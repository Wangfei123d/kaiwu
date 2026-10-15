// 全仓源码体检:哪些文件不是能读的文本(含 NUL / 二进制垃圾 / 不是合法 UTF-8)。
// 起因:tests/ 下两个文件被写成了二进制垃圾(一个从 09-18 起、一个 09-26),
// 而仓库里本来就有两个乱码目录名 —— 先把"还有没有别的"这件事查清。
import fs from 'node:fs';
import path from 'node:path';

const roots = ['app', 'electron', 'plugins', 'tools', 'tests'];
const exts = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.html', '.md', '.yml', '.txt']);
const bad = [];
let scanned = 0;

function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            walk(p);
            continue;
        }
        if (!e.isFile()) continue;
        if (!exts.has(path.extname(e.name).toLowerCase())) continue;
        scanned += 1;
        const buf = fs.readFileSync(p);
        const nul = buf.includes(0);
        const text = buf.toString('utf8');
        const replacement = text.includes('\uFFFD');
        if (nul || replacement) {
            bad.push({ file: p, bytes: buf.length, nul, replacement, head: buf.subarray(0, 16).toString('hex') });
        }
    }
}

for (const r of roots) walk(r);
console.log('扫了', scanned, '个文本文件;有问题的:', bad.length);
for (const b of bad) console.log(JSON.stringify(b));
