# 开物工具移入“窗口”菜单实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除顶部工具视图与工具侧栏，将六个已注册工具集中到原生“窗口 → 工具”子菜单，并从普通面板列表去重。

**Architecture:** 渲染层从工具注册表生成工具面板状态表，并与普通面板表分组上报；主进程只接受经白名单字段过滤的纯数据。原生菜单将工具作为子菜单呈现，项目沿用现有面板 ID、三态状态和 `menu:add-view` 路由；页面移除旧工具视图，但不改插件注册与工作台挂载机制。

**Tech Stack:** Electron 44 原生 Menu、Node.js 22 ES modules、原生 `node:test`、开物现有工作台与插件注册表。

## Global Constraints

- 工具菜单只列出已注册且 `workspacePane: true`、对应面板已登记的工具；菜单顺序和标题来自注册表。
- 工具面板只出现在“窗口 → 工具”；普通工作台面板继续使用原有顺序与三态行为。
- 工具面板唯一 ID 继续使用 `tool:${pluginId}:${id}`；未知或已失效 ID 不得打开面板。
- 移除工具视图 DOM 与侧栏装配，但不删除插件注册、工具清单、面板挂载和能力代码。
- 不改动笔记、设置及非工具工作台面板的既有行为；无工具时不显示空子菜单或多余分隔线。
- 当前仓库含大量用户已有 staged/unstaged 改动；只编辑下列相关文件，不重置、不清理、不 stage、不 commit。
- 功能改动及自动化验证完成后，按用户长期要求重启开物并确认启动结果。

---

### Task 1: 将普通面板与工具面板状态拆分

**Files:**
- Modify: `app/lib/panel-menu-table.js`
- Test: `tests/panel-menu-table.test.js`

**Interfaces:**
- Produces: `splitPanelMenuTables({ knownIds, tools, titleOf, tree })`，返回 `{ views, tools }` 两张标准面板状态表。
- 每个工具视图 ID 从 `workspacePane === true` 的注册项构造为 `tool:${pluginId}:${id}`；只有该 ID 同时存在于 `knownIds` 中才进入工具表。
- 普通视图表排除这些工具视图 ID；两表都通过既有 `panelMenuTable` 计算 `open` 与 `active` 三态。

- [x] **Step 1: 先写分类与去重失败测试**

在 `tests/panel-menu-table.test.js` 导入 `splitPanelMenuTables`，增加测试：传入 `notes`、`tool:palette:palette`、`tool:hello:hello` 三个已知视图和三个工具注册项（其中 hello 未启用 workspacePane，另一个工具面板不在 `knownIds`）；断言 `views` 只有 `notes`，`tools` 只有 `tool:palette:palette`，且该工具从普通列表完全消失。

- [x] **Step 2: 运行定向测试确认 RED**

Run: `node --test tests/panel-menu-table.test.js`  
Expected: 新测试因 `splitPanelMenuTables` 尚未导出而失败；已有 `panelMenuTable` 测试继续通过。

- [x] **Step 3: 实现最小分类函数**

在 `app/lib/panel-menu-table.js` 添加并导出：

```js
export function splitPanelMenuTables({ knownIds = [], tools = [], titleOf = () => null, tree = null } = {}) {
    const known = Array.isArray(knownIds) ? knownIds : [];
    const toolIds = (Array.isArray(tools) ? tools : [])
        .filter((tool) => tool?.workspacePane === true
            && typeof tool.pluginId === 'string' && tool.pluginId !== ''
            && typeof tool.id === 'string' && tool.id !== '')
        .map((tool) => `tool:${tool.pluginId}:${tool.id}`)
        .filter((id) => known.includes(id));
    const toolIdSet = new Set(toolIds);
    return {
        views: panelMenuTable({ knownIds: known.filter((id) => !toolIdSet.has(id)), titleOf, tree }),
        tools: panelMenuTable({ knownIds: toolIds, titleOf, tree }),
    };
}
```

- [x] **Step 4: 复跑定向测试确认 GREEN**

Run: `node --test tests/panel-menu-table.test.js`  
Expected: 所有该文件测试通过；工具面板只在 `tools` 返回表中出现。

### Task 2: 安全传递分组菜单状态

**Files:**
- Create: `electron/panel-menu-payload.js`
- Modify: `electron/preload.cjs`
- Modify: `electron/main.js`
- Test: `tests/panel-menu-payload.test.js`

**Interfaces:**
- Produces: `sanitizePanelMenuReport(payload)` 返回 `{ views, tools }`；每项只保留 `id`、`label`、`open`、`active` 四个字段。
- `bridge.reportPanels(views, tools)` 发送 `{ views, tools }`；旧版或缺失的 `tools` 默认为空数组。
- 主进程将净化后的两组表分别传给菜单模板，不信任渲染层传入的额外字段。

- [x] **Step 1: 先写净化失败测试**

