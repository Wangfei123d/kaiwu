// 「复制视频」的 IPC 注册。与 agent-ipc / notes-ipc / video-ipc 同一个模式:
// 依赖全部注入,于是能脱离 Electron 单测(不碰真剪贴板、不起真进程)。
//
// 为什么这一步必须回到主进程:网页 API 放不进"文件"——`navigator.clipboard`
// 只能写文本/图片,而"粘到资源管理器/微信/剪贴板里直接出现文件"要的是剪贴板的
// **CF_HDROP**(文件拖放列表)。所以只有主进程能调 Windows 的剪贴板 API。
//
// 边界(与其它通道同一条原则):渲染进程只递一个 `{ taskId }` —— **递不进路径**。
// 路径由主进程自己去问本地代理(3302)、按队列数据解析、并逐条核过
// (任务存在 → 已完成 → 路径在它自己的下载目录里 → 文件真的在)。
// 让渲染进程递路径就等于开了一条"任意文件进剪贴板"的通道。
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import {
    CLIPBOARD_RETRIES, CLIPBOARD_RETRY_DELAY_MS, CLIPBOARD_TIMEOUT_MS,
    buildClipboardInvocation, interpretClipboardResult, isRetryableClipboardResult,
} from '../../app/lib/bilibili-copy.js';
import { admitCopyTarget } from '../../app/lib/bilibili-queue.js';

/** 注册的频道名。preload 的白名单必须与它逐字一致(有单测钉这件事)。 */
export const BILIBILI_INVOKE_CHANNELS = Object.freeze([
    // 频道名按"能力"取,不按插件取:它做的事是**把一个本地文件放进系统剪贴板**,
    // "哪个任务、路径在哪"是主进程自己去解析的实现细节。ctx.js 里那条
    // ctx.clipboard.copyVideo(taskId) 就是它(需要清单申请 "clipboard" 权限)。
    'clipboard:copyVideo',
]);

/** 本地代理地址。与插件里那个常量是同一个服务(端口写在清单的 services 里)。 */
export const BILIBILI_PROXY_BASE = 'http://127.0.0.1:3302';
/** 取队列的超时:它是本地服务,不该久等。 */
export const QUEUE_FETCH_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 收敛代理地址:去掉末尾斜杠,空值退回默认。 */
export function normalizeProxyBase(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === '') return BILIBILI_PROXY_BASE;
    return raw.replace(/\/+$/, '');
}

