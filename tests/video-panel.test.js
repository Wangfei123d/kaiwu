import { test } from 'node:test';
import assert from 'node:assert/strict';

// 视频理解的**渲染层**入口:拖/粘贴 → 草稿 → 点发送 → IPC(只递叶子字段)→ 消息流。
//
// 照 agent-panel.test.js 的写法自己造 DOM 替身,不引 jsdom、不起 Electron。
// 这一组钉的是这次交互改动的**要害**:
//   1. 拖入/粘贴**只是草稿** —— 一次 IPC 都不发(更不碰网络),消息流里一条记录都不留;
//   2. 草稿可移除,移除后再发送**不会**触发视频调用;
//   3. 只有「发送」才触发;有字用那段字当提问,没字用默认问法;
//   4. 结果作为一条助手消息进消息流,与那条带视频卡的用户消息语义对得上(不是两条记录);
//   5. 文件名是不可信输入:只许进 textContent,一个字符都不许落地成元素。

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
        child.parentNode = this;
        this.children.push(child);
        this.firstChild = this.children[0] ?? null;
        return child;
    }
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
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    /** classList 替身:面板优先走 classList(真 DOM 的做法,见 panel.js 的 setClass),
     *  所以替身也得有它 —— 否则测试跑的是回退分支,真机上那条路没人验。 */
    get classList() {
        const self = this;
        const parts = () => String(self.className ?? '').split(/\s+/).filter(p => p !== '');
        return {
            toggle(name, on) {
                const list = parts();
                const has = list.includes(name);
                const want = on === undefined ? !has : on === true;
                if (want && !has) list.push(name);
                if (!want && has) list.splice(list.indexOf(name), 1);
                self.className = list.join(' ');
                return want;
            },
            contains(name) { return parts().includes(name); },
        };
    }
    focus() { this.ownerDocument.activeElement = this; }
    async fire(type, event = {}) {
        for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, ...event });
    }
    matches(child, sel) {
        // ⚠️ 支持 `.a.b` 这种**复合**类选择器:方案 C 的状态行是靠
        // `stage-row doing/done/failed` 两个类一起表达状态的(自检也是这么断言的),
        // 只认单个类就没法钉住"那一行红没红"。
        if (sel.startsWith('.')) {
            const want = sel.slice(1).split('.').filter(part => part !== '');
            const have = String(child.className).split(/\s+/);
            return want.every(name => have.includes(name));
        }
        if (sel.startsWith('[') && sel.endsWith(']')) return child.getAttribute(sel.slice(1, -1)) !== null;
        return child.tagName === sel.toUpperCase();
    }
    query(sel) {
        for (const child of this.children) {
            if (this.matches(child, sel)) return child;
            const deep = child.query?.(sel);
            if (deep) return deep;
        }
        return null;
    }
    queryAll(sel, out = []) {
        for (const child of this.children) {
            if (this.matches(child, sel)) out.push(child);
            child.queryAll?.(sel, out);
        }
        return out;
    }
}

/** 文本节点替身:助手回复走的是**建节点**那版 Markdown 渲染器,它要用 createTextNode。 */
class TextNode {
    constructor(text) {
        this.nodeType = 3;
        this.tagName = '#text';
        this.className = '';
        this.textContent = String(text);
        this.children = [];
        this.parentNode = null;
        this.attrs = {};
    }
    setAttribute() {}
    getAttribute() { return null; }
    query() { return null; }
    queryAll() { return []; }
}

const doc = {
    activeElement: null,
    createElement(tag) { return new El(tag, doc); },
    createTextNode(text) { return new TextNode(text); },
    // 文档级事件:AI 面板靠它接收"请理解一段本地视频"(B站下载队列那类面板发过来的)
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
        const list = this.listeners[type] ?? [];
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
    },
    dispatchEvent(event) {
        for (const fn of this.listeners[event?.type] ?? []) fn(event);
        return true;
    },
};
globalThis.document = doc;

const { createAgentPanel } = await import('../app/agent/panel.js');

const flush = () => new Promise(r => setTimeout(r, 0));

/** 子树里的全部文字(替身的 textContent 不聚合子节点)。 */
function textOf(node) {
    if (node === null || node === undefined) return '';
    let out = String(node.textContent ?? '');
    for (const child of node.children ?? []) out += textOf(child);
    return out;
}

/** 一段"真的"mp4:判据看的就是开头这几个字节(ftyp/isom)。 */
const MP4_HEAD = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];

function makeFile(name, type, size = 4096, head = null) {
    const bytes = new Uint8Array(size);
    bytes.set(head ?? (String(type).startsWith('video/') ? MP4_HEAD : [0x61]), 0);
    return {
        name,
        type,
        size,
        async arrayBuffer() { return bytes.buffer; },
    };
}

/** 桥替身:记下每个频道的入参,回一个可编程的结果。
 *
 *  `statusBox.value` 是**可变**的:保存/清除密钥之后 video:status 会跟着变 ——
 *  这样"状态读数以主进程为准"这件事才是真的在测(而不是面板自己拼一句好看的话)。
 *  `keySave` / `keyClear` 控制那两个通道的返回或抛错。 */
function makeBridge({ videoStatus = null, understandResult = null, statusBox = null, keySave = null, keyClear = null, cancelResult = null } = {}) {
    const calls = [];
    const box = statusBox ?? { value: null };
    const bridge = {
        async invoke(channel, payload = {}) {
            calls.push({ channel, payload });
            if (channel === 'agent:status') return { state: 'stopped', pid: null, error: null, restarts: 0, since: null };
            if (channel === 'agent:credentials') return { ok: true, source: 'env', reason: null };
            if (channel === 'video:status') {
                return box.value ?? videoStatus ?? {
                    ok: true, source: 'env', storage: 'plain', reason: null,
                    model: 'qwen3-vl-flash', models: [], maxTokens: 800,
                    maxVideoBytes: 67108864, maxVideosPerPrompt: 1, inlineLimitBytes: 19922944,
                    audioNotice: '注意:这个模型只看画面、听不到声音 —— 对话、旁白与背景音乐都不在理解范围内。',
                    mimeLabel: 'MP4 / MOV / WebM / MKV',
                };
            }
            if (channel === 'video:key:set') {
                if (keySave !== null) return keySave(payload);
                // 默认:存成密文,并把"已配(设置文件)"写进 status(模拟主进程的真实行为)
                box.value = {
                    ok: true, source: 'settings', storage: 'encrypted', reason: null,
                    model: 'qwen3-vl-flash', models: [], maxTokens: 800,
                    maxVideoBytes: 67108864, maxVideosPerPrompt: 1, inlineLimitBytes: 19922944,
                    audioNotice: '听不到声音', mimeLabel: 'MP4 / MOV / WebM / MKV',
                };
                return { ok: true, storage: 'encrypted' };
            }
            if (channel === 'video:key:clear') {
                if (keyClear !== null) return keyClear(payload);
                box.value = {
                    ok: false, source: null, storage: 'plain', reason: '没有配置 DashScope 密钥。',
                    model: 'qwen3-vl-flash', models: [], maxTokens: 800,
                    maxVideoBytes: 67108864, maxVideosPerPrompt: 1, inlineLimitBytes: 19922944,
                    audioNotice: '听不到声音', mimeLabel: 'MP4 / MOV / WebM / MKV',
                };
                return { ok: true };
            }
            if (channel === 'video:cancel') {
                return cancelResult ?? { ok: true };
            }
            if (channel === 'video:understand') {
                return understandResult ?? {
                    ok: true,
                    text: '一个红方块从左向右移动。',
                    model: 'qwen3-vl-flash',
                    requestId: 'chatcmpl-1',
                    usage: { promptTokens: 352, completionTokens: 231, totalTokens: 583, videoTokens: 322 },
                    delivery: { mode: 'inline', bytes: 4096 },
                };
            }
            return {};
        },
        onAgentEvent() { return () => {}; },
        // 方案 C 的进度推送:替身把订阅者收起来,测试里手动喂事件(与真主进程推的是同一份形状)
        onVideoEvent(handler) {
            bridge.videoHandlers.push(handler);
            return () => {
                const at = bridge.videoHandlers.indexOf(handler);
                if (at >= 0) bridge.videoHandlers.splice(at, 1);
            };
        },
        /** 推一条进度事件给所有订阅者(等价于主进程那次 webContents.send)。 */
        emitVideo(event) {
            for (const handler of bridge.videoHandlers.slice()) handler(event);
        },
        videoHandlers: [],
        calls,
    };
    return { bridge, calls, statusBox: box };
}

