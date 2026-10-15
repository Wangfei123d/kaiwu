import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins } from '../app/runtime/loader.js';
import { createRegistries } from '../app/runtime/registries.js';

const desc = (id, permissions = ['log']) => ({
    id, name: id, version: '1.0.0',
    root: 'plugin', dir: '/x', entryUrl: `toolbox://plugin/${id}/index.js`,
    permissions, contributions: { tools: [], services: [] },
});

// 把 console 噪音关掉,测试输出才看得清
const quiet = { info() {}, warn() {}, error() {} };

// 假的 IPC 桥:管线要它才能构造 ctx,但测试不关心真的发出去什么
const fakeBridge = { invoke: async () => null, on: () => () => {} };

function run(descriptors, importFn, registries = createRegistries()) {
    return loadPlugins({ descriptors, importFn, registries, bridge: fakeBridge, log: quiet });
}

test('正常插件被激活并注册了工具', async () => {
    const registries = createRegistries();
    const result = await run([desc('a')], async () => ({
        default: {
            activate(ctx) {
                ctx.tools.register({ id: 'a', title: 'A', icon: 'i', panel: '<p>x</p>' });
            },
        },
    }), registries);
    assert.equal(result.activated.length, 1);
    assert.equal(result.broken.length, 0);
    assert.equal(registries.tools.get('a').pluginId, 'a');
});

test('标记为工作台面板的清单工具按稳定 id 惰性挂载并复用原 teardown', async () => {
    const registries = createRegistries();
    const descriptor = desc('folder');
    descriptor.contributions.tools = [{
        id: 'asset', title: '素材工具', icon: 'box', panel: 'panel.html', style: null, workspacePane: true,
    }];
    let setupCount = 0;
    let teardownCount = 0;
    const result = await loadPlugins({
        descriptors: [descriptor],
        importFn: async () => ({ default: {
            setup() { setupCount += 1; },
            teardown() { teardownCount += 1; },
        } }),
        registries, bridge: fakeBridge, log: quiet,
        fetchText: async (url) => {
            assert.equal(url, 'toolbox://plugin/folder/panel.html');
            return '<p>独立工具内容</p>';
        },
    });

    const pane = registries.panes.get('tool:folder:asset');
    assert.equal(result.activated.length, 1);
    assert.equal(pane.title, '素材工具');
    assert.equal(pane.optional, true);
    assert.equal(typeof pane.mount, 'function');
    assert.equal(setupCount, 0, '插件激活阶段不能提前挂载工具 DOM');

    const host = { dataset: {}, innerHTML: '' };
    const handle = await pane.mount(host);
    assert.equal(host.innerHTML, '<p>独立工具内容</p>');
    assert.equal(host.dataset.plugin, 'folder');
    assert.equal(setupCount, 1);
    await handle.teardown();
    assert.equal(teardownCount, 1);
});

test('未标记的工具仍是普通工具,不会生成工作台 pane', async () => {
    const registries = createRegistries();
    const descriptor = desc('ordinary');
    descriptor.contributions.tools = [{ id: 'tool', title: '普通工具', icon: 'box', panel: 'panel.html' }];
    await run([descriptor], async () => ({ default: { activate() {} } }), registries);
    assert.equal(registries.tools.get('tool') !== null, true);
    assert.equal(registries.panes.list().length, 0);
});

test('单文件插件可在 activate 注册时声明工作台面板', async () => {
    const registries = createRegistries();
    let setupCount = 0;
    const result = await run([desc('hello')], async () => ({ default: {
        activate(ctx) {
            ctx.tools.register({
                id: 'hello', title: '单文件示例', icon: 'sparkle', workspacePane: true,
                panel: '<p>inline tool</p>', setup() { setupCount += 1; },
            });
        },
    } }), registries);
    const pane = registries.panes.get('tool:hello:hello');
    assert.equal(result.activated.length, 1);
    assert.equal(pane.optional, true);
    assert.equal(setupCount, 0);
    const host = { dataset: {}, innerHTML: '' };
    await pane.mount(host);
    assert.equal(host.innerHTML, '<p>inline tool</p>');
    assert.equal(setupCount, 1);
});

test('import 抛错的插件进 broken,不影响其他插件', async () => {
    const result = await run([desc('bad'), desc('good')], async (url) => {
        if (url.includes('/bad/')) throw new Error('语法错误');
        return { default: { activate() {} } };
    });
    assert.equal(result.broken.length, 1);
    assert.equal(result.broken[0].descriptor.id, 'bad');
    assert.equal(result.broken[0].stage, 'import');
    assert.equal(result.activated.length, 1);
    assert.equal(result.activated[0].descriptor.id, 'good');
});

test('activate 抛错的插件进 broken,stage 为 activate', async () => {
    const result = await run([desc('boom')], async () => ({
        default: { activate() { throw new Error('激活炸了'); } },
    }));
    assert.equal(result.broken[0].stage, 'activate');
    assert.match(result.broken[0].error.message, /激活炸了/);
});

test('没有 default 导出进 broken', async () => {
    const result = await run([desc('nodedefault')], async () => ({ activate() {} }));
    assert.equal(result.broken[0].stage, 'no-default-export');
});

