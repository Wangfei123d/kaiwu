# Task 2 · 独立笔记画布与自适应平滑实施报告

已实现可挂载的独立笔记画布插件，并在隔离 Edge、真实临时笔记库、真实 canvas IPC 中验证。直接修改既有脏工作区；没有提交、重启应用、调用模型接口、使用用户浏览器或写真实笔记库。Task 1 的 app/electron 存储文件未修改；仅按 Task 2 授权在两份 adoption 表追加落点。

## 实现文件

- plugins/note-canvas/plugin.json：canvas/vault/shell/log 权限；独立 pane `note-canvas`，title/fullTitle 为「笔记画布」。
- plugins/note-canvas/index.js：真实 panes.register、mount/dispose；主动 fetch style.css 并使用公共 scopeCss(css,'note-canvas') 注入。
- plugins/note-canvas/canvas-view.js：画布列表、新建表单、库内笔记/图片素材、工具条、保存状态、节点/连线/菜单/编辑器、原笔记编辑、拖放、生命周期。
- plugins/note-canvas/style.css：宿主作用域内暗色界面、图片 contain、窄于 600px 时折叠素材栏；窄面板「素材」按钮可展开覆盖侧栏。
- plugins/note-canvas/navigation.js：可注入 RAF/时钟的指数导航和松手惯性。
- plugins/note-canvas/session.js：800ms 防抖、单写串行 CAS 快照队列、模块内 vault/path 草稿恢复、最新 session ownership。
- app/main.js、app/lib/panel-tree.js：仅新增 `'note-canvas': {anchor:'doc',dir:'row',sizes:[60,40]}`；既有保存布局由现有 adoption 机制保留。
- tests/canvas-navigation.test.js、tests/canvas-session.test.js、tests/note-canvas-integration.test.js：20 项单元/集成用例。
- tools/check-note-canvas.cjs：真实插件源码 + 真实主进程 IPC 的独立临时库浏览器验证。
- docs/superpowers/plans/note-canvas-check.png：真实浏览器截图（交互验证后的视口，复制节点按规定偏移，因此有重叠）。

## 实际接口与安全边界

UI 对所有生产请求显式传当前 library/board 返回的 opaque vault token：

```
canvas.library()
canvas.create(name, vault)
canvas.read(path, vault)
canvas.write(path, graph, revision, vault)
canvas.importImage(boardPath, {name, bytes:ArrayBuffer, mimeType}, vault)
canvas.media(file, vault)
canvas.readNote(path, vault)
canvas.writeNote(path, text, revision, vault)
```

引用笔记编辑不调用 ctx.vault.writeText。每次打开编辑器重新读取原文件；保存前重新读取并比较原文本和 revision，然后经绑定 token 的 writeNote CAS 保存。成功后清除该引用缓存、重新读取所有同文件卡片。非 UTF8/readonly 笔记禁编辑按钮与保存。原笔记 textarea 没有文本节点的 200000 字符 maxlength，浏览器证据用超过该长度的真实 .md 原文证明完整显示；临时 text 节点仍限制 200000。

Markdown 使用公共 renderMarkdownNodes(docFacade,text,{tables:true})。安全 doc facade 在创建节点前把 img 替成无 src 行为的占位 span，避免 renderer 自动识别远程图片 URL 时发网络请求；TXT 用 textContent。正文链接 preventDefault，验证 HTTP/HTTPS 后明确交给 ctx.shell.openExternal；不创建 iframe。新链接表单拒绝 javascript:，不使用 window.prompt。

图片使用文件 bytes 导入，graph 只保存库内相对 file；媒体 dataUrl 仅用于展示。File.type 为空时按照受支持扩展传 canonical MIME，后端仍校验 magic。笔记树自定义拖动经 drag-bus onEnd 订阅，仅落在本画布且 insideTree=false 的 md/txt/位图引用可添加，使用 relPath，不使用 absPath；销毁退订。自身素材支持点击与 native drag，外部图片支持 drop/file input。

异步读取用 epoch/session/vault 校验；library 刷新不会覆写 dirty 图。切库后当前旧画布锁定、停止动画，用户可以导出 JSON 草稿，关闭并重开 pane 进入新库。回到原库重新挂载可恢复 keyed 草稿。失败 flush 阻止普通切画布。关闭不静默丢弃：模块缓存保存 graph、原 revision、编辑器原文本/草稿；「导出草稿」包含 graph 与 editDrafts。缓存仅在应用当前进程存活期间存在，重启前需要导出以获得文件级保留。

