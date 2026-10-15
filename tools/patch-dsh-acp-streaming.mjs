#!/usr/bin/env node
// kaiwu 侧的一次性补丁:让 dsh 的 ACP 桥把 harness 的**实时帧**转成 ACP 增量,
// 并把模型的"问用户"接到 ACP 的权限请求上。
//
// 为什么需要它(DSH 0.9.0 / dsh-acp 0.1.5-rc.2,本机实测):
//   一、流式。桥只有一条输出路径 —— 把**已提交的耐久事件**投影成 ACP 更新。于是:
//     · 正文与思考要等 `assistant/message` **提交**之后才整块到达(实测一段生成了
//       3 秒的正文只有 1 条、跨 0ms)—— 应用里看到的就是"顿一下,然后整段蹦出来";
//     · 工具卡片来自 `tool/call` 耐久事件,而它是在**整条 assistant 消息提交之后**
//       才追加的 —— 模型只要先写一段正文再调工具,卡片就得等那段正文写完才现身。
//   harness 本身是**实时**的:`agent/assistant-stream` 的帧逐条带增量
//   (text-delta / reasoning-delta / tool-call-delta,dsh-headless 消费的是同一路),
//   桥没接这一路;它的 inject 里没有扩展点、Config 里也没有开关,所以只能在桥内部接。
//
//   二、问用户。DSH 的 ask_user_question 在 `user-questions/request` 瀑布上等一个
//   回答者,而 ACP 没有"问用户"这个方法 —— 能借的只有 session/request_permission。
//   桥没接这一路,于是模型即便有这个工具也没人能回答它。
//
// 补丁做八件事(都尽量小):
//   1) AcpSession 上记三个字段:已流出的正文 / 已流出的思考 / 已实时宣告过的工具 id
//   2) 接 agent/assistant-stream,按 chunk 类型分三路发 ACP 增量
//   3) 工具调用的**第一个** delta 就把卡片建出来(不再等整条消息提交)
//   4) 正文与思考提交时,扣掉已经流出去的那些块(对不上就照发,宁可重复不许丢字)
//   5) 已实时宣告过的工具,耐久 tool/call 降级成一次 tool_call_update(不把卡片打回 in_progress)
//   6) 工具结果到达时把该 id 从实时记录里收起
//   7) 当 `user-questions/request` 的回答者:把单选带选项的提问映射成一次
//      session/request_permission(多选/无选项**不硬凑**,交给下一个回答者)
//   8) 提供非标准的 `kaiwu/translate`:按需用 ctx.llm 把一段文字译成中文
//      (思考条上的「译」,一次补全,不新增进程、不占当前那一轮)
//
// 用法:
//   node tools/patch-dsh-acp-streaming.mjs            打补丁(已打过则只报告)
//   node tools/patch-dsh-acp-streaming.mjs --check     只看状态,不写盘
//   node tools/patch-dsh-acp-streaming.mjs --revert    从 .kaiwu-orig 还原
//   node tools/patch-dsh-acp-streaming.mjs --target <index.js 路径>
//
// ⚠️ DSH 升级会覆盖这个文件 —— 升级后重跑本脚本即可。锚点对不上时它**拒绝写盘**,
//    并把对不上的那一条打出来,绝不会改出一个半截的桥。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDshEntry } from '../app/lib/agent-command.js';

const T = '\t';
const N = '\n';
const MARK = 'kaiwu: 实时流式';
// 图片能力那条:非标准方法名(与 kaiwu/translate 同一条约定,别的客户端不认识也不会发)。
const CAPABILITIES_METHOD = 'kaiwu/capabilities';
// 旧版补丁只接了正文,标记也不一样。留着它是为了认出"该升级",而不是当成没打过。
const LEGACY_MARK = 'kaiwu: 流式正文';

function defaultTarget() {
    const entry = resolveDshEntry({ env: process.env, exists: fs.existsSync });
    if (entry === null) throw new Error('找不到 dsh 的 bin.js(可用 DSH_CLI_ENTRY 或 --target 指定)');
    // <appRoot>/node_modules/@deepseek-ai/dsh/lib/bin.js → 同级的 dsh-acp
    return path.join(path.dirname(entry), '..', '..', 'dsh-acp', 'lib', 'index.js');
}

