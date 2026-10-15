import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPanelWorkspace, DEFAULT_BAND_PX, DEFAULT_EDGE, DEFAULT_EDGE_BAND_PX, GUTTER_PX, EMPTY_PANE_HINT } from '../app/shell/panel-workspace.js';
import {
    defaultTree, listPaneIds, isPane, dockBottom, split, pane, DEFAULT_SIDE_SPLIT, findPane,
    addPane, detach, tabKeysOf,
} from '../app/lib/panel-tree.js';

// 渲染层(工作台)。这里用**替身 DOM** 跑真实的 createPanelWorkspace:
// 落点判定、拖分隔条只动相邻两片、"松手才写存档"这些是接线里的逻辑错误最容易
// 藏身的地方,而它们不需要真的 Electron 就能验(自检一次 30-60 秒,太贵)。
//
// 真界面上"每个面板都真的可见、尺寸非零"那条断言**不在这里** —— CSS 命中
// 被搬走的元素这类坑,替身 DOM 根本看不见。那条在 electron/selftest.js 里
// 用 getBoundingClientRect + getComputedStyle 量真窗口。

// ---------- 替身 DOM(只实现工作台用到的那一撮) ----------

class FakeStyle {
    constructor() { this.props = {}; }
    setProperty(k, v) { this.props[k] = String(v); }
    getPropertyValue(k) { return this.props[k] ?? ''; }
}

class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...names) { for (const n of names) if (n) this.set.add(n); this.sync(); }
    remove(...names) { for (const n of names) this.set.delete(n); this.sync(); }
    contains(n) { return this.set.has(n); }
    sync() { this.el._className = [...this.set].join(' '); }
    reset(str) { this.set = new Set(String(str ?? '').split(/\s+/).filter(Boolean)); this.sync(); }
}