async function mountPanel(bridgeOf, { logs = null } = {}) {
    const els = {
        panel: new El('section'), statusEl: new El('div'), retryBtn: new El('button'),
        messagesEl: new El('div'), inputEl: new El('textarea'), sendBtn: new El('button'),
        credentialEl: new El('div'), killBtn: new El('button'),
    };
    const sink = logs ?? [];
    const panel = createAgentPanel({
        els, bridge: bridgeOf.bridge,
        log: { warn: (...a) => sink.push(a.join(' ')), error: (...a) => sink.push(a.join(' ')) },
        getNote: () => null, autoStart: false,
    });
    await panel.mount();
    await flush();
    return { els, panel, logs: sink };
}

/** 造一个"拖放事件"的替身:dataTransfer 的形状与浏览器一致(items / files / types)。 */
function dragData(files) {
    return {
        items: files.map(f => ({ kind: 'file', type: f.type, getAsFile: () => f })),
        files,
        types: files.length > 0 ? ['Files'] : ['text/plain'],
    };
}

const videoCalls = (calls) => calls.filter(c => c.channel.startsWith('video:'));

// ---------- 核心:拖入只是草稿 ----------

test('拖进来一段 mp4:只出现草稿,**一次 IPC 都不发**(不发 video:status、更不发视频理解)', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    const baseline = bridgeOf.calls.length;          // 挂载本身会问 agent:status / agent:credentials

    assert.equal(panel.addVideo(makeFile('vu-synth.mp4', 'video/mp4')), true);

    // 卡片是**同步**建起来的:拖进来立刻就该看到它
    const row = els.panel.query('.agent-video-row');
    assert.ok(row !== null && row.hidden === false, '草稿卡片必须立刻出现');
    const cardText = textOf(row);
    assert.ok(cardText.includes('vu-synth.mp4'), '卡片上要有文件名');
    assert.ok(cardText.includes('听不到声音'), '卡片上必须常驻音频说明');
    // 卡片上不许有第二个触发点(点一下就能花钱的按钮)
    assert.equal(row.query('.btn'), null, '卡片上不该有「理解」按钮:触发点只有「发送」');

    // 给它足够的机会去偷偷发一次请求
    await flush(); await flush(); await flush(); await flush();

    assert.equal(videoCalls(bridgeOf.calls).length, 0, '拖入阶段不许发任何 video: 请求');
    assert.equal(bridgeOf.calls.length, baseline, '拖入阶段一个 IPC 都不该多出来');
    assert.equal(panel.state.messages.length, 0, '消息流里不该留下任何记录');
    assert.equal(els.messagesEl.queryAll('.agent-msg-video').length, 0);
    assert.equal(panel.pendingVideo?.name, 'vu-synth.mp4');
});

test('拖入之后「发送」必须可点(Agent 没连上也能发 —— 视频理解不经过 Agent)', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    // 挂载后 Agent 是 stopped:没有草稿时发送按钮本来就是灰的
    assert.equal(els.sendBtn.disabled, true);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    assert.equal(els.sendBtn.disabled, false, '有草稿时发送必须可点');
});

test('点发送才触发:输入框为空时用**默认问法**,并作为提问发出去', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    assert.equal(videoCalls(bridgeOf.calls).length, 0);

    await els.inputEl.fire('keydown', { key: 'Enter' });     // 与点「发送」同一条路
    await flush(); await flush(); await flush();

    const calls = bridgeOf.calls.filter(c => c.channel === 'video:understand');
    assert.equal(calls.length, 1);
    assert.match(calls[0].payload.question, /用中文详细描述这段视频/);
    // 气泡里显示的就是**真正发出去**的那一句(不是"〔视频理解〕xxx"那种占位)
    assert.match(panel.state.messages[0].text, /用中文详细描述这段视频/);
});

test('输入框里有字时,那段字就是提问;发出去之后输入框清空', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    els.inputEl.value = '第几秒开始动?';
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    await flush();

    await panel.send();
    await flush(); await flush();

    const call = bridgeOf.calls.find(c => c.channel === 'video:understand');
    assert.equal(call.payload.question, '第几秒开始动?');
    assert.equal(panel.state.messages[0].text, '第几秒开始动?');
    assert.equal(els.inputEl.value, '');
});

// ---------- 草稿可移除,移除后不触发 ----------

test('草稿上有一个移除按钮:点了它草稿消失,而且**不发任何请求**', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));

    const del = els.panel.query('.agent-video-del');
    assert.ok(del !== null, '草稿上必须有移除按钮(误拖一个 60MB 的视频不能只能靠清空输入框)');
    assert.match(del.getAttribute('aria-label'), /移除这个视频:a\.mp4/);
    await del.fire('click');
    await flush();

    assert.equal(panel.pendingVideo, null);
    assert.equal(els.panel.query('.agent-video-row').hidden, true, '移除后整行收起来');
    assert.equal(videoCalls(bridgeOf.calls).length, 0);
    assert.equal(panel.state.messages.length, 0);
});

test('移除草稿之后再点发送:什么也不发生(不触发视频调用,也不留记录)', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    await els.panel.query('.agent-video-del').fire('click');

    await panel.send();
    await panel.sendVideo();            // 直接调也不许触发(草稿已经没了)
    await flush(); await flush();

    assert.equal(videoCalls(bridgeOf.calls).length, 0, '没有草稿就不该有任何 video: 请求');
    assert.equal(panel.state.messages.length, 0, '没有草稿就不该留下任何消息');
});

test('格式不对/太大:拒绝并给一句可读中文,一次请求都不发', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    assert.equal(panel.addVideo(makeFile('x.avi', 'video/avi')), false);
    const notice = els.panel.query('.agent-video-notice');
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /不支持的视频格式/);
    assert.match(notice.textContent, /MP4 \/ MOV \/ WebM \/ MKV/);

    assert.equal(panel.addVideo(makeFile('huge.mp4', 'video/mp4', 64 * 1024 * 1024 + 1)), false);
    assert.match(notice.textContent, /超过单段上限/);
    assert.equal(videoCalls(bridgeOf.calls).length, 0, '被拒时不该发任何 video 请求');
});

test('一次只放一段草稿:第二段被拒(服务端一次只听一段)', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    assert.equal(panel.addVideo(makeFile('b.mp4', 'video/mp4')), false);
    assert.match(els.panel.query('.agent-video-notice').textContent, /一次只能理解 1 段/);
});

// ---------- 结果进消息流 ----------

test('发送成功:结果作为一条**助手消息**进消息流,视频卡挂在同一条用户消息上', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('vu-synth.mp4', 'video/mp4'));
    await panel.send();
    await flush(); await flush();

    const state = panel.state;
    assert.equal(state.messages.length, 2, '一条用户消息(带视频卡)+ 一条助手回答');
    assert.equal(state.messages[0].role, 'user');
    assert.equal(state.messages[0].video.name, 'vu-synth.mp4');
    assert.equal(state.messages[1].role, 'assistant');
    assert.equal(state.messages[1].text, '一个红方块从左向右移动。');
    assert.equal(state.messages[1].usage.videoTokens, 322);
    assert.equal(state.busy, false);
    assert.equal(panel.pendingVideo, null, '草稿已经交给气泡了');

    // 界面上真的画出来了。⚠️ 消息流挂在 els.messagesEl 下,草稿行挂在 footer(= els.panel)下
    const streamText = textOf(els.messagesEl);
    assert.ok(streamText.includes('一个红方块从左向右移动。'));
    assert.ok(streamText.includes('视频 322 tokens'));
    assert.ok(streamText.includes('vu-synth.mp4'));
    assert.equal(els.messagesEl.queryAll('.agent-msg-video').length, 1);
    assert.equal(els.panel.query('.agent-video-row').hidden, true);
});

