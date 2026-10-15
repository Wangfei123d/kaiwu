import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { assertPidDetail, createAgentSupervisor } from '../electron/agent/agent-supervisor.js';
import { encodeMessage } from '../app/lib/acp-frame.js';
import { spawnFake as spawnFakeProcess } from './helpers/acp-fixture.js';

// 监护人注入的是**工厂**(每次调用起一个新进程),不是进程本身
const spawnFake = (args = []) => () => spawnFakeProcess(args);

/**
 * 一个**不真的起进程**的假子进程:用来构造"进程边界上的坏情况"
 * (迟到的 exit、写 stdin 撞上进程已死、被切开的字节块)。
 * 真进程做不到确定性复现 —— 那些时序全由操作系统调度决定。
 */
function makeFakeChild(pid, { autoExitOnKill = true } = {}) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    // kill 之后**异步**发 exit,和真进程一样 —— stop() 要等这个事件。
    // autoExitOnKill=false 用来模拟"已经下手杀了、但 exit 还没到"的那个窗口。
    child.kill = () => {
        if (!autoExitOnKill) return;
        setImmediate(() => child.emit('exit', 0, null));
    };
    return child;
}

/** 让出事件循环,等假子进程身上的异步事件落地。 */
const tick = () => new Promise((r) => setImmediate(r));

/** 轮询到条件成立(有界,失败时由调用方的断言报错,不会挂死)。 */
async function until(pred, tries = 200) {
    for (let i = 0; i < tries && !pred(); i++) await tick();
    return pred();
}

/**
 * 把 start() 的结局**当场接住**:返回 {value} 或 {error},永不挂起、也永不产生
 * 未处理拒绝。C2 之后 start() 会拒绝,而测试往往要过好几个 await 才检查它,
 * 中间那段空档足以让 Node 报 unhandledRejection —— 所以一律先接住再断言。
 */
const settle = (promise) => promise.then(value => ({ value }), error => ({ error }));

/**
 * C2 的契约:一次 start() 只要**没就绪**,就必须以 Error 拒绝,而不是
 * resolve 一个 {state:'failed'|'crashed'|'stopping'} 的快照让调用方自己记得判。
 */
async function expectNotReady(promise, re) {
    const outcome = await settle(promise);
    assert.ok(outcome.error instanceof Error,
        `非就绪的 start() 必须以 Error 拒绝,实际却 resolve 了:${JSON.stringify(outcome.value)}`);
    if (re !== undefined) assert.match(outcome.error.message, re);
    return outcome.error;
}

/** 真实的握手:发 initialize,等它的响应。 */
function makeHandshake() {
    return (transport) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('握手超时')), 5000);
        const off = transport.onMessage((msg) => {
            if (msg.id === 'h1') {
                clearTimeout(timer);
                off();
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            }
        });
        transport.send({ jsonrpc: '2.0', id: 'h1', method: 'initialize', params: { protocolVersion: 1 } });
    });
}

/** 退避用的假定时器:手动放行,测试不用真的等 500ms、1s、2s。
 *  ⚠️ clearTimeout 必须真的把条目摘掉 —— 否则"start() 用完就清掉握手超时"
 *  这个行为测不出来,后面断言 queued.length 的用例会假失败。
 *  sticky:true 反过来模拟"清除没生效"(定时器已经在执行队列里,清不掉了),
 *  用来验证回调**自己**的身份校验能独立挡住复活。 */
function fakeTimers({ sticky = false } = {}) {
    const queued = [];
    let seq = 0;
    return {
        queued,
        setTimeout: (fn, ms) => { const h = ++seq; queued.push({ fn, ms, h }); return h; },
        clearTimeout: (h) => {
            if (sticky) return;                  // 故意不摘:条目会照常到点
            const i = queued.findIndex(j => j.h === h);
            if (i !== -1) queued.splice(i, 1);
        },
        async flushNext() {
            const job = queued.shift();
            if (!job) throw new Error('没有排队的定时器');
            await job.fn();
            return job.ms;
        },
    };
}

test('start() 走完握手才变成 ready(不是"进程活着就算就绪")', async () => {
    const sup = createAgentSupervisor({ spawnChild: spawnFake(), handshake: makeHandshake() });
    try {
        assert.equal(sup.status().state, 'stopped');
        const st = await sup.start();
        assert.equal(st.state, 'ready');
        assert.ok(st.pid > 0, '应当拿到子进程 pid');
        assert.equal(st.error, null);
    } finally {
        await sup.stop();
    }
});

test('握手失败进 failed,而不是假装 ready', async () => {
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(),
        handshake: async () => { throw new Error('协议版本不匹配'); },
    });
    try {
        // C2:非就绪不再 resolve 成一个 {state:'failed'} 快照,而是拒绝 ——
        // 调用方不可能"漏判一次"就把 failed 当成了连上了。
        await expectNotReady(sup.start(), /state=failed/);
        // 快照本身照旧能读(界面/日志要用它),只是它不再是 start() 的返回值。
        assert.equal(sup.status().state, 'failed');
        assert.match(sup.status().error, /协议版本不匹配/);
    } finally {
        await sup.stop();
    }
});

test('握手挂住时超时进 failed,而不是永远不返回', async () => {
    // 这条守的是一个**真实写出来过的 bug**:超时计时器创建后立刻被 clearTimeout 掉,
    // 于是超时永远不触发,握手挂住时 start() 永远不返回、界面永远停在"连接中"。
    const timers = fakeTimers();
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(),
        handshake: () => new Promise(() => {}),      // 永远不 resolve
        timers,
        handshakeTimeoutMs: 1234,
    });
    try {
        const pending = sup.start();
        const rejected = expectNotReady(pending, /state=failed/);   // 先接住,别漏成未处理拒绝
        for (let i = 0; i < 100 && timers.queued.length === 0; i++) {
            await new Promise(r => setTimeout(r, 5));
        }
        assert.equal(timers.queued[0]?.ms, 1234, '超时必须真的被排上');
        await timers.flushNext();
        assert.match((await rejected).message, /握手超时/);
        assert.equal(sup.status().state, 'failed');
    } finally {
        await sup.stop();
    }
});

