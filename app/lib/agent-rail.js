// 会话轮次导航轨(方案 D:状态语义轨)的**纯逻辑**。
//
// 为什么单独一个文件(与 agent-image / agent-video / bilibili-queue 同一个理由):
//   这些判据同时被**面板**(渲染)与**单测**用着,而面板的 DOM 渲染跑不进 node --test。
//   于是"哪几轮、每轮什么状态、当前是第几轮、摘要写什么"全部做成纯函数,逐条钉住。
//
// ⚠️ 不许 import 任何 node: 模块(渲染进程要用)。
//
// 一、"轮"是什么(定义只此一处):
//   一条**用户消息**开启一轮;这一轮一直延伸到**下一条用户消息之前** ——
//   中间所有助手回复、工具调用、思考都算这一轮的。这与界面上的分组是同一件事:
//   面板先把时间线切成渲染单元(app/agent/panel.js 的 planTimeline),再按用户消息分段。
//
// 二、状态从哪来(**只用真实数据,不新造**):
//   · `failed` —— 这一轮里出现过失败:工具卡的状态是 failed/error,或者这条助手消息的
//     状态行里有 state==='failed' 的那一行(视频理解:哪一步断了红在哪一步)。**另有**一个
//     兜底:面板那句全局 error 只对**最后一轮**生效(它不带轮次信息,把历史轮次也染红就是编)。
//     用户自己按的取消(cancelled)不算失败 —— 它不是故障。
//   · `tool` —— 这一轮里有工具调用。
//   · `ok` —— 其余一切,包括"判不出来"的情况。**刻意不发明第四种颜色**:
//     颜色是有语义的,多一种就多一条用户要学会的约定,而认不出来的那些本来就该安静。
//
// 三、颜色编码必须有图例(RAIL_LEGEND / RAIL_STATUS_LABEL):
//   用色不解释等于没编码。摘要标题里用中文写出状态,aria-label 里也写。

/** 一轮的三种状态。与 CSS 的 `.tick.ok / .tool / .failed` 一一对应。 */
export const RAIL_STATUSES = Object.freeze(['ok', 'tool', 'failed']);

/** 状态的中文名。**摘要与 aria-label 里都要写出来** —— 用户就是靠这句话学会颜色含义的。 */
export const RAIL_STATUS_LABEL = Object.freeze({
    ok: '正常',
    tool: '含工具调用',
    failed: '失败',
});

/** 整条轨的可访问说明(aria-label)。把颜色含义写成句子,读屏与鼠标用户拿到同一份信息。 */
export const RAIL_LEGEND =
    '会话轮次导航:一格一轮,点一下跳到那一轮。灰=正常,蓝=含工具调用,红=失败,绿=当前轮。';

/** 摘要里问题那行最多留几个字(超了截断加省略号)。 */
export const RAIL_QUESTION_MAX = 42;

/** 工具卡的哪些状态算"这一轮失败过"。还在跑的那些不算。 */
const FAILED_TOOL_STATUSES = new Set(['failed', 'error']);

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

function trimmed(v) {
    return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
}

/**
 * 把渲染单元按**用户消息**分段。
 *
 * 第一条用户消息**之前**的单元(少见:欢迎语之类)单独放在 `pre` 里 —— 它们不属于任何一轮,
 * 所以**不给它们格子**(一格必须对应一条能跳过去的用户提问)。
 *
 * @param {Array<object>} units planTimeline 的产物
 * @returns {{pre:Array<object>, turns:Array<Array<object>>}}
 */
export function groupTurns(units) {
    const pre = [];
    const turns = [];
    for (const unit of asArray(units)) {
        if (unit?.kind === 'message' && unit.message?.role === 'user') {
            turns.push([unit]);
            continue;
        }
        if (turns.length === 0) pre.push(unit);
        else turns[turns.length - 1].push(unit);
    }
    return { pre, turns };
}

/** 这一轮里的用户提问(第一条用户消息的文本)。没有就空串。 */
export function turnQuestion(turn) {
    for (const unit of asArray(turn)) {
        if (unit?.kind === 'message' && unit.message?.role === 'user') return trimmed(unit.message.text);
    }
    return '';
}

