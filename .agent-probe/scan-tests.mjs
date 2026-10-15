// 逐字节看清损坏范围:头 24 字节、尾 24 字节、是否有 NUL、mtime、大小。
// (上一轮把整个文件打出来,二进制内容把日志冲爆了 —— 这次只印摘要。)
import fs from 'node:fs';
import path from 'node:path';

const dir = 'tests';
const names = fs.readdirSync(dir).filter((n) => n.endsWith('.js'));
const rows = [];
for (const n of names.sort()) {
    const p = path.join(dir, n);
    const buf = fs.readFileSync(p);
    const st = fs.statSync(p);
    const head = buf.subarray(0, 24).toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '·');
    const tail = buf.subarray(Math.max(0, buf.length - 24)).toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '·');
    const nul = buf.includes(0);
    const okHead = /^(import|\/\/|\/\*)/.test(buf.subarray(0, 8).toString('utf8'));
    rows.push({
        name: n, bytes: buf.length,
        mtime: new Date(st.mtimeMs).toISOString().slice(5, 19),
        headOk: okHead, nul,
        head, tail,
    });
}
console.log('共', rows.length, '个 .js;不正常的(头不是 import/注释 或含 NUL):');
for (const r of rows) {
    if (!r.headOk || r.nul) console.log(JSON.stringify(r));
}
console.log('\n全部文件的头 20 字符:');
for (const r of rows) console.log(`${r.name.padEnd(34)} ${String(r.bytes).padStart(7)}  ${r.mtime}  ${r.head.slice(0, 20)}`);