const FIELD_ANCHOR = 'outputTail = Promise.resolve();';
const FIELD_REPL = FIELD_ANCHOR + N
    + T + '/** ' + MARK + ':本会话已经**流出去**的正文,提交时用来扣掉,避免整段重发。 */' + N
    + T + 'liveText = "";' + N
    + T + '/** ' + MARK + ':思考同理 —— 思考也走实时帧,提交时同样会整段再来一遍。 */' + N
    + T + 'liveThoughts = "";' + N
    + T + '/** ' + MARK + ':已经**实时宣告过**的工具调用 id(耐久事件到了就不再建卡,改成更新)。 */' + N
    + T + 'liveToolCalls = new Set();';

const DOC_ANCHOR = T + '/**' + N + T + '* Process one durable event';
const METHOD = [
    T + '/**',
    T + '* ' + MARK + ':把 harness 的实时帧转成 ACP 增量。',
    T + '*',
    T + '* 没有这一段时,桥只在耐久事件**提交**之后才投递:正文与思考要等整段写完才到达,',
    T + '* 工具卡片要等整条 assistant 消息提交才出现 —— 一轮里什么都等最后一起蹦出来。',
    T + '* harness 的 agent/assistant-stream 帧本来就带逐字增量,这里按 chunk 类型分三路发:',
    T + '*',
    T + '*   text-delta      → agent_message_chunk',
    T + '*   reasoning-delta → agent_thought_chunk',
    T + '*   tool-call-delta → tool_call(首个带 name 的 delta 就建卡,不再等提交)',
    T + '*/',
    T + 'onAssistantStream(frame) {',
    T + T + 'const chunk = frame?.chunk;',
    T + T + 'if (chunk === void 0) return;',
    T + T + 'if (chunk.type === "text-delta") {',
    T + T + T + 'const text = typeof chunk.text === "string" ? chunk.text : "";',
    T + T + T + 'if (text === "") return;',
    T + T + T + 'this.liveText += text;',
    T + T + T + 'this.enqueueUpdate({',
    T + T + T + T + 'sessionUpdate: "agent_message_chunk",',
    T + T + T + T + 'content: { type: "text", text }',
    T + T + T + '});',
    T + T + T + 'return;',
    T + T + '}',
    T + T + 'if (chunk.type === "reasoning-delta") {',
    T + T + T + 'const text = typeof chunk.text === "string" ? chunk.text : "";',
    T + T + T + 'if (text === "") return;',
    T + T + T + 'this.liveThoughts += text;',
    T + T + T + 'this.enqueueUpdate({',
    T + T + T + T + 'sessionUpdate: "agent_thought_chunk",',
    T + T + T + T + 'content: { type: "text", text }',
    T + T + T + '});',
    T + T + T + 'return;',
    T + T + '}',
    T + T + 'if (chunk.type === "tool-call-delta") this.onToolCallDelta(chunk);',
    T + '}',
    T + '/** ' + MARK + ':按到达顺序排队发一条增量(与提交路径共用 outputTail,两条路不交叉)。 */',
    T + 'enqueueUpdate(update) {',
    T + T + 'const sessionId = this.agent.session.id;',
    T + T + 'const previous = this.outputTail;',
    T + T + 'this.outputTail = previous.then(() => this.notify({',
    T + T + T + 'sessionId,',
    T + T + T + 'update',
    T + T + '})).catch(() => {});',
    T + '}',
    T + '/**',
    T + '* ' + MARK + ':工具调用的**第一个** delta 就把卡片建出来。',
    T + '*',
    T + '* 为什么等到 id 与 name 都非空才宣告:ACP 的卡片靠 toolCallId 更新,空 id 建出来的',
    T + '* 卡谁也改不了;标题来自 name,只拿 id 建卡会先出现一张没名字的卡。两者只要有一条',
    T + '* 始终没来就不宣告 —— 耐久事件 tool/call 会照旧建卡(集合里没这个 id),不会丢卡。',
    T + '*/',
    T + 'onToolCallDelta(chunk) {',
    T + T + 'const id = typeof chunk.id === "string" ? chunk.id : "";',
    T + T + 'const name = typeof chunk.name === "string" ? chunk.name : "";',
    T + T + 'if (id === "" || name === "") return;',
    T + T + 'if (this.liveToolCalls.has(id)) return;',
    T + T + 'this.liveToolCalls.add(id);',
    T + T + 'this.enqueueUpdate({',
    T + T + T + 'sessionUpdate: "tool_call",',
    T + T + T + 'toolCallId: id,',
    T + T + T + 'title: name,',
    T + T + T + 'kind: "other",',
    T + T + T + 'status: "in_progress"',
    T + T + '});',
    T + '}',
    T + '/** ' + MARK + ':提交消息里已经流过的正文与思考不要再发一遍(对不上就照发,宁可重复不许丢字)。 */',
    T + 'dropStreamed(updates) {',
    T + T + 'const liveText = this.liveText;',
    T + T + 'const liveThoughts = this.liveThoughts;',
    T + T + 'this.liveText = "";',
    T + T + 'this.liveThoughts = "";',
    T + T + 'if (liveText === "" && liveThoughts === "") return updates;',
    T + T + 'let textCursor = 0;',
    T + T + 'let thoughtCursor = 0;',
    T + T + 'return updates.filter((update) => {',
    T + T + T + 'const kind = update.sessionUpdate;',
    T + T + T + 'if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return true;',
    T + T + T + 'const text = update.content?.text;',
    T + T + T + 'if (typeof text !== "string") return true;',
    T + T + T + 'const isText = kind === "agent_message_chunk";',
    T + T + T + 'const live = isText ? liveText : liveThoughts;',
    T + T + T + 'const cursor = isText ? textCursor : thoughtCursor;',
    T + T + T + 'if (live.slice(cursor, cursor + text.length) !== text) return true;',
    T + T + T + 'if (isText) textCursor += text.length;',
    T + T + T + 'else thoughtCursor += text.length;',
    T + T + T + 'return false;',
    T + T + '});',
    T + '}',
    T + '/**',
    T + '* ' + MARK + ':这张卡已经实时宣告过了,耐久 tool/call 就降级成一次更新。',
    T + '*',
    T + '* 照发一条新的 tool_call 的代价:同一个 toolCallId 会把卡片打回 in_progress ——',
    T + '* 那时工具可能已经跑完了。**不带 status** 是有意的:以当前状态为准。',
    T + '*/',
    T + 'liveToolCallUpdate(event) {',
    T + T + 'const update = toolCallUpdate(event);',
    T + T + 'if (!this.liveToolCalls.has(update.toolCallId)) return update;',
    T + T + 'delete update.status;',
    T + T + 'update.sessionUpdate = "tool_call_update";',
    T + T + 'return update;',
    T + '}',
    T + '/** ' + MARK + ':结果到了,这张卡不用再记着(集合不随会话无限长大)。 */',
    T + 'finishLiveToolCall(update) {',
    T + T + 'this.liveToolCalls.delete(update.toolCallId);',
    T + T + 'return update;',
    T + '}',
    '',
].join(N);

