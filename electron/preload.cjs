// 唯一的 CommonJS 文件。sandbox: true 下预加载不支持 ESM,所以扩展名必须是 .cjs。
const { contextBridge, ipcRenderer } = require('electron');

// 频道路由表。渲染进程侧的第一道约束 —— 主进程对未注册的频道本来也会拒绝,
// 但在这里挡住能让错误更早、更清楚地暴露出来。
const ALLOWED_INVOKE = [
    'kaiwu:plugins:scan',
    'kaiwu:plugins:registerManifest',
    'kaiwu:services:list',
    'kaiwu:services:start',
    'kaiwu:services:stop',
    'kaiwu:services:logs',
    'kaiwu:settings:get',
    'kaiwu:settings:set',
    'kaiwu:dialog:openFile',
    // 选目录(插件想把数据放到笔记库之外时才用得上)。只回用户选中的那一个路径。
    'kaiwu:dialog:openDirectory',
    'kaiwu:shell:openExternal',
    // 「登录一次,自动记住 Cookie」:只递 pluginId,登录页/域名/投递目标全部来自
    // 插件清单,主进程还会把 Cookie 直接 POST 给该插件自己的服务(值不经过这里)。
    'kaiwu:cookies:login',
    // 「用自带浏览器取数据」:同样只递 pluginId + 网址,网址还要过插件清单里的 allow。
    'kaiwu:browser:fetchJson',
    'kaiwu:log',
    // 启动阶段诊断日志(渲染进程 → 主进程写文件)。
    // 只是个日志通道,不构成新能力。
    'kaiwu:stage',
    // 笔记子系统。渲染进程只能递相对 Vault 的相对路径,绝对路径由主进程解析。
    'canvas:library',
    'canvas:create',
    'canvas:read',
    'canvas:write',
    'canvas:importImage',
    'canvas:media',
    'canvas:readNote',
    'canvas:writeNote',
    'notes:vault:status',
    'notes:vault:choose',
    'notes:vault:clear',
    'notes:vault:set',
    'notes:index',
    'notes:read',
    'notes:write',
    'notes:create',
    // 新建文件夹(侧栏树状列表用)。同样只递 Vault 内的相对目录名。
    'notes:mkdir',
    'notes:links',
    'notes:replaceFrontmatter',
    'notes:rename',
    // 拖放落点:把**任意文件或目录**在笔记库内挪位置(png / docx / json / 整个文件夹)。
    // 与 notes:rename 的分工见主进程注释;两道防线(路径越界、移进自己的子孙)
    // 都在主进程,渲染进程只递相对路径。
    'notes:move',
    // 用系统程序打开一个**非笔记文件**(树里那些 png / docx / json)。
    // 只递相对路径,主进程过路径守卫后交给 shell.openPath。
    'notes:openPath',
    // 「命名好却保存不了」:标题输入框提交(回车/失焦)走这条。
    // 与 notes:rename 一样只递相对路径,新名字由主进程洗过再落地。
    'notes:setTitle',
    // 删除一篇笔记(列表行右键菜单的第二项)。同样只递**库内相对路径**一个叶子字段;
    // 主进程只收 `.md`,并且走的是系统回收站(shell.trashItem)—— 可还原,**不是**永久删。
    // 笔记的 `.md.bak` 由主进程一并送进去,不由渲染层递第二个路径。
    'notes:remove',
    // 删除一个**文件夹**(列表里文件夹行右键菜单的第二项)。同样只递库内相对路径;
    // 主进程单独守一道 —— 其中一条是"绝不能是笔记库根本身"(见主进程注释)。
    'notes:removeDir',
    // AI 面板(Agent over ACP)。渲染进程只能递提示文本 / 权限选项 id ——
    // 命令、cwd、环境变量全部由主进程按候选清单与当前 Vault 算出来。
    'agent:status',
    'agent:credentials',
    'agent:start',
    'agent:stop',
    'agent:send',
    'agent:cancel',
    // 改会话配置(模型 / 思考强度):只递 { configId, value } 两个字符串,
    // 而 value 是渲染进程从对端那份 configOptions 里**原样抄回来**的不透明串。
    'agent:setConfig',
    // 换模型之后重新问一次"能不能收图片"(桥那边由 kaiwu 自己的补丁提供问法)。
    'agent:capabilities',
    'agent:permission',
    // 按需翻译:只递 (thoughtId, 原文)。翻成什么语言、用哪个模型,都由主进程与桥定。
    'agent:translate',
    // 视频理解(DashScope 本地视频直传)。渲染进程只递四个叶子字段:
    // { mimeType, bytes, name, question } —— 递不进 URL、上限、模型白名单;
    // 密钥那条通道只**收**一串待存的密钥,任何返回值里都没有密钥值。
    // 触发点只有一个:用户点「发送」→ video:understand。拖入视频本身**不发任何 IPC**
    // (它只是输入区里的一份草稿),所以这里没有也不需要"自动理解"那条通道。
    'video:status',
    'video:understand',
    // 按**本地路径**理解(队列里已经下好的文件走这条):渲染进程只递
    // path/folder/name/mimeType/question 五个叶子字段,文件由主进程自己读 ——
    // 所以这条入口能到服务端自己的 1024 MB。主进程会核:绝对路径 / 扩展名白名单 /
    // 文件存在且是文件 / **路径必须落在这个下载目录里**。
    'video:understandPath',
    'video:key:set',
    'video:key:clear',
    'video:model:set',
    // 取消一次正在进行的理解。只递一个 requestId(不透明字符串),
    // 取消谁由主进程按它找 —— 渲染进程说不出别的。
    'video:cancel',
    // 「把下载好的视频放进系统剪贴板」(B站下载队列的「复制视频」)。
    // 渲染进程只递一个 taskId —— **递不进路径**:主进程自己去本地队列服务解析、
    // 逐条核对(任务存在/已完成/路径在该任务的下载目录里/文件真的在),
    // 再交给 Windows 剪贴板(CF_HDROP)。需要清单申请 "clipboard" 权限。
    'clipboard:copyVideo',
    // 短剧工作台。引擎(fs / child_process / crypto)跑在**主进程**里 —— 渲染进程
    // 是沙箱,拿不到这些。所以这里只递叶子字段(项目名 / 节点 id / 提示词),
    // 路径一律由主进程按"当前笔记库"解析。需要清单申请 "drama" 权限。
    'drama:root',
    'drama:projects',
    'drama:state',
    'drama:save',
    'drama:run',
    'drama:readOutput',
    'drama:image:status',
    'drama:image:key:set',
    'drama:image:key:clear',
    'drama:create',
    // 项目面板的两条:改名、删除(删除走系统回收站,可恢复)。
    'drama:rename',
    'drama:remove',
    // 「＋ 导入」:把一个文本文件抽成纯文本交给面板(**只读**,不往项目里拷东西)。
    // 从前的 'drama:import'(拷进项目 + 在节点上记路径)与 source/useSource 两个参数一起删了。
    'drama:readText',
    // 从系统拖进画布的 Word:只递文件名与字节,不递磁盘路径。
    'drama:readDroppedText',
    'drama:media',
    'drama:importImage',
    // 「AI 会话」:会话台账(记录写在 <笔记库>/AI会话/ 里)。
    // 渲染进程只递**会话 id**;读写哪个目录由主进程按当前笔记库算。
    // ⚠️ `sessions:activate` 是这里唯一会**换掉当前会话上下文**的动作(「接着聊」),
    //    它把一件事做完就回来,失败时回结果对象(带一句人话的原因),不 throw。
    'sessions:list',
    'sessions:read',
    // 新建一条会话(点了立刻建:对端真的 session/new,台账当场落一条 0 轮的记录)。
    'sessions:new',
    'sessions:remove',
    'sessions:activate',
];

