// Agent 子进程的监护人:拉起来、等握手、盯着它、必要时退避重启。
//
// **不要照抄 service-supervisor**:那个管的是"有端口的 HTTP 服务",就绪靠探端口;
// 这个管的是 stdio 长连接,**就绪判定是 ACP 握手完成**(设计文档 §5.1)。
// 探端口在这里毫无意义 —— 它根本不开端口。
//
// 全部依赖注入(spawnChild / handshake / timers),所以可以脱离 Electron 单测。
import { spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { drainLines, encodeMessage, parseMessage } from '../../app/lib/acp-frame.js';

// ⚠️ 这只是"直接构造监护人、又没给超时"时的**兜底**,不是 kaiwu 的产品默认值 ——
// 产品默认值住在 electron/agent/agent-runtime.js 的 DEFAULT_HANDSHAKE_TIMEOUT_MS(35s),
// 由 runtime 显式注入进来(测试也一律注入小值,所以这里改成多少都不影响用例)。
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;
const DEFAULT_LOG_RING = 200;
// "稳定窗口":能连续 ready 满这么久,就说明前面那些崩溃不算"连续崩溃"。
// 没有它,几次跨越几天的崩溃会累加到 maxRestarts 上,永久熔断 ——
// 而每一次其实都握上手、也正常跑了一段时间,那不该算熔断。
const DEFAULT_READY_STABILITY_MS = 60000;

/**
 * 默认的"杀整棵树"。child.kill() 只杀直接子进程,而 Agent 为了跑工具
 * 会再开子进程 —— 那些会变成孤儿留在机器上(实测过的真实故障)。
 */
function defaultKillTree(pid) {
    if (typeof pid !== 'number') return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        return;
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已经死了 */ }
}

/**
 * `setState(next, error, detail)` 里那份 detail 的契约检查。
 *
 * 为什么要有它:detail 的旧默认值是 `{ pid: null }`,于是**未来**某个忘了传 detail
 * 的调用点会静默退回终审 C1 修掉的那个 bug —— 通知里带着一个看起来完全合法的
 * pid:null,"这次转换是关于哪个进程的"重新变成没人说得清。默认值只能覆盖
 * undefined,所以问题不在"默认成什么",而在"能不能有默认值":改成必须**显式**说清,
 * 省略、给 `{}`、`{ pid: undefined }` 一律当场抛。
 *
 * 为什么单独导出:模块内 11 个调用点全都写对了,从外面**永远触发不到**这个抛错 ——
 * 不导出一个检查入口,"漏了就炸"这条不变量本身就没法测。它没有副作用,只是个形状检查。
 *
 * @param {unknown} detail
 * @returns {void}
 */
export function assertPidDetail(detail) {
    if (detail === null || typeof detail !== 'object') {
        throw new Error('setState 需要显式给出 detail(形状 { pid }):'
            + '它就是"这次转换是关于哪个进程的",漏了就等于把 C1 那个 bug 放回来');
    }
    const pid = detail.pid;
    // 数字 = 点名了某个进程;显式 null = "这次转换确实没有进程"(比如 stop() 时根本没有活进程)。
    // undefined 不是"没有进程",是"没想清楚",必须当场炸。
    // NaN 也要炸:它 `typeof` 是 number,可 `detail.pid ?? null` 会把它变成 null ——
    // 那正好是这条检查要防的"静默退化成没有进程"。形状检查不能只看 typeof。
    if (pid !== null && (typeof pid !== 'number' || Number.isNaN(pid))) {
        throw new Error('setState 的 detail.pid 必须显式写成数字或 null'
            + `(收到 ${pid === undefined ? '空' : typeof pid})`);
    }
}

/**
 * @param {object} deps
 * @param {() => import('node:child_process').ChildProcess} deps.spawnChild
 * @param {(transport: {send:Function,onMessage:Function}) => Promise<any>} deps.handshake
 */
