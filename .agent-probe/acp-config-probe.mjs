// 探针:照 kaiwu 的方式起一个真 dsh(acp profile),问一次 session/new,
// 把对端回的 **configOptions 原样打印**。
//
// 为什么需要它:界面上那枚胶囊显示"对端没有给出思考强度这一项",而"为什么没有"只能靠
// 对端亲口说的那份清单来判断 —— 光读代码推不出来(桥只在 resolveModelInfo().reasoning
// 存在时才加那一条,而那一层要真的走 provider 注册与凭证路由)。
//
// 用法:node .agent-probe/acp-config-probe.mjs
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentCommand, resolveDshEntry } from '../app/lib/agent-command.js';
import { createAgentSpawn } from '../app/lib/agent-env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = path.join(process.env.APPDATA ?? os.homedir(), 'kaiwu', 'dsh-home');
const VAULT = process.env.KAIWU_PROBE_VAULT ?? path.join(ROOT, '..', 'kaiwu-demo-vault');

const resolved = resolveAgentCommand({ env: process.env, exists: existsSync, appRoot: ROOT });
if (resolved === null || resolved.reason !== 'dsh') {
    console.error('[probe] 拿不到 dsh 命令:', JSON.stringify(resolved));
    process.exit(2);
}
console.log('[probe] dsh 入口:', resolveDshEntry({ env: process.env, exists: existsSync, appRoot: ROOT }));
console.log('[probe] DSH_HOME:', DSH_HOME, '| cwd:', existsSync(VAULT) ? VAULT : ROOT);

const child = createAgentSpawn({
    command: resolved.command,
    args: resolved.args,
    dshHome: DSH_HOME,
    cwd: existsSync(VAULT) ? VAULT : ROOT,
    base: process.env,
})();

let buffer = '';
const seen = [];
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

child.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
        if (line.trim() === '') continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        seen.push(msg.id ?? msg.method);
        if (msg.id === 1) {
            send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: VAULT, mcpServers: [] } });
        }
        if (msg.id === 2) {
            const opts = msg.result?.configOptions ?? null;
            console.log('\n[probe] session/new 原始返回:');
            console.log(JSON.stringify(opts, null, 2));
            console.log('\n[probe] 逐条:', (opts ?? []).map((o) => `${o.id}=${o.currentValue ?? '?'}`).join(' | ') || '(空)');
            if (msg.error) console.error('[probe] session/new 出错:', JSON.stringify(msg.error));
            child.kill();
            process.exit(0);
        }
    }
});
child.stderr.on('data', (d) => process.stderr.write('[dsh] ' + d.toString('utf8')));
child.on('exit', (code) => console.error('[probe] dsh 退出,code =', code, '| 收到的消息:', JSON.stringify(seen)));

send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'kaiwu-probe', version: '0.0.1' },
    },
});
setTimeout(() => {
    console.error('[probe] 20s 超时,收到的消息:', JSON.stringify(seen));
    child.kill();
    process.exit(3);
}, 20000);
