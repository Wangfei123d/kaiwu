import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSupervisor } from '../electron/agent/agent-supervisor.js';
import { createAcpClient } from '../electron/agent/acp-client.js';
import { isMissingCredentialError } from '../electron/agent/credentials.js';
import { METHODS } from '../app/lib/acp-protocol.js';
import { spawnFake } from './helpers/acp-fixture.js';

/**
 * 起一套真的"监护人 + 客户端",全部打在假 agent 上。
 *
 * `deps.createSupervisor` 只给"start() 拒绝"那条失败路径用:那条路径<b>本来就不该</b>
 * 靠真子进程来测(要制造一次真的 start() 拒绝,得先把假 agent 弄坏,既慢又不稳),
 * 换成一个只会拒绝的假监护人,测的就是 boot 的收尾责任本身。
 */
async function boot(deps = {}) {
    let client = null;
    const sup = (deps.createSupervisor ?? createAgentSupervisor)({
        spawnChild: () => spawnFake(),
        // 就绪判定要用到客户端,所以这里晚一步取 client
        handshake: (transport) => client.initialize({ name: 'kaiwu', version: '0.1.0' }),
    });
    client = createAcpClient({ transport: sup.transport });
    try {
        await sup.start();
    } catch (err) {
        // ⚠️ start() 从这里抛出时,调用方**永远拿不到 sup 的引用** —— 连"补一刀"都做不到,
        // 已经拉起来的那个子进程就留在了机器上(而它很可能正是"起不来"的病根)。
        // 收尾责任只能在 boot 内部:先收干净,再把原始错误原样抛出去。
        try { await sup.stop(); } catch { /* 收尾自己失败不许顶掉原始错误 */ }
        throw err;
    }
    return { sup, client };
}

test('握手拿到协议版本与 agentInfo', async () => {
    const { sup, client } = await boot();
    try {
        const r = await client.initialize({ name: 'kaiwu', version: '0.1.0' });
        assert.equal(r.protocolVersion, 1);
        assert.equal(r.agentInfo.name, 'fake-acp');
    } finally {
        await sup.stop();
    }
});

test('协议版本对不上时明确报错,而不是硬撑', async () => {
    const { sup, client } = await boot();
    try {
        await assert.rejects(
            () => client.initialize({ name: 'kaiwu', version: '0.1.0' }, { expectVersion: 99 }),
            /协议版本/);
    } finally {
        await sup.stop();
    }
});

test('建会话拿到 sessionId', async () => {
    const { sup, client } = await boot();
    try {
        const s = await client.newSession({ cwd: 'D:\\project' });
        assert.equal(s.sessionId, 'fake-session-1');
    } finally {
        await sup.stop();
    }
});

test('prompt 把流式增量交给 onUpdate,并回 stopReason', async () => {
    const { sup, client } = await boot();
    try {
        const s = await client.newSession({ cwd: '.' });
        const chunks = [];
        const r = await client.prompt({
            sessionId: s.sessionId,
            text: '你好',
            onUpdate: u => chunks.push(u),
        });
        assert.equal(r.stopReason, 'end_turn');
        assert.deepEqual(chunks.map(c => c.content.text), ['回复0', '回复1', '回复2']);
    } finally {
        await sup.stop();
    }
});

test('并发两个请求不会串线(请求 id 必须各自对上)', async () => {
    const { sup, client } = await boot();
    try {
        const [a, b] = await Promise.all([
            client.newSession({ cwd: '.' }),
            client.newSession({ cwd: '.' }),
        ]);
        // ⚠️ 夹具照真机:每次 session/new 回一个**新的**会话 id(第一次仍是 fake-session-1,
        //    见夹具里的 sessionSeq)。于是"哪个响应落在哪一次"可以直接断言 —— 串线就会
        //    把两次对上同一份(原来靠"两次都回同一个 id"表达这件事,那其实是个弱判据)。
        assert.equal(a.sessionId, 'fake-session-1');
        assert.equal(b.sessionId, 'fake-session-3');
    } finally {
        await sup.stop();
    }
});

test('对端回错误时 promise 拒绝,并且带上原始错误码', async () => {
    const { sup, client } = await boot();
    try {
        await assert.rejects(() => client.call('没这个方法', {}), /-32601|不认识/);
    } finally {
        await sup.stop();
    }
});

