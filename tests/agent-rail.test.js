import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    RAIL_LEGEND, RAIL_QUESTION_MAX, RAIL_STATUSES, RAIL_STATUS_LABEL, currentTurnIndex, groupTurns,
    liveTurnIndex, summarizeTurn, tickAriaLabel, truncate, turnStatus, wheelScrollDelta,
} from '../app/lib/agent-rail.js';

// 会话轮次导航轨(方案 D)的**纯逻辑**。
//
// ⚠️ 这里最要紧的两条,都不是"能不能跑",而是"有没有说谎":
//   ① 一轮的状态**只能**从现有数据推出来(工具卡状态 / 状态行的红行 / 最后一轮那句全局 error),
//      认不出来的一律算"正常" —— 不许为了好看发明第四种颜色;
//   ② 当前轮序号是"滚动联动"的全部依据,边界(0 轮 / 滚到顶 / 滚到底)错一个,
//      整条轨的高亮就会跑到别的轮次上。

// ---- 夹具:渲染单元的形状与 panel.js 的 planTimeline 一致 ----
const user = (text, id = 'u') => ({ kind: 'message', message: { id, role: 'user', text, done: true } });
const reply = (text, id = 'a', extra = {}) => ({ kind: 'message', message: { id, role: 'assistant', text, done: true, ...extra } });
const tool = (status, id = 't1') => ({ kind: 'tool', tool: { toolCallId: id, status, title: '读文件' } });
const think = (id = 'k1') => ({ kind: 'thought', thought: { id, text: '想想', done: true } });

test('轮次:一条用户消息开一轮,直到下一条用户消息之前(工具/思考都算那一轮的)', () => {
    const { pre, turns } = groupTurns([
        think('k0'),
        user('第一问', 'u1'), reply('答一', 'a1'), tool('completed', 't1'),
        user('第二问', 'u2'), reply('答二', 'a2'),
        user('第三问', 'u3'),
    ]);
    assert.equal(turns.length, 3);
    assert.deepEqual(turns.map(t => t.length), [3, 2, 1]);
    assert.deepEqual(turns[0].map(u => u.kind), ['message', 'message', 'tool']);
    // 第一条用户消息**之前**的东西不算任何一轮(它没有可跳转的提问)
    assert.equal(pre.length, 1);
    assert.equal(pre[0].kind, 'thought');
});

test('轮次:空输入 / 只有助手输出 → 0 轮(一条轨都不该有)', () => {
    assert.deepEqual(groupTurns(null), { pre: [], turns: [] });
    assert.deepEqual(groupTurns([]), { pre: [], turns: [] });
    const onlyReply = groupTurns([reply('没人问过')]);
    assert.equal(onlyReply.turns.length, 0);
    assert.equal(onlyReply.pre.length, 1);
});

test('状态:有工具调用 → 蓝(tool);其余 → 正常(ok)', () => {
    assert.equal(turnStatus([user('q'), reply('a')]), 'ok');
    assert.equal(turnStatus([user('q'), tool('completed'), reply('a')]), 'tool');
    assert.equal(turnStatus([]), 'ok');
    // 判不出来的(比如工具状态字段缺失)→ 正常,**不发明第四种颜色**
    assert.equal(turnStatus([user('q'), { kind: 'tool', tool: {} }]), 'tool');
    assert.equal(turnStatus([{ kind: '不认识的东西' }]), 'ok');
});

test('状态:工具在界面上是**折成一组**画的 —— 那一组同样算"含工具调用"', () => {
    // ⚠️ 真机上 planTimeline 会把工具折成 {kind:'group', tools:[…]}:只认 kind==='tool'
    // 就会漏掉绝大多数情况(格子上会是灰的)。这条就是那个漏判的回归。
    const group = (statuses) => ({ kind: 'group', tools: statuses.map((s, i) => ({ toolCallId: `t${i}`, status: s })), messages: [], live: false });
    assert.equal(turnStatus([user('q'), group(['completed']) ]), 'tool');
    assert.equal(turnStatus([user('q'), group(['pending', 'completed'])]), 'tool');
    assert.equal(turnStatus([user('q'), group(['failed'])]), 'failed');
    assert.equal(turnStatus([user('q'), group(['completed', 'error'])]), 'failed');
    assert.equal(turnStatus([user('q'), group([])]), 'ok', '空组不算工具调用');
});

test('状态:工具失败 → 红(failed);运行中的工具**不算**失败', () => {
    assert.equal(turnStatus([user('q'), tool('failed'), reply('a')]), 'failed');
    assert.equal(turnStatus([user('q'), tool('error')]), 'failed');
    assert.equal(turnStatus([user('q'), tool('running')]), 'tool');
    assert.equal(turnStatus([user('q'), tool('completed')]), 'tool');
});