test('握手失败要把**子进程最后说的话**一起报出来(上一次排查一小时就因为它一个字没留)', async () => {
    // 现场:`[agent] 握手超时(20000ms)` 之后再无任何线索 —— 子进程其实在 stderr 上
    // 打过一句、在 stdout 上可能也答过,但那些字节当时没进任何报告。
    // 现在:失败原因里带最后两行(它会进面板那张提示卡),完整尾巴进日志。
    const timers = fakeTimers();
    const warns = [];
    const child = makeFakeChild(4242);
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: () => new Promise(() => {}),
        timers,
        handshakeTimeoutMs: 1000,
        log: { warn: (...a) => warns.push(a.join(' ')) },
    });
    try {
        const pending = sup.start();
        const rejected = expectNotReady(pending, /state=failed/);
        await until(() => child.stdin.listenerCount('error') > 0);   // 等 doStart 把监听器都挂上
        // 子进程说两句(一句 stderr、一句 stdout 上的协议消息),然后一直不回答
        child.stderr.write('[kaiwu] dsh 入口 = D:/x/bin.js\n引擎自己吐的最后一句\n');
        child.stdout.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'session/update', params: {} }) + '\n');
        await until(() => warns.some((w) => /引擎自己吐的最后一句/.test(w)));
        for (let i = 0; i < 100 && timers.queued.length === 0; i++) await tick();
        await timers.flushNext();

        const err = await rejected;
        assert.match(err.message, /握手超时\(1000ms\)/);
        assert.match(err.message, /子进程最后输出/);
        assert.match(err.message, /引擎自己吐的最后一句/, '最后一句往往就是原因,必须进错误消息');
        assert.match(err.message, /← \{/, '握手期间收到的 stdout 也要留档:否则"答了但没认出来"看不出来');
        // 完整尾巴(不止两行)进日志:排查的人要的是原文
        const joined = warns.join('\n');
        assert.match(joined, /--- 子进程最后输出 ---/);
        assert.match(joined, /\[kaiwu\] dsh 入口/, '环形缓冲里的更早几行也要一起打出来');
    } finally {
        await sup.stop();
    }
});

test('能收到子进程发来的通知(onMessage)', async () => {
    const sup = createAgentSupervisor({ spawnChild: spawnFake(), handshake: makeHandshake() });
    try {
        await sup.start();
        const got = [];
        sup.onMessage(m => got.push(m));
        sup.transport.send({
            jsonrpc: '2.0', id: 7, method: 'session/prompt',
            params: { sessionId: 's', prompt: [] },
        });
        // 等流式通知到达
        for (let i = 0; i < 50 && got.filter(m => m.method === 'session/update').length < 3; i++) {
            await new Promise(r => setTimeout(r, 20));
        }
        const chunks = got.filter(m => m.method === 'session/update');
        assert.equal(chunks.length, 3);
        assert.equal(chunks[0].params.update.content.text, '回复0');
    } finally {
        await sup.stop();
    }
});

test('非预期退出进 crashed,并按退避重启', async () => {
    const timers = fakeTimers();
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(['--crash-after', '1']),
        handshake: makeHandshake(),
        timers,
        baseDelayMs: 500,
        log: { warn() {} },              // 这条会打印"后重启(第 N 次)",别让它混进测试输出
    });
    try {
        await sup.start();
        // 让假 agent 崩掉
        for (let i = 0; i < 100 && sup.status().state !== 'crashed'; i++) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.equal(sup.status().state, 'crashed');
        assert.match(sup.status().error, /意外退出/);

        assert.equal(timers.queued.length, 1, '应当排了一次重启');
        assert.equal(timers.queued[0].ms, 500, '第一次退避是 baseDelayMs');
    } finally {
        await sup.stop();
    }
});

test('连续崩溃到上限后进 failed,不再无限重启', async () => {
    const timers = fakeTimers();
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(['--crash-after', '1']),
        handshake: makeHandshake(),
        timers,
        maxRestarts: 2,
        baseDelayMs: 10,
        log: { warn() {} },              // 这条会打印三次"后重启(第 N 次)",别让它混进测试输出
    });
    try {
        await sup.start();
        for (let round = 0; round < 3; round++) {
            for (let i = 0; i < 100 && sup.status().state !== 'crashed'
                && sup.status().state !== 'failed'; i++) {
                await new Promise(r => setTimeout(r, 20));
            }
            if (sup.status().state === 'failed') break;
            await timers.flushNext();
            // ⚠️ 这里**不再**补一句手动 await sup.start():flushNext 已经触发了那一轮
            // 自动重启,而 C2 之后"在飞时再 start()"会把那次重启的结局交回来 ——
            // 假 agent 处理完第 1 条就退出,那一轮随时可能以 crashed 收场,
            // 于是这条用例会去断言一个与"熔断"无关的拒绝。熔断本身由下面的
            // status() 断言看着,不需要这次手动拉起。
        }
        assert.equal(sup.status().state, 'failed');
        assert.match(sup.status().error, /不再自动重启/);
    } finally {
        await sup.stop();
    }
});

test('stop() 之后是 stopped,且手动停不会被当成崩溃去重启', async () => {
    const timers = fakeTimers();
    const sup = createAgentSupervisor({ spawnChild: spawnFake(), handshake: makeHandshake(), timers });
    // finally 兜底:断言若失败,也不能把一个真的 fake-acp-agent 子进程留在机器上。
    try {
        await sup.start();
        await sup.stop();
        assert.equal(sup.status().state, 'stopped');
        assert.equal(sup.status().pid, null);
        assert.equal(timers.queued.length, 0, '用户主动停不该排重启');
    } finally {
        await sup.stop();
    }
});

test('stop() 走的是杀整棵树(留下孤儿 Agent 是真实故障)', async () => {
    const killed = [];
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(),
        handshake: makeHandshake(),
        killTree: (pid) => killed.push(pid),
    });
    let st = null;
    try {
        st = await sup.start();
        await sup.stop();
        assert.deepEqual(killed, [st.pid], '必须把真实 pid 交给 killTree');
    } finally {
        await sup.stop();
    }
});

test('stderr 进环形缓冲,且不会无限涨', async () => {
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(['--noisy-stderr']),
        handshake: makeHandshake(),
        log: { warn() {} },              // 这条会灌 20 行,别让它淹掉测试输出
        logRingSize: 5,
    });
    try {
        await sup.start();
        for (let i = 0; i < 100 && sup.logs().length < 5; i++) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.equal(sup.logs().length, 5, '环形缓冲的上限必须生效');
        assert.match(sup.logs().at(-1), /第 20 行/, '留下的是最新的几行');
    } finally {
        await sup.stop();
    }
});

test('status() 只吐出可 JSON 化的叶子字段(不要把子进程对象漏出去)', async () => {
    const sup = createAgentSupervisor({ spawnChild: spawnFake(), handshake: makeHandshake() });
    try {
        await sup.start();
        const st = sup.status();
        assert.deepEqual(Object.keys(st).sort(), ['error', 'pid', 'restarts', 'since', 'state']);
        assert.doesNotThrow(() => JSON.stringify(st));
    } finally {
        await sup.stop();
    }
});

