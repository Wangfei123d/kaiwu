# 独立笔记画布与自适应平滑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 将用户已确认的独立笔记画布和自适应平滑一起落地到开物，不改变短剧流水线的语义。

**Architecture:** 新增 note-canvas 插件贡献独立工作区面板。画布采用 JSON Canvas 的 nodes/edges 结构，持久化在当前笔记库的画布目录中；主进程提供受限文件接口，渲染端不访问任意本地路径。画布界面与导航动画独立；节点坐标始终为世界坐标，平滑仅改变视图。

**Tech Stack:** 既有 Electron / ES modules / DOM / node:test，复用 Markdown DOM 渲染与拖拽总线，无新增依赖。

## Global Constraints

- 用户授权直接修改 E:/project/kaiwu；保留所有既有 staged/unstaged 改动，不提交、重置、推送或重启应用。
- 画布面板名为「笔记画布」，从既有窗口面板选择器可打开；不往真实笔记库自动写示例数据。
- 持久化为 <当前笔记库>/画布/<名称>.canvas；支持多个画布，原子写与失败提示，切换之前保存，失败时保留当前草稿。
- 文件卡片引用库内 .md/.txt 或图片；文本卡片存储 Markdown；HTTP/HTTPS 链接仅在明确点击时交给系统浏览器，不自动加载远端网页。
- 交互包括卡片任意非编辑区域拖动、拉伸、空白框选、Shift 多选、连接点拖连线/点击连线、关系标签、分组并整体移动、右键复制粘贴、移除、文本编辑、笔记引用编辑、图片导入、笔记列表拖入。
- 自适应平滑：离散滚轮时间常数 110ms，小量触控板 38ms，缩放 100ms；拖动画布和节点直接跟手，画布松手滑行衰减 95ms、累计位移上限 75px；缩放范围 0.25–2.5；无弹簧过冲。
- Ctrl/Meta + 滚轮绕鼠标缩放；普通滚轮平移，Shift + 垂直滚轮横移。节点内容滚动不带动画布。空格或中键拖动画布；普通空白拖动框选。
- 系统 prefers-reduced-motion 或开物 data-motion=off 关闭缓动与惯性；失焦、取消、切换/关闭时停止动画、释放监听、禁止旧帧写入新画布。
- 新接口仅接受安全相对路径；拒绝越界、符号链接/目录联接逃逸、非 HTTP URL、无效节点、重复 ID、悬空边、非有限坐标、无效图片与超限输入。

## Task 1: 数据与安全存储

**Files:** app/lib/note-canvas.js, electron/notes/canvas-ipc.js, app/runtime/ctx.js, app/lib/manifest-schema.js, electron/preload.cjs, electron/main.js; tests/note-canvas*.test.js。

**Interfaces:**

```js
// JSON Canvas 数据
// graph = { nodes: [{id,type:'text'|'file'|'link'|'group',x,y,width,height,text?,file?,url?,label?}],
//           edges:[{id,fromNode,toNode,fromSide,toSide,label?}], viewport?:{x,y,scale} }
normalizeCanvas(graph); // 返回验证后可序列化的拷贝，失败 throw 中文 Error
registerCanvasIpc({ipcMain,vaultRoot}); // vaultRoot 是函数，每次操作重新取当前笔记库
// plugin permissions:['canvas','vault','shell','log'] 下的 ctx.canvas
ctx.canvas.library(); // -> {boards:[{path,name}],notes:[{path,title,kind}],images:[{path,name}],vault,reason}
ctx.canvas.create(name,vault); // -> {path,graph,revision,vault}
ctx.canvas.read(path,vault); // -> {path,graph,revision,vault}
ctx.canvas.write(path,graph,revision,vault); // -> {path,revision,vault}; 校验旧 revision，冲突不覆盖
ctx.canvas.importImage(path,{name,bytes,mimeType},vault); // -> {file,name,vault}，写在该画布专属素材目录
ctx.canvas.media(file,vault); // -> {dataUrl,vault}，仅库内受支持的图片文件
ctx.canvas.readNote(path,vault); // 复用既有笔记解码与只读语义，返回 revision/vault
ctx.canvas.writeNote(path,text,revision,vault); // 原笔记 CAS 保存，安全 token 绑定
```

- [x] 先写行为测试：空画布与 JSON Canvas 类型、大小与安全输入；实际临时 Vault 建立、读取、保存、冲突、图外路径、切库、图片持久化与非法媒体。缺少生产模块时应失败。
- [x] 实现 normalizeCanvas：最多 1000 节点/5000 边，总 JSON 不超过 8MiB，单文本不超过 200000 字符；保留安全类型字段和 viewport；节点 ID 唯一、边端点存在；file 路径只允许库内相对路径；URL 仅 HTTP/HTTPS。
- [x] 建立主进程 handler：画布目录真实路径守卫；文件修订号按实际磁盘内容 hash；同路径串行化 compare+atomic write；新建禁止覆盖同名。图片最多 20MiB，png/jpg/jpeg/webp/gif/bmp，校验扩展名、MIME 与格式特征，写在画布素材目录；media 拒绝 SVG/HTML 等主动内容。
- [x] 桥白名单、canvas 权限与 ctx.canvas 按既有插件 API 模式接线；在 notesIpc 注册后、窗口加载前注册，vaultRoot:()=>notesIpc.currentVault()。
- [x] 运行 node --test tests/note-canvas*.test.js tests/ctx.test.js tests/manifest-schema.test.js，报告 RED/GREEN 与安全边界。不提交。

## Task 2: 导航与画布界面

**Files:** plugins/note-canvas/plugin.json, index.js, canvas-view.js, navigation.js, style.css; tests/canvas-navigation.test.js; tools/check-note-canvas.cjs。

