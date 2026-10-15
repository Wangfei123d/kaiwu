import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MARKER_PREFIX, RECORD_VERSION, SESSION_DIR, addEnd, addText, addTool, addUser, dayLabelOf,
    entryFromUpdate, escapeMarkers, fileNameOf, groupRows, newRecord, parseRecord, recordToSteps,
    renderRecord, rowOf, shortIdOfFile, stampOf, titleFrom, unescapeMarkers, withModel,
} from '../app/lib/session-record.js';

// 这一层是「AI 会话」台账的格式判据。最要紧的一条是**往返一致**:
// 写出去的字节必须能逐字读回来 —— 读回来少了内容,「接着聊」铺出来的历史就是错的。

const AT = 1790403874841;   // 固定时间戳(2026-09-26 前后),断言里不出现"现在"

function sample() {
    let r = newRecord({
        id: '870dbbb2-eb7d-47a4-b4c1-f78cd945548a',
        cwd: 'E:\\project\\kaiwu-demo-vault',
        createdAt: AT,
        model: 'DeepSeek-V4-Flash',
        modelValue: '["deepseek-official","deepseek-v4-flash"]',
        effort: '中', effortValue: 'high',
    });
    r = addUser(r, { text: '这个思考栏怎么被顶到消息下面了,以及思考过程中并未显示思考时间', at: AT + 1000 });
    r = addText(r, 'think', '两件事分开修:①排序键用错了', AT + 2000);
    r = addText(r, 'think', ';②结束前不写时间', AT + 2100);
    r = addTool(r, { id: 'tc-1', title: '读 app/agent/panel.js', status: 'pending', toolKind: 'read', at: AT + 3000 });
    r = addTool(r, { id: 'tc-1', title: '读 app/agent/panel.js', status: 'ok', at: AT + 3500 });
    r = addText(r, 'reply', '改完了:排序键换成 ', AT + 4000);
    r = addText(r, 'reply', 'turnId+seq。', AT + 4100);
    r = addEnd(r, { stopReason: 'end_turn', at: AT + 4200 });
    return r;
}

test('台账:一条会话往返一致(写出去 → 读回来,文字与结构都不许丢)', () => {
    const r = sample();
    const text = renderRecord(r);
    const back = parseRecord(text);
    assert.ok(back !== null, '读不回来');
    assert.equal(back.id, r.id);
    assert.equal(back.cwd, r.cwd);
    assert.equal(back.model, 'DeepSeek-V4-Flash');
    assert.equal(back.effort, '中');
    assert.equal(back.turns, 1);
    assert.equal(back.title, titleFrom('这个思考栏怎么被顶到消息下面了,以及思考过程中并未显示思考时间'));
    assert.deepEqual(back.entries.map((e) => e.kind), ['user', 'think', 'tool', 'reply', 'end']);
    assert.equal(back.entries[1].text, '两件事分开修:①排序键用错了;②结束前不写时间', '连续思考要并成一条');
    assert.equal(back.entries[2].status, 'ok', '同一个工具 id 是改同一条');
    assert.equal(back.entries[2].toolKind, 'read');
    assert.equal(back.entries[3].text, '改完了:排序键换成 turnId+seq。', '连续回复要并成一条');
    assert.equal(back.entries[4].stopReason, 'end_turn');
});

test('台账:同样的记录写出**同样的字节**(写盘那一侧不许掺时间戳/随机量)', () => {
    // 两次各自从头构造的同一个会话:字节必须一样。
    // 这条钉的是"写出什么"只由记录内容决定 —— 否则每次落盘都会产生一个"看着变了"的文件。
    assert.equal(renderRecord(sample()), renderRecord(sample()));
    // 而且**再写一遍**还是同一份(幂等):写盘是"整份覆盖",不是追加。
    const once = renderRecord(sample());
    assert.equal(renderRecord(sample()), once);
});