// ---------------------------------------------------------------------------
// 复核修复:attempt 身份 / stdin 的 error 与发送回执 / 逐块 UTF-8 / 稳定窗口
// ---------------------------------------------------------------------------

test('握手失败后立刻重试:上一轮迟到的 exit 不能把新进程抹掉(那会留下孤儿)', async () => {
    // 守的是评审追出来的那条链:握手失败 → catch 里杀了 A 但**没等它的 exit** →
    // 调用方马上重试拉起 B → A 的 exit 这时才到。
    // 旧实现的 handleExit 闭包认的是模块级 child(= B),于是 B 被置空、被标成 crashed:
    // B 明明活着却再没人认得它 —— send() 写进虚空、stop() 走 child === null 的早退。
    // 那就是一个**孤儿进程**,正是这个任务存在的意义所要防的故障。
    const a = makeFakeChild(1111, { autoExitOnKill: false });   // A 被杀但 exit 还在路上
    const b = makeFakeChild(2222);
    const kids = [a, b];
    let calls = 0;
    const timers = fakeTimers();
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {
            calls += 1;
            if (calls === 1) throw new Error('协议版本不匹配');
        },
        killTree: () => {},                  // pid 是编出来的,绝不能真去 taskkill
        timers,
        baseDelayMs: 500,
        log: { warn() {} },
    });
    try {
        // C2:非就绪一律拒绝 —— 这里第一步就是"握手失败",所以必须 reject 而不是 resolve。
        await expectNotReady(sup.start(), /state=failed/);
        const st = await sup.start();        // 用户立刻重试
        assert.equal(st.state, 'ready');
        assert.equal(st.pid, b.pid);

        a.emit('exit', 1, null);             // A 现在才真的退出

        assert.equal(sup.status().state, 'ready', 'B 还活着,状态机不该被 A 的 exit 带走');
        assert.equal(sup.status().pid, b.pid, 'pid 必须还是 B 的');
        assert.equal(sup.transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }), true,
            'B 仍在跟踪中:消息必须还能真的发出去');
        assert.equal(timers.queued.filter((j) => j.ms === 500).length, 0,
            'B 没崩,不该排任何重启');
    } finally {
        await sup.stop();
    }
});

test('握手还没回来进程就退出了:不许返回假 ready(否则排好的重启会被 ready 早退吞掉)', async () => {
    // 真实成因:Node 可能**在 stdout 排空前**就先发 exit,于是 handleExit 在
    // state 还是 'starting' 时就把进程记成 crashed、排好重启;紧接着 initialize 的
    // 响应到了,旧实现无条件把状态改回 ready —— 那次重启随后撞上 start() 开头的
    // "state === 'ready' 就早退",被**静默丢弃**。监护人从此停在
    // state: 'ready' 而 pid: null,没有任何事件能纠正它。
    const a = makeFakeChild(1111);
    const b = makeFakeChild(2222);
    const kids = [a, b];
    const timers = fakeTimers();
    let resolveHandshake = null;
    let calls = 0;
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: () => {
            calls += 1;
            if (calls === 1) return new Promise((r) => { resolveHandshake = r; });
            return Promise.resolve();
        },
        killTree: () => {},
        timers,
        baseDelayMs: 500,
        log: { warn() {} },
    });
    try {
        const pending = sup.start();
        const rejected = expectNotReady(pending, /state=crashed/);   // 先接住这次拒绝
        await until(() => resolveHandshake !== null);

        a.emit('exit', 1, null);                       // 进程先死了
        assert.equal(sup.status().state, 'crashed');

        resolveHandshake({ protocolVersion: 1 });      // 迟到的握手响应
        // 死进程不能算 ready:这次 start() 必须失败,而不是交回一个假就绪快照。
        // 拒绝消息里两件事都要有:登记在案的原始原因(意外退出)与这次 start()
        // 自己的上下文(握手回来时进程已经没了)。
        const diedMsg = (await rejected).message;
        assert.match(diedMsg, /意外退出/);
        assert.match(diedMsg, /已经退出或被换掉了/);
        assert.equal(timers.queued.filter((j) => j.ms === 500).length, 1,
            '排好的那次重启必须还在,不能被吞掉');

        await timers.flushNext();                      // 放行重启
        assert.equal(await until(() => sup.status().state === 'ready'), true,
            '重启必须真的把监护人带回就绪');
        assert.equal(sup.status().pid, b.pid);
    } finally {
        await sup.stop();
    }
});

test('连接过程中 stop():在飞的 start() 不能把 stopped 复活成 ready/failed', async () => {
    const a = makeFakeChild(1111);
    const timers = fakeTimers();
    let resolveHandshake = null;
    const sup = createAgentSupervisor({
        spawnChild: () => a,
        handshake: () => new Promise((r) => { resolveHandshake = r; }),
        killTree: () => {},
        timers,
        handshakeTimeoutMs: 9999,
        log: { warn() {} },
    });
    const pending = sup.start();
    const rejected = expectNotReady(pending, /state=stopping|state=stopped/);  // 先接住
    await until(() => resolveHandshake !== null);

    const stopping = sup.stop();                   // 用户按下"停"
    assert.equal(timers.queued.length, 0, 'stop() 必须把在飞的握手超时也摘掉,不能留到超时后复活状态');

    resolveHandshake({ protocolVersion: 1 });      // 握手"这才"回来
    const err = await rejected;
    await stopping;

    // 这次 start() 已经作废,但**不许**把别人的状态名冒充成自己的结论:
    // 既不能说成 ready,也不能说成 failed(那会把一次正常的停止误报成失败)。
    assert.doesNotMatch(err.message, /state=ready/, 'stop() 之后 start() 不许再给出 ready');
    assert.doesNotMatch(err.message, /state=failed/, '已经作废的握手不该再判成 failed');
    assert.equal(sup.status().state, 'stopped');
});

test('子进程 stdin 的 error 不会变成未捕获异常(Electron 主进程里那会带走整个应用)', async () => {
    const child = makeFakeChild(1111);
    const warnings = [];
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: async () => {},          // 不牵扯真协议,只测进程边界
        killTree: () => {},
        log: { warn: (...a) => warnings.push(a.map(String).join(' ')) },
    });
    try {
        await sup.start();
        // 没有 'error' 监听器时,EventEmitter 会在 emit 的**当下**把错误抛出来 ——
        // 所以这条断言是确定性的,不用等异步。
        assert.doesNotThrow(() => child.stdin.emit('error', new Error('write EPIPE')));
        assert.ok(warnings.some((w) => /EPIPE/.test(w)), '至少要留下一条日志,不能静默');
    } finally {
        await sup.stop();
    }
});

