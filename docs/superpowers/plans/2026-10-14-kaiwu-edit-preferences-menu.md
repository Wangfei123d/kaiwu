# 开物首选项菜单实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除顶部“设置”标签，并通过“编辑 → 首选项…”打开现有完整设置页。

**Architecture:** Electron 原生编辑菜单调用一个固定的主进程回调，经 preload 闭包桥以无参数事件通知渲染层。渲染层复用当前 `switchView('settings')`，保留现有设置面板、四个分区、11 项控件和设置存档；“笔记”按钮继续作为返回入口，但改为单按钮主导航语义。

**Tech Stack:** Electron 44 Menu / IPC、preload CommonJS、渲染层 ES modules、Node.js `node:test`。

## Global Constraints

- “编辑”菜单仅增加一个“首选项…”入口；不增加分区子菜单、快捷键或独立设置窗口。
- 移除 `viewSettings` 顶部按钮；保留并复用 `paneSettings` 与既有设置页。
- 设置项 ID、存储命名空间、持久化值、设置 IPC 通道与生效时机保持不变。
- 主导航只保留“笔记”按钮；不再使用单成员 `tablist` / `tab` 语义，以 `aria-current="page"` 表示笔记页活动状态。
- 菜单通知仅通过固定 preload 桥接通道发送，不传设置内容、Electron event 或任意可执行值。
- 保留笔记、工具菜单、工作台布局及既有面板行为。
- 当前工作区有大量既有 staged/unstaged 改动；只改下列相关文件，不清理、不重置、不 stage、不 commit。
- 每次功能改动完成后重启开物，并核实进程与启动日志。

---

### Task 1: 将“首选项…”加入编辑菜单

**Files:**
- Modify: `electron/app-menu.js`
- Test: `tests/app-menu.test.js`

**Interfaces:**
- `buildMenuTemplate({ ..., onOpenPreferences = null } = {})` 增加可选回调 `onOpenPreferences: () => void`。
- “编辑”菜单在现有“全选”后添加分隔线和“首选项…”项；点击只调用回调。

- [ ] **Step 1: 先写菜单行为测试**

扩展 `tests/app-menu.test.js`：分别构建 Windows 与 macOS 菜单，定位“编辑”菜单，断言末尾为 `全选 / separator / 首选项…`，点击“首选项…”只调用一次传入的回调；断言撤销、剪切、复制、粘贴、全选 role 均保持原值。

```js
test('编辑菜单在 Windows 与 macOS 都提供首选项入口', () => {
    for (const platform of ['win32', 'darwin']) {
        let opened = 0;
        const edit = buildMenuTemplate({ platform, onOpenPreferences: () => { opened += 1; } })
            .find((menu) => menu.label === '编辑');
        assert.deepEqual(edit.submenu.slice(-3).map((item) =>
            item.type === 'separator' ? 'separator' : item.label), ['全选', 'separator', '首选项…']);
        edit.submenu.at(-1).click();
        assert.equal(opened, 1);
        assert.deepEqual(edit.submenu.filter((item) => item.role).map((item) => item.role),
            ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
    }
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/app-menu.test.js`

Expected: 新断言因菜单尚无“首选项…”或回调参数未接入而失败，既有菜单断言通过。

- [ ] **Step 3: 实现最小菜单改动**

给 `buildMenuTemplate` 增加 `onOpenPreferences = null` 参数；在编辑菜单标准命令之后追加分隔线和下列菜单项。不改变其它平台菜单。

```js
{ label: '全选', role: 'selectAll' },
sep,
{ label: '首选项…', click: () => onOpenPreferences?.() },
```

- [ ] **Step 4: 运行菜单测试确认 GREEN**

Run: `node --test tests/app-menu.test.js tests/app-menu-window-panels.test.js`

Expected: 两个文件全部通过，原有普通面板和工具子菜单行为不变。

### Task 2: 安全接通主进程与 preload 事件

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.cjs`
- Create: `tests/preload-preferences.test.js`

**Interfaces:**
- 主进程构建菜单时提供回调；用户点击后向现有窗口发送固定频道 `menu:open-preferences`，不带 payload。
- preload 桥新增 `onOpenPreferences(callback)`；非函数输入同步报错；回调不接收 IPC event；返回取消订阅函数。

- [ ] **Step 1: 先写 preload 桥测试**

创建 `tests/preload-preferences.test.js`，使用 `node:vm` 执行 `electron/preload.cjs`，注入 mock `electron` 模块并取得传给 `contextBridge.executeInMainWorld` 的桥对象。测试：方法存在；非函数回调抛错；mock `ipcRenderer.on` 触发 listener 时页面回调收到零个参数；返回的 disposer 调用 `ipcRenderer.removeListener` 并移除同一个 listener。

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const preloadSource = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

test('首选项事件只传零参数并能取消订阅', () => {
    const listeners = new Map();
    const removed = [];
    const ipcRenderer = {
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => removed.push([channel, listener]),
        invoke() {}, send() {},
    };
    const pageWindow = { addEventListener() {} };
    const sandbox = {
        require: (name) => {
            assert.equal(name, 'electron');
            return { contextBridge: { executeInMainWorld: ({ func, args }) => func(...args) }, ipcRenderer };
        },
        window: pageWindow,
        console,
    };
    vm.runInNewContext(preloadSource, sandbox, { filename: 'preload.cjs' });
    const bridge = pageWindow.__kaiwuBridgeTemp;
    assert.equal(typeof bridge.onOpenPreferences, 'function');
    assert.throws(() => bridge.onOpenPreferences(null), /需要一个函数/);
    let received;
    const dispose = bridge.onOpenPreferences((...args) => { received = args; });
    const listener = listeners.get('menu:open-preferences');
    listener({ sender: 'must-not-cross-the-bridge' });
    assert.deepEqual(received, []);
    dispose();
    assert.deepEqual(removed, [['menu:open-preferences', listener]]);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/preload-preferences.test.js`