## 已实现交互

- Text Markdown 双击/按钮编辑；原笔记显式编辑并同步其他引用卡；图片 contain；安全网页打开；分组包含卡片并一起移动。
- 非编辑区域及正文超过 5px 阈值后直接拖动，阈值前不 capture、不重建 DOM，按钮/链接 click/dblclick 保留。Alt 可选择正文；已有正文选区保留原生 Ctrl+C。角标 resize、空白框选、Shift 增选。
- 四侧 ports 点源再点目标或拖动连接，拒绝自连；SVG 连线双击标签编辑与移除。
- 宿主内右键复制/粘贴/删除；本地节点剪贴板复制内部连线，粘贴更新所有 IDs 并偏移。文本编辑字段 Delete 不走节点删除。
- 所有卡片 DOM 查找以 dataset ID 等值匹配，支持 JSON Canvas 合法的引号/括号/Unicode ID。
- 连续添加使用可见范围内未占用空位，避免新卡片完全重叠。

## 导航参数与生命周期

导出 createNavigation({view,onFrame,onSettled,requestFrame,cancelFrame,now,reducedMotion})；提供 pan、zoom、set、stop、dispose、view getter，另实现 coast(vx,vy)。view 是 translate(x,y) scale(scale)。初始与 set 视口坐标使用 finite fallback，scale clamp 0.25–2.5。

离散轮 tau110ms、trackpad38ms、zoom100ms；指数趋近，无过冲；时间步独立。连续事件累积并允许反向，zoom 每帧维持指针世界锚点。普通 wheel 平移、Shift 垂直转横移、Ctrl/Meta wheel 缩放（正文内也缩放）；line/page 模式转像素。Space/中键平移直接跟手，释放 coast95ms 衰减，数学总位移最多75px；节点拖动直接改图坐标。

正文 wheel 独立平滑 scrollTop/Left，无画布冒泡；到边界同步真实 scroll position，因此继续滚到边界后反向可立即向内移动。系统 reduced motion 与 html[data-motion=off] 关闭缓动/惯性；监听 kaiwu:motion 与 media change。blur、pointercancel、document hidden、切画布、host 隐藏/脱离、dispose 均停止帧。ResizeObserver 与每帧 host visibility guard 覆盖 shell 把关闭 tab 宿主移入隐藏 stack 的情况。generation guard 确保 onFrame 调用 stop/dispose 后不复活 RAF。

相机停止时的实际限制：视口只在导航自然 settled 或手动平移松手时标 dirty。动画中途 blur/hidden/切板/dispose 的 stop 可能让中间相机位置不落盘，重新打开恢复上一次已记录视口；节点内容与编辑草稿不受影响。没有为此观感问题扩大本次修改。

## RED / GREEN 证据

首次导航/集成 RED：

```
D:/nodejs/node.exe --test tests/canvas-navigation.test.js tests/note-canvas-integration.test.js
```

缺 navigation.js 与 manifest 的预期缺实现失败；修正测试中既有 split 参数顺序后实现，初版 10 pass。后续真实 RED 覆盖：初始 invalid viewport 未归一化、onFrame stop 后 RAF 复活；修复后通过。

Session 首轮 RED 为缺 session.js；实现后串行快照/失败恢复/原 revision/重挂载/库响应不匹配/clean 无样例通过。主代理发现旧 session 回调覆盖新草稿后，新增三项真实 RED：

1. A pending save + dispose；B 恢复后编辑 newer + dispose；A 成功导致 C 恢复仅 first，新 newer 丢失。
2. A 旧失败回调覆盖 B 的 newer 草稿。
3. B 已保存 clean 后，A 旧失败回调复活旧草稿。

每 vault/path 增加最新 session Symbol owner，只有当前 owner 可更新/删除恢复缓存。三项全 GREEN；保留旧 revision，不自动 rebase 覆盖磁盘。最终单测：

```
D:/nodejs/node.exe --test tests/canvas-navigation.test.js tests/canvas-session.test.js tests/note-canvas-integration.test.js
```

20 tests / 20 pass / 0 fail / 0 skip，最后一次 110.5379ms。

