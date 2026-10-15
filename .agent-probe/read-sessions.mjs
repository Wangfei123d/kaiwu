// 看 dsh 的会话文件里到底有什么:kaiwu 想做「AI 会话面板」,先得知道
// "会话内容能不能读到、读到的是什么形状" —— 这决定方案可行性,猜不出来。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.join(process.env.APPDATA, 'kaiwu', 'dsh-home', 'sessions');
let shown = 0;
for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d);
    if (!fs.statSync(p).isDirectory()) continue;
    console.log('工作目录桶:', d);
    for (const id of fs.readdirSync(p)) {
        const f = path.join(p, id, 'session.v3.jsonl.zstd');
        if (!fs.existsSync(f)) continue;
        const buf = fs.readFileSync(f);
        let text;
        try { text = zlib.zstdDecompressSync(buf).toString('utf8'); }
        catch (e) { console.log(' ', id, '解压失败', e.message); continue; }
        const lines = text.split('\n').filter((l) => l.trim() !== '');
        console.log(`  ${id}  压缩 ${buf.length} → 解压 ${text.length} 字节, ${lines.length} 行`);
        if (shown < 2) {
            shown += 1;
            for (const line of lines.slice(0, 8)) console.log('     ', line.slice(0, 240));
        }
    }
}
