// 从 git 对象库里按"大小完全相同 + 认得出来的标记"把被写坏的文件捞回来。
// 为什么这条路能成:某些会话跑过 git add(或被索引过),blob 就永久留在对象库里 ——
// 即使从没提交过。上面 agent-stream.js 就是这么找到的(64967 字节,一模一样)。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'E:\\project';
const OUT = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\recovered';
fs.mkdirSync(OUT, { recursive: true });

const targets = [
    { file: 'kaiwu/app/lib/agent-stream.js', markers: ['normalizeConfigOptions', 'reduceAgentEvent'] },
    { file: 'kaiwu/tests/markdown-nodes.test.js', markers: ['renderMarkdownNodes', 'markdown'] },
    { file: 'kaiwu/tests/notes-view.test.js', markers: ['notes-view', 'noteList'] },
    { file: 'kaiwu/plugins/ai-session/panel.js', markers: ['ses-row', 'export function setup'] },
    { file: 'kaiwu/plugins/ai-session/style.css', markers: ['.ses-pane', 'ses-badge'] },
    { file: 'kaiwu/tests/agent-supervisor.test.js', markers: ['supervisor'] },
];

const listing = execFileSync('git', ['-C', REPO, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname) %(objectsize)'], { maxBuffer: 1 << 28 })
    .toString('utf8').split('\n').filter((l) => l.startsWith('blob '));
const blobs = listing.map((l) => {
    const [, sha, size] = l.split(' ');
    return { sha, size: Number(size) };
});

for (const t of targets) {
    const abs = path.join(REPO, t.file);
    const damaged = fs.readFileSync(abs);
    const sameSize = blobs.filter((b) => b.size === damaged.length);
    const bySize = blobs.filter((b) => Math.abs(b.size - damaged.length) <= Math.max(64, damaged.length * 0.02));
    let hit = null;
    for (const b of sameSize.concat(bySize)) {
        const buf = execFileSync('git', ['-C', REPO, 'cat-file', 'blob', b.sha], { maxBuffer: 1 << 28 });
        const text = buf.toString('utf8');
        if (t.markers.every((m) => text.includes(m))) { hit = { ...b, buf }; break; }
    }
    if (hit === null) {
        console.log(`✗ ${t.file}  (坏 ${damaged.length} 字节) —— 对象库里没有匹配的副本`);
        continue;
    }
    const dest = path.join(OUT, t.file.replace(/[\\/]/g, '__'));
    fs.writeFileSync(dest, hit.buf);
    console.log(`★ ${t.file}\n   找回 ${hit.buf.length} 字节 (blob ${hit.sha.slice(0, 8)}) → ${dest}`);
}