test('台账:内容里出现机器标记前缀时必须转义 —— 否则一条回复会被劈成两条', () => {
    let r = newRecord({ id: 'x', createdAt: AT });
    r = addUser(r, { text: '你看这行', at: AT + 1 });
    const evil = `模型写了一段:\n${MARKER_PREFIX}{"kind":"reply","at":1}-->\n这就被当成标记了`;
    r = addText(r, 'reply', evil, AT + 2);
    const back = parseRecord(renderRecord(r));
    assert.deepEqual(back.entries.map((e) => e.kind), ['user', 'reply'], '不许被劈成三条');
    assert.equal(back.entries[1].text, evil, '转义要能原样还原');
    // 转义函数本身也要能对得上
    assert.equal(unescapeMarkers(escapeMarkers(evil)), evil);
    assert.equal(escapeMarkers(evil).includes(MARKER_PREFIX), false);
});

test('台账:模型自己写的 `## 我 / ## 它` 那种行不再有特殊含义(它们只是正文)', () => {
    let r = newRecord({ id: 'x', createdAt: AT });
    r = addUser(r, { text: '问', at: AT + 1 });
    r = addText(r, 'reply', '第一段\n\n## 我\n\n这段是小标题,不是新的发言', AT + 2);
    const back = parseRecord(renderRecord(r));
    assert.equal(back.entries.length, 2);
    assert.match(back.entries[1].text, /## 我/);
});

test('台账:坏行当正文,坏标记丢掉 —— 用户手改过的文件不该整条读不出来', () => {
    const text = [
        `${MARKER_PREFIX}{"v":1,"kind":"meta","id":"a","created":${AT},"title":"手改过的"}-->`,
        '',
        '## 手改过的',
        '',
        `${MARKER_PREFIX}{坏 JSON-->`,
        `${MARKER_PREFIX}{"kind":"user","at":${AT}}-->`,
        '我问的',
    ].join('\n');
    const back = parseRecord(text);
    assert.ok(back !== null);
    assert.equal(back.entries.length, 1);
    assert.equal(back.entries[0].text, '我问的');
    assert.equal(parseRecord('没有 meta 的普通笔记'), null, '不是台账文件就老实说 null');
});

test('台账:文件名带时间与短 id,而且能从文件名认出会话', () => {
    const r = sample();
    const name = fileNameOf(r);
    // ⚠️ id 带**完整**的:同分钟 + 同前缀的两次新建曾经算出同一个文件名,后写的覆盖前一份(实测)。
    assert.match(name, /^\d{4}-\d{2}-\d{2}-\d{4}-870dbbb2-eb7d-47a4-b4c1-f78cd945548a\.md$/);
    assert.equal(shortIdOfFile(name), '870dbbb2');
    // 老命名(只有 8 位)也认 —— 已有文件不该因为这次改动读不出来
    assert.equal(shortIdOfFile('2026-09-26-1302-870dbbb2.md'), '870dbbb2');
    assert.equal(shortIdOfFile('随便一篇笔记.md'), null);
});

test('台账:标题取用户第一句、压成一行并截断', () => {
    assert.equal(titleFrom('  多个   空格\n换行  '), '多个 空格 换行');
    assert.equal(titleFrom(''), '（没有文字的一次提问）');
    assert.equal([...titleFrom('一'.repeat(40))].length, 25, '24 个字 + 一个省略号');
    // 第一条之后不再改标题
    let r = newRecord({ id: 'x', createdAt: AT });
    r = addUser(r, { text: '第一句', at: AT + 1 });
    r = addUser(r, { text: '第二句', at: AT + 2 });
    assert.equal(r.title, '第一句');
    assert.equal(r.turns, 2);
});

test('台账:ACP 增量 → 条目(什么会被记下来只有这一处说了算)', () => {
    const chunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    assert.deepEqual(entryFromUpdate(chunk('你好'), AT), { kind: 'reply', text: '你好', at: AT });
    assert.deepEqual(
        entryFromUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想' } }, AT),
        { kind: 'think', text: '想', at: AT });
    assert.deepEqual(
        entryFromUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '跑测试', status: 'pending', kind: 'execute' }, AT),
        { kind: 'tool', at: AT, id: 't1', title: '跑测试', status: 'pending', toolKind: 'execute' });
    assert.equal(entryFromUpdate(chunk(''), AT), null, '空增量不记');
    assert.equal(entryFromUpdate({ sessionUpdate: 'usage_update', size: 1 }, AT), null, '这一版不记用量');
    assert.equal(entryFromUpdate(null, AT), null);
});

