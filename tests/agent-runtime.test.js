import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
    DEFAULT_PERMISSION_TIMEOUT_MS,
    DEFAULT_PROMPT_MAX_MS,
    DEFAULT_PROMPT_TIMEOUT_MS,
    createAgentRuntime,
} from '../electron/agent/agent-runtime.js';
import { createAgentSupervisor } from '../electron/agent/agent-supervisor.js';
import { createAgentSpawn, AGENT_PERMISSION_MODE } from '../app/lib/agent-env.js';
import { METHODS } from '../app/lib/acp-protocol.js';

// 这个文件里的每条用例都**不起真进程**:监护人、ACP 客户端、定时器全部注入。
// 理由不是"快",而是"确定" —— 崩溃、握手挂住、取消与超时全是时序问题,
// 靠 sleep 去撞它们只会得到偶尔变红的用例(而偶尔变红等于没有守卫)。

const tick = () => new Promise((r) => setImmediate(r));

/**
 * 手动定时器:排进去的东西**只在你叫它的时候**才跑。
 * 它同时记下 `ms`,于是"默认超时到底是多少"也能被断言,而不只是"能触发"。
 */
function manualTimers() {
    const jobs = [];
    let seq = 0;
    return {
        jobs,
        setTimeout(fn, ms) {
            const handle = ++seq;
            jobs.push({ fn, ms, handle });
            return handle;
        },
        clearTimeout(handle) {
            const i = jobs.findIndex((j) => j.handle === handle);
            if (i !== -1) jobs.splice(i, 1);
        },
        /** 触发第一个待跑的定时器(超时/权限那两条路都只有一个在等)。 */
        async flushFirst() {
            const job = jobs.shift();
            assert.ok(job, '应当有排队的定时器');
            await job.fn();
            return job;
        },
        /**
         * 触发**指定 ms** 的那个定时器。
         * 一轮里现在同时排着两只表(空闲窗口 + 总上限),谁先跑是要分清的。
         */
        async flushMs(ms) {
            const i = jobs.findIndex((j) => j.ms === ms);
            assert.ok(i !== -1, `应当有 ms=${ms} 的定时器,现有:${jobs.map((j) => j.ms)}`);
            const [job] = jobs.splice(i, 1);
            await job.fn();
            return job;
        },
    };
}

/**
 * 假监护人。只实现 runtime 真正用到的那几个成员:
 * transport / start / stop / status / onMessage / onStateChange。
 */
function fakeSupervisor() {
    const state = {
        state: 'stopped', pid: null, restarts: 0, since: 1, error: null,
    };
    const messageListeners = new Set();
    const stateListeners = new Set();
    const calls = { start: 0, stop: 0, handshake: 0 };
    const sup = {
        calls,
        transport: {
            sent: [],
            send(msg) { sup.transport.sent.push(msg); return true; },
            onMessage(fn) { messageListeners.add(fn); return () => messageListeners.delete(fn); },
        },
        get current() { return state.state; },
        setState(next, error = null) {
            state.state = next;
            state.error = error === null ? null : String(error?.message ?? error);
            for (const fn of stateListeners) fn({ ...state });
        },
        async start() {
            calls.start += 1;
            state.state = 'ready';
            // 就绪的进程当然有 pid:status() 的 pid 必须是"真的起来了"的那个,
            // 否则"连上了但 pid 是 null"这种半截世界没有任何用例盯得住。
            state.pid = calls.start;
            calls.handshake += 1;
            await sup.handshake(sup.transport);
            return { ...state };
        },
        async stop() { calls.stop += 1; state.state = 'stopped'; state.pid = null; return { ...state }; },
        status: () => ({ ...state }),
        onMessage(fn) { messageListeners.add(fn); return () => messageListeners.delete(fn); },
        onStateChange(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); },
        /** 制造一次状态转换(测试用:模拟崩溃/失败/停止)。 */
        fire(next, error = null) { sup.setState(next, error); },
        /** 模拟对端推来一条 ACP 消息(反向请求走这里)。 */
        deliver(msg) { for (const fn of messageListeners) fn(msg); },
        /** 测试给出真正的握手实现(默认是"起一个从没 resolve 的 promise")。 */
        handshake: null,
    };
    sup.handshake = async () => { for (;;) await tick(); };
    return sup;
}

/**
 * 假 ACP 客户端。`prompt()` 返回一个**不会自己落地**的 promise:
 * 超时与取消那两条路必须由运行时自己收场 —— 那正是要测的东西。
 */
function fakeClient() {
    const calls = {
        prompt: [], notify: [], failPending: [], initialize: 0, newSession: 0, dispose: 0, setConfig: [], listSessions: [], resume: [],
    };
    let requestHandler = null;
    let promptResolve = null;
    let promptReject = null;
    // 对端**手里**那份会话配置(session/new 与 set_config_option 都回它)。
    // 默认空表 —— 与改动前逐字一致;要验"思考强度"的用例用 setSessionConfig 摆初始状态。
    let sessionConfig = [];
    const client = {
        calls,
        get requestHandler() { return requestHandler; },
        get sessionConfig() { return sessionConfig; },
        /** 摆"对端现在手里是这一份配置"(必须在建会话之前调)。 */
        setSessionConfig: (list) => { sessionConfig = Array.isArray(list) ? list : []; },
        /**
         * 换掉"改配置"这件事的行为。默认是哑的(照原样回同一份),
         * 用例可以换它来**演真桥**的具体行为 —— 真桥实测:换模型会把思考强度
         * 打回新模型的默认值(见 agent-runtime 的 pinEffort)。
         */
        onSetConfig: null,
        initialize: async () => { calls.initialize += 1; return { protocolVersion: 1 }; },
        // ⚠️ 每次建会话都给一个**不同**的 id:真 dsh 就是这样(会话是进程的属性)。
        // 恒返回同一个 id 的替身会让"拿旧会话 id 去 prompt"这条 bug 完全隐形
        // —— 这正是它此前能躲过 36 条用例的原因。
        newSession: async () => {
            calls.newSession += 1;
            return { sessionId: `s${calls.newSession}`, configOptions: sessionConfig };
        },
        /**
         * 列表 / 恢复:对端那两个"会话栏"用的方法。
         * `listResult` 与 `onResume` 由用例摆 —— 默认是"空清单 / 照单回一份配置"。
         */
        listResult: { sessions: [], nextCursor: null },
        onResume: null,
        resumeResult: { configOptions: [] },
        listSessions: async ({ cwd } = {}) => {
            calls.listSessions.push({ cwd });
            return client.listResult;
        },
        resumeSession: async ({ sessionId, cwd }) => {
            calls.resume.push({ sessionId, cwd });
            if (typeof client.onResume === 'function') return await client.onResume({ sessionId, cwd });
            return client.resumeResult;
        },
        setConfigOption: async ({ sessionId, configId, value }) => {
            calls.setConfig.push({ sessionId, configId, value });
            if (typeof client.onSetConfig === 'function') {
                return await client.onSetConfig({ configId, value, list: sessionConfig });
            }
            return { configOptions: sessionConfig };
        },
        prompt({ sessionId, text, images = [], onUpdate }) {
            calls.prompt.push({ sessionId, text, images, onUpdate });
            return new Promise((resolve, reject) => { promptResolve = resolve; promptReject = reject; });
        },
        notify(method, params) { calls.notify.push({ method, params }); return true; },
        failPending(reason) { calls.failPending.push(String(reason?.message ?? reason)); },
        onRequest(entry) { requestHandler = entry; return () => { requestHandler = null; }; },
        dispose() { calls.dispose += 1; },
        /** 让在飞的那次 prompt 成功收场。 */
        resolvePrompt: (value) => promptResolve?.(value),
        rejectPrompt: (err) => promptReject?.(err),
        /** 模拟对端发来一个反向请求。 */
        deliver: (msg) => requestHandler?.handle(msg),
    };
    return client;
}

/**
 * 一套"运行时 + 两个替身"。`vault` 是**函数**,便于验证"每次 start 都重新取当前 Vault"。
 */
function harness(overrides = {}) {
    const timers = manualTimers();
    const sup = fakeSupervisor();
    const client = fakeClient();
    let vault = 'E:\\vault-a';
    const seen = { supervisors: [], clients: [] };

    const runtime = createAgentRuntime({
        vaultRoot: () => vault,
        env: {
            KAIWU_AGENT_SCRIPT: 'E:\\fake.mjs',
            KAIWU_NODE: 'E:\\node\\node.exe',
            // kaiwu 自己的 DSH_HOME 由 %APPDATA% 推出来(见 app/lib/agent-env.js)。
            // 这里必须给一个真的 APPDATA:没有它就算不出**绝对**的家,
            // 而 createAgentSpawn 现在会当场拒绝启动(宁可不启动,也不递一个相对的家)。
            APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        },
        exists: () => true,
        promptTimeoutMs: 1000,
        handshakeTimeoutMs: 2000,
        permissionTimeoutMs: 5000,
        timers,
        log: { warn() {}, error() {}, log() {} },
        createSupervisor: (deps) => {
            sup.handshake = deps.handshake;
            seen.supervisors.push(deps);
            return sup;
        },
        createClient: (deps) => { seen.clients.push(deps); return client; },
        ...overrides,
    });

    return {
        runtime, sup, client, timers, seen,
        setVault: (v) => { vault = v; },
    };
}

/** 接住一个 promise 的两种结局,避免"晚一点才断言"期间的未处理拒绝。 */
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

// ---- "思考强度默认为中"这一组用例用的形状(照真机实测的 configOptions 写)----

/** 真机那条梯子:`off / low / high / max`,其中 `high` 的短名就是「中」。 */
const EFFORT_LEVELS = ['off', 'low', 'high', 'max'];

/**
 * 一份 configOptions。
 * @param {string} current 强度那一项的当前值
 * @param {{levels?:string[], model?:boolean, effort?:boolean}} [opt]
 *        `effort:false` = 对端**没给**强度那一项(要验"不臆造");
 *        `levels` 可以换成一份**没有中**的梯子。
 */
function effortConfig(current, opt = {}) {
    const { levels = EFFORT_LEVELS, model = true, effort = true } = opt;
    const list = [];
    if (model) {
        list.push({
            id: 'model', name: 'Model', category: 'model', type: 'select',
            currentValue: '["fake","a"]',
            options: [{
                group: 'fake', name: '夹具供应商',
                options: [{ value: '["fake","a"]', name: 'A' }, { value: '["fake","b"]', name: 'B' }],
            }],
        });
    }
    if (effort) {
        list.push({
            id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
            currentValue: current,
            options: levels.map((v) => ({ value: v, name: v })),
        });
    }
    return list;
}

/** 一份 configOptions 里强度那一项的当前值(没有这一项 → undefined)。 */
const effortOf = (list) => (Array.isArray(list)
    ? list.find((o) => o?.id === 'reasoning_effort')?.currentValue
    : undefined);

/**
 * 一个**装成子进程**的对象:足够满足监护人(EventEmitter + stdio 流 + kill)。
 * 用它才能让 runtime 走到"真监护人"那条路(默认的假监护人只是把 spawnChild
 * 收在口袋里),于是 `spawn` 的 options 可以被逐字断言。
 */
function makeFakeChild(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('exit', 0, null)); };
    return child;
}

// ---------------------------------------------------------------------------
// 1) spawnChild 必须走 createAgentSpawn:cwd = 当前 Vault,env 是 read-only
// ---------------------------------------------------------------------------

test('起进程走 createAgentSpawn:cwd 是当前 Vault,env 是烤进去的 read-only', () => {
    const spawns = [];
    const fakeSpawn = (command, args, options) => { spawns.push({ command, args, options }); return { pid: 1 }; };

    // 直接用 createAgentSpawn 这一层验证(它就是 runtime 唯一允许的起进程方式):
    // 参数与 runtime 传给它的完全一致。
    const spawnChild = createAgentSpawn({
        command: 'E:\\node\\node.exe',
        args: ['E:\\fake.mjs', '--tool-call'],
        dshHome: 'C:\\Users\\me\\AppData\\Roaming\\kaiwu\\dsh-home',
        cwd: 'E:\\vault-a',
        base: { PATH: 'C:\\Program Files\\nodejs' },
        spawn: fakeSpawn,
    });
    spawnChild();

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, 'E:\\node\\node.exe');
    assert.deepEqual(spawns[0].args, ['E:\\fake.mjs', '--tool-call']);
    assert.equal(spawns[0].options.cwd, 'E:\\vault-a', 'cwd 必须是当前 Vault');
    assert.equal(spawns[0].options.env.DSH_PERMISSION_MODE, AGENT_PERMISSION_MODE);
    assert.equal(spawns[0].options.env.DSH_PERMISSION_MODE, 'read-only');
    assert.equal(spawns[0].options.env.DSH_HOME, 'C:\\Users\\me\\AppData\\Roaming\\kaiwu\\dsh-home');
    assert.equal(spawns[0].options.env.PATH, 'C:\\Program Files\\nodejs');
});

