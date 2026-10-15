// 右侧 AI 面板。
//
// 职责边界:
//   - 状态归约全在 app/lib/agent-stream.js(纯函数,可直测);这里只负责**画**。
//   - 笔记内容由外壳传入(getNote 注入函数)。面板**不 invoke 笔记频道** ——
//     笔记的路径守卫、当前笔记是谁,都是外壳的知识,面板不该知道。
//
// 两条安全规矩,对所有来自对端的内容都成立(消息正文、工具标题、错误原因):
//   1. 一律用 textContent,绝不 innerHTML 拼字符串 —— `<img onerror=...>` 必须
//      原样显示成文字(设计 §6.6)。
//   2. 绝不显示任何密钥值。凭证频道本身就只有 { ok, source, reason } 三个叶子字段,
//      界面上再拼一遍密钥是没机会的 —— 这条是结构上保证的。
//
// 无障碍:状态变化由一个 aria-live="polite" 的容器承载;纯图标/紧凑按钮都带 aria-label。
import {
    applyVideoProgress, beginPrompt, beginVideoStages, buildPromptText, describeNoteContext,
    estimateFirstTokenMs, failedVideoStage, finishVideoStages, initialStreamState,
    lastActiveStage, needsCredentialAttention, reduceAgentEvent, resolvePermission, stageDetailText,
    videoStageLabel,
} from '../lib/agent-stream.js';
// 黏贴截图:判据(类型白名单 / 单张与总量上限 / 那一句中文原因)只有一份 ——
// 渲染层用同一份做**即时反馈**,主进程用同一份做**权威校验**。
import { validateImageCandidate, imagePromptFailureHint, imageCapabilityRefusal, stripIpcWrapper } from '../lib/agent-image.js';
import {
    MODEL_CONFIG_ID, REASONING_CONFIG_ID, chipLabel, configOptionOf, effortIndexOf,
    effortLevels, modelGroups,
} from '../lib/agent-config.js';
// 视频理解:同样只有一份判据(容器白名单 / 单段上限 / 体积→内联还是上传的分发),
// 渲染层拿它做即时反馈,主进程拿它做权威校验。音频说明也从这里来 ——
// 那句"听不到声音"必须与 provider 写的是同一句,不能各写一遍。
import {
    DEFAULT_VIDEO_QUESTION, MAX_LOCAL_VIDEO_BYTES, VIDEO_AUDIO_NOTICE, chooseDelivery,
    describeVideoKeyStatus, formatBytes, validateVideoCandidate, videoSniffVerdict,
} from '../lib/agent-video.js';
// Markdown 走**建节点**那一版渲染器:面板的规矩是"绝不 innerHTML 拼字符串",而这里的
// 内容来自模型。同一条解析也喂着笔记预览(那边出 HTML 字符串),规则只有一份。
import { renderMarkdownNodes } from '../lib/markdown.js';
// 「接着聊」:对端**不重放旧消息**,所以历史由开物自己的台账铺回来 ——
// 记录 → 步骤(用户消息 / 归约事件)那一层是纯函数,单测钉着(会话记录格式也在那里)。
import { recordToSteps } from '../lib/session-record.js';
// 会话轮次导航轨(方案 D:状态语义轨)。"哪几轮 / 每轮什么状态 / 当前第几轮 / 摘要写什么"
// 全是纯函数住在 lib 里(能 node --test),这里只负责画与联动。
import {
    RAIL_LEGEND, currentTurnIndex, groupTurns, liveTurnIndex, summarizeTurn, tickAriaLabel,
    turnQuestion, turnStatus, turnTimings, wheelScrollDelta,
} from '../lib/agent-rail.js';
// 那颗球(发送/取消合一按钮)的纯逻辑:四类注视来源的**优先级**、方向命名、眼睛幅度、
// 平滑系数、以及"一个变化值不值得看"。判据只有一份 —— 数字放这里才能不进 DOM 就单测。
import {
    CARET_GAP, EDIT_HOLD_MS, FACE, IDLE_MS, LOW_GAZE, NEAR, NOTICE_GAP, NOTICE_MS, TEAR_SLICES,
    dirLabel, ease, gazeScale, glanceVerdict, maxOffset, pickSource, toward, towardMouse,
} from '../lib/robot-face.js';

const STATE_LABEL = {
    stopped: '未连接',
    starting: '连接中…',
    ready: '已连接',
    stopping: '正在停止…',
    failed: '连接失败',
    crashed: '已断开(Agent 崩溃)',
};

/**
 * 四段状态行的标记。**深浅不够明确**(与下载队列那边同一个理由),所以每行都有一个
 * 字符级标记:没到的 `·`、正在做的 `▸`、做完的 `✓`、断在这里的 `✕`。
 * 全是纯文本,读屏也能读出区别(再配 aria-label / data-state)。
 */
const STAGE_MARK = Object.freeze({
    idle: '·', doing: '▸', done: '✓', failed: '✕',
});

/** 配置指引。在凭证卡片里与"为什么用不了"并列显示 —— 只说怎么配,不涉及值。 */
const CREDENTIAL_HOWTO =
    '两种配法任选一种:① 设置环境变量 DEEPSEEK_API_KEY 后再启动开物;'
    + '② 把密钥写进 DSH 的凭证文件 .credentials.yaml 的 deepseek.apiKey。'
    + '开物自己不存密钥,也不会把密钥读进界面。';

const TOOL_STATUS_LABEL = {
    pending: '等待中',
    in_progress: '进行中',
    running: '进行中',
    completed: '完成',
    failed: '失败',
    error: '失败',
    cancelled: '已取消',
};

/** 工具卡片上的状态徽标文字。未知状态原样显示,不猜。 */
export function toolStatusLabel(status) {
    const s = String(status ?? '').trim();
    if (s === '') return '未知';
    return TOOL_STATUS_LABEL[s] ?? s;
}

/** 元素工厂:全部走 createElement + textContent。 */
function el(doc, tag, className = '', text = null) {
    const node = doc.createElement(tag);
    if (className !== '') node.className = className;
    if (text !== null) node.textContent = String(text);
    return node;
}

/** 对端给的数组字段一律当"可能不是数组"处理(状态替身/旧快照都可能有)。 */
function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function replaceChildren(node, children) {
    if (typeof node.replaceChildren === 'function') {
        node.replaceChildren(...children);
        return;
    }
    while (node.firstChild) node.removeChild(node.firstChild);
    for (const child of children) node.appendChild(child);
}

function setDisabled(node, disabled) {
    if (node) node.disabled = Boolean(disabled);
}

/**
 * 显隐一个节点。
 *
 * 用 `hidden`(而不是 class 或 display):它是**语义**上的"现在没有这个按钮",
 * 读屏与 Tab 序列都会跟着让开 —— 一个"平时不存在、出事才出现"的按钮必须是这个语义。
 * 测试里的 DOM 替身只有属性,`node.hidden = true` 就够了(与 setDisabled 同一个理由)。
 */
function setHidden(node, hidden) {
    if (node) node.hidden = Boolean(hidden);
}

/**
 * 取一个后代节点。
 *
 * 真 DOM 走 `querySelector`(标准做法);测试里的 DOM 替身只实现了 `query`
 * (名字不同、语义一样)—— 与 replaceChildren / setClass 那几处同一个理由:
 * 面板要在替身里也能跑,否则所有 DOM 单测都得先造一个假的 querySelector。
 */
function pick(node, selector) {
    if (!node) return null;
    if (typeof node.querySelector === 'function') return node.querySelector(selector);
    if (typeof node.query === 'function') return node.query(selector);
    return null;
}

function setAria(node, name, value) {
    if (node && typeof node.setAttribute === 'function') node.setAttribute(name, String(value));
}

/**
 * 加/去一个 class。
 *
 * 真 DOM 上走 `classList`(这是标准做法);测试里的 DOM 替身只有 `className`,
 * 所以留一条等价的回退 —— 与 replaceChildren / setDisabled 那几处同一个理由:
 * 面板要在替身里也能跑,否则所有 DOM 单测都得先造一个假的 classList。
 */
function setClass(node, name, open) {
    if (!node) return;
    const list = node.classList;
    if (list !== null && list !== undefined && typeof list.toggle === 'function') {
        list.toggle(name, open === true);
        return;
    }
    const parts = String(node.className ?? '').split(/\s+/).filter(part => part !== '');
    const has = parts.includes(name);
    if (open === true && !has) parts.push(name);
    if (open !== true && has) parts.splice(parts.indexOf(name), 1);
    node.className = parts.join(' ');
}

/** 把钩子包成"不抛"的调用:面板不该因为一个可选订阅不存在就整块不工作。 */
function safe(fn, log) {
    try {
        if (typeof fn === 'function') fn();
    } catch (err) {
        log?.warn?.('[agent] 订阅失败', err);
    }
}

/**
 * 把剪贴板里那张 File 读成字节(Uint8Array);读不出来返回 null。
 *
 * 走 `Blob.arrayBuffer()`(现代 Chromium 一定有),FileReader 只是兜底 ——
 * 这条路的返回要跨 IPC,所以返回**二进制**而不是 base64:结构化克隆传
 * Uint8Array 是一次拷贝,base64 会白涨 33%,一张 5 MB 的截图就差出一趟。
 */
async function readFileBytes(file) {
    if (file === null || file === undefined) return null;
    if (typeof file.arrayBuffer === 'function') {
        const buf = await file.arrayBuffer();
        if (buf === null || buf === undefined) return null;
        if (typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer) {
            return new Uint8Array(buf);
        }
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(buf)) {
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        return null;
    }
    const Reader = globalThis.FileReader;
    if (typeof Reader !== 'function') return null;
    return await new Promise((resolve) => {
        const reader = new Reader();
        reader.onerror = () => resolve(null);
        reader.onload = () => {
            const result = reader.result;
            if (typeof ArrayBuffer !== 'undefined' && result instanceof ArrayBuffer) {
                resolve(new Uint8Array(result));
                return;
            }
            resolve(null);
        };
        reader.readAsArrayBuffer(file);
    });
}

// ---------- 纯渲染 ----------

/** 消息流节点的描述(只读 state,不碰任何 DOM),便于直测。 */
export function renderMessageStream(state) {
    const s = (state !== null && typeof state === 'object') ? state : initialStreamState();
    return s.messages.map(m => ({ role: m.role, text: m.text, done: m.done }));
}

/**
 * 按状态里的**有序时间线**(`order`)取回三类实体。
 *
 * 为什么要有这一层:状态把消息 / 思考 / 工具存成三个**平行数组**,先后信息只存在于
 * `order` 里(见 app/lib/agent-stream.js)。这里把它还原成一条真正的序列。
 *
 * ⚠️ `order` 里没提到的条目一律**补在最后**,不许丢:旧快照、或者将来加了新类型而
 * 忘了记键时,代价必须是"排得难看",绝不能是"内容在界面上消失"。
 */
function timelineOf(s) {
    const byKey = new Map();
    for (const m of asArray(s.messages)) byKey.set(`msg:${m.id}`, { kind: 'message', message: m });
    for (const t of asArray(s.thoughts)) byKey.set(`think:${t.id}`, { kind: 'thought', thought: t });
    for (const t of asArray(s.tools)) byKey.set(`tool:${t.toolCallId}`, { kind: 'tool', tool: t });

    const out = [];
    const used = new Set();
    for (const key of asArray(s.order)) {
        const item = byKey.get(key);
        if (item === undefined || used.has(key)) continue;
        used.add(key);
        out.push(item);
    }
    for (const [key, item] of byKey) {
        if (!used.has(key)) out.push(item);
    }
    return out;
}

/**
 * 把时间线切成**渲染单元**(纯函数,便于直测)。排布规则:
 *
 *   1. 思考:原样内联 —— 每一条都排在它那段输出前面,不合并也不置顶;
 *   2. 工具卡与**中间**回复:收进一个可折叠的组(DSH 图二那行「N 次工具调用 ›」);
 *   3. 一**段**里最后那条 assistant 回复留在组外 —— 答案不能被折起来;
 *   4. 用户消息是分段的界,自己永不进组。
 *
 * 「一段」= 两次用户消息之间。拿用户消息当界、而不是另立一个"轮次"状态,是因为它本来
 * 就在时间线上,而且是唯一权威的分界(主进程不需要额外告诉我们轮次)。
 *
 * 边界情形:一段里还没有任何 assistant 回复时(工具正在跑),工具**立刻**就是一组 ——
 * 用户看到的是「N 次工具调用 · 运行中」,而不是一屏零散的卡片。
 */
export function planTimeline(state) {
    const s = (state !== null && typeof state === 'object') ? state : initialStreamState();
    const units = [];
    let segment = [];

    const flushSegment = () => {
        if (segment.length === 0) return;
        // 这一轮**结束了吗**:结束之后才做"答案必须看得见"那两条兜底 ——
        // 正在跑的时候后面还会来东西,别急着下结论。
        const ended = s.busy !== true;
        // 这一段里**最后**一条 assistant 回复:留在组外(它就是这一轮的答案)
        let lastReply = -1;
        for (let i = segment.length - 1; i >= 0; i--) {
            if (segment[i].kind === 'message' && segment[i].message.role === 'assistant') { lastReply = i; break; }
        }
        const foldable = new Set();
        segment.forEach((item, i) => {
            if (item.kind === 'tool') foldable.add(i);
            else if (item.kind === 'message' && item.message.role === 'assistant' && i !== lastReply) foldable.add(i);
        });

        let i = 0;
        while (i < segment.length) {
            if (!foldable.has(i)) {
                units.push(segment[i]);
                i += 1;
                continue;
            }
            const tools = [];
            const messages = [];
            while (i < segment.length && foldable.has(i)) {
                if (segment[i].kind === 'tool') tools.push(segment[i].tool);
                else messages.push(segment[i].message);
                i += 1;
            }
            units.push({ kind: 'group', tools, messages, live: tools.some(isToolRunning) });
        }

        // ⚠️ 两条"答案必须看得见"的兜底(实测量出来的):
        //   用户看到的是一屏折叠条 + 一条回复都没有,以为"消息丢了"。真相是那一轮
        //   模型**一路调工具 + 思考就收尾了**,一个字正文都没写 —— 而界面对此完全沉默。
        //   沉默才是问题:下面这两条让"答案在哪、有没有"永远有个明说。
        if (ended) {
            const replies = segment.filter((it) => it.kind === 'message' && it.message.role === 'assistant');
            if (replies.length === 0) {
                // ① 整轮没有正文 → 明确写一行(否则用户只能猜)
                units.push({
                    kind: 'noReply',
                    tools: segment.filter((it) => it.kind === 'tool').length,
                    thoughts: segment.filter((it) => it.kind === 'thought').length,
                });
            } else {
                // ② 最后那条回复被折进了组里(组外没有回复)→ 那一组**默认展开**,
                //    否则答案就藏在一个收起来的「N 次工具调用」后面(同样看不见答案)。
                const last = units[units.length - 1];
                if (last !== undefined && last.kind === 'group' && last.messages.length > 0 && last.live !== true) {
                    last.defaultOpen = true;
                }
            }
        }
        segment = [];
    };

    for (const item of timelineOf(s)) {
        if (item.kind === 'message' && item.message.role === 'user') {
            flushSegment();          // 用户开口 = 上一段到此为止
            units.push(item);
            continue;
        }
        segment.push(item);
    }
    flushSegment();
    return units;
}

/** 工具还在跑吗。没跑完的状态名不写死一套白名单,只认"结束态"这三种。 */
function isToolRunning(tool) {
    const status = String(tool?.status ?? '');
    return status !== 'completed' && status !== 'failed' && status !== 'error' && status !== 'cancelled';
}

/** 从渲染单元里挑出"还在长"的那两条(思考 / 正文),快速通道要原地改它们。 */
function liveOf(units) {
    let thought = null;
    let message = null;
    let stages = null;
    for (const unit of units) {
        if (unit.kind === 'thought' && unit.thought.done !== true) thought = unit.thought;
        if (unit.kind === 'message' && unit.message.role === 'assistant'
            && unit.message.done !== true) {
            message = unit.message;
            if (Array.isArray(unit.message.stages) && unit.message.stages.length > 0) stages = unit.message.stages;
        }
    }
    return { thought, message, stages };
}

/** 一个折叠组的稳定键:拿第一张工具卡的 id(没有工具就拿第一条消息的 id)。
 *  它必须**跨重画稳定**,否则用户展开过的组会在下一次重画时又合上。 */
function groupKeyOf(unit) {
    if (unit.tools.length > 0) return `tool:${unit.tools[0].toolCallId}`;
    if (unit.messages.length > 0) return `msg:${unit.messages[0].id}`;
    return 'group:empty';
}

