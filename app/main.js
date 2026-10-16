// 必须是第一个 import:它负责把桥从临时全局收进模块作用域并抹掉那个名字。
// ES 模块按深度优先求值,所以放在第一行能保证它先于其他模块执行。
import { bridge } from './shell/bootstrap.js';
import { startStarfield } from './shell/starfield.js';
import { createRegistries } from './runtime/registries.js';
import { loadPlugins } from './runtime/loader.js';
import { createOnboarding } from './notes/onboarding.js';
import { createNotesView } from './notes/notes-view.js';
import { createAgentPanel } from './agent/panel.js';
import {
    createColumnResizer, clampWidth, shrinkToFit,
    DEFAULT_NAV_W, DEFAULT_SIDE_W, MIN_NAV_W, MAX_NAV_W, MIN_SIDE_W, MAX_SIDE_W,
} from './shell/column-resizer.js';
import { createPanelWorkspace, GUTTER_PX } from './shell/panel-workspace.js';
import { createPaneLifecycle } from './lib/pane-lifecycle.js';
import { treeFromWidths, adoptPanes, addPane, viewsOpenIn } from './lib/panel-tree.js';
// 「窗口」菜单那份面板表(已知视图 × 现在开着没有)——纯函数,带回归单测(用户档里"开着却没勾"那一条)。
import { splitPanelMenuTables } from './lib/panel-menu-table.js';
import { createLayoutStore, LAYOUT_KEY, LAYOUT_NAMESPACE } from './lib/panel-layout-store.js';
// 设置页那几个键与动效判据的**纯逻辑**(与主进程共用同一份常量,见 settings-page.js)。
import { SETTINGS_KEYS, SETTINGS_NS, motionOffFromSetting } from './lib/settings-page.js';
import { stage, stageError } from './lib/stage-log.js';
// 页面级 Ctrl+A 的判据(纯函数,单测钉着 —— 见 app/lib/select-all-guard.js 顶部)。
import { shouldBlockPageSelectAll } from './lib/select-all-guard.js';
// 拖拽总线:笔记列表拖动时把"正在拖什么"播出去;画布那类面板订阅它收素材。
import { setVaultRoot } from './lib/drag-bus.js';

const registries = createRegistries();
const fetchText = (url) => fetch(url).then(r => r.text());

function $(id) { return document.getElementById(id); }

/**
 * 「减少动态效果(强制关)」的执行者(设置页那个开关,以及启动时读一次设置)。
 *
 * 为什么是两件事:根属性 `html[data-motion="off"]` 给 CSS 那条全局规则看(它关掉
 * 所有动画/过渡);而星空是 canvas + requestAnimationFrame,**不吃 CSS** ——
 * 所以再派一个 `kaiwu:motion` 事件,由 shell/starfield.js 自己停/起。
 * ⚠️ 这里只**应用**,不写盘:写盘是设置页保存时的事。
 */
function applyMotionOff(off) {
    const root = document.documentElement;
    if (off === true) root.setAttribute('data-motion', 'off');
    else root.removeAttribute('data-motion');
    document.dispatchEvent(new CustomEvent('kaiwu:motion', { detail: { off: off === true } }));
}

/**
 * 笔记视图那一侧的接口(挂在模块作用域上,而不是从 boot() 往下传)。
 *
 * 为什么要这一层:`setupPanelWorkspace()` 要用笔记视图的两个能力 ——
 * "标签全名 = 笔记标题"与"某个 doc 标签成为当前标签 → 把编辑器切到那一篇";
 * 而笔记视图是在 `boot()` 里、**工作台之前**建出来的。两边互相需要,谁先建都不合适,
 * 于是在这里放一个明确的接线点:boot() 建完笔记视图就赋上去,工作台按需读。
 * 拿不到(还没建好)时一律当成"这会儿还不能用",绝不抛。
 */
let notesApi = null;

/**
 * 工作台那一侧的接口(同上一个理由:它比笔记视图**晚**建出来,而"点笔记 → 换标签"
 * 这件事发生在它建好之前就可能被触发 —— 例如自检脚本点得比启动快)。
 */
let workspaceApi = null;

/**
 * 侧栏宽度:从设置里读回来并接到两条分隔条上。
 *
 * 为什么放设置里而不是 localStorage:项目已经有设置存储(按命名空间分),
 * 渲染进程只能通过桥递叶子字段 —— 宽度是典型的用户偏好,重启该还在。
 * 读失败不致命(设置通道坏了不该让外壳起不来),退回默认宽度。
 */
async function setupColumnResizers() {
    const pane = $('paneNotes');
    if (!pane) return;
    const read = async (key, fallback) => {
        try {
            const v = await bridge.invoke('kaiwu:settings:get', { pluginId: '__global', key });
            return v ?? fallback;
        } catch { return fallback; }
    };
    const write = (key, value) => {
        bridge.invoke('kaiwu:settings:set', { pluginId: '__global', key, value })
            .catch((err) => console.warn('[shell] 保存侧栏宽度失败', err));
    };

    let navW = clampWidth(await read('ui.navWidth', DEFAULT_NAV_W), MIN_NAV_W, MAX_NAV_W, DEFAULT_NAV_W);
    let sideW = clampWidth(await read('ui.sideWidth', DEFAULT_SIDE_W), MIN_SIDE_W, MAX_SIDE_W, DEFAULT_SIDE_W);

    const apply = () => {
        pane.style.setProperty('--nav-w', `${navW}px`);
        pane.style.setProperty('--side-w', `${sideW}px`);
    };
    apply();

    createColumnResizer({
        handle: $('navResizer'), side: 'left', min: MIN_NAV_W, max: MAX_NAV_W,
        defaultWidth: DEFAULT_NAV_W,
        getWidth: () => navW,
        apply: (w) => { navW = w; apply(); },
        persist: (w) => write('ui.navWidth', w),
    });
    createColumnResizer({
        handle: $('sideResizer'), side: 'right', min: MIN_SIDE_W, max: MAX_SIDE_W,
        defaultWidth: DEFAULT_SIDE_W,
        getWidth: () => sideW,
        apply: (w) => { sideW = w; apply(); },
        persist: (w) => write('ui.sideWidth', w),
    });

    // 窗口变窄时把两栏按比例收回来 —— 否则中间的编辑器会被彻底挤没
    // (宽度存在设置里,换个小窗口打开就是必然发生的事,不能只靠拖动那一刻的夹取)
    const fit = () => {
        const next = shrinkToFit({ containerWidth: pane.clientWidth, navW, sideW });
        if (next === null) return;
        navW = clampWidth(next.navW, MIN_NAV_W, MAX_NAV_W, DEFAULT_NAV_W);
        sideW = clampWidth(next.sideW, MIN_SIDE_W, MAX_SIDE_W, DEFAULT_SIDE_W);
        apply();
        // 收回来这一下也存进去:下次打开就不必再收一次
        write('ui.navWidth', navW);
        write('ui.sideWidth', sideW);
    };
    window.addEventListener('resize', fit);
    fit();
}