test('失败:原因显示出来,红在**具体那一段**,而且不留一条看着像回答的助手消息', async () => {
    const bridgeOf = makeBridge({
        understandResult: { ok: false, code: 'auth_failed', reason: '鉴权失败:密钥不对。', status: 401 },
    });
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    await panel.send();
    await flush(); await flush();

    const state = panel.state;
    // ⚠️ 判据从"一条助手消息都不许有"收紧成"不许有**看着像回答**的助手消息":
    // 方案 C 的失败态要留一份"走到哪一步断的"清单,所以那条占位气泡会留下 ——
    // 但它一个字正文都没有,而且断点那一行是红的。笼统一句"理解失败"被消掉了。
    const assistants = state.messages.filter(m => m.role === 'assistant');
    assert.equal(assistants.filter(m => m.text !== '').length, 0, '失败不该塞一条有正文的助手气泡');
    assert.equal(assistants.length, 1, '留下的那条是状态行占位');
    assert.equal(assistants[0].stages.find(s => s.key === 'prepare').state, 'failed', '鉴权失败红在「准备请求」');
    assert.equal(state.error.stage, 'prepare');
    assert.match(state.error.message, /鉴权失败/);
    assert.equal(state.busy, false);
    assert.match(els.panel.query('.agent-video-notice').textContent, /鉴权失败/);
    // 界面上真的画出了那一行红的(自检与用户看的是同一处)
    assert.equal(els.messagesEl.queryAll('.stage-row.failed').length, 1);
});

test('缺密钥那次失败:把配置入口亮出来,并读出状态(来源/存法,不含值)', async () => {
    const bridgeOf = makeBridge({
        understandResult: { ok: false, code: 'missing_key', reason: '没有配置 DashScope 密钥。', status: null },
    });
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    await panel.send();
    await flush(); await flush();

    const keyRow = els.panel.query('.agent-video-key');
    assert.ok(keyRow !== null && keyRow.hidden === false);
    assert.match(els.panel.query('.agent-video-notice').textContent, /没有配置 DashScope 密钥/);
    // 卡片上是**叶子读数**(来源 + 存法),永远不含密钥值
    const status = textOf(keyRow);
    assert.match(status, /密钥:已配置\(环境变量\)/);
    assert.equal(status.includes('sk-'), false);
    // 缺密钥这一步会读 video:status(读数以主进程为准)
    assert.ok(bridgeOf.calls.some(c => c.channel === 'video:status'));
});

test('图片和视频同时待发:明说不能一起发,而且两边都不发出去', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    // 借图片那条路塞一张待发图片(用它的公开入口:粘贴)
    const png = makeFile('shot.png', 'image/png', 64, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await els.inputEl.fire('paste', {
        clipboardData: {
            items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
            files: [png],
            types: ['Files'],
        },
    });
    await flush();
    await panel.send();
    await flush();

    assert.match(els.panel.query('.agent-video-notice').textContent, /不能同时带图片和视频/);
    assert.equal(videoCalls(bridgeOf.calls).length, 0);
    assert.equal(panel.state.messages.length, 0);
    assert.equal(panel.pendingVideo?.name, 'a.mp4', '草稿要留着让用户处理');
});

test('发送在飞的时候不许重入(点两次只发一次)', async () => {
    let release = null;
    const bridgeOf = makeBridge();
    const original = bridgeOf.bridge.invoke.bind(bridgeOf.bridge);
    bridgeOf.bridge.invoke = async (channel, payload) => {
        if (channel === 'video:understand') await new Promise((r) => { release = r; });
        return await original(channel, payload);
    };
    const { panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const first = panel.send();
    await flush();
    const before = bridgeOf.calls.filter(c => c.channel === 'video:understand').length;
    await panel.sendVideo();            // 第二次:此刻还在飞,必须被挡住
    assert.equal(panel.videoBusy, true);
    assert.equal(bridgeOf.calls.filter(c => c.channel === 'video:understand').length, before);
    release?.();
    await first;
    await flush(); await flush();
    assert.equal(panel.videoBusy, false);
});

// ---------- 不可信输入 ----------

test('HTML 改名成 mp4:发送时读到字节就拦下(不发 IPC、不留消息、草稿收掉)', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    // 字节不是 mp4,但声明的类型是 —— 判据看的是**字节**
    const fake = makeFile('evil.mp4', 'video/mp4', 64, [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);
    assert.equal(panel.addVideo(fake), true, '加草稿这一步只看声明与大小(字节还没读)');
    await flush();
    await panel.send();
    await flush();

    const notice = els.panel.query('.agent-video-notice');
    assert.match(notice.textContent, /字节不是/);
    assert.match(notice.textContent, /MP4 \/ MOV \/ WebM \/ MKV/);
    assert.equal(videoCalls(bridgeOf.calls).length, 0, '不该把假视频递出去');
    assert.equal(panel.pendingVideo, null, '草稿要收掉');
    assert.equal(panel.state.messages.length, 0, '消息流里不该留下一条"我递了视频"');
    assert.equal(els.panel.query('.agent-video-row').hidden, true);
});

test('文件名是不可信输入:带标签的名字只出现为文字,一个元素都不许落地', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    const nasty = '<img src=x onerror=alert(1)>.mp4';
    panel.addVideo(makeFile(nasty, 'video/mp4'));
    await flush();
    await panel.send();
    await flush(); await flush();

    // 卡片与消息流里都不许出现 img 节点
    assert.equal(els.panel.queryAll('img').length + els.messagesEl.queryAll('img').length, 0);
    // 名字本身照旧看得见(只是当文字):它在消息流那条视频卡上
    assert.ok(textOf(els.messagesEl).includes(nasty));
    // 也没有任何节点被塞了 innerHTML(替身没有这个属性 —— 塞过就会留下痕迹)
    for (const node of [...els.panel.queryAll('div'), ...els.messagesEl.queryAll('div')]) {
        assert.equal(Object.prototype.hasOwnProperty.call(node, 'innerHTML'), false);
    }
});

test('粘贴:含视频的粘贴变成草稿(不拦文字粘贴,也不发请求)', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);

    let prevented = false;
    await els.inputEl.fire('paste', {
        clipboardData: dragData([makeFile('a.mp4', 'video/mp4')]),
        preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true, '含视频的粘贴必须拦下(否则浏览器会拿它做别的事)');
    await flush(); await flush(); await flush();
    assert.equal(panel.pendingVideo?.name, 'a.mp4', '粘贴的应该是草稿');
    assert.equal(videoCalls(bridgeOf.calls).length, 0, '粘贴阶段不许发请求');

    let textPrevented = false;
    await els.inputEl.fire('paste', {
        clipboardData: { items: [], files: [], types: ['text/plain'] },
        preventDefault() { textPrevented = true; },
    });
    assert.equal(textPrevented, false, '纯文字粘贴一个字节都不许改');
});

test('拖放:带文件的拖放被拦下(dragover 与 drop 都拦),不带文件的拖放一概不碰', async () => {
    const bridgeOf = makeBridge();
    const { els, panel } = await mountPanel(bridgeOf);

    let dropPrevented = false;
    let overPrevented = false;
    await els.panel.fire('dragover', { dataTransfer: dragData([makeFile('a.mp4', 'video/mp4')]), preventDefault() { overPrevented = true; } });
    await els.panel.fire('drop', { dataTransfer: dragData([makeFile('a.mp4', 'video/mp4')]), preventDefault() { dropPrevented = true; } });
    assert.equal(overPrevented, true, 'dragover 不拦的话 Chromium 根本不会触发 drop');
    assert.equal(dropPrevented, true);
    await flush(); await flush();
    assert.ok(panel.pendingVideo !== null, '草稿应该建起来了');
    assert.equal(videoCalls(bridgeOf.calls).length, 0);

    // 拖一段选中的文字:一点都不碰
    let textPrevented = false;
    await els.panel.fire('drop', { dataTransfer: { items: [], files: [], types: ['text/plain'] }, preventDefault() { textPrevented = true; } });
    assert.equal(textPrevented, false);

    // 拖一个非视频文件:不建草稿,但仍然拦下(不让 Chromium 去打开它)
    const before = panel.pendingVideo;
    let otherPrevented = false;
    await els.panel.fire('drop', { dataTransfer: dragData([makeFile('note.txt', 'text/plain', 10)]), preventDefault() { otherPrevented = true; } });
    assert.equal(otherPrevented, true);
    assert.equal(panel.pendingVideo, before, '非视频文件不该顶掉或清掉已有草稿');
});

// ---------- 配密钥那张卡 ----------

/** 缺密钥的那一份 understand 返回。**它就是卡片的唯一入口** ——
 *  输入卡片那一行上的「密钥」按钮已按用户要求删掉,所以卡片没有开关。 */
const MISSING_KEY = {
    ok: false, code: 'missing_key', reason: '没有配置 DashScope 密钥。', status: null,
};

