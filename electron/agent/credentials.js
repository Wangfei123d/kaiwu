// 检测 Agent 的凭证**是否存在**。
//
// 为什么需要它:ACP 握手和 session/new 都不需要凭证 —— 链路全绿也可能发不出第一条提示。
// 不提前检查的话,用户看到的是"发出去了没反应",而日志里什么都没有。
//
// ⚠️ 这个模块**绝不读出密钥值**,只回答"有没有"(设计文档 §5.4:密钥不进渲染进程)。
// 它返回的对象只有三个叶子字段,可以直接递到界面上。
import path from 'node:path';

// JSON-RPC 的 -32603(internal error)是 Agent 报"我起不来活"的通用码。
// 凭证缺失只是它的一种原因,所以判定必须**同时**看码和文案 —— 只看码会把
// 工具执行失败、模型内部错误一起吞进"你没配钥匙"。
const RPC_INTERNAL_ERROR = -32603;

// 只认"缺"的措辞(没有 / 未配置 / not set …),**不认**"无效"。
// "钥匙无效"是另一回事:钥匙在、只是不对,给用户的下一步(换一把)与"去配一把"
// 完全不同;混在一起等于把两类故障合并成一句说不清的提示。
const MISSING_CREDENTIAL_PATTERNS = [
    /\b(?:no|missing|without)\s+(?:api[\s_-]?key|credentials?|api[\s_-]?token)\b/i,
    // 这里**不写**前置 \b:DEEPSEEK_API_KEY 里的 "API_KEY" 前面是下划线,
    // 而 \b 在下划线后不成立 —— 那会把最常见的一种措辞漏掉。
    /(?:api[\s_-]?key|credentials?|api[\s_-]?token)\b(?:\s+(?:is|are|was|were))?\s+not\s+(?:set|configured|found|provided|available)\b/i,
    /(?:没有|未配置|未设置|找不到|不存在|缺少|缺失)[^。\n]{0,8}?(?:api[\s_-]?key|凭证|密钥)/i,
    /(?:api[\s_-]?key|凭证|密钥)[^。\n]{0,8}?(?:没有|未配置|未设置|不存在|缺失|找不到)/i,
];

/**
 * 这是不是"Agent 起来了,但没配凭证"那种失败?
 *
 * 为什么需要它:真实流程是 initialize OK → session/new OK → prompt 报
 * `-32603 no API key`,而监护人**仍然是 ready**。不做这个映射,M3-B 的面板会
 * 渲染"已连接",然后让用户面对一个没有解释的失败(终审 Important 5)。
 *
 * 为什么放在这个模块(而不是 acp-client):它回答的是**凭证**问题 ——
 * 与 detectCredentials 同一类,消费它的是同一个"凭证状态"面板。
 * 它只依赖 JSON-RPC 的结构化 `code` 与**对端自己**的文案,
 * 不依赖 acp-client 的错误消息前缀(`ACP 错误 …`),所以不会因为那边的格式变化而失效。
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMissingCredentialError(err) {
    if (err === null || typeof err !== 'object') return false;
    if (err.code !== RPC_INTERNAL_ERROR) return false;
    const message = typeof err.message === 'string' ? err.message : '';
    return MISSING_CREDENTIAL_PATTERNS.some((re) => re.test(message));
}

/**
 * home 缺失时的判词。与"缺 readFile"同一类:都是**调用方接错了线**,
 * 绝不能对用户说成"你没配凭证"。
 */
function wiringReason(what) {
    return `内部错误:detectCredentials 没有拿到 ${what},无法判断凭证文件在哪里。`
        + '这是调用方接错了线,不代表用户没配凭证。';
}

/**
 * @param {{env?:object, home?:string, readFile?:(p:string)=>string}} deps
 *   `home` 是**必填**的:它必须是 Agent 实际使用的 DSH_HOME
 *   (用 app/lib/agent-env.js 的 resolveKaiwuDshHome 解析,spawn 与这里共用同一个值)。
 * @returns {{ok:boolean, source:'env'|'file'|null, reason:string|null}}
 */
export function detectCredentials({ env, home, readFile } = {}) {
    // ⚠️ 不用解构默认值来兜:默认值**只**覆盖 undefined。调用方传 null 时
    // `env.DEEPSEEK_API_KEY` / `path.join(home, …)` 会直接 TypeError,
    // 而 path.join 那一句还在下面那道 try **之外** —— 于是"接错线"表现为一个崩溃。
    // 归一化一次,让所有契约外输入都落到同一句中文 reason 上。
    const e = env ?? process.env;

    // ⚠️ **home 缺了绝不回落到 env.DSH_HOME**。本机实测:进程 env 里的 DSH_HOME 是
    // harness 自己的家(那里**有** .credentials.yaml),而 kaiwu 的家没有 ——
    // 回落等于对一个"agent 根本不会用的家"下结论,在这台机器上就是一句**假**的
    // "没凭证",而用户明明配好了。宁可报"接错线":那种错必须被修,不能被一个
    // 看起来合理的 verdict 掩盖过去。
    const h = typeof home === 'string' ? home.trim() : '';
    if (h === '') {
        return { ok: false, source: null, reason: wiringReason('home(Agent 实际使用的 DSH_HOME)') };
    }

    const fromEnv = typeof e.DEEPSEEK_API_KEY === 'string' ? e.DEEPSEEK_API_KEY.trim() : '';
    if (fromEnv !== '') {
        return { ok: true, source: 'env', reason: null };
    }

    const file = path.join(h, '.credentials.yaml');

    // 没拿到 readFile 是**调用方接错了线**,不是"用户没配凭证"。
    // 这两种情况必须说得出区别 —— 否则这个模块要防的那个误诊
    // (把"链路全绿却发不出提示"说成"你没配")会从内部原样再演一遍:
    // 用户明明配好了,却被指着去写一个根本没被检查过的文件。
    if (typeof readFile !== 'function') {
        return { ok: false, source: null, reason: wiringReason(`readFile(凭证文件 ${file})`) };
    }

    let text = '';
    try {
        text = String(readFile(file) ?? '');
    } catch {
        text = '';
    }
    // 有内容就当有凭证 —— 具体够不够用由 Agent 自己判断,这里不猜格式。
    if (text.trim() !== '') {
        return { ok: true, source: 'file', reason: null };
    }

    return {
        ok: false,
        source: null,
        reason: '没有找到 DeepSeek 凭证。设环境变量 DEEPSEEK_API_KEY,'
            + `或者把它写进 ${file}`,
    };
}
