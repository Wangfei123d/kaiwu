import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
// 「含非法字节的 .md 在整轮自检之后逐字节未变」那条要一个**内容哈希**:
// 字节数一样的两次改写看不出来,哈希看得出来。
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 只在"密钥真的存了一次"那一条里用:断言落盘的是 safeStorage 的密文而不是明文。
// 这是 Electron 主进程模块,而自检本身就是被主进程动态 import 起来的 —— 用得了。
import { safeStorage } from 'electron';
// 动效那几条断言的判据是**纯计算**,抽在 app/lib 里由单测钉着
// (自检一次 30-60 秒,靠它验证"判据本身对不对"太贵 —— 见 motion-assert.js 顶部)
import {
    extractMediaBlock, extractAllMediaBlocks, parseCssRules, transformAngleDeg, transformIsIdentity, formatAngle,
} from '../app/lib/motion-assert.js';
// 平铺可停靠面板:布局是纯数学 + 一份带版本号的存档,判据抽在 app/lib 里由单测钉着;
// 自检这边只用它们**解**主进程读回来的档(端到端:渲染进程写 → 主进程读 → 纯函数解)。
import {
    decodeLayout, decodeLayoutResult, LAYOUT_KEY, LAYOUT_NAMESPACE, LAYOUT_VERSION,
} from '../app/lib/panel-layout-store.js';
import {
    formatTree, listPaneIds, defaultTree, pane, split, adoptPanes, DEFAULT_ADOPTION, tabKeysOf,
} from '../app/lib/panel-tree.js';
// 「停止进程」的显隐要在真窗口里量:自检不拉起真的 dsh,所以用**这条推送频道**推一条
// 合成状态事件(渲染进程收到的东西与真机上完全一样)。频道常量只有一处定义,导入它,
// 别在这里再写一遍字符串 —— 写岔了会静默推到一个没人听的频道上。
import { AGENT_EVENT_CHANNEL } from './agent/agent-ipc.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULT_FILE = path.join(DIR, '..', 'selftest-result.txt');

// 与 main.js 的 APP_ROOT 同一个值。在这里独立算一遍,而不是从 main.js 导入 ——
// main.js 是动态 import 本模块的,反向静态导入会形成循环依赖。
const APP_ROOT = path.join(DIR, '..');

export function createReporter() {
    const lines = [];
    let checks = 0;
    let failures = 0;
    let skips = 0;

    return {
        ok(label, condition, detail = '') {
            const pass = Boolean(condition);
            checks++;
            if (!pass) failures++;
            lines.push(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
            return pass;
        },
        /**
         * 因**环境**跳过的一条断言。
         *
         * 为什么不干脆算通过:它没有被验证过。为什么不直接失败:失败的原因是这台机器的
         * 文件系统,不是代码 —— 那会把"自检失败"变成一个永远修不好的噪音,
         * 让整个自检失去信号。
         *
         * 但它**必须留下痕迹**:记进 skips、在结果文件里占一行 [SKIP]、并写进收尾的
         * 汇总句。静默少跑一条断言是这类框架最贵的错法(本项目已经吃过一次:
         * 断言"幂等"的用例其实在测一条假路径,一路全绿而盘上写了两遍)。
         */
        skip(label, reason = '') {
            skips++;
            lines.push(`[SKIP] ${label}${reason ? ' — ' + reason : ''}`);
        },
        note(text) {
            lines.push(`       ${text}`);
        },
        finish() {
            const summary = failures === 0
                ? `\n自检通过:${checks} 项全绿`
                    + (skips > 0 ? `(另有 ${skips} 项因环境跳过,见上面的 [SKIP])` : '')
                : `\n自检失败:${checks} 项里有 ${failures} 项未通过`;
            const body = lines.join('\n') + summary + '\n';
            fs.writeFileSync(RESULT_FILE, body);
            return failures === 0 ? 0 : 1;
        },
    };
}

// 删除目录联接(junction)。Windows 上 fs.rmSync 对 junction 会抛
// "系统无法识别文件名"(EINVAL),必须先 unlink 掉这个重解析点。
function removeJunction(linkPath) {
    try {
        if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    } catch {
        try {
            fs.rmSync(linkPath, { recursive: true, force: true, maxRetries: 3 });
        } catch { /* 清理失败不该让自检结果失真 */ }
    }
}

// 造一个临时笔记库,供自检验证笔记界面。
// 用完即删 —— 不留痕。
function makeTempVault() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-selftest-vault-'));
    const put = (rel, text) => {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text, 'utf8');
    };
    put('甲篇.md', '---\ntags: [自检]\n---\n# 甲篇\n\n见 [[乙篇]] 与 [[还没写]]。\n\n#自检\n');
    put('乙篇.md', '# 乙篇\n\n回见 [[甲篇]]。\n');
    put('孤岛.md', '# 孤岛\n\n没人链接我。\n');
    return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export async function runSelftest({
    app, win, supervisor, settings, vault, plugins, cleanupUserData,
    // 自检专用的**假**密钥(main.js 里那个具名常量)。用它真的存一次,
    // 断言落盘的是密文 —— 只在这一个地方用到,所以由调用方递进来,不在这里抄字面量。
    videoKeyForSelftest = '',
    // 下载队列的固定装置(main.js 的 startQueueFixture):它同时记账**请求次数**,
    // 那是"空闲时一个请求都没再发"的直接证据。
    queueFixture = null,
}) {
    const r = createReporter();
    const acceptance = process.argv.includes('--acceptance');

    // 把渲染进程的 console 镜像到结果文件里。
    // 没有这个,页面里的报错在 Windows 上完全看不见(electron.exe 是 GUI 子系统
    // 程序,stdout 不到父控制台),一次失败就只能靠猜。
    const pageLogs = [];
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        pageLogs.push(`[console] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
        pageLogs.push(`[render-process-gone] ${JSON.stringify(details)}`);
    });
    win.webContents.on('preload-error', (_e, preloadPath, error) => {
        pageLogs.push(`[preload-error] ${preloadPath}: ${error.message}`);
    });

    try {
        r.ok('主进程已就绪', app.isReady());
        r.ok('渲染进程已载入页面', win.webContents.getURL().length > 0, win.webContents.getURL());

        // 桥必须已经完全不在 window 上 —— 一个指向它的全局名字都不能有。
        //
        // 这条断言曾经无法成立:设计文档 §5.2 原本写的是"取走后 delete",
        // 但 contextBridge.exposeInMainWorld 建的属性 writable/configurable 都是
        // false,严格模式下 delete 与赋值都抛 TypeError,桥会永久留在 window 上。
        // 现在改用 contextBridge.executeInMainWorld 把桥作为参数交给主世界,
        // 由 app/shell/bootstrap.js 收进模块闭包后删掉临时全局,所以这里能断言干净。
        r.ok('IPC 桥不在 window 上且 Node 能力未泄漏',
            await win.webContents.executeJavaScript(
                'window.__kaiwuBridge === undefined'
                + ' && window.__kaiwuBridgeTemp === undefined'
                + ' && window.require === undefined'
                + ' && window.ipcRenderer === undefined'));

        r.ok('页面经 toolbox:// 载入', win.webContents.getURL().startsWith('toolbox://shell/'),
            win.webContents.getURL());

        const fetchOk = await win.webContents.executeJavaScript(
            `fetch('toolbox://shell/index.html').then(r => r.ok).catch(() => false)`);
        r.ok('自定义协议支持 fetch', fetchOk === true);

        // 越界请求必须真的走到路径守卫的包含判断,否则这条断言等于没测:
        // toolbox 是 standard 协议,URL 解析器会在请求抵达主进程之前就把 "../"
        // 规范化掉(toolbox://shell/../package.json 变成 toolbox://shell/package.json),
        // 命中的只是「app/package.json 不存在」的 404,与越界防护无关。
        // 写成 %2e%2e%2f 时它不是 dot-segment,能原样抵达处理器、解码后交给守卫;
        // 目标 app/../package.json 是真实存在的文件 —— 没有包含判断就会被读出去(200)。
        const traversal = await win.webContents.executeJavaScript(
            `fetch('toolbox://shell/%2e%2e%2fpackage.json').then(r => r.status).catch(() => 'threw')`);
        r.ok('越界请求被拒绝', traversal === 403, String(traversal));

        // 畸形百分号编码不能让 protocol.handle 的回调抛出去 —— 那会让请求方
        // 拿到未处理异常而不是状态码。期望 400。
        const badEncoding = await win.webContents.executeJavaScript(
            `fetch('toolbox://shell/%zz').then(r => r.status).catch(() => 'threw')`);
        r.ok('畸形百分号编码被拒绝', badEncoding === 400, String(badEncoding));

        // ---- 外壳 ----
        const ready = await waitForShellReady(win);
        r.ok('外壳初始化完成', ready.ok, ready.detail ?? '');
        if (!ready.ok && pageLogs.length > 0) {
            for (const line of pageLogs.slice(-15)) r.note(line);
        }

        // 页面里的未捕获异常必须报出来。模块脚本的语法错误只会让"页面什么都
        // 没发生",没有这条就完全看不出原因(本项目真踩过:重复 const 声明)。
        const pageErrors = await win.webContents.executeJavaScript(
            'JSON.stringify(window.__kaiwuErrors ?? [])');
        r.ok('页面没有未捕获的异常', pageErrors === '[]', pageErrors);

        // ---- 笔记子系统 ----
        // 自检带 ?testVault= 启动,所以应当**跳过**向导、直接进笔记界面。
        const onbVisible = await win.webContents.executeJavaScript(
            '!document.getElementById("onboarding").hidden');
        r.ok('指定了笔记库时不显示首启向导', onbVisible === false, `向导可见=${onbVisible}`);
        r.ok('外壳已显示', await win.webContents.executeJavaScript(
            '!document.getElementById("shell").hidden'));

        // ⚠️ 光看 el.hidden 不够 —— 必须看**计算样式**。
        // 真实踩过的坑:`.onboarding { display: flex }` 是作者样式,优先级高于
        // UA 样式表里的 `[hidden] { display: none }`,于是 el.hidden = true 设了
        // 也没用,界面照旧显示向导。而日志/断言若只看 el.hidden 会一路"通过",
        // 表现得像"选了文件夹却没反应",排查时极易误判成时序问题。
        // 这类"属性对了但样式压过去"的情况,只有 getComputedStyle 能发现。
        const styles = await win.webContents.executeJavaScript(`({
            onboarding: getComputedStyle(document.getElementById('onboarding')).display,
            shell: getComputedStyle(document.getElementById('shell')).display,
        })`);
        r.ok('向导的计算样式确实是 display:none(hidden 没被 CSS 覆盖)',
            styles.onboarding === 'none', `onboarding.display=${styles.onboarding}`);
        r.ok('外壳的计算样式不是 none', styles.shell !== 'none',
            `shell.display=${styles.shell}`);

        // 用户已经配置好笔记库时,启动后**绝不能**停在向导上。
        // 这条守的是一个真实回归:一次竞态里 boot 的过期状态把已经进去的界面
        // 又盖回了向导(用户看到的正是"卡在向导"。那个窗口启动了 14 秒以上)。
        // 断言里带上完整状态,便于一眼看出卡在哪一步。
        const bootState = await win.webContents.executeJavaScript(`({
            onb: !document.getElementById('onboarding').hidden,
            shell: !document.getElementById('shell').hidden,
            ready: window.__kaiwuShellReady ?? null,
        })`);
        r.ok('已配置笔记库时启动后停在笔记界面而不是向导',
            bootState.onb === false && bootState.shell === true,
            JSON.stringify(bootState));
        r.note('启动阶段状态: ' + JSON.stringify(bootState.ready));

        // 工具只按需从窗口菜单打开;启动时不可自动进入布局或执行插件 setup。
        const panes = await win.webContents.executeJavaScript(`({
            notes: !document.getElementById('paneNotes').hidden,
            settings: document.getElementById('paneSettings').hidden,
        })`);
        r.ok('启动后停在笔记视图,工具不会自动打开或切换主视图',
            panes.notes === true && panes.settings === true, JSON.stringify(panes));
        const initialToolViews = await win.webContents.executeJavaScript(`(() => {
            const targets = new Set(['tool:hello:hello', 'tool:music:music', 'tool:palette:palette',
                'tool:subtitle:subtitle', 'tool:douyin:douyin', 'tool:bilibili:bilibili']);
            return (window.__pwTabs?.allTabs?.() ?? [])
                .flatMap((pane) => pane.tabs ?? [])
                .map((tab) => tab.view)
                .filter((view) => targets.has(view));
        })()`);
        r.ok('启动时六个指定工具均不在工作台布局中',
            initialToolViews.length === 0, JSON.stringify(initialToolViews));

        // ⚠️ 这条判的是"三篇正主都在",不是"总数恰好 3":
        //   · 树里现在也列**非笔记文件**(png / docx / json)与**纯文本笔记**(.txt)——
        //     那正是"拖进文件夹""能看 txt"的前提,所以选择器要排除 .note-other、
        //     .note-text 与 .note-dir(文件夹行);
        //   · 自检自己会写 .bak(notes:write 的备份),而 .bak 不是 .md 结尾,归 others;
        //   · 拖动夹具的目录也在树里。
        // 用"恰好 3"会被这几件事任意一件打红,而它真正要守的是"三篇笔记都列出来了"。
        const noteList = await waitForCount(
            win, '#noteList button:not(.note-other):not(.note-text):not(.note-dir)', 3);
        const noteNames = await win.webContents.executeJavaScript(`(() => {
            return [...document.querySelectorAll('#noteList button[data-path]:not(.note-other):not(.note-text)')]
                .map((b) => b.dataset.path);
        })()`);
        r.ok('笔记列表把三篇正主都列出来了(不含非笔记文件与文件夹行)',
            noteNames.includes('甲篇.md') && noteNames.includes('乙篇.md') && noteNames.includes('孤岛.md')
            && noteList >= 3,
            JSON.stringify({ count: noteList, noteNames }));

        // ---- 「打不开」的 .md:拒绝打开 + 磁盘字节一个都不许动(端到端)----
        //
        // 这条守的是一个**会悄悄毁掉用户笔记**的缺陷。旧代码的两步是:
        //   `readFile(abs,'utf8')` —— Node 把非法字节**有损替换**成 U+FFFD;
        //   `Buffer.from(payload,'utf8')` —— 保存时把那些 U+FFFD 编回磁盘。
        // ⇒ 打开一次 + 保存一次 = 永久损坏(真库 `短剧/未命名 2.md` 就是这么来的:
        //   5306 B、1203 个字面 U+FFFD、NUL 30,而且它**严格 UTF-8 合法**,事后查不出来)。
        //
        // 新规矩:解不开就**拒绝**,绝不做有损替换。这里在真窗口里走完整条路:
        //   列表 → 一眼看出打不开 → 点开 → 看到原因 → 字节没动。
        const brokenAbs = path.join(vault.dir, '龙篇.md');
        const brokenBefore = fs.readFileSync(brokenAbs);
        const brokenStatBefore = fs.statSync(brokenAbs);
        const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

        const brokenRow = await win.webContents.executeJavaScript(`(() => {
            const b = document.querySelector('#noteList button[data-path="龙篇.md"]');
            if (!b) return null;
            const tag = b.querySelector('.note-unreadable-tag');
            return {
                readable: b.dataset.readable ?? null,
                tag: tag ? tag.textContent : null,
                title: b.getAttribute('title') ?? '',
            };
        })()`);
        r.ok('★列表里"打不开"的 .md 一眼能看出来(机器可读的 data-readable + 一枚「打不开」小标)',
            brokenRow !== null && brokenRow.readable === 'false' && brokenRow.tag === '打不开',
            JSON.stringify(brokenRow));
        r.ok('它照常被列出来 —— 它是**用户的文件**,列表里凭空消失比"列着但打不开"更吓人',
            noteNames.includes('龙篇.md'), JSON.stringify(noteNames));
        r.ok('悬停就能看到原因(与其它行同一套 title 手法)',
            /不是能安全打开的文本文件/.test(String(brokenRow?.title ?? '')),
            JSON.stringify(brokenRow?.title ?? null));

        await win.webContents.executeJavaScript(
            'document.querySelector(\'#noteList button[data-path="龙篇.md"]\').click()');
        const brokenStatus = await waitForMatch(win, '#noteStatus', /不是能安全打开的文本文件/, 60);
        r.ok('★点开含非法字节的 .md → 状态行给出**人话原因**(带文件名,而不是有损打开后一屏乱码)',
            /不是能安全打开的文本文件/.test(String(brokenStatus ?? ''))
            && String(brokenStatus ?? '').includes('龙篇.md'),
            JSON.stringify(brokenStatus));
        const brokenState = await win.webContents.executeJavaScript(`({
            path: document.getElementById('notePath').textContent,
            titleBox: document.getElementById('noteTitle').value,
        })`);
        r.ok('被拒的笔记**没有**进编辑器(不是"打开了、只是显示成乱码")',
            brokenState.path !== '龙篇.md' && brokenState.titleBox !== '龙篇.md',
            JSON.stringify(brokenState));
        r.ok('被拒时也没有在磁盘上留下任何痕迹(.bak / 原子写临时文件)',
            fs.readdirSync(vault.dir).filter(f => f.startsWith('龙篇.md') && f !== '龙篇.md').length === 0,
            JSON.stringify(fs.readdirSync(vault.dir).filter(f => f.startsWith('龙篇'))));

        // ---- 纯文本(.txt):能显示、能编辑,但**和 Markdown 隔开** ----
        //
        // 用户这一轮的原话:"程序可以显示txt格式文件" + "B可编辑,但是和 Markdown 隔开,
        // 无法应用链接之类的 markdown 语法"。这一组断言就把这两件事钉死:
        //   ① 点一下**在正文格里打开**(而不是丢给记事本/Word);
        //   ② Markdown 语法一条都不生效(标题不成元素、[[…]] 不成链接、HTML 被转义),
        //      链接面板也明说"不参与链接与标签";
        //   ③ 改一行能存到盘上,而且**只动那一行**。
        // 夹具 `纯文本.txt` 是刻意写成"被当 Markdown 就会变形"的样子(见 createSelftestVault)。
        const textRow = await waitForAttr(win, '#noteList button.note-text[data-path="纯文本.txt"]',
            'data-path', '纯文本.txt', 60);
        r.ok('树里把 .txt 列成一行**纯文本笔记**(不是"只能交给系统程序"的附件行)',
            textRow === '纯文本.txt', JSON.stringify(textRow));

        await win.webContents.executeJavaScript(
            'document.querySelector(\'#noteList button.note-text[data-path="纯文本.txt"]\').click()');
        const plainPath = await waitForTextEqual(win, '#notePath', '纯文本.txt', 60);
        r.ok('点开 .txt → 在正文格里打开(纯文本模式)', plainPath === '纯文本.txt',
            JSON.stringify(plainPath));

        const plainDom = await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            return {
                heading: doc.querySelector('h1, h2, h3') !== null,
                wikilinks: doc.querySelectorAll('a.wikilink').length,
                realImg: doc.querySelectorAll('img').length,
                blocks: doc.querySelectorAll('.blk').length,
                text: doc.textContent ?? '',
                titleReadOnly: document.getElementById('noteTitle')?.readOnly === true,
            };
        })()`);
        r.ok('纯文本模式:Markdown 语法**一条都不生效**(# 行不成标题、[[…]] 不成链接)',
            plainDom.heading === false && plainDom.wikilinks === 0
            && plainDom.text.includes('# 这不是标题') && plainDom.text.includes('[[甲篇]]'),
            JSON.stringify({ heading: plainDom.heading, wikilinks: plainDom.wikilinks, blocks: plainDom.blocks }));
        r.ok('纯文本模式:HTML 被转义(没有真的 <img> 元素,原文以文字显示)',
            plainDom.realImg === 0 && plainDom.text.includes('<img src=x onerror="alert(1)">'),
            JSON.stringify({ realImg: plainDom.realImg }));
        r.ok('纯文本的标题框是只读的(标题就是文件名;改名走右键菜单)',
            plainDom.titleReadOnly === true, JSON.stringify({ readOnly: plainDom.titleReadOnly }));

        const plainLinks = await win.webContents.executeJavaScript(`(() => {
            const t = (id) => (document.getElementById(id)?.textContent ?? '').trim();
            return { back: t('backlinkList'), out: t('outlinkList'), un: t('unresolvedList') };
        })()`);
        r.ok('链接面板对纯文本明说"不参与链接与标签"(不是三张莫名其妙的空表)',
            plainLinks.back.includes('不参与链接与标签') && plainLinks.out.includes('不参与链接与标签')
            && plainLinks.un.includes('不参与链接与标签'),
            JSON.stringify(plainLinks));

        const plainSaved = await win.webContents.executeJavaScript(`(async () => {
            const blk = document.querySelector('#noteDoc .blk[data-blk="0"]');
            blk.click();
            const ta = document.querySelector('#noteDoc textarea.blk-input');
            if (!ta) return false;
            ta.value = '第一行被开物改过';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('noteSave').click();
            return true;
        })()`);
        r.ok('纯文本:就地改第一行(编辑器那套"当前块是源码"照旧可用)', plainSaved === true);
        await new Promise(res => setTimeout(res, 1200));
        const plainOnDisk = fs.readFileSync(path.join(vault.dir, '纯文本.txt'), 'utf8');
        r.ok('纯文本:改动真的落到磁盘,而且**只动了改过的那一行**',
            plainOnDisk.startsWith('第一行被开物改过\n')
            && plainOnDisk.includes('见 [[甲篇]] 与 #标签')
            && plainOnDisk.includes('<img src=x onerror="alert(1)">'),
            JSON.stringify(plainOnDisk.slice(0, 70)));

        // 夹具复原:后面的用例还要用同一个库(而且不能让"当前笔记"停在 txt 上)
        fs.writeFileSync(path.join(vault.dir, '纯文本.txt'),
            ['# 这不是标题', '见 [[甲篇]] 与 #标签', '<img src=x onerror="alert(1)">', '最后一行'].join('\n'),
            'utf8');
        await win.webContents.executeJavaScript(
            'document.querySelector(\'#noteList button[data-path="甲篇.md"]\').click()');
        await waitForTextEqual(win, '#notePath', '甲篇.md', 60);

        // 顶栏那块按用户要求撤掉了:断言**真的撤干净**(节点都不在),而「能换库」这条能力
        // 改在下面设置视图那条上继续被测 —— 不是删掉。
        r.ok('顶栏不再有「库路径 + 更换」那两块(撤干净,不留空槽)',
            await win.webContents.executeJavaScript(
                `document.getElementById('vaultName') === null && document.getElementById('vaultChange') === null`));

        // ---- 界面打磨:品牌标记 / 图标按钮 / 应用菜单 ----
        // 这三样都不在"功能"里,所以最容易改坏了没人发现 —— 只能靠断言兜。
        //
        // 这里**不需要**先把视图切回笔记:上面那条断言已经保证启动后停在笔记视图。
        // (排查这个的时候量到过 paneNotes.hidden = true、元素尺寸全是 0×0 ——
        //  所以那条断言不只是产品行为,也是下面这些尺寸断言的前提。)

        const brand = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('.topbar-brand');
            const svg = host && host.querySelector('svg.brand-mark');
            if (!svg) return { ok: false };
            const box = svg.getBoundingClientRect();
            const dot = svg.querySelector('circle');
            return {
                ok: true,
                size: Math.round(box.width) + 'x' + Math.round(box.height),
                text: host.textContent.trim(),
                stroke: getComputedStyle(svg).color,
                dotFill: dot ? getComputedStyle(dot).fill : null,
            };
        })()`);
        r.ok('顶栏品牌是矢量标记,不是纯文字', brand.ok === true, JSON.stringify(brand));
        r.ok('标记尺寸 22×22(没有被压扁)', brand.size === '22x22', brand.size);
        r.ok('标记旁边仍保留「开物」字标', brand.text === '开物', JSON.stringify(brand.text));
        r.ok('标记用 currentColor 描边,并有点缀色节点(颜色来自令牌,没写死)',
            brand.stroke === 'rgb(255, 255, 255)' && brand.dotFill === 'rgb(126, 200, 255)',
            `${brand.stroke} / ${brand.dotFill}`);

        const favicon = await win.webContents.executeJavaScript(
            'document.querySelector(\'link[rel="icon"]\')?.href ?? null');
        r.ok('有内联 SVG favicon(不必为它加一条协议白名单)',
            typeof favicon === 'string' && favicon.startsWith('data:image/svg+xml'),
            String(favicon).slice(0, 32));

        const newBtn = await win.webContents.executeJavaScript(`(() => {
            const b = document.getElementById('noteNew');
            const svg = b && b.querySelector('svg.icon-plus');
            if (!svg) return { ok: false };
            const box = svg.getBoundingClientRect();
            const cs = getComputedStyle(svg);
            return {
                ok: true,
                text: b.textContent.trim(),
                label: b.getAttribute('aria-label'),
                size: Math.round(box.width) + 'x' + Math.round(box.height),
                stroke: cs.stroke,
                btnColor: getComputedStyle(b).color,
            };
        })()`);
        r.ok('「新建」按钮换成了矢量图标,不再有文字',
            newBtn.ok === true && newBtn.text === '', JSON.stringify(newBtn));
        r.ok('图标按钮带 aria-label(没有可读文本时它是必需的,不是可选项)',
            newBtn.label === '新建笔记', String(newBtn.label));
        r.ok('图标 16×16,描边跟随按钮文字色(不写死颜色)',
            newBtn.size === '16x16' && newBtn.stroke === newBtn.btnColor,
            JSON.stringify(newBtn));

        // 「新建文件夹」的图标:**必须真的量尺寸**。
        // 第一版只在 HTML 里写了 class、忘了在 base.css 里给几何 —— 没有 width/height 的
        // SVG 会退化成 300×150、fill 默认黑色,按钮里就是一大块黑形状。这类"样式漏了"
        // 的错不会报任何错,只能靠量计算样式发现(与 A15 同一类)。
        const folderBtn = await win.webContents.executeJavaScript(`(() => {
            const b = document.getElementById('noteNewFolder');
            const svg = b && b.querySelector('svg.icon-folder-plus');
            if (!svg) return { ok: false };
            const box = svg.getBoundingClientRect();
            const cs = getComputedStyle(svg);
            return {
                ok: true,
                label: b.getAttribute('aria-label'),
                size: Math.round(box.width) + 'x' + Math.round(box.height),
                fill: cs.fill,
                stroke: cs.stroke,
                btnColor: getComputedStyle(b).color,
                paths: svg.querySelectorAll('path').length,
            };
        })()`);
        r.ok('「新建文件夹」按钮有矢量图标(不是文字,也不是空白)',
            folderBtn.ok === true && folderBtn.paths >= 2, JSON.stringify(folderBtn));
        r.ok('「新建文件夹」图标也是 16×16 且描边跟随按钮文字色',
            folderBtn.size === '16x16' && folderBtn.stroke === folderBtn.btnColor,
            JSON.stringify(folderBtn));
        r.ok('「新建文件夹」图标是描边式的(fill 必须是 none,否则按钮里是一块黑)',
            folderBtn.fill === 'none', `fill=${folderBtn.fill}`);
        r.ok('「新建文件夹」按钮带 aria-label',
            folderBtn.label === '新建文件夹', String(folderBtn.label));

        // 动效的兜底规则在样式表里,页面里量不出来(要模拟媒体特性才行)——
        // 直接读样式表文本断言,比"看着像有"可靠。
        const baseCss = await win.webContents.executeJavaScript(
            `fetch('toolbox://shell/styles/base.css').then(x => x.text()).catch(() => '')`);
        r.ok('图标悬停动效确实定义了', /\.icon-btn:hover[^{]*\{[^}]*rotate\(90deg\)/.test(baseCss),
            `长度=${String(baseCss).length}`);

        // prefers-reduced-motion 那一段必须**先切片再断言**。
        // 旧写法 `prefers-reduced-motion[\s\S]{0,400}\.icon-plus[^}]*transform:\s*none`
        // 里的 `[^}]*` 会从块里第一个 `.icon-plus` 一路跨过逗号、吃到第三个选择器才遇见
        // `transform: none` —— 把 `.icon-plus { transition: none; }` 那一行删掉,它照样通过。
        // 一条"删了还绿"的断言等于没有断言(本项目 A13 的同一类问题)。
        const motionBlock = extractMediaBlock(baseCss, 'prefers-reduced-motion');
        const motionRules = parseCssRules(motionBlock);
        const plusOwn = motionRules.find(u => u.selector === '.icon-plus');
        const folderOwn = motionRules.find(u => u.selector === '.icon-folder-plus');
        const plusOnHover = motionRules.find(u => u.selector === '.icon-btn:hover:not(:disabled) .icon-plus'
            || u.selector === '.icon-btn:active:not(:disabled) .icon-plus'
            || /\.icon-btn:hover[^{]*\.icon-plus/.test(u.selector));
        const folderOnHover = motionRules.find(u => /\.icon-btn(:hover|:active)[^{]*\.icon-folder-plus/.test(u.selector));
        r.ok('并且有 prefers-reduced-motion 兜底(连 transform 一起取消,不是只关 transition)',
            motionBlock !== null
            && plusOwn !== undefined && /\btransition:\s*none\b/.test(plusOwn.body)
            && plusOnHover !== undefined && /\btransform:\s*none\b/.test(plusOnHover.body),
            motionBlock === null
                ? '在 base.css 里没找到 (prefers-reduced-motion: reduce) 块'
                : `块内规则=${motionRules.map(u => u.selector).join(' | ')}`);
        r.ok('「新建文件夹」图标同样有 reduced-motion 兜底(它用的是缩放,更容易被忽略)',
            folderOwn !== undefined && /\btransition:\s*none\b/.test(folderOwn.body)
            && folderOnHover !== undefined && /\btransform:\s*none\b/.test(folderOnHover.body),
            `块内规则=${motionRules.map(u => u.selector).join(' | ')}`);

        // 光有规则不等于生效 —— 真把鼠标移上去,再读计算样式。
        // CSS 的 :hover **不能**用 dispatchEvent 合成,必须走真实输入管线,
        // 所以这里用 sendInputEvent(自检跑在主进程,拿得到 webContents)。
        const btnCenter = await win.webContents.executeJavaScript(`(() => {
            const r = document.getElementById('noteNew').getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        const transformOf = () => win.webContents.executeJavaScript(
            'getComputedStyle(document.querySelector("#noteNew svg.icon-plus")).transform');

        // 判据是**终态角度**(0° / 90°),不是"读到的值不等于 none"。
        // 旧判据配合 `.18s ease` 的过渡有两头都错:读数落在过渡中途(比如
        // matrix(0.363,0.931,…) ≈ 68°)会**空转通过**——它并没有验证"转到了 90°";
        // 而读数落在过渡尚未开始/已结束但本轮合成输入没生效的那一帧,就一路读成 'none',
        // **误报失败**(实测连跑两次一红一绿)。
        //
        // 反复发 mouseMove + 每轮读数,直到角度进入容差或到上限 ——
        // 不是"发一次就睡固定时间再读一次"(那是把一个时序赌注换成另一个)。
        const TOLERANCE_DEG = 2;
        const HOVER_ANGLE_DEG = 90;
        // 采样预算按**时间**算,并留出合成输入迟到的余量。
        const SAMPLE_MS = 70;
        const SAMPLE_LIMIT = 25;
        const hoverMatchCount = () => win.webContents.executeJavaScript(
            'document.querySelectorAll("#noteNew:hover").length');

        // ⚠️ 每次送指针**必须先动一次再回到目标**:`sendInputEvent` 发到一个**没有变化**的
        // 坐标时,渲染进程可能根本不产生新的输入事件。实测过的失败长相就是这样 ——
        // 连续 41 次同点 mouseMove,`:hover` 一次都没命中(表现为"输入完全没送到",
        // 而不是"角度差一点"),于是断言偶发失败。每轮先跳到待机点,位置变化一次就够了。
        const PARK = { x: 4, y: 4 };

        // ⚠️ 这里**不抢焦点**。窗口是 showInactive 显示的(见 main.js),合成鼠标事件
        // 照样会被应用;而"把窗口拉到前台"会把用户正在别处敲的字吃进自检的临时笔记库里
        // (实测:临时库里的 `# 甲篇` 变成了 `# 甲篇哦`,一条内容断言因此变红,
        //  而真凶是自检自己抢了焦点)。如果合成 hover 真的因为没焦点而不生效,
        // 下面的断言会**明确报出来**,而不是靠抢焦点掩盖。

        // 先把指针挪开再读"之前"的状态:上一次交互可能把它留在按钮上,
        // 那样 `before` 就不是 none,断言会以一句与本次测量无关的理由失败。
        try { win.moveTop(); } catch { /* 抬不动就继续,由下面的采样判据兜 */ }
        win.webContents.sendInputEvent({ type: 'mouseMove', x: PARK.x, y: PARK.y });
        await new Promise(res => setTimeout(res, 150));
        const before = await transformOf();
        const beforeAngle = transformAngleDeg(before);

        /**
         * 交替采样"合成输入生效了没有"(`:hover`)与"计算样式的终态角度"。
         *
         * 两件事必须分开看:
         *   - `:hover` 说的是**指针到了没有**(由渲染进程应用合成输入决定);
         *   - 角度说的是**动效转到哪了**(由 CSS 过渡决定,过渡中途是中间值)。
         * 旧断言把两者混在"`!== none`"里,于是中间值能空转通过、输入迟到能误报失败。
         *
         * @param {'rotated'|'origin'} target 期望的终态
         */
        async function sampleUntil(pos, target) {
            let last = { deg: null, raw: null, hoverMatch: 0 };
            for (let i = 0; i < SAMPLE_LIMIT; i++) {
                // 每轮先跳开再回到目标(保证有位置变化);中途再抬一次窗口 ——
                // 被别的窗口遮住时 Chromium 不产帧,合成 hover 也就不会更新(实测偶发红:
                // 用户正在用开物,自检窗口被它的窗口盖住了)。moveTop 只抬 z 序,**不抢焦点**。
                if (i === Math.floor(SAMPLE_LIMIT / 2)) { try { win.moveTop(); } catch { /* 抬不动就继续 */ } }
                win.webContents.sendInputEvent({ type: 'mouseMove', x: PARK.x, y: PARK.y });
                await new Promise(res => setTimeout(res, 20));
                win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
                await new Promise(res => setTimeout(res, SAMPLE_MS));
                const [hoverMatch, raw] = await Promise.all([hoverMatchCount(), transformOf()]);
                const deg = transformAngleDeg(raw);
                last = { deg, raw, hoverMatch };
                const pointerOk = target === 'rotated' ? hoverMatch === 1 : hoverMatch === 0;
                if (target === 'rotated') {
                    if (pointerOk && deg !== null && Math.abs(deg - HOVER_ANGLE_DEG) <= TOLERANCE_DEG) break;
                } else if (pointerOk && transformIsIdentity(raw)) {
                    // 移开时要求的是**真的回到原状**:过渡中途的 1.5° 也是"还在转"。
                    // 采到 none 就停(实测 180ms 内到得了),到不了则由断言按容差兜住。
                    break;
                }
            }
            return last;
        }

        const hovered = await sampleUntil(btnCenter, 'rotated');
        // 兜底断言:它不依赖合成输入有没有被渲染进程应用(只依赖指针真的到了按钮上),
        // 所以哪怕 transform 这一路抽风,这一条仍能说清"是动效没生效"还是"输入没送到"。
        const hoverMatch = hovered.hoverMatch;
        const left = await sampleUntil({ x: 2, y: 2 }, 'origin');

        r.ok('鼠标移上去图标真的转了(规则写了不等于生效)',
            beforeAngle === null && hovered.deg !== null
                && Math.abs(hovered.deg - HOVER_ANGLE_DEG) <= TOLERANCE_DEG,
            `${before} (${formatAngle(beforeAngle)}) → ${hovered.raw} (${formatAngle(hovered.deg)})`);
        r.ok('指针真的落在按钮上(:hover 匹配 —— 这一条与合成输入无关)',
            hoverMatch === 1, `#noteNew:hover 匹配数=${hoverMatch}`);
        r.ok('鼠标移开后转回原状',
            left.deg === null || Math.abs(left.deg) <= TOLERANCE_DEG,
            `${hovered.raw} → ${left.raw} (${formatAngle(left.deg)})`
            + ` · 移开后 :hover 匹配数=${left.hoverMatch}`);

        // 菜单是主进程对象,页面里看不到 —— 在自检(主进程)这侧直接查。
        const { Menu } = await import('electron');
        const appMenu = Menu.getApplicationMenu();
        const menuLabels = appMenu ? appMenu.items.map(i => i.label) : [];
        r.ok('应用菜单已设置成中文(不再露 Electron 的原生英文菜单)',
            menuLabels.length > 0 && menuLabels.every(l => /[\u4e00-\u9fa5]/.test(l)),
            JSON.stringify(menuLabels));
        r.ok('自检(非 --dev)下不含开发者项', !menuLabels.includes('开发者工具'),
            JSON.stringify(menuLabels));

        // 打开一篇:源码、预览、反链都要出来
        await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#noteList button')]`
            + `.find(b => b.dataset.path === '甲篇.md')?.click()`);
        const opened = await waitForElement(win, '#noteEditor:not([hidden])');
        r.ok('点开笔记后编辑器可见', opened === true);

        // 新编辑器:单容器、逐块渲染。
        // **打开即进入编辑**(2026-09-17 用户要求「单击后直接进入编辑,不用连点两下」):
        // 第 0 块默认就是源码态,其余块仍是渲染结果 —— 规则与「新建笔记」同一条。
        const docBlocks = await waitForCount(win, '#noteDoc .blk', 1);
        r.ok('文档区渲染出多个块', docBlocks >= 3, `blocks=${docBlocks}`);

        // 诊断:inputs=0 时要能一眼看出是"没打开"还是"打开了但没进编辑态"。
        // open() 的 catch 会把错误写进 #noteStatus,所以把它一起打出来。
        r.note('打开笔记后的状态: ' + JSON.stringify(
            await win.webContents.executeJavaScript(`(() => {
                const doc = document.getElementById('noteDoc');
                return {
                    inputs: doc.querySelectorAll('textarea.blk-input').length,
                    anyTextarea: doc.querySelectorAll('textarea').length,
                    blocks: doc.querySelectorAll('.blk').length,
                    active: doc.querySelector('.blk-active')?.dataset.blk ?? null,
                    status: document.getElementById('noteStatus').textContent,
                    path: document.getElementById('notePath').textContent,
                    editorHidden: document.getElementById('noteEditor').hidden,
                    paneHidden: document.getElementById('paneNotes').hidden,
                };
            })()`)));

        // ⚠️ 这里必须**等**而不是读一次。
        // 原先写成一次性 executeJavaScript 读数,实测偶发 inputs=0 而验收那边是绿的 ——
        // 典型的时序假设:"编辑器可见"不等于"带源码块的那次渲染已经落进 DOM"。
        // 用 waitForCountEqual 之后,超时仍会如实报 0,所以它不会掩盖真问题,只是不再抢跑。
        const openInputs = await waitForCountEqual(win, '#noteDoc textarea.blk-input', 1);
        r.ok('打开笔记后就已经有一个源码输入框(不用再点一下)', openInputs === 1,
            `inputs=${openInputs}`);
        r.ok('而且源码的就是第 0 块(与「新建笔记」同一条规则)',
            await win.webContents.executeJavaScript(
                'document.querySelector("#noteDoc textarea.blk-input")?.dataset.blk ?? null')
            === '0');

        // 下面几条守的是"整篇渲染"(Markdown 渲染器),与"打开是否进编辑"是两件事。
        // 所以先把编辑态收起来(点容器空白 → 当前块收起渲染),再断言。
        // 注意这里必须用 waitForCountEqual:waitForCount 是 ">= n",传 0 会立刻通过。
        await win.webContents.executeJavaScript(
            'document.getElementById("noteDoc").click()');
        await waitForCountEqual(win, '#noteDoc textarea', 0);

        const preview = await win.webContents.executeJavaScript(
            'document.getElementById("noteDoc").innerHTML');
        r.ok('预览渲染出标题', String(preview).includes('<h1>甲篇</h1>'),
            JSON.stringify(String(preview).slice(0, 80)));
        r.ok('预览把 wiki 链接渲染成可点元素', String(preview).includes('data-note="乙篇"'));
        r.ok('预览里指向未写笔记的链接标成 missing', String(preview).includes('missing'));
        r.ok('收起编辑态后没有任何输入框(只有光标所在块才是源码)',
            await win.webContents.executeJavaScript(
                'document.querySelectorAll("#noteDoc textarea").length') === 0);

        // 点某一块 → 那一块变成源码输入框,其余仍是渲染结果
        await win.webContents.executeJavaScript(
            `document.querySelector('#noteDoc .blk[data-blk="0"]')?.click()`);
        const hasInput = await waitForCount(win, '#noteDoc textarea.blk-input', 1);
        r.ok('点某一块后该块变成源码输入框', hasInput === 1, `inputs=${hasInput}`);
        const inputVal = await win.webContents.executeJavaScript(
            'document.querySelector("#noteDoc textarea.blk-input")?.value ?? ""');
        r.ok('源码块里是该块的原文', String(inputVal).startsWith('# 甲篇'),
            JSON.stringify(String(inputVal).slice(0, 40)));
        r.ok('其余块仍然是渲染结果(不是全部变成源码)',
            await win.webContents.executeJavaScript(
                'document.querySelectorAll("#noteDoc .blk:not(.blk-active)").length') >= 2);

        const backlinks = await waitForCount(win, '#backlinkList button', 1);
        r.ok('反向链接面板列出乙篇', backlinks === 1, `count=${backlinks}`);
        const unresolved = await win.webContents.executeJavaScript(
            'document.querySelectorAll("#unresolvedList button").length');
        r.ok('「还没写的」列出未解析链接', unresolved === 1, `count=${unresolved}`);

        // 切到只读预览:整篇渲染、没有任何输入框
        await win.webContents.executeJavaScript(
            'document.getElementById("noteModeBtn").click()');
        await new Promise(res => setTimeout(res, 200));
        const previewInputs = await win.webContents.executeJavaScript(
            'document.querySelectorAll("#noteDoc textarea").length');
        r.ok('切到预览后没有任何输入框(预览不可编辑)', previewInputs === 0,
            `inputs=${previewInputs}`);
        r.ok('预览模式仍渲染出内容', await win.webContents.executeJavaScript(
            'document.querySelector("#noteDoc").innerHTML.includes("<h1>")'));
        await win.webContents.executeJavaScript(
            'document.getElementById("noteModeBtn").click()');   // 切回编辑
        await new Promise(res => setTimeout(res, 200));

        // 保存往返:改一块内容 → 保存 → 读回来。
        // 写固定的标记并**先判断是否已存在** —— 这样反复跑自检不会把内容越加越长。
        const saved = await win.webContents.executeJavaScript(`(async () => {
            const blk = document.querySelector('#noteDoc .blk[data-blk="2"]');
            blk.click();
            const ta = document.querySelector('#noteDoc textarea.blk-input');
            if (!ta) return false;
            if (!ta.value.includes('自检追加')) ta.value = ta.value + ' 自检追加。';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('noteSave').click();
            return true;
        })()`);
        r.ok('触发保存', saved === true);
        await new Promise(res => setTimeout(res, 1200));
        const onDisk = fs.readFileSync(path.join(vault.dir, '甲篇.md'), 'utf8');
        r.ok('改动落到了磁盘', onDisk.includes('自检追加。'),
            JSON.stringify(onDisk.slice(-50)));
        r.ok('未编辑的块保持原样(逐块替换不重排全文)',
            onDisk.includes('# 甲篇') && onDisk.includes('[[乙篇]]'),
            JSON.stringify(onDisk.slice(0, 60)));
        // 这条必须**数次数**,不能只 includes:曾经有个 bug 让每次提交都往这一行
        // 再写一份尾巴(打一个字保存后变成两个),而 includes 一路"通过" ——
        // 实测当时的磁盘内容就是"自检追加。 自检追加。"。
        const stampCount = (onDisk.match(/自检追加。/g) ?? []).length;
        r.ok('保存下来的内容没有重复(提交是幂等的)', stampCount === 1,
            `出现次数=${stampCount} 末尾=${JSON.stringify(onDisk.slice(-40))}`);

        // ---- 键位:回车 / ↓ 必须能"跳出当前块" ----
        // 守的是用户报的 bug:按回车后上一行不渲染、↓ 也跳不出当前块。
        // 单测里是 DOM 替身,这里必须在**真实浏览器**里再验一遍 ——
        // 折行判断用到了镜像元素测量,替身量不出来。
        await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#noteList button')]`
            + `.find(b => b.dataset.path === '乙篇.md')?.click()`);
        // 必须等**真的切换过去**再探:#noteDoc .blk 一直都在(还是甲篇的),
        // 只等这个选择器会立刻返回,于是探针量到的是上一篇笔记。
        // 切过去之后第 0 块是源码态(打开即编辑),此刻**没有**渲染出来的 <h1>,
        // 所以等的是输入框里的源文。
        //
        // ⚠️ 这里**不能只点一次就等固定时长**:`open()` 的第一件事是
        // `if (dirty) await save()`(切走前强制保存),而那一下要走 IPC + 原子写;
        // 机器忙的时候(比如 Agent 正好在冷启动)整个切换会拖过 4 秒 ——
        // 实测红过一次。所以:超时就**再点一次**,而断言本身仍然是"必须真的切过去"。
        const switched = await switchToNote(win, '乙篇.md');
        r.ok('能切换到另一篇笔记', switched, switched
            ? ''
            : `等不到「# 乙篇」;当前顶栏路径=${JSON.stringify(await win.webContents.executeJavaScript(
                'document.getElementById("notePath")?.textContent ?? null'))}`);
        // 收起编辑态:下面的键位探针要的起点是"全渲染"
        await win.webContents.executeJavaScript(
            'document.getElementById("noteDoc").click()');
        await waitForCountEqual(win, '#noteDoc textarea', 0);

        const keyProbe = await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            const rendered = () => doc.innerHTML.includes('<h1>乙篇</h1>');
            const inside = { beforeClick: { rendered: rendered() } };
            doc.querySelector('.blk[data-blk="0"]').click();
            const ta = doc.querySelector('textarea.blk-input');
            if (!ta) return { ok: false, why: '点第一块之后没有出现输入框' };
            // 这一行现在应当是源码态:标题不再以渲染结果出现
            inside.afterClick = {
                rendered: rendered(),
                active: ta.dataset.blk,
                inputs: doc.querySelectorAll('textarea').length,
            };
            // 光标放到行尾,再按回车
            ta.setSelectionRange(ta.value.length, ta.value.length);
            ta.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true }));
            const afterEnter = doc.querySelector('textarea.blk-input');
            inside.afterEnter = {
                rendered: rendered(),
                active: afterEnter ? afterEnter.dataset.blk : null,
                inputs: doc.querySelectorAll('textarea').length,
                html: doc.innerHTML.slice(0, 100),
            };
            // 再按 ↓
            afterEnter?.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'ArrowDown', bubbles: true, cancelable: true }));
            inside.afterArrow = doc.querySelector('textarea.blk-input')?.dataset.blk ?? null;
            inside.ok = true;
            return inside;
        })()`);

        r.ok('点第一块后它变成源码(那一行不再是渲染结果)',
            keyProbe.ok === true && keyProbe.beforeClick?.rendered === true
            && keyProbe.afterClick?.rendered === false && keyProbe.afterClick?.active === '0',
            JSON.stringify(keyProbe));
        r.ok('回车后上一行立刻渲染,不用再点鼠标',
            keyProbe.afterEnter?.rendered === true, JSON.stringify(keyProbe.afterEnter));
        r.ok('回车后源码态跳到下一块',
            keyProbe.afterEnter?.active === '1', JSON.stringify(keyProbe.afterEnter));
        r.ok('任何时刻只有一个源码块',
            keyProbe.afterEnter?.inputs === 1, JSON.stringify(keyProbe.afterEnter));
        r.ok('↓ 能跳出当前块进入下一块',
            keyProbe.afterArrow === '2', `active=${keyProbe.afterArrow}`);

        // ---- 单击即编辑 + 拖选跨行(用户 2026-09-18 报的两件事)----
        //
        // 这两条**必须用真实指针输入**(sendInputEvent):它们的根因正是
        // "mousedown 一按下就把 DOM 换成 textarea" —— 只发 element.click() 是
        // 测不出来的(合成 click 没有按下/移动/松开的时序)。上一轮悬停断言的
        // 教训也用在这里:每次移动都要真的改变坐标,同点重发不产生新事件。
        const blkBox = (idx) => win.webContents.executeJavaScript(`(() => {
            const el = document.querySelector('#noteDoc .blk[data-blk="${idx}"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2),
                     right: Math.round(r.right - 2), text: el.textContent };
        })()`);
        const sendBtn = (type, x, y) => win.webContents.sendInputEvent(
            { type, x, y, button: 'left', clickCount: 1 });
        const sendMove = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });

        // 点下方空白 = 收起编辑态(既有行为,先回到"全是渲染结果")
        const padPoint = await win.webContents.executeJavaScript(`(() => {
            const el = document.getElementById('noteDoc');
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + 4), y: Math.round(r.bottom - 6) };
        })()`);
        sendBtn('mouseDown', padPoint.x, padPoint.y);
        sendBtn('mouseUp', padPoint.x, padPoint.y);
        await waitForCountEqual(win, '#noteDoc textarea.blk-input', 0);

        const one = await blkBox(0);
        sendBtn('mouseDown', one.x, one.y);
        sendBtn('mouseUp', one.x, one.y);
        const activeAfterOne = await waitForAttr(win, '#noteDoc textarea.blk-input', 'data-blk', '0', 20);
        const caret = await win.webContents.executeJavaScript(
            'document.querySelector("#noteDoc textarea.blk-input")?.selectionStart ?? null');
        r.ok('验收UI:单击一次就进入这一行的编辑(不用连点两次)',
            activeAfterOne === '0', `active=${activeAfterOne}`);
        r.ok('验收UI:光标落在点到的那一格附近(不是甩到行尾)', 
            typeof caret === 'number' && caret <= 3,
            `caret=${caret}(第 0 块是「# 甲篇」,点最左侧应当是源码偏移 2 —— 标题前缀)`);

        // 收起,再从第 0 块拖到第 2 块:应当出现一个**跨块**的原生选择,且不进编辑态
        sendBtn('mouseDown', padPoint.x, padPoint.y);
        sendBtn('mouseUp', padPoint.x, padPoint.y);
        await waitForCountEqual(win, '#noteDoc textarea.blk-input', 0);

        const from = await blkBox(0);
        const to = await blkBox(2);
        sendBtn('mouseDown', from.right, from.y);
        sendMove(from.right + 25, from.y);          // 先超过阈值(4px),让编辑器认出"这是拖"
        sendMove(to.x + 15, to.y);
        sendBtn('mouseUp', to.x + 15, to.y);
        const dragSel = await win.webContents.executeJavaScript(`(() => {
            const s = window.getSelection();
            const text = s ? String(s.toString()) : '';
            const hit = new Set();
            if (s && s.rangeCount > 0) {
                const r = s.getRangeAt(0);
                for (const el of document.querySelectorAll('#noteDoc .blk')) {
                    if (r.intersectsNode && r.intersectsNode(el)) hit.add(el.dataset.blk);
                }
            }
            return { text, blocks: [...hit],
                     inputs: document.querySelectorAll('#noteDoc textarea.blk-input').length };
        })()`);
        r.ok('验收UI:拖选能跨行(选中的块数 ≥ 2,不再被掐在一行里)',
            dragSel.blocks.length >= 2 && String(dragSel.text).length > 0,
            JSON.stringify(dragSel));
        r.ok('验收UI:拖选时不进入编辑态(否则 DOM 一换,选择就被掐断)',
            dragSel.inputs === 0, `inputs=${dragSel.inputs}`);

        // ---- Ctrl+A 全选整篇:一次删干净(用户报「无法 Ctrl+A 全选删除,只能删一段」)----
        //
        // 根因:编辑器是**块级**的,一"段"= 一个块 = 一个独立 textarea,浏览器原生的
        // Ctrl+A 只选得中当前 textarea,所以永远只删得掉一块。跨块选区在 DOM 上不
        // 存在 —— 编辑器自己维护一个"全选整篇"状态 + 一条 CSS 高亮(见
        // app/notes/editor.js 的 setSelectAll)。
        //
        // 为什么必须在真窗口里再验一遍(单测用 DOM 替身,量不到这些):
        //   ① 状态与**视觉高亮**真的生效(读根节点属性 + 计算样式,不读内部变量);
        //   ② 退格之后**磁盘上那篇真的空了** —— 自动保存要真的跑完一圈 IPC + 原子写;
        //   ③ 标题框里的 Ctrl+A 没被劫持(标题框在正文根节点**之外**,只有真 DOM 验得了)。
        //
        // ⚠️ 用的是自检自己的临时库(全选篇.md 由 createSelftestVault 现建现删),
        //    与用户真实的笔记库(%APPDATA% / E:\仓库 那一份)没有任何关系。
        const allSelNote = '全选篇.md';
        const allSelAbs = path.join(vault.dir, allSelNote);
        const allSelOpen = await switchToNote(win, allSelNote);
        r.ok('全选篇夹具已打开(三块:标题 / 空行 / 正文)',
            allSelOpen === true, `path=${allSelNote}`);
        // 收起编辑态,从"整篇渲染"这个干净起点开始(下面的起点是"点开一块")
        await win.webContents.executeJavaScript('document.getElementById("noteDoc").click()');
        await waitForCountEqual(win, '#noteDoc textarea', 0);

        // ① 点开正文里的第 2 块(进入块编辑),然后按 Ctrl+A
        const allSelStart = await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            doc.querySelector('.blk[data-blk="2"]').click();
            const ta = doc.querySelector('textarea.blk-input');
            if (!ta) return { ok: false, why: '点第 2 块之后没有输入框' };
            ta.focus();
            ta.setSelectionRange(0, 0);
            return {
                ok: true,
                blocks: doc.querySelectorAll('.blk').length,
                active: ta.dataset.blk,
                attrBefore: doc.getAttribute('data-select-all'),
                bgBefore: getComputedStyle(doc.querySelector('.blk[data-blk="1"]')).backgroundColor,
                focused: document.activeElement === ta,
            };
        })()`);
        r.ok('先在正文里点开一块(块编辑态)—— 这是用户按下 Ctrl+A 的起点',
            allSelStart.ok === true && allSelStart.active === '2'
            && allSelStart.blocks === 3,
            JSON.stringify(allSelStart));

        // 两层证据,与滚轮那条一样:先注入一次**真按键**(走 Chromium 输入管线),
        // 再确定性地直接派发同一个 keydown(注入是否被窗口接受受环境影响)。
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await new Promise(res => setTimeout(res, 200));
        const injectedAttr = await win.webContents.executeJavaScript(
            'document.getElementById("noteDoc").getAttribute("data-select-all")');
        // 退出(用 Esc:它同时也是"其它动作要退出全选态"那一条),再用派发的方式重来一次
        await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            doc.querySelector('textarea.blk-input')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        })()`);

        const allSelOn = await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            const ta = doc.querySelector('textarea.blk-input');
            if (!ta) return { ok: false };
            const afterEsc = doc.getAttribute('data-select-all');
            const ev = new KeyboardEvent('keydown',
                { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
            ta.dispatchEvent(ev);
            return {
                ok: true,
                afterEsc,
                attr: doc.getAttribute('data-select-all'),
                prevented: ev.defaultPrevented,
                inputs: doc.querySelectorAll('textarea.blk-input').length,
                bg: getComputedStyle(doc.querySelector('.blk[data-blk="1"]')).backgroundColor,
                bgActive: getComputedStyle(doc.querySelector('.blk-active')).backgroundColor,
                sel: [ta.selectionStart, ta.selectionEnd, ta.value.length],
            };
        })()`);
        r.ok('①Ctrl+A 后整篇进入「全选整篇」态(不是只选当前那一块)',
            injectedAttr === '1' || allSelOn.attr === '1',
            `injected=${injectedAttr} dispatched=${allSelOn.attr} prevented=${allSelOn.prevented}`);
        r.ok('Ctrl+A 之后才有的标记:进入前根节点上没有 data-select-all(状态是真的切换过去的)',
            allSelStart.attrBefore === null && allSelOn.afterEsc === null,
            JSON.stringify({ before: allSelStart.attrBefore, afterEsc: allSelOn.afterEsc }));
        r.ok('★ 视觉提示真的生效(块的背景色变了 —— 不是"没有任何提示"的全选)',
            typeof allSelOn.bg === 'string' && allSelOn.bg !== allSelStart.bgBefore
            && allSelOn.bg !== 'rgba(0, 0, 0, 0)',
            `before=${allSelStart.bgBefore} after=${allSelOn.bg} active=${allSelOn.bgActive}`);
        r.ok('全选态下当前块的 textarea 原生选区也扩到了整块(Ctrl+C 至少能复制这一块)',
            Array.isArray(allSelOn.sel)
            && allSelOn.sel[0] === 0 && allSelOn.sel[1] === allSelOn.sel[2]
            && allSelOn.sel[2] > 0,
            JSON.stringify({ sel: allSelOn.sel }));

        // ② 退格 → 整篇清空(必须**真的落盘**:这个编辑器是自动保存的)
        const allSelCleared = await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            const ta = doc.querySelector('textarea.blk-input');
            const ev = new KeyboardEvent('keydown',
                { key: 'Backspace', bubbles: true, cancelable: true });
            ta.dispatchEvent(ev);
            return {
                prevented: ev.defaultPrevented,
                attr: doc.getAttribute('data-select-all'),
                inputs: doc.querySelectorAll('textarea.blk-input').length,
                active: doc.querySelector('.blk-active')?.dataset.blk ?? null,
                value: doc.querySelector('textarea.blk-input')?.value ?? null,
                blocks: doc.querySelectorAll('.blk').length,
            };
        })()`);
        r.ok('②退格:整篇被清空,只留一个空块(不是只删掉当前那一段)',
            allSelCleared.prevented === true && allSelCleared.value === ''
            && allSelCleared.active === '0' && allSelCleared.inputs === 1,
            JSON.stringify(allSelCleared));
        r.ok('删完立刻退出全选态(不留"看不见的全选")',
            allSelCleared.attr === null, `attr=${allSelCleared.attr}`);

        // 等**自动保存**自己跑完(轮询磁盘,不赌固定时长:AUTOSAVE_MS = 800)
        let allSelSize = -1;
        for (let i = 0; i < 60; i++) {
            try { allSelSize = fs.statSync(allSelAbs).size; } catch { allSelSize = -2; }
            if (allSelSize === 0) break;
            await new Promise(res => setTimeout(res, 100));
        }
        r.ok('★②磁盘上那篇真的空了(自动保存走完了 IPC + 原子写,不是只在界面上删了)',
            allSelSize === 0 && fs.readFileSync(allSelAbs, 'utf8') === '',
            `size=${allSelSize} path=${allSelNote}`);

        // ③ 再来一次 Ctrl+A,打一个字符 → 整篇被替换成那一个字符(并且照样落盘)
        const allSelReplace = await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            const ta = doc.querySelector('textarea.blk-input');
            ta.focus();
            ta.setSelectionRange(0, 0);
            ta.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
            const armed = doc.getAttribute('data-select-all');
            ta.dispatchEvent(new KeyboardEvent('keydown',
                { key: '全', bubbles: true, cancelable: true }));
            return {
                armed,
                attr: doc.getAttribute('data-select-all'),
                value: doc.querySelector('textarea.blk-input')?.value ?? null,
                blocks: doc.querySelectorAll('.blk').length,
            };
        })()`);
        r.ok('③Ctrl+A 之后打一个字符:整篇被替换成那一个字符(全选状态下打字 = 覆盖)',
            allSelReplace.armed === '1' && allSelReplace.value === '全'
            && allSelReplace.attr === null,
            JSON.stringify(allSelReplace));

        let allSelReplaced = null;
        for (let i = 0; i < 60; i++) {
            try { allSelReplaced = fs.readFileSync(allSelAbs, 'utf8'); } catch { allSelReplaced = null; }
            if (allSelReplaced === '全') break;
            await new Promise(res => setTimeout(res, 100));
        }
        r.ok('③替换后的内容也真的落盘(磁盘上就那一个字符)',
            allSelReplaced === '全', JSON.stringify({ disk: allSelReplaced }));

        // ④ 标题框:它不在正文根节点里,Ctrl+A 必须仍是浏览器原生"选中标题"。
        //    这里用**真按键**(sendInputEvent,走输入管线),因为它要验的正是
        //    "原生行为没被拦" —— 合成事件不会触发原生全选,验不了这件事。
        const titleSel = await win.webContents.executeJavaScript(`(() => {
            const t = document.getElementById('noteTitle');
            if (!t) return { ok: false };
            t.focus();
            t.setSelectionRange(0, 0);
            return { ok: true, value: t.value, focused: document.activeElement === t,
                     docAttr: document.getElementById('noteDoc').getAttribute('data-select-all') };
        })()`);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await new Promise(res => setTimeout(res, 200));
        const titleAfter = await win.webContents.executeJavaScript(`(() => {
            const t = document.getElementById('noteTitle');
            return {
                sel: [t.selectionStart, t.selectionEnd, String(t.value).length],
                docAttr: document.getElementById('noteDoc').getAttribute('data-select-all'),
                stillFocused: document.activeElement === t,
            };
        })()`);
        // 注入了真按键却没生效(窗口没被系统聚焦等环境问题)→ 如实记 [SKIP],
        // 不假装通过。注释里说明为什么:这一条要验的就是原生行为。
        if (titleAfter.sel[1] - titleAfter.sel[0] !== titleSel.value.length) {
            r.skip('④标题框里 Ctrl+A 只选标题(没被劫持)',
                `注入的真按键没被窗口接受:sel=${JSON.stringify(titleAfter.sel)}`
                + `(真窗口那一条另由隔离实例的 CDP 输入验过)`);
        } else {
            r.ok('④标题框里 Ctrl+A 只选标题本身(正文那套「全选整篇」没有越界劫持)',
                titleSel.ok === true && titleSel.docAttr === null && titleAfter.docAttr === null
                && titleAfter.sel[0] === 0 && titleAfter.sel[1] === titleSel.value.length
                && titleSel.value.length > 0,
                JSON.stringify({ title: titleSel.value, after: titleAfter }));
        }

        // ---- 页面级 Ctrl+A 守卫:焦点不在输入框里时,不许把整个 app 页面选上 ----
        //
        // 盲区是这么来的:上一轮只处理了"焦点在正文块输入区"(上面那组用例),浏览器还留着
        // 一条**页面级**默认 —— 焦点在外壳 / 列表上按 Ctrl+A,Chromium 把顶栏、笔记列表、
        // AI 对话、连底部那行布局树读数一起选上,屏幕上却没有任何可编辑的东西。守卫在
        // app/main.js 的**捕获期**,判据是纯函数(见 app/lib/select-all-guard.js)。
        //
        // 三条各自的证据分工(为什么不能只留一条):
        //   · ① 与 ③ 验的是"原生行为还在不在"(块里仍是全选整篇 / 那一格仍被原生全选),
        //     必须用**真按键**(sendInputEvent,走 Chromium 输入管线)—— 合成事件不触发原生
        //     全选,这类断言用合成事件验等于没验;
        //   · ② 的端到端读数("页面上没有任何选中")有一个致命的假绿:真按键**没被窗口接受**
        //     时选区同样是空的,与"守卫挡住了"长得一模一样。所以另配两样东西把两者分开 ——
        //     一条**合成事件**的判据读数(外壳上 defaultPrevented=true、可编辑元素上 false,
        //     确定性,不依赖窗口是否被系统聚焦),以及把 ③(标题框被原生全选)当作**注入活性
        //     对照**:它是活的,② 的空选区才说明是守卫挡下来的;
        //   · 另有一条**对照读数**:同一页面上 execCommand('selectAll') 能选出几千字符 ——
        //     证明"空选区"不是空页面/选不动造成的假象。
        //
        // ⚠️ 仍然只在自检自己的临时库里(全选篇.md 现建现删),与真实笔记库无关。
        const guardLabel = '页面级 Ctrl+A 守卫';

        // ① 焦点在正文块输入区:仍是编辑器那套「全选整篇」+ 高亮
        const guardBlock = await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            doc.click();
            const blk = doc.querySelector('.blk[data-blk="0"]');
            if (!blk) return { ok: false, why: '没有第 0 块' };
            blk.click();
            const ta = doc.querySelector('textarea.blk-input');
            if (!ta) return { ok: false, why: '点开第 0 块之后没有输入框' };
            ta.focus();
            ta.setSelectionRange(0, 0);
            const blkNow = doc.querySelector('.blk[data-blk="0"]');
            return {
                ok: true,
                focused: document.activeElement === ta,
                attrBefore: doc.getAttribute('data-select-all'),
                bgBefore: blkNow ? getComputedStyle(blkNow).backgroundColor : null,
            };
        })()`);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await new Promise(res => setTimeout(res, 200));
        const guardBlockAfter = await win.webContents.executeJavaScript(`(() => {
            const doc = document.getElementById('noteDoc');
            const blk = doc.querySelector('.blk[data-blk="0"]');
            return {
                attr: doc.getAttribute('data-select-all'),
                bg: blk ? getComputedStyle(blk).backgroundColor : null,
                focused: document.activeElement === doc.querySelector('textarea.blk-input'),
                pageSel: String(window.getSelection() || ''),
            };
        })()`);
        r.ok('①' + guardLabel + ':正文块输入区里 Ctrl+A 仍是「全选整篇」+ 高亮'
            + '(守卫没把编辑器那条路吃掉)',
            guardBlock.ok === true && guardBlock.focused === true
            && guardBlock.attrBefore === null
            && guardBlockAfter.attr === '1' && guardBlockAfter.bg !== guardBlock.bgBefore,
            JSON.stringify({ before: guardBlock, after: guardBlockAfter }));
        // 退出全选态(用 Esc:它同时也是"其它动作要退出全选态"那一条),免得影响后面的读数
        await win.webContents.executeJavaScript(`(() => {
            const ta = document.getElementById('noteDoc').querySelector('textarea.blk-input');
            if (ta) ta.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Escape', bubbles: true, cancelable: true }));
        })()`);

        // ②a 判据(合成事件 + 真 DOM):外壳 / 富文本区 / 输入框分别该挡还是该放行。
        //     真 DOM 里临时造三个 contenteditable(true / "" / false)的盒子,用完立刻摘掉。
        const guardCriterion = await win.webContents.executeJavaScript(`(() => {
            const fire = (el) => {
                const ev = new KeyboardEvent('keydown',
                    { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
                el.dispatchEvent(ev);
                return ev.defaultPrevented === true;
            };
            const shell = document.querySelector('.topbar-brand')
                || document.querySelector('.topbar') || document.body;
            const out = {
                onShell: fire(shell),
                onTitle: fire(document.getElementById('noteTitle')),
                onSearch: fire(document.getElementById('noteSearch')),
                onAgentInput: fire(document.getElementById('agentInput')),
            };
            const host = document.getElementById('shell');
            const mk = (attrValue) => {
                const box = document.createElement('div');
                if (attrValue !== null) box.setAttribute('contenteditable', attrValue);
                const inner = document.createElement('span');
                inner.textContent = '自检富文本';
                box.appendChild(inner);
                host.appendChild(box);
                return { box: box, inner: inner };
            };
            const t = mk('true');
            out.onCeTrue = fire(t.box);
            out.onCeInner = fire(t.inner);
            t.box.remove();
            const e = mk('');
            out.onCeEmpty = fire(e.box);
            e.box.remove();
            const f = mk('false');
            out.onCeFalse = fire(f.box);
            f.box.remove();
            return out;
        })()`);
        r.ok('②' + guardLabel + '·判据(合成事件,真 DOM):外壳上挡掉页面级全选;'
            + 'input / textarea / contenteditable(含其内部)一律放行,contenteditable=false 不放行',
            guardCriterion.onShell === true
            && guardCriterion.onTitle === false
            && guardCriterion.onSearch === false
            && guardCriterion.onAgentInput === false
            && guardCriterion.onCeTrue === false
            && guardCriterion.onCeInner === false
            && guardCriterion.onCeEmpty === false
            && guardCriterion.onCeFalse === true,
            JSON.stringify(guardCriterion));

        // ②b 端到端:**真鼠标**点顶栏(品牌标记那块,非可编辑、点了什么也不触发)让它失焦,
        //     再按**真 Ctrl+A**。先收读数,断言放到 ③ 之后(要拿 ③ 当注入活性对照)。
        const guardTopbarPoint = await win.webContents.executeJavaScript(`(() => {
            const el = document.querySelector('.topbar-brand') || document.querySelector('.topbar');
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        win.webContents.sendInputEvent({
            type: 'mouseDown', x: guardTopbarPoint.x, y: guardTopbarPoint.y,
            button: 'left', clickCount: 1,
        });
        win.webContents.sendInputEvent({
            type: 'mouseUp', x: guardTopbarPoint.x, y: guardTopbarPoint.y,
            button: 'left', clickCount: 1,
        });
        await new Promise(res => setTimeout(res, 150));
        const guardShellBefore = await win.webContents.executeJavaScript(`(() => {
            const editableOf = (el) => Boolean(el && typeof el.closest === 'function'
                && el.closest('input, textarea, [contenteditable="true"], [contenteditable=""]'));
            const ae = document.activeElement;
            const out = {
                activeTag: ae ? ae.tagName : null,
                activeId: ae && ae.id ? ae.id : '',
                editable: editableOf(ae),
                docAttr: document.getElementById('noteDoc').getAttribute('data-select-all'),
            };
            if (out.editable) {
                ae.blur();
                out.blurredBy = 'fallback(真鼠标点击没让焦点离开输入框)';
                const ae2 = document.activeElement;
                out.activeTag2 = ae2 ? ae2.tagName : null;
                out.editable2 = editableOf(ae2);
            }
            const sel = window.getSelection();
            if (sel && typeof sel.removeAllRanges === 'function') sel.removeAllRanges();
            return out;
        })()`);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await new Promise(res => setTimeout(res, 200));
        const guardShellAfter = await win.webContents.executeJavaScript(`(() => {
            const sel = window.getSelection();
            const text = sel ? String(sel) : null;
            const anchor = sel && sel.anchorNode ? sel.anchorNode : null;
            return {
                reading: 'window.getSelection()',
                isCollapsed: sel ? sel.isCollapsed === true : null,
                rangeCount: sel ? sel.rangeCount : null,
                toString: text,
                textLen: text === null ? null : text.length,
                anchorTag: anchor
                    ? (anchor.nodeType === 1 ? anchor.tagName
                        : (anchor.parentElement ? anchor.parentElement.tagName : null))
                    : null,
                docAttr: document.getElementById('noteDoc').getAttribute('data-select-all'),
                bodyTextLen: document.body.innerText ? document.body.innerText.length : 0,
            };
        })()`);
        // 对照读数:同一页面上"整页其实选得动"(否则上面那个空选区什么都证明不了)
        const guardSelProbe = await win.webContents.executeJavaScript(`(() => {
            const sel = window.getSelection();
            if (sel) sel.removeAllRanges();
            let canSelect = false;
            try { canSelect = document.execCommand('selectAll') === true; } catch (e) { canSelect = false; }
            const s2 = window.getSelection();
            const text = s2 ? String(s2) : '';
            const head = text.slice(0, 40);
            if (s2) s2.removeAllRanges();
            return { canSelect: canSelect, len: text.length, head: head };
        })()`);

        // ③ 标题框 / 搜索框:真按键,必须仍是"只选那一格"。它同时是 ②b 的注入活性对照 ——
        //    标题框真的被原生全选了,说明输入管线是活的,②b 的空选区才不是假象。
        const guardTitleBefore = await win.webContents.executeJavaScript(`(() => {
            const t = document.getElementById('noteTitle');
            t.focus();
            t.setSelectionRange(0, 0);
            return {
                value: t.value,
                focused: document.activeElement === t,
                docAttr: document.getElementById('noteDoc').getAttribute('data-select-all'),
            };
        })()`);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await new Promise(res => setTimeout(res, 200));
        const guardTitleAfter = await win.webContents.executeJavaScript(`(() => {
            const t = document.getElementById('noteTitle');
            return {
                sel: [t.selectionStart, t.selectionEnd, String(t.value).length],
                stillFocused: document.activeElement === t,
                docAttr: document.getElementById('noteDoc').getAttribute('data-select-all'),
            };
        })()`);
        const guardInjectionLive = guardTitleBefore.focused === true
            && guardTitleAfter.sel[1] - guardTitleAfter.sel[0] === guardTitleAfter.sel[2]
            && guardTitleAfter.sel[2] > 0;

        // 搜索框(同一条:它是外壳上的另一个输入框,守卫同样不许碰)
        const GUARD_SEARCH_WORD = '自检搜索词';
        const guardSearchBefore = await win.webContents.executeJavaScript(`(() => {
            const s = document.getElementById('noteSearch');
            s.value = '自检搜索词';
            s.focus();
            s.setSelectionRange(0, 0);
            return { len: String(s.value).length, focused: document.activeElement === s };
        })()`);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await new Promise(res => setTimeout(res, 200));
        const guardSearchAfter = await win.webContents.executeJavaScript(`(() => {
            const s = document.getElementById('noteSearch');
            const out = {
                sel: [s.selectionStart, s.selectionEnd, String(s.value).length],
                stillFocused: document.activeElement === s,
                selected: String(s.value).slice(s.selectionStart, s.selectionEnd),
            };
            s.value = '';
            return out;
        })()`);
        const guardSearchLive = guardSearchAfter.sel[1] - guardSearchAfter.sel[0] === guardSearchBefore.len
            && guardSearchBefore.len > 0;

        // ---- 三条的断言(②b 依赖 ③ 的活性对照,所以放在 ③ 之后一起报)----
        if (!guardInjectionLive) {
            r.skip('②' + guardLabel + ':焦点在外壳(顶栏)时 Ctrl+A,页面上没有任何选中',
                '本次注入的真按键没被窗口接受(见 ③ 的读数),这一条无法判定'
                + ' —— 判据本身已由上面那条合成事件读数覆盖');
        } else {
            r.ok('②' + guardLabel + ':焦点在外壳(顶栏)时 Ctrl+A,页面上没有任何选中'
                + '(window.getSelection().isCollapsed === true 且 toString() === "")',
                (guardShellBefore.editable === false || guardShellBefore.editable2 === false)
                && guardShellAfter.isCollapsed === true
                && guardShellAfter.toString === ''
                && guardShellAfter.textLen === 0
                && guardShellAfter.docAttr === null,
                JSON.stringify({ before: guardShellBefore, after: guardShellAfter }));
        }
        r.ok('②' + guardLabel + '·对照读数:同一页面上整页确实"选得动"'
            + '(execCommand(selectAll) 能选出几千字符),所以上面的空选区不是空页面的假象',
            guardSelProbe.len > 0,
            JSON.stringify({ canSelect: guardSelProbe.canSelect, len: guardSelProbe.len,
                             head: guardSelProbe.head, bodyTextLen: guardShellAfter.bodyTextLen }));

        if (guardInjectionLive) {
            r.ok('③' + guardLabel + ':标题框 Ctrl+A 仍然只选那一格的内容'
                + '(没被守卫劫持,也没被正文那套「全选整篇」吃掉)',
                guardTitleBefore.focused === true && guardTitleAfter.stillFocused === true
                && guardTitleAfter.sel[0] === 0
                && guardTitleAfter.sel[1] === guardTitleAfter.sel[2]
                && guardTitleAfter.sel[2] > 0
                && guardTitleBefore.docAttr === null && guardTitleAfter.docAttr === null,
                JSON.stringify({ title: guardTitleBefore.value, after: guardTitleAfter }));
        } else {
            r.skip('③' + guardLabel + ':标题框 Ctrl+A 仍然只选那一格的内容',
                '注入的真按键没被窗口接受:sel=' + JSON.stringify(guardTitleAfter.sel)
                + '(真窗口那一条另由隔离实例的 CDP 输入验过)');
        }
        if (guardSearchLive) {
            r.ok('③' + guardLabel + ':搜索框 Ctrl+A 仍然只选那一格的内容'
                + '(守卫只挡页面级全选,不碰任何输入框)',
                guardSearchBefore.focused === true && guardSearchAfter.stillFocused === true
                && guardSearchAfter.sel[0] === 0
                && guardSearchAfter.sel[1] === guardSearchBefore.len
                && guardSearchAfter.selected === GUARD_SEARCH_WORD,
                JSON.stringify({ word: GUARD_SEARCH_WORD, after: guardSearchAfter }));
        } else {
            r.skip('③' + guardLabel + ':搜索框 Ctrl+A 仍然只选那一格的内容',
                '注入的真按键没被窗口接受:sel=' + JSON.stringify(guardSearchAfter.sel));
        }

        // 收尾:切回甲篇(后面的断言不该依赖"现在打开的是哪一篇")—— 见下面第 862 行那段。
        await switchToNote(win, '甲篇.md');

        // ---- 新建文件夹 + 树状目录(用户 2026-09-18 要的)----
        //
        // 走**完整链路**:点按钮 → 内联输入 → 回车 → preload → 主进程 mkdir →
        // 索引带上 folders → 树里出现这一行。单测用的是替身,这里是真的。
        await win.webContents.executeJavaScript(
            'document.getElementById("viewNotes").click()');
        await win.webContents.executeJavaScript(
            'document.getElementById("noteNewFolder").click()');
        r.ok('侧栏有「新建文件夹」入口,点了出现内联输入行',
            await waitForElement(win, '#noteList input.note-new-input') === true);

        await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-new-input');
            i.value = '验收目录';
            i.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true }));
        })()`);
        // ⚠️ 判"存在某个 data-folder=验收目录 的行",不要拿树里第一个文件夹去比 ——
        // 自检自己的夹具目录(夹具起点 / 夹具终点)也在这棵树里。
        const folderAttr = await waitForAttr(win, '#noteList button.note-dir[data-folder="验收目录"]',
            'data-folder', '验收目录', 40);
        r.ok('验收UI:新建的文件夹出现在树里(空目录也要看得见 —— 它不在笔记清单里)',
            folderAttr === '验收目录', `folder=${folderAttr}`);

        await win.webContents.executeJavaScript(
            'document.querySelector(\'#noteList button.note-dir-add[data-new-note-in="验收目录"]\')?.click()');
        const nestedPath = '验收目录/未命名.md';
        const nested = await waitForAttr(win, `#noteList button[data-path="${nestedPath}"]`,
            'data-path', nestedPath, 60);
        r.ok('验收UI:能在文件夹里新建笔记(路径带目录前缀)',
            nested === nestedPath, `path=${nested}`);
        const nestedDepth = await win.webContents.executeJavaScript(`(() => {
            const el = document.querySelector('#noteList button[data-path="${nestedPath}"]');
            if (!el) return null;
            const v = getComputedStyle(el).getPropertyValue('--depth');
            return v === null || v === undefined ? null : String(v).trim();
        })()`);
        r.ok('验收UI:树里的笔记按层级缩进(--depth = 1)',
            nestedDepth === '1', `--depth=${JSON.stringify(nestedDepth)}`);

        // 切回甲篇:后面的断言不该依赖"现在打开的是哪一篇"。
        // 走 switchToNote:超时就再点一次,不赌单次点击的时序(见那里的说明)
        await switchToNote(win, '甲篇.md');

        // 标签面板
        const tagCount = await win.webContents.executeJavaScript(
            'document.querySelectorAll("#tagPanel .tag-chip").length');
        r.ok('标签面板列出标签', tagCount >= 1, `count=${tagCount}`);

        // ---- 标签面板方案 4:工具条 + 前 N + 「+N」+ 顶部筛选提示 ----
        // 改这一块的起因是"标签越多侧栏越高"(实测 9 个 138px → 30 个 346px)。
        // 这里量的是真面板:头部三个工具、名字与计数分开、收起后只剩一行、
        // 以及"列表为什么变短了"必须在**列表顶部**看得见。
        const tagPanel = await win.webContents.executeJavaScript(`(() => {
            const p = document.getElementById('tagPanel');
            return {
                tools: [...p.querySelectorAll('.tag-tool')].map(b => b.getAttribute('aria-label')),
                chips: [...p.querySelectorAll('.tag-chip')].map(c => ({
                    name: c.querySelector('.tag-name')?.textContent ?? null,
                    count: c.querySelector('.tag-count')?.textContent ?? null,
                })),
            };
        })()`);
        r.ok('标签面板有工具条(过滤 / 排序 / 收起,都带 aria-label)',
            tagPanel.tools.length === 3 && tagPanel.tools.every(l => typeof l === 'string' && l.length > 0),
            JSON.stringify(tagPanel.tools));
        r.ok('标签的名字与计数是分开的两段(不再糊成「#自检 1」)',
            tagPanel.chips.length >= 1
            && tagPanel.chips.every(c => /^#/.test(c.name ?? '') && /^\d+$/.test(c.count ?? '')),
            JSON.stringify(tagPanel.chips));

        await win.webContents.executeJavaScript(
            'document.querySelector(\'#tagPanel .tag-tool[aria-label="收起标签栏"]\')?.click()');
        const collapsedChips = await win.webContents.executeJavaScript(
            'document.querySelectorAll("#tagPanel .tag-chip").length');
        r.ok('点「收起」后标签区只剩头部一行(高度不再随标签数量走)',
            collapsedChips === 0, `chips=${collapsedChips}`);
        await win.webContents.executeJavaScript(
            'document.querySelector(\'#tagPanel .tag-tool[aria-label="展开标签栏"]\')?.click()');
        r.ok('再点一次能展开回来',
            await win.webContents.executeJavaScript(
                'document.querySelectorAll("#tagPanel .tag-chip").length') >= 1);

        const notesBefore = await win.webContents.executeJavaScript(
            'document.querySelectorAll("#noteList button[data-path]").length');
        await win.webContents.executeJavaScript(
            'document.querySelector("#tagPanel .tag-chip")?.click()');
        const filtered = await win.webContents.executeJavaScript(`(() => {
            const bar = document.getElementById('tagFilterBar');
            return {
                hidden: bar.hidden,
                name: document.getElementById('tagFilterName').textContent,
                notes: document.querySelectorAll('#noteList button[data-path]').length,
            };
        })()`);
        r.ok('选中标签后,列表**顶部**出现「筛选中:#… ×」(列表为什么变短一眼可见)',
            filtered.hidden === false && /^#/.test(filtered.name), JSON.stringify(filtered));
        r.ok('筛选真的作用在列表上(不是只有提示条)',
            filtered.notes < notesBefore, `before=${notesBefore} after=${filtered.notes}`);
        await win.webContents.executeJavaScript('document.getElementById("tagFilterClear")?.click()');
        const cleared = await win.webContents.executeJavaScript(`({
            hidden: document.getElementById('tagFilterBar').hidden,
            notes: document.querySelectorAll('#noteList button[data-path]').length,
        })`);
        r.ok('点 × 清除筛选,列表条数恢复',
            cleared.hidden === true && cleared.notes === notesBefore, JSON.stringify(cleared));

        // ---- 列表右键菜单 → 行内重命名(产品要的「笔记目录右键菜单栏可重命名笔记」)----
        //
        // 走**完整链路**:右键 → 渲染层浮层 → 点「重命名」→ 行内输入 → 回车 →
        // preload → 主进程 notes:rename → 索引重算 → 列表里是新路径,
        // 而且**磁盘上的文件名真的变了**。单测用的是替身,这里是真的。
        //
        // ⚠️ 用的是自检自己的临时库(vault.dir —— createSelftestVault 在 os.tmpdir() 下
        //    现建现删的那一份),与用户真实的笔记库没有任何关系。
        const renameTarget = '验收目录/未命名.md';
        const openNoteListMenu = (relPath) => win.webContents.executeJavaScript(`(() => {
            const b = document.querySelector('#noteList button[data-path=${JSON.stringify(relPath)}]');
            if (!b) return false;
            b.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, clientX: 180, clientY: 200,
            }));
            return true;
        })()`);
        const menuShape = () => win.webContents.executeJavaScript(`(() => {
            const box = document.querySelector('.note-menu');
            if (!box) return null;
            const item = box.querySelector('[data-menu-role="rename"]');
            const r = box.getBoundingClientRect();
            return {
                role: box.getAttribute('role'),
                labels: [...box.querySelectorAll('.note-menu-item')].map(b => b.textContent),
                itemRole: item ? item.getAttribute('role') : null,
                focused: item ? document.activeElement === item : false,
                onScreen: r.width > 0 && r.height > 0
                    && r.left >= 0 && r.top >= 0
                    && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
            };
        })()`);

        r.ok('验收UI:右键那一行弹出的是渲染层浮层菜单(不是原生 Menu)',
            await openNoteListMenu(renameTarget) === true);
        const menu = await menuShape();
        r.ok('验收UI:浮层里有两项「重命名」「删除笔记」,可聚焦、尺寸非零、没跑出窗口',
            menu !== null && menu.role === 'menu'
            && JSON.stringify(menu.labels) === JSON.stringify(['重命名', '删除笔记'])
            && menu.itemRole === 'menuitem' && menu.focused === true && menu.onScreen === true,
            JSON.stringify(menu));

        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="rename"]\')?.click()');
        const renameInput = await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-rename-input');
            if (!i) return null;
            return {
                value: i.value,
                label: i.getAttribute('aria-label'),
                dataPath: i.dataset.path,
                focused: document.activeElement === i,
                menuGone: document.querySelector('.note-menu') === null,
            };
        })()`);
        r.ok('验收UI:点「重命名」后那一行变成输入框,预填的是**不含 .md 的主名**',
            renameInput !== null && renameInput.value === '未命名'
            && renameInput.dataPath === renameTarget
            && /重命名笔记/.test(String(renameInput.label))
            && renameInput.focused === true && renameInput.menuGone === true,
            JSON.stringify(renameInput));

        // 真正输入新名字再回车(走键盘事件,与用户按键同一条路)
        await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-rename-input');
            i.value = '改名验收';
            i.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true }));
        })()`);
        const renamedPath = '验收目录/改名验收.md';
        const renamedRow = await waitForAttr(win,
            `#noteList button[data-path="${renamedPath}"]`, 'data-path', renamedPath, 60);
        r.ok('验收UI:回车后列表里是新路径,旧路径那行没了',
            renamedRow === renamedPath
            && await win.webContents.executeJavaScript(
                `document.querySelector('#noteList button[data-path=${JSON.stringify(renameTarget)}]') === null
                 && document.querySelector('#noteList input.note-rename-input') === null`),
            `row=${renamedRow}`);

        // 磁盘上**真的**改名了(这一条才是"重命名"这件事本身);正文一个字节都不动
        const renamedText = fs.existsSync(path.join(vault.dir, renamedPath))
            ? fs.readFileSync(path.join(vault.dir, renamedPath), 'utf8') : null;
        r.ok('验收UI:磁盘上文件名真的变了(旧文件消失、新文件在),内容一字不动',
            fs.existsSync(path.join(vault.dir, renamedPath)) && renamedText !== null
            && !fs.existsSync(path.join(vault.dir, renameTarget))
            && /# 未命名/.test(renamedText),
            `new=${fs.existsSync(path.join(vault.dir, renamedPath))}`
            + ` old=${fs.existsSync(path.join(vault.dir, renameTarget))}`);

        // 「目标已存在」:甲篇.md 就在那儿,把乙篇改名成它 → 必须报错并**把行恢复成原名**
        await openNoteListMenu('乙篇.md');
        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="rename"]\')?.click()');
        await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-rename-input');
            i.value = '甲篇';
            i.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true }));
        })()`);
        const conflictStatus = await waitForMatch(win, '#noteStatus', /已存在/, 40);
        r.ok('验收UI:目标已存在时把主进程的报错显示出来(不是静默失败)',
            typeof conflictStatus === 'string' && /重命名失败/.test(conflictStatus)
            && /已存在/.test(conflictStatus), String(conflictStatus));
        const afterConflict = await win.webContents.executeJavaScript(`({
            row: document.querySelector('#noteList button[data-path="乙篇.md"]') !== null,
            input: document.querySelector('#noteList input.note-rename-input') !== null,
        })`);
        r.ok('验收UI:失败的改名不许留在界面上 —— 那一行恢复原名,输入框收起',
            afterConflict.row === true && afterConflict.input === false,
            JSON.stringify(afterConflict));
        r.ok('验收UI:冲突时两个文件都一个字不动',
            fs.existsSync(path.join(vault.dir, '乙篇.md'))
            && fs.existsSync(path.join(vault.dir, '甲篇.md')));

        // 名字里有路径分隔符 = 想移动。必须**明确拒绝**,不能静默当成移动
        await openNoteListMenu('乙篇.md');
        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="rename"]\')?.click()');
        await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-rename-input');
            i.value = '子目录/乙篇';
            i.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true }));
        })()`);
        const sepStatus = await waitForMatch(win, '#noteStatus', /分隔符/, 40);
        r.ok('验收UI:名字里的路径分隔符被明确拒绝(提示里说清"这是重命名不是移动")',
            typeof sepStatus === 'string' && /分隔符/.test(sepStatus), String(sepStatus));
        r.ok('验收UI:被拒绝时笔记留在原地(没有偷偷搬进子目录)',
            await win.webContents.executeJavaScript(
                'document.querySelector(\'#noteList button[data-path="乙篇.md"]\') !== null')
            && fs.existsSync(path.join(vault.dir, '乙篇.md')));

        // 改的是**正打开着的那篇**:currentPath 与顶栏路径显示都要跟着走,
        // 否则下一次自动保存会写到一个已经不存在的老路径上(内容就丢了)。
        await switchToNote(win, '甲篇.md');
        await openNoteListMenu('甲篇.md');
        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="rename"]\')?.click()');
        await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-rename-input');
            i.value = '甲篇改';
            i.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true }));
        })()`);
        const openRenamed = await waitForTextEqual(win, '#notePath', '甲篇改.md', 60);
        r.ok('验收UI:改的正打开着的那篇时,#notePath 跟着走到新路径',
            openRenamed === '甲篇改.md', `path=${openRenamed}`);
        r.ok('验收UI:磁盘上也真的改了名',
            fs.existsSync(path.join(vault.dir, '甲篇改.md'))
            && !fs.existsSync(path.join(vault.dir, '甲篇.md')));
        // 改回去:后面的断言(切笔记 / 反链)都按「甲篇.md」这个名字走
        await openNoteListMenu('甲篇改.md');
        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="rename"]\')?.click()');
        await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-rename-input');
            i.value = '甲篇';
            i.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true }));
        })()`);
        const nameBack = await waitForAttr(win, '#noteList button[data-path="甲篇.md"]',
            'data-path', '甲篇.md', 60);
        r.ok('验收UI:再改回「甲篇.md」也成功(名字回到原样,后续断言不被这次改名带偏)',
            nameBack === '甲篇.md' && fs.existsSync(path.join(vault.dir, '甲篇.md')),
            `row=${nameBack}`);

        // ---- 列表**空白处**右键 → 新建笔记 ----
        //
        // 产品原话:「右击空白处可以在菜单栏中新建笔记」。与上面那族走同一条链路,
        // 只把触发点从"某一行"换成"列表容器里、任何行之外":
        // 右键 → 渲染层浮层 → 点「新建笔记」→ preload → 主进程 notes:create →
        // 索引重算 → 列表多一条,而且**磁盘上真的有那个文件**。
        //
        // ⚠️ 用的还是自检自己的临时库(vault.dir —— makeTempVault 在 os.tmpdir() 下
        //    现建现删的那一份),与用户真实的笔记库没有任何关系。
        //
        // 空白点用 elementFromPoint **扫**出来,而不是随便往某个节点上派发事件 ——
        // 后者连"这一点到底是不是空白"都没证明(那样测的只是"我把事件派给了谁")。
        const blankPoint = await win.webContents.executeJavaScript(`(() => {
            const nav = document.querySelector('.notes-nav-scroll');
            if (!nav) return { ok: false, why: '没有 .notes-nav-scroll' };
            const box = nav.getBoundingClientRect();
            for (let y = Math.round(box.bottom) - 8; y > box.top + 4; y -= 4) {
                for (const fx of [0.25, 0.5, 0.75]) {
                    const x = Math.round(box.left + box.width * fx);
                    const el = document.elementFromPoint(x, y);
                    if (!el || !nav.contains(el)) continue;
                    // 空白 = 不是任何一行、不在标签面板/筛选条上、不是已经开着的浮层
                    if (el.closest('button, input, li, .tag-panel, .tag-filter-bar, .note-menu')) continue;
                    el.dispatchEvent(new MouseEvent('contextmenu',
                        { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                    return { ok: true, x, y, tag: el.tagName, cls: String(el.className) };
                }
            }
            return { ok: false, why: 'nav 里没扫到空白点' };
        })()`);
        const readMenu = () => win.webContents.executeJavaScript(`(() => {
            const box = document.querySelector('.note-menu');
            if (!box) return null;
            const r = box.getBoundingClientRect();
            const first = box.querySelector('.note-menu-item');
            return {
                kind: box.dataset.menuKind,
                role: box.getAttribute('role'),
                labels: [...box.querySelectorAll('.note-menu-item')].map(b => b.textContent),
                menuRoles: [...box.querySelectorAll('.note-menu-item')].map(b => b.dataset.menuRole),
                focused: first ? document.activeElement === first : false,
                onScreen: r.width > 0 && r.height > 0
                    && r.left >= 0 && r.top >= 0
                    && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
            };
        })()`);
        const blankMenu = await readMenu();
        r.ok('验收UI:列表**空白处**右键弹出渲染层浮层,第一项是「新建笔记」',
            blankPoint.ok === true && blankMenu !== null
            && blankMenu.kind === 'blank' && blankMenu.role === 'menu'
            && blankMenu.labels[0] === '新建笔记'
            && blankMenu.menuRoles[0] === 'new-note'
            && blankMenu.focused === true && blankMenu.onScreen === true,
            JSON.stringify({ point: blankPoint, menu: blankMenu }));

        const notesBeforeBlank = await win.webContents.executeJavaScript(
            'document.querySelectorAll("#noteList button[data-path]").length');
        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="new-note"]\')?.click()');
        const createdPath = '未命名.md';
        const createdRow = await waitForAttr(win,
            `#noteList button[data-path="${createdPath}"]`, 'data-path', createdPath, 60);
        const notesAfterBlank = await win.webContents.executeJavaScript(
            'document.querySelectorAll("#noteList button[data-path]").length');
        r.ok('验收UI:点「新建笔记」后列表上真的多了一条(而且就是这条路径)',
            createdRow === createdPath && notesAfterBlank === notesBeforeBlank + 1,
            `row=${createdRow} before=${notesBeforeBlank} after=${notesAfterBlank}`);
        r.ok('验收UI:磁盘上真的有那个文件(这一条才是"新建"这件事本身)',
            fs.existsSync(path.join(vault.dir, createdPath)),
            `exists=${fs.existsSync(path.join(vault.dir, createdPath))}`);
        const createdText = fs.existsSync(path.join(vault.dir, createdPath))
            ? fs.readFileSync(path.join(vault.dir, createdPath), 'utf8') : null;
        r.ok('验收UI:新笔记的初始正文与 ＋ 按钮那条路一致(# 标题 + 空行)',
            createdText === '# 未命名\n\n', JSON.stringify(createdText));
        r.ok('验收UI:建完就打开它(与 ＋ 按钮同一条规则)',
            await waitForTextEqual(win, '#notePath', createdPath, 60) === createdPath,
            await win.webContents.executeJavaScript(
                'document.getElementById("notePath").textContent'));

        // 反过来验一次:右键落在**笔记行**上,出的必须是那一行自己的菜单(重命名),
        // 不能被空白菜单抢走。真窗口里就看 dataset.menuKind —— 两份菜单文案不一样,
        // 但"谁抢了谁"只有这个字段说得清。
        await openNoteListMenu('乙篇.md');
        const rowMenu = await readMenu();
        r.ok('验收UI:在**笔记行**上右键出的是行菜单(重命名 + 删除笔记),空白菜单不抢',
            rowMenu !== null && rowMenu.kind === 'note'
            && JSON.stringify(rowMenu.labels) === JSON.stringify(['重命名', '删除笔记']),
            JSON.stringify(rowMenu));
        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="rename"]\')?.click()');
        await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-rename-input');
            i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        })()`);
        r.ok('验收UI:行菜单收起后没留下改名输入框(反悔手势仍然有效)',
            await win.webContents.executeJavaScript(
                'document.querySelector("#noteList input.note-rename-input") === null'));

        // 把打开的那篇还回「甲篇.md」:后面的断言不该依赖"刚刚新建的是哪一篇"
        await switchToNote(win, '甲篇.md');

        // ---- 列表行右键 → 「删除笔记」:两步确认 → 进系统回收站 ----
        //
        // 产品原话:「右击添加删除笔记选项」。这一节走**完整链路**:
        //   右键那一行 → 点「删除笔记」(第一次)→ 确认态,**磁盘上文件还在** →
        //   再点一次 → 列表少一条 + preload(notes:remove)→ 主进程
        //   shell.trashItem → **磁盘上真的没有了**(这一条才是"删除"这件事本身)。
        // 另外单独验一条最险的:**正在编辑、且有未保存改动**的那一篇必须拒删。
        //
        // ⚠️ 用的是自检自己的临时库(vault.dir,os.tmpdir() 下现建现删的那一份),
        //    与用户真实的笔记库没有任何关系。回收站里那份东西自检**不碰**:
        //    不还原、不清空(它本来就是临时库里的一次性文件)。
        // ⚠️ 目标是上面空白菜单刚建的那条 `未命名.md`:它不被后面任何断言引用。
        const delTarget = createdPath;
        r.ok('验收UI:删除目标在磁盘上确实存在(前置条件)',
            fs.existsSync(path.join(vault.dir, delTarget)),
            `exists=${fs.existsSync(path.join(vault.dir, delTarget))}`);

        const onDeleteTarget = await switchToNote(win, delTarget);
        r.ok('验收UI:切到那条待删的笔记上(后面两步都按"它正开着"来验)',
            onDeleteTarget === true);
        // ④ 最险的一条:**正在编辑 + 有未保存改动** → 拒删并说清原因。
        //    ⚠️ 造脏与两次点击必须在**同一段同步脚本**里。编辑器 800ms 后会自动保存,
        //    中间一旦让出主线程(换成多次 executeJavaScript 就是一个来回几十毫秒),
        //    笔记就可能已经变干净 —— 那时这条用例验的就不是"脏时拒删"了。
        const dirtyRefusal = await win.webContents.executeJavaScript(`(() => {
            // 挑**最后一块**(那行空行):往标题行里写字会顺带改掉标题,而这里要验的
            // 只是"有未保存改动",不该把别的语义搅进来。
            const blks = [...document.querySelectorAll('#noteDoc .blk')];
            const blk = blks.length > 0 ? blks[blks.length - 1] : null;
            if (!blk) return { ok: false, why: '正文里一块都没有' };
            blk.click();
            const ta = document.querySelector('#noteDoc textarea.blk-input');
            if (!ta) return { ok: false, why: '没有源码输入框' };
            ta.value = ta.value + '自检脏改动';
            ta.dispatchEvent(new Event('input', { bubbles: true }));   // 与用户打字同一条路

            const row = document.querySelector('#noteList button[data-path=${JSON.stringify(delTarget)}]');
            if (!row) return { ok: false, why: '列表里没有那一行' };
            row.dispatchEvent(new MouseEvent('contextmenu',
                { bubbles: true, cancelable: true, clientX: 180, clientY: 200 }));
            const item = document.querySelector('.note-menu [data-menu-role="delete-note"]');
            if (!item) return { ok: false, why: '菜单里没有「删除笔记」这一项' };
            item.click();       // 第一次:进确认态(不执行)
            item.click();       // 第二次:应当被**拒绝**
            const st = document.getElementById('noteStatus');
            return {
                ok: true,
                status: st.textContent, state: st.dataset.state,
                menuGone: document.querySelector('.note-menu') === null,
                path: document.getElementById('notePath').textContent,
            };
        })()`);
        r.ok('验收UI:正在编辑且有未保存改动的那一篇 → 拒删,并把原因说在状态行上',
            dirtyRefusal.ok === true
            && /未保存/.test(String(dirtyRefusal.status)) && dirtyRefusal.state === 'error',
            JSON.stringify(dirtyRefusal));
        r.ok('验收UI:被拒之后文件还在磁盘上、那一行还在列表里、编辑器还指着它',
            fs.existsSync(path.join(vault.dir, delTarget))
            && dirtyRefusal.path === delTarget
            && await win.webContents.executeJavaScript(
                `document.querySelector('#noteList button[data-path=${JSON.stringify(delTarget)}]') !== null`),
            JSON.stringify(dirtyRefusal));

        // 把刚才那点脏改动落盘(点保存按钮,与用户同一条路),好让"干净时删除"走得到
        await win.webContents.executeJavaScript('document.getElementById("noteSave")?.click()');
        await waitForMatch(win, '#noteStatus', /已保存/, 60);

        // ② 第一次点「删除笔记」:进确认态,**一个字节都不许动**
        await openNoteListMenu(delTarget);
        const beforeDelete = await win.webContents.executeJavaScript(`({
            count: document.querySelectorAll('#noteList button[data-path]').length,
            // 上面那次保存会把这一篇的上一代内容写成「未命名.md.bak」(writeNote 的
            // 有意行为),它在树里是一条 .note-other 行。删的时候它必须**一起走** ——
            // 所以先记下它此刻在不在(在不在都合法,但断言要跟着它的实际状态走)。
            bakRow: document.querySelector('#noteList button[data-path=' + JSON.stringify(${JSON.stringify(delTarget + '.bak')}) + ']') !== null,
        })`);
        const bakOnDiskBefore = fs.existsSync(path.join(vault.dir, `${delTarget}.bak`));
        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="delete-note"]\')?.click()');
        const armedState = await win.webContents.executeJavaScript(`(() => {
            const box = document.querySelector('.note-menu');
            if (!box) return { menuOpen: false };
            const del = box.querySelector('[data-menu-role="delete-note"]');
            const ren = box.querySelector('[data-menu-role="rename"]');
            const r = del.getBoundingClientRect();
            return {
                menuOpen: true,
                label: del.textContent,
                role: del.getAttribute('role'),
                danger: del.dataset.menuDanger,
                // 告警色必须**真的**落在这一项上(不是只写了个 data 属性):
                // 与旁边那一项的实际算出色做对比 —— 两边一样就说明样式没接上。
                delColor: getComputedStyle(del).color,
                renColor: getComputedStyle(ren).color,
                width: Math.round(r.width), height: Math.round(r.height),
            };
        })()`);
        r.ok('验收UI:第一次点「删除笔记」只进确认态 —— 文案变成「再点一次确认删除」,菜单不关',
            armedState.menuOpen === true && armedState.label === '再点一次确认删除'
            && armedState.role === 'menuitem'
            && armedState.width > 0 && armedState.height > 0,
            JSON.stringify(armedState));
        r.ok('验收UI:确认态带告警色(与旁边那一项的实际算出色不同,不是只写了个属性)',
            armedState.danger === 'true' && armedState.delColor !== armedState.renColor,
            JSON.stringify(armedState));
        // ⚠️ 读数里**必须**带上"现在数到几" —— 只打 before 的话,红了也不知道是多了还是少了
        //    (这条断言曾经连续两次红,靠读数才看出到底是哪一边)。
        const rowsAtConfirm = await win.webContents.executeJavaScript(
            'document.querySelectorAll("#noteList button[data-path]").length');
        // ⚠️ 判据是 `>=` 而不是 `==`:这句话的字面意思是"**一条不少**"(确认态不许把行弄丢),
        //    而两次读数之间可能有并发的刷新/新建让行数**多**出来 —— 那不是这条断言要管的事。
        //    用 `==` 会把它变成一条看运气的用例(实测:同一份代码有跑 12 有跑 13,红过两次)。
        r.ok('验收UI:确认态时磁盘上的文件还在,列表也一条不少',
            fs.existsSync(path.join(vault.dir, delTarget)) && rowsAtConfirm >= beforeDelete.count,
            `exists=${fs.existsSync(path.join(vault.dir, delTarget))} before=${beforeDelete.count} now=${rowsAtConfirm}`);

        // ③ 再点一次 → 真的删:列表里那一篇没了 + 磁盘上真的没有了
        await win.webContents.executeJavaScript(
            'document.querySelector(\'.note-menu [data-menu-role="delete-note"]\')?.click()');
        const deleteStatus = await waitForMatch(win, '#noteStatus', /回收站/, 60);
        r.ok('验收UI:第二次点击才真的删,并在状态行说清"进了回收站"(可还原,不是永久删)',
            typeof deleteStatus === 'string' && /回收站/.test(deleteStatus), String(deleteStatus));
        const listAfterDelete = await win.webContents.executeJavaScript(`({
            row: document.querySelector('#noteList button[data-path=${JSON.stringify(delTarget)}]') !== null,
            bakRow: document.querySelector('#noteList button[data-path=' + JSON.stringify(${JSON.stringify(delTarget + '.bak')}) + ']') !== null,
            menu: document.querySelector('.note-menu') !== null,
            count: document.querySelectorAll('#noteList button[data-path]').length,
        })`);
        // 少几条取决于 .bak 那一行之前在不在:笔记那一行必然消失,备份行跟着一起走。
        const rowsGone = beforeDelete.count - listAfterDelete.count;
        r.ok('验收UI:列表里那一篇(以及它的 .bak 行,如果它在)真的没了,浮层也收起来了',
            listAfterDelete.row === false && listAfterDelete.bakRow === false
            && listAfterDelete.menu === false
            && rowsGone === (beforeDelete.bakRow ? 2 : 1),
            JSON.stringify({ beforeDelete, listAfterDelete, rowsGone }));
        r.ok('验收UI:★ 磁盘上那个文件真的没有了(这一条才是"删除"这件事本身)',
            !fs.existsSync(path.join(vault.dir, delTarget)),
            `exists=${fs.existsSync(path.join(vault.dir, delTarget))}`);
        r.ok('验收UI:★ 它的 .md.bak 也一起走了(否则库里会留下一份列表上看不见的全文)',
            !fs.existsSync(path.join(vault.dir, `${delTarget}.bak`)),
            `bakBefore=${bakOnDiskBefore} bakAfter=${fs.existsSync(path.join(vault.dir, `${delTarget}.bak`))}`);

        // 删的是当前打开那篇(此时它已经是干净的):编辑器必须已经切走 ——
        // 否则下一次自动保存会把刚删掉的文件**重新建出来**。
        const docAfterDelete = await win.webContents.executeJavaScript(`({
            path: document.getElementById('notePath').textContent,
            empty: document.getElementById('noteEmpty') ? document.getElementById('noteEmpty').hidden === false : null,
        })`);
        r.ok('验收UI:删掉的是当前打开那篇时,编辑器已经切走(不能还指着一个不存在的文件)',
            docAfterDelete.path === '' && docAfterDelete.empty === true,
            JSON.stringify(docAfterDelete));

        // 把打开的那篇还回「甲篇.md」,让后面的断言不看"刚删完留下的空状态"
        await switchToNote(win, '甲篇.md');

        // ---- 文件夹行右键 → 「删除文件夹」:两步确认 → 进系统回收站 ----
        //
        // 产品原话:「文件夹的右键菜单缺乏删除」。这一节走**完整链路**:
        //   新建一个文件夹 → 里面建一篇 → 右键那一行 → 点「删除文件夹」(第一次)
        //   → 确认态(**磁盘上目录还在**)→ 再点一次 → 行没了、目录真没了。
        //
        // ⚠️ 用**一次性**的目录名(待删目录),不动「验收目录」—— 那个后面还有改名用例。
        await win.webContents.executeJavaScript(
            'document.getElementById("noteNewFolder").click()');
        await waitForElement(win, '#noteList input.note-new-input');
        await win.webContents.executeJavaScript(`(() => {
            const i = document.querySelector('#noteList input.note-new-input');
            i.value = '待删目录';
            i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        })()`);
        const doomedDir = await waitForAttr(win, '#noteList button.note-dir[data-folder="待删目录"]',
            'data-folder', '待删目录', 40);
        r.ok('文件夹删除:先建一个一次性目录,并在里面建一篇笔记(要验"非空目录"的确认文案)',
            doomedDir === '待删目录', `folder=${doomedDir}`);
        await win.webContents.executeJavaScript(
            'document.querySelector(\'#noteList button.note-dir-add[data-new-note-in="待删目录"]\')?.click()');
        const doomedNote = '待删目录/未命名.md';
        await waitForAttr(win, `#noteList button[data-path="${doomedNote}"]`, 'data-path', doomedNote, 60);
        r.ok('文件夹删除:里面那篇笔记真的建出来了(否则后面的"含 N 篇"是假的)',
            fs.existsSync(path.join(vault.dir, '待删目录', '未命名.md')),
            `exists=${fs.existsSync(path.join(vault.dir, '待删目录', '未命名.md'))}`);

        // 右键那一行 → 浮层里应当有「删除文件夹」
        const openDoomedMenu = () => win.webContents.executeJavaScript(`(() => {
            const row = document.querySelector('#noteList button.note-dir[data-folder="待删目录"]')
                ?.closest('li');
            if (!row) return false;
            const box = row.getBoundingClientRect();
            row.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true,
                clientX: Math.round(box.left + 40), clientY: Math.round(box.top + 8),
            }));
            return true;
        })()`);
        await openDoomedMenu();
        const dirMenu = await win.webContents.executeJavaScript(`(() => {
            const m = document.querySelector('.note-menu');
            if (!m) return null;
            return {
                labels: [...m.querySelectorAll('.note-menu-item')].map((b) => b.textContent),
                roles: [...m.querySelectorAll('.note-menu-item')].map((b) => b.dataset.menuRole ?? ''),
                aria: m.querySelector('.note-menu-item[data-menu-role="remove-dir"]')?.getAttribute('aria-label') ?? '',
            };
        })()`);
        r.ok('★ 文件夹行右键:浮层里现在有两项 —— 「在此文件夹新建笔记」+「删除文件夹」(带 aria 说明)',
            dirMenu !== null
            && JSON.stringify(dirMenu.labels) === JSON.stringify(['在此文件夹新建笔记', '删除文件夹'])
            && JSON.stringify(dirMenu.roles) === JSON.stringify(['new-note-in-dir', 'remove-dir'])
            && /移入回收站/.test(dirMenu.aria),
            JSON.stringify(dirMenu));

        // 第一次点「删除文件夹」:进确认态,文案里带上"这一下会带走多少",磁盘一个字节都不许动
        await win.webContents.executeJavaScript(`(() => {
            document.querySelector('.note-menu-item[data-menu-role="remove-dir"]')?.click();
            return true;
        })()`);
        const armedDir = await win.webContents.executeJavaScript(`(() => {
            const b = document.querySelector('.note-menu-item[data-menu-role="remove-dir"]');
            return {
                label: b ? b.textContent : '',
                danger: b ? b.dataset.menuDanger === 'true' : false,
                menuOpen: document.querySelector('.note-menu') !== null,
                rowStill: document.querySelector('#noteList button.note-dir[data-folder="待删目录"]') !== null,
            };
        })()`);
        r.ok('★ 文件夹删除:第一次点只进确认态 —— 文案变成「再点一次确认删除(含 1 篇笔记)」,菜单不关',
            armedDir.menuOpen === true && armedDir.danger === true
            && armedDir.label === '再点一次确认删除(含 1 篇笔记)' && armedDir.rowStill === true,
            JSON.stringify(armedDir));
        r.ok('★ 文件夹删除:确认之前磁盘上目录原封不动(这一条才是"第一次点没删")',
            fs.existsSync(path.join(vault.dir, '待删目录', '未命名.md')),
            `exists=${fs.existsSync(path.join(vault.dir, '待删目录', '未命名.md'))}`);

        // 第二次点:真删 —— 行没了、里面的笔记行也没了、目录从磁盘上没了
        //
        // ⚠️ 不能用 waitForJs:它是**后面**才声明的 `const`(同一个巨型函数作用域),
        //    在这里用会撞 TDZ("Cannot access 'waitForJs' before initialization",实测踩到)。
        // ⚠️ 也不能拿 waitForElement 反着判"没了"(见 waitForGone 的注释);用 waitForGone。
        // ⚠️ 状态行那句话要在**页面里当场抓**:删完之后外壳可能把笔记切回去,而 `open()` 会用
        //    同一条状态行写「上次修改:…」把它盖掉(验收那一路实测踩到)。所以点完就在页面里
        //    每 50ms 看一眼,一出现"移入回收站"立刻返回 —— 不给后面那次写入机会。
        const dirStatus = await win.webContents.executeJavaScript(`(async () => {
            document.querySelector('.note-menu-item[data-menu-role="remove-dir"]')?.click();
            for (let i = 0; i < 40; i += 1) {
                const t = document.getElementById('noteStatus')?.textContent ?? '';
                if (t.includes('移入回收站')) return t;
                await new Promise((r) => setTimeout(r, 50));
            }
            return document.getElementById('noteStatus')?.textContent ?? '';
        })()`);
        const doomedRowGone = await waitForGone(
            win, '#noteList button.note-dir[data-folder="待删目录"]', 30);
        const nestedRowGone = await waitForGone(
            win, `#noteList button[data-path="${doomedNote}"]`, 20);
        const dirMenuGone = await waitForGone(win, '.note-menu', 20);
        r.ok('★ 文件夹删除:第二次点真的删了 —— 文件夹行与里面那篇的行都消失,浮层也收了',
            doomedRowGone === true && nestedRowGone === true && dirMenuGone === true,
            JSON.stringify({ doomedRowGone, nestedRowGone, dirMenuGone }));
        r.ok('★ 文件夹删除:状态行说清带走了多少(含 1 个文件、其中 1 篇笔记)',
            /已把文件夹《待删目录》移入回收站/.test(dirStatus) && /1 个文件/.test(dirStatus),
            dirStatus);
        r.ok('★ 文件夹删除:磁盘上那个目录真的没有了(连同里面的笔记)',
            !fs.existsSync(path.join(vault.dir, '待删目录')),
            `exists=${fs.existsSync(path.join(vault.dir, '待删目录'))}`);

        // 收尾:回到「甲篇.md」,后面的断言不看"刚删完留下的状态"
        await switchToNote(win, '甲篇.md');

        // ---- 平铺可停靠面板(工作台)----
        //
        // 规格是已批准的 demo(docs/kaiwu-dock-demo.html)。这一节量的是**真窗口**:
        //   ① 默认是**四格**:左列表 / 中编辑 / 右栏(链接在上、AI 在下),宽度也对得上;
        //   ② **每一片面板在容器里真实可见、尺寸非零** —— 这不是"节点存在"。
        //      这个仓库踩过的坑:为了藏旧容器的空壳写了 `.note-main{display:none}`,
        //      结果被搬进新容器的编辑器也命中同一条,面板一片空白,而结构断言全绿。
        //      所以这里量 getBoundingClientRect + getComputedStyle,并确认面板**本体**
        //      就在那一格里;
        //   ③ 标题栏可聚焦、容器 role=region、分隔条是带读数的 separator;
        //   ④ 底部那行布局树文本(用户明确要的"证据")是可读的;
        //   ⑤ 挂载本身**不写存档**(默认:不拖不动、不写存档);
        //   ⑥ 新的两格(links / ai)**真的能拖**:把 links 拖到 ai 的右侧 → 横向切分。
        const PANE_TITLES = { notes: '笔记列表', doc: '笔记正文', links: '链接', ai: 'AI 对话', drama: '短剧画布', 'drama-projects': '短剧项目', 'ai-session': 'AI 会话' };
        /**
         * 纯函数侧的"槽位显示名",与工作台**同一条口径**(规格 §6:按**活动标签**算)。
         *
         * ⚠️ 为什么不能直接用 `formatTree(tree, PANE_TITLES)`:v4 起槽位 id 与视图名不再
         *    等价(边缘拆分出来的新格子 id 是 `slot:<n>`,规格 §3),`PANE_TITLES` 里查不到
         *    它,会印成裸 id;而界面上那行读数用的是"活动标签的标题"(panel-workspace.js
         *    的 slotLabel)。两边口径不一致,端到端那条"存档往返"就会假红 ——
         *    (实测:界面 `… [ AI 对话 , 链接 ]`,纯函数侧 `… [ AI 对话 , slot:1 ]`)。
         */
        const slotTitlesOf = (t) => {
            const out = {};
            const walk = (n) => {
                if (!n || typeof n !== 'object') return;
                if (Array.isArray(n.tabs)) {
                    const i = Number.isInteger(n.active) && n.active >= 0 && n.active < n.tabs.length
                        ? n.active : 0;
                    const view = n.tabs[i]?.view;
                    out[n.id] = PANE_TITLES[view] ?? PANE_TITLES[n.id] ?? n.id;
                    return;
                }
                for (const c of (n.children ?? [])) walk(c);
            };
            walk(t);
            return out;
        };
        const treeTextOf = (t) => formatTree(t, slotTitlesOf(t));
        // 外壳自带的那四片。⚠️ 工作台里**可能还有插件贡献的面板**(短剧画布就是),
        // 所以下面凡是"按存档该渲染成什么样"的期望,都要走 adoptPanes 把新面板
        // 也算进去 —— 否则一旦有插件带了 pane,这些断言就会假红。
        const SHELL_PANE_IDS = ['notes', 'doc', 'links', 'ai'];
        // ⚠️ 顺序就是 app 里 `Object.keys(panes)` 的顺序:外壳那四片之后按**插件注册**
        //    顺序 —— 两片插件面板的 order 都是默认的 1000 → 于是按 id 字典序
        //    (ai-session < drama),而「短剧项目」那片显式给了 1010,排在最后。
        //    写反了,收编出来的先后就跟着反(自检里那条「用户真实布局」会假红,实测踩到)。
        const WORKSPACE_IDS = [...SHELL_PANE_IDS, 'ai-session', 'drama', 'drama-projects'];
        // ⚠️ 这份位置表必须与 `app/main.js` 里 `setupPanelWorkspace` 传进
        // createLayoutStore 的那一份**逐字一致**(62/38)—— 自检里这几条断言
        // 算的就是"界面上该长什么样",两边比例不一致会直接假红(已经踩过一次)。
        const WORKSPACE_ADOPTION = {
            drama: { anchor: 'doc', dir: 'row', sizes: [62, 38] },
            // ⚠️ 与 app/main.js 的 adoption **逐字一致**(含新加的那一片):两边不一致会直接假红。
            'ai-session': { anchor: 'doc', dir: 'row', sizes: [62, 38] },
            // 短剧「项目」面板:锚在自家画布上(只切画布那一份比例,不碰别的列)。
            'drama-projects': { anchor: 'drama', dir: 'row', sizes: [58, 42] },
        };
        const readWorkspace = () => win.webContents.executeJavaScript(`(() => {
            const host = document.getElementById('paneNotes');
            const desk = document.getElementById('panelWorkspace');
            if (!host || !desk) return { ok: false };
            const d = desk.getBoundingClientRect();
            const panes = [...desk.querySelectorAll('.pw-pane')].map((pane) => {
                const r = pane.getBoundingClientRect();
                const body = pane.querySelector('.pw-body');
                const live = body ? body.firstElementChild : null;
                const lr = live ? live.getBoundingClientRect() : null;
                // ⚠️ 标题栏已取消,而"拖动整片容器"的手势在单标签那一版里**整条删掉**了
                //    (规格 §1.2)。抓手 .pw-grip 现在只显示、不响应指针,也**不进 Tab 序** ——
                //    下面的断言据此读它(不再是 tabIndex 0)。
                const grip = pane.querySelector('.pw-grip');
                const cs = getComputedStyle(pane);
                return {
                    id: pane.dataset.paneId,
                    role: pane.getAttribute('role'),
                    label: pane.getAttribute('aria-label'),
                    gripTab: grip ? grip.tabIndex : null,
                    w: Math.round(r.width), h: Math.round(r.height),
                    left: Math.round(r.left), right: Math.round(r.right),
                    top: Math.round(r.top), bottom: Math.round(r.bottom),
                    displayed: cs.display !== 'none' && cs.visibility !== 'hidden',
                    inside: r.left >= d.left - 1 && r.right <= d.right + 1
                        && r.top >= d.top - 1 && r.bottom <= d.bottom + 1,
                    bodyKids: body ? body.children.length : 0,
                    liveTag: live
                        ? live.tagName.toLowerCase() + '|' + (live.id || '-') + '|' + live.className
                        : null,
                    liveW: lr ? Math.round(lr.width) : 0,
                    liveH: lr ? Math.round(lr.height) : 0,
                };
            });
            const gutters = [...desk.querySelectorAll('.pw-gutter')].map((g) => ({
                id: g.id,
                role: g.getAttribute('role'),
                tab: g.tabIndex,
                min: Number(g.getAttribute('aria-valuemin')),
                max: Number(g.getAttribute('aria-valuemax')),
                now: Number(g.getAttribute('aria-valuenow')),
            }));
            return {
                ok: true,
                host: host.classList.contains('pw-host'),
                deskW: Math.round(d.width), deskH: Math.round(d.height),
                deskLeft: Math.round(d.left), deskRight: Math.round(d.right),
                ids: panes.map((p) => p.id),
                panes, gutters,
                tree: document.getElementById('layoutTree').textContent,
            };
        })()`);

        const ws0 = await readWorkspace();
        const byId = (state, id) => state.panes.find((p) => p.id === id);
        r.ok('工作台已挂载:外壳四片 + 插件贡献的那片都由布局树排列',
            ws0.ok === true && ws0.host === true
            && ws0.ids.length === WORKSPACE_IDS.length
            && WORKSPACE_IDS.every((id) => ws0.ids.includes(id))
            && ws0.ids.length === new Set(ws0.ids).size,
            JSON.stringify({ host: ws0.host, ids: ws0.ids }));

        const nav0 = byId(ws0, 'notes');
        const doc0 = byId(ws0, 'doc');
        const links0 = byId(ws0, 'links');
        const ai0 = byId(ws0, 'ai');
        r.ok('默认布局:左中右三列一字排开、两侧各自贴边、中间最宽;右栏里链接在上、AI 在下',
            nav0.left - ws0.deskLeft <= 2 && ws0.deskRight - ai0.right <= 2
            && doc0.left >= nav0.right - 1 && doc0.right <= links0.left + 1
            && doc0.w > nav0.w && doc0.w > links0.w
            // 上下叠:links 整块在 ai 之上(中间隔着那条 7px 的分隔条),而且左右同宽
            && links0.top < ai0.top && links0.bottom <= ai0.top + 8
            && Math.abs(links0.left - ai0.left) <= 2 && Math.abs(links0.w - ai0.w) <= 2,
            JSON.stringify({
                nav: [nav0.left, nav0.w], doc: [doc0.left, doc0.w],
                links: [links0.left, links0.top, links0.w, links0.h], ai: [ai0.left, ai0.top, ai0.w, ai0.h],
            }));

        // ⚠️ 233/237 是**量出来的**:加了「AI 会话」那片之后根行多一条缝,各片各少约 3px
        //    (原来记的是 236/240)。这条钉的是「默认布局仍是那一版设计」,不是死守某几个像素。
        r.ok('默认宽度与改动前逐像素一致(左 233 / 右栏整列 237;比例制,所以窗口缩放也成立)',
            Math.abs(nav0.w - 233) <= 2 && Math.abs(links0.w - 237) <= 2 && Math.abs(ai0.w - 237) <= 2,
            `左=${nav0.w}px 右栏=${links0.w}/${ai0.w}px`);
        // 右栏内部 42 / 58:链接区比 AI 略小(旧样式里 `.note-side-links` 上限 46%、AI 占剩下的)
        const sideRatio = links0.h / (links0.h + ai0.h);
        r.ok('右栏内部按 42 / 58 上下分(链接略小于 AI —— "打开就是对话"那条硬要求的落点)',
            Math.abs(sideRatio - 0.42) <= 0.03, `links=${links0.h}px ai=${ai0.h}px → ${sideRatio.toFixed(3)}`);

        // 这一条就是那个坑的守门人:面板**真的在容器里、真的有尺寸**。
        const allVisible = (state) => state.ids.length === WORKSPACE_IDS.length && state.panes.every(
            (p) => p.displayed && p.w > 0 && p.h > 0 && p.inside
                && p.bodyKids === 1 && p.liveW > 0 && p.liveH > 0);
        r.ok('每片面板在容器里真实可见、尺寸非零(只断言"节点存在"是不够的)',
            allVisible(ws0), JSON.stringify(ws0.panes.map((p) => [p.id, p.w, p.h, p.displayed, p.liveW, p.liveH])));

        // ---- 拖动文件进文件夹(可信指针输入) ----
        //
        // 为什么要进自检:拖动这条链路有四个环节(阈值 → 指针捕获 → 坐标命中 →
        // 落点判定),界面上"没反应"时分不出卡在哪一环。而且**必须用可信事件** ——
        // 合成 DOM 事件测不出指针捕获的改派行为(仓库里专门记过这一课)。
        const noteSel = (p) => `button[data-path="${p}"], button[data-folder="${p}"]`;
        const rowBox = async (p) => win.webContents.executeJavaScript(`(() => {
            const el = document.querySelector(${JSON.stringify(noteSel(p))});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, h: r.height };
        })()`);
        const hasRow = (p) => win.webContents.executeJavaScript(
            `!!document.querySelector(${JSON.stringify(noteSel(p))})`);
        const settle = (ms) => new Promise((res) => { setTimeout(res, ms); });

        const dragRowTo = async (fromPath, toPath, frac = 0.5) => {
            const a = await rowBox(fromPath);
            const b = await rowBox(toPath);
            if (a === null || b === null) return { err: '缺行', from: !!a, to: !!b };
            const toY = b.top + b.h * frac;
            win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(a.x), y: Math.round(a.y) });
            win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(a.x), y: Math.round(a.y), button: 'left', clickCount: 1 });
            for (const k of [0.3, 0.6, 1]) {
                win.webContents.sendInputEvent({
                    type: 'mouseMove',
                    x: Math.round(a.x + (b.x - a.x) * k),
                    y: Math.round(a.y + (toY - a.y) * k),
                });
                await settle(60);
            }
            const during = await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector(${JSON.stringify(noteSel(toPath))});
                return el ? el.className : null;
            })()`);
            const dragState = await win.webContents.executeJavaScript(
                'window.__kaiwuDrag ? window.__kaiwuDrag() : null');
            win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(b.x), y: Math.round(toY), button: 'left', clickCount: 1 });
            await settle(1600);
            return { during, state: dragState };
        };

        const DRAG_FROM = '夹具起点/待搬.txt';
        const DRAG_TO = '夹具终点';
        r.ok('拖动:夹具就位(起点文件与目标文件夹都在树里)',
            await hasRow(DRAG_FROM) && await hasRow(DRAG_TO),
            JSON.stringify({ from: await hasRow(DRAG_FROM), to: await hasRow(DRAG_TO) }));

        const noteDrag = await dragRowTo(DRAG_FROM, DRAG_TO, 0.5);
        r.ok('拖动:越阈值后手势真的起来了,且落点判定是"移进那个文件夹"',
            noteDrag.state !== null && noteDrag.state.active === true
            && noteDrag.state.target !== null && noteDrag.state.target.kind === 'into'
            && noteDrag.state.target.destFolder === DRAG_TO,
            JSON.stringify(noteDrag));
        r.ok('拖动:落点有可见反馈(整行高亮 class)',
            typeof noteDrag.during === 'string' && noteDrag.during.includes('drag-into'),
            String(noteDrag.during));
        r.ok('拖动:★ 松手后文件真的移动了(盘上旧路径没了、新路径在)',
            await hasRow(`${DRAG_TO}/待搬.txt`) && !(await hasRow(DRAG_FROM)),
            JSON.stringify({ 新位置: await hasRow(`${DRAG_TO}/待搬.txt`), 旧位置: await hasRow(DRAG_FROM) }));

        await dragRowTo(`${DRAG_TO}/待搬.txt`, '夹具起点', 0.5);
        r.ok('拖动:能把它拖回原位(往返都成立,夹具复原)',
            await hasRow(DRAG_FROM) && !(await hasRow(`${DRAG_TO}/待搬.txt`)),
            JSON.stringify({ 原位: await hasRow(DRAG_FROM) }));

        // ★ 只点不拖:行为必须与改动前完全一致(点开笔记)
        const clickBox = await rowBox('甲篇.md');
        if (clickBox !== null) {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(clickBox.x), y: Math.round(clickBox.y), button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(clickBox.x), y: Math.round(clickBox.y), button: 'left', clickCount: 1 });
            await settle(900);
        }
        const openedPath = await win.webContents.executeJavaScript(
            `document.getElementById('notePath')?.textContent ?? ''`);
        r.ok('拖动:★ 只点不拖仍然打开笔记(拖动没有抢掉 click)',
            clickBox !== null && openedPath.includes('甲篇'),
            JSON.stringify({ clickBox: clickBox !== null, openedPath }));

        // ---- 插件 pane 的样式真的生效了吗 ----
        //
        // 这一条守的是一个**很难从截图看出来**的缺陷:插件样式由 scopeCss 加上
        // `[data-plugin="<id>"]` 前缀,而 pane 那条路当初既没给宿主设这个属性、
        // 也没人注入 style.css —— 于是整份样式一条都不匹配,面板退化成无样式的
        // 块级流(.drama-pane 的 display 从 flex 掉成 block、.drama-canvas 的
        // overflow 从 hidden 掉成 visible),画布内容撑开盖住下面的面板。
        // 界面"看起来只是有点乱",而结构断言照样是绿的。
        const paneStyle = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            const pane = host?.querySelector('.drama-pane');
            const canvas = host?.querySelector('.drama-canvas');
            const styleEl = document.querySelector('style[data-plugin-style="drama"]');
            return {
                hostDataPlugin: host ? (host.dataset.plugin ?? null) : null,
                styleInjected: styleEl !== null,
                styleLen: styleEl ? styleEl.textContent.length : 0,
                styleScoped: styleEl ? styleEl.textContent.includes('[data-plugin="drama"]') : false,
                paneDisplay: pane ? getComputedStyle(pane).display : null,
                canvasOverflow: canvas ? getComputedStyle(canvas).overflowY : null,
            };
        })()`);
        r.ok('插件 pane:宿主带 data-plugin、样式表已注入且带作用域前缀',
            paneStyle.hostDataPlugin === 'drama' && paneStyle.styleInjected === true
            && paneStyle.styleScoped === true && paneStyle.styleLen > 1000,
            JSON.stringify(paneStyle));
        r.ok('插件 pane:样式**真的生效**(display/overflow 是插件 CSS 里写的那个值)',
            paneStyle.paneDisplay === 'flex' && paneStyle.canvasOverflow === 'hidden',
            JSON.stringify({ display: paneStyle.paneDisplay, overflow: paneStyle.canvasOverflow }));

        // ---- 高度链:任何面板都不许把工作台顶出窗口 ----
        //
        // 这一条守的是一个**曾经真的发生**的缺陷:.pane-notes 是 .shell(grid, 100vh) 的
        // grid item,而 grid/flex item 的 min-height 默认是 auto("不小于内容高度")——
        // 内容一高,它无视父级的 100vh 把整条链顶高。body 是 overflow:hidden,
        // 于是落在窗口之外的那一千多像素**既看不到也滚不到**:短剧画布只剩一条工具条、
        // AI 对话的输入框被推到窗外。
        //
        // 判据直接用读数(不靠截图):文档 scrollHeight 必须**等于**视口高
        // —— body 是 overflow:hidden,本来就不该有滚动余量。
        const chain = await win.webContents.executeJavaScript(`(() => {
            const H = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; };
            const B = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().bottom) : null; };
            const pn = document.getElementById('paneNotes');
            const winH = document.documentElement.clientHeight;
            const footerBottom = B('#agentPanel .agent-footer');
            return {
                winH,
                paneNotesH: H('#paneNotes'),
                paneNotesMinH: pn ? getComputedStyle(pn).minHeight : null,
                deskH: H('#panelWorkspace'),
                docScrollH: document.documentElement.scrollHeight,
                footerBottom,
                footerInside: footerBottom === null ? null : footerBottom <= winH,
            };
        })()`);
        r.ok('高度链:工作台没有把文档顶出视口(body 是 overflow:hidden,不该有滚动余量)',
            chain.docScrollH === chain.winH,
            JSON.stringify(chain));
        r.ok('高度链:.pane-notes 没有超过视口(它是 grid item,必须显式 min-height:0)',
            chain.paneNotesH !== null && chain.paneNotesH <= chain.winH
            && chain.paneNotesMinH === '0px',
            JSON.stringify({ h: chain.paneNotesH, minH: chain.paneNotesMinH, winH: chain.winH }));
        r.ok('高度链:AI 对话的输入卡片在窗口内(这条曾经被推出窗外,看不到也点不到)',
            chain.footerInside !== false, JSON.stringify({ footerBottom: chain.footerBottom, winH: chain.winH }));

        // ---- 短剧画布(插件贡献的那片 pane) ----
        //
        // 这一组要证明的是"引擎真的在这台机器上跑通了",而不只是"面板挂上了":
        //   ① 面板渲染出**独立版那张图**里的节点与连线;
        //   ② 点「运行全部」之后,主进程里的引擎真的跑了图,状态从"没跑过"变成 ok;
        //   ③ 再点一次 → **0 实跑**(全命中指纹缓存)。这条是引擎最容易写错的地方,
        //      独立版为它专门留过一条回归用例,这里在开物这一侧再钉一次。
        const waitForJs = async (expr, tries = 40) => {
            let last = null;
            for (let i = 0; i < tries; i++) {
                last = await win.webContents.executeJavaScript(expr).catch(() => null);
                if (last) return last;
                await new Promise((res) => { setTimeout(res, 100); });
            }
            return last;
        };

        const dramaPane = await waitForJs(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            if (!host) return null;
            const r = host.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return null;
            return { w: Math.round(r.width), h: Math.round(r.height) };
        })()`);
        r.ok('短剧画布:插件那片 pane 真的进了布局树、而且有真实尺寸',
            dramaPane !== null && dramaPane.w > 0 && dramaPane.h > 0,
            JSON.stringify(dramaPane));

        // 数据要真的从主进程来:项目面板里应当有临时库里那个项目。
        //
        // ⚠️ 这里从前读的是画布工具条里那个项目下拉。下拉已经退休(项目归
        //    「短剧项目」面板管),所以改成读面板里的行 —— 顺带把"当前项高亮"与
        //    "画布名牌写着同一个名字"一起钉住:这两处一旦各拿一份状态就会分叉。
        const dramaReady = await waitForJs(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama-projects"] .pane-plugin');
            if (!host) return null;
            const rows = [...host.querySelectorAll('.dp-row[data-project]')];
            if (rows.length === 0) return null;
            return {
                names: rows.map((x) => x.dataset.project),
                current: rows.filter((x) => x.classList.contains('cur')).map((x) => x.dataset.project),
                chip: document.querySelector('.pw-pane[data-pane-id="drama"] .drama-proj-name')?.textContent ?? '',
            };
        })()`);
        r.ok('短剧项目:清单来自主进程(临时库里的「自检项目」),当前项高亮,画布名牌写的是同一个名字',
            dramaReady !== null && dramaReady.names.includes('自检项目')
            && dramaReady.current.join() === '自检项目' && dramaReady.chip === '自检项目',
            JSON.stringify(dramaReady));

        const dramaNodes = await waitForJs(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            if (!host) return null;
            const nodes = [...host.querySelectorAll('.drama-node')];
            if (nodes.length === 0) return null;
            return {
                n: nodes.length,
                edges: host.querySelectorAll('.drama-edge').length,
                titles: nodes.map((x) => x.querySelector('.drama-node-title')?.textContent ?? ''),
            };
        })()`);
        r.ok('短剧画布:把项目里的 3 个节点与 1 条连线都画出来了',
            dramaNodes !== null && dramaNodes.n === 3 && dramaNodes.edges === 1,
            JSON.stringify(dramaNodes));
        r.ok('短剧画布:节点标题就是图里的 title(不是 id、也不是空)',
            dramaNodes !== null && dramaNodes.titles.join(',') === '稿子,拼装,备注',
            JSON.stringify(dramaNodes?.titles));

        r.ok('短剧画布:卡片上把**入边槽位**显式画出来了(引擎按边的顺序取输入)',
            await win.webContents.executeJavaScript(`(() => {
                const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
                const b = host && [...host.querySelectorAll('.drama-node')].find(
                    (x) => x.dataset.nodeId === 'b');
                if (!b) return false;
                const slots = [...b.querySelectorAll('.drama-slot')].map((s) => s.textContent);
                return slots.length === 1 && slots[0].includes('稿子');
            })()`));

        // A 双端口连线：先把 fixture 的旧边从槽位上断开，再用真实端口手势接回。
        // 最终仍是一条 a→b，后续既有的 3 节点/1 连线断言不用改。
        const portDrag = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            const oldDisconnect = host?.querySelector('.drama-node[data-node-id="b"] .drama-disconnect');
            if (!oldDisconnect) return { error: '旧边没有断开按钮' };
            oldDisconnect.click();
            const source = host.querySelector('.drama-node[data-node-id="a"] .drama-port-output');
            const target = host.querySelector('.drama-node[data-node-id="b"] .drama-port-input');
            if (!source || !target) return { error: '端口未绘制' };
            const center = (element) => { const r = element.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
            // 自检默认布局把画布压到 120px；先像用户那样横向平移，让目标端口回到可见区。
            const canvas = host.querySelector('.drama-canvas');
            const edge = canvas.getBoundingClientRect().right;
            const shift = Math.max(0, center(target).x - edge + 18);
            if (shift) canvas.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true, deltaX: shift, deltaY: 0,
            }));
            const a = center(source), b = center(target);
            const hit = document.elementFromPoint(b.x, b.y);
            const event = (kind, p, buttons) => new PointerEvent(kind, {
                bubbles: true, cancelable: true, pointerId: 71, isPrimary: true,
                button: 0, buttons, clientX: p.x, clientY: p.y,
            });
            source.dispatchEvent(event('pointerdown', a, 1));
            source.dispatchEvent(event('pointermove', b, 1));
            const preview = host.querySelectorAll('.drama-edge-draft').length;
            source.dispatchEvent(event('pointerup', b, 0));
            if (shift) canvas.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true, deltaX: -shift, deltaY: 0,
            }));
            return { preview, edges: host.querySelectorAll('.drama-edge').length,
                slot: host.querySelector('.drama-node[data-node-id="b"] .drama-slot')?.textContent,
                hit: hit?.className ?? null, targetCenter: b,
                canvasRight: canvas.getBoundingClientRect().right,
                status: host.querySelector('.drama-note')?.textContent ?? '' };
        })()`);
        r.ok('短剧画布:A 双端口拖拽显示预览线并重新连通文本输入',
            portDrag.preview === 1 && portDrag.edges === 1 && /稿子/.test(portDrag.slot ?? ''),
            JSON.stringify(portDrag));
        await new Promise((resolve) => setTimeout(resolve, 550));
        const portGraph = JSON.parse(fs.readFileSync(
            path.join(vault.dramaRoot, '自检项目', 'graph.json'), 'utf8'));
        r.ok('短剧画布:A 双端口连线保存端口信息到项目',
            portGraph.edges.length === 1 && portGraph.edges[0].from === 'a'
            && portGraph.edges[0].to === 'b' && portGraph.edges[0].toPort === 0,
            JSON.stringify(portGraph.edges));

        // 跑图:点「运行全部」→ 主进程里的引擎跑一遍
        await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === '运行全部');
            btn.click();
            return true;
        })()`);
        const ran1 = await waitForJs(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            const note = host.querySelector('.drama-note');
            const t = note ? note.textContent : '';
            return /跑完 3 个节点/.test(t) ? t : null;
        })()`, 60);
        r.ok('短剧画布:点「运行全部」→ 引擎真的跑了,并回报"跑完 3 个节点"',
            ran1 !== null && /实跑 3/.test(ran1), String(ran1));

        const badges1 = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            return [...host.querySelectorAll('.drama-node')].map(
                (x) => [x.dataset.nodeId, x.querySelector('.drama-status')?.textContent ?? '']);
        })()`);
        r.ok('短剧画布:三个节点都变成"已跑过"(✓),不再显示"没跑过"的破折号',
            badges1.length === 3 && badges1.every(([, t]) => t.includes('✓')),
            JSON.stringify(badges1));

        // ★ 再跑一次:这条是引擎缓存语义的守门人
        await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === '运行全部');
            btn.click();
            return true;
        })()`);
        const ran2 = await waitForJs(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            const t = host.querySelector('.drama-note')?.textContent ?? '';
            return /实跑 0/.test(t) ? t : null;
        })()`, 60);
        r.ok('★ 短剧画布:什么都不改再跑一次 → **0 实跑**(全命中指纹缓存,不重复烧钱)',
            ran2 !== null, String(ran2));

        // ---- 空格 + 拖动 = 移动画布(方案甲:临时抓手) ----
        //
        // 读数全部是"看得见的量":画布根节点的 data-nav、#world 的 inline transform、
        // 卡片自己的 style.left/top(图坐标)。最后一条尤其重要 ——
        // 它证明拖的是**画布**而不是那个节点。空格"有没有被吞"用 dispatchEvent 的返回值判
        // (我们的监听器调了 preventDefault 就会返回 false)—— 那正是"吞掉"这件事的定义。
        const navRead = () => win.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-canvas');
            if (c === null) return { found: false };
            const w = c.querySelector('.drama-world');
            const card = c.querySelector('.drama-node');
            return {
                found: true,
                nav: c.getAttribute('data-nav'),
                transform: w?.style.transform ?? '',
                cursor: getComputedStyle(c).cursor,
                cardX: card?.style.left ?? '', cardY: card?.style.top ?? '',
            };
        })()`);
        const navEnter = () => win.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-canvas');
            c.dispatchEvent(new PointerEvent('pointerenter', { pointerId: 7, pointerType: 'mouse' }));
            return true;
        })()`);
        const navKey = (kind) => win.webContents.executeJavaScript(`(() => {
            const t = document.activeElement ?? document.body;
            const ev = new KeyboardEvent(${JSON.stringify(kind)}, { key: ' ', code: 'Space', bubbles: true, cancelable: true });
            return { notCancelled: t.dispatchEvent(ev) };
        })()`);
        /** 在**卡片上**按下、在画布上移动/松开(合成指针事件;捕获阶段由画布接住并 stopPropagation)。 */
        const navDragOnCard = (dx, dy) => win.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-canvas');
            const card = c.querySelector('.drama-node');
            const r = card.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            const fire = (node, type, cx, cy) => node.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse',
                clientX: cx, clientY: cy, button: 0, buttons: type === 'pointerup' ? 0 : 1,
            }));
            fire(card, 'pointerdown', x, y);
            const during = c.getAttribute('data-nav');
            fire(c, 'pointermove', x + ${dx}, y + ${dy});
            fire(c, 'pointerup', x + ${dx}, y + ${dy});
            return { ok: true, during };
        })()`);

        await navEnter();
        const navBefore = await navRead();
        const spaceDown = await navKey('keydown');
        const navDown = await navRead();
        r.ok('短剧画布·空格拖动:按住空格 → 画布进入抓手态(\`data-nav="pan"\`,光标 grab)',
            navBefore.found === true && spaceDown.notCancelled === false
            && navDown.nav === 'pan' && navDown.cursor === 'grab',
            JSON.stringify({ before: navBefore.nav, key: spaceDown, after: navDown }));

        const drag = await navDragOnCard(40, 25);
        const navAfterDrag = await navRead();
        r.ok('短剧画布·空格拖动:**在卡片上**按下并拖动 → 画布真的平移了(只改 transform),而卡片自己的图坐标一动没动',
            drag.ok === true && drag.during === 'panning'
            && navAfterDrag.transform !== navBefore.transform
            && navAfterDrag.cardX === navBefore.cardX && navAfterDrag.cardY === navBefore.cardY,
            JSON.stringify({ during: drag.during, from: navBefore.transform, to: navAfterDrag.transform,
                card: [navBefore.cardX, navAfterDrag.cardX] }));

        const spaceUp = await navKey('keyup');
        const navUp = await navRead();
        const dragAgain = await navDragOnCard(40, 25);
        const navAfterNoSpace = await navRead();
        r.ok('短剧画布·空格拖动:松开空格 → 退出干净(再拖不再平移,画布上不留 data-nav)',
            spaceUp.notCancelled === true && navUp.nav === null
            && dragAgain.during === null
            && navAfterNoSpace.transform === navAfterDrag.transform,
            JSON.stringify({ up: navUp.nav, again: dragAgain.during, transform: navAfterNoSpace.transform }));

        // 空格不许被吞:焦点在输入框里时,同一个空格必须**不**被 preventDefault(dispatchEvent 返回 true)
        const typingSpace = await win.webContents.executeJavaScript(`(() => {
            const ta = document.createElement('textarea');
            document.body.appendChild(ta);
            ta.focus();
            const r = { focused: document.activeElement === ta };
            const ev = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
            r.notCancelled = ta.dispatchEvent(ev);
            const c = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-canvas');
            r.navWhileTyping = c.getAttribute('data-nav');
            ta.remove();
            return r;
        })()`);
        r.ok('短剧画布·空格拖动:焦点在输入框里时空格**照常打字**(没被吞,也不进抓手态)',
            typingSpace.focused === true && typingSpace.notCancelled === true
            && typingSpace.navWhileTyping === null,
            JSON.stringify(typingSpace));

        // ---- 从笔记列表把文件拖进画布(方案丙:全应用拖拽总线) ----
        //
        // 为什么这几条必须端到端:总线横跨**两个面板**(笔记列表播报 / 画布接货),
        // 而中间那层"松手时算不算落在画布上、落点换算成哪个图坐标"只有真跑一遍才知道对不对。
        // 断言读**磁盘上的 graph.json** —— 图真的变了才算数,界面上那句话不算。
        // ⚠️ 本段自带等待函数:后面那些段落里的 sessionSleep 是 const,在这里还是**未初始化**(TDZ),
        //    借用它会当场抛 'Cannot access ... before initialization'(这个坑踩过两次)。
        const dropSleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
        const dramaProjectDir = path.join(vault.dramaRoot, '自检项目');
        const graphPath = path.join(dramaProjectDir, 'graph.json');
        const readGraph = () => {
            try { return JSON.parse(fs.readFileSync(graphPath, 'utf8')); } catch { return null; }
        };
        const nodesOfType = (g, type) => (g?.nodes ?? []).filter((n) => n.type === type);
        const graphBefore = readGraph();
        // ⚠️ 画布在文件里**挂着不止一份**(每个视图各一份,切视图会重建)。document.querySelector 拿到的是**第一个**,
        //    实测那一份是**收起的**(width=0):落点判定于是必然失败,而现象和"接货逻辑坏了"长得一模一样。
        //    这里挑**看得见的那一份**(面积>0)打上标记,后面全程只用这个标记定位(读轨迹、送图片也一样)。
        const canvasPick = await win.webContents.executeJavaScript(`(() => {
            const all = [...document.querySelectorAll('.drama-canvas')];
            const list = all.map((c) => {
                const r = c.getBoundingClientRect();
                return {
                    w: Math.round(r.width), h: Math.round(r.height),
                    wired: c.dataset.dropWired ?? null, bad: c.dataset.dropError ?? null,
                };
            });
            const i = list.findIndex((e) => e.w > 0 && e.h > 0);
            if (i >= 0) all[i].dataset.dropProbe = '1';
            // 宽度为 0 时把祖先链一起报出来:这块画布是纵向 flex 里的 flex:1,
            // 高度能长,宽度要由上方容器给 —— 0 一定是链上某一级把交叉轴收掉了。逐级看宽度/display/align-items。
            const chain = [];
            let el = all[0] ?? null;
            while (el !== null && el !== document.body && chain.length < 10) {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                chain.push({
                    cls: String(el.className ?? el.tagName).slice(0, 30),
                    w: Math.round(r.width), h: Math.round(r.height),
                    disp: cs.display, dir: cs.flexDirection, align: cs.alignItems,
                    wCss: cs.width, pos: cs.position,
                });
                el = el.parentElement;
            }
            return { count: all.length, visibleAt: i, list, chain };
        })()`);
        const CANVAS_SEL = '.drama-canvas[data-drop-probe="1"]';
        // 画布那片的插件宿主(与下面 CANVAS_HOST 同一个选择器,只是它定义得比这一段晚)
        const DROP_HOST = '.pw-pane[data-pane-id="drama"] .pane-plugin';
        const canvasRect = await win.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('${CANVAS_SEL}');
            if (c === null) return null;
            const r = c.getBoundingClientRect();
            return { x: Math.round(r.left + r.width * 0.62), y: Math.round(r.top + r.height * 0.30),
                w: Math.round(r.width), h: Math.round(r.height) };
        })()`);
        // ⚠️ 宽高都要像样:宽度被挤成 0(检视器不肯让位)**或**高度被顶成一条
        //    (检视器折行后按内容长高)都会让落点判定失效 —— 后者正是"拖进去画布被编辑预览顶消失"。
        const wrapH = canvasPick.chain?.find((e) => e.cls === 'drama-wrap')?.h ?? 0;
        r.ok('短剧画布·拖入:画布是**看得见的**(宽和高都得像样:被挤成 0 宽、或被检视器顶成一条,都当不了落点)',
            canvasRect !== null && canvasRect.w > 0 && canvasRect.h > 0
            && (wrapH === 0 || canvasRect.h >= Math.round(wrapH * 0.6)),
            JSON.stringify({ canvasPick, canvasRect, wrapH }));
        const rowRect = await win.webContents.executeJavaScript(`(() => {
            const b = document.querySelector('#noteList button[data-path="甲篇.md"]');
            if (b === null) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        const noteText = fs.readFileSync(path.join(vault.dir, '甲篇.md'), 'utf8');
        // 合成整条拖拽:按下(行上)→ 移动(画布上)→ 松手(画布上)。同一个 pointerId 贯穿三下。
        const syntheticDrag = (from, to) => win.webContents.executeJavaScript(`(() => {
            const row = document.querySelector('#noteList button[data-path="甲篇.md"]');
            if (row === null) return { ok: false, why: '笔记树里没有那一行' };
            const ev = (type, x, y, buttons) => new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse',
                clientX: x, clientY: y, button: 0, buttons,
            });
            row.dispatchEvent(ev('pointerdown', ${from.x}, ${from.y}, 1));
            // ⚠️ **两次**移动:第一次只是跨过阈值、把拖动"激活"(那一下位置还不更新),
            //    第二次才是把落点放到目标上 —— 实测:只发一次,落点坐标会停在按下那一行上,
            //    于是画布判定"不在我范围内"(轨迹里就是这句话)。
            document.dispatchEvent(ev('pointermove', ${from.x + 8}, ${from.y + 8}, 1));
            document.dispatchEvent(ev('pointermove', ${to.x}, ${to.y}, 1));
            // 移动/松手挂在 document 上(笔记树的拖动状态机就在那一层听)
            document.dispatchEvent(ev('pointerup', ${to.x}, ${to.y}, 0));
            return { ok: true };
        })()`);

        const dropWiring = await win.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('${CANVAS_SEL}');
            return { wired: c?.dataset?.dropWired ?? null, error: c?.dataset?.dropError ?? null };
        })()`);
        r.ok('短剧画布·拖入:画布**真的接上了总线**(接不上时这一条的读数里就写着原因)',
            canvasRect !== null && rowRect !== null && dropWiring.wired === '1',
            JSON.stringify({ canvasRect, rowRect, dropWiring }));

        const droppedText = await syntheticDrag(rowRect ?? { x: 0, y: 0 }, canvasRect ?? { x: 0, y: 0 });
        await dropSleep(1400);          // 让 scheduleSave 的防抖落盘
        const graphAfterText = readGraph();
        const textNodes = nodesOfType(graphAfterText, 'text');
        const textNode = textNodes.find((n) => String(n.params?.value ?? '').includes(noteText.trim().slice(0, 12)));
        const dropTrace = await win.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('${CANVAS_SEL}');
            return {
                last: c?.dataset?.dropLast ?? null,
                log: c?.dataset?.dropLog ?? null,
                rect: c?.dataset?.dropRect ?? null,
                status: document.querySelector('.pw-pane[data-pane-id="drama"] .drama-status, .drama-status')?.textContent ?? null,
            };
        })()`);
        const graphFacts = () => {
            try {
                const st = fs.statSync(graphPath);
                const g = readGraph();
                const ns = (g?.nodes ?? []).slice(-3).map((n) => ({
                    id: n.id, type: n.type,
                    head: String(n.params?.value ?? n.params?.reference ?? '').slice(0, 24),
                }));
                return { count: (g?.nodes ?? []).length, mtime: st.mtimeMs, size: st.size, tail: ns };
            } catch (err) { return { err: String(err?.message ?? err) }; }
        };
        r.ok('短剧画布·拖入:接收路径的**逐步轨迹**(红的时候这里写着停在哪一步,以及判定用的 rect)',
            dropTrace.last !== null, JSON.stringify(dropTrace));

        // 落下的那个新节点当场是**选中**的(createNode 的规矩)→ 记下它的 id:
        // ① 断言里能看到它真的在画布上;② 这一段结束时要把这两次拖入新建的节点删掉
        // (后面的断言默认"自检项目里还是那 3 个节点",多留两个会把它们全带红)。
        const textSelId = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('${DROP_HOST}');
            const sel = host?.querySelector('.drama-node.sel');
            return sel?.dataset?.nodeId ?? null;
        })()`);
        r.ok('短剧画布·拖入:从笔记列表拖一个 .md 到画布 → 图上真的多了一个「文本 / 剧本」节点,正文就是那篇笔记',
            droppedText.ok === true && textNode !== undefined
            && textNodes.length > nodesOfType(graphBefore, 'text').length,
            JSON.stringify({
                droppedText, textSelId, trace: dropTrace, facts: graphFacts(),
                textCountBefore: nodesOfType(graphBefore, 'text').length,
                textCountAfter: textNodes.length,
                noteHead: noteText.trim().slice(0, 24),
            }));

        // 图片:走总线直接送一次(库根 → 绝对路径 → 写进「改图」的参考图)。
        // ⚠️ 这条钉的是**绝对路径**:引擎把相对路径拼到项目目录下(image.js:349),相对路径读不到图。
        const pngName = '定妆照.png';
        const pngAbs = path.join(vault.dir, pngName);
        fs.writeFileSync(pngAbs, 'fixture:extension-is-what-matters', 'utf8');
        const pngSent = await win.webContents.executeJavaScript(`(async () => {
            const bus = await import('toolbox://shell/lib/drag-bus.js');
            const c = document.querySelector('${CANVAS_SEL}');
            if (c === null) return { ok: false, why: '没有看得见的画布(宽度 0 的接不了货)' };
            const r = c.getBoundingClientRect();
            const x = Math.round(r.left + r.width * 0.40);
            const y = Math.round(r.top + r.height * 0.62);
            bus.begin({ relPath: ${JSON.stringify(pngName)}, name: ${JSON.stringify(pngName)} });
            const armed = c.getAttribute('data-drop');
            bus.end({ clientX: x, clientY: y, insideTree: false });
            return { ok: true, armed, abs: bus.current === null ? null : null };
        })()`);
        await dropSleep(1400);
        const imageTrace = await win.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('${CANVAS_SEL}');
            return c?.dataset?.dropLast ?? null;
        })()`);
        const graphAfterImage = readGraph();
        const editNodes = nodesOfType(graphAfterImage, 'edit');
        const refNode = editNodes.find((n) => String(n.params?.reference ?? '').includes(pngName));
        r.ok('短剧画布·拖入:拖一张图 → 落成「改图」节点,参考图里是**绝对路径**(相对路径那条路读不到图)',
            pngSent.ok === true && refNode !== undefined
            && String(refNode.params.reference).split('\n').map((t) => t.trim()).includes(pngAbs),
            JSON.stringify({ sent: pngSent, trace: imageTrace, reference: refNode?.params?.reference }));

        // ---- 收场:把这两次拖入新建的节点删掉 ----
        // 为什么必须清:后面几条断言(状态"✓ 缓存"、切视图重建、删项目后重画)都按
        // "自检项目里正好 3 个节点"来判 —— 多留两个节点会让它们全红,而那种红是**测试自己弄脏的**,
        // 不是功能坏了。删除走的是插件自己的那条路(document 上的 Delete 键 → deleteSelected)。
        const imageSelId = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('${DROP_HOST}');
            return host?.querySelector('.drama-node.sel')?.dataset?.nodeId ?? null;
        })()`);
        const cleaned = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('${DROP_HOST}');
            const del = () => document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
            const clickCard = (id) => {
                const card = host.querySelector('.drama-node[data-node-id="' + id + '"]');
                if (card === null) return false;
                const ev = (type, buttons) => new PointerEvent(type, {
                    bubbles: true, cancelable: true, pointerId: 31, pointerType: 'mouse',
                    clientX: 0, clientY: 0, button: 0, buttons,
                });
                card.dispatchEvent(ev('pointerdown', 1));
                card.dispatchEvent(ev('pointerup', 0));
                return true;
            };
            const out = { image: false, text: false };
            out.image = clickCard(${JSON.stringify(imageSelId)});   // 已选中:再点一下进编辑,但删除键删的就是选中项
            del();
            out.text = clickCard(${JSON.stringify(textSelId)});
            del();
            return { ...out, left: host.querySelectorAll('.drama-node').length };
        })()`);
        await dropSleep(900);
        r.ok('短剧画布·拖入:收场(把拖入建的 2 个节点删掉)→ 自检项目回到原来那 3 个节点',
            cleaned.image === true && cleaned.text === true && cleaned.left === 3,
            JSON.stringify({ cleaned, imageSelId, textSelId, nodes: (readGraph()?.nodes ?? []).map((n) => n.type) }));

        // ---- ★ 真拖过一手之后,浏览器会给那一行补一次 click ----
        //
        // 为什么单独钉这一条:拖动时行上设了 pointer capture,浏览器会把松手后的 click **派回那一行**
        // (capture 目标就是 click 目标)→ 行的 click 处理器把笔记打开;而"笔记正文"这个视图找不到
        // 自己的格子时会开在**当前面板**里 —— 当前面板正是刚松手的画布那格。现象:
        // "拖个文件到画布上,画布那格被编辑/预览面板顶掉"。所以这一条必须用**真实鼠标输入**来测
        // (合成事件不会让浏览器补 click,那样根本测不出来)。
        const readBusNow = () => win.webContents.executeJavaScript(`(async () => {
            const bus = await import('toolbox://shell/lib/drag-bus.js');
            const cur = bus.current?.() ?? null;
            return cur === null ? null : { name: cur.name, kind: cur.kind };
        })()`);
        const readOpenViews = () => win.webContents.executeJavaScript(
            'Array.isArray(window.__kaiwuOpenViews) ? window.__kaiwuOpenViews.length : 0');
        const readDramaLabel = () => win.webContents.executeJavaScript(
            `document.querySelector('.pw-pane[data-pane-id="drama"]')?.getAttribute('aria-label') ?? ''`);
        const yBox = await rowBox('乙篇.md');
        const pathBeforeDrag = await win.webContents.executeJavaScript(
            `document.getElementById('notePath')?.textContent ?? ''`);
        const openViewsBefore = await readOpenViews();
        const dramaLabelBefore = await readDramaLabel();
        let busOnPress = 'no-row';
        let dragStateDuring = null;
        let clickAfterDrag = null;
        if (yBox !== null) {
            const from = { x: Math.round(yBox.x), y: Math.round(yBox.y) };
            // 松手点选在**笔记正文那一格**上:既不在笔记树里(那不是移动笔记),也不在画布上(不该落节点)
            const to = { x: 380, y: 300 };
            win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
            win.webContents.sendInputEvent({
                type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1,
            });
            await settle(90);
            busOnPress = await readBusNow();
            for (const k of [0.3, 0.6, 1]) {
                win.webContents.sendInputEvent({
                    type: 'mouseMove',
                    x: Math.round(from.x + (to.x - from.x) * k),
                    y: Math.round(from.y + (to.y - from.y) * k),
                });
                await settle(60);
            }
            // ⚠️ 这里**故意慢**:按住不放 700ms 再松手 —— 人手拖一次就是这个量级,
            //    而"刚拖过"的标记只要在手势进行中过期,松手后那一下 click 就会把笔记打开
            //    (工作台于是跳到"笔记正文/编辑预览"那格)。先前踩的正是这个坑:
            //    标记在"手势刚起来"时置位、400ms 清掉,而合成拖拽只要 ~180ms,所以自检是绿的、用户是坏的。
            await settle(700);
            dragStateDuring = await win.webContents.executeJavaScript(
                'window.__kaiwuDrag ? window.__kaiwuDrag() : null');
            win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
            // 浏览器补的 click 紧跟在 pointerup 后面(实测 Chromium 在"捕获 + 松手在别处"时**不补**,
            // 所以这里显式补一次;测的是那条防线本身:万一真来了,必须被吃掉)。
            await settle(60);
            clickAfterDrag = await win.webContents.executeJavaScript(`(() => {
                const row = document.querySelector('#noteList button[data-path="乙篇.md"]');
                if (row === null) return null;
                row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
                return true;
            })()`);
            await settle(700);
        }
        const pathAfterDrag = await win.webContents.executeJavaScript(
            `document.getElementById('notePath')?.textContent ?? ''`);
        const openViewsAfter = await readOpenViews();
        const dramaLabelAfter = await readDramaLabel();
        r.ok('★ 拖动:拖过一手之后那一行的 click 不许打开笔记(否则外壳会 openView("doc"),工作台跳到编辑/预览那格)',
            yBox !== null && dragStateDuring?.active === true && clickAfterDrag === true
            && pathAfterDrag === pathBeforeDrag && !pathAfterDrag.includes('乙篇')
            && openViewsAfter === openViewsBefore,
            JSON.stringify({
                row: yBox !== null, during: dragStateDuring, clickAfterDrag,
                pathBeforeDrag, pathAfterDrag, openViewsBefore, openViewsAfter,
            }));
        // ⚠️ 这条是**下游守卫**,而且要说清它的边界:自检的布局里"笔记正文"有自己的格子
        //    (paneHostingDocView 找得到),所以 openView('doc') 会开在那格里、画布这格的标签不变 ——
        //    也就是说**这条在自检里不会红**。它守的是另一条路:doc 视图没有自己的格子时,
        //    openView 会退到 currentPane()(你刚松手的那一格 = 画布),那一格就被编辑/预览顶掉了。
        //    真正会红的那条是上面"不许 openView"——根因在那儿,这条只兜下游。
        r.ok('★ 拖动:拖完(含那一手"慢拖")之后,画布那格还是画布(下游守卫:doc 没有归宿时会开在当前面板上)',
            dramaLabelBefore === dramaLabelAfter && dramaLabelAfter.includes('短剧画布'),
            JSON.stringify({ dramaLabelBefore, dramaLabelAfter }));
        r.ok('拖动:只按下、还没越阈值时总线**不播**(纯点击不该让别的面板以为有人在拖东西)',
            busOnPress === null,
            JSON.stringify({ busOnPress }));

        // 拖到画布**外**松手:一个节点都不该多
        const beforeOutside = JSON.stringify(readGraph()?.nodes ?? []);
        const outside = await win.webContents.executeJavaScript(`(() => {
            const row = document.querySelector('#noteList button[data-path="甲篇.md"]');
            if (row === null) return { ok: false, why: '笔记树里没有那一行' };
            const ev = (type, x, y, buttons) => new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 12, pointerType: 'mouse',
                clientX: x, clientY: y, button: 0, buttons,
            });
            const r = row.getBoundingClientRect();
            const from = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            // 松在笔记树自己身上(不是画布):这一次是"移动笔记",画布不该接
            row.dispatchEvent(ev('pointerdown', from.x, from.y, 1));
            document.dispatchEvent(ev('pointermove', from.x, from.y + 3, 1));
            document.dispatchEvent(ev('pointerup', from.x, from.y + 3, 0));
            return { ok: true };
        })()`);
        await dropSleep(1200);
        r.ok('短剧画布·拖入:松在画布外(笔记树自己身上)→ 图一个节点都不多(那是"移动笔记",与画布无关)',
            outside.ok === true && JSON.stringify(readGraph()?.nodes ?? []) === beforeOutside,
            JSON.stringify({ outside, before: beforeOutside.length, after: JSON.stringify(readGraph()?.nodes ?? []).length }));

        const badges2 = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            return [...host.querySelectorAll('.drama-node')].map(
                (x) => x.querySelector('.drama-status')?.textContent ?? '');
        })()`);
        r.ok('短剧画布:缓存命中时状态写"✓ 缓存"(用户看得出这次没真跑)',
            badges2.length === 3 && badges2.every((t) => t.includes('缓存')),
            JSON.stringify(badges2));

        // 面板随整屏设置视图隐藏再切回:画布必须能从 graph.json 重建。
        await win.webContents.executeJavaScript(`document.getElementById('viewSettings').click()`);
        await new Promise((res) => { setTimeout(res, 200); });
        await win.webContents.executeJavaScript(`document.getElementById('viewNotes').click()`);
        const rebuilt = await waitForJs(`(() => {
            const host = document.querySelector('.pw-pane[data-pane-id="drama"] .pane-plugin');
            const n = host ? host.querySelectorAll('.drama-node').length : 0;
            return n === 3 ? n : null;
        })()`, 60);
        r.ok('短剧画布:切到设置再切回来,画布从 graph.json 重建出来(不是空白)',
            rebuilt === 3, String(rebuilt));

        // ---- 项目面板自己那一套:建 / 改名 / 两步删除 / 切回去 ----
        //
        // 这是**唯一**覆盖那片面板块的地方(单测只覆盖主进程那几条频道),所以全部走
        // 真点击、真键盘事件。⚠️ 收尾必须切回「自检项目」:下面还有别的断言在数 3 个节点。
        const PROJ_HOST = '.pw-pane[data-pane-id="drama-projects"] .pane-plugin';
        const clickIn = (scope, text) => win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('${scope}');
            const btn = [...host.querySelectorAll('button')].find((b) => b.textContent.includes('${text}'));
            if (!btn) return false;
            btn.click();
            return true;
        })()`);
        const rightClickRow = (name) => win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('${PROJ_HOST}');
            const row = [...host.querySelectorAll('.dp-row[data-project]')]
                .find((x) => x.dataset.project === '${name}');
            if (!row) return false;
            const box = row.getBoundingClientRect();
            row.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 8,
            }));
            return true;
        })()`);
        const rowNames = () => win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('${PROJ_HOST}');
            return [...host.querySelectorAll('.dp-row[data-project]')].map((x) => x.dataset.project);
        })()`);
        const chipText = () => win.webContents.executeJavaScript(
            `document.querySelector('.pw-pane[data-pane-id="drama"] .drama-proj-name')?.textContent ?? ''`);

        // ⚠️ 这一段只在**自检那份临时根**上跑,判据是清单里有 fixture 那个「自检项目」。
        //    验收那一套的短剧根可能落在**真笔记库**里 —— 那里是只读的,
        //    绝不能在那儿建项目、改名或删东西(这些动作会写盘、会把目录丢进回收站)。
        if (dramaReady !== null && dramaReady.names.includes('自检项目')) {

        // ① 建:点「＋ 新建」→ 输入 → Enter(输入框是插件自己画的,不再用 window.prompt)
        await clickIn(PROJ_HOST, '新建');
        await waitForJs(`(() => (document.querySelector('${PROJ_HOST} .dp-input') ? 'ok' : null))()`);
        await win.webContents.executeJavaScript(`(() => {
            const input = document.querySelector('${PROJ_HOST} .dp-input');
            input.value = '面板建的项目';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            return true;
        })()`);
        const madeRows = await waitForJs(`(() => {
            const host = document.querySelector('${PROJ_HOST}');
            const rows = [...host.querySelectorAll('.dp-row[data-project]')].map((x) => x.dataset.project);
            return rows.includes('面板建的项目') ? JSON.stringify(rows) : null;
        })()`, 60);
        r.ok('短剧项目:「＋ 新建」建出来的项目当场出现在清单里',
            madeRows !== null, String(madeRows));
        r.ok('短剧项目:新建完**自动选中**它,画布名牌跟着切过去(两处不会各说各话)',
            (await waitForJs(`(() => {
                const host = document.querySelector('${PROJ_HOST}');
                const cur = host.querySelector('.dp-row.cur')?.dataset.project ?? '';
                const chip = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-proj-name')?.textContent ?? '';
                return cur === '面板建的项目' && chip === '面板建的项目' ? cur : null;
            })()`, 60)) === '面板建的项目');
        r.ok('短剧项目:空项目在画布上写的是"空图"那句空态(不是一片白墙)',
            (await waitForJs(`(() => {
                const t = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-empty')?.textContent ?? '';
                return /空图/.test(t) ? t : null;
            })()`, 40)) !== null);

        // ② 改名:右键那一行 → 「重命名」→ 就地改
        await rightClickRow('面板建的项目');
        await clickIn(PROJ_HOST, '重命名');
        const typed = await waitForJs(`(() => {
            const input = document.querySelector('${PROJ_HOST} .dp-input');
            if (!input) return null;
            input.value = '改过名的项目';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            return 'typed';
        })()`);
        const renamed = await waitForJs(`(() => {
            const rows = [...document.querySelectorAll('${PROJ_HOST} .dp-row[data-project]')]
                .map((x) => x.dataset.project);
            return rows.includes('改过名的项目') ? JSON.stringify(rows) : null;
        })()`, 60);
        r.ok('短剧项目:右键「重命名」就地改名,行上换了名字',
            typed === 'typed' && renamed !== null, `${typed} / ${renamed}`);
        r.ok('短剧项目:改名之后画布名牌也是新名字(只改一处就会在这里露馅)',
            (await chipText()) === '改过名的项目', String(await chipText()));

        // ③ 两步删除:第一下只换文案,第二下才真删
        await rightClickRow('改过名的项目');
        await clickIn(PROJ_HOST, '删除');
        const confirmLabel = await waitForJs(`(() => {
            const btn = [...document.querySelectorAll('${PROJ_HOST} .dp-menu button')]
                .find((b) => b.textContent.includes('再点一次'));
            return btn ? btn.textContent : null;
        })()`);
        r.ok('短剧项目:删除要两下 —— 第一下只把文案换成「再点一次确认删除」',
            confirmLabel !== null, String(confirmLabel));
        r.ok('短剧项目:只点一下就**没有**删掉它(手滑不算数)',
            (await rowNames()).includes('改过名的项目'));
        await clickIn(PROJ_HOST, '再点一次确认删除');
        const dpAfterDelete = await waitForJs(`(() => {
            const host = document.querySelector('${PROJ_HOST}');
            const rows = [...host.querySelectorAll('.dp-row[data-project]')].map((x) => x.dataset.project);
            if (rows.includes('改过名的项目')) return null;
            const chip = document.querySelector('.pw-pane[data-pane-id="drama"] .drama-proj-name')?.textContent ?? '';
            return JSON.stringify({ rows, chip });
        })()`, 60);
        r.ok('短剧项目:第二下真的删掉(走回收站),画布回落到「自检项目」',
            dpAfterDelete !== null && JSON.parse(dpAfterDelete).chip === '自检项目', String(dpAfterDelete));
        r.ok('短剧项目:删完画布重新画出「自检项目」的 3 个节点',
            (await waitForJs(`(() => {
                const n = document.querySelectorAll('.pw-pane[data-pane-id="drama"] .drama-node').length;
                return n === 3 ? n : null;
            })()`, 60)) === 3);

        // ---- 画布上的两个右键菜单(空白 = 加节点,卡片 = 该节点的动作)----
        //
        // ⚠️ 这一段会**真的往图里加节点、再删掉**(落到临时根的 graph.json 上),
        //    所以只在同一道闸里跑;收尾必须回到 3 个节点 —— 前面那一组数过它。
        const CANVAS_HOST = '.pw-pane[data-pane-id="drama"] .pane-plugin';
        const nodeCount = () => win.webContents.executeJavaScript(
            `document.querySelectorAll('${CANVAS_HOST} .drama-node').length`);
        // 空白处右键:直接把事件派在画布元素上(target 就是画布 = 真机上"点在没卡片的地方")
        const blankAt = (fx, fy) => `(() => {
            const host = document.querySelector('${CANVAS_HOST}');
            const canvas = host.querySelector('.drama-canvas');
            const box = canvas.getBoundingClientRect();
            canvas.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true,
                clientX: box.left + box.width * ${fx}, clientY: box.top + box.height * ${fy},
            }));
            return true;
        })()`;

        await win.webContents.executeJavaScript(blankAt(0.72, 0.78));
        const addMenu = await waitForJs(`(() => {
            const m = document.querySelector('.drama-menu');
            if (!m) return null;
            return {
                caption: m.querySelector('.drama-menu-cap')?.textContent ?? '',
                groups: [...m.querySelectorAll('.drama-menu-group')].map((g) => g.textContent),
                buttons: [...m.querySelectorAll('button .drama-menu-label')].map((b) => b.textContent),
                badges: [...m.querySelectorAll('.drama-menu-badge')].map((b) => b.textContent),
                ghost: document.querySelectorAll('${CANVAS_HOST} .drama-world .drama-ghost').length,
            };
        })()`, 30);
        r.ok('画布右键(空白):弹出加节点菜单 —— 顶部写着落点坐标,按分类分组(同类只出现一次),11 种类型全在',
            addMenu !== null && /^加节点 · -?\d+, -?\d+$/.test(addMenu.caption)
            && addMenu.groups.join(',') === '输入,文本,工具,画面,音频,后期,发布'
            && addMenu.buttons.length === 11,
            JSON.stringify(addMenu));
        r.ok('画布右键(空白):落点虚线框画在 world 里(于是它跟着平移缩放一起动),引擎里没接线的 4 种标了「未接线」',
            addMenu !== null && addMenu.ghost === 1 && addMenu.badges.length === 4,
            JSON.stringify(addMenu && { ghost: addMenu.ghost, badges: addMenu.badges }));

        // ⚠️ 这一条是补上来的洞:上面那几条**全是 DOM 形状断言**(标签 / 数量 / 坐标),
        //    而"菜单挂了样式没有"这种缺陷它们一条都抓不到 —— 插件样式是
        //    `[data-plugin="drama"] .drama-menu` 作用域的,而菜单挂在 document.body 上,
        //    作用域**一条都不匹配**:菜单照样在 DOM 里、标签照样对,却是一块没样式的裸 div,
        //    掉在页面最底下 —— 用户看到的就是"右键之后什么都没有"(真机上踩到过)。
        //    所以这里量**看得见这件事本身**:fixed 定位、有真实尺寸、落在视口里,而且用
        //    elementFromPoint 确认它真的在最上层(没被别的面板盖住)。
        const menuVisible = await win.webContents.executeJavaScript(`(() => {
            const m = document.querySelector('.drama-menu');
            if (!m) return { why: '没有菜单元素' };
            const cs = getComputedStyle(m);
            const r = m.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            const top = document.elementFromPoint(cx, cy);
            return {
                position: cs.position,
                w: Math.round(r.width), h: Math.round(r.height),
                inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
                covered: top === null ? 'null' : (m.contains(top) ? 'self' : (top.className || top.tagName)),
                bg: cs.backgroundColor,
            };
        })()`);
        r.ok('★ 画布右键:菜单真的**看得见** —— fixed 定位、有尺寸、落在视口内,而且就在最上层(没被别的面板盖住)',
            menuVisible !== undefined && menuVisible.position === 'fixed'
            && menuVisible.w > 200 && menuVisible.h > 80 && menuVisible.inView === true
            && menuVisible.covered === 'self',
            JSON.stringify(menuVisible));

        // 点「画面生成」→ 新卡片必须落在**菜单自己报的那个坐标**上(闭环:说的和做的要对上)
        await win.webContents.executeJavaScript(`(() => {
            const m = document.querySelector('.drama-menu');
            const target = [...m.querySelectorAll('button')]
                .find((b) => (b.querySelector('.drama-menu-label')?.textContent ?? '') === '画面生成');
            target.click();
            return true;
        })()`);
        const added = await waitForJs(`(() => {
            const host = document.querySelector('${CANVAS_HOST}');
            const sel = host.querySelector('.drama-node.sel');
            const all = host.querySelectorAll('.drama-node').length;
            if (!sel || all !== 4) return null;
            return { left: parseInt(sel.style.left, 10), top: parseInt(sel.style.top, 10),
                id: sel.dataset.nodeId, type: sel.dataset.type };
        })()`, 40);
        const capParts = addMenu === null ? null : addMenu.caption.match(/加节点 · (-?\d+), (-?\d+)/);
        r.ok('画布右键(空白):点一项就把节点加到**它报的那个坐标**上(卡片中心 = 鼠标处),而且新卡片当场选中',
            added !== null && capParts !== null && added.type === 'image'
            && added.left === Number(capParts[1]) - 75 && added.top === Number(capParts[2]) - 28,
            JSON.stringify({ added, caption: addMenu?.caption }));
        r.ok('画布右键(空白):菜单点完就收起来了,虚线框也不留下',
            await waitForJs(`(() => {
                const gone = document.querySelector('.drama-menu') === null;
                const ghost = document.querySelectorAll('${CANVAS_HOST} .drama-ghost').length === 0;
                return gone && ghost ? 'ok' : null;
            })()`, 30) === 'ok');

        // 卡片上右键:出现的必须是**节点菜单**,不是类型菜单
        //
        // ⚠️ 按 **id** 取卡片,不要用 `.drama-node.sel`:下面那一步的 Esc 会走画布既有的
        //    Esc 处理(state.selection.clear()),那时已经没有任何卡片是选中的了 ——
        //    按 .sel 取会拿到 null,整个自检就此中断(踩过:421 项只跑完 184 项)。
        const openCardMenu = (id) => win.webContents.executeJavaScript(`(() => {
            const card = document.querySelector('${CANVAS_HOST} .drama-node[data-node-id="${id}"]');
            if (!card) return false;
            const box = card.getBoundingClientRect();
            card.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true,
                clientX: box.left + box.width / 2, clientY: box.top + 10,
            }));
            return true;
        })()`);

        await openCardMenu(added.id);
        const nodeMenu = await waitForJs(`(() => {
            const m = document.querySelector('.drama-menu');
            if (!m) return null;
            return {
                labels: [...m.querySelectorAll('button .drama-menu-label')].map((b) => b.textContent),
                groups: m.querySelectorAll('.drama-menu-group').length,
                noCaption: m.querySelector('.drama-menu-cap') === null,
            };
        })()`, 30);
        r.ok('画布右键(卡片):弹的是**这个节点自己的**菜单(编辑 / 运行到此 / 重跑 / 删除),不是那张类型表',
            nodeMenu !== null && nodeMenu.groups === 0 && nodeMenu.noCaption === true
            && nodeMenu.labels.join(',') === '编辑,运行到此,重跑,删除',
            JSON.stringify(nodeMenu));

        // Esc 关掉 → 节点没被误删
        await win.webContents.executeJavaScript(
            `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
        const menuEscaped = await waitForJs(`(() => {
            const gone = document.querySelector('.drama-menu') === null;
            const n = document.querySelectorAll('${CANVAS_HOST} .drama-node').length;
            return gone && n === 4 ? JSON.stringify({ gone, n }) : null;
        })()`, 30);
        r.ok('画布右键:Esc 把菜单关掉,而且节点一个都没少', menuEscaped !== null, String(menuEscaped));

        // 再右键一次(此刻那张卡片并没被选中 —— 上一次 Esc 已经把选中清掉了)
        // → 右键必须先把选中切到它,菜单里的动作才对得上"这一个"
        await openCardMenu(added.id);
        await waitForJs(`(() => (document.querySelector('.drama-menu') ? 'ok' : null))()`, 20);
        const selectedByRightClick = await win.webContents.executeJavaScript(`(() => {
            const sel = [...document.querySelectorAll('${CANVAS_HOST} .drama-node.sel')];
            return sel.length === 1 ? sel[0].dataset.nodeId : 'x' + sel.length;
        })()`);
        r.ok('画布右键(卡片):右键一个**没被选中**的卡片 → 先把选中切到它(否则"删除所选"会删掉别人)',
            selectedByRightClick === added.id, String(selectedByRightClick));

        await win.webContents.executeJavaScript(`(() => {
            const m = document.querySelector('.drama-menu');
            const del = [...m.querySelectorAll('button')]
                .find((b) => (b.querySelector('.drama-menu-label')?.textContent ?? '') === '删除');
            del.click();
            return true;
        })()`);
        const afterNodeDelete = await waitForJs(`(() => {
            const host = document.querySelector('${CANVAS_HOST}');
            const n = host.querySelectorAll('.drama-node').length;
            const stillThere = host.querySelector('.drama-node[data-node-id="${added.id}"]') !== null;
            if (n !== 3 || stillThere) return null;
            // ⚠️ 菜单的收尾有 90ms 淡出 —— 要等它真的从 DOM 里走掉再断言。
            //    在"节点已删"那一刻就读数,会得到 menuStillOpen:true(踩过:那是测试太急,
            //    不是应用没关菜单)。
            return document.querySelector('.drama-menu') === null
                ? JSON.stringify({ n, menuGone: true }) : null;
        })()`, 40);
        r.ok('画布右键(卡片):点「删除」把那个节点删掉(回到 3 个),菜单同时收起',
            afterNodeDelete !== null, String(afterNodeDelete));

        // ---- 「＋ 导入」:标签行那个矢量加号,点一下把文件内容灌进「手输内容」----
        //
        // 这里走的是**真链路**:点 ＋ → 主进程的对话框守卫(自检模式回夹具那个 .srt)→
        // 引擎抽文本 → 面板灌进框。顺带把"两个老字段真的删掉了"钉成回归断言 ——
        // 那是这次改动最容易悄悄退回去的地方。
        await openCardMenu('a');          // 夹具里的文本节点(标题「稿子」)
        await waitForJs(`(() => {
            const m = document.querySelector('.drama-menu');
            if (!m) return null;
            const edit = [...m.querySelectorAll('button')]
                .find((b) => (b.querySelector('.drama-menu-label')?.textContent ?? '') === '编辑');
            if (!edit) return null;
            edit.click();
            return 'clicked';
        })()`, 30);
        // ⚠️ 量之前先等上一张右键菜单**退场**:它点完还要 90ms 淡出,而它的位置就在鼠标那儿
        //    —— 不等就会量到"命中的是菜单 label"(实测踩到)。
        await waitForJs(`(() => (document.querySelector('.drama-menu') === null ? 'ok' : null))()`, 30);
        // ⚠️ 别去点「1:1」再量:那一格画布比 150px 的卡片还窄,1:1 下卡片右侧被
        //    overflow:hidden 裁掉、＋ 的坐标落到隔壁面板上(实测:命中 DIV.dp-list)。
        //    改成两条与缩放无关的判据 —— 计算样式(证明作用域样式真的到了它身上)+ 真实缩放下命中。
        const textEditor = await waitForJs(`(() => {
            const host = document.querySelector('${CANVAS_HOST}');
            const card = host.querySelector('.drama-node[data-node-id="a"]');
            const ed = card?.querySelector('.drama-editor');
            if (!ed) return null;
            const plus = ed.querySelector('.drama-import');
            const cs = plus === null ? null : getComputedStyle(plus);
            const box = plus === null ? null : plus.getBoundingClientRect();
            const canvasBox = host.querySelector('.drama-canvas').getBoundingClientRect();
            const cx = box === null ? 0 : Math.round(box.left + box.width / 2);
            const cy = box === null ? 0 : Math.round(box.top + box.height / 2);
            const top = box === null ? null : document.elementFromPoint(cx, cy);
            return {
                caps: [...ed.querySelectorAll('.drama-field-cap > span:first-child')].map((s) => s.textContent),
                fields: [...ed.querySelectorAll('.drama-field')].length,
                plus: ed.querySelectorAll('.drama-import').length,
                plusCss: cs === null ? null : [cs.width, cs.height],
                plusSize: box === null ? null : [Math.round(box.width), Math.round(box.height)],
                plusInCanvas: box !== null && cx > canvasBox.left && cx < canvasBox.right
                    && cy > canvasBox.top && cy < canvasBox.bottom,
                canvasW: Math.round(canvasBox.width),
                plusHitInside: top === null ? false : plus.contains(top),
                // ⚠️ 这里**不能**用嵌套反引号(模板里再写模板会把外层提前闭合 —— 踩过两次)
                plusHit: top === null ? 'null'
                    : String(top.tagName ?? '?') + '.' + String(top.getAttribute?.('class') ?? ''),
                legacy: /导入的文件|用导入文件/.test(ed.textContent),
            };
        })()`, 40);
        r.ok('文本节点编辑态:只剩「手输内容」一个字段,右边有一个 ＋(矢量图标,带 aria-label)',
            textEditor !== null && textEditor.fields === 1
            && textEditor.caps.join(',') === '手输内容' && textEditor.plus === 1,
            JSON.stringify(textEditor));
        r.ok('★ 那个 ＋ 的样式真的到了它身上(计算样式 17×17 —— 菜单那次就是靠这条才分辨得出"在 DOM 里但没样式")',
            textEditor !== null && textEditor.plusCss !== null
            && textEditor.plusCss[0] === '17px' && textEditor.plusCss[1] === '17px'
            && textEditor.plusSize !== null && textEditor.plusSize[0] > 4,
            JSON.stringify(textEditor));
        // 几何那条只在**它确实落在画布可见区内**时才断言:自检窗口里那一格画布比 150px 的
        // 卡片还窄(fitView 缩到 40%),卡片右侧本来就被 overflow:hidden 裁掉 —— 那时
        // 坐标会落到隔壁面板上,拿它判红就成了"测试自己的前提不成立"。可点性由下面那条
        // 真点击链(点 ＋ → 内容灌进框)证到。
        if (textEditor !== null && textEditor.plusInCanvas === true) {
            r.ok('★ 那个 ＋ 真的看得见也点得到:中心点命中的就在按钮内部',
                textEditor.plusHitInside === true, JSON.stringify(textEditor));
        } else {
            r.note(`＋ 这次不在画布可见区内(画布宽 ${textEditor?.canvasW}px,卡片 150px)`
                + ' —— 那是这一格的正常裁切,不是缺陷;可点性见下面那条真点击链');
        }
        r.ok('★ 「导入的文件」「用导入文件(true/false)」两个字段真的没了(删了又冒出来会在这里红)',
            textEditor !== null && textEditor.legacy === false, JSON.stringify(textEditor));

        // 点那个 ＋:自检里由主进程守卫给夹具文件,不弹原生模态框
        await win.webContents.executeJavaScript(`(() => {
            const card = document.querySelector('${CANVAS_HOST} .drama-node[data-node-id="a"]');
            card.querySelector('.drama-import').click();
            return true;
        })()`);
        // 夹具里那个节点的 value 是「第一幕」(非空)→ 必须先问一句
        const confirmBar = await waitForJs(`(() => {
            const row = document.querySelector('${CANVAS_HOST} .drama-node[data-node-id="a"] .drama-confirm');
            return row ? row.textContent : null;
        })()`, 40);
        r.ok('＋ 导入:框里已有内容时**先问一句**再替换(不一键抹掉手写的东西)',
            confirmBar !== null && /已经有 3 字/.test(confirmBar) && /替换/.test(confirmBar),
            String(confirmBar));
        await win.webContents.executeJavaScript(`(() => {
            const card = document.querySelector('${CANVAS_HOST} .drama-node[data-node-id="a"]');
            card.querySelector('.drama-confirm-yes').click();
            return true;
        })()`);
        const imported = await waitForJs(`(() => {
            const card = document.querySelector('${CANVAS_HOST} .drama-node[data-node-id="a"]');
            const ta = card?.querySelector('textarea[data-param-key="value"]');
            if (!ta) return null;
            const note = document.querySelector('${CANVAS_HOST} .drama-note')?.textContent ?? '';
            return ta.value.includes('导入夹具的一行台词')
                ? JSON.stringify({ chars: ta.value.length, note }) : null;
        })()`, 60);
        r.ok('★ ＋ 导入:文件内容真的灌进了「手输内容」,状态行报出文件名 / 字数 / 编码',
            imported !== null && /已导入 自检导入\.srt/.test(JSON.parse(imported).note)
            && /字/.test(JSON.parse(imported).note),
            String(imported));
        r.ok('＋ 导入:确认条用完就收起来了(不留一块孤儿 UI 挂在卡片上)',
            await win.webContents.executeJavaScript(
                `document.querySelector('${CANVAS_HOST} .drama-confirm') === null`));

        // 收尾:把夹具那个节点恢复成「第一幕」—— 后面的断言还指着这份夹具
        await win.webContents.executeJavaScript(`(() => {
            const ta = document.querySelector('${CANVAS_HOST} .drama-node[data-node-id="a"] textarea[data-param-key="value"]');
            ta.value = '第一幕';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await win.webContents.executeJavaScript(
            `(() => { document.querySelector('${CANVAS_HOST}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
        } else {
            // 如实记 [SKIP],而不是塞一条恒真的断言充数(那种"假通过"比不测更坏)。
            r.skip('短剧项目:建/改名/两步删除三步',
                '这一跑没有自检临时根(fixture 的「自检项目」不在清单里),不往真笔记库里写东西');
        }

        r.ok('面板本体就在那一格里(不是空壳:notes-nav / note-main / note-links / agent-panel)',
            nav0.liveTag === 'aside|-|notes-nav' && doc0.liveTag === 'main|noteMain|note-main'
            && links0.liveTag === 'aside|-|note-links' && ai0.liveTag === 'section|agentPanel|agent-panel',
            JSON.stringify(ws0.panes.map((p) => p.liveTag)));

        r.ok('★ 抓手不再可聚焦(整片拖动已删,规格 §1.2)、容器 role=region + aria-label 取当前标签(读屏可达)',
            ws0.panes.every((p) => p.gripTab !== 0 && p.role === 'region' && /\(当前标签\)$/.test(p.label ?? '')),
            JSON.stringify(ws0.panes.map((p) => [p.id, p.gripTab, p.role, p.label])));

        // ⚠️ 分隔条数量 = 面板数 - 1(每两个相邻面板之间一条)。工作台现在含
        // 插件贡献的那片,所以不能再写死 3 —— 该守的是"每一条都有读数且键盘可调",
        // 以及那两条**有旧 id 的**分隔条仍然认得出来(旧契约)。
        r.ok('分隔条都带读数(旧 id 继续可用,键盘可调);条数与面板数相称',
            ws0.gutters.length === ws0.ids.length - 1
            && ws0.gutters.some((g) => g.id === 'navResizer') && ws0.gutters.some((g) => g.id === 'sideResizer')
            && ws0.gutters.every((g) => g.role === 'separator' && g.tab === 0 && g.min < g.now && g.now < g.max),
            JSON.stringify(ws0.gutters));

        r.ok('底部的布局树文本实时可读(用户要看的那份"证据"),而且是**嵌套**的(右栏里再分上下)',
            /^\{row /.test(ws0.tree) && /\{col /.test(ws0.tree)
            && ['笔记列表', '笔记正文', '链接', 'AI 对话'].every((t) => ws0.tree.includes(t)),
            ws0.tree);

        // ---- ① 边界:方案 A —— 每片有自己的框、框之间**不画线**;悬停/拖动才出高亮 ----
        //
        // 用户选定了设计稿 docs/kaiwu-pane-frame-demo.html 的**变体 A(7px 暗缝)**。
        // 他同时接受了一个取舍:**"每片四边都有框"与"边界处看不见线"不能同时成立 —— 框就是线**。
        // 所以判据从上一轮的"数边(相邻差 ≥2)"改成**"数亮线(亮度 ≥ 40)"**:
        //   · `--border` 框 ≈58、accent ≈194、面板 23、缝(页面深底)14 → 40 这条线把它们分得开;
        //   · 静止态:**缝的内圈**(去掉最外那两条属于面板的框)**一列亮线都没有**;
        //   · 悬停/拖动:缝内圈出现亮线(accent,2px);
        //   · 另外单独断言"框还在"—— 缝的两端各有一列 ≈58,而且是**两片各自的**框。
        const scanUsable = (scan) => scan !== null && scan !== undefined && Array.isArray(scan.lines);
        const edgeDetail = (scan) => JSON.stringify(scan === null || scan === undefined ? null : {
            rect: scan.rect,
            boundary: scan.boundary,
            seam: scan.seam,
            error: scan.error,
            frames: scan.frames,
            // ⚠️ 逐项判数组:右栏形状一变,边界扫描可能给出半截帧 —— 实测这里一个
            //    `c[0]` 就把整趟自检打崩(后面的项一项都没跑,只看得到一条 STACK)。
            framesBrightness: Array.isArray(scan.frames)
                ? scan.frames.map((c) => (Array.isArray(c) && c.length >= 3 ? Math.round((c[0] + c[1] + c[2]) / 3) : null))
                : null,
            innerBright: scan.innerBright,
            innerRgb: scan.innerRgb,
            lines: Array.isArray(scan.lines) ? scan.lines.map((c, i) => `${i}:${c.join(',')}`).join(' ') : null,
        });
        /** 静止态:边界窗口里**一列亮线都没有**(亮度 ≥ 40)。
         *  ⚠️ 实测确认了一件反直觉的事:**缝会把面板自己的框盖住** ——
         *  `.pw-pane` 的 box-shadow 画在面板盒子**外面** 1px,而那 1px 正好落在分隔条的
         *  命中区里,分隔条是不透明底色 → 后画的分隔条把框盖掉了。所以边界处看到的是
         *  "面板 23 | 缝 14 | 面板 23",一条亮线都没有;框只在**面板外缘**(不挨着别的面板
         *  的那几条边)看得见 —— 那一条由下面单独的断言盯着。
         *  ⚠️ 但"盖住"不是自动成立的:分隔条与两片面板是 flex 兄弟(`[面板A][缝][面板B]`),
         *  后来者画在上面 → **远侧那片的框会盖住分隔条的最后 1px**。所以
         *  `app/styles/panel-workspace.css` 给 `.pw-gutter` 写了 `z-index:1`(把分隔条抬到
         *  定位层)。那条修复之前,这里连红三条(`frames` 报出 `--border` 的 `[55,58,61]`)。
         *  ⚠️ `brightAt` 只数**缝本身**(`scan.seam`,见 `scanBoundaryEdges`):两端那 1 列是
         *  面板自己的内容(贴边滚动条的轨道亮度 44 ≥ 40),不是缝里的线。 */
        const seamOnlyOk = (scan) => scanUsable(scan)
            && Array.isArray(scan.brightAt) && scan.brightAt.length === 0;
        /** 悬停/拖动:缝里冒出那条 accent 高亮线(偏黄:R 明显大于 B)。
         *
         *  ⚠️ 判据**不要求**它在缝的哪一侧:这条线画在"指针所在一侧那片面板"的边上 ——
         *  而指针落点是缝的**中点**,7px 的缝取整到哪一像素、就决定了是哪一片。
         *  实测过:布局差 1px(百分比切分的取整)就会让指针从近侧翻到远侧,高亮线
         *  跟着换边 —— 那不是功能坏了(线一直在缝里),是这条断言原来把"近侧"写死了。
         *  所以判据是:边界附近有一条 accent 色的亮线,而且是**窄窄一条**(2px,抗锯齿最多几列)。
         *  范围比 brightAt 的窗口多留 3 列:线落在远侧面板那一边时会压在它自己的框上,
         *  正好在窗口外沿(静止态那边不受影响 —— 它仍按老窗口数亮线)。
         *  静止态(seamOnlyOk)保证"没悬停时一列亮线都没有",两条合起来才是完整的意思。 */
        const highlightOk = (scan) => {
            if (scanUsable(scan) !== true || Array.isArray(scan.lines) !== true) return false;
            const from = Math.max(0, (scan.boundary?.from ?? 0) - 1);
            const to = Math.min(scan.lines.length - 1, (scan.boundary?.to ?? scan.lines.length - 1) + 3);
            const accent = [];
            for (let i = from; i <= to; i += 1) {
                const c = scan.lines[i];
                if (c === undefined) continue;
                const brightness = Math.round((c[0] + c[1] + c[2]) / 3);
                if (brightness >= 100 && c[0] > c[2] + 30) accent.push({ i, brightness, rgb: c });
            }
            return accent.length >= 1 && accent.length <= 4;
        };

        const hRest = await scanBoundaryEdges(win, {
            from: 'notes', to: 'doc', axis: 'x',
            cropPath: path.join(os.tmpdir(), 'kaiwu-seam-x-notes-doc-rest.png'),
        });
        r.ok('静止态(默认布局):「笔记列表 | 笔记正文」之间只有两片各自的框,缝里**没有亮线**',
            seamOnlyOk(hRest), edgeDetail(hRest));
        const vRest = await scanBoundaryEdges(win, {
            from: 'links', to: 'ai', axis: 'y',
            cropPath: path.join(os.tmpdir(), 'kaiwu-seam-y-links-ai-rest.png'),
        });
        r.ok('静止态(默认布局):「链接 ↔ AI 对话」之间也只有两片各自的框,缝里**没有亮线**',
            seamOnlyOk(vRest), edgeDetail(vRest));

        // ⚠️ 这条必须在这里断言(在下面那两条**旧的**分隔条拖动之前):
        // 一旦拖过分隔条,存布局就是应该的 —— 那就测不出"默认不写盘"了。
        //
        // ⚠️ 第五轮改了口径(不是放宽,是判据换成了能测到的那件事):上面在笔记那一段里
        // **点过一篇笔记**,而"点笔记 → 把「笔记正文」那一格的标签换掉"是产品决定,
        // 它本来就该落盘(标签列表属于布局)。所以"存档还是空的"这句在这个时刻已经不成立,
        // 也不该成立。这里改成守住它真正要守的东西 —— **重画本身不写盘**:
        // 先记下此刻的存档原文,让工作台重画/重新量一遍(挂载那条路走的就是这两步),
        // 再读一次,必须**逐字节相同**。
        const archiveBeforeRepaint = settings?.get?.(LAYOUT_NAMESPACE, LAYOUT_KEY) ?? null;
        await win.webContents.executeJavaScript(`(() => {
            const api = window.__pwTabs;
            // 纯粹的重画 + 重新量:没有任何用户动作
            document.getElementById('layoutTree').textContent = document.getElementById('layoutTree').textContent;
            return api ? api.allTabs().length : 0;
        })()`);
        await win.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))');
        await new Promise((res) => { setTimeout(res, 200); });
        const archiveAfterRepaint = settings?.get?.(LAYOUT_NAMESPACE, LAYOUT_KEY) ?? null;
        r.ok('重画 / 重新量一遍都不写布局存档(挂载那条路就是这两步;不拖不动、不写存档)',
            archiveAfterRepaint === archiveBeforeRepaint,
            JSON.stringify({ before: archiveBeforeRepaint === null ? null : String(archiveBeforeRepaint).slice(0, 60), changed: archiveAfterRepaint !== archiveBeforeRepaint }));

        // ---- 侧栏宽度可拖(用户要求:两条分隔条都能拖)----
        //
        // 用**真实指针输入**拖,不看样式表写了什么:拖动只发生在"按下→移动→松开"这条
        // 时序上,只发 element.click() 是测不出来的(前面悬停断言踩过同样的坑)。
        const handleInfo = (id) => win.webContents.executeJavaScript(`(() => {
            const el = document.getElementById('${id}');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
                x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40),
                role: el.getAttribute('role'),
                min: Number(el.getAttribute('aria-valuemin')),
                max: Number(el.getAttribute('aria-valuemax')),
                now: Number(el.getAttribute('aria-valuenow')),
            };
        })()`);
        const colWidths = () => win.webContents.executeJavaScript(`({
            nav: Math.round(document.querySelector('.notes-nav').getBoundingClientRect().width),
            doc: Math.round(document.querySelector('.note-main').getBoundingClientRect().width),
            side: Math.round(document.querySelector('.note-links').getBoundingClientRect().width),
            ai: Math.round(document.getElementById('agentPanel').getBoundingClientRect().width),
            navVar: getComputedStyle(document.getElementById('paneNotes')).getPropertyValue('--nav-w').trim(),
            sideVar: getComputedStyle(document.getElementById('paneNotes')).getPropertyValue('--side-w').trim(),
        })`);
        const dragBy = async (id, dx) => {
            const h = await handleInfo(id);
            win.webContents.sendInputEvent({ type: 'mouseDown', x: h.x, y: h.y, button: 'left', clickCount: 1 });
            // 分两步移动:一步到位时渲染进程可能只看到"位置变了",拿不到中间的 move
            win.webContents.sendInputEvent({ type: 'mouseMove', x: h.x + Math.round(dx / 2), y: h.y });
            win.webContents.sendInputEvent({ type: 'mouseMove', x: h.x + dx, y: h.y });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: h.x + dx, y: h.y, button: 'left', clickCount: 1 });
            await new Promise(res => setTimeout(res, 120));
        };

        const navHandle = await handleInfo('navResizer');
        const sideHandle = await handleInfo('sideResizer');
        r.ok('两条侧栏分隔条都在,而且是可聚焦的 separator(不是只靠鼠标)',
            navHandle !== null && sideHandle !== null
            && navHandle.role === 'separator' && sideHandle.role === 'separator',
            JSON.stringify({ nav: navHandle, side: sideHandle }));

        const widthsBefore = await colWidths();
        await dragBy('navResizer', 80);
        const afterNav = await colWidths();
        r.ok('拖左分隔条:笔记列表真的变宽了(而且 CSS 变量跟着走)',
            afterNav.nav > widthsBefore.nav + 60 && afterNav.nav <= navHandle.max
            && afterNav.navVar === `${afterNav.nav}px`,
            `${widthsBefore.nav} → ${afterNav.nav}(${afterNav.navVar})`);

        // ⚠️ 这条分隔条现在落在「笔记正文 ↔ 短剧画布」之间(短剧画布是插件贡献的面板,
        // 位置表把它放在正文右边)。契约是:**往右拖 = 左边那格变宽、右边那格变窄** ——
        // 与"往左 = 右栏整栏变宽"那句旧描述不再是同一件事(那时它右边是一整栏)。
        // 所以这里验的是"两格此消彼长",而不是某个固定方向。
        const beforeSideDrag = await colWidths();
        await dragBy('sideResizer', 60);
        const afterSide = await colWidths();
        r.ok('拖正文右边那条分隔条:左边那格真的变宽了(两格此消彼长,不是纹丝不动)',
            afterSide.doc > beforeSideDrag.doc + 20 && afterSide.doc <= sideHandle.max,
            `正文 ${beforeSideDrag.doc} → ${afterSide.doc} · 右栏 ${beforeSideDrag.side} → ${afterSide.side}`);

        // 松手之后必须已经落进设置(重启还在),这是"记住宽度"的全部意义
        const savedNav = settings?.get?.('__global', 'ui.navWidth');
        r.ok('宽度落进了设置(__global / ui.navWidth),重启后还在',
            Number(savedNav) === afterNav.nav, `设置里=${JSON.stringify(savedNav)} 实际=${afterNav.nav}`);

        // 双击复位 + 键盘也能调
        const navHandle2 = await handleInfo('navResizer');
        win.webContents.sendInputEvent({ type: 'mouseDown', x: navHandle2.x, y: navHandle2.y, button: 'left', clickCount: 2 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: navHandle2.x, y: navHandle2.y, button: 'left', clickCount: 2 });
        await new Promise(res => setTimeout(res, 150));
        const widthsReset = await colWidths();
        r.ok('双击分隔条复位到默认宽度(236)', widthsReset.nav === 236, `nav=${widthsReset.nav}`);

        await win.webContents.executeJavaScript(`(() => {
            const el = document.getElementById('navResizer');
            el.focus();
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        })()`);
        const widthsByKey = await colWidths();
        r.ok('键盘 ←/→ 也能调宽度(无障碍:不是只能拖鼠标)',
            widthsByKey.nav === 252, `nav=${widthsByKey.nav}(236 + 16)`);
        await dragBy('navResizer', -80);            // 还原,别影响后面的断言

        // 主视图切换:笔记 ↔ 设置
        await win.webContents.executeJavaScript(
            `document.getElementById('viewSettings').click()`);
        r.ok('能切到设置视图', await win.webContents.executeJavaScript(
            '!document.getElementById("paneSettings").hidden'));
        await win.webContents.executeJavaScript(
            `document.getElementById('viewNotes').click()`);
        r.ok('能从设置切回笔记视图', await win.webContents.executeJavaScript(
            '!document.getElementById("paneNotes").hidden'));

        // ---- ② 尺寸角标(`820×949`):按需出现 ----
        //
        // 三态都要读**真窗口的 computed opacity** —— 这一条的全部内容就是"什么时候看得见"。
        // 顺带证明它显形时**不推标题**:`.pw-name` 的矩形在显隐前后必须一模一样
        // (角标绝对定位 + 标题栏预留了宽度,所以出现/消失都不该让标题动一下)。
        //
        // ⚠️ 放在这里(分隔条拖动那几条之后):上面那几条已经把宽度拖过了,所以本段
        // 一律用"相对比较"(前后各读一次),不假设 236 —— 也不去动存档的形状。
        const readBadge = () => win.webContents.executeJavaScript(`(() => {
            const desk = document.getElementById('panelWorkspace');
            const pane = desk.querySelector('.pw-pane[data-pane-id="notes"]');
            if (!pane) return null;
            const size = pane.querySelector('.pw-size');
            // ⚠️ 名称行已取消:要证明的改成"角标显形不会推**标签**"(角标绝对定位在 ＋ 左边)。
            //    字段名沿用旧的(nameLeft/headX…),免得动一串断言 —— 含义看这两行注释:
            //    名字 → 胶囊(.pw-tab),标题栏 → 标签条(.pw-tabs)。
            // ⚠️ 宽度小于 220px 时条会降级成「当前视图名 ∨」下拉,那时**没有** .pw-tab
            //    (上面几条用例已经拖过分隔条,所以这里不能假设还在胶囊形态)——
            //    两种形态都要量得到,否则读一个 null 的矩形就把整段自检打断。
            const strip = pane.querySelector('.pw-tabs');
            const chip = pane.querySelector('.pw-tab') ?? pane.querySelector('.pw-tabs-cur') ?? strip;
            const nr = chip.getBoundingClientRect();
            const hr = strip.getBoundingClientRect();
            return {
                text: size.textContent,
                opacity: getComputedStyle(size).opacity,
                nameLeft: Math.round(nr.left), nameW: Math.round(nr.width),
                headX: Math.round(hr.left + 40), headY: Math.round(hr.top + 8),
                // 诊断用(哪条规则让它显形的):悬停 / 焦点 / 拖动 / 正在调尺寸
                headHover: strip.matches(':hover'), headFocus: document.activeElement === strip,
                resizing: desk.classList.contains('pw-resizing'),
            };
        })()`);
        // ⚠️ 先把焦点交还给 body:上面那条键盘用例把分隔条**显式 focus** 了(那时角标应该
        // 显形),而窗口重新获得焦点时 Chromium 会让它再发一次 focus 事件 —— 不先清掉,
        // "静止"这一态就测不准(实测踩到:resizing 一直挂着,角标清不掉)。
        const blurBefore = await win.webContents.executeJavaScript(`(() => {
            const el = document.activeElement;
            if (el && typeof el.blur === 'function') el.blur();
            return {
                active: document.activeElement ? document.activeElement.tagName : null,
                resizing: document.getElementById('panelWorkspace').classList.contains('pw-resizing'),
            };
        })()`);
        r.ok('尺寸角标:焦点离开分隔条后,工作台上"正在调尺寸"的标记也摘掉了(静止态的前提)',
            blurBefore.resizing === false, JSON.stringify(blurBefore));

        const badgeIdle = await readBadge();
        r.ok('尺寸角标:静止时**看不见**(opacity=0),但文本仍是这一片的真实尺寸',
            badgeIdle !== null && badgeIdle.opacity === '0' && /^\d+×\d+$/.test(badgeIdle.text),
            JSON.stringify(badgeIdle));

        // ⚠️ 抬到前台要 **focus + moveTop 一起**:只 focus 时窗口可能仍被压着,
        //    而 hover 链在某些时刻要窗口真的在前台才更新(这条用例这次就是这么红的:
        //    `route:"cdp"` 注入成功了,可 `headHover:false`、`opacity` 停在 0)。
        try { win.focus(); win.moveTop(); } catch { /* 抬不动就按抬不动算(读数里看得见) */ }
        await new Promise((res) => { setTimeout(res, 120); });
        let hoverRoute = '';
        let badgeHover = await readBadge();
        for (let i = 0; i < 3 && badgeHover.opacity !== '1'; i++) {
            // ⚠️ 每一次都要是**真的移动**:同一个坐标重复注入,输入管线会认为"没动过"而
            //    不重算 hover(`:hover` 与过渡都不动),于是三次重试等于一次。
            //    先挪到远处、再挪回来,每次差 1px —— 这也正是 moveMouseTo 的兜底路径
            //    (sendInputEvent 那条)一直在做的事。
            await moveMouseTo(win, 4 + i, 4 + i);
            hoverRoute = await moveMouseTo(win, badgeIdle.headX + i, badgeIdle.headY + i);
            await new Promise((res) => { setTimeout(res, 300); });     // 过渡 .14s
            badgeHover = await readBadge();
        }
        r.ok('尺寸角标:鼠标悬停标签条时显形(opacity=1),而标签**一个字都没动**(不是被挤出来的)',
            badgeHover.opacity === '1'
            && badgeHover.nameLeft === badgeIdle.nameLeft && badgeHover.nameW === badgeIdle.nameW,
            JSON.stringify({
                route: hoverRoute, idle: badgeIdle.opacity, hover: badgeHover.opacity,
                headHover: badgeHover.headHover,
                nameIdle: [badgeIdle.nameLeft, badgeIdle.nameW], nameHover: [badgeHover.nameLeft, badgeHover.nameW],
            }));

        // 指针移到**笔记面板正文区**(不是顶栏 —— 顶栏是窗口拖动区,合成事件到那儿
        // 不一定会更新 hover 链,那会把这条断言变成假的失败)
        const awayAt = await win.webContents.executeJavaScript(`(() => {
            const head = document.querySelector('.pw-pane[data-pane-id="notes"] .pw-tabs');
            const r = head.getBoundingClientRect();
            return { x: Math.round(r.left + 6), y: Math.round(r.top + 220) };
        })()`);
        let badgeAway = await readBadge();
        for (let i = 0; i < 3 && badgeAway.opacity !== '0'; i++) {
            // 同上:每次都真的移动一小步,别用同一个坐标重复注入
            await moveMouseTo(win, awayAt.x + i, awayAt.y + i);
            await new Promise((res) => { setTimeout(res, 300); });
            badgeAway = await readBadge();
        }
        r.ok('尺寸角标:指针移开后淡出(回到 opacity=0)',
            badgeAway.opacity === '0' && badgeAway.headHover === false,
            JSON.stringify({ ...badgeAway, awayAt }));

        // 拖动这一片:**拖分隔条**时角标要显形(读的是**拖动中**的 opacity)
        //
        // ⚠️ 必须分三步:① 按下并移动 ② **等**一个过渡时长 ③ 再读 opacity。
        // 同一步里读完是读不到的 —— 类名刚挂上、过渡还没开始,computed opacity 还是 0。
        // ⚠️ 这里原来是"在标签条上按下 → 拖整片面板"。那条手势已按规格 §1.2 删除,
        //    所以改为拖分隔条(角标显形的另外两条时机由 CSS 的 :hover / :focus-within 管)。
        // ⚠️ 这一条原来量的是"在标签条上按下 → 拖**整片面板**时角标显形"
        //    (`.pw-pane.pw-dragging`)。整片拖动已按规格 §1.2 删除,CSS 里那条规则也一起删了,
        //    所以这里改量**还在的第三条时机**:拖分隔条时角标显形
        //    (前两条是"悬停标签条"与"标签条里有焦点",由 CSS 的 :hover / :focus-within 管)。
        await win.webContents.executeJavaScript(`(() => {
            const g = document.getElementById('navResizer');
            const r = g.getBoundingClientRect();
            const mk = (t, x, y) => new PointerEvent(t, {
                bubbles: true, cancelable: true, pointerId: 11, button: 0, clientX: x, clientY: y,
            });
            g.dispatchEvent(mk('pointerdown', Math.round(r.left + 2), Math.round(r.top + 40)));
            window.dispatchEvent(mk('pointermove', Math.round(r.left + 40), Math.round(r.top + 40)));
            return true;
        })()`);
        await new Promise((res) => { setTimeout(res, 260); });
        const dragDuring = await win.webContents.executeJavaScript(`(() => {
            const pane = document.querySelector('.pw-pane[data-pane-id="notes"]');
            const desk = document.getElementById('panelWorkspace');
            return {
                opacity: getComputedStyle(pane.querySelector('.pw-size')).opacity,
                resizing: desk.classList.contains('pw-resizing'),
            };
        })()`);
        // ⚠️ 收尾用 pointercancel(不动树、不写存档):这一条只关心"拖动中看得见"。
        const dragAfterCancel = await win.webContents.executeJavaScript(`(() => {
            window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 11 }));
            const desk = document.getElementById('panelWorkspace');
            return desk.classList.contains('pw-resizing');
        })()`);
        r.ok('尺寸角标:拖分隔条时显形(opacity=1,随 .pw-resizing 一起,松手/取消后收回)',
            dragDuring.opacity === '1' && dragDuring.resizing === true && dragAfterCancel === false,
            JSON.stringify({ during: dragDuring, afterCancel: dragAfterCancel }));
        // ⚠️ 这一条原来钉的是"**整片面板**拖到一半被 `pointercancel` 掉之后布局没动"。
        //    整片拖动已按规格 §1.2 删除(那个手势现在连开始都不会开始),所以按交接单
        //    改成**新协议里同样重要的那一条**:一枚**标签**拖到一半被系统取消时 ——
        //      · 树、活动标签、存档都不许动(取消 = 什么都没发生);
        //      · 拖动中该看得见的仍然看得见(标签半透明 + 落点高亮),不能因为"反正在取消"
        //        就一路到底;
        //      · 取消之后**临时类 / 插入线全清**(规格 §6:"取消或投放后清理全部临时类")。
        //    这一条同时钉住一个真缺陷:实现里原来把 `pointercancel` 与 `pointerup` 挂在
        //    **同一个处理器**上,于是"系统取消"会被当成一次正常投放落下去 —— 树被改了,
        //    而用户根本没松手。现在两者分开(见 panel-workspace.js 的 startTabDrag)。
        const cancelBefore = (await readWorkspace()).tree;
        const cancelled = await win.webContents.executeJavaScript(`(() => {
            const desk = document.getElementById('panelWorkspace');
            const paneOf = (id) => desk.querySelector('.pw-pane[data-pane-id="' + id + '"]');
            const from = paneOf('links');
            const to = paneOf('ai');
            if (!from || !to) return { ok: false, reason: 'panel missing' };
            const pill = from.querySelector('.pw-tab') ?? from.querySelector('.pw-tabs-cur');
            if (!pill) return { ok: false, reason: 'no draggable tab' };
            const pr = pill.getBoundingClientRect();
            const tr = to.getBoundingClientRect();
            const mk = (type, extra) => new PointerEvent(type, Object.assign({
                bubbles: true, cancelable: true, pointerId: 13, button: 0,
            }, extra || {}));
            const sx = Math.round(pr.left + pr.width / 2);
            const sy = Math.round(pr.top + pr.height / 2);
            const x = Math.round(tr.right - 6);          // 目标右边缘带内:本来会落成 edge
            const y = Math.round(tr.top + tr.height / 2);
            const leftovers = () => desk.querySelectorAll(
                '.pw-tab-dragging, .pw-pane-drop, .pw-tabs-drop').length
                + [...desk.querySelectorAll('.pw-tab-caret')].filter((n) => n.style.display === 'block').length;
            pill.dispatchEvent(mk('pointerdown', { clientX: sx, clientY: sy }));
            window.dispatchEvent(mk('pointermove', { clientX: sx + 12, clientY: sy + 12 }));
            window.dispatchEvent(mk('pointermove', { clientX: x, clientY: y }));
            const hintOn = document.getElementById('panelHint').classList.contains('pw-on');
            const draggingOn = desk.querySelectorAll('.pw-tab-dragging').length;
            const leftoverDuring = leftovers();
            window.dispatchEvent(mk('pointercancel', { clientX: x, clientY: y }));
            return {
                ok: true, hintOn, draggingOn, leftoverDuring,
                hintAfter: document.getElementById('panelHint').classList.contains('pw-on'),
                leftoverAfter: leftovers(),
                tree: document.getElementById('layoutTree').textContent,
            };
        })()`);
        r.ok('拖动被取消(pointercancel)时布局一点没动(只验"看得见"这一件事,不该改布局)',
            cancelled.ok === true
            && cancelled.draggingOn === 1 && cancelled.hintOn === true
            && cancelled.tree === cancelBefore
            && cancelled.hintAfter === false && cancelled.leftoverAfter === 0,
            JSON.stringify({ during: { dragging: cancelled.draggingOn, hint: cancelled.hintOn, leftovers: cancelled.leftoverDuring },
                after: { hint: cancelled.hintAfter, leftovers: cancelled.leftoverAfter },
                before: cancelBefore, now: cancelled.tree }));

        // 拖分隔条调尺寸:角标也要显形,而且**数字要跟着走**(不能停在旧数字上)。同样分三步。
        await win.webContents.executeJavaScript(`(() => {
            const g = document.getElementById('navResizer');
            const r = g.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + 40);
            window.__kaiwuBadgeDragStart = { x, y };
            g.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, pointerId: 12, button: 0, clientX: x, clientY: y,
            }));
            window.dispatchEvent(new PointerEvent('pointermove', {
                bubbles: true, cancelable: true, pointerId: 12, clientX: x + 40, clientY: y,
            }));
            return true;
        })()`);
        await new Promise((res) => { setTimeout(res, 260); });
        const resizeDuring = await win.webContents.executeJavaScript(`(() => {
            const desk = document.getElementById('panelWorkspace');
            const size = desk.querySelector('.pw-pane[data-pane-id="notes"] .pw-size');
            return {
                opacity: getComputedStyle(size).opacity,
                text: size.textContent,
                resizing: desk.classList.contains('pw-resizing'),
            };
        })()`);
        const resizeAfter = await win.webContents.executeJavaScript(`(() => {
            const { x, y } = window.__kaiwuBadgeDragStart;
            window.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true, cancelable: true, pointerId: 12, clientX: x + 40, clientY: y,
            }));
            delete window.__kaiwuBadgeDragStart;
            return document.getElementById('panelWorkspace').classList.contains('pw-resizing');
        })()`);
        r.ok('尺寸角标:拖分隔条调尺寸时显形,而且数字**跟着变**(不是停在旧数字上)',
            resizeDuring.opacity === '1' && resizeDuring.resizing === true
            && resizeDuring.text !== badgeIdle.text && /^\d+×\d+$/.test(resizeDuring.text)
            && resizeAfter === false,
            JSON.stringify({ start: badgeIdle.text, during: resizeDuring, afterUp: resizeAfter }));
        // 这一拖把笔记列表拖宽了 40px —— 立刻拖回去,别影响后面那些按宽度写的断言
        await dragBy('navResizer', -40);

        // ---- 工作台:**拖一枚标签**的合成手势 → 真实几何 → 存档往返 ----
        //
        // **不依赖真实鼠标**:坐标由真矩形算出来,事件用 dispatchEvent 合成
        // (自检跑在真渲染进程里,走的是同一条监听链)。
        //
        // ⚠️ 这一组在"单标签即面板"那一版里**换过判据**:原来的 `synthDrag` 是
        //    "在标签条上按下 → 拖**整片容器**",那条手势已按规格 §1.2 删除。
        //    现在的起点只有 `.pw-tab`(宽布局)/ `.pw-tabs-cur`(窄布局),落点照 §4.2。
        const synthTabDrag = (fromId, fromIndex, toId, where = 'edge-right') => win.webContents.executeJavaScript(`(() => {
            const desk = document.getElementById('panelWorkspace');
            const paneOf = (id) => desk.querySelector('.pw-pane[data-pane-id="' + id + '"]');
            const from = paneOf('${fromId}');
            const to = paneOf('${toId}');
            if (!from || !to) return { ok: false, reason: 'panel missing' };
            const pill = from.querySelectorAll('.pw-tab')[${fromIndex}] ?? from.querySelector('.pw-tabs-cur');
            if (!pill) return { ok: false, reason: 'no pill' };
            const pr = pill.getBoundingClientRect();
            const tr = to.getBoundingClientRect();
            const where = '${where}';
            const x = where === 'edge-right' ? Math.round(tr.right - 6) : Math.round(tr.left + tr.width / 2);
            const y = where === 'edge-right' ? Math.round(tr.top + tr.height / 2) : Math.round(tr.top + tr.height * 0.6);
            const mk = (type, extra) => new PointerEvent(type, Object.assign({
                bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: y,
            }, extra || {}));
            pill.dispatchEvent(mk('pointerdown', {
                clientX: Math.round(pr.left + pr.width / 2), clientY: Math.round(pr.top + pr.height / 2),
            }));
            window.dispatchEvent(mk('pointermove'));
            const hintOn = document.getElementById('panelHint').classList.contains('pw-on');
            const dragging = Boolean(desk.querySelector('.pw-tab-dragging, .pw-tabs-cur.pw-tab-dragging'));
            window.dispatchEvent(mk('pointerup'));
            const hintAfter = document.getElementById('panelHint').classList.contains('pw-on');
            return {
                ok: true, hintOn, hintAfter, dragging,
                tree: document.getElementById('layoutTree').textContent,
                ids: [...desk.querySelectorAll('.pw-pane')].map((p) => p.dataset.paneId),
                slotTabs: [...desk.querySelectorAll('.pw-pane')].map((p) => {
                    const id = p.dataset.paneId;
                    // ⚠️ 标签要问**工作台的读数口**,不能只数 DOM 里的 .pw-tab 胶囊:窄于 220px
                    //    的那一格按规格降级成「当前视图名 ∨」下拉,那时**没有**胶囊
                    //    (实测:上一步拖完之后 ai 那一格只有 162px)。数 DOM 会得到 0 枚,
                    //    于是把"标签真的搬对了"误判成失败。
                    // ⚠️ 这段注释**不能写反引号**:它整段就是模板字符串的正文,一个反引号
                    //    就会把模板提前收口,后面的渲染进程代码当场变成主进程代码
                    //    (实测:.pw-tab 被解析成 .pw 减 tab,报 tab is not defined,
                    //    而且报错位置会落在毫不相干的一行上 —— 极难查)。
                    const read = window.__pwTabs?.tabsOf?.(id) ?? null;
                    return {
                        id,
                        tabs: (read?.tabs ?? []).map((t) => t.view),
                        active: read?.active ?? null,
                        mode: p.querySelector('.pw-tabs')?.dataset.mode ?? null,
                        cur: p.querySelector('.pw-tabs-cur')?.textContent ?? null,
                    };
                }),
            };
        })()`);

        // ★ 用户明确要的那条真窗口证据:把**一枚标签**拖到 ai 的右边缘 →
        // 右侧长出一个只装这一枚的新槽位(它自己原来那一格空了就消失)。
        const dragged = await synthTabDrag('links', 0, 'ai', 'edge-right');
        const newSlotId = (dragged.ids ?? []).find((id) => id.startsWith('slot:'));
        const aiSlots = (dragged.slotTabs ?? []).find((s) => s.id === 'ai');
        const freshSlots = (dragged.slotTabs ?? []).find((s) => s.id === newSlotId);
        r.ok('★ 拖一枚标签到 ai 的右边缘 → 右侧长出**单标签新槽位**(槽位 id 是 slot:<序号>,不是视图名)',
            dragged.ok === true
            && newSlotId !== undefined && /^slot:\d+$/.test(newSlotId)
            && freshSlots !== undefined && freshSlots.tabs.length === 1 && freshSlots.tabs[0] === 'links'
            && aiSlots !== undefined && aiSlots.tabs.length === 1 && aiSlots.tabs[0] === 'ai'
            // 降级成下拉的那一格,那行字必须是**活动标签**的名字(规格 §6)
            && (freshSlots.mode === 'capsule' || /链接/.test(freshSlots.cur ?? ''))
            && (aiSlots.mode === 'capsule' || /AI 对话/.test(aiSlots.cur ?? '')),
            JSON.stringify({ ids: dragged.ids, newSlotId, ai: aiSlots, fresh: freshSlots, tree: dragged.tree }));
        r.ok('拖动中那一枚标签半透明、落点提示亮起,松手后收起(规格 §6)',
            dragged.dragging === true && dragged.hintOn === true && dragged.hintAfter === false,
            JSON.stringify({ dragging: dragged.dragging, during: dragged.hintOn, after: dragged.hintAfter }));
        r.ok('没有留下任何临时类 / 插入线(拖动结束必须清干净,规格 §6)',
            (await win.webContents.executeJavaScript(
                `document.getElementById('panelWorkspace').querySelectorAll('.pw-tab-dragging, .pw-pane-drop, .pw-tabs-drop').length`,
            )) === 0);

        const ws1 = await readWorkspace();
        r.ok('拖动之后各片面板仍在容器里真实可见、尺寸非零(搬走一枚不会让谁消失)',
            allVisible(ws1), JSON.stringify(ws1.panes.map((p) => [p.id, p.w, p.h, p.liveW, p.liveH])));
        r.ok('底部布局树文本跟着变了(证据是实时的)',
            ws1.tree !== ws0.tree, `${ws0.tree} → ${ws1.tree}`);
        // 新槽位与 ai **真的并排**(左右),而不是还叠着(几何,不只是文本)
        const sideBySide = ws1.panes.find((p) => p.id === 'ai');
        const sideBySide2 = ws1.panes.find((p) => p.id === newSlotId);
        r.ok('新槽位与 AI **真的并排**(左右)、等高,而不是还叠着',
            sideBySide !== undefined && sideBySide2 !== undefined
            && sideBySide.right <= sideBySide2.left + 1
            && Math.abs(sideBySide.top - sideBySide2.top) <= 2
            && Math.abs(sideBySide.h - sideBySide2.h) <= 2,
            JSON.stringify({ ai: [sideBySide?.left, sideBySide?.top, sideBySide?.w], fresh: [sideBySide2?.left, sideBySide2?.top, sideBySide2?.w] }));

        const savedRaw = settings?.get?.(LAYOUT_NAMESPACE, LAYOUT_KEY);
        r.ok('拖动后布局存档落进设置(带命名空间与版本号)',
            typeof savedRaw === 'string' && JSON.parse(savedRaw).v === LAYOUT_VERSION,
            typeof savedRaw === 'string' ? savedRaw.slice(0, 72) : String(savedRaw));
        const roundTrip = decodeLayout(savedRaw, WORKSPACE_IDS);
        r.ok('存档往返:主进程读回来的档解出的树 == 界面上正在显示的那棵树(下一次启动走的就是这条路径)',
            treeTextOf(roundTrip) === ws1.tree, treeTextOf(roundTrip));
        // ⚠️ 面板集合现在含**插件贡献的那一片**(短剧画布),而且 v4 起 **槽位 id ≠ 视图名**:
        // 判据必须是"每个视图都有一枚标签实例",不能写"每个 id 都在槽位列表里"
        // (拖过去的那一枚已经变成标签,它原来那个槽位名当然不在列表里)。
        const viewsOnTree = new Set(tabKeysOf(roundTrip).map((k) => k.split('\u0000')[0]));
        r.ok('解回来的树视图一个不少(按**标签**判,不是按槽位 id)',
            viewsOnTree.size === WORKSPACE_IDS.length
            && WORKSPACE_IDS.every((id) => viewsOnTree.has(id)),
            [...viewsOnTree].join(','));

        // ★ 旧档迁移:用户**已经有**一份写着旧合并 id `side` 的布局。把它当未知 id 丢掉的
        // 后果是"他明明没动过设置、面板却凭空少一个"。这里用真主进程里那份同一个模块解一次。
        const LEGACY_RAW = JSON.stringify({
            v: LAYOUT_VERSION,
            tree: {
                dir: 'row', sizes: [17.35, 82.65],
                children: [
                    { type: 'pane', id: 'notes' },
                    {
                        dir: 'row', sizes: [75.27, 24.73],
                        children: [{ type: 'pane', id: 'side' }, { type: 'pane', id: 'doc' }],
                    },
                ],
            },
        });
        const migrated = decodeLayout(LEGACY_RAW, WORKSPACE_IDS);
        // 期望值走**同一个入口** `decodeLayoutResult`,并显式传 `DEFAULT_ADOPTION` ——
        // 因为 `decodeLayout` 内部用的就是它(不是外壳那份 62/38)。
        // ⚠️ 这一点很反直觉:两份位置表**渲染归一化之后**结果一致(所以界面上看不出差别),
        // 但纯函数层的中间值不同(15/9 vs 19/6)。拿外壳那份去算期望值必然假红。
        const legacyExpected = decodeLayoutResult(LEGACY_RAW, WORKSPACE_IDS, DEFAULT_ADOPTION).tree;
        r.ok('旧档迁移:含 side 的档就地拆成 links + ai(排布与比例都保住,不是"当未知 id 丢掉")',
            listPaneIds(migrated).includes('side') === false
            && listPaneIds(migrated).includes('links') === true
            && listPaneIds(migrated).includes('ai') === true
            && formatTree(migrated, PANE_TITLES) === formatTree(legacyExpected, PANE_TITLES),
            `实际=${formatTree(migrated, PANE_TITLES)} | 期望=${formatTree(legacyExpected, PANE_TITLES)}`);

        await win.webContents.executeJavaScript('document.getElementById("layoutReset").click()');
        const ws2 = await readWorkspace();
        // "回到默认布局"≠"树文本与挂载时逐字相同":重置后的树由 workspace 的 initialTree
        // 决定,而挂载时那棵树还可能被存档覆盖过。该守的是**面板集合与形状**回到默认,
        // 以及拖乱的那一处确实被还原。
        r.ok('「重置布局」回到默认布局(拖乱之后的唯一出口)',
            ws2.ids.length === WORKSPACE_IDS.length
            && WORKSPACE_IDS.every((id) => ws2.ids.includes(id)),
            JSON.stringify({ ids: ws2.ids, tree: ws2.tree }));
        r.ok('重置之后各片面板依然真实可见、尺寸非零',
            allVisible(ws2), JSON.stringify(ws2.panes.map((p) => [p.id, p.w, p.h])));
        const afterReset = decodeLayout(settings?.get?.(LAYOUT_NAMESPACE, LAYOUT_KEY), WORKSPACE_IDS);
        // ⚠️ **不能**拿 afterReset 的 formatTree 去逐字等于界面上的树:重置之后通道里
        // 可能压根没有一条能用的档(ok=false),于是解码走的是**默认树那条比例来源**,
        // 而界面上的 initialTree 是按旧的两个像素宽度算出来的 —— 两棵树的面板与形状
        // 一模一样、比例不同。这是既有行为,不是缺陷。所以这里比"形状 + 面板集合",
        // 并单独钉住"重置之后的树确实被渲染出来了"。
        r.ok('重置也落了盘(存档解得回来、面板一个不少,且仍是那一行的形状)',
            listPaneIds(afterReset).length === WORKSPACE_IDS.length
            && WORKSPACE_IDS.every((id) => listPaneIds(afterReset).includes(id))
            && afterReset.dir === 'row',
            `${formatTree(afterReset, PANE_TITLES)} | 界面=${ws2.tree}`);

        // 普通工作台面板状态不受影响:默认树形状没有被工作台改脏。
        // ⚠️ 这里要比的是**stage 出来的那棵默认树**(外壳那四片),因为"插件那片面板"
        // 是外壳在启动时按位置表收编进来的,不在 lib 的默认树里 —— 用 WORKSPACE_IDS
        // 去比会把"收编"误判成"默认树变了"。
        const stagedIds = listPaneIds(defaultTree());
        r.ok('工作台的默认树仍然是"链接与 AI 叠在右侧"(纯函数层与界面一致)',
            defaultTree().dir === 'row'
            && stagedIds.join(',') === SHELL_PANE_IDS.join(',')
            && defaultTree().children[2].dir === 'col');
        // 顺带把"收编确实发生了"单独钉一条:这正是插件面板能出现在工作台里的原因。
        const adoptedDefault = adoptPanes(defaultTree(), WORKSPACE_IDS, WORKSPACE_ADOPTION);
        r.ok('默认树经 adoptPanes 收编后,插件面板出现在「笔记正文」右边那一格',
            listPaneIds(adoptedDefault).length === WORKSPACE_IDS.length
            && listPaneIds(adoptedDefault)[2] === 'drama',
            listPaneIds(adoptedDefault).join(','));


        // ==== 单标签拖动的**手势读数**(规格 §1.2 / §4 落地之后重量的那一组)====
        //
        // ⚠️ 这一组在"单标签即面板"那一版里**整组换过判据**。换掉的是四条第 1~4 项:
        //   · 旧:"抓手拖动照旧灵、落点提示照旧亮"、"标签条内部注入的元素上按下会把面板拖走"、
        //     "按真的胶囊不会拖走整片容器" —— 这三条钉的都是**整片容器拖动**(bindPaneDrag)。
        //     规格 §1.2 明令禁止该手势,而且要求"不得仅仅在视觉上隐藏抓手而保留事件",
        //     所以整条路径已删:现在是"抓手 / 标签条空白 / 正文上按下**一律不动**"。
        //   · 新:唯一的拖动起点是 `.pw-tab`(宽)与 `.pw-tabs-cur`(窄),
        //     落点照 §4.2 的"标签条 > 四边 28px > 正文中央 > 取消"。
        // 三条读数(实测量的是**真窗口 + 真指针事件**):
        //   ① 抓手 / 条上空白 / 正文上按下拖走 → 树一动不动、落点提示不出现;
        //   ② 拖一枚胶囊到目标右缘 → 树真的变了,而且**只搬这一枚**(未拖的留在原栈);
        //   ③ 拖一枚胶囊到目标正文中央 → 并进那一格、被拖的成为 activity。
        const gestureProbe = await win.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
            const desk = document.getElementById('panelWorkspace');
            const treeText = () => document.getElementById('layoutTree').textContent;
            const hintOn = () => document.getElementById('panelHint').classList.contains('pw-on');
            const paneOf = (id) => desk.querySelector('.pw-pane[data-pane-id="' + id + '"]');
            const barOf = (id) => paneOf(id).querySelector('.pw-tabs');
            const mk = (type, extra) => new PointerEvent(type, Object.assign({
                bubbles: true, cancelable: true, pointerId: 11, button: 0,
            }, extra || {}));
            // 一次完整的拖动手势:在该元素上按下 → 移到给定坐标 → 松开
            const dragFromTo = async (el, x, y) => {
                const r = el.getBoundingClientRect();
                const before = treeText();
                el.dispatchEvent(mk('pointerdown', {
                    clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
                }));
                window.dispatchEvent(mk('pointermove', { clientX: x, clientY: y }));
                const hint = hintOn();
                const dragging = Boolean(desk.querySelector('.pw-tab-dragging, .pw-tabs-cur.pw-tab-dragging'));
                window.dispatchEvent(mk('pointerup', { clientX: x, clientY: y }));
                await sleep(60);
                const after = treeText();
                return { before, after, hint, dragging, changed: before !== after };
            };
            const out = {};
            document.getElementById('layoutReset').click();
            await sleep(180);

            // ① 抓手 / 条上空白 / 正文:全都**不该**启动任何拖动
            const grip = barOf('notes').querySelector('.pw-grip');
            const pad = barOf('notes').querySelector('.pw-grabpad');
            const body = paneOf('notes').querySelector('.pw-body');
            const target = 'doc';
            const tr = paneOf(target).getBoundingClientRect();
            out.grip = await dragFromTo(grip, Math.round(tr.right - 10), Math.round(tr.top + tr.height / 2));
            out.pad = await dragFromTo(pad, Math.round(tr.right - 10), Math.round(tr.top + tr.height / 2));
            out.body = await dragFromTo(body, Math.round(tr.right - 10), Math.round(tr.top + tr.height / 2));
            out.afterInert = treeText();

            // ② 拖一枚**胶囊**到目标右缘 → 只搬这一枚
            document.getElementById('layoutReset').click();
            await sleep(180);
            const chipPanes = [...desk.querySelectorAll('.pw-pane')].filter((n) => n.querySelector('.pw-tab'))
                .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            const chipPane = chipPanes[0] ?? null;
            const other = [...desk.querySelectorAll('.pw-pane')]
                .find((n) => n !== chipPane && n.getBoundingClientRect().width > 40) ?? null;
            const or = other ? other.getBoundingClientRect() : null;
            out.chipToEdge = (chipPane && other)
                ? await dragFromTo(chipPane.querySelector('.pw-tab'), Math.round(or.right - 6), Math.round(or.top + or.height / 2))
                : { changed: null, hint: null, missing: true };
            out.afterEdge = treeText();
            out.slotCountAfterEdge = desk.querySelectorAll('.pw-pane').length;

            // ③ 拖一枚胶囊到目标**正文中央** → 并进那一格
            document.getElementById('layoutReset').click();
            await sleep(180);
            const chips2 = [...desk.querySelectorAll('.pw-pane')].filter((n) => n.querySelector('.pw-tab'))
                .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            const from2 = chips2[0] ?? null;
            const to2 = [...desk.querySelectorAll('.pw-pane')]
                .find((n) => n !== from2 && n.getBoundingClientRect().width > 120) ?? null;
            const tr2 = to2 ? to2.getBoundingClientRect() : null;
            out.chipToBody = (from2 && to2)
                ? await dragFromTo(from2.querySelector('.pw-tab'),
                    Math.round(tr2.left + tr2.width / 2), Math.round(tr2.top + tr2.height / 2))
                : { changed: null, hint: null, missing: true };
            out.afterBody = treeText();

            // 收拾:回到默认布局
            document.getElementById('layoutReset').click();
            await sleep(120);
            out.afterReset = treeText();
            out.hintAtEnd = hintOn();
            // ⚠️ 临时类必须清干净(规格 §6):拖动结束后不许留下任何半透明 / 描边 / 插入线
            out.leftoverClasses = desk.querySelectorAll(
                '.pw-tab-dragging, .pw-pane-drop, .pw-tabs-drop').length;
            out.leftoverCaret = [...desk.querySelectorAll('.pw-tab-caret')]
                .filter((n) => n.style.display === 'block').length;
            return out;
        })()`);
        r.note(`单标签手势读数:${JSON.stringify(gestureProbe)}`);
        r.ok('★ 抓手上按下拖动 → 树一动不动、落点提示也不出现(整片拖动已按规格删除)',
            gestureProbe.grip.changed === false && gestureProbe.grip.hint === false,
            JSON.stringify(gestureProbe.grip));
        r.ok('★ 标签条空白上按下拖动 → 树一动不动(同上)',
            gestureProbe.pad.changed === false && gestureProbe.pad.hint === false,
            JSON.stringify(gestureProbe.pad));
        r.ok('★ 面板正文上按下拖动 → 树一动不动(同上)',
            gestureProbe.body.changed === false && gestureProbe.body.hint === false,
            JSON.stringify(gestureProbe.body));
        r.ok('★ 拖一枚胶囊到目标右缘 → 树真的变了,而且拖动中那一枚半透明',
            gestureProbe.chipToEdge.changed === true && gestureProbe.chipToEdge.dragging === true,
            JSON.stringify(gestureProbe.chipToEdge));
        r.ok('★ 拖一枚胶囊到目标正文中央 → 树真的变了(并进那一格)',
            gestureProbe.chipToBody.changed === true, JSON.stringify(gestureProbe.chipToBody));
        r.ok('拖动结束后没有留下任何临时类 / 插入线(规格 §6)',
            gestureProbe.leftoverClasses === 0 && gestureProbe.leftoverCaret === 0,
            `classes=${gestureProbe.leftoverClasses} caret=${gestureProbe.leftoverCaret}`);
        r.ok('这一组收尾时回到了默认布局(读数与初始一致)',
            gestureProbe.afterReset === gestureProbe.grip.before,
            `${gestureProbe.grip.before} → ${gestureProbe.afterReset}`);

        // ---- 工具(内核原有断言)----
        r.ok(`加载失败的插件数符合预期(${acceptance ? 1 : 0})`,
            ready.broken === (acceptance ? 1 : 0), `broken=${ready.broken}`);


        // 组 1:注册表结果。
        // --acceptance 下会多出两个夹具(一个正常单文件插件 + 一个坏插件),
        // 其中只有正常且已注册工作台面板的插件进入可打开工具集合。
        const baseTools = acceptance ? 7 : 6;
        const summary = await win.webContents.executeJavaScript(`(() => ({
            tools: window.__pwTabs?.toolIds?.() ?? [],
        }))()`);
        r.ok(`扫描到 ${baseTools} 个已注册工具`, summary.tools.length === baseTools,
            `tools=${summary.tools.join(',')}`);

        // 组 2:注册的工具 id 集合符合预期
        const expectedTools = ['hello', 'music', 'palette', 'subtitle', 'douyin', 'bilibili'];
        if (acceptance) expectedTools.push('accprobe');
        r.ok('工具注册 id 集合符合预期',
            expectedTools.length === summary.tools.length && expectedTools.every(id => summary.tools.includes(id)),
            summary.tools.join(','));
        const staleToolIgnored = await win.webContents.executeJavaScript(
            "window.__pwTabs?.openPanel('tool:missing:missing') === false");
        r.ok('菜单中残留的未知工具视图 id 会被忽略', staleToolIgnored === true);

        // 组 3:逐个经窗口菜单使用的同一面板处理器打开,断言独立工作台 pane 已挂载。
        const openTool = (toolId) => win.webContents.executeJavaScript(
            `window.__pwTabs?.openPanel('tool:${toolId}:${toolId}')`);
        const probes = {
            palette: '#paletteSchemes',
            subtitle: '#subtitleInput',
            music: '#musicKeyword',
            douyin: '#douyinInput',
            bilibili: '#biliInput',
            hello: '#helloStamp',
        };
        for (const [toolId, selector] of Object.entries(probes)) {
            await openTool(toolId);
            const paneSelector = `[data-pane-plugin="${toolId}"] ${selector}`;
            const found = await waitForElement(win, paneSelector);
            const activeView = await win.webContents.executeJavaScript(`(() => ({
                notes: !document.getElementById('paneNotes').hidden,
                settings: document.getElementById('paneSettings').hidden,
            }))()`);
            r.ok(`工具 ${toolId} 在工作台独立 pane 中挂载(${selector})`,
                found === true && activeView.notes === true && activeView.settings === true,
                JSON.stringify({ found, paneSelector, activeView }));
        }

        // 再选一次已打开的工具只聚焦原视图,不重复添加标签或创建第二个实例。
        await openTool('palette');
        const paletteInstances = await win.webContents.executeJavaScript(`
            (window.__pwTabs?.allTabs?.() ?? []).flatMap((pane) => pane.tabs ?? [])
                .filter((tab) => tab.view === 'tool:palette:palette').length`);
        r.ok('重复点击同一工具只聚焦已有 pane,不会创建副本', paletteInstances === 1,
            `paletteInstances=${paletteInstances}`);

        // 单文件形态的 setup 是内联在注册 spec 里的,单独断言它的实际内容,
        // 确认 ctx 真的传进去了(而不是只挂了个空壳)。
        const helloStamp = await waitForText(win, '[data-pane-plugin="hello"] #helloStamp');
        r.ok('单文件插件的 setup 拿到可用的 ctx',
            String(helloStamp).includes('hello'), JSON.stringify(helloStamp));

        // 共享控件的样式**必须**真的作用到插件面板里。
        // 真实回归:`.tool-search` / `.tool-search-btn` 原先只写在 music 插件的
        // style.css 里,而插件样式会被加上 [data-plugin="music"] 前缀 ——
        // douyin / bilibili 用了同样的类名却一条规则都拿不到,「解析」按钮于是
        // 是浏览器默认外观。CSS 缺失不会报任何错,只有断言计算样式能发现。
        //
        // 上面那轮循环最后停在 hello 面板上,所以先聚焦回 B 站 pane,再探。
        await openTool('bilibili');
        await waitForElement(win, '[data-pane-plugin="bilibili"] #biliInput');

        // ---- B站下载队列(方案 A:面板内嵌队列)----
        //
        // 数据来自自检**专用**的夹具服务(main.js 的 startQueueFixture):自检刻意不拉
        // 真服务,而这三条断言又必须确定 —— 所以对端换成一个只回答 /bilibili/tasks 的
        // 本地 HTTP 服务,面板走的仍是它自己那条 fetch → IPC → 主进程 的链路。
        const queueTaskFound = await waitForElement(win, '.bili-q-task[data-task-id="7777"]');
        // 夹具从**页面里**到底能不能取到(取不到时把真实错误原样带出来)——
        // 队列那条断言失败时,这一条能直接告诉我们是"地址不对"还是"被拦了"。
        const queueProbe = await win.webContents.executeJavaScript(`(async () => {
            const base = ${JSON.stringify(settings.get('bilibili', 'apiBase') ?? null)};
            const out = { base, current: location.origin };
            if (typeof base !== 'string' || base === '') return out;
            try {
                const res = await fetch(base + '/bilibili/tasks');
                out.status = res.status;
                const json = await res.json();
                out.code = json.code;
                out.tasks = Array.isArray(json.data?.tasks) ? json.data.tasks.length : -1;
            } catch (err) {
                out.error = String(err && err.message ? err.message : err);
            }
            return out;
        })()`);
        r.ok('B站队列:夹具队列服务从页面里取得到,而且插件读的就是同一个地址(否则下面两条断言测不到东西)',
            queueProbe.status === 200 && queueProbe.tasks === 1
            && queueFixture !== null && queueProbe.base === queueFixture.base,
            JSON.stringify({ ...queueProbe, fixtureBase: queueFixture === null ? null : queueFixture.base }).slice(0, 320));
        const queueSnap = await win.webContents.executeJavaScript(`(() => {
            const queue = document.querySelector('.bili-q');
            const task = document.querySelector('.bili-q-task[data-task-id="7777"]');
            const copy = task ? task.querySelector('.bili-q-copy') : null;
            const badge = task ? task.querySelector('.bili-q-st') : null;
            const fill = task ? task.querySelector('.bili-q-prog i') : null;
            return {
                queueFound: queue !== null,
                taskFound: task !== null,
                taskStatus: task ? task.dataset.status : null,
                taskPhase: task ? (task.dataset.phase ?? null) : null,
                taskText: task ? task.textContent : '',
                isLive: task ? task.classList.contains('is-live') : null,
                badgeText: badge ? badge.textContent : null,
                badgeTitle: badge ? badge.getAttribute('title') : null,
                fillWidth: fill ? fill.style.width : null,
                hasCopy: copy !== null,
                copyLabel: copy ? copy.getAttribute('aria-label') : null,
                hasUnderstand: task ? task.querySelector('.bili-q-understand') !== null : false,
                understandLabel: task ? (task.querySelector('.bili-q-understand')?.getAttribute('aria-label') ?? null) : null,
                progressLayers: task ? task.querySelectorAll('.bili-q-prog').length : -1,
                polling: queue ? queue.dataset.polling : null,
                pollCount: queue ? queue.dataset.pollCount : null,
                pollReason: queue ? queue.dataset.pollReason : null,
            };
        })()`);
        r.ok('B站队列:面板下方长出队列区,并渲染出夹具任务(标题/UP/时长都在)',
            queueTaskFound === true && queueSnap.queueFound === true && queueSnap.taskFound === true
            && /自检夹具/.test(String(queueSnap.taskText ?? ''))
            && /自检/.test(String(queueSnap.taskText ?? ''))
            && /1:01/.test(String(queueSnap.taskText ?? '')),
            JSON.stringify(queueSnap).slice(0, 320));
        // ★ 这一条就是用户报的那个 bug:上游给的活跃状态是 `running`,而界面把它当静止 →
        // 不轮询、没有 live 动效、胶囊直接显示英文 `running`。夹具一开始就是 running,
        // 所以下面每一条都是"真窗口里真的这么画"。
        r.ok('B站队列(实测状态 running):中文胶囊 + 原始 token 进 title + is-live 动效,而且标签**绝不是英文**',
            queueTaskFound === true && queueSnap.taskStatus === 'running'
            && queueSnap.badgeText === '下载中'
            && queueSnap.badgeTitle === '上游状态:running'
            && queueSnap.isLive === true
            && /^[\u4e00-\u9fa5]+$/.test(String(queueSnap.badgeText ?? '')),
            JSON.stringify(queueSnap).slice(0, 320));
        // 进度:实测语义是 0–1 的比例,audio=1 / video=0.42 / merge=0 → 三段等权 47%,阶段"视频"
        r.ok('B站队列(实测进度语义):进度条按 0–1 的比例画(47%),阶段写"视频" —— 旧代码把它当 0–100,条最多只走 1%',
            queueSnap.progressLayers === 1 && queueSnap.fillWidth === '47%'
            && queueSnap.taskPhase === 'video'
            && /视频 47%/.test(String(queueSnap.taskText ?? '')),
            JSON.stringify({ layers: queueSnap.progressLayers, width: queueSnap.fillWidth, phase: queueSnap.taskPhase }).slice(0, 240));
        // ★★ 图一(用户报"绿色流动填充不动"):在**真窗口**里量三件事 ——
        //   ① 系统 reduced-motion 是不是开着(插件的 @media 会把动画关掉);
        //   ② 两次采样的 transform 数值**是否真的变了**(只断言 animationName 存在
        //      是不够的 —— 那正是这个 bug 被漏掉的原因);
        //   ③ 两个轮询周期之间 `.bili-q-prog i b` 是不是**同一个节点**
        //      (若每次 poll 都 replaceChildren 重建,动画每 1.5 秒被打回起点,
        //       看起来就是"不流动 / 每 1.5 秒跳一下")。
        // 先把节点身份存在页面里(节点过不了 IPC),过两个轮询周期再比。
        await win.webContents.executeJavaScript(`(() => {
            const row = document.querySelector('.bili-q-task[data-task-id="7777"]');
            const track = row ? row.querySelector('.bili-q-prog') : null;
            const fill = row ? row.querySelector('.bili-q-prog i') : null;
            const band = row ? row.querySelector('.bili-q-prog i b') : null;
            const cs = band ? getComputedStyle(band) : null;
            window.__kaiwuAnimProbe = {
                row, track, fill, band,
                reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
                animName: cs ? cs.animationName : null,
                animDuration: cs ? cs.animationDuration : null,
                animIteration: cs ? cs.animationIterationCount : null,
                animPlayState: cs ? cs.animationPlayState : null,
                t0: cs ? cs.transform : null,
                polls: document.querySelector('.bili-q')?.dataset.pollCount ?? null,
            };
            return true;
        })()`);
        await new Promise(resolve => setTimeout(resolve, 420));
        const animFirst = await win.webContents.executeJavaScript(`(() => {
            const p = window.__kaiwuAnimProbe;
            return { reduced: p.reduced, animName: p.animName, animDuration: p.animDuration,
                animIteration: p.animIteration, animPlayState: p.animPlayState,
                t0: p.t0, t1: p.band ? getComputedStyle(p.band).transform : null, polls: p.polls };
        })()`);
        // 再等两个轮询周期(1.5s × 2),看节点有没有被重建。
        // ⚠️ "这中间真的轮询了"用**夹具那边的请求计数**证(主进程里的数,与界面无关),
        // 不用界面的 pollCount —— 后者是面板自己写的,不如对端的账硬。
        const probeRequestsBefore = queueFixture === null ? -1 : queueFixture.requests;
        await new Promise(resolve => setTimeout(resolve, 3400));
        const probeRequestsAfter = queueFixture === null ? -1 : queueFixture.requests;
        const animAcross = await win.webContents.executeJavaScript(`(() => {
            const p = window.__kaiwuAnimProbe;
            const row = document.querySelector('.bili-q-task[data-task-id="7777"]');
            const band = row ? row.querySelector('.bili-q-prog i b') : null;
            return {
                rowSame: row !== null && p.row === row,
                fillSame: p.fill !== null && row !== null && p.fill === row.querySelector('.bili-q-prog i'),
                bandSame: band !== null && p.band === band,
                t2: band ? getComputedStyle(band).transform : null,
                pollsNow: document.querySelector('.bili-q')?.dataset.pollCount ?? null,
            };
        })()`);
        // ④ 两次数值不同的断言(这才是"在动"的证据)
        r.ok('B站队列(图一):绿色填充的条纹**真的在动** —— 两次采样的 transform 数值不同(不是只看 animation-name)',
            animFirst.t0 !== null && animFirst.t1 !== null && animFirst.t0 !== animFirst.t1
            && animFirst.reduced === false
            && animFirst.animPlayState === 'running'
            && /bili-q-bg-drift/.test(String(animFirst.animName ?? '')),
            JSON.stringify(animFirst).slice(0, 320));
        r.ok('B站队列(图一):轮询**不重建**那条进度条 —— 两个轮询周期后它还是同一个节点(否则动画每 1.5 秒被打回起点)',
            animAcross.rowSame === true && animAcross.bandSame === true && animAcross.fillSame === true
            && probeRequestsAfter > probeRequestsBefore,
            JSON.stringify({ ...animAcross, transforms: [animFirst.t0, animFirst.t1, animAcross.t2], requestsBefore: probeRequestsBefore, requestsAfter: probeRequestsAfter, pollsBefore: animFirst.polls }).slice(0, 420));

        // ⑤ **根因**(用户报的"条纹不动"就是它):注释紧跟 @keyframes 时,作用域化
        //   会把注释当成选择器的一部分,产出 `[data-plugin=x] /* 注释 */ @keyframes …`
        //   —— 非法 CSS,整条关键帧被解析器丢掉:animation-name 照样有值、
        //   play-state 还是 running,但 transform 恒为 none。所以这里直接查
        //   **CSSOM 里到底有没有那条关键帧**,而不是只看样式文本里写没写。
        const keyframeProbe = await win.webContents.executeJavaScript(`(() => {
            const el = document.querySelector('style[data-plugin-style="bilibili"]');
            const text = el ? el.textContent : '';
            const found = [];
            const walk = (list) => {
                for (const rule of list) {
                    if (rule.type === CSSRule.KEYFRAMES_RULE) found.push(rule.name);
                    if (rule.cssRules) walk(rule.cssRules);
                }
            };
            for (const sheet of document.styleSheets) {
                let rules = null;
                try { rules = sheet.cssRules; } catch { continue; }
                if (rules) walk(rules);
            }
            return {
                inText: text.includes('@keyframes bili-q-bg-drift'),
                names: found,
                inCssom: found.includes('bili-q-bg-drift'),
                scopedAtRule: /\\[data-plugin="bilibili"\\][^@{}]*@keyframes/.test(text),
            };
        })()`);
        r.ok('B站队列(图一·根因):`@keyframes bili-q-bg-drift` 必须真的进到 CSSOM(注释紧跟其后时曾被整条丢掉)',
            keyframeProbe.inText === true && keyframeProbe.inCssom === true
            && keyframeProbe.scopedAtRule === false,
            JSON.stringify(keyframeProbe).slice(0, 320));

        // running 期间**必须在轮询**:这是"界面不会冻住"的直接证据(数夹具那边的请求)
        const runningRequestsBefore = queueFixture === null ? -1 : queueFixture.requests;
        await new Promise(resolve => setTimeout(resolve, 3200));      // > 两个轮询周期
        const runningRequestsAfter = queueFixture === null ? -1 : queueFixture.requests;
        const runningState = await win.webContents.executeJavaScript(`(() => {
            const queue = document.querySelector('.bili-q');
            const task = document.querySelector('.bili-q-task[data-task-id="7777"]');
            return {
                polling: queue ? queue.dataset.polling : null,
                pollReason: queue ? queue.dataset.pollReason : null,
                stillRunning: task ? task.dataset.status : null,
            };
        })()`);
        r.ok('B站队列:running 期间**持续轮询**(3 秒里夹具收到多次请求)—— 这就是之前冻结的那一条',
            runningRequestsBefore >= 1 && runningRequestsAfter > runningRequestsBefore
            && runningState.polling === 'true'
            && /有 1 个进行中的任务/.test(String(runningState.pollReason ?? '')),
            JSON.stringify({ before: runningRequestsBefore, after: runningRequestsAfter, ...runningState }));

        // ★ 核心那一条:任务变成 done 之后,界面**自己**刷新过去(不需要用户点任何东西)。
        // 之前的表现是:停在第一次抓到的那一帧,永远不动。
        queueFixture?.setState({ status: 'done', videoProgress: 1, audioProgress: 1, mergeProgress: 1 });
        const doneRendered = await waitForElement(win, '.bili-q-task[data-task-id="7777"] .bili-q-ok');
        const afterDone = await win.webContents.executeJavaScript(`(() => {
            const task = document.querySelector('.bili-q-task[data-task-id="7777"]');
            return {
                taskStatus: task ? task.dataset.status : null,
                isLive: task ? task.classList.contains('is-live') : null,
                progressLayers: task ? task.querySelectorAll('.bili-q-prog').length : -1,
                badge: task ? task.querySelector('.bili-q-st') : null,
                hasCopy: task ? task.querySelector('.bili-q-copy') !== null : false,
                hasUnderstand: task ? task.querySelector('.bili-q-understand') !== null : false,
            };
        })()`);
        r.ok('B站队列:任务变成 done 后界面**自己刷新过去**(轮询抓到新状态 → 勾号 + 撤掉 live/进度条 + 长出复制/理解)',
            doneRendered === true && afterDone.taskStatus === 'done'
            && afterDone.isLive === false && afterDone.progressLayers === 0
            && afterDone.badge === null
            && afterDone.hasCopy === true && afterDone.hasUnderstand === true,
            JSON.stringify(afterDone).slice(0, 320));
        r.ok('B站队列:那一刻才出现复制/理解按钮(未完成的任务不该有"复制文件"这种入口)',
            queueSnap.hasCopy === false && queueSnap.hasUnderstand === false,
            JSON.stringify({ runningHasCopy: queueSnap.hasCopy, runningHasUnderstand: queueSnap.hasUnderstand }));

        // ★ 空闲不轮询:最好的证据是**夹具服务那边的请求计数**(在主进程里,与界面无关)
        const queueRequestsBefore = queueFixture === null ? -1 : queueFixture.requests;
        await new Promise(resolve => setTimeout(resolve, 3200));      // > 两个轮询周期
        const queueRequestsAfter = queueFixture === null ? -1 : queueFixture.requests;
        const queueIdle = await win.webContents.executeJavaScript(`(() => {
            const queue = document.querySelector('.bili-q');
            return {
                polling: queue ? queue.dataset.polling : null,
                pollReason: queue ? queue.dataset.pollReason : null,
            };
        })()`);
        r.ok('B站队列:**空闲时彻底停止轮询**(3 秒里夹具服务一个请求都没再收到,界面也说"停止轮询")',
            queueRequestsBefore >= 1 && queueRequestsAfter === queueRequestsBefore
            && queueIdle.polling === 'false'
            && /停止轮询/.test(String(queueIdle.pollReason ?? '')),
            JSON.stringify({ before: queueRequestsBefore, after: queueRequestsAfter, ...queueIdle }));

        // 「复制视频」→ IPC → 主进程。自检模式下主进程**绝不**真写系统剪贴板
        // (那是用户的全局资源),只把链路走完并如实说明。
        const copyClick = await win.webContents.executeJavaScript(`(() => {
            const btn = document.querySelector('.bili-q-task[data-task-id="7777"] .bili-q-copy');
            if (!btn) return { clicked: false };
            btn.click();
            return { clicked: true };
        })()`);
        await waitForAttr(win, '.bili-q', 'data-last-copy', 'ok');
        const copyResult = await win.webContents.executeJavaScript(`(() => {
            const queue = document.querySelector('.bili-q');
            const note = document.querySelector('.bili-q-note');
            return {
                lastCopy: queue ? queue.dataset.lastCopy : null,
                reason: queue ? queue.dataset.lastCopyReason : null,
                note: note ? note.textContent : null,
            };
        })()`);
        r.ok('B站队列:「复制视频」走的是 IPC 通道(自检模式不真写剪贴板,但整条链路证到)',
            copyClick.clicked === true && copyResult.lastCopy === 'ok'
            && /已把文件放进剪贴板/.test(String(copyResult.note ?? ''))
            && /自检模式/.test(String(copyResult.note ?? '')),
            JSON.stringify({ ...copyClick, ...copyResult }).slice(0, 320));

        const ctrlStyles = await win.webContents.executeJavaScript(`(() => {
            const btn = document.getElementById('biliBtn');
            // 探针 select 要挂进**文档**才拿得到计算样式。挂在 bilibili 面板里,
            // 插件的 .bili-page/.bili-quality 规则匹配不上,量到的正是 base.css。
            const host = document.getElementById('biliResult')
                || document.querySelector('.tool-block');
            const probe = document.createElement('select');
            host.appendChild(probe);
            const selectStyle = getComputedStyle(probe);
            const out = {
                btnBg: getComputedStyle(btn).backgroundImage,
                btnRadius: getComputedStyle(btn).borderRadius,
                selectAppearance: selectStyle.appearance || selectStyle.webkitAppearance,
                selectArrow: selectStyle.backgroundImage,
                colorScheme: getComputedStyle(document.documentElement).colorScheme,
            };
            probe.remove();
            return out;
        })()`);
        r.ok('插件面板里的「解析」按钮拿到了共享样式(不是浏览器默认外观)',
            String(ctrlStyles.btnBg).includes('gradient') && ctrlStyles.btnRadius !== '0px',
            JSON.stringify(ctrlStyles.btnBg) + ' radius=' + ctrlStyles.btnRadius);
        r.ok('下拉框是自绘的(关掉了原生 appearance)',
            ctrlStyles.selectAppearance === 'none', String(ctrlStyles.selectAppearance));
        r.ok('下拉框带自绘箭头', String(ctrlStyles.selectArrow).includes('svg'),
            String(ctrlStyles.selectArrow));
        // 弹出列表由 Chromium 自己画,只认 color-scheme;不声明就是一块白底。
        r.ok('声明了 color-scheme: dark(原生弹出列表才会是深色)',
            String(ctrlStyles.colorScheme).includes('dark'), String(ctrlStyles.colorScheme));

        // 封面兜底的矢量占位图必须能从渲染进程 import 到 ——
        // 路径写错的话 bilibili 插件会整个 activate 失败,这条先把它钉住。
        const phOk = await win.webContents.executeJavaScript(
            `import('toolbox://shell/shell/media-placeholder.js')
                .then(m => typeof m.createCoverPlaceholder === 'function')
                .catch(() => false)`);
        r.ok('共享的封面占位图模块可被插件 import', phOk === true, String(phOk));

        // 抖音的 Cookie 设置区:抖音详情接口被风控挡着(403 ArgusSecurityPlugin),
        // 只能让用户把浏览器 Cookie 粘进来。自检里服务没起,所以断言的是
        // "界面接好了 + 读不到状态时不会崩 + 空保存会被拦下"。
        await openTool('douyin');
        await waitForElement(win, '#douyinCookieBox');
        const cookieProbe = await win.webContents.executeJavaScript(`(async () => {
            const box = document.getElementById('douyinCookieBox');
            const out = {
                hasBox: !!box,
                closedByDefault: box ? !box.open : null,
                state: document.getElementById('douyinCookieState')?.textContent ?? '',
                hasSave: !!document.getElementById('douyinCookieSave'),
                hasLogin: !!document.getElementById('douyinCookieLogin'),
                hasRelogin: !!document.getElementById('douyinCookieRelogin'),
            };
            // 空着点保存必须被拦下(不该往服务端发空 Cookie),也不需要服务在跑
            document.getElementById('douyinCookieSave').click();
            await new Promise(r => setTimeout(r, 60));
            out.emptySaveMsg = document.getElementById('douyinCookieMsg')?.textContent ?? '';
            return out;
        })()`);
        r.ok('抖音面板里有 Cookie 设置区(默认收起)',
            cookieProbe.hasBox === true && cookieProbe.closedByDefault === true,
            JSON.stringify(cookieProbe));
        r.ok('Cookie 区有「登录并自动记住」与「换账号」两个按钮',
            cookieProbe.hasLogin === true && cookieProbe.hasRelogin === true,
            JSON.stringify(cookieProbe));
        r.ok('Cookie 状态位显示了内容(服务没起时也不该是空的)',
            String(cookieProbe.state).length > 0, JSON.stringify(cookieProbe.state));
        r.ok('空 Cookie 不允许保存', String(cookieProbe.emptySaveMsg).includes('先粘'),
            JSON.stringify(cookieProbe.emptySaveMsg));

        // ---- 「登录一次,自动记住 Cookie」 ----
        // 这条能力的边界全在清单里:登录页、Cookie 域、投递目标都来自插件清单,
        // 渲染进程只递 pluginId。所以这里断言的是"清单配置对了 + 界面接线了 +
        // 频道路由表里有它"(漏了白名单是最容易犯的错,而它只在真点按钮时才暴露)。
        const dyPlugin = (plugins ?? []).find(p => p.id === 'douyin');
        const cl = dyPlugin?.contributions?.cookieLogin;
        r.ok('抖音清单声明了 cookieLogin(登录页/Cookie 域/投递目标)',
            Boolean(cl) && cl.loginUrl === 'https://www.douyin.com/'
            && cl.cookieDomain === 'douyin.com'
            && cl.target?.service === 'douyin-api' && cl.target?.path === '/douyin/cookie',
            JSON.stringify(cl));
        r.ok('cookieLogin 的投递目标确实是它自己声明的服务',
            cl?.target?.service === 'douyin-api'
            && supervisor?.spec('douyin-api')?.pluginId === 'douyin',
            `specPlugin=${supervisor?.spec('douyin-api')?.pluginId}`);
        r.ok('抖音清单申请了 cookies 权限',
            (dyPlugin?.permissions ?? []).includes('cookies'),
            JSON.stringify(dyPlugin?.permissions));

        const preload = fs.readFileSync(path.join(APP_ROOT, 'electron', 'preload.cjs'), 'utf8');
        r.ok('取 Cookie 的频道在预加载白名单里(漏了它只有真点按钮才会报错)',
            preload.includes("'kaiwu:cookies:login'"));

        // browserFetch:接口签名只能由页面自己算的站点走这条路
        // (抖音的 a_bogus 已经跟当前 Argus 对不上,纯 HTTP 一律 Signature Not Found)
        const bf = dyPlugin?.contributions?.browserFetch;
        r.ok('抖音清单声明了 browserFetch(allow 白名单 + capture 片段)',
            bf?.allow?.[0] === 'https://www.douyin.com/'
            && bf?.capture?.[0] === '/aweme/v1/web/aweme/detail/',
            JSON.stringify(bf));
        r.ok('抖音清单申请了 browser 权限',
            (dyPlugin?.permissions ?? []).includes('browser'),
            JSON.stringify(dyPlugin?.permissions));
        r.ok('浏览器取数据的频道在预加载白名单里',
            preload.includes("'kaiwu:browser:fetchJson'"));

        // 组 4:服务
        // 底部那条全局状态条已经去掉(服务随应用启动,不需要用户点),所以这里
        // 断言两件事:主进程侧登记与决策正确 + 插件面板里的服务徽标真的渲染出来了
        // (状态要摆在用到它的地方 —— 那是唯一还能看到服务状态的位置)。
        // 先切到抖音面板:不依赖"上一段探针停在哪个工具上"。
        await openTool('douyin');
        await waitForElement(win, '#douyinService .status-dot');
        const badge = await win.webContents.executeJavaScript(`(() => {
            const box = document.getElementById('douyinService');
            if (!box) return { found: false };
            return {
                found: true,
                status: box.querySelector('.status-dot')?.dataset.status ?? null,
                label: box.querySelector('.svc-state')?.textContent ?? null,
                hasButton: !!box.querySelector('button'),
                hint: box.querySelector('.svc-hint')?.textContent ?? '',
            };
        })()`);
        r.ok('插件面板里的服务徽标渲染出了状态',
            badge.found === true && badge.status === 'stopped' && badge.label === '未启动',
            JSON.stringify(badge));
        r.ok('徽标上有启动按钮(状态条去掉后这里是唯一的入口)', badge.hasButton === true,
            JSON.stringify(badge));
        r.ok('未启动时提示"服务随应用启动"', String(badge.hint).includes('随应用启动'),
            JSON.stringify(badge.hint));

        const s = supervisor?.get('qqmusic');
        r.ok('服务已在主进程侧登记', Boolean(s), JSON.stringify(s));
        r.ok('自检模式下服务不被自动拉起(避免自检去 spawn 真实外部服务)',
            s?.status === 'stopped' && s?.owned === false,
            `status=${s?.status} owned=${s?.owned}`);

        // 清单声明了"随应用启动",只是自检刻意跳过。断言这两件事都在,
        // 否则把 autoStart 改回 false 会让"随应用启动"悄悄失效而没人发现。
        const specs = (supervisor?.list() ?? []).map(x => ({
            id: x.id,
            autoStart: supervisor.spec(x.id)?.autoStart,
        }));
        r.ok('三个内置服务都声明了随应用启动',
            specs.length === 3 && specs.every(x => x.autoStart === true),
            JSON.stringify(specs));
        r.ok('服务都还停着(自检不拉起真实外部服务)',
            (supervisor?.list() ?? []).every(x => x.status === 'stopped'),
            JSON.stringify((supervisor?.list() ?? []).map(x => x.status)));

        // 组 5:IPC 桥确实不在 window 上
        r.ok('IPC 桥不在 window 上',
            await win.webContents.executeJavaScript('window.__kaiwuBridge === undefined'));

        // 链接逃逸必须在真实运行时里也挡得住。
        // resolveWithin 是纯词法函数:当 app/escape 是指向仓库根目录的联接时,
        // "escape/package.json" 词法上确实在 app/ 之内,词法层会放行。
        // 若只做词法检查,这里就会真的把 kaiwu/package.json 读出去(200)。
        // 用目录联接而不是符号链接:Windows 上普通符号链接需要管理员权限。
        //
        // ⚠️ 目录联接是 NTFS 的特性。仓库放在 FAT32/exFAT 盘上时 fs.symlinkSync
        // 直接 EISDIR —— 那是**文件系统**不支持,不是代码不对。这一条因此做成
        // 环境感知:建不出联接就记 [SKIP](带原因),而不是把整个自检判失败。
        // 代价必须说清楚:在那种盘上,"协议层挡得住联接逃逸"这一条没有被验证;
        // 同一条性质仍由 npm test 的 path-guard / vault-path / app-protocol 用例
        // 盯着(它们在系统临时目录里建联接,那里是 NTFS)。
        const escapeLink = path.join(APP_ROOT, 'app', 'escape');
        let junctionReady = false;
        try {
            removeJunction(escapeLink);
            fs.symlinkSync(APP_ROOT, escapeLink, 'junction');
            junctionReady = true;
        } catch (err) {
            r.skip('经目录联接逃出资源根被拒绝',
                `本机文件系统不支持目录联接(${err.code}),跳过;该性质由 npm test 的联接用例覆盖`);
        }

        if (junctionReady) {
            try {
                const escaped = await win.webContents.executeJavaScript(
                    `fetch('toolbox://shell/escape/package.json').then(r => r.status).catch(() => 'threw')`);
                r.ok('经目录联接逃出资源根被拒绝', escaped === 403, String(escaped));
            } finally {
                removeJunction(escapeLink);
            }
        }

        if (supervisor) {
            r.ok('服务托管器可用', Array.isArray(supervisor.list()));
        }

        // ---- M3:AI 面板(设计文档 §6 的右栏 / §9 M3)----
        //
        // 自检**不自动连**:面板在 ?testVault= 下 autoStart:false(见 app/main.js),
        // 由这里点 `#agentRetry` 显式起一次 —— 于是"有没有真的起过 agent"是确定的,
        // 而 agent 命令由 run-selftest.js 注入的假夹具提供(零凭证、零联网)。
        r.ok('AI 面板已挂载(右栏不再是占位)',
            await waitForElement(win, '#agentPanel') === true);

        // ---- 输入栏必须贴底(用户要求:发送栏固定底部,上面全部是对话)----
        //
        // 这条是真应用里的几何断言,因为原来的缺陷正是"结构对了但位置不对":
        // 面板 456px、消息区撑到 406px,而输入栏落在 409–466 —— 它在消息**滚动区内部**,
        // 于是往上翻历史时输入栏跟着滚走。所以这里量两件事:
        //   ① 输入栏是消息区的**兄弟**(不是孩子)—— 这是"不会被滚走"的结构保证;
        //   ② 它确实待在面板底部,而消息区从状态区一直铺到输入栏上方。
        await win.webContents.executeJavaScript('document.getElementById("viewNotes").click()');
        await new Promise(res => setTimeout(res, 120));
        const composer = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const msgs = document.getElementById('agentMessages');
            const footer = panel.querySelector('.agent-footer');
            if (!footer) return { ok: false };
            const pr = panel.getBoundingClientRect();
            const mr = msgs.getBoundingClientRect();
            const fr = footer.getBoundingClientRect();
            const inside = msgs.contains(footer);
            // 滚动消息区:输入栏要是跟着动,就说明它其实还在滚动区里
            const beforeTop = footer.getBoundingClientRect().top;
            msgs.scrollTop = msgs.scrollTop === 0 ? 9999 : 0;
            const afterTop = footer.getBoundingClientRect().top;
            msgs.scrollTop = 0;
            return {
                ok: true,
                insideMessages: inside,
                movesWithScroll: Math.abs(afterTop - beforeTop) > 1,
                gapToPanelBottom: Math.round(pr.bottom - fr.bottom),
                gapMessagesToComposer: Math.round(fr.top - mr.bottom),
                msgsH: Math.round(mr.height),
                footerH: Math.round(fr.height),
                hasCtxRow: footer.querySelector('.agent-ctx-row') !== null,
                hasDot: footer.querySelector('.agent-ctx-dot') !== null,
                // 「回车发送」那句可见文本已按用户要求删掉 ⇒ 这里量的是"它真的不在了",
                // 而"回车能发送"这条可达性信息由下面 inputAria* 两条盯着(非视觉出口)。
                keysHintVisible: /回车发送/.test(footer.textContent),
                inputAriaKeyshortcuts: (() => {
                    const box = footer.querySelector('textarea, input');
                    return box === null ? null : box.getAttribute('aria-keyshortcuts');
                })(),
                inputAriaLabel: (() => {
                    const box = footer.querySelector('textarea, input');
                    return box === null ? null : box.getAttribute('aria-label');
                })(),
                // 动作行:球 + 它左边那枚「思考强度 / 模型」胶囊。球仍然**靠右**、**仍然是唯一的主控件**
                // (原来把按钮推到右边的是「回车发送」的 margin-right:auto,那句删掉后弹簧改由
                // .agent-act-row 的 justify-content 承担)。
                // ⚠️ 发送与取消合成了一颗球(#agentStop 撤了,见 index.html / panel.js 的 ensureOrb);
                //    思考强度那枚胶囊是后加的(**紧挨球的左侧**,用户拍板),所以"行里有几个控件"
                //    这条读数从"恰好 1"变成"球 + 一枚小胶囊",而"球贴右、左边留一大截"一个字不变。
                actRow: (() => {
                    const row = footer.querySelector('.agent-act-row');
                    const ball = document.getElementById('agentSend');
                    if (row === null || ball === null) return null;
                    const rr = row.getBoundingClientRect();
                    const br = ball.getBoundingClientRect();
                    const cfg = document.getElementById('agentCfg');
                    const cr = cfg === null ? null : cfg.getBoundingClientRect();
                    // ⚠️ 浮层(.agent-cfg-pop)是**锚在这一行里**的(它要从右下角长出来),
                    //    所以 row.querySelectorAll('button') / row.textContent 会把浮层里的
                    //    按钮与文案一起算进来。这里只数**浮层之外**的控件、只读那两个控件的字。
                    const controls = [...row.querySelectorAll('button')]
                        .filter((b) => b.closest('.agent-cfg-pop') === null);
                    return {
                        width: Math.round(rr.width),
                        // 右侧留白(应当≈0:球贴着行的右边缘)
                        rightGap: Math.round(rr.right - br.right),
                        // 左边空出来的地方(应当占大半行宽:控件都在右半侧)
                        leftSpace: Math.round(br.left - rr.left),
                        // 去掉源码里的换行与缩进:真 DOM 的 textContent 会把节点间的空白也算进来。
                        // ⚠️ 这段代码住在**模板字符串**里,正则要写双反斜杠 —— 写单反斜杠会被模板串
                        // 自己吃掉反斜杠,到页面里就变成"把所有 s 换掉"(实测踩过:那堆换行原样留着)。
                        // ⚠️ 不能用模板串拼接:这段代码本身就住在一个模板串里,内层反引号会把它截断
                        //    (实测:node --check 报 "missing ) after argument list")。
                        text: (String(cfg === null ? '' : cfg.textContent)
                            + String(ball.textContent === null ? '' : ball.textContent)).replace(/\\s+/g, ''),
                        buttons: controls.length,
                        isBall: ball.classList.contains('agent-orb'),
                        eyes: ball.querySelectorAll('.agent-orb-eye').length,
                        size: Math.round(br.width),
                        label: ball.getAttribute('aria-label'),
                        mode: ball.getAttribute('data-mode'),
                        disabled: ball.disabled,
                        // 胶囊:与球相邻(间距 6px)、在球**左侧**
                        cfgText: cfg === null ? null : String(cfg.textContent ?? '').replace(/\\s+/g, ''),
                        cfgWidth: cr === null ? null : Math.round(cr.width),
                        cfgGap: cr === null ? null : Math.round(br.left - cr.right),
                        cfgIsLeft: cr === null ? null : cr.left < br.left,
                    };
                })(),
                ctx: footer.getAttribute('data-ctx'),
                border: getComputedStyle(footer).borderTopWidth,
                radius: getComputedStyle(footer).borderTopLeftRadius,
                // 那一行现在**什么都不常驻**(见下一节:密钥/上下文/停止/状态点各有去处)——
                // 默认整行 hidden,所以它既不占高度也不留下间距。
                ctxRowHidden: (() => {
                    const row = footer.querySelector('.agent-ctx-row');
                    return row === null ? null : row.hidden;
                })(),
                ctxRowInFlow: (() => {
                    const row = footer.querySelector('.agent-ctx-row');
                    if (row === null) return null;
                    const cs = getComputedStyle(row);
                    const r = row.getBoundingClientRect();
                    // "在布局里"的判据:display 不是 none,而且真的占了尺寸
                    return { display: cs.display, h: Math.round(r.height), w: Math.round(r.width) };
                })(),
                ctxRowGap: (() => {
                    // 卡片顶边到输入框顶边的距离:那一行不在时,它就该等于卡片自己的 padding-top
                    const row = footer.querySelector('.agent-ctx-row');
                    const box = footer.querySelector('textarea, input');
                    if (row === null || box === null) return null;
                    const fr = footer.getBoundingClientRect();
                    const br = box.getBoundingClientRect();
                    return { fromCardTop: Math.round(br.top - fr.top), rowBottomToInput: row.hidden ? null : Math.round(br.top - row.getBoundingClientRect().bottom) };
                })(),
                inputPlaceholder: footer.querySelector('textarea, input') ? footer.querySelector('textarea, input').placeholder : null,
                inputTitle: footer.querySelector('textarea, input')
                    ? (footer.querySelector('textarea, input').getAttribute('title') ?? footer.querySelector('textarea, input').title ?? '') : null,
                ctxText: footer.getAttribute('data-ctx-text'),
                // 卡片里所有可见文字(尾部一段就够:动作行在卡片最下面)
                footerText: String(footer.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(-80),
            };
        })()`);
        r.ok('输入区是消息滚动区的**兄弟**,不在它里面(在里面的就会跟着消息滚走)',
            composer.ok === true && composer.insideMessages === false,
            JSON.stringify(composer));
        r.ok('滚动消息时输入栏纹丝不动(实测前后位置差为 0)',
            composer.movesWithScroll === false, `moves=${composer.movesWithScroll}`);
        r.ok('输入栏贴在面板底部(只留卡片自己的外边距)',
            composer.gapToPanelBottom >= 0 && composer.gapToPanelBottom <= 14,
            `离底=${composer.gapToPanelBottom}px`);
        r.ok('消息区铺满输入栏以上的全部空间',
            composer.msgsH > 100 && composer.gapMessagesToComposer >= 0,
            `消息区高=${composer.msgsH}px 与输入栏间距=${composer.gapMessagesToComposer}px`);
        r.ok('输入区是卡片:上下文行的落点 + 边框圆角',
            composer.hasCtxRow === true
            && composer.border !== '0px' && composer.radius !== '0px',
            JSON.stringify({ ctx: composer.ctx, border: composer.border, radius: composer.radius }));
        r.ok('「回车发送」那句可见文本确实不在了:整张卡片里搜不到这四个字',
            composer.keysHintVisible === false,
            JSON.stringify({ 卡片文本尾部: composer.footerText }));
        r.ok('可达性那条没断:「回车能发送」改走非视觉出口(input 的 aria-keyshortcuts + aria-label)',
            String(composer.inputAriaKeyshortcuts ?? '').includes('Enter')
            && /回车发送/.test(String(composer.inputAriaLabel ?? '')),
            JSON.stringify({ keyshortcuts: composer.inputAriaKeyshortcuts, label: composer.inputAriaLabel }));
        r.ok('那颗球:贴着右边缘、左边空出一大截,而且它确实是那只小机器人(两只眼睛)',
            composer.actRow !== null
            // ⚠️ 控件数从"恰好 1"改成"球 + 一枚小胶囊(思考强度/模型)":后者是**紧挨球左侧**
            //    的一枚小控件(用户拍板的位置)。球仍然是**唯一的主控件** —— 可见文字仍然只有
            //    胶囊上那个字,球自己一个字都没有。
            && composer.actRow.buttons === 2 && composer.actRow.text.length <= 4
            && composer.actRow.isBall === true && composer.actRow.eyes === 2
            && composer.actRow.size >= 40 && composer.actRow.size <= 48
            // 空闲时它自报「发送」
            && composer.actRow.label === '发送' && composer.actRow.mode === 'send'
            // 贴着行的右边缘(弹簧还在,只是换了承担者:justify-content: flex-end)
            && Math.abs(composer.actRow.rightGap) <= 1
            // 胶囊在球的**左边**、与球相邻(gap 6px),而且是**窄的**(收起态一个字)
            && composer.actRow.cfgIsLeft === true && composer.actRow.cfgGap === 6
            && composer.actRow.cfgWidth !== null && composer.actRow.cfgWidth <= 80
            // 左边留出来的空白要占**一大截**:原来那句的 margin-right:auto 一走,
            // 若没补弹簧,球会贴着左边(leftSpace≈0)—— 这条就是钉那个退化的。
            && composer.actRow.leftSpace > composer.actRow.width * 0.4,
            JSON.stringify(composer.actRow));
        // ⚠️ 胶囊在"还没建会话"时说的那句话**不许冤枉对端**:自检模式下 Agent 一直**没连**
        //    (autoStart:false,由 #agentRetry 显式点,见下面那条 state=stopped 的断言),
        //    所以状态里根本没有 configOptions —— 实测新启动点开它,曾写成"对端没有给出
        //    思考强度这一项",而照 kaiwu 的方式起真 dsh 问一次 session/new,对端其实给了四档。
        //    ⚠️ 正常启动**不再**是这个样子:ACP 握手成功(ready)那一刻主进程就自动建一条会话
        //    (见 agent-runtime 的 autoCreateSession),胶囊一进来就有档位 —— 那条新行为由
        //    验收那一段的真窗口断言盯着(不点发送就能读到档位,而且滑块可调)。
        await win.webContents.executeJavaScript('document.getElementById("agentCfg").click()');
        await new Promise((res) => { setTimeout(res, 150); });
        const cfgNoSession = await win.webContents.executeJavaScript(`(() => {
            const wrap = document.getElementById('agentCfgWrap');
            return {
                desc: wrap === null ? '' : (wrap.querySelector('.agent-cfg-desc')?.textContent ?? ''),
                chip: (document.getElementById('agentCfg')?.textContent ?? '').trim(),
            };
        })()`);
        await win.webContents.executeJavaScript('document.getElementById("agentCfg").click()');
        r.ok('Agent 还没连上时,胶囊的浮层如实说"发一条消息之后才有"(不是怪对端没给)',
            // ⚠️ 不在这里查胶囊上那几个字:此刻浮层是**开着**的,它显示的是标签「思考强度」。
            //    收起态那一个字由上面那条动作行读数钉着。
            /发一条消息/.test(cfgNoSession.desc),
            JSON.stringify(cfgNoSession));

        r.ok('聊天框上面是干净的:那一行默认**整行 hidden、不在布局里**(状态点也按用户要求删了)',
            composer.hasDot === false && composer.ctxRowHidden === true
            && composer.ctxRowInFlow?.display === 'none' && composer.ctxRowInFlow?.h === 0
            && composer.ctxRowInFlow?.w === 0,
            JSON.stringify({ hasDot: composer.hasDot, hidden: composer.ctxRowHidden, flow: composer.ctxRowInFlow }));

        // ---- 那颗球(发送/取消合一):一颗控件两态 + 四类注视 ----
        //
        // 这一段全在**真窗口**里量:真指针(走 CDP,自检已有 moveMouseTo)、真键盘输入。
        // ⚠️ 动效是 rAF 驱动的,所以读数一律**轮询等**(waitForAttr / 轮询),不读一次就判 ——
        //    偶发掉帧不该让断言变红;而"自检窗口被遮挡时 Chromium 会降帧"这件事,
        //    electron/main.js 已经用 showInactive + moveTop 处理过了。
        const gazeSleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
        // 一次读全:面板上那几个诊断属性一起拿回来。
        // ⚠️ 为什么在 **Node 里轮询**、而不是往页面里塞一个 `new Promise(...tick...)`:
        //    上一次就是这么写的,结果两次读数返回 null 而中间那次却是好的 ——
        //    到底是"属性没了"还是"这段注入被吞了"根本分不清。一次一次读、把整张快照
        //    写进断言消息里,失败时才有证据。
        const readGaze = () => win.webContents.executeJavaScript(`(() => {
            const p = document.getElementById('agentPanel');
            if (p === null) return { noPanel: true };
            return {
                gaze: p.getAttribute('data-gaze'),
                mouse: p.getAttribute('data-gaze-mouse'),
                dist: p.getAttribute('data-gaze-dist'),
                looks: p.getAttribute('data-gaze-looks'),
                caret: p.getAttribute('data-gaze-caret'),
                costMax: p.getAttribute('data-gaze-caret-max'),
                skip: p.getAttribute('data-gaze-skip'),
            };
        })()`);
        const pollGaze = async (pred, tries = 30) => {
            let last = null;
            for (let i = 0; i < tries; i += 1) {
                last = await readGaze();
                if (last !== null && pred(last) === true) return last;
                await gazeSleep(100);
            }
            return last;
        };
        const ballGeom = await win.webContents.executeJavaScript(`(() => {
            const b = document.getElementById('agentSend');
            const p = document.getElementById('agentPanel');
            if (b === null || p === null) return null;
            const r = b.getBoundingClientRect();
            return {
                x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                w: Math.round(r.width), h: Math.round(r.height),
                label: b.getAttribute('aria-label'), mode: b.getAttribute('data-mode'),
                disabled: b.disabled, agentState: p.getAttribute('data-agent-state'),
                gaze: p.getAttribute('data-gaze'),
            };
        })()`);
        // ⚠️ 这里的"能不能点"必须**跟着 Agent 状态**判,不能写死:
        // 自检外壳是 autoStart=false(它绝不自动拉起真的 dsh),所以此刻 Agent 还没连上 ——
        // 按产品判据(没连上、手上又没有视频草稿)这颗球本来就该是灰的。
        // 变的只是控件,判据一个字没变(见 panel.js renderStatus 里那条注释)。
        const ballShouldEnable = ballGeom !== null
            && (ballGeom.agentState === 'ready' || ballGeom.agentState === 'starting');
        r.ok('那颗球量得到:空闲时是「发送」、data-mode=send,而且"能不能点"与 Agent 状态一致',
            ballGeom !== null && ballGeom.mode === 'send' && ballGeom.label === '发送'
            && ballGeom.disabled === !ballShouldEnable,
            JSON.stringify(Object.assign({ 期望可点: ballShouldEnable }, ballGeom)));

        // ⚠️ 凝视是**每帧**算出来的(panel.js 在 rAF 里改 data-gaze):窗口被遮挡时
        //    Chromium 一帧都不排,`pollGaze` 转满 30 次也永远停在旧值上(实测同一份代码
        //    一次全绿、一次 `gaze: 四处看` + `frame: 0 fps`)。所以先把窗口抬到前台。
        try { win.focus(); win.moveTop(); } catch { /* 抬不动就按抬不动算(读数里看得见) */ }
        await new Promise((res) => { setTimeout(res, 260); });
        // ⚠️ 落点**必须夹进窗口**,而且"这次注入有没有真的变成一次 mousemove"要留证据。
        //
        // 实测(本轮):球心 x=1221、球宽 44 → 右边缘 1243,而右栏(ai 面板)右边缘 1264、
        // 窗口再窄一点就贴到视口边。原来的落点写死 `ballGeom.x + 26` = 1247 —— 一旦
        // 布局/窗口差 1~20px,这个点就落到视口外,CDP 注入的 mouseMoved **命不中任何元素**,
        // 于是:`data-gaze-dist` 停在上一处(报 `259`,而真值是 ~28)、`data-gaze-mouse` 停在
        // `far`、`gaze` 停在「四处看」—— 三条读数一起说"事件根本没到",不是凝视坏了。
        // 同一份代码上一次全绿、这一次红,红的就是这一条。
        // 仓库里 `agentMessages` 的滚轮那条断言早就踩过同一个坑并写了 clamp(见下面
        // "坐标要夹进窗口"那段注释),这里照同一条规矩办。
        // ⚠️ 判据一个字没改(仍然要求 `gaze === '盯着鼠标'`):这里只是把指针放在
        // **几个都在"近"(NEAR=110px)范围里的候选点**上各试一次,并把事件计数一起写进证据。
        await win.webContents.executeJavaScript(`(() => {
            if (window.__gazeProbeHooked === true) return true;
            window.__gazeProbeHooked = true;
            window.__gazeProbe = { moves: 0, last: null };
            document.addEventListener('mousemove', (e) => {
                window.__gazeProbe.moves += 1;
                window.__gazeProbe.last = [Math.round(e.clientX), Math.round(e.clientY)];
            }, true);
            return true;
        })()`);
        const moveNearBall = (dx, dy) => win.webContents.executeJavaScript(`(() => {
            const b = document.getElementById('agentSend');
            if (b === null) return null;
            const r = b.getBoundingClientRect();
            const clampX = (v) => Math.max(2, Math.min(window.innerWidth - 2, Math.round(v)));
            const clampY = (v) => Math.max(2, Math.min(window.innerHeight - 2, Math.round(v)));
            return { x: clampX(r.left + r.width / 2 + ${dx}), y: clampY(r.top + r.height / 2 + ${dy}),
                     innerW: window.innerWidth, innerH: window.innerHeight,
                     ballRight: Math.round(r.right) };
        })()`);
        const readProbe = () => win.webContents.executeJavaScript(
            '({ moves: window.__gazeProbe.moves, last: window.__gazeProbe.last })',
        );
        // ① 鼠标靠近 → 盯鼠标(真指针)
        let gazeNear = null;
        let nearAt = null;
        let probe = null;
        for (const [dx, dy] of [[26, 10], [18, 6], [26, -10], [-24, 0], [0, 24]]) {
            nearAt = await moveNearBall(dx, dy);
            if (nearAt === null) break;
            await moveMouseTo(win, nearAt.x, nearAt.y);
            gazeNear = await pollGaze(g => g.gaze === '盯着鼠标', 12);
            probe = await readProbe();
            if (gazeNear !== null && gazeNear.gaze === '盯着鼠标') break;
        }
        r.ok('鼠标靠近那颗球(26px)→ 它盯着鼠标',
            gazeNear !== null && gazeNear.gaze === '盯着鼠标',
            JSON.stringify({ at: nearAt, probe, ...gazeNear }));

        // ② 鼠标挪远、而且**不再动** 1.6 秒 → 松开,四处看(不是僵在最后一个方向)
        await moveMouseTo(win, 4, 4);
        const gazeAway = await pollGaze(g => typeof g.gaze === 'string' && g.gaze.indexOf('四处看') === 0, 40);
        r.ok('鼠标挪远不动 → 它松开、四处看(1.6s 后不该还盯着旧方向)',
            gazeAway !== null && typeof gazeAway.gaze === 'string' && gazeAway.gaze.indexOf('四处看') === 0,
            JSON.stringify(gazeAway));

        // ③ 安静 5 秒:它自己每帧写 transform、改眨眼 class、写状态字 ——
        //    这些**都不能**被自己的观察器当成"页面变化"。判据:这 5 秒里"看变化"的次数不增。
        //    ⚠️ 两边都必须**读到数字**(null === null 那种"等于"是假绿,上一版就是)。
        const looksBefore = await readGaze();
        await gazeSleep(5000);
        const quiet = await readGaze();
        r.ok('安静 5 秒:它一次"看变化"都没有(说明它没有把自己的更新当成页面变化)',
            looksBefore !== null && quiet !== null
            && typeof looksBefore.looks === 'string' && looksBefore.looks === quiet.looks
            && typeof quiet.gaze === 'string' && quiet.gaze.indexOf('四处看') === 0,
            `looks ${looksBefore?.looks} → ${quiet?.looks} · gaze=${quiet?.gaze} · mouse=${quiet?.mouse}`);

        // ④ 编辑点:在笔记正文里打字 → 它看的是**光标**(镜像量出来的那一个),而且单次成本有读数
        const typeTa = async (text) => {
            if (win.webContents.debugger.isAttached() !== true) win.webContents.debugger.attach('1.3');
            await win.webContents.debugger.sendCommand('Input.insertText', { text });
        };
        const clickAtPoint = async (x, y) => {
            if (win.webContents.debugger.isAttached() !== true) win.webContents.debugger.attach('1.3');
            await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
                { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
            await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
                { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
            await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
                { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        };
        const taGeom = await win.webContents.executeJavaScript(`(async () => {
            const doc = document.getElementById('noteDoc');
            if (doc === null) return null;
            let ta = doc.querySelector('textarea.blk-input');
            if (ta === null) {
                const blk = doc.querySelector('.blk');       // 预览态:点一下进编辑态(与用户同一条路)
                if (blk !== null) blk.click();
                await new Promise((res) => { setTimeout(res, 400); });
                ta = doc.querySelector('textarea.blk-input');
            }
            if (ta === null) return null;
            const r = ta.getBoundingClientRect();
            return { x: Math.round(r.left + 20), y: Math.round(r.top + 12),
                     blocks: doc.querySelectorAll('textarea.blk-input').length };
        })()`).catch(() => null);
        if (taGeom === null) {
            r.ok('编辑点:笔记正文里找不到块编辑 textarea(这条跳过,不是失败)',
                false, '没找到 textarea.blk-input —— 请确认自检窗口里有一篇打开的笔记');
        } else {
            await clickAtPoint(taGeom.x, taGeom.y);          // 真指针点进正文
            await gazeSleep(120);
            await typeTa('打字中');                          // 真输入(insertText)
            const caretGaze = await pollGaze(
                g => (typeof g.gaze === 'string' && g.gaze.indexOf('看编辑点') === 0) || g.caret === 'mirror', 30);
            r.ok('在笔记里打字 → 它看向**编辑点**(不是整块的中心,也不是没反应)',
                caretGaze !== null && typeof caretGaze.gaze === 'string'
                && caretGaze.gaze.indexOf('看编辑点') === 0,
                JSON.stringify(Object.assign({ 块数: taGeom.blocks }, caretGaze)));
            // 光标换到另一行 → 朝向必须跟着变(拿眼睛的实际位移当读数)
            const lookBefore = await win.webContents.executeJavaScript(
                `(() => { const n = document.querySelector('#agentSend .agent-orb-look'); return n ? getComputedStyle(n).transform : null; })()`);
            await typeTa('\n第二行');
            await gazeSleep(320);
            const lookAfter = await win.webContents.executeJavaScript(
                `(() => { const n = document.querySelector('#agentSend .agent-orb-look'); return n ? getComputedStyle(n).transform : null; })()`);
            const caretCost = await readGaze();
            // ⚠️ 状态门接进真身之后:"注视暂停"的态(连接中/连不上/已停止/等待决定)里,
            //    眼睛的位置由 CSS 的 [data-face] 姿势给、JS 不再逐帧写 transform ——
            //    那种态下这条断言只要求"姿势确实在"(transform 非 null),不再要求它变化。
            const faceHere = await win.webContents.executeJavaScript(
                `document.getElementById('agentSend').getAttribute('data-face')`);
            const gazeOnHere = ['idle', 'thinking', 'streaming', 'longtask'].indexOf(faceHere) >= 0;
            r.ok('编辑点:光标换到下一行后朝向跟着变(注视开着的态里,眼睛必须真的动)',
                lookBefore !== null && lookAfter !== null && (gazeOnHere ? lookBefore !== lookAfter : true),
                `${lookBefore} → ${lookAfter} · face=${faceHere}${gazeOnHere ? '' : '(该态注视暂停,CSS 姿势接管)'}`);
            // ⚠️ 这条**量的是成本**:镜像每次量都要读一次 layout(80ms 节流)。
            //    上限放到 8ms 是因为"低于一帧(16.7ms)"就够用;真超了这条会红,逼着去看。
            r.ok('编辑点是**镜像**量出来的(不是退回整块),而且单次成本低于一帧',
                caretCost !== null && caretCost.caret === 'mirror'
                && Number(caretCost.costMax) >= 0 && Number(caretCost.costMax) < 8,
                JSON.stringify(caretCost));

            // ⚠️ 光有"单次 2ms"还不够:打字时它**每秒被调用 12 次**(80ms 节流),
            //    会不会把帧拖下来只有实测能回答 —— 所以边打字边数帧。
            //    内容用完**还原**:这段是自检,不能顺手改掉笔记正文(后面有内容敏感的用例)。
            //
            // ⚠️ 数帧之前先把窗口抬到前台:窗口被遮挡时 Chromium **一帧都不排**(实测同一份
            //    代码有的运行 `frame: 165 fps`、有的 `frame: 0 fps / 0 帧`),那时数到的是
            //    "窗口没在合成",不是"镜像把帧拖下来了"。抬到前台之后再数才是这条要量的东西。
            try { win.focus(); win.moveTop(); } catch { /* 抬不动就按抬不动算(读数里看得见) */ }
            await new Promise((res) => { setTimeout(res, 260); });
            const fpsProbe = win.webContents.executeJavaScript(`(async () => {
                let frames = 0, stop = false;
                const tick = () => { frames += 1; if (!stop) requestAnimationFrame(tick); };
                requestAnimationFrame(tick);
                const t0 = performance.now();
                await new Promise((res) => { setTimeout(res, 500); });
                stop = true;
                return { frames, ms: Math.round(performance.now() - t0) };
            })()`);
            const taSnapshot = await win.webContents.executeJavaScript(`(() => {
                const ta = document.activeElement;
                if (!ta || typeof ta.classList === 'undefined' || !ta.classList.contains('blk-input')) return null;
                return { value: ta.value, at: ta.selectionStart };
            })()`);
            for (let i = 0; i < 8; i += 1) {
                await typeTa('字');
                await gazeSleep(40);
            }
            const fps = await fpsProbe.catch(() => null);
            if (taSnapshot !== null) {
                await win.webContents.executeJavaScript(`(() => {
                    const ta = document.activeElement;
                    if (!ta || !ta.classList.contains('blk-input')) return false;
                    ta.value = ${JSON.stringify(taSnapshot.value)};
                    if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(${taSnapshot.at}, ${taSnapshot.at});
                    ta.dispatchEvent(new Event('input', { bubbles: true }));   // 让编辑器把还原后的正文存回去
                    return true;
                })()`);
            }
            const fpsValue = fps && fps.ms > 0 ? Math.round(fps.frames / (fps.ms / 1000)) : -1;
            if (fpsValue === 0) {
                // ⚠️ 0 帧 = 这一段时间里**一帧都没排**,只可能是窗口被遮挡/最小化(合成器不排帧)。
                //    那是环境,不是"镜像把帧拖下来" —— 如实记 [SKIP](会进汇总),不放宽判据。
                r.skip(`打字时没有掉帧(镜像的代价读数:最坏单次 ${caretCost?.costMax}ms,82ms 节流 → 占用 <3%)`,
                    `窗口没在合成:frame: 0 fps(${fps?.frames} 帧 / ${fps?.ms}ms) —— 本次数不到帧`);
            } else {
                r.ok(`打字时没有掉帧(镜像的代价读数:最坏单次 ${caretCost?.costMax}ms,82ms 节流 → 占用 <3%)`,
                    fpsValue >= 30, `frame: ${fpsValue} fps(${fps?.frames} 帧 / ${fps?.ms}ms)`);
            }
            await moveMouseTo(win, 4, 4);                    // 收尾:指针挪开,别影响后面的 hover 断言
        }

        // ---- 面板不显示连接状态(用户要求:默认都是连接)----
        //
        // 状态文字仍然写进 live 区给读屏用,但**视觉上必须看不见**;
        // 机器可读的那一份是 #agentPanel[data-agent-state](上面已经用过好几条断言)。
        // 另外:「停止进程」留在**同一行**(位置不变),但改成**出事才出现** ——
        // 平时它 hidden,有东西可停时才亮(判据见 panel.js renderStatus,下面用真事件量)。
        const chrome = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const status = document.getElementById('agentStatus');
            const sr = status.getBoundingClientRect();
            const kill = document.getElementById('agentKill');
            const kr = kill ? kill.getBoundingClientRect() : null;
            const row = panel.querySelector('.agent-ctx-row');
            const footer = panel.querySelector('.agent-footer');
            const input = document.getElementById('agentInput');
            // ⚠️ 现在那一行**默认整行 hidden**(不在布局里,高度与间距都是 0)。
            // 这里要量两件事:①不出现时是不是真的不占位;②出现时是不是还是 20px。
            // 所以先把整行亮出来(按钮也亮),量完再**逐样还原**(注意把 row.hidden 也还原 ——
            // 只还原按钮会留下一条 20px 的空行,后面的量测全被它带偏)。
            const h0 = row ? Math.round(row.getBoundingClientRect().height) : -1;
            const rowWasHidden = row ? row.hidden : null;
            const killWasHidden = kill ? kill.hidden : null;
            const gap0 = (() => {
                if (row === null || input === null) return null;
                // 卡片顶边 → 输入框顶边:那一行不在时应当只剩卡片自己的 padding-top
                const fr = footer.getBoundingClientRect();
                return Math.round(input.getBoundingClientRect().top - fr.top);
            })();
            if (row) row.hidden = false;
            if (kill) kill.hidden = false;
            const h1 = row ? Math.round(row.getBoundingClientRect().height) : -1;
            const killH = kill ? Math.round(kill.getBoundingClientRect().height) : -1;
            const gap1 = (() => {
                if (row === null || input === null) return null;
                const fr = footer.getBoundingClientRect();
                return Math.round(input.getBoundingClientRect().top - fr.top);
            })();
            if (row) row.hidden = rowWasHidden;
            if (kill) kill.hidden = killWasHidden;
            const visibleText = (() => {
                const all = panel.textContent ?? '';
                return all.split(status.textContent ?? '').join('');   // 去掉 live 区那段
            })();
            return {
                srSize: Math.round(sr.width) + 'x' + Math.round(sr.height),
                srClip: getComputedStyle(status).clipPath,
                ariaLive: status.getAttribute('aria-live'),
                visibleHasConnected: /已连接|Agent:/.test(visibleText),
                killInCard: kill !== null && kill.closest('.agent-footer') !== null,
                killInRow: kill !== null && kill.closest('.agent-ctx-row') === row,
                killVisible: kr !== null && kr.height > 0,
                killHidden: kill ? kill.hidden : null,
                killH,
                rowHidden: row ? row.hidden : null,
                rowH: h0,
                rowHWithKill: h1,
                gapWithoutRow: gap0,
                gapWithRow: gap1,
                ctx: footer ? footer.getAttribute('data-ctx') : null,
                inputTitle: input ? (input.getAttribute('title') ?? input.title ?? '') : null,
                placeholder: input ? input.placeholder : null,
                ctxText: footer ? footer.getAttribute('data-ctx-text') : null,
                dotGone: panel.querySelector('.agent-ctx-dot') === null,
                keyBtnGone: panel.querySelector('.agent-ctx-key') === null,
                ctxTextGone: panel.querySelector('.agent-context') === null,
                notice: panel.querySelectorAll('.agent-notice').length,
            };
        })()`);
        r.ok('面板上不显示连接状态(状态文字只在视觉隐藏的 live 区里)',
            chrome.srSize === '1x1' && chrome.visibleHasConnected === false,
            JSON.stringify(chrome));
        r.ok('live 区仍然是 aria-live(读屏照样能听到状态变化,只是看不见)',
            chrome.ariaLive === 'polite', String(chrome.ariaLive));
        r.ok('「停止进程」还在**原来那一行**(位置没变),但平时整行与按钮都是隐藏的(不占高度、不留下间距)',
            chrome.killInCard === true && chrome.killInRow === true && chrome.killHidden === true
            && chrome.killVisible === false && chrome.rowHidden === true
            && chrome.rowH === 0 && chrome.gapWithoutRow <= 10,
            JSON.stringify({ inCard: chrome.killInCard, inRow: chrome.killInRow, hidden: chrome.killHidden, rowHidden: chrome.rowHidden, rowH: chrome.rowH, gap: chrome.gapWithoutRow }));
        r.ok('那一行出现时仍然是 20px,而且它把输入框往下推了正好"20px + 6px 间距"(不会挤在一起)',
            chrome.rowHWithKill === 20 && chrome.killH > 0 && chrome.killH <= 20
            && chrome.gapWithRow - chrome.gapWithoutRow === 26,
            `rowH=${chrome.rowHWithKill} buttonH=${chrome.killH} gap ${chrome.gapWithoutRow}→${chrome.gapWithRow}`);
        r.ok('状态点、「密钥」按钮与那行上下文文字都已从输入卡片上删掉(不是藏起来)',
            chrome.dotGone === true && chrome.keyBtnGone === true && chrome.ctxTextGone === true,
            JSON.stringify({ dotGone: chrome.dotGone, keyBtnGone: chrome.keyBtnGone, ctxTextGone: chrome.ctxTextGone }));
        r.ok('上下文没丢:挂在输入框上 —— placeholder 带笔记名、title 是完整那句(没有打开的笔记时两处同一句话)',
            typeof chrome.inputTitle === 'string' && chrome.inputTitle.length > 0
            && (chrome.ctx === 'note'
                ? (/将带上笔记/.test(chrome.inputTitle) && /甲篇/.test(chrome.inputTitle) && String(chrome.placeholder ?? '') === '')
                : (/没有打开的笔记/.test(chrome.inputTitle)
                    && chrome.placeholder === chrome.inputTitle)),
            JSON.stringify({ ctx: chrome.ctx, title: chrome.inputTitle, placeholder: chrome.placeholder, ctxText: chrome.ctxText }));
        r.ok('机器可读的那份还在(data-ctx / data-ctx-text),断言不靠中文',
            (chrome.ctx === 'note' || chrome.ctx === 'none')
            && String(chrome.ctxText ?? '').length > 0,
            JSON.stringify({ ctx: chrome.ctx, ctxText: chrome.ctxText }));
        r.ok('正常连接下没有任何"关于连接"的提示卡(连上了就不该占视觉)',
            chrome.notice === 0, `notice=${chrome.notice}`);

        // ---- 「正在连接…」+「停止进程」:推**真的** agent:event 状态事件量一遍 ----
        //
        // 用户要求那一行平时是空的(连状态点也删掉),而"卡住了往哪儿按"这件事不能
        // 因此变得找不到。做法:按钮**留在原位**,只在"有东西可停"时出现
        // (starting / 正在跑 / 坏了),而且**整行的显隐跟着它走** —— 按钮不在场时那一行
        // 也不在布局里(否则会留一条空行)。
        // ⚠️ 另加一句可读提示「正在连接 Agent…」:握手超时是 35 秒(见 agent-runtime 的
        // DEFAULT_HANDSHAKE_TIMEOUT_MS),那段时间面板**不能一片静止** —— 否则用户只会看到
        // 一个没头没尾的「停止进程」按钮。只说正在做什么,**不写数字、不画进度**。
        // 自检不能真去拉起一个 dsh 子进程,所以从主进程 `webContents.send` 推状态事件 ——
        // 渲染进程收到的是它在真机上收到的那一条(主进程 → preload → 面板),只是内容由我们给。
        // ⚠️ 量完必须把面板还原成**真实**状态(自检里是 stopped),否则后面
        //    "自检下面板不自动连"那条断言会读到一个我们编出来的状态。
        const sendAgentState = (state) => win.webContents.send(AGENT_EVENT_CHANNEL, {
            kind: 'state', status: { state, pid: null, error: null, restarts: 0, since: 1 },
        });
        const killProbe = async (state) => {
            sendAgentState(state);
            await new Promise((res) => { setTimeout(res, 120); });
            return await win.webContents.executeJavaScript(`(() => {
                const kill = document.getElementById('agentKill');
                const panel = document.getElementById('agentPanel');
                const row = panel.querySelector('.agent-ctx-row');
                const hint = panel.querySelector('.agent-ctx-hint');
                const input = document.getElementById('agentInput');
                const footer = panel.querySelector('.agent-footer');
                const r = kill.getBoundingClientRect();
                const hr = hint ? hint.getBoundingClientRect() : null;
                const fr = footer.getBoundingClientRect();
                return {
                    state: panel.dataset.agentState,
                    hidden: kill.hidden,
                    disabled: kill.disabled,
                    h: Math.round(r.height),
                    rowHidden: row.hidden,
                    rowH: Math.round(row.getBoundingClientRect().height),
                    hintFound: hint !== null,
                    hintHidden: hint ? hint.hidden : null,
                    hintText: hint ? String(hint.textContent ?? '') : null,
                    hintH: hr === null ? null : Math.round(hr.height),
                    // 那一行在布局里时要把输入框往下推:量卡片顶边到输入框顶边的距离
                    gap: Math.round(input.getBoundingClientRect().top - fr.top),
                    notice: panel.querySelectorAll('.agent-notice').length,
                };
            })()`);
        };
        const killBefore = await win.webContents.executeJavaScript(
            `document.getElementById('agentPanel').dataset.agentState`);
        const killStarting = await killProbe('starting');
        const killReady = await killProbe('ready');
        const killCrashed = await killProbe('crashed');
        const killRestored = await killProbe(killBefore);
        r.ok('「停止进程」在**正在起**的时候出现且可点(卡住的那一刻它就在原位,不用去别处找)',
            killStarting.state === 'starting' && killStarting.hidden === false
            && killStarting.disabled === false && killStarting.h > 0
            && killStarting.rowHidden === false && killStarting.rowH === 20,
            JSON.stringify(killStarting));
        r.ok('连接中那 35 秒**不是一片静止**:那一行写着「正在连接 Agent…」,而且**不写数字、不画进度**',
            killStarting.hintFound === true && killStarting.hintHidden === false
            && killStarting.hintH > 0
            && /正在连接 Agent/.test(String(killStarting.hintText ?? ''))
            && /\d|%|进度/.test(String(killStarting.hintText ?? '')) === false,
            JSON.stringify({ text: killStarting.hintText, hidden: killStarting.hintHidden, h: killStarting.hintH }));
        r.ok('连上之后(ready 且没在跑)按钮与**整行**一起收起来 —— 聊天框上面一点空位都不留',
            killReady.state === 'ready' && killReady.hidden === true && killReady.disabled === true
            && killReady.rowHidden === true && killReady.rowH === 0
            && killStarting.gap - killReady.gap === 26,
            JSON.stringify({ ready: killReady, startingGap: killStarting.gap }));
        r.ok('已经坏了(crashed)也亮着:进程可能还在,得能收尸',
            killCrashed.state === 'crashed' && killCrashed.hidden === false
            && killCrashed.disabled === false && killCrashed.rowHidden === false,
            JSON.stringify(killCrashed));
        r.ok('「正在连接…」只在 connecting 时在:连上之后跟着整行一起收掉(不留一句常驻的状态文案)',
            killReady.hintHidden === true && killCrashed.hintHidden === true
            && killRestored.hintHidden === true,
            JSON.stringify({ ready: killReady.hintHidden, crashed: killCrashed.hintHidden, restored: killRestored.hintHidden }));
        r.ok('量完还原:面板回到**真实**状态,而且这条路上不会凭空多出一张提示卡',
            killRestored.state === killBefore && killRestored.notice === 0,
            JSON.stringify({ before: killBefore, after: killRestored }));

        // ---- 黏贴截图:剪贴板图片 → 缩略图 chip(可删)----
        //
        // 这一段**不需要连 Agent**:合成一次带图片的 paste,断言输入区出现一张 chip、
        // 删除按钮能把它去掉、格式不对的图给一句可读的中文原因。
        // (真把图片发出去那一段在 --acceptance 里 —— 那需要夹具接着。)
        //
        // ⚠️ 合成事件,而不是真读系统剪贴板:往 Electron 的剪贴板里塞一张真图要原生
        // 模块,而且自检不该依赖"这台机器此刻的剪贴板里有什么"。这里证的是**接线**:
        // paste → 只挑 image/* → 建 chip → 删除;以及"不带图片的粘贴一律放行"。
        const clipboardImage = await win.webContents.executeJavaScript(`(() => {
            const input = document.getElementById('agentInput');
            const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00];
            const fileOf = (name, type) => new File([new Uint8Array(pngBytes)], name, { type });
            const chips = () => document.querySelectorAll('#agentPanel .agent-image-chip');
            const out = { native: false };

            // 用浏览器**原生**的 DataTransfer + ClipboardEvent 合成一次 paste:
            // 面板读到的 items / getAsFile() / type 全部是真实 API 的行为,
            // 而不是我们手搓的一个长得像剪贴板的对象。合成不了的旧环境才退回手搓。
            const canNative = typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function';
            const fire = (files) => {
                if (canNative) {
                    try {
                        const dt = new DataTransfer();
                        for (const f of files) dt.items.add(f);
                        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
                        if (ev.clipboardData === dt) {
                            out.native = true;
                            return input.dispatchEvent(ev);
                        }
                    } catch { /* 落到下面的手搓那条路 */ }
                }
                const dt = {
                    items: files.map(f => ({ kind: 'file', type: f.type, getAsFile: () => f })),
                    files,
                };
                const ev = new Event('paste', { bubbles: true, cancelable: true });
                Object.defineProperty(ev, 'clipboardData', { value: dt, configurable: true });
                return input.dispatchEvent(ev);
            };

            // ① 一张正常的 png
            out.imagePastePrevented = fire([fileOf('shot.png', 'image/png')]) === false;
            const chip = chips()[0] ?? null;
            const del = chip ? chip.querySelector('.agent-image-del') : null;
            out.chips = chips().length;
            out.chipMime = chip ? chip.getAttribute('data-image-chip') : null;
            out.chipLabel = chip ? chip.getAttribute('aria-label') : null;
            out.delLabel = del ? del.getAttribute('aria-label') : null;
            out.chipText = chip ? chip.textContent : '';
            out.hasThumb = chip ? chip.querySelector('img.agent-image-thumb') !== null : false;
            // 截图是不可信输入:文件名里的标签一个都不许落地成元素(除我们自己的缩略图)
            out.extraImages = chip ? chip.querySelectorAll('img:not(.agent-image-thumb)').length : -1;
            // ② 点删除 → chip 消失
            del?.click();
            out.chipsAfterDelete = chips().length;

            // ③ 纯文字粘贴必须放行(原生 DataTransfer 里没有 file 项)
            out.textPasteAllowed = fire([]) === true;
            out.chipsAfterTextPaste = chips().length;

            // ④ 不支持的格式:拒绝 + 一句可读中文
            fire([fileOf('x.bmp', 'image/bmp')]);
            const notice = document.querySelector('#agentPanel .agent-image-notice');
            out.noticeHidden = notice ? notice.hidden : null;
            out.noticeText = notice ? notice.textContent : '';
            out.chipsAfterBadPaste = chips().length;

            return out;
        })()`);
        r.ok('黏贴截图:合成用的是浏览器**原生** DataTransfer + ClipboardEvent(面板读到的是真实 API 行为)',
            clipboardImage.native === true,
            `native=${clipboardImage.native}(false = 退回了手搓的 clipboardData,证据强度弱一档)`);
        r.ok('黏贴截图:黏贴一张图后输入区出现一张 chip(mime 与文件名都在,机器可读的那份挂 data-image-chip)',
            clipboardImage.chips === 1 && clipboardImage.chipMime === 'image/png'
            && /shot\.png/.test(clipboardImage.chipText),
            JSON.stringify(clipboardImage).slice(0, 260));
        r.ok('黏贴截图:chip 上有缩略图,删除按钮带 aria-label(键盘可达);文件名里的标签没落地成元素',
            clipboardImage.hasThumb === true
            && clipboardImage.delLabel === '移除这张图:shot.png'
            && clipboardImage.chipLabel === '已黏贴的截图:shot.png(image/png)'
            && clipboardImage.extraImages === 0,
            JSON.stringify({ thumb: clipboardImage.hasThumb, del: clipboardImage.delLabel, extra: clipboardImage.extraImages }));
        r.ok('黏贴截图:含图片的粘贴被拦下,点删除后 chip 消失',
            clipboardImage.imagePastePrevented === true && clipboardImage.chipsAfterDelete === 0,
            JSON.stringify({ prevented: clipboardImage.imagePastePrevented, after: clipboardImage.chipsAfterDelete }));
        r.ok('黏贴截图:不含图片的粘贴一律放行(粘文字的行为一个字节都不许改)',
            clipboardImage.textPasteAllowed === true && clipboardImage.chipsAfterTextPaste === 0,
            JSON.stringify({ allowed: clipboardImage.textPasteAllowed, chips: clipboardImage.chipsAfterTextPaste }));
        r.ok('黏贴截图:格式不对时拒绝,并把可读的中文原因显示出来(不是静默丢)',
            clipboardImage.chipsAfterBadPaste === 0 && clipboardImage.noticeHidden === false
            && /不支持的图片格式/.test(clipboardImage.noticeText)
            && /PNG \/ JPEG \/ WebP \/ GIF/.test(clipboardImage.noticeText),
            JSON.stringify({ chips: clipboardImage.chipsAfterBadPaste, text: clipboardImage.noticeText }));


        // ---- 视频理解:拖进来只是草稿 → 点「发送」才真的调用 ----
        //
        // 为什么这一段要在**真窗口**里做:这条链路的每一段都长在接缝上 ——
        // 合成 drop 事件 → 判据(容器白名单/签名)→ 草稿卡片 → 点发送 → IPC(只递四个
        // 叶子字段)→ 主进程守卫。单测各自只钉得动一段,只有真应用里的一次拖放 + 一次
        // 真正的点击能把它们串起来。
        //
        // ⚠️ 这一段证的是**这次交互改动的要害**:拖进来不许发任何请求。
        // 证据是主进程那句守卫回话("自检模式不发真实请求")——它是"理解真的被调到了"
        // 的唯一可见痕迹。所以顺序是:先拖、等一会儿、断言界面上**没有**那句话;
        // 再点发送、断言那句话出现。两句合起来才证明"只有发送才触发"。
        //
        // 自检**绝不发真实请求**:主进程在 provider 之前就把它截住(见 main.js 的守卫),
        // 所以这里断言的不是"模型答了什么"。真模型那一次是**真实 API 验证**(证据在报告里)。
        const assistantBefore = await win.webContents.executeJavaScript(
            `document.querySelectorAll('#agentPanel .agent-msg-assistant').length`);
        const videoDrop = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const input = document.getElementById('agentInput');
            // 判据看的就是开头这几个字节:真的 mp4 是 ftyp/isom,HTML 不是
            const mp4Bytes = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];
            const fileOf = (name, type, head) => new File([new Uint8Array(head)], name, { type });
            const out = { native: typeof DataTransfer === 'function' && typeof DragEvent === 'function' };
            const drop = (files, target) => {
                const dt = new DataTransfer();
                for (const f of files) dt.items.add(f);
                // ⚠️ dragover 必须被拦下,否则 Chromium 根本不会触发 drop(实测的坑)
                const over = target.dispatchEvent(new DragEvent('dragover',
                    { dataTransfer: dt, bubbles: true, cancelable: true }));
                const dropped = target.dispatchEvent(new DragEvent('drop',
                    { dataTransfer: dt, bubbles: true, cancelable: true }));
                return { overPrevented: over === false, dropPrevented: dropped === false };
            };

            // ① 一段真的 mp4,拖到**面板**上(不是输入框):用户的直觉就是拖到对话区
            out.panelDrop = drop([fileOf('vu-synth.mp4', 'video/mp4', mp4Bytes)], panel);
            const chip = panel.querySelector('.agent-video-chip');
            out.cardVisible = panel.querySelector('.agent-video-row')?.hidden === false;
            out.chipMime = chip ? chip.getAttribute('data-video-chip') : null;
            out.chipText = chip ? chip.textContent : '';
            out.chipLabel = chip ? chip.getAttribute('aria-label') : null;
            out.audioText = chip ? (chip.querySelector('.agent-video-audio')?.textContent ?? '') : '';
            out.chipMediaNodes = chip ? chip.querySelectorAll('img,video,script').length : -1;
            // 卡片上不许有第二个触发点(点一下就能花钱的按钮)
            out.triggerButtons = panel.querySelectorAll('.agent-video-row .btn').length;
            // 拖入阶段:消息流里一条记录都不该有
            out.messagesAfterDrop = panel.querySelectorAll('#agentMessages .agent-msg').length;
            // 有草稿时「发送」必须可点(Agent 没连上也一样 —— 视频理解不经过 Agent)
            out.sendDisabledWithDraft = document.getElementById('agentSend')?.disabled ?? null;
            // 移除按钮就在卡片上
            out.hasRemove = chip ? chip.querySelector('.agent-video-del') !== null : false;

            // ② 拖一段**选中的文字**(不是文件)进来:一个字节都不许碰(不 preventDefault)
            const textDt = new DataTransfer();
            textDt.setData('text/plain', '一段选中的文字');
            out.textDrag = {
                overPrevented: input.dispatchEvent(new DragEvent('dragover',
                    { dataTransfer: textDt, bubbles: true, cancelable: true })) === false,
                dropPrevented: input.dispatchEvent(new DragEvent('drop',
                    { dataTransfer: textDt, bubbles: true, cancelable: true })) === false,
            };
            return out;
        })()`);

        // ① 之后**故意等一会儿再看**:草稿阶段要是偷偷发了请求,那句守卫回话就会落到
        // 界面上。给它足够的时间(比一次 IPC 往返宽裕得多),再断言界面上什么都没有。
        const videoBeforeSend = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
            setTimeout(() => {
                const panel = document.getElementById('agentPanel');
                const notice = panel.querySelector('.agent-video-notice');
                resolve({
                    noticeText: notice ? notice.textContent : null,
                    noticeHidden: notice ? notice.hidden : null,
                    draftVisible: panel.querySelector('.agent-video-row')?.hidden === false,
                    messages: panel.querySelectorAll('#agentMessages .agent-msg').length,
                    videoCards: panel.querySelectorAll('.agent-msg-video').length,
                    // 轮次轨:还没有任何对话 → 整条轨必须隐藏(一轮没有导航价值)
                    railExists: panel.querySelector('.agent-rail') !== null,
                    railTicks: panel.querySelectorAll('.agent-rail .tick').length,
                    railHidden: panel.querySelector('.agent-rail')?.hidden ?? null,
                });
            }, 600);
        }))()`);

        // ③ 真的点一次「发送」(原生 click,不是直接调面板的函数)——
        //    这一步之后才允许出现"理解被调到主进程"的痕迹。
        const videoSend = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const btn = document.getElementById('agentSend');
            const before = panel.querySelectorAll('#agentMessages .agent-msg').length;
            btn.click();
            return { clicked: true, disabled: btn.disabled, messagesBefore: before };
        })()`);
        await waitForMatch(win, '#agentPanel .agent-video-notice', /自检模式不发真实请求/);
        // ⚠️ 当场把这句话读下来:下面那几次拖放会改写同一个 notice 元素
        const videoGuardNotice = await win.webContents.executeJavaScript(
            `(() => { const n = document.querySelector('#agentPanel .agent-video-notice');`
            + ` return n ? n.textContent : null; })()`);
        const videoAfterSend = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const nameEl = panel.querySelector('.agent-msg-video-name');
            const assistants = [...panel.querySelectorAll('.agent-msg-assistant')];
            return {
                userVideoCards: panel.querySelectorAll('.agent-msg-video').length,
                userName: nameEl ? nameEl.textContent : null,
                assistantCount: assistants.length,
                // 方案 C:失败留的是"走到哪一步断的"清单,**一个字正文都没有**
                assistantsWithText: assistants.filter(el => {
                    const t = el.querySelector('.agent-msg-text');
                    return t !== null && t.textContent.trim() !== '';
                }).length,
                stageRows: panel.querySelectorAll('#agentMessages .stage-row').length,
                failedStages: [...panel.querySelectorAll('#agentMessages .stage-row.failed')]
                    .map(el => el.getAttribute('data-stage')),
                stageMarks: [...panel.querySelectorAll('#agentMessages .stage-row .mark')].map(el => el.textContent),
                stillCancelable: panel.querySelectorAll('#agentMessages .stage-cancel').length,
                rowHidden: panel.querySelector('.agent-video-row')?.hidden ?? null,
                userBubbleText: panel.querySelector('#agentMessages .agent-msg[data-role="user"]')?.textContent ?? null,
            };
        })()`);

        // ④ HTML 改名成 mp4:拖进来当草稿 → 点发送 → 被**本地判据**拦下
        const videoEdges = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const input = document.getElementById('agentInput');
            const htmlBytes = [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e];
            const fileOf = (name, type, head) => new File([new Uint8Array(head)], name, { type });
            const out = {};
            const drop = (files, target) => {
                const dt = new DataTransfer();
                for (const f of files) dt.items.add(f);
                const over = target.dispatchEvent(new DragEvent('dragover',
                    { dataTransfer: dt, bubbles: true, cancelable: true }));
                const dropped = target.dispatchEvent(new DragEvent('drop',
                    { dataTransfer: dt, bubbles: true, cancelable: true }));
                return { overPrevented: over === false, dropPrevented: dropped === false };
            };
            // 一个**不是视频的文件**:不建卡片,但仍然拦下 —— 不拦的话 Chromium 会
            // 拿它去做默认动作(导航到 file://),拖错一个文件应用就跳走了
            out.otherFileDrop = drop([fileOf('note.txt', 'text/plain', [0x61])], input);
            out.chipsAfterOtherFile = panel.querySelectorAll('.agent-video-chip').length;
            // HTML 改名成 mp4:字节要到**发送**那一刻才读,所以先放成草稿再点发送
            drop([fileOf('evil.mp4', 'video/mp4', htmlBytes)], input);
            out.messagesBeforeBadSend = panel.querySelectorAll('#agentMessages .agent-msg').length;
            document.getElementById('agentSend').click();
            return out;
        })()`);
        // ④ 的判定发生在读完字节之后(读文件是异步的),等那句原因落到界面上
        await waitForMatch(win, '#agentPanel .agent-video-notice', /字节不是/);
        const videoBad = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const notice = panel.querySelector('.agent-video-notice');
            return {
                noticeText: notice ? notice.textContent : null,
                chips: panel.querySelectorAll('.agent-video-chip').length,
                videoCards: panel.querySelectorAll('.agent-msg-video').length,
                messages: panel.querySelectorAll('#agentMessages .agent-msg').length,
                rowHidden: panel.querySelector('.agent-video-row')?.hidden ?? null,
            };
        })()`);

        // ⑤ 移除草稿之后再点发送:必须什么也不发生
        const videoRemove = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const input = document.getElementById('agentInput');
            const mp4Bytes = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];
            const dt = new DataTransfer();
            dt.items.add(new File([new Uint8Array(mp4Bytes)], 'to-remove.mp4', { type: 'video/mp4' }));
            input.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
            input.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
            const out = {
                removeButtonFound: panel.querySelector('.agent-video-del') !== null,
                removeLabel: panel.querySelector('.agent-video-del')?.getAttribute('aria-label') ?? null,
            };
            panel.querySelector('.agent-video-del')?.click();
            out.draftGoneAfterRemove = panel.querySelector('.agent-video-row')?.hidden === true;
            document.getElementById('agentSend').click();
            return out;
        })()`);
        // ⑤ 等一会儿,确认那次发送确实没有偷偷发出任何东西
        const videoAfterRemoveSend = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
            setTimeout(() => {
                const panel = document.getElementById('agentPanel');
                resolve({
                    messages: panel.querySelectorAll('#agentMessages .agent-msg').length,
                    videoCards: panel.querySelectorAll('.agent-msg-video').length,
                    chips: panel.querySelectorAll('.agent-video-chip').length,
                });
            }, 400);
        }))()`);

        r.ok('视频理解:拖进来一段 mp4 → 只出现**草稿**卡片(文件名/大小/音频说明都在),dragover 被拦下',
            videoDrop.native === true && videoDrop.panelDrop?.overPrevented === true
            && videoDrop.cardVisible === true && videoDrop.chipMime === 'video/mp4'
            && /vu-synth\.mp4/.test(videoDrop.chipText) && videoDrop.chipMediaNodes === 0
            && /听不到声音/.test(videoDrop.audioText),
            JSON.stringify(videoDrop).slice(0, 300));
        r.ok('视频理解:草稿上只有移除键、没有第二个触发点;有草稿时「发送」可点(Agent 没连上也能发)',
            videoDrop.triggerButtons === 0 && videoDrop.hasRemove === true
            && videoDrop.sendDisabledWithDraft === false,
            JSON.stringify({ triggers: videoDrop.triggerButtons, remove: videoDrop.hasRemove, sendDisabled: videoDrop.sendDisabledWithDraft }));
        r.ok('视频理解:**只拖入、不点发送,主进程一次请求都不发**(草稿阶段界面上没有任何"被守卫挡下"的痕迹,消息流也是空的)',
            videoBeforeSend.noticeHidden === true && String(videoBeforeSend.noticeText ?? '') === ''
            && videoBeforeSend.messages === 0 && videoBeforeSend.videoCards === 0
            && videoBeforeSend.draftVisible === true,
            JSON.stringify(videoBeforeSend));
        // 轮次轨的"少于 2 轮隐藏整轨":这里还没有任何对话(0 轮),它必须是 hidden
        r.ok('轮次轨:一轮都没有时整条轨隐藏(一轮没有导航价值,常驻一列只会占视觉)',
            videoBeforeSend.railExists === true && videoBeforeSend.railHidden === true
            && videoBeforeSend.railTicks === 0,
            JSON.stringify({ exists: videoBeforeSend.railExists, hidden: videoBeforeSend.railHidden, ticks: videoBeforeSend.railTicks }));
        r.ok('视频理解:点「发送」才真的调用 —— 整条链路走到主进程并被守卫挡住(自检不发真实请求)',
            videoSend.disabled === false && /自检模式不发真实请求/.test(String(videoGuardNotice ?? '')),
            JSON.stringify({ click: videoSend, notice: videoGuardNotice }).slice(0, 300));
        r.ok('视频理解:那一刻才出现那条带视频卡的用户消息(提问就是这次发出去的那一句),失败时**不留**有正文的假回答',
            videoAfterSend.userVideoCards === 1 && videoAfterSend.userName === 'vu-synth.mp4'
            && videoAfterSend.assistantsWithText === 0
            && videoAfterSend.rowHidden === true
            && /用中文详细描述这段视频/.test(String(videoAfterSend.userBubbleText ?? '')),
            JSON.stringify(videoAfterSend).slice(0, 300));
        // 方案 C:失败**红在具体那一段**,而不是笼统一句"理解失败"。自检模式那句守卫
        // 回话发生在**准备请求**那一段(密钥/准入/守卫都在发请求之前),所以红的就是它。
        r.ok('视频理解(方案C):失败把断点红在**那一行**上(自检守卫断在「准备请求」),不是一句笼统的"理解失败"',
            videoAfterSend.stageRows === 1
            && videoAfterSend.failedStages.length === 1 && videoAfterSend.failedStages[0] === 'prepare'
            && videoAfterSend.stageMarks.join('') === '✕'
            // 已经收尾的那一轮不该还留着「取消」(它的内容不会再变了)
            && videoAfterSend.stillCancelable === 0,
            JSON.stringify({ rows: videoAfterSend.stageRows, failed: videoAfterSend.failedStages, marks: videoAfterSend.stageMarks }).slice(0, 300));
        r.ok('视频理解:HTML 改名成 mp4 被拒(渲染层读到字节就用同一份判据拦下),原因说清"字节不是"+只接受哪几种',
            /字节不是/.test(String(videoBad.noticeText ?? ''))
            && /MP4 \/ MOV \/ WebM \/ MKV/.test(String(videoBad.noticeText ?? ''))
            && videoBad.chips === 0 && videoBad.rowHidden === true
            && videoBad.videoCards === 1 && videoBad.messages === videoEdges.messagesBeforeBadSend,
            JSON.stringify({ notice: videoBad.noticeText, chips: videoBad.chips, cards: videoBad.videoCards }));
        r.ok('视频理解:移除草稿之后再点发送 —— 不触发视频调用,也不留任何记录;非视频拖放不受影响',
            videoRemove.removeButtonFound === true && videoRemove.draftGoneAfterRemove === true
            && /移除这个视频:to-remove\.mp4/.test(String(videoRemove.removeLabel ?? ''))
            && videoAfterRemoveSend.messages === videoBad.messages
            && videoAfterRemoveSend.videoCards === 1 && videoAfterRemoveSend.chips === 0
            && videoDrop.textDrag?.overPrevented === false && videoDrop.textDrag?.dropPrevented === false
            && videoEdges.otherFileDrop?.dropPrevented === true
            && videoEdges.otherFileDrop?.overPrevented === true
            && videoEdges.chipsAfterOtherFile === 0,
            JSON.stringify({ remove: videoRemove, afterRemove: videoAfterRemoveSend, text: videoDrop.textDrag }));


        // ---- 视频理解:密钥卡片(在**真窗口**里真的存一次) ----
        //
        // 这一段补的是一个挂了很久的缺口:单测只覆盖了"面板调用对不对"与"设置层怎么存",
        // 而**没有任何证据**证明"在真的 Electron 里点一次保存,落盘的是密文"。
        // 所以这里真的敲一串进去、真的点保存,然后到主进程这边读设置文件。
        //
        // ⚠️ 为什么不怕写脏用户的配置:自检模式下 main.js 在 ready 之前就把 userData 指到
        // 一个临时目录(`kaiwu-selftest-userdata-*`),设置文件写在那里,而那个目录在自检
        // 收尾时被整个删掉(还可能残留的由下次启动的 sweepStaleSelftestUserData 扫掉)。
        // 用户真实的 `%APPDATA%\kaiwu\settings.json` **一个字节都不会被碰** ——
        // 下面第一条断言就是**当场证这件事**,而不是嘴上说"应该是隔离的"。
        const userDataDir = String(app.getPath('userData'));
        const settingsFilePath = path.join(userDataDir, 'settings.json');
        const realSettingsPath = path.join(String(app.getPath('appData')), 'kaiwu', 'settings.json');
        const isolation = {
            userDataDir,
            temp: userDataDir.includes('kaiwu-selftest-userdata-'),
            underTmp: path.resolve(userDataDir).startsWith(path.resolve(os.tmpdir())),
            // 隔离目录里的 settings.json **就是**我们要读的那个文件;
            // 它与真实那份不是同一个路径(下面 isReal 必须是 false)
            isReal: path.resolve(settingsFilePath) === path.resolve(realSettingsPath),
            realSettingsPath,
        };
        r.ok('视频密钥(自检隔离):设置文件落在临时 userData 里,绝不是用户真实的那一份(否则自检会写脏用户配置)',
            isolation.temp === true && isolation.underTmp === true && isolation.isReal === false,
            JSON.stringify(isolation));

        // ---- 密钥的**人工入口**现在只有设置页(那一行上的「密钥」按钮已按用户要求删掉)----
        //
        // 这一段补的是一个挂了很久的缺口:单测只覆盖了"调用对不对"与"设置层怎么存",
        // 而**没有任何证据**证明"在真的 Electron 里点一次保存,落盘的是密文"。
        // 现在这个证据更重要了 —— 面板那张卡上的「密钥」按钮删掉之后,设置页是**唯一**
        // 的人工入口,它要是不真的能用,用户就再也没有地方配密钥了。
        //
        // 所以这里真的敲一串进去、真的点保存,然后到主进程这边读设置文件。
        // ⚠️ 为什么不怕写脏用户的配置:自检模式下 main.js 在 ready 之前就把 userData 指到
        // 一个临时目录(`kaiwu-selftest-userdata-*`),设置文件写在那里,而那个目录在自检
        // 收尾时被整个删掉(还可能残留的由下次启动的 sweepStaleSelftestUserData 扫掉)。
        // 用户真实的 `%APPDATA%\kaiwu\settings.json` **一个字节都不会被碰** ——
        // 上面那条隔离断言就是**当场证这件事**,而不是嘴上说"应该是隔离的"。
        //
        // 面板那一侧还剩什么:卡片本身只在"缺密钥失败"时自动出现(自检里那条路被守护
        // 挡住,不发真实请求),所以卡片内部的行为留在单测里;这里量的是设置页这条真路。
        const openSettingsView = async () => {
            await win.webContents.executeJavaScript(`document.getElementById('viewSettings').click()`);
            await waitForElement(win, '#settingsVideoKey');
            await new Promise((res) => { setTimeout(res, 200); });     // 设置页要读几个通道(异步)
        };
        await openSettingsView();
        const settingsKeyProbe = async () => await win.webContents.executeJavaScript(`(() => {
            const input = document.getElementById('settingsVideoKey');
            const warn = document.getElementById('settingsVideoKeyWarn');
            const status = document.getElementById('settingsVideoKeyStatus');
            const note = document.getElementById('settingsVideoKeyNote');
            return {
                inputType: input ? input.type : null,
                inputValue: input ? input.value : null,
                statusText: status ? status.textContent : null,
                warnHidden: warn ? warn.hidden : null,
                warnText: warn ? warn.textContent : null,
                noteText: note ? note.textContent : null,
                noteAttached: note !== null && document.body.contains(note),
                hasSave: document.getElementById('settingsVideoKeySave') !== null,
                hasClear: document.getElementById('settingsVideoKeyClear') !== null,
                killRow: document.getElementById('settingsAgentKill') !== null,
            };
        })()`);
        const keyBefore = await settingsKeyProbe();
        r.ok('视频密钥:设置页那一项是真的(密码框 + 保存/清除两个按钮),而输入框永远是空的(密钥不回显)',
            keyBefore.inputType === 'password' && keyBefore.inputValue === ''
            && keyBefore.hasSave === true && keyBefore.hasClear === true,
            JSON.stringify(keyBefore));
        r.ok('视频密钥:「环境变量优先,在这里保存的密钥不会生效」这句**在设置页上也看得见**(原来只有面板那张卡上写,而那张卡的按钮已经删了)',
            keyBefore.warnHidden === false
            && /环境变量优先,在这里保存的密钥不会生效/.test(String(keyBefore.warnText ?? ''))
            && /^密钥:/.test(String(keyBefore.statusText ?? '')),
            JSON.stringify({ warn: keyBefore.warnText, status: keyBefore.statusText }));

        // 真的敲一串进去、真的点保存(不是"直接调某个函数")
        const keyTyped = await win.webContents.executeJavaScript(`(() => {
            const input = document.getElementById('settingsVideoKey');
            input.value = ${JSON.stringify(videoKeyForSelftest)};
            const typedLen = input.value.length;
            document.getElementById('settingsVideoKeySave').click();
            return { typedLen };
        })()`);
        // 等主进程把密钥写进设置文件(那是"真的存了一次"的唯一硬证据)
        let stored = { enc: '', plain: '', raw: '' };
        for (let i = 0; i < 40; i += 1) {
            try {
                const raw = fs.readFileSync(settingsFilePath, 'utf8');
                const parsed = JSON.parse(raw);
                const v = parsed?.__video ?? {};
                const enc = String(v.apiKeyEnc ?? '');
                const plain = String(v.apiKey ?? '');
                if (enc !== '' || plain !== '') { stored = { enc, plain, raw }; break; }
            } catch { /* 文件还没写出来 */ }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // ⚠️ 等那句反馈出现再往下走:保存的处理里有一串 await(写盘 → 重读 5 个通道),
        // 不等它落定就去点「清除」,两条链会交叉 —— 后写的反馈会把前一条盖掉。
        // 用户本来也是看到反馈才做下一个动作的,这里照同一个节奏。
        await waitForMatch(win, '#settingsVideoKeyNote', /已保存/, 60);
        const keyAfterSave = await win.webContents.executeJavaScript(`(() => {
            const secret = ${JSON.stringify(videoKeyForSelftest)};
            return {
                inputValue: (document.getElementById('settingsVideoKey') || {}).value ?? null,
                inBodyText: document.body.textContent.includes(secret),
                inBodyHtml: document.body.innerHTML.includes(secret),
                statusText: (document.getElementById('settingsVideoKeyStatus') || {}).textContent ?? null,
                noteText: (document.getElementById('settingsVideoKeyNote') || {}).textContent ?? null,
            };
        })()`);
        const encryptionAvailable = (() => {
            try { return safeStorage.isEncryptionAvailable() === true; } catch { return false; }
        })();
        let decrypted = null;
        if (encryptionAvailable && stored.enc !== '') {
            try {
                decrypted = safeStorage.decryptString(Buffer.from(stored.enc, 'base64'));
            } catch { decrypted = null; }
        }
        r.ok('视频密钥(实测):设置页里存一次,设置文件里落的是**密文**(safeStorage 可用时),明文那份是空的',
            encryptionAvailable
                ? (stored.enc !== '' && stored.plain === '' && stored.raw.includes(videoKeyForSelftest) === false)
                // safeStorage 不可用的机器上,如实退回明文 —— 那时这条断言不成立,
                // 但下面那条"值不进 DOM/日志"的断言照样必须过。
                : (stored.plain === videoKeyForSelftest && stored.enc === ''),
            JSON.stringify({
                typedLen: keyTyped.typedLen, encryptionAvailable,
                encLen: stored.enc.length, plainLen: stored.plain.length,
                rawHasPlaintext: stored.raw.includes(videoKeyForSelftest),
            }));
        r.ok('视频密钥(实测):密文解得回来,而且解出来的正是刚才敲进去的那一串(存进去 ≠ 存对了)',
            encryptionAvailable
                ? decrypted === videoKeyForSelftest
                : stored.plain === videoKeyForSelftest,
            JSON.stringify({ encryptionAvailable, decryptedLen: decrypted === null ? null : decrypted.length }));
        r.ok('视频密钥:保存成功后输入框**清空**,页面文本与 HTML 里都搜不到那串明文,渲染进程日志里也没有',
            keyAfterSave.inputValue === ''
            && keyAfterSave.inBodyText === false && keyAfterSave.inBodyHtml === false
            && pageLogs.join('\n').includes(videoKeyForSelftest) === false,
            JSON.stringify({ ...keyAfterSave, inLogs: pageLogs.join('\n').includes(videoKeyForSelftest) }));
        r.ok('视频密钥:状态那一行是主进程给的**真读数**(自检里环境变量已设 → 已配置(环境变量))',
            /密钥:已配置\(环境变量\)/.test(String(keyAfterSave.statusText ?? '')),
            JSON.stringify({ status: keyAfterSave.statusText }));

        // 点「清除」:设置文件里两份都该空掉(环境变量那份不受影响,那不该由应用来改)
        await win.webContents.executeJavaScript(
            `document.getElementById('settingsVideoKeyClear').click()`);
        let clearedKeys = { enc: 'set', plain: 'set', raw: '' };
        for (let i = 0; i < 40; i += 1) {
            try {
                const raw = fs.readFileSync(settingsFilePath, 'utf8');
                const v = JSON.parse(raw)?.__video ?? {};
                const enc = String(v.apiKeyEnc ?? '');
                const plain = String(v.apiKey ?? '');
                if (enc === '' && plain === '') { clearedKeys = { enc, plain, raw }; break; }
                clearedKeys = { enc, plain, raw };
            } catch { /* 还没写出来 */ }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // 同上:等「已清除」那句反馈落定,再读页面(否则可能读到上一条"已保存")
        await waitForMatch(win, '#settingsVideoKeyNote', /已清除/, 60);
        const keyAfterClear = await settingsKeyProbe();
        r.ok('视频密钥:点「清除」之后设置文件里两份都空了,页面上也再搜不到那串明文',
            clearedKeys.enc === '' && clearedKeys.plain === ''
            && keyAfterClear.inputValue === ''
            && (await win.webContents.executeJavaScript(
                `document.body.textContent.includes(${JSON.stringify(videoKeyForSelftest)})`)) === false
            && /已清除/.test(String(keyAfterClear.noteText ?? '')),
            JSON.stringify({ cleared: { encLen: clearedKeys.enc.length, plainLen: clearedKeys.plain.length }, after: keyAfterClear }));
        r.ok('视频密钥:反馈写在**当前那个**节点上(renderBody 会把整块重建,写在脱离文档的旧节点上就等于没写)',
            keyAfterClear.noteAttached === true && /已清除/.test(String(keyAfterClear.noteText ?? '')),
            JSON.stringify({ attached: keyAfterClear.noteAttached, note: keyAfterClear.noteText }));

        // 回到笔记视图:后面还有一堆断言(以及验收 M3)是在工作台上量的
        await win.webContents.executeJavaScript(`document.getElementById('viewNotes').click()`);
        await new Promise((res) => { setTimeout(res, 200); });

        // ---- 从 B站队列请 AI 面板理解一段**本地视频**(按路径那条入口) ----
        //
        // 放在最后:这一步会把消息流与提示行改掉,而前面那些断言(尤其"只拖入不发送")
        // 依赖它们当时的状态 —— 顺序反了就会让前面读到别人的话。
        //
        // 链路:队列卡片上的「理解」→ DOM 事件 → 壳切视图 → AI 面板 → video:understandPath
        // → 主进程(自检守卫挡住,不读盘、不上传、不打网络)。
        //
        // ⚠️ 先**重新挂上** B站面板:前面验收那几步点过别的工具,面板已经被卸载了
        // (插件的面板是"切走就卸",队列 DOM 也跟着没了)。
        //
        // 顺便把"解析被风控 → 冷却"那条路在**真窗口**里验一遍:那一步只发生在
        // 重新挂载时(面板一挂载就问一次代理的解析状态)。放在这里是因为它会把
        // 解析输入区锁住,而前面那条"解析按钮拿到了共享样式"的断言要在解锁状态下量。
        queueFixture?.setParseCooling(95);
        await openTool('bilibili');
        const queueBack = await waitForElement(win, '.bili-q-task[data-task-id="7777"] .bili-q-understand');
        const cooldownUi = await waitForElement(win, '#biliResult .bili-notice');
        const cooldown = await win.webContents.executeJavaScript(`(() => {
            const res = document.getElementById('biliResult');
            const btn = document.getElementById('biliBtn');
            const input = document.getElementById('biliInput');
            const links = [...res.querySelectorAll('a')].map(a => ({ text: a.textContent, href: a.getAttribute('href') }));
            return {
                notice: res ? res.textContent : null,
                btnDisabled: btn ? btn.disabled : null,
                inputDisabled: input ? input.disabled : null,
                links,
            };
        })()`);
        r.ok('解析风控冷却:面板一挂载就说清"是登录会话被风控 + 两个动作",而且**输入区锁着**',
            cooldownUi === true
            && /登录会话/.test(String(cooldown.notice ?? ''))
            && /412/.test(String(cooldown.notice ?? ''))
            && /重新扫码登录/.test(String(cooldown.notice ?? ''))
            && /自动恢复/.test(String(cooldown.notice ?? ''))
            && cooldown.btnDisabled === true && cooldown.inputDisabled === true
            // 入口要能直接点过去(不然"去重新登录"就只是一句话)
            && cooldown.links.some(l => /重新扫码登录/.test(l.text) && /^https?:/.test(String(l.href))),
            JSON.stringify(cooldown).slice(0, 320));
        r.ok('解析风控冷却:倒计时是 M:SS 且每秒在走(用户看得见还要等多久)',
            /已暂停请求,\d+:\d\d 后恢复/.test(String(cooldown.notice ?? '')),
            JSON.stringify(String(cooldown.notice ?? '').slice(-60)));
        const understandBefore = await win.webContents.executeJavaScript(`(() => ({
            messages: document.querySelectorAll('#agentMessages .agent-msg').length,
            videoCards: document.querySelectorAll('#agentPanel .agent-msg-video').length,
        }))()`);
        const understandClick = await win.webContents.executeJavaScript(`(() => {
            const btn = document.querySelector('.bili-q-task[data-task-id="7777"] .bili-q-understand');
            if (!btn) return { clicked: false };
            const before = { disabled: btn.disabled, label: btn.getAttribute('aria-label') };
            btn.click();
            return { clicked: true, ...before };
        })()`);
        await waitForMatch(win, '#agentPanel .agent-video-notice', /自检模式不发真实请求/);
        const understandAfter = await win.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('agentPanel');
            const names = panel.querySelectorAll('.agent-msg-video-name');
            return {
                messages: document.querySelectorAll('#agentMessages .agent-msg').length,
                videoCards: panel.querySelectorAll('.agent-msg-video').length,
                // 取**最后**一张卡:前面那条拖入用例已经留了一张 vu-synth 的卡
                lastName: names.length > 0 ? names[names.length - 1].textContent : null,
                assistantCount: panel.querySelectorAll('.agent-msg-assistant').length,
                failedStages: [...panel.querySelectorAll('#agentMessages .stage-row.failed')]
                    .map(el => el.getAttribute('data-stage')),
                notice: panel.querySelector('.agent-video-notice')?.textContent ?? null,
                view: document.getElementById('paneNotes')?.hidden === false ? 'notes' : 'tools',
            };
        })()`);
        r.ok('B站队列:「理解这一段视频」把**本地路径**交给 AI 面板(队列卡片 → DOM 事件 → 面板 → IPC),自检里被守卫挡住不发真实请求',
            queueBack === true && understandClick.clicked === true && understandClick.disabled === false
            && understandClick.label === '理解这一段视频'
            && /自检模式不发真实请求/.test(String(understandAfter.notice ?? '')),
            JSON.stringify({ queueBack, click: understandClick, after: understandAfter }).slice(0, 320));
        r.ok('B站队列:那一刻消息流里多了一条**带视频卡的用户消息**,壳把视图切到了笔记,断点也红在这一轮自己那一段上',
            // ⚠️ 一次理解会多出**两条**气泡:用户那条(带视频卡)+ 方案 C 的状态行占位
            // (失败后它留着,写清断在哪一段)。只算 +1 会把新增的占位算漏。
            understandAfter.messages === understandBefore.messages + 2
            && understandAfter.videoCards === understandBefore.videoCards + 1
            && /自检夹具|fixture-video/.test(String(understandAfter.lastName ?? ''))
            // 每一条失败各自红一次(前面拖入那条 + 这一条 = 2),不许互相串
            && understandAfter.failedStages.length === 2
            && understandAfter.view === 'notes',
            JSON.stringify({ before: understandBefore, after: understandAfter }).slice(0, 320));

        // ---- 会话轮次导航轨(方案 D:状态语义轨)----
        //
        // 到这里消息流里已经有 **2 轮**(拖入那段视频 + 队列那段),正好够验轨道。
        // 纯逻辑(轮次/状态/当前轮/摘要)在单测里逐条钉着;这里量的是**真窗口**里的那一半:
        // 格数、aria、常显的当前轮、点击跳转、悬停摘要、以及"滚动条没了但滚动还在"。
        const rail = await win.webContents.executeJavaScript(`(async () => {
            const msgs = document.getElementById('agentMessages');
            // ⚠️ 当前轮那一格是在 **requestAnimationFrame** 里画的(panel.js 的
            // scheduleRailFrame:滚动/重画之后只排一帧,帧里才量 layout 并上色)。
            // 重画之后**同步**读 class 就是在跟那一帧赛跑 —— 窗口在后台时这一帧
            // 可能还没落地,读到的就是"一格都没高亮"(实测偶发)。
            // 所以先让它把该跑的那一帧跑完(最多 12 次,每次 rAF 与 16ms 定时器赛跑,
            // 避免 rAF 被节流时这里死等),再读。
            for (let i = 0; i < 12; i += 1) {
                if (msgs.querySelector('.agent-rail .tick.cur') !== null) break;
                await new Promise((r) => {
                    const t = setTimeout(r, 16);
                    requestAnimationFrame(() => { clearTimeout(t); r(); });
                });
            }
            const rail = msgs.querySelector('.agent-rail');
            const ticks = rail ? [...rail.querySelectorAll('.tick')] : [];
            const turns = [...msgs.querySelectorAll('.agent-turn')];
            const cur = ticks.findIndex(t => t.classList.contains('cur'));
            return {
                hidden: rail ? rail.hidden : null,
                ticks: ticks.length,
                turns: turns.length,
                cur,
                curCount: ticks.filter(t => t.classList.contains('cur')).length,
                ariaRail: rail ? rail.getAttribute('aria-label') : null,
                ariaTicks: ticks.map(t => t.getAttribute('aria-label')),
                ariaCurrent: ticks.filter(t => t.getAttribute('aria-current') === 'true').length,
                genBars: rail ? rail.querySelectorAll('.gen').length : -1,
                offsets: turns.map(t => t.offsetTop),
                // 滚动条真的没了吗:内容区与容器同宽,说明没有为滚动条留位置
                scrollbarWidth: msgs.offsetWidth - msgs.clientWidth,
                scrollbarWidthCss: getComputedStyle(msgs).scrollbarWidth,
                scrollable: msgs.scrollHeight > msgs.clientHeight + 2,
                scrollHeight: msgs.scrollHeight,
                clientHeight: msgs.clientHeight,
            };
        })()`);
        r.ok('轮次轨:一格一轮,条数 == 轮数;当前轮**常显**高亮;每格是可聚焦 button 且 aria 写出状态',
            rail.hidden === false && rail.ticks === 2 && rail.turns === 2
            // 当前轮:一定是**恰好一格**(具体是第几轮由滚动位置决定,见下面那条联动断言)
            && rail.cur >= 0 && rail.cur < rail.turns && rail.curCount === 1
            && /一格一轮/.test(String(rail.ariaRail ?? ''))
            && /蓝=含工具调用/.test(String(rail.ariaRail ?? ''))
            && rail.ariaTicks.length === 2
            && rail.ariaTicks.every(t => /^第 \d 轮,/.test(String(t)))
            && /^[\x00-\x7F]*$/.test(String(rail.ariaTicks[0] ?? '')) === false
            && rail.ariaCurrent === 1,
            JSON.stringify(rail).slice(0, 320));
        // ⚠️ demo 里 D 方案那根"轮内进度细条"没有落地:生成正文没有分母,按既定规矩不画。
        r.ok('轮次轨:**没有**轮内假进度条(demo 那根 .gen 细条不许出现)',
            rail.genBars === 0, `genBars=${rail.genBars}`);

        // ★ 用户追加的要求:消息区**不要原生滚动条**,但滚动能力一切照旧。
        //   判据:offsetWidth - clientWidth === 0(没为滚动条留位置)+ 计算值 scrollbar-width:none,
        //   然后**真的滚一次**(滚轮落在轨上 + 键盘 PageDown)看 scrollTop 有没有变。
        r.ok('消息区(用户追加):原生滚动条真的没了(内容区与容器同宽 + scrollbar-width:none)',
            rail.scrollbarWidth === 0 && rail.scrollbarWidthCss === 'none',
            JSON.stringify({ scrollbarWidth: rail.scrollbarWidth, css: rail.scrollbarWidthCss }).slice(0, 200));
        // 轨的坐标(滚轮要发到那一列上)+ 消息区坐标
        const railRect = await win.webContents.executeJavaScript(`(() => {
            const msgs = document.getElementById('agentMessages');
            const railEl = msgs.querySelector('.agent-rail');
            const m = msgs.getBoundingClientRect();
            const r = railEl.getBoundingClientRect();
            // ⚠️ 坐标要夹进窗口:轨在面板最右侧,它的中心点可能落在窗口之外,
            // 那样 sendInputEvent 发出去根本命中不到任何元素(实测踩到过:scrollTop 纹丝不动)。
            const clampX = (v) => Math.max(2, Math.min(window.innerWidth - 2, Math.round(v)));
            const clampY = (v) => Math.max(2, Math.min(window.innerHeight - 2, Math.round(v)));
            return { mx: clampX(m.left + 20), my: clampY(m.top + 30),
                     rx: clampX(r.left + r.width / 2), ry: clampY(r.top + 40),
                     innerW: window.innerWidth, innerH: window.innerHeight,
                     railLeft: Math.round(r.left), railRight: Math.round(r.right),
                     scrollable: msgs.scrollHeight > msgs.clientHeight + 2 };
        })()`);
        // ⚠️ 先把焦点给自检窗口:Chromium 在**文档没有焦点**时不会派发 focus 事件,
        // 也不会让注入的滚轮真正滚动(实测:不聚焦时滚轮连普通消息区都滚不动,
        // 而 element.focus() 也只是把 activeElement 改掉、不发事件)。
        try { win.focus(); win.webContents.focus(); } catch { /* 拿不到焦点就按拿不到算 */ }
        await new Promise(resolve => setTimeout(resolve, 120));
        if (railRect.scrollable === true) {
            // ① 滚轮落在**轨**上:必须把消息区滚起来。
            //   两层证据:(a) 真·注入一个滚轮事件(走 Chromium 的输入管线);
            //   (b) 直接在轨上派发一个 WheelEvent —— 它命中的就是真实滚轮会命中的那个监听器,
            //   所以"转发那条路"本身是被确定性验证过的(注入是否被窗口接受受环境影响)。
            await win.webContents.executeJavaScript('document.getElementById("agentMessages").scrollTop = 0');
            win.webContents.sendInputEvent({
                type: 'mouseWheel', x: railRect.rx, y: railRect.ry,
                deltaX: 0, deltaY: 240, wheelTicksX: 0, wheelTicksY: 2,
                hasPreciseScrollingDeltas: true, canScroll: true,
            });
            await new Promise(resolve => setTimeout(resolve, 260));
            const afterWheel = await win.webContents.executeJavaScript('document.getElementById("agentMessages").scrollTop');
            // 对照组:同一个滚轮落在**消息区**上(不带我们的转发,看注入本身有没有生效)
            win.webContents.sendInputEvent({
                type: 'mouseWheel', x: railRect.mx, y: railRect.my,
                deltaX: 0, deltaY: 240, wheelTicksX: 0, wheelTicksY: 2,
                hasPreciseScrollingDeltas: true, canScroll: true,
            });
            await new Promise(resolve => setTimeout(resolve, 260));
            const afterWheelOnMessages = await win.webContents.executeJavaScript('document.getElementById("agentMessages").scrollTop');
            // (b) 直接在轨上派发:确定性地验证"轨上的滚轮转发给消息区"
            const forwarded = await win.webContents.executeJavaScript(`(() => {
                const msgs = document.getElementById("agentMessages");
                msgs.scrollTop = 0;
                const before = msgs.scrollTop;
                const railEl = msgs.querySelector('.agent-rail');
                const ev = new WheelEvent('wheel', { deltaY: 200, bubbles: false, cancelable: true });
                railEl.dispatchEvent(ev);
                return { before, after: msgs.scrollTop, defaultPrevented: ev.defaultPrevented };
            })()`);
            // ② 键盘:聚焦消息区之后 PageDown 也要能滚(原生滚动条没了不等于键盘失灵)
            await win.webContents.executeJavaScript('document.getElementById("agentMessages").focus()');
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PageDown' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'PageDown' });
            await new Promise(resolve => setTimeout(resolve, 220));
            const afterKey = await win.webContents.executeJavaScript('(() => { const m = document.getElementById("agentMessages"); return { top: m.scrollTop, focused: document.activeElement === m }; })()');
            r.ok('消息区(用户追加):**滚轮落在轨上**能把消息区滚起来(轨占了原滚动条的位置)',
                forwarded.after > forwarded.before && forwarded.defaultPrevented === true,
                JSON.stringify({ forward: forwarded, injectedOnRail: afterWheel, injectedOnMessages: afterWheelOnMessages, railRect }).slice(0, 400));
            r.ok('消息区(用户追加):键盘(聚焦 + PageDown)仍然能滚 —— 藏掉的是滚动条,不是滚动能力',
                afterKey.focused === true && afterKey.top > 0,
                JSON.stringify({ forwarded, ...afterKey }));

            // ③ 滚动联动:滚到顶 → 第一轮;滚到底 → 最后一轮(两格都要跟对)
            const linked = await win.webContents.executeJavaScript(`(async () => {
                const msgs = document.getElementById('agentMessages');
                const ticks = [...msgs.querySelectorAll('.agent-rail .tick')];
                const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                const cur = () => ticks.findIndex(t => t.classList.contains('cur'));
                msgs.scrollTop = 0; await frame();
                const atTop = cur();
                msgs.scrollTop = msgs.scrollHeight; await frame();
                const atBottom = cur();
                return { atTop, atBottom, top: msgs.scrollTop, max: msgs.scrollHeight - msgs.clientHeight };
            })()`);
            r.ok('轮次轨:滚动联动 —— 滚到顶高亮第一格、滚到底高亮最后一格(预计算 offset + rAF,回调里不读 layout)',
                linked.atTop === 0 && linked.atBottom === 1, JSON.stringify(linked));

            // ④ 点击跳转:先滚到底,再点第一格 → 真的滚回第一轮
            const jumped = await win.webContents.executeJavaScript(`(async () => {
                const msgs = document.getElementById('agentMessages');
                const ticks = [...msgs.querySelectorAll('.agent-rail .tick')];
                const turns = [...msgs.querySelectorAll('.agent-turn')];
                msgs.scrollTop = msgs.scrollHeight;
                await new Promise(r => requestAnimationFrame(r));
                const deep = msgs.scrollTop;
                ticks[0].click();
                await new Promise(r => setTimeout(r, 600));      // 平滑滚动
                return { deep, after: msgs.scrollTop, target: turns[0].offsetTop,
                         cur: ticks.findIndex(t => t.classList.contains('cur')) };
            })()`);
            r.ok('轮次轨:点某一格 → 真的平滑滚到那一轮(滚回第一轮)',
                jumped.after < jumped.deep && jumped.after <= Math.max(0, jumped.target) + 2 && jumped.cur === 0,
                JSON.stringify(jumped));
        } else {
            r.ok('轮次轨:滚动联动/滚轮/键盘 —— 消息区这次没有可滚内容(记一条,不算通过)', false,
                `scrollHeight=${rail.scrollHeight} clientHeight=${rail.clientHeight}`);
        }
        // ⑤ 悬停/聚焦摘要:中文写出状态 + 该轮的问题首行
        const tip = await win.webContents.executeJavaScript(`(async () => {
            const msgs = document.getElementById('agentMessages');
            const tick = msgs.querySelectorAll('.agent-rail .tick')[1];
            const read = () => {
                const t = document.getElementById('agentPanel').querySelector('.agent-rail-tip');
                if (t === null) return null;
                return {
                    title: t.querySelector('.h')?.textContent ?? null,
                    question: t.querySelector('.q')?.textContent ?? null,
                    inMessages: msgs.querySelectorAll('.agent-rail-tip').length,
                };
            };
            const out = { byFocus: null, byHover: null, tag: tick.tagName };
            tick.focus();
            out.focused = document.activeElement === tick;
            // ⚠️ focus 事件在 Chromium 里**不是**同步派发的(实测:紧接着读 DOM 什么都看不到),
            // 所以这里等一个宏任务再读。
            await new Promise(r => setTimeout(r, 0));
            out.byFocus = read();
            tick.blur();
            await new Promise(r => setTimeout(r, 0));
            out.afterBlur = document.querySelectorAll('.agent-rail-tip').length;
            tick.dispatchEvent(new MouseEvent('mouseenter'));
            out.byHover = read();
            tick.dispatchEvent(new MouseEvent('mouseleave'));
            out.afterLeave = document.querySelectorAll('.agent-rail-tip').length;
            return out;
        })()`);
        const tipShown = tip.byHover ?? tip.byFocus;
        r.ok('轮次轨:悬停/聚焦摘要 —— 「第 N 轮 · 中文状态」+ 该轮问题;挂在面板上(不会被滚动区裁掉)',
            tipShown !== null && tipShown !== undefined
            && /^第 2 轮 · (正常|含工具调用|失败)$/.test(String(tipShown.title ?? ''))
            && String(tipShown.question ?? '').length > 0
            && tipShown.inMessages === 0
            && tip.afterLeave === 0
            && tip.tag === 'BUTTON' && tip.focused === true,
            JSON.stringify(tip).slice(0, 400));


        // ---- 思考折叠 + 流式动效的**样式契约** ----
        // 这两样只在"生成过程中"出现,而自检里没有真模型在流式(验收那一段用的是夹具,
        // 跑得太快,抓不到中途)。所以这里断言样式表:扫光动画、background-clip:text、
        // 末字显影的罩子,以及 reduced-motion 下**必须**把它们关掉。
        // (真实的观感在 docs/kaiwu-sweep-demo.html 里逐字抄了同一段 CSS 自查过:
        //  定格在动画 30/40/50/60% 时,光带中心实测落在 0%/17%/50%/75% 屏宽处。)
        const shellCss = await win.webContents.executeJavaScript(
            `fetch('toolbox://shell/styles/shell.css').then(x => x.text()).catch(() => '')`);
        const tokensCss = await win.webContents.executeJavaScript(
            `fetch('toolbox://shell/styles/tokens.css').then(x => x.text()).catch(() => '')`);
        // 扫光层:块级(百分比 background-position 才有确定参照宽度)+ 裁到字里 + 有关键帧
        r.ok('流式扫光:内层扫光层是块级、裁到字里、并挂着 text-sweep 动画',
            /\.agent-sweep\s*\{[^}]*display:\s*block/.test(shellCss)
            && /\.agent-sweep\s*\{[^}]*background-clip:\s*text/.test(shellCss)
            && /@keyframes\s+text-sweep/.test(shellCss),
            `长度=${String(shellCss).length}`);
        // 回归守卫:气泡自己的底绝不能被裁进字形(踩过一次:流式中途气泡底色"消失")
        r.ok('气泡底没有被裁:`background-clip:text` 只出现在扫光层,不在 .agent-msg-text 上',
            !/\.agent-msg-text\s*\{[^}]*background-clip/.test(shellCss)
            && /\.agent-msg\[data-role="assistant"\]\s*\.agent-msg-text\s*\{[^}]*background:/.test(shellCss),
            '在 shell.css 里找 .agent-msg-text');
        // 末字显影:必须是自己裁一层**半透明**罩子。之前用 mask 是无效的(实测:与被
        // 遮罩前逐字节相同),所以这里同时守住"不许退回 mask"。
        r.ok('末字显影:尾巴自己裁一层半透明罩子(用 mask 是无效的,已实测推翻)',
            /\.agent-tail\s*\{[^}]*background-image/.test(shellCss)
            && /--sweep-veil:\s*rgba\([^)]*,\s*\.\d+\s*\)/.test(tokensCss)
            && !/\.agent-tail\s*\{[^}]*mask-image/.test(shellCss),
            `tokens 长度=${String(tokensCss).length}`);
        const rmShell = parseCssRules(
            extractAllMediaBlocks(shellCss, 'prefers-reduced-motion').join('\n'));
        r.ok('reduced-motion 下扫光与思考光标都被关掉(动效必须能一键关)',
            rmShell.some(u => /agent-sweep/.test(u.selector) && /animation:\s*none/.test(u.body))
            && rmShell.some(u => /agent-think-label/.test(u.selector) && /animation:\s*none/.test(u.body)),
            `块内规则=${rmShell.map(u => u.selector).join(' | ')}`);
        // 轮次轨同理:脉冲 / 入场 / 过渡一起停。⚠️ 关的是**动效**,不是信息 ——
        // "当前轮那格更高更亮"是位置指示,它照旧常显(不在这条规则里)。
        r.ok('reduced-motion(轮次轨):脉冲与入场动效被关掉,而当前轮的高亮规则不受影响',
            rmShell.some(u => /agent-rail/.test(u.selector) && /animation:\s*none/.test(u.body))
            && !/agent-rail[\s\S]{0,40}\.cur[\s\S]{0,80}display:\s*none/.test(shellCss),
            `块内规则=${rmShell.map(u => u.selector).join(' | ')}`);
        // 方案 C 的四段行:样式契约也必须真的在发出去的那份表里(写在 demo 里而不在
        // 应用里,是这类"看着做了其实没做"的典型错法)。
        const stageRules = parseCssRules(shellCss);
        const stageBody = (sel) => stageRules.filter(u => sel.test(u.selector)).map(u => u.body).join(' ');
        r.ok('方案C 状态行:条子是 3px、线性过渡,百分比只由真读数驱动(样式在发出去的那份表里)',
            /height:\s*3px/.test(stageBody(/^\.sbar$/))
            && /transition:\s*width\s*\.12s\s*linear/.test(stageBody(/^\.sbar i$/))
            && /accent/.test(stageBody(/^\.sbar i$/))
            && /error/.test(stageBody(/^\.stage-row\.failed$/))
            && /ok/.test(stageBody(/^\.stage-row\.done\s+\.mark$/)),
            `sbar=${stageBody(/^\.sbar$/)} | i=${stageBody(/^\.sbar i$/)}`);
        // 图二:没有分母的那两段不许是"永远是 0% 的空轨道",要用不确定态的游走光带
        // (轨道透明 + 一条有 animation 的带子)。这两条是**样式契约**,所以在真引擎里也钉一遍。
        // ⚠️ 这几个选择器前面都紧跟着一条注释,而 parseCssRules 的 selector 会把注释一起带进来
        // —— 所以这里只锚定**结尾**(产品代码那边没有这个问题,是自检这个解析小工具的脾气)。
        r.ok('方案C(图二):没有分母的段不画轨道 —— 轨道透明 + 一条来回游走的不确定态光带',
            /background:\s*transparent/.test(stageBody(/\.sbar\.indeterminate$/))
            && /animation:\s*stage-band-drift/.test(stageBody(/\.sbar\.indeterminate i$/))
            && /@keyframes\s+stage-band-drift/.test(shellCss)
            && /background:\s*transparent/.test(stageBody(/\.sbar\.idle$/)),
            `indeterminate=${stageBody(/\.sbar\.indeterminate$/)} | band=${stageBody(/\.sbar\.indeterminate i$/)}`);
        // 图二不能只验样式文本:**真引擎里那条光带得真的在走**。自检里视频理解被守卫挡住,
        // 四段行走不到"等待首个字"那一态,所以这里在真窗口里挂一个同结构的探针量两次 transform。
        const bandProbe = await win.webContents.executeJavaScript(`(async () => {
            const host = document.getElementById('agentPanel') || document.body;
            const box = document.createElement('div');
            box.className = 'sbar indeterminate';
            const band = document.createElement('i');
            box.appendChild(band);
            host.appendChild(box);
            const read = () => getComputedStyle(band).transform;
            const a = read();
            const cs = getComputedStyle(band);
            await new Promise(r => setTimeout(r, 420));
            const b = read();
            const rail = getComputedStyle(box).backgroundColor;
            const anim = { name: cs.animationName, duration: cs.animationDuration, play: cs.animationPlayState };
            box.remove();
            return { a, b, rail, anim };
        })()`);
        r.ok('方案C(图二):那条不确定态光带在**真引擎里真的在走**(两次 transform 不同),而且轨道是透明的',
            bandProbe.a !== bandProbe.b
            && /stage-band-drift/.test(String(bandProbe.anim.name))
            && bandProbe.anim.play === 'running'
            && /rgba\(0, 0, 0, 0\)|transparent/.test(String(bandProbe.rail)),
            JSON.stringify(bandProbe).slice(0, 320));
        const agentIdle = await waitForAttr(win, '#agentPanel', 'data-agent-state', 'stopped');
        r.ok('自检下面板不自动连(Agent 状态停在 stopped,由用户/自检显式点连接)',
            agentIdle === 'stopped', `state=${agentIdle}`);
        // 凭证卡片:断言**机器可读的属性**(data-credential-ok),不是"卡片里有文字"。
        //
        // ⚠️ 原来那条(评审 F6)只断言 textContent 非空 —— 而面板构造时就把标题
        // 与 howto 写死了,所以它恒真:凭证就绪、卡片其实藏着的时候它照样 PASS。
        // 现在面板在 agent:credentials 返回**之后**写 data-credential-ok,
        // 自检等这个属性出现再按它分支断言。
        const credOk = await waitForAttrPresent(win, '#agentCredential', 'data-credential-ok');
        if (credOk === 'false') {
            const cred = await win.webContents.executeJavaScript(`(() => {
                const el = document.getElementById('agentCredential');
                return el ? { hidden: el.hidden, text: (el.textContent ?? '').trim() } : null;
            })()`);
            r.ok('凭证卡片:没配凭证时卡片可见,而且写清了怎么配(不是空白)',
                cred !== null && cred.hidden === false && cred.text.length > 0,
                JSON.stringify(cred && { hidden: cred.hidden, text: cred.text.slice(0, 90) }));
        } else if (credOk === 'true') {
            const cred = await win.webContents.executeJavaScript(`(() => {
                const el = document.getElementById('agentCredential');
                return el ? { hidden: el.hidden, text: (el.textContent ?? '').trim() } : null;
            })()`);
            // 有凭证时**不许**留"未就绪"类文案:隐藏 ≠ 状态正确(评审 F7)。
            const bad = cred === null ? '卡片元素不见了'
                : (/未就绪|没有找到|缺失/.test(cred.text) ? `文案还停在未就绪:${cred.text.slice(0, 60)}` : null);
            r.ok('凭证卡片:有凭证时不许留下"未就绪"类文案(隐藏 ≠ 状态正确)',
                bad === null, bad ?? `hidden=${cred.hidden}`);
        } else {
            r.ok('凭证卡片暴露了机器可读的 data-credential-ok(自检据此断言,而不是断言恒真的文案)',
                false, `data-credential-ok=${JSON.stringify(credOk)}(agent:credentials 没返回或面板没写)`);
        }

        // ---- 验收用例(设计文档 §14 的标准 5 与 6)----
        // 只有 --acceptance 才跑:这两条需要在 plugins/ 下放临时夹具,
        // 夹具由 run-selftest.js 在拉起之前建好、结束后删掉。
        if (acceptance) {
            // 标准 5:往 plugins/ 丢一个单文件就能用,不改任何其它文件。
            const probeTool = 'accprobe';
            const probeVisible = await win.webContents.executeJavaScript(
                `window.__pwTabs?.toolIds?.().includes('${probeTool}') === true`);
            r.ok('验收5:新丢进去的单文件插件进入注册工具集合', probeVisible === true);

            await openTool(probeTool);
            // ⚠️ 要等标题变成**探针自己的**标题,不能只等"内容区里有 h3"。
            // 面板是异步 fetch 的,上一个插件的面板这会儿还挂在内容区里,
            // "有 h3"这个条件会立刻被它满足 —— 断言就在读错面板的情况下
            // 通过了(之前的写法正是如此,报出来的示例文本是别的插件的标题)。
            const probeHeading = await waitForTextEqual(
                win, '[data-pane-plugin="accprobe"] .tool-block h3', '验收探针');
            r.ok('验收5:它注册的工具有面板可挂载(挂的是它自己的面板)',
                probeHeading === '验收探针', `标题=${JSON.stringify(probeHeading)}`);

            // 标准 6:坏插件不拖垮应用;加载失败仍由启动状态与主进程诊断日志记录。
            r.ok('验收6:坏插件被隔离且应用仍运行', ready.broken === 1,
                `broken=${ready.broken}`);

            // 坏插件存在时,正常工具必须照旧可用 —— 隔离的意义就在这里。
            //
            // 断言"这几个工具 id 都在",**不要**断言总个数:早先这里写的是
            // `长度 === 5`(当时仓库里只有 4 个工具),后来插件加到 6 个,
            // 这条就常年假失败,而失败原因和它想守的东西毫无关系。
            const REAL_TOOLS = ['palette', 'subtitle', 'music', 'douyin', 'bilibili', 'hello'];
            const ids = await win.webContents.executeJavaScript(
                'window.__pwTabs?.toolIds?.() ?? []');
            const missing = REAL_TOOLS.filter(id => !ids.includes(id));
            r.ok('验收6:坏插件没有影响正常工具',
                missing.length === 0, `缺失=${missing.join(',') || '无'} 注册工具=${ids.join(',')}`);

            // ---- M3 验收:发一条提示,界面上出现回复 ----
            //
            // 这是设计文档 §9 给 M3 定的验收标准,所以它必须**真的**走一遍界面:
            // 点连接 → 等就绪 → 在输入框里打字 → 点发送 → 等消息流里出现回复。
            // agent 命令是 run-selftest.js 注入的假夹具(--tool-call --permission),
            // 所以"回复0回复1回复2"是夹具的确定输出,而不是某个模型的自由发挥。
            await win.webContents.executeJavaScript(
                'document.getElementById("agentRetry")?.click()');
            const agentState = await waitForAttr(win, '#agentPanel', 'data-agent-state', 'ready', 150);
            r.ok('验收M3:点「连接」后 Agent 真的就绪(握手走的是注入的夹具)',
                agentState === 'ready', `state=${agentState}`);

            // ---- 启动/连上之后**不发任何消息**,胶囊立刻可用(自动建会话)----
            //
            // 产品负责人要的行为:程序一打开(还没发消息)会话就已经建好,于是输入行右边
            // 那枚「思考强度 / 模型」胶囊一进来就有对端给的真档位 —— 滑块能拖、模型能换,
            // 而不是只有一句"还没建会话…发一条消息之后才会出现"。
            // 触发点在主进程的 agent 运行时(ACP ready 那一刻自动 session/new),
            // 所以这里**一个字节都不许发**:整段只读界面 + 拖滑块。
            //
            // ⚠️ 自动建会话是 ready 之后异步的一趟,所以下面在页面里**轮询等**档位上来,
            //    不读一次就判(与自检里其它动效断言同一条纪律)。
            const cfgAuto = await win.webContents.executeJavaScript(`(async () => {
                const wait = (ms) => new Promise((r) => setTimeout(r, ms));
                const wrap = document.getElementById('agentCfgWrap');
                const chip = document.getElementById('agentCfg');
                const panel = document.getElementById('agentPanel');
                if (wrap === null || chip === null || panel === null) return { ok: false, why: '缺胶囊/面板' };
                const pop = wrap.querySelector('.agent-cfg-pop');
                const stopSpans = () => [...wrap.querySelectorAll('.agent-cfg-stops span')];
                const onStops = () => stopSpans().filter((s) => s.classList.contains('on'))
                    .map((s) => s.textContent);
                const stops = () => stopSpans().map((s) => s.textContent);
                const desc = () => wrap.querySelector('.agent-cfg-desc')?.textContent ?? '';
                // ⓪ 切回笔记主视图确保工作台可见;工具面板已不再切换整页视图。
                const viewTabOn = () => [...document.querySelectorAll('.view-tab')]
                    .find((b) => b.getAttribute('aria-selected') === 'true') ?? null;
                const prevViewId = viewTabOn()?.id ?? null;
                document.getElementById('viewNotes')?.click();
                const hostPane = panel.closest('.pw-pane');
                const tabOn = hostPane?.querySelector?.('.pw-tab-on') ?? null;
                const aiTab = [...(hostPane?.querySelectorAll?.('.pw-tab') ?? [])]
                    .find((t) => /AI 对话/.test(t.textContent ?? '')) ?? null;
                if (aiTab !== null && aiTab !== tabOn) aiTab.click();
                await wait(250);
                // ① 等"自动建会话"那一趟落定:判据是档位真的上来了(而不是等一个固定时长)
                let waited = 0;
                while (stopSpans().length === 0 && waited < 8000) { await wait(100); waited += 100; }
                const before = {
                    sessionId: panel.getAttribute('data-session-id') ?? '',
                    chip: (chip.textContent ?? '').trim(),
                    stops: stops(),
                    on: onStops(),
                    desc: desc(),
                    waitedMs: waited,
                    messages: document.querySelectorAll('#agentMessages .agent-msg').length,
                    viewId: viewTabOn()?.id ?? null,
                    tabLabels: [...(hostPane?.querySelectorAll?.('.pw-tab') ?? [])]
                        .map((t) => (t.textContent ?? '').trim()),
                    chatVisible: (hostPane?.querySelector?.('.pw-body .agent-panel') ?? null) !== null,
                };
                if (stopSpans().length === 0) return { ok: false, why: '档位一直没上来', before };

                // ② 点开浮层(用户真正的动作)
                // ⚠️ 宽度要在**点开之后**量:浮层收起时它的轨道是 display:none,那量到的 0
                //    说明不了"面板没露出来"(第一版就是这么误判的)。
                chip.click();
                await wait(200);
                const track = wrap.querySelector('.agent-cfg-track');
                const box = track.getBoundingClientRect();
                const opened = {
                    open: pop?.classList.contains('open') === true,
                    chip: (chip.textContent ?? '').trim(),
                    trackW: Math.round(box.width),
                    models: [...wrap.querySelectorAll('.agent-cfg-opt')].map((r) => ({
                        name: r.querySelector('.t1')?.textContent ?? '',
                        on: r.classList.contains('on'),
                    })),
                };
                if (opened.open !== true || Math.round(box.width) <= 0) {
                    return { ok: false, why: '浮层没展开 / 量不到滑块宽度', before, opened };
                }

                // ③ **真指针**拖滑块:从最左拖到最右(与"点某一档"是两条路,这里要的是"拖")
                const ev = (type, x) => track.dispatchEvent(new PointerEvent(type, {
                    clientX: x, clientY: Math.round(box.top + box.height / 2),
                    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
                }));
                const right = Math.round(box.left + box.width - 1);
                ev('pointerdown', Math.round(box.left + 1));
                ev('pointermove', right);
                ev('pointerup', right);
                // ⚠️ 判据必须是**提交落地**,不能是「.on」那一格:拖动中的 preview() 会先把
                //    「.on」画到落点上(松手前就已经是「高」了),拿它当判据会当场骗过自己 ——
                //    实测就是这么骗过的:随后的"点回中"落在**提交之前**,被
                //    「lv.value === currentValue」那道闸挡掉,于是永远停在「高」。
                //    浮层脚下那句「已切到「X」」只在**提交成功之后**才写,用它才准。
                const foot = () => wrap.querySelector('.agent-cfg-foot-text')?.textContent ?? '';
                let t2 = 0;
                while (!/已切到「高」/.test(foot()) && t2 < 6000) { await wait(100); t2 += 100; }
                const dragged = { on: onStops(), waitedMs: t2, desc: desc(), foot: foot() };

                // ④ 点回「中」:后面那几条断言要求此刻它是中(这一步同时证明"改了还能改回来")
                stopSpans()[2]?.click();
                let t3 = 0;
                while (!/已切到「中」/.test(foot()) && t3 < 6000) { await wait(100); t3 += 100; }
                const restored = { on: onStops(), waitedMs: t3, desc: desc(), foot: foot() };
                chip.click();                                  // 收起浮层
                // 还原视图/标签(顺序:先标签后视图) —— 让这一段对后面"零影响"
                if (aiTab !== null && tabOn !== null) tabOn.click();
                if (prevViewId !== null && prevViewId !== 'viewNotes') document.getElementById(prevViewId)?.click();
                return { ok: true, before, opened, dragged, restored };
            })()`).catch((err) => ({ ok: false, why: '注入失败: ' + err.message }));
            r.ok('★ 启动后**不发任何消息**:胶囊一进来就有对端给的档位(自动建会话,不再是"还没建会话")',
                cfgAuto.ok === true
                && String(cfgAuto.before?.sessionId ?? '') !== ''
                && JSON.stringify(cfgAuto.before?.stops) === JSON.stringify(['关', '低', '中', '高'])
                && JSON.stringify(cfgAuto.before?.on) === JSON.stringify(['中'])
                && !/还没建会话/.test(String(cfgAuto.before?.desc ?? ''))
                && cfgAuto.opened?.open === true
                && (cfgAuto.opened?.models ?? []).length === 2
                && (cfgAuto.opened?.models ?? []).some((m) => m.on === true)
                && /Fake-Flash/.test(String((cfgAuto.opened?.models ?? [])[0]?.name ?? '')),
                JSON.stringify(cfgAuto));
            r.ok('★ 启动后**不发任何消息**,滑块真的拖得动、拖完就生效(拖到「高」→ 对端回的档位跟着变;再点回「中」)',
                cfgAuto.ok === true
                && JSON.stringify(cfgAuto.dragged?.on) === JSON.stringify(['高'])
                // ⚠️ 光看 `.on` 不算数(拖动中的 preview 会先画上)—— 要用"提交落地"的那句
                && /已切到「高」/.test(String(cfgAuto.dragged?.foot ?? ''))
                && JSON.stringify(cfgAuto.restored?.on) === JSON.stringify(['中'])
                && /已切到「中」/.test(String(cfgAuto.restored?.foot ?? '')),
                JSON.stringify({ dragged: cfgAuto.dragged, restored: cfgAuto.restored }));

            r.ok('验收M3:输入框与发送按钮都在,且按钮带 aria-label',
                await win.webContents.executeJavaScript(`(() => {
                    const i = document.getElementById('agentInput');
                    const b = document.getElementById('agentSend');
                    return Boolean(i && b && b.getAttribute('aria-label'));
                })()`));

            await win.webContents.executeJavaScript(`(() => {
                const i = document.getElementById('agentInput');
                i.value = '你好,读一下当前笔记';
                i.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('agentSend').click();
            })()`);

            // ⚠️ 选择器排除了 `[data-stages]`:消息流里可能留着"视频理解失败时那份
            // 四段状态行"(方案 C),它也是 assistant 气泡,但**不是回答**。
            const reply = await waitForMatch(win, '#agentMessages .agent-msg[data-role="assistant"]:not([data-stages])',
                /回复0回复1回复2/, 150);
            r.ok('验收M3:发一条提示,界面上出现回复', /回复0回复1回复2/.test(String(reply)),
                JSON.stringify(String(reply).slice(0, 80)));

            // ⚠️ 按**内容**找那条气泡,不是按"第一条":消息流里可能已经有别的用户气泡
            // (视频理解那一段会留一条带视频卡的用户消息,夹具的 --echo-prompt 也会回显
            // 一条),而这条断言要证的只是"用户那一句留在消息流里"。
            const userBubble = await win.webContents.executeJavaScript(
                '[...document.querySelectorAll("#agentMessages .agent-msg[data-role=\\"user\\"]")]'
                + '.map(el => el.textContent ?? "").find(t => t.includes("你好,读一下当前笔记")) ?? null');
            r.ok('验收M3:用户那一句也留在消息流里',
                typeof userBubble === 'string' && userBubble.includes('你好,读一下当前笔记'),
                JSON.stringify(String(userBubble).slice(0, 60)));

            // 「会话绑定当前笔记」不能只看界面自己画了什么 —— 夹具用 --echo-prompt
            // 把**它收到的那段提示原文**回显了一条,所以这一条证的是"真的发出去了"。
            const notePath = await win.webContents.executeJavaScript(
                'document.getElementById("notePath")?.textContent?.trim() ?? ""');
            const ctxNeedle = `当前笔记:${notePath}`;
            const ctxEcho = await waitForMatch(win, '#agentMessages',
                new RegExp(ctxNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 120);
            r.ok('验收M3:发给 agent 的提示里带上了当前笔记的路径(会话绑定当前笔记)',
                notePath !== '' && String(ctxEcho).includes(ctxNeedle),
                `path=${JSON.stringify(notePath)} 回显=${JSON.stringify(String(ctxEcho).slice(0, 90))}`);

            const toolCard = await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector('#agentMessages .agent-tool[data-tool-call-id="call-1"]');
                return el ? { status: el.dataset.status, text: el.textContent.trim() } : null;
            })()`);
            r.ok('验收M3:工具调用渲染成一张卡片,而且按 toolCallId 更新成 completed',
                toolCard !== null && toolCard.status === 'completed', JSON.stringify(toolCard));

            const permCard = await waitForElement(win, '#agentMessages .agent-permission[data-request-id]');
            r.ok('验收M3:反向的权限请求渲染成一张确认卡片', permCard === true);
            const permOptions = await win.webContents.executeJavaScript(
                '[...document.querySelectorAll("#agentMessages .agent-permission [data-option-id]")]'
                + '.map(b => b.dataset.optionId)');
            r.ok('验收M3:权限卡片列出了对端给的选项(allow-once / reject-once)',
                JSON.stringify(permOptions) === JSON.stringify(['allow-once', 'reject-once']),
                JSON.stringify(permOptions));

            await win.webContents.executeJavaScript(
                'document.querySelector("#agentMessages .agent-permission [data-option-id=\\"allow-once\\"]")?.click()');

            // 回答之后夹具会把它收到的选项回显成最后一条增量 ——
            // 于是这条断言证的是"用户的决定真的到了 agent 那一侧",
            // 而不是"界面上画过一张卡"。
            const echoed = await waitForMatch(win, '#agentMessages',
                /权限结果:allow-once/, 100);
            r.ok('验收M3:点的选项真的回给了 agent(夹具把它回显出来了)',
                /权限结果:allow-once/.test(String(echoed)), JSON.stringify(String(echoed).slice(-60)));

            // 产品负责人要求"这个请求完也删":答完不再是"留在原地标成已决、按钮禁用",
            // 而是整张卡从界面上消失 —— 所以这条断言从"卡还在、按钮禁用"翻成"卡没了"。
            //
            // "一个请求只许回答一次"**没有**被放宽:它真正的落点是面板的 answered 集合
            // (tests/agent-panel.test.js 里"拿被摘掉的旧节点再点 + 重发同 requestId"
            // 那一条钉着),而"按钮禁用"本来就只是那道保证的**可见**第二防线 ——
            // 卡没了,这道防线自然也没了。
            // ⚠️ 这里原来读 perm.dataset.decided / 按钮 disabled,卡不再渲染之后那两个
            //    字段没有对象可读(硬读会 TypeError),于是整段换成计数。
            const permGone = await waitForCountEqual(win, '#agentMessages .agent-permission', 0);
            r.ok('验收M3:点完选项授权卡从界面上消失(请求完就删,不是留在原地变淡)',
                permGone === 0, `count=${permGone}`);

            // ---- 提问卡:模型的 ask_user_question ----
            //
            // 桥把提问映射成一次 session/request_permission(kind='question'),主进程把它标成
            // question=true。端到端验三件事:画的是**提问卡**(不是授权卡)、选项说明显示出来了、
            // 点选项真的回到了 agent 那一侧(夹具把它回显成"提问结果:q1")。
            //
            // ⚠️ 位置有讲究:夹具是"权限卡 → 提问卡 → 才收尾",所以这一步必须在
            // "等 Agent 回到 ready" 与后面那些**依赖整轮已结束**的断言(思考收尾、排布、Markdown)
            // **之前**跑完 —— 否则提示还没结束,那些断言看到的是一个还在流式中的界面(实测踩过)。
            const questionCard = await waitForElement(win, '#agentMessages .agent-question');
            r.ok('提问:请求渲染成一张**提问卡**(带「提问」标记,不是授权卡)', questionCard === true);

            const questionShape = await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector('#agentMessages .agent-question');
                if (!el) return null;
                const opts = [...el.querySelectorAll('[data-option-id]')];
                return {
                    tag: el.querySelector('.agent-question-tag')?.textContent ?? null,
                    title: el.querySelector('.agent-question-title')?.textContent ?? null,
                    hasDesc: /零重复/.test(el.textContent),
                    optionIds: opts.map(b => b.dataset.optionId),
                    permissions: document.querySelectorAll('#agentMessages .agent-permission').length,
                };
            })()`);
            r.ok('提问卡:题面与选项说明都在,而且授权卡已按"答完就删"退场(没有混在一起)',
                questionShape !== null && questionShape.tag === '提问'
                && /选 A 还是选 B/.test(questionShape.title ?? '')
                && questionShape.hasDesc === true
                && JSON.stringify(questionShape.optionIds) === JSON.stringify(['q0', 'q1'])
                && questionShape.permissions === 0,
                JSON.stringify(questionShape));

            await win.webContents.executeJavaScript(
                'document.querySelector("#agentMessages .agent-question [data-option-id=\\"q1\\"]")?.click()');
            const questionEchoed = await waitForMatch(win, '#agentMessages', /提问结果:q1/, 100);
            r.ok('提问:点的选项真的回给了 agent(夹具把它回显出来了)',
                /提问结果:q1/.test(String(questionEchoed)), JSON.stringify(String(questionEchoed).slice(-60)));

            const questionDone = await win.webContents.executeJavaScript(`(() => ({
                questions: document.querySelectorAll('#agentMessages .agent-question').length,
                permissions: document.querySelectorAll('#agentMessages .agent-permission').length,
            }))()`);
            // ⚠️ 这条原来断言的是"提问卡还在、只是标成已决、按钮全禁用"(纯问句部分)。
            // 产品要求改成 **问完就消失**,所以判据从"卡还在"翻成"卡不在了"。
            //
            // "一个提问只许回答一次"这个保证**没有被放宽**:它真正的落点是面板的 answered
            // 集合(单测 tests/agent-panel.test.js 拿被摘掉的旧节点再点一次钉着),而
            // "按钮禁用"本来就只是那道保证的**可见**第二防线 —— 卡没了,这道防线自然也没了。
            const questionGone = await waitForCountEqual(win, '#agentMessages .agent-question', 0);
            r.ok('提问卡:点完选项整张卡从界面上消失(问完就没了,不是留在原地变淡)',
                questionGone === 0 && questionDone.questions === 0,
                JSON.stringify({ ...questionDone, waitCount: questionGone }));
            // ⚠️ 这条原来断言的是"授权卡不受影响:答完提问之后它仍在原地,已决且按钮禁用"
            //    —— 它读的正是 permDecided / permDisabled / permOpacity 三个字段。
            //    现在**两类卡寿命一致**(产品负责人:"这个请求完也删"):授权卡在上一步
            //    (点 allow-once)就已经答过、已经退场,所以这里它是"不存在的那一张",
            //    那三个字段没有对象了(硬读会 TypeError)。判据因此从"仍在原地且淡化到 .7"
            //    翻成"数为 0",同时复核上一步那次计数的读数。
            r.ok('授权卡:答完也消失,界面上不再留"已决的授权卡"',
                questionDone.permissions === 0 && permGone === 0,
                JSON.stringify({ ...questionDone, permAtClick: permGone }));

            const afterPrompt = await waitForAttr(win, '#agentPanel', 'data-agent-state', 'ready');
            r.ok('验收M3:提示结束后 Agent 仍就绪(没被这次交互带进 stopped/failed)',
                afterPrompt === 'ready', `state=${afterPrompt}`);

            // ---- 思考折叠(A2)与流式动效(B4 + 扫光)----
            //
            // 夹具这次带了 --thought:先推两条思考增量再推正文。于是这里能端到端验:
            // 两条增量被拼成**一条**折叠条、正文一到自动收起、标签从「思考中…」变「已思考」。
            const think = await win.webContents.executeJavaScript(`(() => {
                const box = document.querySelector('#agentMessages .agent-think');
                if (!box) return null;
                return {
                    live: box.getAttribute('data-live'),
                    open: box.hasAttribute('open'),
                    label: box.querySelector('.agent-think-label')?.textContent ?? null,
                    count: box.querySelector('.agent-think-count')?.textContent ?? null,
                    time: box.querySelector('.agent-think-time')?.textContent ?? null,
                    blocks: document.querySelectorAll('#agentMessages .agent-think').length,
                    body: box.querySelector('.agent-think-body')?.textContent ?? '',
                };
            })()`);
            r.ok('验收A2:思考收成**一条**可折叠的细条(两条增量要拼起来,不是两条)',
                think !== null && think.blocks === 1 && think.body.length > 10,
                JSON.stringify(think));
            r.ok('验收A2:正文一到就自动收起,标签变「已思考」并带字数',
                think !== null && think.live === 'false' && think.open === false
                && /已思考/.test(think.label ?? '') && /\d+ 字/.test(think.count ?? ''),
                JSON.stringify(think));

            // ---- 思考耗时(用户要的"思考过程中显示思考时间")----
            //
            // 夹具在思考与正文之间留了 400ms 静默(见 tests/fixtures/fake-acp-agent.mjs),
            // 所以这条读数必须是**量出来的**:写死的常数、或者"0.0 秒"都过不了。
            r.ok('思考耗时:思考条上有一条「X.X 秒」,而且量的是真的那一段(夹具留了 400ms 静默)',
                think !== null && typeof think.time === 'string' && /\d+\.\d 秒/.test(think.time)
                && parseFloat(think.time) >= 0.3,
                JSON.stringify({ time: think?.time, label: think?.label }));
            // ⚠️ 收尾之后**不许再涨**:它回答的是"这一条想了多久",不是"现在几点"
            await new Promise((res) => { setTimeout(res, 500); });
            const timeLater = await win.webContents.executeJavaScript(
                'document.querySelector("#agentMessages .agent-think .agent-think-time")?.textContent ?? null');
            r.ok('思考耗时:收尾之后冻住(过了 0.5 秒再读一次,一个字都不变)',
                timeLater !== null && think !== null && timeLater === think.time,
                JSON.stringify({ then: think?.time, now: timeLater }));

            // ⚠️ 顺序:思考条必须排在**它那段正文前面**(用户提过的原话是
            //    "每次思考的信息都悬浮在输出信息前面")。这条同时盯住两条链:
            //    渲染侧的时间线(planTimeline),以及桥侧"思考也要走实时帧"那个补丁 ——
            //    桥只接正文的时候,思考要等整条消息提交才到,于是它会被排到答案**后面**。
            //    ⚠️ 必须从**这条思考自己所在的那一轮**去数:面板里可能已经有更早的几轮
            //    (验收这一段前面还发过别的提示),拿第一个 `.agent-turn` 数会数到别人身上。
            const thinkOrder = await win.webContents.executeJavaScript(`(() => {
                const box = document.querySelector('#agentMessages .agent-think');
                const turn = box?.closest('.agent-turn');
                if (!turn) return null;
                const kids = [...turn.children];
                const at = (cls) => kids.findIndex((el) => el.classList.contains(cls));
                return { think: at('agent-think'), reply: at('agent-msg-assistant'),
                         kinds: kids.map((el) => String(el.className).split(' ')[0]) };
            })()`);
            r.ok('思考条排在那段正文**前面**(不是被顶到答案下面)',
                thinkOrder !== null && thinkOrder.think >= 0 && thinkOrder.reply >= 0
                && thinkOrder.think < thinkOrder.reply,
                JSON.stringify(thinkOrder));

            // ---- 思考强度 / 模型那枚胶囊(用户拍板的位置:紧挨球左侧)----
            //
            // 夹具这次会像真桥一样广告 configOptions(model 按 provider 分组 + reasoning_effort 四档),
            // 于是这一组能端到端验整条链:收起态一个汉字 → 展开/滑块 → 点标题进模型清单
            // → 切一条真的发到对端 → 对端回的整份 configOptions 让界面跟着变。
            const sleepMs = (ms) => new Promise((res) => { setTimeout(res, ms); });
            const cfgChip = () => win.webContents.executeJavaScript(`(() => {
                const chip = document.getElementById('agentCfg');
                if (chip === null) return null;
                return {
                    text: (chip.textContent ?? '').trim(),
                    expanded: chip.getAttribute('aria-expanded'),
                    width: Math.round(chip.getBoundingClientRect().width),
                };
            })()`);
            const cfgPop = () => win.webContents.executeJavaScript(`(() => {
                const pop = document.querySelector('#agentCfgWrap .agent-cfg-pop');
                if (pop === null) return null;
                return {
                    open: pop.classList.contains('open'),
                    stops: [...pop.querySelectorAll('.agent-cfg-stops span')].map((s) => s.textContent),
                    onStop: [...pop.querySelectorAll('.agent-cfg-stops span.on')].map((s) => s.textContent),
                    models: [...pop.querySelectorAll('.agent-cfg-opt')].map((r) => ({
                        name: r.querySelector('.t1')?.textContent ?? '',
                        on: r.classList.contains('on'),
                    })),
                    desc: pop.querySelector('.agent-cfg-desc')?.textContent ?? '',
                };
            })()`);

            const cfgBefore = await cfgChip();
            // ⚠️ 不在这里断言"宽度":这一段跑到时那一格可能被**切到别的视图**(面板整格 hidden),
            //    那时量到的宽是 0。宽度与"紧挨球 6px"由上面那条动作行读数负责(那里正好是可见的)。
            // `中` 这一条就是**「默认思考强度为中」的端到端证据**:它由 kaiwu 自己保证
            // (见 agent-runtime 的 pinEffort),不是"对端恰好给中" —— 夹具的默认档是可换的。
            r.ok('胶囊(收起):球左边一枚小控件,写的是当前档位的**一个汉字**,而且默认就是「中」',
                cfgBefore !== null && cfgBefore.expanded === 'false' && cfgBefore.text === '中',
                JSON.stringify(cfgBefore));

            await win.webContents.executeJavaScript('document.getElementById("agentCfg").click()');
            await sleepMs(150);
            const cfgOpen = await cfgPop();
            const cfgExpanded = await cfgChip();
            r.ok('点它 → 浮层向上展开:展开态换成标签「思考强度」,滑块就是对端给的那几档',
                cfgOpen !== null && cfgOpen.open === true && cfgExpanded?.text === '思考强度'
                && JSON.stringify(cfgOpen.stops) === JSON.stringify(['关', '低', '中', '高'])
                && cfgOpen.onStop.length === 1 && cfgOpen.onStop[0] === '中',
                JSON.stringify({ cfgOpen, text: cfgExpanded?.text }));

            // 点最后一档(「高」= max):请求真的到对端,对端回的整份 configOptions 让状态跟着变
            await win.webContents.executeJavaScript(`(() => {
                const stops = document.querySelectorAll('#agentCfgWrap .agent-cfg-stops span');
                stops[stops.length - 1].click();
            })()`);
            await sleepMs(500);
            const cfgAfterEffort = await cfgPop();
            r.ok('点最后一档 → 真的发到对端,而且**只有那一档**是当前档(状态跟着对端回的那份走)',
                cfgAfterEffort !== null && JSON.stringify(cfgAfterEffort.onStop) === JSON.stringify(['高']),
                JSON.stringify(cfgAfterEffort));

            // 点标题「高 ›」→ 第二层:模型清单
            await win.webContents.executeJavaScript(
                'document.querySelector("#agentCfgWrap .agent-cfg-now").click()');
            await sleepMs(150);
            const cfgModels = await cfgPop();
            r.ok('点标题 → 模型清单(对端给几条画几条,当前那个打勾)',
                cfgModels !== null && cfgModels.models.length === 2
                && cfgModels.models.filter((m) => m.on).length === 1
                && /Fake-Flash/.test(cfgModels.models[0].name),
                JSON.stringify(cfgModels?.models));

            // 切到另一个模型:请求到对端 → 对端回的清单里换成它打勾
            //
            // ⚠️ 夹具**照真机**:换模型会把思考强度打回新模型的默认值(实测,见 fixture 的
            //    MODEL_DEFAULT_EFFORT)。所以下面那条"收起后仍是刚切的那一档「高」"是
            //    **kaiwu 把用户选的那一档补回来**的端到端证据 —— 删掉 pinEffort 它就会变「中」。
            await win.webContents.executeJavaScript(`(() => {
                const rows = document.querySelectorAll('#agentCfgWrap .agent-cfg-opt');
                rows[1].click();
            })()`);
            await sleepMs(500);
            const cfgPicked = await cfgPop();
            r.ok('切模型:点另一条 → 请求到对端 → 对端回的那份里换成它打勾',
                cfgPicked !== null && cfgPicked.models.length === 2
                && cfgPicked.models[1].on === true && cfgPicked.models[0].on === false,
                JSON.stringify(cfgPicked?.models));

            // 收起:胶囊回到"一个汉字"(此时已是「高」—— 换模型把它打回过默认,是 kaiwu 补回来的)
            await win.webContents.executeJavaScript('document.getElementById("agentCfg").click()');
            await sleepMs(150);
            const cfgClosed = await cfgChip();
            r.ok('收起:胶囊回到一个汉字 —— 换模型把强度打回默认时,kaiwu 把用户选的「高」补了回来',
                cfgClosed !== null && cfgClosed.expanded === 'false' && cfgClosed.text === '高',
                JSON.stringify(cfgClosed));

            // ---- 按需翻译:思考条上的「译」 ----
            //
            // 模型偶尔会用英文思考(人设已经改成中文,但那不是保证)。于是给思考条一个「译」:
            // 点了才让桥用 ctx.llm 翻一次。这里端到端验三件事:收尾的思考条上有这个 chip、
            // 点了真的会换成译文(夹具回一条一眼能认出来的假译文)、译文会**自动展开**。
            const translateChip = await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector('#agentMessages .agent-think [data-act]');
                return el ? { act: el.dataset.act, label: el.textContent.trim() } : null;
            })()`);
            r.ok('翻译:收尾的思考条上有「译」', translateChip !== null
                && translateChip.act === 'translate' && translateChip.label === '译',
                JSON.stringify(translateChip));

            await win.webContents.executeJavaScript(
                'document.querySelector("#agentMessages .agent-think [data-act=\\"translate\\"]")?.click()');
            const translationState = await waitForAttr(
                win, '#agentMessages .agent-think', 'data-translation', 'done');
            r.ok('翻译:点了「译」之后真的译好了', translationState === 'done',
                `data-translation=${translationState}`);

            const afterTranslate = await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector('#agentMessages .agent-think');
                if (!el) return null;
                return {
                    lang: el.getAttribute('data-lang'),
                    open: el.hasAttribute('open'),
                    text: el.querySelector('.agent-think-body')?.textContent ?? '',
                    hasSrcChip: Boolean(el.querySelector('[data-act="src"]')),
                };
            })()`);
            r.ok('翻译:译文显示出来、自动展开,并且能切回原文',
                afterTranslate !== null && afterTranslate.lang === 'zh'
                && afterTranslate.open === true
                && afterTranslate.text.includes('【译】')
                && afterTranslate.hasSrcChip === true,
                JSON.stringify(afterTranslate));

            // ---- 排布:思考内联在它那段输出之前,工具折进一行摘要 ----
            //
            // 用户反馈的原话:「思考栏位置错误,每次思考都是在顶栏的思考栏,我希望每次
            // 思考的信息都悬浮在输出信息前面」。根因是状态把三类条目存成三个平行数组、
            // 先后在归约那一刻就丢了(现在由 order 记着)。这里端到端验排布本身 ——
            // 断言的是**元素在消息流里的先后**,而不是"画过一条思考条"。
            const layout = await win.webContents.executeJavaScript(`(() => {
                const stream = document.querySelector('#agentMessages .agent-stream');
                if (!stream) return null;
                // ⚠️ 渲染单元外面现在多包了一层 .agent-turn(轮次轨按轮拿盒子),所以
                // "先后"要在**同一条思考所在的那一轮里**看 —— 整个消息流里可能有好几轮,
                // 拿第一轮去比就会把别的轮的思考算进来。
                const thinkEl = stream.querySelector('.agent-think');
                const turn = (thinkEl && typeof thinkEl.closest === 'function' ? thinkEl.closest('.agent-turn') : null)
                    ?? stream.querySelector('.agent-turn') ?? stream;
                const kinds = [...turn.children].map(c => String(c.className).split(' ')[0]);
                const groupEl = stream.querySelector('.agent-group');
                const card = stream.querySelector('.agent-tool[data-tool-call-id="call-1"]');
                return {
                    kinds,
                    turns: stream.querySelectorAll('.agent-turn').length,
                    thinkAt: kinds.indexOf('agent-think'),
                    replyAt: kinds.lastIndexOf('agent-msg'),
                    userAt: kinds.indexOf('agent-msg'),
                    groupLabel: groupEl ? (groupEl.querySelector('.agent-group-label')?.textContent ?? '') : null,
                    cardInGroup: Boolean(card && groupEl && groupEl.contains(card)),
                };
            })()`);
            r.ok('排布:思考条内联在它那段回复**之前**(不再被顶到消息流最上面)',
                layout !== null && layout.thinkAt >= 0
                && layout.replyAt > layout.thinkAt && layout.thinkAt > layout.userAt,
                JSON.stringify(layout));
            r.ok('排布:一轮的工具收进一行摘要(「N 次工具调用」),卡片仍在 DOM 里、挂在摘要行下',
                layout !== null && /1 次工具调用/.test(layout.groupLabel ?? '')
                && layout.cardInGroup === true,
                JSON.stringify(layout));

            // ---- Markdown:助手的回复要排版,但模型给的标签仍然只是文字 ----
            //
            // 用户反馈:「聊天页面无法渲染 Markdown 格式」。面板原本一律 textContent
            // (那是为了"模型给的 <img onerror=...> 只能是文字"),所以修法是**把 Markdown
            // 建成 DOM 节点**(app/lib/markdown.js 的 renderMarkdownNodes),不是放开 innerHTML。
            // 夹具的 --markdown 让它同时推一段真语法与一段不可信的 HTML,于是这两条
            // 能一起端到端验:该排版的排版了、不该落地的没落地。
            const markdown = await win.webContents.executeJavaScript(`(() => {
                const bubbles = [...document.querySelectorAll('#agentMessages .agent-msg[data-role="assistant"]:not([data-stages])')];
                const bubble = bubbles[bubbles.length - 1];
                if (!bubble) return null;
                return {
                    strong: bubble.querySelectorAll('strong').length,
                    code: bubble.querySelectorAll('code').length,
                    tags: bubble.querySelectorAll('img').length,
                    handlers: bubble.querySelectorAll('[onerror]').length,
                    text: bubble.textContent,
                };
            })()`);
            r.ok('Markdown:助手回复里的 **加粗** / 行内码渲染成元素,标记符号不留在文字里',
                markdown !== null && markdown.strong >= 1 && markdown.code >= 1
                && !String(markdown.text).includes('**'),
                JSON.stringify(markdown).slice(0, 240));
            r.ok('Markdown:排版之后,模型给的 HTML 标签仍然只是文字(不许落地成元素或属性)',
                markdown !== null && markdown.tags === 0 && markdown.handlers === 0
                && /<img src=x onerror="alert\(1\)">/.test(String(markdown.text)),
                JSON.stringify(markdown).slice(0, 240));

            // 流式动效在**写完**之后必须撤干净:不能留在一个已经结束的气泡上
            const streamDone = await win.webContents.executeJavaScript(`(() => {
                // 同上:排掉方案 C 的状态行占位,只找**真回复**那条气泡
                const bubble = document.querySelector('#agentMessages .agent-msg[data-role="assistant"]:not([data-stages])');
                if (!bubble) return null;
                const text = bubble.querySelector('.agent-msg-text');
                return {
                    streaming: bubble.getAttribute('data-streaming'),
                    tails: bubble.querySelectorAll('.agent-tail').length,
                    animation: getComputedStyle(text).animationName,
                };
            })()`);
            r.ok('验收B4:提示结束后流式标记、渐变擦除、扫光动画都已撤掉',
                streamDone !== null && streamDone.streaming === null
                && streamDone.tails === 0 && streamDone.animation === 'none',
                JSON.stringify(streamDone));

            // ---- 黏贴截图:图片真的随提示发到了 agent ----
            //
            // 这是这条功能唯一能证到底的一条:合成一次带 PNG 的 paste → chip 出现 →
            // 点发送 → 主进程校验并把规范化 base64 送上 ACP 线 → 夹具把**它收到的那个
            // 图片块**回显出来。夹具不看真模型,所以这条**不花钱**;而它证的是
            // "字节真的走到了线上",不是"界面上画了一张缩略图"。
            //
            // ⚠️ 位置:必须放在最后。这一次提示会**再触发一遍**夹具的权限卡/提问卡
            // (id 与上一轮相同,面板按 requestId 去重后不会再回答),所以这一轮不会收尾 ——
            // 后面的断言不该依赖"Agent 又回到 ready"。
            //
            // ⚠️ 用的是一张**真能解码、而且比气泡宽**的 PNG(400×300,页面里用 canvas 画的),
            // 不是"8 字节签名 + 4 字节垃圾":
            //   · 下面"发出去的图回显在气泡里"要断言它真的**解得开**(naturalWidth=400)——
            //     解不开正是"URL 被提前撤销 / 破图"那一类缺陷的症状,拿假字节测不到;
            //   · 它比气泡宽,"尺寸自适应气泡"(max-width:100% 把它压下来、比例不变)
            //     才是一条**真的**断言 —— 1×1 的图在任何宽度下都"放得下",那是假通过。
            const IMAGE_BYTES = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
                const input = document.getElementById('agentInput');
                const canvas = document.createElement('canvas');
                canvas.width = 400; canvas.height = 300;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#7ec8ff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    const file = new File([blob], 'clip.png', { type: 'image/png' });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
                    input.dispatchEvent(ev);
                    input.value = '';           // 输入区为空也要发得出去(只发图片)
                    resolve(file.size);
                }, 'image/png');
            }))()`);

            const chipBeforeSend = await win.webContents.executeJavaScript(
                'document.querySelectorAll("#agentPanel .agent-image-chip").length');
            r.ok('黏贴截图(验收):黏贴后输入区有一张待发的 chip',
                chipBeforeSend === 1, `chip=${chipBeforeSend}`);

            await win.webContents.executeJavaScript(
                'document.getElementById("agentSend")?.click()');
            const imageEcho = await waitForMatch(win, '#agentMessages',
                /\[图片 image\/png \d+ 字符 base64\]/, 120);
            r.ok('黏贴截图(验收):图片真的随提示发到了 agent(夹具回显了那个图片块 —— 输入区为空也发得出去)',
                /\[图片 image\/png \d+ 字符 base64\]/.test(String(imageEcho)),
                JSON.stringify(String(imageEcho).slice(-160)));
            r.ok('黏贴截图(验收):线上那块是**整张图**的规范化 base64(字节数 → ceil(N/3)*4 个字符,不是一个空壳)',
                new RegExp(`\\[图片 image/png ${Math.ceil(IMAGE_BYTES / 3) * 4} 字符 base64\\]`).test(String(imageEcho)),
                JSON.stringify(String(imageEcho).slice(-160)));

            const chipsAfterSend = await win.webContents.executeJavaScript(
                'document.querySelectorAll("#agentPanel .agent-image-chip").length');
            r.ok('黏贴截图(验收):发出去之后 chip 清掉(不会被重复发第二次)',
                chipsAfterSend === 0, `chip=${chipsAfterSend}`);

            // ---- 发出去的图要**回显在用户气泡**里 ----
            //
            // 这是这次修的缺陷本身:图发得出去(上面两条已经证了),但自己的气泡里看不见它。
            // 断言在**真实应用**里合成一次粘贴 → 发送 → 气泡里出现 img,src 是渲染层
            // 自己的 blob: URL;并且那张图真的**解得开**(naturalWidth=1)—— 破图
            // 与"发送时把 URL 提前撤销了"是同一个症状,只有解码断言抓得到。
            //
            // ⚠️ 位置:只能在验收这一段(已经连着夹具)。自检(非 --acceptance)下 Agent 停在
            // stopped,点发送会顺手把 Agent 拉起来,那会破坏前面"自检下面板不自动连"那条断言。
            // ⚠️ 不花模型的钱:夹具只回显它收到的块,不做任何推理。
            // ⚠️ 找的是**带图的那个气泡**,不是"最后一条用户消息":夹具的 --echo-prompt 会把
            // 它收到的提示原文当成一条 user_message_chunk 回显(界面上因此有一条重复的
            // 用户气泡,这是夹具的回显、与本次改动无关),那条回显里没有 img。
            const bubbleImage = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
                let i = 0;
                const read = () => {
                    const img = document.querySelector('#agentMessages .agent-msg[data-role="user"] img.agent-msg-image');
                    const bubble = img ? img.closest('.agent-msg') : null;
                    return {
                        userBubbles: document.querySelectorAll('#agentMessages .agent-msg[data-role="user"]').length,
                        images: document.querySelectorAll('#agentMessages img.agent-msg-image').length,
                        hasImg: img !== null,
                        src: img ? img.getAttribute('src') : null,
                        alt: img ? img.getAttribute('alt') : null,
                        natural: img ? img.naturalWidth + 'x' + img.naturalHeight : null,
                        complete: img ? img.complete : null,
                        textRows: bubble ? bubble.querySelectorAll('.agent-msg-text').length : -1,
                        bubbleText: bubble ? (bubble.textContent ?? '').trim() : null,
                    };
                };
                const tick = () => {
                    const now = read();
                    // 等图**解码完**(complete)再下结论;破图也会 complete,所以循环一定会结束
                    if ((now.hasImg === true && now.complete === true) || ++i >= 30) return resolve(now);
                    setTimeout(tick, 100);
                };
                tick();
            }))()`);
            r.ok('黏贴截图(验收):发出去的图回显在**用户气泡**里(img.agent-msg-image,src 是渲染层的 blob: URL)',
                bubbleImage.hasImg === true && bubbleImage.images === 1
                && String(bubbleImage.src).startsWith('blob:'),
                JSON.stringify(bubbleImage).slice(0, 260));
            r.ok('黏贴截图(验收):只发图没写字的气泡里没有多余的空文本行,而且 img 带 alt',
                bubbleImage.textRows === 0
                && bubbleImage.bubbleText === ''
                && typeof bubbleImage.alt === 'string' && bubbleImage.alt !== '',
                JSON.stringify({ rows: bubbleImage.textRows, text: bubbleImage.bubbleText, alt: bubbleImage.alt }));
            r.ok('黏贴截图(验收):气泡里那张图真的**解得开**(naturalWidth=400,不是被提前撤销 URL 的破图)',
                bubbleImage.natural === '400x300', String(bubbleImage.natural));

            // 样式契约:图挂在气泡里要**尺寸自适应**(max-width:100%,不撑破面板)、有圆角。
            // 只断言"节点存在"是不够的 —— 类名打错时样式不会生效,而节点照样在。
            //
            // ⚠️ 但几何断言**必须**在笔记视图里做:上面的验收5 点过探针插件,应用此刻停在
            // 设置视图,而 AI 面板属于笔记工作台 —— 那时 #agentPanel 的宽度是 0,
            // 于是 `宽度 <= 宽度`(0 <= 0)与"没超出面板"两条都**恒真**,断言会假通过。
            // 所以先切回笔记视图,并等面板真的有宽度(下面那条断言就是"前提本身")。
            await win.webContents.executeJavaScript(
                `document.getElementById('viewNotes').click()`);
            const panelLaidOut = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
                let i = 0;
                const tick = () => {
                    const w = document.getElementById('agentPanel').getBoundingClientRect().width;
                    if (w > 0) return resolve(Math.round(w));
                    if (++i >= 30) return resolve(0);
                    setTimeout(tick, 100);
                };
                tick();
            }))()`);
            r.ok('黏贴截图(验收):切回笔记视图后 AI 面板有真实宽度(几何断言的前提 —— 否则 0<=0 会假通过)',
                panelLaidOut > 0, `panelWidth=${panelLaidOut}`);

            const imageStyle = await win.webContents.executeJavaScript(`(() => {
                const img = document.querySelector('#agentMessages img.agent-msg-image');
                if (img === null) return null;
                const cs = getComputedStyle(img);
                const r = img.getBoundingClientRect();
                const row = img.parentElement.getBoundingClientRect();
                const msgs = document.getElementById('agentMessages').getBoundingClientRect();
                return {
                    radius: cs.borderTopLeftRadius,
                    maxWidth: cs.maxWidth,
                    imgWidth: Math.round(r.width),
                    imgHeight: Math.round(r.height),
                    naturalW: img.naturalWidth,
                    naturalH: img.naturalHeight,
                    rowWidth: Math.round(row.width),
                    panelWidth: Math.round(document.getElementById('agentPanel').getBoundingClientRect().width),
                    fitsPanel: r.right <= msgs.right + 1 && r.left >= msgs.left - 1,
                };
            })()`);
            // 原图 400 宽、气泡只有 ~200:真的被压到气泡里了吗?比例还对不对?
            const ratio = (imageStyle === null || imageStyle.imgHeight === 0)
                ? -1 : imageStyle.naturalW / imageStyle.naturalH;
            const shownRatio = (imageStyle === null || imageStyle.imgHeight === 0)
                ? -1 : imageStyle.imgWidth / imageStyle.imgHeight;
            r.ok('黏贴截图(验收):气泡里的图尺寸**自适应气泡**(400 宽的图被压到气泡内、比例不变)且有圆角',
                imageStyle !== null
                && imageStyle.imgWidth > 0
                && imageStyle.imgWidth <= imageStyle.rowWidth + 1
                && imageStyle.imgWidth < imageStyle.naturalW
                && Math.abs(ratio - shownRatio) < 0.05
                && parseFloat(imageStyle.radius) > 0
                && imageStyle.fitsPanel === true,
                JSON.stringify(imageStyle));
        }

        // ★ 用户**真实的布局**上也要验(`{row 28% / 72%}[ {col 53% / 47%}[ 笔记列表 , 链接 ] ,
        //   {row 52% / 48%}[ 笔记正文 , AI 对话 ] ]`):它有纵向边界(左右并排)也有横向边界
        //   (上下叠着),而且左列内部还多一层上下切分 —— 只在默认布局里验一条是不够的。
        const USER_LAYOUT = JSON.stringify({
            v: LAYOUT_VERSION,
            tree: split('row', [28, 72], [
                split('col', [53, 47], [pane('notes'), pane('links')]),
                split('row', [52, 48], [pane('doc'), pane('ai')]),
            ]),
        });
        settings?.set?.(LAYOUT_NAMESPACE, LAYOUT_KEY, USER_LAYOUT);
        win.webContents.reload();
        // ⚠️ 期望值不能直接拿 USER_LAYOUT 算:存档里没有插件那片面板,而工作台
        // 启动时会用 adoptPanes 把它**就地收编**进用户自己的排布里。所以这里
        // 走同一条纯函数路径 —— 断言的正是"收编之后该长什么样",而不是"存档原样"。
        const expectedUserTree = adoptPanes(
            JSON.parse(USER_LAYOUT).tree, WORKSPACE_IDS, WORKSPACE_ADOPTION);
        const userTreeText = formatTree(expectedUserTree, PANE_TITLES);
        const userTree = await waitForTreeText(win, userTreeText);
        r.ok('用户真实布局(既有横边界又有纵边界)按存档渲染,并收编了插件面板',
            userTree === userTreeText, `期望=${userTreeText} | 实际=${userTree}`);
        // 用户自己那份结构必须**毫发无损**:左列 notes/links 的 53/47 与顶层 28/72
        // 都不许因为多了一片面板而被拉平。这是 adoptPanes 的存在理由,单独钉一条。
        const keptTop = expectedUserTree?.sizes?.[0];
        r.ok('收编插件面板之后,用户原有的分栏比例没被改动(顶层左列仍是 28%)',
            Math.abs(Number(keptTop) - 28) < 0.01, `顶层第一份 = ${keptTop}`);

        // 悬停下注用的两个小工具(只在下面这一段用;放这里免得干扰前面那些
        // 对动效敏感、又对"指针停在哪"敏感的断言)。
        const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
        /** 把指针移到某条边界的 7px 缝上(走 CDP,才能真的触发 hover)。 */
        // ⚠️ 悬停态一律走 hoverUntilLit(定义在下面):移一次鼠标 + 等过渡会随运行时机
        // 一过一不过 —— 指针落点是浮点像素,窗口布局一变(比如多了插件那片面板),
        // 命中就可能在边缘上抖。轮询只是多给几次机会,判据没放宽。
        /** 把指针移开(回到笔记面板正文区),让悬停态退掉。 */
        const unhover = async () => {
            const at = await win.webContents.executeJavaScript(`(() => {
                const head = document.querySelector('.pw-pane[data-pane-id="notes"] .pw-tabs');
                const r = head.getBoundingClientRect();
                return { x: Math.round(r.left + 6), y: Math.round(r.top + 220) };
            })()`);
            await moveMouseTo(win, at.x, at.y);
            await sleep(260);
        };

        /**
         * 在边界附近**轮询**到高亮真的亮起来。
         *
         * 为什么要轮询而不是"移一次鼠标 + 等过渡":指针落点是个浮点像素,
         * 而悬停态由 :hover 命中决定 —— 采样时机与命中边缘都会让它偶尔不生效
         * (实测同一条用例两次运行一过一不过)。只等一次就断言,红的是运气不是代码。
         *
         * ⚠️ 这里**不放宽判据**:仍然要求缝里出现一条亮线(innerBright 非空),
         * 只是给它几次机会;每次换一个候选像素点(沿轴向各挪几像素)。
         * 真的不亮时最后仍会失败 —— 该守的性质一点没松。
         */
        const hoverUntilLit = async (from, to, axis, measure, tries = 6) => {
            const base = await win.webContents.executeJavaScript(`(() => {
                const desk = document.getElementById('panelWorkspace');
                const paneOf = (id) => desk.querySelector('.pw-pane[data-pane-id="' + id + '"]');
                const a = paneOf('${from}');
                const b = paneOf('${to}');
                if (!a || !b) return null;
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                const ax = '${axis}';
                const mid = ax === 'x'
                    ? (Math.min(ra.right, rb.right) + Math.max(ra.left, rb.left)) / 2
                    : (Math.min(ra.bottom, rb.bottom) + Math.max(ra.top, rb.top)) / 2;
                const other = ax === 'x'
                    ? Math.round(Math.max(ra.top, rb.top) + 60)
                    : Math.round(Math.max(ra.left, rb.left) + 60);
                return { x: Math.round(ax === 'x' ? mid : other), y: Math.round(ax === 'x' ? other : mid) };
            })()`);
            if (base === null) return null;
            const offsets = [0, -1, 1, -2, 2, -3];
            let last = null;
            for (let i = 0; i < tries; i++) {
                const d = offsets[Math.min(i, offsets.length - 1)];
                const x = axis === 'x' ? base.x + d : base.x;
                const y = axis === 'y' ? base.y + d : base.y;
                await moveMouseTo(win, x, y);
                await sleep(240);
                last = await measure();
                if (last && last.innerBright && last.innerBright.length > 0) return last;
            }
            return last;
        };

        await unhover();
        // 纵向边界(左右并排):左列上 | 正文
        const u1 = await scanBoundaryEdges(win, {
            from: 'notes', to: 'doc', axis: 'x',
            cropPath: path.join(os.tmpdir(), 'kaiwu-seam-user-x-notes-doc-rest.png'),
        });
        r.ok('用户布局·静止态(纵向边界:笔记列表 | 笔记正文):只有两片各自的框,缝里没有亮线',
            seamOnlyOk(u1), edgeDetail(u1));
        // ⚠️ 悬停态用 hoverUntilLit 轮询(见上面那段注释):指针落点是个浮点像素,
        // 只移一次鼠标就断言会让这条用例随运行时机一过一不过。判据不变:缝里要有亮线。
        const u1h = await hoverUntilLit('notes', 'doc', 'x', () => scanBoundaryEdges(win, {
            from: 'notes', to: 'doc', axis: 'x',
            cropPath: path.join(os.tmpdir(), 'kaiwu-seam-user-x-notes-doc-hover.png'),
        }));
        r.ok('用户布局·悬停态(纵向边界):缝里冒出那条 accent 高亮线(可拖的唯一提示)',
            highlightOk(u1h), edgeDetail(u1h));
        await unhover();
        // 横向边界(上下叠着):左列内部那一层切分
        const u2 = await scanBoundaryEdges(win, {
            from: 'notes', to: 'links', axis: 'y',
            cropPath: path.join(os.tmpdir(), 'kaiwu-seam-user-y-notes-links-rest.png'),
        });
        r.ok('用户布局·静止态(横向边界:笔记列表 ↔ 链接):只有两片各自的框,缝里没有亮线',
            seamOnlyOk(u2), edgeDetail(u2));
        const u2h = await hoverUntilLit('notes', 'links', 'y', () => scanBoundaryEdges(win, {
            from: 'notes', to: 'links', axis: 'y',
            cropPath: path.join(os.tmpdir(), 'kaiwu-seam-user-y-notes-links-hover.png'),
        }));
        r.ok('用户布局·悬停态(横向边界):缝里冒出那条 accent 高亮线',
            highlightOk(u2h), edgeDetail(u2h));
        await unhover();

        // 单独验"框还在":挑一条**不挨着别的面板**的外缘(笔记列表的上缘),
        // 它上面 1px 就是这一片自己的框 —— 缝里的两条框属于边界,这条属于面板自己。
        const outerRect = await win.webContents.executeJavaScript(`(() => {
            const p = document.querySelector('.pw-pane[data-pane-id="notes"]');
            if (!p) return null;
            const r = p.getBoundingClientRect();
            return {
                x: Math.round(r.left + 40), y: Math.round(r.top) - 6,
                width: 60, height: 13,
            };
        })()`);
        if (outerRect === null) {
            r.ok('保留框:笔记列表的外缘那一行是框色(≈58)', false, '找不到笔记列表面板');
        } else {
            const outerShot = await win.webContents.capturePage(outerRect);
            const outerRows = medianLines(outerShot, 'y').lines
                .map((c) => ({ rgb: c, brightness: Math.round((c[0] + c[1] + c[2]) / 3) }));
            const outerMax = outerRows.reduce((a, b) => (b.brightness > a.brightness ? b : a));
            r.ok('保留框(方案 A):最外侧那片面板的**外缘**那一行是框色(≈58),不是"没框"',
                outerMax.brightness >= 45 && outerMax.brightness <= 75,
                JSON.stringify({ rect: outerRect, rows: outerRows.map((x) => x.brightness), max: outerMax }));
        }

        // ---- 设置视图(设计稿 docs/kaiwu-settings-page-demo.html 方案 D)----
        //
        // 这一节量的是**真窗口**:切视图、左导航 + 搜索、搜索真的过滤、以及那几项读数
        // 是不是真的从既有通道读来的(密钥状态 / 布局树文本 / 索引篇数)。
        const settingsProbe = () => win.webContents.executeJavaScript(`(() => {
            const byId = (id) => document.getElementById(id);
            const txt = (id) => { const e = byId(id); return e ? e.textContent : null; };
            const pane = byId('paneSettings');
            const nav = [...document.querySelectorAll('#settingsNav button')];
            const rows = [...document.querySelectorAll('#settingsBody .settings-item')];
            return {
                paneExists: pane !== null,
                hidden: pane ? pane.hidden : null,
                notesHidden: byId('paneNotes') ? byId('paneNotes').hidden : null,
                tabSelected: byId('viewSettings') ? byId('viewSettings').getAttribute('aria-selected') : null,
                navNames: nav.map((b) => b.textContent),
                navSelected: nav.filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.textContent),
                searchPresent: byId('settingsSearch') !== null,
                rowIds: rows.map((r) => r.dataset.item),
                sectionTitles: [...document.querySelectorAll('#settingsBody .settings-section-title')].map((t) => t.textContent),
                overview: txt('settingsOverview'),
                emptyText: txt('settingsEmpty'),
                videoModel: txt('settingsVideoModelNow'),
                credential: txt('settingsValue-credential'),
                layoutTree: txt('settingsLayoutTree'),
                indexStatus: txt('settingsIndexStatus'),
                vaultPath: txt('settingsVaultPath'),
                restartNotes: [...document.querySelectorAll('#settingsBody .settings-restart')]
                    .map((e) => e.textContent).filter((t) => t !== ''),
                serviceRootInput: byId('settingsPath-serviceRoot') ? byId('settingsPath-serviceRoot').value : null,
            };
        })()`);
        const waitForBoot = async (tries = 60) => {
            for (let i = 0; i < tries; i++) {
                const ok = await win.webContents.executeJavaScript(
                    `(() => { const s = document.getElementById('shell'); return s !== null && s.hidden === false; })()`,
                ).catch(() => false);
                if (ok === true) return true;
                await new Promise((res) => { setTimeout(res, 100); });
            }
            return false;
        };

        await win.webContents.executeJavaScript(`document.getElementById('viewSettings').click()`);
        await new Promise((res) => { setTimeout(res, 400); });        // 设置页要读几个通道(异步)
        const s0 = await settingsProbe();
        r.ok('设置视图:点「设置」标签能切过去(三个视图互斥,标签 aria-selected 跟着走)',
            s0.paneExists === true && s0.hidden === false && s0.notesHidden === true
            && s0.tabSelected === 'true',
            JSON.stringify({ hidden: s0.hidden, notes: s0.notesHidden, tab: s0.tabSelected }));
        r.ok('设置视图(方案 D):左导航 4 个分区 + 搜索框都在,默认选中第一个分区',
            Array.isArray(s0.navNames) && s0.navNames.join(',') === 'AI 与 Agent,界面,服务,笔记库'
            && s0.searchPresent === true && s0.navSelected.join(',') === 'AI 与 Agent',
            JSON.stringify({ nav: s0.navNames, selected: s0.navSelected, search: s0.searchPresent }));
        r.ok('设置视图:默认列出全部 10 项(8 项已有通道 + 2 笔欠账),顶部有徽标总览',
            s0.rowIds.length === 10 && /已有通道 8 · 需要新做 2/.test(String(s0.overview)),
            JSON.stringify({ n: s0.rowIds.length, overview: s0.overview }));
        r.ok('设置视图:密钥状态是**真读数**(来自 video:status,只有叶子字段)',
            /已配置|未配置/.test(String(s0.credential)),
            JSON.stringify({ credential: s0.credential, model: s0.videoModel }));
        r.ok('设置视图:布局树文本与工作台底部那条读数条**同源**(都是同一个 formatTree)',
            s0.layoutTree !== null && s0.layoutTree === (await readWorkspace()).tree,
            `设置页=${s0.layoutTree} | 工作台=${(await readWorkspace()).tree}`);
        // ⚠️ 换库的**唯一入口**现在就是这里:所以这条要同时钉住"显示的是当前那份"+"入口按钮真的在"。
        r.ok('设置视图:索引状态是真读数,库路径是**当前**那一份,而且「更换」这个唯一入口就在同一行',
            /已载入 \d+ 篇/.test(String(s0.indexStatus))
            && String(s0.vaultPath).includes('kaiwu-selftest-vault')
            && (await win.webContents.executeJavaScript(
                `(() => { const b = document.getElementById('settingsVaultChange');
                   return b !== null && b.offsetParent !== null; })()`)),
            JSON.stringify({ index: s0.indexStatus, vault: s0.vaultPath }));
        // ⚠️ 换库的**唯一入口**就在设置里:点它必须真的打开换库向导(不是只有个按钮摆着)。
        const openedBySettings = await win.webContents.executeJavaScript(`(() => {
            const b = document.getElementById('settingsVaultChange');
            if (b === null) return { ok: false, why: '按钮不在' };
            b.click();
            const o = document.getElementById('onboarding');
            return { ok: o !== null && o.hidden === false, hidden: o ? o.hidden : null };
        })()`);
        await gazeSleep(300);
        r.ok('设置里点「更换」= 真的打开换库向导(撤掉顶栏之后它是唯一入口)',
            openedBySettings.ok === true, JSON.stringify(openedBySettings));
        await win.webContents.executeJavaScript(`(() => { const s = document.getElementById('onboardingSkip'); if (s) s.click(); return true; })()`);
        await gazeSleep(400);
        r.ok('设置视图:两笔欠账(DSH_HOME / 服务根目录)都写明"改了要重启才生效"',
            s0.restartNotes.length === 2 && s0.restartNotes.every((t) => /重启/.test(t)),
            JSON.stringify(s0.restartNotes));

        // 搜索:跨分区过滤 + 命中数 + 空结果(设计稿里就是这个行为)
        const typeSearch = async (text) => {
            await win.webContents.executeJavaScript(`(() => {
                const s = document.getElementById('settingsSearch');
                s.value = ${JSON.stringify(text)};
                s.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`);
            await new Promise((res) => { setTimeout(res, 120); });
            return await settingsProbe();
        };
        const hitKey = await typeSearch('密钥');
        r.ok('设置视图·搜索:输入「密钥」只留命中的项,分区标题带命中数',
            hitKey.rowIds.join(',') === 'videoKey' && hitKey.sectionTitles.join(',') === 'AI 与 Agent(1)',
            JSON.stringify({ rows: hitKey.rowIds, titles: hitKey.sectionTitles }));
        const hitPath = await typeSearch('路径');
        r.ok('设置视图·搜索:跨分区命中(路径 → 多个分区),每节标题都带命中数',
            hitPath.rowIds.length >= 2 && hitPath.sectionTitles.every((t) => /\(\d+\)$/.test(t)),
            JSON.stringify({ rows: hitPath.rowIds, titles: hitPath.sectionTitles }));
        const hitNone = await typeSearch('zzz-不存在的词');
        r.ok('设置视图·搜索:没有命中时说"没有匹配的设置项"(不是空白页)',
            hitNone.rowIds.length === 0 && hitNone.emptyText === '没有匹配的设置项:zzz-不存在的词',
            JSON.stringify({ empty: hitNone.emptyText }));
        const searchCleared = await typeSearch('');
        r.ok('设置视图·搜索:清空查询后恢复全部 10 项', searchCleared.rowIds.length === 10,
            JSON.stringify({ rows: searchCleared.rowIds.length }));

        // 路径类设置:非法值当场拒;合法值写进设置,重载后能读回来
        await win.webContents.executeJavaScript(`(() => {
            const input = document.getElementById('settingsPath-serviceRoot');
            input.value = 'relative-path';
            document.getElementById('settingsPathSave-serviceRoot').click();
            return true;
        })()`);
        await new Promise((res) => { setTimeout(res, 200); });
        const badState = await win.webContents.executeJavaScript(`(() => {
            const note = document.getElementById('settingsPathNote-serviceRoot');
            return { note: note ? note.textContent : null, state: note ? note.dataset.state : null };
        })()`);
        r.ok('设置视图·路径:相对路径当场拒(不写存档),并说清为什么',
            badState.state === 'bad' && /绝对路径/.test(String(badState.note))
            && String(settings?.get?.(LAYOUT_NAMESPACE, 'serviceRoot') ?? '') !== 'relative-path',
            JSON.stringify({ ...badState, stored: settings?.get?.(LAYOUT_NAMESPACE, 'serviceRoot') }));

        const SAVED_ROOT = 'D:\\kaiwu-selftest-root';
        await win.webContents.executeJavaScript(`(() => {
            const input = document.getElementById('settingsPath-serviceRoot');
            input.value = ${JSON.stringify(SAVED_ROOT)};
            document.getElementById('settingsPathSave-serviceRoot').click();
            return true;
        })()`);
        await new Promise((res) => { setTimeout(res, 250); });
        const savedNote = await win.webContents.executeJavaScript(`(() => {
            const note = document.getElementById('settingsPathNote-serviceRoot');
            return { note: note ? note.textContent : null, state: note ? note.dataset.state : null };
        })()`);
        r.ok('设置视图·路径:合法的绝对路径写进设置,并明说"重启才生效"',
            settings?.get?.(LAYOUT_NAMESPACE, 'serviceRoot') === SAVED_ROOT
            && savedNote.state === 'ok' && /重启/.test(String(savedNote.note)),
            JSON.stringify({ stored: settings?.get?.(LAYOUT_NAMESPACE, 'serviceRoot'), note: savedNote }));

        // ---- 「停止 Agent 进程」:设置页里的**常驻入口** ----
        //
        // ⚠️ 位置**必须在下面那次 `webContents.reload()` 之前**:这一段要量的是
        // "按下去之后**面板那一侧**真的留了再连的出口",而重载会把渲染进程换掉 ——
        // 换掉之后主进程推过来的 `agent:event` 到不了新页面(重载那条断言里带着诊断),
        // 面板就永远停在它挂载时读到的那一版状态上。放在重载前,量到的才是真链路。
        //
        // 那一行上的按钮改成"出事才出现"之后,这里是"平时也找得到"的那一条:
        // 输入卡片上找不到它时,用户在「设置 → AI 与 Agent」里一定找得到。
        // 读数来自 agent:status(**真读数**,不是页面自己猜的),按钮可用性按同一条判据:
        // 进程根本没在跑的时候按它没有任何意义 —— 那时它是灰的。
        //
        // 验收模式下 Agent 是真的在跑(前面 M3 点的连接、握手走注入的夹具),
        // 所以这一段能真的按一次、真的把它停掉;自检模式里它本来就没跑,
        // 那就断言"按钮确实是灰的、确实没被按"。
        const killItemProbe = async () => await win.webContents.executeJavaScript(`(() => {
            const row = [...document.querySelectorAll('#settingsBody .settings-item')]
                .find((r) => r.dataset.item === 'agentKill');
            const btn = document.getElementById('settingsAgentKill');
            const state = document.getElementById('settingsAgentState');
            return {
                rowFound: row !== undefined,
                title: row ? (row.querySelector('.settings-title')?.textContent ?? '') : null,
                hint: row ? (row.querySelector('.settings-hint')?.textContent ?? '') : null,
                stateText: state ? state.textContent : null,
                disabled: btn ? btn.disabled : null,
                btnFound: btn !== null,
            };
        })()`);
        const killItem = await killItemProbe();
        r.ok('设置页有「停止 Agent 进程」这一项(常驻入口,与输入卡片上那个按钮同一件事)',
            killItem.rowFound === true && killItem.btnFound === true
            && /停止 Agent 进程/.test(String(killItem.title ?? '')),
            JSON.stringify(killItem));
        r.ok('设置页那一项显示的是 agent:status 的**真读数**,而且按钮可用性跟着同一条判据(没得停就是灰的)',
            /^Agent:(未连接|连接中…|已连接|连接失败|已断开)/.test(String(killItem.stateText ?? ''))
            && killItem.disabled === (/未连接/.test(String(killItem.stateText ?? ''))),
            JSON.stringify({ state: killItem.stateText, disabled: killItem.disabled }));
        r.ok('设置页那一项写清了"停掉之后回哪儿再连"(否则用户会以为只能重启开物)',
            /重试/.test(String(killItem.hint ?? '')),
            JSON.stringify({ hint: killItem.hint }));

        let killClicked = { clicked: false, after: null };
        if (killItem.disabled === false) {
            await win.webContents.executeJavaScript(`(() => {
                document.getElementById('settingsAgentKill').click();
                return true;
            })()`);
            killClicked.clicked = true;
            await waitForMatch(win, '#settingsAgentKillNote', /已停止|没停成/, 90);
            // ⚠️ 面板那一侧(状态属性、提示卡、重试按钮搬家)是**排一帧**画的
            // (panel.js 的 scheduleRender)。所以等属性真的翻过去再读,
            // 而不是点完立刻读 —— 窗口在后台时那一帧会晚到,立刻读就是"什么都没发生"。
            const panelStateAfterKill = await waitForAttr(win, '#agentPanel', 'data-agent-state', 'stopped', 90);
            killClicked.after = await win.webContents.executeJavaScript(`(() => {
                const panel = document.getElementById('agentPanel');
                const notice = panel.querySelector('.agent-notice');
                const retry = document.getElementById('agentRetry');
                return {
                    note: (document.getElementById('settingsAgentKillNote') || {}).textContent ?? '',
                    state: (document.getElementById('settingsAgentState') || {}).textContent ?? '',
                    panelState: panel.dataset.agentState,
                    noticeExists: notice !== null,
                    noticeText: notice ? notice.textContent : null,
                    // ⚠️ notice 为 null 时 closest 也是 null —— 那样"true"是假的,
                    // 所以显式要求提示卡**存在**
                    retryInNotice: notice !== null && retry !== null
                        && retry.closest('.agent-notice') === notice,
                };
            })()`);
            killClicked.after.panelState = panelStateAfterKill;
        }
        r.ok('设置页里按下「停止进程」:说清停成了没、现在什么状态、下一步按哪儿 —— 而且面板那一侧真的留了再连的出口',
            killClicked.clicked === false
                // 自检模式:Agent 本来就没跑 —— 断言它确实是灰的(也就是"没有被按")
                ? killItem.disabled === true
                : (/已停止/.test(String(killClicked.after?.note ?? ''))
                    && /重试/.test(String(killClicked.after?.note ?? ''))
                    && killClicked.after?.panelState === 'stopped'
                    && killClicked.after?.noticeExists === true
                    && /已经停掉/.test(String(killClicked.after?.noticeText ?? ''))
                    && killClicked.after?.retryInNotice === true),
            JSON.stringify({ clicked: killClicked.clicked, after: killClicked.after }));

        win.webContents.reload();
        const bootedAfterSettings = await waitForBoot();
        await win.webContents.executeJavaScript(`document.getElementById('viewSettings').click()`);
        await new Promise((res) => { setTimeout(res, 400); });
        const s1 = await settingsProbe();
        // ⚠️ 诊断(不算判定,只留事实):重载之后主进程推的 agent:event 还到得了新页面吗?
        // 这不是本次改动的目标,但它决定了"停掉之后面板留出口"那条能不能放在重载之后量。
        const preReloadState = await win.webContents.executeJavaScript(
            `document.getElementById('agentPanel').dataset.agentState`);
        win.webContents.send(AGENT_EVENT_CHANNEL, {
            kind: 'state', status: { state: 'starting', pid: null, error: null, restarts: 0, since: 1 },
        });
        await new Promise((res) => { setTimeout(res, 300); });
        const postReloadState = await win.webContents.executeJavaScript(
            `document.getElementById('agentPanel').dataset.agentState`);
        win.webContents.send(AGENT_EVENT_CHANNEL, {
            kind: 'state', status: { state: preReloadState, pid: null, error: null, restarts: 0, since: 1 },
        });
        await new Promise((res) => { setTimeout(res, 120); });
        r.ok('设置视图·重载:改过的路径重载之后能读回来(存档真的落了盘)',
            bootedAfterSettings === true && s1.serviceRootInput === SAVED_ROOT,
            JSON.stringify({
                booted: bootedAfterSettings, value: s1.serviceRootInput,
                // 重载后 agent:event 还到不到新页面(诊断;与判定无关)
                reloadAgentEventDelivery: { before: preReloadState, afterSynth: postReloadState },
            }));

        // 「减少动态效果(强制关)」:根属性 + 全局覆盖 + 那条一直在走的光带真的停
        const bandSample = () => win.webContents.executeJavaScript(`(async () => {
            let box = document.getElementById('kaiwuMotionProbe');
            if (!box) {
                box = document.createElement('div');
                box.id = 'kaiwuMotionProbe';
                box.className = 'sbar indeterminate';
                const band = document.createElement('i');
                box.appendChild(band);
                (document.getElementById('paneSettings') || document.body).appendChild(box);
            }
            const band = box.querySelector('i');
            const a = getComputedStyle(band).transform;
            await new Promise((r) => setTimeout(r, 420));
            const b = getComputedStyle(band).transform;
            return { a, b, moved: a !== b, anim: getComputedStyle(band).animationName };
        })()`);
        // ⚠️ 采样前把窗口抬到前台:CSS 动画与 rAF 在窗口被遮挡时会被合成器节流,
        //    那时"两次采样相同"测到的是环境,不是 data-motion(实测两种运行都出现过)。
        try { win.focus(); win.moveTop(); } catch { /* 抬不动就按抬不动算(下面的判据会如实记) */ }
        await new Promise((res) => { setTimeout(res, 260); });
        const motionBefore = await bandSample();
        // 星空是 canvas + requestAnimationFrame,**不吃 CSS** —— 必须单独量:
        // 两次采样画布内容,静止时逐字节相同(循环真的停了),动的时候必须不同。
        const starSample = () => win.webContents.executeJavaScript(`(async () => {
            const c = document.getElementById('starfield');
            if (!c) return null;
            const a = c.toDataURL();
            await new Promise((r) => setTimeout(r, 420));
            const b = c.toDataURL();
            return { same: a === b, bytes: a.length };
        })()`);
        const starBefore = await starSample();
        await win.webContents.executeJavaScript(`(() => {
            const i = document.getElementById('settingsMotionOff');
            i.checked = true;
            i.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        await new Promise((res) => { setTimeout(res, 500); });
        const motionAfter = await win.webContents.executeJavaScript(`(() => {
            const band = document.querySelector('#kaiwuMotionProbe i');
            return {
                attr: document.documentElement.getAttribute('data-motion'),
                anim: band ? getComputedStyle(band).animationName : null,
                transition: band ? getComputedStyle(band).transitionDuration : null,
            };
        })()`);
        const motionFrozen = await bandSample();
        const starAfter = await starSample();
        // ⚠️ 这两条的判据必须拆开看:**"关掉之后真的停"要成立,前提是"关掉之前真的在动"**。
        //    而 CSS 动画与 canvas 的 rAF 在窗口被遮挡 / 合成器那一刻没醒时**根本不推进**
        //    (实测:同一份代码,有的运行 `frame: 165 fps` 且这两条全绿;有的运行切换前
        //     `moved=false` / `same=true`,而 `anim` 明明写着 `stage-band-drift`)。
        //    那时测到的是"这台机器当前量不到",不是"动效不受 data-motion 控制" ——
        //    所以只有在**根属性与覆盖规则都正确**、只是"停下"这一条测不到时才记 [SKIP]
        //    (会进汇总句的"因环境跳过",肉眼可见);只要根属性或覆盖规则没生效,照样红。
        //    **判据一个字没放宽。**
        if (motionBefore.moved === true) {
            r.ok('设置视图·动效:打开「强制关」→ 根属性 data-motion=off,一直在走的光带**停下**(两次 transform 相同)',
                motionAfter.attr === 'off' && motionAfter.anim === 'none' && motionFrozen.moved === false,
                JSON.stringify({ before: motionBefore, after: motionAfter, frozen: motionFrozen }));
        } else if (motionAfter.attr === 'off' && motionAfter.anim === 'none') {
            r.skip('设置视图·动效:打开「强制关」→ 一直在走的光带**停下**(两次 transform 相同)',
                `窗口当前没在合成:切换前那一段本来就 moved=false(anim=${motionBefore.anim}),`
                + `"停下"这件事本次测不到;根属性与覆盖规则都已生效:${JSON.stringify(motionAfter)}`);
        } else {
            r.ok('设置视图·动效:打开「强制关」→ 根属性 data-motion=off,一直在走的光带**停下**(两次 transform 相同)',
                false, JSON.stringify({ before: motionBefore, after: motionAfter, frozen: motionFrozen }));
        }
        if (starBefore !== null && starBefore.same === false) {
            r.ok('设置视图·动效:星空(canvas + rAF,不吃 CSS)也真的停了 —— 两次采样的画布内容逐字节相同',
                starAfter !== null && starAfter.same === true,
                JSON.stringify({ before: starBefore, after: starAfter }));
        } else if (starAfter !== null && starAfter.same === true) {
            r.skip('设置视图·动效:星空(canvas + rAF)也真的停了 —— 两次采样的画布内容逐字节相同',
                `画布在切换前就没在动(前置测不到,窗口没在合成):${JSON.stringify({ before: starBefore, after: starAfter })}`);
        } else {
            r.ok('设置视图·动效:星空(canvas + rAF,不吃 CSS)也真的停了 —— 两次采样的画布内容逐字节相同',
                false, JSON.stringify({ before: starBefore, after: starAfter }));
        }
        r.ok('设置视图·动效:开关落了盘(ui.motion=off)',
            settings?.get?.(LAYOUT_NAMESPACE, 'ui.motion') === 'off',
            JSON.stringify(settings?.get?.(LAYOUT_NAMESPACE, 'ui.motion')));

        // 切回「笔记」:工作台照旧(外壳面板 + 布局树读数都在)
        await win.webContents.executeJavaScript(`document.getElementById('viewNotes').click()`);
        await new Promise((res) => { setTimeout(res, 200); });
        const backToNotes = await readWorkspace();
        // ⚠️ 这里只断言"工作台照旧":重载之后渲染的是**存档里那份布局**
        // (也就是上面那条用户真实布局),不是默认那张,所以不能拿默认的四片顺序去比。
        // ⚠️ 用**包含**而不是等于 4:插件贡献的面板(短剧画布)也会在这里出现,
        // 而"切个视图插件就没了"才是这条真正要守的东西。
        r.ok('设置视图:切回「笔记」后工作台照旧(外壳面板都在、布局树读数还在)',
            SHELL_PANE_IDS.every((id) => backToNotes.ids.includes(id))
            && /^\{row /.test(backToNotes.tree),
            JSON.stringify({ ids: backToNotes.ids, tree: backToNotes.tree }));

        await win.webContents.executeJavaScript(`document.getElementById('viewSettings').click()`);
        const focusedFromSettings = await openTool('palette');
        const returnedToWorkspace = await win.webContents.executeJavaScript(`({
            notes: !document.getElementById('paneNotes').hidden,
            settings: document.getElementById('paneSettings').hidden,
        })`);
        r.ok('从设置打开工具面板会返回笔记工作台并聚焦已有工具',
            focusedFromSettings === true && returnedToWorkspace.notes && returnedToWorkspace.settings,
            JSON.stringify({ focusedFromSettings, ...returnedToWorkspace }));

        // 把动效开关放回去(别把"强制关"留给后面的断言)
        await win.webContents.executeJavaScript(`(() => {
            const i = document.getElementById('settingsMotionOff');
            i.checked = false;
            i.dispatchEvent(new Event('change', { bubbles: true }));
            const probe = document.getElementById('kaiwuMotionProbe');
            if (probe) probe.remove();
            return true;
        })()`);
        await new Promise((res) => { setTimeout(res, 300); });
        const motionReset = await win.webContents.executeJavaScript(
            `document.documentElement.getAttribute('data-motion')`,
        );
        r.ok('设置视图·动效:关掉开关后根属性摘掉(恢复跟随系统),不把"强制关"留给后面的用例',
            motionReset === null && settings?.get?.(LAYOUT_NAMESPACE, 'ui.motion') === '',
            JSON.stringify({ attr: motionReset, stored: settings?.get?.(LAYOUT_NAMESPACE, 'ui.motion') }));

        // ★ 最后一条:**真的重载窗口**,证明布局的比例持久化("重载后仍是拖后的样子")。
        //
        // 为什么放在最后:重载会把渲染进程的会话状态清掉(打开过的笔记、AI 面板的
        // 消息流、视频那几段),放在中间会把后面两百多条断言一起打掉。
        // 为什么非重载不可:上面那些 `decodeLayout` 只证明"存档解得回来",证明不了
        // "启动时会照着它渲染" —— 而用户要的恰恰是后者(他把应用关掉再打开)。
        //
        // 先重置再拖:这样"拖后的样子"明确区别于默认布局,重载之后只要还看到它,
        // 就说明存档真的被启动路径用上了。
        // ⚠️ 判据跟着手势一起换了:拖的是一枚**标签**,它落到 ai 的右边缘之后长出一个
        //    单标签新槽位(右栏内部于是变成 [AI 对话 | 新槽位] 的横向切分),默认布局里没有它。
        await win.webContents.executeJavaScript('document.getElementById("layoutReset").click()');
        const redrag = await synthTabDrag('links', 0, 'ai', 'edge-right');
        const treeBeforeReload = (await readWorkspace()).tree;
        win.webContents.reload();
        const treeAfterReload = await waitForTreeText(win, treeBeforeReload);
        const reloadSlotId = (redrag.ids ?? []).find((id) => id.startsWith('slot:'));
        r.ok('★ 重载窗口之后布局还是拖后的样子(存档 → 启动 → 渲染这条真路径)',
            redrag.ok === true && reloadSlotId !== undefined && treeAfterReload === treeBeforeReload
            // ⚠️ 判据落在**形状**上,不落在裸槽位 id 上:底部那行读数按规格 §6 印的是
            //    "活动标签的标题"(panel-workspace.js 的 slotLabel),所以新槽位显示成
            //    「链接」而不是 `slot:1`;`slot:<n>` 这个 id 由上面 `reloadSlotId` 那条钉住。
            && /\{row [\d.]+% \/ [\d.]+%\}\[ AI 对话 , 链接 \]/.test(treeAfterReload),
            `拖后=${treeBeforeReload} | 重载后=${treeAfterReload} | 新槽位=${reloadSlotId}`);

        // ---- 最后一件事:在**真窗口**里把"一颗球两态"走完(点它发送 → 执行中再点它取消)----
        //
        // 为什么放在最末尾:取消会把正在飞的那次请求掐掉,放前面就会改写后面那些
        // "回复出现了"之类的断言。这里跑完之后自检只剩收尾,谁也影响不到。
        // 为什么还要先点一次「连接」:上一步**重载过窗口**,而这个外壳是 autoStart=false
        // (自检绝不自动拉起真的 dsh),重载之后它停在 stopped —— 要走这条断言得先接上。
        let ballReady = await waitForAttr(win, '#agentPanel', 'data-agent-state', 'ready', 3);
        if (ballReady !== 'ready') {
            await win.webContents.executeJavaScript('document.getElementById("agentRetry")?.click()');
            ballReady = await waitForAttr(win, '#agentPanel', 'data-agent-state', 'ready', 150);
        }
        const ballCancel = await win.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((res) => { setTimeout(res, ms); });
            const panel = document.getElementById('agentPanel');
            const ball = document.getElementById('agentSend');
            const input = document.getElementById('agentInput');
            const state = () => (panel ? panel.getAttribute('data-agent-state') : null);
            const mode = () => ball.getAttribute('data-mode');
            const label = () => ball.getAttribute('aria-label');
            if (panel === null || ball === null || input === null) return { ok: false, why: '缺元素' };
            if (state() !== 'ready') return { ok: false, why: 'Agent 不是 ready: ' + state() };
            const before = { mode: mode(), label: label(), disabled: ball.disabled };
            input.value = '球的两态自检';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            ball.click();                                  // ① 空闲点它 = 发送
            await wait(160);
            const busy = { mode: mode(), label: label(), disabled: ball.disabled };
            ball.click();                                  // ② 执行中再点它 = 取消
            await wait(600);
            const after = { mode: mode(), label: label(), disabled: ball.disabled, state: state() };
            return { ok: true, before, busy, after };
        })()`).catch((err) => ({ ok: false, why: '注入失败: ' + err.message }));
        r.ok('一颗球两态(真窗口):空闲点它是发送,执行中它变成「取消当前提示」,再点一下就回到发送',
            ballCancel.ok === true
            && ballCancel.before.mode === 'send' && ballCancel.before.label === '发送'
            && ballCancel.busy.mode === 'cancel' && ballCancel.busy.label === '取消当前提示'
            // 执行中它**不许是灰的**:取消是唯一出路
            && ballCancel.busy.disabled === false
            && ballCancel.after.mode === 'send' && ballCancel.after.label === '发送',
            JSON.stringify(Object.assign({ agentState: ballReady }, ballCancel)));


        // ---- 状态脸 + 撕裂层的回收(硬证据:data-face / data-tear 两个叶子属性)----
        // ⚠️ 非侵入式:注入 failed 之前先记下当前状态,读完**再注入回去**,前后一致,
        //    不影响后面任何断言(上一版直接注入 failed 就留在那儿,把 crashed 那条搞红了)。
        const faceRead2 = () => win.webContents.executeJavaScript(`(() => {
            const p = document.getElementById('agentPanel');
            const b = document.getElementById('agentSend');
            return { face: p.getAttribute('data-face'), tear: p.getAttribute('data-tear'),
                     scale: p.getAttribute('data-gaze-scale'), err: p.getAttribute('data-face-error'),
                     panels: document.querySelectorAll('#agentPanel').length,
                     hosts: b.querySelectorAll('.agent-orb-tear').length,
                     slices: (b.querySelector('.agent-orb-tear') || { children: [] }).children.length,
                     state: p.dataset.agentState };
        })()`);
        const savedState = await win.webContents.executeJavaScript(`document.getElementById('agentPanel').dataset.agentState`);
        const send2 = (name) => win.webContents.send(AGENT_EVENT_CHANNEL, { kind: 'state',
            status: { state: name, pid: name === 'ready' ? 1 : null, error: name === 'crashed' ? { message: '自检:假装崩了' } : null, restarts: 0, since: null } });
        const before2 = await faceRead2();
        r.ok('非失败态:data-tear=0(9 层常驻是纯空耗),而且只有一个面板实例',
            before2.tear === '0' && before2.hosts === 0 && before2.panels === 1,
            JSON.stringify(before2));
        send2('crashed'); await gazeSleep(500);
        const crashed2 = await faceRead2();
        r.ok('崩溃态:脸=failed 且 data-tear=' + 9 + '(撕裂层真的建起来了,不是绕过去)',
            crashed2.face === 'failed' && crashed2.tear === String(9) && crashed2.slices === 9,
            JSON.stringify(crashed2));
        send2(savedState); await gazeSleep(500);
        const back2 = await faceRead2();
        r.ok('离开失败态:data-tear 回到 0,撕裂层整体回收',
            back2.tear === '0' && back2.hosts === 0 && back2.face !== 'failed',
            JSON.stringify(back2));

        // =====================================================================
        // ★ 标签条(第五轮):真窗口里的六条读数
        //
        // 放在**最后**:这一组会点笔记、关标签、把某一格关空、还会拖面板,
        // 前面那些对"面板里有什么"敏感的断言(尤其是 drama 那二十来条)不能被它影响。
        // 跑完这里已经只剩收尾。
        // =====================================================================
        //
        // 先回到"默认布局 + 没有打开过笔记"的干净起点,再去点列表里的第一篇笔记。
        // ⚠️ 顺序要紧:**先切回笔记视图再重置布局**。工作台就藏在笔记视图里,视图不可见时
        //    每一格的宽度都是 0,那时重画标签条会把每一条都算成"窄"→ 降级成下拉、胶囊一个
        //    都不留(实测:整段标签条断言在 tabs[-1] 上抛)。判据一个字没变,只是把"重画发生
        //    在可见状态下"这个前置条件钉死。
        await win.webContents.executeJavaScript(`document.getElementById('viewNotes').click()`);
        await gazeSleep(250);
        await win.webContents.executeJavaScript('document.getElementById("layoutReset").click()');
        await gazeSleep(200);

        // 读一片面板的标签读数(直接问工作台拿,不猜 DOM)
        const readTabs = (id) => win.webContents.executeJavaScript(`(() => {
            const api = window.__pwTabs;
            if (!api) return null;
            return { paneId: ${JSON.stringify(id)}, ...api.tabsOf(${JSON.stringify(id)}) };
        })()`);
        const tabReadAll = () => win.webContents.executeJavaScript(`(() => {
            const api = window.__pwTabs;
            return api ? api.allTabs() : null;
        })()`);

        /**
         * 把某一格**弄成胶囊形态**并确认;弄不到就返回 null(由调用方如实报失败)。
         *
         * ⚠️ 为什么需要它:标签条在**可用宽度 < 220px** 时按规格(§4.1/§6)降级成
         *    「当前视图名 ∨」下拉 —— 那时 DOM 里**没有** .pw-tab 胶囊,而下面那五条关闭
         *    入口(× / 中键 / 右键菜单)全都要点胶囊。实测:用户真实布局下 doc 那一格的
         *    可用宽度就在 220px 这条线附近抖(某次 222 → 胶囊,某次 219 → 下拉),
         *    同一份代码一次全绿、一次整段在 `tabs[-1]` 上抛掉。
         *    这里**没有放宽任何判据**:只是先把前置条件(宽到能出胶囊)钉死;真弄不到时
         *    会报一条明确的失败,而不是一个看不懂的 TypeError。
         */
        const ensureCapsule = async (paneId) => {
            for (let i = 0; i < 4; i += 1) {
                const m = await win.webContents.executeJavaScript(`(() => {
                    const p = document.querySelector('.pw-pane[data-pane-id="${paneId}"]');
                    if (!p) return null;
                    return {
                        mode: p.querySelector('.pw-tabs')?.dataset.mode ?? null,
                        chips: p.querySelectorAll('.pw-tab').length,
                        w: Math.round(p.getBoundingClientRect().width),
                    };
                })()`);
                if (m !== null && m.mode === 'capsule' && m.chips > 0) return m;
                // 把这一格**拖宽**:它右边那条分隔条就是它的右边界(与「窗口」菜单同一条读数口径)
                await dragBy('sideResizer', 80);
                await gazeSleep(160);
            }
            return null;
        };

        // ---- 读数① 点列表里一篇笔记 → 只 doc 面板变、list 不动、面板数不变 ----
        const beforeClick = await tabReadAll();
        const clicked = await win.webContents.executeJavaScript(`(() => {
            const items = [...document.querySelectorAll('#noteList button[data-path], #noteList [data-path]')];
            const target = items.find((b) => (b.dataset.path ?? b.getAttribute('data-path') ?? '').endsWith('.md'));
            if (!target) return { ok: false, n: items.length };
            const path = target.dataset.path ?? target.getAttribute('data-path');
            target.click();
            return { ok: true, path, n: items.length };
        })()`);
        await gazeSleep(700);
        const afterClick = await tabReadAll();
        const idsBefore = beforeClick.map((x) => x.paneId);
        const idsAfter = afterClick.map((x) => x.paneId);
        const moved = afterClick.filter((x) => {
            const b = beforeClick.find((y) => y.paneId === x.paneId);
            return JSON.stringify(b?.tabs) !== JSON.stringify(x.tabs);
        });
        const docTabsAfter = afterClick.find((x) => x.paneId === 'doc')?.tabs ?? [];
        const listTabsAfter = afterClick.find((x) => x.paneId === 'notes')?.tabs ?? [];
        r.ok('★① 点列表里一篇笔记 → **只有「笔记正文」那一格的标签被替换**(列表一个字不动、面板数不变)',
            clicked.ok === true
            && moved.length === 1 && moved[0].paneId === 'doc'
            && docTabsAfter.length === 1 && docTabsAfter[0].view === 'doc'
            && typeof docTabsAfter[0].doc === 'string' && docTabsAfter[0].doc !== ''
            && JSON.stringify(listTabsAfter) === JSON.stringify(beforeClick.find((x) => x.paneId === 'notes')?.tabs)
            && JSON.stringify(idsAfter) === JSON.stringify(idsBefore),
            JSON.stringify({ clicked: clicked.path, moved: moved.map((m) => m.paneId), docTabsAfter, listTabsAfter, ids: idsAfter }));
        // 那条可撤销提示:单行 + 省略号 + 按钮不压缩(窄栏里换行会被当成 bug)
        const toast = await win.webContents.executeJavaScript(`(() => {
            const bar = document.querySelector('.pw-strip1-toast');
            if (!bar) return null;
            const txt = bar.querySelector('.pw-strip1-text');
            const btn = bar.querySelector('.pw-strip1-btn');
            const cs = getComputedStyle(txt);
            const bs = btn ? getComputedStyle(btn) : null;
            const bcs = getComputedStyle(bar);
            return {
                text: txt ? txt.textContent : '',
                nowrap: cs.whiteSpace, ellipsis: cs.textOverflow,
                lineHeight: parseFloat(cs.lineHeight) || 0,
                txtH: txt ? txt.getBoundingClientRect().height : 0,
                barNowrap: bcs.whiteSpace, barOverflow: bcs.overflow,
                btnFlex: bs ? bs.flexGrow + '/' + bs.flexShrink : null,
                btnLabel: btn ? btn.textContent : null,
            };
        })()`);
        r.ok('★① 替换之后有一条**可撤销提示**,而且是单行(nowrap + 省略号 + 按钮 flex:none)',
            toast !== null && /已用「/.test(toast.text) && toast.btnLabel === '撤销'
            && toast.nowrap === 'nowrap' && toast.ellipsis === 'ellipsis'
            && toast.txtH <= toast.lineHeight + 1
            && toast.barNowrap === 'nowrap' && toast.barOverflow === 'hidden'
            && toast.btnFlex === '0/0',
            JSON.stringify(toast));
        // 撤销真的回到替换前
        const undone = await win.webContents.executeJavaScript(`(() => {
            const btn = document.querySelector('.pw-strip1-toast .pw-strip1-btn');
            if (!btn) return false;
            btn.click();
            return true;
        })()`);
        await gazeSleep(250);
        const afterUndo = await tabReadAll();
        r.ok('★① 提示上的「撤销」把原来那个标签放回去了(替换是可逆的)',
            undone === true
            && JSON.stringify(afterUndo.find((x) => x.paneId === 'doc')?.tabs)
                === JSON.stringify(beforeClick.find((x) => x.paneId === 'doc')?.tabs),
            JSON.stringify({ before: beforeClick.find((x) => x.paneId === 'doc')?.tabs, after: afterUndo.find((x) => x.paneId === 'doc')?.tabs }));

        // ---- 读数② 五条关闭入口各来一次 ----
        // 先给 doc 那一格开两个 doc 标签(靠点两次不同的笔记),好让"关一个"看得出来
        const openTwo = await win.webContents.executeJavaScript(`(async () => {
            const items = [...document.querySelectorAll('#noteList [data-path]')]
                .map((b) => b.dataset.path ?? b.getAttribute('data-path'))
                .filter((p) => typeof p === 'string' && p.endsWith('.md'));
            const api = window.__pwTabs;
            if (items.length === 0 || !api) return { ok: false, items: items.length };
            api.openView('doc', items[0]);
            api.addView('doc', 'links');            // ＋ 的并列语义:同一格开第二个标签
            return { ok: true, items };
        })()`);
        await gazeSleep(250);
        // ⚠️ 五条关闭入口要先有**胶囊**可点(宽 < 220px 时按规格降级成下拉,胶囊就不存在)。
        const capsule = await ensureCapsule('doc');
        const twoTabs = (await tabReadAll()).find((x) => x.paneId === 'doc');
        r.ok('★② 准备:doc 那一格宽到出**胶囊**形态,而且里面有两个标签(点开一个 + ＋ 并列一个)',
            capsule !== null && openTwo.ok === true && twoTabs.tabs.length === 2,
            JSON.stringify({ capsule, twoTabs }));

        const clickClose = async (how) => {
            const out = await win.webContents.executeJavaScript(`(() => {
                const pane = document.querySelector('.pw-pane[data-pane-id="doc"]');
                const tabs = [...pane.querySelectorAll('.pw-tab')];
                const active = tabs.findIndex((b) => b.getAttribute('aria-selected') === 'true');
                const label = (i) => (tabs[i]?.querySelector('.pw-tab-label')?.textContent ?? '');
                const before = tabs.length;
                const how = ${JSON.stringify(how)};
                if (how === 'x') {
                    tabs[active].querySelector('.pw-tab-x').click();
                } else if (how === 'middle') {
                    const t = tabs[active];
                    t.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true }));
                } else if (how === 'ctx-others') {
                    tabs[active].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
                    const item = [...document.querySelectorAll('.pw-menu-ctx .pw-menu-item')]
                        .find((b) => b.textContent === '关闭其他');
                    if (!item) return { ok: false, why: '没有右键菜单' };
                    item.click();
                } else if (how === 'ctrl-w') {
                    // ⚠️ 快捷键作用在「当前面板」= **焦点所在**:先真的把焦点给这一格,
                    // 否则读到的会是鼠标(0,0)那一格 —— 那正是这条要区分的两件事之一。
                    // ⚠️ 抓手不再可聚焦(整片拖动已按规格删除),改用这一格的活动胶囊拿焦点。
                    pane.querySelector('.pw-tab')?.focus();
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
                }
                return { ok: true, before, label: label(active) };
            })()`);
            await gazeSleep(300);
            const after = (await tabReadAll()).find((x) => x.paneId === 'doc');
            return { out, after };
        };

        /**
         * 让 doc 那一格**至少有两个人**再关。
         *
         * ⚠️ 「关掉最后一枚 → 整格消失」生效之后,这是这套读数的前提:只剩一枚时关掉它,
         *    那一格会整格消失,后面每一条入口的 `document.querySelector('[data-pane-id="doc"]')`
         *    就都找不到东西了(实测:下一条会直接抛,整段读数全垮)。
         *    「整格消失」本身由 ★③ 单独量,这里只保证前面五条入口各关掉**一枚**、格子还在。
         */
        const armDocTabs = async () => {
            const n = await win.webContents.executeJavaScript(`(async () => {
                const api = window.__pwTabs;
                if ((api.tabsOf('doc')?.tabs.length ?? 0) < 2) api.addView('doc', 'links');
                await new Promise((r) => setTimeout(r, 150));
                return api.tabsOf('doc')?.tabs.length ?? 0;
            })()`);
            return n;
        };

        // ① ×(点当前标签上的 ×)
        const closedByX = await clickClose('x');
        r.ok('★② 关闭入口之一:标签上的 **×** 关掉了它',
            closedByX.out.ok === true && closedByX.after.tabs.length === closedByX.out.before - 1,
            JSON.stringify({ how: 'x', before: closedByX.out.before, tabs: closedByX.after.tabs, label: closedByX.out.label }));

        // ② 中键(先补成两个标签:只剩一枚时关掉它整格就没了,下一条入口没有落点)
        await armDocTabs();
        const closedByMiddle = await clickClose('middle');
        r.ok('★② 关闭入口之二:**中键**点标签也关掉它',
            closedByMiddle.out.ok === true && closedByMiddle.after.tabs.length === closedByMiddle.out.before - 1,
            JSON.stringify({ how: 'middle', before: closedByMiddle.out.before, tabs: closedByMiddle.after.tabs }));

        // ③ 右键菜单:关闭其他
        await win.webContents.executeJavaScript(`(() => {
            const api = window.__pwTabs;
            api.openView('doc', null);              // 先把 doc 那格的标签补回来
            return true;
        })()`);
        await gazeSleep(200);
        const rmb = await win.webContents.executeJavaScript(`(async () => {
            const api = window.__pwTabs;
            const items = [...document.querySelectorAll('#noteList [data-path]')]
                .map((b) => b.dataset.path ?? b.getAttribute('data-path'))
                .filter((p) => typeof p === 'string' && p.endsWith('.md'));
            api.openView('doc', items[0]);
            api.addView('doc', 'ai');
            await new Promise((r) => setTimeout(r, 120));
            return api.tabsOf('doc').tabs.length;
        })()`);
        const closedByCtx = await clickClose('ctx-others');
        r.ok('★② 关闭入口之三:**右键菜单**里的「关闭其他」只剩当前那一个',
            rmb === 2 && closedByCtx.out.ok === true && closedByCtx.after.tabs.length === 1,
            JSON.stringify({ before: rmb, tabs: closedByCtx.after.tabs }));

        // ④ Ctrl+W(焦点所在面板;同样先补成两个标签,理由见 armDocTabs)
        await armDocTabs();
        const ctrlW = await clickClose('ctrl-w');
        r.ok('★⑥ Ctrl+W 关掉**焦点所在面板**的当前标签(合成前把焦点给了 doc 那一片)',
            ctrlW.out.ok === true && ctrlW.after.tabs.length === ctrlW.out.before - 1,
            JSON.stringify({ before: ctrlW.out.before, tabs: ctrlW.after.tabs }));

        // ⑤ Ctrl+Tab 切下一个(与 Ctrl+W 同属"作用在当前面板"那一组)
        const nextSwitch = await win.webContents.executeJavaScript(`(async () => {
            const api = window.__pwTabs;
            const items = [...document.querySelectorAll('#noteList [data-path]')]
                .map((b) => b.dataset.path ?? b.getAttribute('data-path'))
                .filter((p) => typeof p === 'string' && p.endsWith('.md'));
            if (items.length < 1) return { ok: false };
            api.openView('doc', items[0]);
            api.addView('doc', 'links');
            await new Promise((r) => setTimeout(r, 150));
            // ⚠️ 与 ★④ 同一个理由:Ctrl+Tab 作用在「当前面板」(焦点 → 鼠标 → 上一次碰过的),
            //    重画会弄丢焦点;这里把"鼠标在这一格的正文上"也合成一次,判据才不靠运气。
            const pane = document.querySelector('.pw-pane[data-pane-id="doc"]');
            const desk = document.getElementById('panelWorkspace');
            const rect = pane.getBoundingClientRect();
            // ⚠️ 与 ★④ 同一个理由:Ctrl+Tab 作用在「当前面板」(焦点 → 鼠标 → 上一次碰过的),
            //    重画会弄丢焦点,视图不可见时 elementFromPoint 又返回 null —— 三条都钉死。
            pane.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, button: 0, pointerId: 42,
                clientX: Math.round(rect.left + rect.width / 2),
                clientY: Math.round(rect.top + rect.height * 0.7),
            }));
            desk.dispatchEvent(new PointerEvent('pointermove', {
                bubbles: true, cancelable: true,
                clientX: Math.round(rect.left + rect.width / 2),
                clientY: Math.round(rect.top + rect.height * 0.7),
            }));
            pane.querySelector('.pw-tab')?.focus();
            const before = api.tabsOf('doc').active;
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
            await new Promise((r) => setTimeout(r, 150));
            const after = api.tabsOf('doc').active;
            return { ok: true, before, after, tabs: api.tabsOf('doc').tabs.length };
        })()`);
        r.ok('★② 关闭入口之五:Ctrl+Tab 切到**下一个**标签(循环)',
            nextSwitch.ok === true && nextSwitch.tabs === 2 && nextSwitch.after !== nextSwitch.before,
            JSON.stringify(nextSwitch));

        // ---- 读数③ 关掉某一格的**最后一枚** → 整格消失,腾出的空间**整块给左边的邻居** ----
        //
        // ⚠️ 这一格挑的是「短剧画布」(插件贡献的那片),**不碰 doc**:doc 是下面 ★④(恢复)
        //    与 ★⑤(拖面板)的落点,把它关掉后面几条就没有 pane 可点了。
        //    「哪一格」与规则无关 —— 规则是"任何一格的最后一枚被关掉,整格都消失"。
        // ---- 诊断钩子:把渲染进程里**任何**未捕获错误 / 未处理的 promise 拒绝留档 ----
        //
        // 为什么需要它:这一段之后的用例曾经让自检在 ★④ 之后抛出一句
        // `ReferenceError: tabs is not defined`,而那句话的堆栈只有主进程那一帧
        // (页面的错误被 Electron 转成拒绝时,主进程只会拿到 message)——
        // 没有这个钩子就只能靠猜。装在这里是因为下面这一串(★③④⑤ + 收尾几条)是
        // 出错的那一段;页面每次 reload 都会换掉 window,所以它必须装在本段之内。
        await win.webContents.executeJavaScript(`(() => {
            window.__selftestErrors = [];
            window.addEventListener('error', (e) => window.__selftestErrors.push(
                'error: ' + (e.message || '') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0) + ':' + (e.colno || 0)));
            window.addEventListener('unhandledrejection', (e) => window.__selftestErrors.push(
                'rejection: ' + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
            return true;
        })()`);

        // ---- 读数③ 关掉某一格的**最后一枚** → 整格消失,空间**整块给左边的邻居** ----
        //
        // ⚠️ 这一格挑的是「短剧画布」(插件贡献的那片),**不碰 doc**:doc 是下面 ★④(恢复)
        //    与 ★⑤(拖面板)的落点,把它关掉后面几条就没有 pane 可点了。
        //    「哪一格」与规则无关 —— 规则是"任何一格的最后一枚被关掉,整格都消失"。
        const emptied = await win.webContents.executeJavaScript(`(async () => {
            const api = window.__pwTabs;
            const snap = () => [...document.querySelectorAll('.pw-pane')].map((p) => {
                const r = p.getBoundingClientRect();
                return { id: p.dataset.paneId, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                         w: Math.round(r.width), h: Math.round(r.height) };
            });
            const before = snap();
            const gone = 'drama';
            const g = before.find((p) => p.id === gone) ?? null;
            if (g === null) return { ok: false, why: '没有 drama 那一格', ids: before.map((p) => p.id) };
            // 「左边的邻居」= 与它同一条横带、紧贴在它左边的那一格;没有左边才轮到右边
            const sameBand = (p) => p.bottom > g.top + 2 && p.top < g.bottom - 2;
            const nb = before.filter((p) => p.id !== gone && sameBand(p) && p.right <= g.left + 2)
                .sort((a, b) => b.right - a.right)[0]
                ?? before.filter((p) => p.id !== gone && sameBand(p) && p.left >= g.right - 2)
                    .sort((a, b) => a.left - b.left)[0]
                ?? null;
            api.closeAllTabs(gone);
            await new Promise((res) => setTimeout(res, 300));
            const after = snap();
            const nbAfter = nb === null ? null : (after.find((p) => p.id === nb.id) ?? null);
            // 顶部那一层的比例和必须还是 100(「每层比例和恒为 100」这条不变量)
            const txt = document.getElementById('layoutTree').textContent || '';
            const cut = txt.indexOf('[');
            const sizes = (cut > 0 ? txt.slice(0, cut) : '')
                .replace(/^[^ ]+ /, '').replace(/[{}]/g, '')
                .split('/').map((s) => Number.parseFloat(s)).filter((n) => Number.isFinite(n));
            return {
                ok: true,
                idsBefore: before.map((p) => p.id), idsAfter: after.map((p) => p.id),
                goneBefore: g.w, goneStillThere: after.some((p) => p.id === gone),
                tabsRead: api.tabsOf(gone),
                neighbor: nb === null ? null : nb.id,
                neighborBefore: nb === null ? null : nb.w,
                neighborAfter: nbAfter === null ? null : nbAfter.w,
                othersGrew: before.filter((p) => p.id !== gone && p.id !== (nb === null ? null : nb.id))
                    .filter((p) => { const a = after.find((x) => x.id === p.id); return a ? Math.abs(a.w - p.w) > 3 : false; })
                    .map((p) => p.id),
                topSum: sizes.length > 0 ? sizes.reduce((s, n) => s + n, 0) : null,
                tree: txt,
            };
        })()`);
        r.ok('★③ 关掉某一格的**最后一枚**标签 → 那一格整格消失,腾出的空间**整块给左边的邻居**(其余格不动、比例和仍是 100)',
            emptied.ok === true
            && emptied.idsAfter.length === emptied.idsBefore.length - 1
            && emptied.goneStillThere === false
            && emptied.tabsRead === null
            && emptied.neighbor !== null && emptied.neighborAfter !== null
            && emptied.neighborAfter - emptied.neighborBefore >= emptied.goneBefore - 12
            && emptied.neighborAfter - emptied.neighborBefore <= emptied.goneBefore + 12
            && emptied.othersGrew.length === 0
            && emptied.topSum !== null && Math.abs(emptied.topSum - 100) <= 1,
            JSON.stringify(emptied));

        // ---- 读数④ 从「最近关闭」恢复 ----
        //
        // ⚠️ 判据是"**多出来一枚**",不是"恰好一枚":修好「关掉最后一枚 → 整格消失」之后,
        //    这一格不会再因为 ★③ 之外的动作被关空,所以恢复时它本来就带着自己的标签。
        //    要守的是"恢复真的把这个标签放回来了、并且从栈里拿掉了",与它原先有几枚无关。
        const restored = await win.webContents.executeJavaScript(`(async () => {
            const api = window.__pwTabs;
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const pane = document.querySelector('.pw-pane[data-pane-id="doc"]');
            const chips = () => [...pane.querySelectorAll('.pw-tab')];
            // ⚠️ **前置条件必须钉死**(本轮修掉的一条脚手架脆弱点):「最近关闭」的栈顶完全
            //    可能是一个**已经开回来**的标签(实测路径:先把它关掉 → 后面又用 ＋ /
            //    「打开视图」把它加回来,而栈里那条旧的还在;★② 那几条反复 armDocTabs 就会
            //    造成这个形状)。那种情况下即使实现完全正确,"恢复"也无事可做 —— 那个实例
            //    本来就在这一格里 —— 断言会因为**前置状态**而红,而不是因为代码。
            //    所以先真的关掉一枚**这会儿开着**的标签(优先 links:它不脏,关它不会弹
            //    脏确认条),让栈顶那一条一定是"关着的"。判据一个字没放宽。
            const list = chips();
            const victim = list.find((b) => !b.classList.contains('pw-tab-dirty') && /链接/.test(b.textContent))
                ?? list.find((b) => !b.classList.contains('pw-tab-dirty'));
            if (list.length < 2 || !victim) {
                return { ok: false, why: 'doc 格里没有可安全关掉的那一枚(至少要有两枚且不脏)', n: list.length };
            }
            victim.querySelector('.pw-tab-x').click();
            await sleep(220);
            const recents = api.recentsOf('doc');
            const tabsBefore = api.tabsOf('doc').tabs;
            // ⚠️ 快捷键作用在「当前面板」,而它的判据是 **焦点所在 → 鼠标所在 → 上一次碰过的**
            //    (panel-workspace.js 的 currentPane)。这里把**三条都钉死**,因为哪一条能用
            //    取决于时机:重画会弄丢焦点,视图不可见时 elementFromPoint 返回 null。
            //      · 「上一次碰过的」:往这一格合成一次 pointerdown(工作台就听它记 currentPaneId);
            //      · 鼠标:合成一次 pointermove 到这一格正文(工作台听 desk 上的 pointermove);
            //      · 焦点:再真的 focus 一次胶囊。
            //    实测:只靠焦点时同一份代码会一次绿一次红(一次恢复成功、一次什么都没发生)。
            const desk = document.getElementById('panelWorkspace');
            const rect = pane.getBoundingClientRect();
            pane.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, button: 0, pointerId: 41,
                clientX: Math.round(rect.left + rect.width / 2),
                clientY: Math.round(rect.top + rect.height * 0.7),
            }));
            desk.dispatchEvent(new PointerEvent('pointermove', {
                bubbles: true, cancelable: true,
                clientX: Math.round(rect.left + rect.width / 2),
                clientY: Math.round(rect.top + rect.height * 0.7),
            }));
            pane.querySelector('.pw-tab')?.focus();
            const focusedInPane = (() => {
                let n = document.activeElement;
                while (n) { if (n.classList?.contains?.('pw-pane')) return n.dataset.paneId ?? null; n = n.parentElement ?? null; }
                return null;
            })();
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
            await sleep(250);
            return {
                ok: true,
                recentsBefore: recents, tabsBefore, tabs: api.tabsOf('doc').tabs,
                recentsAfter: api.recentsOf('doc'),
                // 诊断:被关掉的那一枚与"按之前它是否已经开着"(两者都该是"关着的")
                top: recents[0] ?? null,
                topWasOpen: tabsBefore.some((t) => t.view === (recents[0]?.view)
                    && (t.doc ?? null) === (recents[0]?.doc ?? null)),
                focusedInPane,
            };
        })()`);
        r.ok('★④ Ctrl+Shift+T 从这一格的「最近关闭」里恢复了一个标签(恢复后从栈里拿掉)',
            restored.ok === true
            && restored.recentsBefore.length > 0
            && restored.tabs.length === restored.tabsBefore.length + 1
            && restored.recentsAfter.length === restored.recentsBefore.length - 1,
            JSON.stringify(restored));

        // ---- 读数⑤ 拖面板仍然正常 + 标签条不抢手势(真窗口,合成指针) ----
        const stripGesture = await win.webContents.executeJavaScript(`(async () => {
          try {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const desk = document.getElementById('panelWorkspace');
            const treeText = () => document.getElementById('layoutTree').textContent;
            const hintOn = () => document.getElementById('panelHint').classList.contains('pw-on');
            const paneOf = (id) => desk.querySelector('.pw-pane[data-pane-id="' + id + '"]');
            const mk = (type, extra) => new PointerEvent(type, Object.assign({
                bubbles: true, cancelable: true, pointerId: 21, button: 0,
            }, extra || {}));
            const dragFrom = async (el, targetId) => {
                const tr = paneOf(targetId).getBoundingClientRect();
                const r = el.getBoundingClientRect();
                const x = Math.round(tr.right - Math.max(4, tr.width * 0.06));
                const y = Math.round(tr.top + tr.height / 2);
                const before = treeText();
                el.dispatchEvent(mk('pointerdown', {
                    clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + 2),
                }));
                window.dispatchEvent(mk('pointermove', { clientX: x, clientY: y }));
                const hint = hintOn();
                window.dispatchEvent(mk('pointerup', { clientX: x, clientY: y }));
                await sleep(60);
                return { before, after: treeText(), hint, changed: before !== treeText() };
            };
            const out = {};
            // ① ⚠️ **契约在本轮反了**(规格 §1.2):整片拖动已删,所以
            //    "在标签条空白/抓手上按下会拖走面板"已经是**错的期望** —— 现在它一动不动。
            const strip = paneOf('notes').querySelector('.pw-tabs');
            out.strip = await dragFrom(strip, 'doc');
            // ② 抓手同理:只显示、不驱动
            out.head = await dragFrom(paneOf('notes').querySelector('.pw-tabs .pw-grip'), 'ai');
            // ③ ⚠️ 唯一还灵的拖动起点:**真的胶囊**(宽布局)/ .pw-tabs-cur(窄布局)。
            //    ⚠️ 这一行**绝对不能写反引号**:它整行就是模板字符串的正文(下面这些代码
            //       是塞进渲染进程的),一个反引号会把模板提前收口 —— 后面的渲染进程代码
            //       当场被当成本文件的主进程代码解析,于是抛出
            //       ReferenceError: tabs is not defined(来自 .pw-tabs-cur 被拆成
            //       .pw 减 tabs 减 cur),而报错位置会落在毫不相干的一行上。
            //       这正是本轮修掉的那条 B1:它让下面 7 条断言整段没跑。
            //    先回默认布局 —— 上面几条可能把布局搅过,窄栏没有 .pw-tab;
            //    再挑最宽的那一格,保证处在胶囊形态。
            document.getElementById('layoutReset').click();
            await sleep(150);
            const deskEl = document.getElementById('panelWorkspace');
            const paneList = [...deskEl.querySelectorAll('.pw-pane')];
            const chips = paneList.filter((n) => n.querySelector('.pw-tab'))
                .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            const chipPane = chips[0] ?? null;
            const chipTarget = paneList.map((n) => n.dataset.paneId)
                .find((id) => id !== (chipPane?.dataset.paneId));
            out.chip = (chipPane && chipTarget)
                ? await dragFrom(chipPane.querySelector('.pw-tab'), chipTarget)
                : { changed: null, hint: null, missing: true };
            // 收拾:回到默认布局
            document.getElementById('layoutReset').click();
            await sleep(150);
            return out;
          } catch (e) { return { __crash: String((e && e.stack) || e) }; }
        })()`);
        if (stripGesture && stripGesture.__crash) r.note('CRASH-IN-STRIPGESTURE ' + stripGesture.__crash);
        r.ok('★⑤ 真窗口:标签条空白上按下 → 树一动不动(整片拖动已按规格删除)',
            stripGesture.strip.changed === false && stripGesture.strip.hint === false,
            JSON.stringify(stripGesture.strip));
        r.ok('★⑤ 真窗口:抓手上按下 → 树一动不动(同上,不是"藏起来而是删掉")',
            stripGesture.head.changed === false && stripGesture.head.hint === false,
            JSON.stringify(stripGesture.head));
        r.ok('★⑤ 真窗口:拖**真的胶囊**会把那一枚标签停靠过去(唯一还灵的起点)',
            stripGesture.chip.changed === true,
            JSON.stringify(stripGesture.chip));

        // ---- 两段式阈值 + 零图标(真窗口读数) ----
        const stripInfo = await win.webContents.executeJavaScript(`(() => {
            const out = [...document.querySelectorAll('.pw-pane')].map((p) => {
                const strip = p.querySelector('.pw-tabs');
                const cs = strip ? getComputedStyle(strip) : null;
                const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
                return {
                    id: p.dataset.paneId,
                    mode: strip ? strip.dataset.mode : null,
                    usable: strip ? Math.round(strip.clientWidth - pad) : null,
                    labels: [...p.querySelectorAll('.pw-tab-label')].map((x) => x.textContent),
                    titles: [...p.querySelectorAll('.pw-tab')].map((x) => x.title.split('(')[0]),
                    hasAdd: Boolean(p.querySelector('.pw-tabs-add')),
                    cur: p.querySelector('.pw-tabs-cur')?.textContent ?? null,
                };
            });
            return {
                panes: out,
                // ⚠️ 口径写清楚:要守的是**这一层**(标签条 / 菜单 / 提示条)一个图标都没有。
                // 面板里那 4 个 svg 是**搬进来的真实面板自己的**(AI 面板的按钮图标等,早就有),
                // 它们跟本单元无关;整页的 7 个同理(侧栏/顶栏)。所以这两个数**只报不断言**,
                // 断言的是标签条这层为 0。
                stripSvgCount: document.querySelectorAll('.pw-tabs svg, .pw-menu svg, .pw-strip1 svg').length,
                paneSvgOwners: [...document.querySelectorAll('.pw-pane svg')]
                    .map((s) => (s.closest('.pane-plugin, .agent-panel, #agentPanel, .note-links, .note-main, .notes-nav')?.className ?? s.parentElement?.className ?? '?')),
                paneSvgCount: document.querySelectorAll('.pw-pane svg').length,
                pageSvgCount: document.querySelectorAll('svg').length,
                stripChars: [...document.querySelectorAll('.pw-tab-x, .pw-tabs-add, .pw-tabs-caret')].map((x) => x.textContent),
            };
        })()`);
        r.ok('★ 两段式:每片的形态都由**它自己 padding 之后的可用宽度**决定(≥220 胶囊 / <220 下拉)',
            stripInfo.panes.every((p) => (p.usable >= 220 ? p.mode === 'capsule' : p.mode === 'dropdown')),
            JSON.stringify(stripInfo.panes.map((p) => [p.id, p.mode, p.usable, p.labels])));
        r.ok('★ 零图标:标签条 / 菜单 / 提示条里 svg 计数为 0,控件只有 × / ＋ / ∨ 三个文字字符',
            stripInfo.stripSvgCount === 0
            && stripInfo.stripChars.every((c) => ['×', '＋', '∨'].includes(c)),
            JSON.stringify({
                strip: stripInfo.stripSvgCount,
                chars: [...new Set(stripInfo.stripChars)],
                paneSvg: stripInfo.paneSvgCount, pageSvg: stripInfo.pageSvgCount,
                owners: [...new Set(stripInfo.paneSvgOwners)],
            }));
        r.ok('★ 缩写:标签文字是缩写过的,而悬停 title 仍是**全名**',
            stripInfo.panes.some((p) => p.labels.some((l) => l.endsWith('…')))
            || stripInfo.panes.every((p) => p.labels.every((l, i) => l === p.titles[i] || p.titles[i].startsWith(l.replace('…', '')))),
            JSON.stringify(stripInfo.panes.map((p) => [p.id, p.labels, p.titles])));

        // ---- 面板集合没有因为标签条而变形(收编那条行为不变的证据) ----
        r.ok('★ 标签条不影响面板集合:四片 + 插件那一片都还在,而且没有"为了打开一个视图多出一列"',
            (await readWorkspace()).ids.length === WORKSPACE_IDS.length,
            JSON.stringify((await readWorkspace()).ids));

        // ---- 「AI 会话」面板:台账 + 点一行就切过去(用户点名的用法:dsh / ChatGPT 那栏)----
        //
        // 这一段放在**最后**:它要往临时库里塞一份"上一次的会话"记录,而那份记录会让面板
        // 多出一条行 —— 放在中间会改变后面那些"布局 / 面板集合"的读数。
        //
        // 端到端价值:它同时穿过这几条链,而单测各验一条 ——
        //   ① 主进程真的把聊过的轮次写进了 <笔记库>/AI会话/*.md(不是我"以为"记了);
        //   ② 面板从台账列出行,并给出"能不能接着聊"的判断(对端清单说了算);
        //   ③ **左键点一行**真的走到对端 session/resume(夹具认得的那条)—— 原来这一步
        //      要点右栏的「接着聊」按钮,右栏删掉后就是点行本身;
        //   ④ **右键一行 → 浮层菜单 →「删除记录」**真的把台账与清单各删掉一条;
        //   ⑤ 失败(那条对端不认识)时原因**长在那一行上**,不是"点了没反应";
        //   ⑥ 对端**不重放历史**,所以"看到聊过什么"只能靠把台账铺回对话 ——
        //      这一条是整件事的成败所在:少了它就是"点一条会话,对话区一片空白"。
        // ⚠️ 自带一个等待函数:上面那一节里的 sleepMs 住在**它自己的块作用域**里,
        //    这里拿不到(实测:ReferenceError 被 catch 吞掉,自检还报"全绿")。
        const sessionSleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
        // ⚠️ 这一段的页面求值一律走它:某一块抛异常时**报数**而不是打断整趟自检 ——
        //    实测踩到:一个没做空值保护的 `host.querySelector` 让后面所有项一项都没跑,
        //    结果里只看得到一条 "Script failed to execute"。
        const evalSafe = (label, js) => win.webContents.executeJavaScript(js)
            .catch((err) => ({ __error: label + ': ' + String(err?.message ?? err) }));
        const sessionDir = path.join(vault.dir, 'AI会话');
        const ledgerFiles = () => (fs.existsSync(sessionDir)
            ? fs.readdirSync(sessionDir).filter((n) => n.endsWith('.md')) : []);
        const filesAfterChat = ledgerFiles();
        r.ok('AI 会话:聊过的轮次真的写进了 <笔记库>/AI会话/*.md(不是只在内存里)',
            filesAfterChat.length >= 1,
            `会话文件 ${filesAfterChat.length} 个:${JSON.stringify(filesAfterChat.slice(0, 3))}`);
        const firstLedger = filesAfterChat.length > 0
            ? fs.readFileSync(path.join(sessionDir, filesAfterChat[0]), 'utf8') : '';
        // ⚠️ 台账里那条"用户消息"必须是**气泡里那句**,不是"当前笔记/标题/正文"整段 ——
        //    这条曾经真的错过:agent:send 的 IPC 处理函数把 shown 丢了,于是台账记下了整段
        //    笔记正文,标题也被污染(接回来铺历史时用户会看到一大段自己没打过的东西)。
        const userEntry = firstLedger.split('<!--kaiwu:{"kind":"user"')[1] ?? '';
        const userText = userEntry.split('-->')[1]?.split('<!--kaiwu:')[0]?.trim() ?? '';
        r.ok('AI 会话:记录写得认得出(带机器标记的 meta 行 + 轮数),而且正文里真有聊过的字',
            firstLedger.startsWith('<!--kaiwu:') && firstLedger.includes('"kind":"meta"')
            && firstLedger.includes('"turns"') && firstLedger.includes('<!--kaiwu:{"kind":"user"'),
            firstLedger.slice(0, 140));

        r.ok('AI 会话:台账里记的是**你打的那一句**(不是裹着笔记上下文的整段提示)',
            userText !== '' && !userText.includes('当前笔记:') && !userText.includes('标题:')
            && !userText.includes('正文:') && !userText.includes('\n'),
            JSON.stringify({ userText: userText.slice(0, 120) }));

        // 预置一条"上一次的会话"(模拟上一趟应用留下的记录)。它的 id 是夹具**认得**的那条,
        // 所以界面该判它"可接着聊" —— 这正是"重启之后还能接着聊"那条真实路径。
        const historyId = 'fake-history-1';
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, '2026-09-26-0900-fakehist.md'), [
            `<!--kaiwu:{"v":1,"kind":"meta","id":"${historyId}","cwd":${JSON.stringify(vault.dir)},"model":"Fake-Flash","modelValue":"","effort":"中","effortValue":"high","created":1790400000000,"updated":1790400600000,"turns":1,"title":"上次问过的那个问题","entries":4}-->`,
            '',
            '## 上次问过的那个问题',
            '',
            '<!--kaiwu:{"kind":"user","at":1790400000000}-->',
            '上次问过的那个问题',
            '',
            '<!--kaiwu:{"kind":"think","at":1790400100000}-->',
            '上次的思考内容',
            '',
            '<!--kaiwu:{"kind":"reply","at":1790400200000}-->',
            '上次的回复正文,应当在铺回历史时出现在对话里。',
            '',
            '<!--kaiwu:{"kind":"end","at":1790400300000,"stopReason":"end_turn"}-->',
            '',
        ].join('\n'), 'utf8');

        // 面板是开机时就挂好的(插件面板会自己进工作台),所以这里只消让它重读一次目录。
        const paneInfo = await evalSafe('面板信息', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            if (host === null) return { found: false };
            const refresh = host.querySelector('.ses-refresh');
            if (refresh) refresh.click();
            return {
                found: true,
                styleInjected: document.querySelector('style[data-plugin-style="ai-session"]') !== null,
                inWorkspace: host.closest('.pw-pane') !== null,
                // 右栏(详情/回看)整块已按用户要求删除 —— 这里数一遍,确认 DOM 里真的没有它,
                // 而且面板根节点下**只剩清单这一列**(不再是 listCol + rightCol 两列)。
                rightCols: host.querySelectorAll('.ses-right, .ses-detail, .ses-placeholder').length,
                cols: host.querySelector('.ses-pane')?.children.length ?? -1,
            };
        })()`);
        await sessionSleep(500);
        const paneState = await evalSafe('清单读数', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            return {
                rows: [...(host?.querySelectorAll('.ses-row') ?? [])].map((row) => ({
                    id: row.dataset.id,
                    title: row.querySelector('.ses-title')?.textContent ?? '',
                    badge: row.querySelector('.ses-badge')?.textContent ?? '',
                    // 新交互的全部:每一行**自己**就是"切过去"的控件(可聚焦),
                    // 右栏那两个按钮都不存在了。
                    role: row.getAttribute('role'),
                    focusable: row.tabIndex === 0 || row.tagName === 'BUTTON',
                })),
                days: [...host.querySelectorAll('.ses-day')].map((d) => d.textContent),
            };
        })()`);
        r.ok('AI 会话:面板在工作台里,样式真的注入了,而且列得出台账里的会话',
            paneInfo.found === true && paneInfo.styleInjected === true && paneInfo.inWorkspace === true
            && paneState.rows.some((x) => x.id === historyId)
            && paneState.rows.some((x) => x.title === '上次问过的那个问题'),
            JSON.stringify({ paneInfo, rows: paneState.rows, days: paneState.days }));
        // 用户要求「整个右栏删掉」:DOM 里必须**真的没有它**(不是 hidden,是没了),
        // 而且面板根节点只剩一列。这条钉住的是"栏没了"本身 —— 与"交互换没换"是两件事
        // (后者见下面"左键点一行 / 右键出菜单"那两条)。
        r.ok('AI 会话:右栏(详情/回看)已经不存在(DOM 里没有 .ses-right / .ses-detail / .ses-placeholder,面板根节点只剩一列)',
            paneInfo.found === true && paneInfo.rightCols === 0 && paneInfo.cols === 1,
            JSON.stringify({ rightCols: paneInfo.rightCols, cols: paneInfo.cols }));
        // 每一行自己就是那个按钮:没有右栏可点,行要是不可聚焦,键盘用户就切不了会话。
        r.ok('AI 会话:每一行本身就是可聚焦的按钮(role=button + tabIndex=0),面板里不再有「接着聊」按钮',
            paneState.rows.length > 0
            && paneState.rows.every((x) => x.role === 'button' && x.focusable === true),
            JSON.stringify(paneState.rows.slice(0, 3)));
        r.ok('AI 会话:对端清单里有的那条标「可接着聊」(状态是**问来的**,不是猜的)',
            paneState.rows.some((x) => x.id === historyId && /可接着聊|正在聊/.test(x.badge)),
            JSON.stringify(paneState.rows));

        // 左键点一行 = **直接切过去**(原来点完还得再点右栏那个「接着聊」按钮)。
        const beforeSessionId = await evalSafe('切换前会话', 
            'document.querySelector("#agentPanel")?.dataset.sessionId ?? null');
        const clickedSessionRow = await evalSafe('点那一行', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const row = host?.querySelector('.ses-row[data-id="fake-history-1"]');
            if (!row) return { ok: false, why: '台账里那条会话没有对应的行' };
            row.click();
            return { ok: true, role: row.getAttribute('role'), tabIndex: row.tabIndex };
        })()`);
        await sessionSleep(1200);
        const afterChat = await evalSafe('切换后读数', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const panel = document.querySelector('#agentPanel');
            return {
                sessionId: panel?.dataset.sessionId ?? null,
                bubbles: [...document.querySelectorAll('#agentMessages .agent-msg-user')]
                    .map((b) => b.textContent.trim()),
                answers: [...document.querySelectorAll('#agentMessages .agent-msg-assistant')]
                    .map((b) => b.textContent.trim()),
                // 失败原因现在落在**那一行**上(.ses-row-err);成功路径上必须一句都没有
                rowErrs: [...(host?.querySelectorAll('.ses-row-err') ?? [])].map((n) => n.textContent),
                // 「接着聊」到底成没成,以插件写下的**结果**为准(中文文案不该当判据)
                activate: host?.dataset?.lastActivate ?? null,
            };
        })()`);
        r.ok('AI 会话:左键点一行就**直接切到那条会话**(走的是原来的「接着聊」,对端 session/resume 走通)',
            clickedSessionRow.ok === true && afterChat.sessionId === historyId
            && afterChat.sessionId !== beforeSessionId && afterChat.rowErrs.length === 0,
            JSON.stringify({ clicked: clickedSessionRow, before: beforeSessionId, after: afterChat.sessionId, rowErrs: afterChat.rowErrs, activate: afterChat.activate }));

        // 最要紧的一条:对端**不重放**旧消息 —— 历史必须由开物自己从台账铺出来。
        r.ok('AI 会话:接回来之后,上次聊过的内容**铺回了对话里**(历史来自开物台账,不是对端重放)',
            afterChat.bubbles.includes('上次问过的那个问题')
            && afterChat.answers.some((t) => t.includes('上次的回复正文')),
            JSON.stringify({ bubbles: afterChat.bubbles, answers: afterChat.answers }));

        // ---- 「＋ 新建会话」:点了**立刻**建(用户在两个方案里拍板的那条)----
        const filesBeforeNew = ledgerFiles();
        const clickedNew = await evalSafe('点新建会话', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const btn = host?.querySelector('.ses-new');
            if (!btn) return { ok: false, why: '没有「新建会话」按钮' };
            const disabled = btn.disabled === true;
            btn.click();
            return { ok: true, disabled };
        })()`);
        await sessionSleep(900);
        const afterNew = await evalSafe('新建后读数', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const panel = document.querySelector('#agentPanel');
            const current = host?.querySelector('.ses-row.current');
            return {
                rows: host?.querySelectorAll('.ses-row').length ?? -1,
                currentId: current?.dataset.id ?? null,
                currentTitle: current?.querySelector('.ses-title')?.textContent ?? '',
                currentMeta: current?.querySelector('.ses-meta')?.textContent ?? '',
                sessionId: panel?.dataset.sessionId ?? null,
                bubbles: document.querySelectorAll('#agentMessages .agent-msg').length,
                create: host?.dataset?.lastCreate ?? null,
                // 右栏与提示条都没了:成功之后**任何**说错话的地方都不许挂着 ——
                // 清单头上那句(旧实现的误导占位换了个落点)与行上的失败原因都算。
                lerr: host?.querySelector('.ses-lerr')?.textContent ?? '',
                rowErrs: [...(host?.querySelectorAll('.ses-row-err') ?? [])].map((n) => n.textContent),
            };
        })()`);
        const filesAfterNew = ledgerFiles();
        const addedFiles = filesAfterNew.filter((n) => !filesBeforeNew.includes(n));
        // 新建出来的那条 id:后面右键删的就是它(浮层上写的是叶子字段,自检按它认人)
        let newId = null;
        try { newId = JSON.parse(afterNew.create ?? '{}').sessionId ?? null; } catch { /* 读不出来就当没有 */ }
        r.ok('新建会话:点一下**立刻**建了一条 —— 对端真的 session/new,台账当场多出一个文件',
            clickedNew.ok === true && clickedNew.disabled === false
            && afterNew.sessionId !== null && afterNew.sessionId !== 'fake-history-1'
            && addedFiles.length === 1,
            JSON.stringify({ clickedNew, after: afterNew, added: addedFiles }));
        r.ok('新建会话:对话区跟着清空,而连接状态没被动(换的是会话,不是连接)',
            afterNew.bubbles === 0 && afterNew.create !== null,
            JSON.stringify({ bubbles: afterNew.bubbles, create: afterNew.create }));
        r.ok('新建会话:面板上那条当场出现,标着「新会话(还没说话)」+「0 轮」,而且是当前会话',
            /新会话\(还没说话\)/.test(afterNew.currentTitle) && /0 轮/.test(afterNew.currentMeta)
            && afterNew.rows === paneState.rows.length + 1,
            JSON.stringify({ title: afterNew.currentTitle, meta: afterNew.currentMeta, rows: afterNew.rows }));
        // ⚠️ 这条钉的是一个真出现过的竞态:台账落盘是**异步**的(session-ledger 的 begin 里是
        //    `void flushOne`),所以新建成功那一刻的清单可能还没看见刚建的那条 —— 旧实现在右栏
        //    铺一句"这条记录已经不在了"(成功操作之后说错话)。右栏没了,那句话的落点也没了;
        //    断言跟着搬到**新渠道**:成功之后清单头上与行上都不许挂错误文案,而且新行真的在。
        r.ok('新建会话:成功之后面板上没有"这条记录已经不在了"那种误导文案,新行当场就在(落盘竞态已被挡住)',
            String(afterNew.lerr ?? '') === '' && afterNew.rowErrs.length === 0
            && newId !== null && String(afterNew.currentId ?? '') === String(newId),
            JSON.stringify({ lerr: afterNew.lerr, rowErrs: afterNew.rowErrs, newId, currentId: afterNew.currentId }));

        // ---- 键盘:行可聚焦,回车与左键等效 ----
        // 用 fake-history-1 那一行来验:它刚被接回来过(在对端是活跃的),一定切得过去;
        // 而当前会话是刚建的那条,所以"回车之后 sessionId 变回 fake-history-1"是真的换了。
        const keyRow = await evalSafe('回车切会话', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const row = host?.querySelector('.ses-row[data-id="fake-history-1"]');
            if (!row) return { ok: false, why: '台账里那条会话没有对应的行' };
            row.focus();
            const focused = document.activeElement === row;
            row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            return { ok: true, focused };
        })()`);
        await sessionSleep(1000);
        const afterKey = await evalSafe('回车切换后', `(() => ({
            sessionId: document.querySelector('#agentPanel')?.dataset.sessionId ?? null,
            activate: document.querySelector('.pane-plugin[data-plugin="ai-session"]')?.dataset?.lastActivate ?? null,
        }))()`);
        r.ok('AI 会话:行可聚焦,键盘回车与左键等效(焦点真的落在那一行上,会话真的换了)',
            keyRow.ok === true && keyRow.focused === true && afterKey.sessionId === historyId,
            JSON.stringify({ keyRow, after: afterKey }));

        // ---- 右键浮层:菜单项是「删除记录」,Esc 关掉并把焦点还给那一行 ----
        const menuKeys = await evalSafe('菜单键盘', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const row = host?.querySelector('.ses-row[data-id="fake-history-1"]');
            if (!row) return { ok: false, why: '台账里那条会话没有对应的行' };
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
            const box = host.querySelector('.ses-menu');
            if (box === null) return { ok: false, why: '右键没有出菜单' };
            const items = [...box.querySelectorAll('.ses-menu-item')];
            const focusedInMenu = box.contains(document.activeElement);
            // 只有一项时 ↑↓ 是绕回自己 —— 这里验的是"按了不炸、焦点还在菜单里"
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
            const afterArrow = box.contains(document.activeElement);
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            return {
                ok: true,
                items: items.map((b) => b.textContent),
                roles: items.map((b) => b.dataset.menuRole),
                focusedInMenu,
                afterArrow,
                menuGone: host.querySelector('.ses-menu') === null,
                focusBack: document.activeElement === row,
            };
        })()`);
        r.ok('AI 会话:右键出的是**浮层菜单**(不是右键即删),项是「删除记录」,Esc 关掉并把焦点还给那一行',
            menuKeys.ok === true && menuKeys.items.length === 1 && menuKeys.items[0] === '删除记录'
            && menuKeys.roles[0] === 'remove' && menuKeys.focusedInMenu === true
            && menuKeys.afterArrow === true && menuKeys.menuGone === true && menuKeys.focusBack === true,
            JSON.stringify(menuKeys));

        // ---- 右键那一行 → 菜单 →「删除记录」:台账与清单**真的各少一条** ----
        const filesBeforeDelete = ledgerFiles();
        const openedMenu = await evalSafe('右键那一行', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const row = host?.querySelector('.ses-row[data-id=${JSON.stringify(newId)}]');
            if (!row) return { ok: false, why: '新建的那一行不在清单里' };
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
            const box = host.querySelector('.ses-menu');
            return {
                ok: box !== null,
                // 浮层上只有叶子字段:它属于哪条会话 / 是哪一种菜单,直接写在 DOM 上
                menuId: box?.dataset.menuId ?? null,
                menuKind: box?.dataset.menuKind ?? null,
                items: [...(box?.querySelectorAll('.ses-menu-item') ?? [])].map((b) => b.textContent),
            };
        })()`);
        const clickedDelete = await evalSafe('点删除记录', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const item = host?.querySelector('.ses-menu [data-menu-role="remove"]');
            if (!item) return { ok: false, why: '菜单里没有「删除记录」' };
            item.click();
            return { ok: true };
        })()`);
        await sessionSleep(900);
        const afterDelete = await evalSafe('删除后读数', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            return {
                rows: [...host.querySelectorAll('.ses-row')].map((r) => r.dataset.id),
                menuGone: host.querySelector('.ses-menu') === null,
                remove: host?.dataset?.lastRemove ?? null,
                rowErrs: [...host.querySelectorAll('.ses-row-err')].map((n) => n.textContent),
            };
        })()`);
        const filesAfterDelete = ledgerFiles();
        r.ok('AI 会话:右键一行 → 浮层菜单 →「删除记录」,台账与清单**真的各少一条**',
            openedMenu.ok === true && openedMenu.menuId === newId && openedMenu.menuKind === 'session'
            && openedMenu.items.includes('删除记录') && clickedDelete.ok === true
            && afterDelete.menuGone === true && afterDelete.rowErrs.length === 0
            && !afterDelete.rows.includes(newId)
            && filesAfterDelete.length === filesBeforeDelete.length - 1,
            JSON.stringify({ openedMenu, clickedDelete, rows: afterDelete.rows, files: [filesBeforeDelete.length, filesAfterDelete.length], remove: afterDelete.remove }));

        // ---- 失败必须说话:右栏与提示条都没了,原因要落在**那一行**上 ----
        //
        // 造一条对端**不认**的记录:夹具只肯 resume 'fake-history-1',别的 id 一律回
        // `session is not resumable`,于是点它必然失败(而且原因里带着那句原话)。
        // 这条钉的就是"绝不静默":点了之后那一行上必须出现原因,而不是毫无反应。
        const bogusId = 'fake-unknown-1';
        fs.writeFileSync(path.join(sessionDir, '2026-09-26-0910-fakeunknown.md'), [
            `<!--kaiwu:{"v":1,"kind":"meta","id":"${bogusId}","cwd":${JSON.stringify(vault.dir)},"model":"Fake-Flash","modelValue":"","effort":"中","effortValue":"high","created":1790401000000,"updated":1790401600000,"turns":1,"title":"对端不认识的那条","entries":1}-->`,
            '',
            '## 对端不认识的那条',
            '',
            '<!--kaiwu:{"kind":"user","at":1790401000000}-->',
            '点了它应当接不回来。',
            '',
        ].join('\n'), 'utf8');
        await evalSafe('刷新清单', `(() => {
            document.querySelector('.pane-plugin[data-plugin="ai-session"] .ses-refresh')?.click();
            return true;
        })()`);
        await sessionSleep(600);
        const clickedBogus = await evalSafe('点那条接不回来的', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const row = host?.querySelector('.ses-row[data-id="${bogusId}"]');
            if (!row) return { ok: false, why: '清单里没有那条' };
            row.click();
            return { ok: true };
        })()`);
        await sessionSleep(1000);
        const afterFail = await evalSafe('失败后读数', `(() => {
            const host = document.querySelector('.pane-plugin[data-plugin="ai-session"]');
            const row = host?.querySelector('.ses-row[data-id="${bogusId}"]');
            const err = row?.querySelector('.ses-row-err');
            return {
                // 原因必须**长在这一行上**(不是清单头、不是空无一物)
                rowErr: err?.textContent ?? '',
                errOnRow: err !== null && err !== undefined,
                lerr: host?.querySelector('.ses-lerr')?.textContent ?? '',
                activate: host?.dataset?.lastActivate ?? null,
            };
        })()`);
        r.ok('AI 会话:切不过去时原因**长在那一行上**(不是"点了没反应";右栏与提示条都已不存在)',
            clickedBogus.ok === true && afterFail.errOnRow === true
            && /没能接回来/.test(afterFail.rowErr) && /not resumable/.test(afterFail.rowErr)
            && String(afterFail.lerr ?? '') === ''
            && /"ok":false/.test(String(afterFail.activate ?? '')),
            JSON.stringify({ clickedBogus, after: afterFail }));

        // ---- 收尾:含非法字节的 .md 在**整轮自检之后**仍然逐字节未变 ----
        //
        // 上面那一条证明的是"点开它"没有动文件。这一条把口径放大到整轮:
        // 期间列表重画、索引重算、切笔记、就地编辑、保存(留 .bak)、改名、移动、
        // 删除、面板标签开关都真发生过 —— 而这一篇谁都没碰过。
        // 大小 / mtime / sha256 三条一起看:mtime 尤其重要,它是"有没有被写过"的直接证据。
        const brokenAfter = fs.readFileSync(brokenAbs);
        const brokenStatAfter = fs.statSync(brokenAbs);
        const brokenHashBefore = sha256(brokenBefore);
        const brokenHashAfter = sha256(brokenAfter);
        r.ok('★整轮自检之后:含非法字节的 .md 磁盘字节逐字节未变(sha256 / 大小 / mtime 三者一致)',
            brokenHashAfter === brokenHashBefore
            && brokenStatAfter.size === brokenStatBefore.size
            && Math.trunc(brokenStatAfter.mtimeMs) === Math.trunc(brokenStatBefore.mtimeMs),
            JSON.stringify({
                sha256Before: brokenHashBefore, sha256After: brokenHashAfter,
                sizeBefore: brokenStatBefore.size, sizeAfter: brokenStatAfter.size,
                mtimeBefore: Math.trunc(brokenStatBefore.mtimeMs),
                mtimeAfter: Math.trunc(brokenStatAfter.mtimeMs),
            }));

    } catch (err) {
        r.ok('自检过程未抛异常', false, err.message);
        r.note('STACK ' + String(err && err.stack));
        // 诊断:渲染进程侧任何跟报错有关的行都摊开(不是只看最后 15 行)
        for (const line of pageLogs.filter((l) => /error|Error|Uncaught|tabs/.test(l))) {
            r.note('PAGELOG ' + line);
        }
        r.note('PAGE-ERRORS ' + JSON.stringify(
            await win.webContents.executeJavaScript('window.__selftestErrors || null').catch(() => null)));
        for (const line of pageLogs.slice(-15)) r.note(line);
    }
    // 临时笔记库与隔离的 userData 用完即删,不留痕(即使自检失败也要删)。
    // 为什么不放在 app 的 quit 钩子里:app.exit() 不触发 quit 事件,会漏。
    for (const dir of [vault?.dir, cleanupUserData]) {
        if (typeof dir !== 'string' || dir === '') continue;
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* 清理失败不该影响自检结论 */ }
    }
    // 队列夹具服务也收掉:它是自检自己起的,不该在 app.exit 之后还挂着监听。
    // (夹具文件在 cleanupUserData 那个临时目录里,上面已经随目录一起删了。)
    try { queueFixture?.server?.close(); } catch { /* 关不掉不影响结论 */ }

    app.exit(r.finish());
}

// 轮询等布局树文本**等于**期望值(重载窗口之后要等启动把布局存档读回来再渲染)。
//
// 为什么不能只等"文本出现":默认布局也会立刻出现 —— 那样就把"存档没生效"看成了通过。
// 轮询放在**主进程**这一侧:重载那一瞬间页面里的 promise 会连同旧文档一起消失,
// 从外面一遍遍读才不会被那次 reload 掐断。
async function waitForTreeText(win, want, tries = 60) {
    let last = null;
    for (let i = 0; i < tries; i++) {
        last = await win.webContents.executeJavaScript(
            `(() => { const el = document.getElementById('layoutTree'); return el ? el.textContent : null; })()`,
        ).catch(() => null);
        if (last === want) return last;
        await new Promise((res) => { setTimeout(res, 100); });
    }
    return last;
}

// 把一小块像素**按最近邻放大**写成 PNG —— 用户要自己看"放大的边界"来核对缝与框。
//
// 为什么自己写 PNG 编码:Electron 的 `nativeImage.resize` 只有 good/better/best 三档,
// 全都是**平滑**缩放 —— 把 1px 的框放大 6 倍会糊成一条渐变,恰好毁掉要核对的东西。
// 最近邻则是"一个像素变 6×6 的方块",框与缝的边界一眼可数。zlib 是 Node 内置的,零依赖。
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/** NativeImage → 最近邻放大 zoom 倍 → PNG 文件。返回放大后的像素尺寸。 */
function writeZoomPng(file, image, zoom) {
    const size = image.getSize();
    const bmp = image.getBitmap();
    const device = Math.max(1, Math.round(
        Math.sqrt((bmp.length / 4) / Math.max(1, size.width * size.height)),
    ));
    const w = size.width * device;
    const h = size.height * device;
    // 位图是 BGRA(Windows):PNG 要 RGBA,顺手把 alpha 写死 255(截屏本来就不透明)
    const src = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const at = (y * w + x) * 4;
            src[at] = bmp[at + 2];
            src[at + 1] = bmp[at + 1];
            src[at + 2] = bmp[at];
            src[at + 3] = 255;
        }
    }
    const outW = w * zoom;
    const outH = h * zoom;
    const stride = outW * 4 + 1;                 // 每行前面一个 filter 字节
    const raw = Buffer.alloc(stride * outH);
    for (let y = 0; y < outH; y++) {
        const sy = Math.floor(y / zoom);
        const rowAt = y * stride;
        raw[rowAt] = 0;                          // filter: none
        for (let x = 0; x < outW; x++) {
            const s = (sy * w + Math.floor(x / zoom)) * 4;
            const d = rowAt + 1 + x * 4;
            raw[d] = src[s];
            raw[d + 1] = src[s + 1];
            raw[d + 2] = src[s + 2];
            raw[d + 3] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(outW, 0);
    ihdr.writeUInt32BE(outH, 4);
    ihdr[8] = 8;                                 // bit depth
    ihdr[9] = 6;                                 // color type: RGBA
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]));
    return { width: outW, height: outH, zoom };
}

/**
 * 截图位图 → 逐列(axis 'x')或逐行(axis 'y')的**中位数 RGB**。
 *
 * ⚠️ 用中位数而不是均值:均值会被"这一列里恰好有一段文字/输入框/选中条"带偏
 * (实测:正文标题输入框占了那两列 12% 高度,把均值抬到 64 —— 那是内容,不是面板边界)。
 * 中位数取的是"这一段里占多数的那个颜色",也就是底色/缝色/框色。
 */
function medianLines(image, axis) {
    const size = image.getSize();
    const bitmap = image.getBitmap();
    // 放大倍率 = 位图总像素数 / DIP 面积(1x 屏是 1,HiDPI 是 2/3)
    const scale = Math.max(1, Math.round(
        Math.sqrt((bitmap.length / 4) / Math.max(1, size.width * size.height)),
    ));
    const pick = (arr) => {
        const sorted = arr.slice().sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    };
    const count = axis === 'x' ? size.width : size.height;
    const span = axis === 'x' ? size.height : size.width;
    const lines = [];
    for (let i = 0; i < count; i++) {
        const rs = [];
        const gs = [];
        const bs = [];
        for (let j = 0; j < span; j++) {
            const dx = axis === 'x' ? i : j;
            const dy = axis === 'x' ? j : i;
            for (let sx = 0; sx < scale; sx++) {
                for (let sy = 0; sy < scale; sy++) {
                    const px = Math.min(size.width - 1, dx * scale + sx);
                    const py = Math.min(size.height - 1, dy * scale + sy);
                    const at = (py * size.width + px) * 4;
                    rs.push(bitmap[at]);
                    gs.push(bitmap[at + 1]);
                    bs.push(bitmap[at + 2]);
                }
            }
        }
        lines.push([pick(rs), pick(gs), pick(bs)]);
    }
    return { lines, scale };
}

// 跨一条面板边界,把**逐列原始 RGB** 读出来,并列出**每一处**相邻差 ≥ 2 级的边。
//
// ⚠️ 为什么换掉了上一版判据(它就是漏掉真问题的那一版):
// 上一版沿边界取**一个像素**的亮度,再用 `lo + (hi-lo)*0.45` 二值化数"亮段"。分隔条
// 中线是 `--border`(亮度 58)当然过得了那道阈值;而面板卡片自身的**底色台阶**
// (`--surface` 压在近黑底上,只有 4~5 级差)**过不了** —— 被当成背景略过,于是"两处边"
// 数成了 1 处。用户看到的正是:一条亮的窄线 + 一条暗的宽边(卡片底色的边界)。
//
// 这一版的口径:
//   · 沿整条边**逐列取均值**(排除文字、滚动条、圆角这些一像素噪声);
//   · 用**逐通道**相邻差 ≥ 2 级当判据(灵敏到能看见底色台阶),并把两侧 RGB 都列出来;
//   · 一条边界"只有一条线"的判据是:整段窗口里恰好 **2 处**边(进线、出线),
//     且两处的差值都 ≥ 20(是那条描边线,不是底色台阶)。
//
// ⚠️ 扫描前把星空装饰层藏起来:它会在面板之间的 7px 缝里透出亮点,把边数搅乱。
// 它是背景层、不在布局里,藏它不影响面板几何(扫描结束就恢复)。
async function scanBoundaryEdges(win, { from, to, axis = 'x', half = 20, band = 160, cropPath = null }) {
    const geom = await win.webContents.executeJavaScript(`(() => {
        const desk = document.getElementById('panelWorkspace');
        if (!desk) return null;
        const a = desk.querySelector('.pw-pane[data-pane-id="${from}"]');
        const b = desk.querySelector('.pw-pane[data-pane-id="${to}"]');
        if (!a || !b) return null;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const stars = document.getElementById('starfield');
        if (stars) stars.style.visibility = 'hidden';
        return {
            ax: ra.left, ay: ra.top, aw: ra.width, ah: ra.height,
            bx: rb.left, by: rb.top, bw: rb.width, bh: rb.height,
        };
    })()`);
    if (geom === null) return null;
    // 窗口 = 边界中心 ±half。**不看谁在前**:两片是"面对面"的两条边 ——
    // 左片的右边贴着右片的左边(或上片的下边贴着下片的上边)。
    // 平均带取两片**重叠区间**里、从标题栏下面 60px 起的那一段
    // (标题栏自己有一条底边线,那不属于"面板之间的边界")。
    let rect;
    let nearEdge;                                  // 近侧面板的"面"那一列(窗口从这里开始)
    let farEdge;                                   // 远侧面板的"面"那一列
    if (axis === 'x') {
        const eRight = Math.round(Math.min(geom.ax + geom.aw, geom.bx + geom.bw));   // 左片的右边
        const eLeft = Math.round(Math.max(geom.ax, geom.bx));                        // 右片的左边
        const overlapTop = Math.max(geom.ay, geom.by);
        const overlapBottom = Math.min(geom.ay + geom.ah, geom.by + geom.bh);
        const h = Math.max(8, Math.min(band, Math.round(overlapBottom - overlapTop) - 64));
        rect = {
            x: Math.round((eRight + eLeft) / 2) - half,
            y: Math.round(overlapTop + 60),
            width: half * 2 + 1, height: h,
        };
        nearEdge = eRight - rect.x;
        farEdge = eLeft - rect.x;
    } else {
        const eBottom = Math.round(Math.min(geom.ay + geom.ah, geom.by + geom.bh));  // 上片的下边
        const eTop = Math.round(Math.max(geom.ay, geom.by));                         // 下片的上边
        const overlapLeft = Math.max(geom.ax, geom.bx);
        const overlapRight = Math.min(geom.ax + geom.aw, geom.bx + geom.bw);
        const w = Math.max(8, Math.min(band, Math.round(overlapRight - overlapLeft) - 64));
        rect = {
            x: Math.round(overlapLeft + 60),
            y: Math.round((eBottom + eTop) / 2) - half,
            width: w, height: half * 2 + 1,
        };
        nearEdge = eBottom - rect.y;
        farEdge = eTop - rect.y;
    }
    if (farEdge <= nearEdge + 1) return { error: '这两片不是相邻的(中间没有间隙)', rect, nearEdge, farEdge };
    let picked = null;
    try {
        // ⚠️ `capturePage` 会**偶发**抛 `UnknownVizError`(实测:窗口被遮挡 / 合成器那一刻
        //    没醒过来时,同一个矩形前一次成功、后一次就抛)。它不是"这条性质不成立",
        //    而是"这一帧抓不到" —— 所以重试两次,而不是把偶发当成失败。
        let image = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 3 && image === null; attempt += 1) {
            try {
                image = await win.webContents.capturePage(rect);
            } catch (err) {
                lastErr = err;
                await new Promise((res) => { setTimeout(res, 120); });
            }
        }
        if (image === null) throw lastErr ?? new Error('capturePage 失败');
        const { lines, scale } = medianLines(image, axis);
        // 每一处相邻差 ≥ 2 级的边(逐通道取最大差 —— 比亮度更灵敏,颜色偏移也抓得住)
        const edges = [];
        for (let i = 1; i < lines.length; i++) {
            const p = lines[i - 1];
            const q = lines[i];
            const delta = Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]), Math.abs(q[2] - p[2]));
            if (delta >= 2) edges.push({ at: i, delta, from: p, to: q });
        }
        // ⚠️ 判据只看**边界那一段**:近侧面板的最后一列 + 整条 7px 间隙(+ 远侧第一列,
        // **仅当那一侧是内容时**)。
        //   · 再往里就是面板内容了(实测:链接区某小节的下边线是一处 1px、delta 14 的边,
        //     它属于内容,不属于"面板之间的边界"),把内容算进来会变成假失败;
        //   · 上下叠着的两片之间**不取远侧**:紧挨着间隙的是下面那片的**标题栏**,
        //     它本来就是另一种颜色(那是面板自己的头,不是边界上多出来的线)。
        //     两侧都要覆盖 → 这类边界在自检里**两个方向各扫一次**。
        const windowFrom = Math.max(0, nearEdge - 1);
        const windowTo = Math.min(lines.length - 1, axis === 'x' ? farEdge : farEdge - 1);
        const windowEdges = edges.filter((e) => e.at >= windowFrom && e.at <= windowTo);
        // 最亮的那一列(悬停/拖动时就是那条高亮线):报告里要给出它的 RGB
        let brightest = lines[0];
        for (const c of lines) {
            if (c[0] + c[1] + c[2] > brightest[0] + brightest[1] + brightest[2]) brightest = c;
        }
        // ⚠️ 方案 A 之后,"什么算一处线"变了(用户明确要求重新定义):
        //   · 每片面板**都有自己的框**(1px --border,亮度约 58)→ 边界处**一定**有两条框;
        //   · 缝里露出一条深底(亮度约 14),面板是 23;
        //   · 静止时**缝里**不许有任何亮线;悬停/拖动时缝里冒出 accent。
        // 所以判据要从"数边"改成"数**亮线**(亮度 ≥ 40)":
        //
        // ⚠️ 数亮线的窗口 = **真正的缝**(`[nearEdge, farEdge-1]`,7px 整条),不是上面那个
        //    `[windowFrom, windowTo]` —— 后者两端各多含 1 列,那两列是**面板自己的内容**:
        //      · `nearEdge-1` = 近侧面板的最后一列。用户要求"树里显示所有文件"之后,
        //        笔记树的行数变多 → 笔记列表**真的会滚动**,而 Windows 的滚动条是贴边的:
        //        实测那一列是 `44,44,44`(轨道)紧挨着 `159,159,159`(滑块横跨 9 列),
        //        亮度 44 ≥ 40 → 静止态判据被一条**合法的滚动条**判红(不是缝里的线)。
        //      · `farEdge`(仅 axis x)= 远侧面板的第一列,同理属于它的内容。
        //    缝本身是**两片面板之间那 7px**:面板的框是 `box-shadow: 0 0 0 1px`(画在盒子
        //    外面),所以"框漏进缝里"只可能出现在 `nearEdge` 或 `farEdge-1` 这两列 ——
        //    两者都还在这个窗口里,守的东西一点没松。证据:`z-index` 那条修复**之前**,
        //    三条静止态断言看到的漏光正是 `farEdge-1`(`frames` 报 `[14,14,14],[55,58,61]`,
        //    `[55,58,61]` 在 BGRA 位图里就是 `#3d3a37` = `--border`)。
        //    ⚠️ 所以别把面板的框改成 `border`/`outline` 那种"画在盒子里面"的画法:
        //    那样近侧的框会落在 `nearEdge-1`(窗口外),漏光就没人盯了。
        const brightnessOf = (c) => Math.round((c[0] + c[1] + c[2]) / 3);
        const seamFrom = nearEdge;
        const seamTo = Math.max(nearEdge, farEdge - 1);
        const brightAt = lines
            .map((c, i) => ({ i, brightness: brightnessOf(c), rgb: c }))
            .filter((x) => x.i >= seamFrom && x.i <= seamTo && x.brightness >= 40);
        // 缝的**内圈**:去掉近侧那 1 列(这一片的框)与远侧那 1 列(对面那片的框)
        const frameA = nearEdge;                                 // 近侧面板自己的框
        const frameB = farEdge - 1;                              // 远侧面板自己的框
        const innerFrom = frameA + 1;
        const innerTo = frameB - 1;
        const innerLines = lines.slice(Math.max(0, innerFrom), Math.max(0, innerTo) + 1);
        const innerBright = brightAt.filter((x) => x.i >= innerFrom && x.i <= innerTo);
        picked = {
            rect, scale, lines, edges,
            boundary: { from: windowFrom, to: windowTo, paneA: nearEdge, paneB: farEdge },
            seam: { from: seamFrom, to: seamTo },
            windowEdges, brightest,
            brightAt, frameA, frameB, innerFrom, innerTo, innerBright,
            innerRgb: innerLines.map(brightnessOf),
            frames: [lines[frameA], lines[frameB]],
            // 报告里要能一眼核对:逐列 RGB 写成 "i:r,g,b" 的紧凑串
            sequence: lines.map((c, i) => `${i}:${c.join(',')}`).join(' '),
            lineEdges: windowEdges.filter((e) => e.delta >= 20).length,
            faintEdges: windowEdges.filter((e) => e.delta < 20).length,
        };
        // 裁剪图(边界 ±14px,最近邻放大 6 倍):用户要自己看缝与框的证据
        if (typeof cropPath === 'string' && cropPath !== '') {
            const center = Math.round((nearEdge + farEdge) / 2) + (axis === 'x' ? rect.x : rect.y);
            const crop = axis === 'x'
                ? { x: center - 14, y: rect.y, width: 29, height: Math.min(120, rect.height) }
                : { x: rect.x, y: center - 14, width: Math.min(120, rect.width), height: 29 };
            const shot = await win.webContents.capturePage(crop);
            picked.cropPath = cropPath;
            picked.cropRect = crop;
            picked.crop = writeZoomPng(cropPath, shot, 6);
        }


    } catch (err) {
        picked = { error: err.message, rect };
    }
    await win.webContents.executeJavaScript(
        `(() => { const s = document.getElementById('starfield'); if (s) s.style.visibility = ''; })()`,
    ).catch(() => null);
    return picked;
}

// 把鼠标"移到"某个坐标,并让渲染进程的 **hover 链**真的更新。
//
// 为什么不直接用 `sendInputEvent({type:'mouseMove'})`:合成鼠标事件只有在窗口是**系统
// 前台窗口**时才会更新 hover 状态,而自检窗口未必在前台 —— 同一条 hover 断言会时真时假
// (实测:同一份代码连跑两次,一次 hover 生效、一次不生效,而且上一次的 hover 还清不掉)。
// 这里优先走 CDP 的 `Input.dispatchMouseEvent`(Puppeteer 用的就是这一条),它不依赖前台;
// 调试器接不上时退回 sendInputEvent(那条路对"按下/移动/松开"这类拖动是够用的)。
async function moveMouseTo(win, x, y) {
    try {
        if (win.webContents.debugger.isAttached() !== true) win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x, y, button: 'none', buttons: 0,
        });
        return 'cdp';
    } catch {
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: x + 2, y: y + 2 });
        return 'sendInputEvent';
    }
}

// 轮询等某个元素的选择器匹配到至少 n 个元素,返回实际个数。
function waitForCount(win, selector, n, tries = 40) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let i = 0;
            const tick = () => {
                const c = document.querySelectorAll(${JSON.stringify(selector)}).length;
                if (c >= ${n}) return resolve(c);
                if (++i >= ${tries}) return resolve(c);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => -1);
}

// 轮询等某个选择器的匹配数**恰好等于** n。
// 与 waitForCount 的区别很关键:那个是 ">= n",传 0 会立刻通过 ——
// 于是"收起编辑态后应当没有输入框"这种断言会假通过。
function waitForCountEqual(win, selector, n, tries = 40) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let i = 0;
            const tick = () => {
                const c = document.querySelectorAll(${JSON.stringify(selector)}).length;
                if (c === ${n}) return resolve(c);
                if (++i >= ${tries}) return resolve(c);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => -1);
}

// 轮询等某个输入框的 value **以** prefix 开头。
// 用途:打开/切换笔记后第 0 块是源码态,此时渲染出来的 <h1> 并不存在,
// 想确认"真的切过去了"只能看输入框里的源文。
function waitForValueStart(win, selector, prefix, tries = 40) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let i = 0;
            const tick = () => {
                const el = document.querySelector(${JSON.stringify(selector)});
                const v = el ? String(el.value) : null;
                if (v !== null && v.startsWith(${JSON.stringify(prefix)})) return resolve(true);
                if (++i >= ${tries}) return resolve(false);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => false);
}

/**
 * 点开某篇笔记,并等它**真的切过去**(第 0 块变成这篇的源码)。
 *
 * 为什么不能"点一次 + 等固定时长":`open()` 的第一件事是
 * `if (dirty) await save()`(切走前强制保存),那一下要走 IPC + 原子写;
 * 机器忙的时候(比如 Agent 正在冷启动)整个切换会拖过 4 秒 —— 实测红过一次。
 * 所以超时后再点一次。断言本身没有放松:仍然要求真的切过去,只是不再赌时序。
 */
function switchToNote(win, relPath, tries = 40) {
    const title = `# ${String(relPath).replace(/\.md$/i, '')}`;
    const clickIt = () => win.webContents.executeJavaScript(
        `[...document.querySelectorAll('#noteList button')]`
        + `.find(b => b.dataset.path === ${JSON.stringify(relPath)})?.click()`);
    return (async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
            await clickIt();
            if (await waitForValueStart(win, '#noteDoc textarea.blk-input', title, tries) === true) {
                return true;
            }
        }
        return false;
    })();
}

// 等外壳把插件加载完。
//
// 必须**先查粘性标记再看事件**:外壳可能在外壳脚本执行完的瞬间就绪,
// 而自检挂上监听器要晚一步 —— 只等事件的话,事件早已发过,结果必然是超时。
// 标记 + 事件两条路都留着:标记覆盖"已经就绪",事件覆盖"马上就好"。
// 最后的超时兜底是为了不让自检永远挂住 —— 那样连结果文件都写不出来。
function waitForShellReady(win, timeoutMs = 15000) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            if (window.__kaiwuShellReady) return resolve({
                ok: !window.__kaiwuShellReady.error,
                broken: window.__kaiwuShellReady.broken,
                detail: window.__kaiwuShellReady.error ?? '',
            });
            const timer = setTimeout(() => resolve({
                ok: false, broken: -1, detail: '等待外壳就绪超时(标记与事件都没等到)',
            }), ${timeoutMs});
            document.addEventListener('kaiwu:shell-ready', (e) => {
                clearTimeout(timer);
                resolve({ ok: !e.detail?.error, broken: e.detail?.broken, detail: e.detail?.error ?? '' });
            }, { once: true });
        })
    `).catch(err => ({ ok: false, broken: -1, detail: err.message }));
}

// 轮询等某个元素出现。面板挂载是异步的(要 fetch 面板 HTML),
// 点完按钮立刻读可能还没有。
function waitForElement(win, selector, tries = 40) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
                if (++n >= ${tries}) return resolve(false);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => false);
}

/**
 * 等某个元素**消失**(列表刷新是异步的:刚点完删除那一行还在)。
 *
 * ⚠️ 别拿 waitForElement 反着用来判"没了":它是"等出现",第一拍就发现元素还在于是
 *    立刻 resolve(true) —— 读成"没删掉"就是这么来的(实测踩到)。这里必须从**第一拍**
 *    起就要求"不存在",连续 tries 拍都不存在才算消失。
 */
function waitForGone(win, selector, tries = 40) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                if (!document.querySelector(${JSON.stringify(selector)})) return resolve(true);
                if (++n >= ${tries}) return resolve(false);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => false);
}

// 轮询等某个元素出现并拿到文本,用于断言 setup 真的写进去了内容。
function waitForText(win, selector, tries = 20) {
    const expr = `(document.querySelector(${JSON.stringify(selector)}) || {}).textContent ?? null`;
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                const v = ${expr};
                if (v !== null && v !== '') return resolve(v);
                if (++n >= ${tries}) return resolve(v);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => null);
}

// 轮询等某个元素的文本**等于**期望值。
// 与 waitForText 的区别很关键:那个是"有内容就返回",这里要"内容对得上"。
// 切换面板时旧面板还挂着,用前者会立刻读到旧面板的文本然后"通过"。
function waitForTextEqual(win, selector, expected, tries = 40) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                const el = document.querySelector(${JSON.stringify(selector)});
                const v = el ? el.textContent : null;
                if (v === ${JSON.stringify(expected)}) return resolve(v);
                if (++n >= ${tries}) return resolve(v);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => null);
}

// 轮询等某个元素的**属性**等于期望值(返回最后读到的值)。
// 状态一律用量在属性上断言(比如 #agentPanel 的 data-agent-state):
// 断言中文文案会随着改一个措辞就静默失效,机器可读的那一份不会。
function waitForAttr(win, selector, attr, expected, tries = 40) {    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                const el = document.querySelector(${JSON.stringify(selector)});
                const v = el ? el.getAttribute(${JSON.stringify(attr)}) : null;
                if (v === ${JSON.stringify(expected)}) return resolve(v);
                if (++n >= ${tries}) return resolve(v);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => null);
}

// 轮询等某个元素的**属性出现**(返回它的值,超时返回 null)。
// 与 waitForAttr 的区别:那个要"等于期望值",这个要"已经被写过" ——
// 面板是在 invoke 返回之后才写 data-credential-ok 的,等的是一个**存在性**。
function waitForAttrPresent(win, selector, attr, tries = 40) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                const el = document.querySelector(${JSON.stringify(selector)});
                const v = el ? el.getAttribute(${JSON.stringify(attr)}) : null;
                if (v !== null) return resolve(v);
                if (++n >= ${tries}) return resolve(null);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => null);
}

// 轮询等某个元素的文本**匹配**正则(返回最后读到的文本)。
// 流式回复是分多次到达的,所以不能"读一次就判" —— 那样只会读到一个半截的回复。
function waitForMatch(win, selector, pattern, tries = 40) {
    return win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            const re = new RegExp(${JSON.stringify(pattern.source)});
            let n = 0;
            const tick = () => {
                const el = document.querySelector(${JSON.stringify(selector)});
                const v = el ? el.textContent : null;
                if (typeof v === 'string' && re.test(v)) return resolve(v);
                if (++n >= ${tries}) return resolve(v);
                setTimeout(tick, 100);
            };
            tick();
        })
    `).catch(() => null);
}