test('transport.send 必须回执"到底发出去没有"(Task 4 靠它知道响应永远不会来)', async () => {
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(),
        handshake: makeHandshake(),
        log: { warn() {} },                  // 丢消息时会 warn,别让它混进测试输出
    });
    try {
        await sup.start();
        assert.equal(sup.transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }), true);
    } finally {
        await sup.stop();
    }
    // 停完之后 stdin 已经没了:必须明确回 false,而不是静默丢弃
    assert.equal(sup.transport.send({ jsonrpc: '2.0', id: 2, method: 'x' }), false);
});

test('stdout 上被切断的多字节字符不会被解成 U+FFFD(这里的载荷几乎全是中文)', async () => {
    const child = makeFakeChild(1111);
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        await sup.start();
        const got = [];
        sup.onMessage((m) => got.push(m));
        const line = Buffer.from(encodeMessage({
            jsonrpc: '2.0', id: 9, method: 'session/update',
            params: { update: { content: { text: '中文回复' } } },
        }), 'utf8');
        // 在**一个汉字的三个字节中间**切开:逐块 toString('utf8') 会把两半各自解成
        // U+FFFD —— 不抛错、JSON 也照样能解析,只是"中文回复"被悄悄改成了"��文回复"。
        const cut = line.indexOf(Buffer.from('中')) + 1;
        child.stdout.write(line.subarray(0, cut));
        child.stdout.write(line.subarray(cut));

        assert.equal(await until(() => got.length > 0), true, '切开的两块必须拼回一条完整消息');
        assert.equal(got[0].params.update.content.text, '中文回复');
    } finally {
        await sup.stop();
    }
});

test('稳定运行满 readyStabilityMs 就清零 restarts:散在几天里的崩溃不该累加成熔断', async () => {
    const a = makeFakeChild(1111);
    const b = makeFakeChild(2222);
    const kids = [a, b];
    const timers = fakeTimers();
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {},
        killTree: () => {},
        timers,
        maxRestarts: 2,
        baseDelayMs: 500,
        readyStabilityMs: 60000,
        log: { warn() {} },
    });
    try {
        assert.equal((await sup.start()).state, 'ready');

        a.emit('exit', 1, null);                        // 第 1 次崩
        assert.equal(sup.status().restarts, 1);

        await timers.flushNext();                       // 放行自动重启
        assert.equal(await until(() => sup.status().state === 'ready'), true);
        assert.equal(sup.status().restarts, 1, '刚起来还没稳住,计数不能清');

        // 稳定窗口到点(注入的假定时器,不用真睡 60 秒)
        assert.equal(timers.queued.length, 1, 'ready 之后应当挂上稳定窗口定时器');
        assert.equal(timers.queued[0].ms, 60000);
        await timers.flushNext();
        assert.equal(sup.status().restarts, 0, '稳过 readyStabilityMs 就是"不连续"了');

        b.emit('exit', 1, null);                        // 稳定之后又崩一次
        assert.equal(sup.status().state, 'crashed', '清零之后不该直接熔断成 failed');
        assert.equal(sup.status().restarts, 1);
    } finally {
        await sup.stop();
    }
});

test('stop() 会摘掉稳定窗口定时器:停止之后不许再有定时器偷偷改计数', async () => {
    const a = makeFakeChild(1111);
    const b = makeFakeChild(2222);
    const kids = [a, b];
    const timers = fakeTimers();
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {},
        killTree: () => {},
        timers,
        baseDelayMs: 500,
        readyStabilityMs: 60000,
        log: { warn() {} },
    });
    try {
        await sup.start();
        assert.equal(timers.queued.length, 1, 'ready 之后应当挂上稳定窗口定时器');

        a.emit('exit', 1, null);
        await timers.flushNext();
        assert.equal(await until(() => sup.status().state === 'ready'), true);
        assert.equal(sup.status().restarts, 1);

        assert.equal(timers.queued.length, 1, '这一轮应该挂着稳定窗口定时器');
        await sup.stop();
        assert.equal(timers.queued.length, 0, '停止时稳定窗口定时器必须被摘掉,不能泄漏');
        assert.equal(sup.status().state, 'stopped');
        assert.equal(sup.status().restarts, 1, '停止后计数不再被悄悄改动');
    } finally {
        await sup.stop();                    // 幂等兜底
    }
});

// ---------------------------------------------------------------------------
// 二轮复核修复:stop() ↔ start() 的身份对账 / 退避定时器不许泄漏 /
// 分帧状态必须**属于某一次 attempt**(外加 stderr 的对称解码)
// ---------------------------------------------------------------------------

test('stop() 还在等 exit 时 start():不许起新进程,更不许把活进程报成 stopped', async () => {
    // 评审探针的确定性版本:sup.stop()(不 await)紧接着 sup.start()。
    // 旧实现里 start() 只对 ready/starting 早退,于是真的起了 B 并握手完成;
    // 而 stop() 的 await 醒来后无条件写 stopped —— B 活着、stdin 可写、
    // transport.send() 回 true,status() 却报 {"state":"stopped","pid":B},
    // 而且 stop() 从此走 "没有活着的进程" 的早退,再也停不掉 B。
    const a = makeFakeChild(1111, { autoExitOnKill: false });   // 杀了,但 exit 还在路上
    const b = makeFakeChild(2222);
    const kids = [a, b];
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        assert.equal((await sup.start()).state, 'ready');

        const stopping = sup.stop();                 // 用户按停(不 await:还在等 exit)
        assert.equal(sup.status().state, 'stopping');

        // C2:旧契约会 resolve 一个 {state:'stopping'} 快照;现在这次 start() 必须拒绝
        // (而且不能偷偷起一个新进程 —— 见下面的 kids.length 断言)。
        await expectNotReady(sup.start(), /state=stopping|state=stopped/);
        assert.equal(sup.status().state, 'stopping', '旧的 stop 还没走完,这次 start() 不该起新进程');
        assert.equal(sup.status().pid, null);
        assert.equal(sup.transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }), false,
            '没有活着的子进程时 send() 必须回 false,不能写进一个"不存在"的 stdin');

        a.emit('exit', 0, null);                     // 旧 stop 终于等到 exit
        await stopping;

        assert.equal(sup.status().state, 'stopped');
        assert.equal(sup.status().pid, null, 'stopped 就意味着没有活着的子进程');
        assert.equal(kids.length, 1, 'B 根本不该被拉起来');
    } finally {
        await sup.stop();
    }
});