/** 打开卡片:走**真实**那条路 —— 缺密钥时自动展开。
 *
 *  ⚠️ 这里刻意不去点任何「开关」:那一行上的「密钥」按钮已经删了,卡片只有
 *  "缺密钥自动出现 + 卡片自己的「收起」"。测试要是自己造一个开关去点,
 *  测的就不是产品了 —— 用户遇到的路径正是下面这条。
 */
async function openKeyCard(els, panel) {
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    await panel.send();
    await flush(); await flush();
    const row = els.panel.query('.agent-video-key');
    assert.ok(row !== null && row.hidden === false,
        '缺密钥必须自动把配置卡展开(否则密钥就没地方配了)');
    return row;
}

const SECRET = 'sk-ws-UNIT-TEST-KEY-must-never-appear-anywhere';

test('输入卡片那一行没有「密钥」按钮:卡片只能由"缺密钥"自动展开', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel } = await mountPanel(bridgeOf);
    // ① 用户要求:那一行只剩状态点 —— 「密钥」入口整个删掉,卡片也不该提前存在
    assert.equal(els.panel.query('.agent-ctx-key'), null, '「密钥」按钮必须已经删掉');
    assert.equal(els.panel.query('.agent-video-key'), null, '没缺密钥之前,卡片不该存在');
    assert.equal(videoCalls(bridgeOf.calls).length, 0, '没人点、没事发生:一个 video: 请求都不该有');

    // ② 真缺密钥那一次:卡片自动出现,并且读了一次 status
    const row = await openKeyCard(els, panel);
    assert.deepEqual(videoCalls(bridgeOf.calls).map(c => c.channel),
        ['video:understand', 'video:status'],
        '缺密钥 → 自动展开,并且读数以主进程那一份为准');
    // 默认那份 status 是"环境变量已配" → 必须出现那句"在这里保存不会生效"
    const text = textOf(row);
    assert.match(text, /密钥:已配置\(环境变量\)/);
    assert.match(text, /环境变量优先,在这里保存的密钥不会生效/);
    // 密码框:类型对、不回填、有 aria-label
    const input = row.query('INPUT');
    assert.equal(input.type, 'password');
    assert.equal(input.value, '');
    assert.equal(input.getAttribute('aria-label'), 'DashScope 密钥');
});

test('未配密钥时:卡片说"未配置",而且**不**出现环境变量那句警告', async () => {
    const bridgeOf = makeBridge({
        understandResult: MISSING_KEY,
        videoStatus: {
            ok: false, source: null, storage: 'plain', reason: '没有配置 DashScope 密钥。',
            model: 'qwen3-vl-flash', models: [], maxTokens: 800,
            maxVideoBytes: 1, maxVideosPerPrompt: 1, inlineLimitBytes: 1,
            audioNotice: '听不到声音', mimeLabel: 'x',
        },
    });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    const text = textOf(row);
    assert.match(text, /密钥:未配置/);
    assert.equal(text.includes('在这里保存不会生效'), false);
});

test('设置文件里的密文:状态说清"已配置(设置文件),系统加密",并附上来源说明', async () => {
    const bridgeOf = makeBridge({
        understandResult: MISSING_KEY,
        videoStatus: {
            ok: true, source: 'settings', storage: 'encrypted', reason: null,
            model: 'qwen3-vl-flash', models: [], maxTokens: 800,
            maxVideoBytes: 1, maxVideosPerPrompt: 1, inlineLimitBytes: 1,
            audioNotice: '听不到声音', mimeLabel: 'x',
        },
    });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    const text = textOf(row);
    assert.match(text, /密钥:已配置\(设置文件\),系统加密/);
    assert.equal(text.includes('在这里保存不会生效'), false);
});

test('普通存在的明文存储:状态标出"明文",并把后果写出来(不粉饰成"已保存")', async () => {
    const bridgeOf = makeBridge({
        understandResult: MISSING_KEY,
        videoStatus: {
            ok: true, source: 'settings', storage: 'plain', reason: null,
            model: 'qwen3-vl-flash', models: [], maxTokens: 800,
            maxVideoBytes: 1, maxVideosPerPrompt: 1, inlineLimitBytes: 1,
            audioNotice: '听不到声音', mimeLabel: 'x',
        },
    });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    const text = textOf(row);
    assert.match(text, /密钥:已配置\(设置文件\),明文/);
    assert.match(text, /明文/);
    assert.match(text, /能读到那个文件的人就能读到密钥/);
});

test('保存:递出去的参数正确;成功后**输入框清空**、页面文本里搜不到那串明文、状态刷新为主进程读数', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel, logs } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    const input = row.query('INPUT');

    input.value = SECRET;                     // 用户敲进去(只存在于 input.value)
    await row.query('.agent-video-key-save').fire('click');
    await flush(); await flush();

    // ① 通道收到的就是那一串(而且只在这一个参数里)
    const setCall = bridgeOf.calls.find(c => c.channel === 'video:key:set');
    assert.ok(setCall !== undefined);
    assert.deepEqual(setCall.payload, { key: SECRET });

    // ② 成功后输入框立刻清空:明文不许继续留在 DOM 里
    assert.equal(input.value, '');

    // ③ 页面文本里搜不到它,日志里也搜不到
    assert.equal(textOf(els.panel).includes(SECRET), false);
    assert.equal(textOf(els.messagesEl).includes(SECRET), false);
    assert.equal(logs.join('\n').includes(SECRET), false);

    // ④ 状态刷新成"主进程说"的那一份(fake 把它改成了设置文件/密文)
    assert.match(textOf(row), /密钥:已配置\(设置文件\),系统加密/);
    assert.match(textOf(row), /已保存\(系统加密\)/);
    // 而且面板不该把 video:status 的返回原样塞进 DOM(里面没有值,但它也不该被整坨丢掉)
    assert.equal(JSON.stringify(panel.videoInfo).includes(SECRET), false);
});

test('保存失败(主进程给原因):把中文原因显示出来,输入框**不清空**(用户要能改一改再试)', async () => {
    const bridgeOf = makeBridge({
        understandResult: MISSING_KEY,
        keySave: () => ({ ok: false, code: 'invalid_key', reason: '密钥不能为空' }),
    });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    const input = row.query('INPUT');
    input.value = SECRET;
    await row.query('.agent-video-key-save').fire('click');
    await flush();

    assert.match(textOf(row), /密钥不能为空/);
    assert.equal(input.value, SECRET, '失败时不能清空 —— 否则用户得重新输一遍');
});

test('保存时通道直接 reject:也要有一句中文原因(不是"点了没反应")', async () => {
    const bridgeOf = makeBridge({
        understandResult: MISSING_KEY,
        keySave: () => { throw new Error('未授权的 IPC 频道: video:key:set'); },
    });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    row.query('INPUT').value = SECRET;
    await row.query('.agent-video-key-save').fire('click');
    await flush();

    const text = textOf(row);
    assert.match(text, /没保存成功/);
    assert.match(text, /未授权的 IPC 频道/);
    assert.equal(text.includes(SECRET), false);
});

test('空白与超长输入:原样递出去(判据在主进程那一边),并把返回的原因显示出来', async () => {
    const seen = [];
    const bridgeOf = makeBridge({
        understandResult: MISSING_KEY,
        keySave: (payload) => {
            seen.push(payload.key);
            if (payload.key === '') return { ok: false, code: 'invalid_key', reason: '密钥不能为空' };
            return { ok: false, code: 'invalid_key', reason: '这一串太长了,不像是密钥(没有存)' };
        },
    });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    const input = row.query('INPUT');
    const save = row.query('.agent-video-key-save');

    await save.fire('click');                         // 空白
    await flush();
    assert.deepEqual(seen, ['']);
    assert.match(textOf(row), /密钥不能为空/);

    const long = `sk-${'x'.repeat(600)}`;
    input.value = long;                               // 超长
    await save.fire('click');
    await flush();
    assert.deepEqual(seen[1], long, '面板不许自己截断 —— 判据与文案只有主进程那一份');
    assert.match(textOf(row), /太长了/);
});

test('清除:调用 video:key:clear,状态回到主进程说的那一种(未配 / 环境变量)', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    // 先存一次(状态 → 设置文件/密文)
    row.query('INPUT').value = SECRET;
    await row.query('.agent-video-key-save').fire('click');
    await flush(); await flush();
    assert.match(textOf(row), /密钥:已配置\(设置文件\),系统加密/);

    await row.query('.agent-video-key-clear').fire('click');
    await flush(); await flush();

    assert.ok(bridgeOf.calls.some(c => c.channel === 'video:key:clear'));
    const text = textOf(row);
    assert.match(text, /已清除保存的那一份/);
    assert.match(text, /密钥:未配置/);
    assert.equal(text.includes(SECRET), false);
    assert.equal(row.query('INPUT').value, '');
});

