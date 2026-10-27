# DOCX 内置阅读器实现计划

> **For agentic workers:** 本计划由当前 Codex 会话就地执行，不拆分子代理。每项按顺序完成并在阶段交界检查工作区差异。

**Goal:** 从笔记树打开 `.docx` 文件时，在开物内部标签中安全显示只读正文、目录、搜索和缩放。

**Architecture:** 主进程通过现有 Vault 路径守卫读取 DOCX，并调用 Mammoth 转换为语义 HTML。渲染层将结果解析为 DOM 后按严格标签与属性白名单重建节点，再生成目录、可搜索内容和分页纸张阅读视图；工作台继续使用现有 `{ view: 'doc', doc: relativePath }` 标签身份。

**Tech Stack:** Electron IPC、Mammoth.js、浏览器 DOM、现有笔记树及 panel-workspace 标签机制。

## Global Constraints

- 只读打开，原始 DOCX 字节保持不变。
- DOCX 仅从 Vault 内相对路径读取，沿用 `resolveInsideReal` 的路径边界。
- Mammoth 生成的 HTML 不可信；必须在渲染层白名单净化后再插入 DOM，屏蔽脚本、事件属性、危险链接和远程资源。
- 设置 DOCX 大小上限，解析失败、加密或损坏文档须显示可读错误。
- 不改变 Markdown/TXT 编辑与保存流程，不改布局持久化格式。
- 本次按当前工作区要求，不新增或运行自动化测试；实施阶段只做代码和差异检查，不声称测试通过。

---

## 文件结构

- `electron/notes/docx-reader.js`：Mammoth 转换入口、大小校验与结构化转换结果。
- `electron/notes/docx-reader-worker.js`：隔离 Mammoth 转换，限制堆内存并设置超时。
- `electron/notes/notes-ipc.js`：增加 `notes:readDocx`，在主进程校验路径、扩展名、文件大小并读取。
- `electron/preload.cjs`：将 `notes:readDocx` 加入受限 invoke 白名单。
- `app/notes/docx-reader.js`：净化 HTML、构造目录与阅读器控件、搜索/缩放/分页交互。
- `app/notes/notes-view.js`：DOCX 行改为打开内置 doc 标签，并将只读视图接入现有文档打开流程。
- `app/main.js`：DOC 标签名回退为文件名，排除 DOCX 的 AI 笔记正文上下文，并提供关闭错误标签的回调。
- `app/styles/shell.css`：DOCX 阅读器工具栏、目录侧栏、纸张、表格、图片、错误态及响应式样式。
- `package.json`、`package-lock.json`：添加并锁定 Mammoth 运行时依赖。
- `docs/superpowers/plans/2026-10-17-docx-reader.md`：本计划。

## Task 1: 添加受限的 DOCX 转换通道

