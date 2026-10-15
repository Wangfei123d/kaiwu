// 假 ACP agent:一个**真的子进程**,说真的 stdio 协议,但不需要凭证、不联网、不花钱。
//
// 为什么要它:Agent 层最容易出问题的地方是"进程边界"——分帧、请求关联、
// 崩溃重启、流式增量。这些都不该等到"用户配好 DEEPSEEK_API_KEY 才能验"。
// 有了这个夹具,`npm test` 是确定性的,Plan B 的自检也能在没有凭证的机器上
// 断言"发一条提示,界面上出现回复"。
//
// 用法: node tests/fixtures/fake-acp-agent.mjs [--crash-after <n>] [--noisy-stderr]
//                                          [--tool-call] [--permission]
//
//   --tool-call   提示过程中发一条 tool_call + 一条 tool_call_update(M3 的工具卡片)
//   --permission  发一条**反向请求** session/request_permission,并且**等客户端回答**
//                 才收尾(回答的内容会作为最后一条增量回显,便于端到端断言)
//   --echo-prompt 把**收到的那段提示原文**用一条 user_message_chunk 回显出来 ——
//                 于是"界面到底把什么发给了 agent"(比如有没有带上当前笔记的上下文)
//                 能被自检断言,而不是只能相信界面自己画了什么
//   --thought     先推两条 agent_thought_chunk 再推正文 —— 自检据此断言
//                 「思考收成一条可折叠的细条,正文一到就自动收起」(A2)
//   --markdown    正文里带上 Markdown 与一段**不可信的 HTML** —— 自检据此端到端断言
//                 「助手回复被排版成元素,而模型给的标签仍然只是文字」
import { drainLines, encodeMessage } from '../../app/lib/acp-frame.js';

const argv = process.argv.slice(2);
const crashAt = argv.includes('--crash-after')
    ? Number(argv[argv.indexOf('--crash-after') + 1])
    : 0;
const wantToolCall = argv.includes('--tool-call');
const wantPermission = argv.includes('--permission');
const echoPrompt = argv.includes('--echo-prompt');
const wantThought = argv.includes('--thought');
const wantMarkdown = argv.includes('--markdown');
// --question 发一次"提问"(同一个 request_permission,但 toolCall.kind='question'):
// 自检据此断言界面把它画成**提问卡**、而不是授权卡,并且点选项真的回到了 agent。
const wantQuestion = argv.includes('--question');

// 反向请求的 id 用一个**明显的、绝不可能与我们自己发出的请求撞车**的值:
// JSON-RPC 的 id 空间分方向,但夹具只从 1 开始数自己的请求,用一个高位数
// 能让日志里一眼看出这是一条反向请求。
const PERMISSION_REQUEST_ID = 900001;
// 提问用**另一个** id:两个反向请求可能连着发,id 撞了就分不清在等哪一个。
const QUESTION_REQUEST_ID = 900002;

// ---- 会话配置(模型 / 思考强度)----
//
// 形状照**真机**(dsh-acp 的 modelAndReasoningOptions)写:模型那条按 provider 分组、
// value 是**不透明串**;思考强度那条是平表、带英文 name/description。
// 自检据此端到端验那枚胶囊:收起态一个汉字 → 展开滑块 → 点标题进模型清单 → 切一条。
// ⚠️ 夹具**记住**改过的值,并在 set_config_option 时把整份新 configOptions 回过去 ——
//    真桥就是这么回的("改完长什么样"由对端说了算,界面不自己拼)。
const MODEL_VALUES = {
    flash: '["fake-provider","fake-flash"]',
    vision: '["fake-provider","fake-flash-vision"]',
};
// 「AI 会话」:哪些会话在对端那边是**活跃**的(照真机:活跃的不出现在 session/list 里)。
// 夹具一开始就有那条 session/new 建出来的会话。
const activeSessions = new Set(['fake-session-1']);
// ⚠️ 真机的 session/new **每次都回一个新的 uuid**(探针实测);夹具从前永远回 'fake-session-1',
//    于是"新建会话"会与第一条撞成同一条记录 —— 自检里看起来像"没建出来"。
//    这里第一次仍回 'fake-session-1'(既有用例都按它断言),第二次起回递增的新 id。
let sessionSeq = 1;