Expected: 因 `onOpenPreferences` 尚不存在而失败，不应出现 VM 初始化错误。

- [ ] **Step 3: 实现主进程发送与 preload 订阅**

在 `electron/main.js` 的 `buildMenuTemplate` 参数中传入 `onOpenPreferences`，仅在 `win !== null && !win.isDestroyed()` 时执行 `win.webContents.send('menu:open-preferences')`。因为初始菜单在主窗口创建前安装，先在该闭包作用域声明 `let win = null`，后将 `const win = createWindow()` 改为 `win = createWindow()`，避免菜单项被提前点击时读到暂时性死区。`onAddView` 的窗口存活守卫同步使用 null 安全判断。在 `electron/preload.cjs` 桥对象中新增校验并复用 `bridge.on('menu:open-preferences', () => callback())`，沿用现有 listener 对 IPC event 的剥离和取消订阅逻辑。

```js
onOpenPreferences(callback) {
    if (typeof callback !== 'function') throw new Error('onOpenPreferences 需要一个函数');
    return bridge.on('menu:open-preferences', () => callback());
},
```

主进程回调只发送固定事件且不带参数：

```js
onOpenPreferences: () => {
    if (win !== null && !win.isDestroyed()) win.webContents.send('menu:open-preferences');
},
```

- [ ] **Step 4: 复跑 IPC 测试和语法检查**

Run: `node --check electron/main.js; node --check electron/preload.cjs; node --test tests/preload-preferences.test.js tests/app-menu.test.js`

Expected: 语法检查退出码为 0，目标测试全部通过。

### Task 3: 移除顶栏设置标签并复用设置页

**Files:**
- Modify: `app/index.html`
- Modify: `app/main.js`
- Modify: `app/lib/settings-page.js`
- Modify: `tests/settings-page.test.js`
- Modify: `app/styles/shell.css`
- Create: `tests/app-shell-settings-preferences.test.js`

**Interfaces:**
- 主界面保留一个“笔记”导航按钮；进入笔记时该按钮有 `aria-current="page"`，进入设置时移除该属性。
- `bridge.onOpenPreferences(openPreferences)` 与自测钩子 `window.__pwTabs.openPreferences()` 共用 `switchView('settings')` 行为。
- `SETTINGS_VIEW` 只保留仍有效的 `view` 与 `paneId`，不再暴露失效的 `tabId`。

- [ ] **Step 1: 先写主界面和设置常量回归测试**

创建 `tests/app-shell-settings-preferences.test.js`，断言 HTML 不含 `id="viewSettings"`，仍有 `id="viewNotes"` 与 `id="paneSettings"`；仅针对 `.topbar-views` 导航确认没有 `role="tablist"`，笔记按钮没有 `role="tab"`；`app/main.js` 订阅 `bridge.onOpenPreferences`、按视图切换 `aria-current` 并提供 `openPreferences` 自测钩子；`electron/main.js` 发送固定菜单事件。更新 `tests/settings-page.test.js` 的常量断言为 `{ view: 'settings', paneId: 'paneSettings' }`。

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SETTINGS_VIEW } from '../app/lib/settings-page.js';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
const electronMain = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');

