// 「视频理解」的 provider:构造请求 → 体积分发(内联 base64 / 临时上传)→ 发请求
// → 解析返回 → 把 HTTP 失败映射成可读的中文。
//
// 图片走**同一条路**(`understandImage`):同一个端点、同一套鉴权、同一个解析、
// 同一份错误映射,只有 content 项的形状不同(实测:同一次调用里 `image_url` 也通)。
// 所以这里只有一个 provider —— 分成两个就是把请求体/错误码/用量解析抄两遍。
//
// 为什么这一层单独一个文件、而且**所有外部依赖都可注入**:
//   · 单测里必须能"不发一次真实网络请求"地跑完整条链路(硬要求 5),所以
//     `transport` 是注入点,而不是直接 fetch;
//   · 密钥只有一个来源(resolveKey),绝不出现在返回值、日志与错误里 ——
//     这条靠"这一层是唯一碰密钥的地方"来保证,散在别处就保证不了;
//   · 「内联还是上传」的分发判据必须能被单测逐点钉住(硬要求 1 与 5),
//     所以真正的判据在 app/lib/agent-video.js 的纯函数里,这里只负责执行。
//
// 零运行时依赖:HTTP 走 Electron 自带的 fetch(主进程 Node ≥18 就有),
// 不引任何第三方库;multipart 的字节由纯模块自己拼。
//
// ⚠️ 这一层**不 throw 业务失败**,一律返回 `{ok:false, code, reason}`:
// 真 Electron 的 `ipcMain.handle` 里 throw 的 Error 过 IPC 只剩 message/stack
// (agent-ipc.js 里已经为这件事写过一段),而这里的 `code` 恰恰是界面要用来决定
// "要不要亮出密钥输入框"的机器可读字段 —— 让它死在 IPC 边界上是不行的。
import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
    DEFAULT_MAX_TOKENS, DEFAULT_VIDEO_MODEL, MAX_LOCAL_VIDEO_BYTES, MISSING_KEY_REASON,
    OSS_RESOLVE_HEADER, OSS_RESOLVE_VALUE,
    admitVideoPath, admitVideoPayload, base64Length, buildChatBody, buildDataUrl, buildInlineBodyParts,
    buildMediaContent, buildMultipartBody, buildMultipartParts, buildOssUrl, buildUploadFormFields,
    chooseDelivery, classifyChatFailure, encodeBase64Chunks, inlineChunkStep, normalizeVideoMime, normalizeVideoModel,
    parseStreamPayload, parseUploadPolicy, safeVideoName, splitSseEvents, toCanonicalBase64,
    uniqueUploadName, VIDEO_FILE_EXTENSIONS,
} from '../../app/lib/agent-video.js';
// 图片的**权威判据**在 agent-image.js 那一份(与黏贴截图共用同一个白名单与上限),
// 这里只是用它,不再写第二份。
import { admitImagePayload } from '../../app/lib/agent-image.js';

/** DashScope 的根地址。写成常量而不是散在几处:内联与上传必须是同一个服务。 */
export const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com';
/** 兼容模式(OpenAI 形状)的对话端点。图与视频走的是同一条。 */
export const CHAT_PATH = '/compatible-mode/v1/chat/completions';
/** 上传凭证端点。⚠️ 是 **GET**(POST 会 405,实测)。 */
export const UPLOAD_POLICY_PATH = '/api/v1/uploads';

/** 对话的超时。视频要服务端解码 + 抽帧,给足(实测 4 秒 1080p 约 3 秒)。 */
export const DEFAULT_TIMEOUT_MS = 120000;
/** 上传的超时。文件可能几十 MB,单独一个更长的值。 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 300000;

/**
 * **已知本地路径**那条入口的超时。都比默认更宽:
 *   · 上传:实测 169.5 MB 走了 **26 秒**(200 OK)。上行慢一档就是几分钟,
 *     所以给到 10 分钟 —— 超时掐掉一次已经传了九成的上传,是最亏的一种失败。
 *   · 对话:同一段 8 分半的 1080p60 实测 **44.9 秒**才回。30 分钟的视频会更久,
 *     所以给到 5 分钟(默认那 2 分钟是按"4 秒短片"定的,这里不适用)。
 */
export const LOCAL_UPLOAD_TIMEOUT_MS = 600000;
export const LOCAL_CHAT_TIMEOUT_MS = 300000;

/** 上传时用的流分块大小(只是读取粒度,不影响内存峰值)。 */
const STREAM_CHUNK_BYTES = 1024 * 1024;

/**
 * "这次失败看着像**请求体本身**的问题"的判据。
 *
 * 为什么要单独一条:两条路都有一条"流式发不出去就退回整包"的兜底,而**只有**请求体
 * 形态的问题才值得重发一次 —— 真业务失败(403/400)换一种发法还是失败,重试只会白传
 * 一遍 19 MB(内联)或 170 MB(上传)。两边共用一份,免得只有一处被改对。
 */
const LOOKS_LIKE_BODY_PROBLEM = /content-length|duplex|stream|chunked|other side closed|und_err/i;
/**
 * 把「前缀 / 文件流 / 后缀」拼成一条 Web ReadableStream。
 *
 * 为什么要这么做(而不是拼一个大 Buffer):169.5 MB 的文件在两处各存一份就是 340 MB
 * 的峰值内存,而这些字节本来就在磁盘上 —— 流式发出去,内存里只留一小段前缀、
 * 一小段后缀,和 1 MiB 的读缓冲。
 *
 * ⚠️ **必须用 `pull()` 逐块喂,而不是在 `start()` 里一路 enqueue**:enqueue 从不阻塞,
 * 消费端(undici 往 socket 写)慢下来时,队列会一路涨 —— 实测那版会把 169 MB 全
 * 堆进流队列(external 峰值 208 MB),等于"流式"了个寂寞。`pull` 是**消费端来要
 * 才给一块**,所以队列里最多一块(几个 MiB)。
 *
 * 环境里没有 ReadableStream(极老的运行时/替身)时返回 null,调用方走"单份缓冲"那条路。
 */
