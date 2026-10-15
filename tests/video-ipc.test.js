import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MAX_VIDEO_BYTES } from '../app/lib/agent-video.js';
import { VIDEO_INVOKE_CHANNELS, createProgressPump, registerVideoIpc } from '../electron/video/video-ipc.js';

// 视频理解的 IPC 契约。
//
// 三条必须钉住的事(与 agent 那条通道同一套原则):
//   1. 渲染进程只能递**叶子字段** —— 多递的东西(payload 里塞 url / path / model)
//      必须被忽略,而不是被当成参数用;
//   2. 业务失败**resolve 成对象**,不 throw(throw 过真 IPC 会丢掉 code/reason 之外的
//      机器可读字段,而界面正是靠 code 决定"要不要亮出密钥输入框");
//   3. preload 的白名单与本文件注册的频道**一字不差** —— 两边漂移的表现是
//      "界面点了没反应",而且不报错。

/** ipcMain 替身:把 handle 注册的处理器收起来,能直接按频道调。 */
function makeIpcMain() {
    const handlers = new Map();
    return {
        handlers,
        handle(channel, fn) { handlers.set(channel, fn); },
        removeHandler(channel) { handlers.delete(channel); },
        async invoke(channel, payload) {
            const fn = handlers.get(channel);
            if (fn === undefined) throw new Error(`没有注册的频道:${channel}`);
            return await fn({}, payload);
        },
        /** 带一个"真的能 send"的事件对象:进度推送那条路要它。 */
        async invokeWithSender(channel, payload, sent) {
            const fn = handlers.get(channel);
            if (fn === undefined) throw new Error(`没有注册的频道:${channel}`);
            const event = { sender: { send: (name, body) => sent.push({ name, body }) } };
            return await fn(event, payload);
        },
    };
}

/** provider 替身:把收到的入参记下来,回一个可编程的结果。 */
function makeProvider(result = { ok: true, text: '描述', usage: {}, delivery: { mode: 'inline' } }) {
    const seen = [];
    return {
        seen,
        understand: async (input) => { seen.push(input); return result; },
    };
}

function makeSettings({ ok = false, reason = '没有配置 DashScope 密钥。' } = {}) {
    const written = [];
    return {
        written,
        summary: () => ({ ok, source: ok ? 'env' : null, reason: ok ? null : reason, storage: 'plain' }),
        config: () => ({ model: 'qwen3-vl-flash', maxTokens: 800, inlineLimitBytes: 12345 }),
        resolveSecret: () => ({ ok, secret: ok ? 'sk-ws-secret-value' : '', source: 'env', reason: null }),
        saveKey: (key) => { written.push(key); return { ok: true, storage: 'plain' }; },
        clearKey: () => ({ ok: true }),
        setModel: (model) => (model === 'qwen3-vl-plus' ? { ok: true, model } : { ok: false, code: 'bad_model', reason: '不认识的模型' }),
    };
}

function makeIpc({ provider = makeProvider(), videoSettings = makeSettings() } = {}) {
    const ipcMain = makeIpcMain();
    const handle = registerVideoIpc({
        ipcMain, provider, videoSettings,
        log: { warn() {}, info() {}, error() {} },
    });
    return { ipcMain, handle, provider, videoSettings };
}

// ---------- 注册面 ----------

test('注册的就是那一组频道(与 preload 白名单逐字一致)', async () => {
    const { ipcMain } = makeIpc();
    assert.deepEqual([...ipcMain.handlers.keys()].sort(), [...VIDEO_INVOKE_CHANNELS].sort());
    // ⚠️ 这里**没有** video:auto:set:交互改成"拖入只是草稿、点发送才调用"之后,
    // "自动理解"整个概念不存在了 —— 通道与设置一起删掉,不留废弃的空壳。
    // video:understandPath 是按**本地路径**那条入口(队列里下好的文件走它)。
    assert.deepEqual([...VIDEO_INVOKE_CHANNELS], [
        'video:status', 'video:understand', 'video:understandPath',
        'video:key:set', 'video:key:clear', 'video:model:set',
        // 取消一次正在进行的理解(方案 C 的四段行旁边那个按钮)。
        'video:cancel',
    ]);
    assert.equal(VIDEO_INVOKE_CHANNELS.includes('video:auto:set'), false);
});