/**
 * 手写的假 transport —— 这里**故意不用假 agent 子进程**。
 * 假 agent 从来不发反向请求,也没法让我们精确地制造"对端请求的 id 正好撞上
 * 我们在飞请求的 id"这个瞬间;而这个瞬间正是要测的那个 bug。
 * 只需要 { send, onMessage } 两个方法,所以手写一个最小实现就够。
 */
function createFakeTransport({ sendResult = true } = {}) {
    const sent = [];
    let handler = null;
    const t = {
        sent,
        /**
         * 回执:默认 true(= 真的交出去了)。测试可以改成 false / undefined,
         * 分别模拟"写不进去的传输"和"压根不回回执的传输"。
         */
        sendResult,
        send(msg) { sent.push(msg); return t.sendResult; },
        onMessage(fn) { handler = fn; return () => { if (handler === fn) handler = null; } },
        /** 模拟"对端发来一条消息"(直接喂给客户端的 onMessage 回调)。 */
        deliver(msg) { handler?.(msg); },
    };
    return t;
}

test('对端请求的 id 撞上在飞请求的 id 时,它仍是请求,不会被当成我的响应吞掉', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    const handled = [];
    const offRequest = client.onRequest({
        // canHandle 收的是**方法名**(实现里是 h.canHandle(msg.method),与 brief 代码块一致)
        canHandle: method => method === 'session/request_permission',
        handle: (m) => { handled.push(m.method); return { outcome: 'allow' }; },
    });

    try {
        const outgoing = client.call('session/new', { cwd: '.' });
        let settled = null;
        outgoing.then(v => { settled = { value: v }; }, e => { settled = { error: e }; });
        const id = transport.sent[0].id;

        // JSON-RPC 的 id 空间是**分方向**的:对端用自己的计数器,撞上我们的 id 很正常。
        transport.deliver({
            jsonrpc: '2.0', id,
            method: 'session/request_permission',
            params: { sessionId: 's1', toolCall: {} },
        });
        await new Promise(r => setImmediate(r));    // 让 handler 的 promise 链跑完

        assert.deepEqual(handled, ['session/request_permission']);  // 反向请求被派发
        assert.equal(settled, null);                                // 我们的请求还在等,没被"回答"
        assert.deepEqual(transport.sent[1], { jsonrpc: '2.0', id, result: { outcome: 'allow' } });

        // 收尾:真正的响应到了,在飞请求照常 resolve(不留下悬着的 promise)
        transport.deliver({ jsonrpc: '2.0', id, result: { sessionId: 'fake-session-1' } });
        const r = await outgoing;
        assert.equal(r.sessionId, 'fake-session-1');
    } finally {
        offRequest();
        client.dispose();
    }
});

/**
 * 等一个"本该被拒绝"的 promise,但**设上限**。
 * 这个 bug 的表现恰恰是"永远不落地":直接 await 的话,它一旦回归就把整个测试进程
 * 挂死(刚才 RED 阶段就真的挂死了),而挂死远不如一条失败断言好查。
 */
async function rejectionOf(promise, ms = 2000) {
    const TIMEOUT = Symbol('timeout');
    let timer = null;
    const outcome = await Promise.race([
        promise.then(value => ({ value }), error => ({ error })),
        new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), ms); }),
    ]);
    if (timer !== null) clearTimeout(timer);
    assert.notEqual(outcome, TIMEOUT, `在飞请求 ${ms}ms 内没有被拒绝(仍然挂着)`);
    assert.ok(outcome.error instanceof Error,
        `必须以 Error 拒绝,实际却 resolve 成了:${JSON.stringify(outcome.value)}`);
    return outcome.error;
}

test('failPending 让在飞的 call 以给定原因拒绝,而不是永远挂着', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        const inFlight = client.call('session/new', {});
        client.failPending('Agent 进程崩了');

        assert.match((await rejectionOf(inFlight)).message, /Agent 进程崩了/);
    } finally {
        client.dispose();
    }
});