const CALL_ANCHOR = 'for (const update of await assistantUpdates(this.ctx, session, event)) await this.notify({';
const CALL_REPL = 'for (const update of this.dropStreamed(await assistantUpdates(this.ctx, session, event))) await this.notify({';

const LISTEN_ANCHOR = T + 'ctx.on("session/event", (session, event) => {';
const LISTEN_INSERT = [
    T + 'ctx.on("agent/assistant-stream", ({ agent, frame }) => { // ' + MARK,
    T + T + 'ownedRecord(agent)?.onAssistantStream(frame);',
    T + '});',
    '',
].join(N);

// 工具那两处:耐久事件到达时,把"已经实时宣告过"的那张卡降级成更新、并在结果到达时收尾。
// 锚点各只是整行里的一小段 —— 与上面四处同样的纪律(尽量小、要求恰好命中一次)。
const TOOLCALL_ANCHOR = 'update: toolCallUpdate(event)';
const TOOLCALL_REPL = 'update: this.liveToolCallUpdate(event)';
const TOOLRESULT_ANCHOR = 'update: await toolResultUpdate(this.ctx, event)';
const TOOLRESULT_REPL = 'update: this.finishLiveToolCall(await toolResultUpdate(this.ctx, event))';

// 第七处:当 `user-questions/request` 的回答者。插在现成的 approval/request 回答者**之前**
// (两者是同一类东西:都是"瀑布上由桥来回答",放在一起便于对照)。
const ANSWER_ANCHOR = T + 'ctx.on("approval/request", (request, next) => {';
const ANSWER_INSERT = [
    T + '// ' + MARK + ':把模型的"问用户"接到 ACP 上。',
    T + '//',
    T + '// DSH 的 ask_user_question 在 user-questions/request 瀑布上等一个回答者,而 ACP 没有',
    T + '// "问用户"这个方法 —— 能借的只有 session/request_permission(单选、一次一题、回不了文字)。',
    T + '// 所以这里是一条**有意受限**的映射:',
    T + '//',
    T + '//   单选 + 有选项   → 一次 request_permission,选项就是按钮(答案按 label 回给模型)',
    T + '//   一次问多题      → **串行**:答完一题再发下一题(ACP 一次只回一个选项)',
    T + '//   多选 / 没选项   → **不硬凑**,交给下一个回答者(最终 NO_PROVIDER),模型改用正文问',
    T + '//   用户关掉 / 超时 → cancelled → 以 ASK_ABORTED 收场(与"用户没答"同义)',
    T + '//',
    T + '// ⚠️ 为什么"不硬凑":把多选降级成单选、或替用户编一个文字答案,都是**假答案** ——',
    T + '// 模型会拿它当用户的选择继续往下做。宁可让它收到错误、改用正文问。',
    T + 'ctx.on("user-questions/request", (request, next) => {',
    T + T + 'const record = ownedRecord(request.agent);',
    T + T + 'if (record === void 0) return next();',
    T + T + 'const questions = Array.isArray(request.questions) ? request.questions : [];',
    T + T + 'const mappable = questions.length > 0 && questions.every((question) => question !== null',
    T + T + T + '&& typeof question === "object" && Array.isArray(question.options)',
    T + T + T + '&& question.options.length > 0 && question.multiSelect !== true);',
    T + T + 'if (!mappable) return next();',
    T + T + 'return (async () => {',
    T + T + T + 'const answers = [];',
    T + T + T + 'for (const question of questions) {',
    T + T + T + T + 'await record.drainUpdates();',
    T + T + T + T + 'const options = question.options.map((option, index) => ({',
    T + T + T + T + T + 'optionId: "q" + index,',
    T + T + T + T + T + 'name: String(option?.label ?? ""),',
    T + T + T + T + T + 'kind: "allow_once",',
    T + T + T + T + T + '// 非标准字段:ACP 的选项没有"说明"这一栏,而提问里的 description 正是',
    T + T + T + T + T + '// 取舍说明。kaiwu 把它读出来画成选项下面那行小字;别的客户端忽略它。',
    T + T + T + T + T + 'description: typeof option?.description === "string" ? option.description : ""',
    T + T + T + T + '}));',
    T + T + T + T + 'const header = typeof question.header === "string" ? question.header : "";',
    T + T + T + T + 'const title = header === "" ? String(question.question ?? "") : header + ":" + String(question.question ?? "");',
    T + T + T + T + 'const { outcome } = await conn.request(methods.client.session.requestPermission, {',
    T + T + T + T + T + 'sessionId: record.agent.session.id,',
    T + T + T + T + T + '// kind: "question" 是给 kaiwu 看的暗号:同样是 request_permission,',
    T + T + T + T + T + '// 但界面上要画成"提问卡"而不是"授权卡"。别的客户端会忽略这个值。',
    T + T + T + T + T + 'toolCall: { toolCallId: "ask:" + String(question.id), title, kind: "question" },',
    T + T + T + T + T + 'options',
    T + T + T + T + '});',
    T + T + T + T + 'const picked = options.findIndex((option) => option.optionId === outcome?.optionId);',
    T + T + T + T + 'if (outcome?.outcome !== "selected" || picked === -1) {',
    T + T + T + T + T + 'const aborted = new Error("ask_user_question was aborted before the user answered");',
    T + T + T + T + T + 'aborted.name = "UserQuestionError";',
    T + T + T + T + T + 'aborted.code = "ASK_ABORTED";',
    T + T + T + T + T + 'throw aborted;',
    T + T + T + T + '}',
    T + T + T + T + 'answers.push({ id: question.id, selected: [String(question.options[picked].label ?? "")] });',
    T + T + T + '}',
    T + T + T + 'return { answers };',
    T + T + '})();',
    T + '});',
    '',
].join(N);

