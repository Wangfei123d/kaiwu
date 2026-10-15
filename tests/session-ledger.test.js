import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionLedger } from '../electron/sessions/session-ledger.js';
import { SESSION_DIR, parseRecord } from '../app/lib/session-record.js';

// 台账落盘这一层的判据。用**真 fs + 临时目录**(不造 fs 替身):
// 这里要验的正是"文件真的写对了、再读回来还是那一份",替身验不了这件事。

const AT = 1790403874841;

function tmpVault() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-ledger-'));
}

function makeLedger(vault, opts = {}) {
    return createSessionLedger({
        vaultRoot: () => vault,
        flushDebounceMs: opts.flushDebounceMs ?? 0,   // 默认关掉防抖:测试自己调 flush()
        log: { info() {}, warn() {}, error() {} },
        ...opts,
    });
}

const SID = '870dbbb2-eb7d-47a4-b4c1-f78cd945548a';

test('台账:一轮走完 → 文件写对,清单能列出来', async () => {
    const vault = tmpVault();
    const ledger = makeLedger(vault);
    await ledger.begin({
        id: SID, cwd: vault, model: 'DeepSeek-V4-Flash', modelValue: '["p","m"]',
        effort: '中', effortValue: 'high', createdAt: AT,
    });
    ledger.user({ id: SID, text: '这个思考栏怎么被顶到消息下面了', at: AT + 1000 });
    ledger.update({
        id: SID, at: AT + 2000,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看排序键' } },
    });
    ledger.update({
        id: SID, at: AT + 3000,
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: '读 panel.js', status: 'pending', kind: 'read' },
    });
    ledger.update({
        id: SID, at: AT + 3500,
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: '读 panel.js', status: 'ok', kind: 'read' },
    });
    ledger.update({
        id: SID, at: AT + 4000,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '改完了' } },
    });
    ledger.end({ id: SID, stopReason: 'end_turn', at: AT + 5000 });
    const [file] = await ledger.flush();

    assert.ok(fs.existsSync(file), '文件必须真的落盘');
    // 文件名带**完整**会话 id —— 理由见 session-record.js 的 fileNameOf:
    // 同一分钟 + id 前 8 位相同会算出同一个文件名,后写的把前一份静默覆盖(实测踩到)。
    assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}-\d{4}-870dbbb2-eb7d-47a4-b4c1-f78cd945548a\.md$/);
    const back = parseRecord(fs.readFileSync(file, 'utf8'));
    assert.equal(back.id, SID);
    assert.equal(back.turns, 1);
    assert.equal(back.model, 'DeepSeek-V4-Flash');
    assert.deepEqual(back.entries.map((e) => e.kind), ['user', 'think', 'tool', 'reply', 'end']);
    assert.equal(back.entries[2].status, 'ok', '同一个工具 id 是改同一条');

    const listed = await ledger.list();
    assert.equal(listed.ok, true);
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].id, SID);
    assert.equal(listed.rows[0].title, '这个思考栏怎么被顶到消息下面了');
    assert.equal(listed.rows[0].turns, 1);
});

test('台账:「接着聊」恢复同一条会话时**接着写**,不是另起一份', async () => {
    const vault = tmpVault();
    // 第一次:聊一句就"退出"(换个 ledger 实例 = 模拟重启)
    const first = makeLedger(vault);
    await first.begin({ id: SID, cwd: vault, model: 'M', createdAt: AT });
    first.user({ id: SID, text: '第一句', at: AT + 10 });
    first.end({ id: SID, stopReason: 'end_turn', at: AT + 20 });
    const [fileA] = await first.flush();

    const second = makeLedger(vault);
    await second.begin({ id: SID, cwd: vault, createdAt: AT });
    second.user({ id: SID, text: '接着聊的第二句', at: AT + 100 });
    second.end({ id: SID, stopReason: 'end_turn', at: AT + 200 });
    const [fileB] = await second.flush();

    assert.equal(fileB, fileA, '同一个会话必须还是同一个文件');
    const files = fs.readdirSync(path.join(vault, SESSION_DIR)).filter((n) => n.endsWith('.md'));
    assert.equal(files.length, 1, '不许出现第二份');
    const back = parseRecord(fs.readFileSync(fileA, 'utf8'));
    assert.equal(back.turns, 2, '两轮都要在');
    assert.deepEqual(back.entries.filter((e) => e.kind === 'user').map((e) => e.text),
        ['第一句', '接着聊的第二句']);
    assert.equal(back.title, '第一句', '标题不许被第二句顶掉');
});

