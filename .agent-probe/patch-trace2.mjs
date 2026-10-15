// 修好"逐步轨迹"的补丁(上一版在 `\n` 与 `${}` 的转义上写坏了,整份没打上)。
// 这次只改 onEnd 那一段(它里面没有 \n 字面量),并把 ${} 正确转义。
import fs from 'node:fs';

function patch(file, pairs) {
    let s = fs.readFileSync(file, 'utf8');
    const crlf = s.includes('\r\n');
    const fix = (t) => (crlf ? t.replace(/\n/g, '\r\n') : t);
    for (const [from, to] of pairs) {
        const f = fix(from);
        if (!s.includes(f)) { console.error('✗ MISS', file, JSON.stringify(from.slice(0, 70))); process.exit(1); }
        s = s.replace(f, fix(to));
    }
    fs.writeFileSync(file, s);
    console.log('patched', file);
}

patch('plugins/drama/drop-bus.js', [[
    `    const off = bus.onEnd(({ payload, clientX, clientY, insideTree }) => {
        arm(false);
        // 松在树里 = 一次笔记移动(与画布无关);松在画布外 = 不关我的事
        if (insideTree === true || payload === null || payload === undefined) return;
        if (!insideCanvas(clientX, clientY)) return;
        if (DROP_KINDS[payload.kind] === undefined) {
            setStatus(\`这种格式画布还用不了:\${payload.name}(只收文本 / 图片 / 视频)\`);
            return;
        }
        void applyDrop(payload, toWorld(clientX, clientY));
    });`,
    `    // 逐步留痕:接货这条路有五个判断,而**失败在任何一步的现象都一样**("松手什么都没发生")——
    // 所以每一步都写到 DOM 上(自检里读得到;页面日志只在自检抛异常时才打印,静默失败查不出来)。
    const trace = (text) => { try { el.canvas.dataset.dropLast = text; } catch { /* 写不进去就算了 */ } };
    const off = bus.onEnd(({ payload, clientX, clientY, insideTree }) => {
        arm(false);
        trace(\`onEnd kind=\${payload?.kind ?? 'null'} insideTree=\${insideTree} xy=\${clientX},\${clientY}\`);
        // 松在树里 = 一次笔记移动(与画布无关);松在画布外 = 不关我的事
        if (insideTree === true || payload === null || payload === undefined) { trace('停:松在树里,或没有载荷'); return; }
        if (!insideCanvas(clientX, clientY)) { trace('停:落点不在画布范围内'); return; }
        if (DROP_KINDS[payload.kind] === undefined) {
            setStatus(\`这种格式画布还用不了:\${payload.name}(只收文本 / 图片 / 视频)\`);
            trace(\`停:不认这种格式(\${payload.kind})\`);
            return;
        }
        trace(\`接住:\${payload.name} kind=\${payload.kind} abs=\${payload.absPath === '' ? '(空!库根没设?)' : payload.absPath}\`);
        void applyDrop(payload, toWorld(clientX, clientY)).then(
            () => trace(\`applyDrop 回来了:\${payload.name}\`),
            (err) => trace(\`applyDrop 抛错:\${err?.message ?? err}\`),
        );
    });`,
]]);

// 自检:把轨迹读出来(单独一条,读数里直接带原因)
patch('electron/selftest.js', [[
    `        r.ok('短剧画布·拖入:从笔记列表拖一个 .md 到画布 → 图上真的多了一个「文本 / 剧本」节点,正文就是那篇笔记',`,
    `        const dropTrace = await win.webContents.executeJavaScript(\`(() => {
            const c = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-canvas');
            return c?.dataset?.dropLast ?? null;
        })()\`);
        r.ok('短剧画布·拖入:接收路径的**逐步轨迹**(红的时候这里写着停在哪一步)',
            dropTrace !== null, String(dropTrace));

        r.ok('短剧画布·拖入:从笔记列表拖一个 .md 到画布 → 图上真的多了一个「文本 / 剧本」节点,正文就是那篇笔记',`,
]]);