/** 默认的取队列实现:Electron 主进程自带 fetch + AbortController 超时。 */
export function createQueueFetcher({ fetchImpl, timeoutMs = QUEUE_FETCH_TIMEOUT_MS } = {}) {
    return async function fetchQueue(url) {
        const doFetch = fetchImpl ?? globalThis.fetch;
        if (typeof doFetch !== 'function') throw new Error('这个环境里没有 fetch');
        const Abort = globalThis.AbortController;
        const controller = typeof Abort === 'function' ? new Abort() : null;
        const timer = (controller !== null && typeof setTimeout === 'function')
            ? setTimeout(() => { try { controller.abort(); } catch { /* 忽略 */ } }, timeoutMs)
            : null;
        try {
            const res = await doFetch(url, controller === null ? {} : { signal: controller.signal });
            if (res.ok !== true) {
                // 把"HTTP 不对"与"连不上"分开报:连不上是"服务没起",而 404 往往是
                // **代理是旧版本**(没有 /bilibili/tasks 这个端点)—— 两者的下一步完全不同。
                const err = new Error(`代理返回 HTTP ${res.status}`);
                err.httpStatus = res.status;
                throw err;
            }
            return await res.json();
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    };
}

/**
 * 默认的"写剪贴板"实现:`powershell.exe -NoProfile -STA …`(见 bilibili-copy.js 顶部
 * 为什么必须是 5.1 + -STA)。
 *
 * `windowsHide: true` 是必需的:不藏窗口的话每次复制都会闪一下黑框
 * (用户会以为程序出问题了)。超时用 execFile 自带的 `timeout`。
 */
export function createClipboardRunner({ execFileImpl = execFile } = {}) {
    return function runClipboard({ command, args, timeoutMs }) {
        return new Promise((resolve) => {
            execFileImpl(command, args, {
                timeout: timeoutMs,
                windowsHide: true,
                maxBuffer: 1024 * 1024,
            }, (error, stdout, stderr) => {
                const killed = error !== null && error !== undefined && error.killed === true;
                resolve({
                    stdout: String(stdout ?? ''),
                    stderr: String(stderr ?? '') || (error === null || error === undefined ? '' : String(error.message ?? '')),
                    code: (error === null || error === undefined) ? 0 : (typeof error.code === 'number' ? error.code : null),
                    timedOut: killed === true,
                });
            });
        });
    };
}

/** 默认的 stat:只回答"在不在、是不是文件、多大"。 */
export function createPathStat({ statSyncImpl = statSync } = {}) {
    return function statPath(filePath) {
        try {
            const info = statSyncImpl(filePath);
            return { exists: true, isFile: typeof info.isFile === 'function' ? info.isFile() : false, size: Number(info.size) || 0 };
        } catch {
            return { exists: false, isFile: false, size: 0 };
        }
    };
}

/**
 * @param {object} deps
 * @param {object} deps.ipcMain
 * @param {(url:string)=>Promise<object>} [deps.fetchQueue] 取队列(注入=单测里零网络)
 * @param {(req:object)=>Promise<object>} [deps.runClipboard] 真正写剪贴板(注入=单测不碰剪贴板)
 * @param {(p:string)=>{exists:boolean,isFile:boolean,size:number}} [deps.statPath]
 * @param {(()=>string)|string} [deps.resolveBaseUrl] 本地代理地址。
 *        给**函数**是为了每次现取(与 agent-runtime 的 vaultRoot 同一个理由:
 *        代理地址是可配置的,写死在模块加载那一刻就会与界面里那份分叉 ——
 *        自检把队列指向夹具服务时正是靠这一点)。
 * @param {boolean} [deps.enabled] false = **绝不碰系统剪贴板**(自检模式走这条)
 * @param {object} [deps.log]
 */
export function registerBilibiliIpc({
    ipcMain,
    fetchQueue = createQueueFetcher(),
    runClipboard = createClipboardRunner(),
    statPath = createPathStat(),
    resolveBaseUrl = () => BILIBILI_PROXY_BASE,
    enabled = true,
    log = console,
} = {}) {
    if (ipcMain === null || typeof ipcMain?.handle !== 'function') {
        throw new Error('registerBilibiliIpc 需要 ipcMain');
    }

    const handlers = {
        /**
         * 把某个已完成任务的视频文件放进系统剪贴板(CF_HDROP)。
         *
         * 业务失败一律 **resolve 成对象**(`{ok:false, code, reason}`),不 throw:
         * 真 Electron 里 throw 的 Error 过 IPC 只剩 message(见 agent-ipc.js 那段),
         * 而这里的 code 是界面用来决定"要不要提示重试/去登录"的依据。
         */
        'clipboard:copyVideo': async (_event, payload = {}) => {
            const taskId = Number(payload?.taskId);
            if (!Number.isInteger(taskId) || taskId <= 0) {
                return { ok: false, code: 'bad_task_id', reason: `taskId 必须是一个正整数,收到:${String(payload?.taskId)}` };
            }

            // ① 队列从本地代理取 —— 渲染进程递不进路径,只能递 id
            const base = normalizeProxyBase(typeof resolveBaseUrl === 'function' ? resolveBaseUrl() : resolveBaseUrl);
            let queue;
            try {
                queue = await fetchQueue(`${base}/bilibili/tasks`);
            } catch (err) {
                // 404 与"连不上"分开说:前者多半是**代理是旧版本**(没有 /bilibili/tasks)
                const status = err?.httpStatus;
                if (typeof status === 'number') {
                    return {
                        ok: false,
                        code: 'proxy_http_error',
                        reason: `本地代理(${base})返回 HTTP ${status} —— 队列端点不可用,`
                            + '多半是代理还是旧版本(重启服务后再试)',
                    };
                }
                return {
                    ok: false,
                    code: 'proxy_unreachable',
                    reason: `取下载队列失败:${String(err?.message ?? err)} —— 解析服务没起来?等「服务状态」变成运行中再试`,
                };
            }
            if (queue === null || typeof queue !== 'object' || queue.code !== 0) {
                return {
                    ok: false,
                    code: 'queue_error',
                    reason: `取下载队列失败:${String(queue?.message ?? '返回里没有 code=0')}`,
                };
            }

            // ② 逐条核对(任务在不在、是不是已完成、路径是不是它自己的、文件还在不在)
            const admitted = admitCopyTarget({ queue: queue.data, taskId, stat: statPath });
            if (admitted.ok !== true) return admitted;

            // ③ 自检模式:**绝不碰系统剪贴板**。
            //    剪贴板是用户的全局资源 —— 自检把它覆盖掉,用户会当场丢东西
            //    (他刚复制的一段文字/一张图就没了)。所以这里只把链路走完并如实说明。
            if (enabled !== true) {
                return {
                    ok: true,
                    skipped: true,
                    code: 'selftest',
                    fileName: admitted.fileName,
                    filePath: admitted.filePath,
                    size: admitted.size,
                    reason: '自检模式:链路走通了,但没有真去写系统剪贴板(那是用户的全局资源)',
                };
            }

            // ④ 真的写剪贴板,失败重试(别的进程独占剪贴板时 OpenClipboard 会直接失败)
            let invocation;
            try {
                invocation = buildClipboardInvocation(admitted.filePath);
            } catch (err) {
                return { ok: false, code: 'path_rejected', reason: String(err?.message ?? err) };
            }

            let last = { ok: false, reason: '没有尝试写剪贴板' };
            for (let attempt = 1; attempt <= CLIPBOARD_RETRIES; attempt += 1) {
                const result = await runClipboard({
                    command: invocation.command,
                    args: invocation.args,
                    timeoutMs: CLIPBOARD_TIMEOUT_MS,
                });
                const verdict = interpretClipboardResult(result);
                if (verdict.ok === true) {
                    return {
                        ok: true,
                        fileName: admitted.fileName,
                        filePath: admitted.filePath,
                        size: admitted.size,
                        attempts: attempt,
                    };
                }
                last = verdict;
                log.warn?.(`[bilibili] 写剪贴板第 ${attempt} 次失败:${verdict.reason}`);
                const retry = isRetryableClipboardResult({
                    code: result?.code,
                    timedOut: result?.timedOut === true,
                    reason: verdict.reason,
                });
                if (retry !== true) break;
                if (attempt < CLIPBOARD_RETRIES) await sleep(CLIPBOARD_RETRY_DELAY_MS);
            }
            return { ok: false, code: 'clipboard_failed', reason: last.reason };
        },
    };

    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, payload) => {
            try {
                return await handler(event, payload);
            } catch (err) {
                // 走到这里说明是接线/内部故障(业务失败都在上面 resolve 掉了)。
                log.warn?.(`[bilibili] ${channel} 失败:${err?.message ?? err}`);
                return { ok: false, code: 'ipc_error', reason: String(err?.message ?? err) };
            }
        });
    }

    return {
        dispose: () => {
            for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
        },
    };
}
