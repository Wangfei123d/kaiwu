// ACP 协议常量。单独放一个文件,是为了让"线上的方法名"只有一份:
// acp-client.js 里全是连接状态,不该被谁为了一个字符串常量就整个 import 进去,
// 而常量表单独放着,谁在用、用没用,一眼就能看出来。
// ⚠️ 当前的使用者:electron/agent/acp-client.js(线上方法名)与
// tests/acp-client.test.js(用 METHODS 做"常量表 ↔ 实现"的漂移守卫)。
// 这里以前写着"没有任何测试 import 这个文件" —— 那是错的,已改正。
export const PROTOCOL_VERSION = 1;
export const METHODS = Object.freeze({
    INITIALIZE: 'initialize',
    SESSION_NEW: 'session/new',
    SESSION_PROMPT: 'session/prompt',
    // ⚠️ 这是**通知**,不是请求:ACP 里对端不会为它回响应(见 acp-client 的 notify)。
    // 用它就必须走 notify / transport.send,走 call 会登记一个永远等不到回答的 pending
    // —— 那正是"界面上一个永不停止的转圈"。
    SESSION_CANCEL: 'session/cancel',
    SESSION_UPDATE: 'session/update',
    // 改一条会话配置(模型 / 思考强度)。**标准 ACP 方法**,响应里回整份新的 configOptions
    // (所以界面不必自己拼"改完长什么样");对端还会另外**主动推**一条
    // `sessionUpdate:"config_option_update"` —— 两条路都要收,谁先到都要对。
    SESSION_SET_CONFIG_OPTION: 'session/set_config_option',
    // 列会话(「AI 会话」那栏的数据来源之一)。**标准 ACP 方法**,但能力有限:
    // 只回 `{sessionId, cwd}`,没有标题、没有时间、没有内容 —— 而且**不列正在活跃的会话**
    // (实测:dsh-acp 的 listSessions 会把活跃/子代理/派生会话全部过滤掉)。
    // 所以"能不能接着聊"这件事,活跃那一份必须由 kaiwu 自己记着(见 app/lib/agent-sessions.js)。
    SESSION_LIST: 'session/list',
    // 恢复一条历史会话,把上下文接回来。三条硬约束(实测/读实现):
    // cwd 必须与当初建会话时**同一目录**(realpath 比较)、会话正在活跃 → 拒、子代理会话 → 拒。
    // ⚠️ 它**不重放旧消息**:只回 `{configOptions}` —— 所以"看到的历史"永远来自开物自己的台账,
    //    对端只负责"记性还在不在"(这条限制写在界面上,不许含糊)。
    SESSION_RESUME: 'session/resume',
    REQUEST_PERMISSION: 'session/request_permission',
    // ⚠️ **非标准方法**,kaiwu 与它自己给 dsh-acp 打的补丁之间的私约(不是 ACP 规范):
    // 按需把一段文字(思考原文)请桥用 ctx.llm 翻一次。只有这两端认识它 ——
    // 别的 ACP 客户端不会发、别的 agent 也不会答,所以它不该被当成通用能力。
    TRANSLATE: 'kaiwu/translate',
    // ⚠️ 同样**非标准**(只有 kaiwu 与它自己给 dsh-acp 打的那处补丁认识):
    // "这条连接现在还能不能收内联图片"。ACP 只在 initialize 广告一次能力,而换模型
    // (set_config_option)恰恰会改变它 —— 不重新问一次,客户端就只能一直按旧值拦人
    // (实测:换成视觉模型之后开物仍然拒绝发图)。
    CAPABILITIES: 'kaiwu/capabilities',
});