// ⚠️ 这一组用例的**实例**必须是同一个 runtime:换库之后要不要重建 controller 是
// runtime **内部**的决定,dispose 掉再新建一个 runtime 去断言,验的只是"新对象用新参数"
// —— 那种用例名比断言强,而真 bug(cwd 定死在第一次 start)正好从这条缝里漏过去。
test('同一个 runtime:start → stop → 换库 → start,spawn 的 cwd 与 session/new 都是新 Vault', async () => {
    const spawns = [];
    const fakeSpawn = (command, args, options) => { spawns.push({ command, args, options }); return makeFakeChild(spawns.length); };
    const created = [];
    const makeClient = () => {
        const cl = {
            initCalls: 0,
            dispose: async () => { cl.disposed += 1; },
            disposed: 0,
            initialize: async () => { cl.initCalls += 1; return { protocolVersion: 1 }; },
            newSession: async ({ cwd }) => { cl.sessionCwds.push(cwd); return { sessionId: 's1', configOptions: [] }; },
            sessionCwds: [],
            prompt: async () => ({ stopReason: 'end_turn' }),
            notify: () => true,
            failPending: () => {},
            onRequest: () => () => {},
        };
        created.push(cl);
        return cl;
    };

    let currentVault = 'E:\\vault-a';
    // 这里让 runtime 自己走 `resolveAgentCommand` + `createAgentSpawn` 那条默认路:
    // spawnOptions.spawn 是 createAgentSpawn 的注入点,于是既验证了接线、
    // 又不用真的起进程。createSupervisor 换成假监护人(它才会真的调那个 spawnChild)。
    const runtime = createAgentRuntime({
        vaultRoot: () => currentVault,
        env: { KAIWU_AGENT_SCRIPT: 'E:\\fake.mjs', KAIWU_NODE: 'E:\\node\\node.exe', DSH_HOME: 'C:\\home' },
        exists: () => true,
        spawnOptions: { spawn: fakeSpawn },
        handshakeTimeoutMs: 5,
        timers: manualTimers(),
        log: { warn() {}, error() {} },
        // ⚠️ 这里**必须**用真监护人:假监护人自己就是进程,它根本不会去调
        // `spawnChild`(cwd 也就无从谈起)。只有真监护人 + 假 spawn,才能同时
        // 验证"换库会重建 controller"与"重建时真的把新 cwd 交给了 spawn"。
        createSupervisor: createAgentSupervisor,
        createClient: () => makeClient(),
    });

    try {
        await runtime.start();
        // ready 之后运行时**自动建**一条会话(见 autoCreateSession):真监护人是在
        // setState('ready') 里推通知的,所以这里等它落定再断言。
        assert.equal(spawns.length, 1);
        assert.equal(spawns[0].options.cwd, 'E:\\vault-a');
        assert.equal(spawns[0].options.env.DSH_PERMISSION_MODE, 'read-only');
        await tick();
        assert.deepEqual(created[0].sessionCwds, ['E:\\vault-a'],
            'ready 之后自动建的会话也得建在**当前** Vault 上');
        assert.equal(runtime.status().sessionId, 's1');

        await runtime.stop();

        // 用户换库,然后**同一个 runtime** 再 start —— cwd 必须跟着换。
        currentVault = 'E:\\vault-b';
        await runtime.start();
        await tick();
        assert.equal(spawns.length, 2, '换库必须重新起进程(旧 controller 不许被复用)');
        assert.equal(spawns[1].options.cwd, 'E:\\vault-b', '换库之后 cwd 必须是新的 Vault');

        // 会话也必须建在新库上(不然同一次连接里两个 cwd 不一致)。
        await runtime.send('你好');
        const used = created.flatMap((c) => c.sessionCwds);
        assert.deepEqual(used, ['E:\\vault-a', 'E:\\vault-b'],
            '两次 session/new 各建在自己那一刻的 Vault 上(旧那个绝不会建到新库去)');

        // 旧 controller 必须**彻底收掉**:监听器摘掉、客户端释放 —— 否则旧进程的
        // 事件/僵尸响应还能顺着它打到新进程上。
        assert.equal(created.length, 2, '两个 Vault 各一个客户端实例');
        assert.equal(created[0].disposed, 1, '旧客户端必须被 dispose(监听器与在飞请求一起收掉)');
        assert.equal(created[1].disposed, 0, '新客户端还活着');
    } finally {
        await runtime.dispose();
    }
});

test('还没有选库(Null Vault)时 start() 拒绝,而不是在某个默认目录里起 Agent', async () => {
    const h = harness({ vaultRoot: () => null });
    const outcome = await settle(h.runtime.start());
    assert.ok(outcome.error instanceof Error);
    assert.match(outcome.error.message, /笔记库|Vault/);
    assert.equal(h.sup.calls.start, 0, '没有 Vault 就不许起进程');
});

// ---------------------------------------------------------------------------
// 2) DSH_HOME 只解析一次,spawn 与 detectCredentials 共用同一个值
// ---------------------------------------------------------------------------

test('spawn 与 credentials() 用的是**同一个** DSH_HOME', async () => {
    const spawns = [];
    const fakeSpawn = (command, args, options) => { spawns.push({ command, args, options }); return { pid: 1 }; };
    const seenHomes = [];

    const runtime = createAgentRuntime({
        vaultRoot: 'E:\\vault-a',
        env: {
            KAIWU_AGENT_SCRIPT: 'E:\\fake.mjs',
            KAIWU_NODE: 'E:\\node\\node.exe',
            // 两条路都从这份 env 推家:spawn 侧走 createAgentSpawn → resolveKaiwuDshHome,
            // 凭证侧走 credentials()。两边都得能算出**绝对**的家,否则还没比就已经拒启动了。
            APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        },
        exists: () => true,
        appData: 'C:\\Users\\me\\AppData\\Roaming',
        spawnOptions: { spawn: fakeSpawn },
        handshakeTimeoutMs: 5,
        timers: manualTimers(),
        log: { warn() {}, error() {} },
        // 真实的 detectCredentials 只需要 readFile;这里注入一个记下 home 的替身,
        // 于是"两处拿到的是不是同一个字符串"可以被直接断言。
        detectCredentialsFn: ({ home }) => {
            seenHomes.push(home);
            return { ok: true, source: 'file', reason: null };
        },
    });
    try {
        void runtime.credentials();
        const starting = settle(runtime.start());
        // spawn 现在发生在**微任务之后**:`start()` 里的 `const c = await ensureController()`
        // 会把"同步快路径"返回的 controller 也推迟一轮微任务,`c.supervisor.start()`
        // 因此不再与 `start()` 同步(实测:调用后同步读 spawns.length = 0)。
        // 所以断言前必须 `await tick()` —— 这不是假监护人的排队行为,是那个 await 本身。
        await tick();
        assert.equal(spawns.length, 1);
        const spawnedHome = spawns[0].options.env.DSH_HOME;
        assert.ok(typeof spawnedHome === 'string' && spawnedHome !== '', 'DSH_HOME 必须显式传给子进程');
        assert.deepEqual(seenHomes, [spawnedHome], '凭证检测必须看同一个家');
        await starting;
    } finally {
        await runtime.dispose();
    }
});

test('继承来的 DSH_HOME 不许决定 Agent 用哪个家(它属于 harness,不是 kaiwu 的)', async () => {
    const spawns = [];
    const fakeSpawn = (command, args, options) => { spawns.push({ options }); return { pid: 1 }; };
    const runtime = createAgentRuntime({
        vaultRoot: 'E:\\vault-a',
        env: {
            KAIWU_AGENT_SCRIPT: 'E:\\fake.mjs',
            KAIWU_NODE: 'E:\\node\\node.exe',
            DSH_HOME: 'C:\\Users\\me\\AppData\\Roaming\\dsh-desktop\\harness',
            APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        },
        exists: () => true,
        spawnOptions: { spawn: fakeSpawn },
        handshakeTimeoutMs: 5,
        timers: manualTimers(),
        log: { warn() {}, error() {} },
    });
    try {
        const starting = settle(runtime.start());
        // 同上:延迟来自 `start()` 里那句 `await ensureController()`(微任务),
        // 不是监护人把 spawnChild 排了队 —— 让一轮事件循环才看得见 spawn。
        await tick();
        assert.equal(spawns.length, 1);
        // resolveKaiwuDshHome 的规则是"显式 DSH_HOME > %APPDATA%\kaiwu\dsh-home",
        // 而这里的 DSH_HOME 是**继承**来的 —— 按 agent-env 的契约它仍然算显式给出
        // (探针也是这么做的)。这里只断言它确实被显式传给了子进程,而不是靠继承。
        assert.equal(spawns[0].options.env.DSH_HOME, 'C:\\Users\\me\\AppData\\Roaming\\dsh-desktop\\harness');
        await starting;
    } finally {
        await runtime.dispose();
    }
});

test('credentials() 只回叶子字段,绝不带出密钥值', async () => {
    const h = harness({
        env: { KAIWU_AGENT_SCRIPT: 'E:\\fake.mjs', KAIWU_NODE: 'E:\\node\\node.exe', DEEPSEEK_API_KEY: 'sk-超级秘密' },
        detectCredentialsFn: () => ({ ok: true, source: 'env', reason: null }),
    });
    const cred = await h.runtime.credentials();
    assert.deepEqual(cred, { ok: true, source: 'env', reason: null });
    assert.equal(JSON.stringify(cred).includes('超级秘密'), false);
    assert.deepEqual(Object.keys(cred).sort(), ['ok', 'reason', 'source']);
});

// ---------------------------------------------------------------------------
// 3) failPending 必须接在**每一条**离开 ready 的路上
// ---------------------------------------------------------------------------

const LEFT_READY_CASES = [
    ['crashed', /崩/],
    ['failed', /失败/],
    ['stopping', /停止/],
    ['stopped', /停止/],
];

for (const [state, pattern] of LEFT_READY_CASES) {
    test(`离开 ready 的 ${state} 那条路会结掉在飞请求(否则 prompt 永远挂着)`, async () => {
        const h = harness();
        try {
            await h.runtime.start();
            assert.equal(h.sup.current, 'ready');
            h.sup.fire(state, new Error('测试制造的转换'));
            await tick();
            assert.equal(h.client.calls.failPending.length, 1);
            assert.match(h.client.calls.failPending[0], pattern);
        } finally {
            await h.runtime.dispose();
        }
    });
}

test('stop() 也会结掉在飞请求(用户在提示进行中按停止是最常见的那条路)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        h.client.calls.failPending.length = 0;
        await h.runtime.stop();
        assert.ok(h.client.calls.failPending.length >= 1, 'stop() 必须先结掉在飞请求再停进程');
        assert.match(h.client.calls.failPending[0], /停止/);
    } finally {
        await h.runtime.dispose();
    }
});

test('stop() 推出去的状态事件**必须说 stopped**:推一条"还 ready"的假事件会让面板一直以为连着', async () => {
    // 真机表现(改动前):从输入卡片或设置页按下「停止进程」,主进程确实停了
    // (设置页那一行立刻变"未连接"),而**面板纹丝不动** —— 还写着已连接、发送按钮亮着,
    // 点下去必然失败。根因:`leaveReady` 那一刻 controller 还在(它要用 controller
    // 结在飞请求),而 agentStatus() 是按 controller 算状态的,于是那条事件报的是旧状态。
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        await h.runtime.stop();
        const states = events.filter((e) => e.kind === 'state').map((e) => e.status?.state);
        assert.deepEqual(states, ['stopped'],
            `stop() 只该推一条如实的状态事件,实际:${JSON.stringify(states)}`);
        assert.equal(h.runtime.status().state, 'stopped');
    } finally {
        await h.runtime.dispose();
    }
});

test('在飞的 prompt 真的会因为崩溃而以失败收场(不是挂在 pending 里)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('你好'));
        await tick();
        assert.equal(h.client.calls.prompt.length, 1);

        // 模拟 acp-client 的 failPending 会做的事:在飞请求以原因拒绝。
        h.client.rejectPrompt(new Error('ACP 请求失败(session/prompt):Agent 进程崩溃了'));
        h.sup.fire('crashed', new Error('Agent 意外退出'));
        const outcome = await sending;
        assert.ok(outcome.error instanceof Error, '崩溃后在飞的提示必须收场,不许永远挂着');
        assert.match(outcome.error.message, /崩溃|失败/);
    } finally {
        await h.runtime.dispose();
    }
});

// ---------------------------------------------------------------------------
// 3b) 会话不许活过进程:离开 ready 的每条路都要作废 sessionId
//
// 这是复核时抓出来的**真 bug**:sessionId 原来只在 dispose() 里清。ACP 的会话是
// **进程的属性**,而 ensureSession() 见 sessionId 非空就直接复用 —— 于是
// 「崩溃 → 监护人退避重启 → 又 ready」之后,下一条提示会拿旧会话 id 去 prompt,
// 真 dsh 回"会话不存在"一类错误,而**此后再也建不出新会话**:界面永久坏掉。
// 夹具对任意 sessionId 都照收,所以这些用例必须自己盯住 newSession 的次数与 id。
// ---------------------------------------------------------------------------