test('failPending 让在飞的 prompt 拒绝,而不是永远转圈', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        const inFlight = client.prompt({ sessionId: 's1', text: '你好' });
        client.failPending('Agent 进程崩了');

        assert.match((await rejectionOf(inFlight)).message, /Agent 进程崩了/);
    } finally {
        client.dispose();
    }
});

test('dispose 会把在飞请求一并拒绝,不留永不落地的等待者', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    const inFlight = client.call('session/new', {});
    client.dispose();

    assert.match((await rejectionOf(inFlight)).message, /dispose/);
});

test('failPending 幂等:重复调用、没有在飞请求都不抛', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        client.failPending('空表');                       // 一条在飞请求都没有

        const inFlight = client.call('session/new', {});
        client.failPending('第一次');
        client.failPending('第二次');                     // 表已经清空,不许抛

        assert.match((await rejectionOf(inFlight)).message, /第一次/);
        client.dispose();                                 // dispose 再叫一次也不许抛
    } finally {
        client.dispose();
    }
});

// ---------------------------------------------------------------------------
// 以下两组用例都**故意不起子进程**(继续用手写 transport):它们要制造的是
// "传输写不进去"和"应用层的 handler 自己炸了"这两个瞬间,真子进程做不出来。
// ---------------------------------------------------------------------------

test('transport.send 报 false 时立刻拒绝:这个请求永远不会有人回答', async () => {
    // 回执就是为这个消费者存在的(见 agent-supervisor 的 transport.send 注释):
    // false = 消息根本没交出去 = 响应永远不会来。等下去就是界面上一个永远不停的转圈。
    const transport = createFakeTransport({ sendResult: false });
    const client = createAcpClient({ transport });
    try {
        const err = await rejectionOf(client.call('session/new', {}));
        assert.match(err.message, /没发出去/);
        assert.match(err.message, /session\/new/);        // 顺手说清是哪一个请求
    } finally {
        client.dispose();
    }
});

test('transport.send 不回回执(undefined)时按"发出去了"处理,只有明确的 false 才算没交出去', async () => {
    // 只认 false 是一个**选择**:不回回执的传输(手写的假传输、将来别的实现)不能被判死,
    // 否则每一条请求都会在发出后立刻失败。这条用例把选择钉住。
    const transport = createFakeTransport({ sendResult: undefined });
    const client = createAcpClient({ transport });
    try {
        const inFlight = client.call('session/new', {});
        transport.deliver({ jsonrpc: '2.0', id: transport.sent[0].id, result: { sessionId: 's1' } });
        assert.equal((await inFlight).sessionId, 's1');
    } finally {
        client.dispose();
    }
});

test('handler 同步抛错也要给对端回 -32603,不能让对端的请求永远悬着', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    const off = client.onRequest({
        canHandle: method => method === 'session/request_permission',
        handle: () => { throw new Error('权限卡片自己炸了'); },   // 同步抛,不是 reject
    });
    try {
        transport.deliver({
            jsonrpc: '2.0', id: 7,
            method: 'session/request_permission',
            params: { sessionId: 's1', toolCall: {} },
        });
        await new Promise(r => setImmediate(r));                  // 让 promise 链跑完

        assert.equal(transport.sent.length, 1);
        assert.equal(transport.sent[0].error.code, -32603);
        assert.match(transport.sent[0].error.message, /权限卡片自己炸了/);
    } finally {
        off();
        client.dispose();
    }
});

test('canHandle 抛错只当"接不了",既不逃出去也不牵连后面的 handler', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    const seen = [];
    const offBad = client.onRequest({
        canHandle: () => { throw new Error('这个 handler 坏了'); },
        handle: () => { seen.push('bad'); return {}; },
    });
    const offGood = client.onRequest({
        canHandle: method => method === 'session/request_permission',
        handle: () => { seen.push('good'); return { outcome: 'allow' }; },
    });
    try {
        transport.deliver({
            jsonrpc: '2.0', id: 3,
            method: 'session/request_permission',
            params: { sessionId: 's1', toolCall: {} },
        });
        await new Promise(r => setImmediate(r));

        assert.deepEqual(seen, ['good']);                         // 坏的那个当接不了,好的照常接
        assert.deepEqual(transport.sent.at(-1),
            { jsonrpc: '2.0', id: 3, result: { outcome: 'allow' } });
    } finally {
        offBad();
        offGood();
        client.dispose();
    }
});