/**
 * kaiwu: 按需翻译用的方法名。
 *
 * ⚠️ 它**不是** ACP 规范里的东西 —— 是 kaiwu 与它自己这个补丁之间的私约。
 * 别的 ACP 客户端不会发、别的 agent 也不会答,所以别把它当通用能力。
 */
const TRANSLATE_METHOD = 'kaiwu/translate';

// 第八处要插的函数:一次性翻译。**必须插在模块级**(类的外面,见 FN_ANCHOR 的说明)。
// 它只用桥本来就 import 了的 createUserMessage 与 ctx.llm —— 不新增任何依赖。
const TRANSLATE_FN = [
    T + '/**',
    T + '* ' + MARK + ':把一段文字译成中文(思考条上的「译」)。',
    T + '*',
    T + '* 用 ctx.llm 直接补全一次:不新增进程、不动会话历史,也**不占当前那一轮** ——',
    T + '* 用户在看答案的同时点一下翻译,不该把进行中的提示搅乱。',
    T + '*',
    T + '* 失败一律抛给调用方(kaiwu 会在那条思考上显示「重译」),但**真实原因先写进日志**:',
    T + '* 上面那层 SDK 会把任何异常折成一句 "Internal error",不留日志就等于什么都查不到',
    T + '*(这条是实测踩出来的:第一次跑只看到 -32603,直到加上这行才知道是哪一步炸的)。',
    T + '*/',
    T + 'async function translateThought(ctx, config, params, signal) {',
    T + T + 'const text = typeof params?.text === "string" ? params.text : "";',
    T + T + 'if (text.trim() === "") return { text: "" };',
    T + T + 'try {',
    T + T + T + 'const messages = [createUserMessage({',
    T + T + T + T + 'content: [{ type: "text", text }],',
    T + T + T + T + 'source: { kind: "plugin", plugin: "kaiwu-translate" }',
    T + T + T + '})];',
    T + T + T + 'const options = {',
    T + T + T + T + 'provider: config.provider,',
    T + T + T + T + 'model: config.model,',
    T + T + T + T + 'messages,',
    T + T + T + T + 'system: "把用户发来的文字翻译成简体中文。只输出译文本身:不要解释、不要加引号、不要重复原文。已经是中文就原样返回。代码、命令、路径、报错信息保持原样不译。",',
    T + T + T + T + 'maxTokens: 2048,',
    T + T + T + T + '...(typeof params?.sessionId === "string" && params.sessionId !== "" ? { sessionId: params.sessionId } : {}),',
    T + T + T + T + '...(signal === void 0 ? {} : { signal })',
    T + T + T + '};',
    T + T + T + 'let out = "";',
    T + T + T + 'let kinds = "";',
    T + T + T + 'let finish = null;',
    T + T + T + 'for await (const chunk of ctx.llm.stream(options)) {',
    T + T + T + T + 'const type = typeof chunk?.type === "string" ? chunk.type : "?";',
    T + T + T + T + 'kinds += type + " ";',
    T + T + T + T + 'if (type === "text-delta" && typeof chunk.text === "string") out += chunk.text;',
    T + T + T + T + 'if (type === "finish") finish = chunk;',
    T + T + T + '}',
    T + T + T + 'if (out.trim() === "") {',
    T + T + T + T + '// ⚠️ 空结果**不能静默**:chunk 流正常结束但一个字都没有,通常是模型那一侧',
    T + T + T + T + '// 在 finish 里报了错(或这条路由根本不通)。把原样的事实打出来,别让上层只看到',
    T + T + T + T + '// 一句"翻译结果为空"。(实测踩过:只有这行才看得出是哪一步。)',
    T + T + T + T + 'console.error("kaiwu: translate produced no text; chunks=[" + kinds.trim()',
    T + T + T + T + T + '+ "] finish=" + JSON.stringify(finish));',
    T + T + T + '}',
    T + T + T + 'return { text: out.trim() };',
    T + T + '} catch (error) {',
    T + T + T + 'const detail = "kaiwu: translate failed: " + String(error?.stack ?? error);',
    T + T + T + '// 两条都写:ctx.logger 是应用侧的日志口(可能不存在),console.error 一定到 stderr',
    T + T + T + '// —— 排查这一步时只有后者靠得住(第一次 ctx.logger 是 undefined,日志压根没出来)。',
    T + T + T + 'try { ctx.logger?.warn?.(detail); } catch (_ignored) { /* 只是日志 */ }',
    T + T + T + 'console.error(detail);',
    T + T + T + 'throw error;',
    T + T + '}',
    T + '}',
    '',
].join(N);