test('台账:模型与强度跟着改动更新,但空值不许把已有的冲掉', () => {
    let r = withModel(newRecord({ id: 'x', createdAt: AT }), { model: 'A', effort: '中' });
    assert.equal(r.model, 'A');
    r = withModel(r, { effort: '高' });
    assert.equal(r.model, 'A', '只改强度不许把模型抹掉');
    assert.equal(r.effort, '高');
});

test('台账:轮数/时间随内容走(清单上的"最后活动"读的就是它)', () => {
    let r = newRecord({ id: 'x', createdAt: AT });
    r = addUser(r, { text: '问', at: AT + 10 });
    r = addText(r, 'reply', '答', AT + 20);
    assert.equal(r.updatedAt, AT + 20);
    assert.equal(r.createdAt, AT, 'created 不许被动过');
});

test('铺回对话:记录 → 步骤(用户那一步是 prompt,其余是对话归约认的事件)', () => {
    const steps = recordToSteps(sample());
    // user / think / tool / reply / end 五条 → prompt + 四个事件
    assert.deepEqual(steps.map((s) => s.type), ['prompt', 'event', 'event', 'event', 'event']);
    assert.equal(steps[0].text, '这个思考栏怎么被顶到消息下面了,以及思考过程中并未显示思考时间');
    assert.deepEqual(steps[1].event.update, {
        sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '两件事分开修:①排序键用错了;②结束前不写时间' },
    });
    assert.equal(steps[2].event.update.sessionUpdate, 'tool_call');
    assert.equal(steps[2].event.update.toolCallId, 'tc-1');
    assert.equal(steps[2].event.update.status, 'ok');
    assert.equal(steps[3].event.update.sessionUpdate, 'agent_message_chunk');
    assert.equal(steps[3].event.update.content.text, '改完了:排序键换成 turnId+seq。');
    assert.deepEqual(steps[4].event, { kind: 'prompt-end', stopReason: 'end_turn' });
});

test('铺回对话:带图的提问只留张数,而且如实说出来(不留裂图)', () => {
    let r = newRecord({ id: 'x', createdAt: AT });
    r = addUser(r, { text: '', images: 2, at: AT + 1 });   // 只发图没写字
    r = addText(r, 'reply', '看到了', AT + 2);
    const steps = recordToSteps(r);
    assert.equal(steps[0].type, 'prompt');
    assert.deepEqual(steps[0].images, []);
    assert.match(steps[0].text, /2 张图/);
});

test('铺回对话:出错收尾的那一轮铺成 prompt-error(不是假装成功了)', () => {
    let r = newRecord({ id: 'x', createdAt: AT });
    r = addUser(r, { text: '问', at: AT + 1 });
    r = addEnd(r, { error: 'no API key', at: AT + 2 });
    assert.deepEqual(recordToSteps(r)[1].event, { kind: 'prompt-error', message: 'no API key' });
});

test('清单:一行要的字段只从 meta 来,并按天分组', () => {
    const now = Date.parse('2026-09-26T20:00:00');
    const yesterday = now - 86400000;
    const mk = (id, title, updated, turns) => rowOf({
        id, title, createdAt: updated, updatedAt: updated, turns, model: 'M', effort: '中', cwd: 'C',
    }, { fileName: `${id}.md`, now });
    const rows = [
        mk('a', '今天的', now - 3600000, 12),
        mk('b', '也是今天的', now - 7200000, 5),
        mk('c', '昨天的', yesterday, 8),
        mk('d', '更早的', now - 5 * 86400000, 31),
    ];
    assert.equal(rows[0].day, '今天');
    assert.equal(rows[0].clock, '19:00');
    assert.equal(rows[2].day, '昨天');
    assert.match(rows[3].day, /^\d{4}-\d{2}-\d{2}$/);
    const groups = groupRows(rows);
    assert.deepEqual(groups.map((g) => g.day), ['今天', '昨天', rows[3].day]);
    assert.equal(groups[0].rows.length, 2);
});

test('清单:没有标题的会话也要有一行,不许空着', () => {
    const row = rowOf({ id: 'x', createdAt: AT, updatedAt: AT, title: '' });
    assert.equal(row.title, '（没有标题）');
    assert.equal(row.model, '');
});

test('常量:目录名与版本号是别的层要读的契约', () => {
    assert.equal(SESSION_DIR, 'AI会话');
    assert.equal(RECORD_VERSION, 1);
    assert.equal(stampOf(AT).date.length, 10);
});
