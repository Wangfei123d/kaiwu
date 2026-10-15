# 开物 (Kaiwu)

可插件扩展的桌面工具箱。7 个工具里的 4 个已迁入(palette / subtitle / music +
一个单文件示例 hello),其余 4 个属于子项目 3。

## 命令

    npm start                 # 打开应用
    npm test                  # 单元测试(纯 Node,不需要 Electron)
    npm run selftest          # 启动真实应用跑断言,结果在 selftest-result.txt
    npm run selftest:acceptance  # 额外跑两条验收用例(见下)

`npm test` 与 `npm run selftest` 都必须绿;自检的断言是累加的,后面的任务加断言,
前面的不能退化。

### 自检断言覆盖什么

- 协议:`toolbox://` 载入、fetch 可用、越界与畸形编码被拒、**目录联接逃逸被拒**
- 桥:IPC 桥不在 `window` 上,且 `require` / `ipcRenderer` 没有泄漏
- 页面:没有未捕获异常(模块语法错误只会让"页面什么都没发生",这条专门守它)
- 外壳:扫描到 4 个工具、逐个切过去断言各自面板里的关键元素真的挂上了
- 服务:插件面板里的服务徽标显示状态、三个内置服务都声明了 `autoStart: true`、
  自检本身不拉起服务(那会真的 spawn 三个外部程序)
- AI 面板:**黏贴截图**(合成原生 paste → chip → 删除 → 中文拒绝原因)与
  **视频理解**(合成原生拖放 → 草稿卡 → **不点发送时不发任何请求** → 点发送 →
  IPC → 主进程守卫;以及"移除草稿后再发送不触发")。
  这两条都用浏览器**原生**的 `DataTransfer` / `ClipboardEvent` / `DragEvent`,
  面板读到的是真实 API 的行为,而不是手搓的一个长得像剪贴板的对象。
- 视频密钥:在**真窗口**里真的存一次(用自检专用假密钥)→ 断言落盘的是 safeStorage
  的密文、密文解得回来、输入框已清空、页面文本/HTML/渲染进程日志里都搜不到那串明文;
  并且第一条就**当场证明**写的是临时 userData(用户真实的 `settings.json` 一个字节都不碰)。

`selftest:acceptance` 会临时往 `plugins/` 放两个夹具(一个正常单文件插件 +
一个清单非法的坏插件),验证设计文档 §14 的标准 5 与 6:

- 标准 5:往 `plugins/` 丢一个 `*.tool.js` 就能用,**不需要改任何其它文件**
- 标准 6:坏插件不拖垮应用,侧边栏出现带原因的红色错误卡片,正常工具照旧可用

夹具在拉起 Electron **之前**写入、结束之后删除,通过还是失败都不会留在仓库里。

## 写一个插件

两种形态,API 完全一致。

**文件夹形态**(要用后台服务就必须用这种):

    plugins/my-tool/
      plugin.json    清单:id / name / version / permissions / contributes
      index.js       入口:export default { activate, setup, teardown }
      panel.html     面板 HTML
      style.css      私有样式(会被自动加上 [data-plugin="my-tool"] 前缀)

**单文件形态**(快速丢一个小工具):

    plugins/my-tool.tool.js   —— 清单、面板 HTML、逻辑全写在里面

```js
export default {
    manifest: { id: 'my-tool', name: '我的工具', version: '1.0.0' },
    activate(ctx) {
        ctx.tools.register({
            id: 'my-tool', title: '我的工具', icon: 'sparkle',
            panel: '<div class="tool-block"><h3>你好</h3></div>',
            setup(el, ctx) { /* el 是已挂载的面板容器 */ },
        });
    },
};
```

**为什么分成 `activate` 和 `setup` 两段:** `activate` 在应用启动时跑一次,只登记
贡献点,**禁止碰 DOM**;`setup` 在用户第一次点开这个工具、面板已经注入 DOM 之后
才调用。旧站 7 个 `tool-*.js` 全都在模块顶层就 `document.getElementById(...)`,
面板不存在会拿到 `null` —— 这个分界就是为了它。

