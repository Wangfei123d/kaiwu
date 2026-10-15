// 全仓语法体检:每个 .js/.mjs/.cjs 都过一次 node --check。
// 为什么需要:前一轮只查了 NUL / 坏 UTF-8,漏得下"没有 NUL、但内容被换掉"的损伤
// (drama-ipc.test.js 就是这种:能读、能 parse 到一半,却报一个没有细节的 'test failed')。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['app', 'electron', 'plugins', 'tools', 'tests'];
const files = [];
const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            walk(p);
            continue;
        }
        if (e.isFile() && ['.js', '.mjs', '.cjs'].includes(path.extname(e.name).toLowerCase())) files.push(p);
    }
};
for (const r of roots) walk(r);

const bad = [];
for (const f of files) {
    try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (err) {
        const msg = String(err.stderr ?? '').split('\n').slice(0, 3).join(' | ');
        bad.push(`${f}  (${fs.statSync(f).size} 字节) ${msg}`);
    }
}
console.log('检查', files.length, '个文件;语法不过的:', bad.length);
for (const b of bad) console.log('  ✗', b);
