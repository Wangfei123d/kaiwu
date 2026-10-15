# 开物 (Kaiwu) · 项目交接文档

> 这份文档是自包含的。接手的人只读这一份,就能接着往下做。
>
> 最后更新:2026-09-18 · 分支 `kaiwu-kernel` · 最后代码提交 `eb31838`
>
> **2026-09-18 补记(最重要的一条环境事实)**:仓库现在位于 **FAT32** 盘(`E:\project`)。
> 后果:①目录联接/硬链接都不支持 → `npm run selftest` 里那条「经联接逃出资源根」会记
> `[SKIP]`(这是**预期**,不是失败;reporter 会把它写进结果文件与汇总句);
> ②**DSH 的 `write` 工具在本盘不可用**(它用硬链接原子落盘,报 `EISDIR ... link`)——
> 改已存在的文件用 `edit`,建新文件用 pwsh 的
> `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`;
> **绝不要用 PowerShell 读改写源码**(UTF-8 中文会被读成乱码再写回,本项目已经踩过一次,
> 要还原就用 `git checkout -- <file>`)。
> 另:本机真实 Node 是 **v22.17.0**,而 PATH 上的 `node` 是指向 Electron 的包装脚本。

---

## 零、先读这一段:产品定位已转向

**内核(子项目 1)已完成**,但产品定位在 2026-09-17 发生了转向:

| | 原定位 | **现定位** |
|---|---|---|
| 打开应用看到什么 | 工具列表 | **对话 + 当前笔记** |
| 工具是什么 | 用户来点的界面 | 侧栏附属,**且是 Agent 可调用的能力** |
| 核心循环 | 打开工具 → 用完关掉 | **读笔记 → 问 AI → AI 改笔记** |

**权威设计文档**:`docs/superpowers/specs/2026-09-17-kaiwu-ai-notes-design.md`
(转向后的方案;**内核设计文档仍然有效**,是它的前置。两者冲突时以新文档为准 ——
它记录了内核文档被实测修正的地方。)

### 转向后的进度

| 里程碑 | 状态 |
|---|---|
| **M1 可行性验证**(ACP 接缝) | ✅ 完成,并据实测**改定了架构** |
| **M2 笔记子系统** | ✅ 完成(纯函数层 + 主进程层 + 三栏界面 + 首启向导) |
| **M3-A Agent 层** | ✅ 完成(分帧 / 假 agent 夹具 / 进程监护人 / ACP 客户端 / 凭证检测 / read-only 运行环境) |
| **M3-B AI 面板接通** | ✅ 完成(命令解析与启动器 / 组合点与 IPC / 右侧面板 / 会话绑定当前笔记);两份独立评审已收口,见下「M3 落地记录」 |
| M4 深度绑定(diff 提案 / 建议链接) | ⬜ 未开始 —— **下一步就是它** |
| M5 工具归位与补齐 | 🔶 部分(抖音/B站已补) |

### M3 落地记录(2026-09-18,接手前必读)

**做了什么**

```
主进程                                     渲染进程
electron/agent/agent-runtime.js  ←组合点→   app/agent/panel.js(右侧常驻面板)
  ├ agent-command.js(找 node / dsh 入口)     ├ app/lib/agent-stream.js(纯状态机:增量/工具卡/权限卡)
  ├ dsh-launcher.mjs(绕开 import.meta.main)  └ app/lib/motion-assert.js(自检的动效判据)
  ├ agent-ipc.js(7 个 agent:* 频道 + agent:event)
  └ preload.cjs(onAgentEvent,只递纯数据)
```

- **Agent 以 read-only 运行**:起进程只有 `app/lib/agent-env.js` 的 `createAgentSpawn` 一条路
  (cwd = 每次 start 时现取的当前 Vault,env 在创建时烤死)。全仓库搜 `DSH_PERMISSION_MODE`
  只许出现在它与它的测试里 —— 别处再拼一次 spawn/env 就等于把能力边界悄悄打开。
- **打开就是对话**:面板挂载即 `agent:start`;失败不致命,`#agentRetry` 可重试。
  **自检模式(`?testVault=`)下 autoStart:false** —— 自检里绝不自动拉起真 dsh。
- **会话绑定当前笔记**:`buildPromptText` 的第一行是 `当前笔记:<path>`,正文取编辑器**现值**
  (不是盘上旧值),超长会明说「正文已截断」。
- **`agent:start` 的契约(2026-09-18 评审后改过)**:非就绪**不再 reject**,而是 resolve
  `{ok:false, state, snapshot, message}` —— 因为 `ipcMain.handle` throw 的 Error 跨进程后
  只剩 message/stack,机器可读的字段全丢。`#agentPanel[data-agent-state]` 与
  `#agentCredential[data-credential-ok]` 是给自检用的机器可读状态。

**怎么验**(三件套,本机实际数字)

```powershell
cd E:\project\kaiwu
npm test                     # 824 项(823 绿 / 1 项环境 SKIP)
npm run selftest             # 100 项全绿 + 1 项 [SKIP]
npm run selftest:acceptance  # 116 项全绿 + 1 项 [SKIP](含 M3 验收:发提示→回复→工具卡→权限卡)
```

M3 的验收断言不用真凭证、不联网:agent 命令由 `electron/run-selftest.js` 注入
`tests/fixtures/fake-acp-agent.mjs`(真子进程、真 stdio、`--tool-call --permission --echo-prompt`)。

