import { test } from 'node:test';
import assert from 'node:assert/strict';

// AI 面板的 DOM 断言。**照 notes-view.test.js 的写法**:自己造 DOM 替身,
// 不引 jsdom,也不起 Electron。
//
// 这一组用例只钉三件事:
//   1. 事件到达就渲染(流式),不用等整段结束;
//   2. 面板发出去的**频道与参数**正确(自检与主进程靠这个契约);
//   3. 对端给的一切都是**文字**,不是元素 —— 面板只许用 textContent。

class El {
    constructor(tag = 'div', doc = null) {
        this.tagName = String(tag).toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attrs = {};
        this.listeners = {};
        this.style = {};
        this.className = '';
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.type = '';
        this.placeholder = '';
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.firstChild = null;
    }
    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        this.firstChild = this.children[0] ?? null;
        return child;
    }
    /** 真 DOM 的 append(可变参数)。替身原先只有 appendChild —— 而面板里
     *  有几处（胶囊、浮层）用 append 一次挂几个节点，缺了它整段渲染就抛。 */
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    insertBefore(child, ref) {
        child.parentNode = this;
        const i = ref === null || ref === undefined ? this.children.length : this.children.indexOf(ref);
        this.children.splice(i < 0 ? this.children.length : i, 0, child);
        this.firstChild = this.children[0] ?? null;
        return child;
    }
    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parentNode = null;
        this.firstChild = this.children[0] ?? null;
        return child;
    }
    replaceChildren(...nodes) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        this.firstChild = null;
        for (const n of nodes) this.appendChild(n);
    }
    /** 类名的**真**实现(维护 className):面板里大量用 classList.toggle 表达状态,
     *  而断言要能读到"浮层开没开"。⚠️ 朴素替身里 className 与 class 属性是两份,
     *  所以读写都走 classesOf 那套口径(两边都看)。 */
    get classList() {
        const self = this;
        const list = () => String(self.className ?? '').split(/\s+/).filter(Boolean);
        const set = (next) => { self.className = [...new Set(next)].join(' '); };
        return {
            add: (...cs) => set([...list(), ...cs]),
            remove: (...cs) => set(list().filter((c) => !cs.includes(c))),
            contains: (c) => list().includes(c),
            toggle: (c, force) => {
                const has = list().includes(c);
                const want = force === undefined ? !has : force === true;
                if (want && !has) set([...list(), c]);
                if (!want && has) set(list().filter((x) => x !== c));
                return want;
            },
        };
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    focus() { this.ownerDocument.activeElement = this; }
    /** 触发事件;await 监听器返回的 promise(项目既有约定,见 onboarding.test.js)。 */
    async fire(type, event = {}) {
        for (const fn of this.listeners[type] ?? []) {
            await fn({ preventDefault() {}, ...event });
        }
    }
    /** 选择器只支持三种:.className(整词)、[attr](存在即可)、TAGNAME。
     *  ⚠️ 这里刻意**不用正则** —— 这个文件是通过 PowerShell here-string 落盘的,
     *  `\w` 那类转义会被吃掉,于是选择器悄悄失效、断言只会得到 0 个节点
     *  (这个坑真踩过:tag 选择器静默变成"什么都匹配不到")。 */
    matches(child, sel) {
        if (sel.startsWith('.')) {
            return String(child.className).split(/\s+/).includes(sel.slice(1));
        }
        if (sel.startsWith('[') && sel.endsWith(']')) {
            return child.getAttribute(sel.slice(1, -1)) !== null;
        }
        return child.tagName === sel.toUpperCase();
    }
    /** 递归找第一个匹配的节点。 */
    query(sel) {
        for (const child of this.children) {
            if (this.matches(child, sel)) return child;
            const deep = child.query?.(sel);
            if (deep) return deep;
        }
        return null;
    }
    /** 递归找**所有**匹配的节点(自检要按 data-* 数卡片,这里也得能数)。 */
    // ⚠️ 替身的局限,记一笔:className 与 `class` **属性**在真 DOM 里是同一份,在朴素替身里是两份 ——
    //    早先 matches() 只看 className,于是用 setAttribute('class',…) 造出来的节点一个都查不到
    //    (实测:两只眼睛数成 0,而真窗口里一切正常)。这里两边都看,免得下一个人再被骗一次。
    classesOf(node) {
        const a = String(node.className ?? '');
        const b = String((node.attrs && node.attrs.class) ?? '');
        return (a + ' ' + b).split(/\s+/).filter(Boolean);
    }
    /** 真 DOM 的 API 名(面板里用的就是这两个)。替身原先只有 query/queryAll,
     *  于是任何"先量一下 DOM 再决定画什么"的代码在替身里都走不到 —— 实测踩到:
     *  模型清单的"当前项打勾"整段被跳过,而界面上一切正常。 */
    querySelector(sel) { return this.query(sel); }
    querySelectorAll(sel) { return this.queryAll(sel); }
    queryAll(sel) {
        const out = [];
        for (const child of this.children) {
            if (this.matches(child, sel)) out.push(child);
            out.push(...(child.queryAll?.(sel) ?? []));
        }
        return out;
    }
}

const doc = {
    activeElement: null,
    createElement: (t) => new El(t, doc),
    createElementNS: (_, t) => new El(t, doc),
    // Markdown 渲染器用 createTextNode 造文字节点 —— 它绝不拼 HTML 字符串
    createTextNode: (text) => {
        const n = new El('#text', doc);
        n.textContent = String(text);
        return n;
    },
};

// 面板在**运行时**取 document(不是模块加载时),所以这里先装替身再 import。
globalThis.document = doc;

const { createAgentPanel } = await import('../app/agent/panel.js');
// 撕裂层的片数常量(单测要按它断言:进了失败态就建这么多片)
const { TEAR_SLICES } = await import('../app/lib/robot-face.js');

const flush = () => new Promise(r => setTimeout(r, 0));

/**
 * 子树里的全部文字。替身的 textContent **不聚合子节点**(真 DOM 会),
 * 所以断言"卡片上写着什么"必须自己走一遍树 —— 否则断言到的是一个空串,
 * 看起来像通过、其实什么都没验。
 */
function textOf(node) {
    if (node === null || node === undefined) return '';
    let out = String(node.textContent ?? '');
    for (const child of node.children ?? []) {
        if (child.getAttribute?.('aria-hidden') !== 'true') out += textOf(child);
    }
    return out;
}

/**
 * 一个会记账的桥替身。
 *
 * `startResult` = agent:start 的**返回值**(新契约:{ok:true,status} / {ok:false,...});
 * `failStart`  = agent:start **拒绝**(旧契约,面板仍要能兜住,比如桥自己坏了)。
 */
/** 可变的返回值盒子:测"失败之后又恢复"时需要中途换掉 agent:start 的结果。 */
function makeBox(value) {
    return { value };
}

function makeBridge({
    failStart = null,
    startResult = null,
    credentials = { ok: true, source: 'env', reason: null },
    sessionRecord = undefined,
} = {}) {
    const calls = [];
    const subscribers = [];
    const bridge = {
        async invoke(channel, payload = {}) {
            calls.push({ channel, payload });
            if (channel === 'agent:status') {
                return { state: 'stopped', pid: null, error: null, restarts: 0, since: null };
            }
            if (channel === 'agent:credentials') return credentials;
            // 「接着聊」要读台账:默认"没有记录",用例给 sessionRecord 时才回一份。
            if (channel === 'sessions:read') {
                return sessionRecord === undefined || sessionRecord === null
                    ? { ok: false, reason: '没有记录', record: null }
                    : { ok: true, record: sessionRecord };
            }
            if (channel === 'agent:start') {
                if (failStart) throw failStart;
                if (startResult !== null) {
                    return (typeof startResult === 'object' && 'value' in startResult)
                        ? startResult.value
                        : startResult;
                }
                return { ok: true, status: { state: 'ready', pid: 4242, error: null, restarts: 0, since: 1, sessionId: null, busy: false } };
            }
            return {};
        },
        onAgentEvent(fn) { subscribers.push(fn); return () => subscribers.splice(subscribers.indexOf(fn), 1); },
        emit(event) { for (const fn of subscribers) fn(event); },
        calls,
    };
    return { bridge, calls, emit: (e) => bridge.emit(e) };
}


/** 造一套元素替身 + 面板。真外壳里这 8 个元素都来自 index.html 的骨架。
 *  传自己的桥用 **bridgeOf**(也就是 makeBridge() 的返回值),因为它是个
 *  { bridge, calls, emit } 的包装 —— 直接当 bridge 塞进去,面板会拿到一个
 *  没有 invoke 的对象。(替身这个坑真咬过一次:调用全都没发生,而断言只是
 *  数字对不上,看起来像面板的 bug。) */
async function mountPanel({
    bridgeOf = null, note = null, autoStart = true,
    log = { warn() {}, error() {} },
} = {}) {
    const bridge = bridgeOf === null ? makeBridge().bridge : bridgeOf.bridge;
    const els = {
        panel: new El('section'), statusEl: new El('div'), retryBtn: new El('button'),
        messagesEl: new El('div'), inputEl: new El('textarea'), sendBtn: new El('button'),
        credentialEl: new El('div'),
        // 思考强度 / 模型那枚胶囊(真外壳里是 #agentCfg / #agentCfgWrap)。
        // ⚠️ 真外壳**总是**给这两个元素,所以主替身也必须给 —— 否则"面板会自己补骨架"
        //    那条能力会掩盖掉"这一枚控件根本没接上"。(另外两条"只给 8 个元素"的用例
        //    故意不给它们,那是在验降级。)
        configBtn: new El('button'), configWrap: new El('span'),
    };
    const panel = createAgentPanel({
        els, bridge, log, getNote: () => note, autoStart,
    });
    await panel.mount();
    await flush();
    return { els, panel, bridge };
}

const chunks = (...texts) => texts.map(text => ({
    kind: 'update', sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
}));

/** 控制浏览器帧时间，直接检查帧间 DOM，避免依赖等待墙上时钟。 */
function replyFrameClock() {
    const previous = doc.defaultView;
    let now = 0, id = 0;
    const jobs = new Map();
    doc.defaultView = {
        performance: { now: () => now },
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: fn => { jobs.set(++id, fn); return id; },
        cancelAnimationFrame: key => jobs.delete(key),
    };
    return {
        step(ms = 16) {
            now += ms;
            const callbacks = [...jobs.values()]; jobs.clear();
            callbacks.forEach(fn => fn(now));
        },
        get pending() { return jobs.size; },
        restore() { doc.defaultView = previous; },
    };
}

test('缓冲逐帧显示：未来段落不在正文或扫光 DOM 中，收尾后继续显示且不重播', async () => {
    const clock = replyFrameClock();
    let panel;
    try {
        const mounted = await mountPanel(); panel = mounted.panel;
        const { bridge, els } = mounted;
        const source = '第一段正文。'.repeat(40) + '\n\n' + '未来段落。'.repeat(40) + '\n\n最终末尾';
        bridge.emit(chunks(source)[0]); await flush();
        const base = els.messagesEl.query('.agent-stream-base');
        const sweep = els.messagesEl.query('.agent-sweep');
        assert.equal(textOf(base), '', '收进缓存时不应挂出不可见的未来节点');
        assert.equal(base.children.length, 0);
        assert.equal(sweep.children.length, 0);
        clock.step();
        const visible = textOf(base);
        assert.ok(visible.length > 0 && visible.length < source.length);
        assert.equal(base.queryAll('p').length, 1, '未来段落不占布局高度');
        assert.equal(textOf(sweep), visible, '扫光只能照到已显示正文');
        assert.equal(textOf(els.messagesEl).includes('未来段落'), false);
        bridge.emit({ kind: 'prompt-end', sessionId: 's1' }); await flush();
        assert.equal(els.messagesEl.query('.agent-stream-base'), base, '收尾不能重建正文');
        assert.equal(textOf(base), visible, '结束事件不能突然显示全部缓存或从头重播');
        assert.equal(els.messagesEl.query('.agent-sweep'), sweep, '缓存未排空时扫光仍连续运行');
        for (let i = 0; i < 130; i++) clock.step();
        assert.equal(textOf(base), source.replace(/\n/g, ''));
        assert.equal(els.messagesEl.query('.agent-sweep'), null);
        assert.equal(clock.pending, 0);
    } finally { panel?.dispose(); clock.restore(); }
});

test('缓冲显示中实时渲染标题、粗体、开放代码围栏和表格；缺字时扫光持续，卸载取消帧', async () => {
    const clock = replyFrameClock();
    let panel;
    try {
        const mounted = await mountPanel(); panel = mounted.panel;
        const { bridge, els } = mounted;
        let source = '## 标题\n\n**加粗**\n\n```js\nconst n = 1;';
        bridge.emit(chunks(source)[0]); await flush();
        for (let i = 0; i < 100; i++) clock.step();
        const base = els.messagesEl.query('.agent-stream-base');
        const sweep = els.messagesEl.query('.agent-sweep');
        assert.ok(base.query('h2'));
        assert.equal(textOf(base.query('strong')), '加粗');
        const pre = base.query('pre');
        assert.equal(textOf(pre.query('code')), 'const n = 1;');
        assert.ok(sweep, '缓存耗尽但网络未结束时仍然扫光');
        assert.equal(clock.pending, 0, '缺字期间无需空转帧任务');
        pre.scrollLeft = 37;
        const delta = '\n```\n\n| 名称 | 状态 |\n| --- | --- |\n| 缓冲 | 正常 |';
        source += delta;
        bridge.emit(chunks(delta)[0]); await flush();
        for (let i = 0; i < 100; i++) clock.step();
        assert.equal(base.query('pre'), pre, '已显示代码块要保留节点');
        assert.equal(pre.scrollLeft, 37, '增量解析不重置代码滚动位置');
        assert.ok(base.query('table'));
        assert.equal(els.messagesEl.query('.agent-sweep'), sweep);
        bridge.emit(chunks('未显示的字'.repeat(1000))[0]);
        assert.ok(clock.pending > 0);
        panel.dispose();
        await flush();
        assert.equal(clock.pending, 0, '卸载不能留下播放任务');
    } finally { panel?.dispose(); clock.restore(); }
});

test('同一批收到全文和结束事件仍缓冲显示，切换新会话立即取消旧缓存', async () => {
    const clock = replyFrameClock();
    let panel;
    try {
        const mounted = await mountPanel(); panel = mounted.panel;
        const { bridge, els } = mounted;
        bridge.emit(chunks('旧会话待显示内容。'.repeat(200))[0]);
        bridge.emit({ kind: 'prompt-end', sessionId: 's1' });
        await flush();
        assert.equal(textOf(els.messagesEl.query('.agent-stream-base')), '');
        clock.step();
        assert.ok(textOf(els.messagesEl.query('.agent-stream-base')).length > 0);
        bridge.emit({ kind: 'session', sessionId: 's2', fresh: true });
        await flush();
        assert.equal(clock.pending, 0);
        assert.equal(els.messagesEl.query('.agent-stream-base'), null);
        bridge.emit({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '迟到内容' } } });
        await flush();
        assert.equal(clock.pending, 0, '旧会话迟到的文本不能重启播放器');
    } finally { panel?.dispose(); clock.restore(); }
});

// ---------- 挂载即对话 ----------

test('挂载就自动发一次 agent:start(打开就是对话)', async () => {
    const { panel, bridge } = await mountPanel();
    assert.deepEqual(bridge.calls.map(c => c.channel),
        ['agent:status', 'agent:credentials', 'agent:start']);
    assert.equal(panel.state.status.state, 'ready');
});

test('autoStart:false 时挂载不连,状态停在 stopped,重试按钮是入口', async () => {
    const { panel, bridge, els } = await mountPanel({ autoStart: false });

    assert.equal(bridge.calls.some(c => c.channel === 'agent:start'), false,
        '自检模式绝不许自动拉起真的 dsh');
    assert.equal(panel.state.status.state, 'stopped');
    assert.equal(els.panel.dataset.agentState, 'stopped');
    assert.equal(els.retryBtn.disabled, false, '未连接时重试必须可点');
});

test('autoStart:false 时点重试才真连上(自检走的那条路)', async () => {
    const { panel, bridge, els } = await mountPanel({ autoStart: false });

    await els.retryBtn.fire('click');
    await flush();

    assert.equal(bridge.calls.filter(c => c.channel === 'agent:start').length, 1);
    assert.equal(els.panel.dataset.agentState, 'ready');
});

test('start 返回 {ok:false,state,snapshot,message} 时:用 snapshot 的原因,而不是内部错误 message', async () => {
    // 这条钉的是"原因选哪一句":快照里的 error 是**要显示给用户的那句中文**
    // (例如"握手失败"),而返回体里的 message 是给日志/排查看的内部话术
    // (例如"没有凭证")。选错就是把内部错误显示给用户。
    const { bridge, els, panel } = await mountPanel({
        bridgeOf: makeBridge({
            startResult: {
                ok: false,
                state: 'failed',
                message: '没有凭证',
                snapshot: { state: 'failed', pid: null, error: '握手失败', restarts: 0, since: 1 },
            },
        }),
    });

    assert.equal(panel.state.status.state, 'failed');
    assert.equal(els.panel.dataset.agentState, 'failed');
    assert.match(textOf(els.statusEl), /握手失败/, '原因要显示出来,不能只留一个红点');
    assert.equal(els.retryBtn.disabled, false, '失败时要给重试入口');
    assert.equal(bridge.calls.filter(c => c.channel === 'agent:start').length, 1);
});

test('start 返回 {ok:false} 但没带 snapshot 时,也把 state 与 message 显示出来', async () => {
    // 防御:真出了问题也不许在界面上显示 "undefined"。
    const { els, panel } = await mountPanel({
        bridgeOf: makeBridge({
            startResult: { ok: false, state: 'failed', message: 'Agent 未就绪(state=failed):握手超时(20000ms)' },
        }),
    });

    assert.equal(els.panel.dataset.agentState, 'failed');
    assert.match(textOf(els.statusEl), /failed/);
    assert.match(textOf(els.statusEl), /握手超时/);
    assert.equal(panel.state.status.error.includes('undefined'), false);
});

test('start 返回 {ok:false,state,message} 时:状态与中文原因都可见,重试按钮可用', async () => {
    // 真 Electron 那条路(M3-B 独立评审 F3):`ipcMain.handle` throw 的 Error
    // 跨进程只剩 message/stack,state/snapshot 全丢。所以 agent:start 改成
    // **返回**结果对象,面板要按返回体渲染 —— 这条钉的就是那个渲染。
    const { els, panel, bridge } = await mountPanel({
        bridgeOf: makeBridge({
            startResult: {
                ok: false,
                state: 'failed',
                message: 'Agent 未就绪(state=failed):握手超时(20000ms)',
                snapshot: { state: 'failed', pid: null, error: '握手超时(20000ms)', restarts: 0, since: 1 },
            },
        }),
    });

    assert.equal(panel.state.status.state, 'failed');
    assert.equal(els.panel.dataset.agentState, 'failed');
    assert.match(textOf(els.statusEl), /握手超时/, '原因要显示到状态区');
    assert.equal(textOf(els.statusEl).includes('undefined'), false);
    assert.equal(els.retryBtn.disabled, false, '失败时要给重试入口');
    assert.equal(bridge.calls.filter(c => c.channel === 'agent:start').length, 1);
});

test('start 返回 {ok:false} 但状态不是 failed(比如 stopping)时也照实显示', async () => {
    const { els, panel } = await mountPanel({
        bridgeOf: makeBridge({
            startResult: { ok: false, state: 'stopping', message: '上一次停止还没走完' },
        }),
    });

    assert.equal(panel.state.status.state, 'stopping');
    assert.equal(els.panel.dataset.agentState, 'stopping');
    assert.match(textOf(els.statusEl), /上一次停止还没走完/);
    assert.equal(textOf(els.statusEl).includes('undefined'), false);
});

test('start 成功返回 {ok:true,status} 时用返回的 status 渲染(不是桥里别的什么)', async () => {
    const { els, panel } = await mountPanel({
        bridgeOf: makeBridge({
            startResult: { ok: true, status: { state: 'ready', pid: 777, error: null, restarts: 2, since: 5 } },
        }),
    });

    assert.equal(panel.state.status.state, 'ready');
    assert.equal(panel.state.status.pid, 777);
    assert.equal(panel.state.status.restarts, 2);
    assert.equal(els.panel.dataset.agentState, 'ready');
});

