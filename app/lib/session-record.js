// 「AI 会话」台账的**格式与编解码**。纯逻辑:不碰 fs、不碰 IPC、不碰 DOM。
//
// 为什么格式要单独一层:同一份数据被三处用,任何一处自己拼字符串都会漂 ——
//   · 主进程写盘(electron/sessions/session-ledger.js);
//   · 插件面板列清单 / 只读回看(plugins/ai-session/);
//   · 「接着聊」之后把历史**铺回对话**(app/agent/panel.js 的 hydrate)。
// 编解码放在这里,单测直接钉住"写出去再读回来是同一份"。
//
// 一条会话 = 一个 .md,住在 <笔记库>/AI会话/。**故意用 .md**:开物的库就是它的数据库
// (短剧那些数据也在库里),于是会话记录天生能被搜索、能被双链、跟着库一起备份。
//
// 文件长这样(人和机器都能读):
//
//   <!--kaiwu:{"v":1,"kind":"meta","id":"870d…","cwd":"E:\\vault", …,"title":"…"}-->
//
//   ## 思考栏被顶到消息下面
//
//   <!--kaiwu:{"kind":"user","at":1790403874841}-->
//   这个思考栏怎么被顶到消息下面了……
//
//   <!--kaiwu:{"kind":"reply","at":1790403884000}-->
//   改完了:排序键换成 turnId+seq……
//
// ⚠️ 为什么每条前面要一个 HTML 注释当中断标记,而不是"## 我 / ## 它"那种好看的小标题:
//    模型自己就会输出 `## 我`、`## 它` 这种行(它就是写 Markdown 的),拿它当分隔符
//    迟早会把一条回复劈成两半。`<!--kaiwu:…-->` 是一条**独占一行、以固定前缀开头**的
//    机器标记,而内容里真出现这个前缀时,写盘那一侧会把它转义掉(见 escapeMarkers),
//    于是"哪一段属于哪一条"永远不含糊。
//
// ⚠️ 元数据也走同一种标记(`"kind":"meta"`),不写 YAML frontmatter:frontmatter 要处理
//    引号、反斜杠(Windows 路径)、冒号这些转义,而 JSON 一行就说完,不会读错。

/** 文件格式版本。将来改字段时靠它分辨老文件。 */
export const RECORD_VERSION = 1;
/** 会话记录住的目录(相对笔记库)。 */
export const SESSION_DIR = 'AI会话';
/** 机器标记的前缀(后面紧跟一段 JSON)。 */
export const MARKER_PREFIX = '<!--kaiwu:';
const MARKER_SUFFIX = '-->';
/** 条目种类:用户说的 / 助手回复 / 思考 / 工具调用 / 这一轮怎么结束的。 */
export const ENTRY_KINDS = Object.freeze(['user', 'reply', 'think', 'tool', 'end']);
/** 标题取用户第一句话的前多少个字。 */
export const TITLE_MAX = 24;

const isText = (v) => typeof v === 'string' && v !== '';

/** 把一段文字里可能出现的机器标记前缀**转义**掉,保证标记行只由我们写。 */
export function escapeMarkers(text) {
    return String(text ?? '').split(MARKER_PREFIX).join('<\u200bkaiwu:');
}

/** 反向操作:读回来时把转义还原(写出去的字节必须能**逐字**读回来)。 */
export function unescapeMarkers(text) {
    return String(text ?? '').split('<\u200bkaiwu:').join(MARKER_PREFIX);
}

