import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks, replaceBlock } from '../app/lib/md-blocks.js';

// 编辑器的核心契约:一次只编辑一块、其余渲染掉。
// 这里用一个最小 DOM 替身跑真实的 createEditor —— DOM 行为在自检里另有真实覆盖。
// 不引 jsdom:项目保持零运行时依赖,替身足够覆盖"块切换 / 落盘内容 / 脏标记"。

class El {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
        this.style = {}; this.listeners = {}; this._html = ''; this._value = '';
        this.hidden = false; this.scrollHeight = 20; this.attrs = {};
        this.classList = { add() {}, remove() {}, toggle() {} };
    }
    // 全选态把状态写在根节点的 data-select-all 上(见 editor.js 的 setSelectAll),
    // 所以替身也得有属性读写 —— 否则那几条断言测的是一个不存在的行为。
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    contains() { return false; }
    set innerHTML(v) { this._html = String(v); this._parse(); }
    get innerHTML() { return this._html; }
    set value(v) { this._value = String(v); }
    get value() { return this._value; }
    /** 按 data-blk 切分。不能用非贪婪 div 匹配 —— 块内含 textarea 时会切错。 */
    _parse() {
        this.children = [];
        const marks = [...this._html.matchAll(/<div class="blk[^"]*" data-blk="(\d+)">/g)];
        for (let i = 0; i < marks.length; i++) {
            const s = marks[i].index + marks[i][0].length;
            const e = i + 1 < marks.length ? marks[i + 1].index : this._html.length;
            const inner = this._html.slice(s, e);
            const el = new El('div');
            el.dataset.blk = marks[i][1];
            if (inner.includes('<textarea')) el._isInput = true;
            this.children.push(el);
        }
    }
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
    querySelector(sel) {
        if (sel === 'textarea.blk-input') return this.children.find(c => c._isInput) ?? null;
        return null;
    }
    querySelectorAll(sel) { return sel.includes('blk') ? this.children : []; }
    closest() { return null; }
    focus() {} setSelectionRange() {}
}

globalThis.document = { createElement: (t) => new El(t) };

const { createEditor } = await import('../app/notes/editor.js');

const NOTE = [
    '# 甲篇',
    '',
    '见 [[乙篇]] 与 [[还没写]]。',
    '',
    '- 甲',
    '- 乙',
].join('\n');

const makeEditor = () => new El();

/**
 * 像真人打字一样往**渲染出来的那个** textarea 里输入:改它的 value,
 * 再把 input 事件递给编辑器。
 *
 * 为什么不能用游离的替身:那样测出来的东西和真实输入不是一回事 ——
 * 曾经因此漏掉"每次提交都把尾巴重写一遍"的 bug(游离替身的值与渲染出来的
 * 那个凑巧一样长,替换区间也凑巧对得上,于是看着一切正常)。
 */
function typeInto(root, value) {
    const ta = root.querySelector('textarea.blk-input');
    assert.ok(ta, '当前应当有一个源码输入框');
    ta.value = value;
    ta.selectionStart = value.length;
    ta.selectionEnd = value.length;
    root.listeners.input[0]({ target: { closest: () => ta } });
    return ta;
}

test('载入后按块渲染,且没有任何块处于源码态', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(`---\ntags: [x]\n---\n${NOTE}`);

    assert.ok(root.children.length >= 4, `应当切成多块,实际 ${root.children.length}`);
    assert.equal(ed.getBody(), NOTE, 'body 应当是去掉 frontmatter 的正文');
    assert.equal(ed.isDirty(), false);
});

test('value() 会把 frontmatter 原样拼回去', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    const full = `---\ntags: [x]\n---\n${NOTE}`;

    ed.load(full);
    assert.equal(ed.value(), full, '打开再保存不该改动 frontmatter(多一个空行也算改动)');
});

test('没有 frontmatter 时不会被凭空加上', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);
    assert.equal(ed.value(), NOTE);
    assert.ok(!ed.value().startsWith('---'));
});

// ---------- 纯文本模式(kind:'text')----------
//
// 用户这一轮的决定:txt **可编辑**,但**必须和 Markdown 隔开** ——
// 不解析 [[链接]]、不认 #标签、不按 Markdown 渲染、也不认 frontmatter。
// 这一组用例就是把"隔开"这四个字钉死在编辑器这一层:任何一条 Markdown 语义
// 漏进 txt,都应当在这里红。

