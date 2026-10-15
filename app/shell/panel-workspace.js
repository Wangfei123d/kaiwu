// 平铺可停靠面板的**渲染层**(工作台)。
//
// 规格是已批准的那份交接单(单标签即面板的 Premiere 式停靠),这里只做三件事:
//   ① 把布局树画成 flex 的 DOM(比例走 flex-grow,所以窗口缩放也成立);
//   ② 把真实的指针动作翻译成树的变化(拖分隔条 / **拖一枚标签**的四种落点);
//   ③ 松手才写存档。
//
// 数学一条都不在这里 —— 全在 app/lib/panel-tree.js(纯函数、可单测)。
// 这一层只碰 DOM,`doc` / `win` 都从外面注入,于是单元测试可以给替身。
//
// ⚠️ 这个仓库踩过的坑(两次),这里都刻意避开了:
//   ① **CSS 命中"被搬走的元素"**:面板是从 #paneNotes 搬进树里的**同一批节点**。
//      所以本模块不用 `display:none` 藏任何空壳,新样式也一律用直接子元素
//      限定(见 panel-workspace.css 顶部)。上一次"藏空壳"把搬进新容器的编辑器
//      也一起藏了,面板一片空白 —— 而所有结构断言都是绿的。
//   ② **flex 子项必须 min-width:0 / min-height:0**:否则内容会把面板撑破再被裁掉。
//      CSS 里 .pw-node / .pw-leaf / .pw-pane / .pw-body 每一个都写了。
//
// 关于键盘:容器 `role="region"` + `aria-label`(名字取**当前标签**),
// 分隔条是 `role="separator"` + `tabindex="0"` 且能用方向键调。
// **面板的"搬家"只支持指针**(拖一枚标签)—— 这条如实写在报告里。
//
// ---- 第六轮:只拖一枚标签(规格 §1 / §4)----
// 本轮的**核心删除**:`bindPaneDrag()` 与 `dragId` 那条"拖整片容器"的路径**整条删掉**了
// (连同它的 `applyDrop` / `swapPanes` / `dropOnEdge` / `dockBottom` 入口)。
// 规格 §1.2 禁止用标题栏 / 抓手 / 标签条空白 / 任何"整组面板"来移动或交换布局 ——
// 而且明确要求"不得仅仅在视觉上隐藏抓手而保留事件"。所以:
//   · 抓手 ⠿ 与条上空白仍然**显示**(保留这一行的视觉语言与面板尺寸角标的悬停区),
//     但它们**不再启动任何拖动**,也不再可聚焦、不再向读屏宣告(见 renderLeaf);
//   · 唯一的拖动起点是 `.pw-tab`(宽布局)与 `.pw-tabs-cur`(窄布局下拉);
//   · 落点由 `tabDropZoneAt()` 认**整个 `.pw-pane`**(不再只认 `.pw-tabs`),
//     判定顺序照规格 §4.2:标签条 > 四边 28px 带 > 正文中央(追加)> 取消。
//
// ⚠️ 落点判定里"标签条优先于顶部边缘带"是靠**先量 `.pw-tabs` 的矩形**做到的:
//    条就在这一格顶上那一条,先判它,用户把标签放到标签条上就永远不会被误判成
//    "插到目标上方"。文件名 docs/kaiwu-single-tab-dock-demo.html 里那份行为模型
//    是同一个顺序(它的读数留档在 docs/kaiwu-single-tab-dock-readings.txt)。

import {
    MIN_RATIO, defaultTree, cloneTree, isPane, isSplit, listPaneIds, normalizeTree, tabKey,
    findPane, pathTo, nodeAtPath, formatTree, validateLayout,
    setPairRatio, pairSizesFromPx, pairSizesFromDrag,
    detach, moveTabToPane, moveTabToEdge,
} from '../lib/panel-tree.js';
// 标签页那一层(纯函数):两段式 + 三级缩写、关闭/替换/最近关闭都在那里。
import {
    stripMode, chooseLevels, tabLabel, estimateTextWidth, useTabKey,
    addTab, openInPane, activateTab, nextTab, closeTab, closeOthers, closeAll,
    appendTabs, replaceTabs, findTab, updatePane, createRecent, panesWithView, RECENT_MAX,
} from '../lib/panel-tabs.js';

// 标签身份 = 视图 + 文档实例。**唯一实现**在 panel-tree.js,这里只是把它接进来 ——
// 本模块再写一份的话,"同一篇笔记只开一个标签"迟早会在两条路径上给出不同答案。
useTabKey(tabKey);

/** 三个**文字字符**(不是图标:整页 svg 计数必须保持 0)—— 关闭 / 加 / 下拉。 */
export const TAB_CHAR_CLOSE = '×';      // U+00D7
export const TAB_CHAR_ADD = '＋';        // U+FF0B
export const TAB_CHAR_CARET = '∨';       // U+2228

/** 标签多到这个数以上,末尾给一个"更多 N"计数(设计稿的阈值就是 4)。 */
export const MORE_THRESHOLD = 4;

/**
 * 空面板那句占位文案。
 *
 * ⚠️ 正常操作**走不到这里**:「不允许存在空面板」—— 某一格的最后一枚被关掉/搬走之后
 * 整格都会消失(见 collapseIfEmpty)。这段占位只降级成两种兜底的显示:
 * 坏存档里本来就带着空叶子,以及"整棵树只剩这一格"时不许把它也摘掉。
 */
export const EMPTY_PANE_HINT = '这个面板还没有视图 —— 点 ＋ 加一个';

/** 标签条自己的左右 padding(与 CSS 里 .pw-tabs 一致;量不到真实宽度时的兜底要用它)。 */
export const TAB_STRIP_PADDING_PX = 6;

/**
 * 落点命中的**边缘带**宽度(像素,规格 §4.2 / demo 里的 `BAND = 28`)。
 *
 * ⚠️ 与 `DEFAULT_EDGE` 是**两套**口径,别互相替代:
 *   · `DEFAULT_EDGE` 是"拖**整片面板**"时代按**比例**算边缘的旧口径,只留给
 *     `zoneAt()` 那条只读兼容口(自检/老测试还在读它);
 *   · 真正的标签投放走 `DEFAULT_EDGE_BAND_PX` —— **固定像素**,因为面板宽度可以
 *     从 200px 到 1500px,28% 在宽面板上会吃掉整个正文,用户根本落不到"中央追加"。
 */
export const DEFAULT_BAND_PX = 34;      // 窗口最底部那条带的高度(demo 是 34px;v4 起已不用)
export const DEFAULT_EDGE_BAND_PX = 28; // 标签投放的边缘带(规格 §4.2 / demo 的 BAND)
export const DEFAULT_EDGE = 0.28;       // 旧口径:整片面板边缘 28% 之内算"插到那一侧"(只读兼容)
export const TAB_DRAG_THRESHOLD_PX = 4; // 走够这么多像素才算"拖"(规格 §4.1:不足则仍是点击)
export const GUTTER_PX = 7;             // 分隔条厚度(与 CSS 里 .pw-gutter 一致)
export const KEY_STEP_PX = 16;          // 键盘一次调多少(与旧 col-resizer 一致)

function el(doc, tag, className) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
}

/**
 * @param {object} p
 * @param {object} p.doc / p.win       注入(单测给替身)
 * @param {object} p.desk              工作台容器(提示浮层的定位基准,position:relative)
 * @param {object} p.stack             树的宿主
 * @param {object} [p.hintEl]          落点提示(四边那半侧高亮 / 中央那整格描边)
 * @param {object} [p.bandEl]          ⚠️ 底部带**已删**(规格 §4 末尾:那条手势要么只接受
 *                                     单标签、要么删掉;产品侧选了删除)。参数保留是为了
 *                                     不破坏既有调用方的签名,传进来也只当不存在。
 * @param {object} [p.treeEl]          布局树文本(用户要看的那份"证据")
 * @param {object} [p.resetBtn]        「重置布局」
 * @param {object} [p.host]            #paneNotes:挂 pw-host 类、清掉旧的像素分隔条
 * @param {Object<string,{title:string, fullTitle?:string, el:object}>} p.panes 真实面板:id → 标题 + 元素
 *        (fullTitle 是标题栏放不下时挂在悬停提示里的全称)
 * @param {object|null} [p.store]      panel-layout-store 实例(松手才写)
 * @param {Array<{id?:string, after?:string, before?:string, defaultPx?:number, which?:0|1}>} [p.gutters]
 *        旧分隔条的兼容规则:id = 这个分隔条挂哪个 id;after / before = 它贴着哪个
 *        面板;defaultPx = 双击复位到多少像素(旧的"双击回到 236 / 240"就是它);
 *        which = 双击时**哪一侧**回到 defaultPx(0 左 / 1 右,默认按 after/before 推)
 * @param {object|null} [p.initialTree] 初始树(main.js 用旧的像素宽度算出来,保证默认外观不变)
 * @param {string[]} [p.requiredIds] 布局完整性所需的视图;默认全部 panes key(兼容旧调用方)
 * @param {(tree:object, info:{persist:boolean})=>void} [p.onLayout] 提交回调
 * @param {(tab:object,paneId:string)=>string} [p.viewTitle] 标签**全名**(笔记标签用笔记标题)
 * @param {(tab:object,paneId:string)=>string} [p.viewShort] 第三级缩写的文本(设计稿那份 笔/正/剧/链/AI)
 * @param {(tab:object,paneId:string)=>void} [p.onActivateTab] 某个标签成为当前标签(外壳据此把
 *        对应的视图内容装上 —— 例如把笔记正文那个编辑器切到 tab.doc 那一篇)
 * @param {(tab:object)=>boolean} [p.isTabDirty] 这个标签有没有未保存的改动(脏标记 + 关前先问)
 * @param {(tab:object)=>any} [p.onSaveTab] 脏确认里选"保存并关闭"时调它
 */