**Interfaces:**

```js
createNavigation({view,onFrame,onSettled,requestFrame,cancelFrame,now,reducedMotion});
// -> {pan(dx,dy,trackpad),zoom(factor,cx,cy),set(view),stop(),dispose(),get view()}
// onFrame(view) 使用世界层 transform；onSettled 保存最终视图，不逐帧写盘
mountCanvas(host,ctx); // 创建面板并返回 dispose，ctx 提供 Task 1 API
```

- [x] 先为导航写测试：多帧移动、连续目标叠加、反向输入、鼠标锚定、时间步独立、缩放边界、减少动态效果、停止/释放。验证失败后实现指数趋近与有限滑行，不借用 CSS transition 延迟节点拖动。
- [x] 注册独立插件面板，按 drama 插件样式注入模式添加自身作用域样式。面板包含画布列表、新建、笔记库素材、工具条、画布和保存状态；无笔记库时明确提示。
- [x] 使用 JSON Canvas 节点编辑与关系连接，SVG 只绘制连线；用 renderMarkdownNodes 渲染文本，库内 txt 用纯文本显示。所有标题与用户输入通过 textContent/安全 DOM，不嵌入未转义 HTML。
- [x] 保存队列记录 path+revision+graph 快照，写入串行化、失败保留 dirty，切换前 flush；不因跨画布异步回复混入旧卡片/旧媒体。原笔记编辑单独保存，引用重新读取；不存在时保留卡片并显示原因。
- [x] 引入 drag-bus.onEnd 接收 notes 列表的库内文件，原生外部图片 drop 读取 bytes 后经安全导入；复制粘贴为画布局部状态，不写系统剪贴板。
- [x] 浏览器隔离夹具载入实际插件源码并对接临时测试库，验证创建/重载保存、节点编辑、引用同步、图片、链接、拖动/框选/resize、连线、组移动、复制粘贴、平滑锚定/内滚动隔离、异步切换/失败保留；不操作真实库，不调用模型。

## Task 3: 复核与交付

- [x] 独立审查规格与代码质量，修复 Critical/Important；给审查者本轮文件清单和测试报告，不让其混入既有用户改动。
- [x] 运行完整 npm test（使用其同一 node --test 脚本）；失败时区分本轮回归与原有环境问题，保留日志与源文件，不掩盖失败。
- [x] 更新功能说明与任务进度，交付保存位置、打开入口、已验证与未验证范围。提示重启加载新增插件；不自行重启。

## Progress

- Task 1: complete; 221 focused pass, independent spec/quality review clean after encoded-size fix.
- Task 2: complete; 20 focused pass, real-plugin isolated Edge checks pass including four stale-connection paths; independent spec/quality review approved after final fix wave.
- Task 3: complete; final whole-feature review approved, Critical0/unresolved Important0/Minor1 documented. Root final full suite2027 total/2026 pass/1skip/0fail. No application restart, commit, push or user-work cleanup.

## Baseline evidence

2026-10-09，直接工作区基线：D:/nodejs/node.exe --test tests/ctx.test.js tests/manifest-schema.test.js tests/notes-ipc.test.js：154 pass / 0 fail。全量 D:/nodejs/node.exe --test "tests/**/*.test.js"：1984 tests / 1983 pass / 1 skipped / 0 fail，14545.6496ms。没有写入真实 Vault。

Task 1 brief: note-canvas-storage-brief.md；Task 2 brief: note-canvas-ui-brief.md。当前阶段按 subagent-driven-development 顺序实施/审查，不同时派出多个实现者；在用户直接修改且无提交的约束下，审查针对明确 owner files，不创建临时提交或混入原有 dirty diff。

Task1 first review：19新增画布测试 + 198相关回归通过（217/217），主代理独立复跑确认。审查发现 canvas.writeNote 超20MiB内容先落盘后因计算revision失败抛错；真实临时库复现20971521 bytes替换原文。fix wave将限制放在最终编码bytes、backup之前，默认旧notes行为不变。新增ASCII/multibyte/BOM+CRLF/maxBytes四项 RED→GREEN；221项通过，独立重审通过。其余存储规格/质量无阻塞发现。

Task2 root verification：20 focused tests / 20 pass / 0 fail，107.8561ms；真实插件 Edge 临时库夹具 exit0，9.098s；源码语法检查和明确 owner 文件 whitespace 检查 exit0。全量 2027 total / 2026 pass / 1 skip / 0 fail，14481.5412ms。旧 session 回调污染新草稿竞态增加三项实际 RED→GREEN；保留原 revision，不自动覆盖外部修改。中途停止动画的相机位置可能不落盘，内容安全；已在使用说明披露。

Final fix/re-review：独立实际浏览器确认 pending portSource 在删除源/新建板后产生隐藏悬空边；两项真实 RED 后，统一清理连接状态并检查源/目标当前图成员资格。四条浏览器回归（删除源、新建板、失效目标事件、拖动中删除源）校验提交图、真实IPC成功和磁盘内容，全部 GREEN；正常点击/拖连线、自连拒绝、取消继续通过。独立最终重审通过，见 note-canvas-final-review.md。

Root final verification (stable code)：完整 node --test（与 package.json test 脚本同一测试集）2027 tests/2026 pass/1skip/0fail，14409.7721ms；Edge fixture exit0，四条回归 dangling=[]/saveError=null；changed source syntax exit0、tracked scoped diff--check exit0、新增未跟踪源码逐行 trailing-whitespace 检查 exit0。使用说明 docs/note-canvas.md；操作汇报 2026-10-09_233006_笔记画布与自适应平滑.md。既有 kaiwu-kernel 分支与工作区保留，无提交、重启或真实库验收。