test('data-agent-state 跟着 status.state 走(自检按它断言连接状态)', async () => {
    const { bridge, els } = await mountPanel();

    for (const state of ['starting', 'ready', 'crashed', 'failed', 'stopped']) {
        bridge.emit({ kind: 'state', status: { state, pid: 1, error: null, restarts: 0, since: 1 } });
        await flush();
        assert.equal(els.panel.dataset.agentState, state);
    }
});

// ---------- 发送 ----------

test('输入框回车 = 发送,频道与参数都对', async () => {
    const note = { title: '灵感收集', path: 'inbox/灵感.md', text: '# 灵感\n\n一个点子。' };
    const { els, bridge } = await mountPanel({ note });

    els.inputEl.value = '帮我整理';
    await els.inputEl.fire('keydown', { key: 'Enter' });
    await flush();

    const sent = bridge.calls.filter(c => c.channel === 'agent:send');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.text.split('\n')[0], '当前笔记:inbox/灵感.md',
        '提示第一行必须是「当前笔记:<path>」(自检回显后按这一行断言)');
    assert.match(sent[0].payload.text, /一个点子/);
    assert.match(sent[0].payload.text, /问题:帮我整理/);
    assert.equal(els.inputEl.value, '', '发出去之后输入框要清空');
});

test('回车发送会 preventDefault(不许被上层当成别的动作)', async () => {
    const { els } = await mountPanel();
    let prevented = false;
    els.inputEl.value = '问题';
    await els.inputEl.fire('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
});

test('「回车发送」那句可见文本删掉之后:卡片里搜不到它,但可达性只走非视觉出口', async () => {
    // 用户要求删掉动作行里那句「回车发送」。⚠️ 删的是**可见文本**,不是"回车能发送"这条
    // 可达性信息 —— 它必须还在,只是换了出口:input 的 aria-keyshortcuts(标准字段)+
    // aria-label(每个读屏都会念)。真外壳的 #agentInput 在 index.html 里写着这两条,
    // 这里量的是"输入框由面板现场造"那条兜底路径(替身 / 老外壳)。
    const { els } = await mountPanel();
    assert.equal(textOf(els.panel).includes('回车发送'), false,
        '卡片里不许再出现那四个字(可见文本已删)');
    assert.equal(els.inputEl.getAttribute('aria-keyshortcuts'), 'Enter',
        '回车这个快捷键要用标准字段声明出来');
    assert.match(String(els.inputEl.getAttribute('aria-label') ?? ''), /回车发送/,
        '标签里也带上它:支持 keyshortcuts 的读屏不多,标签是保底那条');
});

test('没有打开的笔记时只发问题本身', async () => {
    const { els, bridge } = await mountPanel({ note: null });

    els.inputEl.value = '你好';
    await els.sendBtn.fire('click');
    await flush();

    const sent = bridge.calls.filter(c => c.channel === 'agent:send');
    assert.equal(sent[0].payload.text, '你好');
});

test('空间里只有空白时点发送什么都不发', async () => {
    const { els, bridge } = await mountPanel();

    els.inputEl.value = '   ';
    await els.sendBtn.fire('click');
    await flush();

    assert.equal(bridge.calls.some(c => c.channel === 'agent:send'), false);
});

test('发送后用户那句话立刻上屏(不等整段结束)', async () => {
    const { els, panel } = await mountPanel();

    els.inputEl.value = '这句要立刻看见';
    await els.inputEl.fire('keydown', { key: 'Enter' });

    const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
    assert.equal(bubble.getAttribute('data-role'), 'user');
    assert.equal(textOf(bubble), '这句要立刻看见');
    assert.equal(panel.state.busy, true);
});

// ---------- 流式渲染 ----------

test('agent:update 到达即渲染,连续 chunk 拼在同一个气泡里', async () => {
    const { bridge, els } = await mountPanel();

    for (const event of chunks('你', '好', '呀')) {
        bridge.emit(event);
        await flush();
    }

    const bubbles = els.messagesEl.queryAll('.agent-msg');
    assert.equal(bubbles.length, 1, `连续 chunk 不许拆成多个气泡,实际 ${bubbles.length} 个`);
    assert.equal(bubbles[0].getAttribute('data-role'), 'assistant');
    assert.equal(textOf(bubbles[0]), '你好呀');
});

test('prompt-end 到达后气泡不再标 data-streaming', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit(chunks('半句')[0]);
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-msg')[0].getAttribute('data-streaming'), 'true');

    bridge.emit({ kind: 'prompt-end', sessionId: 's1', stopReason: 'end_turn' });
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-msg')[0].getAttribute('data-streaming'), null);
});

test('实时 Markdown 正文与扫光副本一致，写完只保留正文', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit(chunks('短句')[0]);
    await flush();
    let sweep = els.messagesEl.queryAll('.agent-sweep');
    assert.equal(sweep.length, 1,
        '流式正文必须包一层 .agent-sweep —— 扫光只能作用在文字上,气泡底不能跟着被 background-clip 裁掉');
    assert.equal(textOf(sweep[0]), '短句');

    bridge.emit(chunks('一二三四五六七八九十')[0]);
    await flush();
    sweep = els.messagesEl.queryAll('.agent-sweep');
    assert.equal(sweep.length, 1, '同一个气泡里只该有一层扫光');
    assert.equal(textOf(sweep[0]), '短句一二三四五六七八九十', '两层加起来还是完整正文,不许丢字');

    // 写完:两层都撤干净,正文一个字不少
    bridge.emit({ kind: 'prompt-end', sessionId: 's1', stopReason: 'end_turn' });
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-sweep').length, 0, '写完之后扫光层要撤干净');
    assert.equal(textOf(els.messagesEl.queryAll('.agent-msg')[0]), '短句一二三四五六七八九十');
});

test('流式增量只改文字、不重建 DOM(重建会把扫光/光标动画从头开始)', async () => {
    const { bridge, els } = await mountPanel();

    // 已显示结构应复用，CSS 扫光保持同一相位。
    bridge.emit(chunks('一二三四五六七八九十')[0]);
    await flush();
    const sweepBefore = els.messagesEl.queryAll('.agent-sweep')[0];
    const thinkBefore = els.messagesEl.queryAll('.agent-think')[0];
    assert.ok(sweepBefore, '应当有扫光层');

    // 再追加正文:结构没变 → 必须复用同一批节点(CSS 动画才不会重来)
    bridge.emit(chunks('十一十二')[0]);
    await flush();
    const sweepAfter = els.messagesEl.queryAll('.agent-sweep')[0];
    assert.equal(sweepAfter, sweepBefore,
        '追加正文不许把 .agent-sweep 重建 —— 每次更新都换新节点,扫光的 CSS 动画就永远停在起点');
    assert.equal(els.messagesEl.queryAll('.agent-think')[0], thinkBefore);
    assert.equal(textOf(sweepAfter), '一二三四五六七八九十十一十二', '复用节点也要把新正文写进去');

    // 但结构真变了(比如来了一条工具卡)就必须重建,不能拿旧节点凑合
    bridge.emit({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', kind: 'read', status: 'pending' } });
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-sweep')[0], sweepBefore, '工具改变列表结构也不能重置回复播放器');
    assert.match(textOf(els.messagesEl), /一二三四五六七八九十十一十二/, '重建之后正文一个字都不能少');
});

test('工具卡片:.agent-tool 带 data-tool-call-id 与 data-status,更新复用同一条', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'call-7', title: 'read', kind: 'read', status: 'pending' } });
    await flush();
    bridge.emit({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-7', status: 'completed' } });
    await flush();

    const cards = els.messagesEl.queryAll('.agent-tool');
    assert.equal(cards.length, 1, '更新不许再出一张卡');
    assert.equal(cards[0].getAttribute('data-tool-call-id'), 'call-7');
    assert.equal(cards[0].getAttribute('data-status'), 'completed');
    assert.match(textOf(cards[0]), /read/);
});

test('思考收进一条可折叠的细条:正文一到就自动收起(A2)', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '让我想想' } } });
    await flush();

    const think = els.messagesEl.query('.agent-think');
    assert.ok(think !== null, '思考要有一条自己的折叠块');
    assert.equal(think.getAttribute('data-live'), 'true', '还在流式 → data-live=true(自检按属性断言)');
    assert.match(textOf(think), /思考中…/);
    assert.equal(think.query('.agent-think-count'), null, '思考栏不显示字数');
    assert.equal(textOf(think.query('.agent-think-body')), '让我想想');
    assert.equal(els.messagesEl.queryAll('.agent-msg').length, 0, '这时还没有正文气泡');

    // 正文一到:思考收尾(标签变「已思考」),而且**自动收起**
    bridge.emit(chunks('想好了')[0]);
    await flush();
    const thinkAfter = els.messagesEl.query('.agent-think');
    assert.equal(thinkAfter.getAttribute('data-live'), 'false');
    assert.match(textOf(thinkAfter), /已思考/);
    assert.equal(thinkAfter.getAttribute('open'), null, '正文开始时思考要自动收起,答案立刻可读');
    assert.equal(els.messagesEl.queryAll('.agent-msg').length, 1, '思考不许混进消息气泡');
});

test('思考条显示耗时:静默期自己在走,收尾之后冻住(用户问的"思考时间")', async () => {
    const realNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    let panel = null;
    try {
        const mounted = await mountPanel();
        const { bridge, els } = mounted;
        panel = mounted.panel;
        // ⚠️ 必须先真的发一轮(busy=true):秒表只在**这一轮在飞**的时候挂 ——
        //    光看"有没有 live 的思考"会让进程被硬杀后留下一条永远 live 的思考,
        //    那个定时器就再也不会停(见 panel.js 的 syncThinkTicker)。
        els.inputEl.value = '想一下';
        await panel.send();
        await flush();

        const thinkChunk = (text) => ({
            kind: 'update', sessionId: 's1',
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
        });

        bridge.emit(thinkChunk('第一段'));
        await flush();
        const at0 = els.messagesEl.query('.agent-think-time');
        assert.ok(at0 !== null, '思考条上要有一行耗时读数');
        assert.equal(at0.textContent, '0.0 秒', '刚出现的思考从 0 起算');

        // ① 服务端一个字都不发的静默期,秒数也要自己在走 —— 靠本地时钟 + 定时器,
        //    不是"等下一个增量才顺手刷一下"(那在有思考但没输出的时候正好什么都不动)。
        now += 1000;
        await new Promise(r => setTimeout(r, 400));            // 秒表 250ms 一拍
        assert.equal(els.messagesEl.query('.agent-think-time').textContent, '1.0 秒',
            '静默期必须自己涨');

        // ② 收尾:按**事件那一刻**的时刻冻住,之后时钟再走也不许涨
        now += 2200;
        bridge.emit(chunks('答案')[0]);
        await flush();
        assert.equal(els.messagesEl.query('.agent-think-time').textContent, '3.2 秒');
        now += 10_000;
        await new Promise(r => setTimeout(r, 400));
        assert.equal(els.messagesEl.query('.agent-think-time').textContent, '3.2 秒',
            '收尾后冻住:它回答的是"这一条想了多久",不是"现在几点"');
    } finally {
        panel?.dispose();          // 断言失败也要收干净:否则泄出去的定时器会把整个进程挂住
        Date.now = realNow;
    }
});

test('一闪而过的思考:没被画成 live,耗时也量得出来(秒表挂在事件上,不是渲染上)', async () => {
    const realNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    let panel = null;
    try {
        const mounted = await mountPanel();
        panel = mounted.panel;
        const { bridge, els } = mounted;
        // ⚠️ 中间**不 flush**:思考与正文在同一批事件里到达 → 渲染从没见过它是 live 的。
        //    若把秒表按下在渲染里,这条就只能记出 0.0 秒(那是假读数)。
        bridge.emit({
            kind: 'update', sessionId: 's1',
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '一闪而过' } },
        });
        now += 500;
        bridge.emit(chunks('答案')[0]);
        await flush();

        assert.equal(els.messagesEl.query('.agent-think-time').textContent, '0.5 秒');
    } finally {
        panel?.dispose();
        Date.now = realNow;
    }
});

test('别的会话的增量不进这个面板(多会话不许串线)', async () => {    const { bridge, els } = await mountPanel();

    bridge.emit({ kind: 'session', sessionId: 's1', configOptions: [] });
    await flush();
    bridge.emit({ kind: 'update', sessionId: '别的会话', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '不该出现' } } });
    await flush();

    assert.equal(els.messagesEl.queryAll('.agent-msg').length, 0);
});

// ---------- 错误与凭证 ----------

test('prompt-error 的中文原因可见', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit({ kind: 'prompt-error', sessionId: 's1', message: '模型拒绝了这次请求', missingCredential: false });
    await flush();

    assert.match(textOf(els.statusEl), /模型拒绝了这次请求/);
});

test('凭证缺失时把中文原因与"怎么配"的指引显示出来', async () => {
    const reason = '没有找到 DEEPSEEK_API_KEY,也没有 .credentials.yaml';
    const { els } = await mountPanel({
        bridgeOf: makeBridge({ credentials: { ok: false, source: null, reason } }),
    });

    const shown = textOf(els.credentialEl);
    assert.equal(els.credentialEl.hidden, false);
    assert.match(shown, /没有找到 DEEPSEEK_API_KEY/);
    assert.match(shown, /credentials\.yaml/, '只说原因不够,要给怎么配');
    assert.match(shown, /DEEPSEEK_API_KEY/, '"怎么配"里要出现环境变量的名字');
    assert.match(shown, /环境变量/, '要告诉用户配置方式');
});

test('prompt-error 且 missingCredential 时凭证卡片被展开/高亮(映射落点)', async () => {
    const { bridge, els } = await mountPanel({
        bridgeOf: makeBridge({ credentials: { ok: false, source: null, reason: '没有凭证' } }),
    });
    // 先收起来,假装一开始是好的
    els.credentialEl.hidden = true;

    bridge.emit({ kind: 'prompt-error', sessionId: 's1', message: '缺少凭证', missingCredential: true });
    await flush();

    assert.equal(els.credentialEl.hidden, false, '缺凭证必须把卡片亮出来');
    assert.equal(els.credentialEl.dataset.state, 'warn');
});

test('凭证卡片里绝不出现任何看起来像密钥的值', async () => {
    const { els } = await mountPanel({
        bridgeOf: makeBridge({ credentials: { ok: false, source: null, reason: '未配置' } }),
    });

    // 频道契约本身就只有 ok/source/reason,结构上没有值;这条钉住面板也不自己造
    assert.equal(/sk-[A-Za-z0-9]/.test(els.credentialEl.textContent), false);
});

// ---------- 权限卡片 ----------

function permissionEvent(overrides = {}) {
    return {
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 's1',
        toolCall: { toolCallId: 'c1', title: '运行命令', kind: 'execute' },
        options: [
            { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
            { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
        ],
        ...overrides,
    };
}

test('权限卡渲染出每个选项按钮,带 data-option-id', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit(permissionEvent());
    await flush();

    const card = els.messagesEl.query('.agent-permission');
    assert.equal(card.getAttribute('data-request-id'), 'req-1');
    const ids = card.queryAll('[data-option-id]').map(b => b.getAttribute('data-option-id'));
    assert.deepEqual(ids, ['allow-once', 'reject-once']);
    // ⚠️ 这里原来还断言 `data-decided` 是空串("还没决定时是空的")。已决的卡现在整个
    // 不再渲染(见下一条),面板也就不再往卡上刻"用户选了哪一个" —— data-decided /
    // data-resolved 两处写入随这次改动一起删了,那条断言没有对象可量。
});

test('点某个选项 → agent:permission{requestId, optionId},而且卡当场消失', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit(permissionEvent());
    await flush();
    const card = els.messagesEl.query('.agent-permission');
    await card.queryAll('[data-option-id]')[1].fire('click');
    await flush();

    const answer = bridge.calls.filter(c => c.channel === 'agent:permission');
    assert.equal(answer.length, 1);
    assert.deepEqual(answer[0].payload, { requestId: 'req-1', optionId: 'reject-once' });

    // 产品负责人要求"这个请求完也删":答完不再留在原地变灰,而是整张卡从界面上消失。
    assert.equal(els.messagesEl.query('.agent-permission'), null,
        '答完的授权卡不许再留在界面上');
    assert.equal(els.messagesEl.queryAll('.agent-permission').length, 0);
});

test('点「允许一次」:回到 agent 的正是 allow-once,卡也一并消失', async () => {
    // 这条原来是「点『允许一次』之后 data-decided 就是 allow-once(自检断言的那一条)」。
    // 卡不再留在界面上之后,那个 DOM 属性没有对象了 —— 但这条用例真正要证的东西没变,
    // 只是换了证据:用户的决定(allow-once)**真的**走了 agent:permission 这条通道。
    const { bridge, els } = await mountPanel();

    bridge.emit(permissionEvent());
    await flush();
    await els.messagesEl.query('.agent-permission').queryAll('[data-option-id]')[0].fire('click');
    await flush();

    assert.deepEqual(
        bridge.calls.filter(c => c.channel === 'agent:permission')[0].payload,
        { requestId: 'req-1', optionId: 'allow-once' },
    );
    assert.equal(els.messagesEl.queryAll('.agent-permission').length, 0,
        '请求答完就该从界面上退场');
});

test('授权卡:拿着已被摘掉的旧节点再点、对端重发同一个 requestId,都不发第二个回答', async () => {
    // 「恰好回答一次」原来靠"按钮禁用"这个**可见**证据。卡消失之后那个证据没有了,
    // 所以这里直接盯住真正的保证:answered 集合。手里攥着那张已经被摘掉的旧节点
    // (它的 click 监听器还在),再点一次 —— 一次也不许变成第二个 IPC。
    const { bridge, els } = await mountPanel();

    bridge.emit(permissionEvent());
    await flush();
    const stale = els.messagesEl.query('.agent-permission');
    await stale.queryAll('[data-option-id]')[0].fire('click');
    await flush();
    assert.equal(els.messagesEl.query('.agent-permission'), null, '答完就没了');
    await stale.queryAll('[data-option-id]')[1].fire('click');
    await flush();

    const answered = bridge.calls.filter(c => c.channel === 'agent:permission');
    assert.equal(answered.length, 1, '同一个 requestId 只许回答一次');
    assert.deepEqual(answered[0].payload, { requestId: 'req-1', optionId: 'allow-once' },
        '后一次点击不许改写已经做出的决定');

    // 对端重发同一个 requestId 是常态:更不许把答完的卡"拉回来"。
    bridge.emit(permissionEvent());
    await flush();
    assert.equal(els.messagesEl.query('.agent-permission'), null, '重发不许让答完的卡复活');
});

test('同一个 requestId 重复到达只出一张卡', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit(permissionEvent());
    bridge.emit(permissionEvent());
    bridge.emit(permissionEvent({ requestId: 'req-2' }));
    await flush();

    const cards = els.messagesEl.queryAll('.agent-permission');
    assert.equal(cards.length, 2, `只该有 req-1/req-2 两张,实际 ${cards.length} 张`);
    assert.deepEqual(cards.map(c => c.getAttribute('data-request-id')), ['req-1', 'req-2']);
});

// ---------- 取消 / 停止 / 重试 ----------

// ⚠️ 这条原来叫「#agentStop 是取消当前提示(agent:cancel),不是停进程」。
// 发送与取消**合成一颗球**之后(#agentStop 已经不存在,见 index.html 与 panel.js 的 ensureOrb),
// 这颗球在**执行中**点一下就是取消 —— 被钉住的性质一个字没变:
//   ① 取消走的是 agent:cancel(不是 agent:stop,进程不许被顺手停掉);
//   ② 同一个控件在空闲时仍然是发送(见上面「回车发送」与下面「一颗球三态」那两条)。
test('执行中点那颗球 = 取消当前提示(agent:cancel),不是停进程', async () => {
    const { bridge, els, panel } = await mountPanel();
    els.inputEl.value = '问题';
    await els.inputEl.fire('keydown', { key: 'Enter' });
    await flush();
    assert.equal(panel.state.busy, true);
    assert.equal(els.sendBtn.getAttribute('aria-label'), '取消当前提示',
        '执行中它必须自报"取消当前提示" —— 这是读屏唯一能知道该控件现在干什么的地方');

    await els.sendBtn.fire('click');
    await flush();

    assert.equal(bridge.calls.filter(c => c.channel === 'agent:cancel').length, 1);
    assert.equal(bridge.calls.some(c => c.channel === 'agent:stop'), false, '取消不该顺手把进程也停了');
    assert.equal(panel.state.busy, false);
    // 取消完回到空闲:同一个控件又变回发送
    assert.equal(els.sendBtn.getAttribute('aria-label'), '发送');
});

