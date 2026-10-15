// Agent 事件流的状态归约。**纯函数** —— 放 app/lib 是为了能用 node --test 直跑。
//
// 这个模块只做一件事:把主进程推来的 agent:event(见 M3-B 计划里的冻结契约)
// 折成一个**全是叶子字段**的状态对象。约束是硬的:state 必须能 JSON.stringify,
// 里面不许出现任何活对象(DOM 节点、EventEmitter、子进程……)。
// 面板(agent/panel.js)只负责把这个状态画出来,不做任何协议判断 ——
// 协议的形状变化全在这一个文件里收口。
//
// 另一个必须记住的点:**这里的所有字符串都来自对端**(Agent / 插件),
// 一律当纯文本。归约阶段原样保留,渲染阶段一律走 textContent。

/** 笔记正文送进提示词的上限(UTF-16 码元)。超出要**明说**被截断了。 */
export const MAX_NOTE_CHARS = 8000;

const DEFAULT_STATUS = Object.freeze({
    state: 'stopped', pid: null, error: null, restarts: 0, since: null,
});

/** 初始状态。字段与契约一致,一条不多一条不少。 */
export function initialStreamState() {
    return {
        status: { ...DEFAULT_STATUS },
        sessionId: null,
        // 会话的模型 / 思考强度这些配置项(session/new 返回的 configOptions)。
        // M3-B 只**留住**它(界面渲染推到 M4):交接表里这一条不能安静地跳过。
        configOptions: [],
        // 对端广告的能力(initialize 的 promptCapabilities)。null = 还不知道(旧外壳/替身),
        // 界面只在**明确 false** 时拒绝发图 —— "还不知道"不等于"不支持"。
        caps: null,
        busy: false,
        messages: [],
        thoughts: [],
        tools: [],
        // 有序时间线:三类条目**真实到达的先后**(键带前缀:msg: / think: / tool:)。
        // 实体仍然留在上面三个数组里,这里只记顺序 —— 界面按它排布,才不会把思考
        // 永远堆在最顶、把工具卡排到**所有**消息前面。
        order: [],
        // 按需翻译的译文:thoughtId → { status, text, error }。
        // 模型偶尔仍会用英文思考,用户点「译」时由主进程请桥翻一次,结果落在这里。
        translations: {},
        permissions: [],
        usage: null,
        error: null,
        // 「启动时自动建会话」那一步的失败原因(null = 没失败过 / 会话已经建好了)。
        // 为什么单独一条、不复用 error:它发生时**一轮对话都还没有**,没有哪一轮可以挂它;
        // 而 error 那条会被 prompt-end 清掉、又会被"下一轮开始"覆盖 —— 两者生命周期不同。
        sessionError: null,
    };
}

// ---------- 取值助手:对端给什么都不许让归约抛错 ----------

function asString(v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return '';
    return String(v);
}

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

function trimmed(v) {
    return asString(v).trim();
}

function pickString(...vals) {
    for (const v of vals) {
        const s = trimmed(v);
        if (s !== '') return s;
    }
    return '';
}

function pickNumber(...vals) {
    for (const v of vals) {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return 0;
}

/** 归一化进程状态:叶子字段 + 稳定键集(pid/error 允许是 null,不能用默认值填)。 */
function normalizeStatus(raw) {
    const src = (raw !== null && typeof raw === 'object') ? raw : {};
    return {
        state: pickString(src.state) || DEFAULT_STATUS.state,
        pid: (typeof src.pid === 'number' || src.pid === null) ? src.pid : null,
        error: (src.error === null || src.error === undefined || src.error === '')
            ? null : asString(src.error),
        restarts: pickNumber(src.restarts),
        since: (typeof src.since === 'number' || src.since === null) ? src.since : null,
    };
}

/** 归一化"对端广告的能力":只留三个布尔叶子(别的字段一律丢掉,状态里不许有任意结构)。 */
function normalizeCaps(raw) {
    const src = (raw !== null && typeof raw === 'object') ? raw : {};
    return {
        image: src.image === true,
        audio: src.audio === true,
        embeddedContext: src.embeddedContext === true,
    };
}

// ---------- ACP session/update 的取值 ----------

/**
 * 从 ACP 的 update 里取文本。content 可能是:
 *   { type:'text', text }、裸字符串、或者一**数组** block(ACP 允许)。
 * 任何别的形状都当空文本,绝不抛。
 */
function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(extractText).join('');
    if (content !== null && typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
        if (content.content !== undefined) return extractText(content.content);
    }
    return '';
}

function hasContent(c) {
    return c !== null && c !== undefined && c !== '';
}

/**
 * 追加一个时间线条目(同一个键不再追加第二次)。
 *
 * ⚠️ 键必须带前缀:`msg:` / `think:` / `tool:`。三类 id 来自不同地方(自己编号的
 * m-N / t-N,以及对端给的任意 toolCallId),不加前缀就可能撞在一起 —— 而撞了的
 * 表现是"有一条内容在界面上消失":静默、难查。
 * `asArray` 兜住手工构造的状态字面量(没有 order 字段时当成空时间线)。
 */
function withOrder(state, key) {
    const order = asArray(state.order);
    if (order.includes(key)) return state;
    return { ...state, order: [...order, key] };
}

/**
 * 归一化一条消息里的图片(叶子字段)。
 *
 * 这些图片是**用户自己发出去**的那几张:面板在发送的那一刻把缩略图的 blob: URL
 * 移交给气泡(见 app/agent/panel.js 的 handOffImages —— URL 的**归属**在那里写清),
 * 所以这里只留三样可以 JSON.stringify 的叶子:`url` / `mimeType` / `name`。
 *
 * ⚠️ 认不出来的条目(不是对象、没有 url)一律丢掉:留着只会让界面画一个空 src 的
 * img(浏览器会拿它当"当前页面"去请求一次)。
 */
function normalizeMessageImages(raw) {
    return asArray(raw).map((img) => {
        const src = (img !== null && typeof img === 'object') ? img : {};
        return {
            url: asString(src.url),
            mimeType: asString(src.mimeType),
            name: asString(src.name),
        };
    }).filter(img => img.url !== '');
}

function pushMessage(state, { role, text, done, images, video, usage, stages }) {
    const messages = state.messages.slice();
    const id = `m-${messages.length + 1}`;
    const message = {
        id,
        role,
        text: asString(text),
        done: Boolean(done),
    };
    // ⚠️ 只有**真的带了图**才加 `images` 这个键。没有图的消息形状必须与从前逐字段
    // 一致 —— 多一个空数组就是改了既有契约(状态快照、旧用例、自检夹具都按现在
    // 这个字段集读它)。"没有图"也包含"给了图但每条都没 url"。
    const shown = normalizeMessageImages(images);
    if (shown.length > 0) message.images = shown;
    // 视频理解那两条消息(用户递进来的那段 + 助手的理解结果)多两个键。
    // 同样是"有才加":纯文字/纯图片的消息形状一个字节都不变。
    const clip = normalizeMessageVideo(video);
    if (clip !== null) message.video = clip;
    const stats = normalizeMessageUsage(usage);
    if (stats !== null) message.usage = stats;
    // 方案 C 的四段状态行。同样"有才加",而且**收尾时会摘掉**
    // (见 finishVideoStages)—— 收尾后的消息形状必须与从前逐字段一致。
    const rows = normalizeStages(stages);
    if (rows.length > 0) message.stages = rows;
    messages.push(message);
    return withOrder({ ...state, messages }, `msg:${id}`);
}

/**
 * 一条消息上挂的"这段视频是什么"(叶子字段)。
 *
 * 与图片不同,这里**没有 blob: URL** —— 视频字节只在渲染进程手里过一趟 IPC,
 * 不会回显成播放器:64 MiB 的视频做成 <video> 元素既拖慢面板,又要在重画时
 * 反复处理 URL 归属。所以这里只留"叫什么、多大、什么容器"三样,气泡里画一张卡。
 */
