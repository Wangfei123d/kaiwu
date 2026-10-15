# 插件工具改为可停靠工作台面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将截图中的 6 个工具迁移为可按需打开、可拖动停靠并能随工作台布局保存的独立面板。

**Architecture:** 工具清单通过 `workspacePane: true` 显式声明工作台呈现方式；加载器复用既有 `mountTool()`，为其注册一个稳定 ID 的可选工作台视图。布局存档继续识别所有注册视图，但只强制要求内建与现有必需面板；工具启动器点击时再加入可选视图，并聚焦唯一实例。

**Tech Stack:** Electron、原生 ES modules、Node.js `node:test`、现有 `panel-tree` / `panel-layout-store` 工作台。

## Global Constraints

- 改造范围仅为 B站解析下载、抖音解析、音乐试听、调色板 & 渐变、字幕格式互转、单文件示例。
- 保留各插件当前 UI、业务交互、私有样式、设置和后台服务行为。
- 保留顶部“工具”视图、侧栏搜索与插件加载错误提示；目标工具仅用侧栏作为工作台启动入口。
- 未打开的目标工具不得自动加入默认布局或在重启时被补回。
- 短剧画布、笔记画布、AI 会话等既有面板及用户已保存的布局比例不得改变。
- 避免将工作区现有暂存或未提交改动纳入本功能的提交。

---

### Task 1: 让布局校验支持可选视图

**Files:**
- Modify: `kaiwu/app/lib/panel-tree.js`
- Modify: `kaiwu/app/lib/panel-layout-store.js`
- Test: `kaiwu/tests/panel-tree.test.js`
- Test: `kaiwu/tests/panel-layout-store.test.js`

**Interfaces:**
- `knownIds` 仍表示所有可识别视图，用于过滤未知存档项。
- 新增 `requiredIds`，默认等于 `knownIds`，用于布局完整性校验和缺失视图补回。
- `normalizeTree(tree, knownIds, requiredIds)`、`validateLayout(tree, knownIds, requiredIds)`、`decodeLayoutResult(raw, knownIds, adoption, requiredIds)` 与 `createLayoutStore({ knownIds, requiredIds, ... })` 必须保持旧调用签名兼容；新增参数放在末尾或作为新增可选属性。

- [ ] **Step 1: 写出可选视图缺席与必需视图补回的失败测试**

在 `tests/panel-tree.test.js` 增加用例：以 `knownIds = [...DEFAULT_PANE_IDS, 'tool:bilibili']`、`requiredIds = DEFAULT_PANE_IDS` 和 `defaultTree()` 为输入，断言 `normalizeTree(tree, knownIds, requiredIds)` 不添加 `tool:bilibili`，且 `validateLayout(...).ok === true`；再以仅含 `pane('notes')` 的树归一化，断言其他必需视图仍会补回。

在 `tests/panel-layout-store.test.js` 增加 v4 存档用例：存档只含默认必需视图，解码时将 `tool:bilibili` 放入 `knownIds`、但不放进 `requiredIds`；断言 `ok === true`、旧树与比例不变、可选视图仍缺席。先运行：

```powershell
node --test tests/panel-tree.test.js tests/panel-layout-store.test.js
```

预期：新增断言失败，现有测试保持通过。

- [ ] **Step 2: 实现必需视图与可识别视图分离**

在 `panel-tree.js` 中让 `normalizeTree` 仍按 `knownIds` 丢弃未知视图，但只对 `requiredIds` 调用缺失视图补回逻辑；让 `validateLayout` 只检查 `requiredIds` 是否都存在。`requiredIds` 过滤到 `knownIds` 的交集，防止错误配置制造无法识别的必需项。

在 `panel-layout-store.js` 中把 `requiredIds` 贯穿 `decodeLayoutResult()`、默认树收编、存档归一化和 `createLayoutStore().save()`。默认值保持旧行为，即所有已知视图都必需。核心判据应保持如下语义：

```js
const required = known.filter((id) => requiredIds.includes(id));
const missing = required.filter((id) => !views.has(id));
```

- [ ] **Step 3: 重跑布局单测**

运行：

```powershell
node --test tests/panel-tree.test.js tests/panel-layout-store.test.js
```

预期：全部通过；旧调用方未传 `requiredIds` 时，测试结果与当前行为一致。

---

### Task 2: 为目标工具增加工作台面板注册适配

**Files:**
- Modify: `kaiwu/app/lib/manifest-schema.js`
- Modify: `kaiwu/app/runtime/loader.js`
- Modify: `kaiwu/app/main.js`
- Modify: `kaiwu/plugins/bilibili/plugin.json`
- Modify: `kaiwu/plugins/douyin/plugin.json`
- Modify: `kaiwu/plugins/music/plugin.json`
- Modify: `kaiwu/plugins/palette/plugin.json`
- Modify: `kaiwu/plugins/subtitle/plugin.json`
- Modify: `kaiwu/plugins/hello.tool.js`
- Test: `kaiwu/tests/manifest-schema.test.js`
- Test: `kaiwu/tests/loader.test.js`
- Test: `kaiwu/tests/plugins-manifest.test.js`

