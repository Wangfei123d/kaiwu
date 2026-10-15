import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../electron/agent/agent-runtime.js';
import { createDramaTextGenerator } from '../electron/drama/lib/text-generator.js';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('文本生成把准入后的图片交给独立 runtime，纯文本保持单参数', async () => {
    let listener;
    const calls = [];
    const generator = createDramaTextGenerator({ createRuntime: () => ({
        onEvent(fn) { listener = fn; },
        async send(...args) {
            calls.push(args);
            listener({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: '正文' } });
        },
        async dispose() {},
    }) });
    await generator({ images: [{ mimeType: 'IMAGE/PNG', bytes: png }] });
    await generator({});
    assert.deepEqual(calls[0][1], { images: [{ mimeType: 'image/png', bytes: png }] });
    assert.equal(calls[1].length, 1);
});

test('非法图片在创建文本 runtime 前拒绝', async () => {
    let created = 0;
    const generator = createDramaTextGenerator({ createRuntime: () => { created++; } });
    await assert.rejects(() => generator({ images: [{ mimeType: 'image/png', bytes: [1, 2] }] }), /字节不是/);
    assert.equal(created, 0);
});

test('独立会话只收助手正文，不收思考，且结束后释放', async () => {
    let listener;
    let sent;
    let disposed = false;
    const runtime = {
        onEvent(fn) { listener = fn; return () => {}; },
        async send(prompt) {
            sent = prompt;
            listener({ kind: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '内部想法' } } });
            listener({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一段' } } });
            listener({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: '第二段' }] } });
            return { stopReason: 'end_turn' };
        },
        async dispose() { disposed = true; },
    };
    const generator = createDramaTextGenerator({ createRuntime: () => runtime });
    const output = await generator({ source: '剧本内容', prompt: '续写' });
    assert.equal(output, '第一段第二段');
    assert.match(sent, /剧本内容/);
    assert.match(sent, /续写/);
    assert.equal(disposed, true);
});

test('模型试图申请工具权限时取消本轮，绝不返回半截文本', async () => {
    let listener;
    let cancelled = false;
    let disposed = false;
    const runtime = {
        onEvent(fn) { listener = fn; return () => {}; },
        async send() {
            listener({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { text: '半截' } } });
            listener({ kind: 'permission', requestId: 'p1' });
            return { stopReason: 'cancelled' };
        },
        async cancel() { cancelled = true; },
        async dispose() { disposed = true; },
    };
    const generator = createDramaTextGenerator({ createRuntime: () => runtime });
    await assert.rejects(() => generator({ source: 'x', prompt: 'y' }), /不允许执行工具/);
    assert.equal(cancelled, true);
    assert.equal(disposed, true);
});

test('文本生成通过真实 ACP 子进程链路收到助手文本，不依赖网络或密钥', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
    const generator = createDramaTextGenerator({
        createRuntime: () => createAgentRuntime({
            vaultRoot: () => process.cwd(),
            env: { ...process.env, KAIWU_AGENT_SCRIPT: fixture, KAIWU_AGENT_ARGS: '--echo-prompt' },
            appRoot: path.resolve(path.dirname(fixture), '..'),
            log: { warn() {}, error() {} },
            promptTimeoutMs: 20000,
        }),
    });
    try {
        const result = await generator({ source: '第一幕', prompt: '续写第二幕' });
        assert.equal(result, '回复0回复1回复2', '只收助手回复，不把夹具回显的用户提示混进结果');
    } finally {
        await generator.dispose();
    }
});