const PLAIN = [
    '---',
    '这不是 frontmatter,就是三行减号',
    '---',
    '# 这不是标题',
    '',
    '见 [[甲篇]] 与 #标签',
    '<img src=x onerror="alert(1)">',
].join('\n');

test('纯文本:逐块渲染,但**一块都不许**被 Markdown 化', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(PLAIN, { kind: 'text' });

    assert.equal(ed.getKind(), 'text');
    assert.equal(ed.getBody(), PLAIN, 'txt 没有 frontmatter —— 开头那三行减号必须原样留在正文里');
    assert.equal(ed.value(), PLAIN, '打开再保存,一个字节都不该变');
    // 逐块看:渲染出来的那一块里不许出现 Markdown 的产物
    for (const child of root.children) {
        const html = String(child.innerHTML ?? '');
        assert.equal(/<h[1-6]/.test(html), false, '`# 这不是标题` 不许变成标题元素');
        assert.equal(/class="wikilink"/.test(html), false, '`[[甲篇]]` 不许变成 wiki 链接');
        assert.equal(/<code|<strong|<em>/.test(html), false, '其它行内 Markdown 也不许生效');
    }
    assert.ok(root.innerHTML.includes('&lt;img'), 'HTML 必须被转义(注入防线与 Markdown 那条路一致)');
});

test('即使启用 Markdown 实时编辑，.txt 仍走纯文本渲染路径', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, liveMarkdown: true });
    ed.load('# 标题\n\n**原样文本**', { kind: 'text' });
    assert.match(root.innerHTML, /blk-plain/);
    assert.doesNotMatch(root.innerHTML, /md-live-editor|<h1|<strong/);
    assert.equal(ed.value(), '# 标题\n\n**原样文本**');
});

test('纯文本 · 预览模式:整篇就是原文,不挂 wiki 链接监听', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(PLAIN, { kind: 'text' });
    ed.setMode('preview');

    assert.ok(root.innerHTML.includes('text-view'), '纯文本用 text-view(等宽 + 保留空白)');
    assert.equal(root.innerHTML.includes('wikilink'), false);
    assert.equal(/<h[1-6]/.test(root.innerHTML), false);
});

test('纯文本:激活一行改它,改动只落进那一行(区间照样精确)', () => {
    const root = makeEditor();
    const ed = createEditor({
        els: { rootEl: root }, resolveLink: () => true, onDirtyChange: () => {},
    });
    const plain = '第一行\n第二行\n第三行';
    ed.load(plain, { kind: 'text' });

    // 只认当前块:激活第 0 块,改它 —— 另外两行必须一个字节都不动
    ed.focusFirst();
    typeInto(root, '第一行改了');

    assert.equal(ed.getKind(), 'text');
    assert.equal(ed.isDirty(), true);
    assert.equal(ed.value(), '第一行改了\n第二行\n第三行');
});

test('Markdown 那一侧不受影响:load 不带 kind 仍是 Markdown 语义', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);
    assert.equal(ed.getKind(), 'markdown');
    assert.ok(/<h1/.test(root.innerHTML), 'Markdown 笔记照旧渲染标题');
});

test('预览模式:整篇渲染且没有输入框', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);

    ed.setMode('preview');
    assert.equal(ed.getMode(), 'preview');
    assert.ok(root.innerHTML.includes('md-view'), '预览模式应当渲染成整篇视图');
    assert.equal(root.querySelector('textarea.blk-input'), null, '预览模式不该有输入框');

    ed.setMode('live');
    assert.equal(ed.getMode(), 'live');
});

test('逐块替换不重排其余内容', () => {
    const blocks = splitBlocks(NOTE);
    const idx = blocks.findIndex(b => b.text === '- 乙');
    assert.notEqual(idx, -1);
    const next = replaceBlock(NOTE, blocks[idx], '- 乙改了');
    assert.ok(next.includes('# 甲篇'));
    assert.ok(next.includes('见 [[乙篇]] 与 [[还没写]]。'));
    assert.ok(next.includes('- 甲\n- 乙改了'));
});

test('body 变化后 value() 反映最新内容', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);

    const blocks = splitBlocks(ed.getBody());
    const target = blocks.find(b => b.text === '见 [[乙篇]] 与 [[还没写]]。');
    ed.load(replaceBlock(ed.getBody(), target, '见 [[乙篇]]。'));

    assert.ok(ed.value().includes('见 [[乙篇]]。'));
    assert.ok(!ed.value().includes('[[还没写]]'));
});

