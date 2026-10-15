import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCtx } from '../app/runtime/ctx.js';
import { createRegistries } from '../app/runtime/registries.js';

function fakeBridge(calls) {
    return {
        invoke(channel, payload) {
            calls.push([channel, payload]);
            return Promise.resolve('ok');
        },
        on() { return () => {}; },
    };
}

// 静音的 console,避免测试输出被日志噪音淹没
const quiet = { info() {}, warn() {}, error() {} };

const descriptor = (permissions) => ({
    id: 'demo', name: 'Demo', version: '1.0.0',
    root: 'plugin', dir: '/x', entryUrl: 'toolbox://plugin/demo/index.js',
    permissions,
    contributions: { tools: [], services: [] },
});

const build = (permissions, { bridge = fakeBridge([]), registries = createRegistries() } = {}) =>
    buildCtx({ descriptor: descriptor(permissions), bridge, registries, log: quiet });

test('未声明权限时对应成员不存在', () => {
    const ctx = build(['log']);
    assert.equal('services' in ctx, false);
    assert.equal('settings' in ctx, false);
    assert.equal('dialog' in ctx, false);
    assert.equal('shell' in ctx, false);
    assert.equal('log' in ctx, true);
});

test('声明后成员存在', () => {
    const ctx = build(['log', 'settings', 'dialog', 'shell']);
    assert.equal(typeof ctx.settings.get, 'function');
    assert.equal(typeof ctx.dialog.openFile, 'function');
    assert.equal(typeof ctx.shell.openExternal, 'function');
});

test('ctx.tools.register 自动带上 pluginId', () => {
    const registries = createRegistries();
    const ctx = build(['log'], { registries });
    ctx.tools.register({ id: 'demo', title: 'Demo', icon: 'i', panel: '<p>x</p>' });
    assert.equal(registries.tools.get('demo').pluginId, 'demo');
});

test('ctx.tools.register 把注册结果如实返回', () => {
    const registries = createRegistries();
    registries.tools.define({ id: 'dup', pluginId: 'other' });
    const ctx = build(['log'], { registries });
    assert.equal(ctx.tools.register({ id: 'dup', title: 'D', icon: 'i', panel: '<p>' }), false);
    assert.equal(ctx.tools.register({ id: 'fresh', title: 'F', icon: 'i', panel: '<p>' }), true);
});

test('settings 读写打到正确的命名空间', async () => {
    const calls = [];
    const ctx = build(['log', 'settings'], { bridge: fakeBridge(calls) });
    await ctx.settings.set('theme', 'dark');
    assert.deepEqual(calls.at(-1),
        ['kaiwu:settings:set', { pluginId: 'demo', key: 'theme', value: 'dark' }]);
});

test('settings.get 把 null/undefined 换成 fallback', async () => {
    const bridge = {
        invoke: async () => null,
        on: () => () => {},
    };
    const ctx = build(['log', 'settings'], { bridge });
    assert.equal(await ctx.settings.get('missing', '默认值'), '默认值');
    assert.equal(await ctx.settings.get('missing'), null);
});

test('settings.get 返回值存在时用返回值而不是 fallback', async () => {
    const bridge = { invoke: async () => 'stored', on: () => () => {} };
    const ctx = build(['log', 'settings'], { bridge });
    assert.equal(await ctx.settings.get('k', 'fallback'), 'stored');
});

test('dialog.openFile 缺省参数被补成空对象', async () => {
    const calls = [];
    const ctx = build(['log', 'dialog'], { bridge: fakeBridge(calls) });
    await ctx.dialog.openFile();
    assert.deepEqual(calls.at(-1), ['kaiwu:dialog:openFile', {}]);
});

test('shell.openExternal 拒绝非 http(s)', async () => {
    const calls = [];
    const ctx = build(['log', 'shell'], { bridge: fakeBridge(calls) });
    await assert.rejects(() => ctx.shell.openExternal('file:///C:/Windows/win.ini'));
    assert.equal(calls.length, 0);      // 根本没发出去
});

test('shell.openExternal 放行 http 与 https', async () => {
    const calls = [];
    const ctx = build(['log', 'shell'], { bridge: fakeBridge(calls) });
    await ctx.shell.openExternal('https://example.com/a');
    assert.deepEqual(calls.at(-1), ['kaiwu:shell:openExternal', { url: 'https://example.com/a' }]);
    await ctx.shell.openExternal('http://127.0.0.1:3300/');
    assert.deepEqual(calls.at(-1), ['kaiwu:shell:openExternal', { url: 'http://127.0.0.1:3300/' }]);
});