/** 这一轮里最后一次真实耗时读数(视频那条链路写在助手消息上)。没有就给 null。 */
export function turnTimings(turn) {
    let found = null;
    for (const unit of asArray(turn)) {
        const t = unit?.message?.timings;
        if (t !== null && typeof t === 'object') found = t;
    }
    return found;
}

/**
 * 这一轮里有没有工具调用。
 *
 * ⚠️ 工具在**界面**上是被折成一组(`{kind:'group', tools:[…]}`)之后再画的
 * (见 panel.js 的 planTimeline),所以只认 `kind === 'tool'` 会漏掉绝大多数情况 ——
 * 表现就是"明明有工具调用,轨道上那一格却是灰的"。两种形状都得认。
 */
export function turnHasTool(turn) {
    return asArray(turn).some(u => u?.kind === 'tool'
        || (u?.kind === 'group' && asArray(u.tools).length > 0));
}

/** 把一个单元里所有工具卡的状态取出来(单独一张卡,或折起来那一组里的每一张)。 */
function toolStatuses(unit) {
    if (unit?.kind === 'tool') return [trimmed(unit.tool?.status)];
    if (unit?.kind === 'group') return asArray(unit.tools).map(t => trimmed(t?.status));
    return [];
}

/**
 * 这一轮的状态。
 *
 * @param {Array<object>} turn 渲染单元列表
 * @param {{isLast?:boolean, error?:object|null}} [ctx] 面板那句全局 error 只对最后一轮生效
 * @returns {'ok'|'tool'|'failed'}
 */
export function turnStatus(turn, { isLast = false, error = null } = {}) {
    const units = asArray(turn);
    // ① 工具卡失败(单独一张卡,或者折起来那一组里的任意一张)
    const toolFailed = units.some(u => toolStatuses(u).some(s => FAILED_TOOL_STATUSES.has(s)));
    // ② 助手消息上那几段状态行里有红色的
    const stageFailed = units.some(u => asArray(u?.message?.stages).some(s => trimmed(s?.state) === 'failed'));
    // ③ 最后一轮 + 面板那句全局 error(它不带轮次信息,只能落在最后;取消不算失败)
    const globalFailed = isLast === true && error !== null && typeof error === 'object'
        && error.cancelled !== true && trimmed(error.message) !== '';
    if (toolFailed || stageFailed || globalFailed) return 'failed';
    if (turnHasTool(units)) return 'tool';
    return 'ok';
}

/**
 * 正在生成的是哪一轮 —— **只有最后一轮**可能是"生成中"(更早的轮次已经收尾)。
 * 没有忙碌信号时给 -1(不画脉冲)。
 *
 * @param {number} count 轮数
 * @param {{busy?:boolean}} ctx 面板的 busy(提示在飞 / 视频理解在飞)
 */
export function liveTurnIndex(count, { busy = false } = {}) {
    const n = Number(count);
    if (busy !== true || Number.isFinite(n) !== true || n <= 0) return -1;
    return n - 1;
}

/**
 * 当前轮序号:滚动位置落在哪一轮上。
 *
 * 判据与 demo 一致:**最后一个 offsetTop 不超过"滚动位置 + 容差"的轮次**。
 * 边界(单测逐条钉着):
 *   · 轮数为 0 → -1(没有轨可高亮);
 *   · 滚到顶 → 0;滚到底 → 最后一轮;
 *   · 只有一个 offset 时恒为 0;
 *   · offsets 里的非数值跳过(宁可沿用上一个,也不要 NaN 让整条轨不亮)。
 *
 * ⚠️ `atBottom`(滚到底了)必须**优先**判:最后一轮的 offsetTop 常常落在可滚范围之外
 * (内容比视口高不出整整一轮,滚动条到不了那儿),只按 offset 比就会永远高亮倒数第二轮 ——
 * 真机实测就是这样(滚到底 scrollTop=173,而最后一轮的 offsetTop=190)。
 *
 * @param {number[]} offsets 每轮的 offsetTop(预计算;滚动回调里**不许**再读 layout)
 * @param {number} scrollTop
 * @param {{pad?:number, atBottom?:boolean}} [opts] 容差 / 是否已滚到底
 */
