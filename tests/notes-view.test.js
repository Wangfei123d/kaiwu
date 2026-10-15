import { test } from 'node:test';
import assert from 'node:assert/strict';

// 复现用户报的缺陷:「命名好后无法保存」。
//
// 顶栏的 #noteTitle 是个真的可编辑输入框,但**没有任何代码读它的值**:
// 保存按钮的启用条件只认正文的 dirty 标记,而 save() 也只写正文。
// 于是在标题框里打字等于什么都没发生,按钮一直是灰的,而且**不报错** ——
// disabled 按钮的点击是 no-op,连一行日志都不会有。
//
// 这组用例钉住修复后的契约:回车或失焦必须真的把标题落盘(notes:setTitle),
// 失败或为空时必须把输入框还原 —— 界面绝不能显示一个并没有落地的名字。

/** 把一棵子树标记成"已从文档里摘掉"(真实的 innerHTML 重写就是这件事)。 */
function markDetached(el) {
    for (const child of el.children ?? []) {
        child.isConnected = false;
        markDetached(child);
    }
}

class El {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
        // 真实的 CSSStyleDeclaration 有 setProperty;替身也**记下来** —— 树状列表
        // 用 `--depth` 传层级,读不回来的话"缩进对不对"就没法断言了
        this.style = { props: {}, setProperty(k, v) { this.props[k] = String(v); } };
        this.listeners = {}; this._html = ''; this._value = '';
        this.hidden = false; this.scrollHeight = 20; this.textContent = '';
        this.disabled = false; this.attrs = {}; this.className = ''; this.title = '';
        // 真实的节点有 isConnected;替身必须也有 —— 代码用它区分"被重画摘掉"
        // 与"用户点到别处"这两种失焦(见 renameRow 的 blur)
        this.isConnected = true;
        this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set innerHTML(v) { this._html = String(v); markDetached(this); this._parse(); }
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
    /** 触发事件,并 await 监听器返回的 promise(项目的既有约定,见 onboarding.test.js)。 */
    async fire(type, event = {}) {
        for (const f of this.listeners[type] ?? []) {
            await f({ preventDefault() {}, stopPropagation() {}, ...event });
        }
    }
    appendChild(c) { this.children.push(c); c._parent = this; return c; }
    remove() {
        this.removed = true;
        this.isConnected = false;
        const p = this._parent;
        if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); }
    }
    /** 浮层"点里面不算点外面"靠它(真实的 Node.contains 也是这个语义:含自己)。 */
    contains(node) {
        if (node === this) return true;
        return this.children.some(c => c.contains?.(node) === true);
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    querySelector(sel) {
        if (sel === 'textarea.blk-input') return this.children.find(c => c._isInput) ?? null;
        return null;
    }
    querySelectorAll(sel) { return sel.includes('blk') ? this.children : []; }
    closest() { return null; }
    /** 记下聚焦次数:"打开就把焦点放进菜单"这类断言只能靠它。 */
    focus() { this.focused = (this.focused ?? 0) + 1; }
    select() { this.selected = (this.selected ?? 0) + 1; }
    setSelectionRange() {}
}

// document / window 都**记下**监听器:浮层的"点外面关掉"与"滚动关掉"是绑在它们身上的,
// 不记的话这两条规则就只能靠肉眼在真窗口里看(自检那层才有真 DOM)。
globalThis.document = {
    listeners: {},
    createElement: (t) => new El(t),
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
};
globalThis.window = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
};

const { createNotesView } = await import('../app/notes/notes-view.js');

