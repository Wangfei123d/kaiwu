import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCanvas } from '../app/lib/note-canvas.js';

export const graph = () => ({ nodes: [{ id: 'n1', type: 'text', x: 0, y: -10, width: 250, height: 160, text: '你好' }], edges: [], viewport: { x: 0, y: 0, scale: 1 } });

test('canvas normalizer safely copies JSON Canvas nodes, edges and viewport', () => {
    const raw = graph();
    raw.nodes.push({ id: 'f', type: 'file', x: 20, y: 10, width: 100, height: 100, file: '笔记/正文.md' },
        { id: 'l', type: 'link', x: 0, y: 0, width: 100, height: 100, url: 'https://example.com' },
        { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 500, label: '组', color: '2' });
    raw.edges.push({ id: 'e', fromNode: 'n1', toNode: 'f', fromSide: 'right', toSide: 'left', label: '引用' });
    const copy = normalizeCanvas(raw);
    assert.deepEqual(copy, raw);
    copy.nodes[0].text = 'changed';
    assert.equal(raw.nodes[0].text, '你好');
});

test('canvas normalizer rejects malformed geometry, IDs, endpoints and unsafe references', () => {
    for (const patch of [{ x: Infinity }, { width: 0 }, { id: '' }, { type: 'shell' }, { text: 'x'.repeat(200001) }]) {
        const raw = graph(); Object.assign(raw.nodes[0], patch);
        assert.throws(() => normalizeCanvas(raw), /[\u4e00-\u9fff]/);
    }
    const duplicate = graph(); duplicate.nodes.push({ ...duplicate.nodes[0] });
    assert.throws(() => normalizeCanvas(duplicate), /重复/);
    const edge = graph(); edge.edges.push({ id: 'e', fromNode: 'n1', toNode: 'missing', fromSide: 'right', toSide: 'left' });
    assert.throws(() => normalizeCanvas(edge), /端点/);
    edge.edges[0].toNode = 'n1'; edge.edges[0].toSide = 'center';
    assert.throws(() => normalizeCanvas(edge), /侧边/);
    for (const file of ['../secret', 'C:/secret', '/secret', 'a/../../secret', '%2e%2e/secret', 'foo:bar', 'dir\\secret']) {
        const raw = graph(); Object.assign(raw.nodes[0], { type: 'file', file });
        assert.throws(() => normalizeCanvas(raw), /路径/);
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://']) {
        const raw = graph(); Object.assign(raw.nodes[0], { type: 'link', url });
        assert.throws(() => normalizeCanvas(raw), /链接/);
    }
});

test('canvas normalizer enforces graph limits and JSON byte budget', () => {
    assert.throws(() => normalizeCanvas({ nodes: Array.from({ length: 1001 }, (_, i) => ({ ...graph().nodes[0], id: String(i) })), edges: [] }), /节点/);
    assert.throws(() => normalizeCanvas({ nodes: [], edges: Array(5001).fill({}) }), /连线/);
    const huge = graph(); huge.nodes = Array.from({ length: 45 }, (_, i) => ({ ...huge.nodes[0], id: String(i), text: 'x'.repeat(200000) }));
    assert.throws(() => normalizeCanvas(huge), /8|大小/);
    assert.throws(() => normalizeCanvas(null), /画布/);
    assert.throws(() => normalizeCanvas({ nodes: [], edges: [], viewport: { x: 0, y: 0, scale: 0 } }), /视口/);
});

test('canvas normalization emits integer geometry and never silently drops extension fields', () => {
    const raw = graph(); Object.assign(raw.nodes[0], { x: 1.4, y: -2.7, width: 0.2, height: 100.5 });
    const result = normalizeCanvas(raw).nodes[0];
    assert.deepEqual([result.x, result.y, result.width, result.height], [1, -3, 1, 101]);
    const unknown = graph(); unknown.nodes[0].secretExtension = 'retain or reject';
    assert.throws(() => normalizeCanvas(unknown), /字段/);
    const file = graph(); Object.assign(file.nodes[0], { type: 'file', file: 'script.exe' });
    assert.throws(() => normalizeCanvas(file), /文件/);
    const color = graph(); color.nodes[0].color = 'url(https://evil)';
    assert.throws(() => normalizeCanvas(color), /颜色/);
});