function normalizeMessageVideo(raw) {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = asString(raw.name).trim();
    if (name === '') return null;
    const bytes = Number(raw.byteLength);
    return {
        name,
        mimeType: asString(raw.mimeType),
        byteLength: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0,
    };
}

/**
 * 一次视频理解的用量读数(叶子字段)。
 *
 * 为什么单独存它:`prompt_tokens_details.video_tokens` 是这条链路上**唯一**能拿到的
 * 成本读数(实测 1080p 4 秒 = 2378,320×240 = 322,对像素面积次线性)。不显示它,
 * 用户对"这一下花了多少"就完全没有概念。
 */
function normalizeMessageUsage(raw) {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0);
    const out = {
        videoTokens: num(raw.videoTokens),
        promptTokens: num(raw.promptTokens),
        completionTokens: num(raw.completionTokens),
        model: asString(raw.model),
        mode: asString(raw.mode),
    };
    if (out.videoTokens === 0 && out.promptTokens === 0 && out.completionTokens === 0) return null;
    return out;
}

/**
 * 把最后一条思考收尾(等价于"这段思考想完了")。
 *
 * 谁调它:正文一到(说明想完了)、提示收尾、提示失败 —— 三种都是"思考阶段结束"。
 * 界面据此把思考块从「思考中…」收起成「已思考」,并把展开状态复位。
 */
function finishThoughts(state) {
    const thoughts = state.thoughts.slice();
    const last = thoughts[thoughts.length - 1];
    if (last === undefined || last.done === true) return state;   // 没有在飞的思考
    thoughts[thoughts.length - 1] = { ...last, done: true };
    return { ...state, thoughts };
}

/** 把最后一条 assistant 气泡收尾(等价于"当前正在流式的那一条")。 */
function finishAssistant(state) {
    const messages = state.messages.slice();
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            if (messages[i].done === true) return state;      // 已经收过尾,别重复造新对象
            messages[i] = { ...messages[i], done: true };
            return { ...state, messages };
        }
    }
    return state;
}

/**
 * 归一化 session/new(或 set_config_option)返回的 configOptions(模型 / 思考强度……)。
 *
 * 为什么不让它原样进状态:它是对端给的任意结构,而状态的不变量是"全是叶子字段、
 * 可 JSON.stringify";没有 id 的项直接丢掉(它连"改哪一个"都说不出来)。
 *
 * ⚠️ 形状要说清(options 有两种):模型那条是**分组的**
 *    `[{group,name,options:[{value,name,description}]}]`,思考强度那条是**平表**。
 *    这里两种都收下,而且**分组结构原样留着**(界面画清单要它),
 *    同时把叶子摊平成一份 `options`(找"当前这项叫什么"用) —— 摊平只在归一化时做一次。
 * ⚠️ `value` 是不透明串,原样留着(空串 = Provider default,合法,不许当空值丢掉)。
 */
function normalizeConfigOptions(raw) {
    return asArray(raw).map((o) => {
        const src = (o !== null && typeof o === 'object') ? o : {};
        const leaf = (l) => {
            const op = (l !== null && l !== undefined && typeof l === 'object') ? l : {};
            const out = { value: trimmed(op.value), name: trimmed(op.name) };
            // "有才加":对端没给 description 就不加这个键(既有形状一个字节不变)
            const desc = trimmed(op.description);
            if (desc !== '') out.description = desc;
            return out;
        };
        const rawOptions = asArray(src.options);
        const groups = [];
        for (const item of rawOptions) {
            if (item === null || item === undefined || typeof item !== 'object') continue;
            if (Array.isArray(item.options)) {
                const leafs = item.options.filter((l) => l !== null && typeof l === 'object').map(leaf);
                if (leafs.length === 0) continue;
                groups.push({ group: trimmed(item.group), name: trimmed(item.name), options: leafs });
            }
        }
        const out = {
            id: trimmed(src.id),
            name: trimmed(src.name),
            currentValue: trimmed(src.currentValue),
            // 摊平的那一份:分组就摊平,平表原样(两种消费方各取所需)
            options: groups.length > 0 ? groups.flatMap((g) => g.options) : rawOptions.map(leaf),
        };
        const category = trimmed(src.category);
        const type = trimmed(src.type);
        if (category !== '') out.category = category;
        if (type !== '') out.type = type;
        if (groups.length > 0) out.groups = groups;
        return out;
    }).filter((o) => o.id !== '');
}

function normalizeUsage(raw) {
    const src = (raw !== null && typeof raw === 'object') ? raw : {};
    const has = (...v) => v.some(x => typeof x === 'number' && Number.isFinite(x));
    if (!has(src.inputTokens, src.outputTokens, src.totalTokens,
        src.input_tokens, src.output_tokens, src.total_tokens)) {
        return null;
    }
    return {
        inputTokens: pickNumber(src.inputTokens, src.input_tokens),
        outputTokens: pickNumber(src.outputTokens, src.output_tokens),
        totalTokens: pickNumber(src.totalTokens, src.total_tokens),
    };
}

// ---------- 主归约 ----------

/**
 * 折一个事件,返回**新的**状态(不改传入的 state)。
 * 未识别的事件原样返回 —— 将来 ACP 加字段时界面不该崩,也不该冒出半张卡片。
 * @param {object} state
 * @param {object} event
 * @returns {object}
 */