test('状态:状态行里有红的那一行(视频理解)→ 红', () => {
    const failedStages = reply('', 'a1', {
        stages: [{ key: 'prepare', state: 'done' }, { key: 'upload', state: 'failed' }],
    });
    assert.equal(turnStatus([user('q'), failedStages]), 'failed');
    // 全绿的状态行不染色
    const okStages = reply('答案', 'a2', { stages: [{ key: 'prepare', state: 'done' }] });
    assert.equal(turnStatus([user('q'), okStages]), 'ok');
});

test('状态:面板那句全局 error **只对最后一轮**生效(它不带轮次信息,染红历史轮就是编)', () => {
    const first = [user('q1'), reply('a1')];
    const last = [user('q2'), reply('a2')];
    const error = { message: '鉴权失败', missingCredential: false };
    assert.equal(turnStatus(first, { isLast: false, error }), 'ok');
    assert.equal(turnStatus(first, { isLast: true, error }), 'failed');
    assert.equal(turnStatus(last, { isLast: true, error }), 'failed');
    // 用户自己按的取消不是故障 —— 不该把那一轮染红
    assert.equal(turnStatus(last, { isLast: true, error: { message: '这次理解已被取消', cancelled: true } }), 'ok');
    // 空 error / 不是对象 / 空 message 一律不算
    assert.equal(turnStatus(last, { isLast: true, error: null }), 'ok');
    assert.equal(turnStatus(last, { isLast: true, error: '炸了' }), 'ok');
    assert.equal(turnStatus(last, { isLast: true, error: { message: '   ' } }), 'ok');
});

test('生成中:只有最后一轮可能是 live;不忙时没有 live', () => {
    assert.equal(liveTurnIndex(3, { busy: true }), 2);
    assert.equal(liveTurnIndex(1, { busy: true }), 0);
    assert.equal(liveTurnIndex(3, { busy: false }), -1);
    assert.equal(liveTurnIndex(0, { busy: true }), -1);
    assert.equal(liveTurnIndex(Number.NaN, { busy: true }), -1);
});

test('当前轮:滚动到顶 → 第一轮;到底 → 最后一轮;轮数为 0 → -1', () => {
    const offsets = [0, 200, 460, 700];
    assert.equal(currentTurnIndex([], 0), -1);
    assert.equal(currentTurnIndex([], 500), -1);
    assert.equal(currentTurnIndex([0], 0), 0);
    assert.equal(currentTurnIndex([0], 9999), 0);
    assert.equal(currentTurnIndex(offsets, 0), 0);
    assert.equal(currentTurnIndex(offsets, 187), 0, '差一点点到下一轮:还算上一轮(容差 12)');
    assert.equal(currentTurnIndex(offsets, 188), 1, '刚到 offset-12 就算下一轮');
    assert.equal(currentTurnIndex(offsets, 190), 1);
    assert.equal(currentTurnIndex(offsets, 201), 1);
    assert.equal(currentTurnIndex(offsets, 459), 2);
    assert.equal(currentTurnIndex(offsets, 10 ** 6), 3, '滚到底就是最后一轮');
    // 容差可注入;非法容差退回 12
    assert.equal(currentTurnIndex(offsets, 190, { pad: 0 }), 0);
    assert.equal(currentTurnIndex(offsets, 199, { pad: 0 }), 0);
    assert.equal(currentTurnIndex(offsets, 200, { pad: 0 }), 1);
    assert.equal(currentTurnIndex(offsets, 195, { pad: Number.NaN }), 1, '非法容差退回 12(195 ≥ 188)');
    // 脏输入不许把整条轨弄哑:非数值的 offset 跳过,scrollTop 不是数就当 0
    assert.equal(currentTurnIndex([0, Number.NaN, 400], 500), 2);
    assert.equal(currentTurnIndex(offsets, Number.NaN), 0);
    assert.equal(currentTurnIndex(offsets, -50), 0);
});

test('当前轮:滚到底要认**最后一轮**(最后一轮的 offset 常在可滚范围之外)', () => {
    // 真机实测:内容 383 / 视口 210 → 最多只能滚到 173,而最后一轮的 offsetTop 是 190。
    // 只按 "scrollTop >= offset - pad" 比,最后一格永远不会高亮 —— 那是错的。
    const offsets = [10, 190];
    assert.equal(currentTurnIndex(offsets, 173, { pad: 12 }), 0, '不告诉它"到底了"时就是这个(错的)结果');
    assert.equal(currentTurnIndex(offsets, 173, { pad: 12, atBottom: true }), 1, '到底了就认最后一轮');
    // atBottom 的优先级最高(它在判据之前)
    assert.equal(currentTurnIndex(offsets, 0, { atBottom: true }), 1);
    // 没有轮次时仍然是 -1(到底也没有格)
    assert.equal(currentTurnIndex([], 999, { atBottom: true }), -1);
    assert.equal(currentTurnIndex(offsets, 173, { atBottom: false }), 0);
});

