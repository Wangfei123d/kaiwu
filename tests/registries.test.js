import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, createRegistries } from '../app/runtime/registries.js';

test('define 后可 get', () => {
    const reg = createRegistry('tools');
    assert.equal(reg.define({ id: 'a', pluginId: 'p', order: 10 }), true);
    assert.equal(reg.get('a').id, 'a');
});

test('重复 id 被拒绝且不覆盖原项', () => {
    const reg = createRegistry('tools');
    reg.define({ id: 'a', pluginId: 'p1', order: 10, title: '第一个' });
    assert.equal(reg.define({ id: 'a', pluginId: 'p2', order: 20, title: '第二个' }), false);
    assert.equal(reg.get('a').title, '第一个');
});

test('list 按 order 升序,order 相同按 id 字典序', () => {
    const reg = createRegistry('tools');
    reg.define({ id: 'c', pluginId: 'p', order: 10 });
    reg.define({ id: 'a', pluginId: 'p', order: 20 });
    reg.define({ id: 'b', pluginId: 'p', order: 10 });
    assert.deepEqual(reg.list().map(t => t.id), ['b', 'c', 'a']);
});

test('removeByPlugin 只移除该插件的项', () => {
    const reg = createRegistry('tools');
    reg.define({ id: 'a', pluginId: 'p1' });
    reg.define({ id: 'b', pluginId: 'p2' });
    reg.removeByPlugin('p1');
    assert.deepEqual(reg.list().map(t => t.id), ['b']);
});

test('removeByPlugin 对不存在的插件是空操作,不触发通知', () => {
    const reg = createRegistry('tools');
    reg.define({ id: 'a', pluginId: 'p1' });
    let n = 0;
    reg.onChange(() => n++);
    reg.removeByPlugin('不存在的插件');
    assert.equal(n, 0, '没有变化就不该通知订阅者');
    assert.deepEqual(reg.list().map(t => t.id), ['a']);
});

test('onChange 在增删时触发,取消订阅后不再触发', () => {
    const reg = createRegistry('tools');
    let n = 0;
    const off = reg.onChange(() => n++);
    reg.define({ id: 'a', pluginId: 'p' });
    assert.equal(n, 1);
    off();
    reg.define({ id: 'b', pluginId: 'p' });
    assert.equal(n, 1);
});

test('removeByPlugin 触发 onChange', () => {
    const reg = createRegistry('tools');
    reg.define({ id: 'a', pluginId: 'p1' });
    let n = 0;
    reg.onChange(() => n++);
    reg.removeByPlugin('p1');
    assert.equal(n, 1);
});

test('缺 id 的 define 返回 false 而不是抛异常', () => {
    const reg = createRegistry('tools');
    assert.equal(reg.define({ pluginId: 'p' }), false);
});

test('define 传入 null / undefined 返回 false 而不是抛异常', () => {
    const reg = createRegistry('tools');
    assert.equal(reg.define(null), false);
    assert.equal(reg.define(undefined), false);
    assert.equal(reg.define({ id: '' }), false);
});

test('get 未注册的 id 返回 null', () => {
    const reg = createRegistry('tools');
    assert.equal(reg.get('不存在'), null);
});

test('define 不写 order 时默认 1000', () => {
    const reg = createRegistry('tools');
    reg.define({ id: 'a', pluginId: 'p' });
    assert.equal(reg.get('a').order, 1000);
});

test('一个订阅者抛错不影响其他订阅者', () => {
    const reg = createRegistry('tools');
    // 静音注册表自身的报错通道,避免测试输出被噪音淹没
    const originalError = console.error;
    console.error = () => {};
    try {
        let second = 0;
        reg.onChange(() => { throw new Error('boom'); });
        reg.onChange(() => second++);
        reg.define({ id: 'a', pluginId: 'p' });
        assert.equal(second, 1, '前一个订阅者抛错不该中断后面的');
    } finally {
        console.error = originalError;
    }
});

test('list 返回的是快照,外部改动不影响注册表', () => {
    const reg = createRegistry('tools');
    reg.define({ id: 'a', pluginId: 'p', title: '原值' });
    const snapshot = reg.list();
    snapshot[0].title = '被改了';
    assert.equal(reg.get('a').title, '原值');
});

test('createRegistries 提供 tools / services / panes 三套独立实例', () => {
    const regs = createRegistries();
    regs.tools.define({ id: 'x', pluginId: 'p' });
    assert.equal(regs.services.get('x'), null, '两类注册表必须互相独立');
    assert.equal(regs.panes.get('x'), null, 'panes 也不能与 tools 串在一起');
    assert.deepEqual(regs.tools.list().map(t => t.id), ['x']);
    assert.deepEqual(regs.services.list(), []);
    assert.deepEqual(regs.panes.list(), []);
});

test('panes 与 tools 是两件事:同一个 id 可以在两边各登记一次', () => {
    // 例如短剧:内容区那个"工具面板"与工作台里那片"画布 pane"可能同名,
    // 它们的生命周期与归宿完全不同(一个住内容区、一个进布局存档),不该互相顶掉。
    const regs = createRegistries();
    assert.equal(regs.tools.define({ id: 'drama', title: '短剧工作台', pluginId: 'drama' }), true);
    assert.equal(regs.panes.define({ id: 'drama', title: '短剧画布', pluginId: 'drama' }), true);
    assert.equal(regs.tools.get('drama').title, '短剧工作台');
    assert.equal(regs.panes.get('drama').title, '短剧画布');
});

test('removeByPlugin 同时回收该插件的 pane(卸插件不留幽灵面板)', () => {
    const regs = createRegistries();
    regs.panes.define({ id: 'a', title: 'A', pluginId: 'p1' });
    regs.panes.define({ id: 'b', title: 'B', pluginId: 'p2' });
    regs.panes.removeByPlugin('p1');
    assert.deepEqual(regs.panes.list().map(p => p.id), ['b']);
});