/** 标题:用户第一句话压成一行,超长截断。没有可用的字就给一个兜底名。 */
export function titleFrom(text, max = TITLE_MAX) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (flat === '') return '（没有文字的一次提问）';
    const chars = [...flat];
    return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`;
}

/** 本地时间 `2026-09-26 13:02` 这种口径统一在这里,别处不要再拼。 */
export function stampOf(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return {
        date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        clock: `${p(d.getHours())}:${p(d.getMinutes())}`,
        second: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    };
}

/**
 * 文件名:`2026-09-26-1302-<完整会话 id>.md`(时间在前 → 目录里天然按时间排)。
 *
 * ⚠️ id 用**完整**的,不截 8 位。实测踩到的静默丢数据:同一分钟内建的两条会话时间前缀一样,
 *    若 id 前 8 位也相同(夹具那种 `fake-session-1` / `fake-session-3` 就会),两次算出**同一个
 *    文件名** —— 后写的那份把前一份覆盖掉,现象是"新建了会话,台账却没多出文件"。
 *    会话 id 本身唯一,整个放进名字就没有这条路了。
 */
export function fileNameOf(record) {
    const { date, clock } = stampOf(record.createdAt);
    const id = String(record.id ?? '').trim();
    if (id === '') return `${date}-${clock.replace(':', '')}-unknown.md`;
    // 只挡路径分隔符之类的意外字符:加号数字仍是原样(会话 id 是 uuid,本来就只有十六进制与减号)。
    const safe = id.replace(/[\\/:*?"<>|]/g, '_');
    return `${date}-${clock.replace(':', '')}-${safe}.md`;
}

/**
 * 从文件名里认出会话 id(回**前 8 位**,便于日志里辨认;完整 id 在 meta 里)。
 * 短名与全名两种历史命名都认 —— 老文件不会因为这次改动就认不出来。
 */
export function shortIdOfFile(name) {
    const m = /^\d{4}-\d{2}-\d{2}-\d{4}-(.+)\.md$/i.exec(String(name ?? ''));
    if (m === null) return null;
    const id = m[1].replace(/-/g, '').toLowerCase();
    return id === '' ? null : id.slice(0, 8);
}

/** 一条空记录。 */
export function newRecord({ id, cwd = '', createdAt, model = '', modelValue = '', effort = '', effortValue = '' } = {}) {
    return {
        v: RECORD_VERSION,
        id: String(id ?? ''),
        cwd: String(cwd ?? ''),
        model: String(model ?? ''),
        modelValue: String(modelValue ?? ''),
        effort: String(effort ?? ''),
        effortValue: String(effortValue ?? ''),
        title: '',
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        updatedAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        turns: 0,
        entries: [],
    };
}

/** 一行机器标记。`payload` 里的键顺序固定 —— 同样的数据必须写出同样的字节(可断言)。 */
function markerLine(payload) {
    return `${MARKER_PREFIX}${JSON.stringify(payload)}${MARKER_SUFFIX}`;
}

/** 把一条记录写成文件全文。**纯函数**:同样的记录永远写出同样的字节。 */
export function renderRecord(record) {
    const out = [];
    out.push(markerLine({
        v: RECORD_VERSION, kind: 'meta',
        id: record.id, cwd: record.cwd,
        model: record.model, modelValue: record.modelValue,
        effort: record.effort, effortValue: record.effortValue,
        created: record.createdAt, updated: record.updatedAt,
        turns: record.turns, title: record.title,
        entries: record.entries.length,
    }));
    out.push('');
    out.push(`## ${record.title === '' ? '（还没有标题）' : record.title}`);
    for (const e of record.entries) {
        out.push('');
        const payload = { kind: e.kind, at: e.at };
        if (e.kind === 'tool') {
            payload.id = e.id;
            payload.title = e.title;
            payload.status = e.status;
            payload.toolKind = e.toolKind;
        }
        if (e.kind === 'end') {
            payload.stopReason = e.stopReason;
            if (isText(e.error)) payload.error = e.error;
        }
        if (e.kind === 'user' && Number.isFinite(e.images) && e.images > 0) payload.images = e.images;
        out.push(markerLine(payload));
        if (isText(e.text)) out.push(escapeMarkers(e.text));
    }
    out.push('');
    return out.join('\n');
}

/** 标记行判定:整行就是一条标记(前后不许有别的东西)。 */
function markerPayloadOf(line) {
    const s = line.trim();
    if (!s.startsWith(MARKER_PREFIX) || !s.endsWith(MARKER_SUFFIX)) return null;
    try {
        const parsed = JSON.parse(s.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length));
        return (parsed !== null && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;   // 坏行当普通正文,不炸
    }
}

/**
 * 读回一份记录。
 *
 * 容错口径:**坏行当正文**,坏标记丢掉 —— 这个文件用户是能打开的,
 * 一句手写的 `<!--kaiwu:` 不该让整个会话读不出来。
 *
 * @returns {{meta:object, entries:Array, title:string}|null} 连 meta 都没有 → null
 */
export function parseRecord(text) {
    const lines = String(text ?? '').split('\n');
    let meta = null;
    const entries = [];
    let current = null;
    for (const line of lines) {
        const payload = markerPayloadOf(line);
        if (payload === null) {
            if (current !== null) current.raw.push(line);
            continue;
        }
        if (payload.kind === 'meta') {
            if (meta === null) meta = payload;
            continue;
        }
        const entry = { kind: String(payload.kind ?? ''), at: Number(payload.at ?? 0) };
        if (entry.kind === 'tool') {
            entry.id = String(payload.id ?? '');
            entry.title = String(payload.title ?? '');
            entry.status = String(payload.status ?? '');
            entry.toolKind = String(payload.toolKind ?? '');
        }
        if (entry.kind === 'end') {
            entry.stopReason = String(payload.stopReason ?? '');
            if (isText(payload.error)) entry.error = String(payload.error);
        }
        if (entry.kind === 'user' && Number.isFinite(payload.images)) entry.images = Number(payload.images);
        entry.raw = [];
        entries.push(entry);
        current = entry;
    }
    if (meta === null) return null;
    for (const e of entries) {
        const body = e.raw.join('\n').trim();
        delete e.raw;
        if (body !== '') e.text = unescapeMarkers(body);
    }
    return {
        meta,
        entries,
        title: String(meta.title ?? ''),
        id: String(meta.id ?? ''),
        createdAt: Number(meta.created ?? 0),
        updatedAt: Number(meta.updated ?? 0),
        turns: Number(meta.turns ?? 0),
        cwd: String(meta.cwd ?? ''),
        model: String(meta.model ?? ''),
        effort: String(meta.effort ?? ''),
    };
}