class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.dataset = {};
        this.attrs = {};
        this.style = new FakeStyle();
        this.classList = new ClassList(this);
        this._className = '';
        this._listeners = {};
        this.textContent = '';
        this.title = '';
        this.tabIndex = -1;
        this.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    }
    get className() { return this._className; }
    set className(v) { this.classList.reset(v); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, fn) { (this._listeners[t] ??= []).push(fn); }
    removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] ?? []).filter((f) => f !== fn); }
    fire(type, ev = {}) {
        const event = { type, preventDefault() {}, stopPropagation() {}, target: this, ...ev };
        for (const fn of [...(this._listeners[type] ?? [])]) fn(event);
        return event;
    }
    appendChild(node) {
        if (node.parentElement) node.parentElement.removeChild(node);
        node.parentElement = this;
        this.children.push(node);
        return node;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    removeChild(node) {
        const i = this.children.indexOf(node);
        if (i >= 0) this.children.splice(i, 1);
        node.parentElement = null;
        return node;
    }
    replaceChildren(...nodes) {
        for (const c of this.children) c.parentElement = null;
        this.children = [];
        for (const n of nodes) this.appendChild(n);
    }
    remove() { this.parentElement?.removeChild(this); }
    getBoundingClientRect() { return this.rect; }
    closest(sel) {
        // ⚠️ 支持**逗号列表**(`.a, .b, .c`):产品代码用
        //    `closest('.pw-tab, .pw-tabs-add, .pw-tabs-more')` 按目标元素切开
        //    "这一枚标签的事"与"拖整片容器"。替身不认列表的话,那条判定会在这里
        //    **静默失效**(永远返回 null),测试就再也证明不了它 —— 所以替身要跟上。
        const sels = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
        let node = this;
        while (node) {
            if (sels.some((s) => (s.startsWith('.') ? node.classList.contains(s.slice(1)) : node.tagName === s.toUpperCase()))) return node;
            node = node.parentElement;
        }
        return null;
    }
    querySelectorAll(sel) { return findAll(this, (n) => matches(n, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

function matches(node, sel) {
    if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
    return node.tagName === sel.toUpperCase();
}

function findAll(root, pred) {
    const out = [];
    const walk = (n) => {
        if (pred(n)) out.push(n);
        for (const c of n.children ?? []) walk(c);
    };
    walk(root);
    return out;
}

function rect(left, top, width, height) {
    return { left, top, width, height, right: left + width, bottom: top + height };
}

function fakeWin() {
    const listeners = {};
    return {
        addEventListener(t, fn) { (listeners[t] ??= []).push(fn); },
        removeEventListener(t, fn) { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
        fire(t, ev = {}) { for (const fn of [...(listeners[t] ?? [])]) fn({ preventDefault() {}, ...ev }); },
        count(t) { return (listeners[t] ?? []).length; },
    };
}

const PANE_SPECS = {
    notes: { title: '笔记列表' },
    doc: { title: '笔记正文' },
    links: { title: '链接', fullTitle: '反向链接 / 出链 / 还没写的' },
    ai: { title: 'AI 对话', fullTitle: 'AI 对话(Agent 面板)' },
};
const PANE_IDS = ['notes', 'doc', 'links', 'ai'];
const GUTTERS = [
    { id: 'navResizer', after: 'notes', defaultPx: 236 },
    { id: 'sideResizer', after: 'doc', defaultPx: 240, which: 1 },
];

/**
 * 旧三栏形状的树(右栏里上下叠着链接与 AI),权重按像素给。
 *
 * 用它是因为好些用例的坐标是按"notes 400 / doc 500 / 右栏 300"写死的 ——
 * 而默认树是嵌套的(右栏内部还有一条 col 分割),坐标得先能算得出来。
 */
function flatTree(weights = [400, 500, 300]) {
    return split('row', weights, [
        pane('notes'), pane('doc'),
        split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
    ]);
}

/** 搭一套工作台(默认布局),并把四片的矩形按树算出来摆在 1200×600 上。 */
async function setup({ store = null, initialTree = null, load = null, isTabDirty = null, onActivateTab = null, viewTitle = null, extraPanes = {}, requiredIds = null } = {}) {
    const doc = {
        createElement: (tag) => new El(tag),
        documentElement: { clientWidth: 1200 },
        elementFromPoint: () => null,
        activeElement: null,
    };
    const win = fakeWin();
    const desk = new El('div');
    desk.rect = rect(0, 0, 1200, 600);
    const stack = new El('div');
    desk.appendChild(stack);
    const hintEl = new El('div');
    const bandEl = new El('div');
    const treeEl = new El('span');
    const resetBtn = new El('button');
    const host = new El('section');

    const panels = {
        notes: new El('aside'), doc: new El('main'),
        links: new El('aside'), ai: new El('section'),
    };
    const paneSpecs = { ...PANE_SPECS, ...extraPanes };
    for (const id of Object.keys(extraPanes)) {
        if (!panels[id]) panels[id] = new El('section');
    }
    panels.notes.className = 'notes-nav';
    panels.doc.className = 'note-main';
    panels.links.className = 'note-links';
    panels.ai.className = 'agent-panel';
    // 旧的两条像素分隔条(工作台挂载时要把它们清掉)
    const oldNav = new El('div'); oldNav.className = 'col-resizer'; oldNav.id = 'navResizer';
    const oldSide = new El('div'); oldSide.className = 'col-resizer'; oldSide.id = 'sideResizer';
    host.append(oldNav, oldSide, ...Object.values(panels));

    const saved = [];
    const layoutCalls = [];
    const storeImpl = store ?? {
        save: (tree) => { saved.push(tree); return Promise.resolve(true); },
        load: async () => (load ? load() : { ok: false, tree: null }),
    };

    const ws = createPanelWorkspace({
        doc, win, desk, stack, hintEl, bandEl, treeEl, resetBtn, host,
        panes: Object.fromEntries(Object.entries(paneSpecs).map(([id, spec]) => [id, { ...spec, el: panels[id] }])),
        requiredIds: requiredIds ?? Object.keys(paneSpecs),
        store: storeImpl,
        gutters: GUTTERS,
        initialTree: initialTree ?? defaultTree(),
        isTabDirty,
        onActivateTab,
        viewTitle,
    });
    await ws.mount();

    const panesOf = () => findAll(stack, (n) => typeof n.dataset?.paneId === 'string');
    const byId = (id) => panesOf().find((n) => n.dataset.paneId === id) ?? null;
    // 替身 DOM 没有布局引擎,所以按**树**自己算矩形:row 分宽度、col 分高度,
    // 每一层扣掉分隔条占的像素。叶子包装(.pw-leaf)与它里面的面板在真界面里同格,
    // 所以矩形一起给 —— 分隔条量的是叶子,落点判定量的面板。
    // ⚠️ 胶囊的矩形必须在 `ws.refresh()` **之后**摆:`paintStrips()` 会
    //    `strip.replaceChildren()`,整批胶囊被换成新节点(替身 DOM 里新节点的
    //    rect 是 0×0)。摆早了等于没摆 —— 实测:落点判定永远退化成"追加到末尾",
    //    拖动因为"位移不足 4px"整条不启动。
    const placeChips = () => {
        for (const n of panesOf()) {
            const strip = n.querySelector?.('.pw-tabs');
            if (!strip) continue;
            const chips = strip.querySelectorAll?.('.pw-tab') ?? [];
            chips.forEach((chip, i) => {
                const w = Math.max(1, (n.rect.width - 12) / Math.max(1, chips.length));
                chip.rect = rect(n.rect.left + 6 + i * w, n.rect.top + 2, w,
                    Math.max(1, Math.min(24, n.rect.height) - 4));
            });
        }
    };
    const layout = (box = rect(0, 0, 1200, 600)) => {
        const walk = (node, r) => {
            if (isPane(node)) {
                const el = byId(node.id);
                if (!el) return;
                el.rect = r;
                if (el.parentElement) el.parentElement.rect = r;
                // ⚠️ 标签条也要有矩形:落点判定第 1 条问的就是"指针在不在 `.pw-tabs` 里"
                //    (规格 §4.2 要求它优先于顶部边缘带)。替身 DOM 没有布局引擎,
                //    不摆这一份矩形的话每一点都会被判成"贴着上边缘"。
                const strip = el.querySelector?.('.pw-tabs');
                if (strip) strip.rect = rect(r.left, r.top, r.width, Math.min(24, r.height));
                return;
            }
            const horizontal = node.dir === 'row';
            const total = horizontal ? r.width : r.height;
            const avail = Math.max(0, total - GUTTER_PX * (node.children.length - 1));
            let at = horizontal ? r.left : r.top;
            node.children.forEach((child, i) => {
                const size = avail * (node.sizes[i] / 100);
                walk(child, horizontal
                    ? rect(at, r.top, size, r.height)
                    : rect(r.left, at, r.width, size));
                at += size + GUTTER_PX;
            });
        };
        walk(ws.getTree(), box);
        doc.elementFromPoint = (x, y) => panesOf().find(
            (n) => x >= n.rect.left && x <= n.rect.right && y >= n.rect.top && y <= n.rect.bottom) ?? null;
        // ⚠️ 标签条**压在正文上面**(CSS 里它是 flex 的第一个孩子、条在正文之上),
        //    所以指针落在条的范围内时 `elementFromPoint` 应该先给条 —— 真浏览器就是这样。
        //    替身按矩形范围自己算:点在条的矩形里就返回条,否则返回面板。
        const hitTest = doc.elementFromPoint;
        doc.elementFromPoint = (x, y) => {
            for (const n of panesOf()) {
                const strip = n.querySelector?.('.pw-tabs');
                const sr = strip?.rect;
                if (sr && sr.width > 0 && x >= sr.left && x <= sr.right && y >= sr.top && y <= sr.bottom) return strip;
            }
            return hitTest(x, y);
        };
        // ⚠️ 摆完矩形还要让工作台**重新量一遍** —— 真界面里浏览器自己会量(所以 resize 绑了
        // refresh),替身 DOM 没有布局引擎:不 refresh 的话,标签条读到的可用宽度永远是 0,
        // 于是每一片都停在"窄栏下拉"形态(实测踩过:关一个标签之后连 .pw-tab 都找不到)。
        ws.refresh();
        placeChips();                       // ⚠️ 必须在 refresh 之后(见 placeChips 的注释)
    };
    layout();
    // 真界面上 mount 时就能量到真实矩形(外壳已可见);替身 DOM 里矩形是刚摆的,
    // 所以再量一次读数(尺寸 / 分隔条 aria)。
    ws.refresh();

    return {
        ws, doc, win, desk, stack, host, hintEl, bandEl, treeEl, resetBtn, panels,
        saved, layoutCalls, panesOf, byId, layout,
        /**
         * 手动给某一格摆一个矩形(替身 DOM 没有布局引擎)。
         * ⚠️ **标签条与胶囊的矩形必须一起改**:`usableWidthOf` 优先读标签条自己的矩形
         * (真身上是 clientWidth),只改面板的矩形会让形态(胶囊/下拉)与它实际宽度对不上。
         */
        setPaneRect: (id, r) => {
            const pane = byId(id);
            if (!pane) return;
            pane.rect = r;
            if (pane.parentElement) pane.parentElement.rect = r;
            const strip = pane.querySelector?.('.pw-tabs');
            if (strip) strip.rect = rect(r.left, r.top, r.width, Math.min(24, r.height));
            ws.refresh();
            placeChips();
        },
        gutter: (id) => findAll(stack, (n) => n.id === id)[0] ?? null,
        // ⚠️ 标题栏已取消:拖整片容器的手势挂在**标签条**上(.pw-tabs —— 里面的抓手与
        //    条上空白都是它的地盘)。替身的 `fire` **不冒泡**,所以拖拽用例必须点在
        //    标签条自己身上,而不是里面的抓手。
        handleOf: (id) => findAll(byId(id), (n) => n.classList.contains('pw-tabs'))[0] ?? null,
        // 抓手(⠿):键盘可达的那一点,读屏的全称也挂在它身上
        gripOf: (id) => findAll(byId(id), (n) => n.classList.contains('pw-grip'))[0] ?? null,
    };
}

// ---------- 渲染 ----------

test('渲染:四片都在,面板被搬进叶子的内容区(同一批节点,不是克隆)', async () => {
    const h = await setup();
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'doc', 'links', 'ai']);
    assert.equal(h.panesOf().length, 4);
    for (const id of PANE_IDS) {
        const pane = h.byId(id);
        assert.ok(pane, `${id} 的容器在`);
        assert.equal(pane.getAttribute('role'), 'region');
        // ⚠️ 读屏的名字取**当前那一枚标签**(面板自己没有名字了 —— 属性由标签页继承)
        assert.match(pane.getAttribute('aria-label'), /\(当前标签\)$/);
        const body = pane.querySelector('.pw-body');
        assert.equal(body.children[0], h.panels[id], '面板本体就在内容区里');
        assert.notEqual(h.panels[id].parentElement, h.host, '已经不在旧容器里了');
    }
    // ⚠️ 面板**没有名字**了:原来的标题栏(`.pw-head` + `.pw-name`)整条不存在 ——
    //    名字只由标签一处给出,所以"标题写一遍、胶囊又写一遍"在结构上不可能再发生。
    for (const id of PANE_IDS) {
        assert.equal(findAll(h.byId(id), (n) => n.classList.contains('pw-head')).length, 0,
            `${id}: 名称行必须不存在`);
        assert.equal(findAll(h.byId(id), (n) => n.classList.contains('pw-name')).length, 0,
            `${id}: 名称元素必须不存在`);
    }
    // ⚠️ 抓手与条上空白**只显示、不驱动**(规格 §1.2:整片拖动已删),所以它们
    //    **不在无障碍树里**(aria-hidden)、也**不进 Tab 序** —— 一个"看着能拖、其实不能"
    //    的可聚焦控件比不显示更糟。名字只由标签一处给出。
    for (const id of PANE_IDS) {
        const grip = h.gripOf(id);
        assert.equal(grip.getAttribute('aria-hidden'), 'true', `${id}: 抓手不向读屏宣告`);
        assert.notEqual(grip.tabIndex, 0, `${id}: 抓手不再可聚焦`);
        assert.equal(grip.getAttribute('aria-label'), null, `${id}: 抓手没有读屏名字`);
    }
    // 旧的两条像素分隔条被换掉了(否则会有两个 #navResizer)
    assert.equal(h.host.querySelectorAll('.col-resizer').length, 0);
    assert.equal(h.host.classList.contains('pw-host'), true);
});

test('渲染:抓手 / 标签条空白 / 标题栏都不再是拖动起点(整片拖动整条删掉,不是藏起来)', async () => {
    const h = await setup();
    h.layout();
    const before = JSON.stringify(h.ws.getTree());
    const ai = h.byId('ai');
    // ① 抓手按下再走:树不动、不写存档、也没有任何落点高亮
    const grip = h.gripOf('ai');
    grip.fire('pointerdown', { button: 0, clientX: 1000, clientY: 400 });
    assert.equal(h.win.count('pointermove'), 0, '抓手按下**没有**挂 window 上的拖动监听');
    h.win.fire('pointermove', { clientX: 200, clientY: 300 });
    h.win.fire('pointerup', { clientX: 200, clientY: 300 });
    assert.equal(JSON.stringify(h.ws.getTree()), before, '抓手拖动不改布局');
    assert.equal(h.saved.length, 0, '不写存档');
    assert.equal(h.hintEl.classList.contains('pw-on'), false, '没有落点预览');
    // ② 条上空白同理
    ai.querySelector('.pw-grabpad').fire('pointerdown', { button: 0, clientX: 1000, clientY: 400 });
    assert.equal(h.win.count('pointermove'), 0, '条上空白按下也没挂监听');
    // ③ 标签条本身(空白区)同理 —— 旧实现是"条上任何非胶囊处都能拖整片"
    ai.querySelector('.pw-tabs').fire('pointerdown', { button: 0, clientX: 1000, clientY: 400 });
    assert.equal(h.win.count('pointermove'), 0, '标签条空白按下也没挂监听');
    // ④ 正文同理
    ai.querySelector('.pw-body').fire('pointerdown', { button: 0, clientX: 1000, clientY: 400 });
    assert.equal(h.win.count('pointermove'), 0, '正文按下也没挂监听');
    // ⑤ DOM 里也不再有任何"正在拖整片"的类名(旧实现会给 .pw-pane 挂 pw-dragging)
    assert.equal(findAll(h.stack, (n) => n.classList.contains('pw-dragging')).length, 0);
});

test('渲染:分隔条是带读数的 separator(键盘可聚焦、可调)', async () => {
    const h = await setup();
    for (const [id, orientation] of [['navResizer', 'vertical'], ['sideResizer', 'vertical']]) {
        const g = h.gutter(id);
        assert.ok(g, `${id} 在`);
        assert.equal(g.getAttribute('role'), 'separator');
        assert.equal(g.getAttribute('aria-orientation'), orientation);
        assert.equal(g.tabIndex, 0, '分隔条也能聚焦(键盘可调)');
        assert.ok(Number(g.getAttribute('aria-valuemax')) > Number(g.getAttribute('aria-valuemin')));
    }
    // links 与 ai 之间那条是新出现的(**竖向**分隔条):它们是上下叠着的两格
    const colGutters = findAll(h.stack, (n) => n.classList.contains('pw-gutter')
        && n.classList.contains('pw-col'));
    assert.equal(colGutters.length, 1, '右栏内部那条上下分隔条在');
    assert.equal(colGutters[0].getAttribute('aria-orientation'), 'horizontal');
    assert.equal(h.treeEl.textContent,
        '{row 19% / 62% / 19%}[ 笔记列表 , 笔记正文 , {col 42% / 58%}[ 链接 , AI 对话 ] ]');
});

test('zoneAt:只读兼容口 —— 中间 / 左 / 右 / 上 / 下 / 自己身上(没有落点)', async () => {
    const h = await setup({ initialTree: flatTree([400, 500, 300]) });
    h.layout();                                   // notes 0-395, doc 402-896, 右栏 903-1199
    assert.deepEqual(h.ws.zoneAt(20, 300), { kind: 'edge', id: 'notes', side: 'left' });
    assert.deepEqual(h.ws.zoneAt(200, 300), { kind: 'center', id: 'notes' });
    assert.deepEqual(h.ws.zoneAt(390, 300), { kind: 'edge', id: 'notes', side: 'right' });
    assert.deepEqual(h.ws.zoneAt(200, 20), { kind: 'edge', id: 'notes', side: 'top' });
    assert.deepEqual(h.ws.zoneAt(200, 580 - DEFAULT_BAND_PX - 20), { kind: 'edge', id: 'notes', side: 'bottom' });
    assert.equal(DEFAULT_EDGE, 0.28);
    assert.equal(h.ws.zoneAt(200, 300).id, 'notes');
    // ⚠️ `zoneAt` 是**旧口径的只读兼容口**,它仍然会报 `bottom-dock`(既有断言读它),
    //    但那条带**不再有手势**:底部整宽停靠按规格 §4 末尾删掉了(见下一条用例)。
    assert.deepEqual(h.ws.zoneAt(200, 590), { kind: 'bottom-dock' });
});

test('tabDropZoneAt:标签条 > 四边 28px 带 > 正文中央 > 取消(规格 §4.2 的顺序)', async () => {
    const h = await setup({ initialTree: flatTree([400, 500, 300]) });
    h.layout();                                   // notes 0-395, doc 402-896, 右栏 903-1199
    assert.equal(DEFAULT_EDGE_BAND_PX, 28, '固定像素带,不是比例');
    // ① 标签条:条在面板顶上那一条,命中它是 stack + 插入位(**优先于上边缘带**)
    const strip = stripOf(h, 'notes');
    const sr = strip.getBoundingClientRect();
    const onStrip = h.ws.tabDropZoneAt(sr.left + 2, sr.top + 1);
    assert.equal(onStrip.kind, 'stack');
    assert.equal(onStrip.slotId, 'notes');
    assert.equal(typeof onStrip.insertAt, 'number', '标签条上给的是插入位,不是 null');
    // ② 左/右/上/下四条带(28px 之内)
    assert.deepEqual(h.ws.tabDropZoneAt(410, 300), { kind: 'edge', slotId: 'doc', side: 'left' });
    assert.deepEqual(h.ws.tabDropZoneAt(890, 300), { kind: 'edge', slotId: 'doc', side: 'right' });
    // 顶部那一条带从 y=0 起算,但**标签条盖在前 24px 上** —— 所以取 y=27:
    //    既在上边缘带(28px)的判定里、又已经落在标签条下面(规格 §4.2 的顺序判据)。
    // ⚠️ 读数留档这里有个**真实观察**:真机上标签条约 25px 高,所以"上边缘带"只剩
    //    最上面几像素可用(与规格 §4.2 的"标签条优先"是同一个设计取舍 —— demo 里
    //    BAND=28、条也在顶上,它的判据一模一样)。已写进回报。
    assert.deepEqual(h.ws.tabDropZoneAt(650, 27), { kind: 'edge', slotId: 'doc', side: 'top' });
    assert.deepEqual(h.ws.tabDropZoneAt(650, 592), { kind: 'edge', slotId: 'doc', side: 'bottom' });
    // ③ 其余正文中央 = 追加到末尾
    assert.deepEqual(h.ws.tabDropZoneAt(650, 300), { kind: 'stack', slotId: 'doc', insertAt: null });
    // ④ 没命中任何 .pw-pane → null
    h.doc.elementFromPoint = () => null;
    assert.equal(h.ws.tabDropZoneAt(650, 300), null);
    // ⑤ 认的是**整个 .pw-pane**(旧实现只认 .pw-tabs):正文里一点也能拿到落点
    h.doc.elementFromPoint = () => h.byId('doc').querySelector('.pw-body');
    assert.equal(h.ws.tabDropZoneAt(650, 300)?.slotId, 'doc');
});

// ---------- 拖**一枚标签**(规格 §4 / §7 第三组) ----------
//
// ⚠️ 这一组替换掉了旧的"拖面板"一组:那一组钉的是**整片容器**的四种落点
// (抓手/标签条空白按下 → 换位 / 插边 / 整宽底栏),而那正是规格 §1.2 明令禁止的手势。
// 旧手势在新实现里**连监听都不挂**(见上一条用例),所以那几条断言不是"改成绿",
// 而是被删掉、换成了下面这些"拖一枚标签"的判据。

/**
 * 拖一枚标签的合成指针序列:按下 → 走够阈值 → 松手。
 * 返回 h,方便链式读取读数。
 */
function dragTab(h, fromPaneId, index, to) {
    const pill = tabEls(h, fromPaneId)[index];
    assert.ok(pill, `第 ${index} 枚标签要在 DOM 里`);
    const r = pill.getBoundingClientRect();
    const sx = r.left + 4;
    const sy = r.top + 4;
    pill.fire('pointerdown', { button: 0, clientX: sx, clientY: sy });
    h.win.fire('pointermove', { clientX: to.x, clientY: to.y });
    h.win.fire('pointerup', { clientX: to.x, clientY: to.y });
    return pill;
    h.win.fire('pointermove', { clientX: to.x, clientY: to.y });
    h.win.fire('pointerup', { clientX: to.x, clientY: to.y });
    return pill;
}

test('拖标签:到另一片面板的**正文中央** → 并进同一个槽位,被拖的成为最前(active)', async () => {
    const h = await setup({ initialTree: flatTree([400, 500, 300]) });
    h.layout();                                   // notes 0-395,doc 402-896,右栏 903-1199(links 上 / ai 下)
    const before = listPaneIds(h.ws.getTree());
    // links 那一片的正文中央(避开四边带、也避开它自己的标签条)
    dragTab(h, 'ai', 0, { x: 1050, y: 150 });
    const after = h.ws.getTree();
    assert.deepEqual(listPaneIds(after), ['notes', 'doc', 'links'], 'AI 那一格空了 → 整格消失(不留空面板)');
    const host = findPane(after, 'links');
    assert.deepEqual(host.tabs.map((t) => t.view), ['links', 'ai'], '并进 links 那一格,追加在末尾');
    assert.equal(host.active, 1, '被拖的成为**最前**(active)');
    assert.equal(h.saved.length, 1, '松手写一次存档');
    assert.equal(h.ws.tabsOf('links').tabs.length, 2, '读数也看得到两枚');
    assert.notDeepEqual(before, listPaneIds(after));
});

test('拖标签:到目标**右边缘** → 出现右侧单标签新槽位(不调用旧的整片 dropOnEdge)', async () => {
    const h = await setup({ initialTree: flatTree([400, 500, 300]) });
    h.layout();
    // doc 的右边缘带内(28px):x = 896-6
    dragTab(h, 'ai', 0, { x: 890, y: 300 });
    const after = h.ws.getTree();
    const keys = tabKeysOf(after);
    assert.equal(keys.includes('ai'), true, 'AI 这一枚还在树上');
    const fresh = listPaneIds(after).find((i) => i.startsWith('slot:'));
    assert.match(fresh, /^slot:\d+$/, `新槽位 id 是槽位序号(不是视图名):${fresh}`);
    assert.deepEqual(findPane(after, fresh).tabs, [{ view: 'ai' }], '新槽位只装被拖的那一枚');
    // 未拖的那些留在原栈 —— 旧整片 dropOnEdge 会把**整格**搬走,这里只是"一枚标签"
    assert.deepEqual(findPane(after, 'links').tabs, [{ view: 'links' }], 'links 那一格还在、没被整片搬走');
    assert.deepEqual(findPane(after, 'notes').tabs, [{ view: 'notes' }]);
    assert.deepEqual(findPane(after, 'doc').tabs, [{ view: 'doc' }]);
    assert.equal(keys.length, 4, `四枚标签一枚不少:${keys}`);
    assert.equal(h.saved.length, 1);
});

test('拖标签:标签条上也并入同一槽位(标签条优先于上边缘带),并画竖向插入线', async () => {
    const h = await setup({ initialTree: flatTree([400, 500, 300]) });
    h.layout();
    const strip = stripOf(h, 'notes');
    const sr = strip.getBoundingClientRect();
    // 落在 notes 标签条上、又贴着它的**上边缘** —— 两个判据重叠,规格要求标签条优先
    dragTab(h, 'doc', 0, { x: sr.left + 4, y: sr.top + 1 });
    const after = h.ws.getTree();
    assert.deepEqual(listPaneIds(after), ['notes', 'links', 'ai'], 'doc 那一格空了 → 收拢;剩下的都在');
    assert.deepEqual(findPane(after, 'notes').tabs.map((t) => t.view), ['doc', 'notes'],
        '按胶囊中线算出来是插到第 0 位(最左)');
    assert.equal(findPane(after, 'notes').active, 0, '被拖的成为最前');
    // 没有因为"贴着上边缘"而给 notes 上方劈出一格
    assert.equal(listPaneIds(after).some((i) => i.startsWith('slot:')), false, '标签条优先,不劈新格');
});

test('拖标签:没有落点(松手在空白处)时树、活动标签与存档都不变', async () => {
    const h = await setup();
    h.doc.elementFromPoint = () => null;             // 指针下面什么都没有
    const before = JSON.stringify(h.ws.getTree());
    dragTab(h, 'ai', 0, { x: 5, y: 5 });
    assert.equal(JSON.stringify(h.ws.getTree()), before, '树不变');
    assert.equal(h.saved.length, 0, '也不写存档');
    assert.equal(h.hintEl.classList.contains('pw-on'), false, '没有留下落点预览');
    assert.equal(findAll(h.stack, (n) => n.classList.contains('pw-pane-drop')).length, 0, '临时类清干净');
    assert.equal(findAll(h.stack, (n) => n.classList.contains('pw-tab-dragging')).length, 0, '半透明标记也清掉');
});

test('拖标签:走不够 4px 阈值 = 普通点击(不劫持点击切换)', async () => {
    const h = await setup();
    h.layout();
    const before = JSON.stringify(h.ws.getTree());
    const pill = tabEls(h, 'ai')[0];
    const r = pill.getBoundingClientRect();
    pill.fire('pointerdown', { button: 0, clientX: r.left + 4, clientY: r.top + 4 });
    h.win.fire('pointermove', { clientX: r.left + 5, clientY: r.top + 5 });   // 只走了 2px
    h.win.fire('pointerup', { clientX: r.left + 5, clientY: r.top + 5 });
    assert.equal(JSON.stringify(h.ws.getTree()), before, '没到阈值 → 不算拖');
    assert.equal(h.saved.length, 0);
    pill.fire('click');
    assert.equal(h.ws.tabsOf('ai').active, 0, '点击仍然照常切换标签');
});

test('拖标签:右键(非左键)不启动拖动', async () => {
    const h = await setup();
    tabEls(h, 'ai')[0].fire('pointerdown', { button: 2, clientX: 1000, clientY: 400 });
    assert.equal(h.win.count('pointermove'), 0, '右键根本不该挂监听器');
});

test('拖标签:窄布局(下拉)里拖 `.pw-tabs-cur` 只移动**当前**那一枚', async () => {
    // 两枚文档标签 + 一片窄面板:doc 是内容型格子(装两枚),ai 挤到 200px 走下拉
    const two = split('row', [19, 62, 19], [
        pane('notes'),
        pane('doc', [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }], 1),
        split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
    ]);
    const h = await setup({ initialTree: two });
    h.setPaneRect('ai', rect(900, 300, 200, 300));
    assert.equal(stripOf(h, 'ai').dataset.mode, 'dropdown', '200px → 下拉形态');
    const cur = stripOf(h, 'ai').querySelector('.pw-tabs-cur');
    assert.ok(cur, '下拉里的当前标签文字在');
    assert.equal(cur.textContent, 'AI 对话');
    // 目标 = doc 那一片的正文中央
    const r = cur.getBoundingClientRect();
    cur.fire('pointerdown', { button: 0, clientX: r.left + 4, clientY: r.top + 4 });
    h.win.fire('pointermove', { clientX: 650, clientY: 300 });
    h.win.fire('pointerup', { clientX: 650, clientY: 300 });
    const after = h.ws.getTree();
    const docPane = findPane(after, 'doc');
    assert.deepEqual(docPane.tabs.map((t) => t.view), ['doc', 'doc', 'ai'],
        '只把**当前**那一枚(AI)搬过去;两枚文档标签一个不少');
    assert.equal(docPane.active, 2, '搬过去的就是当前那个');
    assert.equal(listPaneIds(after).includes('ai'), false, '窄面板那一格空了 → 收拢');
});

test('拖标签:一次拖动里"合并 + 拆分"都做完之后,活动视图的 DOM 只挂在一个 .pw-body 里', async () => {
    const h = await setup({ initialTree: flatTree([400, 500, 300]) });
    h.layout();
    /** 走一遍树:每一格的**活动标签**那个视图,其 DOM 必须恰好出现在一个 `.pw-body` 里。 */
    const checkMounted = (label) => {
        const bodies = findAll(h.stack, (n) => n.classList.contains('pw-body'));
        const tree = h.ws.getTree();
        for (const id of listPaneIds(tree)) {
            const leaf = findPane(tree, id);
            const view = leaf.tabs[leaf.active]?.view;
            if (view === undefined) continue;
            const el = h.panels[view];
            const hits = bodies.filter((b) => b.children.includes(el));
            assert.equal(hits.length, 1, `${label}:${view}(槽位 ${id} 的活动标签)恰好挂在一个内容区里(实际 ${hits.length})`);
        }
        // 反向:没有任何面板本体同时挂在两处
        for (const [view, el] of Object.entries(h.panels)) {
            const hits = bodies.filter((b) => b.children.includes(el));
            assert.ok(hits.length <= 1, `${label}:${view} 的 DOM 不许同时在两个内容区里`);
        }
    };
    // ① 合并:把 ai 拖进 links 的正文中央
    dragTab(h, 'ai', 0, { x: 1050, y: 150 });
    assert.equal(findAll(h.stack, (n) => n.classList.contains('pw-body'))
        .filter((b) => b.children.includes(h.panels.ai)).length, 1, '合并之后 AI 的 DOM 只在一个内容区里');
    assert.equal(h.panels.ai.parentElement, h.byId('links').querySelector('.pw-body'), '就在 links 那一格');
    checkMounted('合并后');
    // ② 拆分:把并进去的 ai 那一枚拖到 notes 的右边缘 → 单标签新槽位
    h.layout();
    dragTab(h, 'links', 1, { x: 390, y: 300 });
    const after = h.ws.getTree();
    assert.equal(tabKeysOf(after).length, 4, `四枚标签一枚不少:${tabKeysOf(after)}`);
    checkMounted('拆分后');
});

test('拖标签:落到自己那一格上 = 取消(同槽位没有落点)', async () => {
    const h = await setup({ initialTree: flatTree([400, 500, 300]) });
    h.layout();
    const before = JSON.stringify(h.ws.getTree());
    dragTab(h, 'doc', 0, { x: 650, y: 300 });        // doc 自己的正文中央
    assert.equal(JSON.stringify(h.ws.getTree()), before, '落在自己身上不改树');
    assert.equal(h.saved.length, 0);
});

test('尺寸角标:文本永远是真的,而"显不显示"由状态决定(拖动 / 聚焦分隔条时才淡入)', async () => {
    const h = await setup({ initialTree: flatTree([236, 700, 250]) });
    h.layout();
    const sizeEl = (id) => h.handleOf(id).querySelector('.pw-size');
    const shown = (id) => `${Math.round(h.byId(id).rect.width)}×${Math.round(h.byId(id).rect.height)}`;
    // 文本一直写对(常驻或按需都不该写错);静止时工作台上没有"正在调尺寸"的标记
    assert.equal(sizeEl('notes').textContent, shown('notes'));
    assert.equal(h.desk.classList.contains('pw-resizing'), false, '静止:没有标记 → CSS 让角标淡出');

    // 拖分隔条:按下就挂标记(所有面板的角标一起显形),松手摘掉
    const g = h.gutter('navResizer');
    g.fire('pointerdown', { button: 0, clientX: 236, clientY: 300 });
    assert.equal(h.desk.classList.contains('pw-resizing'), true, '拖动中:标记在 → 角标显形');
    const before = sizeEl('notes').textContent;
    h.win.fire('pointermove', { clientX: 316, clientY: 300 });
    h.layout();                                     // 替身 DOM 的矩形跟着新树重算
    h.win.fire('pointermove', { clientX: 340, clientY: 300 });
    assert.notEqual(sizeEl('notes').textContent, before, '拖动中角标要跟着变,不能停在旧数字上');
    assert.equal(sizeEl('notes').textContent, shown('notes'), '它与这一片当前的尺寸一致');
    h.win.fire('pointerup', {});
    assert.equal(h.desk.classList.contains('pw-resizing'), false, '松手:标记摘掉 → 角标淡出');

    // 键盘用户:分隔条**拿到焦点**就等于"正在调它"(方向键随时会按)
    g.fire('focus');
    assert.equal(h.desk.classList.contains('pw-resizing'), true);
    g.fire('blur');
    assert.equal(h.desk.classList.contains('pw-resizing'), false);

    // ⚠️ 旧实现还有一条"拖**整片面板**时角标也显形"(`.pw-dragging`)。那条手势已按规格删除,
    //    连同 CSS 里 `.pw-pane.pw-dragging .pw-size` 一起 —— 所以这里不再断言它。
    //    现在的显形时机只有三个:悬停标签条 / 标签条里有焦点 / 正在拖分隔条。
});

// ---------- 拖分隔条 ----------

test('拖分隔条:只动相邻两片,其余片不动;拖动中不写存档,松手写一次', async () => {
    const h = await setup({ initialTree: flatTree([236, 700, 250]) });
    // notes=236、doc=700(两条分隔条自己占 14px 不在矩形里)
    h.layout();
    const g = h.gutter('navResizer');
    const before = h.ws.getTree();
    g.fire('pointerdown', { button: 0, clientX: 236, clientY: 300 });
    assert.equal(g.dataset.dragging, '1', '拖动中给个标记(CSS 用它点亮分隔条)');
    assert.equal(h.win.count('pointermove'), 1, '移动挂在 window 上(拖快了指针会离开那 7px)');
    h.win.fire('pointermove', { clientX: 316, clientY: 300 });
    const during = h.ws.getTree();
    assert.ok(during.sizes[0] > before.sizes[0], '左片变宽');
    assert.equal(during.sizes[2], before.sizes[2], '右片一点不动');
    assert.equal(Math.round(during.sizes[0] + during.sizes[1]), Math.round(before.sizes[0] + before.sizes[1]),
        '相邻两片之和不变');
    assert.equal(h.saved.length, 0, '一次拖动有上百个 move,不能每个都写盘');

    h.win.fire('pointerup', {});
    assert.equal(h.saved.length, 1, '松手才落一次');
    assert.equal(h.win.count('pointermove'), 0, '松手后要摘掉 window 上的监听器');
    assert.equal(g.dataset.dragging, undefined);
    // 真的宽了 80px:236 → 316(用渲染读数换算,不看具体百分比)
    const after = h.ws.getTree();
    const pair = after.sizes[0] + after.sizes[1];
    const navPx = after.sizes[0] / pair * 936;
    assert.ok(Math.abs(navPx - 316) < 1, `左片 236 → 316,实际 ${navPx.toFixed(1)}px`);
    assert.equal(h.byId('notes').parentElement.style.flex, `${after.sizes[0]} 1 0%`, '新比例写回了 DOM');
});

test('拖分隔条:6% 保底在拖动过程中就生效(不是松手才夹)', async () => {
    const h = await setup({ initialTree: flatTree([236, 700, 250]) });
    h.layout();
    const g = h.gutter('navResizer');
    g.fire('pointerdown', { button: 0, clientX: 236, clientY: 300 });
    h.win.fire('pointermove', { clientX: -5000, clientY: 300 });
    const sizes = h.ws.getTree().sizes;
    const pair = sizes[0] + sizes[1];
    assert.ok(sizes[0] >= pair * 0.06 - 0.01, `左片保底 6%:${JSON.stringify(sizes)}`);
    assert.ok(sizes[1] >= pair * 0.06 - 0.01, '右片也保底');
    h.win.fire('pointerup', {});
});

test('双击分隔条:相邻两片回到默认宽度(236px),只动这两片', async () => {
    const h = await setup({ initialTree: flatTree([236, 700, 250]) });
    h.layout();
    const g = h.gutter('navResizer');
    h.win.fire('pointermove', { clientX: 400 });                    // 无拖动时移动不该改任何东西
    const before = h.ws.getTree().sizes.slice();
    assert.deepEqual(h.ws.getTree().sizes, before);
    // 先把它拖宽,再双击复位
    g.fire('pointerdown', { button: 0, clientX: 236, clientY: 300 });
    h.win.fire('pointermove', { clientX: 400, clientY: 300 });
    h.win.fire('pointerup', {});
    const dragged = h.ws.getTree();
    const draggedPair = dragged.sizes[0] + dragged.sizes[1];
    assert.ok(dragged.sizes[0] / draggedPair * 936 > 380, `拖宽了:${dragged.sizes[0]}`);
    h.layout(rect(0, 0, 1200, 600));                                // 重新按当前树量一遍
    g.fire('dblclick');
    const reset = h.ws.getTree();
    const pair = reset.sizes[0] + reset.sizes[1];
    assert.ok(Math.abs(reset.sizes[0] / pair * 936 - 236) < 1,
        `双击回到默认宽度 236px:${(reset.sizes[0] / pair * 936).toFixed(1)}px`);
    assert.equal(reset.sizes[2], before[2], '第三片不动');
    assert.equal(h.saved.length, 2, '拖动 + 双击各写一次');
});

test('键盘:分隔条 ←/→ 能调宽度(无障碍不该只靠鼠标),并落存档', async () => {
    const h = await setup({ initialTree: flatTree([236, 700, 250]) });
    h.layout();
    const g = h.gutter('navResizer');
    const before = h.ws.getTree().sizes.slice();
    g.fire('keydown', { key: 'ArrowRight' });
    const after = h.ws.getTree().sizes;
    assert.ok(after[0] > before[0], '往右推 = 左边那片变宽');
    assert.equal(after[2], before[2], '第三片不动');
    assert.equal(h.saved.length, 1, '键盘调完落一次');
    g.fire('keydown', { key: 'a' });
    assert.deepEqual(h.ws.getTree().sizes, after, '别的键不管');
});

// ---------- 重置 / 存档 ----------

test('重置:回到初始树(默认布局)并写一次存档', async () => {
    const h = await setup();
    // 先真的改动一次布局(拖一枚标签:把 ai 并进 links)
    dragTab(h, 'ai', 0, { x: 1050, y: 150 });
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'doc', 'links']);
    const beforeReset = h.saved.length;
    h.resetBtn.fire('click');
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'doc', 'links', 'ai']);
    assert.equal(h.ws.getTree().dir, 'row');
    assert.equal(h.saved.length, beforeReset + 1, '重置也要落盘(下次打开还是默认)');
});

