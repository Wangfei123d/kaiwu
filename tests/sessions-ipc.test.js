import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSessionsIpc, SESSIONS_CHANGED_CHANNEL } from '../electron/sessions/sessions-ipc.js';
import { createSessionLedger } from '../electron/sessions/session-ledger.js';

// 「AI 会话」的主进程接口。这一层唯一的职责是**合成**:台账(有记录)+ 这条连接
// 接上过的(活跃)+ 对端清单(可恢复)→ 界面要画的行;外加把"接不上"的原因原样带回去。
// 判据本身在 app/lib/agent-sessions.js(那边单独钉),这里钉的是接线对不对。

const AT = 1790403874841;
const SID = '870dbbb2-eb7d-47a4-b4c1-f78cd945548a';
const OTHER = 'aaaaaaaa-0000-0000-0000-000000000001';

function tmpVault() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-sessions-ipc-'));
}

function fakeIpcMain() {
    const handlers = new Map();
    return {
        handlers,
        handle(channel, fn) { handlers.set(channel, fn); },
        async call(channel, payload) {
            const fn = handlers.get(channel);
            assert.ok(fn, `没有注册 ${channel}`);
            return await fn(null, payload);
        },
    };
}

function harness({ peer, activate } = {}) {
    const vault = tmpVault();
    const ledger = createSessionLedger({
        vaultRoot: () => vault, flushDebounceMs: 0,
        log: { info() {}, warn() {}, error() {} },
    });
    const sent = [];
    const info = {
        current: null, live: [], peer: { ask: false, reason: '', ids: [] }, cwd: vault,
    };
    const runtime = {
        info,
        listPeerCalls: 0,
        sessionsInfo: () => info,
        listPeerSessions: async () => {
            runtime.listPeerCalls += 1;
            info.peer = peer ?? { ask: true, reason: '', ids: [] };
            return { ok: true, sessions: [] };
        },
        activateSession: async (id) => {
            if (typeof activate === 'function') return await activate(id);
            info.current = id;
            info.live = [id];
            return { sessionId: id, reused: false, configOptions: [] };
        },
    };
    const ipcMain = fakeIpcMain();
    const bridge = registerSessionsIpc({
        ipcMain, getWindow: () => ({ webContents: { send: (c, p) => sent.push([c, p]) } }),
        ledger, runtime, log: { info() {}, warn() {}, error() {} },
    });
    return { vault, ledger, runtime, ipcMain, sent, bridge };
}

async function seed(ledger, { id = SID, title = '第一条', at = AT } = {}) {
    await ledger.begin({ id, cwd: 'E:\\vault', model: 'M', effort: '中', createdAt: at });
    ledger.user({ id, text: title, at: at + 10 });
    ledger.end({ id, stopReason: 'end_turn', at: at + 20 });
    await ledger.flush(id);
}

test('清单:台账 + 活跃 + 对端清单 → 每行都判好状态', async () => {
    const h = harness({ peer: { ask: true, reason: '', ids: [OTHER] } });
    await seed(h.ledger, { id: SID, title: '甲' });
    await seed(h.ledger, { id: OTHER, title: '乙', at: AT + 100000 });
    h.runtime.info.current = SID;
    h.runtime.info.live = [SID];

    const r = await h.ipcMain.call('sessions:list', {});
    assert.equal(r.ok, true);
    assert.equal(r.dir, path.join(h.vault, 'AI会话'));
    assert.equal(r.current, SID);
    // 新的在前
    assert.deepEqual(r.rows.map((x) => x.title), ['乙', '甲']);
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    assert.equal(byId[SID].state, 'live', '接上过的那条算"正在聊"');
    assert.equal(byId[SID].stateLabel, '正在聊');
    assert.equal(byId[SID].current, true);
    assert.equal(byId[OTHER].state, 'resumable');
    assert.equal(byId[OTHER].stateLabel, '可接着聊');
});

test('清单:对端明确没有它 → 上下文已不在;没问到 → 不给徽标(不许拿"不知道"冒充"没有")', async () => {
    const h = harness({ peer: { ask: true, reason: '', ids: [] } });
    await seed(h.ledger);
    const gone = await h.ipcMain.call('sessions:list', {});
    assert.equal(gone.rows[0].state, 'gone');
    assert.match(gone.rows[0].stateLabel, /已不在/);

    const h2 = harness({ peer: { ask: false, reason: '还没连接', ids: [] } });
    await seed(h2.ledger);
    const unknown = await h2.ipcMain.call('sessions:list', {});
    assert.equal(unknown.rows[0].state, 'unknown');
    assert.equal(unknown.rows[0].stateLabel, '', '不知道就不显示徽标');
    assert.equal(unknown.peer.ask, false);
    assert.equal(unknown.peer.reason, '还没连接');
});

test('清单:只在"没问到过"时才去问对端(每次刷新都问是没必要的往返)', async () => {
    const h = harness({ peer: { ask: true, reason: '', ids: [] } });
    await seed(h.ledger);
    await h.ipcMain.call('sessions:list', {});
    assert.equal(h.runtime.listPeerCalls, 1, '第一次要问');
    await h.ipcMain.call('sessions:list', {});
    assert.equal(h.runtime.listPeerCalls, 1, '问到了就不必再问');
});

