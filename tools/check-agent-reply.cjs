// Deterministic playback frames in a real Electron DOM; no provider or user vault.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.fix-backup-reply-check');
const resultPath = path.join(output, 'result.json');

if (!process.versions.electron) {
    fs.mkdirSync(output, { recursive: true });
    fs.rmSync(resultPath, { force: true });
    import('../electron/launch.js').then(async ({ launch }) => {
        const code = await launch([__filename], { timeoutMs: 45000 });
        const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
        console.log(JSON.stringify(result ?? { error: 'Electron did not write results' }, null, 2));
        process.exitCode = code || (result?.ok ? 0 : 1);
    }).catch(error => { console.error(error); process.exitCode = 1; });
} else {
    const { app, BrowserWindow } = require('electron');
    app.disableHardwareAcceleration();
    const http = require('node:http');
    let win, server;
    const evaluate = async source => {
        const response = await win.webContents.executeJavaScript(
            `(async()=>{try{return {value:await (${source})}}catch(error){return {error:error.stack}}})()`);
        if (response.error) throw new Error(response.error);
        return response.value;
    };
    const capture = () => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { win.webContents.off('paint', painted); reject(new Error('Offscreen paint timeout')); }, 5000);
        const painted = (_event, _rect, bitmap) => { clearTimeout(timeout); resolve(bitmap.toPNG()); };
        win.webContents.once('paint', painted);
        win.webContents.invalidate();
    });
    const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/app/styles/tokens.css">