test('一颗球:空闲能发、执行中能取消、没连上又没草稿时是灰的(三态一一对应旧的两个按钮)', async () => {
    const { els, panel, bridge } = await mountPanel();
    // ① 空闲(ready 且手上没活):能发,名字是「发送」
    assert.equal(panel.state.status.state, 'ready');
    assert.equal(els.sendBtn.disabled, false, 'ready 且没活时它必须是可点的发送');
    assert.equal(els.sendBtn.getAttribute('aria-label'), '发送');

    // ② 执行中:同一颗球变成取消,**永远可点**(取消是唯一出路,不能是灰的)
    els.inputEl.value = '问题';
    await els.sendBtn.fire('click');
    await flush();
    assert.equal(panel.state.busy, true);
    assert.equal(els.sendBtn.disabled, false, '执行中它是取消 —— 禁用就等于把唯一出路堵掉');
    assert.equal(els.sendBtn.getAttribute('aria-label'), '取消当前提示');
    await els.sendBtn.fire('click');
    await flush();
    assert.equal(panel.state.busy, false, '再点一下就是取消');

    // ③ 没连上、也没有视频草稿:灰的(旧「发送」按钮的禁用判据原样搬过来)
    const els2 = {
        panel: new El('section'), statusEl: new El('div'), retryBtn: new El('button'),
        messagesEl: new El('div'), inputEl: new El('textarea'), sendBtn: new El('button'),
        credentialEl: new El('div'),
    };
    const h2 = makeBridge();
    const p2 = createAgentPanel({
        els: els2, bridge: h2.bridge, log: { warn() {}, error() {} },
        getNote: () => null, autoStart: false,
    });
    await p2.mount();
    await flush();
    assert.equal(p2.state.status.state, 'stopped');
    assert.equal(els2.sendBtn.disabled, true, '没连上、手上也没活 → 不许点(旧按钮的判据不变)');
    assert.equal(bridge.calls.filter(c => c.channel === 'agent:cancel').length, 1,
        '取消只发生了一次(第二次点击走的是 send,不是 cancel)');
});

test('球是自己长出来的:外壳只给一个空按钮,面板补上手/眼睛,并且不重复造', async () => {
    const els = fullSkeleton();
    const harness = makeBridge();
    const panel = createAgentPanel({
        els, bridge: harness.bridge, log: { warn() {}, error() {} },
        getNote: () => null, autoStart: true,
    });
    await panel.mount();
    await flush();
    await panel.mount();                 // 挂载两次(切视图重建)也不许长出第二层

    assert.equal(String(els.sendBtn.className).split(/\s+/).includes('agent-orb'), true,
        '球要有 agent-orb 这个类(CSS 全靠它)');
    assert.equal(els.sendBtn.queryAll('.agent-orb-bot').length, 1, '球的画布只许有一层');
    assert.equal(els.sendBtn.queryAll('.agent-orb-body').length, 1);
    assert.equal(els.sendBtn.queryAll('.agent-orb-eye').length, 2, '两只眼睛,不多不少');
    assert.equal(els.sendBtn.textContent, '', '纯图形按钮:里面不许有可见文字(文案走 aria-label)');
    const wrap = els.sendBtn.query('.agent-orb-bot');
    assert.equal(wrap.getAttribute('aria-hidden'), 'true',
        '里面的画对读屏要隐形 —— 名字在按钮自己身上');
});

test('AI 输入卡片移除停止进程按钮，只在连接时显示提示', async () => {
    const { bridge, els, panel } = await mountPanel();
    const ctxRow = () => els.panel.query('.agent-ctx-row');
    const hint = () => els.panel.query('.agent-ctx-hint');

    assert.equal(panel.state.status.state, 'ready');
    assert.ok(ctxRow() !== null, '连接提示行仍然保留');
    assert.equal(els.panel.query('.agent-ctx-stop'), null, 'AI 输入卡片中不再创建停止进程按钮');
    assert.equal(ctxRow().hidden, true, '整行默认 hidden:不留 20px 空行,也不留下间距');

    // 出错时由对话提示卡提供重试入口，输入卡片不再显示空行。
    bridge.emit({ kind: 'state', status: { state: 'crashed', pid: null, error: null, restarts: 0, since: 1 } });
    await flush();
    assert.equal(ctxRow().hidden, true, '故障状态由提示卡表达，不在输入区留空行');

    // 正在起(starting)时保留连接提示，但没有停止按钮。
    bridge.emit({ kind: 'state', status: { state: 'starting', pid: null, error: null, restarts: 0, since: 1 } });
    await flush();
    assert.equal(ctxRow().hidden, false);
    assert.equal(hint().hidden, false, '连接中显示可读提示');
    assert.match(String(hint().textContent ?? ''), /正在连接 Agent/, '说清正在做什么');
    assert.equal(/进度|%|\d+\s*秒/.test(String(hint().textContent ?? '')), false,
        '不许写数字/假进度:分母不存在,写了就是拿猜的数当承诺');
    assert.equal(els.panel.query('.agent-ctx-stop'), null);

    bridge.emit({ kind: 'state', status: { state: 'ready', pid: 1, error: null, restarts: 0, since: 1 } });
    await flush();
    assert.equal(hint().hidden, true);
    assert.equal(ctxRow().hidden, true);
});

test('失败之后点重试会再发一次 agent:start', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit({ kind: 'state', status: { state: 'failed', pid: null, error: '握手超时', restarts: 0, since: 1 } });
    await flush();
    assert.equal(els.retryBtn.disabled, false, '失败时重试要能点');

    await els.retryBtn.fire('click');
    await flush();

    assert.equal(bridge.calls.filter(c => c.channel === 'agent:start').length, 2);
});

// ---------- 安全:对端给的一切都是文字 ----------

test('对端给的 <img onerror> 原样是文字,不是元素(XSS 不许执行)', async () => {
    const evil = '<img src=x onerror="window.__pwned = 1">';
    const { bridge, els } = await mountPanel();

    bridge.emit({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: evil } } });
    bridge.emit({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'x', title: evil, kind: 'read', status: 'pending' } });
    bridge.emit(permissionEvent({ toolCall: { title: evil } }));
    await flush();

    const bubble = els.messagesEl.query('.agent-msg');
    assert.equal(textOf(bubble), evil, '气泡里应当是这段文字本身');
    assert.equal(bubble.query('img'), null, '面板不许把它建成元素');
    assert.equal(els.messagesEl.queryAll('img').length, 0);
    assert.equal(els.messagesEl.queryAll('script').length, 0);

    assert.match(textOf(els.messagesEl.query('.agent-tool')), /<img src=x/, '工具标题也是文字');
    assert.match(textOf(els.messagesEl.query('.agent-permission')), /<img src=x/, '权限卡标题也是文字');
});

test('对端给的消息文本不许被当成 HTML 解出子节点', async () => {
    const { bridge, els } = await mountPanel();

    bridge.emit(chunks('<b>加粗</b>')[0]);
    await flush();

    const bubble = els.messagesEl.query('.agent-msg');
    assert.equal(textOf(bubble), '<b>加粗</b>');
    assert.equal(bubble.query('b'), null);
});

// ---------- 无障碍 ----------

test('无障碍:输入/发送/取消/重试都有 aria-label,状态区是 aria-live', async () => {
    const { els } = await mountPanel();

    // 真外壳的 index.html 里这些 aria-label 已经写好;替身里空着,面板要补上,
    // 这样"自带骨架但没有标签"的情况也不会漏。
    // ⚠️ 输入框那条从 `对 AI 提问` 改成 `对 AI 提问(回车发送)`:动作行里那句可见的
    // 「回车发送」按用户要求删掉了,这条可达性信息必须有出口 —— 标签是**每个读屏都会念**
    // 的那一条(aria-keyshortcuts 的支持面没这么广,所以两条一起给)。
    assert.equal(els.inputEl.getAttribute('aria-label'), '对 AI 提问(回车发送,Shift+回车换行)。没有打开的笔记 —— 只发问题本身');
    assert.equal(els.inputEl.getAttribute('aria-keyshortcuts'), 'Enter');
    assert.equal(els.sendBtn.getAttribute('aria-label'), '发送');
    // ⚠️ 原来这里还有一条 `els.stopBtn.getAttribute('aria-label') === '取消当前提示'`。
    // #agentStop 已经不存在(发送与取消合成一颗球),那条**没有删** —— 它并到了
    // 「执行中点那颗球 = 取消当前提示」那条里:同一个控件在执行中必须自报「取消当前提示」,
    // 换的是控件,不是语义。
    assert.equal(els.retryBtn.getAttribute('aria-label'), '重试连接');
});

test('外壳只交出 8 个元素时,面板也要把骨架补齐并绑上事件', async () => {
    // 这条钉的是**接线**:main.js 拿到的是 8 个现成元素(index.html 的骨架),
    // 面板必须能靠它们把状态文字、消息流、权限区、输入区都搭起来 ——
    // 少一个元素就少一块界面,而外面看不出来。
    const els = {
        panel: new El('section'), statusEl: new El('div'), retryBtn: new El('button'),
        messagesEl: new El('div'), inputEl: new El('textarea'), sendBtn: new El('button'),
        credentialEl: new El('div'),
    };
    const harness = makeBridge();
    const panel = createAgentPanel({
        els, bridge: harness.bridge, log: { warn() {}, error() {} },
        getNote: () => null, autoStart: true,
    });
    await panel.mount();
    await flush();

    assert.ok(textOf(els.statusEl).includes('Agent:'), '状态文字要补进 #agentStatus');
    assert.ok(els.messagesEl.children.length >= 2, '消息流与权限区要挂进 #agentMessages');
    // 输入区**必须挂在面板上**,不能挂进消息滚动区 —— 挂进去它就跟着消息一起滚,
    // 往上翻历史时输入栏会滚出视野(用户报的正是这个;实测输入栏落在 409–466 而面板到 755)
    const card = els.inputEl.parentNode?.parentNode ?? null;
    assert.ok(card !== null && String(card.className).includes('agent-footer'), '输入区要有一张卡片');
    assert.equal(card.parentNode, els.panel, '输入区必须是**面板**的孩子');
    assert.equal(els.messagesEl.children.includes(card), false,
        '输入区不许挂在 #agentMessages 里');
    // 按钮真的接着监听器(不是只画了个壳)
    await els.retryBtn.fire('click');
    await flush();
    assert.equal(harness.calls.filter(c => c.channel === 'agent:start').length, 2, '重试按钮要真的再连一次');
});

test('外壳只交出 8 个元素时,凭证卡片也要自己从空填成有内容', async () => {
    const els = {
        panel: new El('section'), statusEl: new El('div'), retryBtn: new El('button'),
        messagesEl: new El('div'), inputEl: new El('textarea'), sendBtn: new El('button'),
        credentialEl: new El('div'),
    };
    const harness = makeBridge({ credentials: { ok: false, source: null, reason: '没找到凭证' } });
    const panel = createAgentPanel({
        els, bridge: harness.bridge, log: { warn() {}, error() {} },
        getNote: () => null, autoStart: true,
    });
    await panel.mount();
    await flush();

    const shown = textOf(els.credentialEl);
    assert.equal(els.credentialEl.hidden, false);
    assert.match(shown, /没找到凭证/, '原因要填进去');
    assert.match(shown, /DEEPSEEK_API_KEY/, '怎么配也要填进去');
});

// ---------- 凭证卡片的机器可读状态(自检据此断言,见评审 F6)----------
//
// 自检**不能**断言"卡片有文字":面板构造时就把标题与 howto 写死了,那种断言恒真
// (实测就是这么假通过的)。机器可读的那一份是 `data-credential-ok`,由 invoke
// 返回之后写出;自检等它出现再按它分支断言。

test('creds 就绪:data-credential-ok="true" 且卡片从不写"未就绪"类文案', async () => {
    const { els } = await mountPanel({
        bridgeOf: makeBridge({ credentials: { ok: true, source: 'file', reason: null } }),
    });

    assert.equal(els.credentialEl.getAttribute('data-credential-ok'), 'true');
    assert.equal(els.credentialEl.hidden, true, '有凭证就收起卡片');
    const shown = textOf(els.credentialEl);
    assert.equal(/未就绪|没有找到|缺失/.test(shown), false,
        `有凭证时不许留下任何"未就绪"类文案(隐藏 ≠ 状态正确),实际:${JSON.stringify(shown)}`);
});

test('creds 缺失:data-credential-ok="false"、卡片可见、原因与"怎么配"都在', async () => {
    const reason = '没有找到 DEEPSEEK 凭证。设环境变量 DEEPSEEK_API_KEY,或者把它写进 .credentials.yaml。';
    const { els } = await mountPanel({
        bridgeOf: makeBridge({ credentials: { ok: false, source: null, reason } }),
    });

    assert.equal(els.credentialEl.getAttribute('data-credential-ok'), 'false');
    assert.equal(els.credentialEl.hidden, false);
    const shown = textOf(els.credentialEl);
    assert.match(shown, /没有找到 DEEPSEEK 凭证/, '原因要真的填进去(不是构造时那句死文案)');
    assert.match(shown, /DEEPSEEK_API_KEY/, '"怎么配"里要出现环境变量的名字');
});

test('creds 缺失但没给原因时也给一句中文,不留空', async () => {
    const { els } = await mountPanel({
        bridgeOf: makeBridge({ credentials: { ok: false, source: null, reason: null } }),
    });

    assert.equal(els.credentialEl.getAttribute('data-credential-ok'), 'false');
    assert.equal(els.credentialEl.hidden, false);
    assert.ok(textOf(els.credentialEl).trim().length > 0, '卡片不许是空白');
    assert.match(textOf(els.credentialEl), /缺少凭证|未就绪/, '要有说得出的一句话');
});

test('凭证频道失败时也填卡片并给出中文原因,而不是留一句 undefined', async () => {
    const harness = makeBridge();
    harness.bridge.invoke = async (channel) => {
        if (channel === 'agent:credentials') throw new Error('桥坏了');
        return { state: 'stopped', pid: null, error: null, restarts: 0, since: null };
    };
    const { els } = await mountPanel({ bridgeOf: harness });

    assert.equal(els.credentialEl.hidden, false, '取不到凭证状态时要把卡片亮出来说清楚');
    assert.equal(textOf(els.credentialEl).includes('undefined'), false);
    assert.match(textOf(els.credentialEl), /凭证/, '要说明白这是凭证这条路上的问题');
});

// ---------- 已经带着骨架启动(真外壳那条路) ----------
/** 按 index.html 的真实形状搭骨架:状态区里已经有重试/停进程按钮,
 *  消息流里已经有输入区(输入框 + 发送/取消)。 */
function fullSkeleton() {
    const panel = new El('section');
    const statusEl = new El('div');
    const retryBtn = new El('button');
    statusEl.appendChild(retryBtn);

    const credentialEl = new El('div');
    const messagesEl = new El('div');
    // 与真外壳(app/index.html)一致:卡片三行结构,而且 footer 是 messages 的**兄弟**
    const footer = new El('footer');
    footer.className = 'agent-footer';
    const ctxRow = new El('div');
    ctxRow.className = 'agent-ctx-row';
    // 连接中才显示提示，其余时间整行 hidden；骨架与 index.html 对齐。
    ctxRow.hidden = true;
    const ctxHint = new El('span');
    ctxHint.className = 'agent-ctx-hint';
    ctxHint.hidden = true;
    ctxRow.appendChild(ctxHint);
    footer.appendChild(ctxRow);
    const inputEl = new El('textarea');
    footer.appendChild(inputEl);
    const actRow = new El('div');
    actRow.className = 'agent-act-row';
    // 与 index.html 同形:动作行里只有**一颗球**(发送/取消合一,#agentStop 已撤)
    const sendBtn = new El('button');
    sendBtn.className = 'agent-orb';
    actRow.appendChild(sendBtn);
    footer.appendChild(actRow);

    panel.appendChild(statusEl);
    panel.appendChild(credentialEl);
    panel.appendChild(messagesEl);
    panel.appendChild(footer);

    return {
        panel, statusEl, retryBtn, credentialEl, messagesEl,
        inputEl, sendBtn, footer,
    };
}

test('外壳已经带好骨架时:不许再造一个输入框或一条输入行(方案 ③:输入区是**多行** textarea)', async () => {
    const els = fullSkeleton();
    const harness = makeBridge();
    const panel = createAgentPanel({
        els, bridge: harness.bridge, log: { warn() {}, error() {} },
        getNote: () => null, autoStart: true,
    });
    await panel.mount();
    await flush();

    assert.equal(els.panel.queryAll('textarea').length, 1, '整个面板里输入区只许有一个(方案 ③:多行 textarea)');
    assert.equal(els.panel.queryAll('.agent-footer').length, 1, 'footer 只许有一个');
    assert.equal(els.footer.parentNode, els.panel,
        '沿用原来那个 footer,不换节点 —— 但它的父节点是**面板**,不是消息区');
    assert.equal(els.messagesEl.children.includes(els.footer), false,
        '消息区里不许有输入区(有它就会跟着滚)');
    // 上下文信息不能丢,但**可见文字全删了**(用户要求):只走 title(悬停/读屏)与 data-ctx(机器可读)
    // 输入区现在**没有任何可见引导文字** —— placeholder 必须是空的。
    assert.equal(els.inputEl.placeholder, '', '没有任何可见引导文字(placeholder 空 —— 用户要求)');
    assert.match(String(els.inputEl.title ?? ''), /没有打开的笔记/, '信息改走 title(悬停可见 + 读屏)');
    assert.match(String(els.inputEl.title ?? ''), /没有打开的笔记/,
        '悬停那一下也要说同一件事(input.title)');
    // 原来的按钮仍然接着监听器(这条钉住"沿用节点也没把事件绑丢")。
    // 注意要 await 两次 flush:命令的 click 监听器返回的不是 promise
    // (面板里的箭头函数没 return),所以只能等异步落下去。
    els.inputEl.value = '骨架里发送';
    await els.sendBtn.fire('click');
    await flush();
    await flush();
    assert.equal(harness.calls.filter(c => c.channel === 'agent:send').length, 1, '沿用骨架后发送按钮必须仍然可用');
});

// ---------- 输入区必须贴底(方案 4:卡片式)----------
//
// 用户报的是"发送栏要固定在侧栏底部,它上面的空间全部用来显示对话"。
// 真应用里量出来的根因很具体:面板 456px、消息区一直撑到 406px,
// 而输入栏落在 409–466 —— 它在**消息滚动区内部**,所以跟着消息一起滚。

test('旧结构(输入区被放在消息区里)会被搬出来 —— 这是"输入栏跟着滚走"的根因', async () => {
    const panel = new El('section');
    const statusEl = new El('div');
    const messagesEl = new El('div');
    const footer = new El('footer');
    footer.className = 'agent-footer';
    const ctxRow = new El('div');
    ctxRow.className = 'agent-ctx-row';
    const inputEl = new El('textarea');
    footer.appendChild(ctxRow);
    footer.appendChild(inputEl);
    messagesEl.appendChild(footer);            // ← 旧形状:输入区在消息区里
    panel.appendChild(statusEl);
    panel.appendChild(messagesEl);

    const harness = makeBridge();
    const p = createAgentPanel({
        els: {
            panel, statusEl, retryBtn: new El('button'), messagesEl, inputEl,
            sendBtn: new El('button'),
            credentialEl: new El('div'),
        },
        bridge: harness.bridge, log: { warn() {}, error() {} },
        getNote: () => null, autoStart: false,
    });
    await p.mount();
    await flush();

    assert.equal(messagesEl.children.includes(footer), false,
        '必须把输入区从消息滚动区里搬出来(留在里面它就会跟着消息滚)');
    assert.equal(footer.parentNode, panel, '搬到面板下 —— 与消息区同级');
});