export function composeUploadStream(chunks, { onBytes, onEnd } = {}) {
    if (typeof ReadableStream !== 'function') return null;
    const list = Array.isArray(chunks) ? chunks : [];
    let index = 0;
    let reader = null;
    let sent = 0;
    // 「上传进度」的口径就定在这里:**交出去的字节数**。
    // 不是因为这样好看,而是因为这是本地**唯一**能真实观测到的量 —— 服务端收了多少
    // 我们看不见,谁也说不出。数 enqueue 是诚实的:这一块已经离开我们、交给下层的连接了。
    const count = (value) => {
        const n = value?.byteLength ?? value?.length ?? 0;
        if (n > 0) {
            sent += n;
            try { onBytes?.(sent); } catch { /* 进度回调抛错不能影响上传 */ }
        }
        return value;
    };
    return new ReadableStream({
        async pull(controller) {
            for (;;) {
                if (reader !== null) {
                    const { done, value } = await reader.read();
                    if (done === true) { reader = null; index += 1; continue; }
                    controller.enqueue(count(value));
                    return;                      // 一次 pull 只给一块 → 队列不堆积
                }
                if (index >= list.length) {
                    controller.close();
                    // 全部字节都已经被消费端要走 = "请求体交完了"。内联那条路靠这个时刻
                    // 决定「等待首个字」从哪一秒开始(见 requestStreamingChat)。
                    try { onEnd?.(); } catch { /* 收尾回调抛错不能影响发送结果 */ }
                    return;
                }
                const chunk = list[index];
                if (chunk === null || chunk === undefined) { index += 1; continue; }
                // 约定:带 getReader() 的就是"文件那条流",逐块转发
                if (typeof chunk.getReader === 'function') { reader = chunk.getReader(); continue; }
                index += 1;
                controller.enqueue(count(chunk));
                return;
            }
        },
        cancel(reason) {
            try { reader?.cancel?.(reason); } catch { /* 取消失败不影响结果 */ }
        },
    });
}

/** 默认:按块打开的二进制文件流(测试注入假实现)。 */
export function createFileStreamOpener({ createReadStreamImpl = createReadStream } = {}) {
    return function openFileStream(path) {
        const nodeStream = createReadStreamImpl(path, { highWaterMark: STREAM_CHUNK_BYTES });
        // Node 的 Readable → Web ReadableStream(undici 的 fetch 只认后者)
        if (typeof Readable?.toWeb === 'function') return Readable.toWeb(nodeStream);
        return nodeStream;
    };
}

/**
 * **内联**那条路的请求体流:前缀 → 分块 base64(**边发边编**)→ 后缀。
 *
 * ⚠️ 这里是"边发边编",不是"先编好一整份再发":后者要在内存里同时留着源字节与整段
 * base64(13.9 MiB 的文件编出来 ~19.4 MB 的字符串)—— 那就等于没做流式。`pull` 是
 * **消费端来要才给一块**,所以同一时刻只有一块 base64 存在,编完就交给连接层、本地不再留引用。
 * 峰值 ≈ 源字节(它本来就在内存里,是过 IPC 递进来的)+ 一块 base64(~1.4 MiB)。
 *
 * ⚠️ 分块必须 **3 字节对齐**:块长不是 3 的倍数时每一块都会被独立补 `=`,拼起来中间就
 * 多出填充符 —— 整个请求体变成非法 base64,服务端只回一个 400,极难查(见 encodeBase64Chunks)。
 *
 * ⚠️ 复用的是上传那条路**已经实测跑通**的 `composeUploadStream`:它逐块 enqueue、
 * 队列里最多一块(背压生效),并且统一在那里数"已经交给连接的字节数"。
 *
 * @param {{bytes?:Uint8Array, chunkBytes?:number, prefix?:Uint8Array, suffix?:Uint8Array,
 *          onBytes?:(sent:number)=>void, onEnd?:()=>void}} deps
 * @returns {ReadableStream|null} 环境里没有 ReadableStream 时返回 null(调用方回退整包)
 */
export function composeInlineBodyStream({ bytes, chunkBytes, prefix, suffix, onBytes, onEnd } = {}) {
    if (typeof ReadableStream !== 'function') return null;
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
    const step = inlineChunkStep(chunkBytes);
    let at = 0;
    const encode = new TextEncoder();
    const middle = new ReadableStream({
        pull(controller) {
            if (at >= source.length) { controller.close(); return; }
            const window = source.subarray(at, Math.min(at + step, source.length));
            at += step;
            // 一次只编一块:上一块的字符串到这里已经没有任何引用了(交给连接层后即成为垃圾)
            const text = encodeBase64Chunks(window, { chunkBytes: step })[0] ?? '';
            // base64 是纯 ASCII:一个字符一个字节
            controller.enqueue(encode.encode(text));
        },
    });
    return composeUploadStream([prefix, middle, suffix], { onBytes, onEnd });
}

/**
 * "单份缓冲"兜底:整份 multipart 只占**一块**内存 —— 文件字节由 `readInto` 直接
 * 读进这块缓冲区的中间,而不是先读成一份再拷进另一份。
 *
 * 为什么留这条退路:流式发送要 undici 的 `duplex:'half'` 且可能撞上服务端对
 * chunked 表单的挑剔。真撞上时退到这里,内存峰值仍然只有一份文件(不是两份)。
 */
export function createSingleCopyBodyBuilder({ readInto } = {}) {
    return function buildSingleCopyBody({ parts, path, size, onBytes }) {
        const body = new Uint8Array(parts.contentLength);
        body.set(parts.prefix, 0);
        body.set(parts.suffix, parts.prefix.byteLength + size);
        if (typeof readInto === 'function') {
            readInto({ path, buffer: body, offset: parts.prefix.byteLength, length: size, onBytes });
        }
        return body;
    };
}

/**
 * 默认传输层:Electron 主进程自带的 fetch + AbortController 超时。
 *
 * 契约(注入假传输层时按这个实现):
 *   入参 `{ url, method, headers, body, timeoutMs, duplex, signal, onData }`,
 *   body 是 string / Uint8Array / Web ReadableStream;`duplex:'half'` 只在 body 是流时出现
 *   (undici 的硬要求);`onData(text)` 是**流式**回调(收到一段就调一次,同时照旧把全文
 *   拼进返回的 `text`,所以不用流式的调用方一行都不用改);`signal` 是外部取消。
 *   返回 `{ status:number|null, ok:boolean, text:string, timedOut:boolean, networkError:string }`;
 *   **不 throw** —— 网络层异常也折成 networkError 返回,让"谁来判错"只有一处。
 *
 * 为什么不用 electron 的 net 模块:主进程里 fetch 就在(Node 22 起是标准全局),
 * 而 net 只在 Electron 进程内有,单测直接跑 node --test 就构造不出来。
 */