let currentModel = MODEL_VALUES.flash;
let currentEffort = 'high';
/**
 * 新模型上来时思考强度会被打回的那一档。
 *
 * ⚠️ 这不是夹具脑补的:**真桥实测**就是这么干的 —— 手动把强度设成 `low` 之后再换模型,
 *    回来的是 `high`(新模型的默认值)。夹具必须照做,否则 kaiwu 那条"换模型之后把用户
 *    选的那一档补回来"的保证在**端到端**这一层完全测不到:自检里"切完模型收起胶囊仍是
 *    刚切的那一档"会变成**假绿**(即使 pinEffort 被删掉也照样过)。
 */
const MODEL_DEFAULT_EFFORT = 'high';
function configOptions() {
    return [
        {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: currentModel,
            options: [{
                group: 'fake-provider',
                name: '夹具供应商',
                options: [
                    { value: MODEL_VALUES.flash, name: 'Fake-Flash', description: '日常够用的那个' },
                    { value: MODEL_VALUES.vision, name: 'Fake-Flash-Vision', description: '看得见图片的那个' },
                ],
            }],
        },
        {
            id: 'reasoning_effort',
            name: 'Reasoning effort',
            category: 'thought_level',
            type: 'select',
            currentValue: currentEffort,
            options: [
                { value: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
                { value: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
                { value: 'high', name: 'High', description: 'The default balance for most tasks.' },
                { value: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
            ],
        },
    ];
}

// 测日志环形缓冲用:往 stderr 灌 20 行
if (argv.includes('--noisy-stderr')) {
    for (let i = 1; i <= 20; i++) process.stderr.write(`stderr 第 ${i} 行\n`);
}

let buffer = '';
let handled = 0;
// 等客户端回答反向请求的那一次 prompt:id 与"回答到了没"
let pendingPromptId = null;
// 会话 id 也要留下来:响应里**没有** params,靠它取 sessionId 是取不到的
let pendingSessionId = null;
let permissionOutcome = null;
// 反向请求按**队列**发:每个都要等回答。权限卡与提问卡是同一个 ACP 方法
// (session/request_permission),只有 toolCall.kind 不同 —— 于是这里也就共用一套机器。
let pendingStage = null;          // 当前在等哪一个:{ label, id } | null
const pendingAsks = [];           // 还没发的那些

const write = (msg) => process.stdout.write(encodeMessage(msg));

function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

function chunk(sessionId, text) {
    write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
    });
}

function maybeCrash() {
    if (crashAt > 0 && handled >= crashAt) {
        // 等一下让 stdout 冲出去,再"崩溃"
        setTimeout(() => process.exit(3), 20);
    }
}

/** 一次提示的收尾。反向请求那次要等回答,所以单独抽出来。 */
function endPrompt(id, sessionId) {
    reply(id, { stopReason: 'end_turn' });
    maybeCrash();
}

/** 发下一个待答的反向请求;队列空了就收尾。 */
function sendNextAsk(promptId, sessionId) {
    pendingStage = null;
    if (pendingAsks.length === 0) {
        const id = promptId ?? pendingPromptId;
        pendingPromptId = null;
        pendingSessionId = null;
        if (id !== null) endPrompt(id, sessionId);
        return;
    }
    const next = pendingAsks.shift();
    pendingPromptId = promptId;
    pendingSessionId = sessionId;
    pendingStage = { label: next.label, id: next.id };
    write(next.message(sessionId));
}

/** 权限请求:客户端的回答要**恰好**一次,否则我们(和它)都会一直等。 */
function permissionAsk() {
    return {
        label: '权限结果',
        id: PERMISSION_REQUEST_ID,
        message: (sessionId) => ({
            jsonrpc: '2.0',
            id: PERMISSION_REQUEST_ID,
            method: 'session/request_permission',
            params: {
                sessionId,
                toolCall: { toolCallId: 'call-1', title: '运行命令:git status', kind: 'execute' },
                options: [
                    { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
                    { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
                ],
            },
        }),
    };
}

/**
 * 提问:同一个 ACP 方法,但 toolCall.kind 是 'question' ——
 * 那是桥给 kaiwu 的暗号(ACP 没有"问用户"这一条),界面据此画**提问卡**。
 * 选项上那个 description 是桥给的非标准字段,界面画成选项下面那行小字。
 */
function questionAsk() {
    return {
        label: '提问结果',
        id: QUESTION_REQUEST_ID,
        message: (sessionId) => ({
            jsonrpc: '2.0',
            id: QUESTION_REQUEST_ID,
            method: 'session/request_permission',
            params: {
                sessionId,
                toolCall: { toolCallId: 'ask-1', title: '实现方式:选 A 还是选 B?', kind: 'question' },
                options: [
                    { optionId: 'q0', name: 'A:共用解析', kind: 'allow_once', description: '零重复' },
                    { optionId: 'q1', name: 'B:另写一份', kind: 'allow_once', description: '维护两份' },
                ],
            },
        }),
    };
}

function handle(msg) {
    // 0) 反向请求的**响应**:没有 method,id 是我们发出去的那个。
    //    以前这里会掉进 else 分支回一条 -32601,把"对端不会发响应"当成了事实。
    if (msg.method === undefined) {
        if (pendingStage !== null && msg.id === pendingStage.id) {
            // ACP 的 request_permission 响应形状:{ outcome: { outcome: 'selected', optionId } }
            const picked = msg.result?.outcome?.optionId
                ?? msg.result?.optionId
                ?? (msg.result?.outcome?.outcome ?? 'unknown');
            // ⚠️ 回答**当场**回显成一条增量,不要攒到最后一起发:自检是"点完就断言
            // 那一句话出现了",攒着发会让它在结算前一直等不到(实测踩过)。
            chunk(pendingSessionId ?? 'fake-session-1', `${pendingStage.label}:${picked}`);
            sendNextAsk(pendingPromptId, pendingSessionId ?? 'fake-session-1');
        }
        return;
    }

    handled += 1;
    const { id, method } = msg;
    const sessionId = msg.params?.sessionId ?? 'fake-session-1';

    if (method === 'initialize') {
        reply(id, {
            protocolVersion: 1,
            agentInfo: { name: 'fake-acp', version: '0.0.1' },
            agentCapabilities: { promptCapabilities: { image: true, audio: false, embeddedContext: false } },
        });
    } else if (method === 'session/new') {
        sessionSeq += 1;
        const fresh = sessionSeq === 2 ? 'fake-session-1' : `fake-session-${sessionSeq}`;
        activeSessions.add(fresh);
        reply(id, { sessionId: fresh, configOptions: configOptions() });
    } else if (method === 'session/list') {
        // 列会话。⚠️ **照真机**:不列正在活跃的会话(活跃那一份由客户端自己记着,
        // 见 app/lib/agent-sessions.js 的说明)。这里给三条固定的"历史会话"。
        const all = ['fake-history-1', 'fake-session-1', 'fake-gone-1'];
        reply(id, {
            sessions: all.filter((s) => !activeSessions.has(s))
                .map((s) => ({ sessionId: s, cwd: String(msg.params?.cwd ?? '') })),
        });
    } else if (method === 'session/resume') {
        // 恢复一条历史会话。照真机的三条约束:已活跃 → 拒;恢复不了的 → 拒;
        // 认得的那条 → 把它变成活跃的。
        const sid = String(msg.params?.sessionId ?? '');
        if (activeSessions.has(sid)) { fail(id, -32602, `session is already active: ${sid}`); return; }
        if (sid !== 'fake-history-1') { fail(id, -32602, `session is not resumable: ${sid}`); return; }
        activeSessions.add(sid);
        reply(id, { configOptions: configOptions() });
    } else if (method === 'session/set_config_option') {
        // 改一条会话配置(模型 / 思考强度)。**照真桥的契约**回整份新的 configOptions ——
        // 自检据此端到端验:界面点一下 → 请求真的到了这一侧 → 胶囊上的字跟着变。
        const configId = String(msg.params?.configId ?? '');
        const value = String(msg.params?.value ?? '');
        if (configId === 'model') {
            currentModel = value;
            // 照真机:换模型会把强度打回新模型的默认值(见 MODEL_DEFAULT_EFFORT)。
            currentEffort = MODEL_DEFAULT_EFFORT;
        } else if (configId === 'reasoning_effort') currentEffort = value;
        else { fail(id, -32602, `不认识的 configId:${configId}`); return; }
        reply(id, { configOptions: configOptions() });
    } else if (method === 'kaiwu/capabilities') {
        // kaiwu 私约问法(真桥那边由 kaiwu 自己的补丁提供):**按当前被切到的模型**如实回答 ——
        // 这样自检能端到端验「换成视觉模型之后能力跟着变」这条链。
        reply(id, { image: currentModel === MODEL_VALUES.vision });
    } else if (method === 'session/prompt') {
        // 把收到的提示原文回显一条(**可选**)—— 自检据此断言"界面真的把笔记上下文发出去了"
        if (echoPrompt) {
            // 图片块没有 text 字段,所以逐块投影成一行可读的字:
            // `[图片 image/png 1234 字符 base64]`。自检据此断言"图片真的走到了线上,
            // 而且是规范化 base64 的一整块"(光看界面上的 chip 证明不了这件事)。
            const text = msg.params?.prompt?.map((p) => {
                if (p?.type === 'image') {
                    return `[图片 ${String(p.mimeType)} ${String(p.data ?? '').length} 字符 base64]`;
                }
                return p?.text ?? '';
            }).join('') ?? '';
            write({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                    sessionId,
                    update: {
                        sessionUpdate: 'user_message_chunk',
                        content: { type: 'text', text },
                    },
                },
            });
        }
        // 思考:两条增量(界面要**拼成一条**折叠块,不是两条)
        if (wantThought) {
            for (const text of ['先看它是不是只读跑的……', '是,所以它写不了盘。']) {
                write({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                        sessionId,
                        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
                    },
                });
            }
        }
        // ⚠️ 思考与它后面那些东西之间**故意留一段静默**(400ms):真实的推理模型想几秒
        //    才开口/才动手,而自检要验的「思考耗时」量的正是这一段。不留它,思考与正文
        //    在同一批事件里到达 —— 耗时永远是 0.0 秒,断言就只能验一个格式。
        //    ⚠️ 静默必须挡在**工具卡之前**:工具调用一到,状态侧就把还在飞的思考收尾了
        //    (见 agent-stream.js:一次新的工具调用 = 一个步骤边界),挡在工具卡之后就等于
        //    没挡 —— 实测就是这样跑出 "0.0 秒" 的。
        const afterThoughts = () => {
            // 工具卡片:先建后更新 —— 两者必须是**同一条**卡片(按 toolCallId 关联)
            if (wantToolCall) {
                write({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                        sessionId,
                        update: {
                            sessionUpdate: 'tool_call',
                            toolCallId: 'call-1',
                            title: 'read 甲篇.md',
                            kind: 'read',
                            status: 'pending',
                            rawInput: { file_path: '甲篇.md' },
                        },
                    },
                });
                write({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                        sessionId,
                        update: {
                            sessionUpdate: 'tool_call_update',
                            toolCallId: 'call-1',
                            status: 'completed',
                        },
                    },
                });
            }
            // 再流三条增量 —— 顺序很重要:响应必须在通知之后
            for (let i = 0; i < 3; i++) chunk(sessionId, `回复${i}`);

            // Markdown:一段真语法 + 一段**不可信的 HTML**。自检据此端到端断言两件事:
            // 助手的回复被排版成了元素;而模型给的标签仍然只是文字(不许落地成元素)。
            if (wantMarkdown) {
                chunk(sessionId, '\n\n**加粗**与`行内码`');
                chunk(sessionId, '\n\n<img src=x onerror="alert(1)">');
            }

            // 反向请求:客户端必须**恰好**回答一次,否则我们(和它)都会一直等。
            // 两个都要时**依次**发:先权限卡,再提问卡 —— 自检因此能把两种卡片都验一遍。
            pendingAsks.length = 0;
            if (wantPermission) pendingAsks.push(permissionAsk());
            if (wantQuestion) pendingAsks.push(questionAsk());
            if (pendingAsks.length > 0) {
                sendNextAsk(id, sessionId);
                return;   // 等一下再说 —— 收尾在最后一个响应到达时
            }

            endPrompt(id, sessionId);
        };
        if (wantThought) setTimeout(afterThoughts, 400);
        else afterThoughts();
    } else if (method === 'kaiwu/translate') {
        // kaiwu 与它自己给 dsh-acp 打的补丁之间的**非标准**方法:按需翻译思考原文。
        // 夹具回一个能一眼认出来的假译文 —— 自检据此断言"点「译」之后界面真的换成了译文"。
        // (真桥那一边用 ctx.llm 真翻,这里只验链路:请求到了、结果回来了、界面更新了。)
        reply(id, { text: `【译】${String(msg.params?.text ?? '').slice(0, 12)}` });
    } else {
        fail(id, -32601, `不认识的方法:${method}`);
    }

    maybeCrash();
}


process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const { lines, rest } = drainLines(buffer);
    buffer = rest;
    for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        handle(msg);
    }
});