test('崩溃后重启回 ready,再发提示必须重新 session/new,且不许再用旧会话 id', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const first = settle(h.runtime.send('第一条'));
        await tick();
        assert.equal(h.client.calls.newSession, 1);
        const oldSid = h.client.calls.prompt[0].sessionId;
        assert.equal(oldSid, 's1');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await first;
        assert.equal(h.runtime.status().sessionId, 's1');

        // 1) 崩溃 —— 会话随进程消失
        h.sup.fire('crashed', new Error('Agent 意外退出'));
        await tick();
        assert.equal(h.runtime.status().sessionId, null, 'status() 必须反映"会话已经没了"');

        // 2) 监护人退避重启之后又是 ready(全新进程)—— 那一刻就**自动**建一条新会话,
        //    不必等用户再发消息(这正是"胶囊一进来就能用"那条行为的接缝)。
        h.sup.fire('ready');
        await tick();
        assert.equal(h.client.calls.newSession, 2, '重启之后要重新 session/new(不许复用旧会话)');
        const newSid = h.runtime.status().sessionId;
        assert.notEqual(newSid, null, 'ready 之后就该有新会话');
        assert.notEqual(newSid, oldSid, '新会话绝不是死在旧进程上的那一个');
        assert.equal(newSid, 's2');

        // 3) 用户再发一条:直接用那条新会话(**不许**再建第三条),prompt 用的是新 id
        const second = settle(h.runtime.send('第二条'));
        await tick();
        assert.equal(h.client.calls.newSession, 2, '已经有会话了:发提示不该再建一条');
        assert.equal(h.client.calls.prompt.length, 2);
        assert.equal(h.client.calls.prompt[1].sessionId, 's2', 'prompt 必须用新会话 id');
        assert.notEqual(h.client.calls.prompt[1].sessionId, oldSid);
        assert.equal(h.runtime.status().sessionId, 's2');
        // 旧 id 不许再出现在任何发出去的请求里(通知也算)
        for (const m of h.client.calls.notify) {
            assert.notEqual(m.params?.sessionId, oldSid, '旧会话 id 不许再出现在通知里');
        }
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        assert.deepEqual((await second).value, { stopReason: 'end_turn' });
    } finally {
        await h.runtime.dispose();
    }
});

test('崩溃的每一条路(failed / stopping / stopped)都作废会话,不只 crashed', async () => {
    for (const state of ['crashed', 'failed', 'stopping', 'stopped']) {
        const h = harness();
        try {
            await h.runtime.start();
            const sending = settle(h.runtime.send('你好'));
            await tick();
            assert.equal(h.runtime.status().sessionId, 's1', `${state}:发提示后应当有会话`);

            h.sup.fire(state, new Error(`测试制造的 ${state}`));
            await tick();
            assert.equal(h.runtime.status().sessionId, null, `${state}:离开 ready 必须作废会话`);
            assert.equal(h.runtime.status().busy, false, `${state}:busy 必须归位`);
            // 提示进行中进程就没了:那一次提示必须收场,不许挂着
            h.client.rejectPrompt(new Error(`ACP 请求失败(session/prompt):${state}`));
            const outcome = await sending;
            assert.ok(outcome.error instanceof Error, `${state}:在飞的提示必须收场`);
        } finally {
            await h.runtime.dispose();
        }
    }
});

test('stop() 之后 status().sessionId 是 null,再 send 同样会重新建会话', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const first = settle(h.runtime.send('第一条'));
        await tick();
        assert.equal(h.runtime.status().sessionId, 's1');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await first;

        await h.runtime.stop();
        assert.equal(h.runtime.status().state, 'stopped');
        assert.equal(h.runtime.status().sessionId, null, 'stop() 之后会话必须没了');
        assert.equal(h.runtime.status().busy, false);

        // 再发一条:自动 start + 重新建会话
        const startsBefore = h.sup.calls.start;
        const second = settle(h.runtime.send('第二条'));
        await tick();
        assert.equal(h.sup.calls.start, startsBefore + 1, '停止之后再发提示要重新拉起 Agent');
        assert.equal(h.client.calls.newSession, 2, '必须重新 session/new');
        assert.equal(h.client.calls.prompt[1].sessionId, 's2');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        assert.deepEqual((await second).value, { stopReason: 'end_turn' });
    } finally {
        await h.runtime.dispose();
    }
});

test('取消**不**让会话失效:只有进程离开 ready 才算会话没了', async () => {
    // 与上面几条是**成对**的:把"进程没了"与"这一轮提示结束"分开钉住。
    // 会话失效判据一旦写成"提示结束就作废",每轮提示都会白建一个会话
    // (而且前一个会话永远留在对端);写成"崩了也不作废",就是这条 bug。
    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('你好'));
        await tick();
        await h.runtime.cancel();
        await sending;

        assert.equal(h.runtime.status().sessionId, 's1', '取消只是结束这一轮提示,会话还在');
        assert.equal(h.runtime.status().state, 'ready');

        const second = settle(h.runtime.send('再来一条'));
        await tick();
        assert.equal(h.client.calls.newSession, 1, '取消之后**不许**重建会话');
        assert.equal(h.client.calls.prompt[1].sessionId, 's1', '仍然用同一个会话');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await second;
    } finally {
        await h.runtime.dispose();
    }
});

test('提示超时**不**让会话失效(超时是这一轮的事,不是进程的事)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('你好'));
        await tick();
        await h.timers.flushFirst();
        await sending;
        assert.equal(h.runtime.status().sessionId, 's1', '超时之后会话仍然可用');

        const second = settle(h.runtime.send('再来一条'));
        await tick();
        assert.equal(h.client.calls.newSession, 1, '超时之后不许重建会话');
        assert.equal(h.client.calls.prompt[1].sessionId, 's1');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await second;
    } finally {
        await h.runtime.dispose();
    }
});
// ---------------------------------------------------------------------------
// 4) prompt 的超时与取消
// ---------------------------------------------------------------------------

test('空闲超时:默认 180000ms、总上限 1800000ms;空闲到点发 session/cancel 并当场以失败收场', async () => {
    // 默认值本身就是契约(硬要求 4/6):太短会把正常的慢回复判死。
    // ⚠️ 空闲超时从 20000 提到 180000 是被**生图**撑大的:generate_image 一次 10–60 秒
    // 是常态,20 秒会把这一轮判超时、还会顺手 session/cancel 把生成打断(白花钱)。
    assert.equal(DEFAULT_PROMPT_TIMEOUT_MS, 180000);
    // ⚠️ 总上限**必须**存在:空闲超时改成"看有没有增量"之后,一直出字的一轮永不收场
    // (真陷进死循环的 agent 也会持续出字),总得有个兜底(见下面第三条用例)。
    assert.equal(DEFAULT_PROMPT_MAX_MS, 1800000);
    // ⚠️ 握手超时 20000 → **35000**:这台机器冷启动实测 3.5–3.9s,但机器忙 / 子进程
    // boot 卡住时 20s 不够(实测两次判死分别用了 21.2s 与 20.6s —— 差一点就起来了)。
    // 失败时会把子进程最后输出一并打出来,所以"晚 15 秒才失败"的代价很小。
    assert.equal(DEFAULT_HANDSHAKE_TIMEOUT_MS, 35000);
    assert.equal(DEFAULT_PERMISSION_TIMEOUT_MS, 120000);

    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('你好'));
        await tick();
        // 排在队里、且 ms=1000(harness 注入的值)的那个就是**空闲**超时
        const job = h.timers.jobs.find((j) => j.ms === 1000);
        assert.ok(job, `空闲超时定时器必须真的排上去了,现有:${h.timers.jobs.map(j => j.ms)}`);

        await h.timers.flushMs(1000);
        const outcome = await sending;
        assert.ok(outcome.error instanceof Error, '超时必须拒绝,不许挂住');
        assert.match(outcome.error.message, /超时/);
        assert.deepEqual(h.client.calls.notify, [
            { method: METHODS.SESSION_CANCEL, params: { sessionId: 's1' } },
        ]);
        assert.equal(h.runtime.status().busy, false, '超时之后不许还显示"正在生成"');
    } finally {
        await h.runtime.dispose();
    }
});

test('一直有增量的一轮**不**判超时 —— 实测踩过:188s 的一轮在工具正跑着时被掐掉', async () => {
    // 真机那一轮(2026-09-27 22:21):从发出到被判超时 188534ms,期间 11 段思考、
    // 10 段回复、17 个工具条目一直在出 —— 定时器却只认墙钟,把这一轮连同工具一起取消。
    // 这条用例盯的就是"有增量 = 有进展 = 不算没响应"。
    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('你好'));
        await tick();
        const first = h.timers.jobs.find((j) => j.ms === 1000);
        assert.ok(first, '空闲超时定时器必须在队里');

        for (let i = 0; i < 5; i += 1) {
            h.client.calls.prompt[0].onUpdate({
                sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `第${i}段` },
            });
            await tick();
        }

        const idleJobs = h.timers.jobs.filter((j) => j.ms === 1000);
        assert.equal(idleJobs.length, 1, '空闲定时器只该有一个(旧的必须被撤掉,不是越排越多)');
        assert.notEqual(idleJobs[0].handle, first.handle, '必须是**新**的那个在等');
        assert.equal(h.runtime.status().busy, true, '一直在出字的一轮不许被收场');
        assert.equal(h.timers.jobs.some((j) => j.ms === 1800000), true, '总上限始终在队里兜底');

        // 出字停下来、再过满一个空闲窗口,才轮到收场 —— 而且文案要说清是"没进展"
        await h.timers.flushMs(1000);
        const outcome = await sending;
        assert.match(outcome.error.message, /没有任何进展/, '要说"没进展",不能再说"没有响应"');
        assert.deepEqual(h.client.calls.notify, [
            { method: METHODS.SESSION_CANCEL, params: { sessionId: 's1' } },
        ]);
    } finally {
        await h.runtime.dispose();
    }
});

test('工具在跑就不算"没响应":空闲到点放行,工具收尾后才收场', async () => {
    // 一轮里最长的静默往往在工具内部(跑测试 / 生图 / 一条大命令),那不是对端死了。
    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('跑一下'));
        await tick();
        const update = (u) => h.client.calls.prompt[0].onUpdate(u);

        update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'pwsh', kind: 'execute', status: 'pending' });
        await tick();

        // 空闲窗口到点:工具还在跑 —— 不许收场,而且必须重新排上一个新的空等
        await h.timers.flushMs(1000);
        assert.equal(h.runtime.status().busy, true, '工具在跑时不许把这一轮判死');
        assert.equal(h.timers.jobs.some((j) => j.ms === 1000), true, '放行之后必须重新计时');

        // 工具还在跑:再等一个窗口,还是不许收场(不能只放行一次)
        await h.timers.flushMs(1000);
        assert.equal(h.runtime.status().busy, true, '工具一直没结束就一直不许判超时');

        // 工具收尾了,再空满一个窗口才收场
        update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        await tick();
        await h.timers.flushMs(1000);
        const outcome = await sending;
        assert.ok(outcome.error instanceof Error, '工具结束之后仍然静默,这时才该收场');
        assert.match(outcome.error.message, /没有任何进展/);
    } finally {
        await h.runtime.dispose();
    }
});

test('总上限兜底:一直有增量也照样在到点时收场(文案与空闲超时分开)', async () => {
    const h = harness({ promptMaxMs: 4000 });
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('没完没了'));
        await tick();
        // 一直有增量,空闲那只看门狗永远等不到机会
        h.client.calls.prompt[0].onUpdate({
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '还在出字' },
        });
        await tick();

        await h.timers.flushMs(4000);
        const outcome = await sending;
        assert.ok(outcome.error instanceof Error, '总上限必须拒绝,不许挂住');
        assert.match(outcome.error.message, /超过了 0 分钟上限|超过了 .* 分钟上限/, '文案要说的是"整轮太长"');
        assert.deepEqual(h.client.calls.notify, [
            { method: METHODS.SESSION_CANCEL, params: { sessionId: 's1' } },
        ], '总上限同样要给对端发取消');
        assert.equal(h.runtime.status().busy, false);
    } finally {
        await h.runtime.dispose();
    }
});

test('取消:本地那次提示立刻以 {stopReason:"cancelled"} 收场,并给对端发 session/cancel', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        const sending = settle(h.runtime.send('你好'));
        await tick();
        assert.equal(h.runtime.status().busy, true);

        const r = await h.runtime.cancel();
        assert.deepEqual(r, { cancelled: true });

        const outcome = await sending;
        // ⚠️ 断言必须在 `await sending` **之后**再数:send() 的 cancelled 分支
        // 还要等 Promise.race 的后续微任务才跑,早一步数就看不见第二条 ——
        // "一次取消发两条 session/cancel"这条 bug 正是这样躲过原用例的。
        assert.deepEqual(h.client.calls.notify, [
            { method: METHODS.SESSION_CANCEL, params: { sessionId: 's1' } },
        ], '一次取消只许发一条 session/cancel');

        assert.deepEqual(outcome.value, { stopReason: 'cancelled' }, '取消是正常收场,不是错误');
        const end = events.filter((e) => e.kind === 'prompt-end');
        assert.equal(end.length, 1);
        assert.equal(end[0].stopReason, 'cancelled');
        assert.equal(h.runtime.status().busy, false);
    } finally {
        await h.runtime.dispose();
    }
});

test('取消与 send 的 cancelled 分支不许各发一条 session/cancel(数量恰好 1)', async () => {
    // F4:一次取消原来会发**两条** session/cancel —— cancel() 一条,
    // send() 的 cancelled 分支又一条。第二条晚一拍才发出去,所以旧用例
    // (断言时机在 cancel() 之后、await send 之前)看不见它。
    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('你好'));
        await tick();
        await h.runtime.cancel();
        await sending;

        const cancels = h.client.calls.notify.filter((n) => n.method === METHODS.SESSION_CANCEL);
        assert.equal(cancels.length, 1, `一次取消只许发一条 session/cancel,实际 ${cancels.length} 条`);
        assert.deepEqual(cancels[0].params, { sessionId: 's1' });
    } finally {
        await h.runtime.dispose();
    }
});