export function reduceAgentEvent(state, event) {
    const base = (state !== null && typeof state === 'object') ? state : initialStreamState();
    if (event === null || typeof event !== 'object') return base;

    switch (event.kind) {
    case 'state':
        return { ...base, status: normalizeStatus(event.status) };

    case 'session': {
        // configOptions 落进状态但不渲染(见 normalizeConfigOptions)。
        // ⚠️ 对端没带(`undefined`)时**保留上一次的**,不许冲成空数组——
        // 那会让界面在重开会话的那一瞬间把用户选的模型"忘了"。
        const configOptions = (event.configOptions === null || event.configOptions === undefined)
            ? base.configOptions
            : normalizeConfigOptions(event.configOptions);
        // caps:对端在 initialize 里广告的能力(promptCapabilities)。界面用它**在发图之前**
        // 拦住"这条连接不收图片",而不是让用户吃一句 -32602 的英文(实测踩到过)。
        // 与 configOptions 同一条规矩:没带就保留上一次的(重开会话那一瞬间不许忘)。
        const caps = (event.caps === null || event.caps === undefined)
            ? base.caps
            : normalizeCaps(event.caps);
        // 会话到了 → 上一次"自动建会话失败"的话立刻作废:它是**那一刻**的事实,
        // 不是这条连接的属性(留着它,胶囊会在会话明明可用时还说"建会话失败")。
        return {
            ...base, sessionId: trimmed(event.sessionId) || base.sessionId, configOptions, caps,
            sessionError: null,
        };
    }

    case 'session-error':
        // 启动时**自动建会话**这一步失败了(主进程只在这一条路上推它)。
        // ⚠️ 它发生时一轮对话都还没有,所以没有哪一轮可以挂"失败" —— 单独记一条叶子,
        //    面板把它接在胶囊那句"还没建会话"后面说出来(否则用户会以为"等等就有了",
        //    而实际上这一步已经失败,他手里唯一的出路是发一条消息再试一次)。
        return {
            ...base,
            sessionError: {
                message: trimmed(event.message) || '自动建会话失败(对端没有给出原因)',
            },
        };

    case 'caps': {
        // 连接能力的**单独**一路:重连(重新握手)之后界面要立刻把"已知能力"换成新的 ——
        // 否则它会拿旧值继续拦(实测:换到视觉模型、重连成功了,界面还在说"这条连接不收图片")。
        // `caps: null` 是合法的:**"还不知道"**(那是重连刚发生、新会话还没建的那一刻)。
        if (event.caps === undefined) return base;
        return { ...base, caps: event.caps === null ? null : normalizeCaps(event.caps) };
    }

    case 'config': {
        // set_config_option 的响应(configOptions 是整份新的)。
        // ⚠️ 与 session 那条同一套规矩:对端没带就保留上一次的。
        const configOptions = (event.configOptions === null || event.configOptions === undefined)
            ? base.configOptions
            : normalizeConfigOptions(event.configOptions);
        return { ...base, sessionId: trimmed(event.sessionId) || base.sessionId, configOptions };
    }

    case 'prompt-end':
        // ⚠️ 展开必须在**前**面:finishAssistant 返回的是**整份状态**,
        // 放后面会把上面刚设的 busy / error 一起盖回去(实测踩过)。
        // 思考也一并收尾:一轮结束时不该留一条永远停在「思考中…」的条目。
        return { ...finishAssistant(finishThoughts(base)), busy: false, error: null };

    case 'prompt-error':
        return {
            ...finishAssistant(finishThoughts(base)),
            busy: false,
            error: {
                message: trimmed(event.message) || '提示失败(对端没有给出原因)',
                missingCredential: event.missingCredential === true,
            },
        };

    case 'permission': {
        const requestId = trimmed(event.requestId);
        // 同一个 requestId 重复到达不许出两张卡 —— 对端重发是常态
        if (requestId === '' || base.permissions.some(p => p.requestId === requestId)) return base;
        const toolCall = (event.toolCall !== null && typeof event.toolCall === 'object')
            ? event.toolCall : {};
        const permissions = base.permissions.slice();
        permissions.push({
            requestId,
            title: trimmed(toolCall.title) || trimmed(toolCall.kind) || '工具请求权限',
            // 提问与授权走同一个 ACP 方法(桥用 toolCall.kind === 'question' 当暗号),
            // 界面据此换一种卡片画 —— 其余(去重、已决、恰好回答一次)完全共用。
            question: event.question === true,
            options: asArray(event.options).map(o => ({
                optionId: pickString(o?.optionId, o?.id),
                name: pickString(o?.name, o?.optionId, o?.id) || '允许',
                kind: pickString(o?.kind),
                // 提问的选项带一句取舍说明(桥给的非标准字段)。缺了就是空串。
                description: pickString(o?.description),
            })).filter(o => o.optionId !== ''),
            resolved: false,
            // 用户选了哪一个。空串 = 还没决定。非空即已决。
            decided: '',
        });
        return { ...base, permissions };
    }

    case 'update':
        return reduceUpdate(base, (event.update !== null && typeof event.update === 'object')
            ? event.update : {});

    case 'translation': {
        // 按需翻译的结果。按 thoughtId 记账,界面据此在思考条上显示
        // 译 / 翻译中… / 中文·原文 三种状态。
        const thoughtId = trimmed(event.thoughtId);
        if (thoughtId === '') return base;   // 对不上任何一条,收了也没用
        const raw = trimmed(event.status);
        // ⚠️ 只认这三个阶段,别的(将来对端新加的、或者脏数据)一律当**失败**收场:
        // 留一个永远转圈的「翻译中」是最糟的结局 —— 用户以为还在译,其实早就结束了。
        const status = raw === 'pending' ? 'pending' : (raw === 'done' ? 'done' : 'error');
        const translations = (base.translations !== null && typeof base.translations === 'object')
            ? base.translations : {};
        return {
            ...base,
            translations: {
                ...translations,
                [thoughtId]: {
                    status,
                    text: status === 'done' ? asString(event.text) : '',
                    error: status === 'error'
                        ? (trimmed(event.error) || '翻译失败(对端没有给出原因)') : '',
                },
            },
        };
    }

    default:
        return base;
    }
}

function reduceUpdate(state, update) {
    const kind = trimmed(update.sessionUpdate);

    // 对端**主动推**的配置变更(我们点完下拉之后,它也可能自己推一条)。
    // 与 set_config_option 的响应是两条路,收到哪条都要把状态刷成"对端说的那份"。
    if (kind === 'config_option_update') {
        const configOptions = normalizeConfigOptions(update.configOptions);
        if (configOptions.length === 0) return state;
        return { ...state, configOptions };
    }

    // ⚠️ 连续 chunk 必须**拼进同一条**气泡。早期写法是"每个 chunk 追一条消息",
    // 结果一条回复被拆成几十个气泡,而且 prompt-end 收尾时只标了最后一条。
    if (kind === 'agent_message_chunk') {
        const text = extractText(update.content);
        if (text === '') return state;
        const last = state.messages[state.messages.length - 1];
        // 正文一开始就说明**想完了**:先把思考收尾,界面据此把"思考中…"折起来
        const settled = finishThoughts(state);
        if (last !== undefined && last.role === 'assistant' && last.done !== true) {
            const messages = settled.messages.slice();
            messages[messages.length - 1] = { ...last, text: last.text + text };
            return { ...settled, messages };
        }
        return pushMessage(settled, { role: 'assistant', text, done: false });
    }

    if (kind === 'agent_thought_chunk') {
        const text = extractText(update.content);
        if (text === '') return state;
        const thoughts = state.thoughts.slice();
        const last = thoughts[thoughts.length - 1];
        // 与消息一样**拼进同一条**:一段思考可能来几百个增量,一条一条存会让
        // state 里堆几千个小对象,而界面每次增量都要重画全部条目(实测一段 300 字的
        // 思考就是 300 个节点)。思维链在这里是"一条在长的文本",不是"很多条"。
        if (last !== undefined && last.done !== true) {
            thoughts[thoughts.length - 1] = { ...last, text: last.text + text };
            return { ...state, thoughts };
        }
        const thought = { id: `t-${thoughts.length + 1}`, text, done: false };
        thoughts.push(thought);
        return withOrder({ ...state, thoughts }, `think:${thought.id}`);
    }

    // 工具卡片:tool_call 建卡、tool_call_update 按 id 改同一条(不许新建)
    if (kind === 'tool_call' || kind === 'tool_call_update') {
        const toolCallId = trimmed(update.toolCallId);
        if (toolCallId === '') return state;

        const fields = {
            title: pickString(
                typeof update.title === 'string' ? update.title : '',
                typeof update.rawInput?.title === 'string' ? update.rawInput.title : '',
            ),
            status: pickString(update.status),
            kind: pickString(update.kind),
        };

        const tools = state.tools.slice();
        const at = tools.findIndex(t => t.toolCallId === toolCallId);
        if (at === -1) {
            // ⚠️ 一次**新的**工具调用就是一个步骤边界:把还开着的思考收尾。
            // 不收的话,工具跑完之后那一段思考会**并回**上一条(它们本来是"一条在长的
            // 文本"),于是它在界面上被排到工具**前面** —— 而它其实是工具之后才发生的。
            // 位置不实,正是这次要修的那类毛病;一次工具更新不重复收尾(已经收过了)。
            const settled = finishThoughts(state);
            tools.push({
                toolCallId,
                title: fields.title || '工具调用',
                status: fields.status || 'pending',
                kind: fields.kind || 'other',
            });
            return withOrder({ ...settled, tools }, `tool:${toolCallId}`);
        }
        const prev = tools[at];
        tools[at] = {
            ...prev,
            title: fields.title || prev.title,
            status: fields.status || prev.status,
            kind: fields.kind || prev.kind,
        };
        return { ...state, tools };
    }

    if (kind === 'usage_update') {
        const usage = normalizeUsage(update);
        return usage === null ? state : { ...state, usage };
    }

    if (kind === 'user_message_chunk') {
        const text = extractText(update.content);
        if (text === '') return state;
        const last = state.messages[state.messages.length - 1];
        // 面板发提示时已经把用户那句话放上去了 —— 对端再回一份不许变成两个气泡
        if (last !== undefined && last.role === 'user' && last.text === text) return state;
        return pushMessage(state, { role: 'user', text, done: true });
    }

    return state;
}

// ---------- 供面板调用的两个动作(同样是纯函数,便于直测) ----------

