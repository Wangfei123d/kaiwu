// 平铺可停靠面板的**布局树** —— 纯函数,不碰 DOM。
//
// 规格来自已批准的 demo(docs/kaiwu-dock-demo.html):布局是一棵分割树,
// 只有两种节点:
//     { dir:'row'|'col', sizes:[比例...], children:[...] }   分割
//     { type:'pane', id, tabs:[...], active }                 叶子(面板)
// sizes 是**比例**(flex-grow 的权重),不是像素 —— 所以窗口缩放也成立。
//
// 一个面板里可以放多个视图(标签页),于是叶子从契约 v3 起多带两件东西(见 pane()):
//     tabs:   [{ view, doc? }, ...]   这个面板里的标签,**顺序即显示顺序**
//     active: 0                       当前活动标签是 tabs 里的哪一个
// `view` 是视图类型(notes / doc / links / ai / 插件登记的 drama 之类),`doc` 是
// **文档实例**(笔记库里的相对路径,与 notes:read 用的是同一个标识)。
// ⚠️ 标签的身份是"视图 + 文档实例",**不是**"视图类型":同一篇笔记的编辑器只能有一个
// 标签,不同笔记 = 不同标签(见 tabKey)。
//
// 这两个字段最容易被弄丢的地方不是序列化,而是**按 id 重建节点**
// (`pane(node.id)`)—— 树上的每一次拖动都在重建叶子。所以:pane() 造的叶子**永远**
// 带 tabs/active,cloneTree / normalizeTree / 迁移都只经这一个口子,见下面各处注释。
//
// 四个真实面板:notes / doc / links / ai(默认排布见 defaultTree)。
// 上一版的 `side`(反向链接 + AI 合并成一个面板)由 `migrateLegacyTree` 就地拆开 ——
// 那是**迁移**路径,不是别名:旧档必须保住用户原本的排布,不许把它当未知 id 丢掉。
//
// 为什么单独一个模块:落点判定、摘走后的折叠、拖分隔条只动相邻两片 ——
// 这些都是"树怎么变"的数学,与 DOM 无关。放在这里就能被 node --test 直接跑,
// 而不用靠 30-60 秒一次的自检来验"数学本身对不对"。
//
// ⚠️ 与 demo 的一处**有意不同**(只在 detach 的折叠那一步,下面有详细注释):
// demo 折叠父节点时把「父节点的比例 + 幸存孩子的比例」相加,量纲是错的 ——
// 会让**无关的**面板跟着变大。这里按 demo 自己注释里写的
// "继承祖父里的位置与比例"实现:幸存者顶替父节点在祖父里的那一格。

/** 拖分隔条时相邻两片各自至少留这么多(与 demo 一致:6%)。 */
export const MIN_RATIO = 6;

/**
 * 真实界面上的四个面板。
 *
 * ⚠️ 这里原来是三个:`side` 一个元素里同时装着「反向链接 + 出链 + 还没写的」与 AI 面板。
 * 现在拆成 `links` 与 `ai` 两个**完全同等**的面板(同样的手柄 / 投放区 / 最小尺寸 /
 * 比例持久化),于是它们能各自被拖到任何地方 —— 旧档里的 `side` 由 `migrateLegacyTree`
 * 就地拆开(见那个函数)。
 */
export const PANE_NOTES = 'notes';      // 左:笔记列表
export const PANE_DOC = 'doc';          // 中:笔记正文(编辑器)
export const PANE_LINKS = 'links';      // 右栏上半:反向链接 / 出链 / 还没写的
export const PANE_AI = 'ai';            // 右栏下半:Agent(AI)对话面板
export const DEFAULT_PANE_IDS = [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI];

/** 默认权重(顶行:左 19 / 中 62 / 右 19 —— 与改动前的三栏比例一致)。 */
export const DEFAULT_WEIGHTS = [19, 62, 19];

/**
 * 右栏(links 上 / ai 下)的默认比例。
 *
 * 为什么是 42 / 58 而不是 50 / 50:改动前 `.note-side-links` 的 `max-height` 是 46%、
 * AI 面板占满剩下那一块(≥54%)—— 取 42/58 让 AI 比链接区略大,与旧观感一致;
 * 而"打开就是对话"是 AI 面板的硬要求,它不该是更小的那半。
 */
export const DEFAULT_SIDE_SPLIT = [42, 58];

/**
 * 旧 id(已拆开的那一个)。只是为了迁移与单测读起来直白 —— 新代码里**不该**
 * 再出现它,`DEFAULT_PANE_IDS` 里也没有它。
 */
export const PANE_SIDE = 'side';

/**
 * 旧面板 id → 拆成哪几个新 id(顺序就是槽位里的先后)。
 *
 * 这是**迁移**用的映射,不是"别名":`side` 是一个合并面板,读旧档时要在它原来的槽位里
 * 就地切成两块(见 `migrateLegacyTree`),丢掉它等于让用户的面板凭空少一个。
 */
export const LEGACY_PANE_SPLITS = Object.freeze({
    [PANE_SIDE]: [PANE_LINKS, PANE_AI],
});

/** 底栏:被拖到窗口最底部那条带时,整棵树被 {col:[原树, 被拖]} 包起来。 */
export const BOTTOM_DOCK_SIZES = [72, 28];

/** 把存疑的一条标签规整成 `{view}` / `{view,doc}`;读不懂(没有非空 view)返回 null。 */
function cleanTab(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const view = typeof raw.view === 'string' ? raw.view.trim() : '';
    if (view === '') return null;
    const doc = typeof raw.doc === 'string' ? raw.doc.trim() : '';
    return doc === '' ? { view } : { view, doc };
}

/**
 * 槽位 id 的**自动补号**规则(契约 v4)。
 *
 * ⚠️ 为什么新槽位叫 `slot:<序号>` 而不是视图名:`pane.id` 从 v4 起是**槽位键**,
 * 与 `tab.view` 不再等价 —— 一次边缘停靠只拆出**一枚标签**,而那一枚可能是
 * "同一视图的第二篇文档"(两个 doc 标签),拿视图名当 id 会当场撞名。
 * 于是新槽位必须拿一个全树唯一的、与视图无关的 id。
 *
 * 纯函数(不藏模块级计数器):序号 = 树里现有 `slot:<n>` 的最大序号 + 1。
 * 这样"同一棵树 + 同一次投放"永远得到同一个 id —— 可被单测逐字钉住,
 * 也不会因为进程重启而给同一棵存档树补出不同的号。
 */
export function nextSlotSeq(tree) {
    let max = 0;
    const walk = (node) => {
        if (isPane(node)) {
            const m = /^slot:(\d+)$/.exec(node.id);
            if (m) max = Math.max(max, Number(m[1]));
            return;
        }
        if (!isSplit(node)) return;
        for (const c of node.children) walk(c);
    };
    walk(tree);
    return max + 1;
}

/**
 * 树里**全部标签实例**的身份(`tabKey` 列表,深度优先)。
 *
 * 为什么单独一个口子:存档层的 v4 校验有两件事都要问它 ——
 * "同一枚标签是不是出现在了两格里"(全局唯一)、以及"某个视图还在不在树里"
 * (每个必需视图至少一枚)。两处各写一遍遍历迟早会分叉。
 */
export function tabKeysOf(tree) {
    const out = [];
    const walk = (node) => {
        if (isPane(node)) {
            for (const tab of (Array.isArray(node.tabs) ? node.tabs : [])) out.push(tabKey(tab));
            return;
        }
        if (!isSplit(node)) return;
        for (const c of node.children) walk(c);
    };
    walk(tree);
    return out;
}

/**
 * 面板节点工厂 —— 树上**所有**叶子都必须从这里造出来。
 *
 * `pane(id)` = 只有单一视图的面板(这个面板自己就是它唯一的标签):默认树、新收编的
 * 插件面板、以及**没有 tabs 的旧档节点**(v2 = 单视图)都走这一条。
 * `pane(id, tabs, active)` = 带上已有的标签结构(克隆 / 归一化 / 迁移时用)。
 * `pane(id, tabs, active, fallbackView)` = 第四参显式给"读不出标签时退回哪一枚视图"
 *    (空串 = **不退回**,读不出就是空面板 —— 契约 v4 的默认口径)。
 *
 * ⚠️ 第四参为什么必须存在(v4 的关键一条):`pane.id` 不再是视图名,
 * 于是"读不出标签就按 id 补一枚 `{view: id}`"从兜底变成了**改数据** ——
 * 一个叫 `doc` 的槽位里装着的可能是 `links`,按 id 补回就等于把用户的面板换掉。
 * 所以只有**明确知道该退回到哪个视图**的调用方(v2 迁移路径)才传这一参;
 * 其余一律走空串,得到"空面板",再由上层按"空槽位收拢"处理。
 *
 * 为什么默认标签就在这里补,而不是留给 normalizeTree:detach / dropOnEdge / dockBottom /
 * swapPanes / adoptPanes 全都是"重建叶子"的操作。只要有一条路能造出没有标签的叶子,
 * 用户拖一次面板就把标签结构丢了 —— 而树形与面板数量照样对得上,断言全绿。
 * 这就是契约 v2→v3 那个"看着绿、实际丢数据"的坑,堵在工厂这一层最省事。
 *
 * 传入的 tabs 会被**形状级**规整(读不懂的条目丢掉、按实例身份去重、active 跟着实例走);
 * 按 knownIds 过滤 view 是 normalizeTree 的活(normalizeTabs),这里没有 known 可用。
 */