test('输入区是卡片(方案 ③):那一行平时**整行不占位**,输入区**没有可见引导文字**,上下文只走 title / aria-label / data-ctx 三条非视觉出口', async () => {
    const els = fullSkeleton();
    let note = null;
    const p = createAgentPanel({
        els, bridge: makeBridge().bridge, log: { warn() {}, error() {} },
        getNote: () => note, autoStart: false,
    });
    await p.mount();
    await flush();

    const ctxRow = els.footer.query('.agent-ctx-row');
    assert.ok(ctxRow !== null, '卡片顶端保留连接提示行');
    // 用户要求:那一行平时**什么都不常驻、整行 hidden** —— 连状态点也没有。
    assert.equal(els.panel.query('.agent-ctx-dot'), null, '状态点按用户要求删掉了');
    assert.equal(els.panel.query('.agent-ctx-key'), null, '「密钥」按钮按用户要求删掉了');
    assert.equal(els.panel.query('.agent-context'), null, '那行上下文文字也删掉了');
    assert.equal(ctxRow.children.length, 1, '那一行只保留连接提示');
    // ⚠️ 逐个按 class 查,不写 `.agent-ctx-row > *` —— 测试替身的选择器只支持
    // `.class` / `[attr]` / `TAGNAME` 三种(见 El.matches 的说明),子选择器它会**静默**匹配到 0 个。
    assert.notEqual(els.footer.query('.agent-ctx-hint'), null, '「正在连接…」那句在那一行里');
    assert.equal(els.footer.query('.agent-ctx-stop'), null, '输入卡片不再有停止进程按钮');
    for (const child of ctxRow.children) {
        assert.equal(child.hidden, true, `${child.className} 默认是隐藏的`);
    }
    assert.equal(ctxRow.hidden, true, '整行也默认 hidden(不占高度,聊天框上面才干净)');
    // ⚠️ 读 dataset 而不是 getAttribute:替身里这两份是各自独立的(真 DOM 才互通)
    assert.equal(els.footer.dataset.ctx, 'none',
        '没有打开的笔记 → none');
    assert.equal(els.inputEl.placeholder, '', '没有任何可见引导文字(placeholder 空 —— 用户要求)');
    assert.match(String(els.inputEl.title ?? ''), /没有打开的笔记/, '信息改走 title(悬停可见 + 读屏)');
    assert.match(String(els.inputEl.title ?? ''), /没有打开的笔记/, 'input.title 同样');

    note = { path: '甲篇.md', title: '甲篇', text: '正文' };
    p.syncNote();
    assert.equal(els.footer.dataset.ctx, 'note', '有笔记可带 → note');
    assert.match(String(els.inputEl.title ?? ''), /将带上笔记:甲篇/,
        '悬停那一下要给**完整**的那句(含笔记名)');
    // ⚠️ 可见文字按用户要求删了:placeholder 必须空,笔记名只走 title(悬停 + 读屏那条出口)
    assert.equal(els.inputEl.placeholder, '', 'placeholder 不许再有任何可见文字');
    assert.match(String(els.inputEl.title ?? ''), /甲篇/, '但 title 里必须带得出笔记名');
    assert.equal(els.footer.dataset.ctxText, '将带上笔记:甲篇',
        '原文也给一份机器可读的:断言不该依赖中文');
});
// ---------- 面板不显示连接状态(默认就是连接),失败改在对话里说 ----------
//
// 用户要求:「移除 Agent 状态显示,默认都是连接」。于是:
//   - 平时面板上**看不到**任何连接状态(状态文字只进视觉隐藏的 live 区,给读屏用);
//   - 但"连不上"必须看得见 —— 它改成对话里的一张提示卡,并把「重试」搬到卡上。

test('正常情况下面板里没有可见的连接状态文案(默认就是连接)', async () => {
    const { els, panel } = await mountPanel({});
    assert.equal(panel.state.status.state, 'ready');
    assert.equal(els.messagesEl.query('.agent-notice'), null,
        '连上了就不该有任何"关于连接"的东西占用视觉');
    // 状态文字仍然写进 live 区(读屏要用),但它靠 CSS 的 .agent-sr-only 隐藏
    assert.match(textOf(els.statusEl), /已连接/);
});

test('连接失败:对话里出现一张提示卡,并且「重试」被搬到卡上', async () => {
    const box = makeBox({
        ok: false, state: 'failed', message: '握手失败',
        snapshot: { state: 'failed', pid: null, error: '握手超时(20000ms)', restarts: 0, since: 1 },
    });
    const { els, panel } = await mountPanel({ bridgeOf: makeBridge({ startResult: box }) });
    assert.equal(panel.state.status.state, 'failed');

    const notice = els.messagesEl.query('.agent-notice');
    assert.ok(notice !== null, '连不上必须在对话里说清楚(否则用户打了字没反应,以为是自己没按对)');
    assert.match(textOf(notice), /连不上 Agent/);
    assert.match(textOf(notice), /握手超时/);
    assert.equal(els.retryBtn.parentNode, notice, '「重试」要搬到提示卡上(那里才是用户看的地方)');

    // 恢复之后:提示卡消失,「重试」回到隐藏的 live 区待命(节点不销毁,监听器还在)
    box.value = { ok: true, status: { state: 'ready', pid: 1, error: null, restarts: 0, since: 1, sessionId: null, busy: false } };
    await els.retryBtn.fire('click');
    await flush();
    assert.equal(panel.state.status.state, 'ready');
    assert.equal(els.messagesEl.query('.agent-notice'), null, '连上了就该把提示卡收掉');
    assert.equal(els.retryBtn.parentNode, els.statusEl, '「重试」回到 live 区里待命');
});

// ---------- 时间线排布:思考内联 + 一轮折一行 ----------
//
// 用户反馈的原话:「思考栏位置错误,每次思考都是在顶栏的思考栏,我希望每次思考的信息
// 都悬浮在输出信息前面」。根因在状态侧:三类条目原本存成三个平行数组,先后信息在归约
// 那一刻就丢了(修法是 app/lib/agent-stream.js 的 order)。这里钉的是**渲染侧**的规则:
//   · 思考:原样内联,就排在它那段输出前面(不合并、不置顶);
//   · 工具卡与**中间**回复:收进一行可折叠的摘要(D…SH 图二那行「N 次工具调用 ›」);
//   · 该轮**最后一条**回复留在组外 —— 答案不能被折进摘要里;
//   · 用户消息是分段的界,自己永不进组。

const { initialStreamState, reduceAgentEvent, beginPrompt } = await import('../app/lib/agent-stream.js');
const { planTimeline } = await import('../app/agent/panel.js');

const evUser = (text) => ({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } });
const evThink = (text) => ({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } });
const evText = (text) => ({ kind: 'update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
const evTool = (toolCallId, status = 'pending', title = 'read') => ({
    kind: 'update', sessionId: 's1',
    update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'read', status },
});
const evToolDone = (toolCallId) => ({
    kind: 'update', sessionId: 's1',
    update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
});
const foldAll = (events) => events.reduce(reduceAgentEvent, initialStreamState());

test('planTimeline:思考内联在自己那段输出之前,工具折成一组,最后一条回复留在组外', () => {
    const s = foldAll([evUser('你好呀'), evThink('先打招呼'), evTool('c1'), evToolDone('c1'), evText('你好!')]);

    const plan = planTimeline(s);

    assert.deepEqual(plan.map(u => u.kind), ['message', 'thought', 'group', 'message']);
    assert.equal(plan[0].message.text, '你好呀');
    assert.deepEqual(plan[2].tools.map(t => t.toolCallId), ['c1']);
    assert.equal(plan[3].message.text, '你好!', '最后那条回复必须留在组外 —— 答案不能被折起来');
});

test('planTimeline:这一轮还在跑(busy)时,工具折成一行,而且不急着说"没有回复"', () => {
    // ⚠️ busy 必须**真的立起来**(beginPrompt):「一轮结束了却没有正文」那条兜底
    //    判的就是 busy,拿一个裸状态(initialStreamState 的 busy=false)当"在跑"会误判。
    const s = [evTool('c1'), evTool('c2')]
        .reduce(reduceAgentEvent, beginPrompt(initialStreamState(), '做点事'));

    const plan = planTimeline(s);

    assert.deepEqual(plan.map(u => u.kind), ['message', 'group'], '还在跑:不许提前下"没有回复"的结论');
    assert.equal(plan[1].tools.length, 2);
    assert.equal(plan[1].messages.length, 0);
    assert.equal(plan[1].live, true, '还有工具没跑完 → live(界面上给个"运行中"的暗示)');
});

test('planTimeline:一轮结束却一条正文都没有 → 明说"这一轮没有文字回复"', () => {
    // 用户实测:一屏折叠条 + 一个字答案都没有,以为**消息丢了**。
    // 真相是那一轮模型一路调工具 + 思考就收尾了 —— 界面对此沉默才是问题。
    const s = [
        evTool('c1'), evToolDone('c1'), evThink('想一下'),
        evTool('c2'), evToolDone('c2'),
        { kind: 'prompt-end', sessionId: 's1' },
    ].reduce(reduceAgentEvent, beginPrompt(initialStreamState(), '做点事'));

    const plan = planTimeline(s);
    const last = plan[plan.length - 1];
    assert.equal(last.kind, 'noReply', '必须有一行明说"没有文字回复"');
    assert.equal(last.tools, 2, '被折起来的工具数要写进去(用户据此知道去哪看)');
    assert.equal(last.thoughts, 1);
});

test('planTimeline:用户消息是分段界,两轮的工具绝不混进同一组', () => {
    const s = foldAll([
        evUser('一'), evTool('c1'), evToolDone('c1'), evText('答一'),
        evUser('二'), evTool('c2'), evText('答二'),
    ]);

    const plan = planTimeline(s);

    assert.deepEqual(plan.map(u => u.kind), ['message', 'group', 'message', 'message', 'group', 'message']);
    assert.deepEqual(plan[1].tools.map(t => t.toolCallId), ['c1']);
    assert.deepEqual(plan[4].tools.map(t => t.toolCallId), ['c2']);
});

test('planTimeline:多步思考各自成条,后一步排在它前面的工具之后(位置要实)', () => {
    const s = foldAll([evThink('第一步'), evTool('c1'), evToolDone('c1'), evThink('第二步'), evText('答复')]);

    const plan = planTimeline(s);

    assert.deepEqual(plan.map(u => u.kind), ['thought', 'group', 'thought', 'message']);
    assert.equal(plan[0].thought.text, '第一步');
    assert.equal(plan[2].thought.text, '第二步');
});

test('planTimeline:状态里没有 order(旧快照)时退回旧的"三坨"顺序,一个条目都不许丢', () => {
    const s = foldAll([evThink('想想'), evTool('c1'), evText('答复'), evUser('再问'), evThink('再想')]);
    const legacy = { ...s, order: [] };

    const plan = planTimeline(legacy);
    const kinds = plan.flatMap(u => u.kind === 'group'
        ? [...u.tools.map(() => 'tool'), ...u.messages.map(() => 'message')]
        : [u.kind]);

    assert.equal(kinds.filter(k => k === 'thought').length, 2, '思考一条都不能少');
    assert.equal(kinds.filter(k => k === 'tool').length, 1);
    assert.equal(kinds.filter(k => k === 'message').length, 2);
});

test('方案B(界面):思考不再置顶,工具卡不再跑到用户消息上面', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evUser('你好呀')); await flush();
    bridge.emit(evThink('先打招呼')); await flush();
    bridge.emit(evTool('call-1')); await flush();
    bridge.emit(evToolDone('call-1')); await flush();
    bridge.emit(evText('你好!')); await flush();

    const stream = els.messagesEl.query('.agent-stream');
    // ⚠️ 渲染单元外面现在多包了一层 `.agent-turn`(轮次轨要按轮拿盒子算 offset)。
    // 顺序这件事仍然一样重要,所以断言下探到轮里面 —— 只是多了一层壳,不是换了顺序。
    const turn = stream.children[0];
    assert.equal(String(turn.className).split(' ')[0], 'agent-turn');
    assert.equal(turn.getAttribute('data-turn'), '0');
    assert.deepEqual(turn.children.map(c => String(c.className).split(' ')[0]),
        ['agent-msg', 'agent-think', 'agent-group', 'agent-msg'],
        '顺序必须是:用户 → 思考 → 摘要行 → 回复');
    assert.match(textOf(turn.children[0]), /你好呀/, '第一条是用户那句,工具卡不许跑到它上面');
});

test('方案B(界面):摘要行写着"N 次工具调用",卡片收在里面(点开才可见,但一直在 DOM 里)', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evTool('call-1')); await flush();
    bridge.emit(evTool('call-2')); await flush();

    const group = els.messagesEl.query('.agent-group');
    assert.ok(group !== null, '工具要收进一行摘要');
    assert.match(textOf(group), /2 次工具调用/);
    assert.equal(group.getAttribute('data-tool-count'), '2');
    assert.equal(group.getAttribute('open'), null, '默认收起');
    assert.equal(els.messagesEl.queryAll('.agent-tool').length, 2,
        '卡片必须仍在 DOM 里 —— 收起来只是视觉上折叠(details),不是把它们删掉');
    assert.equal(group.queryAll('.agent-tool').length, 2, '卡片挂在摘要行里');
});

test('方案B(界面):用户在摘要行上展开过之后,后续重画不许把它又合上', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evTool('call-1')); await flush();

    const group = els.messagesEl.query('.agent-group');
    group.open = true;                 // 真 DOM 里 details 被点开后 open 就是 true
    await group.fire('toggle');
    await flush();

    // 再来一条,触发一次整块重画
    bridge.emit(evTool('call-2')); await flush();

    const after = els.messagesEl.query('.agent-group');
    assert.equal(after.getAttribute('open'), '', '用户展开过就要保持展开(不能每次重画都复位)');
    assert.match(textOf(after), /2 次工具调用/, '重画之后计数也要跟上');
});

test('方案B(界面):工具全跑完之前摘要行标"运行中",跑完就不标了', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evTool('call-1')); await flush();
    assert.equal(els.messagesEl.query('.agent-group').getAttribute('data-live'), 'true');

    bridge.emit(evToolDone('call-1')); await flush();
    assert.equal(els.messagesEl.query('.agent-group').getAttribute('data-live'), 'false');
});

// 录屏中的真实入口是 AI 对话 generate_image，动效必须在折叠的工具栏外。
async function beginImageTool(t, status = 'in_progress') {
    const mounted = await mountPanel();
    t.after(() => mounted.panel.dispose());
    mounted.els.inputEl.value = '生成一张角色图';
    await mounted.panel.send();
    mounted.bridge.emit(evTool('image-call', status, 'generate_image'));
    await flush();
    return mounted;
}

test('AI 生图事件立即显示 D 动效，工具组收起时仍在折叠栏外', async (t) => {
    const { els } = await beginImageTool(t);
    const group = els.messagesEl.query('.agent-group');
    assert.equal(group.getAttribute('open'), null);
    const preview = els.messagesEl.query('.agent-image-generation');
    assert.ok(preview, '真实 generate_image 运行事件必须显示动效');
    assert.equal(preview.getAttribute('data-tool-call-id'), 'image-call');
    assert.equal(preview.getAttribute('role'), 'status');
    assert.match(textOf(preview), /正在生成图片/);
    for (let parent = preview.parentNode; parent; parent = parent.parentNode) {
        assert.notEqual(parent.tagName, 'DETAILS', '折叠工具不能隐藏生图动效');
    }
});

test('AI 生图 pending 到运行状态及正文更新保持同一个动效元素', async (t) => {
    const { bridge, els } = await beginImageTool(t, 'pending');
    const before = els.messagesEl.query('.agent-image-generation');
    assert.ok(before);
    bridge.emit({ kind: 'update', sessionId: 's1', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'image-call', status: 'in_progress',
    } });
    bridge.emit(evText('正在绘制。'));
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), before);
    assert.equal(els.messagesEl.queryAll('.agent-image-generation').length, 1);
});

test('AI 生图失败或取消时立即移除无结果动效', async (t) => {
    for (const status of ['failed', 'error', 'cancelled']) {
        await t.test(status, async (subtest) => {
            const { bridge, els } = await beginImageTool(subtest);
            assert.ok(els.messagesEl.query('.agent-image-generation'));
            bridge.emit({ kind: 'update', sessionId: 's1', update: {
                sessionUpdate: 'tool_call_update', toolCallId: 'image-call', status,
            } });
            await flush();
            assert.equal(els.messagesEl.query('.agent-image-generation'), null);
        });
    }
});

test('AI 生图完成后结果替换原框，正文重复图片不再显示，下一轮保留结果', async (t) => {
    const { bridge, els, panel } = await beginImageTool(t);
    const before = els.messagesEl.query('.agent-image-generation');
    bridge.emit(evToolDone('image-call'));
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), before, '工具完成后保留原框等图片链接');
    const url = 'https://example.test/generated.png';
    bridge.emit(evText(`图片已生成\n![角色图](${url})\n图片直链：${url}\n`));
    await flush();
    const image = before.query('img');
    assert.ok(image, '结果图片必须在原框里');
    assert.equal(image.getAttribute('src'), url);
    assert.equal(els.messagesEl.queryAll('img').filter(img => img.getAttribute('src') === url).length, 1);
    assert.equal(before.query('a').getAttribute('href'), url);
    await image.fire('load');
    assert.equal(before.getAttribute('data-state'), 'ready');
    assert.equal(before.query('.agent-generation-scene').hidden, true);
    bridge.emit({ kind: 'prompt-end', sessionId: 's1' });
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), before);
    els.inputEl.value = '继续';
    await panel.send();
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), before, '下一轮不丢历史结果框');
});

test('AI 生图结果追加到工具之前的回复时，加载失败仍保留查看原图入口', async (t) => {
    const { bridge, els, panel } = await mountPanel();
    t.after(() => panel.dispose());
    els.inputEl.value = '生成图片';
    await panel.send();
    bridge.emit(evText('先画一张。'));
    bridge.emit(evTool('g', 'in_progress', 'generate_image'));
    await flush();
    const before = els.messagesEl.query('.agent-image-generation');
    bridge.emit(evToolDone('g'));
    bridge.emit(evText('\n![图片](https://example.test/broken.png)\n'));
    bridge.emit({ kind: 'prompt-end', sessionId: 's1' });
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), before);
    const image = before.query('img');
    assert.ok(image);
    await image.fire('error');
    assert.equal(before.getAttribute('data-state'), 'error');
    assert.equal(before.query('a').getAttribute('href'), 'https://example.test/broken.png');
});

test('提示结束后移除未收尾的生图动画，下一轮不复活历史 pending 工具', async (t) => {
    const { bridge, els, panel } = await beginImageTool(t);
    assert.ok(els.messagesEl.query('.agent-image-generation'));
    bridge.emit({ kind: 'prompt-end', sessionId: 's1' });
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), null);
    els.inputEl.value = '继续聊天';
    await panel.send();
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), null);
});

test('取消或进程断开时停止生图动效，普通工具不触发它', async (t) => {
    const { bridge, els, panel } = await beginImageTool(t);
    assert.ok(els.messagesEl.query('.agent-image-generation'));
    await panel.cancel();
    assert.equal(els.messagesEl.query('.agent-image-generation'), null);
    els.inputEl.value = '读文件';
    await panel.send();
    bridge.emit(evTool('read-call', 'in_progress', 'read'));
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), null);
    bridge.emit(evTool('image-second', 'in_progress', 'generate_image'));
    await flush();
    assert.ok(els.messagesEl.query('.agent-image-generation'));
    bridge.emit({ kind: 'state', status: { state: 'crashed', pid: null, error: '连接断开' } });
    await flush();
    assert.equal(els.messagesEl.query('.agent-image-generation'), null);
});

