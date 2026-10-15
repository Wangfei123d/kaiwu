/* ============================================================
   把一份 HTML 文档渲染出来并截几张图 —— 交付前自己先看一眼。

   为什么需要它:docs/ 下面那些设计稿是给用户拍板用的,而"我以为它长这样"
   与"它渲染出来是这样"经常不是一件事(块错位、中文字体回退、假面板塌掉)。
   这个工具把整页和指定选择器的局部各截一张,PNG 落在磁盘上,可以自己看。

   用法:
     node_modules\electron\dist\electron.exe tools/render-html-clips.cjs <html> <outDir> [宽] [选择器,选择器,...]
   例:
     node_modules\electron\dist\electron.exe tools/render-html-clips.cjs ..\docs\x.html ..\docs 1440 "#m-jia,#m-yi"

   ⚠️ 别用 `npx electron ...`:本机实测它把脚本当成 **Node 脚本**跑了
   (`require('electron')` 回的是二进制路径字符串、`app` 是 undefined,
   报 `Cannot read properties of undefined (reading 'setPath')`)。直接用 dist 里的 exe 就对了。

   注意:
   · 自己设 userData —— 不能和正在跑的 kaiwu 抢同一个目录;
   · 整页截图要求窗口高到能装下整页(没有滚动),否则裁剪坐标是错的;
   · 指定选择器时会把它们**全部摊开**(去掉 hidden):收起来的块量到 0×0,截出来是空图(实测踩到);
   · 截图前等一小会儿:字体与布局要落地。
   ============================================================ */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [htmlPath, outDir, widthArg, clipsArg] = process.argv.slice(2);
if (htmlPath === undefined || outDir === undefined) {
    console.error('用法: npx electron tools/render-html-clips.cjs <html> <outDir> [宽] [选择器,...]');
    process.exit(2);
}

const WIDTH = Number(widthArg ?? 1440);
const SELECTORS = (clipsArg ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
const STEM = path.basename(htmlPath).replace(/\.html?$/i, '');

app.setPath('userData', path.join(os.tmpdir(), 'kaiwu-doc-render'));
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: WIDTH,
        height: 900,
        show: false,
        backgroundColor: '#0e0e0e',
        webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
    });
    const wc = win.webContents;
    await win.loadFile(path.resolve(htmlPath));
    await sleep(700);

    // 要单独截的那几块可能是**收起来**的(方案切换那种 display:none)。先全部摊开再量:
    // 不摊开的话量到的宽高是 0×0,capturePage 会截出一张空图(实测踩到)。
    if (SELECTORS.length > 0) {
        await wc.executeJavaScript(`(() => {
            for (const sel of ${JSON.stringify(SELECTORS)}) {
                const el = document.querySelector(sel);
                if (el === null) continue;
                el.classList.remove('hidden');
                for (let p = el.parentElement; p !== null; p = p.parentElement) p.classList.remove('hidden');
            }
        })()`);
        await sleep(300);
    }

    // 整页:先把窗口拉到能装下整页(不留滚动条),裁剪坐标才等于页面坐标。
    const full = await wc.executeJavaScript(
        'Math.ceil(document.documentElement.scrollHeight)');
    const height = Math.min(20000, Math.max(600, full));
    win.setContentSize(WIDTH, height);
    await sleep(400);

    const page = await wc.capturePage();
    fs.mkdirSync(outDir, { recursive: true });
    const pageOut = path.join(outDir, `${STEM}.full.png`);
    fs.writeFileSync(pageOut, page.toPNG());
    console.log(`[render] 整页 ${page.getSize().width}x${page.getSize().height} → ${pageOut}`);

    for (const sel of SELECTORS) {
        const rect = await wc.executeJavaScript(`(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.floor(r.left), y: Math.floor(r.top),
                     width: Math.ceil(r.width), height: Math.ceil(r.height) };
        })()`);
        if (rect === null) {
            console.log(`[render] 找不到 ${sel},跳过`);
            continue;
        }
        const img = await wc.capturePage({
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        });
        const out = path.join(outDir, `${STEM}.${sel.replace(/[^A-Za-z0-9_-]/g, '')}.png`);
        fs.writeFileSync(out, img.toPNG());
        console.log(`[render] ${sel} ${rect.width}x${rect.height} → ${out}`);
    }

    app.quit();
}).catch((err) => {
    console.error('[render] 失败', err);
    app.exit(1);
});
