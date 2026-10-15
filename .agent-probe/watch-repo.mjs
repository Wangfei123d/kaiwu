// 判定"有没有东西正在写这个仓库":先取一份清单,等一会儿,再取一份,比差异。
// 我这一侧在这段时间里**什么都不写**(只读)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const roots = ['app', 'electron', 'plugins', 'tools', 'tests'];
const exts = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.html', '.md', '.yml', '.txt']);

function snapshot() {
    const out = new Map();
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
            if (!e.isFile()) continue;
            if (!exts.has(path.extname(e.name).toLowerCase())) continue;
            const buf = fs.readFileSync(p);
            out.set(p, {
                size: buf.length,
                hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
                mtime: fs.statSync(p).mtimeMs,
                text: !(buf.includes(0) || buf.toString('utf8').includes('\uFFFD')),
            });
        }
    };
    for (const r of roots) walk(r);
    return out;
}

const a = snapshot();
console.log('清单 A:', a.size, '个文件;其中"不是文本"的:', [...a.values()].filter((v) => !v.text).length);
for (const [p, v] of a) if (!v.text) console.log('  坏:', p, v.size);

const waitMs = Number(process.argv[2] ?? 60000);
console.log(`\n等 ${Math.round(waitMs / 1000)} 秒(这期间我不写任何东西)……`);
await new Promise((res) => { setTimeout(res, waitMs); });

const b = snapshot();
console.log('清单 B:', b.size, '个文件;其中"不是文本"的:', [...b.values()].filter((v) => !v.text).length);
const changed = [];
for (const [p, v] of b) {
    const old = a.get(p);
    if (old === undefined) { changed.push(`${p} 新出现`); continue; }
    if (old.hash !== v.hash) {
        changed.push(`${p} 变了(${old.size}→${v.size}${old.text && !v.text ? ',由文本变成二进制' : ''})`);
    }
}
for (const [p] of a) if (!b.has(p)) changed.push(`${p} 消失了`);
console.log('\n这段时间内变化的文件:', changed.length);
for (const c of changed) console.log('  ', c);