// 第八处:把 kaiwu/translate 挂到连接上。锚点是那条链子的尾巴(它同时是
// ".connect(stream)" 之前唯一一处 onNotification(session/cancel))。
//
// ⚠️ 自定义方法**必须**给一个 params 解析器,而且要把它**直接当第二个参数**传:
// SDK 是 onRequest(method, handlerOrParams, handler),三参时 `handlerOrParams` **整体**
// 就是 spec.params,内部再走 parseParams:函数就调用它,否则调 `parser.parse(params)`。
// 写成 `{ params: fn }` 会变成 spec.params = {params: fn} → "parser.parse is not a function",
// 而且那个 TypeError 发生在**解析阶段**(handler 还没进去),于是 -32603 之外什么都没有 ——
// 连我们自己的日志都打不出来(实测踩了两轮才定位到)。
const CONNECT_ANCHOR = '.onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params)).connect(stream);';
const CONNECT_REPL = '.onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))'
    + N + T + '.onRequest("' + TRANSLATE_METHOD + '", (raw) => (raw !== null && typeof raw === "object" ? raw : {}), ({ params, signal }) => translateThought(ctx, config, params, signal))'
    // 第十处:kaiwu/capabilities —— "这条连接现在还能不能收图片"。
    // 为什么需要它:ACP 只在 initialize 里广告一次 promptCapabilities,之后**没有任何**
    // "能力变了"的通知。而换模型(set_config_option)恰恰会改变图片能力 —— 客户端不重新问一次,
    // 就只能一直按旧值拦(实测:换成视觉模型之后,开物仍然拒绝发图)。
    // 非标准方法,只有这两端认识(与 kaiwu/translate 同一条约定)。
    + N + T + '.onRequest("' + CAPABILITIES_METHOD + '", (raw) => (raw !== null && typeof raw === "object" ? raw : {}), async ({ params }) => {'
    + N + T + T + '// ⚠️ 按**会话当前的模型**算,不能按 profile 里的 config:换模型改的是会话的'
    + N + T + T + '//    modelControl.selected,而 config.model 一直是最初那个(第一版就栽在这儿,'
    + N + T + T + '//    探针实测:换到视觉模型之后问能力,回的仍是 false)。'
    + N + T + T + '// ⚠️ 就地取(不能用模块级辅助函数:requireSession 定义在**插件作用域**里,'
    + N + T + T + '//    模块级函数看不见它 —— 第一版就栽在这儿,每次都静默走了兜底)。'
    + N + T + T + 'let route = { provider: config.provider, model: config.model };'
    + N + T + T + 'try {'
    + N + T + T + T + 'const picked = requireSession(brandString(params?.sessionId))?.modelControl?.selected;'
    + N + T + T + T + 'if (picked !== void 0) route = picked;'
    + N + T + T + '} catch (error) { /* 会话不在(刚被关掉之类)就退回 profile 的配置 */ }'
    + N + T + T + 'return { image: await refreshImagePromptEnabled(ctx, route.provider, route.model) };'
    + N + T + '})'
    + N + T + '.connect(stream);';

