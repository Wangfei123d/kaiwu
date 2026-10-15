// ① 合成拖拽补一次移动:第一次移动只够"跨过阈值、激活拖动",位置要到第二次才更新
//    (轨迹给出的证据:落点坐标停在按下那一行上 → insideCanvas 判定为 false)。
// ② 图片那条之后再读一次轨迹(dropLast 每次覆盖,读一次只够看一件事)。
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

patch('electron/selftest.js', [
    [
        `            row.dispatchEvent(ev('pointerdown', \${from.x}, \${from.y}, 1));
            // 移动/松手挂在 document 上(笔记树的拖动状态机就在那一层听)
            document.dispatchEvent(ev('pointermove', \${to.x}, \${to.y}, 1));
            document.dispatchEvent(ev('pointerup', \${to.x}, \${to.y}, 0));`,
        `            row.dispatchEvent(ev('pointerdown', \${from.x}, \${from.y}, 1));
            // ⚠️ **两次**移动:第一次只是跨过阈值、把拖动"激活"(那一下位置还不更新),
            //    第二次才是把落点放到目标上 —— 实测:只发一次,落点坐标会停在按下那一行上,
            //    于是画布判定"不在我范围内"(轨迹里就是这句话)。
            document.dispatchEvent(ev('pointermove', \${from.x + 8}, \${from.y + 8}, 1));
            document.dispatchEvent(ev('pointermove', \${to.x}, \${to.y}, 1));
            // 移动/松手挂在 document 上(笔记树的拖动状态机就在那一层听)
            document.dispatchEvent(ev('pointerup', \${to.x}, \${to.y}, 0));`,
    ],
    [
        `        await dropSleep(1400);
        const graphAfterImage = readGraph();`,
        `        await dropSleep(1400);
        const imageTrace = await win.webContents.executeJavaScript(\`(() => {
            const c = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-canvas');
            return c?.dataset?.dropLast ?? null;
        })()\`);
        const graphAfterImage = readGraph();`,
    ],
    [
        `            JSON.stringify({ sent: pngSent, reference: refNode?.params?.reference }));`,
        `            JSON.stringify({ sent: pngSent, trace: imageTrace, reference: refNode?.params?.reference }));`,
    ],
]);