test('主导航通过首选项事件打开保留的设置页', () => {
    assert.doesNotMatch(html, /id="viewSettings"/);
    assert.match(html, /id="viewNotes"/);
    assert.match(html, /id="paneSettings"/);
    const nav = html.match(/<nav class="topbar-views"[\s\S]*?<\/nav>/)?.[0] ?? '';
    assert.doesNotMatch(nav, /role="tablist"|role="tab"/);
    assert.match(main, /bridge\.onOpenPreferences\(/);
    assert.match(main, /aria-current/);
    assert.match(main, /openPreferences/);
    assert.match(electronMain, /menu:open-preferences/);
    assert.deepEqual(SETTINGS_VIEW, { view: 'settings', paneId: 'paneSettings' });
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/app-shell-settings-preferences.test.js tests/settings-page.test.js`

Expected: 主界面合同与设置常量测试因旧 Settings tab / tabId 仍存在而失败；现有设置逻辑测试通过。

- [ ] **Step 3: 移除旧标签并接入首选项事件**

从 `app/index.html` 删除设置按钮与 tablist/tab 语义；给笔记按钮设置 `aria-current="page"`。更新 `app/styles/shell.css` 活动样式选择器为 `.view-tab[aria-current="page"]`。在 `app/main.js` 用 `switchView` 管理笔记按钮的 `aria-current`，订阅 `bridge.onOpenPreferences(() => switchView('settings'))`，并在原有 `window.__pwTabs` 对象中暴露同一切换函数。移除 `SETTINGS_VIEW.tabId` 及指向顶栏按钮的注释。

```js
function switchView(next) {
    const selected = next === 'settings' ? 'settings' : 'notes';
    $('paneNotes').hidden = selected !== 'notes';
    $('paneSettings').hidden = selected !== 'settings';
    for (const button of document.querySelectorAll('.view-tab')) {
        if (button.dataset.view === selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    if (selected === 'settings') void settingsView.show();
}
bridge.onOpenPreferences(() => switchView('settings'));
// 在现有 window.__pwTabs 对象中加入：
openPreferences: () => switchView('settings'),
```

- [ ] **Step 4: 复跑 shell 与设置测试确认 GREEN**

Run: `node --test tests/app-shell-settings-preferences.test.js tests/settings-page.test.js`

Expected: 新的导航/事件合同与全部现有设置数据、搜索、路径和设置通道测试通过。

### Task 4: 迁移 Electron 自测中的设置入口

**Files:**
- Modify: `electron/selftest.js`

- [ ] **Step 1: 将自测改为使用统一首选项入口**

把所有 `document.getElementById('viewSettings').click()` 替换为调用 `window.__pwTabs.openPreferences()`；更新设置探针读取 `viewNotes` 的 `aria-current`，设置可见时预期值为空，返回笔记时预期为 `page`。保留对现有设置分区、控件与落盘行为的断言。例如：

```js
await win.webContents.executeJavaScript('window.__pwTabs.openPreferences()');
const navCurrent = await win.webContents.executeJavaScript(
    "document.getElementById('viewNotes').getAttribute('aria-current')");
// 设置中 navCurrent === null；切回笔记后 navCurrent === 'page'。
```

- [ ] **Step 2: 检查旧入口无遗留并运行语法检查**

Run: `rg -n "viewSettings" app electron/selftest.js tests/settings-page.test.js tests/app-shell-settings-preferences.test.js; node --check electron/selftest.js; node --check app/main.js`

Expected: `viewSettings` 无输出；语法检查退出码为 0。

### Task 5: 整体验证并重启开物

**Files:**
- Verify: Task 1–4 的所有改动

- [ ] **Step 1: 运行相关测试与全量单元测试**

Run: `node --test tests/app-menu.test.js tests/app-menu-window-panels.test.js tests/preload-preferences.test.js tests/app-shell-settings-preferences.test.js tests/settings-page.test.js`，然后运行 `npm test`。

Expected: 定向测试通过；全量测试 `fail 0`。若出现失败，判断是否由本次菜单事件与导航语义变更导致。

- [ ] **Step 2: 运行 Electron 自测**

Run: `npm run selftest` 与 `npm run selftest:acceptance`。

Expected: 新的首选项打开和返回笔记断言通过；记录并区分现有 Markdown 编辑器断言失败，不扩大范围修复无关问题。

- [ ] **Step 3: 检查空白错误与改动边界**

Run: `git diff --check -- kaiwu/app/index.html kaiwu/app/main.js kaiwu/app/lib/settings-page.js kaiwu/app/styles/shell.css kaiwu/electron/app-menu.js kaiwu/electron/main.js kaiwu/electron/preload.cjs kaiwu/electron/selftest.js kaiwu/tests/app-menu.test.js kaiwu/tests/settings-page.test.js kaiwu/tests/preload-preferences.test.js kaiwu/tests/app-shell-settings-preferences.test.js`。

Expected: 没有空白错误；不处理仓库中其它既有改动。

- [ ] **Step 4: 重启并确认开物**

确认旧进程属于 `E:\project\kaiwu` 后，仅重启该实例；若没有实例则直接执行 `npm start`。检查启动日志无新错误、笔记页可进入，“编辑 → 首选项…”能打开原设置页，再点“笔记”能返回。

---

## 自审结果

- **规格覆盖：** 菜单入口与排序在 Task 1；固定 IPC 和受限 preload 桥在 Task 2；顶栏移除、返回入口和原设置页复用在 Task 3；自测入口迁移在 Task 4；测试、空白校验和重启验收在 Task 5。
- **占位扫描：** 计划没有 TBD/TODO 或把实现留给未来的指令；每个改代码步骤均附具体接口或代码形态。
- **接口一致性：** `onOpenPreferences: () => void` → `menu:open-preferences` 无 payload → `onOpenPreferences(callback)` 零参数回调 → `switchView('settings')`；`window.__pwTabs.openPreferences()` 与同一切换函数一致。`SETTINGS_VIEW` 仅保留 `view` 与 `paneId`。
- **安全检查：** 菜单可能早于窗口创建，因此计划显式初始化 `win = null` 并对菜单回调做销毁/空值守卫；主进程发固定频道，不从渲染层接收任意菜单内容。