export function createAgentSupervisor({
    spawnChild,
    handshake,
    killTree = defaultKillTree,
    log = console,
    maxRestarts = 5,
    baseDelayMs = 500,
    maxDelayMs = 15000,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    logRingSize = DEFAULT_LOG_RING,
    readyStabilityMs = DEFAULT_READY_STABILITY_MS,
    timers = { setTimeout, clearTimeout },
} = {}) {
    let state = 'stopped';
    // 当前这**一个 attempt**(见 start() 里 attempt 的构造)。没有活着的 attempt 就是 null。
    // ⚠️ 子进程、分帧缓冲、两个解码器都**不在模块级** —— 它们只属于某一次 attempt,
    // 所以"上一轮进程迟到的字节拼进这一轮的消息"在结构上不可能发生(见 start())。
    let current = null;
    let restarts = 0;
    let since = Date.now();
    let lastError = null;
    let stopping = false;
    let restartTimer = null;
    let stabilityTimer = null;
    // 每一轮 start() 发一张"身份牌"。子进程的 exit 是**异步**的,没有身份牌就分不清
    // "这条 exit 是当前这个进程发的,还是上一轮那个已经被换掉的进程发的"。
    let generation = 0;
    // 在飞的那一次 start()(见 start() 的并发语义):第二次 start() 交回它的结局,
    // 而不是一个 {state:'starting'} 的快照。落定即摘(见 start())。
    let inFlightStart = null;
    // 每一次 stop() 发一张"所有权牌":stopping 这面闸门归**最新那次** stop() 管。
    // stop() 等完 exit 醒来做世代对账时,靠它判断"闸门是不是还归我" ——
    // 不这么写,晚到的 stop() 只会二选一:要么把 stopping 留成 true(等于把 start()
    // 永久焊死,而新一代的进程可能正活着),要么擅自替后一次 stop() 拆掉闸门。
    let stopToken = 0;

    const stateListeners = new Set();
    const messageListeners = new Set();

    // 日志环形缓冲:Agent 崩了之后要看的是"最后几十行 stderr",
    // 而不是一个会无限涨的数组(设计文档 §5.1)。
    const logRing = [];
    function pushLog(line) {
        logRing.push(line);
        if (logRing.length > logRingSize) logRing.splice(0, logRing.length - logRingSize);
    }

    /**
     * 把某个 attempt 的 stderr 缓冲里**没有换行结尾**的残留补记成一行。
     * 按行分帧有个天然的代价:不到换行就不算"一行",残行会一直压在缓冲里。
     * 而崩掉的 Agent 的最后一句往往正是崩溃原因 —— 进程退出时补记,别让它随缓冲消失。
     * (残行属于哪个 attempt 是明确的:缓冲就挂在那一个 attempt 上。)
     */
    function flushStderr(attempt) {
        const rest = attempt.stderrBuffer.trim();
        attempt.stderrBuffer = '';
        if (rest === '') return;
        pushLog(rest);
        log.warn?.('[agent] ' + rest);
    }

    /**
     * 子进程最后几行输出 —— 握手失败/引擎起不来时**唯一**的现场线索。
     *
     * 两块拼起来:
     *   · 环形缓冲里最后几行 **stderr**(引擎自己的日志/报错);
     *   · **握手期间**收到的 stdout 原文(带 `← ` 前缀)——
     *     这样"它一句话没说"和"它答了、我们没认出来"是当场分得清的两件事。
     * 后者只压在这一个 attempt 上(见 handshakeTrace),不进 logs() 的那个环 ——
     * 那个环的契约是"最后 N 行 stderr",混进协议消息会让它不再可信。
     */
    function subprocessTail(attempt, lines = 8, maxChars = 1500) {
        const trace = Array.isArray(attempt?.handshakeTrace) ? attempt.handshakeTrace : [];
        const tail = [...logRing.slice(-lines).map((l) => String(l)), ...trace]
            .filter((l) => l.trim() !== '');
        if (tail.length === 0) return '';
        return tail.join('\n').slice(-maxChars);
    }

    /**
     * 给一条失败原因加上"子进程最后说了什么"。
     *
     * ⚠️ 分成两处写,是因为两者的读者不同:
     *   · **完整尾巴进日志**(`--- 子进程最后输出 ---` 夹起来)—— 排查的人要的是原文;
     *   · 错误消息里只带**最后两行**(它会出现在面板那张提示卡上,几十行会把卡片撑爆),
     *     没有输出时也要说清是"一个字都没说",不然读的人分不清"没说"和"没记"。
     */
    function withSubprocessTail(message, attempt) {
        const tail = subprocessTail(attempt);
        if (tail === '') {
            log.warn?.(`[agent] ${message};子进程一个字都没说(它没在 stderr/stdout 上留下任何东西)`);
            return `${message};子进程一个字都没说`;
        }
        log.warn?.(`[agent] ${message}\n--- 子进程最后输出 ---\n${tail}\n--- 以上 ---`);
        const brief = tail.split('\n').slice(-2).join(' / ').slice(0, 300);
        return `${message};子进程最后输出:${brief}`;
    }

    /** 只吐叶子字段 —— 不要把 ChildProcess 这种活对象递给渲染进程。 */
    function status() {
        return {
            state,
            pid: current?.proc?.pid ?? null,
            restarts,
            since,
            error: lastError === null ? null : String(lastError.message ?? lastError),
        };
    }

    /**
     * 状态转换 + 把**转换时刻**的快照投递给监听者。
     *
     * ⚠️ `detail.pid` 必须由**调用点**显式给出 —— 它就是"这次转换是关于哪个进程的"。
     * 不能在这里用 `current?.proc?.pid` 现推:stop() 是「先 setState('stopping')、
     * 再把 current 置空、最后 setState('stopped')」,而通知是微任务投递的 ——
     * 现推的话 'stopped' 那条通知永远带着 pid:null,靠这些事件推进 UI 的界面
     * 根本说不出"停的是哪个进程"(终审 C1)。'crashed' 同理:进程刚死,
     * 但那正是这次转换要说明的对象。
     *
     * **投递契约**:快照描述的是**转换发生的那一刻**(state/since/error/pid/restarts
     * 都在那一刻冻结),它在微任务里才送到监听者手里。所以它完全可能与监听者
     * 收到通知后再调一次 `status()` 的结果**不同**(那时进程可能已经从 current 摘掉、
     * pid 已经归 null)。这不是矛盾:通知是"发生过什么",status() 是"现在是什么"。
     *
     * ⚠️ `detail` **没有默认值**(以前是 `{ pid: null }`)。默认值会让一个忘了给的
     * 调用点静默退回 C1:通知带着一个看起来合法的 pid:null,而 C1 正是"通知必须
     * 说得清这次转换是关于哪个进程的"。所以 omission 必须是**响的** ——
     * 由 assertPidDetail 当场抛。合法写法只有两种:`{ pid: 4321 }`(点名某个进程)
     * 或 `{ pid: null }`(**显式**说明这次转换没有进程,比如 stop() 时根本没有活进程)。
     * 每个调用点都要想清楚它说的是谁。
     */
    function setState(next, error = null, detail) {
        assertPidDetail(detail);
        state = next;
        since = Date.now();
        lastError = error;
        const snap = status();
        snap.pid = detail.pid ?? null;
        // ⚠️ **只推迟"通知",不推迟状态本身**:状态字段当场就改,监听者只是在微任务里
        // 才收到这条通知。同步通知是这里最脆的一点 —— 监听者是应用代码,它完全可以在
        // 收到通知时反手调 stop()/start()。同步发的话,那次重入就落在"状态已经改了、
        // 但这一轮的 attempt 还没造出来/还没挂上"的**半截世界**里:
        // start() 刚 setState('starting') 就被 stop() 抢先 bump 世代,而它醒来照常
        // spawn 并 current = attempt —— 于是 stopping 与一个活进程同时存在,
        // start() 被开头那道 stopping 闸门永久拒绝,而那个进程正是用户要停的。
        // 推迟到微任务后,重入看到的永远是**一致**的世界:那一刻 attempt 已经挂好,
        // stop() 能真的停掉它,不会再有任何"世界已经变了但代码还在按老世界观走"的窗口。
        queueMicrotask(() => {
            for (const fn of stateListeners) {
                try { fn(snap); } catch (err) { log.warn?.('[agent] 状态监听器抛错', err); }
            }
        });
    }

    function emit(msg) {
        for (const fn of messageListeners) {
            try { fn(msg); } catch (err) { log.warn?.('[agent] 消息监听器抛错', err); }
        }
    }

    /**
     * 让在飞的握手立刻收场(并摘掉它的超时计时器)。
     * 不这么做,start() 的续段会一直挂到握手超时,然后**在世界已经变了之后**
     * 继续把状态写成 ready/failed —— 那正是"stop() 之后被复活"和
     * "死进程被判成就绪"的来源。
     */
    function settleHandshake(attempt) {
        const pending = attempt?.handshake;
        if (pending === undefined || pending.settled) return;
        pending.settled = true;
        if (pending.timer !== null) {
            timers.clearTimeout?.(pending.timer);
            pending.timer = null;
        }
        pending.settle?.();
    }

    function clearStabilityTimer() {
        if (stabilityTimer === null) return;
        timers.clearTimeout?.(stabilityTimer);
        stabilityTimer = null;
    }

    /**
     * 进入 ready 后开始记"稳定窗口"。
     * ⚠️ 定时器必须挂在 attempt 身份上:进程崩掉、用户按停、或者又开了一轮,
     * 旧 attempt 的定时器到点后**不许**再改计数(那是在为别人的生命周期清零)。
     */
    function armStabilityTimer(attempt) {
        clearStabilityTimer();
        stabilityTimer = timers.setTimeout(() => {
            stabilityTimer = null;
            if (!attempt.isCurrent()) return;   // 上一轮的定时器:当没到点
            if (state !== 'ready') return;      // 已经不在就绪了(比如刚崩),更不该清零
            restarts = 0;
        }, readyStabilityMs);
    }

    /** 摘掉待放行的退避定时器(幂等;没挂着就什么也不做)。 */
    function clearRestartTimer() {
        if (restartTimer === null) return;
        timers.clearTimeout?.(restartTimer);
        restartTimer = null;
    }

    const transport = {
        /**
         * @returns {boolean} 这条消息是否**真的**交给了子进程。
         * 没交出去时必须返回 false:Task 4 的 acp-client 要靠这个信号知道
         * "这个请求永远不会有人回答",而不是傻等一个永不到来的响应。
         */
        send(msg) {
            const stdin = current?.proc?.stdin;
            if (!stdin?.writable) {
                // 静默丢消息是最难查的那种故障:调用方在等响应,而它根本没发出去。
                log.warn?.('[agent] 子进程 stdin 不可写,消息被丢弃:' + String(msg?.method ?? msg?.id ?? ''));
                return false;
            }
            try {
                stdin.write(encodeMessage(msg));
                return true;
            } catch (err) {
                log.warn?.('[agent] 写 stdin 失败:' + (err?.message ?? err));
                return false;
            }
        },
        onMessage(fn) {
            messageListeners.add(fn);
            return () => messageListeners.delete(fn);
        },
    };

    function backoffDelay() {
        const step = Math.max(0, restarts - 1);
        return Math.min(baseDelayMs * (2 ** step), maxDelayMs);
    }

    function scheduleRestart(attempt) {
        if (stopping) return;
        if (restarts >= maxRestarts) {
            // 熔断说的是"刚刚崩掉的那个进程":快照必须点名它,而不是投递时的空世界。
            setState('failed', new Error(`Agent 连续崩溃 ${restarts} 次,不再自动重启`),
                { pid: attempt.proc?.pid ?? null });
            return;
        }
        const delay = backoffDelay();
        log.warn?.(`[agent] ${delay}ms 后重启(第 ${restarts} 次)`);
        // ⚠️ 先摘掉上一个再挂新的。不摘的话,手动 start() 顶掉一轮重启之后旧把手
        // 还躺在定时器队列里,而 stop() 只清得掉**最新**那一个 —— 漏网的那个到点
        // 就去 start({autoRestart:true}),把用户刚停掉的 agent 又拉起来(实测过)。
        clearRestartTimer();
        const handle = timers.setTimeout(() => {
            // 到点时把手已经不是"当前那个"了:这一轮重启早就被撤销/顶替,别再动。
            if (restartTimer !== handle) return;
            restartTimer = null;
            // 再核一次世代:即便 clearTimeout 没生效(注入的假定时器、或定时器
            // 已经在执行队列里),上一轮排的退避也绝不许拉起进程。
            if (!attempt.ownsGeneration()) return;
            start({ autoRestart: true }).catch(err => log.error?.('[agent] 重启失败', err));
        }, delay);
        restartTimer = handle;
    }

    /**
     * 把"没就绪"做成**不可忽略**的失败(终审 C2)。
     *
     * 以前 start() 会带着 {state:'failed'|'crashed'|'stopping'} 正常 resolve ——
     * 计划里只有一句散文说"要读 .state",调用方漏判一次就把 failed 当成了"连上了"。
     * 现在非就绪一律抛出,消息里点名 state **和** 原因:光有 state 不够,
     * 协议版本、EPERM、握手超时这些原始原因必须跟着走,否则现场只剩一个状态名。
     */
    function notReadyError(snap, why) {
        // 快照里记下的原因(可能是 ENOENT / 协议版本 / 意外退出)与这次 start()
        // 自己的上下文(比如"被 stop() 作废")**都要带上**:只留状态名等于把现场丢了,
        // 只留其中一条则会漏掉另一半 —— 两句话用分号连起来,读日志的人自己拼。
        const reason = [snap.error, why].filter((s) => s !== null && s !== undefined && s !== '')
            .join(';') || '没有给出原因';
        const err = new Error(`Agent 未就绪(state=${snap.state}):${reason}`);
        // ⚠️ 机器可读的那一份**必须挂在错误对象上**,不能只藏在上面那句中文里:
        // 下一个计划要按 state 分支(比如"stopping 就等一会儿再试"、"failed 就别重试"),
        // 让它去正则匹配自己写的散文,等于把契约塞进文案里 —— 改一个措辞就静默失效。
        // 快照与 status() 同形状(只有叶子字段),而且在这里**冻结**:等调用方 catch 到时,
        // status() 可能已经是另一回事了(通知/状态是"当下",错误说的是"这次 start() 为什么没成")。
        err.state = snap.state;
        err.snapshot = { ...snap };
        return err;
    }

    /**
     * start() 的入口。就绪时 resolve 一个快照;**其它一切结局都 reject**(见 notReadyError)。
     *
     * 并发语义:已经在起的时候,第二次 start() 交回**在飞那一次**的结局,
     * 而不是立刻给一个 {state:'starting'} 的在飞快照 —— 否则调用方看到它 resolve
     * 就会以为连上了,转身 newSession() 进一个即将 failed 的监护人。
     */
    function start(opts) {
        if (state === 'ready') return Promise.resolve(status());
        if (state === 'starting') {
            if (inFlightStart !== null) return inFlightStart;
            // ⚠️ 状态已经是 'starting',却没有在飞的 promise —— 这是**半截世界**。
            // doStart 的同步段(setState('starting') → spawnChild() → current=attempt)
            // 跑在下面"先调 doStart、后赋 inFlightStart"**之间**;而 spawnChild 与
            // handshake 都是**注入**的代码(契约是 `() => ChildProcess` /
            // `(transport) => Promise`),它们完全可以在这一刻回调 start()。
            // 从这条缝里落进新一轮 doStart 的代价是:第二个进程被真的拉起来,
            // 而 current 只记得后造出来的那一个 —— 先造的那个成了 stop() 再也够不到的
            // 活进程(实测:一次重入之后机器上躺着两个子进程)。所以这里**拒绝**,
            // 一步也不许往前迈:这一次重入没有资格代表"要连上"。
            return Promise.reject(notReadyError(status(),
                '这次 start() 是在上一轮 start() 的同步段里重入进来的(状态已是 starting),不许再起一个进程'));
        }
        const p = doStart(opts);
        inFlightStart = p;
        // 落定后摘掉把手,免得把上一轮的结局递给下一轮。两个分支都接住,
        // 这样"没人接的自动重启"也不会漏成未处理拒绝(调用点另有 .catch)。
        const clear = () => { if (inFlightStart === p) inFlightStart = null; };
        p.then(clear, clear);
        return p;
    }

    /**
     * autoRestart=true 表示这一轮是**退避重启**拉起来的,不是用户按的。
     * @param {{autoRestart?: boolean}} [opts]
     */
    async function doStart({ autoRestart = false } = {}) {
        // ⚠️ 上一次 stop() 还没走完(还在等 exit / 2s 兜底)时**绝不许**起新进程:
        // 那次 stop() 醒来后会把状态写成 stopped,于是新进程明明活着、握手也完成、
        // stdin 还能写,status() 却报 stopped —— 而 stop() 此后走 current === null
        // 的早退,再没人停得掉它。所以这里拒掉这次 start(),而不是造出一个
        // 监护人自己不认识的活进程。(拒绝而不是返回 stopping 快照:见 notReadyError。)
        if (stopping) throw notReadyError(status(), '上一次 stop() 还没走完,现在不许起新进程');

        // 这一轮还没有进程(process 在下面才造出来),所以这次转换没有 pid 可说 —— 显式写 null。
        setState('starting', null, { pid: null });

        const id = ++generation;                // 这一轮的身份牌
        // 新进程:上一轮的稳定窗口作废(它到点会去改计数,而那属于别人)。
        // ⚠️ 必须挪到 spawnChild **之前**:工厂抛错时下面直接进 failed,没有"新进程"
        // 来顶替旧的稳定窗口,留着它到点就会去清另一轮的计数。
        clearStabilityTimer();

        let proc;
        try {
            proc = spawnChild();
        } catch (err) {
            // ⚠️ 工厂自己抛(包装层校验证书/路径,或者 spawn 直接 EPERM)时**必须**
            // 把状态落到 failed。留在 'starting' 不是"这次失败"而已 ——
            // start() 开头那道 state === 'starting' 的早退会把**之后每一次** start()
            // 都静默拒绝,监护人从此再也拉不起来,只有 stop() 解得开。
            // 另外:起不来不是"崩了",重启一百次也还是起不来(路径/权限/句柄耗尽),
            // 所以跟握手失败一样进 failed,不排退避。
            // 工厂抛错 = 根本没有进程被造出来,所以这次 failed 没有 pid。
            setState('failed', new Error(`Agent 子进程启动失败:${err?.message ?? err}`),
                { pid: null });
            throw notReadyError(status());
        }

        // ------------------------------------------------------------------
        // attempt = "这一轮"的全部家当。所有回调只碰**自己的**闭包:
        // 进程、分帧缓冲、两个解码器、握手把手、以及 data/exit 处理器。
        // 于是身份校验不必"每个回调都记得写"(那种要求迟早会被漏掉) ——
        // 上一轮进程迟到的字节只能写进上一轮自己的 buffer,污染不了这一轮。
        // ------------------------------------------------------------------
        const attempt = {
            id,
            proc,
            // 分帧状态属于这个进程:上一轮的半条消息、半个多字节字符都与它无关。
            buffer: '',
            // ⚠️ 不能写成 chunk.toString('utf8'):管道给的是**任意切分**的字节块,
            // 一个汉字被切成两半时,两半各自 toString 都会变成 U+FFFD ——
            // 它不抛错,只是**悄悄把消息文本弄坏**,而这个应用的载荷几乎全是中文。
            // StringDecoder 会把不完整的尾巴留到下一块再拼。
            stdoutDecoder: new StringDecoder('utf8'),
            // stderr 用**同一个 attempt 的**另一个解码器:日志同样几乎全是中文,
            // 逐块 String(d) 会把被切断的汉字解成 U+FFFD。
            stderrDecoder: new StringDecoder('utf8'),
            // stderr 的**按行**缓冲:和 stdout 一样,管道给的是任意切分的块,
            // 一条日志被切成两块时逐块 push 会变成两条日志 ——
            // logs() 的"最近 logRingSize 行"契约就废了。缓冲属于这一轮 attempt。
            stderrBuffer: '',
            // 在飞的握手(超时计时器 + 提前放行的把手)。stop() 和 onExit 都要能碰到它。
            handshake: { timer: null, settle: null, settled: false },
            // 握手期间对端在 stdout 上说过的原文(最多 20 条)——
            // 只在"握手失败"时才被读出来进报告,见 subprocessTail / traceStdout。
            handshakeTrace: [],
            /** 记一条握手期的 stdout 原文(有上限,免得一个话痨对端把内存吃掉)。 */
            traceStdout(line) {
                if (attempt.handshakeTrace.length >= 20) return;
                attempt.handshakeTrace.push(String(line));
            },

            /** 这一轮是否仍是"当前世代"。进程崩溃后 current 归 null,但世代不变。 */
            ownsGeneration() { return attempt.id === generation; },
            /** 这个进程本体是否仍被监护人跟踪(崩溃/停止后 current 归 null,即为假)。 */
            isCurrent() { return attempt.ownsGeneration() && current === attempt; },

            onStdout(chunk) {
                attempt.buffer += attempt.stdoutDecoder.write(chunk);
                const { lines, rest } = drainLines(attempt.buffer);
                attempt.buffer = rest;
                for (const line of lines) {
                    const msg = parseMessage(line);
                    if (msg === null) {
                        // 对端可能往 stdout 打了日志。记下来但别炸。
                        log.warn?.('[agent] stdout 上不是 JSON 的一行:' + line.slice(0, 200));
                        if (state === 'starting') attempt.traceStdout('[stdout 非 JSON] ' + line.slice(0, 300));
                        continue;
                    }
                    // ⚠️ **握手期间**收到的每一条协议消息也留一份原文:握手失败时最要紧的
                    // 一条信息就是"它到底答没答、答的是什么"。只压在**这一个 attempt** 上
                    // (不进 logs() 那个环 —— 那个环的契约是"最后 N 行 stderr"),
                    // 而且只在 'starting' 期间记,正常运行时一个字节都不多存。
                    if (state === 'starting') attempt.traceStdout('← ' + line.slice(0, 300));
                    // ⚠️ 这里**故意不做身份校验**:进程临死前最后几条消息仍要送到监听者
                    // 手里(丢掉它们就等于丢掉"最后一句话")。不被污染靠的是上面的
                    // per-attempt buffer,而不是在这里丢数据。
                    emit(msg);
                }
            },

            onStderr(chunk) {
                attempt.stderrBuffer += attempt.stderrDecoder.write(chunk);
                const { lines, rest } = drainLines(attempt.stderrBuffer);
                attempt.stderrBuffer = rest;
                for (const line of lines) {
                    pushLog(line);
                    log.warn?.('[agent] ' + line);
                }
            },

            /**
             * ChildProcess **自己**发的 'error':进程根本没起来(ENOENT/EACCES/EMFILE)。
             * 这是与 exit 并列的另一条"这一轮终了"的路,所以走同一套收场动作
             * (身份校验 → 清账 → setState),只是终态是 failed 而不是 crashed。
             */
            onSpawnError(err) {
                log.warn?.('[agent] 子进程 error:' + (err?.message ?? err));
                // 已经不在"启动中"了(ready/failed 之后)收到的 'error' 多半是
                // kill() 那类次生噪音:只留日志,不许再改写终态、也不许抹掉 current。
                if (!attempt.isCurrent() || state !== 'starting') return;
                current = null;
                clearStabilityTimer();
                // 让还在等握手的 start() 立刻收场,而不是空挂到握手超时。
                settleHandshake(attempt);
                killProcess(attempt.proc);      // 半成品进程:能收就收掉
                // 起不来**不是**"崩了":重启一百次还是起不来,所以走 failed,
                // 不排退避 —— 与握手失败同一个终态。
                // 这次转换说的是那个半成品进程:它虽然没起来,pid 也已经有了。
                setState('failed', new Error(`Agent 子进程启动失败:${err?.message ?? err}`),
                    { pid: attempt.proc?.pid ?? null });
            },

            onExit(code, signal) {
                // 进程没了,但它 stderr 缓冲里可能还压着**没有换行结尾**的最后一行 ——
                // 那往往正是崩溃原因。这一句必须在身份校验**之前**:
                // 迟到的 exit 也是这条进程的最后遗言。
                flushStderr(attempt);
                // ⚠️ 身份校验必须在清 current **之前**:迟到的 exit 属于上一轮的进程,
                // 无条件清空会把后来那一轮(B)从状态里抹掉 ——
                // B 明明还活着,却再没人认得它:transport.send 写进虚空,
                // stop() 又走 current === null 的早退 —— 那就是一个**孤儿进程**,
                // 正是这个任务存在的意义所要防的那种故障。
                if (!attempt.isCurrent()) return;
                current = null;
                // 进程没了,"稳定窗口"自然作废:留着它到点后会去清另一轮进程的计数。
                clearStabilityTimer();
                // 让可能还在等的 start() 立刻收场(它醒来后会看到身份已过期而放弃),
                // 而不是一直挂到握手超时。
                settleHandshake(attempt);
                // 用户按停带来的退出:'stopped' 说的是刚刚走掉的那个进程。
                if (stopping) {
                    setState('stopped', null, { pid: attempt.proc?.pid ?? null });
                    return;
                }
                // 已经是 failed 了,说明这次退出是**我们自己杀的**(握手失败后清理),
                // 不是"又崩了一次"。少了这一句,failed 会立刻被 crashed 覆盖并排一次重启,
                // 而握手失败多是凭证/版本问题 —— 重启一百次也一样(实测:真会重排)。
                if (state === 'failed') return;
                restarts += 1;
                // 崩溃通知必须点名**崩掉的那个进程**:它虽然已经死了,但这次转换
                // 说的就是它(终审 C1:'crashed' 曾经也带着一个投递时推出来的 null)。
                setState('crashed', new Error(`Agent 意外退出(code=${code} signal=${signal})`),
                    { pid: attempt.proc?.pid ?? null });
                scheduleRestart(attempt);
            },
        };

        current = attempt;

        proc.stdout?.on('data', attempt.onStdout);
        // stdin 也必须挂 'error':子进程在写入竞态里死掉时 write 会 EPIPE,
        // 而流上没有 'error' 监听器的话,未处理的 error 会变成**未捕获异常** ——
        // 在 Electron 主进程里那可能直接把整个应用带走。
        proc.stdin?.on('error', (err) => {
            log.warn?.('[agent] stdin 出错(子进程可能已经死了):' + (err?.message ?? err));
        });
        proc.stderr?.on('data', attempt.onStderr);
        // ChildProcess **本体**也要挂 'error':进程根本没起来(ENOENT/EACCES/EMFILE)时
        // Node 是往子进程对象上发 'error' 的。没有监听器的话它同样会变成未捕获异常 ——
        // 和上面 stdin 的 EPIPE 是同一类故障。走 attempt.onSpawnError 收场。
        proc.on('error', (err) => attempt.onSpawnError(err));
        proc.once('exit', (code, signal) => attempt.onExit(code, signal));

        // ⚠️ 超时计时器必须在**结束时**清掉,不能在创建后立刻清 ——
        // 曾经写成 `const t = setTimeout(...); clearTimeout(t);` 紧挨着两行,
        // 那等于超时永远不会触发,握手挂住时整个 start() 永远不返回。
        try {
            await Promise.race([
                Promise.resolve(handshake(transport)),
                new Promise((resolve, reject) => {
                    attempt.handshake.settle = resolve;
                    attempt.handshake.timer = timers.setTimeout(
                        () => reject(new Error(`握手超时(${handshakeTimeoutMs}ms)`)),
                        handshakeTimeoutMs,
                    );
                }),
            ]);
        } catch (err) {
            // 已经作废了(用户按了停 / 这个进程已退出 / 新一轮已经起来):别拿旧结论
            // 覆盖新状态。但这次 start() **自己**确实没就绪,所以必须失败,
            // 只是原因要说清是"被作废",而不是拿别人的状态名冒充自己的结论。
            if (!attempt.isCurrent()) {
                throw notReadyError(status(), '这次连接已经被 stop() 或新一轮 start() 作废');
            }
            // ⚠️ 失败原因必须带**子进程最后说了什么**(见 withSubprocessTail):
            // 「握手超时(20000ms)」这一句什么线索都没有 —— 上一次现场就是靠手工
            // 拼一条命令重放才查出方向的。子进程的 stderr 与握手期间收到的 stdout
            // 都在环形缓冲里,不花任何额外代价,一起打出来。
            const reason = withSubprocessTail(String(err?.message ?? err), attempt);
            // 握手失败就是失败,不要假装 ready —— 也不自动重启:
            // 这类失败通常是配置问题(凭证/版本),重启一百次也一样。
            killTree(proc.pid);
            killProcess(proc);
            // 这次失败说的是那个握不上手的进程 —— 我们刚把它杀掉,但 pid 依然是它的。
            setState('failed', new Error(reason), { pid: proc?.pid ?? null });
            throw notReadyError(status());
        } finally {
            // 无论谁赢,这个 attempt 的握手把手与超时计时器都到此为止。
            settleHandshake(attempt);
        }

        // 握手期间世界可能已经变了:用户按了停、或者这个进程已经退出了。
        // 这时候再写 ready 就是**在复活一个不存在的进程** —— 界面显示就绪、
        // pid 却是 null,而排好的那次重启会被 start() 开头的 ready 早退挡掉,
        // 于是监护人永远停在假就绪上,没有任何事件能纠正它。
        // 对这一次 start() 而言这意味着"没能连上",所以拒绝,而不是把
        // 一个死进程的快照当成成功交回去(终审 C2)。
        if (!attempt.isCurrent() || state !== 'starting') {
            throw notReadyError(status(), '握手完成时这个进程已经退出或被换掉了');
        }

        // ⚠️ 只有**用户手动**拉起才把计数清零。自动重启起来的这一轮如果又立刻崩,
        // 那仍然是"连续崩溃" —— 无条件清零会让 restarts 永远停在 0,
        // maxRestarts 这条熔断就永远不生效(实测:那样写假 agent 会无限重启下去)。
        if (!autoRestart) restarts = 0;
        setState('ready', null, { pid: proc?.pid ?? null });
        armStabilityTimer(attempt);             // 稳过 readyStabilityMs 才清零(见该函数)
        return status();
    }

    function killProcess(target) {
        try { target?.kill(); } catch { /* 已经死了 */ }
    }

    async function stop() {
        stopping = true;
        const token = ++stopToken;      // stopping 这面闸门归本次 stop() 管(见 stopToken 的声明)
        // ⚠️ 换一代身份牌:在飞的 start() 续段、上一轮进程的 exit、以及各种定时器
        // 由此全部作废。stop() 并不取消 start(),不这么做的话那个续段会在 stop() 之后
        // 把 stopping/stopped 覆盖成 ready 或 failed(后者最多要等一个握手超时)。
        generation += 1;
        const mine = generation;        // 本次 stop 的身份:中途若有人 start(),它就不再相等
        const dying = current;
        settleHandshake(dying);
        clearStabilityTimer();          // 停止后不许再有定时器偷偷改计数
        clearRestartTimer();

        if (dying === null) {
            // 没有活着的进程可停:这次转换确实没有 pid 可言,显式写 null。
            setState('stopped', null, { pid: null });
            stopping = false;
            return;
        }
        // 快照在**这里**就冻结:此刻 current 还是 dying,pid 就是用户要停的那个。
        setState('stopping', null, { pid: dying.proc?.pid ?? null });
        current = null;
        const pid = dying.proc.pid;

        await new Promise((resolve) => {
            // 这个兜底用**真实**定时器,不走注入的 timers:
            // 注入的那套只管退避策略,而这里纯粹是"杀不掉也不能永远挂着"的安全网。
            let fallback = null;
            const done = () => {
                if (fallback !== null) clearTimeout(fallback);
                resolve();
            };
            dying.proc.once('exit', done);
            fallback = setTimeout(done, 2000);
            killTree(pid);                  // 先杀整棵树
            killProcess(dying.proc);        // 再补一刀,防止 killTree 不生效
        });

        // ⚠️ 世代对账:本次 stop() 的结论只在"世界还是本次那个"时才允许生效。
        // 这条分支**是可达的**,不是"两重保险里的第二重"——并发的第二次 stop() 会
        // ++generation,而它走"没有活着的 attempt"的早退时会顺手把 stopping 清掉,
        // 于是调用方可以在第一次 stop() 还在等 exit(最长 2s 兜底)的时候 start();
        // 等第一次 stop() 终于醒来,世界已经是新那一代的了,它必须闭嘴 —— 否则会把
        // 一个活着、握过手、stdin 可写的新进程报成 stopped,而它从此再没人停得掉。
        if (generation !== mine) {
            // 但 stopping 也**不许**留成 true:那等于把 start() 永久焊死,
            // 而新一代的进程可能正活着(下一次 stop() 才解得开)。只在本次仍是
            // stopping 的主人才清 —— 若它已经被后一次 stop() 接管,擅自清掉就等于
            // 提前拆掉那次 stop() 的闸门(见 start() 开头那道闸的理由)。
            if (stopToken === token) stopping = false;
            return;
        }
        stopping = false;
        // ⚠️ 不要在这里清 logRing:环形缓冲的意义就是"崩了之后回看最后几十行",
        // 停止时清掉等于把证据销毁了。
        // 'stopped' 说的是**刚被停掉的那个进程**:current 早就摘了,pid 只在这里给得出。
        setState('stopped', null, { pid: pid ?? null });
    }

    return {
        start,
        stop,
        status,
        transport,
        logs: () => logRing.slice(),
        onMessage(fn) { messageListeners.add(fn); return () => messageListeners.delete(fn); },
        onStateChange(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    };
}