// 单向通报(渲染层 → 主进程,**没有返回值**)的频道表。
// 与 ALLOWED_INVOKE 分开列是因为方向不同:那条是"问一件事、等一个回答",
// 这条只是通告 —— 主进程收到就办事,不回任何东西,所以不能走 invoke。
const ALLOWED_SEND = [
    // 「窗口」菜单要列出**程序目前所有的面板**,而这份表只有渲染层知道
    // (插件面板是插件激活时才登记的,主进程看不到)—— 布局一变就报一次,
    // 主进程据此重建菜单。递过去的只有 id / 标题 / 开着没有三种叶子字段。
    'kaiwu:panels:report',
    'preferences:reset-layout',
    'preferences:change-vault',
    'preferences:motion-change',
    'preferences:layout-text',
    'preferences:layout-text-request',
];

// 桥只活在预加载的闭包里,不挂在 window 上。
const bridge = {
    invoke(channel, payload) {
        if (!ALLOWED_INVOKE.includes(channel)) {
            return Promise.reject(new Error('未授权的 IPC 频道: ' + channel));
        }
        return ipcRenderer.invoke(channel, payload);
    },
    /**
     * 单向通报(没有返回值)。白名单与 invoke 那一份是同一个作用:挡住没登记过的频道,
     * 让"两边漂移"更早暴露 —— 只是这里没有 promise 可拒,所以直接抛。
     */
    send(channel, payload) {
        if (!ALLOWED_SEND.includes(channel)) {
            throw new Error('未授权的 IPC 频道: ' + channel);
        }
        ipcRenderer.send(channel, payload);
    },
    on(channel, handler) {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },
    /**
     * 订阅主进程推来的 Agent 事件(`agent:event`)。
     *
     * ⚠️ 回调收到的是**纯数据**:上面那个 listener 只把 payload 递出去,
     * Electron 的 event 对象一个字节都不进页面(它带着 sender 等活对象,
     * 递过去既没用又不安全)。
     *
     * 返回取消订阅的函数;调用方忘了取消也不会让渲染进程崩 ——
     * 事件是单向推送,重复订阅最多是多画一次。
     */
    onAgentEvent(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onAgentEvent 需要一个函数');
        }
        return bridge.on('agent:event', callback);
    },
    /**
     * 订阅视频理解推来的**进度事件**(`video:event`)。
     *
     * 为什么要这条:方案 C 的四段状态行要的是"上传到 37% / 已等待 12 秒 / 已生成 210 字"
     * 这些**中间**读数,而 `invoke` 只在整件事结束时回一次 —— IPC 上没别的办法。
     * 推过来的同样是**纯数据**(叶子字段 + 一个 requestId),没有 event 对象、没有流对象。
     */
    onVideoEvent(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onVideoEvent 需要一个函数');
        }
        return bridge.on('video:event', callback);
    },
    onDramaRunEvent(callback) {
        if (typeof callback !== 'function') throw new Error('onDramaRunEvent 需要一个函数');
        return bridge.on('drama:runEvent', callback);
    },
    /**
     * 上报当前普通面板表与工具面板表—— 主进程据此重建「窗口」菜单。
     *
     * 为什么用 send 而不是 invoke:主进程只需要知道"窗口里此刻有哪些面板",
     * 没有任何东西要回给渲染层。菜单重建的结果(哪几条打勾)不需要回执 ——
     * 它下一轮上报时会自然对齐。
     *
     * 只做形状级的兜底(不是数组就当空表):真正的内容过滤在主进程那一侧 ——
     * 这条通道的另一端是页面,主进程不该假设它递上来的一定是干净的。
     */
    reportPanels(views, tools = []) {
        bridge.send('kaiwu:panels:report', {
            views: Array.isArray(views) ? views : [],
            tools: Array.isArray(tools) ? tools : [],
        });
    },
    /**
     * 订阅主进程的「把某个面板加进窗口」命令(`menu:add-view`)。
     *
     * ⚠️ 与 onAgentEvent 同一个形状:回调收到的是**纯数据**(一个视图 id 字符串),
     * Electron 的 event 对象一个字节都不进页面(它带着 sender 等活对象)。
     * 返回取消订阅的函数。
     */
    onAddPanel(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onAddPanel 需要一个函数');
        }
        return bridge.on('menu:add-view', callback);
    },
    requestPreferencesResetLayout() {
        bridge.send('preferences:reset-layout');
    },
    requestPreferencesChangeVault() {
        bridge.send('preferences:change-vault');
    },
    requestPreferencesMotionChange(off) {
        if (typeof off !== 'boolean') throw new Error('动效设置必须是布尔值');
        bridge.send('preferences:motion-change', { off });
    },
    onPreferencesResetLayout(callback) {
        if (typeof callback !== 'function') throw new Error('onPreferencesResetLayout 需要一个函数');
        return bridge.on('preferences:main-reset-layout', callback);
    },
    onPreferencesChangeVault(callback) {
        if (typeof callback !== 'function') throw new Error('onPreferencesChangeVault 需要一个函数');
        return bridge.on('preferences:main-change-vault', callback);
    },
    onPreferencesMotionChange(callback) {
        if (typeof callback !== 'function') throw new Error('onPreferencesMotionChange 需要一个函数');
        return bridge.on('preferences:main-motion-change', callback);
    },
    reportPreferencesLayoutText(text) {
        bridge.send('preferences:layout-text', { text: String(text ?? '') });
    },
    requestPreferencesLayoutText() {
        bridge.send('preferences:layout-text-request');
    },
    onPreferencesLayoutTextRequest(callback) {
        if (typeof callback !== 'function') throw new Error('onPreferencesLayoutTextRequest 需要一个函数');
        return bridge.on('preferences:main-layout-text-request', callback);
    },
    onPreferencesLayoutText(callback) {
        if (typeof callback !== 'function') throw new Error('onPreferencesLayoutText 需要一个函数');
        return bridge.on('preferences:layout-text', callback);
    },
};