test('applyTree:「窗口」菜单那一格 = 外壳算好的树被原样渲染、且落盘一次', async () => {
    const h = await setup();
    // 先造出"某一格不在窗口里"的状态(用户把它的标签拖走之后整格被摘掉就是这个形状)——
    // 「窗口」菜单里那一条正是为它准备的。
    const withoutAi = detach(h.ws.getTree(), 'ai').tree;
    h.ws.applyTree(withoutAi);
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'doc', 'links'], 'ai 那一格真的不在窗口里了');
    assert.equal(h.saved.length, 1, '换树要落盘(不然下次打开又回来了)');

    // 菜单那一条走的正是这两个纯函数:锚点旁边的右边新加一格。
    const next = addPane(h.ws.getTree(), 'ai', { anchorId: 'doc', dir: 'row', side: 'right' });
    h.ws.applyTree(next);
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'doc', 'ai', 'links'], '新格长在锚点右边');
    assert.equal(h.saved.length, 2, '第二次换树再落一次盘');
    h.layout();
    // 新格真的把面板本体搬进去了(渲染层"同一批节点"那条规矩在新路径上也成立)
    const body = h.byId('ai').querySelector('.pw-body');
    assert.equal(body.children[0], h.panels.ai);
    assert.equal(h.panels.ai.parentElement, body);

    // 非法输入:不动树、不重画、更不写盘(菜单递上来的东西不许把布局搞坏)
    h.ws.applyTree('不是树');
    h.ws.applyTree(null);
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'doc', 'ai', 'links']);
    assert.equal(h.saved.length, 2);
});

