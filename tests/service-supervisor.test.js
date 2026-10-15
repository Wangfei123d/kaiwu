import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceSupervisor, LOG_RING_SIZE } from '../electron/service-supervisor.js';

const quiet = { info() {}, warn() {}, error() {} };

const spec = {
    id: 'svc', pluginId: 'demo', label: '示例服务',
    cwd: '/tmp', command: 'node', args: [], port: 3300,
    healthPath: null, autoStart: false, stopOnExit: true,
};

test('define 后状态为 stopped', () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => false });
    sup.define(spec);
    assert.equal(sup.get('svc').status, 'stopped');
    assert.equal(sup.get('svc').owned, false);
});

test('端口已被占用时 start 进入 external,且不拥有', async () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => true });
    sup.define(spec);
    const state = await sup.start('svc');
    assert.equal(state.status, 'external');
    assert.equal(state.owned, false);
});

test('external 状态下 stop 被拒绝,状态不变', async () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => true });
    sup.define(spec);
    await sup.start('svc');
    const state = await sup.stop('svc');
    assert.equal(state.status, 'external');       // 我们没启动它,就不该关它
    assert.equal(state.owned, false);
});

test('端口空闲但 spawn 抛错时进入 failed 并记录原因', async () => {
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,
        spawnImpl: () => { throw new Error('ENOENT: node 不存在'); },
    });
    sup.define(spec);
    const state = await sup.start('svc');
    assert.equal(state.status, 'failed');
    assert.match(state.error, /ENOENT/);
});

test('未 define 的 id 调用 start 抛错', async () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => false });
    await assert.rejects(() => sup.start('不存在'), /未定义的服务/);
});

test('未 define 的 id 调用 stop 抛错', async () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => false });
    await assert.rejects(() => sup.stop('不存在'), /未定义的服务/);
});

test('onChange 在状态变化时触发', async () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => true });
    const seen = [];
    sup.onChange(s => seen.push(s.status));
    sup.define(spec);
    await sup.start('svc');
    assert.ok(seen.includes('starting'));
    assert.ok(seen.includes('external'));
});

test('list 返回全部服务', () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => false });
    sup.define(spec);
    sup.define({ ...spec, id: 'svc2' });
    assert.deepEqual(sup.list().map(s => s.id).sort(), ['svc', 'svc2']);
});

test('shutdownAll 不会去关 external 的服务', async () => {
    let killed = 0;
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => true,
        killImpl: () => { killed++; },
    });
    sup.define(spec);
    await sup.start('svc');
    await sup.shutdownAll();
    assert.equal(killed, 0);
});

// ---- Task 9:健康检查与 ready 终态 ----

test('端口空闲且 spawn 成功、健康检查通过 → ready 且 owned', async () => {
    let probed = 0;
    const sup = createServiceSupervisor({
        log: quiet,
        // 第一次探活(启动前)返回 false,之后健康检查返回 true
        probePort: async () => (probed++ === 0 ? false : true),
        spawnImpl: () => ({ pid: 4242 }),
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    const state = await sup.start('svc');
    assert.equal(state.status, 'ready');
    assert.equal(state.owned, true);
    assert.equal(state.pid, 4242);
});

test('健康检查一直不过 → failed 且带超时说明', async () => {
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,
        spawnImpl: () => ({ pid: 1 }),
        timeoutMs: 200,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    const state = await sup.start('svc');
    assert.equal(state.status, 'failed');
    assert.match(state.error, /超时|没有就绪/);
});

test('有 healthPath 时优先用 HTTP 健康检查而不是端口探活', async () => {
    const calls = [];
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,           // 启动前探活:空闲
        httpHealth: async (port, healthPath) => {
            calls.push([port, healthPath]);
            return true;
        },
        spawnImpl: () => ({ pid: 9 }),
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define({ ...spec, healthPath: '/' });
    const state = await sup.start('svc');
    assert.equal(state.status, 'ready');
    assert.deepEqual(calls, [[3300, '/']]);
});

test('httpHealth 一直不过 → failed', async () => {
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,
        httpHealth: async () => false,
        spawnImpl: () => ({ pid: 9 }),
        timeoutMs: 200,
        pollIntervalMs: 10,
    });
    sup.define({ ...spec, healthPath: '/health' });
    const state = await sup.start('svc');
    assert.equal(state.status, 'failed');
});

test('服务声明的 healthTimeoutMs 会传给 httpHealth', async () => {
    // 真实踩到的 bug:B站代理的 /health 要顺带探自己的上游,响应约 2 秒,
    // 而 httpHealth 的默认超时是 1500ms —— 服务明明健康也永远测不过,
    // 表现为"启动 31 秒后失败"。所以必须允许按服务覆盖这个超时。
    const seen = [];
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,
        httpHealth: async (port, path, timeoutMs) => {
            seen.push([port, path, timeoutMs]);
            return true;
        },
        spawnImpl: () => ({ pid: 9 }),
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define({ ...spec, healthPath: '/health', healthTimeoutMs: 8000 });
    const state = await sup.start('svc');
    assert.equal(state.status, 'ready');
    assert.deepEqual(seen[0], [3300, '/health', 8000],
        'healthTimeoutMs 必须原样传给 httpHealth');
});