// ---------------------------------------------------------------------------
// 往里加东西(全是纯函数:交回**新**记录,调用方不必担心共享引用)
// ---------------------------------------------------------------------------

const TEXT_KINDS = ['reply', 'think'];

/** 只合并"尾巴上同一种文字"—— 与对话面板的归约同一条规则(见 agent-stream 的说明)。 */
function mergeable(entries, kind) {
    const last = entries[entries.length - 1];
    return last !== undefined && last.kind === kind && TEXT_KINDS.includes(kind);
}

/** 用户说了话:这是**一轮**的开始,标题取第一句。 */
export function addUser(record, { text = '', images = 0, at } = {}) {
    const now = Number.isFinite(at) ? at : Date.now();
    const entries = record.entries.slice();
    const entry = { kind: 'user', at: now, text: String(text ?? '') };
    if (Number.isFinite(images) && images > 0) entry.images = Number(images);
    entries.push(entry);
    return {
        ...record,
        entries,
        turns: record.turns + 1,
        title: record.title === '' ? titleFrom(text) : record.title,
        updatedAt: now,
    };
}

/** 助手的一条文字(回复或思考)。连续增量并进同一条 —— 与界面同一条规则。 */
export function addText(record, kind, text, at) {
    const body = String(text ?? '');
    if (body === '' || !TEXT_KINDS.includes(kind)) return record;
    const now = Number.isFinite(at) ? at : Date.now();
    const entries = record.entries.slice();
    if (mergeable(entries, kind)) {
        const last = entries[entries.length - 1];
        entries[entries.length - 1] = { ...last, text: `${last.text ?? ''}${body}` };
    } else {
        entries.push({ kind, at: now, text: body });
    }
    return { ...record, entries, updatedAt: now };
}

/** 工具调用:同一个 id 出现多次是**改同一条**,不是新建(与界面同一条规则)。 */
export function addTool(record, { id, title = '', status = '', toolKind = '', at } = {}) {
    const toolId = String(id ?? '');
    if (toolId === '') return record;
    const now = Number.isFinite(at) ? at : Date.now();
    const entries = record.entries.slice();
    let at2 = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].kind === 'tool' && entries[i].id === toolId) { at2 = i; break; }
    }
    if (at2 === -1) {
        entries.push({
            kind: 'tool', at: now, id: toolId,
            title: String(title ?? '') || '工具调用',
            status: String(status ?? '') || 'pending',
            toolKind: String(toolKind ?? '') || 'other',
        });
    } else {
        const prev = entries[at2];
        entries[at2] = {
            ...prev,
            title: String(title ?? '') || prev.title,
            status: String(status ?? '') || prev.status,
            toolKind: String(toolKind ?? '') || prev.toolKind,
        };
    }
    return { ...record, entries, updatedAt: now };
}

/** 这一轮怎么结束的(带错误信息就是"最后一条错")。 */
export function addEnd(record, { stopReason = '', error = '', at } = {}) {
    const now = Number.isFinite(at) ? at : Date.now();
    const entry = { kind: 'end', at: now, stopReason: String(stopReason ?? '') };
    if (isText(error)) entry.error = String(error);
    return { ...record, entries: [...record.entries, entry], updatedAt: now };
}

/** 会话当前用的模型 / 强度(换模型时更新,清单里显示的就是它)。 */
export function withModel(record, { model, modelValue, effort, effortValue } = {}) {
    return {
        ...record,
        model: isText(model) ? String(model) : record.model,
        modelValue: isText(modelValue) ? String(modelValue) : record.modelValue,
        effort: isText(effort) ? String(effort) : record.effort,
        effortValue: isText(effortValue) ? String(effortValue) : record.effortValue,
    };
}

/**
 * ACP 的一条增量 → 台账条目。**入口只有这一个**,于是"什么会被记下来"是一处说了算。
 * @returns {{kind:string, text?:string, id?:string, title?:string, status?:string, toolKind?:string}|null}
 */
