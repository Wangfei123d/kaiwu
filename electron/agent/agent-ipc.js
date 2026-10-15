// Agent 子系统的 IPC 注册。与 main.js 解耦,便于单测与阅读 ——
// 和 notes-ipc.js 同一个模式:依赖注入(ipcMain / getWindow / runtime),
// 返回一个带 dispose 的句柄。
//
// 边界都在主进程这一侧:渲染进程只能递 text / requestId / optionId 这类叶子字段,
// **递不进命令、路径、环境变量** —— 那些只由 agent-runtime 从应用设置与
// app/lib/agent-command.js 的候选清单里算出来(设计文档 §5.4)。
//
// 主进程 → 渲染进程只有一条推送频道 `agent:event`,事件形状是冻结契约
// (见 docs/superpowers/plans/2026-09-18-kaiwu-m3-b-agent-panel.md)。

// 黏贴截图的**权威**判据(类型白名单 / 单张与总量上限 / 字节是否与声明相符)
// 只在 app/lib/agent-image.js 那一份里,渲染层拿同一份做即时反馈。
import { admitImagePayload } from '../../app/lib/agent-image.js';

/** 注册的频道名。preload 的白名单必须与它逐字一致。 */
export const AGENT_INVOKE_CHANNELS = Object.freeze([
    'agent:status',
    'agent:credentials',
    'agent:start',
    'agent:stop',
    'agent:send',
    'agent:cancel',
    // 改会话配置(模型 / 思考强度)。渲染进程只递 { configId, value } 两个字符串,
    // 而 value 是从对端那份 configOptions 里**原样抄回来**的不透明串。
    'agent:setConfig',
    // 换模型之后重新问一次"能不能收图片"(桥那边由 kaiwu 自己的补丁提供问法)。
    'agent:capabilities',
    'agent:permission',
    // 按需翻译(思考条上的「译」)。它**不是**一次提示:走桥的非标准方法,不碰当前那一轮。
    'agent:translate',
]);

/** 推送频道。只有一个 —— 形状由 kind 区分。 */
export const AGENT_EVENT_CHANNEL = 'agent:event';

/**
 * 把 Error 里的机器可读字段原样带过去。
 *
 * ⚠️ 这条只覆盖**其余频道**(send / permission 那些)的拒绝。别指望它能把
 * `agent:start` 的 state / snapshot 送过真 IPC —— 实测过不去(见
 * startFailureResult),所以那个频道已经改成 resolve 结果对象、不 throw 了。
 * 留着它是因为"能带就带"对别的频道仍然有用(比如将来要按 code 分支)。
 */
function rethrow(err) {
    const wrapped = new Error(String(err?.message ?? err));
    if (err !== null && typeof err === 'object') {
        if (typeof err.state === 'string') wrapped.state = err.state;
        if (err.snapshot !== null && typeof err.snapshot === 'object') wrapped.snapshot = { ...err.snapshot };
        if (err.code !== undefined) wrapped.code = err.code;
    }
    return wrapped;
}

/**
 * 把非就绪的 start() 失败折成**可过 IPC 的返回值**。
 *
 * ⚠️ 为什么不能 reject:实测真 Electron 44.4.1,`ipcMain.handle` 里 throw 的 Error
 * 到渲染进程**只剩 message/stack** —— state / snapshot / code **全丢**,message 还被
 * 加上 `Error invoking remote method '...'` 前缀。于是"非就绪"这个机器可读的事实
 * 在真实边界上根本不成立,面板只能走兜底分支。
 *
 * 判据是 `err.state` 是否存在:它由监护人的 notReadyError 挂在错误对象上,
 * 是"这次 start 没就绪"的标记。别的错误(参数错、没有 Vault、接线错)没有它,
 * 照旧 reject —— 那些是真故障,不该被装扮成"Agent 没连上"。
 */
function startFailureResult(err) {
    const snapshot = (err?.snapshot !== null && typeof err?.snapshot === 'object')
        ? { ...err.snapshot } : null;
    return {
        ok: false,
        state: typeof err?.state === 'string' ? err.state : (snapshot?.state ?? null),
        snapshot,
        message: String(err?.message ?? err),
    };
}

/**
 * @param {{ipcMain:object, getWindow:()=>object|null, runtime:object, log?:object}} deps
 * @returns {{dispose:()=>void, emit:(event:object)=>void}}
 */
