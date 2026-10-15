// 面板里的**标签页** —— 纯函数,不碰 DOM。
//
// 契约在 panel-tree.js 的叶子上(`tabs: [{view, doc?}]` + `active`),这里负责的是
// 界面上那些"标签页该怎么表现"的规则:
//   · 两段式:可用宽度 ≥ 220px → 胶囊标签 + **三级缩写**(全名 → 前 2 字+… → 首字);
//             < 220px → 整条换成"当前视图名 ∨"下拉;
//   · 关闭:× / 中键 / 右键菜单(关闭·关闭其他·关闭全部)/ Ctrl+W —— 这一层**只负责把标签拿掉**
//         ("空面板"在这里是合法状态);某一格空掉之后要不要**整格收起**,是工作台那一层的事
//         (panel-workspace.js 的 collapseIfEmpty:空了就 detach,空间整块给邻居);
//   · **＋ = 并列**(追加一个标签),**点击打开 = 替换**(新标签成为当前标签,原标签关闭);
//   · 「最近关闭」:被关闭/被替换的标签一律进去,Ctrl+Shift+T 恢复。
//
// 为什么这些都放在纯函数里:它们全是"标签列表怎么变"的数学,与 DOM 无关,
// 放在这里就能被 node --test 直接跑(与 panel-tree.js 同一个理由 —— 自检一次两分钟,
// 靠它验"数学对不对"太贵)。DOM 那一层只负责把函数结果画出来、把指针/键盘事件翻译成调用。
//
// ⚠️ 缩写级别**必须实测文字宽度**再决定,不能像设计稿那样写死"3 个标签 × 74px":
//    设计稿的 labelFor() 把 3 这个数字写死了(而面板里可能是 2 个或 5 个标签),
//    于是它算出来的级别在 5 个标签时**根本装不下**(只能靠溢出的横滚兜底),
//    而第三级"首字"在数学上永远走不到(要 clientWidth < 190 才会用到,可 < 220 已经走下拉了)。
//    这里按**每个标签实际能分到多少宽度**逐个降级,三级都真的会用到。

/** 面板**可用宽度**(padding 之后)的下界:低于它整条换成"当前视图名 ∨"下拉。 */
export const TAB_BREAKPOINT_PX = 220;

/** 标签条上不属于任何标签的固定开销:＋ / 更多 按钮 + 两侧 padding。 */
export const TAB_RESERVED_PX = 40;

/** 每个标签内部与文字无关的开销:左右 padding(8+8)+ × 与其外边距(≈14)。 */
export const TAB_TEXT_RESERVE_PX = 30;

/** 标签之间的间隙(与 CSS 里 .pw-tabs 的 gap 同一个值;别只改一处)。 */
export const TAB_GAP_PX = 3;

/** 单个标签文字的保底预算:再挤也要留这么多,剩下的交给 CSS 的省略号。 */
export const TAB_MIN_TEXT_PX = 18;

/** 缩写级别:0 = 全名,1 = 前 2 字+…,2 = 首字。 */
export const LEVEL_FULL = 0;
export const LEVEL_TWO = 1;
export const LEVEL_SHORT = 2;

/** 每个面板的「最近关闭」最多记几条(设计稿 route-demo 用的是 3)。 */
export const RECENT_MAX = 3;

/**
 * 兜底的字宽估算(纯函数用;真身由外壳注入 canvas 实测的那一份,见 main.js)。
 *
 * 中日韩文字按字号整宽、ASCII 按 0.56 倍 —— 够用来分级,不需要精确到像素:
 * 级别只差一档就是好几个字符的宽度,估错一点不会换级。
 */
export function estimateTextWidth(text, fontSize = 11.5) {
    let w = 0;
    for (const ch of String(text)) {
        w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? fontSize : fontSize * 0.56;
    }
    return w;
}

/**
 * 第二级缩写的文本:前 2 个**字**+ 省略号。
 * 名字本身就短(≤2 字)时不加省略号 —— 否则「链接」会变成「链接…」,反而更长。
 */
export function twoCharLabel(label) {
    const s = String(label ?? '');
    return s.length > 2 ? `${s.slice(0, 2)}…` : s;
}

/**
 * 第三级缩写的文本:首字。
 *
 * ⚠️ 拉丁字母开头的名字取**前两个 ASCII 字母**:设计稿的 VIEWS 表里 `ai` 的 short 是
 * 'AI' 而不是 'A' —— 一个 'A' 在中文界面里既不像名字也不好认。其余一律 1 个字。
 */
