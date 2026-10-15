import { app, BrowserWindow, shell, ipcMain, dialog, Menu, clipboard, safeStorage } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScheme, registerAppProtocol, PROTOCOL } from './app-protocol.js';
import { createSettingsStore } from './settings-store.js';
import { scanPlugins } from './plugin-scanner.js';
import { createServiceSupervisor } from './service-supervisor.js';
import { createRealDeps } from './service-runner.js';
import { captureLoginCookies, partitionFor } from './cookie-login.js';
import { fetchJsonViaPage } from './browser-fetch.js';
import { validateManifest } from '../app/lib/manifest-schema.js';
import { shouldAutoStart, autoStartKey } from '../app/lib/service-autostart.js';
// 服务根目录 / 设置页那几个键的判据都在 app/lib 里(纯函数,单测钉着):
// 主进程只做"读设置 → 交给判据 → 用它",不在这里重写一遍规则。
import { resolveServiceRoot } from '../app/lib/service-root.js';
import { SETTINGS_KEYS } from '../app/lib/settings-page.js';
import { registerNotesIpc } from './notes/notes-ipc.js';
import { registerCanvasIpc } from './notes/canvas-ipc.js';
// 原生对话框的 filters 要洗一遍再用(渲染进程递进来的形状不可信)。纯函数,单测在 tests/dialog-filters.test.js。
import { sanitizeDialogFilters } from '../app/lib/dialog-filters.js';
import { registerDramaIpc } from './drama/drama-ipc.js';
import { createImageSettings } from './drama/image-settings.js';
import { APINEBULA_IMAGE_SIGNATURE, createApinebulaImageGenerator } from './drama/lib/apinebula-image.js';
import { createDramaTextGenerator } from './drama/lib/text-generator.js';
import { createAgentRuntime } from './agent/agent-runtime.js';
import { registerAgentIpc } from './agent/agent-ipc.js';
import { createSessionLedger } from './sessions/session-ledger.js';
import { registerSessionsIpc, SESSIONS_CHANGED_CHANNEL } from './sessions/sessions-ipc.js';
import { createFetchTransport, createVideoProvider } from './video/dashscope.js';
import { createVideoSettings } from './video/video-settings.js';
import { registerVideoIpc } from './video/video-ipc.js';
import { registerBilibiliIpc } from './bilibili/bilibili-ipc.js';
import { buildMenuTemplate } from './app-menu.js';
import { sanitizePanelMenuReport } from './panel-menu-payload.js';
import { installContextMenu } from './context-menu.js';
import { enableStageLog, stage, stageError, stageLogPath } from './stage-log.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.join(DIR, '..');

// 全局设置(不属于任何插件)用的命名空间。插件 id 有格式约束,不会撞上这个。
const GLOBAL_NS = '__global';

/**
 * 自检专用的**假** DashScope 密钥。
 *
 * 为什么需要它:自检要证的是"拖进视频 → 卡片 → IPC → 主进程"这条接线,而没配密钥时
 * 面板在发请求**之前**就停下了 —— 后半段根本走不到。给一把假的,链路就能整条走通。
 * 它**绝不会**发到网络:自检模式下理解那一条在 provider 之前就被守卫截住
 * (`{ok:false, code:'selftest'}`)。写成一个具名常量而不是散在字符串里,
 * 是为了让 grep "sk-" 的人一眼看出这不是真密钥。
 */
const SELFTEST_VIDEO_KEY = 'sk-selftest-fake-key-not-a-real-credential';

const isSelftest = process.argv.includes('--selftest');

// 自检窗口**故意不抢焦点**(showInactive,见下面 win.showInactive()),于是它经常被用户
// 自己的窗口盖住 —— 而被遮挡的渲染进程会被 Chromium 降频:rAF、CSS 过渡、定时器都被
// 拉长/推迟。自检里大量断言正是"悬停 → 过渡 → 量一个像素/一个 opacity",降频的后果是
// **同一份代码换一组用例变红**,看起来像代码坏了。
//
// 实测(本轮,代码在这些用例相关的路径上完全没动):
//   · 第一次运行:三条"缝里没有亮线"红(那条是真回归,已修);
//   · 第二次运行:红的是「在笔记里打字 → 它看向编辑点」(`gaze:"四处看"`,`looks:"0"`);
//   · 第三次运行:红的是笔记树拖动(`active:false`)+ 三条尺寸角标(`opacity` 停在 0)。
// 三组互不相干、每次换一组 —— 这是环境降频,不是被测代码的性质。把这三个降频开关
// 只挂在自检上,断言才有确定性的含义;正常启动(用户在用开物)一条都不动。
if (isSelftest) {
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
}

// 应用名决定 userData 路径(%APPDATA%\kaiwu),必须在 ready 之前设置
app.setName('kaiwu');

// 自检用**独立的 userData**,不碰用户真实的应用数据。
//
// 为什么必须这么做:自检会把临时笔记库的路径写进设置,而那个临时目录用完就删 ——
// 留在真实设置里就是一个悬空路径,下次正常启动会看到"上次的笔记库找不到了"。
// 自检污染用户数据是不可接受的(实测踩到)。必须在 app.setName 之后立刻设置,
// 一旦有代码读过 userData 路径就晚了。
let selftestUserData = null;
if (isSelftest) {
    // 先扫掉上次自检留下的隔离目录。
    // 为什么不在退出时删:自检进行中 Chromium 一直占着 userData 里的缓存文件,
    // 退出那一刻的删除是尽力而为,常常删不干净(实测每次都留一个)。
    // 改在**下次启动时**扫 —— 那时文件已经不被占用,删得掉,而且能自愈历史残留。
    sweepStaleSelftestUserData();
    selftestUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-selftest-userdata-'));
    app.setPath('userData', selftestUserData);
}

function sweepStaleSelftestUserData() {
    try {
        const tmp = os.tmpdir();
        for (const name of fs.readdirSync(tmp)) {
            if (!name.startsWith('kaiwu-selftest-userdata-') && !name.startsWith('kaiwu-selftest-vault-')) continue;
            try {
                fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
            } catch { /* 还被占用就留给下次 */ }
        }
    } catch { /* 扫不动就算了,不该影响自检 */ }
}

// 启动诊断日志。**始终开启** —— 它只有几十行、开销可忽略,
// 而"卡在启动界面"这类问题没有它就只能靠猜(本项目已为此绕了好几圈)。
// 位置:<userData>/stage-log.txt
const STAGE_LOG = enableStageLog({
    file: path.join(app.getPath('userData'), 'stage-log.txt'),
});
stage(`开始启动(日志:${STAGE_LOG})`);
stage(`userData = ${app.getPath('userData')}`);
stage(`selftest = ${isSelftest}`);

// 启动阶段的未处理拒绝必须**立刻可见并退出**。
// 否则 Electron 会继续跑一个没有初始化完的进程:自检脚本永远等不到 app.exit,
// 只能靠外层 60 秒超时兜底 —— 排查时看到的是"挂住"而不是真实错误,
// 极难定位(本项目为此白费过好几轮)。启动期的错误宁可早死早报。
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    stageError('启动阶段未处理的 Promise 拒绝', reason);
    console.error('[kaiwu] 启动阶段未处理的 Promise 拒绝,进程退出:\n' + msg);
    app.exit(1);
});