test('failPending 不给原因时也有说得通的默认理由,不会拼出 undefined', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        const inFlight = client.call('session/new', {});
        client.failPending();                                     // 故意的:调用方忘了传原因
        const err = await rejectionOf(inFlight);

        assert.doesNotMatch(err.message, /undefined/);
        assert.match(err.message, /session\/new/);                // 至少要说清它在等哪一个方法
    } finally {
        client.dispose();
    }
});

test('每个在飞请求各自拿到一个 Error,并且点名自己在等哪个方法', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        const a = client.call('session/new', {});
        const b = client.prompt({ sessionId: 's1', text: '你好' });
        client.failPending('Agent 进程崩了');

        const [ea, eb] = await Promise.all([rejectionOf(a), rejectionOf(b)]);
        // 共用一个 Error 实例时堆栈只指向 failPending,崩溃现场分不清是谁挂了。
        assert.notEqual(ea, eb);
        assert.match(ea.message, /session\/new/);
        assert.match(eb.message, /session\/prompt/);
    } finally {
        client.dispose();
    }
});

test('发到线上的方法名就是 acp-protocol.METHODS 的值,常量表与实现不许漂移', async () => {
    // 这条钉的是"单一事实来源":客户端曾经把 'session/new' 这类字面量又抄了一遍,
    // 而 METHODS 一个使用者都没有。谁改了常量表或实现,这里立刻红。
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        const inits = client.initialize({ name: 'kaiwu', version: '0.1.0' });
        const session = client.newSession({ cwd: '.' });
        const updates = [];
        const prompt = client.prompt({
            sessionId: 's1', text: '你好', onUpdate: u => updates.push(u),
        });

        assert.deepEqual(transport.sent.map(m => m.method),
            [METHODS.INITIALIZE, METHODS.SESSION_NEW, METHODS.SESSION_PROMPT]);

        // session/update 是"通知方向"的方法名:客户端靠它过滤流式增量
        transport.deliver({
            jsonrpc: '2.0', method: METHODS.SESSION_UPDATE,
            params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } },
        });
        assert.equal(updates.length, 1);

        // 收尾:三条响应都送回去,不留悬着的 promise
        transport.deliver({ jsonrpc: '2.0', id: transport.sent[0].id, result: { protocolVersion: 1, agentInfo: { name: 'x' } } });
        transport.deliver({ jsonrpc: '2.0', id: transport.sent[1].id, result: { sessionId: 's1' } });
        transport.deliver({ jsonrpc: '2.0', id: transport.sent[2].id, result: { stopReason: 'end_turn' } });
        await inits;
        await session;
        await prompt;
    } finally {
        client.dispose();
    }
});

test('prompt 撞上 -32603 no API key 时,错误能被 isMissingCredentialError 认出来', async () => {
    // 真实流程(实测):initialize OK → session/new OK → prompt 报 -32603 no API key,
    // 而监护人**仍然是 ready**。这条把"客户端产出的错误形状"与"凭证判定"接在一起:
    // 客户端必须原样带上 code,判定才可能成立 —— 一边改了另一边立刻红。
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        const inFlight = client.prompt({ sessionId: 's1', text: '你好' });
        transport.deliver({
            jsonrpc: '2.0', id: transport.sent[0].id,
            error: { code: -32603, message: 'no API key configured' },
        });

        const err = await rejectionOf(inFlight);
        assert.equal(err.code, -32603, '客户端必须把对端的原始错误码原样带上');
        assert.equal(isMissingCredentialError(err), true);
    } finally {
        client.dispose();
    }
});

test('dispose 之后再 call 立刻拒绝:不许再登记进 pending,那是一条永远不会被回答的请求', async () => {
    // dispose() 已经 off() 了,响应再也不可能回来。而 call() 旧实现照常
    // pending.set 并把请求写出去 —— 对调用方就是一个永远挂着的 promise。
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    client.dispose();

    const err = await rejectionOf(client.call('session/new', {}));
    assert.match(err.message, /dispose/);
    assert.equal(transport.sent.length, 0, '已经释放了,不许再往传输上写任何东西');
});