**过程中抓到的真缺陷**(都写进了 `.superpowers/sdd/` 的两份评审报告与修复报告):
会话活过进程(崩溃重启后拿旧 sessionId → 再也建不出新会话)、cwd 定死在第一次 start(换库后
子进程还在旧库)、僵尸权限响应打到重启后的新进程(同一 jsonrpc id 两个响应)、
`err.state` 过不了 IPC、保留设备名/超长标题/纯大小写改名、悬停断言间歇性(且会"空转通过")。

**已知限制**:真 dsh 那条路需要 `DSH_HOME` 里有 `acp` profile(本机 `%APPDATA%\kaiwu\dsh-home`
不存在);而在 FAT32 上 profile 引导会因 symlink 受限失败 —— 首次真机联调要先解决这一条
(见第六节)。

### M1 最重要的结论(它改了架构,务必先读)

DSH 融合走 **ACP over stdio**:Kaiwu 当客户端,`dsh --profile acp` 当子进程。
已实测握手、会话、一轮完整对话、流式事件全部通畅。

**但推翻了原设计的一个前提**(原设计以为工具调用要走 ACP 客户端回调):

- Agent **用自己的沙箱工具**读写文件,不回调客户端(实测请求数 0)
- 默认模式下改文件**不发审批**;`read-only` 下发审批,但**批准也无法突破沙箱**

据此改定为:

    Agent 以 read-only 运行(物理上没有写盘能力)
       ├─ 读笔记:自带工具直接读,不需要任何桥
       └─ 改笔记:只能调「提案工具」→ Kaiwu 渲染 diff → 用户确认 → Kaiwu 落盘

「AI 不能静默改笔记」因此从**靠约定**变成**靠能力边界**。
可重跑的探针在 `.agent-probe/`(4 个脚本)。

---

## 一、当前仓库状态

```
分支:kaiwu-kernel
最后代码提交:b9bfec5
```

最近的提交链(新→旧;**最新的一条是本轮"行级编辑器 + 去掉状态条 + Cookie 设置"**):

```
         feat(notes,ui): 编辑器改成一行一块;去掉底部状态条;抖音 Cookie 可在界面配置
         feat(services,ui): 服务随应用并行启动;解析/下载按钮与下拉框改为深色统一外观
19bc610  docs(handoff): 按「AI + 笔记」转向重写交接文档
90d5dd0  fix(bilibili): B站服务改为「先起本体、再起代理」的启动器
a8895b3  fix(services): 健康检查超时太紧,导致健康的服务被判为启动失败
2221ce0  feat(plugins): 补回抖音与 B 站解析下载,并抽出共享服务徽标
5916e3f  feat(notes): 实时预览编辑器(光标块为源码)+ 工具列表样式修回
87f317b  fix(notes): hidden 属性被 CSS 覆盖,导致"卡在向导界面"
9c3c6c5  feat(diag): 启动阶段日志,并补"已配置笔记库时不进向导"的断言
c55a93c  fix(notes): 向导选完文件夹后被过期状态盖回去(真实竞态)
d44e8d8  test(notes): 补反链正确性用例,并澄清一次误判
7b3c6bc  feat(notes): 笔记界面接通 —— 三栏外壳、编辑预览、反链、首启向导
df44f97  feat(notes): 笔记 IPC、三栏外壳骨架与 Markdown 预览
5e73d05  feat(notes): Vault 路径守卫与笔记索引(主进程侧)
febb295  feat(notes): 笔记纯函数层 —— 链接解析、frontmatter、链接图
7a300e5  docs: M1 可行性验证完成,并据实测结果改定 Agent 集成架构
81ab310  docs: 评审通过,写入四项决定
e626093  test: 补全自检到设计文档 §11.2 的 5 组断言,并加上两条验收用例   ← 内核收口
…
bbda1a8  feat: toolbox:// 自定义协议与路径越界防护                      ← Task 2
3e6109b  feat: 开物项目骨架、Electron 宿主与自检框架                    ← Task 1
106378e  docs: 开工前修掉计划里四处缺陷
```

### 文件地图

转向后的完整文件地图见下面的「文件地图」,或直接看源码 ——
下面只列最容易找错位置的关键文件:

