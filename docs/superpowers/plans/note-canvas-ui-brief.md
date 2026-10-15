# Task 2 · 独立笔记画布与自适应导航

用户明确批准「笔记画布 + 自适应平滑一起落盘」。工作区 E:/project/kaiwu 很脏，直接修改且保留所有旧改动；不提交、不重启、不写真实笔记库。读取适用技能，TDD，然后实现，最后报告。

## Owned files

plugins/note-canvas/plugin.json, index.js, canvas-view.js, navigation.js, style.css；tests/canvas-navigation.test.js；tools/check-note-canvas.cjs。需要额外拆分 plugin 内部模块/测试可以新增，不修改 Task 1 拥有的 app/electron 文件。完整计划 docs/superpowers/plans/2026-10-09-note-canvas.md。

集成时另拥有 app/main.js 的 adoption 表与 app/lib/panel-tree.js 的 DEFAULT_ADOPTION 表，只追加 note-canvas placement（anchor doc，sizes[60,40]，复用既有结构，不改用户已保存分栏）；加对应 tests/note-canvas-integration.test.js 验证 manifest 和两份落点一致。新 pane 默认不会通过工具插件自动加载CSS，务必真实注册并挂载检查。窄面板隐藏/折叠素材侧栏，主画布不能因180px sidebar成为细缝。

## Integration

新增插件 id note-canvas，权限 canvas/vault/shell/log，贡献 pane id note-canvas/title 笔记画布/fullTitle 笔记画布。入口 default activate(ctx)，ctx.panes.register({id,title,fullTitle,mount:host=>mountCanvas(host,ctx)})；mount 返回 dispose。pane 的 CSS 不由外壳自动注入，参考 plugins/drama/index.js injectStyles，自行加载 style.css + toolbox://shell/lib/css-scope.js scopeCss(css,'note-canvas')，宿主 data-plugin 由 shell 设置。菜单/对话框保持宿主内，避免未受作用域样式。

生产 API 正在 Task 1 实现，完成后再核对：ctx.canvas.library/create/read/write/importImage/media；细节参见 storage brief/report。graph {nodes:[{id,type:'text'|'file'|'link'|'group',x,y,width,height,text?,file?,url?,label?,color?}],edges:[{id,fromNode,toNode,fromSide,toSide,label?}],viewport?:{x,y,scale}}。JSON Canvas 兼容。只存库内相对路径，图片非 dataURL 持久化。

ctx.vault.readText(path) -> {text,mtimeMs,size,kind:'markdown'|'text',encoding,bom,newline,editable,reason}; ctx.vault.writeText(path,text) 原子保存原笔记。readonly 编码笔记必须禁编辑。编辑前保存原文本，保存前复读防外部覆盖；Vault identity 用 ctx.vault.status/path 或 Task1 token，每次异步结果检查 epoch；切库时旧卡片不得写入新库。

**安全合同修正（2026-10-09）：** Task1 增加 opaque vault token。library/create/read/write 响应含 vault；所有 UI 请求都显式绑定当前 library/board token：create(name,vault)、read(path,vault)、write(path,graph,revision,vault)、importImage(path,image,vault)、media(file,vault)。引用笔记请用新安全 API canvas.readNote(path,vault)->{text,kind,editable,...,revision,vault} 和 canvas.writeNote(path,text,revision,vault)，后端复用原 readNote/writeNote 但绑定 Vault 并 CAS 防外部编辑覆盖。不要用未绑定的 ctx.vault.writeText 进行原笔记保存，因 status 检查后再 write 会有切库竞态。UI显式传 token，不能依赖 ctx缓存。

import {renderMarkdownNodes} from 'toolbox://shell/lib/markdown.js'；返回 Node[]，body.replaceChildren(...nodes)，tables:true。txt 使用 textContent。默认 renderer 链接需处理仅允许 http/https，并用 ctx.shell.openExternal 明确点击打开；不要加载远程图片/iframe，防不安全链接。

import {onEnd} from 'toolbox://shell/lib/drag-bus.js'，订阅自定义笔记树拖动松手 {payload:{relPath,name,ext,kind,absPath},clientX,clientY,insideTree}，insideTree=false 且落点在自己 canvas rect 内才接收，仅 md/txt/png/jpg/jpeg/webp/gif/bmp，只用 relPath，dispose 退订。自身库内素材列表可按钮添加或 native drag。外部图片 drop / file input 用 ArrayBuffer bytes 经 canvas.importImage。