/**
 * 用户点「发送」时把问题放上界面,并把 busy 立起来。
 * 提示真的发出去之前就显示,是为了"点了有反应";失败由 prompt-error 收尾。
 *
 * `images` 是**渲染层自己的缩略图**(`{url, mimeType, name}`,url 是 blob:),
 * 随消息一起留在状态里 —— 界面据此在用户气泡里把那几张图**回显**出来。
 * 它不需要再过一次 IPC:图本来就在渲染进程手里,只是从前没有挂到气泡上。
 *
 * 文字与图片**两样都空**才什么都不做(`beginPrompt(before, '  ')` 的老行为不变);
 * 只发图没写字是一次合法的提示(黏贴一张截图直接发送)。
 *
 * @param {object} state
 * @param {string} question
 * @param {Array<{url?:string, mimeType?:string, name?:string}>} [images]
 */
export function beginPrompt(state, question, images) {
    const base = (state !== null && typeof state === 'object') ? state : initialStreamState();
    const text = trimmed(question);
    const shown = normalizeMessageImages(images);
    if (text === '' && shown.length === 0) return base;
    return {
        ...pushMessage(base, { role: 'user', text, done: true, images: shown }),
        busy: true,
        error: null,
    };
}

/**
 * 视频理解:**开始**那一步的状态变化(纯函数,便于直测)。
 *
 * 与 `beginPrompt`(走 Agent 的那条路)分开,是因为这两件事在架构上完全不同:
 * 理解一段视频**不经过 ACP 会话** —— 它由主进程直接 POST 给 DashScope,与本机有没有
 * Agent、有没有 Vault、当前笔记是哪一篇都无关。硬塞进 beginPrompt 那个形状里,
 * 就得在消息上假装一次"提示",而那会让界面对"这一轮到底走哪条路"永远说不清。
 *
 * 界面上先放一条**用户消息**(带着视频卡片),这样用户看得见"我递了哪一段"。
 * 一段都没有时原样返回(调用方据此不发空请求)。
 *
 * @param {object} state
 * @param {{name?:string, mimeType?:string, byteLength?:number, question?:string}} input
 */
export function beginVideoPrompt(state, { name, mimeType, byteLength, question } = {}) {
    const base = (state !== null && typeof state === 'object') ? state : initialStreamState();
    const clip = normalizeMessageVideo({ name, mimeType, byteLength });
    if (clip === null) return base;
    const asked = trimmed(question);
    // 没写字就用一句明确的说明,不留空气泡 —— 与"只发图片"那条同一个处理。
    const shown = asked !== '' ? asked : `〔视频理解〕${clip.name}`;
    return {
        ...pushMessage(base, { role: 'user', text: shown, done: true, video: clip }),
        busy: true,
        error: null,
    };
}

// ---------- 方案 C:四段**真实**状态行 ----------
//
// 为什么值得单独做一套(而不是继续用一个转圈):实测那个 169.5 MB 的文件里,
// 用户要等 47–71 秒,而其中 **26–28 秒是上传、21–45 秒是模型思考**。一个转圈把
// 这两段画成同一个样子,用户唯一的结论是"卡住了"。四段行把"卡在哪"说清楚,
// 而且每一段都必须是**能观测到的真值**:
//
//   · 准备请求 —— 本地校验入参、解密钥、定 delivery。它是真的存在的一段(解密钥
//     不是零成本),而**大多数"理解失败"其实发生在这里**(类型不对/太大/没密钥)。
//     这一段红掉,用户才知道该改什么。
//   · 上传 —— 百分比 = **已经交给连接的字节数**(流式请求体每 pull 一块就加一次)。
//     服务端收了多少我们看不见,所以文案写"已交给连接",不写"已上传完成"。
//     内联那条路**没有这一行**:没有上传就没有上传进度,不许画一条 0% 的假行。
//   · 等待首个字 —— 服务端在这段里一个字节都不给,所以**只有"已等待 X 秒"是真实的**。
//     绝不做倒计时/百分比:那是纯编。估计值只在标定过的体积附近才给(见
//     `estimateFirstTokenMs`),宁可不显示,也不要编一个数。
//   · 生成正文 —— 真值 = **已经收到的正文字数**(SSE 每个增量累加)。
//     ⚠️ 绝不拿 max_tokens 当分母画进度条:模型什么时候停是它决定的,
//        按 max_tokens 画出来的条在真实情况下要么早满、要么永远不满,是假的。
//
// 事件形状(全是叶子字段,渲染进程只认这些):
//   {stage:'preparing'} / {stage:'prepared', mode, totalBytes}
//   {stage:'uploading', sentBytes, totalBytes, percent}
//   {stage:'waiting'} / {stage:'generating', chars, chunks}

/** 四段行的键。顺序就是显示顺序。 */
export const VIDEO_STAGE_KEYS = Object.freeze(['prepare', 'upload', 'wait', 'generate']);
/**
 * 行的文案。`upload` 那一行要带上体积(面板才拿得到 formatBytes),而且**两条路的说法不同**:
 *   · 上传那条:字节真的被送到了 OSS → 「上传 … 到服务端」;
 *   · 内联那条:没有上传这回事,是把请求体直接发给模型接口 → 「发送请求体(内联 …)」。
 * 说成同一样东西会让人以为内联也在传文件(那是两套完全不同的机制)。
 */
export const VIDEO_STAGE_LABELS = Object.freeze({
    prepare: '准备请求',
    upload: '上传到服务端',
    // 内联那条没有"上传":它只是把请求体(内含 base64)发出去
    inline: '发送请求体',
    wait: '等待模型返回第一个字',
    generate: '生成正文',
});

/** 一段行的合法状态。`doing` 正在做、`done` 做完了、`failed` 在这一段断了。 */
const STAGE_STATES = new Set(['idle', 'doing', 'done', 'failed']);

/** 把一段行收敛成叶子字段(对端/主进程给什么都不许让归约抛错)。 */
function normalizeStage(raw) {
    const src = (raw !== null && typeof raw === 'object') ? raw : {};
    const key = trimmed(src.key);
    if (key === '') return null;
    const percent = Number(src.percent);
    const bytes = Number(src.bytes);
    const chars = Number(src.chars);
    // ⚠️ `Number(null) === 0`:不显式排掉空值,"没报过百分比"会被读成"0%",
    // 界面上就是一根 0% 的进度条 —— 那正是"编出来的进度"。
    const numOrNull = (raw) => (raw === null || raw === undefined || raw === '' ? NaN : raw);
    return {
        key,
        label: trimmed(src.label) || VIDEO_STAGE_LABELS[key] || key,
        state: STAGE_STATES.has(trimmed(src.state)) ? trimmed(src.state) : 'idle',
        // 三个读数**各有各的单位**,分开存,合并成一个"progress"就会串味
        percent: Number.isFinite(Number(numOrNull(src.percent))) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
        bytes: Number.isFinite(Number(numOrNull(src.bytes))) && bytes > 0 ? Math.floor(bytes) : null,
        chars: Number.isFinite(Number(numOrNull(src.chars))) && chars > 0 ? Math.floor(chars) : null,
        // 走的是哪条路('inline' / 'upload'):只影响**文案**,不影响任何判据
        mode: trimmed(src.mode),
    };
}

function normalizeStages(raw) {
    return asArray(raw).map(normalizeStage).filter(s => s !== null);
}

/** 这条消息是不是"视频理解那四段行"的容器(收尾后 stages 会被摘掉)。 */
export function hasVideoStages(state) {
    const msgs = asArray(state?.messages);
    const last = msgs[msgs.length - 1];
    return last !== undefined && Array.isArray(last.stages) && last.stages.length > 0;
}