export function shortLabel(label) {
    const s = String(label ?? '');
    if (s === '') return '';
    const m = /^[A-Za-z]{2,}/.exec(s);
    if (m) return m[0].slice(0, 2).toUpperCase();
    return s.slice(0, 1);
}

/**
 * 标签项 → 全名。
 *
 * 标签项可以就是一个字符串,也可以是 `{ label, short }`:
 * `short` 是**外壳按视图登记的那一份第三级缩写**(设计稿的 VIEWS 表:笔记列表→笔、
 * 笔记正文→正、短剧画布→剧、链接→链、AI 对话→AI、大纲→纲)。
 *
 * ⚠️ 为什么要允许外壳指定:两个真身视图**同头**(「笔记列表」与「笔记正文」),
 * 只看首字的话第三级双双退化成「笔」—— 而设计稿正是用**人工挑过的** 笔/正 解决这件事的。
 * 没给 `short` 时兜底成首字,所以文档标签(笔记标题)不传也能用。
 */
function labelOf(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return String(item.label ?? '');
}

function shortOf(item) {
    const curated = (item !== null && typeof item === 'object') ? String(item.short ?? '') : '';
    return curated !== '' ? curated : shortLabel(labelOf(item));
}

/** 第 level 级的标签文本(越界一律按最高一级处理,绝不返回空串)。 */
export function tabLabel(item, level) {
    const s = labelOf(item);
    if (level === LEVEL_FULL) return s;
    if (level === LEVEL_TWO) return twoCharLabel(s);
    if (level === LEVEL_SHORT) return shortOf(item);
    return s;
}

/** 可用宽度 → 用哪种形态(胶囊 / 下拉)。⚠️ 传进来的必须是 **padding 之后**的可用宽度。 */
export function stripMode(usablePx) {
    const w = Number(usablePx);
    if (!Number.isFinite(w)) return 'dropdown';        // 量不到(首帧 clientWidth=0)→ 先按最窄画
    return w < TAB_BREAKPOINT_PX ? 'dropdown' : 'capsule';
}

/**
 * 给一组标签挑**每一档的缩写级别**(同级之间互相独立)。
 *
 * @param {Array<string|{label:string,short?:string}>} items 每个标签的全名(顺序即显示顺序)
 * @param {number} usablePx 面板 padding 之后的可用宽度
 * @param {(text:string)=>number} [measure] 量文字宽度(真身注入 canvas 实测)
 * @returns {number[]} 与 items 一一对应的级别
 */
export function chooseLevels(items, usablePx, measure = (t) => estimateTextWidth(t)) {
    const names = Array.isArray(items) ? items : [];
    const n = names.length;
    if (n === 0) return [];
    const avail = Math.max(0, Number(usablePx) - TAB_RESERVED_PX);
    const per = (avail - TAB_GAP_PX * (n - 1)) / n - TAB_TEXT_RESERVE_PX;
    const budget = Math.max(TAB_MIN_TEXT_PX, per);
    return names.map((item) => {
        // 从最高一级往下试:第一档塞得下就用它 —— 这就是"按实际可用宽度自动降级"
        for (const level of [LEVEL_FULL, LEVEL_TWO, LEVEL_SHORT]) {
            if (measure(tabLabel(item, level)) <= budget) return level;
        }
        return LEVEL_SHORT;                            // 连首字都塞不下:交给 CSS 的省略号
    });
}

// ---------------------------------------------------------------------------
// 标签列表怎么变(全是对树的操作,纯函数:返回新树,绝不改传进来的那棵)
// ---------------------------------------------------------------------------

/** 找某个标签实例(按 tabKey 身份的树级查找)。 */
export function findTab(tree, tab, tabKeyFn) {
    const key = tabKeyFn(tab);
    if (key === '') return null;
    let hit = null;
    const walk = (node) => {
        if (hit !== null) return;
        if (!node || typeof node !== 'object') return;
        if (node.type === 'pane') {
            const list = Array.isArray(node.tabs) ? node.tabs : [];
            for (let i = 0; i < list.length; i++) {
                if (tabKeyFn(list[i]) === key) { hit = { paneId: node.id, index: i, tab: list[i] }; return; }
            }
            return;
        }
        if (!Array.isArray(node.children)) return;
        for (const c of node.children) walk(c);
    };
    walk(tree);
    return hit;
}

/** 某个 view 都开在哪些面板里(用于"一个视图只有一份 DOM"的搬家规则)。 */
export function panesWithView(tree, view) {
    const out = [];
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'pane') {
            const list = Array.isArray(node.tabs) ? node.tabs : [];
            if (list.some((t) => t && t.view === view)) out.push(node.id);
            return;
        }
        if (Array.isArray(node.children)) for (const c of node.children) walk(c);
    };
    walk(tree);
    return out;
}