export function pane(id, tabs, active, fallbackView = '') {
    const list = [];
    const at = new Map();                       // 实例身份 → 它在 list 里的下标
    let wanted = -1;                            // active 指的是哪个**实例**
    const given = Array.isArray(tabs);          // 调用方**显式**给了标签列表(哪怕是空的)
    const src = given ? tabs : [];
    const rawActive = Math.floor(Number(active));
    for (let i = 0; i < src.length; i++) {
        const tab = cleanTab(src[i]);
        if (tab === null) continue;
        const key = tabKey(tab);
        let slot = at.get(key);
        if (slot === undefined) { slot = list.length; at.set(key, slot); list.push(tab); }
        // ⚠️ 去重之后 active 要跟着**实例**走,而不是留在原来的下标上:
        // [甲, 甲, 乙] + active=1 指的是"甲",去重后必须落在 0,不能变成"乙"。
        // active 越界(或指向一条读不懂的标签)时 wanted 保持 -1 → 回到第一个。
        if (i === rawActive) wanted = slot;
    }
    if (list.length === 0) {
        // 这三种情况**必须分开**(接上界面之后"关掉最后一个标签"是合法状态):
        //   · 显式给了 `tabs: []` = 用户把最后一条也关掉了 —— **空面板**,保留为空;
        //   · 压根没有 tabs 字段 = v2 旧档的节点 —— 单视图,面板自己就是它唯一的标签;
        //   · 有 tabs 但一条都读不出(全被过滤)= **空面板**(v4:绝不按 id 补回来)。
        if (given) return { type: 'pane', id, tabs: [], active: 0 };
        if (fallbackView !== '') return { type: 'pane', id, tabs: [{ view: fallbackView }], active: 0 };
        return { type: 'pane', id, tabs: [{ view: id }], active: 0 };
    }
    return { type: 'pane', id, tabs: list, active: wanted >= 0 ? wanted : 0 };
}

/**
 * 一条标签的**实例身份**。
 *
 * ⚠️ 为什么身份不是"视图类型":`{view:'doc',doc:'甲篇.md'}` 与 `{view:'doc',doc:'乙篇.md'}`
 * 是**两个**标签(两篇笔记各一个编辑器),而 `{view:'doc'}`(还没打开任何文档)又是第三个;
 * 反过来 `{view:'links'}` 重复出现就只是同一个标签写了两遍。去重、"已开则激活它"、
 * 以及测试里"同型不同文档实例"那条断言,依据的都是这个函数。
 *
 * 用 \u0000 做分隔:它在路径里不可能出现(笔记相对路径来自文件系统),于是
 * ('a\u0000b', '') 与 ('a', 'b') 这种拼接不会撞车。
 */
export function tabKey(tab) {
    const clean = cleanTab(tab);
    if (clean === null) return '';
    return clean.doc === undefined ? clean.view : `${clean.view}\u0000${clean.doc}`;
}

/**
 * 面板自己的标签列表(**归一化**):丢掉这次不认得的 view、按实例身份去重、
 * 读不出东西时按调用方给的 `fallbackView` 退回一枚视图。
 *
 * 为什么 view 要按 knownIds 过滤:标签里的 view 来自**视图注册表**
 * (notes / doc / links / ai / 插件登记的 drama)。插件被卸掉之后再读老档,里面那个
 * 已不存在的 view 就是**读不懂的东西** —— 丢掉它,而不是让整棵树作废
 * (整棵树要不要作废由上层 validateLayout 判,这里不越权)。
 *
 * ⚠️ 三条路的区别(第四轮补的,别合并):
 *   · `tabs` 不是数组(旧档没有这个字段)→ 交给调用方按"单视图"处理;
 *   · `tabs: []`(显式空)→ 返回 `[]` = **空面板**(用户关掉了最后一条,这是合法状态);
 *   · `tabs` 里有东西但一条都不认得 → 按 `fallbackView` 退回;
 *     ⚠️ v4 里 normalizeTree **不传** fallbackView(默认空串),于是"一条都读不出" =
 *     空面板 → 上层收拢该槽位。传 fallbackView 的只有 v2 迁移那类"明确知道退回哪一枚"的路。
 */
export function normalizeTabs(tabs, knownIds = DEFAULT_PANE_IDS, fallbackView = '') {
    const known = (Array.isArray(knownIds) ? knownIds : [])
        .filter((id) => typeof id === 'string' && id.length > 0);
    const out = [];
    if (Array.isArray(tabs)) {
        for (const raw of tabs) {
            const tab = cleanTab(raw);
            if (tab === null) continue;
            if (!known.includes(tab.view)) continue;
            out.push(tab);
        }
    }
    // 显式空 = 空面板(原样保留)
    if (Array.isArray(tabs) && tabs.length === 0) return [];
    if (out.length === 0 && fallbackView !== '') out.push({ view: fallbackView });
    return out;
}

export function isPane(node) {
    return Boolean(node) && typeof node === 'object' && node.type === 'pane'
        && typeof node.id === 'string' && node.id.length > 0;
}

export function isSplit(node) {
    return Boolean(node) && typeof node === 'object'
        && (node.dir === 'row' || node.dir === 'col')
        && Array.isArray(node.children) && node.children.length > 0;
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * 把任意(可能很脏的)数字数组变成 count 个正数,和恰好是 100。
 * 非数字/非正数 → 用已知值的平均数补;一个都没有 → 平分。
 */
export function normalizeSizes(sizes, count) {
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n <= 0) return [];
    if (n === 1) return [100];
    const src = Array.isArray(sizes) ? sizes : [];
    const vals = [];
    for (let i = 0; i < n; i++) {
        const v = Number(src[i]);
        vals.push(Number.isFinite(v) && v > 0 ? v : null);
    }
    const known = vals.filter((v) => v !== null);
    const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    const filled = vals.map((v) => (v === null ? avg : v));
    const total = filled.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return new Array(n).fill(round2(100 / n));
    const out = filled.map((v) => Math.max(0.01, round2((v / total) * 100)));
    // 四舍五入的漂移补给最后一片,保证每一层的比例和都是 100
    const drift = round2(100 - out.reduce((a, b) => a + b, 0));
    out[n - 1] = Math.max(0.01, round2(out[n - 1] + drift));
    return out;
}

/** 造一个分割节点(比例统一归一化,和恒为 100)。 */
export function split(dir, sizes, children) {
    const kids = Array.isArray(children) ? children : [];
    return {
        dir: dir === 'col' ? 'col' : 'row',
        sizes: normalizeSizes(sizes, kids.length),
        children: kids,
    };
}

/**
 * 默认树:**链接与 AI 上下叠在右侧**(不是横排四栏)。
 *
 * 为什么这么排(新装 / 重置时的默认):
 *   ① 改动前就是"左列表 / 中编辑 / 右链接+AI"这三栏 —— 默认形状不变,老用户看不出
 *      界面被重排过,只是右栏内部多了一条可拖的分隔条;
 *   ② 四栏横排会把编辑器挤到 1/4 宽(窗口 1280 时正文只剩 ~300px),而正文是这里
 *      最需要宽度的一块;链接与 AI 都是窄栏内容,竖着叠才用得上高度;
 *   ③ 右栏内部沿用旧顺序:**链接在上、AI 在下**(与 `.note-side` 原来的先后一致),
 *      比例 42/58 见 `DEFAULT_SIDE_SPLIT`。
 *
 * @param {number[]} [weights] 顶行三片的权重(列表 / 正文 / 右栏)
 * @param {number[]} [sideSplit] 右栏内部的权重(links / ai)
 */
export function defaultTree(weights = DEFAULT_WEIGHTS, sideSplit = DEFAULT_SIDE_SPLIT) {
    const w = normalizeSizes(weights, 3);
    return {
        dir: 'row',
        sizes: w,
        children: [
            pane(PANE_NOTES),
            pane(PANE_DOC),
            split('col', sideSplit, [pane(PANE_LINKS), pane(PANE_AI)]),
        ],
    };
}

/**
 * 用**像素宽度**造默认树 —— 让"没拖过"的界面与改动前逐像素一致。
 *
 * 为什么需要它:sizes 是比例,但旧界面是"左 236px / 中自适应 / 右 240px"。
 * 把旧的像素宽当成权重再归一化,在这块宽度上渲染出来的宽度就还是 236 / 240,
 * 之后窗口缩放按比例走(规格要的就是这个)。
 *
 * ⚠️ `sideW` 是**右栏整列**的宽度(链接与 AI 叠在一起的那一列),不是其中某一块。
 *
 * @param {{navW?:number, sideW?:number, avail?:number, sideSplit?:number[]}} p
 *        avail = 容器宽度减去所有分隔条宽度(即留给三片的像素)。
 */
export function treeFromWidths({ navW = 236, sideW = 240, avail = 1280, sideSplit = DEFAULT_SIDE_SPLIT } = {}) {
    const a = Number.isFinite(Number(navW)) && Number(navW) > 0 ? Number(navW) : 236;
    const b = Number.isFinite(Number(sideW)) && Number(sideW) > 0 ? Number(sideW) : 240;
    const total = Number.isFinite(Number(avail)) && Number(avail) > 0 ? Number(avail) : 1280;
    const center = Math.max(1, total - a - b);
    return {
        dir: 'row',
        sizes: normalizeSizes([a, center, b], 3),
        children: [
            pane(PANE_NOTES),
            pane(PANE_DOC),
            split('col', sideSplit, [pane(PANE_LINKS), pane(PANE_AI)]),
        ],
    };
}