**Interfaces:**
- 目标工具清单字段为 `workspacePane: true`；缺省或 `false` 的其他工具仍是普通工具页内容。
- 稳定工作台视图 ID 为 ``tool:${pluginId}:${toolId}``，标题沿用工具标题，pane spec 标记 `optional: true`。
- `loadPlugins()` 新增可选 `fetchText` 参数，默认使用 `fetch(url).then(response => response.text())`；应用入口显式传入已有 `fetchText`。
- pane spec 的 `mount(host)` 调用既有 `mountTool({ descriptor, toolSpec, instance, container: host, ctx, fetchText })` 并返回其 teardown 句柄，不另复制 HTML/CSS 注入或 setup 逻辑。

- [ ] **Step 1: 写清单与加载器失败测试**

在 `tests/manifest-schema.test.js` 增加断言：`workspacePane: true` 经校验后保留；非布尔值报在 `contributes.tools[0].workspacePane`。在 `tests/loader.test.js` 增加两条测试：未标记的工具不生成 pane；标记的工具在插件激活后生成 `tool:<pluginId>:<toolId>`、`optional === true` 且有 `mount` 函数，加载插件时不提前执行 setup。

运行：

```powershell
node --test tests/manifest-schema.test.js tests/loader.test.js
```

预期：新增测试失败，现有测试通过。

- [ ] **Step 2: 实现清单字段和运行时 pane adapter**

在清单 schema 中验证并保留布尔字段 `workspacePane`。加载器在 `instance.activate(ctx)` 成功后，从该插件所属的工具注册项中筛选 `workspacePane === true`，并按 Task 2 接口登记 optional pane。这样文件夹插件使用清单声明，`hello.tool.js` 则在 `ctx.tools.register({...})` 中声明同一字段。

为 `loadPlugins()` 注入 `fetchText`，让 `mountTool()` 仍按插件入口 URL 解析 `panel.html` / `style.css`，并沿用已有 setup 与 teardown。把 `workspacePane: true` 加到指定 5 份 `plugin.json` 的工具项以及 `plugins/hello.tool.js` 的注册项；不更改其余工具定义和服务声明。

- [ ] **Step 3: 钉住范围并运行运行时测试**

在 `tests/plugins-manifest.test.js` 增加范围断言：5 个文件夹插件的目标工具都标记为工作台面板。单文件插件入口的标记由 `tests/loader.test.js` 的运行时注册用例验证。随后运行：

```powershell
node --test tests/manifest-schema.test.js tests/loader.test.js tests/plugins-manifest.test.js tests/mount.test.js
```

预期：面板注册测试通过，未标记工具的旧注册行为与 `mountTool()` teardown 测试不变。

---

### Task 3: 按需挂载、释放并加入工作台

**Files:**
- Create: `kaiwu/app/lib/pane-lifecycle.js`
- Modify: `kaiwu/app/main.js`
- Modify: `kaiwu/app/shell/panel-workspace.js`
- Modify: `kaiwu/app/shell/content.js`
- Test: `kaiwu/tests/pane-lifecycle.test.js`
- Test: `kaiwu/tests/panel-workspace.test.js`

**Interfaces:**
- 新建 `createPaneLifecycle({ mountPane })`，返回 `activate(viewId, host)`、`reconcile(openViewIds)`、`dispose()`。
- `activate()` 对同一视图并发或重复调用只挂载一次；挂载完成前视图已关闭时立即 teardown，不把过期宿主留在界面。
- `reconcile()` 收到当前布局中的所有标签视图；只有目标视图从布局移除时才 teardown。移动或切换标签不应误卸载仍然打开的工具。
- `createPanelWorkspace()` 接收 `requiredIds`（默认全部 `panes` key），存档读回后的归一化与校验均使用它；否则渲染层二次归一化会把可选视图重新补回。
- `content.showHint(text)` 只负责工具页引导空态；普通、未迁移工具继续通过 `content.show(toolId)` 挂载。

- [ ] **Step 1: 写 pane 生命周期失败测试**

新增 `tests/pane-lifecycle.test.js`，覆盖：同一已打开视图重复 activate 只 mount 一次；视图仍在布局时切换活动标签不 teardown；视图从布局移除时调用一次 teardown；异步 mount 尚未完成便移除时，句柄一返回就 teardown。运行：

```powershell
node --test tests/pane-lifecycle.test.js
```

预期：测试因模块或行为尚不存在而失败。

- [ ] **Step 2: 实现可取消的惰性挂载管理器**

在 `app/lib/pane-lifecycle.js` 维护 `openViewIds`、已挂载句柄和进行中的 mount Promise。`activate(viewId, host)` 只接受当前布局已打开的视图；`reconcile(openViewIds)` 更新打开集合、teardown 已关闭句柄并使过期 Promise 失效；`dispose()` 清理全部句柄。teardown 必须幂等并接住异步错误，不能因一个插件异常阻断其他面板。