test('密钥值不进状态、不进日志、不进 DOM —— 连"保存中…"那一刻也没有', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY, keySave: async () => ({ ok: true, storage: 'plain' }) });
    const { els, panel, logs } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    row.query('INPUT').value = SECRET;
    const click = row.query('.agent-video-key-save').fire('click');    // 不 await:抓"保存中…"那一帧
    assert.match(textOf(row), /保存中…/);
    assert.equal(textOf(row).includes(SECRET), false);
    await click;
    await flush();
    assert.equal(textOf(els.panel).includes(SECRET), false);
    assert.equal(logs.join('\n').includes(SECRET), false);
});

// ---------- 开/关(真机上报的 bug:卡片展开后收不起来)----------
//
// ⚠️ 输入的卡片那一行上的「密钥」按钮已按用户要求删掉,所以现在**没有开关**:
//   进 = 缺密钥时自动展开;出 = 卡片自己那个「收起」。下面这几条测的就是这两个口。

/** 读一次卡片的外部表现:在不在、hidden、以及卡片自己那个「收起」的标签。 */
function keyCardState(els) {
    const row = els.panel.query('.agent-video-key');
    const close = row === null ? null : row.query('.agent-video-key-close');
    return {
        rowExists: row !== null,
        hidden: row === null ? null : row.hidden,
        closeLabel: close === null ? null : close.getAttribute('aria-label'),
    };
}

test('卡片不是开关:缺密钥才出现,出现后**再缺一次**也只是保持展开(不会自己收起)', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel } = await mountPanel(bridgeOf);

    // 初始:还没缺过密钥 → 卡片根本没建(不是"建了但藏着")
    const initial = keyCardState(els);
    assert.equal(initial.rowExists, false, '没缺密钥之前不该有这张卡');
    assert.equal(els.panel.query('.agent-ctx-key'), null, '「密钥」按钮已经删掉了');

    await openKeyCard(els, panel);
    const open = keyCardState(els);
    assert.equal(open.hidden, false, '缺密钥 → 自动展开');
    assert.equal(open.closeLabel, '收起密钥设置', '卡片自带「收起」,标签要能读出来');

    // 再缺一次(用户又发了一段视频):卡片保持展开,而且只可能有一张卡
    await openKeyCard(els, panel);
    assert.equal(keyCardState(els).hidden, false, '再缺一次仍然是展开的');
    assert.equal(els.panel.queryAll('.agent-video-key').length, 1, '卡片只会有一张(不重建)');
});

test('缺密钥**自动展开**那条路:卡片自己那个「收起」能把状态收回去(状态只有 hidden 一个来源)', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    await panel.send();
    await flush(); await flush();

    const auto = keyCardState(els);
    assert.equal(auto.hidden, false, '缺密钥该把卡片展开');

    // 卡片上的「收起」就是收起的入口(那一行上的按钮没了,这个必须还在)
    await els.panel.query('.agent-video-key-close').fire('click');
    await flush();
    assert.equal(keyCardState(els).hidden, true, '「收起」必须真的能收');
});

test('收起之后再打开:读数是主进程**当下**那一份,不是上一次的残留值', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel } = await mountPanel(bridgeOf);

    const row = await openKeyCard(els, panel);
    assert.match(textOf(row), /密钥:已配置\(环境变量\)/);

    await els.panel.query('.agent-video-key-close').fire('click');   // 收起
    await flush();
    assert.equal(row.hidden, true);

    // 收起期间配置变了(现实里:用户去掉了环境变量 / 手改了设置文件)
    bridgeOf.statusBox.value = {
        ok: false, source: null, storage: 'plain', reason: '没有配置 DashScope 密钥。',
        model: 'qwen3-vl-flash', models: [], maxTokens: 800,
        maxVideoBytes: 1, maxVideosPerPrompt: 1, inlineLimitBytes: 1,
        audioNotice: 'x', mimeLabel: 'x',
    };

    // 再一次缺密钥 → 自动重新展开
    panel.addVideo(makeFile('b.mp4', 'video/mp4'));
    await panel.send();
    // 展开这一刻绝不许还是上一次那句话(快慢都行,但不能是旧的)
    assert.equal(textOf(row).includes('已配置(环境变量)'), false, '不能显示上一次的残留读数');

    await flush(); await flush();
    assert.match(textOf(row), /密钥:未配置/);
});

test('主进程还没回话时,卡片显示的是"读取中…",而不是上一次的读数', async () => {
    // 这一条用**挂起的** video:status 把"中间那一帧"钉住 —— 上面那条测的是最终值,
    // 这一条测的是"在拿到新答案之前,屏幕上不会有旧答案"。
    let release = null;
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);                 // 第一次:正常拿到"环境变量已配"
    assert.match(textOf(row), /密钥:已配置\(环境变量\)/);
    await els.panel.query('.agent-video-key-close').fire('click');
    await flush();                                             // 收起

    const original = bridgeOf.bridge.invoke.bind(bridgeOf.bridge);
    bridgeOf.bridge.invoke = async (channel, payload) => {
        if (channel === 'video:status') return await new Promise((resolve) => { release = resolve; });
        return await original(channel, payload);
    };
    panel.addVideo(makeFile('b.mp4', 'video/mp4'));
    const sending = panel.send();        // ⚠️ 不 await:这一次的 video:status 会一直挂着
    // 等那条 video:status 真的问到主进程(release 被填上)——
    // 此刻正是"已经清成读取中…、但新答案还没回来"那一帧。
    for (let i = 0; i < 40 && release === null; i += 1) await flush();
    assert.ok(release !== null, '缺密钥那条路应该已经把 video:status 问出去了');
    const pending = textOf(row);
    assert.match(pending, /读取中…/);
    assert.equal(pending.includes('已配置(环境变量)'), false, '拿不到新答案之前,不许把旧答案摆出来');
    release?.({ ok: true, source: 'settings', storage: 'encrypted', reason: null, model: 'qwen3-vl-flash', models: [], maxTokens: 800, maxVideoBytes: 1, maxVideosPerPrompt: 1, inlineLimitBytes: 1, audioNotice: 'x', mimeLabel: 'x' });
    await sending;
    await flush(); await flush();
    assert.match(textOf(row), /密钥:已配置\(设置文件\),系统加密/);
});

test('卡片上的「收起」也能收,而且卡片里没有任何"开关"按钮残留', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    const close = row.query('.agent-video-key-close');
    assert.ok(close !== null, '卡片上应该有一个就地收起的入口');
    assert.equal(close.getAttribute('aria-label'), '收起密钥设置');

    await close.fire('click');
    await flush();
    const state = keyCardState(els);
    assert.equal(state.hidden, true);
    assert.equal(els.panel.query('.agent-ctx-key'), null, '那一行上的「密钥」按钮不许回来');
});

test('保存成功**不**自动收起(那句"已保存"的反馈要看得见),但用户可以自己收', async () => {
    const bridgeOf = makeBridge({ understandResult: MISSING_KEY });
    const { els, panel } = await mountPanel(bridgeOf);
    const row = await openKeyCard(els, panel);
    row.query('INPUT').value = SECRET;
    await row.query('.agent-video-key-save').fire('click');
    await flush(); await flush();

    let state = keyCardState(els);
    assert.equal(state.hidden, false, '保存成功不该把卡片收起来');
    assert.match(textOf(row), /已保存\(系统加密\)/);

    // 但用户必须能收掉它
    await els.panel.query('.agent-video-key-close').fire('click');
    await flush();
    state = keyCardState(els);
    assert.equal(state.hidden, true);
});

// ---------- 按本地路径理解(队列里下好的文件走这条) ----------

const LOCAL_FOLDER = 'D:\\project\\bilidown\\download';
const LOCAL_FILE = `${LOCAL_FOLDER}\\中国人能飞😭 [高清 1080P60] NA.mp4`;
const BIG_SIZE = 177737264;              // 169.5 MB