/**
 * **旧档迁移**:把 `side`(反向链接 + AI 合并成的那个面板)就地拆成 `links` + `ai`。
 *
 * 为什么必须迁移而不是"当未知 id 丢掉":用户已经有持久化的布局(实测
 * `{row 17% / 83%}[ 笔记列表 , {row 75% / 25%}[ 链接与 AI , 笔记正文 ] ]`)。丢掉 `side`
 * 的后果是他明明没动过设置,面板却凭空少一个、排布被打回默认 —— 而"布局是偏好,
 * 最坏只能是回到默认"这条原则的前提是**我们真的读不懂**,这里我们读得懂。
 *
 * 拆法:保留原来那个槽位与它在这一层里的比例,只在槽位**内部**做一次切分:
 *   · 窄高的槽位(父是 row,或它就是整棵树)→ `col`:links 在上、ai 在下;
 *   · 宽扁的槽位(父是 col,例如"整宽底栏")→ `row`:links 在左、ai 在右。
 * 后者是刻意的:28% 高的底栏里再上下切成两条才真的是"两条细缝",左右并排则各占半个
 * 宽度、高度还是整条底栏。两片都取 `DEFAULT_SIDE_SPLIT`,天然都远大于最小比例 6%。
 *
 * 没有旧 id 时**原样返回**(新档一个字节都不动);脏输入不抛(交给 normalizeTree 兜底)。
 *
 * @param {object} tree 存档里的树(可能含旧 id)
 * @param {{knownIds?:string[], splits?:object}} [opts]
 */
export function migrateLegacyTree(tree, { knownIds = DEFAULT_PANE_IDS, splits = LEGACY_PANE_SPLITS } = {}) {
    const known = (Array.isArray(knownIds) ? knownIds : []).filter((id) => typeof id === 'string' && id.length > 0);
    const map = (splits !== null && typeof splits === 'object') ? splits : LEGACY_PANE_SPLITS;
    const hasLegacy = (node) => {
        if (isPane(node)) return Array.isArray(map[node.id]);
        if (!isSplit(node)) return false;
        return node.children.some(hasLegacy);
    };
    if (hasLegacy(tree) !== true) return tree;             // 没有旧 id:一个字节都不动

    const walk = (node, parentDir) => {
        if (isPane(node)) {
            const into = map[node.id];
            // ⚠️ 只认得这片面板(它不是旧 id)时,**整片照搬**(id + 标签结构):
            // 迁移只负责拆 `side`,不能顺手把别人的标签重置成单视图。
            if (!Array.isArray(into)) return pane(node.id, node.tabs, node.active);
            // 只补那些"这次真的认得"的面板。⚠️ 一个都不认得(调用方给的 knownIds 里
            // 没有 links/ai,例如只认得旧 id 的老调用方)时**保持原样** —— 迁移不是
            // 丢弃器:面板集合对不对由上面那层 `paneSetMatches` 判,这里不越权。
            const parts = into.filter((id) => known.includes(id));
            if (parts.length === 0) return pane(node.id, node.tabs, node.active);
            if (parts.length === 1) return pane(parts[0]);
            return split(parentDir === 'col' ? 'row' : 'col', DEFAULT_SIDE_SPLIT, parts.map((id) => pane(id)));
        }
        if (!isSplit(node)) return null;
        const kids = [];
        const sizes = [];
        node.children.forEach((child, i) => {
            const cleaned = walk(child, node.dir);
            if (cleaned === null) return;
            kids.push(cleaned);
            const raw = Array.isArray(node.sizes) ? Number(node.sizes[i]) : NaN;
            sizes.push(Number.isFinite(raw) && raw > 0 ? raw : null);
        });
        if (kids.length === 0) return null;
        if (kids.length === 1) return kids[0];             // 单孩子的分割没有意义 → 折叠
        return { dir: node.dir, sizes: normalizeSizes(sizes, kids.length), children: kids };
    };
    try {
        return walk(tree, null) ?? tree;
    } catch {
        return tree;                                       // 脏档:原样交给 normalizeTree 处理
    }
}

/**
 * **v2 → v3 迁移**:给每个还没有标签的面板节点补上"单视图"结构
 * (`tabs = [{ view: id }]`、`active = 0`)。
 *
 * 为什么需要它:v2 的面板**语义上就是一个视图**(那时一个面板只放一种视图)。
 * 版本号升到 3 之后,读老档的第一件事就是把这句话翻译成新契约的形状 ——
 * 这是一次**读懂**,不是容错,所以它有资格走 `ok === true` 那条路(与 `side` 迁移、
 * 新面板收编并列),而不是落到 `normalizeTree` 的兜底分支里去。
 *
 * ⚠️ 为什么调用点必须在"面板集合比对"**之前**、而且紧挨另外两处迁移(见 panel-layout-store):
 *   ① 三处迁移回答的是同一个问题 —— "这是一份读得懂的旧档,把它翻译出来,别丢掉";
 *      翻译必须在判卷之前做完,否则用户明明没动过设置,排布却被打回默认;
 *   ② 兜底分支是给"形状就不对 / 面板对不上"的档用的。把 v2 的翻译塞进兜底里,
 *      两条完全不同的路就再也分不开了 —— 将来想单独改标签迁移的规则会无从下手;
 *   ③ 它排在两处之前还有一层顺序上的理由:后面两处(以及它们的深拷贝)都会重建节点,
 *      先让每个面板都有标签,它们才有东西可保(见 pane()/cloneTree 的注释)。
 *
 * 只补"没有(或读不出)标签"的节点:已经有 tabs 的节点**一个字节都不动** ——
 * 迁移必须幂等,更不许把一份新档里真实的标签结构覆盖成单视图。
 * 一个节点都不用补时**原样返回**(同一个引用);脏输入不抛。
 */
export function migrateV2Tabs(tree) {
    let touched = false;
    const walk = (node) => {
        if (isPane(node)) {
            if (Array.isArray(node.tabs) && node.tabs.length > 0) return node;   // 已有标签:不覆盖
            touched = true;
            return pane(node.id);                    // 没有标签 = 单视图
        }
        if (!isSplit(node)) return node;             // 脏档不归它管(交给 normalizeTree 兜底)
        let changed = false;
        const kids = node.children.map((child) => {
            const next = walk(child);
            if (next !== child) changed = true;
            return next;
        });
        if (!changed) return node;
        return { dir: node.dir, sizes: node.sizes.slice(), children: kids };
    };
    try {
        const next = walk(tree);
        return touched ? next : tree;
    } catch {
        return tree;                                 // 脏档:原样交给 normalizeTree 处理
    }
}

/**
 * 新面板的**默认位置**表:id → { anchor, dir, sizes }。
 *
 * `anchor` = 它塞在谁旁边;`dir` = 与 anchor 并成一行还是列;`sizes` = 两片的比例。
 * 只在"存档里没有这片"时用一次,之后它就和其他面板一样完全由用户摆布。
 *
 * 为什么朝向要跟着 anchor 所在的父方向走(见 adoptPanes):往一条**高瘦**的列
 * (父是 row)里再切一刀,若还按 col 叠,两片都会变得又窄又扁;反过来同理。
 * 所以默认朝向取"新开一列/一行",由调用方按需要覆盖。
 */
export const DEFAULT_ADOPTION = Object.freeze({
    'note-canvas': { anchor: 'doc', dir: 'row', sizes: [60, 40] },
    // 短剧画布:插在"笔记正文"右边,自成第三列(左列表 / 中正文 / 右画布+AI)
    drama: { anchor: PANE_DOC, dir: 'row', sizes: [62, 19] },
    // 短剧「项目」面板:挂在自家画布旁边(只切画布那一份,不碰别的列)。
    // ⚠️ 这份与 app/main.js 里那份是同一口径 —— 那边是外壳真正用的,这里是兜底。
    'drama-projects': { anchor: 'drama', dir: 'row', sizes: [58, 42] },
});

/** 树里已经出现的 pane id(顺序即从左到右 / 从上到下)。 */
function paneIdsOf(node, out = []) {
    if (isPane(node)) { out.push(node.id); return out; }
    if (isSplit(node)) for (const c of node.children) paneIdsOf(c, out);
    return out;
}

/**
 * 把 `knownIds` 里**存档还没有**的面板就地收编进树,而不是让整棵树作废。
 *
 * ⚠️ 为什么必须有这一步:上层 `paneSetMatches` 要求"存档的面板集合与 known **恰好一致**",
 * 多一片新面板就判成坏档 → `normalizeTree` 退回默认树。结果是:插件一装,
 * **用户辛苦拖出来的布局被静默打回默认**,而且不会有任何报错。旧 id 的 `side` 迁移
 * (`migrateLegacyTree`)解决的是同一类问题,这里解决的是"新增面板"那一类。
 *
 * 规则:
 *   · 集合已经一致 → **原样返回**(新档一个字节都不动);
 *   · 缺的那片 → 按 placement 插到 anchor 旁边,并把那一层的比例按 `sizes` 重新分配;
 *   · anchor 找不到(用户早把它拖到别处或删了)→ 挂到最外层那一行的末尾;
 *   · 表里没写 placement 的新 id → 也用上面的兜底(`dir:'row'`,与 anchor 平分);
 *   · 脏输入不抛 —— 原样返回,交给 `normalizeTree` 兜底。
 *
 * @param {object} tree 存档里的树
 * @param {string[]} knownIds 这次认得的全部面板 id
 * @param {Object<string,{anchor?:string,dir?:'row'|'col',sizes?:number[]}>} [placement]
 */
/**
 * 把树上等于 `target` 的那个节点换成 `replacement`(按引用比对)。
 * 只用于 adoptPanes —— 它拿到的节点就是自己刚 clone 出来的。
 */
function replaceNode(root, target, replacement) {
    if (root === target) return replacement;
    if (!isSplit(root)) return root;
    return {
        dir: root.dir,
        sizes: root.sizes.slice(),
        children: root.children.map((c) => replaceNode(c, target, replacement)),
    };
}