**Files:**
- Create: `electron/notes/docx-reader.js`
- Create: `electron/notes/docx-reader-worker.js`
- Modify: `electron/notes/notes-ipc.js`
- Modify: `electron/preload.cjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**接口：**
- `convertDocxBuffer(buffer)` 输入 Buffer，返回 `{ html, messages }`。
- IPC `notes:readDocx({ path })` 只接受 Vault 相对路径，返回 `{ html, messages, size, mtimeMs }`。
- 源文件与转换 HTML 各自上限为 64 MiB；扩展名必须是 `.docx`，必须是普通文件。

- [x] 添加运行时依赖 Mammoth，并实现转换函数。转换时显式保持 `externalFileAccess: false`，从 Buffer 输入，在 256 MiB 堆上限与 15 秒 Worker 截止时间内使用默认语义映射；源和输出各限 64 MiB，不读取/写入额外文件。
- [x] 在 `notes-ipc.js` 中复用 `requireVault()` 和 `resolveInsideReal()`，验证路径、文件类型、扩展名及大小后读取 Buffer，再返回转换结果和文件元数据。
- [x] 在 preload 白名单中仅新增 `notes:readDocx`，渲染层仍只传 `{ path: string }`。
- [x] 检查 IPC 返回对象不包含绝对路径或文件 Buffer。

## Task 2: 构造安全只读阅读器

**Files:**
- Create: `app/notes/docx-reader.js`
- Modify: `app/styles/shell.css`

**接口：**
- `createDocxReader({ document, root, html, fileName, size, mtimeMs, openExternal })` 将安全阅读器挂到 `root`，返回 `{ destroy() }`。
- 只保留 `p`, `h1`–`h6`, `strong`, `em`, `u`, `s`, `del`, `sub`, `sup`, `br`, `hr`, `ol`, `ul`, `li`, `table`, `thead`, `tbody`, `tr`, `td`, `th`, `a`, `img`, `blockquote`, `pre`, `code`。
- `a` 只允许 `https:`、`http:`；`img` 只允许 PNG/JPEG/GIF/WebP 的 base64 data URL。移除其他标签、属性、样式、锚点脚本及远程资源。

- [x] 通过 `DOMParser` 解析转换片段，以新建 DOM 节点逐层复制白名单元素与文本，不把原始转换字符串直接赋给真实页面。
- [x] 为没有标题的文档提供“正文”目录项；对标题生成稳定的阅读器内 ID 和可跳转目录。
- [x] 创建搜索框与上一个/下一个命中操作，匹配结果滚动到视口并短暂高亮；清空搜索时移除高亮状态。
- [x] 创建缩小、放大、适合页面和当前页/总页数控件；缩放范围为 60%–180%，每次 10%。
- [x] 将正文按可用页面高度切为独立纸张；窗口宽度或缩放变化后重新排版，单个超高块允许溢出并保持可读。
- [x] 使用新增的 `.docx-reader*` 样式类实现深色外壳、浅色纸张、目录区、页边距、表格与图片约束、错误信息和窄视口滚动。

## Task 3: 接入笔记树与现有 DOC 标签

**Files:**
- Modify: `app/notes/notes-view.js`
- Modify: `app/main.js`

**接口：**
- `open(relPath, { source })` 按 `.docx` 分流；主进程返回 `{ html, messages, size, mtimeMs }`。
- `otherItem()` 遇到 `.docx` 时调用现有 `open()`；其他非笔记文件仍调用 `notes:openPath`。

- [x] 导入 `createDocxReader` 并记录当前 reader disposer；切换文件、设置 Vault 或重新打开文档时先销毁旧 reader。
- [x] 在 `open()` 中调用 `notes:readDocx`，设定只读标题/路径，隐藏编辑模式与保存控件，在正文容器内挂阅读器。
- [x] 复用现有 `onOpenNote(path, { source })`，保证点击 DOCX 行进入 `{ view: 'doc', doc: path }`，切换回标签时以 `source: 'tabs'` 重载对应文档。
- [x] 保持错误反馈在已有 `noteStatus` 状态栏可见；转换拒绝时不把 HTML 错误插入正文。
- [x] 保存入口、标题改名与 AI 笔记上下文均排除 DOCX；文件移动仍按附件路径处理，不尝试写回。

## 完成检查

- [x] `git diff --check` 与受影响文件差异检查；DOCX 实现未把此前已有工作区修改纳入本计划文件。
- [x] 检查新 IPC 通道只有 Vault 相对路径输入，返回值不暴露绝对路径。
- [x] 静态检查 DOCX 打开路径均只读，转换内容先经过 DOM 白名单净化。
- 根据当前指令，不运行自动化测试或自检脚本；如需运行验证，等待用户明确要求。

## 自审

- 设计覆盖：主进程本地转换、Vault 路径校验、渲染层净化、目录、搜索、缩放、分页、错误提示、原文件不变和 DOC 标签复用均有对应任务。
- 依赖边界：Mammoth 转换只在 Task 1 主进程模块内，界面只消费 `{ html, messages, size, mtimeMs }`。
- 范围边界：不支持编辑、回存、导出、打印，不改现有标签序列化格式。