/**
 * 用 `fn(leaf)` 就地改一个面板节点,返回**新树**(纯函数)。
 * 找不到面板 / 拿到的不是叶子 → **原树原样返回**(同一个引用,调用方据此判断"什么都没发生")。
 */
export function updatePane(tree, paneId, fn) {
    let done = false;
    const walk = (node) => {
        if (!node || typeof node !== 'object') return node;
        if (node.type === 'pane') {
            if (node.id !== paneId || done) return node;
            done = true;
            const leaf = { type: 'pane', id: node.id, tabs: (node.tabs ?? []).map((t) => ({ ...t })), active: node.active };
            fn(leaf);
            // 标签去重 + active 夹回范围内(与 panel-tree 的 pane() 同一套规矩)
            const seen = new Set();
            const tabs = [];
            for (const t of leaf.tabs) {
                const k = tabKeyOf(t);
                if (k === '' || seen.has(k)) continue;
                seen.add(k);
                tabs.push(t);
            }
            const active = Number.isInteger(leaf.active) && leaf.active >= 0 && leaf.active < tabs.length
                ? leaf.active : 0;
            return { type: 'pane', id: node.id, tabs, active };
        }
        if (!Array.isArray(node.children)) return node;
        return { ...node, children: node.children.map(walk) };
    };
    const out = walk(tree);
    return done ? out : tree;
}

// tabKey 由外部注入(panel-tree.js 是它的唯一实现)—— 这里留一个可替换的入口,
// 于是本模块不 import 任何东西,单测也能直接跑(零依赖)。
let tabKeyOf = (tab) => {
    if (!tab || typeof tab !== 'object' || typeof tab.view !== 'string' || tab.view === '') return '';
    const doc = typeof tab.doc === 'string' && tab.doc !== '' ? tab.doc : '';
    return doc === '' ? tab.view : `${tab.view}\u0000${doc}`;
};

/** 注入 panel-tree.js 的那一份 tabKey(真身与单测都在入口处注入一次)。 */
export function useTabKey(fn) {
    if (typeof fn === 'function') tabKeyOf = fn;
}

/**
 * **＋ 的并列语义**:往这个面板追加一个标签。
 *
 * 三条路(顺序就是优先级):
 *   ① 这个实例(note/view + 文档)**已经在本面板里** → 激活它(同一篇笔记不开第二个标签);
 *   ② 它开在**别的面板**里 → 把它(以及同 view 的其它标签)**搬过来**;
 *   ③ 哪儿都没有 → 追加。
 *
 * ⚠️ 为什么 ② 是"搬家"而不是"复制":每个视图的 DOM **只有一份**(笔记正文就一个编辑器,
 * 反向链接也只有一份)。同一个 view 同时挂在两个面板上,必然有一个面板是空的 ——
 * 那不是"并排看两个",那是坏掉。所以模型层就钉住"一个 view 只在一个面板里",
 * 菜单项上也会写清它现在在哪个面板(见 shell 那一层的 menu 文案)。
 *
 * @returns {{tree:object, paneId:string, index:number, created:boolean, movedFrom:string|null}}
 *          created=true 表示**本面板里多了一个标签**(②③);false 表示只是激活了已有的那个。
 */
export function addTab(tree, paneId, tab) {
    const key = tabKeyOf(tab);
    if (key === '') return { tree, paneId, index: -1, created: false, movedFrom: null };
    const hit = findTab(tree, tab, tabKeyOf);
    if (hit !== null && hit.paneId === paneId) {
        // ① 同一个实例已经**在本面板**开着 —— 激活它,不再开第二个
        return { tree: activateTab(tree, paneId, hit.index), paneId, index: hit.index, created: false, movedFrom: null };
    }
    let next = tree;
    let movedFrom = null;
    if (hit !== null) {
        // ②a 同一个实例开在别的面板 → 把**那一个**标签搬过来(连同它的位置语义)
        next = updatePane(next, hit.paneId, (leaf) => {
            leaf.tabs.splice(hit.index, 1);
            if (leaf.active >= leaf.tabs.length) leaf.active = Math.max(0, leaf.tabs.length - 1);
            else if (hit.index < leaf.active) leaf.active -= 1;
        });
        movedFrom = hit.paneId;
    } else {
        // ②b 同一个 **view** 的其它标签开在别的面板(例如把 3 个 doc 标签整体挪个面板)
        for (const id of panesWithView(tree, tab.view).filter((p) => p !== paneId)) {
            next = updatePane(next, id, (leaf) => {
                leaf.tabs = leaf.tabs.filter((t) => t.view !== tab.view);
                if (leaf.active >= leaf.tabs.length) leaf.active = Math.max(0, leaf.tabs.length - 1);
            });
            movedFrom = movedFrom ?? id;
        }
    }
    // ③ 追加并激活
    let index = -1;
    const out = updatePane(next, paneId, (leaf) => {
        leaf.tabs.push({ ...tab });
        index = leaf.tabs.length - 1;
        leaf.active = index;
    });
    // 面板不存在时 updatePane 会把原树还回来(同一个引用),index 仍是 -1 —— 如实报"没加成"
    if (index < 0) return { tree, paneId, index: -1, created: false, movedFrom: null };
    return { tree: out, paneId, index, created: true, movedFrom };
}