<link rel="stylesheet" href="/app/styles/base.css">
<link rel="stylesheet" href="/app/styles/shell.css">
<style>body{margin:24px;background:#171615}.agent-msg{width:510px}#host{min-height:0}h1{font:15px sans-serif;color:#cfccc7}</style>
<h1>AI 回复 · 缓冲播放检查</h1><div class="agent-msg" data-role="assistant"><div id="host" class="agent-msg-text md"></div></div>
<script type="module">
import {createReplyPlayback} from '/app/agent/reply-playback.js';
let now=0, id=0; const jobs=new Map();
const doc={createElement:tag=>document.createElement(tag),createTextNode:text=>document.createTextNode(text),defaultView:{
performance:{now:()=>now},matchMedia:()=>({matches:false}),
requestAnimationFrame:fn=>{jobs.set(++id,fn);return id},cancelAnimationFrame:id=>jobs.delete(id)}};
window.player=createReplyPlayback({doc});document.querySelector('#host').append(player.element);
window.advance=(count=1)=>{for(let i=0;i<count;i++){now+=16;const batch=[...jobs.values()];jobs.clear();batch.forEach(fn=>fn(now))}};
window.readableText=node=>{if(!node)return null;const copy=node.cloneNode(true);copy.querySelectorAll('[aria-hidden]').forEach(child=>child.remove());return copy.textContent};
window.snapshot=()=>{const base=player.element.querySelector('.agent-stream-base'),sweep=player.element.querySelector('.agent-sweep');
return {text:readableText(base),sweep:readableText(sweep),height:player.element.getBoundingClientRect().height,
paragraphs:base.querySelectorAll('p').length,active:player.active,frames:jobs.size}};
window.ready=true;
</script>`;

    (async () => {
        await app.whenReady();
        server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://local').pathname;
            if (url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
            const file = path.resolve(root, '.' + url);
            if (!url.startsWith('/app/') || !file.startsWith(root + path.sep) || !fs.existsSync(file)) {
                res.writeHead(404); res.end(); return;
            }
            res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
            res.end(fs.readFileSync(file));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        win = new BrowserWindow({ width: 800, height: 750, show: false,
            webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true } });
        const errors = [];
        win.webContents.on('console-message', event => { if (event.message.includes('Uncaught')) errors.push(event.message); });
        await win.loadURL('http://127.0.0.1:' + server.address().port);
        await evaluate('new Promise(resolve=>{const check=()=>window.ready?resolve():setTimeout(check,10);check()})');
        const result = await evaluate(`(async()=>{
const check=(value,message)=>{if(!value)throw new Error(message)};
const source='## 实时 Markdown\\n\\n'+'正文先暂存，再快速逐字显示。\\n\\n'.repeat(8)+'**已经显示的粗体**与 \`行内代码\`\\n\\n- 第一个条目\\n- 第二个条目\\n\\n\`\`\`js\\nconst value = 1; // '+ 'long-code-'.repeat(20)+'\\n\`\`\`\\n\\n| 名称 | 状态 |\\n| --- | --- |\\n| 缓冲播放 | 正常 |\\n\\n未来内容专用标记';
player.update(source,false); const empty=snapshot();
check(empty.height===0 && empty.text==='' && empty.sweep==='', 'Buffered text must not reserve layout or leak into sweep');
advance(2); const partial=snapshot();
check(partial.text.length>0 && !partial.text.includes('未来内容专用标记'),'Only the revealed prefix enters DOM');
check(partial.sweep===partial.text,'Sweep and base contain identical visible text');
window.sweepNode=player.element.querySelector('.agent-sweep');window.sweepAnimation=sweepNode.getAnimations()[0];
check(sweepAnimation?.animationName==='text-sweep','Sweep is running');
player.update(source,true); const ended=snapshot();
check(ended.text===partial.text && ended.height===partial.height,'End event must not reveal or replay text');
window.sample={source,empty,partial,ended}; return sample;
})()`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        fs.writeFileSync(path.join(output, 'partial.png'), await capture());
        const complete = await evaluate(`(()=>{
const check=(value,message)=>{if(!value)throw new Error(message)};
// Remain in a live stream while the buffer empties, so the sweep can be inspected.
player.update(sample.source,false);advance(240);const waiting=snapshot();
check(!waiting.frames && waiting.active,'Empty buffer waits for input while sweep continues');
check(player.element.querySelector('.agent-sweep')===sweepNode,'Stable sweep node');
check(sweepNode.getAnimations()[0]===sweepAnimation,'Markdown updates preserve sweep animation phase');
const base=player.element.querySelector('.agent-stream-base');
check(base.querySelector('h2')&&base.querySelector('strong')&&base.querySelector('li')&&base.querySelector('pre')&&base.querySelector('table'),'Live Markdown structures');
const a=[...base.children],b=[...sweepNode.children];
const differences=a.map((node,i)=>{const p=node.getBoundingClientRect(),q=b[i].getBoundingClientRect();return Math.max(Math.abs(p.x-q.x),Math.abs(p.y-q.y),Math.abs(p.width-q.width),Math.abs(p.height-q.height))});
check(differences.every(delta=>delta<1),'Markdown sweep layout aligns with base: '+differences.join(','));
const pre=base.querySelector('pre');pre.scrollLeft=70;pre.dispatchEvent(new Event('scroll'));
const originalScroll=pre.scrollLeft;
check(sweepNode.querySelector('pre').scrollLeft===pre.scrollLeft,'Code sweep scroll is synchronized');
const first=base.firstChild,ink=sweepNode.querySelector('.agent-reply-ink'),inkNodes=ink.childNodes.length;
player.update(sample.source+'\\n\\n新到的文字',false);advance(30);
check(base.firstChild===first && base.querySelector('pre')===pre,'Existing Markdown nodes remain stable');
check(ink.childNodes.length===inkNodes,'Unchanged sweep text does not accumulate empty DOM nodes');
check(pre.scrollLeft===originalScroll,'Code scroll position survives appended text: '+originalScroll+' -> '+pre.scrollLeft+'; width '+pre.clientWidth+'/'+pre.scrollWidth);
const glyphRect=node=>{const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);const text=walker.nextNode();const range=document.createRange();range.setStart(text,0);range.setEnd(text,1);return range.getBoundingClientRect()};
const baseGlyph=glyphRect(pre),overlayGlyph=glyphRect(sweepNode.querySelector('pre'));
check(Math.abs(baseGlyph.x-overlayGlyph.x)<1&&Math.abs(baseGlyph.y-overlayGlyph.y)<1,'Scrolled code glyphs align');
sweepAnimation.pause();sweepAnimation.currentTime=700;
window.finishCheck=()=>{player.update(sample.source+'\\n\\n新到的文字',true);const final=snapshot();check(final.sweep===null&&!final.active&&!final.frames,'Completion drains without replay');player.dispose();return final};
return {waiting,alignmentMax:Math.max(...differences),partialHeight:sample.partial.height,fullHeight:waiting.height,codeScroll:{left:originalScroll,width:pre.clientWidth,content:pre.scrollWidth}};
})()`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        await evaluate('new Promise(resolve=>setTimeout(()=>resolve(true),220))');
        fs.writeFileSync(path.join(output, 'markdown.png'), await capture());
        const final = await evaluate('finishCheck()');
        if (errors.length) throw new Error(errors.join('\n'));
        fs.writeFileSync(resultPath, JSON.stringify({ ok: true, empty: result.empty, partial: result.partial,
            complete, final: { height: final.height, active: final.active, frames: final.frames }, screenshots: output }, null, 2));
    })().catch(error => {
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: error.stack }, null, 2));
        process.exitCode = 1;
    }).finally(async () => {
        win?.destroy();
        if (server) await new Promise(resolve => server.close(resolve));
        app.exit(process.exitCode ?? 0);
    });
}
