import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FIRST_TOKEN_CALIBRATION, MAX_NOTE_CHARS, NO_NOTE_CONTEXT, applyVideoProgress, beginPrompt,
    beginVideoStages, buildPromptText, describeNoteContext, estimateFirstTokenFrom,
    estimateFirstTokenMs, failedVideoStage, finishVideoStages, initialStreamState, lastActiveStage,
    needsCredentialAttention, reduceAgentEvent, resolvePermission, stageDetailText, videoStageLabel,
} from '../app/lib/agent-stream.js';

// 这一组用例钉的是主进程 → 渲染进程那条**冻结契约**的归约端
// (见 docs/superpowers/plans/2026-09-18-kaiwu-m3-b-agent-panel.md)。
// 契约里最容易出错的三处:连续 chunk 被拆成多个气泡、tool_call_update 新建了卡片、
// 同一个 requestId 出了两张权限卡 —— 三条都单独立了用例。

/** 一条流的简写:把若干事件依次折进去。 */
function fold(events, start = initialStreamState()) {
    return events.reduce(reduceAgentEvent, start);
}

function chunk(text) {
    return { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } };
}

test('初始状态只有契约里那几个字段,且能 JSON.stringify', () => {
    const s = initialStreamState();
    assert.deepEqual(Object.keys(s).sort(), [
        'busy', 'caps', 'configOptions', 'error', 'messages', 'order', 'permissions',
        'sessionError', 'sessionId', 'status', 'thoughts', 'tools', 'translations', 'usage',
    ]);
    assert.deepEqual(s.order, [], 'order 是有序时间线,空会话里没有条目');
    assert.deepEqual(s.translations, {}, '译文按思考条 id 记,空会话里没有');
    assert.deepEqual(Object.keys(s.status).sort(), ['error', 'pid', 'restarts', 'since', 'state']);
    assert.equal(s.status.state, 'stopped');
    assert.equal(s.busy, false);
    assert.deepEqual(s.configOptions, [], '会话还没建时没有配置项,但键要在(界面要能读)');
    // caps 初值是 null 而不是 {image:false}:「还不知道」与「明确不支持」是两件事 ——
    // 前者不许拒绝用户发图(旧外壳/替身根本没有这个字段)。
    assert.equal(s.caps, null, '还没握手时能力是"不知道",不是"不支持"');
    assert.doesNotThrow(() => JSON.stringify(s));
});

test('session 事件把对端广告的能力收进状态:缺 image 就是"不收图片"', () => {
    const withImage = fold([{ kind: 'session', sessionId: 's1', configOptions: [], caps: { image: true, audio: false } }]);
    assert.deepEqual(withImage.caps, { image: true, audio: false, embeddedContext: false });

    const noImage = fold([{ kind: 'session', sessionId: 's1', configOptions: [], caps: { audio: true } }]);
    assert.equal(noImage.caps.image, false, 'ACP 里没写 image 就是"不收图片"');

    const absent = fold([{ kind: 'session', sessionId: 's1', configOptions: [] }]);
    assert.equal(absent.caps, null, '事件没带 caps → 保留上一次的(初始是 null),不许冲成"不支持"');
});

test('连续 agent_message_chunk 拼进同一条气泡,不是每条一个气泡', () => {
    const s = fold([chunk('你'), chunk('好'), chunk('呀')]);

    assert.equal(s.messages.length, 1, `应当只有一条气泡,实际 ${s.messages.length} 条`);
    assert.equal(s.messages[0].role, 'assistant');
    assert.equal(s.messages[0].text, '你好呀');
    assert.equal(s.messages[0].done, false, '流式中的气泡还没收尾');
});

test('工具卡片夹在流式中间:卡片单列,气泡不因为一次工具调用就另起一个', () => {
    // 这是**有意**的选择:契约只要求"连续 chunk 拼进同一条",没有要求工具调用
    // 切断当前气泡。工具卡片在界面上本来就画成独立的一行(.agent-tool),
    // 所以"先看看 [卡片] 看完了"看着是对的;反过来为它维护一个"气泡还开着吗"
    // 的隐藏标记,只会给状态多一个容易出错的分支。
    // 真正被钉住的是:**卡片不许重复建**,流式文本不许丢、不许错序。
    const s = fold([
        chunk('先看看'),
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', kind: 'read', status: 'pending' } },
        chunk('看完了'),
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
    ]);

    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0].text, '先看看看完了', '流式文本不许因为工具调用断掉');
    assert.equal(s.tools.length, 1, '两次 tool_* 事件只能有一张卡片');
    assert.equal(s.tools[0].status, 'completed');
});

test('tool_call 建卡片,tool_call_update 按同一个 toolCallId 改同一条', () => {
    const s = fold([
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'call-7', title: 'edit', kind: 'edit', status: 'pending' } },
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-7', status: 'completed' } },
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-7', status: 'completed' } },
    ]);

    assert.equal(s.tools.length, 1, '更新不许新建卡片');
    assert.deepEqual(s.tools[0], { toolCallId: 'call-7', title: 'edit', kind: 'edit', status: 'completed' });
});

test('没有 title 的 tool_call_update 不许把原标题冲成空', () => {
    const s = fold([
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: '读笔记', kind: 'read' } },
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress' } },
    ]);

    assert.equal(s.tools[0].title, '读笔记');
    assert.equal(s.tools[0].status, 'in_progress');
});

test('tool_call 没带 toolCallId 时不建卡片(建了也没法更新它)', () => {
    const s = fold([{ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', title: '无 id' } }]);
    assert.deepEqual(s.tools, []);
});

test('agent_thought_chunk 进 thoughts,不混进消息流', () => {
    const s = fold([
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '让我想想' } } },
        chunk('想好了'),
    ]);

    assert.equal(s.thoughts.length, 1);
    assert.equal(s.thoughts[0].text, '让我想想');
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0].role, 'assistant');
});

test('usage_update 落成叶子数字(两种命名都认)', () => {
    const a = fold([{ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'usage_update', inputTokens: 12, outputTokens: 34, totalTokens: 46 } }]);
    assert.deepEqual(a.usage, { inputTokens: 12, outputTokens: 34, totalTokens: 46 });

    const b = fold([{ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'usage_update', input_tokens: 1, output_tokens: 2 } }]);
    assert.equal(b.usage.inputTokens, 1);
    assert.equal(b.usage.outputTokens, 2);
});

test('usage_update 没带数字时不动状态(不许把上一次的用量抹成 0)', () => {
    const s = fold([
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'usage_update', inputTokens: 5, outputTokens: 6 } },
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'usage_update', note: '只是别的字段' } },
    ]);
    assert.deepEqual(s.usage, { inputTokens: 5, outputTokens: 6, totalTokens: 0 });
});

