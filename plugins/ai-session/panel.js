// 「AI 会话」面板的视图 —— **单列:每一行自己就是"切过去"的按钮**。
//
// 与上一版的区别(整块重做,electron/selftest.js 里 8 条断言逐条钉着):
//   · **没有右栏**:详情/回看整块删掉 —— 面板根节点`.ses-pane` 只有一个孩子(清单这一列);
//   · **行即按钮**:`role="button"` + `tabIndex=0`,左键点 = 切过去,回车与左键等效;
//   · **右键出浮层菜单**(不是右键即删),唯一一项是「删除记录」,Esc 关掉并把焦点还给那一行;
//   · **失败原因长在那一行上**(`.ses-row-err`),不再有顶部提示条。
//
// 为什么删掉右栏反而更清楚:点一行就已经切过去,开物会把台账里的历史**铺进「AI 对话」那一格** ——
// 与 DSH / ChatGPT 的会话栏同一种用法(点了就是进去了),而不是"先看一个小预览、再点一次才进去"。
//
// ⚠️ 纪律:**绝不 innerHTML**。内容来自模型(回复/title)与用户,一律 textContent。

/** 时间戳 → `13:02`。 */
function clockOf(ms) {
    const d = new Date(Number(ms) || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {HTMLElement} host 外壳造好的宿主
 * @param {object} ctx 插件上下文(只用到 sessions / log)
 */
export function setup(host, ctx) {
    const sessions = ctx.sessions;
    if (sessions === undefined) {
        host.textContent = '这个面板需要清单里的 "sessions" 权限(见 plugins/ai-session/plugin.json)。';
        return;
    }

    const doc = document;

    const el = (tag, cls = '', text = '') => {
        const node = document.createElement(tag);
        if (cls !== '') node.className = cls;
        if (text !== '') node.textContent = text;
        return node;
    };

    // ---- 骨架:**一列**(自检钉着 `.ses-pane` 只有一个孩子) ----
    const root = el('div', 'ses-pane');
    const listCol = el('div', 'ses-list');
    root.append(listCol);
    host.append(root);

    /** 最近一次清单。 */
    let rows = [];
    /** 在飞的一轮(清单里带回来的):新建 / 切会话都要禁用。 */
    let busyTurn = false;
    /** 正在忙(某次操作没回来):防连点。 */
    let busy = false;
    /** 清单级的错误(读不到台账之类)。⚠️ 成功路径上一句话都不许挂在这儿。 */
    let lerr = '';
    /** 行级错误:会话 id → 原因。**跨重画保留** —— 失败信息不该被下一次刷新吃掉。 */
    const rowErrs = new Map();
    /** 当前开着的浮层菜单。 */
    let menu = null;
    let menuFor = null;

    // ---------------------------------------------------------------- 菜单
    function closeMenu({ focusBack = false } = {}) {
        if (menu === null) return;
        const box = menu;
        const id = menuFor;
        menu = null;
        menuFor = null;
        box.remove();
        // 键盘用户关掉菜单之后,焦点要**回到原来那一行**(自检钉着 focusBack)
        if (focusBack && id !== null) {
            const row = listCol.querySelector(`.ses-row[data-id="${id}"]`);
            if (row !== null && typeof row.focus === 'function') row.focus();
        }
    }

    /**
     * 右键浮层。
     * ⚠️ 菜单上只放**叶子字段**:它属于哪条会话(menuId)、是哪一种菜单(menuKind) ——
     * 自检靠这两个 attribute 认人,不靠中文文案。
     */
    function openMenu(id, x, y) {
        closeMenu();
        const box = el('div', 'ses-menu');
        box.dataset.menuId = id;
        box.dataset.menuKind = 'session';
        box.setAttribute('role', 'menu');
        const item = el('button', 'ses-menu-item', '删除记录');
        item.type = 'button';
        item.dataset.menuRole = 'remove';
        item.setAttribute('role', 'menuitem');
        item.addEventListener('click', () => {
            const target = menuFor;
            closeMenu();
            void removeSession(target ?? id);
        });
        box.append(item);
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault?.(); closeMenu({ focusBack: true }); return; }
            // 只有一项时 ↑↓ 是绕回自己 —— 这里保证"按了不炸、焦点还在菜单里"
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault?.();
                item.focus();
            }
        });
        // 点别处就收(与外壳那些浮层同一条口径)
        const onDown = (e) => { if (!box.contains(e.target)) closeMenu(); };
        doc.addEventListener('pointerdown', onDown, { once: true });
        // ⚠️ 挂**宿主里面**(不是 document.body):自检在宿主范围内找 .ses-menu;
        //    而 position:fixed 让它在视觉上照样不受面板 overflow 裁剪。
        host.append(box);
        menu = box;
        menuFor = id;
        // 定位:fixed,免得被面板的 overflow 裁掉
        box.style.left = `${Math.round(Number(x) || 0)}px`;
        box.style.top = `${Math.round(Number(y) || 0)}px`;
        item.focus();   // 打开就把焦点放进菜单(键盘可达)
    }

    // ---------------------------------------------------------------- 行
    function rowNode(row) {
        const node = el('div', 'ses-row');
        node.dataset.id = row.id;
        // 行**自己**就是"切过去"的控件:没有右栏那个按钮了,不可聚焦等于键盘用户切不了会话。
        node.setAttribute('role', 'button');
        node.tabIndex = 0;
        if (row.current === true) node.classList.add('current');
        // 0 轮 = 已经建好但一句话都还没说(「点了立刻建」会造出来的那种)。
        const label = Number(row.turns ?? 0) > 0 ? (row.title || '(没有标题)') : '新会话(还没说话)';
        node.append(el('div', 'ses-title', label));
        const meta = el('div', 'ses-meta');
        meta.append(el('span', '', clockOf(row.updatedAt)));
        if (Number(row.turns ?? 0) > 0) meta.append(el('span', '', `${row.turns} 轮`));
        else meta.append(el('span', 'ses-empty-turn', '0 轮'));
        if (row.model !== '') meta.append(el('span', 'ses-model', row.model));
        if (row.stateLabel !== '') meta.append(el('span', `ses-badge ${row.state}`, row.stateLabel));
        node.append(meta);
        const err = rowErrs.get(row.id);
        if (err !== undefined && err !== '') node.append(el('div', 'ses-row-err', err));
        // 左键 / 回车 / 空格:三条路都走"切过去"
        node.addEventListener('click', (e) => { e.stopPropagation?.(); void activate(row.id); });
        node.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault?.();
                void activate(row.id);
            }
        });
        node.addEventListener('contextmenu', (e) => {
            e.preventDefault?.();
            e.stopPropagation?.();
            openMenu(row.id, e.clientX, e.clientY);
        });
        return node;
    }

    function renderList() {
        listCol.replaceChildren();
        const head = el('div', 'ses-lhead');
        head.append(el('span', '', '历次对话'), el('span', 'ses-count', String(rows.length)));
        // 「＋ 新建会话」:点了**立刻**让对端开一条新的。
        const create = el('button', 'ses-new', '＋ 新建会话');
        create.type = 'button';
        create.disabled = busyTurn || busy;
        create.title = busyTurn
            ? '这一轮还没结束 —— 等它跑完(或取消)再新建'
            : '立刻开一条全新的会话(对端当场建,台账里立刻会出现一条 0 轮的记录)';
        create.addEventListener('click', () => { void createSession(); });
        head.append(create);
        const refresh = el('button', 'ses-refresh', '刷新');
        refresh.type = 'button';
        refresh.addEventListener('click', () => { void load(); });
        head.append(refresh);
        listCol.append(head);

        // 清单级的话(读不到台账之类)。成功路径上它必须是空的 —— 自检钉着这一条。
        listCol.append(el('div', 'ses-lerr', lerr));

        if (rows.length === 0) {
            const empty = el('div', 'ses-empty');
            empty.append(
                el('span', 'ses-empty-big', '还没有会话记录'),
                el('span', '', '在「AI 对话」里聊过一次之后,这里就会出现一条 —— 记录写在 笔记库/AI会话/ 里。'),
            );
            listCol.append(empty);
            return;
        }
        let day = null;
        for (const row of rows) {
            if (row.day !== day) { day = row.day; listCol.append(el('div', 'ses-day', day)); }
            listCol.append(rowNode(row));
        }
    }

    // ---------------------------------------------------------------- 数据
    async function load() {
        const r = await sessions.list();
        busyTurn = r?.busy === true;
        if (r?.ok !== true) {
            rows = [];
            lerr = r?.reason ?? '读不到会话记录';
            renderList();
            return;
        }
        rows = Array.isArray(r.rows) ? r.rows : [];
        lerr = '';
        // 已经不在清单里的那些行,错误也跟着清掉(不许对不存在的行说错话)
        for (const id of [...rowErrs.keys()]) {
            if (!rows.some((x) => x.id === id)) rowErrs.delete(id);
        }
        renderList();
    }

    /** 切到某一条会话(左键 / 回车)。 */
    async function activate(id) {
        if (id === '' || busy) return;
        busy = true;
        rowErrs.delete(id);          // 这一条要重新试,旧的失败原因先撤掉
        renderList();
        const r = await sessions.activate(id);
        busy = false;
        try {
            host.dataset.lastActivate = JSON.stringify({
                ok: r?.ok === true, sessionId: r?.sessionId ?? null,
                reused: r?.reused === true, reason: r?.reason ?? '',
            });
        } catch { /* dataset 写不进去不该影响功能 */ }
        if (r?.ok !== true) {
            // ⚠️ 失败**长在这一行上**:右栏与提示条都没了,静默就是"点了没反应"。
            //    原因里带着对端的原话(主进程已经把认得出的那几类换成了中文 + 原话)。
            rowErrs.set(id, `没能接回来:${r?.reason ?? '未知原因'}`);
            renderList();
            return;
        }
        await load();
    }

    /** 新建一条会话(「＋ 新建会话」)。 */
    async function createSession() {
        if (busy) return;
        busy = true;
        renderList();
        const r = await sessions.create();
        busy = false;
        try {
            host.dataset.lastCreate = JSON.stringify({
                ok: r?.ok === true, sessionId: r?.sessionId ?? null, reason: r?.reason ?? '',
            });
        } catch { /* 同上 */ }
        if (r?.ok !== true) {
            lerr = `没能新建会话:${r?.reason ?? '未知原因'}`;
            renderList();
            return;
        }
        lerr = '';
        await load();
    }

    /** 删掉一条记录(右键菜单那一项)。 */
    async function removeSession(id) {
        if (id === null || id === '' || busy) return;
        const r = await sessions.remove(id);
        try {
            host.dataset.lastRemove = JSON.stringify({
                ok: r?.ok === true, removed: r?.removed === true, reason: r?.reason ?? '',
            });
        } catch { /* 同上 */ }
        if (r?.ok !== true) {
            rowErrs.set(id, `没能删除:${r?.reason ?? '未知原因'}`);
            renderList();
            return;
        }
        rowErrs.delete(id);
        await load();
    }

    // ---- 起手 ----
    lerr = '';
    renderList();
    void load();
    // 台账落盘 / 当前会话变了 → 跟着刷新(一轮聊完那一行要排到最前面)
    const off = sessions.onChanged?.(() => { void load(); });
    if (typeof off === 'function') ctx.onDispose?.(off);
    // 面板被拆掉时把菜单也收掉(它是挂在 body 上的,不跟着宿主一起走)
    ctx.onDispose?.(() => closeMenu());
}
