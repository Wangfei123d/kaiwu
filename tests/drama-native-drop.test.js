import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireNativeWordDrop } from '../plugins/drama/drop-bus.js';

function makeFile(name, size = 8) {
    return { name, size, arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer };
}

function harness({ readDroppedText } = {}) {
    const listeners = new Map();
    const canvas = {
        dataset: {},
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        setAttribute(name, value) { this.dataset[name.replace('data-', '')] = value; },
        removeAttribute(name) { delete this.dataset[name.replace('data-', '')]; },
        getBoundingClientRect() { return { left: 100, top: 50, right: 700, bottom: 500 }; },
    };
    const node = { id: 'n1', type: 'text', params: {} };
    const created = [];
    let saved = 0;
    const statuses = [];
    const previewCalls = [];
    const preview = {
        show: (...args) => previewCalls.push(['show', ...args]),
        reading: () => previewCalls.push(['reading']),
        hide: () => previewCalls.push(['hide']),
    };
    wireNativeWordDrop({
        ctx: { drama: { readDroppedText: readDroppedText ?? (async () => ({ name: '台词.docx', text: '正文', chars: 2, note: 'Word' })) } },
        el: { canvas }, state: { view: { x: 10, y: 20, scale: 2 }, graph: { nodes: [] } },
        nodeById: (id) => id === 'n1' ? node : null,
        createNode: (type, x, y) => { created.push({ type, x, y }); return 'n1'; },
        scheduleSave: () => { saved += 1; },
        setStatus: (text) => statuses.push(text),
        preview,
    });
    async function fire(type, files, clientX = 210, clientY = 270, types = []) {
        let prevented = false;
        const result = listeners.get(type)({
            dataTransfer: { files, types }, clientX, clientY,
            preventDefault() { prevented = true; },
        });
        await result;
        return prevented;
    }
    return { canvas, created, node, statuses, previewCalls, get saved() { return saved; }, fire };
}

test('docx 原生 drop 等提取成功后才按缩放后的坐标创建文本节点', async () => {
    let release = null;
    const h = harness({ readDroppedText: () => new Promise((resolve) => { release = resolve; }) });
    const pending = h.fire('drop', [makeFile('台词终稿.docx')]);
    await Promise.resolve();
    assert.deepEqual(h.created, [], '读取中绝不抢先创建空节点');
    release({ name: '台词终稿.docx', text: '正文', chars: 2, note: 'Word(.docx)' });
    const prevented = await pending;
    assert.equal(prevented, true);
    assert.deepEqual(h.created, [{ type: 'text', x: 50, y: 100 }]);
    assert.equal(h.node.params.value, '正文');
    assert.equal(h.saved, 1);
    assert.match(h.statuses.at(-1), /已导入 台词终稿.docx/);
});

test('旧 doc、多文件与超限 docx 均不创建或保存节点', async () => {
    const h = harness();
    await h.fire('drop', [makeFile('旧稿.doc')]);
    await h.fire('drop', [makeFile('甲.docx'), makeFile('乙.docx')]);
    await h.fire('drop', [makeFile('太大.docx', 200 * 1024 + 1)]);
    assert.deepEqual(h.created, []);
    assert.equal(h.saved, 0);
    assert.match(h.statuses.join('\n'), /旧版 Word\(\.doc\)/);
    assert.match(h.statuses.join('\n'), /一次只能拖入一个/);
    assert.match(h.statuses.join('\n'), /超过 200 KB/);
});

test('带文件的 dragover 才阻止默认行为并显示可投放状态', async () => {
    const h = harness();
    const nonFilePrevented = await h.fire('dragover', []);
    assert.equal(nonFilePrevented, false);
    const filePrevented = await h.fire('dragover', [makeFile('台词.docx')]);
    assert.equal(filePrevented, true);
    assert.equal(h.canvas.dataset.drop, 'armed');
});

test('受保护拖动阶段只暴露 Files 类型时仍显示节点预落位', async () => {
    const h = harness();
    const prevented = await h.fire('dragover', [], 210, 270, ['Files']);
    assert.equal(prevented, true);
    assert.equal(h.canvas.dataset.drop, 'armed');
    assert.deepEqual(h.previewCalls.at(-1), ['show', 'Word 文件', 210, 270]);
    await h.fire('dragleave', []);
    assert.deepEqual(h.previewCalls.at(-1), ['hide']);
});
