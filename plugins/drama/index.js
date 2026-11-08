/* ============================================================
   短剧工作台 —— 插件入口
   ------------------------------------------------------------
   它贡献的是**工作台里的一片面板**(不是内容区的工具面板):用户能把它拖到任何
   地方,位置进布局存档,而且天然与「AI 对话」并排。

   数据落在 <笔记库>/短剧/<项目>/(graph.json + shots/ + inputs/)。
   引擎(读写图、跑图、出图)跑在**主进程**里 —— 渲染进程是沙箱,拿不到 fs。

   ⚠️ 交互契约(路线二的核心,照独立版 README 里那些踩坑结论做):
     · 指针捕获**只在手势真正开始时**做:
         一 pointerdown 就捕获会让卡片里的按钮收不到 click,还会把"点空白取消选中"
         误判成点到画布(现象是"点节点选不中")。
     · 文本节点单击即进编辑:只有切换到编辑器时才重建节点;编辑期间输入不重建 DOM,
         否则浏览器正要聚焦的元素被换掉,光标会丢失。
     · 画布不用原生滚动:平移/缩放只作用在 #world 这一层,
         节点的 x/y 永远是**图坐标**,唯一的换算是"拖节点时除以 scale"。
   ============================================================ */

import { snapGroupPositions } from './snap-alignment.js';
import { inputEdgeGroups, validateConnection } from 'toolbox://shell/lib/drama-connections.js';
import { buildImagePrompt } from 'toolbox://shell/lib/drama-image-prompt.js';
import { skillCandidates, currentSkillMatch } from 'toolbox://shell/lib/drama-skills.js';
import { renderMarkdownNodes } from 'toolbox://shell/lib/markdown.js';
import { mountLiveMarkdown } from 'toolbox://shell/lib/live-markdown.js';
import { createDramaOutputPanel } from './output-panel.js';
import { createImagePromptPreview } from './image-prompt-preview.js';
import { createSkillPanel } from './skill-panel.js';
import { resizeHitSizes, resizeNodeBox } from './node-resize.js';
import {
    clientToWorldPoint,
    finishMarqueeSelection,
    intersectingNodeIds,
    normalizeSelectionRect,
} from './marquee-selection.js';

const PANE_ID = 'drama';
let runSequence = 0;
/**
 * 项目面板的 pane id。**与画布分开两片**:画布只管画布,项目的新建 / 改名 / 删除 /
 * 切换都在这一片里 —— 原来那个挤在画布工具条里的下拉框就此退休。
 */
const PROJECTS_PANE_ID = 'drama-projects';

export default {
    activate(ctx) {
        // 面板样式**自己注入**。
        //
        // ⚠️ 为什么不能像工具面板那样指望外壳:工具面板走 mountTool,它会把
        // `style.css` fetch 回来、过 scopeCss 加作用域前缀再塞进 <head>。
        // **pane 这条路没有对应的那一步** —— 外壳只造一个宿主 div 然后调插件的
        // mount()。所以不自己注入的话,整份样式一条都不会生效,面板退化成
        // 无样式的块级流(.drama-pane 的 display 从 flex 掉成 block、
        // .drama-canvas 的 overflow 从 hidden 掉成 visible),画布内容会撑开
        // 盖住下面的面板 —— 实测踩到过。
        //
        // scopeCss 从外壳公共库来:`toolbox://shell/lib/css-scope.js` 是纯函数
        // (不碰 DOM、不碰 node:),渲染进程里可以直接 import。宿主上的
        // `data-plugin="drama"` 由外壳设置(main.js 的 setupPanelWorkspace)。
        void injectStyles(ctx);

        // 两片面板共享的**唯一一份**项目状态。
        //
        // ⚠️ 为什么必须是共享的一份:从前"当前项目"存在画布自己的局部 state 里
        //    (默认取清单第一个)。加上项目面板之后就有两处会改它 —— 面板点了另一行,
        //    画布却还攥着旧的那个,表现是"左边高亮换了、右边画布没换"。所以真相只有
        //    一份,两片都订阅它(见 createProjectStore)。
        const store = createProjectStore(ctx);
        ctx.onDispose(() => store.dispose());

        ctx.panes.register({
            id: PANE_ID,
            title: '短剧画布',
            fullTitle: '短剧工作台 · 节点画布',
            mount: (host) => setup(host, ctx, store),
        });

        ctx.panes.register({
            id: PROJECTS_PANE_ID,
            title: '短剧项目',
            fullTitle: '短剧工作台 · 项目',
            // order 比画布大一点:列表面板在「窗口」菜单里排在画布后面。
            order: 1010,
            mount: (host) => setupProjects(host, ctx, store),
        });

        ctx.log.info('短剧工作台:画布面板与项目面板已登记');
    },
};

/* ------------------------------------------------------------------ *
 * 两片面板共享的项目状态
 * ------------------------------------------------------------------ */

/**
 * 项目的**唯一真相**:清单 + 当前选中的那一个。
 *
 * 订阅者(画布 / 项目面板)只管渲染,不许各存一份 —— 存两份就会分叉。
 * `refresh()` 是唯一会去问主进程的入口:建、改名、删之后都走它,一次调用
 * 把清单与统计一起拿回来(`drama:projects` 同时给 `projects` 与 `items`)。
 */