test('旧退避定时器不许泄漏:两轮崩溃之后 stop() 必须把它们全清掉', async () => {
    // 评审的另一半:scheduleRestart 挂新把手时不清旧的。手动 start() 顶掉一轮重启后,
    // 旧把手还躺在队列里,而 stop() 只清得掉最新那一个 —— 漏网的那个到点会
    // start({autoRestart:true}),把用户刚停掉的 agent 又拉起来。
    const timers = fakeTimers();
    const a = makeFakeChild(1111);
    const b = makeFakeChild(2222);
    const c = makeFakeChild(3333);
    const kids = [a, b, c];
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {},
        killTree: () => {},
        timers,
        baseDelayMs: 500,
        readyStabilityMs: 60000,
        log: { warn() {} },
    });
    try {
        await sup.start();                           // A 就绪
        a.emit('exit', 1, null);                     // A 崩 → 排下第一次退避
        assert.equal(sup.status().state, 'crashed');
        assert.equal(timers.queued.filter((j) => j.ms === 500).length, 1);

        assert.equal((await sup.start()).state, 'ready');   // 用户不等了,手动拉起 B

        b.emit('exit', 1, null);                     // B 也崩 → 又排一次退避
        // 旧实现:restartTimer 被新把手覆盖,旧的那个没人清 —— 队列里同时躺着两次退避。
        assert.equal(timers.queued.filter((j) => j.ms === 500).length, 1,
            '同一时刻只该有一次待放行的退避,旧把手必须先摘掉');

        await sup.stop();
        assert.equal(sup.status().state, 'stopped');
        assert.equal(timers.queued.length, 0, 'stop() 之后不许再有任何排队的定时器');

        // 就算有一个漏网的退避到点了(比如 clearTimeout 没生效),它也必须是**死的**:
        // 到点后拉起进程 = 用户停完又被复活。
        while (timers.queued.length > 0) await timers.flushNext();
        assert.equal(sup.status().state, 'stopped', '被撤销的退避到点也不许再拉起进程');
        assert.equal(sup.status().pid, null);
        assert.equal(kids.length, 1, 'C 根本不该被拉起来');
    } finally {
        await sup.stop();
    }
});

test('被换掉的旧进程迟到的 stdout 不许拼进新进程的分帧流', async () => {
    // 评审探针:A 的 exit 之后 Node 仍会把管道里剩下的 stdout 排空出来,而
    // B 的 start() 已经 reset 过分帧状态了。旧实现两个处理器共用一份模块级 buffer,
    // 于是 A 的前半条 + B 的后半条正好拼成一条**完整假消息**发给监听者。
    const timers = fakeTimers();
    const a = makeFakeChild(1111);
    const b = makeFakeChild(2222);
    const kids = [a, b];
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {},
        killTree: () => {},
        timers,
        baseDelayMs: 500,
        log: { warn() {} },
    });
    try {
        await sup.start();
        const got = [];
        sup.onMessage((m) => got.push(m));

        a.emit('exit', 1, null);                     // A 走了
        assert.equal(sup.status().state, 'crashed');
        assert.equal((await sup.start()).state, 'ready');   // 换成 B

        const line = Buffer.from(
            encodeMessage({ jsonrpc: '2.0', id: 42, method: 'stale/from/A' }), 'utf8');
        const cut = Math.floor(line.length / 2);
        a.stdout.write(line.subarray(0, cut));       // 前半条:A 自己的缓冲
        await tick();
        b.stdout.write(line.subarray(cut));          // 后半条:B 的缓冲
        for (let i = 0; i < 5; i++) await tick();

        assert.deepEqual(got, [], '两个半条分属两个进程,不许拼成一条完整消息');
    } finally {
        await sup.stop();
    }
});

test('stderr 上被切断的多字节字符不会被解成 U+FFFD(日志几乎全是中文)', async () => {
    // 与 stdout 对称:逐块 String(d) 会把切断的汉字解成 U+FFFD,
    // 而这个应用的日志同样几乎全是中文。
    const child = makeFakeChild(1111);
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        await sup.start();
        const line = Buffer.from('这一行日志被切开了\n', 'utf8');
        const cut = line.indexOf(Buffer.from('这')) + 1;   // 在「这」的三个字节中间切
        child.stderr.write(line.subarray(0, cut));
        await tick();
        child.stderr.write(line.subarray(cut));

        assert.equal(await until(() => sup.logs().length > 0), true, 'stderr 必须进环形缓冲');
        assert.deepEqual(sup.logs(), ['这一行日志被切开了']);
    } finally {
        await sup.stop();
    }
});

test('被撤销的退避到点也不许复活 agent(即使 clearTimeout 没生效)', async () => {
    // scheduleRestart 先摘旧把手是第一道闸;回调**自己**的身份校验是第二道。
    // 这条把第一道拆掉(sticky 定时器:clearTimeout 摘不掉条目,假装它已经在
    // 执行队列里了),单测第二道 —— 少了它,用户停完的 agent 会被那个到点的
    // 回调重新拉起来。
    const timers = fakeTimers({ sticky: true });
    const a = makeFakeChild(1111);
    const c = makeFakeChild(3333);
    const kids = [a, c];
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {},
        killTree: () => {},
        timers,
        baseDelayMs: 500,
        readyStabilityMs: 60000,
        log: { warn() {} },
    });
    try {
        await sup.start();                           // A 就绪
        a.emit('exit', 1, null);                     // A 崩 → 排下一次退避
        assert.equal(sup.status().state, 'crashed');
        assert.equal(timers.queued.filter((j) => j.ms === 500).length, 1);

        await sup.stop();
        assert.equal(sup.status().state, 'stopped');

        // 清除没生效:这些定时器照常到点,必须靠回调自己的世代/把手校验挡住。
        while (timers.queued.length > 0) await timers.flushNext();

        assert.equal(sup.status().state, 'stopped', '被撤销的退避到点也不许再拉起进程');
        assert.equal(sup.status().pid, null);
        assert.equal(kids.length, 1, '停止之后不许再起进程');
    } finally {
        await sup.stop();
    }
});

// ---------------------------------------------------------------------------
// 三轮复核修复:spawn 失败必须收场 / 重入 stop() 不许把 stopping 焊死 /
// stderr 也按行分帧
// ---------------------------------------------------------------------------