/** 摘要行右边那串工具名(去重后带 ×N)。工具名来自对端,只当文字。 */
function toolNamesOf(tools) {
    const counts = new Map();
    for (const tool of tools) {
        const name = String(tool?.title ?? '').trim();
        if (name === '') continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(' · ');
}

// ---------- 主入口 ----------

/**
 * @param {object} deps
 * @param {object} deps.els       现成元素(见 index.html 的 #agentPanel 骨架)
 * @param {object} deps.bridge    外壳的 IPC 桥:{ invoke, onAgentEvent? }
 * @param {object} [deps.log]     日志口(默认 console)
 * @param {() => ({title:string, path:string, text:string}|null)} [deps.getNote]
 *        当前笔记;返回 null 表示没有打开笔记(此时只发问题本身)
 * @param {boolean} [deps.autoStart] 挂载后是否自动连一次。
 *        true(默认)= 产品行为「打开就是对话」;false = 不自动连,
 *        #agentRetry 成为显式入口(自检走这条 —— 自检**绝不能**自动拉起真的 dsh)。
 */
export function createAgentPanel({
    els = {}, bridge, log = console, getNote = () => null, autoStart = true,
} = {}) {
    const doc = els.panel?.ownerDocument ?? globalThis.document;
    const {
        panel, statusEl, retryBtn, messagesEl, inputEl, sendBtn, credentialEl, killBtn = null,
        // 思考强度 / 模型那枚胶囊(与它外面那层锚点)。**可选**:旧外壳/测试替身没有它时,
        // 面板照常工作 —— 只是没有这一枚控件(与 killBtn 同一条规矩)。
        configBtn = null, configWrap = null,
    } = els;

    let state = initialStreamState();
    let renderQueued = false;
    let credentials = null;
    let started = false;              // 挂载时自动 start 只做一次(重试走按钮)
    let starting = false;             // start() 在飞,防连点
    let killRequested = false;        // 刚按过「停止进程」:提示卡要留一个「重试」出口(见 killProcess)
    let footerEl = null;              // 输入区那张卡片(机器可读的 data-ctx 挂在它上面)
    let noticeEl = null;              // 连接失败时对话里那张提示卡(懒建)
    // 思考条与工具摘要行的"用户展开过"状态按 id / 组键记(不再是一个全局布尔:现在
    // 思考一轮一条、摘要行一组一个,全局布尔会让用户展开的那条被别条的重画带合上)。
    // 三份记录都定义在下面的渲染缓存旁边(thinkOpenIds / thinkDoneSeen / groupOpenIds)。
    // 已经回答过的权限请求。对端每个 requestId 只等一个回答,重发会串线。
    const answered = new Set();

    // ---------- 黏贴截图:待发图片 ----------
    //
    // 每一条是 { id, mimeType, name, byteLength, file, thumbUrl }。
    // 这里存着**活的 File 对象**,是渲染进程自己的东西,不跨 IPC —— 送到主进程的
    // 只有 `{ mimeType, bytes }` 两个叶子字段(见 send 里那一段)。
    // 缩略图 URL 必须记着,删/发/释放时要 revoke,否则一张图一条永不回收的 blob。
    let pendingImages = [];
    let nextImageId = 1;
    let imageRowEl = null;        // chips 那一行(空时整行隐藏)
    let imageNoticeEl = null;     // 被拒的原因(可读中文),像凭证卡片那样**明说**

    // ---------- 视频理解:待发送的视频草稿 ----------
    //
    // 一段视频拖进来/粘进来,只是变成输入区里的一份**草稿** —— 与图片那套
    // (pendingImages)完全同一个立场:草稿阶段一次 IPC 都不发、更不碰网络。
    // 用户按下「发送」之后才读字节、才调 `video:understand`,那一次是要花钱的。
    //
    // 一次只放**一段**(服务端一次也只听一段):要问第二段就先把草稿移除。
    // 这里存着活的 File 对象(渲染进程自己的东西),送进主进程的只有
    // `{ mimeType, bytes, name, question }` 四个叶子字段。
    let pendingVideo = null;      // { id, mimeType, name, byteLength, file } —— 只是**草稿**
    let videoRowEl = null;        // 草稿卡片行(没有草稿时整行隐藏)
    let videoNoticeEl = null;     // 被拒/失败的原因(可读中文)
    // ---- 密钥那张卡(懒建;卡片上的四块内容分开写,理由见 ensureVideoKeyRow)----
    let videoKeyRowEl = null;     // 卡片本体
    let videoKeyStatusEl = null;  // 状态读数:未配 / 已配(来源,存法)
    let videoKeyWarnEl = null;    // 警告:环境变量赢的时候那句"在这里保存不会生效"
    let videoKeyDetailEl = null;  // 细节:明文存储的后果
    let videoKeyResultEl = null;  // 操作反馈:刚才那次保存/清除成没成
    let videoInfo = null;         // video:status 的结果(全是叶子字段,不含密钥值)
    let videoBusy = false;        // 一次理解在飞:防连点、防重入
    let ctxRowEl = null;          // 输入卡片顶端那一行(平时 hidden,只在"连接中/有东西可停"时出现)
    let ctxHintEl = null;         // 那一行里那句「正在连接 Agent…」(只在 connecting 时写出来)

    // ---------- 方案 C:四段状态行的**本地**那几样 ----------
    //
    // 三样东西刻意**不进 state**:①requestId 是这一次调用的身份(状态是"界面是什么样",
    // 不是"IPC 事务表");②等待起点是本地时钟(把它塞进可序列化状态只会让快照用例
    // 多一个一直在变的字段);③计时器与订阅句柄是**活的资源**,必须在 dispose 里收干净。
    let videoRequestId = '';      // 这一次理解的 requestId(推来的事件按它过滤)
    let videoRequestSeq = 0;      // 只为了给出互不相同的 id
    let waitStartedAt = 0;        // 「等待首个字」开始那一刻(本地时钟,0 = 没在等)
    let stageTicker = null;       // 等待期间的秒表(setInterval)
    let stageEstimateText = '';   // 标定给出的"首字通常多久";不可信时就是空串
    let stageEstimateTitle = '';  // 那句话的出处(鼠标悬停可看):几个样本、各自怎么来的
    let videoProgressUnsub = null; // video:event 的取消订阅函数

    // ---------- 黏贴截图:blob: URL 的归属 ----------
    //
    // 一条 blob: URL 只有一个主人,换了主人就要**说清楚**(这是这类改动最容易踩的坑:
    // 发送时顺手 revoke,气泡里就是一张破图 —— 不报错,只画一个碎图标)。
    //   ① 创建与撤销权在输入区:pendingImages 里那条 entry 的 thumbUrl 归 chip,
    //      删除(removeImage)/ 清空(clearImages)/ dispose 时撤销。
    //   ② 发送的那一刻**移交**给消息气泡:`handOffImages()` 把 URL 登记进
    //      messageImageUrls,并把 entry.thumbUrl 置空 —— chip 侧从此不再认识它,
    //      随后那次 `clearImages()` 不会碰到它。
    //   ③ 气泡侧只在**这条消息不再存在**时撤销:dispose(全撤),或者某次重画时
    //      状态里已经没有引用它的消息(清空会话 / 换会话)—— 见 releaseMessageImages。
    // 反过来说:**只要消息还在状态里,就绝不许撤销它**。
    const messageImageUrls = new Set();

    const calls = (channel, payload) => {
        if (!bridge || typeof bridge.invoke !== 'function') {
            return Promise.reject(new Error(`IPC 桥不可用,无法调用 ${channel}`));
        }
        return bridge.invoke(channel, payload);
    };

    // ---------- 骨架:状态区 / 消息流 / 权限卡 / 凭证卡 / 输入区 ----------
    //
    // 状态区与输入区在 index.html 里已经带了按钮(#agentRetry / #agentKill /
    // #agentInput / #agentSend —— 发送与取消已经合成**一颗球**,见下面的 ensureOrb),
    // 所以这里只**补齐**缺的部分:
    // 状态文字插在最前面(按钮留在后面),输入框与球若已经存在就不再造一个。
    // 这样同一份代码在真外壳与"只有几个空 div"的替身里都能跑。

    const stateText = el(doc, 'span', 'agent-state-text');
    const stateDetail = el(doc, 'span', 'agent-state-error');
    if (statusEl) {
        if (typeof statusEl.insertBefore === 'function') {
            statusEl.insertBefore(stateDetail, statusEl.firstChild ?? null);
            statusEl.insertBefore(stateText, statusEl.firstChild ?? null);
        } else {
            replaceChildren(statusEl, [stateText, stateDetail]);
        }
    }

    const streamEl = el(doc, 'div', 'agent-stream');
    const permsEl = el(doc, 'div', 'agent-perms');
    // 消息区里那一列(steam + 权限卡)包一层:右侧要给轮次轨让出 34px,而滚动仍然由
    // `.agent-messages` 自己承担(**不换滚动容器** —— 换掉的话面板里所有
    // scrollTop/scrollHeight 的读写口径都要跟着改,而那是既有行为)。
    const scrollContentEl = el(doc, 'div', 'agent-scroll-content');
    // 会话轮次导航轨(方案 D)。⚠️ 它是**滚动区的孩子**并靠 sticky 钉在右上角 ——
    // 这样"滚轮落在轨上"时浏览器本来就会滚消息区(轨在滚动容器里),我们又显式转发一次
    // (见 onRailWheel),两条路都通。
    const railEl = el(doc, 'div', 'agent-rail');
    railEl.hidden = true;                    // 少于 2 轮时整条隐藏(一轮没有导航价值)

    // 轮次轨的状态(闭包内;与 DOM 同寿命)。turnEls/turnOffsets 由 measureRail 每次重画后刷新。
    let railTicks = [];          // 每格的 <button>
    let railModels = [];         // 每格的模型(纯函数算出来的:问题/状态/耗时)
    let railKey = '';            // 结构指纹:格数 / 状态 / 生成中变了才重建格子
    let railCurrent = -1;        // 当前轮(滚动联动算出来;常显高亮)
    let railLive = -1;           // 正在生成的那一轮(-1 = 没有)
    let railNewIndex = -1;       // 刚入场的那一格(加一个短促的入场动效)
    let railSeenCount = 0;       // 上一版的轮数(判断"新轮进场")
    let railFramePending = false; // 一帧里只量一次
    let railTip = null;          // 悬停/聚焦摘要(挂在面板上,不在滚动区里)
    let turnEls = [];            // 每一轮的盒子(.agent-turn)
    let turnOffsets = [];        // 预计算的 offsetTop(滚动回调里**不读 layout**)

    if (credentialEl) {
        credentialEl.hidden = true;
        const head = el(doc, 'strong', '', '凭证未就绪');
        const reason = el(doc, 'p', 'agent-cred-reason', '');
        const howto = el(doc, 'p', 'agent-cred-howto', CREDENTIAL_HOWTO);
        replaceChildren(credentialEl, [head, reason, howto]);
    }

    // 输入区是**多行**的(方案 ③):随内容长高、Enter 发送、Shift+Enter 换行。替身没给就用 textarea 造一个。
    const input = inputEl ?? el(doc, 'textarea');
    if (input.tagName === 'TEXTAREA' && typeof input.getAttribute === 'function' && input.getAttribute('rows') === null) {
        input.setAttribute('rows', '1');
    }
    if (input.tagName === 'INPUT' && input.type === '') input.type = 'text';
    if (typeof input.getAttribute === 'function' && input.getAttribute('aria-label') === null) {
        // ⚠️ 动作行里那句「回车发送」的**可见**文本已按用户要求删掉;这条信息改走非视觉出口,
        // 而且两条一起给:标签里带上它(每个读屏都会念),再用 aria-keyshortcuts 声明那个键
        // (标准字段,支持它的读屏会把它当成"激活方式"播报)。
        // 真外壳的 #agentInput 在 index.html 里已经写好了这两条,所以这里只在"输入框是我们
        // 现场造的"(替身 / 老外壳)时才补 —— 与下面 placeholder 那一段同一条规矩。
        setAria(input, 'aria-label', '对 AI 提问(回车发送)');
    }
    if (typeof input.getAttribute === 'function' && input.getAttribute('aria-keyshortcuts') === null) {
        setAria(input, 'aria-keyshortcuts', 'Enter');
    }
    // ⚠️ 这里**不再补任何 placeholder**(用户要求输入区没有任何可见引导文字)。

    // ⚠️ 卡片顶端那一行现在**什么都不常驻**(用户要求:密钥按钮、停止按钮、上下文文字、
    // 最后连那个状态点也删掉了)。这一行只剩一个用途:Agent 不正常时「停止进程」的落点 ——
    // 平时整行 `hidden`(不占高度、不占间距),所以聊天框上面是干净的。
    // 上下文信息不丢,改挂在**输入框**上(placeholder 短句 + title 全句,见 renderContext)。
    // 所以这里不再建任何节点,只在渲染时把那一行按需显隐(见 renderStatus)。

    // ================= 那颗球:发送/取消合成一颗 =================
    //
    // 用户拍板:动作行里原来的「发送」「取消」**两个按钮合成一颗球** ——
    // 空闲=发送、执行中=取消(点一下分别走 send() / cancel())。
    // 外观就是这只只有眼睛的小机器人(**不要极光**:那是另一个 demo 的方向)。
    // 它的"看哪儿"有四类来源,优先级只有一处定义(app/lib/robot-face.js 的 pickSource):
    //   ① 鼠标进到 110px 内 → 盯鼠标;② 鼠标 1.6s 不动 → 松开,四处看;
    //   ③ 用户正在写笔记 → 看**编辑点**(光标);④ 消息流出现变化 → 看变化处;都没有 → 四处看。
    //
    // ⚠️ 反自反馈:这颗球自己每帧写 transform、眨眼改 class、状态字改写 #agentStatus ——
    //    这些**都落在 MutationObserver 的观察范围内**(观察器一旦给自己发消息,它就会
    //    永远"看着自己"动)。所以下面有一张排除表 GAZE_IGNORE,写的是**真身的实际节点名**;
    //    以后改节点名,这张表和自检里的"安静 5 秒"要跟着一起看。
    const ORB_NS = 'http://www.w3.org/2000/svg';
    /** SVG 元素必须用 createElementNS 造,否则真 DOM 里它不在 SVG 命名空间、根本画不出来;
     *  替身(测试桩)没有这个 API,退回 createElement —— 那边只用来查结构,不需要真的渲染。 */
    const svgEl = (name) => (typeof doc?.createElementNS === 'function'
        ? doc.createElementNS(ORB_NS, name)
        : el(doc, name));
    const attr = (node, k, v) => { if (node && typeof node.setAttribute === 'function') node.setAttribute(k, v); };
    // ⚠️ class 一律用模块级那个 setClass(node, name, open):它已经处理了
    // "真 DOM 走 classList / 替身只有 className" 这条差异(见文件开头)。SVG 元素也有 classList,
    // 所以同一个helper 对 HTML 与 SVG 都成立 —— 别再写第二个同名函数把它遮住(那会让三参数调用静默走错)。
    let orbBody = null, orbLook = null, orbEyes = [];
    /** 球径:44px。⑥ 机灵那一组数就是按 44 算出来的(眼睛 4.95px / 身体 2.23px),别改。 */
    const ORB_SIZE = 44;

    if (sendBtn) {
        if (typeof sendBtn.getAttribute === 'function' && sendBtn.getAttribute('aria-label') === null) {
            setAria(sendBtn, 'aria-label', '发送');
        }
        // ⚠️ 球里**没有文字**:文案一律走 aria-label / title(它是纯图形按钮)。
        //    旧「发送」「取消」两个按钮的可见文字随之消失,语义一个字都没少。
        if (sendBtn.textContent !== '') sendBtn.textContent = '';
        ensureOrb();
    }
    if (retryBtn) {
        if (typeof retryBtn.getAttribute === 'function' && retryBtn.getAttribute('aria-label') === null) {
            setAria(retryBtn, 'aria-label', '重试连接');
        }
        if (retryBtn.textContent === '') retryBtn.textContent = '重试';
    }
    if (killBtn) {
        if (typeof killBtn.getAttribute === 'function' && killBtn.getAttribute('aria-label') === null) {
            setAria(killBtn, 'aria-label', '停止 Agent 进程');
        }
        if (killBtn.textContent === '') killBtn.textContent = '停止进程';
    }

    const inputRow = el(doc, 'div', 'agent-input-row');
    if (input.parentNode === null) inputRow.appendChild(input);
    for (const b of [sendBtn]) {
        if (b && b.parentNode === null) inputRow.appendChild(b);
    }

    if (messagesEl) {
        replaceChildren(scrollContentEl, [streamEl, permsEl]);
        replaceChildren(messagesEl, [scrollContentEl, railEl]);
        // 轮次轨要有一个可访问的名字与说明:颜色编码不解释就等于没编码。
        setAria(railEl, 'aria-label', RAIL_LEGEND);
        setAria(railEl, 'role', 'navigation');
        // ⚠️ 键盘滚动的前提是**这个区域能拿到焦点**:原生滚动条被隐藏之后,滚轮仍然靠
        // 指针位置生效,但 PageUp/PageDown/Home/End 需要一个被聚焦的滚动容器。
        // tabindex=0 把它放进 Tab 序列(消息区本来就是一个可独立浏览的区域)。
        if (typeof messagesEl.getAttribute === 'function' && messagesEl.getAttribute('tabindex') === null) {
            setAria(messagesEl, 'tabindex', '0');
            setAria(messagesEl, 'aria-label', '对话消息(可滚动)');
        }
        // 滚动联动:回调里只排一帧(见 onMessagesScroll 的注释)
        if (typeof messagesEl.addEventListener === 'function') {
            messagesEl.addEventListener('scroll', onMessagesScroll, { passive: true });
        }
        // 轨上的滚轮转发(**不** passive:要 preventDefault 才不会和浏览器各滚一次)
        if (typeof railEl.addEventListener === 'function') {
            railEl.addEventListener('wheel', onRailWheel, { passive: false });
        }
        // 尺寸变化要重新量 offset(窄了/换行变了,轮次的位置就变了)
        if (typeof globalThis.addEventListener === 'function') {
            globalThis.addEventListener('resize', onPanelResize);
        }

        // ⚠️ 输入区是**消息滚动区的兄弟**,不是它的孩子。
        // 挂进去(旧实现就是这么做的)它就跟着消息一起滚:实测面板 456px、消息区撑满到 406px,
        // 而输入栏落在 409–466 —— 消息一多、往上翻历史,输入栏就滚出视野,
        // 用户得先滚到底才能插一句话。
        //
        // 真外壳里那个 footer 本来就在 #agentPanel 下(与 #agentMessages 同级),
        // 这里只管"如果它在别处就搬回来";测试替身没有 footer 时,现场按卡片结构造一个。
        const existingFooter = (input.parentNode !== null) ? findFooter(input) : null;
        const footer = existingFooter ?? el(doc, 'footer', 'agent-footer');
        if (existingFooter === null) {
            // 现场造一个空的骨架时也要有那一行:它是「正在连接…」与「停止进程」的落点(平时 hidden)
            const row = el(doc, 'div', 'agent-ctx-row');
            row.hidden = true;
            row.appendChild(el(doc, 'span', 'agent-ctx-hint', ''));
            row.appendChild(el(doc, 'button', 'agent-ctx-stop', '停止进程'));
            footer.appendChild(row);
            footer.appendChild(inputRow);
            footer.appendChild(el(doc, 'div', 'agent-act-row'));
        }
        // 卡片顶端那一行:只需要拿到**那个容器**、那句提示、以及停止按钮 ——
        // 三者的显隐都跟着状态走(renderStatus)。
        ctxRowEl = pick(footer, '.agent-ctx-row');
        ctxHintEl = pick(footer, '.agent-ctx-hint');
        if (panel && footer.parentNode !== panel) panel.appendChild(footer);
        footerEl = footer;
    }

    /** 从输入框往上找那个 .agent-footer(找不到就返回 null)。 */
    function findFooter(node) {
        let cur = node?.parentNode ?? null;
        while (cur !== null && cur !== undefined) {
            if (String(cur.className ?? '').split(/\s+/).includes('agent-footer')) return cur;
            cur = cur.parentNode ?? null;
        }
        return null;
    }

    // ---------- 黏贴截图:节点与渲染 ----------
    //
    // 位置:图片行插在**输入框正上方**(它有图时才有内容),被拒原因那行放在
    // 动作行下面 —— 也就是卡片里最靠近输入的地方,用户不用去找。
    // 两张节点都在构造时就建好、靠 hidden 开关(与凭证卡片同一条规矩:
    // 显示与否只有一个落点,文案不许停在过期状态)。

    imageRowEl = el(doc, 'div', 'agent-image-row');
    imageRowEl.hidden = true;
    imageNoticeEl = el(doc, 'p', 'agent-image-notice', '');
    imageNoticeEl.hidden = true;
    // 读屏也要能听到"这张图被拒了/为什么"。视觉上它就在输入框旁边。
    setAria(imageNoticeEl, 'aria-live', 'polite');

    {
        const host = footerEl ?? inputRow;
        const inputHolder = input?.parentNode ?? null;
        if (inputHolder !== null && typeof inputHolder.insertBefore === 'function') {
            inputHolder.insertBefore(imageRowEl, input);
        } else {
            host.appendChild(imageRowEl);
        }
        host.appendChild(imageNoticeEl);
    }

    /** 显示一句可读的中文原因(被拒、发不出去,都在这里说)。 */
    function showImageNotice(text) {
        if (imageNoticeEl === null) return;
        imageNoticeEl.textContent = String(text ?? '');
        imageNoticeEl.hidden = imageNoticeEl.textContent === '';
    }

    // ---------- 视频理解:节点 ----------
    //
    // 位置:紧挨着输入框(在图片行正下方),被拒/失败的原因跟在图片那条原因后面。
    // 与图片行同一条规矩:节点构造时就建好、靠 hidden 开关,显示与否只有一个落点。

    videoRowEl = el(doc, 'div', 'agent-video-row');
    videoRowEl.hidden = true;
    videoNoticeEl = el(doc, 'p', 'agent-video-notice', '');
    videoNoticeEl.hidden = true;
    setAria(videoNoticeEl, 'aria-live', 'polite');

    {
        const host = footerEl ?? inputRow;
        const inputHolder = input?.parentNode ?? null;
        if (inputHolder !== null && typeof inputHolder.insertBefore === 'function') {
            // 插在图片行**后面**(挂到输入框之前):视频卡片更靠近输入框 ——
            // 它是"这一次要理解的东西",图片那条路照旧。
            inputHolder.insertBefore(videoRowEl, input);
        } else {
            host.appendChild(videoRowEl);
        }
        host.appendChild(videoNoticeEl);
    }

    // ⚠️ 「密钥」入口按钮**已删**(用户要求:输入卡片顶端那一行只留状态点)。
    // 人工入口改由「设置」页承担(AI 与 Agent → DashScope 密钥);面板这一侧保留的是
    // **自动那条路**:视频理解失败于 `missing_key` 时自己把卡片建出来并展开 ——
    // 它不依赖任何按钮存在(见下面 setVideoKeyCardOpen / openVideoKeyCard)。

    /** 显示一句可读的中文原因(被拒、缺密钥、理解失败,都在这里说)。 */
    function showVideoNotice(text) {
        if (videoNoticeEl === null) return;
        videoNoticeEl.textContent = String(text ?? '');
        videoNoticeEl.hidden = videoNoticeEl.textContent === '';
    }

    /**
     * 「配密钥」那一张卡。**懒建**:绝大多数用户用环境变量,不该在界面上常驻一个
     * 要求填密钥的输入框 —— 那看起来像"不填就不能用"。
     *
     * 什么时候出现:视频理解失败于 `missing_key` 那一刻(见 sendVideo 里那句
     * `openVideoKeyCard()`)。⚠️ **没有按钮入口了** —— 人工配密钥的入口在「设置」页
     * (AI 与 Agent → DashScope 密钥);面板这张卡只在"缺密钥、刚失败过"时出现,
     * 并且自带一个「收起」按钮(否则它一旦出现就没有出口)。
     *
     * 三件事在这张卡上**分开写**,因为它们回答的是不同的问题:
     *   · 状态读数 —— 现在到底配没配、来源是哪、存的是密文还是明文(来自 video:status);
     *   · 警告 —— 环境变量赢的时候"在这里保存不会生效";明文时把后果说清;
     *   · 操作反馈 —— 刚才那一次保存/清除成没成、为什么没成。
     * 合成一行的话,一次保存失败就会把状态读数盖掉,用户再也看不到"当前用的是环境变量"。
     *
     * ⚠️ 输入框是 password 类型、**从不回填**,而且保存成功后**立刻清空** ——
     * 刚输入的明文不该继续留在 DOM 里。
     */
    function ensureVideoKeyRow() {
        if (videoKeyRowEl !== null) return videoKeyRowEl;
        const row = el(doc, 'div', 'agent-video-key');
        const hint = el(doc, 'span', 'agent-video-key-hint',
            'DashScope 密钥(DASHSCOPE_API_KEY)。填进来的这一串只走密钥通道:'
            + '不回显、不进日志、不进任何状态返回值。');
        videoKeyStatusEl = el(doc, 'span', 'agent-video-key-status', '');
        videoKeyWarnEl = el(doc, 'span', 'agent-video-key-warn', '');
        videoKeyWarnEl.hidden = true;
        videoKeyDetailEl = el(doc, 'span', 'agent-video-key-detail', '');
        videoKeyDetailEl.hidden = true;
        const inputElForKey = doc.createElement('input');
        inputElForKey.type = 'password';
        inputElForKey.className = 'agent-video-key-input';
        // 别让浏览器/密码管理器把这个框当成登录框去自动填充 —— 那会把别的密码
        // 填进来,然后被当成密钥存下去。
        inputElForKey.setAttribute('autocomplete', 'off');
        setAria(inputElForKey, 'aria-label', 'DashScope 密钥');
        const save = el(doc, 'button', 'btn btn-sm agent-video-key-save', '保存');
        save.type = 'button';
        const clear = el(doc, 'button', 'btn btn-sm agent-video-key-clear', '清除');
        clear.type = 'button';
        videoKeyResultEl = el(doc, 'span', 'agent-video-key-result', '');
        setAria(videoKeyResultEl, 'aria-live', 'polite');
        setAria(videoKeyStatusEl, 'aria-live', 'polite');

        save.addEventListener('click', async () => {
            // ⚠️ 值只在这里被读到、只进那一个通道:不缓存、不打日志、不回显。
            // 失败时**不清空**输入框(用户要能改一改再试),成功才清。
            const value = String(inputElForKey.value ?? '');
            videoKeyResultEl.textContent = '保存中…';
            try {
                const result = await calls('video:key:set', { key: value });
                if (result !== null && typeof result === 'object' && result.ok === true) {
                    inputElForKey.value = '';       // 明文不许继续留在 DOM 里
                    videoKeyResultEl.textContent = result.storage === 'encrypted'
                        ? '已保存(系统加密)'
                        : '已保存(明文存进设置文件)';
                    await loadVideoStatus();        // 读数以主进程为准,不自己拼
                } else {
                    // 主进程的判据是权威的那一份(空白 / 太短 / 带了引号都在那里说)
                    videoKeyResultEl.textContent = String(result?.reason ?? '没保存成功(没给出原因)');
                }
            } catch (err) {
                // 通道本身 reject(桥坏了 / 频道没放行)也要有一句能读的中文,
                // 不能变成"点了没反应"。
                log.warn?.('[video] 保存密钥失败', err);
                videoKeyResultEl.textContent = `没保存成功:${String(err?.message ?? err)}`;
            }
        });
        clear.addEventListener('click', async () => {
            try {
                await calls('video:key:clear', {});
                inputElForKey.value = '';
                videoKeyResultEl.textContent = '已清除保存的那一份(环境变量不受影响)';
                await loadVideoStatus();
            } catch (err) {
                log.warn?.('[video] 清除密钥失败', err);
                videoKeyResultEl.textContent = `清除失败:${String(err?.message ?? err)}`;
            }
        });

        row.appendChild(hint);
        row.appendChild(videoKeyStatusEl);
        row.appendChild(videoKeyWarnEl);
        row.appendChild(videoKeyDetailEl);
        row.appendChild(inputElForKey);
        row.appendChild(save);
        row.appendChild(clear);
        row.appendChild(videoKeyResultEl);
        // 卡片自己也留一个明显的收起入口:按钮在卡片上方,而卡片展开后可能占了半屏,
        // 用户的视线正在卡片上 —— 让他就地收起,不必回头去找那个按钮。
        // 它和上面那个按钮走**同一个** setter,所以两处的状态永远一致。
        const close = el(doc, 'button', 'agent-video-key-close', '收起');
        close.type = 'button';
        setAria(close, 'aria-label', '收起密钥设置');
        close.addEventListener('click', () => { setVideoKeyCardOpen(false); });
        row.appendChild(close);
        row.hidden = true;
        videoKeyRowEl = row;
        const host = footerEl ?? inputRow;
        host.appendChild(row);
        renderVideoKeyStatus();
        return row;
    }

    /**
     * 把 `video:status` 的叶子字段画进那张卡(文案由纯函数 describeVideoKeyStatus 出,
     * 所以它本身被单测逐字钉着)。卡片还没建就什么都不做 —— 读数是给卡片看的。
     *
     * ⚠️ 只用叶子字段,而且这个函数**拿不到**密钥值(它的输入里没有那个字段)。
     */
    function renderVideoKeyStatus() {
        if (videoKeyRowEl === null) return;
        const d = describeVideoKeyStatus(videoInfo ?? {});
        const storageText = d.storageLabel === '' ? '' : `,${d.storageLabel}`;
        videoKeyStatusEl.textContent = `密钥:${d.label}${storageText}`;
        if (videoKeyWarnEl !== null) {
            videoKeyWarnEl.textContent = d.warning;
            videoKeyWarnEl.hidden = d.warning === '';
        }
        if (videoKeyDetailEl !== null) {
            videoKeyDetailEl.textContent = d.detail;
            videoKeyDetailEl.hidden = d.detail === '';
        }
    }

    /** 卡片现在开着吗。**唯一**的判据就是 DOM 上那个 hidden —— 不另立布尔量。 */
    function isVideoKeyCardOpen() {
        return videoKeyRowEl !== null && videoKeyRowEl.hidden === false;
    }

    /**
     * 打开/收起密钥卡片。**这是唯一的写入口**(卡片自己的 hidden 就是全部状态)。
     *
     * 为什么不另立一个 `videoKeyOpen` 布尔量:缺密钥时 sendVideo 会**自动**把卡片
     * 展开。两份状态一旦分叉,就会出现"卡片开着、界面上却说关着"这种自相矛盾的界面。
     * 所以状态的唯一来源就是 DOM 上那个 hidden:读也读它、写也写它。
     * (卡片自己带一个「收起」按钮 —— 那一行上的「密钥」按钮已按用户要求删掉了,
     *  所以这里是"只有自动出现、用户只能收起",没有开关按钮了。)
     */
    function setVideoKeyCardOpen(open) {
        const row = ensureVideoKeyRow();
        row.hidden = open !== true;
        return row;
    }

    /**
     * 重新打开时先把读数摆成"读取中…"。
     *
     * 因为收起期间配置完全可能变了(别处设了环境变量、用户手改了设置文件),
     * 直接显示上一次的缓存读数就是**残留值** —— 而"卡片上写的一定是当下的事实"
     * 正是这张卡存在的理由。清掉再读,慢半拍但不会撒谎。
     */
    function showVideoKeyReading() {
        if (videoKeyStatusEl !== null) videoKeyStatusEl.textContent = '读取中…';
        if (videoKeyWarnEl !== null) {
            videoKeyWarnEl.textContent = '';
            videoKeyWarnEl.hidden = true;
        }
        if (videoKeyDetailEl !== null) {
            videoKeyDetailEl.textContent = '';
            videoKeyDetailEl.hidden = true;
        }
    }

    /**
     * 确保卡片展开(缺密钥那条自动路径用它)。
     *
     * 与 toggle 共用同一个 setter —— 于是"自动打开"之后,按钮上的 aria-expanded
     * 一定也是 true(有单测钉住这件事)。
     */
    async function openVideoKeyCard() {
        if (!isVideoKeyCardOpen()) {
            setVideoKeyCardOpen(true);
            showVideoKeyReading();
        }
        await loadVideoStatus();
    }

    /**
     * 重建视频草稿卡片。
     *
     * 与图片行同一个理由整行重建:chip 上按钮的闭包捕获的是那一条 entry。
     * 全程 textContent —— 文件名来自用户本机的任意文件,是不可信输入。
     *
     * ⚠️ 卡片上**没有**「理解」按钮(曾经有):触发点只有「发送」一个。
     * 多一个按钮就多一条绕过"草稿→发送"这一致的路径,而"这一下要花钱"的决定权
     * 必须只在用户按下发送那一刻。所以卡片上留的是:名字 + 大小 + 音频说明 + 移除。
     */
    function renderVideo() {
        if (videoRowEl === null) return;
        if (pendingVideo === null) {
            videoRowEl.hidden = true;
            if (typeof videoRowEl.replaceChildren === 'function') videoRowEl.replaceChildren();
            return;
        }
        const chip = el(doc, 'div', 'agent-video-chip');
        if (typeof chip.setAttribute === 'function') {
            chip.setAttribute('data-video-chip', pendingVideo.mimeType);
        }
        const label = `待发送的视频:${pendingVideo.name}(${formatBytes(pendingVideo.byteLength)})`;
        setAria(chip, 'aria-label', label);
        chip.appendChild(el(doc, 'span', 'agent-video-name', pendingVideo.name));
        chip.appendChild(el(doc, 'span', 'agent-video-size', formatBytes(pendingVideo.byteLength)));

        const del = el(doc, 'button', 'agent-video-del', '×');
        del.type = 'button';
        setAria(del, 'aria-label', `移除这个视频:${pendingVideo.name}`);
        del.addEventListener('click', () => { removeVideo(); });
        chip.appendChild(del);

        // 音频说明**常驻在卡片上**:这个模型只看画面。放在这里比放在帮助里管用 ——
        // 用户正对着"要不要按发送"的那一刻就会读到它。
        chip.appendChild(el(doc, 'span', 'agent-video-audio', VIDEO_AUDIO_NOTICE));

        if (typeof videoRowEl.replaceChildren === 'function') videoRowEl.replaceChildren(chip);
        else {
            while (videoRowEl.firstChild) videoRowEl.removeChild(videoRowEl.firstChild);
            videoRowEl.appendChild(chip);
        }
        videoRowEl.hidden = false;
    }

    /**
     * 移除待发送的那段视频。
     *
     * 这一步**只丢草稿**:读完字节、递出去的那些事一件都没发生(它们只发生在 send 里),
     * 所以这里不需要撤销任何远端状态 —— 与图片的 removeImage 同一个形状。
     */
    function removeVideo() {
        pendingVideo = null;
        showVideoNotice('');
        renderVideo();
        // 发送按钮的可用性跟着"有没有草稿"走(见 renderStatus),所以这里要重画一次:
        // 删掉草稿之后,Agent 没连上时那个按钮就该重新变灰,否则点了什么都不发生。
        render();
    }

    /** 从剪贴板/拖放事件里挑出视频文件。不含视频时返回空数组 —— 调用方据此"不拦"。 */
    function videoFilesFrom(data) {
        const out = [];
        const items = data?.items;
        if (items !== null && items !== undefined && typeof items.length === 'number') {
            for (let i = 0; i < items.length; i += 1) {
                const item = items[i];
                if (item === null || item === undefined) continue;
                if (String(item.kind ?? '') !== 'file') continue;
                if (!String(item.type ?? '').startsWith('video/')) continue;
                const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
                if (file !== null && file !== undefined) out.push(file);
            }
        }
        const files = data?.files;
        if (out.length === 0 && files !== null && files !== undefined
            && typeof files.length === 'number') {
            for (let i = 0; i < files.length; i += 1) {
                const file = files[i];
                if (file !== null && file !== undefined
                    && String(file.type ?? '').startsWith('video/')) out.push(file);
            }
        }
        return out;
    }

    function videoName(file) {
        const raw = String(file?.name ?? '').trim();
        if (raw !== '') return raw;
        const type = String(file?.type ?? 'video/mp4');
        return `视频.${type.slice('video/'.length) || 'mp4'}`;
    }

    /**
     * 收下一段视频,放进输入区当**草稿**。
     *
     * ⚠️ 这一步是**纯本地**的:一次 IPC 都不发,更不会碰网络。用户按下「发送」
     * 之后才读字节、才调 `video:understand`(见 sendVideo)。这条边界是这次交互的
     * 全部意义所在 —— 拖进来一段 60MB 的视频只是"我准备问这个",不是"我同意花钱"。
     * 与图片那条草稿路(handOffImages 之前的所有事)形状完全一致。
     */
    function addVideo(file) {
        if (videoBusy) {
            showVideoNotice('上一段视频还在理解,等它结束再拖新的');
            return false;
        }
        const verdict = validateVideoCandidate({
            mimeType: file?.type,
            byteLength: Number(file?.size),
            existing: pendingVideo === null ? [] : [pendingVideo],
        });
        if (verdict.ok !== true) {
            showVideoNotice(verdict.reason);
            return false;
        }
        pendingVideo = {
            id: 1,
            mimeType: verdict.mimeType,
            name: videoName(file),
            byteLength: Number(file.size),
            file,
        };
        showVideoNotice('');
        renderVideo();
        // 有草稿时"发送"必须可点(见 renderStatus)—— 即便 Agent 没连上,
        // 因为视频理解根本不经过 Agent。
        render();
        return true;
    }

    /**
     * 把草稿移交给消息气泡 —— 与图片的 `handOffImages()` **同一个形状、同一个职责**:
     * 把这份待发数据的**所有权**转出去,并让输入区忘掉它(此后输入区不再渲染它,
     * 也不会在 dispose/清空时把它当成自己的东西收掉)。
     *
     * 图片那次移交的是 blob: URL(所以有 releaseMessageImages 的撤销账);
     * 视频这里没有 URL(不做播放器),移交的只是"气泡要画的三个叶子字段"。
     * 形状照旧,是因为最容易错的那件事一样:谁在什么时候放弃所有权。
     *
     * @returns {{name:string, mimeType:string, byteLength:number}|null}
     */
    function handOffVideo() {
        const entry = pendingVideo;
        if (entry === null) return null;
        pendingVideo = null;
        renderVideo();
        return { name: entry.name, mimeType: entry.mimeType, byteLength: entry.byteLength };
    }

    /**
     * 这次发送用的是哪一句提问。
     *
     * 与文字消息同一套语义:输入框里有字就用那一句;**空的话用默认问法**
     * (那一位写在纯模块里,与主进程的兜底是同一句,不在这里另抄一遍)。
     * 面板**先把默认问法解析出来**再显示,是为了让气泡里就是真正发出去的那一句 ——
     * 否则界面上写"〔视频理解〕x.mp4"、模型收到的却是另一句,对不上。
     */
    function videoQuestion() {
        const typed = String(input?.value ?? '').trim();
        return typed !== '' ? typed : DEFAULT_VIDEO_QUESTION;
    }

    /**
     * **发送**时的那条视频路径(唯一的触发点)。与 `send()` 里图片那一段的职责一样:
     * 先做"会中止这一次发送"的本地检查(读字节、判签名),再动界面,最后才 await IPC。
     *
     * 顺序上有两处是刻意的:
     *   ① 本地检查**全部排在动界面之前**:读不出字节、字节不是视频的,一律不许在
     *      消息流里留下一条"我递了视频"的记录(与图片那边"读不出字节就不发"一致);
     *   ② "用户递了这段视频 + 提问"这条消息**同步**放上界面,再去 await IPC ——
     *      否则从按下发送到界面有反应之间隔着一次 IPC,看起来像卡住了。
     *
     * @returns {Promise<boolean>} 这一次是否真的发出去了(调用方据此决定要不要清输入框)
     */
    async function sendVideo() {
        if (pendingVideo === null || videoBusy) return false;
        const entry = pendingVideo;
        let bytes;
        try {
            bytes = await readFileBytes(entry.file);
        } catch (err) {
            log.warn?.('[video] 读视频字节失败', err);
            bytes = null;
        }
        if (bytes === null) {
            showVideoNotice(`${entry.name} 读不出来(文件可能已被移动或删除),这次没有发出去`);
            return false;
        }
        // ⚠️ 字节到手之后**先本地判一次**"它真的是视频吗":判据与主进程用的是同一个
        // videoSniffVerdict(声明是 mp4、字节其实是 HTML 的那种,在这里就被挡住),
        // 于是它连消息流都进不去 —— 也省掉一次注定失败的远端往返。
        const sniffVerdict = videoSniffVerdict({ mimeType: entry.mimeType, bytes });
        if (sniffVerdict.ok !== true) {
            removeVideo();
            showVideoNotice(sniffVerdict.reason);
            return false;
        }
        const question = videoQuestion();
        // 草稿移交给气泡(与图片的 handOffImages 同一个位置、同一个职责)
        const clip = handOffVideo();
        // 方案 C:一条用户消息 + 一条**待完成的助手占位**(四段状态行就画在那里面,
        // 正文到了之后在同一个气泡里流出来 —— 气泡自始至终是同一个节点)。
        state = beginVideoStages(state, { ...clip, question });
        videoRequestId = nextVideoRequestId();
        videoBusy = true;
        showVideoNotice('');
        render();

        try {
            const result = await calls('video:understand', {
                mimeType: entry.mimeType,
                bytes,
                name: entry.name,
                question,
                requestId: videoRequestId,
            });
            await applyUnderstandResult(result);
        } catch (err) {
            log.warn?.('[video] 理解失败', err);
            const reason = String(err?.message ?? err);
            state = finishVideoStages(state, { ok: false, reason });
            showVideoNotice(reason);
        } finally {
            videoBusy = false;
            stopStageTicker();
            render();
        }
        return true;
    }

    /**
     * 一次理解的结果落到界面上的**唯一**落点(两条入口共用:过 IPC 的字节 / 按路径)。
     *
     * 为什么合成一个:两条入口的失败语义必须一模一样 —— 尤其"缺密钥就把配置卡展开"
     * 这一条,抄两遍迟早只修一处。差别只在"怎么把请求发出去"。
     */
    async function applyUnderstandResult(result) {
        stopStageTicker();
        if (result === null || typeof result !== 'object') {
            state = finishVideoStages(state, { ok: false, reason: '主进程没有返回结果', failedStage: lastVideoStage() });
            showVideoNotice('主进程没有返回结果');
            return;
        }
        if (result.ok === true) {
            state = finishVideoStages(state, {
                ok: true,
                text: result.text,
                usage: result.usage,
                delivery: result.delivery,
            });
            showVideoNotice('');
            return;
        }
        const reason = String(result.reason ?? '理解失败(没有给出原因)');
        // ⚠️ 失败**红在哪一段**:先按码指认;码指不出来(超时/网络/服务端)就落到
        // 界面上"最后一条还在做的行"。绝不退回一句笼统的"理解失败" ——
        // 那句笼统的话正是这次要消掉的东西。
        // 用户自己按的「取消」是**例外**:那不是故障,红一行"在这里断了"会让人以为
        // 出错了。它照常不留占位(与旧的失败语义一致),只在提示区说一句已取消。
        const cancelled = result.code === 'cancelled';
        state = finishVideoStages(state, {
            ok: false,
            reason,
            failedStage: cancelled ? '' : (failedVideoStage(result.code) || lastVideoStage()),
        });
        showVideoNotice(reason);
        // 缺密钥:把配置入口展开,再读一次配置写读数(叶子字段,不含密钥值)。
        // ⚠️ 走的是与按钮**同一个** setter(openVideoKeyCard → setVideoKeyCardOpen),
        // 所以自动展开之后按钮上的 aria-expanded 也是 true —— 不会出现"卡片开着、
        // 按钮说关着"那种分叉。顺序:先建行、再读(读数写在行里)。
        if (result.code === 'missing_key') await openVideoKeyCard();
    }

    /** 界面上"最后一条还在做的行"(失败时红在哪的兜底判据)。 */
    function lastVideoStage() {
        const msgs = asArray(state?.messages);
        const last = msgs[msgs.length - 1];
        return lastActiveStage(last?.stages) || 'prepare';
    }

    /**
     * 「取消」:只递一个 requestId,取消谁由主进程按它找。
     *
     * 为什么值得做:169.5 MB 那条实测 47–71 秒,上行慢的时候是几分钟 ——
     * 这中间用户没有任何退路(只能干等或者关窗口)。主进程那侧早就有 AbortSignal
     * 这条线(超时用的就是它),把它接到界面上只是把已有的能力露出来。
     */
    async function cancelVideo() {
        if (videoRequestId === '') return;
        const id = videoRequestId;
        try {
            const result = await calls('video:cancel', { requestId: id });
            if (result !== null && typeof result === 'object' && result.ok !== true) {
                // "已经结束了"不是错误:用户按的时候它刚好收尾,这是正常的一瞬
                showVideoNotice(result.code === 'not_running'
                    ? '这次理解刚好结束了' : String(result.reason ?? '取消失败'));
                return;
            }
            showVideoNotice('已取消这次理解');
        } catch (err) {
            log.warn?.('[video] 取消失败', err);
            showVideoNotice(`取消失败:${String(err?.message ?? err)}`);
        }
    }

    /**
     * 「等待首个字」那一行的秒表。
     *
     * 为什么必须是本地时钟 + 定时器:服务端在这段时间里**一个字节都不发**,
     * 所以只有"从请求发出到现在过了多久"是真实的。也**不做倒计时** ——
     * 倒计时到 0 而模型还没回来,用户会以为坏了(那比不给更糟)。
     */
    function startStageTicker() {
        if (stageTicker !== null || typeof setInterval !== 'function') return;
        stageTicker = setInterval(() => {
            if (videoBusy !== true) { stopStageTicker(); return; }
            render();
        }, 250);
    }

    function stopStageTicker() {
        if (stageTicker !== null && typeof clearInterval === 'function') clearInterval(stageTicker);
        stageTicker = null;
        waitStartedAt = 0;
        stageEstimateText = '';
        stageEstimateTitle = '';
    }

    /**
     * 主进程推来的进度事件落到状态上。
     *
     * ⚠️ 两条过滤,缺一不可:①只认**这一次**的 requestId(上一次的迟到推送不许
     * 改这一次的四段行);②不再飞的时候直接丢掉(收尾之后推来的都是历史的回声)。
     */
    function onVideoEvent(event) {
        if (videoBusy !== true) return;
        if (event === null || typeof event !== 'object') return;
        if (String(event.requestId ?? '') !== videoRequestId || videoRequestId === '') return;
        const stage = String(event.stage ?? '');
        if (stage === 'prepared') {
            // delivery 定下来的那一刻才知道有没有"上传"那一段,也才知道体积 ——
            // 于是估计值(标定过的)只在这时算一次,而且只在标定可信时才写。
            // 文案由纯函数给:样本差得多的时候它说的是"通常十几秒到半分钟",
            // 而不是一个看着像测准了的数(见 estimateFirstTokenFrom)。
            const est = estimateFirstTokenMs({ byteLength: Number(event.totalBytes), mode: String(event.mode ?? '') });
            stageEstimateText = est.ok === true ? est.text : '';
            stageEstimateTitle = est.ok === true ? String(est.title ?? '') : '';
        }
        if (stage === 'uploading') {
            // 上传那一段界面要有活的东西在动:它是实测里最长的一段(27 秒)。
            startStageTicker();
        }
        if (stage === 'waiting') {
            waitStartedAt = Date.now();
            startStageTicker();
        }
        if (stage === 'generating' && waitStartedAt > 0) {
            // 首字到了:秒表到此为止,再涨就是假读数
            waitStartedAt = 0;
            stopStageTicker();
        }
        state = applyVideoProgress(state, event);
        render();
    }

    /**
     * 按**本地路径**理解一段视频(队列里已经下好的文件走这条)。
     *
     * 与 `sendVideo` 的差别只有一处,但是关键的一处:**字节不过 IPC**。
     * 文件由主进程按路径自己读,所以这条入口的上限是服务端自己的 1024 MB,
     * 而不是那条"过 IPC"的 64 MiB —— 用户那个 169.5 MB 的视频就是走这条。
     * 其余(消息进消息流、失败不留假回答、缺密钥展开配置卡)与 sendVideo 完全一致。
     *
     * @param {{path?:string, folder?:string, name?:string, size?:number, question?:string}} detail
     * @returns {Promise<boolean>} 这次有没有真的发出去
     */
    async function understandVideoPath(detail = {}) {
        if (videoBusy) {
            showVideoNotice('上一段视频还在理解,等它结束再试');
            return false;
        }
        const path = String(detail?.path ?? '').trim();
        if (path === '') {
            showVideoNotice('这条路径是空的,没法理解');
            return false;
        }
        const name = String(detail?.name ?? '').trim() || (path.split(/[\\/]/).pop() ?? '') || '视频';
        const size = Number(detail?.size);
        const byteLength = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;

        // 体积 → 路径的分发用**同一份判据**(app/lib/agent-video.js),这里只是拿它
        // 决定那条提示该说"上传中"还是"理解中"。上限用按路径那条入口的。
        const delivery = chooseDelivery({
            byteLength,
            mimeType: 'video/mp4',
            maxBytes: MAX_LOCAL_VIDEO_BYTES,
        });
        const question = String(detail?.question ?? '').trim() || videoQuestion();
        state = beginVideoStages(state, { name, mimeType: '', byteLength, question });
        videoRequestId = nextVideoRequestId();
        videoBusy = true;
        // ⚠️ 大文件要上传:169.5 MB 实测 27.4 秒上传 + 26.1 秒首字 + 12.9 秒生成
        // (共 66.4 秒),上行慢的时候是几分钟。四段状态行已经把"卡在哪"说清楚了,
        // 这一句只留**下一步能做什么**(取消)。
        showVideoNotice(delivery.mode === 'upload'
            ? `正在理解:这段 ${formatBytes(byteLength)} 要先上传到服务端,可能要一两分钟(可以点「取消」)`
            : '正在理解…');
        render();

        try {
            const result = await calls('video:understandPath', {
                path,
                folder: String(detail?.folder ?? ''),
                name,
                mimeType: '',
                question,
                requestId: videoRequestId,
            });
            await applyUnderstandResult(result);
        } catch (err) {
            log.warn?.('[video] 按路径理解失败', err);
            const reason = String(err?.message ?? err);
            state = finishVideoStages(state, { ok: false, reason, failedStage: lastVideoStage() });
            showVideoNotice(reason);
        } finally {
            videoBusy = false;
            stopStageTicker();
            render();
        }
        return true;
    }

    /**
     * 别的面板(比如 B站下载队列)请本面板理解一段**本地文件**。
     *
     * 为什么走 DOM 事件而不是新开一条 IPC:这是**同一个页面内**两块的协作
     * (插件面板 → AI 面板),数据通道仍然是 `video:understandPath` 那一条;
     * 壳里本来就有同类先例(`kaiwu:shell-ready`)。事件只承载叶子字段,
     * 真正的准入判据在主进程侧(admitVideoPath)。
     */
    function onUnderstandVideoRequest(event) {
        void understandVideoPath(event?.detail ?? {});
    }

    /**
     * 拉一次视频理解的配置与凭证状态(叶子字段,不含密钥值)。
     *
     * 谁读它:上面 sendVideo 在"这次没配密钥"那一刻读一次,把当前模型与密钥的
     * 存储方式写进那张配置卡(明文还是密文,用户有权知道)。
     * **不在拖入视频时读、更不在挂载时读** —— 拖入只是草稿,一个 IPC 都不该发;
     * 挂载时的频道序列又是既有契约(有单测逐字钉着它)。
     */
    /**
     * 拉一次视频理解的配置与凭证状态(叶子字段,不含密钥值),并把读数画进那张卡。
     *
     * 谁读它:① 用户点「密钥」打开卡片时;② sendVideo 在"这次没配密钥"那一刻;
     * ③ 保存/清除密钥成功之后(读数以主进程为准,界面不自己拼)。
     * **不在拖入视频时读、更不在挂载时读** —— 拖入只是草稿,一个 IPC 都不该发;
     * 挂载时的频道序列又是既有契约(有单测逐字钉着它)。
     */
    async function loadVideoStatus() {
        try {
            const r = await calls('video:status', {});
            videoInfo = (r !== null && typeof r === 'object') ? r : null;
        } catch (err) {
            log.warn?.('[video] 取视频配置失败', err);
            videoInfo = null;
        }
        renderVideoKeyStatus();
        return videoInfo;
    }

    function clearImageNotice() {
        showImageNotice('');
    }

    /** 造缩略图 URL。环境里没有 createObjectURL(替身/老环境)就返回空串 —— 不报错。 */
    function createThumbUrl(file) {
        try {
            const urlApi = globalThis.URL;
            if (urlApi === null || urlApi === undefined
                || typeof urlApi.createObjectURL !== 'function') return '';
            const url = urlApi.createObjectURL(file);
            return typeof url === 'string' ? url : '';
        } catch (err) {
            log.warn?.('[agent] 生成缩略图失败', err);
            return '';
        }
    }

    function revokeThumbUrl(entry) {
        if (entry === null || entry === undefined) return;
        const url = String(entry.thumbUrl ?? '');
        if (url === '') return;
        entry.thumbUrl = '';
        try {
            const urlApi = globalThis.URL;
            if (urlApi !== null && urlApi !== undefined
                && typeof urlApi.revokeObjectURL === 'function') urlApi.revokeObjectURL(url);
        } catch (err) {
            log.warn?.('[agent] 释放缩略图失败', err);
        }
    }

    /**
     * 重建图片行。
     *
     * ⚠️ 整行**重建**(而不是增量插入):chip 的删除按钮闭包捕获的是那一条 entry,
     * 增量插入时"删了第 2 张之后第 3 张的闭包还指着旧下标"这类错法很难看出来。
     * 一条条节点建出来,全程 textContent —— 截图来自剪贴板,是不可信输入,
     * 文件名一个字符都不许进 innerHTML。
     */
    function renderImages() {
        if (imageRowEl === null) return;
        const chips = pendingImages.map((entry) => {
            // 有缩略图就画图,没有(环境不支持 createObjectURL)就退成一个方块占位 ——
            // 但 chip 本身、文件名、删除按钮一样不少。
            const chip = el(doc, 'div', 'agent-image-chip');
            chip.setAttribute('data-image-chip', entry.mimeType);
            // chip 自己可聚焦:图片本身不是控件,但键盘用户要能走到它上面,
            // 才能读到 aria-label 里那句"已黏贴的截图:…"(删除按钮独立可聚焦)。
            if (typeof chip.setAttribute === 'function') chip.setAttribute('tabindex', '0');
            const label = `已黏贴的截图:${entry.name}(${entry.mimeType})`;
            setAria(chip, 'aria-label', label);

            if (entry.thumbUrl !== '') {
                const thumb = doc.createElement('img');
                thumb.className = 'agent-image-thumb';
                // ⚠️ src 来自我们自己 createObjectURL 出来的 blob: URL,
                // **不是**对端给的字符串;alt 用 textContent 走不了,所以显式给属性。
                thumb.setAttribute('src', entry.thumbUrl);
                thumb.setAttribute('alt', '');
                chip.appendChild(thumb);
            } else {
                const placeholder = el(doc, 'span', 'agent-image-thumb agent-image-thumb-empty', '图');
                setAria(placeholder, 'aria-hidden', 'true');
                chip.appendChild(placeholder);
            }

            chip.appendChild(el(doc, 'span', 'agent-image-name', entry.name));

            const del = el(doc, 'button', 'agent-image-del', '×');
            del.type = 'button';
            setAria(del, 'aria-label', `移除这张图:${entry.name}`);
            del.addEventListener('click', () => removeImage(entry.id));
            chip.appendChild(del);
            return chip;
        });
        if (typeof imageRowEl.replaceChildren === 'function') {
            imageRowEl.replaceChildren(...chips);
        } else {
            while (imageRowEl.firstChild) imageRowEl.removeChild(imageRowEl.firstChild);
            for (const chip of chips) imageRowEl.appendChild(chip);
        }
        imageRowEl.hidden = chips.length === 0;
    }

    /** 从剪贴板事件里挑出图片文件。不含图片时返回空数组 —— 调用方据此"不拦"。 */
    function imageFilesFrom(clipboardData) {
        const out = [];
        const items = clipboardData?.items;
        if (items !== null && items !== undefined && typeof items.length === 'number') {
            for (let i = 0; i < items.length; i += 1) {
                const item = items[i];
                if (item === null || item === undefined) continue;
                if (String(item.kind ?? '') !== 'file') continue;
                if (!String(item.type ?? '').startsWith('image/')) continue;
                const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
                if (file !== null && file !== undefined) out.push(file);
            }
        }
        const files = clipboardData?.files;
        if (out.length === 0 && files !== null && files !== undefined
            && typeof files.length === 'number') {
            for (let i = 0; i < files.length; i += 1) {
                const file = files[i];
                if (file !== null && file !== undefined
                    && String(file.type ?? '').startsWith('image/')) out.push(file);
            }
        }
        return out;
    }

    function imageName(file, index) {
        const raw = String(file?.name ?? '').trim();
        if (raw !== '') return raw;
        const type = String(file?.type ?? 'image');
        return `截图${index + 1}.${type.slice('image/'.length) || 'png'}`;
    }

    /** 收下一张图。超限/格式不对就**明说原因**,不静默丢。 */
    function addImage(file) {
        const verdict = validateImageCandidate({
            mimeType: file?.type,
            byteLength: Number(file?.size),
            existing: pendingImages,
        });
        if (verdict.ok !== true) {
            showImageNotice(verdict.reason);
            return false;
        }
        pendingImages.push({
            id: nextImageId,
            mimeType: verdict.mimeType,
            name: imageName(file, pendingImages.length),
            byteLength: Number(file.size),
            file,
            thumbUrl: createThumbUrl(file),
        });
        nextImageId += 1;
        clearImageNotice();
        renderImages();
        return true;
    }

    /** 删掉一张(按 id,不按下标 —— 下标会在删除之后错位)。 */
    function removeImage(id) {
        const at = pendingImages.findIndex(entry => entry.id === id);
        if (at === -1) return;
        const [entry] = pendingImages.splice(at, 1);
        revokeThumbUrl(entry);
        clearImageNotice();
        renderImages();
    }

    function clearImages() {
        for (const entry of pendingImages) revokeThumbUrl(entry);
        pendingImages = [];
        renderImages();
    }

    /**
     * 把待发图片**连缩略图 URL 一起**移交给消息气泡(见上面那段归属说明)。
     *
     * ⚠️ 这里**只移交、不撤销**:URL 从现在起归气泡所有,发送时 revoke 出去,
     * 气泡里立刻就是一张破图(这类改动最经典的 bug)。
     * 移交给气泡的那些 entry 会被清出 pendingImages,所以随后那次 clearImages()
     * 是空转 —— chip 侧再也不会撤销它们。
     *
     * @returns {Array<{url:string, mimeType:string, name:string}>} 给 beginPrompt 的叶子数据
     */
    function handOffImages() {
        const handed = [];
        for (const entry of pendingImages) {
            const url = String(entry.thumbUrl ?? '');
            if (url === '') continue;         // 环境造不出 blob: URL:没有东西可移交
            messageImageUrls.add(url);
            handed.push({ url, mimeType: entry.mimeType, name: entry.name });
            entry.thumbUrl = '';              // 所有权转走:chip 侧从此不许再撤销它
        }
        pendingImages = [];
        renderImages();
        return handed;
    }

    /** 撤销一条已经归气泡所有的 blob: URL(它已经没有任何消息引用了)。 */
    function revokeMessageUrl(url) {
        messageImageUrls.delete(url);
        try {
            const urlApi = globalThis.URL;
            if (urlApi !== null && urlApi !== undefined
                && typeof urlApi.revokeObjectURL === 'function') urlApi.revokeObjectURL(url);
        } catch (err) {
            log.warn?.('[agent] 释放消息图片失败', err);
        }
    }

    /**
     * 撤销**已经没有任何消息引用**的气泡图片 URL。两种调用时机:
     *   · `all = true` —— dispose:整个面板要没了,一律撤销(最后一次回收);
     *   · `all = false`(默认)—— 每次重画:状态里已经找不到那条消息了就撤销
     *     (清空会话 / 换会话)。还留在状态里的**一个都不碰** —— 撤销了就是破图。
     * @param {boolean} [all]
     */
    function releaseMessageImages(all = false) {
        if (messageImageUrls.size === 0) return;      // 绝大多数重画走这一行就出去了
        const alive = new Set();
        if (all !== true) {
            for (const message of asArray(state.messages)) {
                for (const image of asArray(message?.images)) {
                    const url = String(image?.url ?? '');
                    if (url !== '') alive.add(url);
                }
            }
        }
        for (const url of [...messageImageUrls]) {
            if (alive.has(url)) continue;
            revokeMessageUrl(url);
        }
    }

    /**
     * 输入区收到 paste。
     *
     * 只拦**含图片或视频**的那一种:纯文字粘贴一点都不碰(不 preventDefault、
     * 不碰 value),否则用户粘一段文本的行为就被改了。
     */
    function onPaste(event) {
        const imageFiles = imageFilesFrom(event?.clipboardData);
        const videoFiles = videoFilesFrom(event?.clipboardData);
        if (imageFiles.length === 0 && videoFiles.length === 0) return undefined;
        if (typeof event?.preventDefault === 'function') event.preventDefault();
        for (const file of imageFiles) addImage(file);
        for (const file of videoFiles) addVideo(file);
        return undefined;
    }

    /**
     * 拖进来的东西里有文件吗。
     *
     * ⚠️ `dragover` 上**必须** preventDefault,否则浏览器(Chromium)根本不会触发
     * `drop` —— 表现是"拖进去什么都没发生",而且不报错。但也不能见拖就拦:
     * 拖一段选中的文字进来时不该改任何行为。
     */
    function dragHasFiles(event) {
        const types = event?.dataTransfer?.types;
        if (types !== null && types !== undefined && typeof types.length === 'number') {
            for (let i = 0; i < types.length; i += 1) {
                if (String(types[i]) === 'Files') return true;
            }
        }
        return videoFilesFrom(event?.dataTransfer).length > 0;
    }

    function onDragOver(event) {
        if (!dragHasFiles(event)) return undefined;
        if (typeof event?.preventDefault === 'function') event.preventDefault();
        if (event?.dataTransfer) {
            try { event.dataTransfer.dropEffect = 'copy'; } catch { /* 只读的实现,不重要 */ }
        }
        return undefined;
    }

    /**
     * 拖进来的**文件**由这里收:是视频就建卡片(并按配置自动开始理解),不是视频就
     * 什么都不做 —— 但仍然 preventDefault。
     *
     * 为什么非视频文件也要拦:不拦的话 Chromium 会拿那个文件去做默认动作(导航到
     * file://)。拖错一个文件就"应用跳走了"是不能接受的,哪怕我们并不处理它。
     * 而**不带文件**的拖放(拖一段选中的文字)在 dragHasFiles 那一关就返回了 ——
     * 那种拖动一个字节都不碰。
     */
    function onDrop(event) {
        if (!dragHasFiles(event)) return undefined;
        if (typeof event?.preventDefault === 'function') event.preventDefault();
        for (const file of videoFilesFrom(event?.dataTransfer)) addVideo(file);
        return undefined;
    }

    /**
     * 把待发的图片读成字节。渲染进程只递叶子数据:`{ mimeType, bytes }`。
     * 读不出来就返回 null,并把原因显示出来(不静默发一条没图的消息)。
     */
    async function imagesForSend() {
        const out = [];
        for (let i = 0; i < pendingImages.length; i += 1) {
            const entry = pendingImages[i];
            let bytes;
            try {
                bytes = await readFileBytes(entry.file);
            } catch (err) {
                log.warn?.('[agent] 读图片字节失败', err);
                bytes = null;
            }
            if (bytes === null) {
                showImageNotice(`第 ${i + 1} 张图(${entry.name})读不出来,这次没有发出去`);
                return null;
            }
            out.push({ mimeType: entry.mimeType, bytes });
        }
        return out;
    }

    // ---------- 渲染 ----------

    function scrollToBottom() {
        if (typeof messagesEl?.scrollTop !== 'number'
            || typeof messagesEl?.scrollHeight !== 'number') return;
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /**
     * 填凭证卡片的内容。**无论卡片显不显示都填** —— 只用 `hidden` 控制显示。
     *
     * 为什么不是"显示了才填":初始文案是构造时写死的那句,有凭证时卡片只是被
     * 藏起来、文案还停在"凭证未就绪"。哪天谁换个条件显示这张卡,用户看到的就是
     * 一句错话(评审 F7 点名的地雷)。
     */
    function fillCredentialCard() {
        if (!credentialEl) return;
        const headline = credentialEl.children?.[0];
        const reasonNode = credentialEl.children?.[1];
        // credentials 还没取回来(null)时按"未就绪"渲染:取不到就说取不到,
        // 不许显示一句"凭证正常"。
        const ok = credentials !== null && credentials.ok === true;
        if (headline !== undefined) headline.textContent = ok ? '凭证已就绪' : '凭证未就绪';
        if (reasonNode !== undefined) {
            if (ok) {
                reasonNode.textContent = '';
            } else {
                const why = String(credentials?.reason ?? '').trim();
                reasonNode.textContent = why !== '' ? why
                    : '没有找到 DeepSeek 凭证(也没能问出原因)。';
            }
        }
    }

    /**
     * 把凭证状态写到卡片上(显示 + 内容 + 机器可读的那个属性)。
     *
     * `data-credential-ok` 是自检用来断言的那一份:只断言"卡片有文字"是**恒真**的
     * (构造时就写死了标题与 howto),断言这个属性才真的在验"invoke 的结果被处理了"。
     * 只有真的拿到结果才写它 —— 取不到时留着属性不写,自检等不到就会报失败。
     */
    function setCredentialState(kind) {
        if (!credentialEl) return;
        fillCredentialCard();
        if (credentials !== null && typeof credentials === 'object') {
            if (typeof credentialEl.setAttribute === 'function') {
                credentialEl.setAttribute('data-credential-ok', credentials.ok === true ? 'true' : 'false');
            } else if (credentialEl.dataset) {
                credentialEl.dataset.credentialOk = credentials.ok === true ? 'true' : 'false';
            }
        }
        if (kind === 'content-only') {
            // 只写内容与机器可读的那个属性,不动显示 —— 调用方随后决定显隐。
            return;
        }
        if (kind === 'hidden') {
            credentialEl.hidden = true;
            delete credentialEl.dataset.state;
            return;
        }
        credentialEl.hidden = false;
        credentialEl.dataset.state = kind;
    }

    /** 流式正文里"还在显影"的那几个字(渐变擦除的宽度,与 shell.css 的 .agent-tail 一致)。 */
    const TAIL_CHARS = 8;

    /**
     * 增量渲染的缓存(见 renderMessages 顶上的快速通道)。
     *
     * 为什么需要:面板原来是"每次更新把消息区整块重建"。单测与夹具自检里都看不出来 ——
     * 那里一条回复只有两三个增量。真跑起来完全不是这样:Agent 侧把流式接上之后实测
     * **169 次更新 / 约 400ms**(正文按字吐)。整块重建的代价不只是 CPU:
     *   · `.agent-sweep` 的 CSS 动画每次都**从 0 开始** —— 扫光永远卡在起点(等于没有);
     *   · `.agent-think` 的思考光标同理,一直停在第一帧;
     *   · 用户在思考块上手动展开/收起也会被反复复位。
     * 所以:结构没变、只有正文变长时走快速通道,只改文本节点,节点本身不动。
     */
    let renderedShape = null;    // 上一次整块重建时的结构指纹(不含正文有多长)
    let liveNodes = null;        // 快速通道要写的那几个节点
    // 用户手动展开过的思考条与摘要行(按 id / 组键记),以及"已经见过它想完了"的思考。
    // 没有这两份记录,每次重画都会把用户刚点开的块合上(实测过)。
    const thinkOpenIds = new Set();
    const thinkDoneSeen = new Set();
    const groupOpenIds = new Set();
    // 用户**明确收起**过的组(与 groupOpenIds 配对):没有它,"答案折在里面就默认展开"
    // 这条兜底会把用户刚收起来的组在每次重画时又弹开。
    const groupClosedIds = new Set();
    // 按需翻译:已经译好的那几条,用户可以切回原文看 —— 记的是"这一条现在显示原文"。
    // 以及"已经见过它译好了"的思考(用来在译好那一刻自动展开,否则用户看不到结果)。
    const showSourceIds = new Set();
    const translatedSeen = new Set();

    /**
     * 每条思考"想了多久":id → { start, end }(毫秒,本地时钟;end=0 表示还在想)。
     *
     * 为什么在**事件边界**上记,而不是在渲染时按下秒表:
     *   · 面板会因为增量反复重画,渲染时刻不等于"开始想"的时刻;
     *   · 更糟的是**一闪而过的思考** —— 它在同一批事件里"开始 + 结束",一次都没被
     *     画成 live,渲染里按下秒表就只能记出 0.0 秒(那是假读数,不是它想得快)。
     * 事件流才是唯一权威的先后(与 app/lib/agent-stream.js 的 order 同一条原则),
     * 所以秒表挂在 onEvent 上 —— 那里能看见每一次"新建 / 收尾"的跃迁。
     *
     * ⚠️ 键与 thinkOpenIds / thinkDoneSeen 用同一套(id):它们同生共死(一份状态里
     *    思考的 id 只由 thoughts.length 递增得到)。面板重建 = 这三份记录一起重建。
     */
    const thinkClock = new Map();
    let thinkTicker = null;      // 还在想的时候让秒数真的在动(setInterval)


    /**
     * 结构指纹:**只包含会改变 DOM 结构的东西**,不包含"文本有多长"。
     *
     * ⚠️ 它现在是从**渲染单元**算出来的,不是从三个数组:时间线的顺序、分组的边界、
     * 以及"哪个工具进了哪一组"都会改变结构,漏掉任何一项,快速通道就会拿旧节点
     * 凑合新结构(表现是新增的卡片不出现)。
     * 正文长度跨过 TAIL_CHARS 会让尾巴那一层出现/消失,所以那个布尔算结构变化。
     */
    function shapeOf(units) {
        return JSON.stringify(units.map((unit) => {
            if (unit.kind === 'thought') {
                const tr = (state.translations ?? {})[unit.thought.id] ?? null;
                const lang = (tr?.status === 'done' && !showSourceIds.has(unit.thought.id)) ? 'zh' : 'src';
                return ['think', unit.thought.id, unit.thought.done === true, unit.thought.text.length > 0,
                    tr?.status ?? 'none', lang, (tr?.text ?? '').length];
            }
            if (unit.kind === 'tool') {
                return ['tool', unit.tool.toolCallId, unit.tool.status, unit.tool.title, unit.tool.kind];
            }
            if (unit.kind === 'group') {
                return ['group', unit.live,
                    unit.tools.map(t => [t.toolCallId, t.status, t.title, t.kind]),
                    unit.messages.map(m => m.id)];
            }
            // ⚠️ 新增的单元类型必须在这里显式认领:下面那条兜底分支读的是 `unit.message.id`,
            //    漏了就会当场抛(整条消息列表画不出来)。
            if (unit.kind === 'noReply') return ['noreply', unit.tools, unit.thoughts];
            return ['msg', unit.message.id, unit.message.role, unit.message.done === true,
                unit.message.text.length > TAIL_CHARS,
                // 四段状态行的**结构**指纹:有哪些行、每行什么状态。
                // ⚠️ 刻意**不含百分比/秒数/字数** —— 那些每 60ms 就变一次,放进指纹
                // 就等于每来一片正文都重建整条消息列表(扫光动画会一遍遍从头开始)。
                // 读数由 paintLive 原地写。
                asArray(unit.message.stages).map(s => `${s.key}:${s.state}`).join(',')];
        }));
    }

    /** 快速通道:结构没变,只把变了的文本写进去(节点不动 → 动画不会重来)。 */
    function paintLive(live) {
        if (liveNodes.thinkCount !== null && live.thought !== null) {
            liveNodes.thinkCount.textContent = `${live.thought.text.length} 字`;
            liveNodes.thinkBody.textContent = live.thought.text;
        }
        // 秒数由计时器驱动重画(见 syncThinkTicker),所以这里每次都要按**当前时刻**重算
        if (liveNodes.thinkTime !== null && live.thought !== null) {
            liveNodes.thinkTime.textContent = thinkElapsedText(live.thought);
        }
        // 四段状态行的读数(百分比 / 已等待秒数 / 已生成字数)原地刷
        if (live.stages !== null && live.stages !== undefined && liveNodes.stages !== null
            && liveNodes.stages !== undefined) {
            paintVideoStages(live.stages, liveNodes.stages.refs);
        }
        const msg = live.message;
        if (liveNodes.sweep === null || msg === null) return;
        if (liveNodes.sweepTail !== null) {
            liveNodes.sweepHead.textContent = msg.text.slice(0, -TAIL_CHARS);
            liveNodes.sweepTail.textContent = msg.text.slice(-TAIL_CHARS);
        } else {
            liveNodes.sweep.textContent = msg.text;
        }
    }

    /**
     * 一条思考的耗时读数(一位小数,单位"秒")。
     *
     * 口径与视频那段的「已等待 X 秒」**完全一致**(见 app/lib/agent-stream.js 的
     * stageDetailText:给到 0.1 秒就够了,再多是假装精确)。还在想 → 用**当前时刻**算,
     * 于是它自己会涨;想完了 → 用记下的收尾时刻,冻住(不再跟着时钟走)。
     */
    function thinkElapsedText(thought) {
        const rec = thinkClock.get(thought.id);
        if (rec === undefined) return '';
        const end = rec.end > 0 ? rec.end : Date.now();
        const seconds = Math.max(0, end - rec.start) / 1000;
        return `${(Math.round(seconds * 10) / 10).toFixed(1)} 秒`;
    }

    /**
     * 还在想的思考条要一个定时器:服务端可能好几秒一个字都不发,秒数不能跟着停。
     *
     * ⚠️ 只在这一轮**真的在飞**的时候挂(忙 + 进程可用):光看"有没有 live 的思考"不够 ——
     *    进程被硬杀、或事件流半路断掉时,状态里会留下一条永远 live 的思考,那时定时器
     *    就再也不会停(面板没了都还在每 250ms 调一次 render)。实测:单测里就有一条
     *    「流式中的思考条没有『译』」,它发完思考增量就结束 —— 泄出去的定时器让整个测试
     *    **进程退不出去**(跑满 300 秒被外部杀掉)。
     */
    function stopThinkTicker() {
        if (thinkTicker !== null && typeof clearInterval === 'function') clearInterval(thinkTicker);
        thinkTicker = null;
    }

    function syncThinkTicker() {
        const flying = state.busy === true
            && (state.status.state === 'ready' || state.status.state === 'starting')
            && asArray(state.thoughts).some(t => t.done !== true);
        if (flying !== true) { stopThinkTicker(); return; }
        if (thinkTicker === null && typeof setInterval === 'function') {
            // 250ms 与「等待首个字」那条秒表同一个节奏;render 本身走快速通道
            // (结构没变 → 只改文本节点),不会把扫光/思考光标那些动画从头播一遍。
            thinkTicker = setInterval(() => { render(); }, 250);
        }
    }

    /**
     * 从**事件之后**的状态推进秒表:新出现的思考按下开始,收尾的按下结束。
     *
     * ⚠️ 收尾只记一次:finishThoughts 是幂等的,但事件可能重复到达,重复记就会把
     *    耗时越记越长(那不是"想了更久",是记账重复)。
     */
    function trackThinkClock() {
        const now = Date.now();
        for (const thought of asArray(state.thoughts)) {
            let rec = thinkClock.get(thought.id);
            if (rec === undefined) {
                rec = { start: now, end: 0 };
                thinkClock.set(thought.id, rec);
            }
            if (thought.done === true && rec.end === 0) rec.end = now;
        }
        syncThinkTicker();
    }

    /** 一条思考:每一条思考自己一个可折叠块,排在它那段输出前面(不再合并置顶)。 */
    function renderThought(thought) {
        const live = thought.done !== true;
        // 从"思考中"变成"想完了"的那一刻**自动收起**(旧行为,现在一条一条地做)
        if (!live && !thinkDoneSeen.has(thought.id)) {
            thinkDoneSeen.add(thought.id);
            thinkOpenIds.delete(thought.id);
        }
        const translation = (state.translations ?? {})[thought.id] ?? null;
        // 译好的那一刻自动展开:否则用户点了「译」却什么也看不见(条是收着的)。
        if (translation?.status === 'done' && !translatedSeen.has(thought.id)) {
            translatedSeen.add(thought.id);
            showSourceIds.delete(thought.id);
            thinkOpenIds.add(thought.id);
        }
        const lang = (translation?.status === 'done' && !showSourceIds.has(thought.id)) ? 'zh' : 'src';
        const bodyText = (lang === 'zh' && translation?.status === 'done')
            ? translation.text : thought.text;

        const box = el(doc, 'details', 'agent-think');
        if (typeof box.setAttribute === 'function') {
            box.setAttribute('data-live', String(live));   // 自检按它断言,不靠文案
            box.setAttribute('data-translation', translation?.status ?? 'none');
            box.setAttribute('data-lang', lang);
            if (thinkOpenIds.has(thought.id)) box.setAttribute('open', '');
        }
        const sum = el(doc, 'summary', 'agent-think-head');
        sum.appendChild(el(doc, 'span', 'agent-think-caret', '▶'));
        sum.appendChild(el(doc, 'span', 'agent-think-label', live ? '思考中…' : '已思考'));
        // 想了多久:紧跟标签。⚠️ 它必须**在事件边界上记账**(见 thinkClock 的说明),
        //    所以这里只负责把它画出来,不按下秒表。
        const timeEl = el(doc, 'span', 'agent-think-time', thinkElapsedText(thought));
        sum.appendChild(timeEl);
        // 「译」只给**收尾**的思考条:还在流的那条翻了也是白翻(后面还会变长)。
        if (!live) sum.appendChild(translationChips(thought, translation, lang));
        const countEl = el(doc, 'span', 'agent-think-count', `${bodyText.length} 字`);
        sum.appendChild(countEl);
        box.appendChild(sum);
        // ⚠️ 按**换行**把正文切成一行一枚 .agent-think-line:只有切成独立元素,
        //    才可能做到"逐行 + 每行从左到右"(一行一枚才有各自的擦除边)。
        //    ⚠️ live(还在流)时**不切**:增量每来一次就重建,逐行动画会一遍遍重播,
        //    看起来像抽搐。流式期间让它朴实地长,只有**收尾**的思考条才播动效。
        const bodyEl = el(doc, 'div', 'agent-think-body');
        if (live) {
            bodyEl.textContent = bodyText;
        } else {
            String(bodyText).split('\n').forEach((line, i) => {
                const ln = el(doc, 'span', 'agent-think-line', line);
                // 行号 = 错开的唯一输入(见 shell.css 里 calc(var(--think-stagger) * var(--i)))
                if (typeof ln.style?.setProperty === 'function') ln.style.setProperty('--i', String(i));
                bodyEl.appendChild(ln);
            });
        }
        // native <details> 是**瞬开**的:不套一层 grid,就没有"撑开"这一拍。
        const grow = el(doc, 'div', 'agent-think-grow');
        grow.appendChild(bodyEl);
        box.appendChild(grow);
        // 字数、正文与秒数会随增量/时间变:交给快速通道原地改(见 paintLive)
        if (live) {
            liveNodes.thinkCount = countEl;
            liveNodes.thinkBody = bodyEl;
            liveNodes.thinkTime = timeEl;
        }
        // 用户手动展开/收起要记住 —— 否则每次增量重画都会把它复位
        if (typeof box.addEventListener === 'function') {
            box.addEventListener('toggle', () => {
                if (box.open === true) {
                    thinkOpenIds.add(thought.id);
                    // ⚠️ 动效只在**这一次**展开时播,而且播完就把标记摘掉:
                    //    面板会反复重画,若把动画挂在 [open] 上,每次重画都会重播一遍 ——
                    //    那块内容会自己一鼓一鼓地动(典型的"动画没做成一次性"的坑)。
                    if (!live && typeof box.setAttribute === 'function') {
                        box.setAttribute('data-reveal', '1');
                        const clear = () => {
                            if (typeof box.removeAttribute === 'function') box.removeAttribute('data-reveal');
                        };
                        box.addEventListener('animationend', clear, { once: true });
                        if (typeof setTimeout === 'function') setTimeout(clear, 1200);
                    }
                } else thinkOpenIds.delete(thought.id);
            });
        }
        return box;
    }

    /**
     * 思考条上的翻译控件:未译 → 「译」;译中 → 「翻译中…」;译好 → 「中文 / 原文」;
     * 失败 → 「重译」(点一次就是重来)。全是叶子字段的展示,不在这里做协议判断。
     */
    function translationChips(thought, translation, lang) {
        const wrap = el(doc, 'span', 'agent-think-actions');
        const status = translation?.status ?? 'none';

        const chip = (act, label, on) => {
            const btn = el(doc, 'button', on ? 'agent-think-chip on' : 'agent-think-chip', label);
            btn.type = 'button';
            if (typeof btn.setAttribute === 'function') btn.setAttribute('data-act', act);
            btn.addEventListener('click', (event) => {
                // ⚠️ 它在 <summary> 里:不拦住的话点一下会**顺带把这条折叠块开合一次**。
                event?.preventDefault?.();
                event?.stopPropagation?.();
                if (act === 'translate') translate(thought);
                else {
                    if (act === 'src') showSourceIds.add(thought.id);
                    else showSourceIds.delete(thought.id);
                    render();
                }
            });
            return btn;
        };

        if (status === 'pending') {
            wrap.appendChild(el(doc, 'span', 'agent-think-chip busy', '翻译中…'));
            return wrap;
        }
        if (status === 'done') {
            wrap.appendChild(chip('zh', '中文', lang === 'zh'));
            wrap.appendChild(chip('src', '原文', lang === 'src'));
            return wrap;
        }
        wrap.appendChild(chip('translate', status === 'error' ? '重译' : '译', false));
        return wrap;
    }

    /** 点「译」:把这一条交给主进程(它再请桥翻一次)。失败不抛,状态由事件回填。 */
    async function translate(thought) {
        try {
            await calls('agent:translate', { thoughtId: thought.id, text: thought.text });
        } catch (err) {
            log.warn?.('[agent] 翻译失败', err);
        }
    }

    /** 一张工具卡。 */
    function renderTool(tool) {
        const card = el(doc, 'div', 'agent-tool');
        if (typeof card.setAttribute === 'function') {
            card.setAttribute('data-tool-call-id', tool.toolCallId);
            // 状态同时写在**卡片**上(自检按 .agent-tool[data-status] 断言)
            // 与徽标上(CSS 上色用)—— 两份是同一个值,由这里一处写出去。
            card.setAttribute('data-status', tool.status);
        }
        const badge = el(doc, 'span', 'agent-tool-status', toolStatusLabel(tool.status));
        if (typeof badge.setAttribute === 'function') badge.setAttribute('data-status', tool.status);
        card.appendChild(badge);                       // 徽标先建,标题再追加
        card.appendChild(el(doc, 'span', 'agent-tool-title', tool.title));
        if (tool.kind !== '' && tool.kind !== 'other') {
            card.appendChild(el(doc, 'span', 'agent-tool-kind', tool.kind));
        }
        return card;
    }

    /**
     * 一轮的"过程"折成一行(DSH 图二那行「N 次工具调用 ›」)。
     *
     * ⚠️ 里面的卡片**照建不误**,只是挂在 `<details>` 里:折叠是**视觉**行为,不是
     * "把它们从 DOM 里删掉" —— 自检要能 querySelector 到那几张卡,用户点开也要立刻有东西。
     */
    function renderGroup(unit) {
        const key = groupKeyOf(unit);
        const box = el(doc, 'details', 'agent-group');
        // 展开状态:用户手动开过 → 开着;否则看这一组是不是"答案就在里面"(defaultOpen)。
        // ⚠️ `groupClosedIds` 记的是**用户明确收起过**的组 —— 没有它,"默认展开"会把
        //    用户刚收起来的那一组在每次重画时又弹开(与思考条那条 `open` 记忆同一个道理)。
        const open = groupOpenIds.has(key) || (unit.defaultOpen === true && !groupClosedIds.has(key));
        if (typeof box.setAttribute === 'function') {
            box.setAttribute('data-tool-count', String(unit.tools.length));
            box.setAttribute('data-message-count', String(unit.messages.length));
            box.setAttribute('data-live', String(unit.live === true));
            if (unit.defaultOpen === true) box.setAttribute('data-holds-answer', 'true');
            if (open) box.setAttribute('open', '');
        }
        const head = el(doc, 'summary', 'agent-group-head');
        head.appendChild(el(doc, 'span', 'agent-group-caret', '▶'));
        let label = `${unit.tools.length} 次工具调用`;
        if (unit.messages.length > 0) label += ` · ${unit.messages.length} 条消息`;
        head.appendChild(el(doc, 'span', 'agent-group-label', label));
        if (unit.defaultOpen === true) {
            // 让"答案被折在里面"这件事在收起来的时候也看得见(用户手动收起之后)
            head.appendChild(el(doc, 'span', 'agent-group-answer', '含回复'));
        }
        if (unit.live === true) head.appendChild(el(doc, 'span', 'agent-group-live', '运行中'));
        const names = toolNamesOf(unit.tools);
        if (names !== '') head.appendChild(el(doc, 'span', 'agent-group-tools', names));
        box.appendChild(head);
        for (const tool of unit.tools) box.appendChild(renderTool(tool));
        for (const msg of unit.messages) box.appendChild(renderMessage(msg));
        if (typeof box.addEventListener === 'function') {
            box.addEventListener('toggle', () => {
                if (box.open === true) { groupOpenIds.add(key); groupClosedIds.delete(key); }
                else { groupOpenIds.delete(key); groupClosedIds.add(key); }
            });
        }
        return box;
    }

    /**
     * 「这一轮没有文字回复」那一行。
     *
     * 为什么必须有:实测用户看到一屏"2 次工具调用 + 已思考"、一个字答案都没有,
     * 以为**消息丢了**。真相是那一轮模型一路调工具 + 思考就收尾了 —— 界面对此
     * 完全沉默,沉默才是问题。这一行把"有没有答案、细节在哪"明说出来。
     */
    function renderNoReply(unit) {
        const line = el(doc, 'div', 'agent-noreply');
        if (typeof line.setAttribute === 'function') {
            line.setAttribute('data-tools', String(unit.tools));
            line.setAttribute('data-thoughts', String(unit.thoughts));
        }
        const parts = [];
        if (unit.tools > 0) parts.push(`${unit.tools} 次工具调用`);
        if (unit.thoughts > 0) parts.push(`${unit.thoughts} 段思考`);
        line.textContent = parts.length === 0
            ? '这一轮它没有写文字回复。'
            : `这一轮它没有写文字回复 —— 只做了${parts.join(' · ')},细节在上面收起来的那几行里。`;
        return line;
    }

    /**
     * 用户气泡里的一张图。
     *
     * ⚠️ src 来自我们自己 createObjectURL 出来的 blob: URL(见 handOffImages),
     * **不是**对端给的字符串;字节也不在这里、不再走一趟主进程 —— 图本来就在渲染
     * 进程手里。alt 用文件名:它来自剪贴板 = 不可信输入,所以只走 setAttribute
     * 赋属性,绝不拼进任何 HTML 字符串。
     */
    function renderMessageImage(image) {
        const node = doc.createElement('img');
        node.className = 'agent-msg-image';
        node.setAttribute('src', image.url);
        const name = String(image.name ?? '').trim();
        node.setAttribute('alt', name !== '' ? name : '已发送的图片');
        return node;
    }

    /**
     * 用户气泡里"我递进去的那段视频"。
     *
     * 刻意**不做成播放器**:字节只在渲染进程里过一趟 IPC 就交出去了,把它再做成
     * <video> 元素意味着要么留一份 64 MiB 的 blob URL(重画时还得管归属),
     * 要么每次重画重新读一遍文件 —— 两条都不划算。这里只画一张卡片:
     * 文件名 + 大小,文件名走 textContent(它来自用户本机,不可信)。
     */
    function renderMessageVideo(clip) {
        const card = el(doc, 'div', 'agent-msg-video');
        if (typeof card.setAttribute === 'function') card.setAttribute('data-mime', clip.mimeType);
        card.appendChild(el(doc, 'span', 'agent-msg-video-tag', '视频'));
        card.appendChild(el(doc, 'span', 'agent-msg-video-name', clip.name));
        if (clip.byteLength > 0) card.appendChild(el(doc, 'span', 'agent-msg-video-size', formatBytes(clip.byteLength)));
        return card;
    }

    /**
     * 视频理解那一轮的成本读数(挂在助手消息下面)。
     *
     * 为什么要显示 `videoTokens`:那是服务端给的**视频部分真实 token 数**
     * (实测 1080p 4 秒 2378、320×240 4 秒 322),也是这条链路上唯一能拿到的
     * 成本读数。不给它,用户对"这一下花了多少"完全没有概念。
     *
     * 三段耗时(`timings`)是**自标定**那一条:每一次真实运行都把自己的
     * 上传/首字/生成读数写在这里 —— 标定常量因此可以被反复核对,而不是一次定死、
     * 慢慢失真。没有读数(整包那次)就整段不出现,不显示空占位。
     */
    function renderMessageUsage(usage, timings) {
        const parts = [];
        if (usage.videoTokens > 0) parts.push(`视频 ${usage.videoTokens} tokens`);
        if (usage.promptTokens > 0) parts.push(`输入 ${usage.promptTokens}`);
        if (usage.completionTokens > 0) parts.push(`输出 ${usage.completionTokens}`);
        if (usage.model !== '') parts.push(usage.model);
        // 内联 / 临时上传:同一段视频两条路的成本完全不同,值得写在界面上。
        if (usage.mode === 'upload') parts.push('临时上传');
        const nodes = [el(doc, 'div', 'agent-msg-usage', parts.join(' · '))];
        const t = (timings !== null && typeof timings === 'object') ? timings : null;
        if (t !== null) {
            const secs = (ms) => (Number.isFinite(Number(ms)) ? `${(Math.round(Number(ms) / 100) / 10).toFixed(1)}s` : null);
            // ⚠️ 第一段的说法跟着**走的路**变:内联没有"上传"这回事(它只是把请求体直接
            // 发给模型接口),这里写"上传"会让人以为中间过了一次文件传输。
            const sendLabel = usage.mode === 'inline' ? '发送' : '上传';
            const spans = [
                [sendLabel, secs(t.uploadMs)],
                ['首字', secs(t.ttftMs)],
                ['生成', secs(t.generateMs)],
                ['总计', secs(t.totalMs)],
            ].filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`);
            if (spans.length > 0) {
                const line = el(doc, 'div', 'agent-msg-timings', spans.join(' · '));
                if (typeof line.setAttribute === 'function') line.setAttribute('data-timings', 'true');
                nodes.push(line);
            }
        }
        return nodes;
    }

    /**
     * 方案 C 的四段状态行。
     *
     * 画法对着 docs/kaiwu-send-motion-demo.html 里的 `.stages` / `.stage-row`:
     * 每行一个标记(· / ▸ / ✓ / ✕)+ 一句话 + 一条 3px 的条。
     *
     * ⚠️ 条的形态**分两种**(用户报"等待那一段的条一直不动"之后改的):
     *   · **有真百分比**的段(上传)→ 轨道 + 填充,宽度就是那个百分数;
     *   · **没有分母**的段(等待首个字 / 生成正文)→ **不画轨道**,改用一条来回
     *     游走的细光带。为什么:一根永远是 0% 的空轨道,用户读到的是"卡住了",
     *     与我们"拿不到读数就不画条"的原则自相矛盾;而画一条会走的假进度条更糟
     *     (用户会拿它当剩余时间的依据)。光带表达的是"在等、不知道还要多久",
     *     与"进度"是两件事。
     *   收尾后的行(done/failed)两种都不画 —— 那时候它已经不是"正在进行"了。
     */
    function renderVideoStages(stages, { canCancel } = {}) {
        const box = el(doc, 'div', 'stages');
        const refs = new Map();
        for (const stage of asArray(stages)) {
            const row = el(doc, 'div', `stage-row ${stage.state}`);
            if (typeof row.setAttribute === 'function') row.setAttribute('data-stage', stage.key);
            const mark = el(doc, 'span', 'mark', STAGE_MARK[stage.state] ?? '·');
            const body = el(doc, 'div', 'stage-body');
            const label = el(doc, 'span', 'stage-label', videoStageLabel(stage, formatBytes));
            const detail = el(doc, 'span', 'stage-detail', '');
            const bar = el(doc, 'div', 'sbar');
            const fill = el(doc, 'i');
            bar.appendChild(fill);
            body.appendChild(label);
            body.appendChild(detail);
            body.appendChild(bar);
            row.appendChild(mark);
            row.appendChild(body);
            box.appendChild(row);
            refs.set(stage.key, { row, mark, detail, bar, fill });
        }
        // 取消只在这一轮**还在飞**的时候出现(收尾后的状态行是历史,取消没有意义)
        if (canCancel === true) {
            const btn = el(doc, 'button', 'btn btn-sm stage-cancel', '取消');
            btn.type = 'button';
            if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', '取消这次理解');
            btn.addEventListener('click', () => cancelVideo());
            box.appendChild(btn);
        }
        return { node: box, refs };
    }

    /** 一条消息气泡(用户 / 助手)。 */
    function renderMessage(msg) {
        const bubble = el(doc, 'div', `agent-msg agent-msg-${msg.role}`);
        if (typeof bubble.setAttribute === 'function') {
            bubble.setAttribute('data-role', msg.role);
            if (msg.done !== true) bubble.setAttribute('data-streaming', 'true');
        }
        // 用户自己发出去的图(状态里是 blob: URL 这种叶子字段)。这里**只挂节点**:
        // URL 不在这里撤销 —— 它的归属见 handOffImages / releaseMessageImages。
        const images = msg.role === 'user' ? asArray(msg.images) : [];
        if (images.length > 0) {
            const imageRow = el(doc, 'div', 'agent-msg-images');
            for (const image of images) imageRow.appendChild(renderMessageImage(image));
            bubble.appendChild(imageRow);
        }
        // 视频卡片(用户递进去的那一段)。
        if (msg.video !== null && typeof msg.video === 'object' && String(msg.video.name ?? '') !== '') {
            bubble.appendChild(renderMessageVideo(msg.video));
        }
        // 方案 C 的四段状态行(只有视频理解那一轮在飞时才有;收尾后 stages 已被摘掉)。
        const stages = asArray(msg.stages);
        if (stages.length > 0) {
            const rendered = renderVideoStages(stages, { canCancel: msg.done !== true });
            paintVideoStages(stages, rendered.refs);
            bubble.appendChild(rendered.node);
            // 机器可读的标记:这条气泡此刻装的是**状态行**,不是回答。
            // 自检与"找那条真回复"的地方据此把它排除掉 —— 靠"第几条"去找,
            // 迟早会被前面留下的状态行带偏(已经踩过一次)。
            if (typeof bubble.setAttribute === 'function') bubble.setAttribute('data-stages', 'true');
            // 快速通道要原地改的那几个节点(改的是百分比/秒数,不是结构)
            if (liveNodes !== null) liveNodes.stages = { stages, refs: rendered.refs };
        }
        const textEl = el(doc, 'div', 'agent-msg-text');
        // 流式中的正文:整段再包一层 `.agent-sweep`,让扫光只作用在**文字**上。
        // ⚠️ 为什么不能直接给 `.agent-msg-text` 加 background-clip:text:
        // 那一下会把气泡自己的底也一起裁进字形里 —— 气泡背景"消失",看起来像
        // 流式中途换了一套样式(实测踩到过)。扫光层与气泡层必须分开。
        // (.agent-sweep 在 CSS 里是 display:block —— 百分比 background-position
        //  要有个确定参照宽度,行内折行后光带落点会随文字长度乱跳,见 shell.css。)
        // 最后几个字再单独包一层,交给 .agent-tail 显影:它自己裁一层**半透明**罩子
        // 画在父层文字之上,所以扫光的亮带仍然透得出来(用 mask 是无效的,已实测推翻)。
        // 一律用 textContent 赋值(正文来自模型,不解析标记)。
        if (msg.done !== true) {
            const sweep = el(doc, 'span', 'agent-sweep');
            if (msg.text.length > TAIL_CHARS) {
                const head = el(doc, 'span', '', msg.text.slice(0, -TAIL_CHARS));
                const tail = el(doc, 'span', 'agent-tail', msg.text.slice(-TAIL_CHARS));
                sweep.appendChild(head);
                sweep.appendChild(tail);
                liveNodes.sweepHead = head;
                liveNodes.sweepTail = tail;
            } else {
                sweep.textContent = msg.text;
            }
            textEl.appendChild(sweep);
            // 这一层与它的两个子节点会一直被原地改文字(见 paintLive)——
            // 重建就等于把扫光/光标动画从头开始,所以只在这一条流式消息上留引用。
            liveNodes.sweep = sweep;
        } else if (msg.role === 'assistant') {
            // 收尾后的助手回复:渲染常用子集的 Markdown。
            // ⚠️ 走的是**建节点**那条路(createElement / createTextNode),面板里依然一个
            // innerHTML 都没有 —— 模型给的 `<img onerror=...>` 只会是一段文字。
            // ⚠️ 为什么只在收尾后做:流式期间那套扫光/末字显影是直接切文本节点的,
            // 中途插进 <strong>/<p> 会把动画每次都从头开始,也破坏"增量不重建 DOM"。
            textEl.className = 'agent-msg-text md';
            for (const node of renderMarkdownNodes(doc, msg.text)) textEl.appendChild(node);
        } else {
            // 用户气泡**不排版**:那是用户自己说的话,而且自检夹具回显的那条带着
            // `当前笔记:…` + frontmatter 的 `---` 与 `# 甲篇`,排版会把它画成标题与分隔线。
            textEl.textContent = msg.text;
        }
        // ⚠️ 只发图没写字时(输入框为空的那次发送)文本这一层**不挂上去**:
        // 挂了就是一个空的 .agent-msg-text,气泡里凭空多出一条空白高度。
        // 方案 C 的状态行占位同理(它此刻还没有正文)。
        // 纯文字那条路完全不变(没有图也没有状态行时这个条件恒真,与从前逐像素一致)。
        if (msg.text !== '' || (images.length === 0 && stages.length === 0)) bubble.appendChild(textEl);
        // 视频理解那一轮的成本读数(只有带 usage 的消息才有;其余消息形状不变)。
        if (msg.usage !== null && typeof msg.usage === 'object') {
            for (const node of renderMessageUsage(msg.usage, msg.timings ?? null)) bubble.appendChild(node);
        }
        return bubble;
    }

    /**
     * 把一段行的**读数**刷进已经建好的节点(结构不动,只改文字/宽度/类名)。
     *
     * 为什么要单独一个刷函数:上传百分比一次跑 100 个点(实测 pullCount=171),
     * 每点一次都重建整条消息列表是纯粹的浪费,而且会把扫光动画从头开始。
     * 结构变化(多一行/少一行/状态翻转)才走重建那条路(见 shapeOf)。
     */
    function paintVideoStages(stages, refs) {
        if (refs === null || refs === undefined) return;
        for (const stage of asArray(stages)) {
            const ref = refs.get(stage.key);
            if (ref === undefined) continue;
            if (typeof ref.row.setAttribute === 'function') ref.row.setAttribute('data-state', stage.state);
            ref.row.className = `stage-row ${stage.state}`;
            ref.mark.textContent = STAGE_MARK[stage.state] ?? '·';
            // ⚠️ 等待那一行的秒数是**本地时钟**算的,不是服务端给的 —— 它每 ~0.25 秒
            // 变一次,所以由计时器触发重画(见 startStageTicker)。
            const waitSeconds = (stage.key === 'wait' && waitStartedAt > 0)
                ? (Date.now() - waitStartedAt) / 1000 : null;
            let text = stageDetailText(stage, { waitSeconds });
            let title = '';
            // 估计值只在这一段**刚开始**时贴一次(标定可信才贴),不去跟秒数抢位置。
            if (stage.key === 'wait' && stage.state === 'doing' && stageEstimateText !== '') {
                text = text === '' ? stageEstimateText : `${text} · ${stageEstimateText}`;
                // 出处挂在悬停里:粗话留给一眼扫过的人,两个样本各自怎么来的留给要核对的人
                title = stageEstimateTitle;
            }
            ref.detail.textContent = text;
            if (typeof ref.detail.setAttribute === 'function') ref.detail.setAttribute('title', title);
            // 条的形态:有真百分比 → 轨道 + 填充;正在做但**没有分母** → 不画轨道,
            // 换成一条来回游走的细光带(不确定态);收尾/失败 → 什么都不画
            // (位置留着,免得整块高度跳一下)。
            const raw = stage.percent;
            const hasPct = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw));
            const mode = hasPct ? '' : (stage.state === 'doing' ? ' indeterminate' : ' idle');
            const cls = `sbar${mode}`;
            if (ref.bar.className !== cls) ref.bar.className = cls;
            ref.fill.style.width = hasPct ? `${Math.max(0, Math.min(100, Number(raw)))}%` : '';
        }
    }

    /**
     * 一个渲染单元 → 一个节点(原来 inline 在 renderMessages 里,现在按轮分包也要用它)。
     */
    function renderUnit(unit) {
        if (unit.kind === 'thought') return renderThought(unit.thought);
        if (unit.kind === 'tool') return renderTool(unit.tool);
        if (unit.kind === 'group') return renderGroup(unit);
        if (unit.kind === 'noReply') return renderNoReply(unit);
        return renderMessage(unit.message);
    }

    function renderMessages() {
        // 快速通道:只有文本在长(结构一个字节都没变)时,别把 DOM 推倒重来。
        const units = planTimeline(state);
        const shape = shapeOf(units);
        if (shape === renderedShape && liveNodes !== null) {
            paintLive(liveOf(units));
            return;
        }
        liveNodes = { thinkCount: null, thinkBody: null, thinkTime: null, sweep: null, sweepHead: null, sweepTail: null, stages: null };
        // 按**有序时间线**画:思考内联在它那段输出前面、工具与中间回复折成一行。
        // ⚠️ 外面还要按**轮**包一层 `.agent-turn`:轮次轨要拿每一轮的盒子算 offset
        // 与跳转,没有这一层就只能按"第几条消息"猜边界。分包是纯函数(groupTurns)。
        const parts = [];
        const { pre, turns } = groupTurns(units);
        for (const unit of pre) parts.push(renderUnit(unit));
        turns.forEach((turn, i) => {
            const box = el(doc, 'div', 'agent-turn');
            if (typeof box.setAttribute === 'function') box.setAttribute('data-turn', String(i));
            for (const unit of turn) box.appendChild(renderUnit(unit));
            parts.push(box);
        });
        if (parts.length === 0) {
            parts.push(el(doc, 'p', 'hint', '还没有对话。直接问吧 —— 问题会带上当前打开的笔记。'));
        }
        replaceChildren(streamEl, parts);
        // 记下这一版的结构:下一次只有文本变长时就不再重建(见函数开头的快速通道)
        renderedShape = shape;
    }

    // ---------- 会话轮次导航轨(方案 D:状态语义轨)----------
    //
    // 一列格子 = 会话轮次。三件事:
    //   ① **可读**:颜色 = 这一轮的状态(灰=正常 / 蓝=含工具调用 / 红=失败 / 绿=当前轮),
    //      悬停/聚焦给一句中文摘要 —— 颜色编码必须能在文字里学到,否则等于没编码;
    //   ② **可点**:点一格平滑滚到那一轮;
    //   ③ **联动**:滚动时算出"当前是第几轮",那一格常亮(不是悬停才出现)。
    //
    // ⚠️ 性能:offset 是**预计算**的(每次重画/尺寸变化后算一遍),滚动回调里只排一帧、
    // 在帧里才读 layout —— 轮次多了也不会每帧强制重排。
    // ⚠️ 不画"轮内进度条":demo 里那根细条是演示用的假进度(定时器喂的)。真机上
    // "生成正文"没有分母,按这一轮反复确立的规矩 —— **没有真分母就不画填充条**。

    /** 滚动/重画之后只排一帧;真正的 layout 读发生在那帧里。 */
    function scheduleRailFrame() {
        if (railFramePending === true) return;
        railFramePending = true;
        const run = () => {
            railFramePending = false;
            measureRail();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
    }

    /** 量一遍每一轮的 offset(唯一读 layout 的地方),再据此更新"当前轮"高亮。 */
    function measureRail() {
        // ⚠️ 优先 querySelectorAll(真 DOM 都有);替身/老外壳只实现了 query/queryAll,
        // 于是退回那一套 —— 少一个方法不该让整条轨不见(面板里别处也是这么兜的)。
        if (typeof streamEl?.querySelectorAll === 'function') turnEls = [...streamEl.querySelectorAll('.agent-turn')];
        else if (typeof streamEl?.queryAll === 'function') turnEls = streamEl.queryAll('.agent-turn');
        else turnEls = [];
        // ⚠️ 量不到(替身 DOM / 还没布局)时给 NaN,交给 currentTurnIndex 跳过 ——
        // 不要用 0 假装"都在顶部",那会让高亮落在最后一轮上。
        turnOffsets = turnEls.map(node => Number(node?.offsetTop));
        updateRailCurrent();
    }

    function updateRailCurrent() {
        if (railTicks.length === 0) return;
        const el = messagesEl;
        const top = (el !== null && typeof el.scrollTop === 'number') ? el.scrollTop : 0;
        // 滚到底就认最后一轮:最后一轮的 offsetTop 常落在可滚范围之外(内容比视口高不出
        // 整整一轮),只按 offset 比会永远高亮倒数第二轮(真机实测踩到过)。
        const atBottom = el !== null && typeof el.scrollHeight === 'number' && typeof el.clientHeight === 'number'
            && el.scrollHeight > el.clientHeight
            && (top + el.clientHeight) >= (el.scrollHeight - 2);
        const next = currentTurnIndex(turnOffsets, top, { atBottom });
        if (next === railCurrent) return;
        railCurrent = next;
        paintRailTicks();
    }

    /** 滚动事件:只做两件便宜的事(藏摘要 + 排一帧),绝不在回调里读 layout。 */
    function onMessagesScroll() {
        hideRailTip();
        scheduleRailFrame();
    }

    /** 面板/窗口尺寸变了:轮次的位置跟着变,下一帧重新量。 */
    function onPanelResize() {
        scheduleRailFrame();
    }

    /**
     * **轨上的滚轮转发给消息区**。
     *
     * 为什么必须转发:轨正好占了原来滚动条的位置,用户的肌肉记忆会把滚轮放在那一列上。
     * 我们显式转发一次(而不是指望浏览器)—— 于是"滚轮落在轨上"这件事在两种结构下都成立。
     * ⚠️ 只拦纵向:横向滚轮(触控板横滑)不接,也不 preventDefault(那是别的手势,抢了就变成 bug)。
     */
    function onRailWheel(event) {
        const { handled, delta } = wheelScrollDelta(event);
        if (handled !== true || messagesEl === null) return;
        if (typeof event?.preventDefault === 'function') event.preventDefault();
        messagesEl.scrollTop = Math.max(0, messagesEl.scrollTop + delta);
        scheduleRailFrame();
    }

    function jumpToTurn(index) {
        const node = turnEls[index];
        if (node === undefined || messagesEl === null) return;
        const top = Math.max(0, (Number(node.offsetTop) || 0) - 4);
        if (typeof messagesEl.scrollTo === 'function') messagesEl.scrollTo({ top, behavior: 'smooth' });
        else messagesEl.scrollTop = top;
        // 平滑滚动期间先高亮目标轮,别等 rAF 追上来(否则点完那一格还要等一两帧才亮)
        railCurrent = index;
        paintRailTicks();
    }

    function hideRailTip() {
        if (railTip === null) return;
        const tip = railTip;
        railTip = null;
        // 同样兜一手:替身/老外壳可能只有 removeChild,没有 Element.remove()
        if (typeof tip.remove === 'function') tip.remove();
        else if (tip.parentNode !== null && typeof tip.parentNode?.removeChild === 'function') tip.parentNode.removeChild(tip);
    }

    /** 悬停/聚焦摘要。挂在**面板**上(不挂进轨):滚动区有 overflow,挂里面会被裁掉。 */
    function showRailTip(tickEl, model) {
        hideRailTip();
        if (panel === null || typeof panel.appendChild !== 'function') return;
        const text = summarizeTurn(model);
        const tip = el(doc, 'div', 'agent-rail-tip');
        tip.appendChild(el(doc, 'div', 'h', text.title));
        if (text.question !== '') tip.appendChild(el(doc, 'div', 'q', text.question));
        if (text.timings !== undefined) tip.appendChild(el(doc, 'div', 's', text.timings));
        panel.appendChild(tip);
        railTip = tip;
        // 与那一格的竖直中心对齐。一次 hover 读一次 layout 是没问题的 —— 每帧读才有问题。
        const r = typeof tickEl?.getBoundingClientRect === 'function' ? tickEl.getBoundingClientRect() : null;
        const pr = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null;
        if (r !== null && pr !== null && r.height > 0) {
            tip.style.top = `${Math.round(r.top - pr.top + (r.height / 2))}px`;
        }
    }

    /** 把每格的类名/aria 刷一遍(便宜,只在重画与当前轮变化时调)。 */
    function paintRailTicks() {
        railTicks.forEach((btn, i) => {
            const model = railModels[i] ?? { status: 'ok' };
            const classes = ['tick', model.status];
            if (i === railCurrent) classes.push('cur');
            if (i === railLive) classes.push('live');
            if (i === railNewIndex) classes.push('new');
            const cls = classes.join(' ');
            if (btn.className !== cls) btn.className = cls;
            const label = tickAriaLabel(i, model.status);
            if (typeof btn.setAttribute === 'function') {
                btn.setAttribute('aria-label', label);
                if (i === railCurrent) btn.setAttribute('aria-current', 'true');
                else if (typeof btn.removeAttribute === 'function') btn.removeAttribute('aria-current');
            }
        });
    }

    function buildRailTicks(models, { markNew = false } = {}) {
        hideRailTip();
        railNewIndex = markNew === true ? models.length - 1 : -1;
        railTicks = models.map((model, i) => {
            const btn = el(doc, 'button', 'tick');
            btn.type = 'button';
            btn.appendChild(el(doc, 'i', 'mark'));
            btn.addEventListener('click', () => jumpToTurn(i));
            btn.addEventListener('mouseenter', () => showRailTip(btn, model));
            btn.addEventListener('mouseleave', hideRailTip);
            btn.addEventListener('focus', () => showRailTip(btn, model));
            btn.addEventListener('blur', hideRailTip);
            return btn;
        });
        replaceChildren(railEl, railTicks);
        paintRailTicks();
    }

    /**
     * 重画整条轨。判据:格数或状态变了才重建格子,否则只刷类名 —— 每帧重建按钮
     * 会把悬停/焦点也一起吹掉。
     */
    function renderRail() {
        const { turns } = groupTurns(planTimeline(state));
        const last = turns.length - 1;
        railModels = turns.map((turn, i) => ({
            index: i,
            question: turnQuestion(turn),
            status: turnStatus(turn, { isLast: i === last, error: state.error }),
            timings: turnTimings(turn),
        }));
        railLive = liveTurnIndex(turns.length, { busy: state.busy === true });
        // 一轮没有导航价值:常驻一列反而占视觉(也会把唯一那条消息挤窄)
        railEl.hidden = turns.length < 2;
        const key = `${turns.length}|${railModels.map(m => m.status).join(',')}|${railLive}`;
        if (key !== railKey) {
            const grew = turns.length > railSeenCount;
            buildRailTicks(railModels, { markNew: grew });
            railKey = key;
        }
        railSeenCount = turns.length;
        scheduleRailFrame();
    }

    /**
     * 权限区:授权卡与**提问卡**两种。
     *
     * 它们共用一条回答通道(agent:permission)、也共用"恰好回答一次"的保证
     * (answered 集合是关键的那一道,超时按取消)—— 差别只在**画法**:
     * 提问是"帮我选一个",授权是"要不要放行",让人一眼分得清。
     *
     * ⚠️ **寿命**上两类现在也一致(产品负责人原话:"这个请求完也删"):答完就**消失**。
     *    授权卡原来答完留在原地(靠 shell.css 那条 opacity:.7 淡化),理由是它算
     *    "这一轮放行了什么"的记录;现在那条记录行为作废 —— 于是两类卡只差画法,
     *    不再有"寿命"上的差别。
     */
    function renderPermissions() {
        const parts = [];
        for (const perm of state.permissions) {
            const isQuestion = perm.question === true;
            // 已决的卡**直接不画**,两类一致(授权卡:请求完也删;提问卡:问完就删)。
            // 它以前只是被淡化到 70%(shell.css 那两条已随这次改动删掉),用户看到的
            // 还是"卡留在原地、只是变灰了" —— 那不是"消失"。
            //
            // ⚠️ 判定用的就是 `perm.resolved`:它是"这个请求已经被回答过"的那一个布尔,
            //    由 resolvePermission() 在发回答的同一刻标上,与 answered 集合同步。
            //    上一轮这里带的是 `isQuestion &&`(只跳提问卡),产品现在要求两类一致,
            //    那个保留被推翻 —— 单看 perm.resolved 就是新的判据。
            if (perm.resolved) continue;
            const card = el(doc, 'div', isQuestion ? 'agent-question' : 'agent-permission');
            if (typeof card.setAttribute === 'function') {
                // data-request-id 留着:自检按它找这张卡(`.agent-permission[data-request-id]`)。
                //
                // ⚠️ 这里原来还写 data-decided / data-resolved(面板"记住用户选了哪一个")。
                //    已决的卡现在整个不画,于是这两处写入只会是"永远空值 / 永远不设置"
                //    —— 死代码,连 shell.css 里只认它们的 `.agent-permission[data-resolved="true"]`
                //    一起删了(谁都不再读)。
                //    "用户选了哪一个"没有丢:那份记录在 state.permissions[].decided
                //    (resolvePermission() 写的),只是不再往一个界面留不住的 DOM 上刻一份。
                card.setAttribute('data-request-id', perm.requestId);
            }
            if (isQuestion) {
                const head = el(doc, 'div', 'agent-question-head');
                head.appendChild(el(doc, 'span', 'agent-question-tag', '提问'));
                head.appendChild(el(doc, 'span', 'agent-question-title', perm.title));
                card.appendChild(head);
            } else {
                card.appendChild(el(doc, 'div', 'agent-permission-title', perm.title));
            }
            for (const option of perm.options) {
                const btn = el(doc, 'button', isQuestion ? 'agent-question-opt' : 'btn btn-sm', option.name);
                btn.type = 'button';
                if (typeof btn.setAttribute === 'function') {
                    btn.setAttribute('data-option-id', option.optionId);
                }
                if (isQuestion && option.description !== '') {
                    btn.appendChild(el(doc, 'span', 'agent-question-desc', option.description));
                }
                // 已决的卡在上面就被跳过了,所以这一行现在**走不到 true** —— 它是
                // 故意留着的第二道防线(万一将来又放行一张已决的卡,按钮也不该可点),
                // "恰好回答一次"真正的保证仍然是 answerPermission() 里的 answered 集合。
                btn.disabled = Boolean(perm.resolved);
                btn.addEventListener('click', () => answerPermission(perm.requestId, option.optionId));
                card.appendChild(btn);
            }
            parts.push(card);
        }
        replaceChildren(permsEl, parts);
    }

    function renderStatus() {
        const status = state.status;
        const text = STATE_LABEL[status.state] ?? status.state;
        // 状态文字写进的是**视觉隐藏的 live 区**(读屏用)。面板上不显示连接状态 ——
        // 用户要求"默认都是连接":正常情况下一眼看去只有对话与输入卡片。
        if (stateText) stateText.textContent = `Agent:${text}`;
        let detail = status.error ?? '';
        if (state.error !== null && state.error !== undefined) {
            detail = state.error.message;
        }
        if (stateDetail) stateDetail.textContent = detail === '' ? '' : ` — ${detail}`;

        const running = status.state === 'ready' || status.state === 'starting';
        const broken = status.state === 'failed' || status.state === 'crashed';
        // 重试按钮是"把人接上"的入口,所以三种情形都得可用:
        //   自动连过(autoStart=true)—— 只有出了错才需要它(连上了再点没有意义);
        //   不自动连(autoStart=false,自检走这条)—— 它**就是**唯一入口,一直可点;
        //   刚按过「停止进程」—— 进程是自己停掉的,没有"失败"可看,但也得能再接上。
        const retryAvailable = autoStart ? (broken || starting || killRequested) : true;
        // ⚠️ 「发送」在**有视频草稿**时必须可点,哪怕 Agent 没连上:视频理解根本
        // 不经过 Agent(它由主进程直接 POST 给 DashScope)。照着"没连上就禁用"写,
        // 用户就会拖进视频、点一个灰按钮、然后什么都看不到 —— 而他并没有做错什么。
        // 一颗球之后这条判据**一个字没变**,只是多了一个条件:执行中它变成「取消」,
        // 那时候**永远可点**(取消是唯一出路,绝不能是灰的)。
        setDisabled(sendBtn, state.busy !== true && !running && pendingVideo === null);
        if (sendBtn) {
            // 空闲=发送、执行中=取消:同一颗球,名字与"能不能点"都跟着 busy 走。
            // 文案仍然用旧的字符串(「发送」/「取消当前提示」)—— 换的是控件,不是语义;
            // 自检与单测里那两条断言量的也正是这两个词。
            const orbLabel = state.busy === true ? '取消当前提示' : '发送';
            setAria(sendBtn, 'aria-label', orbLabel);
            attr(sendBtn, 'title', orbLabel);
            attr(sendBtn, 'data-mode', state.busy === true ? 'cancel' : 'send');
            // ---- 状态脸:形状归状态、位置归注视(表在 app/lib/robot-face.js 的 FACES)----
            // ⚠️ 这一段是**纯表现层**,绝不能影响状态机:renderStatus 后面才写 data-agent-state,
            //    这里若抛异常,状态属性就永远停在旧值(实测:崩溃态显示成 ready、撕裂层也建不出来 ——
            //    两个症状同一个根因)。所以整段 try/catch,并把错误留成叶子属性给人看。
            const face = deriveFace(status, state, videoBusy);
            if (face !== currentFace) {
                currentFace = face;
                try {
                    attr(sendBtn, 'data-face', face);
                    attr(panel, 'data-face', face);
                    // ⚠️ 撕裂层(9 张脸副本 + 一堆动画)**只在连不上时存在**:
                    //    进这一态才建,一离开就整体回收 —— 节点移除,动画随之消失(CPU 也随即归零)。
                    tearSlices = (face === 'failed') ? (ensureTear() === null ? 0 : TEAR_SLICES) : dropTear();
                    attr(panel, 'data-face-error', '');
                } catch (err) {
                    tearSlices = 0;
                    attr(panel, 'data-face-error', String((err && err.message) || err));
                }
            }
            // 机器可读的叶子属性:**每次渲染都写**(只在"脸变了"时写的话,回收之后它会停在旧值上:
            // 实测 hosts=0 而 data-tear 还是 9 —— 自检读到的就是一条假证据)。
            // ⚠️ data-tear **以 DOM 为准**(不读那个变量 —— 变量与 DOM 一旦不同步,自检读到的就是假证据;
            // 实测就撞到过 hosts=0 而它还是 9 的那次)。
            const tearHostNow = (sendBtn !== null && typeof sendBtn.querySelector === 'function')
                ? sendBtn.querySelector('.agent-orb-tear') : null;
            attr(panel, 'data-tear', String(tearHostNow !== null && tearHostNow.children ? tearHostNow.children.length : 0));
            attr(panel, 'data-gaze-scale', String(gazeScale(currentFace === null ? 'idle' : currentFace)));
            growInput();                                    // 输入区高度永远跟着值走(清空就收回去)
        }
        setDisabled(retryBtn, !retryAvailable);
        // ⚠️ 「停止进程」是**出事才出现**的按钮(用户要求:那一行平时是空的、连状态点都没有)。
        // 判据是"现在有没有东西可停":
        //   · 正在起(starting)—— 起的过程就可能卡住,这正是要停的时刻;
        //   · 正在跑一次(state.busy)—— 正常从眼前消失;卡住时它就是唯一出路;
        //   · 已经坏了(failed/crashed)—— 进程可能还在,得能收尸。
        // 反过来,`ready` 且手上没活、以及用户自己停掉的 `stopped`,都**不显示** ——
        // 那时点它没有任何意义。它出现的**位置不变**(还是输入卡片顶端那一行),
        // 所以"卡住了去哪儿按"这件事不需要重新学。
        // 另一条常驻入口在「设置 → AI 与 Agent → 停止 Agent 进程」(找不到这一行时用)。
        //
        // ⚠️ **整行的显隐跟着按钮走**:那一行平时只有这个按钮,按钮不在场时它必须 `hidden`
        // (CSS 里是 display:none)—— 否则它会留一条 20px 空行加一段下间距,
        // 而用户要的是"聊天框上面干净"。按钮在场时这一行才有 20px(上一轮钉的不变量:
        // 出现时 20、不出现时不占位)。
        const killNeeded = status.state === 'starting' || broken || (running && state.busy);
        setHidden(killBtn, !killNeeded);
        setDisabled(killBtn, !killNeeded);
        // ⚠️ 「正在连接 Agent…」:握手超时是 35 秒(见 agent-runtime 的
        // DEFAULT_HANDSHAKE_TIMEOUT_MS),那段时间里面板**不能是一片静止** ——
        // 否则用户只会看见一个没头没尾的「停止进程」按钮,以为界面坏了。
        // 只说"正在连接",**不写数字也不画进度条**:分母(这一台机器这次要多久)
        // 根本不存在,写了就是把猜的数字当承诺(与项目里"没有真分母就不画"同一条规矩)。
        // 只在 `starting` 时出现:失败/崩了有对话里的提示卡说原因,那比这句更有信息。
        const connecting = status.state === 'starting';
        if (ctxHintEl !== null) {
            if (connecting === true && String(ctxHintEl.textContent ?? '') === '') {
                ctxHintEl.textContent = '正在连接 Agent…';
            }
            setHidden(ctxHintEl, !connecting);
        }
        setHidden(ctxRowEl, !killNeeded);
        // 提示卡两种来由:连不上(broken)或**用户自己刚把进程停掉**(killRequested)。
        // 后者不是错误,但同样"什么都不能做" —— 所以同样要在对话里给出「重试」。
        renderNotice(broken || killRequested, detail, killRequested && !broken);
        // 机器可读的连接状态(data-agent-state)。自检不靠中文文案断言 ——
        // 文案会改,这个属性不会。取值就是监护人的状态名。
        if (panel && panel.dataset) panel.dataset.agentState = status.state;
        // 当前会话 id 也挂一个机器可读的口子。
        // 为什么需要:「AI 会话」那栏点一条会话之后,面板到底**切没切过去**只能从外面问 ——
        // 自检据它断言"接着聊真的换了会话"(靠看中文提示是验不出这件事的)。
        if (panel && panel.dataset) {
            panel.dataset.sessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
        }
    }

    /**
     * 出问题时**在对话里**说清楚,并把「重试」搬到那张提示卡上。
     *
     * 为什么放在对话里而不是顶部状态栏:面板平时不显示任何连接状态(默认就是连接),
     * 但"连不上"必须让人看得见 —— 否则用户打了字、什么都没发生,还以为是自己没按对。
     * 提示卡是 #agentMessages 的第一个孩子,所以它跟着对话一起滚,不会像状态栏那样
     * 把面板的视觉重心拽走。
     *
     * @param {boolean} show 要不要出现(连不上 / 刚被用户停掉)
     * @param {string} detail 失败原因(连不上时才有)
     * @param {boolean} killed true = 这次是"用户自己停掉的",话得换一句(不是错误)
     */
    function renderNotice(show, detail, killed = false) {
        if (!messagesEl) return;
        if (!show) {
            if (noticeEl !== null && noticeEl.parentNode) noticeEl.parentNode.removeChild(noticeEl);
            // 「重试」回到隐藏的 live 区里待命(节点不销毁,监听器与 id 都留着)
            if (retryBtn && statusEl && retryBtn.parentNode !== statusEl) statusEl.appendChild(retryBtn);
            return;
        }
        if (noticeEl === null) {
            noticeEl = el(doc, 'div', 'agent-notice');
            noticeEl.appendChild(el(doc, 'span', 'agent-notice-text'));
        }
        const textEl = noticeEl.querySelector?.('.agent-notice-text') ?? noticeEl.children?.[0] ?? null;
        // 自己停掉的不是故障:别写成"连不上"(那会让用户以为出错了),
        // 但必须说清**下一步按哪儿**再连 —— 这是这次"把停止按钮挪出那一行"留下的唯一出口。
        if (textEl) {
            textEl.textContent = killed === true
                ? 'Agent 进程已经停掉 —— 点「重试」再连上。'
                : `连不上 Agent:${detail === '' ? '原因不明' : detail}`;
        }
        if (retryBtn && retryBtn.parentNode !== noticeEl) noticeEl.appendChild(retryBtn);
        if (noticeEl.parentNode !== messagesEl) {
            // 插在消息流之前:它是"关于这次连接"的说明,不是一条消息
            if (typeof messagesEl.insertBefore === 'function') {
                messagesEl.insertBefore(noticeEl, messagesEl.firstChild ?? null);
            } else {
                messagesEl.appendChild(noticeEl);
            }
        }
    }

    /**
     * 把"这次会带上哪篇笔记"写到**输入框**上(那一行上的文字与状态点都按用户要求删掉了)。
     *
     * 为什么是输入框的两个位置(而不是再造一个指示器):这条信息不能丢 —— 它决定了
     * "这次发送到底带不带上下文";而输入框本来就在用户眼前:
     *   · `placeholder` 一眼看得见 → 放**短**的那句(笔记名过长按码点截断);
     *   · `title` 悬停看得见 → 放**完整**的那句(全名)。
     * 没有打开的笔记时两处都写同一句话(NO_NOTE_CONTEXT)。
     * 机器可读的那一份照旧在 `.agent-footer[data-ctx]` 上(自检不靠中文断言)。
     * 文案由纯函数 describeNoteContext 出(单测逐字钉着,判据与 buildPromptText 同口径)。
     */
    function renderContext() {
        const ctx = describeNoteContext(readNote());
        if (input !== null && input !== undefined && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
        // ⚠️ 用户要求删掉 placeholder 那句可见文字 —— 信息**一个字都没丢**,改走三条非视觉出口:
        //    title(悬停可见,仍是完整那句)/ aria-label(读屏念得到)/ data-ctx·data-ctx-text(机器可读)。
            // title 是"完整的那一句":输入框本身的框里装不下全名,悬停才是它的出路
            input.title = ctx.full;
        setAria(input, 'aria-label', '对 AI 提问(回车发送,Shift+回车换行)。' + ctx.full);
        }
        if (footerEl && footerEl.dataset) {
            footerEl.dataset.ctx = ctx.bound === true ? 'note' : 'none';
            // 也给一份机器可读的原文:断言不该依赖中文
            footerEl.dataset.ctxText = ctx.full;
        }
    }

    function render() {
        renderQueued = false;
        // 先把**已经没有任何消息引用**的气泡图片 URL 回收掉(清空会话 / 换会话)。
        // 还留在状态里的一个都不碰 —— 撤销了就是破图(见 handOffImages 的归属说明)。
        releaseMessageImages();
        const active = doc?.activeElement ?? null;
        const wasFocused = active !== null && active === input;
        renderStatus();
        renderPermissions();
        renderMessages();
        // 会话 id 挂成机器可读的属性(**每次重画都刷**,不只在状态渲染那次)。
        // ⚠️ 为什么不能只写在 renderStatus 里:「AI 会话」那栏点一条会话之后,面板收的是
        //    一条 `session` 事件 —— 状态没变,于是 renderStatus 里那行**不会重写**,
        //    从外面读到的还是旧会话(自检实测:切过去了但读数说没切)。
        if (panel && panel.dataset) {
            panel.dataset.sessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
        }
        // 输入行那枚「思考强度 / 模型」胶囊(数据来自对端的 configOptions)
        cfgPaint();
        // 轮次轨要在消息重画**之后**刷:它按当前 DOM 里的轮次盒子量 offset。
        // (它自己也是幂等的:格数与状态没变时只刷类名,不重建按钮 —— 重建会把
        //  悬停与焦点一起吹掉,而用户很可能正悬在某一格上看摘要。)
        renderRail();
        renderContext();
        if (wasFocused) {
            try { input.focus(); } catch { /* 隐藏元素上聚焦会失败,不影响功能 */ }
        }
        scrollToBottom();
    }

    function scheduleRender() {
        if (renderQueued) return;
        renderQueued = true;
        if (typeof queueMicrotask === 'function') queueMicrotask(() => { if (renderQueued) render(); });
        else render();
    }

    function readNote() {
        let note = null;
        try {
            note = getNote?.() ?? null;
        } catch (err) {
            log.warn?.('[agent] 取当前笔记失败', err);
            note = null;
        }
        if (note === null || typeof note !== 'object') return null;
        return {
            title: String(note.title ?? ''),
            path: String(note.path ?? ''),
            text: String(note.text ?? ''),
        };
    }

    // ---------- 动作 ----------

    /**
     * 挂载即自动来一次;失败不是致命的 —— 状态里说明原因,重试按钮可点。
     *
     * ⚠️ `agent:start` 的契约(2026-09-18 评审后改过)是**返回**结果对象:
     *   `{ ok:true, status }` / `{ ok:false, state, snapshot, message }`。
     * 原因是 `ipcMain.handle` throw 的 Error 过不了真 IPC(state/snapshot 全丢,
     * message 还带 "Error invoking remote method" 前缀),面板于是永远走兜底分支。
     * 这里仍然兜住"桥自己 reject"的情况(旧契约/桥坏掉),不许显示 undefined。
     */
    async function start() {
        if (starting) return state.status;
        starting = true;
        // 一次新的 start 就是"再连一次"本身:那张"进程已停掉"的提示卡该让位了
        // (连上了它没意义;连不上会有 broken 那条提示卡顶上)。
        killRequested = false;
        scheduleRender();
        try {
            const result = await calls('agent:start', {});
            if (result !== null && typeof result === 'object' && result.ok === false) {
                state = reduceAgentEvent(state, { kind: 'state', status: failedStatusFrom(result) });
            } else if (result !== null && typeof result === 'object' && result.ok === true) {
                state = reduceAgentEvent(state, { kind: 'state', status: result.status });
            } else if (result !== null && typeof result === 'object') {
                // 兼容旧形状(直接回一个 status 快照):不认识 ok 字段时按快照处理。
                state = reduceAgentEvent(state, { kind: 'state', status: result });
            }
        } catch (err) {
            state = reduceAgentEvent(state, { kind: 'state', status: failedStatusFrom(err) });
        } finally {
            starting = false;
            scheduleRender();
        }
        return state.status;
    }

    /**
     * 把一次失败(`{ok:false,...}` 或一个 Error)折成状态快照。
     *
     * 优先用对端给的 snapshot(它是"这次 start 为什么没成"的现场,里面那句
     * error 正是要显示的中文);没有 snapshot 才用这次失败自己的 message。
     * 两者都没有就落到兜底文案 —— 绝不显示 undefined。
     */
    function failedStatusFrom(src) {
        const snapshot = (src?.snapshot !== null && typeof src?.snapshot === 'object')
            ? src.snapshot : null;
        const status = (snapshot !== null) ? { ...snapshot } : { ...state.status, state: 'failed' };
        if (typeof src?.state === 'string' && src.state !== '') status.state = src.state;
        const hasReason = typeof status.error === 'string' && status.error !== '';
        if (!hasReason) {
            const message = String(src?.message ?? '').trim();
            status.error = message !== '' ? message : '连接失败(没有给出原因)';
        }
        return status;
    }

    async function loadCredentials() {
        try {
            const r = await calls('agent:credentials', {});
            credentials = (r !== null && typeof r === 'object') ? r : null;
        } catch (err) {
            log.warn?.('[agent] 取凭证状态失败', err);
            // 取不到**不是**"凭证没问题":给一句能读的中文,再把卡片亮出来。
            credentials = { ok: false, source: null, reason: `读取凭证状态失败:${String(err?.message ?? err)}` };
        }
        // 只刷新内容与 data-credential-ok;显示与否由 applyCredentialVisibility 决定
        // (它是"有凭证就收起"这一条规则的唯一落点)。
        setCredentialState('content-only');
        return credentials;
    }

    /** "有凭证就收起、缺凭证就说清"这条规则的**唯一**落点。 */
    function applyCredentialVisibility() {
        setCredentialState((credentials !== null && credentials.ok === true) ? 'hidden' : 'info');
    }

    /**
     * 这次会话钉的模型 id(session/new 的 configOptions 里 `model` 那一项的 currentValue)。
     * 只用在"拒绝发图"那句话里 —— 用户得知道该换的是哪个模型。拿不到就空串。
     */
    function currentModelValue() {
        const hit = asArray(state.configOptions).find((o) => o?.id === 'model');
        return typeof hit?.currentValue === 'string' ? hit.currentValue : '';
    }

    async function send() {
        const question = String(input?.value ?? '');

        // ---- 视频:这是本功能**唯一**的触发点 ----
        //
        // 有视频草稿时这一次发送走视频那条路(它不经过 Agent,所以 Agent 没连上也照样能用)。
        // 判据放在图片那一段**之前**:一条消息只能有一种附件语义,不能出现
        // "同一个问题既发给 agent、又发给 DashScope"两条互不相干的记录。
        if (pendingVideo !== null) {
            if (pendingImages.length > 0) {
                // 两条路都要用同一段文字,分开走必然出现两条记录 —— 与其悄悄丢掉一边,
                // 不如明说、让用户决定删哪一个。
                showVideoNotice('一次发送里不能同时带图片和视频 —— 先移掉其中一个再发');
                return;
            }
            const sent = await sendVideo();
            // 真的发出去了才清输入框(没发出去时那些字要留着让用户重试,与图片那条一致)。
            if (sent && input) input.value = '';
            return;
        }

        // 有图没字也允许发送(黏贴一张截图直接发是正常用法);两样都空才什么都不做。
        if (question.trim() === '' && pendingImages.length === 0) return;

        // 先把字节读出来(异步)。读不出来就当场说原因并**中止这一次** ——
        // 不许发一条"图和字都少了"的提示出去。
        let images;
        try {
            images = await imagesForSend();
        } catch (err) {
            log.warn?.('[agent] 准备图片失败', err);
            showImageNotice(`图片没能准备好:${String(err?.message ?? err)}`);
            return;
        }
        if (images === null) return;

        const note = readNote();
        // ⚠️ **发图之前**先看对端广告的能力:ACP 规定"只有对方广告了才准发内联图片"。
        //    装机那份桥钉的模型(deepseek-v4-flash)没有声明图片输入,握手时就广告了
        //    `image:false`;照发的结果是 -32602 + 一句英文(用户实测看到的就是它),
        //    而且图片与文字是一起发的 —— 被拒就是**整条提示都没发出去**,还白等一轮。
        //    所以在这里就停住,并说清"为什么 / 怎么办"。caps 为 null(还不知道)不拦。
        if (images.length > 0 && state.caps !== null && state.caps.image !== true) {
            showImageNotice(imageCapabilityRefusal(state.caps, currentModelValue()));
            return;
        }

        let text;
        try {
            // 空问题由 buildPromptText 兜住(它抛错,不是静默发一条空提示)
            text = buildPromptText({
                noteTitle: note?.title,
                notePath: note?.path,
                noteText: note?.text,
                question,
                imageCount: images.length,
            });
        } catch (err) {
            log.warn?.('[agent] 提示词拼装失败', err);
            return;
        }

        // 界面上只显示用户自己问的那句;笔记上下文是送给 Agent 的,不塞回气泡。
        // 图**连缩略图 URL 一起**移交给气泡 —— 这是他发出去的那张图,要在气泡里回显。
        // ⚠️ 顺序:移交必须在所有"会中止这一次发送"的检查**之后**(读不出字节、拼不出
        // 提示词时图要留在输入区让用户重试),而且在 clearImages() **之前**
        // (clearImages 撤销的是还归 chip 的那些 URL)。
        // ⚠️ 这几行必须**同步**跑完:测试里 await fire('keydown') 之后要立刻看到
        // 气泡。先 await IPC 再渲染会让"点了有反应"变成"点了过一会儿才有反应"。
        const bubbleImages = handOffImages();
        // 只发图没写字时气泡里**只有图**(shown 为空 → 不建文本层)。
        // 极少数环境造不出 blob: URL(createObjectURL 缺失)时退回旧文案:总比
        // "发出去一条图,气泡里什么都没有"强。有文字时逐字不变。
        const shown = question.trim() !== ''
            ? question.trim()
            : (bubbleImages.length > 0
                ? ''
                : (images.length > 1 ? `（${images.length} 张图片）` : '（图片）'));
        state = beginPrompt(state, shown, bubbleImages);
        if (input) input.value = '';
        clearImages();   // 这时 pendingImages 已经空了(URL 已随 handOffImages 转走),空转
        render();

        try {
            // ⚠️ `shown` 一起递过去:会话台账里要记的是**用户真打的那句**,
            //    不是 `text`(那里面还裹着笔记上下文那一段)。铺回历史时若拿错,
            //    用户会看到一大段自己没打过的东西。
            await calls('agent:send', { text, images, shown });
        } catch (err) {
            log.warn?.('[agent] 发送失败', err);
            // 主进程的权威校验拒了(超限/格式/字节与声明不符)时必须**看得见**,
            // 否则用户对着"消息发出去了"的界面猜为什么模型没理那张图。
            // 纯文字那条路不许因此多出一个提示行,所以只在带图时说。
            if (images.length > 0) {
                // ⚠️ 桥拒图片时回的是英文,而且被 IPC 包了一层
                //    `Error invoking remote method 'agent:send': Error: …` —— 原文对用户等于没说。
                //    先剥掉 IPC 那层壳(通道名对用户是噪声),能认出来就换成中文
                //    (原因照说 + 给出下一步),认不出照旧(不掩盖)。
                const raw = stripIpcWrapper(String(err?.message ?? err));
                showImageNotice(`这次没能发出去:${imagePromptFailureHint(raw) ?? raw}`);
            }
        }
    }

    async function cancel() {
        // 立刻收 busy:按钮要马上有反应;对端随后会给出 prompt-end/prompt-error
        state = { ...state, busy: false };
        render();
        try {
            await calls('agent:cancel', {});
        } catch (err) {
            log.warn?.('[agent] 取消失败', err);
        }
    }

    /**
     * 重连 Agent 进程(停掉再起)。
     *
     * 为什么需要它 —— 唯一一件**必须重连才能生效**的事:图片能力。
     * 桥在 `initialize` 那一刻算一次 `imagePromptEnabled`(判据是"当前模型有没有声明
     * 图片输入"),之后整条连接都用那个值,连 `set_config_option` 换模型也不重算。
     * 所以:换到视觉模型之后,想真的发得出去图,就得让它重新握一次手。
     *
     * ⚠️ 代价要**说在前面**:ACP 的会话随进程一起消失(上下文清零),面板里的聊天记录还在,
     *    但新的一轮不再记得之前聊过什么。所以这是个**用户自己按的按钮**,不替用户决定。
     */
    async function restartAgent() {
        if (cfgRestarting) return false;
        cfgRestarting = true;
        cfgPaint();
        try {
            await calls('agent:stop', {});
            await loadCredentials();
            applyCredentialVisibility();
            // 重连之后能力要重新学:先把"已知能力"清成"还不知道",避免界面拿旧值继续拦。
            state = reduceAgentEvent(state, { kind: 'caps', caps: null });
            await start();
            return true;
        } catch (err) {
            log.warn?.('[agent] 重连失败', err);
            return false;
        } finally {
            cfgRestarting = false;
            render();
        }
    }

    async function killProcess() {
        // ⚠️ 停掉之后**必须留一个再连的出口**:进程没了,面板就停在 stopped,
        // 而 stopped 下「发送」是灰的、「重试」本来也不出现 —— 用户会以为只能重启开物。
        // 这件事**不在这里做**:判据是"状态真的从在跑掉到 stopped"(见 onEvent)——
        // 那样不管是谁停的(这一行的按钮、设置页那一项、还是外部把进程干掉了)都成立,
        // 而且停止失败(进程还活着)时不会凭空出现一张"已经停掉"的假提示。
        try {
            await calls('agent:stop', {});
            await loadCredentials();
            applyCredentialVisibility();
        } catch (err) {
            log.warn?.('[agent] 停止进程失败', err);
        }
        render();
    }

    async function answerPermission(requestId, optionId) {
        // 同一个 requestId 只回答一次。禁用了按钮还不够 —— 事件可能已经排在队列里,
        // 而对端每个 requestId 只等**一个**回答,发两次会让它把第二个当成串线的响应。
        if (answered.has(requestId)) return;
        answered.add(requestId);

        state = resolvePermission(state, requestId, optionId);
        // 先标已决:renderPermissions() 随即把这张卡从界面上摘掉(两类卡都是答完就删),
        // 所以"重复点击"不再靠按钮禁用挡,而是靠上面那句 answered 集合 —— 旧节点的
        // click 监听器还活着,那条判据是唯一挡在第二个 IPC 前面的东西。
        render();
        try {
            await calls('agent:permission', { requestId, optionId });
        } catch (err) {
            log.warn?.('[agent] 回权限失败', err);
        }
    }

    /** 主进程推来一个事件。kind 契约见 M3-B 计划(与 B1 共用,冻结)。 */
    function onEvent(event) {
        if (event === null || typeof event !== 'object') return;
        // 别的会话的增量不该进这个面板(多会话并存时会把两条回复搅在一起)。
        //
        // ⚠️ 但 `session` 事件**必须放行**:它正是"当前会话换成了谁"的公告 ——
        //    「AI 会话」那栏点「接着聊」就是靠它把面板切过去、再照它铺历史的。
        //    拿"id 与当前不一致"去挡它,等于把换会话的公告本身丢掉:主进程明明切成功了,
        //    界面还停在旧会话上(实测:activate 回 ok、面板读到的还是旧 id,历史也没铺出来)。
        if (event.kind !== 'session' && event.sessionId !== undefined && state.sessionId !== null
            && event.sessionId !== state.sessionId) return;

        // ⚠️ 判据取**这一次事件之前**的状态:进程从"在跑"掉到"没在跑"之后,
        // 「发送」是灰的、「重试」本来也不出现 —— 那一行上的「停止进程」也不再显示
        // (它只在有东西可停时出现)。所以这一刻必须在对话里留一个再连的出口。
        // 不绑定到"谁按的按钮":面板那一行、设置页那一项、外部把进程干掉,都算。
        const wasRunning = state.status.state === 'ready' || state.status.state === 'starting';
        state = reduceAgentEvent(state, event);
        // 「接着聊」接回来的会话:对端不重放旧消息,历史得由**开物自己的台账**铺回来。
        // 放在 reduce 之后:此刻 sessionId / configOptions / caps 都已经归位。
        if (event.kind === 'session' && event.resumed === true && typeof event.sessionId === 'string') {
            void hydrateFromLedger(event.sessionId);
        }
        // 「＋ 新建会话」:对端刚建了一条**空的** —— 对话区要跟着空,
        // 而不是接着上一条往下画(那样用户会以为"新建"没生效)。
        if (event.kind === 'session' && event.fresh === true) clearConversation();
        // 思考秒表跟着**事件**走:这一条新出现的思考按下开始,这一条收尾的按下结束。
        // 放在 reduce 之后:此刻 state 已经是"这次事件之后"的样子,新建/收尾都看得见。
        trackThinkClock();
        if (wasRunning && state.status.state === 'stopped') killRequested = true;
        if (needsCredentialAttention(state)) {
            // 缺凭证的映射落点(M3-A 终审 Important 5):提示因为没配钥匙失败时,
            // 凭证卡片要亮出来 —— 别让用户对着一句"发送失败"猜。
            setCredentialState('warn');
        } else if (event.kind === 'prompt-end' && credentials !== null && credentials.ok !== true) {
            setCredentialState('info');
        }
        scheduleRender();
    }

    // ============ 「接着聊」:把历史铺回对话 ============
    //
    // 为什么必须自己做这件事:ACP 的 `session/resume` **只回 configOptions**,
    // 它恢复的是对端那边的**记性**(上下文),不是屏幕上的消息 —— 对端从不重放历史
    // (实测)。所以"点一条旧会话,能看到当时聊了什么"这件事只能由开物自己的台账完成:
    //   台账记录 → recordToSteps() → 走一遍**和实时完全一样**的归约 → 得到一份 state。
    //
    // 为什么走归约而不是另写一套渲染:实时那条路上有思考折叠、工具卡片、"这一轮没有
    // 文字回复"、轮次轨……历史若是另一套渲染,两边迟早长得不一样(用户会发现"同样的
    // 内容在历史里和实时里不一样")。走同一条归约,历史与实时**天生一致**。

    /** 会话 id → 已经铺过的那一条(避免同一条会话被反复铺/反复重画)。 */
    let hydratedFor = null;

    /**
     * 把对话区清空(「＋ 新建会话」走这条)。
     *
     * ⚠️ 清的是**这一轮对话**:消息 / 思考 / 工具 / 顺序 / 权限卡 / 译文 / 用量 / 最后一条错,
     *    外加气泡图片那笔账(它们不再被任何消息引用了,不清就是泄漏)。
     *    不动 status / caps / configOptions / sessionId —— 那是"这条连接的现在":
     *    换一条会话不等于换了连接,连接该是 ready 就还是 ready。
     */
    function clearConversation() {
        releaseMessageImages(true);
        state = {
            ...state,
            messages: [], thoughts: [], tools: [], order: [],
            permissions: [], translations: {}, usage: null, error: null, busy: false,
        };
        // 新会话没有历史可铺,顺手把"铺过哪一条"的标记清掉(将来这条聊完再切回来还要铺)。
        hydratedFor = null;
        trackThinkClock();
        scheduleRender();
    }

    /**
     * 把某一条会话的历史铺回对话区。
     *
     * ⚠️ 只换**对话那一层**(messages / thoughts / tools / order / error),不动
     *    这条连接的现在(status / caps / configOptions / sessionId)—— 那些是"当前这一格
     *    的状态",不是历史的一部分。混着换会让面板显示一个不存在的进程状态。
     * ⚠️ 读不到记录**不是错误**:那条会话可能是在别的机器/别的库上聊的,或者是被删过的
     *    记录。那时宁可留一段空白,也不许假装有历史。
     */
    async function hydrateFromLedger(sid) {
        if (hydratedFor === sid) return;
        hydratedFor = sid;
        let record = null;
        try {
            const r = await calls('sessions:read', { id: sid });
            if (r !== null && typeof r === 'object' && r.ok === true
                && r.record !== null && typeof r.record === 'object') {
                record = r.record;
            }
        } catch (err) {
            log.warn?.('[agent] 会话记录没读回来', err);
        }
        if (record === null) return;
        let next = initialStreamState();
        for (const step of recordToSteps(record)) {
            next = step.type === 'prompt'
                ? beginPrompt(next, step.text, step.images)
                : reduceAgentEvent(next, step.event);
        }
        state = {
            ...state,
            messages: next.messages,
            thoughts: next.thoughts,
            tools: next.tools,
            order: next.order,
            busy: false,
            // ⚠️ error 取历史里的:这一条会话最后一次是怎么结束的(出错也要看得见),
            //    而不是"现在没有错误"。
            error: next.error,
        };
        trackThinkClock();
        scheduleRender();
    }

    // ============ 思考强度 / 模型(输入行右侧那枚胶囊) ============
    //
    // 数据**全部**来自对端的 configOptions(session/new 与 set_config_option 都给整份),
    // 解析与"紧凑态写哪个字"的判据在 app/lib/agent-config.js(纯函数,单测钉着),
    // 这里只负责画与发请求。两条不许破的纪律:
    //   · `value` 是**不透明串** —— 只从对端给的那一份里原样抄回来,不解析、不拼装;
    //   · 在飞的一轮**不许改**(切换会动上下文),所以 busy 时整枚禁用。
    // 浮层是**两层**:第 1 层思考强度(滑块),第 2 层模型(清单);不嵌套第三层。

    let cfgOpen = 'none';        // 'none' | 'effort' | 'models'
    let cfgEls = null;           // 浮层里的节点(懒建一次,之后只改文本/类名 —— 见 cfgPaint 的说明)
    let cfgStopsKey = '';        // 档位那次构建的指纹(数据没变就不重建,否则动效会一遍遍重播)
    let cfgModelsKey = '';
    let cfgDrag = null;          // 拖动中:落点档位(松手才提交)
    let cfgRestarting = false;   // 正在重连(按钮要禁用,别连点两次把进程来回停) 

    const reasonOption = () => configOptionOf(state.configOptions, REASONING_CONFIG_ID);
    const modelOption = () => configOptionOf(state.configOptions, MODEL_CONFIG_ID);
    const reasonLevels = () => effortLevels(reasonOption());
    const cfgDisabled = () => state.busy === true;

    const cfgNode = (tag, cls = '', text = '') => {
        const node = doc.createElement(tag);
        if (cls !== '') node.className = cls;
        if (text !== '') node.textContent = text;
        return node;
    };

    /**
     * 「还没建会话」那一句(两种"空"分开说里的那一半)。
     *
     * ⚠️ 这一句**必须保留**:agent 没连上、还没 ready、或者有什么东西坏掉时,
     *    它仍然是诚实的说法(所以单测与自检都钉着它,别顺手删)。
     *    而**正常启动之后它不该再出现**:ACP 握手成功(ready)时主进程就会自动建一条
     *    会话(见 electron/agent/agent-runtime.js 的 autoCreateSession),`session`
     *    事件一到,sessionId 就不是 null 了。
     *
     * ⚠️ 但"自动建会话**失败**"是第三种情况:确实没有会话,可原因不是"还没连上",
     *    而是那一步本身失败了 —— 那时把主进程推来的原因接在后面说(绝不在这里编一句),
     *    用户才知道不是"等等就有了",以及他手里的出路是发一条消息再试一次。
     */
    function noSessionText(tail) {
        const reason = typeof state.sessionError?.message === 'string' ? state.sessionError.message : '';
        return reason === ''
            ? `还没建会话 —— ${tail}`
            : `自动建会话失败:${reason} —— 发一条消息时会再试一次。`;
    }

    /** 造一次浮层骨架(像球里那张脸一样:壳给按钮,里面由这里造)。 */
    function ensureConfig() {
        if (configBtn === null || configWrap === null || cfgEls !== null) return cfgEls;
        if (typeof configWrap.appendChild !== 'function') return null;

        const pop = cfgNode('div', 'agent-cfg-pop');
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', '思考强度');

        // —— 第 1 层:强度 ——
        const pane1 = cfgNode('div', 'agent-cfg-pane');
        const head = cfgNode('div', 'agent-cfg-head');
        const nowBtn = cfgNode('button', 'agent-cfg-now');
        nowBtn.type = 'button';
        const nowVal = cfgNode('span', 'v');
        const nowGo = cfgNode('span', 'go', '›');
        nowBtn.append(nowVal, nowGo);
        const tip = cfgNode('span', 'agent-cfg-tip', '点上面的字可换模型');
        head.append(nowBtn, tip);

        const track = cfgNode('div', 'agent-cfg-track');
        track.tabIndex = 0;
        track.setAttribute('role', 'slider');
        track.setAttribute('aria-label', '思考强度');
        const rail = cfgNode('div', 'rail');
        const fill = cfgNode('div', 'fill');
        const knob = cfgNode('div', 'knob');
        track.append(rail, fill, knob);

        const stops = cfgNode('div', 'agent-cfg-stops');
        const desc = cfgNode('p', 'agent-cfg-desc');
        const foot = cfgNode('div', 'agent-cfg-foot');
        const footText = cfgNode('span', 'agent-cfg-foot-text', '松手即生效(续聊,不丢上下文)');
        // 重连按钮:只在"图片能力与当前模型不一致"时出现(见 cfgPaint)。
        // 文案带代价 —— 会话上下文会随进程一起消失,用户有权知道。
        const renew = cfgNode('button', 'agent-cfg-renew', '重连以启用图片');
        renew.type = 'button';
        renew.title = '图片能力是连接建立时确定的,换模型后要重新握手才生效。重连会清空这次对话的上下文(聊天记录还在)。';
        renew.addEventListener('click', () => { void restartAgent(); });
        foot.append(footText, renew);
        pane1.append(head, track, stops, desc, foot);

        // —— 第 2 层:模型 ——
        const pane2 = cfgNode('div', 'agent-cfg-pane');
        const back = cfgNode('button', 'agent-cfg-back', '‹ 思考强度');
        back.type = 'button';
        const list = cfgNode('div', 'agent-cfg-list');
        pane2.append(back, list);

        pop.append(pane1, pane2);
        configWrap.appendChild(pop);

        cfgEls = {
            pop, pane1, pane2, head, nowBtn, nowVal, tip, track, rail, fill, knob,
            stops, desc, foot, footText, back, list, renew,
        };

        // ---- 交互 ----
        configBtn.addEventListener('click', () => {
            if (cfgDisabled()) return;                       // busy:整枚禁用(见 cfgDisabled)
            setCfgOpen(cfgOpen === 'none' ? 'effort' : 'none');
        });
        // 点浮层外面 / Esc 收起。⚠️ 挂 document 上、而且只在打开时才起作用。
        if (typeof doc.addEventListener === 'function') {
            doc.addEventListener('pointerdown', (e) => {
                if (cfgOpen === 'none') return;
                const t = e.target;
                if (t === configBtn || (typeof configBtn.contains === 'function' && configBtn.contains(t))) return;
                if (typeof pop.contains === 'function' && pop.contains(t)) return;
                setCfgOpen('none');
            });
            doc.addEventListener('keydown', (e) => {
                if (cfgOpen !== 'none' && e.key === 'Escape') { e.preventDefault?.(); setCfgOpen('none'); }
            });
        }
        nowBtn.addEventListener('click', () => setCfgOpen('models'));
        back.addEventListener('click', () => setCfgOpen('effort'));

        // 滑块:指针拖动(拖动中**不许**有过渡 —— 与笔记树拖动同一条纪律),
        // 松手才提交;方向键也走提交。
        const indexAt = (clientX) => {
            const n = reasonLevels().length;
            if (n <= 1) return 0;
            const box = typeof track.getBoundingClientRect === 'function' ? track.getBoundingClientRect() : null;
            if (box === null || box.width <= 0) return 0;
            const t = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
            return Math.round(t * (n - 1));
        };
        const preview = (i) => {
            // 拖动中只改视觉(不发请求):档位、填充、把手、说明
            cfgDrag = { index: i };
            cfgPaintStops(i);
        };
        track.addEventListener('pointerdown', (e) => {
            if (cfgDisabled()) return;
            track.classList.add('dragging');
            try { track.setPointerCapture?.(e.pointerId); } catch { /* 预览环境 */ }
            preview(indexAt(e.clientX));
            e.preventDefault?.();
        });
        track.addEventListener('pointermove', (e) => {
            if (cfgDrag === null || track.classList.contains('dragging') !== true) return;
            preview(indexAt(e.clientX));
        });
        const release = (e) => {
            if (cfgDrag === null) return;
            const i = indexAt(e.clientX ?? 0);
            track.classList.remove('dragging');
            cfgDrag = null;
            track.classList.add('settle');
            setTimeout(() => track.classList.remove('settle'), 300);
            const levels = reasonLevels();
            const wanted = levels[i];
            cfgDrag = null;
            if (wanted !== undefined && wanted.value !== reasonOption()?.currentValue) {
                void commitConfig(REASONING_CONFIG_ID, wanted.value, { label: wanted.short });
            } else {
                cfgPaintStops();
            }
        };
        track.addEventListener('pointerup', release);
        track.addEventListener('pointercancel', release);
        track.addEventListener('keydown', (e) => {
            const levels = reasonLevels();
            const cur = effortIndexOf(levels, reasonOption()?.currentValue);
            const go = (i) => {
                const want = levels[Math.max(0, Math.min(levels.length - 1, i))];
                if (want !== undefined && want.value !== reasonOption()?.currentValue) {
                    void commitConfig(REASONING_CONFIG_ID, want.value, { label: want.short });
                }
                e.preventDefault?.();
            };
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') go(cur - 1);
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') go(cur + 1);
            if (e.key === 'Home') go(0);
            if (e.key === 'End') go(levels.length - 1);
        });

        cfgPaint(true);
        return cfgEls;
    }

    function setCfgOpen(next) {
        cfgOpen = next;
        cfgDrag = null;
        cfgEls?.track?.classList.remove('dragging');
        cfgPaint();
    }

    /** 一把刷:胶囊 + 浮层(结构只在数据变了时重建)。 */
    function cfgPaint(force = false) {
        if (ensureConfig() === null) return;
        const { pop, pane1, pane2, nowVal, track, stops, desc, footText, list, renew } = cfgEls;

        const levels = reasonLevels();
        const current = reasonOption()?.currentValue ?? '';
        const at = cfgDrag !== null ? cfgDrag.index : effortIndexOf(levels, current);
        const label = chipLabel({ expanded: cfgOpen !== 'none', level: levels[at] ?? null });

        // 胶囊
        if (configBtn !== null) {
            const text = label.text;
            if (configBtn.textContent !== text) {
                configBtn.textContent = text;
                // 换字:一次性的上滑入场(与思考条逐行入场同一套语言)
                configBtn.classList.remove('swap'); void configBtn.offsetWidth; configBtn.classList.add('swap');
            }
            configBtn.setAttribute('aria-expanded', String(cfgOpen !== 'none'));
            configBtn.disabled = cfgDisabled();
            configBtn.classList.toggle('disabled', cfgDisabled());
            const cur = levels[effortIndexOf(levels, current)] ?? null;
            configBtn.title = cur === null
                ? '思考强度'
                : `思考强度:${cur.full}${cur.description !== '' ? ` · ${cur.name}` : ''}`;
        }

        // 重连按钮:只在**这条连接不能发图片**时露出来。
        // 它就是"换到视觉模型之后让图片真的能用"的唯一出口(见 restartAgent 的说明)。
        // ⚠️ 用 `hidden` **属性**而不是类名:`.agent-cfg-renew` 那条规则不写 display,
        //    于是 [hidden]{display:none} 能正常压住它(写了 display 就同权重、按顺序,会压不住)。
        // 有会话、但能力不是明确的 true → 露出来(不知道 / 明确 false 都值得给一个出口)。
        // 换到视觉模型之后 refreshCapabilities 会把 caps 刷成 true,它就自己藏起来。
        renew.hidden = state.sessionId === null || state.caps?.image === true;
        renew.disabled = cfgRestarting === true || cfgDisabled();
        renew.textContent = cfgRestarting === true ? '正在重连…' : '重连以启用图片';

        // 浮层显示/隐藏(两层各自一个类,动画交给 CSS)
        pop.classList.toggle('open', cfgOpen !== 'none' && !cfgDisabled());
        pane1.classList.toggle('on', cfgOpen === 'effort');
        pane2.classList.toggle('on', cfgOpen === 'models');
        nowVal.textContent = levels[at]?.short ?? '默';

        // 档位:数据变了才重建(否则每帧重建会把入场动效一遍遍重播)
        const key = JSON.stringify(levels.map((l) => [l.value, l.name, l.short, l.full, l.description]));
        if (force || key !== cfgStopsKey) {
            cfgStopsKey = key;
            // ⚠️ 用 replaceChildren() 而不是 textContent='':后者在真 DOM 里也清子节点,
            //    但这个面板的 DOM 替身把 textContent 当成普通字段(不清子节点)—— 于是一重建
            //    就"叠"出一份旧的,断言查到的永远是第一份(实测踩到)。
            stops.replaceChildren();
            levels.forEach((lv, i) => {
                const s = cfgNode('span', '', lv.short);
                s.dataset.i = String(i);
                s.title = lv.description === '' ? lv.name : `${lv.name} —— ${lv.description}`;
                // 点某一档也能直接切(不必拖):与"拖动松手"走同一条提交路。
                s.addEventListener('click', () => {
                    if (cfgDisabled() || lv.value === reasonOption()?.currentValue) return;
                    void commitConfig(REASONING_CONFIG_ID, lv.value, { label: lv.short });
                });
                stops.appendChild(s);
            });
            track.setAttribute('aria-valuemin', '0');
            track.setAttribute('aria-valuemax', String(Math.max(0, levels.length - 1)));
        }
        cfgPaintStops(at);

        // 模型清单:同样只在数据变了时重建
        const groups = modelGroups(modelOption());
        // ⚠️ 指纹里要带上"有没有会话":清单为空时那句文案依赖它(还没建会话 vs 对端没给),
        //    不带的话,挂载时写下的那句会一直冻在那儿(实测踩到:会话建好了文案还在说"还没建会话")。
        //    自动建会话**失败**时的原因同理(from noSessionText):它一变那句就要重画。
        const modelsKey = JSON.stringify([
            groups, modelOption()?.currentValue ?? '', state.sessionId === null,
            state.sessionError?.message ?? '',
        ]);
        if (force || modelsKey !== cfgModelsKey) {
            cfgModelsKey = modelsKey;
            list.replaceChildren();
            if (groups.length === 0) {
                list.appendChild(cfgNode('p', 'agent-cfg-empty', state.sessionId === null
                    ? noSessionText('模型清单是对端在 session/new 里给的,发一条消息之后才会出现。')
                    : '对端没有给出模型清单(这条连接不支持换模型)。'));
            }
            let n = 0;
            for (const g of groups) {
                if (g.name !== '') list.appendChild(cfgNode('div', 'agent-cfg-grp', g.name));
                for (const m of g.options) {
                    const row = cfgNode('div', 'agent-cfg-opt');
                    row.dataset.value = m.value;             // 不透明值:只存不算
                    // 逐条错开的唯一输入(见 shell.css 的 calc(var(--i) * 22ms))。
                    // ⚠️ 守卫是必需的:朴素替身的 style 是个空对象、没有 setProperty ——
                    //    缺了它整段 cfgPaint 会当场抛,浮层里一样东西都画不出来(实测踩到)。
                    if (typeof row.style?.setProperty === 'function') {
                        row.style.setProperty('--i', String(n));
                    }
                    n += 1;
                    const mark = cfgNode('span', 'mark');
                    const txt = cfgNode('span', 'txt');
                    const t1 = cfgNode('span', 't1', m.name);
                    const t2 = cfgNode('span', 't2', m.description);
                    txt.append(t1, t2);
                    row.append(mark, txt);
                    row.addEventListener('click', () => {
                        if (cfgDisabled()) return;
                        if (m.value === modelOption()?.currentValue) { setCfgOpen('none'); return; }
                        void commitConfig(MODEL_CONFIG_ID, m.value, { label: m.name });
                    });
                    list.appendChild(row);
                }
            }
        }
        // 当前项打勾(重建之后也要刷,所以不放在重建块里)
        const curModel = modelOption()?.currentValue ?? '';
        if (typeof list.querySelectorAll === 'function') {
            for (const row of list.querySelectorAll('.agent-cfg-opt')) {
                const on = row.dataset?.value === curModel;
                row.classList.toggle('on', on);
                const mark = typeof row.querySelector === 'function' ? row.querySelector('.mark') : null;
                if (mark !== null) mark.textContent = on ? '✓' : '';
            }
        }
    }

    /** 只刷滑块那一组(拖动中每帧都走它 —— 不重建 DOM)。 */
    function cfgPaintStops(at = null) {
        if (cfgEls === null) return;
        const levels = reasonLevels();
        const current = reasonOption()?.currentValue ?? '';
        const idx = at !== null ? at : effortIndexOf(levels, current);
        const n = levels.length;
        const pct = n <= 1 ? 0 : (idx / (n - 1)) * 100;
        cfgEls.fill.style.width = `${pct}%`;
        cfgEls.knob.style.left = `${pct}%`;
        const lv = levels[idx] ?? null;
        cfgEls.nowVal.textContent = lv?.short ?? '默';
        cfgEls.track.setAttribute('aria-valuenow', String(idx));
        cfgEls.track.setAttribute('aria-valuetext', lv?.full ?? '');
        cfgEls.desc.textContent = lv === null
            // ⚠️ 两种"空"必须分开说(实测冤枉过对端):**还没建会话**时状态里根本没有
            //    configOptions(正常启动时它会由主进程在 ready 那一刻自动建出来,见 noSessionText)
            //    —— 那不是"对端没给";只有会话已经建好、而对端那份里确实没有这一条,
            //    才该说"没有广告"。
            ? (state.sessionId === null
                ? noSessionText('档位与模型都是对端在 session/new 里给的,发一条消息之后才会出现。')
                : '这条连接没有广告思考强度(当前模型没声明 reasoning 档位)。')
            : `${lv.full} · ${lv.name}${lv.description === '' ? '' : ` —— ${lv.description}`}`;
        if (typeof cfgEls.stops.querySelectorAll === 'function') {
            for (const s of cfgEls.stops.querySelectorAll('span')) {
                const i = Number(s.dataset?.i ?? -1);
                s.classList.toggle('on', i === idx);
            }
        }
    }

    /**
     * 提交一次配置变更。
     *
     * ⚠️ 失败时**抖动 + 把原因写在浮层脚下**,并且把档位显示退回对端那一份
     *    (state.configOptions 没变,所以 cfgPaint 自然画回旧值)—— 绝不假装改成了。
     */
    async function commitConfig(configId, value, { label = '' } = {}) {
        if (cfgDisabled()) return;
        try {
            await calls('agent:setConfig', { configId, value });
            if (configBtn !== null) {
                configBtn.classList.remove('pulse'); void configBtn.offsetWidth; configBtn.classList.add('pulse');
            }
            if (cfgEls !== null) cfgEls.footText.textContent = `已切到「${label}」`;
            // ⚠️ 换了模型就要**重新问一次图片能力**:
            //   · 先把已知能力清成"还不知道" —— 否则界面会拿**旧模型**的能力继续拦
            //     (实测:换到视觉模型之后,发图仍被自己的 pre-flight 挡住);
            //   · 再向对端问一次(kaiwu/capabilities;桥那边由 kaiwu 自己的补丁提供)。
            //     问不到就保留"还不知道"—— 那比拿旧值拦人强,失败时对端会给出中文原因。
            if (configId === MODEL_CONFIG_ID) {
                state = reduceAgentEvent(state, { kind: 'caps', caps: null });
                try {
                    await calls('agent:capabilities', {});
                } catch (err) {
                    log.warn?.('[agent] 问图片能力失败(先按不知道处理)', err);
                }
            }
        } catch (err) {
            log.warn?.('[agent] 改配置失败', err);
            const why = String(err?.message ?? err);
            if (configBtn !== null) {
                configBtn.classList.remove('shake'); void configBtn.offsetWidth; configBtn.classList.add('shake');
            }
            if (cfgEls !== null) cfgEls.footText.textContent = `没改成:${why}`;
            cfgPaint(true);
        }
    }

    // ================= 那颗球的实现:造它 + 让它看 =================
    //
    // 这一整段都服务于上面那条用户决定:发送与取消合成一颗球。
    // 判据(优先级、阈值、幅度、平滑)全在 app/lib/robot-face.js,这里只做三件事:
    //   ① 把球的骨架造出来(外壳只给一个空按钮);② 收四类来源;③ 每帧把眼睛推过去。

    /** 造一张脸(头 + 眼睛层 + 两只眼睛)。底脸与 9 条撕裂片共用它 ——
     *  失败态的"片"必须是**整脸的副本**(头 + 眼睛一起被切走),不能用矩形色块盖上去。 */
    function buildFaceSvg() {
        const svg = svgEl('svg');
        attr(svg, 'viewBox', `0 0 ${FACE.view} ${FACE.view}`);
        attr(svg, 'aria-hidden', 'true');
        const body = svgEl('g');
        setClass(body, 'agent-orb-body', true);
        const head = svgEl('circle');
        attr(head, 'cx', String(FACE.view / 2));
        attr(head, 'cy', String(FACE.view / 2));
        attr(head, 'r', String(FACE.headR));
        attr(head, 'fill', '#f2f6ff');
        setClass(head, 'agent-orb-head', true);
        body.appendChild(head);
        svg.appendChild(body);
        const look = svgEl('g');
        setClass(look, 'agent-orb-look', true);
        for (const sign of [-1, 1]) {
            const eye = svgEl('ellipse');
            attr(eye, 'cx', String(FACE.view / 2 + sign * FACE.eyeCx));
            attr(eye, 'cy', '16.2');
            attr(eye, 'rx', String(FACE.eyeRx));
            attr(eye, 'ry', '3.3');
            attr(eye, 'fill', '#0b0d16');
            // ⚠️ 类名两个 token 要**写属性**,不能塞进 setClass:classList.toggle 的 token 里
            //    带空格会直接抛 `InvalidCharacterError`(实测:它让 ensureTear 抛 → 整段 renderStatus 中断 →
            //    崩溃态显示成 ready、撕裂层也建不出来,三个症状一个根因)。
            // ⚠️ 类名只留**一个 token**:左右放到 data-eye 上。替身(与一些朴素实现)按类名精确匹配,
            // "agent-orb-eye l" 这种两 token 会让它查不到(实测:两只眼睛数成 0)。
            // 类名单个 token 用 setClass(真身与测试替身都认);左右放 data-eye。
            // ⚠️ 别用 attr(node,'class',...) 写类名:替身的 matches() 读的是 className、不同步属性表,
            //    于是它会把两只眼睛数成 0(实测)。单 token 也本来更干净。
            setClass(eye, 'agent-orb-eye', true);
            attr(eye, 'data-eye', sign < 0 ? 'l' : 'r');
            look.appendChild(eye);
        }
        svg.appendChild(look);
        return svg;
    }

    /** 造球的一次性工作。幂等:同一颗球挂载两次也只造一层。 */
    function ensureOrb() {
        // ⚠️ **必须每次都把引用取回来**:外壳/替身里可能已经有一层 .agent-orb-bot(切视图会重建面板),
        //    早退而不赋值 orbLook/orbBody/orbEyes 的后果是:那个实例的注视整条不跑(它的 canGaze()
        //    要求 orbLook),撕裂层也建不出来(ensureTear 同样要求 orbLook)。实测就是这么踩到的。
        const existed = pick(sendBtn, '.agent-orb-bot');
        if (existed !== null) {
            orbBody = pick(existed, '.agent-orb-body');
            orbLook = pick(existed, '.agent-orb-look');
            orbEyes = typeof existed.queryAll === 'function' ? existed.queryAll('.agent-orb-eye') : [];
            setClass(sendBtn, 'agent-orb', true);
            return;
        }
        setClass(sendBtn, 'agent-orb', true);
        const wrap = el(doc, 'span', 'agent-orb-bot');
        attr(wrap, 'aria-hidden', 'true');            // 它只是画;名字在按钮上(纯图形按钮)
        const svg = svgEl('svg');
        attr(svg, 'viewBox', `0 0 ${FACE.view} ${FACE.view}`);
        attr(svg, 'aria-hidden', 'true');
        const body = svgEl('g');
        setClass(body, 'agent-orb-body', true);
        const head = svgEl('circle');
        attr(head, 'cx', String(FACE.view / 2));
        attr(head, 'cy', String(FACE.view / 2));
        attr(head, 'r', String(FACE.headR));
        attr(head, 'fill', '#f2f6ff');
        // 颜色(思考青蓝 / 流式青绿)是 CSS 按 data-face 改 head 的 fill —— 需要一个类
        setClass(head, 'agent-orb-head', true);
        body.appendChild(head);
        svg.appendChild(body);
        const look = svgEl('g');
        setClass(look, 'agent-orb-look', true);
        orbEyes = [];
        for (const sign of [-1, 1]) {
            const eye = svgEl('ellipse');
            attr(eye, 'cx', String(FACE.view / 2 + sign * FACE.eyeCx));
            attr(eye, 'cy', '16.2');                  // 略低于中线:看着更"在看人"
            attr(eye, 'rx', String(FACE.eyeRx));
            attr(eye, 'ry', '3.3');
            attr(eye, 'fill', '#0b0d16');
            // ⚠️ 类名只留**一个 token**:左右放到 data-eye 上。替身(与一些朴素实现)按类名精确匹配,
            // "agent-orb-eye l" 这种两 token 会让它查不到(实测:两只眼睛数成 0)。
            // 类名单个 token 用 setClass(真身与测试替身都认);左右放 data-eye。
            // ⚠️ 别用 attr(node,'class',...) 写类名:替身的 matches() 读的是 className、不同步属性表,
            //    于是它会把两只眼睛数成 0(实测)。单 token 也本来更干净。
            setClass(eye, 'agent-orb-eye', true);
            attr(eye, 'data-eye', sign < 0 ? 'l' : 'r');
            look.appendChild(eye);
            orbEyes.push(eye);
        }
        svg.appendChild(look);
        wrap.appendChild(svg);
        sendBtn.appendChild(wrap);
        orbBody = body;
        orbLook = look;
    }

    /* ================= 撕裂层:只在"连不上"时存在 =================
       ⚠️ 9 张脸副本 + 一堆动画**常驻**是纯空耗(离屏实测:这一套在主线程上约 9.7% 单核)。
       所以规矩是:**进 failed/crashed 才建,一离开就整体回收** ——
       节点一移除,它带的动画也一起没了,不需要额外 clearInterval/animationName 之类。
       「裂开」的结构:失败态**没有完整底脸**(CSS 把 .bot 藏了),脸由这 9 条横片拼成,
       所以任何一片错位都会在中间露出背景 —— 这才是"快要无法显示"。 */
    /* 状态 → 脸。判据**全部来自真身已有的字段**,不新增任何状态机:
         status.state(全是 STATE_LABEL 里那几个)/ state.busy / state.permissions /
         videoBusy(视频理解那条路的长任务)。
       "思考中 vs 流式中"的分界 = **本轮是否已经吐出内容**:从最后一条用户消息之后
       找有没有 assistant 消息 —— 有 = 流式在吐,没有 = 还在等首个字。 */
    function deriveFace(status, st, videoBusyNow) {
        const name = status ? status.state : 'stopped';
        if (name === 'failed' || name === 'crashed') return 'failed';
        if (name === 'stopped' || name === 'stopping') return 'stopped';
        if (name === 'starting') return 'starting';
        const perms = Array.isArray(st.permissions) ? st.permissions : [];
        // ⚠️ 判据是"有没有**未决**的那一条",不是"数组里有没有条目"。
        //    为什么:已决的条目**永远留在** state.permissions 里 —— resolvePermission() 只标上
        //    resolved,prompt-end / hydrateFromLedger 都不清它(clearConversation 才清,那要换会话)。
        //    那是**故意**的:那份记录还兜着 answered 集合与"恰好回答一次"的保证,清它牵动的是
        //    回答通道,不是这张脸。所以判据得自己把"已决"读出来。
        //    按"有条目"判的话,产品要求"答完就消失"之后痕迹就跑到脸上来了 —— 实测:两张卡都从
        //    DOM 消失、一轮也结束了,球却还摆着"我在等你决定"(panelFace/orbFace 都是 waiting)。
        //    `p && p.resolved === true` 才算已决:条目缺字段(脏数据)一律当**未决**,宁可多摆一会儿脸。
        if (perms.some((p) => !(p && p.resolved === true))) return 'waiting';   // 权限卡 / 提问卡:在等你决定
        if (videoBusyNow === true) return 'longtask';            // 视频理解:四段阶段
        if (st.busy === true) {
            const msgs = Array.isArray(st.messages) ? st.messages : [];
            let lastUser = -1;
            for (let i = msgs.length - 1; i >= 0; i -= 1) { if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; } }
            const replied = msgs.slice(lastUser + 1).some((m) => m && m.role === 'assistant');
            return replied ? 'streaming' : 'thinking';
        }
        return 'idle';
    }
    let currentFace = null;
    let tearSlices = 0;
    let tearHost = null;
    let tearBuiltAt = 0;
    /** 建撕裂层(幂等)。片高按 TEAR_SLICES 均分;每片 4 个爆发错位值(片片不同)。 */
    function ensureTear() {
        if (tearHost !== null) return tearHost;
        // ⚠️ 只要求 sendBtn:切片是 buildFaceSvg() 自己造出来的整脸副本,与 orbLook 无关。
        //    早先写成 `orbLook === null` 就 return —— 于是重建过的面板(切视图)永远建不出撕裂层(实测踩到)。
        if (sendBtn === null) return null;
        const host = el(doc, 'span', 'agent-orb-tear');
        attr(host, 'aria-hidden', 'true');
        const head0 = 9.375, headH = 81.25;                 // 头在 32 视框里占的竖向范围(26/32)
        const band = headH / TEAR_SLICES;
        for (let i = 0; i < TEAR_SLICES; i += 1) {
            const sl = el(doc, 'i');
            const top = head0 + i * band;
            // 四个错位值:幅度 3–8px、方向交替 —— 每片不同,才会"碎成很多片"而不是"两三片来回"
            // ⚠️ style 要**一次写完**:写两次的话后一次会把前一次整体覆盖掉,
            //    于是 clip-path 丢失、9 条切片变成 9 张叠在一起的整脸(看着正常、其实不会撕)。实测踩过。
            const base = 3.2 + ((i * 1.7) % 4.8);
            const sign = (i % 2 === 0) ? 1 : -1;
            attr(sl, 'style',
                `clip-path:inset(${top.toFixed(3)}% 0 ${(100 - top - band).toFixed(3)}% 0);`
                + `--ta:${(sign * base).toFixed(1)}px;--tb:${(-sign * (base * 0.72)).toFixed(1)}px;`
                + `--tc:${(sign * (base * 0.9 + 1)).toFixed(1)}px;--td:${(-sign * (base * 0.55)).toFixed(1)}px`);
            sl.appendChild(buildFaceSvg());
            host.appendChild(sl);
        }
        // ⚠️ 撕裂片画在脸**上面**(要替换那一行的内容),底脸在失败态由 CSS 藏掉
        sendBtn.appendChild(host);
        tearHost = host;
        tearBuiltAt = nowMs();
        return host;
    }
    /** 回收:整层拿掉(动画随之消失)。返回被回收的片数,便于写日志/断言。 */
    function dropTear() {
        if (tearHost === null) return 0;
        const n = tearHost.children ? tearHost.children.length : 0;
        if (typeof tearHost.remove === 'function') tearHost.remove();
        else if (tearHost.parentNode && typeof tearHost.parentNode.removeChild === 'function') tearHost.parentNode.removeChild(tearHost);
        tearHost = null;
        return n;
    }
    const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now() : Date.now());
    /** 这条整条都依赖**布局与帧**:替身(测试桩)两样都没有 → 整段不跑,球退化成一个普通按钮。
     *  这也正是单测里那二十来次 `sendBtn.fire('click')` 还能照旧工作的原因。 */
    const canGaze = () => sendBtn !== null && orbLook !== null
        && typeof sendBtn.getBoundingClientRect === 'function'
        && typeof requestAnimationFrame === 'function';
    let gazeRaf = 0, gazeT = 0, gazeMode = '', gazeLooks = 0, gazeSkip = '';
    let mouseNear = false, mouseMovedAt = -1e9, mouseVec = { x: 0, y: 0 };
    let notice = null, lastGlance = 0;
    let caret = null, caretMeasuredAt = 0, caretEl = null, caretCostMax = 0;
    let blinkTimer = 0, nextWander = 0;
    let orbCenterCache = null, orbCenterAt = -1e9;
    let messagesObs = null;
    const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 }, bodyCur = { x: 0, y: 0 };

    /** 球心(屏幕坐标)。**缓存 250ms**:每次 mousemove 都 getBoundingClientRect
     *  就是"鼠标每动一下读一次 layout"(每秒上百次)。250ms 的陈旧最多让"靠近"判据差几个像素,
     *  而那个半径是 110px —— 看不出来;布局真变了(resize)时立刻作废。 */
    function orbCenter() {
        const t = nowMs();
        if (orbCenterCache !== null && t - orbCenterAt < 250) return orbCenterCache;
        const r = typeof sendBtn.getBoundingClientRect === 'function' ? sendBtn.getBoundingClientRect() : null;
        // ⚠️ 0×0 的矩形**不是**"球跑到左上角去了",而是"这一帧它没被排版"(重画中间、容器隐藏)。
        //    那种值一旦进了这个 250ms 缓存,"鼠标靠近"就会拿 (0,0) 当球心算距离 ——
        //    实测踩过一次:鼠标明明贴着球,dist 却报 1428px(整个视口的对角),
        //    于是"盯鼠标"那条断言假红。所以量到 0 就**不作数**:继续用上一次的好值,
        //    而且**不更新缓存时间**(下一次调用立刻重量,不被这 250ms 拖住)。
        if (r !== null && r.width > 0 && r.height > 0) {
            orbCenterCache = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
            orbCenterAt = t;
            return orbCenterCache;
        }
        if (orbCenterCache !== null) return orbCenterCache;
        // 还一次都没量到过:尺寸按 44 算(手感幅度照常),位置欠奉 —— 下一次 mousemove 就会重量,
        // 上面那条保证了"坏值不进缓存"。
        return { x: 0, y: 0, w: ORB_SIZE, h: ORB_SIZE };
    }
    function forgetOrbCenter() { orbCenterCache = null; orbCenterAt = -1e9; }
    /** 球的像素幅度:按**实测**球径算(改了 CSS 尺寸,手感跟着变,不用改代码)。 */
    const maxOff = () => maxOffset(orbCenter().w || ORB_SIZE);

    function onOrbMouseMove(e) {
        const c = orbCenter();
        const dx = (e.clientX ?? 0) - c.x, dy = (e.clientY ?? 0) - c.y;
        const dist = Math.hypot(dx, dy);
        mouseMovedAt = nowMs();
        mouseNear = dist <= NEAR;
        if (mouseNear) mouseVec = towardMouse(dx, dy, maxOff());
        // 诊断:这两个属性是"它为什么不跟鼠标"的唯一证据(界面上只看到它在自己四处看)。
        // 与 data-gaze-skip 同一类东西:机器可读、自检直接读。
        attr(panel, 'data-gaze-mouse', mouseNear ? 'near' : 'far');
        attr(panel, 'data-gaze-dist', String(Math.round(dist)));
    }

    /** 四处看:每 0.6–1.2s 换一个方向(换太快像抽风,太慢像死机)。 */
    function wanderTo(now) {
        if (now < nextWander) return;
        nextWander = now + FACE.wanderMin + Math.random() * (FACE.wanderMax - FACE.wanderMin);
        const a = Math.random() * Math.PI * 2;
        const r = maxOff() * (0.35 + Math.random() * 0.65);
        target.x = Math.cos(a) * r;
        target.y = Math.sin(a) * r;
    }

    /** 消息流里某处变了 → 值不值得看?值得就记一个 notice(带保持时间)。
     *  ⚠️ 不看的原因要**写下来**(gazeSkip):界面上"没反应"和"看错地方"长得一模一样,
     *  而这两种情况的排查方向完全不同 —— 原因码会进 data-gaze-skip,自检直接读它。 */
    function glanceAtNode(node) {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const now = nowMs();
        if (now - lastGlance < NOTICE_GAP) { gazeSkip = 'throttle'; return false; }
        const r = node.getBoundingClientRect();
        const c = orbCenter();
        const v = toward(r.left + r.width / 2 - c.x, r.top + r.height / 2 - c.y);
        const view = eventDoc?.defaultView ?? null;
        const visible = view === null ? true
            : !(r.bottom < 0 || r.top > view.innerHeight || r.right < 0 || r.left > view.innerWidth);
        const bad = glanceVerdict({ area: r.width * r.height, dist: v.dist, visible });
        if (bad !== null) { gazeSkip = bad; return false; }
        lastGlance = now;
        gazeSkip = '';
        notice = { ux: v.ux, uy: v.uy, until: now + NOTICE_MS, label: v.label };
        gazeLooks += 1;
        attr(panel, 'data-gaze-looks', String(gazeLooks));
        return true;
    }

    /* 编辑点:kaiwu 的笔记正文是**多个** <textarea class="blk-input">(一篇笔记分块编辑),
       只给**当前聚焦的那一块**建镜像,并按元素缓存(WeakMap)—— 块被重渲染掉时镜像跟着走。

       ⚠️ 为什么是镜像、而不是"看那一块":验收要求"光标换行/换侧,目光跟着变",而整块的中心
          是不动的,量不出来。代价两条:**每次量都要读一次 layout**(用 CARET_GAP=80ms 节流),
          以及镜像的字体/内边距/边框/宽度/换行规则必须与 textarea **逐项一致** —— 差一项就整体偏,
          而那种偏差在界面上看着"差不多对",最难发现。所以下面每一项都从 getComputedStyle 抄。
       这条路在 kaiwu 上划算的原因:textarea **自动长高、内部不滚动**(notes/editor.js 的 autoGrow),
          于是镜像法最麻烦的那一项(同步 scrollTop)根本不存在。 */
    const caretMirrors = new WeakMap();
    const MIRROR_CLASS = 'agent-caret-mirror';
    function caretMirrorFor(ta) {
        let m = caretMirrors.get(ta);
        if (m && m.parentNode === ta.parentNode) return m;
        m = el(doc, 'div', MIRROR_CLASS);
        attr(m, 'aria-hidden', 'true');
        if (ta.parentNode && typeof ta.parentNode.appendChild === 'function') ta.parentNode.appendChild(m);
        caretMirrors.set(ta, m);
        return m;
    }
    function syncMirror(ta, m) {
        const view = ta.ownerDocument?.defaultView ?? null;
        const cs = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(ta) : null;
        if (cs === null || typeof m.style !== 'object') return false;
        for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
            'textTransform', 'textIndent', 'wordBreak', 'overflowWrap', 'whiteSpace', 'tabSize', 'direction',
            'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
            'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
            m.style[k] = cs[k];
        }
        // ⚠️ 原点用 **textarea 的视口矩形**(镜像在 CSS 里是 position:fixed),不用 offsetLeft/offsetTop:
        // 那对值是相对 offsetParent 的,而笔记块(.blk)并**不是**定位元素 —— 一旦原点算错,
        // 量出来的点就落在编辑框外,于是**永远走兜底**(实测就是这么退化成"看整块"的)。
        // 视口坐标没有这个歧义:fixed 定位的包含块就是视口,量的也是视口坐标,两边同源。
        const tr = typeof ta.getBoundingClientRect === 'function' ? ta.getBoundingClientRect() : null;
        if (tr === null) return false;
        m.style.left = `${tr.left}px`;
        m.style.top = `${tr.top}px`;
        m.style.width = `${ta.offsetWidth}px`;        // 宽度定死:折行位置才与 textarea 一致
        m.style.height = 'auto';
        return true;
    }
    function caretRectOf(ta) {
        const m = caretMirrorFor(ta);
        if (!syncMirror(ta, m)) return null;
        const at = typeof ta.selectionStart === 'number' ? ta.selectionStart : 0;
        m.textContent = String(ta.value ?? '').slice(0, at);   // 有选区时看起点(与"编辑点"一致)
        const mk = el(doc, 'span');
        mk.textContent = '\u200b';                             // 零宽空格:给 span 一个可量的盒子
        m.appendChild(mk);
        const r = typeof mk.getBoundingClientRect === 'function' ? mk.getBoundingClientRect() : null;
        const box = typeof ta.getBoundingClientRect === 'function' ? ta.getBoundingClientRect() : null;
        if (r === null || box === null) return null;
        // 兜底:量出来的点落在编辑框外(字体亚像素差 / 折行差一行)→ 退回整块的中心。
        // **不硬信镜像**:宁可粗一点,也不要一个错位的点把眼睛甩到屏幕角落。
        const mid = { x: box.left + box.width / 2, y: box.top + box.height / 2, fallback: true };
        if (r.width === 0 && r.height === 0) return mid;
        if (r.top + r.height < box.top - 2 || r.top > box.bottom + 2) return mid;
        return { x: r.left, y: r.top + r.height / 2, fallback: false };
    }
    /** 编辑动作 → 记下编辑点。节流只挡**量**(80ms),不挡"还在写"的续期。 */
    function noteEditPoint() {
        const active = eventDoc?.activeElement ?? null;
        const ta = active && typeof active.closest === 'function' ? active.closest('textarea.blk-input') : null;
        if (ta === null || ta === undefined) {
            // 焦点离开笔记正文(点了别处、或失焦)→ 立刻松开:不要还盯着一个旧光标
            if (caretEl !== null) { caretEl = null; caret = null; }
            return;
        }
        caretEl = ta;
        const now = nowMs();
        if (now - caretMeasuredAt >= CARET_GAP) {
            // 成本自量:镜像每次都要读一次 layout,所以把**这一次**与**最坏一次**都写在面板上
            // (data-gaze-caret-ms / -max)。这条路上的开销在界面上看不见,只能量 ——
            // 数字公开了,以后谁把它改慢了都能立刻看出来(自检直接读这两个属性)。
            const t0 = nowMs();
            const rect = caretRectOf(ta);
            const cost = nowMs() - t0;
            if (cost > caretCostMax) caretCostMax = cost;
            attr(panel, 'data-gaze-caret-ms', cost.toFixed(1));
            attr(panel, 'data-gaze-caret-max', caretCostMax.toFixed(1));
            if (rect !== null) {
                caretMeasuredAt = now;
                const c = orbCenter();
                const v = toward(rect.x - c.x, rect.y - c.y);
                caret = { ux: v.ux, uy: v.uy, until: now + EDIT_HOLD_MS, label: v.label };
                attr(panel, 'data-gaze-caret', rect.fallback === true ? 'block-center' : 'mirror');
            }
        } else if (caret !== null) {
            caret.until = now + EDIT_HOLD_MS;       // 没到 80ms 不再量,但"还在写"要续上
        }
    }
    const onEditPointEvent = () => { noteEditPoint(); };

    /* 页面变化:只盯**消息流**这一个容器,并且开 characterData ——
       流式输出是往**已有文本节点**里追加(characterData),只看 childList 会整类漏掉;
       反过来,characterData 开在 document.body 上会被打字/光标每一下淹掉。
       笔记那边**一条观察器都不挂**:它的"变化"由上面那条**编辑点**的路表达(优先级也更高)。
       ⚠️ 排除表写的是**真身的实际节点名**:球、球里的图层、状态字、光标镜像 —— 它们都是
          "我自己"的更新,漏一个它就永远在看着自己动。改节点名时这张表要跟着改。 */
    const GAZE_IGNORE = `#agentStatus, #agentSend, .agent-orb, .${MIRROR_CLASS}`;
    function observeMessages() {
        if (messagesEl === null || messagesEl === undefined || typeof MutationObserver !== 'function') return null;
        const obs = new MutationObserver((list) => {
            for (const m of list) {
                const t = m.target;
                if (!t) continue;
                const host = t.nodeType === 1 ? t : t.parentElement;
                if (host && typeof host.closest === 'function' && host.closest(GAZE_IGNORE) !== null) continue;
                // 目标可能是**文本节点**(characterData / textContent 更新)→ 用它的父元素
                const node = (m.type === 'childList' && m.addedNodes && m.addedNodes.length > 0)
                    ? m.addedNodes[0] : t;
                const box = (node && node.nodeType === 1) ? node : (node?.parentElement ?? host);
                if (box) glanceAtNode(box);
            }
        });
        obs.observe(messagesEl, { childList: true, subtree: true, characterData: true });
        return obs;
    }

    function gazeFrame(now) {
        const dt = gazeT === 0 ? 16.7 : now - gazeT;
        gazeT = now;
        const asleep = now - mouseMovedAt > IDLE_MS;
        const tracking = mouseNear && !asleep;
        const src = pickSource({ tracking, caret, notice, now });
        // ---- 状态门(接进真身后新增的那道)----
        //   full(就绪)= 1:现有手感一个字不改;low(思考/流式/长任务)= 0.4:忙,但你互动它还有反应;
        //   pause(连接中/连不上/已停止/等待)= 0:位置交给 CSS 的状态姿势,**这一帧不写 transform**
        //   (写了就会把 CSS 的姿势盖掉)。
        const gscale = gazeScale(currentFace === null ? 'idle' : currentFace);
        const M = maxOff();
        let label = '四处看';
        if (src === 'mouse') {
            target.x = mouseVec.x;
            target.y = mouseVec.y;
            label = '盯着鼠标';
        } else if (src === 'caret') {
            target.x = caret.ux * M;
            target.y = caret.uy * M;
            label = `看编辑点(${caret.label})`;
        } else if (src === 'notice') {
            target.x = notice.ux * M;
            target.y = notice.uy * M;
            label = notice.label === '' ? '看变化' : `看${notice.label}的变化`;
        } else {
            notice = null;
            wanderTo(now);
            label = (mouseNear && asleep) ? '四处看(鼠标没动)' : '四处看';
        }
        if (gscale <= 0) { cur.x = 0; cur.y = 0; bodyCur.x = 0; bodyCur.y = 0; }
        target.x *= gscale;
        target.y *= gscale;
        const aEye = ease(dt, FACE.tauEye), aBody = ease(dt, FACE.tauBody);
        cur.x += (target.x - cur.x) * aEye;
        cur.y += (target.y - cur.y) * aEye;
        bodyCur.x += (cur.x * FACE.ratio - bodyCur.x) * aBody;
        bodyCur.y += (cur.y * FACE.ratio - bodyCur.y) * aBody;
        // pause 时不写:让 CSS 的 [data-face] 姿势说了算(否则逐帧写会把姿势盖掉)
        if (gscale > 0) attr(orbLook, 'transform', `translate(${cur.x.toFixed(2)} ${cur.y.toFixed(2)})`);
        const tilt = (bodyCur.x / Math.max(M, 0.01)) * FACE.tilt;
        attr(orbBody, 'transform',
            `translate(${bodyCur.x.toFixed(2)} ${bodyCur.y.toFixed(2)}) rotate(${tilt.toFixed(2)} 16 16)`);
        if (label !== gazeMode) {
            gazeMode = label;
            // 机器可读的那一份挂在**面板**上:自检读 data-gaze / data-gaze-skip 就够,
            // 不需要 window 全局(属性变化不进 childList,观察器不会因此自激)
            attr(panel, 'data-gaze', label);
            attr(panel, 'data-gaze-skip', gazeSkip);
        }
        gazeRaf = requestAnimationFrame(gazeFrame);
    }

    /** 眨眼:2.6–6s 随机一次。只改一个 class(属性变化,不进观察器的 childList)。 */
    function blinkLoop() {
        blinkTimer = setTimeout(() => {
            const cl = sendBtn.classList;
            if (cl && typeof cl.add === 'function') cl.add('is-blinking');
            setTimeout(() => {
                if (cl && typeof cl.remove === 'function') cl.remove('is-blinking');
                if (gazeRaf !== 0) blinkLoop();
            }, 90);
        }, 2600 + Math.random() * 3400);
    }

    function startGaze() {
        if (!canGaze()) return;                        // 替身/老外壳:没有布局与帧,这条整条不跑
        forgetOrbCenter();
        if (canListenDoc) {
            eventDoc.addEventListener('mousemove', onOrbMouseMove, { passive: true });
            eventDoc.addEventListener('focusin', onEditPointEvent);
            eventDoc.addEventListener('selectionchange', onEditPointEvent);
            eventDoc.addEventListener('input', onEditPointEvent);
            eventDoc.addEventListener('keyup', onEditPointEvent);
            eventDoc.addEventListener('click', onEditPointEvent);
            if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('resize', forgetOrbCenter);
        }
        messagesObs = observeMessages();
        attr(panel, 'data-gaze-looks', String(gazeLooks));   // 起手就有 0:自检的不增断言要读到数字
        blinkLoop();
        gazeT = 0;
        gazeRaf = requestAnimationFrame(gazeFrame);
    }
    /** 收干净:帧、眨眼定时器、观察器、文档级监听(少收一样就是"面板没了还在跑")。 */
    function stopGaze() {
        if (gazeRaf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(gazeRaf);
        gazeRaf = 0;
        if (blinkTimer !== 0) { clearTimeout(blinkTimer); blinkTimer = 0; }
        if (messagesObs !== null) { messagesObs.disconnect(); messagesObs = null; }
        if (canListenDoc) {
            eventDoc.removeEventListener('mousemove', onOrbMouseMove);
            eventDoc.removeEventListener('focusin', onEditPointEvent);
            eventDoc.removeEventListener('selectionchange', onEditPointEvent);
            eventDoc.removeEventListener('input', onEditPointEvent);
            eventDoc.removeEventListener('keyup', onEditPointEvent);
            eventDoc.removeEventListener('click', onEditPointEvent);
            if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('resize', forgetOrbCenter);
        }
    }

    // ---------- 事件绑定 ----------

    // 一颗球:空闲=发送、执行中=取消。
    // ⚠️ 判据用 state.busy,与旧「取消」按钮的禁用判据同源:旧「发送」在执行中一定是灰的,
    //    所以"busy 就取消"与旧行为一一对应。输入框的 Enter 那条路**不变**(见下面 keydown)。
    sendBtn?.addEventListener('click', () => (state.busy === true ? cancel() : send()));
    retryBtn?.addEventListener('click', () => start());
    killBtn?.addEventListener('click', () => killProcess());
    /* ⚠️ 中文输入法(IME)组合态:多行输入里 Enter 有两个含义 —— **确认候选字** vs 发送。
       组合期间绝不能把"选字"当成发送。三重判据(缺一条都可能漏):
         e.isComposing === true   标准字段;
         composing 标志              compositionstart/end 维护 —— 有些输入法在 compositionend
                                     之后紧跟着一次 Enter,那一刻 isComposing 已经变回 false;
         e.keyCode === 229         老式"正在组合"的信号(旧 IME / 旧内核)。
       命中任一条就**直接放行**(不 preventDefault、不发送),让输入法自己处理那个 Enter。
       Shift+Enter 同理放行:textarea 的默认行为就是换行,拦了就换不了行。 */
    let composing = false;
    input?.addEventListener('compositionstart', () => { composing = true; });
    input?.addEventListener('compositionend', () => { composing = false; });
    input?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.isComposing === true || composing === true || e.keyCode === 229) return;
        if (e.shiftKey === true) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return send();
    });
    // 黏贴截图。只拦含图片的粘贴:不含图片时**什么都不做**(不 preventDefault、
    // 不碰 value),粘文字的行为一个字节都不变。视频同理(黏贴文件也能粘到视频)。
    /** 随内容长高:先归零再读 scrollHeight(不归零只会越读越大),到 --agent-input-max 之后交给内部滚。 */
    const growInput = () => {
        if (input === null || input.tagName !== 'TEXTAREA' || input.style === undefined) return 0;
        const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(input) : null;
        const max = cs ? parseFloat(cs.maxHeight) : NaN;
        const prev = input.style.height;
        input.style.height = 'auto';
        const want = Number(input.scrollHeight) || 0;
        if (want <= 0) { input.style.height = prev; return 0; }
        const capped = (Number.isFinite(max) && max > 0) ? Math.min(want, max) : want;
        input.style.height = capped + 'px';
        input.style.overflowY = (Number.isFinite(max) && want > max) ? 'auto' : 'hidden';
        return capped;
    };
    input?.addEventListener('input', () => { growInput(); });
    input?.addEventListener('paste', (e) => onPaste(e));
    // 拖放。⚠️ 只挂在**面板**这一处:输入框是面板的后代,而 dragover/drop 会**冒泡** ——
    // 两处都挂就等于同一段视频被处理两次(第二次会撞上"上一段还在理解"并弹一句
    // 莫名其妙的提示,而第一次其实好好地建了卡片)。挂在面板上,拖到输入框、
    // 消息区还是面板任何角落都只处理一次。
    // 面板缺失时(替身/旧结构)才退回输入框。
    const dropTarget = (panel && typeof panel.addEventListener === 'function') ? panel : input;
    dropTarget?.addEventListener('dragover', (e) => onDragOver(e));
    dropTarget?.addEventListener('drop', (e) => onDrop(e));

    // 「请 AI 面板理解一段本地视频」:别的面板(B站下载队列)用 DOM 事件请过来。
    // 为什么不是一条新 IPC:这是**同一个页面内**两块的协作,而事件里只有叶子字段
    // (路径/目录/名字/大小/提问);真正的准入判据在主进程(admitVideoPath)。
    const eventDoc = panel?.ownerDocument ?? globalThis.document;
    const canListenDoc = eventDoc !== null && eventDoc !== undefined
        && typeof eventDoc.addEventListener === 'function';
    if (canListenDoc) eventDoc.addEventListener('kaiwu:understand-video', onUnderstandVideoRequest);

    let unsubscribe = null;
    function subscribe() {
        if (typeof bridge?.onAgentEvent === 'function') {
            safe(() => { unsubscribe = bridge.onAgentEvent(onEvent) ?? null; }, log);
        } else if (typeof bridge?.on === 'function') {
            safe(() => { unsubscribe = bridge.on('agent:event', onEvent) ?? null; }, log);
        }
        // 视频理解的进度事件(方案 C 的四段行读数)。
        // ⚠️ 与 agent:event **各订各的**:这两条流的生命周期与来源完全不同
        // (一条来自 ACP 会话,一条来自主进程自己的 HTTP 请求),合成一条只会
        // 让"谁推的"变得说不清。没有那个桥方法时**静默跳过** —— 老外壳/单测替身
        // 不会有它,而四段行仍然能画(只是没有中间读数)。
        if (typeof bridge?.onVideoEvent === 'function') {
            safe(() => { videoProgressUnsub = bridge.onVideoEvent(onVideoEvent) ?? null; }, log);
        } else if (typeof bridge?.on === 'function') {
            safe(() => { videoProgressUnsub = bridge.on('video:event', onVideoEvent) ?? null; }, log);
        }
    }

    /** 这一次理解的 requestId。只要求**互不相同**,不承载任何含义。 */
    function nextVideoRequestId() {
        videoRequestSeq += 1;
        return `v-${Date.now().toString(36)}-${videoRequestSeq}`;
    }

    render();
    subscribe();

    /**
     * 挂载。`autoStart` 为真时就是"打开即对话":这里发一次 agent:start。
     * `autoStart=false` 时**绝不**自动连 —— 状态停在 stopped,由用户/自检点
     * #agentRetry 显式开始。凭证状态仍然取一次(卡片要在缺凭证时就能说清原因)。
     */
    async function mount() {
        // 球先"活起来"(替身/老外壳里 canGaze() 为假,这一句什么也不做)。
        // 放在最前面:它只依赖 DOM 与帧,不依赖 Agent 连没连上 —— 没连上时那颗球
        // 照样应该四处看(它是个控件,不是状态指示器)。
        startGaze();
        await calls('agent:status', {}).then((s) => {
            if (s !== null && typeof s === 'object') {
                state = reduceAgentEvent(state, { kind: 'state', status: s });
                if (typeof s.sessionId === 'string') state = { ...state, sessionId: s.sessionId };
                render();
            }
        }).catch((err) => log.warn?.('[agent] 取状态失败', err));

        await loadCredentials();
        applyCredentialVisibility();

        started = true;
        if (autoStart !== true) {
            render();
            return state.status;
        }
        return start();
    }

    return {
        mount,
        onEvent,
        start,
        send,
        cancel,
        killProcess,
        loadCredentials,
        /** 外壳在笔记打开/切换时调一次,刷新"这次会带上哪篇笔记"。 */
        syncNote: () => { renderContext(); },
        dispose() {
            if (typeof unsubscribe === 'function') safe(unsubscribe, log);
            unsubscribe = null;
            if (typeof videoProgressUnsub === 'function') safe(videoProgressUnsub, log);
            videoProgressUnsub = null;
            // 秒表与"这一次"的身份也要收干净:面板没了还留一个 setInterval 在跑,
            // 就是一处永远不退出的定时器(而且它会一直调 render)。
            stopStageTicker();
            // 思考那条秒表同理(它有思考在飞的时候每 250ms 调一次 render)
            stopThinkTicker();
            videoBusy = false;
            videoRequestId = '';
            // 轮次轨:监听器、摘要、以及那一帧都要收干净(面板卸载后它们引用的节点
            // 已经不在文档里,继续跑就是纯粹的泄漏)。
            if (typeof messagesEl?.removeEventListener === 'function') {
                messagesEl.removeEventListener('scroll', onMessagesScroll);
            }
            if (typeof railEl.removeEventListener === 'function') {
                railEl.removeEventListener('wheel', onRailWheel);
            }
            if (typeof globalThis.removeEventListener === 'function') {
                globalThis.removeEventListener('resize', onPanelResize);
            }
            hideRailTip();
            // 球的帧、眨眼定时器、消息观察器、文档级监听 —— 少收一样就是"面板没了还在跑"。
            stopGaze();
            railTicks = [];
            turnEls = [];
            turnOffsets = [];
            // 文档级的事件监听也要摘:同一个文档里挂过两次(切视图重建面板)时,
            // 不摘就会让一次点击触发两次理解。
            if (canListenDoc) eventDoc.removeEventListener('kaiwu:understand-video', onUnderstandVideoRequest);
            // blob: URL 不 revoke 就一辈子不回收(一张一张攒)。两边都要收:
            //   ① 还留在输入区没发的 chip —— 归输入区;
            //   ② 已经移交给消息气泡的 —— 归气泡,这里传 true 全撤(面板整个要没了,
            //      不需要再看 state 里还有没有引用它)。
            clearImages();
            releaseMessageImages(true);
        },
        get state() { return state; },
        get credentials() { return credentials; },
        get started() { return started; },
        get autoStart() { return autoStart; },
        // ---- 视频理解 ----
        // 单独一条路(不经过 ACP 会话),所以这几个入口与 send/cancel 平级暴露,
        // 而不是塞进"提示"里。自检与单测据此驱动整条链路。
        /** 收下一段视频当草稿(与拖放/黏贴走的是同一个函数;**不发任何 IPC**)。 */
        addVideo,
        /** 发送当前草稿(通常由 send() 分发过来;单测也直接调它)。 */
        sendVideo,
        /** 按**本地路径**理解一段(队列那条入口;单测直接调它,不必合成 DOM 事件)。 */
        understandVideoPath,
        /** 取消这一次理解(四段行旁边那个按钮;单测也直接调它)。 */
        cancelVideo,
        /** 拉一次配置与凭证状态(叶子字段,不含密钥值)。 */
        loadVideoStatus,
        /** 移除草稿(不影响已经进消息流的那条)。 */
        clearVideo: removeVideo,
        get videoInfo() { return videoInfo; },
        get pendingVideo() { return pendingVideo; },
        get videoBusy() { return videoBusy; },
    };
}