/**
 * 把 `knownIds` 里**存档还没有**的面板就地收编进树,而不是让整棵树作废。
 *
 * ⚠️ 为什么必须有这一步:上层 `paneSetMatches` 要求"存档的面板集合与 known **恰好一致**",
 * 多一片新面板就判成坏档 → `normalizeTree` 退回默认树。结果是:插件一装,
 * **用户辛苦拖出来的布局被静默打回默认**,而且不会有任何报错。旧 id 的 `side` 迁移
 * (`migrateLegacyTree`)解决的是同一类问题,这里解决的是"新增面板"那一类。
 *
 * 规则:
 *   · 集合已经一致 → **原样返回**(新档一个字节都不动);
 *   · 缺的那片 → 插到 anchor 的**后一个槽位**,并把 anchor 那一份比例按 `sizes` 分给它;
 *   · anchor 找不到或它在整棵树的根上 → 挂到最外层那一行的末尾;
 *   · 表里没写 placement 的新 id → 也走上面的兜底;
 *   · 脏输入不抛 —— 原样返回,交给 `normalizeTree` 兜底。
 *
 * @param {object} tree 存档里的树
 * @param {string[]} knownIds 这次认得的全部面板 id
 * @param {Object<string,{anchor?:string,dir?:'row'|'col',sizes?:number[]}>} [placement]
 */
export function adoptPanes(tree, knownIds = DEFAULT_PANE_IDS, placement = DEFAULT_ADOPTION) {
    const known = (Array.isArray(knownIds) ? knownIds : [])
        .filter((id) => typeof id === 'string' && id.length > 0);
    if (known.length === 0) return tree;
    if (!isPane(tree) && !isSplit(tree)) return tree;          // 脏档:交给 normalizeTree

    try {
        const present = new Set(paneIdsOf(tree));
        const missing = known.filter((id) => !present.has(id));
        if (missing.length === 0) return tree;                 // 集合一致:不动
        // 本函数只**收编缺失的已知面板**,不负责容忍外来 id。
        // 存档里若有 known 之外的 id(插件被卸掉留下的),那是"坏档":原样返回,
        // 交给上层 `paneSetMatches` 判掉、退回默认树。两件事混在一起会让外来 id 被悄悄容忍。
        const knownSet = new Set(known);
        if ([...present].some((id) => !knownSet.has(id))) return tree;

        let next = cloneTree(tree);
        const appendToRootRow = (node, id) => {
            if (!isSplit(node)) return split('row', [50, 50], [node, pane(id)]);
            const kids = node.children.slice();
            const rawSizes = node.sizes.slice();
            kids.push(pane(id));
            rawSizes.push(null);
            // 新片拿 anchor 原来那份的一部分:从均分里切出 30%,其余各片按原比例缩。
            return { dir: node.dir, sizes: normalizeSizes(rawSizes, kids.length), children: kids };
        };

        for (const id of missing) {
            const spec = (placement !== null && typeof placement === 'object' && placement[id]) || {};
            const sizeA = Array.isArray(spec.sizes) ? Number(spec.sizes[0]) : NaN;
            const sizeB = Array.isArray(spec.sizes) ? Number(spec.sizes[1]) : NaN;
            const finalSizes = (Number.isFinite(sizeA) && Number.isFinite(sizeB) && sizeA > 0 && sizeB > 0)
                ? [sizeA, sizeB] : [50, 50];
            const anchor = (typeof spec.anchor === 'string' && spec.anchor !== '') ? spec.anchor : null;

            let placed = false;
            if (anchor !== null && present.has(anchor)) {
                // ⚠️ `findParent` 是按**引用**找的(它还要用返回的引用去替换节点),
                // 所以必须先 `findPane` 拿到 anchor 的节点引用 —— 直接传 id 字符串
                // 永远返回 null,那会让每一片新面板都落到兜底分支上(踩过)。
                const anchorNode = findPane(next, anchor);
                const found = anchorNode === null ? null : findParent(next, anchorNode);
                // anchor 在任意一层都就地插到它后一个槽位 —— 包括"它就是根那一行的
                // 一个成员"这种最常见的情形(短剧画布挂在「笔记正文」旁边就是它)。
                // 只有 anchor **整个找不到**时才走下面的兜底。
                if (found && isSplit(found.parent)) {
                    const idx = found.index;
                    const kids = found.parent.children.slice();
                    const rawSizes = found.parent.sizes.slice();
                    kids.splice(idx + 1, 0, pane(id));
                    rawSizes.splice(idx + 1, 0, null);
                    const base = Number.isFinite(Number(rawSizes[idx])) && Number(rawSizes[idx]) > 0
                        ? Number(rawSizes[idx]) : 100 / (kids.length - 1);
                    const sum = finalSizes[0] + finalSizes[1];
                    rawSizes[idx] = base * (finalSizes[0] / sum);
                    rawSizes[idx + 1] = base * (finalSizes[1] / sum);
                    next = replaceNode(next, found.parent, {
                        dir: found.parent.dir,
                        sizes: normalizeSizes(rawSizes, kids.length),
                        children: kids,
                    });
                    placed = true;
                }
            }
            if (!placed) next = appendToRootRow(next, id);
            present.add(id);
        }
        return next;
    } catch {
        return tree;
    }
}

export function cloneTree(node) {
    // ⚠️ 叶子必须连**标签结构**一起拷贝:`pane(node.id)` 会把 tabs/active 抹成单视图,
    // 而这个函数是 detach / dropOnEdge / dockBottom / swapPanes / adoptPanes 的公共底座 ——
    // 少了这一行,用户只要拖一次面板,标签页就全没了(而树形与面板数照样是对的)。
    if (isPane(node)) return pane(node.id, node.tabs, node.active);
    if (!isSplit(node)) return null;
    return {
        dir: node.dir,
        sizes: node.sizes.slice(),
        children: node.children.map((c) => cloneTree(c)).filter(Boolean),
    };
}

/** 深度优先的面板 id 顺序(左→右、上→下)。 */
export function listPaneIds(tree) {
    const out = [];
    const walk = (n) => {
        if (isPane(n)) { out.push(n.id); return; }
        if (!isSplit(n)) return;
        for (const c of n.children) walk(c);
    };
    walk(tree);
    return out;
}

export function countPanes(tree) { return listPaneIds(tree).length; }

/**
 * 树上**现在开着**的视图集合。
 *
 * ⚠️ 为什么需要它(而不是 `listPaneIds(tree).includes(viewId)`):
 *    v4 起 `pane.id` 只是**槽位键**(见上面 nextSlotSeq 的注释)—— 新建那一格时它恰好
 *    等于视图名,但**标签一旦被拖进别的格子**,视图就住在 id 完全不同的格里了。
 *    于是"按槽位 id 判某视图开没开"会给出**错的**答案,而它错起来很隐蔽:
 *    用户在"窗口"菜单里看到明明开着的面板**没有勾**,再点一次又开出第二份。
 *    实测用户档里就是这样:短剧项目住在 `notes` 格、短剧画布住在 `slot:3` 格。
 *    所以"开没开"一律按**标签里的 view** 判。
 */
export function viewsOpenIn(tree) {
    const out = new Set();
    const walk = (n) => {
        if (isPane(n)) {
            for (const t of n.tabs ?? []) {
                if (typeof t?.view === 'string' && t.view !== '') out.add(t.view);
            }
            return;
        }
        if (!isSplit(n)) return;
        for (const c of n.children) walk(c);
    };
    walk(tree);
    return out;
}

/**
 * 树上**此刻正显示着**的视图集合(每一格里当前标签那一个)。
 *
 * ⚠️ 为什么要和 `viewsOpenIn` 分开:「开着」与「看得见」不是一回事 ——
 *    一格可以塞好几个标签,只有当前那个标签是看得见的,其余只是"开着但藏着"。
 *    「窗口」菜单要能区分这三态才有用:
 *      · 没开 → 点它新加一格;
 *      · 开着但藏着 → 点它**切到前面**(否则用户明明开着却看不见,菜单又点不动,只能自己翻标签条);
 *      · 正显示着 → 无事可做(点不动)。
 */
export function activeViewsIn(tree) {
    const out = new Set();
    const walk = (n) => {
        if (isPane(n)) {
            const tabs = n.tabs ?? [];
            if (tabs.length === 0) return;
            const i = Number.isInteger(n.active) && n.active >= 0 && n.active < tabs.length ? n.active : 0;
            const view = tabs[i]?.view;
            if (typeof view === 'string' && view !== '') out.add(view);
            return;
        }
        if (!isSplit(n)) return;
        for (const c of n.children) walk(c);
    };
    walk(tree);
    return out;
}

export function findPane(tree, id) {
    if (isPane(tree)) return tree.id === id ? tree : null;
    if (!isSplit(tree)) return null;
    for (const c of tree.children) {
        const hit = findPane(c, id);
        if (hit) return hit;
    }
    return null;
}

/** 找父节点与下标。根节点返回 { parent:null, index:-1 }。 */
export function findParent(root, target, parent = null, index = -1) {
    if (root === target) return { parent, index };
    if (!isSplit(root)) return null;
    for (let i = 0; i < root.children.length; i++) {
        const hit = findParent(root.children[i], target, root, i);
        if (hit) return hit;
    }
    return null;
}

/** 从根到 target 的下标路径(按**引用**找;根 = [])。找不到返回 null。 */
export function pathTo(root, target) {
    if (root === target) return [];
    if (!isSplit(root)) return null;
    for (let i = 0; i < root.children.length; i++) {
        const sub = pathTo(root.children[i], target);
        if (sub !== null) return [i, ...sub];
    }
    return null;
}

/** 按路径取节点;[][] 就是根。路径不合法返回 null。 */
export function nodeAtPath(root, path) {
    let node = root;
    for (const i of path) {
        if (!isSplit(node)) return null;
        node = node.children[i];
        if (node === undefined) return null;
    }
    return node ?? null;
}