/**
 * 平铺可停靠面板(工作台)。
 *
 * 四片真实面板(左列表 / 中编辑 / 右链接 / 右 AI)交给布局树,树从存档 v2 里读回来;
 * 没存过就用**旧的像素宽度**(ui.navWidth / ui.sideWidth)当权重造默认树 ——
 * 于是"从没拖过"的界面与改动前逐像素一致,窗口缩放则按比例走(规格要的就是这个)。
 * 旧档里的合并面板 `side`(反向链接 + AI)由布局树那层的迁移就地拆开,用户原本的排布保住。
 *
 * 两个坑都绕开了:
 *   ① 面板是**搬**进树叶子的同一批节点,不克隆 —— 笔记视图 / 编辑器 / AI 面板的
 *      引用与监听器全部照旧;本文件里没有一条 display:none(那一次"藏空壳"把
 *      搬进新容器的编辑器一起藏了,面板一片空白而结构断言全绿)。
 *   ② 必须在外壳**可见之后**才挂载:隐藏时量出来的尺寸是 0,分隔条的
 *      aria-valuemax 会变成 0(既有自检正好断言那条读数)。
 *
 * 挂载失败不致命:调用方会退回改动前的固定三栏兜底(.pane-notes 的 grid,四格依次排开)。
 */