function createProjectStore(ctx) {
    const listeners = new Set();
    let items = [];
    let current = null;
    let reason = '';        // 根不可用(没配笔记库)时那句人话
    let root = null;        // 主进程给的 {root, reason, dir}
    let loading = null;     // 首次加载的 promise(见 ensureLoaded)

    const emit = () => {
        for (const fn of [...listeners]) {
            try { fn(); } catch (err) { ctx.log.warn('短剧项目状态订阅者抛错', err); }
        }
    };

    const keepCurrentValid = () => {
        if (items.some((it) => it.name === current)) return;
        current = items.length > 0 ? items[0].name : null;
    };

    return {
        get items() { return items; },
        get current() { return current; },
        get reason() { return reason; },
        get root() { return root; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        /**
         * 两片面板挂载时**都**调它:问一次根、拉一次清单。
         *
         * ⚠️ 必须幂等:两片面板是一起挂上的,不缓存这个 promise 就会各问一遍主进程
         *    (白跑两次 IPC,而且两边的"刚加载完"时机不同,容易出现一闪而过的空态)。
         */
        ensureLoaded() {
            if (loading !== null) return loading;
            loading = (async () => {
                root = await ctx.drama.root();
                if (root === null || root.root === null) {
                    this.fail(root?.reason || '短剧项目根不可用');
                    return items;
                }
                return await this.refresh();
            })().catch((err) => {
                this.fail(`读短剧项目根失败:${err.message}`);
                return items;
            });
            return loading;
        },
        /** 问主进程要一份新的清单。失败时把原因留在 `reason` 里,由两片各自显示。 */
        async refresh() {
            try {
                const r = await ctx.drama.projects();
                const list = Array.isArray(r?.items) ? r.items : [];
                // 老形状兜底:主进程只回了名字数组时也要能用(items 是新加的字段)。
                items = list.length > 0
                    ? list
                    : (Array.isArray(r?.projects) ? r.projects.map((name) => ({ name })) : []);
                reason = '';
            } catch (err) {
                items = [];
                reason = `读项目清单失败:${err.message}`;
            }
            keepCurrentValid();
            emit();
            return items;
        },
        /** 选中某个项目(面板点那一行时调)。已经是它了就不惊动订阅者。 */
        select(name) {
            if (typeof name !== 'string' || name === '' || name === current) return;
            current = name;
            emit();
        },
        /**
         * 建 / 改名 / 删之后收尾:清单换了,同时把选中项落到指定那个上。
         *
         * ⚠️ 选中项要**先**摆好再 refresh:反过来的话,refresh 里的 keepCurrentValid
         *    会发现"当前那个名字不在清单里了",先把选中项落到清单第一个并通知订阅者,
         *    于是画布先读一遍别的项目、再读一遍真正要的那个 —— 白读一次图,还会闪一下。
         */
        async afterMutation(preferred = null) {
            if (typeof preferred === 'string' && preferred !== '') current = preferred;
            await this.refresh();
            return items;
        },
        /** 根不可用:两片一起显示原因,并且清空选择。 */
        fail(text) {
            reason = text;
            items = [];
            current = null;
            emit();
        },
        /** 清单与选中都没动,但界面要重画(比如删到只剩空清单)。 */
        touch() { emit(); },
        dispose() { listeners.clear(); },
    };
}

/**
 * 把插件自己的 style.css 注入到 <head>,并加上作用域。
 *
 * 幂等:重复调用只会更新那一份(用 data-plugin-style 认领),不会堆出多份。
 * 失败不致命(样式没了仍能用,只是难看),记一条日志即可。
 */
async function injectStyles(ctx) {
    try {
        const { scopeCss } = await import('toolbox://shell/lib/css-scope.js');
        // ① 面板自己的样式:加 [data-plugin="drama"] 作用域(用到它们的东西都在宿主 div 里)。
        await injectOne(ctx, PANE_ID, 'style.css', (css) => scopeCss(css, PANE_ID));
        // ② 右键菜单那一份:**不加作用域**。菜单挂在 document.body 上(为了躲开画布的
        //    overflow:hidden 与 world 的 scale),而作用域前缀 `[data-plugin="drama"]`
        //    对 body 上的元素**一条都不匹配** —— 加了就等于没样式:菜单变成一块裸 div
        //    掉在页面最底下,现象是"右键之后什么都没有"(虚线落点框却看得见,因为它在宿主内)。
        //    实测踩到过,见 menu.css 的头注。
        await injectOne(ctx, `${PANE_ID}-menu`, 'menu.css', (css) => css);
    } catch (err) {
        ctx.log.warn('短剧面板样式注入失败(面板会没有样式,但功能不受影响)', err);
    }
}

/**
 * 注入一份样式。
 * 幂等:按 `data-plugin-style="<key>"` 认领同一份 —— 重复调用只更新,不会堆出多份。
 */
async function injectOne(ctx, key, file, transform) {
    const doc = globalThis.document;
    if (!doc) return;
    const url = new URL(file, import.meta.url).toString();
    const cssText = await (await fetch(url)).text();
    let styleEl = doc.querySelector(`style[data-plugin-style="${key}"]`);
    if (styleEl === null) {
        styleEl = doc.createElement('style');
        styleEl.dataset.pluginStyle = key;
        doc.head.appendChild(styleEl);
    }
    styleEl.textContent = transform(cssText);
    ctx.onDispose(() => { styleEl?.remove(); });
}

/* ------------------------------------------------------------------ *
 * 面板
 * ------------------------------------------------------------------ */

function setup(host, ctx, store) {
    host.innerHTML = '';

    const state = {
        root: null,            // {root, reason}
        project: null,
        graph: null,           // {nodes, edges, runs}
        types: [],             // 节点类型表(主进程给)
        selection: new Set(),  // 选中的节点 id
        view: { x: 0, y: 0, scale: 1 },
        editing: null,         // 正在编辑的节点 id(源码态)
        busy: false,
        generatingNodes: new Set(),
        priorMediaRuns: new Map(),
        activeRunId: null,
        outputModes: new Map(),
        outputTexts: new Map(),
        mediaReads: new Map(),
        status: '',
        rebuildTimer: null,    // 打字时推迟重建
        fresh: null,           // 刚从右键菜单落地的那张卡片(只影响它的入场动画)
        textImport: null,      // {extensions, maxBytes} —— 由引擎给,导入时拼对话框过滤器用
        officeFileImport: null,
    };

    const el = {};
    const build = () => {
        const root = document.createElement('div');
        root.className = 'drama-pane';

        // ---- 工具条 ----
        const bar = document.createElement('div');
        bar.className = 'drama-bar';

        // ⚠️ 这里原来是一个项目 <select> 加一个「新建项目…」按钮。现在项目归
        //    **「短剧项目」面板**管(新建 / 改名 / 删除 / 切换都在那儿),画布只留一个
        //    **只读**的名牌 —— 取消下拉之后,总得有地方让用户一眼看清"画布看的是哪个项目"。
        el.proj = document.createElement('span');
        el.proj.className = 'drama-proj';
        el.projDot = document.createElement('i');
        el.projName = document.createElement('span');
        el.projName.className = 'drama-proj-name';
        el.projName.textContent = '还没有项目';
        el.proj.append(el.projDot, el.projName);

        el.importBtn = btn('导入稿子…', 'drama-import');
        el.importWordBtn = btn('导入 Word', 'drama-word-import');
        el.importOfficeBtn = btn('导入 WPS 文件', 'drama-wps-import');
        el.runAll = btn('运行全部', 'drama-run pri');
        el.runTo = btn('运行到此', 'drama-runto');
        el.forceRun = btn('强制重跑', 'drama-force');
        el.fit = btn('适应', 'drama-fit');
        el.reset1 = btn('1:1', 'drama-1to1');

        el.note = document.createElement('span');
        el.note.className = 'drama-note';

        bar.append(el.proj, sep(), el.importBtn, el.importWordBtn, el.importOfficeBtn, sep(),
            el.runAll, el.runTo, el.forceRun, sep(), el.fit, el.reset1, el.note);

        // ---- 主体:画布占满可用区域 ----
        const wrap = document.createElement('div');
        wrap.className = 'drama-wrap';

        el.canvas = document.createElement('div');
        el.canvas.className = 'drama-canvas';
        el.world = document.createElement('div');
        el.world.className = 'drama-world';
        el.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.svg.setAttribute('class', 'drama-edges');
        el.world.appendChild(el.svg);
        el.snapGuideX = document.createElement('div');
        el.snapGuideX.className = 'drama-snap-guide x';
        el.snapGuideX.setAttribute('aria-hidden', 'true');
        el.snapGuideX.hidden = true;
        el.snapGuideY = document.createElement('div');
        el.snapGuideY.className = 'drama-snap-guide y';
        el.snapGuideY.setAttribute('aria-hidden', 'true');
        el.snapGuideY.hidden = true;
        el.snapGrid = document.createElement('div');
        el.snapGrid.className = 'drama-snap-grid';
        el.snapGrid.setAttribute('aria-hidden', 'true');
        el.snapGrid.hidden = true;
        el.marquee = document.createElement('div');
        el.marquee.className = 'drama-marquee';
        el.marquee.setAttribute('aria-hidden', 'true');
        el.marquee.hidden = true;
        el.world.append(el.snapGuideX, el.snapGuideY, el.snapGrid, el.marquee);
        el.canvas.appendChild(el.world);

        wrap.append(el.canvas);
        root.append(bar, wrap);
        host.appendChild(root);
    };

    build();

    /* ---------------- 数据 ---------------- */

    let rebuildPending = false;

    /**
     * 画布此刻**真正铺着**的那个项目 —— 不是"应该铺的"。
     * 有了它,"选中项变了才去读图"这件事才成立(否则每次 store 一动就重读一遍,
     * 连带把用户正在看的视野与选中都清掉)。
     */
    let shownProject = null;

    /**
     * 把 store 里的当前项目落到画布上。
     *
     * ⚠️ 这里**不再自己问主进程要清单**:清单与选中项都由 store 持有(见
     *    createProjectStore)。画布只做两件事:更新那个只读名牌,以及选中项真的
     *    变了的时候把图换过来。
     */
    function applyStore() {
        const name = store.current;
        el.projName.textContent = name ?? '还没有项目';
        el.proj.dataset.empty = name === null ? '1' : '0';
        el.importBtn.disabled = name === null;
        el.importWordBtn.disabled = name === null;
        el.importOfficeBtn.disabled = name === null;
        if (name === null) {
            shownProject = null;
            state.project = null;
            state.graph = null;
            renderEmpty(store.reason || '还没有项目。在「短剧项目」面板里新建一个。');
            return;
        }
        if (name !== shownProject) void loadState(name);
    }
    ctx.onDispose(store.subscribe(() => { applyStore(); }));

    async function loadState(project) {
        try {
            const s = await ctx.drama.state(project ?? state.project ?? undefined);
            if (s.project !== state.project) {
                state.generatingNodes.clear();
                state.priorMediaRuns.clear();
                state.outputModes.clear();
                state.outputTexts.clear();
                state.mediaReads.clear();
            }
            state.project = s.project;
            shownProject = s.project;
            state.graph = s.graph;
            state.types = s.types ?? [];
            state.textImport = s.textImport ?? null;
            state.officeFileImport = s.officeFileImport ?? null;
            state.selection.clear();
            state.editing = null;
            render();
            // ⚠️ 载入项目之后必须**适应一次视野**:图里的坐标是任意值(示例项目横跨
            // -452…1449),而画布那一格可能只有三四百像素宽 —— 不 fit 的话节点全在
            // 视野之外,表现是"面板里一片空白,但节点数其实是对的"(实测踩到)。
            // 放在 render 之后:fitView 要读画布与节点的真实尺寸。
            fitView();
            setStatus('');
        } catch (err) {
            setStatus(`读项目失败:${err.message}`);
        }
    }

    /* ---------------- 渲染 ---------------- */

    const nodeById = (id) => (state.graph?.nodes ?? []).find((n) => n.id === id) ?? null;
    const typeById = (id) => state.types.find((t) => t.id === id) ?? null;

    function fullOutputText(project, file) {
        const key = `${project}\0${file}`;
        const cached = state.outputTexts.get(key);
        if (cached !== undefined) return Promise.resolve(cached);
        const pending = ctx.drama.readOutput(project, file).then((result) => {
            const full = String(result.text ?? '');
            if (state.outputTexts.get(key) === pending) state.outputTexts.set(key, full);
            return full;
        }).catch((error) => {
            if (state.outputTexts.get(key) === pending) state.outputTexts.delete(key);
            throw error;
        });
        state.outputTexts.set(key, pending);
        return pending;
    }

    function imageSource(project, file) {
        const key = `${project}\0${file}`;
        const pending = state.mediaReads.get(key);
        if (pending) return pending;
        const request = ctx.drama.media(project, file).then((result) => {
            const mime = String(result?.mime ?? '');
            const base64 = result?.base64;
            if (!/^image\/(png|jpeg|webp|gif)$/i.test(mime) || typeof base64 !== 'string' || base64 === '') {
                throw new Error('图片数据格式无效');
            }
            return `data:${mime};base64,${base64}`;
        }).finally(() => {
            if (state.mediaReads.get(key) === request) state.mediaReads.delete(key);
        });
        state.mediaReads.set(key, request);
        return request;
    }

    function attachImage(img, project, file, placeholder = null) {
        void imageSource(project, file).then((src) => {
            if (!img.isConnected || state.project !== project) return;
            img.src = src;
            img.hidden = false;
            if (placeholder) placeholder.hidden = true;
        }).catch(() => {
            if (!img.isConnected || state.project !== project) return;
            img.hidden = true;
            if (placeholder) {
                placeholder.hidden = false;
                placeholder.textContent = '图片读取失败';
            }
        });
    }

    ctx.onDispose(ctx.drama.onRunEvent((event) => {
        if (event?.runId !== state.activeRunId || event?.project !== state.project) return;
        const nodeType = nodeById(event.nodeId)?.type;
        if (nodeType !== 'llm' && nodeType !== 'image' && nodeType !== 'run') return;
        if (event.status === 'skillMatched') {
            state.graph.skillMatches = { ...state.graph.skillMatches, [event.nodeId]: event.skillMatch };
            refreshSkillFeedback();
            return;
        }
        if (event.status === 'inputReady') {
            state.graph.runs = { ...state.graph.runs, [event.nodeId]: {
                ...state.graph.runs?.[event.nodeId], ...event.run,
            } };
            refreshSkillFeedback();
            return;
        }
        const running = event.status === 'running';
        if (running) {
            state.generatingNodes.add(event.nodeId);
            if (nodeType === 'image') {
                const previous = state.graph?.runs?.[event.nodeId];
                if (Array.isArray(previous?.media) && previous.media.length > 0) {
                    state.priorMediaRuns.set(event.nodeId, previous);
                }
            }
        }
        else state.generatingNodes.delete(event.nodeId);
        const card = [...el.world.querySelectorAll('.drama-node')]
            .find((item) => item.dataset.nodeId === event.nodeId);
        if (!card) return;
        card.classList.toggle('generating', running);
        card.classList.toggle('running', running);
        const runButton = card.querySelector('.drama-run-button');
        if (runButton) runButton.disabled = running || state.busy;
        const runState = card.querySelector('.drama-run-state');
        if (runState) runState.textContent = event.status === 'running' ? '正在运行'
            : event.status === 'failed' ? '运行失败' : event.status === 'ok' ? '已完成' : '等待运行';
        const badge = card.querySelector('.drama-status');
        if (badge) {
            badge.className = `drama-status drama-status-${event.status}`;
            badge.textContent = statusText({ status: event.status });
            badge.title = running ? (nodeType === 'image' ? '正在生成画面' : '正在生成文本') : '';
        }
    }));

    function inboundOf(id) {
        const node = nodeById(id);
        const type = typeById(node?.type);
        return inputEdgeGroups(state.graph, id, type?.inputs?.length ?? 0, type?.multipleInputs);
    }

    function render() {
        hideSnapFeedback();
        hideMarqueeFeedback();
        el.world.querySelectorAll('.drama-node').forEach((n) => n.remove());

        if (!state.graph) {
            el.svg.replaceChildren();
            renderEmpty('先选一个项目,或新建一个。');
            return;
        }
        if ((state.graph.nodes ?? []).length === 0) {
            el.svg.replaceChildren();
            renderEmpty('这个项目还是一张空图。\n在画布空白处右键添加节点。');
            return;
        }
        clearEmpty();

        for (const node of state.graph.nodes) {
            const card = renderNode(node);
            el.world.appendChild(card);
            card.style.minHeight = `${nodeContentMinHeight(card)}px`;
        }
        renderEdges();
        applyView();
        repaintSelection();
        renderNote();
    }

    function renderEmpty(text) {
        clearEmpty();
        const box = document.createElement('div');
        box.className = 'drama-empty';
        box.textContent = text;
        el.canvas.appendChild(box);
    }

    function clearEmpty() {
        el.canvas.querySelectorAll('.drama-empty').forEach((n) => n.remove());
    }

    function renderImageGallery(node, run) {
        const files = Array.isArray(run?.media)
            ? run.media.filter((file) => typeof file === 'string' && file !== '').slice(0, 8) : [];
        if (files.length === 0) return null;

        const gallery = document.createElement('div');
        gallery.className = `drama-image-gallery${files.length === 1 ? ' single' : ''}`;
        gallery.setAttribute('aria-label', `画面生成结果，共 ${files.length} 张`);

        const feature = document.createElement('div');
        feature.className = 'drama-image-feature';
        const main = document.createElement('img');
        main.className = 'drama-image-main';
        main.alt = `生成图片 1：${node.title ?? '画面生成'}`;
        main.hidden = true;
        const placeholder = document.createElement('span');
        placeholder.className = 'drama-image-placeholder';
        placeholder.textContent = '载入预览…';
        placeholder.setAttribute('role', 'status');
        feature.append(main, placeholder);
        gallery.appendChild(feature);

        if (files.length > 1) {
            const rail = document.createElement('div');
            rail.className = 'drama-image-thumbnails';
            rail.setAttribute('aria-label', '选择主预览图片');
            files.forEach((file, index) => {
                const thumb = document.createElement('button');
                thumb.type = 'button';
                thumb.className = 'drama-image-thumb';
                thumb.setAttribute('aria-label', `显示第 ${index + 1} 张图片`);
                thumb.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
                thumb.title = `第 ${index + 1} 张`;
                const preview = document.createElement('img');
                preview.className = 'drama-image-thumb-img';
                preview.alt = '';
                preview.hidden = true;
                thumb.appendChild(preview);
                thumb.addEventListener('click', (event) => {
                    event.stopPropagation();
                    rail.querySelectorAll('.drama-image-thumb').forEach((item) => {
                        item.setAttribute('aria-pressed', String(item === thumb));
                    });
                    main.alt = `生成图片 ${index + 1}：${node.title ?? '画面生成'}`;
                    placeholder.hidden = false;
                    placeholder.textContent = '载入预览…';
                    attachImage(main, state.project, file, placeholder);
                });
                rail.appendChild(thumb);
                attachImage(preview, state.project, file);
                if (index === 0) {
                    attachImage(main, state.project, file, placeholder);
                }
            });
            gallery.appendChild(rail);
        } else {
            attachImage(main, state.project, files[0], placeholder);
        }
        return gallery;
    }

    function renderInputSlots(node, type, body) {
        // 运行节点只显示动作控件；输入端口和连接线负责表达连接关系。
        if (node.type === 'run') return;
        const inbound = inboundOf(node.id);
        (type?.inputs ?? []).forEach((label, index) => {
            const sources = inbound[index] ?? [];
            const multiple = type.multipleInputs?.includes(index);
            if (multiple) {
                const heading = document.createElement('div');
                heading.className = 'drama-input-caption';
                heading.textContent = `${label}输入 · ${sources.length} 个来源`;
                body.appendChild(heading);
            }
            const sourceList = multiple ? document.createElement('div') : body;
            if (multiple) {
                sourceList.className = 'drama-input-sources';
                body.appendChild(sourceList);
            }
            (sources.length ? sources : [null]).forEach((edge, sourceIndex) => {
                const slot = document.createElement('div');
                slot.className = 'drama-slot';
                const from = edge ? (nodeById(edge.from)?.title ?? edge.from) : '';
                const caption = document.createElement('span');
                caption.textContent = multiple
                    ? (edge ? `${sourceIndex + 1} ${from}` : label === '技能' ? '连入技能后，按提示词需求启用'
                        : node.type === 'skill' ? '可连入多个来源' : '暂无上游，使用节点提示词')
                    : `${index} ${label}${from ? ' ← ' + from : ''}`;
                caption.title = caption.textContent;
                slot.appendChild(caption);
                if (!edge) slot.classList.add('drama-slot-empty');
                else {
                    const disconnect = document.createElement('button');
                    disconnect.type = 'button';
                    disconnect.className = 'drama-disconnect';
                    disconnect.textContent = '×';
                    disconnect.title = `断开 ${from}`;
                    disconnect.setAttribute('aria-label', `断开 ${from} 的${label}输入`);
                    disconnect.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        const edgeIndex = state.graph.edges.indexOf(edge);
                        if (edgeIndex < 0) return;
                        state.graph.edges.splice(edgeIndex, 1);
                        render();
                        scheduleSave();
                        setStatus('已断开连线');
                    });
                    slot.appendChild(disconnect);
                }
                sourceList.appendChild(slot);
            });
        });
    }

    function renderNode(node) {
        const type = typeById(node.type);
        const run = state.generatingNodes.has(node.id)
            ? { ...state.priorMediaRuns.get(node.id), ...state.graph.runs?.[node.id], status: 'running' }
            : state.graph.runs?.[node.id];
        const card = document.createElement('div');
        // `fresh` = 刚落地的那一张:给它一次性入场动画 + 一圈选中脉冲(见 style.css)
        card.className = node.id === state.fresh ? 'drama-node fresh' : 'drama-node';
        if ((node.type === 'llm' || node.type === 'image') && state.generatingNodes.has(node.id)) card.classList.add('generating');
        if (node.type === 'run' && run?.status === 'running') card.classList.add('running');
        if (node.type === 'llm' && (run?.output || run?.file)) card.classList.add('has-output');
        if (node.type === 'image' && Array.isArray(run?.media) && run.media.length > 0) card.classList.add('has-media');
        if (node.type === 'image' && typeof node.h === 'number' && node.h > 0) card.classList.add('has-custom-height');
        card.dataset.nodeId = node.id;
        card.dataset.type = node.type;
        card.title = node.type === 'word-file'
            ? '双击节点名重命名；右键菜单打开文件；拖动右侧连接点可接入运行节点'
            : node.type === 'wps-file' ? '双击或右键打开文件；按住并移动可拖动节点'
            : '按住并移动可拖动节点；按 Shift 拖动可选择文字';
        card.style.left = `${Math.round(node.x ?? 0)}px`;
        card.style.top = `${Math.round(node.y ?? 0)}px`;
        if (typeof node.w === 'number' && node.w > 0) card.style.width = `${node.w}px`;
        if (typeof node.h === 'number' && node.h > 0) card.style.height = `${node.h}px`;

        const head = document.createElement('div');
        head.className = 'drama-node-head';
        const dot = document.createElement('span');
        dot.className = `drama-dot drama-dot-${type?.color ?? 'text'}`;
        const title = document.createElement('span');
        title.className = 'drama-node-title';
        title.textContent = node.title ?? type?.label ?? node.id;
        const badge = document.createElement('span');
        badge.className = `drama-status drama-status-${statusKey(run)}`;
        badge.textContent = statusText(run);
        badge.title = run?.error ?? (run ? `fp ${String(run.fp ?? '').slice(0, 8)}` : '还没跑过');
        head.append(dot, title, badge);

        const body = document.createElement('div');
        body.className = 'drama-node-body';
        if (node.type === 'image' || node.type === 'skill') renderInputSlots(node, type, body);
        if (node.type === 'word-file') {
            const fileCard = document.createElement('div');
            fileCard.className = 'drama-word-file';
            const icon = document.createElement('span');
            icon.className = 'drama-word-icon';
            const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            iconSvg.setAttribute('viewBox', '0 0 40 40');
            iconSvg.setAttribute('aria-hidden', 'true');
            const mark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            mark.setAttribute('d', 'M5 10h7l3.2 14.2L19.1 10h4.2l4 14.2L30.5 10H36l-6.3 20h-5.1l-3.5-12.1L17.5 30h-5.1L5 10Z');
            mark.setAttribute('fill', 'currentColor');
            iconSvg.appendChild(mark);
            icon.appendChild(iconSvg);

            const details = document.createElement('div');
            details.className = 'drama-word-details';
            const filename = document.createElement('span');
            filename.className = 'drama-word-filename';
            filename.textContent = String(node.params?.name ?? node.title ?? 'Word 文档');
            filename.title = filename.textContent;
            const format = document.createElement('span');
            format.className = 'drama-word-format';
            format.textContent = 'DOCX';
            const bytes = Number(node.params?.size) || 0;
            const size = document.createElement('span');
            size.className = 'drama-word-size';
            size.textContent = bytes >= 1024 * 1024
                ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
                : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : (bytes > 0 ? `${bytes} B` : 'Word 文档');
            const meta = document.createElement('div');
            meta.className = 'drama-word-meta';
            meta.append(format, document.createTextNode(' · '), size);
            const readable = document.createElement('span');
            readable.className = 'drama-word-readable';
            readable.textContent = '正文可读取';
            details.append(filename, meta, readable);
            fileCard.append(icon, details);
            body.appendChild(fileCard);
        } else if (node.type === 'wps-file') {
            const fileCard = document.createElement('div');
            fileCard.className = 'drama-wps-file';
            const icon = document.createElement('span');
            icon.className = 'drama-wps-icon';
            const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            iconSvg.setAttribute('viewBox', '0 0 40 40');
            iconSvg.setAttribute('aria-hidden', 'true');
            const mark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            mark.setAttribute('d', 'M6 8h4.5l3 14 3-10h4l3 10 3-14H34l-5.5 19h-4.2L20 17.5 15.7 27h-4.2L6 8Z');
            mark.setAttribute('fill', 'currentColor');
            const brand = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            brand.setAttribute('x', '20');
            brand.setAttribute('y', '35');
            brand.setAttribute('text-anchor', 'middle');
            brand.setAttribute('font-size', '6');
            brand.setAttribute('font-family', 'Arial, sans-serif');
            brand.setAttribute('font-weight', '700');
            brand.setAttribute('letter-spacing', '.5');
            brand.textContent = 'WPS';
            iconSvg.append(mark, brand);
            icon.appendChild(iconSvg);

            const details = document.createElement('div');
            details.className = 'drama-wps-details';
            const extension = document.createElement('span');
            extension.className = 'drama-wps-format';
            extension.textContent = String(node.params?.extension ?? 'wps').toUpperCase();
            const bytes = Number(node.params?.size) || 0;
            const size = document.createElement('span');
            size.className = 'drama-wps-size';
            size.textContent = bytes >= 1024 * 1024
                ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
                : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : (bytes > 0 ? `${bytes} B` : 'WPS 文件');
            details.append(extension, document.createTextNode(' · '), size);
            fileCard.append(icon, details);
            body.appendChild(fileCard);
        } else if (node.type === 'run') {
            body.appendChild(renderRunControl(node, run));
        } else if (node.type === 'result') {
            const out = document.createElement('div');
            out.className = 'drama-out drama-text-content drama-output-markdown';
            const sourceEdge = state.graph.edges?.find((edge) => edge.to === node.id
                && (edge.toPort ?? 0) === 0);
            const sourceRun = sourceEdge ? state.graph.runs?.[sourceEdge.from] : null;
            const resultProject = state.project;
            const renderResult = (value) => {
                out.replaceChildren(...renderMarkdownNodes(document, String(value ?? ''), { tables: true }));
            };
            renderResult(sourceRun?.output ?? node.outputText ?? '');
            out.setAttribute('aria-label', '运行结果');
            out.tabIndex = 0;
            if (typeof sourceRun?.exportFile === 'string' && sourceRun.exportFile !== '') {
                const exportFile = document.createElement('div');
                exportFile.className = 'drama-result-export';
                const icon = document.createElement('span');
                icon.className = 'drama-result-export-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = String(sourceRun.exportFormat ?? '').toUpperCase().slice(0, 4);
                const label = document.createElement('span');
                label.className = 'drama-result-export-label';
                label.textContent = `${sourceRun.exportLabel ?? sourceRun.exportFormat ?? '导出'} 文件`;
                const open = document.createElement('button');
                open.type = 'button';
                open.className = 'drama-result-export-open';
                open.textContent = '打开文件';
                open.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    open.disabled = true;
                    try {
                        await ctx.drama.openGeneratedOutput(resultProject, sourceRun.exportFile);
                        setStatus(`已打开 ${sourceRun.exportLabel ?? sourceRun.exportFormat ?? '导出'} 文件`);
                    } catch (error) {
                        setStatus(`打开文件失败：${error.message}`);
                    } finally {
                        open.disabled = false;
                    }
                });
                exportFile.append(icon, label, open);
                body.appendChild(exportFile);
            }
            body.appendChild(out);
            if (sourceRun?.file) {
                const project = state.project;
                void fullOutputText(project, sourceRun.file).then((full) => {
                    if (out.isConnected && state.project === project) renderResult(full);
                }).catch(() => {});
            }
        } else if (state.editing === node.id) {
            body.appendChild(renderEditor(node));
        } else {
            if (node.type !== 'image' && node.type !== 'skill') renderInputSlots(node, type, body);
            const summary = summarize(node);
            if (summary !== '' && node.type !== 'text') {
                const s = document.createElement('div');
                s.className = 'drama-summary';
                s.textContent = summary;
                body.appendChild(s);
            }
            if (node.type === 'text') {
                const out = document.createElement('div');
                out.className = 'drama-out drama-text-content';
                // 正文来自当前输入；旧运行缓存不能覆盖编辑后的内容。
                out.textContent = String(node.params?.value ?? run?.output ?? '');
                out.setAttribute('aria-label', '文本内容');
                out.tabIndex = 0;
                body.appendChild(out);
            } else if (card.classList.contains('has-output')) {
                const renderProject = state.project;
                const key = `${renderProject}\0${run.file}`;
                const cached = run.file ? state.outputTexts.get(key) : undefined;
                const panel = createDramaOutputPanel({
                    doc: document,
                    text: typeof cached === 'string' ? cached : String(run.output ?? ''),
                    renderMarkdownNodes,
                    initialMode: state.outputModes.get(node.id) ?? 'preview',
                    onModeChange: (mode) => state.outputModes.set(node.id, mode),
                });
                body.appendChild(panel.element);
                if (run.file && typeof cached !== 'string') {
                    panel.setStatus('加载全文…');
                    void fullOutputText(renderProject, run.file).then((full) => {
                        if (!panel.element.isConnected || state.project !== renderProject) return;
                        panel.setText(full);
                        panel.setStatus('Markdown');
                    }).catch(() => {
                        if (panel.element.isConnected && state.project === renderProject) {
                            panel.setStatus('全文读取失败');
                        }
                    });
                }
            } else if (run?.output && !(node.type === 'image' && run.media?.length)) {
                const out = document.createElement('div');
                out.className = 'drama-out';
                out.textContent = String(run.output).slice(0, 120);
                out.title = String(run.output);
                body.appendChild(out);
            }
        }
        if (node.type === 'skill') {
            const hint = document.createElement('div');
            hint.className = 'drama-skill-note';
            hint.textContent = '用途参与需求匹配；正文与连入图片仅在被启用后读取。无需 @。';
            body.appendChild(hint);
        }
        if (['llm', 'image'].includes(node.type)) {
            const renderProject = state.project;
            const panel = createSkillPanel({
                doc: document,
                getState: () => ({ candidates: skillCandidates(state.graph, node.id),
                    match: currentSkillMatch(state.graph, node.id), run: state.graph.runs?.[node.id] }),
                readInput: input => input.file ? fullOutputText(renderProject, input.file) : Promise.resolve(input.text ?? ''),
                renderImages: files => renderImageGallery(node, { media: files }),
                onUpdate: () => { if (card.isConnected) card.style.minHeight = `${nodeContentMinHeight(card)}px`; },
            });
            panel.element.hidden = skillCandidates(state.graph, node.id).length === 0 && !run?.skillInput;
            card.refreshSkillFeedback = () => {
                panel.refresh();
                panel.element.hidden = skillCandidates(state.graph, node.id).length === 0 && !state.graph.runs?.[node.id]?.skillInput;
                if (card.isConnected) card.style.minHeight = `${nodeContentMinHeight(card)}px`;
            };
            body.appendChild(panel.element);
        }
        if (node.type === 'image-input') body.appendChild(renderReferenceInput(node));
        // 编辑提示词时也保留上次生成结果，避免进入编辑态后看起来像图片丢失。
        if (node.type === 'image') {
            const renderProject = state.project;
            const preview = createImagePromptPreview({
                doc: document,
                buildPrompt: buildImagePrompt,
                getPrompt: () => node.params?.prompt ?? '',
                readSources: async () => Promise.all((inboundOf(node.id)[0] ?? []).map(async (edge) => {
                    const source = nodeById(edge.from);
                    const sourceRun = state.graph.runs?.[edge.from];
                    const title = source?.title ?? typeById(source?.type)?.label ?? edge.from;
                    if (source?.type === 'text') return { title, text: source.params?.value ?? '',
                        pending: Boolean(source.params?.source) };
                    const text = source?.type === 'llm' && sourceRun?.file
                        ? await fullOutputText(renderProject, sourceRun.file) : sourceRun?.output ?? '';
                    return { title, text, pending: !['ok', 'cached'].includes(sourceRun?.status) };
                })),
                onUpdate: () => {
                    if (!card.isConnected) return;
                    card.style.minHeight = `${nodeContentMinHeight(card)}px`;
                    renderEdges();
                },
            });
            if (skillCandidates(state.graph, node.id).length) {
                preview.element.querySelector('summary').textContent = '普通提示词预览（技能运行时按需加入）';
            }
            body.appendChild(preview.element);
            body.addEventListener('input', (ev) => {
                if (ev.target.dataset?.paramKey === 'prompt') void preview.refresh();
            });
            const gallery = renderImageGallery(node, run);
            if (gallery) body.appendChild(gallery);
        }

        if (node.type === 'text') {
            const name = document.createElement('input');
            name.type = 'text';
            name.className = 'drama-node-name';
            name.value = String(node.title ?? type?.label ?? node.id);
            name.size = Math.max(4, Math.min(32, name.value.length));
            name.setAttribute('aria-label', '节点名称');
            name.autocomplete = 'off';
            name.spellcheck = false;
            name.addEventListener('input', () => {
                const current = nodeById(node.id);
                if (!current) return;
                current.title = name.value;
                name.size = Math.max(4, Math.min(32, name.value.length));
                scheduleSave();
            });
            name.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') name.blur();
            });
            card.append(name, body);
        } else if (node.type === 'run' || node.type === 'result') {
            const name = document.createElement('div');
            name.className = 'drama-node-name';
            name.textContent = node.title ?? type?.label ?? '节点';
            card.append(name, body);
        } else if (node.type === 'word-file') {
            const name = document.createElement('input');
            name.type = 'text';
            name.className = 'drama-node-name drama-word-name';
            name.value = node.title && node.title !== node.params?.name ? node.title : 'Word 文件';
            name.size = Math.max(4, Math.min(32, name.value.length));
            name.setAttribute('aria-label', 'Word 节点名称');
            name.autocomplete = 'off';
            name.spellcheck = false;
            name.addEventListener('input', () => {
                const current = nodeById(node.id);
                if (!current) return;
                current.title = name.value;
                name.size = Math.max(4, Math.min(32, name.value.length));
                scheduleSave();
            });
            name.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') name.blur();
            });
            name.addEventListener('dblclick', (event) => {
                event.stopPropagation();
                name.focus();
                name.select();
            });
            card.append(name, body);
        } else if (node.type === 'wps-file') {
            const name = document.createElement('div');
            name.className = 'drama-node-name drama-wps-name';
            name.textContent = node.params?.name ?? node.title ?? 'WPS 文件';
            name.title = name.textContent;
            card.append(name, body);
        } else {
            card.append(head, body);
        }
        (type?.inputs ?? []).forEach((label, index) => {
            const port = document.createElement('button');
            port.type = 'button';
            port.className = 'drama-port drama-port-input';
            const incoming = inboundOf(node.id)[index] ?? [];
            const connected = incoming.length > 0;
            if (connected) port.classList.add('connected');
            port.dataset.portIndex = String(index);
            port.style.top = ['text', 'run', 'result', 'word-file'].includes(node.type) ? '50%' : `${24 + index * 22}px`;
            const inputName = node.type === 'run' ? `文本输入端（可连接多个来源，当前 ${incoming.length} 条）` : `输入：${label}`;
            port.title = `${inputName}${type.multipleInputs?.includes(index)
                ? `（可连入多个节点，已连接 ${incoming.length} 个）` : connected ? '（已连接；拖动到空白处断开）' : ''}`;
            port.setAttribute('aria-label', `${node.title ?? type?.label ?? node.id} ${inputName}${connected ? '，拖动到空白处可断开连接' : ''}`);
            card.appendChild(port);
        });
        (type?.outputs ?? []).forEach((label, index) => {
            const port = document.createElement('button');
            port.type = 'button';
            port.className = 'drama-port drama-port-output';
            if ((state.graph.edges ?? []).some((edge) => edge.from === node.id
                && (edge.fromPort ?? 0) === index)) port.classList.add('connected');
            port.dataset.portIndex = String(index);
            port.style.top = ['text', 'run', 'result', 'word-file'].includes(node.type) ? '50%' : `${2 + index * 22}px`;
            port.title = `从这里拖出 ${label} 连线`;
            port.setAttribute('aria-label', `${node.title ?? type?.label ?? node.id} 输出：${label}`);
            card.appendChild(port);
        });
        const size = document.createElement('span');
        size.className = 'drama-resize-size';
        size.setAttribute('aria-hidden', 'true');
        card.appendChild(size);
        for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
            const edge = document.createElement('div');
            edge.className = `drama-resize-edge ${direction}`;
            edge.dataset.resizeDir = direction;
            edge.setAttribute('aria-hidden', 'true');
            card.appendChild(edge);
        }
        bindDynamicPortHover(card);
        bindNodeGestures(card, node);
        bindConnectionGestures(card, node);
        bindDisconnectGestures(card, node);
        bindResizeGestures(card, node, size);
        return card;
    }

    /** 卡片上那行"当前参数"摘要(取第一个有值的参数)。 */
    function summarize(node) {
        const type = typeById(node.type);
        for (const p of type?.params ?? []) {
            const v = node.params?.[p.key];
            if (v === undefined || v === null || String(v) === '') continue;
            const text = String(v).replace(/\s+/g, ' ').trim();
            if (text === '') continue;
            return `${p.label}:${text.slice(0, 60)}`;
        }
        return '';
    }

    function renderRunControl(node, run) {
        const box = document.createElement('div');
        box.className = 'drama-run-control';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'drama-run-button';
        button.textContent = '运行';
        button.disabled = state.busy;
        button.setAttribute('aria-label', `运行节点「${node.title ?? '运行'}」`);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            void runGraph(node.id, true, true);
        });
        const stateLabel = run?.status === 'running' ? '正在运行'
            : run?.status === 'failed' ? (run.error ?? '运行失败')
                : run?.status === 'ok' || run?.status === 'cached' ? '已完成' : '';
        box.appendChild(button);
        if (stateLabel !== '') {
            const status = document.createElement('div');
            status.className = `drama-run-state drama-run-state-${statusKey(run)}`;
            status.setAttribute('aria-live', 'polite');
            status.textContent = stateLabel;
            box.appendChild(status);
        }
        return box;
    }

    function renderEditor(node) {
        const type = typeById(node.type);
        const box = document.createElement('div');
        box.className = 'drama-editor';
        if (node.type === 'skill') {
            const label = document.createElement('label');
            label.className = 'drama-field';
            const caption = document.createElement('span');
            caption.textContent = '技能名称';
            const name = document.createElement('input');
            name.type = 'text';
            name.dataset.skillName = 'true';
            name.value = node.title ?? '技能';
            name.addEventListener('input', () => {
                node.title = name.value.trim() || '技能';
                const card = name.closest('.drama-node');
                card.querySelector('.drama-node-title').textContent = node.title;
                refreshSkillFeedback(); scheduleSave();
            });
            label.append(caption, name);box.appendChild(label);
        }
        for (const p of type?.params ?? []) {
            const label = node.type === 'text' ? null : document.createElement('label');
            if (label) label.className = 'drama-field';
            const value = node.params?.[p.key] ?? p.default ?? '';
            if (node.type === 'text' && p.type === 'textarea') {
                const editor = document.createElement('div');
                editor.className = 'drama-textarea drama-live-markdown';
                editor.dataset.paramKey = p.key;
                const live = mountLiveMarkdown(editor, String(value), {
                    showToolbar: false,
                    onInput: (markdown) => {
                        const current = nodeById(node.id);
                        if (!current) return;
                        current.params = { ...(current.params ?? {}), [p.key]: markdown };
                        scheduleSave();
                        refreshSkillFeedback();
                    },
                });
                const content = editor.querySelector('.live-markdown-content');
                if (content) {
                    content.classList.add('drama-output-markdown');
                    content.dataset.paramKey = p.key;
                    content.setAttribute('aria-label', p.label);
                    content.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Escape') {
                            live.dispose();
                            state.editing = null;
                            render();
                        }
                    });
                }
                box.appendChild(editor);
                continue;
            }
            const input = p.type === 'textarea'
                ? document.createElement('textarea')
                : document.createElement('input');
            if (p.type !== 'textarea') input.type = p.type === 'number' ? 'number' : 'text';
            input.value = String(value);
            input.dataset.paramKey = p.key;
            // ⚠️ 打字时**推迟重建**:一改就 render() 会把正在聚焦的这个元素换掉,
            // 光标随即丢失(独立版踩过:表现是"输入框里敲不进字")。
            input.addEventListener('input', () => {
                state.graph.nodes.find((n) => n.id === node.id).params = {
                    ...(nodeById(node.id)?.params ?? {}),
                    [p.key]: input.value,
                };
                scheduleSave();
                refreshSkillFeedback();
            });
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape') {
                    state.editing = null;
                    render();
                }
            });
            // 标签行:标题 + (只有标了 importable 的参数才有)那个 ＋
            if (node.type === 'text') {
                input.className = 'drama-textarea';
                input.setAttribute('aria-label', p.label);
                box.appendChild(input);
            } else {
                const cap = document.createElement('span');
                cap.className = 'drama-field-cap';
                const capText = document.createElement('span');
                capText.textContent = p.label;
                cap.appendChild(capText);
                if (p.importable === true) cap.appendChild(importButton(node, p, input));
                label.append(cap, input);
                box.appendChild(label);
            }
        }
        return box;
    }

    function refreshSkillFeedback() {
        el.world.querySelectorAll('.drama-node').forEach(card => card.refreshSkillFeedback?.());
        renderEdges();
    }

    function renderReferenceInput(node) {
        const box = document.createElement('div');
        box.className = 'drama-reference-input';
        const files = Array.isArray(node.params?.files) ? node.params.files : [];
        const add = btn('导入参考图片', 'drama-reference-add');
        add.type = 'button';
        add.addEventListener('click', async event => {
            event.stopPropagation();
            const project = state.project;
            add.disabled = true;
            try {
                const picked = await ctx.dialog.openFile({ multiple: true,
                    filters: [{ name: '参考图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
                const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
                if (!paths.length) return;
                const current = nodeById(node.id);
                if (state.project !== project || !current) return;
                if ((current.params?.files?.length ?? 0) + paths.length > 4) throw new Error('一个图片输入节点最多保留 4 张图片');
                for (const file of paths) {
                    const result = await ctx.drama.importImage(project, file);
                    if (state.project !== project || !nodeById(node.id)) return;
                    current.params = { ...current.params, files: [...(current.params?.files ?? []), result.file] };
                    scheduleSave();
                }
                render();
                setStatus('参考图片已导入');
            } catch (error) {
                if (state.project === project) { render(); setStatus(`图片导入失败：${error.message}`); }
            } finally { add.disabled = false; }
        });
        box.appendChild(add);
        files.forEach((file, index) => {
            const remove = btn(`移除第 ${index + 1} 张`, 'drama-reference-remove');
            remove.type = 'button';
            remove.title = '仅移除节点引用，不删除图片文件';
            remove.addEventListener('click', event => {
                event.stopPropagation();
                node.params.files = files.filter(name => name !== file);
                render(); scheduleSave();
            });
            box.appendChild(remove);
        });
        const gallery = renderImageGallery(node, { media: files });
        if (gallery) box.appendChild(gallery);
        return box;
    }

    /**
     * 标签行右边那个 ＋:仅为显式标记了 importable 的文本输入提供文件导入。
     * 文本节点不带这个标记,只允许手动输入纯文本。
     */
    function importButton(node, param, input) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'drama-import';
        b.title = '导入文本文件…(txt / md / srt / json / csv / docx …)';
        b.setAttribute('aria-label', '导入文本文件');
        b.dataset.importFor = param.key;
        // 矢量加号(内联 SVG)。不 innerHTML:本仓库的规矩是只用 createElement 造节点。
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 12 12');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.6');
        svg.setAttribute('stroke-linecap', 'round');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M6 2v8M2 6h8');
        svg.appendChild(path);
        b.appendChild(svg);
        b.addEventListener('click', (ev) => {
            ev.preventDefault();          // 别让 label 把点击转给 textarea
            ev.stopPropagation();
            void importInto(node, param, input, b);
        });
        return b;
    }

    /**
     * 「＋ 导入」整条路:选文件 → (框里非空先确认) → 主进程抽文本 → 灌进允许导入的框。
     *
     * @param {object} node 目标节点
     * @param {object} param 目标参数(它有 importable 标记)
     * @param {HTMLTextAreaElement|HTMLInputElement|null} input 视野里那个输入框(没有就只改数据)
     * @param {HTMLElement|null} button 触发它的那个 ＋(用来转圈)
     */
    async function importInto(node, param, input, button) {
        if (node?.type === 'text') {
            setStatus('文本节点只支持手动输入纯文本');
            return;
        }
        const filters = [
            { name: '文本与剧本', extensions: state.textImport?.extensions ?? ['txt', 'md', 'srt'] },
            { name: '全部文件', extensions: ['*'] },
        ];
        try {
            const picked = await ctx.dialog.openFile({ multiple: false, filters });
            const filePath = Array.isArray(picked) ? picked[0] : picked;
            if (!filePath) { setStatus('取消导入(什么都没改)'); return; }

            const current = String(nodeById(node.id)?.params?.[param.key] ?? '');
            if (current.trim() !== '') {
                // 非空先问一句:导入是**替换**,一键抹掉手写的东西不行
                const ok = await confirmReplace(node, current.length);
                if (!ok) { setStatus('取消导入(原来的内容还在)'); return; }
            }

            if (button !== null) button.classList.add('busy');
            setStatus('正在读取文件…');
            const r = await ctx.drama.readText({ path: filePath });
            const target = nodeById(node.id);
            if (target === null) { setStatus('这个节点已经不在了'); return; }
            target.params = { ...(target.params ?? {}), [param.key]: r.text };
            if (input !== null) {
                input.value = r.text;
                input.classList.remove('fresh');
                void input.offsetWidth;              // 重启那段很轻的入场动画
                input.classList.add('fresh');
            }
            scheduleSave();
            setStatus(`已导入 ${r.name} · ${r.chars} 字 · ${r.note}`);
        } catch (err) {
            setStatus(`导入失败:${err.message}`);
        } finally {
            if (button !== null) button.classList.remove('busy');
        }
    }

    /** 替换确认条:优先显示在编辑器下方,未进入编辑时显示在画布中央。 */
    function confirmReplace(node, currentChars) {
        return new Promise((resolve) => {
            const editor = el.world.querySelector(`.drama-node[data-node-id="${node.id}"] .drama-editor`);
            const holder = editor ?? el.canvas;
            const row = document.createElement('div');
            row.className = 'drama-confirm';
            if (editor === null) row.classList.add('drama-confirm-canvas');
            const text = document.createElement('span');
            text.textContent = `框里已经有 ${currentChars} 字 —— 导入会把它替换掉?`;
            const yes = btn('替换', 'drama-confirm-yes pri');
            const no = btn('取消', 'drama-confirm-no');
            const refreshTextHeight = () => {
                const card = holder.closest('.drama-node[data-type="text"]');
                if (card) card.style.minHeight = `${nodeContentMinHeight(card)}px`;
            };
            const done = (ok) => {
                row.remove();
                refreshTextHeight();
                host.ownerDocument.removeEventListener('keydown', onKey);
                resolve(ok);
            };
            const onKey = (ev) => { if (ev.key === 'Escape') done(false); };
            yes.addEventListener('click', () => done(true));
            no.addEventListener('click', () => done(false));
            host.ownerDocument.addEventListener('keydown', onKey);
            row.append(text, yes, no);
            holder.appendChild(row);
            refreshTextHeight();
        });
    }

    function portPoint(node, direction, index = 0) {
        const card = el.world.querySelector(`.drama-node[data-node-id="${node.id}"]`);
        const port = card?.querySelector(`.drama-port-${direction}[data-port-index="${index}"]`);
        return {
            x: (node.x ?? 0) + (port ? port.offsetLeft + port.offsetWidth / 2
                : direction === 'output' ? nodeSnapBox(node).width - 10 : 10),
            y: (node.y ?? 0) + (port ? port.offsetTop + (['text', 'run', 'result'].includes(node.type) ? 0 : port.offsetHeight / 2)
                : 34 + index * 22),
        };
    }

    function appendEdgePath(a, b, className) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const bend = Math.max(40, Math.abs(b.x - a.x) / 2);
        line.setAttribute('d', `M${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`);
        line.setAttribute('class', className);
        el.svg.appendChild(line);
    }

    function renderEdges(draft = null) {
        // SVG 的自身尺寸与 viewBox 保持 1:1；图坐标与节点坐标才能在平移/缩放后仍重合。
        const box = worldBounds();
        const pad = 200;
        if (draft) {
            const minX = Math.min(box.minX, draft.start.x, draft.end.x);
            const minY = Math.min(box.minY, draft.start.y, draft.end.y);
            const maxX = Math.max(box.minX + box.w, draft.start.x, draft.end.x);
            const maxY = Math.max(box.minY + box.h, draft.start.y, draft.end.y);
            Object.assign(box, { minX, minY, w: maxX - minX, h: maxY - minY });
        }
        el.svg.style.left = `${box.minX - pad}px`;
        el.svg.style.top = `${box.minY - pad}px`;
        el.svg.style.width = `${box.w + pad * 2}px`;
        el.svg.style.height = `${box.h + pad * 2}px`;
        el.svg.setAttribute('viewBox',
            `${box.minX - pad} ${box.minY - pad} ${box.w + pad * 2} ${box.h + pad * 2}`);
        el.svg.innerHTML = '';
        for (const e of state.graph.edges ?? []) {
            if (draft?.skipEdge === e) continue;
            const a = nodeById(e.from);
            const b = nodeById(e.to);
            if (!a || !b) continue;
            const targetType = typeById(b.type);
            const slots = inputEdgeGroups(state.graph, b.id, targetType?.inputs?.length ?? 0, targetType?.multipleInputs);
            const index = slots.findIndex((group) => group.includes(e));
            const active = currentSkillMatch(state.graph, b.id)?.selected?.some(item => item.id === a.id);
            const style = a.type === 'skill' ? ` drama-edge-skill ${active ? 'active' : 'dormant'}` : '';
            appendEdgePath(portPoint(a, 'output', e.fromPort ?? 0),
                portPoint(b, 'input', index < 0 ? (e.toPort ?? 0) : index), `drama-edge${style}`);
        }
        if (draft?.start && draft?.end) appendEdgePath(draft.start, draft.end, 'drama-edge-draft');
    }

    function worldBounds() {
        const nodes = state.graph?.nodes ?? [];
        if (nodes.length === 0) return { minX: 0, minY: 0, w: 800, h: 600 };
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of nodes) {
            minX = Math.min(minX, n.x ?? 0);
            minY = Math.min(minY, n.y ?? 0);
            const box = nodeSnapBox(n);
            maxX = Math.max(maxX, (n.x ?? 0) + (n.w > 0 ? box.width : Math.max(170, box.width)));
            maxY = Math.max(maxY, (n.y ?? 0) + (n.h > 0 ? box.height : Math.max(120, box.height)));
        }
        return { minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    }

    function applyView() {
        el.world.style.transform =
            `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
        const hit = resizeHitSizes(state.view.scale);
        el.world.style.setProperty('--drama-resize-edge-hit', `${hit.edge}px`);
        el.world.style.setProperty('--drama-resize-corner-hit', `${hit.corner}px`);
    }

    function revealNodeInViewport(node, padding = 24) {
        const viewport = el.canvas.getBoundingClientRect();
        const box = nodeSnapBox(node);
        const scale = state.view.scale || 1;
        const width = box.width * scale;
        const height = box.height * scale;
        const minX = padding;
        const maxX = viewport.width - padding;
        const minY = padding;
        const maxY = viewport.height - padding;
        let left = state.view.x + box.x * scale;
        let top = state.view.y + box.y * scale;

        if (width > maxX - minX) state.view.x += (minX + maxX - width) / 2 - left;
        else if (left < minX) state.view.x += minX - left;
        else if (left + width > maxX) state.view.x -= left + width - maxX;

        if (height > maxY - minY) state.view.y += (minY + maxY - height) / 2 - top;
        else if (top < minY) state.view.y += minY - top;
        else if (top + height > maxY) state.view.y -= top + height - maxY;

        applyView();
    }

    function hideSnapFeedback() {
        if (!el.snapGuideX) return;
        el.snapGuideX.hidden = true;
        el.snapGuideY.hidden = true;
        el.snapGrid.hidden = true;
    }

    function showSnapFeedback(result) {
        const rect = el.canvas.getBoundingClientRect();
        const scale = state.view.scale || 1;
        const left = -state.view.x / scale;
        const right = (rect.width - state.view.x) / scale;
        const top = -state.view.y / scale;
        const bottom = (rect.height - state.view.y) / scale;
        if (result.guideX !== null) {
            el.snapGuideX.style.left = `${result.guideX}px`;
            el.snapGuideX.style.top = `${top - 100}px`;
            el.snapGuideX.style.height = `${bottom - top + 200}px`;
            el.snapGuideX.hidden = false;
        } else {
            el.snapGuideX.hidden = true;
        }
        if (result.guideY !== null) {
            el.snapGuideY.style.top = `${result.guideY}px`;
            el.snapGuideY.style.left = `${left - 100}px`;
            el.snapGuideY.style.width = `${right - left + 200}px`;
            el.snapGuideY.hidden = false;
        } else {
            el.snapGuideY.hidden = true;
        }
        if (result.gridX || result.gridY) {
            el.snapGrid.style.left = `${result.x}px`;
            el.snapGrid.style.top = `${result.y}px`;
            el.snapGrid.hidden = false;
        } else {
            el.snapGrid.hidden = true;
        }
    }

    function nodeSnapBox(node, x = node.x ?? 0, y = node.y ?? 0) {
        const card = el.world.querySelector(`.drama-node[data-node-id="${node.id}"]`);
        return {
            id: node.id,
            x,
            y,
            width: card?.offsetWidth || (node.w > 0 ? node.w : 150),
            height: card?.offsetHeight || (node.h > 0 ? node.h : 56),
        };
    }

    function nodeContentMinHeight(card) {
        const head = card.querySelector('.drama-node-head');
        const body = card.querySelector('.drama-node-body');
        if (card.dataset.type === 'text') {
            const outerHeight = (child) => {
                const style = getComputedStyle(child);
                return child.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
            };
            const fixed = [...(body?.children ?? [])]
                .filter((child) => !child.matches('.drama-text-content, .drama-editor'))
                .reduce((height, child) => height + outerHeight(child), 0);
            const editor = body?.querySelector('.drama-editor');
            const caps = [...(editor?.querySelectorAll('.drama-field-cap') ?? [])]
                .reduce((height, child) => height + child.offsetHeight + 2, 0);
            const confirms = [...(editor?.querySelectorAll('.drama-confirm') ?? [])]
                .reduce((height, child) => height + outerHeight(child) + 5, 0);
            // 只计固定栏和最小正文，不用随节点伸展的 scrollHeight 反向锁住缩小。
            return Math.max(92, (head?.offsetHeight ?? 0) + fixed + caps + confirms + 64);
        }
        if (card.dataset.type === 'result') {
            // 结果正文自身滚动，不能拿它的完整 scrollHeight 当节点最小高度：
            // Markdown 长文或窄列换行会把最小高度抬高，导致拖拽时节点被撑开且无法收回。
            const fixed = [...(body?.children ?? [])]
                .filter((child) => !child.classList.contains('drama-text-content'))
                .reduce((height, child) => {
                    const style = getComputedStyle(child);
                    return height + child.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
                }, 0);
            return Math.max(184, (head?.offsetHeight ?? 0) + fixed + 64);
        }
        if (card.dataset.type === 'image' && card.classList.contains('has-media')
            && card.classList.contains('has-custom-height')) {
            const fixed = [...(body?.children ?? [])]
                .filter((child) => !child.classList.contains('drama-image-gallery'))
                .reduce((height, child) => {
                    const style = getComputedStyle(child);
                    return height + child.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
                }, 0);
            // 图片框使用弹性高度后，仍给预览留出可辨认的最小空间；不再把默认 210px 当成硬下限。
            return Math.max(92, (head?.offsetHeight ?? 0) + fixed + 117);
        }
        if (card.classList.contains('has-output')) {
            const fixed = [...(body?.children ?? [])]
                .filter((child) => !child.classList.contains('drama-output-panel'))
                .reduce((height, child) => height + child.offsetHeight, 0);
            return Math.max(185, (head?.offsetHeight ?? 0) + fixed + 110);
        }
        return Math.max(92, (head?.offsetHeight ?? 0) + (body?.scrollHeight ?? 0) + 2);
    }

    /* ---------------- 选中(只改高亮,不重建) ---------------- */

    /**
     * 选中变化**只改 class**。
     * 这是"第二下进编辑"能成立的前提:重建 DOM 会把浏览器正要聚焦的元素换掉。
     */
    function repaintSelection() {
        for (const card of el.world.querySelectorAll('.drama-node')) {
            card.classList.toggle('sel', state.selection.has(card.dataset.nodeId));
        }
    }

    /* ---------------- 手势 ---------------- */

    function bindConnectionGestures(card, node) {
        for (const output of card.querySelectorAll('.drama-port-output')) {
            let gesture = null;
            const doc = host.ownerDocument;
            const targetAt = (ev) => {
                const canvas = el.canvas.getBoundingClientRect();
                if (ev.clientX < canvas.left || ev.clientX > canvas.right
                    || ev.clientY < canvas.top || ev.clientY > canvas.bottom) return null;
                const direct = doc.elementFromPoint(ev.clientX, ev.clientY)
                    ?.closest?.('.drama-port-input');
                if (direct) return direct;
                // 缩到 25% 时端口本身只有约 5px；屏幕坐标下给 12px 磁吸命中圈。
                let nearest = null;
                let best = 12 * 12;
                for (const port of el.world.querySelectorAll('.drama-port-input')) {
                    const rect = port.getBoundingClientRect();
                    const dx = ev.clientX - (rect.left + rect.width / 2);
                    const dy = ev.clientY - (rect.top + rect.height / 2);
                    const distance = dx * dx + dy * dy;
                    if (distance <= best) { nearest = port; best = distance; }
                }
                return nearest;
            };
            const clearTarget = () => {
                el.world.querySelectorAll('.drama-port-input.is-target')
                    .forEach((port) => port.classList.remove('is-target'));
            };
            const cleanup = () => {
                if (!gesture) return;
                const pointerId = gesture.pointerId;
                gesture = null;
                doc.removeEventListener('keydown', onEscape, true);
                clearTarget();
                el.canvas.classList.remove('connecting');
                try { output.releasePointerCapture(pointerId); } catch { /* 指针可能已取消 */ }
                renderEdges();
            };
            const onEscape = (ev) => {
                if (ev.key !== 'Escape' || !gesture) return;
                ev.preventDefault();
                ev.stopPropagation();
                cleanup();
                setStatus('已取消连线');
            };
            output.addEventListener('pointerdown', (ev) => {
                if (ev.button !== 0 || !state.graph) return;
                ev.preventDefault();
                ev.stopPropagation();
                gesture = { pointerId: ev.pointerId, fromPort: Number(output.dataset.portIndex),
                    start: portPoint(node, 'output', Number(output.dataset.portIndex)) };
                el.canvas.classList.add('connecting');
                doc.addEventListener('keydown', onEscape, true);
                try { output.setPointerCapture(ev.pointerId); } catch { /* 合成事件 */ }
                renderEdges({ start: gesture.start, end: canvasPoint(ev) });
            });
            output.addEventListener('pointermove', (ev) => {
                if (!gesture || ev.pointerId !== gesture.pointerId) return;
                ev.stopPropagation();
                clearTarget();
                const target = targetAt(ev);
                const targetNode = target?.closest('.drama-node');
                const result = targetNode && validateConnection(state.graph, state.types,
                    node.id, gesture.fromPort, targetNode.dataset.nodeId,
                    Number(target.dataset.portIndex));
                if (result?.ok) target.classList.add('is-target');
                const end = result?.ok
                    ? portPoint(nodeById(targetNode.dataset.nodeId), 'input', Number(target.dataset.portIndex))
                    : canvasPoint(ev);
                renderEdges({ start: gesture.start, end });
            });
            output.addEventListener('pointerup', (ev) => {
                if (!gesture || ev.pointerId !== gesture.pointerId) return;
                ev.preventDefault();
                ev.stopPropagation();
                const target = targetAt(ev);
                const targetNode = target?.closest('.drama-node');
                const result = targetNode && validateConnection(state.graph, state.types,
                    node.id, gesture.fromPort, targetNode.dataset.nodeId,
                    Number(target.dataset.portIndex));
                cleanup();
                if (!targetNode) { setStatus('已取消连线'); return; }
                if (!result.ok) { setStatus(result.reason); return; }
                state.graph.edges ??= [];
                state.graph.edges.push(result.edge);
                state.editing = null;
                render();
                scheduleSave();
                setStatus(targetNode.dataset.type === 'image'
                    ? '已连接；画面生成将合并全部上游文本' : '已连接；将读取上游内容');
            });
            output.addEventListener('pointercancel', (ev) => {
                if (gesture && ev.pointerId === gesture.pointerId) cleanup();
            });
            output.addEventListener('lostpointercapture', () => cleanup());
        }
    }

    /** 拖动已连接的输入端点：拖到兼容输出端可换接，拖到空白画布则断开。 */
    function bindDisconnectGestures(card, node) {
        const doc = host.ownerDocument;
        const findOutput = (ev) => {
            const canvas = el.canvas.getBoundingClientRect();
            if (ev.clientX < canvas.left || ev.clientX > canvas.right
                || ev.clientY < canvas.top || ev.clientY > canvas.bottom) return null;
            const direct = doc.elementFromPoint(ev.clientX, ev.clientY)
                ?.closest?.('.drama-port-output');
            if (direct) return direct;
            let nearest = null;
            let best = 12 * 12;
            for (const port of el.world.querySelectorAll('.drama-port-output')) {
                const rect = port.getBoundingClientRect();
                const dx = ev.clientX - (rect.left + rect.width / 2);
                const dy = ev.clientY - (rect.top + rect.height / 2);
                const distance = dx * dx + dy * dy;
                if (distance <= best) { nearest = port; best = distance; }
            }
            return nearest;
        };
        const clearTargets = () => {
            el.world.querySelectorAll('.drama-port-output.is-target')
                .forEach((port) => port.classList.remove('is-target'));
        };

        for (const input of card.querySelectorAll('.drama-port-input')) {
            let gesture = null;
            const portIndex = Number(input.dataset.portIndex);
            const cleanup = () => {
                if (!gesture) return;
                const pointerId = gesture.pointerId;
                gesture = null;
                doc.removeEventListener('keydown', onEscape, true);
                clearTargets();
                el.canvas.classList.remove('connecting', 'disconnecting');
                try { input.releasePointerCapture(pointerId); } catch { /* 指针可能已释放 */ }
                renderEdges();
            };
            const onEscape = (ev) => {
                if (ev.key !== 'Escape' || !gesture) return;
                ev.preventDefault();
                ev.stopPropagation();
                cleanup();
                setStatus('已取消断开');
            };
            const candidateFor = (edge, port) => {
                if (!port) return null;
                const sourceCard = port.closest('.drama-node');
                if (!sourceCard) return null;
                const from = sourceCard.dataset.nodeId;
                const fromPort = Number(port.dataset.portIndex);
                const graphWithoutEdge = { ...state.graph,
                    edges: state.graph.edges.filter((candidate) => candidate !== edge) };
                return {
                    from,
                    fromPort,
                    result: validateConnection(graphWithoutEdge, state.types,
                        from, fromPort, node.id, portIndex),
                    source: nodeById(from),
                };
            };

            input.addEventListener('pointerdown', (ev) => {
                if (ev.button !== 0 || !state.graph) return;
                const edges = inboundOf(node.id)[portIndex] ?? [];
                if (edges.length === 0) return;
                ev.preventDefault();
                ev.stopPropagation();
                if (edges.length !== 1) {
                    setStatus('该端口有多条连线，请在输入列表中用 × 单独断开');
                    return;
                }
                const edge = edges[0];
                const source = nodeById(edge.from);
                if (!source) return;
                const sourcePort = edge.fromPort ?? 0;
                const fixedEnd = portPoint(node, 'input', portIndex);
                gesture = {
                    pointerId: ev.pointerId,
                    edge,
                    source,
                    sourcePort,
                    fixedEnd,
                    start: fixedEnd,
                    current: fixedEnd,
                    clientX: ev.clientX,
                    clientY: ev.clientY,
                    moved: false,
                    candidate: null,
                };
                el.canvas.classList.add('connecting', 'disconnecting');
                doc.addEventListener('keydown', onEscape, true);
                try { input.setPointerCapture(ev.pointerId); } catch { /* 合成事件没有真指针 */ }
                renderEdges({ skipEdge: edge, start: portPoint(source, 'output', sourcePort), end: fixedEnd });
            });
            input.addEventListener('pointermove', (ev) => {
                if (!gesture || ev.pointerId !== gesture.pointerId) return;
                ev.stopPropagation();
                const point = canvasPoint(ev);
                gesture.current = point;
                gesture.moved ||= Math.hypot(ev.clientX - gesture.clientX, ev.clientY - gesture.clientY) >= 5;
                clearTargets();
                const port = findOutput(ev);
                const candidate = candidateFor(gesture.edge, port);
                gesture.candidate = candidate?.result.ok ? { ...candidate, port } : null;
                if (gesture.candidate) port.classList.add('is-target');
                renderEdges(gesture.candidate
                    ? { skipEdge: gesture.edge, start: portPoint(gesture.candidate.source, 'output', gesture.candidate.fromPort), end: gesture.fixedEnd }
                    : { skipEdge: gesture.edge, start: portPoint(gesture.source, 'output', gesture.sourcePort), end: point });
            });
            input.addEventListener('pointerup', (ev) => {
                if (!gesture || ev.pointerId !== gesture.pointerId) return;
                ev.preventDefault();
                ev.stopPropagation();
                const current = gesture;
                const pointer = canvasPoint(ev);
                const port = findOutput(ev);
                const candidate = candidateFor(current.edge, port);
                const candidateNode = port?.closest('.drama-node');
                const underPointer = doc.elementFromPoint(ev.clientX, ev.clientY);
                const overNode = Boolean(underPointer?.closest?.('.drama-node'));
                const canvas = el.canvas.getBoundingClientRect();
                const overCanvas = ev.clientX >= canvas.left && ev.clientX <= canvas.right
                    && ev.clientY >= canvas.top && ev.clientY <= canvas.bottom;
                const distance = Math.hypot(ev.clientX - current.clientX, ev.clientY - current.clientY);
                const edgeIndex = state.graph.edges.indexOf(current.edge);

                if (distance < 5) {
                    cleanup();
                    return;
                }
                if (candidate?.result.ok && candidateNode && edgeIndex >= 0) {
                    const unchanged = candidate.from === current.edge.from
                        && candidate.fromPort === (current.edge.fromPort ?? 0);
                    if (!unchanged) state.graph.edges[edgeIndex] = candidate.result.edge;
                    cleanup();
                    if (!unchanged) {
                        render();
                        scheduleSave();
                        setStatus('已重新连接');
                    }
                    return;
                }
                if (overCanvas && !overNode && edgeIndex >= 0) {
                    state.graph.edges.splice(edgeIndex, 1);
                    cleanup();
                    render();
                    scheduleSave();
                    setStatus('已断开连线');
                    return;
                }
                cleanup();
                if (candidate && !candidate.result.ok) setStatus(candidate.result.reason);
                else if (distance >= 5) setStatus('松开到空白画布即可断开；无效位置会保留原连接');
            });
            input.addEventListener('pointercancel', (ev) => {
                if (gesture && ev.pointerId === gesture.pointerId) cleanup();
            });
            input.addEventListener('lostpointercapture', () => cleanup());
        }
    }

    function bindDynamicPortHover(card) {
        if (card.dataset.type !== 'text' && card.dataset.type !== 'word-file') return;
        const ports = [...card.querySelectorAll('.drama-port')];
        if (ports.length === 0) return;
        const current = new Map(ports.map((port) => [port, 50]));
        const target = new Map(ports.map((port) => [port, 50]));
        let frame = 0;
        const sideOf = (port) => port.classList.contains('drama-port-input') ? 'input' : 'output';
        const animate = () => {
            let moving = false;
            for (const port of ports) {
                const next = current.get(port) + (target.get(port) - current.get(port)) * .18;
                current.set(port, next);
                port.style.top = `${next}%`;
                if (Math.abs(target.get(port) - next) > .08) moving = true;
            }
            if (ports.some((port) => port.classList.contains('connected'))) renderEdges();
            if (moving) frame = requestAnimationFrame(animate);
            else frame = 0;
        };
        const reset = () => {
            for (const port of ports) {
                port.classList.remove('is-near');
                target.set(port, 50);
            }
            if (!frame) frame = requestAnimationFrame(animate);
        };
        card.addEventListener('pointermove', (event) => {
            if (event.pointerType === 'touch' || event.target.closest?.('.drama-node-name')) return;
            const rect = card.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const nearLeft = x >= 0 && x <= 34;
            const nearRight = x <= rect.width && rect.width - x <= 34;
            const side = nearLeft ? 'input' : nearRight ? 'output' : null;
            for (const port of ports) {
                const active = sideOf(port) === side && y >= 0 && y <= rect.height;
                port.classList.toggle('is-near', active);
                if (!active) {
                    target.set(port, 50);
                    continue;
                }
                const pointerY = y / rect.height * 100;
                target.set(port, Math.max(42, Math.min(58, 50 + (pointerY - 50) * .14)));
            }
            if (!frame && ports.some((port) => Math.abs(target.get(port) - current.get(port)) > .08)) {
                frame = requestAnimationFrame(animate);
            }
        });
        card.addEventListener('pointerleave', reset);
    }

    function bindNodeGestures(card, node) {
        let gesture = null;   // 只在手势真正开始时才有值
        let suppressClick = false;
        const doc = card.ownerDocument;
        if (node.type === 'wps-file') {
            card.addEventListener('dblclick', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void openOfficeFileNode(node);
            });
        }

        card.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0 || gesture) return;
            suppressClick = false;
            const target = ev.target;
            // 端口连线和边缘拉伸有各自的手势；内容与按钮不再整块排除。
            if (target.closest?.('.drama-port, .drama-resize-edge')) return;
            const control = target.closest?.('input, textarea, select, button, a, summary, label, [contenteditable]:not([contenteditable="false"])');
            const contentRegion = target.closest?.('.drama-output-panel, .drama-text-content, .drama-image-prompt, .drama-input-sources, .drama-skill-panel, .drama-reference-input, .drama-image-gallery');
            const isResultText = node.type === 'result' && contentRegion?.classList.contains('drama-text-content');
            // Shift 保留原生选字；运行结果正文的普通单击要继续进入节点选中流程。
            if (ev.shiftKey && (control || contentRegion)) return;
            const content = isResultText ? null : contentRegion;
            const textBodyClick = node.type === 'text' && content?.classList.contains('drama-text-content');
            if (!control && !content) ev.preventDefault();
            gesture = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY,
                moved: false, nativeClick: Boolean(control || (content && !textBodyClick)), target };
            // 临时跟踪文档，快速划出节点时也能跨过阈值；捕获仍延迟到实际拖动。
            doc.addEventListener('pointermove', moveGesture, true);
            doc.addEventListener('pointerup', endGesture, true);
            doc.addEventListener('pointercancel', cancelGesture, true);
            doc.defaultView?.addEventListener('blur', cancelOnBlur);
        }, true);

        function moveGesture(ev) {
            if (!gesture || ev.pointerId !== gesture.pointerId) return;
            if (!card.isConnected) { cancelGesture(ev); return; }
            const dx = ev.clientX - gesture.x;
            const dy = ev.clientY - gesture.y;
            if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            ev.preventDefault();
            if (!gesture.moved) {
                gesture.moved = true;
                suppressClick = true;
                // 手势真正开始了:现在才捕获,并进入拖动
                try { card.setPointerCapture(ev.pointerId); } catch { /* 忽略 */ }
                if (!state.selection.has(node.id)) {
                    state.selection.clear();
                    state.selection.add(node.id);
                    repaintSelection();
                }
                gesture.origins = [...state.selection]
                    .map((id) => nodeById(id))
                    .filter(Boolean)
                    .map((n) => ({ n, x: n.x ?? 0, y: n.y ?? 0 }));
                for (const origin of gesture.origins) {
                    el.world.querySelector(`.drama-node[data-node-id="${origin.n.id}"]`)?.classList.add('dragging');
                }
                const selection = doc.getSelection();
                if (selection && (card.contains(selection.anchorNode) || card.contains(selection.focusNode))) {
                    selection.removeAllRanges();
                }
                const field = gesture.target.closest?.('input, textarea');
                try { field?.setSelectionRange(field.selectionStart, field.selectionStart); } catch { /* number 等无选区 */ }
            }
            const s = state.view.scale || 1;
            const selected = new Set(gesture.origins.map((origin) => origin.n.id));
            const moving = gesture.origins.map((origin) => nodeSnapBox(
                origin.n, origin.x + dx / s, origin.y + dy / s,
            ));
            const anchors = (state.graph.nodes ?? [])
                .filter((candidate) => !selected.has(candidate.id))
                .map((candidate) => nodeSnapBox(candidate));
            const snapped = snapGroupPositions({ nodes: moving, anchors, view: state.view });
            const positions = new Map(snapped.positions.map((position) => [position.id, position]));
            for (const origin of gesture.origins) {
                const position = positions.get(origin.n.id);
                origin.n.x = Math.round(position.x);
                origin.n.y = Math.round(position.y);
            }
            showSnapFeedback(snapped);
            for (const id of state.selection) {
                const c = el.world.querySelector(`.drama-node[data-node-id="${id}"]`);
                const n = nodeById(id);
                if (c && n) {
                    c.style.left = `${Math.round(n.x)}px`;
                    c.style.top = `${Math.round(n.y)}px`;
                }
            }
            renderEdges();
        }

        function endGesture(ev, cancelled = false) {
            if (!gesture || ev.pointerId !== gesture.pointerId) return;
            const ended = gesture;
            gesture = null;
            cancelled ||= !card.isConnected;
            doc.removeEventListener('pointermove', moveGesture, true);
            doc.removeEventListener('pointerup', endGesture, true);
            doc.removeEventListener('pointercancel', cancelGesture, true);
            doc.defaultView?.removeEventListener('blur', cancelOnBlur);
            try { card.releasePointerCapture(ev.pointerId); } catch { /* 忽略 */ }
            if (ended.moved) {
                for (const origin of ended.origins) {
                    const element = el.world.querySelector(`.drama-node[data-node-id="${origin.n.id}"]`);
                    element?.classList.remove('dragging');
                    if (cancelled) {
                        origin.n.x = origin.x;
                        origin.n.y = origin.y;
                        if (element) {
                            element.style.left = `${Math.round(origin.x)}px`;
                            element.style.top = `${Math.round(origin.y)}px`;
                        }
                    }
                }
                hideSnapFeedback();
                if (cancelled) renderEdges();
                else scheduleSave();
                return;
            }
            if (cancelled) return;
            if (node.type === 'run' || node.type === 'result'
                || node.type === 'wps-file' || node.type === 'word-file') {
                if (!ended.nativeClick) {
                    state.selection.clear();
                    state.selection.add(node.id);
                    state.editing = null;
                    repaintSelection();
                }
                return;
            }
            if (ended.nativeClick) return;
            if (node.type === 'text') {
                state.selection.clear();
                state.selection.add(node.id);
                state.editing = node.id;
                render();
                el.world.querySelector(`.drama-node[data-node-id="${node.id}"] .live-markdown-content`)?.focus();
                return;
            }
            // 其他可编辑节点保持原来的行为:首次选择,再次点击进入编辑。
            if (state.selection.size === 1 && state.selection.has(node.id)) {
                state.editing = node.id;
                render();
            } else {
                state.selection.clear();
                state.selection.add(node.id);
                state.editing = null;
                repaintSelection();
            }
        }
        function cancelGesture(ev) { endGesture(ev, true); }
        function cancelOnBlur() {
            if (gesture) endGesture({ pointerId: gesture.pointerId }, true);
        }
        card.addEventListener('lostpointercapture', (ev) => {
            if (ev.target === card) cancelGesture(ev);
        });
        // 浏览器原生图片/文本拖拽会抢走 pointermove；节点移动统一由画布处理。
        card.addEventListener('dragstart', (ev) => ev.preventDefault());
        card.addEventListener('click', (ev) => {
            if (suppressClick && ev.detail !== 0) {
                suppressClick = false;
                ev.preventDefault();
                ev.stopImmediatePropagation();
                return;
            }
            if (node.type !== 'text' || ev.target.closest?.('.drama-port, .drama-resize-edge')) return;
            if (state.selection.size === 1 && state.selection.has(node.id)) return;
            state.selection.clear();
            state.selection.add(node.id);
            repaintSelection();
        }, true);

        // 双击标题栏 = 复原(与独立版一致:清掉手改的 w/h)
        card.querySelector('.drama-node-head')?.addEventListener('dblclick', () => {
            delete node.w;
            delete node.h;
            render();
            scheduleSave();
        });
    }

    function bindResizeGestures(card, node, size) {
        let gesture = null;

        function restoreOriginal(original) {
            node.x = original.x;
            node.y = original.y;
            if (original.hadWidth) node.w = original.w;
            else delete node.w;
            if (original.hadHeight) node.h = original.h;
            else delete node.h;
            card.classList.toggle('has-custom-height', node.type === 'image' && original.hadHeight);
            card.style.left = `${Math.round(node.x ?? 0)}px`;
            card.style.top = `${Math.round(node.y ?? 0)}px`;
            card.style.width = original.styleWidth;
            card.style.height = original.styleHeight;
            card.style.minHeight = `${nodeContentMinHeight(card)}px`;
            renderEdges();
        }

        function updateResize(ev) {
            if (!gesture || ev.pointerId !== gesture.pointerId) return;
            const motion = {
                box: gesture.box,
                direction: gesture.direction,
                clientDx: ev.clientX - gesture.clientX,
                clientDy: ev.clientY - gesture.clientY,
                scale: gesture.scale,
                minWidth: card.classList.contains('has-output') ? 220 : 150,
            };
            const draft = resizeNodeBox({ ...motion, minHeight: 92 });
            if (node.type === 'image' && card.classList.contains('has-media')) {
                card.classList.add('has-custom-height');
            }
            card.style.width = `${draft.width}px`;
            const minHeight = nodeContentMinHeight(card);
            const next = resizeNodeBox({ ...motion, minHeight });
            Object.assign(node, { x: next.x, y: next.y, w: next.width, h: next.height });
            card.style.left = `${next.x}px`;
            card.style.top = `${next.y}px`;
            card.style.width = `${next.width}px`;
            card.style.height = `${next.height}px`;
            card.style.minHeight = `${minHeight}px`;
            size.textContent = `${next.width} × ${next.height}`;
            renderEdges();
        }

        function endResize(ev, cancelled = false) {
            if (!gesture || ev.pointerId !== gesture.pointerId) return;
            ev.stopPropagation();
            if (!cancelled) updateResize(ev);
            const original = gesture.original;
            const initial = gesture.box;
            const changed = node.x !== initial.x || node.y !== initial.y
                || node.w !== initial.width || node.h !== initial.height;
            gesture = null;
            try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* 已释放 */ }
            card.classList.remove('resizing');
            if (cancelled || !changed) restoreOriginal(original);
            else scheduleSave();
        }

        for (const edge of card.querySelectorAll('.drama-resize-edge')) {
            edge.addEventListener('pointerdown', (ev) => {
                if (gesture || ev.button !== 0 || !state.selection.has(node.id)) return;
                ev.preventDefault();
                ev.stopPropagation();
                const box = nodeSnapBox(node);
                gesture = {
                    pointerId: ev.pointerId,
                    clientX: ev.clientX,
                    clientY: ev.clientY,
                    scale: state.view.scale || 1,
                    direction: edge.dataset.resizeDir,
                    box,
                    original: {
                        x: node.x, y: node.y, w: node.w, h: node.h,
                        hadWidth: Object.hasOwn(node, 'w'),
                        hadHeight: Object.hasOwn(node, 'h'),
                        styleWidth: card.style.width,
                        styleHeight: card.style.height,
                    },
                };
                size.textContent = `${box.width} × ${box.height}`;
                card.classList.add('resizing');
                try { edge.setPointerCapture(ev.pointerId); } catch { /* 合成事件 */ }
            });
            edge.addEventListener('pointermove', (ev) => {
                if (!gesture || ev.pointerId !== gesture.pointerId) return;
                ev.stopPropagation();
                updateResize(ev);
            });
            edge.addEventListener('pointerup', (ev) => endResize(ev));
            edge.addEventListener('pointercancel', (ev) => endResize(ev, true));
            edge.addEventListener('lostpointercapture', (ev) => endResize(ev, true));
        }
    }

    /* 空白处左键拖框选；空白单击清选。空格平移在捕获阶段先拦截，不会启动框选。 */
    let marqueeGesture = null;

    function hideMarqueeFeedback() {
        if (!el.marquee) return;
        el.marquee.hidden = true;
        el.canvas.removeAttribute('data-marquee');
    }

    function finishMarquee(ev, cancelled = false) {
        if (!marqueeGesture || ev.pointerId !== marqueeGesture.pointerId) return;
        const gesture = marqueeGesture;
        marqueeGesture = null;
        try { el.canvas.releasePointerCapture(ev.pointerId); } catch { /* 预览环境 / 合成事件 */ }
        hideMarqueeFeedback();
        let hits = [];
        if (gesture.moved && !cancelled) {
            const end = canvasPoint(ev);
            const rect = normalizeSelectionRect(gesture.start, end);
            const nodes = (state.graph?.nodes ?? []).map((node) => nodeSnapBox(node));
            hits = intersectingNodeIds(rect, nodes);
        }
        const next = finishMarqueeSelection(state.selection, hits, {
            moved: gesture.moved,
            cancelled,
            additive: gesture.additive,
        });
        if (cancelled) return;
        const wasEditing = state.editing !== null;
        state.selection.clear();
        for (const id of next) state.selection.add(id);
        state.editing = null;
        if (wasEditing) render();
        else repaintSelection();
    }

    el.canvas.addEventListener('pointerdown', (ev) => {
        // 空格抓手优先；同一个空白画布节点上也可能收到框选监听。
        if (navSpace) { ev.preventDefault(); return; }
        if (ev.button !== 0 || !state.graph) return;
        if (ev.target !== el.canvas && ev.target !== el.world && ev.target !== el.svg) return;
        marqueeGesture = {
            pointerId: ev.pointerId,
            startClientX: ev.clientX,
            startClientY: ev.clientY,
            start: canvasPoint(ev),
            additive: ev.shiftKey,
            moved: false,
        };
        ev.preventDefault();
        try { el.canvas.setPointerCapture(ev.pointerId); } catch { /* 预览环境 / 合成事件 */ }
    });
    el.canvas.addEventListener('pointermove', (ev) => {
        const gesture = marqueeGesture;
        if (!gesture || ev.pointerId !== gesture.pointerId) return;
        const dx = ev.clientX - gesture.startClientX;
        const dy = ev.clientY - gesture.startClientY;
        if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        gesture.moved = true;
        el.canvas.dataset.marquee = '1';
        const rect = normalizeSelectionRect(gesture.start, canvasPoint(ev));
        el.marquee.style.left = `${rect.x}px`;
        el.marquee.style.top = `${rect.y}px`;
        el.marquee.style.width = `${rect.width}px`;
        el.marquee.style.height = `${rect.height}px`;
        el.marquee.hidden = false;
    });
    el.canvas.addEventListener('pointerup', (ev) => finishMarquee(ev));
    el.canvas.addEventListener('pointercancel', (ev) => finishMarquee(ev, true));

    /* 右键:空白处 = 加节点;卡片上 = 那个节点自己的动作。
       ⚠️ 两种菜单都从**一个**入口分派 —— 别在卡片上各挂一个 contextmenu,
          那样"点在卡片边缘/标题上"会出现两个菜单一起弹。 */
    el.canvas.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const card = ev.target.closest?.('.drama-node');
        if (card !== null && card !== undefined) {
            openNodeMenu(ev, card.dataset.nodeId);
            return;
        }
        state.selection.clear();
        state.editing = null;
        repaintSelection();
        openAddMenu(ev);
    });
    const rememberCanvasPointer = (ev) => {
        lastCanvasPointer = { clientX: ev.clientX, clientY: ev.clientY };
    };
    el.canvas.addEventListener('pointermove', rememberCanvasPointer);

    // 点别处 / Esc 关菜单(捕获阶段:卡片自己的 pointerdown 也要能把它关掉)
    const menuDoc = host.ownerDocument;
    const onMenuDocPointer = (ev) => {
        if (menuNode !== null && !(ev.target?.closest?.('.drama-menu'))) closeCanvasMenu();
    };
    const onMenuDocKey = (ev) => { if (ev.key === 'Escape' && menuNode !== null) closeCanvasMenu(); };
    menuDoc.addEventListener('pointerdown', onMenuDocPointer, true);
    menuDoc.addEventListener('keydown', onMenuDocKey);
    ctx.onDispose(() => {
        menuDoc.removeEventListener('pointerdown', onMenuDocPointer, true);
        menuDoc.removeEventListener('keydown', onMenuDocKey);
        el.canvas.removeEventListener('pointermove', rememberCanvasPointer);
        // 面板被关掉时菜单挂在 document 上,必须自己收掉 —— 否则会留一块孤儿菜单
        if (menuNode !== null) { menuNode.remove(); menuNode = null; }
        hideGhost();
    });

    /* 滚轮平移 / Ctrl+滚轮缩放(与独立版同一套换算) */
    el.canvas.addEventListener('wheel', (ev) => {
        if (!ev.ctrlKey && ev.target.closest?.('.drama-output-scroll, .drama-text-content, .drama-node[data-type="text"] .live-markdown-content, .drama-node[data-type="text"] textarea, .drama-image-prompt-content, .drama-input-sources, .drama-skill-input')) return;
        ev.preventDefault();
        if (ev.ctrlKey) {
            const next = Math.min(2.5, Math.max(0.25, state.view.scale * (ev.deltaY < 0 ? 1.1 : 0.9)));
            const rect = el.canvas.getBoundingClientRect();
            const cx = ev.clientX - rect.left;
            const cy = ev.clientY - rect.top;
            // 以光标为锚:视图坐标 = (屏幕 - 平移) / 缩放
            state.view.x = cx - (cx - state.view.x) * (next / state.view.scale);
            state.view.y = cy - (cy - state.view.y) * (next / state.view.scale);
            state.view.scale = next;
        } else {
            state.view.x -= ev.deltaX;
            state.view.y -= ev.deltaY;
        }
        applyView();
    }, { passive: false });

    /* 收画布支持的拖拽资源(全应用拖拽总线,方案丙)—— 逻辑在 drop-bus.js 里 */
    void (async () => {
        // ⚠️ 结果**写进 DOM**:接不上总线时不能静默 —— 页面日志只在自检抛异常时才打印,
        //    静默失败的表现是"拖进去什么都没发生"(实测踩到过,查了半小时)。
        try {
            const mod = await import('./drop-bus.js');
            const offDrop = await mod.wireDrop({ ctx, el, state, nodeById, createNode,
                scheduleSave, setStatus });
            // Intercept image files first so they neither create nodes nor open in the window.
            const offNativeImageDrop = mod.wireNativeImageDrop({ el, setStatus });
            const offNativeFileDrop = mod.wireNativeFileDrop({
                el,
                setStatus,
                extensions: () => state.officeFileImport?.extensions ?? [],
                onOfficeFiles: (files, point) => importOfficeFiles({ files, point }),
            });
            ctx.onDispose?.(offDrop);
            ctx.onDispose?.(offNativeImageDrop);
            ctx.onDispose?.(offNativeFileDrop);
            el.canvas.dataset.dropWired = '1';
        } catch (err) {
            el.canvas.dataset.dropError = String(err?.message ?? err);
            ctx.log?.warn?.(`拖拽总线接不上:${err?.message ?? err}`);
        }
    })();

    /* ---------------- 空格 + 拖动 = 移动画布(临时抓手) ---------------- */
    //
    // 用户拍板的那条:按住空格,画布**任意位置**(含卡片上、连线上)都能拖着平移。
    //
    // 为什么值得单独一套状态机(而不是顺手塞个 if):
    //   · 空格是**打字字符** —— 焦点在输入框 / 正在编辑卡片标题时,空格必须照常输入,一个字都不许吞;
    //   · 空格默认还会**滚动页面 / 激活按钮** —— 只有"这次按键属于画布"时才 preventDefault;
    //   · 它要和既有三套手势共存:滚轮平移、Ctrl+滚轮缩放、拖节点 —— 前两个不动,
    //     拖节点在空格按住时**全让位**(这一刻点卡片几乎总是误操作);
    //   · 平移只改 state.view 再 applyView(),与滚轮平移**同一条路**(节点一个都不重建)。
    //
    // ⚠️ 纪律(插件头部那条踩坑):指针捕获只在**确认是平移之后**做 ——
    //    一 pointerdown 就捕获会让卡片里的按钮收不到 click。
    const navDoc = host.ownerDocument;
    /** 指针是否在画布范围内 —— 空格的作用域判据就是它(鼠标指着画布,这次空格才算画布的)。 */
    let navInside = false;
    /** 空格是否按着。 */
    let navSpace = false;
    /** 正在拖:记下起手时的指针位置与当时的 view。 */
    let navPan = null;

    /** 这次按键/这个焦点是不是"在打字"?是的话空格一律放行。 */
    function isTypingTarget(node) {
        if (node === null || node === undefined) return false;
        const tag = String(node.tagName ?? '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        return node.isContentEditable === true;
    }

    /** 画布上那两个状态写成属性(光标由 CSS 认它)—— 只在真的变了时才写。 */
    function paintNav() {
        const next = navPan !== null ? 'panning' : ((navSpace && navInside) ? 'pan' : null);
        if (next === null) {
            if (el.canvas.hasAttribute('data-nav')) el.canvas.removeAttribute('data-nav');
            return;
        }
        if (el.canvas.getAttribute('data-nav') !== next) el.canvas.setAttribute('data-nav', next);
    }

    /** pointerenter 可能在面板刚挂载、鼠标一直静止时尚未触发；以浏览器当前 hover 命中补正。 */
    function pointerIsOverCanvas(target = null) {
        return navInside || el.canvas.matches(':hover') || (target !== null && el.canvas.contains(target));
    }

    /** 结束一次平移(松鼠标 / 取消 / 收尾都走这里)。 */
    function endPan(pointerId) {
        if (navPan === null) return;
        const id = pointerId ?? navPan.pointerId;
        navPan = null;
        try { el.canvas.releasePointerCapture?.(id); } catch { /* 预览环境 / 合成事件 */ }
        paintNav();
    }

    /** 退出抓手态(松空格 / 失焦 / Esc)。⚠️ 不动 navInside:那是指针的位置,不是导航状态。 */
    function exitNav() {
        if (navPan !== null) endPan(null);
        navSpace = false;
        paintNav();
    }

    const onNavKeyDown = (ev) => {
        if (ev.key !== ' ' && ev.key !== 'Spacebar' && ev.code !== 'Space') return;
        // 打字优先:焦点在输入类元素里 → 空格是字符,不是手势(一个字都不许吞)
        if (isTypingTarget(ev.target) || isTypingTarget(navDoc.activeElement)) return;
        // 作用域:鼠标必须正指着画布 —— 否则会跟笔记面板 / AI 面板的空格抢。
        // matches(':hover') 覆盖面板刚挂载时指针已在画布、但 pointerenter 尚未同步的情况。
        if (!pointerIsOverCanvas()) return;
        navInside = true;
        ev.preventDefault();          // 不然会滚页面 / 点亮按钮
        if (navSpace) return;         // 长按的自动重复
        navSpace = true;
        paintNav();
    };
    const onNavKeyUp = (ev) => {
        if (ev.key !== ' ' && ev.key !== 'Spacebar' && ev.code !== 'Space') return;
        if (navSpace) exitNav();
    };
    const onNavEsc = (ev) => { if (ev.key === 'Escape' && navSpace) exitNav(); };
    const onNavBlur = () => { if (navSpace) exitNav(); };
    // 捕获阶段:先于任何输入框自己的处理(但打字判据已经在上面放行了)
    navDoc.addEventListener('keydown', onNavKeyDown, true);
    navDoc.addEventListener('keyup', onNavKeyUp, true);
    navDoc.addEventListener('keydown', onNavEsc);
    host.ownerDocument.defaultView?.addEventListener('blur', onNavBlur);

    el.canvas.addEventListener('pointerenter', () => { navInside = true; paintNav(); });
    // ⚠️ 用 enter/leave 而不是 over/out:后者会从子元素上冒泡上来,卡片一划过就把判据搅乱
    el.canvas.addEventListener('pointerleave', () => { navInside = false; paintNav(); });

    // 平移的起手必须走**捕获阶段**:空格按住那一刻,卡片自己的 pointerdown / 按钮 click 全让位
    el.canvas.addEventListener('pointerdown', (ev) => {
        if (!navSpace || ev.button !== 0 || !pointerIsOverCanvas(ev.target)) return;
        ev.preventDefault();
        // 空白处 pointerdown 的 target 就是 canvas 本身，stopPropagation 不会
        // 阻止同一元素上的框选监听；必须立即截断后续同节点监听。
        ev.stopImmediatePropagation();
        navInside = true;
        navPan = {
            pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY,
            vx: state.view.x, vy: state.view.y,
        };
        // ⚠️ 到这里才捕获(确认是平移了)—— 与插件头部那条纪律一致
        try { el.canvas.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件没有真指针 */ }
        paintNav();
    }, true);
    el.canvas.addEventListener('pointermove', (ev) => {
        if (navPan === null || ev.pointerId !== navPan.pointerId) return;
        state.view.x = navPan.vx + (ev.clientX - navPan.x0);
        state.view.y = navPan.vy + (ev.clientY - navPan.y0);
        applyView();                  // 只改 transform，不重建节点或连线
    });
    el.canvas.addEventListener('pointerup', (ev) => endPan(ev.pointerId));
    el.canvas.addEventListener('pointercancel', (ev) => endPan(ev.pointerId));
    ctx.onDispose(() => {
        navDoc.removeEventListener('keydown', onNavKeyDown, true);
        navDoc.removeEventListener('keyup', onNavKeyUp, true);
        navDoc.removeEventListener('keydown', onNavEsc);
        host.ownerDocument.defaultView?.removeEventListener('blur', onNavBlur);
        el.canvas.removeAttribute('data-nav');
    });

    /* ---------------- 画布上的两个右键菜单 ---------------- */
    //
    // 空白处 = 加节点(按分类分组的类型表);卡片上 = 那个节点自己的动作
    // (运行到此 / 重跑 / 编辑 / 删除)。
    //
    // ⚠️ 菜单挂在 document.body 上、用 fixed 定位。两个理由,缺一不可:
    //    · 画布是 overflow:hidden —— 菜单挂在里面会被裁掉;
    //    · world 上挂着 scale —— 挂在里面会被一起缩小(缩到 25% 时菜单变成看不清的小字)。

    let menuNode = null;
    let ghostEl = null;
    let nodeClipboard = null;
    let lastCanvasPointer = null;

    const closeCanvasMenu = () => {
        if (menuNode === null) return;
        const node = menuNode;
        menuNode = null;
        node.classList.add('closing');
        // ⚠️ 这一条**不记进任何定时器表**:开新菜单时若把它一起取消,那个正在收起的
        //    菜单就永远留在 DOM 里(预览里踩过)。
        setTimeout(() => node.remove(), 90);
        hideGhost();
    };

    /** 屏幕点 → 图坐标。与滚轮缩放同一套换算:视图坐标 = (屏幕 - 平移) / 缩放。 */
    function canvasPoint(ev) {
        const box = el.canvas.getBoundingClientRect();
        return clientToWorldPoint({
            clientX: ev.clientX,
            clientY: ev.clientY,
            canvasRect: box,
            view: state.view,
        });
    }

    /**
     * 落点虚线框:节点将会长在这里。
     * 放进 world(不是画布) —— 于是它跟着平移缩放一起动,读数与真实落点永远一致。
     */
    function showGhost(x, y) {
        hideGhost();
        const g = document.createElement('div');
        g.className = 'drama-ghost';
        g.style.left = `${Math.round(x - 75)}px`;
        g.style.top = `${Math.round(y - 28)}px`;
        el.world.appendChild(g);
        ghostEl = g;
    }

    function hideGhost() {
        if (ghostEl !== null) { ghostEl.remove(); ghostEl = null; }
    }

    /** 选定之后:虚线框放大淡出,卡片同一拍长出来 —— 视觉上读作"框变成了卡片"。 */
    function mergeGhost(then) {
        if (ghostEl === null) { then(); return; }
        const g = ghostEl;
        ghostEl = null;
        g.classList.add('merge');
        setTimeout(() => g.remove(), 150);
        then();
    }

    /**
     * 建一个菜单并贴到鼠标处。
     *
     * @param {Array<object>} items 每项:`{sep:true}` 分隔线 / `{label, badge?, danger?, onClick}` 可点项
     * @param {number} gapY 纵向让开多少(空白菜单要让开那个 56px 高的虚线框)
     */
    function buildMenu(items, ev, gapY) {
        closeCanvasMenu();
        // ⚠️ 上一条正在淡出的菜单(90ms)**必须**当场收掉:DOM 里同时躺着两个 .drama-menu 时
        //    "现在开着的是哪一个"就没有答案了 —— 点菜单项会抓到旧的那个(自检里就这么
        //    咬过一次:点「删除」抓到了上一张类型表,del 是 undefined,整个自检直接中断)。
        for (const stale of document.querySelectorAll('.drama-menu.closing')) stale.remove();
        const node = document.createElement('div');
        node.className = 'drama-menu';
        for (const item of items) {
            if (item.sep === true) {
                const line = document.createElement('div');
                line.className = 'drama-menu-sep';
                node.appendChild(line);
                continue;
            }
            const b = document.createElement('button');
            b.type = 'button';
            if (item.disabled === true) {
                b.disabled = true;
                b.setAttribute('aria-disabled', 'true');
            }
            if (typeof item.dot === 'string' && item.dot !== '') {
                const dot = document.createElement('i');
                // 类名带前缀(`.drama-menu-dot`):菜单在 body 上,而 `.dot` / `.k-*`
                // 那几条是作用域规则,匹配不到它 —— 底色写在 menu.css 里(见那里的注释)。
                dot.className = `drama-menu-dot k-${item.dot}`;
                b.appendChild(dot);
            }
            const label = document.createElement('span');
            label.className = 'drama-menu-label';
            label.textContent = item.label;
            b.appendChild(label);
            if (typeof item.badge === 'string' && item.badge !== '') {
                const badge = document.createElement('span');
                badge.className = 'drama-menu-badge';
                badge.textContent = item.badge;
                b.appendChild(badge);
            }
            if (item.danger === true) b.classList.add('danger');
            // ⚠️ 顺序:先执行动作、**再**关菜单。反过来的话,"加节点"那条路上的
            //    closeCanvasMenu() 会先 hideGhost,把虚线框直接删掉 ——
            //    "框实化成卡片"那条动效就整条丢了(预览里踩过)。
            b.addEventListener('click', (e2) => {
                e2.stopPropagation();
                if (item.disabled === true) return;
                item.onClick();
                closeCanvasMenu();
            });
            node.appendChild(b);
        }
        // 逐条错峰:按子元素顺序给 delay(16ms 一档,封顶 150ms —— 免得最后一条等太久)
        [...node.children].forEach((child, i) => {
            child.style.animationDelay = `${Math.min(i * 16, 150)}ms`;
        });
        document.body.appendChild(node);

        // ⚠️ 让开那个虚线框(它 150x56、以鼠标为中心)。贴着鼠标试过:菜单左上角正好压在
        //    框上,把"要落到哪儿"这条唯一证据挡掉了 —— 菜单和它要说明的东西不能打架。
        //    不越界照旧:右边不够往左翻、下面不够往上翻,缩放原点跟着翻到对应那一角。
        const GAP_X = 12;
        const r = node.getBoundingClientRect();
        const flipX = ev.clientX + GAP_X + r.width > window.innerWidth - 6;
        const flipY = ev.clientY + gapY + r.height > window.innerHeight - 6;
        node.style.left = `${Math.max(6, flipX ? ev.clientX - GAP_X - r.width : ev.clientX + GAP_X)}px`;
        node.style.top = `${Math.max(6, flipY ? ev.clientY - gapY - r.height : ev.clientY + gapY)}px`;
        node.style.transformOrigin = `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}`;
        menuNode = node;
    }

    /** 空白处的"加节点"菜单:只列可用节点类型。 */
    function openAddMenu(ev) {
        const p = canvasPoint(ev);
        showGhost(p.x, p.y);
        const items = [];
        if (nodeClipboard !== null) {
            const sameProject = nodeClipboard.project === state.project;
            const count = nodeClipboard.nodes.length;
            items.push({
                label: count > 1 ? `粘贴节点组(${count})` : '粘贴节点',
                disabled: !sameProject || !state.graph,
                onClick: () => mergeGhost(() => pasteGraphNodes(p)),
            });
            items.push({ sep: true });
        }
        for (const t of state.types) {
            if (!['text', 'run'].includes(t.id) || t.internal === true) continue;
            items.push({
                label: t.label,
                // 色点用引擎给的 color(text / img / vid / aud),与卡片头那个点是同一套
                dot: t.color ?? 'text',
                // 保留未接线状态标记,它不是输入/输出说明。
                badge: t.wired === false ? '未接线' : '',
                onClick: () => {
                    // 鼠标处就是卡片的**中心**(与虚线框逐字同一处),所以各减半个卡片。
                    // 关菜单由 buildMenu 统一负责(而且是在 onClick **之后**才关)。
                    const size = defaultNodeSize(t.id);
                    if (ghostEl) {
                        ghostEl.style.width = `${size.width}px`;
                        ghostEl.style.height = `${size.height}px`;
                        ghostEl.style.left = `${Math.round(p.x - size.width / 2)}px`;
                        ghostEl.style.top = `${Math.round(p.y - size.height / 2)}px`;
                    }
                    mergeGhost(() => { createNode(t.id, p.x - size.width / 2, p.y - size.height / 2); });
                },
            });
        }
        buildMenu(items, ev, 40);
    }

    function defaultNodeSize(typeId) {
        if (typeId === 'text') return { width: 280, height: 92 };
        if (typeId === 'run') return { width: 176, height: 92 };
        if (typeId === 'word-file') return { width: 290, height: 112 };
        if (typeId === 'result') return { width: 280, height: 184 };
        if (typeId === 'wps-file') return { width: 248, height: 96 };
        return { width: 150, height: 56 };
    }

    /**
     * 卡片上的菜单。
     *
     * ⚠️ 右键**不改动多选**,但要分清两种情况:点中的卡片已在选中里 → 动作就是对**所选**
     *    做的;不在 → 先把选中切到它。否则会出现"右键一个没选中的卡片、
     *    菜单写着「删除所选(3)」、删掉的却是另外三个" —— 那是真实的误删。
     */
    function openNodeMenu(ev, nodeId) {
        const node = nodeById(nodeId);
        if (node === null) return;
        if (!state.selection.has(nodeId)) {
            state.selection.clear();
            state.selection.add(nodeId);
            state.editing = null;
            repaintSelection();
        }
        const many = state.selection.size;
        const items = [];
        if (many === 1 && ['wps-file', 'word-file'].includes(node.type)) {
            items.push({
                label: '打开文件',
                onClick: () => { void openOfficeFileNode(node); },
            });
        }
        if (many === 1 && !['run', 'result', 'wps-file', 'word-file'].includes(node.type)) {
            items.push({
                label: '编辑',
                onClick: () => { state.editing = nodeId; render(); },
            });
        }
        if (!['wps-file', 'word-file'].includes(node.type)) items.push({
            label: many > 1 ? `运行所选(${many})` : '运行到此',
            onClick: () => { void runGraph(many > 1 ? null : nodeId, false); },
        });
        if (many === 1 && !['wps-file', 'word-file'].includes(node.type)) {
            items.push({
                label: '重跑',
                onClick: () => { void runGraph(nodeId, true); },
            });
        }
        items.push({
            label: many > 1 ? `复制所选节点(${many})` : '复制节点',
            onClick: () => { copySelectedNodes(); },
        });
        if (many > 1) {
            items.push({ label: '取消选中', onClick: () => { state.selection.clear(); state.editing = null; repaintSelection(); } });
        }
        items.push({ sep: true });
        items.push({
            label: many > 1 ? `删除所选(${many})` : '删除',
            danger: true,
            onClick: () => { deleteSelected(); },
        });
        buildMenu(items, ev, 10);
        // 卡片上不需要虚线框:那块地方本来就是它的
        hideGhost();
    }

    /**
     * 造一个节点。画布右键菜单统一走这里，避免默认参数、id 规则、选中和保存时机不一致。
     */
    function createNode(typeId, x, y) {
        const node = makeGraphNode(typeId, x, y);
        if (node === null) return null;
        state.selection.clear();
        state.selection.add(node.id);
        state.editing = null;
        state.fresh = node.id;
        render();
        scheduleSave();
        // 入场动画只放一次:动画跑完就把标记清掉,免得下次整块重建时又"新"一遍
        const card = el.world.querySelector(`.drama-node[data-node-id="${node.id}"]`);
        setTimeout(() => {
            if (state.fresh === node.id) state.fresh = null;
            card?.classList.remove('fresh');
        }, 430);
        return node.id;
    }

    function makeGraphNode(typeId, x, y, options = {}) {
        const t = typeById(typeId);
        if (!state.graph || t === null) return null;
        const baseId = `n${Date.now().toString(36)}`;
        let id = baseId;
        let suffix = 0;
        while (state.graph.nodes.some((node) => node.id === id)) {
            suffix += 1;
            id = `${baseId}-${suffix.toString(36)}`;
        }
        const node = {
            id,
            type: typeId,
            title: typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim() : t.label,
            x: Math.round(x),
            y: Math.round(y),
            params: { ...Object.fromEntries((t.params ?? []).map((p) => [p.key, p.default ?? ''])),
                ...(options.params ?? {}) },
            ...(typeof options.outputText === 'string' ? { outputText: options.outputText } : {}),
        };
        state.graph.nodes.push(node);
        return node;
    }

    function cloneGraphValue(value) {
        if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function copySelectedNodes() {
        if (!state.graph || !state.project || state.selection.size === 0) {
            setStatus('先选中要复制的节点');
            return false;
        }
        const selected = [...state.selection].map(nodeById).filter(Boolean);
        if (selected.length === 0) return false;
        const left = Math.min(...selected.map((node) => Number(node.x) || 0));
        const top = Math.min(...selected.map((node) => Number(node.y) || 0));
        try {
            nodeClipboard = {
                project: state.project,
                nodes: selected.map((node) => ({
                    type: node.type,
                    title: node.title,
                    x: (Number(node.x) || 0) - left,
                    y: (Number(node.y) || 0) - top,
                    params: cloneGraphValue(node.params ?? {}),
                    ...(typeof node.outputText === 'string' ? { outputText: node.outputText } : {}),
                    ...(Number.isFinite(node.w) ? { w: node.w } : {}),
                    ...(Number.isFinite(node.h) ? { h: node.h } : {}),
                })),
            };
        } catch (error) {
            nodeClipboard = null;
            setStatus(`复制节点失败：${error.message}`);
            return false;
        }
        setStatus(selected.length > 1
            ? `已复制 ${selected.length} 个节点（不含连线），可在画布空白处右键粘贴`
            : '已复制节点（不含连线），可在画布空白处右键粘贴');
        return true;
    }

    function pasteGraphNodes(point) {
        if (!state.graph || !state.project || nodeClipboard === null) {
            setStatus('没有可粘贴的节点');
            return false;
        }
        if (nodeClipboard.project !== state.project) {
            setStatus('节点副本只可粘贴回复制它的短剧项目');
            return false;
        }
        if (nodeClipboard.nodes.some((source) => typeById(source.type) === null)) {
            setStatus('当前项目缺少副本所需的节点类型');
            return false;
        }
        const x = Number(point?.x);
        const y = Number(point?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            setStatus('粘贴位置无效');
            return false;
        }
        const made = [];
        for (const source of nodeClipboard.nodes) {
            let params;
            try { params = cloneGraphValue(source.params); }
            catch (error) {
                for (const node of made) state.graph.nodes = state.graph.nodes.filter((item) => item.id !== node.id);
                setStatus(`粘贴节点失败：${error.message}`);
                return false;
            }
            const node = makeGraphNode(source.type, x - 75 + source.x, y - 28 + source.y,
                { title: source.title, params, outputText: source.outputText });
            if (node === null) {
                for (const created of made) state.graph.nodes = state.graph.nodes.filter((item) => item.id !== created.id);
                setStatus('粘贴失败：画布尚未就绪');
                return false;
            }
            if (Number.isFinite(source.w)) node.w = source.w;
            if (Number.isFinite(source.h)) node.h = source.h;
            made.push(node);
        }
        state.selection.clear();
        made.forEach((node) => state.selection.add(node.id));
        state.editing = null;
        state.fresh = made.at(-1)?.id ?? null;
        render();
        scheduleSave();
        const last = made.at(-1);
        const card = last ? el.world.querySelector(`.drama-node[data-node-id="${last.id}"]`) : null;
        setTimeout(() => {
            if (state.fresh === last?.id) state.fresh = null;
            card?.classList.remove('fresh');
        }, 430);
        setStatus(made.length > 1 ? `已粘贴 ${made.length} 个节点副本（不含连线）` : '已粘贴节点副本（不含连线）');
        return true;
    }

    /**
     * 删掉当前选中的那些节点(连同挂在它们身上的边)。
     * 右键菜单与 Delete 快捷键共用 —— 两处各写一遍迟早漏掉一处(比如忘了清选中)。
     */
    function deleteSelected() {
        if (!state.graph || state.selection.size === 0) return;
        const gone = new Set(state.selection);
        state.graph.nodes = state.graph.nodes.filter((n) => !gone.has(n.id));
        state.graph.edges = state.graph.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
        state.selection.clear();
        state.editing = null;
        render();
        scheduleSave();
    }

    /* ---------------- 保存与跑图 ---------------- */

    let saveTimer = null;
    function scheduleSave() {
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            saveTimer = null;
            if (!state.graph || !state.project) return;
            try {
                await ctx.drama.save(state.project, state.graph);
                setStatus('已保存');
            } catch (err) {
                setStatus(`保存失败:${err.message}`);
            }
        }, 400);
    }

    async function runGraph(target, force, createOutput = false) {
        if (state.busy || !state.project) return;
        state.busy = true;
        const runProject = state.project;
        const runId = `${Date.now()}-${++runSequence}`;
        state.activeRunId = runId;
        setStatus(target ? `运行到「${nodeById(target)?.title ?? target}」…` : '运行全部…');
        try {
            // 先把当前图的改动存下去,再让主进程跑 —— 否则跑的是盘上的旧图
            if (saveTimer !== null) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }
            await ctx.drama.save(runProject, state.graph);
            const r = await ctx.drama.run({ project: runProject, target, force, runId });
            if (state.project === runProject) {
                state.graph = r.state.graph;
                let createdOutput = null;
                let outputSaveError = null;
                const completedNode = nodeById(target);
                const completedRun = state.graph.runs?.[target];
                if (createOutput && completedNode?.type === 'run'
                    && ['ok', 'cached'].includes(completedRun?.status)) {
                    const generated = completedRun.file
                        ? await fullOutputText(runProject, completedRun.file)
                        : String(completedRun.output ?? '');
                    if (state.project === runProject && generated.trim() !== '') {
                        const box = nodeSnapBox(completedNode);
                        const existingResults = state.graph.nodes.filter((item) => item.type === 'result'
                            && /^运行结果(?: \d+)?$/.test(String(item.title ?? ''))).length;
                        const resultTitle = existingResults === 0 ? '运行结果' : `运行结果 ${existingResults + 1}`;
                        let resultY = completedNode.y ?? 0;
                        const resultX = (completedNode.x ?? 0) + box.width + 48;
                        const collides = (candidateY) => state.graph.nodes.some((item) => {
                            const other = nodeSnapBox(item);
                            return resultX < other.x + other.width + 18
                                && resultX + 280 + 18 > other.x
                                && candidateY < other.y + other.height + 16
                                && candidateY + 184 + 16 > other.y;
                        });
                        let attempts = 0;
                        while (collides(resultY) && attempts < 30) { resultY += 200; attempts += 1; }
                        createdOutput = makeGraphNode('result', resultX, resultY,
                            { title: resultTitle, outputText: generated });
                        if (createdOutput) {
                            state.graph.edges.push({ from: completedNode.id, fromPort: 0,
                                to: createdOutput.id, toPort: 0 });
                            state.selection.clear();
                            state.selection.add(createdOutput.id);
                            state.editing = null;
                            state.fresh = createdOutput.id;
                            try { await ctx.drama.save(runProject, state.graph); }
                            catch (error) { outputSaveError = error; }
                        }
                    }
                }
                render();
                if (createdOutput) {
                    revealNodeInViewport(createdOutput);
                    const card = el.world.querySelector(`.drama-node[data-node-id="${createdOutput.id}"]`);
                    setTimeout(() => {
                        if (state.fresh === createdOutput.id) state.fresh = null;
                        card?.classList.remove('fresh');
                    }, 430);
                    setStatus(outputSaveError
                        ? `结果已创建，但保存失败：${outputSaveError.message}`
                        : `已创建「${createdOutput.title}」`);
                } else setStatus(r.summary ?? '跑完了');
            }
        } catch (err) {
            if (state.project === runProject) setStatus(`跑图失败:${err.message}`);
        } finally {
            if (state.generatingNodes.size > 0) {
                state.generatingNodes.clear();
                if (state.project === runProject) render();
            }
            state.activeRunId = null;
            state.busy = false;
            el.world.querySelectorAll('.drama-run-button').forEach((button) => { button.disabled = false; });
        }
    }

    function setStatus(text) {
        state.status = text;
        renderNote();
    }

    async function openOfficeFileNode(node) {
        const project = state.project;
        if (!project || typeof node?.params?.file !== 'string') return;
        try {
            await ctx.drama.openOfficeFile(project, node.params.file);
            if (state.project === project) setStatus(`已打开 ${node.params?.name ?? node.title}`);
        } catch (error) {
            if (state.project === project) setStatus(`打开文件失败：${error.message}`);
        }
    }

    function renderNote() {
        if (!el.note) return;
        const parts = [];
        if (state.project) parts.push(state.project);
        if (state.status !== '') parts.push(state.status);
        el.note.textContent = parts.join(' · ');
        el.note.title = el.note.textContent;
    }

    function fitView() {
        if (!state.graph || (state.graph.nodes ?? []).length === 0) return;
        const box = worldBounds();
        const rect = el.canvas.getBoundingClientRect();
        const scale = Math.min(
            (rect.width - 40) / Math.max(1, box.w),
            (rect.height - 40) / Math.max(1, box.h),
            1,
        );
        // ⚠️ 下限 0.4 而不是 0.25:示例那张图横跨 1900px,而画布那一格通常只有
        // 三百多像素宽 —— 按"全部装下"算出来的缩放是 0.16,卡片会小到读不出标题。
        // 所以宁可**装不下**(让用户拖/缩放),也不要缩到不可读;「1:1」与
        // 滚轮缩放都在,想细看随时能放大。
        state.view.scale = Math.max(0.4, scale);
        state.view.x = 20 - box.minX * state.view.scale;
        state.view.y = 20 - box.minY * state.view.scale;
        applyView();
    }

    /* ---------------- 接线 ---------------- */

    // ⚠️ 原来这里挂着项目下拉的 change 与「新建项目…」按钮。两件事都搬到
    //    「短剧项目」面板去了(见 setupProjects);画布这边只订阅 store。

    el.runAll.addEventListener('click', () => runGraph(null, false));
    el.forceRun.addEventListener('click', () => runGraph(null, true));
    el.runTo.addEventListener('click', () => {
        const first = [...state.selection][0];
        if (first) void runGraph(first, false);
        else setStatus('先选一个节点,再点「运行到此」');
    });
    el.fit.addEventListener('click', fitView);
    el.reset1.addEventListener('click', () => {
        state.view = { x: 0, y: 0, scale: 1 };
        applyView();
    });
    el.importBtn.addEventListener('click', async () => {
        if (!state.project) {
            setStatus('先选一个项目');
            return;
        }
        // 工具条这条就是参数行「＋ 导入」的另一个入口:目标是**当前选中的可导入节点**。
        // ⚠️ 没选中、或者选中的不是带 importable 参数的节点 → 说清楚,**不猜**一个节点去灌:
        //    猜错就是把别人正在写的稿子替换掉了。
        const pickedId = [...state.selection][0] ?? null;
        const node = pickedId === null ? null : nodeById(pickedId);
        const param = typeById(node?.type)?.params?.find((p) => p.importable === true) ?? null;
        if (node === null || param === null) {
            setStatus(node?.type === 'text'
                ? '文本节点只支持手动输入纯文本'
                : '请选择带文本输入的节点,再导入');
            return;
        }
        // 顺手让它进编辑态:导入完内容就摆在眼前(不然只剩状态行一句话,用户还得自己双击)
        if (state.editing !== node.id) {
            state.editing = node.id;
            render();
        }
        const input = el.world.querySelector(
            `.drama-node[data-node-id="${node.id}"] [data-param-key="${param.key}"]`,
        );
        await importInto(node, param, input ?? null, null);
    });

    el.importOfficeBtn.addEventListener('click', () => { void importOfficeFiles(); });
    el.importWordBtn.addEventListener('click', () => { void importOfficeFiles({ wordOnly: true }); });

    async function importOfficeFiles({ files = [], point = null, wordOnly = false } = {}) {
        const project = state.project;
        const projectGraph = state.graph;
        if (!project || !projectGraph) {
            setStatus('先选一个项目，再导入文件');
            return;
        }
        const extensions = wordOnly ? ['docx'] : (state.officeFileImport?.extensions
            ?? ['wps', 'et', 'dps', 'wpt', 'ett', 'dpt', 'docx', 'xlsx', 'pptx']);
        try {
            let sources = Array.from(files ?? []).map(file => ({ file }));
            if (sources.length === 0) {
                const picked = await ctx.dialog.openFile({ multiple: true, filters: [
                    { name: wordOnly ? 'Word 文档' : 'WPS / Office 文件', extensions },
                    { name: '全部文件', extensions: ['*'] },
                ] });
                const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
                if (paths.length === 0) { setStatus('已取消导入'); return; }
                sources = paths.map(path => ({ path }));
            }
            if (state.project !== project || state.graph !== projectGraph) {
                setStatus('项目已切换，请在当前项目重新导入');
                return;
            }

            el.importWordBtn.disabled = true;
            el.importOfficeBtn.disabled = true;
            const rect = el.canvas.getBoundingClientRect();
            const dropPoint = point && Number.isFinite(Number(point.clientX))
                && Number.isFinite(Number(point.clientY))
                ? point : { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
            const center = canvasPoint(dropPoint);
            const created = [];
            const failures = [];
            const findPosition = (size) => {
                const startX = center.x - size.width / 2;
                const startY = center.y - size.height / 2;
                for (let attempt = 0; attempt < 80; attempt += 1) {
                    const column = attempt % 2;
                    const row = Math.floor(attempt / 2);
                    const x = startX + column * (size.width + 26);
                    const y = startY + row * (size.height + 24);
                    const collision = projectGraph.nodes.some((other) => {
                        const box = nodeSnapBox(other);
                        return x < box.x + box.width + 16 && x + size.width + 16 > box.x
                            && y < box.y + box.height + 14 && y + size.height + 14 > box.y;
                    });
                    if (!collision) return { x, y };
                }
                return { x: startX, y: startY + projectGraph.nodes.length * (size.height + 24) };
            };

            for (const source of sources) {
                if (state.project !== project || state.graph !== projectGraph) break;
                try {
                    const sourceName = source.file?.name ?? source.path ?? '';
                    if (wordOnly && !/\.docx$/i.test(sourceName)) {
                        throw new Error('Word 文件节点只支持 .docx');
                    }
                    const imported = source.file
                        ? await ctx.drama.importDroppedOfficeFile(project, source.file)
                        : await ctx.drama.importOfficeFile(project, source.path);
                    if (state.project !== project || state.graph !== projectGraph) break;
                    const nodeType = imported.extension === 'docx' ? 'word-file' : 'wps-file';
                    const size = defaultNodeSize(nodeType);
                    const position = findPosition(size);
                    const node = makeGraphNode(nodeType, position.x, position.y, {
                        title: nodeType === 'word-file' ? 'Word 文件' : imported.name,
                        params: {
                            file: imported.file,
                            name: imported.name,
                            extension: imported.extension,
                            size: imported.size,
                        },
                    });
                    if (node === null) throw new Error(nodeType === 'word-file'
                        ? 'Word 文件节点类型尚未就绪' : 'WPS 文件节点类型尚未就绪');
                    node.w = size.width;
                    node.h = size.height;
                    created.push(node);
                } catch (error) { failures.push(error.message); }
            }

            if (created.length > 0 && state.project === project && state.graph === projectGraph) {
                state.selection.clear();
                state.selection.add(created.at(-1).id);
                state.editing = null;
                state.fresh = created.at(-1).id;
                render();
                try { await ctx.drama.save(project, projectGraph); }
                catch (error) { failures.push(`节点保存失败：${error.message}`); }
                const freshId = state.fresh;
                const card = el.world.querySelector(`.drama-node[data-node-id="${freshId}"]`);
                setTimeout(() => {
                    if (state.fresh === freshId) state.fresh = null;
                    card?.classList.remove('fresh');
                }, 430);
            }
            if (failures.length > 0) {
                setStatus(created.length > 0
                    ? `已导入 ${created.length} 个文件；另有 ${failures.length} 个失败：${failures[0]}`
                    : `导入失败：${failures[0]}`);
            } else setStatus(`已导入 ${created.length} 个文件`);
        } catch (error) {
            setStatus(`${wordOnly ? '导入 Word 文件' : '导入 WPS 文件'}失败：${error.message}`);
        } finally {
            el.importWordBtn.disabled = !state.project;
            el.importOfficeBtn.disabled = !state.project;
        }
    }

    // 键盘:Delete 删选中 / Esc 退出编辑
    const onKey = (ev) => {
        if (!host.contains(ev.target)
            || ev.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c' && state.selection.size > 0) {
            if (copySelectedNodes()) ev.preventDefault();
            return;
        }
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v' && nodeClipboard !== null) {
            ev.preventDefault();
            const rect = el.canvas.getBoundingClientRect();
            const point = lastCanvasPointer
                ? canvasPoint(lastCanvasPointer)
                : canvasPoint({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
            pasteGraphNodes(point);
            return;
        }
        if (ev.key === 'Escape') {
            state.editing = null;
            state.selection.clear();
            render();
        }
        if (ev.key === 'Delete' && state.selection.size > 0) {
            // 与右键菜单同一条路(免得两处各写一遍,漏掉一处就出怪事)
            deleteSelected();
        }
    };
    host.ownerDocument.addEventListener('keydown', onKey);
    ctx.onDispose(() => host.ownerDocument.removeEventListener('keydown', onKey));

    /* ---------------- 启动 ---------------- */

    void (async () => {
        await store.ensureLoaded();
        const r = store.root;
        state.root = r;
        // 画布自己**不再去读根与清单**:那是 store 的事(两片面板共用一份)。
        if (r === null || r.root === null) {
            const why = store.reason || '短剧项目根不可用';
            renderEmpty(why);
            setStatus(why);
            el.note.textContent = why;
            for (const b of [el.importBtn, el.importOfficeBtn, el.runAll, el.runTo, el.forceRun]) b.disabled = true;
            return;
        }
        // 名牌与"要不要去读图"都由 applyStore 定 —— 它订阅的是 store 的变化。
        applyStore();
        ctx.log.info(`短剧画布就绪 · 根=${r.root}`);
    })();

    ctx.onDispose(() => {
        if (saveTimer !== null) clearTimeout(saveTimer);
        if (state.rebuildTimer !== null) clearTimeout(state.rebuildTimer);
        host.innerHTML = '';
    });
}

/* ------------------------------------------------------------------ *
 * 「短剧项目」面板
 * ------------------------------------------------------------------ */

/**
 * 项目面板:列表 + 新建 / 改名 / 删除,点一行就切换画布。
 *
 * 为什么单独一片面板(而不是在画布工具条上多塞几个按钮):
 *   · 画布工具条属于画布操作,项目管理是**另一件事**;
 *   · 列表要能滚动、要能右键、要能就地改名 —— 塞进工具条就没地方了;
 *   · 它天然是可关的:不关心项目的人把这格关掉,画布照样用(选中项仍在 store 里)。
 *
 * ⚠️ 它和画布**不各存一份状态**:清单与当前项目都在 store 里,两片都订阅它。
 */
function setupProjects(host, ctx, store) {
    host.innerHTML = '';

    const el = {};
    let renaming = null;      // 正在就地改名的那个项目
    let adding = false;       // 顶上那条"新项目"输入框开着没有
    let menu = null;          // {node, name} —— name 为 null 表示空白处菜单
    let confirmDel = null;    // 已经点过一次删除的那一项
    let confirmTimer = null;
    let note = '';            // 底下一行提示(改名失败之类)
    let noteErr = false;

    const build = () => {
        const root = document.createElement('div');
        root.className = 'dp-pane';

        const head = document.createElement('div');
        head.className = 'dp-head';
        const title = document.createElement('span');
        title.className = 'dp-title';
        title.textContent = '短剧项目';
        el.add = document.createElement('button');
        el.add.type = 'button';
        el.add.className = 'dp-add';
        el.add.textContent = '＋ 新建';
        el.add.title = '新建一个短剧项目';
        head.append(title, el.add);

        el.list = document.createElement('div');
        el.list.className = 'dp-list';
        el.foot = document.createElement('div');
        el.foot.className = 'dp-foot';

        root.append(head, el.list, el.foot);
        el.root = root;
        host.appendChild(root);
    };

    const setNote = (text, isErr = false) => { note = text; noteErr = isErr; };

    /** 一行右边那句小字:mtime 变成人话。 */
    const relTime = (ms) => {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '时间未知';
        const diff = Date.now() - ms;
        if (diff < 60_000) return '刚刚';
        if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
        if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
        if (diff < 172800_000) return '昨天';
        if (diff < 2592000_000) return `${Math.floor(diff / 86400_000)} 天前`;
        return new Date(ms).toLocaleDateString();
    };

    const metaText = (it) => {
        const when = relTime(it.mtime);
        if (typeof it.nodes !== 'number') return when;          // 老形状只有名字
        if (it.nodes === 0) return `空图 · ${when}`;
        return `${it.nodes} 节点 · ${it.shots ?? 0} 张图 · ${when}`;
    };

    const span = (cls, text) => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        return s;
    };

    /* ---------------- 菜单 ---------------- */

    const closeMenu = () => {
        if (menu !== null) { menu.node.remove(); menu = null; }
    };

    const openMenu = (ev, name) => {
        closeMenu();
        const node = document.createElement('div');
        node.className = 'dp-menu';
        const addItem = (label, danger, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            if (danger) b.className = 'danger';
            b.addEventListener('click', (e2) => { e2.stopPropagation(); fn(); });
            node.appendChild(b);
        };
        if (name === null) {
            addItem('新建项目…', false, () => { adding = true; renaming = null; closeMenu(); render(); focusInput(); });
        } else {
            addItem('重命名', false, () => { renaming = name; adding = false; closeMenu(); render(); focusInput(); });
            const label = confirmDel === name ? '再点一次确认删除' : '删除';
            addItem(label, true, () => {
                void askRemove(name, { clientX: ev.clientX, clientY: ev.clientY });
            });
        }
        // 菜单**留在面板容器里**(绝对定位):它不上浮到整个窗口,也就不会在
        // 面板被拖走/关掉之后留一块孤儿菜单在页面上。
        const box = el.root.getBoundingClientRect();
        node.style.left = `${Math.max(4, Math.min(ev.clientX - box.left, box.width - 150))}px`;
        node.style.top = `${ev.clientY - box.top + 2}px`;
        el.root.appendChild(node);
        menu = { node, name };
    };

    /* ---------------- 三个动作 ---------------- */

    const create = async (name) => {
        try {
            const r = await ctx.drama.create(name);
            adding = false;
            setNote('');
            // 新建完**自动切过去**:用户建一个项目就是为了接着往里放东西。
            await store.afterMutation(r?.project ?? name);
        } catch (err) {
            setNote(`建项目失败:${err.message}`, true);
            render();
        }
    };

    const rename = async (from, to) => {
        try {
            const r = await ctx.drama.rename(from, to);
            renaming = null;
            setNote('');
            await store.afterMutation(r?.project ?? to);
        } catch (err) {
            setNote(`改名失败:${err.message}`, true);
            render();
        }
    };

    /**
     * 删除的**第一下只是把文案换成确认**,第二下才真的删;4 秒没再点就退回去。
     * 与笔记目录那套两步确认同一个节奏 —— 这里删掉的是整个项目(shots/inputs 一起),
     * 走回收站可恢复,但仍然要挡一下手滑。
     */
    const askRemove = async (name, anchor) => {
        if (confirmDel !== name) {
            confirmDel = name;
            closeMenu();
            render();
            // 菜单关掉再**原地**重开一次,只把那一行文案换成确认 —— 用户的手还停在那儿,
            // 菜单跳走或消失都会让"再点一次"变成找不到目标。
            openMenu(anchor, name);
            if (confirmTimer !== null) clearTimeout(confirmTimer);
            confirmTimer = setTimeout(() => { confirmDel = null; render(); }, 4000);
            return;
        }
        if (confirmTimer !== null) { clearTimeout(confirmTimer); confirmTimer = null; }
        confirmDel = null;
        closeMenu();
        try {
            await ctx.drama.remove(name);
            setNote('');
            await store.afterMutation(null);
        } catch (err) {
            setNote(`删除失败:${err.message}`, true);
            render();
        }
    };

    /* ---------------- 渲染 ---------------- */

    function render() {
        closeMenu();
        el.list.textContent = '';
        const reason = store.reason;
        if (reason !== '') {
            el.list.appendChild(span('dp-empty', reason));
            el.foot.textContent = '';
            el.add.disabled = true;
            return;
        }
        el.add.disabled = false;

        if (adding) {
            const row = document.createElement('div');
            row.className = 'dp-row adding';
            const input = document.createElement('input');
            input.className = 'dp-input';
            input.placeholder = '新项目叫什么?';
            input.dataset.role = 'new';
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    const name = input.value.trim();
                    // 空名字与重名**当场拒**:不弹窗、不报错,输入框留着让人改。
                    if (name === '') { setNote('名字不能为空', true); render(); focusInput(); return; }
                    if (store.items.some((it) => it.name === name)) {
                        setNote(`项目「${name}」已经存在`, true);
                        render();
                        focusInput();
                        return;
                    }
                    void create(name);
                }
                if (ev.key === 'Escape') { adding = false; setNote(''); render(); }
            });
            input.addEventListener('blur', () => {
                // 失焦就收起输入框 —— 但正在提交(create 在飞)时不要拆掉它。
                if (adding) { adding = false; render(); }
            });
            row.appendChild(input);
            el.list.appendChild(row);
        }

        if (store.items.length === 0 && !adding) {
            const empty = document.createElement('div');
            empty.className = 'dp-empty';
            empty.textContent = '还没有项目。\n点「＋ 新建」建第一个。';
            el.list.appendChild(empty);
        }

        for (const it of store.items) {
            const row = document.createElement('div');
            row.className = `dp-row${it.name === store.current ? ' cur' : ''}`;
            row.dataset.project = it.name;
            if (renaming === it.name) {
                const input = document.createElement('input');
                input.className = 'dp-input';
                input.value = it.name;
                input.dataset.role = 'rename';
                input.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') {
                        const to = input.value.trim();
                        if (to === '' || to === it.name) { renaming = null; setNote(''); render(); return; }
                        if (store.items.some((x) => x.name === to)) {
                            setNote(`项目「${to}」已经存在`, true);
                            render();
                            focusInput();
                            return;
                        }
                        void rename(it.name, to);
                    }
                    if (ev.key === 'Escape') { renaming = null; setNote(''); render(); }
                });
                input.addEventListener('blur', () => {
                    if (renaming === it.name) { renaming = null; render(); }
                });
                row.appendChild(input);
            } else {
                row.appendChild(span('dp-name', it.name));
                row.appendChild(span('dp-meta', metaText(it)));
                row.addEventListener('click', () => { setNote(''); store.select(it.name); });
                row.addEventListener('contextmenu', (ev) => {
                    ev.preventDefault();
                    // 右键**不**顺带切换项目:用户可能只是想改名,不该把画布也换掉。
                    if (confirmDel !== null && confirmDel !== it.name) { confirmDel = null; render(); }
                    openMenu(ev, it.name);
                });
            }
            el.list.appendChild(row);
        }

        const total = store.items.length;
        el.foot.textContent = note !== ''
            ? note
            : (total === 0 ? '落在 短剧/' : `落在 短剧/ · 共 ${total} 个项目`);
        el.foot.dataset.err = noteErr && note !== '' ? '1' : '0';
    }

    function focusInput() {
        const input = el.list.querySelector('input');
        if (!input) return;
        input.focus();
        if (input.dataset.role === 'rename') input.select();
    }

    /* ---------------- 接线 ---------------- */

    // ⚠️ 必须先 build:下面每一行接线用的 el.* 都是它造出来的。
    //    (踩过一次:build 落在接线后面,第一行 el.add.addEventListener 就抛
    //     "Cannot read properties of undefined",整片面板一个字都渲染不出来。)
    build();

    el.add.addEventListener('click', () => { adding = true; renaming = null; setNote(''); render(); focusInput(); });

    // 空白处右键 = 新建(与笔记目录那边同一个手势)
    el.list.addEventListener('contextmenu', (ev) => {
        if (ev.target.closest('.dp-row') !== null) return;      // 行上的右键交给行自己
        ev.preventDefault();
        openMenu(ev, null);
    });

    const doc = host.ownerDocument;
    const onDocClick = (ev) => { if (menu !== null && !ev.target.closest('.dp-menu')) closeMenu(); };
    const onDocKey = (ev) => { if (ev.key === 'Escape' && menu !== null) closeMenu(); };
    doc.addEventListener('click', onDocClick);
    doc.addEventListener('keydown', onDocKey);

    ctx.onDispose(store.subscribe(() => { render(); }));
    ctx.onDispose(() => {
        if (confirmTimer !== null) clearTimeout(confirmTimer);
        doc.removeEventListener('click', onDocClick);
        doc.removeEventListener('keydown', onDocKey);
        host.innerHTML = '';
    });

    render();
    void store.ensureLoaded();
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function btn(text, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `drama-btn ${cls}`;
    b.textContent = text;
    return b;
}

function sep() {
    const s = document.createElement('span');
    s.className = 'drama-sep';
    return s;
}

/** 跑图状态 → class 后缀。没跑过是 idle。 */
function statusKey(run) {
    if (!run) return 'idle';
    if (run.status === 'ok') return 'ok';
    if (run.status === 'cached') return 'cached';
    if (run.status === 'running') return 'running';
    if (run.status === 'failed') return 'failed';
    return 'idle';
}

function statusText(run) {
    if (!run) return '—';
    if (run.status === 'ok') return '✓';
    if (run.status === 'cached') return '✓ 缓存';
    if (run.status === 'running') return '●';
    if (run.status === 'failed') return '✕';
    return '—';
}
