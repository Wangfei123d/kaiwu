// 探针:「AI 会话面板」到底能不能做**历史会话**这件事。
//
// 三个必须量清楚的问题(猜不出来,只能问对端):
//   ① `session/list` 真机上回什么?(字段够不够画一个清单)
//   ② 会话内容有没有落盘?dsh 子进程被杀掉之后,那个 .jsonl.zstd 里是只有头、还是有整段对话?
//   ③ 同一份清单里会不会混着一堆"只有头、没有内容"的空会话(每次自检都建一个)?
//
// 用法:node .agent-probe/acp-session-list-probe.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { resolveAgentCommand, resolveDshEntry } from '../app/lib/agent-command.js';
import { createAgentSpawn } from '../app/lib/agent-env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = path.join(process.env.APPDATA ?? os.homedir(), 'kaiwu', 'dsh-home');
const VAULT = process.env.KAIWU_PROBE_VAULT ?? path.join(ROOT, '..', 'kaiwu-demo-vault');
const CWD = existsSync(VAULT) ? VAULT : ROOT;

const resolved = resolveAgentCommand({ env: process.env, exists: existsSync, appRoot: ROOT });
if (resolved === null || resolved.reason !== 'dsh') {
    console.error('[probe] 拿不到 dsh 命令:', JSON.stringify(resolved));
    process.exit(2);
}
console.log('[probe] dsh 入口:', resolveDshEntry({ env: process.env, exists: existsSync, appRoot: ROOT }));
console.log('[probe] cwd:', CWD);

const child = createAgentSpawn({
    command: resolved.command, args: resolved.args, dshHome: DSH_HOME, cwd: CWD, base: process.env,
})();

let buffer = '';
let sessionId = null;
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const call = (id, method, params) => send({ jsonrpc: '2.0', id, method, params });

/** 会话文件目录(按 cwd 分桶)。 */
function sessionDirOf(sid) {
    const sessions = path.join(DSH_HOME, 'sessions');
    for (const bucket of readdirSync(sessions)) {
        const f = path.join(sessions, bucket, sid, 'session.v3.jsonl.zstd');
        if (existsSync(f)) return f;
    }
    return null;
}

function readSession(sid) {
    const f = sessionDirOf(sid);
    if (f === null) return { found: false };
    const text = zlib.zstdDecompressSync(readFileSync(f)).toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    return { found: true, bytes: readFileSync(f).length, lines: lines.length, text, first: lines[0] ?? '', last: lines.at(-1) ?? '' };
}

let closed = false;
function finish(code = 0) {
    if (closed) return;
    closed = true;
    setTimeout(() => process.exit(code), 50);
}

const TIMEOUT = setTimeout(() => {
    console.error('[probe] 120s 超时');
    try { child.kill(); } catch { /* 已经走了 */ }
    finish(3);
}, 120000);

child.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
        if (line.trim() === '') continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === 'session/update') continue;      // 增量噪声:这一趟不关心
        if (msg.id === 1) { call(2, 'session/new', { cwd: CWD, mcpServers: [] }); continue; }
        if (msg.id === 2) {
            sessionId = msg.result?.sessionId ?? null;
            console.log('\n[probe] ② session/new →', sessionId);
            call(3, 'session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: '请只回复四个字:收到收到' }],
            });
            continue;
        }
        if (msg.id === 3) {
            console.log('[probe] ③ prompt 结束,stopReason =', msg.result?.stopReason ?? JSON.stringify(msg.error));
            call(4, 'session/list', { cwd: CWD });
            continue;
        }
        if (msg.id === 4) {
            const r = msg.result ?? {};
            console.log('\n[probe] ④ session/list(cwd=当前库) 返回:');
            console.log('        条目数 =', (r.sessions ?? []).length, '| nextCursor =', r.nextCursor ?? '(无)');
            for (const s of (r.sessions ?? []).slice(0, 6)) {
                console.log('        ·', JSON.stringify(s));
            }
            if (msg.error) console.log('        出错:', JSON.stringify(msg.error));
            // 不带 cwd 再问一次:看是不是"所有工作目录的会话都给"
            call(5, 'session/list', {});
            continue;
        }
        if (msg.id === 5) {
            const r = msg.result ?? {};
            console.log('\n[probe] ⑤ session/list(不带 cwd) 返回条目数 =', (r.sessions ?? []).length);
            if (msg.error) console.log('        出错:', JSON.stringify(msg.error));
            // 杀掉子进程,再看磁盘上那个会话文件里到底有什么
            console.log('\n[probe] ⑥ 杀掉 dsh 子进程,再看会话文件……');
            try { child.kill(); } catch { /* ignore */ }
            setTimeout(() => {
                const one = readSession(sessionId);
                console.log('        本次会话文件:', JSON.stringify({
                    found: one.found, bytes: one.bytes, lines: one.lines,
                }));
                if (one.found) {
                    console.log('        第 1 行:', one.first.slice(0, 200));
                    console.log('        末  行:', one.last.slice(0, 200));
                    console.log('        含"收到收到" =', one.text.includes('收到收到'));
                }
                // 再数一遍整个库存:多少会话是"只有头"的空壳
                const sessionsRoot = path.join(DSH_HOME, 'sessions');
                let total = 0; let headerOnly = 0;
                for (const bucket of readdirSync(sessionsRoot)) {
                    const bp = path.join(sessionsRoot, bucket);
                    for (const sid of readdirSync(bp)) {
                        const f = path.join(bp, sid, 'session.v3.jsonl.zstd');
                        if (!existsSync(f)) continue;
                        total += 1;
                        try {
                            const t = zlib.zstdDecompressSync(readFileSync(f)).toString('utf8');
                            if (t.split('\n').filter((l) => l.trim() !== '').length <= 1) headerOnly += 1;
                        } catch { /* 坏文件不计 */ }
                    }
                }
                console.log(`\n[probe] ⑦ 库存统计:${total} 个会话,其中**只有头、没有内容**的 = ${headerOnly}`);
                clearTimeout(TIMEOUT);
                finish(0);
            }, 2500);
            continue;
        }
    }
});
child.stderr.on('data', (d) => process.stderr.write('[dsh] ' + d.toString('utf8')));
child.on('exit', (code) => console.error('[probe] dsh 退出,code =', code));

call(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: 'kaiwu-probe', version: '0.0.1' },
});