async function setupPanelWorkspace() {
    const host = $('paneNotes');
    const desk = $('panelWorkspace');
    const stack = $('panelTree');
    if (!host || !desk || !stack) throw new Error('工作台骨架缺失(#panelWorkspace / #panelTree)');

    const read = async (key, fallback) => {
        try {
            const v = await bridge.invoke('kaiwu:settings:get', { pluginId: LAYOUT_NAMESPACE, key });
            return v ?? fallback;
        } catch { return fallback; }
    };
    const write = (key, value) => {
        bridge.invoke('kaiwu:settings:set', { pluginId: LAYOUT_NAMESPACE, key, value })
            .catch((err) => console.warn('[shell] 保存布局读数失败', err));
    };

    // 旧的两个像素宽度:既是默认树的权重,也是拖动后继续维护的那份读数(既有契约)。
    const navW = clampWidth(await read('ui.navWidth', DEFAULT_NAV_W), MIN_NAV_W, MAX_NAV_W, DEFAULT_NAV_W);
    const sideW = clampWidth(await read('ui.sideWidth', DEFAULT_SIDE_W), MIN_SIDE_W, MAX_SIDE_W, DEFAULT_SIDE_W);
    // 容器宽度 ≈ 视口宽度(笔记视图横跨整个 body)。拿不到就退回一个常见宽度 ——
    // 反正是**比例**,差几像素只影响默认树的权重,不影响窗口缩放。
    const viewportW = document.documentElement?.clientWidth || window.innerWidth || 1280;

    const panes = {
        // `short` = 标签第三级缩写。⚠️「笔记列表」与「笔记正文」同头(都是"笔记"),
        // 只看首字会双双退化成「笔」—— 设计稿正是用**人工挑过的**这一份区分它们的
        // (笔/正/剧/链/AI),所以按视图登记在这里,而不是让通用规则去猜。
        notes: { title: '笔记列表', short: '笔', el: document.querySelector('.notes-nav') },
        doc: { title: '笔记正文', short: '正', el: document.querySelector('.note-main') },
        // 窄面板里只放得下两三个字,所以标题取得短;全称挂在 .pw-name 的 title 上
        // (见 panel-workspace.js 的 fullTitle),读屏另有 aria-label。
        links: {
            title: '链接', short: '链', fullTitle: '反向链接 / 出链 / 还没写的',
            el: document.querySelector('.note-links'),
        },
        ai: {
            title: 'AI 对话', short: 'AI', fullTitle: 'AI 对话(Agent 面板)',
            el: document.querySelector('#agentPanel'),
        },
    };

    // 插件贡献的面板。宿主元素在这里**就地造好**(而不是让插件给一个 document 里
    // 预先存在的元素):插件拿不到工作台的 DOM,也不该去猜外壳的结构。
    // mount(host) 等挂载完成后才调用 —— 那时宿主已经真正进了文档,量得到尺寸。
    const paneTeardowns = [];
    const optionalPaneSpecs = new Map();
    for (const spec of registries.panes.list()) {
        const hostEl = document.createElement('div');
        hostEl.className = 'pane-plugin';
        hostEl.dataset.panePlugin = spec.pluginId ?? '';
        // ⚠️ 必须有 `data-plugin`:插件样式是由 mountTool 注入的,而注入时会经
        // `scopeCss` 给**每条规则**加上 `[data-plugin="<id>"]` 前缀。宿主上没有这个
        // 属性 → 整份插件样式一条都匹配不上 → 面板退化成无样式的块级流(实测:
        // `.drama-pane` 的 display 从 flex 掉成 block、`.drama-canvas` 的
        // overflow 从 hidden 掉成 visible,于是画布内容撑开、盖住下面的面板)。
        // 工具面板那条路是 mountTool 自己设的(`container.dataset.plugin`),
        // pane 这条路当初没有对应的那一行 —— 这就是那个缺口。
        if (typeof spec.pluginId === 'string' && spec.pluginId !== '') {
            hostEl.dataset.plugin = spec.pluginId;
        }
        panes[spec.id] = {
            title: spec.title,
            fullTitle: spec.fullTitle ?? spec.title,
            // 插件登记的视图没有人工 short → 让通用规则取首字(panel-tabs.js 的 shortLabel)
            short: typeof spec.short === 'string' ? spec.short : undefined,
            el: hostEl,
            pluginId: spec.pluginId ?? null,
            optional: spec.optional === true,
        };
        if (typeof spec.mount === 'function') {
            if (spec.optional === true) optionalPaneSpecs.set(spec.id, spec);
            else paneTeardowns.push({ spec, el: hostEl });
        }
    }

    const knownIds = Object.keys(panes);
    const requiredIds = knownIds.filter((id) => panes[id]?.optional !== true);
    const paneLifecycle = createPaneLifecycle({
        mountPane: (viewId, hostEl) => {
            const spec = optionalPaneSpecs.get(viewId);
            return typeof spec?.mount === 'function'
                ? spec.mount(hostEl, { pluginId: spec.pluginId ?? null })
                : null;
        },
    });
    // 外壳自带的那几片必须有元素(插件那片刚造好,一定有)。
    for (const id of ['notes', 'doc', 'links', 'ai']) {
        if (!panes[id]?.el) throw new Error(`工作台要的面板元素不存在:${id}`);
    }

    /**
     * 把**当前视图表**报给主进程 —— 「窗口」菜单里那一段面板列表就是它。
     *
     * 为什么非报不可:菜单只有主进程建得了(Menu 是 Electron 的东西),而"窗口里此刻
     * 有哪些面板"只有这一层知道(插件面板是插件激活时才登记的)。两边各存一份列表迟早
     * 会分叉,所以真值就在这儿,主进程每次收到就重建菜单。
     *
     * ⚠️ `open` 判的是"**这个视图在不在窗口里**"(按标签里的 view 判,见 viewOpenIn 那条注释),
     *    **不是**"有没有一个槽位 id 叫这个名字":v4 起 `pane.id` 只是槽位键,
     *    标签被拖进别的格子之后,视图就住在 id 完全不同的格里了 ——
     *    按槽位 id 判会让"窗口"菜单**骗人**(明明开着却没勾,点一下再开第二份)。
     *
     * ⚠️ 必须**按内容去重**:`onLayout` 会被 refresh 连着调(每一次 render 结尾、resize、
     *    拖分隔条都会调),内容没变还往上打一次,主进程就会白白重建一遍应用菜单。
     */
    let lastPanelTable = '';
    const reportPanels = (tree) => {
        if (typeof bridge.reportPanels !== 'function') return;      // 桥是旧版:静默不报,不拦启动
        const groups = splitPanelMenuTables({
            knownIds,
            tools: registries.tools.list(),
            titleOf: (id) => panes[id]?.title,
            tree,
        });
        const text = JSON.stringify(groups);
        if (text === lastPanelTable) return;                        // 没变就不报(见上)
        lastPanelTable = text;
        try {
            bridge.reportPanels(groups.views, groups.tools);
        } catch (err) {
            // 上报失败只影响菜单里那段列表(勾会停在上一轮),不该让布局这条线跟着塌
            console.warn('[shell] 上报面板表失败(「窗口」菜单里的面板列表会不动)', err);
        }
    };

    // 新面板的收养位置。改这里就能改"插件面板第一次出现在哪一格"。
    // ⚠️ 必须和 app/lib/panel-tree.js 的 DEFAULT_ADOPTION 保持同一份口径 ——
    // 这里传的是**外壳真正用的那一份**,lib 里那个只是给单测与默认行为兜底。
    const adoption = {
        'note-canvas': { anchor: 'doc', dir: 'row', sizes: [60, 40] },
        drama: { anchor: 'doc', dir: 'row', sizes: [62, 38] },
        // ⚠️ 每一片插件面板都**必须**在这里有落点。没有落点时 adoptPanes 会走
        // \"追加到根那一行\" 的兜底 —— 那条路会**重算整行的比例**,把用户原有的分栏
        // 一起改掉(实测:加「AI 会话」之后左列从 28% 变成 18.67%,自检里三条
        // \"默认宽度 / 原有比例不许被改动\"当场变红)。有落点则只切**锚点那一份**。
        // ⚠️ 落点是**量出来的**,不是审美。三种都试过,只有这一条成立:
        //   · 与 drama 同一种(挂在「笔记正文」右边、根行里多一片):右栏那两片的
        //     42/58 与「AI 不该是更小的那半」原封不动(有明文硬要求,自检单独钉着);
        //   · 挂在「AI 对话」或「链接」下面都不行:前者把 AI 切小 → 右栏里链接比 AI 还大,
        //     后者让右栏多出第三片 → 自检里按「右栏恰好两片」写的读数当场崩(实测);
        //   · 代价只有一处:根行多一片就多一条缝,默认布局的像素宽度各少约 3px
        //     (自检里那条「逐像素一致」因此调过一次数)。
        'ai-session': { anchor: 'doc', dir: 'row', sizes: [62, 38] },
        // 「短剧项目」:挂在**短剧画布**旁边。
        // ⚠️ 为什么不像 drama 那样锚在 'doc':锚在 doc 上会去切「笔记正文」那一份,
        //    把中间那列挤窄 —— 而"AI 不该是更小的那半""右栏恰好两片"这些硬要求
        //    就挂在这一带的读数上(实测踩过)。锚在自家画布上,代价只落在插件那一格。
        // ⚠️ 收编只会插在**锚点后面**,所以它落在画布右边;用户拖到左边之后照常记进存档。
        'drama-projects': { anchor: 'drama', dir: 'row', sizes: [58, 42] },
    };

    // ⚠️ 默认树(以及"从没存过 / 存档读坏了"时回退用的那棵树)**也必须收编插件面板**。
    // 这里踩过一次:`store.load()` 返回的树明明带着新面板,界面上却没有 ——
    // 因为 mount() 在"没有可用存档"那条分支上回退的是 `initialTree`,而它是
    // `treeFromWidths()` 按**外壳那四片**造的,压根不知道有第五片。
    // 结果就是"插件激活了、面板集合也含它,但树里永远少一片"。
    const initialTree = adoptPanes(
        treeFromWidths({ navW, sideW, avail: Math.max(240, viewportW - GUTTER_PX * 2) }),
        requiredIds,
        adoption,
    );

    const store = createLayoutStore({
        storage: {
            read: () => bridge.invoke('kaiwu:settings:get', { pluginId: LAYOUT_NAMESPACE, key: LAYOUT_KEY }),
            write: (text) => bridge.invoke('kaiwu:settings:set', {
                pluginId: LAYOUT_NAMESPACE, key: LAYOUT_KEY, value: text,
            }),
        },
        knownIds,
        requiredIds,
        adoption,
        log: console,
    });

    // --nav-w / --side-w 现在是**读数**(从真实宽度反写,给无障碍与既有自检读),
    // 排版由树的比例驱动;拖动后照旧落进 ui.navWidth / ui.sideWidth。
    const measured = (selector) => {
        const el = document.querySelector(selector);
        return el ? Math.round(el.getBoundingClientRect().width) : 0;
    };
    // 右栏读数 = links 与 ai 两块的**并集**宽度:默认它们上下叠着 → 就是那一列的宽度
    // (与旧的 --side-w 同一个口径);被拖成左右并排时 → 两块加起来,仍是"右栏占多宽"。
    const unionWidth = (selectors) => {
        let left = Infinity;
        let right = -Infinity;
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (!(r.width > 0)) continue;
            left = Math.min(left, r.left);
            right = Math.max(right, r.right);
        }
        return Number.isFinite(left) ? Math.round(right - left) : 0;
    };

    const workspace = createPanelWorkspace({
        desk, stack,
        hintEl: $('panelHint'), bandEl: $('panelBand'),
        treeEl: $('layoutTree'), resetBtn: $('layoutReset'),
        host, panes, store, initialTree,
        requiredIds,
        // 标签**全名**:笔记标签用笔记标题(「甲篇」而不是「笔记正文」),
        // 其它视图用登记的名字。找不到标题(索引还没载入)就退回文件名。
        viewTitle: (tab) => {
            if (tab?.view === 'doc' && typeof tab.doc === 'string' && tab.doc !== '') {
                const hit = (notesApi?.index?.notes ?? []).find((n) => n.path === tab.doc);
                const title = hit?.title;
                return (typeof title === 'string' && title.trim() !== '') ? title.trim() : tab.doc;
            }
            return panes[tab?.view]?.title ?? tab?.view ?? '';
        },
        viewShort: (tab) => panes[tab?.view]?.short,
        // 某个标签成为**当前标签**:把内容真正装上。笔记正文走这里切笔记 ——
        // ⚠️ source:'tabs' 表示"这次是标签条自己切的",列表那侧不必再做替换。
        onActivateTab: (tab) => {
            if (tab?.view === 'doc' && typeof tab.doc === 'string' && tab.doc !== ''
                && notesApi?.currentPath !== tab.doc) {
                notesApi?.open(tab.doc, { source: 'tabs' });
            }
            if (optionalPaneSpecs.has(tab?.view)) {
                const paneHost = panes[tab.view]?.el;
                void paneLifecycle.activate(tab.view, paneHost).catch((err) => {
                    console.error(`[shell] 插件面板 ${tab.view} 渲染失败`, err);
                });
            }
        },
        // 脏 = 这个 doc 标签就是编辑器里**正开着**的那一篇、而且编辑器里有未保存的改动。
        // 别的标签(还没被打开的笔记)在编辑器里根本没有内容,也就谈不上脏。
        isTabDirty: (tab) => tab?.view === 'doc' && notesApi?.currentPath === tab.doc
            && notesApi?.hasUnsaved?.() === true,
        onSaveTab: () => notesApi?.save?.(),
        // 旧 id 与"双击回到 236 / 240"的兼容规则:按贴着哪个面板来认。
        // ⚠️ `side` 拆成 links + ai 之后,"右栏那条分隔条"变成了**正文右边**那一条
        // (右边不再是某一格面板,而是一个上下分割),所以认 `doc` 而不是认 `side`;
        // which:1 = 双击时让**右边那一整栏**回到 ui.sideWidth(240),与旧行为一致。
        gutters: [
            { id: 'navResizer', after: 'notes', defaultPx: DEFAULT_NAV_W },
            { id: 'sideResizer', after: 'doc', defaultPx: DEFAULT_SIDE_W, which: 1 },
        ],
        onLayout: (tree, { persist }) => {
            void paneLifecycle.reconcile([...viewsOpenIn(tree)]);
            const nav = measured('.notes-nav');
            const side = unionWidth(['.note-links', '#agentPanel']);
            if (nav > 0) host.style.setProperty('--nav-w', `${nav}px`);
            if (side > 0) host.style.setProperty('--side-w', `${side}px`);
            // ⚠️ 面板表必须在**这个提前返回之前**报:菜单要跟的是"窗口里有哪些格子",
            //    而那件事在"不落盘"的那些刷新里也会变(挂载、读回存档、菜单自己加的那一格)。
            //    放到下面去的话,菜单只在用户拖过分隔条之后才更新一次。
            reportPanels(tree);
            // "默认不拖不动、不写存档":挂载与重画只更新读数,一个字都不落盘。
            if (!persist) return;
            write('ui.navWidth', nav);
            write('ui.sideWidth', side);
        },
    });

    /**
     * 「窗口」菜单里点了一条**没开着**的面板 → 在窗口里**新加一格**
     * (用户定的:不是往现有格子里塞标签,而是旁边长出一格)。
     *
     * 落点交给 `addPane`(纯函数,见 app/lib/panel-tree.js):锚点 = **当前聚焦的那一格**,
     * 方向 row / 右边,新格从锚点那份比例里切走 30% —— 其余格的比例一个字不动。
     *
     * 两道守卫都是必要的:
     *   · 注册表里没有这个 id → 不认(菜单可能比注册表旧:插件刚被停用就会这样);
     *   · 这一格已经在树上 → 跳过。菜单那边本来就是 `enabled:false` 点不动,
     *     这里是**第二道**:同一个 id 在树上出现两次会毁掉布局存档(见 reportPanels 的注释)。
     */
    function openWorkspacePanel(viewId) {
        if (typeof viewId !== 'string' || !knownIds.includes(viewId)) return false;
        const tree = workspace.getTree();
        // ⚠️ 第二道闸也按**视图**判:同一个视图在窗口里只该有一份。
        //    (先前按槽位 id 判,于是"视图没开、但它的名字被别的格子占着"时会**静默什么都不做** ——
        //     用户点了菜单却什么都没发生,比报错更难查。)
        if (viewsOpenIn(tree).has(viewId)) {
            // 已经开着 → 不许多开一份;但它可能只是**某格里的非活动标签**(用户看不见它)。
            // 菜单那一项既然是可点的,点它就该把它**切到眼前** —— 否则用户明明开着却看不到、
            // 菜单又点不动,只能自己去翻标签条(实测用户就是这样找不到「笔记列表」的)。
            const ok = workspace.focusView(viewId);
            console.info(`[shell] 窗口菜单:${viewId} 本来开着 → ${ok ? '已切到眼前' : '没找到那一枚标签(不改动)'}`);
            return ok;
        }
        const next = addPane(tree, viewId, {
            anchorId: workspace.currentPane(), dir: 'row', side: 'right',
        });
        if (next === null) return false;        // 认不出锚点 → 保持原树(不猜一个位置出来)
        console.info(`[shell] 窗口菜单:${viewId} 没开着 → 新加一格`);
        workspace.applyTree(next);              // 内部走 render + commit:重画 + 落盘
        return workspace.focusView(viewId);
    }
    bridge.onAddPanel(openWorkspacePanel);

    await workspace.mount();

    // 工作台挂好之后才让插件往自己的 pane 里渲染 —— 此刻宿主元素已经真正进了文档,
    // 量尺寸 / 建画布 / 绑事件都是有效的(挂载前调就只有个游离的 div)。
    // 失败只影响这一片:记一笔日志,不让整个工作台跟着塌。
    for (const { spec, el } of paneTeardowns) {
        try {
            await spec.mount(el, { pluginId: spec.pluginId ?? null });
        } catch (err) {
            console.error(`[shell] 插件面板 ${spec.id} 渲染失败`, err);
        }
    }

    stage(`boot:工作台已挂载 ${workspace.text()}`);

    // 自检钩子:标签条那几条读数要"点真标签、按真快捷键、读真 DOM",而合成指针事件之前
    // 得先知道这一格此刻有哪些标签(布局树文本里看不到标签)。与 `window.__kaiwuShellReady`
    // 同一个路子:只暴露**只读快照 + 几个动作**,不回传任何宿主对象。
    window.__pwTabs = {
        toolIds: () => registries.tools.list().map((tool) => tool.id),
        tabsOf: (id) => workspace.tabsOf(id),
        allTabs: () => workspace.allTabs(),
        recentsOf: (id) => workspace.recentsOf(id),
        notice: () => workspace.notice(),
        currentPane: () => workspace.currentPane(),
        openPanel: (viewId) => openWorkspacePanel(viewId),
        openView: (view, doc) => workspace.openView(view, doc),
        addView: (paneId, view) => workspace.addView(paneId, view),
        closeTab: (paneId, index) => workspace.closeTab(paneId, index),
        closeAllTabs: (paneId) => workspace.closeAllTabs(paneId),
    };
    return workspace;
}