test('取消之后对端才回来的真正响应不再影响调用方,也不留下未处理的拒绝', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        const sending = settle(h.runtime.send('你好'));
        await tick();
        await h.runtime.cancel();
        const outcome = await sending;
        assert.deepEqual(outcome.value, { stopReason: 'cancelled' });

        // 对端迟到的响应:acp-client 已经把那次 prompt 从 pending 里摘掉了,
        // 所以这里既不该改结局,也不该产生任何东西。
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await tick();
        await tick();
        assert.deepEqual(await sending, outcome, '迟到的响应不许改写结局');
        assert.equal(events.filter((e) => e.kind === 'prompt-end').length, 1);
        assert.equal(events.filter((e) => e.kind === 'prompt-error').length, 0);
        assert.deepEqual(rejections, [], '不许留下未处理的拒绝');
    } finally {
        process.removeListener('unhandledRejection', onRejection);
        await h.runtime.dispose();
    }
});

test('没有在飞的提示时 cancel 回 {cancelled:false},也不给对端发通知', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        assert.deepEqual(await h.runtime.cancel(), { cancelled: false });
        assert.deepEqual(h.client.calls.notify, []);
    } finally {
        await h.runtime.dispose();
    }
});

test('取消之后 busy 归位,而且能再发下一条提示(不是为了修 spinner 把会话废掉)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const first = settle(h.runtime.send('第一条'));
        await tick();
        await h.runtime.cancel();
        await first;

        const second = settle(h.runtime.send('第二条'));
        await tick();
        assert.equal(h.client.calls.prompt.length, 2, '取消之后必须还能再发');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        const outcome = await second;
        assert.deepEqual(outcome.value, { stopReason: 'end_turn' });
    } finally {
        await h.runtime.dispose();
    }
});

// ---------------------------------------------------------------------------
// 5) 没配钥匙必须被认出来
// ---------------------------------------------------------------------------

test('prompt 报 -32603 no API key 时,事件里 missingCredential 为 true', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        const sending = settle(h.runtime.send('你好'));
        await tick();

        const err = new Error('ACP 错误 -32603:no API key configured');
        err.code = -32603;
        h.client.rejectPrompt(err);

        const outcome = await sending;
        assert.ok(outcome.error instanceof Error);
        const failure = events.filter((e) => e.kind === 'prompt-error');
        assert.equal(failure.length, 1);
        assert.equal(failure[0].missingCredential, true, '不许把"没配钥匙"渲染成"已连接然后莫名失败"');
        assert.match(failure[0].message, /no API key/);
    } finally {
        await h.runtime.dispose();
    }
});

test('别的 -32603 不会被误判成"没配钥匙"', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        const sending = settle(h.runtime.send('你好'));
        await tick();
        const err = new Error('ACP 错误 -32603:工具执行失败');
        err.code = -32603;
        h.client.rejectPrompt(err);
        await sending;

        const failure = events.filter((e) => e.kind === 'prompt-error');
        assert.equal(failure.length, 1);
        assert.equal(failure[0].missingCredential, false);
    } finally {
        await h.runtime.dispose();
    }
});

test('发成功时 prompt-end 带上对端的 stopReason,状态里没有错误', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        const sending = settle(h.runtime.send('你好'));
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        const outcome = await sending;
        assert.deepEqual(outcome.value, { stopReason: 'end_turn' });

        const session = events.filter((e) => e.kind === 'session');
        assert.equal(session.length, 1);
        assert.equal(session[0].sessionId, 's1');
        assert.ok(Array.isArray(session[0].configOptions));
        const end = events.filter((e) => e.kind === 'prompt-end');
        assert.deepEqual(end.map((e) => e.stopReason), ['end_turn']);
    } finally {
        await h.runtime.dispose();
    }
});

test('update 增量原样推给渲染进程(带 sessionId)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        const sending = settle(h.runtime.send('你好'));
        await tick();
        const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回复0' } };
        h.client.calls.prompt[0].onUpdate(update);
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;

        const updates = events.filter((e) => e.kind === 'update');
        assert.deepEqual(updates, [{ kind: 'update', sessionId: 's1', update }]);
    } finally {
        await h.runtime.dispose();
    }
});

// ---------------------------------------------------------------------------
// 6) 反向请求 session/request_permission
// ---------------------------------------------------------------------------

test('权限请求:推事件 → answerPermission → 对端收到选中那个选项', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        const answering = h.client.deliver({
            jsonrpc: '2.0',
            id: 900001,
            method: METHODS.REQUEST_PERMISSION,
            params: {
                sessionId: 's1',
                toolCall: { toolCallId: 'call-1', title: '运行命令:git status', kind: 'execute' },
                options: [
                    { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
                    { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
                ],
            },
        });

        const permissions = events.filter((e) => e.kind === 'permission');
        assert.equal(permissions.length, 1);
        assert.equal(permissions[0].sessionId, 's1');
        assert.deepEqual(permissions[0].toolCall,
            { toolCallId: 'call-1', title: '运行命令:git status', kind: 'execute' });
        assert.deepEqual(permissions[0].options.map((o) => o.optionId), ['allow-once', 'reject-once']);

        const requestId = permissions[0].requestId;
        const answered = await h.runtime.answerPermission(requestId, 'allow-once');
        assert.deepEqual(answered, { ok: true });
        assert.deepEqual(await answering, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    } finally {
        await h.runtime.dispose();
    }
});

test('权限请求超时按"拒绝"收场 —— 对端必须**恰好**拿到一个回答', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        const answering = h.client.deliver({
            jsonrpc: '2.0',
            id: 900002,
            method: METHODS.REQUEST_PERMISSION,
            params: { sessionId: 's1', toolCall: { toolCallId: 'c2', title: '跑命令', kind: 'execute' }, options: [] },
        });
        const requestId = events.find((e) => e.kind === 'permission').requestId;

        const job = h.timers.jobs.find((j) => j.ms === 5000);
        assert.ok(job, '权限等待上限必须真的排上去(没有它,用户不点卡片就一直等)');
        await h.timers.flushFirst();

        const answer = await answering;
        assert.deepEqual(answer.outcome.outcome, 'cancelled', '超时按拒绝收场');
        // 之后用户再点那张卡片不该再产生第二个回答
        assert.deepEqual(await h.runtime.answerPermission(requestId, 'allow-once'), { ok: false });
    } finally {
        await h.runtime.dispose();
    }
});

test('重复回答同一个权限请求时,第二次不会给对端再发一次', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        const answering = h.client.deliver({
            jsonrpc: '2.0', id: 900003, method: METHODS.REQUEST_PERMISSION,
            params: { sessionId: 's1', toolCall: {}, options: [{ optionId: 'allow-once', name: '允许', kind: 'allow_once' }] },
        });
        const requestId = events.find((e) => e.kind === 'permission').requestId;

        assert.deepEqual(await h.runtime.answerPermission(requestId, 'allow-once'), { ok: true });
        assert.deepEqual(await h.runtime.answerPermission(requestId, 'allow-once'), { ok: false });
        assert.deepEqual(await answering, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    } finally {
        await h.runtime.dispose();
    }
});

/**
 * 这一组是 M3-A 那条契约**改写**后的样子(评审 F2)。
 *
 * 旧契约:dispose / 离开 ready 时把挂着的权限请求**按拒绝收场**,理由是"别让对端一直等"。
 * 新契约:离开 ready / dispose 时把挂起的权限请求**直接丢弃,一个响应都不发**。
 * 为什么改:请求方那个进程已经没了,没有任何人在等这个响应;而 acp-client 是拿
 * **原消息的 jsonrpc id** 回响应的,响应又走**当前** transport —— 那个 transport
 * 在监护人重启后指向**新进程**,而对端每进程 id 从头编号(本项目夹具就是常量
 * 900001)。于是"按拒绝收场"恰好会变成:新进程发的另一个权限请求**同一个 id
 * 收到两个响应**,而且第二个是 cancelled —— 用户根本没拒绝,却被当成拒绝了。
 */
test('dispose 时挂着的权限请求被丢弃:一个响应都不发,定时器一起清掉(契约改写)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        let respond = null;
        // ⚠️ 新契约下这个 promise **永远不会落地**(请求被丢弃了),所以只能挂着;
        // 但必须接住它的两种结局,否则测试进程会以为事件循环还没完(实测:
        // 整份文件后面的用例全被 cancelledByParent 带红)。
        const answering = h.client.deliver({
            jsonrpc: '2.0', id: 900004, method: METHODS.REQUEST_PERMISSION,
            params: { sessionId: 's1', toolCall: {}, options: [] },
        }).then((result) => { respond = result; return result; }, () => null);
        assert.equal(events.filter((e) => e.kind === 'permission').length, 1);
        assert.equal(h.timers.jobs.filter((j) => j.ms === 5000).length, 1, '权限等待上限先排上');

        await h.runtime.dispose();
        assert.equal(respond, null, 'dispose 不许再发出任何权限响应(那个进程已经没了)');
        assert.deepEqual(h.timers.jobs.filter((j) => j.ms === 5000), [], '权限定时器必须一起清掉');
        void answering;
    } finally {
        await h.runtime.dispose();
    }
});

/**
 * 崩 → 监护人重启 → 旧定时器到点:那个**旧 id** 的响应绝不许出现在新进程上。
 *
 * 这条必须用**真 acp-client**:僵尸响应是它发出去的(它拿原消息 id 回响应,
 * 而 transport 是单例、闭包读可变 current —— 重启后它写的就是新进程)。
 * 只用假客户端的话,这条路径根本没有代码去走。
 */
test('崩溃重启后旧权限请求的定时器到点,不会用旧 id 给新进程发第二个响应', async () => {
    const bus = [];
    // 与 acp-client 的契约一致:onMessage 返回退订函数;每条被"登记过"的
    // 监听器都留着 —— 重启用的是**新** client(它重新登记一条监听器),
    // 所以一次投递要同时喂给它们(这正是僵尸能打到新进程的原因)。
    const transport = {
        sent: [],
        send(msg) { transport.sent.push(msg); return true; },
        onMessage(fn) { bus.push(fn); return () => { const i = bus.indexOf(fn); if (i !== -1) bus.splice(i, 1); }; },
        deliver(msg) { for (const fn of [...bus]) fn(msg); },
    };

    const { createAcpClient } = await import('../electron/agent/acp-client.js');
    // 假监护人的默认握手是"永远不 resolve"(专门给挂住那几条路用的),
    // 而真 acp-client 的 initialize 要等一个**永远不会来的响应**。
    // 这条要真的走完"连上 → 离开 ready → 再连上",所以让握手直接落地 ——
    // 客户端本身走的是真 acp-client(僵尸响应必须由它发出来才算验到)。
    const h = harness({
        promptTimeoutMs: 60000,      // 这一条只盯权限,提示超时别来搅局
        createClient: ({ transport: t }) => createAcpClient({ transport: t, log: { warn() {} } }),
        createSupervisor: (deps) => {
            h.sup.handshake = async () => ({ protocolVersion: 1 });
            h.seen.supervisors.push(deps);
            return h.sup;
        },
    });

    const events = [];
    h.runtime.onEvent((e) => events.push(e));
    // 让假监护人的"传输"就是上面那个观察器:`fakeSupervisor.deliver` 会把消息
    // 喂给它,而真 acp-client 正是在它身上登记 onMessage —— 僵尸响应才有路可走。
    h.sup.transport = transport;
    const permissionId = () => transport.sent.filter(
        (m) => m.id === 900001 && m.method === undefined).length;

    try {
        await h.runtime.start();

        // 1) 旧进程发来一个权限请求,用户还没回答。
        //    ⚠️ 用 `.catch` 接住它的结局:新契约下这个请求会被**丢弃**,
        //    那个 promise 永远不会落地 —— 挂着不管会让整个测试文件卡住。
        transport.deliver({
            jsonrpc: '2.0', id: 900001, method: METHODS.REQUEST_PERMISSION,
            params: { sessionId: 's1', toolCall: { toolCallId: 'c-1', title: '跑命令' }, options: [] },
        });
        await tick();
        assert.equal(events.filter((e) => e.kind === 'permission').length, 1, '旧进程的权限请求要真的到达');
        const stale = h.timers.jobs.filter((j) => j.ms === 5000);
        assert.equal(stale.length, 1, '此刻排着 1 个权限等待定时器');
        const staleJob = stale[0];      // 抓住它:旧契约下它到点会发一个 cancelled 响应

        // 2) 进程离开 ready —— 挂起的权限请求与它的定时器都要被丢掉
        //    (与"用户按了停止 / 进程崩了"是同一条路)。
        h.sup.fire('stopped', new Error('测试：进程没了'));
        await tick();
        assert.equal(h.timers.jobs.filter((j) => j.ms === 5000).length, 0,
            '离开 ready 必须清掉权限等待定时器');

        // 3) 监护人重启 → 新的 controller 与新的 acp-client(它重新登记监听器)
        h.sup.fire('ready');
        transport.deliver({
            jsonrpc: '2.0', id: 900001, method: METHODS.REQUEST_PERMISSION,
            params: { sessionId: 's2', toolCall: { toolCallId: 'c-2', title: '跑命令' }, options: [] },
        });
        await tick();
        const second = events.filter((e) => e.kind === 'permission')[1];
        assert.ok(second, '新进程的权限请求也要到达(否则这条用例什么都没验)');
        assert.equal(permissionId(), 0, '回答之前一个响应都还不该有');

        // 4) 旧的僵尸定时器在**新请求还挂着**的时候到点 —— 这正是最危险的那一刻:
        //    旧契约下它会把一个 cancelled 响应顺着当前 transport 发出去,
        //    对端于是对同一个 id 收到"用户拒绝了" + 后来"用户选了 allow-once"两条。
        await staleJob.fn();
        await tick();
        assert.equal(permissionId(), 0, '僵尸定时器到点后也不许发出任何响应');
        assert.equal(transport.sent.some((m) => m.result?.outcome?.outcome === 'cancelled'),
            false, '绝不许把"用户根本没做过的拒绝"回给新进程');

        // 5) 用户回答新进程那个请求:恰好一个响应,内容是用户真的选的那个
        assert.deepEqual(await h.runtime.answerPermission(second.requestId, 'allow-once'), { ok: true });
        await tick();
        assert.equal(permissionId(), 1, `id 900001 只许有一个响应,实际 ${permissionId()} 个`);
        const answers = transport.sent.filter((m) => m.id === 900001 && m.method === undefined);
        assert.deepEqual(answers[0].result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    } finally {
        await h.runtime.dispose();
    }
});
// ---------------------------------------------------------------------------
// 7) 状态快照与 dispose
// ---------------------------------------------------------------------------

test('status() 是叶子字段快照,带 sessionId 与 busy,可直接 JSON 化', async () => {
    const h = harness();
    try {
        const idle = h.runtime.status();
        assert.deepEqual(Object.keys(idle).sort(),
            ['busy', 'error', 'pid', 'restarts', 'sessionId', 'since', 'state']);
        assert.equal(idle.state, 'stopped');
        assert.equal(idle.sessionId, null);
        assert.equal(idle.busy, false);
        assert.doesNotThrow(() => JSON.stringify(idle));

        await h.runtime.start();
        const sending = settle(h.runtime.send('你好'));
        await tick();
        const running = h.runtime.status();
        assert.equal(running.state, 'ready');
        assert.equal(running.sessionId, 's1');
        assert.equal(running.busy, true);
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;
        assert.equal(h.runtime.status().busy, false);
    } finally {
        await h.runtime.dispose();
    }
});

test('dispose 停进程、释放客户端,并且可以重复调用', async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.dispose();
    assert.equal(h.sup.calls.stop, 1);
    assert.equal(h.client.calls.dispose, 1);
    await h.runtime.dispose();
    assert.equal(h.sup.calls.stop, 1, '重复 dispose 不许再停一次');
});