export function createPanelWorkspace({
    doc = globalThis.document,
    win = globalThis.window,
    desk,
    stack,
    hintEl = null,
    bandEl = null,                     // ⚠️ 已不用:底部带手势按规格删掉了(见 createPanelWorkspace 的注释)
    treeEl = null,
    resetBtn = null,
    host = null,
    panes = {},
    requiredIds = null,
    store = null,
    gutters = [],
    initialTree = null,
    minRatio = MIN_RATIO,
    bandPx = DEFAULT_BAND_PX,          // ⚠️ 已不用(同上);保留参数以免旧调用方解构不到
    edgeBandPx = DEFAULT_EDGE_BAND_PX,
    edge = DEFAULT_EDGE,               // ⚠️ 旧口径,只给 zoneAt() 那个只读兼容口用
    keyStepPx = KEY_STEP_PX,
    onLayout = null,
    viewTitle = null,
    viewShort = null,
    onActivateTab = null,
    isTabDirty = null,
    onSaveTab = null,
    log = console,
}) {
    const titles = {};
    for (const id of Object.keys(panes)) titles[id] = panes[id]?.title ?? id;

    /**
     * 一个**槽位**的显示名(规格 §6:按**活动标签**算,不看 `node.id`)。
     *
     * ⚠️ 为什么不能再直接查 `titles[id]`:`titles` 是按**视图名**建的(notes/doc/links/ai/…),
     *    而 v4 起槽位 id 只是"槽位键"—— 边缘拆分出来的新格子叫 `slot:<序号>`,与视图名
     *    无关(规格 §3)。查 `titles['slot:1']` 得到 undefined,于是底部那行布局树读数、
     *    "从哪一格搬到这一格"的提示、视图菜单里的"（在「…」）"全都会把**裸 id** 印给用户,
     *    而那行读数正是用户与自检共用的"证据"(§8 验收④要用户从它上面看出比例/顺序/前景
     *    标签都还在)。所以统一走这一个口子:活动标签的标题 → 槽位名(老档的 id 与视图同名,
     *    读数因此与从前逐字一致) → 兜底才是 id。
     */
    function slotLabel(id) {
        // ⚠️ 顺序要紧:**先看活动标签**。槽位 id 可能**碰巧**等于某个视图名(初始布局
        //    就是这样:notes / doc / links / ai),但它上面挂的标签是别的视图时(把「笔记
        //    正文」并进 ai 那一格),名字必须跟着**前景面板**走,否则读数说「AI 对话」而
        //    用户眼睛看到的是笔记正文 —— 规格 §6 要的正是"按活动标签而不是 node.id"。
        const tab = activeTabOf(findLeaf(id));
        if (tab !== null) {
            const byTab = titles[tab.view];
            if (typeof byTab === 'string' && byTab !== '') return byTab;
        }
        // 读不出活动标签(空槽位 / 未知视图)才退回槽位自己的名字,再不行才用 id。
        return (typeof titles[id] === 'string' && titles[id] !== '') ? titles[id] : id;
    }

    /** 这棵树里每个槽位的显示名(底部那行读数与 `text()` 共用同一份)。 */
    function treeLabels() {
        const labels = {};
        for (const id of listPaneIds(tree)) labels[id] = slotLabel(id);
        return labels;
    }

    let tree = cloneTree(initialTree) ?? defaultTree();
    let mounted = false;
    let interacted = false;            // 存档还没读回来用户就动过手 → 不要覆盖他的意图
    let bodies = new Map();            // pane id → .pw-body
    let paneEls = new Map();           // pane id → .pw-pane
    let sizeEls = new Map();           // pane id → .pw-size
    let tabRefs = [];                  // 每次渲染重建:每片叶子的 { node, pane, strip, body }
    let ariaRefreshers = [];           // 每次渲染重建:分隔条 aria 的刷新函数
    // ---- 标签条那几件状态 ----
    let currentPaneId = null;          // 「当前面板」= 焦点所在;没有焦点时退回鼠标所在(见 currentPane())
    let lastMouse = { x: 0, y: 0 };     // 鼠标最后停在哪(快捷键 7 的兜底判据)
    const recents = createRecent();     // 每个面板一份「最近关闭」
    let popup = null;                   // 当前打开的那个浮层:{ kind, paneId, el }
    let notice = null;                  // 面板底部那条:最近关闭 / 可撤销提示 / 脏确认
    let noticeTimer = null;
    let pendingAsk = null;              // 脏确认:等用户点一个按钮
    const disposers = [];

    function listen(target, type, fn, opts) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, fn, opts);
        disposers.push(() => target.removeEventListener(type, fn, opts));
    }

    // ---- 渲染:树 → DOM。比例用 flex-grow,所以窗口缩放也成立 ----

    function render() {
        bodies = new Map();
        paneEls = new Map();
        sizeEls = new Map();
        tabRefs = [];
        ariaRefreshers = [];
        const root = renderNode(tree);
        root.style.flex = '1 1 0%';                        // 根节点铺满 .pw-stack
        stack.replaceChildren(root);
        // 每一格的内容 = 这一格**活动标签**对应的那个视图元素(同一批节点,只是换了容器)。
        // ⚠️ 从前这里是按 pane id 找元素 —— 有了标签之后 id 不再等于视图:
        // 一个面板里可以放「笔记正文」+「链接」两个标签,内容由**活动标签的 view** 决定。
        const placed = new Set();
        for (const ref of tabRefs) {
            const tab = activeTabOf(ref.node);
            if (tab === null) {
                // 空面板:占位一句,面板本身留下(位置尺寸是用户拖出来的,不该因为没内容就消失)
                ref.body.replaceChildren(emptyPlaceholder());
                continue;
            }
            const live = panes[tab.view]?.el;
            if (!live) { ref.body.replaceChildren(unknownViewPlaceholder(tab)); continue; }
            placed.add(tab.view);
            ref.body.replaceChildren(live);                  // 一个 body 里永远只有一个孩子
        }
        // 没有任何标签在用它的视图:元素**离开文档**(而不是 display:none ——
        // 那条路这个仓库踩过:藏空壳会连搬进去的真面板一起藏掉)。
        for (const id of Object.keys(panes)) {
            if (placed.has(id)) continue;
            const live = panes[id]?.el;
            if (live?.parentElement) live.parentElement.removeChild(live);
        }
        paintStrips();
        refresh();
    }

    function renderNode(node) {
        if (isPane(node)) return renderLeaf(node);
        const box = el(doc, 'div', `pw-node pw-${node.dir}`);
        const kids = node.children.map((child) => renderNode(child));
        kids.forEach((childEl, i) => {
            childEl.style.flex = `${node.sizes[i]} 1 0%`;
            box.appendChild(childEl);
            if (i < kids.length - 1) {
                box.appendChild(renderGutter(node, i, childEl, kids[i + 1]));
            }
        });
        return box;
    }

    function renderLeaf(node) {
        const leaf = el(doc, 'div', 'pw-leaf');
        const pane = el(doc, 'section', 'pw-pane');
        // ⚠️ v4:`node.id` 是**槽位 id**(可能叫 `slot:3`),不再是视图名。
        //    这一个属性是"这一格是谁"的机器可读身份,落点判定与读数都用它;
        //    给人看的名字一律取**当前标签**(见 paintStrip)。
        pane.dataset.paneId = node.id;
        // 容器:role=region。⚠️ aria-label **不在这里写** —— 面板自己没有名字,
        // 名字全是标签的(属性由标签页继承),所以由 paintStrip 按"当前那一枚标签"写。
        pane.setAttribute('role', 'region');

        // ⚠️ 面板标题栏**已取消**(原来 .pw-head + .pw-name 那一行):
        //    容器没有名字可写,留着它必然和下面的胶囊重名 ——
        //    标题写「笔记列表」、胶囊又写一遍「笔记列表」,这是用户截图里的原始缺陷。
        //    顶上唯一那一行就是标签条;落在胶囊上就是"这一枚标签的事"。
        const strip = el(doc, 'div', 'pw-tabs');
        strip.dataset.paneTabs = node.id;

        // ⚠️ 抓手 / 条上空白 / 尺寸角标**只造一次**:paintStrip 每次都会
        //    `strip.replaceChildren()`,这三个节点要复用 —— 否则监听会随重画越挂越多
        //    (标签条上踩过同一个坑:一次点击开出两个菜单)。
        //
        // ⚠️ 抓手 ⠿ 与条上空白**不再启动任何拖动**(规格 §1.2,本轮把整条手势删掉了)。
        //    为什么还留着它们、而不是从 DOM 里删掉:
        //      · 条上空白是这一行唯一的"喘息位"—— 删了它,标签会紧贴 ＋ 挤在一起,
        //        而且 `.pw-size`(尺寸角标)是**绝对定位在条里**的,它需要这段空白当视觉底座;
        //      · 抓手是这一行的视觉语言(用户已经认得的"这一格"标记),突然消失会被当成 bug。
        //    所以它们只**显示**、不响应指针、不进 Tab 序、也不向读屏报名字:
        //    一个"看着能拖、其实不能"的键盘可达控件比不显示更糟(读屏用户会反复按它)。
        const grip = el(doc, 'span', 'pw-grip');
        grip.textContent = '⠿';
        grip.setAttribute('aria-hidden', 'true');
        grip.title = '这一格的标记(拖动请拖标签;整片拖动已取消)';
        const pad = el(doc, 'span', 'pw-grabpad');
        pad.setAttribute('aria-hidden', 'true');
        const size = el(doc, 'span', 'pw-size');

        const body = el(doc, 'div', 'pw-body');
        body.dataset.paneBody = node.id;
        pane.append(strip, body);
        leaf.appendChild(pane);

        bodies.set(node.id, body);
        paneEls.set(node.id, pane);
        sizeEls.set(node.id, size);
        tabRefs.push({ node, pane, strip, body, bound: [], grip, pad, size });
        // ⚠️ 这里**没有** bindPaneDrag(整片拖动那条路按规格删掉了)。
        // 「当前面板」= 焦点/鼠标所在的那一片:快捷键都作用在它身上(实测那几条在自检里)。
        // ⚠️ 用 `on` 而不是 `listen`:pane 每次重画都是**新节点**,不需要(也不该)登记解绑。
        on(pane, 'pointerdown', () => { currentPaneId = node.id; });
        on(pane, 'focusin', () => { currentPaneId = node.id; });
        return leaf;
    }

    /**
     * 往**标签条本体**上挂监听 —— 必须先登记再挂,重画时按这份清单摘掉。
     *
     * ⚠️ 踩过:标签条的**子节点**每次重画都被换掉(监听跟着节点一起走),但标签条
     * 自己是复用同一个节点的(`replaceChildren` 只换孩子)。于是每重画一次就多挂一个
     * click —— 实测(替身 DOM 探针)一次点击开出**两个**菜单,而且面板每改一次大小
     * 就多一个。所以标签条自己的监听必须记在 ref.bound 里,重画前先摘干净。
     */
    function bindStrip(ref, type, fn) {
        ref.bound = Array.isArray(ref.bound) ? ref.bound : [];
        ref.bound.push([type, fn]);
        ref.strip?.addEventListener?.(type, fn);
    }

    function unbindStrip(ref) {
        for (const [type, fn] of ref.bound ?? []) ref.strip?.removeEventListener?.(type, fn);
        ref.bound = [];
    }

    // -----------------------------------------------------------------------
    // 标签条:画出来 + 五条关闭入口 + 点击打开的替换 + 最近关闭
    // -----------------------------------------------------------------------

    /**
     * ⚠️ 标签条内部的监听一律用这个(不登记 disposer)。
     *
     * 理由:标签条的 DOM 每次重画都**整片重建**,旧节点会被丢掉;而 `listen()` 会把
     * 每个监听记进 disposers —— 面板一改变大小就重画一次,用 listen 会攒出成百上千个
     * 早就没用的解绑函数(而且解绑的是已经不在文档里的节点)。窗口/document 那一层的
     * 监听才用 `listen()`(它们只注册一次,必须解绑)。
     */
    function on(target, type, fn) {
        target?.addEventListener?.(type, fn);
    }

    /** 这一片叶子的活动标签(空面板返回 null)。 */
    function activeTabOf(node) {
        const tabs = Array.isArray(node?.tabs) ? node.tabs : [];
        if (tabs.length === 0) return null;
        const i = Number.isInteger(node.active) && node.active >= 0 && node.active < tabs.length ? node.active : 0;
        return tabs[i];
    }

    /** 标签的**全名**:外壳能按标签给(笔记标签 = 笔记标题),没给就退回视图登记的名字。 */
    function tabTitle(tab, paneId = null) {
        if (typeof viewTitle === 'function') {
            const custom = viewTitle(tab, paneId);
            if (typeof custom === 'string' && custom !== '') return custom;
        }
        return panes[tab?.view]?.title ?? tab?.view ?? '';
    }

    /** 交给纯函数层的那一项:{ label, short }(short = 设计稿那份第三级缩写,可缺)。 */
    function tabItem(tab, paneId) {
        const label = tabTitle(tab, paneId);
        const curated = typeof viewShort === 'function' ? viewShort(tab, paneId) : panes[tab?.view]?.short;
        return (typeof curated === 'string' && curated !== '') ? { label, short: curated } : label;
    }

    /**
     * 量文字宽度:真身上用 canvas 实测(字体与 CSS 里那一条一致)。
     * 拿不到 canvas(单测的替身 DOM)时退回纯函数里的估算法 —— 级别只差整档,估错不会换级。
     */
    const measureText = (() => {
        try {
            const ctx = doc?.createElement?.('canvas')?.getContext?.('2d');
            if (!ctx) return (t) => estimateTextWidth(t);
            ctx.font = '11.5px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
            return (t) => ctx.measureText(String(t)).width;
        } catch {
            return (t) => estimateTextWidth(t);
        }
    })();

    /**
     * 面板 **padding 之后**的可用宽度(产品负责人明确要求的口径:不是面板外宽)。
     * 真身上量标签条的 clientWidth 再减掉它自己的左右 padding;
     * 量不到(首帧 / 单测的替身 DOM)就退回**面板**的宽度减掉标签条两边那点 padding。
     */
    function usableWidthOf(strip, pane) {
        const cw = Number(strip?.clientWidth);
        if (Number.isFinite(cw) && cw > 0) {
            const cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(strip) : null;
            const pl = Number.parseFloat(cs?.paddingLeft) || 0;
            const pr = Number.parseFloat(cs?.paddingRight) || 0;
            return Math.max(0, cw - pl - pr);
        }
        const r = strip?.getBoundingClientRect?.();
        if (r && Number.isFinite(r.width) && r.width > 0) return r.width;
        const pr2 = pane?.getBoundingClientRect?.();
        return pr2 && Number.isFinite(pr2.width) ? Math.max(0, pr2.width - TAB_STRIP_PADDING_PX * 2) : 0;
    }

    /** 重画所有标签条(宽度变了 → 形态与缩写级别都可能变)。 */
    function paintStrips() {
        for (const ref of tabRefs) paintStrip(ref);
    }
    function paintStrip(ref) {
        const { node, pane, strip } = ref;
        const tabs = Array.isArray(node.tabs) ? node.tabs : [];
        const usable = usableWidthOf(strip, pane);
        // ⚠️ 量不到宽度(usable = 0)不等于"这一格很窄":工作台藏在笔记视图里,切到设置视图
        //    (或刚挂载、还没布局)时每一格的 clientWidth 都是 0。这时如果照 0 去判形态,
        //    整条会降到「当前视图名 ∨」—— 而隐藏期间**不会**有人再重画第二次,于是用户切
        //    回来看到的是一条**没有标签的空条**,连 × / 中键 / 右键菜单三个关闭入口都不存在。
        //    (自检实测:整段标签条断言在 tabs[-1] 上抛掉,而根因只是"重画发生在隐藏期间"。)
        //    所以量不到就**沿用上一次的形态** —— 它是在可见时算出来的,比 0 可信。
        const mode = usable > 0 ? stripMode(usable) : (strip.dataset.mode ?? stripMode(0));
        // ⚠️ 重画之前先把**标签条自己**上一轮挂的监听摘掉(见 bindStrip 的注释)
        unbindStrip(ref);
        strip.dataset.mode = mode;
        strip.replaceChildren();
        // ⚠️ 抓手挂在最前面只是为了保住这一行的视觉语言(它**不响应指针**,见 renderLeaf)。
        //    只造一次、每次重画再挂回(见 renderLeaf 的注释:否则监听越挂越多)。
        strip.append(ref.grip);
        if (mode === 'dropdown') {
            // < 220px:整条换成「当前视图名 ∨」下拉(点开是全名列表)
            const tab = activeTabOf(node);
            const label = tab === null ? '（空）' : tabTitle(tab, node.id);
            const cur = el(doc, 'span', 'pw-tabs-cur');
            cur.textContent = label;
            cur.title = label;
            // ⚠️ 窄布局里 `.pw-tabs-cur` 代表**当前活动标签** —— 它就是这一形态下唯一的
            //    拖动起点(规格 §4.1)。不接上这一条的话,"面板窄了就再也拖不动标签",
            //    用户会以为窄栏把功能弄丢了。
            const idx = Number.isInteger(node.active) && node.active >= 0 && node.active < tabs.length ? node.active : 0;
            if (tab !== null) {
                cur.title = `${label}(拖动可以把这一枚标签停靠到别处)`;
                cur.setAttribute('aria-label', `${label}:当前标签,可拖动`);
                on(cur, 'pointerdown', (e) => {
                    e?.stopPropagation?.();          // 别让下面的"点开下拉"也吃到这一下
                    startTabDrag(e, node.id, idx, cur);
                });
            }
            const caret = el(doc, 'span', 'pw-tabs-caret');
            caret.textContent = TAB_CHAR_CARET;
            caret.setAttribute('aria-hidden', 'true');
            strip.append(cur, caret);
            strip.title = '点开:全部视图的文字列表';
            bindStrip(ref, 'click', () => togglePopup('views', node.id, strip));
        } else {
            const items = tabs.map((t) => tabItem(t, node.id));
            const levels = chooseLevels(items, usable, measureText);
            tabs.forEach((tab, i) => strip.append(makeTabButton(node, tab, i, items[i], levels[i])));
            if (tabs.length > MORE_THRESHOLD) {
                // ⚠️ 设计稿里的"更多 N"只是个 say() 占位(点不动)。这里让它真的能点开
                // —— 否则标签一多,后面的标签会被 overflow 藏掉而且没有出路。
                const more = el(doc, 'button', 'pw-tabs-more');
                more.type = 'button';
                more.textContent = `更多 ${tabs.length - MORE_THRESHOLD}`;
                more.title = '标签多于 4 个:点开看全部';
                on(more, 'click', (e) => { e?.stopPropagation?.(); togglePopup('views', node.id, more); });
                strip.append(more);
            }
        }
        // 条上空白:夹在标签与 ＋ 之间。⚠️ v4 起它**不启动任何拖动**(整片拖动已删),
        // 留着它是这一行的喘息位 + 尺寸角标的视觉底座(见 renderLeaf 的注释)。
        strip.append(ref.pad);
        // 尺寸角标同样只造一次,重画时挂回原位(绝对定位,不参与排版)
        strip.append(ref.size);
        strip.append(makeAddButton(node));
        // ⚠️ 面板自己没有名字了,读屏的名字取**当前那一枚标签** ——
        //    这就是"属性由标签页继承"在无障碍上的同一条规矩(空容器就直说它是空的)。
        const activeNow = activeTabOf(node);
        const activeName = activeNow === null ? '' : String(tabTitle(activeNow, node.id) ?? '');
        pane.setAttribute('aria-label', activeName === '' ? '空容器(还没有标签)' : `${activeName}(当前标签)`);
    }

    // ---- 拖**一枚标签**到别的面板上(规格 §4:按胶囊中线定插入位,竖线指示)----
    //
    // ⚠️ 本轮之后这里**是唯一**的拖动路径:整片容器那条(`bindPaneDrag` + `dragId` +
    //    `applyDrop`)已经按规格 §1.2 整条删掉。所以下面的判定不再需要"与整格拖动分开"。
    // 仍然保留那道"走够 4px 才算拖"的门:没走够就当成普通点击(点标签 = 切换)。
    let tabDrag = null;

    function tabInsertIndex(strip, x) {
        const chips = [...(strip?.querySelectorAll?.('.pw-tab') ?? [])];
        for (let i = 0; i < chips.length; i += 1) {
            const r = chips[i].getBoundingClientRect?.();
            if (r && x < r.left + r.width / 2) return i;
        }
        return chips.length;                 // 落在最后一枚右边 = 追加到末尾
    }

    /**
     * 指针落在哪(规格 §4.2 的判定顺序,一字不差):
     *
     *   1. 目标 `.pw-tabs` 里 → `{ kind:'stack', slotId, insertAt }`(按胶囊中线算插入位);
     *   2. 目标面板外沿的四个边缘带(固定 `edgeBandPx` 像素)→ `{ kind:'edge', slotId, side }`;
     *   3. 其余正文中央 → `{ kind:'stack', slotId, insertAt:null }`(追加到末尾并激活);
     *   4. 没命中任何 `.pw-pane` → `null`(取消,不改布局)。
     *
     * ⚠️ 第 1 步**必须**排在"上边缘带"前面:标签条就在面板顶上那一条,两个矩形是重叠的 ——
     *    先判边缘带的话,用户把标签放到标签条上会被判成"插到目标上方",凭空劈出一格。
     * ⚠️ 它认的是**整个 `.pw-pane`**,不再是旧版那个只认 `.pw-tabs` 的实现:
     *    "拖到正文中央"与"拖到右边"都得由它给出落点。
     *
     * 只读:不改树、不碰 DOM(预览由 previewTabDrop 画)。
     */
    function tabDropZoneAt(x, y, fromSlotId = null) {
        const under = doc.elementFromPoint?.(x, y);
        const pane = under?.closest?.('.pw-pane') ?? null;
        if (!pane) return null;
        const slotId = pane.dataset?.paneId ?? null;
        if (slotId === null || slotId === '') return null;
        const paneRect = pane.getBoundingClientRect?.();
        if (!paneRect || !(paneRect.width > 0) || !(paneRect.height > 0)) return null;
        // ① 标签条优先
        const strip = pane.querySelector?.('.pw-tabs') ?? null;
        const stripRect = strip?.getBoundingClientRect?.();
        if (strip && stripRect && y >= stripRect.top && y <= stripRect.bottom
            && x >= stripRect.left && x <= stripRect.right) {
            return { kind: 'stack', slotId, insertAt: tabInsertIndex(strip, x) };
        }
        // ② 四边带(固定像素 —— 比例口径在宽面板上会把整个正文吃光)
        const band = Math.max(1, Number(edgeBandPx) || DEFAULT_EDGE_BAND_PX);
        if (x - paneRect.left <= band) return { kind: 'edge', slotId, side: 'left' };
        if (paneRect.right - x <= band) return { kind: 'edge', slotId, side: 'right' };
        if (y - paneRect.top <= band) return { kind: 'edge', slotId, side: 'top' };
        if (paneRect.bottom - y <= band) return { kind: 'edge', slotId, side: 'bottom' };
        // ③ 正文中央 = 追加到那个栈末尾并激活
        return { kind: 'stack', slotId, insertAt: null };
    }

    /** 清理所有临时类 / 插入线 / 预览(取消或投放之后都必须调用,规格 §6)。 */
    function clearTabDrop() {
        tabDrag = null;
        for (const s of (desk.querySelectorAll?.('.pw-tabs') ?? [])) {
            s.classList?.remove?.('pw-tabs-drop');
            const c = s.querySelector?.('.pw-tab-caret');
            if (c?.style) c.style.display = 'none';
        }
        for (const p of (desk.querySelectorAll?.('.pw-pane') ?? [])) p.classList?.remove?.('pw-pane-drop');
        for (const t of (desk.querySelectorAll?.('.pw-tab-dragging') ?? [])) t.classList?.remove?.('pw-tab-dragging');
        hintEl?.classList?.remove?.('pw-on');
        bandEl?.classList?.remove?.('pw-on');
    }

    /**
     * 画落点预览(三种,与行为模型 demo 一致):
     *   · `stack` 落在标签条 → 整条点亮 + 一条**竖向插入线**标出会插到第几个;
     *   · `stack` 落在正文中央 → 整格描边(表示"并进这个栈");
     *   · `edge` → 目标的那**半侧**高亮。
     * 返回落点(拿不到就 null)。预览只是显示:树在松手之前一个字都不动。
     */
    function previewTabDrop(x, y) {
        clearTabDropPreview();
        if (tabDrag === null) return null;
        const zone = tabDropZoneAt(x, y, tabDrag.fromId);
        if (zone === null || zone.slotId === tabDrag.fromId) return null;   // 落在自己身上 = 没落点
        const pane = paneEls.get(zone.slotId);
        if (!pane) return null;
        const wrap = desk.getBoundingClientRect?.() ?? { left: 0, top: 0 };
        const r = pane.getBoundingClientRect?.();
        if (!r) return null;
        if (zone.kind === 'edge') {
            // 半边高亮:直接用现成的 hint 浮层(它的定位基准是 .pw-desk)
            const half = r.width * 0.5;
            const halfH = r.height * 0.5;
            const box = zone.side === 'left' ? { left: r.left - wrap.left + 2, top: r.top - wrap.top + 2, width: half, height: r.height - 4 }
                : zone.side === 'right' ? { left: r.left - wrap.left + r.width * 0.5 - 2, top: r.top - wrap.top + 2, width: half, height: r.height - 4 }
                    : zone.side === 'top' ? { left: r.left - wrap.left + 2, top: r.top - wrap.top + 2, width: r.width - 4, height: halfH }
                        : { left: r.left - wrap.left + 2, top: r.top - wrap.top + r.height * 0.5 - 2, width: r.width - 4, height: halfH };
            if (hintEl?.style) {
                hintEl.style.left = `${box.left}px`;
                hintEl.style.top = `${box.top}px`;
                hintEl.style.width = `${box.width}px`;
                hintEl.style.height = `${box.height}px`;
                hintEl.classList?.add?.('pw-on');
            }
            return zone;
        }
        // stack:整格描边;落在标签条上时再点亮那一条并画出插入线
        pane.classList?.add?.('pw-pane-drop');
        const strip = pane.querySelector?.('.pw-tabs') ?? null;
        if (strip) {
            strip.classList?.add?.('pw-tabs-drop');
            const onStrip = zone.insertAt !== null;
            const chips = [...(strip.querySelectorAll?.('.pw-tab') ?? [])];
            let caret = strip.querySelector?.('.pw-tab-caret');
            if (onStrip && (caret === null || caret === undefined)) {
                // 竖线按需创建:标签条每次重画都会换掉孩子,所以不能指望它一直在
                caret = el(doc, 'span', 'pw-tab-caret');
                strip.appendChild?.(caret);
            }
            if (caret?.style) {
                if (!onStrip) { caret.style.display = 'none'; }
                else {
                    const at = Math.max(0, Math.min(zone.insertAt, chips.length));
                    const base = strip.getBoundingClientRect?.();
                    const anchor = chips.length === 0 ? null
                        : (at < chips.length ? chips[at].getBoundingClientRect?.() : chips[chips.length - 1].getBoundingClientRect?.());
                    if (base) {
                        const px = anchor === null ? base.left + 6 : (at < chips.length ? anchor.left - 2 : anchor.right + 1);
                        caret.style.left = `${Math.round(px - base.left)}px`;
                        caret.style.display = 'block';
                    }
                }
            }
        }
        return zone;
    }

    /** 只清预览(不动 `tabDrag`):拖动过程中每一帧都先清再画。 */
    function clearTabDropPreview() {
        for (const s of (desk.querySelectorAll?.('.pw-tabs') ?? [])) {
            s.classList?.remove?.('pw-tabs-drop');
            const c = s.querySelector?.('.pw-tab-caret');
            if (c?.style) c.style.display = 'none';
        }
        for (const p of (desk.querySelectorAll?.('.pw-pane') ?? [])) p.classList?.remove?.('pw-pane-drop');
        hintEl?.classList?.remove?.('pw-on');
    }

    /**
     * 真的落下去:改树 → 重画 → 落盘(源槽位空了由纯函数一并摘掉)。
     *
     * ⚠️ 中央/标签条 `insertAt: null` 是**合法**落点(规格 §4.2 第 3 条:追加到末尾并激活),
     *    旧实现在这里写的是 `at.insertAt === null → return`,那条判据把"拖到正文中央"
     *    整条路堵死了 —— 本轮修掉。
     * ⚠️ 一次拖动里"预览"画过好几帧,落点在这里**重算一遍**(不信任最后一帧的缓存):
     *    松手那一下的坐标才是真的。
     */
    function finishTabDrag(x, y) {
        const d = tabDrag;
        const zone = d === null ? null : tabDropZoneAt(x, y, d.fromId);
        clearTabDrop();
        if (d === null || zone === null || zone.slotId === d.fromId) return;   // 没落点 / 落在自己身上 → 取消
        const next = zone.kind === 'edge'
            // 边缘:只搬这一枚标签,给它新建一个槽位(规格 §4.3)
            ? moveTabToEdge(tree, d.fromId, d.index, zone.slotId, zone.side)
            // 标签条 / 正文中央:并进目标槽位,按插入位排列并设为最前
            : moveTabToPane(tree, d.fromId, d.index, zone.slotId, zone.insertAt, { space: 'neighbor' });
        if (next === null) return;                       // 参数不成立 → 树、活动标签、存档都不变
        tree = next;
        render();
        commit();
    }

    function makeTabButton(node, tab, index, item, level) {
        const active = Number.isInteger(node.active) && node.active >= 0 && node.active < (node.tabs ?? []).length
            ? node.active : 0;
        const on_ = index === active;
        const b = el(doc, 'button', 'pw-tab');
        b.type = 'button';
        b.dataset.tabIndex = String(index);
        b.setAttribute('aria-selected', String(on_));
        if (on_) b.classList.add('pw-tab-on');
        const dirty = isTabDirty ? isTabDirty(tab) === true : false;
        if (dirty) b.classList.add('pw-tab-dirty');
        const text = el(doc, 'span', 'pw-tab-label');
        text.textContent = tabLabel(item, level);
        const x = el(doc, 'span', 'pw-tab-x');
        x.textContent = TAB_CHAR_CLOSE;
        x.title = '关闭这个标签';
        x.setAttribute('aria-hidden', 'true');
        // 悬停 title **永远**给全名(缩写只改显示、不改身份)
        const full = tabTitle(tab, node.id);
        b.title = `${full}${dirty ? '(有未保存的改动)' : ''}(中键关闭 · 右键菜单 · Ctrl+W)`;
        b.append(text, x);
        on(b, 'click', (e) => {
            if (e?.target === x) return;                 // × 自己那条路
            activatePaneTab(node.id, index);
        });
        on(x, 'click', (e) => { e?.stopPropagation?.(); requestClose(node.id, index); });
        on(b, 'auxclick', (e) => { if (e.button === 1) { e.preventDefault?.(); requestClose(node.id, index); } });
        on(b, 'contextmenu', (e) => { e.preventDefault?.(); openPopup('ctx', node.id, b, index); });
        // ⚠️ 胶囊上按下 = **拖这一枚标签**(规格 §4.1:这是宽布局里唯一的拖动起点)。
        //    保留"走够 4px 才算拖"的门 —— 没走够就什么都不做,让 click 去切换标签。
        on(b, 'pointerdown', (e) => startTabDrag(e, node.id, index, b, x));
        return b;
    }

    /**
     * 一次**单标签拖动**的开始(规格 §4.1:宽布局拖 `.pw-tab`,窄布局拖 `.pw-tabs-cur`)。
     *
     * `pill` 是那个"按下时被抓住的元素"(胶囊,或窄布局里的当前标签文字);
     * 它在整个拖动中半透明(规格 §6),`exclude` 是要让开的子元素(胶囊上的 ×)。
     */
    function startTabDrag(e, slotId, index, pill, exclude = null) {
        if (e.button !== undefined && e.button !== 0) return;
        if (exclude !== null && e.target === exclude) return;      // × 自己那条路
        const sx = e.clientX ?? 0;
        const sy = e.clientY ?? 0;
        let moved = false;
        const move = (ev) => {
            const cx = ev.clientX ?? 0;
            const cy = ev.clientY ?? 0;
            if (!moved) {
                if (Math.abs(cx - sx) + Math.abs(cy - sy) < TAB_DRAG_THRESHOLD_PX) return;   // 还只是"点了一下"
                moved = true;
                tabDrag = { fromId: slotId, index };
                pill?.classList?.add?.('pw-tab-dragging');
            }
            previewTabDrop(cx, cy);
        };
        const up = (ev) => {
            win?.removeEventListener?.('pointermove', move);
            win?.removeEventListener?.('pointerup', up);
            win?.removeEventListener?.('pointercancel', cancel);
            // 走够了才落;没走够 = 还只是"点了一下",交给 click 去切换标签
            if (moved) finishTabDrag(ev?.clientX ?? 0, ev?.clientY ?? 0);
            else clearTabDrop();
        };
        /**
         * 取消(规格 §6:"取消或投放后清理全部临时类")。
         *
         * ⚠️ 必须与 `pointerup` **分开**:两者原来共用一个处理器,于是"拖到一半被系统
         *    取消"会当成一次正常投放落下去 —— 树被改了,而用户根本没松手。
         *    取消的定义就是"什么都没发生":不落点、不改树、不写存档,只把临时类收干净。
         */
        const cancel = () => {
            win?.removeEventListener?.('pointermove', move);
            win?.removeEventListener?.('pointerup', up);
            win?.removeEventListener?.('pointercancel', cancel);
            clearTabDrop();
        };
        win?.addEventListener?.('pointermove', move);
        win?.addEventListener?.('pointerup', up);
        win?.addEventListener?.('pointercancel', cancel);
    }

    function makeAddButton(node) {
        const plus = el(doc, 'button', 'pw-tabs-add');
        plus.type = 'button';
        plus.textContent = TAB_CHAR_ADD;
        plus.title = '加一个视图(并列:不关掉现有的标签)';
        plus.setAttribute('aria-label', '加一个视图');
        on(plus, 'click', (e) => { e?.stopPropagation?.(); togglePopup('views', node.id, plus); });
        return plus;
    }

    function findLeaf(paneId) {
        const leaf = findPane(tree, paneId);
        return isPane(leaf) ? leaf : null;
    }

    // ---- 浮层(点 ＋ / 窄栏下拉 / 右键菜单都是同一个东西) ----

    function closePopup() {
        popup?.el?.remove?.();
        popup = null;
    }

    function togglePopup(kind, paneId, anchor, index = null) {
        const reopen = !(popup !== null && popup.kind === kind && popup.paneId === paneId);
        closePopup();
        if (reopen) openPopup(kind, paneId, anchor, index);
    }

    function openPopup(kind, paneId, anchor, index = null) {
        const pane = paneEls.get(paneId);
        if (!pane) return;
        const box = el(doc, 'div', kind === 'ctx' ? 'pw-menu pw-menu-ctx' : 'pw-menu');
        box.dataset.paneMenu = paneId;
        box.setAttribute('role', 'menu');
        box.title = '';
        const item = (label, fn, extra = null) => {
            const b = el(doc, 'button', 'pw-menu-item');
            b.type = 'button';
            b.textContent = label;
            b.setAttribute('role', 'menuitem');
            if (extra) b.dataset.menuRole = extra;
            on(b, 'click', () => { closePopup(); fn(); });
            return b;
        };
        if (kind === 'ctx') {
            box.append(
                item('关闭', () => requestClose(paneId, index), 'close'),
                item('关闭其他', () => requestCloseOthers(paneId, index), 'close-others'),
                item('关闭全部', () => requestCloseAll(paneId), 'close-all'),
            );
        } else {
            // 视图菜单:**列出可加的视图**,已经在面板里的要标注(产品负责人拍的那条)
            const here = new Set((findLeaf(paneId)?.tabs ?? []).map((t) => t.view));
            for (const view of Object.keys(panes)) {
                const elsewhere = here.has(view) ? [] : panesWithView(tree, view).filter((id) => id !== paneId);
                const where = elsewhere.length > 0 ? `（在「${slotLabel(elsewhere[0])}」）` : '';
                const label = `${here.has(view) ? '·' : TAB_CHAR_ADD} ${panes[view]?.title ?? view}${where}`;
                const b = item(label, () => requestAdd(paneId, view), 'view');
                b.dataset.viewId = view;
                if (here.has(view)) b.classList.add('pw-menu-here');
                box.append(b);
            }
        }
        pane.appendChild(box);
        popup = { kind, paneId, el: box };
    }

    // ---- 底部那条(最近关闭 / 可撤销提示 / 脏确认):**一律单行** ----

    function clearNotice() {
        if (noticeTimer !== null) {
            const off = win?.clearTimeout ?? globalThis.clearTimeout;
            try { off?.(noticeTimer); } catch { /* 拿不到定时器也不该抛 */ }
            noticeTimer = null;
        }
        notice?.el?.remove?.();
        notice = null;
    }

    function showNotice(paneId, spec) {
        clearNotice();
        const pane = paneEls.get(paneId);
        if (!pane) return;
        const bar = el(doc, 'div', `pw-strip1 pw-strip1-${spec.kind}`);
        bar.dataset.paneNotice = paneId;
        const txt = el(doc, 'span', 'pw-strip1-text');
        // ⚠️ 单行:文字省略号、按钮 flex:none(CSS)。窄栏里换行会被当成 bug(设计稿自己标的)
        txt.textContent = spec.text;
        txt.title = spec.text;
        bar.append(txt);
        for (const btn of spec.buttons ?? []) {
            const b = el(doc, 'button', 'pw-strip1-btn');
            b.type = 'button';
            b.textContent = btn.label;
            if (btn.role) b.dataset.noticeRole = btn.role;
            on(b, 'click', () => btn.onClick?.());
            bar.append(b);
        }
        pane.appendChild(bar);
        notice = { paneId, el: bar, kind: spec.kind };
        if (spec.autoHideMs) {
            const after = win?.setTimeout ?? globalThis.setTimeout;
            try { noticeTimer = after?.(() => clearNotice(), spec.autoHideMs) ?? null; } catch { noticeTimer = null; }
        }
    }

    /** 这一片的标签全名列表(脏确认文案里用得上)。 */
    function labelList(tabs, paneId) {
        return tabs.map((t) => `「${tabTitle(t, paneId)}」`).join('、');
    }

    // ---- 动作:关闭 / 添加 / 激活 / 替换 / 恢复 ----

    /** 脏 → 先问一句(页内确认条;绝不用 window.confirm —— 那会卡住自检)。 */
    function askDirty(paneId, action) {
        pendingAsk = { paneId, action };
        showNotice(paneId, {
            kind: 'ask',
            text: `${labelList([action.tab], paneId)}有未保存的改动 —— 要保存吗?`,
            buttons: [
                {
                    label: '保存并关闭',
                    role: 'save',
                    onClick: async () => {
                        const a = pendingAsk;
                        pendingAsk = null;
                        try { await onSaveTab?.(a?.action?.tab); } catch (err) { log?.warn?.('[layout] 保存标签内容失败', err); }
                        if (a) commitAsk(a);
                    },
                },
                { label: '直接关闭', role: 'discard', onClick: () => { const a = pendingAsk; pendingAsk = null; if (a) commitAsk(a); } },
                { label: '取消', role: 'cancel', onClick: () => { pendingAsk = null; clearNotice(); } },
            ],
        });
    }

    function commitAsk({ paneId, action }) {
        clearNotice();
        if (action.kind === 'close') doClose(paneId, action.index);
        else if (action.kind === 'replace') doOpen(action.tab, { paneId, prev: action.prev, prevActive: action.prevActive });
    }

    /**
     * 这一格**空了就摘掉整格**,空间给邻居(方案 B:整块给相邻那一格);没空则原样返回。
     *
     * ⚠️ 「不允许存在空面板」这条规则就落在这里,而且只有这一处 ——
     * 关掉最后一枚(× / 中键 / Ctrl+W / 右键那三条)与**搬走最后一枚标签**最终都汇到它。
     * 之前那条相反的产品决定("关到最后一个留空占位、格子不收起")已作废。
     * 空面板的占位渲染保留着,但降级成**兜底**:坏存档本来就带着空叶子、
     * 以及"整棵树只剩这一格"时不许把它摘掉(见下面那一行 detach 的返回值)。
     *
     * ⚠️ 查这一格**必须**用 `findPane(t, paneId)`(形参里的树 t),**不能**用上面那个
     *    `findLeaf(paneId)` —— 后者只收**一个**参数、而且闭包读的是**模块级的 `tree`**,
     *    所以 `findLeaf(t, paneId)` 会把 `t`(一个对象)当成 paneId 去查那棵旧树:
     *    必然查不到 → 条件恒真 → 原样返回,`detach` 一辈子走不到。
     *    这条路曾经**整条是死的**(关掉最后一枚从不收起),根因就在这里。
     */
    function collapseIfEmpty(t, paneId) {
        if (findPane(t, paneId)?.tabs?.length !== 0) return t;
        const out = detach(t, paneId, { space: 'neighbor' });
        // ⚠️ 整棵树只剩这一格时 `detach` 按契约返回 `tree: null` —— 此时**必须保留原来的树**:
        //    工作区不能变成 0 格,那一格留着当空占位(见 detach 的文档注释)。
        return out === null || out.tree === null ? t : out.tree;
    }

    function requestClose(paneId, index) {
        closePopup();
        const tab = findLeaf(paneId)?.tabs?.[index];
        if (tab === undefined) return;
        if (isTabDirty?.(tab) === true) { askDirty(paneId, { kind: 'close', index, tab }); return; }
        doClose(paneId, index);
    }

    function doClose(paneId, index) {
        const r = closeTab(tree, paneId, index);
        if (r.closed === null) return;
        recents.push(paneId, r.closed);
        tree = r.tree;
        tree = collapseIfEmpty(tree, paneId);
        render();
        // ⚠️ 不用为"这一格可能已经消失"加守卫:notifyActivated 对缺失的面板本来就是空的
        //    (findLeaf → null → key 为 ''、不回调)。加了守卫反而会让 lastActive 停在上一次的值。
        notifyActivated(paneId);
        commit();
        // 「最近关闭」是这套 UX 的安全网:关掉谁都要给一条能按回去的路
        showNotice(paneId, {
            kind: 'recent',
            text: `已关闭「${tabTitle(r.closed, paneId)}」`,
            buttons: [{ label: '恢复', role: 'restore', onClick: () => restoreRecent(paneId) }],
            autoHideMs: 8000,
        });
    }

    function requestCloseOthers(paneId, index) {
        closePopup();
        const tabs = findLeaf(paneId)?.tabs ?? [];
        const dirty = tabs.some((t, i) => i !== index && isTabDirty?.(t) === true);
        if (dirty) { askDirty(paneId, { kind: 'closeOthers', index, tab: tabs[index] }); return; }
        doCloseOthers(paneId, index);
    }

    function doCloseOthers(paneId, index) {
        const r = closeOthers(tree, paneId, index);
        if (r.closed.length === 0) return;
        recents.pushAll(paneId, r.closed);
        tree = r.tree;
        tree = collapseIfEmpty(tree, paneId);
        render();
        notifyActivated(paneId);
        commit();
        showNotice(paneId, {
            kind: 'recent',
            text: `已关闭其它 ${r.closed.length} 个标签`,
            buttons: [{ label: '恢复', role: 'restore', onClick: () => restoreRecent(paneId) }],
            autoHideMs: 8000,
        });
    }

    function requestCloseAll(paneId) {
        closePopup();
        const tabs = findLeaf(paneId)?.tabs ?? [];
        if (tabs.some((t) => isTabDirty?.(t) === true)) {
            askDirty(paneId, { kind: 'closeAll', index: -1, tab: tabs.find((t) => isTabDirty?.(t) === true) ?? tabs[0] });
            return;
        }
        doCloseAll(paneId);
    }

    function doCloseAll(paneId) {
        const r = closeAll(tree, paneId);
        if (r.closed.length === 0) return;
        recents.pushAll(paneId, r.closed);
        tree = r.tree;
        tree = collapseIfEmpty(tree, paneId);
        render();
        commit();
        showNotice(paneId, {
            kind: 'recent',
            text: `已关闭全部 ${r.closed.length} 个标签`,
            buttons: [{ label: '恢复', role: 'restore', onClick: () => restoreRecent(paneId) }],
            autoHideMs: 8000,
        });
    }

    function requestAdd(paneId, view) {
        closePopup();
        const r = addTab(tree, paneId, { view });
        if (r.tree === tree) return r;
        tree = r.tree;
        render();
        notifyActivated(paneId);
        commit();
        if (r.movedFrom !== null && r.movedFrom !== paneId) {
            // 搬家这件事用户必须看得见(视图只有一份 DOM,不可能同时在两格)
            showNotice(paneId, {
                kind: 'recent',
                text: `「${panes[view]?.title ?? view}」从「${slotLabel(r.movedFrom)}」搬到了这一格`,
                buttons: [],
                autoHideMs: 6000,
            });
        }
        return r;
    }

    function activatePaneTab(paneId, index) {
        closePopup();
        const leaf = findLeaf(paneId);
        if (leaf === null) return;
        if (leaf.active === index) { notifyActivated(paneId); return; }
        tree = activateTab(tree, paneId, index);
        render();
        notifyActivated(paneId);
        commit();
    }

    function nextPaneTab(paneId) {
        const leaf = findLeaf(paneId);
        if (leaf === null || leaf.tabs.length < 2) return;
        tree = nextTab(tree, paneId);
        render();
        notifyActivated(paneId);
        commit();
    }

    /**
     * 把某个**已经开着**的视图切到眼前(它可能只是某格里的**非活动标签** —— 用户看不见它)。
     *
     * ⚠️ 为什么要单独一个口,而不是复用 `openView`:`openView` 会**保证**那枚标签存在 ——
     *    对「笔记正文」这种"标签身份含文档路径"的视图,`openView('doc')` 拿到的是
     *    `{view:'doc'}`(**没带文档**),和我们想"把用户正开着的那篇正文切到前面"是两回事。
     *    这里只做一件事:找到装着这个视图的那一格 → 激活它那一枚标签。
     * @returns {boolean} 找到了并已激活
     */
    function focusView(view) {
        if (typeof view !== 'string' || view === '') return false;
        const ids = panesWithView(tree, view);
        for (const paneId of ids) {
            const leaf = findLeaf(paneId);
            const index = (leaf?.tabs ?? []).findIndex((t) => t?.view === view);
            if (index < 0) continue;
            activatePaneTab(paneId, index);
            return true;
        }
        return false;
    }

    /**
     * 恢复这一格「最近关闭」里**最近一个还没开着**的标签。
     *
     * ⚠️ 为什么不能"拿栈顶那一条 `addTab` 一下就算恢复" —— 那是本轮修掉的一个真缺陷:
     *    栈顶可能**已经开在这一格里**了(实测路径:把它关掉 → 又用 ＋ /「打开视图」
     *    把它加回来;`addView` 只往 `tabs` 里加,不会顺手清掉「最近关闭」里那条旧的)。
     *    这时 `addTab` 走的是"同一个实例已经在本面板里开着 → **只激活**"那一条:
     *    它返回的是 `activateTab(...)` 的**新树**(引用换了)但**一枚标签都没多**。
     *    旧代码拿 `r.tree === tree` 当"恢复成功"的判据,于是:
     *      · 标签数没变(恢复动作等于什么都没做),
     *      · 却把那条最近关闭**白白吃掉**了(自检 ★④ 实测:标签与恢复前逐字相同,
     *        而 recents 少了一条)。
     *    现在认 `addTab` 自己的 `created` 标记:只有**真的多了一枚标签**才算成功;
     *    顺手把"已经开着"的那些陈旧条目清掉(它们不可能再被恢复),这样按一次
     *    Ctrl+Shift+T 一定落到一个看得见的结果上,也不会把栈堵死。
     */
    function restoreRecent(paneId) {
        for (const candidate of recents.list(paneId)) {
            const r = addTab(tree, paneId, candidate);
            recents.drop(paneId, candidate);       // 成功要从栈里拿掉;陈旧条目更要拿掉
            if (r.created !== true) continue;      // 只激活了已有的那枚 = 这条是陈旧的
            clearNotice();
            tree = r.tree;
            render();
            notifyActivated(paneId);
            commit();
            return candidate;
        }
        return null;
    }

    /**
     * **点击打开 = 在目标面板里替换**(产品负责人拍的那一条)。
     *
     * 目标面板的选择顺序:显式给的 → **当前**有 doc 标签的那一片(笔记正文的归宿)
     * → 当前面板 → 树里第一片。原标签全部交出来:进「最近关闭」+ 一条可撤销提示。
     */
    function openView(view, docPath = null, { paneId = null } = {}) {
        const target = paneId ?? paneHostingDocView(view) ?? currentPane() ?? listPaneIds(tree)[0];
        // 留痕:谁在切视图。这条线索是给"面板自己跳走了"那类问题准备的 ——
        // 现象是"拖个文件到画布上,工作台自动跳到笔记正文(编辑/预览)那一格",
        // 而调用方可能是三条路里的任意一条(行的 click、快捷键、插件),
        // 没有调用栈就只能猜。留痕失败绝不该影响开视图本身,所以整段裹在 try 里。
        try {
            const from = String(new Error().stack ?? '').split('\n').slice(1, 5).join(' <- ');
            const list = (globalThis.__kaiwuOpenViews ??= []);
            list.push({ view, doc: docPath ?? null, target: target ?? null, at: Date.now(), from });
            if (list.length > 40) list.shift();
            console.info(`[openView] ${view}${docPath === null ? '' : ` · ${docPath}`} → ${target} ← ${from}`);
        } catch { /* 留痕失败就跳过 */ }
        if (target === null || target === undefined) return { paneId: null, activated: false, replaced: [] };
        const tab = (typeof docPath === 'string' && docPath !== '') ? { view, doc: docPath } : { view };
        return doOpen(tab, { paneId: target });
    }

    function paneHostingDocView(view) {
        const ids = panesWithView(tree, view);
        return ids.length > 0 ? ids[0] : null;
    }

    function doOpen(tab, { paneId, prev = null, prevActive = 0 }) {
        const before = findLeaf(paneId);
        const prevTabs = prev ?? (before?.tabs ?? []).slice();
        const prevIdx = prevActive ?? (before?.active ?? 0);
        const r = openInPane(tree, paneId, tab);
        if (r.tree === tree) { notifyActivated(paneId); return { paneId, activated: r.activated, replaced: [] }; }
        tree = r.tree;
        render();
        notifyActivated(paneId);
        commit();
        for (const t of r.replaced) recents.push(paneId, t);
        if (r.replaced.length > 0) {
            showNotice(paneId, {
                kind: 'toast',
                text: `已用「${tabTitle(tab, paneId)}」替换${labelList(r.replaced, paneId)}`,
                buttons: [{
                    label: '撤销',
                    role: 'undo',
                    onClick: () => undoReplace(paneId, prevTabs, prevIdx, r.replaced),
                }],
                autoHideMs: 10000,
            });
        }
        return { paneId, activated: r.activated, replaced: r.replaced };
    }

    function undoReplace(paneId, prevTabs, prevActive, replaced) {
        clearNotice();
        // 撤销 = 把整份标签恢复回去,并把刚塞进「最近关闭」的那些**拿掉**
        // (设计稿的撤销只改了标签、没清最近关闭 —— 于是同一条会同时躺在两处)
        for (const t of replaced) recents.drop(paneId, t);
        const r = replaceTabs(tree, paneId, prevTabs, prevActive);
        tree = r.tree;
        render();
        notifyActivated(paneId);
        commit();
        return r;
    }

    /** 某个标签成为当前标签时通知外壳(它负责把内容装上,例如把编辑器切到那一篇)。 */
    const lastActive = new Map();
    function notifyActivated(paneId) {
        const tab = activeTabOf(findLeaf(paneId));
        const key = tab === null ? '' : tabKey(tab);
        if (lastActive.get(paneId) === key) return;
        lastActive.set(paneId, key);
        if (tab !== null) onActivateTab?.(tab, paneId);
    }

    function notifyAll() {
        for (const id of listPaneIds(tree)) notifyActivated(id);
    }

    /** 「当前面板」:焦点所在(往上找 .pw-pane)→ 鼠标所在 → 上一片被碰过的 → 树里第一片。 */
    function currentPane() {
        let node = doc?.activeElement ?? null;
        while (node) {
            if (node.classList?.contains?.('pw-pane') && node.dataset?.paneId) return node.dataset.paneId;
            node = node.parentElement ?? null;
        }
        const at = doc?.elementFromPoint?.(lastMouse.x, lastMouse.y);
        const pane = at?.closest?.('.pw-pane');
        if (pane?.dataset?.paneId) return pane.dataset.paneId;
        return currentPaneId ?? listPaneIds(tree)[0] ?? null;
    }

    /** 空面板的占位(只在坏存档 / "整棵树只剩这一格"这两种兜底里出现,见 EMPTY_PANE_HINT)。 */    function emptyPlaceholder() {
        const box = el(doc, 'div', 'pw-empty');
        box.textContent = EMPTY_PANE_HINT;
        return box;
    }

    function unknownViewPlaceholder(tab) {
        const box = el(doc, 'div', 'pw-empty');
        box.textContent = `「${tab?.view ?? ''}」这个视图这次没有登记(插件没加载?)—— 面板还在`;
        return box;
    }

    /** 一片面板的标签读数(自检/设置页读数用;只读快照,不给内部对象)。 */
    function readTabs(paneId) {
        const leaf = findLeaf(paneId);
        if (leaf === null) return null;
        return {
            tabs: leaf.tabs.map((t) => ({ ...t })),
            active: leaf.active,
            mode: paneEls.get(paneId)?.querySelector?.('.pw-tabs')?.dataset?.mode ?? null,
        };
    }

    /** 一个元素整棵子树的文字(只给读数用:替身 DOM 不做 textContent 聚合)。 */
    function textOf(node) {
        if (!node) return '';
        const kids = Array.isArray(node.children) ? node.children : [];
        return `${node.textContent ?? ''}${kids.map(textOf).join('')}`;
    }

    /** 分隔条的旧 id / 双击默认宽度:按"贴着哪个面板"匹配(外壳兼容,见 main.js)。 */
    function ruleFor(node, index) {
        const leftId = isPane(node.children[index]) ? node.children[index].id : null;
        const rightId = isPane(node.children[index + 1]) ? node.children[index + 1].id : null;
        for (const rule of gutters) {
            if (rule.after && rule.after === leftId) return { rule, which: Number.isInteger(rule.which) ? rule.which : 0 };
            if (rule.before && rule.before === rightId) return { rule, which: Number.isInteger(rule.which) ? rule.which : 1 };
        }
        return null;
    }

    function renderGutter(node, index, leftEl, rightEl) {
        const horizontal = node.dir === 'row';
        // 路径在渲染时算一次:树之后会被换成新对象,但**形状**在两次 render 之间不变,
        // 所以路径一直有效(拖动中绝不 render)。
        const path = pathTo(tree, node);
        const g = el(doc, 'div', `pw-gutter pw-${node.dir}`);
        const matched = ruleFor(node, index);
        if (matched?.rule?.id) g.id = matched.rule.id;       // 旧 id 继续可用(#navResizer / #sideResizer)
        g.dataset.gutterIndex = String(index);
        g.setAttribute('role', 'separator');
        g.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
        const leftName = titleOf(node.children[index]);
        const rightName = titleOf(node.children[index + 1]);
        g.setAttribute('aria-label', `${leftName} 与 ${rightName} 之间:拖动调整大小`);
        g.tabIndex = 0;

        const geom = () => {
            const a = leftEl.getBoundingClientRect();
            const b = rightEl.getBoundingClientRect();
            const pxA = horizontal ? a.width : a.height;
            const pxB = horizontal ? b.width : b.height;
            return { horizontal, pxA, pxB, pairPx: pxA + pxB };
        };
        ariaRefreshers.push(() => {
            const { pxA, pairPx } = geom();
            if (!(pairPx > 0)) return;
            g.setAttribute('aria-valuemin', String(Math.round(pairPx * (minRatio / 100))));
            g.setAttribute('aria-valuemax', String(Math.round(pairPx * (1 - minRatio / 100))));
            g.setAttribute('aria-valuenow', String(Math.round(pxA)));
        });

        listen(g, 'pointerdown', (e) => startGutterDrag(e, g, path, index, leftEl, rightEl));
        listen(g, 'dblclick', () => resetPair(path, index, leftEl, rightEl, matched));
        listen(g, 'keydown', (e) => onGutterKey(e, path, index, leftEl, rightEl));
        // 键盘调尺寸时角标也要看得见:分隔条**拿到焦点**就等于"正在调它"(方向键随时会按)
        listen(g, 'focus', () => setResizing(true));
        listen(g, 'blur', () => setResizing(false));
        return g;
    }

    /**
     * 一个孩子给人的**名字**。
     *
     * ⚠️ v4:叶子的 `node.id` 是**槽位 id**(可能叫 `slot:3`),不是视图名 ——
     * 所以名字必须取**当前标签**的视图名;槽位 id 只在"这一格是空的"时当兜底。
     * 分隔条的 aria-label 走这一条,用户听到的才是「笔记列表 与 笔记正文 之间」,
     * 而不是「slot:3 与 notes 之间」。
     */
    function titleOf(child) {
        if (isPane(child)) {
            const tab = activeTabOf(child);
            if (tab !== null) return String(tabTitle(tab, child.id) ?? tab.view ?? child.id);
            return `空容器(${child.id})`;
        }
        return '分割区';
    }

    // ---- 拖分隔条:只改相邻两片,其余片不动 ----

    /** 把新的比例写进树与这两个 DOM 子项的 flex,并刷新读数/证据。 */
    function applyPairSizes(path, index, sizes, leftEl, rightEl) {
        tree = setPairRatio(tree, path, index, sizes[index], { minRatio });
        const live = nodeAtPath(tree, path);
        if (!live) return;
        leftEl.style.flex = `${live.sizes[index]} 1 0%`;
        rightEl.style.flex = `${live.sizes[index + 1]} 1 0%`;
        refreshAria();
        updateText();
        // ⚠️ 尺寸角标也要跟着动:它是"正在改尺寸"时才看的那份读数,拖动中读到旧数字
        // 比不显示更糟(松手才跳一下,用户会以为拖动没生效)。
        refreshSizeTexts();
    }

    /** 拖分隔条 / 聚焦分隔条期间给工作台挂个标记:CSS 靠它让**所有**面板的尺寸角标显形。 */
    function setResizing(on) {
        const cls = desk?.classList;
        if (on === true) cls?.add?.('pw-resizing');
        else cls?.remove?.('pw-resizing');
    }

    function startGutterDrag(e, g, path, index, leftEl, rightEl) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault?.();
        const live = nodeAtPath(tree, path);
        if (!live) return;
        const horizontal = live.dir === 'row';
        const a = leftEl.getBoundingClientRect();
        const b = rightEl.getBoundingClientRect();
        const pxA = horizontal ? a.width : a.height;
        const pairPx = pxA + (horizontal ? b.width : b.height);
        if (!(pairPx > 0)) return;
        const startSizes = live.sizes.slice();
        const startPos = horizontal ? (e.clientX ?? 0) : (e.clientY ?? 0);
        g.dataset.dragging = '1';
        setResizing(true);                                  // 尺寸角标显形(拖完/取消时收回)

        const move = (ev) => {
            ev.preventDefault?.();
            const pos = horizontal ? (ev.clientX ?? 0) : (ev.clientY ?? 0);
            const sizes = pairSizesFromDrag(startSizes, index, pairPx, pxA, pos - startPos, minRatio);
            applyPairSizes(path, index, sizes, leftEl, rightEl);
        };
        const up = () => {
            win?.removeEventListener?.('pointermove', move);
            win?.removeEventListener?.('pointerup', up);
            win?.removeEventListener?.('pointercancel', up);
            delete g.dataset.dragging;
            setResizing(false);
            interacted = true;
            commit();
        };
        win?.addEventListener?.('pointermove', move);
        win?.addEventListener?.('pointerup', up);
        win?.addEventListener?.('pointercancel', up);
    }

    /** 双击分隔条:相邻两片回到"默认宽度"(旧的 .col-resizer 就是双击回 236 / 240)。 */
    function resetPair(path, index, leftEl, rightEl, matched) {
        const live = nodeAtPath(tree, path);
        if (!live) return;
        const horizontal = live.dir === 'row';
        const a = leftEl.getBoundingClientRect();
        const b = rightEl.getBoundingClientRect();
        const pairPx = (horizontal ? a.width : a.height) + (horizontal ? b.width : b.height);
        if (!(pairPx > 0)) return;
        const targetPx = Number.isFinite(Number(matched?.rule?.defaultPx))
            ? Number(matched.rule.defaultPx) : pairPx / 2;
        // which=0 → 左边那片回到 defaultPx;which=1 → 右边那片回到 defaultPx
        const leftPx = matched?.which === 1 ? pairPx - targetPx : targetPx;
        const sizes = pairSizesFromPx(live.sizes, index, pairPx, leftPx, minRatio);
        interacted = true;
        applyPairSizes(path, index, sizes, leftEl, rightEl);
        commit();
    }

    function onGutterKey(e, path, index, leftEl, rightEl) {
        const live = nodeAtPath(tree, path);
        if (!live) return;
        const horizontal = live.dir === 'row';
        const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
        const fwd = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault?.();
        const a = leftEl.getBoundingClientRect();
        const b = rightEl.getBoundingClientRect();
        const pxA = horizontal ? a.width : a.height;
        const pairPx = pxA + (horizontal ? b.width : b.height);
        if (!(pairPx > 0)) return;
        // 方向按"把分隔条往哪边推"理解:往右/下推 = 左边那片变宽
        const step = (e.shiftKey ? 3 : 1) * keyStepPx * (e.key === fwd ? 1 : -1);
        const sizes = pairSizesFromPx(live.sizes, index, pairPx, pxA + step, minRatio);
        interacted = true;
        applyPairSizes(path, index, sizes, leftEl, rightEl);
        commit();
    }

    // ---- 旧"拖整片面板"那一段**已整条删除**(规格 §1.2)----
    //
    // 删掉的是:`bindPaneDrag()`(抓标签条/抓手起手)、`dragId`(正在拖的面板)、
    // `showHint()` / `hideHints()`(整格与半侧的落点预览)、`applyDrop()`(分发到
    // `swapPanes` / `dropOnEdge` / `dockBottom` 的入口)。
    //
    // ⚠️ 为什么是"删干净"而不是"把抓手藏起来":规格 §1.2 明确写了不许只隐藏视觉而保留事件 ——
    //    那会让"抓手拖不动"变成一条**只能靠试才知道**的规则。整条路径不在代码里,
    //    才谈得上"抓手 / 标题栏 / 标签条空白拖动一律不动"(§8 验收动作 ③)。
    //    连带作废的是底部整宽停靠带(`bandEl`):它原来绑的就是整片 `dockBottom`,
    //    规格 §4 末尾给了两条出路 —— 要么也只接受单标签、要么删掉;
    //    **这里选删掉**(理由见回报:那条带与"拖到窗口底部"这个动作本身就带着
    //    "把一整片搬下去"的语感,而四边停靠已经能表达"放到下面";留一条只用一次的
    //    手势要额外维护命中区、预览与测试,收益却是负的)。
    //
    // 保留的唯一只读口是下面的 `zoneAt()`:自检与既有单测用它读"某点落在哪一片"。

    /**
     * ⚠️ **只读兼容口**,不再参与任何拖动(拖动走 `tabDropZoneAt`)。
     *
     * 它用的是旧的**比例**口径(`edge` = 0.28)与旧的字段名(`id` / `kind:'center'`),
     * 因为既有断言逐字读这些值。真正的标签投放不能用它:比例口径在宽面板上会把
     * 整个正文都算成"边缘",用户根本落不到"中央追加"(规格 §4.2 要的是固定像素带)。
     */
    function zoneAt(x, y) {
        const wrap = desk.getBoundingClientRect?.() ?? { bottom: 0 };
        if (y >= wrap.bottom - bandPx) return { kind: 'bottom-dock' };
        const under = doc.elementFromPoint?.(x, y);
        const pane = under?.closest?.('.pw-pane');
        if (!pane) return null;
        const id = pane.dataset.paneId;
        if (!id || id === tabDrag?.fromId) return null;    // 落到自己身上 = 没有落点
        const r = pane.getBoundingClientRect();
        if (!(r.width > 0) || !(r.height > 0)) return null;
        const px = (x - r.left) / r.width;
        const py = (y - r.top) / r.height;
        if (px < edge) return { kind: 'edge', id, side: 'left' };
        if (px > 1 - edge) return { kind: 'edge', id, side: 'right' };
        if (py < edge) return { kind: 'edge', id, side: 'top' };
        if (py > 1 - edge) return { kind: 'edge', id, side: 'bottom' };
        return { kind: 'center', id };
    }

    // ---- 读数与存档 ----

    function refresh() {
        // ⚠️ 标签条要跟着宽度重画:220px 那条阈值与三级缩写都是**按实际可用宽度**算的,
        // 拖分隔条 / 换窗口大小之后,同一个面板可能从胶囊变下拉(或反过来)。
        paintStrips();
        refreshSizeTexts();
        refreshAria();
        updateText();
        onLayout?.(tree, { persist: false });               // 只更新读数(CSS 变量),不写盘
    }

    /**
     * 标题栏那个尺寸角标(`820×949`)的文本。
     *
     * 单独一个函数是因为它有**两个**调用点:重画之后(`refresh`),以及拖分隔条的过程中
     * (`applyPairSizes`)—— 拖动中读到旧数字比不显示更糟。角标显不显示由 CSS 决定
     * (悬停/聚焦/拖动时淡入),这里只管把数字写对。
     */
    function refreshSizeTexts() {
        for (const [id, sizeEl] of sizeEls) {
            const pane = paneEls.get(id);
            if (!pane) continue;
            const r = pane.getBoundingClientRect();
            sizeEl.textContent = `${Math.round(r.width)}×${Math.round(r.height)}`;
        }
    }

    function refreshAria() {
        for (const fn of ariaRefreshers) {
            try { fn(); } catch { /* 量不到就算了下一次再刷 —— 不该影响渲染 */ }
        }
    }

    function updateText() {
        if (!treeEl) return;
        // ⚠️ 标签表**逐槽位**算:槽位 id 与视图名不再等价(边缘拆分出来的是 `slot:<n>`),
        //    直接递 titles 会把裸 id 印给用户 —— 见 slotLabel。
        treeEl.textContent = formatTree(tree, treeLabels());   // textContent:绝不用 innerHTML
        treeEl.title = treeEl.textContent;
    }

    async function commit() {
        refresh();
        onLayout?.(tree, { persist: true });
        try {
            await store?.save(tree);                        // 松手才写一次
        } catch (err) {
            log?.warn?.('[layout] 保存布局失败', err);
        }
    }

    // ---- 对外 ----

    async function mount() {
        if (mounted) return tree;
        mounted = true;
        host?.classList?.add('pw-host');
        // 旧的像素分隔条换成树里的分隔条(否则 #navResizer 会有两个)。
        if (host?.querySelectorAll) {
            for (const old of [...host.querySelectorAll('.col-resizer')]) old.remove();
        }
        render();
        if (store) {
            try {
                const { ok, tree: saved } = await store.load();
                if (ok && saved && !interacted) {
                    // 最后一道防线:存档层已经归一化过,这里再过一遍 —— 万一有别的
                    // 实现把一棵缺视图的树递进来,渲染出来就是"某个面板整片消失",
                    // 而结构断言照样是绿的(这个仓库踩过一次)。宁可退回外壳的初始树。
                    //
                    // ⚠️ 判据必须是 **validateLayout**(问标签),**不能**再写
                    //    "叶子 id 集合与 known 一一对应" —— 那是 v3 的口径:
                    //    合并过的布局叶子天然比视图少(一枚标签并进了别的格子),
                    //    旧判据会把**用户刚拖好的布局**判成坏档、直接打回 initialTree。
                    //    实测(§8 验收动作④):合并 + 边缘拆分之后重启,布局整片丢失 ——
                    //    根因就是这里这一句,与存档层的 `paneSetMatches` 是同一个错。
                    const known = Object.keys(panes);
                    const required = Array.isArray(requiredIds) ? requiredIds : known;
                    const safe = normalizeTree(saved, known, required);
                    tree = validateLayout(safe, known, required).ok ? safe : (cloneTree(initialTree) ?? defaultTree());
                    render();
                }
                // 存档里的活动标签 = 用户上次正在看的那个视图。挂载完成后通知一次,
                // 外壳据此把内容装上(例如把笔记正文那个编辑器切到 tab.doc 那一篇)。
                // 放在 load 之后:此刻 tree 才是最终那棵树。
                notifyAll();
            } catch (err) {
                log?.warn?.('[layout] 读布局存档失败,继续用默认布局', err);
            }
        }
        notifyAll();
        return tree;
    }

    function reset() {
        tree = cloneTree(initialTree) ?? defaultTree();
        interacted = true;
        render();
        commit();
        return tree;
    }

    /**
     * 用一棵**外壳算好的**树替换当前树(「窗口」菜单点一条未开着的面板 = 新加一格,走这条)。
     *
     * 为什么必须有这个口子:树的变化原本只由这一层内部的指针/键盘动作产生,而菜单那条
     * 路径的树是外壳用 app/lib/panel-tree.js 的纯函数(addPane)算出来的 —— 外壳拿不到
     * 这里的闭包变量 `tree`,没有这个口子它就只能自己重画一遍 DOM,那等于把渲染规则抄第二份。
     *
     * `interacted = true` 与 reset() 同一个理由:这是**用户的手动动作** —— 若此刻存档
     * 还没读回来,随后那棵"上次的存档树"不许把它盖掉(见 mount 里那一句的判断)。
     * 非法输入(不是叶子也不是分割)原样返回:不动树、不重画、更不写盘。
     */
    function applyTree(next) {
        if (!isPane(next) && !isSplit(next)) return tree;
        tree = next;
        interacted = true;
        render();
        commit();
        return tree;
    }

    listen(resetBtn, 'click', () => { reset(); });
    listen(win, 'resize', () => refresh());

    // ---- 窗口级那几条:快捷键 + 鼠标位置 + 浮层的"点外面关掉" ----

    // 鼠标停在哪:快捷键要作用在「当前面板」上,而没有焦点时那个判据就是它。
    // ⚠️ 挂在**工作台容器**(desk)上而不是 window 上:window 上的 pointermove 被既有
    //    断言数着("拖面板:右键不启动拖动"要求松手后 window 上没有多余的 pointermove;
    //    "拖分隔条"要求挂钩数恰好是 1)。工作台是鼠标唯一会在意的地方,挂在这里
    //    覆盖范围一模一样,却不会去动那两条既有判据。
    listen(desk, 'pointermove', (e) => { lastMouse = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 }; });

    /**
     * 快捷键(全部作用在「当前面板」= 焦点所在,没有焦点时鼠标所在):
     *   Ctrl+W      关掉当前标签
     *   Ctrl+Tab    切下一个标签(循环)
     *   Ctrl+Shift+T 恢复这个面板最近关掉的那个
     *
     * ⚠️ Ctrl+Tab 是浏览器/Electron 的保留键,真窗口里到底收不收得到必须**实测**
     * (自检里那条断言就是干这个的);收不到的话如实写在报告里,不装作它可用。
     */
    listen(win, 'keydown', (e) => {
        if (!e?.ctrlKey || e.altKey || e.metaKey) return;
        const paneId = currentPane();
        if (paneId === null || paneId === undefined) return;
        const leaf = findLeaf(paneId);
        if (leaf === null) return;
        if (e.key === 'w' || e.key === 'W') {
            e.preventDefault?.();
            if (leaf.tabs.length > 0) requestClose(paneId, leaf.active);
            return;
        }
        if (e.key === 'Tab' && e.shiftKey !== true) {
            e.preventDefault?.();
            nextPaneTab(paneId);
            return;
        }
        if ((e.key === 'T' || e.key === 't') && e.shiftKey === true) {
            e.preventDefault?.();
            restoreRecent(paneId);
        }
    });

    // 浮层:点外面关掉。⚠️ 判据里必须**包含"点在浮层内部"**——
    // 设计稿是"pointerdown 一律关掉",而那一下正好落在菜单项上时,菜单项的 click 还没发
    // 节点就被移除了(设计稿自己标注过:它只被合成事件驱动过,真鼠标可能根本点不动)。
    listen(doc, 'pointerdown', (e) => {
        if (popup === null) return;
        const t = e?.target;
        if (t === popup.el || popup.el?.contains?.(t) === true) return;
        closePopup();
    }, true);
    listen(win, 'keydown', (e) => { if (e?.key === 'Escape') closePopup(); });

    return {
        mount,
        reset,
        render,
        /** 换成外壳算好的树(「窗口」菜单加一格);内部照常 render + commit(落盘)。 */
        applyTree,
        refresh,                       // 重新量一遍读数(尺寸/aria/标签条);不写盘
        getTree: () => cloneTree(tree),
        text: () => formatTree(tree, treeLabels()),
        /** ⚠️ 只读兼容口(旧的**比例**口径,不参与拖动)。真正的落点判定见 tabDropZoneAt。 */
        zoneAt,
        /**
         * 标签投放的落点判定(规格 §4.2):`{ kind:'stack', slotId, insertAt }` /
         * `{ kind:'edge', slotId, side }` / `null`。只读,不碰 DOM、不改树。
         */
        tabDropZoneAt,
        paneIds: () => Object.keys(panes),
        // ---- 标签页对外那几件(main.js 接线 + 自检读数) ----
        /** 点击打开 = 在目标面板里替换(返回 { paneId, activated, replaced })。 */
        openView,
        /** 把某个已经开着的视图切到眼前(它可能只是某格里的非活动标签);返回 true = 找到了。 */
        focusView,
        /** ＋ 的并列语义:返回 { created, movedFrom, paneId, index }。 */
        addView: (paneId, view) => requestAdd(paneId, view),
        closeTab: (paneId, index) => requestClose(paneId, index),
        closeOtherTabs: (paneId, index) => requestCloseOthers(paneId, index),
        closeAllTabs: (paneId) => requestCloseAll(paneId),
        activateTab: (paneId, index) => activatePaneTab(paneId, index),
        nextTab: (paneId) => nextPaneTab(paneId),
        restoreClosedTab: (paneId) => restoreRecent(paneId),
        /** 这一片的标签(只读快照,自检与设置页读数用)。 */
        tabsOf: (paneId) => readTabs(paneId),
        /** 每一片的标签读数(自检用:比较"点了一篇笔记之后谁动了")。 */
        allTabs: () => listPaneIds(tree).map((id) => ({ paneId: id, ...(readTabs(id) ?? {}) })),
        /** 底部那条提示还在不在(自检断言"可撤销提示"用)。 */
        notice: () => (notice === null ? null : { paneId: notice.paneId, kind: notice.kind, text: textOf(notice.el) }),
        recentsOf: (paneId) => recents.list(paneId),
        currentPane,
        /** 这一片此刻有没有东西(空面板的判据);自检用。 */
        isEmpty: (paneId) => (findLeaf(paneId)?.tabs ?? []).length === 0,
        dispose() {
            closePopup();
            clearNotice();
            for (const off of disposers.splice(0)) off();
        },
    };
}