async function boot() {
    stage('boot:进入');
    startStarfield($('starfield'));
    stage('boot:星空已启动');

    // 启动时先把「减少动态效果(强制关)」读出来应用一次:设置页那个开关是**持久的**,
    // 上次关掉之后这次启动就得是关的(否则会先动一下再停)。读设置要走桥,所以是异步的;
    // 星空在这之前已经开始跑了,靠 `kaiwu:motion` 事件把它停下。读失败不致命(当没设过)。
    void bridge.invoke('kaiwu:settings:get', { pluginId: SETTINGS_NS, key: SETTINGS_KEYS.motion })
        .then((raw) => {
            const off = motionOffFromSetting(raw);
            applyMotionOff(off);
            if (off === true) stage('boot:动效已按设置强制关闭');
        })
        .catch(() => { /* 读不到设置 = 跟随系统 */ });

    // 自检钩子(见下面"先决定笔记库状态"一节):URL 上带 ?testVault=<绝对路径>
    // 时直接进那个笔记库并跳过向导。**必须在这里就算出来** —— AI 面板的
    // autoStart 要按它决定"绝不自动拉起真的 dsh"。
    const testVault = new URLSearchParams(location.search).get('testVault');

    // 底部不再有"服务状态条"。
    // 服务现在随应用并行启动,不需要用户点;每个工具面板里有自己的服务徽标
    // (createServiceBadge),状态就摆在用到它的地方。全局那一条只会占掉一行高度。
    // 真需要停某个服务时,面板徽标上的按钮还在。

    // ---------- 笔记视图 ----------
    const notes = createNotesView({
        els: {
            listEl: $('noteList'),
            searchEl: $('noteSearch'),
            newBtn: $('noteNew'),
            newFolderBtn: $('noteNewFolder'),
            emptyEl: $('noteEmpty'),
            editorEl: $('noteEditor'),
            titleEl: $('noteTitle'),
            pathEl: $('notePath'),
            saveBtn: $('noteSave'),
            statusEl: $('noteStatus'),
            modeBtn: $('noteModeBtn'),
            docEl: $('noteDoc'),
            backlinkEl: $('backlinkList'),
            outlinkEl: $('outlinkList'),
            unresolvedEl: $('unresolvedList'),
            tagPanelEl: $('tagPanel'),
            tagFilterBar: $('tagFilterBar'),
            tagFilterName: $('tagFilterName'),
            tagFilterClear: $('tagFilterClear'),
        },
        bridge,
        log: console,
        // 打开一篇笔记之后:① 让「笔记正文」那一格按**替换语义**换标签(产品决定);
        // ② 刷新 AI 面板上"这次会带上哪篇笔记"那行提示。
        // ⚠️ source='tabs' 是标签条自己切过去的 —— 那时光标**已经**是那个标签了,
        //    再做一次替换会把用户旁边开着的标签全关掉(这条区分就是为它留的)。
        onOpenNote: (path, info) => {
            if (info?.source !== 'tabs') workspaceApi?.openView('doc', path);
            agent.syncNote();
        },
    });
    stage('boot:笔记视图已建');
    // 工作台要用它(标签全名 = 笔记标题;切 doc 标签 = 把编辑器切到那一篇)
    notesApi = notes;

    // 侧栏宽度可拖(左 + 右)/ 平铺工作台。放在这里:两条分隔条与 #paneNotes 都在骨架里,
    // 而宽度的读回要走设置通道 —— 失败也不该拦住后面的外壳启动。
    //
    // ⚠️ 工作台必须在 `#shell` **可见之后**才挂载(见 setupPanelWorkspace 顶部),
    // 所以真正的挂载点在下面对应的分支里(ensureWorkspace)。
    let workspacePromise = null;
    let workspaceRef = null;
    function ensureWorkspace() {
        if (workspacePromise) return workspacePromise;
        workspacePromise = setupPanelWorkspace()
            .then((ws) => { workspaceApi = ws; return ws; })
            .catch((err) => {
                stageError('boot:工作台初始化失败,退回固定网格兜底', err);
                // 退路:改动前的固定布局兜底(.pane-notes 的 grid,四格依次排开)。
                // 工作台没挂上时 .pw-host 不会被加,.pw-desk / .pw-bar 保持 display:none,
                // 布局照旧走 shell.css 的 grid。
                return setupColumnResizers().catch((e) => stageError('boot:侧栏宽度初始化失败', e));
            });
        return workspacePromise;
    }

    // ---------- AI 面板(右侧常驻) ----------
    //
    // 面板拿的是**注入的 getNote**,不是笔记频道:面板不该知道 notes:read /
    // 路径守卫 / 当前笔记是谁 —— 那些都是外壳的知识(见 B2 的文件归属)。
    // 会话绑定当前笔记就落在这一处:发送时把标题/路径/正文一起拼进提示。
    //
    // ⚠️ 自检模式(?testVault=,见 electron/run-selftest.js)**绝不自动连**:
    // 那会在自检里拉起一个真的 dsh 子进程。自检走 #agentRetry 显式开始,
    // 于是整条流程(stopped → 点重试 → ready → 发提示)是确定性的。
    const isSelftest = testVault !== null && testVault !== undefined;
    const agent = createAgentPanel({
        els: {
            panel: $('agentPanel'),
            statusEl: $('agentStatus'),
            retryBtn: $('agentRetry'),
            messagesEl: $('agentMessages'),
            inputEl: $('agentInput'),
            // 发送与取消已经合成**一颗球**(#agentSend):空闲=发送、执行中=取消,
            // 所以这里不再有 stopBtn —— 面板也不再需要它(见 panel.js 的 ensureOrb / 点击接线)。
            sendBtn: $('agentSend'),
            // 思考强度 / 模型那枚胶囊(以及它外面那层锚点 —— 浮层锚在它上面)。
            // ⚠️ 与球同一套:壳给元素,行为在 panel.js;缺了它面板要能照常工作(旧外壳)。
            configBtn: $('agentCfg'),
            configWrap: $('agentCfgWrap'),
            credentialEl: $('agentCredential'),
            killBtn: $('agentKill'),
        },
        bridge,
        log: console,
        autoStart: !isSelftest,
        getNote: () => {
            const path = notes.currentPath;
            if (!path) return null;
            const meta = (notes.index?.notes ?? []).find(n => n.path === path);
            return {
                path,
                title: meta?.title ?? path,
                // 用编辑器里的现值,不是盘上的:自动保存有 800ms 延迟,
                // 从盘上读会漏掉用户刚敲进去的几句话。
                text: notes.editor?.value?.() ?? '',
            };
        },
    });
    // 挂载即对话:启动一次 agent:start。失败不致命 —— 面板把原因显示出来,
    // 重试按钮(#agentRetry)可以再点。
    agent.mount().then((status) => {
        stage(`boot:AI 面板已挂载 state=${status?.state}`);
    }).catch((err) => {
        console.error('[shell] AI 面板挂载失败', err);
    });

    // 插件(B站下载队列)请 AI 面板理解一段**本地视频**时,对话与回答都在 Notes 工作台。
    document.addEventListener('kaiwu:understand-video', () => {
        stage('boot:收到「理解这段视频」请求,Notes 工作台保持显示');
    });

    // ---------- 首启向导 ----------
    const onboarding = createOnboarding({
        el: $('onboarding'),
        bridge,
        log: console,
        onVaultReady: async (status) => {
            stage(`onVaultReady:收到 ${JSON.stringify(status)}`);
            $('shell').hidden = false;
            workspaceRef = await ensureWorkspace();   // 外壳可见了,量出来的尺寸才是真的
            await enterVault(status);
            stage('onVaultReady:完成');
        },
    });
    // 把向导内部的可见性变化接进启动日志 —— 这次排查证明"读代码推时序"不可靠,
    // 必须有真实时间线。
    onboarding.setTrace?.(m => stage('[向导] ' + m));

    bridge.onPreferencesResetLayout(() => {
        if (workspaceRef === null) return;
        workspaceRef.reset();
        bridge.reportPreferencesLayoutText(workspaceRef.text());
    });
    bridge.onPreferencesLayoutTextRequest(() => {
        if (workspaceRef !== null) bridge.reportPreferencesLayoutText(workspaceRef.text());
    });
    bridge.onPreferencesChangeVault(() => onboarding.open());
    bridge.onPreferencesMotionChange(({ off } = {}) => { if (typeof off === 'boolean') applyMotionOff(off); });

    async function enterVault(status) {
        stage(`enterVault:开始 status.ok=${status && status.ok}`);
        if (status && status.ok) {
            await notes.setVault();
            stage('enterVault:索引已载入');
            agent.syncNote();                  // 进了新库,上下文提示跟着刷新
        } else {
            stage('enterVault:状态不可用,Notes 工作台保持显示(空状态)');
        }
    }

    $('vaultChange')?.addEventListener('click', () => onboarding.open());

    // ---------- 插件(与笔记无关,先加载,失败不影响笔记) ----------
    const pluginPromise = (async () => {
        const descriptors = await bridge.invoke('kaiwu:plugins:scan', {});
        await mergeRuntimeManifests(descriptors);
        const { activated, broken } = await loadPlugins({
            descriptors,
            registries,
            importFn: (url) => import(url),
            bridge,
            log: console,
            fetchText,
        });
        for (const b of broken) {
            console.error(`[shell] 插件 ${b.descriptor.id} 在 ${b.stage} 阶段失败:${b.error?.message}`);
        }
        return { activated: activated.length, broken: broken.length };
    })();

    // ---------- 先决定笔记库状态,再显示对应界面 ----------
    //
    // 自检钩子(?testVault=,在上面已经读出来了)。为什么需要它:目录选择器是
    // 模态对话框,自动化没法点;而桥已经刻意从 window 上拿掉了,自检也无法替
    // 渲染进程调 IPC。所以唯一干净的入口就是启动参数。写入仍然要过 Vault 内的
    // 路径守卫,所以这不构成额外的能力。

    let status = await bridge.invoke('notes:vault:status', {});
    // 总线的载荷要带**绝对路径**(引擎按盘上的路径读文件),而笔记树只给库内相对路径 ——
    // 库根只有这里知道,所以启动时告诉总线一次(它只做拼接,不做权限判断)。
    // ⚠️ 但**每次拿到状态都要同步**,不能只同步最初那一次:自检模式下面还要把库切到临时库,
    //    只在最开始同步的话总线记住的是**旧库根**(或空)—— 现象是"拖上去只建出一个空节点",
    //    而真正的线索只有载荷里那句 abs=(空!库根没设?)。实测就这么白跑了两轮。
    const applyVaultRoot = (st) => {
        if (st !== null && typeof st === 'object' && typeof st.path === 'string' && st.path !== '') {
            setVaultRoot(st.path);
        }
    };
    applyVaultRoot(status);
    stage(`boot:查笔记库状态 → ${JSON.stringify(status)}`);
    if (testVault) {
        try {
            status = await bridge.invoke('notes:vault:set', { path: testVault });
            applyVaultRoot(status);      // ← 换了库,就把**新**库根告诉总线
            console.info('[shell] 自检模式:已指向临时笔记库');
        } catch (err) {
            console.error('[shell] 自检笔记库设置失败', err);
        }
    }

    const showedOnboarding = testVault ? false : onboarding.apply(status);
    stage(`boot:apply 返回 ${showedOnboarding}(true=要显示向导)`);

    // ⚠️ 插件必须在**挂载工作台之前**激活完:插件面板是在 activate 里登记的
    // (`ctx.panes.register`),而工作台一旦挂好,它的 panes 表就固定了 ——
    // 那时再登记就来不及,插件那片面板会整片不出现。
    //
    // 代价是这里多等一会儿(插件那几个 import 是并行的,通常很快),换来的是
    // "工作台知道自己有几片面板"这件事有一个确定的时刻。放在 ensureWorkspace 之前,
    // 两条分支(正常进库 / 走向导)都不用各自再等一次。
    const pluginResult = await pluginPromise.catch((err) => {
        console.error('[shell] 插件加载失败', err);
        return { activated: 0, broken: 0, error: String(err) };
    });

    if (!showedOnboarding) {
        $('shell').hidden = false;
        stage('boot:外壳已显示,准备进入笔记库');
        await enterVault(status);
        // ⚠️ 这一条路(`?testVault=`,自检走的就是它)也必须把工作台引用**存下来** ——
        // 设置页的「布局」那一项读的就是它(读不到就会显示成空的布局树)。
        workspaceRef = await ensureWorkspace();   // 同上:必须等外壳可见
        stage('boot:进入笔记库完成');
    } else {
        stage('boot:停在向导,等待用户选择');
    }

    stage(`boot:插件加载完成 activated=${pluginResult.activated} broken=${pluginResult.broken}`);

    // 拖动的只读状态出口(可信指针事件验不了合成,只能从外面问 —— 见 exposeDragState)。
    exposeDragState(() => notes.dragState());

    markShellReady({
        view: showedOnboarding ? 'onboarding' : 'notes',
        vault: status?.ok ? status.path : null,
        notes: notes.index?.notes?.length ?? 0,
        activated: pluginResult.activated,
        broken: pluginResult.broken,
        testVault: testVault ?? null,
    });
}

