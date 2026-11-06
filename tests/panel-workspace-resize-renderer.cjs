// 用 Electron 执行：electron tests/panel-workspace-resize-renderer.cjs
// 真实 CSS + 原生鼠标输入，检查快速往返时边缘的位置，不能用固定矩形的 DOM 替身覆盖。
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const output = path.resolve(__dirname, '../out/panel-workspace-resize-result.json');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-resize-check-')));
for (const flag of ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding',
    'disable-background-timer-throttling']) app.commandLine.appendSwitch(flag);
let finished = false;
function finish(result) {
    if (finished) return;
    finished = true;
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
}
setTimeout(() => finish({ ok: false, error: '面板拖动检查超时' }), 20000);

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1400, height: 850,
        webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/panel-workspace-resize.html'));
    assert.equal(await win.webContents.executeJavaScript('window.resizeReady'), true);
    // 完全隐藏的窗口会合并鼠标移动；显示但不抢焦点，保证每帧可以观测。
    win.showInactive();
    const readings = [];
    for (const [selector, index, axis, amplitude] of [
        ['.pw-gutter.pw-row', 0, 'x', 160],
        ['.pw-gutter.pw-row', 1, 'x', 160],
        ['.pw-gutter.pw-col', 0, 'y', 100],
    ]) {
        const geometry = await win.webContents.executeJavaScript(`resizeGeometry(${JSON.stringify(selector)})`);
        const start = geometry[index];
        const x = Math.round(start.x), y = Math.round(start.y);
        const offset = start[axis] - (axis === 'x' ? x : y);
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
        let maxError = 0, neighborError = 0;
        for (let step = 0; step < 160; step++) {
            const delta = Math.round(amplitude * Math.sin(step / 159 * Math.PI * 6));
            const pointer = { x: x + (axis === 'x' ? delta : 0), y: y + (axis === 'y' ? delta : 0) };
            win.webContents.sendInputEvent({ type: 'mouseMove', ...pointer, modifiers: ['leftButtonDown'] });
            const current = await win.webContents.executeJavaScript(`new Promise(resolve =>
                requestAnimationFrame(() => resolve(resizeGeometry(${JSON.stringify(selector)}))))`);
            maxError = Math.max(maxError, Math.abs(current[index][axis] - pointer[axis] - offset));
            geometry.forEach((neighbor, i) => {
                if (i !== index) neighborError = Math.max(neighborError, Math.abs(current[i][axis] - neighbor[axis]));
            });
        }
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
        const released = await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => resolve({
            resizing: document.querySelector('#desk').classList.contains('pw-resizing'),
            dragging: document.querySelectorAll('.pw-gutter[data-dragging]').length, saves: resizeSaves,
        })))`);
        readings.push({ selector, index, samples: 160, maxError, neighborError, released });
        assert.ok(maxError < 1, `分隔条与指针偏差 ${maxError.toFixed(2)}px，应小于 1px`);
        assert.ok(neighborError < 1, '拖动不能带动另一条分隔线');
        assert.equal(released.resizing, false);
        assert.equal(released.dragging, 0);
        assert.equal(released.saves, readings.length, '每次拖动只在松手时保存一次');
    }
    finish({ ok: true, readings });
}).catch(error => finish({ ok: false, error: error.stack || String(error) }));