function pathToPane(root, id) {
    const leaf = findPane(root, id);
    if (!leaf) return null;
    return pathTo(root, leaf);
}

/** 布局树文本(给用户看的"证据")。 */
export function formatTree(tree, titles = {}) {
    const label = (id) => (titles && typeof titles[id] === 'string' && titles[id]) ? titles[id] : id;
    // ⚠️ 这份文本**刻意不打印 tabs/active**:它是用户与自检共用的那份"证据"
    // (工作台底部那条读数、设置页的布局树、以及一串逐字断言都读它),
    // 多一个字段就会让所有既有读数在一夜之间变样,而"标签页"这件事本身在下一个单元
    // 有它自己的界面(标签条)。这里只保证:新增字段**不影响**这棵树的形状读数。
    const text = (n) => {
        if (isPane(n)) return label(n.id);
        if (!isSplit(n)) return '?';
        const sizes = n.sizes.map((s) => `${Math.round(s)}%`).join(' / ');
        return `{${n.dir} ${sizes}}[ ${n.children.map(text).join(' , ')} ]`;
    };
    try {
        return text(tree);
    } catch {
        return '(布局树不可读)';
    }
}

/**
 * 契约 v4 的**验收判据** —— 取代 `paneSetMatches` 的"叶子 id 与 known 一一对应"。
 *
 * ⚠️ 为什么必须换掉:`paneSetMatches` 用**叶子数**当判据。一枚标签被拖进另一格之后,
 * 叶子天然少一个(源槽位空了就消失),于是重启时这份**完全正常**的档会被判成坏档,
 * 用户的布局被静默打回默认。v4 里"叶子数 ≠ 视图数"是常态,判据必须改问**标签**:
 *
 *   1. 每个槽位 id 非空且**全局唯一**(v4 里 id 只是槽位键,不再要求等于视图名);
 *   2. 每条标签的 `view` 都在已注册视图里(上一步 normalizeTabs 过滤过,这里复核);
 *   3. 每个必需的内建 / 已激活插件视图**至少存在一个标签实例**;
 *   4. 全部标签实例按 `tabKey` **全局唯一**(同一枚标签不许出现在两格里)。
 *
 * 返回 `{ ok, problems }`。**绝不抛**:它是给存档层做"要不要退回默认"的最后一道判断。
 */
export function validateLayout(tree, knownIds = DEFAULT_PANE_IDS, requiredIds = knownIds) {
    const known = (Array.isArray(knownIds) ? knownIds : [])
        .filter((id) => typeof id === 'string' && id.length > 0);
    const required = (Array.isArray(requiredIds) ? requiredIds : known)
        .filter((id) => known.includes(id));
    const problems = [];
    try {
        if (!isPane(tree) && !isSplit(tree)) return { ok: false, problems: ['形状不是布局树'] };
        if (countPanes(tree) === 0) problems.push('树里一个槽位都没有');
        // ① 槽位 id 唯一
        const ids = listPaneIds(tree);
        if (new Set(ids).size !== ids.length) problems.push(`槽位 id 有重复:${ids.join(' / ')}`);
        // ② / ④ 标签视图与实例身份
        const seen = new Map();
        const views = new Set();
        const walk = (node) => {
            if (isPane(node)) {
                for (const tab of (Array.isArray(node.tabs) ? node.tabs : [])) {
                    const key = tabKey(tab);
                    if (key === '') { problems.push(`槽位 ${node.id} 里有一条读不懂的标签`); continue; }
                    const where = seen.get(key);
                    if (where !== undefined) problems.push(`标签实例重复:${key} 同时出现在 ${where} 与 ${node.id}`);
                    else seen.set(key, node.id);
                    if (!known.includes(tab.view)) problems.push(`槽位 ${node.id} 里的视图没有注册:${tab.view}`);
                    views.add(tab.view);
                }
                return;
            }
            if (isSplit(node)) for (const c of node.children) walk(c);
        };
        walk(tree);
        // ③ 每个必需视图至少一枚标签(少了就意味着"有个面板没有归宿",界面上它会整片消失)
        const missing = required.filter((id) => !views.has(id));
        if (missing.length > 0) problems.push(`这些视图没有标签实例:${missing.join(' / ')}`);
    } catch (err) {
        problems.push(`校验时抛错:${err?.message ?? err}`);
    }
    return { ok: problems.length === 0, problems };
}

/**
 * 只把**视图**补进树:缺的那个视图做成单视图槽位挂到最外层那一行的末尾。
 *
 * ⚠️ 为什么不能直接用 `adoptPanes`:它的判据是"**面板 id** 在不在树上",
 * 而契约 v4 里槽位 id 与视图名已经解耦 —— 一个叫 `doc` 的槽位里可能装着别的标签,
 * 也可能被归一化整格丢掉。`adoptPanes` 会看到"doc 这个 id 在树上"就跳过,
 * 于是**一个标签实例都没有的视图**永远补不回来(实测:归一化喂它
 * `[notes, {doc 槽位(空)}, col[links, ai]]`,它会原样返回,validateLayout 报
 * "这些视图没有标签实例:doc" → 整棵树退回默认 —— 而 v4 要的是那一格收拢、doc 补回来)。
 * 所以这里按**标签视图**判,与 normalizeTree 的上层判据同一口径。
 *
 * 它也**不**看"外来 id":能走到这里的树已经是归一化过的,槽位 id 是 `slot:<序号>`
 * 完全正常 —— 那件事在 v4 里不该再被当成坏档(见 normalizeTree 的注释)。
 */
function readdMissingViews(tree, known) {
    const have = new Set();
    for (const key of tabKeysOf(tree)) {
        const at = key.indexOf('\u0000');
        have.add(at < 0 ? key : key.slice(0, at));
    }
    const missing = known.filter((id) => !have.has(id));
    if (missing.length === 0) return tree;
    const fresh = missing.map((id) => pane(id));
    if (isSplit(tree)) {
        return {
            dir: tree.dir,
            sizes: normalizeSizes([...tree.sizes, ...new Array(fresh.length).fill(null)], tree.children.length + fresh.length),
            children: [...tree.children, ...fresh],
        };
    }
    return split('row', null, [tree, ...fresh]);
}

/**
 * 存档 → 树。**绝不抛**,读不懂一律退回默认树。
 *
 * 规则(契约 v4):
 *   · 未知视图的标签丢掉(不可渲染,与插件被卸掉同一条安全规则);
 *   · 槽位 id 重复 → 后来的那一格丢掉;丢掉 / 过滤之后空掉的槽位**收拢**(不留空面板);
 *   · **绝不按 `pane.id` 补回单视图**(见 pane 的第四参注释);
 *   · 缺掉的必需视图 → 补回来(单视图槽位),而不是把整棵树打回默认;
 *   · 真的修不好(形状就不对 / 一个槽位都留不下)→ 退回默认树。
 *
 * ⚠️ 最后那条"退回默认"从前是"叶子 id 与 known 对不上就退回",那是 v3 的口径;
 * v4 下它只留一个作用:形状彻底不可读时的安全网。
 */