/**
 * **点击打开的替换语义**:在目标面板里打开这个标签。
 *
 * 与 `addTab` 的差别只在最后一步:这里**不是追加,而是把整份标签换掉**(原标签交出来,
 * 调用方收进「最近关闭」并给一条可撤销提示)。产品负责人拍的就是这一条:
 * 在「笔记列表」里点一篇笔记 → **只有「笔记正文」面板的标签被替换**,列表面板一个字不动、
 * 面板总数不变。
 *
 * ⚠️ 例外:这个实例**已经在本面板里**开着时**只激活、不替换** —— 否则用户点一下自己
 * 已经打开的那篇笔记,旁边几个标签会凭空消失(那正是"替换"最容易伤到人的地方)。
 */
export function openInPane(tree, paneId, tab) {
    const key = tabKeyOf(tab);
    if (key === '') return { tree, paneId, index: -1, replaced: [], activated: false };
    const hit = findTab(tree, tab, tabKeyOf);
    if (hit !== null && hit.paneId === paneId) {
        return { tree: activateTab(tree, paneId, hit.index), paneId, index: hit.index, replaced: [], activated: true };
    }
    // 它开在别的面板:先把那一个收掉(否则同一个实例会同时存在于两个面板)
    let base = tree;
    const stray = [];
    if (hit !== null) {
        const r = closeTab(base, hit.paneId, hit.index);
        base = r.tree;
        if (r.closed !== null) stray.push(r.closed);
    }
    const r = replaceTabs(base, paneId, [tab], 0);
    return { tree: r.tree, paneId, index: 0, replaced: [...r.replaced, ...stray], activated: false };
}

/** 激活某面板里的第 index 个标签。 */
export function activateTab(tree, paneId, index) {
    return updatePane(tree, paneId, (leaf) => {
        if (Number.isInteger(index) && index >= 0 && index < leaf.tabs.length) leaf.active = index;
    });
}

/** 切到下一个标签(循环;只有一个标签时不动)。 */
export function nextTab(tree, paneId) {
    return updatePane(tree, paneId, (leaf) => {
        if (leaf.tabs.length > 1) leaf.active = (leaf.active + 1) % leaf.tabs.length;
    });
}

/**
 * 关掉某面板里的第 index 个标签 → { tree, closed }。
 *
 * ⚠️ 纯函数只管"把标签拿掉":关掉最后一个时这个面板就是 `tabs: []`(合法状态,树形一个字不动)。
 *    要不要把空掉的格子**整格收起**由工作台那一层决定(见 panel-workspace.js 的 collapseIfEmpty)。
 */
export function closeTab(tree, paneId, index) {
    let closed = null;
    const next = updatePane(tree, paneId, (leaf) => {
        if (!Number.isInteger(index) || index < 0 || index >= leaf.tabs.length) return;
        closed = leaf.tabs[index];
        leaf.tabs.splice(index, 1);
        // 关掉的是当前标签时,活动标签顺延到**原位置**那个(没有就往前挪一个)
        if (leaf.active >= leaf.tabs.length) leaf.active = Math.max(0, leaf.tabs.length - 1);
        else if (index < leaf.active) leaf.active -= 1;
    });
    return { tree: closed === null ? tree : next, closed };
}

/** 关掉**其它**标签 → { tree, closed:[] }。 */
export function closeOthers(tree, paneId, index) {
    const closed = [];
    const next = updatePane(tree, paneId, (leaf) => {
        if (!Number.isInteger(index) || index < 0 || index >= leaf.tabs.length) return;
        const keep = leaf.tabs[index];
        closed.push(...leaf.tabs.filter((_, i) => i !== index));
        leaf.tabs = [keep];
        leaf.active = 0;
    });
    return { tree: closed.length === 0 ? tree : next, closed };
}