/** 够用的笔记库替身:文件内容在 files,索引条目在 notes,目录在 folders,标签在 tags。 */
function boot({
    notes = [], folders = [], tags = [], files = {},
    failTitle = null, failWrite = null, failMkdir = null, failRename = null, failRemove = null,
    failRemoveDir = null,
    // 删除的两种落点:系统回收站(默认) / 这个卷没有回收站时的**库内 .trash**。
    // 2026-09-29 用户报"点了删除没反应",根因就是他的库在 FAT32 可移动盘上没有回收站 ——
    // 这条路径必须在渲染层也被验到(状态行要说清东西去哪了)。
    removeMode = 'trash',
    // 两步确认的告警态还原时长。用例里给一个很短的值(生产是 4000):
    // "超时自动还原"这条规则要能被真的等到,而不是靠肉眼在真窗口里看 4 秒。
    deleteConfirmMs = 25,
} = {}) {
    const state = {
        notes: notes.map(n => ({ ...n })), folders: [...folders], tags: [...tags],
        files: { ...files }, failTitle, failWrite, failMkdir, failRename, failRemove, failRemoveDir,
        removeMode,
        /** 被 notes:remove 删掉的路径(按调用顺序)。 */
        removed: [],
        /** 被 notes:removeDir 删掉的目录(按调用顺序)。 */
        removedDirs: [],
    };
    const calls = [];
    // 每次 boot 都把全局监听器清空:否则前一个用例的视图也会收到这次派发的事件
    // (它自己那份 noteMenu 早关了,不会误伤,但"到底是谁处理的"就没法说清了)。
    globalThis.document.listeners = {};
    globalThis.window.listeners = {};
    // 焦点也一并复位:空白处菜单没有"那一行"可还,它靠 document.activeElement 记
    // "打开前聚焦的是谁"。上个用例留下的值会静默影响这个用例。
    globalThis.document.activeElement = null;

    const invoke = async (channel, payload = {}) => {
        calls.push([channel, payload]);
        switch (channel) {
        case 'notes:index':
            return { root: 'V', notes: state.notes, folders: state.folders, tags: state.tags };
        case 'notes:read':
            return { text: state.files[payload.path] ?? '', mtimeMs: 0 };
        case 'notes:links':
            return { backlinks: [], outgoing: [], unresolved: [] };
        case 'notes:write':
            if (state.failWrite !== null) throw new Error(state.failWrite);
            state.files[payload.path] = payload.text;
            return { path: payload.path };
        case 'notes:create':
            state.files[payload.path] = payload.text ?? '';
            state.notes.push({
                path: payload.path,
                title: payload.path.split('/').pop().replace(/\.md$/i, ''),
                tags: [],
            });
            return { path: payload.path };
        case 'notes:mkdir': {
            if (state.failMkdir !== null) throw new Error(state.failMkdir);
            state.folders.push(payload.path);
            return { path: payload.path };
        }
        // notes:rename 只搬文件,不碰正文/frontmatter —— 主进程就是这么实现的
        // (界面上显示的标题是索引另外算出来的:frontmatter.title → H1 → 文件名)。
        // 这里的替身也只搬条目,索引重算后标题由用例自己按需断言。
        case 'notes:rename': {
            if (state.failRename !== null) throw new Error(state.failRename);
            if (payload.to !== payload.from) {
                if (Object.prototype.hasOwnProperty.call(state.files, payload.to)) {
                    throw new Error(`目标已存在:${payload.to}`);
                }
                state.files[payload.to] = state.files[payload.from] ?? '';
                delete state.files[payload.from];
                const meta = state.notes.find(n => n.path === payload.from);
                if (meta) meta.path = payload.to;
            }
            return { from: payload.from, to: payload.to };
        }
        // notes:remove:进的是系统回收站(真主进程走 shell.trashItem),替身只记账。
        // 这里**不模拟**失败之外的任何 fs 语义:用例要断言的是"界面调没调、传了什么路径"。
        case 'notes:remove': {
            if (state.failRemove !== null) throw new Error(state.failRemove);
            state.removed.push(payload.path);
            state.notes = state.notes.filter(n => n.path !== payload.path);
            delete state.files[payload.path];
            // 主进程的两种落点(系统回收站 / 这个卷没有回收站时的库内 .trash)都要能演出来
            return {
                path: payload.path,
                trashed: [payload.path],
                warning: null,
                mode: state.removeMode,
                to: state.removeMode === 'vault' ? '.trash/2026-09-29-230000/未命名.md' : null,
            };
        }
        // notes:removeDir:删一个文件夹(真主进程走 shell.trashItem + 递归计数)。
        // 替身把"这个目录下的东西都没了"这个**语义**演出来,用例要断言的是界面调没调、
        // 传了什么路径、以及刷新后列表对不对。
        case 'notes:removeDir': {
            if (state.failRemoveDir !== null) throw new Error(state.failRemoveDir);
            state.removedDirs.push(payload.path);
            const prefix = `${payload.path}/`;
            state.notes = state.notes.filter(n => n.path !== payload.path && !n.path.startsWith(prefix));
            state.folders = state.folders.filter(f => f !== payload.path && !f.startsWith(prefix));
            for (const key of Object.keys(state.files)) {
                if (key === payload.path || key.startsWith(prefix)) delete state.files[key];
            }
            return {
                path: payload.path,
                files: 1,
                notes: 1,
                mode: state.removeMode,
                to: state.removeMode === 'vault' ? '.trash/2026-09-29-230000/阅读' : null,
            };
        }
        case 'notes:setTitle': {
            if (state.failTitle !== null) throw new Error(state.failTitle);
            const to = `${payload.title}.md`;
            // 主进程的 setTitle 会同时改文件名与正文 H1,替身照做
            state.files[to] = String(state.files[payload.path] ?? '')
                .replace(/^# .*$/m, `# ${payload.title}`);
            delete state.files[payload.path];
            const meta = state.notes.find(n => n.path === payload.path);
            if (meta) { meta.path = to; meta.title = payload.title; }
            return { from: payload.path, to, title: payload.title, renamed: true };
        }
        default:
            return {};
        }
    };

    const els = {
        listEl: new El(), searchEl: new El(), newBtn: new El(), newFolderBtn: new El(),
        emptyEl: new El(),
        editorEl: new El(), titleEl: new El(), pathEl: new El(), saveBtn: new El(),
        statusEl: new El(), modeBtn: new El(), docEl: new El(), backlinkEl: new El(),
        outlinkEl: new El(), unresolvedEl: new El(), tagPanelEl: new El(),
        tagFilterBar: new El(), tagFilterName: new El(), tagFilterClear: new El(),
    };
    // 真 DOM 里 #noteList 的父级是 .notes-nav-scroll;浮层挂在那里(不是挂进列表里),
    // 替身也照这个形状搭 —— 否则"重画列表会不会把浮层吃掉"这件事就测不出来了。
    els.listEl.parentElement = new El('div');
    // 父链也接上(appendChild 会自动接):"contextmenu 冒泡到滚动容器"这条路要真的走得通,
    // 才测得出"行上的右键不会被空白菜单抢走"。
    els.listEl._parent = els.listEl.parentElement;

    // 外壳靠这个回调把「笔记正文」那一格切到新路径(改名后标签条也要跟着换)
    const opened = [];
    const view = createNotesView({
        els,
        bridge: { invoke },
        log: { error() {}, warn() {} },
        onOpenNote: (path) => opened.push(path),
        deleteConfirmMs,
    });
    return {
        view, els, calls, state,
        openedNotes: () => [...opened],
        titleCalls: () => calls.filter(c => c[0] === 'notes:setTitle'),
        mkdirCalls: () => calls.filter(c => c[0] === 'notes:mkdir'),
        createCalls: () => calls.filter(c => c[0] === 'notes:create'),
        renameCalls: () => calls.filter(c => c[0] === 'notes:rename'),
        removeCalls: () => calls.filter(c => c[0] === 'notes:remove'),
        removeDirCalls: () => calls.filter(c => c[0] === 'notes:removeDir'),
        /** 文件夹菜单里那一项「删除文件夹」。 */
        removeDirItem: () => (els.listEl.parentElement.children
            .find(c => c.className === 'note-menu')?.children ?? [])
            .find(c => c.dataset?.menuRole === 'remove-dir') ?? null,
        /** 删除菜单项(带两步确认的那一项)。 */
        deleteItem: () => (els.listEl.parentElement.children
            .find(c => c.className === 'note-menu')?.children ?? [])
            .find(c => c.dataset?.menuRole === 'delete-note') ?? null,
        /** 浮层菜单(挂在列表的父级上)。 */
        menu: () => els.listEl.parentElement.children.find(c => c.className === 'note-menu') ?? null,
        /** 这一份浮层是谁的('note' = 笔记行 / 'dir' = 文件夹行 / 'blank' = 列表空白处)。 */
        menuKind: () => (els.listEl.parentElement.children
            .find(c => c.className === 'note-menu')?.dataset.menuKind ?? null),
        /** 浮层里的菜单项。 */
        menuItems: () => (els.listEl.parentElement.children
            .find(c => c.className === 'note-menu')?.children ?? [])
            .filter(c => c.className === 'note-menu-item'),
        /** 行内改名输入框。 */
        renameInput() {
            for (const li of els.listEl.children) {
                const hit = (li.children ?? []).find(c => c.className === 'note-rename-input');
                if (hit) return hit;
            }
            return null;
        },
        /** 按路径找列表里那一行的按钮(树里/拍平里都能找到)。 */
        noteButton(path) {
            for (const li of els.listEl.children) {
                const hit = (li.children ?? []).find(c => c.tagName === 'BUTTON' && c.dataset?.path === path);
                if (hit) return hit;
            }
            return null;
        },
        /** 右键某一篇(替身里没有真鼠标,直接派发 contextmenu)。 */
        async contextOn(path, event = { clientX: 40, clientY: 60 }) {
            const btn = this.noteButton(path);
            assert.ok(btn, `列表里应当有 ${path} 这一行`);
            await btn.fire('contextmenu', event);
            return btn;
        },
        /**
         * 右键列表的**空白处**(列表容器里、任何行之外)。
         *
         * 目标元素给列表本身 —— 真实界面里"最后一行下面那片空白"的目标就是容器/列表,
         * 而不是任何一行。它不在 `button, input, …` 里,所以应当被当成空白。
         */
        async contextOnBlank(event = { clientX: 40, clientY: 60 }) {
            await els.listEl.parentElement.fire('contextmenu', { target: els.listEl, ...event });
            return els.listEl.parentElement;
        },
        /** 右键文件夹那一行。 */
        async contextOnDir(folderPath, event = { clientX: 40, clientY: 60 }) {
            const dirBtn = this.button('note-dir');
            assert.ok(dirBtn, '列表里应当有文件夹行');
            assert.equal(dirBtn.dataset.folder, folderPath);
            const row = els.listEl.children.find(li => (li.children ?? []).includes(dirBtn));
            assert.ok(row, '文件夹按钮应当在它那一行里');
            await row.fire('contextmenu', event);
            return row;
        },
        /** 列表里每一项的"形状" —— 断言树结构用,不依赖内部 DOM 细节。 */
        items() {
            return els.listEl.children.map((li) => {
                const dir = li.children.find(c => c.className === 'note-dir');
                if (dir) {
                    return `dir:${dir.dataset.folder}:${dir.getAttribute('aria-expanded')}`;
                }
                const note = li.children.find(c => c.dataset && c.dataset.path);
                if (note) return `note:${note.dataset.path}@${note.style.props['--depth'] ?? '?'}`;
                return `other:${li.className}`;
            });
        },
        /** 按 class 找一个按钮(树里那些按钮不是 id,只能这样找)。 */
        button(className) {
            for (const li of els.listEl.children) {
                const hit = li.children.find(c => c.className === className);
                if (hit) return hit;
            }
            return null;
        },
        /** 标签面板里所有 chip 的形状(名字 / 计数 / 是否选中 / 是不是「+N」)。 */
        chips() {
            return els.tagPanelEl.children
                .filter(c => c.className === 'tag-chips')
                .flatMap(w => w.children)
                .map((c) => {
                    if (c.className === 'tag-empty') return { empty: c.textContent };
                    const name = c.children.find(x => x.className === 'tag-name');
                    const count = c.children.find(x => x.className === 'tag-count');
                    return {
                        tag: name ? name.textContent.replace(/^#/, '') : null,
                        count: count ? count.textContent : null,
                        pressed: c.getAttribute('aria-pressed') === 'true',
                        more: c.className.includes('tag-more') ? c.textContent : null,
                    };
                });
        },
        /** 标签面板头部的工具按钮。 */
        tagTool(i) {
            const head = els.tagPanelEl.children.find(c => c.className === 'tag-head-row');
            return head ? head.children.filter(c => c.className === 'tag-tool')[i] : null;
        },
        tagPanelHidden: () => els.tagPanelEl.hidden === true,
        filterBar: () => (els.tagFilterBar.hidden
            ? null
            : { name: els.tagFilterName.textContent }),
    };
}

const NOTE = { path: '未命名.md', title: '未命名' };
const FILES = { '未命名.md': '# 未命名\n\n' };

function openDefault() {
    const h = boot({ notes: [NOTE], files: FILES });
    return { h, ready: (async () => { await h.view.setVault(); await h.view.open('未命名.md'); })() };
}

test('打开笔记:标题框显示标题,路径显示文件名', async () => {
    const { h, ready } = openDefault();
    await ready;

    assert.equal(h.els.titleEl.value, '未命名');
    assert.equal(h.els.pathEl.textContent, '未命名.md');
});

test('标题框按回车必须真的落盘 —— 这就是「命名好后无法保存」', async () => {
    const { h, ready } = openDefault();
    await ready;

    h.els.titleEl.value = '第一个笔记';
    await h.els.titleEl.fire('keydown', { key: 'Enter' });

    assert.equal(h.titleCalls().length, 1, '回车必须调 notes:setTitle;修复前这里是 0');
    assert.deepEqual(h.titleCalls()[0][1], { path: '未命名.md', title: '第一个笔记' });
    assert.equal(h.els.pathEl.textContent, '第一个笔记.md', '路径显示要跟着改');
    assert.equal(h.els.titleEl.value, '第一个笔记');
});

test('失焦也提交一次', async () => {
    const { h, ready } = openDefault();
    await ready;

    h.els.titleEl.value = '第一个笔记';
    await h.els.titleEl.fire('blur');

    assert.equal(h.titleCalls().length, 1);
});

test('标题没改就不发请求(点开再点别处不该白写一次盘)', async () => {
    const { h, ready } = openDefault();
    await ready;

    await h.els.titleEl.fire('blur');
    await h.els.titleEl.fire('keydown', { key: 'Enter' });

    assert.equal(h.titleCalls().length, 0);
});

test('标题为空时不发请求,并把输入框还原', async () => {
    const { h, ready } = openDefault();
    await ready;

    h.els.titleEl.value = '   ';
    await h.els.titleEl.fire('keydown', { key: 'Enter' });

    assert.equal(h.titleCalls().length, 0);
    assert.equal(h.els.titleEl.value, '未命名', '不能显示一个没落地的空名字');
});

test('改名失败时还原输入框并说明原因', async () => {
    const h = boot({
        notes: [NOTE], files: FILES, failTitle: '目标已存在:第一个笔记.md',
    });
    await h.view.setVault();
    await h.view.open('未命名.md');

    h.els.titleEl.value = '第一个笔记';
    await h.els.titleEl.fire('keydown', { key: 'Enter' });

    assert.equal(h.els.titleEl.value, '未命名', '失败的改名不能留在界面上');
    assert.match(h.els.statusEl.textContent, /改名失败/);
    assert.match(h.els.statusEl.textContent, /已存在/);
});

test('改名后编辑器显示的是新标题(正文 H1 已在主进程改掉)', async () => {
    const { h, ready } = openDefault();
    await ready;

    h.els.titleEl.value = '第一个笔记';
    await h.els.titleEl.fire('keydown', { key: 'Enter' });

    assert.ok(h.view.editor.value().includes('# 第一个笔记'),
        `编辑器里应当是新标题,实际:${JSON.stringify(h.view.editor.value())}`);
});

test('改名后 currentPath 指向新文件(否则下一次保存会写回旧路径)', async () => {
    const { h, ready } = openDefault();
    await ready;

    h.els.titleEl.value = '第一个笔记';
    await h.els.titleEl.fire('keydown', { key: 'Enter' });

    assert.equal(h.view.currentPath, '第一个笔记.md');
});

test('预览模式下改名失败,不能把保存按钮点亮(预览是只读的)', async () => {
    // 保存按钮的可用态由「有没有改动」和「是不是只读预览」**共同**决定。
    // 改名收尾若只看 dirty,就会在只读预览里点亮一个按了也没用的保存按钮。
    const h = boot({
        notes: [NOTE], files: FILES, failTitle: '目标已存在:第一个笔记.md', failWrite: '磁盘满了',
    });
    await h.view.setVault();
    await h.view.open('未命名.md');

    // 正文改点东西(写盘会失败),再切到只读预览
    h.els.docEl.listeners.click[0]({
        target: { closest: (sel) => (sel === '.blk' ? { dataset: { blk: '1' } } : null) },
    });
    const ta = h.els.docEl.querySelector('textarea.blk-input');
    ta.value = '改了字';
    ta.selectionStart = ta.value.length;
    ta.selectionEnd = ta.value.length;
    h.els.docEl.listeners.input[0]({ target: { closest: () => ta } });
    await h.els.modeBtn.fire('click');
    assert.equal(h.els.saveBtn.disabled, true, '切到预览后保存按钮就该是灰的');

    h.els.titleEl.value = '第一个笔记';
    await h.els.titleEl.fire('keydown', { key: 'Enter' });

    assert.equal(h.els.saveBtn.disabled, true, '只读预览下不该被点亮');
    assert.equal(h.view.editor.getMode(), 'preview');
});

// ---------- 打开笔记即进入编辑 ----------
//
// 用户报的:「单击后直接进入编辑,不需要连点两下」。
// 根因是 open() → editor.load() 会把 activeIndex 置回 -1,render() 之后
// **文档里根本没有 input 元素** —— 所以非点第二下不可。而 createNamed() 结尾调了
// editor.focusFirst(),于是"新建的笔记能直接写、打开的笔记不能",两条路径不一致。

test('打开一篇笔记就直接进入编辑,光标在第一块', async () => {
    const { h, ready } = openDefault();
    await ready;

    const ta = h.els.docEl.querySelector('textarea.blk-input');
    assert.ok(ta, '打开之后文档里就该有一个源码输入框;修复前这里是 null');
    assert.equal(ta.dataset.blk, '0', '落在第一块 —— 与「新建笔记」同一条规则');
});

test('先把编辑器显示出来再聚焦(隐藏祖先里的聚焦会被浏览器静默丢弃)', async () => {
    // 这类"设了、读回来也是对的、就是没生效"的静默失败,本项目已经踩过好几次(A6/A9)。
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    assert.equal(h.els.editorEl.hidden, true, '进库时编辑器应当是藏起来的');

    let hiddenAtFocus = null;
    const real = h.view.editor.focusFirst.bind(h.view.editor);
    h.view.editor.focusFirst = () => { hiddenAtFocus = h.els.editorEl.hidden; real(); };

    await h.view.open('未命名.md');

    assert.equal(hiddenAtFocus, false, '必须先把编辑器显示出来,聚焦才真的落得下去');
});

test('正文有未保存改动时先落盘再改名', async () => {
    const { h, ready } = openDefault();
    await ready;

    // 点第 2 块(那个空行)让它成为源码块,再改它的内容 —— 走的是真实输入路径
    h.els.docEl.listeners.click[0]({
        target: { closest: (sel) => (sel === '.blk' ? { dataset: { blk: '1' } } : null) },
    });
    const ta = h.els.docEl.querySelector('textarea.blk-input');
    assert.ok(ta, '点过之后应当有一个处于源码态的块');
    ta.value = '改了字';
    ta.selectionStart = ta.value.length;
    ta.selectionEnd = ta.value.length;
    h.els.docEl.listeners.input[0]({ target: { closest: () => ta } });
    assert.equal(h.view.hasUnsaved(), true, '正文应当已被标记为有改动');

    h.els.titleEl.value = '第一个笔记';
    await h.els.titleEl.fire('keydown', { key: 'Enter' });

    const write = h.calls.find(c => c[0] === 'notes:write');
    assert.ok(write, '改名之前必须先把正文写盘,否则那点改动会留在已经不存在的老路径上');
    assert.equal(write[1].path, '未命名.md');
    assert.ok(write[1].text.includes('改了字'));
});

// ---------- 树状目录 + 新建文件夹 ----------
//
// 用户要的是:侧栏按树显示,并且能新建文件夹。两个坑必须在用例里钉住:
//   ① **空文件夹**在笔记清单里根本不出现 —— 不把它列出来,用户刚建的文件夹
//      "看不见",看着就像没建成;
//   ② 树里点文件夹是**收起/展开**,不是打开某篇笔记(点错一次就会把当前编辑
//      的笔记切走)。

const TREE_NOTES = [
    { path: '甲.md', title: '甲', tags: [] },
    { path: '阅读/读书笔记.md', title: '读书笔记', tags: [] },
    { path: '阅读/2026/一月.md', title: '一月', tags: [] },
];

test('列表按树渲染:文件夹在上、里面的笔记缩进一级', async () => {
    const h = boot({ notes: TREE_NOTES, folders: ['阅读', '阅读/2026'] });
    await h.view.setVault();

    assert.deepEqual(h.items(), [
        'dir:阅读:true',
        'dir:阅读/2026:true',
        'note:阅读/2026/一月.md@2',
        'note:阅读/读书笔记.md@1',
        'note:甲.md@0',
    ], '目录在前、笔记在后;深度按层级递增(缩进就是靠它)');
});

test('点文件夹是收起/展开,不是打开笔记', async () => {
    const h = boot({ notes: TREE_NOTES, folders: ['阅读', '阅读/2026'] });
    await h.view.setVault();
    const before = h.view.currentPath;

    await h.button('note-dir').fire('click');
    assert.deepEqual(h.items(), ['dir:阅读:false', 'note:甲.md@0'],
        '收起之后里面的笔记(含子目录)都藏起来');
    assert.equal(h.view.currentPath, before, '点文件夹不许把当前笔记换掉');

    await h.button('note-dir').fire('click');
    assert.equal(h.items().length, 5, '再点一次要能展开回来');
});

test('空文件夹也要出现在列表里(否则"刚建的看不见")', async () => {
    const h = boot({ notes: [{ path: '甲.md', title: '甲', tags: [] }], folders: ['空目录'] });
    await h.view.setVault();
    assert.ok(h.items().includes('dir:空目录:true'), `实际=${JSON.stringify(h.items())}`);
});

test('「新建文件夹」:内联输入行 → 回车 → 调 notes:mkdir,并出现在树里', async () => {
    const h = boot({ notes: [{ path: '甲.md', title: '甲', tags: [] }] });
    await h.view.setVault();

    await h.els.newFolderBtn.fire('click');
    const row = h.els.listEl.children.find(li => li.className === 'note-new-row');
    assert.ok(row, '点了「新建文件夹」应当出现内联输入行(不用原生对话框)');

    const input = row.children[0];
    input.value = '项目';
    await input.fire('keydown', { key: 'Enter' });

    assert.deepEqual(h.mkdirCalls().map(c => c[1]), [{ path: '项目' }]);
    assert.ok(h.items().includes('dir:项目:true'),
        `新建的(空)文件夹必须出现在列表里,实际=${JSON.stringify(h.items())}`);
    assert.match(h.els.statusEl.textContent, /已新建文件夹/);
});

test('新建文件夹:Esc 与空名都不发请求', async () => {
    const h = boot({ notes: [{ path: '甲.md', title: '甲', tags: [] }] });
    await h.view.setVault();

    await h.els.newFolderBtn.fire('click');
    let row = h.els.listEl.children.find(li => li.className === 'note-new-row');
    row.children[0].value = '不要这个';
    await row.children[0].fire('keydown', { key: 'Escape' });
    assert.equal(h.mkdirCalls().length, 0, 'Esc = 反悔,不许建');
    assert.equal(h.els.listEl.children.some(li => li.className === 'note-new-row'), false,
        '取消后输入行要收起来');

    await h.els.newFolderBtn.fire('click');
    row = h.els.listEl.children.find(li => li.className === 'note-new-row');
    row.children[0].value = '   ';
    await row.children[0].fire('keydown', { key: 'Enter' });
    assert.equal(h.mkdirCalls().length, 0, '空名不许建');
});

test('新建文件夹失败时把原因说出来,并收起输入行', async () => {
    const h = boot({ notes: [{ path: '甲.md', title: '甲', tags: [] }], failMkdir: '文件夹已存在:项目' });
    await h.view.setVault();

    await h.els.newFolderBtn.fire('click');
    const row = h.els.listEl.children.find(li => li.className === 'note-new-row');
    row.children[0].value = '项目';
    await row.children[0].fire('keydown', { key: 'Enter' });

    assert.equal(h.mkdirCalls().length, 1);
    assert.match(h.els.statusEl.textContent, /新建文件夹失败/);
    assert.match(h.els.statusEl.textContent, /已存在/);
});

test('在文件夹里新建笔记:路径带上目录前缀(否则文件夹永远装不进东西)', async () => {
    const h = boot({ notes: TREE_NOTES, folders: ['阅读', '阅读/2026'] });
    await h.view.setVault();

    await h.button('note-dir-add').fire('click');
    assert.deepEqual(h.createCalls().map(c => c[1].path), ['阅读/未命名.md']);
});

test('搜索时拍平:不再显示文件夹行,匹配到的笔记带出完整路径', async () => {
    const h = boot({ notes: TREE_NOTES, folders: ['阅读', '阅读/2026'] });
    await h.view.setVault();

    h.els.searchEl.value = '读书';
    await h.els.searchEl.fire('input');

    const items = h.items();
    assert.equal(items.some(x => x.startsWith('dir:')), false,
        '筛选时树会让命中的东西藏在收起的文件夹里,所以拍平显示');
    assert.deepEqual(items, ['note:阅读/读书笔记.md@0']);
    const sub = h.els.listEl.children[0].children[0].children
        .find(c => c.className === 'note-sub');
    assert.equal(sub?.textContent, '阅读/读书笔记.md', '拍平后要能看出它在哪一层');
});

// ---------- 标签面板(方案 4:工具条 + 前 6 个 + 「+N」)----------
//
// 改这一块的起因是"标签越多、侧栏越高":实测 9 个标签 138px、30 个标签 346px,
// 笔记列表被一路挤上去。新方案的契约是:**高度与标签数量无关**,
// 并且"列表为什么变短了"必须在列表顶部看得见(而不是只藏在 chip 的浅色底上)。

const TAG_NOTES = [
    { path: 'a.md', title: 'a', tags: ['设计'] },
    { path: 'b.md', title: 'b', tags: ['开物'] },
];
const TAGS = [
    { tag: '随手记', count: 1 }, { tag: '设计', count: 5 }, { tag: '开物', count: 3 },
    { tag: '安全', count: 2 }, { tag: '笔记', count: 1 }, { tag: '待办', count: 1 },
    { tag: '读书', count: 4 }, { tag: '概念', count: 1 },
];

test('标签默认按数量降序,只显示前 6 个,其余折进「+N」', async () => {
    const h = boot({ notes: TAG_NOTES, tags: TAGS });
    await h.view.setVault();

    const chips = h.chips();
    assert.equal(chips.length, 7, '6 个标签 + 1 个「+N」');
    assert.deepEqual(chips.slice(0, 6).map(c => c.tag),
        ['设计', '读书', '开物', '安全', '笔记', '待办'],
        '按数量降序;同数量的按名字排(顺序不能每次刷新都跳)');
    assert.equal(chips[6].more, '+2', '剩下 2 个折进「+N」');
    assert.equal(chips[0].count, '5', '计数是**单独的**一段(名字与数字不再糊在一起)');
});

test('点「+N」展开全部,再点「收起」回到 6 个', async () => {
    const h = boot({ notes: TAG_NOTES, tags: TAGS });
    await h.view.setVault();

    await h.chips().at(-1).more === undefined ? null : null;
    const moreBtn = h.els.tagPanelEl.children.find(c => c.className === 'tag-chips').children.at(-1);
    await moreBtn.fire('click');
    assert.equal(h.chips().length, 9, '展开后是 8 个标签 + 1 个「收起」');

    const collapseBtn = h.els.tagPanelEl.children.find(c => c.className === 'tag-chips').children.at(-1);
    await collapseBtn.fire('click');
    assert.equal(h.chips().length, 7, '回到 6 个 + 「+2」');
});

test('排序可切:按名称排序后顺序变', async () => {
    const h = boot({ notes: TAG_NOTES, tags: TAGS });
    await h.view.setVault();

    await h.tagTool(1).fire('click');           // 0=过滤 1=排序 2=收起
    // 先对**全部**标签按名字排序,再取前 6 个(不是"取前 6 个再排序")
    const byName = [...TAGS].map(t => t.tag).sort((a, b) => a.localeCompare(b, 'zh')).slice(0, 6);
    assert.deepEqual(h.chips().slice(0, 6).map(c => c.tag), byName, '按名称排序');
});

test('收起标签栏:只剩头部一行,再点恢复', async () => {
    const h = boot({ notes: TAG_NOTES, tags: TAGS });
    await h.view.setVault();

    await h.tagTool(2).fire('click');
    assert.deepEqual(h.chips(), [], '收起后一个 chip 都不渲染 —— 高度只占头部那一行');
    assert.ok(h.tagTool(0) !== null, '头部三个工具按钮还在');

    await h.tagTool(2).fire('click');
    assert.equal(h.chips().length, 7, '再点一次恢复');
});

test('点标签:列表变筛选态,并且列表顶部出现「筛选中:#… ×」', async () => {
    const h = boot({ notes: TAG_NOTES, tags: TAGS });
    await h.view.setVault();

    const chip = h.els.tagPanelEl.children.find(c => c.className === 'tag-chips').children[0];
    await chip.fire('click');

    assert.equal(h.chips()[0].pressed, true, '被选中的 chip 要有选中态');
    assert.deepEqual(h.filterBar(), { name: '#设计' },
        '列表顶部必须能看出"现在筛的是哪个标签"');
    assert.deepEqual(h.items(), ['note:a.md@0'], '筛选后列表拍平,只留命中的');

    await h.els.tagFilterClear.fire('click');
    assert.equal(h.filterBar(), null, '点 × 之后提示条收起来');
    assert.equal(h.chips().some(c => c.pressed), false, 'chip 的选中态也要跟着清掉');
    assert.equal(h.items().length, 2, '列表恢复');
});

test('再点同一个标签 = 取消筛选', async () => {
    const h = boot({ notes: TAG_NOTES, tags: TAGS });
    await h.view.setVault();
    const chipsEl = () => h.els.tagPanelEl.children.find(c => c.className === 'tag-chips');
    await chipsEl().children[0].fire('click');
    await chipsEl().children[0].fire('click');
    assert.equal(h.filterBar(), null);
});

test('标签过滤输入:只留匹配的,Esc 收起并清空', async () => {
    const h = boot({ notes: TAG_NOTES, tags: TAGS });
    await h.view.setVault();

    await h.tagTool(0).fire('click');            // 打开过滤输入
    const row = h.els.tagPanelEl.children.find(c => c.className === 'tag-filter-row');
    assert.ok(row, '点「⌕」出现标签自己的过滤输入(与笔记搜索不是同一个)');
    const input = row.children[0];
    input.value = '读书';
    await input.fire('input');
    assert.deepEqual(h.chips().map(c => c.tag), ['读书']);

    await input.fire('keydown', { key: 'Escape' });
    assert.equal(h.els.tagPanelEl.children.some(c => c.className === 'tag-filter-row'), false,
        'Esc 收起输入');
    assert.equal(h.chips().length, 7, '过滤词也一起清掉,回到 6 +「+2」');
});

test('标签名里的标记原样当文本(不解析成 HTML)', async () => {
    const h = boot({ notes: TAG_NOTES, tags: [{ tag: '<img src=x onerror=alert(1)>', count: 1 }] });
    await h.view.setVault();
    const name = h.chips()[0].tag;
    assert.equal(name, '<img src=x onerror=alert(1)>', '原样保留');
    assert.equal(typeof name, 'string', '它必须是一个字符串,而不是被解析出来的元素');
});

test('一个标签都没有时整块收起来(不留一条空面板的边框)', async () => {
    const h = boot({ notes: TAG_NOTES, tags: [] });
    await h.view.setVault();
    assert.equal(h.tagPanelHidden(), true);
});

// ---------- 右键菜单 → 行内重命名 ----------
//
// 产品要的:「笔记目录右键菜单栏可重命名笔记」。
// 后端能力本来就有(notes:rename:只收 .md、目标已存在会抛错、纯大小写改名走两步),
// 所以这一节钉的是**渲染层那半边**:
//   · 右键出的是渲染层浮层(与工作台标签条同一套),不是主进程的原生 Menu;
//   · 菜单能键盘操作(焦点进得去、Esc 出得来);
//   · 行内输入的预填值是**不含 .md 的主名**,提交时才拼回扩展名;
//   · 失败(最典型是"目标已存在")必须说到用户看得见的地方,并把行恢复成原名。

/** 右键 → 点「重命名」,返回那个行内输入框。 */
async function toRenameInput(h, path) {
    await h.contextOn(path);
    await h.menuItems()[0].fire('click');
    return h.renameInput();
}

/** 把 document / window 上注册的监听器都跑一遍(两条关闭规则绑在它们身上)。 */
function fireGlobal(host, type, event) {
    for (const f of globalThis[host].listeners[type] ?? []) f(event);
}

test('右键笔记项弹出浮层菜单,里面有「重命名」与「删除笔记」', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    await h.contextOn('未命名.md');

    const menu = h.menu();
    assert.ok(menu, '右键应当出现浮层菜单(渲染层的,不是主进程的原生 Menu)');
    assert.equal(menu.getAttribute('role'), 'menu');
    const items = h.menuItems();
    assert.deepEqual(items.map(b => b.textContent), ['重命名', '删除笔记'],
        '两项都是这个菜单自己的动作:改名(既有)与删除(产品原话「右击添加删除笔记选项」)');
    assert.equal(items[0].getAttribute('role'), 'menuitem');
    assert.equal(items[0].dataset.menuRole, 'rename');
    // 删除那一项也要能被单独找到(真窗口/自检按 data-menu-role 点它)
    assert.equal(items[1].dataset.menuRole, 'delete-note');
    assert.equal(items[1].dataset.menuDanger, undefined,
        '还没点,就不该是告警态');
    // 浮层挂在列表的**父级**上:列表是"索引一变就整段重画",挂进列表会被下一次重画吃掉
    assert.equal(h.els.listEl.children.some(c => c.className === 'note-menu'), false,
        '浮层不能是列表里的一项');
});

test('菜单打开就把焦点放进去;Esc 关掉并把焦点还给那一行', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    const btn = await h.contextOn('未命名.md');

    const item = h.menuItems()[0];
    assert.ok(item.focused >= 1, '打开就该聚焦在第一个菜单项上(键盘用户不用先想办法走进去)');

    await h.menu().fire('keydown', { key: 'Escape', target: item });
    assert.equal(h.menu(), null, 'Esc 关掉浮层');
    assert.ok(btn.focused >= 1, '焦点要还给那一行,否则键盘用户会掉回文档开头');
});

