// 「AI 会话」面板的**主进程接口**:台账 + 对端那份清单合成界面要画的行。
//
// 为什么合成放在主进程、而不是让插件自己拼:
//   "能不能接着聊"要同时看三处 —— 台账(有记录)、这条连接里已经接上的(活跃)、
//   对端 `session/list` 里的(可恢复)。这三处只有主进程都摸得到,插件拿到的应该
//   是**已经判好的行**(判据在 app/lib/agent-sessions.js,纯函数、单测钉着)。
//
// ⚠️ 所有频道都回**结果对象**,不 throw:实测真 Electron 44.4.1 里 `ipcMain.handle`
//    抛出的 Error 到渲染进程只剩 message/stack(`state`/`code` 那些机器可读字段全丢),
//    而"为什么接不上"恰恰是这里最要紧的信息(见 agent-ipc 里那段同样的教训)。
import { decorateRows } from '../../app/lib/agent-sessions.js';

/** 面板订阅的那条广播:台账落了新内容 / 当前会话变了。 */
export const SESSIONS_CHANGED_CHANNEL = 'sessions:changed';

/**
 * @param {object} deps
 * @param {object} deps.ipcMain
 * @param {() => (object|null)} deps.getWindow 发广播用(窗口没了就别发)
 * @param {object} deps.ledger createSessionLedger 的实例
 * @param {object} deps.runtime createAgentRuntime 的实例
 * @param {{info?:Function,warn?:Function,error?:Function}} [deps.log]
 */
export function registerSessionsIpc({ ipcMain, getWindow, ledger, runtime, log = console }) {
    let announced = 0;
    const broadcast = (payload) => {
        announced += 1;
        const win = getWindow();
        if (win === null || win === undefined) return;
        try {
            win.webContents.send(SESSIONS_CHANGED_CHANNEL, payload);
        } catch (err) {
            log.warn?.('[sessions] 广播失败', err);
        }
    };

    /** 台账 + 对端 → 界面要画的行(判据全在 decorateRows 里)。 */
    async function rowsNow() {
        const info = runtime.sessionsInfo();
        // 只在"没问到过"时才去问对端:每次列清单都问一遍是没必要的往返,
        // 而没连接时它当场返回(不会为了画清单去拉进程,见 listPeerSessions)。
        if (info.peer.ask !== true) await runtime.listPeerSessions();
        const after = runtime.sessionsInfo();
        const listed = await ledger.list();
        return {
            listed,
            rows: decorateRows(listed.rows, {
                liveIds: after.live,
                peerIds: after.peer.ids,
                peerOk: after.peer.ask === true,
            }, after.current),
            info: after,
        };
    }

    ipcMain.handle('sessions:list', async () => {
        try {
            const { listed, rows, info } = await rowsNow();
            return {
                ok: listed.ok === true,
                reason: listed.reason ?? '',
                dir: listed.dir ?? null,
                rows,
                current: info.current,
                cwd: info.cwd,
                // 在飞的一轮:面板据此把「新建会话 / 接着聊」按灰(都会换掉上下文)。
                busy: info.busy === true,
                peer: { ask: info.peer.ask === true, reason: info.peer.reason ?? '' },
            };
        } catch (err) {
            return { ok: false, reason: String(err?.message ?? err), rows: [], current: null, peer: { ask: false, reason: '' } };
        }
    });

    ipcMain.handle('sessions:read', async (_event, payload = {}) => {
        try {
            const r = await ledger.read(String(payload?.id ?? ''));
            return { ok: r.ok === true, reason: r.reason ?? '', record: r.record ?? null, running: r.running === true };
        } catch (err) {
            return { ok: false, reason: String(err?.message ?? err), record: null };
        }
    });

    ipcMain.handle('sessions:remove', async (_event, payload = {}) => {
        try {
            const r = await ledger.remove(String(payload?.id ?? ''));
            if (r.ok === true && r.removed === true) broadcast({ kind: 'removed' });
            return { ok: r.ok === true, removed: r.removed === true, reason: r.reason ?? '' };
        } catch (err) {
            return { ok: false, removed: false, reason: String(err?.message ?? err) };
        }
    });

    /**
     * 切到某一条会话(「接着聊」)。
     *
     * ⚠️ 这是**会换掉当前上下文**的动作:失败时把原因原样带回去(认得出的那几类已经
     *    被 agent-runtime 换成了中文 + 原话),界面负责把它说出来 —— 不许变成一句"接不上"。
     */
    ipcMain.handle('sessions:activate', async (_event, payload = {}) => {
        const id = String(payload?.id ?? '').trim();
        if (id === '') return { ok: false, reason: '会话 id 必填' };
        try {
            const r = await runtime.activateSession(id);
            broadcast({ kind: 'activated', id: r.sessionId });
            return { ok: true, sessionId: r.sessionId, reused: r.reused === true, reason: '' };
        } catch (err) {
            return { ok: false, sessionId: null, reused: false, reason: String(err?.message ?? err) };
        }
    });

    /**
     * **新建一条会话**(「＋ 新建会话」)。
     *
     * ⚠️ 这是"立刻建"(用户在两个方案里选的那条):点了就对端真的 `session/new`、
     *    台账当场落一个记录(0 轮)。代价是点几下没聊就会留下几个空记录 ——
     *    所以面板那边每一行都能一步删掉(见 plugins/ai-session)。
     */
    ipcMain.handle('sessions:new', async () => {
        try {
            const r = await runtime.beginNewSession();
            broadcast({ kind: 'created', id: r.sessionId });
            return { ok: true, sessionId: r.sessionId, previous: r.previous ?? null, reason: '' };
        } catch (err) {
            return { ok: false, sessionId: null, previous: null, reason: String(err?.message ?? err) };
        }
    });

    return {
        broadcast,
        /** 只给测试/诊断:广播过多少次。 */
        get announced() { return announced; },
    };
}