/** 让 makeBridge 也支持按路径那条通道。 */
function makePathBridge({ understandPathResult = null, size = BIG_SIZE } = {}) {
    const bridgeOf = makeBridge();
    const original = bridgeOf.bridge.invoke.bind(bridgeOf.bridge);
    bridgeOf.bridge.invoke = async (channel, payload) => {
        if (channel === 'video:understandPath') {
            bridgeOf.calls.push({ channel, payload });
            return understandPathResult ?? {
                ok: true,
                text: '这是一段游戏实况与广告的混剪。',
                model: 'qwen3-vl-flash',
                usage: { promptTokens: 127799, completionTokens: 800, videoTokens: 127766 },
                delivery: { mode: 'upload', uploadBody: 'stream', bytes: size },
            };
        }
        return await original(channel, payload);
    };
    return bridgeOf;
}

test('按路径理解:消息流里出现"用户递了这段视频"+ 助手回答,IPC 只递几个叶子字段', async () => {
    const bridgeOf = makePathBridge();
    const { els, panel } = await mountPanel(bridgeOf);

    const sent = await panel.understandVideoPath({
        path: LOCAL_FILE, folder: LOCAL_FOLDER, name: '中国人能飞😭 [高清 1080P60] NA.mp4', size: BIG_SIZE,
    });
    await flush(); await flush();

    assert.equal(sent, true);
    const call = bridgeOf.calls.find(c => c.channel === 'video:understandPath');
    assert.ok(call !== undefined, '必须走 video:understandPath 这条通道');
    // requestId 是方案 C 加的第六个字段:它只是个**不透明字符串**(主进程按它把
    // 进度推回本次调用),不承载路径/命令/上限之类的任何权威。
    assert.deepEqual(Object.keys(call.payload).sort(), ['folder', 'mimeType', 'name', 'path', 'question', 'requestId']);
    assert.equal(call.payload.path, LOCAL_FILE);
    assert.equal(call.payload.folder, LOCAL_FOLDER);
    assert.equal(call.payload.bytes, undefined, '按路径那条**不许**把字节过 IPC');
    assert.match(call.payload.requestId, /^v-/, 'requestId 由渲染进程现给,好让它在发请求之前就认得出自己那条推送');

    // 消息流:一条带视频卡的用户消息 + 一条助手回答(与过 IPC 那条形状一致)
    assert.equal(panel.state.messages.length, 2);
    assert.equal(panel.state.messages[0].role, 'user');
    assert.equal(panel.state.messages[0].video.name, '中国人能飞😭 [高清 1080P60] NA.mp4');
    assert.equal(panel.state.messages[0].video.byteLength, BIG_SIZE);
    assert.equal(panel.state.messages[1].role, 'assistant');
    assert.equal(panel.state.messages[1].usage.videoTokens, 127766);
    // 收尾后 stages 必须被摘掉(收尾消息的形状与从前逐字段一致)
    assert.equal(panel.state.messages[1].stages, undefined);
    const streamText = textOf(els.messagesEl);
    assert.ok(streamText.includes('这是一段游戏实况与广告的混剪。'));
    assert.ok(streamText.includes('视频 127766 tokens'));
    assert.equal(panel.videoBusy, false);
});

test('按路径理解:大文件先给"要上传"的反馈(169.5 MB 实测要 47.7 秒,不能点了没反应)', async () => {
    let release = null;
    const bridgeOf = makePathBridge();
    const original = bridgeOf.bridge.invoke.bind(bridgeOf.bridge);
    bridgeOf.bridge.invoke = async (channel, payload) => {
        if (channel === 'video:understandPath') {
            bridgeOf.calls.push({ channel, payload });
            return await new Promise((resolve) => { release = () => resolve({ ok: true, text: '好了', usage: { videoTokens: 1 }, delivery: { mode: 'upload' } }); });
        }
        return await original(channel, payload);
    };
    const { els, panel } = await mountPanel(bridgeOf);
    const pending = panel.understandVideoPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER, name: 'a.mp4', size: BIG_SIZE });
    await flush();

    const notice = textOf(els.panel.query('.agent-video-notice'));
    assert.match(notice, /正在理解/);
    assert.match(notice, /169\.5 MB|上传到服务端/);
    assert.equal(panel.videoBusy, true);

    release?.();
    await pending;
    await flush();
    assert.equal(panel.videoBusy, false);
    // 上传期间界面**不能**是死的:消息已经进流了
    assert.equal(panel.state.messages.length, 2);
});

test('按路径理解:失败给中文原因,红在那一段;缺密钥时展开配置卡', async () => {
    const bridgeOf = makePathBridge({
        understandPathResult: { ok: false, code: 'outside_folder', reason: '这个路径不在它自己的下载目录里,已拒绝', status: null },
    });
    const { els, panel } = await mountPanel(bridgeOf);
    await panel.understandVideoPath({ path: 'C:\\x.mp4', folder: LOCAL_FOLDER, name: 'x.mp4', size: 1024 });
    await flush(); await flush();

    // 路径准入失败发生在**准备请求**那一段:那里红,不在这里编一句笼统的"理解失败"
    const msgs = panel.state.messages.filter(m => m.role === 'assistant');
    assert.equal(msgs.filter(m => m.text !== '').length, 0, '不许留假回答');
    assert.equal(msgs[0].stages.find(s => s.key === 'prepare').state, 'failed');
    assert.equal(panel.state.error.stage, 'prepare');
    assert.match(textOf(els.panel.query('.agent-video-notice')), /不在它自己的下载目录里/);
    // 缺密钥那条 → 配置卡自动展开(与过 IPC 那条同一个落点)
    const bridgeOf2 = makePathBridge({
        understandPathResult: { ok: false, code: 'missing_key', reason: '没有配置 DashScope 密钥。', status: null },
    });
    const second = await mountPanel(bridgeOf2);
    await second.panel.understandVideoPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER, name: 'a.mp4', size: 1024 });
    await flush(); await flush();
    const keyRow = second.els.panel.query('.agent-video-key');
    assert.ok(keyRow !== null && keyRow.hidden === false);
});

test('按路径理解:空路径直接拒(不发 IPC);正在理解时第二次请求被挡', async () => {
    const bridgeOf = makePathBridge();
    const { panel } = await mountPanel(bridgeOf);
    assert.equal(await panel.understandVideoPath({ path: '   ' }), false);
    assert.equal(bridgeOf.calls.some(c => c.channel === 'video:understandPath'), false);

    let release = null;
    const original = bridgeOf.bridge.invoke.bind(bridgeOf.bridge);
    bridgeOf.bridge.invoke = async (channel, payload) => {
        if (channel === 'video:understandPath') {
            bridgeOf.calls.push({ channel, payload });
            await new Promise((resolve) => { release = resolve; });
            return { ok: true, text: 'x', usage: { videoTokens: 1 }, delivery: { mode: 'inline' } };
        }
        return await original(channel, payload);
    };
    const first = panel.understandVideoPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER, name: 'a.mp4', size: 1024 });
    await flush();
    assert.equal(await panel.understandVideoPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER, name: 'a.mp4', size: 1024 }), false);
    release?.();
    await first;
});

test('DOM 事件那条路:别的面板派 kaiwu:understand-video 就能让 AI 面板理解这段本地视频', async () => {
    const bridgeOf = makePathBridge();
    const { panel } = await mountPanel(bridgeOf);
    doc.dispatchEvent({
        type: 'kaiwu:understand-video',
        detail: { path: LOCAL_FILE, folder: LOCAL_FOLDER, name: '队列里的那段.mp4', size: BIG_SIZE },
    });
    await flush(); await flush();

    const call = bridgeOf.calls.find(c => c.channel === 'video:understandPath');
    assert.ok(call !== undefined, '事件应当被面板接住并转成一次 IPC');
    assert.equal(call.payload.path, LOCAL_FILE);
    assert.equal(panel.state.messages[0].video.name, '队列里的那段.mp4');

    // 面板释放后不该再有人接这个事件(不然切视图重建会触发两次)
    panel.dispose();
    bridgeOf.calls.length = 0;
    doc.dispatchEvent({ type: 'kaiwu:understand-video', detail: { path: LOCAL_FILE, name: 'x.mp4', size: 1 } });
    await flush();
    assert.equal(bridgeOf.calls.filter(c => c.channel === 'video:understandPath').length, 0);
});

// ---------- 方案 C:四段状态行画在界面上 ----------
//
// 归约那侧的判据已经钉过了(agent-stream.test.js),这里钉的是**画出来的那一半**:
// 行在不在、百分比有没有落到条上、失败那一行有没有变红、取消按钮有没有接上、
// 以及"度数行"里真的写出了三段耗时(自标定要看它)。