test('浮层关闭:点外面关掉,点里面不算', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();

    await h.contextOn('未命名.md');
    const outside = new El('div');
    fireGlobal('document', 'pointerdown', { target: outside });
    assert.equal(h.menu(), null, '点空白(浮层外)应当关掉菜单');

    await h.contextOn('未命名.md');
    fireGlobal('document', 'pointerdown', { target: h.menuItems()[0] });
    assert.ok(h.menu(),
        '点在浮层内部**不算**点空白 —— 关早了,菜单项自己的 click 就永远发不出来'
        + '(工作台的浮层踩过同一个坑)');

    // 列表一滚,浮层与那一行就脱开了:必须关掉,而不是悬在原地指着一行别的笔记
    fireGlobal('window', 'scroll', {});
    assert.equal(h.menu(), null, '滚动时关掉浮层');
});

test('点「重命名」:那一行变成输入框,预填不含 .md 的主名', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    assert.equal(h.menu(), null, '点了菜单项,浮层要收起来');
    assert.ok(input, '这一行应当变成一个行内输入框');
    assert.equal(input.value, '未命名', '预填的是主名,不带 .md');
    assert.match(String(input.getAttribute('aria-label')), /重命名笔记/,
        '没有可见文本的输入框,aria-label 是必需的');
    assert.equal(input.style.props['--depth'], '0', '缩进与它原来那一行一致');
    assert.ok(input.focused >= 1, '进入改名态就聚焦在输入框里');
    assert.ok(input.selected >= 1, '预填内容全选:改名最常见的动作是整个换掉');
    assert.equal(h.noteButton('未命名.md'), null, '输入框替掉了原来的按钮');
});