test('★ mount:存档里是一棵**合并过**的树 → 必须照它渲染(叶子数少于视图数不是坏档)', async () => {
    // ⚠️ 这一条钉的是 §8 验收动作④ 的真根因:mount() 里原来还有一份 **v3 的判据**
    //    (`叶子 id 集合与 known 一一对应`),合并过的布局一定不满足它 ——
    //    于是"用户刚拖好的布局"在重启时被打回 initialTree(实测:合并 + 边缘拆分之后
    //    重启,布局整片丢失)。判据必须改成"每个视图都有标签实例"。
    const merged = split('row', [36, 31, 33], [
        pane('notes'),
        split('row', [51, 49], [pane('links'), pane('slot:1', [{ view: 'ai' }], 0)]),
        pane('ai', [{ view: 'doc', doc: '第一个笔记.md' }], 0),
    ]);
    const h = await setup({
        load: () => ({ ok: true, tree: merged }),
        initialTree: split('row', [50, 50], [pane('notes'), pane('doc')]),   // 外壳的初始树:与存档完全不同
    });
    const got = h.ws.getTree();
    assert.deepEqual(listPaneIds(got), ['notes', 'links', 'slot:1', 'ai'],
        '合并过的树被**原样**渲染(不是被打回外壳的初始树)');
    assert.deepEqual(findPane(got, 'slot:1').tabs, [{ view: 'ai' }], '并进去的那一枚在 slot:1 里');
    assert.deepEqual(findPane(got, 'ai').tabs, [{ view: 'doc', doc: '第一个笔记.md' }],
        'ai 那一格里装的是笔记正文(槽位 id 与视图名无关)');
    assert.deepEqual(got.sizes, [36, 31, 33], '比例一个字不动');
    // 反过来:读不懂的视图不再让整棵树作废,而是"过滤 + 收拢 + 把缺的视图补回来"
    //(v4 口径,见 panel-tree.js 的 readdMissingViews)。只要视图一个不少就算好档。
    const stranger = await setup({
        load: () => ({ ok: true, tree: split('row', [50, 50], [pane('notes'), pane('外人')]) }),
        initialTree: split('row', [50, 50], [pane('notes'), pane('doc')]),
    });
    const fixed = stranger.ws.getTree();
    assert.equal(listPaneIds(fixed).includes('外人'), false, '读不懂的那一格被丢掉');
    assert.deepEqual([...listPaneIds(fixed)].sort(), [...PANE_IDS].sort(), '四个视图一个不少');
    // "没存过 / 存档读坏了"(ok=false)时才用**外壳算好的初始树**(而不是模块默认树)
    const fresh = await setup({
        load: () => ({ ok: false, tree: null }),
        initialTree: split('row', [50, 50], [pane('notes'), pane('doc')]),
    });
    assert.deepEqual(listPaneIds(fresh.ws.getTree()), ['notes', 'doc'], 'ok=false → 保留外壳的初始树');
});