// ---------- Markdown:只渲染**助手**的回复,而且只走建节点 ----------
//
// 用户反馈:「聊天页面无法渲染 Markdown 格式」。面板原本一律 textContent(那是为了
// "模型给的 `<img onerror=...>` 只能是文字"),所以修法不是放开 innerHTML,而是
// **把 Markdown 建成 DOM 节点**(app/lib/markdown.js 的 renderMarkdownNodes)。
//
// 三条边界在这里钉死:
//   1. 只有助手的回复排版 —— 用户气泡里是用户自己说的话,而且自检夹具回显的那条
//      带着 `当前笔记:…` + frontmatter 的 `---` 与 `# 甲篇`,排版会把它画成标题与分隔线;
//   2. 流式期间也渲染 Markdown，扫光容器独立保留，不随解析重建;
//   3. 排版之后,不可信内容**仍然**只能是文字节点。

const endTurn = { kind: 'prompt-end', sessionId: 's1', stopReason: 'end_turn' };

test('助手回复里的 Markdown 渲染成元素(粗体 / 行内代码 / 标题)', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evText('## 标题\n\n这是**加粗**与`代码`。')); await flush();
    bridge.emit(endTurn); await flush();

    const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
    assert.ok(bubble.query('h2') !== null, '## 要变成 h2');
    assert.ok(bubble.query('strong') !== null, '**加粗** 要变成 strong');
    assert.ok(bubble.query('code') !== null, '`代码` 要变成 code');
    assert.equal(textOf(bubble).includes('**'), false, '标记符号不许留在文字里');
    assert.equal(textOf(bubble).includes('##'), false);
});

test('助手回复里的围栏代码渲染成 pre>code,内容原样', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evText('```\nconst a = **1**;\n```')); await flush();
    bridge.emit(endTurn); await flush();

    const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
    const pre = bubble.query('pre');
    assert.ok(pre !== null, '围栏代码要变成 pre');
    // ⚠️ 用 textOf 而不是 .textContent:这个替身的 textContent 不聚合子节点
    // (真 DOM 才聚合),直接读会永远拿到空串 —— 断言看着通过、其实什么都没验。
    assert.equal(textOf(pre.query('code')), 'const a = **1**;', '代码块里不许解析标记');
    assert.equal(pre.query('strong'), null);
});

test('用户气泡**不**渲染 Markdown(那里是用户自己说的话,以及回显的笔记上下文)', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evUser('当前笔记:甲篇.md\n# 甲篇\n**不是加粗**')); await flush();

    const bubble = els.messagesEl.query('.agent-msg');
    assert.equal(bubble.query('h1'), null, '用户气泡里的 # 不许变成标题');
    assert.equal(bubble.query('strong'), null, '用户气泡里的 ** 不许变成粗体');
    assert.match(textOf(bubble), /\*\*不是加粗\*\*/, '原样显示');
});

test('流式期间实时排版 Markdown，扫光容器保持稳定', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evText('**正在输出的加粗**\n\n- 列表项')); await flush();

    const bubble = els.messagesEl.query('.agent-msg');
    assert.ok(bubble.query('.agent-sweep') !== null, '实时排版也应保留扫光');
    assert.ok(bubble.query('strong'), '不必等收尾就应渲染粗体');
    assert.ok(bubble.query('ul'), '不必等收尾就应渲染列表');
    assert.match(textOf(bubble), /正在输出的加粗/);

    bridge.emit(endTurn); await flush();
    assert.equal(els.messagesEl.query('.agent-sweep'), null, '收尾后扫光层撤掉');
});

test('排版之后,模型给的标签仍然只能是文字(不是元素、不带属性)', async () => {
    const { bridge, els } = await mountPanel();

    const evil = '<img src=x onerror="alert(1)">';
    bridge.emit(evText(`${evil} 与 **粗**`)); await flush();
    bridge.emit(endTurn); await flush();

    const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
    assert.ok(bubble.query('strong') !== null, '该渲染的还是要渲染');
    assert.equal(bubble.query('img'), null, '模型给的标签不许变成元素');
    assert.equal(bubble.queryAll('[onerror]').length, 0, '不许带上事件处理器属性');
    assert.match(textOf(bubble), /<img src=x onerror="alert\(1\)">/, '必须原样显示成文字');
});

test('多行回复只收成一条气泡,而且是**一条**带若干段落的回复', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(evText('第一段\n\n第二段')); await flush();
    bridge.emit(endTurn); await flush();

    assert.equal(els.messagesEl.queryAll('.agent-msg').length, 1, '一条回复不许拆成两条');
    const bubble = els.messagesEl.queryAll('.agent-msg')[0];
    assert.equal(bubble.queryAll('p').length, 2, '空行分段 → 两个段落');
});

// ---------- 提问卡:同一个回答通道,另一种卡片 ----------
//
// 模型的 ask_user_question 由桥映射成一次 session/request_permission(kind=question),
// 主进程把它标成 question=true 递过来。界面据此画**提问卡**:中性色 + 「提问」标记 +
// 选项下面那行说明 —— 免得用户以为是在授权。
//
// ⚠️ 回答走的还是 agent:permission 那条老路:**不新开频道、不动预加载白名单**。
// "恰好回答一次"的保证真正的落点是 answered 集合(与授权卡共用);按钮禁用那道可见的
// 第二防线已经随"答完就删"一起消失 —— 两类卡现在都是答完即从界面退场。

const questionEvent = (requestId = 'q-1') => ({
    kind: 'permission', requestId, question: true,
    toolCall: { toolCallId: 'ask:1', title: '实现方式:选 A 还是选 B?', kind: 'question' },
    options: [
        { optionId: 'q0', name: 'A:共用解析', kind: 'allow_once', description: '零重复,要动笔记预览那条路' },
        { optionId: 'q1', name: 'B:另写一份', kind: 'allow_once', description: '不碰笔记预览,维护两份' },
    ],
});

test('提问卡:question=true 画成「提问」卡,选项带说明,不是授权卡', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(questionEvent()); await flush();

    const card = els.messagesEl.query('.agent-question');
    assert.ok(card !== null, '要画成提问卡');
    assert.match(textOf(card), /提问/, '要有「提问」标记,别让人以为在授权');
    assert.match(textOf(card), /实现方式:选 A 还是选 B\?/, '题面要显示');
    assert.match(textOf(card), /A:共用解析/);
    assert.match(textOf(card), /零重复/, '选项说明要显示出来');
    assert.equal(els.messagesEl.query('.agent-permission'), null, '提问不该画成授权卡');
});

test('提问卡:点一个选项就走 agent:permission,而且卡**当场消失**(问完就没了)', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(questionEvent('q-7')); await flush();

    const card = els.messagesEl.query('.agent-question');
    assert.ok(card !== null, '点之前得先有卡');
    await card.queryAll('[data-option-id]')[1].fire('click');
    await flush();

    const answered = bridge.calls.filter((c) => c.channel === 'agent:permission');
    assert.deepEqual(answered.map((c) => c.payload), [{ requestId: 'q-7', optionId: 'q1' }],
        '回答走的还是 agent:permission 那条老路');

    // ⚠️ 这条原来断言的是"卡还在,只是被标成已决、按钮全禁用"(卡那时靠
    // shell.css 的 opacity .7 淡化)。产品改成**问完就消失** —— 判据因此从
    // "卡还在"翻成"卡不在了"。这不是放宽:「一个请求只许回答一次」的保证由
    // answered 集合兜着(下一条用例拿旧节点再点一次钉着),按钮禁用本来就只是
    // 第二道防线,而那第二道防线随卡一起消失了。
    assert.equal(els.messagesEl.query('.agent-question'), null,
        '答完的提问卡要从界面上消失,不是留在原地变灰');
    assert.equal(els.messagesEl.queryAll('.agent-question').length, 0);
});

test('提问卡:已经从界面上摘掉的那张卡再被点到也不发第二个回答', async () => {
    // 「恰好回答一次」原来靠"按钮禁用"这个**可见**证据。卡消失之后那个证据没有了,
    // 所以这里直接盯住真正的保证:answered 集合。手里攥着那张已经被摘掉的旧节点
    // (它的 click 监听器还在),再点两次 —— 一次也不许变成第二个 IPC。
    const { bridge, els } = await mountPanel();
    bridge.emit(questionEvent('q-9')); await flush();

    const stale = els.messagesEl.query('.agent-question');
    await stale.queryAll('[data-option-id]')[1].fire('click');
    await flush();
    assert.equal(els.messagesEl.query('.agent-question'), null, '答完就没了');
    await stale.queryAll('[data-option-id]')[0].fire('click');
    await flush();

    const answered = bridge.calls.filter((c) => c.channel === 'agent:permission');
    assert.equal(answered.length, 1, '同一个 requestId 只许回答一次');
    assert.deepEqual(answered[0].payload, { requestId: 'q-9', optionId: 'q1' },
        '后一次点击不许改写已经做出的决定');

    // 对端重发同一个 requestId 是常态:更不许把答完的卡"拉回来"。
    bridge.emit(questionEvent('q-9')); await flush();
    assert.equal(els.messagesEl.query('.agent-question'), null, '重发不许让答完的卡复活');
});

test('授权卡与提问卡寿命一致:答完的授权卡也不再留在界面上', async () => {
    // ⚠️ 这条原来叫「授权卡不受影响:答完提问之后,授权卡照旧留在原地(已决、按钮禁用)」
    //    —— 它钉的正是上一轮特意保留的那条差别。产品负责人现在要求两类一致
    //    ("这个请求完也删"),那条差别作废,所以这条用例**正面翻过来**。
    //
    // 这次改动的风险点仍在:两类卡共用 renderPermissions(),所以一次同时造出两种卡
    // (授权在前、提问在后,与真夹具同序),再分别回答 —— 消失的必须是"已决的那一张",
    // 不能顺手把还没回答的另一张也带走。
    const { bridge, els } = await mountPanel();
    bridge.emit(permissionEvent());
    bridge.emit(questionEvent('q-2'));
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-permission').length, 1);
    assert.equal(els.messagesEl.queryAll('.agent-question').length, 1);

    await els.messagesEl.query('.agent-permission').queryAll('[data-option-id]')[0].fire('click');
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-permission').length, 0, '答完的授权卡要消失');
    assert.equal(els.messagesEl.queryAll('.agent-question').length, 1,
        '还没回答的提问卡不许被顺手带走');

    await els.messagesEl.query('.agent-question').queryAll('[data-option-id]')[1].fire('click');
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-question').length, 0, '提问卡同样答完就消失');

    assert.deepEqual(
        bridge.calls.filter((c) => c.channel === 'agent:permission').map((c) => c.payload),
        [
            { requestId: 'req-1', optionId: 'allow-once' },
            { requestId: 'q-2', optionId: 'q1' },
        ],
        '两张卡各走一次既有的回答通道,一次不多一次不少',
    );
});

test('授权卡照旧:question 缺省(false)时仍然是权限卡那套', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit({
        kind: 'permission', requestId: 'p-1',
        toolCall: { toolCallId: 'call-1', title: '运行命令:git status', kind: 'execute' },
        options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
    }); await flush();

    assert.ok(els.messagesEl.query('.agent-permission') !== null, '没有 question 标记就还是授权卡');
    assert.equal(els.messagesEl.query('.agent-question'), null);
});

// ---------- 按需翻译:思考条上的双向换译 SVG ----------
//
// 模型偶尔仍会用英文思考(人设已经改成中文,但模型不是被保证的)。于是给思考条一个
// 「译」:点了才让桥翻一次(省钱),译文与原文都在,可随时切回去。**只有收尾的思考条
// 才有这个 chip** —— 还在流的那条翻了也是白翻。

const thinkEvent = (text) => ({
    kind: 'update', sessionId: 's1',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
});

/**
 * 按 data-act 的值找那个 chip。
 * ⚠️ 这个替身的选择器只支持 `.class` / `[attr]`(存在性)/ TAG —— **不支持
 * `[attr="值"]`**。写成 `query('[data-act="translate"]')` 会永远返回 null:
 * 断言"有它"就必失败,而断言"没有它"会**假通过**(其实什么都没验)。所以按值找要自己过滤。
 */
const chipOf = (strip, act) => strip.queryAll('[data-act]')
    .find((b) => b.getAttribute('data-act') === act) ?? null;

test('按需翻译:思考收尾后只显示一个 SVG 换译图标、不显示字数；点击只请求一次', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(thinkEvent('Let me check the handler first.')); await flush();
    bridge.emit(evText('看过了。')); await flush();      // 正文一到,思考收尾

    const strip = els.messagesEl.query('.agent-think');
    const chip = chipOf(strip, 'translate');
    assert.ok(chip !== null, '收尾后应有翻译入口');
    assert.ok(chip.query('svg'), '图标必须由矢量节点构成');
    assert.equal(textOf(chip), '', '不保留文字按钮');
    assert.equal(strip.queryAll('button').length, 1);
    assert.equal(strip.query('.agent-think-count'), null);
    assert.equal(chip.getAttribute('aria-label'), '翻译为中文');

    let prevented = false, stopped = false;
    await chip.fire('click', { preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    await chip.fire('click'); // 已经被摘下的旧节点也不能重复请求。
    await flush();

    assert.equal(prevented && stopped, true, '点击不能连带开合思考块');
    const busy = els.messagesEl.query('.agent-think-translate');
    assert.equal(busy.disabled, true);
    assert.equal(busy.getAttribute('aria-busy'), 'true');
    assert.equal(busy.getAttribute('data-state'), 'busy');

    const sent = bridge.calls.filter((c) => c.channel === 'agent:translate');
    assert.deepEqual(sent.map((c) => c.payload),
        [{ thoughtId: 't-1', text: 'Let me check the handler first.' }]);
});

test('按需翻译:流式中的思考条没有「译」(翻了也是白翻)', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(thinkEvent('还在想')); await flush();

    const strip = els.messagesEl.query('.agent-think');
    assert.ok(strip !== null, '先确认这条思考条真的在(否则下面那条断言是空转)');
    assert.equal(chipOf(strip, 'translate'), null);
    assert.equal(strip.query('.agent-think-count'), null);
    bridge.emit(thinkEvent('，继续补充')); await flush();
    assert.equal(textOf(els.messagesEl.query('.agent-think-body')), '还在想，继续补充', '删掉字数后流式思考正文仍原地更新');
});

test('按需翻译:翻译中 → 译文;可切回原文,再切回中文', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(thinkEvent('Let me check the handler first.')); await flush();
    bridge.emit(evText('看过了。')); await flush();

    bridge.emit({ kind: 'translation', thoughtId: 't-1', status: 'pending' }); await flush();
    const pending = els.messagesEl.query('.agent-think-translate');
    assert.equal(pending.getAttribute('data-state'), 'busy');
    assert.equal(pending.disabled, true);
    assert.equal(pending.getAttribute('aria-busy'), 'true');
    assert.equal(textOf(pending), '');

    bridge.emit({
        kind: 'translation', thoughtId: 't-1', status: 'done', text: '我先看一下这个处理函数。',
    }); await flush();

    let strip = els.messagesEl.query('.agent-think');
    assert.equal(strip.getAttribute('data-lang'), 'zh', '译好了默认显示中文');
    assert.equal(strip.getAttribute('open'), '', '译好了要自动展开,否则用户看不到结果');
    assert.match(textOf(strip), /我先看一下这个处理函数。/);
    assert.equal(textOf(strip).includes('Let me check'), false, '这时正文里不该还是英文');
    assert.equal(strip.queryAll('button').length, 1);
    assert.equal(chipOf(strip, 'src').getAttribute('aria-pressed'), 'true');

    await chipOf(strip, 'src').fire('click'); await flush();
    strip = els.messagesEl.query('.agent-think');
    assert.equal(strip.getAttribute('data-lang'), 'src');
    assert.match(textOf(strip), /Let me check the handler first\./, '切回原文要看到英文原文');
    assert.equal(strip.queryAll('button').length, 1);
    assert.equal(chipOf(strip, 'zh').getAttribute('aria-pressed'), 'false');

    await chipOf(strip, 'zh').fire('click'); await flush();
    strip = els.messagesEl.query('.agent-think');
    assert.equal(strip.getAttribute('data-lang'), 'zh');
    assert.match(textOf(strip), /我先看一下这个处理函数。/);
    assert.equal(bridge.calls.filter(call => call.channel === 'agent:translate').length, 0, '已缓存的中英文切换不重新翻译');
});

test('按需翻译:失败之后能重译(不许卡在一个永远转圈的「翻译中」)', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(thinkEvent('English thought')); await flush();
    bridge.emit(evText('好。')); await flush();

    bridge.emit({ kind: 'translation', thoughtId: 't-1', status: 'error', error: '模型调用超时' }); await flush();

    const strip = els.messagesEl.query('.agent-think');
    const retry = chipOf(strip, 'translate');
    assert.ok(retry.query('svg'));
    assert.match(retry.getAttribute('title'), /模型调用超时/);
    assert.match(retry.getAttribute('aria-label'), /重试/);
    assert.equal(retry.disabled, false);
    assert.equal(strip.getAttribute('data-translation'), 'error');
    assert.equal(chipOf(strip, 'src'), null, '没译成就不该有"原文/中文"的切换');
    await retry.fire('click'); await flush();
    assert.equal(bridge.calls.filter(call => call.channel === 'agent:translate').length, 1);
});

test('按需翻译:请求拒绝后恢复图标重试入口，不遗留永久忙态', async () => {
    const { bridge, els } = await mountPanel();
    bridge.emit(thinkEvent('English thought')); await flush();
    bridge.emit(evText('好。')); await flush();
    const invoke = bridge.invoke;
    bridge.invoke = (channel, payload) => channel === 'agent:translate'
        ? Promise.reject(new Error('连接已断开')) : invoke(channel, payload);
    await chipOf(els.messagesEl.query('.agent-think'), 'translate').fire('click');
    await flush();
    const retry = els.messagesEl.query('.agent-think-translate');
    assert.equal(retry.getAttribute('data-state'), 'error');
    assert.equal(retry.getAttribute('aria-busy'), 'false');
    assert.equal(retry.disabled, false);
    assert.match(retry.getAttribute('title'), /连接已断开/);
});

// ---------- 黏贴截图 ----------
//
// 用户要的是:在输入框里按 Ctrl+V 粘一张剪贴板里的图 → 输入区出现一张缩略图 chip
// (可删除)→ 点「发送」时这张图随提示一起给 agent。
//
// 这一组钉四件事:
//   1. 只有**含图片**的粘贴才被拦(粘文字照旧,一个字节都不碰);
//   2. chip 出现、可删、并且**全程建节点 + textContent**(截图是不可信输入);
//   3. 不合规的图(格式/大小)给一句可读的中文原因,不是静默丢;
//   4. 发送时主进程真的收到了 `{ mimeType, bytes }`,而且**叶子数据**之外什么都没有。