/**
 * 开始一段视频理解:**一条用户消息(带视频卡)+ 一条待完成的助手占位**。
 *
 * 为什么要占位(而不是等结果出来再 push 一条助手消息):方案 C 要求正文**在同一
 * 个气泡里**从状态行变成流水文本。占位的 id 固定,后面每一次增量都改这一条,
 * 界面上那个气泡自始至终是同一个节点。失败时占位会被**整条摘掉**(见
 * `finishVideoStages`)—— 失败不许在消息流里留一条像模型回答的空壳。
 */
export function beginVideoStages(state, { name, mimeType, byteLength, question } = {}) {
    const withUser = beginVideoPrompt(state, { name, mimeType, byteLength, question });
    const msgs = asArray(withUser.messages);
    // beginVideoPrompt 原样返回 = 视频信息不全,这一轮不该发(调用方据此不发)
    if (msgs.length === 0) return withUser;
    const started = pushMessage(withUser, {
        role: 'assistant',
        text: '',
        done: false,
        // 一上来只有"准备请求"是 doing:后面的行要等 provider 说了才出现 ——
        // 先把四行都摆出来会让用户在"内联"那条路上看着一条永远不动的"上传"行。
        stages: [{ key: 'prepare', label: VIDEO_STAGE_LABELS.prepare, state: 'doing' }],
    });
    return { ...started, busy: true, error: null };
}

/**
 * 一次进度事件落到状态上(纯函数)。**不在视频那一轮时原样返回** —— 迟到的推送
 * 不许改动别的消息。
 *
 * @param {object} state
 * @param {{stage?:string, mode?:string, totalBytes?:number, sentBytes?:number,
 *          percent?:number, chars?:number}} event
 */
export function applyVideoProgress(state, event) {
    const base = (state !== null && typeof state === 'object') ? state : initialStreamState();
    // ⚠️ 默认参数只挡 `undefined`:`null` 会一路走到 `event.stage` 上抛 TypeError。
    const evt = (event !== null && typeof event === 'object') ? event : {};
    if (hasVideoStages(base) !== true) return base;
    const at = base.messages.length - 1;
    const message = base.messages[at];
    const rows = normalizeStages(message.stages);
    const stage = trimmed(evt.stage);
    const setRow = (key, patch) => {
        const i = rows.findIndex(r => r.key === key);
        if (i === -1) {
            rows.push(normalizeStage({ key, label: VIDEO_STAGE_LABELS[key], ...patch }));
            return;
        }
        rows[i] = normalizeStage({ ...rows[i], ...patch });
    };
    /** 只改**已经存在**的行。用它来收尾前面那几段:没出现过的段不许凭空补一行出来。 */
    const patchRow = (key, patch) => {
        const i = rows.findIndex(r => r.key === key);
        if (i !== -1) rows[i] = normalizeStage({ ...rows[i], ...patch });
    };
    const dropRow = (key) => {
        const i = rows.findIndex(r => r.key === key);
        if (i !== -1) rows.splice(i, 1);
    };

    let text = message.text;
    if (stage === 'preparing') {
        setRow('prepare', { state: 'doing' });
    } else if (stage === 'prepared') {
        // delivery 定下来的那一刻才知道这一段走的是哪条路,但**两条路都有它**:
        //   · 上传:字节送到 OSS(「上传 … 到服务端」);
        //   · 内联:请求体直接发给模型接口(「发送请求体(内联 …)」)。
        // 内联原来**没有**这一行(整包发、字节数观测不到)—— 现在改成流式发,于是它有了
        // 真百分比,这一行也就该出现。mode 决定文案,判据本身两条路一样。
        const totalBytes = Number(evt.totalBytes);
        const mode = trimmed(evt.mode);
        setRow('prepare', { state: 'done' });
        setRow('upload', {
            state: 'doing',
            mode,
            bytes: Number.isFinite(totalBytes) && totalBytes > 0 ? Math.floor(totalBytes) : null,
        });
    } else if (stage === 'uploading') {
        patchRow('prepare', { state: 'done' });
        const total = Number(evt.totalBytes);
        const mode = trimmed(evt.mode);
        // ⚠️ 体积**只由 `prepared` 定**,这里不覆盖已经有的那个数:
        //   · 上传说的是**文件**大小(与 prepared 一致,覆盖了也一样);
        //   · 内联说的是**文件**大小(13.9 MiB,用户认得的就是它),而 `uploading` 的
        //     totalBytes 是**请求体**长度(base64 之后比文件大 1/3,18.5 MiB)。
        //     用它去改标签,文案会在发送途中从 13.9 MiB 跳到 18.5 MiB —— 同一个格子
        //     两个数,用户只会以为哪里出错了。百分比照旧按真实总长算(那是**进度**的口径)。
        const known = rows.find(r => r.key === 'upload')?.bytes ?? null;
        const keep = Number.isFinite(Number(known)) && Number(known) > 0 ? Number(known) : null;
        setRow('upload', {
            state: 'doing',
            ...(mode === '' ? {} : { mode }),
            bytes: keep ?? (Number.isFinite(total) && total > 0 ? Math.floor(total) : undefined),
            percent: Number(evt.percent),
        });
    } else if (stage === 'waiting') {
        patchRow('prepare', { state: 'done' });
        // 上传这一段到"服务端开始思考"就结束了:此时**全部字节都已经交出去**,
        // 所以 100% 是真的(而不是"服务端确认收完了" —— 那个我们看不见)。
        patchRow('upload', { state: 'done', percent: 100 });
        setRow('wait', { state: 'doing' });
    } else if (stage === 'generating') {
        patchRow('prepare', { state: 'done' });
        patchRow('upload', { state: 'done' });
        patchRow('wait', { state: 'done' });
        setRow('generate', { state: 'doing', chars: Number(evt.chars) });
        // 正文**边收边显示**:这就是流式的全部意义。切片本身就是文案,
        // 不做任何缓冲/节流 —— 那会让"已经收到"与"屏幕上"不一致。
        text = text + asString(evt.delta);
    } else {
        return base;
    }

    const messages = base.messages.slice();
    messages[at] = { ...message, stages: rows, text };
    return { ...base, messages };
}

/**
 * 视频理解**收尾**:成功就把占位那条**变成**最终回答(同一处,不另起一条);
 * 失败就把占位**整条摘掉**,只留 `error` 让面板说清为什么。
 *
 * @param {object} state
 * @param {{ok?:boolean, text?:string, reason?:string, usage?:object, delivery?:object,
 *          failedStage?:string}} input `failedStage` 是"哪一段红的"(见下),
 *          由调用方从失败码映射过来 —— 归约层不认识业务码。
 */
