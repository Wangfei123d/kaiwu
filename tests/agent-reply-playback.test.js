import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyTextBuffer } from '../app/agent/reply-playback.js';

test('已接收正文暂存，推进显示前不公开未来文字；结束事件不会跳到全文', () => {
    const reply = new ReplyTextBuffer();
    const text = '第一段文字。\n\n'.repeat(160);
    reply.receive(text, false, 0);
    assert.equal(reply.text, '');
    reply.advance(16);
    assert.ok(reply.text.length > 0 && reply.text.length < text.length);
    const beforeEnd = reply.text;
    reply.receive(text, true, 20);
    assert.equal(reply.text, beforeEnd);
    for (let now = 32; now <= 2400; now += 16) reply.advance(now);
    assert.equal(reply.text, text, '长回复应快速排空，不增加逐行等待时间');
    assert.equal(reply.active, false);
});

test('低速输入时降低消耗速度，缓冲充足时加速；暂时无新字仍保持生成状态', () => {
    const slow = new ReplyTextBuffer();
    let source = '';
    for (let now = 0; now <= 800; now += 80) {
        source += '字符';
        slow.receive(source, false, now);
        slow.advance(now + 16);
    }
    const burst = new ReplyTextBuffer();
    burst.receive('快'.repeat(1000), false, 0);
    burst.advance(16);
    assert.ok(burst.rate > slow.rate * 2, '低库存应放缓，积压时应明显更快');
    for (let now = 832; now <= 1600; now += 16) slow.advance(now);
    assert.equal(slow.text, source);
    assert.equal(slow.pending, false);
    assert.equal(slow.active, true, '等待后续流式输入时扫光仍处于生成状态');
    slow.receive(source, true, 1616);
    assert.equal(slow.active, false);
});

test('分帧显示不会截断 Unicode 码点，补发与收尾不会重复或漏字', () => {
    const reply = new ReplyTextBuffer();
    const text = '你好😀，👩‍💻正在输出。\n**完成**';
    reply.receive(text, false, 0);
    for (let now = 16; now <= 500; now += 16) {
        reply.advance(now);
        assert.ok(text.startsWith(reply.text));
        assert.equal(/[\uD800-\uDBFF]$/.test(reply.text), false);
    }
    reply.receive(text + '新片段', true, 510);
    for (let now = 526; now <= 1500; now += 16) reply.advance(now);
    assert.equal(reply.text, text + '新片段');
});
