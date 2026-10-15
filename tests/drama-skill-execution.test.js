import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure, writeGraph, readGraph, runGraph, palette } from '../electron/drama/lib/core.js';
import { validateConnection } from '../app/lib/drama-connections.js';

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-skill-run-'));
    configure({ root });
    const graph = { nodes: [
        { id: 'text', type: 'text', params: { value: '角色设定全文' } },
        { id: 'refs', type: 'image-input', params: { files: ['missing.png'] } },
        { id: 'skill', type: 'skill', title: '人物一致性', params: { purpose: '保持同一个人物', value: '' } },
        { id: 'out', type: 'image', params: { prompt: '生成雨夜镜头' } }], edges: [
        { from: 'text', to: 'skill', toPort: 0 }, { from: 'refs', to: 'skill', toPort: 1 },
        { from: 'skill', to: 'out', toPort: 1 }], runs: {} };
    writeGraph('test', graph);
    return { root, graph, dir: path.join(root, 'test') };
}

test('技能有双输入和专用输出；只可接生成节点技能汇聚端口', () => {
    const types = palette();
    const graph = { nodes: [{ id: 's', type: 'skill' }, { id: 'o', type: 'image' }], edges: [] };
    assert.deepEqual(types.find(t => t.id === 'skill')?.inputs, ['文本', '图集']);
    assert.equal(validateConnection(graph, types, 's', 0, 'o', 1).ok, true);
    assert.equal(validateConnection(graph, types, 's', 0, 'o', 0).ok, false);
});

test('未选技能不执行来源，缺失图片也不阻止接收节点；运行全部同样跳过', async () => {
    const { graph } = setup();
    // 故意会失败的命令来源只能进入待命技能，不可提前执行。
    graph.nodes[0].type = 'shell';
    graph.nodes[0].params = { command: "throw '待命技能来源不应执行'" };
    writeGraph('test', graph);
    let calls = 0;
    const options = { matchSkills: async () => ({ selected: [] }), generateImage: async () => { calls++; return { files: [], detail: 'image' }; } };
    const result = await runGraph('test', 'out', false, options);
    assert.doesNotMatch(result, /失败|异常/);
    let runs = readGraph('test').runs;
    assert.equal(runs.out.status, 'ok');
    assert.equal(runs.text, undefined);
    assert.equal(runs.refs, undefined);
    assert.equal(runs.skill, undefined);
    await runGraph('test', null, true, options);
    assert.equal(calls, 2);
    runs = readGraph('test').runs;
    assert.equal(runs.refs, undefined);
});

test('选中技能读取当前全文和图片字节；正文变化失效缓存，用途/提示词变化重匹配', async () => {
    const { graph, dir } = setup();
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'shots', 'missing.png'), Buffer.from('89504e470d0a1a0a0001', 'hex'));
    graph.nodes[0].params.value = '角色设定'.repeat(6000);
    graph.nodes[3].params.prompt = '保持同一个人';
    writeGraph('test', graph);
    let matches = 0;
    const calls = [];
    const options = { matchSkills: async () => { matches++; return { selected: [{ id: 'skill', reason: '要求同一角色', evidence: '同一个人' }] }; },
        generateImage: async args => { calls.push(args); return { files: [], detail: 'image' }; } };
    assert.doesNotMatch(await runGraph('test', 'out', false, options), /失败|异常/);
    assert.match(calls[0].prompt, /角色设定/);
    assert.ok(calls[0].prompt.includes(graph.nodes[0].params.value));
    assert.equal(calls[0].images[0].mimeType, 'image/png');
    await runGraph('test', 'out', false, options);
    assert.equal(matches, 1);
    assert.equal(calls.length, 1);
    const changed = readGraph('test');
    changed.nodes[0].params.value = '全新的角色';
    writeGraph('test', changed);
    await runGraph('test', 'out', false, options);
    assert.equal(matches, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /全新的角色/);
    assert.equal(readGraph('test').skillMatches.out.selected[0].id, 'skill');
    changed.nodes[2].params.purpose = '更新同一角色用途';
    writeGraph('test', changed);
    await runGraph('test', 'out', false, options);
    assert.equal(matches, 2);
});

test('匹配错误/越界 ID 在任何来源和生成执行前被拦住', async () => {
    setup();
    let calls = 0;
    const result = await runGraph('test', 'out', false, {
        matchSkills: async () => ({ selected: [{ id: 'foreign', reason: 'r', evidence: '雨夜' }] }),
        generateImage: async () => { calls++; throw new Error('不应调用'); },
    });
    assert.match(result, /技能匹配/);
    assert.equal(calls, 0);
    assert.equal(readGraph('test').runs.refs, undefined);
});

test('断开已启用技能后不复用旧匹配；无选中技能的用途变化仍重匹配和生成', async () => {
    const { graph } = setup();
    graph.edges = graph.edges.filter(edge => edge.from !== 'refs');
    writeGraph('test', graph);
    let matches = 0;
    const calls = [];
    const options = { matchSkills: async () => { matches++; return { selected: matches === 1
        ? [{ id: 'skill', reason: 'r', evidence: '雨夜' }] : [] }; },
        generateImage: async args => { calls.push(args); return { files: [], detail: 'ok' }; } };
    await runGraph('test', 'out', false, options);
    const disconnected = readGraph('test');
    disconnected.edges = disconnected.edges.filter(edge => edge.from !== 'skill');
    writeGraph('test', disconnected);
    assert.doesNotMatch(await runGraph('test', 'out', false, options), /失败|异常/);
    assert.equal(readGraph('test').skillMatches.out, undefined);
    assert.doesNotMatch(calls.at(-1).prompt, /角色设定/);
    const reconnected = readGraph('test');
    reconnected.edges.push({ from: 'skill', to: 'out', toPort: 1 });
    writeGraph('test', reconnected);
    await runGraph('test', 'out', false, options);
    const changed = readGraph('test');
    changed.nodes[2].params.purpose = '另一项用途';
    writeGraph('test', changed);
    await runGraph('test', 'out', false, options);
    assert.equal(matches, 3);
    assert.equal(calls.length, 4);
});

