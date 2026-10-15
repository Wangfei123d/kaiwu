// Agent 的**组合点**:把 M3-A 的三块(监护人 / ACP 客户端 / 凭证判定)与 kaiwu 的
// 运行环境(agent-env 的 read-only + cwd=当前 Vault)接成主进程要用的那一个对象。
//
// 为什么单独一个文件:监护人与客户端各自只答"我这一层对不对",而
// 「Agent 崩了界面还在转圈」「没配钥匙被渲染成已连接然后莫名失败」「取消之后对端
// 的响应把状态搅乱」这些故障**只发生在接缝上**。接缝的责任在这里,所以这里也是
// 唯一需要同时看到 spawnChild / failPending / prompt 超时的地方。
//
// 依赖全部可注入(spawnChild / createSupervisor / createClient / timers),
// 所以 `node --test` 能直接跑它,不必启动 Electron。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { createAgentSpawn, resolveKaiwuDshHome } from '../../app/lib/agent-env.js';
import { METHODS } from '../../app/lib/acp-protocol.js';
import { agentCommandFailureReason, resolveAgentCommand } from '../../app/lib/agent-command.js';
import {
    admitImagePayload, imagePromptFailureHint, imageCapabilityRefusal, promptCapabilitiesOf,
} from '../../app/lib/agent-image.js';
import {
    REASONING_CONFIG_ID, MODEL_CONFIG_ID, configOptionOf, currentModelEntry, effortLevels,
    effortValueOf, preferredEffortValue, shortEffortName,
} from '../../app/lib/agent-config.js';
import { resumeFailureOf } from '../../app/lib/agent-sessions.js';
import { nullLedger } from '../sessions/session-ledger.js';
import { createAgentSupervisor } from './agent-supervisor.js';
import { createAcpClient } from './acp-client.js';
import { detectCredentials, isMissingCredentialError } from './credentials.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 一轮里**两次增量之间**允许的最长间隔(空闲超时)。**180s** —— 这个数是被工具撑大的,
 * 不是拍脑袋:生图(`generate_image`)一次 10–60 秒是常态,20 秒会把这一轮直接判超时,
 * 而且超时会**顺手发一条 session/cancel**,把正在进行的生成打断(图上就白花了)。
 * 代价是"真挂住的一轮"要等更久才收场 —— 有「停止」按钮兜底,这个方向更划算。
 *
 * ⚠️ 它量的是**间隔**,不是整轮的墙钟时间 —— 这一点是实测踩出来的
 *    (2026-09-27 22:21 那条会话):那一轮从用户发出到被判超时一共跑了 188534ms,
 *    期间 11 段思考、10 段回复、17 个工具条目一路在出,定时器却在 `pwsh` 正跑着的
 *    时候到点,把这一轮连同那个工具一起取消,界面上还写着"180000ms 没有响应" ——
 *    对端其实一直在响应。整轮的墙钟上限见 DEFAULT_PROMPT_MAX_MS。
 */
export const DEFAULT_PROMPT_TIMEOUT_MS = 180000;
/**
 * 一轮的**总时长**上限。**30 分钟**,与空闲超时同一条收场路(发 session/cancel + 当场失败),
 * 只是文案不同。
 *
 * 为什么非要有它:空闲超时改成"看有没有增量"之后,**一直有增量的一轮**在理论上永不收场
 * (真陷进死循环的 agent 也会持续出字),总得有个兜底,否则用户只能自己发现并去按停止。
 * 为什么是 30 分钟:这台机器上真实的长活是"翻一份被污染的笔记 + 反复跑 pwsh 实验",
 * 十几分钟量级;30 分钟足够放过它,又不会让一轮僵死太久。
 */