test('Enter 提交:调 notes:rename,from/to 都是带 .md 的完整相对路径,列表跟着刷新', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = '第一课';
    await input.fire('keydown', { key: 'Enter' });

    assert.deepEqual(h.renameCalls().map(c => c[1]), [{ from: '未命名.md', to: '第一课.md' }],
        'IPC 只传两个叶子字段,扩展名在这里拼回去');
    assert.equal(h.renameInput(), null, '提交后回到普通行');
    assert.ok(h.items().includes('note:第一课.md@0'),
        `列表要刷成新路径,实际=${JSON.stringify(h.items())}`);
    assert.match(h.els.statusEl.textContent, /已重命名为/);
});

test('用户自带 .md 就剥掉再拼回(别拼成「第一课.md.md」)', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = '第一课.md';
    await input.fire('keydown', { key: 'Enter' });

    assert.deepEqual(h.renameCalls().map(c => c[1]), [{ from: '未命名.md', to: '第一课.md' }],
        '可编辑部分定义成"不含扩展名的主名",用户多打一遍不该变成另一个文件');
});

test('失焦**按提交**处理(与「新建文件夹」「顶栏标题」同一条规则)', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = '第一课';
    await input.fire('blur');

    assert.deepEqual(h.renameCalls().map(c => c[1]), [{ from: '未命名.md', to: '第一课.md' }],
        '同一个面板里同样的手势必须给同样的结果:另外两处内联编辑都是失焦提交');
});