export function registerAgentIpc({ ipcMain, getWindow, runtime, log = console }) {
    if (runtime === null || typeof runtime !== 'object') {
        throw new Error('registerAgentIpc 需要 runtime(createAgentRuntime 的产物)');
    }

    /**
     * 把 runtime 的事件推给渲染进程。
     * 只递**纯数据**:runtime 给的已经是叶子字段快照(契约见计划),这里再原样
     * 走一次 Electron 的结构化克隆 —— 绝不把 Electron 的 event 对象递给页面。
     */
    function emit(event) {
        const win = getWindow();
        if (win === null || win === undefined) return;
        if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
        win.webContents.send(AGENT_EVENT_CHANNEL, event);
    }

    const handlers = {
        'agent:status': () => runtime.status(),

        // 只有叶子字段(ok / source / reason)—— **绝不含密钥值**(设计文档 §5.4)。
        'agent:credentials': () => runtime.credentials(),

        // 契约(2026-09-18 评审后改过):**就绪 resolve `{ok:true, status}`**,
        // 非就绪 resolve `{ok:false, state, snapshot, message}` —— **不 reject**
        // (reject 路上的字段过不了真 IPC,见 startFailureResult)。
        'agent:start': async () => {
            try {
                return { ok: true, status: await runtime.start() };
            } catch (err) {
                if (typeof err?.state !== 'string') throw err;
                log.warn?.(`[agent] agent:start 未就绪(${err.state}):${err.message ?? err}`);
                return startFailureResult(err);
            }
        },

        'agent:stop': () => runtime.stop(),

        'agent:send': (_event, payload = {}) => {
            const text = typeof payload?.text === 'string' ? payload.text : '';
            // 黏贴截图:渲染进程递来的只有 `{mimeType, bytes}` 两个叶子字段
            // (没有路径、没有命令、没有环境变量)。**权威校验在主进程这一侧**:
            // 类型白名单、单张/总量/张数上限、以及字节与声明是否相符 ——
            // 截图来自剪贴板,属于不可信输入。理由是一句可读的中文,面板会显示出来。
            const admitted = admitImagePayload(payload?.images);
            if (admitted.ok !== true) throw new Error(admitted.reason);
            if (text.trim() === '' && admitted.images.length === 0) throw new Error('text 不能为空');
            // ⚠️ `shown`(**气泡里显示的那一句**)必须一起转交 —— 会话台账记的是它,不是 `text`
            //    (text 里还裹着"当前笔记 / 标题 / 正文"那一整段上下文)。
            //    漏掉这一步的后果是实测出来的:台账里那条"用户消息"变成了整段笔记正文,
            //    标题也跟着被污染(「接着聊」铺回历史时,用户会看到一大段自己没打过的东西)。
            const shown = typeof payload?.shown === 'string' ? payload.shown : '';
            return runtime.send(text, { images: admitted.images, shown });
        },

        'agent:cancel': () => runtime.cancel(),

    // 换模型之后重新问一次"能不能收图片"(桥那边由 kaiwu 自己的补丁提供问法)。
        'agent:capabilities': () => runtime.refreshCapabilities(),

        // 改一条会话配置(模型 / 思考强度)。
        //
        // 渲染进程只递 **两个字符串**:configId 与 value —— 而且 value 是它从对端给的那份
        // configOptions 里**原样抄回来的不透明串**(不是拼出来的)。命令、cwd、环境变量、
        // provider 一律递不进来;`value` 到底是什么意思,由对端说了算。
        // ⚠️ 正因为它是"原样透传",这里**不能**做任何白名单校验(那等于把对端的模型表
        //    抄进主进程);能校验的只有类型与"非空 configId",以及"这一轮是不是在飞"。
        'agent:setConfig': (_event, payload = {}) => {
            const configId = payload?.configId;
            const value = payload?.value;
            if (typeof configId !== 'string' || configId.trim() === '') {
                throw new Error('configId 必填');
            }
            if (typeof value !== 'string') throw new Error('value 必须是字符串');
            return runtime.setConfig({ configId: configId.trim(), value });
        },

        'agent:permission': (_event, payload = {}) => {
            const requestId = payload?.requestId;
            const optionId = payload?.optionId;
            if (typeof requestId !== 'string' || requestId.trim() === '') {
                throw new Error('requestId 必填');
            }
            if (typeof optionId !== 'string' || optionId.trim() === '') {
                throw new Error('optionId 必填');
            }
            return runtime.answerPermission(requestId, optionId);
        },

        // 按需翻译:渲染进程只递两个叶子字段(哪一条、原文是什么),
        // **递不进** provider / model / 命令 —— 那些由主进程与桥决定。
        'agent:translate': (_event, payload = {}) => {
            const thoughtId = payload?.thoughtId;
            const text = payload?.text;
            if (typeof thoughtId !== 'string' || thoughtId.trim() === '') {
                throw new Error('thoughtId 必填');
            }
            if (typeof text !== 'string' || text.trim() === '') {
                throw new Error('text 必填');
            }
            return runtime.translateThought({ thoughtId, text });
        },
    };

    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, payload) => {
            try {
                return await handler(event, payload);
            } catch (err) {
                // 统一成可读消息 + 机器可读的 state/snapshot
                log.warn?.(`[agent] ${channel} 失败:${err?.message ?? err}`);
                throw rethrow(err);
            }
        });
    }

    const offEvent = runtime.onEvent(emit);

    return {
        emit,
        dispose: () => {
            for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
            offEvent?.();
        },
    };
}