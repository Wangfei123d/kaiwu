// 探针:换模型会不会把「思考强度」打回默认?
//
// 为什么必须量:kaiwu 要"每次新会话都确保思考强度落在中"。如果**换模型**也会重置强度,
// 那道保证要么覆盖换模型,要么就只在新会话时生效 —— 这决定了实现范围,猜不出来。
//
// 步骤:initialize → session/new → 换模型 → 改强度 → 再换模型,每步打印 currentValue。
// 用法:node .agent-probe/acp-effort-probe.mjs
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentCommand, resolveDshEntry } from '../app/lib/agent-command.js';
import { createAgentSpawn } from '../app/lib/agent-env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = path.join(process.env.APPDATA ?? os.homedir(), 'kaiwu', 'dsh-home');
const VAULT = process.env.KAIWU_PROBE_VAULT ?? path.join(ROOT, '..', 'kaiwu-demo-vault');
const CWD = existsSync(VAULT) ? VAULT : ROOT;

const M_PRO = JSON.stringify(['deepseek-official', 'deepseek-v4-pro']);
const M_FLASH = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']);

const resolved = resolveAgentCommand({ env: process.env, exists: existsSync, appRoot: ROOT });
if (resolved === null || resolved.reason !== 'dsh') {
    console.error('[probe] 拿不到 dsh 命令:', JSON.stringify(resolved));
    process.exit(2);
}

const child = createAgentSpawn({
    command: resolved.command,
    args: resolved.args,
    dshHome: DSH_HOME,
    cwd: CWD,
    base: process.env,
})();

let buffer = '';
let sessionId = null;
let step = 0;
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

/** 一行摘要:model=… | reasoning_effort=…(找不到写 "(没有这一项)")。 */
const brief = (opts) => {
    const list = Array.isArray(opts) ? opts : [];
    const pick = (id) => list.find((o) => o?.id === id)?.currentValue ?? '(没有这一项)';
    return `model=${pick('model')} | reasoning_effort=${pick('reasoning_effort')}`;
};

const plan = [
    { tag: 'session/new 之后', method: 'session/new', params: () => ({ cwd: CWD, mcpServers: [] }) },
    { tag: '换模型 → V4-Pro', method: 'session/set_config_option', params: () => ({ sessionId, configId: 'model', value: M_PRO }) },
    { tag: '手动把强度设成 low', method: 'session/set_config_option', params: () => ({ sessionId, configId: 'reasoning_effort', value: 'low' }) },
    { tag: '再换模型 → V4-Flash', method: 'session/set_config_option', params: () => ({ sessionId, configId: 'model', value: M_FLASH }) },
];

function next() {
    if (step >= plan.length) { child.kill(); process.exit(0); }
    const s = plan[step];
    step += 1;
    send({ jsonrpc: '2.0', id: 100 + step, method: s.method, params: s.params() });
}

child.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
        if (line.trim() === '') continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { next(); continue; }
        if (typeof msg.id === 'number' && msg.id >= 101) {
            const s = plan[msg.id - 101];
            if (msg.error) {
                console.log(`\n[probe] ${s.tag} → 出错: ${JSON.stringify(msg.error)}`);
            } else {
                const r = msg.result ?? {};
                if (typeof r.sessionId === 'string') sessionId = r.sessionId;
                console.log(`\n[probe] ${s.tag}\n         ${brief(r.configOptions)}`);
            }
            next();
        }
    }
});
child.stderr.on('data', (d) => process.stderr.write('[dsh] ' + d.toString('utf8')));
child.on('exit', (code) => console.error('[probe] dsh 退出,code =', code));

send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'kaiwu-probe', version: '0.0.1' },
    },
});
setTimeout(() => {
    console.error('[probe] 60s 超时,已走到第', step, '步');
    child.kill();
    process.exit(3);
}, 60000);
