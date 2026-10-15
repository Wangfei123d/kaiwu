// Exercise real Chromium keyboard input and layout, independently of the user's vault.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('C:/Users/18014/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/plugins/note-canvas/style.css">
<style>body{margin:20px} .nc-pane{width:600px;height:440px} .nc-node{left:20px;top:20px;width:520px;height:370px}</style>
<div class="nc-pane"><article class="nc-node"><div class="nc-node-head">文本</div><div id="liveHost" class="nc-node-body"></div></article></div>
<div id="noteHost" style="width:520px; min-height:250px"></div>
<script type="module">
import {mountLiveMarkdown} from '/app/lib/live-markdown.js';
import {createEditor} from '/app/notes/editor.js';
window.noteEditor = createEditor({els:{rootEl:document.querySelector('#noteHost')},liveMarkdown:true});
window.mount = source => {
  window.editor?.dispose(); window.values = [];
  window.editor = mountLiveMarkdown(document.querySelector('#liveHost'), source, {onInput:value=>window.values.push(value)});
};
window.snapshot = () => {
  const surface = document.querySelector('.live-markdown-content'), selection = getSelection();
  let rect = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
  // A collapsed Range inside a BR has no rectangle; its line box does.
  if (!rect?.height && selection.anchorNode?.nodeName === 'BR') rect = selection.anchorNode.getBoundingClientRect();
  return {value:editor.value(), html:surface.innerHTML, renderedText:surface.innerText,
    caret:{node:selection.anchorNode?.nodeName,text:selection.anchorNode?.textContent,offset:selection.anchorOffset,
      connected:selection.anchorNode?.isConnected,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null},values:window.values};
};
window.mount('是粉色');
</script>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !/^\/(app|plugins)\//.test(pathname) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({channel:'msedge',headless:true});
    const page = await browser.newPage(); page.setDefaultTimeout(8000); const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => typeof window.snapshot === 'function');
    const surface = page.locator('.live-markdown-content');
    await surface.click(); await surface.press('Control+End');
    const before = await page.evaluate(() => snapshot());
    await surface.press('Enter');
    const after = await page.evaluate(() => snapshot());
    await page.keyboard.type('下一行');
    const typed = await page.evaluate(() => snapshot());
    assert.equal(after.value,'是粉色\n','Enter retains its newline');
    assert.ok(after.caret.rect?.height>0 && after.caret.rect.y>before.caret.rect.y+10,'Enter visibly moves the caret to the next line');
    assert.equal(typed.value,'是粉色\n下一行','Text entered after Enter stays on the new line');
    assert.ok(typed.caret.rect.y > before.caret.rect.y + 10, 'Continued typing is visibly on the new line');
    for (const [source, key] of [['正文','Enter'],['','Enter'],['正文','Shift+Enter'],['# 标题','Enter'],['- 条目','Enter']]) {
      await page.evaluate(source=>mount(source),source);
      await surface.click(); await surface.press('Control+End');
      let previous = await page.evaluate(()=>snapshot());
      for (let count=1;count<=3;count++) {
        await surface.press(key);
        const next = await page.evaluate(()=>snapshot());
        assert.equal(next.value,source+'\n'.repeat(count),`${JSON.stringify(source)}: consecutive ${key} ${count} preserves empty lines`);
        assert.ok(next.caret.connected && next.caret.rect?.height>0, 'Blank-line caret has a visible line box');
        if(previous.caret.rect?.height)assert.ok(next.caret.rect.y>previous.caret.rect.y+10,'Consecutive Enter visibly moves down');
        previous=next;
      }
      await page.keyboard.type('后续正文');
      const continued = await page.evaluate(()=>snapshot());
      assert.equal(continued.value,source+'\n\n\n后续正文','Typing after blank lines keeps every newline');
      await page.evaluate(value=>mount(value),continued.value);
      assert.equal(await page.evaluate(()=>editor.value()),continued.value,'Reopening keeps blank lines');
    }
    await page.evaluate(()=>mount('前后'));
    await surface.click(); await surface.press('Control+End');await surface.press('ArrowLeft');await surface.press('Enter');
    await page.keyboard.type('中');
    assert.equal(await page.evaluate(()=>editor.value()),'前\n中后','Mid-line Enter splits at the cursor');
    await surface.press('Backspace');await surface.press('Backspace');
    assert.equal(await page.evaluate(()=>editor.value()),'前后','Backspace at the start of a line rejoins it');
    await page.evaluate(()=>mount('```\n代码\n```'));
    await surface.click();await surface.press('Control+End');await surface.press('Enter');await page.keyboard.type('新行');
    assert.equal(await page.evaluate(()=>editor.value()),'```\n代码\n新行\n```','Code block Enter keeps a literal newline');
    await page.evaluate(()=>noteEditor.load('---\ntags: [测试]\n---\n普通笔记'));
    const note = page.locator('#noteHost [contenteditable="true"]');
    await note.click();await note.press('Control+End');await note.press('Enter');await note.press('Enter');await page.keyboard.type('笔记新行');
    const savedNote = await page.evaluate(()=>noteEditor.value());
    assert.equal(savedNote,'---\ntags: [测试]\n---\n普通笔记\n\n笔记新行','Normal note editor keeps Enter and frontmatter');
    await page.evaluate(source=>{noteEditor.markClean();noteEditor.load(source)},savedNote);
    assert.equal(await page.evaluate(()=>noteEditor.value()),savedNote,'Saved normal note retains its line breaks on reload');
    assert.ok(await note.locator('p').filter({hasText:'笔记新行'}).isVisible(),'Normal note displays new text on its own rendered line');
    assert.deepEqual(errors,[]);
    console.log('PASS real Chromium: visible Enter, consecutive blank lines, Shift+Enter, continued typing, reopen, mid-line split, Backspace, code blocks and normal note editor');
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
