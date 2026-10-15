import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnFake } from './helpers/acp-fixture.js';
import { drainLines, encodeMessage } from '../app/lib/acp-frame.js';

/**
 * 给一个 promise 设上限。夹具出问题时(不回、不退)必须变成一条**失败断言**,
 * 而不是让整个 `node --test` 挂死 —— 挂死远比一条失败难查。
 */
function withTimeout(promise, ms, what) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${what}(超过 ${ms}ms)`)), ms);
        }),
    ]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

/** 起一个假 agent,返回一个 request() 与收集到的通知。 */
function launch(args = []) {
    const child = spawnFake(args);
    let buf = '';
    const pending = new Map();
    const notes = [];

    child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        const { lines, rest } = drainLines(buf);
        buf = rest;
        for (const line of lines) {
            const m = JSON.parse(line);
            if (m.id !== undefined && pending.has(m.id)) {
                const { resolve, timer } = pending.get(m.id);
                clearTimeout(timer);
                pending.delete(m.id);
                resolve(m);
            } else {
                notes.push(m);
            }
        }
    });

    // 进程死了之后仍可能有人往 stdin 写(见下面"死了就不回答"那条用例):
    // 没有 'error' 监听器时,EPIPE 会变成未捕获异常把整个测试进程带走。
    child.stdin.on('error', () => {});

    let nextId = 1;
    /**
     * 发一条请求。**超时必须拒绝** —— 以前它 resolve 成 `{timeout:true}`,
     * 调用方紧接着读 `r.result.xxx` 就是 "Cannot read properties of undefined":
     * 一条夹具回归被伪装成了一条毫不相干的 TypeError。拒绝消息里点名方法,
     * 让现场直接说出"是谁没被回答"。
     */
    const request = (method, params, timeoutMs = 5000) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`假 agent 在 ${timeoutMs}ms 内没有回答 ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    });

    return { child, request, notes };
}

test('假 agent 能完成握手与建会话', async () => {
    const a = launch();
    try {
        const init = await a.request('initialize', { protocolVersion: 1 });
        assert.equal(init.result.protocolVersion, 1);
        assert.equal(init.result.agentInfo.name, 'fake-acp');

        const s = await a.request('session/new', { cwd: '.', mcpServers: [] });
        assert.equal(s.result.sessionId, 'fake-session-1');
    } finally {
        a.child.kill();
    }
});

test('session/prompt 会先流出增量通知,再回 stopReason', async () => {
    const a = launch();
    try {
        await a.request('initialize', { protocolVersion: 1 });
        const r = await a.request('session/prompt', {
            sessionId: 'fake-session-1',
            prompt: [{ type: 'text', text: '你好' }],
        });
        assert.equal(r.result.stopReason, 'end_turn');

        const chunks = a.notes
            .filter(n => n.method === 'session/update')
            .map(n => n.params.update.content.text);
        assert.deepEqual(chunks, ['回复0', '回复1', '回复2']);
    } finally {
        a.child.kill();
    }
});

test('未知方法回 JSON-RPC 错误而不是静默', async () => {
    const a = launch();
    try {
        const r = await a.request('没这个方法', {});
        assert.equal(r.error.code, -32601);
    } finally {
        a.child.kill();
    }
});

test('--crash-after 会在处理完第 n 条请求后退出(用来测退避重启)', async () => {
    const a = launch(['--crash-after', '1']);
    try {
        const exited = new Promise(res => a.child.once('exit', (code) => res(code)));
        await a.request('initialize', { protocolVersion: 1 });
        // 退出是异步的,而且夹具一旦哪天不退了,这里必须**有界**地失败 ——
        // 无上限的 await 会把整个 node --test 挂死。
        assert.equal(await withTimeout(exited, 5000, '假 agent 处理完第 1 条后没有退出'), 3,
            '第 1 条之后应当以退出码 3 结束');
    } finally {
        a.child.kill();          // 万一它没退:也不许把子进程留在机器上
    }
});

test('退出等待有上限:夹具不退时是一条失败断言,而不是把整个测试挂死', async () => {
    // --crash-after 0 等于"永远不崩" —— 用它确定性地演一遍"夹具不再退出"。
    const a = launch(['--crash-after', '0']);
    try {
        const exited = new Promise(res => a.child.once('exit', (code) => res(code)));
        await a.request('initialize', { protocolVersion: 1 });
        await assert.rejects(withTimeout(exited, 150, '假 agent 没有退出'), /没有退出/);
    } finally {
        a.child.kill();
    }
});

test('请求超时以拒绝收场,且消息点名是哪个方法(不许 resolve 成 undefined 形状)', async () => {
    // 进程已经死了,这一条永远不会有人回答 —— 超时那条路由此变成确定性的。
    // 旧实现 resolve {timeout:true},调用方读 r.result 就是
    // "Cannot read properties of undefined":夹具回归被伪装成不相干的 TypeError。
    const a = launch(['--crash-after', '1']);
    try {
        const exited = new Promise(res => a.child.once('exit', (code) => res(code)));
        await a.request('initialize', { protocolVersion: 1 });
        assert.equal(await withTimeout(exited, 5000, '假 agent 没有按 --crash-after 退出'), 3);

        await assert.rejects(
            () => a.request('session/prompt', { sessionId: 'fake-session-1' }, 150),
            /session\/prompt/);
    } finally {
        a.child.kill();
    }
});

