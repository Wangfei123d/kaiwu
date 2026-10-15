// 用真实画布和浏览器指针验证整节点拖动；项目和图片均为内存夹具。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/18014/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');

(async () => {
    const { palette } = await import('file://' + path.join(root, 'electron/drama/lib/core.js').replaceAll('\\', '/'));
    const graph = { nodes: [
        { id: 'text', type: 'text', x: 20, y: 20, w: 300, h: 220, params: { value: '完整的剧本文字，按住这里拖动节点。\n第二行：人物走进便利店。' } },
        { id: 'refs', type: 'image-input', x: 420, y: 20, w: 280, h: 350, params: { files: ['ref.png', 'other.png'] } },
        { id: 'out', type: 'llm', x: 20, y: 390, w: 300, h: 280, params: { prompt: '生成剧本' } },
        { id: 'skill', type: 'skill', x: 820, y: 20, w: 250, h: 180, title: '镜头技能', params: { purpose: '镜头', text: '特写与中景' } },
    ], edges: [{ from: 'skill', to: 'out', fromPort: 0, toPort: 1 }],
    runs: { out: { status: 'ok', output: '# 生成结果\n\n这是可以拖动的 Markdown 正文。\n\n第二段文字。' } } };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app/styles/tokens.css">
    <style>*{box-sizing:border-box}body{margin:0;color:var(--text);background:var(--bg)}#host{height:920px}</style>
    <div id="host" data-plugin="drama"></div><script type="module">
    import plugin from '/plugins/drama/index.js';
    let graph=${JSON.stringify(graph)};window.saved=structuredClone(graph);window.fileDialogs=0;const panes=[];
    plugin.activate({onDispose(){},log:{info(){},warn(){}},panes:{register(p){panes.push(p)}},
      dialog:{openFile:async()=>{window.fileDialogs++;return[]}},
      drama:{root:async()=>({root:'fixture'}),projects:async()=>({projects:['fixture'],items:[{name:'fixture'}]}),
        state:async()=>({project:'fixture',graph,types:${JSON.stringify(palette())}}),
        media:async()=>({mime:'image/png',base64:${JSON.stringify(png)}}),
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
        const page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
        const errors = [];page.on('pageerror', e => errors.push(e.message));
        const url = `http://127.0.0.1:${server.address().port}`;
        const card = id => page.locator(`[data-node-id="${id}"]`);
        const position = id => card(id).evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
        const reset = async () => {
            await page.goto(url);await card('text').waitFor();
            await card('refs').locator('.drama-image-main').waitFor({state:'visible'});
        };
        async function drag(area, dx = 65, dy = 35) {
            const box = await area.boundingBox();assert.ok(box, '拖动目标必须可见');
            const x = box.x + Math.min(30, box.width / 2);
            const y = box.y + Math.min(18, box.height / 2);
            await page.mouse.move(x, y);await page.mouse.down();
            await page.mouse.move(x + dx, y + dy, { steps: 10 });await page.mouse.up();
        }
        async function assertDrag(id, selector, label) {
            await reset();const before = await position(id);
            await drag(card(id).locator(selector).first());
            const after = await position(id);
            assert.ok(after.x > before.x + 20 && after.y > before.y + 10, `${label}应移动整个节点：${JSON.stringify({before,after})}`);
            await page.waitForFunction(({id,after}) => {const n=window.saved.nodes.find(n=>n.id===id);return n.x===after.x&&n.y===after.y}, {id,after});
            assert.equal(await card(id).locator('textarea').count(), 0, '拖动完成不应误进入编辑');
            assert.equal(await card(id).evaluate(el => el.classList.contains('dragging')), false, '拖动状态必须清理');
            console.log(`PASS ${label}`);
        }
        await assertDrag('text', '.drama-text-content', '文本正文拖动并保存');
        await assertDrag('out', '.drama-output-markdown p', 'Markdown 结果拖动');
        await assertDrag('refs', '.drama-image-main', '图片预览拖动');
        await assertDrag('refs', '.drama-reference-add', '按钮区域拖动');
        assert.equal(await page.evaluate(()=>window.fileDialogs), 0, '拖动按钮不能触发导入');
        await card('refs').locator('.drama-reference-add').click();
        assert.equal(await page.evaluate(()=>window.fileDialogs), 1, '拖动后的普通点击仍应打开导入');
        await assertDrag('out', '.drama-skill-caption', '技能面板拖动');

        await reset();
        const tab = card('out').locator('.drama-output-source-tab');
        await drag(tab);
        assert.equal(await tab.getAttribute('aria-selected'), 'false', '拖动标签按钮不能切换显示模式');
        await tab.click();assert.equal(await tab.getAttribute('aria-selected'), 'true', '普通点击仍能切换显示模式');

        await reset();
        const cancelBefore = await position('refs');
        const cancelButton = card('refs').locator('.drama-reference-add');
        const cb = await cancelButton.boundingBox();
        await page.mouse.move(cb.x+12,cb.y+10);await page.mouse.down();
        await page.mouse.move(cb.x+70,cb.y+45,{steps:8});
        assert.ok((await position('refs')).x>cancelBefore.x+20, '取消前拖动已经开始');
        await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
        assert.deepEqual(await position('refs'),cancelBefore,'窗口失焦应取消拖动并恢复坐标');
        assert.equal(await card('refs').evaluate(el=>el.classList.contains('dragging')),false,'取消后不能残留拖动样式');
        await page.mouse.up();await cancelButton.click();
        assert.equal(await page.evaluate(()=>window.fileDialogs),1,'取消拖动后按钮仍正常');
        console.log('PASS 窗口失焦取消和下一次点击');

        await reset();
        const fastBefore = await position('text');
        const fb = await card('text').locator('.drama-text-content').boundingBox();
        await page.mouse.move(fb.x+fb.width-3,fb.y+15);await page.mouse.down();
        await page.mouse.move(fb.x+fb.width+65,fb.y+50);await page.mouse.up();
        assert.ok((await position('text')).x>fastBefore.x+20,'指针一步划出节点也不能丢失拖动');
        console.log('PASS 快速划出节点仍能拖动');

        await reset();
        await card('text').locator('.drama-node-head').click();
        await card('text').locator('.drama-node-head').click();
        const input = card('text').locator('textarea');await input.waitFor();
        const value = await input.inputValue();const beforeEdit = await position('text');
        await drag(input);
        assert.ok((await position('text')).x > beforeEdit.x + 20, '文本框区域也能拖动节点');
        assert.equal(await input.inputValue(), value, '文本框拖动不能改变正文');
        await input.click();await input.press('End');await input.press('!');
        assert.ok((await input.inputValue()).includes('!'), '拖动后仍能编辑');
        const beforeSelection = await position('text');
        const b = await input.boundingBox();
        await page.keyboard.down('Shift');
        await page.mouse.move(b.x+8,b.y+10);await page.mouse.down();
        await page.mouse.move(b.x+110,b.y+10,{steps:10});await page.mouse.up();
        await page.keyboard.up('Shift');
        assert.deepEqual(await position('text'), beforeSelection, 'Shift 选字应保留节点位置');
        assert.ok(await input.evaluate(el=>el.selectionEnd>el.selectionStart), 'Shift 拖动仍能选择文字');
        console.log('PASS 文本框拖动、继续编辑与 Shift 选字');

        await reset();
        const beforeResize = await position('text');
        await card('text').locator('.drama-node-head').click();
        const oldHeight = await card('text').evaluate(el=>el.offsetHeight);
        await drag(card('text').locator('.drama-resize-edge.s'), 0, 45);
        assert.ok(await card('text').evaluate(el=>el.offsetHeight)>oldHeight+20, '边缘仍能拉伸');
        assert.deepEqual(await position('text'), beforeResize, '下边缘拉伸不能拖走节点');
        const beforePort = await position('text');
        await drag(card('text').locator('.drama-port-output'));
        assert.deepEqual(await position('text'), beforePort, '端口拖动不能移动节点');
        console.log('PASS 拉伸和端口手势');

        await reset();
        const t = await card('text').boundingBox();const o = await card('out').boundingBox();
        await page.mouse.move(t.x-10,t.y-10);await page.mouse.down();
        await page.mouse.move(Math.max(t.x+t.width,o.x+o.width)+10,o.y+o.height+10,{steps:15});await page.mouse.up();
        assert.equal(await page.locator('.drama-node.sel').count(), 2, '框选夹具应选择两个节点');
        const groupBefore = {text:await position('text'),out:await position('out')};
        await drag(card('text').locator('.drama-text-content'));
        const groupAfter = {text:await position('text'),out:await position('out')};
        assert.ok(groupAfter.text.x>groupBefore.text.x+20);
        assert.equal(groupAfter.text.x-groupBefore.text.x,groupAfter.out.x-groupBefore.out.x,'整组拖动横向间距保持');
        assert.equal(groupAfter.text.y-groupBefore.text.y,groupAfter.out.y-groupBefore.out.y,'整组拖动纵向间距保持');
        console.log('PASS 内容区拖动多选组');
        assert.deepEqual(errors, []);
        console.log('Node drag checks passed. No user files or model requests.');
    } finally { if (browser) await browser.close();await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error);process.exitCode = 1; });
