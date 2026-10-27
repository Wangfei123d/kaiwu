import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGeneratedImages } from '../app/lib/agent-generated-images.js';

const user = id => ({ kind: 'message', message: { id, role: 'user', text: '生成图片', done: true } });
const reply = (id, text, done = true) => ({ kind: 'message', message: { id, role: 'assistant', text, done } });
const tool = (id, status = 'completed') => ({ kind: 'tool', tool: { toolCallId: id, title: 'generate_image', status } });

test('结果追加到工具之前的同一回复时仍绑定原框，Markdown 和直链去重', () => {
    const url = 'https://example.test/result.png';
    const plan = planGeneratedImages([user('u'), reply('m', `生成好了\n![结果](${url})\n图片直链：${url}`), tool('g')]);
    assert.deepEqual(plan.generations[0].images, [{ url, alt: '结果' }]);
    assert.deepEqual([...plan.omittedByMessage.get('m')], [url]);
});

test('不同轮次、不同生图调用按顺序绑定，普通回答图片不被接管', () => {
    const a = 'https://example.test/a.png', b = 'https://example.test/b.png';
    const plan = planGeneratedImages([
        user('plain'), reply('reference', `![参考](${a})`),
        user('u1'), tool('g1'), tool('g2'), reply('m1', `![1](${a})\n![2](${b})`),
        user('u2'), tool('g3'), reply('m2', `![新图](${a})`),
    ]);
    assert.equal(plan.omittedByMessage.has('reference'), false);
    assert.deepEqual(plan.generations.map(item => item.images.map(image => image.url)), [[a], [b], [a]]);
    assert.equal(plan.generations.at(-1).turn, plan.currentTurn);
    assert.notEqual(plan.generations[0].turn, plan.currentTurn);
});

test('代码、危险协议、失败调用不产生结果；流式未闭合直链等待后续字符', () => {
    const url = 'https://example.test/a.png';
    const plan = planGeneratedImages([user('u'), tool('g'), reply('m', `\`![代码](${url})\`\n![x](javascript:alert)\n${url}`, false)]);
    assert.deepEqual(plan.generations[0].images, []);
    assert.deepEqual([...plan.omittedByMessage.get('m')], [url]);
    const failed = planGeneratedImages([user('u'), tool('g', 'failed'), reply('m', `![参考](${url})`)]);
    assert.deepEqual(failed.generations[0].images, []);
    assert.equal(failed.omittedByMessage.has('m'), false);
    const done = planGeneratedImages([user('u'), tool('g'), reply('m', url)]);
    assert.equal(done.generations[0].images[0].url, url);
});
