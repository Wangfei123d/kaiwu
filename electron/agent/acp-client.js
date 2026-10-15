// ACP 客户端:握手、会话、提示流式、权限请求。
//
// 不引 @agentclientprotocol/sdk 的原因(见计划 Task 4 说明):
// 握手与会话的确切形状已经实测过(.agent-probe/acp-verify.txt),手写的量很小,
// 而且能保持零依赖 + 可脱机测。真到了要接 MCP / 文件回调那天再换,只影响这一个文件。
import { METHODS, PROTOCOL_VERSION } from '../../app/lib/acp-protocol.js';
import { buildAcpPromptBlocks } from '../../app/lib/agent-image.js';

export function createAcpClient({ transport, log = console, protocolVersion = PROTOCOL_VERSION }) {
    let nextId = 1;
    // 释放之后连接就拆了:任何新请求都不可能有人回答(响应再也不会回来)。
    // 没有这道闸,call() 会照常登记进 pending 并把请求写出去 —— 对调用方
    // 就是一个永远挂着的 promise(终审 Important 6)。
    let disposed = false;
    const pending = new Map();          // id -> { resolve, reject }
    const requestHandlers = new Set();  // 处理对端发来的**请求**(有 id + method)
    // 通知(没有 id)的订阅者。prompt() 只在自己那个会话的增量上回调 ——
    // 多会话并存时,增量不能串到别的会话去。
    const updateListeners = new Set();

    const off = transport.onMessage((msg) => {
        // 1) 对端发来的请求(有 id **且有 method**)—— 必须排在最前面判。
        //    JSON-RPC 的 id 空间是**分方向**的:对端用自己的计数器编号,与我们发出去的
        //    请求 id 各自独立,双方都从 1 开始,撞车完全正常。若先按 id 认领"响应",
        //    对端的 session/request_permission 会被静默当成某个在飞请求的响应吞掉:
        //    反向请求永远到不了 onRequest(权限卡片永远不弹),而我们那个请求还拿到一个
        //    {method, params} 形状的假结果。请求必有 method、响应必无,这就是判据。
        if (msg.id !== undefined && typeof msg.method === 'string') {
            const handler = findHandler(msg.method);
            if (handler) {
                // ⚠️ 先包进微任务再调用,不能写成 Promise.resolve(handler.handle(msg)):
                // 那样 handler.handle **当场**就被求值了,而 handler 是应用代码,同步抛错时
                // 这一次调用发生在本函数里,会直接穿过 emit 的 try/catch 逃出去 ——
                // 下面的 .catch 只接得住**异步**拒绝。代价是:对端那个请求**永远没有响应**
                // (ACP 那边一直等),而我们这边只留一条 warn,看起来一切正常。
                // 包一层之后,同步抛错也变成一次 promise 拒绝,统一落到 -32603 那条路。
                Promise.resolve()
                    .then(() => handler.handle(msg))
                    .then(result => transport.send({ jsonrpc: '2.0', id: msg.id, result }))
                    .catch(err => transport.send({
                        jsonrpc: '2.0', id: msg.id,
                        error: { code: -32603, message: String(err?.message ?? err) },
                    }));
            } else {
                transport.send({
                    jsonrpc: '2.0', id: msg.id,
                    error: { code: -32601, message: `客户端不支持:${msg.method}` },
                });
            }
            return;
        }
        // 2) 我们发出去的请求的响应(没有 method)
        if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) {
                const err = new Error(`ACP 错误 ${msg.error.code}:${msg.error.message}`);
                err.code = msg.error.code;
                reject(err);
            } else {
                resolve(msg.result);
            }
            return;
        }
        // 3) 通知(没有 id):session/update 之类,交给订阅者
        for (const fn of updateListeners) {
            try { fn(msg); } catch (err) { log.warn?.('[acp] update 监听器抛错', err); }
        }
    });

    function call(method, params) {
        // 当场拒绝,连 pending 都不碰:登记进去只会留下一个永远不会落地的等待者。
        if (disposed) {
            return Promise.reject(new Error(`ACP 客户端已释放(dispose),不再接受请求:${method}`));
        }
        const id = nextId++;
        return new Promise((resolve, reject) => {
            // method 必须留下来:后面拒绝时要靠它说清"谁在等什么"(见 failPending)。
            pending.set(id, { resolve, reject, method });
            // ⚠️ transport.send 的布尔回执**就是给这里用的**(见 agent-supervisor 的
            // transport.send 注释):报 false = 这条请求根本没交出去 = 响应永远不会来。
            // 这时候还留在 pending 里傻等,就是界面上一个永远不停的转圈 ——
            // 当场摘掉并以"没发出去"拒绝。
            // ⚠️ 只认**明确的 false**:undefined(手写的假传输、不返回回执的实现)一律当
            // "交出去了"。写成 !sent 会把这些传输的每一条请求都判死。
            const sent = transport.send({ jsonrpc: '2.0', id, method, params });
            if (sent === false) {
                pending.delete(id);
                reject(new Error(`ACP 请求没发出去(transport.send 回 false):${method}`));
            }
        });
    }

    /**
     * 找一个能接 `method` 的 handler;找不到返回 null。
     *
     * canHandle 和应用层的 handle 一样是**别人写的代码**,它抛错只当"这个接不了"处理:
     * 让它逃出去就等于一个坏 handler 把整个派发打断 —— 后面那些好 handler 再也没机会接,
     * 对端的请求也永远拿不到响应。找不到任何 handler 时由调用方回 -32601,是明确的结局。
     */
    function findHandler(method) {
        for (const h of requestHandlers) {
            try {
                if (h.canHandle(method)) return h;
            } catch (err) {
                log.warn?.('[acp] canHandle 抛错,当作接不了:', err);
            }
        }
        return null;
    }

    /**
     * 让所有在飞请求当场失败。
     *
     * 为什么需要它:Agent 崩掉之后,对端**再也不可能**回响应,而 pending 里那些
     * promise 没有任何人会去 settle —— `prompt()` 会永远挂着,界面上就是一个永远不会停
     * 的转圈。进程失败必须是**可见**的(设计文档 §5.1),所以由调用方在得知进程已死时
     * 把原因传进来,逐个叫醒等待者。这里只管叫醒,不碰传输、不碰监护人 ——
     * 本模块保持与传输无关(接到 crashed 状态上是组合点的活,不是这里)。
     *
     * 幂等:表空时(或第二次调用)直接返回,不抛。
     */
    function failPending(reason) {
        if (pending.size === 0) return;
        // 没有原因也要给一句人话:以前会拼出 "ACP 请求失败:undefined",那种消息在
        // 崩溃现场等于没说。调用方忘了传原因不该由读日志的人来付代价。
        const raw = reason?.message ?? reason;
        const detail = raw === undefined || raw === null ? '未指明原因' : raw;
        // 先取出并清空再拒绝:reject 的处理函数里完全可能立刻发起新请求,
        // 边遍历边删会把那些**新**请求一起拒掉。
        const waiters = [...pending.values()];
        pending.clear();
        // ⚠️ 每个等待者**各自**一个 Error,并在消息里点名它在等哪个方法:
        // 共用一个实例时堆栈只指向 failPending 这一处,崩溃现场根本分不清是 who 挂了;
        // 而"谁在等 session/prompt、谁在等 session/new"正是最要紧的那条信息。
        for (const { reject, method } of waiters) {
            reject(new Error(`ACP 请求失败(${method}):${detail}`));
        }
    }

    return {
        call,

        /**
         * 发一条**通知**:不登记 pending、不等响应。
         *
         * 为什么不能拿 `call` 凑合:`call` 会往 pending 里塞一个等待者,而通知
         * (ACP 的 `session/cancel` 就是)根本没有响应 —— 那一条会永远挂在表里,
         * 调用方也永远在等。这个模块存在的意义之一就是消灭"永不落地的等待"。
         *
         * ⚠️ 它顺便**摘掉同名方法的在飞请求**:调用点用 notify 发 `session/cancel`
         * 时,本地那一次 prompt 已经以"已取消"收场了,之后再回来的真正响应不该
         * 再被认领(认领了也没人要,只是留一条悬着的账)。摘掉之后那条响应会落到
         * "没有对应请求"的静默丢弃路径 —— 不抛错、也不产生未处理的拒绝。
         *
         * @param {string} method
         * @param {object} [params]
         * @returns {boolean} 与 transport.send 一致:这条消息是否真的交出去了
         */
        notify(method, params) {
            if (disposed) return false;
            for (const [id, entry] of [...pending.entries()]) {
                if (entry.method === method) pending.delete(id);
            }
            return transport.send({ jsonrpc: '2.0', method, params });
        },

        /** 让所有在飞请求立刻以 `reason` 拒绝(幂等)。见 failPending 的说明。 */
        failPending,

        async initialize(clientInfo, { expectVersion = protocolVersion } = {}) {
            const result = await call(METHODS.INITIALIZE, {
                protocolVersion: expectVersion,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo,
            });
            if (result?.protocolVersion !== expectVersion) {
                throw new Error(
                    `协议版本不匹配:对端 ${result?.protocolVersion},本端只支持 ${expectVersion}`);
            }
            return result;
        },

        /** 问一次"这条连接现在能不能收内联图片"(kaiwu 私约方法,见 acp-protocol 的说明)。 */
        async capabilities({ sessionId }) {
            const r = await call(METHODS.CAPABILITIES, { sessionId });
            return { image: r?.image === true };
        },

        async newSession({ cwd, mcpServers = [] } = {}) {
            const r = await call(METHODS.SESSION_NEW, { cwd, mcpServers });
            return { sessionId: r.sessionId, configOptions: r.configOptions ?? [] };
        },

        /**
         * 改一条会话配置(模型 / 思考强度)。
         *
         * ⚠️ `value` **原样透传**:它对我们是**不透明串**(模型那条实际是
         * `["provider","model"]` 的 JSON,但那是对端的实现细节)。
         * 界面负责把选中的那一项**原封不动**递回来,谁也不许解析或拼装它。
         * 空串是合法的(ACP 用 "" 表示 "Provider default")。
         */
        async setConfigOption({ sessionId, configId, value }) {
            const r = await call(METHODS.SESSION_SET_CONFIG_OPTION, { sessionId, configId, value });
            return { configOptions: r?.configOptions ?? [] };
        },

        /**
         * 列对端的会话(「AI 会话」清单的数据来源之一)。
         *
         * ⚠️ 只回 `{sessionId, cwd}`:没有标题、没有时间、没有内容,而且**不列正在活跃的会话**
         *    (实测 dsh-acp 会把活跃/子代理/派生会话全过滤掉)。所以清单里那些字段只能由
         *    kaiwu 自己的台账出,"能不能接着聊"也要把活跃那一份自己记着。
         * @param {{cwd?:string, cursor?:string}} [options] cwd 省略 = 所有工作目录
         */
        async listSessions({ cwd, cursor } = {}) {
            const params = {};
            if (typeof cwd === 'string' && cwd !== '') params.cwd = cwd;
            if (typeof cursor === 'string' && cursor !== '') params.cursor = cursor;
            const r = await call(METHODS.SESSION_LIST, params);
            return {
                sessions: Array.isArray(r?.sessions) ? r.sessions : [],
                nextCursor: typeof r?.nextCursor === 'string' ? r.nextCursor : null,
            };
        },

        /**
         * 恢复一条历史会话(「接着聊」)。响应里**只有 configOptions** —— 对端不重放旧消息。
         * @param {{sessionId:string, cwd:string}} input
         */
        async resumeSession({ sessionId, cwd }) {
            const r = await call(METHODS.SESSION_RESUME, { sessionId, cwd });
            return { configOptions: r?.configOptions ?? [] };
        },

        async prompt({ sessionId, text, images = [], onUpdate }) {
            // 只在这个会话的增量上回调 —— 多会话并存时不能串
            const listener = (msg) => {
                if (msg.method !== METHODS.SESSION_UPDATE) return;
                if (msg.params?.sessionId !== sessionId) return;
                onUpdate?.(msg.params.update);
            };
            // prompt 块的形状只由 app/lib/agent-image.js 那一份组装:
            // 没有图片时它输出的就是从前手写的 `[{type:'text', text}]`,逐字节相同;
            // 有图片时追加 `{type:'image', mimeType, data}`,data 是规范化 base64
            // (桥的 decodeImage 只认规范 base64 与那四种 mime)。
            const built = buildAcpPromptBlocks({ text, images });
            if (built.ok !== true) throw new Error(built.reason);
            updateListeners.add(listener);
            try {
                const r = await call(METHODS.SESSION_PROMPT, {
                    sessionId,
                    prompt: built.blocks,
                });
                return { stopReason: r?.stopReason ?? null };
            } finally {
                updateListeners.delete(listener);
            }
        },

        /** 处理对端发来的请求(比如 session/request_permission)。 */
        onRequest({ canHandle, handle }) {
            const entry = { canHandle, handle };
            requestHandlers.add(entry);
            return () => requestHandlers.delete(entry);
        },

        // 释放的同时把在飞请求一并拒掉:这时候连接已经拆了,不会再有响应回来,
        // 留着它们就是永远不会落地的 spinner。之后来的请求由 call() 那道
        // disposed 闸当场拒绝(幂等:重复 dispose 不抛)。
        dispose() {
            if (disposed) return;
            disposed = true;
            off();
            updateListeners.clear();
            requestHandlers.clear();
            failPending('客户端已释放(dispose)');
        },
    };
}
