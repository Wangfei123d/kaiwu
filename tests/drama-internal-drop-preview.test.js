import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireDrop } from '../plugins/drama/drop-bus.js';

test('笔记列表捕获指针时，仍按文档坐标在画布显示并收起 Word 预落位', async () => {
    const documentListeners = new Map();
    const canvasListeners = new Map();
    const doc = {
        addEventListener(type, fn) { documentListeners.set(type, fn); },
        removeEventListener(type) { documentListeners.delete(type); },
    };
    const canvas = {
        ownerDocument: doc,
        dataset: {},
        addEventListener(type, fn) { canvasListeners.set(type, fn); },
        removeEventListener(type) { canvasListeners.delete(type); },
        setAttribute(name, value) { this.dataset[name.replace('data-', '')] = value; },
        removeAttribute(name) { delete this.dataset[name.replace('data-', '')]; },
        getBoundingClientRect() { return { left: 100, top: 50, right: 700, bottom: 500, width: 600, height: 450 }; },
    };
    const payload = { name: '分镜.docx', ext: 'docx', kind: 'text', absPath: 'E:\\vault\\分镜.docx' };
    let endDrag;
    const bus = {
        current: () => payload,
        onEnd(fn) { endDrag = fn; return () => {}; },
    };
    const calls = [];
    const preview = {
        show: (...args) => calls.push(['show', ...args]),
        hide: () => calls.push(['hide']),
    };
    const off = await wireDrop({
        bus, preview,
        ctx: {}, el: { canvas },
        state: { view: { x: 0, y: 0, scale: 1 }, graph: { nodes: [] }, selection: new Set() },
        nodeById: () => null, createNode: () => null,
        scheduleSave: () => {}, setStatus: () => {},
    });

    documentListeners.get('pointermove')({ clientX: 210, clientY: 270 });
    assert.equal(canvas.dataset.drop, 'armed');
    assert.deepEqual(calls.at(-1), ['show', '分镜.docx', 210, 270]);

    documentListeners.get('pointermove')({ clientX: 800, clientY: 270 });
    assert.equal(canvas.dataset.drop, undefined);
    assert.deepEqual(calls.at(-1), ['hide']);

    documentListeners.get('pointermove')({ clientX: 220, clientY: 270 });
    endDrag({ payload, clientX: 220, clientY: 270, insideTree: true });
    assert.deepEqual(calls.at(-1), ['hide']);
    off();
    assert.equal(documentListeners.has('pointermove'), false);
});
