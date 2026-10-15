import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createRealDeps } from '../electron/service-runner.js';

const quiet = { info() {}, warn() {}, error() {} };

// 不写死端口:让系统分配一个空闲端口再释放,避免被别的进程占用导致假失败。
function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// 等端口真的被监听。subprocess 启动是异步的,spawn 返回不代表服务已经在听 ——
// 直接调 httpHealth 会和服务启动赛跑,变成随机失败的假用例。
async function waitForPort(deps, port, tries = 50) {
    for (let i = 0; i < tries; i++) {
        if (await deps.probePort(port)) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

// 起一个临时 HTTP 服务,跑完断言后必定收掉 —— 断言失败不能让子进程留下来。
async function withHttpServer(deps, statusCode, body, fn) {
    const port = await findFreePort();
    const child = deps.spawnImpl({
        id: 'tmp', cwd: process.cwd(), port,
        command: process.execPath,
        args: ['-e', `require('http').createServer((q,s)=>{s.statusCode=${statusCode};s.end(${JSON.stringify(body)})}).listen(${port})`],
    }, { onStdout() {}, onStderr() {}, onExit() {} });
    try {
        assert.equal(await waitForPort(deps, port), true, '临时服务应当在超时前开始监听');
        await fn(port);
    } finally {
        await deps.killImpl(child.pid);
        // 端口释放是异步的,给 taskkill 一点时间
        await new Promise(r => setTimeout(r, 400));
    }
}

test('probePort 对空闲端口返回 false', async () => {
    const deps = createRealDeps({ log: quiet });
    const port = await findFreePort();
    assert.equal(await deps.probePort(port), false);
});

test('probePort 对正在监听的端口返回 true', async () => {
    const deps = createRealDeps({ log: quiet });
    const port = await findFreePort();
    const srv = net.createServer();
    await new Promise(r => srv.listen(port, '127.0.0.1', r));
    try {
        assert.equal(await deps.probePort(port), true);
    } finally {
        await new Promise(r => srv.close(r));
    }
});

test('真实拉起一个 HTTP 服务并健康检查通过,然后被停掉', async () => {
    const deps = createRealDeps({ log: quiet });
    await withHttpServer(deps, 200, 'ok', async (port) => {
        assert.equal(await deps.httpHealth(port, '/'), true, '临时服务应当可访问');
    });
});

test('killImpl 连派生出来的孙进程一起杀掉', async () => {
    const deps = createRealDeps({ log: quiet });
    const port = await findFreePort();
    // 父进程再派生一个子进程去监听端口 —— 只杀父进程会留下孤儿占着端口
    const script = `
        const { spawn } = require('child_process');
        const p = spawn(process.execPath, ['-e', "require('http').createServer((q,s)=>s.end('ok')).listen(${port})"], { stdio: 'ignore' });
        setInterval(() => {}, 1000);
    `;
    const child = deps.spawnImpl({
        id: 't2', cwd: process.cwd(), port,
        command: process.execPath, args: ['-e', script],
    }, { onStdout() {}, onStderr() {}, onExit() {} });

    try {
        assert.equal(await waitForPort(deps, port), true, '孙进程应当已监听');

        await deps.killImpl(child.pid);
        await new Promise(r => setTimeout(r, 800));
        assert.equal(await deps.probePort(port), false, '进程树应当被整体杀掉');
    } finally {
        await deps.killImpl(child.pid);
    }
});

test('httpHealth 对 4xx 也算服务活着', async () => {
    const deps = createRealDeps({ log: quiet });
    await withHttpServer(deps, 404, 'nope', async (port) => {
        // 404 说明服务在跑而且路由是可用的 —— 只有 5xx / 连不上才算不健康
        assert.equal(await deps.httpHealth(port, '/'), true);
    });
});

test('httpHealth 对 5xx 算不健康', async () => {
    const deps = createRealDeps({ log: quiet });
    await withHttpServer(deps, 500, 'boom', async (port) => {
        assert.equal(await deps.httpHealth(port, '/'), false);
    });
});

test('httpHealth 对连不上的端口返回 false 而不是抛异常', async () => {
    const deps = createRealDeps({ log: quiet });
    const port = await findFreePort();
    assert.equal(await deps.httpHealth(port, '/'), false);
});

test('spawnImpl 启动不存在的命令时通过 onExit 报告而不是抛异常', async () => {
    const deps = createRealDeps({ log: quiet });
    const exits = [];
    deps.spawnImpl({
        id: 'bad', cwd: process.cwd(), port: 1,
        command: '这个命令一定不存在-xyz', args: [],
    }, { onStdout() {}, onStderr() {}, onExit: code => exits.push(code) });

    await new Promise(r => setTimeout(r, 500));
    assert.deepEqual(exits, [-1], '应通过 onExit(-1) 上报,give 状态机一个明确的终态');
});

test('killImpl 对不存在的 pid 静默返回', async () => {
    const deps = createRealDeps({ log: quiet });
    await assert.doesNotReject(() => deps.killImpl(999999));
});

test('killImpl 对空 pid 静默返回', async () => {
    const deps = createRealDeps({ log: quiet });
    await assert.doesNotReject(() => deps.killImpl(null));
});

test('httpHealth 对慢响应仍判定为健康(默认超时必须够宽)', async () => {
    // 真实踩到的 bug:有的服务 /health 会顺带探自己的上游(B 站代理会去连
    // Bilidown),响应要 2 秒左右。默认超时若是 1500ms,服务明明健康也永远
    // 测不过 —— 表现为"启动 30 秒后失败"。默认给到 5000ms。
    const deps = createRealDeps({ log: quiet });
    const port = await findFreePort();

    // 一个延迟 2 秒才回响应的服务
    const srv = http.createServer((q, s) => {
        setTimeout(() => s.end('{"code":0}'), 2000);
    });
    await new Promise(r => srv.listen(port, '127.0.0.1', r));
    try {
        const t0 = Date.now();
        const ok = await deps.httpHealth(port, '/health');
        const cost = Date.now() - t0;
        assert.equal(ok, true, `2 秒的响应应当算健康,实际 false,耗时 ${cost}ms`);
        assert.ok(cost >= 1900, `确实等了约 2 秒,实际 ${cost}ms`);
    } finally {
        await new Promise(r => srv.close(r));
    }
});

test('httpHealth 可以按服务调大超时', async () => {
    const deps = createRealDeps({ log: quiet });
    const port = await findFreePort();
    // 4 秒才响应:默认 5000ms 能过,手动给 800ms 就会超时失败
    const srv = http.createServer((q, s) => {
        setTimeout(() => s.end('ok'), 4000);
    });
    await new Promise(r => srv.listen(port, '127.0.0.1', r));
    try {
        assert.equal(await deps.httpHealth(port, '/health', 800), false,
            '超时给紧了应当失败(这正是那个 bug 的机制)');
        assert.equal(await deps.httpHealth(port, '/health', 6000), true,
            '超时给够了应当成功');
    } finally {
        await new Promise(r => srv.close(r));
    }
});

test('createRealDeps 返回的四个依赖名与 supervisor 的参数名逐字一致', () => {
    const deps = createRealDeps({ log: quiet });
    // 名字不一致会让 `createServiceSupervisor({ ...deps })` 展开后
    // 悄悄退化:比如叫 killTree 而不是 killImpl,停止服务就成了空操作。
    for (const key of ['probePort', 'httpHealth', 'spawnImpl', 'killImpl']) {
        assert.equal(typeof deps[key], 'function', `缺少依赖 ${key}`);
    }
});

test('探活与健康检查不留下活跃句柄(否则调用方永远等不到事件循环清空)', async () => {
    const deps = createRealDeps({ log: quiet });
    const port = await findFreePort();
    const srv = http.createServer((q, s) => s.end('ok'));
    await new Promise(r => srv.listen(port, '127.0.0.1', r));

    try {
        const before = process._getActiveHandles().length;

        await deps.probePort(port);
        await deps.httpHealth(port, '/');
        await deps.probePort(port);
        await deps.httpHealth(port, '/');

        // 给 socket 关闭留一点时间
        await new Promise(r => setTimeout(r, 300));
        const after = process._getActiveHandles().length;

        // 这条断言防的是一个真实挂起缺陷:http.get 默认走全局 keep-alive agent,
        // 每次健康检查都把一个 socket 留在池里,句柄数会随调用次数增长。
        // 探活用的 net.connect 也会在 destroy 之后残留一小会儿。
        // 四次调用之后不该比开始时多出两个以上句柄。
        assert.ok(after - before <= 2,
            `句柄数从 ${before} 涨到 ${after},说明探活/健康检查在泄漏 socket`);
    } finally {
        await new Promise(r => srv.close(r));
    }
});
