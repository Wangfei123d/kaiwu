import { test } from 'node:test';
import assert from 'node:assert/strict';

// mountTool 需要 DOM,所以这里只在有 DOM 的最小替身时跑。
// 我们关心的其实只有一件事:**过期挂载一个字节都不能写进共享容器**。
// 这是自检里真实抓到过的竞态(10 次里约 2 次):旧挂载在新挂载之后完成,
// 把自己的面板写进容器,于是"选中 hello 却显示 music",且无任何报错。
//
// 用一个极小的 DOM 替身来验证,而不是引入 jsdom(项目零运行时依赖)。

class FakeElement {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this._html = '';
        this.textContent = '';
        this.style = {};
        this.listeners = {};
    }
    set innerHTML(v) { this._html = String(v); }
    get innerHTML() { return this._html; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() {}
}

function installFakeDom() {
    const head = new FakeElement('head');
    globalThis.document = {
        head,
        createElement: (tag) => new FakeElement(tag),
    };
    return { head };
}

function removeFakeDom() {
    delete globalThis.document;
}

const descriptor = (id) => ({
    id, name: id, version: '1.0.0', root: 'plugin', dir: '/x',
    entryUrl: `toolbox://plugin/${id}/index.js`,
    permissions: ['log'], contributions: { tools: [], services: [] },
});

const ctx = { log: { info() {}, warn() {}, error() {} } };

test('shouldApply 为 false 时不写容器、不加样式', async () => {
    const { head } = installFakeDom();
    const { mountTool } = await import('../app/runtime/mount.js');
    try {
        const container = new FakeElement();
        const handle = await mountTool({
            descriptor: descriptor('b'),
            toolSpec: { panel: '<p>B</p>', style: '.b{}' },
            instance: null,
            container,
            ctx,
            fetchText: async () => 'should-not-be-used',
            shouldApply: () => false,
        });

        assert.equal(container.innerHTML, '', '过期的挂载绝不能写容器');
        assert.equal(head.children.length, 0, '过期的挂载绝不能插样式');
        assert.equal(typeof handle.teardown, 'function', '仍要返回可用的句柄');
        await handle.teardown();        // 不该抛
    } finally {
        removeFakeDom();
    }
});

test('shouldApply 为 true 时正常写入面板', async () => {
    installFakeDom();
    const { mountTool } = await import('../app/runtime/mount.js');
    try {
        const container = new FakeElement();
        await mountTool({
            descriptor: descriptor('a'),
            toolSpec: { panel: '<p>A</p>' },
            instance: null,
            container,
            ctx,
            fetchText: async () => 'unused',
            shouldApply: () => true,
        });
        assert.equal(container.innerHTML, '<p>A</p>');
        assert.equal(container.dataset.plugin, 'a');
    } finally {
        removeFakeDom();
    }
});

test('fetch 面板期间失去资格 → 仍然不写容器', async () => {
    installFakeDom();
    const { mountTool } = await import('../app/runtime/mount.js');
    try {
        const container = new FakeElement();
        let applies = true;
        const handle = await mountTool({
            descriptor: descriptor('c'),
            // 走 fetch 分支,在 fetch 过程中把资格撤掉
            toolSpec: { panel: 'panel.html' },
            instance: null,
            container,
            ctx,
            fetchText: async () => {
                applies = false;        // 模拟"这期间用户点了别的工具"
                return '<p>C</p>';
            },
            shouldApply: () => applies,
        });
        assert.equal(container.innerHTML, '', 'fetch 回来时已过期,不能写入');
        await handle.teardown();
    } finally {
        removeFakeDom();
    }
});

test('setup 抛错会被抛出,由调用方呈现错误', async () => {
    installFakeDom();
    const { mountTool } = await import('../app/runtime/mount.js');
    try {
        const container = new FakeElement();
        await assert.rejects(
            () => mountTool({
                descriptor: descriptor('d'),
                toolSpec: { panel: '<p>D</p>' },
                instance: { setup() { throw new Error('setup 炸了'); } },
                container,
                ctx,
                fetchText: async () => '',
                shouldApply: () => true,
            }),
            /setup 炸了/,
        );
    } finally {
        removeFakeDom();
    }
});

test('内联纯文本面板被当作内联,不会去 fetch', async () => {
    installFakeDom();
    const { mountTool } = await import('../app/runtime/mount.js');
    try {
        const container = new FakeElement();
        let fetched = false;
        await mountTool({
            descriptor: descriptor('e'),
            toolSpec: { panel: 'hello' },
            instance: null,
            container,
            ctx,
            fetchText: async () => { fetched = true; return '不该走到这里'; },
            shouldApply: () => true,
        });
        assert.equal(container.innerHTML, 'hello');
        assert.equal(fetched, false, '没有扩展名的面板应当视为内联');
    } finally {
        removeFakeDom();
    }
});