```
kaiwu/
  electron/
    main.js                主进程:窗口、安全策略、IPC 路由、服务登记与随应用启动、退出清理
    launch.js              启动器:摘掉 ELECTRON_RUN_AS_NODE 再拉起 Electron
    preload.cjs            唯一 CJS 文件;用 executeInMainWorld 交接 IPC 桥
    stage-log.js           启动阶段日志(逐行落盘,始终开启)
    app-protocol.js        toolbox:// 接线层(处理逻辑在 app/lib)
    plugin-scanner.js      扫描根目录、读清单、归一化描述符
    service-supervisor.js  服务状态机(依赖全注入,可脱离 Electron 单测)
    service-runner.js      真实依赖:探端口 / HTTP 健康检查 / spawn / 杀进程树
    settings-store.js      设置持久化,按插件 id 分命名空间
    cookie-login.js        ★ 登录一次自动记住 Cookie(持久分区登录窗 + 投递给服务)
    app-menu.js            应用菜单模板(中文;纯数据、可单测;开发者项只在 --dev)
    notes/note-index.js    笔记扫描、解析、原子写、备份(.bak 一代 + 跟随改名)
    notes/notes-ipc.js     所有 notes:* 频道(含 notes:setTitle:文件名/H1/frontmatter.title 一起改)
    agent/agent-runtime.js ★ Agent 组合点:起进程(failPending / 会话作废 / prompt 超时与取消 / 权限挂起)
    agent/agent-supervisor.js ★ 进程监护人(握手即就绪 + 指数退避;依赖全注入)
    agent/acp-client.js    ★ ACP 客户端(握手/会话/流式/反向请求;notify 不登记 pending)
    agent/agent-ipc.js     7 个 agent:* 频道 + agent:event 推送
    agent/dsh-launcher.mjs 真 dsh 的启动器(绕开 Node<24.2 上死掉的 import.meta.main)
    agent/credentials.js   ★ 凭证"有没有"(只回叶子字段,绝不读出密钥值)
    selftest.js            自检断言(100 项;--acceptance 时 116 项;环境不支持时会记 [SKIP])
    run-selftest.js        纯 Node 包装器:拉起 → 读结果 → 透传退出码;并注入假 agent 命令
  app/
    index.html             外壳骨架(三栏 + 向导 + 右侧 AI 面板;**没有底部状态条**)
    main.js                外壳入口:查笔记库 → 向导或笔记界面 → 加载插件 → 挂 AI 面板
    lib/                   ★ 纯函数与安全关键件都在这(可 node --test 直跑)
      path-guard.js        ★ 路径守卫(词法层 + 真实路径层)
      app-protocol-core.js ★ toolbox:// 处理器
      manifest-schema.js   ★ 清单校验(主/渲染共用)
      css-scope.js         ★ 插件样式作用域化(真正的块结构解析)
      service-autostart.js ★ 「随应用启动」的决策(用户设置 > 清单 > 默认)
      cookie-string.js     ★ 拼 Cookie 串 + 体检(缺 uifid/sessionid)
      wikilink.js          ★ [[链接]]/标签/标题解析
      frontmatter.js       ★ YAML 子集解析与序列化
      note-graph.js        ★ 反链/出链/孤儿/建议链接
      md-blocks.js         ★ 正文切块(**一行一块**,代码块/表格跨行)
      markdown.js          ★ Markdown → HTML(**注入边界:先转义再替换**)
      agent-env.js         ★ read-only 运行环境 + cwd 的**唯一出口**(createAgentSpawn)
      agent-command.js     ★ 找真 node / 找 dsh 入口(纯函数,存在性全靠注入)
      agent-stream.js      ★ ACP 事件 → 界面状态(纯;连续 chunk 拼一条、权限卡去重)
      motion-assert.js     ★ 自检的动效判据(matrix 解角度、CSS 媒体块切片)
      color.js / utils.js  公共库
    runtime/               registries / ctx / loader / mount
    shell/
      bootstrap.js         ★ 把 IPC 桥收进模块闭包并抹掉临时全局
      service-badge.js     ★ 服务状态徽标(三个插件共用)
      media-placeholder.js ★ 封面/图片兜底的内联矢量占位图
      icons.js / sidebar.js / content.js / starfield.js
    notes/
      onboarding.js        首启向导 / 更换笔记库
      notes-view.js        列表 + 编辑器 + 链接栏(标题改名走 notes:setTitle)
      editor.js            行级实时预览编辑器(回车/↑↓/退格都有专门处理)
    agent/
      panel.js             ★ 右侧 AI 面板(消息流/工具卡/权限卡/凭证卡/重试)
    styles/                tokens.css / base.css / shell.css
  plugins/                 hello.tool.js + palette / subtitle / music / douyin / bilibili
  tests/                   824 项单测(含夹具 tests/fixtures/fake-acp-agent.mjs)
```

## 二、踩过的坑(这一节最值钱)

### A. 通用坑(换任何机器都会遇到)

**A1. `electron@44.4.1` 的 package.json 里根本没有 `scripts` 字段。**
所以 `npm install` **永远不会**下载 `node_modules/electron/dist/`。装完依赖必须再跑一次:

```powershell
node node_modules\electron\install.js
```

这是**每次全新克隆的必需第二步**,不是可选项。

**A2. `.npmrc` 里的 `electron_mirror` 是个无效键。**
npm 不认它。`@electron/get` 认的是**环境变量** `ELECTRON_MIRROR`。别再写回去。

**A3. Electron 二进制缓存的变量名是小写的 `electron_config_cache`。**
不是 `ELECTRON_CACHE`,也不是 npmrc 里的 `electron_cache`。

**A4. Windows 上 `electron.exe` 是 GUI 子系统程序。**
`console.log` 默认到不了父控制台,退出码也拿不到。**所以任何脚本化验证都必须把结果
写进文件**。例外:调用方给 `stdio: 'inherit'` 时输出能看见 —— `npm start` 就是这么做的。

**A5. 沙箱环境会静默阻断 Chromium 的 mojo IPC**(它用 Windows 命名管道)。
表现为:主进程能启动、`app ready` 永不触发、Chromium 日志 0 字节,**没有任何报错**。
需要完整文件访问权限才能跑 Electron。

**A6. `contextBridge.exposeInMainWorld` 建的属性不可写也不可配置。**
这是本项目踩得最深的一个坑。ES 模块体**始终**是严格模式,所以
`delete window.__kaiwuBridge` 与 `= undefined` **都会抛 TypeError** ——
后果不是"不够干净",而是整个 `app/main.js` 在那一行**静默中止**:
页面没有任何 console 输出、没有任何可见错误,只表现为"什么都没发生"。
修法是用 `contextBridge.executeInMainWorld` 把桥当**参数**交给主世界(见 `app/shell/bootstrap.js`)。
**给模块脚本加错误陷阱**(预加载里装 `window.addEventListener('error', …)`)是唯一
能看见这类问题的手段,自检已经这么做了。

**A7. CSS 作用域化必须做真正的块结构解析。**
拿正则扫 `[^{}]+\{` 会给 `@media` 的前导也加前缀,得到非法选择器,
**整块被 CSS 解析器静默丢弃**。详见 `app/lib/css-scope.js` 与它的 17 项单测。