export function currentTurnIndex(offsets, scrollTop, { pad = 12, atBottom = false } = {}) {
    const list = asArray(offsets);
    if (list.length === 0) return -1;
    if (atBottom === true) return list.length - 1;
    const top = Number(scrollTop);
    const at = Number.isFinite(top) ? top : 0;
    const slack = Number.isFinite(Number(pad)) ? Number(pad) : 12;
    let index = 0;
    for (let i = 0; i < list.length; i += 1) {
        const offset = Number(list[i]);
        if (Number.isFinite(offset) === false) continue;
        if (at >= offset - slack) index = i;
    }
    return index;
}

/**
 * 轨上的滚轮要转发给消息区(轨正好占了原生滚动条的位置,用户的肌肉记忆会把滚轮放那儿)。
 *
 * 纯函数:给出"该滚多少"与"要不要处理",DOM 那一层留给面板。
 *   · 只认纵向(deltaY),**横向滚轮不接**(那是别的手势,拦了就变成抢);
 *   · deltaMode 换算成像素(0=像素 1=行 2=页),并把单次增量夹在 ±600 内 ——
 *     某些鼠标驱动一次给几千,那样会一下跳过头。
 *
 * @param {{deltaY?:number, deltaMode?:number}} event
 * @returns {{handled:boolean, delta:number}} handled=false 表示"这次不该我们管"
 */
export function wheelScrollDelta(event) {
    const raw = Number(event?.deltaY);
    if (Number.isFinite(raw) !== true || raw === 0) return { handled: false, delta: 0 };
    const mode = Number(event?.deltaMode);
    const per = mode === 1 ? 16 : (mode === 2 ? 100 : 1);
    const delta = raw * per;
    return { handled: true, delta: Math.max(-600, Math.min(600, delta)) };
}

/** 超长截断(摘要里那一行问题)。max 之外加省略号;空/非串给空串。 */
export function truncate(text, max = RAIL_QUESTION_MAX) {
    const s = trimmed(text);
    if (s === '') return '';
    const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : RAIL_QUESTION_MAX;
    return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * 悬停/聚焦时那一格显示什么(纯函数,便于直测)。
 *
 * 三行:标题(**第 N 轮 · 状态**,中文写出状态 —— 图例就藏在这句话里)、问题首行(截断)、
 * 有真实耗时就带上。没有的键就**不出现**,不留空行。
 *
 * @param {{index:number, question?:string, status?:string, timings?:object|null}} turn
 */
export function summarizeTurn(turn) {
    const index = Number(turn?.index);
    const n = Number.isFinite(index) && index >= 0 ? index + 1 : 1;
    const status = RAIL_STATUS_LABEL[trimmed(turn?.status)] ?? RAIL_STATUS_LABEL.ok;
    const out = { title: `第 ${n} 轮 · ${status}`, question: truncate(turn?.question) };
    const t = turn?.timings;
    if (t !== null && typeof t === 'object') {
        const secs = (ms) => (Number.isFinite(Number(ms)) ? `${(Math.round(Number(ms) / 100) / 10).toFixed(1)}s` : null);
        const parts = [['上传', secs(t.uploadMs)], ['首字', secs(t.ttftMs)], ['生成', secs(t.generateMs)], ['总计', secs(t.totalMs)]]
            .filter(([, v]) => v !== null)
            .map(([k, v]) => `${k} ${v}`);
        if (parts.length > 0) out.timings = parts.join(' · ');
    }
    return out;
}

/** 那一格的 aria-label:`第 4 轮,含工具调用`(状态用中文,读屏用户也拿得到颜色含义)。 */
export function tickAriaLabel(index, status) {
    const n = Number.isFinite(Number(index)) && Number(index) >= 0 ? Number(index) + 1 : 1;
    const label = RAIL_STATUS_LABEL[trimmed(status)] ?? RAIL_STATUS_LABEL.ok;
    return `第 ${n} 轮,${label}`;
}