// 交接给渲染进程的**唯一**方式,也是这个文件存在的理由。
//
// 为什么不用 exposeInMainWorld(设计文档 §5.2 原本的写法):
// 它建的属性是 writable: false + configurable: false。ES 模块体始终是严格模式,
// 于是 `delete window.__kaiwuBridge` 会抛 TypeError,`= undefined` 也会抛 ——
// 两者都做不到(已实测)。结果是桥在 window 上永久可见,任何页内代码都够得着,
// 与"IPC 桥不挂在 window 上"这条要求正好相反。
//
// 改用 contextBridge.executeInMainWorld:它把 bridge 当**参数**交给一个在主世界
// 里执行的函数(跨世界按支持的类型复制,拿到的是一份可用的代理)。那个函数自己
// 把 bridge 收进闭包、再把临时全局删掉 —— 主世界因此不会留下任何全局名字。
// 外壳脚本通过 import 拿到那份闭包,插件模块则完全够不着它。
//
// 时序:预加载在文档创建时执行,而 <script type="module"> 是延迟执行的,
// 所以这段一定先于外壳脚本跑完。
try {
    contextBridge.executeInMainWorld({
        func: (api) => {
            // 顺带在主世界最早的时刻装一个错误陷阱。
            // 模块脚本的解析/求值错误(比如重复声明、写错标识符)既不会进
            // console-message,也不会冒到任何主进程可见的地方 —— 表现只是
            // "页面什么都没发生"。自检通过它把真实原因读出来。
            window.__kaiwuErrors = [];
            window.addEventListener('error', (e) => {
                window.__kaiwuErrors.push('error: '
                    + (e.message || e.error?.message || String(e.target?.src || e.target)));
            }, true);
            window.addEventListener('unhandledrejection', (e) => {
                window.__kaiwuErrors.push('rejection: ' + (e.reason?.message || String(e.reason)));
            });

            window.__kaiwuBridgeTemp = api;
        },
        args: [bridge],
    });
} catch (err) {
    // 预加载里没法往主世界记错误,只能往控制台写
    console.error('[preload] 桥交接失败', err);
}