export function createFetchTransport({ fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, log = console } = {}) {
    return async function transport({
        url, method = 'POST', headers = {}, body, timeoutMs: perCall, duplex, signal: external, onData,
    } = {}) {
        const doFetch = fetchImpl ?? globalThis.fetch;
        if (typeof doFetch !== 'function') {
            return { status: null, ok: false, text: '', timedOut: false, networkError: '这个运行环境里没有 fetch,发不出请求' };
        }
        const budget = Number.isFinite(perCall) && perCall > 0 ? perCall : timeoutMs;
        // 超时必须能打断:没有 AbortController 时 `fetch` 会一直挂着,
        // 而界面那边就是一个永不结束的"理解中…"。
        const Abort = globalThis.AbortController;
        const controller = typeof Abort === 'function' ? new Abort() : null;
        let timedOut = false;
        let cancelled = false;
        let timer = null;
        if (controller !== null) {
            if (typeof setTimeout === 'function') {
                timer = setTimeout(() => {
                    timedOut = true;
                    try { controller.abort(); } catch (err) { log.warn?.('[video] abort 失败', err); }
                }, budget);
            }
            // 外部取消(用户按「取消」)与超时共用同一个 controller,但记另一个标志 ——
            // 这样报错文案分得清"超时"与"你自己取消的"。
            if (external !== undefined && external !== null && typeof external.addEventListener === 'function') {
                const onAbort = () => {
                    cancelled = true;
                    try { controller.abort(); } catch { /* 忽略 */ }
                };
                if (external.aborted === true) onAbort();
                else external.addEventListener('abort', onAbort, { once: true });
            }
        }
        try {
            const res = await doFetch(url, {
                method,
                headers,
                body,
                // 流式请求体必须显式声明 half duplex(undici 不认"没声明"的流)
                ...(duplex === undefined ? {} : { duplex }),
                ...(controller === null ? {} : { signal: controller.signal }),
            });
            // 流式:一边收一边回调(SSE 的增量就靠这一条路进界面)。
            // 全文照旧拼进 text —— 所以"不用流式的调用方"行为逐字不变。
            if (typeof onData === 'function' && res.body !== null && res.body !== undefined
                && typeof res.body.getReader === 'function') {
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let streamed = '';
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done === true) break;
                    const piece = decoder.decode(value, { stream: true });
                    if (piece === '') continue;
                    streamed += piece;
                    try { onData(piece); } catch (err) { log.warn?.('[video] onData 回调抛错', err); }
                }
                streamed += decoder.decode();
                return {
                    status: typeof res.status === 'number' ? res.status : null,
                    ok: res.ok === true,
                    text: streamed,
                    timedOut: false,
                    networkError: '',
                };
            }
            const text = typeof res.text === 'function' ? await res.text() : '';
            return {
                status: typeof res.status === 'number' ? res.status : null,
                ok: res.ok === true,
                text: String(text ?? ''),
                timedOut: false,
                networkError: '',
            };
        } catch (err) {
            return {
                status: null,
                ok: false,
                text: '',
                timedOut,
                cancelled,
                networkError: cancelled
                    ? '这次理解已被取消'
                    : (timedOut
                        ? `请求超过 ${budget}ms 没有回应,已中断`
                        : String(err?.message ?? err)),
            };
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    };
}

/** 纯函数的 JSON.parse:坏正文不 throw,返回 null(调用方负责说清楚)。 */
function parseJson(text) {
    try {
        return JSON.parse(String(text ?? ''));
    } catch {
        return null;
    }
}

/** 请求头。密钥只在这里出现,而且这一层不把它写进任何返回值。 */
function authHeaders(apiKey, extra = {}) {
    return { Authorization: `Bearer ${apiKey}`, ...extra };
}

/**
 * "单份缓冲"兜底时把文件**直接读进**目标缓冲区的中间(不是先读出来再拷进去)。
 * 逐块 readSync,所以即使 169 MB 也不会在中途多出第二份。
 */
function defaultReadInto({ path, buffer, offset, length, onBytes }) {
    const fd = openSync(path, 'r');
    try {
        let at = 0;
        while (at < length) {
            const want = Math.min(STREAM_CHUNK_BYTES, length - at);
            const got = readSync(fd, buffer, offset + at, want, at);
            if (got <= 0) break;
            at += got;
            // 兜底这条路的"进度"= 已经读进请求体的字节数。它比流式那条更靠前一点
            // (读进内存 ≠ 交给连接),所以文案上不写"已上传",只写"已读入"。
            try { onBytes?.(at); } catch { /* 同上,进度不影响正事 */ }
        }
    } finally {
        closeSync(fd);
    }
}

/**
 * @param {object} deps
 * @param {(req:object)=>Promise<object>} deps.transport 传输层(必填;单测注入假的)
 * @param {() => {ok:boolean, secret?:string, source?:string, reason?:string}} deps.resolveKey
 *        解析密钥。**只有主进程会拿到 secret**,而它绝不出现在任何返回值里。
 * @param {() => {model?:string, maxTokens?:number, inlineLimitBytes?:number,
 *                timeoutMs?:number, uploadTimeoutMs?:number}} [deps.config]
 * @param {object} [deps.log]
 * @param {() => number} [deps.now] / @param {() => number} [deps.random] 便于确定性单测
 * @param {(p:string)=>{exists:boolean,isFile:boolean,size:number}} [deps.statFile]
 *        按路径那条入口用(**主进程自己读盘**;单测注入假货)
 * @param {(p:string)=>Uint8Array} [deps.readFileBytes] 内联小文件时整读
 * @param {(p:string)=>any} [deps.openFileStream] 大文件流式上传时的文件流
 * @param {(req:object)=>void} [deps.readInto] "单份缓冲"兜底时把文件直接读进缓冲中间
 */