test('激活某块后编辑它:标脏、上报、并落进 value()', () => {
    const root = makeEditor();
    const seen = [];
    const ed = createEditor({
        els: { rootEl: root },
        resolveLink: () => true,
        onDirtyChange: (v) => seen.push(v),
    });
    ed.load(NOTE);
    assert.equal(ed.isDirty(), false, '刚载入不算脏');

    // 先激活某一块 —— 只有当前块是源码态,输入事件只认当前块。
    ed.focusFirst();
    const ta = typeInto(root, '# 甲篇改了');

    assert.equal(ed.isDirty(), true, '编辑当前块后应当标脏');
    assert.deepEqual(seen, [true], 'onDirtyChange 应当被调用一次');
    assert.ok(ed.getBody().includes('# 甲篇改了'),
        'body 应当已含改动,实际:' + JSON.stringify(ed.getBody().slice(0, 60)));
    assert.ok(ed.value().includes('# 甲篇改了'),
        'value() 应当含改动,实际:' + JSON.stringify(ed.value().slice(0, 60)));
    assert.equal(ta.value, '# 甲篇改了');
});

test('连续输入不会把尾巴重复写进去(input 必须同步区间)', () => {
    // ⚠️ 真实踩过的 bug,而且藏了很久:区间是"激活这一块时"记的,
    // 用户一打字 body 里那一段就变长了,而提交时仍按**旧区间**替换 ——
    // 于是每敲一个字符都多留一份尾巴。症状是"打一个字,保存后变成两个"。
    //
    // 当时那条"幂等"用例之所以一路通过,是因为它把一个**游离的** textarea
    // 递给输入处理器,而提交时读的却是渲染出来的那个 —— 两个值凑巧一样长,
    // 替换区间也凑巧对得上。所以这里必须像真实输入那样,改的就是渲染出来的
    // 那个 textarea。
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲乙\n\n丙丁');
    ed.focusFirst();

    typeInto(root, '甲乙');            // 值没变,只触发一次 input
    typeInto(root, '甲乙A');
    typeInto(root, '甲乙AB');
    typeInto(root, '甲乙ABC');

    assert.equal(ed.getBody(), '甲乙ABC\n\n丙丁', 'body 不该有重复的尾巴');
    assert.equal(ed.value(), '甲乙ABC\n\n丙丁', 'value() 也不该再加一份');
});

test('value() 是幂等的:反复调用不会改动内容', () => {
    // 真实踩过的 bug:commitActive 用"重新切分后的同序号块"去替换,
    // 区间已经错位,于是 value() 把刚写进去的内容又抹掉一次。
    // 表现是"body 改对了、但 value() 返回旧内容",极难发现。
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);
    ed.focusFirst();
    typeInto(root, '# 甲篇改了');

    const first = ed.value();
    const second = ed.value();
    const third = ed.value();
    assert.equal(first, second, '第二次调用 value() 不该改变内容');
    assert.equal(second, third, '第三次也一样');
    assert.equal(first, '# 甲篇改了\n\n见 [[乙篇]] 与 [[还没写]]。\n\n- 甲\n- 乙',
        '保存下去的必须正好是用户写的内容');
});

test('未激活的块收到 input 事件不会标脏(只认当前块)', () => {
    const root = makeEditor();
    const seen = [];
    const ed = createEditor({
        els: { rootEl: root },
        resolveLink: () => true,
        onDirtyChange: (v) => seen.push(v),
    });
    ed.load(NOTE);

    // 没有任何块被激活 → activeIndex 是 -1 → 这个事件应当被忽略
    const ta = new El('textarea');
    ta.dataset.blk = '0';
    ta.value = '# 不该生效';
    root.listeners.input?.[0]?.({ target: { closest: () => ta } });

    assert.equal(ed.isDirty(), false, '没激活的块不该能改内容');
    assert.deepEqual(seen, []);
    assert.ok(!ed.value().includes('不该生效'));
});

test('空的正文不会崩,并提示可以开始写', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('');
    assert.equal(ed.getBody(), '');
    assert.ok(root.innerHTML.includes('hint'));
});