test('清单:没有笔记库时如实说原因,而不是给一份空清单装作"没有会话"', async () => {
    const ledger = createSessionLedger({
        vaultRoot: () => null, flushDebounceMs: 0, log: { info() {}, warn() {}, error() {} },
    });
    const ipcMain = fakeIpcMain();
    registerSessionsIpc({
        ipcMain, getWindow: () => null, ledger,
        runtime: { sessionsInfo: () => ({ current: null, live: [], peer: { ask: false, ids: [], reason: '' }, cwd: null }), listPeerSessions: async () => ({}) },
        log: { info() {}, warn() {}, error() {} },
    });
    const r = await ipcMain.call('sessions:list', {});
    assert.equal(r.ok, false);
    assert.match(r.reason, /笔记库/);
});

test('读一份:回的是完整记录(entries 就是回看/铺回对话要的那一份)', async () => {
    const h = harness();
    await seed(h.ledger);
    const r = await h.ipcMain.call('sessions:read', { id: SID });
    assert.equal(r.ok, true);
    assert.equal(r.record.id, SID);
    assert.deepEqual(r.record.entries.map((e) => e.kind), ['user', 'end']);
    const missing = await h.ipcMain.call('sessions:read', { id: 'nope' });
    assert.equal(missing.ok, false);
});

test('删一条:真的删掉并广播(界面据此刷新)', async () => {
    const h = harness();
    await seed(h.ledger);
    const r = await h.ipcMain.call('sessions:remove', { id: SID });
    assert.deepEqual({ ok: r.ok, removed: r.removed }, { ok: true, removed: true });
    assert.equal((await h.ledger.list()).rows.length, 0);
    assert.deepEqual(h.sent.at(-1), [SESSIONS_CHANGED_CHANNEL, { kind: 'removed' }]);
});

test('接着聊:成功 → 回 {ok, sessionId} 并广播;失败 → 把原因**原样**带回(不 throw)', async () => {
    const ok = harness();
    const good = await ok.ipcMain.call('sessions:activate', { id: SID });
    assert.deepEqual({ ok: good.ok, sessionId: good.sessionId }, { ok: true, sessionId: SID });
    assert.deepEqual(ok.sent.at(-1), [SESSIONS_CHANGED_CHANNEL, { kind: 'activated', id: SID }]);

    const bad = harness({
        activate: () => { throw new Error('这条会话是在**另一个笔记库**里聊的(原话:session cwd does not match)'); },
    });
    const r = await bad.ipcMain.call('sessions:activate', { id: SID });
    assert.equal(r.ok, false);
    assert.equal(r.sessionId, null);
    assert.match(r.reason, /另一个笔记库/);
    assert.match(r.reason, /原话/, '原因里要留着对端的原话(排障的唯一线索)');
});

test('接着聊:空 id 直接拒(不许拿空串去问对端)', async () => {
    const h = harness();
    const r = await h.ipcMain.call('sessions:activate', { id: '   ' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /必填/);
});

test('窗口没了时广播不炸(退出过程中面板还在刷新是正常现象)', async () => {
    const h = harness();
    const ipcMain = fakeIpcMain();
    const bridge = registerSessionsIpc({
        ipcMain, getWindow: () => null,
        ledger: h.ledger,
        runtime: { sessionsInfo: () => ({ current: null, live: [], peer: { ask: true, ids: [], reason: '' }, cwd: null }), listPeerSessions: async () => ({}) },
        log: { info() {}, warn() {}, error() {} },
    });
    bridge.broadcast({ kind: 'written' });
    assert.equal(bridge.announced, 1);
});

test('新建会话:成功 → 回 {ok, sessionId};失败 → 把原因原样带回(不 throw)', async () => {
    const ok = harness();
    ok.runtime.beginNewSession = async () => ({ sessionId: 'brand-new', previous: SID });
    const made = await ok.ipcMain.call('sessions:new', {});
    assert.deepEqual({ ok: made.ok, sessionId: made.sessionId, previous: made.previous },
        { ok: true, sessionId: 'brand-new', previous: SID });
    assert.deepEqual(ok.sent.at(-1), [SESSIONS_CHANGED_CHANNEL, { kind: 'created', id: 'brand-new' }]);

    const bad = harness();
    bad.runtime.beginNewSession = async () => { throw new Error('这一轮还没结束 —— 等它跑完(或取消)再新建会话'); };
    const r = await bad.ipcMain.call('sessions:new', {});
    assert.equal(r.ok, false);
    assert.equal(r.sessionId, null);
    assert.match(r.reason, /还没结束/);
});

test('清单带上 busy(面板据此把「新建会话 / 接着聊」按灰)', async () => {
    const h = harness();
    await seed(h.ledger);
    h.runtime.info.busy = true;
    const busy = await h.ipcMain.call('sessions:list', {});
    assert.equal(busy.busy, true);
    h.runtime.info.busy = false;
    assert.equal((await h.ipcMain.call('sessions:list', {})).busy, false);
});