test('mount:存档里有一棵停靠过的树 → 就按它渲染;坏档 → 默认布局', async () => {
    const docked = dockBottom(defaultTree(), 'ai');
    const good = await setup({ load: () => ({ ok: true, tree: docked }) });
    assert.equal(good.ws.getTree().dir, 'col', '存档里的底栏被照原样渲染');
    assert.deepEqual(listPaneIds(good.ws.getTree()), ['notes', 'doc', 'links', 'ai']);

    const bad = await setup({ load: () => ({ ok: true, tree: split('row', [50, 50], [pane('notes'), pane('外人')]) }) });
    assert.deepEqual(listPaneIds(bad.ws.getTree()), ['notes', 'doc', 'links', 'ai']);
    assert.equal(bad.ws.getTree().dir, 'row');
});

test('mount:默认状态「不拖不动、不写存档」—— 挂载与重画只更新读数', async () => {
    const h = await setup();
    assert.equal(h.saved.length, 0, '挂载一个字节都不该写进存档');
    h.ws.render();
    assert.equal(h.saved.length, 0, '单纯重画也不写');
});

test('存档往返:拖动后的树被原样交给 store(而不是引用一份会被改的对象)', async () => {
    const h = await setup({ initialTree: flatTree([400, 500, 300]) });
    h.layout();
    // ① 落在自己那一格 = 没落点 → 不写盘
    dragTab(h, 'notes', 0, { x: 200, y: 300 });
    assert.equal(h.saved.length, 0, '落在自己身上等于没变,不写盘');

    // ② 真的合并一次(ai → links 的正文中央)
    dragTab(h, 'ai', 0, { x: 1050, y: 150 });
    assert.equal(h.saved.length, 1);
    const snapshot = JSON.stringify(h.saved[0]);
    // ③ 再做一次**边缘拆分**:把刚并进去的 ai 拖到 notes 的右边缘
    h.layout();
    dragTab(h, 'links', 1, { x: 890, y: 300 });
    assert.equal(JSON.stringify(h.saved[0]), snapshot, '上一次交出去的树没被后来的操作改掉');
    assert.equal(h.saved.length, 2, '第二次操作又落了一次盘');
});

