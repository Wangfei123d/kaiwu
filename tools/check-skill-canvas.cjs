// 隔离画布验证：使用真实插件和类型表，所有模型/文件接口由本地夹具替代。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/18014/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const projectRoot = path.resolve(__dirname, '..');
(async () => {
    const { palette } = await import('file:///E:/project/kaiwu/electron/drama/lib/core.js');
    const { skillCandidates, skillMatchKey } = await import('file:///E:/project/kaiwu/app/lib/drama-skills.js');
    const graph = { nodes: [
        { id: 'text', type: 'text', title: '人物设定', x: 15, y: 25, w: 220, params: { value: '人物外观素材' } },
        { id: 'refs', type: 'image-input', title: '参考图片', x: 15, y: 150, w: 220, params: { files: [] } },
        { id: 'skill', type: 'skill', title: '人物一致性', x: 280, y: 25, w: 280,
            params: { purpose: '同一人物外观', scenarios: '保持长相', exclude: '不需要人物', value: '保持黑色短发' } },
        { id: 'out', type: 'image', title: '画面生成', x: 615, y: 25, w: 340, h: 500,
            params: { prompt: '生成同一个人的雨夜镜头', batch: 1 } },
    ], edges: [{ from: 'text', to: 'skill', toPort: 0 }, { from: 'skill', to: 'out', toPort: 1 }], runs: {} };
    graph.skillMatches = { out: { key: skillMatchKey(graph.nodes[3].params.prompt, skillCandidates(graph, 'out')),
        selected: [{ id: 'skill', reason: '要求保持人物长相', evidence: '同一个人' }] } };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKQAAAABJRU5ErkJggg==';
    const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app/styles/tokens.css"><style>*{box-sizing:border-box}body{margin:0;padding:15px;background:var(--bg);color:var(--text)}#host{height:800px}</style></head><body><div id="host" data-plugin="drama"></div><script type="module">
    import plugin from '/plugins/drama/index.js';
    import {skillCandidates,skillMatchKey} from '/app/lib/drama-skills.js';
    let graph=${JSON.stringify(graph)}; const types=${JSON.stringify(palette())};
    window.saved=graph;window.calls={imports:0,media:0,reads:0};let listener;const panes=[];
    const ctx={onDispose(){},log:{info(){},warn(...a){console.error(...a)}},panes:{register(p){panes.push(p)}},
      dialog:{openFile:async()=>['C:/fixture/ref.png']},drama:{root:async()=>({root:'fixture',reason:null}),
      projects:async()=>({projects:['fixture'],items:[{name:'fixture'}]}),state:async()=>({project:'fixture',graph,types}),
      save:async(_p,g)=>{graph=structuredClone(g);window.saved=graph},onRunEvent:fn=>{listener=fn;return()=>{}},
      importImage:async()=>{window.calls.imports++;return{file:'ref.png'}},
      media:async()=>{window.calls.media++;return{mime:'image/png',base64:'${png}'}},
      readOutput:async()=>{window.calls.reads++;return{text:'完整实际输入：人物外观素材，保持黑色短发'}},
      run:async({runId})=>{
        const skillMatch={key:skillMatchKey(graph.nodes.find(n=>n.id==='out').params.prompt,skillCandidates(graph,'out')),
          selected:[{id:'skill',reason:'要求保持人物长相',evidence:'同一个人'}]};
        graph.skillMatches={out:skillMatch};
        listener({project:'fixture',runId,nodeId:'out',status:'skillMatched',skillMatch});
        listener({project:'fixture',runId,nodeId:'out',status:'running'});
        graph.runs.out={status:'running',skillInput:{file:'outputs/input.txt',text:'摘要',images:['ref.png']}};
        listener({project:'fixture',runId,nodeId:'out',status:'inputReady',run:graph.runs.out});
        await new Promise(r=>{window.finishGeneration=r});
        graph.runs.out={status:'ok',media:['frame.png'],skillInput:{file:'outputs/input.txt',text:'摘要',images:['ref.png']}};
        listener({project:'fixture',runId,nodeId:'out',status:'ok'});
        return{summary:'夹具生成完成',state:{graph}};
      }}};
    plugin.activate(ctx);panes.find(p=>p.id==='drama').mount(document.getElementById('host'));
    </script></body></html>`;
    const server = http.createServer((req, res) => {
        const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (relative === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8');res.end(html);return; }
        const file = path.resolve(projectRoot, '.' + relative);
        if (!file.startsWith(projectRoot + path.sep) || !fs.existsSync(file)) { res.writeHead(404);res.end();return; }
        const source = fs.readFileSync(file, 'utf8');
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        res.end(file.endsWith('.js') ? source.replaceAll('toolbox://shell/', '/app/') : source);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1270, height: 840 } });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const out = page.locator('[data-node-id="out"]');
        const skill = page.locator('[data-node-id="skill"]');
        const refs = page.locator('[data-node-id="refs"]');
        await out.locator('.drama-skill-row.active').waitFor();
        assert.equal(await out.locator('.drama-port-input').count(), 2);
        assert.equal(await skill.locator('.drama-port-input').count(), 2);
        assert.equal(await page.locator('.drama-edge-skill.active').count(), 1);
        assert.equal((await page.evaluate(() => window.calls)).media, 0, '待命时没有偷偷读取技能图片');
        await refs.locator('.drama-reference-add').click();
        await refs.locator('.drama-image-main:not([hidden])').waitFor();
        assert.equal((await page.evaluate(() => window.calls)).imports, 1);
        const from = await refs.locator('.drama-port-output').boundingBox();
        const to = await skill.locator('.drama-port-input[data-port-index="1"]').boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });await page.mouse.up();
        await out.locator('.drama-skill-caption').filter({ hasText: '待匹配' }).waitFor();
        assert.equal(await page.locator('.drama-edge-skill.dormant').count(), 1);
        await skill.locator('.drama-node-head').click();await skill.locator('.drama-node-head').click();
        await skill.locator('input[data-skill-name]').fill('角色一致性');
        await skill.locator('textarea[data-param-key="purpose"]').fill('保持同一人物外观和服装');
        assert.equal(await skill.locator('.drama-disconnect').count(), 2);
        await out.locator('.drama-node-head').click();
        await page.locator('.drama-runhere').click();
        await out.locator('.drama-skill-row.active').waitFor();
        assert.equal((await page.evaluate(() => window.calls)).reads, 0);
        await out.locator('.drama-skill-actual summary').click();
        await out.locator('.drama-skill-input').filter({ hasText: '完整实际输入' }).waitFor();
        assert.ok(await out.evaluate(el=>el.classList.contains('generating')), 'inputReady 保持生成扫光');
        await page.evaluate(()=>window.finishGeneration());
        await out.locator('.drama-node-body > .drama-image-gallery .drama-image-main:not([hidden])').waitFor();
        // 完成后面板会重建，复用已懒读的正文。
        await out.locator('.drama-skill-actual summary').click();
        await out.locator('.drama-skill-input').filter({ hasText: '完整实际输入' }).waitFor();
        assert.equal(await out.locator('.drama-skill-actual .drama-image-feature').evaluate(el => el.offsetHeight), 145);
        assert.ok(await out.locator('.drama-node-body > .drama-image-gallery .drama-image-feature').evaluate(el => el.offsetHeight) >= 88);
        assert.equal((await page.evaluate(() => window.calls)).reads, 1);
        // 再次运行时保持上一轮生成图，并在 pending 阶段更新实际输入。
        await page.locator('.drama-runhere').click();
        await page.waitForFunction(() => document.querySelector('[data-node-id="out"]').classList.contains('generating'));
        assert.equal(await out.locator('.drama-node-body > .drama-image-gallery .drama-image-main:not([hidden])').count(), 1);
        await out.locator('.drama-skill-actual summary').click();
        await out.locator('.drama-skill-input').filter({ hasText: '完整实际输入' }).waitFor();
        assert.equal((await page.evaluate(() => window.calls)).reads, 1, '同一快照全文读取复用缓存');
        await page.evaluate(()=>window.finishGeneration());
        await page.waitForFunction(() => !document.querySelector('[data-node-id="out"]').classList.contains('generating'));
        await out.locator('.drama-skill-actual summary').click();
        await out.locator('.drama-skill-input').filter({ hasText: '完整实际输入' }).waitFor();
        const before = await page.locator('.drama-world').evaluate(el => el.style.transform);
        await out.locator('.drama-skill-input').evaluate(el => el.textContent += '\n技能正文'.repeat(80));
        await out.locator('.drama-skill-input').hover();await page.mouse.wheel(0, 180);
        await page.waitForFunction(() => document.querySelector('.drama-skill-input').scrollTop > 0);
        assert.equal(await page.locator('.drama-world').evaluate(el => el.style.transform), before);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(projectRoot, 'docs/superpowers/plans/skill-canvas-check.png'), fullPage: true });
        console.log('Skill canvas passed: reference import/preview, typed ports, drag connection, stale metadata, live activation, lazy actual input and contained scroll. No real model calls.');
    } finally { if (browser) await browser.close();await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error);process.exitCode = 1; });