test('dispose 之后 start/send 当场拒绝,而不是留一个永远不落地的等待', async () => {
    const h = harness();
    await h.runtime.dispose();
    assert.match((await settle(h.runtime.start())).error.message, /dispose|释放/);
    assert.match((await settle(h.runtime.send('你好'))).error.message, /dispose|释放/);
});

// ---------------------------------------------------------------------------
// 接线本身:不注入 exists 时必须落到真实文件系统,而不是抛"接错线"
// ---------------------------------------------------------------------------

test('不注入 exists 时用真实文件系统起真子进程(夹具),走进完整链路', async () => {
    // 这条是**真的起进程**的:假 ACP agent 说真 stdio 协议、零凭证。
    // 它钉的是一个真实存在过的接线错误:runtime 没把 exists 传给纯模块,
    // 于是用户在界面上点「连接」时拿到的是一句"需要 exists"的内部错。
    // 依赖本机有 node 与那个夹具,但**不依赖 dsh、不依赖凭证**。
    const fixture = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');
    assert.equal(fs.existsSync(fixture), true, `夹具应当存在:${fixture}`);

    const events = [];
    const runtime = createAgentRuntime({
        vaultRoot: () => process.cwd(),
        // 真 env:Node 要从 PATH / ProgramFiles 里找出来
        env: { ...process.env, KAIWU_AGENT_SCRIPT: fixture, KAIWU_AGENT_ARGS: '--tool-call --permission' },
        appRoot: process.cwd(),
        log: { warn() {}, error() {} },
        promptTimeoutMs: 20000,
    });
    runtime.onEvent((e) => events.push(e));

    try {
        const started = await runtime.start();
        assert.equal(started.state, 'ready');
        assert.ok(started.pid > 0, '必须真的拿到子进程 pid');

        const sending = runtime.send('你好');
        for (let i = 0; i < 250 && events.filter((e) => e.kind === 'permission').length === 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        const permissions = events.filter((e) => e.kind === 'permission');
        assert.equal(permissions.length, 1, '假 agent 的 --permission 应当弹出一张权限卡片');

        // 权限卡片要能回传:夹具把用户选的选项回显成最后一条增量
        const answered = await runtime.answerPermission(permissions[0].requestId, 'allow-once');
        assert.deepEqual(answered, { ok: true });

        const result = await sending;
        assert.equal(result.stopReason, 'end_turn');
        const texts = events
            .filter((e) => e.kind === 'update')
            .map((e) => e.update?.content?.text ?? '')
            .join('');
        assert.match(texts, /回复0/, '流式增量必须原样推上来');
        assert.match(texts, /权限结果:allow-once/, '用户点的那个选项必须真的到了 agent');
    } finally {
        await runtime.dispose();
    }
});

test('点连接前的接线错误会变成一句中文,而不是一句内部错误', async () => {
    // 没有 node 也没有夹具时,start() 必须给一句能显示的中文(KAIWU_NODE 指路),
    // 而不是 "需要 exists" 那种只有开发者看得懂的话。
    const runtime = createAgentRuntime({
        vaultRoot: () => process.cwd(),
        env: { PATH: '', ProgramFiles: '', KAIWU_NODE: 'C:\\definitely-missing\\node.exe' },
        appRoot: process.cwd(),
        exists: () => false,
        log: { warn() {}, error() {} },
    });
    try {
        const outcome = await settle(runtime.start());
        assert.ok(outcome.error instanceof Error);
        assert.match(outcome.error.message, /Node/);
        assert.match(outcome.error.message, /KAIWU_NODE/);
    } finally {
        await runtime.dispose();
    }
});

// ---------------------------------------------------------------------------
// 8) IPC 接线(agent-ipc):频道、白名单、事件推送
// ---------------------------------------------------------------------------

test('注册的频道就是契约里那 10 个,dispose 全部注销', async () => {
    const h = harness();
    h.handlers = new Map();
    const ipcMain = {
        handle: (channel, fn) => h.handlers.set(channel, fn),
        removeHandler: (channel) => h.handlers.delete(channel),
    };
    const { registerAgentIpc, AGENT_INVOKE_CHANNELS, AGENT_EVENT_CHANNEL } =
        await import('../electron/agent/agent-ipc.js');

    const ipc = registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime });
    const expected = [
        'agent:status', 'agent:credentials', 'agent:start',
        'agent:stop', 'agent:send', 'agent:cancel', 'agent:permission',
        // 按需翻译(思考条上的「译」)。它不是一次提示,所以在契约里单独占一条。
        'agent:translate',
        // 改会话配置(模型 / 思考强度):只递两个字符串,value 是不透明串。
        'agent:setConfig',
        // 换模型之后重新问一次图片能力(桥那边由 kaiwu 自己的补丁提供问法)。
        'agent:capabilities',
    ];
    assert.deepEqual([...AGENT_INVOKE_CHANNELS].sort(), [...expected].sort());
    assert.deepEqual([...h.handlers.keys()].sort(), [...expected].sort());
    assert.equal(AGENT_EVENT_CHANNEL, 'agent:event');

    ipc.dispose();
    assert.equal(h.handlers.size, 0);
    await h.runtime.dispose();
});

test('preload 的白名单与主进程注册的频道一字不差(两边漂移就当场红)', async () => {
    const { AGENT_INVOKE_CHANNELS } = await import('../electron/agent/agent-ipc.js');
    const fs = await import('node:fs');
    const preload = fs.readFileSync(
        new URL('../electron/preload.cjs', import.meta.url), 'utf8');
    for (const channel of AGENT_INVOKE_CHANNELS) {
        assert.ok(preload.includes(`'${channel}'`), `preload 白名单缺 ${channel}`);
    }
    // 反向:白名单里出现的 agent:* 都必须真的注册了。
    // ⚠️ 只扫 ALLOWED_INVOKE 那个数组 —— `agent:event` 是**推送**频道,
    // 它由 onAgentEvent 订阅,按设计就不在 invoke 白名单里。
    const listBlock = preload.slice(
        preload.indexOf('const ALLOWED_INVOKE'),
        preload.indexOf('];', preload.indexOf('const ALLOWED_INVOKE')),
    );
    const listed = [...listBlock.matchAll(/'(agent:[a-zA-Z]+)'/g)].map((m) => m[1]);
    assert.ok(listed.length >= 7, `ALLOWED_INVOKE 里应当有 7 个 agent:* 频道,实际 ${listed.length}`);
    for (const channel of new Set(listed)) {
        assert.ok(AGENT_INVOKE_CHANNELS.includes(channel),
            `preload 放行了没人注册的频道:${channel}`);
    }
    assert.match(preload, /onAgentEvent/, '面板要能订阅 agent:event');
});

test('agent:event 推给渲染进程的是**纯数据**,且窗口销毁后不再推', async () => {
    const h = harness();
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const sent = [];
    const win = { webContents: { send: (channel, payload) => sent.push({ channel, payload }) }, isDestroyed: () => false };
    const ipcMain = { handle: () => {}, removeHandler: () => {} };
    const ipc = registerAgentIpc({ ipcMain, getWindow: () => win, runtime: h.runtime });

    await h.runtime.start();
    await tick();
    assert.ok(sent.length >= 1);
    assert.equal(sent[0].channel, 'agent:event');
    // ⚠️ 不再钉"第一条就是 state":握手成功那一刻会先推一条 **caps**
    //    (对端在 initialize 里广告的能力 —— 图片能力那条链要靠它,见 promptCapabilitiesOf)。
    //    这条用例真正要守的是"推过去的是纯数据、dispose 之后不再推",所以按后者判。
    assert.ok(sent.every((s) => s.channel === 'agent:event'));
    assert.ok(sent.some((s) => s.payload.kind === 'state'), 'start 之后一定有一条 state');
    // 一定是纯数据(能过结构化克隆),而不是活对象
    for (const s of sent) assert.doesNotThrow(() => structuredClone(s.payload));

    ipc.dispose();
    sent.length = 0;
    h.sup.fire('crashed', new Error('炸了'));
    await tick();
    assert.deepEqual(sent, [], 'dispose 之后不许再推(监听器要摘干净)');

    await h.runtime.dispose();
});

// ---------------------------------------------------------------------------
// 8b) agent:start 的失败信息必须**过得了真 IPC**(评审 F3)
//
// 实测(真 Electron 44.4.1):`ipcMain.handle` 里 throw 的 Error 到渲染进程只剩
// message/stack,自定义字段(state/snapshot/code)全丢,message 还被加上
// "Error invoking remote method ..." 前缀。所以"非就绪"这件事不能再靠 reject 传,
// 必须**resolve 一个结果对象**。
// ---------------------------------------------------------------------------

test('runtime.start() 在非就绪时拒绝,而 err.state / err.snapshot 是机器可读的那一份', async () => {
    // 这是 IPC 那一层的**上游**:错误对象上带着 state/snapshot,IPC 才有东西可搬。
    const h = harness();
    h.sup.start = async () => {
        h.sup.setState('failed', new Error('握手超时(20000ms)'));
        const err = new Error('Agent 未就绪(state=failed):握手超时(20000ms)');
        err.state = 'failed';
        err.snapshot = { ...h.sup.status() };
        throw err;
    };
    try {
        const outcome = await settle(h.runtime.start());
        assert.ok(outcome.error instanceof Error, '非就绪必须是拒绝,不许 resolve 一个 failed 快照');
        assert.equal(outcome.error.state, 'failed');
        assert.equal(outcome.error.snapshot.state, 'failed');
        assert.equal(outcome.error.snapshot.pid, null);
        assert.doesNotThrow(() => JSON.stringify(outcome.error.snapshot),
            'snapshot 必须是叶子字段快照(它要能过结构化克隆)');
        assert.match(outcome.error.message, /未就绪|failed/);
    } finally {
        await h.runtime.dispose();
    }
});

