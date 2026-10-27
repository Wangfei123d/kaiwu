// 用真实 Chromium 验证 AI 生图等待动效，不连接 Agent 或图片服务。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'agent-image-generation-renderer-result.json');
app.setPath('userData', path.join(os.tmpdir(), 'kaiwu-image-generation-smoke'));
let finished = false;
function finish(result) {
    if (finished) return;
    finished = true;
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
}
setTimeout(() => finish({ ok: false, error: 'Renderer smoke timed out after 20 seconds' }), 20000);
app.whenReady().then(async () => {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="240"><rect width="120" height="240" fill="#7ec8ff"/><circle cx="60" cy="60" r="30" fill="#17202b"/></svg>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const imageUrl = `http://127.0.0.1:${server.address().port}/generated.png`;
    const win = new BrowserWindow({ show: false, width: 468, height: 794,
        webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures', 'agent-image-generation-smoke.html'));
    const result = await win.webContents.executeJavaScript(`window.runImageGenerationSmoke(${JSON.stringify(imageUrl)})`);
    finish(result);
}).catch(error => finish({ ok: false, error: error.stack || String(error) }));
