// 服务托管。核心设计:启动前先探端口 —— 已经有人监听就"接管但不拥有"。
// 这样用户手敲的 .bat 和本应用可以共存,不会撞端口,退出时也不会误杀别人的进程。
//
// 依赖全部注入(probePort / spawnImpl / httpHealth / killImpl),所以状态机可以
// 完全脱离 Electron 和真实进程做单测;碰操作系统的那一层在 service-runner.js。

export const LOG_RING_SIZE = 200;

export function createServiceSupervisor({
    probePort,
    spawnImpl = null,
    httpHealth = null,
    killImpl = null,
    timeoutMs = 30000,
    pollIntervalMs = 300,
    log = console,
}) {
    const specs = new Map();
    const states = new Map();
    const logs = new Map();
    const children = new Map();
    const listeners = new Set();

    function emit(state) {
        for (const cb of listeners) {
            try {
                cb({ ...state });
            } catch (err) {
                log.error('[services] onChange 回调抛错', err);
            }
        }
    }

    function setState(id, patch) {
        const next = { ...states.get(id), ...patch, since: Date.now() };
        states.set(id, next);
        emit(next);
        return { ...next };
    }

    function appendLog(id, chunk) {
        const ring = logs.get(id) ?? [];
        ring.push(...String(chunk).split(/\r?\n/).filter(Boolean));
        while (ring.length > LOG_RING_SIZE) ring.shift();
        logs.set(id, ring);
    }

    // 轮询健康:优先 HTTP(能真正确认服务可用),退化为端口连通性。
    // 注意这两次探活的语义不同 —— 上面的首次探活回答"端口有没有被占",
    // 这里回答"我们拉起的那个东西到底起来没有"。
    //
    // healthTimeoutMs 允许按服务覆盖:有些服务的 /health 会顺带探自己的上游,
    // 响应要 2 秒以上,用默认超时会永远测不过(实测踩到过)。
    async function waitForReady(spec) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (httpHealth && spec.healthPath) {
                const ok = spec.healthTimeoutMs
                    ? await httpHealth(spec.port, spec.healthPath, spec.healthTimeoutMs)
                    : await httpHealth(spec.port, spec.healthPath);
                if (ok) return true;
            } else if (await probePort(spec.port)) {
                return true;
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
        return false;
    }

    const supervisor = {
        define(spec) {
            specs.set(spec.id, spec);
            states.set(spec.id, {
                id: spec.id,
                pluginId: spec.pluginId,
                label: spec.label,
                port: spec.port,
                status: 'stopped',
                owned: false,
                pid: null,
                error: null,
                since: Date.now(),
            });
            logs.set(spec.id, []);
        },

        get(id) {
            const s = states.get(id);
            return s ? { ...s } : null;
        },

        // 取回登记时的原始清单。运行态(states)里只放状态,autoStart 这类
        // 清单属性不重复存一份 —— 调用方(启动决策、设置页)需要时来这里取。
        spec(id) {
            const s = specs.get(id);
            return s ? { ...s, args: [...(s.args ?? [])] } : null;
        },

        list() {
            return [...states.keys()].sort().map(id => ({ ...states.get(id) }));
        },

        logs(id) {
            return [...(logs.get(id) ?? [])];
        },

        onChange(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },

        // specOverride 用于传入那些"登记时还不知道、启动时才定"的字段,
        // 目前只有 cwd(它相对服务根目录,根目录存在设置里)。
        // 单独开这个口子,而不是让托管器自己去读设置 —— 托管器必须保持
        // "依赖全注入、可脱离 Electron 单测"的性质。
        async start(id, specOverride = null) {
            const base = specs.get(id);
            if (!base) throw new Error(`未定义的服务: ${id}`);
            const spec = specOverride ? { ...base, ...specOverride } : base;

            const current = states.get(id);
            if (current.status === 'ready' || current.status === 'starting') return { ...current };
            // 已经接管来的也在跑,不必再拉一次
            if (current.status === 'external') return { ...current };

            setState(id, { status: 'starting', error: null });

            // 关键一步:先探端口。已有人监听 → 接管,不重启。
            if (await probePort(spec.port)) {
                appendLog(id, `端口 ${spec.port} 已有服务在运行,接管(不重启)`);
                return setState(id, { status: 'external', owned: false, pid: null });
            }

            if (!spawnImpl) {
                return setState(id, { status: 'failed', error: '当前环境不支持启动服务' });
            }

            try {
                const child = spawnImpl(spec, {
                    onStdout: chunk => appendLog(id, chunk),
                    onStderr: chunk => appendLog(id, chunk),
                    onExit: code => {
                        appendLog(id, `进程退出,退出码 ${code}`);
                        children.delete(id);
                        setState(id, { status: 'stopped', owned: false, pid: null });
                    },
                });
                children.set(id, child);
                setState(id, { status: 'starting', owned: true, pid: child.pid });

                const ok = await waitForReady(spec);
                if (!ok) {
                    appendLog(id, `等待就绪超时(${timeoutMs}ms),端口 ${spec.port} 仍未就绪`);
                    return setState(id, {
                        status: 'failed',
                        error: `等待就绪超时,端口 ${spec.port} 没有就绪`,
                    });
                }
                appendLog(id, `服务已就绪,端口 ${spec.port}`);
                return setState(id, { status: 'ready' });
            } catch (err) {
                appendLog(id, `启动失败: ${err.message}`);
                return setState(id, { status: 'failed', owned: false, pid: null, error: err.message });
            }
        },

        async stop(id) {
            const spec = specs.get(id);
            if (!spec) throw new Error(`未定义的服务: ${id}`);

            const current = states.get(id);

            // 只是接管来的,不归我们管 —— 不动它
            if (current.status === 'external' || !current.owned) {
                appendLog(id, '该服务不是本应用启动的,不予停止');
                return { ...current };
            }

            setState(id, { status: 'stopping' });
            if (killImpl && current.pid) {
                try {
                    await killImpl(current.pid);
                } catch (err) {
                    // 杀不掉也要把状态收敛掉,否则界面会永远停在"停止中"
                    appendLog(id, `停止失败: ${err.message}`);
                }
            }
            children.delete(id);
            return setState(id, { status: 'stopped', owned: false, pid: null });
        },

        async shutdownAll() {
            for (const [id, state] of states) {
                if (state.owned && specs.get(id)?.stopOnExit) {
                    await supervisor.stop(id);
                }
            }
        },
    };

    return supervisor;
}