test('user_message_chunk 记账,但面板已经放过的那句不重复出气泡', () => {
    const one = fold([{ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你好' } } }]);
    assert.equal(one.messages.length, 1);
    assert.equal(one.messages[0].role, 'user');

    const two = fold([
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你好' } } },
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你好' } } },
    ]);
    assert.equal(two.messages.length, 1, '同一句话到达两次不许变成两条');
});

test('prompt-end 收尾:当前 assistant 气泡标 done、busy 落下、错误清掉', () => {
    const s = beginPrompt(fold([chunk('半句')]), '问题');
    assert.equal(s.busy, true);

    const done = reduceAgentEvent(s, { kind: 'prompt-end', sessionId: 's1', stopReason: 'end_turn' });
    assert.equal(done.busy, false);
    // 收尾要落在那条 assistant 气泡上 —— 用户那句话是它后面的一条,不是它
    const assistant = done.messages.find(m => m.role === 'assistant');
    assert.equal(assistant.done, true);
    assert.equal(assistant.text, '半句', '收尾不许改内容');
    assert.equal(done.error, null);
});

test('prompt-error 收尾:中文原因可见、busy 落下、缺凭证标记为 true', () => {
    const s = reduceAgentEvent(
        beginPrompt(initialStreamState(), '问题'),
        { kind: 'prompt-error', sessionId: 's1', message: '未找到凭证', missingCredential: true },
    );

    assert.equal(s.busy, false);
    assert.deepEqual(s.error, { message: '未找到凭证', missingCredential: true });
    assert.equal(needsCredentialAttention(s), true, '缺凭证要能被面板认出来(卡片高亮)');
});

test('prompt-error 没带原因时也给一句中文,不给 undefined', () => {
    const s = reduceAgentEvent(initialStreamState(), { kind: 'prompt-error', sessionId: 's1' });
    assert.match(s.error.message, /提示失败/);
    assert.equal(s.error.missingCredential, false);
    assert.equal(needsCredentialAttention(s), false);
});

test('session-error(自动建会话失败):单独记一条原因,而且不占用"这一轮失败"那个位置', () => {
    // 为什么单独一条:自动建会话失败时**一轮对话都还没有**,没有哪一轮可以挂它;
    // 而 error 那个位置会被 prompt-end 清掉、被下一轮覆盖,生命周期完全不同。
    const s = reduceAgentEvent(initialStreamState(), {
        kind: 'session-error', message: '对端不肯建会话',
    });
    assert.equal(s.sessionError.message, '对端不肯建会话');
    assert.equal(s.error, null, '不许占用"这一轮失败"(否则轮次轨会莫名标红)');
    assert.equal(s.sessionId, null, '失败就是没有会话 —— 界面那句"还没建会话"仍然成立');

    // 没带原因也要给一句中文,不给 undefined
    const bare = reduceAgentEvent(initialStreamState(), { kind: 'session-error' });
    assert.match(bare.sessionError.message, /自动建会话失败/);

    // 会话真的建起来了 → 那句"失败"立刻作废(它是那一刻的事实,不是这条连接的属性)
    const fixed = reduceAgentEvent(s, { kind: 'session', sessionId: 's1', configOptions: [] });
    assert.equal(fixed.sessionId, 's1');
    assert.equal(fixed.sessionError, null, '会话建好了还挂着"建会话失败"就是界面在撒谎');
});

test('同一个 requestId 重复到达只出一张权限卡', () => {
    const event = {
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 's1',
        toolCall: { toolCallId: 'c1', title: '运行命令', kind: 'execute' },
        options: [
            { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
            { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
        ],
    };

    const s = fold([event, event, { ...event, options: [] }]);

    assert.equal(s.permissions.length, 1, '重复请求不许出两张卡');
    assert.equal(s.permissions[0].requestId, 'req-1');
    assert.equal(s.permissions[0].title, '运行命令');
    assert.deepEqual(s.permissions[0].options.map(o => o.optionId), ['allow-once', 'reject-once']);
    assert.equal(s.permissions[0].resolved, false);
    assert.equal(s.permissions[0].decided, '', '还没决定时"选了哪一个"是空的');
});

test('权限卡已决后再来一次同一个 requestId,仍然只有一张', () => {
    const event = { kind: 'permission', requestId: 'req-2', toolCall: { title: 'x' }, options: [{ optionId: 'a', name: 'A' }] };
    const s = resolvePermission(fold([event]), 'req-2');
    const again = reduceAgentEvent(s, event);

    assert.equal(again.permissions.length, 1);
    assert.equal(again.permissions[0].resolved, true, '已决状态不许被重发冲掉');
});

test('state 事件把进程状态整份换掉(pid 为 null 时不能被默认值填上)', () => {
    const s = fold([
        { kind: 'state', status: { state: 'ready', pid: 4242, error: null, restarts: 0, since: 1 } },
        { kind: 'state', status: { state: 'stopped', pid: null, error: null, restarts: 0, since: 2 } },
    ]);

    assert.equal(s.status.state, 'stopped');
    assert.equal(s.status.pid, null, 'null 是有效值,不该被拿默认值补');
});

test('session 事件记下 sessionId', () => {
    const s = reduceAgentEvent(initialStreamState(), { kind: 'session', sessionId: 'sess-9', configOptions: [{ id: 'model' }] });
    assert.equal(s.sessionId, 'sess-9');
});

test('session 事件把 configOptions 也留在状态里(叶子字段,可 JSON 化)', () => {
    // Plan B 的交接表写着"session/new 返回的 configOptions(模型 / 思考强度)
    // 面板要显示与切换它们"。M3-B 这一轮**只负责留住**它(界面渲染推到 M4),
    // 但"留不住"就等于那条交接被安静地跳过了 —— 所以状态里必须有它。
    const s = reduceAgentEvent(initialStreamState(), {
        kind: 'session',
        sessionId: 'sess-9',
        configOptions: [
            { id: 'model', name: '模型', currentValue: 'deepseek-chat', options: [{ value: 'deepseek-chat', name: 'chat' }] },
            { id: 'thought', name: '思考强度', currentValue: 'high' },
        ],
    });

    assert.equal(s.sessionId, 'sess-9');
    assert.equal(s.configOptions.length, 2, `configOptions 必须落进状态,实际 ${s.configOptions.length} 项`);
    assert.equal(s.configOptions[0].id, 'model');
    assert.equal(s.configOptions[0].currentValue, 'deepseek-chat');
    assert.deepEqual(s.configOptions[0].options.map(o => o.value), ['deepseek-chat']);
    assert.equal(s.configOptions[1].currentValue, 'high');
    assert.deepEqual(Object.keys(s.configOptions[0]).sort(),
        ['currentValue', 'id', 'name', 'options'], '只留叶子字段,对端给什么结构都不许漏进来');
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
});

test('session 事件没带 configOptions 时不许把已有的冲成空', () => {
    const first = reduceAgentEvent(initialStreamState(), {
        kind: 'session', sessionId: 's1', configOptions: [{ id: 'model', currentValue: 'x' }],
    });
    const again = reduceAgentEvent(first, { kind: 'session', sessionId: 's1' });
    assert.equal(again.configOptions.length, 1, '后一条没带就不动它');
});

test('configOptions 里对端给的脏数据不许让归约抛错', () => {
    const s = reduceAgentEvent(initialStreamState(), {
        kind: 'session',
        sessionId: 's1',
        configOptions: [null, '不是对象', { id: '' }, { id: 'ok', options: '不是数组' }],
    });
    assert.equal(s.configOptions.length, 1, '没有 id 的项丢掉,其余照收');
    assert.equal(s.configOptions[0].id, 'ok');
    assert.deepEqual(s.configOptions[0].options, []);
    assert.doesNotThrow(() => JSON.stringify(s));
});

test('未识别的事件原样返回(将来 ACP 加字段不该让界面冒半张卡片)', () => {
    const before = fold([chunk('内容')]);
    const after = reduceAgentEvent(before, { kind: '未来才有的东西' });
    assert.deepEqual(after, before);

    const weird = reduceAgentEvent(before, { kind: 'update', sessionId: 's1', update: { sessionUpdate: '未来的更新' } });
    assert.deepEqual(weird, before);
});

test('update 的 content 是数组或裸字符串都能取到文本', () => {
    const arr = fold([{ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] } }]);
    assert.equal(arr.messages[0].text, '甲乙');

    const raw = fold([{ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: '丙' } }]);
    assert.equal(raw.messages[0].text, '丙');
});

test('归约不改传进来的 state(面板要靠前后两份做对比)', () => {
    const before = initialStreamState();
    const snapshot = JSON.stringify(before);
    reduceAgentEvent(before, chunk('x'));
    reduceAgentEvent(before, { kind: 'state', status: { state: 'ready' } });

    assert.equal(JSON.stringify(before), snapshot);
});

test('对端给的 XSS 字符原样留在状态里(渲染端用 textContent)', () => {
    const evil = '<img onerror="alert(1)" src=x>';
    const s = fold([
        chunk(evil),
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: evil, kind: evil } },
    ]);

    assert.equal(s.messages[0].text, evil);
    assert.equal(s.tools[0].title, evil);
    assert.equal(s.tools[0].kind, evil);
});

