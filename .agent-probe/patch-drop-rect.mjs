// 让轨迹把 insideCanvas 那一层的**实际 rect** 也说出来 ——
// 下一次跑就能区分两种可能:①el.canvas 不是页面上那个可见元素(拿到的是 0×0);
// ②rect 正常,但坐标真的不在里面。
import fs from 'node:fs';

const file = 'plugins/drama/drop-bus.js';
let s = fs.readFileSync(file, 'utf8');
const crlf = s.includes('\r\n');
const fix = (t) => (crlf ? t.replace(/\n/g, '\r\n') : t);

const from = `    const insideCanvas = (clientX, clientY) => {
        if (!Number.isFinite(Number(clientX)) || !Number.isFinite(Number(clientY))) return false;
        const r = el.canvas.getBoundingClientRect();
        return Number(clientX) >= r.left && Number(clientX) <= r.right
            && Number(clientY) >= r.top && Number(clientY) <= r.bottom;
    };`;

const to = `    const insideCanvas = (clientX, clientY) => {
        if (!Number.isFinite(Number(clientX)) || !Number.isFinite(Number(clientY))) return false;
        const r = el.canvas.getBoundingClientRect();
        // 判定的**读数**也留一份:落点被判"不在范围内"时,只有把 rect 说出来才知道
        // 是"元素不是我看到的那个"(rect 全 0)还是"坐标真的偏了"(实测踩到过)。
        try {
            el.canvas.dataset.dropRect = \`\${Math.round(r.left)},\${Math.round(r.top)},\${Math.round(r.width)}x\${Math.round(r.height)} connected=\${el.canvas.isConnected === true} xy=\${clientX},\${clientY}\`;
        } catch { /* 写不进去就算了 */ }
        return Number(clientX) >= r.left && Number(clientX) <= r.right
            && Number(clientY) >= r.top && Number(clientY) <= r.bottom;
    };`;

if (!s.includes(fix(from))) { console.error('✗ 锚点没找到'); process.exit(1); }
fs.writeFileSync(file, s.replace(fix(from), fix(to)));
console.log('patched', file);

// 自检:轨迹那条断言把 rect 一起读出来
const sf = 'electron/selftest.js';
let ss = fs.readFileSync(sf, 'utf8');
const f2 = fix(`            return c?.dataset?.dropLast ?? null;
        })()\`);
        r.ok('短剧画布·拖入:接收路径的**逐步轨迹**(红的时候这里写着停在哪一步)',`);
const t2 = fix(`            return { last: c?.dataset?.dropLast ?? null, rect: c?.dataset?.dropRect ?? null };
        })()\`);
        r.ok('短剧画布·拖入:接收路径的**逐步轨迹**(红的时候这里写着停在哪一步,以及判定用的 rect)',`);
if (!ss.includes(f2)) { console.error('✗ 自检锚点没找到'); process.exit(1); }
ss = ss.replace(f2, t2);
ss = ss.replace(fix("            dropTrace !== null, String(dropTrace));"), fix("            dropTrace.last !== null, JSON.stringify(dropTrace));"));
fs.writeFileSync(sf, ss);
console.log('patched', sf);