**单文件形态不能声明服务。** 单文件的清单写在模块内部,主进程读不到;若改由渲染
进程回传登记,就等于开了一条"渲染进程递进任意命令行"的通道。要服务就用文件夹形态。

### 权限

清单里的 `permissions` 只能是这 6 个:`log` / `settings` / `services` / `dialog` /
`shell` / `cookies`。未声明的权限对应的 `ctx` 成员**不存在**(不是抛错,是不注入)。

| 权限 | ctx 成员 | 说明 |
|---|---|---|
| `log` | `ctx.log` | 把日志转发到主进程 |
| `settings` | `ctx.settings` | 按插件 id 分命名空间的键值存储 |
| `services` | `ctx.services` | 读状态 / 启停 / 读服务日志 |
| `dialog` | `ctx.dialog` | 系统文件选择框 |
| `shell` | `ctx.shell` | 用系统浏览器打开链接(只放行 http/https) |
| `cookies` | `ctx.cookies` | 「登录一次,自动记住 Cookie」,见下 |

**边界要说清楚:** 这是"安装前可见的审计信息 + 正常路径下的能力门控",**不是对抗
恶意代码的沙箱** —— 插件与外壳共享同一个 JS realm,主进程分辨不出某次 IPC 调用来自
哪个插件。真正结构性、绕不过的保证在主进程侧:不存在任意命令执行通道(服务的命令 /
参数 / 工作目录全部来自清单)、外链只放行 http(s)、文件访问限三个资源根之内。

### 需要登录态的服务:声明 `cookieLogin`

有的站点(比如抖音)接口被风控挡着,**只有浏览器登录后的 Cookie 才过得去**,而那段
标识是页面 JS 在客户端算出来的,纯 HTTP 拿不到。这类插件可以在清单里声明:

```json
"permissions": ["services", "cookies"],
"contributes": {
  "cookieLogin": {
    "title": "登录抖音(开物)",
    "loginUrl": "https://www.douyin.com/",
    "cookieDomain": "douyin.com",
    "target": { "service": "douyin-api", "path": "/douyin/cookie" }
  },
  "services": [ { "id": "douyin-api", "...": "..." } ]
}
```

面板里调 `await ctx.cookies.login()`:开物用自带的 Chromium 开一个**持久分区**的
登录窗(和用户的日常浏览器互不影响),用户扫码一次,之后 Cookie 一直在那个分区里;
登录态一到就自动关窗,开物把它 POST 给你声明的服务。`ctx.cookies.login({ force: true })`
用于换账号。

**为什么不是"打开任意网址取 Cookie"**:登录页、Cookie 域、投递目标全部来自清单,
渲染进程只递一个 pluginId;投递目标只能是**本插件自己声明的服务**,端口也是主进程
从服务清单里查的。Cookie 值**不经过渲染进程**。

## Agent 的流式输出(正文 / 思考 / 工具调用,要给 dsh 的 ACP 桥打一次补丁)

`dsh --profile acp`(本机 dsh-acp 0.1.5-rc.2)只有一条输出路径:**已提交的耐久事件**。于是
`assistant/message` 提交之后才整块发正文与思考(一段生成几秒的正文要等全部写完才到达,应用里
看到的就是「顿一下,然后整段蹦出来」),而工具卡片来自 `tool/call` 耐久事件 —— 它是在**整条
assistant 消息提交之后**才追加的,所以模型只要先写一段正文再调工具,卡片就得等那段正文写完
才现身。harness 自己本来是实时的(`agent/assistant-stream` 的 chunk 帧带 `text-delta` /
`reasoning-delta` / `tool-call-delta`,dsh-headless 就是消费同一路帧把推理实时打到 stderr 的),
只是那座桥没接这一路;它的 `inject` 里没有扩展点、`Config` 里也没有开关,所以只能在桥内部接上。

    node tools/patch-dsh-acp-streaming.mjs           # 打补丁(已打过就只报告)
    node tools/patch-dsh-acp-streaming.mjs --check    # 只看状态,不写盘
    node tools/patch-dsh-acp-streaming.mjs --revert   # 从 .kaiwu-orig 还原

