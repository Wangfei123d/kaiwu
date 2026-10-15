import { test } from 'node:test';
import assert from 'node:assert/strict';

// 对话面板用的 Markdown → **DOM 节点**渲染器的用例。
//
// 为什么不是"再抄一份 renderMarkdown":那一份出的是 HTML 字符串,靠 innerHTML 落地 ——
// 笔记预览里可以(内容是你自己的笔记),但**对话里的内容是模型给的**。这个面板的规矩是
// "一律 textContent、绝不 innerHTML 拼字符串",所以这里要的是建节点的那一种。
// 两者**共用同一套解析**(app/lib/markdown.js),输出端各写各的。
//
// 与 notes 那份的差别(有意):对话只要常用子集 —— 标题 / 粗斜体 / 行内码 / 围栏码 /
// 列表 / 引用 / 分隔线 / http(s) 链接。表格、[[wiki]]、#标签 不在这里:
// 面板不碰笔记频道,[[x]] 点了也去不了,画成"还没写的虚线链接"是骗人。

/** 极简 DOM 替身:只认 createElement / createTextNode 与节点树。 */
class El {
    constructor(tag = 'div', doc = null) {
        this.tagName = String(tag).toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentNode = null;
        this.attrs = {};
        this.className = '';
        this._text = '';
        this.isText = false;
    }
    /** 真 DOM 的 textContent 会**聚合子节点**,这里照做 —— 替身不聚合的话,
     *  "元素上写着什么"永远断言到空串:看起来通过,其实什么都没验。 */
    get textContent() {
        if (this.isText === true) return this._text;
        return this._text + this.children.map(c => c.textContent).join('');
    }
    set textContent(value) {
        this._text = String(value);
        this.children = [];
    }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    query(sel) {
        for (const child of this.children) {
            if (matches(child, sel)) return child;
            const deep = child.query?.(sel);
            if (deep) return deep;
        }
        return null;
    }
    queryAll(sel) {
        const out = [];
        for (const child of this.children) {
            if (matches(child, sel)) out.push(child);
            out.push(...(child.queryAll?.(sel) ?? []));
        }
        return out;
    }
}

// 选择器只支持 TAG、.class、[attr] —— 与面板那份替身同一套约定(刻意不用正则)
function matches(node, sel) {
    if (node.isText === true) return false;
    if (sel.startsWith('.')) return String(node.className).split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith('[') && sel.endsWith(']')) return node.getAttribute(sel.slice(1, -1)) !== null;
    return node.tagName === sel.toUpperCase();
}

const doc = {
    createElement: (t) => new El(t, doc),
    createTextNode: (text) => {
        const n = new El('#text', doc);
        n.isText = true;
        n.tagName = '#TEXT';
        n.textContent = String(text);
        return n;
    },
};

const { renderMarkdownNodes } = await import('../app/lib/markdown.js');

/** 读一棵节点树的文字(替身的 textContent 与真 DOM 一样聚合子节点)。 */
function textOf(node) {
    return node === null || node === undefined ? '' : String(node.textContent);
}

const render = (md, options) => renderMarkdownNodes(doc, md, options);

// ---------- 常用子集 ----------

test('粗体 / 斜体 / 行内代码渲染成真的元素,而不是留着星号', () => {
    const nodes = render('这是**加粗**与*斜体*与`code`。');

    const p = nodes[0];
    assert.equal(p.tagName, 'P');
    assert.equal(p.query('strong').textContent, '加粗');
    assert.equal(p.query('em').textContent, '斜体');
    assert.equal(p.query('code').textContent, 'code');
    assert.equal(textOf(p), '这是加粗与斜体与code。', '标记符号本身不许留在文字里');
});

test('标题 1-6 级各自成元素', () => {
    const nodes = render('# 一级\n\n### 三级');

    assert.equal(nodes[0].tagName, 'H1');
    assert.equal(textOf(nodes[0]), '一级');
    assert.equal(nodes[1].tagName, 'H3');
    assert.equal(textOf(nodes[1]), '三级');
});

test('围栏代码块:内容原样,里面的标记不再解析', () => {
    const nodes = render('```js\nconst a = **1**;\n```');

    const pre = nodes[0];
    assert.equal(pre.tagName, 'PRE');
    const code = pre.query('code');
    assert.equal(code.textContent, 'const a = **1**;', '代码块里 **1** 必须是字面文字');
    assert.equal(pre.query('strong'), null, '代码块里不许解析出元素');
});