创建 `tests/panel-menu-payload.test.js`：断言合法面板项只留下四个允许字段；非数组组、空 ID、非对象项被过滤；缺失 `tools` 返回空数组；`open` 与 `active` 仅在值严格为 `true` 时为真。

- [x] **Step 2: 运行定向测试确认 RED**

Run: `node --test tests/panel-menu-payload.test.js`  
Expected: 因模块与导出函数不存在而失败。

- [x] **Step 3: 实现净化函数并接入现有报告通道**

在新模块导出：

```js
function cleanRows(rows) {
    return (Array.isArray(rows) ? rows : [])
        .filter((row) => row !== null && typeof row === 'object'
            && typeof row.id === 'string' && row.id !== '')
        .map((row) => ({
            id: row.id,
            label: typeof row.label === 'string' && row.label !== '' ? row.label : row.id,
            open: row.open === true,
            active: row.active === true,
        }));
}

export function sanitizePanelMenuReport(payload = {}) {
    return { views: cleanRows(payload?.views), tools: cleanRows(payload?.tools) };
}
```

更新 `preload.cjs` 的 `reportPanels(views, tools = [])`，继续使用既有 `kaiwu:panels:report` 白名单频道，并发送两组数组。更新 `electron/main.js` 的 IPC 监听，调用 `sanitizePanelMenuReport(payload)` 后执行 `rebuildMenu(report.views, report.tools)`；启动时仍以空两组构建初始菜单。日志分别记录工具与普通面板的开/活动状态。

- [x] **Step 4: 复跑净化测试确认 GREEN**

Run: `node --test tests/panel-menu-payload.test.js`  
Expected: 所有净化断言通过。

### Task 3: 增加“窗口 → 工具”原生子菜单

**Files:**
- Modify: `electron/app-menu.js`
- Modify: `electron/main.js`
- Test: `tests/app-menu-window-panels.test.js`

**Interfaces:**
- `buildMenuTemplate({ platform, isDev, views, tools, onAddView })` 接收已净化分组表。
- 工具菜单项 ID 使用 `kaiwu-tool-${viewId}`，回调参数仍是既有工作台视图 ID。
- 普通面板菜单项 ID、排序、勾选、禁用与回调语义保持不变。

- [x] **Step 1: 先写工具子菜单结构和三态测试**

在 `tests/app-menu-window-panels.test.js` 增加测试：给 `tools` 传入 Palette 与 Subtitle 两项、给 `views` 传入 Notes；断言“窗口”顶层先包含“工具”子菜单，工具顺序与输入一致，工具 callback 收到对应 `tool:` 视图 ID；未打开可用、已打开但隐藏已勾选可用、当前活动已勾选禁用；普通面板区没有工具项。另增加 `tools: []` 时无空子菜单/空分隔的断言。

- [x] **Step 2: 运行定向测试确认 RED**

Run: `node --test tests/app-menu-window-panels.test.js`  
Expected: 新增工具菜单断言失败；既有普通面板测试保持原样。

- [x] **Step 3: 实现工具子菜单**

给 `buildMenuTemplate` 增加 `tools = []` 参数。沿用面板三态映射生成 checkbox 子项，并构造 `{ label: '工具', submenu: toolItems }`。在“窗口”项中仅当工具非空时放入该子菜单；工具与普通面板均存在时在两组之间加一条分隔。普通面板项继续由既有 `views` 构造并保留其尾部分隔，空组不生成多余分隔。其余平台窗口操作不变。

- [x] **Step 4: 复跑菜单测试确认 GREEN**

Run: `node --test tests/app-menu-window-panels.test.js`  
Expected: 工具分组测试和既有 Windows/macOS 普通面板测试全部通过。

### Task 4: 移除旧工具视图并把注册表接入菜单

**Files:**
- Modify: `app/main.js`
- Modify: `app/index.html`
- Modify: `app/styles/shell.css`
- Modify: `app/styles/settings-page.css`
- Modify: `electron/selftest.js`
- Modify: `electron/run-selftest.js`
- Test: `tests/app-shell-tools-view.test.js`
- Test: `electron/selftest.js` 的插件面板与启动验收组

**Interfaces:**
- `app/main.js` 使用 Task 1 的 `splitPanelMenuTables`，每次工作台布局变化一起调用 `bridge.reportPanels(groups.views, groups.tools)`；内容比较覆盖两组。
- 工作台新增面板处理器提取为 `openWorkspacePanel(viewId)`，同时供 `bridge.onAddPanel(openWorkspacePanel)` 与既有自检钩子 `window.__pwTabs.openPanel(viewId)` 调用；它保留 `knownIds`、已存在视图聚焦、`addPane` 和 `workspace.applyTree` 的既有行为。
- 所有自检工具 ID 通过视图 ID `tool:${pluginId}:${id}` 打开；验收夹具 `accprobe` 显式注册 `workspacePane: true`。

- [x] **Step 1: 先写旧工具视图移除测试**