它改的是装机那份 `node_modules/@deepseek-ai/dsh-acp/lib/index.js`:补丁前留 `.kaiwu-orig`
备份,**六条锚点必须各自恰好命中一次**,对不上就拒绝写盘(宁可没补,也不改出半个桥)。
**DSH 升级会覆盖这个文件** —— 升级后重跑一次即可。补丁做六件事:

1. 接上 `agent/assistant-stream`,按 chunk 类型分三路转成 ACP 增量(正文 / 思考 / 工具调用);
2. 工具调用的**第一个**带 name 的 delta 就把卡片建出来,不再等整条消息提交;
3. 正文与思考正式提交时**扣掉已经流出去的块**(否则整段会再发一遍,界面上就是重复);
4. 已经实时宣告过的工具,耐久 `tool/call` 降级成一次 `tool_call_update` —— 而且**不带 `status`**:
   照发一条新的 `tool_call` 会把卡片打回 in_progress,而那时工具可能已经跑完了;
5. 工具结果到达时把该 id 从实时记录里收起(集合不随会话无限长大);
6. 认得出**旧版补丁**(只接了正文,标记是「kaiwu: 流式正文」):只提示先 `--revert` 再升级,
   不在一个已经打过补丁的文件上重复打。

量它有没有生效(会打出每条增量的到达时间、流式/提交各几条、以及重复检测):

    node ..\.agent-probe\acp-stream-timing.mjs

本机实测(同一提示词,`PROBE_VAULT=E:\仓库`):

| 读数 | 打补丁前 | 打补丁后 |
|---|---|---|
| 正文增量 | 1 条,跨 0ms(整块) | 105 条,跨 665ms |
| 提交后重发的正文 | 1 条 | 0 条 |
| 思考增量 | 2 条(整块) | 61 条(逐段) |
| `tool_call` 建卡 | 1113ms(提交之后) | 1077ms(首个带 name 的 delta) |
| 重复检测 | — | 没有重复 |

应用侧的配套改动在 `app/agent/panel.js`:同一条消息的增量**只改文本节点、不重建 DOM**。
整块重建会让 `.agent-sweep` 的 CSS 动画每次都从 0 开始(扫光永远停在起点,等于没有),
思考光标也会一直停在第一帧。

## 让模型能"给几个选项让你选"(问用户)

模型想让你选一个的时候会调 `ask_user_question`。这条链路要**两半都在**才有用:

**① acp profile 得挂上那个工具。** `dsh-base` 只提供了 `userQuestions` **服务**,工具本身
(`@deepseek-ai/dsh-tool-ask-user`)平时由 agent preset 带 —— 而 `dsh --profile acp` 不带 preset,
所以模型手里原本根本没有这个工具。要挂的是 profile 自己的补丁层(**不在仓库里**):

    %APPDATA%\dsh-desktop\harness\profiles\acp\cordis.patch.yml

```yaml
- insert:
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
```

⚠️ 必须**裸挂**:这个工具行不发布服务,只是**消费** `dsh-base` 的 `userQuestions`;
套进 `isolate` realm 反而解析不到那个服务,行会一直等着、mount 判不通过。

**② 桥得会回答它。** ACP 没有"问用户"这个方法,能借的只有 `session/request_permission` ——
上面那个补丁脚本的第七处就是在 `user-questions/request` 瀑布上当回答者,把它映射过去。
映射是**有意受限**的:

