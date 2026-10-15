// 坏文件到底是"整份替换"还是"局部覆盖"?
// 判据:①非文本字节占比;②还认不认得出 JS 源码片段;③有没有大段连续的可打印内容。
import fs from 'node:fs';

const files = [
    'app/lib/agent-stream.js',
    'plugins/ai-session/panel.js',
    'plugins/ai-session/style.css',
    'tests/agent-supervisor.test.js',
    'tests/notes-view.test.js',
    'tests/markdown-nodes.test.js',
];

const MARKERS = {
    'app/lib/agent-stream.js': ['export function', 'reduceAgentEvent', 'normalizeConfigOptions', 'export const MAX_NOTE_CHARS'],
    'plugins/ai-session/panel.js': ['export function setup', 'renderList', 'sessions:new', 'ses-row'],
    'plugins/ai-session/style.css': ['.ses-pane', '.ses-new', '#7ec8ff'],
    'tests/agent-supervisor.test.js': ['import { test }', 'test(', 'assert'],
    'tests/notes-view.test.js': ['import { test }', 'test(', 'assert'],
    'tests/markdown-nodes.test.js': ['import { test }', 'test(', 'assert'],
};

for (const f of files) {
    const buf = fs.readFileSync(f);
    const text = buf.toString('utf8');
    let bad = 0;
    for (const b of buf) if (b === 0) bad += 1;
    const fffd = (text.match(/\uFFFD/g) ?? []).length;
    // 最长的一段"看起来像源码"的连续内容(可打印 ASCII / 常见标点,长度 ≥ 20 的连续块)
    let run = 0;
    let best = 0;
    for (const b of buf) {
        const printable = b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127);
        if (printable) { run += 1; if (run > best) best = run; } else run = 0;
    }
    const found = (MARKERS[f] ?? []).filter((m) => text.includes(m));
    console.log(`${f}\n   ${buf.length} 字节 | NUL ${bad} (${(bad / buf.length * 100).toFixed(1)}%) | U+FFFD ${fffd} | 最长可打印连续段 ${best} 字节`);
    console.log(`   认得出的源码标记: ${found.length ? JSON.stringify(found) : '(一个都没有)'}`);
}