- [ ] **Step 3: 接入工作台布局与可选 pane 生命周期**

在 `app/main.js` 构造 `knownIds` 与 `requiredIds`：`knownIds` 包含全部内建和插件视图，`requiredIds` 排除 `spec.optional === true` 的工具 pane；同时把 `optional` 从 pane spec 保留到工作台视图表。将 `requiredIds` 传给 `initialTree` 收编、`createLayoutStore` 与 `createPanelWorkspace()`。在 `app/shell/panel-workspace.js` 中把它用于存档读回后的 `normalizeTree()` 与 `validateLayout()`。

用 `createPaneLifecycle()` 管理工具 pane：工作台活动标签回调在对应宿主已插入 DOM 后调用 `activate()`；布局回调通过 `viewsOpenIn(tree)` 的视图集合调用 `reconcile()`。不再在工作台启动末尾无条件 mount 所有目标工具；普通必需插件面板保持原挂载时机。

- [ ] **Step 4: 实现工具列表启动器与重复打开聚焦**

在 `app/main.js` 的侧栏选择回调中区分标记工具：自动选择 (`user === false`) 只更新选中态与引导文案，不加入工作台；用户点击时先切到笔记工作台并等待其可见，再检查 `viewsOpenIn(tree)`。视图已打开则 `workspace.focusView(viewId)`；否则用既有 `addPane(tree, viewId, { anchorId: workspace.currentPane(), dir: 'row', side: 'right' })` 加入并 `workspace.applyTree(next)`，之后聚焦该视图。非目标工具仍切换到“工具”视图并调用 `content.show(toolId)`。

在 `app/shell/content.js` 暴露 `showHint(text)`，为目标工具选择和空工具页显示“从左侧选择工具，在工作台中打开”的简洁提示。保持 `sidebar.js` 的搜索、选择态和错误卡片行为。

- [ ] **Step 5: 验证生命周期与工作台回归**

运行：

```powershell
node --test tests/pane-lifecycle.test.js tests/panel-workspace.test.js tests/panel-tree.test.js tests/panel-layout-store.test.js
```

预期：新开的视图只出现一份；可选视图缺席不触发布局回退；现有工作台交互与四个内建必需视图测试通过。

---

### Task 4: 更新 Electron 自检并完成重启验收

**Files:**
- Modify: `kaiwu/electron/selftest.js`
- Modify: `kaiwu/app/main.js`（仅在自检暴露的只读状态需要补充时）

**Interfaces:**
- 自检以工作台视图 ID ``tool:${pluginId}:${toolId}`` 定位已打开面板，并以宿主 `data-pane-plugin` 定位面板 UI。
- 工具业务操作仍在原有面板 HTML 中完成；自检不得再把目标工具的内容错误地限定在 `#content`。

- [ ] **Step 1: 更新启动与工具行为自检**

在 `electron/selftest.js` 的工具页/插件用例中增加断言：初始布局没有 6 个可选工具视图；从侧栏选择目标工具后切到笔记工作台并出现对应 pane；再次点击没有重复实例；已打开 pane 的宿主包含原工具 DOM。把现有 B 站、抖音、音乐等行为用例中的目标容器查询从 `#content` 改为对应 `[data-pane-plugin="<pluginId>"]`，并共用一个按 `toolId` 定位与等待工作台 pane 的自检 helper。

- [ ] **Step 2: 运行完整测试与桌面自检**

在 `E:\project\kaiwu` 运行：

```powershell
npm test
npm run selftest
```

预期：Node 测试全通过；Electron 自检验证原插件功能与新工作台入口均成功。若既有失败出现，记录具体失败用例，不把它归因于本次改造，先确认是否由修改触发。

- [ ] **Step 3: 重启开物并检查实际交互**

按用户要求，在实现和验证完成后通过项目现有启动方式重启开物。确认启动后的笔记布局没有自动出现 6 个工具；逐项从“工具”入口打开，确认面板可见、可停靠、重复点击不复制；至少选择一个面板调整分栏后再次重启，确认存档恢复且未打开工具仍保持缺席。完成桌面操作后按 `操作汇报` 技能生成本次操作报告。

---

## Self-review

- 规格范围：Task 2 覆盖六个指定工具和功能保持；Task 3 覆盖启动器、去重、按需打开和面板生命周期；Task 1 与 Task 4 覆盖布局兼容、重启恢复和回归验证。
- 默认布局：`requiredIds` 默认仍等于 `knownIds`，因此未标记的现有插件面板和所有旧调用方保留必需视图语义；仅明确标记的六个工具变成可选视图。
- 自检边界：目标工具 DOM 改由 `mountTool()` 放入独立 pane 宿主，原 `#content` 仍服务于未迁移工具；Electron 自检必须同步调整容器定位。
- 改动隔离：该计划要求逐个路径审查现有 staged/unstaged diff，测试期间不 reset、不 checkout、不批量重置索引，也不提交无关改动。