**A8. 异步挂载必须设"写入前"的闸门。**
只在拿到 handle 之后丢弃是不够的:那时旧面板**早已写进共享容器**。
表现是"选中的是 A、显示的却是 B",且无任何报错。详见 `content.js` + `mount.js` 的
`shouldApply`。这类竞态极难复现(自检实测 10 次里约 2 次),但一旦理解就不难修。

**A9. 【最容易误判,单独强调】`hidden` 属性会被作者 CSS 覆盖。**
浏览器规范里 `[hidden]` 只是 UA 样式表的一条 `display: none`,**优先级最低** ——
任何作者写的 `display`(`.onboarding { display: flex }`)都会把它压过去。
于是 `el.hidden = true` 设了、**读回来也是 `true`**,界面却照旧显示。

后果:用户报"选完文件夹卡在向导界面",而**日志明明说隐藏成功了**。
我为此绕了好几轮,还误判过一次(把"猜到一个问题"当成"找到这个问题",
加了个竞态守卫 —— 那守卫本身有价值,但不是这次现象的原因)。

→ **"日志说成功、界面没变"这类问题,第一优先级查 `getComputedStyle(el).display`,
   不要先怀疑时序。**
→ `base.css` 已有 `[hidden] { display: none !important }`。
→ 诊断代码(向导的 hide/show)会**读回计算样式**并在不一致时告警。
→ 自检直接断言**计算样式**,不只断言 `el.hidden`(否则一路通过而界面是错的)。

**A10. 把"异步初始化"和"用户可交互的 UI"放同一条路径上时,
必须显式标记"用户已经做过决定了"。**
向导的按钮在 HTML 里一开始就存在,而 boot 卡在"查笔记库状态"那次 await 上;
用户完全可能在那之前就点完 → 晚到的**过期**状态把已进去的界面又盖回向导。
→ 这类 bug 本地跑不出来(要点得够快),只能靠想清楚时序或**直接写竞态用例**。

**A11. 健康检查的超时不能拍脑袋定。**
有的服务 `/health` 会**顺带探自己的上游**(B站代理会去连 Bilidown),响应要 2 秒。
超时给 1500ms 就让**健康的服务永远测不过**,表现为"启动 30 秒后失败"、
而日志里 uvicorn 明明说 `Application startup complete`。
→ 清单可声明 `healthTimeoutMs`;默认已放宽到 5000ms。

**A12. `spawn(command, args, { cwd })` 把相对命令按 `cwd` 解析。**
而清单里的 `command` 约定是相对**服务根目录**的(`.python-runtime/python.exe`),
cwd 却是另一个子目录(`bilidown`)→ 去找 `bilidown/.python-runtime/python.exe` → ENOENT。
→ 必须在主进程解析成绝对路径(`main.js` 的 `resolveCommand`)。
→ 裸命令名(如 `node`)不带路径分隔符,交给 PATH,不要动它。

**A13. 编辑器的"提交"操作必须幂等。**
`commitActive()` 原先用"**重新切分后**同序号的块"去替换,而 input 处理器已经应用过
这次编辑、正文变长、区间随之错位 → 第二次替换落在错误位置,**把刚写进去的内容覆盖掉**。
表现极隐蔽:**body 是对的,但 `value()` 返回旧内容**,也就是"看着改成功了、
保存下去的却是旧的"。
→ 激活块时记下它的区间,提交时用这个区间 —— 同一段文本在同一区间上再写一次,结果不变。

**A13. 编辑器的"提交"必须幂等 —— 而"幂等"的意思是区间要跟着内容一起更新。**
原实现记下"激活这一块时的区间"就不再管它,提交时拿**旧区间**去替换:
用户一打字,body 里那一段就变长了,旧区间只盖住前面一截 —— 于是每敲一个字符、
每调一次 `value()`(自动保存会调),都把多出来的尾巴再写一遍。
症状是"打一个字,保存后变成两个"。

→ 提交后必须把区间更新成"这次写进去的那一段"(`applyActiveText`)。
→ **更值得记的是它为什么藏了这么久**:当时那条"幂等"用例把**游离的** textarea
   递给输入处理器(提交时读的却是渲染出来的那个),两个值凑巧一样长、区间也
   凑巧对得上,于是用例一路通过。自检的 `includes('自检追加。')` 也照样通过 ——
   而磁盘上写的是"自检追加。 自检追加。"。
→ **教训:断言要"数次数/看全量",不能只 `includes` 一个子串;测试要尽量贴近
   真实路径(改就改渲染出来的那个 DOM 节点)。**

**A14. 分块单位决定交互手感 —— "按回车不渲染"的根因在这里。**
编辑器最初按"空行分隔的段落"分块,于是连续两行属于**同一块**:在 textarea 里按回车
只是在块内插了个换行,上一行仍然显示为源码 —— 用户看到的正是"按了回车不渲染,
得用鼠标点一下才渲染;按 ↓ 也跳不出当前块"。
→ 改成**一行一块**(只有围栏代码块与表格跨行成块),回车/↓ 才天然等于"跳到下一块"。
→ 连带必须做的三件事:空行**自己也是一块**(零长度区间,否则"光标停在空行上"
   没法表示、新起的那一行没地方放);行首退格要**自己实现**合并(行与行之间的
   换行不属于任何一块,不实现就永远删不掉空行);代码块/表格内部回车仍是换行。