export function normalizeTree(saved, knownIds = DEFAULT_PANE_IDS, requiredIds = knownIds) {
    const known = (Array.isArray(knownIds) ? knownIds : [])
        .filter((id) => typeof id === 'string' && id.length > 0);
    const required = (Array.isArray(requiredIds) ? requiredIds : known)
        .filter((id) => known.includes(id));
    // 退回默认树。known 不是默认那几个时,按 known 的顺序造一行(数量可能不同)。
    const fallback = () => {
        // ⚠️ 用**集合**比较而不是逐位相等:外壳那个 `panes` 对象的键序是主进程/渲染层的
        // 书写顺序,不该决定"这是不是默认面板集合"(它一变就会悄悄退回一行横排,
        // 默认的"链接与 AI 叠在右侧"就没了)。
        const isDefault = required.length === DEFAULT_PANE_IDS.length
            && DEFAULT_PANE_IDS.every((id) => required.includes(id));
        if (isDefault || required.length === 0) return defaultTree();
        return { dir: 'row', sizes: normalizeSizes(null, required.length), children: required.map((id) => pane(id)) };
    };
    try {
        let nextAuto = nextSlotSeq(saved);
        /**
         * 一个槽位的 id 用哪个。空 id / 撞名 → 补 `slot:<序号>`(最多补 200 次,防脏档死循环)。
         * ⚠️ 补号**排在最后**做:去重与收拢都会丢掉槽位,先发号会让留下来的格子拿到
         * 又大又乱的号(`slot:5`、`slot:7`)。在最终那棵树上发号,序号才与"现有几格"对得上。
         */
        const assignIds = (node, used) => {
            if (isPane(node)) {
                let id = typeof node.id === 'string' ? node.id : '';
                if (id === '' || used.has(id)) {
                    for (let i = 0; i < 200 && (id === '' || used.has(id)); i += 1) id = `slot:${nextAuto++}`;
                }
                if (id === '' || used.has(id)) return null;
                used.add(id);
                return { type: 'pane', id, tabs: node.tabs, active: node.active };
            }
            if (!isSplit(node)) return null;
            const kids = [];
            const keptSizes = [];
            node.children.forEach((child, i) => {
                const next = assignIds(child, used);
                if (next === null) return;
                kids.push(next);
                const raw = Array.isArray(node.sizes) ? node.sizes[i] : NaN;
                keptSizes.push(raw);
            });
            if (kids.length === 0) return null;
            if (kids.length === 1) return kids[0];
            return { dir: node.dir, sizes: normalizeSizes(keptSizes, kids.length), children: kids };
        };
        /**
         * 去掉空槽位、折叠单孩子的分割,并按留下的孩子重新归一化比例
         * (「绝不留空面板 + 每层比例和恒为 100」的树形那一半)。
         */
        const pruneTreeSizes = (n) => {
            if (isPane(n)) return (Array.isArray(n.tabs) && n.tabs.length > 0) ? n : null;
            if (!isSplit(n)) return null;
            const kids = [];
            const sizes = [];
            n.children.forEach((child, i) => {
                const next = pruneTreeSizes(child);
                if (next === null) return;
                kids.push(next);
                const raw = Array.isArray(n.sizes) ? Number(n.sizes[i]) : NaN;
                sizes.push(Number.isFinite(raw) && raw > 0 ? raw : null);
            });
            if (kids.length === 0) return null;
            if (kids.length === 1) return kids[0];
            return { dir: n.dir, sizes: normalizeSizes(sizes, kids.length), children: kids };
        };
        /**
         * 每个槽位的**形状级**归一化:只是"把 labels 规整一下",**不做**去重(去重要看全树)。
         * tabs 不是数组(v2 旧节点)→ 单视图(与 pane() 的缺省口径一致,这里显式写出来,
         * 因为后面那趟全局去重不再经过 pane())。
         */
        const clean = (node) => {
            if (isPane(node)) {
                // ⚠️ `tabs` 不是数组(没有这个字段)是**旧档节点**的形状,语义是"这一格就是这个
                // 视图本身" —— 补一枚 `{view: id}`(与 pane() 的缺省口径一致)。
                // ⚠️ 显式 `tabs: []` 是另一件事(用户把最后一条也关掉了),原样保留空 tabs,
                // 由下面的 prune 收拢掉。
                if (!Array.isArray(node.tabs)) return pane(node.id);
                const knownTabs = node.tabs.filter((raw) => cleanTab(raw) !== null && known.includes(cleanTab(raw).view));
                const wantKey = knownTabs.length === 0 ? ''
                    : tabKey(knownTabs[Math.min(Math.max(0, Math.floor(Number(node.active)) || 0), knownTabs.length - 1)]);
                return { type: 'pane', id: node.id, tabs: knownTabs, wantKey };
            }
            if (!node || typeof node !== 'object') return null;
            if (node.dir !== 'row' && node.dir !== 'col') return null;
            if (!Array.isArray(node.children)) return null;
            const kids = node.children.map((child) => clean(child)).filter(Boolean);
            if (kids.length === 0) return null;
            if (kids.length === 1) return kids[0];            // 单孩子的分割没有意义 → 折叠
            return {
                dir: node.dir,
                sizes: normalizeSizes(Array.isArray(node.sizes) ? node.sizes : [], kids.length),
                children: kids,
            };
        };
        /**
         * **全树去重**(契约 v4 的硬约束:一枚标签实例只能出现在一格)
         * + 每个槽位的 active 落定 + 丢掉空槽位、折叠单孩子的分割。
         *
         * 去重的优先级是本节最绕的一处,单独说清:
         *   1. 先归"**以这个视图名当槽位名**"的那一格(一个叫 `ai` 的格子就是"AI 面板"),
         *      它是这个视图的天然归宿;
         *   2. 同一优先级内按深度优先(界面从左到右、从上到下),先到先得。
         * ⚠️ 这个先后**不能反**:反过来的话,`pane('doc',[{view:'ai'}])` 会先把 ai 抢走,
         *    于是 `pane('ai')` 被剥成空、整格收拢消失 —— 实测默认结构里"AI 面板"就这么
         *    凭空少了(而且树形断言仍看得过去:只是少了一格)。
         * 反过来,"同名格优先"唯一会牺牲的是"某个内容型格子里的同名标签",那正是
         * `moveTabToPane` 之后该有的形状:标签进了目标格,它自己的原格空掉、收拢。
         */
        const dedupAndPrune = (root) => {
            const panes = [];
            const walk = (n) => {
                if (isPane(n)) { panes.push(n); return; }
                if (isSplit(n)) n.children.forEach(walk);
            };
            walk(root);
            const owner = (paneNode, key) => key === '' ? false : (key === paneNode.id || key.startsWith(`${paneNode.id}\u0000`));
            const used = new Set();
            // ⚠️ 两趟去重都必须看**同一份原始标签**,不能在原地改 `p.tabs` ——
            // 第一趟写回之后第二趟就读不到东西了(实测:默认树走一趟归一化,
            // 所有格子的标签全变成空的,整棵树被收拢成一个 `fallback()`)。
            // 所以先把每个格子的原始名单、它的"同名归属"和活动标签抄下来,最后一次性写回。
            const plan = panes.map((p) => ({
                pane: p,
                src: (Array.isArray(p.tabs) ? p.tabs : []).map((tab) => ({ tab, key: tabKey(tab) })),
                wantKey: p.wantKey,
            }));
            const owners = new Map(plan.map((it) => [it, it.src.some((t) => owner(it.pane, t.key))]));
            const pass = (wantOwner) => {
                for (const it of plan) {
                    if (owners.get(it) !== wantOwner) continue;    // 这一趟还没轮到它,留给下一趟
                    const kept = [];
                    for (const { tab, key } of it.src) {
                        if (key === '' || used.has(key)) continue;
                        used.add(key);
                        kept.push(tab);
                    }
                    it.kept = kept;
                }
            };
            pass(true);                  // 先满足"同名"格子(视图的天然归宿)
            pass(false);                 // 剩下的才轮到"内容型"格子
            for (const it of plan) {
                it.pane.tabs = it.kept ?? [];
                it.pane.active = it.pane.tabs.length === 0 ? 0
                    : Math.max(0, it.pane.tabs.findIndex((t) => tabKey(t) === it.wantKey));
                delete it.pane.wantKey;
            }
            return pruneTreeSizes(root);
        };
        let tree = clean(saved);
        if (!isPane(tree) && !isSplit(tree)) return fallback();
        tree = dedupAndPrune(tree);
        if (!isPane(tree) && !isSplit(tree)) tree = null;
        // 缺掉的必需视图:按**标签视图**补回来(不是按槽位 id,见 readdMissingViews)
        const readded = tree === null ? null : readdMissingViews(tree, required);
        if (readded !== null && readded !== tree) tree = dedupAndPrune(clean(readded) ?? readded);
        if (!isPane(tree) && !isSplit(tree)) return fallback();
        const usedIds = new Set();
        const finalTree = pruneTreeSizes(assignIds(tree, usedIds));
        if (!isPane(finalTree) && !isSplit(finalTree)) return fallback();
        if (!validateLayout(finalTree, known, required).ok) return fallback();
        return finalTree;
    } catch {
        return fallback();
    }
}

/**
 * 摘掉一片叶子。
 *
 * 父节点只剩一个孩子时把它**折叠掉**:幸存者顶替父节点在祖父里的那一格,
 * 祖父那一格的比例**保持不变** —— 于是旁边的面板恰好占满腾出来的那块
 * (demo 里"拖走一个面板,旁边的自动占满")。
 *
 * ⚠️ demo 的实现在这里把它写成了 `父比例 + 幸存者比例`(见 demo 的 detach)。
 * 那是错的量纲:幸存者的比例是**相对父节点**的,父节点的比例是**相对祖父**
 * 的,相加之后整层的权重和会超过 100,渲染出来就是**不相关的面板也跟着变**。
 * 实测(照 demo 的字面实现):从右列摘走一片,左列会从 24% 缩到 17%。
 * 这里按 demo 自己注释里写的"继承祖父里的位置与比例"实现。
 *
 * @returns {{tree:object|null, leaf:object}|null} 找不到 id 返回 null;
 *          整棵树就是这一片时 tree 为 null。
 */
export function detach(tree, id, { space = 'proportional' } = {}) {
    const path = pathToPane(tree, id);
    if (path === null) return null;
    const leaf = cloneTree(nodeAtPath(tree, path));
    if (path.length === 0) return { tree: null, leaf };
    const next = cloneTree(tree);
    const parentPath = path.slice(0, -1);
    const parent = nodeAtPath(next, parentPath);
    if (!isSplit(parent)) return null;
    const index = path[parentPath.length];
    const removedSize = parent.sizes[index];      // 「整块给邻居」要把这份加回去,先留一手
    parent.children.splice(index, 1);
    parent.sizes.splice(index, 1);
    // 剩下的兄弟按原来的权重比例重新归一化 —— 渲染结果完全一样(flex-grow 只看
    // 相对值),但"每层比例和恒为 100"这条不变量保住了,底下那行"布局树"证据
    // 才不会出现 19% / 62%(和 81%)这种看着就像坏了的读数。
    if (parent.children.length >= 2) {
        if (space === 'neighbor') {
            // 「整块给邻居」(方案 B,用户选的):腾出来的那份**加给相邻那一格**
            // (优先左边,没有左边就给右边),其余格的比例**一个字不动**。
            // ⚠️ 与默认的 proportional 是**可测的不同**:40/35/25 摘掉 35 →
            //    proportional = 61.5 / 38.5(两格都变大);neighbor 里左邻的 40 拿到
            //    35 那一整份 = 75,links 的 25 一个字不动。
            //
            // ⚠️ **不要把兄弟们先按 `100/(100-removedSize)` 放大再加**(这里曾经这么做)。
            //    本层的权重之和**恒为 100**(normalizeSizes 的不变量),`removedSize`
            //    本身就是"这一层里的百分比";拿掉 d 之后 a+b+c 恰好等于 100-d,
            //    把 d 加回给邻居就又回到 100 —— 基准**本来就是对齐的**,不需要换算。
            //    多乘那一次等于把腾出来的空间**发了两遍**:未涉及的格也被撑大。
            //    实测(默认布局 `[17/45/19/19]` 里关掉「短剧画布」那一格):
            //    读数变成 `{row 20% / 60% / 20%}`,左邻 **和右侧那两格**的像素宽度
            //    全都变了(自检 ★③ 的 `othersGrew=["notes","links","ai"]`),
            //    直接违反规格 §4.3 第 6 条「不改变未涉及分支的比例」与 §7 第 2 条
            //    「**只**把腾出空间给相邻槽位」。改回"直接相加"之后:
            //    邻居涨的像素 == 被摘掉那格的像素(±1),其余格逐像素不动。
            const left = index - 1;
            const target = left >= 0 ? left : Math.min(index, parent.children.length - 1);
            parent.sizes[target] += removedSize;
        }
        parent.sizes = normalizeSizes(parent.sizes, parent.children.length);
    }
    if (parent.children.length === 1) {
        const survivor = parent.children[0];
        if (parentPath.length === 0) return { tree: survivor, leaf };
        const grand = nodeAtPath(next, parentPath.slice(0, -1));
        if (!isSplit(grand)) return { tree: next, leaf };
        grand.children[parentPath[parentPath.length - 1]] = survivor;
        // grand.sizes 那一格不动 —— 幸存者顶替父节点的位置与比例
    }
    return { tree: next, leaf };
}

