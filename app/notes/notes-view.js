// 笔记视图:左列表 + 中编辑器 + 右链接栏。
//
// 保存策略:编辑器报"有改动"后延迟自动保存(默认 800ms),切走前强制保存。
// 不每次按键都写盘:写盘走的是原子写(临时文件 + fsync + rename),频率太高既慢
// 又伤盘;也不只在手动点保存时写,那样切走一篇没保存的笔记就会丢内容。
//
// 编辑交互本身在 editor.js(光标所在块是源码、其余是渲染结果;可切只读预览)。
// 这个模块只负责"文件 ↔ 编辑器"的接线,以及列表、标签与链接栏。
import { createEditor } from './editor.js';
import { createDocxReader, showDocxReaderError } from './docx-reader.js';

// 「正在拖什么」的全应用总线:拖动是**自己画的**指针拖拽(不是浏览器拖放),
// 所以别的面板收不到 drop 事件 —— 由这里把"这一拖"播出去(见 app/lib/drag-bus.js)。
import { begin as beginBusDrag, end as endBusDrag } from '../lib/drag-bus.js';

const AUTOSAVE_MS = 800;

/**
 * 拖放的**落点判定**。抽成纯函数是有意的:它是这一整套交互里最容易写错、
 * 也最难在界面上看出来的部分(拖错了只是"东西去了别处"),必须能被单测直接钉住。
 *
 * 三条规则(与设计方案一致):
 *   · 拖到自己身上                          → forbidden
 *   · 把文件夹拖进**它自己的子孙**里          → forbidden(那是个环)
 *   · 悬在**文件夹**行的中段(1/4–3/4)        → into(进它)
 *   · 其余(含"拖到一篇笔记上")               → sibling,落到**那一行的父目录**
 *
 * @param {{dragPath:string, dragIsDir:boolean, targetPath:string, targetIsDir:boolean,
 *          frac:number, rootPath?:boolean}} p
 *        frac:指针在目标行内的相对位置 0–1;rootPath=true 表示"笔记库根投放带"
 * @returns {{kind:'into'|'sibling'|'forbidden', destFolder:string, reason:string, sameLevel:boolean}}
 */
export function resolveDropTarget({ dragPath, dragIsDir, targetPath, targetIsDir, frac, rootPath = false }) {
    const forbidden = (reason) => ({ kind: 'forbidden', destFolder: '', reason, sameLevel: false });
    if (typeof dragPath !== 'string' || dragPath === '') return forbidden('没有正在拖的东西');

    if (rootPath) {
        const parent = parentDir(dragPath);
        return { kind: 'sibling', destFolder: '', reason: '', sameLevel: parent === '' };
    }
    if (dragPath === targetPath) return forbidden('不能拖到它自己身上');

    // 把目录拖进自己的子孙里 → 会把目录变成自己的儿子,是个环。
    // 主进程那边还有一道同样的守卫(两道防线,与路径守卫同一口径)。
    if (dragIsDir && (targetPath + '/').startsWith(dragPath + '/')) {
        return forbidden('不能放进它自己的子文件夹');
    }

    if (targetIsDir && frac > 0.25 && frac < 0.75) {
        return { kind: 'into', destFolder: targetPath, reason: '', sameLevel: false };
    }
    // 其余情况落到"那一行的父目录"。同目录内 = 只是排序,而这一版**不做自定义排序**,
    // 所以调用方要据此提示"什么都没变"。
    const parent = parentDir(targetPath);
    return { kind: 'sibling', destFolder: parent, reason: '', sameLevel: parent === parentDir(dragPath) };
}

/** 相对路径的父目录。根返回 ''(统一用 / 分隔,与 vault 的约定一致)。 */
function parentDir(relPath) {
    const cut = String(relPath).lastIndexOf('/');
    return cut === -1 ? '' : String(relPath).slice(0, cut);
}