/** 一张能过校验的假 File(替身环境里没有真 File,只用到 type/size/name/arrayBuffer)。 */
function fakeImageFile({
    type = 'image/png', name = 'shot.png',
    bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
} = {}) {
    return {
        type,
        name,
        size: bytes.byteLength,
        async arrayBuffer() {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
    };
}

/** 造一份"剪贴板里有一张图"的 clipboardData(真 ClipboardEvent 的那两个字段)。 */
function clipboardWith(files, { withItems = true } = {}) {
    return {
        items: withItems
            ? files.map(f => ({ kind: 'file', type: f.type, getAsFile: () => f }))
            : [],
        files,
    };
}

/** 粘一张图。返回 preventDefault 有没有被调用(用它证"该拦的拦了")。 */
async function pasteInto(inputEl, clipboardData) {
    let prevented = false;
    await inputEl.fire('paste', {
        clipboardData,
        preventDefault: () => { prevented = true; },
    });
    await flush();
    return prevented;
}

test('黏贴一张图:输入区出现一张 chip(带文件名与删除按钮,而且带 aria-label)', async () => {
    const { els } = await mountPanel();

    const prevented = await pasteInto(els.inputEl, clipboardWith([fakeImageFile()]));

    const chips = els.panel.queryAll('.agent-image-chip');
    assert.equal(chips.length, 1, '应当出现一张 chip');
    assert.equal(prevented, true, '含图片的粘贴要被拦下(否则浏览器会去粘别的东西)');
    assert.match(textOf(chips[0]), /shot\.png/, 'chip 上要能看出是哪张图');
    const del = chips[0].query('.agent-image-del');
    assert.ok(del !== null, 'chip 上必须有删除按钮');
    assert.equal(del.getAttribute('aria-label'), '移除这张图:shot.png',
        '删除按钮要能键盘操作 —— aria-label 是它唯一的可读名字');
    assert.equal(chips[0].getAttribute('aria-label'), '已黏贴的截图:shot.png(image/png)');
    assert.equal(chips[0].getAttribute('data-image-chip'), 'image/png',
        '机器可读的那一份挂 data-image-chip 上,自检据此断言');
});

test('chip 那一段是**建节点**出来的:截图里的名字进不了元素(不可信输入)', async () => {
    const { els } = await mountPanel();
    const hostile = fakeImageFile({ name: '<img src=x onerror="alert(1)">.png' });

    await pasteInto(els.inputEl, clipboardWith([hostile]));

    const chip = els.panel.query('.agent-image-chip');
    assert.equal(chip.queryAll('img').length, 0,
        '文件名里的标签不许落地成元素(建节点 + textContent 的判据)');
    assert.match(textOf(chip), /<img src=x/, '它必须原样显示成文字');
});

test('点删除:chip 消失,而且不影响别的张', async () => {
    const { els } = await mountPanel();
    await pasteInto(els.inputEl, clipboardWith([
        fakeImageFile({ name: 'a.png' }),
        fakeImageFile({ name: 'b.png' }),
        fakeImageFile({ name: 'c.png' }),
    ]));
    assert.equal(els.panel.queryAll('.agent-image-chip').length, 3);

    const second = els.panel.queryAll('.agent-image-chip')[1];
    await second.query('.agent-image-del').fire('click');
    await flush();

    const names = els.panel.queryAll('.agent-image-chip').map(c => textOf(c));
    assert.equal(names.length, 2);
    assert.equal(names.some(t => t.includes('b.png')), false, '第 2 张应当被删掉');
    assert.equal(names.some(t => t.includes('a.png')), true, '第 1 张不许跟着没');
    assert.equal(names.some(t => t.includes('c.png')), true, '第 3 张不许被错位删掉');
});

test('粘**文字**不拦:不 preventDefault、不出现 chip、value 也不碰', async () => {
    const { els } = await mountPanel();

    // 一个只有文本的 clipboardData(items 里全是 string)
    const prevented = await pasteInto(els.inputEl, {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
        files: [],
    });

    assert.equal(prevented, false, '纯文字粘贴必须放行(拦了就把粘文本改坏了)');
    assert.equal(els.panel.queryAll('.agent-image-chip').length, 0);
});

test('剪贴板里没有图片也没有 files 时,paste 处理器不许抛', async () => {
    const { els } = await mountPanel();
    let prevented = false;
    await els.inputEl.fire('paste', { preventDefault: () => { prevented = true; } });
    await flush();
    assert.equal(prevented, false);
    assert.equal(els.panel.queryAll('.agent-image-chip').length, 0);
});

test('格式不在白名单:拒绝并**显示可读中文原因**,而不是静默丢掉', async () => {
    const { els } = await mountPanel();

    await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ type: 'image/bmp', name: 'x.bmp' })]));

    assert.equal(els.panel.queryAll('.agent-image-chip').length, 0, '不合规的图不许进列表');
    const notice = els.panel.query('.agent-image-notice');
    assert.ok(notice !== null, '被拒时必须有一行能看见的说明');
    assert.equal(notice.hidden, false, '被拒了就要亮出来');
    assert.match(textOf(notice), /不支持的图片格式/);
    assert.match(textOf(notice), /PNG \/ JPEG \/ WebP \/ GIF/);
});

test('单张超限:原因里给出这张多大、上限多少', async () => {
    const { els } = await mountPanel();
    const bytes = new Uint8Array(8);
    const huge = fakeImageFile({ bytes });
    huge.size = 11 * 1024 * 1024;              // 只骗 size —— 这一条测的是渲染层的即时判断

    await pasteInto(els.inputEl, clipboardWith([huge]));

    assert.equal(els.panel.queryAll('.agent-image-chip').length, 0);
    const notice = els.panel.query('.agent-image-notice');
    assert.match(textOf(notice), /超过单张上限 10\.0 MB/);
});

test('一次粘多张:合规的留下,不合规的那张单独说原因', async () => {
    const { els } = await mountPanel();

    await pasteInto(els.inputEl, clipboardWith([
        fakeImageFile({ name: 'ok.png' }),
        fakeImageFile({ type: 'image/svg+xml', name: 'bad.svg' }),
    ]));

    const chips = els.panel.queryAll('.agent-image-chip');
    assert.equal(chips.length, 1, '合规的那张要被收下');
    assert.match(textOf(chips[0]), /ok\.png/);
    assert.match(textOf(els.panel.query('.agent-image-notice')), /不支持的图片格式/);
});

test('下一次成功的黏贴会把上一次的拒绝原因收掉(不许留一句过期的话)', async () => {
    const { els } = await mountPanel();
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ type: 'image/bmp' })]));
    assert.equal(els.panel.query('.agent-image-notice').hidden, false);

    await pasteInto(els.inputEl, clipboardWith([fakeImageFile()]));

    assert.equal(els.panel.query('.agent-image-notice').hidden, true);
    assert.equal(els.panel.queryAll('.agent-image-chip').length, 1);
});

test('有 createObjectURL 时 chip 上真的挂缩略图,删掉时把 blob URL 释放掉', async () => {
    const { els } = await mountPanel();
    const urlApi = globalThis.URL;
    const created = [];
    const revoked = [];
    const original = urlApi.createObjectURL;
    const originalRevoke = urlApi.revokeObjectURL;
    urlApi.createObjectURL = (file) => { const u = `blob:fake/${file.name}`; created.push(u); return u; };
    urlApi.revokeObjectURL = (u) => { revoked.push(u); };
    try {
        await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'thumb.png' })]));

        const chip = els.panel.query('.agent-image-chip');
        const thumb = chip.query('.agent-image-thumb');
        assert.ok(thumb !== null, '有 createObjectURL 就该有缩略图');
        assert.equal(thumb.getAttribute('src'), 'blob:fake/thumb.png',
            'src 必须是我们自己造出来的 blob URL');
        assert.equal(created.length, 1);

        await chip.query('.agent-image-del').fire('click');
        await flush();
        assert.deepEqual(revoked, ['blob:fake/thumb.png'],
            '删掉那张图必须把它那条 blob URL 释放掉(不然一张一张攒着不回收)');
    } finally {
        urlApi.createObjectURL = original;
        urlApi.revokeObjectURL = originalRevoke;
    }
});

test('没有 createObjectURL 的环境里 chip 照样出现(退成一个占位方块,不是整块不工作)', async () => {
    const { els } = await mountPanel();
    const urlApi = globalThis.URL;
    const original = urlApi.createObjectURL;
    delete urlApi.createObjectURL;
    try {
        await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'no-thumb.png' })]));

        const chip = els.panel.query('.agent-image-chip');
        assert.ok(chip !== null);
        assert.equal(chip.query('img'), null, '造不出缩略图就不许挂一个空 src 的 img');
        assert.equal(chip.query('.agent-image-thumb-empty') !== null, true);
        assert.match(textOf(chip), /no-thumb\.png/);
    } finally {
        urlApi.createObjectURL = original;
    }
});

test('发送时把图片随提示一起交给 agent:payload 里是叶子数据 { mimeType, bytes }', async () => {
    const { els, bridge } = await mountPanel();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'shot.png', bytes })]));

    els.inputEl.value = '看这张图';
    await els.sendBtn.fire('click');
    await flush();

    const sent = bridge.calls.filter(c => c.channel === 'agent:send');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].payload.images.map(i => i.mimeType), ['image/png']);
    assert.deepEqual([...sent[0].payload.images[0].bytes], [...bytes],
        '送出去的必须是那张图**原来的字节**,不是缩略图、不是文件名');
    assert.match(sent[0].payload.text, /看这张图/);
    // ⚠️ 渲染进程只递叶子字段:主进程那边不接受路径/命令/环境变量,这里也不许塞。
    assert.deepEqual(Object.keys(sent[0].payload.images[0]).sort(), ['bytes', 'mimeType']);
});

// ---------- 发图之前的拦截:对端广告 image=false 时不许发 ----------
//
// 用户实测踩到的那条路:装机那份桥钉的模型(deepseek-v4-flash)没有声明图片输入,
// 它在 initialize 时广告 `promptCapabilities.image=false`,于是带图的提示被 -32602 拒掉,
// 界面弹出来的是一句英文 + IPC 包装("Error invoking remote method 'agent:send'…")。
// 现在:握手时把能力收进状态,发之前就拦住,而且说清为什么、下一步怎么办。

test('对端广告 image=false:发图被**发之前**拦住(不调 agent:send,图留在输入区)', async () => {
    const { els, bridge } = await mountPanel();
    bridge.emit({
        kind: 'session', sessionId: 's1',
        configOptions: [{ id: 'model', currentValue: 'deepseek-v4-flash' }],
        caps: { image: false, audio: false, embeddedContext: false },
    });
    await flush();
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'shot.png' })]));
    els.inputEl.value = '看这张图';

    await els.sendBtn.fire('click');
    await flush();

    assert.equal(bridge.calls.some(c => c.channel === 'agent:send'), false,
        '既然对方说了不收图片,就不该发出去(发出去只会换来一句 -32602)');
    const notice = els.panel.query('.agent-image-notice');
    assert.ok(notice !== null, '必须有一句看得见的说明');
    assert.match(textOf(notice), /不接受图片输入/);
    assert.match(textOf(notice), /deepseek-v4-flash/, '要说清是哪个模型(用户才知道该换哪个)');
    assert.equal(els.panel.queryAll('.agent-image-chip').length, 1, '图要留在输入区,别悄悄吞掉');
    assert.equal(els.inputEl.value, '看这张图', '这一次没发出去,打的字也不该被清掉');
});

test('对端广告 image=true(或还不知道):照旧发得出去', async () => {
    const { els, bridge } = await mountPanel();
    bridge.emit({ kind: 'session', sessionId: 's1', configOptions: [], caps: { image: true } });
    await flush();
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'ok.png' })]));
    els.inputEl.value = '这张能发';

    await els.sendBtn.fire('click');
    await flush();

    assert.equal(bridge.calls.filter(c => c.channel === 'agent:send').length, 1,
        '广告了图片能力就必须发得出去(拦截只在明确 false 时)');
});

test('发送之后 chip 清掉、输入框清空(图片不会被重复发第二次)', async () => {    const { els } = await mountPanel();
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile()]));
    els.inputEl.value = '看图';

    await els.sendBtn.fire('click');
    await flush();

    assert.equal(els.panel.queryAll('.agent-image-chip').length, 0, '图已经随着这一次提示走了');
    assert.equal(els.inputEl.value, '');
});

test('输入区为空、只有图片时也允许发送(黏贴一张截图直接发)', async () => {
    const { els, bridge } = await mountPanel();
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'only.png' })]));
    assert.equal(els.inputEl.value, '', '这条用例的前提:一个字都没打');

    await els.sendBtn.fire('click');
    await flush();

    const sent = bridge.calls.filter(c => c.channel === 'agent:send');
    assert.equal(sent.length, 1, '只有图片也必须发得出去');
    assert.equal(sent[0].payload.images.length, 1);
    assert.match(sent[0].payload.text, /只发了 1 张图片/, '提示正文里要说清"这次只有图、没有文字"');
    const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
    assert.equal(textOf(bubble), '（图片）', '空气泡看不出发生过什么,所以要给一句');
});

test('两样都空还是什么都不发(图片不能把"空提示"这条闸顶开)', async () => {
    const { els, bridge } = await mountPanel();
    els.inputEl.value = '   ';
    await els.sendBtn.fire('click');
    await flush();
    assert.equal(bridge.calls.some(c => c.channel === 'agent:send'), false);
});

test('主进程拒了这次发送时,原因要显示在输入区(而不是只写进日志)', async () => {
    const bridgeOf = makeBridge();
    const rejecting = {
        ...bridgeOf.bridge,
        async invoke(channel, payload = {}) {
            if (channel === 'agent:send') {
                bridgeOf.calls.push({ channel, payload });
                throw new Error('第 1 张图:字节不是 PNG / JPEG / WebP / GIF,已拒绝');
            }
            return bridgeOf.bridge.invoke(channel, payload);
        },
    };
    const { els } = await mountPanel({ bridgeOf: { ...bridgeOf, bridge: rejecting } });
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile()]));

    await els.sendBtn.fire('click');
    await flush();

    const notice = els.panel.query('.agent-image-notice');
    assert.equal(notice.hidden, false, '发不出去必须看得见');
    assert.match(textOf(notice), /这次没能发出去/);
    assert.match(textOf(notice), /字节不是 PNG/);
});

test('IPC 那层壳(Error invoking remote method …)不进提示行 —— 用户要看的是真正的原因', async () => {
    // 用户实测贴回来的原文就是这条:超时那次,提示行里最显眼的竟是通道名。
    const bridgeOf = makeBridge();
    const rejecting = {
        ...bridgeOf.bridge,
        async invoke(channel, payload = {}) {
            if (channel === 'agent:send') {
                bridgeOf.calls.push({ channel, payload });
                throw new Error("Error invoking remote method 'agent:send': Error: "
                    + '提示超时(180000ms 没有任何进展),已经请求对端取消');
            }
            return bridgeOf.bridge.invoke(channel, payload);
        },
    };
    const { els } = await mountPanel({ bridgeOf: { ...bridgeOf, bridge: rejecting } });
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile()]));

    await els.sendBtn.fire('click');
    await flush();

    const text = textOf(els.panel.query('.agent-image-notice'));
    assert.match(text, /没有任何进展/, '真正的原因必须在');
    assert.equal(/invoking remote method/.test(text), false, '通道名那层壳不该给用户看');
});

test('纯文字那条路**一个提示行都不多**:发送失败也不在输入区插话', async () => {
    const bridgeOf = makeBridge();
    const rejecting = {
        ...bridgeOf.bridge,
        async invoke(channel, payload = {}) {
            if (channel === 'agent:send') throw new Error('上一条提示还没有结束');
            return bridgeOf.bridge.invoke(channel, payload);
        },
    };
    const { els } = await mountPanel({ bridgeOf: { ...bridgeOf, bridge: rejecting } });
    els.inputEl.value = '只有文字';

    await els.sendBtn.fire('click');
    await flush();

    assert.equal(els.panel.query('.agent-image-notice').hidden, true,
        '没带图的发送失败走原来的路(prompt-error 在消息流里说),不许因此多一行');
});

test('图片读不出来时:中止这一次发送,并把原因说出来(不发一条少图的消息)', async () => {
    const { els, bridge } = await mountPanel();
    const broken = fakeImageFile({ name: 'broken.png' });
    broken.arrayBuffer = async () => { throw new Error('文件已经不可读'); };
    await pasteInto(els.inputEl, clipboardWith([broken]));
    els.inputEl.value = '看看';

    await els.sendBtn.fire('click');
    await flush();

    assert.equal(bridge.calls.some(c => c.channel === 'agent:send'), false,
        '读不出字节就不许发 —— 发了就是一条静默少了图的消息');
    assert.match(textOf(els.panel.query('.agent-image-notice')), /读不出来/);
    assert.equal(els.panel.queryAll('.agent-image-chip').length, 1, '图还留在输入区,用户可以重试');
});

test('dispose 时把还没发的缩略图 URL 释放掉', async () => {
    const { els, panel } = await mountPanel();
    const urlApi = globalThis.URL;
    const revoked = [];
    const original = urlApi.createObjectURL;
    const originalRevoke = urlApi.revokeObjectURL;
    urlApi.createObjectURL = () => 'blob:fake/dispose';
    urlApi.revokeObjectURL = (u) => { revoked.push(u); };
    try {
        await pasteInto(els.inputEl, clipboardWith([fakeImageFile()]));
        panel.dispose();
        assert.deepEqual(revoked, ['blob:fake/dispose']);
    } finally {
        urlApi.createObjectURL = original;
        urlApi.revokeObjectURL = originalRevoke;
    }
});

// ---------- 发出去的图要在**用户气泡**里回显 ----------
//
// 这一组钉住三件事:
//   1. 发送之后气泡里真的出现那张图,src 就是 chip 用的那条 blob: URL
//      (图本来就在渲染进程手里,不重走一遍主进程);
//   2. **发送时绝不撤销那条 URL** —— 它在发送那一刻移交给气泡了,撤销了就是一张破图;
//   3. 只发图没写字的气泡里**只有图**,不留一行空文本;纯文字那条路一点没变。

/** 装一次 URL.createObjectURL / revokeObjectURL 的替身(返回 created / revoked 两本账)。 */
function stubObjectUrls(names = []) {
    const urlApi = globalThis.URL;
    const created = [];
    const revoked = [];
    const original = urlApi.createObjectURL;
    const originalRevoke = urlApi.revokeObjectURL;
    urlApi.createObjectURL = (file) => {
        const u = names.length > 0 ? names[created.length] : `blob:fake/${file.name}`;
        created.push(u);
        return u;
    };
    urlApi.revokeObjectURL = (u) => { revoked.push(u); };
    return {
        created,
        revoked,
        restore() {
            urlApi.createObjectURL = original;
            urlApi.revokeObjectURL = originalRevoke;
        },
    };
}

test('发送之后那张图回显在**用户气泡**里:src 就是 chip 那条 blob: URL,而且发送时**不许**撤销它', async () => {
    const stub = stubObjectUrls();
    try {
        const { els } = await mountPanel();
        await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'shot.png' })]));
        els.inputEl.value = '看这张图';

        await els.sendBtn.fire('click');
        await flush();

        const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
        assert.equal(bubble.getAttribute('data-role'), 'user');
        const img = bubble.query('.agent-msg-image');
        assert.ok(img !== null, '用户气泡里必须有他发出去的那张图');
        assert.equal(img.tagName, 'IMG');
        assert.equal(img.getAttribute('src'), 'blob:fake/shot.png',
            'src 必须是 chip 那条 blob: URL(渲染层自己的 objectURL,不重走主进程)');
        assert.equal(img.getAttribute('alt'), 'shot.png', 'img 必须带 alt');
        assert.match(textOf(bubble), /看这张图/, '文字照旧在气泡里(图 + 文字一起)');
        assert.deepEqual(stub.created, ['blob:fake/shot.png'], '一张图只造一条 URL');
        assert.deepEqual(stub.revoked, [],
            '发送时**绝不许**撤销:URL 在这一刻移交给气泡了,撤销了气泡里就是一张破图');
    } finally {
        stub.restore();
    }
});

test('只发图不写字:气泡里只有图,没有多余的空文本行', async () => {
    const stub = stubObjectUrls();
    try {
        const { els } = await mountPanel();
        await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'only.png' })]));
        assert.equal(els.inputEl.value, '', '这条用例的前提:一个字都没打');

        await els.sendBtn.fire('click');
        await flush();

        const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
        assert.ok(bubble.query('.agent-msg-image') !== null, '图必须在气泡里');
        assert.equal(bubble.query('.agent-msg-text'), null,
            '不建文本层 —— 建了就是一个空 div,气泡里凭空多出一条空白高度');
        assert.equal(textOf(bubble), '', '气泡里一个字都不该有');
        assert.deepEqual(stub.revoked, [], '发送时不许撤销');
    } finally {
        stub.restore();
    }
});

test('一张图 + 一句话:图与文字同时都在气泡里(顺序:图在上,文字在下)', async () => {
    const stub = stubObjectUrls();
    try {
        const { els } = await mountPanel();
        await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'a.png' })]));
        els.inputEl.value = '这张怎么样';

        await els.sendBtn.fire('click');
        await flush();

        const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
        assert.equal(textOf(bubble), '这张怎么样', '气泡里只有用户自己那句话,没有占位文字');
        assert.ok(bubble.query('.agent-msg-image') !== null);
        const kinds = bubble.children.map(c => String(c.className).split(' ')[0]);
        assert.deepEqual(kinds, ['agent-msg-images', 'agent-msg-text'], '图在前、文字在后');
    } finally {
        stub.restore();
    }
});

