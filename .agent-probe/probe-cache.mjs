// 看 harness 的会话缓存里到底存了什么:如果它存了**文件内容**,那被写坏的 agent-stream.js 就能整份捞回来。
import fs from 'node:fs';
import path from 'node:path';

const dir = 'C:\\Users\\Administrator\\AppData\\Roaming\\dsh-desktop\\harness\\storages\\session_projcache\\sessions';
const files = fs.readdirSync(dir).map((n) => path.join(dir, n));

for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch { console.log(path.basename(f), '不是 JSON'); continue; }
    const top = (data !== null && typeof data === 'object' && !Array.isArray(data)) ? Object.keys(data) : ['(数组)'];
    const big = [];
    const walk = (node, p) => {
        if (typeof node === 'string') {
            if (node.length > 1500) {
                big.push({ at: p, len: node.length, hasStream: node.includes('normalizeConfigOptions'), head: node.slice(0, 50).replace(/\n/g, '\\n') });
            }
            return;
        }
        if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${p}[${i}]`)); return; }
        if (node !== null && typeof node === 'object') {
            for (const k of Object.keys(node)) walk(node[k], `${p}.${k}`);
        }
    };
    walk(data, '');
    console.log('====', path.basename(f), '| 顶层键:', JSON.stringify(top).slice(0, 160), '| >1500 字的字符串:', big.length);
    for (const b of big.slice(0, 6)) {
        console.log(`   ${b.at}  len=${b.len}  含agent-stream标记=${b.hasStream}  "${b.head}"`);
    }
}