export function finishVideoStages(state, { ok, text, reason, usage, delivery, failedStage } = {}) {
    const base = (state !== null && typeof state === 'object') ? state : initialStreamState();
    const staged = hasVideoStages(base);
    // 失败:先决定"红在哪一段",再摘掉占位。
    if (ok !== true) {
        const message = trimmed(reason) || '视频理解失败(没有给出原因)';
        const failed = trimmed(failedStage);
        if (staged !== true || failed === '') {
            return { ...dropStagedPlaceholder(base), busy: false, error: { message, missingCredential: false } };
        }
        // 红在那一段上,占位**留下来**:用户看到的是一份"走到哪一步断的"清单,
        // 而不是一句从天上掉下来的"理解失败"。占位这时算收尾(done=true),
        // 因为它的内容不会再变了。
        const at = base.messages.length - 1;
        const messages = base.messages.slice();
        const all = normalizeStages(messages[at].stages);
        // ⚠️ 失败那一段**后面**的行一律摘掉:它们根本没发生过。把没发生的行标成
        // 打勾是另一种形式的编 —— 用户会以为"上传完了、也等到首字了,是生成挂了",
        // 而真实情况可能是上传就断了。
        const rows = [];
        let hit = false;
        for (const row of all) {
            if (row.key === failed) {
                rows.push({ ...row, state: 'failed' });
                hit = true;
                break;
            }
            rows.push(row.state === 'doing' ? { ...row, state: 'done' } : row);
        }
        if (hit !== true) rows.push(normalizeStage({ key: failed, label: VIDEO_STAGE_LABELS[failed], state: 'failed' }));
        messages[at] = { ...messages[at], stages: rows, done: true };
        return {
            ...base,
            messages,
            busy: false,
            error: { message, missingCredential: false, stage: failed },
        };
    }
    const body = trimmed(text);
    if (body === '') {
        return {
            ...dropStagedPlaceholder(base),
            busy: false,
            error: { message: '理解结果为空(服务端没有给出正文)', missingCredential: false },
        };
    }
    const stats = {
        videoTokens: usage?.videoTokens,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        model: usage?.model,
        mode: delivery?.mode,
    };
    // 三段耗时与字数一起进读数行:这是**自标定**的入口 —— 每次真实运行都留下
    // 自己的 upload/首字/生成读数,标定值才不会随服务端变化而悄悄失真。
    const timings = normalizeTimings(delivery?.timings);
    if (staged !== true) {
        // 没有占位(理论上到不了这里):照老路补一条助手消息,绝不丢结果。
        return {
            ...pushMessage(base, { role: 'assistant', text: body, done: true, usage: stats }),
            busy: false,
            error: null,
        };
    }
    const at = base.messages.length - 1;
    const messages = base.messages.slice();
    const finished = { ...messages[at], text: body, done: true };
    // stages 摘掉:收尾后的消息形状必须与从前**逐字段一致**(旧用例/自检/快照
    // 都按那个字段集读它)。四段行走完了就该消失,留在那儿是历史噪音。
    delete finished.stages;
    // ⚠️ 走**同一个** normalizeMessageUsage:它负责把 undefined 收敛成 0,并在
    // 一个读数都没有时返回 null —— 那时这个键**不加**(与 pushMessage 同一条规矩)。
    const normalized = normalizeMessageUsage(stats);
    if (normalized === null) delete finished.usage;
    else finished.usage = normalized;
    if (timings !== null) finished.timings = timings;
    messages[at] = finished;
    return { ...base, messages, busy: false, error: null };
}

/** 摘掉末尾那条"待完成的助手占位"(没有就原样返回)。 */
function dropStagedPlaceholder(state) {
    const msgs = asArray(state?.messages);
    const last = msgs[msgs.length - 1];
    if (last === undefined || last.role !== 'assistant' || last.done === true) return state;
    return { ...state, messages: msgs.slice(0, -1) };
}

/**
 * 三段耗时收敛成叶子数字(毫秒)。一个都没有时返回 null —— 不许写一行空的读数。
 */
function normalizeTimings(raw) {
    if (raw === null || raw === undefined || typeof raw !== 'object') return null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
    const out = {
        prepareMs: num(raw.prepareMs),
        uploadMs: num(raw.uploadMs),
        ttftMs: num(raw.ttftMs),
        generateMs: num(raw.generateMs),
        totalMs: num(raw.totalMs),
    };
    if (Object.values(out).every(v => v === null)) return null;
    return out;
}

/**
 * 「等待首个字」这一段有多长 —— **实测样本**(不是常数)。
 *
 * ⚠️ 为什么是**样本 + 区间**,而不是一个数:同一个文件、同一个模型、同样是
 * 127,766 个 video token,两次真实运行的"上传之后到首字"差了约 **3 倍**
 * (34.1 s vs 倒推 ≈11.7 s)。首字等待里含着服务端的排队/prefill 调度,单点样本
 * 填出来的"约 34 秒"会把人带偏 —— 所以这里存**全部样本**,由
 * `estimateFirstTokenFrom` 折算成区间;样本之间差得太多时,界面连区间数字都不给,
 * 只说"通常十几秒到半分钟"。这条与"没标定就不显示"是同一条原则:**宁可粗糙,
 * 也不要假装精确**。
 *
 * 两个样本的出处(samples 里逐条写着,谁都能复核):
 *   ① `kind:'stream'` —— **直接测量**。2026-10-05 用本仓库
 *      `electron/video/dashscope.js` 的 `understandFromPath` 跑
 *      `D:\project\bilidown\download\中国人能飞😭 [高清 1080P60] NA.mp4`
 *      (177,737,264 字节 = 169.5 MB,`uploadBody='stream'`):
 *      取凭证 0.21s → 上传 24.05s → **首字 34.11s** → 生成 10.88s,总 69.25s,
 *      794 片 / 1271 字,`video_tokens=127,766`。四段相加与 `totalMs` 逐毫秒吻合。
 *   ② `kind:'derived'` —— **倒推,不是实测**。2026-09-19 那次**整包**(非流式)
 *      运行:整轮对话 21.86s(含 1191 字生成的输出,`totalMs` 49.62s)。
 *      按 ① 的生成速度(1271 字 / 10.88s ≈ 117 字/s)折掉 1191 字的生成 ≈ 10.2s,
 *      余下 ≈ 11.7s 算作首字等待。**这一步有假设**(两次的生成速度一样),
 *      所以它只配当区间的一端,不能当结论。
 *
 * 规则:
 *   · 只在**同一条路(upload)**且体积落在标定点 ±40% 以内时才给估计;
 *   · 区间一律**取整到秒**(给到 0.1 秒就是假装精确);
 *   · 样本跨度 ≥ `coarseSpread` 倍时,只说量级(见 `estimateFirstTokenFrom`);
 *   · **永不倒计时** —— 倒计时到 0 而模型还没回,用户会以为坏了,比不说更糟。
 */
export const FIRST_TOKEN_CALIBRATION = Object.freeze({
    // 标定的**体积**与那两条路的样本都是真的;`samples` 里每条的 kind 说明它怎么来的。
    bytes: 177737264,
    mode: 'upload',
    band: 0.4,
    /** 样本跨到多少倍就不给"数字区间"的文案了(2.5 倍已经是"快慢差一大截")。 */
    coarseSpread: 2.5,
    samples: [
        {
            ms: 34108,
            kind: 'stream',
            note: '2026-10-05 流式实跑(169.5 MB):上传 24.05s → 首字 34.11s → 生成 10.88s,总 69.25s',
        },
        {
            ms: 11700,
            kind: 'derived',
            note: '2026-09-19 整包实跑的**倒推值**(不是直接测量):整轮对话 21.86s 减去按 117 字/s 折算的 1191 字生成 ≈10.2s',
        },
    ],
});

/** 样本里那些**能用**的读数(坏样本直接丢掉,不许把区间拉歪)。 */
function usableSamples(calibration) {
    return asArray(calibration?.samples)
        .map((s) => {
            const ms = Number(s?.ms);
            if (Number.isFinite(ms) !== true || ms <= 0) return null;
            return {
                ms,
                // 认不出 kind 的一律当"倒推"(更保守:倒推值不该被当成实测值展示)
                kind: trimmed(s?.kind) === 'stream' ? 'stream' : 'derived',
                note: trimmed(s?.note),
            };
        })
        .filter(s => s !== null);
}

/**
 * 估计的逻辑本身(**可注入标定值**,所以这段判据能被单测逐条钉住)。
 *
 * @param {{calibration?:object, byteLength?:number, mode?:string}} input
 * @returns {{ok:true, lowMs:number, highMs:number, text:string, title:string,
 *            samples:number, note:string}|{ok:false, reason:string}}
 */