test('纯文字那条路一个字节都没变:只有一个文本层、没有任何图片节点', async () => {
    const { els } = await mountPanel();

    els.inputEl.value = '只有文字';
    await els.sendBtn.fire('click');
    await flush();

    const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
    assert.equal(bubble.query('.agent-msg-images'), null, '没有图就不该有图片行');
    assert.equal(bubble.queryAll('.agent-msg-text').length, 1);
    assert.equal(textOf(bubble), '只有文字');
    assert.equal(bubble.queryAll('img').length, 0, '没有图就一个 img 都不许有');
});

test('发送之后 dispose:已经归气泡的那条 blob: URL 也要撤销(不然一张一张攒着)', async () => {
    const stub = stubObjectUrls();
    try {
        const { els, panel } = await mountPanel();
        await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'shot.png' })]));
        els.inputEl.value = '看图';

        await els.sendBtn.fire('click');
        await flush();
        assert.deepEqual(stub.revoked, [], '前提:发送时不许撤销');

        panel.dispose();
        assert.deepEqual(stub.revoked, ['blob:fake/shot.png'],
            'dispose 要把已经移交给气泡的那条也收掉');
    } finally {
        stub.restore();
    }
});

test('没造出 blob: URL 的环境里(createObjectURL 不可用)不会变成空气泡,退回旧文案', async () => {
    // ⚠️ 这条不是在测"应当这样",而是把**降级路径**钉住:拿不到 URL 就没有图可显示,
    // 此时气泡里至少要有一句说明,不许是一个什么都没有的空壳。
    const { els } = await mountPanel();
    await pasteInto(els.inputEl, clipboardWith([fakeImageFile({ name: 'no-thumb.png' })]));
    assert.equal(els.inputEl.value, '');

    await els.sendBtn.fire('click');
    await flush();

    const bubble = els.messagesEl.queryAll('.agent-msg').at(-1);
    assert.equal(bubble.query('.agent-msg-image'), null, '没有 URL 就不许挂一个空 src 的 img');
    assert.equal(textOf(bubble), '（图片）');
});

// ---------- 会话轮次导航轨(方案 D:状态语义轨)----------
//
// 纯逻辑(轮次/状态/当前轮/摘要)在 tests/agent-rail.test.js 里逐条钉着,这里钉的是
// **画出来与联动**那一半:格数、颜色类、aria、常显的当前轮、点击跳转、滚轮转发、
// 悬停摘要、以及"少于 2 轮不出现"。

/** 造一段"两轮 + 一轮带工具"的对话。 */
async function mountRail({ toolStatus = 'completed' } = {}) {
    const { bridge, els, panel } = await mountPanel();
    bridge.emit(evUser('第一问')); await flush();
    if (toolStatus !== null) { bridge.emit(evTool('c1', toolStatus)); await flush(); }
    bridge.emit(evText('答一')); await flush();
    bridge.emit(evUser('第二问')); await flush();
    bridge.emit(evText('答二')); await flush();
    return { bridge, els, panel };
}

test('轮次轨:一轮时整条隐藏,两轮时长出两格(一轮没有导航价值)', async () => {
    const { bridge, els } = await mountPanel();
    const rail = els.messagesEl.query('.agent-rail');
    assert.ok(rail !== null, '轨的元素要一直在(靠 hidden 控制显隐)');
    assert.equal(rail.hidden, true, '还没有对话:不显示');

    bridge.emit(evUser('只有一问')); await flush();
    bridge.emit(evText('答')); await flush();
    assert.equal(rail.hidden, true, '一轮:仍然不显示(常驻一列只会占视觉、把消息挤窄)');

    bridge.emit(evUser('再问一句')); await flush();
    assert.equal(rail.hidden, false, '两轮:出现');
    assert.equal(rail.queryAll('.tick').length, 2);
});

test('轮次轨:颜色类跟着这一轮的真实状态走(灰=正常/蓝=工具/红=失败)', async () => {
    // ⚠️ 这个替身的选择器只支持**单个类**(`.ok`,不支持 `.tick.ok`),所以按具体颜色类数。
    const ok = await mountRail({ toolStatus: null });
    const railA = ok.els.messagesEl.query('.agent-rail');
    assert.equal(railA.queryAll('.tick').length, 2);
    assert.equal(railA.queryAll('.ok').length, 2, '两轮都没有工具 → 都是正常(灰)');
    assert.equal(railA.queryAll('.tool').length, 0);

    const tool = await mountRail({ toolStatus: 'completed' });
    const railB = tool.els.messagesEl.query('.agent-rail');
    assert.equal(railB.queryAll('.tool').length, 1,
        '第一轮里有工具调用 → 蓝(第二格没有 → 灰)');
    assert.equal(railB.queryAll('.ok').length, 1);

    const failed = await mountRail({ toolStatus: 'failed' });
    const railC = failed.els.messagesEl.query('.agent-rail');
    assert.equal(railC.queryAll('.failed').length, 1, '工具失败 → 红');
    assert.equal(railC.queryAll('.ok').length, 1);
});

test('轮次轨:每格是可聚焦的 button,aria-label 用中文写出状态;整条轨有图例(a11y)', async () => {
    const { els } = await mountRail({ toolStatus: 'completed' });
    const rail = els.messagesEl.query('.agent-rail');
    assert.match(rail.getAttribute('aria-label'), /一格一轮/);
    assert.match(rail.getAttribute('aria-label'), /蓝=含工具调用/);
    const ticks = rail.queryAll('.tick');
    assert.deepEqual(ticks.map(t => t.tagName), ['BUTTON', 'BUTTON'], '每格必须是 button(可键盘聚焦)');
    assert.equal(ticks[0].getAttribute('aria-label'), '第 1 轮,含工具调用');
    assert.equal(ticks[1].getAttribute('aria-label'), '第 2 轮,正常');
    // 可访问性:颜色不是唯一的信息通道 —— 摘要与 aria-label 都把状态写成了中文
    assert.equal(/^[\x00-\x7F]*$/.test(ticks[0].getAttribute('aria-label')), false);
});

test('轮次轨:当前轮**常显**高亮(滚动条没了之后它是唯一的纵向指示物),不靠悬停', async () => {
    const { els } = await mountRail({ toolStatus: null });
    const rail = els.messagesEl.query('.agent-rail');
    const ticks = rail.queryAll('.tick');
    // 替身 DOM 里量不到 offsetTop → currentTurnIndex 给 0(第一轮),而不是 NaN
    assert.equal(ticks[0].className.includes('cur'), true, '第一格常亮');
    assert.equal(ticks[1].className.includes('cur'), false);
    assert.equal(rail.queryAll('.cur').length, 1, '当前轮只有一格');
    // 没有任何悬停动作,`cur` 已经在 DOM 里 —— 这就是"常显"
    assert.equal(ticks[0].getAttribute('aria-current'), 'true');
    assert.equal(ticks[0].query('.agent-rail-tip'), null, '常显的是高亮,不是摘要(摘要仍然靠悬停)');
});

test('轮次轨:点一格 → 平滑滚到那一轮(位置来自预计算的 offset)', async () => {
    const { els } = await mountRail({ toolStatus: null });
    const rail = els.messagesEl.query('.agent-rail');
    const turns = els.messagesEl.queryAll('.agent-turn');
    assert.equal(turns.length, 2);
    // 替身没有布局,手动给它一个 offsetTop(点击处理器是**当场**读的)
    turns[0].offsetTop = 40;
    turns[1].offsetTop = 300;
    els.messagesEl.scrollTop = 0;

    await rail.queryAll('.tick')[1].fire('click');
    assert.equal(els.messagesEl.scrollTop, 296, '跳转 = 那一轮的 offset 减 4');
    assert.match(rail.queryAll('.tick')[1].className, /cur/, '点完立刻高亮目标轮(不等平滑滚动结束)');

    await rail.queryAll('.tick')[0].fire('click');
    assert.equal(els.messagesEl.scrollTop, 36);
});

test('轮次轨:轨上的滚轮转发给消息区(纵向),横向滚轮不接也不拦截', async () => {
    const { els } = await mountRail({ toolStatus: null });
    const rail = els.messagesEl.query('.agent-rail');
    els.messagesEl.scrollTop = 100;
    let prevented = false;
    await rail.fire('wheel', { deltaY: 120, preventDefault: () => { prevented = true; } });
    assert.equal(els.messagesEl.scrollTop, 220, '纵向滚轮:消息区跟着滚');
    assert.equal(prevented, true, '要 preventDefault —— 否则浏览器会再滚一次(双倍)');

    prevented = false;
    const before = els.messagesEl.scrollTop;
    await rail.fire('wheel', { deltaX: 120, deltaY: 0, preventDefault: () => { prevented = true; } });
    assert.equal(els.messagesEl.scrollTop, before, '横向滚轮不是我们的手势');
    assert.equal(prevented, false, '不许把横向手势也拦掉');
});

test('轮次轨:悬停/聚焦给摘要(中文状态 + 问题;挂在面板上,不被滚动区裁掉)', async () => {
    const { els } = await mountRail({ toolStatus: 'completed' });
    const rail = els.messagesEl.query('.agent-rail');
    const tick = rail.queryAll('.tick')[0];
    assert.equal(els.panel.query('.agent-rail-tip'), null, '没悬停时不该有摘要');

    await tick.fire('mouseenter');
    const tip = els.panel.query('.agent-rail-tip');
    assert.ok(tip !== null, '摘要要挂在面板上(滚动区有 overflow,挂轨里会被裁掉)');
    assert.equal(els.messagesEl.query('.agent-rail-tip'), null);
    assert.equal(textOf(tip.query('.h')), '第 1 轮 · 含工具调用', '标题里用中文写出状态(图例藏在句子里)');
    assert.equal(textOf(tip.query('.q')), '第一问');
    assert.equal(tip.query('.s'), null, '没有真实耗时时不出现那一行');

    await tick.fire('mouseleave');
    assert.equal(els.panel.query('.agent-rail-tip'), null, '移开就收掉');
});

test('轮次轨:入场动效只给刚出现的那一格,而且**没有**轮内进度条(没有真分母就不画)', async () => {
    const { els } = await mountRail({ toolStatus: null });
    const rail = els.messagesEl.query('.agent-rail');
    const ticks = rail.queryAll('.tick');
    assert.equal(ticks.length, 2, '两轮');
    // 新轮入场:只有**刚出现的那一格**(最后那一格)带入场动效类
    assert.equal(rail.queryAll('.new').length, 1);
    assert.equal(ticks[1].className.includes('new'), true);
    assert.equal(ticks[0].className.includes('new'), false);
    // 没有 busy → 没有脉冲(脉冲是"正在生成"的信号,不许常亮)
    assert.equal(rail.queryAll('.live').length, 0);
    // demo 里 D 方案那根"轮内进度细条"**没有**落地:任何格子里都不该有它
    assert.equal(rail.queryAll('.gen').length, 0, '不许画假进度(生成正文没有分母)');
    // 状态还是按真实数据:这两轮都没有工具 → 灰(没有凭空多出颜色)
    assert.equal(rail.queryAll('.ok').length, 2);
});

test('撕裂层只在"连不上"时存在:进这一态才建,回 ready 就整体回收(不留常驻动画)', async () => {
    const { els, panel } = await mountPanel({ autoStart: false });
    const state = (name) => ({ kind: 'state', status: { state: name, pid: null, error: null, restarts: 0, since: null } });
    // 初始(未连接)= 已停止那张脸,而且**没有**撕裂层
    assert.equal(els.sendBtn.getAttribute('data-face'), 'stopped');
    assert.equal(els.sendBtn.queryAll('.agent-orb-tear').length, 0, '没进失败态就不该有撕裂层');

    panel.onEvent(state('failed'));
    await flush();
    assert.equal(els.sendBtn.getAttribute('data-face'), 'failed');
    assert.equal(els.sendBtn.queryAll('.agent-orb-tear').length, 1, '失败态要建撕裂层');
    assert.equal(els.sendBtn.query('.agent-orb-tear').children.length, TEAR_SLICES,
        `撕裂层要有 ${TEAR_SLICES} 条横片(用户看过的那一版)`);

    panel.onEvent(state('ready'));
    await flush();
    assert.equal(els.sendBtn.getAttribute('data-face'), 'idle');
    assert.equal(els.sendBtn.queryAll('.agent-orb-tear').length, 0,
        '离开失败态必须把整层回收 —— 留着就是 9 张脸副本 + 一堆动画在空耗');
});

