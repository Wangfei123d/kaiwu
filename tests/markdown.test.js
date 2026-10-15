import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { renderMarkdown, escapeHtml } from '../app/lib/markdown.js';

// 这个模块是一条**注入边界**:输出会被塞进 innerHTML。
// 所以除了功能,还要专门用一组用例守住"原文里的标签不能变成标签"。

const R = (md, opts) => renderMarkdown(md, opts);

// ---------- 转义与注入 ----------

test('escapeHtml 转掉全部五个危险字符', () => {
    assert.equal(escapeHtml('<a href="x">&\'</a>'),
        '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('正文里的 HTML 标签被转义,不会变成真标签', () => {
    const html = R('<script>alert(1)</script>');
    assert.ok(!html.includes('<script>'), '绝不能原样输出 script 标签');
    assert.ok(html.includes('&lt;script&gt;'));
});

test('img onerror 这类注入被转义', () => {
    const html = R('<img src=x onerror=alert(1)>');
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
});

test('行内代码里的 HTML 也被转义', () => {
    const html = R('用 `<b>` 加粗');
    assert.ok(html.includes('<code>&lt;b&gt;</code>'));
    assert.ok(!html.includes('<b>'));
});

test('代码块里的 HTML 被转义且不做标记解析', () => {
    const html = R('```\n<script>x</script>\n**不该加粗**\n```');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<strong>'), '代码块里不该解析 markdown 标记');
});

test('外部链接只放行 http/https', () => {
    const ok = R('[站点](https://example.com)');
    assert.ok(ok.includes('href="https://example.com"'));
    // javascript: 不匹配我们的模式,所以不会被渲染成链接
    const bad = R('[点我](javascript:alert(1))');
    assert.ok(!bad.includes('href="javascript:'), 'javascript: 不能被渲染成链接');
});

// ---------- 基本块 ----------

test('标题', () => {
    assert.ok(R('# 一级').includes('<h1>一级</h1>'));
    assert.ok(R('### 三级').includes('<h3>三级</h3>'));
});

test('段落', () => {
    assert.ok(R('一段话').includes('<p>一段话</p>'));
});

test('连续行合并进同一段落,并保留换行', () => {
    const html = R('第一行\n第二行');
    assert.equal((html.match(/<p>/g) || []).length, 1);
    assert.ok(html.includes('<br>'));
});

test('无序列表', () => {
    const html = R('- 甲\n- 乙');
    assert.ok(html.includes('<ul><li>甲</li><li>乙</li></ul>'), html);
});

test('有序列表', () => {
    const html = R('1. 甲\n2. 乙');
    assert.ok(html.includes('<ol><li>甲</li><li>乙</li></ol>'), html);
});

test('引用块', () => {
    const html = R('> 引用内容');
    assert.ok(html.includes('<blockquote>'));
    assert.ok(html.includes('引用内容'));
});

test('分隔线', () => {
    assert.ok(R('---').includes('<hr>'));
    assert.ok(R('***').includes('<hr>'));
});

test('围栏代码块', () => {
    const html = R('```js\nconst a = 1;\n```');
    assert.ok(html.includes('<pre><code>const a = 1;</code></pre>'), html);
});

test('表格', () => {
    const html = R('| 列一 | 列二 |\n|---|---|\n| a | b |');
    assert.ok(html.includes('<th>列一</th>'), html);
    assert.ok(html.includes('<td>a</td>'), html);
});

// ---------- 行内标记 ----------

test('粗体与斜体', () => {
    assert.ok(R('**粗**').includes('<strong>粗</strong>'));
    assert.ok(R('*斜*').includes('<em>斜</em>'));
});

test('行内代码', () => {
    assert.ok(R('`code`').includes('<code>code</code>'));
});

test('行内代码里的星号不被当作强调', () => {
    const html = R('`a * b`');
    assert.ok(html.includes('<code>a * b</code>'));
    assert.ok(!html.includes('<em>'), '代码里的 * 不该变成强调');
});

// ---------- wiki 链接 ----------

test('wiki 链接渲染成带 data-note 的元素', () => {
    const html = R('见 [[另一篇]]', { resolveLink: () => true });
    assert.ok(html.includes('data-note="另一篇"'), html);
    assert.ok(!html.includes('missing'));
});

test('指向未写笔记的链接标成 missing', () => {
    const html = R('见 [[还没写]]', { resolveLink: () => false });
    assert.ok(html.includes('missing'));
});

test('默认(没有 resolveLink)按未解析处理', () => {
    const html = R('见 [[某篇]]');
    assert.ok(html.includes('missing'), '不知道是否存在时,宁可提示"还没写"');
});

test('wiki 链接的别名作为显示文字', () => {
    const html = R('[[真实目标|显示文字]]', { resolveLink: () => true });
    assert.ok(html.includes('>显示文字</a>'), html);
    assert.ok(html.includes('data-note="真实目标"'));
});

test('wiki 链接目标里的引号被转义,不会逃出属性', () => {
    const html = R('[[a" onmouseover="x]]', { resolveLink: () => true });
    assert.ok(!html.includes('onmouseover="x"'), '不能靠闭合属性注入事件处理器');
});

test('嵌入 ![[...]] 显示文档标记', () => {
    const html = R('![[图.png]]', { resolveLink: () => true });
    assert.ok(html.includes('📄'));
});

test('标签渲染成 span', () => {
    const html = R('提到 #项目/开物 了');
    assert.ok(html.includes('<span class="tag">#项目/开物</span>'), html);
});

// ---------- 边界 ----------

test('空输入返回空串', () => {
    assert.equal(R(''), '');
    assert.equal(R(null), '');
    assert.equal(R(undefined), '');
});

test('只有空白也返回空串', () => {
    assert.equal(R('   \n\n  ').trim(), '');
});

test('列表紧跟在标题后面不会被吞掉', () => {
    const html = R('# 标题\n- 甲\n- 乙');
    assert.ok(html.includes('<h1>标题</h1>'));
    assert.ok(html.includes('<ul>'));
});

test('未闭合的围栏代码块把剩余内容都当代码', () => {
    const html = R('```\nabc');
    assert.ok(html.includes('<pre><code>abc</code></pre>'));
});

test('引用里的标题与列表也能渲染', () => {
    const html = R('> # 引用里的标题\n> 正文');
    assert.ok(html.includes('<blockquote>'));
    assert.ok(html.includes('<h1>引用里的标题</h1>'));
});

// ---------- 收敛性(真机故障回归) ----------
//
// 这一组的重点**不是输出对不对,而是它必须返回**。
//
// 真机故障(2026-09-25):`E:\仓库\未命名.md` 的内容恰好是两个字节 `"# "`(井号 + 一个空格,
// 后面什么都没有)。块循环里"标题"那条要求井号后面至少有**一个非空字符**(`(.+?)`),
// 而"段落"那条的终止判据(`#{1,6}\s`)只要求井号后面是空白 —— 两个判据夹在一起,
// 这一行哪个分支都吃不下,`i` 不前进,外层 while 就**永远转下去**:
// 渲染线程占满一个核、IPC 一条都不回,界面上就是"程序卡住了"(窗口却不报未响应,
// 卡的是渲染进程而不是窗口消息泵)。打开那篇笔记的动作由布局存档里的
// `{"view":"doc","doc":"未命名.md"}` 这个标签在启动时触发,所以"启动就卡"。
//
// ⚠️ 为什么这一组必须走**子线程 + 看门狗**:同步死循环在 node:test 里没有别的办法
// 变成"失败" —— 直接调用只会把整个套件一起吊死(连超时都轮不到)。放进 Worker,
// 超时就 terminate,用例是干净的红。
function parseWithWatchdog(markdown, timeoutMs = 5000) {
    const mod = new URL('../app/lib/markdown.js', import.meta.url).href;
    return new Promise((resolve, reject) => {
        // worker 里一律用动态 import:不依赖 worker 是 CJS 还是 ESM 上下文。
        const source = `
            import('node:worker_threads').then(({ parentPort }) => {
                import(${JSON.stringify(mod)}).then((m) => {
                    parentPort.postMessage({ ok: true, blocks: m.parseMarkdown(${JSON.stringify(markdown)}) });
                }).catch((err) => parentPort.postMessage({ ok: false, error: String(err && err.message || err) }));
            });
        `;
        const worker = new Worker(source, { eval: true });
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error(`parseMarkdown 在 ${timeoutMs}ms 内没有返回(不收敛):${JSON.stringify(markdown)}`));
        }, timeoutMs);
        worker.once('message', (msg) => { clearTimeout(timer); worker.terminate(); resolve(msg); });
        worker.once('error', (err) => { clearTimeout(timer); worker.terminate(); reject(err); });
    });
}