test('断链的 descriptor 直接进 broken,不调用 importFn', async () => {
    let called = 0;
    const broken = { ...desc('broken'), status: 'broken', error: { stage: 'scan', message: '清单非法' } };
    const result = await run([broken], async () => { called++; return { default: {} }; });
    assert.equal(called, 0);
    assert.equal(result.broken[0].stage, 'scan');
});

test('一个插件注册失败(重复 id)不会让它整体进 broken', async () => {
    const registries = createRegistries();
    registries.tools.define({ id: 'dup', pluginId: 'other' });
    const result = await run([desc('a')], async () => ({
        default: {
            activate(ctx) {
                const ok = ctx.tools.register({ id: 'dup', title: 'D', icon: 'i', panel: '<p>' });
                ctx.log.warn('注册被拒绝:' + ok);
            },
        },
    }), registries);
    assert.equal(result.activated.length, 1);
    assert.equal(result.broken.length, 0);
    assert.equal(registries.tools.get('dup').pluginId, 'other');   // 原项未被覆盖
});

test('activate 抛错时已注册的贡献点被回滚', async () => {
    const registries = createRegistries();
    const result = await run([desc('half')], async () => ({
        default: {
            activate(ctx) {
                ctx.tools.register({ id: 'ghost', title: 'G', icon: 'i', panel: '<p>' });
                throw new Error('注册完才炸');
            },
        },
    }), registries);
    assert.equal(result.broken.length, 1);
    assert.equal(registries.tools.get('ghost'), null, '不应留下幽灵工具');
});

test('activate 抛错时该插件的 onDispose 回调仍被调用', async () => {
    const registries = createRegistries();
    let disposed = 0;
    await run([desc('half')], async () => ({
        default: {
            activate(ctx) {
                ctx.onDispose(() => disposed++);
                throw new Error('注册完才炸');
            },
        },
    }), registries);
    assert.equal(disposed, 1, '激活失败的插件也必须释放它申请过的资源');
});

test('activate 是异步函数时会被 await', async () => {
    const registries = createRegistries();
    await run([desc('async')], async () => ({
        default: {
            async activate(ctx) {
                await new Promise(r => setTimeout(r, 5));
                ctx.tools.register({ id: 'async', title: 'A', icon: 'i', panel: '<p>' });
            },
        },
    }), registries);
    assert.ok(registries.tools.get('async'));
});

test('activate 异步拒绝同样进 broken 并被回滚', async () => {
    const registries = createRegistries();
    const result = await run([desc('asyncbad')], async () => ({
        default: {
            async activate(ctx) {
                ctx.tools.register({ id: 'ghost', title: 'G', icon: 'i', panel: '<p>' });
                throw new Error('异步炸');
            },
        },
    }), registries);
    assert.equal(result.broken.length, 1);
    assert.equal(result.broken[0].stage, 'activate');
    assert.equal(registries.tools.get('ghost'), null);
});

test('没有 activate 的插件也算激活成功', async () => {
    const result = await run([desc('noactivate')], async () => ({ default: {} }));
    assert.equal(result.activated.length, 1);
    assert.equal(result.broken.length, 0);
});

test('default 不是对象进 broken', async () => {
    const result = await run([desc('fn')], async () => ({ default: () => {} }));
    assert.equal(result.broken[0].stage, 'no-default-export');
});

test('activate 抛错时给到的 ctx 带 plugin 信息,便于报错归属', async () => {
    let seen = null;
    await run([desc('who')], async () => ({
        default: { activate(ctx) { seen = ctx.plugin.id; throw new Error('x'); } },
    }));
    assert.equal(seen, 'who');
});

test('activated 项带回 descriptor / instance / ctx', async () => {
    const instance = { activate() {} };
    const result = await run([desc('a')], async () => ({ default: instance }));
    assert.equal(result.activated[0].descriptor.id, 'a');
    assert.equal(result.activated[0].instance, instance);
    assert.equal(typeof result.activated[0].ctx.tools.register, 'function');
});

test('status 为 ok 的 descriptor 正常加载(不被误判为断链)', async () => {
    const result = await run([{ ...desc('fine'), status: 'ok', error: null }],
        async () => ({ default: { activate() {} } }));
    assert.equal(result.activated.length, 1);
    assert.equal(result.broken.length, 0);
});

test('descriptor 列表为空时返回空结果', async () => {
    const result = await run([], async () => {});
    assert.deepEqual(result, { activated: [], broken: [] });
});

test('一个插件失败不会中断后续插件的加载', async () => {
    const registries = createRegistries();
    const result = await run(
        [desc('bad'), desc('ok1'), desc('ok2')],
        async (url) => {
            if (url.includes('/bad/')) throw new Error('炸');
            const id = url.includes('/ok1/') ? 'ok1' : 'ok2';
            return { default: { activate(ctx) { ctx.tools.register({ id, title: id, icon: 'i', panel: '<p>' }); } } };
        },
        registries,
    );
    assert.equal(result.broken.length, 1);
    assert.equal(result.activated.length, 2);
    assert.deepEqual(registries.tools.list().map(t => t.id), ['ok1', 'ok2']);
});