浏览器测试先于 UI 实现运行：等待「新建画布」超时（模块缺失），是实际 UI RED。后续真实浏览器 RED 并修复的行为包括：正文滚到边界后再次滚到边界再反向无响应、正文 Ctrl wheel 未缩放、正文链接未调用 shell、原生正文 Ctrl+C 被节点复制截获、当前板点击不能取消 pending 旧 read、原笔记编辑器重开仍用外部修改前缓存、特殊合法 ID 导致 querySelector SyntaxError。特殊 ID 用例还暂时恢复原坏选择器，明确见到该 SyntaxError 后恢复修复并 GREEN。

## 真实浏览器验证

```
D:/nodejs/node.exe tools/check-note-canvas.cjs
```

最后运行 exit 0，9.135s。独立 Playwright `channel:'msedge', headless:true`；server 只映射 app/lib 与 plugins/note-canvas，真实 IPC registration、真实临时 .canvas/.md/image IO；没有 mock 掉读写、CAS、原子保存或媒体导入。HTTP 包装只提供模拟 IPC 通信和明确失败/延迟控制。

已实际断言：

- 创建、保存、读盘、重挂载；pane 样式真正生效，窄 330px 宿主画布 >300px。
- Markdown 标题/加粗/安全链接/远端图片占位；全程零外部 network requests。
- 超过 200000 字符的原笔记编辑器全文与 maxlength=-1；原文件保存 + 两张引用同步。
- 原文件被外部编辑时保存失败，磁盘外文保留、编辑器草稿保留；重开能读最新原文。
- 非 UTF8 原笔记编辑按钮禁用。
- 正文普通 wheel 独立滚动与边界反向；正文 Ctrl wheel 缩放；原生选区 copy 放行。
- 正文拖动、resize、Shift 多选、空白框选；点 ports、拖 ports；SVG 标签；分组带成员。
- 键盘复制粘贴和真实右键菜单复制粘贴，节点新 ID 与偏移；安全链接拒绝与打开。
- File.type 为空的真实 PNG file input 导入、真实 assets 文件、预览完成、object-fit contain。
- 画布 wheel 多帧、真实 Ctrl wheel 三个采样帧世界锚点（误差 <0.01）；motion off 零待执行 RAF。
- 保存失败保留并重挂载恢复/重试；失败 flush 不切板；延迟 read 后点击当前板取消旧响应。
- 合法特殊 ID 卡片真实 pointer 拖动。
- 切库阻止继续改旧图，草稿导出下载，目标新库无任何文件；关闭/重开回原库后 keyed 草稿恢复。
- pane 隐藏与 dispose 待执行 RAF 为 0；零 pageerror / console.error；每个非 library API 调用显式 token。

最终语法检查 canvas-view.js/navigation.js/session.js/check-note-canvas.cjs 均 exit 0；指定 owner 文件 git diff --check exit 0。主代理另报告全量 2027 项、2026 pass、1 skip、0 fail，完整全量记录以主代理报告为准。

## 尚未独立验证与交接

代码已包含笔记树 drag-bus、自身素材 native drag、外部 OS 图片 drop、Space/中键拖动、pointercancel/blur/doc visibility、连线删除/自连拒绝、编辑期间 Delete 和编辑器草稿重挂载。浏览器 fixture 没有逐项独立断言这些交互；松手 coast 参数与停止/销毁机制已有 fake RAF 用例。没有在当前运行中的真实应用装载/重启验收；按用户要求保留该边界。

样式与截图已实际查看。没有新增设计需求或存储权限，无待实现的核心阻塞。当前源码/测试稳定，交主代理进行独立规格与质量审查。

## Final fix wave · stale connection state（2026-10-09）

本波仅修改 `plugins/note-canvas/canvas-view.js`、`tools/check-note-canvas.cjs` 并追加本报告。fixture 按既有行为刷新 `note-canvas-check.png`。没有提交、stage、reset、重启应用、使用用户浏览器、写真实 Vault、调用模型或修改后端/共享 app 文件及其他脏改动。

根因：点 port 后 `portSource` 独立保存在 mount 闭包。删除其节点与新建画布没有清除它，`connect()` 又直接插入连线而未检查当前图端点。`renderEdges()` 跳过缺失端点，因此坏边不可见；真实 IPC 的图校验随后拒绝写入。既有后端拒绝非法图是正确行为，本波修正生成非法图的 UI 路径。

### 实际 RED（生产源码保持原状）

先添加两条真实隔离 Edge 回归，再运行：

```
D:/nodejs/node.exe tools/check-note-canvas.cjs
```

