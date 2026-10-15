// 交付前的最低限度自检:标签配平 + 方案切换的三块 mock 都在 + 没有把 &lt;script&gt; 写坏。
import fs from 'node:fs';

const file = process.argv[2];
const t = fs.readFileSync(file, 'utf8');
const tags = ['div', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'p', 'span', 'pre', 'style', 'script', 'h2', 'h3', 'button', 'body', 'html'];
const bad = [];
for (const tag of tags) {
    const open = (t.match(new RegExp(`<${tag}(?=[ >])`, 'g')) ?? []).length;
    const close = (t.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (open !== close) bad.push(`${tag}: 开 ${open} / 闭 ${close}`);
}
console.log('不平衡的标签:', bad.length > 0 ? bad.join(' | ') : '无');

for (const id of ['m-jia', 'm-yi', 'm-bing']) {
    console.log(`mock ${id}:`, t.includes(`id="${id}"`) ? '在' : '缺失');
}
for (const id of ['b-jia', 'b-yi', 'b-bing']) {
    console.log(`按钮 ${id}:`, t.includes(`id="${id}"`) ? '在' : '缺失');
}
console.log('默认隐藏的块数:', (t.match(/class="hidden"/g) ?? []).length, '(应为 2)');
console.log('切换脚本:', /function pick\(k\)/.test(t) ? '在' : '缺失');
console.log('字节:', t.length, '| 行数:', t.split('\n').length);