test('Esc 不调 IPC,行恢复原名;之后的失焦也不许再提交一次', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = '不要这个';
    await input.fire('keydown', { key: 'Escape' });
    assert.equal(h.renameCalls().length, 0, 'Esc = 反悔,一个字都不许发出去');
    assert.equal(h.renameInput(), null, '输入框收起来');
    assert.ok(h.noteButton('未命名.md'), '行要回到原来的样子');
    assert.equal(h.items().filter(x => x.startsWith('note:')).length, 1, '列表里还是原来那一项');

    await input.fire('blur');        // 真实的浏览器里,节点被移除也会走一次失焦
    assert.equal(h.renameCalls().length, 0, 'Esc 之后的失焦不许把取消变成提交');
});

test('空名 / 只有空白 / 与原名完全相同 → 一律不调 IPC,直接恢复原样', async () => {
    for (const value of ['', '   ', '未命名', ' 未命名 ']) {
        const h = boot({ notes: [NOTE], files: FILES });
        await h.view.setVault();
        const input = await toRenameInput(h, '未命名.md');

        input.value = value;
        await input.fire('keydown', { key: 'Enter' });

        assert.equal(h.renameCalls().length, 0, `${JSON.stringify(value)} 不该发请求`);
        assert.equal(h.renameInput(), null);
        assert.ok(h.noteButton('未命名.md'), `${JSON.stringify(value)} 之后行要恢复原样`);
    }
});

test('名字里有路径分隔符:明确拒绝并提示,不静默变成"移动"', async () => {
    for (const value of ['子目录/新名', '子目录\\新名']) {
        const h = boot({ notes: [NOTE], files: FILES });
        await h.view.setVault();
        const input = await toRenameInput(h, '未命名.md');

        input.value = value;
        await input.fire('keydown', { key: 'Enter' });

        assert.equal(h.renameCalls().length, 0, `${value} 不该发请求`);
        assert.match(h.els.statusEl.textContent, /分隔符/, '要说清楚为什么不行');
        assert.equal(h.renameInput(), null, '拒绝之后行恢复原样');
        assert.ok(h.noteButton('未命名.md'), '笔记还在原来的位置(没有被当成移动)');
    }
});

test('名字里有非法字符:拒绝并提示(而不是悄悄把字符删掉再照做)', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = 'a?b';
    await input.fire('keydown', { key: 'Enter' });

    assert.equal(h.renameCalls().length, 0);
    assert.match(h.els.statusEl.textContent, /不能有/);
    assert.ok(h.noteButton('未命名.md'));
});

test('目标已存在:把主进程的报错显示出来,并把行恢复成原名', async () => {
    const h = boot({
        notes: [NOTE, { path: '已存在.md', title: '已存在' }],
        files: { ...FILES, '已存在.md': '# 已存在\n' },
    });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = '已存在';
    await input.fire('keydown', { key: 'Enter' });

    assert.equal(h.renameCalls().length, 1);
    assert.match(h.els.statusEl.textContent, /重命名失败/);
    assert.match(h.els.statusEl.textContent, /已存在/, '用户必须看得见失败的原因');
    assert.ok(h.noteButton('未命名.md'), '失败了就不是改名,行要回到原名');
    assert.equal(h.renameInput(), null);
    assert.ok(h.items().includes('note:已存在.md@0'), '目标那篇一个字都不该动');
});

test('主进程抛别的错(例如不是 .md)也要说出来,并且行恢复原名', async () => {
    const h = boot({ notes: [NOTE], files: FILES, failRename: '只允许重命名 .md 笔记' });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = '随便';
    await input.fire('keydown', { key: 'Enter' });

    assert.match(h.els.statusEl.textContent, /只允许重命名 \.md 笔记/);
    assert.ok(h.noteButton('未命名.md'), '界面不能显示一个并没有落地的名字');
});

test('改的是正打开着的那篇:currentPath 与路径显示都要跟着走', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    await h.view.open('未命名.md');

    const input = await toRenameInput(h, '未命名.md');
    input.value = '第一课';
    await input.fire('keydown', { key: 'Enter' });

    assert.equal(h.view.currentPath, '第一课.md',
        '不跟着走的话,下一次自动保存会往一个已经不存在的老路径写(内容就丢了)');
    assert.equal(h.els.pathEl.textContent, '第一课.md');
    assert.equal(h.state.files['第一课.md'], '# 未命名\n\n', 'rename 只搬文件,正文一个字节都不动');
    assert.equal(h.openedNotes().at(-1), '第一课.md', '标签条上那一格记的是路径,得通知外壳');
});

test('子目录里的笔记:只换最后一段,目录不动(重命名不是移动)', async () => {
    const h = boot({
        notes: [{ path: '阅读/读书笔记.md', title: '读书笔记', tags: [] }],
        folders: ['阅读'],
        files: { '阅读/读书笔记.md': '# 读书笔记\n' },
    });
    await h.view.setVault();
    const input = await toRenameInput(h, '阅读/读书笔记.md');

    input.value = '新名字';
    await input.fire('keydown', { key: 'Enter' });

    assert.deepEqual(h.renameCalls().map(c => c[1]),
        [{ from: '阅读/读书笔记.md', to: '阅读/新名字.md' }], '目录前缀必须原样带回去');
    assert.ok(h.items().includes('note:阅读/新名字.md@1'),
        `还在同一个目录、同一个层级,实际=${JSON.stringify(h.items())}`);
});

test('筛选(拍平)态下也能右键重命名,目录前缀一样不许丢', async () => {
    const h = boot({
        notes: [{ path: '阅读/读书笔记.md', title: '读书笔记', tags: [] }],
        folders: ['阅读'],
        files: { '阅读/读书笔记.md': '# 读书笔记\n' },
    });
    await h.view.setVault();
    h.els.searchEl.value = '读书';
    await h.els.searchEl.fire('input');
    assert.ok(h.items().includes('note:阅读/读书笔记.md@0'), '筛选时是拍平显示');

    const input = await toRenameInput(h, '阅读/读书笔记.md');
    input.value = '新名字';
    await input.fire('keydown', { key: 'Enter' });

    assert.deepEqual(h.renameCalls().map(c => c[1]),
        [{ from: '阅读/读书笔记.md', to: '阅读/新名字.md' }]);
});

test('纯大小写改名照常发出去(在"有没有改"的判断里它不是"没改")', async () => {
    const h = boot({ notes: [{ path: 'abc.md', title: 'abc' }], files: { 'abc.md': '# abc\n' } });
    await h.view.setVault();
    const input = await toRenameInput(h, 'abc.md');
    assert.equal(input.value, 'abc');

    input.value = 'ABC';
    await input.fire('keydown', { key: 'Enter' });

    assert.deepEqual(h.renameCalls().map(c => c[1]), [{ from: 'abc.md', to: 'ABC.md' }],
        '主进程会走"先临时名再目标名"两步,渲染层不该把它当成"没改"挡掉');
    assert.ok(h.items().includes('note:ABC.md@0'), `实际=${JSON.stringify(h.items())}`);
});

test('改名途中列表被重画(自动保存收尾会刷新索引)也不吃掉已经打的字', async () => {
    // 编辑器自动保存 → refreshIndex → renderList:整段重画会把输入框重建。
    // 重建时若不认草稿,用户刚敲进去的名字就会被"预填的主名"悄悄盖回去 ——
    // 而这种静默回退在界面上看不出来(他还以为名字已经打好了)。
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = '第一课';
    await input.fire('input');                 // 用户真的在打字
    await h.view.refreshIndex();               // 自动保存收尾走的就是这条

    const again = h.renameInput();
    assert.ok(again, '改名态要活过这次重画(输入框还在)');
    assert.equal(again.value, '第一课', '已经打的字不能被吃掉');
    assert.ok(again.focused >= 1, '重画后焦点要回到输入框');
    assert.equal(again.selected ?? 0, 0,
        '重画之后不该再全选一次 —— 那会让下一个按键把刚打的字整段替换掉');

    await again.fire('keydown', { key: 'Enter' });
    assert.deepEqual(h.renameCalls().map(c => c[1]), [{ from: '未命名.md', to: '第一课.md' }],
        '重画之后提交的仍然是用户打的那个名字');
});