// 外壳就绪的粘性标记 + 一次性事件。
// 只用事件不够:监听方(自检)可能在事件发出之后才挂上监听器,那样永远等不到;
// 只用标记也不够:监听方需要在就绪的瞬间被唤醒,而不是轮询。
function markShellReady(detail) {
    window.__kaiwuShellReady = detail;
    document.dispatchEvent(new CustomEvent('kaiwu:shell-ready', { detail }));
}

/**
 * 拖动的**只读状态出口**(阈值 / 捕获 / 命中 / 落点判定)。
 *
 * 为什么需要它:拖动必须用**可信指针事件**验(这个仓库专门记过 —— 合成事件测不出
 * 指针捕获的改派行为),那只能从页面外面发。而它在界面上"没反应"时,肉眼分不出是
 * 卡在阈值、命中,还是落点判定哪一环 —— 这个口子让自检一次问清中间状态。
 *
 * 只读,不改任何状态。
 * ⚠️ 由 boot() 显式注入取值函数,而不是在这里直接写 notes.dragState():notes 是
 *    boot() 的局部变量,模块作用域够不着(踩过一次,报 ReferenceError)。
 * ⚠️ 也不要拿 `?testVault=` 当开关:Electron 的 standard-scheme 解析会把 query 吃掉
 *    (实测 location.href 里就没有它),那个判据根本不成立。
 */