// ---------- 标签结构(契约 v3)在真实加载路径上不许被抹掉 ----------
//
// 这一条走的是**真外壳的那条路**:store.load() → mount() 里那道"最后防线"
// (再跑一次 normalizeTree) → 渲染 → 拖动 → commit → store.save()。
// 只要其中任何一步"按 id 重建叶子",标签就在用户看不见的地方没了 ——
// 而树形、面板数量与存档里的比例全都对得上,断言照样是绿的。

test('★ 标签:store 里的标签结构穿过 mount 的归一化防线,拖动之后仍在(且写回 store)', async () => {
    const docTabs = [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }];
    const loaded = split('row', [19, 62, 19], [
        pane('notes'),
        pane('doc', docTabs, 1),
        split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
    ]);
    const h = await setup({ load: () => ({ ok: true, tree: loaded }) });
    // ① 加载:标签与活动标签都还在(挂载时还会再归一化一次,那一步最容易把它剥掉)
    const afterMount = h.ws.getTree();
    assert.deepEqual(findPane(afterMount, 'doc').tabs, docTabs, 'mount 之后标签还在');
    assert.equal(findPane(afterMount, 'doc').active, 1, '活动标签也还在');
    assert.equal(findPane(afterMount, 'notes').tabs.length, 1, '别的面板照旧单视图');

    // ② 拖**一枚标签**(真实交互路径:落点判定 → 改树 → 重画 → commit)
    h.layout();
    dragTab(h, 'notes', 0, { x: 1050, y: 150 });      // notes 那一枚并进 links
    assert.equal(h.saved.length, 1, '这一次拖动落了盘');
    assert.deepEqual(findPane(h.ws.getTree(), 'doc').tabs, docTabs, '拖动之后界面这棵树里标签还在(别的格子被并,它一点不动)');
    assert.deepEqual(findPane(h.ws.getTree(), 'links').tabs.map((t) => t.view), ['links', 'notes'],
        '并进去的那一枚在最前');
    // ③ 交给 store 的那棵树也带着标签(存档路径与内存路径必须一致)
    assert.deepEqual(findPane(h.saved[0], 'doc').tabs, docTabs, '写进 store 的树里标签也在');
    assert.equal(findPane(h.saved[0], 'doc').active, 1);
});

// ===========================================================================
// 标签条(第五轮):两段式 / 五条关闭入口 / 整格收起(不允许空面板) / 替换语义 / 最近关闭 / 快捷键
//
// 这一组跑的是**真渲染层**(替身 DOM),验的是"把指针与键盘翻译成调用"那一段接线 ——
// 真窗口里的读数(可用宽度、几何、真事件)在 electron/selftest.js 里另有一组。
// ===========================================================================

const tabsOf = (h, id) => h.ws.tabsOf(id);
const tabEls = (h, id) => h.byId(id).querySelectorAll('.pw-tab');
const stripOf = (h, id) => h.byId(id).querySelector('.pw-tabs');

test('标签条:≥220px 是胶囊(名字 + ×),<220px 整条换成「当前视图名 ∨」', async () => {
    const h = await setup();                       // 默认树:19 / 62 / 19
    h.layout();
    // ⚠️ 窄栏那条阈值按**实际可用宽度**算,所以这里显式摆出两档宽度(不靠默认比例碰运气:
    //    1200 窗口下默认左栏 225px 减去标签条 padding 恰好落在 220 以下 —— 那本身是个
    //    值得记下来的读数,但它不该决定这条用例的结论)。
    h.setPaneRect('notes', rect(0, 0, 400, 600));
    h.setPaneRect('links', rect(900, 0, 199, 600));
    const notes = stripOf(h, 'notes');
    assert.equal(notes.dataset.mode, 'capsule', '400px → 胶囊');
    assert.equal(stripOf(h, 'links').dataset.mode, 'dropdown', '199px → 下拉');
    // 胶囊:一个标签按钮(文字 + 文字 ×)、一个文字 ＋
    const tabs = tabEls(h, 'notes');
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].querySelector('.pw-tab-label').textContent, '笔记列表');
    assert.equal(tabs[0].querySelector('.pw-tab-x').textContent, '×');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(stripOf(h, 'notes').querySelector('.pw-tabs-add').textContent, '＋');
    // 悬停 title **永远**给全名
    assert.equal(tabs[0].title.startsWith('笔记列表'), true, tabs[0].title);
    // 一个图标都没有:标签条里不许出现 svg
    assert.equal(findAll(stripOf(h, 'notes'), (n) => n.tagName === 'SVG').length, 0);

    // 把 notes 那一栏挤到 220px 以下:整条换成下拉
    h.setPaneRect('notes', rect(0, 0, 200, 600));
    const narrow = stripOf(h, 'notes');
    assert.equal(narrow.dataset.mode, 'dropdown', '200px < 220px → 下拉');
    assert.equal(narrow.querySelector('.pw-tabs-cur').textContent, '笔记列表', '写的是**当前**视图名');
    assert.equal(narrow.querySelector('.pw-tabs-caret').textContent, '∨');
    assert.equal(tabEls(h, 'notes').length, 0, '下拉形态里不排标签');
    // 下拉里也有 ＋:空面板那句文案就是"点 ＋ 加一个",窄栏里没有它就等于无路可走
    assert.ok(narrow.querySelector('.pw-tabs-add'), '窄栏里 + 仍在');
    // 点开下拉 → 列出全部视图的全名
    narrow.fire('click');
    const menu = h.byId('notes').querySelector('.pw-menu');
    assert.ok(menu, '下拉点开了');
    const items = menu.querySelectorAll('.pw-menu-item');
    assert.equal(items.length, h.ws.paneIds().length, '每个视图一项');
    assert.equal(items.map((b) => b.textContent).some((t) => t.startsWith('· 笔记列表')), true,
        '已在面板里的那一个要标注');
});

test('标签条:＋ = 并列 —— 出视图菜单,选中就**追加**一个标签(不关掉现有的)', async () => {
    const h = await setup();
    h.layout();
    const before = tabsOf(h, 'links');
    assert.deepEqual(before.tabs, [{ view: 'links' }]);
    stripOf(h, 'links').querySelector('.pw-tabs-add').fire('click');
    const menu = h.byId('links').querySelector('.pw-menu');
    assert.ok(menu, '＋ 真的打开了视图菜单(不是"默默加下一个")');
    const aiItem = menu.querySelectorAll('.pw-menu-item').find((b) => b.dataset.viewId === 'ai');
    assert.ok(aiItem, '菜单里列着可加的视图');
    aiItem.fire('click');
    const after = tabsOf(h, 'links');
    assert.equal(after.tabs.length, 2, '并列:标签数 +1');
    assert.deepEqual(after.tabs, [{ view: 'links' }, { view: 'ai' }]);
    assert.equal(after.active, 1, '新加的成为当前标签');
    assert.equal(h.ws.getTree().children.length, 3, '顶层结构没动(面板数不变)');
    assert.equal(h.byId('links').querySelector('.pw-menu'), null, '选完菜单关掉');
});