**A15. 共享控件的样式写在某个插件里 = 另外几个插件没有样式。**
`.tool-search` / `.tool-search-btn` 原先只写在 `plugins/music/style.css`,而插件样式
会被运行时加上 `[data-plugin="music"]` 前缀 —— douyin / bilibili 用了**同一套类名
却一条规则都拿不到**,「解析」按钮就是浏览器默认外观(用户截图里正是如此)。
→ 共享控件样式一律放 `app/styles/base.css`,插件里不再各写一份。
→ 这类缺失**不报任何错**,只能靠断言计算样式发现(自检已加)。

**A16. 原生下拉框的弹出列表由 Chromium 自己画,只认 `color-scheme`。**
普通 CSS 管不到它。不声明 `color-scheme: dark` 的话,深色界面里点开 `<select>`
会弹出一块**白底**列表(用户截图)。另外插件里用 `background:` **简写**覆盖下拉框
会把自绘箭头的 `background-image` 一起清掉 —— 要用 `background-*` 长写或干脆别覆盖。

**A17. 底部全局状态条属于"看起来该有、其实添乱"的那类东西。**
它让我写出过"服务真的起来了、勾选框却是空的"这种界面在撒谎的代码(界面只看设置,
不看清单)。用户直接要求删掉 —— 服务已随应用启动,状态摆在**用到它的工具面板**里
就够了。删掉时别忘了:grid 模板要跟着去掉那一行、`.status-dot` 样式被插件徽标
共用着(不能一起删)、自检里那三条基于状态条 DOM 的断言要改成断言面板徽标。

**A18. 「登录一次,自动记住」这类能力要按清单声明,不要做成通用接口。**
抖音的接口被风控挡着,只有登录态 Cookie 过得去(实测见 B6)。最容易走偏的做法是
给插件一个"打开任意网址并把 Cookie 取出来"的通用函数 —— 那就是一个 Cookie 外发通道。
最终做成:插件清单里声明 `contributes.cookieLogin`(登录页 / Cookie 域 / 投递目标),
`ctx.cookies.login()` 只递 pluginId;投递目标必须是**该插件自己声明的服务**,端口由
主进程从服务清单里查,**Cookie 值不经过渲染进程**。
→ 一般化的教训:新能力尽量做成"清单声明意图 + 主进程按结构校验",而不是"给渲染进程
   一个参数随便填的接口"。内核里服务那条保证(命令只能来自清单)就是这个套路。

**A19. 登录窗必须用持久分区,而且要在"检测到登录态"时自动收尾。**
`partition: 'persist:…'` 才让"登录一次"成立(否则每次都要重扫码);
轮询到 `sessionid` 就自动关窗,用户不需要知道"关掉窗口才算完成" ——
把收尾动作交给用户,他就会卡在那儿等。另外窗口的 `show` 要可关(探针/自检里
不该弹窗),`timeoutMs` 必须有上限(用户走开时不能挂死)。

### B. 只在这台机器上成立的坑(到公司大概率不用管)

**B1. 这里的 `node` 是一个包装脚本 `%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd`,
它会 `set ELECTRON_RUN_AS_NODE=1`。**
这个变量被 `electron.exe` 继承后,它会**退化成纯 Node**。所以有 `electron/launch.js`。
普通终端下这个变量本来就不存在,`launch.js` 只是白白删一个不存在的变量,无害。

**B2. 同一个包装脚本还会让 `node` 的输出管道失败(`spawn EPERM`)。**
`npm test` / `npm run selftest` 在受限沙箱下必然失败。另:即使不涉及 Electron,
`node ... | Select-String` 也会失败 —— 用直接调 `C:\Program Files\nodejs\node.exe`
且不接管道的方式绕开。

**B3. `Copy-Item` 备份 UTF-8 源码会把中文变成乱码。**
PowerShell 的备份/还原会在控制台代码页上打转,还原后 JS 变成语法错误,
表现与 A6 一模一样(模块静默中止)。**备份/还原一律用 git 或 read/write 工具。**
读含中文的输出也一样 —— 用 read 工具或显式指定编码。
**这一轮我因为乱码看错了列,白追了一个不存在的 bug。**

**B4. Node 22 不支持 `node --test <目录>`,且 glob 必须加引号。**
不加引号时 shell 会先展开,子目录里的用例被**静默跳过**(全绿但根本没跑)。

**B5. `import.meta.main` 在 Node < 24.2 上是 `undefined`。**
`dsh` CLI 因此**零输出、退出码 0、秒退**(连 `-V` 都无输出),极难排查。
绕法:直接 `import { runCli } from '@deepseek-ai/dsh/lib/bin.js'` 再 `await runCli()`。
见 `.agent-probe/dsh-run.mjs`。

**B6. 抖音必须配真实浏览器 Cookie(不是本机特有,但当前是"必须人工做一次"的事)。**
抖音的详情接口被风控挡着:只带 `ttwid` 会拿到
`403 Blocked by ArgusSecurityPlugin Uifid Not Found`。
实测过所有"免登录"的老路(`iesdouyin` 分享页 / `iteminfo` / `m.aweme` / App 侧
`api.amemv` 接口 / **真 Chromium 匿名访问**)**全部不通**,不是代码能绕过去的
—— 可重跑的探针在 `.agent-probe/douyin-browser-probe.mjs`。
→ 已做成能力:插件清单声明 `contributes.cookieLogin`,面板上一个按钮,开物就用自带
   Chromium 开**持久分区**的登录窗,用户扫码一次,之后 Cookie 一直在那个分区里
   (换账号才需要重登)。实现在 `electron/cookie-login.js`;机械部分(开窗/轮询/
   收集/体检)用 `.agent-probe/cookie-login-probe.mjs` 验过。
