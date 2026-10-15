# 笔记画布节点内 Markdown 编辑实施计划

> **For agentic workers:** Use this plan task-by-task with review checkpoints.

**Goal:** 在笔记画布原节点中直接编辑并实时渲染 Markdown，不弹出独立编辑面板。

**Architecture:** 复用 `mountLiveMarkdown` 渲染与序列化能力。画布文本节点的编辑直接更新 session 图数据；`.md` 文件节点在节点内暂存并通过现有 revision 校验后写回；`.txt` 保持现有纯文本编辑路径。

**Tech Stack:** Electron renderer, vanilla JavaScript modules, CSS, Node.js test runner, Playwright Edge acceptance harness.

## Global Constraints

- 只对 Markdown 文本节点及 `.md` 文件引用启用 Markdown 编辑；`.txt` 一律保持纯文本。
- `.md` 写回必须通过 `readNote` / `writeNote` revision 校验，冲突时保留草稿且不得覆盖。
- 在已经有大量本地修改的项目目录内就地工作，不重置、不覆盖或提交无关改动。
- 不增加运行时依赖。

---

## 文件职责

- `tools/check-note-canvas.cjs`：真实 Chromium/Edge 测试编辑、保存与版本冲突保护。
- `plugins/note-canvas/canvas-view.js`：把 Markdown 编辑器挂到原节点；管理文本节点更新和 `.md` 文件草稿写回/重载。
- `plugins/note-canvas/session.js`：干净画布仅携带文件草稿恢复时，采用新读取的画布图数据与 revision。
- `app/lib/live-markdown.js`：支持独立的安全 Markdown 渲染 document，并把未加载的远程图像占位符序列化回原始 Markdown。
- `tests/canvas-session.test.js`、`tests/live-markdown.test.js`：覆盖会话 revision 恢复和安全图片序列化。
- `plugins/note-canvas/style.css`：将工具栏与可编辑正文限制在节点内并适配节点尺寸。
- `docs/note-canvas.md`：更新画布操作说明。

## Task 1：先固定节点内编辑的交互回归

**Files:**
- Modify: `tools/check-note-canvas.cjs`

**Interfaces:**
- 现有浏览器 harness 提供真实插件、临时笔记库和真实 canvas IPC；测试通过页面可见状态与临时文件内容断言行为。

- [x] **Step 1: 将原 modal 验收替换为内联编辑验收。** 点击新增文本节点后，直接填充 `.nc-node-body [contenteditable="true"]`；断言 `.nc-overlay` 数量为 `0`，再等待节点内出现格式化的 `h1`。
- [x] **Step 2: 将 `.md` 验收改为节点内保存。** 双击 Markdown 文件节点正文后断言无 `.nc-overlay`；编辑节点内 contenteditable，点击节点头部「保存」，断言临时笔记文件更新。
- [x] **Step 3: 固定冲突和 TXT 边界。** 外部改写 `.md` 后点击节点内保存，断言原文件保持外部内容且编辑草稿仍可见，并提供有确认的「重载原文」；对 `.txt` 节点断言 `contenteditable` 数量为 `0`、正文没有 Markdown 标签。
- [x] **Step 4: 运行 RED 验证。** 运行 `node tools/check-note-canvas.cjs`，确认失败原因是当前仍需 modal，而不是测试启动错误。

## Task 2：最小实现节点内编辑与安全保存

**Files:**
- Modify: `plugins/note-canvas/canvas-view.js`
- Modify: `plugins/note-canvas/style.css`
- Modify: `docs/note-canvas.md`
- Test: `tools/check-note-canvas.cjs`

**Interfaces:**
- `mountLiveMarkdown(root, markdown, { onInput })` 在 `root` 内创建工具栏与可编辑正文，并在输入时回调序列化后的 Markdown。
- `ctx.canvas.readNote(file, vault)` 返回 `{ text, revision, editable, reason, vault }`；`ctx.canvas.writeNote(file, text, revision, vault)` 以 revision 做冲突保护。

- [x] **Step 1: 为文本节点挂载内联编辑器。** 在渲染 `node.type === 'text'` 时调用 `mountLiveMarkdown(body, node.text, { onInput })`；回调只用 `mutate` 更新相同 id 节点的 `text`，不重绘正在编辑的 DOM。
- [x] **Step 2: 为 `.md` 文件节点挂载并保存。** 文件读取成功且 `result.kind === 'markdown'` 后挂载内联编辑器；在节点头部添加默认禁用的「保存」和「重载原文」按钮。输入时将 `{ text, original, revision, editable, reason }` 按 node id 保存在 session extras；保存前重新读取文件并比较 revision 与原文，相同才调用 `writeNote`。成功后清除该草稿并刷新引用缓存；冲突时保留草稿、显示错误，点击重载并确认后读取磁盘最新版。
- [x] **Step 3: 保持纯文本和画布操作边界。** `.txt` 仍走 `textContent` 加 `.nc-text-body`，其现有编辑按钮继续打开纯文本编辑器。删除 Markdown 节点正文/标题的 modal 双击绑定；让节点头部保存按钮以外的标题双击不抢编辑焦点。现有 pointer/key handlers 已跳过 `contenteditable=true`，保持该保护。
- [x] **Step 4: 增加节点样式并更新文档。** 将 `.nc-node-body.live-markdown` 设为占满节点正文的纵向布局；toolbar 固定在正文顶部，可编辑正文使用 `min-height:0; flex:1; overflow:auto; overflow-wrap:anywhere`。说明 Markdown 可在节点原位编辑，TXT 保持纯文本。
- [x] **Step 5: 运行 GREEN 验证。** `node --test tests/live-markdown.test.js tests/canvas-session.test.js`（12/12）和 `node tools/check-note-canvas.cjs`（Edge 浏览器验收）通过，修改文件 `node --check` 通过。全量 `npm test` 遇到 `killImpl 连派生出来的孙进程一起杀掉` 失败后长时间无输出，本轮停止等待；全量结果未完成。

## 自检

- 目标、实现边界和验收标准均映射到 Task 1 与 Task 2。
- 未新增 `.txt` 的 Markdown 渲染；文件节点继续使用已有 revision 比较。
- 不会提交应用源码或测试：目标文件当前属于既有未提交工作的一部分，最终保留改动供用户检查。
