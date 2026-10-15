// 「视频理解」的 IPC 注册。与 main.js 解耦(依赖注入 ipcMain / provider / settings),
// 和 agent-ipc.js、notes-ipc.js 同一个模式 —— 于是它可以脱离 Electron 单测。
//
// 边界(与 image/agent 那条通道同一条原则):
//   渲染进程只能递**叶子字段** —— 视频的 `{mimeType, bytes, name}`、一句 `question`、
//   一个模型名、一把待存的密钥。**递不进** URL、命令、路径、上限、模型白名单 ——
//   那些由主进程按 app/lib/agent-video.js 与 video-settings.js 算出来。
//
// ⚠️ 业务失败一律 **resolve 成对象**(`{ok:false, code, reason}`),不 throw:
// 真 Electron 里 `ipcMain.handle` throw 的 Error 过 IPC 只剩 message/stack
// (agent-ipc.js 顶部为这件事写过一整段),而这里的 `code` 恰恰是界面用来决定
// "要不要亮出密钥输入框"的机器可读字段,不能让它在边界上丢掉。
import {
    MAX_VIDEO_BYTES, MAX_VIDEOS_PER_PROMPT, VIDEO_AUDIO_NOTICE, VIDEO_MIME_LABEL,
    VIDEO_MODELS,
} from '../../app/lib/agent-video.js';

/** 注册的频道名。preload 的白名单必须与它逐字一致(有一条单测钉这件事)。 */
export const VIDEO_INVOKE_CHANNELS = Object.freeze([
    'video:status',
    // ⚠️ **唯一**的触发点。曾经还有一个 `video:auto:set`(拖进来就自动开始理解),
    // 用户把交互改成"拖入只是草稿、点发送才调用"之后,那条通道没有任何消费者了 ——
    // 于是连同 autoUnderstand 设置一起删掉,不留一个"已废弃"的空壳:
    // 一次要花钱的远端调用,多一个不起作用的开关比没有更糟。
    'video:understand',
    // 按**本地路径**理解(队列里已经下好的文件走这条):渲染进程只递路径字符串,
    // 文件由主进程自己读 —— 所以这条入口的上限是服务端自己的 1024 MB,
    // 而不是"过 IPC"那条的 64 MiB。
    'video:understandPath',
    'video:key:set',
    'video:key:clear',
    'video:model:set',
    // 取消一次正在进行的理解(169.5 MB 那条实测要 47–71 秒,不给取消就是"只能干等")。
    // 只递一个 requestId —— 取消谁由主进程按那个 id 找,渲染进程说不出别的。
    'video:cancel',
]);

/**
 * 主进程 → 渲染进程的**推送**频道(四段状态行的读数走这条)。
 *
 * 为什么不能靠 invoke 的返回值:invoke 只在**整件事结束**时返回一次,而方案 C 要的
 * 是"上传到 37%、已等待 12 秒、已生成 210 字"这些**中间**读数。IPC 上没有别的办法。
 *
 * ⚠️ 推出去的**只有叶子字段**(stage/percent/chars/chunks/delta/requestId 这些标量),
 * 不推流对象、不推 provider 的返回对象 —— 与 invoke 那条通道同一条边界规矩。
 */
export const VIDEO_EVENT_CHANNEL = 'video:event';

/** 进度事件的合并窗口(毫秒)。见 createProgressPump 的说明。 */
export const VIDEO_PROGRESS_INTERVAL_MS = 60;

/**
 * 把 provider 的进度回调变成"适量"的 IPC 推送。
 *
 * 为什么必须合并:实测一次 322 字的回答分了 **227 个增量**(SSE 是逐 token 切的)。
 * 一次一个 `webContents.send` 就是 227 次跨进程调用,而界面一帧只画得下一次 ——
 * 剩下的全是白花的开销,还会让渲染进程的队列越排越长(表现是"文字越流越慢")。
 *
 * 合并规则(刻意的,不是随手写的):
 *   · **阶段切换立刻发** —— "从等待变成生成"这一下必须马上到,不然用户看不出进展;
 *   · 生成中的增量按 `intervalMs` 合并,**delta 拼接、chars/chunks 取最新** ——
 *     合并的是消息条数,不是信息(正文一个字都不丢)。
 *
 * @param {{emit:(event:object)=>void, now?:()=>number, intervalMs?:number,
 *          setTimer?:Function, clearTimer?:Function}} deps
 */
