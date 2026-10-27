// 按清单声明的权限构造插件 ctx。
//
// 重要边界(见设计文档 §3.4):这是"正常路径下的能力门控",不是对抗恶意代码的沙箱。
// 插件与外壳共享同一个 JS realm,主进程无法分辨某次 IPC 调用来自哪个插件。
// 真正的结构性保证在主进程侧(服务命令只能来自已校验清单、外链限 http/https、
// 文件访问限三个根目录),不在这里。
const HTTP_URL = /^https?:\/\//i;

export function buildCtx({ descriptor, bridge, registries, log = console }) {
    const pluginId = descriptor.id;
    const permissions = descriptor.permissions ?? [];
    const disposers = [];

    const invoke = (channel, payload) => bridge.invoke(channel, payload);

    // 日志是尽力而为的:它是插件唯一无条件的反馈通道,不能因为
    // 「主进程还没接线」这类原因反过来把插件搞崩。
    // 不接住拒绝的话,未处理的 Promise 拒绝会冒到全局。
    const invokeQuietly = (channel, payload) => {
        try {
            Promise.resolve(bridge.invoke(channel, payload)).catch(() => {});
        } catch {
            /* 同步抛出同样吞掉 —— 日志失败不该影响调用方 */
        }
    };

    // 本地 console 一直写(开发时最有用);转发到主进程要申请 log 权限。
    // 这样「log 权限控制是否转发、不控制成员存在与否」这句话才真的成立 ——
    // 否则每个 ctx.log 调用都会往一个未授权的频道发消息。
    const writeLog = (level, sink, msg, rest) => {
        sink.call(log, `[${pluginId}] ${msg}`, ...rest);
        if (permissions.includes('log')) {
            invokeQuietly('kaiwu:log', { level, pluginId, message: String(msg) });
        }
    };

    const ctx = {
        plugin: Object.freeze({
            id: pluginId,
            name: descriptor.name,
            version: descriptor.version,
            root: descriptor.root,
            dir: descriptor.dir,
        }),

        // log 成员始终存在 —— 它是插件唯一无条件的反馈通道,
        // 否则插件出错时连一句话都说不出。
        log: {
            info: (msg, ...rest) => writeLog('info', log.info, msg, rest),
            warn: (msg, ...rest) => writeLog('warn', log.warn, msg, rest),
            error: (msg, ...rest) => writeLog('error', log.error, msg, rest),
        },

        tools: {
            register(spec) {
                return registries.tools.define({ order: 1000, ...spec, pluginId });
            },
        },

        // 注册平铺工作台里的一片面板。与 tools 的区别是**归宿**:
        // 工具面板住内容区(切走再切回来重建),pane 参与布局树 ——
        // 用户能拖它、停靠它,布局进存档,所以它必须由外壳在挂载工作台时装配。
        //
        // spec:{ id, title, fullTitle?, el?, mount? }
        //   · el     —— 直接给一个已存在的元素
        //   · mount  —— 或给一个 (host) => void,由外壳建好宿主再交给它渲染
        // 两者都给时以 el 为准;都不给则只登记标题(面板会是空的,排错时很有用)。
        panes: {
            register(spec) {
                if (!spec || typeof spec.id !== 'string' || spec.id === '') return false;
                return registries.panes.define({ order: 1000, ...spec, pluginId });
            },
        },

        onDispose(fn) {
            if (typeof fn === 'function') disposers.push(fn);
        },

        // 运行时内部使用,不写进文档给插件作者
        __dispose() {
            // 逆序释放:后申请的资源先放,顺序与构造相反。
            for (const fn of disposers.reverse()) {
                try {
                    fn();
                } catch (err) {
                    log.error(`[${pluginId}] onDispose 回调抛错`, err);
                }
            }
            disposers.length = 0;
        },
    };

    // 注意:services 刻意不提供 define —— 服务只能由清单声明,
    // 否则渲染进程就能递进任意命令行,架空主进程的那条保证。
    if (permissions.includes('services')) {
        ctx.services = {
            list: () => invoke('kaiwu:services:list', { pluginId }),
            start: (id) => invoke('kaiwu:services:start', { pluginId, id }),
            stop: (id) => invoke('kaiwu:services:stop', { pluginId, id }),
            status: (id) => invoke('kaiwu:services:list', { pluginId })
                .then(list => (Array.isArray(list) ? list.find(s => s.id === id) ?? null : null)),            logs: (id) => invoke('kaiwu:services:logs', { pluginId, id }),
            on(id, event, cb) {
                if (event !== 'change') throw new Error('只支持 change 事件');
                return bridge.on('kaiwu:services:changed', (state) => {
                    if (state && state.id === id) cb(state);
                });
            },
        };
    }

    if (permissions.includes('settings')) {
        ctx.settings = {
            get: (key, fallback = null) => invoke('kaiwu:settings:get', { pluginId, key })
                .then(v => (v === undefined || v === null ? fallback : v)),
            set: (key, value) => invoke('kaiwu:settings:set', { pluginId, key, value }),
        };
    }

    if (permissions.includes('dialog')) {
        ctx.dialog = {
            // 注意:openFile 不带 pluginId —— 它不是插件命名空间下的能力,
            // 主进程只返回用户实际选中的路径(见设计文档 §5.2 的频道表)。
            openFile: (options = {}) => invoke('kaiwu:dialog:openFile', options),
            // 选**目录**:插件想把数据放到笔记库之外时才需要(默认位置就在笔记库旁边,
            // 用 vault.path() 就够)。与 openFile 同一口径:主进程只回用户选中的那一个。
            openDirectory: (options = {}) => invoke('kaiwu:dialog:openDirectory', options),
        };
    }

    // 「读写当前笔记库」。
    //
    // 为什么做成一项能力而不是让插件自己去拼:笔记库的路径只有主进程知道,而
    // 笔记库的**守卫**也在主进程(vault-path.js 的两层:词法层挡 ../ 与盘符,
    // 真实路径层挡符号链接与目录联接逃逸)。插件在这里只能递**相对路径**,
    // 一个绝对路径都递不进去 —— 与既有 notes:* 通道完全同一条路。
    //
    // 典型用法:数据存在笔记库旁边(`<vault>/短剧/<项目>/graph.json`),
    // 于是它跟着笔记库一起备份、同步、进版本控制。
    if (permissions.includes('vault')) {
        ctx.vault = {
            /** → {configured, ok, path, reason};没配笔记库时 path 为 null。 */
            status: () => invoke('notes:vault:status', {}),
            /** → 笔记库绝对路径,或 null(没配 / 配的那个现在不可用)。 */
            path: () => invoke('notes:vault:status', {})
                .then((s) => (s && s.ok === true && typeof s.path === 'string' ? s.path : null)),
            /** 读库内一个文件(相对路径,统一 / 分隔)。 */
            readText: (relativePath) => invoke('notes:read', { path: relativePath }),
            /** 写库内一个文件(相对路径)。内容必须是字符串。 */
            writeText: (relativePath, text) => invoke('notes:write', { path: relativePath, text }),
        };
    }

    if (permissions.includes('canvas')) {
        // 按版本绑定库：延迟保存即使省略 token，也只沿用当时读取的那一个。
        const bindings = new Map();
        const remember = result => {
            if (result?.path && result?.revision && result?.vault) {
                const key = `${result.path}\n${result.revision}`;
                // 两个库可有字节相同的同名文件；歧义版本必须由调用方显式给 token。
                if (bindings.has(key) && bindings.get(key) !== result.vault) bindings.set(key, null);
                else bindings.set(key, result.vault);
                if (bindings.size > 256) bindings.delete(bindings.keys().next().value);
            }
            return result;
        };
        ctx.canvas = {
            library: () => invoke('canvas:library', {}),
            create: (name, vault) => invoke('canvas:create', { name, vault }).then(remember),
            read: (path, vault) => invoke('canvas:read', { path, vault }).then(remember),
            write: (path, graph, revision, vault = bindings.get(`${path}\n${revision}`)) => invoke('canvas:write', { path, graph, revision, vault }).then(remember),
            importImage: (path, image, vault) => invoke('canvas:importImage', { path, name: image?.name, bytes: image?.bytes, mimeType: image?.mimeType, vault }),
            media: (file, vault) => invoke('canvas:media', { file, vault }),
            readNote: (path, vault) => invoke('canvas:readNote', { path, vault }),
            writeNote: (path, text, revision, vault) => invoke('canvas:writeNote', { path, text, revision, vault }),
        };
        disposers.push(() => bindings.clear());
    }

    if (permissions.includes('shell')) {
        ctx.shell = {
            openExternal(url) {
                // 渲染进程侧先挡一道;主进程会再挡一道(见设计文档 §3.4)
                if (typeof url !== 'string' || !HTTP_URL.test(url)) {
                    return Promise.reject(new Error('只允许打开 http/https 链接'));
                }
                return invoke('kaiwu:shell:openExternal', { url });
            },
        };
    }

    // 「登录一次,自动记住 Cookie」(cookieLogin 贡献点)。
    //
    // 插件能做的只有"请主进程按**我自己清单里写的**配置走一遍登录流程" ——
    // 它递不进登录页、域名,也拿不到 Cookie 值(主进程直接投递给它自己的服务)。
    // 之所以做成这样,是因为抖音那类站点的 Cookie 只有真浏览器登录后才有,
    // 而"打开任意网址并读 Cookie"会是一个大得多的能力。
    if (permissions.includes('cookies')) {
        ctx.cookies = {
            /** @param {{force?: boolean}} [options] force=true 时即使已登录也重开登录窗 */
            login: (options = {}) => invoke('kaiwu:cookies:login', {
                pluginId,
                force: options.force === true,
            }),
        };
    }

    // 「用自带浏览器取数据」(browserFetch 贡献点)。
    //
    // 用途:接口被风控守着、签名只能由页面自己的 JS 算的站点。插件只能请求打开
    // **自己清单 allow 列表里**的网址,而且主进程只把命中 capture 的那个响应交回来。
    // 拿不到 Cookie 值,也打不开列表之外的站。
    if (permissions.includes('browser')) {
        ctx.browser = {
            /** @param {{url: string}} options 要打开的页面(必须命中清单里的 allow) */
            fetchJson: (options = {}) => invoke('kaiwu:browser:fetchJson', {
                pluginId,
                url: options.url,
            }),
        };
    }

    // 「把**本地文件**放进系统剪贴板」。网页 API 放不进文件(只能放文本/图片),
    // 所以这件事只能由主进程调 Windows 的剪贴板 API(CF_HDROP)。
    //
    // 插件能做的只有"请主进程把**第 N 个任务**的文件放进去" —— 它递不进路径:
    // 主进程自己去本地队列服务解析路径,并逐条核对(任务存在/已完成/路径在该任务
    // 自己的下载目录里/文件真的在)。详见 electron/bilibili/bilibili-ipc.js。
    if (permissions.includes('clipboard')) {
        ctx.clipboard = {
            /** @param {number|string} taskId 下载队列里的任务 id */
            copyVideo: (taskId) => invoke('clipboard:copyVideo', { taskId }),
        };
    }

    // 「短剧工作台的引擎通道」。
    //
    // 为什么必须有这一层:引擎要用 node:fs(读写 graph.json)、node:child_process
    // (shell 节点与出图后端)、node:crypto(指纹)—— 而插件面板跑在**沙箱**渲染进程里,
    // 那些一个都拿不到。所以引擎住在主进程(见 electron/drama/drama-ipc.js),
    // 这里只递**叶子字段**:项目名、节点 id、提示词。
    //
    // ⚠️ 递不进路径:项目的根由主进程按**当前笔记库**算(<笔记库>/短剧/),
    // 项目名也被它洗成安全目录名。所以这条通道不会变成"往任意目录写文件"。
    if (permissions.includes('drama')) {
        ctx.drama = {
            /** → {root, reason, dir};没配笔记库时 root 为 null、reason 说清原因。 */
            root: () => invoke('drama:root', {}),
            /**
             * → {projects:[名字], items:[{name, nodes, shots, mtime}]}(顺带把根目录建出来)。
             * `projects` 是老的纯名字数组(画布用),`items` 给项目面板——
             * 一行要显示「12 节点 · 3 张图 · 2 天前」,纯名字不够。
             */
            projects: () => invoke('drama:projects', {}),
            /** → {projects, project, graph, types, textImport, version, root} —— 面板一次拿全。
             *  `textImport` = {extensions, maxBytes}:导入要用的常量,**由引擎给**
             *  (能读哪些格式只有引擎的 lib/text.js 知道,插件不另抄一份名单)。 */
            state: (project) => invoke('drama:state', { project }),
            /** 整张图存回去(逐节点改动的落盘点)。 */
            save: (project, graph) => invoke('drama:save', { project, graph }),
            /** 建项目(name 会被主进程洗成安全目录名)。 */
            create: (name) => invoke('drama:create', { name }),
            /**
             * 改项目名。主进程只改目录名与图里的 title,不动图内部的 id
             * (runs 的指纹挂在 id 上);目标已存在、名字里没有可用字符都会被拒。
             */
            rename: (from, to) => invoke('drama:rename', { from, to }),
            /**
             * 删一个项目(整个目录)。走**系统回收站**,可恢复 ——
             * 与笔记删除同一条决策,不是永久删。
             */
            remove: (project) => invoke('drama:remove', { project }),
            /**
             * 跑图。target 省略 = 跑全图;给了节点 id = 跑它和它的上游;
             * force = 忽略指纹缓存。
             * @param {{project:string, target?:string, force?:boolean}} options
             */
            run: (options = {}) => invoke('drama:run', {
                project: options.project,
                target: options.target,
                force: options.force === true,
                runId: options.runId,
            }),
            /** 只接收当前窗口发起的跑图进度，返回取消订阅函数。 */
            onRunEvent: (callback) => bridge.onDramaRunEvent(callback),
            /** 读取本项目里文本生成节点的完整结果。 */
            readOutput: (project, file) => invoke('drama:readOutput', { project, file }),
            /**
             * 把一个文本文件抽成纯文本(**只读**:不往项目里拷任何东西)。
             * 面板把它填进节点的「手输内容」;抽取会带编码嗅探与格式拒绝(见引擎 lib/text.js)。
             * → {name, text, chars, kind, note}
             */
            readText: (options = {}) => invoke('drama:readText', {
                path: options.path,
                name: options.name,
            }),
            /** 取一张出图 → {mime, base64}(渲染进程拿不到 fs,只能这样读图)。 */
            media: (project, file) => invoke('drama:media', { project, file }),
            importImage: (project, file) => invoke('drama:importImage', { project, file }),
        };
    }

    // 「AI 会话」:列会话记录、读一份、删一份、把某一条接回来接着聊。
    //
    // 为什么值得一项能力(而不是让插件自己去读笔记库):"能不能接着聊"要同时看三处 ——
    // 台账(有记录)、这条连接里已经接上的(活跃)、对端 session/list 里的(可恢复),
    // 而这三处只有主进程都摸得到。插件拿到的是**已经判好的行**(state/stateLabel),
    // 判据在 app/lib/agent-sessions.js(纯函数、单测钉着)。
    //
    // ⚠️ `activate` 是这里唯一的**动手**能力:它会把当前会话换成另一条(上下文随之换掉)。
    //    切换会话会改变当前上下文,所以调用方必须把代价写明。
    // ⚠️ 递不进路径:读写哪一份记录由主进程按**当前笔记库**算(<笔记库>/AI会话/),
    //    插件只能递会话 id。
    if (permissions.includes('sessions')) {
        ctx.sessions = {
            /** → {ok, reason, dir, rows:[{id,title,updatedAt,turns,model,effort,state,stateLabel,current}], current, peer} */
            list: () => invoke('sessions:list', {}),
            /** → {ok, record, running} —— `record.entries` 就是回看/铺回对话要的那一份。 */
            read: (id) => invoke('sessions:read', { id: String(id ?? '') }),
            /** 删掉一条记录(用户明确要删才调)。 */
            remove: (id) => invoke('sessions:remove', { id: String(id ?? '') }),
            /** 把某一条接回来接着聊 → {ok, sessionId, reused, reason}。 */
            activate: (id) => invoke('sessions:activate', { id: String(id ?? '') }),
            /**
             * **新建一条会话**(点了立刻建)。
             * 与 activate 正好成对:那个带上下文接回来,这个从零起一条。
             * → {ok, sessionId, previous, reason}
             */
            create: () => invoke('sessions:new', {}),
            /**
             * 订阅"台账/当前会话变了"。只支持 change 这一种事件(与 services.on 同一条口径)。
             * @returns {() => void} 退订
             */
            onChanged(cb) {
                if (typeof cb !== 'function') return () => {};
                return bridge.on('sessions:changed', (payload) => {
                    try { cb(payload ?? {}); } catch (err) { log.warn?.(`[${pluginId}] sessions.onChanged 回调抛错`, err); }
                });
            },
        };
    }

    return ctx;
}