## UI and interactions

暗色、清晰可读，侧栏画布列表/新建/笔记与图片素材，主区工具条、保存状态、网格画布。无配置库明确提示，空库不写样例。新建名字使用自己 inline form/modal，不用 Electron 不支持的 window.prompt。

- 文本卡片支持 Markdown，双击编辑；引用笔记卡读取原笔记，显式编辑原文件，保存后重新读取其他相同引用卡。
- 图片 contain 自适应卡片剩余空间；链接卡只安全 URL 与打开按钮；分组空间包含卡片，移动组带成员。
- 任意非按钮/编辑字段区域按住拖动，正文预览区域也能拖；保持原生按钮/链接/输入/文本选取与滚动。拖动超过阈值才 pointer capture，不要 pointerdown 重建 DOM 破坏 click/dblclick。
- 角标 resize；空白框选，Shift 增选；四边 ports 拖连线与点击 source -> target，拒绝自连，SVG 连接可编辑标签/移除。
- 右键菜单复制/粘贴/删除，本地剪贴板复制选择卡与内部连线，粘贴新 IDs + 落点偏移；Delete 编辑期间不删节点。
- 保存队列 debounced800ms，单写串行并使用 revision；变更计数只清除成功的快照，保存期间新编辑保留；切换前 flush，失败保留草稿/显示重试，不切换。关闭失败提供保留草稿方案（至少内存模块 keyed vault/path 复挂载恢复 + 导出 JSON 按钮）。不得静默丢弃。
- 列表刷新/切库/多个异步读取拒绝旧 epoch 回写，保持 dirty 不覆写。当前库身份变化阻止旧笔记编辑和画布保存，用户可导出草稿。

## Adaptive smooth

export createNavigation({view,onFrame,onSettled,requestFrame,cancelFrame,now,reducedMotion}) from navigation.js -> pan(dx,dy,trackpad),zoom(factor,cx,cy),set(view),stop(),dispose(),get view()；可加 coast(vx,vy) 接口做松手惯性，明确报告。

view {x,y,scale} transform world = translate(x,y) scale(scale)。离散滚轮 tau110ms，细粒度 trackpad38ms，zoom100ms；指数趋近无过冲，可反向连续累积。缩放0.25–2.5，每帧保持光标世界锚点，坐标 cx/cy 是 canvas rect 本地位置。普通 wheel 平移，Shift 垂直轮横移，Ctrl/Meta+wheel 缩放。line/page deltaMode 转像素。Space 或 middle 拖动视图直接跟手，释放滑行95ms 衰减且总位移 <=75px；节点拖动直接不缓动。节点 body wheel 使用独立自适应平滑 scrollTop/Left，绝不带动画布（到边界也不传出）。系统 reduced-motion / html[data-motion=off] 关闭缓动+惯性，监听 document kaiwu:motion。blur/pointercancel/visibilityhidden/切画布/销毁 stop，无残余帧。

## Tests / evidence

先导航 RED 真实 fake RAF 时钟测多帧/累积/反向/锚定/时间步独立/边界/减少动态/stop/dispose/coast，再 GREEN。browser 工具 tools/check-note-canvas.cjs 载入真实插件源码，临时目录真实 canvas IPC 与 notes read/write，不操作用户浏览器或真实库。可起 own localhost server 映射 toolbox shell imports，仅新建隔离 Playwright Edge headless；Playwright 位于 C:/Users/18014/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright，Node D:/nodejs/node.exe。清理仅自己创建明确 tempdir。

浏览器检查创建/重载、编辑 Markdown、引用笔记同步、图片导入预览、安全链接、正文拖动/resize/多选/连线/组移动/复制粘贴、平滑锚定/正文滚动隔离、切换异步/保存失败保留/销毁帧取消；捕获 console/pageerror。若时间不够务必先可运行核心 + 明确遗漏，不假称全部验证。截图写到 docs 或可写 visualization dir；测试不能自动打开用户浏览器。

## Report

docs/superpowers/plans/note-canvas-ui-report.md：实现文件、API 实际接口、RED/GREEN、真实 browser tests 命令及结果、截图、未验证项/疑问。最终15行以内。主代理会独立检查与全量测试。
