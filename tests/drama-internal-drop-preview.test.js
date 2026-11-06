import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireDrop } from '../plugins/drama/drop-bus.js';

test('笔记列表拖入文本文件不创建文本节点，并提示只支持手动输入', async () => {
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
    const statuses = [];
    const off = await wireDrop({
        bus,
        ctx: {}, el: { canvas },
        state: { view: { x: 0, y: 0, scale: 1 }, graph: { nodes: [] }, selection: new Set() },
        nodeById: () => null, createNode: () => { throw new Error('不应创建文本节点'); },
        scheduleSave: () => {}, setStatus: (text) => statuses.push(text),
    });

    documentListeners.get('pointermove')({ clientX: 210, clientY: 270 });
    assert.equal(canvas.dataset.drop, undefined);

    endDrag({ payload, clientX: 220, clientY: 270, insideTree: true });
    assert.deepEqual(statuses, []);
    endDrag({ payload, clientX: 220, clientY: 270, insideTree: false });
    assert.match(statuses.at(-1), /只支持手动输入纯文本/);
    assert.equal(canvas.dataset.drop, undefined);
    off();
    assert.equal(documentListeners.has('pointermove'), false);
});