// registerSchemesAsPrivileged 必须在 ready 之前调用,否则静默失效
registerScheme();

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 600,
        backgroundColor: '#12100f',
        show: false,
        webPreferences: {
            preload: path.join(DIR, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    });

    // ⚠️ 自检用 **showInactive** + **moveTop**:
    //   - showInactive:窗口要可见(合成 hover / 指针拖动都要它真的被渲染),但**不许抢焦点** ——
    //     自检跑的时候用户可能正在别处打字,而笔记编辑器是"打开即编辑"、光标就在正文里,
    //     一抢焦点就会把用户敲的字吃进自检那个临时笔记库(实测踩到过一次:临时库里的
    //     `# 甲篇` 变成了 `# 甲篇哦`,一条内容断言因此变红,而真凶是自检自己)。
    //   - moveTop:抬到 z 序顶部**但不激活**(SetWindowPos + SWP_NOACTIVATE)。
    //     不加这一句,窗口会被用户当前的窗口遮住 —— Chromium 对遮挡窗口降帧,
    //     而 CSS 过渡是按帧推进的:180ms 的过渡会被拖到秒级,于是"移开后转回原状"
    //     那条断言读到的还是中间值(实测偶发红,`:hover` 已经不再匹配)。
    win.once('ready-to-show', () => {
        if (!isSelftest) { win.show(); return; }
        win.showInactive();
        win.moveTop();
    });

    // 外链一律交给系统浏览器,且只放行 http/https
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
        return { action: 'deny' };
    });

    // 阻止导航离开应用自身
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('toolbox://')) event.preventDefault();
    });

    // 右键菜单。Electron 默认**没有**右键菜单 —— 不挂这一句,"图片无法右键保存"
    // 就是必然的(用户反馈的原话)。规则本身在 context-menu.js 里,可单测。
    installContextMenu(win, { Menu, clipboard, shell, dialog });

    return win;
}

// 两个资源根的绝对路径。扫描插件与协议路由共用同一份定义,
// 避免两处各写一遍导致"协议能读但扫不到"这类不一致。
function pluginRoots() {
    return [
        { id: 'plugin', dir: path.join(APP_ROOT, 'plugins'), urlBase: 'toolbox://plugin/' },
        { id: 'user', dir: path.join(app.getPath('userData'), 'plugins'), urlBase: 'toolbox://user/' },
    ];
}

// ---- 退出清理 ----
// 只停自己拉起的、且 stopOnExit 的服务(接管来的不动)。
// 监听器注册在模块顶层而不是 whenReady 里:窗口还没建起来就退出时,
// 也必须能走到这条清理路径。
let supervisorRef = null;
// AI 面板的 Agent 运行时。与上面同一个理由挂在模块级:退出清理在 whenReady 之外。
// ⚠️ 它**绝不自动 start** —— 拉不拉起 Agent 由界面上的「连接/重试」按钮决定。
let agentRuntimeRef = null;
let dramaTextGeneratorRef = null;
/** 会话台账(退出时要收尾:最后一份记录只有那一次机会落盘)。 */
let sessionLedgerRef = null;
// 扫描到的插件描述符(启动时填)。cookieLogin 的配置要在这里查 ——
// 渲染进程只能递 pluginId,递不进 URL/域名/投递目标。
let scannedPlugins = null;
let shuttingDown = false;

// 退出也要留痕。
// 为什么:应用曾经出现"跑一会儿自己没了",而退出码是 0、日志停在插件加载完成 ——
// 完全看不出是用户关的窗口、还是别的东西把它关了。这几行让下次一眼能分辨。
app.on('before-quit', (event) => {
    stage(`before-quit(shuttingDown=${shuttingDown})`);
    // 没有任何东西要收时就放行;第二次进来也直接放行,否则永远退不出。
    if (shuttingDown || (!supervisorRef && !agentRuntimeRef && !dramaTextGeneratorRef)) return;
    shuttingDown = true;
    event.preventDefault();
    // ⚠️ Agent 清理必须**排在服务清理之前**并一起 await:子进程是 stdio 长连接,
    // 不显式停掉就会变成孤儿留在机器上(而且它还会继续开着会话)。
    // dispose() 幂等,重复调不抛。
    Promise.allSettled([
        agentRuntimeRef?.dispose(),
        dramaTextGeneratorRef?.dispose(),
    ])
        .then((results) => results.forEach((result) => {
            if (result.status === 'rejected') console.error('[agent] 退出清理失败', result.reason);
        }))
        // 台账再冲一次盘:**最后一份记录只在这里有机会落地**。
        // (dispose 里已经冲过一次,那次是"进程没了"这条路的责任;这一层兜的是
        //  "连运行时都没建起来就退出"之类的边角。close 幂等,重复调不抛。)
        .then(() => (sessionLedgerRef ? sessionLedgerRef.close() : undefined))
        .catch(err => console.error('[sessions] 会话记录收尾失败', err))
        .then(() => (supervisorRef ? supervisorRef.shutdownAll() : undefined))
        .catch(err => console.error('[services] 退出清理失败', err))
        .finally(() => app.quit());
});