test('归约出来的状态可 JSON.stringify(没有活对象漏进去)', () => {
    const s = fold([
        { kind: 'state', status: { state: 'ready', pid: 1 } },
        { kind: 'session', sessionId: 's1' },
        chunk('hi'),
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', status: 'pending' } },
        { kind: 'permission', requestId: 'r', toolCall: { title: 'p' }, options: [{ optionId: 'o', name: 'O' }] },
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'usage_update', inputTokens: 1, outputTokens: 2 } },
    ]);

    assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
});

// ---------- beginPrompt / resolvePermission ----------

test('beginPrompt:问题立刻上屏并且 busy 立起来', () => {
    const s = beginPrompt(initialStreamState(), '  这篇笔记讲了什么  ');

    assert.equal(s.busy, true);
    assert.equal(s.messages.length, 1);
    assert.deepEqual({ role: s.messages[0].role, text: s.messages[0].text, done: s.messages[0].done },
        { role: 'user', text: '这篇笔记讲了什么', done: true });
});

test('beginPrompt:空问题不动状态(不许发一次空提示)', () => {
    const before = initialStreamState();
    assert.deepEqual(beginPrompt(before, '   '), before);
    assert.deepEqual(beginPrompt(before, ''), before);
    assert.equal(beginPrompt(before, '  ').busy, false);
});

test('beginPrompt:带上图片时用户消息里就有图片(全是叶子字段,url 是渲染层给的 blob:)', () => {
    const s = beginPrompt(initialStreamState(), '看这张图', [
        { url: 'blob:kaiwu/1', mimeType: 'image/png', name: 'shot.png' },
    ]);

    assert.equal(s.messages.length, 1);
    assert.deepEqual(s.messages[0].images, [
        { url: 'blob:kaiwu/1', mimeType: 'image/png', name: 'shot.png' },
    ]);
    // 状态必须还能 JSON.stringify(里面不许出现活对象 —— 图片只是几个字符串)
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
});

test('beginPrompt:只发图没写字也是一次合法的提示(气泡里只有图,不加占位文字)', () => {
    const s = beginPrompt(initialStreamState(), '   ', [
        { url: 'blob:kaiwu/1', mimeType: 'image/png', name: 'shot.png' },
    ]);

    assert.equal(s.busy, true);
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0].role, 'user');
    assert.equal(s.messages[0].text, '', '空气泡:一个字都不许凭空加进去');
    assert.equal(s.messages[0].images.length, 1);
});

test('beginPrompt:没有图片时消息形状与从前**逐字段一致**(不许多出一个空 images)', () => {
    const plain = beginPrompt(initialStreamState(), '你好');
    assert.deepEqual(Object.keys(plain.messages[0]).sort(), ['done', 'id', 'role', 'text'],
        '字段集就是契约:多一个空数组会改掉既有形状');

    // 空数组、以及"给了图但没有 url"的条目,都算"没有图" —— 形状必须一模一样
    assert.deepEqual(beginPrompt(initialStreamState(), '你好', []).messages[0], plain.messages[0]);
    assert.deepEqual(beginPrompt(initialStreamState(), '你好', [{ url: '' }]).messages[0], plain.messages[0]);
    // 连一张能用的图都没有时,空问题照旧什么都不做
    const before = initialStreamState();
    assert.deepEqual(beginPrompt(before, '  ', [{ url: '' }]), before);
});

test('resolvePermission 只标记那一条卡片', () => {
    const s = fold([
        { kind: 'permission', requestId: 'r1', toolCall: { title: '一' }, options: [{ optionId: 'a', name: 'A' }] },
        { kind: 'permission', requestId: 'r2', toolCall: { title: '二' }, options: [{ optionId: 'b', name: 'B' }] },
    ]);
    const after = resolvePermission(s, 'r1', 'allow-once');

    assert.equal(after.permissions[0].resolved, true);
    assert.equal(after.permissions[1].resolved, false);
    assert.equal(resolvePermission(after, '不存在').permissions[0].resolved, true, '找不到就原样返回');
});

test('resolvePermission 要记住用户选了哪一个(decided 就是那个 optionId)', () => {
    // 自检断言的是「用户的决定被界面记住了」:resolved 是个布尔,说不出选的是哪个,
    // 所以"选了哪一个"必须自己存一个字段。
    const s = fold([
        { kind: 'permission', requestId: 'r1', toolCall: { title: '一' }, options: [{ optionId: 'a', name: 'A' }] },
        { kind: 'permission', requestId: 'r2', toolCall: { title: '二' }, options: [{ optionId: 'b', name: 'B' }] },
    ]);
    const after = resolvePermission(s, 'r2', 'b');

    assert.equal(after.permissions[1].decided, 'b');
    assert.equal(after.permissions[1].resolved, true);
    assert.equal(after.permissions[0].decided, '', '别的卡片不受影响');

    // 已经决定过就不许被后一次改写(第二次点击可能还排在队列里)
    const again = resolvePermission(after, 'r2', '别的选项');
    assert.equal(again.permissions[1].decided, 'b');
});

// ---------- buildPromptText ----------

test('buildPromptText:正常情况的形状固定 —— 第一行就是「当前笔记:<path>」', () => {
    const text = buildPromptText({
        noteTitle: '灵感收集', notePath: 'inbox/灵感.md', noteText: '# 灵感收集\n\n今天想到一个点子。', question: '帮我整理成三条',
    });
    const lines = text.split('\n');

    // 这一行的字面形状是契约:自检的夹具用 --echo-prompt 把提示原文回显成一条
    // user_message_chunk,自检再断言消息流里出现「当前笔记:<当前那篇的 path>」。
    assert.equal(lines[0], '当前笔记:inbox/灵感.md');
    assert.equal(lines[1], '标题:灵感收集');
    assert.match(text, /今天想到一个点子/);
    assert.match(text, /帮我整理成三条/);
    assert.equal(lines.at(-1), '问题:帮我整理成三条', '问题在最后一行');
});