/** 让 understand 那条一直挂着(进度事件要有一个"在飞"的窗口才推得动)。 */
function makeHangingBridge({ understandResult = null } = {}) {
    const bridgeOf = makeBridge({ understandResult });
    const original = bridgeOf.bridge.invoke.bind(bridgeOf.bridge);
    let release = null;
    bridgeOf.bridge.invoke = async (channel, payload) => {
        if (channel === 'video:understand' || channel === 'video:understandPath') {
            bridgeOf.calls.push({ channel, payload });
            return await new Promise((resolve) => { release = resolve; });
        }
        return await original(channel, payload);
    };
    return { bridgeOf, release: (result) => release?.(result) };
}

test('在飞的时候:气泡里画出四段行,上传的百分比真的落到那条上', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const pending = panel.send();
    await flush();

    // 一开始只有"准备请求"一行,而且是 doing
    assert.equal(els.messagesEl.queryAll('.stage-row').length, 1);
    assert.equal(els.messagesEl.queryAll('.stage-row.doing').length, 1);
    assert.equal(els.messagesEl.query('.mark').textContent, '▸');

    const requestId = bridgeOf.calls.find(c => c.channel === 'video:understand').payload.requestId;
    bridgeOf.bridge.emitVideo({ stage: 'preparing', requestId });
    bridgeOf.bridge.emitVideo({ stage: 'prepared', mode: 'upload', totalBytes: BIG_SIZE, requestId });
    bridgeOf.bridge.emitVideo({ stage: 'uploading', percent: 37, sentBytes: 100, totalBytes: BIG_SIZE, requestId });
    await flush();

    const rows = els.messagesEl.queryAll('.stage-row');
    assert.equal(rows.length, 2, '准备 + 上传(两条路共用这一格,只有说法不同)');
    assert.equal(els.messagesEl.queryAll('.stage-row.done').length, 1);
    assert.equal(els.messagesEl.queryAll('.stage-row.doing').length, 1);
    assert.equal(rows[1].query('.mark').textContent, '▸');
    // 上传那一行的标签带上真实体积,读数写"已交给连接 37%",条子按 37% 填
    const uploadText = textOf(rows[1]);
    assert.ok(uploadText.includes('169.5 MB'), `上传行要带体积:${uploadText}`);
    assert.ok(uploadText.includes('已交给连接 37%'), uploadText);
    // 条子的宽度就是那个真百分比(替身不支持后代选择器,所以先取 .sbar 再取它里面的 i)
    const bars = els.messagesEl.queryAll('.sbar');
    assert.equal(bars.length, 2);
    assert.equal(bars[1].query('i').style.width, '37%');
    // ★ 图二:没有分母的行不许画"永远是 0%"的空轨道 —— 那是用户报的"条不动"。
    // 「准备请求」这时已经 **done**(prepared 事件把它翻过去了)→ 什么都不画(idle);
    // 还在做的、又没有分母的行(等待/生成,见下)才用不确定态的游走光带。
    assert.equal(bars[0].className, 'sbar idle');
    assert.equal(bars[1].className, 'sbar', '有真百分比的那一段仍然是普通轨道 + 填充');
    assert.equal(bars[0].query('i').style.width, '', '不画的时候不写宽度(写 0% 就是一根假的空轨道)');

    // 上传结束、进入"等待首个字":这一段**正在做**而且没有分母 → 不确定态光带
    bridgeOf.bridge.emitVideo({ stage: 'waiting', requestId });
    await flush();
    const waiting = els.messagesEl.queryAll('.stage-row');
    const barIn = (list, key) => list.find(r => r.getAttribute('data-stage') === key).query('.sbar');
    assert.equal(barIn(waiting, 'upload').className, 'sbar', '上传那段是真百分比,轨道照旧');
    assert.equal(barIn(waiting, 'wait').className, 'sbar indeterminate', '等待首个字:没有分母 → 不确定态光带');
    assert.equal(barIn(waiting, 'wait').query('i').style.width, '', '不确定态不写宽度');

    // 首字到了 → 生成那一段:正文在**同一个气泡里**流出来
    bridgeOf.bridge.emitVideo({ stage: 'generating', chars: 3, chunks: 1, delta: '红块在', requestId });
    await flush();
    assert.equal(els.messagesEl.queryAll('.stage-row').length, 4);
    assert.ok(textOf(els.messagesEl).includes('红块在'), '正文边收边显示');
    assert.ok(textOf(els.messagesEl).includes('已生成 3 字'));
    // 生成那一段同样没有分母 → 也是不确定态;已经收尾的那几行什么都不画
    const late = els.messagesEl.queryAll('.stage-row');
    assert.equal(barIn(late, 'upload').className, 'sbar');
    assert.equal(barIn(late, 'generate').className, 'sbar indeterminate', '生成正文:没有分母 → 不确定态光带');
    assert.equal(barIn(late, 'wait').className, 'sbar idle', '收尾又没有百分比的行:什么都不画');
    assert.equal(barIn(late, 'prepare').className, 'sbar idle');

    release({ ok: true, text: '红块在动。', usage: { videoTokens: 127766 }, delivery: { mode: 'upload', timings: { uploadMs: 27400, ttftMs: 26100, generateMs: 12900, totalMs: 66400 } } });
    await pending;
    await flush();
    // 收尾:四段行整块消失(它是过程,不是回答),正文与度数行留下
    assert.equal(els.messagesEl.queryAll('.stage-row').length, 0);
    const streamText = textOf(els.messagesEl);
    assert.ok(streamText.includes('红块在动。'));
    assert.match(streamText, /上传 27\.4s/);
    assert.match(streamText, /首字 26\.1s/);
    assert.match(streamText, /生成 12\.9s/);
});

test('状态行占位带 data-stages 标记,而且没有空的正文层(靠"第几条"找真回复会被它带偏)', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const pending = panel.send();
    await flush();

    const bubble = els.messagesEl.queryAll('.agent-msg-assistant')[0];
    assert.equal(bubble.getAttribute('data-stages'), 'true');
    assert.equal(bubble.queryAll('.agent-msg-text').length, 0, '还没有正文时不许挂一个空的正文层');
    assert.equal(bubble.queryAll('.stages').length, 1);

    // 收尾之后它变回一条**普通回答**:标记与状态行一起消失,正文层出现
    release({ ok: true, text: '真正的回答。', usage: {}, delivery: { mode: 'inline' } });
    await pending;
    await flush();
    const done = els.messagesEl.queryAll('.agent-msg-assistant')[0];
    assert.equal(done.getAttribute('data-stages'), null);
    assert.equal(done.queryAll('.stages').length, 0);
    assert.equal(done.queryAll('.agent-msg-text').length, 1);
    assert.ok(textOf(done).includes('真正的回答。'));
});

test('内联那条路(小文件):发送那一行**在**,带真百分比,而且说的是"发送请求体"不是"上传"', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('small.mp4', 'video/mp4', 4096));
    const pending = panel.send();
    await flush();
    const requestId = bridgeOf.calls.find(c => c.channel === 'video:understand').payload.requestId;
    // prepared 给的是**文件**大小;uploading 给的是**请求体**长度(base64 之后比文件大 1/3)
    // —— 标签上要留文件大小(用户认得的就是它),百分比按请求体的真实总长算。
    bridgeOf.bridge.emitVideo({ stage: 'prepared', mode: 'inline', totalBytes: 4096, requestId });
    bridgeOf.bridge.emitVideo({ stage: 'uploading', mode: 'inline', sentBytes: 2732, totalBytes: 5464, percent: 50, requestId });
    await flush();

    const keys = els.messagesEl.queryAll('.stage-row').map(row => row.getAttribute('data-stage'));
    assert.deepEqual(keys, ['prepare', 'upload'], '内联**也有**"把请求体交给连接"这一段(以前整包发,连观测都观测不到)');
    const sendRow = els.messagesEl.queryAll('.stage-row').find(r => r.getAttribute('data-stage') === 'upload');
    const sendText = textOf(sendRow);
    assert.ok(sendText.includes('发送请求体'), `内联那条路要说"发送请求体":${sendText}`);
    assert.ok(sendText.includes('4.0 KB'), `标签上留的是文件大小(不是编出来的请求体长度):${sendText}`);
    assert.equal(sendText.includes('5.3 KB'), false, '请求体长度(5.3 KB)不许顶掉文件大小 —— 文案会半路跳数');
    assert.equal(sendText.includes('上传'), false, '内联没有"传文件"这回事,不许说"上传"');
    const sendBar = sendRow.query('.sbar');
    assert.equal(sendBar.className, 'sbar', '有真百分比 → 普通轨道 + 填充(不是不确定态光带)');
    assert.equal(sendBar.query('i').style.width, '50%', '这 50% 是逐块报上来的真数 —— 小文件也有进度条');

    // 请求体交完 → 等待首个字:这一段没有分母 → 不确定态光带;发送那一段是真的满格
    bridgeOf.bridge.emitVideo({ stage: 'waiting', requestId });
    await flush();
    const barIn = (list, key) => list.find(r => r.getAttribute('data-stage') === key).query('.sbar');
    const late = els.messagesEl.queryAll('.stage-row');
    assert.equal(barIn(late, 'upload').className, 'sbar');
    assert.equal(barIn(late, 'upload').query('i').style.width, '100%', '字节全交出去了,100% 是真的');
    assert.equal(barIn(late, 'wait').className, 'sbar indeterminate', '等待首个字:没有分母 → 不确定态光带');
    release({ ok: true, text: 'x', usage: {}, delivery: { mode: 'inline' } });
    await pending;
});