test('shell.openExternal 拒绝非字符串与 javascript:', async () => {
    const calls = [];
    const ctx = build(['log', 'shell'], { bridge: fakeBridge(calls) });
    await assert.rejects(() => ctx.shell.openExternal(null));
    await assert.rejects(() => ctx.shell.openExternal('javascript:alert(1)'));
    assert.equal(calls.length, 0);
});

test('ctx.services 不提供 define —— 服务只能由清单声明', () => {
    const ctx = build(['log', 'services']);
    assert.equal(typeof ctx.services.start, 'function');
    assert.equal(ctx.services.define, undefined,
        '一旦允许运行时登记服务,就能递进任意命令行,权限模型的那条保证即失效');
});

test('ctx.services.start 带上 pluginId 与 id', async () => {
    const calls = [];
    const ctx = build(['log', 'services'], { bridge: fakeBridge(calls) });
    await ctx.services.start('qqmusic');
    assert.deepEqual(calls.at(-1),
        ['kaiwu:services:start', { pluginId: 'demo', id: 'qqmusic' }]);
});

test('ctx.services.on 只接受 change 事件', () => {
    const ctx = build(['log', 'services']);
    assert.throws(() => ctx.services.on('svc', '别的', () => {}), /只支持 change/);
});

test('ctx.services.on 只把匹配 id 的变化回调出去', () => {
    const handlers = [];
    const bridge = {
        invoke: async () => null,
        on(channel, cb) {
            handlers.push({ channel, cb });
            return () => {};
        },
    };
    const ctx = build(['log', 'services'], { bridge });
    const seen = [];
    ctx.services.on('svc', 'change', s => seen.push(s));

    assert.equal(handlers.length, 1);
    assert.equal(handlers[0].channel, 'kaiwu:services:changed');
    handlers[0].cb({ id: '别的', status: 'ready' });
    handlers[0].cb({ id: 'svc', status: 'ready' });
    assert.deepEqual(seen, [{ id: 'svc', status: 'ready' }]);
});

test('ctx.services.status 从 list 里挑出对应项', async () => {
    // 真实契约:status 走 services:list(入参只有 pluginId),在渲染进程侧过滤。
    // 所以主进程返回的是整份列表,与要查的 id 无关 —— 假桥必须照这个形状来,
    // 否则「过滤用的 id 用错了」这类缺陷会被假桥掩盖过去。
    const list = [{ id: 'a', status: 'stopped' }, { id: 'b', status: 'ready' }];
    const bridge = {
        invoke: async (channel, payload) => {
            assert.equal(channel, 'kaiwu:services:list');
            assert.deepEqual(payload, { pluginId: 'demo' });
            return list.map(s => ({ ...s }));
        },
        on: () => () => {},
    };
    const ctx = build(['log', 'services'], { bridge });
    assert.deepEqual(await ctx.services.status('b'), { id: 'b', status: 'ready' });
    assert.equal(await ctx.services.status('不存在'), null);
});

test('log 成员始终存在 —— 插件唯一无条件的反馈通道', () => {
    const ctx = build([]);
    assert.equal(typeof ctx.log.info, 'function');
    assert.equal(typeof ctx.log.warn, 'function');
    assert.equal(typeof ctx.log.error, 'function');
});

test('未申请 log 权限时日志不转发到主进程', () => {
    const calls = [];
    const ctx = build([], { bridge: fakeBridge(calls) });
    ctx.log.info('不该发出去');
    assert.equal(calls.length, 0, 'log 权限只控制是否转发,不控制成员是否存在');
});

test('申请了 log 权限时日志转发到主进程', () => {
    const calls = [];
    const ctx = build(['log'], { bridge: fakeBridge(calls) });
    ctx.log.warn('要发出去');
    assert.deepEqual(calls.at(-1),
        ['kaiwu:log', { level: 'warn', pluginId: 'demo', message: '要发出去' }]);
});