test('多个技能汇入文本生成，同时保留待命技能共享的普通分支', async () => {
    const { graph, dir } = setup();
    graph.nodes[3].type = 'llm';
    graph.nodes.push({ id: 'skill2', type: 'skill', title: '文风', params: { value: '克制对白' } });
    graph.edges = [{ from: 'text', to: 'out', toPort: 0 },
        { from: 'text', to: 'skill', toPort: 0 }, { from: 'refs', to: 'skill', toPort: 1 },
        { from: 'skill', to: 'out', toPort: 1 }, { from: 'skill2', to: 'out', toPort: 1 }];
    writeGraph('test', graph);
    const calls = [];
    const options = { matchSkills: async () => ({ selected: [{ id: 'skill2', reason: 'r', evidence: '雨夜' }] }),
        generateText: async args => { calls.push(args); return '正文'; } };
    assert.doesNotMatch(await runGraph('test', null, false, options), /失败|异常/);
    assert.match(calls[0].source, /角色设定全文/);
    assert.match(calls[0].source, /技能 · 文风/);
    assert.equal(readGraph('test').runs.refs, undefined);
    assert.equal(readGraph('test').runs.skill, undefined);
    const actual = readGraph('test').runs.out.skillInput;
    assert.match(fs.readFileSync(path.join(dir, actual.file), 'utf8'), /克制对白/);
});

test('实际技能输入在提交前登记并在失败后保留', async () => {
    const { graph, dir } = setup();
    graph.edges = graph.edges.filter(edge => edge.from !== 'refs');
    writeGraph('test', graph);
    const events = [];
    const result = await runGraph('test', 'out', false, {
        matchSkills: async () => ({ selected: [{ id: 'skill', reason: 'r', evidence: '雨夜' }] }),
        onNodeInput: payload => events.push(payload),
        generateImage: async args => {
            const run = readGraph('test').runs.out;
            assert.equal(run.status, 'running');
            assert.equal(fs.readFileSync(path.join(dir, run.skillInput.file), 'utf8'), args.prompt);
            assert.equal(events[0].run.skillInput.file, run.skillInput.file);
            throw new Error('fixture generation failed');
        },
    });
    assert.match(result, /fixture generation failed/);
    assert.equal(readGraph('test').runs.out.status, 'failed');
    assert.ok(readGraph('test').runs.out.skillInput);
});

test('超过 16 MiB 的实际技能输入在提交前拒绝', async () => {
    const { graph } = setup();
    graph.edges = graph.edges.filter(edge => edge.from !== 'refs');
    graph.nodes[0].params.value = 'x'.repeat(16 * 1024 * 1024);
    writeGraph('test', graph);
    let calls = 0;
    const result = await runGraph('test', 'out', false, {
        matchSkills: async () => ({ selected: [{ id: 'skill', reason: 'r', evidence: '雨夜' }] }),
        generateImage: async () => { calls++; return { files: [], detail: 'ok' }; },
    });
    assert.match(result, /16 MiB/);
    assert.equal(calls, 0);
});

test('两个技能共享四张参考图只按首次文件顺序发送一次', async () => {
    const { graph, dir } = setup();
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
    const files = ['a.png', 'b.png', 'c.png', 'd.png'];
    for (const file of files) fs.writeFileSync(path.join(dir, 'shots', file), Buffer.from('89504e470d0a1a0a0001', 'hex'));
    graph.nodes[1].params.files = files;
    graph.nodes.push({ id: 'skill2', type: 'skill', params: { value: '第二个技能全文' } });
    graph.edges.push({ from: 'refs', to: 'skill2', toPort: 1 }, { from: 'skill2', to: 'out', toPort: 1 });
    writeGraph('test', graph);
    let sent;
    const result = await runGraph('test', 'out', false, {
        matchSkills: async () => ({ selected: ['skill', 'skill2'].map(id => ({ id, reason: 'r', evidence: '雨夜' })) }),
        generateImage: async args => { sent = args; return { files: [], detail: 'ok' }; },
    });
    assert.doesNotMatch(result, /失败/);
    assert.equal(sent.images.length, 4);
    assert.match(sent.prompt, /第二个技能全文/);
    assert.deepEqual(readGraph('test').runs.out.skillInput.images, files);
});

test('未启用技能只改待命正文时继续复用匹配和生成缓存', async () => {
    setup();
    let matches = 0;
    let calls = 0;
    const options = {
        matchSkills: async () => { matches++; return { selected: [] }; },
        generateImage: async () => { calls++; return { files: [], detail: 'ok' }; },
    };
    await runGraph('test', 'out', false, options);
    const changed = readGraph('test');
    changed.nodes[0].params.value = '新待命来源正文';
    changed.nodes[2].params.value = '新待命技能正文';
    // 保持元信息中的文本类型不变，再只改正文。
    writeGraph('test', changed);
    await runGraph('test', 'out', false, options);
    const sameMetadata = readGraph('test');
    sameMetadata.nodes[0].params.value = '再次修改来源';
    sameMetadata.nodes[2].params.value = '再次修改技能正文';
    writeGraph('test', sameMetadata);
    const before = [matches, calls];
    await runGraph('test', 'out', false, options);
    assert.deepEqual([matches, calls], before);
});