| DSH 的提问 | 桥怎么办 | 用户看到 |
|---|---|---|
| 单选 + 有选项 | 一次 `request_permission`,一个选项一个按钮 | **提问卡**(琥珀色 + 「提问」标记) |
| 一次问多题 | **串行**:答完一题再发下一题 | 一张接一张 |
| 多选 / 没有选项 | **不硬凑**,交给下一个回答者(`NO_PROVIDER`) | 模型收到错误,改用正文列清单问你 |
| 用户不答 / 关掉 | `cancelled` | 按"没答"收场(`ASK_ABORTED`) |

**为什么不硬凑**多选与自由文本:把多选降级成单选、或替用户编一段文字答案,模型都会拿它
**当用户的选择**继续往下做 —— 那是假答案。宁可让它收到错误、改用正文问。

提问卡与权限卡**共用**回答通道(`agent:permission`)与"恰好回答一次"的全部保证(去重、
按钮禁用、超时按取消),差别只在画法 —— 靠 `toolCall.kind === 'question'` 这个暗号区分。
选项上的 `description` 是桥给的非标准字段(ACP 的选项没有"说明"这一栏),画成选项下面那行小字。

量这条链路(真凭证、真 dsh;提示词要把工具名说清楚):

    $env:PROBE_PROMPT='用 ask_user_question 工具问我:实现方式选 A 还是选 B?两个选项都要给,推荐 A。'
    node ..\.agent-probe\runtime-tool-test.mjs

预期能看到:`[权限] 实现方式:选 A 还是选 B? → 选 q0`,以及工具结果里
`{"answers":[{"id":"…","selected":["A(推荐)"]}]}` —— 探针会把第一个选项当成用户的回答。

## 让 agent 用中文思考,以及思考条上的「译」

**先治根。** acp-app 那份 bundle 给的人设是英文(`You are a coding agent powered by the
{{model}} model.`),模型就照着那个语言思考 —— 界面上的「思考」条于是整段英文。同一个
profile 补丁层里按 id 覆盖它就行(**零额外模型调用**,回复也跟着变中文):

```yaml
- id: system-prompt
  config:
    personaPrefix: >-
      你是一个由 {{model}} 模型驱动的编码助手。
    personaSuffix: >-
      你的工作目录是 {{cwd}}。请始终用中文思考和回答;代码、命令、路径、报错信息与专有名词保持原样。
```

**兜底:思考条上的「译」。** 人设不是保证,模型偶尔仍会用英文想。**收尾的**思考条上有个「译」,
点了才让桥翻一次(不白花钱),译文与原文都在、可随时切回去。链路:

```
渲染进程   agent:translate { thoughtId, text }
  主进程   runtime.translateThought  → 要求**已有会话**(见下面第 2 条)
    ACP    kaiwu/translate { text, sessionId }   ← 非标准方法:本项目与那个补丁的私约
     桥    ctx.llm.stream() 一次性翻完 → { text }
  回界面   { kind:'translation', thoughtId, status:'pending' | 'done' | 'error' }
```

⚠️ 两个**实测**踩出来的坑,别再踩:

1. **自定义 ACP 方法必须给 params 解析器,而且要把函数直接当第二个参数传。**
   SDK 是 `onRequest(method, handlerOrParams, handler)`,三参时 `handlerOrParams` **整体**
   就是 `params`。写成 `{ params: fn }` 会变成 `spec.params = { params: fn }` →
   `parser.parse is not a function`;更坑的是它发生在**解析阶段**(handler 还没进去),
   所以外面只看到一句 `-32603 Internal error`,连自己加的日志都打不出来。
2. **翻译必须在某个会话的模型路由下进行(要带 `sessionId`)。** 不带它去调,桥那边解析不到
   provider 的凭证,只会回一条 `no API key for provider route …`(`MISSING_CREDENTIAL`)。
   界面上「译」只长在收尾的思考条上,那时一定有会话;探针要先发一条提示再翻。

量这条链路(会先建会话、再翻,并打印耗时):

    node ..\.agent-probe\kaiwu-translate-test.mjs

## 视频理解(把视频拖进 AI 面板)