test('frontmatter 后的正文分块正确', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('---\ntitle: 标题\nlist: [a, b]\n---\n第一段\n\n第二段');
    assert.equal(ed.getBody(), '第一段\n\n第二段');
});

// ---------- 键位:回车 / 上下跳块 / 合并行 ----------
// 这一组守的是用户报的那个 bug:"按回车上一行不渲染,得用鼠标点一下才渲染;
// 按下方向键也跳不出当前块"。根因是分块单位(见 md-blocks.js),修法在 editor.js。

/** 造一个最小键盘事件:handler 只读这几个字段。 */
function keyEvent(key, ta, extra = {}) {
    return {
        key,
        keyCode: 0,
        isComposing: false,
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
        target: { closest: () => ta },
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...extra,
    };
}

/** 造一个"当前源码块"的输入框替身。 */
function blockInput(idx, value, caret = null) {
    const ta = new El('textarea');
    ta.dataset.blk = String(idx);
    ta.value = value;
    if (caret !== null) { ta.selectionStart = caret; ta.selectionEnd = caret; }
    return ta;
}

const press = (root, ev) => root.listeners.keydown?.[0]?.(ev);
const activeBlk = (root) => root.querySelector('textarea.blk-input')?.dataset.blk ?? null;

test('回车:上一行立刻渲染,光标落到下一块', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('# 甲篇\n\n正文');
    ed.focusFirst();
    assert.equal(activeBlk(root), '0');

    const ev = keyEvent('Enter', blockInput(0, '# 甲篇'));
    press(root, ev);

    assert.equal(ev.defaultPrevented, true, '回车必须被接管,不能让它插进 textarea');
    assert.ok(root.innerHTML.includes('<h1>甲篇</h1>'),
        '上一行必须已经变成渲染结果,实际:' + root.innerHTML);
    assert.equal(activeBlk(root), '1', '源码态应当换到下一块');
    assert.equal(ed.getBody(), '# 甲篇\n\n正文',
        '光标已经在行尾时按回车,不该凭空多出一个空行');
});

test('回车:光标在行中间时把这一行切开', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('abcdef');
    ed.focusFirst();

    press(root, keyEvent('Enter', blockInput(0, 'abc', 3)));
    assert.equal(ed.getBody(), 'abc\n');
    assert.equal(activeBlk(root), '1', '后半截(这里是空行)应当成为新的源码块');
});

test('回车:连续按会在末尾不断新起空行', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲');
    ed.focusFirst();

    press(root, keyEvent('Enter', blockInput(0, '甲')));
    assert.equal(ed.getBody(), '甲\n');
    assert.equal(activeBlk(root), '1');

    // 第二块现在是空的,再按一次回车应当再新起一行
    press(root, keyEvent('Enter', blockInput(1, '')));
    assert.equal(ed.getBody(), '甲\n\n');
    assert.equal(activeBlk(root), '2');
});

test('回车在代码块内部只是换行,不在中间切一刀', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('```\nconst a = 1;\n```');
    ed.focusFirst();
    assert.equal(activeBlk(root), '0');

    const ev = keyEvent('Enter', blockInput(0, '```\nconst a = 1;'));
    press(root, ev);

    assert.equal(ev.defaultPrevented, false, '代码块里回车交给 textarea 自己处理');
    assert.equal(ed.getBody(), '```\nconst a = 1;\n```', 'body 不该被切开');
});

test('↓ 跳到下一块,内容不变', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙');
    ed.focusFirst();
    assert.equal(activeBlk(root), '0');

    const ev = keyEvent('ArrowDown', blockInput(0, '甲'));
    press(root, ev);

    assert.equal(ev.defaultPrevented, true);
    assert.equal(activeBlk(root), '1', '应当跳出当前块,进入下一块');
    assert.equal(ed.getBody(), '甲\n乙', '只是移动光标,不该改内容');
});

test('↑ 在第一块上什么都不做(不越界)', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙');
    ed.focusFirst();

    const ev = keyEvent('ArrowUp', blockInput(0, '甲'));
    press(root, ev);

    assert.equal(ev.defaultPrevented, true, '仍然要拦下默认行为,免得光标乱跑');
    assert.equal(activeBlk(root), '0');
    assert.equal(ed.getBody(), '甲\n乙');
});