test('buildPromptText:空问题直接抛错(不许拼出一次空提示)', () => {
    assert.throws(() => buildPromptText({ noteTitle: 'a', question: '   ' }), /问题不能为空/);
    assert.throws(() => buildPromptText({}), /问题不能为空/);
    assert.throws(() => buildPromptText(), /问题不能为空/);
});

test('buildPromptText:没有打开的笔记时只发问题本身,「当前笔记:」整行不出现', () => {
    assert.equal(buildPromptText({ noteTitle: '', notePath: '', noteText: '', question: '你好' }), '你好');
    assert.equal(buildPromptText({ question: '  你好  ' }), '你好');
    assert.equal(buildPromptText({ noteText: '   ', question: '你好' }), '你好', '只有空白的正文等于没有笔记');
    assert.equal(buildPromptText({ question: '你好' }).includes('当前笔记:'), false);
});

test('buildPromptText:正文超长要截断,并且**明说**截断了', () => {
    const long = '甲'.repeat(MAX_NOTE_CHARS + 250);
    const text = buildPromptText({ noteTitle: '长文', notePath: 'a.md', noteText: long, question: '总结' });
    const lines = text.split('\n');

    assert.equal(text.includes('甲'.repeat(MAX_NOTE_CHARS + 1)), false, '超出的部分不许出现在提示里');
    assert.equal(lines[2], '正文已截断', '截断要单独占一行,措辞不许改');
    assert.equal(text.includes('甲'.repeat(MAX_NOTE_CHARS)), true, '上限之内的正文要在');
});

test('buildPromptText:刚好等于上限时不截断(只在超出时提示)', () => {
    const exact = '乙'.repeat(MAX_NOTE_CHARS);
    const text = buildPromptText({ noteTitle: 't', notePath: 'a.md', noteText: exact, question: 'q' });
    assert.equal(text.includes('正文已截断'), false);
});

// ---------- 输入框上那句"这次会带上哪篇笔记" ----------
//
// 那一行上的上下文文字与状态点都按用户要求删掉了,这份信息现在只能挂在输入框上:
// placeholder(短,一眼看得见)+ title(全,悬停看得见)。判据与 buildPromptText 的
// `hasNote` **同一口径** —— 两处判岔了就会出现"输入框说没带笔记、其实带上了"。

test('describeNoteContext:有笔记 → placeholder 带笔记名、title 放完整那句', () => {
    const ctx = describeNoteContext({ path: '甲篇.md', title: '甲篇', text: '正文' });
    assert.equal(ctx.bound, true);
    assert.equal(ctx.name, '甲篇');
    assert.equal(ctx.full, '将带上笔记:甲篇', '悬停那一句要和以前状态点上的**一字不差**');
    assert.equal(ctx.placeholder, '就「甲篇」提问…');
});

test('describeNoteContext:没有笔记 → 两处都是同一句话(不是两种说法)', () => {
    const none = describeNoteContext(null);
    assert.equal(none.bound, false);
    assert.equal(none.full, NO_NOTE_CONTEXT);
    assert.equal(none.placeholder, NO_NOTE_CONTEXT, '两处必须一字不差,否则用户会以为悬停能看到别的');
    // 脏输入不抛(通道/替身可能给任何东西)
    for (const bad of [undefined, '', 0, [], { title: '   ', path: '  ', text: '  ' }]) {
        assert.equal(describeNoteContext(bad).bound, false, `${JSON.stringify(bad)} 该当成"没有笔记"`);
    }
});

test('describeNoteContext:只有标题 / 只有路径 / 只有正文,各按各的兜住', () => {
    assert.equal(describeNoteContext({ path: 'D:\\库\\很长的目录名\\某篇.md' }).name, 'D:\\库\\很长的目录名\\某篇.md',
        '没有标题就用路径当名字');
    // 只有正文(标题与路径都空):提示词那边**算带上了笔记**(见 buildPromptText 的 hasNote),
    // 所以这里也必须是 bound,只是名字退回一个中性说法 —— 不能让两边判岔。
    const bodyOnly = describeNoteContext({ text: '正文' });
    assert.equal(bodyOnly.bound, true);
    assert.equal(bodyOnly.name, '当前笔记');
});

test('describeNoteContext:笔记名过长按**码点**截断(不劈开代理对),完整那句不截', () => {
    const long = '📕'.repeat(20);
    const ctx = describeNoteContext({ title: long });
    assert.equal(ctx.full, `将带上笔记:${long}`, 'title 那句是完整的');
    assert.equal([...ctx.placeholder].includes('…'), true, 'placeholder 要带省略号');
    assert.equal(ctx.placeholder, `就「${'📕'.repeat(12)}…」提问…`, '按**码点**截到 12 个再补省略号');
    assert.equal(ctx.placeholder.includes('\uFFFD'), false, '不许把代理对劈成半个字符');
    // 刚好等于上限时不截断
    assert.equal(describeNoteContext({ title: '甲'.repeat(12) }, { maxNameChars: 12 }).placeholder,
        '就「' + '甲'.repeat(12) + '」提问…');
});

test('buildPromptText:正文里的 CRLF 归一成 LF(不改缩进与代码块)', () => {
    const text = buildPromptText({ noteTitle: 't', notePath: 'a.md', noteText: '第一行\r\n    缩进的代码\r\n', question: 'q' });
    assert.equal(text.includes('\r'), false);
    assert.ok(text.includes('    缩进的代码'), '缩进必须原样保留');
});

test('buildPromptText:对端/用户给的 XSS 字符原样保留,不做 HTML 编码', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const text = buildPromptText({ noteTitle: evil, notePath: 'a.md', noteText: evil, question: evil });

    assert.ok(text.includes(evil), '原样送进提示 —— 它不是元素,是一行文字');
    assert.equal(text.includes('&lt;'), false, '不许在这里做 HTML 转义');
});

// ---------- 有序时间线(order)----------
//
// 为什么必须有它:状态原本把 messages / thoughts / tools 存成**三个互不相干的数组**,
// 先后信息在归约那一刻就丢了。界面于是只能"先思考、再工具、最后消息"三坨画 ——
// 思考永远置顶、工具卡永远排在**所有**消息前面(实测:工具卡跑到用户那句「你好呀」
// 上面去了)。order 只记**顺序**,实体仍然留在原来的三个数组里,所以既有那些
// 读 state.tools[0] / state.thoughts[0] 的用例一条都不用改。
//
// 键带前缀(msg: / think: / tool:)是有意的:三类 id 来自不同地方(自己编号的
// m-N / t-N,以及对端给的任意 toolCallId),不加前缀就可能撞在一起,而撞了的表现是
// "有一条内容在界面上消失" —— 静默、难查。

const toolEv = (toolCallId, status = 'pending', title = 'read') => ({
    kind: 'update', sessionId: 's1',
    update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'read', status },
});
const toolUpd = (toolCallId, status) => ({
    kind: 'update', sessionId: 's1',
    update: { sessionUpdate: 'tool_call_update', toolCallId, status },
});
const think = (text) => ({
    kind: 'update', sessionId: 's1',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
});