把一段视频**拖进右侧 AI 面板**(或黏贴)—— 它只是变成输入框上的一张**待发送草稿卡**
(文件名 + 大小 + 那句"模型听不到声音"),**这一步不会发任何请求**。再按「发送」
(或回车)才真的调用:输入框里有字就用那段字当提问,没字用一句默认问法。
结果作为一条助手消息进消息流,那条带视频卡的用户消息也在此时才出现。
草稿卡上的「×」随时可以移除,移除后再发送不会触发任何调用。

**第二入口:队列里已经下好的文件** —— B站下载队列那张已完成卡片上有「理解」,
点它就把**本地路径**交给 AI 面板(结果同样进对话)。两条入口的上限**不同,而且理由是分开的**:

| 入口 | 单段上限 | 为什么是这个数 |
| --- | --- | --- |
| 拖入 / 粘贴 | **64 MiB** | 字节要**过 IPC**(结构化克隆进主进程)。这条限制管的是**拷贝量**,与 DashScope 无关 —— 一次几 GB 的拷贝会把界面卡住 |
| 队列里已知本地路径 | **1024 MB** | 文件由主进程**按路径自己读**,不过 IPC —— 上限就是服务端自己报的 `max_file_size_mb`(实测 `getPolicy` 返回 1024) |

按路径那条会**流式**上传(前缀 → 文件流 → 后缀),所以 169.5 MB 的文件在内存里
只有一条流;实测(2026-09-19,真实 API):上传 26.6 秒 + 理解 20.9 秒,共 **47.7 秒**,
`video_tokens` **127,766**(服务端对长视频会降采样,不是简单按秒数线性增长)。
拖入/粘贴那条仍然把整份请求体拼成一块(它的文件本来就在内存里,且 ≤64 MiB)。

**配置密钥**:输入卡片上有常驻的「密钥」按钮 —— **点一下展开、再点一下收起**
(`aria-expanded` / 标签 / 按下态都跟着变,卡片里另有一个「收起」)。

    setx DASHSCOPE_API_KEY sk-xxxx        # ① 环境变量(优先、不落盘 —— 推荐)
    ② 或者在密钥卡片里填一次

⚠️ **环境变量优先**:如果 `DASHSCOPE_API_KEY` 已经设在环境里,卡片里保存的密钥
**不会生效** —— 这一点卡片上会明写出来(不说清就变成了"存了没反应"的静默行为)。

填的那一份**存进开物的设置文件**(`%APPDATA%\kaiwu\settings.json`)。系统加密
(`safeStorage`)可用时存的是**密文**,不可用时退回明文 —— 卡片上会如实告诉你是哪一种。
密钥**不进界面、不进日志、不进任何状态返回值**:对外只有
`{ ok, source, storage, reason }` 这几个叶子字段;保存成功后输入框立刻清空。
这几条都有断言钉着(`tests/video-panel.test.js` 的单测,以及 `npm run selftest`
在**真窗口**里真的存一次、再断言落盘的是密文而不是明文)。

三条必须先知道的事实(都实测过,细节见 `app/lib/agent-video.js` 顶部的注释):

1. **整段视频直接发给 DashScope,本机不需要 ffmpeg**。抽帧在服务端做。
   本机 ffmpeg 被系统策略拦着(`contains a virus or potentially unwanted software`),
   所以"本地抽帧再送图"这条路在这台机器上根本不存在 —— 这也是这个功能这么设计的原因。
2. **模型只看画面,听不到声音**。对话、旁白、背景音乐都不在理解范围内 ——
   卡片上常驻着这一句,别拿它当"听懂了内容"。
3. **`fps` 参数被服务端静默忽略**(fps=1/2/不传,`video_tokens` 一模一样),
   所以界面上不暴露它 —— 摆一个不起作用的旋钮只会让人以为自己能控成本。