test('台账:清单只认自己写的文件(用户往这个目录里放东西不许把清单搞乱)', async () => {
    const vault = tmpVault();
    const ledger = makeLedger(vault);
    await ledger.begin({ id: SID, cwd: vault, createdAt: AT });
    ledger.user({ id: SID, text: '一句', at: AT + 1 });
    await ledger.flush();

    const dir = path.join(vault, SESSION_DIR);
    fs.writeFileSync(path.join(dir, '我自己写的笔记.md'), '# 这是我的笔记\n不是台账\n');
    fs.writeFileSync(path.join(dir, '坏文件.md'), '<!--kaiwu:{坏 JSON-->\n');
    fs.writeFileSync(path.join(dir, '不是 md.txt'), 'x');

    const listed = await ledger.list();
    assert.equal(listed.rows.length, 1, '只有台账那一条');
    assert.equal(listed.rows[0].id, SID);
});

test('台账:新的在前(清单第一行就是最近聊的那条)', async () => {
    const vault = tmpVault();
    const ledger = makeLedger(vault);
    await ledger.begin({ id: 'aaaaaaaa-0000-0000-0000-000000000001', cwd: vault, createdAt: AT });
    ledger.user({ id: 'aaaaaaaa-0000-0000-0000-000000000001', text: '早的', at: AT + 10 });
    await ledger.flush();
    await ledger.begin({ id: 'bbbbbbbb-0000-0000-0000-000000000002', cwd: vault, createdAt: AT + 100000 });
    ledger.user({ id: 'bbbbbbbb-0000-0000-0000-000000000002', text: '晚的', at: AT + 100010 });
    await ledger.flush();

    const listed = await ledger.list();
    assert.deepEqual(listed.rows.map((r) => r.title), ['晚的', '早的']);
});

test('台账:还没有笔记库时什么都不写,而且如实说原因(不往默认目录里倒)', async () => {
    const ledger = makeLedger(null);
    const listed = await ledger.list();
    assert.equal(listed.ok, false);
    assert.match(listed.reason, /笔记库/);
    assert.equal(await ledger.begin({ id: SID, createdAt: AT }), null, '没有库就没有会话可记');
    assert.equal(ledger.user({ id: SID, text: 'x' }), null);
});