test('中途失败:红的是**具体那一段**(不是笼统一句"理解失败")', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const pending = panel.send();
    await flush();
    const requestId = bridgeOf.calls.find(c => c.channel === 'video:understand').payload.requestId;
    bridgeOf.bridge.emitVideo({ stage: 'prepared', mode: 'upload', totalBytes: BIG_SIZE, requestId });
    bridgeOf.bridge.emitVideo({ stage: 'uploading', percent: 12, totalBytes: BIG_SIZE, requestId });
    release({ ok: false, code: 'upload_failed', reason: '临时上传失败(HTTP 403)', status: 403 });
    await pending;
    await flush();

    const failed = els.messagesEl.queryAll('.stage-row.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].getAttribute('data-stage'), 'upload', '断在上传就该红在上传');
    assert.equal(panel.state.error.stage, 'upload');
    assert.match(textOf(failed[0]), /在这里断了/);
    // 上传**之后**那些没发生的行一行都不许留
    assert.deepEqual(els.messagesEl.queryAll('.stage-row').map(r => r.getAttribute('data-stage')), ['prepare', 'upload']);
});

test('取消:按钮只在飞的时候出现,点了递出 requestId,并把"已取消"说出来', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const pending = panel.send();
    await flush();

    const btn = els.messagesEl.query('.stage-cancel');
    assert.ok(btn !== null, '在飞的时候必须有取消入口(169.5 MB 那条要等 47–71 秒)');
    await btn.fire('click');
    await flush();
    const cancelCall = bridgeOf.calls.find(c => c.channel === 'video:cancel');
    assert.ok(cancelCall !== undefined, '必须走 video:cancel 这条通道');
    assert.equal(cancelCall.payload.requestId, bridgeOf.calls.find(c => c.channel === 'video:understand').payload.requestId);
    assert.match(textOf(els.panel.query('.agent-video-notice')), /已取消/);

    // 取消之后这次理解仍然要正常收尾(占位不留、提示是"已取消"而不是"失败")
    release({ ok: false, code: 'cancelled', reason: '这次理解已被取消', status: null });
    await pending;
    await flush();
    assert.equal(els.messagesEl.queryAll('.stage-row').length, 0, '取消不留那条占位');
    assert.equal(els.messagesEl.query('.stage-cancel'), null);
    assert.equal(panel.videoBusy, false);
});

test('取消时主进程说"已经结束了"(not_running):不是错误,如实说一句', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    bridgeOf.bridge.invoke = (() => {
        const original = bridgeOf.bridge.invoke;
        return async (channel, payload) => {
            if (channel === 'video:cancel') {
                bridgeOf.calls.push({ channel, payload });
                return { ok: false, code: 'not_running', reason: '这一次已经结束了(或者不是这个 id)' };
            }
            return await original(channel, payload);
        };
    })();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const pending = panel.send();
    await flush();
    await els.messagesEl.query('.stage-cancel').fire('click');
    await flush();
    assert.match(textOf(els.panel.query('.agent-video-notice')), /刚好结束/);
    release({ ok: true, text: 'x', usage: {}, delivery: { mode: 'inline' } });
    await pending;
});

test('迟到的进度事件(别的 requestId / 已经收尾)一个字都不许改', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const pending = panel.send();
    await flush();
    bridgeOf.bridge.emitVideo({ stage: 'prepared', mode: 'upload', totalBytes: BIG_SIZE, requestId: 'v-别的' });
    await flush();
    assert.equal(els.messagesEl.queryAll('.stage-row').length, 1, '不是这一次的推送不许改这一轮');
    release({ ok: true, text: '答案', usage: {}, delivery: { mode: 'inline' } });
    await pending;
    await flush();
    const before = textOf(els.messagesEl);
    bridgeOf.bridge.emitVideo({ stage: 'generating', chars: 9, chunks: 9, delta: '不该出现', requestId: 'v-别的' });
    await flush();
    assert.equal(textOf(els.messagesEl), before);
});

test('释放面板:订阅摘掉、秒表停掉(不许留一个还在跑的定时器)', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    const { panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const pending = panel.send();
    await flush();
    const requestId = bridgeOf.calls.find(c => c.channel === 'video:understand').payload.requestId;
    bridgeOf.bridge.emitVideo({ stage: 'waiting', requestId });
    await flush();
    assert.equal(bridgeOf.bridge.videoHandlers.length, 1);
    panel.dispose();
    assert.equal(bridgeOf.bridge.videoHandlers.length, 0, '订阅必须摘干净');
    release({ ok: true, text: 'x', usage: {}, delivery: { mode: 'inline' } });
    await pending;
});

test('「等待首个字」那一行:显示**本地秒数**,旁边贴标定区间(不是单点),出处挂在 title 里', async () => {
    const { bridgeOf, release } = makeHangingBridge();
    const { els, panel } = await mountPanel(bridgeOf);
    panel.addVideo(makeFile('a.mp4', 'video/mp4'));
    const pending = panel.send();
    await flush();
    const requestId = bridgeOf.calls.find(c => c.channel === 'video:understand').payload.requestId;
    // 上传完 → 等待首个字。体积落在标定点附近,所以估计值是可信的。
    bridgeOf.bridge.emitVideo({ stage: 'prepared', mode: 'upload', totalBytes: BIG_SIZE, requestId });
    bridgeOf.bridge.emitVideo({ stage: 'waiting', requestId });
    await flush();

    const waitRow = els.messagesEl.queryAll('.stage-row').find(r => r.getAttribute('data-stage') === 'wait');
    assert.ok(waitRow !== undefined);
    const detail = waitRow.query('.stage-detail');
    // 本地秒数是真的
    assert.match(detail.textContent, /已等待 \d+\.\d 秒/);
    // ⚠️ 两个样本差了近 3 倍,所以贴的是**量级**,不是"约多少秒"(那是假装精确)
    assert.match(detail.textContent, /通常十几秒到半分钟/);
    assert.equal(/约 \d+ 秒/.test(detail.textContent), false);
    // 出处可核对:几个样本、各自是实测还是倒推
    assert.match(detail.getAttribute('title'), /2 个样本/);
    assert.match(detail.getAttribute('title'), /实测 34\.1s/);
    assert.match(detail.getAttribute('title'), /倒推 11\.7s/);

    release({ ok: true, text: 'x', usage: {}, delivery: { mode: 'upload' } });
    await pending;
    await flush();

    // 内联那条路没有标定 → 一个估计都不许贴(宁可不说):只有本地秒数,那一行到此为止
    const { bridgeOf: small, release: release2 } = makeHangingBridge();
    const second = await mountPanel(small);
    second.panel.addVideo(makeFile('small.mp4', 'video/mp4', 4096));
    const pending2 = second.panel.send();
    await flush();
    const rid2 = small.calls.find(c => c.channel === 'video:understand').payload.requestId;
    small.bridge.emitVideo({ stage: 'prepared', mode: 'inline', totalBytes: 4096, requestId: rid2 });
    small.bridge.emitVideo({ stage: 'waiting', requestId: rid2 });
    await flush();
    const inlineWait = second.els.messagesEl.queryAll('.stage-row').find(r => r.getAttribute('data-stage') === 'wait');
    assert.match(inlineWait.query('.stage-detail').textContent, /^已等待 \d+\.\d 秒$/);
    assert.equal(/通常|约/.test(inlineWait.query('.stage-detail').textContent), false);
    release2({ ok: true, text: 'x', usage: {}, delivery: { mode: 'inline' } });
    await pending2;
});