export function createNotesView({
    els, bridge, log = console, onOpenNote = null, onCloseDocx = null,
    /**
     * 「删除笔记」两步确认里,"再点一次确认删除"这个告警态自动还原的毫秒数。
     *
     * 为什么是可传的:这是**交互时长**而不是业务规则(4 秒对人够用),而单测里
     * 真等 4 秒既慢又脆 —— 用例递一个小值就能把"超时自动还原"这条规则钉住。
     * 生产不传,走默认值。
     */
    deleteConfirmMs = 4000,
}) {
    const {
        listEl, searchEl, newBtn, newFolderBtn, emptyEl, editorEl,
        titleEl, pathEl, saveBtn, statusEl, modeBtn, docEl,
        backlinkEl, outlinkEl, unresolvedEl, tagPanelEl,
        tagFilterBar, tagFilterName,
    } = els;

    let index = null;              // 最近一次 notes:index 的结果
    let currentPath = null;
    let docxReaderDispose = null;
    let openGeneration = 0;
    let saving = false;
    let saveTimer = null;
    let keyword = '';
    let tagFilter = null;
    let dirty = false;
    /** 收起的文件夹(记的是 Vault 内相对路径)。默认全展开 —— 用户建了文件夹就是要看见里面。 */
    const collapsedDirs = new Set();
    /** "新建文件夹"的内联输入行开着没有(不开原生对话框:Electron 的 window.prompt 不可用)。 */
    let newFolderOpen = false;
    /** 标签面板的状态(方案 4):排序方式 / 是否收起 / 是否展开全部 / 标签自己的过滤词。 */
    let tagSort = 'count';
    let tagCollapsed = false;
    let tagExpanded = false;
    let tagFilterOpen = false;
    let tagKeyword = '';

    /**
     * 列表上那个右键浮层菜单:{ el, kind, path }(kind 为 'note' | 'dir' | 'blank')。
     * null = 没开着。同一时刻只可能有一个 —— 开新的先关旧的。
     *
     * 为什么是渲染层 DOM 浮层,不是 Electron 的原生 `Menu`:原生菜单在主进程,
     * 样式/键盘/关闭时机都不受渲染层控制;而工作台标签条的右键菜单
     * (panel-workspace.js 的 `openPopup('ctx', …)`)走的就是渲染层浮层 ——
     * 同一个界面里塞两种右键菜单,用户一眼就看出不是一套东西。
     */
    let noteMenu = null;
    /**
     * 正在行内改名的那篇笔记(Vault 内相对路径)。null = 没有。
     * 行的样子由它决定(noteItem 里据此改渲染成输入框),而不是直接改 DOM ——
     * 列表本来就是"索引一变就整段重画",让改名态也参与重画,就不会出现
     * "重画之后输入框没了、用户打的字跟着没了"。
     */
    let renamingPath = null;
    /**
     * 改名途中已经打的字。**必须**跨重画保留:编辑器自动保存收尾时会刷新索引
     * (refreshIndex → renderList),那一下会把输入框整个重建 —— 不留草稿的话,
     * 用户刚敲进去的名字会被"预填的主名"悄悄盖回去。
     */
    let renameDraft = null;
    /** 只有**刚进入**改名态那一次要全选预填内容;重画之后的聚焦不该再全选一次(会吃掉正在输的字)。 */
    let renameSelectPending = false;
    /**
     * 即将被我们自己重画掉的那个改名输入框(元素本身)。
     *
     * 为什么按下标/状态记不行,非得记元素:重画时 `listEl.innerHTML = ''` 会把正聚焦的
     * 输入框摘掉,浏览器照样派发一次 blur —— 而**派发时机不保证在"已断开"之后**
     * (真窗口实测:blur 跑起来时 `input.isConnected` 还是 true),所以不能只靠
     * isConnected 判"这是我们自己拆的"。按元素身份判断与派发时机无关,永远成立。
     */
    let repaintDoomedInput = null;

    // ---------- 状态提示 ----------

    function setStatus(text, state = '') {
        if (!statusEl) return;
        statusEl.textContent = text;
        if (state) statusEl.dataset.state = state;
        else delete statusEl.dataset.state;
    }

    // ---------- 列表 ----------

    /**
     * 把扁平的 notes/folders 拼成一棵树。
     *
     * 目录有两个来源,两个都要认:`index.folders`(空文件夹只有这里有)与
     * 笔记路径里推出来的中间层(某些情况下 folders 没列到)。用 Map 而不是数组:
     * 目录多起来时按路径查找是 O(1)。
     */
    function buildTree(notes, folders, texts = [], others = []) {
        const root = { name: '', path: '', dirs: new Map(), notes: [], texts: [], others: [] };
        // 平表:按完整路径 O(1) 找节点。树本身是 parent.dirs,两者要**同时**维护 ——
        // 只往平表里挂(而不挂到父节点下)会让所有目录都变成根的直系子节点,
        // 层级与缩进就全错了(这条是写完就踩到、被用例抓住的)。
        const byPath = new Map();
        function ensureDir(rel) {
            if (rel === '') return root;
            const hit = byPath.get(rel);
            if (hit) return hit;
            const cut = rel.lastIndexOf('/');
            const parent = ensureDir(cut === -1 ? '' : rel.slice(0, cut));
            const node = {
                name: cut === -1 ? rel : rel.slice(cut + 1),
                path: rel,
                dirs: new Map(),
                notes: [],
                texts: [],
                others: [],
            };
            parent.dirs.set(rel, node);
            byPath.set(rel, node);
            return node;
        }
        for (const f of folders) ensureDir(String(f));
        for (const n of notes) {
            const cut = n.path.lastIndexOf('/');
            ensureDir(cut === -1 ? '' : n.path.slice(0, cut)).notes.push(n);
        }
        // 纯文本笔记:与笔记同处一层,但**单独一组**排在它们后面(见 renderDir)。
        for (const t of texts) {
            const cut = t.path.lastIndexOf('/');
            ensureDir(cut === -1 ? '' : t.path.slice(0, cut)).texts.push(t);
        }
        // 非笔记文件(图片 / 文档 / json)。它们与笔记同处一层,只是渲染不同 ——
        // 不列出来的话,那些 shots/ 里的图在树里根本不存在,也就无从"拖进文件夹"。
        for (const o of others) {
            const cut = o.path.lastIndexOf('/');
            ensureDir(cut === -1 ? '' : o.path.slice(0, cut)).others.push(o);
        }
        return root;
    }

    /* ------------------------------------------------------------------ *
     * 拖动:把一行拖进文件夹 / 拖到一行上(等同于进它所在的文件夹)
     *
     * ⚠️ 三条硬约束(都是这个仓库踩过并写下来的):
     *   ① **不抢 click**。拖动靠"按下后移动超过阈值"判定,单纯点击一个字节都不改 ——
     *      否则已有的三套交互(点开笔记、点箭头折叠、点 ＋ 新建)会一起坏掉。
     *   ② **捕获只在手势真正开始时做**(超过阈值那一刻)。一上来就 setPointerCapture
     *      会让行内按钮收不到 click,还会把"点空白"误判成点到这一行。
     *   ③ 落点判定走 resolveDropTarget 那个**纯函数**(已被 12 条单测钉住),
     *      这里只负责量位置与画反馈。
     * ------------------------------------------------------------------ */

    const DRAG_THRESHOLD_PX = 5;
    const dragState = {
        active: false,      // 已经越过阈值(手势真正开始了)
        down: false,
        from: null,         // 被拖的相对路径
        fromIsDir: false,
        fromName: '',
        startX: 0, startY: 0,
        pointerId: null,
        row: null,          // 按下的那一行(用作捕获元素)
        target: null,       // 当前落点判定结果
        targetRow: null,
        busStarted: false,  // 这一手**真的拖起来了**、并且已经播给总线(纯点击不该播)
    };

    // ⚠️ 真拖过一手的**那一下点击必须吃掉**。
    //    拖动时行上设了 pointer capture,浏览器于是把 pointerup 之后那次 click **派发回那一行**
    //    (capture 目标就是 click 目标)—— 行的 click 处理器会把笔记打开,于是工作台跳到
    //    "笔记正文(编辑/预览)"那一格。所以这里吞掉它。
    //    ⚠️ 必须挂 document + 捕获阶段:行自己的 click 处理器注册得比这里早,
    //       挂在同一行上的话,目标节点上是按**注册顺序**跑的,拦不住。
    //    ⚠️ 标记的生命周期是这条修复的**要害**,踩过一次:
    //       先前在"手势刚起来"那一刻置位、400ms 后清掉 —— 而人手拖一次通常比 400ms 长,
    //       等他松手时标记早过期了,那一下 click 照样把笔记打开(工作台跳到"笔记正文/编辑预览"那格),
    //       而自检里合成拖拽只要 ~180ms,所以它反过来是**绿**的,查了半天。
    //       现在:**松手那一刻**才置位,并且只在"紧跟着的那一下 click"里有效(500ms 窗口)——
    //       浏览器的 click 就在 pointerup 后面几毫秒,人手也不可能在 0.5s 内再点同一行,
    //       所以既不会漏、也不会误吞用户下一次真的点击。
    let justDragged = false;
    let justDraggedUntil = 0;
    const DRAG_CLICK_GRACE_MS = 500;
    const clearJustDragged = () => { justDragged = false; justDraggedUntil = 0; };
    const markDragged = () => { justDragged = true; justDraggedUntil = Date.now() + DRAG_CLICK_GRACE_MS; };
    const isJustDragged = () => {
        if (!justDragged) return false;
        if (Date.now() > justDraggedUntil) { clearJustDragged(); return false; }   // 过期就当没这回事
        return true;
    };

    function bindDragRow(btn, info) {
        btn.addEventListener('pointerdown', (e) => {
            // 只认左键;点在行内按钮(＋)上时不参与拖动
            if (e.button !== 0) return;
            if (e.target?.closest?.('.note-dir-add')) return;
            dragState.down = true;
            dragState.active = false;
            dragState.from = info.path;
            dragState.fromIsDir = info.isDir;
            dragState.fromName = info.name;
            dragState.startX = e.clientX;
            dragState.startY = e.clientY;
            dragState.pointerId = e.pointerId;
            dragState.row = btn;
            dragState.lastX = e.clientX;
            dragState.lastY = e.clientY;
            // 新的一次手势开始:上一次"刚拖过"的标记必然已经没用了,清掉
            clearJustDragged();
            // ⚠️ **这里不播总线**:按下还没越阈值 —— 纯点击也会走到这儿,
            //    一播别的面板(画布)就以为有人在拖东西了。真正播出去的时机是"越过阈值"那一刻。
            dragState.busStarted = false;
        });
    }

    /** 当前落点所在的行(用坐标命中,不依赖事件目标 —— 尺寸读的是同一次布局)。 */
    function rowAt(x, y) {
        const el = document.elementFromPoint(x, y);
        const row = el?.closest?.('.note-list button[data-path], .note-list button[data-folder]');
        return row ?? null;
    }

    function clearDragMarks() {
        for (const el of listEl.querySelectorAll('.drag-into, .drag-before, .drag-after, .drag-forbid')) {
            el.classList.remove('drag-into', 'drag-before', 'drag-after', 'drag-forbid');
            el.removeAttribute('data-drag-forbid');
        }
        listEl.classList.remove('drop-root');
    }

    /** 树滚出视野时,越界的那部分命不中(elementFromPoint 对窗外坐标给 null)。
     *  所以拖动时必须**自动滚动** —— 否则"把这张图拖到下面那个文件夹"在一个
     *  长列表里根本做不到(实测踩到:目标在 y=1412 而视口只到 755)。 */
    const AUTO_SCROLL_EDGE_PX = 28;
    const AUTO_SCROLL_STEP_PX = 14;
    let autoScrollTimer = null;

    function scrollContainer() {
        return listEl?.closest?.('.notes-nav-scroll') ?? listEl?.parentElement ?? null;
    }

    function stopAutoScroll() {
        if (autoScrollTimer !== null) { clearInterval(autoScrollTimer); autoScrollTimer = null; }
    }

    function autoScroll(x, y) {
        const box = scrollContainer();
        if (box === null) return;
        const r = box.getBoundingClientRect();
        // 只在**沿着这一列**的时候滚:指针跑到别的面板上就别自作主张地滚列表
        if (x < r.left - 40 || x > r.right + 40) { stopAutoScroll(); return; }
        let dy = 0;
        if (y < r.top + AUTO_SCROLL_EDGE_PX) dy = -AUTO_SCROLL_STEP_PX;
        else if (y > r.bottom - AUTO_SCROLL_EDGE_PX) dy = AUTO_SCROLL_STEP_PX;
        if (dy === 0) { stopAutoScroll(); return; }
        if (autoScrollTimer !== null) return;              // 已经在滚了,别叠定时器
        autoScrollTimer = setInterval(() => {
            const before = box.scrollTop;
            box.scrollTop = before + dy;
            // 滚不动了(到顶/到底)就停,别空转
            if (box.scrollTop === before) stopAutoScroll();
        }, 16);
    }

    function updateDragTarget(x, y) {
        const row = rowAt(x, y);
        clearDragMarks();
        dragState.targetRow = null;
        dragState.target = null;
        dragState.hit = null;
        // ⚠️ 自动滚动要在**每次移动**时都问一次,不能只在"命不中行"时问 ——
        // 指针压在列表底边时命中的仍然是最后那一行,于是"越界才滚"永远不会发生
        // (实测:压住底边 0.9 秒 scrollTop 纹丝不动)。它自己判断距离边缘够不够近。
        dragState.lastX = x;
        dragState.lastY = y;
        autoScroll(x, y);
        if (row === null) return;
        dragState.hit = row.dataset.path ?? row.dataset.folder ?? null;

        const path = row.dataset.path ?? row.dataset.folder;
        const isDir = Boolean(row.dataset.folder);
        const r = row.getBoundingClientRect();
        const frac = r.height > 0 ? (y - r.top) / r.height : 0.5;
        const v = resolveDropTarget({
            dragPath: dragState.from, dragIsDir: dragState.fromIsDir,
            targetPath: path, targetIsDir: isDir, frac,
        });
        dragState.target = v;
        dragState.targetRow = row;
        if (v.kind === 'forbidden') {
            row.classList.add('drag-forbid');
            row.dataset.dragForbid = v.reason;
            return;
        }
        if (v.kind === 'into') row.classList.add('drag-into');
        else row.classList.add(frac < 0.5 ? 'drag-before' : 'drag-after');
    }

    function endDrag() {
        const wasActive = dragState.active;
        // 松手:把"这一拖"交给总线。
        // ⚠️ hit !== null = 松在**某一行**上 —— 那次是"移动笔记"(树内的事),别的面板不该接;
        //    松在树外才是"给别人送货"(画布就是靠这个收素材的)。
        // ⚠️ 只有**真拖起来过**的才播结束:纯点击(spawn 过 dragState 但没越阈值)不该
        //    凭空派发一条"拖动结束"(那会让画布按行的坐标判一次落点)。
        if (dragState.busStarted) {
            endBusDrag({
                clientX: dragState.lastX,
                clientY: dragState.lastY,
                insideTree: dragState.hit !== null,
            });
            dragState.busStarted = false;
        }
        stopAutoScroll();
        dragState.down = false;
        dragState.active = false;
        dragState.from = null;
        dragState.target = null;
        dragState.targetRow = null;
        dragState.row = null;
        dragState.pointerId = null;
        clearDragMarks();
        listEl.classList.remove('drag-active');
        // 真拖过一手 → 记下"紧跟着的那一下 click 不算点击"(见 markDragged 的注释)。
        // 纯点击(没越阈值)不记:那一下 click 本来就该打开笔记。
        if (wasActive) markDragged();
    }

    /** 落点解析成"从哪到哪"。返回 null 表示这件事不该发请求。 */
    function planMove(v) {
        const from = dragState.from;
        if (v === null || v.kind === 'forbidden') return null;
        const parent = parentDir(from);
        const name = parent === '' ? from : from.slice(parent.length + 1);
        // 同层只是排序,而这一版不做自定义排序 → 不发请求,提示一句
        if (parent === v.destFolder) return { noop: true };
        const to = v.destFolder === '' ? name : `${v.destFolder}/${name}`;
        return { from, to, name, dest: v.destFolder };
    }

    function notice(text, state = '') {
        // 只把**非空**的提示写进状态栏。空串会把上一次的提示擦掉 ——
        // 而"什么都没发生"本身不该产生一条空白更新。
        if (typeof text === 'string' && text !== '') setStatus(text, state);
    }

    async function doMove(from, to) {
        try {
            await bridge.invoke('notes:move', { from, to });
            await refreshIndex({ keepSelection: true });
            notice(`已移动到「${parentDir(to) || '笔记库根目录'}」`);
        } catch (err) {
            log.error?.('[notes] 移动失败', err);
            notice(`移动失败:${err.message}`, 'error');
            // 失败时列表按索引恢复原状 —— 界面上不能留下"已经移走了"的假象
            await refreshIndex({ keepSelection: true });
        }
    }

    document.addEventListener('pointermove', (e) => {
        if (!dragState.down) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        if (!dragState.active) {
            if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;   // 还没越过阈值
            dragState.active = true;
            // ② 手势真正开始了 —— **现在**才捕获
            try { dragState.row?.setPointerCapture?.(dragState.pointerId); } catch { /* 忽略 */ }
            listEl.classList.add('drag-active');
            dragState.row?.classList.add('drag-source');
            // ③ 也是"现在"才播给总线(别的面板据此亮出"可以拖到我这儿")
            beginBusDrag({
                relPath: dragState.from,
                name: dragState.fromName,
                isDir: dragState.fromIsDir === true,
            });
            dragState.busStarted = true;
            // ⚠️ 不在这里置"刚拖过"的标记:人手拖一次可能好几秒,标记会**在手势进行中就过期**。
            //    置位时机是松手那一刻(见 endDrag)。
        }
        e.preventDefault?.();
        updateDragTarget(e.clientX, e.clientY);
    });

    document.addEventListener('pointerup', (e) => {
        if (!dragState.down) return;
        const wasActive = dragState.active;
        const v = dragState.target;
        const row = dragState.row;
        try { row?.releasePointerCapture?.(dragState.pointerId); } catch { /* 忽略 */ }
        if (wasActive && v !== null && v !== undefined) {
            const plan = planMove(v);
            if (plan !== null && plan.noop === true) {
                notice('同一层内不做排序 —— 移到了原位,什么都没变');
            } else if (plan !== null) {
                void doMove(plan.from, plan.to);
            } else if (v.kind === 'forbidden') {
                notice(`没有移动:${v.reason}`, 'error');
            }
        }
        endDrag();
    });

    document.addEventListener('pointercancel', () => { if (dragState.down) endDrag(); });

    // 真拖过一手之后,浏览器会往那一行补一次 click(pointer capture 把 click 目标也一并带过去了)——
    // 那一下必须吃掉,否则"拖文件到画布"会顺手把笔记打开,而笔记正文视图在找不到自己的格子时
    // 会开在**当前面板**上(正是刚松手的那一格画布)→ 画布那格被编辑/预览顶掉。
    // ⚠️ 挂 document + 捕获阶段:行自己的 click 处理器注册得比这里早,挂在同一行上拦不住
    //    (目标节点上是按注册顺序跑的);listEl 这时还没赋值,所以用类名判断落点。
    document.addEventListener('click', (e) => {
        if (!isJustDragged()) return;
        const inList = typeof e.target?.closest === 'function' && e.target.closest('.note-list') !== null;
        if (!inList) return;      // 不是笔记列表上那一下 → 不关我事(窗口过期后自己失效)
        clearJustDragged();
        e.stopPropagation();
        e.preventDefault();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dragState.down) endDrag();
    });

    /** 文件大小的人话(与外壳 utils 里那份同口径,这里不引它以免多一条依赖)。 */    function humanSize(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        const units = ['KB', 'MB', 'GB'];
        let v = n / 1024;
        let i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
    }

    /** 按扩展名给一个粗分类,只用于挑图标与配色。 */
    function kindOf(name) {
        const ext = String(name).toLowerCase().split('.').pop();
        if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(ext)) return 'image';
        if (['mp4', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a'].includes(ext)) return 'media';
        if (['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml'].includes(ext)) return 'data';
        if (['docx', 'doc', 'pdf', 'rtf', 'srt', 'vtt', 'txt'].includes(ext)) return 'doc';
        return 'other';
    }

    /**
     * 一个**非笔记文件**的列表项。
     *
     * 与 noteItem 的关键区别:它不参与 Markdown 编辑。DOCX 进入内置只读阅读器，
     * 其余非笔记文件交给系统程序打开。它们同样可拖 —— "把 shots 里的图拖进另一个文件夹"正是
     * 这次拖放要支持的主要动作之一。
     */
    function otherItem(other, depth) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'note-other';
        btn.dataset.path = other.path;
        btn.dataset.kind = kindOf(other.name);
        btn.style.setProperty('--depth', String(depth));
        btn.title = `${other.path}\n${humanSize(other.size)}`;
        // 用户可以起任意文件名 → 一律 textContent,别拼 HTML
        const name = document.createElement('span');
        name.className = 'note-other-name';
        name.textContent = other.name;
        const size = document.createElement('span');
        size.className = 'note-other-size';
        size.textContent = humanSize(other.size);
        btn.append(name, size);
        btn.addEventListener('click', () => {
            if (/\.docx$/i.test(other.name)) {
                void open(other.path);
                return;
            }
            // 用系统程序打开。失败只提示一句 —— 没有关联程序是很常见的情况,
            // 不该让整个列表跟着报错(与"打开笔记失败"同一套反馈)。
            void bridge.invoke('notes:openPath', { path: other.path }).catch((err) => {
                log.error?.('[notes] 打开文件失败', err);
                setStatus(`打不开「${other.name}」:${err.message}`, 'error');
            });
        });
        // 非笔记文件**同样可拖** —— "把 shots 里的图拖进另一个文件夹"正是这次要支持的主场景。
        bindDragRow(btn, { path: other.path, isDir: false, name: other.name });
        li.appendChild(btn);
        return li;
    }

    /**
     * 一行**纯文本笔记**(.txt)。
     *
     * 与 otherItem 的关键区别:点它**进编辑器**(纯文本模式:可编辑、不解析 Markdown),
     * 而不是丢给系统程序 —— 这正是用户这一轮要的"程序可以显示 txt"。
     * 与 noteItem 的区别:它没有标题/标签/链接这些索引出来的东西,所以只画文件名与大小。
     *
     * @param {{path:string,name:string,size:number}} text
     * @param {number} depth
     * @param {string|null} [subText] 拍平显示时写在下面的完整路径
     */
    function textItem(text, depth, subText = null) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'note-text';
        btn.dataset.path = text.path;
        btn.dataset.kind = 'text';
        btn.style.setProperty('--depth', String(depth));
        btn.title = `${text.path}\n纯文本 · ${humanSize(text.size)}`;
        btn.setAttribute('aria-selected', String(text.path === currentPath));
        // 用户可以起任意文件名 → 一律 textContent,别拼 HTML
        const name = document.createElement('span');
        name.className = 'note-text-name';
        name.textContent = text.name;
        const size = document.createElement('span');
        size.className = 'note-text-size';
        size.textContent = humanSize(text.size);
        btn.append(name, size);
        if (subText !== null) {
            const sub = document.createElement('span');
            sub.className = 'note-sub';
            sub.textContent = subText;
            btn.appendChild(sub);
        }
        btn.addEventListener('click', () => open(text.path));
        // 与其它行一样可拖(拖进文件夹、拖到另一行上)
        bindDragRow(btn, { path: text.path, isDir: false, name: text.name });
        li.appendChild(btn);
        return li;
    }

    /**
     * 一篇笔记的列表项(树里与拍平列表里是同一套节点)。
     * @param {object} note
     * @param {number} depth 缩进层级(写进 --depth,CSS 用它换算 padding)
     * @param {string|null} [subText] 拍平显示时写在标题下面的完整路径
     */
    function noteItem(note, depth, subText = null) {
        // 正改名的就是这一篇 → 这一行换成输入框(见 renameRow)
        if (note.path === renamingPath) return renameRow(note, depth);
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.path = note.path;
        btn.style.setProperty('--depth', String(depth));
        btn.setAttribute('aria-selected', String(note.path === currentPath));
        // ⚠️ 「打不开」的 .md(含非法字节 / NUL)照常列出来 —— 它是**用户的文件**,
        //    在列表里凭空消失比"列着但打不开"更吓人(用户会以为笔记丢了)。
        //    但它必须**一眼看出**不一样:data-readable 给自检一个机器可读判据,
        //    行尾再挂一枚小标;具体原因由状态行在点开时说(与其它错误同一套提示)。
        const readable = note.readable !== false;
        if (!readable) {
            btn.dataset.readable = 'false';
            btn.classList.add('note-unreadable');
            // 悬停就能看到原因 —— 与 otherItem / textItem 用同一个 title 手法
            btn.title = `${note.path}\n${note.reason || '这篇笔记打不开'}`;
        }
        // 用 textContent,不用 innerHTML —— 标题来自用户的文件名/元数据
        btn.textContent = note.title;
        if (!readable) {
            const tag = document.createElement('span');
            tag.className = 'note-unreadable-tag';
            tag.textContent = '打不开';
            btn.appendChild(tag);
        }
        if (subText !== null) {
            const sub = document.createElement('span');
            sub.className = 'note-sub';
            sub.textContent = subText;
            btn.appendChild(sub);
        }
        btn.addEventListener('click', () => open(note.path));
        // 可拖:拖进文件夹、或拖到另一行上(等同于进它所在的文件夹)。
        // ⚠️ 它**不占 click** —— 拖动靠"按下后移动超过阈值"判定(见 bindDragRow)。
        bindDragRow(btn, { path: note.path, isDir: false, name: note.title });
        // 右键 → 浮层菜单。preventDefault 是必需的:不拦的话 Chromium 会把它自己的
        // 原生右键菜单盖在这个浮层上(那正是"两套菜单"的来源)。
        // ⚠️ stopPropagation 同样是必需的:contextmenu 会冒泡,而这个浮层挂在列表的
        //    父级上,父级上还有一条"空白处右键"的监听器。不拦住的话,行菜单刚开就被
        //    父级那条当成"点在空白处"换成空白菜单 —— 笔记行的重命名入口会凭空消失。
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault?.();
            e.stopPropagation?.();
            openNoteMenu(note.path, btn, e);
        });
        li.appendChild(btn);
        return li;
    }

    /** 拍平列表(搜索/标签筛选时走这条:树 + 筛选会让命中的东西藏在收起的文件夹里)。 */
    function renderFlatList(visible, visibleTexts = []) {
        listEl.innerHTML = '';
        if (visible.length === 0 && visibleTexts.length === 0) {
            const li = document.createElement('li');
            li.className = 'hint';
            li.style.padding = '8px 10px';
            li.textContent = '没有匹配的笔记。';
            listEl.appendChild(li);
            return;
        }
        for (const note of visible) {
            // 拍平时没有层级,把所在目录写在标题下面,免得两篇同名笔记分不清
            listEl.appendChild(noteItem(note, 0, note.path.includes('/') ? note.path : null));
        }
        // 纯文本排在笔记后面(与树里同一条"先笔记,再纯文本,最后只能看的")
        for (const text of visibleTexts) {
            listEl.appendChild(textItem(text, 0, text.path.includes('/') ? text.path : null));
        }
    }

    /** 递归渲染一层目录:先子目录、再笔记。 */
    function renderDir(node, depth) {
        for (const dir of node.dirs.values()) {
            const li = document.createElement('li');
            li.className = 'note-dir-row';

            const isCollapsed = collapsedDirs.has(dir.path);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'note-dir';
            btn.dataset.folder = dir.path;
            btn.style.setProperty('--depth', String(depth));
            btn.setAttribute('aria-expanded', String(!isCollapsed));
            btn.setAttribute('aria-label', `文件夹 ${dir.name}`);
            btn.title = dir.path;

            const caret = document.createElement('span');
            caret.className = 'note-caret';
            caret.setAttribute('aria-hidden', 'true');
            // 用文字箭头而不是 SVG:它就是个可旋转的指示符,而图标按钮在这里
            // 反而要额外处理"点了箭头算不算点文件夹"
            caret.textContent = '▾';
            const name = document.createElement('span');
            name.className = 'note-dir-name';
            name.textContent = dir.name;                 // 用户起的目录名 → 一律 textContent
            btn.appendChild(caret);
            btn.appendChild(name);
            btn.addEventListener('click', () => {
                if (collapsedDirs.has(dir.path)) collapsedDirs.delete(dir.path);
                else collapsedDirs.add(dir.path);
                renderList();
            });

            // 在这个文件夹里新建一篇笔记。没有它,新建的空文件夹只能靠手写
            // [[目录/名字]] 链接才用得上 —— 那样"新建文件夹"就是个半成品。
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'note-dir-add';
            add.dataset.newNoteIn = dir.path;
            add.setAttribute('aria-label', `在「${dir.name}」里新建笔记`);
            add.title = '在此文件夹新建笔记';
            add.textContent = '＋';
            add.addEventListener('click', (e) => {
                e.stopPropagation();                     // 别让它顺带把文件夹收起/展开
                return createNamed('未命名', dir.path);
            });

            // 文件夹**也可拖**:拖到另一个文件夹里就整包挪过去(子树跟着走)。
            // isDir:true 才会触发"不能放进自己的子孙"那条守卫。
            bindDragRow(btn, { path: dir.path, isDir: true, name: dir.name });

            li.appendChild(btn);
            li.appendChild(add);

            // 文件夹行也要有自己的右键菜单。理由见 openDirMenu:这一项的动作**本来就在**
            // 这一行上(旁边那枚 ＋),右键只是同一个动作的第二个入口 —— 不新增规则。
            // 监听挂在 li 上(而不是那枚文件夹按钮上):右键落在 ＋ 上时也算"在这一行上",
            // 不会漏成一个什么都不出的死区。
            li.addEventListener('contextmenu', (e) => {
                e.preventDefault?.();
                e.stopPropagation?.();      // 别让父级的"空白菜单"把它换掉(同 noteItem)
                openDirMenu(dir.path, dir.name, btn, e, countSubtree(dir));
            });

            listEl.appendChild(li);

            if (!isCollapsed) renderDir(dir, depth + 1);
        }
        for (const note of node.notes) listEl.appendChild(noteItem(note, depth));
        // 纯文本笔记:能编辑,所以排在"笔记之后、只能看的之前" ——
        // 用户要的隔离在这里看得见:它们是一组独立、颜色/图标不同的行,
        // 点一下进的是**纯文本模式**的编辑器(不渲染 Markdown)。
        for (const text of node.texts) listEl.appendChild(textItem(text, depth));
        // 非笔记文件排在最后:先"能编辑的",再"只能看的"。
        // DOCX 走内置只读阅读器；其他文件交给系统程序打开。
        for (const other of node.others) listEl.appendChild(otherItem(other, depth));
    }

    /**
     * 「新建文件夹」的内联输入行。
     *
     * 为什么不用对话框:Electron 里 `window.prompt` 不可用(会直接返回 null),
     * 而项目里没有模态弹窗这件东西;内联输入与顶栏改标题是同一套交互
     * (回车提交、Esc 取消、失焦提交),用户不用学新东西。
     */
    function appendNewFolderRow() {
        const li = document.createElement('li');
        li.className = 'note-new-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'note-new-input';
        input.placeholder = '文件夹名,回车创建';
        input.setAttribute('aria-label', '新文件夹名');
        li.appendChild(input);

        let done = false;
        const finish = async (commit) => {
            if (done) return;
            done = true;
            const raw = input.value;
            newFolderOpen = false;
            const name = cleanTitle(raw);
            if (!commit || name === '') { renderList(); return; }
            try {
                await bridge.invoke('notes:mkdir', { path: name });
                collapsedDirs.delete(name);              // 新建的默认展开
                setStatus(`已新建文件夹:${name}`);
                await refreshIndex({ keepSelection: true });
            } catch (err) {
                log.error?.('[notes] 新建文件夹失败', err);
                setStatus(`新建文件夹失败:${err.message}`, 'error');
                renderList();
            }
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); return finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); return finish(false); }
            return undefined;
        });
        input.addEventListener('blur', () => finish(true));

        listEl.appendChild(li);
        input.focus();
    }

    function renderListInner() {
        if (!listEl) return;
        const all = index?.notes ?? [];

        let visible = all;
        if (keyword !== '') {
            const k = keyword.toLowerCase();
            visible = visible.filter(n =>
                n.title.toLowerCase().includes(k) || n.path.toLowerCase().includes(k)
                || (n.tags ?? []).some(t => t.toLowerCase().includes(k)));
        }
        if (tagFilter !== null) {
            visible = visible.filter(n => (n.tags ?? []).includes(tagFilter));
        }

        // 纯文本(.txt):**关键词**筛选对它一样有效(按文件名匹配),
        // 但**标签**筛选把它藏起来 —— txt 没有标签这个东西(不解析 `#标签`),
        // 让它在"筛选中:#某标签"的结果里冒充命中,是更坏的结果(看着有、点开却没有)。
        const allTexts = index?.texts ?? [];
        let visibleTexts = allTexts;
        if (tagFilter !== null) {
            visibleTexts = [];
        } else if (keyword !== '') {
            const k = keyword.toLowerCase();
            visibleTexts = visibleTexts.filter(t => t.name.toLowerCase().includes(k) || t.path.toLowerCase().includes(k));
        }

        listEl.innerHTML = '';

        // 列表顶部那条"筛选中:#… ×"跟着一起更新 —— 它解释的是**这个列表**为什么变短了
        renderTagFilterBar();

        // 有筛选时拍平:树会让"匹配的东西藏在收起的文件夹里",反而更难找
        if (keyword !== '' || tagFilter !== null) {
            renderFlatList(visible, visibleTexts);
            return;
        }

        if (newFolderOpen) appendNewFolderRow();

        const dirs = index?.folders ?? [];
        const others = index?.others ?? [];
        if (all.length === 0 && dirs.length === 0 && allTexts.length === 0 && others.length === 0) {
            const li = document.createElement('li');
            li.className = 'hint';
            li.style.padding = '8px 10px';
            li.textContent = '还没有笔记,点「新建」。';
            listEl.appendChild(li);
            return;
        }
        renderDir(buildTree(all, dirs, allTexts, others), 0);
    }

    /**
     * 重画整个列表。
     *
     * 单独包一层只为一件事:改名输入框的聚焦**必须**排在它真的进了 DOM 之后 ——
     * 游离/隐藏元素上的 `focus()` 会被浏览器静默丢弃(设了、读回来也对、就是没生效,
     * 见 open() 里那条与 HANDOFF §A9)。所以不在 renameRow 里聚焦,在这里统一收尾。
     */
    function renderList() {
        // 先把"即将被这次重画换掉的那个输入框"记下来(见 repaintDoomedInput 的说明):
        // 它决定 renameRow 的 blur 是"用户点到别处"还是"我们自己把它拆了"。
        repaintDoomedInput = renamingPath === null ? null : findRenameInput();
        renderListInner();
        if (renamingPath === null) return;
        const input = findRenameInput();
        input?.focus?.();
        // 全选只做一次(刚进入改名态那次):重画时再全选一次,会把用户正在输的字
        // 整段选中,下一个按键就把它换掉了。
        if (renameSelectPending) {
            renameSelectPending = false;
            input?.select?.();
        }
    }

    // ---------- 右键菜单 + 行内重命名 ----------

    /** Vault 内相对路径 → 不含 `.md` 的主名(改名的可编辑部分就是它)。 */
    function baseNameOf(relPath) {
        return String(relPath).split('/').pop().replace(/\.md$/i, '');
    }

    /** Vault 内相对路径 → 所在目录(空串 = 根目录),统一用 `/` 拼回去。 */
    function dirOf(relPath) {
        const cut = String(relPath).lastIndexOf('/');
        return cut === -1 ? '' : String(relPath).slice(0, cut);
    }

    /**
     * 找到当前那个改名输入框(真实 DOM 走 querySelector,替身只认编辑器那个选择器,故再走一遍列表)。
     *
     * ⚠️ 真实 DOM 里 `children` 是 **HTMLCollection**:`for…of` 能用(WebIDL 的索引属性
     *    让它可以迭代),但它**没有** Array 的 `find` —— 直接 `.find` 会在真窗口里抛
     *    `TypeError: …find is not a function`(单测替身的 children 是数组,测不出来;
     *    真窗口探针抓到的就是这个)。所以两边都先 `Array.from`。
     */
    function findRenameInput() {
        const hit = listEl?.querySelector?.('input.note-rename-input');
        if (hit) return hit;
        for (const li of Array.from(listEl?.children ?? [])) {
            const input = Array.from(li.children ?? []).find(c => c.className === 'note-rename-input');
            if (input) return input;
        }
        return null;
    }

    function closeNoteMenu() {
        // 菜单上可能挂着"两步确认"的还原计时器(见 openMenu 的 confirmLabel):
        // 关掉时必须把它一起收走,否则元素都移除了它还会醒过来(一个指向死节点的回调)。
        noteMenu?.dispose?.();
        noteMenu?.el?.remove?.();
        noteMenu = null;
    }

    /** 三种浮层的 aria-label(菜单没有可见标题,这是屏幕阅读器唯一能读到的名字)。 */
    const MENU_LABELS = {
        note: '笔记菜单',
        dir: '文件夹菜单',
        blank: '列表空白处菜单',
    };

    /**
     * 打开右键浮层 —— 笔记行 / 文件夹行 / 列表空白处**共用同一份实现**。
     *
     * 为什么把"菜单项列表"变成参数,而不是复制第二份浮层代码:定位、贴边回收、
     * 打开即聚焦、↑↓ 绕圈、Enter 触发、Esc 关掉并把焦点还给触发处、
     * 点外面 / 滚动 / 窗口失焦都关掉 —— 这一整套是**同一份交互契约**。
     * 复制一份就等于多一份会各自漂移的实现,而"两个右键菜单行为不一样"是用户
     * 一眼就能看见的那类不一致(工作台的浮层与它也是同一套规则)。
     * 三处菜单之间唯一的差别只有"有哪些项",所以只有项是参数。
     *
     * @param {object} spec
     * @param {string} spec.kind 'note' | 'dir' | 'blank'(写进 data,并决定 aria-label)
     * @param {Array<object>} spec.items 每一项 { label, menuRole, ariaLabel?, onPick, confirmLabel? }
     *        带 confirmLabel 的项走**两步确认**(第一次点只改文案,第二次点才 onPick);
     *        不带的那一项第一次点就 onPick,与既有行为完全一致。
     * @param {object|null} [spec.anchor] 触发菜单的那一行(定位兜底 + Esc 后焦点还给谁);空白处右键为 null
     * @param {object|null} [spec.event] contextmenu 事件(拿鼠标坐标;键盘唤起时坐标无效,退回锚点位置)
     * @param {string|null} [spec.notePath] 笔记菜单记下目标路径(其余菜单为 null)
     * @param {number} [spec.confirmMs] 两步确认的告警态自动还原时长
     * @returns {object} 浮层盒子
     */
    function openMenu({ kind, items, anchor = null, event = null, notePath = null, confirmMs = 4000 }) {
        closeNoteMenu();
        // 开之前先把焦点记下来:空白处右键**没有**一个"触发它的那一行"可以还,
        // 而 Esc 之后焦点停在已经被移除的菜单项上 = 掉回 <body>(键盘用户从此
        // 从文档开头重新 Tab)。记下原来那个元素,才谈得上"焦点还给列表"。
        const previousFocus = globalThis.document?.activeElement ?? null;
        const box = document.createElement('div');
        box.className = 'note-menu';
        box.setAttribute('role', 'menu');
        box.setAttribute('aria-label', MENU_LABELS[kind] ?? '菜单');
        // 只放叶子字段(kind 与相对路径都是字符串):浮层上不留任何指向视图内部对象的引用。
        box.dataset.menuKind = kind;
        if (notePath !== null) box.dataset.noteMenu = notePath;

        // 关菜单时要一起收走的东西(目前只有两步确认的还原计时器)。见 closeNoteMenu。
        const disposers = [];

        const buttons = items.map(({ label, menuRole, ariaLabel, onPick, confirmLabel = null }) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'note-menu-item';
            b.setAttribute('role', 'menuitem');
            if (menuRole) b.dataset.menuRole = menuRole;
            // 文案有歧义时才要 aria-label(例如"在此文件夹新建笔记"没说是哪个文件夹)
            if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
            b.textContent = label;              // 菜单文案也是文本,不用 innerHTML

            /**
             * 两步确认(目前只有「删除笔记」用)。
             *
             * 为什么必须有这一步:右键菜单是"一点就中"的手势,而删除是永久生效的动作
             * (即便进的是回收站、还能捡回来,也不该让一次误点就把它送出去)。所以第一次
             * 点击**不执行、也不关菜单**,只把这一项自己换成「再点一次确认删除」并打上
             * 告警色;第二次点同一项才真的做 —— 第二次手势是明确的,不是"接着点"。
             *
             * N 秒无操作自动还原:菜单一直悬在"确认删除"态上,过一会儿用户已经不记得
             * 自己点过什么了,那时再来一点就删 —— 那等于没有确认。
             */
            let armed = false;
            let armTimer = null;
            const disarm = () => {
                if (armTimer !== null) { clearTimeout(armTimer); armTimer = null; }
                if (!armed) return;
                armed = false;
                b.textContent = label;
                // 告警色由 CSS 的 [data-menu-danger="true"] 给:改 className 会让这一项
                // 从 .note-menu-item 这个既有选择器里掉出去(样式与测试都按它找项)。
                delete b.dataset.menuDanger;
            };
            disposers.push(disarm);

            // 返回 onPick 的 promise 只是让测试替身能 await 到动作做完(浏览器忽略监听器
            // 的返回值)—— 与这个文件里别的内联提交同一条约定。
            b.addEventListener('click', () => {
                if (confirmLabel === null) { closeNoteMenu(); return onPick(); }
                if (!armed) {
                    armed = true;
                    b.textContent = confirmLabel;
                    b.dataset.menuDanger = 'true';
                    armTimer = setTimeout(disarm, confirmMs);
                    return undefined;          // 菜单**不关**:第二次点击要落在同一项上
                }
                disarm();
                closeNoteMenu();
                return onPick();
            });
            box.appendChild(b);
            return b;
        });

        // 挂在滚动容器的**父级**上,而不是列表里:列表是"索引一变就整段重画",
        // 浮层要是列表的一项,会被下一次重画顺手吃掉。
        const host = listEl?.parentElement ?? listEl;
        host?.appendChild?.(box);

        // 定位:视口坐标 + fixed。列表容器是 overflow:auto,在里面做绝对定位
        // 会被裁在容器边缘(贴近底部的那几行右键就只剩半条菜单)。
        const rect = anchor?.getBoundingClientRect?.();
        const x = Number.isFinite(event?.clientX) && event.clientX > 0
            ? event.clientX : (rect ? rect.left + 12 : 0);
        const y = Number.isFinite(event?.clientY) && event.clientY > 0
            ? event.clientY : (rect ? Math.round(rect.bottom) : 0);
        if (box.style) {
            box.style.left = `${Math.round(x)}px`;
            box.style.top = `${Math.round(y)}px`;
            // 贴边回收:右/下放不下就翻回去,菜单不能跑到窗口外面(那就点不到了)
            const boxRect = box.getBoundingClientRect?.();
            const vw = Number(globalThis.innerWidth) || 0;
            const vh = Number(globalThis.innerHeight) || 0;
            if (vw > 0 && (boxRect?.width ?? 0) > 0 && x + boxRect.width > vw) {
                box.style.left = `${Math.max(0, Math.round(vw - boxRect.width - 4))}px`;
            }
            if (vh > 0 && (boxRect?.height ?? 0) > 0 && y + boxRect.height > vh) {
                box.style.top = `${Math.max(0, Math.round(y - boxRect.height))}px`;
            }
        }

        // 菜单项是 <button>:focus / Tab / Enter 天然可用。开就把焦点放进去,
        // 键盘用户(含 Shift+F10 / 菜单键唤起)不用再想办法"走"进菜单。
        buttons[0]?.focus?.();
        box.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault?.();
                const at = buttons.indexOf(e.target);
                const step = e.key === 'ArrowDown' ? 1 : -1;
                const next = buttons.length === 0 ? -1
                    : ((at + step) % buttons.length + buttons.length) % buttons.length;
                buttons[next]?.focus?.();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault?.();
                closeNoteMenu();
                // 焦点还给那一行,否则键盘用户会掉回文档开头。
                // 空白处的菜单没有"那一行",就还给打开菜单前聚焦着的元素(通常是列表里
                // 上一篇笔记 / 搜索框);两个都没有时什么也不做,而不是硬塞一个焦点。
                (anchor ?? previousFocus)?.focus?.();
            }
        });
        // path 只在笔记菜单上有值;kind 让"这一份菜单是谁的"在 DOM 上可读(自检也靠它)
        noteMenu = { el: box, kind, path: notePath, dispose: () => { for (const d of disposers) d(); } };
        return box;
    }

    /**
     * 某一篇笔记那一行的右键浮层。
     *
     * 两项都只用**既有的**实现,不在这里另起一套:
     *   · 「重命名」→ startRename(行内改名,本就在这一行上);
     *   · 「删除笔记」→ removeNote,只是它要过**两步确认**(见 openMenu 的 confirmLabel)。
     *
     * @param {string} notePath 目标笔记的相对路径
     * @param {object} anchor 那一行的按钮(定位与"焦点还给它"都用它)
     * @param {object} event contextmenu 事件
     */
    function openNoteMenu(notePath, anchor, event) {
        // 两项,都是这一个菜单自己的动作:重命名(既有)与删除(产品原话
        // 「右击添加删除笔记选项」)。删除在这里只走**两步确认**的第一次点击,
        // 真正发 IPC 的那一下在 removeNote —— 那是唯一一处会动磁盘的删除入口。
        return openMenu({
            kind: 'note',
            notePath,
            anchor,
            event,
            confirmMs: deleteConfirmMs,
            items: [{
                label: '重命名',
                menuRole: 'rename',
                onPick: () => startRename(notePath),
            }, {
                label: '删除笔记',
                menuRole: 'delete-note',
                // 第一次点只把这一项变成「再点一次确认删除」(并换成告警色),第二次点才真删。
                confirmLabel: '再点一次确认删除',
                onPick: () => removeNote(notePath),
            }],
        });
    }

    /**
     * 把编辑器从"某一篇"上摘下来(切走 / 清空)。
     *
     * 为什么删之前**必须**先做:文件一进回收站就没了,而编辑器还指着那个路径。
     * 下一次自动保存 / 手动保存会把那个文件**重新建出来**(writeNote 是"临时文件 →
     * rename"的落盘),用户会看到一篇"删不掉的笔记"——而且它可能只有半篇内容。
     *
     * 只清"当前这一篇"在界面上的显示,不动列表结构:列表由删成功后的
     * refreshIndex 重画(那里才是列表的唯一真相)。
     */
    function detachEditor() {
        openGeneration += 1;
        docxReaderDispose?.destroy?.();
        docxReaderDispose = null;
        if (editorEl?.dataset) delete editorEl.dataset.documentKind;
        currentPath = null;
        dirty = false;
        // 待触发的自动保存也要收走,否则它醒来时会拿着一份内存里的正文,
        // 而 currentPath 已经是 null(它自己会 return,但留着就是一颗哑雷)。
        clearTimeout(saveTimer);
        if (editorEl) editorEl.hidden = true;
        if (emptyEl) emptyEl.hidden = false;
        if (titleEl) titleEl.value = '';
        if (pathEl) pathEl.textContent = '';
        if (saveBtn) saveBtn.disabled = true;
        // 链接栏画的是"刚打开那篇"的反链/出链 —— 不清就会留着一份指向已删笔记的面板。
        renderLinks({ backlinks: [], outgoing: [], unresolved: [] });
    }

    /**
     * 删一篇笔记 —— 菜单项「删除笔记」的**第二次**点击才走到这里。
     *
     * 三件事的顺序是有理由的,别调换:
     *   ① 删的正是"当前打开的那一篇"**且有未保存改动** → 拒绝。此刻删等于把用户
     *      手上正在编辑的东西从脚底下抽走:磁盘上那份进回收站,而正文最新的版本只
     *      活在编辑器里。保存还是撤销该由他自己决定,不替他决定。
     *   ② 干净的那一篇 → **先切走再删**。反过来的话,中间那一下编辑器指着一个
     *      已经不存在的文件(见 detachEditor)。
     *   ③ 失败时界面动都不能动,并且把原因说出来(笔记还在磁盘上,不能假装删掉了)。
     */
    async function removeNote(notePath) {
        const name = baseNameOf(notePath);

        if (currentPath === notePath && dirty) {
            setStatus(`「${name}」有未保存的改动 —— 先保存或撤销改动再删`, 'error');
            return;
        }

        const wasOpen = currentPath === notePath;
        if (wasOpen) detachEditor();

        let result = null;
        try {
            // 只递**库内相对路径**这一个叶子字段;`.md.bak` 由主进程按同一个路径算出来,
            // 渲染层说不出第二个路径(见 preload 白名单那条注释)。
            result = await bridge.invoke('notes:remove', { path: notePath });
        } catch (err) {
            log.error?.('[notes] 删除失败', err);
            // 文件还在,就把刚才摘掉的编辑现场还回去 —— 否则用户会觉得"没删掉,
            // 但我的编辑也不见了"。放在 setStatus **之前**:失败原因必须是最后那句话。
            if (wasOpen) await open(notePath);
            setStatus(`删除失败:${err.message}`, 'error');
            return;
        }

        // 列表与索引一起刷新(与保存/改名后的收尾同一条路:索引是列表的唯一真相)。
        await refreshIndex({ keepSelection: false });
        // 删的是**别的**那篇时,当前这篇的反链/出链可能指着它,一并刷新;
        // 删的就是当前这篇时 currentPath 已经是 null,refreshLinks 自己会跳过
        // (面板已由 detachEditor 清空)。
        await refreshLinks();

        // 备份没能一起挪走时**不静默**:库里会留下一份列表上看不见的全文,
        // 用户有权知道它还在那儿(用既有那条状态行说,不另开一套提示)。
        const extra = result?.warning ? `(${result.warning})` : '';
        // ⚠️ 两种落点说法不同:系统回收站(能在资源管理器里还原)与**库内 .trash/**
        //    (这个卷没有回收站时才走,比如 E 盘那种 FAT32 可移动盘)。第二种必须把路径
        //    说出来 —— 否则用户不知道东西去哪了,只会觉得"删了但没删掉"。
        if (result?.mode === 'vault') {
            setStatus(`已把《${name}》移到库内 ${result.to}(这个卷没有系统回收站,内容仍在库里,可以自己恢复)${extra}`);
        } else {
            setStatus(`已把《${name}》移入回收站${extra}`);
        }
    }

    /**
     * 文件夹那一行的右键浮层。
     *
     * 两项都是"本来就在这一行上"的动作,没有新规则:
     *   · 「在此文件夹新建笔记」= 旁边那枚 ＋(走同一个 `createNamed('未命名', dir.path)`);
     *   · 「删除文件夹」= 笔记行那条「删除笔记」的同一套规矩(两步确认 + 系统回收站)。
     *
     * 不给它加删除的话,文件夹行会成一个**只进不出**的地方:建得出、删不掉。
     * 删除的代价比一篇笔记大得多(整个子树),所以确认文案里把"会带走多少"写出来 ——
     * 用户点第二下之前就该知道这一下带走什么。
     */
    function openDirMenu(dirPath, dirName, anchor, event, counts) {
        const cost = describeDirCost(counts);
        return openMenu({
            kind: 'dir',
            anchor,
            event,
            items: [
                {
                    label: '在此文件夹新建笔记',
                    menuRole: 'new-note-in-dir',
                    // 文案里有"此",说不出是哪个文件夹 —— aria-label 把它补全
                    ariaLabel: `在「${dirName}」里新建笔记`,
                    onPick: () => createNamed('未命名', dirPath),
                },
                {
                    label: '删除文件夹',
                    menuRole: 'remove-dir',
                    ariaLabel: `把文件夹「${dirName}」移入回收站${cost === '' ? '' : `(${cost})`}`,
                    // 与「删除笔记」同一个两步确认:第一次点只改文案,第二次点才真删
                    confirmLabel: cost === '' ? '再点一次确认删除' : `再点一次确认删除(含 ${cost})`,
                    onPick: () => removeDir(dirPath, dirName),
                },
            ],
        });
    }

    /**
     * 一个文件夹子树里有多少东西 —— 给确认文案用。
     * @param {{notes?:number, texts?:number, others?:number, dirs?:number}|null} counts
     * @returns {string} 例如「3 篇笔记、12 个文件、2 个子文件夹」;空文件夹给空串
     */
    function describeDirCost(counts) {
        if (counts === null || counts === undefined) return '';
        const parts = [];
        const notes = Number(counts.notes ?? 0);
        const texts = Number(counts.texts ?? 0);
        const others = Number(counts.others ?? 0);
        const dirs = Number(counts.dirs ?? 0);
        if (notes > 0) parts.push(`${notes} 篇笔记`);
        if (texts > 0) parts.push(`${texts} 个文本`);
        if (others > 0) parts.push(`${others} 个文件`);
        if (dirs > 0) parts.push(`${dirs} 个子文件夹`);
        return parts.join('、');
    }

    /**
     * 数一个文件夹子树(含子文件夹)。右键菜单一打开就要用,所以走**已经载入的树**,
     * 不再去问一次主进程 —— 菜单弹出时多一次 IPC 往返,手感会明显发涩。
     */
    function countSubtree(node) {
        const out = { notes: node.notes.length, texts: node.texts.length, others: node.others.length, dirs: 0 };
        for (const child of node.dirs.values()) {
            out.dirs += 1;
            const sub = countSubtree(child);
            out.notes += sub.notes;
            out.texts += sub.texts;
            out.others += sub.others;
            out.dirs += sub.dirs;
        }
        return out;
    }

    /**
     * 删一个文件夹 —— 菜单项「删除文件夹」的**第二次**点击才走到这里。
     *
     * 顺序与 removeNote 同一条理由(别调换):
     *   ① 正在编辑的那篇**就在这个文件夹里**且有未保存改动 → 拒绝:此刻删等于把用户手上
     *      最新的正文抽走(磁盘那份进回收站,而最新的只活在编辑器里);
     *   ② 干净 → **先切走再删**(否则中间那一下编辑器指着一个已经不存在的文件);
     *   ③ 失败 → 把刚才摘掉的编辑现场还回去,并把原因说出来(文件夹还在磁盘上,不能假装删了)。
     */
    async function removeDir(dirPath, dirName) {
        const inside = currentPath !== null
            && (currentPath === dirPath || currentPath.startsWith(`${dirPath}/`));
        if (inside && dirty) {
            setStatus(`「${dirName}」里那篇正在编辑的笔记还有未保存的改动 —— 先保存或撤销改动再删`, 'error');
            return;
        }
        const reopenPath = inside ? currentPath : null;
        if (inside) detachEditor();

        let result = null;
        try {
            result = await bridge.invoke('notes:removeDir', { path: dirPath });
        } catch (err) {
            log.error?.('[notes] 删除文件夹失败', err);
            if (reopenPath !== null) await open(reopenPath);
            setStatus(`删除失败:${err.message}`, 'error');
            return;
        }

        await refreshIndex({ keepSelection: false });
        await refreshLinks();

        // 带走了多少要说出来 —— 删文件夹是这一列表里代价最大的一下
        const files = Number(result?.files ?? 0);
        const notes = Number(result?.notes ?? 0);
        const detail = files === 0 ? '空的' : `含 ${files} 个文件${notes > 0 ? `、其中 ${notes} 篇笔记` : ''}`;
        // 与单篇删除同一口径:落点不同,话就不同(见 removeNote 里的说明)
        if (result?.mode === 'vault') {
            setStatus(`已把文件夹《${dirName}》移到库内 ${result.to}(${detail};这个卷没有系统回收站,内容仍在库里)`);
        } else {
            setStatus(`已把文件夹《${dirName}》移入回收站(${detail})`);
        }
    }

    /**
     * 列表空白处的右键浮层(产品原话:「右击空白处可以在菜单栏中新建笔记」)。
     *
     * 两项都是既有动作的**同一个入口**,一个新动作都没有:
     *   · 新建笔记 = 搜索框旁边那枚 ＋(`newBtn` → `createNamed('未命名')`):
     *     落在库根、名字唯一化、建完打开编辑器,全都走同一条路;
     *   · 新建文件夹 = 顶栏那枚文件夹按钮(`newFolderOpen = true` → 列表顶部的内联输入行)。
     */
    function openBlankMenu(event) {
        return openMenu({
            kind: 'blank',
            event,
            items: [
                {
                    label: '新建笔记',
                    menuRole: 'new-note',
                    onPick: () => createNamed('未命名'),
                },
                {
                    label: '新建文件夹',
                    menuRole: 'new-folder',
                    onPick: () => { newFolderOpen = true; renderList(); },
                },
            ],
        });
    }

    /** 进入行内改名态:只改状态再重画,行本身由 renameRow 渲染。 */
    function startRename(notePath) {
        renamingPath = notePath;
        renameDraft = null;              // 新的一次改名:草稿从预填的主名开始
        renameSelectPending = true;      // 这一次要把预填内容全选(直接打字就整个换掉)
        renderList();
    }

    /**
     * 改名态的那一行:标题按钮换成一个预填「主名」的输入框。
     *
     * 为什么预填的是**文件名**而不是列表上显示的标题:`notes:rename` 搬的是文件,
     * 而界面上的标题还可能来自 frontmatter.title / 正文 H1。拿标题当预填值的话,
     * "什么都没改直接回车"会把文件改成另一个名字(标题与文件名不一致时),
     * 而用户以为自己什么都没做。
     */
    function renameRow(note, depth) {
        const li = document.createElement('li');
        li.className = 'note-rename-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'note-rename-input';
        input.dataset.path = note.path;
        input.style.setProperty('--depth', String(depth));
        // 重画时优先用草稿:用户已经打的字不许被预填值盖回去(见 renameDraft 的说明)
        input.value = renameDraft ?? baseNameOf(note.path);
        // 无可见文本的输入框:aria-label 是必需的,不是可选项
        input.setAttribute('aria-label', `重命名笔记(原名 ${baseNameOf(note.path)})`);
        input.title = note.path;
        input.addEventListener('input', () => { renameDraft = input.value; });
        li.appendChild(input);

        let done = false;
        /**
         * 收尾:`commit` 为真时把输入的名字提交给主进程,否则恢复原样。
         *
         * ⚠️ 失焦**按提交**处理 —— 与这个模块里另外两处内联编辑完全一致:
         *    「新建文件夹」的 `finish(true)`、顶栏标题框的 blur → commitTitle()。
         *    同一个面板里同样的手势必须给同样的结果:否则用户点一下别处,
         *    有时保存、有时反悔,没法预期。反悔有它自己的明确手势 —— Esc。
         */
        const finish = async (commit) => {
            if (done) return;
            done = true;                       // 先上锁:Esc 之后的 blur 不许再提交一次
            const from = note.path;
            const raw = input.value;
            renamingPath = null;               // 无论成败,这一行都要回到"列表里的一行"
            renameDraft = null;
            renameSelectPending = false;

            // 自带 `.md` 就把扩展名剥掉再拼回:可编辑部分本来就定义成"不含扩展名的主名",
            // 用户手上拿到的却是完整文件名,顺手把 `.md` 打进来很正常 ——
            // 不剥的话会拼成 `笔记.md.md`,那是另一个文件,不是他要的。
            const name = String(raw ?? '').trim().replace(/\.md$/i, '').trim();
            const dir = dirOf(from);
            const to = dir === '' ? `${name}.md` : `${dir}/${name}.md`;

            // 空名 / 只有空白 / 与原名完全相同 → 不调 IPC,直接把行恢复原样。
            // 完全相同必须是**大小写敏感**的比较:只差大小写是一次真的改名
            // (主进程走"先临时名再目标名"两步),不能被这里当成"没改"。
            if (!commit || name === '' || to === from) { renderList(); return; }

            // 含路径分隔符 = 用户其实想**移动**文件。这里明确拒绝,不静默照做:
            // 静默把它变成移动,表现是"这篇笔记原地消失了"(去了别的目录),
            // 而他只是想要一个新名字。
            if (/[\\/]/.test(name)) {
                renderList();
                setStatus('重命名失败:名字里不能有路径分隔符(/ 或 \\)—— 这是重命名,不是移动', 'error');
                return;
            }
            // 与 cleanTitle 同一套非法字符,但这里是**明确拒绝**而不是悄悄删掉:
            // 界面把用户打的字吃掉几个再照做,等于替他改了名还不说。
            if (/[*?"<>|:]/.test(name)) {
                renderList();
                setStatus('重命名失败:名字里不能有 * ? " < > | : 这些字符', 'error');
                return;
            }

            try {
                await bridge.invoke('notes:rename', { from, to });
                // 改的要是**正打开着的那篇**,currentPath 必须跟着走 ——
                // 否则下一次自动保存会往一个已经不存在的老路径写,内容就丢了。
                if (currentPath === from) {
                    currentPath = to;
                    if (pathEl) pathEl.textContent = to;
                }
                setStatus(`已重命名为《${name}》`);
                await refreshIndex({ keepSelection: true });
                if (currentPath === to) {
                    await refreshLinks();
                    // 标签条上那一格记的是路径,不通知外壳就会停在旧名字上
                    // (与 commitTitle 同一条理由)。
                    onOpenNote?.(to);
                }
            } catch (err) {
                log.error?.('[notes] 重命名失败', err);
                // 失败的改名绝不能留在界面上:状态栏说原因,行按索引恢复成原名。
                setStatus(`重命名失败:${err.message}`, 'error');
                renderList();
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); return finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); return finish(false); }
            return undefined;
        });
        /**
         * 失焦 = 提交。⚠️ 但**我们自己把这一行拆掉**时不算提交:
         * 列表重画(renderListInner 里的 `listEl.innerHTML = ''`)会把正聚焦的输入框
         * 从文档里摘走,那一下浏览器照样派发 blur —— 不区分的话,一次编辑器自动保存
         * (它收尾时会 refreshIndex → 重画列表)就会把用户刚打了一半的名字当成新名字
         * 发出去(真窗口实测:只打了「隔」,磁盘上就落成了 `隔.md`)。
         *
         * 判据用"元素身份"(renderList 事先记下的那一个),而不是 `isConnected`:
         * 实测 blur 跑起来时那个输入框**还是 isConnected 的**(派发时机不保证在断开之后),
         * 只靠 isConnected 拦不住。`isConnected === false` 作为兜底留着 —— 覆盖
         * "整个视图被拆掉"那条路。被拦下的这一下什么都不做:改名态与草稿由 renameDraft
         * 留着,重画出来的新输入框接着让用户打完。
         */
        input.addEventListener('blur', () => {
            if (repaintDoomedInput === input || input.isConnected === false) return undefined;
            return finish(true);
        });
        return li;
    }

    // 浮层关闭规则与工作台那套一致:点外面关掉、Esc 关掉(见 openNoteMenu 的 keydown)。
    // ⚠️ 判据里必须**包含"点在浮层内部"**:捕获阶段先跑,漏掉它的话菜单项自己的 click
    //    还没发,节点就已经被移除了(工作台那里踩过同一个坑,见 panel-workspace.js:1544)。
    document.addEventListener('pointerdown', (e) => {
        if (noteMenu === null) return;
        const t = e?.target;
        if (t === noteMenu.el || noteMenu.el?.contains?.(t) === true) return;
        closeNoteMenu();
    }, true);
    // 列表一滚动,浮层与那一行就脱开了 —— 直接关掉,而不是让它悬在原地指着一行别的笔记。
    // 用捕获:元素的 scroll 事件不冒泡,但捕获阶段能从 window 上收到。
    window.addEventListener('scroll', () => closeNoteMenu(), true);
    // 窗口失焦(切到别的应用 / 主窗口被别的东西挡住)也关掉:浮层是 fixed 定位的,
    // 不关就会孤零零地悬在一个已经不活跃的窗口上。与工作台浮层的规则一致。
    window.addEventListener('blur', () => closeNoteMenu());

    /**
     * 标签面板(方案 4:工具条 + 前 N 个 + 「+N」)。
     *
     * 为什么不是简单地把胶囊列出来:标签越多,那一块越高,笔记列表被一路挤上去
     * (实测:9 个标签 138px,30 个标签 346px)。所以这里做四件事:
     *   ① 头部一行:标题 + 过滤 + 排序 + 收起 —— 收起后整块只占一行;
     *   ② 默认只显示**按计数排序**的前 N 个,其余折进「+N」;
     *   ③ 排序可切(按数量 / 按名称);
     *   ④ 选中标签时,列表**顶部**出现「筛选中:#… ×」—— 让"列表为什么变短"看得见。
     * 于是标签再多,这一块的高度也不变(实测 148px 恒定)。
     */
    const TAG_PREVIEW = 6;

    /** 头部的小工具按钮。 */
    function tagToolButton(text, label, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tag-tool';
        b.textContent = text;                 // 图标是字符,不用 innerHTML
        b.setAttribute('aria-label', label);
        b.title = label;
        b.addEventListener('click', onClick);
        return b;
    }

    /** 当前该显示哪些标签(先按关键词过滤,再排序)。 */
    function visibleTags() {
        const all = (index?.tags ?? []).filter(t => t.tag !== undefined);
        const k = tagKeyword.trim().toLowerCase();
        const hit = k === '' ? all : all.filter(t => String(t.tag).toLowerCase().includes(k));
        const sorted = [...hit];
        if (tagSort === 'name') {
            sorted.sort((a, b) => String(a.tag).localeCompare(String(b.tag), 'zh'));
        } else {
            // 计数降序;同计数按名字,免得每次刷新顺序乱跳
            sorted.sort((a, b) => (b.count - a.count) || String(a.tag).localeCompare(String(b.tag), 'zh'));
        }
        return sorted;
    }

    function toggleTagFilter(tag) {
        tagFilter = tagFilter === tag ? null : tag;
        renderTags();
        renderList();
    }

    /** 列表顶部那条「筛选中:#… ×」。 */
    function renderTagFilterBar() {
        if (!tagFilterBar) return;
        const on = tagFilter !== null && tagFilter !== undefined;
        tagFilterBar.hidden = !on;
        if (on && tagFilterName) tagFilterName.textContent = `#${tagFilter}`;
    }

    function renderTags() {
        if (!tagPanelEl) return;
        const tags = (index?.tags ?? []).filter(t => t.tag !== undefined);

        tagPanelEl.innerHTML = '';
        // 一个标签都没有时整块收掉 —— 否则会留下一条只有边框的空面板
        if (tags.length === 0) { tagPanelEl.hidden = true; return; }
        tagPanelEl.hidden = false;

        const head = document.createElement('div');
        head.className = 'tag-head-row';
        const title = document.createElement('span');
        title.className = 'tag-title';
        title.textContent = '标签';
        head.appendChild(title);

        head.appendChild(tagToolButton('⌕', '过滤标签', () => {
            tagFilterOpen = !tagFilterOpen;
            if (!tagFilterOpen) tagKeyword = '';
            renderTags();
        }));
        head.appendChild(tagToolButton('⇅',
            tagSort === 'count' ? '当前按数量排序,点击改为按名称' : '当前按名称排序,点击改为按数量',
            () => {
                tagSort = tagSort === 'count' ? 'name' : 'count';
                renderTags();
            }));
        head.appendChild(tagToolButton(tagCollapsed ? '⌄' : '⌃',
            tagCollapsed ? '展开标签栏' : '收起标签栏',
            () => {
                tagCollapsed = !tagCollapsed;
                renderTags();
            }));
        tagPanelEl.appendChild(head);

        // 标签自己的过滤输入(不是笔记搜索:那个只过滤笔记)
        if (tagFilterOpen) {
            const row = document.createElement('div');
            row.className = 'tag-filter-row';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'tag-filter-input';
            input.value = tagKeyword;
            input.placeholder = '过滤标签…';
            input.setAttribute('aria-label', '过滤标签');
            const commit = (keep) => {
                if (!keep) { tagFilterOpen = false; tagKeyword = ''; }
                renderTags();
            };
            input.addEventListener('input', () => { tagKeyword = input.value; renderTags(); });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.preventDefault(); return commit(false); }
                return undefined;
            });
            row.appendChild(input);
            tagPanelEl.appendChild(row);
            input.focus();
        }

        // 收起:只留头部那一行(高度从此与标签数量无关)
        if (tagCollapsed) return;

        const list = visibleTags();
        const shown = tagExpanded ? list : list.slice(0, TAG_PREVIEW);
        const wrap = document.createElement('div');
        wrap.className = 'tag-chips';

        for (const t of shown) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'tag-chip';
            chip.dataset.tag = String(t.tag);
            chip.setAttribute('aria-pressed', String(tagFilter === t.tag));
            const name = document.createElement('span');
            name.className = 'tag-name';
            name.textContent = `#${t.tag}`;       // 标签名来自用户的笔记 → 一律 textContent
            const count = document.createElement('span');
            count.className = 'tag-count';
            count.textContent = String(t.count ?? 0);
            chip.appendChild(name);
            chip.appendChild(count);
            chip.addEventListener('click', () => toggleTagFilter(t.tag));
            wrap.appendChild(chip);
        }

        if (list.length > TAG_PREVIEW) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'tag-chip tag-more';
            more.textContent = tagExpanded ? '收起' : `+${list.length - shown.length}`;
            more.setAttribute('aria-expanded', String(tagExpanded));
            more.setAttribute('aria-label',
                tagExpanded ? '收起多余的标签' : `再显示 ${list.length - shown.length} 个标签`);
            more.addEventListener('click', () => { tagExpanded = !tagExpanded; renderTags(); });
            wrap.appendChild(more);
        }

        if (list.length === 0) {
            const hint = document.createElement('span');
            hint.className = 'tag-empty';
            hint.textContent = tags.length === 0 ? '还没有标签' : '没有匹配的标签';
            wrap.appendChild(hint);
        }
        tagPanelEl.appendChild(wrap);
    }

    // ---------- 链接解析 ----------

    /** 目标名 → 是否存在这样一篇笔记(决定 wiki 链接画实线还是虚线)。 */
    function isResolved(target) {
        const norm = String(target).trim().replace(/\.md$/i, '').toLowerCase();
        if (norm === '') return false;
        return (index?.notes ?? []).some(n => {
            const full = n.path.replace(/\.md$/i, '').toLowerCase();
            const base = n.path.split('/').pop().replace(/\.md$/i, '').toLowerCase();
            return full === norm || base === norm;
        });
    }

    function findNoteByTarget(target) {
        const norm = String(target).trim().replace(/\.md$/i, '').toLowerCase();
        return (index?.notes ?? []).find(n =>
            n.path.replace(/\.md$/i, '').toLowerCase() === norm
            || n.path.split('/').pop().replace(/\.md$/i, '').toLowerCase() === norm) ?? null;
    }

    // ---------- 编辑器 ----------

    const editor = createEditor({
        els: { rootEl: docEl, emptyEl, modeBtn },
        resolveLink: isResolved,
        liveMarkdown: true,
        log,
        onDirtyChange: (v) => {
            dirty = v;
            if (saveBtn) saveBtn.disabled = !v;
            if (v) {
                setStatus('有未保存的改动', 'dirty');
                clearTimeout(saveTimer);
                saveTimer = setTimeout(() => { if (dirty) save({ silent: true }); }, AUTOSAVE_MS);
            }
        },
    });

    editor.setLinkHandler((target) => {
        const hit = findNoteByTarget(target);
        if (hit) open(hit.path);
        else setStatus(`还没有《${target}》这篇笔记`, 'error');
    });

    // ---------- 链接栏 ----------

    function renderLinks(links) {
        const fill = (ul, items, make) => {
            if (!ul) return;
            ul.innerHTML = '';
            if (items.length === 0) {
                const li = document.createElement('li');
                li.className = 'link-meta';
                li.textContent = '—';
                ul.appendChild(li);
                return;
            }
            for (const item of items) {
                const li = document.createElement('li');
                li.appendChild(make(item));
                ul.appendChild(li);
            }
        };

        // 纯文本文件:三张列表都写一句**为什么**是空的 —— 空白会让人以为链接坏了,
        // 而这里是产品决定:txt 不参与链接与标签(用户要的"和 Markdown 隔开")。
        if (links?.kind === 'text') {
            const why = '纯文本文件不参与链接与标签(不解析 [[…]] 与 #标签)';
            for (const ul of [backlinkEl, outlinkEl, unresolvedEl]) {
                if (!ul) continue;
                ul.innerHTML = '';
                const li = document.createElement('li');
                li.className = 'link-meta';
                li.textContent = why;
                ul.appendChild(li);
            }
            return;
        }

        const linkBtn = (path, text, meta) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.title = path;
            b.addEventListener('click', () => open(path));
            if (meta) {
                const m = document.createElement('span');
                m.className = 'link-meta';
                m.textContent = ' ' + meta;
                b.appendChild(m);
            }
            return b;
        };

        fill(backlinkEl, links?.backlinks ?? [],
            (b) => linkBtn(b.path, b.title, `第 ${b.line} 行`));
        fill(outlinkEl, links?.outgoing ?? [],
            (o) => linkBtn(o.path, o.title, null));
        fill(unresolvedEl, links?.unresolved ?? [], (u) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = u.target;
            b.title = `还没写 —— 点一下新建《${u.target}》`;
            b.addEventListener('click', () => createNamed(u.target));
            return b;
        });
    }

    // ---------- 打开与保存 ----------

    /**
     * 打开一篇笔记。
     *
     * `source` 只有一个作用:**让外壳分清这次打开是谁发起的**。
     *   · 'user' —— 用户在列表 / 链接 / 反链里点的。外壳要按产品决定走
     *     **替换语义**:只有「笔记正文」那一格的标签被换掉(原标签关闭),别的面板一个字不动;
     *   · 'tabs' —— 标签条自己切过去的(用户点了另一个 doc 标签)。
     *     这时标签**已经**是那个了,外壳再做一次替换就会把旁边几个标签全关掉。
     */
    function destroyDocxReader() {
        docxReaderDispose?.destroy?.();
        docxReaderDispose = null;
        if (editorEl?.dataset) delete editorEl.dataset.documentKind;
    }

    function mountDocxReader(relPath, result) {
        destroyDocxReader();
        currentPath = relPath;
        dirty = false;
        const fileName = relPath.split('/').at(-1) ?? relPath;
        if (titleEl) {
            titleEl.value = fileName;
            titleEl.readOnly = true;
            titleEl.title = 'DOCX 文档只读 —— 原文件保持不变';
        }
        if (pathEl) pathEl.textContent = relPath;
        if (editorEl?.dataset) editorEl.dataset.documentKind = 'docx';
        if (saveBtn) saveBtn.disabled = true;
        if (emptyEl) emptyEl.hidden = true;
        if (editorEl) editorEl.hidden = false;
        docxReaderDispose = createDocxReader({
            document,
            root: docEl,
            html: result.html,
            fileName,
            size: result.size,
            mtimeMs: result.mtimeMs,
            openExternal: (url) => {
                void bridge.invoke('kaiwu:shell:openExternal', { url }).catch((err) => {
                    log.warn?.('[notes] 打开 DOCX 链接失败', err);
                    setStatus(`链接打不开:${err.message}`, 'error');
                });
            },
        });
        renderList();
        renderLinks({ backlinks: [], outgoing: [], unresolved: [] });
        const warning = (result.messages ?? []).some((item) => item.type === 'warning');
        setStatus(warning ? 'DOCX 已打开，部分格式可能未能还原' : `只读预览 · 上次修改:${new Date(result.mtimeMs).toLocaleString()}`);
    }

    function mountDocxError(relPath, err) {
        destroyDocxReader();
        currentPath = relPath;
        dirty = false;
        const fileName = relPath.split('/').at(-1) ?? relPath;
        if (titleEl) {
            titleEl.value = fileName;
            titleEl.readOnly = true;
            titleEl.title = 'DOCX 文档只读 —— 原文件保持不变';
        }
        if (pathEl) pathEl.textContent = relPath;
        if (editorEl?.dataset) editorEl.dataset.documentKind = 'docx';
        if (saveBtn) saveBtn.disabled = true;
        if (emptyEl) emptyEl.hidden = true;
        if (editorEl) editorEl.hidden = false;
        showDocxReaderError({
            document,
            root: docEl,
            message: err.message,
            fileName,
            onBack: () => {
                detachEditor();
                onCloseDocx?.(relPath);
            },
        });
        renderList();
        renderLinks({ backlinks: [], outgoing: [], unresolved: [] });
    }

    async function open(relPath, { source = 'user' } = {}) {
        // ⚠️ 第二道闸(第一道是 document 上那个捕获阶段的 click 吞噬):**刚拖过一手**时,
        //    紧跟着的那一下 click 不算"打开笔记"。放在这里是因为"打开笔记"最终都会走到这个漏斗,
        //    而它会调用 onOpenNote → 外壳 workspaceApi.openView('doc', …) → 工作台跳到
        //    "笔记正文(编辑/预览)"那一格 —— 正是用户看到的"拖个文件到画布上,面板自动跳走"。
        //    ⚠️ 注意:打开的若是**当前这一篇**,open() 会在下面第一行就 onOpenNote 返回 ——
        //       所以 #notePath 一个字都不变、照样跳;闸门必须加在这一行**之前**。
        if (isJustDragged()) {
            clearJustDragged();
            log.info?.('[notes] 这一下是拖动收尾补来的 click,不当"打开笔记"');
            return;
        }
        if (relPath === currentPath) {
            openGeneration += 1;            // 打开当前项也要取消尚未完成的其它读取
            onOpenNote?.(relPath, { source });
            return;
        }
        const generation = ++openGeneration;
        if (dirty) await save({ silent: true });     // 切走前强制保存

        const isDocx = typeof relPath === 'string' && /\.docx$/i.test(relPath);
        try {
            if (isDocx) {
                setStatus('正在读取并排版 DOCX…');
                const result = await bridge.invoke('notes:readDocx', { path: relPath });
                if (generation !== openGeneration) return;
                mountDocxReader(relPath, result);
                onOpenNote?.(relPath, { source, kind: 'docx' });
                return;
            }
            const r = await bridge.invoke('notes:read', { path: relPath });
            if (generation !== openGeneration) return;
            destroyDocxReader();
            currentPath = relPath;
            const meta = (index?.notes ?? []).find(n => n.path === relPath);
            if (titleEl) {
                // ⚠️ 纯文本的标题框是**只读**的:改标题那条路的实现是"改文件名 + 换掉正文里的 H1",
                //    而 txt 没有 H1 这个语义(硬跑会把 `# 标题` 塞进用户的文件)。
                //    文件名照样能改 —— 走右键菜单的重命名,那里只动文件名。
                // ⚠️ `.md` 里也有一类**只读**的:编码编不回去的(GBK / UTF-16)。改标题这条
                //    路要把正文 H1 重写一遍,而那份正文我们写不回去 —— 所以标题框同样只读。
                const titleLocked = r.kind === 'text' || r.editable === false;
                titleEl.value = meta?.title ?? relPath;
                titleEl.readOnly = titleLocked;
                if (typeof titleEl.setAttribute === 'function') {
                    titleEl.setAttribute('title', titleLocked
                        ? (r.kind === 'text'
                            ? '纯文本文件的标题就是文件名 —— 用右键菜单「重命名」改'
                            : '这篇笔记的编码开物写不回去,标题框是只读的')
                        : '');
                }
            }
            if (pathEl) pathEl.textContent = relPath;
            // ⚠️ kind 决定编辑器走哪条路:纯文本**不解析任何 Markdown 语法**(用户要的隔离)。
            editor.load(r.text, { kind: r.kind === 'text' ? 'text' : 'markdown' });
            // 不是 UTF-8(GBK / UTF-16)的内容只能读:开物编不回去,绝不假装能写。
            // ⚠️ 这里**不能只判 kind === 'text'**:`.md` 现在也走同一套编解码判据
            //    (见 note-index.js),它一样可能是 GBK / UTF-16 —— 那时也必须只读打开。
            if (r.editable === false) {
                editor.setMode('preview');
                setStatus(`${r.reason || '这份内容不是 UTF-8'} —— 只读打开`, 'error');
            }
            if (emptyEl) emptyEl.hidden = true;
            if (editorEl) editorEl.hidden = false;
            // 打开即进入编辑:光标进第 0 块,与「新建笔记」同一条规则。
            // ⚠️ 必须排在 hidden = false **之后** —— 隐藏祖先里的 focus() 会被浏览器
            // 静默丢弃:设了、读回来也对、就是没生效(HANDOFF §A9 那一类)。
            editor.focusFirst();
            if (saveBtn) saveBtn.disabled = true;
            // 只读打开时上面那句"为什么只读"必须留在状态行上(不能被这句覆盖掉)
            if (r.editable !== false) {
                setStatus(`上次修改:${new Date(r.mtimeMs).toLocaleString()}`);
            }
            renderList();
            await refreshLinks();
            onOpenNote?.(relPath, { source });
        } catch (err) {
            if (generation !== openGeneration) return;
            log.error?.('[notes] 打开失败', err);
            if (isDocx) {
                mountDocxError(relPath, err);
                onOpenNote?.(relPath, { source, kind: 'docx' });
            }
            setStatus(`打开失败:${err.message}`, 'error');
        }
    }

    async function refreshLinks() {
        if (!currentPath) return;
        try {
            const links = await bridge.invoke('notes:links', { path: currentPath });
            renderLinks(links);
        } catch (err) {
            log.warn?.('[notes] 取链接失败', err);
        }
    }

    async function save({ silent = false } = {}) {
        if (!currentPath || saving || editorEl?.dataset?.documentKind === 'docx') return;
        const text = editor.value();
        saving = true;
        if (saveBtn) saveBtn.disabled = true;
        if (!silent) setStatus('保存中…');
        try {
            await bridge.invoke('notes:write', { path: currentPath, text });
            editor.markClean();
            dirty = false;
            setStatus(`已保存 ${new Date().toLocaleTimeString()}`);
            await refreshLinks();
            await refreshIndex({ keepSelection: true });
        } catch (err) {
            log.error?.('[notes] 保存失败', err);
            setStatus(`保存失败:${err.message}`, 'error');
            if (saveBtn) saveBtn.disabled = false;
        } finally {
            saving = false;
        }
    }

    // ---------- 新建 ----------

    function uniqueName(base, dir = '') {
        const prefix = dir === '' ? '' : `${String(dir).replace(/\/+$/, '')}/`;
        const names = new Set((index?.notes ?? []).map(n => n.path.toLowerCase()));
        let candidate = `${prefix}${base}.md`;
        let n = 2;
        while (names.has(candidate.toLowerCase())) {
            candidate = `${prefix}${base} ${n}.md`;
            n++;
        }
        return candidate;
    }

    /**
     * 新建一篇笔记并打开它。
     * @param {string} title 用户想起的名字(会被洗成合法文件名)
     * @param {string} [inFolder] 放进哪个文件夹(Vault 内相对路径;空 = 根目录)
     */
    async function createNamed(title, inFolder = '') {
        const clean = String(title).trim().replace(/[\\/:*?"<>|]/g, '') || '未命名';
        const rel = uniqueName(clean, inFolder);
        try {
            await bridge.invoke('notes:create', { path: rel, text: `# ${clean}\n\n` });
            await refreshIndex({ keepSelection: false });
            await open(rel);           // 聚焦由 open() 统一负责,不要再在这里补一次
        } catch (err) {
            log.error?.('[notes] 新建失败', err);
            setStatus(`新建失败:${err.message}`, 'error');
        }
    }

    // ---------- 标题 ----------
    //
    // 顶栏那个 #noteTitle 原先**一个监听器都没有**:打进去的字没有任何代码读,
    // 保存按钮的启用条件只认正文的 dirty 标记 —— 于是「命名好后无法保存」,
    // 而且不报错(disabled 按钮的点击是 no-op,连日志都不会有)。
    // 现在回车/失焦提交给 notes:setTitle,由主进程把**文件名与正文 H1 一起**改掉
    // (只改一处会被标题解析顺序里的另一处盖回去,见 note-index.js 的 setBodyTitle)。

    let titleBusy = false;

    /** 与主进程 sanitizeTitle 同一套规则。放这里只为了本地就能判断"空"与"没改"。 */
    function cleanTitle(raw) {
        return String(raw ?? '').trim().replace(/[\\/:*?"<>|]/g, '').trim();
    }

    /** 当前这篇笔记在界面上显示的标题。 */
    function shownTitle() {
        const meta = (index?.notes ?? []).find(n => n.path === currentPath);
        return meta?.title ?? currentPath ?? '';
    }

    async function commitTitle() {
        if (!currentPath || titleBusy || editorEl?.dataset?.documentKind === 'docx') return;

        const current = shownTitle();
        const wanted = cleanTitle(titleEl?.value);

        // 清空 = 想反悔。既不拿它去改名,也不让它留在界面上冒充"已保存"。
        if (wanted === '') {
            if (titleEl) titleEl.value = current;
            setStatus('标题不能为空,已还原', 'error');
            return;
        }
        // 没改就什么都不做 —— 否则点开一篇笔记再点别处都要白写一次盘
        if (wanted === current) {
            if (titleEl) titleEl.value = current;
            return;
        }

        titleBusy = true;
        if (saveBtn) saveBtn.disabled = true;
        setStatus('改名中…');
        try {
            // 正文有改动就先落盘:名字一改 currentPath 就失效了,
            // 没保存的内容会留在一条已经不存在的路径上
            if (dirty) await save({ silent: true });

            const r = await bridge.invoke('notes:setTitle', { path: currentPath, title: wanted });
            currentPath = r.to;
            if (pathEl) pathEl.textContent = r.to;
            if (titleEl) titleEl.value = r.title;

            // 正文 H1 是主进程改的,得读回来 —— 否则编辑器里还显示旧标题
            const fresh = await bridge.invoke('notes:read', { path: r.to });
            editor.load(fresh.text);
            dirty = false;

            setStatus(`已改名为《${r.title}》`);
            await refreshIndex({ keepSelection: true });
            await refreshLinks();
            onOpenNote?.(r.to);
        } catch (err) {
            log.error?.('[notes] 改名失败', err);
            setStatus(`改名失败:${err.message}`, 'error');
            // 还原输入框:界面不能显示一个并没有落地的名字
            if (titleEl) titleEl.value = current;
        } finally {
            titleBusy = false;
            // 与模式切换按钮**同一条规则**:只读预览下保存按钮永远不可用。
            // 只看 dirty 的话,改名失败(正文仍是脏的)会在预览里点亮一个按了也没用的按钮。
            if (saveBtn) saveBtn.disabled = editor.getMode() === 'preview' ? true : !dirty;
        }
    }

    // ---------- 索引 ----------

    async function refreshIndex({ keepSelection = true } = {}) {
        try {
            index = await bridge.invoke('notes:index', {});
            renderTags();
            renderList();
            return index;
        } catch (err) {
            log.error?.('[notes] 索引失败', err);
            setStatus(`索引失败:${err.message}`, 'error');
            return null;
        }
    }

    // ---------- 事件绑定 ----------

    saveBtn?.addEventListener('click', () => save());
    searchEl?.addEventListener('input', () => {
        keyword = searchEl.value.trim().toLowerCase();
        renderList();
    });
    newBtn?.addEventListener('click', () => createNamed('未命名'));

    /**
     * 列表**空白处**右键 → 浮层菜单(产品原话:「右击空白处可以在菜单栏中新建笔记」)。
     *
     * ⚠️ 听的是**滚动容器**(列表的父级)的 contextmenu,不是列表(ul)自己的:
     *    ul 是块级元素,只有内容那么高,最后一行下面那片空白**根本不在 ul 里** ——
     *    点在界面上,事件目标是容器。只挂在 ul 上,用户点"列表下面那块空"就没反应,
     *    而那块恰恰最像"空白处"。
     * 行上的右键正常走不到这里:行自己的监听器 preventDefault 之后 stopPropagation。
     */
    const blankMenuEl = listEl?.parentElement ?? listEl;
    blankMenuEl?.addEventListener?.('contextmenu', (e) => {
        // 下面两道判据都是**兜底**:将来新增的行万一漏了 stopPropagation,
        // 也不至于让那一行自己的菜单被"空白菜单"顶掉。
        if (e?.defaultPrevented === true) return;
        const t = e?.target;
        // 只按"有没有落在可交互的行上"判断,不按"是不是 li":列表为空时那条
        // 「还没有笔记」的提示也是一个 li —— 而列表为空恰恰是最该出这个菜单的时候。
        // 标签面板 / 标签筛选条也排掉:它们不是"列表的空白处",右键弹一个新建菜单不合适。
        if (t?.closest?.('button, input, .note-menu, .tag-panel, .tag-filter-bar')) return;
        e?.preventDefault?.();
        openBlankMenu(e);
    });

    // 清除标签筛选(列表顶部那条提示上的 ×)
    els.tagFilterClear?.addEventListener('click', () => {
        tagFilter = null;
        renderTags();
        renderList();
    });

    // 新建文件夹:开一个内联输入行(见 appendNewFolderRow 的说明)
    newFolderBtn?.addEventListener('click', () => {
        newFolderOpen = true;
        renderList();
    });

    // 标题提交:回车或失焦。
    // 回车要 preventDefault,免得上层把它当成"确认/换行"之类的别的动作。
    // 返回 promise 只是让测试替身能 await 到提交完成 —— 浏览器会忽略监听器的返回值。
    titleEl?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        return commitTitle();
    });
    titleEl?.addEventListener('blur', () => commitTitle());

    // 编辑 ⇄ 预览 切换
    modeBtn?.addEventListener('click', () => {
        const next = editor.getMode() === 'live' ? 'preview' : 'live';
        editor.setMode(next);
        modeBtn.textContent = next === 'preview' ? '编辑' : '预览';
        // 预览模式下不显示"保存"按钮的可用态(没有可编辑内容)
        if (saveBtn) saveBtn.disabled = next === 'preview' ? true : !dirty;
    });

    // Ctrl/Cmd+S 保存
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !editorEl?.hidden) {
            e.preventDefault();
            save();
        }
    });

    // 关窗前尽力保存一次
    window.addEventListener('beforeunload', () => {
        if (dirty && currentPath) {
            // 同步发一次,不等结果 —— 关窗流程不给等待的机会
            bridge.invoke('notes:write', { path: currentPath, text: editor.value() })
                .catch(() => {});
        }
    });

    return {
        /** 设定当前笔记库并载入索引 */
        async setVault() {
            openGeneration += 1;
            destroyDocxReader();
            if (emptyEl) emptyEl.hidden = false;
            if (editorEl) editorEl.hidden = true;
            currentPath = null;
            return refreshIndex({ keepSelection: false });
        },
        refreshIndex,
        open,
        createNamed,
        save,
        hasUnsaved: () => dirty,
        get currentPath() { return currentPath; },
        get index() { return index; },
        editor,
        // 拖动状态的最小只读出口。为什么留它:拖动这条链路(阈值 → 捕获 → 命中 →
        // 落点判定)在界面上"没反应"时,靠肉眼看不出卡在哪一步 —— 自检要能一次问到
        // "手势起没起来、落点判定是什么"。只读,不改任何状态。
        dragState() {
            return {
                down: dragState.down,
                active: dragState.active,
                from: dragState.from,
                hit: dragState.hit ?? null,
                target: dragState.target,
            };
        },
    };
}
