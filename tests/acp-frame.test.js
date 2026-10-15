import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainLines, encodeMessage, parseMessage } from '../app/lib/acp-frame.js';

// ACP over stdio 是**按行分隔的 JSON-RPC**。分帧唯一的难点是:
// 管道给的是任意切分的字节块 —— 一条消息可能分几次到达,也可能一次到达好几条。
// "半条消息"是最难在真实环境里复现的情况,所以把它做成纯函数直接构造。

test('一次到达一条完整消息', () => {
    const r = drainLines('{"id":1}\n');
    assert.deepEqual(r.lines, ['{"id":1}']);
    assert.equal(r.rest, '');
});

test('半条消息留在 rest 里,不能当完整消息吐出去', () => {
    const r = drainLines('{"id":1,"resu');
    assert.deepEqual(r.lines, []);
    assert.equal(r.rest, '{"id":1,"resu');
});

test('半个 JSON 分两次到达时能拼回来', () => {
    const a = drainLines('{"id":1,"resu');
    const b = drainLines(a.rest + 'lt":"ok"}\n');
    assert.deepEqual(b.lines, ['{"id":1,"result":"ok"}']);
    assert.equal(b.rest, '');
});

test('一次到达多条', () => {
    const r = drainLines('{"a":1}\n{"b":2}\n{"c":3}\n');
    assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('空行被忽略(尾部换行不该产出一条空消息)', () => {
    const r = drainLines('{"a":1}\n\n\n');
    assert.deepEqual(r.lines, ['{"a":1}']);
    assert.equal(r.rest, '');
});

test('行首尾空白被去掉', () => {
    assert.deepEqual(drainLines('  {"a":1}  \n').lines, ['{"a":1}']);
});

test('encodeMessage 末尾必须带换行 —— 否则对端永远读不到这一条', () => {
    assert.equal(encodeMessage({ id: 1 }), '{"id":1}\n');
});

test('parseMessage 对坏输入返回 null 而不是抛错', () => {
    assert.equal(parseMessage('不是 JSON'), null);
    assert.equal(parseMessage('null'), null, 'JSON null 不是合法消息');
    assert.equal(parseMessage('42'), null, '标量不是合法消息');
    assert.deepEqual(parseMessage('{"id":1}'), { id: 1 });
});