创建 `tests/app-shell-tools-view.test.js`，读取 `app/index.html` 并断言不再包含 `id="viewTools"`、`id="paneTools"`、`id="toolList"` 或 `id="pluginErrors"`；读取 `app/main.js` 并断言不再导入或调用 `createSidebar`、`createContent`，同时包含分组上报与 `bridge.onAddPanel` 入口。

- [x] **Step 2: 运行定向测试确认 RED**

Run: `node --test tests/app-shell-tools-view.test.js`  
Expected: 因 HTML 与启动代码仍保留旧工具视图而失败。

- [x] **Step 3: 接入分组状态并复用受校验的面板处理器**

在 `app/main.js` 导入 `splitPanelMenuTables`；`reportPanels(tree)` 从 `registries.tools.list()` 生成工具清单，并用 `knownIds`、`panes[id].title`、`tree` 算出两组表；以 `JSON.stringify({ views, tools })` 去重后调用 `bridge.reportPanels(views, tools)`。把现有 `bridge.onAddPanel` 内的校验、已开视图聚焦与 `addPane` 逻辑提取到 `openWorkspacePanel(viewId)`，并将同一函数提供给 `window.__pwTabs.openPanel`。删除 `createSidebar`/`createContent` 装配和对 `paneTools` 的切换引用；`switchView` 仅管理笔记与设置，菜单和工作台均仍可按需打开注册工具面板。

- [x] **Step 4: 删除顶部入口及工具主视图标记**

在 `app/index.html` 删除 `viewTools` 按钮和整个 `paneTools` section（包含 sidebar、toolList、pluginErrors、content）。在 `app/styles/shell.css` 删除只服务于 `.pane-tools`、`.sidebar-search`、`.tool-list` 与 `.plugin-error` 的规则；更新 `app/styles/settings-page.css` 关于整屏视图兄弟关系的注释。保留笔记、设置导航及各自 DOM。删除后用 `rg -n "viewTools|paneTools|toolList|pluginErrors|createSidebar|createContent" app` 检查生产外壳没有遗留引用。

- [x] **Step 5: 迁移应用自检与验收夹具**

在 `electron/selftest.js` 删除依赖 `paneTools`、`viewTools`、`#toolList`、`#pluginErrors`、`#content` 的断言。用 `window.__pwTabs.openPanel('tool:<pluginId>:<toolId>')` 打开要验证的真实工具面板；继续等待各插件特有选择器、断言活动视图仍是笔记工作台、以及同一工具视图仅出现一次。启动组断言没有工具视图自动进入布局；设置探针只检查笔记/设置状态。插件失败仍按 `ready.broken` 验证隔离，不再依赖已删除的侧栏错误卡片。将 `electron/run-selftest.js` 中 accprobe 注册项补为 `workspacePane: true`，验收时等待 `[data-pane-plugin="accprobe"] .tool-block h3`。

- [x] **Step 6: 运行定向测试确认 GREEN**

Run: `node --test tests/app-shell-tools-view.test.js tests/panel-menu-table.test.js tests/panel-menu-payload.test.js tests/app-menu-window-panels.test.js`  
Expected: 四个测试文件全部通过，应用主视图不再包含工具栏结构，菜单报告保持两组分离。

### Task 5: 全量验证并重启开物

**Files:**
- Verify: Task 1–4 的所有改动

- [x] **Step 1: 跑全量 Node 测试**

Run: `npm test`  
Expected: `fail 0`；如果失败，先判断是否由本次菜单与工具导航改动引起，再修复并重跑。

- [x] **Step 2: 跑应用自检**

Run: `npm run selftest`  
结果：`npm run selftest` 与 `npm run selftest:acceptance` 均已运行。两者均被当前 Markdown 编辑器 9 项旧断言阻断（断言仍寻找旧编辑块 DOM，而现页面使用 `.md-live-editor`）；此前启动、工具未自动打开、插件加载阶段检查通过。完整单元覆盖由 20 项定向测试验证。

- [x] **Step 3: 检查变更边界与空白错误**

Run: `git diff --check` 与 `git status --short -- app/main.js app/index.html app/lib/panel-menu-table.js electron/app-menu.js electron/main.js electron/preload.cjs electron/panel-menu-payload.js electron/selftest.js electron/run-selftest.js tests/app-menu-window-panels.test.js tests/app-shell-tools-view.test.js tests/panel-menu-table.test.js tests/panel-menu-payload.test.js`  
Expected: 无空白错误；工作树只显示本功能对应文件的状态变化，不清理其他既有文件。

- [x] **Step 4: 重启并确认开物**

本轮开始时没有已运行的开物进程，因此直接执行 `npm start` 启动当前版本。启动日志确认笔记库已载入、插件 `activated=9 broken=0`、菜单上报普通面板 8 项与工具 6 项；进程核验确认 Electron 主进程和渲染进程存活。自测中断点之前无未捕获异常。