test('无序 / 有序列表收成 ul / ol,每一步一个 li', () => {
    const ul = render('- 甲\n- 乙');
    assert.equal(ul[0].tagName, 'UL');
    assert.deepEqual(ul[0].queryAll('li').map(li => textOf(li)), ['甲', '乙']);

    const ol = render('1. 一\n2. 二');
    assert.equal(ol[0].tagName, 'OL');
    assert.deepEqual(ol[0].queryAll('li').map(li => textOf(li)), ['一', '二']);
});

test('引用与分隔线', () => {
    const nodes = render('> 引用一句\n\n---');

    assert.equal(nodes[0].tagName, 'BLOCKQUOTE');
    assert.match(textOf(nodes[0]), /引用一句/);
    assert.equal(nodes[1].tagName, 'HR');
});

test('段落里的换行渲染成 br(不能把两行挤成一行)', () => {
    const nodes = render('第一行\n第二行');

    assert.equal(nodes[0].tagName, 'P');
    assert.equal(nodes[0].queryAll('br').length, 1);
    assert.equal(textOf(nodes[0]), '第一行第二行');
});

// ---------- 链接:只放行 http(s) ----------

test('http(s) 链接成 a 元素,并带上 target/rel', () => {
    const nodes = render('见 [文档](https://example.com/a) 。');

    const a = nodes[0].query('a');
    assert.equal(a.textContent, '文档');
    assert.equal(a.getAttribute('href'), 'https://example.com/a');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noreferrer');
});

test('非 http(s) 的链接协议不许变成 a 元素', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///C:/x']) {
        const nodes = render(`[点我](${bad})`);
        assert.equal(nodes[0]?.query('a') ?? null, null, `${bad} 不该变成可点的链接`);
    }
});

// ---------- 图片:模型给的 `![alt](url)` 要真的显示出来 ----------

test('图片:![alt](url) 渲染成 img 元素,src 与 alt 都对,感叹号不许留在文字里', () => {
    const nodes = render('看这张:![山水图](https://cdn.example.com/a.png)');

    const img = nodes[0].query('img');
    assert.ok(img !== null, '要真的建出 <img>,否则界面上只是一行带感叹号的链接');
    assert.equal(img.getAttribute('src'), 'https://cdn.example.com/a.png');
    assert.equal(img.getAttribute('alt'), '山水图');
    assert.equal(textOf(nodes[0]).includes('!['), false, '标记符号不许当字面文字留下');
});

test('图片:非 http(s) 的地址不许变成 img(与链接同一条白名单)', () => {
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=']) {
        const nodes = render(`![x](${bad})`);
        assert.equal(nodes[0]?.query('img') ?? null, null, `${bad} 不该变成图片`);
    }
});

test('图片:alt 里塞标签也只是属性值,不会多出元素', () => {
    const nodes = render('![<img src=x onerror=alert(1)>](https://cdn.example.com/a.png)');

    const img = nodes[0].query('img');
    assert.ok(img !== null, '还是这张图');
    assert.equal(img.getAttribute('alt'), '<img src=x onerror=alert(1)>', 'alt 原样进属性');
    assert.equal(nodes[0].queryAll('[onerror]').length, 0, '不许冒出带事件处理器的元素');
});

test('裸地址:是图片扩展名就直接显示成图(模型不一定写 Markdown 语法)', () => {
    // 实测:模型两次用了两种写法 —— `![图](url)` 与直接贴 `https://…png`。
    const nodes = render('图片地址:https://cdn.example.com/a.png');

    const img = nodes[0].query('img');
    assert.ok(img !== null, '裸的图片地址也要显示成图');
    assert.equal(img.getAttribute('src'), 'https://cdn.example.com/a.png');
});

test('裸地址:不是图片的就渲染成可点链接(而不是一堆死文字)', () => {
    const nodes = render('见 https://example.com/doc 里的说明');

    const a = nodes[0].query('a');
    assert.ok(a !== null, '裸地址要成链接');
    assert.equal(a.getAttribute('href'), 'https://example.com/doc');
    assert.equal(nodes[0].query('img'), null, '不是图片就不许当图片');
});

