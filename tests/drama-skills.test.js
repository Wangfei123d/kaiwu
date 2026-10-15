import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('技能匹配只给模型已连接技能元信息，语义结果按连入顺序且去重', async () => {
    const { skillCandidates, skillMatchKey } = await import('../app/lib/drama-skills.js');
    const { createSkillMatcher } = await import('../electron/drama/lib/skill-matcher.js');
    const graph = { nodes: [
        { id: 'a', type: 'skill', title: '人物', params: { purpose: '保持同一角色', value: 'secret-body', files: ['secret.png'] } },
        { id: 'b', type: 'skill', title: '光影', params: { purpose: '胶片电影光影' } },
        { id: 'other', type: 'skill', params: { purpose: '未连接' } },
        { id: 'out', type: 'image' }], edges: [
        { from: 'a', to: 'out', toPort: 1 }, { from: 'b', to: 'out', toPort: 1 }] };
    const candidates = skillCandidates(graph, 'out');
    assert.equal(candidates.length, 2);
    assert.doesNotMatch(JSON.stringify(candidates), /secret-body|secret.png|未连接/);
    let sent;
    const match = createSkillMatcher({ generateText: async args => {
        sent = args;
        return JSON.stringify({ selected: [
            { id: 'b', reason: '要求电影光影', evidence: '胶片电影' },
            { id: 'a', reason: '要求角色一致', evidence: '同一个人' },
            { id: 'a', reason: '重复', evidence: '同一个人' }] });
    } });
    const result = await match({ prompt: '保持同一个人，采用胶片电影光影。', candidates });
    assert.deepEqual(result.selected.map(s => s.id), ['a', 'b']);
    assert.doesNotMatch(sent.source, /secret-body|secret.png/);
    assert.match(sent.prompt, /否定/);
    const first = skillMatchKey('同一个人', candidates);
    graph.nodes[0].params.value = 'changed-unused-body';
    assert.equal(skillMatchKey('同一个人', skillCandidates(graph, 'out')), first);
    graph.nodes[0].params.purpose = '新用途';
    assert.notEqual(skillMatchKey('同一个人', skillCandidates(graph, 'out')), first);
});

test('匹配结果拒绝陌生技能、非 JSON 和脱离提示词的需求证据', async () => {
    const { createSkillMatcher } = await import('../electron/drama/lib/skill-matcher.js');
    const candidates = [{ id: 'a', name: '人物', purpose: '人物一致', scenarios: '', exclude: '', inputTypes: [] }];
    for (const reply of ['oops', '{"selected":[{"id":"foreign","reason":"r","evidence":"同一个人"}]}',
        '{"selected":[{"id":"a","reason":"r","evidence":"未出现的需求"}]}']) {
        const match = createSkillMatcher({ generateText: async () => reply });
        await assert.rejects(() => match({ prompt: '同一个人', candidates }), /技能匹配/);
    }
    let calls = 0;
    const match = createSkillMatcher({ generateText: async () => { calls++; return '{"selected":[]}'; } });
    assert.deepEqual(await match({ prompt: '', candidates }), { selected: [] });
    assert.equal(calls, 0);
    assert.deepEqual(await match({ prompt: '不需要保持人物一致', candidates }), { selected: [] });
});

test('技能图片读取验证真实字节、内容指纹和项目目录范围', async () => {
    const { readProjectImages } = await import('../electron/drama/lib/skill-resources.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-skill-img-'));
    fs.mkdirSync(path.join(dir, 'shots'));
    const bytes = Buffer.from('89504e470d0a1a0a0001', 'hex');
    fs.writeFileSync(path.join(dir, 'shots', 'ref.png'), bytes);
    const first = readProjectImages(dir, ['ref.png']);
    assert.equal(first.images[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(first.images[0].bytes), bytes);
    fs.writeFileSync(path.join(dir, 'shots', 'ref.png'), Buffer.concat([bytes, Buffer.from('change')]));
    assert.notEqual(readProjectImages(dir, ['ref.png']).signature, first.signature);
    assert.throws(() => readProjectImages(dir, ['../outside.png']), /项目|图片/);
    fs.writeFileSync(path.join(dir, 'shots', 'bad.png'), 'not an image');
    assert.throws(() => readProjectImages(dir, ['bad.png']), /图片/);
});