export function createVideoProvider({
    transport,
    resolveKey,
    config = () => ({}),
    log = console,
    now = () => Date.now(),
    random = () => Math.random(),
    statFile = (p) => {
        const info = statSync(p);
        return { exists: true, isFile: info.isFile(), size: info.size };
    },
    readFileBytes = (p) => new Uint8Array(readFileSync(p)),
    openFileStream = createFileStreamOpener(),
    readInto = null,
} = {}) {
    if (typeof transport !== 'function') {
        // 接线错误要**当场**说,别拖到用户按下「理解」才炸。
        throw new Error('createVideoProvider 需要 transport(createFetchTransport 的产物或注入的假传输层)');
    }
    if (typeof resolveKey !== 'function') {
        throw new Error('createVideoProvider 需要 resolveKey(密钥解析函数)');
    }

    /** 把一次 HTTP 结果折成失败对象。code 是机器可读的那一份。 */
    function failed(res, { codePrefix = '', extra = '' } = {}) {
        // ⚠️ 传输层失败时 `res.text` 是空的,真正的原话在 `networkError` 里(例如 undici 的
        // "Request body length does not match content-length header")。丢掉它,用户与日志
        // 就只剩一句"连不上";而内联那条路的兜底判据(要不要换成整包重发一次)也读它。
        const detail = String(res.text ?? '').trim() !== '' ? res.text : String(res.networkError ?? '');
        const verdict = classifyChatFailure({
            status: res.status,
            body: parseJson(res.text),
            message: detail,
            timedOut: res.timedOut === true,
            network: String(res.networkError ?? '') !== '' && res.timedOut !== true,
        });
        const reason = extra === '' ? verdict.reason : `${extra}${verdict.reason}`;
        return { ok: false, code: codePrefix === '' ? verdict.code : `${codePrefix}_${verdict.code}`, reason, status: res.status ?? null };
    }

    /**
     * 一次**流式**对话请求 —— 首字时刻、生成字数、usage 全从这条流里读。
     *
     * 为什么要流式(而不是继续用整包):用户看到的是四段状态行,其中「等待首个字」与
     * 「生成正文」**只能**从流里得到真实读数 —— 整包模式下这两段都是黑盒,只能编。
     *
     * 进度回调的叶子字段(渲染进程只认这些,不递整个流对象):
     *   `{stage:'waiting'}`                                  → 请求体已交完,还没首字
     *   `{stage:'generating', chars, chunks, delta}`          → 每来一片
     *
     * `bodyStream` 是给**内联**那条路用的:整包 base64 的请求体太大(13.9 MiB 的文件
     * 编出来 ~19 MB),整串拼好再一次发出去等于没做流式。传一条流进来时按 `duplex:'half'`
     * 发,于是"已经交给连接的字节数"能在发送过程中逐块报出去(与上传那条路同一种做法)。
     *
     * @param {{bodyStream?:object, duplex?:string}} [extra]
     * @returns {Promise<object>} 成功 `{ok:true, text, usage, ttftMs, generateMs, chunks}`
     *          失败 `{ok:false, ...}`(形状与 `failed()` 一致,调用方直接返回)
     */
    async function requestStreamingChat({ model, content, maxTokens, apiKey, timeoutMs, signal, onProgress, extraHeaders, bodyStream, duplex, onWaitStart }) {
        // 有流就用流;没有就现拼一个字符串体(图片那条路仍然走这一支)
        const body = bodyStream ?? JSON.stringify(buildChatBody({ model, content, maxTokens, stream: true }));
        let buffer = '';
        let text = '';
        let usage = null;
        let streamError = '';
        let finishReason = '';
        let chunks = 0;
        let firstDeltaAt = 0;
        const sentAt = now();
        // 「等待首个字」的**起点**分两种:
        //   · 整包请求体(图片那条路):请求一交给连接层就算开始等;
        //   · 流式请求体(内联那条路):要等请求体**交完**才开始。fetch 是边发边收的,
        //     若在发之前就报"等待中",归约层会先把发送那一行标成 done/100%,
        //     随后逐块的发送进度再把它打回 doing —— 界面上就是进度条往回跳。
        let waitingSent = false;
        const markWaiting = () => {
            if (waitingSent === true) return;
            waitingSent = true;
            onProgress?.({ stage: 'waiting' });
        };
        if (bodyStream === undefined || bodyStream === null) markWaiting();
        // 流式那条路:把"该报等待了"这件事交给调用方 —— 它才知道请求体什么时候交完
        // (`composeInlineBodyStream` 的 `onEnd`)。
        else if (typeof onWaitStart === 'function') onWaitStart(markWaiting);
        const res = await transport({
            url: `${DASHSCOPE_BASE_URL}${CHAT_PATH}`,
            method: 'POST',
            headers: authHeaders(apiKey, { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(extraHeaders ?? {}) }),
            body,
            ...(bodyStream === undefined || bodyStream === null ? {} : { duplex: duplex ?? 'half' }),
            timeoutMs,
            signal,
            onData: (piece) => {
                // 兜底:服务端**已经在回字节**了,那"等待"无论如何都已经过去。
                // (正常跑不到这里 —— 请求体交完时就报过了。)
                markWaiting();
                const split = splitSseEvents(buffer, piece);
                buffer = split.rest;
                for (const data of split.events) {
                    const evt = parseStreamPayload(data);
                    if (evt.kind === 'delta') {
                        if (firstDeltaAt === 0) firstDeltaAt = now();
                        chunks += 1;
                        text += evt.delta;
                        if (evt.finishReason !== '') finishReason = evt.finishReason;
                        onProgress?.({ stage: 'generating', chars: text.length, chunks, delta: evt.delta });
                    } else if (evt.kind === 'usage') {
                        usage = evt.usage;
                    } else if (evt.kind === 'finish') {
                        finishReason = evt.finishReason;
                    } else if (evt.kind === 'error') {
                        streamError = evt.reason;
                    }
                }
            },
        });
        const finishedAt = now();
        if (res.ok !== true) return failed(res);
        // 流里带错误(HTTP 200 但 body 里报错)时也要按失败走
        if (streamError !== '') return { ok: false, code: 'stream_error', reason: streamError, status: res.status ?? null };
        const trimmed = text.trim();
        if (trimmed === '') {
            return {
                ok: false,
                code: 'bad_response',
                // 空正文有两种,给的话必须分开:一种是被输出上限截断了(用户能改),
                // 另一种是服务端真的什么都没回(用户改不了)。
                reason: finishReason === 'length'
                    ? '模型把这一段用完了输出上限(只回了空内容)。把 max_tokens 调大,或者把提问问得更短。'
                    : '服务端流式返回里没有正文(可能被中断了)',
                status: res.status ?? null,
            };
        }
        const stats = usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, videoTokens: 0, textTokens: 0, imageTokens: 0 };
        return {
            ok: true,
            text: trimmed,
            usage: stats,
            chunks,
            // 首字时刻:从请求发出到第一片正文(实测这段是"看起来卡住"的主体)
            ttftMs: firstDeltaAt === 0 ? finishedAt - sentAt : firstDeltaAt - sentAt,
            generateMs: firstDeltaAt === 0 ? 0 : finishedAt - firstDeltaAt,
            totalMs: finishedAt - sentAt,
        };
    }

    /**
     * 内联那条路:整段字节 → **分块** base64 → 流式发出 → 一次**流式**对话请求。
     *
     * 为什么改成流式发(而不是继续整包):内联的请求体里那段 base64 是整包拼好的,
     * 一次性写出去时"已经发出多少字节"**根本观测不到** —— 于是界面上这一段没有格子
     * (按"没发生的事不画格子"的规矩,连"发送中"都不显示),用户看到的是"点了之后直接
     * 卡在等待首字"。改成逐块编码 + 流式发送之后,这一段有了**真百分比**。
     *
     * ⚠️ 内存:不先把整段 base64 拼出来再发 —— 逐块编码(3 字节对齐)、发完即弃。
     * 峰值 = 原始字节(它本来就在内存里,是过 IPC 递进来的)+ 一块 base64(~1 MiB)。
     *
     * 按路径那条入口只在小文件上走到这里(超过内联上限就走上传),所以这里的
     * "整段字节"最多是十几 MiB。
     */
    async function viaInline({ source, question, model, maxTokens, apiKey, timeoutMs, signal, onProgress, prepareMs = 0 }) {
        const t0 = now();
        const parts = buildInlineBodyParts({
            model, mimeType: source.mimeType, question, maxTokens, stream: true,
            byteLength: source.bytes.byteLength,
        });
        // 进度口径与上传那条路**完全一致**:已经交给连接的字节数 / 请求体总长度。
        let lastPercent = -1;
        let sentDoneAt = 0;
        const startBody = t0;
        const reportSend = (sentBytes) => {
            if (sentBytes >= parts.contentLength && sentDoneAt === 0) sentDoneAt = now();
            const percent = parts.contentLength <= 0 ? 0
                : Math.max(0, Math.min(100, Math.floor((sentBytes / parts.contentLength) * 100)));
            if (percent === lastPercent) return;
            lastPercent = percent;
            try {
                // mode 一起报:阶段文案要说清走的是哪条路(内联没有"上传"这回事)。
                // ⚠️ 阶段名与上传那条路**同一个**(`uploading` = "正在把请求体交给连接"),
                // 两条路共用同一行,只有文案不同。
                onProgress?.({ stage: 'uploading', mode: 'inline', sentBytes, totalBytes: parts.contentLength, percent });
            } catch { /* 进度不影响正事 */ }
        };
        // 「等待首个字」的启动器:请求体交完(onEnd)那一刻才该让"等待"那一行开始计时。
        // 这里先把位置留出来 —— 流的 onEnd 一定晚于 requestStreamingChat 拿到它。
        let markWaiting = null;
        const bodyStream = composeInlineBodyStream({
            // ⚠️ 递**源字节**而不是"编好的 base64 数组":编码在发送过程中一块一块做,
            // 于是内存里不会有"源字节 + 整段 base64"两份。
            bytes: source.bytes,
            prefix: parts.prefix,
            suffix: parts.suffix,
            onBytes: reportSend,
            onEnd: () => markWaiting?.(),
        });
        reportSend(0);
        // 没有流时的请求体(`content`)必须现拼一次:此时请求体是**整包字符串**,
        // 里面得有真的 content —— 给 null 就是一个必然被服务端拒的请求。
        // 只有在"上不了流式"的两条兜底路上才会走到这里(见下),那条路本来就要多占一份内存。
        const inlineContent = () => buildMediaContent({
            url: buildDataUrl({
                mimeType: normalizeVideoMime(source.mimeType) || 'video/mp4',
                base64: toCanonicalBase64(source.bytes),
            }),
            question, kind: 'video',
        });
        const sendChat = (stream) => requestStreamingChat({
            model,
            maxTokens,
            apiKey,
            timeoutMs,
            signal,
            onProgress,
            bodyStream: stream,
            // 整包那条兜底路要用真的 content;流式那条路的请求体是流,content 用不上
            content: stream === null ? inlineContent() : null,
            onWaitStart: (fn) => { markWaiting = fn; },
            // 长度是算好的:带上 Content-Length,于是"发完一块不差"由 HTTP 层再兜一道。
            // ⚠️ 整包兜底路不能带它 —— 那个长度是**流**的总长,与字符串体的长度对不上。
            extraHeaders: stream === null ? undefined : { 'Content-Length': String(parts.contentLength) },
        });
        let chat = await sendChat(bodyStream);
        // 一开始就上不了流(极老运行时)→ 这次走的本来就是整包兜底路,如实记下来
        let uploadBody = bodyStream === null ? 'buffer' : 'stream';
        // ⚠️ 兜底:传输层不认"流 + Content-Length + duplex"这个组合时,退回**整包字符串体**
        // 再发一次(与上传那条路同一个判据 —— 只有看着像**请求体本身**的问题才重试)。
        // 真业务失败(400/401)换一种发法还是失败,重试只会白传一遍 ~19 MB;
        // 超时也不重试:那只会让用户再等一个完整的超时(实测这条路上限是 5 分钟)。
        if (bodyStream !== null && chat.ok !== true && chat.code !== 'timeout' && chat.code !== 'cancelled'
            && chat.status === null && LOOKS_LIKE_BODY_PROBLEM.test(String(chat.reason ?? ''))) {
            log.warn?.(`[video] 内联的流式请求体没走通(${chat.code}),退回整包再发一次`);
            markWaiting = null;
            lastPercent = -1;
            chat = await sendChat(null);
            uploadBody = 'buffer';
            // 整包那条路**没有可观测的中间态**(一次写出去),所以只在成功之后报满 ——
            // 与上传那条路的"单份缓冲"兜底是同一个口径,不编中间百分比。
            if (chat.ok === true) reportSend(parts.contentLength);
        }
        const sentAt = now();
        if (chat.ok !== true) return chat;
        return {
            ok: true,
            text: chat.text,
            model,
            requestId: '',
            usage: chat.usage,
            delivery: {
                mode: 'inline',
                bytes: source.bytes.byteLength,
                base64Bytes: parts.base64Chars,
                // 走的确实是流式请求体(报告与自检据此区分"真流式"与"整包兜底")
                uploadBody,
                timings: {
                    prepareMs,
                    // 这一段现在是**真的**:从开始发到最后一个字节交出去
                    uploadMs: sentDoneAt === 0 ? (sentAt - startBody) : (sentDoneAt - startBody),
                    ttftMs: chat.ttftMs,
                    generateMs: chat.generateMs,
                    totalMs: prepareMs + chat.totalMs,
                },
                chunks: chat.chunks,
            },
        };
    }

    /**
     * 上传那条路:GET 凭证 → multipart POST 到 upload_host → 用 oss:// 调模型。
     * 三步都实测通过(HTTP 200 / 200 / 200),但**只有第三步带上
     * X-DashScope-OssResourceResolve: enable 才成立**。
     *
     * `source` 有两种形状,对应两条入口:
     *   · `{ bytes, name, mimeType }` —— 拖入/粘贴那条(字节已经过 IPC 进来了,≤64 MiB);
     *   · `{ path, size, name, mimeType }` —— 已知本地路径那条(主进程**按路径自己读**,
     *     最大 1024 MB)。后者**流式**发送,文件在内存里只有一条流。
     */
    async function viaUpload({ source, question, model, maxTokens, apiKey, timeoutMs, uploadTimeoutMs, signal, onProgress }) {
        const t0 = now();
        const size = Number(source.size ?? source.bytes?.byteLength ?? 0);
        const policyRes = await transport({
            url: `${DASHSCOPE_BASE_URL}${UPLOAD_POLICY_PATH}?action=getPolicy&model=${encodeURIComponent(model)}`,
            method: 'GET',
            headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }),
            timeoutMs,
        });
        if (policyRes.ok !== true) {
            return failed(policyRes, { codePrefix: 'policy', extra: '取上传凭证失败:' });
        }
        const parsedPolicy = parseUploadPolicy(parseJson(policyRes.text));
        if (parsedPolicy.ok !== true) {
            return { ok: false, code: 'policy_malformed', reason: parsedPolicy.reason, status: policyRes.status ?? null };
        }
        const policy = parsedPolicy.policy;
        // 服务端自己给的单文件上限(实际上传它也会拒,但在这里拒能说清是哪一个限制)。
        // 实测这个数是 1024 MB —— MAX_LOCAL_VIDEO_BYTES 就是照它定的。
        if (policy.maxFileSizeMb > 0 && size > policy.maxFileSizeMb * 1024 * 1024) {
            return {
                ok: false,
                code: 'too_large',
                reason: `这段视频 ${size} 字节,超过服务端这次给的上限 ${policy.maxFileSizeMb} MB,已拒绝`,
                status: null,
            };
        }

        // ⚠️ 文件名必须**唯一**:策略里 forbid_overwrite=true,同一个 key 再传一次
        // 就是 403(实测)。用户把同一个文件拖进来两次是很正常的事。
        const fileName = uniqueUploadName(safeVideoName(source.name, source.mimeType), { now: now(), random });
        // 三段耗时分别记:凭证那一段是"拿一次就要重传一次"的(策略 5 分钟过期),
        // 与上传/对话混在一起就看不出到底是哪一段慢。
        const policyMs = now() - t0;
        const fields = buildUploadFormFields({
            uploadDir: policy.uploadDir,
            fileName,
            policy: policy.policy,
            signature: policy.signature,
            accessKeyId: policy.accessKeyId,
            securityToken: policy.securityToken,
            objectAcl: policy.objectAcl,
            forbidOverwrite: policy.forbidOverwrite,
        });
        // boundary 只用 ASCII 且不含引号:它进了 Content-Type 头。
        const boundary = `----kaiwu${Math.floor(now()).toString(36)}${Math.floor(random() * 1e9).toString(36)}`;

        const sent = await sendUploadBody({ policy, source, size, fields, boundary, fileName, uploadTimeoutMs, signal, onProgress });
        if (sent.ok !== true) return sent.failure;
        const uploadMs = now() - t0 - policyMs;

        const ossUrl = buildOssUrl(policy.uploadDir, fileName);
        const content = buildMediaContent({ url: ossUrl, question, kind: 'video' });
        // ⚠️ 本地文件那条入口的对话超时单独放大:实测 8 分半的 1080p60 要 44.9 秒,
        // 而默认那 2 分钟是按"4 秒短片"定的。
        const chatTimeout = typeof source.path === 'string' ? Math.max(timeoutMs, LOCAL_CHAT_TIMEOUT_MS) : timeoutMs;
        const chat = await requestStreamingChat({
            model,
            content,
            maxTokens,
            apiKey,
            timeoutMs: chatTimeout,
            signal,
            onProgress,
            // 少了这一个头,服务端不解析 oss://,回一句
            // "The provided URL does not appear to be valid"(实测)。
            extraHeaders: { [OSS_RESOLVE_HEADER]: OSS_RESOLVE_VALUE },
        });
        const chatMs = now() - t0 - policyMs - uploadMs;
        if (chat.ok !== true) {
            return { ...chat, code: chat.code === '' ? 'upload_chat_failed' : `upload_chat_${chat.code}` };
        }
        return {
            ok: true,
            text: chat.text,
            model,
            requestId: '',
            usage: chat.usage,
            delivery: {
                mode: 'upload',
                bytes: size,
                base64Bytes: base64Length(size),
                ossUrl,
                fileName,
                // 走了流式还是"单份缓冲"兜底 —— 报告内存口径时要用到它
                uploadBody: sent.mode,
                timings: {
                    prepareMs: policyMs,
                    uploadMs,
                    ttftMs: chat.ttftMs,
                    generateMs: chat.generateMs,
                    totalMs: now() - t0,
                },
                // 旧的整包口径读数保留,报告里两个口径都能对上
                policyMs,
                uploadMs,
                chatMs,
                chunks: chat.chunks,
            },
        };
    }

    /**
     * 把 multipart 发出去。**优先流式**(文件不进内存),失败再退到"单份缓冲"。
     *
     * 为什么要两条:流式要 undici 的 `duplex:'half'`,而且带上显式 Content-Length 时
     * 某些实现对"流 + 长度"这个组合很挑剔;真撞上时退到单份缓冲 ——
     * 那一条**只占一份内存**(文件字节由 readInto 直接读进缓冲中间),不是两份。
     * 返回值里带 `mode`,所以"这次到底走了哪条"是可观测、可报告的。
     */
    async function sendUploadBody({ policy, source, size, fields, boundary, fileName, uploadTimeoutMs, signal, onProgress }) {
        const parts = buildMultipartParts({
            fields,
            file: { name: fileName, mimeType: source.mimeType, byteLength: size },
            boundary,
        });
        // 进度只在**文件字节**上算百分比:multipart 的前后缀一共几 KB,算进去也不会
        // 让读数变准,反而让"100%"落在一个用户不关心的边界上。
        // `sentBytes` 是单调递增的,**永远不回退** —— 回退的进度条是假的进度条。
        let lastPercent = -1;
        const reportUpload = (sentBytes) => {
            const percent = size <= 0 ? 0 : Math.max(0, Math.min(100, Math.floor((sentBytes / size) * 100)));
            if (percent === lastPercent) return;      // 千分位级的抖动不必过 IPC
            lastPercent = percent;
            // mode 与内联那条路同一个字段名:阶段文案据此区分"上传到服务端"与"发送请求体"
            try { onProgress?.({ stage: 'uploading', mode: 'upload', sentBytes, totalBytes: size, percent }); } catch { /* 进度不影响正事 */ }
        };
        const uploadFailure = (res) => ({
            ok: false,
            // 取消不是"上传失败":用户自己按的,红一行"上传失败"会让人以为出了故障。
            code: res.cancelled === true ? 'cancelled' : 'upload_failed',
            // OSS 的失败是 XML,不是 JSON —— 直接给状态码与一小段原文,别让
            // classifyChatFailure 去猜(它会当 JSON 解析失败,原因就丢了)。
            reason: `临时上传失败(HTTP ${res.status ?? '无响应'})`
                + `${String(res.networkError ?? '') !== '' ? `:${res.networkError}` : ''}`
                + `${String(res.text ?? '').trim() === '' ? '' : ` —— ${String(res.text).slice(0, 300)}`}`,
            status: res.status ?? null,
        });

        // ---- ① 流式(只有按路径那条入口才有文件流可开)----
        if (typeof source.path === 'string' && source.path !== '') {
            try {
                const stream = composeUploadStream([parts.prefix, await openFileStream(source.path), parts.suffix], { onBytes: reportUpload });
                if (stream !== null) {
                    const res = await transport({
                        url: policy.uploadHost,
                        method: 'POST',
                        // ⚠️ 不带 Authorization:OSS 表单上传认的是 policy + signature,
                        // 多带一个 OAuth 头既无意义,又把密钥送到了一个不该收到它的主机上。
                        headers: { 'Content-Type': parts.contentType, 'Content-Length': String(parts.contentLength) },
                        body: stream,
                        duplex: 'half',
                        timeoutMs: uploadTimeoutMs,
                        signal,
                    });
                    if (res.ok === true) { reportUpload(size); return { ok: true, mode: 'stream' }; }
                    // 只有"这一条路本身不被支持"才退回缓冲;真的业务失败(403 等)直接报出去,
                    // 换一种发法也还是失败,只会白传一遍 170 MB。
                    const text = String(res.text ?? '') + String(res.networkError ?? '');
                    const looksLikeBodyProblem = res.status === null || LOOKS_LIKE_BODY_PROBLEM.test(text);
                    if (looksLikeBodyProblem !== true) return { ok: false, failure: uploadFailure(res) };
                    log.warn?.(`[video] 流式上传没走通(${String(res.networkError ?? res.status)}),退回单份缓冲`);
                }
            } catch (err) {
                log.warn?.('[video] 流式上传起不来,退回单份缓冲', err);
            }
        }

        // ---- ② 缓冲那条路(两种入口共用)----
        //   · 已知路径:用"单份缓冲"—— 文件字节直接读进这块缓冲的中间,**只有一份**;
        //   · 拖入/粘贴(字节本来就在内存里):照旧拼一份请求体 —— 那条入口的文件
        //     本来就已经在内存里了(≤64 MiB),再拼一份不会有量级上的差别。
        const isPath = typeof source.path === 'string' && source.path !== '';
        const body = isPath
            ? createSingleCopyBodyBuilder({ readInto: readInto ?? defaultReadInto })({ parts, path: source.path, size, onBytes: reportUpload })
            : buildMultipartBody({
                fields,
                file: { name: fileName, mimeType: source.mimeType, bytes: source.bytes },
                boundary: parts.boundary,
            }).body;
        // 字节本来就在内存里那条入口(拖入/粘贴 ≤64 MiB)没有阶段可言:一次写出去,
        // 中途没有可观测的中间态,所以只报一次"正要发"。
        reportUpload(0);
        const res = await transport({
            url: policy.uploadHost,
            method: 'POST',
            headers: { 'Content-Type': parts.contentType },
            body,
            timeoutMs: uploadTimeoutMs,
            signal,
        });
        if (res.ok !== true) return { ok: false, failure: uploadFailure(res) };
        reportUpload(size);
        return { ok: true, mode: isPath ? 'single-copy-buffer' : 'buffer' };
    }

    /**
     * 图片理解。**与视频走同一条路** —— 同一个端点、同一套鉴权、同一个解析、
     * 同一份错误映射,只把 content 项换成 `{type:'image_url'}`。
     *
     * 为什么写在同一个 provider 里(而不是另起一个 image provider):这两条路的
     * 请求体构造、超时、`usage` 解析、错误码映射**完全一样**;拆成两份就是把它们
     * 抄两遍,而抄两遍的东西迟早只有一边被修好(比如"401 要映射成 auth_failed"
     * 只改了一处)。差别只有两样:content 项的形状,以及图片走不走上传。
     * 图片比视频小得多,而且实测同一次内联就能过,所以这里**只走内联**。
     *
     * @param {{mimeType?:string, bytes?:unknown, question?:string}} input
     * @returns {Promise<object>} 与 understand 同一个形状。
     */
    async function understandImage(input = {}) {
        // 图片的判据用 agent-image.js 那一份(类型白名单 / 单张与总量上限 / 字节与声明相符)
        const admitted = admitImagePayload([{ mimeType: input.mimeType, bytes: input.bytes }]);
        if (admitted.ok !== true) {
            return { ok: false, code: 'invalid_input', reason: admitted.reason, status: null };
        }
        const image = admitted.images[0];
        const keyInfo = resolveKey() ?? {};
        const apiKey = String(keyInfo.secret ?? '');
        if (keyInfo.ok !== true || apiKey === '') {
            return {
                ok: false,
                code: 'missing_key',
                reason: String(keyInfo.reason ?? '').trim() || MISSING_KEY_REASON,
                status: null,
            };
        }
        const cfg = config() ?? {};
        const model = normalizeVideoModel(cfg.model) || DEFAULT_VIDEO_MODEL;
        const maxTokens = Number.isFinite(cfg.maxTokens) && cfg.maxTokens > 0
            ? Math.floor(cfg.maxTokens) : DEFAULT_MAX_TOKENS;
        const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;

        const base64 = toCanonicalBase64(image.bytes);
        const url = buildDataUrl({ mimeType: image.mimeType, base64 });
        const content = buildMediaContent({ url, question: input.question, kind: 'image' });
        const started = now();
        try {
            // 图片也走**同一条流式请求**:不是为了图片的进度条(图片几秒就回来了,
            // 界面上不给它阶段行),而是为了"对话只有一条路" —— 留一条整包老路,
            // 它就永远只有一边会被修(比如"401 要映射成 auth_failed")。
            const chat = await requestStreamingChat({ model, content, maxTokens, apiKey, timeoutMs });
            if (chat.ok !== true) return chat;
            return {
                ok: true,
                text: chat.text,
                model,
                requestId: '',
                usage: chat.usage,
                delivery: {
                    mode: 'inline',
                    kind: 'image',
                    bytes: image.bytes.byteLength,
                    base64Bytes: base64.length,
                    timings: { prepareMs: 0, uploadMs: 0, ttftMs: chat.ttftMs, generateMs: chat.generateMs, totalMs: now() - started },
                    chunks: chat.chunks,
                    chatMs: now() - started,
                    totalMs: now() - started,
                },
            };
        } catch (err) {
            log.warn?.('[video] 理解图片时抛了异常', err);
            return { ok: false, code: 'provider_error', reason: `理解失败:${String(err?.message ?? err)}`, status: null };
        }
    }

    /** 理解一段视频。
     *
     * @param {{mimeType?:string, bytes?:unknown, name?:string, question?:string}} input
     *        渲染进程递来的**叶子字段**;这里会**从头再判一遍**(不可信输入)。
     * @returns {Promise<object>} 成功 `{ok:true, text, usage, delivery, …}`;
     *          失败 `{ok:false, code, reason, status}`。**绝不 throw 业务失败**。
     */
    async function understand(input = {}) {
        // 「准备请求」这一段**真的存在**:校验入参、解析密钥、算 delivery 都要时间
        // (密钥解密尤其不是零成本)。而且这一段失败时,红框必须落在这一行上 ——
        // 用户看到的"理解失败"多数其实是本地的准入判断拒了。
        input.onProgress?.({ stage: 'preparing' });
        // 权威校验:类型白名单 / 段数 / 单段上限 / 字节与声明是否相符。
        const admitted = admitVideoPayload([{
            mimeType: input.mimeType,
            bytes: input.bytes,
            name: input.name,
        }]);
        if (admitted.ok !== true) {
            // 码沿用纯模块判出来的那一个(too_large / not_a_video / mime_mismatch …):
            // 界面据它决定说哪一句、给哪个下一步,而不是回头去猜中文文案。
            return { ok: false, code: admitted.code ?? 'invalid_input', reason: admitted.reason, status: null };
        }
        const video = admitted.videos[0];

        const keyInfo = resolveKey() ?? {};
        const apiKey = String(keyInfo.secret ?? '');
        if (keyInfo.ok !== true || apiKey === '') {
            return {
                ok: false,
                code: 'missing_key',
                reason: String(keyInfo.reason ?? '').trim() || MISSING_KEY_REASON,
                status: null,
            };
        }

        const cfg = config() ?? {};
        const model = normalizeVideoModel(cfg.model) || DEFAULT_VIDEO_MODEL;
        const maxTokens = Number.isFinite(cfg.maxTokens) && cfg.maxTokens > 0
            ? Math.floor(cfg.maxTokens) : DEFAULT_MAX_TOKENS;
        const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
        const uploadTimeoutMs = Number.isFinite(cfg.uploadTimeoutMs) && cfg.uploadTimeoutMs > 0
            ? cfg.uploadTimeoutMs : DEFAULT_UPLOAD_TIMEOUT_MS;

        const delivery = chooseDelivery({
            byteLength: video.bytes.byteLength,
            mimeType: video.mimeType,
            inlineLimitBytes: cfg.inlineLimitBytes,
        });
        if (delivery.mode === 'reject') {
            return { ok: false, code: 'too_large', reason: delivery.reason, status: null };
        }

        // 日志只说体积与路径,**绝不打请求体**(里面是整段 base64)与密钥。
        log.info?.(`[video] 理解 ${video.name}(${video.mimeType}, ${video.bytes.byteLength} 字节)`
            + ` → ${delivery.mode}(${delivery.reason})`);
        // 走到这里"准备"才算完:下面每一步都是"已经知道要发什么、发去哪"。
        input.onProgress?.({ stage: 'prepared', mode: delivery.mode, totalBytes: video.bytes.byteLength });

        const common = {
            source: { bytes: video.bytes, name: video.name, mimeType: video.mimeType, size: video.bytes.byteLength },
            question: input.question, model, maxTokens, apiKey, timeoutMs, uploadTimeoutMs,
            // 取消与进度是**主进程注入的**:它们不是能过 IPC 的叶子字段,
            // 而是 main 那边按 requestId 现建的 AbortSignal 与推送函数。
            signal: input.signal, onProgress: input.onProgress,
        };
        try {
            return delivery.mode === 'inline' ? await viaInline(common) : await viaUpload(common);
        } catch (err) {
            // transport 的契约是"不 throw",但注入的假传输层/将来的实现可能违约。
            // 违约时给一句能读的中文,而不是让一个异常穿过 IPC 边界(那边只剩 message)。
            log.warn?.('[video] 理解时抛了异常', err);
            return { ok: false, code: 'provider_error', reason: `理解失败:${String(err?.message ?? err)}`, status: null };
        }
    }

    /**
     * 按**本地路径**理解一段视频。给"队列里已经下好的文件"那条入口用。
     *
     * 与 `understand()` 的分工:
     *   · `understand()` 收的是渲染进程过 IPC 递来的**字节**(≤64 MiB,那条限制管的是
     *     IPC 拷贝量);
     *   · 这一个只收**路径字符串**,文件由主进程自己读 —— 所以上限抬到
     *     `MAX_LOCAL_VIDEO_BYTES`(1024 MB,服务端 getPolicy 实测值)。
     *
     * ⚠️ 安全:递路径 = "让主进程读一个文件并发给第三方"。所以准入判据
     * (`admitVideoPath`)从头核四件事:绝对路径、扩展名在白名单、文件存在且是文件、
     * 而且**如果给了下载目录,路径必须落在它里面**。渲染进程额外塞的字段一概不采信。
     *
     * @param {{path?:string, folder?:string, question?:string, name?:string, mimeType?:string}} input
     */
    async function understandFromPath(input = {}) {
        input.onProgress?.({ stage: 'preparing' });
        const rawPath = String(input.path ?? '');
        let stat = null;
        try {
            stat = statFile(rawPath);
        } catch {
            stat = { exists: false, isFile: false, size: 0 };
        }
        const admitted = admitVideoPath({
            path: rawPath,
            folder: input.folder,
            exists: stat?.exists === true,
            isFile: stat?.isFile === true,
            size: stat?.size,
        });
        if (admitted.ok !== true) {
            return { ok: false, code: admitted.code, reason: admitted.reason, status: null };
        }

        const keyInfo = resolveKey() ?? {};
        const apiKey = String(keyInfo.secret ?? '');
        if (keyInfo.ok !== true || apiKey === '') {
            return {
                ok: false,
                code: 'missing_key',
                reason: String(keyInfo.reason ?? '').trim() || MISSING_KEY_REASON,
                status: null,
            };
        }

        const cfg = config() ?? {};
        const model = normalizeVideoModel(cfg.model) || DEFAULT_VIDEO_MODEL;
        const maxTokens = Number.isFinite(cfg.maxTokens) && cfg.maxTokens > 0
            ? Math.floor(cfg.maxTokens) : DEFAULT_MAX_TOKENS;
        const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
        const uploadTimeoutMs = Number.isFinite(cfg.uploadTimeoutMs) && cfg.uploadTimeoutMs > 0
            ? cfg.uploadTimeoutMs : LOCAL_UPLOAD_TIMEOUT_MS;

        const mimeType = normalizeVideoMime(input.mimeType)
            || (admitted.extension === '.mov' ? 'video/quicktime'
                : (admitted.extension === '.webm' ? 'video/webm'
                    : (admitted.extension === '.mkv' ? 'video/x-matroska' : 'video/mp4')));
        const name = safeVideoName(
            String(input.name ?? '').trim() || rawPath.split(/[\\/]/).pop() || 'video.mp4',
            mimeType,
        );

        const delivery = chooseDelivery({
            byteLength: admitted.size,
            mimeType,
            inlineLimitBytes: cfg.inlineLimitBytes,
            maxBytes: MAX_LOCAL_VIDEO_BYTES,
        });
        if (delivery.mode === 'reject') {
            return { ok: false, code: 'too_large', reason: delivery.reason, status: null };
        }
        log.info?.(`[video] 按路径理解 ${name}(${mimeType}, ${admitted.size} 字节)`
            + ` → ${delivery.mode}(${delivery.reason})`);
        input.onProgress?.({ stage: 'prepared', mode: delivery.mode, totalBytes: admitted.size });

        const source = { path: rawPath, name, mimeType, size: admitted.size };
        const extra = { signal: input.signal, onProgress: input.onProgress };
        try {
            if (delivery.mode === 'inline') {
                // 内联只发生在小文件上(≤ 内联上限),整读一次是合理的。
                source.bytes = readFileBytes(rawPath);
                return await viaInline({ source, question: input.question, model, maxTokens, apiKey, timeoutMs, uploadTimeoutMs, ...extra });
            }
            return await viaUpload({ source, question: input.question, model, maxTokens, apiKey, timeoutMs, uploadTimeoutMs, ...extra });
        } catch (err) {
            log.warn?.('[video] 按路径理解时抛了异常', err);
            return { ok: false, code: 'provider_error', reason: `理解失败:${String(err?.message ?? err)}`, status: null };
        }
    }

    return { understand, understandImage, understandFromPath };
}