test('重画把输入框摘掉那一下的失焦不算"用户点到别处",半截名字绝不许发出去', async () => {
    // 真窗口实测踩到的缺陷:重画(innerHTML 重写)会把正聚焦的输入框从文档里摘走,
    // 浏览器照样派发一次 blur。若照"失焦=提交"处理,编辑器一次自动保存就会把
    // 用户刚打了一半的名字当成新名字落到磁盘上(实测:只打「隔」就落成了 隔.md)。
    const h = boot({
        notes: [NOTE, { path: '别的.md', title: '别的' }],
        files: { ...FILES, '别的.md': '# 别的\n' },
    });
    await h.view.setVault();
    const input = await toRenameInput(h, '未命名.md');

    input.value = '隔';
    await input.fire('input');
    await h.view.refreshIndex();               // 重画:这一步会创建新输入框、把旧的换掉
    // 真窗口实测:blur 跑起来时那个输入框**还是 isConnected 的**(派发时机不保证在断开之后),
    // 所以这里把兜底判据人为置回 true —— 只留"元素身份"这一条,它必须自己拦得住。
    input.isConnected = true;
    await input.fire('blur');                  // 被换掉那一下浏览器派的 blur

    assert.equal(h.renameCalls().length, 0, '半截名字绝不能变成一次改名');
    const again = h.renameInput();
    assert.ok(again, '改名态与草稿都要留着,让用户把名字打完');
    assert.equal(again.value, '隔');

    // 而**用户点到别处**那种失焦仍然是提交(输入框还在文档里)
    again.value = '第一课';
    await again.fire('blur');
    assert.deepEqual(h.renameCalls().map(c => c[1]), [{ from: '未命名.md', to: '第一课.md' }]);
});

// ---------- 笔记行右键 → 删除笔记(两步确认 + 系统回收站) ----------
//
// 产品原话:「右击添加删除笔记选项」。这一节钉的是**渲染层那半边**:
//   · 菜单里多了一项「删除笔记」,而且第一次点**不发任何 IPC** ——
//     删的是真实资产,一次误点不该生效,所以要有第二次明确手势;
//   · 第二次点才真的调 notes:remove,只递**库内相对路径**一个叶子字段;
//   · 确认态会被 Esc / 超时还原(悬在那里越久越容易被"接着点"点掉);
//   · 删的正是当前打开那篇时:脏 → 拒绝并说原因;干净 → 先切走再删;
//   · 失败要把原因说出来(用这个文件既有的状态行)。

/** 点「删除笔记」那一项(返回第一次点击的结果)。 */
async function toDeleteConfirm(h, path) {
    await h.contextOn(path);
    const item = h.deleteItem();
    assert.ok(item, '菜单里应当有「删除笔记」这一项');
    await item.fire('click');
    return item;
}

test('点第一次「删除笔记」:只变成确认态,**一个 IPC 都不发**', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();

    const item = await toDeleteConfirm(h, '未命名.md');

    assert.equal(h.removeCalls().length, 0, '第一次点击绝不能真的删 —— 那是"一键即删"');
    assert.equal(item.textContent, '再点一次确认删除', '文案要明确说出"再点一次"');
    assert.equal(item.dataset.menuDanger, 'true', '确认态必须有告警色(由 CSS 按这个属性给)');
    assert.equal(item.className, 'note-menu-item',
        '不能另加 class:加了这一项就从 .note-menu-item 那套选择器里掉出去了');
    assert.ok(h.menu(), '确认态**不关菜单** —— 第二次点击要落在同一项上');
});

test('点第二次才真的删:只递相对路径,并刷新列表', async () => {
    const h = boot({ notes: [NOTE, { path: '别的.md', title: '别的' }], files: { ...FILES, '别的.md': '# 别的\n' } });
    await h.view.setVault();

    const item = await toDeleteConfirm(h, '未命名.md');
    await item.fire('click');

    assert.deepEqual(h.removeCalls().map(c => c[1]), [{ path: '未命名.md' }],
        'IPC 只递库内相对路径这一个叶子字段(不该有第二个路径:.bak 由主进程自己算)');
    assert.equal(h.menu(), null, '删完浮层要收起来');
    assert.equal(h.state.notes.some(n => n.path === '未命名.md'), false, '被删的那篇从列表消失');
    assert.match(String(h.els.statusEl.textContent), /回收站/,
        '成功也要说话,而且要说清"进了回收站"(可还原)而不是永久删');
});

test('确认态被 Esc 还原:那一项回到「删除笔记」,而且不会删', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();

    const item = await toDeleteConfirm(h, '未命名.md');
    await h.menu().fire('keydown', { key: 'Escape', target: item });

    assert.equal(h.menu(), null, 'Esc 关掉浮层');
    assert.equal(h.removeCalls().length, 0, 'Esc 是明确的反悔手势:一篇都不许删');
    // 再右键一次:文案必须是干净的「删除笔记」,不能留着上一次的确认态
    await h.contextOn('未命名.md');
    assert.equal(h.deleteItem().textContent, '删除笔记', '新开的菜单不该继承上一次的确认态');
});

test('确认态超时自动还原(菜单还开着,但那一项自己退回去)', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();

    const item = await toDeleteConfirm(h, '未命名.md');
    await new Promise(resolve => setTimeout(resolve, 80));   // boot 把确认时长设成 25ms

    assert.equal(item.textContent, '删除笔记', '悬太久就不该还停在"再点一次"上');
    assert.equal(item.dataset.menuDanger, undefined, '告警色也要跟着退掉');
    assert.equal(h.removeCalls().length, 0, '还原不是删除');
    // 还原之后再点一次只会**重新**进入确认态(不是"接着上次的第二次")
    await item.fire('click');
    assert.equal(item.textContent, '再点一次确认删除');
    assert.equal(h.removeCalls().length, 0, '还原后的第一次点击同样不许删');
});

test('删除失败:把主进程的原因显示出来,并且笔记还在列表里', async () => {
    const h = boot({ notes: [NOTE], files: FILES, failRemove: '拒绝访问' });
    await h.view.setVault();

    const item = await toDeleteConfirm(h, '未命名.md');
    await item.fire('click');

    assert.match(String(h.els.statusEl.textContent), /删除失败/,
        '失败不能静默 —— 用这个文件既有的状态行');
    assert.match(String(h.els.statusEl.textContent), /拒绝访问/, '原样带出主进程给的原因');
    assert.equal(h.els.statusEl.dataset.state, 'error', '与其它错误同一条状态行口径');
    assert.equal(h.state.notes.some(n => n.path === '未命名.md'), true, '没删成,列表就不能少一条');
});

/**
 * 把当前打开的正文改成"有未保存改动"。
 *
 * 走的必须是**真实输入路径**(点一块让它变成源码态 → 改值 → 派发 input),
 * 与既有那条「正文有未保存改动时先落盘再改名」用例同一套手法 ——
 * 直接去改 editor 内部的 dirty 标志就等于把这条链路绕过去了,而那正是要验的东西。
 */
function makeDirty(h) {
    h.els.docEl.listeners.click[0]({
        target: { closest: (sel) => (sel === '.blk' ? { dataset: { blk: '1' } } : null) },
    });
    const ta = h.els.docEl.querySelector('textarea.blk-input');
    assert.ok(ta, '点过之后应当有一个处于源码态的块');
    ta.value = '改了字';
    ta.selectionStart = ta.value.length;
    ta.selectionEnd = ta.value.length;
    h.els.docEl.listeners.input[0]({ target: { closest: () => ta } });
}

test('删的正是当前打开那篇、而且有未保存改动 → 拒绝并说清原因', async () => {
    const { h, ready } = openDefault();
    await ready;

    makeDirty(h);
    assert.equal(h.view.hasUnsaved(), true, '前置条件:当前这篇必须是脏的');

    const item = await toDeleteConfirm(h, '未命名.md');
    await item.fire('click');

    assert.equal(h.removeCalls().length, 0, '脏的那一篇绝不许删 —— 那会把正在编辑的东西抽走');
    assert.match(String(h.els.statusEl.textContent), /未保存/);
    assert.equal(h.els.statusEl.dataset.state, 'error', '与其它错误同一条状态行口径');
    assert.equal(h.view.currentPath, '未命名.md', '拒绝之后编辑器还指着那一篇');
    assert.equal(h.state.notes.some(n => n.path === '未命名.md'), true, '文件当然还在');
});

test('删的是当前打开那篇且**干净**:先切走编辑器,再调删除通道', async () => {
    const { h, ready } = openDefault();
    await ready;
    assert.equal(h.view.hasUnsaved(), false, '前置条件:干净');

    const item = await toDeleteConfirm(h, '未命名.md');
    await item.fire('click');

    assert.deepEqual(h.removeCalls().map(c => c[1]), [{ path: '未命名.md' }]);
    assert.equal(h.view.currentPath, null,
        '删完编辑器不能再指着那个路径 —— 否则下一次保存会把文件重新建出来');
    assert.equal(h.els.editorEl.hidden, true, '编辑器要切走(先切走再删,顺序有理由)');
    assert.equal(h.els.pathEl.textContent, '', '顶栏路径也要清掉');
    assert.equal(h.view.hasUnsaved(), false, '切走之后不该还留着脏标记');
});

test('删的是**别的**那一篇:当前打开那篇一动都不动', async () => {
    const h = boot({
        notes: [NOTE, { path: '别的.md', title: '别的' }],
        files: { ...FILES, '别的.md': '# 别的\n' },
    });
    await h.view.setVault();
    await h.view.open('未命名.md');

    const item = await toDeleteConfirm(h, '别的.md');
    await item.fire('click');

    assert.deepEqual(h.removeCalls().map(c => c[1]), [{ path: '别的.md' }]);
    assert.equal(h.view.currentPath, '未命名.md', '删别人不该把我正在编辑的那篇切走');
    assert.equal(h.els.editorEl.hidden, false, '编辑器要还在');
    assert.equal(h.els.pathEl.textContent, '未命名.md');
});

