# 日程面板实现计划

> **For agentic workers:** Execute inline in this worktree. Preserve unrelated changes; do not commit or push.

**Goal:** 在开物里实现方案 A 的日程工具面板，并本地保存混合日程与待办。

**Architecture:** 新增文件夹插件 `plugins/schedule/`，沿用现有插件扫描、面板挂载、CSS 隔离和 `ctx.settings` 持久化。界面以左侧月历和右侧当日日程为主，窄宽度时纵向排列。

**Tech Stack:** Electron renderer plugin, HTML, scoped CSS, vanilla JavaScript, plugin settings IPC.

## Global Constraints

- 仅新增 `plugins/schedule/` 和本计划/设计文档；保留仓库中其他未提交改动。
- 不新增外部依赖，不接外部日历或网络服务。
- 不添加或运行测试；完成后做 JavaScript 静态语法检查。
- 不提交、不推送。

---

### Task 1: 注册日程工具并建立方案 A 面板结构

**Files:**
- Create: `plugins/schedule/plugin.json`
- Create: `plugins/schedule/panel.html`
- Create: `plugins/schedule/style.css`

**Interfaces:**
- 清单注册工具 `schedule`，标题“日程”，图标使用日历字形，启用 `settings` 权限和可停靠面板。
- 面板提供月历、月份导航、当天事项区和新增/编辑表单的 DOM 锚点。
- 插件私有样式覆盖月历、状态标记、时间线、待办和表单，并在窄宽度下改为纵向布局。

- [x] 新建插件清单与面板骨架，确保选择日期、月份导航、事项表单都通过带 `data-*` 属性的面板内元素表达。
- [x] 添加与开物深色外壳一致的局部样式和窄面板布局。

### Task 2: 实现日期视图、事项操作与本地保存

**Files:**
- Create: `plugins/schedule/index.js`

**Interfaces:**
- `setup(el, ctx)` 读取插件设置键 `entries` 并绑定本面板交互。
- 条目字段：`id`, `date` (`YYYY-MM-DD`), `kind` (`event` 或 `task`), `title`, `start`, `end`, `note`, `done`。
- 保存通过 `ctx.settings.set('entries', entries)`，失败时在面板内显示状态提示。
- `teardown()` 释放 DOM 事件资源。

- [x] 实现本地日期工具、月历网格与当天事项渲染；日期标记来自已保存条目。
- [x] 实现新增、编辑、删除、待办完成切换、月份导航和回到今天。
- [x] 读取/写入插件设置；校验载入的数据并对写入失败给出可见提示。
- [x] 对插件脚本做静态语法检查，并核对改动范围只含计划、设计和 `plugins/schedule/`。