app.whenReady().then(async () => {
    // 自检的临时笔记库(以及它旁边那个**短剧根**)在这里就建出来。
    // ⚠️ 必须早于 registerDramaIpc:短剧那边要用 dramaRoot 当固定根
    // (自检的项目故意放在库外,免得 graph.json / inputs/*.txt 被笔记索引收进清单)。
    const selftestVault = isSelftest ? createSelftestVault() : null;

    // ---- 应用菜单 ----
    // 不设的话窗口顶部露出来的是 Electron 的原生英文菜单(File/Edit/View/Window)——
    // 模板在 app-menu.js 里,那部分是可单测的纯数据。
    // 开发者项(重新加载/开发者工具)只在 `--dev` 下出现。
    const isDev = process.argv.includes('--dev');

    /**
     * 按渲染层报来的视图表重建应用菜单(「窗口」里那一段 = 程序目前所有的面板)。
     *
     * 为什么是**重建**而不是"用 getMenuItemById 把那几条的勾改掉":
     * 下面第一次建菜单时渲染层还没起来,「窗口」菜单里**一条面板项都还不存在** ——
     * 想只改勾就得先凭空补出那些菜单项、再维护一份 id → MenuItem 的映射,
     * 等于把"菜单长什么样"拆到两处写。整份模板重建只有一个调用点、一份真值(app-menu.js),
     * 代价是几毫秒。
     *
     * ⚠️ 这里引用的 `win` 声明在**下面几行**(`const win = createWindow()`)。这不是 TDZ 缺陷:
     *    这个闭包只在用户真的点了某条**未开着**的面板菜单时才跑,而那时窗口早就建好了;
     *    而第一次建菜单时视图表是空的(app-menu.js 对空表不产出任何菜单项),
     *    连一个会回调的项都没有 —— 所以"在 win 初始化之前拿到它"这条路径根本不存在。
     */
    const rebuildMenu = (views, tools) => {
        Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
            isDev,
            views,
            tools,
            onAddView: (id) => {
                // 窗口可能在菜单被点的同时正在销毁(用户先关窗、菜单还挂着),
                // 往销毁的 webContents 上 send 会抛 —— 这一条只是防呆,不改变语义。
                if (!win.isDestroyed()) win.webContents.send('menu:add-view', id);
            },
        })));
    };

    // 第一次(空视图表)**必须先建**:macOS 的第一项菜单在窗口出现之前就得是对的,
    // 而此刻渲染层还没加载、拿不到任何视图 —— 所以这里只摆一个骨架,
    // 真正的面板表等下面那条 IPC 报上来之后再重建。
    rebuildMenu([], []);

    // 渲染层的**当前视图表**上报(见 app/main.js 的 reportPanels):布局每次变化报一次,
    // 主进程据此重建菜单,于是"已开着的那条打勾且点不动"永远跟界面一致。
    //
    // ⚠️ 这条通道的另一端是页面,报上来的东西**不能直接信**:只取两组菜单真正需要的
    //    叶子字段(id / 标题 / 开着没有 / 当前活动),其余字段一概不进模板、不进菜单对象。
    ipcMain.on('kaiwu:panels:report', (_event, payload = {}) => {
        const { views, tools } = sanitizePanelMenuReport(payload);
        // 去重交给渲染层(它按内容比较过),这里每次收到就重建 ——
        // 主进程再存一份"上一次的表"只是第二处状态,而两边迟早不一致。
        //
        // 留痕:「窗口」菜单里那一小段是**原生菜单**,截不了图、自检也点不着 ——
        // "明明开着却没勾"这类问题只能靠这一行定位(它报的就是菜单最终用的那份判据)。
        stage(`窗口菜单面板表:普通 ${views.length} 项,工具 ${tools.length} 项 · 开着 ${[...views, ...tools].filter((v) => v.open).map((v) => v.id).join(' / ') || '(无)'} · 看得见 ${[...views, ...tools].filter((v) => v.active).map((v) => v.id).join(' / ') || '(无)'}`);
        rebuildMenu(views, tools);
    });

    registerAppProtocol({
        shell: path.join(APP_ROOT, 'app'),
        plugin: path.join(APP_ROOT, 'plugins'),
        user: path.join(app.getPath('userData'), 'plugins'),
    });

    const win = createWindow();

    // ---- 服务托管 ----
    const deps = createRealDeps({ log: console });
    const supervisor = createServiceSupervisor({ ...deps, log: console });
    supervisorRef = supervisor;
    const settings = createSettingsStore({
        filePath: path.join(app.getPath('userData'), 'settings.json'),
    });

    supervisor.onChange((state) => {
        if (!win.isDestroyed()) win.webContents.send('kaiwu:services:changed', state);
    });

    // 服务清单里的 cwd 是**相对服务根目录**的路径。根目录存在全局设置里,
    // 这样搬迁服务只需要改一处,不必动每个插件的 plugin.json。
    //
    // 解析必须发生在主进程:渲染进程只能递进服务 id,递不进路径。
    const DEFAULT_SERVICE_ROOT = 'D:\\project\\personal_web_project';

    /**
     * 服务根目录 = 设置 > 内置默认。
     *
     * ⚠️ 判据本身在 `app/lib/service-root.js`(纯函数,单测钉着):空值、非字符串、
     * **相对路径**一律退回默认 —— 相对路径当根的话,`path.resolve` 会拿进程 cwd 去补,
     * 而 cwd 是用户随时能换的笔记库,同一个设置在不同库里指向不同目录。
     * 设置页改的是同一个键(`__global/serviceRoot`),改完**要重启**才生效(服务在启动
     * 那一刻就按这个根拉起来了):界面上写着这句,日志里也记下这次用的是哪一个来源。
     */
    function serviceRoot() {
        const verdict = resolveServiceRoot({
            configured: settings.get(GLOBAL_NS, SETTINGS_KEYS.serviceRoot),
            fallback: DEFAULT_SERVICE_ROOT,
        });
        if (verdict.reason !== '') log?.warn?.(`[services] ${verdict.reason}`);
        return verdict.root;
    }

    function resolveCwd(spec) {
        return path.resolve(serviceRoot(), spec.cwd ?? '');
    }

    /**
     * 把清单里的 command 解析成绝对路径。
     *
     * ⚠️ 这一步不能省。清单里的 command 是**相对服务根目录**的
     * (例如 `.python-runtime/python.exe`,而 cwd 是 `bilidown`),
     * 但子进程的 `spawn(command, args, { cwd })` 会把**相对命令按 cwd 解析** ——
     * 于是实际去找 `bilidown/.python-runtime/python.exe`,直接 ENOENT。
     * 实测确认过这个行为,不是推测。
     *
     * 裸命令名(如 `node`)不带路径分隔符,交给 PATH 解析,原样返回。
     */
    function resolveCommand(spec) {
        const cmd = String(spec.command ?? '');
        if (cmd === '') return cmd;
        const looksLikePath = /[\\/]/.test(cmd) || /^[a-zA-Z]:/.test(cmd);
        if (!looksLikePath) return cmd;
        return path.isAbsolute(cmd) ? cmd : path.resolve(serviceRoot(), cmd);
    }

    // 扫描 + 把清单声明的服务登记进托管器。
    // 抽成函数是因为它有两个调用方:渲染进程的 IPC,以及下面启动时的
    // autoStart 决策 —— 后者必须先有已登记的服务才能判断要不要启动。
    async function scanAndDefine() {
        const list = await scanPlugins({ roots: pluginRoots() });
        // 服务只能从清单登记 —— 命令 / 参数 / 工作目录全部来自这里,
        // 渲染进程递不进任何命令行。这是权限模型里唯一靠得住的那条保证。
        for (const plugin of list) {
            for (const svc of plugin.contributions.services) supervisor.define(svc);
        }
        // 记住扫描结果:cookieLogin 的配置要在这里查(见下面的 IPC)。
        // 只留描述符,不留任何用户数据。
        scannedPlugins = list;
        return list;
    }

    ipcMain.handle('kaiwu:plugins:scan', () => scanAndDefine());

    // 清单里声明 autoStart 的服务随应用启动(三个内置服务都声明了)。
    // 用户的覆盖值存在设置里(键名 service.<id>.autoStart),优先级高于清单。
    // 决策本身在 app/lib/service-autostart.js —— 状态条的勾选框读的是同一个函数,
    // 否则会出现"服务真的起来了、勾选框却是空的"这种界面在撒谎的情况。
    async function startAutoStartServices() {
        const wanted = supervisor.list().flatMap((svc) => {
            const spec = supervisor.spec(svc.id);
            const override = settings.get(svc.pluginId, autoStartKey(svc.id));
            return shouldAutoStart(spec, override) && spec ? [spec] : [];
        });
        if (wanted.length === 0) return;

        // **并行**拉起,不是一个个 await。
        // 串行时总耗时是各服务之和(B站代理要 2.7 秒、抖音 0.6 秒),
        // 而它们之间没有任何依赖 —— 并行后总耗时是最慢的那个。
        // 用 allSettled:一个服务起不来不能连累其它服务。
        const results = await Promise.allSettled(wanted.map(spec =>
            supervisor.start(spec.id, { cwd: resolveCwd(spec), command: resolveCommand(spec) })));
        results.forEach((res, i) => {
            if (res.status === 'rejected') {
                console.error(`[services] ${wanted[i].id} 自动启动失败`, res.reason);
            }
        });
    }

    // 单文件形态:清单写在模块内部,主进程静态读不到,只能由渲染进程 import 后回传。
    // 这里用**同一份** manifest-schema 校验,校验强度与文件夹形态完全一致。
    ipcMain.handle('kaiwu:plugins:registerManifest', (_event, { manifest } = {}) => {
        const { ok, errors, value } = validateManifest(manifest, { sourceLabel: '单文件插件' });
        if (!ok) return { ok: false, errors, descriptor: null };

        // 单文件形态不允许声明服务:它的清单无法在扫描阶段被主进程校验,
        // 若允许声明就等于开了一条"渲染进程递进命令行"的通道(设计文档 §6.2)。
        if (value.contributes.services.length > 0) {
            return {
                ok: false,
                errors: [{
                    field: 'contributes.services',
                    message: '单文件插件不能声明服务,请改用文件夹形态',
                }],
                descriptor: null,
            };
        }
        return { ok: true, errors: [], descriptor: value };
    });

    // 读接口额外带上**生效的** autoStart。
    // 为什么不在托管器的运行态里存这个字段:autoStart 是清单 + 设置的属性,
    // 不是运行态 —— 托管器要保持"只认状态、不碰设置"。所以在读的这一层补,
    // 状态条据此初始化那个勾选框,不必自己去设置里查第二遍。
    ipcMain.handle('kaiwu:services:list', () => supervisor.list().map(svc => ({
        ...svc,
        autoStart: shouldAutoStart(
            supervisor.spec(svc.id),
            settings.get(svc.pluginId, autoStartKey(svc.id)),
        ),
    })));
    // 启动前把 cwd 与 command 都解析成绝对路径再交给托管器。
    // **两者都要**:cwd 相对服务根目录,command 也相对服务根目录,而子进程的
    // spawn 会把相对命令按 cwd 解析 —— 不解析 command 就会 ENOENT(实测确认)。
    // 托管器本身不碰设置,保持"依赖全注入、可脱离 Electron 单测"的性质。
    ipcMain.handle('kaiwu:services:start', (_event, { id } = {}) => {
        const spec = supervisor.spec(id);
        return supervisor.start(id, spec
            ? { cwd: resolveCwd(spec), command: resolveCommand(spec) }
            : undefined);
    });
    ipcMain.handle('kaiwu:services:stop', (_event, { id } = {}) => supervisor.stop(id));
    ipcMain.handle('kaiwu:services:logs', (_event, { id } = {}) => supervisor.logs(id));

    // ---- 「用自带浏览器取数据」 ----
    // 接口被风控守着、签名只能由页面自己的 JS 算的站点(抖音)走这条路:
    // 打开页面 → 抓页面**自己**那个请求的响应 → 交给插件。
    //
    // 边界:网址必须命中该插件清单里声明的 allow 前缀,抓哪个请求由 capture 决定;
    // 用的还是 cookieLogin 那个持久分区(所以先登录过才有意义)。
    ipcMain.handle('kaiwu:browser:fetchJson', async (_event, { pluginId, url } = {}) => {
        if (isSelftest) return { ok: false, error: '自检模式不打开浏览器窗口(会打网络)' };
        const descriptor = (scannedPlugins ?? []).find(p => p.id === pluginId);
        const config = descriptor?.contributions?.browserFetch;
        if (!config) {
            return { ok: false, error: `插件 ${pluginId} 没有声明 contributes.browserFetch` };
        }
        if (typeof url !== 'string' || url === '') {
            return { ok: false, error: 'url 必填' };
        }
        const allowed = (config.allow ?? []).some(prefix => url.startsWith(prefix));
        if (!allowed) {
            return {
                ok: false,
                error: `这个网址不在 ${pluginId} 声明的 allow 列表里(清单里只允许:${(config.allow ?? []).join(' / ')})`,
            };
        }
        const domain = descriptor?.contributions?.cookieLogin?.cookieDomain;
        try {
            const result = await fetchJsonViaPage({
                url,
                capture: config.capture,
                partition: partitionFor(domain),
                log: console,
            });
            stage(`[browser] ${pluginId} 抓 ${url} → ok=${result.ok}`
                + `${result.ok ? ` bytes=${result.bytes}` : ` error=${result.error}`}`);
            return result;
        } catch (err) {
            console.error('[browser] 取数据失败', err);
            return { ok: false, error: String(err?.message ?? err) };
        }
    });

    // ---- 「登录一次,自动记住 Cookie」 ----
    //
    // 为什么需要它:抖音的详情接口被风控挡着,而 uifid / msToken 是页面 JS 在
    // 客户端算出来的,纯 HTTP 拿不到;实测只有**登录态**那一整套才过得去。
    // 这里用开物自己的 Chromium 开一个持久分区的登录窗,用户扫码一次就够。
    //
    // 安全边界(这是这条能力不会变成"任意站点 Cookie 外发"的原因):
    //   * 登录页 / Cookie 域 / 投递目标**全部来自插件清单**,渲染进程只递一个
    //     pluginId,递不进任何 URL;
    //   * 投递目标只能是**该插件自己声明的服务**,端口另外从服务清单里查 ——
    //     连端口都不是渲染进程说了算;
    //   * Cookie 值**不经过渲染进程**:主进程直接 POST 给本地服务。
    ipcMain.handle('kaiwu:cookies:login', async (_event, { pluginId, force = false } = {}) => {
        // 自检里不真的开窗:那会等用户、还会打网络,自检必须是确定性的。
        // 仍然返回一个结构化结果,好让自检能断言"这个频道确实接线了"。
        if (isSelftest) {
            return { ok: false, error: '自检模式不打开登录窗(会等用户 + 打网络)' };
        }
        const descriptor = (scannedPlugins ?? []).find(p => p.id === pluginId);
        const config = descriptor?.contributions?.cookieLogin;
        if (!config) {
            return { ok: false, error: `插件 ${pluginId} 没有声明 contributes.cookieLogin` };
        }
        const spec = supervisor.spec(config.target.service);
        if (!spec) {
            return { ok: false, error: `找不到服务 ${config.target.service}(清单里的 target.service 写错了?)` };
        }

        try {
            const result = await captureLoginCookies({
                loginUrl: config.loginUrl,
                cookieDomain: config.cookieDomain,
                title: config.title,
                parent: win.isDestroyed() ? null : win,
                log: console,
                force,
            });
            const summary = result.summary;
            if (!summary.hasSessionid) {
                return {
                    ok: false,
                    opened: result.opened,
                    reused: result.reused,
                    reason: result.reason,
                    summary,
                    error: '没拿到登录态(sessionid)。在登录窗里完成扫码登录再试一次。',
                };
            }

            // 交给服务:写文件 + 立即生效(服务侧 /douyin/cookie 已经实现了热加载)
            const url = `http://127.0.0.1:${spec.port}${config.target.path}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookie: result.cookie }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.code !== 0)) {
                return {
                    ok: false,
                    summary,
                    error: `服务拒绝了 Cookie(${res.status}):${json?.message ?? ''}`,
                };
            }
            stage(`[cookies] 已把 ${config.cookieDomain} 的 Cookie 交给 ${config.target.service}`
                + `(长度 ${summary.length},sessionid=${summary.hasSessionid},uifid=${summary.hasUifid})`);
            return { ok: true, summary, opened: result.opened, reused: result.reused, reason: result.reason };
        } catch (err) {
            console.error('[cookies] 登录取 Cookie 失败', err);
            return { ok: false, error: String(err?.message ?? err) };
        }
    });

    ipcMain.handle('kaiwu:log', (_event, { pluginId, level, message } = {}) => {
        const sink = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
        console[sink](`[${pluginId}] ${message}`);
    });

    // 启动阶段诊断日志:渲染进程报来的阶段直接追加进日志文件。
    // 同步追加是刻意的 —— 崩溃/卡死时最后几行才是关键,不能缓冲。
    ipcMain.handle('kaiwu:stage', (_event, { message } = {}) => {
        stage(`[渲染] ${message}`);
    });

    ipcMain.handle('kaiwu:settings:get', (_event, { pluginId, key } = {}) =>
        settings.get(pluginId, key));
    ipcMain.handle('kaiwu:settings:set', (_event, { pluginId, key, value } = {}) => {
        settings.set(pluginId, key, value);
    });

    ipcMain.handle('kaiwu:dialog:openFile', async (_event, options = {}) => {
        // ⚠️ 自检模式**不弹原生模态对话框**:那是自检点不动的东西(挂在那儿等用户,
        //    整个自检就超时了)。改成把"用户选文件"这一步守卫掉、直接回夹具里那个文本文件 ——
        //    于是"点 ＋ → 主进程抽文本 → 灌进框"这条链在自检里是真跑完的。
        //    与「自检模式不打开浏览器窗口 / 不真写剪贴板」同一个套路:守卫放在主进程。
        if (isSelftest) {
            return selftestVault?.textFixture !== undefined ? [selftestVault.textFixture] : [];
        }
        // filters 是渲染进程递进来的:洗一遍再用(形状不对就丢,别塞给 Electron 让它抛)
        const filters = sanitizeDialogFilters(options.filters);
        const result = await dialog.showOpenDialog(win, {
            properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
            ...(filters.length > 0 ? { filters } : {}),
        });
        return result.canceled ? [] : result.filePaths;
    });

    // 选**目录**。与 openFile 分开而不是加一个参数:两者的返回值形状不同
    // (一个数组可能多选,一个只有一个),而且调用方的意图也完全不同 ——
    // "选一个文件夹当数据根"与"选几个文件来导入"不该共用一条通道。
    // createDirectory 让用户能在对话框里直接新建一个(数据根常常还不存在)。
    ipcMain.handle('kaiwu:dialog:openDirectory', async (_event, options = {}) => {
        const result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    ipcMain.handle('kaiwu:shell:openExternal', (_event, { url } = {}) => {
        // 渲染进程侧已经挡了一道,这里是主进程侧的第二道(设计文档 §3.4)
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
        shell.openExternal(url);
        return true;
    });

    // ---- 笔记子系统 ----
    // 路径与鉴权都在主进程:渲染进程只能递**相对 Vault 的相对路径**,
    // 绝对路径由主进程解析 —— 从结构上就没有"递一个绝对路径写到系统目录"这条路。
    //
    // ⚠️ 必须在 loadURL **之前**注册:外壳脚本一跑起来就查 notes:vault:status,
    // 晚一步注册就会拿到 "No handler registered" 而白等一次(实测踩到)。
    const notesIpc = registerNotesIpc({
        ipcMain,
        dialog,
        settings,
        // 非笔记文件(图片 / docx / json)在树里点一下要"用系统程序打开" —— 所以要 shell。
        // 渲染进程仍然只递相对路径,由这一侧过路径守卫再交给 shell。
        shell,
        getWindow: () => (win.isDestroyed() ? null : win),
    });

    registerCanvasIpc({ ipcMain, vaultRoot: () => notesIpc.currentVault() });

    // ---- 短剧工作台(引擎跑在主进程里) ----
    //
    // 与 Agent 那条同一个理由:项目的根是 **<当前笔记库>/短剧**,而笔记库用户
    // 随时能换。这里递的是 notes-ipc 里那条已经校验过(存在、是目录、realpath)的
    // 同一个值 —— 不信任渲染进程递进来的路径,也不自己再解析一遍。
    const configuredDshHome = () => {
        const v = settings.get(GLOBAL_NS, SETTINGS_KEYS.dshHome);
        return typeof v === 'string' ? v : '';
    };
    const dramaTextGenerator = createDramaTextGenerator({
        createRuntime: () => createAgentRuntime({
            vaultRoot: () => notesIpc.currentVault(),
            env: { ...process.env, APPDATA: app.getPath('appData') },
            appRoot: APP_ROOT,
            configuredDshHome,
            log: console,
        }),
    });
    dramaTextGeneratorRef = dramaTextGenerator;
    const imageSettings = createImageSettings({ settings, safeStorage });
    const generateImage = createApinebulaImageGenerator({ resolveKey: () => imageSettings.resolveKey() });
    const dramaIpc = registerDramaIpc({
        ipcMain,
        getVaultPath: () => notesIpc.currentVault(),
        // 自检把项目放在库外(见 createSelftestVault 的注释):这里给它固定根。
        // 生产一律走上面的 getVaultPath,没有这个口子。
        rootOverride: selftestVault?.dramaRoot ?? null,
        // 删项目要进**系统回收站** —— 与 notes-ipc 用同一个 shell、同一个理由:
        // 用户点错了还能捞回来,而不是永久删掉一个可能跑了几十张图的项目。
        shell,
        generateText: dramaTextGenerator,
        generateImage,
        imageSignature: APINEBULA_IMAGE_SIGNATURE,
        imageSettings,
    });

    // ---- AI 面板(Agent over ACP) ----
    //
    // Agent 的 cwd 是**当前 Vault**,而 Vault 用户随时能换 —— 所以这里递的是
    // 一个**函数**(每次 start 才取当时的值),不是一个字符串。取的是 notes-ipc
    // 里那条已经校验过(存在、是目录、realpath)的同一个值:两处各自解析迟早会
    // 分叉出"笔记在 A 库、Agent 在 B 库"。
    //
    // ⚠️ 这里**不自动 start**。握手是终端用户按「连接」才发生的事:
    // 自动拉起会让每次开应用都多一个外部进程(自检模式尤其不该)。
    // APPDATA 显式取自 app.getPath('appData'),不用环境里的那份:
    // resolveKaiwuDshHome 要算的就是 kaiwu 自己的家,而 appData 才是权威。
    //
    // ---- 「AI 会话」台账 ----
    //
    // 会话记录写在**笔记库**里(<笔记库>/AI会话/*.md):
    //   · 跟着库一起备份/同步/进版本控制(与短剧那些数据同一条路);
    //   · 用 .md 是为了它在笔记应用里天生能被搜到 —— "我上次问过什么"能搜出来。
    // ⚠️ 台账在这里**只造一个实例**,同时交给运行时(记)与 sessions-ipc(读/列/删):
    //    造两个就会出现"记在一个对象里、读在另一个对象里"这种只在半路才发现的错位。
    const sessionLedger = createSessionLedger({
        vaultRoot: () => notesIpc.currentVault(),
        log: console,
        // 落盘之后通知界面刷新清单(一轮聊完,那一行要排到最前面)。
        onWrite: () => {
            if (!win.isDestroyed()) {
                try { win.webContents.send(SESSIONS_CHANGED_CHANNEL, { kind: 'written' }); } catch { /* 窗口正在走 */ }
            }
        },
    });
    sessionLedgerRef = sessionLedger;

    const agentRuntime = createAgentRuntime({
        vaultRoot: () => notesIpc.currentVault(),
        env: { ...process.env, APPDATA: app.getPath('appData') },
        appRoot: APP_ROOT,
        // 设置页里配的 DSH_HOME(**函数**,不是快照):用户改完重启,这一次启动读到新值;
        // 空串 = 没配 → 走 resolveKaiwuDshHome 的探测(显式 env > %APPDATA%\kaiwu\dsh-home)。
        configuredDshHome,
        ledger: sessionLedger,
        log: console,
    });
    agentRuntimeRef = agentRuntime;
    registerAgentIpc({
        ipcMain,
        getWindow: () => (win.isDestroyed() ? null : win),
        runtime: agentRuntime,
        log: console,
    });
    registerSessionsIpc({
        ipcMain,
        getWindow: () => (win.isDestroyed() ? null : win),
        ledger: sessionLedger,
        runtime: agentRuntime,
        log: console,
    });
    // 会话变了(建了新会话 / 接回旧会话 / 换了配置)→ 清单也跟着变。
    agentRuntime.onEvent((event) => {
        if (event?.kind !== 'session' && event?.kind !== 'config') return;
        if (win.isDestroyed()) return;
        try { win.webContents.send(SESSIONS_CHANGED_CHANNEL, { kind: event.kind }); } catch { /* 窗口正在走 */ }
    });

    // ---- 视频理解(DashScope 本地视频直传) ----
    //
    // 与 Agent 是**两条独立的路**:理解一段视频不需要 ACP 连接、不需要 Vault,也不需要
    // 本机有任何解码器 —— 本机 ffmpeg 被系统策略拦着,所以整段视频直接 POST 给服务端,
    // 抽帧由服务端做(这是本功能的架构前提,见 app/lib/agent-video.js 顶部)。
    //
    // 密钥只在这一层解析,并且**只有 provider 拿得到值**:IPC 的返回里、日志里、
    // 界面状态里都只有 { ok, source, reason } 三个叶子字段。
    // safeStorage 可用时存的是密文,不可用就退回明文(取舍写在 video-settings.js 里)。
    const videoSettings = createVideoSettings({
        settings,
        // ⚠️ 自检模式给一把**假的**密钥:自检要能在真实应用里走完"拖入草稿 → 点发送 →
        // IPC → provider"整条接线,而没配密钥时面板会在发请求之前就停下(那证明不了
        // 后面那半段)。这把假密钥**永远不会到达网络** —— 理解那一条被下面的守卫挡在
        // provider 之前(见 provider 包装)。它也不落盘(只是内存里的一份 env),
        // 自检一结束就没了。
        env: isSelftest ? { ...process.env, DASHSCOPE_API_KEY: SELFTEST_VIDEO_KEY } : process.env,
        safeStorage,
        log: console,
    });
    const videoProvider = createVideoProvider({
        transport: createFetchTransport({ log: console }),
        resolveKey: () => videoSettings.resolveSecret(),
        config: () => videoSettings.config(),
        log: console,
    });
    registerVideoIpc({
        ipcMain,
        videoSettings,
        log: console,
        // 自检模式**绝不**发真实请求(那会打网络、还会花钱)。这里挡住的是理解这一条;
        // status / key / model 那几个频道是纯本地读写,照常工作(自检要能断言它们接线了)。
        provider: {
            understand: async (input) => (isSelftest
                ? { ok: false, code: 'selftest', reason: '自检模式不发真实请求(会打网络)', status: null }
                : videoProvider.understand(input)),
            // 按**本地路径**那条入口同样要在自检里挡住:它会真的读盘 + 上传 + 打网络
            // (169.5 MB 实测要 71 秒、花几分钱)。判据照走,只是不真发。
            understandFromPath: async (input) => (isSelftest
                ? { ok: false, code: 'selftest', reason: '自检模式不发真实请求(会打网络)', status: null }
                : videoProvider.understandFromPath(input)),
        },
    });

    // ---- 「复制视频」:把下载好的文件放进系统剪贴板 ----
    //
    // 为什么必须回主进程:网页 API 放不进"文件"(navigator.clipboard 只能写文本/图片),
    // 而"粘到资源管理器/微信/剪映里直接出现文件"要的是剪贴板的 CF_HDROP。
    // 路径由主进程自己去本地队列服务解析并逐条核对,渲染进程只递一个 taskId。
    //
    // ⚠️ 自检模式 **enabled:false** —— 剪贴板是**用户的全局资源**,自检绝不能覆盖它
    // (用户刚复制的一段文字/一张图会当场没了)。自检只把链路走完,不真去写。
    //
    // 代理地址与插件读的是**同一个**设置(默认 3302):两处各写一份,迟早出现
    // "界面在看 A、复制却去问 B"。给函数是为了每次现取(设置可能在运行中变)。
    registerBilibiliIpc({
        ipcMain,
        enabled: !isSelftest,
        resolveBaseUrl: () => settings.get('bilibili', 'apiBase'),
        log: console,
    });

    // 先把插件扫一遍、把清单声明的服务登记好,再让渲染进程加载外壳。
    //
    // 为什么必须排在 loadURL 之前:状态条在脚本一跑起来就查 kaiwu:services:list,
    // 如果那时服务还没登记,它会拿到空列表并从此不再重查(服务变更事件只推
    // 状态变化,不推"新登记")—— 表现为状态条上一条服务都看不到。
    await scanAndDefine();
    // 服务随应用启动,但**不阻塞**窗口加载。
    // 阻塞的话,B站代理要 2.7 秒、某个服务起不来还要等满 30 秒超时 ——
    // 那段时间窗口是一片空白,像是应用没启动。改成后台并行拉起:
    // 外壳先显示出来,状态条订阅了服务变更事件,会自己从"启动中"走到"运行中"。
    //
    // 自检**不**拉起服务:那会真的 spawn 三个外部程序(B站那个还会起一个托盘
    // 程序),让自检变慢、依赖机器上有没有这些服务,而且跑完可能留下残留进程。
    // 自检断言的是"决策对不对"(清单声明 + 自检模式下不被拉起),不是"能不能起"。
    // 必须挂 .catch:main.js 装了 unhandledRejection → app.exit(1),
    // 一个没接住的拒绝会直接把应用打死。
    if (!isSelftest) startAutoStartServices().catch(err => console.error('[services] 自动启动失败', err));

    // 自检模式:先造一个临时笔记库,再带着它加载页面。
    // 页面必须**在加载时**就知道用哪个库(?testVault=):渲染进程拿不到桥,
    // 没法在启动后自己切 —— 这是内核刻意做的隔离带来的副作用,用启动参数绕开。
    // (selftestVault 已在 whenReady 顶部建好:registerDramaIpc 要用它的 dramaRoot。)
    const shellUrl = selftestVault
        ? `${PROTOCOL}://shell/index.html?testVault=${encodeURIComponent(selftestVault.dir)}`
        : `${PROTOCOL}://shell/index.html`;

    // 自检的**队列固定装置**。必须在 loadURL **之前**备好:插件面板在 setup 时就会
    // 读设置里的 apiBase 并取一次队列,晚一步它拿到的就是默认的 3302(而自检不拉服务)。
    const queueFixture = isSelftest ? await startQueueFixture(settings) : null;
    await win.loadURL(shellUrl);

    if (isSelftest) {
        const { runSelftest } = await import('./selftest.js');
        await runSelftest({
            app, win, supervisor, settings,
            vault: selftestVault,
            // 交给自检断言清单里的 cookieLogin 配置(登录页/域名/投递目标)
            plugins: scannedPlugins,
            // 交给自检清理:app.exit() 不会触发 quit 事件,放在 quit 钩子里会漏。
            cleanupUserData: selftestUserData,
            // 交给自检"真的存一次密钥"用:自检要能在真窗口里把那把**假**密钥敲进去,
            // 再断言落盘的是密文。定义只留在上面那一处(具名常量),不在这里抄字面量。
            videoKeyForSelftest: SELFTEST_VIDEO_KEY,
            // 队列固定装置:自检要读它的**请求计数**来证明"空闲不轮询"(比读界面文案硬)
            queueFixture,
        });
    }
});

/**
 * 自检专用的下载队列固定装置:一个**只回答 `/bilibili/tasks`** 的本地 HTTP 服务。
 *
 * 为什么非要它:队列那几条断言(队列出现 / 空闲不轮询 / 复制按钮走通道)必须**确定性** ——
 * 不能依赖"用户机器上那个 3302 服务此刻在不在"(他可能没开应用,而自检本身刻意不拉服务)。
 * 所以这里造一条完成任务,并把插件的 `apiBase` 设置指过来;面板照常走它自己那条
 * fetch → IPC → 主进程 的链路,只是对端换成了这个装置。
 *
 * ⚠️ 它只在 --selftest 下存在;夹具文件建在自检那个**临时** userData 里,随它一起被删。
 * 装置同时记账请求次数 —— 那是"空闲时一个请求都没再发"的**直接证据**。
 */
/**
 * 自检专用的下载队列固定装置:一个**只回答 `/bilibili/tasks`** 的本地 HTTP 服务。
 *
 * 为什么非要它:队列那几条断言(队列出现 / 空闲不轮询 / 复制按钮走通道)必须**确定性** ——
 * 不能依赖"用户机器上那个 3302 服务此刻在不在"(他可能没开应用,而自检本身刻意不拉服务)。
 * 所以这里造一条任务,并把插件的 `apiBase` 设置指过来;面板照常走它自己那条
 * fetch → IPC → 主进程 的链路,只是对端换成了这个装置。
 *
 * ⚠️ 它只在 --selftest 下存在;夹具文件建在自检那个**临时** userData 里,随它一起被删。
 * 装置同时记账请求次数 —— 那是"空闲时一个请求都没再发"的**直接证据**。
 *
 * ⚠️ 状态是**可改的**(`setState`):用户报的那条 bug 是"上游给 `running`,而界面把它当
 * 静止 → 停止轮询 → 永远停在第一帧"。所以在真窗口里复现它需要**真的演一遍**
 * `running → done`:先断言 running 时有中文胶囊/live/进度,再翻成 done,断言界面
 * **自己**刷新过去 —— 只断言"能画出来"是证不到那个 bug 的。
 *
 * 进度值照**实测**的语义写(0–1 的比例,见 app/lib/bilibili-queue.js 里那段采样说明):
 * audio=1 / video=0.42 / merge=0 → 三段等权平均 47%,阶段是"视频"。
 */
async function startQueueFixture(settings) {
    const dir = path.join(app.getPath('userData'), 'queue-fixture');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'fixture-video.mp4');
    fs.writeFileSync(file, Buffer.from('KAIWU-SELFTEST-FIXTURE-NOT-A-REAL-VIDEO'));
    const size = fs.statSync(file).size;

    const fixture = { requests: 0, dir, file, base: '', server: null };
    // 一开始就是**进行中**:自检第一步就要断言 running 被当成活跃(那正是 bug 的根因)。
    let state = { status: 'running', videoProgress: 0.42, audioProgress: 1, mergeProgress: 0 };
    fixture.setState = (patch) => { state = { ...state, ...patch }; };
    fixture.getState = () => ({ ...state });
    // 解析那条路的冷却状态(默认不冷却)。自检可以当场翻成"正在冷却",用来验
    // "面板一挂载就看得出在暂停中 + 输入区锁着" —— 那份状态真机上住在代理进程里,
    // 而自检刻意不拉真服务,所以由装置代答(形状与 web_api.py 的 /bilibili/parse-state 一致)。
    let parseCooling = 0;
    fixture.setParseCooling = (remainingS) => { parseCooling = Math.max(0, Number(remainingS) || 0); };

    /** 每次请求**现算**一遍:状态改了之后下一次取就该看到新值。 */
    const buildPayload = () => {
        // 终态之外一律算活跃 —— 与 app/lib/bilibili-queue.js 的 TERMINAL_STATUSES 同一条判据。
        const active = ['done', 'error', 'pause'].includes(state.status) !== true;
        return {
            code: 0,
            message: 'ok',
            data: {
                tasks: [{
                    id: 7777,
                    bvid: 'BV1Selftest01',
                    title: '自检夹具 [高清 1080P]',
                    owner: '自检',
                    cover: '',
                    duration: 61,
                    status: state.status,
                    format: 80,
                    formatLabel: '高清 1080P',
                    folder: dir,
                    fileName: path.basename(file),
                    filePath: file,
                    fileSize: size,
                    fileMtime: 0,
                    fileCandidates: 1,
                    fileAmbiguous: false,
                    fileReason: '',
                    // 上游**从来没有** progress / speed 这两个字段(实测 11 帧全是 null),
                    // 夹具里也照实留空,免得自检测的是一个真实世界不存在的形状。
                    progress: 0,
                    speed: '',
                    videoProgress: state.videoProgress,
                    audioProgress: state.audioProgress,
                    mergeProgress: state.mergeProgress,
                    createAt: '2026-01-01T00:00:00Z',
                    createAtMs: 1767225600000,
                    error: '',
                }],
                total: 1,
                activeCount: active ? 1 : 0,
                hasActive: active,
                folders: [dir],
                polledAt: 0,
            },
        };
    };

    const server = http.createServer((req, res) => {
        fixture.requests += 1;
        const url = typeof req.url === 'string' ? req.url : '';
        const json = (body) => {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                // 面板是从 toolbox:// 页面发起的请求 —— 不给 CORS 头浏览器会拦掉
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(body));
        };
        // 解析冷却那一条:插件挂载时会问一次(它**不碰上游**,所以自检里可以随便答)
        if (url.startsWith('/bilibili/parse-state')) {
            json({
                code: 0,
                message: 'ok',
                data: {
                    cooling: parseCooling > 0,
                    cooldownRemainingS: parseCooling,
                    failStreak: 0,
                    failStreakToCooldown: 3,
                    cooldownSeconds: 120,
                    attemptTimes: 2,
                    retryDelays: [3.5],
                    upstreamCalls: 0,
                    messageText: parseCooling > 0
                        ? 'B 站风控了**当前登录会话**(HTTP 412):已暂停请求,'
                            + '2:00 后自动恢复。有效的做法只有一个:到 Bilidown 界面**重新扫码登录**。'
                        : '',
                },
            });
            return;
        }
        if (url.startsWith('/bilibili/tasks')) {
            json(buildPayload());
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"code":1,"message":"fixture only serves /bilibili/tasks and /bilibili/parse-state"}');
    });

    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    fixture.server = server;
    fixture.base = `http://127.0.0.1:${server.address().port}`;
    // 插件读这个设置(没有就用默认的 3302)
    settings.set('bilibili', 'apiBase', fixture.base);
    stage(`[selftest] 队列固定装置已就绪:${fixture.base}(夹具文件 ${file})`);
    return fixture;
}