export function createProgressPump({
    emit, now = () => Date.now(), intervalMs = VIDEO_PROGRESS_INTERVAL_MS,
    setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
    if (typeof emit !== 'function') throw new Error('createProgressPump 需要 emit');
    let pending = null;
    let timer = null;
    let lastAt = 0;

    const flush = () => {
        if (timer !== null) { clearTimer(timer); timer = null; }
        if (pending === null) return;
        const event = pending;
        pending = null;
        lastAt = now();
        emit(event);
    };

    return {
        push(event) {
            if (event === null || typeof event !== 'object') return;
            if (event.stage !== 'generating') {
                flush();                       // 阶段切换:先把攒下的正文发出去,顺序不乱
                lastAt = now();
                emit(event);
                return;
            }
            if (pending === null) pending = { stage: 'generating', chars: 0, chunks: 0, delta: '' };
            pending.chars = Number.isFinite(Number(event.chars)) ? Number(event.chars) : pending.chars;
            pending.chunks = Number.isFinite(Number(event.chunks)) ? Number(event.chunks) : pending.chunks;
            pending.delta += typeof event.delta === 'string' ? event.delta : '';
            const wait = intervalMs - (now() - lastAt);
            if (wait <= 0) flush();
            else if (timer === null) timer = setTimer(flush, wait);
        },
        flush,
        dispose() { if (timer !== null) { clearTimer(timer); timer = null; } pending = null; },
    };
}


/**
 * @param {object} deps
 * @param {object} deps.ipcMain
 * @param {{understand:(input:object)=>Promise<object>}} deps.provider
 * @param {object} deps.videoSettings createVideoSettings 的产物
 * @param {object} [deps.log]
 */
export function registerVideoIpc({ ipcMain, provider, videoSettings, log = console }) {
    if (provider === null || typeof provider?.understand !== 'function') {
        throw new Error('registerVideoIpc 需要 provider(createVideoProvider 的产物)');
    }
    if (videoSettings === null || typeof videoSettings?.summary !== 'function') {
        throw new Error('registerVideoIpc 需要 videoSettings(createVideoSettings 的产物)');
    }

    /** 非空字符串叶子字段,别的形状一律当空(不猜、不 JSON 化)。 */
    function leafString(value) {
        return typeof value === 'string' ? value : '';
    }

    // 正在跑的那几次理解的 AbortController,按渲染进程给的 requestId 索引。
    // ⚠️ 为什么要渲染进程给 id(而不是主进程现生成一个回传):界面要在**发请求之前**
    // 就知道"这条推送属于我这一次",否则第一条进度事件到达时它还没有对应关系。
    // 这个 id 只是不透明字符串,主进程不拿它做任何路径/命令类的事。
    const running = new Map();

    /**
     * 跑一次理解,并把进度推到发起那次调用的那个 webContents 上。
     *
     * @param {object} event ipcMain 给的 IpcMainInvokeEvent(e.sender 就是发起方)
     * @param {string} requestId
     * @param {(input:object)=>Promise<object>} run
     */
    async function runWithProgress(event, requestId, run) {
        // ⚠️ **只有真的推得出去时**才把这两个字段递给 provider。推不出去(没有
        // requestId、或者事件对象上没有 sender)时递的是一份**空的**附加字段 ——
        // provider 收到的入参就仍然是逐字的那几个叶子字段,与从前完全一样。
        const extra = {};
        let pump = null;
        const canPush = requestId !== '' && event !== null && event !== undefined
            && event.sender !== null && event.sender !== undefined
            && typeof event.sender.send === 'function';
        if (canPush) {
            const send = (payload) => {
                try {
                    event.sender.send(VIDEO_EVENT_CHANNEL, { ...payload, requestId });
                } catch (err) {
                    // 窗口在理解过程中被关掉是完全正常的:推不出去就算了,
                    // 绝不能因此把正在跑的理解搞崩(它的返回值仍然要还给调用方)。
                    log.warn?.(`[video] 进度推送失败:${err?.message ?? err}`);
                }
            };
            pump = createProgressPump({ emit: send });
            // 第一件事:让界面立刻知道"这一次我接上了"(准备请求那一段从这里开始)
            pump.push({ stage: 'preparing' });
            extra.onProgress = (p) => pump.push(p);
            if (typeof AbortController === 'function') {
                const controller = new AbortController();
                extra.signal = controller.signal;
                running.set(requestId, controller);
            }
        }
        try {
            return await run(extra);
        } finally {
            if (pump !== null) { pump.flush(); pump.dispose(); }
            if (requestId !== '') running.delete(requestId);
        }
    }

    /** 取消一次正在跑的理解。找不到就是"已经结束了"——那是个正常结果,不是错误。 */
    function cancel(requestId) {
        const controller = running.get(requestId);
        if (controller === undefined) return { ok: false, code: 'not_running', reason: '这一次已经结束了(或者不是这个 id)' };
        try {
            controller.abort();
        } catch (err) {
            log.warn?.(`[video] 取消失败:${err?.message ?? err}`);
            return { ok: false, code: 'cancel_failed', reason: `取消失败:${err?.message ?? err}` };
        }
        return { ok: true };
    }

    const handlers = {
        /**
         * 读一次:凭证状态 + 生效配置 + 上限 + 那句"听不到声音"的说明。
         * 只有叶子字段,**绝不含密钥值**。
         *
         * 谁读它:面板在"这次没配密钥"那一刻读一次(把密钥的存储方式/当前模型如实
         * 写进那张配置卡)。**不在拖入视频时读** —— 拖入只是草稿,不该有任何 IPC。
         */
        'video:status': () => {
            const summary = videoSettings.summary();
            const cfg = videoSettings.config();
            return {
                ok: summary.ok === true,
                source: summary.source ?? null,
                storage: summary.storage ?? null,
                reason: summary.reason ?? null,
                model: cfg.model,
                models: VIDEO_MODELS.map(m => ({ id: m.id, label: m.label })),
                maxTokens: cfg.maxTokens,
                maxVideoBytes: MAX_VIDEO_BYTES,
                maxVideosPerPrompt: MAX_VIDEOS_PER_PROMPT,
                inlineLimitBytes: cfg.inlineLimitBytes,
                // 界面必须显示这一句:模型只看画面。
                audioNotice: VIDEO_AUDIO_NOTICE,
                // 支持的容器标签,拖进来被拒时界面照着它说"只接受哪几种"。
                mimeLabel: VIDEO_MIME_LABEL,
            };
        },

        /**
         * 理解一段视频 —— **本功能唯一的触发点**(用户点「发送」才会调到这里)。
         * 渲染进程递来的只有四个叶子字段。
         * 权威校验(类型白名单 / 单段上限 / 字节与声明是否相符)在 provider 里
         * 再走一遍 —— 与图片那条路一样,渲染进程的话不算数。
         */
        'video:understand': async (event, payload = {}) => {
            const requestId = leafString(payload?.requestId);
            // ⚠️ 注意这里把 `...extra` 放在**叶子字段之后**:renderer 就算在 payload 里
            // 塞了 onProgress / signal,也进不来(上面从来只读那四个白名单字段)。
            return await runWithProgress(event, requestId, async (extra) => await provider.understand({
                mimeType: leafString(payload?.mimeType),
                bytes: payload?.bytes,
                name: leafString(payload?.name),
                question: leafString(payload?.question),
                ...extra,
            }));
        },

        /**
         * 按**本地路径**理解一段视频(队列里已经下好的文件走这条)。
         *
         * ⚠️ 递路径意味着"能让主进程读一个文件并发给第三方" —— 所以:
         *   · 渲染进程只能递这五个叶子字段(path/folder/name/mimeType/question);
         *   · 路径由 `provider.understandFromPath` 里的 `admitVideoPath` 从头核过
         *     (绝对路径 / 扩展名白名单 / 文件存在且是文件 / **必须落在给定的下载目录里**);
         *   · 额外字段一概不采信(下面这个对象是白名单,不是透传)。
         */
        'video:understandPath': async (event, payload = {}) => {
            const requestId = leafString(payload?.requestId);
            return await runWithProgress(event, requestId, async (extra) => await provider.understandFromPath({
                path: leafString(payload?.path),
                // folder 是"允许读的范围"的依据(队列给的下载目录);空串表示不限定
                folder: leafString(payload?.folder),
                name: leafString(payload?.name),
                mimeType: leafString(payload?.mimeType),
                question: leafString(payload?.question),
                ...extra,
            }));
        },

        /** 取消一次正在跑的理解(找不到 = 已经结束,正常返回)。 */
        'video:cancel': (_event, payload = {}) => cancel(leafString(payload?.requestId)),

        /** 存一把密钥。**不回显任何值**,只回 `{ok, storage}`。 */
        'video:key:set': (_event, payload = {}) => videoSettings.saveKey(leafString(payload?.key)),

        /** 清掉保存的密钥(环境变量那份不受影响)。 */
        'video:key:clear': () => videoSettings.clearKey(),

        /** 换模型(白名单之外一律拒)。 */
        'video:model:set': (_event, payload = {}) => videoSettings.setModel(leafString(payload?.model)),
    };

    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, payload) => {
            try {
                return await handler(event, payload);
            } catch (err) {
                // 走到这里说明是**接线/内部**故障(业务失败都在上面 resolve 掉了)。
                // 仍然 resolve 成对象:throw 过 IPC 会丢掉机器可读字段。
                log.warn?.(`[video] ${channel} 失败:${err?.message ?? err}`);
                return { ok: false, code: 'ipc_error', reason: String(err?.message ?? err), status: null };
            }
        });
    }

    return {
        dispose: () => {
            for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
        },
    };
}