test('轨上滚轮:只接纵向;横向与 0 不接;deltaMode 换算 + 夹紧', () => {
    assert.deepEqual(wheelScrollDelta({ deltaY: 120 }), { handled: true, delta: 120 });
    assert.deepEqual(wheelScrollDelta({ deltaY: -120 }), { handled: true, delta: -120 });
    // 横向滚轮(只有 deltaX)不该被我们接管
    assert.deepEqual(wheelScrollDelta({ deltaX: 120 }), { handled: false, delta: 0 });
    assert.deepEqual(wheelScrollDelta({ deltaY: 0 }), { handled: false, delta: 0 });
    assert.deepEqual(wheelScrollDelta({}), { handled: false, delta: 0 });
    assert.deepEqual(wheelScrollDelta(null), { handled: false, delta: 0 });
    // deltaMode:1 = 行,2 = 页
    assert.deepEqual(wheelScrollDelta({ deltaY: 3, deltaMode: 1 }), { handled: true, delta: 48 });
    assert.deepEqual(wheelScrollDelta({ deltaY: 1, deltaMode: 2 }), { handled: true, delta: 100 });
    // 某些鼠标驱动一次给几千:夹到 ±600,别让内容一下跳过头
    assert.equal(wheelScrollDelta({ deltaY: 5000 }).delta, 600);
    assert.equal(wheelScrollDelta({ deltaY: -5000 }).delta, -600);
});

test('摘要文本:问题超长截断(默认 42 字,与 demo 一致)', () => {
    assert.equal(RAIL_QUESTION_MAX, 42);
    const long = '问'.repeat(60);
    const cut = truncate(long);
    assert.equal(cut.length, 43, '42 个字 + 一个省略号');
    assert.ok(cut.endsWith('…'));
    assert.equal(truncate('短问题'), '短问题');
    assert.equal(truncate('  带空白  '), '带空白');
    assert.equal(truncate(''), '');
    assert.equal(truncate(null), '');
    assert.equal(truncate('abcdef', 3), 'abc…');
    assert.equal(truncate('abcdef', 0), 'abcdef', '非法上限退回默认');
});

test('摘要:标题把状态写成中文(图例就藏在这句话里);有真耗时才带上', () => {
    const s = summarizeTurn({ index: 3, question: '为什么进度条不动?', status: 'tool' });
    assert.equal(s.title, '第 4 轮 · 含工具调用');
    assert.equal(s.question, '为什么进度条不动?');
    assert.equal('timings' in s, false, '没有耗时就不许出现空的一行');

    const withTimings = summarizeTurn({
        index: 0, question: '描述这段视频', status: 'ok',
        timings: { uploadMs: 24100, ttftMs: 34100, generateMs: 10900, totalMs: 69300 },
    });
    assert.equal(withTimings.title, '第 1 轮 · 正常');
    assert.equal(withTimings.timings, '上传 24.1s · 首字 34.1s · 生成 10.9s · 总计 69.3s');
    // 只有一部分读数时,把没有的那几个略掉(不写 0.0s 那种假读数)
    const partial = summarizeTurn({ index: 1, question: 'q', status: 'ok', timings: { totalMs: 5000 } });
    assert.equal(partial.timings, '总计 5.0s');
    // 认不出的状态按"正常"显示(与 turnStatus 的兜底同一条)
    assert.equal(summarizeTurn({ index: 0, question: 'q', status: '???' }).title, '第 1 轮 · 正常');
    assert.equal(summarizeTurn({}).title, '第 1 轮 · 正常');
});

test('aria-label:每格都是「第 N 轮,状态」,而且状态是中文', () => {
    assert.equal(tickAriaLabel(0, 'ok'), '第 1 轮,正常');
    assert.equal(tickAriaLabel(3, 'tool'), '第 4 轮,含工具调用');
    assert.equal(tickAriaLabel(1, 'failed'), '第 2 轮,失败');
    assert.equal(tickAriaLabel(0, '???'), '第 1 轮,正常');
    assert.equal(tickAriaLabel(-5, 'ok'), '第 1 轮,正常');
    assert.equal(/^[\x00-\x7F]*$/.test(tickAriaLabel(0, 'weird')), false, '兜底不许是 ASCII 英文');
});

test('图例:四种颜色都在句子与映射里写清楚(用色不解释等于没编码)', () => {
    assert.deepEqual([...RAIL_STATUSES], ['ok', 'tool', 'failed']);
    assert.deepEqual(RAIL_STATUS_LABEL, { ok: '正常', tool: '含工具调用', failed: '失败' });
    assert.match(RAIL_LEGEND, /一格一轮/);
    assert.match(RAIL_LEGEND, /点一下跳到那一轮/);
    assert.match(RAIL_LEGEND, /灰=正常/);
    assert.match(RAIL_LEGEND, /蓝=含工具调用/);
    assert.match(RAIL_LEGEND, /红=失败/);
    assert.match(RAIL_LEGEND, /绿=当前轮/);
});