test('子进程自身的 error 不许变成未捕获异常,且必须落进 failed(不是崩溃重启)', async () => {
    // 真实 ChildProcess 在进程**根本没起来**(ENOENT/EACCES/EMFILE)时,是往
    // **自己身上**发 'error'。没有监听器时 EventEmitter 会把它当场抛成未捕获异常 ——
    // 在 Electron 主进程里那和 stdin 的 EPIPE 是同一类故障,能把整个应用带走。
    const child = makeFakeChild(1111);
    const timers = fakeTimers();
    const warnings = [];
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: () => new Promise(() => {}),      // 进程起不来,握手永远不会回来
        killTree: () => {},
        timers,
        log: { warn: (...a) => warnings.push(a.map(String).join(' ')) },
    });
    try {
        const pending = sup.start();
        const rejected = expectNotReady(pending, /state=failed/);   // 先接住
        // 没有 'error' 监听器时,EventEmitter 会在 emit 的**当下**把错误抛出来 ——
        // 所以这条断言是确定性的,不用等异步。
        assert.doesNotThrow(() => child.emit('error', new Error('spawn ENOENT')));

        // 也不许挂到握手超时:C2 之后"没就绪"必须 reject。
        assert.match((await rejected).message, /ENOENT/);
        assert.equal(sup.status().state, 'failed');
        assert.match(sup.status().error, /ENOENT/);
        assert.ok(warnings.some((w) => /ENOENT/.test(w)), '至少要留下一条日志,不能静默');
        assert.equal(sup.status().pid, null, '起不来的进程不该还报一个 pid');
        assert.equal(timers.queued.length, 0, '起不来不是"崩了":不许排退避重启');
    } finally {
        await sup.stop();
    }
});

test('spawnChild 自己抛错时:start() 落进 failed,不许把状态焊死在 starting', async () => {
    // 包装层校验证书/路径,或者 spawn 直接 EPERM 时,工厂会在 start() 的同步段里抛。
    // 旧实现把它整个漏出去:start() reject,而 state 永远停在 'starting' ——
    // 于是 start() 开头那道 state === 'starting' 的早退会把**之后每一次** start()
    // 都静默拒绝,监护人从此再也拉不起来,只有 stop() 解得开。
    let calls = 0;
    const sup = createAgentSupervisor({
        spawnChild: () => { calls += 1; throw new Error('EPERM: 二进制没有执行权限'); },
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        // C2:非就绪一律拒绝。这条守的是"工厂抛错必须落进 failed",而拒绝本身
        // 就是"没连上"的唯一表达 —— 快照照旧在 status() 里可读。
        const err = await expectNotReady(sup.start(), /state=failed/);
        assert.match(err.message, /EPERM/);
        assert.equal(sup.status().state, 'failed');

        await expectNotReady(sup.start(), /state=failed/);   // 下一次 start() 必须真的再试一次
        assert.equal(calls, 2, '两次 start() 就该尝试起两次进程');
    } finally {
        await sup.stop();
    }
});

test('starting 通知里重入 stop():不许留下一个"活着却再也拉不起来"的子进程', async () => {
    // 评审追出来的那条链:从 failed 再 start() 时,上一轮被杀掉的 attempt 仍是 current
    // (它的 exit 还挂在半路)。若 'starting' 通知是**同步**发的,监听者在这一刻调
    // stop(),就会赶在 ++generation / spawnChild 之前 —— stop() 一路 bump 世代、
    // 走 dying !== null 的路径;start() 回来却照常 spawn 并 current = attempt。
    // 结果:state 停在 stopping、stopping 永远是 true、新进程活着却没人认得,
    // 只有再按一次 stop() 才解得开 —— 而它正是用户要停的那个进程。
    const a = makeFakeChild(1111);                  // 握手失败那一轮:被杀,exit 很快到
    const b = makeFakeChild(2222);
    const c = makeFakeChild(3333);
    const kids = [a, b, c];
    let calls = 0;
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {
            calls += 1;
            if (calls === 1) throw new Error('协议版本不匹配');   // A 失败
        },
        killTree: () => {},
        log: { warn() {} },
    });
    let reentrant = null;
    let off = () => {};
    try {
        await expectNotReady(sup.start(), /state=failed/);
        assert.equal(sup.status().pid, a.pid, '失败那一轮的 attempt 此刻仍是 current');

        // 监听者在**这一次** start() 的 'starting' 通知里按停。
        off = sup.onStateChange((snap) => {
            if (snap.state === 'starting' && reentrant === null) reentrant = sup.stop();
        });
        const retry = sup.start();
        // 这次 start() 会被重入的 stop() 作废:C2 之后它必须拒绝,而不是
        // resolve 成一个 {state:'stopping'} 的快照让调用方以为连上了。
        const retryRejected = expectNotReady(retry, /state=stopping|state=stopped/);
        assert.equal(await until(() => reentrant !== null), true, '"starting" 通知必须真的发出来');
        await retryRejected;
        await reentrant;

        assert.equal(await until(() => sup.status().state === 'stopped'), true,
            '用户按了停:状态必须真的落到 stopped,不能焊死在 stopping');
        assert.equal(sup.transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }), false,
            '按停之后不许还留着一个活着却没人管的子进程');
        off();

        // 闸门没有被焊死:下一次 start() 必须真的能拉起进程。
        const again = await sup.start();
        assert.equal(again.state, 'ready');
        assert.equal(again.pid, c.pid);
    } finally {
        off();
        await sup.stop();
    }
});

test('stderr 也按行分帧:一条日志被切成两块不许变成两条', async () => {
    // stdout 有 drainLines,stderr 却是"逐块 split('\n') 就 push" ——
    // 一条被管道切开的日志会变成好几条,logs() 的"最近 logRingSize 行"契约就破了。
    const child = makeFakeChild(1111);
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        await sup.start();
        child.stderr.write('前半行');
        await tick();                      // 两次独立的 'data' 事件
        child.stderr.write('后半行\n');

        assert.equal(await until(() => sup.logs().length > 0), true);
        await tick();
        assert.deepEqual(sup.logs(), ['前半行后半行'], '同一条行被切开也只是一行');
    } finally {
        await sup.stop();
    }
});

test('最后一行 stderr 没有换行结尾时,进程退出也必须把它记下来', async () => {
    // 按行分帧的代价:没有结尾换行的那一行会一直压在缓冲里。而崩掉的 Agent 的
    // 最后一行往往正是崩溃原因 —— 不能因为"没换行"就把它一起丢掉。
    const child = makeFakeChild(1111);
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: async () => {},
        killTree: () => {},
        timers: fakeTimers(),
        log: { warn() {} },
    });
    try {
        await sup.start();
        child.stderr.write('崩之前的最后一句没有换行');
        assert.equal(await until(() => sup.logs().length > 0), false,
            '没有换行就还没成"一行",不算进环形缓冲');

        child.emit('exit', 1, null);       // 进程走了
        assert.equal(await until(() => sup.logs().length > 0), true, '退出时必须把残行补记下来');
        assert.deepEqual(sup.logs(), ['崩之前的最后一句没有换行']);
    } finally {
        await sup.stop();
    }
});

// ---------------------------------------------------------------------------
// 四轮复核修复(C1/C2):状态通知必须点名"这次转换是关于哪个进程的",
// 且 start() 不许把"没就绪"当成成功
// ---------------------------------------------------------------------------