test('标签条:五条关闭入口都真的能关(× / 中键 / 右键菜单 / Ctrl+W 与 Ctrl+Tab)', async () => {
    const twoTabs = () => split('row', [19, 62, 19], [
        pane('notes'),
        pane('doc', [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }], 0),
        split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
    ]);
    // ① ×
    let h = await setup({ load: () => ({ ok: true, tree: twoTabs() }) });
    h.layout();
    tabEls(h, 'doc')[1].querySelector('.pw-tab-x').fire('click');
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }], '× 关掉了第二个');
    assert.match(h.ws.notice()?.text ?? '', /已关闭/, '关掉之后给了可恢复的提示');
    // ② 中键
    h = await setup({ load: () => ({ ok: true, tree: twoTabs() }) });
    h.layout();
    tabEls(h, 'doc')[1].fire('auxclick', { button: 1 });
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }], '中键关掉了');
    // 左键(button 0)的 auxclick 不该关
    h = await setup({ load: () => ({ ok: true, tree: twoTabs() }) });
    h.layout();
    tabEls(h, 'doc')[1].fire('auxclick', { button: 0 });
    assert.equal(tabsOf(h, 'doc').tabs.length, 2, '左键不关');
    // ③ 右键菜单:关闭其他 / 关闭全部
    h = await setup({ load: () => ({ ok: true, tree: twoTabs() }) });
    h.layout();
    tabEls(h, 'doc')[0].fire('contextmenu', { clientX: 10, clientY: 10 });
    const ctx = h.byId('doc').querySelector('.pw-menu-ctx');
    assert.ok(ctx, '右键出菜单');
    const labels = ctx.querySelectorAll('.pw-menu-item').map((b) => b.textContent);
    assert.deepEqual(labels, ['关闭', '关闭其他', '关闭全部']);
    ctx.querySelectorAll('.pw-menu-item').find((b) => b.textContent === '关闭其他').fire('click');
    assert.equal(tabsOf(h, 'doc').tabs.length, 1, '关闭其他:只剩当前那一个');
    // 关闭全部 → **整格消失**(「不允许存在空面板」:规则落在 collapseIfEmpty 里;
    // ⚠️ 重画之后替身 DOM 的矩形要重新摆一遍,否则标签条量不到宽度)
    h.layout();
    assert.equal(tabsOf(h, 'doc').mode, 'capsule',
        `mode=${tabsOf(h, 'doc').mode} w=${h.byId('doc').rect.width} tabs=${JSON.stringify(tabsOf(h, 'doc').tabs)}`);
    tabEls(h, 'doc')[0].fire('contextmenu', {});
    h.byId('doc').querySelector('.pw-menu-ctx').querySelectorAll('.pw-menu-item')
        .find((b) => b.textContent === '关闭全部').fire('click');
    assert.equal(tabsOf(h, 'doc'), null, '关闭全部 → 那一格整格从树上消失(tabsOf 对不在树上的面板返回 null)');
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'links', 'ai'], '只剩三格');
    // 落盘的那棵树里也没有它 —— 外壳的「窗口」菜单正是按这棵树决定"打勾 / 点得动"
    assert.deepEqual(listPaneIds(h.saved[h.saved.length - 1]), ['notes', 'links', 'ai'],
        '写进 store 的树里也没有那一格');
    // ④ Ctrl+Tab 切下一个 + ⑤ Ctrl+W 关当前(快捷键作用在**焦点所在面板**,先把焦点给 doc)
    h = await setup({ load: () => ({ ok: true, tree: twoTabs() }) });
    h.layout();
    h.doc.activeElement = h.panels.doc;
    h.win.fire('keydown', { ctrlKey: true, key: 'Tab', shiftKey: false });
    assert.equal(tabsOf(h, 'doc').active, 1, 'Ctrl+Tab 切到下一个');
    h.win.fire('keydown', { ctrlKey: true, key: 'Tab', shiftKey: false });
    assert.equal(tabsOf(h, 'doc').active, 0, '再切一次循环回第一个');
    h.win.fire('keydown', { ctrlKey: true, key: 'w' });
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc', doc: '乙篇.md' }], 'Ctrl+W 关掉当前标签');
});

test('标签条:关掉某一格的**最后一枚** → 整格从树上消失,空出来的空间整块给左边的邻居', async () => {
    // 40 / 35 / 25 的三格横排:摘掉中间那格,左边那格接手 35 那一整份。
    // ⚠️ 读数在"detach 的 neighbor 量纲"这一轮**改回来过**:曾经断言 72 / 28,那是
    //    "摘完之后先把兄弟们按剩余比例放大、再把 35 加给邻居"的产物 —— 那条路径等于把
    //    腾出来的空间**发了两遍**,右侧的 links 也从 25 被撑到 28.49。规格 §4.3 第 6 条
    //    要的是"不改变未涉及分支的比例"、§7 第 2 条要的是"**只**把腾出空间给相邻槽位",
    //    所以正确读数是 notes 40+35=75、links 的 25 一个字不动(详见 panel-tree.js detach)。
    // ⚠️ 走 `initialTree` 而不是 `load`:这棵树只有三片,存档层会按"每个视图都要有标签实例"
    //    把缺的收编回来(见 normalizeTree 的 readdMissingViews),塞进 load 会多出一格。
    const three = () => split('row', [40, 35, 25], [pane('notes'), pane('doc'), pane('links')]);
    const h = await setup({ initialTree: three() });
    h.layout();
    h.ws.closeAllTabs('doc');
    const after = h.ws.getTree();
    assert.deepEqual(listPaneIds(after), ['notes', 'links'], 'doc 那一格从树上消失了(不允许空面板)');
    assert.equal(Math.round(after.sizes[0]), 75, '空间整块给**左边**的邻居(它接手了 35 那一份)');
    assert.equal(Math.round(after.sizes[1]), 25, '右侧那一格**一个字不动**(未被牵动)');
    assert.equal(Math.round(after.sizes.reduce((a, b) => a + b, 0)), 100, '每一层的比例和仍是 100');
    assert.equal(h.byId('doc'), null, 'DOM 里也没有那一格了');
    assert.equal(h.ws.tabsOf('doc'), null, '读数:这一格已经不在树上');
    assert.deepEqual(h.ws.recentsOf('doc'), [{ view: 'doc' }], '被关掉的标签仍留在这一格的「最近关闭」里');
    // 空面板占位不再出现在正常路径上(那是坏存档 / "只剩一格"的兜底)
    assert.equal(findAll(h.stack, (n) => n.classList.contains('pw-empty')).length, 0, '没有留空占位');
    // 落盘的那棵树同样没有它 —— 外壳的「窗口」菜单按这棵树决定"打勾 / 点得动"
    assert.deepEqual(listPaneIds(h.saved[h.saved.length - 1]), ['notes', 'links']);

    // 没有左边的邻居 → 整块给右边那一个(doc 35+40=75;links 的 25 仍未动)
    const h2 = await setup({ initialTree: three() });
    h2.layout();
    h2.ws.closeAllTabs('notes');
    const after2 = h2.ws.getTree();
    assert.deepEqual(listPaneIds(after2), ['doc', 'links']);
    assert.equal(Math.round(after2.sizes[0]), 75, '最左边那格没有左边 → 整块给右边(同一口径)');
    assert.equal(Math.round(after2.sizes[1]), 25, '更远的那一格不动');
    assert.equal(Math.round(after2.sizes.reduce((a, b) => a + b, 0)), 100);
});

test('标签条:**只剩一格**时关掉它的最后一枚 → 那一格仍然保留(工作区不能变成 0 格)', async () => {
    // ⚠️ 这是 collapseIfEmpty 里那条兜底:整棵树就是这一片时 `detach` 返回 `tree: null`,
    //    此时必须保留原来的树 —— 否则工作区会变成 0 格。留一个空占位。
    const solo = await setup({ initialTree: pane('ai') });
    solo.layout();
    solo.ws.closeAllTabs('ai');
    assert.deepEqual(tabsOf(solo, 'ai').tabs, [], '最后一枚标签关掉了');
    assert.deepEqual(listPaneIds(solo.ws.getTree()), ['ai'], '那一格还在(工作区不能变成 0 格)');
    const body = solo.byId('ai').querySelector('.pw-body');
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0].classList.contains('pw-empty'), true);
    assert.equal(body.children[0].textContent, EMPTY_PANE_HINT);
    // 空面板上按 Ctrl+W 不该出事
    solo.win.fire('keydown', { ctrlKey: true, key: 'w' });
    assert.deepEqual(tabsOf(solo, 'ai').tabs, []);
});

test('标签条:「最近关闭」—— 被关掉的进栈,Ctrl+Shift+T 恢复回来', async () => {
    // ⚠️ doc 那一格的第二枚标签刻意用**同一视图的另一篇文档**,而不是 `links` / `ai`:
    //    右边那一列里本来就有一格叫 links、一格叫 ai,同一枚实例出现在两格是 v4 的坏档
    //    (去重按"同名格优先"归位,doc 这里那一枚会被它自己的格子认领、doc 反而空掉),
    //    那样测的就不是「最近关闭」了。两篇不同文档是**合法**的多标签形态。
    const tree = split('row', [19, 62, 19], [
        pane('notes'),
        pane('doc', [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }], 1),
        split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
    ]);
    const h = await setup({ load: () => ({ ok: true, tree }) });
    h.layout();
    h.ws.closeTab('doc', 1);                       // 关掉「乙篇」那个标签
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }]);
    assert.deepEqual(h.ws.recentsOf('doc'), [{ view: 'doc', doc: '乙篇.md' }], '关掉的那个进了「最近关闭」');
    // 换一片面板:它自己那一份是空的(每个面板一份)
    assert.deepEqual(h.ws.recentsOf('links'), []);
    // 快捷键作用在「当前面板」上 —— 先把焦点放到 doc 那一片,再按 Ctrl+Shift+T
    h.doc.activeElement = h.panels.doc;
    h.win.fire('keydown', { ctrlKey: true, key: 'T', shiftKey: true });
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }],
        '恢复回来了');
    assert.equal(tabsOf(h, 'doc').active, 1, '恢复的那个成为当前标签');
    assert.deepEqual(h.ws.recentsOf('doc'), [], '恢复之后从栈里拿掉(不会一直恢复同一个)');
    // 「恢复」按钮与快捷键是同一条路
    h.ws.closeTab('doc', 1);
    const btn = h.byId('doc').querySelector('.pw-strip1-btn');
    assert.ok(btn, '提示条上有恢复按钮');
    btn.fire('click');
    assert.equal(tabsOf(h, 'doc').tabs.length, 2);
});