test('日志转发失败不会产生未处理的 Promise 拒绝', async () => {
    const rejections = [];
    const onUnhandled = reason => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        // 主进程侧通道不可用:invoke 直接拒绝
        const bridge = { invoke: async () => { throw new Error('通道关闭'); }, on: () => () => {} };
        const ctx = build(['log'], { bridge });
        ctx.log.error('会失败');
        // 给微任务队列一个机会去触发 unhandledRejection
        await new Promise(r => setTimeout(r, 10));
        assert.deepEqual(rejections, [], '日志是尽力而为的,不能把拒绝漏出去');
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('plugin 信息只读且带 id', () => {
    const ctx = build(['log']);
    assert.equal(ctx.plugin.id, 'demo');
    assert.throws(() => { 'use strict'; ctx.plugin.id = 'x'; }, TypeError);
});

test('onDispose 注册的函数会在 dispose 时被调用', () => {
    const ctx = build(['log']);
    let called = 0;
    ctx.onDispose(() => called++);
    ctx.__dispose();
    assert.equal(called, 1);
});

test('onDispose 按注册的逆序调用', () => {
    const ctx = build(['log']);
    const order = [];
    ctx.onDispose(() => order.push('第一'));
    ctx.onDispose(() => order.push('第二'));
    ctx.__dispose();
    assert.deepEqual(order, ['第二', '第一'], '后申请的资源先释放');
});

test('onDispose 回调抛错不影响其他回调', () => {
    const ctx = build(['log']);
    let second = 0;
    ctx.onDispose(() => { throw new Error('boom'); });
    ctx.onDispose(() => second++);
    ctx.__dispose();
    assert.equal(second, 1);
});

test('onDispose 重复 dispose 不会重复调用回调', () => {
    const ctx = build(['log']);
    let called = 0;
    ctx.onDispose(() => called++);
    ctx.__dispose();
    ctx.__dispose();
    assert.equal(called, 1);
});

test('onDispose 传入非函数被忽略', () => {
    const ctx = build(['log']);
    assert.doesNotThrow(() => ctx.onDispose('不是函数'));
    ctx.__dispose();
});

// ---------------------------------------------------------------------------
// 「AI 会话」这一项能力(ctx.sessions)
//
// 为什么单独一项能力:插件**够不到** agent 的任何东西(它跑在沙箱渲染进程里),
// 而"这条能不能接着聊"要同时看台账、这条连接接上过的、对端清单三处 —— 只有主进程
// 都摸得到。所以插件拿到的是**已经判好的行**,这里钉的就是它只能递会话 id。
// ---------------------------------------------------------------------------

test('没申请 sessions 权限时,ctx.sessions 根本不存在', () => {
    const ctx = build(['log']);
    assert.equal('sessions' in ctx, false);
});

test('申请之后:五个成员都在,而且只能递会话 id(递不进路径)', async () => {
    const calls = [];
    const ctx = build(['log', 'sessions'], { bridge: fakeBridge(calls) });
    assert.equal(typeof ctx.sessions.list, 'function');
    assert.equal(typeof ctx.sessions.read, 'function');
    assert.equal(typeof ctx.sessions.remove, 'function');
    assert.equal(typeof ctx.sessions.activate, 'function');
    assert.equal(typeof ctx.sessions.onChanged, 'function');

    await ctx.sessions.read('870dbbb2');
    await ctx.sessions.remove('870dbbb2');
    await ctx.sessions.activate('870dbbb2');
    await ctx.sessions.list();
    assert.deepEqual(calls, [
        ['sessions:read', { id: '870dbbb2' }],
        ['sessions:remove', { id: '870dbbb2' }],
        ['sessions:activate', { id: '870dbbb2' }],
        ['sessions:list', {}],
    ]);
});

test('activate 原样把"接不上"的返回值交给插件(不许在这里吞成 undefined)', async () => {
    const bridge = {
        invoke: (channel) => Promise.resolve(channel === 'sessions:activate'
            ? { ok: false, reason: '这条会话属于另一个笔记库' }
            : {}),
        on: () => () => {},
    };
    const ctx = build(['log', 'sessions'], { bridge });
    const r = await ctx.sessions.activate('x');
    assert.equal(r.ok, false);
    assert.match(r.reason, /另一个笔记库/);
});

test('onChanged 只在 sessions:changed 上回调,退订能生效', () => {
    let handler = null;
    const off = () => { handler = null; };
    const bridge = {
        invoke: () => Promise.resolve({}),
        on(channel, fn) { assert.equal(channel, 'sessions:changed'); handler = fn; return off; },
    };
    const ctx = build(['log', 'sessions'], { bridge });
    const seen = [];
    const stop = ctx.sessions.onChanged((p) => seen.push(p));
    handler({ kind: 'written' });
    assert.deepEqual(seen, [{ kind: 'written' }]);
    stop();
    assert.equal(handler, null, '退订要把订阅摘掉');
});

test('onChanged 传进来的不是函数也不炸(返回一个空的退订)', () => {
    const ctx = build(['log', 'sessions'], { bridge: fakeBridge([]) });
    assert.equal(typeof ctx.sessions.onChanged(null), 'function');
});

test('新建会话:ctx.sessions.create() 打到 sessions:new(只递一个空对象)', async () => {
    const calls = [];
    const ctx = build(['log', 'sessions'], { bridge: fakeBridge(calls) });
    await ctx.sessions.create();
    assert.deepEqual(calls, [['sessions:new', {}]]);
});