→ 手动粘贴作为备路也留在面板里(第二层折叠)。
→ 关键字段是 `uifid` 与 `sessionid`,界面会明确说"缺哪个"。

**B7. `.npmrc` 里有一行 `cache=D:/project/.npm-cache`。**
到公司若 `D:\project` 不存在,这一行应删掉或改成本机路径。

---

## 三、设计要点(为什么这么设计)

### 3.1 `toolbox://` 自定义协议 —— 一切的前置条件

注册为 privileged + `standard` + `secure` + `supportFetchAPI`,挂三个根:

| URL | 实际目录 | 用途 |
|---|---|---|
| `toolbox://shell/…` | `kaiwu/app/` | 宿主 UI 与公共库 |
| `toolbox://plugin/…` | `kaiwu/plugins/` | 内建插件 |
| `toolbox://user/…` | `<userData>/plugins/` | 用户自己加的插件 |

处理逻辑在 `app/lib/app-protocol-core.js`(纯模块,可单测),`electron/app-protocol.js`
只是接线。路径守卫分两层:**词法层**(挡 `../`、绝对路径、编码穿越)与
**真实路径层**(用 `realpath` 挡符号链接/目录联接逃逸)。两层都不能省。

**一个反直觉的发现(已写进测试注释):** 计划里原本的越界测试
`toolbox://shell/../package.json` 是**无效测试**。因为 `toolbox` 是 standard 协议,
URL 解析器会在请求抵达主进程**之前**就把 `../` 规范化掉,实际命中的只是
「`app/package.json` 不存在」的 404。改用 `%2e%2e%2f` 才真的能测到守卫。

### 3.2 插件两种形态,归一成同一份描述符

**文件夹形态** `plugins/palette/{plugin.json, index.js, panel.html, style.css}`
**单文件形态** `plugins/hello.tool.js` —— 一个文件写完,清单内联在 `export default` 里

入口统一是:

```js
export default {
    activate(ctx) { /* 启动一次:注册贡献点、声明服务。禁止碰 DOM */ },
    setup(el, ctx) { /* 首次打开该工具:el 是已挂载的面板容器 */ },
    teardown() {},
};
```

**为什么分成 `activate` 和 `setup` 两段?** 因为现有 7 个 `tool-*.js` **全都在模块顶层
就 `document.getElementById(...)`**。面板必须先注入 DOM,插件代码才能跑。
`activate` 只注册、不碰 DOM;`setup` 在面板挂载后才调用。

**单文件形态不能声明后台服务。** 原因是结构性的:单文件的清单写在模块内部,
主进程(Node)读不到渲染进程的 ES 模块。若改成"渲染进程 import 后把清单回传给主进程
登记",就等于开了一条**渲染进程可以递进一份含任意命令行的清单**的通道。
规则从简:**要后台服务,就用文件夹形态。**

**注意:** 文件夹形态的工具由 `plugin.json` 的 `contributes.tools` 声明,
`loader.js` 会统一登记进注册表;插件在 `activate` 里再 `register` 一次也无害
(重复 id 返回 `false`、不覆盖)。两种写法都成立。

### 3.3 权限模型 —— 说清楚它到底能挡什么

**✅ 真实且绕不过的(在主进程侧实现):**

- 不存在任意命令执行通道。服务的命令 / 参数 / 工作目录全部来自清单,渲染进程递不进来。
- 外链只放行 `http:` / `https:`。
- 文件访问限制在三个根目录内(**含链接逃逸防护**)。
- `nodeIntegration: false` 意味着渲染进程**根本没有** `require` / `fs` / `child_process`。
- IPC 桥不在 `window` 上(用 `executeInMainWorld` 交接,见 A6)。

**⚠️ 不是安全边界,只是工程边界:**
插件与外壳共享同一个 JS realm,**主进程无法分辨某次 IPC 调用来自哪个插件**。
所以 A 插件理论上能读写 B 插件的设置。桥虽然不在 `window` 上,但**挡不住能拿到
外壳闭包的恶意代码**(比如带 DevTools 的)。

结论:清单里的 `permissions` 是"安装前可见的审计信息 + 正常路径下的能力门控",
**不是对抗恶意代码的沙箱**。真强隔离要每插件独立进程,已评估并推迟。

### 3.4 服务托管:先探活,再决定拥不拥有

状态机 `stopped → starting → ready → stopping → stopped`(失败进 `failed`):

**启动前先探端口。已经有人监听 → 进入 `external`,接管但不拥有、不重启、退出时不杀。**
这样你手敲的 `.bat` 和新应用能共存、不会撞端口。
停止时用 `taskkill /PID <pid> /T /F` 杀**整棵树**。

服务清单里的 `cwd` 是**相对服务根目录**的路径(默认 `D:\project\personal_web_project`),
解析发生在**主进程**(渲染进程只能递服务 id,递不进路径)。

### 3.5 其它已定的决策

- **Electron 而非 Tauri**:现有代码是纯 HTML/CSS/JS,零构建链直接迁移;三个联网工具需要
  托管常驻进程。代价是安装包约 250MB,已接受。
- **同进程 + ctx 能力注入**,不做每插件沙箱(理由见 5.3)。
- **`sandbox: true` 下预加载不支持 ESM**,所以 `preload.cjs` 是全项目唯一的 CJS 文件。
- **零运行时依赖**,除 `electron` 外不引入任何 npm 包(连单测都用自写的 DOM 替身,
  没有引入 jsdom)。

---

## 四、接下来怎么接着做

**M3 已经落地(见「M3 落地记录」)。下一步是 M4:深度绑定。**