exit 1；同一次运行独立收集两条失败，未因第一条失败跳过第二条：

- `delete: submitted graph contains no dangling connection endpoints`：新增两个文本卡片，选择源、点源右 port、Delete 删除源、点剩余卡左 port、保存。submitted graph 实际含 1 条边，fromNode `289cce3a-eabc-4f31-8f0f-6c672c9fe2d3` 已不在 nodes；visibleEdges=0；真实 IPC 返回 `连线端点不存在`。
- `new-board: submitted graph contains no dangling connection endpoints`：点旧板文本卡右 port，新建板、加文本卡、点其左 port、保存。submitted graph 实际含 1 条边，fromNode `d7b7c2e6-203a-4547-be91-d86be1a82971` 仅属于旧板；visibleEdges=0；真实 IPC 同样返回 `连线端点不存在`。

两个预期 `dangling=[]` 断言实际均得到单元素数组；最后集合断言为 `2 !== 0`。因此 RED 检查实际非法提交及真实保存失败，不依赖仅检查 UI 文案。

### 最小修复与自审

- 新增统一 `clearConnection()`，同时清除 pending source、connecting port 样式及 active port gesture/pointer capture。source 被删时取消；open/new board、取消 pending board read、库切换及 stopMotion 生命周期清理；Escape、pointercancel 同样走统一清理。
- `connect()` 在插入前检查 editable session，并验证 source 与 target ID 同时属于当前 session.graph.nodes；任何失效事件都不能写入坏边。现有自连拒绝保留。未开始连接时，失效 detached source port 也不能设为 pending source。
- renderGraph 重建卡片时为仍存在的 pending source 恢复 connecting 样式；删除另一张卡不会丢失该视觉状态。新板创建开始及成功安装 session 均清理，避免请求期间残留状态跨板。
- 自审逐条跟踪正常 click、drag 的 source 消费，Delete 的源/目标路径，session 替换，取消事件与 DOM 重建；没有修改图保存格式、后端拒绝策略、正常连线内容或导航参数。

### 实际 GREEN（最终稳定源码）

```
D:/nodejs/node.exe --test tests/canvas-navigation.test.js tests/canvas-session.test.js tests/note-canvas-integration.test.js
D:/nodejs/node.exe tools/check-note-canvas.cjs
D:/nodejs/node.exe --check plugins/note-canvas/canvas-view.js
D:/nodejs/node.exe --check tools/check-note-canvas.cjs
git diff --check -- plugins/note-canvas/canvas-view.js tools/check-note-canvas.cjs docs/superpowers/plans/note-canvas-ui-report.md
```

最终 covering tests：20 tests / 20 pass / 0 fail / 0 skip，107.8494ms。最终完整 fixture exit 0；四条独立真实 browser + temporary Vault + real IPC 路径均输出 `dangling:[]`、`saveError:null`、`visibleEdges:0`：

1. 删除 pending source 后点击剩余 port；新点击明确处于 fresh pending 状态。
2. 新建画布后点击新板 port；旧 pending/connecting 状态已清除。
3. pending source 保留、删除 target、重放该 detached target port 的 click listener；connect 端点校验拒绝插入，source 视觉在 target 删除后的 DOM 重建仍正确。
4. port drag 已超过阈值并 capture，Delete 源后松手；取消的 gesture 不创建边。

每条均断言 submitted graph 的全部 endpoints 存在、真实 IPC save 无 error、UI 到达已保存；再直接读盘断言剩余 1 个节点、0 条 edge、磁盘 endpoints 有效。原完整 fixture 的有效 click/drag 连线、标签、保存重载等继续通过；新增 Escape/pointercancel 清除视觉与自连拒绝断言通过。语法检查及 scoped diff --check 均 exit 0（这些 scoped 文件原为未跟踪文件，git diff --check 本身不遍历未跟踪内容；patch 已另行自审）。

随后另用 Node 对三个 scoped 文件逐行检查 `/[ \t]+$/`，明确覆盖未跟踪文件；exit 0，输出 `PASS syntax, scoped diff check, and explicit whitespace check including untracked files`。

源码已稳定，停止源代码编辑，交根代理进行最终全量运行与独立修复复审。本波未额外运行全量。剩余 concern 仅为前文记录的 Minor：动画中途 stop 可能不保存中间相机位置；无核心内容丢失，本波不扩展处理。