test('状态脸:思考/流式/等待/长任务各自一张脸(判据全部来自已有字段)', async () => {
    const { els, panel } = await mountPanel();
    const state = (name) => ({ kind: 'state', status: { state: name, pid: null, error: null, restarts: 0, since: null } });
    assert.equal(els.sendBtn.getAttribute('data-face'), 'idle', 'ready 且没活 = 就绪');
    // 发一条 → 还没有内容 = 思考中;收到 chunk = 流式中
    els.inputEl.value = '问题';
    await els.inputEl.fire('keydown', { key: 'Enter' });
    await flush();
    assert.equal(els.sendBtn.getAttribute('data-face'), 'thinking', '发出去还没吐字 = 思考中');
    panel.onEvent({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回' } } });
    await flush();
    assert.equal(els.sendBtn.getAttribute('data-face'), 'streaming', '有内容在吐 = 流式中');
    panel.onEvent(state('starting'));
    await flush();
    assert.equal(els.sendBtn.getAttribute('data-face'), 'starting');
    // "等你决定"放最后:这样就不用去猜"权限卡被解决"是哪个事件名(形状未知就别写进测试)
    // 注意要先回 ready —— deriveFace 里 starting/stopped/failed 排在权限前面(它们更早、也更该优先)
    panel.onEvent(state('ready'));
    await flush();
    // 事件形状按 app/lib/agent-stream.js 的 case 'permission':requestId / toolCall / options 都在**事件本身**上
    panel.onEvent({ kind: 'permission', requestId: 'p1', toolCall: { title: '要写文件吗' }, options: [{ optionId: 'y', name: '允许' }] });
    await flush();
    assert.equal(els.sendBtn.getAttribute('data-face'), 'waiting', '有权限卡在等你决定(它比"连接中"更该被看见)');
});

test('状态脸:卡**答完**就不再是 waiting(已决条目留在 state 里,但不许再摆"等你决定")', async () => {
    // ⚠️ 这条钉的是**真窗口实测到的那条缺陷**:已决条目永远不会离开 state.permissions ——
    //    resolvePermission() 只标 resolved,prompt-end / hydrateFromLedger 都不清它
    //    (那份记录还兜着 answered 集合与"恰好回答一次"的保证,清它动的是回答通道,不是这张脸)。
    //    所以判据只能读"有没有**未决**的那一条"。
    //    按"数组里有条目"判的话:卡已经按产品要求从 DOM 消失、一轮也结束了,球还摆着"我在等你决定"。
    const { els, bridge } = await mountPanel();
    const face = () => els.sendBtn.getAttribute('data-face');
    assert.equal(face(), 'idle', '起手:ready 且没活 = 就绪');

    // 一轮在跑的时候来一张授权卡
    els.inputEl.value = '做点事';
    await els.inputEl.fire('keydown', { key: 'Enter' });
    await flush();
    bridge.emit(permissionEvent());
    await flush();
    assert.equal(face(), 'waiting', '有**未决**的卡在等你决定 —— 这张脸存在的理由,不许改坏');

    await els.messagesEl.query('.agent-permission').queryAll('[data-option-id]')[0].fire('click');
    await flush();
    const answered = face();
    assert.notEqual(answered, 'waiting', `卡答完脸不许还停在"等你决定"(实测缺陷;读到 ${answered})`);
    assert.equal(answered, 'thinking', '让位给这一轮真实在做的事:还没吐字 = 思考中');

    bridge.emit({ kind: 'prompt-end', sessionId: 's1' });
    await flush();
    assert.equal(face(), 'idle', '一轮结束 = 就绪那张脸(不是 waiting、也不是思考中)');
    assert.equal(els.panel.getAttribute('data-face'), 'idle', '面板上那份读数与球那颗一致');
});

test('状态脸:提问卡走同一条路 —— 答完不再是 waiting(两条路一致)', async () => {
    // 提问卡与授权卡共用 renderPermissions() / state.permissions,所以判据也必须共用。
    const { els, bridge } = await mountPanel();
    const face = () => els.sendBtn.getAttribute('data-face');
    bridge.emit(questionEvent('q-face'));
    await flush();
    assert.equal(face(), 'waiting', '提问卡同样是"在等你决定"');

    await els.messagesEl.query('.agent-question').queryAll('[data-option-id]')[0].fire('click');
    await flush();
    const answered = face();
    assert.notEqual(answered, 'waiting', `提问卡答完同样不许停在 waiting(读到 ${answered})`);
    assert.equal(answered, 'idle', '这次没在跑一轮 = 直接回到就绪');
});


test('输入区是 textarea:Enter 发送、Shift+Enter 换行、**IME 组合期间 Enter 一律不发送**', async () => {
    const { els } = await mountPanel();
    assert.equal(els.inputEl.tagName, 'TEXTAREA', '输入区是多行 textarea(方案 ③)');
    assert.equal(els.inputEl.getAttribute('rows'), '1', '起手一行高(多行能力在,占位不多)');
    els.inputEl.value = '组合中的候选';
    // 判据一:标准字段
    await els.inputEl.fire('keydown', { key: 'Enter', isComposing: true });
    assert.equal(els.inputEl.value, '组合中的候选', 'isComposing:true 时按 Enter 是"选字",不许发送');
    // 判据二:老式组合信号
    await els.inputEl.fire('keydown', { key: 'Enter', keyCode: 229 });
    assert.equal(els.inputEl.value, '组合中的候选', 'keyCode 229(老式"正在组合")也不许发送');
    // 判据三:compositionstart/end 标志(有些输入法在 end 之后紧跟一次 Enter,那时 isComposing 已变 false)
    await els.inputEl.fire('compositionstart', {});
    await els.inputEl.fire('keydown', { key: 'Enter' });
    assert.equal(els.inputEl.value, '组合中的候选', '组合中(start..end 之间)的 Enter 一律不发送');
    await els.inputEl.fire('compositionend', {});
    // Shift+Enter:textarea 的默认行为是换行,不许被拦成发送
    await els.inputEl.fire('keydown', { key: 'Enter', shiftKey: true });
    assert.equal(els.inputEl.value, '组合中的候选', 'Shift+Enter 是换行,不许发送');
    // 组合结束 + 普通 Enter:这才发送
    await els.inputEl.fire('keydown', { key: 'Enter' });
    assert.equal(els.inputEl.value, '', '组合结束后按 Enter 才发送(输入框清空)');
});

// ---------- 思考强度 / 模型那枚胶囊 ----------
//
// 数据全部来自对端的 configOptions(真机形状见 tests/agent-config.test.js),
// 界面只负责画与发请求。三条要守住的性质:
//   ① 收起态是**一个汉字**(当前档位的短名),展开态换成标签;
//   ② 点/键切档与点模型都走同一条 agent:setConfig,而且 `value` **原样透传**(不透明串);
//   ③ 在飞的一轮不许改;改失败要看得见,而且**不假装改成了**。

const CONFIG_EVENT = {
    kind: 'session', sessionId: 's1', caps: { image: false },
    configOptions: [
        {
            id: 'model', name: 'Model', category: 'model', type: 'select',
            currentValue: '["p","m1"]',
            options: [{
                group: 'p', name: '供应商 P',
                options: [
                    { value: '["p","m1"]', name: 'M-One', description: '第一个模型' },
                    { value: '["p","m2"]', name: 'M-Two' },
                ],
            }],
        },
        {
            id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
            currentValue: 'high',
            options: [
                { value: 'off', name: 'Off' }, { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' }, { value: 'max', name: 'Max' },
            ],
        },
    ],
};

test('胶囊:收起态一个字、展开态变标签;方向键切一档就走 agent:setConfig', async () => {
    const { els, bridge } = await mountPanel();
    bridge.emit(CONFIG_EVENT);
    await flush();

    assert.equal(els.configBtn.textContent, '中', '收起态显示当前档位的短名(high → 中)');
    assert.equal(els.configBtn.getAttribute('aria-expanded'), 'false');

    await els.configBtn.fire('click');
    await flush();
    assert.equal(els.configBtn.textContent, '思考强度', '展开态换成标签(否则用户不知道在调什么)');
    assert.equal(els.configBtn.getAttribute('aria-expanded'), 'true');
    const pop = els.configWrap.query('.agent-cfg-pop');
    assert.ok(pop !== null, '浮层挂在胶囊外层那个锚点上');
    assert.equal(pop.classList.contains('open'), true);
    // ⚠️ 替身的选择器只支持单个 token(.class / [attr] / TAG),不支持下代 —— 分两步查
    assert.deepEqual(pop.query('.agent-cfg-stops').queryAll('span').map((s) => s.textContent),
        ['关', '低', '中', '高'], '档位来自对端、短名按词典');

    // 方向键:high → max(不需要量像素,所以替身里也能确定性验证)
    await pop.query('.agent-cfg-track').fire('keydown', { key: 'ArrowRight' });
    await flush();
    const sent = bridge.calls.filter((c) => c.channel === 'agent:setConfig');
    assert.deepEqual(sent.map((c) => c.payload), [{ configId: 'reasoning_effort', value: 'max' }]);
});

test('模型清单:点标题进第二层,点一条走 agent:setConfig,value **原样透传**', async () => {
    const { els, bridge } = await mountPanel();
    bridge.emit(CONFIG_EVENT);
    await flush();
    await els.configBtn.fire('click');
    await flush();
    const pop = els.configWrap.query('.agent-cfg-pop');
    await pop.query('.agent-cfg-now').fire('click');       // 标题「中 ›」→ 模型层
    await flush();

    const rows = pop.queryAll('.agent-cfg-opt');
    assert.equal(rows.length, 2, '清单按对端给的条目数画');
    assert.equal(rows[0].classList.contains('on'), true, '当前模型打勾');
    assert.equal(pop.query('.agent-cfg-grp').textContent, '供应商 P', '分组名原样显示');

    await rows[1].fire('click');
    await flush();
    const sent = bridge.calls.filter((c) => c.channel === 'agent:setConfig');
    assert.deepEqual(sent.map((c) => c.payload),
        [{ configId: 'model', value: '["p","m2"]' }],
        '不透明值必须一个字符都不改地递回去(界面不许解析或拼装它)');
});

test('在飞的一轮不许改;改失败要看得见(抖动 + 写原因),绝不假装改成了', async () => {
    const harness = makeBridge();
    const origInvoke = harness.bridge.invoke.bind(harness.bridge);
    harness.bridge.invoke = async (channel, payload) => {
        if (channel === 'agent:setConfig') throw new Error('对端拒了:不认识这个值');
        return origInvoke(channel, payload);
    };
    const { els, panel } = await mountPanel({ bridgeOf: harness });
    harness.bridge.emit(CONFIG_EVENT);
    await flush();

    // ① 失败:抖动 + 脚下写原因 + 档位退回对端那一份(中,不是拖到的那个)
    await els.configBtn.fire('click');
    await flush();
    const pop = els.configWrap.query('.agent-cfg-pop');
    await pop.query('.agent-cfg-track').fire('keydown', { key: 'ArrowRight' });
    await flush();
    assert.equal(els.configBtn.classList.contains('shake'), true, '失败要抖一下');
    assert.match(pop.query('.agent-cfg-foot-text').textContent, /没改成/);
    assert.equal(els.configBtn.textContent, '思考强度');

    // ② 生成中:整枚禁用,点它不开浮层
    els.inputEl.value = '跑一轮';
    await panel.send();
    await flush();
    assert.equal(els.configBtn.disabled, true, 'busy 时整枚禁用(切换会动上下文)');
    await els.configBtn.fire('click');
    await flush();
    assert.equal(pop.classList.contains('open'), false, 'busy 时点它不该打开');
});

test('还没建会话时,浮层如实说"发一条消息之后才有"——不冤枉对端', async () => {
    // 实测踩到:新启动的 app 里点开胶囊,看到的是"对端没有给出思考强度这一项"。
    // 而照 kaiwu 的方式起真 dsh 问一次 session/new,对端**其实给了**四档
    // (off/low/high/max,currentValue=high)。差别在于:**会话是发第一条消息时才建的**,
    // 在那之前状态里根本没有 configOptions。两种"空"必须分开说。
    const { els } = await mountPanel();
    await els.configBtn.fire('click');
    await flush();
    const pop = els.configWrap.query('.agent-cfg-pop');
    assert.match(pop.query('.agent-cfg-desc').textContent, /发一条消息/);

    await pop.query('.agent-cfg-now').fire('click');       // 切到模型层
    await flush();
    assert.match(pop.query('.agent-cfg-empty').textContent, /发一条消息/);
});

test('会话建好但对端那份里确实没有:这时才说"没有广告"', async () => {
    const { els, bridge } = await mountPanel();
    bridge.emit({ kind: 'session', sessionId: 's1', configOptions: [] });
    await flush();
    await els.configBtn.fire('click');
    await flush();
    const pop = els.configWrap.query('.agent-cfg-pop');
    assert.match(pop.query('.agent-cfg-desc').textContent, /没有广告思考强度/);

    await pop.query('.agent-cfg-now').fire('click');
    await flush();
    assert.match(pop.query('.agent-cfg-empty').textContent, /对端没有给出模型清单/);
});

test('会话一到手,"还没建会话"那两句就不许再出现(自动建会话的正常路径)', async () => {
    // 产品行为:程序一启动(还没发消息)主进程就自动建好会话 → 胶囊立刻有档位。
    // 这一条钉的是"那句空态文案在正常路径上不再出现" —— 它是**结果读数**,
    // 不是"把文案删掉"(它在 agent 没连上/有东西坏掉时仍然是诚实的说法)。
    const { els, bridge } = await mountPanel();
    bridge.emit(CONFIG_EVENT);
    await flush();

    assert.equal(els.configBtn.textContent, '中', '收缩态直接是当前档位,不是"默"');
    await els.configBtn.fire('click');
    await flush();
    const pop = els.configWrap.query('.agent-cfg-pop');
    const desc = pop.query('.agent-cfg-desc').textContent;
    assert.doesNotMatch(desc, /还没建会话/, `desc=${desc}`);
    assert.match(desc, /High/, '展开态的说明来自对端那一档(不是空态文案)');
    assert.deepEqual(pop.query('.agent-cfg-stops').queryAll('span').map((s) => s.textContent),
        ['关', '低', '中', '高'], '滑块上是对端给的那几档');

    await pop.query('.agent-cfg-now').fire('click');
    await flush();
    assert.equal(pop.queryAll('.agent-cfg-opt').length, 2, '模型清单也在(不是那句空态)');
    assert.equal(pop.query('.agent-cfg-empty'), null, '正常路径上不该有"还没建会话"那一句');
});

test('自动建会话**失败**了:胶囊如实说原因(不是让用户对着"还没建会话"干等)', async () => {
    const { els, bridge } = await mountPanel();
    // 主进程在 ready 那一刻自动建会话失败时推的就是它(见 agent-runtime 的 autoCreateSession)。
    bridge.emit({ kind: 'session-error', message: '对端不肯建会话' });
    await flush();
    await els.configBtn.fire('click');
    await flush();

    const pop = els.configWrap.query('.agent-cfg-pop');
    const desc = pop.query('.agent-cfg-desc').textContent;
    assert.match(desc, /自动建会话失败/, `desc=${desc}`);
    assert.match(desc, /对端不肯建会话/, '原因来自主进程,不是界面编的');
    assert.match(desc, /再试一次/, '还得告诉用户出路(发一条消息会再试一次)');

    await pop.query('.agent-cfg-now').fire('click');
    await flush();
    assert.match(pop.query('.agent-cfg-empty').textContent, /自动建会话失败/);
});

test('失败之后真的建起了会话:那句"建会话失败"必须让位给对端的档位', async () => {
    // 否则界面会在会话明明可用时说"建会话失败" —— 那是同一个 bug 的镜像。
    const { els, bridge } = await mountPanel();
    bridge.emit({ kind: 'session-error', message: '对端不肯建会话' });
    await flush();
    bridge.emit(CONFIG_EVENT);
    await flush();

    await els.configBtn.fire('click');
    await flush();
    const pop = els.configWrap.query('.agent-cfg-pop');
    const desc = pop.query('.agent-cfg-desc').textContent;
    assert.doesNotMatch(desc, /自动建会话失败/, `desc=${desc}`);
    assert.equal(els.configBtn.textContent, '思考强度');
});

// ---------- 重连:唯一一件"非重连不可"的事(图片能力) ----------
//
// 桥在 initialize 那一刻算一次 imagePromptEnabled(判据:当前模型有没有声明图片输入),
// 之后整条连接都用那个值 —— `set_config_option` 换模型也**不重算**。
// 实测:用户已经切到视觉模型,界面仍在说"不接受图片输入"。所以要有那颗重连按钮。

test('caps.image=false 时浮层里有「重连以启用图片」;点了真的停进程再起(会话随之重来)', async () => {
    const { els, bridge, panel } = await mountPanel();
    bridge.emit({ kind: 'session', sessionId: 's1', configOptions: [], caps: { image: false } });
    await flush();
    await els.configBtn.fire('click');
    await flush();
    const pop = els.configWrap.query('.agent-cfg-pop');
    const renew = pop.query('.agent-cfg-renew');
    assert.ok(renew !== null, '要有一枚重连按钮');
    assert.equal(renew.hidden, false, '这条连接不能发图片 → 该露出来');

    await renew.fire('click');
    await flush();
    const channels = bridge.calls.map((c) => c.channel);
    assert.ok(channels.includes('agent:stop'), '重连 = 先停');
    assert.ok(channels.includes('agent:start'), '再起(重新握手 → 新能力)');
    // 重连之后"已知能力"必须先清成"还不知道",否则界面会拿旧值继续拦
    assert.equal(panel.state.caps, null, '重连后能力要重新学,不许拿旧值拦人');
});

test('caps.image=true 时那枚按钮藏起来(能发图片就没什么可重连的)', async () => {
    const { els, bridge } = await mountPanel();
    bridge.emit({ kind: 'session', sessionId: 's1', configOptions: [], caps: { image: true } });
    await flush();
    await els.configBtn.fire('click');
    await flush();
    const renew = els.configWrap.query('.agent-cfg-pop').query('.agent-cfg-renew');
    assert.equal(renew.hidden, true);
});

test('caps 事件单独一路:重连握手报回来的新能力会立刻替换旧的', async () => {
    const { bridge, panel } = await mountPanel();
    bridge.emit({ kind: 'session', sessionId: 's1', configOptions: [], caps: { image: false } });
    await flush();
    assert.equal(panel.state.caps.image, false);
    bridge.emit({ kind: 'caps', caps: { image: true, audio: false, embeddedContext: false } });
    await flush();
    assert.equal(panel.state.caps.image, true, '重连之后要按新能力走');
    bridge.emit({ kind: 'caps', caps: null });
    await flush();
    assert.equal(panel.state.caps, null, 'null = 还不知道(重连刚发生、新会话还没建)');
});

test('换模型之后会重新问一次图片能力,而且不拿旧能力继续拦', async () => {
    // 用户实测那条 bug:换成视觉模型之后,界面还在用**旧模型**的能力拒绝发图。
    // 所以换模型成功之后必须:(a) 把已知能力清成「还不知道」,(b) 向对端问一次新的。
    const { els, bridge, panel } = await mountPanel();
    bridge.emit({ kind: 'session', sessionId: 's1', configOptions: CONFIG_EVENT.configOptions, caps: { image: false } });
    await flush();
    assert.equal(panel.state.caps.image, false, '前提:这条连接一开始不能收图');

    await els.configBtn.fire('click');
    await flush();
    const pop = els.configWrap.query('.agent-cfg-pop');
    await pop.query('.agent-cfg-now').fire('click');           // 进模型层
    await flush();
    await pop.queryAll('.agent-cfg-opt')[1].fire('click');     // 切到第二个模型
    await flush();

    const asked = bridge.calls.findIndex((c) => c.channel === 'agent:capabilities');
    const switched = bridge.calls.findIndex((c) => c.channel === 'agent:setConfig');
    assert.ok(asked >= 0, '换完要问一次新能力');
    assert.ok(switched >= 0 && asked > switched, '先改模型、再问能力(反了会问到旧的)');
});

test('一轮结束却没有正文:对话里出现「这一轮没有文字回复」那一行(不是默默无闻)', async () => {
    // 用户实测:一屏「2 次工具调用 + 已思考」、一个字答案都没有,以为消息丢了。
    // 那一行就是"没有答案"的明说 —— 沉默才是问题。
    const { els, bridge, panel } = await mountPanel();
    els.inputEl.value = '做点事';
    await panel.send();                        // busy=true + 一条用户消息
    await flush();
    bridge.emit({
        kind: 'update', sessionId: 's1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', kind: 'read', status: 'completed' },
    });
    await flush();
    bridge.emit({ kind: 'prompt-end', sessionId: 's1' });
    await flush();

    const line = els.messagesEl.query('.agent-noreply');
    assert.ok(line !== null, '必须有一行明说(否则用户只能猜消息去哪了)');
    assert.match(line.textContent, /没有写文字回复/);
    assert.equal(line.getAttribute('data-tools'), '1', '被折起来的工具数要写进去');
});

// ---------------------------------------------------------------------------
// 「接着聊」:点一条历史会话之后,**整段历史铺回对话里**
//
// 为什么这条必须端到端钉:对端 `session/resume` **不重放旧消息**(只回 configOptions),
// 所以"点开旧会话看得到当时聊了什么"完全依赖开物自己把台账铺回来。这条链断了的表现是
// "点了一条会话,右边一片空白"—— 而接口层每一条单测都还是绿的。
// ---------------------------------------------------------------------------

test('接着聊:resumed 的会话事件 → 从台账把历史铺回对话(用户/思考/工具/回复都在)', async () => {
    const record = {
        id: 's-old',
        title: '上次那条',
        entries: [
            { kind: 'user', at: 1000, text: '上次我问的那句' },
            { kind: 'think', at: 2000, text: '上次的思考过程' },
            { kind: 'tool', at: 3000, id: 'tc-1', title: '读 文件', status: 'ok', toolKind: 'read' },
            { kind: 'reply', at: 4000, text: '上次的回复正文' },
            { kind: 'end', at: 5000, stopReason: 'end_turn' },
        ],
    };
    const bridgeOf = makeBridge({ sessionRecord: record });
    const { els, bridge } = await mountPanel({ bridgeOf });

    bridge.emit({ kind: 'session', sessionId: 's-old', configOptions: [], caps: null, resumed: true });
    await flush();
    await flush();

    // ⚠️ `.agent-msg` 是**两种角色共用**的类(agent-msg-user / agent-msg-assistant),
    //    所以"用户说了几句"必须按角色查 —— 否则那条回复也会被算成一条用户消息(实测踩到)。
    const bubbles = els.messagesEl.queryAll('.agent-msg-user');
    assert.equal(bubbles.length, 1, `历史里只有一条用户消息,实际 ${bubbles.length}`);
    assert.equal(textOf(bubbles[0]), '上次我问的那句');
    assert.equal(els.messagesEl.queryAll('.agent-think').length, 1, '思考条也要铺回来');
    assert.ok(els.messagesEl.queryAll('.agent-tool').length >= 1, '工具卡片也要铺回来');
    const answers = els.messagesEl.queryAll('.agent-msg-assistant');
    assert.equal(answers.length, 1, '回复也要铺回来');
    assert.equal(textOf(answers[0]), '上次的回复正文');
});

test('接着聊:历史里的图片只留张数,并**如实说出来**(不许留一个裂图)', async () => {
    const record = {
        id: 's-img', title: '带图的',
        entries: [
            { kind: 'user', at: 1000, text: '', images: 2 },
            { kind: 'reply', at: 2000, text: '看到了' },
            { kind: 'end', at: 3000, stopReason: 'end_turn' },
        ],
    };
    const { els, bridge } = await mountPanel({ bridgeOf: makeBridge({ sessionRecord: record }) });
    bridge.emit({ kind: 'session', sessionId: 's-img', configOptions: [], caps: null, resumed: true });
    await flush();
    await flush();
    const bubble = els.messagesEl.queryAll('.agent-msg-user')[0];
    assert.ok(bubble, '只发图没写字的那一条也要有一个气泡');
    assert.match(textOf(bubble), /2 张图/);
    assert.equal(bubble.querySelectorAll?.('img')?.length ?? 0, 0, '不许留一个没有源的 img');
});

test('接着聊:对端恢复失败(读不到台账)时留一段空白,而不是假装有历史', async () => {
    const bridgeOf = makeBridge({ sessionRecord: null });   // → {ok:false}
    const { els, bridge } = await mountPanel({ bridgeOf });
    bridge.emit({ kind: 'session', sessionId: 's-none', configOptions: [], caps: null, resumed: true });
    await flush();
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-msg').length, 0);
    assert.equal(els.messagesEl.queryAll('.agent-think').length, 0);
});

test('接着聊:铺历史**不许**动这条连接的现在(状态/能力还是当前那份)', async () => {
    const record = {
        id: 's-old', title: 'x',
        entries: [{ kind: 'user', at: 1, text: '旧话' }, { kind: 'end', at: 2, stopReason: 'end_turn' }],
    };
    const { els, bridge } = await mountPanel({ bridgeOf: makeBridge({ sessionRecord: record }) });
    bridge.emit({ kind: 'state', status: { state: 'ready', pid: 4242, error: null, restarts: 0, since: 1 } });
    bridge.emit({ kind: 'caps', caps: { image: true } });
    bridge.emit({ kind: 'session', sessionId: 's-old', configOptions: [], caps: { image: true }, resumed: true });
    await flush();
    await flush();
    assert.equal(els.panel.dataset.agentState, 'ready', '历史不是"进程状态",不许把它改了');
    // 状态没被历史搅乱:发得出去(按钮不是灰的)
    assert.equal(els.sendBtn.disabled, false);
});

test('新建会话:fresh 公告 → 对话区清空,但连接状态不许动', async () => {
    const { els, bridge } = await mountPanel();
    bridge.emit({ kind: 'state', status: { state: 'ready', pid: 4242, error: null, restarts: 0, since: 1 } });
    bridge.emit({ kind: 'caps', caps: { image: true } });
    bridge.emit(evText('上一轮的回话')); await flush();
    bridge.emit(endTurn); await flush();
    assert.equal(els.messagesEl.queryAll('.agent-msg').length, 1, '先有内容才谈得上清空');

    bridge.emit({ kind: 'session', sessionId: 's-new', configOptions: [], fresh: true });
    await flush();
    assert.equal(els.messagesEl.queryAll('.agent-msg').length, 0, '新会话应当是空的');
    assert.equal(els.messagesEl.queryAll('.agent-think').length, 0);
    assert.equal(els.panel.dataset.agentState, 'ready', '换会话不是换连接 —— 状态不许被清成别的');
    assert.equal(els.sendBtn.disabled, false, '照样能发');
    assert.equal(els.panel.dataset.sessionId, 's-new', '当前会话换成新的了');
});

test('新建会话:fresh 之后再来的增量进的是**新**会话(旧会话的残留不许混进来)', async () => {
    const { els, bridge } = await mountPanel();
    bridge.emit({ kind: 'session', sessionId: 's-old', configOptions: [], caps: null });
    bridge.emit(evText('旧会话的一句')); await flush();
    bridge.emit({ kind: 'session', sessionId: 's-new', configOptions: [], fresh: true });
    await flush();
    // 旧会话迟到的一条增量:必须被丢掉(面板里那条守卫管的就是它)
    bridge.emit({ kind: 'update', sessionId: 's-old', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '迟到的' } } });
    await flush();
    bridge.emit({ kind: 'update', sessionId: 's-new', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '新会话的' } } });
    await flush();
    const answers = els.messagesEl.queryAll('.agent-msg-assistant');
    assert.equal(answers.length, 1);
    assert.match(textOf(answers[0]), /新会话的/);
});