test('agent:start 非就绪时返回 {ok:false,state,snapshot,message},而不是 reject', async () => {
    // ⚠️ 契约在 2026-09-18 独立评审后**改过**:原来是"非就绪就 reject,
    // Error 上带 state/snapshot"。真 Electron 上那些字段过不来,面板永远走兜底
    // 分支,还会把 "Error invoking remote method" 前缀写进状态区。
    const h = harness();
    h.sup.start = async () => {
        h.sup.setState('failed', new Error('握手超时(20000ms)'));
        const err = new Error('Agent 未就绪(state=failed):握手超时(20000ms)');
        err.state = 'failed';
        err.snapshot = { ...h.sup.status() };
        throw err;
    };
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime, log: { warn() {} } });

    const outcome = await settle(handlers.get('agent:start')(null, {}));
    assert.equal(outcome.error, undefined, '非就绪不许再 reject —— 那条路上的字段过不了 IPC');
    assert.equal(outcome.value.ok, false);
    assert.equal(outcome.value.state, 'failed', '机器可读的 state 要在**返回值**里');
    assert.equal(outcome.value.snapshot.state, 'failed', 'snapshot 要在**返回值**里');
    assert.equal(outcome.value.snapshot.pid, null);
    assert.match(outcome.value.message, /未就绪|failed/);
    assert.equal(outcome.value.message.includes('Error invoking remote method'), false,
        '返回体里不许出现 Electron 给 reject 加的前缀');
    assert.doesNotThrow(() => structuredClone(outcome.value), '返回体要能过一次真 IPC 的结构化克隆');
    await h.runtime.dispose();
});

test('agent:start 成功时返回 {ok:true,status}', async () => {
    const h = harness();
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime, log: { warn() {} } });

    const outcome = await settle(handlers.get('agent:start')(null, {}));
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value.ok, true);
    assert.equal(outcome.value.status.state, 'ready');
    assert.equal(outcome.value.status.pid, 1);
    await h.runtime.dispose();
});

// ⚠️ 原来那条用例名说的是"err.state / err.snapshot 过 IPC",但在真 Electron 上
// **那两个字段根本过不来** —— 断言之所以绿,是因为它只到 ipcMain handler 这一层。
// 按新契约把它**改写**成上面那几条(返回 {ok:false,...});这种"名字比断言强"的
// 写法正是 F3 能躲过那些用例的原因,不能再留。
test('没有选库时 agent:start 也带一句能显示的中文原因(程序性错误照旧 reject)', async () => {
    // 没有 Vault 是**程序性**错误(不是"非就绪"),所以它照旧 reject ——
    // 别把接线错误也包装成 {ok:false},那会让面板把它当成"Agent 没连上"。
    const h = harness({ vaultRoot: () => null });
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime, log: { warn() {} } });

    const outcome = await settle(handlers.get('agent:start')(null, {}));
    assert.ok(outcome.error instanceof Error);
    assert.match(outcome.error.message, /笔记库|Vault/);
    await h.runtime.dispose();
});

test('agent:send 的 text 必须是非空字符串;agent:permission 的两个字段必填', async () => {
    const h = harness();
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime, log: { warn() {} } });

    assert.match((await settle(handlers.get('agent:send')(null, { text: '   ' }))).error.message, /text/);
    assert.match((await settle(handlers.get('agent:send')(null, {}))).error.message, /text/);
    assert.match((await settle(handlers.get('agent:permission')(null, { optionId: 'x' }))).error.message, /requestId/);
    assert.match((await settle(handlers.get('agent:permission')(null, { requestId: 'x' }))).error.message, /optionId/);
    await h.runtime.dispose();
});

test('agent:send 的图片在**主进程这一侧**校验:不合规的当场拒,并给出可读中文', async () => {
    // 截图来自剪贴板,渲染进程是不可信输入。这条钉的是"边界上真的判了",
    // 而不是"界面上判过了所以主进程照收"。
    const h = harness();
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime, log: { warn() {} } });
    const send = (payload) => handlers.get('agent:send')(null, payload);

    const wrongType = await settle(send({ text: '看', images: [{ mimeType: 'image/bmp', bytes: [...PNG_BYTES] }] }));
    assert.match(wrongType.error.message, /不支持的图片格式/);

    const lyingBytes = await settle(send({ text: '看', images: [{ mimeType: 'image/png', bytes: [0x3c, 0x68] }] }));
    assert.match(lyingBytes.error.message, /字节不是 PNG/);

    const notBytes = await settle(send({ text: '看', images: [{ mimeType: 'image/png', bytes: 'AAAA' }] }));
    assert.match(notBytes.error.message, /字节不是一个字节数组/);

    const tooMany = await settle(send({
        text: '看',
        images: Array.from({ length: 5 }, () => ({ mimeType: 'image/png', bytes: [...PNG_BYTES] })),
    }));
    assert.match(tooMany.error.message, /一次最多发 4 张图/);

    const emptyBoth = await settle(send({ text: '   ', images: [] }));
    assert.match(emptyBoth.error.message, /text 不能为空/);

    assert.equal(h.client.calls.prompt.length, 0, '被拒的提示一条都不许落到对端');
    await h.runtime.dispose();
});

test('agent:send 只认叶子字段:渲染进程塞进来的路径/命令/环境变量一概进不去', async () => {
    // 与"渲染进程只能递 text / requestId / optionId"同一条边界规矩。
    const h = harness();
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime, log: { warn() {} } });

    try {
        await h.runtime.start();
        const inFlight = handlers.get('agent:send')(null, {
            text: '',
            images: [{
                mimeType: 'image/png',
                bytes: [...PNG_BYTES],
                // 这些字段必须被忽略(只取 mimeType/bytes)
                path: 'C:\\Windows\\System32\\cmd.exe',
                command: 'rm -rf /',
                env: { DSH_PERMISSION_MODE: 'danger-full-access' },
            }],
        });
        await tick();

        assert.equal(h.client.calls.prompt.length, 1);
        assert.deepEqual(Object.keys(h.client.calls.prompt[0].images[0]).sort(), ['bytes', 'mimeType'],
            '多出来的字段一个都不许带到对端去');
        assert.equal(h.client.calls.prompt[0].text, '', '只有图片时 text 就是空串');

        h.client.resolvePrompt({ stopReason: 'end_turn' });
        const r = await inFlight;
        assert.equal(r.stopReason, 'end_turn');
    } finally {
        await h.runtime.dispose();
    }
});

// ---------------------------------------------------------------------------
// 6b) 提问:同一个 session/request_permission 通道,但 kind 是 question
// ---------------------------------------------------------------------------
//
// 模型的 ask_user_question 在 DSH 那边等一个回答者,而 ACP 没有"问用户"这个方法 ——
// kaiwu 给桥打的补丁把它映射成一次 session/request_permission,并用 toolCall.kind
// 当暗号("question")。于是这里要做的事很小:把暗号与选项说明如实带过 IPC,
// 界面据此画"提问卡"。回答走的还是 agent:permission 那条老路(不新开频道)。

test('提问:kind=question 的反向请求要标成"提问",并带上选项说明', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        h.client.deliver({
            jsonrpc: '2.0',
            id: 900003,
            method: METHODS.REQUEST_PERMISSION,
            params: {
                sessionId: 's1',
                toolCall: { toolCallId: 'ask:impl', title: '实现方式:选 A 还是选 B?', kind: 'question' },
                options: [
                    { optionId: 'q0', name: 'A:共用解析', kind: 'allow_once', description: '零重复' },
                    { optionId: 'q1', name: 'B:另写一份', kind: 'allow_once', description: '维护两份' },
                ],
            },
        });

        const perm = events.find((e) => e.kind === 'permission');
        assert.equal(perm.question, true, '界面据此画"提问卡",而不是"授权卡"');
        assert.deepEqual(perm.toolCall,
            { toolCallId: 'ask:impl', title: '实现方式:选 A 还是选 B?', kind: 'question' });
        assert.deepEqual(perm.options, [
            { optionId: 'q0', name: 'A:共用解析', kind: 'allow_once', description: '零重复' },
            { optionId: 'q1', name: 'B:另写一份', kind: 'allow_once', description: '维护两份' },
        ]);
    } finally {
        await h.runtime.dispose();
    }
});

test('普通权限请求不许被标成提问;说明字段缺失时补空串(叶子字段要稳定)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        h.client.deliver({
            jsonrpc: '2.0',
            id: 900004,
            method: METHODS.REQUEST_PERMISSION,
            params: {
                sessionId: 's1',
                toolCall: { toolCallId: 'call-9', title: '运行命令', kind: 'execute' },
                options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
            },
        });

        const perm = events.find((e) => e.kind === 'permission');
        assert.equal(perm.question, false, '只有 kind=question 才算提问,别的一律当授权');
        assert.deepEqual(perm.options,
            [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once', description: '' }]);
    } finally {
        await h.runtime.dispose();
    }
});

// ---------------------------------------------------------------------------
// 黏贴截图:发送那一段
// ---------------------------------------------------------------------------
//
// 运行时是"渲染进程递来的字节"与"ACP 客户端"之间的那一层。它必须:
//   1. 把图片与文字**一起**送进同一次 prompt(分两次发模型就对不上了);
//   2. 允许"只有图片、没有文字";
//   3. 对渲染进程递来的字节再判一遍(不可信输入),拒了要说人话;
//   4. 桥因为不支持图片而拒掉时,把英文换成一句能读的中文。

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x2a]);

test('带图片的提示:图片与文字一起进**同一次** prompt(不是两条消息)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const inFlight = h.runtime.send('看这张图', {
            images: [{ mimeType: 'image/png', bytes: PNG_BYTES }],
        });
        await tick();

        assert.equal(h.client.calls.prompt.length, 1, '一次提示只许有**一条** session/prompt');
        assert.equal(h.client.calls.prompt[0].text, '看这张图');
        assert.deepEqual(h.client.calls.prompt[0].images.map(i => i.mimeType), ['image/png']);
        assert.deepEqual([...h.client.calls.prompt[0].images[0].bytes], [...PNG_BYTES],
            '字节要原样递给客户端(再过它手上变成线上 base64)');

        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await inFlight;
    } finally {
        await h.runtime.dispose();
    }
});

test('没有图片时 images 是空数组 —— 纯文本那条路一个字段都不多', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const inFlight = h.runtime.send('你好');
        await tick();

        assert.equal(h.client.calls.prompt[0].images.length, 0);
        assert.equal(h.client.calls.prompt[0].text, '你好');

        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await inFlight;
    } finally {
        await h.runtime.dispose();
    }
});

test('只有图片、没有文字也发得出去(黏贴一张截图直接发)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const inFlight = h.runtime.send('', { images: [{ mimeType: 'image/png', bytes: PNG_BYTES }] });
        await tick();

        assert.equal(h.client.calls.prompt.length, 1);
        assert.equal(h.client.calls.prompt[0].text, '');
        assert.equal(h.client.calls.prompt[0].images.length, 1);

        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await inFlight;
    } finally {
        await h.runtime.dispose();
    }
});

test('文字与图片都没有时仍然拒绝(那条闸不许被图片顶开)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        await assert.rejects(() => h.runtime.send('   ', { images: [] }), /提示内容不能为空/);
        await assert.rejects(() => h.runtime.send('', {}), /提示内容不能为空/);
        assert.equal(h.client.calls.prompt.length, 0, '一条都不许发出去');
    } finally {
        await h.runtime.dispose();
    }
});

test('渲染进程递来的字节不可信:主进程这一层再判一遍,拒了要说人话', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        await assert.rejects(
            () => h.runtime.send('看', { images: [{ mimeType: 'image/png', bytes: [0x3c, 0x68, 0x74, 0x6d, 0x6c] }] }),
            /字节不是 PNG/);
        await assert.rejects(
            () => h.runtime.send('看', { images: [{ mimeType: 'image/bmp', bytes: [...PNG_BYTES] }] }),
            /不支持的图片格式/);
        await assert.rejects(
            () => h.runtime.send('看', { images: 'not-an-array' }),
            /必须是一个数组/);
        assert.equal(h.client.calls.prompt.length, 0, '被拒的提示不许落到对端');
    } finally {
        await h.runtime.dispose();
    }
});

test('桥因为"这条连接没广告图片能力"拒掉时,界面上收到一句中文(原文也留着)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        const inFlight = h.runtime.send('看', { images: [{ mimeType: 'image/png', bytes: PNG_BYTES }] });
        await tick();
        h.client.rejectPrompt(Object.assign(
            new Error('ACP 错误 -32602:inline image prompts were not advertised by this connection'),
            { code: -32602 }));

        await assert.rejects(() => inFlight);
        const failed = events.find((e) => e.kind === 'prompt-error');
        assert.ok(failed !== undefined, '必须有一条 prompt-error');
        assert.match(failed.message, /没有广告图片能力/, '对用户要说中文');
        assert.match(failed.message, /换成支持图片的模型/, '而且给出下一步');
        assert.match(failed.message, /原话:/, '原文不许被丢掉(排查时只有它有用)');
    } finally {
        await h.runtime.dispose();
    }
});

test('纯文本失败时不许被硬翻成"图片问题"(只认得出图片那两句才换)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        const inFlight = h.runtime.send('你好');
        await tick();
        h.client.rejectPrompt(Object.assign(
            new Error('ACP 错误 -32603:no API key configured'), { code: -32603 }));

        await assert.rejects(() => inFlight);
        const failed = events.find((e) => e.kind === 'prompt-error');
        assert.match(failed.message, /-32603/);
        assert.equal(failed.message.includes('图片'), false);
        assert.equal(failed.missingCredential, true, '凭证判定照旧(这条不能被图片那段挡掉)');
    } finally {
        await h.runtime.dispose();
    }
});
// ---------------------------------------------------------------------------
// 「默认思考强度为中」由 kaiwu 自己保证(见 agent-runtime 的 pinEffort)
//
// 两条口子都是**实测**出来的,不是设想:
//   · 新会话:session/new 回的强度是对端按**自己的配置**定的(本机实测 high);
//   · 换模型:对端会把强度**打回新模型的默认值**(实测:设成 low 之后再换模型,回来是 high)。
// 这一组用例把"补"的边界钉死:该补时补、不该补时一个请求都不发、补不上不许弄失败。
// ---------------------------------------------------------------------------