/** 收上来的通知(notes)是**异步**到的:等它出现,但有上限,不许把测试挂死。 */
async function waitForNote(a, pred, ms = 4000, what = '夹具没有发出预期的通知') {
    const deadline = Date.now() + ms;
    for (;;) {
        const found = a.notes.find(pred);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(what);
        await new Promise(res => setTimeout(res, 10));
    }
}

test('--echo-prompt:把收到的提示原文回显一条 user_message_chunk(自检据此断言上下文真的发出去了)', async () => {
    // "会话绑定当前笔记"如果只断言界面上画了什么,那和"真的发出去了"是两回事。
    // 夹具把收到的原文回显出来,自检才能断言发出去的内容。
    const a = launch(['--echo-prompt']);
    try {
        await a.request('initialize', { protocolVersion: 1 });
        await a.request('session/prompt', {
            sessionId: 'fake-session-1',
            prompt: [{ type: 'text', text: '当前笔记:甲篇.md\n\n# 甲篇\n\n正文' }],
        });
        const echo = a.notes.find(n => n.method === 'session/update'
            && n.params.update.sessionUpdate === 'user_message_chunk');
        assert.ok(echo, '必须回显一条 user_message_chunk');
        assert.equal(echo.params.update.content.text, '当前笔记:甲篇.md\n\n# 甲篇\n\n正文');

        // 多段 prompt 要拼在一起(ACP 的 prompt 是数组)
        const b = launch(['--echo-prompt']);
        try {
            await b.request('initialize', { protocolVersion: 1 });
            await b.request('session/prompt', {
                sessionId: 'fake-session-1',
                prompt: [{ type: 'text', text: '前半' }, { type: 'text', text: '后半' }],
            });
            const e2 = b.notes.find(n => n.method === 'session/update'
                && n.params.update.sessionUpdate === 'user_message_chunk');
            assert.equal(e2.params.update.content.text, '前半后半');
        } finally {
            b.child.kill();
        }
    } finally {
        a.child.kill();
    }
});

test('--tool-call:先建卡片再更新,两条通知指向同一条 toolCallId', async () => {
    // M3 的工具卡片就靠这个契约:UI 必须按 toolCallId 更新**同一条**卡片,
    // 而不是每来一条 update 就新画一张(那样一次读文件会在界面上堆出三个块)。
    const a = launch(['--tool-call']);
    try {
        await a.request('initialize', { protocolVersion: 1 });
        const r = await a.request('session/prompt', {
            sessionId: 'fake-session-1',
            prompt: [{ type: 'text', text: '你好' }],
        });
        assert.equal(r.result.stopReason, 'end_turn', '响应仍必须在所有通知之后');

        const updates = a.notes
            .filter(n => n.method === 'session/update')
            .map(n => n.params.update);
        assert.deepEqual(updates.map(u => u.sessionUpdate),
            ['tool_call', 'tool_call_update',
                'agent_message_chunk', 'agent_message_chunk', 'agent_message_chunk']);

        assert.equal(updates[0].toolCallId, 'call-1');
        assert.equal(updates[0].status, 'pending');
        assert.equal(updates[0].title, 'read 甲篇.md');
        assert.equal(updates[1].toolCallId, 'call-1', '更新必须落在同一条卡片上');
        assert.equal(updates[1].status, 'completed');
    } finally {
        a.child.kill();
    }
});

test('--permission:反向请求必须等到客户端回答,回答的内容会回显成最后一条增量', async () => {
    // 这条钉住两件事:①客户端**不回答**时 prompt 不许收尾(否则权限卡片只是装饰);
    // ②回答真的到达了对端 —— 用回显增量来证,而不是只看界面画了张卡。
    const a = launch(['--permission', '--tool-call']);
    try {
        await a.request('initialize', { protocolVersion: 1 });
        const promptP = a.request('session/prompt', {
            sessionId: 'fake-session-1',
            prompt: [{ type: 'text', text: '跑一下 git status' }],
        });
        // 失败路径上也不许留下未处理的拒绝
        promptP.catch(() => {});

        const req = await waitForNote(a, n => n.method === 'session/request_permission');
        assert.equal(req.id, 900001, '反向请求的 id 一眼能看出是反向的');
        assert.equal(req.params.toolCall.title, '运行命令:git status');
        assert.deepEqual(req.params.options.map(o => o.optionId), ['allow-once', 'reject-once']);

        const early = await Promise.race([
            promptP.then(() => 'done', () => 'failed'),
            new Promise(res => setTimeout(() => res('pending'), 200)),
        ]);
        assert.equal(early, 'pending', '还没回答反向请求,就不许回 prompt 的响应');

        a.child.stdin.write(encodeMessage({
            jsonrpc: '2.0',
            id: req.id,
            result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
        }));

        const r = await withTimeout(promptP, 4000, '回答之后 prompt 仍没有收尾');
        assert.equal(r.result.stopReason, 'end_turn');

        const texts = a.notes
            .filter(n => n.method === 'session/update')
            .map(n => n.params.update.content?.text)
            .filter(t => typeof t === 'string');
        assert.deepEqual(texts, ['回复0', '回复1', '回复2', '权限结果:allow-once'],
            '用户点的那个选项必须真的到了 agent 那一侧');
    } finally {
        a.child.kill();
    }
});