test('裸地址:末尾的句号/顿号不许被吃进 URL', () => {
    const nodes = render('图在 https://cdn.example.com/a.png。后面还有字');

    const img = nodes[0].query('img');
    assert.equal(img.getAttribute('src'), 'https://cdn.example.com/a.png', '句号要留在正文里');
    assert.match(textOf(nodes[0]), /。后面还有字/);
});

test('Markdown 链接优先于裸地址:不会被拆成"链接 + 裸地址"', () => {
    const nodes = render('[山水图](https://cdn.example.com/a.png)');

    assert.equal(nodes[0].queryAll('a').length, 1);
    assert.equal(nodes[0].query('img'), null, '带文字的 Markdown 链接仍然是链接,不猜成图片');
    assert.equal(textOf(nodes[0]).includes('https://'), false, '地址不该作为文字再出现一次');
});

// ---------- 安全:不可信内容只能变成文字 ----------

test('HTML 不许落地成元素:标签、属性、事件处理器都只能是文字', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const nodes = render(evil);

    assert.equal(nodes[0].query('img'), null, '模型给的标签不许变成元素');
    assert.equal(nodes[0].queryAll('[onerror]').length, 0, '不许带上事件处理器属性');
    assert.ok(textOf(nodes[0]).includes(evil), '它必须原样显示成一行文字');
});

test('script 与 iframe 同样只能是文字', () => {
    const nodes = render('<script>alert(1)</script> 与 <iframe src="//evil"></iframe>');

    assert.equal(nodes[0].query('script'), null);
    assert.equal(nodes[0].query('iframe'), null);
    assert.match(textOf(nodes[0]), /<script>alert\(1\)<\/script>/);
});

test('链接文字里的标签也不许落地(转义发生在文字层)', () => {
    const nodes = render('[<b>粗</b>](https://example.com)');

    const a = nodes[0].query('a');
    assert.ok(a !== null, '链接本身还是链接');
    assert.equal(a.query('b'), null, '链接文字里的 <b> 不许变成元素');
    assert.match(textOf(a), /<b>粗<\/b>/);
});

test('行内代码里的尖括号是文字,不是元素', () => {
    const nodes = render('用 `<div>` 包一层');

    const code = nodes[0].query('code');
    assert.equal(code.textContent, '<div>');
    assert.equal(nodes[0].query('div'), null);
});

// ---------- 不在子集里的语法:保持字面文字,不假装支持 ----------

test('[[wiki 链接]] 与 #标签 在对话里保持字面文字(面板不碰笔记频道,不做假链接)', () => {
    const nodes = render('见 [[甲篇]] 与 #自检');

    assert.equal(nodes[0].query('a'), null, '不许画出点了没反应的链接');
    assert.equal(nodes[0].query('.tag'), null, '对话里不渲染 #标签');
    assert.match(textOf(nodes[0]), /\[\[甲篇\]\]/);
    assert.match(textOf(nodes[0]), /#自检/);
});

test('表格不在子集里:按普通段落渲染,内容一个字都不丢', () => {
    const nodes = render('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');

    assert.equal(nodes[0].query('table'), null);
    assert.match(textOf(nodes[0]), /甲/);
    assert.match(textOf(nodes[0]), /2/);
});

test('显式开启表格时完整渲染表头和每一行，单元格仍安全处理 Markdown', () => {
    const nodes = render('| 场次 | 内容 |\n| --- | --- |\n| 1 | **开场** |\n| 2 | <script>危险</script> |', { tables: true });

    assert.equal(nodes[0].tagName, 'TABLE');
    assert.equal(nodes[0].queryAll('th').length, 2);
    assert.equal(nodes[0].queryAll('td').length, 4);
    assert.equal(nodes[0].query('strong').textContent, '开场');
    assert.equal(nodes[0].query('script'), null);
    assert.match(textOf(nodes[0]), /<script>危险<\/script>/);
});

// ---------- 边界 ----------

test('空输入与纯空白不产生任何节点', () => {
    assert.deepEqual(render(''), []);
    assert.deepEqual(render('   \n  '), []);
});

test('对端给的不是字符串时不许抛(状态里什么都可能有)', () => {
    assert.deepEqual(render(null), []);
    assert.deepEqual(render(undefined), []);
    assert.doesNotThrow(() => render(123));
});

test('未闭合的标记按字面显示,不许吞掉后面的内容', () => {
    const nodes = render('**没闭合的加粗');

    assert.equal(textOf(nodes[0]), '**没闭合的加粗');
    assert.equal(nodes[0].query('strong'), null);
});