// 第八处要插的函数:**必须插在模块级**(类的外面)。第一版插在 DOC_ANCHOR 那条缝上,
// 而那条缝在 class 体内 —— `async function …` 放进去是语法错误(node --check 直接报
// Unexpected identifier)。这里改用 AcpSession 类声明**之前**那一行,恰好在模块级。
const FN_ANCHOR = 'var AcpSession = class AcpSession {';

// ---- 第十处:图片能力要**现算**,不能吃 initialize 那一次的旧值 ----
//
// 病根(实测):桥在 initialize 里算一次 `imagePromptEnabled`,之后整条连接都用它 ——
//   而 `set_config_option` 换模型**不会**重算。于是"换成视觉模型"这一步在客户端看来成功了,
//   发图却仍然被 -32602 拒(用户原话:"还是无法识图")。
// 修法:提问那一刻现算一次(判据与 initialize **完全同一个函数**,不引入第二套口径);
//   另外给客户端一个 kaiwu/capabilities 问法,让它别拿旧值继续拦人。
const PROMPT_ANCHOR = [
    T + T + 'async prompt(params, requestSignal) {',
    T + T + T + 'assertOpen();',
    T + T + T + 'return requireSession(brandString(params.sessionId)).prompt(params, imagePromptEnabled, requestSignal);',
    T + T + '},',
].join(N);
const PROMPT_REPL = [
    T + T + 'async prompt(params, requestSignal) {',
    T + T + T + 'assertOpen();',
    T + T + T + 'const record = requireSession(brandString(params.sessionId));',
    T + T + T + '// ' + MARK + ':图片能力**每次提问现算**(模型可能刚被 set_config_option 换过)。',
    T + T + T + '// 缓存已为 true 时不必再问;为 false 时问一次 —— 换成视觉模型之后就通了。',
    T + T + T + '// ⚠️ 路由必须从**会话**里取(record.modelControl.selected):换模型改的是它,',
    T + T + T + '//    而 profile 的 config.model 一直是最初那个。',
    T + T + T + 'if (imagePromptEnabled !== true) {',
    T + T + T + T + 'const picked = record.modelControl?.selected;',
    T + T + T + T + 'const route = picked === void 0 ? { provider: config.provider, model: config.model } : picked;',
    T + T + T + T + 'imagePromptEnabled = await refreshImagePromptEnabled(ctx, route.provider, route.model);',
    T + T + T + '}',
    T + T + T + 'return record.prompt(params, imagePromptEnabled, requestSignal);',
    T + T + '},',
].join(N);