投递路径按体积自动分发:小文件内联 `data:video/mp4;base64,…`(上限是服务端的
20 MiB base64,判据留了 1 MiB 余量);超过就走 DashScope 的**临时上传**
(`GET /api/v1/uploads?action=getPolicy` → multipart POST → `oss://…`,用的时候
必须带 `X-DashScope-OssResourceResolve: enable`,少了它服务端不解析 oss://)。

代码位置:`app/lib/agent-video.js`(纯判据,渲染层与主进程共用)、
`electron/video/dashscope.js`(provider:构造请求 → 分发 → 解析 → 中文错误)、
`electron/video/video-settings.js`(配置与密钥)、`electron/video/video-ipc.js`(IPC 契约)。

## B站下载队列(B站工具面板内的队列区)

在 B站工具里点「加入下载队列」之后,面板下方会长出一条队列区(设计稿见
`docs/kaiwu-bilibili-queue-demo.html` 的方案 A):封面 / 标题 / UP主 / 时长 / 状态 /
进度。整块就是进度条 —— 填充锚在左边、向右生长,上面叠两层浅绿流光;
下载中的标题带与聊天框同一套扫光;已完成用勾号图标,复制视频用复制图标。

三条要知道的事:

1. **数据来自本地代理(3302),不新增 IPC 数据通道**。代理把上游的
   `/api/getTaskList`(全量)+ `/api/getActiveTask`(进度)合成一个响应,
   并**顺带解决"最终文件名"**——上游只给 `folder + title`,而磁盘上的文件名带随机
   后缀,详见 `web_api.py` 里 `_pick_output_file` 的说明与它标注的歧义风险。
2. **轮询只在有进行中的任务时发生**:队列空 / 全部完成 / 上一次取失败 → 立刻停止,
   一个请求都不再发(判据是纯函数 `planPoll()`,有单测逐条钉着)。
   实测这两个上游端点是读本地库(中位 1–2ms),但节流照做 —— 风控那次事故的同源问题就是高频请求。
3. 「复制视频」走**主进程**(`clipboard:copyVideo`):渲染进程只递 `taskId`,
   主进程自己去代理解析路径、逐条核对,再用 Windows PowerShell 5.1 `-STA` +
   `[System.Windows.Forms.Clipboard]::SetFileDropList` 写 CF_HDROP
   (**pwsh 默认 MTA 时 `Set-Clipboard -Path` 会静默失败**,实测)。失败会重试并给中文原因。

代码位置:`app/lib/bilibili-queue.js`(纯逻辑:状态/排序/轮询判据/复制前核对)、
`app/lib/bilibili-copy.js`(PowerShell 脚本与失败判定)、
`electron/bilibili/bilibili-ipc.js`(IPC 通道)、`plugins/bilibili/`(面板与队列渲染)。

## 环境约束(实测踩过的坑)

1. **GitHub release 下载被墙。** Electron 二进制必须走镜像:装二进制前设
   `$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"`,配合下面
   「命令」一节的两步安装。`.npmrc` 里的 `electron_mirror` **是无效键,已删掉**:
   npm 不认它(每次调用都警告 `Unknown project config`),而手动跑
   `node node_modules/electron/install.js` 不属于 npm 生命周期脚本,`@electron/get`
   根本拿不到 `npm_config_electron_mirror` —— 它认的是环境变量 `ELECTRON_MIRROR`。
2. **`@electron/get` 读的是小写环境变量 `electron_config_cache`**,不是 `ELECTRON_CACHE`。
   npmrc 里的 `electron_cache` 键无效(npm 只会转成 `npm_config_electron_cache`)。
3. **npm 缓存默认落在 `%LOCALAPPDATA%`**,受限环境下会 `EPERM`。`.npmrc` 已把
   `cache` 重定向到 `D:/project/.npm-cache`。
4. **Windows 上 `electron.exe` 是 GUI 子系统程序**,默认不会往父控制台写东西。所以日志能不能
   被看见取决于调用方给的 stdio:**`stdout` 是管道时(脚本捕获)、或者走 GUI 子系统的默认句柄时**,
   `console.log` 到不了父控制台;由 shell 直接拉起 `electron.exe` 时连退出码也拿不到(命令解释器
   不等 GUI 子系统进程结束)。`npm run selftest` 不属于这种情况:它由 `run-selftest.js` 走
   `child_process` 拉起并等待,退出码是子进程的真实值;只是结果仍然另写一份
   `selftest-result.txt`(脚本化验证一律写结果文件,这条规矩不变)。而 `npm start` 用
   `stdio: 'inherit'` 继承当前控制台句柄(继承的是句柄,不是管道),Electron 的报错能直接看见。
5. **Chromium 的 mojo IPC 用 Windows 命名管道**,受限沙箱会静默阻断(表现为主进程能启动、
   `app ready` 永不触发、Chromium 日志 0 字节)。开发此项目需要完整文件访问权限。
6. **工具会话里的 `node` 可能是 `%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd`**,
   这个包装脚本会 `set ELECTRON_RUN_AS_NODE=1`。变量被 `electron.exe` 继承后它会退化成纯 Node
   —— 没有 `app`、窗口起不来、`require('electron')` 只拿到 npm 包的路径字符串。
   `npm start` 和 `npm run selftest` 现在都走 `electron/launch.js`:它会解析 Electron 二进制、
   复制一份 `process.env` 并摘掉 `ELECTRON_RUN_AS_NODE`,再拉起真正的 GUI 进程 ——
   所以在这个环境里也能正常开窗,普通终端下同样不受影响。`npm start` 会把 Electron 的
   stdout/stderr 接到当前控制台,启动失败能直接看到报错。
7. **Agent 用的那份 Node 必须是 dsh 自带的那份(v24),系统 PATH 上的 v22 会让工具全挂。**
   harness 内部有一批靠 `import.meta.main` 自执行的辅助进程(Windows Job runner、ripgrep
   provider 等),而 `import.meta.main` 在 **Node < 24.2** 上是 `undefined` —— 它们会
   **零输出、退出码 0、秒退**,表现是 `pwsh` / `glob` / `grep` 一律失败
   (`Windows Job runner exited with exit code 0…`、`ripgrep provider failure`),而
   `read` 这种不起进程的工具照常,于是模型只能靠猜文件名反复 `read`(屏幕上就是一墙"失败")。
   本机 dsh 自带的是 v24.9.0,系统 PATH 上的是 v22.17.0。
   踩坑点还套了一层:Windows 的环境变量名大小写不敏感,`process.env` 的真实键名是 **`Path`**,
   而 `electron/main.js` 递下去的是一份**普通对象拷贝** `{ ...process.env, APPDATA: … }` ——
   普通对象是大小写敏感的,`copy.PATH` 于是是 `undefined`,整段 PATH 搜索被静默跳过、
   直接退化到 `%ProgramFiles%\nodejs\node.exe`(v22)。`resolveNodeExecutable` 现在
   按大小写不敏感取 `PATH`,并且**优先用 `<appRoot>/node_modules/node/bin/node.exe`**;
   `KAIWU_NODE` 仍然最高优先级。

## 首次装依赖:Electron 二进制必须两步,缺一不可

`electron@44.4.1` 的 package.json 里**没有 `scripts` 字段**,所以 `npm install` 不会去下载
`node_modules/electron/dist/`。装完依赖必须再单独跑一次官方安装脚本:

    cd "D:\project\kaiwu"
    $env:electron_config_cache = "D:\project\.electron-cache"   # 必须是小写这个名字
    $env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
    npm install
    node node_modules\electron\install.js

第二步先查 `dist/version`,二进制已经在时是秒过的空操作;真要下载时,`ELECTRON_MIRROR` 必须
已经在环境里(不然就是环境约束 1 的墙)。上面这块与 `electron/launch.js` 缺二进制时打印的
提示是同一份内容,改一处要改两处。二进制没装好时 `npm start` / `npm run selftest` 会把这段
原样打出来。