/**
 * 把**一枚标签**从一片面板搬到另一片面板上(拖标签跨面板的那条规则)。
 *
 * 为什么单独一个纯函数:这件事的难点全在"树怎么变",而不是指针怎么走 ——
 * 插到第几枚、目标那一格当前显示哪一枚、**源格空了之后它怎么消失**。
 * 把它做成纯函数就能用 node --test 钉住,不必等真窗口里拖一次。
 *
 * 规则(与用户选定的方案 B 一致):
 *   · 插入位置由调用方给出(`insertAt`;`null` = 追加到末尾);
 *   · 目标格把新来的那枚设为**当前显示**(`active`),否则用户搬完看不到它;
 *   · **源格空了就摘掉整格**,腾出的空间按 `space` 分给邻居(默认 neighbor = 整块给相邻那格)。
 *     「不允许空面板」这条规则就落在这里 —— 它是**同一条**路径,不另写一份。
 *   · 源格没空 → 比例、树形一个字不动(只动 tabs/active)。
 *
 * @returns {object|null} 新树;参数不成立 / 找不到 id 时返回 null(调用方原样保持旧树)
 */
export function moveTabToPane(tree, fromId, index, toId, insertAt = null, { space = 'neighbor' } = {}) {
    if (!fromId || !toId || fromId === toId) return null;
    const next = cloneTree(tree);
    if (!next) return null;
    const from = findPane(next, fromId);
    const to = findPane(next, toId);
    if (!from || !to) return null;
    const fromTabs = Array.isArray(from.tabs) ? from.tabs : [];
    if (!Number.isInteger(index) || index < 0 || index >= fromTabs.length) return null;
    const [moved] = fromTabs.splice(index, 1);
    // 搬走的若是它当前显示的那一枚(或它前面的),当前下标要跟着挪,否则会指向别人
    const fromActive = Number.isInteger(from.active) ? from.active : 0;
    from.active = Math.min(
        index < fromActive ? fromActive - 1 : fromActive,
        Math.max(0, fromTabs.length - 1),
    );
    const toTabs = Array.isArray(to.tabs) ? to.tabs : [];
    const at = insertAt === null || insertAt === undefined
        ? toTabs.length
        : Math.max(0, Math.min(insertAt, toTabs.length));
    toTabs.splice(at, 0, moved);
    to.active = at;                       // 搬完就显示它 —— 不然用户以为搬丢了
    from.tabs = fromTabs;
    to.tabs = toTabs;
    if (fromTabs.length > 0) return next;
    // 「不允许空面板」:源格空了就摘掉它,空间按 space 交给邻居(见 detach)
    const out = detach(next, fromId, { space });
    if (out === null || out.tree === null) return null;
    return out.tree;
}

/**
 * 把**一枚已经造好的标签叶**插到锚点旁边(`addPane` 与 `moveTabToEdge` 共用这一条)。
 *
 * ⚠️ 为什么抽出来给两处用:单标签边缘停靠(v4)与「窗口」菜单加一格**必须**长出同一种
 * 形状 —— 新格占的那份比例只从锚点那一份里切走,其余格一个字不动。
 * 抄成两份的话,"锚点左右哪一侧、方向不同时怎么嵌"迟早会在两条路上给出不同答案
 * (而这两条路用户都会走到)。纯函数:不改入参树(`cloneTree` 在内部做)。
 *
 * @param {object} tree 旧树(可以是 null = 空树)
 * @param {object} fresh 新叶(必须已经带好 id 与 tabs)
 * @returns {object|null} 认不出锚点时 null(调用方保持旧树)
 */
function placeLeafNear(tree, fresh, anchorId, dir, side, share) {
    if (!isPane(fresh)) return null;
    if (tree === null || tree === undefined) return fresh;                 // 空树 → 就这一格
    const first = listPaneIds(tree)[0];
    const path = pathToPane(tree, anchorId === '' ? first : anchorId);
    if (path === null) return null;
    const next = cloneTree(tree);
    const pct = Math.min(80, Math.max(10, Number(share) || 30));
    const before = side === 'left' || side === 'top';
    if (path.length === 0){
        return split(dir, before ? [pct, 100 - pct] : [100 - pct, pct],
            before ? [fresh, next] : [next, fresh]);
    }
    const parent = nodeAtPath(next, path.slice(0, -1));
    const index = path[path.length - 1];
    if (isSplit(parent) && parent.dir === dir){
        const take = parent.sizes[index] * (pct / 100);
        parent.sizes[index] -= take;
        parent.children.splice(before ? index : index + 1, 0, fresh);
        parent.sizes.splice(before ? index : index + 1, 0, take);
        parent.sizes = normalizeSizes(parent.sizes, parent.children.length);
        return next;
    }
    const anchorLeaf = parent.children[index];
    parent.children[index] = split(dir, before ? [pct, 100 - pct] : [100 - pct, pct],
        before ? [fresh, anchorLeaf] : [anchorLeaf, fresh]);
    return next;
}

/**
 * 往树上**新加一格**(「窗口」菜单点一条视图 = 窗口里多出一格,而不是往现有格子里塞标签)。
 *
 * 落点:锚点那一格的旁边(默认右/下)。新格占的那份比例**从锚点那份里切走**(`share` %),
 * 所以其余格的比例一个字不动 —— 与「搬标签跨面板」选定的那条空间规则同源(都只动邻近的)。
 *
 * 两种情形:
 *   · 锚点所在父节点的方向与要加的方向**相同** → 直接插成兄弟,从树形上不多一层嵌套
 *     (用户看到的就是"右边多了一格",而不是"整块被再切一刀");
 *   · 方向不同 / 锚点就是整棵树 → 把锚点整格换成一个新的两格 split,锚点自身的位置与
 *     比例不变,新格从它里面切 —— 这样"锚点在哪儿就长在哪儿",不会把布局整体重排。
 *
 * ⚠️ 这里**不校验**视图在不在注册表里 —— 本模块没有那份表(与 normalizeTabs 要 knownIds
 * 是同一个道理)。调用方(「窗口」菜单)递进来的必须是注册表里的 id。
 * ⚠️ 契约 v4:`pane.id` 是**槽位 id**、不再等价于视图名,所以新格的 id 这里仍取视图名
 * (菜单那条路是"视图第一次出现",不会撞名);而"单标签边缘停靠"那条路必须用
 * `slot:<序号>`(见 moveTabToEdge),因为拆出来的那枚标签可能是同一视图的第二篇文档。
 *
 * @returns {object|null} 新树;参数不成立 / 认不出锚点 → null(调用方保持旧树)
 */
export function addPane(tree, view, { anchorId = '', dir = 'row', side = 'right', share = 30, paneId = null } = {}) {
    if (typeof view !== 'string' || view === '') return null;
    // 槽位 id:默认拿视图名(存档里 `notes` / `drama` / `ai` 就是这么来的),但**撞名就发号**。
    // ⚠️ 撞名的场景是真实存在的:v4 起 id 只是槽位键,一个叫 `drama` 的格子完全可能装着别的视图
    //    (实测用户档:`drama` 格装的是「笔记正文」、短剧画布住在 `slot:3`)。
    //    这时若还硬用视图名当新格子的 id,树上就会出现两个 `drama` —— 布局存档当场坏掉。
    let id = (typeof paneId === 'string' && paneId !== '') ? paneId : view;
    if (listPaneIds(tree).includes(id)) id = `slot:${nextSlotSeq(tree)}`;
    const fresh = pane(id, [{ view }], 0);
    if (!isPane(fresh)) return null;
    return placeLeafNear(tree, fresh, anchorId, dir, side, share);
}

/**
 * **单标签边缘停靠**(契约 v4,规格 §4.3):把**一枚标签**从源槽位搬到目标槽位的某一侧,
 * 为它新建一个只装这一枚的槽位。
 *
 * ⚠️ 为什么必须与 `dropOnEdge` 分开:`dropOnEdge` 搬的是**整片叶子**(整组面板)——
 * "拖标题栏 / 抓手把一整片面板搬到别处"正是本次规格**明令禁止**的手势。
 * 两者名字像、形状也像,但一个是"一枚标签",一个是"一格面板",绝不能让前者借后者的实现。
 *
 * 步骤(规格 §4.3 逐条对应):
 *   1. 校验源/目标槽位、标签下标与边方向(任一不成立返回 null,调用方保持旧树);
 *   2. 从源 `tabs` 移除那一枚并修正源 `active`(取走 active 之前的那枚 → 顺移;
 *      取走 active 本身 → 落在同一个下标上,也就是"下一枚顶上来");
 *   3. 新建只含该标签的槽位(`active: 0`,槽位 id 用 `slot:<序号>` 保证全树唯一);
 *   4. 把该槽位插到目标的四边(left/right → row,top/bottom → col);
 *   5. 源槽位空了 → 沿用 `detach(..., { space: 'neighbor' })` 折叠它,空间整块给邻居;
 *   6. 未涉及分支的比例一个字不动。
 *
 * 源槽位就是整棵树、而且它还剩标签时,新槽位包在**外面**(`{row:[源, 新]}`)——
 * 与 `addPane` 那条路同形,源槽位仍然是一个独立可拖的格子。
 *
 * @returns {object|null} 新树;参数不成立 / 找不到槽位 / 边方向非法 → null
 */