test('★ 点击打开 = 在目标面板里替换:只动「笔记正文」那一格,列表一个字节不动、面板数不变', async () => {
    const h = await setup();                        // 默认:notes=笔记列表,doc 是空的单视图
    h.layout();
    const before = h.ws.allTabs();
    const idsBefore = listPaneIds(h.ws.getTree());
    const r = h.ws.openView('doc', '甲篇.md');
    assert.equal(r.paneId, 'doc', '目标 = 有 doc 标签的那一片');
    const after = h.ws.allTabs();
    const changed = after.filter((x) => JSON.stringify(x.tabs) !== JSON.stringify(before.find((b) => b.paneId === x.paneId).tabs));
    assert.deepEqual(changed.map((x) => x.paneId), ['doc'], '只有 doc 那一格的标签变了');
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }]);
    assert.deepEqual(tabsOf(h, 'notes').tabs, [{ view: 'notes' }], '列表面板一个字不动');
    assert.deepEqual(listPaneIds(h.ws.getTree()), idsBefore, '面板总数不变');
    // 可撤销提示(单行那条)+ 撤销真的还原
    const notice = h.ws.notice();
    assert.equal(notice?.kind, 'toast');
    assert.match(notice.text, /已用「/);
    const undo = h.byId('doc').querySelector('.pw-strip1-btn');
    assert.equal(undo.textContent, '撤销');
    undo.fire('click');
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc' }], '撤销把原来那个标签放回来了');
    assert.deepEqual(h.ws.recentsOf('doc'), [], '撤销之后它不该还留在「最近关闭」里');

    // 第二次替换:被替换掉的那个进「最近关闭」,再点撤销 → 回到替换前的状态
    const r2 = h.ws.openView('doc', '甲篇.md');
    assert.deepEqual(r2.replaced, [{ view: 'doc' }]);
    assert.deepEqual(h.ws.recentsOf('doc'), [{ view: 'doc' }], '被替换的进「最近关闭」');
    h.byId('doc').querySelector('.pw-strip1-btn').fire('click');
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc' }]);
});

test('★ 同一篇文档已开在目标面板 → 只**激活**它,不替换(旁边的标签不许消失)', async () => {
    const tree = split('row', [19, 62, 19], [
        pane('notes'),
        pane('doc', [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }], 1),
        split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
    ]);
    const h = await setup({ load: () => ({ ok: true, tree }) });
    h.layout();
    const r = h.ws.openView('doc', '甲篇.md');       // 已经开着(下标 0)
    assert.equal(r.activated, true);
    assert.deepEqual(r.replaced, [], '没有标签被替换掉');
    assert.deepEqual(tabsOf(h, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }],
        '两个标签都在(只是把当前标签切过去了)');
    assert.equal(tabsOf(h, 'doc').active, 0);
    assert.equal(h.ws.notice(), null, '没替换就不该弹提示');
});

test('★ 快捷键作用在「焦点所在面板」:焦点在哪一片,Ctrl+W 就关那一片', async () => {
    const h = await setup();
    h.layout();
    // 让 doc 那一片"拿到焦点":activeElement 是它里面的编辑器元素
    const docEl = h.panels.doc;
    h.doc.activeElement = docEl;
    assert.equal(h.ws.currentPane(), 'doc', '当前面板 = 焦点所在');
    h.win.fire('keydown', { ctrlKey: true, key: 'w' });
    // ⚠️ doc 那一片只有一个标签 → 关掉它就是**整格消失**(不允许空面板),所以读的是"它不在了"
    assert.equal(tabsOf(h, 'doc'), null, '关的是 doc 那一片(它的最后一枚 → 整格消失)');
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'links', 'ai'], '别的格子一个都没少');
    assert.deepEqual(tabsOf(h, 'notes').tabs, [{ view: 'notes' }], 'notes 那一片没被动');

    // 没有焦点 → 退回**鼠标所在**那一片
    const h2 = await setup();
    h2.layout();
    h2.doc.activeElement = null;
    h2.doc.elementFromPoint = () => h2.byId('links');
    h2.desk.fire('pointermove', { clientX: 1100, clientY: 200 });
    assert.equal(h2.ws.currentPane(), 'links', '没有焦点 → 鼠标所在');
    h2.win.fire('keydown', { ctrlKey: true, key: 'w' });
    assert.equal(tabsOf(h2, 'links'), null, '关的是鼠标所在那一片(它的最后一枚 → 整格消失)');
    assert.deepEqual(tabsOf(h2, 'ai').tabs, [{ view: 'ai' }], '别的没被动');
});

test('标签条:脏标签标 * ,关闭前**先问一句**(页内确认条,三个按钮),取消就什么都不做', async () => {
    const h = await setup({
        load: () => ({
            ok: true, tree: split('row', [19, 62, 19], [
                pane('notes'),
                pane('doc', [{ view: 'doc', doc: '甲篇.md' }], 0),
                split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
            ]),
        }),
        isTabDirty: (tab) => tab.view === 'doc' && tab.doc === '甲篇.md',
    });
    h.layout();
    assert.equal(tabEls(h, 'doc')[0].classList.contains('pw-tab-dirty'), true, '脏标签带标记');
    tabEls(h, 'doc')[0].querySelector('.pw-tab-x').fire('click');
    assert.equal(tabsOf(h, 'doc').tabs.length, 1, '先问,不直接关');
    const btns = h.byId('doc').querySelectorAll('.pw-strip1-btn');
    assert.deepEqual(btns.map((b) => b.textContent), ['保存并关闭', '直接关闭', '取消']);
    // 取消 → 一个字节都没变
    btns.find((b) => b.textContent === '取消').fire('click');
    assert.equal(tabsOf(h, 'doc').tabs.length, 1);
    assert.equal(h.ws.notice(), null);
    // 直接关闭 → 真的关
    tabEls(h, 'doc')[0].querySelector('.pw-tab-x').fire('click');
    h.byId('doc').querySelectorAll('.pw-strip1-btn').find((b) => b.textContent === '直接关闭').fire('click');
    // ⚠️ doc 那一片只有这一个标签 → 确认关闭之后**整格消失**(不允许空面板)
    assert.equal(tabsOf(h, 'doc'), null, '确认之后才关,而且关掉最后一枚 = 整格消失');
    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'links', 'ai'], '只剩三格');
});

test('标签条:onActivateTab 只在**真的换了**当前标签时通知一次(不重复轰外壳)', async () => {
    const calls = [];
    const h = await setup({
        load: () => ({
            ok: true, tree: split('row', [19, 62, 19], [
                pane('notes'),
                pane('doc', [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }], 0),
                split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
            ]),
        }),
        onActivateTab: (tab, paneId) => calls.push([paneId, tab.doc ?? tab.view]),
    });
    h.layout();
    await Promise.resolve();
    const first = calls.length;
    h.ws.activateTab('doc', 0);              // 本来就是 0 → 不通知
    assert.equal(calls.length, first, '同一个标签不重复通知');
    h.ws.activateTab('doc', 1);
    assert.deepEqual(calls[calls.length - 1], ['doc', '乙篇.md'], '换了才通知,而且带上是哪一篇');
    // 关掉当前那个 → 顺延出来的新当前标签也要通知
    h.ws.closeTab('doc', 1);
    assert.deepEqual(calls[calls.length - 1], ['doc', '甲篇.md']);
});




















// ---- 「窗口」菜单那条"开着但藏着"的路:把某格里的非活动标签切到眼前 ----
// 实测故障:一格塞着「笔记列表 / AI 会话 / 短剧项目」,当前显示第三个 —— 菜单给笔记列表打了勾
// 却点不动,用户的原话是"笔记列表呢"。菜单现在把这一条做成**可点**,回调走的就是 focusView。
test('★ focusView:把某格里的**非活动标签**切到眼前;没开的视图返回 false(调用方据此新加一格)', async () => {
    const tree = split('row', [500, 500], [
        pane('notes', [{ view: 'notes' }, { view: 'links' }], 1),   // 链接显示着,笔记列表藏着
        pane('doc'),
    ]);
    const h = await setup({ initialTree: tree });
    assert.equal(h.ws.tabsOf('notes').active, 1, '前置:这会儿显示的是"链接"');
    assert.equal(h.ws.tabsOf('notes').tabs.map((t) => t.view).join(','), 'notes,links');

    assert.equal(h.ws.focusView('notes'), true, '找到了装着它的那一格');
    assert.equal(h.ws.tabsOf('notes').active, 0, '笔记列表被切到了眼前');
    assert.equal(h.ws.tabsOf('notes').tabs.length, 2, '只是切标签,一枚都没多');

    // 已经看得见时:空操作(不抛、不改、也不多开)
    assert.equal(h.ws.focusView('notes'), true);
    assert.equal(h.ws.tabsOf('notes').active, 0);
    assert.equal(h.ws.tabsOf('notes').tabs.length, 2);

    // 根本没开着的视图 → false,调用方(main.js 的 onAddPanel)据此走"新加一格"
    assert.equal(h.ws.focusView('drama'), false);
    // 非法入参也不抛(菜单那一侧传来的东西不能直接信)
    assert.equal(h.ws.focusView(''), false);
    assert.equal(h.ws.focusView(null), false);
});

test('mount:存档缺少已知的可选工具视图时,工作台不将它自动补回', async () => {
    const optionalId = 'tool:palette:palette';
    const h = await setup({
        load: () => ({ ok: true, tree: defaultTree() }),
        extraPanes: { [optionalId]: { title: '调色板 & 渐变', optional: true } },
        requiredIds: ['notes', 'doc', 'links', 'ai'],
    });

    assert.deepEqual(listPaneIds(h.ws.getTree()), ['notes', 'doc', 'links', 'ai']);
    assert.equal(h.byId(optionalId), null);
    assert.equal(h.panels[optionalId].parentElement, null, '未打开的工具宿主不挂入 DOM');
});