但如果要先把 M3 真机跑通一次(用真凭证、真 dsh),先解决这两件事:

1. **`DSH_HOME` 里得有 `acp` profile。** 本机 `%APPDATA%\kaiwu\dsh-home` 不存在;
   而 `resolveKaiwuDshHome` 的优先级是「显式 `DSH_HOME` > `%APPDATA%\kaiwu\dsh-home`」——
   在开发终端里 `DSH_HOME` 是 harness 自己的家(`%APPDATA%\dsh-desktop\harness`),
   真 dsh 会去那里找 `acp` profile。**打包运行时未必有 `DSH_HOME`**,所以 M4 之前
   建议做一个「Agent 设置」区(`dsh` 入口 / `DSH_HOME` / 凭证状态 / 自动重启上限),
   这正是设计文档 §6.1 列的那几项。
2. **FAT32 上引导 profile 会失败**:DSH 首次引导 profile 用 symlink,而本盘不支持
   (`EISDIR`)。所以在 E: 上跑真 dsh 之前,要么把仓库挪到 NTFS 盘,要么手工准备一个
   已引导好的 `DSH_HOME` 并用设置项指过去。

### 之后:M4 深度绑定

- 「AI 改笔记」的 diff 提案与确认流程(安全底线,见设计文档 §5.3b)。
  起点已经铺好:Agent 在 read-only 下**物理上写不了盘**,而工具调用会以 `session/update`
  的 `tool_call` 流回来(带 `rawInput: { file_path, old_string, new_string }`)——
  面板现在把它渲染成卡片,把卡片升级成「提案 → diff → 用户确认 → Kaiwu 原子写盘」就是 M4。
- 建议链接(纯逻辑已在 `app/lib/note-graph.js` 的 `suggestLinks`,接界面即可)
- 笔记 ↔ 会话关联(`session/load` / `session/list`;`configOptions` 已在 stream state 里留着,
  界面还没渲染 —— 模型/思考强度的切换属于这里)

### 之后:M5 补齐工具

还剩 `image` / `grade`(含图片处理与调色预演)。**照 `plugins/palette` 的写法做**,
变换规则见计划文档 Task 14 开头。移植时先读 `plugins/subtitle`:
它示范了怎么把纯逻辑(`convert.js`)与 DOM 接线(`index.js`)分开,好让算法能单测。

### 每完成一个任务就验证

```powershell
cd E:\project\kaiwu
npm test                     # 单元测试(当前 824 项)
npm run selftest             # 真实应用的断言(当前 100 项 + 1 项环境 SKIP)
npm run selftest:acceptance  # 改动涉及插件发现/Agent 面板时也跑它(当前 116 项 + 1 SKIP)
```

三个都必须绿(退出码 0)。**自检的断言是累加的** —— 后面的任务加断言,前面的不能退化。
`[SKIP]` 是环境跳过(本盘建不出目录联接),它会计进结果文件的汇总句,不会让红的判成绿。

### ⚠️ 台账是 git 忽略的,不会跟着仓库走

```
E:\project\.superpowers\sdd\progress.md          ← 台账(含全部缺陷记录、M1 结论、每一次评审与修复)
E:\project\.superpowers\sdd\*-review.md          ← 各轮独立评审结论
E:\project\.superpowers\sdd\m3a-task-N-report.md ← M3-A 各任务报告
E:\project\docs\superpowers\plans\               ← 计划(M3-A / M3-B,含冻结的接口契约)
```

**它们在 `.gitignore` 里(`.superpowers/`),`docs/` 下的计划文件目前也未入库。**
要把项目拷到公司,记得**手动把 `.superpowers` 整个目录一起拷过去**(至少把 `progress.md` 拷走)。

---

## 五、环境约束清单(到公司先做这几件事)

1. **确认 Node 版本 ≥ 22.12.0。** `electron@44.4.1` 自身要求这个下限。
2. **删掉或改掉 `kaiwu/.npmrc` 里的 `cache=D:/project/.npm-cache`** —— 那是本机路径。
3. **装 Electron 二进制要两步**(见第二节 A1)。
4. **先试直连 GitHub。** 能连就不用管镜像;连不上再设
   `$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"`。
5. `electron_config_cache` 环境变量在沙箱外不是必需的。
6. **打包阶段的 Node 版本另有一道坎**:依赖里的 `pi-ai` 要求 Node ≥ 22.19,
   而本机是 22.17。开发不受影响(它只在打包/运行那条链上被 `import`),
   但做安装包前要先升级 Node。

---

## 六、还没解决 / 需要注意的点

