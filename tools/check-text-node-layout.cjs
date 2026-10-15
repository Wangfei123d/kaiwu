// 真实画布的隔离布局回归：仅使用夹具，不读写用户项目或调用模型。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/18014/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
(async () => {
    const { palette } = await import('file://' + path.join(root, 'electron/drama/lib/core.js').replaceAll('\\', '/'));
    const text = ('分镜剧本：夜色中的便利店。人物对白、动作和镜头说明。\n').repeat(80) + '正文末尾';
    const graph = { nodes: [
        { id: 'text', type: 'text', x: 20, y: 20, w: 400, h: 300, params: { value: text } },
        { id: 'empty', type: 'text', x: 480, y: 20, params: { value: '' } },
        { id: 'fresh', type: 'text', x: 480, y: 160, w: 280, h: 200, params: { value: '未运行的新节点正文\n第二行' } },
    ], edges: [], runs: { text: { status: 'cached', output: text } } };
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app/styles/tokens.css">
    <style>*{box-sizing:border-box}body{margin:0;color:var(--text);background:var(--bg)}#host{height:850px}</style>
    <div id="host" data-plugin="drama"></div><script type="module">
    import plugin from '/plugins/drama/index.js';
    let graph=${JSON.stringify(graph)};window.saved=graph;const panes=[];
    plugin.activate({onDispose(){},log:{info(){},warn(...a){console.error(...a)}},panes:{register(p){panes.push(p)}},
      dialog:{openFile:async()=>['C:/fixture/script.txt']},
      drama:{root:async()=>({root:'fixture'}),projects:async()=>({projects:['fixture'],items:[{name:'fixture'}]}),
        state:async()=>({project:'fixture',graph,types:${JSON.stringify(palette())}}),
        save:async(_p,g)=>{graph=structuredClone(g);window.saved=graph},onRunEvent(){return()=>{}}}});
    panes.find(p=>p.id==='drama').mount(document.getElementById('host'));</script>`;
    const server = http.createServer((req, res) => {
        const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (route === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8');res.end(html);return; }
        const file = path.resolve(root, '.' + route);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404);res.end();return; }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        const source = fs.readFileSync(file, 'utf8');
        res.end(file.endsWith('.js') ? source.replaceAll('toolbox://shell/', '/app/') : source);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1250, height: 870 } });
        const errors = [];page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const card = page.locator('[data-node-id="text"]');
        await card.waitFor();
        const content = card.locator('.drama-text-content, .drama-out');
        const reading = await content.evaluate(el => ({ height: el.offsetHeight, text: el.textContent,
            bottomGap: el.closest('.drama-node').getBoundingClientRect().bottom - el.getBoundingClientRect().bottom }));
        assert.ok(reading.height > 200, `300px 节点正文应填满剩余高度，实际只有 ${reading.height}px`);
        assert.ok(reading.bottomGap < 12, '正文应贴合节点下边距');
        assert.equal(reading.text, text, '全文不能截断为 120 字摘要');
        await card.screenshot({ path: path.join(root, 'docs/superpowers/plans/text-node-layout-read.png') });
        async function scrollInside(area) {
            const view = await page.locator('.drama-world').evaluate(el => el.style.transform);
            await area.hover();await page.mouse.wheel(0, 180);
            await page.waitForFunction(selector => document.querySelector(selector).scrollTop > 0,
                await area.evaluate(el => el.tagName === 'TEXTAREA' ? '[data-node-id="text"] textarea' : '.drama-text-content'));
            assert.equal(await page.locator('.drama-world').evaluate(el => el.style.transform), view, '滚动正文不应移动画布');
        }
        await scrollInside(content);
        await card.locator('.drama-node-head').click();
        async function resize(delta) {
            const edge = await card.locator('.drama-resize-edge.s').boundingBox();
            const scale = await page.locator('.drama-world').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
            await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);await page.mouse.down();
            await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2 + delta * scale, { steps: 10 });await page.mouse.up();
        }
        const oldHeight = await content.evaluate(el => el.offsetHeight);
        await resize(80);
        assert.ok(await content.evaluate(el => el.offsetHeight) > oldHeight + 70, '拉高时正文随动');
        await resize(-160);
        assert.ok(await card.evaluate(el => el.offsetHeight) < 260, '不能被正文 scrollHeight 锁住，必须能缩小');
        // 已选中的标题单击进入编辑；不要双击（双击标题原本用于复原尺寸）。
        await card.locator('.drama-node-head').click();
        const input = card.locator('textarea[data-param-key="value"]');await input.waitFor();
        assert.equal(await input.inputValue(), text);
        const editing = await input.evaluate(el => ({ height: el.offsetHeight, card: el.closest('.drama-node').offsetHeight,
            bottomGap: el.closest('.drama-node').getBoundingClientRect().bottom - el.getBoundingClientRect().bottom }));
        assert.ok(editing.height > 140, `编辑框填满节点: ${JSON.stringify(editing)}`);
        await scrollInside(input);
        const editHeight = await input.evaluate(el => el.offsetHeight);
        await resize(100);
        assert.ok(await input.evaluate(el => el.offsetHeight) > editHeight + 90, '编辑框随拉高变化');
        await card.screenshot({ path: path.join(root, 'docs/superpowers/plans/text-node-layout-edit.png') });
        await resize(-180);
        assert.ok(await card.evaluate(el => el.offsetHeight) < 180, '编辑状态也能缩小');
        assert.ok(await input.evaluate(el => el.offsetHeight) >= 48, '保留最小可编辑高度');
        await resize(-300);
        await card.locator('.drama-import').click();
        await card.locator('.drama-confirm').waitFor();
        const confirmation = await card.locator('.drama-confirm').evaluate(el => ({ bottom: el.getBoundingClientRect().bottom,
            cardBottom: el.closest('.drama-node').getBoundingClientRect().bottom }));
        assert.ok(confirmation.bottom < confirmation.cardBottom, '最小高度时，导入确认按钮不能被裁切');
        const inputBottom = await input.evaluate(el => el.getBoundingClientRect().bottom);
        const confirmTop = await card.locator('.drama-confirm').evaluate(el => el.getBoundingClientRect().top);
        assert.ok(inputBottom <= confirmTop, '导入确认条不能与编辑框重叠');
        await card.locator('.drama-confirm-no').click();
        await input.fill('修改后的完整正文\n第二行');await input.press('Escape');
        assert.equal(await card.locator('.drama-text-content').textContent(), '修改后的完整正文\n第二行', '显示当前正文而非旧缓存');
        await page.waitForFunction(() => window.saved.nodes[0].params.value === '修改后的完整正文\n第二行');
        const empty = page.locator('[data-node-id="empty"]');
        assert.ok(await empty.evaluate(el => el.offsetHeight) >= 92, '未设置尺寸的节点也有稳定高度');
        assert.ok(await empty.evaluate(el => el.offsetHeight) < 120, '无自定义高度的节点保持紧凑，不影响旧画布排布');
        assert.equal(await empty.locator('.drama-text-content').textContent(), '');
        const fresh = page.locator('[data-node-id="fresh"]');
        assert.equal(await fresh.locator('.drama-text-content').textContent(), '未运行的新节点正文\n第二行', '不依赖运行结果也能阅读当前正文');
        assert.ok(await fresh.locator('.drama-text-content').evaluate(el => el.offsetHeight) > 130);
        assert.deepEqual(errors, []);
        console.log('Text node layout passed: full current content, flexible read/edit height, grow/shrink, contained scroll, save, empty default. No user data or model calls.');
    } finally { if (browser) await browser.close();await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error);process.exitCode = 1; });