// ---------- 列表空白处 → 右键菜单 → 新建笔记 ----------
//
// 产品原话:「右击空白处可以在菜单栏中新建笔记」。
// 后端一个新能力都不需要(notes:create / notes:mkdir 都在),所以这一节钉的全是
// **渲染层那半边**,而且是三件事:
//   · 命中范围:列表容器里、任何行之外(空列表也算);行上右键仍然归那一行自己;
//   · 复用:菜单浮层只有**一份**(kind 不同),动作也各只有**一个**既有入口 ——
//     「新建笔记」= 搜索框旁边那枚 ＋,「新建文件夹」= 顶栏那枚文件夹按钮,
//     不在这里造第二套"新笔记落到哪 / 名字怎么起"的规则;
//   · 键盘与关闭:与笔记行那份菜单逐条一致(开就聚焦、↑↓、Esc、点外面/滚动/失焦)。

/**
 * 按**父链**派发一次事件 —— 真实浏览器里 contextmenu 会从行冒泡到列表容器。
 *
 * 为什么不能直接用替身的 `fire`:它只调这一个元素上的监听器,而 `preventDefault` /
 * `stopPropagation` 都是空函数 —— "行上的监听器拦住了冒泡,所以空白菜单不会把行菜单
 * 顶掉"这条契约在替身里根本走不到。这里带一份**真的**事件对象,并沿 `_parent` 往上走
 * (碰到 stopPropagation 就停),顺序与浏览器一致:目标先跑,父级后跑。
 */
async function fireBubbling(el, type, event = {}) {
    const ev = {
        ...event,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { ev.defaultPrevented = true; },
        stopPropagation() { ev.propagationStopped = true; },
    };
    for (let node = el; node && !ev.propagationStopped; node = node._parent) {
        for (const f of node.listeners?.[type] ?? []) await f(ev);
    }
    return ev;
}

test('列表空白处右键弹出浮层菜单,里面有「新建笔记」', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    await h.contextOnBlank();

    const menu = h.menu();
    assert.ok(menu, '空白处右键应当出现浮层菜单');
    assert.equal(menu.getAttribute('role'), 'menu');
    assert.equal(menu.dataset.menuKind, 'blank', '这一份是"空白处"的菜单');
    assert.match(String(menu.getAttribute('aria-label')), /菜单/,
        '浮层没有可见标题,aria-label 是屏幕阅读器唯一读得到的东西');

    const items = h.menuItems();
    assert.equal(items[0].textContent, '新建笔记', '第一项就是产品要的那条文案');
    assert.deepEqual(items.map(b => b.textContent), ['新建笔记', '新建文件夹'],
        '「新建文件夹」是既有动作的既有入口(顶栏那枚按钮),放进来不算发明新动作');
    for (const b of items) {
        assert.equal(b.getAttribute('role'), 'menuitem');
        assert.equal(b.tagName, 'BUTTON', '菜单项是 <button>:Tab / Enter 天然可用');
    }
    assert.equal(items[0].dataset.menuRole, 'new-note');
    assert.equal(items[1].dataset.menuRole, 'new-folder');
    assert.ok(items[0].focused >= 1, '打开就把焦点放在第一项上(键盘用户不用先想办法走进去)');
    assert.equal(h.els.listEl.children.some(c => c.className === 'note-menu'), false,
        '浮层不能是列表里的一项 —— 列表"索引一变就整段重画",会被下一次重画吃掉');
});

test('行上右键出的仍然是那一行自己的菜单 —— 空白菜单不许抢(真的冒泡一次)', async () => {
    const h = boot({ notes: [NOTE], files: FILES, folders: ['阅读'] });
    await h.view.setVault();

    // 笔记行:contextmenu 从按钮冒泡到列表容器,行自己的监听器必须拦住它
    const btn = h.noteButton('未命名.md');
    await fireBubbling(btn, 'contextmenu', { clientX: 40, clientY: 60 });
    assert.equal(h.menuKind(), 'note', '笔记行右键出的是行菜单');
    assert.deepEqual(h.menuItems().map(b => b.textContent), ['重命名', '删除笔记'],
        '被空白菜单顶掉的话,重命名与删除这两个入口就凭空消失了');

    // 文件夹行:它自己也有菜单,同样不许被空白菜单顶掉
    await fireBubbling(h.button('note-dir'), 'contextmenu', { clientX: 40, clientY: 60 });
    assert.equal(h.menuKind(), 'dir', '文件夹行右键出的是文件夹菜单');
    assert.deepEqual(h.menuItems().map(b => b.textContent), ['在此文件夹新建笔记', '删除文件夹']);
});

test('兜底判据:目标落在行内部(或已经被别的监听器处理过)时,空白菜单不出', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();

    // ① 万一将来新增的行忘了 stopPropagation,只要目标落在可交互元素里就不出空白菜单。
    //    替身的 closest() 恒返回 null,所以这里给一个**真的会做包含判断**的目标。
    const insideRow = { closest: (sel) => (String(sel).includes('button') ? { tagName: 'BUTTON' } : null) };
    await h.els.listEl.parentElement.fire('contextmenu', { target: insideRow });
    assert.equal(h.menu(), null, '落在行(可交互元素)里的右键不该出空白菜单');

    // ② 行已经 preventDefault 过(浏览器里就是"这一行自己处理了") → 空白菜单同样不出
    await h.els.listEl.parentElement.fire('contextmenu',
        { target: new El('div'), defaultPrevented: true });
    assert.equal(h.menu(), null, '已被别人处理过的 contextmenu 不该再开一份菜单');
});

test('点「新建笔记」走的是＋按钮**同一条路**:逐字段一样的 notes:create,建完就打开', async () => {
    // 库里预置的是「别的.md」而不是「未命名.md」:这样"新笔记叫什么"才是个真读数
    const seed = { notes: [{ path: '别的.md', title: '别的' }], files: { '别的.md': '# 别的\n' } };
    const h = boot(seed);
    await h.view.setVault();
    await h.contextOnBlank();
    await h.menuItems()[0].fire('click');

    // 再另起一个替身走 ＋ 按钮(同一个初始库,才比得出"是不是同一条路")
    const viaButton = boot(seed);
    await viaButton.view.setVault();
    await viaButton.els.newBtn.fire('click');

    assert.equal(h.menu(), null, '点了菜单项,浮层要收起来');
    assert.deepEqual(h.createCalls().map(c => c[1]), viaButton.createCalls().map(c => c[1]),
        '「新建笔记」必须复用 ＋ 按钮那条路(同一个 path、同一份初始正文)');
    assert.deepEqual(h.createCalls().map(c => c[1]), [{ path: '未命名.md', text: '# 未命名\n\n' }]);
    assert.equal(h.state.files['未命名.md'], '# 未命名\n\n', '内容真的落到了库里');
    assert.ok(h.items().includes('note:未命名.md@0'), '列表刷新出新那一篇');
    assert.equal(h.view.currentPath, '未命名.md', '与 ＋ 按钮一样:建完就打开它');
    assert.equal(h.openedNotes().at(-1), '未命名.md');

    // 再来一次:重名走的是既有那条唯一化规则(未命名 → 未命名 2),不是这里新写的
    await h.contextOnBlank();
    await h.menuItems()[0].fire('click');
    assert.equal(h.createCalls().at(-1)[1].path, '未命名 2.md',
        '重名唯一化也是既有规则,菜单这边没有另起一套');
});

test('Esc 关掉空白菜单:一个文件都不建,焦点还给打开菜单前的那个元素', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    // 真实界面里右键空白处之前,焦点通常还在列表里(刚点过的那一行 / 搜索框)。
    const wasFocused = h.noteButton('未命名.md');
    globalThis.document.activeElement = wasFocused;

    await h.contextOnBlank();
    const item = h.menuItems()[0];
    await h.menu().fire('keydown', { key: 'Escape', target: item });

    assert.equal(h.menu(), null, 'Esc 关掉浮层');
    assert.equal(h.createCalls().length, 0, 'Esc = 反悔,一个文件都不许建');
    assert.equal(h.state.notes.length, 1, '库里还是原来那一篇');
    assert.ok(wasFocused.focused >= 1,
        '焦点要回到打开菜单前那个元素上 —— 停在已经移除的菜单项上等于掉回 <body>');

    globalThis.document.activeElement = null;
});

test('↑↓ 在两个菜单项之间绕圈(与笔记行那份菜单同一条键盘规则)', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    await h.contextOnBlank();

    const [first, second] = h.menuItems();
    await h.menu().fire('keydown', { key: 'ArrowDown', target: first });
    assert.ok(second.focused >= 1, '↓ 走到第二项');
    await h.menu().fire('keydown', { key: 'ArrowDown', target: second });
    assert.ok(first.focused >= 2, '↓ 从最后一项绕回第一项(绕圈,不卡在末尾)');
    await h.menu().fire('keydown', { key: 'ArrowUp', target: first });
    assert.ok(second.focused >= 2, '↑ 从第一项绕到最后一项');
});

test('空白菜单的两条关闭规则:点外面关掉,滚动关掉', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();

    await h.contextOnBlank();
    fireGlobal('document', 'pointerdown', { target: h.menuItems()[0] });
    assert.ok(h.menu(), '点在浮层内部不算点外面(关早了菜单项的 click 就发不出来了)');

    fireGlobal('document', 'pointerdown', { target: new El('div') });
    assert.equal(h.menu(), null, '点空白(浮层外)应当关掉菜单');

    await h.contextOnBlank();
    fireGlobal('window', 'scroll', {});
    assert.equal(h.menu(), null, '列表一滚动,浮层与触发位置就脱开了:关掉');

    await h.contextOnBlank();
    fireGlobal('window', 'blur', {});
    assert.equal(h.menu(), null, '窗口失焦也关掉(浮层是 fixed 的,不关会悬在不活跃的窗口上)');
});

test('列表为空时也能出菜单 —— 提示那一行不算"一行",不许把它挡掉', async () => {
    const h = boot({ notes: [], folders: [] });
    await h.view.setVault();
    const hint = h.els.listEl.children[0];
    assert.equal(hint.textContent, '还没有笔记,点「新建」。', '空列表里只有那条提示');

    await h.contextOnBlank();
    assert.equal(h.menuKind(), 'blank', '空列表的空白处右键照样出菜单');
    assert.equal(h.menuItems()[0].textContent, '新建笔记');

    await h.menuItems()[0].fire('click');
    assert.deepEqual(h.createCalls().map(c => c[1]), [{ path: '未命名.md', text: '# 未命名\n\n' }],
        '库里什么都没有时,新笔记落在**库根**');
    assert.ok(h.items().includes('note:未命名.md@0'));
});