export function estimateFirstTokenFrom({ calibration, byteLength, mode } = {}) {
    const cal = (calibration !== null && typeof calibration === 'object') ? calibration : FIRST_TOKEN_CALIBRATION;
    const samples = usableSamples(cal);
    if (samples.length === 0) {
        // 没量到就不给。这一条是整套设计的底线:"宁可不显示,不要编"。
        return { ok: false, reason: '首字那一段还没有被真正量到(先跑一次流式理解,读数行里就有它)' };
    }
    if (trimmed(mode) !== trimmed(cal.mode)) {
        return { ok: false, reason: '这条路没有标定过(内联那条实测只有几秒,不需要估计)' };
    }
    const bytes = Number(byteLength);
    if (Number.isFinite(bytes) !== true || bytes <= 0) return { ok: false, reason: '不知道这段视频多大,没法给估计' };
    const lo = cal.bytes * (1 - cal.band);
    const hi = cal.bytes * (1 + cal.band);
    if (bytes < lo || bytes > hi) {
        return { ok: false, reason: `这段的体积离标定点(${Math.round(cal.bytes / 1048576)} MB)太远,估计不可信` };
    }

    const lowMs = Math.min(...samples.map(s => s.ms));
    const highMs = Math.max(...samples.map(s => s.ms));
    // 取整到秒:12.3–34.1 这种"精确"是假的(样本只有两个)
    const lowSec = Math.max(1, Math.round(lowMs / 1000));
    const highSec = Math.max(lowSec, Math.round(highMs / 1000));
    const spread = highMs / lowMs;
    const coarseLimit = Number(cal.coarseSpread);
    const coarse = Number.isFinite(coarseLimit) && coarseLimit > 0 && spread >= coarseLimit;
    // 差得太多就**不给数字区间**:一个"12–34 秒"看着像测准了,实际只是两次样本的端点
    const text = coarse ? '通常十几秒到半分钟' : `实测约 ${lowSec}–${highSec} 秒`;
    const parts = samples.map(s => `${s.kind === 'stream' ? '实测' : '倒推'} ${(Math.round(s.ms / 100) / 10).toFixed(1)}s`);
    return {
        ok: true,
        lowMs,
        highMs,
        text,
        // 鼠标悬停能看到两个样本各自是什么 —— 粗话留给一眼扫过的人,出处留给要核对的人
        title: `${samples.length} 个样本:${parts.join(' / ')}(同一个文件与模型)`,
        samples: samples.length,
        note: samples.map(s => s.note).filter(n => n !== '').join(' | '),
    };
}

/** 用**发出去的那份**标定值估一次(界面走这条)。 */
export function estimateFirstTokenMs({ byteLength, mode } = {}) {
    return estimateFirstTokenFrom({ calibration: FIRST_TOKEN_CALIBRATION, byteLength, mode });
}

/**
 * 一段行**右边那行小字**说什么。纯函数,因为它就是"进度读数"的全部 ——
 * 三条规矩:
 *   1. 每个数字都必须来自一个真读数(percent / chars / 本地计时),没有就**不写**;
 *   2. 不写"大约还剩 X 秒"这类倒计时(只有等待那一段的本地计时是真的);
 *   3. 收尾之后(done)不再显示中间读数 —— 它已经过期了,留着只会让人重算一遍。
 *
 * @param {{key:string, state:string, percent?:number|null, chars?:number|null, bytes?:number|null}} stage
 * @param {{waitSeconds?:number|null}} [ctx] 等待那一段的本地计时(秒,面板给的)
 * @returns {string}
 */
export function stageDetailText(stage, { waitSeconds = null } = {}) {
    const key = trimmed(stage?.key);
    const state = trimmed(stage?.state);
    if (state === 'done') return '';
    if (state === 'failed') return '在这里断了';
    // ⚠️ `Number(null) === 0`:不显式排掉空值,"没报过百分比"就会被写成"已交给连接 0%"
    // —— 那正是"编出来的进度"。
    const absent = (v) => v === null || v === undefined || v === '';
    const percent = absent(stage?.percent) ? NaN : Number(stage.percent);
    const chars = absent(stage?.chars) ? NaN : Number(stage.chars);
    if (key === 'prepare') return state === 'doing' ? '正在校验参数与密钥' : '';
    if (key === 'upload') {
        if (Number.isFinite(percent) !== true) return '';
        // 口径写清楚:是"已经交给连接",不是"服务端已经收完"(那个看不见)
        return `已交给连接 ${Math.round(percent)}%`;
    }
    if (key === 'wait') {
        const seconds = absent(waitSeconds) ? NaN : Number(waitSeconds);
        if (state !== 'doing' || Number.isFinite(seconds) !== true || seconds < 0) return '';
        // 只有一位小数:0.1 秒的精度对"还要等多久"没有任何意义
        return `已等待 ${(Math.round(seconds * 10) / 10).toFixed(1)} 秒`;
    }
    if (key === 'generate') {
        if (Number.isFinite(chars) === true && chars > 0) return `已生成 ${Math.floor(chars)} 字`;
        return state === 'doing' ? '正在生成…' : '';
    }
    return '';
}

/**
 * 一段行显示什么字。发送那一行要带上**真实体积**(面板把字节格式化后传进来):
 * "上传到服务端"看不出这一段有多长,而它恰恰是最长的一段之一(实测 27 秒)。
 *
 * ⚠️ 两条路的说法必须分开(由 `stage.mode` 决定):
 *   · 上传:字节真的送到了 OSS —— 「上传 169.5 MB 到服务端」;
 *   · 内联:没有上传,是把请求体(内含 base64)直接发给模型接口 ——
 *     「发送请求体(内联 13.9 MiB)」。说成"上传"会让人以为它在传文件。
 *
 * @param {{key:string, label?:string, bytes?:number|null, mode?:string}} stage
 * @param {(bytes:number)=>string} [formatBytes]
 */
export function videoStageLabel(stage, formatBytes) {
    const key = trimmed(stage?.key);
    const bytes = Number(stage?.bytes);
    const hasBytes = typeof formatBytes === 'function' && Number.isFinite(bytes) && bytes > 0;
    if (key === 'upload') {
        if (trimmed(stage?.mode) === 'inline') {
            return hasBytes ? `发送请求体(内联 ${formatBytes(bytes)})` : VIDEO_STAGE_LABELS.inline;
        }
        return hasBytes ? `上传 ${formatBytes(bytes)} 到服务端` : VIDEO_STAGE_LABELS.upload;
    }
    return trimmed(stage?.label) || VIDEO_STAGE_LABELS[key] || key;
}

/**
 * 失败码 → **哪一段红了**。
 *
 * 为什么要这一层映射:provider 的码是机器可读的,而"红在哪一行"是展示决定;
 * 两者混在一起,以后加一个码就会有人忘了加一条分支(于是又退回一句笼统的
 * "理解失败")。归约层不认识业务码,所以映射放在这里、由面板显式调用。
 *
 * ⚠️ 顺序很要紧:`upload_chat_*`(上传**之后**那次对话失败)也以 `upload_` 开头,
 * 但它**不是**上传失败 —— 把它算到上传那一段,用户会去反复检查网络,而真正的
 * 原因(模型侧 400/超时)在另一段。所以 `upload_chat*` 先判、返回空串,
 * 由面板按"已经走到哪一段"落到 `wait`/`generate`(见 `lastActiveStage`)。
 */
export function failedVideoStage(code) {
    const c = trimmed(code);
    if (c === '') return '';
    // 对话那一段的失败:指不出是哪一段,交给调用方按进度落点决定
    if (c.startsWith('upload_chat')) return '';
    if (c.startsWith('policy') || c.startsWith('upload')) return 'upload';
    // 准入与**配置类**的失败都发生在"准备请求"那一段:它们与网络无关,重试多少次
    // 都一样,红在准备那一行才指得对下一步(去配密钥 / 换更短的视频 / 换模型)。
    if (c === 'missing_key' || c === 'auth_failed' || c === 'model_not_found' || c === 'bad_model'
        || c === 'invalid_input' || c === 'not_a_video' || c === 'mime_mismatch'
        || c === 'too_large' || c === 'payload_too_large' || c === 'context_too_long'
        || c === 'outside_folder' || c === 'file_missing' || c === 'bad_extension'
        || c === 'not_absolute' || c === 'unknown_extension' || c === 'encrypt_failed'
        || c === 'provider_error' || c === 'ipc_error') {
        return 'prepare';
    }
    return '';
}