test('order 按真实先后记下三类条目:正文 → 工具 → 思考', () => {
    const s = fold([chunk('答复'), toolEv('t1'), think('再想想')]);

    assert.deepEqual(s.order, ['msg:m-1', 'tool:t1', 'think:t-1']);
});

test('order:用户消息也进时间线(它是一段对话的起点)', () => {
    const s = beginPrompt(initialStreamState(), '你好呀');

    assert.deepEqual(s.order, ['msg:m-1']);
    assert.equal(s.messages[0].role, 'user');
});

test('同一个工具反复更新,order 里只记一次(变的是状态,不是位置)', () => {
    const s = fold([toolEv('t1'), toolUpd('t1', 'in_progress'), toolUpd('t1', 'completed')]);

    assert.deepEqual(s.order, ['tool:t1']);
    assert.equal(s.tools.length, 1, '更新不许新建卡片');
});

test('同一轮里思考 → 工具 → 正文:顺序如实,而且新一段思考排在工具之后', () => {
    const s = fold([think('先看看'), toolEv('t1'), toolUpd('t1', 'completed'), think('看完了'), chunk('好了')]);

    assert.deepEqual(s.order, ['think:t-1', 'tool:t1', 'think:t-2', 'msg:m-1']);
});

test('order 与三个数组一一对应:一个不少、一个不重(界面才不会漏画或画两遍)', () => {
    const s = fold([
        chunk('甲'), toolEv('c1'), think('想想'), toolEv('c2'), toolUpd('c1', 'completed'), chunk('乙'),
    ]);
    const expected = [
        ...s.messages.map(m => `msg:${m.id}`),
        ...s.thoughts.map(t => `think:${t.id}`),
        ...s.tools.map(t => `tool:${t.toolCallId}`),
    ];

    assert.deepEqual([...s.order].sort(), [...expected].sort());
    assert.equal(new Set(s.order).size, s.order.length, 'order 里不许有重复键');
});

test('未识别的事件不许往 order 里塞东西(界面不该冒出半张卡)', () => {
    const s = fold([chunk('甲'), { kind: 'update', sessionId: 's1', update: { sessionUpdate: '将来才有的类型' } }]);

    assert.deepEqual(s.order, ['msg:m-1']);
    assert.doesNotThrow(() => JSON.stringify(s));
});