// 能力刷新函数:模块级(类外面),与 translateThought 同一处插。
const CAPFN_ANCHOR = 'var AcpSession = class AcpSession {';
const CAPFN = [
    '/**',
    '* ' + MARK + ':现算"这条连接能不能收内联图片"。',
    '*',
    '* 判据与 initialize 里那一次**完全同一个函数**(supportsAcpImagePrompts),所以不存在',
    '* "两套口径"的风险;差别只在于**什么时候问**:从"握手时问一次"改成"提问时也问一次"。',
    '* 模型路由解析不出来时它自己会回 false(那个函数内部 catch),不会把提问带崩。',
    '*/',
    '',
    'async function refreshImagePromptEnabled(ctx, provider, model) {',
    T + 'try {',
    T + T + 'return await supportsAcpImagePrompts(ctx, provider, model);',
    T + '} catch (error) {',
    T + T + '// 问不出来就当"不能" —— 与 initialize 的兜底一致(宁可少发图,不可把提示带崩)',
    T + T + 'console.error("kaiwu: capability probe failed: " + String(error?.stack ?? error));',
    T + T + 'return false;',
    T + '}',
    '}',
    '',
].join(N);

const PARTS = [
    { name: 'AcpSession 字段 liveText / liveThoughts / liveToolCalls', anchor: FIELD_ANCHOR, repl: FIELD_REPL },
    { name: 'onAssistantStream 等六个方法', anchor: DOC_ANCHOR, repl: METHOD + DOC_ANCHOR },
    { name: '翻译函数(模块级,类的外面)', anchor: FN_ANCHOR, repl: TRANSLATE_FN + FN_ANCHOR },
    { name: '提交路径扣掉已流出的正文与思考', anchor: CALL_ANCHOR, repl: CALL_REPL },
    { name: '接上 agent/assistant-stream', anchor: LISTEN_ANCHOR, repl: LISTEN_INSERT + LISTEN_ANCHOR },
    { name: '耐久 tool/call 降级成更新', anchor: TOOLCALL_ANCHOR, repl: TOOLCALL_REPL },
    { name: '工具结果到达时收起实时记录', anchor: TOOLRESULT_ANCHOR, repl: TOOLRESULT_REPL },
    { name: '当 user-questions/request 的回答者', anchor: ANSWER_ANCHOR, repl: ANSWER_INSERT + ANSWER_ANCHOR },
    { name: '挂上 ' + TRANSLATE_METHOD + ' 与 ' + CAPABILITIES_METHOD + ' 处理器', anchor: CONNECT_ANCHOR, repl: CONNECT_REPL },
    { name: 'prompt 现算图片能力(换模型后立刻生效)', anchor: PROMPT_ANCHOR, repl: PROMPT_REPL },
    { name: '能力刷新函数(模块级,类的外面)', anchor: CAPFN_ANCHOR, repl: CAPFN + CAPFN_ANCHOR },
];