test('video:understandPath 只把五个叶子字段递给 provider(路径之外的字段一律不采信)', async () => {
    const seen = [];
    const { ipcMain } = makeIpc({
        provider: {
            understand: async () => ({ ok: true }),
            understandFromPath: async (input) => { seen.push(input); return { ok: true, text: '描述' }; },
        },
    });
    await ipcMain.invoke('video:understandPath', {
        path: 'D:\\project\\bilidown\\download\\a.mp4',
        folder: 'D:\\project\\bilidown\\download',
        name: 'a.mp4',
        mimeType: 'video/mp4',
        question: '里面有什么?',
        // 下面这些是"渲染进程想塞但塞不进来"的东西
        bytes: new Uint8Array([1, 2, 3]),
        maxBytes: 999999999,
        model: 'qwen3-vl-plus',
        apiKey: 'sk-attacker',
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0]).sort(), ['folder', 'mimeType', 'name', 'path', 'question']);
    assert.equal(seen[0].bytes, undefined);
    assert.equal(seen[0].maxBytes, undefined);
    assert.equal(seen[0].apiKey, undefined);
});

test('video:understandPath 的失败**原样 resolve**成对象(不 throw),并保留机器可读的码', async () => {
    const { ipcMain } = makeIpc({
        provider: {
            understand: async () => ({ ok: true }),
            understandFromPath: async () => ({ ok: false, code: 'outside_folder', reason: '这个路径不在它自己的下载目录里,已拒绝', status: null }),
        },
    });
    const result = await ipcMain.invoke('video:understandPath', { path: 'C:\\x.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'outside_folder');
    assert.match(result.reason, /不在它自己的下载目录里/);
});

test('preload 放行了每一个频道,也没有放行没人注册的 video 频道(两边漂移会静默失效)', async () => {
    const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
    const start = preload.indexOf('const ALLOWED_INVOKE');
    const end = preload.indexOf('];', start);
    assert.ok(start >= 0 && end > start, 'preload 里找不到 ALLOWED_INVOKE 列表');
    const block = preload.slice(start, end);
    for (const channel of VIDEO_INVOKE_CHANNELS) {
        assert.ok(block.includes(`'${channel}'`), `preload 没有放行 ${channel}`);
    }
    for (const quoted of block.matchAll(/'([^']+)'/g)) {
        const channel = quoted[1];
        if (!channel.startsWith('video:')) continue;
        assert.ok(VIDEO_INVOKE_CHANNELS.includes(channel), `preload 放行了没人注册的频道:${channel}`);
    }
});

test('dispose 摘掉所有处理器(可重复调用)', () => {
    const { ipcMain, handle } = makeIpc();
    handle.dispose();
    assert.equal(ipcMain.handlers.size, 0);
    handle.dispose();
    assert.equal(ipcMain.handlers.size, 0);
});

test('接线错了要当场抛(不是等用户拖进视频才炸)', () => {
    const ipcMain = makeIpcMain();
    assert.throws(() => registerVideoIpc({ ipcMain, videoSettings: makeSettings() }), /需要 provider/);
    assert.throws(() => registerVideoIpc({ ipcMain, provider: makeProvider() }), /需要 videoSettings/);
});

// ---------- video:status ----------

test('video:status 只回叶子字段,而且**没有密钥值**', async () => {
    const { ipcMain } = makeIpc({ videoSettings: makeSettings({ ok: true }) });
    const status = await ipcMain.invoke('video:status');
    assert.equal(status.ok, true);
    assert.equal(status.model, 'qwen3-vl-flash');
    assert.equal(status.maxVideoBytes, MAX_VIDEO_BYTES);
    assert.equal(status.maxVideosPerPrompt, 1);
    // 音频说明必须在状态里带着 —— 界面靠它如实告诉用户"听不到声音"
    assert.match(status.audioNotice, /听不到声音/);
    assert.ok(Array.isArray(status.models));
    // "自动理解"这个概念已经不存在了,状态里也不该再冒出来
    assert.equal('autoUnderstand' in status, false);
    assert.equal(JSON.stringify(status).includes('sk-ws-secret-value'), false);
    assert.equal(JSON.stringify(status).includes('secret'), false);
});

test('video:status 在没配密钥时如实带上原因(界面据此亮出配置入口)', async () => {
    const { ipcMain } = makeIpc({ videoSettings: makeSettings({ ok: false, reason: '没有配置 DashScope 密钥。' }) });
    const status = await ipcMain.invoke('video:status');
    assert.equal(status.ok, false);
    assert.match(status.reason, /没有配置 DashScope 密钥/);
});

// ---------- video:understand ----------

test('video:understand 只把四个叶子字段递给 provider(多递的东西必须被丢掉)', async () => {
    const provider = makeProvider();
    const { ipcMain } = makeIpc({ provider });
    const bytes = new Uint8Array([1, 2, 3]);
    await ipcMain.invoke('video:understand', {
        mimeType: 'video/mp4',
        bytes,
        name: 'a.mp4',
        question: '里面有什么?',
        // 下面这些是"渲染进程想塞但塞不进来"的东西
        url: 'https://evil.example/x.mp4',
        path: 'C:\\Windows\\System32\\config\\SAM',
        model: 'qwen3-vl-plus',
        maxTokens: 99999,
        apiKey: 'sk-attacker',
    });
    assert.equal(provider.seen.length, 1);
    assert.deepEqual(Object.keys(provider.seen[0]).sort(), ['bytes', 'mimeType', 'name', 'question']);
    assert.equal(provider.seen[0].url, undefined);
    assert.equal(provider.seen[0].path, undefined);
    assert.equal(provider.seen[0].model, undefined);
    assert.equal(provider.seen[0].apiKey, undefined);
});

test('video:understand 把非字符串的字段收敛成空串(不猜、不 JSON 化)', async () => {
    const provider = makeProvider();
    const { ipcMain } = makeIpc({ provider });
    await ipcMain.invoke('video:understand', { mimeType: 42, name: { a: 1 }, question: ['x'] });
    assert.deepEqual(provider.seen[0], { mimeType: '', bytes: undefined, name: '', question: '' });
});

test('video:understand 把 provider 的失败**原样 resolve**成对象(不 throw)', async () => {
    const provider = makeProvider({ ok: false, code: 'missing_key', reason: '没有配置 DashScope 密钥。', status: null });
    const { ipcMain } = makeIpc({ provider });
    const result = await ipcMain.invoke('video:understand', { mimeType: 'video/mp4', bytes: new Uint8Array([1]), name: 'a.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'missing_key');
    assert.match(result.reason, /没有配置 DashScope 密钥/);
});

test('处理器内部抛异常时也 resolve 成对象(throw 过 IPC 会丢机器可读字段)', async () => {
    const provider = { understand: async () => { throw new Error('provider 炸了'); } };
    const { ipcMain } = makeIpc({ provider });
    const result = await ipcMain.invoke('video:understand', { mimeType: 'video/mp4', bytes: new Uint8Array([1]), name: 'a.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ipc_error');
    assert.match(result.reason, /provider 炸了/);
});

// ---------- 密钥那几个频道 ----------

test('video:key:set 只递一串密钥,返回里没有它的值', async () => {
    const { ipcMain, videoSettings } = makeIpc();
    const result = await ipcMain.invoke('video:key:set', { key: 'sk-ws-abcdefghijklmnopqrst', pluginId: 'x', ns: 'y' });
    assert.deepEqual(result, { ok: true, storage: 'plain' });
    assert.deepEqual(videoSettings.written, ['sk-ws-abcdefghijklmnopqrst']);
    assert.equal(JSON.stringify(result).includes('sk-ws-abcdefghijklmnopqrst'), false);
});

test('video:key:set 对非字符串的输入收敛成空串(由 settings 那边给出可读原因)', async () => {
    const { ipcMain, videoSettings } = makeIpc();
    await ipcMain.invoke('video:key:set', { key: { toString: () => 'sk-ws-x' } });
    assert.deepEqual(videoSettings.written, ['']);
});

test('video:key:clear / video:model:set 各自转给设置那一层', async () => {
    const { ipcMain } = makeIpc();
    assert.deepEqual(await ipcMain.invoke('video:key:clear', {}), { ok: true });
    assert.deepEqual(await ipcMain.invoke('video:model:set', { model: 'qwen3-vl-plus' }), { ok: true, model: 'qwen3-vl-plus' });
    const bad = await ipcMain.invoke('video:model:set', { model: 'gpt-4o' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad_model');
});

test('video:auto:set 已经拆掉:调它不该有任何反应(不是被静默忽略,而是根本没有这条频道)', async () => {
    const { ipcMain } = makeIpc();
    assert.equal(ipcMain.handlers.has('video:auto:set'), false);
    await assert.rejects(() => ipcMain.invoke('video:auto:set', { autoUnderstand: false }), /没有注册的频道/);
});

// ---------- 方案 C:进度推送 + 取消 ----------
//
// 这两条是这次新加的能力,所以判据要钉得比平时更细:
//   · 推出去的**只有叶子字段**(不推流对象、不推 provider 的返回对象);
//   · 阶段切换必须**立刻**到,正文增量可以合并(实测一次回答 227 片,一片一次 IPC 是白花);
//   · 没有 requestId / 推不出去时,provider 收到的入参**与从前逐字一样**(不多两个字段);
//   · 取消走的是主进程那侧的 AbortSignal,而且"已经结束"是正常结果、不是错误。

test('有 requestId 时:进度按叶子字段推出去,而且每一条都带着那个 id', async () => {
    const pushed = [];
    const provider = {
        understand: async (input) => {
            // provider 拿到的两个附加字段是**主进程建的**,不是渲染进程递进来的
            input.onProgress({ stage: 'prepared', mode: 'inline', totalBytes: 512 });
            input.onProgress({ stage: 'waiting' });
            input.onProgress({ stage: 'generating', chars: 2, chunks: 1, delta: '红块' });
            return { ok: true, text: '红块', usage: {}, delivery: { mode: 'inline' } };
        },
    };
    const { ipcMain } = makeIpc({ provider });
    const result = await ipcMain.invokeWithSender('video:understand', {
        mimeType: 'video/mp4', bytes: new Uint8Array([1]), name: 'a.mp4', question: 'x', requestId: 'v-1',
    }, pushed);

    assert.equal(result.ok, true);
    assert.deepEqual(pushed.map(p => p.name), ['video:event', 'video:event', 'video:event', 'video:event']);
    assert.deepEqual(pushed.map(p => p.body.stage), ['preparing', 'prepared', 'waiting', 'generating']);
    for (const item of pushed) assert.equal(item.body.requestId, 'v-1');
    // 叶子字段:只许出现标量(数字/字符串/布尔),一个对象都不许有
    for (const item of pushed) {
        for (const value of Object.values(item.body)) {
            assert.equal(typeof value === 'object' && value !== null, false, `推了非叶子字段:${JSON.stringify(item.body)}`);
        }
    }
    assert.equal(pushed[3].body.delta, '红块');
    assert.equal(pushed[3].body.chars, 2);
});

test('没有 requestId(或推不出去)时:一条都不推,而且 provider 入参**逐字不变**', async () => {
    const pushed = [];
    const provider = makeProvider();
    const { ipcMain } = makeIpc({ provider });
    // ① 没有 requestId
    await ipcMain.invokeWithSender('video:understand', { mimeType: 'video/mp4', bytes: new Uint8Array([1]), name: 'a.mp4', question: 'x' }, pushed);
    assert.deepEqual(pushed, []);
    assert.deepEqual(Object.keys(provider.seen[0]).sort(), ['bytes', 'mimeType', 'name', 'question']);
    // ② 有 requestId 但事件上根本没有 sender(旧外壳/替身)
    await ipcMain.invoke('video:understand', { mimeType: 'video/mp4', bytes: new Uint8Array([1]), name: 'a.mp4', question: 'x', requestId: 'v-9' });
    assert.deepEqual(Object.keys(provider.seen[1]).sort(), ['bytes', 'mimeType', 'name', 'question']);
});

test('渲染进程自己在 payload 里塞 onProgress / signal:一律不采信(那两个只能主进程建)', async () => {
    const pushed = [];
    let seen = null;
    const provider = {
        understand: async (input) => {
            seen = input;
            // 假货(渲染进程塞进来的那个)绝不许被调用到
            return { ok: true, text: 'x', usage: {}, delivery: { mode: 'inline' } };
        },
    };
    const { ipcMain } = makeIpc({ provider });
    let called = 0;
    await ipcMain.invokeWithSender('video:understand', {
        mimeType: 'video/mp4', bytes: new Uint8Array([1]), name: 'a.mp4', question: 'x', requestId: 'v-2',
        onProgress: () => { called += 1; },
        signal: { aborted: true },
    }, pushed);
    assert.equal(called, 0);
    assert.equal(typeof seen.onProgress, 'function');
    assert.equal(seen.signal?.aborted, false, '用的是主进程新建的那个 signal');
});

test('取消:abort 递给 provider 的那个 signal;没在跑时说"已经结束"而不是报错', async () => {
    let observed = null;
    const provider = {
        understand: async (input) => {
            observed = input.signal;
            // 一直等到被取消(真实那条路上 169.5 MB 要等 47–71 秒)
            await new Promise((resolve) => {
                if (input.signal.aborted === true) { resolve(); return; }
                input.signal.addEventListener('abort', resolve, { once: true });
            });
            return { ok: false, code: 'cancelled', reason: '这次理解已被取消', status: null };
        },
    };
    const { ipcMain } = makeIpc({ provider });
    const pending = ipcMain.invokeWithSender('video:understand', {
        mimeType: 'video/mp4', bytes: new Uint8Array([1]), name: 'a.mp4', question: 'x', requestId: 'v-3',
    }, []);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(observed?.aborted, false, '还没取消时不该是 aborted');
    assert.deepEqual(await ipcMain.invoke('video:cancel', { requestId: 'v-3' }), { ok: true });
    assert.equal(observed.aborted, true);
    const result = await pending;
    assert.equal(result.code, 'cancelled');
    // 结束之后再取消一次:正常返回(用户按的时候它刚好收尾,是一瞬,不是故障)
    const again = await ipcMain.invoke('video:cancel', { requestId: 'v-3' });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'not_running');
    assert.match(again.reason, /已经结束/);
});

test('取消一个不存在的 id:不抛(它是一个正常的返回对象)', async () => {
    const { ipcMain } = makeIpc();
    const result = await ipcMain.invoke('video:cancel', { requestId: 'nope' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_running');
});

test('进度泵:阶段切换立刻发,正文增量合并但一个字都不丢', async () => {
    const sent = [];
    let nowMs = 1000;
    const timers = [];
    const pump = createProgressPump({
        emit: (e) => sent.push(e),
        now: () => nowMs,
        setTimer: (fn) => { timers.push(fn); return timers.length; },
        clearTimer: () => {},
    });
    // 阶段切换:立刻发(不然用户看不出进展)
    pump.push({ stage: 'preparing' });
    assert.deepEqual(sent.map(e => e.stage), ['preparing']);
    // 正文增量:同一窗口内先攒着
    pump.push({ stage: 'generating', chars: 1, chunks: 1, delta: '甲' });
    pump.push({ stage: 'generating', chars: 2, chunks: 2, delta: '乙' });
    pump.push({ stage: 'generating', chars: 3, chunks: 3, delta: '丙' });
    assert.equal(sent.length, 1, '窗口内先不发');
    assert.equal(timers.length, 1, '只排一个定时器(不是一片一个)');
    // 窗口到了:合并成一条,delta 拼接、chars/chunks 取最新
    nowMs += 1000;
    timers[0]();
    assert.deepEqual(sent.at(-1), { stage: 'generating', chars: 3, chunks: 3, delta: '甲乙丙' });
    // 阶段切换前必须先把攒下的正文冲出去(顺序不能乱)
    pump.push({ stage: 'generating', chars: 4, chunks: 4, delta: '丁' });
    pump.push({ stage: 'waiting' });
    assert.deepEqual(sent.map(e => e.stage), ['preparing', 'generating', 'generating', 'waiting']);
    assert.equal(sent[2].delta, '丁');
    // flush / dispose 各一次也不重复发
    pump.flush();
    pump.dispose();
    assert.equal(sent.length, 4);
});