export const DEFAULT_PROMPT_MAX_MS = 1800000;
/**
 * 握手超时默认值。**35s** —— 这个数是按**实测**定的,不是拍脑袋:
 *   · 这台机器上真 dsh 的冷启动实测 3.5–3.9 秒(连着 5 次启动都是这个量级);
 *   · 但机器忙 / 子进程自己 boot 卡住时,20 秒**不够**:实测两次判死分别用了
 *     21.2s 与 20.6s —— 也就是说它当时正处在"差一点就起来"的位置,而 20s 直接把它判死了;
 *   · 代价很小:失败时**已经会把子进程最后输出一起打出来**(见 agent-supervisor 的
 *     withSubprocessTail),所以"晚 15 秒才失败"不会更难查,只是晚 15 秒;
 *   · 这 35 秒里界面上有可读信号:输入卡片那一行会亮出「正在连接 Agent…」与「停止进程」
 *     (见 app/agent/panel.js 的 renderStatus),读屏那边也有 `Agent:连接中…`。
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 35000;
/** 权限请求的等待上限。到点按"拒绝"收场 —— 但**必须回一个合法响应**,否则对端一直等。 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120000;

/** 离开 ready 的理由文案(每条路一条,便于日志里分辨)。 */
const LEFT_READY = Object.freeze({
    crashed: 'Agent 进程崩溃了',
    failed: 'Agent 启动失败',
    stopping: 'Agent 正在停止',
    stopped: 'Agent 已经停止(用户在提示进行中按了停止)',
});
/** 这四条就是"离开 ready"的全部路(硬要求 3)。 */
const LEFT_READY_STATES = ['crashed', 'failed', 'stopping', 'stopped'];

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function trimmed(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(err) {
    return String(err?.message ?? err ?? '未知错误');
}

/**
 * 只摘出契约里的叶子字段 —— 权限卡片用的那三样。
 * 对端可能在 toolCall 上挂任意结构,原样递给渲染进程既没必要也不安全。
 */
function pickToolCall(raw) {
    const t = (raw !== null && typeof raw === 'object') ? raw : {};
    return {
        toolCallId: trimmed(t.toolCallId),
        title: trimmed(t.title),
        kind: trimmed(t.kind),
    };
}

/**
 * 从一条 ACP 增量里判"工具是起来了还是结束了"。只认契约里那三个叶子字段,
 * 别的类型一律返回 null(不猜、不把别的增量当工具)。
 *
 * 为什么要它:一轮里最长的静默往往就发生在**工具内部**(跑测试、生图、一条大命令),
 * 那不是"对端没响应",而是对端正忙着 —— 空闲超时要据此放行(见 send 里的 toolsInFlight)。
 *
 * @returns {{id:string, done:boolean}|null}
 */
function toolProgressOf(update) {
    const u = (update !== null && typeof update === 'object') ? update : {};
    const kind = trimmed(u.sessionUpdate);
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return null;
    const id = trimmed(u.toolCallId);
    if (id === '') return null;
    const status = trimmed(u.status);
    return { id, done: status === 'completed' || status === 'failed' || status === 'cancelled' };
}

/** 选项同样只留叶子字段。optionId 是**回传对端**的那一个,不能丢。 */
function pickOptions(raw) {
    return asArray(raw)
        .map((o) => {
            const opt = (o !== null && typeof o === 'object') ? o : {};
            return {
                optionId: trimmed(opt.optionId),
                name: trimmed(opt.name),
                kind: trimmed(opt.kind),
                // 提问的选项带一句"取舍说明" —— 它是桥给的非标准字段(ACP 的选项没有
                // 这一栏),界面画成选项下面那行小字。授权请求没这个字段,补空串。
                description: trimmed(opt.description),
            };
        })
        .filter((o) => o.optionId !== '');
}

/**
 * @param {object} deps
 * @param {(() => string|null)|string} deps.vaultRoot **函数或字符串**。
 *   函数时**每次 start 都重新取**:用户能换库,模块加载时定死就会让 Agent
 *   一直工作在上一个库上(能力边界的读那一半)。
 * @param {object} [deps.env] 解析命令 / DSH_HOME / 凭证用的环境
 * @param {string} [deps.appRoot] 应用根目录(启动器候选之一)
 * @param {(p:string)=>boolean} [deps.exists] 路径存在性(注入后命令解析可单测)
 * @param {string} [deps.fixturePath] 假 agent 脚本(自检用;优先级见 resolveAgentCommand)
 * @param {() => import('node:child_process').ChildProcess} [deps.spawnChild] 注入点
 * @param {object} [deps.spawnOptions] 透传给 createAgentSpawn(测试可注入假 spawn)
 */
export function createAgentRuntime({
    vaultRoot,
    env,
    appRoot,
    // 设置页里配的 DSH_HOME(空串 = 没配,按 kaiwu 自己的规则探测)。
    // ⚠️ 必须是**函数**:用户能在设置页改它,而 runtime 是启动时就建好的 ——
    // 模块加载时读一次会把"改完重启才生效"变成"改完永远不生效"。
    configuredDshHome = () => '',
    // ⚠️ 真实文件系统那一下**必须**由这里注入给纯模块:agent-command.js 自己
    // 绝不摸 fs(它要能在 node --test 里被构造出来测)。缺了它 resolveAgentCommand
    // 会当场抛"需要 exists" —— 那是**接线错误**,不该等到用户点「连接」才炸。
    exists = (p) => { try { return existsSync(p); } catch { return false; } },
    fixturePath,
    spawnChild,
    spawnOptions = {},
    log = console,
    promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
    promptMaxMs = DEFAULT_PROMPT_MAX_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS,
    maxRestarts,
    baseDelayMs,
    readyStabilityMs,
    logRingSize,
    timers = { setTimeout, clearTimeout },
    launcherPath = path.join(HERE, 'dsh-launcher.mjs'),
    createSupervisor = createAgentSupervisor,
    createClient = createAcpClient,
    detectCredentialsFn = detectCredentials,
    readFile = (p) => readFileSync(p, 'utf8'),
    ledger = null,
} = {}) {
    const listeners = new Set();
    /** 一次运行(= 一个监护人 + 一个客户端 + 一个会话)。dispose 后为 null。 */
    let controller = null;
    /**
     * 这个 controller 是**用哪个 Vault** 建的。
     *
     * ⚠️ 必须记下来:`createAgentSpawn` 把 cwd/env 在**创建那一刻**冻结,而
     * controller 只在 dispose 时置空 —— 于是"start → stop → 用户换库 → start"
     * 会复用同一个 controller,子进程的 cwd 仍是旧库,而 `session/new` 的 cwd
     * 每次现取,同一次连接里两个 cwd 不一致(Agent 在新库的界面下读旧库的文件)。
     */
    let controllerVault = null;
    /** 正在进行的收尾(dispose/换库/stop 共用)。见 tearDownNow。 */
    let inFlightTeardown = null;
    let inFlightStart = null;
    let sessionId = null;
    let inFlightSession = null;
    /**
     * **当前会话的世代**:每作废一次(离开 ready / 换库 / 换会话)就 +1。
     *
     * 为什么需要它:`session/new` 那一趟是**真等网络**的,期间进程可能崩、用户可能按
     * 「停止」、用户也可能换了库。建会话的异步段醒来时必须能判出"这条会话属于一个已经
     * 不存在的进程" —— 判不出就会把 id 写进 `sessionId`,于是**会话活过进程**
     * (下一条提示拿它去 prompt,对端只会说"会话不存在",而且再也建不出新会话)。
     * 只比 `controller` 不够:崩溃重启**是同一个 controller**(监护人在内部换进程)。
     */
    let sessionEpoch = 0;
    /**
     * **台账推迟**:启动时自动建的那条会话,落盘要等到用户真的说了第一句话。
     *
     * 为什么:会话一建就落盘,「每次打开程序自动建一条」就会变成**每次启动多一个
     * 0 轮的空记录** —— 用户翻「AI 会话」清单时会看到一串自己没聊过的空壳。
     * 会话本身(对端 + 内存里的 sessionId/configOptions)照旧**立刻**存在,
     * 所以胶囊一进来就能用;只有"这条会话留下来什么"这件事推迟到有内容为止。
     *
     * 形状 `{ id, cwd, createdAt }`;null = 没有待写的。任何"当前会话被换掉/作废"
     * 的路都要把它清掉(见 forgetSession / beginNewSession / activateSession),
     * 否则它会在一个已经不属于任何人的 id 上停着。
     */
    let recordPending = null;
    /** 自动建会话那一次的在飞 promise(见 autoCreateSession;非 null = 已经有一次在飞)。 */
    let autoSessionInFlight = null;
    /**
     * 对端在 `initialize` 里**广告的能力**(至少 `promptCapabilities`)。
     *
     * 为什么非要记住它:图片是"内联图片块",而 ACP 的规定是**只有对方广告了才准发**。
     * 装机那份 acp profile 钉的模型是 `deepseek-v4-flash`,它在 dsh-llm-deepseek 的
     * 目录里没有声明 `inputModalities:['text','image']` —— 于是桥在 initialize 时
     * 广告 `image:false`(实测),带图的提示会被它当场以 -32602 拒掉,用户看到的是
     * 一句英文 + IPC 包装。把广告值记在这里,就能在**发之前**拦住,并把原因说成人话。
     * 连接生命周期内这个值不变(桥在 initialize 那一刻定下 imagePromptEnabled)。
     */
    let caps = null;
    /** 这次会话的 configOptions(model / reasoning 之类),只为了在拒绝图片时说出模型名。 */
    let sessionConfigOptions = [];
    /**
     * 这条连接里**已经接上过**的会话 id。
     *
     * 为什么非得自己记着:对端的 `session/list` **不列正在活跃的会话**(实测),
     * 而"已经接上"的那些在对端那边是活跃的 —— 不记的话,刚接上的那条会从清单里
     * 凭空消失,而且再点它一次还会被 resume 以"is already active"拒掉。
     * 记着它,切回已经接上过的会话就只是**本地换一个 id**,不必再问对端。
     */
    let activatedSessions = new Set();
    /**
     * 对端上一次报的会话清单(`session/list` 的结果)。
     * `ask` 为 false = 还没问到过 —— 界面据此说"不知道",而不是"没有"。
     */
    let peerSessions = { ask: false, cwd: null, ids: new Set(), reason: '' };
    /** 台账:会话记录(见 electron/sessions/session-ledger.js)。可由外部注入(测试/单例)。 */
    const recorder = ledger ?? nullLedger;
    let busy = false;
    let currentTurn = null;
    let disposed = false;
    /**
     * 挂起的权限请求:**按 controller 记账**,不是模块级。
     *
     * 模块级的话,两个 runtime(测试里常见、将来多窗口也可能)会共用一张表:
     * 一个 runtime 离开 ready 就把另一个的挂起请求一起丢掉,而"这个请求属于
     * 哪个进程"恰恰是这里唯一要判的事。
     */
    const permissionsOf = (c) => c.pendingPermissions;
    const nextPermissionId = (c) => String(++c.permissionSeq);

    function emit(event) {
        for (const fn of listeners) {
            try { fn(event); } catch (err) { log.warn?.('[agent] 事件监听器抛错', err); }
        }
    }

    function emitState(status) {
        emit({ kind: 'state', status });
    }

    /** 当前 Vault:函数就每次取(用户能换库),字符串就直接用。 */
    function currentVaultRoot() {
        const raw = typeof vaultRoot === 'function' ? vaultRoot() : vaultRoot;
        const s = typeof raw === 'string' ? raw.trim() : '';
        return s === '' ? null : s;
    }

    /** 当前模型在清单上显示的名字(台账里记的就是它)。 */
    function modelLabelOf(options = sessionConfigOptions) {
        const option = configOptionOf(options, MODEL_CONFIG_ID);
        if (option === null) return '';
        return currentModelEntry(option, option.currentValue)?.name ?? '';
    }

    /** 当前思考强度的短名(关/低/中/高)。 */
    function effortLabelOf(options = sessionConfigOptions) {
        const value = effortValueOf(options);
        if (value === null) return '';
        return shortEffortName(value, configOptionOf(options, REASONING_CONFIG_ID)?.name ?? '');
    }

    /**
     * 开始记这条会话(幂等:同一 id 再来一次只是补一下模型/强度)。
     *
     * ⚠️ 为什么"开工时"就要记:这一轮里对端可能中途崩掉、用户可能直接关窗口 ——
     *    只在收尾时记,那些轮次就一个字都不会留下(实测 dsh 自己那份会话文件正是这样:
     *    12 个会话全是空壳,只剩一行头)。
     */
    async function recordBegin(id, cwd, createdAt) {
        try {
            await recorder.begin({
                id, cwd, createdAt,
                model: modelLabelOf(), modelValue: configOptionOf(sessionConfigOptions, MODEL_CONFIG_ID)?.currentValue ?? '',
                effort: effortLabelOf(), effortValue: effortValueOf(sessionConfigOptions) ?? '',
            });
        } catch (err) {
            log.warn?.('[agent] 会话记录开不了头(不影响这一轮)', err);
        }
    }

    /** kaiwu 自己的 DSH_HOME —— **唯一**解析点,spawn 与凭证检测共用这一个值。
     *  ⚠️ 设置页配的那个值排在最前(见 resolveKaiwuDshHome 的优先级):用户在界面上
     *  显式指定了一个家,就该用它 —— 而且必须与凭证检测读到的是**同一个字符串**。 */
    function dshHome() {
        return resolveKaiwuDshHome({
            env: env ?? process.env,
            configured: typeof configuredDshHome === 'function' ? configuredDshHome() : '',
        });
    }

    function agentStatus() {
        const base = controller === null
            ? { state: 'stopped', pid: null, restarts: 0, since: null, error: null }
            : controller.supervisor.status();
        return { ...base, sessionId, busy };
    }

    /**
     * 离开 ready 时把所有在飞请求结掉。
     *
     * ⚠️ 这是硬要求 3:**每一条**离开 ready 的路都要走这里(crashed / failed /
     * stopping / stop())。少一条的表现都一样 —— Agent 崩了而 `prompt()` 永远不
     * resolve,界面上就是一个永不停止的转圈。failPending 自身幂等,重复调不抛。
     */
    function failInFlight(reason) {
        if (controller === null) return;
        controller.client.failPending(reason);
    }

    /**
     * 离开 ready 的**唯一**收尾点:`failPending` + 丢掉挂起的权限请求 + **作废会话**。
     *
     * ⚠️ 会话是**进程的**属性,不是这个模块的:ACP 的 sessionId 随子进程一起消失。
     * 只在 dispose() 里清 sessionId 会留下一个活过进程的陈旧 id,而 ensureSession()
     * 见它非空就直接复用 —— 于是"崩溃 → 退避重启 → 又 ready"之后,下一条提示会拿
     * 旧会话 id 去 prompt,真 dsh 回"会话不存在"一类错误,而**此后再也建不出新会话**:
     * 不是那一条提示失败,是界面永久坏掉,直到重启应用。stop() 之后再 start() 同理。
     * (夹具对任意 sessionId 都照收,所以只有专门钉这条接缝的用例才看得见它。)
     *
     * ⚠️ 权限请求也必须在这里**丢掉**(见 dropPendingPermissions):留下它的定时器,
     * 到点就会拿旧 jsonrpc id 往**当前** transport(重启后的新进程)发一个响应。
     *
     * ⚠️ `emit:false` 只给 `stop()` 用:那个调用点必须先结在飞请求(要用 controller)、
     * 之后才收 controller,而 `agentStatus()` 是按 controller 算状态的 —— 它那一刻
     * 还在报"ready"。推出去就是一条**假的状态事件**(见 stop() 里的说明)。
     *
     * 收尾顺序的考量:currentTurn / busy 属于"正在进行的那一轮提示",而 send() 的
     * finally 也管它们。这里先清是因为 status() 必须**当场**说实话(界面靠它把
     * "会话已经没了"画出来),而 send() 的 finally 已经改成"只有还是自己那一轮才
     * 归位" —— 所以谁先谁后都不会把状态带坏。cancel() 在这之后会回 {cancelled:false},
     * 那是对的:进程都没了,没有什么可取消的。
     */
    function leaveReady(reason, { emit = true } = {}) {
        failInFlight(reason);
        dropPendingPermissions();
        forgetSession();
        currentTurn = null;
        busy = false;
        if (emit === true) emitState(agentStatus());
    }

    /**
     * 丢掉**所有**挂起的权限请求(连同定时器),一个响应都不发。
     *
     * 这与"用户点了一个选项"和"权限等待超时"那两条路**不同**:那两条有人在等,
     * 必须恰好回一个响应;而这里请求方那个进程已经没了(崩溃/停止/dispose),
     * 没有任何人在等这个响应。反而"回一个响应"才是危险的动作 ——
     * acp-client 是拿**原消息的 jsonrpc id** 回响应的,而响应走**当前** transport,
     * 它在监护人重启之后指向**新进程**;对端每进程 id 从头编号(本项目夹具就是
     * 常量 900001),于是新进程发的另一个权限请求会**同一个 id 收到两个响应**,
     * 第二个还是 cancelled —— 用户根本没拒绝,却被对端当成拒绝了。
     *
     * (这条**改写了 M3-A 留下的契约**:旧契约是"dispose 时按拒绝收场,别让对端
     * 一直等"。改的理由就是上面那条跨 attempt 的重号。)
     *
     * @returns {number} 被丢掉的条数(便于日志与断言)
     */
    function dropPendingPermissions() {
        if (controller === null) return 0;
        return dropPermissionsOf(controller);
    }

    /** 丢掉**某一个 controller** 的挂起权限请求(换库时收掉旧 controller 也要用)。 */
    function dropPermissionsOf(c) {
        const table = permissionsOf(c);
        const count = table.size;
        for (const entry of table.values()) {
            // 先清定时器再删表:定时器回调里还会去查表,留着它就有"到点再发一次"的窗口。
            if (entry.timer !== null) timers.clearTimeout?.(entry.timer);
            entry.timer = null;
            entry.resolved = true;
        }
        table.clear();
        return count;
    }

    /** 会话没了(进程走掉/被停掉)。`status()` 里的 sessionId 必须立刻变 null。 */
    function forgetSession() {
        // ⚠️ 进程一走,对端那边的会话**全没了**:已接上的那些 id 不再活跃,
        //    而"已经问过清单"这件事也作废(下次问的是新进程的清单)。
        //    不在这里清,界面会拿旧的"正在聊/可接着聊"标记骗人。
        const last = sessionId;
        sessionId = null;
        // 世代 +1:在飞的 `session/new` 醒来时会据此判定"这条会话已经不属于任何进程"。
        sessionEpoch += 1;
        // 待写的台账也跟着作废:它属于这个刚没了的会话,没法再等到"第一条消息"了
        // (重启之后会按新会话重新排一份,见 autoCreateSession)。
        recordPending = null;
        sessionConfigOptions = [];
        activatedSessions = new Set();
        peerSessions = { ask: false, cwd: null, ids: new Set(), reason: '' };
        // 最后一份记录要落地:进程没了之后内存里那份就再也没人写(见 recordBegin 的说明)。
        if (last !== null) void recorder.flush?.(last);
    }

    /** 这次会话钉的模型 id(configOptions 里 `model` 那一项的 currentValue);拿不到就空串。 */
    function modelConfigValue() {
        const hit = sessionConfigOptions.find((o) => o?.id === 'model');
        return typeof hit?.currentValue === 'string' ? hit.currentValue : '';
    }

    /**
     * 权限请求的收尾:对端**必须恰好**收到一个响应。
     * 所以"用户点了"与"超时按拒绝"两条路都从这里出去,而且是 resolve 一个结果,
     * 由 acp-client 负责把它变成 JSON-RPC 响应(它保证只发一次)。
     */
    function settlePermission(requestId, result) {
        const c = controller;
        if (c === null) return false;
        const table = permissionsOf(c);
        const entry = table.get(requestId);
        if (entry === undefined || entry.resolved) return false;
        entry.resolved = true;
        table.delete(requestId);
        if (entry.timer !== null) timers.clearTimeout?.(entry.timer);
        entry.settle(result);
        return true;
    }

    function handlePermissionRequest(msg) {
        const c = controller;
        // 没有 controller(function 已被收掉)时也要回一个**合法拒绝**:
        // 这条消息是当前 transport 上真的到达的请求,不响应它才是"对端一直等"。
        if (c === null) return Promise.resolve({ outcome: { outcome: 'cancelled' } });

        const requestId = nextPermissionId(c);
        const params = (msg?.params !== null && typeof msg.params === 'object') ? msg.params : {};
        const toolCall = pickToolCall(params.toolCall);
        const options = pickOptions(params.options);

        const result = new Promise((resolve) => {
            const entry = { settle: resolve, timer: null, resolved: false };
            entry.timer = timers.setTimeout(() => {
                // 超时按"拒绝"收场。**必须**回一个合法响应:没有响应,对端会一直等,
                // 而它等的那一轮提示会把整个会话卡死。
                // ⚠️ 但只有在"这个请求还属于当前 controller"时才发 —— 离开 ready
                // 时表已经清空且定时器已被清掉,这里的兜底再多判一次身份,免得
                // 注入的假定时器/已经在队列里的回调把僵尸响应递出去。
                if (!permissionsOf(c).has(requestId)) return;
                log.warn?.(`[agent] 权限请求 ${requestId} 等待超过 ${permissionTimeoutMs}ms,按拒绝收场`);
                entry.timer = null;
                settlePermission(requestId, { outcome: { outcome: 'cancelled' } });
            }, permissionTimeoutMs);
            permissionsOf(c).set(requestId, entry);
        });

        emit({
            kind: 'permission',
            requestId,
            sessionId: trimmed(params.sessionId) || sessionId,
            toolCall,
            options,
            // 提问与授权走的是**同一个** ACP 方法(session/request_permission ——
            // ACP 没有"问用户"这一条),靠 kind 区分。界面据此画"提问卡"而不是"授权卡";
            // 回答两条路共用,所以"恰好回答一次"的保证也是同一套。
            question: toolCall.kind === 'question',
        });
        return result;
    }

    function buildController() {
        const root = currentVaultRoot();
        if (root === null) {
            throw new Error('还没有选择笔记库(Vault),Agent 不知道该在哪个目录下工作');
        }
        const e = env ?? process.env;
        // `fixturePath` 是自检那条路的**说明性**入参:夹具脚本真正的来源是
        // `KAIWU_AGENT_SCRIPT`(见 agent-command 的优先级),所以这里不参与解析 ——
        // 留着它只是让调用点能一眼看出"这个 runtime 是给谁用的"。
        void fixturePath;
        const resolved = resolveAgentCommand({ env: e, exists, appRoot, launcherPath });
        if (resolved === null) {
            throw new Error(agentCommandFailureReason({ env: e, exists, appRoot })
                ?? '找不到可以运行的 Agent 命令');
        }
        const home = dshHome();

        // 监护人要先造(客户端要用它的 transport),而监护人的握手又要用客户端 ——
        // 所以客户端在**第一次真的需要它**时建(握手回调是第一个碰它的地方)。
        // 这样两者就是同一个对象,也不会留下一个挂在假 transport 上的客户端。
        let client = null;
        const makeClient = () => {
            if (client === null) client = createClient({ transport: supervisor.transport, log });
            return client;
        };

        const supervisor = createSupervisor({
            // ⚠️ 唯一允许的起进程方式。cwd = **当前 Vault**,env(read-only + DSH_HOME)
            // 由 createAgentSpawn 烤进去。别处再拼一次 spawn/env 就等于把能力边界
            // 悄悄重新打开(app/lib/agent-env.js 顶部的注释说的就是这件事)。
            spawnChild: spawnChild ?? createAgentSpawn({
                command: resolved.command,
                args: resolved.args,
                dshHome: home,
                cwd: root,
                base: e,
                ...spawnOptions,
            }),
            handshake: async () => {
                const result = await makeClient().initialize({ name: 'kaiwu', version: '0.1.0' });
                caps = promptCapabilitiesOf(result);
                // 立刻把新能力报给界面:重连之后它会拿这份新值替换旧值 ——
                // 否则界面会继续按"旧的"那条连接拦用户(实测:换成视觉模型、重连成功,
                // 界面还在显示"当前模型不接受图片输入")。
                emit({ kind: 'caps', caps });
                return result;
            },
            handshakeTimeoutMs,
            log,
            ...(maxRestarts === undefined ? {} : { maxRestarts }),
            ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
            ...(readyStabilityMs === undefined ? {} : { readyStabilityMs }),
            ...(logRingSize === undefined ? {} : { logRingSize }),
        });

        const offState = supervisor.onStateChange((snap) => {
            emitState(supervisor.status());
            // 硬要求 3:每一条离开 ready 的路都结掉在飞请求,**并作废会话**
            // (会话随进程一起消失,见 leaveReady)。
            if (LEFT_READY_STATES.includes(snap.state)) leaveReady(LEFT_READY[snap.state]);
            // 握手成功 → 没有会话就自动建一条,胶囊立刻可用(见 autoCreateSession)。
            // ⚠️ 放在 leaveReady **之后**:崩溃重启这条路也走这里,而那一刻 sessionId
            //    已经被作废,于是这一次 ready 会为新进程重新建一条(不会复用死进程的会话)。
            if (snap.state === 'ready') autoCreateSession();
        });
        const offRequest = makeClient().onRequest({
            // canHandle 收到的是**方法名字符串**(实测确认)
            canHandle: (method) => method === METHODS.REQUEST_PERMISSION,
            handle: (msg) => handlePermissionRequest(msg),
        });

        return {
            supervisor,
            client: makeClient(),
            offState,
            offRequest,
            // 权限请求挂在这里(而不是模块级):它天然属于"这一个进程"。
            pendingPermissions: new Map(),   // requestId -> { settle, timer, resolved }
            permissionSeq: 0,
        };
    }

    /**
     * 把一个 controller **彻底**收掉:摘监听器 → 释放客户端 → 停进程(顺序固定)。
     *
     * 为什么单独一个函数:dispose 与"换库时顶掉旧 controller"是**同一件事**。
     * 两边各写一遍,迟早有一边漏掉某一步(漏摘监听器的后果是旧进程的事件打到新面板上)。
     *
     * 先摘监听器再停:监听器摘掉之后,`stop()` 引发的 stopping/stopped 状态转换
     * 不会再走 leaveReady —— 这正是我们要的:收尾(清权限、作废会话)按**新** controller
     * 的世界来一遍就够了。
     */
    async function teardownController(c) {
        if (c === null) return;
        // 收掉这个 controller 时,它挂着的权限请求一律丢弃(一个响应都不发)。
        // 理由与 leaveReady 里那一段相同:请求方那个进程就是它自己。
        try { dropPermissionsOf(c); } catch (err) { log.warn?.('[agent] 丢弃挂起权限请求失败', err); }
        try { c.client.failPending('Agent 运行时已释放(dispose)'); } catch (err) { log.warn?.('[agent] 结掉在飞请求失败', err); }
        try { c.offState(); c.offRequest(); } catch (err) { log.warn?.('[agent] 摘监听器失败', err); }
        try { c.client.dispose(); } catch (err) { log.warn?.('[agent] 释放客户端失败', err); }
        try { await c.supervisor.stop(); } catch (err) { log.warn?.('[agent] 停止 Agent 失败', err); }
    }

    /**
     * 取当前该用的 controller,**按当前 Vault 校验**;不一致就换(见下)。
     *
     * ⚠️ 这个函数现在可能返回 promise,调用方**一律 await**(`const c = await ensureController()`),
     * 所以"同步快路径"只保证 *controller 是同步建好的*,**不保证进程已经 spawn** ——
     * `await` 会把非 thenable 值也推迟一个微任务,`c.supervisor.start()` 因此在
     * `start()` 的同步段之后才跑(实测:调用 `runtime.start()` 后同步读 spawns.length = 0,
     * `await tick()` 之后 = 1)。这条可观测语义**已经变窄**,用例也相应改成 await 之后再读;
     * 别再按"调完 start() 那一刻进程已经起来了"写注释或用例。
     *
     * 真的换库时才走异步:必须**等旧进程停干净**再建新的,绝不许两个 controller
     * 同时活着(那样就有一个监护人都停不掉的活进程,旧客户端的反向请求通道也还开着)。
     * 那个 await 是 cwd 修复的一部分,不能为了同步 spawn 把它去掉。
     */
    function ensureController() {
        if (disposed) throw new Error('Agent 运行时已经释放(dispose)');
        const root = currentVaultRoot();
        if (controller === null && inFlightTeardown === null) {
            controller = buildController();
            controllerVault = root;
            return controller;
        }
        if (controller !== null && controllerVault === root) return controller;
        return supersedeController(root);
    }

    /**
     * 异步收掉旧的、再按 `root` 建新的。调用方 await 到的那个 promise
     * 落定时,`controller` 一定已经是新 controller。
     */
    async function supersedeController(root) {
        // 上一轮换库/停止的收尾还没走完:等它 —— 同时活着两个 controller
        // 就有一个监护人都停不掉的活进程,而且旧客户端的反向请求通道还开着。
        if (inFlightTeardown !== null) await inFlightTeardown;
        if (disposed) throw new Error('Agent 运行时已经释放(dispose)');
        const old = controller;
        controller = null;
        controllerVault = null;
        if (old !== null) {
            // 会话跟着旧进程一起消失(与 leaveReady 同一条路):换库之后那个
            // sessionId 属于上一个进程,复用它去 prompt 会被对端当成"会话不存在"。
            forgetSession();
            await tearDownNow(old);
        }
        if (disposed) throw new Error('Agent 运行时已经释放(dispose)');
        // 换库发生在收尾期间(用户手快)就再收一次:宁可多收一轮,也不许
        // 留下一个 cwd 已经不对的 controller。
        if (currentVaultRoot() !== root) return ensureController();
        controller = buildController();
        controllerVault = root;
        return controller;
    }

    /**
     * 收一个 controller 并把这次收尾挂进 `inFlightTeardown`,
     * 让**同一时刻**只可能有一次收尾在跑。
     */
    function tearDownNow(c) {
        const p = teardownController(c);
        inFlightTeardown = p;
        const clear = () => { if (inFlightTeardown === p) inFlightTeardown = null; };
        p.then(clear, clear);
        return p;
    }

    async function start() {
        if (disposed) throw new Error('Agent 运行时已经释放(dispose)');
        if (inFlightStart !== null) return inFlightStart;
        const p = (async () => {
            const c = await ensureController();
            // 非就绪时 start() 会**拒绝**(M3-A 终审 C2),所以这里不必再判 state。
            await c.supervisor.start();
            emitState(agentStatus());
            return agentStatus();
        })();
        inFlightStart = p;
        const clear = () => { if (inFlightStart === p) inFlightStart = null; };
        p.then(clear, clear);
        return p;
    }

    /**
     * 需要时自动 start + newSession(发提示的路就是"需要时")。
     *
     * ⚠️ 这里**只**认 `sessionId` 非空就算有会话 —— 所以"进程走了但 id 还留着"
     * 必须由 leaveReady() 挡掉(见它的说明)。两处是一对的:少任何一处,
     * 都会出现"拿旧会话 id 发提示、而且再也建不出新会话"。
     *
     * 单飞:两条并发提示不许各建一个会话(后建的那个会把先建的挤成孤儿)。
     *
     * @param {{fresh?:boolean, deferRecord?:boolean}} [options]
     *   `fresh` = 这条会话是刚**新建**的(界面收到要清空对话区);
     *   `deferRecord` = **台账推迟**到第一条用户消息(只有"启动时自动建"那条路传,
     *   理由见 recordPending 与 autoCreateSession)。
     */
    async function ensureSession({ fresh = false, deferRecord = false } = {}) {
        const c = await ensureController();
        if (sessionId !== null) return sessionId;
        if (inFlightSession !== null) return inFlightSession;
        const p = (async () => {
            await start();
            const root = currentVaultRoot();
            if (root === null) throw new Error('还没有选择笔记库(Vault),无法建立会话');
            // ⚠️ 用 ensureController 交回的那个实例,而不是再取一次全局的:
            // 两条并发提示之间若发生换库,后取的那个是**另一个** controller,
            // 拿它的 client 去 newSession 就等于把会话建在刚被顶掉的那个上。
            // ⚠️ 记住这一刻的世代与 controller:`session/new` 是真等网络的一趟,期间进程
            //    可能崩、用户可能按「停止」、用户也可能换了库。醒来时判一次,才不会把一条
            //    属于**已经不存在的进程**的会话写进 sessionId(那正是"会话活过进程",
            //    见 leaveReady 的说明)。
            const epoch = sessionEpoch;
            const sess = await c.client.newSession({ cwd: root });
            if (epoch !== sessionEpoch || controller !== c) {
                throw new Error('这条连接在 session/new 期间已经不在了(停止 / 崩溃 / 换库),这条会话作废');
            }
            sessionId = sess.sessionId;
            activatedSessions.add(sessionId);
            sessionConfigOptions = asArray(sess.configOptions);
            // 「默认思考强度是中」由 kaiwu 保证,不靠对端恰好给中(见 pinEffort)。
            // ⚠️ 必须在 emit 之前补完:否则界面会先亮一下对端的默认值再跳一下。
            sessionConfigOptions = await pinEffort(c, sessionId, sessionConfigOptions, null);
            // 会话一开始就记下它(不是等这一轮结束)—— 见 recordBegin 的说明。
            // ⚠️ 自动建的那条**例外**:它还没有任何内容,落盘就是"每次启动多一个 0 轮的空记录",
            //    所以这里只排一份待写,等用户真的说话了再开头(见 send 里那一段)。
            if (deferRecord === true) {
                recordPending = { id: sessionId, cwd: root, createdAt: Date.now() };
            } else {
                await recordBegin(sessionId, root, Date.now());
            }
            // `caps` 一起报给界面:面板据此在**发图之前**就拦住(而不是发出去挨一句英文)。
            // `fresh` = 「这条会话是刚**新建**的」:界面收到它要把对话区清空(新会话就是空的),
            // 而不是接着上一条往下画。默认 false —— 只有「＋ 新建会话」那条路会传 true。
            emit({
                kind: 'session', sessionId, configOptions: sessionConfigOptions, caps,
                ...(fresh ? { fresh: true } : {}),
            });
            return sessionId;
        })();
        inFlightSession = p;
        // 落定即摘(成功失败都摘):失败之后再发提示要能重试,
        // 而不是永远交回同一个已经失败的 promise。
        const clear = () => { if (inFlightSession === p) inFlightSession = null; };
        p.then(clear, clear);
        return p;
    }

    /**
     * ACP 握手成功(**ready**)之后,若当前没有会话就自动建一条。
     *
     * 这一步就是"一进程序,输入行右边那枚思考强度 / 模型胶囊就能用"的全部实现:
     * 之前会话是**发第一条消息时**才建的,于是新启动的程序里那一枚是空的 ——
     * 点开只有一句"还没建会话…发一条消息之后才会出现",滑块连档位都没有,更拖不动。
     *
     * 为什么触发在**主进程的运行时**、而不是渲染层 invoke('sessions:new'):
     *   · `sessionId` 是**这条连接的属性**(随进程生灭),谁负责建只有这里说得清;
     *   · 渲染层那条路会连带把台账写成一个 0 轮的空记录,而"谁建会话"会散到 UI 层 ——
     *     换个界面(或插件)就得记得再建一次,而"当前到底有没有会话"却只有这里知道。
     *
     * 去重(三条,缺任何一条都会变成"每次 ready 堆一条"):
     *   ① 只在 `sessionId === null` 时建 —— 已经有会话就**一个请求都不发**;
     *   ② 单飞:`ensureSession` 自己也有 inFlightSession 兜底,两个触发点不会各建一条;
     *   ③ 触发点只有**进入 ready 的状态转换**。崩溃重启(crashed → 退避 → ready)也会
     *      再判一次,而那时 `leaveReady` 已经把 sessionId 作废了,所以那是"给新进程建一条"
     *      (正确的),不是"同一进程重复建"(由 ①② 挡住)。
     *
     * 失败**不重试、也不静默**:只记一条 log.error,并推一个 `session-error` 事件
     * (面板把那句原因写在胶囊上)。绝不排定时器反复重试 —— 对端不肯建会话时,
     * 重试风暴只会把日志和进程淹掉,而用户手里的出路(发一条消息会再试一次)本来就在。
     */
    function autoCreateSession() {
        if (disposed) return;
        if (sessionId !== null) return;                       // 已经有会话:一个请求都不发
        if (autoSessionInFlight !== null) return;             // 上一次还在飞:不排队第二个
        const p = (async () => {
            try {
                await ensureSession({ deferRecord: true });
            } catch (err) {
                // dispose 之后就没有界面可说了(也不该再推事件)。同理:如果这一刻已经
                // **不在 ready**,那失败只是"离开 ready"的后果 —— 面板已经从状态上看到
                // 停止/崩溃,再推一句"建会话失败"只会把真正的原因盖住。
                if (disposed || agentStatus().state !== 'ready') {
                    log.warn?.(`[agent] 自动建会话没有完成(${agentStatus().state}):${errorMessage(err)}`);
                    return;
                }
                const message = errorMessage(err);
                log.error?.(`[agent] 自动建会话失败(不重试;发第一条消息时会再试一次):${message}`);
                emit({ kind: 'session-error', message });
            }
        })();
        autoSessionInFlight = p;
        const clear = () => { if (autoSessionInFlight === p) autoSessionInFlight = null; };
        p.then(clear, clear);
    }

    /**
     * 等"启动时自动建会话"那一次落定(没有在飞的就是空操作)。
     *
     * 为什么要等:换会话的两个动作(「＋ 新建会话」/「接着聊」)都会**顶掉当前会话**,
     * 而自动建会话是在 ready 那一刻起飞的 —— 不等的话两个 `session/new` 会同时在飞:
     * 后落定的那个把 `sessionId` 盖回去,用户刚点的「接着聊」就被静默撤销
     * (而且对端多出一条没人认领的会话)。
     */
    async function awaitAutoSession() {
        if (autoSessionInFlight === null) return;
        try { await autoSessionInFlight; } catch { /* 它自己吞掉了错误(见 autoCreateSession) */ }
    }

    /**
     * 把这次会话的思考强度**补**到想要的那一档(默认「中」)。
     *
     * 为什么必须有它(两条都是**实测**出来的,不是设想):
     *   · 新会话:`session/new` 回的强度是**对端按自己的配置**定的(本机实测 `high`);
     *     那是巧合不是约定 —— DSH 那边换个配置、或换条 provider,默认值就会变。
     *     用户拍板的是"默认中",所以这件事得由 kaiwu 自己保证。
     *   · 换模型:对端会**把强度打回新模型的默认值**(实测:手动设成 `low` 之后再换模型,
     *     回来是 `high`)—— 用户刚选的那一档被悄悄丢了。所以换完模型也要补回来。
     *
     * 四条纪律:
     *   ① 只"补"不"抢":目标优先用 `want`(**这次会话已经生效的那个值**),
     *      它不在对端新给的清单里才退到默认档;两者都拿不到就**什么都不发**;
     *   ② 绝不臆造值:发出去的必须**逐字来自对端那份 options**(见 preferredEffortValue);
     *   ③ 一次调用最多补一次,而且失败**不向上抛** —— 强度没补上不该把"建会话 / 换模型"整个弄失败;
     *   ④ 不需要补时**一个请求都不发**(本机对端默认本就是 `high` = 中,所以常态是零请求)。
     *
     * @param {object} c 已经 ensureController() 交回的那个实例(用它自己的 client)
     * @param {string} sid 会话 id
     * @param {Array} opts 对端刚回的整份 configOptions
     * @param {string|null} want 想要的档位值;null = 用 kaiwu 的默认档
     * @returns {Promise<Array>} 最终的 configOptions(补过就是补完的那一份)
     */
    async function pinEffort(c, sid, opts, want) {
        const option = configOptionOf(opts, REASONING_CONFIG_ID);
        if (option === null) return opts;                       // 对端没这一项:没有可补的
        const levels = effortLevels(option);
        if (levels.length === 0) return opts;                   // 一项都没有:同上
        const current = typeof option.currentValue === 'string' ? option.currentValue : '';
        const target = levels.some((l) => l.value === want) ? want : preferredEffortValue(option);
        if (target === null || target === current) return opts;
        try {
            const r = await c.client.setConfigOption({
                sessionId: sid, configId: REASONING_CONFIG_ID, value: target,
            });
            // ⚠️ 回的是空表就**保留原样**:宁可显示旧值,也不把界面那份冲成空
            //    (与 reducer "后一条没带就不动它"同一条纪律)。
            const next = asArray(r?.configOptions);
            return next.length > 0 ? next : opts;
        } catch (err) {
            log.warn?.('[agent] 思考强度没补上(不影响建会话 / 换模型)', err);
            return opts;
        }
    }

    /**
     * 改一条会话配置(模型 / 思考强度)。
     *
     * 语义(照对端的实现写,不是我们猜的):
     *   · `setConfig` 的注释原话是 "Apply one standard configuration option to **later** turns" ——
     *     它影响**后面**的轮次,**正在跑的这一轮不受影响**;
     *   · 响应里回**整份新的 configOptions**,所以界面不必自己拼"改完长什么样";
     *   · 对端还会另外主动推一条 `config_option_update` 通知 —— 那条由 reducer 收,
     *     这里只保证请求这条路也把新状态发出去。
     *
     * ⚠️ 在飞的一轮不许改:一是切换会动上下文,二是两条路并发时状态会来回跳。
     * ⚠️ `value` 原样透传(不透明串;空串合法)。
     *
     * ⚠️ **换模型会把思考强度打回默认**(实测),所以改的不是强度那一条时,改完要把它补回来
     *    —— 判据与理由见 pinEffort。改的**正好就是**强度时不许补:那正是用户刚下的指令,
     *    对端回的才是准的,再补一次等于把用户的选择顶回去。
     */
    async function setConfig({ configId, value } = {}) {
        if (disposed) throw new Error('Agent 运行时已经释放(dispose)');
        const id = typeof configId === 'string' ? configId.trim() : '';
        if (id === '') throw new Error('configId 必填');
        if (typeof value !== 'string') throw new Error('value 必须是字符串');
        if (currentTurn !== null) throw new Error('这一轮还没结束 —— 等它跑完(或取消)再改');

        await ensureController();
        const sid = await ensureSession();
        const c = await ensureController();
        // 改之前**先记下**这一档(补的目标就是它,不是对端改完给的那个)。
        const before = effortValueOf(sessionConfigOptions);
        const r = await c.client.setConfigOption({ sessionId: sid, configId: id, value });
        sessionConfigOptions = asArray(r.configOptions);
        if (id !== REASONING_CONFIG_ID) {
            sessionConfigOptions = await pinEffort(c, sid, sessionConfigOptions, before);
        }
        // 台账里跟上这次改动(清单上显示"这条会话最后用的哪个模型/强度")。
        try {
            recorder.model({
                id: sid,
                model: modelLabelOf(), modelValue: configOptionOf(sessionConfigOptions, MODEL_CONFIG_ID)?.currentValue ?? '',
                effort: effortLabelOf(), effortValue: effortValueOf(sessionConfigOptions) ?? '',
            });
        } catch { /* 记不上不影响这次改动 */ }
        emit({ kind: 'config', sessionId: sid, configId: id, configOptions: sessionConfigOptions });
        return { configId: id, value, configOptions: sessionConfigOptions };
    }

    /**
     * 问对端:这条连接还能恢复哪些会话(「AI 会话」清单里"可接着聊"那一档的来源)。
     *
     * ⚠️ 三条边界:
     *   · **不为了问而拉起进程**:没连接时回 `ok:false / reason:'还没连接'` ——
     *     为了画一份清单去起一个外部进程是很重的副作用(自检模式尤其不该);
     *   · 对端那份清单**不含正在活跃的会话**,所以判"能不能接着聊"要把
     *     `activatedSessions` 一起给界面(见 sessionsInfo);
     *   · 问失败**不清空**上一次的结果?不 —— 这里如实把 ask 置 false(不知道),
     *     宁可让界面少显示一个徽标,也不拿旧清单冒充现在。
     */
    async function listPeerSessions() {
        if (disposed) return { ok: false, reason: 'Agent 运行时已经释放(dispose)', sessions: [] };
        const cwd = currentVaultRoot();
        if (cwd === null) return { ok: false, reason: '还没有选择笔记库(Vault)', sessions: [] };
        if (agentStatus().state !== 'ready') {
            peerSessions = { ask: false, cwd: null, ids: new Set(), reason: '还没连接' };
            return { ok: false, reason: '还没连接', sessions: [] };
        }
        const c = await ensureController();
        try {
            const r = await c.client.listSessions({ cwd });
            peerSessions = {
                ask: true, cwd, reason: '',
                ids: new Set(r.sessions.map((s) => String(s?.sessionId ?? '')).filter((v) => v !== '')),
            };
            return { ok: true, reason: '', sessions: r.sessions, nextCursor: r.nextCursor ?? null };
        } catch (err) {
            const reason = errorMessage(err);
            peerSessions = { ask: false, cwd: null, ids: new Set(), reason };
            return { ok: false, reason, sessions: [] };
        }
    }

    /**
     * 把"当前会话"切到某一条上 —— 「AI 会话」那栏点一行走的就是这里。
     *
     * 两条路,判据是**这条连接里有没有接上过它**:
     *   · 接上过 → 本地换个 id 就行(对端那边它本来就是活跃的,再 resume 会被
     *     "session is already active" 拒掉);
     *   · 没接上过 → `session/resume` 把上下文接回来(要求 cwd 与当初一致)。
     *
     * ⚠️ 对端**不重放旧消息**:切过去之后"看到的历史"由界面从开物自己的台账铺出来
     *    (见 app/agent/panel.js 的 hydrate),对端只负责"记性还在"。
     * ⚠️ 切会话会**换掉**当前这条会话的上下文,所以:在飞的一轮不许切(与 setConfig 同一条纪律);
     *    成功之后照 `session` 事件报给界面,并带 `resumed:true` —— 那是"请把历史铺出来"的信号。
     *
     * @returns {Promise<{sessionId:string, configOptions:Array, reused:boolean}>}
     */
    async function activateSession(targetId) {
        if (disposed) throw new Error('Agent 运行时已经释放(dispose)');
        const sid = typeof targetId === 'string' ? targetId.trim() : '';
        if (sid === '') throw new Error('会话 id 必填');
        if (currentTurn !== null) throw new Error('这一轮还没结束 —— 等它跑完(或取消)再切会话');

        const cwd = currentVaultRoot();
        if (cwd === null) throw new Error('还没有选择笔记库(Vault),无法把会话接回来');

        await ensureController();
        await start();
        // 启动时那次自动建会话若还在飞,先等它落定 —— 否则它会在下面把 sessionId 盖回去
        // (用户刚点的「接着聊」被静默撤销,还对端多出一条没人认领的会话)。
        await awaitAutoSession();
        const c = await ensureController();

        // ① 这条连接里已经接上过它:本地切,不问对端(问了也会被"已活跃"拒掉)。
        if (activatedSessions.has(sid)) {
            recordPending = null;         // 放下上一条会话:它那份待写台账随之作废
            sessionId = sid;
            emit({ kind: 'session', sessionId: sid, configOptions: sessionConfigOptions, caps, resumed: true, reused: true });
            return { sessionId: sid, configOptions: sessionConfigOptions, reused: true };
        }

        // ② 没接上过:请对端恢复。
        let resumed;
        try {
            resumed = await c.client.resumeSession({ sessionId: sid, cwd });
        } catch (err) {
            const raw = errorMessage(err);
            const failure = resumeFailureOf(raw);
            if (failure.kind === 'live') {
                // 对端说它正开着 —— 那它本来就能用,本地接上就是(拿现有的配置)。
                recordPending = null;
                sessionId = sid;
                activatedSessions.add(sid);
                await recordBegin(sid, cwd, Date.now());
                emit({ kind: 'session', sessionId: sid, configOptions: sessionConfigOptions, caps, resumed: true, reused: true });
                return { sessionId: sid, configOptions: sessionConfigOptions, reused: true };
            }
            // ⚠️ 认不出的错误**原样抛**(附上我们认出来的那半句):不许翻成一句"接不上"
            //    了事 —— 排障时那句英文是唯一线索。
            throw new Error(failure.reason === null ? raw : `${failure.reason}(原话:${raw})`);
        }

        recordPending = null;         // 放下上一条会话:它那份待写台账随之作废
        sessionId = sid;
        activatedSessions.add(sid);
        sessionConfigOptions = asArray(resumed.configOptions);
        sessionConfigOptions = await pinEffort(c, sid, sessionConfigOptions, null);
        await recordBegin(sid, cwd, Date.now());
        // 会话换了,模型可能跟着换 → 图片能力要重新问一次(与换模型同一条链)。
        try { await refreshCapabilities(); } catch { /* 问不到就保留旧值 */ }
        emit({ kind: 'session', sessionId: sid, configOptions: sessionConfigOptions, caps, resumed: true });
        // 刚接上的这条不再出现在对端清单里(它活跃了)——缓存的清单随之过期,下次重问。
        peerSessions = { ...peerSessions, ask: false, ids: new Set() };
        return { sessionId: sid, configOptions: sessionConfigOptions, reused: false };
    }

    /**
     * 开一条**全新的会话**(面板上那个「＋ 新建会话」)。
     *
     * 与「接着聊」正好成对:那个是把旧会话连同上下文接回来,这个是从零起一条。
     * 三条纪律:
     *   · **只放下"当前会话"**,绝不清 `activatedSessions` —— 旧会话在对端那边仍然活跃,
     *     忘了它就会被清单误判成「上下文已不在」,点它还会被 already active 拒掉;
     *   · 在飞的一轮不许新建(与切会话同一条:都会换掉上下文);
     *   · 建不出来要**把"放下"这一步收回去** —— 否则界面清空了却一条会话都没有,
     *     用户以为建好了,而下一条消息又会静默地再试一次(现象是"点了没反应,过一会儿又好了")。
     *
     * @returns {Promise<{sessionId:string, previous:string|null, configOptions:Array}>}
     */
    async function beginNewSession() {
        if (disposed) throw new Error('Agent 运行时已经释放(dispose)');
        if (currentTurn !== null) throw new Error('这一轮还没结束 —— 等它跑完(或取消)再新建会话');
        // 启动时那次自动建会话若还在飞,先等它落定:两个 session/new 同时在飞的后果
        // 是后落定的那个把 sessionId 盖掉(用户点了新建却拿到自动建的那一条)。
        await awaitAutoSession();
        const previous = sessionId;
        // 失败要把"待写台账"一起还回去(见下面 catch):那条会话可能还一个字都没说过。
        const pendingBefore = recordPending;
        sessionId = null;
        // 世代 +1:这一刻起,在飞的 `session/new` 落地也算"属于上一个会话"。
        sessionEpoch += 1;
        sessionConfigOptions = [];
        // 被放下的那条会话若还排着一份待写台账,它随之作废(那条会话一个字都没说过)。
        recordPending = null;
        inFlightSession = null;
        try {
            const sid = await ensureSession({ fresh: true });
            return { sessionId: sid, previous, configOptions: sessionConfigOptions };
        } catch (err) {
            sessionId = previous;
            // ⚠️ 待写台账也要一起还回去:那条会话若还没说过话,它的记录本来就还没开头 ——
            //    不还的话,用户回到它之后说的**第一句会静默丢掉**(recorder.user 在
            //    live 表里找不到这条记录,直接返回 null),而"不许静默丢"是硬要求。
            recordPending = pendingBefore;
            throw err;
        }
    }

    /**
     * 会话这一摊的**只读快照**(给「AI 会话」面板与主进程的清单用)。
     * 全是叶子字段:能被 JSON 化,也能直接过 IPC。
     */
    function sessionsInfo() {
        return {
            current: sessionId,
            live: [...activatedSessions],
            peer: {
                ask: peerSessions.ask === true,
                reason: peerSessions.reason ?? '',
                ids: [...peerSessions.ids],
            },
            cwd: currentVaultRoot(),
            // 在飞的一轮:新建 / 切会话都要禁用(都会换掉上下文)。
            busy: currentTurn !== null,
        };
    }

    /**
     * 重新问一次"这条连接能不能收内联图片",并把结果报给界面。
     *
     * 为什么要单独一条:ACP 只在 initialize 广告一次能力,而**换模型会改变它** ——
     * 客户端不重新问,就只能拿旧值继续拦(实测:换成视觉模型之后开物拒绝发图)。
     * 桥那边由 kaiwu 自己打的补丁提供这个问法(kaiwu/capabilities);对端不认识它时
     * 这次调用会失败 —— 那就**保留旧值**,不把状态改坏(旧值至少是"握手时说过的实话")。
     *
     * @returns {Promise<{image:boolean}|null>} 问不到返回 null
     */
    async function refreshCapabilities() {
        if (sessionId === null) return null;
        try {
            const c = await ensureController();
            const r = await c.client.capabilities({ sessionId });
            caps = { image: r.image === true, audio: false, embeddedContext: false };
            emit({ kind: 'caps', caps });
            return caps;
        } catch (err) {
            log.warn?.('[agent] 能力刷新失败(保留旧值)', err);
            return null;
        }
    }

    /**
     * 发一条提示。
     *
     * 取消与超时的收尾语义(契约):
     *   - 超时:以"已超时"**拒绝**,并给对端发一条 `session/cancel` 通知;
     *   - 取消:本地这一次以 `{stopReason:'cancelled'}` **收场**,同样发 `session/cancel`;
     *   - 两者都**当场结掉**本地这一次,并且**之后**对端可能还会把真正的响应送回来 ——
     *     那一条已经被 acp-client 从 pending 里摘掉了,不会影响调用方,也不会留下
     *     未处理的拒绝(它连 Promise 都没有)。
     *
     * 黏贴截图:`options.images` 是叶子数据 `[{mimeType, bytes}]`,由主进程侧的
     * `admitImagePayload` **再判一遍**(渲染进程递来的东西不可信)。图片与文字
     * 一起进同一次 `session/prompt` —— 分成两次发就等于让模型看到两条互不相干的
     * 消息,它没法把图和问题对上。**纯文本那条路完全不变**:不传 images 时
     * prompt 块还是 `[{type:'text', text}]`。
     *
     * @param {string} text
     * @param {{images?: unknown}} [options]
     */
    async function send(text, options = {}) {
        if (disposed) throw new Error('Agent 运行时已经释放(dispose)');
        const admitted = admitImagePayload(options?.images);
        if (admitted.ok !== true) throw new Error(admitted.reason);
        const images = admitted.images;
        const question = typeof text === 'string' ? text : '';
        // 允许"只发图片、没写字" —— 黏贴一张截图直接发送是正常用法。
        if (question.trim() === '' && images.length === 0) throw new Error('提示内容不能为空');

        // ⚠️ **发之前**就拦:对端在 initialize 时说了它不收内联图片,那就别发。
        //    发出去的结果只有一句 -32602 的英文(用户实测看到的就是它),而且图片
        //    与文字是一起发的 —— 这一条被拒等于**整条提示都没发出去**。
        //    caps 为 null(还没握手)时不拦:那不叫"不支持",叫"还不知道"。
        if (images.length > 0 && caps !== null && caps.image !== true) {
            throw new Error(imageCapabilityRefusal(caps, modelConfigValue()));
        }

        // 先确认"能用哪个 controller"(没有 Vault / 没得跑的命令要在建会话之前就失败),
        // 但**不能**把它留到 prompt 时用:见下面那次重新取。
        await ensureController();
        if (currentTurn !== null) throw new Error('上一条提示还没有结束,先取消或等它结束');
        const sid = await ensureSession();
        if (currentTurn !== null) throw new Error('上一条提示还没有结束,先取消或等它结束');
        // 会话建好之后再取一次 controller:session/new 期间用户可能换了库 ——
        // 那样 ensureSession() 已经把旧的 controller 收掉了(会话也随之作废),
        // 这里必须拿**新的**那一个去 prompt,否则请求会挂在一个已经停掉的进程上。
        const c = await ensureController();

        // 启动时自动建的那条会话:台账**推迟到这一刻**才开头(见 ensureSession 的 deferRecord)。
        // ⚠️ 必须在 recorder.user() **之前** —— user() 在 live 表里找不到这条记录会直接
        //    返回 null,用户说的这一句就**静默丢掉**了(而且那条会话会变成一个空文件)。
        // ⚠️ 只认 id 对得上的那一份:会话中途被换掉(换库 / 新建 / 接着聊)时旧的待写
        //    已经作废(见 forgetSession 那几处),不能拿它去开一条别的会话的记录。
        if (recordPending !== null && recordPending.id === sid) {
            const pending = recordPending;
            recordPending = null;
            await recordBegin(pending.id, pending.cwd, pending.createdAt);
        }

        // 记账:用户问的那一句。
        // ⚠️ 记的是 `options.shown`(**气泡里显示的那句**)而不是 question —— question 里
        //    还裹着笔记上下文那一段,铺回历史时用户看到的将是一大段他没打过的东西。
        //    老调用方没给 shown 时退回 question(那至少没丢内容)。
        const shownText = typeof options?.shown === 'string' && options.shown.trim() !== ''
            ? options.shown
            : question;
        try {
            recorder.user({ id: sid, text: shownText, images: images.length, at: Date.now() });
        } catch (err) {
            log.warn?.('[agent] 这一句没记进会话记录', err);
        }

        let resolveCancelled;
        const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
        let settled = false;
        const finish = (fn) => (value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };

        const turn = {
            sessionId: sid,
            resolveCancelled: () => finish(resolveCancelled)({ stopReason: 'cancelled' }),
            // 取消要发的是**通知**:session/cancel 在 ACP 里没有响应,
            // 用 client.call 登记一个 pending 就等于自己造一个永远等不到回答的转圈。
            //
            // ⚠️ 幂等:`cancel()` 会调它,`send()` 的 cancelled 分支**也会**调它 ——
            // 从前两处各发一条,对端会收到重复的取消。而 `session/cancel` 只带
            // sessionId、没有 turn id:第一条若已让对端结束那一轮,迟到的第二条
            // 就可能落在**下一轮**上(用户按一次取消,却把下一轮也取消了)。
            cancelSent: false,
            requestCancel: () => {
                if (turn.cancelSent) return false;
                turn.cancelSent = true;
                return c.client.notify(METHODS.SESSION_CANCEL, { sessionId: sid });
            },
        };
        currentTurn = turn;
        busy = true;
        emitState(agentStatus());

        // 这一轮的两只表:**空闲**(两次增量之间的间隔)与**总时长上限**。
        // 两条路的收场完全相同(发 session/cancel + 当场以失败收场),只是文案不同 ——
        // 分开是为了让用户从那句话就知道该做什么:是"对端没动静了",还是"这一轮太长了"。
        let idleHandle = null;
        let maxHandle = null;
        // 正在跑的工具(toolCallId)。工具在跑就**不**判空闲超时 —— 理由见 toolProgressOf。
        const toolsInFlight = new Set();
        let rejectTimeout = () => { /* 下面 Promise 的构造函数里立刻换成真的 reject */ };
        const timedOut = new Promise((_, reject) => { rejectTimeout = reject; });
        /** 重新开始计空闲窗口。**每一条增量**都会调它。 */
        const armIdle = () => {
            if (idleHandle !== null) timers.clearTimeout?.(idleHandle);
            idleHandle = timers.setTimeout(() => {
                idleHandle = null;
                // 工具还在跑:这不是"没响应",重新计时,这一轮交给总上限兜底。
                if (toolsInFlight.size > 0) { armIdle(); return; }
                rejectTimeout(new Error(
                    `提示超时(${promptTimeoutMs}ms 没有任何进展),已经请求对端取消`,
                ));
            }, promptTimeoutMs);
        };
        armIdle();
        maxHandle = timers.setTimeout(() => {
            rejectTimeout(new Error(
                `这一轮超过了 ${Math.round(promptMaxMs / 60000)} 分钟上限,已经请求对端取消`,
            ));
        }, promptMaxMs);

        try {
            const outcome = await Promise.race([
                c.client
                    .prompt({
                        sessionId: sid,
                        text: question,
                        images,
                        onUpdate: (update) => {
                            // 进度 = 增量:每来一条就**重新开始**计空闲窗口。这一句就是
                            // "一直在出字的一轮不该被判超时"的全部实现(见上面常量的注释)。
                            const tool = toolProgressOf(update);
                            if (tool !== null) {
                                if (tool.done) toolsInFlight.delete(tool.id);
                                else toolsInFlight.add(tool.id);
                            }
                            armIdle();
                            // 记账与界面**同一份增量**:一处收两处用,免得"界面看到了、
                            // 记录里没有"这种只有事后翻记录才会发现的错位。
                            try { recorder.update({ id: sid, update, at: Date.now() }); } catch { /* 记不上不该影响这一轮 */ }
                            emit({ kind: 'update', sessionId: sid, update });
                        },
                    })
                    .then((r) => ({ done: true, value: r }), (err) => ({ done: false, error: err })),
                cancelled.then((value) => ({ cancelled: true, value })),
                timedOut.then(() => ({ timedOut: true }), (err) => ({ timedOut: true, error: err })),
            ]);

            if (outcome.cancelled === true) {
                turn.requestCancel();
                try { recorder.end({ id: sid, stopReason: 'cancelled', at: Date.now() }); } catch { /* 记不上不影响收场 */ }
                emit({ kind: 'prompt-end', sessionId: sid, stopReason: 'cancelled' });
                return { stopReason: 'cancelled' };
            }
            if (outcome.timedOut === true) {
                turn.requestCancel();
                try {
                    recorder.end({ id: sid, error: errorMessage(outcome.error), at: Date.now() });
                } catch { /* 同上 */ }
                emit({
                    kind: 'prompt-error',
                    sessionId: sid,
                    message: errorMessage(outcome.error),
                    missingCredential: false,
                });
                throw outcome.error;
            }
            if (outcome.done === false) {
                const err = outcome.error;
                const raw = errorMessage(err);
                // 图片被桥拒掉时它回的是英文("...were not advertised by this
                // connection"),对用户等于没说。认得出就换成一句中文,认不出照旧。
                const hint = images.length > 0 ? imagePromptFailureHint(raw) : null;
                try { recorder.end({ id: sid, error: raw, at: Date.now() }); } catch { /* 同上 */ }
                emit({
                    kind: 'prompt-error',
                    sessionId: sid,
                    message: hint === null ? raw : `${hint}(原话:${raw})`,
                    // 硬要求 5:-32603 no API key 这类"没配钥匙"必须**判出来**,
                    // 不能渲染成"已连接然后莫名失败"。
                    missingCredential: isMissingCredentialError(err),
                });
                throw err;
            }
            const stopReason = outcome.value?.stopReason ?? null;
            try { recorder.end({ id: sid, stopReason, at: Date.now() }); } catch { /* 同上 */ }
            emit({ kind: 'prompt-end', sessionId: sid, stopReason });
            return { stopReason };
        } finally {
            if (idleHandle !== null) timers.clearTimeout?.(idleHandle);
            if (maxHandle !== null) timers.clearTimeout?.(maxHandle);
            // ⚠️ 只有"这一轮还是当前那一轮"时才归位。离开 ready 时 leaveReady()
            // 已经把 currentTurn 清掉、busy 归位,并且可能已经让下一条提示起了
            // 新一轮 —— 那时 busy 归**新那一轮**管,这里再写一遍就是把它按成
            // "不在忙"(界面于是又开始转圈却再也停不下来)。
            if (currentTurn === turn) {
                currentTurn = null;
                busy = false;
                emitState(agentStatus());
            }
        }
    }

    /** 取消正在进行的提示。没有在进行的提示时 `{cancelled:false}`。 */
    async function cancel() {
        const turn = currentTurn;
        if (turn === null) return { cancelled: false };
        turn.requestCancel();      // 立刻告诉对端停下
        turn.resolveCancelled();   // 本地这一次**当场**收场,不挂着等对端的响应
        return { cancelled: true };
    }

    /**
     * 按需翻译一段文字(思考条上的「译」)。
     *
     * 这不是一次提示:它走的是 kaiwu 与桥之间的**非标准**方法 `kaiwu/translate`,
     * 由桥用 `ctx.llm` 一次性翻完 —— 所以它**不碰** currentTurn / busy / 会话历史:
     * 用户在看答案的同时点一下翻译,不该把当前那一轮搅乱(那正是"提示还没结束,
     * 先取消或等它结束"这条闸要防的事)。
     *
     * 事件形状(渲染进程据此更新那一条思考):
     *   { kind:'translation', thoughtId, status:'pending' }
     *   { kind:'translation', thoughtId, status:'done', text }
     *   { kind:'translation', thoughtId, status:'error', error }
     */
    async function translateThought({ thoughtId, text } = {}) {
        const id = trimmed(thoughtId);
        const source = typeof text === 'string' ? text : '';
        if (id === '' || source.trim() === '') throw new Error('翻译需要 thoughtId 与非空 text');
        const c = controller;
        if (c === null) throw new Error('Agent 还没连上,没法翻译');
        // ⚠️ 必须在**某个会话**的模型路由下翻:`ctx.llm` 要靠 sessionId 才能解析出
        // provider 的凭证 —— 不带它去调,桥那边只会拿到一条
        // "no API key for provider route …"(MISSING_CREDENTIAL),而那是**实测**出来的。
        // 好在界面上「译」只长在收尾的思考条上,那时一定已经有会话了。
        const sid = sessionId;
        if (sid === null) throw new Error('还没有会话 —— 翻译要在会话的模型路由下进行');

        emit({ kind: 'translation', thoughtId: id, status: 'pending' });
        try {
            const result = await c.client.call(METHODS.TRANSLATE, { text: source, sessionId: sid });
            const translated = trimmed(result?.text);
            if (translated === '') throw new Error('翻译结果为空');
            emit({ kind: 'translation', thoughtId: id, status: 'done', text: translated });
            return { ok: true, text: translated };
        } catch (err) {
            const message = errorMessage(err);
            emit({ kind: 'translation', thoughtId: id, status: 'error', error: message });
            throw err;
        }
    }

    /**
     * 回一个权限决定。
     * @returns {Promise<{ok:boolean}>} 找不到那个请求(已超时/已决/不存在)时 ok=false。
     */
    async function answerPermission(requestId, optionId) {
        const id = trimmed(requestId);
        const option = trimmed(optionId);
        if (id === '' || option === '') return { ok: false };
        const ok = settlePermission(id, { outcome: { outcome: 'selected', optionId: option } });
        return { ok };
    }

    async function stop() {
        // 硬要求 3 的 `stop()` 那条路:先结掉在飞请求**并作废会话**,再停进程 ——
        // 反过来的话,prompt() 会一直挂在"等一个已经死掉的进程回答",而且
        // 停止之后再 start() 会拿一个属于上一个进程的会话 id 去发提示。
        //
        // ⚠️ 这一次 **emit:false**,收干净之后再自己推一条:leaveReady 那一刻
        // controller 还在(它要用 controller 结在飞请求),而 `agentStatus()` 是按
        // controller 算状态的 —— 它这时报的**还是 ready**。推出去就是一条"状态没变"
        // 的假事件:面板继续写着已连接、发送按钮亮着,而进程其实已经没了,用户点下去
        // 必然失败(真机上就是这么表现的:从输入卡片或设置页按下停止,界面纹丝不动)。
        // 收掉 controller 之后再推,`agentStatus()` 才如实地是 stopped ——
        // 面板据此把「已经停掉 + 重试」摆出来。
        leaveReady(LEFT_READY.stopped, { emit: false });
        const c = controller;
        // ⚠️ 顺手把 controller **收掉**(不是只停进程):下一次 start() 必须按
        // **当时的** Vault 重建 —— `createAgentSpawn` 的 cwd/env 在创建那一刻就
        // 冻结了,留着这个已停的 controller 就等于把 cwd 焊死在停止前的那个库上。
        controller = null;
        controllerVault = null;
        if (c !== null) await tearDownNow(c);
        emitState(agentStatus());
        return agentStatus();
    }

    /** 凭证"有没有"。只有叶子字段 —— **绝不许**带出密钥值。 */
    async function credentials() {
        const result = detectCredentialsFn({
            env: env ?? process.env,
            home: dshHome(),
            readFile,
        });
        return { ok: result.ok === true, source: result.source ?? null, reason: result.reason ?? null };
    }

    /** 释放:停进程、结掉在飞请求与挂起的权限请求。可重复调用。 */
    async function dispose() {
        if (disposed) return;
        disposed = true;
        // 挂起的权限请求一律**丢弃**(不发响应):请求方那个进程正是我们接下来
        // 要停掉的这个,没有人在等;而响应会顺着**当前** transport 走,重启之后
        // 就是打到新进程上(见 dropPermissionsOf 的说明)。
        if (controller !== null) dropPermissionsOf(controller);
        const c = controller;
        controller = null;
        controllerVault = null;
        // 与 leaveReady 同一条规则:会话属于进程,进程没了会话就没了。
        forgetSession();
        inFlightSession = null;
        busy = false;
        currentTurn = null;
        listeners.clear();
        if (c !== null) await tearDownNow(c);
        else if (inFlightTeardown !== null) await inFlightTeardown;
        // 最后把会话记录落干净:forgetSession 里那次是"不等人"的,而进程要走了,
        // 这是最后的机会(记录是用户能看回去的唯一一份,dsh 自己那份不留东西)。
        try { await recorder.flush?.(); } catch (err) { log.warn?.('[agent] 收尾时会话记录没写完', err); }
    }

    return {
        status: agentStatus,
        credentials,
        start,
        stop,
        send,
        setConfig,
        listPeerSessions,
        activateSession,
        beginNewSession,
        sessionsInfo,
        refreshCapabilities,
        cancel,
        translateThought,
        answerPermission,
        onEvent(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        dispose,
    };
}