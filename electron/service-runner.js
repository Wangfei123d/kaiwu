import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

// 真实依赖实现。刻意与 service-supervisor 分开:supervisor 只有状态机逻辑、
// 依赖全注入,单测不需要真实进程;这里才是碰操作系统的那一层。
//
// 导出的名字必须与 createServiceSupervisor 的参数名逐字一致(probePort /
// httpHealth / spawnImpl / killImpl),因为调用方是 `{ ...deps }` 直接展开的 ——
// 名字对不上会静默退化成空操作,而不是报错。
//
// 关于 httpHealth 的超时:默认 5000ms,不是 1500ms。
// 有些服务的 /health 会**顺带探自己的上游**(B 站代理就会去连 Bilidown),
// 于是响应要 2 秒左右。超时给紧了,服务明明健康也永远测不过 ——
// 实测踩到过:端口 1 秒就通了,而健康检查 25 秒内一次都没成功。
export function createRealDeps({ log = console } = {}) {
    function probePort(port, timeout = 800) {
        return new Promise((resolve) => {
            const socket = net.connect({ port, host: '127.0.0.1' });
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                // destroy() 之后仍可能有在途的 error 事件(对端刚好重置连接),
                // 没有监听器就会变成未处理的 'error' 事件,直接让进程抛异常。
                // 这里挂一个空监听器兜住它 —— 我们已经拿到结论了。
                socket.on('error', () => {});
                socket.destroy();
                resolve(result);
            };
            socket.setTimeout(timeout);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false));
            socket.once('error', () => done(false));
        });
    }

    function httpHealth(port, healthPath, timeoutMs = 5000) {
        return new Promise((resolve) => {
            const req = http.get(
                {
                    host: '127.0.0.1',
                    port,
                    path: healthPath,
                    timeout: timeoutMs,
                    // 必须关掉连接复用。默认的全局 agent 会把 socket 放进
                    // keep-alive 池并保持打开,于是每次健康检查都留下一个
                    // 活跃句柄 —— 调用方(测试运行器、应用退出路径)会因此
                    // 永远等不到事件循环清空。这是个真实的挂起缺陷,不是洁癖。
                    agent: false,
                },
                (res) => {
                    res.resume();
                    // 4xx 也算活着:服务在跑、路由可达,只是这个路径没有内容。
                    // 只有 5xx 表示它自己出问题了。
                    resolve(res.statusCode >= 200 && res.statusCode < 500);
                },
            );
            req.once('timeout', () => { req.destroy(); resolve(false); });
            req.once('error', () => resolve(false));
        });
    }

    function spawnImpl(spec, { onStdout, onStderr, onExit }) {
        const child = spawn(spec.command, spec.args ?? [], {
            cwd: spec.cwd,
            windowsHide: true,
            env: { ...process.env },
        });
        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.once('exit', (code) => onExit?.(code));
        child.once('error', (err) => {
            // 启动失败(命令不存在、cwd 不对)必须给状态机一个终态,
            // 否则它会一直等在 waitForReady 里直到超时。
            log.error(`[services] 无法启动 ${spec.id}: ${err.message}`);
            onExit?.(-1);
        });
        return child;
    }

    // 必须杀整棵树:npm/node 启动的服务常会派生孙进程,
    // 只杀父进程会留下孤儿继续占着端口。
    function killImpl(pid) {
        return new Promise((resolve) => {
            if (!pid) return resolve();
            const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
            });
            killer.once('exit', () => resolve());
            killer.once('error', () => resolve());
        });
    }

    return { probePort, httpHealth, spawnImpl, killImpl };
}