test('dispose 之后的 initialize / newSession / prompt 也一并拒绝(它们都是 call 的门面)', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    client.dispose();

    assert.match((await rejectionOf(client.initialize({ name: 'kaiwu', version: '0.1.0' }))).message,
        /dispose/);
    assert.match((await rejectionOf(client.newSession({ cwd: '.' }))).message, /dispose/);
    assert.match((await rejectionOf(client.prompt({ sessionId: 's1', text: '你好' }))).message,
        /dispose/);
    assert.equal(transport.sent.length, 0, '一条都不许发出去');
});

test('boot 在 sup.start() 拒绝时也会把监护人收掉,不留孤儿进程', async () => {
    let stopped = 0;
    let leaked = null;                       // 万一 boot 真的返回了(补丁没生效),兜底收掉
    const fakeSup = {
        transport: { send: () => true, onMessage: () => () => {} },
        start: () => Promise.reject(new Error('起不来')),
        stop: async () => { stopped += 1; },
    };
    try {
        await assert.rejects(
            async () => { leaked = await boot({ createSupervisor: () => fakeSup }); },
            /起不来/);
        assert.equal(stopped, 1, 'start() 拒绝后必须把监护人停掉,否则子进程没人收');
    } finally {
        await leaked?.sup?.stop();
    }
});

// ---------- 黏贴截图:线上那一段 ----------
//
// 桥的 decodeImage(dsh-acp/lib/index.js)只认三件事:mimeType 在白名单里、
// data 是**规范化** base64、以及 `data.toString('base64') === block.data`。
// 所以这一段必须在**真传输上**断言,而不是只看一个本地拼好的数组。

test('带图片的 prompt:文本块在前、图片块在后,而且是规范化 base64', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    try {
        const inFlight = client.prompt({
            sessionId: 's1',
            text: '看这张图',
            images: [{ mimeType: 'image/png', bytes }],
        });
        transport.deliver({ jsonrpc: '2.0', id: transport.sent[0].id, result: { stopReason: 'end_turn' } });
        await inFlight;

        const params = transport.sent[0].params;
        assert.equal(transport.sent[0].method, METHODS.SESSION_PROMPT);
        assert.deepEqual(params.prompt.map(b => b.type), ['text', 'image']);
        assert.deepEqual(params.prompt[0], { type: 'text', text: '看这张图' });
        assert.equal(params.prompt[1].mimeType, 'image/png');
        assert.equal(params.prompt[1].data, Buffer.from(bytes).toString('base64'));
        // 桥会逐字比对规范 base64:换行/URL-safe 别名一律被它当场拒掉。
        assert.match(params.prompt[1].data,
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    } finally {
        client.dispose();
    }
});

test('纯文本的 prompt 与从前逐字节相同(黏贴截图不许把老路改坏)', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        const inFlight = client.prompt({ sessionId: 's1', text: '你好' });
        transport.deliver({ jsonrpc: '2.0', id: transport.sent[0].id, result: { stopReason: 'end_turn' } });
        await inFlight;
        assert.deepEqual(transport.sent[0].params.prompt, [{ type: 'text', text: '你好' }]);
    } finally {
        client.dispose();
    }
});

test('只发图片(没有文字)时线上只有图片块 —— 空文本块不许发出去', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    try {
        const inFlight = client.prompt({ sessionId: 's1', text: '', images: [{ mimeType: 'image/gif', bytes }] });
        transport.deliver({ jsonrpc: '2.0', id: transport.sent[0].id, result: { stopReason: 'end_turn' } });
        await inFlight;
        assert.deepEqual(transport.sent[0].params.prompt.map(b => b.type), ['image']);
    } finally {
        client.dispose();
    }
});

test('图片不合法时**当场拒绝**,一条请求都不往传输上写', async () => {
    const transport = createFakeTransport();
    const client = createAcpClient({ transport });
    try {
        const err = await rejectionOf(client.prompt({
            sessionId: 's1',
            text: '看',
            images: [{ mimeType: 'image/png', bytes: new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]) }],
        }));
        assert.match(err.message, /字节不是 PNG/);
        assert.equal(transport.sent.length, 0,
            '不该先把一个注定被桥拒掉的请求写出去(那会留下一条 -32602 的往返)');
    } finally {
        client.dispose();
    }
});