test('没声明 healthTimeoutMs 时用 httpHealth 自己的默认值(只传两个参数)', async () => {
    const args = [];
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,
        httpHealth: async (...a) => { args.push(a); return true; },
        spawnImpl: () => ({ pid: 9 }),
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define({ ...spec, healthPath: '/health' });
    await sup.start('svc');
    assert.equal(args[0].length, 2, '不该凭空塞第三个参数');
});

test('owned 的 ready 服务 stop 会调用 killImpl', async () => {
    let probed = 0;
    const killed = [];
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => (probed++ === 0 ? false : true),
        spawnImpl: () => ({ pid: 777 }),
        killImpl: async (pid) => killed.push(pid),
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    await sup.start('svc');
    const state = await sup.stop('svc');
    assert.deepEqual(killed, [777]);
    assert.equal(state.status, 'stopped');
    assert.equal(state.owned, false);
});

test('日志环形缓冲最多保留 200 行,且留下的是最近的那些', async () => {
    let emit = null;
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,
        spawnImpl: (spec_, handlers) => { emit = handlers.onStdout; return { pid: 1 }; },
        timeoutMs: 50,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    await sup.start('svc');        // 健康检查会超时,但日志已经收下了

    for (let i = 1; i <= 250; i++) emit(`第 ${i} 行\n`);

    const lines = sup.logs('svc');
    assert.equal(lines.length, LOG_RING_SIZE, '环形缓冲应当只保留最近 200 行');
    assert.equal(lines[0], '第 51 行', '最旧的 50 行应当已被挤掉');
    assert.equal(lines.at(-1), '第 250 行', '最后一行必须还在');
});

test('stderr 也进同一个日志环', async () => {
    let emitErr = null;
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,
        spawnImpl: (spec_, handlers) => { emitErr = handlers.onStderr; return { pid: 1 }; },
        timeoutMs: 50,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    await sup.start('svc');
    emitErr('出错了\n');
    assert.ok(sup.logs('svc').some(l => l.includes('出错了')));
});

test('ready 状态下重复 start 是空操作,不重复拉起', async () => {
    let probed = 0;
    let spawns = 0;
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => (probed++ === 0 ? false : true),
        spawnImpl: () => { spawns++; return { pid: 5 }; },
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    await sup.start('svc');
    await sup.start('svc');
    assert.equal(spawns, 1, '已经在跑的服务不该被再拉起一次');
});

test('shutdownAll 会停掉自己拉起的服务', async () => {
    let probed = 0;
    const killed = [];
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => (probed++ === 0 ? false : true),
        spawnImpl: () => ({ pid: 31 }),
        killImpl: async (pid) => killed.push(pid),
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    await sup.start('svc');
    await sup.shutdownAll();
    assert.deepEqual(killed, [31]);
    assert.equal(sup.get('svc').status, 'stopped');
});

test('stopOnExit 为 false 的服务在 shutdownAll 时保留', async () => {
    let probed = 0;
    const killed = [];
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => (probed++ === 0 ? false : true),
        spawnImpl: () => ({ pid: 31 }),
        killImpl: async (pid) => killed.push(pid),
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define({ ...spec, stopOnExit: false });
    await sup.start('svc');
    await sup.shutdownAll();
    assert.deepEqual(killed, [], '托盘型应用要保留状态,不能随应用退出被强杀');
});

test('子进程退出会把状态改回 stopped 且不再 owned', async () => {
    let onExit = null;
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => false,
        spawnImpl: (spec_, handlers) => { onExit = handlers.onExit; return { pid: 8 }; },
        timeoutMs: 50,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    await sup.start('svc');            // 超时进 failed
    onExit(1);
    assert.equal(sup.get('svc').status, 'stopped');
    assert.equal(sup.get('svc').owned, false);
    assert.equal(sup.get('svc').pid, null);
});

test('get 未定义的服务返回 null', () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => false });
    assert.equal(sup.get('无'), null);
});

test('logs 对未定义的服务返回空数组', () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => false });
    assert.deepEqual(sup.logs('无'), []);
});

test('状态对象是快照,外部改动不影响内部', async () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => true });
    sup.define(spec);
    const snapshot = sup.get('svc');
    snapshot.status = '被改了';
    assert.equal(sup.get('svc').status, 'stopped');
});

test('没有 spawnImpl 时进 failed 而不是抛异常', async () => {
    const sup = createServiceSupervisor({ log: quiet, probePort: async () => false });
    sup.define(spec);
    const state = await sup.start('svc');
    assert.equal(state.status, 'failed');
    assert.match(state.error, /不支持启动服务/);
});

test('killImpl 抛错时状态仍收敛到 stopped', async () => {
    let probed = 0;
    const sup = createServiceSupervisor({
        log: quiet,
        probePort: async () => (probed++ === 0 ? false : true),
        spawnImpl: () => ({ pid: 1 }),
        killImpl: async () => { throw new Error('taskkill 失败'); },
        timeoutMs: 2000,
        pollIntervalMs: 10,
    });
    sup.define(spec);
    await sup.start('svc');
    const state = await sup.stop('svc');
    assert.equal(state.status, 'stopped');
    assert.equal(state.owned, false);
});
