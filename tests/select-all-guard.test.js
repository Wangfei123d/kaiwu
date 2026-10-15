import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    EDITABLE_SELECTOR, isSelectAllChord, isEditableTarget, shouldBlockPageSelectAll,
} from '../app/lib/select-all-guard.js';

// 这一层钉的是「页面级 Ctrl+A 守卫」的判据(见 app/lib/select-all-guard.js 顶部)。
//
// 为什么判据要单独抽成纯函数:它得同时满足两个方向的要求,方向相反,一条写错就会
// 变成另一个 bug ——
//   ① 焦点在**外壳 / 列表**时挡住页面级全选(用户报的"一次性全选了整个页面的文本");
//   ② 焦点在**任何可编辑元素**里时一个字都不许动(搜索框 / 标题框 / AI 输入框 / 正文块)。
// 真窗口那三条(真按键)在 electron/selftest.js 里;这里钉的是判据本身 —— 跑得快,
// 也不用起 Electron。真实 DOM 那侧(块输入框 / 富文本区 / 标题框)由自检覆盖。

/** 造一个最小事件替身:判据只读这几个字段。 */
function chord(key, extra = {}) {
    return { key, ctrlKey: false, metaKey: false, altKey: false, ...extra };
}

/**
 * 造一个最小目标替身:记录 closest 收到的选择器,并按需要报"命中 / 未命中"。
 * 它同时是"判据口径"的探针 —— 外壳必须把**完整**的选择器交给 closest,
 * 而不是只看 tagName。
 */
function target({ editable = false } = {}) {
    const seen = [];
    return {
        seen,
        closest(selector) {
            seen.push(selector);
            return editable ? { tagName: 'DIV' } : null;
        },
    };
}

test('组合键判据:Ctrl+A / Cmd+A 都算,大小写都算', () => {
    assert.equal(isSelectAllChord(chord('a', { ctrlKey: true })), true);
    assert.equal(isSelectAllChord(chord('A', { ctrlKey: true })), true, '按住 Shift 时 key 是 A');
    assert.equal(isSelectAllChord(chord('a', { metaKey: true })), true, 'macOS 的 Cmd+A');
    assert.equal(isSelectAllChord(chord('a', { ctrlKey: true, metaKey: true })), true);
});

test('组合键判据:不带修饰键 / 带 Alt / 别的键 都不算', () => {
    assert.equal(isSelectAllChord(chord('a')), false, '光按 a 是打字,不是全选');
    assert.equal(isSelectAllChord(chord('a', { ctrlKey: true, altKey: true })), false,
        'AltGr = Ctrl+Alt:不排除它,某些键盘布局里打一个字符就会被当成全选');
    assert.equal(isSelectAllChord(chord('a', { ctrlKey: true, shiftKey: true })), true,
        'Shift 不参与判据(需求只要求排除 Alt)');
    assert.equal(isSelectAllChord(chord('c', { ctrlKey: true })), false);
    assert.equal(isSelectAllChord(chord('w', { ctrlKey: true })), false, 'Ctrl+W 归工作台,别抢');
});

test('组合键判据:畸形输入不抛异常,一律当"不是全选键"', () => {
    assert.equal(isSelectAllChord(null), false);
    assert.equal(isSelectAllChord(undefined), false);
    assert.equal(isSelectAllChord({}), false, 'key 缺失');
    assert.equal(isSelectAllChord({ key: 65, ctrlKey: true }), false, 'key 不是字符串');
});

test('可编辑目标:放行(什么都不做,交给原生 / 交给编辑器)', () => {
    const input = target({ editable: true });
    const ev = { ...chord('a', { ctrlKey: true }), target: input };
    assert.equal(isEditableTarget(input), true);
    assert.equal(shouldBlockPageSelectAll(ev, input), false,
        '可编辑元素里绝不能 preventDefault —— 那正是标题框 / 搜索框 Ctrl+A 被劫持的样子');
});

test('非编辑目标:挡住(这就是"一次性全选了整个页面"那一半)', () => {
    const body = target({ editable: false });
    const ev = { ...chord('a', { ctrlKey: true }), target: body };
    assert.equal(isEditableTarget(body), false);
    assert.equal(shouldBlockPageSelectAll(ev, body), true);
});

test('默认目标取自事件本身(调用方不必自己传 target)', () => {
    const body = target({ editable: false });
    const ev = { ...chord('a', { ctrlKey: true }), target: body };
    assert.equal(shouldBlockPageSelectAll(ev), true);
    const input = target({ editable: true });
    assert.equal(shouldBlockPageSelectAll({ ...ev, target: input }), false);
});

test('不是全选组合键时,连目标都不看 —— 绝不吞掉别的按键', () => {
    for (const ev of [chord('a'), chord('c', { ctrlKey: true }), chord('a', { ctrlKey: true, altKey: true })]) {
        const body = target({ editable: false });
        assert.equal(shouldBlockPageSelectAll({ ...ev, target: body }), false);
        assert.deepEqual(body.seen, [], '判据短路的证据:非全选键不该去问目标');
    }
});

test('判据口径:交给 closest 的是完整选择器,而不是"只看 input"', () => {
    const body = target({ editable: false });
    isEditableTarget(body);
    assert.equal(body.seen.length, 1, '应当只问一次 closest');
    const selector = body.seen[0];
    assert.ok(selector.includes('input'), '普通输入框');
    assert.ok(selector.includes('textarea'), '正文块与 AI 对话框都是 textarea');
    assert.ok(selector.includes('[contenteditable="true"]'),
        '⭐ 富文本区没有 INPUT 标签:漏掉它就会把编辑器以外的富文本区一起劫持');
    assert.ok(selector.includes('[contenteditable=""]'),
        'contenteditable 的布尔写法(浏览器序列化成空串)同样是可编辑');
    assert.ok(selector.includes('[contenteditable="plaintext-only"]'),
        'plaintext-only 也是真的可编辑');
    assert.ok(!selector.includes('contenteditable="false"'), 'contenteditable=false 不可编辑,别放行');
});

test('判据口径的常量本身:五段一个都不能少(以后改这里会被钉住)', () => {
    assert.equal(EDITABLE_SELECTOR.split(',').map(s => s.trim()).length, 5);
});

test('目标拿不到 closest / closest 抛异常:退回"不可编辑"(挡,但不崩)', () => {
    assert.equal(isEditableTarget(null), false);
    assert.equal(isEditableTarget(undefined), false);
    assert.equal(isEditableTarget({}), false, '非元素目标(doc / body 之类)没有 closest');
    assert.equal(isEditableTarget({ closest: () => { throw new Error('不支持的选择器'); } }), false,
        '一次按键绝不能被判据变成一次崩溃');
    assert.equal(shouldBlockPageSelectAll(
        { key: 'a', ctrlKey: true, metaKey: false, altKey: false, target: {} }), true);
});