function exposeDragState(getter) {
    window.__kaiwuDrag = () => {
        try { return getter(); } catch { return null; }
    };
}

async function mergeRuntimeManifests(descriptors) {
    for (const descriptor of descriptors) {
        if (!descriptor.needsRuntimeManifest) continue;
        try {
            const module = await import(descriptor.entryUrl);
            const result = await bridge.invoke('kaiwu:plugins:registerManifest', {
                manifest: module.default?.manifest,
            });
            if (!result?.ok) {
                descriptor.status = 'broken';
                descriptor.error = {
                    stage: 'manifest',
                    message: (result?.errors ?? [])
                        .map(e => `${e.field}: ${e.message}`).join('; ') || '清单校验未通过',
                };
                continue;
            }
            Object.assign(descriptor, {
                id: result.descriptor.id,
                name: result.descriptor.name,
                version: result.descriptor.version,
                description: result.descriptor.description,
                order: result.descriptor.order,
                permissions: result.descriptor.permissions,
                contributions: result.descriptor.contributes,
                needsRuntimeManifest: false,
            });
        } catch (err) {
            descriptor.status = 'broken';
            descriptor.error = { stage: 'import', message: err.message };
        }
    }
}

/**
 * 页面级 Ctrl+A 守卫(挂在 document 的**捕获**阶段)。
 *
 * 为什么这道守卫存在:正文是**块级**编辑器(一段 = 一个 textarea),跨块选区在 DOM 上
 * 不存在,所以"全选整篇"只能在编辑器那一层自己实现(见 app/notes/editor.js 的
 * setSelectAll)。但浏览器还留着一条**页面级**默认:焦点不在任何输入框时按 Ctrl+A,
 * Chromium 会把整个 app 页面(顶栏、笔记列表、AI 对话,连底部那行布局树读数)一股脑
 * 选上 —— 屏幕上并没有任何可编辑的东西,却整片被框住。上一轮只处理了"焦点在正文块
 * 输入区"这一种情形,这条默认没有人拦(产品负责人截图报的就是它)。
 *
 * 为什么放在**外壳**(app/main.js)而不是某个面板里:它管的是"页面"这一层,不属于任何
 * 单个工作台面板。放进笔记面板的话,AI 对话 / 工具面板 / Preferences 窗口下按 Ctrl+A
 * 照样会整页被选。
 *
 * 为什么必须是 **capture**:别的监听方(AI 面板的浮层、工作台快捷键等)也挂在 document /
 * window 上听 keydown,冒泡阶段再拦就排在它们后面了。捕获期只是**先看一眼**"要不要挡
 * 页面级默认",不跟任何人抢按键:该放行的事件照样一路传到它们手上。
 *
 * 为什么可编辑元素一律放行:搜索框 / 重命名框 / 笔记标题框 / AI 对话输入框 / 正文块
 * textarea 的 Ctrl+A 都是浏览器原生的"选中这一格",这正是用户预期;正文块那一条还要
 * 留给 editor.js 自己接管(它的 keydown 挂在正文根节点上,冒泡阶段才轮到它,而它把
 * Ctrl+A 变成"全选整篇")。判据写在 app/lib/select-all-guard.js 里(纯函数,单测钉着):
 * 那里用 closest 认 `input / textarea / [contenteditable…]`,而不是只看 tagName ——
 * 只判 INPUT 会漏掉编辑器以外的富文本区,把它们原生的全选一起劫持掉。
 *
 * 边界:这里**只**挡"页面级全选",不加任何新功能(例如"在列表上 Ctrl+A 就选全部笔记"
 * 是产品决定,不在这里做)。
 */
function installPageSelectAllGuard() {
    document.addEventListener('keydown', (e) => {
        if (shouldBlockPageSelectAll(e)) e.preventDefault();
    }, true);
}

installPageSelectAllGuard();

boot().catch((err) => {
    stageError('boot', err);
    console.error('[shell] 启动失败', err);
    const el = $('onboardingLead') ?? $('content');
    if (el) el.textContent = `开物启动失败:${err.message}`;
    const onb = $('onboarding');
    if (onb) onb.hidden = false;
    // 失败也要发:否则自检会一直等一个永远不来的事件,最后只能靠超时。
    markShellReady({ error: String(err), activated: 0, broken: 0 });
});