test('行首退格:与上一行合并(否则空行永远删不掉)', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n\n乙');

    // 点第 2 块(乙)让它成为源码块
    root.listeners.click[0]({
        target: { closest: (sel) => (sel === '.blk' ? { dataset: { blk: '2' } } : null) },
    });
    assert.equal(activeBlk(root), '2');

    press(root, keyEvent('Backspace', blockInput(2, '乙', 0)));

    assert.equal(ed.getBody(), '甲\n乙', '中间那个空行应当被并掉');
    assert.equal(activeBlk(root), '1', '光标落到合并后的那一行');
});

test('行尾 Delete:把下一行并上来', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙');
    ed.focusFirst();

    press(root, keyEvent('Delete', blockInput(0, '甲', 1)));
    assert.equal(ed.getBody(), '甲乙');
});

test('空笔记:点一下就能开始写(不是只有一行提示)', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('');
    assert.ok(root.innerHTML.includes('hint'), '还没点的时候给提示');
    assert.equal(root.querySelector('textarea.blk-input'), null);

    ed.focusFirst();
    assert.equal(activeBlk(root), '0', '空笔记也要能进入编辑,否则新建的笔记没法写');

    // 输入内容 → 落回 body
    const ta = blockInput(0, '第一行');
    root.listeners.input[0]({ target: { closest: () => ta } });
    assert.equal(ed.getBody(), '第一行');
    assert.equal(ed.isDirty(), true);
});

// ---------- 点选 / 拖选 ----------
//
// 用户报的两件事:①"点一次只是选中了文本区,要连点两次才能编辑";
// ②"选中文本只能选中单行"。两者是同一个根因 —— 旧实现把 mousedown 直接接到
// "激活这一块",指针一按下就把 DOM 换成 textarea:原生选择被就地掐断(所以拖不出
// 一行),浏览器随后的默认聚焦又落在已被替换的元素上(所以光标没进输入框)。
//
// 下面这组用例钉住新的分工:**按下只记位置、拖动就保留选择、松手那一次 click 才进编辑**。

/** 一次鼠标事件。`blk` 是"点在哪一块上"的替身,与真实 e.target.closest 同形状。 */
function pointer(blk, x = 0, y = 0, button = 0) {
    return {
        button, clientX: x, clientY: y,
        target: { closest: (sel) => (sel === '.blk' ? { dataset: { blk: String(blk) } } : null) },
    };
}

test('mousedown 只记位置:不许在这一刻就把 DOM 换成 textarea', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);

    assert.equal(activeBlk(root), null, '载入后没有源码块');
    root.listeners.mousedown[0](pointer(2, 10, 10));
    assert.equal(activeBlk(root), null,
        '按下就换 DOM 会掐断拖选(用户说的"只能选中单行"就是这里)');
});

test('拖过阈值之后的 click 不算"点":保留选择,不进编辑态', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);

    root.listeners.mousedown[0](pointer(2, 10, 10));
    root.listeners.mousemove[0](pointer(2, 60, 10));    // 水平拖了 50px
    root.listeners.click[0](pointer(2, 60, 10));

    assert.equal(activeBlk(root), null, '拖选之后不许顺手进编辑态');
});

test('手抖 2px 仍算一次点击:单击直接进入该行编辑', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);

    root.listeners.mousedown[0](pointer(2, 10, 10));
    root.listeners.mousemove[0](pointer(2, 12, 10));    // 阈值 4px 以内
    root.listeners.click[0](pointer(2, 12, 10));

    assert.equal(activeBlk(root), '2', '一次点击(含手抖)就该进入这一行');
});

test('拖到一半又拖回来(仍超阈值过):不算点击', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);

    root.listeners.mousedown[0](pointer(1, 100, 100));
    root.listeners.mousemove[0](pointer(1, 140, 100));  // 拖出去了
    root.listeners.mousemove[0](pointer(1, 101, 100));  // 又拖回起点附近
    root.listeners.click[0](pointer(1, 101, 100));

    assert.equal(activeBlk(root), null,
        '只要拖过一次就按"在选东西"处理 —— 不然手一抖就把选择吞了');
});

test('只发 click(自动化那条路)照样进入编辑', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);

    // 自检/单测里用 element.click() 时不产生 mousedown/mouseup
    root.listeners.click[0](pointer(3));
    assert.equal(activeBlk(root), '3');
});