// 写完自检用的读数:每一处改动的**证据字符串**,少一条就算失败。
const CHECKS = [
    'onAssistantStream(frame) {',
    'this.onToolCallDelta(chunk);',
    'this.dropStreamed(await assistantUpdates(',
    'ctx.on("agent/assistant-stream"',
    'update: this.liveToolCallUpdate(event)',
    'update: this.finishLiveToolCall(await toolResultUpdate(this.ctx, event))',
    'ctx.on("user-questions/request"',
    'async function translateThought(',
    '.onRequest("kaiwu/translate"',
    // 第十处:换模型之后图片能不能用
    '.onRequest("kaiwu/capabilities"',
    'async function refreshImagePromptEnabled(',
    'const picked = record.modelControl?.selected;',
];

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const target = value('--target') ?? defaultTarget();
const backup = target + '.kaiwu-orig';

if (!fs.existsSync(target)) {
    console.error('目标文件不存在:' + target);
    process.exit(1);
}

if (flag('--revert')) {
    if (!fs.existsSync(backup)) {
        console.error('没有备份可还原:' + backup);
        process.exit(1);
    }
    fs.copyFileSync(backup, target);
    console.log('已还原:' + target + '(从 ' + backup + ')');
    process.exit(0);
}

const before = fs.readFileSync(target, 'utf8');
const patched = before.includes(MARK);
// 旧版补丁(只接正文)带着它自己的标记 —— 也可能是"更早的那版七件事补丁"(少了问用户那一处):
// 两种都要认出来"该升级",不能当成没打过。
const legacy = !patched && before.includes(LEGACY_MARK);
const partial = patched && !CHECKS.every((s) => before.includes(s));

if (flag('--check')) {
    const counts = PARTS.map((p) => ({ name: p.name, n: before.split(p.anchor).length - 1 }));
    console.log('目标:' + target);
    console.log('已打补丁:' + patched + (legacy ? '(**旧版**:只接正文,建议升级)' : '')
        + (partial ? '(**不完整**:缺 ' + JSON.stringify(CHECKS.filter((s) => !before.includes(s))) + ')' : ''));
    console.log('备份:' + (fs.existsSync(backup) ? backup : '(无)'));
    for (const c of counts) console.log('  锚点[' + c.n + '] ' + c.name);
    process.exit(patched && !partial ? 0 : 2);
}

if (patched && !partial) {
    console.log('已经打过补丁,不动它:' + target);
    process.exit(0);
}

if (legacy || partial) {
    console.error('这份桥打的是**旧版/不完整**的补丁(' + (legacy ? '只接了正文' : '缺了问用户那一处') + '):'
        + '先 `--revert` 还原,再重跑本脚本升级。不在这里自动改它 —— 在打过补丁的文件上再打一遍,锚点对不上。');
    process.exit(1);
}

// 每条锚点必须**各自恰好出现一次**:对不上就一条都不改(半个补丁比不打更危险)
const bad = PARTS.map((p) => ({ p, n: before.split(p.anchor).length - 1 })).filter((x) => x.n !== 1);
if (bad.length > 0) {
    console.error('锚点对不上,拒绝写盘(多半是 DSH 升级动过这个文件):');
    for (const { p, n } of bad) console.error('  [' + n + ' 次] ' + p.name + '  →  ' + JSON.stringify(p.anchor.slice(0, 70)));
    console.error('文件:' + target);
    process.exit(1);
}

if (!fs.existsSync(backup)) {
    fs.copyFileSync(target, backup);
    console.log('已备份原始文件:' + backup);
}

let after = before;
for (const part of PARTS) after = after.replace(part.anchor, part.repl);
fs.writeFileSync(target, after, 'utf8');

// 写完自检:标记在、七处改动都在(缺哪一条就把它打出来,别只说一句"失败")
const check = fs.readFileSync(target, 'utf8');
const missing = CHECKS.filter((s) => !check.includes(s));
const ok = check.includes(MARK) && missing.length === 0;
console.log('已写入:' + target);
console.log('自检:' + (ok ? '通过(标记 + 八处改动都在)' : '**失败**,缺 ' + JSON.stringify(missing)));
console.log('用 node .agent-probe/acp-stream-timing.mjs 可以量出增量条数与到达时间。');
process.exit(ok ? 0 : 1);