/** 关掉**全部**标签 → { tree, closed:[] }(纯函数只管标签;空掉的格子收不收由上层定)。 */
export function closeAll(tree, paneId) {
    let closed = [];
    const next = updatePane(tree, paneId, (leaf) => {
        closed = leaf.tabs.slice();
        leaf.tabs = [];
        leaf.active = 0;
    });
    return { tree: closed.length === 0 ? tree : next, closed };
}

/**
 * **替换语义**:把这个面板的标签整份换成 tabs(点击打开笔记走这条)。
 * 原标签全部交出来(调用方把它们收进「最近关闭」,并做撤销)。
 */
export function replaceTabs(tree, paneId, tabs, active = 0) {
    let replaced = [];
    const next = updatePane(tree, paneId, (leaf) => {
        replaced = leaf.tabs.slice();
        leaf.tabs = (Array.isArray(tabs) ? tabs : []).map((t) => ({ ...t }));
        leaf.active = active;
    });
    return { tree: next, replaced };
}

/** 把一组标签追加回去(撤销 / 恢复最近关闭走这条),并激活第一个追加的。 */
export function appendTabs(tree, paneId, tabs) {
    const list = Array.isArray(tabs) ? tabs : [];
    if (list.length === 0) return { tree, index: -1, added: 0 };
    let index = -1;
    const next = updatePane(tree, paneId, (leaf) => {
        for (const t of list) leaf.tabs.push({ ...t });
        index = leaf.tabs.length - list.length;
        leaf.active = index;
    });
    return { tree: next, index, added: list.length };
}

// ---------------------------------------------------------------------------
// 「最近关闭」:每个面板一份,先进后出
// ---------------------------------------------------------------------------

/**
 * 一个面板的最近关闭栈(纯数据,不碰 DOM 也不碰树)。
 *
 * 为什么每个面板**各一份**而不是全局一份:在"点击打开 = 在目标面板里替换"这个模型下,
 * 用户最容易丢的是**刚刚被替换掉的那个视图**;而 Ctrl+Shift+T 的作用范围与 Ctrl+W 一样
 * 是"当前面板" —— 两件事的范围一致,用户才不用去想"它到底会恢复到哪里"。
 */
export function createRecent(max = RECENT_MAX) {
    const byPane = new Map();
    return {
        /** 记一条(去重:同一个实例只留最近一次;超出上限丢最旧的)。 */
        push(paneId, tab) {
            const key = tabKeyOf(tab);
            if (key === '') return;
            const list = (byPane.get(paneId) ?? []).filter((t) => tabKeyOf(t) !== key);
            list.unshift({ ...tab });
            byPane.set(paneId, list.slice(0, max));
        },
        /** 一次记多条(关闭全部时)。顺序:后关的在上。 */
        pushAll(paneId, tabs) {
            for (const t of tabs) this.push(paneId, t);
        },
        /** 取最近一条(不弹出 —— 恢复失败时不该把它吃掉)。 */
        peek(paneId) {
            return (byPane.get(paneId) ?? [])[0] ?? null;
        },
        /** 弹出最近一条(恢复成功后才调它)。 */
        pop(paneId) {
            const list = byPane.get(paneId) ?? [];
            const top = list.shift() ?? null;
            byPane.set(paneId, list);
            return top;
        },
        /**
         * 把某个实例从这一份里**拿掉**(取消替换时用)。
         *
         * 为什么要它:撤销会把标签原样恢复回去,而它刚刚已经被记进「最近关闭」了 ——
         * 不清掉的话,同一条会同时躺在标签栏和最近关闭里(再按一次 Ctrl+Shift+T 就多出一个)。
         */
        drop(paneId, tab) {
            const key = tabKeyOf(tab);
            if (key === '') return;
            const list = byPane.get(paneId) ?? [];
            byPane.set(paneId, list.filter((t) => tabKeyOf(t) !== key));
        },
        list(paneId) {
            return (byPane.get(paneId) ?? []).slice();
        },
        /**
         * 清掉某一个面板的那一份。
         *
         * ⚠️ 现在**没有调用点**:「关掉最后一枚 → 整格消失」之后,被摘掉的那一格的
         *    「最近关闭」确实留在了 Map 里、`Ctrl+Shift+T` 也再指不到它(快捷键作用在
         *    "当前面板",而它已经不在树上)—— 但那一格只要经由「窗口」菜单重新长出来,
         *    这一份就正好还能用。所以这里**刻意不清**:清了就等于把用户刚关掉的标签
         *    永久丢掉,而这套 UX 的整个意义就是"关错了还能按回来"。
         */
        clear(paneId) {
            byPane.delete(paneId);
        },
    };
}