test('空标题(# 后面只有空白)必须返回,并且就是一个空标题', async () => {
    // 真机上把整个应用卡住的那一行,原文就是这两个字节。
    const r = await parseWithWatchdog('# ');
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.blocks, [{ type: 'heading', level: 1, inlines: [] }]);
});

test('只有井号与空白的各级空标题都必须返回', async () => {
    for (const md of ['## ', '####   ', '#\t']) {
        const r = await parseWithWatchdog(md);
        assert.equal(r.ok, true, `${JSON.stringify(md)}:${r.error}`);
        assert.equal(r.blocks[0].type, 'heading', JSON.stringify(md));
    }
});

test('井号后没有空白的仍然不是标题(#标签那条路不受影响)', async () => {
    // 修好收敛性最容易踩的坑:把 `(.+?)` 放宽成"井号后面随便什么" ——
    // 那样 `#标签` 会被当成一级标题,行内标签功能整条失效。
    const r = await parseWithWatchdog('#标签 说明');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.blocks[0].type, 'paragraph');
    assert.equal(r.blocks[0].lines[0][0].type, 'tag');
    assert.equal(r.blocks[0].lines[0][0].text, '#标签');
});

test('认不出的块起始行按段落收下 —— 主循环每轮必须前进', async () => {
    // 同一个死循环的另一条入口:围栏的判据比围栏的处理宽
    // (`\`\`\`js foo` 命中终止判据里的 ``` ,却不匹配"信息串不含空白"的围栏规则)。
    // 兜底一旦只修"空标题"那一条,这一类输入照样把渲染线程转死。
    const r = await parseWithWatchdog('```js foo');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.blocks[0].type, 'paragraph');
    assert.equal(R('```js foo'), '<p>```js foo</p>');
});

test('空标题后面还有正文时,两块都在', async () => {
    const r = await parseWithWatchdog('# \n正文');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.blocks.length, 2);
    assert.equal(r.blocks[0].type, 'heading');
    assert.equal(r.blocks[1].type, 'paragraph');
});