test('工具没有 toolCallId 时不建卡、也不进 order(建了也没法更新它)', () => {
    const s = fold([
        { kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', title: '无 id' } },
    ]);

    assert.deepEqual(s.tools, []);
    assert.deepEqual(s.order, []);
});

// ---------- 提问:同一个权限事件,多了 question 标记与选项说明 ----------
//
// 桥把模型的 ask_user_question 映射成一次 session/request_permission,toolCall.kind
// 用 "question" 当暗号。归约这边只做两件事:把标记留下、把选项说明留下(都是叶子字段)。

test('提问事件:question 标记与选项说明都落进状态,且可 JSON 化', () => {
    const s = fold([{
        kind: 'permission', requestId: 'q-1', question: true,
        toolCall: { toolCallId: 'ask:1', title: '实现方式', kind: 'question' },
        options: [{ optionId: 'q0', name: 'A:共用解析', kind: 'allow_once', description: '零重复' }],
    }]);

    assert.equal(s.permissions[0].question, true);
    assert.equal(s.permissions[0].title, '实现方式');
    assert.deepEqual(s.permissions[0].options[0],
        { optionId: 'q0', name: 'A:共用解析', kind: 'allow_once', description: '零重复' });
    assert.doesNotThrow(() => JSON.stringify(s));
});

test('没有 question 标记的权限事件按授权卡处理(默认 false,不猜)', () => {
    const s = fold([{
        kind: 'permission', requestId: 'p-1',
        toolCall: { title: '跑命令' }, options: [{ optionId: 'a', name: 'A' }],
    }]);

    assert.equal(s.permissions[0].question, false);
    assert.equal(s.permissions[0].options[0].description, '', '缺说明就是空串,别用 undefined');
});

// ---------- 按需翻译:译文按思考条 id 记 ----------
//
// 模型用英文思考时,用户可以点「译」让桥翻一次。译文与"翻到哪一步了"按 thoughtId
// 落在这里 —— 界面据此显示 译 / 翻译中… / 中文·原文 三种状态。

test('翻译事件:按 thoughtId 落进状态,能表达"翻译中 / 好了 / 失败"', () => {
    const base = fold([think('Let me check the handler first.')]);
    const id = base.thoughts[0].id;

    const pending = reduceAgentEvent(base, { kind: 'translation', thoughtId: id, status: 'pending' });
    assert.deepEqual(pending.translations[id], { status: 'pending', text: '', error: '' });

    const done = reduceAgentEvent(pending, {
        kind: 'translation', thoughtId: id, status: 'done', text: '我先看一下这个处理函数。',
    });
    assert.equal(done.translations[id].status, 'done');
    assert.equal(done.translations[id].text, '我先看一下这个处理函数。');

    const failed = reduceAgentEvent(done, {
        kind: 'translation', thoughtId: id, status: 'error', error: '模型调用超时',
    });
    assert.deepEqual(failed.translations[id], { status: 'error', text: '', error: '模型调用超时' });
});

test('翻译事件:没有 thoughtId 就不落(落了也没法对应到哪一条)', () => {
    const s = reduceAgentEvent(initialStreamState(), { kind: 'translation', thoughtId: '', status: 'done', text: 'x' });
    assert.deepEqual(s.translations, {});
});

test('翻译事件:不认识的 status 一律当"失败"收场,不许留一个永远转圈的"翻译中"', () => {
    const base = fold([think('hello')]);
    const id = base.thoughts[0].id;
    const s = reduceAgentEvent(base, { kind: 'translation', thoughtId: id, status: '莫名其妙的阶段' });

    assert.equal(s.translations[id].status, 'error');
    assert.doesNotThrow(() => JSON.stringify(s));
});

// ---------- 黏贴截图:提示词那一段 ----------
//
// 输入区为空、只黏了一张截图也能发。这时"问题:…"那一行**不能留空** ——
// 留空等于给模型发一个空问题,而它多半会当作"用户什么都没问"。

test('只发图片(没写字)时问题那一行写清「只有图、没有文字」,而不是留空', () => {
    const text = buildPromptText({ question: '', imageCount: 1 });
    assert.match(text, /\(只发了 1 张图片,没有文字\)/);
    assert.equal(/问题:\s*$/.test(text), false, '问题后面不许是空的');
});

test('有笔记上下文 + 只有图片:上下文照旧带上,问题那一行是那句占位', () => {
    const text = buildPromptText({
        noteTitle: '灵感收集', notePath: 'inbox/灵感.md', noteText: '一个点子。',
        question: '', imageCount: 2,
    });
    assert.equal(text.split('\n')[0], '当前笔记:inbox/灵感.md');
    assert.match(text, /一个点子。/);
    assert.match(text, /问题:\(只发了 2 张图片,没有文字\)/);
});

test('有文字时那一行逐字不变(带了图片也不许改措辞)', () => {
    const bare = buildPromptText({ question: '看这张图' });
    const withImages = buildPromptText({ question: '看这张图', imageCount: 3 });
    assert.equal(withImages, bare, '有文字时 imageCount 不该影响一个字');
    assert.equal(withImages, '看这张图');
});

test('文字与图片都没有时仍然抛错(那条闸不许被图片顶开)', () => {
    assert.throws(() => buildPromptText({ question: '   ' }), /问题不能为空/);
    assert.throws(() => buildPromptText({ question: '', imageCount: 0 }), /问题不能为空/);
    // 假的张数(NaN/负数)不许把闸顶开
    assert.throws(() => buildPromptText({ question: '', imageCount: Number.NaN }), /问题不能为空/);
    assert.throws(() => buildPromptText({ question: '', imageCount: -1 }), /问题不能为空/);
});

// ---------- 方案 C:四段**真实**状态行 ----------
//
// 这一组用例的存在理由:进度条是**最容易骗人**的一块界面。四条判据必须被钉住:
//   1. 没出现过的阶段**不许**凭空补一行;同一个"发送请求体"格子,两条路的**说法**必须分开
//      (内联说"发送请求体",上传说"上传到服务端");
//   2. 百分比只认真的报上来的那个数(没报过 = null,**不是** 0);
//   3. 正文是**边收边拼**的(流式的全部意义就在这里);
//   4. 失败要红在**具体那一段**,没发生过的行不许打勾。

const CLIP = { name: '中国人能飞😭 [高清 1080P60] NA.mp4', mimeType: 'video/mp4', byteLength: 177737264, question: '描述一下' };

function staged(state = initialStreamState()) {
    return beginVideoStages(state, CLIP);
}

test('开始:一条用户消息(带视频卡)+ 一条**待完成的助手占位**,而占位只有「准备请求」一行', () => {
    const s = staged();
    assert.equal(s.messages.length, 2);
    assert.equal(s.messages[0].role, 'user');
    assert.equal(s.messages[0].video.name, CLIP.name);
    assert.equal(s.messages[1].role, 'assistant');
    assert.equal(s.messages[1].done, false, '占位必须是"还在飞"的,否则面板不会原地刷它');
    assert.equal(s.busy, true);
    assert.deepEqual(s.messages[1].stages.map(r => [r.key, r.state]), [['prepare', 'doing']]);
});

test('视频信息不全时:原样返回(调用方据此不发一次注定被拒的请求)', () => {
    const empty = initialStreamState();
    assert.equal(beginVideoStages(empty, { name: '' }), empty);
});

test('上传那条路:准备 → 上传(带百分比)→ 等待 → 生成,下载量/字数都是真读数', () => {
    let s = staged();
    s = applyVideoProgress(s, { stage: 'prepared', mode: 'upload', totalBytes: 177737264 });
    assert.deepEqual(s.messages[1].stages.map(r => [r.key, r.state]), [['prepare', 'done'], ['upload', 'doing']]);
    assert.equal(s.messages[1].stages[1].bytes, 177737264, '上传那一行要带上真实体积');
    assert.equal(s.messages[1].stages[1].percent, null, '还没报百分比时是 null —— **不是** 0');

    s = applyVideoProgress(s, { stage: 'uploading', percent: 37, sentBytes: 65760000, totalBytes: 177737264 });
    assert.equal(s.messages[1].stages[1].percent, 37);
    s = applyVideoProgress(s, { stage: 'uploading', percent: 99, sentBytes: 176000000, totalBytes: 177737264 });
    assert.equal(s.messages[1].stages[1].percent, 99);

    s = applyVideoProgress(s, { stage: 'waiting' });
    assert.deepEqual(s.messages[1].stages.map(r => [r.key, r.state]), [
        ['prepare', 'done'], ['upload', 'done'], ['wait', 'doing'],
    ]);
    assert.equal(s.messages[1].stages[1].percent, 100, '字节全交出去了,这时 100% 是真的');

    s = applyVideoProgress(s, { stage: 'generating', chars: 5, chunks: 1, delta: '一个红' });
    assert.deepEqual(s.messages[1].stages.map(r => [r.key, r.state]), [
        ['prepare', 'done'], ['upload', 'done'], ['wait', 'done'], ['generate', 'doing'],
    ]);
    assert.equal(s.messages[1].stages[3].chars, 5);
    s = applyVideoProgress(s, { stage: 'generating', chars: 9, chunks: 2, delta: '方块在动' });
    assert.equal(s.messages[1].text, '一个红方块在动', '正文是**边收边拼**的(流式的全部意义)');
    assert.equal(s.messages[1].stages[3].chars, 9);
});

test('内联那条路:发送那一行**在**,但说法是"发送请求体(内联 …)"而不是"上传"', () => {
    let s = staged();
    // prepared 里的 totalBytes 是**文件**大小(内联那条路走的就是这个文件)
    s = applyVideoProgress(s, { stage: 'prepared', mode: 'inline', totalBytes: 14523138 });
    // 内联**也有**"把请求体交给连接"这一段 —— 改成逐块流式发之后,它有真百分比了。
    // 所以这一行必须在;但它不是"上传到服务端":内联根本没有传文件这回事。
    assert.deepEqual(s.messages[1].stages.map(r => r.key), ['prepare', 'upload']);
    const row = s.messages[1].stages[1];
    assert.equal(row.mode, 'inline', 'mode 只决定文案,判据两条路完全一样');
    assert.equal(row.bytes, 14523138, '标签上那个体积是**文件**大小(用户认得的就是它)');
    assert.equal(row.percent, null, '还没报过百分比时是 null —— **不是** 0');
    assert.equal(videoStageLabel(row, (n) => `${(n / 1048576).toFixed(1)} MiB`), '发送请求体(内联 13.9 MiB)');
    // 同一个 key 在上传那条路上说法不同(混为一谈会让人以为内联也在传文件)
    const up = applyVideoProgress(staged(), { stage: 'prepared', mode: 'upload', totalBytes: 177737264 });
    assert.equal(
        videoStageLabel(up.messages[1].stages[1], (n) => `${(n / 1048576).toFixed(1)} MB`),
        '上传 169.5 MB 到服务端',
    );

    // ⚠️ 百分比的分母是**请求体**总长(base64 之后比文件大 1/3),而标签上那个体积是
    //   文件大小:两个数都真,但要是让 uploading 覆盖掉 prepared 给的那个,文案会在
    //   发送途中从 13.9 MiB 跳到 18.5 MiB —— 同一个格子两个数,用户只会以为出错了。
    s = applyVideoProgress(s, { stage: 'uploading', mode: 'inline', sentBytes: 9000000, totalBytes: 19364516, percent: 46 });
    assert.equal(s.messages[1].stages[1].bytes, 14523138, '标签上留的仍是文件大小');
    assert.equal(s.messages[1].stages[1].percent, 46, '内联这一段有**真**百分比(这是这次改动的全部意义)');
    // 上传那条路两个数本来就一样,所以覆盖与否结果相同
    const upRun = applyVideoProgress(
        applyVideoProgress(staged(), { stage: 'prepared', mode: 'upload', totalBytes: 177737264 }),
        { stage: 'uploading', mode: 'upload', sentBytes: 65760000, totalBytes: 177737264, percent: 37 },
    );
    assert.equal(upRun.messages[1].stages[1].bytes, 177737264);
    assert.equal(upRun.messages[1].stages[1].percent, 37);
    // 没有 prepared(只有 uploading)时,体积也不能是空的 —— 那时只能用它给的那个数
    const orphan = applyVideoProgress(
        applyVideoProgress(staged(), { stage: 'prepared', mode: 'inline', totalBytes: 0 }),
        { stage: 'uploading', mode: 'inline', sentBytes: 500, totalBytes: 1000, percent: 50 },
    );
    assert.equal(orphan.messages[1].stages[1].bytes, 1000, 'prepared 没给体积时退回 uploading 的读数(而不是留空)');

    s = applyVideoProgress(s, { stage: 'waiting' });
    assert.deepEqual(s.messages[1].stages.map(r => [r.key, r.state]), [
        ['prepare', 'done'], ['upload', 'done'], ['wait', 'doing'],
    ]);
    s = applyVideoProgress(s, { stage: 'generating', chars: 2, chunks: 1, delta: '红块' });
    assert.deepEqual(s.messages[1].stages.map(r => r.key), ['prepare', 'upload', 'wait', 'generate']);
});

test('收尾:同一处**变成**最终回答(stages 摘掉,形状与从前逐字段一致)', () => {
    let s = staged();
    s = applyVideoProgress(s, { stage: 'prepared', mode: 'upload', totalBytes: 177737264 });
    s = applyVideoProgress(s, { stage: 'waiting' });
    s = applyVideoProgress(s, { stage: 'generating', chars: 2, chunks: 1, delta: '红块' });
    const before = s.messages.length;
    s = finishVideoStages(s, {
        ok: true,
        text: '红块从左向右移动。',
        usage: { videoTokens: 127766, promptTokens: 127799, completionTokens: 44, mode: 'upload' },
        delivery: { mode: 'upload', timings: { prepareMs: 120, uploadMs: 27400, ttftMs: 26100, generateMs: 12900, totalMs: 66400 } },
    });
    assert.equal(s.messages.length, before, '不另起一条:同一条消息变成回答');
    const msg = s.messages[1];
    assert.equal(msg.done, true);
    assert.equal(msg.text, '红块从左向右移动。');
    assert.equal(msg.stages, undefined, 'stages 必须在收尾时摘掉');
    assert.equal(msg.usage.videoTokens, 127766);
    assert.deepEqual(msg.timings, { prepareMs: 120, uploadMs: 27400, ttftMs: 26100, generateMs: 12900, totalMs: 66400 });
    assert.equal(s.busy, false);
    assert.equal(s.error, null);
});

test('收尾:没有 usage 时**不加** usage 这个键(与从前那条规矩一致)', () => {
    let s = staged();
    s = finishVideoStages(s, { ok: true, text: '答案' });
    assert.equal('usage' in s.messages[1], false);
    assert.equal('timings' in s.messages[1], false);
});

test('失败:红在**具体那一段**,它后面的行摘掉(没发生过的行不许打勾)', () => {
    let s = staged();
    s = applyVideoProgress(s, { stage: 'prepared', mode: 'upload', totalBytes: 177737264 });
    s = applyVideoProgress(s, { stage: 'uploading', percent: 12, totalBytes: 177737264 });
    s = applyVideoProgress(s, { stage: 'waiting' });
    s = applyVideoProgress(s, { stage: 'generating', chars: 3, chunks: 1, delta: '红块在' });
    s = finishVideoStages(s, { ok: false, reason: '服务端出错(HTTP 503)', failedStage: 'generate' });
    const rows = s.messages[1].stages;
    assert.deepEqual(rows.map(r => [r.key, r.state]), [
        ['prepare', 'done'], ['upload', 'done'], ['wait', 'done'], ['generate', 'failed'],
    ]);
    assert.equal(s.error.stage, 'generate');
    assert.equal(s.busy, false);
    assert.equal(s.messages[1].text, '红块在', '已经收到的正文留在那儿(它不是假的)');
});

test('失败在上传那一段时:后面还没发生的行**一行都不留**', () => {
    let s = staged();
    s = applyVideoProgress(s, { stage: 'prepared', mode: 'upload', totalBytes: 177737264 });
    s = applyVideoProgress(s, { stage: 'uploading', percent: 12, totalBytes: 177737264 });
    s = finishVideoStages(s, { ok: false, reason: '临时上传失败(HTTP 403)', failedStage: 'upload' });
    assert.deepEqual(s.messages[1].stages.map(r => [r.key, r.state]), [['prepare', 'done'], ['upload', 'failed']]);
});

test('取消:不留那条占位(它不是失败,也不该像一条回答)', () => {
    let s = staged();
    s = applyVideoProgress(s, { stage: 'prepared', mode: 'upload', totalBytes: 177737264 });
    s = finishVideoStages(s, { ok: false, reason: '这次理解已被取消', failedStage: '' });
    assert.equal(s.messages.length, 1, '只剩用户那条');
    assert.equal(s.messages.filter(m => m.role === 'assistant').length, 0);
    assert.equal(s.busy, false);
});

test('不在视频那一轮时,迟到的进度事件一个字都不许改', () => {
    const plain = beginPrompt(initialStreamState(), '普通提问');
    assert.equal(applyVideoProgress(plain, { stage: 'uploading', percent: 50 }), plain);
    // 收尾之后(stages 已摘)推来的回声同理
    let s = staged();
    s = finishVideoStages(s, { ok: true, text: '答案' });
    assert.equal(applyVideoProgress(s, { stage: 'generating', chars: 9, delta: 'x' }), s);
});

test('对端给的脏数据收敛成合法状态,不抛也不编读数', () => {
    let s = staged();
    s = applyVideoProgress(s, { stage: 'uploading', percent: 999, totalBytes: 'x' });
    assert.equal(s.messages[1].stages[1].percent, 100, '百分比夹在 0..100');
    assert.equal(s.messages[1].stages[1].bytes, null);
    s = applyVideoProgress(s, { stage: '不认识的阶段' });
    assert.deepEqual(s.messages[1].stages.map(r => r.key), ['prepare', 'upload']);
    s = applyVideoProgress(s, null);
    assert.equal(Array.isArray(s.messages[1].stages), true);
});

test('读数行那句话:每个数字都来自真读数,没有就不写', () => {
    assert.equal(stageDetailText({ key: 'upload', state: 'doing', percent: 37 }), '已交给连接 37%');
    assert.equal(stageDetailText({ key: 'upload', state: 'doing', percent: null }), '', '没报过百分比就什么都不说');
    assert.equal(stageDetailText({ key: 'wait', state: 'doing' }, { waitSeconds: 12.34 }), '已等待 12.3 秒');
    assert.equal(stageDetailText({ key: 'wait', state: 'doing' }), '', '没有本地计时就不写秒数');
    assert.equal(stageDetailText({ key: 'wait', state: 'done' }, { waitSeconds: 12.34 }), '', '收尾后不再显示中间读数');
    assert.equal(stageDetailText({ key: 'generate', state: 'doing', chars: 210 }), '已生成 210 字');
    assert.equal(stageDetailText({ key: 'generate', state: 'doing', chars: 0 }), '正在生成…');
    assert.equal(stageDetailText({ key: 'generate', state: 'done', chars: 210 }), '');
    assert.equal(stageDetailText({ key: 'upload', state: 'failed' }), '在这里断了');
    // 绝不出现"还剩 X 秒"这类倒计时
    assert.equal(/还剩/.test(stageDetailText({ key: 'wait', state: 'doing' }, { waitSeconds: 3 })), false);
});

test('上传那一行的标签带上真实体积(那一段是最长的之一,看不出多长不行)', () => {
    const row = { key: 'upload', label: '上传到服务端', bytes: 177737264 };
    assert.equal(videoStageLabel(row, (b) => `${(b / 1048576).toFixed(1)} MB`), '上传 169.5 MB 到服务端');
    assert.equal(videoStageLabel({ key: 'upload' }, () => 'x'), '上传到服务端');
    assert.equal(videoStageLabel({ key: 'prepare' }), '准备请求');
});

test('失败码 → 哪一段红了:准入/鉴权类是准备,凭证/上传类是上传,对话类**不猜**', () => {
    assert.equal(failedVideoStage('missing_key'), 'prepare');
    assert.equal(failedVideoStage('auth_failed'), 'prepare', '密钥不对是配置问题,不是网络问题');
    assert.equal(failedVideoStage('too_large'), 'prepare');
    assert.equal(failedVideoStage('outside_folder'), 'prepare');
    assert.equal(failedVideoStage('policy_auth_failed'), 'upload', '取凭证是上传的第一步');
    assert.equal(failedVideoStage('upload_failed'), 'upload');
    // ⚠️ 上传**之后**那次对话失败不是上传失败(否则用户会一直在查网络)
    assert.equal(failedVideoStage('upload_chat_timeout'), '');
    assert.equal(failedVideoStage('timeout'), '', '代码本身指不出是哪一段');
    assert.equal(failedVideoStage('cancelled'), '');
    // 兜底判据:界面自己知道走到哪了
    assert.equal(lastActiveStage([{ key: 'prepare', state: 'done' }, { key: 'upload', state: 'doing' }]), 'upload');
    assert.equal(lastActiveStage([{ key: 'prepare', state: 'done' }]), 'prepare');
    assert.equal(lastActiveStage([]), '');
    assert.equal(lastActiveStage(null), '');
});

test('首字估计:区间 + 样本出处(同一个文件两次实测差了近 3 倍,单点数字会误导)', () => {
    const cal = FIRST_TOKEN_CALIBRATION;
    // 出处的两件事必须在发出去的常量里:样本条数、以及"哪一条是倒推的"
    assert.equal(cal.samples.length, 2);
    assert.equal(cal.samples.filter(s => s.kind === 'stream').length, 1, '一次直接测量');
    assert.equal(cal.samples.filter(s => s.kind === 'derived').length, 1, '一次倒推(必须标明是倒推)');
    assert.match(cal.samples.find(s => s.kind === 'stream').note, /流式实跑/);
    assert.match(cal.samples.find(s => s.kind === 'derived').note, /倒推值/);
    assert.match(cal.samples.find(s => s.kind === 'derived').note, /不是直接测量/);

    const est = estimateFirstTokenMs({ byteLength: cal.bytes, mode: 'upload' });
    assert.equal(est.ok, true);
    assert.equal(est.lowMs, 11700);
    assert.equal(est.highMs, 34108);
    assert.equal(est.samples, 2);
    // 跨度 2.9 倍 ≥ coarseSpread:给的是**量级**,不是"约 X 秒"
    assert.equal(est.text, '通常十几秒到半分钟');
    assert.equal(/约 \d+ 秒/.test(est.text), false, '方差大的时候不许给单点/近似数字');
    // 但区间与出处仍然拿得到(测试与将来的收窄都用得上)
    assert.match(est.title, /实测 34\.1s/);
    assert.match(est.title, /倒推 11\.7s/);
    assert.match(est.title, /2 个样本/);
    assert.match(est.note, /2026-10-05|2026-09-19/);
});

test('首字估计的判据(注入标定值来验):区间取整到秒、跨度小才给数字、样本坏掉就不给', () => {
    const base = { bytes: 177737264, mode: 'upload', band: 0.4, coarseSpread: 2.5 };
    // 跨度小 → 给数字区间;而且**取整到秒**(12.3–13.7 那种"精确"是假的)
    const tight = estimateFirstTokenFrom({
        calibration: { ...base, samples: [{ ms: 12300, kind: 'stream' }, { ms: 13700, kind: 'stream' }] },
        byteLength: base.bytes, mode: 'upload',
    });
    assert.equal(tight.text, '实测约 12–14 秒');
    // 单样本(只量过一次)→ 也走区间形状,两端相等
    const single = estimateFirstTokenFrom({
        calibration: { ...base, samples: [{ ms: 34108, kind: 'stream' }] },
        byteLength: base.bytes, mode: 'upload',
    });
    assert.equal(single.text, '实测约 34–34 秒');
    assert.equal(single.samples, 1);
    // 跨度 ≥ 2.5 倍 → 只说量级
    const wide = estimateFirstTokenFrom({
        calibration: { ...base, samples: [{ ms: 10000, kind: 'stream' }, { ms: 25000, kind: 'stream' }] },
        byteLength: base.bytes, mode: 'upload',
    });
    assert.equal(wide.text, '通常十几秒到半分钟');
    assert.equal(wide.lowMs, 10000);
    assert.equal(wide.highMs, 25000);
    // 坏样本要被丢掉(不许把区间拉歪),全坏 = 没量到
    const mixed = estimateFirstTokenFrom({
        calibration: { ...base, samples: [{ ms: 20000 }, { ms: -5 }, { ms: Number.NaN }, null, {}] },
        byteLength: base.bytes, mode: 'upload',
    });
    assert.equal(mixed.samples, 1);
    assert.equal(mixed.lowMs, 20000);
    // 认不出 kind 的样本按"倒推"算(更保守:倒推值不该被当成实测值展示)
    assert.match(mixed.title, /倒推 20\.0s/);
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [] }, byteLength: base.bytes, mode: 'upload' }).ok, false);
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [{ ms: 0 }] }, byteLength: base.bytes, mode: 'upload' }).ok, false);
    // 另一条路不给:内联实测只有几秒,不需要估,也没有标定
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [{ ms: 30000 }] }, byteLength: base.bytes, mode: 'inline' }).ok, false);
    // 体积不明 / 离标定点太远不给
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [{ ms: 30000 }] }, mode: 'upload' }).ok, false);
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [{ ms: 30000 }] }, byteLength: -1, mode: 'upload' }).ok, false);
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [{ ms: 30000 }] }, byteLength: 400 * 1048576, mode: 'upload' }).ok, false);
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [{ ms: 30000 }] }, byteLength: 10 * 1048576, mode: 'upload' }).ok, false);
    // 边界:±40% 之内给,之外不给
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [{ ms: 30000 }] }, byteLength: Math.floor(base.bytes * 1.39), mode: 'upload' }).ok, true);
    assert.equal(estimateFirstTokenFrom({ calibration: { ...base, samples: [{ ms: 30000 }] }, byteLength: Math.floor(base.bytes * 1.41), mode: 'upload' }).ok, false);
});