test('stopped 转换必须告诉监听者停的是哪个 pid(快照 = 转换时刻,不是投递时刻)', async () => {
    // 终审 C1:快照是在 setState 里现推的,而通知要到微任务才投递 ——
    // 那一刻 stop() 早就把 current 摘成 null 了,于是 'stopped' 永远带着 pid:null。
    // 靠这些事件推进 UI 的界面根本说不出"停的是哪个进程"。
    const child = makeFakeChild(4321);
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    const seen = [];
    const off = sup.onStateChange((snap) => seen.push(snap));
    try {
        await sup.start();
        await sup.stop();

        const stopping = seen.find(s => s.state === 'stopping');
        const stopped = seen.find(s => s.state === 'stopped');
        assert.equal(stopping.pid, 4321, 'stopping 也必须点名它正在停谁');
        assert.equal(stopped.pid, 4321, 'stopped 通知必须带上被停掉的那个 pid');
        // 这条和上面**不矛盾**,它正是契约的另一半:投递时再调一次 status(),
        // 进程已经摘掉了 —— 通知是转换时刻的快照,status() 是当下的事实。
        assert.equal(sup.status().pid, null, 'status() 是投递时刻的样子,进程已经摘掉了');
    } finally {
        off();
        await sup.stop();
    }
});

test('crashed 转换点名的是"崩掉的那个进程",不是投递时已经变空的世界', async () => {
    // C1 的另一半:'crashed' 现在也在清掉 current **之后**才 setState,
    // 现推的话 pid 同样是 null —— 但这次转换明明是关于那个刚死掉的进程的。
    const child = makeFakeChild(2468);
    const sup = createAgentSupervisor({
        spawnChild: () => child,
        handshake: async () => {},
        killTree: () => {},
        timers: fakeTimers(),
        baseDelayMs: 500,
        log: { warn() {} },
    });
    const seen = [];
    const off = sup.onStateChange((snap) => seen.push(snap));
    try {
        await sup.start();
        child.emit('exit', 1, null);
        // 通知是微任务投递的,等它真的到监听者手里(有界等待,失败时由断言报错)
        assert.equal(await until(() => seen.some(s => s.state === 'crashed')), true,
            '"crashed" 通知必须发出来');

        const crashed = seen.find(s => s.state === 'crashed');
        assert.equal(crashed.pid, 2468, '崩溃通知必须点名是哪个进程崩的(哪怕它已经死了)');
        assert.equal(sup.status().pid, null);
        assert.equal(sup.status().state, 'crashed');
    } finally {
        off();
        await sup.stop();
    }
});

test('并发的第二次 start() 必须等第一次的结局,不许把"正在连"当成连上了', async () => {
    // 终审 C2:第二次 start() 以前会立刻返回一个 {state:'starting'} 的在飞快照 ——
    // 调用方看到它 resolve 了,以为连上了,转身就 newSession() 进一个即将 failed 的监护人。
    // 现在它必须**等第一次的结局**。
    const a = makeFakeChild(1111);
    let resolveHandshake = null;
    const sup = createAgentSupervisor({
        spawnChild: () => a,
        handshake: () => new Promise((r) => { resolveHandshake = r; }),
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        const first = sup.start();
        await until(() => resolveHandshake !== null);

        const second = sup.start();
        let settled = false;
        const secondOutcome = second.then(
            (value) => { settled = true; return { value }; },
            (error) => { settled = true; return { error }; });

        await tick();
        await tick();
        assert.equal(settled, false, '在飞的第一次还没结束,第二次 start() 不许先落定');
        assert.equal(sup.status().state, 'starting');

        resolveHandshake({ protocolVersion: 1 });
        const firstSt = await first;
        const secondRes = await secondOutcome;

        assert.equal(firstSt.state, 'ready');
        assert.equal(secondRes.value?.state, 'ready', '第二次必须拿到"真的就绪",而不是在飞快照');
        assert.equal(secondRes.value?.pid, a.pid, '而且要说清是哪一个进程就绪了');
        assert.equal(sup.status().state, 'ready');
    } finally {
        await sup.stop();
    }
});

test('在飞的第一次 start() 失败时,并发的那次也必须失败(不许各自 resolution 成 starting)', async () => {
    const a = makeFakeChild(1111);
    let rejectHandshake = null;
    const sup = createAgentSupervisor({
        spawnChild: () => a,
        handshake: () => new Promise((_r, rej) => { rejectHandshake = rej; }),
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        const first = sup.start();
        await until(() => rejectHandshake !== null);
        const second = sup.start();
        const secondOutcome = settle(second);

        rejectHandshake(new Error('协议版本不匹配'));
        await expectNotReady(first, /state=failed/);
        const secondRes = await secondOutcome;
        assert.ok(secondRes.error instanceof Error,
            '第一次失败时第二次也必须失败,不能 resolve 成在飞快照');
        assert.match(secondRes.error.message, /state=failed/);
    } finally {
        await sup.stop();
    }
});

test('start() 非就绪时抛出的 Error 必须点名 state 与原因(拿不到快照也能诊断)', async () => {
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(),
        handshake: async () => { throw new Error('协议版本不匹配'); },
        log: { warn() {} },
    });
    try {
        const err = await expectNotReady(sup.start(), /state=failed/);
        assert.match(err.message, /协议版本不匹配/, '光有 state 不够,原始原因也得带上');
        // 快照还在 status() 里,界面照旧能读它
        assert.equal(sup.status().state, 'failed');
        assert.match(sup.status().error, /协议版本不匹配/);
    } finally {
        await sup.stop();
    }
});

test('stop() 进行中再 start():直接拒绝,而不是给出一个 {state:stopping} 当成功', async () => {
    const a = makeFakeChild(1111, { autoExitOnKill: false });   // 扣住 exit:stop() 会停在 stopping
    const b = makeFakeChild(2222);
    const kids = [a, b];
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        assert.equal((await sup.start()).state, 'ready');
        const stopping = sup.stop();

        await expectNotReady(sup.start(), /state=stopping|state=stopped/);
        assert.equal(sup.status().pid, null);
        assert.equal(sup.transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }), false);

        a.emit('exit', 0, null);
        await stopping;
        assert.equal(sup.status().state, 'stopped');
        assert.equal(kids.length, 1, '拒绝本身不许偷偷起一个新进程');
    } finally {
        await sup.stop();
    }
});