test('点在输入框或 wiki 链接上时不抢事件', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load(NOTE);

    root.listeners.click[0](pointer(2));                 // 先让第 2 块进入编辑
    assert.equal(activeBlk(root), '2');

    const onInput = {
        clientX: 5, clientY: 5,
        target: { closest: (sel) => (sel === 'textarea.blk-input' ? {} : null) },
    };
    root.listeners.click[0](onInput);
    assert.equal(activeBlk(root), '2', '点在自己的输入框里:光标交给浏览器,编辑器不动');

    const onLink = {
        clientX: 6, clientY: 6,
        target: { closest: (sel) => (sel === 'a.wikilink' ? {} : null) },
    };
    root.listeners.click[0](onLink);
    assert.equal(activeBlk(root), '2', '点在 wiki 链接上:交给链接,不在这里进编辑');
});

// ---------- 全选整篇(Ctrl+A)----------
//
// 用户报的 bug 原话:"我无法按 Ctrl+A 全选删除,只能删一段"。
// 根因是**块级**编辑器:一"段"= 一个块 = 一个独立 textarea,浏览器原生的 Ctrl+A
// 只选得到当前 textarea 里的内容,所以永远只删得掉一块。跨块的选区在 DOM 上不
// 存在 —— 只能在编辑器这一层自己维护一个状态。
//
// 这一组钉住四件事:① 进得去;② 退格/删除 = 整篇清空且标脏(标脏才是自动落盘的信号);
// ③ 打字 = 覆盖整篇;④ 任何其它动作都退出,不留"看不见的全选"。

/** 全选态的两个读数:根节点属性(视觉/外部唯一真相)与对外只读出口。 */
const selectAllAttr = (root) => root.getAttribute('data-select-all');

test('Ctrl+A:正文里进入"全选整篇"态,而不是只选当前那一块', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙\n丙');
    ed.focusFirst();
    assert.equal(ed.isSelectAll(), false, '载入后本来不在全选态');

    const ev = keyEvent('a', blockInput(0, '甲'), { ctrlKey: true });
    press(root, ev);

    assert.equal(ev.defaultPrevented, true,
        '必须拦下浏览器默认的"只选当前 textarea",否则就还是"只能删一段"');
    assert.equal(ed.isSelectAll(), true, '对外出口应当报"整篇选着"');
    assert.equal(selectAllAttr(root), '1',
        '根节点上要有 data-select-all —— 它同时是 CSS 高亮的钩子与外部读数');
    assert.equal(ed.getBody(), '甲\n乙\n丙', '全选本身不该改动内容');
    assert.equal(ed.isDirty(), false, '全选本身不该标脏');
});

test('Ctrl+A → 退格:整篇清空(留一个空块,并且标脏 = 会自动落盘)', () => {
    const root = makeEditor();
    const seen = [];
    const ed = createEditor({
        els: { rootEl: root }, resolveLink: () => true, onDirtyChange: (v) => seen.push(v),
    });
    ed.load('甲\n乙\n丙');
    ed.focusFirst();
    press(root, keyEvent('a', blockInput(0, '甲'), { ctrlKey: true }));

    const del = keyEvent('Backspace', blockInput(0, '甲'));
    press(root, del);

    assert.equal(del.defaultPrevented, true, '退格必须被接管,不能让 textarea 自己删一小段');
    assert.equal(ed.getBody(), '', '整篇应当清空 —— 这就是用户要的"一次删干净"');
    assert.equal(ed.value(), '', 'value() 是写盘用的那一份,它也必须空');
    assert.deepEqual(seen, [true],
        '必须标脏:自动保存是跟着 onDirtyChange 来的 —— 少了它,屏幕上空了、磁盘上还在');
    assert.equal(ed.isSelectAll(), false, '删完就该退出全选态');
    assert.equal(selectAllAttr(root), null, '视觉高亮也要一起摘掉');
    assert.equal(activeBlk(root), '0',
        '留一个空块并把光标放进去(用户可以接着写),而不是留一屏"点一下开始写"的提示');
});

test('Ctrl+A → Delete:与退格同一条路(整篇清空)', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙\n丙');
    ed.focusFirst();
    press(root, keyEvent('a', blockInput(0, '甲'), { ctrlKey: true }));

    press(root, keyEvent('Delete', blockInput(0, '甲')));
    assert.equal(ed.getBody(), '');
    assert.equal(ed.value(), '');
});