export function moveTabToEdge(tree, fromId, index, targetId, side) {
    if (!fromId || !targetId || fromId === targetId) return null;
    if (side !== 'left' && side !== 'right' && side !== 'top' && side !== 'bottom') return null;
    const next = cloneTree(tree);
    if (!next) return null;
    const from = findPane(next, fromId);
    if (!findPane(next, targetId)) return null;
    if (!from) return null;
    const fromTabs = Array.isArray(from.tabs) ? from.tabs : [];
    if (!Number.isInteger(index) || index < 0 || index >= fromTabs.length) return null;
    const [moved] = fromTabs.splice(index, 1);
    // 取走的是它当前显示的那一枚(或它前面的),当前下标要跟着挪,否则会指向别人 ——
    // 与 moveTabToPane 用的是**同一条**算术(两处口径必须一致)
    const fromActive = Number.isInteger(from.active) ? from.active : 0;
    from.active = Math.min(
        index < fromActive ? fromActive - 1 : fromActive,
        Math.max(0, fromTabs.length - 1),
    );
    from.tabs = fromTabs;
    // 新槽位:`slot:<序号>` —— 全树唯一,与视图名无关(见 nextSlotSeq)
    const freshId = `slot:${nextSlotSeq(next)}`;
    const fresh = pane(freshId, [moved], 0);
    // ⚠️ 顺序要害:先把新槽位插进目标那一侧,**再**折叠空掉的源槽位。
    // 反过来的话(先折叠、后插入),摘掉源之后那一层就只剩"目标 +(新槽位)"两格,
    // 而新槽位是后来加的、会被算成"目标那一份里切走的 30%"—— 目标于是白拿源腾出的空间,
    // 源的空间**没有整块给邻居**。实测(先折叠):`{row 51/26}[源 目标]` 拆完变成
    // `{row 90/10}[目标 新]`;按正确顺序是 `{row 70/30}[目标 新]`。
    // 这也是"未涉及分支的比例一个字不动"能被守住的唯一顺序。
    const withFresh = placeLeafNear(next, fresh, targetId,
        side === 'left' || side === 'right' ? 'row' : 'col', side, 30);
    if (withFresh === null) return null;
    if (fromTabs.length > 0) return withFresh;
    // 「不允许空面板」:源槽位空了就摘掉它,空间按 neighbor 交给邻居(与搬标签跨面板同一条)。
    // ⚠️ 这里**不需要**单独处理"源槽位就是整棵树":那要求目标也是它自己(树里只有这一格),
    //    而 fromId === targetId 在最前面就已经返回 null 了。规格 §4.3 第 5 步要的
    //    "折叠"因此只在"源还有邻居"时发生,与 `detach` 的契约(整棵树就是这一片时
    //    `tree: null`)正好对得上。
    const out = detach(withFresh, fromId, { space: 'neighbor' });
    if (out === null || out.tree === null) return null;
    return out.tree;
}

/**
 * 中间落点 = 两片**换位**:树形与比例一点不动,换的是"这两片是谁"。
 *
 * ⚠️ 换的是**整片面板**(id + 标签结构),不是只有 id:标签属于这一片面板,只换 id 会
 * 让"写着甲篇的那个标签"留在原地却挂到另一片面板的 id 上 —— 存档里就出现
 * "面板 id 与它自己的标签对不上"的树,下一次启动界面张冠李戴。
 * 单视图的面板(id 就是它唯一的标签)行为与从前逐字段一致。
 */
export function swapPanes(tree, aId, bId) {
    if (!aId || !bId || aId === bId) return tree;
    const next = cloneTree(tree);
    if (!next) return tree;
    const a = findPane(next, aId);
    const b = findPane(next, bId);
    if (!a || !b) return tree;
    const id = a.id;
    a.id = b.id;
    b.id = id;
    const tabs = a.tabs;
    a.tabs = b.tabs;
    b.tabs = tabs;
    const active = a.active;
    a.active = b.active;
    b.active = active;
    return next;
}

/**
 * 一侧落点:先摘出来,再按方向插到目标旁边。
 * left/right → row 分割;top/bottom → col 分割。
 */
export function dropOnEdge(tree, fromId, targetId, side) {
    if (!targetId || !fromId || fromId === targetId) return tree;
    const horizontal = side === 'left' || side === 'right';
    if (!horizontal && side !== 'top' && side !== 'bottom') return tree;
    const detached = detach(tree, fromId);
    if (!detached || detached.tree === null) return tree;     // 它是唯一一片:没地方可挪
    const next = detached.tree;
    const targetPath = pathToPane(next, targetId);
    if (targetPath === null) return tree;
    const target = nodeAtPath(next, targetPath);
    const pair = horizontal
        ? split('row', [50, 50], side === 'left' ? [detached.leaf, target] : [target, detached.leaf])
        : split('col', [50, 50], side === 'top' ? [detached.leaf, target] : [target, detached.leaf]);
    if (targetPath.length === 0) return pair;
    const parent = nodeAtPath(next, targetPath.slice(0, -1));
    if (!isSplit(parent)) return tree;
    parent.children[targetPath[targetPath.length - 1]] = pair;
    return next;
}

/**
 * 拖到窗口最底部那条带 = 整宽底栏:整棵树被 `{col:[原树, 被拖]}` 包起来。
 *
 * ⚠️ 契约 v4 起这条手势**已经不用了**(规格 §4 末尾:底部整宽停靠带要么只接受单标签、
 * 要么删掉;产品侧选了删除 —— 见 panel-workspace.js)。函数留在这里是给旧调用方与
 * 单测/存档回归用的,但它有一个必须在的地方:
 * ⚠️ 摘出来的那片叶子**必须**是深拷贝。`detach` 会把摘掉的那片从幸存树上剪下去,
 *    若 `detached.leaf` 与幸存树是同一个引用,v4 的"一枚实例只能出现在一格"当场被破坏
 *    (实测:默认树走一趟 dockBottom,`ai` 同时出现在底栏与右栏里,解码时被去重收拢、
 *    树形变样)。从前的代码没炸只是因为没人做全树实例去重。
 */
export function dockBottom(tree, fromId) {
    const detached = detach(tree, fromId);
    if (!detached || detached.tree === null) return tree;
    return split('col', BOTTOM_DOCK_SIZES, [detached.tree, cloneTree(detached.leaf)]);
}

/**
 * 拖分隔条:只改相邻两片的比例,**其余片一个都不动**,两片之和不变,
 * 并且各自保底 MIN_RATIO%。
 *
 * @param {object} tree
 * @param {object|number[]} nodeOrPath 分割节点本身,或它的下标路径
 *        (拖动过程中树会被换成新对象,所以调用方持有**路径**更稳)
 * @param {number} index 分隔条左边的那个孩子的下标
 * @param {number} nextSize 左边那片的新比例(绝对值,与同层其它比例同单位)
 */
export function setPairRatio(tree, nodeOrPath, index, nextSize, { minRatio = MIN_RATIO } = {}) {
    const path = Array.isArray(nodeOrPath) ? nodeOrPath : pathTo(tree, nodeOrPath);
    if (path === null) return tree;
    const target = nodeAtPath(tree, path);
    if (!isSplit(target)) return tree;
    if (!Number.isInteger(index) || index < 0 || index + 1 >= target.children.length) return tree;
    const pair = target.sizes[index] + target.sizes[index + 1];
    const min = pair * (minRatio / 100);
    const v = Number(nextSize);
    if (!Number.isFinite(v)) return tree;
    const clamped = Math.min(Math.max(v, min), pair - min);
    const next = cloneTree(tree);
    const node = nodeAtPath(next, path);
    node.sizes[index] = round2(clamped);
    node.sizes[index + 1] = round2(pair - clamped);
    return next;
}

/**
 * 指针位移 → 相邻两片的新比例(纯数学)。
 *
 * pxA / pairPx 是**拖动开始时**实测的像素:左片的宽度与两片之和。
 * 两片之和在整个拖动中不变(分隔条只在它们之间移动),所以像素与比例
 * 是一一对应的 —— 这就是"拖 80px 就真的宽 80px"。
 */
export function pairSizesFromPx(sizes, index, pairPx, pxA, minRatio = MIN_RATIO) {
    const pair = sizes[index] + sizes[index + 1];
    if (!(pairPx > 0) || !(pair > 0)) return sizes.slice();
    const minPx = pairPx * (minRatio / 100);
    const a = Math.min(Math.max(pxA, minPx), pairPx - minPx);
    const out = sizes.slice();
    out[index] = round2(pair * (a / pairPx));
    out[index + 1] = round2(pair - out[index]);
    return out;
}

export function pairSizesFromDrag(sizes, index, pairPx, pxAStart, dx, minRatio = MIN_RATIO) {
    const d = Number(dx);
    return pairSizesFromPx(sizes, index, pairPx, pxAStart + (Number.isFinite(d) ? d : 0), minRatio);
}