test('start() 拒绝时错误上必须带机器可读的 state 与快照(别逼调用方去匹配中文散文)', async () => {
    const sup = createAgentSupervisor({
        spawnChild: spawnFake(),
        handshake: async () => { throw new Error('协议版本不匹配'); },
        log: { warn() {} },
    });
    try {
        // 中文消息照旧要有:人看日志靠它。
        const err = await expectNotReady(sup.start(), /state=failed/);
        // 但这不够 —— 下一个计划要**分支**在 state 上,而不是去正则匹配中国话。
        assert.equal(err.state, 'failed', 'err.state 必须能直接拿来比较');
        assert.ok(err.snapshot, 'err.snapshot 必须是那一刻的状态快照');
        assert.equal(err.snapshot.state, 'failed');
        assert.match(err.snapshot.error, /协议版本不匹配/, '快照里的原因也是原样带着的');
        assert.deepEqual(Object.keys(err.snapshot).sort(),
            ['error', 'pid', 'restarts', 'since', 'state'],
            '快照只许是叶子字段(和 status() 同一个形状),不许夹带活对象');
        assert.doesNotThrow(() => JSON.stringify(err.snapshot));
        assert.match(err.message, /协议版本不匹配/);
    } finally {
        await sup.stop();
    }
});

test('start() 的同步段里被注入的依赖重入 start():不许起第二个进程(否则那是个 stop() 够不到的孤儿)', async () => {
    // doStart 的同步段(state='starting' → spawnChild() → current=attempt)跑在
    // start() 里"先调 doStart、后赋 inFlightStart"**之间**。spawnChild 与 handshake
    // 都是**注入**的代码(监护人的契约就是 `() => ChildProcess` / `(transport) => Promise`),
    // 它们完全可以在这一刻回调 start():此时 state 已是 'starting',而 inFlightStart
    // 还是 null —— 旧实现从这条缝里**落进新一轮 doStart**,于是 B 被真的拉起来,
    // 而 current 只记得后一个,另一个成了 stop() 再也够不到的活进程。
    const a = makeFakeChild(1111);
    const b = makeFakeChild(2222);
    const kids = [a, b];
    const spawned = [];
    let sup = null;
    let reentrant = null;
    sup = createAgentSupervisor({
        spawnChild: () => {
            const child = kids.shift();
            spawned.push(child);
            // 就趁"state 已是 starting、inFlightStart 还是 null"的那一瞬间重入。
            if (child === a) reentrant = sup.start().then(() => null, (e) => e);
            return child;
        },
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        const st = await sup.start();
        assert.equal(st.state, 'ready');
        assert.equal(st.pid, a.pid);

        // 重入的那一次必须被**拒绝**(C2 的契约:非就绪一律拒绝),而不是又拉起一个进程。
        const err = await reentrant;
        assert.ok(err instanceof Error, '重入的 start() 必须拒绝,不能又开一轮');
        assert.equal(err.state, 'starting', '拒绝时状态仍是 starting —— 机器可读');
        assert.match(err.message, /重入/, '拒绝的理由是"重入",不是别的状态名');

        assert.deepEqual(spawned, [a], '第二个进程(那个 stop() 够不到的孤儿)根本不该被拉起');
        assert.equal(kids.length, 1, 'B 必须原封不动躺着');
    } finally {
        await sup.stop();
    }
});

test('setState 的 detail 契约:漏了 detail(或没说清 pid)必须当场炸,而不是悄悄变成 pid:null', () => {
    // 终审 C1 修的是"每次状态转换都得说清它是关于哪个进程的"。若 setState 给
    // detail 留一个默认值 { pid: null },一个**未来**忘了传 detail 的调用点就会
    // 静默退回 C1 那个 bug:通知带着一个看起来完全合法的 pid:null,谁也发现不了。
    // 所以契约做成"必须显式说清"的检查 —— 省略与糊弄都当场抛。
    assert.throws(() => assertPidDetail(undefined), /detail/,
        '省略 detail 必须当场炸(默认值会把 C1 那个 bug 悄悄放回来)');
    assert.throws(() => assertPidDetail(null), /detail/);
    assert.throws(() => assertPidDetail({}), /pid/, '给了对象却没说 pid 一样是漏');
    assert.throws(() => assertPidDetail({ pid: undefined }), /pid/,
        'pid: undefined 与"忘了给"没有区别,不许当作合法的 null');
    assert.throws(() => assertPidDetail({ pid: '4321' }), /pid/, 'pid 只许是数字或显式 null');
    // NaN 也是 number,但 `detail.pid ?? null` 会把它变成 null —— 那就正好是这条检查
    // 要防的那种"静默退化成没有进程"。所以形状检查必须显式拒它,不能只看 typeof。
    assert.throws(() => assertPidDetail({ pid: NaN }), /pid/,
        'NaN 是 number 却不是进程号:放行等于把 pid:null 那条缝重新打开');
    // 两条**合法**的写法:显式点名一个进程,或者显式说明"这次转换没有进程"。
    assert.doesNotThrow(() => assertPidDetail({ pid: 4321 }));
    assert.doesNotThrow(() => assertPidDetail({ pid: 0 }),
        '0 是"明确说出的一个数字",不是"没说清" —— 拒它会把形状检查变成猜谜');
    assert.doesNotThrow(() => assertPidDetail({ pid: null }));
});

test('并发的第二次 stop() 之后第一次 stop() 醒来:不许用旧结论覆盖新一代', async () => {
    // 这条刺破"stop() 里那句世代对账不可达"的旧注释:第一次 stop() 还卡在等 exit 时,
    // 第二次 stop() 走"没有活着的 attempt"的早退 —— 它顺手清掉 stopping,于是调用方
    // 可以 start() 出新一代;等第一次 stop() 终于等到 exit 醒来,世界已经不是它的了。
    const a = makeFakeChild(1111, { autoExitOnKill: false });   // 第一次 stop 要等的 exit 扣住
    const c = makeFakeChild(3333);
    const kids = [a, c];
    const sup = createAgentSupervisor({
        spawnChild: () => kids.shift(),
        handshake: async () => {},
        killTree: () => {},
        log: { warn() {} },
    });
    try {
        assert.equal((await sup.start()).state, 'ready');

        const first = sup.stop();                     // 等 A 的 exit:扣着不发
        assert.equal(sup.status().state, 'stopping');

        await sup.stop();                             // 第二次:current 已是 null,早退
        assert.equal(sup.status().state, 'stopped');

        const st = await sup.start();                 // 用户重新拉起 C
        assert.equal(st.state, 'ready');
        assert.equal(st.pid, c.pid);

        a.emit('exit', 0, null);                      // 第一次 stop() 这才醒来
        await first;

        assert.equal(sup.status().state, 'ready', '第一次 stop() 的迟到结论不许把 C 报成 stopped');
        assert.equal(sup.status().pid, c.pid);
        assert.equal(sup.transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }), true,
            'C 还活着,消息必须发得出去');
    } finally {
        await sup.stop();
    }
});