test('新会话:对端默认不是「中」时,kaiwu 补成「中」再报给界面', async () => {
    const h = harness();
    try {
        h.client.setSessionConfig(effortConfig('off'));
        h.client.onSetConfig = ({ configId, value }) => ({
            configOptions: effortConfig(configId === 'reasoning_effort' ? value : 'off'),
        });
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        const sending = settle(h.runtime.send('你好'));
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;

        assert.deepEqual(h.client.calls.setConfig,
            [{ sessionId: 's1', configId: 'reasoning_effort', value: 'high' }]);
        const session = events.find((e) => e.kind === 'session');
        assert.equal(effortOf(session.configOptions), 'high',
            '面板拿到的那份必须是**补完**之后的(否则界面先亮对端的默认值再跳一下)');
    } finally {
        await h.runtime.dispose();
    }
});

test('新会话:对端默认本来就是「中」时一个请求都不发', async () => {
    const h = harness();
    try {
        h.client.setSessionConfig(effortConfig('high'));
        await h.runtime.start();
        const sending = settle(h.runtime.send('你好'));
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;

        assert.equal(h.client.calls.setConfig.length, 0,
            '对端已经给中就不许再跑一趟 —— 这是常态路径,不许有额外往返');
    } finally {
        await h.runtime.dispose();
    }
});

test('新会话:对端没有强度这一项 / 梯子上没有「中」时,绝不臆造一个值发出去', async () => {
    const h = harness();
    try {
        // ① 对端压根没广告这一项
        h.client.setSessionConfig(effortConfig('off', { effort: false }));
        await h.runtime.start();
        const first = settle(h.runtime.send('你好'));
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await first;
        assert.equal(h.client.calls.setConfig.length, 0, '对端没这一项:没有可补的');

        // ② 有这一项,但那条梯子上没有"中"(off / max)
        h.client.setSessionConfig(effortConfig('off', { levels: ['off', 'max'] }));
        const second = settle(h.runtime.send('再来一条'));
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await second;
        assert.equal(h.client.calls.setConfig.length, 0, '梯子上没有中:不许硬塞一个它没广告过的值');
    } finally {
        await h.runtime.dispose();
    }
});

test('换模型:对端把强度打回默认时,kaiwu 把用户选的那一档补回来', async () => {
    const h = harness();
    try {
        h.client.setSessionConfig(effortConfig('high'));   // 新会话已经是中 → 不补
        // 照真桥的行为演:改强度就生效;换模型会把强度打回该模型的默认值 high。
        h.client.onSetConfig = ({ configId, value }) => ({
            configOptions: effortConfig(configId === 'reasoning_effort' ? value : 'high'),
        });
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        await h.runtime.setConfig({ configId: 'reasoning_effort', value: 'low' });
        assert.deepEqual(h.client.calls.setConfig.map((c) => c.configId), ['reasoning_effort'],
            '改强度**本身**不许再多发一次 —— 那等于把用户刚下的指令顶回去');

        await h.runtime.setConfig({ configId: 'model', value: '["fake","b"]' });

        assert.deepEqual(h.client.calls.setConfig.map((c) => [c.sessionId, c.configId, c.value]), [
            ['s1', 'reasoning_effort', 'low'],
            ['s1', 'model', '["fake","b"]'],
            ['s1', 'reasoning_effort', 'low'],           // ← 被打回之后补回来
        ]);
        const last = events.filter((e) => e.kind === 'config').at(-1);
        assert.equal(last.configId, 'model', '事件仍是那条"换模型",不许冒出一条假的配置变更');
        assert.equal(effortOf(last.configOptions), 'low', '报给界面的不能是被打回的那一份');
    } finally {
        await h.runtime.dispose();
    }
});

test('补强度失败:留一条日志,但**不许**把建会话 / 换模型弄失败', async () => {
    const warned = [];
    const h = harness({ log: { warn: (...args) => warned.push(args), error() {}, log() {} } });
    try {
        h.client.setSessionConfig(effortConfig('off'));
        h.client.onSetConfig = () => { throw new Error('ACP 错误 -32602:不认识的档位'); };
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        const sending = settle(h.runtime.send('你好'));
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        const outcome = await sending;

        assert.equal(outcome.error, undefined, '补强度失败不该把这一轮弄失败');
        const session = events.find((e) => e.kind === 'session');
        assert.equal(effortOf(session.configOptions), 'off',
            '补不上就照对端给的原样报给界面 —— 不许编一个"其实没生效"的中');
        assert.equal(warned.length, 1, '失败要留日志,否则"强度没生效"这事查不出来');
    } finally {
        await h.runtime.dispose();
    }
});

// ---------------------------------------------------------------------------
// 「AI 会话」那栏的底子:记账 / 问对端清单 / 切会话
//
// 三条边界最要紧,都有实测依据:
//   · 记的是**气泡里那句**,不是裹着笔记上下文的整段(否则铺回历史时用户会看到自己没打过的东西);
//   · 没连接时**不为了画清单去拉进程**,而且要说"还没连接"而不是"没有";
//   · 对端 `session/list` **不列正在活跃的会话** → 活跃那一份必须我方自己记着。
// ---------------------------------------------------------------------------

/** 只记调用的假台账(真台账那层由 tests/session-ledger.test.js 用真 fs 钉)。 */
function fakeLedger() {
    const calls = { begin: [], user: [], update: [], end: [], model: [], flush: 0 };
    return {
        calls,
        begin: async (info) => { calls.begin.push(info); return info; },
        user: (info) => { calls.user.push(info); return info; },
        text: (info) => { calls.text = info; return info; },
        update: (info) => { calls.update.push(info); return info; },
        end: (info) => { calls.end.push(info); return info; },
        model: (info) => { calls.model.push(info); return info; },
        peek: () => null,
        flush: async () => { calls.flush += 1; return []; },
        close: async () => {},
        list: async () => ({ ok: true, rows: [], dir: null }),
        read: async () => ({ ok: false, reason: '没记', record: null }),
        remove: async () => ({ ok: true, removed: false }),
    };
}

/** 让一个会话真的建起来(发一条并收场)。 */
async function openSession(h, text = '你好') {
    const sending = settle(h.runtime.send(text));
    await tick();
    h.client.resolvePrompt({ stopReason: 'end_turn' });
    await sending;
}

test('记账:send 记的是**气泡里那句**,不是裹着笔记上下文的整段', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('【笔记:甲篇】\n\n用户真打的那句', { shown: '用户真打的那句' }));
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;

        assert.equal(led.calls.user.length, 1);
        assert.equal(led.calls.user[0].text, '用户真打的那句');
        assert.equal(led.calls.user[0].id, 's1');
        // 老调用方没给 shown 时退回整段(那至少没丢内容)
        const again = settle(h.runtime.send('第二句', {}));
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await again;
        assert.equal(led.calls.user[1].text, '第二句');
    } finally {
        await h.runtime.dispose();
    }
});

test('记账:建会话就开个头(带模型与强度),增量与收尾都进去', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        h.client.setSessionConfig(effortConfig('high'));
        await h.runtime.start();
        const sending = settle(h.runtime.send('问', { shown: '问' }));
        await tick();
        h.client.calls.prompt[0].onUpdate({
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答' },
        });
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;

        assert.equal(led.calls.begin.length, 1, '会话一开始就记,不等到收尾');
        assert.equal(led.calls.begin[0].id, 's1');
        assert.equal(led.calls.begin[0].cwd, 'E:\\vault-a');
        assert.equal(led.calls.begin[0].model, 'A', '模型名取的是对端清单里的 name');
        assert.equal(led.calls.begin[0].effort, '中', 'high 的短名就是中');
        assert.equal(led.calls.update.length, 1);
        assert.equal(led.calls.update[0].update.sessionUpdate, 'agent_message_chunk');
        assert.equal(led.calls.end.length, 1);
        assert.equal(led.calls.end[0].stopReason, 'end_turn');
    } finally {
        await h.runtime.dispose();
    }
});

test('记账:失败的那一轮把错误也记下来(清单上要能看见"最后一条错")', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('问', { shown: '问' }));
        await tick();
        h.client.rejectPrompt(new Error('ACP 错误 -32603:no API key configured'));
        await sending;
        assert.equal(led.calls.end.length, 1);
        assert.match(led.calls.end[0].error, /no API key/);
    } finally {
        await h.runtime.dispose();
    }
});

test('会话清单:没连接时不为了画清单去拉进程,而且如实说"还没连接"', async () => {
    const h = harness();
    try {
        const r = await h.runtime.listPeerSessions();
        assert.equal(r.ok, false);
        assert.equal(r.reason, '还没连接');
        assert.deepEqual(r.sessions, []);
        assert.equal(h.sup.calls.start, 0, '问清单不许顺手把外部进程拉起来');
        assert.equal(h.runtime.sessionsInfo().peer.ask, false, '没问到就是不知道');
    } finally {
        await h.runtime.dispose();
    }
});

test('会话清单:连上之后问对端,活跃那一份一起报给界面', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        h.client.listResult = { sessions: [{ sessionId: 's-old', cwd: 'E:\\vault-a' }], nextCursor: null };
        const r = await h.runtime.listPeerSessions();
        assert.equal(r.ok, true);
        assert.deepEqual(r.sessions.map((s) => s.sessionId), ['s-old']);
        assert.deepEqual(h.client.calls.listSessions, [{ cwd: 'E:\\vault-a' }], '按当前库问');
        const info = h.runtime.sessionsInfo();
        assert.equal(info.peer.ask, true);
        assert.deepEqual(info.peer.ids, ['s-old']);
        assert.equal(info.current, null, '还没建会话就没有"当前"');
    } finally {
        await h.runtime.dispose();
    }
});

test('切会话:已经接上过的 → 本地切,不再问对端(问了会被"已活跃"拒掉)', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        h.client.setSessionConfig(effortConfig('high'));
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        await openSession(h);

        const r = await h.runtime.activateSession('s1');
        assert.equal(r.reused, true);
        assert.equal(h.client.calls.resume.length, 0, '本地切不该发 resume');
        assert.equal(h.runtime.sessionsInfo().current, 's1');
        const session = events.filter((e) => e.kind === 'session').at(-1);
        assert.equal(session.resumed, true, '带 resumed 就是"请把历史铺出来"的信号');
        assert.equal(session.reused, true);
    } finally {
        await h.runtime.dispose();
    }
});

test('切会话:没接上过的 → resume,并把"铺历史"的信号报给界面', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        h.client.setSessionConfig(effortConfig('high'));
        await h.runtime.start();
        h.client.resumeResult = { configOptions: effortConfig('high') };
        const events = [];
        h.runtime.onEvent((e) => events.push(e));

        const r = await h.runtime.activateSession('s-old');
        assert.equal(r.sessionId, 's-old');
        assert.equal(r.reused, false);
        assert.deepEqual(h.client.calls.resume, [{ sessionId: 's-old', cwd: 'E:\\vault-a' }]);
        const info = h.runtime.sessionsInfo();
        assert.equal(info.current, 's-old');
        assert.deepEqual(info.live, ['s-old'], '接上之后它算"正在聊"');
        const session = events.filter((e) => e.kind === 'session').at(-1);
        assert.equal(session.sessionId, 's-old');
        assert.equal(session.resumed, true);
        assert.ok(Array.isArray(session.configOptions));
        const began = led.calls.begin.at(-1);
        assert.equal(began.id, 's-old', '接回来的会话也要有记录(接着原来那份写)');
    } finally {
        await h.runtime.dispose();
    }
});

test('切会话:对端说"属于另一个库" → 抛一句中文(附原话),不许糊过去', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        h.client.onResume = () => { throw new Error('Invalid params: session cwd does not match: E:\\other'); };
        await assert.rejects(() => h.runtime.activateSession('s-x'), (err) => {
            assert.match(err.message, /另一个笔记库/);
            assert.match(err.message, /原话/, '认出来的那半句之外,原文也要留着');
            return true;
        });
    } finally {
        await h.runtime.dispose();
    }
});

test('切会话:对端说"已经开着" → 当作可用(本地接上,不把用户挡在门外)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        h.client.onResume = () => { throw new Error('Invalid params: session is already active: s-x'); };
        const r = await h.runtime.activateSession('s-x');
        assert.equal(r.sessionId, 's-x');
        assert.equal(r.reused, true);
        assert.equal(h.runtime.sessionsInfo().current, 's-x');
    } finally {
        await h.runtime.dispose();
    }
});

test('切会话:在飞的一轮不许切(会换掉上下文)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('问', { shown: '问' }));
        await tick();
        await assert.rejects(() => h.runtime.activateSession('s-old'), /还没结束/);
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;
    } finally {
        await h.runtime.dispose();
    }
});

test('进程走了:活跃标记与那份清单**都作废**(不许拿旧标记骗人)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        h.client.listResult = { sessions: [{ sessionId: 's-old', cwd: 'E:\\vault-a' }] };
        await h.runtime.listPeerSessions();
        await openSession(h);
        assert.equal(h.runtime.sessionsInfo().peer.ask, true);

        h.sup.fire('crashed');
        await tick();
        const info = h.runtime.sessionsInfo();
        assert.equal(info.current, null);
        assert.deepEqual(info.live, [], '进程没了,对端那边的会话全没了');
        assert.equal(info.peer.ask, false, '清单也作废:下次要重新问');
    } finally {
        await h.runtime.dispose();
    }
});

