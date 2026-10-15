import test from 'node:test';
import assert from 'node:assert/strict';
import { inputEdges, inputEdgeGroups, validateConnection } from '../app/lib/drama-connections.js';

const types = [
    { id: 'text', inputs: [], outputs: ['文本'] },
    { id: 'llm', inputs: ['文本'], outputs: ['文本'] },
    { id: 'edit', inputs: ['文本', '参考图'], outputs: ['图集'] },
    { id: 'image', inputs: ['文本'], multipleInputs: [0], outputs: ['参考图'] },
];
const graph = (edges = []) => ({ nodes: [
    { id: 'source', type: 'text' }, { id: 'writer', type: 'llm' },
    { id: 'edit', type: 'edit' }, { id: 'image', type: 'image' },
], edges });

test('文本输出可接文本生成输入，边记录端口', () => {
    assert.deepEqual(validateConnection(graph(), types, 'source', 0, 'writer', 0), {
        ok: true, edge: { from: 'source', fromPort: 0, to: 'writer', toPort: 0 },
    });
});

test('旧边仍占据首个输入，新边按指定端口排列', () => {
    const g = graph([{ from: 'source', to: 'edit' },
        { from: 'image', fromPort: 0, to: 'edit', toPort: 1 }]);
    assert.deepEqual(inputEdges(g, 'edit', 2).map((edge) => edge?.from), ['source', 'image']);
});

test('禁止无效、占用、重复和成环的连线', () => {
    const reason = (g, from, out, to, input) =>
        validateConnection(g, types, from, out, to, input).reason;
    assert.equal(reason(graph(), 'writer', 0, 'writer', 0), '不能连接节点自身');
    assert.equal(reason(graph(), 'source', 0, 'edit', 1), '端口类型不匹配');
    assert.equal(reason(graph(), 'source', 1, 'writer', 0), '输出端口不存在');
    assert.equal(reason(graph(), 'source', 0, 'missing', 0), '节点不存在');
    const connected = graph([{ from: 'source', to: 'writer' }]);
    assert.equal(reason(connected, 'source', 0, 'writer', 0), '连线已存在');
    assert.equal(reason(connected, 'image', 0, 'writer', 0), '端口类型不匹配');
    assert.equal(reason(connected, 'writer', 0, 'edit', 0), undefined);
    connected.edges.push({ from: 'writer', to: 'edit' });
    assert.equal(reason(connected, 'edit', 0, 'source', 0), '输入端口不存在');
    const cycle = graph([{ from: 'writer', to: 'edit' }]);
    assert.equal(reason(cycle, 'edit', 0, 'writer', 0), '端口类型不匹配');
});

test('已占用输入与闭环分别被拒绝', () => {
    const occupied = graph([{ from: 'source', to: 'writer' }]);
    assert.equal(validateConnection(occupied, types, 'writer', 0, 'writer', 0).reason,
        '不能连接节点自身');
    const cycle = graph([{ from: 'writer', to: 'image' }]);
    // 当前 image 输出为参考图，不能接 writer；改用两个文本生成节点验证环。
    cycle.nodes.push({ id: 'writer2', type: 'llm' });
    cycle.edges = [{ from: 'writer', to: 'writer2' }];
    assert.equal(validateConnection(cycle, types, 'writer2', 0, 'writer', 0).reason,
        '连接会形成环');
    const full = graph([{ from: 'source', to: 'writer' }]);
    full.nodes.push({ id: 'source2', type: 'text' });
    assert.equal(validateConnection(full, types, 'source2', 0, 'writer', 0).reason,
        '输入端口已有连线');
});

test('汇聚端口允许多个文本来源，旧边和任一显式重复边仍被拒绝', () => {
    const g = graph([{ from: 'source', to: 'image' }]);
    assert.equal(validateConnection(g, types, 'writer', 0, 'image', 0).ok, true);
    g.edges.push({ from: 'writer', fromPort: 0, to: 'image', toPort: 0 });
    assert.equal(validateConnection(g, types, 'writer', 0, 'image', 0).reason, '连线已存在');
    assert.equal(validateConnection(g, types, 'source', 0, 'image', 0).reason, '连线已存在');
    g.nodes.push({ id: 'third', type: 'text' });
    assert.equal(validateConnection(g, types, 'third', 0, 'image', 0).ok, true);
});

test('汇聚分组保留旧边与显式边的连入顺序，普通节点端口仍只有一个来源', () => {
    const edges = [{ from: 'source', to: 'image' },
        { from: 'writer', to: 'image', toPort: 0 }, { from: 'source2', to: 'image' }];
    assert.deepEqual(inputEdgeGroups(graph(edges), 'image', 1, [0]), [edges]);
    assert.deepEqual(inputEdges(graph(edges), 'image', 1), [edges[1]]);
    const g = graph([{ from: 'source', to: 'edit' }, { from: 'image', to: 'edit', toPort: 1 }]);
    assert.deepEqual(inputEdgeGroups(g, 'edit', 2).map(group => group.map(edge => edge.from)), [['source'], ['image']]);
});

test('汇聚输入仍拒绝类型错误、自连接和闭环', () => {
    const g = graph([{ from: 'image', to: 'writer' }]);
    const textImageTypes = types.map(type => type.id === 'image' ? { ...type, outputs: ['文本'] } : type);
    assert.equal(validateConnection(g, textImageTypes, 'writer', 0, 'image', 0).reason, '连接会形成环');
    assert.equal(validateConnection(g, types, 'image', 0, 'image', 0).reason, '不能连接节点自身');
    assert.equal(validateConnection(g, types, 'edit', 0, 'image', 0).reason, '端口类型不匹配');
});