// 自检用的临时笔记库:三篇笔记,含互相链接、未解析链接、孤儿,以及标签。
// 用完由 selftest 删除。
function createSelftestVault() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-selftest-vault-'));
    const put = (rel, text) => {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text, 'utf8');
    };
    put('甲篇.md', '---\ntags: [自检]\n---\n# 甲篇\n\n见 [[乙篇]] 与 [[还没写]]。\n\n#自检\n');
    put('乙篇.md', '# 乙篇\n\n回见 [[甲篇]]。\n');
    put('孤岛.md', '# 孤岛\n\n没人链接我。\n');

    // Ctrl+A「全选整篇」的夹具:刻意**正好 3 块**(标题 / 空行 / 一段正文),
    // 因为那一条要验的是"Ctrl+A 之后退格把**整篇**清空,而不是只清掉当前那一块"
    // —— 块数必须一眼数得清。末尾不留换行:留了就会多出一个空块(4 块)。
    // ⚠️ 自检只在自己的临时库里动它(现建现删),与用户真实的笔记库无关。
    put('全选篇.md', '# 全选篇\n\n开篇一句');

    // 纯文本夹具:自检要验"程序能显示并编辑 txt,而且**和 Markdown 隔开**"。
    // 内容刻意写成"如果被当成 Markdown 就会变形"的样子:
    //   · `# 这不是标题` —— Markdown 会渲染成 <h1>,纯文本必须原样;
    //   · `[[甲篇]]` 与 `#标签` —— 不许变成 wiki 链接、不许进标签面板;
    //   · `<img onerror=…>` —— 必须被转义(注入防线在纯文本这条路上同样成立)。
    put('纯文本.txt', [
        '# 这不是标题',
        '见 [[甲篇]] 与 #标签',
        '<img src=x onerror="alert(1)">',
        '最后一行',
    ].join('\n'));

    // 「打不开」的夹具:一篇**含非法字节**的 .md(字节直接写,不经过字符串)。
    //
    // 它守的是一个会**悄悄毁掉用户笔记**的缺陷:从前的 .md 走 `readFile(abs,'utf8')`,
    // Node 会把非法字节**有损替换**成 U+FFFD,而保存时又按 UTF-8 编回去 ——
    // 打开一次 + 保存一次,用户的原文就被永久改写成一堆 U+FFFD(真库里已经有一篇这样了)。
    // 自检要在**真窗口**里验三件事:
    //   ① 列表里它是"一眼看出打不开"的一行;
    //   ② 点开它 → 状态行给出一句人话原因(而不是打开一屏乱码);
    //   ③ 整轮自检跑完之后,它的**磁盘字节逐字节未变**。
    //
    // ⚠️ 名字用 `龙`(U+9F99)开头是**有意的**:笔记列表按码位排序
    //    (`listVaultTree` 里 `files.sort()`),这一篇必须排在
    //    乙 / 全选 / 孤岛 / 甲 之后 —— 自检里有几条断言取"列表里第一个 .md"
    //    (面板标签那一组),让它排到最前面会把那些断言带红,而它们与本次改动无关。
    // ⚠️ 0xFF / 0x80 既不是合法 UTF-8,也不是任何 GB18030 序列(实测两者 fatal 解码都失败),
    //    所以它落到的正是"解不开 → 拒绝打开"那一条路上。
    fs.writeFileSync(path.join(dir, '龙篇.md'), Buffer.concat([
        Buffer.from('# 龙篇\n\n这篇的字节是坏的(别的程序写进来的)。\n', 'utf8'),
        Buffer.from([0xff, 0x80]),
        Buffer.from('\n尾巴\n', 'utf8'),
    ]));

    // 短剧项目:自检要验"画布真的把节点画出来了、点运行真的跑了图"。
    //
    // ⚠️ 它**故意放在笔记库之外**(同级目录),而不是 <库>/短剧/:放进去的话
    // `graph.json` 与 `inputs/*.txt` 会被笔记索引当**笔记**收进清单
    // (实测笔记数从 3 变成 7),把一堆与它无关的断言带红。
    // 生产上项目**就是**放在库里的(那是决策),这里只是自检需要干净的夹具。
    // 通过 registerDramaIpc 的 rootOverride 指过来,顺便也把"根是可注入的"这件事验到。
    const dramaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-selftest-drama-'));
    // 「＋ 导入」的自检夹具:自检模式里 kaiwu:dialog:openFile 会直接回这个文件
    // (原生模态对话框自检点不了)。内容故意用中文 + srt 格式:顺带验编码嗅探那条路。
    const textFixture = path.join(dramaRoot, '自检导入.srt');
    fs.writeFileSync(textFixture,
        '1\n00:00:01,000 --> 00:00:02,000\n导入夹具的一行台词\n', 'utf8');
    const putDrama = (rel, text) => {
        const abs = path.join(dramaRoot, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text, 'utf8');
    };
    // ⚠️ 只放**无副作用**的节点类型(text / template / note)—— shell 会真跑命令,
    // image 会打真实**付费**出图接口。自检绝不能碰那两类。
    putDrama('自检项目/graph.json', JSON.stringify({
        version: 1, id: 'z', title: '自检项目',
        nodes: [
            { id: 'a', type: 'text', title: '稿子', x: 40, y: 40, params: { value: '第一幕' } },
            { id: 'b', type: 'template', title: '拼装', x: 300, y: 40, params: { template: '<<{{input}}>>' } },
            { id: 'c', type: 'note', title: '备注', x: 40, y: 200, params: { value: '备注' } },
        ],
        edges: [{ from: 'a', to: 'b' }],
        runs: {},
    }, null, 2));

    // 拖动夹具:两个目录 + 一个文件。自检要验"把文件拖进文件夹"这条路,
    // 拖完会**移回原位**(后面的用例还要用,不能被自检改坏)。
    // ⚠️ 它们会出现在笔记树里(目录 + 一个 .txt),所以那两条"数笔记 / 找新建文件夹"
    //    的断言必须排除非笔记行 —— 已经改成精确选择器了,别改回去。
    fs.mkdirSync(path.join(dir, '夹具起点'), { recursive: true });
    fs.mkdirSync(path.join(dir, '夹具终点'), { recursive: true });
    put('夹具起点/待搬.txt', 'drag fixture');

    return {
        dir,
        dramaRoot,
        textFixture,
        dispose: () => {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(dramaRoot, { recursive: true, force: true });
        },
    };
}

app.on('window-all-closed', () => {
    stage('所有窗口已关闭 → 退出(用户关窗或窗口被销毁)');
    if (process.platform !== 'darwin') app.quit();
});