test('「新建文件夹」走既有的内联输入行(开出来的是同一个 .note-new-input)', async () => {
    const h = boot({ notes: [NOTE], files: FILES });
    await h.view.setVault();
    await h.contextOnBlank();
    await h.menuItems()[1].fire('click');

    const input = h.button('note-new-input') ?? h.els.listEl.children
        .flatMap(li => li.children ?? []).find(c => c.className === 'note-new-input');
    assert.ok(input, '列表顶部应当出现"新文件夹名"的内联输入行(与顶栏那枚按钮一样)');
    assert.ok(input.focused >= 1, '内联输入行开着就该聚焦(既有行为)');

    input.value = '阅读';
    await input.fire('keydown', { key: 'Enter' });
    assert.deepEqual(h.mkdirCalls().map(c => c[1]), [{ path: '阅读' }],
        '提交走的还是 notes:mkdir 那条既有 IPC');
    assert.ok(h.items().includes('dir:阅读:true'), `新目录默认展开,实际=${JSON.stringify(h.items())}`);
});

test('文件夹行右键:「在此文件夹新建笔记」把笔记落在**那个**目录里', async () => {
    const h = boot({ notes: [NOTE], files: FILES, folders: ['阅读'] });
    await h.view.setVault();
    await h.contextOnDir('阅读');

    const items = h.menuItems();
    assert.deepEqual(items.map(b => b.textContent), ['在此文件夹新建笔记', '删除文件夹']);
    assert.equal(items[0].dataset.menuRole, 'new-note-in-dir');
    assert.equal(items[0].getAttribute('aria-label'), '在「阅读」里新建笔记',
        '文案里只有"此",必须用 aria-label 说清是哪个文件夹');
    // 新加的第二项:删除文件夹 —— 与笔记那条同一个两步确认(见下面的专条用例)
    assert.equal(items[1].dataset.menuRole, 'remove-dir');
    assert.match(items[1].getAttribute('aria-label') ?? '', /把文件夹「阅读」移入回收站/,
        '删除这一项的 aria 要说清删的是哪个文件夹、以及是进回收站');

    await items[0].fire('click');
    // 与那一行上的 ＋ 按钮(`createNamed('未命名', dir.path)`)是同一个动作
    assert.deepEqual(h.createCalls().map(c => c[1]),
        [{ path: '阅读/未命名.md', text: '# 未命名\n\n' }]);
    assert.ok(h.items().includes('note:阅读/未命名.md@1'),
        `落在那个文件夹里、缩进也跟着,实际=${JSON.stringify(h.items())}`);
});

// ---------- 文件夹行右键 → 删除文件夹(两步确认 + 系统回收站) ----------
//
// 产品原话:「文件夹的右键菜单缺乏删除」。这一节钉渲染层这半边:
//   · 第一次点**不发任何 IPC**,只把文案换成确认态 —— 而且确认文案里要写出**代价**
//     (这个文件夹子树里有多少东西),用户点第二下之前就该知道;
//   · 第二次点才发 notes:removeDir,并且只递**库内相对路径**;
//   · 正在编辑的那篇若就在这个文件夹里:脏 → 拒绝(一个 IPC 都不发);干净 → 先切走再删。

test('点第一次「删除文件夹」:只进确认态,文案带上代价,一个 IPC 都不发', async () => {
    const h = boot({
        notes: [{ path: '阅读/一.md', title: '一' }, { path: '阅读/二.md', title: '二' }],
        folders: ['阅读'],
        files: { '阅读/一.md': '# 一\n', '阅读/二.md': '# 二\n' },
    });
    await h.view.setVault();
    await h.contextOnDir('阅读');

    const item = h.removeDirItem();
    assert.ok(item, '文件夹菜单里应当有「删除文件夹」这一项');
    assert.equal(item.textContent, '删除文件夹', '未确认前就是这四个字');
    await item.fire('click');

    assert.deepEqual(h.removeDirCalls(), [], '第一次点击绝不能真的删 —— 那是"一键即删"');
    assert.equal(item.textContent, '再点一次确认删除(含 2 篇笔记)',
        '确认文案要把"这一下带走什么"写出来');
    assert.equal(item.dataset.menuDanger, 'true', '确认态必须有告警色');
    assert.ok(h.menu(), '确认态**不关菜单** —— 第二次点击要落在同一项上');
});

test('空文件夹的确认文案不带括号(没有代价可报)', async () => {
    const h = boot({ notes: [], folders: ['空的'], files: {} });
    await h.view.setVault();
    await h.contextOnDir('空的');

    const item = h.removeDirItem();
    await item.fire('click');
    assert.equal(item.textContent, '再点一次确认删除');
});

test('点第二次才真的删:只递相对路径,列表里那个目录与里面的笔记一起消失', async () => {
    const h = boot({
        notes: [{ path: '阅读/一.md', title: '一' }],
        folders: ['阅读'],
        files: { '阅读/一.md': '# 一\n' },
    });
    await h.view.setVault();
    await h.contextOnDir('阅读');

    const item = h.removeDirItem();
    await item.fire('click');           // 第一次:确认态
    await item.fire('click');           // 第二次:真删

    assert.deepEqual(h.removeDirCalls().map(c => c[1]), [{ path: '阅读' }],
        '只递库内相对路径这一个叶子字段(绝对路径由主进程解析)');
    assert.equal(h.state.folders.includes('阅读'), false, '替身里那个目录应当被删掉');
    assert.ok(!h.items().some(x => String(x).startsWith('dir:阅读')),
        `刷新后列表里不该还有那个目录行,实际=${JSON.stringify(h.items())}`);
});

test('正在编辑的那篇就在这个文件夹里:脏 → 拒绝(一个 IPC 都不发);干净 → 先切走再删', async () => {
    const h = boot({
        notes: [{ path: '阅读/一.md', title: '一' }],
        folders: ['阅读'],
        // 两个块('# 一' + 空行):makeDirty 要点开第 2 块进源码态,与既有那条改名用例同一套夹具
        files: { '阅读/一.md': '# 一\n\n' },
    });
    await h.view.setVault();
    await h.view.open('阅读/一.md');

    // 弄脏必须走**真实输入路径**(见 makeDirty 的注释):直接改 dirty 标志等于把要验的链路绕过去
    makeDirty(h);
    assert.equal(h.view.hasUnsaved(), true, '前置条件:当前这篇必须是脏的');

    await h.contextOnDir('阅读');
    const item = h.removeDirItem();
    await item.fire('click');
    await item.fire('click');

    assert.deepEqual(h.removeDirCalls(), [],
        '手上还有未保存的改动时不许删 —— 那等于把最新正文从脚底下抽走');
    assert.match(String(h.els.statusEl.textContent), /未保存/);
    assert.equal(h.view.currentPath, '阅读/一.md', '拒绝之后编辑器还指着那一篇');
    assert.equal(h.state.folders.includes('阅读'), true, '目录当然还在');

    // 存下来(干净)之后再删:这时必须先切走编辑器,再调删除通道
    await h.view.save();
    assert.equal(h.view.hasUnsaved(), false, '前置条件:已经干净');
    await h.contextOnDir('阅读');
    const item2 = h.removeDirItem();
    await item2.fire('click');
    await item2.fire('click');
    assert.deepEqual(h.removeDirCalls().map(c => c[1]), [{ path: '阅读' }]);
    assert.equal(h.view.currentPath, null,
        '删的目录里就是当前打开那篇时,编辑器必须先切走(否则下一次保存会把文件重新建出来)');
    assert.equal(h.els.pathEl.textContent, '', '顶栏路径也要清掉');
});

test('★ 这个卷没有系统回收站时:状态行要说清东西挪到库内哪了(用户报的"无效"就是这句话缺了)', async () => {
    const h = boot({ notes: [NOTE], files: FILES, removeMode: 'vault' });
    await h.view.setVault();

    const item = await toDeleteConfirm(h, '未命名.md');
    await item.fire('click');

    const text = String(h.els.statusEl.textContent);
    assert.match(text, /\.trash\//, '必须把落点路径说出来');
    assert.match(text, /没有系统回收站/, '并且要说明为什么不是回收站');
    assert.equal(h.els.statusEl.dataset.state === 'error', false, '这是成功,不是错误态');
});

test('★ 文件夹同理:落库内 .trash 时状态行带上路径与"带走了多少"', async () => {
    const h = boot({
        notes: [{ path: '阅读/一.md', title: '一' }],
        folders: ['阅读'],
        files: { '阅读/一.md': '# 一\n' },
        removeMode: 'vault',
    });
    await h.view.setVault();
    await h.contextOnDir('阅读');

    const item = h.removeDirItem();
    await item.fire('click');
    await item.fire('click');

    const text = String(h.els.statusEl.textContent);
    assert.match(text, /\.trash\/2026-09-29-230000\/阅读/);
    assert.match(text, /1 个文件/);
});

test('子目录里的笔记行右键仍然是行菜单(空白菜单不抢,重命名前缀也不丢)', async () => {
    const h = boot({
        notes: [{ path: '阅读/读书笔记.md', title: '读书笔记', tags: [] }],
        folders: ['阅读'],
        files: { '阅读/读书笔记.md': '# 读书笔记\n' },
    });
    await h.view.setVault();
    await fireBubbling(h.noteButton('阅读/读书笔记.md'), 'contextmenu',
        { clientX: 40, clientY: 60 });
    assert.equal(h.menuKind(), 'note');
    assert.deepEqual(h.menuItems().map(b => b.textContent), ['重命名', '删除笔记']);
    // 删除项也要认下**这一行**的路径:前缀丢了对子目录里的笔记就是删错文件
    assert.deepEqual(h.deleteItem().dataset, { menuRole: 'delete-note' });
    assert.equal(h.menu().dataset.noteMenu, '阅读/读书笔记.md',
        '菜单记下的目标路径必须带子目录前缀');
});