test('台账:读一份完整记录(清单之外的用途)', async () => {
    const vault = tmpVault();
    const ledger = makeLedger(vault);
    await ledger.begin({ id: SID, cwd: vault, model: 'M', effort: '中', createdAt: AT });
    ledger.user({ id: SID, text: '问', at: AT + 1 });
    ledger.update({ id: SID, at: AT + 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答' } } });
    await ledger.flush();

    const read = await ledger.read(SID);
    assert.equal(read.ok, true);
    assert.equal(read.record.entries.length, 2);
    assert.equal(read.record.entries[1].text, '答');

    const missing = await ledger.read('00000000-0000-0000-0000-000000000000');
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /没有记录/);
});

test('台账:删掉一条(用户明确要删才走这条)', async () => {
    const vault = tmpVault();
    const ledger = makeLedger(vault);
    await ledger.begin({ id: SID, cwd: vault, createdAt: AT });
    ledger.user({ id: SID, text: '一句', at: AT + 1 });
    await ledger.flush();
    const first = await ledger.remove(SID);
    assert.deepEqual(first, { ok: true, removed: true });
    assert.equal((await ledger.list()).rows.length, 0);
    assert.deepEqual(await ledger.remove(SID), { ok: true, removed: false }, '删第二次不该报错');
});

test('台账:防抖落盘(一轮里几百条增量不该写几百次),而且 close() 兜住最后一份', async () => {
    const vault = tmpVault();
    const writes = [];
    const ledger = makeLedger(vault, { flushDebounceMs: 30, onWrite: (info) => writes.push(info.id) });
    await ledger.begin({ id: SID, cwd: vault, createdAt: AT });
    ledger.user({ id: SID, text: '一句', at: AT + 1 });
    for (let i = 0; i < 50; i += 1) {
        ledger.update({ id: SID, at: AT + 10 + i, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `第${i}段` } } });
    }
    await new Promise((res) => { setTimeout(res, 120); });
    assert.ok(writes.length <= 3, `防抖之后写盘次数应很少,实际 ${writes.length}`);
    assert.ok(fs.readdirSync(path.join(vault, SESSION_DIR)).some((n) => n.endsWith('.md')));

    // close() 之后不许再有定时器吊着
    ledger.user({ id: SID, text: '最后一句', at: AT + 999 });
    await ledger.close();
    const back = parseRecord(fs.readFileSync(path.join(vault, SESSION_DIR, fs.readdirSync(path.join(vault, SESSION_DIR))[0]), 'utf8'));
    assert.equal(back.entries.filter((e) => e.kind === 'user').length, 2, 'close() 要把最后一份写下去');
});

test('台账:模型与强度跟着换(清单上显示的就是最后一次用的那个)', async () => {
    const vault = tmpVault();
    const ledger = makeLedger(vault);
    await ledger.begin({ id: SID, cwd: vault, model: 'A', effort: '中', createdAt: AT });
    ledger.user({ id: SID, text: '问', at: AT + 1 });
    ledger.model({ id: SID, effort: '高', effortValue: 'max' });
    ledger.end({ id: SID, stopReason: 'end_turn', at: AT + 2 });
    await ledger.flush();
    const row = (await ledger.list()).rows[0];
    assert.equal(row.model, 'A', '只改强度不许把模型抹掉');
    assert.equal(row.effort, '高');
});

test('台账:出错的一轮也记下来(清单上要能看见"最后一条错")', async () => {
    const vault = tmpVault();
    const ledger = makeLedger(vault);
    await ledger.begin({ id: SID, cwd: vault, createdAt: AT });
    ledger.user({ id: SID, text: '问', at: AT + 1 });
    ledger.end({ id: SID, stopReason: '', error: 'no API key', at: AT + 2 });
    await ledger.flush();
    const read = await ledger.read(SID);
    assert.equal(read.record.entries.at(-1).error, 'no API key');
});

test('台账:「一点就建」的会话**当场**就有文件(不等防抖)', async () => {
    const vault = tmpVault();
    const ledger = makeLedger(vault, { flushDebounceMs: 5000 });   // 防抖故意设得很长
    await ledger.begin({ id: SID, cwd: vault, model: 'M', createdAt: AT });
    // 一句话都没说 —— 但"这条会话已经建好"这件事必须当场在磁盘上看得见
    await new Promise((res) => { setTimeout(res, 60); });
    const files = fs.readdirSync(path.join(vault, SESSION_DIR)).filter((n) => n.endsWith('.md'));
    assert.equal(files.length, 1, 'begin() 之后就该有文件,而不是等 1.5 秒的防抖');
    const back = parseRecord(fs.readFileSync(path.join(vault, SESSION_DIR, files[0]), 'utf8'));
    assert.equal(back.turns, 0);
    assert.equal(back.entries.length, 0);
    await ledger.close();
});