test('台账:dispose 时把记录落干净(这是最后的机会)', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    await h.runtime.start();
    await openSession(h);
    const before = led.calls.flush;
    await h.runtime.dispose();
    assert.ok(led.calls.flush > before, 'dispose 必须再冲一次盘');
});

// ---------------------------------------------------------------------------
// 「＋ 新建会话」(用户拍板的是**立刻建**:点了就对端真的 session/new)
//
// 三条边界必须钉住,它们各自对应一个真实的坑:
//   · 旧会话**不许**从"这条连接接上过的"里消失 —— 对端那边它仍然活跃,而 list 又不列活跃会话,
//     忘了它就会被面板误判成「上下文已不在」,点它还会被 already active 拒掉;
//   · 在飞的一轮不许新建(会换掉上下文);
//   · 建不出来要把"放下当前会话"这一步**收回去**,否则界面清空了却一条会话都没有。
// ---------------------------------------------------------------------------

test('新建会话:点了立刻真的建一条(带 fresh 标记),旧会话仍算"还开着"', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        h.client.setSessionConfig(effortConfig('high'));
        await h.runtime.start();
        const events = [];
        h.runtime.onEvent((e) => events.push(e));
        await openSession(h);                       // s1
        assert.equal(h.runtime.sessionsInfo().current, 's1');

        const r = await h.runtime.beginNewSession();
        assert.equal(r.sessionId, 's2', '对端真的又开了一条');
        assert.equal(r.previous, 's1');
        assert.equal(h.client.calls.newSession, 2);
        const info = h.runtime.sessionsInfo();
        assert.equal(info.current, 's2');
        assert.deepEqual(info.live.slice().sort(), ['s1', 's2'], '旧会话仍在"接上过"的名单里(否则会被误判成已不在)');
        const session = events.filter((e) => e.kind === 'session').at(-1);
        assert.equal(session.sessionId, 's2');
        assert.equal(session.fresh, true, 'fresh 就是"界面请把对话区清空"的信号');
        assert.ok(led.calls.begin.some((b) => b.id === 's2'), '新会话当场建档(0 轮)');
    } finally {
        await h.runtime.dispose();
    }
});

test('新建会话:在飞的一轮不许建(与切会话同一条纪律)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        const sending = settle(h.runtime.send('问', { shown: '问' }));
        await tick();
        await assert.rejects(() => h.runtime.beginNewSession(), /还没结束/);
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;
    } finally {
        await h.runtime.dispose();
    }
});

test('新建会话:建不出来 → 把"放下当前会话"收回去(不许清空了却没有会话)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        await openSession(h);                        // s1
        h.client.newSession = async () => { throw new Error('对端不干了'); };
        await assert.rejects(() => h.runtime.beginNewSession(), /对端不干了/);
        assert.equal(h.runtime.sessionsInfo().current, 's1', '失败要回到原来那条,不能变成"没有会话"');
    } finally {
        await h.runtime.dispose();
    }
});

test('会话快照带上 busy(面板据此把「新建会话」按灰)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        assert.equal(h.runtime.sessionsInfo().busy, false);
        const sending = settle(h.runtime.send('问', { shown: '问' }));
        await tick();
        assert.equal(h.runtime.sessionsInfo().busy, true, '在飞的一轮:busy 必须是 true');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;
        assert.equal(h.runtime.sessionsInfo().busy, false);
    } finally {
        await h.runtime.dispose();
    }
});

test('agent:send 要把 shown(气泡那一句)一起转交 —— 台账记的是它,不是整段笔记上下文', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime, log: { warn() {} } });
    try {
        await h.runtime.start();
        const inFlight = handlers.get('agent:send')(null, {
            text: '【笔记:甲篇】\n甲篇的正文\n\n问题:你好',
            shown: '你好',
        });
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await inFlight;
        assert.equal(led.calls.user.length, 1);
        assert.equal(led.calls.user[0].text, '你好', '记下来的必须是气泡里那句');
        assert.equal(h.client.calls.prompt[0].text, '【笔记:甲篇】\n甲篇的正文\n\n问题:你好',
            '发给对端的仍然带笔记上下文 —— 两件事互不影响');
    } finally {
        await h.runtime.dispose();
    }
});

// ---------------------------------------------------------------------------
// 启动时自动建会话(「一进程序,胶囊就能用」)
//
// 产品行为:程序一启动、**还没发任何消息**时,会话就已经建好 —— 于是输入行右边那枚
// 「思考强度 / 模型」胶囊一进来就有对端给的真档位(滑块能拖、模型能换),而不是
// 只有一句"还没建会话"。触发点在**主进程的 agent 运行时**(ACP 握手成功 = ready
// 那一刻),不在渲染层:渲染层那条路会连带把台账写成 0 轮空记录,而且"谁负责建会话"
// 会散到 UI 层 —— 而"当前到底有没有会话"只有这里知道。
//
// ⚠️ 假监护人(harness 里的那个)的 `start()` **不推** ready 通知(它直接改 state);
//    真监护人是在 setState('ready') 里推的。所以这一组里凡是要验"ready 那一刻"的
//    用例,都显式 `h.sup.fire('ready')` 制造那次转换 —— 那也是崩溃重启后的那条路。
// ---------------------------------------------------------------------------

test('ready 之后自动建一条会话:不必先发消息,界面立刻拿到对端的档位', async () => {
    const h = harness();
    const events = [];
    h.runtime.onEvent((e) => events.push(e));
    try {
        h.client.setSessionConfig(effortConfig('high'));
        await h.runtime.start();
        assert.equal(h.client.calls.newSession, 0, '还没 ready:一条会话都不许建(那是白跑一趟)');

        h.sup.fire('ready');
        await tick();

        assert.equal(h.client.calls.newSession, 1, 'ready 之后应当自动建一条会话');
        assert.equal(h.runtime.status().sessionId, 's1');
        const session = events.filter((e) => e.kind === 'session').pop();
        assert.ok(session, '界面必须收到 session 事件 —— 否则胶囊还是空的(那就是这次要修的现象)');
        assert.equal(session.sessionId, 's1');
        assert.equal(effortOf(session.configOptions), 'high',
            '报给界面的必须是**对端那份** configOptions(档位/模型都从它来)');
        assert.equal(h.client.calls.setConfig.length, 0, '对端已经给「中」:不许有额外往返');
    } finally {
        await h.runtime.dispose();
    }
});

test('已经有会话时 ready 再来几次:不许再建(去重,不堆空会话)', async () => {
    const h = harness();
    try {
        await h.runtime.start();
        h.sup.fire('ready');
        await tick();
        assert.equal(h.client.calls.newSession, 1);
        const sid = h.runtime.status().sessionId;

        // 同一条连接里重复到达的 ready(重连握手/重复通知):**一个请求都不发**
        h.sup.fire('ready');
        await tick();
        h.sup.fire('ready');
        await tick();

        assert.equal(h.client.calls.newSession, 1, 'ready 重复到达不许堆会话');
        assert.equal(h.runtime.status().sessionId, sid, '当前会话不许被换掉');
    } finally {
        await h.runtime.dispose();
    }
});

test('自动建会话失败:log.error + session-error 事件都留下(不许静默),而且只试一次', async () => {
    const logged = [];
    const h = harness({ log: { warn() {}, error: (...a) => logged.push(a), log() {} } });
    const events = [];
    h.runtime.onEvent((e) => events.push(e));
    h.client.newSession = async () => {
        h.client.calls.newSession += 1;
        throw new Error('对端不肯建会话');
    };
    try {
        await h.runtime.start();
        h.sup.fire('ready');
        await tick();

        assert.equal(h.client.calls.newSession, 1, '只许试一次 —— 绝不排定时器反复重试(重试风暴)');
        assert.equal(h.timers.jobs.length, 0, '不许留下任何重试定时器');
        assert.equal(logged.length, 1, '失败必须留下一条 error 日志(不许静默)');
        assert.match(String(logged[0].join(' ')), /自动建会话失败/);
        const failure = events.find((e) => e.kind === 'session-error');
        assert.ok(failure, '界面必须收到 session-error —— 否则用户只看到"还没建会话",不知道是坏了');
        assert.match(failure.message, /不肯建会话/);
        assert.equal(h.runtime.status().sessionId, null, '失败了就是没有会话,不许编一个出来');

        // 新的 ready(新进程)= **新的一次**尝试,而不是同一进程里反复重试
        h.sup.fire('ready');
        await tick();
        assert.equal(h.client.calls.newSession, 2, '新的 ready 再试一次:总共两次,不是风暴');
    } finally {
        await h.runtime.dispose();
    }
});

test('session/new 还在飞的时候进程走了:落地也不许把会话 id 留下(会话不许活过进程)', async () => {
    const h = harness();
    let release = null;
    h.client.newSession = () => {
        h.client.calls.newSession += 1;
        return new Promise((resolve) => { release = resolve; });
    };
    try {
        await h.runtime.start();
        h.sup.fire('ready');
        await tick();
        assert.equal(typeof release, 'function', '这一刻 session/new 应当在飞');
        assert.equal(h.runtime.status().sessionId, null, '还没落地:先没有会话');

        // 对端还没回答,进程就没了(用户按停止 / 崩溃 / 换库都是这一类)
        h.sup.fire('stopped', new Error('测试制造的停止'));
        await tick();
        release({ sessionId: 's-late', configOptions: [] });
        await tick();

        assert.equal(h.runtime.status().sessionId, null,
            '属于一个已经不存在的进程的会话,绝不许写进 sessionId(否则下一条提示必然"会话不存在")');
    } finally {
        await h.runtime.dispose();
    }
});

test('自动建的会话**不立刻落台账**:推迟到第一条用户消息(否则每次启动多一个空记录)', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        h.client.setSessionConfig(effortConfig('high'));
        await h.runtime.start();
        h.sup.fire('ready');
        await tick();

        assert.equal(h.runtime.status().sessionId, 's1', '会话本身照旧**立刻**存在(胶囊马上能用)');
        assert.equal(led.calls.begin.length, 0, '这一刻台账里一个字都不许写 —— 它是 0 轮的空记录');

        // 用户说了第一句:台账这时才开头,而且带的是**当前**的模型与强度
        const sending = settle(h.runtime.send('第一句'));
        await tick();
        assert.equal(led.calls.begin.length, 1, '第一条用户消息一到,台账才开头');
        assert.equal(led.calls.begin[0].id, 's1');
        assert.equal(led.calls.begin[0].cwd, 'E:\\vault-a');
        assert.equal(led.calls.begin[0].effort, '中');
        assert.deepEqual(led.calls.user.map((u) => u.text), ['第一句'], '那句话不许丢');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;
        assert.equal(led.calls.end.length, 1);
    } finally {
        await h.runtime.dispose();
    }
});

test('推迟只针对"自动建"那一条:「＋ 新建会话」与「接着聊」照旧当场落台账', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        await h.runtime.start();
        h.sup.fire('ready');
        await tick();
        assert.equal(led.calls.begin.length, 0, '自动建的那条还没落');

        // 用户点「＋ 新建会话」:那是他明确要一条新会话 —— 立刻落账(既有语义不变)
        const fresh = await h.runtime.beginNewSession();
        await tick();
        assert.equal(fresh.sessionId, 's2');
        assert.equal(led.calls.begin.length, 1, '手动新建照旧当场落账');
        assert.equal(led.calls.begin[0].id, 's2');
        assert.equal(h.runtime.sessionsInfo().current, 's2');
        assert.equal(led.calls.user.length, 0, '还没说话:只有开头那一条记录(与改动前一致)');
    } finally {
        await h.runtime.dispose();
    }
});

test('「＋ 新建会话」失败之后回到那条还没说话的会话:待写台账必须还在(第一句不许静默丢)', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    try {
        await h.runtime.start();
        h.sup.fire('ready');
        await tick();
        assert.equal(led.calls.begin.length, 0, '自动建的会话:记录还没开头');

        // 用户点了「＋ 新建会话」但对端不干 —— 会话被收回去,回到原来那条
        const realNewSession = h.client.newSession;
        h.client.newSession = async () => { throw new Error('对端不干了'); };
        await assert.rejects(() => h.runtime.beginNewSession(), /对端不干了/);
        assert.equal(h.runtime.sessionsInfo().current, 's1', '失败要回到原来那条');

        // ⚠️ 这一步是这条用例的全部意义:回到的那条会话**仍然**排着待写台账 ——
        //    不然用户接着说的第一句会静默丢掉(recorder.user 找不到运行中的记录)。
        h.client.newSession = realNewSession;          // 还原成假客户端默认的建会话
        const sending = settle(h.runtime.send('回来之后说的第一句', { shown: '回来之后说的第一句' }));
        await tick();
        assert.equal(led.calls.begin.length, 1, '第一句一到,台账要开头');
        assert.equal(led.calls.begin[0].id, 's1');
        assert.deepEqual(led.calls.user.map((u) => u.text), ['回来之后说的第一句'],
            '那一句不许丢');
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await sending;
    } finally {
        await h.runtime.dispose();
    }
});