| 项 | 说明 |
|---|---|
| 插件热重载没做 | 改插件后要重启应用。已在设计里记为后续可做项。 |
| `while(true)` 插件会卡死界面 | 已知限制,缓解方案是 `utilityProcess`,本阶段不做。 |
| 插件能改别的插件的 DOM | 同 realm 的必然结果。样式已做作用域隔离,DOM 靠约定。 |
| 服务根目录写死 | `DEFAULT_SERVICE_ROOT` 在 `electron/main.js`,设置页做好后应改为可配。 |
| `bilidown.exe` 是托盘应用 | 强杀可能丢状态。设计上已支持 `stopOnExit: false`,打包阶段才会遇到。 |
| music 服务未做真机联调 | 需要 `D:\project\personal_web_project\QQMusicapi` 存在。状态机与探活由单测/集成测试覆盖,但"搜索一首歌能播"需要手工验。 |
| ★ B 站启动器放在被 git 忽略的目录里 | `kaiwu/plugins/bilibili/plugin.json` 指向 `personal_web_project\bilidown\kaiwu-launcher.mjs`,而 `personal_web_project` **整体被忽略**(里面有 `SESSDATA`)。换台机器 clone 后这个文件不存在,B 站服务会起不来。要么把启动器挪进仓库、要么拆成"本体 + 代理"两个服务声明。 |
| ★ 抖音需要人工配一次 Cookie | 抖音详情接口被风控挡着(403 Argus),免登录的老接口与**真 Chromium 匿名访问**实测都不通。面板上现在有「登录抖音并自动记住」(开物自带 Chromium 的持久分区登录窗,扫码一次即可),手动粘贴作为备路。 |
| ★ **服务侧的代码在仓库外** | 两个解析服务本体都在 `personal_web_project/`(整体被 gitignore,因为里面存着 B站 `SESSDATA`)。所以本轮给它们打的补丁**不跟着仓库走**,换台机器要重做:①`bilidown/kaiwu-launcher.mjs`(先起本体再起代理)②`douyin_parse/web_api.py` 的 `/douyin/cookie` 读写 + mtime 热加载 ③`douyin_video_parser.py` 的 `last_error` 与 Cookie 绝对路径。彻底解法:把服务本体搬进仓库(密钥单独放),或在仓库里留一份可复用的 `services/` 目录。 |
| 编辑器没有软换行合并的"段落"概念 | 一行一块的必然结果:同段落的两行各自成块。视觉上用 CSS 去掉了行间留白,但它们确实是两块(改动互不牵连,这符合"每行一块"的要求)。 |
| ★ `.md.bak` 备份是**有意的、只留一代、会随改名移动、不入库** | `writeNote` 覆盖前留一份 `<名字>.md.bak`,给「AI 改笔记」兜底(第一道防线是 diff 提案与用户确认)。语义:①**一代**,不是历史堆叠 —— 备份名就是"当前文件名 + .bak",所以永远只有一份;②改名(`notes:setTitle` / `notes:rename`)时由 `moveNoteBackup` 搬到新名字下并覆盖旧的那份,**不在旧名字下留残留**(留了就等于旧内容换个名字继续住在库里,列表上还看不见);③`.gitignore` 里已加 `*.md.bak`。它代价是"用户笔记库磁盘上会有一份同内容副本",这是为了 AI 改错时能回退而**有意接受**的。 |
| ★ **真 dsh 还没在真机跑通过一轮** | M3 的验收走的是假 agent 夹具(零凭证、零联网、确定性),真凭证那条路没验。两个已知前提:①`DSH_HOME` 里要有 `acp` profile(本机 `%APPDATA%\kaiwu\dsh-home` 不存在;开发终端里 `DSH_HOME` 指向 harness 自己的家);②**FAT32 上 profile 引导会因 symlink 受限失败**。见第四节开头。 |
| ★ **Agent 设置项还没有界面** | `dsh` 入口 / `DSH_HOME` / 凭证状态 / 自动重启上限目前都在代码里(`agent-command.js` 的候选清单 + `agent-env.js` 的解析点)。设计文档 §6.1 要求它们可配 —— 建议在 M4 之前补一个小设置区,否则换台机器只能改代码。 |
| ★ **权限卡片的"提权"语义还没接产品行为** | `session/request_permission` 现在能渲染、能回答、能保证"恰好一个响应",但 read-only 下**批准也突破不了沙箱**(M1 实测)—— 所以它目前是"知情"而不是"闸门"。真要提权得在 DSH 侧配置,别在 UI 上假装它能。 |
| 打开应用会拉起一个 Agent 子进程 | 「打开就是对话」的直接后果。自检模式(`?testVault=`)下 autoStart:false,所以自检不会拉真 dsh;但正常启动时如果真 dsh 起不来,面板上会显示中文原因与重试入口,不影响笔记编辑(全局验收要求"Agent 崩溃不影响笔记编辑")。 |

---

## 七、一句话总结

**内核(M0)已收口**:应用能起、协议通了、插件两种形态都能丢进去就用、服务能探活接管也能拉起、
三个服务随应用**并行**自动启动,单测 505 项、自检 72 项(验收 77 项)全绿,
**过程中找出并修掉 20 类真实缺陷** —— 其中最有价值的是"没有任何报错、只表现为什么都没发生"
那一类(严格模式删除、CSS 分组规则、挂载竞态、`hidden` 被 CSS 覆盖、插件样式没作用到、
提交不幂等把用户的字写重):它们共同的破案手法就是**先读计算样式和阶段日志,别猜**。

**产品已转向**(见第零节):AI Agent + 笔记为核心,工具退到侧栏。笔记侧(M2)已落地:
首启选库向导、三栏外壳、Markdown 预览、反链、**行级实时预览编辑器**(回车/↑↓/退格
都按"每一行都是一个块"来做)。

**AI 侧 M3 也已落地**(2026-09-18):Agent 以 **read-only** 运行(物理上写不了盘),走 ACP over stdio;
右侧面板能连、能流式收回复、能渲染工具卡片与权限卡片,提示自动带上当前笔记的上下文;
`npm test` 824 项、自检 100 项、验收 116 项全绿(另有 1 项因 FAT32 环境跳过)。
M3 的过程里两份独立评审抓出四类**只在接缝上出现**的真缺陷:会话/权限/cwd 这些"状态活过了进程",
以及"机器可读字段过不了 IPC" —— 都修掉并用例钉住了。真凭证那条路还没在真机跑通(见第六节)。

接下来:**M4 深度绑定(AI 改笔记的 diff 提案与确认、建议链接、会话关联)→ M5 补齐 image/grade → 打包**。