test('Ctrl+A → 打一个字符:整篇被替换成那一个字符', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙\n丙');
    ed.focusFirst();
    press(root, keyEvent('a', blockInput(0, '甲'), { ctrlKey: true }));

    const typed = keyEvent('新', blockInput(0, '甲'));
    press(root, typed);

    assert.equal(typed.defaultPrevented, true, '必须接管,否则这一个字符会插进当前块');
    assert.equal(ed.getBody(), '新', '全选状态下打字 = 覆盖整篇(与系统语义一致)');
    assert.equal(ed.isSelectAll(), false, '覆盖完就退出全选态');

    // 接着打字必须接在这一个字符**后面**。这条顺带钉住"替换后的区间是对的":
    // 区间若还停在旧的 {0,1} 之外/之内不对,第二次输入就会把 body 写坏。
    typeInto(root, '新的');
    assert.equal(ed.getBody(), '新的', '替换之后的续写不许把内容写歪');
});

test('Ctrl+A 之后:Esc / 点别处 / 切块 / 焦点离开 都退出全选态(不留"看不见的全选")', () => {
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙\n丙');
    ed.focusFirst();
    const arm = () => press(root, keyEvent('a', blockInput(0, '甲'), { ctrlKey: true }));

    // ① Esc
    arm();
    const esc = keyEvent('Escape', blockInput(0, '甲'));
    press(root, esc);
    assert.equal(ed.isSelectAll(), false, 'Esc 应当取消全选');
    assert.equal(esc.defaultPrevented, false,
        'Esc 不能被吞掉:上层还要用它关面板 / 退出编辑');

    // ② 点别处(指针按下)
    arm();
    root.listeners.mousedown[0](pointer(1, 5, 5));
    assert.equal(ed.isSelectAll(), false, '点到别的地方就该退出');

    // ③ 切块(点另一块让它变源码)
    arm();
    root.listeners.click[0](pointer(2));
    assert.equal(ed.isSelectAll(), false, '切块也是一次"其它动作"');

    // ④ 焦点离开正文根节点(点到侧栏 / 标题框去了)
    arm();
    root.listeners.focusout[0]({ relatedTarget: null });
    assert.equal(ed.isSelectAll(), false, '焦点跑出正文根节点就该退出');
});

test('全选态被打断之后,退格回到"只删当前块"的老行为(绝不莫名其妙删掉整篇)', () => {
    // 这是"退出"这件事真正的判据:光看状态位不够,必须验证**退出之后**的键位
    // 走的是老逻辑。否则就是一个"隐形全选":用户以为取消了,一按退格整篇没了。
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙\n丙');
    ed.focusFirst();
    press(root, keyEvent('a', blockInput(0, '甲'), { ctrlKey: true }));
    press(root, keyEvent('Escape', blockInput(0, '甲')));
    assert.equal(ed.isSelectAll(), false);

    press(root, keyEvent('Backspace', blockInput(0, '甲', 0)));
    assert.equal(ed.getBody(), '甲\n乙\n丙', '退出全选后退格只该管当前块(第 0 块行首:什么都不删)');
});

test('Ctrl+A 只认正文块:标题框 / 搜索框那种输入框一概不劫持', () => {
    // 真实 DOM 里标题框(#noteTitle)、改名框、搜索框都在正文根节点**之外**
    // (app/index.html),它们的事件根本走不到编辑器的 keydown —— 这里把这个前提
    // 钉在单元层:事件的 target 不是 `textarea.blk-input` 时,编辑器必须原样放行。
    const root = makeEditor();
    const ed = createEditor({ els: { rootEl: root }, resolveLink: () => true });
    ed.load('甲\n乙\n丙');
    ed.focusFirst();

    const notBlockInput = {
        key: 'a', keyCode: 0, isComposing: false,
        ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
        // 普通 input / 搜索框的 closest('textarea.blk-input') 就是 null
        target: { closest: () => null },
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
    };
    press(root, notBlockInput);

    assert.equal(notBlockInput.defaultPrevented, false,
        '不在正文块里就绝不能 preventDefault —— 那正是标题框 Ctrl+A 被劫持的样子');
    assert.equal(ed.isSelectAll(), false);
    assert.equal(selectAllAttr(root), null, '也不该给正文根节点打上全选标记');

    // 真窗口里那一条(标题框 Ctrl+A 仍只选标题本身)在 electron/selftest.js 里另有一遍。
});