export function entryFromUpdate(update, at) {
    const kind = String(update?.sessionUpdate ?? '');
    const text = (() => {
        const c = update?.content;
        if (typeof c === 'string') return c;
        if (c !== null && typeof c === 'object' && typeof c.text === 'string') return c.text;
        return '';
    })();
    if (kind === 'agent_message_chunk') return text === '' ? null : { kind: 'reply', text, at };
    if (kind === 'agent_thought_chunk') return text === '' ? null : { kind: 'think', text, at };
    if (kind === 'tool_call' || kind === 'tool_call_update') {
        return {
            kind: 'tool', at,
            id: String(update?.toolCallId ?? ''),
            title: String(update?.title ?? update?.rawInput?.title ?? ''),
            status: String(update?.status ?? ''),
            toolKind: String(update?.kind ?? ''),
        };
    }
    return null;   // 别的增量(用量、计划…)这一版不记
}

// ---------------------------------------------------------------------------
// 把记录铺回对话(「接着聊」之后要看到聊过什么)
// ---------------------------------------------------------------------------

/**
 * 记录 → 一串**步骤**。面板照着走一遍就能把历史铺回对话里,不必另写一套渲染。
 *
 * 为什么是 steps 而不是直接回事件:用户消息那一步在对话面板里是 `beginPrompt()`
 * (它不是 reduceAgentEvent 的一个 case),所以两种步骤必须分开说。
 *
 * ⚠️ 图片只记了**张数**:历史里的图没有字节(那是当次会话的 blob),所以在气泡里
 *    如实写一句,而不是假装有图、留一个裂图。
 *
 * @returns {Array<{type:'prompt', text:string, images:Array}|{type:'event', event:object}>}
 */
export function recordToSteps(record) {
    const steps = [];
    for (const e of record.entries) {
        if (e.kind === 'user') {
            const extra = Number.isFinite(e.images) && e.images > 0
                ? `（这条消息带了 ${e.images} 张图;历史里只留了张数）` : '';
            const text = [String(e.text ?? ''), extra].filter((s) => s !== '').join('\n\n');
            steps.push({ type: 'prompt', text, images: [] });
            continue;
        }
        if (e.kind === 'reply' || e.kind === 'think') {
            steps.push({
                type: 'event',
                event: {
                    kind: 'update',
                    update: {
                        sessionUpdate: e.kind === 'reply' ? 'agent_message_chunk' : 'agent_thought_chunk',
                        content: { type: 'text', text: String(e.text ?? '') },
                    },
                },
            });
            continue;
        }
        if (e.kind === 'tool') {
            steps.push({
                type: 'event',
                event: {
                    kind: 'update',
                    update: {
                        sessionUpdate: 'tool_call', toolCallId: e.id,
                        title: e.title, status: e.status, kind: e.toolKind,
                    },
                },
            });
            continue;
        }
        if (e.kind === 'end') {
            steps.push(isText(e.error)
                ? { type: 'event', event: { kind: 'prompt-error', message: String(e.error) } }
                : { type: 'event', event: { kind: 'prompt-end', stopReason: String(e.stopReason ?? '') } });
        }
    }
    return steps;
}

// ---------------------------------------------------------------------------
// 清单(插件面板左栏)
// ---------------------------------------------------------------------------

/** 「今天 / 昨天 / 2026-09-24」——清单按天分段用。 */
export function dayLabelOf(ms, now = Date.now()) {
    const a = stampOf(ms).date;
    const today = stampOf(now).date;
    if (a === today) return '今天';
    if (a === stampOf(now - 86400000).date) return '昨天';
    return a;
}

/**
 * 资料行(清单一行要的东西)。**只从 meta 来** —— 所以列清单不必读整个文件。
 */
export function rowOf(parsed, { fileName = '', now = Date.now() } = {}) {
    return {
        id: String(parsed?.id ?? ''),
        file: String(fileName),
        title: String(parsed?.title ?? '') || '（没有标题）',
        createdAt: Number(parsed?.createdAt ?? 0),
        updatedAt: Number(parsed?.updatedAt ?? 0) || Number(parsed?.createdAt ?? 0),
        turns: Number(parsed?.turns ?? 0),
        model: String(parsed?.model ?? ''),
        effort: String(parsed?.effort ?? ''),
        cwd: String(parsed?.cwd ?? ''),
        day: dayLabelOf(Number(parsed?.updatedAt ?? 0) || Date.now(), now),
        clock: stampOf(Number(parsed?.updatedAt ?? 0) || Date.now()).clock,
    };
}

/** 按天分段(保持"新的在前"),插件直接照着画。 */
export function groupRows(rows) {
    const out = [];
    for (const row of rows) {
        const last = out[out.length - 1];
        if (last !== undefined && last.day === row.day) last.rows.push(row);
        else out.push({ day: row.day, rows: [row] });
    }
    return out;
}