/**
 * 最后一段**正在做**的行 —— 失败时"红在哪一行"的兜底判据。
 *
 * 为什么需要它:超时/网络/服务端这些码本身不指向任何一段(同样的 `timeout` 可能
 * 发生在上传、也可能发生在等首字)。但**界面自己知道它走到哪了**:最后一条 doing
 * 的行就是断点。这比按码猜准得多,也不需要 provider 多报一个字段。
 *
 * @param {Array<object>} stages 或者一条消息(直接给它也行)
 */
export function lastActiveStage(stages) {
    const rows = asArray(Array.isArray(stages) ? stages : stages?.stages);
    let found = '';
    for (const row of rows) {
        const state = trimmed(row?.state);
        if (state === 'doing') found = trimmed(row?.key);
    }
    if (found !== '') return found;
    // 没有 doing 的行时(失败来得太快):取最后一条已经出现的行
    const last = rows[rows.length - 1];
    return trimmed(last?.key);
}


/**
 * 权限卡片已决。
 *
 * `optionId` 是**用户到底选了哪一个** —— 界面把它记在这里(`permissions[].decided`),
 * 因为"已决"是个布尔、说不出选的是哪一个。
 * ⚠️ 它现在只活在状态里:已决的卡整个不再渲染(产品要求"答完就删"),所以面板上**没有**
 *    `data-decided` 这个 DOM 锚点了 —— 别再去界面上找它。
 * 不传 optionId 时只标已决(兼容旧调用)。找不到(或已决)就原样返回。
 */
export function resolvePermission(state, requestId, optionId = '') {
    const base = (state !== null && typeof state === 'object') ? state : initialStreamState();
    const id = trimmed(requestId);
    const permissions = base.permissions.slice();
    const at = permissions.findIndex(p => p.requestId === id);
    if (at === -1 || permissions[at].resolved === true) return base;
    permissions[at] = {
        ...permissions[at],
        resolved: true,
        decided: trimmed(optionId),
    };
    return { ...base, permissions };
}

/** 该不该把凭证卡片亮出来(缺凭证的那条映射落点)。 */
export function needsCredentialAttention(state) {
    return state?.error?.missingCredential === true;
}

// ---------- 笔记上下文 → 提示词 ----------

/**
 * 把「当前笔记 + 用户问题」拼成一次提示。
 *
 * 规则(面板、自检夹具与主进程都按这一份):
 *  1. question 去掉首尾空白后必须是**非空** —— 空问题直接抛错,不许发一次空提示。
 *  2. 有笔记上下文时输出**纯文本**,形状固定:
 *       当前笔记:<path>          ← 第一行,字面就是这两个字加冒号,后面紧跟 path
 *       标题:<title>
 *       正文已截断               ← 只有真的截断时才出现这一行
 *       正文:
 *       <正文>
 *       (空行)
 *       问题:<用户的提问>
 *     没有笔记(未选 Vault、或没打开任何一篇)时**只发问题本身**:
 *     `当前笔记:` 这一行整体不出现,也不塞一段空洞的"正文:(空)"。
 *  3. 正文超过 MAX_NOTE_CHARS 就**截断**,并明确写一句「正文已截断」——
 *     不能让 Agent 以为这就是全文(那样它会基于半篇笔记下结论,而且不报错)。
 *  4. 正文只做换行归一(CRLF → LF):不做"折叠空白"那类清洗,那会改变代码块与缩进。
 *  5. 对端给的字符**一律原样保留**:`<img onerror=...>` 就是一行文字,不是元素。
 *  6. **只带图片、没写文字**也是合法的一次提示(黏贴截图直接发送)。这时问题那一行
 *     写成一句明确的说明,而不是留空 —— 空行会让模型以为用户问了个空问题。
 *     文字那一行在**有文字时逐字不变**(`问题:<原话>`),既有用例与自检照旧。
 *
 * @param {{noteTitle?:string, notePath?:string, noteText?:string, question?:string,
 *          imageCount?:number}} input
 * @returns {string}
 */
export function buildPromptText({ noteTitle, notePath, noteText, question, imageCount = 0 } = {}) {
    const q = trimmed(question);
    const images = Number.isFinite(imageCount) && imageCount > 0 ? Math.floor(imageCount) : 0;
    if (q === '' && images === 0) throw new Error('问题不能为空');
    // 只发图片时给一句占位,别让"问题:"后面是空的(那等于发了个空问题)。
    const asked = q === '' ? `(只发了 ${images} 张图片,没有文字)` : q;

    const title = trimmed(noteTitle);
    const notePathStr = trimmed(notePath);
    const body = asString(noteText).replace(/\r\n?/g, '\n').trim();
    const hasNote = body !== '' || title !== '' || notePathStr !== '';

    if (!hasNote) return asked;

    const truncated = body.length > MAX_NOTE_CHARS;
    const kept = truncated ? body.slice(0, MAX_NOTE_CHARS) : body;

    // ⚠️ 第一行的**字面形状**是契约:必须恰好以 `当前笔记:` 起始、紧跟笔记 path。
    // 自检的夹具用 --echo-prompt 把收到的提示原文回显出来,自检再断言消息流里
    // 出现了 `当前笔记:<当前那篇的 path>` —— 改措辞就断言不到了。
    // 没有打开的笔记时这一行**整体不出现**(上面已经提前返回)。
    const lines = [`当前笔记:${notePathStr}`, `标题:${title === '' ? '(未命名)' : title}`];
    if (truncated) lines.push('正文已截断');
    lines.push('正文:', kept === '' ? '(空)' : kept, '', `问题:${asked}`);

    return lines.join('\n');
}

// ---------- 输入框上那句"这次会带上哪篇笔记" ----------

/** 没有打开的笔记时那句话(输入框的 placeholder 与 title 都用它,一字不差)。 */
export const NO_NOTE_CONTEXT = '没有打开的笔记 —— 只发问题本身';

/** 按**码点**截断(不劈开代理对),超长补省略号。纯函数,单测钉着。 */
function truncateText(text, maxChars) {
    const chars = [...String(text ?? '')];
    const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 12;
    return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

/**
 * 把"这次会带上哪篇笔记"翻成输入框上的**两种**写法。纯函数(单测逐字钉着)。
 *
 * 为什么是输入框、而且是两个位置:那一行上的上下文文字与状态点都按用户要求删掉了,
 * 而这条信息不能丢 —— 它决定了"这次发送到底带不带上下文"。
 *   · `placeholder`:一眼看得见,所以它要**短**(笔记名过长就截断);
 *   · `title`:悬停看得见、且是完整的那一句(全名,不截断)。
 * 两处都用同一个纯函数的输出,免得"看得见的那句"和"悬停的那句"各说各话。
 *
 * 判据与 buildPromptText 的 `hasNote` **同一口径**(标题/路径/正文任一非空 = 带上了笔记):
 * 两处判岔了,就会出现"输入框说没带笔记、其实带上了"这种最误导人的界面。
 *
 * @param {unknown} note `{ title, path, text }`(缺失/非对象按"没有笔记"处理)
 * @param {{maxNameChars?:number}} [opts] placeholder 里笔记名最多几个字符(默认 12)
 * @returns {{bound:boolean, name:string, full:string, placeholder:string}}
 */
export function describeNoteContext(note, { maxNameChars = 12 } = {}) {
    const src = (note !== null && note !== undefined && typeof note === 'object') ? note : {};
    const title = trimmed(src.title);
    const notePath = trimmed(src.path);
    const body = asString(src.text).trim();
    if (title === '' && notePath === '' && body === '') {
        return { bound: false, name: '', full: NO_NOTE_CONTEXT, placeholder: NO_NOTE_CONTEXT };
    }
    // 有名字就用名字;只有路径就用路径;两样都空(只可能来自替身/脏数据)才退回一个中性说法。
    const name = title !== '' ? title : (notePath !== '' ? notePath : '当前笔记');
    return {
        bound: true,
        name,
        full: `将带上笔记:${name}`,
        placeholder: `就「${truncateText(name, maxNameChars)}」提问…`,
    };
}