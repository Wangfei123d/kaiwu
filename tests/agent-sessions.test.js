import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SESSION_STATE, decorateRows, resumeFailureOf, sessionStateOf,
} from '../app/lib/agent-sessions.js';

// 这一层判"能不能接着聊"。最容易写错的一条是:**没问到 ≠ 没有**
// (没连接时说"上下文已不在",用户会以为记录废了)。

test('会话状态:我方已经接上的算"正在聊"(就算对端清单里没有它)', () => {
    // 实测:session/list **不列正在活跃的会话** —— 所以活跃那些必须靠我方自己记着。
    assert.equal(sessionStateOf({ id: 'a', liveIds: ['a'], peerIds: [], peerOk: true }), SESSION_STATE.LIVE);
});

test('会话状态:对端清单里有它 → 可接着聊', () => {
    assert.equal(sessionStateOf({ id: 'a', liveIds: [], peerIds: ['a'], peerOk: true }), SESSION_STATE.RESUMABLE);
});

test('会话状态:对端明确没有它 → 上下文已不在', () => {
    assert.equal(sessionStateOf({ id: 'a', liveIds: [], peerIds: ['b'], peerOk: true }), SESSION_STATE.GONE);
});

test('会话状态:**没问到**就是不知道,不许冒充"已不在"', () => {
    assert.equal(sessionStateOf({ id: 'a', liveIds: [], peerIds: [], peerOk: false }), SESSION_STATE.UNKNOWN);
    assert.equal(sessionStateOf({ id: 'a' }), SESSION_STATE.UNKNOWN);
    assert.equal(sessionStateOf({ id: '' }), SESSION_STATE.UNKNOWN);
});

test('会话状态:Set 与数组都收(两条路自己算过一遍)', () => {
    assert.equal(sessionStateOf({ id: 'a', liveIds: new Set(['a']), peerOk: false }), SESSION_STATE.LIVE);
    assert.equal(sessionStateOf({ id: 'a', peerIds: new Set(['a']), peerOk: false }), SESSION_STATE.RESUMABLE);
});

test('清单行:每行带状态与徽标字,并标出"当前正在聊"的那一条', () => {
    const rows = [
        { id: 'a', title: '甲' },
        { id: 'b', title: '乙' },
        { id: 'c', title: '丙' },
    ];
    const out = decorateRows(rows, { liveIds: ['a'], peerIds: ['b'], peerOk: true }, 'a');
    assert.deepEqual(out.map((r) => r.state), ['live', 'resumable', 'gone']);
    assert.deepEqual(out.map((r) => r.stateLabel), ['正在聊', '可接着聊', '上下文已不在']);
    assert.equal(out[0].current, true);
    assert.equal(out[1].current, false);
    assert.equal(out[0].title, '甲', '原有字段不许丢');
});

test('清单行:不知道的那一档**不给徽标**(不显示比显示错的强)', () => {
    const out = decorateRows([{ id: 'a' }], { peerOk: false });
    assert.equal(out[0].state, SESSION_STATE.UNKNOWN);
    assert.equal(out[0].stateLabel, '');
});

test('恢复失败:三类能认出来的错误各自说人话', () => {
    assert.equal(resumeFailureOf('Invalid params: session is already active: 870d').kind, 'live');
    assert.match(resumeFailureOf('session is already active: 870d').reason, /还开着/);
    assert.equal(resumeFailureOf('Invalid params: session is not resumable: 870d').kind, 'gone');
    assert.match(resumeFailureOf('session is not resumable: 870d').reason, /只读回看/);
    assert.equal(resumeFailureOf('Invalid params: session cwd does not match: E:\\v').kind, 'wrong-cwd');
    assert.match(resumeFailureOf('session cwd does not match: E:\\v').reason, /另一个笔记库/);
});

test('恢复失败:认不出来就**原样交给用户**,不许硬翻成一句"失败"', () => {
    const out = resumeFailureOf('Internal error: 连接断了');
    assert.equal(out.kind, null);
    assert.equal(out.reason, null);
    assert.deepEqual(resumeFailureOf(null), { kind: null, reason: null });
    assert.deepEqual(resumeFailureOf(''), { kind: null, reason: null });
});
