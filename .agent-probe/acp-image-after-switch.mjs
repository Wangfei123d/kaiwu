// 探针:证明"换成视觉模型之后**不需要重连**就能发图"。
//
// 病根:桥在 initialize 里算一次 imagePromptEnabled,set_config_option 换模型不重算
//       → 换成视觉模型后发图仍被 -32602 拒。
// 修法(tools/patch-dsh-acp-streaming.mjs 第十处):
//   · prompt 那一刻现算(判据与 initialize 同一个函数);
//   · 另给一个私有问法 kaiwu/capabilities,让客户端别拿旧值继续拦。
// 本探针按真实顺序走一遍:握手 → 建会话 → 问能力 → 换模型 → 再问能力 → 真发一张图。
//
// 用法:node .agent-probe/acp-image-after-switch.mjs
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentCommand } from '../app/lib/agent-command.js';
import { createAgentSpawn } from '../app/lib/agent-env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = path.join(process.env.APPDATA ?? os.homedir(), 'kaiwu', 'dsh-home');
const VAULT = process.env.KAIWU_PROBE_VAULT ?? path.join(ROOT, '..', 'kaiwu-demo-vault');
const VISION = JSON.stringify(['deepseek-official', 'deepseek-v4-flash-vision-exp']);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const resolved = resolveAgentCommand({ env: process.env, exists: existsSync, appRoot: ROOT });
if (resolved === null || resolved.reason !== 'dsh') { console.error('拿不到 dsh 命令'); process.exit(2); }

const child = createAgentSpawn({
    command: resolved.command, args: resolved.args, dshHome: DSH_HOME,
    cwd: existsSync(VAULT) ? VAULT : ROOT, base: process.env,
})();

let buffer = '';
let sessionId = '';
const results = {};
const fails = [];
const check = (ok, what, detail) => {
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${what}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`);
    if (!ok) fails.push(what);
};
const done = () => {
    console.log('\n[probe] 汇总:', JSON.stringify(results));
    console.log(fails.length === 0 ? '[probe] 全部通过 ✓' : `[probe] ${fails.length} 条不通过: ${fails.join(' / ')}`);
    child.kill();
    process.exit(fails.length === 0 ? 0 : 1);
};
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const pending = new Map();
const call = (id, method, params, alias) => { pending.set(id, alias ?? method); send({ jsonrpc: '2.0', id, method, params }); };

child.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
        if (line.trim() === '') continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === 'session/request_permission') {
            send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } });
            continue;
        }
        if (msg.id === undefined) continue;
        const what = pending.get(msg.id);
        if (what === undefined) continue;
        pending.delete(msg.id);

        if (what === 'initialize') {
            results.imageAtInit = msg.result?.agentCapabilities?.promptCapabilities?.image ?? null;
            check(results.imageAtInit === false, '握手时(文本模型)广告图片能力 = false', results.imageAtInit);
            call(2, 'session/new', { cwd: VAULT, mcpServers: [] });
        } else if (what === 'session/new') {
            sessionId = msg.result?.sessionId ?? '';
            check(sessionId !== '', '建会话成功', sessionId);
            call(3, 'kaiwu/capabilities', { sessionId }, 'caps#1');
        } else if (what === 'caps#1') {
            if (msg.error) { check(false, 'kaiwu/capabilities 有应答(桥打上第十处补丁了吗?)', msg.error); done(); return; }
            results.capsBefore = msg.result?.image ?? null;
            check(results.capsBefore === false, '换模型**之前**问能力 → false', results.capsBefore);
            call(4, 'session/set_config_option', { sessionId, configId: 'model', value: VISION });
        } else if (what === 'session/set_config_option') {
            if (msg.error) { check(false, '换模型', msg.error); done(); return; }
            const now = (msg.result?.configOptions ?? []).find((o) => o.id === 'model')?.currentValue;
            check(now === VISION, '模型真的换成了视觉模型', now);
            call(5, 'kaiwu/capabilities', { sessionId }, 'caps#2');
        } else if (what === 'caps#2') {
            results.capsAfter = msg.result?.image ?? null;
            check(results.capsAfter === true, '换模型**之后**再问 → true(**不需要重连**)', results.capsAfter);
            call(6, 'session/prompt', {
                sessionId,
                prompt: [
                    { type: 'text', text: '这是一张 1×1 的图。一个词回答你看到了什么。' },
                    { type: 'image', mimeType: 'image/png', data: PNG_1PX },
                ],
            });
        } else if (what === 'session/prompt') {
            const err = msg.error ?? null;
            results.imagePrompt = err === null
                ? { ok: true, stopReason: msg.result?.stopReason ?? null }
                : { code: err.code, message: err.message };
            const rejectedAsImage = err !== null && /not advertised by this connection/.test(String(err.message ?? ''));
            check(!rejectedAsImage, '带图片的提示**没有被"图片能力未广告"拒掉**(这条就是原来那个 bug)', results.imagePrompt);
            done();
        }
    }
});
child.stderr.on('data', (d) => process.stderr.write('[dsh] ' + d.toString('utf8')));

// ⚠️ 必须走 call(把它登记进 pending):第一版用裸 send 发 initialize,
//    于是应答回来了却没人认领(id 不在 pending 里)→ 整条链一步都不动,只看到超时。
call(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: 'kaiwu-probe', version: '0.0.1' },
});
setTimeout(() => { console.error('[probe] 超时;已完成:', JSON.stringify(results)); child.kill(); process.exit(3); }, 120000);
