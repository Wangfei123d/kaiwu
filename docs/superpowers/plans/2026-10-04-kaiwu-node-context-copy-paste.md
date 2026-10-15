# 开物画布节点右键复制粘贴实施计划

> **For agentic workers:** 依照本计划在当前工作区逐项执行；不创建分支、不提交代码，也不覆盖其他已有改动。

**Goal:** 停用图片拖入画布时复制成新节点的行为，改为复制已有画布节点并通过右键粘贴生成副本。

**Architecture:** 在短剧画布插件中维护当前项目作用域内的节点剪贴板快照。节点右键菜单复制当前选中节点（或选中组），画布空白处右键粘贴；副本拥有新 ID、保留节点参数与尺寸但不复制连线。图片拖放入口不再新建节点，其余文本、Word 与视频拖入逻辑保持不变。

**Tech Stack:** Electron preload/IPC、短剧插件 JavaScript、原生 DOM contextmenu 和键盘事件。

## Global Constraints

- 只修改 `plugins/drama/` 与已确认的图片拖入专用 IPC/辅助函数。
- 图片文件仍可通过图片输入节点自身的“导入参考图片”按钮添加。
- 节点复制只在原短剧项目中可粘贴；参数与图片引用保留，连线不复制。
- 不运行自动化测试或提交；只做允许的语法及差异静态检查。

---

### Task 1：添加节点剪贴板与菜单粘贴

**Files:**
- Modify: `plugins/drama/index.js`
- Modify: `plugins/drama/menu.css`

**Steps:**
- 增加在插件会话内有效的剪贴板快照：保存源项目名、节点类型、标题、参数、尺寸与相对位置。
- 节点右键菜单显示“复制节点”或“复制所选节点 (N)”；复制已选组时保留组内坐标差异。
- 画布空白处菜单显示“粘贴节点”并在右键位置放置；`Ctrl+C` 与 `Ctrl+V` 作为同一操作的键盘快捷键，输入框内不劫持系统复制粘贴。
- 粘贴生成全新 ID、复制可序列化参数与 `w/h` 尺寸，不复制任何边；选中并保存新副本。
- 如果剪贴板来自另一短剧项目，禁用粘贴并给出可见状态。

### Task 2：关闭图片拖放复制入口

**Files:**
- Modify: `plugins/drama/drop-bus.js`
- Modify: `plugins/drama/drop-preview.js`
- Modify: `plugins/drama/index.js`
- Modify: `plugins/drama/style.css`
- Modify: `app/runtime/ctx.js`
- Modify: `electron/preload.cjs`
- Modify: `electron/drama/drama-ipc.js`
- Modify: `electron/drama/lib/skill-resources.js`
- Delete: `plugins/drama/image-drop-layout.js`

**Steps:**
- 图片由系统文件拖入或应用资源总线拖入画布时，不创建图片输入节点；拦截浏览器默认打开文件行为，并提示先在图片输入节点导入图片，再右键复制节点。
- 移除图片拖动预落位层与布局算法；保留 Word 拖动预览。
- 删除仅用于外部图片拖入的批量导入 IPC/context bridge/主进程辅助函数；保留既有单张项目图片导入 API。
- 文本、Word、视频资源拖入以及图片节点“导入参考图片”按钮保持可用。

### Task 3：静态核对

**Files:**
- Review: 上述改动文件

**Steps:**
- 检查修改后脚本语法、图片拖放事件入口、复制/粘贴菜单与键盘事件作用域。
- 确认没有图片拖入创建节点的残留调用，也没有改动暂存区或提交代码。
- 不运行自动化测试；若静态检查发现问题，先修复再重新检查。
