import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CHAT_PATH, DASHSCOPE_BASE_URL, LOCAL_CHAT_TIMEOUT_MS, LOCAL_UPLOAD_TIMEOUT_MS,
    UPLOAD_POLICY_PATH, composeInlineBodyStream, composeUploadStream, createFetchTransport,
    createVideoProvider,
} from '../electron/video/dashscope.js';
// 纯模块里的请求体构造:用来把"流式分块拼出来的请求体"与"一次性整包拼出来的"直接对比。
import {
    buildChatBody, buildDataUrl, buildInlineBodyParts, buildMediaContent, toCanonicalBase64,
} from '../app/lib/agent-video.js';

// provider 这条链路的**单元**测试。
//
// ⚠️ 硬要求:这里**一个真实网络请求都没有** —— transport 是注入的假货,
// 而且测试会断言"调了几次、每次的 URL/头/请求体是什么"。真实 API 的那一轮验证
// 是另做的(证据在交付报告里),两者的分工是:这里钉住"我们发出去的东西符合契约",
// 那边钉住"服务端真的收得下"。
//
// 为什么这些断言值得写得这么细:
//   · 漏一个 `X-DashScope-OssResourceResolve` 头,oss:// 那条路就整个不通(实测),
//     而错误信息是一句完全不提头部的英文;
//   · 漏 `x-oss-forbid-overwrite`,上传直接 403(实测);
//   · 把 Authorization 也发给 OSS 主机,就是把密钥送给一个不该收到它的地方;
//   · 少判一次"密钥没配",用户看到的是 401 而不是"去配一把密钥"。

const SECRET = 'sk-ws-UNIT-TEST-SECRET-DO-NOT-LEAK';

/** MP4 签名头(判据只看签名,不需要能解码的文件)。 */
function mp4(byteLength = 512) {
    const out = new Uint8Array(byteLength);
    out.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
    return out;
}

/** 一段成功响应的正文。
 *
 * ⚠️ 现在是**线上那份 SSE 形状**,不是整包 JSON —— 因为 provider 已经一律走流式
 * (`stream:true`),「等待首个字 / 生成正文」两段的读数只能从流里来。
 * 这里刻意分成"首包(空 delta)/ 正文档 / usage 尾包 / [DONE]"四段:
 * 真实服务端就是这么发的,拼成一个整包就把要测的那条路测没了。
 */
function okChat(text = '一个红方块从左向右移动。', videoTokens = 322) {
    const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
    return [
        line({ model: 'qwen3-vl-flash', id: 'chatcmpl-unit', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
        line({ model: 'qwen3-vl-flash', id: 'chatcmpl-unit', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }),
        line({
            model: 'qwen3-vl-flash', id: 'chatcmpl-unit', choices: [],
            usage: {
                prompt_tokens: 352, completion_tokens: 44, total_tokens: 396,
                prompt_tokens_details: { text_tokens: 30, video_tokens: videoTokens },
            },
        }),
        'data: [DONE]\n\n',
    ].join('');
}

/** 把一段 SSE 正文按**不规则**切片喂回 onData —— 网络分片不会按事件边界切。 */
function feedSse(onData, text, size = 7) {
    for (let at = 0; at < text.length; at += size) onData(text.slice(at, at + size));
}

/**
 * 假传输层:按调用顺序回放 script 里的响应,并且**把每次请求原样记下来**。
 * 每个元素可以是响应对象,也可以是"按请求算一个响应"的函数。
 *
 * `drain:true` 时会把**流式请求体**读完(真传输层就是这么干的:undici 会一路拉这条流),
 * 并把结果放回 `req.bodyText` / `req.bodyBytes` —— 内联那条路现在发的是一条流,
 * 而断言要看的是"这条流最终拼出来的请求体是什么"。
 */
function makeTransport(script = [], { drain = false } = {}) {
    const calls = [];
    const transport = async (req) => {
        calls.push(req);
        if (drain === true && typeof req.body?.getReader === 'function') {
            const reader = req.body.getReader();
            const parts = [];
            let total = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done === true) break;
                const chunk = typeof value === 'string' ? new TextEncoder().encode(value) : value;
                parts.push(chunk);
                total += chunk.byteLength;
            }
            const joined = new Uint8Array(total);
            let at = 0;
            for (const part of parts) { joined.set(part, at); at += part.byteLength; }
            req.bodyText = new TextDecoder().decode(joined);
            req.bodyBytes = total;
        }
        const next = script[calls.length - 1];
        const res = (typeof next === 'function' ? await next(req) : next)
            ?? { status: 200, ok: true, text: '{}', timedOut: false, networkError: '' };
        // 真传输层是"边收边回调";假货必须照做,否则 provider 的流式解析在单测里
        // 永远走不到 —— 那这些用例就测不到真东西了。
        if (typeof req.onData === 'function' && typeof res.text === 'string' && res.text !== '') {
            feedSse(req.onData, res.text);
        }
        return res;
    };
    return { calls, transport };
}

/** 把一条 Web ReadableStream 读完,拼成一个 Uint8Array(真传输层就是这么拉这条流的)。 */
async function drainStream(stream) {
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        const chunk = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        parts.push(chunk);
        total += chunk.byteLength;
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { joined.set(part, at); at += part.byteLength; }
    return joined;
}

function makeProvider({ script = [], config, resolveKey, logs, now, random, drain = false } = {}) {
    const { calls, transport } = makeTransport(script, { drain });
    const logLines = logs ?? [];
    const provider = createVideoProvider({
        transport,
        resolveKey: resolveKey ?? (() => ({ ok: true, secret: SECRET, source: 'settings', reason: null })),
        config: config ?? (() => ({ model: 'qwen3-vl-flash', maxTokens: 456, timeoutMs: 1234, uploadTimeoutMs: 5678 })),
        log: {
            info: (...a) => logLines.push(a.join(' ')),
            warn: (...a) => logLines.push(a.join(' ')),
            error: (...a) => logLines.push(a.join(' ')),
        },
        // 默认固定值:让每次请求的 URL / 表单都可断言。要测"名字唯一"的那条用例
        // 才传不同的 now / random(它们正是唯一性的来源)。
        now: now ?? (() => 1700000000000),
        random: random ?? (() => 0.25),
    });
    return { provider, calls, logLines };
}

// ---------- 内联那条路(实测跑通的主路) ----------

test('小文件走内联:请求体是**流式**的,内容与"整包拼一次"逐字节相同', async () => {
    const bytes = mp4(512);
    const { provider, calls } = makeProvider({ script: [{ status: 200, ok: true, text: okChat() }], drain: true });

    const result = await provider.understand({ mimeType: 'video/mp4', bytes, name: 'vu-synth.mp4', question: '里面有什么?' });

    assert.equal(result.ok, true);
    assert.equal(result.text, '一个红方块从左向右移动。');
    assert.equal(result.usage.videoTokens, 322);
    assert.equal(result.delivery.mode, 'inline');
    assert.equal(result.delivery.bytes, 512);
    // ★ 内联那条路现在也走**流式请求体**(与小文件也有真进度是同一件事)
    assert.equal(result.delivery.uploadBody, 'stream');
    assert.equal(typeof calls[0].body?.getReader, 'function', 'body 必须是一条流(不是拼好的整串)');
    assert.equal(calls[0].duplex, 'half', '流式请求体要声明 half duplex');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DASHSCOPE_BASE_URL}${CHAT_PATH}`);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    assert.equal(calls[0].timeoutMs, 1234);
    // 长度是算出来的:带上 Content-Length,HTTP 层会替我们再核对一次"一块不差"
    assert.equal(Number(calls[0].headers['Content-Length']), calls[0].bodyBytes);

    const body = JSON.parse(calls[0].bodyText);
    assert.equal(body.model, 'qwen3-vl-flash');
    assert.equal(body.max_tokens, 456);
    const content = body.messages[0].content;
    assert.equal(content[0].type, 'video_url');
    assert.equal(content[1].type, 'text');
    assert.equal(content[1].text, '里面有什么?');
    // 内联的字节必须与源字节**逐字节**相等(不是"差不多")
    const prefix = 'data:video/mp4;base64,';
    assert.ok(content[0].video_url.url.startsWith(prefix));
    const b64 = content[0].video_url.url.slice(prefix.length);
    assert.deepEqual(new Uint8Array(Buffer.from(b64, 'base64')), bytes);
    // ⚠️ fps 不许出现:实测它被服务端静默忽略,写进去只会让人以为能控成本
    assert.equal(JSON.stringify(body).includes('fps'), false);

    // ★★ 分块流式拼出来的请求体,必须与**一次性整包**拼出来的那份逐字节相同。
    // 这是这次改动最大的正确性风险(base64 分块错位 → 非法请求体 → 服务端只回 400),
    // 所以在这里直接对比两种产物,而不是只对比解出来的字节。
    const oneShot = JSON.stringify(buildChatBody({
        model: 'qwen3-vl-flash',
        content: buildMediaContent({
            url: buildDataUrl({ mimeType: 'video/mp4', base64: toCanonicalBase64(bytes) }),
            question: '里面有什么?', kind: 'video',
        }),
        maxTokens: 456, stream: true,
    }));
    assert.equal(calls[0].bodyText, oneShot);
    assert.equal(Number(calls[0].headers['Content-Length']), new TextEncoder().encode(oneShot).byteLength);
});

test('没写提问时发的是纯模块里那句默认问法(不是空文本)', async () => {
    const { provider, calls } = makeProvider({ script: [{ status: 200, ok: true, text: okChat() }], drain: true });
    await provider.understand({ mimeType: 'video/mp4', bytes: mp4(64), name: 'a.mp4' });
    const content = JSON.parse(calls[0].bodyText).messages[0].content;
    assert.match(content[1].text, /用中文详细描述这段视频/);
});

test('内联也流式发:逐块计字节,单调递增,最后**正好**等于请求体长度(不差一块)', async () => {
    const bytes = mp4(4096);
    const events = [];
    const { provider, calls } = makeProvider({ script: [{ status: 200, ok: true, text: okChat() }], drain: true });
    const result = await provider.understand({
        mimeType: 'video/mp4', bytes, name: 'a.mp4', question: '描述',
        onProgress: (p) => events.push(p),
    });
    assert.equal(result.ok, true);
    const sends = events.filter(e => e.stage === 'uploading');
    assert.ok(sends.length >= 1, '内联这条路必须报"正在发送请求体"');
    assert.equal(sends.every(e => e.mode === 'inline'), true, '阶段里要带上是哪条路(文案据此区分)');
    // 单调不减
    for (let i = 1; i < sends.length; i += 1) {
        assert.ok(sends[i].sentBytes >= sends[i - 1].sentBytes, `字节数倒退了:${JSON.stringify(sends)}`);
    }
    const last = sends[sends.length - 1];
    assert.equal(last.totalBytes, Number(calls[0].headers['Content-Length']), '总长度就是请求体的长度');
    assert.equal(last.sentBytes, last.totalBytes, '结束时字节数必须**正好**等于总长');
    assert.equal(last.percent, 100);
    assert.equal(calls[0].bodyBytes, last.totalBytes, '真发出去的字节数与报出去的一致');
});

test('内联请求体流:递进去的是**源字节**(边发边编),拼出来与一次性编码逐字节相同', async () => {
    // 长度故意不是块长的倍数:最后一块带补位,前面每一块都不许带
    const bytes = mp4(3 * 4096 + 2);
    const parts = buildInlineBodyParts({
        model: 'qwen3-vl-flash', mimeType: 'video/mp4', question: '描述',
        maxTokens: 456, stream: true, byteLength: bytes.byteLength,
    });
    const seen = [];
    const stream = composeInlineBodyStream({
        bytes,
        prefix: parts.prefix,
        suffix: parts.suffix,
        chunkBytes: 4096,          // → 向下取整成 4095(3 的倍数)
        onBytes: (n) => seen.push(n),
    });
    assert.equal(typeof stream?.getReader, 'function');
    const got = await drainStream(stream);
    // 逐字节对比"整包拼一次"那份:分块错位在这里就会露出来
    const gold = JSON.stringify(buildChatBody({
        model: 'qwen3-vl-flash',
        content: buildMediaContent({
            url: buildDataUrl({ mimeType: 'video/mp4', base64: toCanonicalBase64(bytes) }),
            question: '描述', kind: 'video',
        }),
        maxTokens: 456, stream: true,
    }));
    assert.equal(new TextDecoder().decode(got), gold);
    assert.equal(parts.contentLength, got.byteLength);
    // 字节计数:递增、最后**正好**等于请求体长度(前缀 + base64 + 后缀,一块不差)
    assert.equal(seen[seen.length - 1], parts.contentLength);
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] > seen[i - 1], `字节数没有推进:${seen}`);
    // 一次 pull 交一块:块数 = 前缀 1 + base64 若干 + 后缀 1
    assert.equal(seen.length, 1 + Math.ceil(bytes.byteLength / 4095) + 1, `交出去的块数不对:${seen.length}`);
});

test('内联兜底①:环境里没有 ReadableStream 时退回**整包**,而且请求体里的 content 是真的', async () => {
    const bytes = mp4(512);
    const { provider, calls } = makeProvider({ script: [{ status: 200, ok: true, text: okChat() }] });
    const saved = globalThis.ReadableStream;
    try {
        // 极老运行时/替身:流这件事根本做不到 —— 但**不许**因此发一个 content:null 的请求
        globalThis.ReadableStream = undefined;
        const result = await provider.understand({ mimeType: 'video/mp4', bytes, name: 'a.mp4', question: '里面有什么?' });
        assert.equal(result.ok, true);
        assert.equal(result.delivery.uploadBody, 'buffer', '兜底那条路要如实说出来');
    } finally {
        globalThis.ReadableStream = saved;
    }
    assert.equal(typeof calls[0].body, 'string', '兜底发的是整包字符串');
    const oneShot = JSON.stringify(buildChatBody({
        model: 'qwen3-vl-flash',
        content: buildMediaContent({
            url: buildDataUrl({ mimeType: 'video/mp4', base64: toCanonicalBase64(bytes) }),
            question: '里面有什么?', kind: 'video',
        }),
        maxTokens: 456, stream: true,
    }));
    assert.equal(calls[0].body, oneShot, '整包兜底那份必须与"整包拼一次"逐字节相同');
    // ⚠️ 整包那条路不能带流用的 Content-Length(长度对不上会被 HTTP 层拒)
    assert.equal('Content-Length' in calls[0].headers, false, '兜底路不带那个 Content-Length');
    assert.equal(calls[0].duplex, undefined, '不是流,不许声明 duplex');
});

test('内联兜底②:传输层不认"流+长度"时,退回整包再发一次;而真业务失败**不**重试', async () => {
    const bytes = mp4(1024);
    /** 造一个只用指定 transport 的 provider(这条用例要自己数"发了几次、body 是什么形态")。 */
    const withTransport = (transport) => createVideoProvider({
        transport,
        resolveKey: () => ({ ok: true, secret: SECRET, source: 'settings', reason: null }),
        config: () => ({ model: 'qwen3-vl-flash', maxTokens: 456, timeoutMs: 1234, uploadTimeoutMs: 5678 }),
        log: { info() {}, warn() {}, error() {} },
        now: () => 1700000000000, random: () => 0.25,
    });

    // ① 第一次:传输层报"请求体本身"的问题(status 为 null)→ 必须重发一次
    let attempt = 0;
    const shapes = [];
    const retried = await withTransport(async (req) => {
        attempt += 1;
        shapes.push(typeof req.body === 'string' ? 'string' : 'stream');
        if (attempt === 1) {
            return { status: null, ok: false, text: '', timedOut: false, networkError: 'Request body length does not match content-length header' };
        }
        const res = { status: 200, ok: true, text: okChat(), timedOut: false, networkError: '' };
        if (typeof req.onData === 'function') feedSse(req.onData, res.text);
        return res;
    }).understand({ mimeType: 'video/mp4', bytes, name: 'a.mp4', question: '描述' });
    assert.equal(attempt, 2, '看着像请求体问题 → 重发一次');
    assert.deepEqual(shapes, ['stream', 'string'], '第二次是整包字符串体');
    assert.equal(retried.ok, true);
    assert.equal(retried.delivery.uploadBody, 'buffer', '最终走的是整包兜底,要如实报出来');

    // ② 真业务失败(403):换一种发法还是失败,不许重试(那会白传一遍整包)
    let businessAttempts = 0;
    const denied = await withTransport(async (req) => {
        businessAttempts += 1;
        if (typeof req.body?.getReader === 'function') {
            const reader = req.body.getReader();
            for (;;) { const { done } = await reader.read(); if (done === true) break; }
        }
        return { status: 403, ok: false, text: '{"error":{"message":"Forbidden"}}', timedOut: false, networkError: '' };
    }).understand({ mimeType: 'video/mp4', bytes, name: 'a.mp4', question: '描述' });
    assert.equal(businessAttempts, 1, '业务失败只发一次');
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'auth_failed');
});

// ---------- 上传那条路(大文件兜底,三步都实测通过) ----------
const POLICY = {
    policy: 'POLICY_B64', signature: 'SIG', upload_dir: 'dashscope-instant/a/2026-09-19/b',
    upload_host: 'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com',
    oss_access_key_id: 'LTAI-TEST', x_oss_object_acl: 'private',
    x_oss_forbid_overwrite: 'true', expire_in_seconds: 300, max_file_size_mb: 1024,
};

test('大文件走上传:GET 凭证 → multipart 上传 → 带解析头用 oss:// 再问一次', async () => {
    const bytes = mp4(4096);
    const { provider, calls } = makeProvider({
        script: [
            { status: 200, ok: true, text: JSON.stringify({ request_id: 'r1', data: POLICY }) },
            { status: 200, ok: true, text: '' },
            { status: 200, ok: true, text: okChat('三个竖条从左向右移动。', 2378) },
        ],
        // 把内联上限压到 1KB,让 4KB 的文件必须走上传
        config: () => ({ model: 'qwen3-vl-flash', maxTokens: 456, inlineLimitBytes: 1024, timeoutMs: 1234, uploadTimeoutMs: 5678 }),
    });

    const result = await provider.understand({ mimeType: 'video/mp4', bytes, name: '../../evil name.mp4' });

    assert.equal(result.ok, true);
    assert.equal(result.delivery.mode, 'upload');
    assert.equal(result.usage.videoTokens, 2378);
    assert.equal(calls.length, 3);

    // ① 凭证:必须是 GET(实测 POST 一律 405),模型名进查询串
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls[0].url.startsWith(`${DASHSCOPE_BASE_URL}${UPLOAD_POLICY_PATH}?action=getPolicy`));
    assert.ok(calls[0].url.includes('model=qwen3-vl-flash'));
    assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);

    // ② 上传:multipart,字段齐(含 forbid-overwrite),**不带鉴权头**
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, POLICY.upload_host);
    assert.match(calls[1].headers['Content-Type'], /^multipart\/form-data; boundary=/);
    assert.equal(calls[1].headers.Authorization, undefined, 'OSS 表单上传不该收到 Authorization(那等于把密钥发给另一个主机)');
    const uploadText = new TextDecoder().decode(calls[1].body);
    for (const field of ['key', 'policy', 'signature', 'OSSAccessKeyId', 'x-oss-object-acl', 'x-oss-forbid-overwrite', 'success_action_status']) {
        assert.ok(uploadText.includes(`name="${field}"`), `上传表单缺字段 ${field}`);
    }
    assert.ok(uploadText.includes('name="x-oss-forbid-overwrite"\r\n\r\ntrue'));
    assert.ok(uploadText.includes('Content-Disposition: form-data; name="file"'));
    // 文件名被洗过:路径分隔符与空格不会原样进 OSS 的对象 key
    assert.equal(uploadText.includes('..'), false);
    assert.ok(!uploadText.includes('evil name.mp4'));

    // ③ 对话:oss:// + **解析头**(少了它服务端直接把 URL 判成非法,实测)
    assert.equal(calls[2].url, `${DASHSCOPE_BASE_URL}${CHAT_PATH}`);
    assert.equal(calls[2].headers['X-DashScope-OssResourceResolve'], 'enable');
    const chat = JSON.parse(calls[2].body);
    assert.ok(chat.messages[0].content[0].video_url.url.startsWith('oss://dashscope-instant/a/2026-09-19/b/'));
    assert.equal(result.delivery.ossUrl, chat.messages[0].content[0].video_url.url);
});

test('每次上传的文件名都不同(策略禁覆盖,重名会 403)', async () => {
    const script = () => [
        { status: 200, ok: true, text: JSON.stringify({ data: POLICY }) },
        { status: 200, ok: true, text: '' },
        { status: 200, ok: true, text: okChat() },
    ];
    // 两次唯一的来源是 now + random(真实运行时就是毫秒时间戳 + Math.random);
    // 这里刻意给不同的值,证明**名字跟着它们走**,而不是写死一个。
    const first = makeProvider({ script: script(), config: () => ({ inlineLimitBytes: 16 }), now: () => 1700000000000, random: () => 0.25 });
    const second = makeProvider({ script: script(), config: () => ({ inlineLimitBytes: 16 }), now: () => 1700000000001, random: () => 0.75 });
    await first.provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    await second.provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    const t1 = new TextDecoder().decode(first.calls[1].body);
    const t2 = new TextDecoder().decode(second.calls[1].body);
    const keyOf = (text) => /name="key"\r\n\r\n([^\r]+)/.exec(text)?.[1] ?? '';
    assert.notEqual(keyOf(t1), keyOf(t2));
});

test('上传失败:说的是上传失败 + 状态码 + 一小段 OSS 原文(不是一句"请求失败")', async () => {
    const { provider } = makeProvider({
        script: [
            { status: 200, ok: true, text: JSON.stringify({ data: POLICY }) },
            { status: 403, ok: false, text: '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Invalid according to Policy</Message></Error>' },
        ],
        config: () => ({ inlineLimitBytes: 16 }),
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'upload_failed');
    assert.match(result.reason, /临时上传失败/);
    assert.match(result.reason, /403/);
    assert.match(result.reason, /AccessDenied/);
});

test('凭证接口挂了:码是 policy_xxx,原因是"取上传凭证失败"', async () => {
    const { provider } = makeProvider({
        script: [{ status: 401, ok: false, text: JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided.' } }) }],
        config: () => ({ inlineLimitBytes: 16 }),
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'policy_auth_failed');
    assert.match(result.reason, /取上传凭证失败/);
});

test('凭证响应缺字段:当场说清缺哪一个,不去发一次注定被拒的上传', async () => {
    const { provider, calls } = makeProvider({
        script: [{ status: 200, ok: true, text: JSON.stringify({ data: { policy: 'P', signature: 'S', upload_host: 'h' } }) }],
        config: () => ({ inlineLimitBytes: 16 }),
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'policy_malformed');
    assert.equal(calls.length, 1);
});

// ---------- 错误映射(逐条对着实测到的原文) ----------

test('401 鉴权失败:code=auth_failed(界面据此亮出密钥输入框)', async () => {
    const { provider } = makeProvider({
        script: [{ status: 401, ok: false, text: JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided. For details, see: https://help.aliyun.com/…' } }) }],
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_failed');
    assert.match(result.reason, /鉴权失败/);
    assert.equal(result.status, 401);
});

test('404 模型不存在:与"密钥不对"分得开(下一步完全不同)', async () => {
    const { provider } = makeProvider({
        script: [{ status: 404, ok: false, text: JSON.stringify({ error: { code: 'model_not_found', message: 'The model `x` does not exist or you do not have access to it.' } }) }],
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.code, 'model_not_found');
    assert.match(result.reason, /模型不存在/);
});

test('400 data-uri 超限:code=payload_too_large 并给出下一步(实测原文)', async () => {
    const { provider } = makeProvider({
        script: [{ status: 400, ok: false, text: JSON.stringify({ error: { message: 'Exceeded limit on max bytes per data-uri item : 20971520' } }) }],
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.code, 'payload_too_large');
    assert.match(result.reason, /临时上传/);
});

test('超时与网络故障:各有各的码,而且都带一句中文', async () => {
    const timedOut = makeProvider({
        script: [{ status: null, ok: false, text: '', timedOut: true, networkError: '请求超过 120000ms 没有回应,已中断' }],
    });
    const r1 = await timedOut.provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(r1.code, 'timeout');
    assert.match(r1.reason, /超时/);

    const offline = makeProvider({
        script: [{ status: null, ok: false, text: '', timedOut: false, networkError: 'fetch failed' }],
    });
    const r2 = await offline.provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(r2.code, 'network');
    assert.match(r2.reason, /连不上/);
});

test('服务端 500:说成服务端出错,不推给用户的密钥或视频', async () => {
    const { provider } = makeProvider({ script: [{ status: 503, ok: false, text: '<html>503</html>' }] });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.code, 'server_error');
    assert.match(result.reason, /服务端/);
});

test('成功响应里正文是空的:算失败,不许留一条空气泡', async () => {
    const { provider } = makeProvider({
        // 真实形状:流跑完了、finish_reason=length,但一片正文都没有。
        script: [{
            status: 200, ok: true, text: 'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
                + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
                + 'data: [DONE]\n\n',
        }],
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad_response');
    assert.match(result.reason, /输出上限/);
});

test('流跑完但一片正文都没有、也没说为什么:仍然算失败,不许留空气泡', async () => {
    const { provider } = makeProvider({
        script: [{ status: 200, ok: true, text: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n' }],
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad_response');
    assert.match(result.reason, /没有正文/);
});

test('流里 (HTTP 200) 带 error:按失败走,不把错误当正文', async () => {
    const { provider } = makeProvider({
        script: [{ status: 200, ok: true, text: 'data: {"error":{"message":"upstream failed"}}\n\ndata: [DONE]\n\n' }],
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'stream_error');
    assert.match(result.reason, /upstream failed/);
});

test('流式:首字/生成/总计三段耗时与分片数都被记下来(进度不是编的)', async () => {
    const { provider } = makeProvider({
        script: [{
            status: 200, ok: true,
            text: 'data: {"choices":[{"delta":{"content":"一个"},"finish_reason":null}]}\n\n'
                + 'data: {"choices":[{"delta":{"content":"红方块"},"finish_reason":"stop"}]}\n\n'
                + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n'
                + 'data: [DONE]\n\n',
        }],
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, true);
    assert.equal(result.text, '一个红方块');
    assert.equal(result.delivery.chunks, 2, '两片正文就是两片,不许多算');
    assert.equal(result.delivery.mode, 'inline');
    for (const key of ['prepareMs', 'uploadMs', 'ttftMs', 'generateMs', 'totalMs']) {
        assert.equal(typeof result.delivery.timings[key], 'number', `timings 缺 ${key}`);
    }
    assert.equal(result.delivery.timings.uploadMs, 0, '内联那条路根本没有上传这一段');
});

test('流式:进度回调只给叶子字段(准备 → 发送请求体 → 等待 → 每片正文的累计字数)', async () => {
    const events = [];
    const { provider } = makeProvider({
        script: [{
            status: 200, ok: true,
            text: 'data: {"choices":[{"delta":{"content":"aa"},"finish_reason":null}]}\n\n'
                + 'data: {"choices":[{"delta":{"content":"bbb"},"finish_reason":"stop"}]}\n\n'
                + 'data: [DONE]\n\n',
        }],
        // 内联那条路的请求体现在是流:要让"发送中"的进度真的报出来,假传输层得像真的一样把它读完
        drain: true,
    });
    const result = await provider.understand({
        mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4',
        onProgress: (p) => events.push(p),
    });
    assert.equal(result.ok, true);
    assert.equal(events[0].stage, 'preparing');
    assert.equal(events[1].stage, 'prepared');
    assert.equal(events[1].mode, 'inline');
    // prepared 里的 totalBytes 是**文件**大小(标签上显示的就是它);百分比那个分母
    // 是请求体长度,由 uploading 事件给 —— 两者不是同一个数,别混
    assert.equal(events[1].totalBytes, 512, 'prepared 报的是文件大小');
    // 内联现在**有**"发送请求体"这一段(以前整包发,这一段观测不到、连格子都没有)
    const send = events.filter(e => e.stage === 'uploading');
    assert.ok(send.length >= 1, '内联也要报发送进度');
    assert.equal(send[0].mode, 'inline');
    assert.equal(send[0].percent, 0);
    // 发送那一段之后才是"等待首个字"
    const waitAt = events.findIndex(e => e.stage === 'waiting');
    assert.ok(waitAt > events.indexOf(send[send.length - 1]), '顺序:发送 → 等待首字');
    assert.deepEqual(events[waitAt], { stage: 'waiting' });
    const gen = events.filter(e => e.stage === 'generating');
    assert.equal(gen.length, 2);
    assert.deepEqual(gen[0], { stage: 'generating', chars: 2, chunks: 1, delta: 'aa' });
    assert.deepEqual(gen[1], { stage: 'generating', chars: 5, chunks: 2, delta: 'bbb' });
    // 递出去的对象里不许夹带任何非叶子字段(流对象/函数/请求头)
    const nonLeaf = events.flatMap(e => Object.values(e))
        .filter(v => typeof v === 'object' || typeof v === 'function');
    assert.deepEqual(nonLeaf, []);
});

test('策略拒了 / 密钥没配:进度只到「准备」就断,红框落在准备那一行', async () => {
    const events = [];
    const { provider } = makeProvider({ resolveKey: () => ({ ok: false, secret: '', reason: '没有配置 DashScope 密钥。' }) });
    const result = await provider.understand({
        mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4', onProgress: (p) => events.push(p),
    });
    assert.equal(result.code, 'missing_key');
    assert.deepEqual(events, [{ stage: 'preparing' }]);
    assert.deepEqual(events.flatMap(e => Object.values(e)).filter(v => typeof v === 'object'), []);
});

test('传输层违约抛异常:折成一句中文,不许让异常穿过 IPC 边界', async () => {
    const { provider } = makeProvider({ script: [() => { throw new Error('boom'); }] });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'provider_error');
    assert.match(result.reason, /boom/);
});

// ---------- 前置校验:该在发请求之前就拒的,一次请求都不许发 ----------

test('没配密钥:code=missing_key,而且**一次请求都不发**', async () => {
    const { provider, calls } = makeProvider({
        resolveKey: () => ({ ok: false, secret: '', source: null, reason: '没有配置 DashScope 密钥。' }),
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'missing_key');
    assert.match(result.reason, /没有配置 DashScope 密钥/);
    assert.equal(calls.length, 0);
});

test('HTML 改名成 mp4:权威校验拦下,一次请求都不发', async () => {    const { provider, calls } = makeProvider({});
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: html, name: 'x.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_a_video');
    assert.match(result.reason, /字节不是/);
    assert.equal(calls.length, 0);
});

test('超过单段上限(64 MiB):当场拒,不发请求、也不走上传', async () => {
    const { provider, calls } = makeProvider({});
    // 不真的分配 64 MiB:给一个"报出来的长度"超限的字节数组即可(校验按 byteLength 判)
    const bytes = new Uint8Array(64 * 1024 * 1024 + 1);
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
    const result = await provider.understand({ mimeType: 'video/mp4', bytes, name: 'huge.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'too_large');
    assert.match(result.reason, /超过单段上限/);
    assert.equal(calls.length, 0);
});

test('接线错了要当场抛(而不是等用户点「理解」才炸)', () => {
    assert.throws(() => createVideoProvider({ resolveKey: () => ({ ok: true, secret: 'x' }) }), /需要 transport/);
    assert.throws(() => createVideoProvider({ transport: async () => ({ ok: true, text: '' }) }), /需要 resolveKey/);
});

// ---------- 按本地路径理解(队列里下好的文件走这条) ----------

const LOCAL_FOLDER = 'D:\\project\\bilidown\\download';
const LOCAL_FILE = `${LOCAL_FOLDER}\\中国人能飞😭 [高清 1080P60] NA.mp4`;
const BIG = 177737264;                  // 169.5 MB(用户那个真实的文件)

/** 注入一套"假盘":statFile / readFileBytes / openFileStream / readInto 都可控。 */
function makePathProvider({ size = BIG, script = [], config } = {}) {
    const { calls, transport } = makeTransport(script);
    const seen = { reads: 0, streams: 0, readInto: 0 };
    const provider = createVideoProvider({
        transport,
        resolveKey: () => ({ ok: true, secret: SECRET, source: 'settings', reason: null }),
        config: config ?? (() => ({ model: 'qwen3-vl-flash', maxTokens: 456, inlineLimitBytes: 1024 })),
        log: { info() {}, warn() {}, error() {} },
        now: () => 1700000000000,
        random: () => 0.25,
        statFile: (p) => (p === LOCAL_FILE ? { exists: true, isFile: true, size } : { exists: false, isFile: false, size: 0 }),
        readFileBytes: (p) => { seen.reads += 1; return new Uint8Array(size); },
        // 文件流:一条极小的假 Web Stream(内容不重要,重要的是"没有把整份读进内存")
        openFileStream: () => {
            seen.streams += 1;
            return composeUploadStream([new Uint8Array([1, 2, 3])]);
        },
        readInto: () => { seen.readInto += 1; },
    });
    return { provider, calls, seen };
}

test('按路径:169.5 MB 不再被 64 MiB 拦下 —— 走临时上传,而且用的是**流**', async () => {
    const { provider, calls, seen } = makePathProvider({
        script: [
            { status: 200, ok: true, text: JSON.stringify({ data: POLICY }) },
            { status: 200, ok: true, text: '' },
            { status: 200, ok: true, text: okChat('这是一段游戏实况混剪。', 127766) },
        ],
    });
    const result = await provider.understandFromPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER, question: '描述一下' });

    assert.equal(result.ok, true);
    assert.equal(result.usage.videoTokens, 127766);
    assert.equal(result.delivery.mode, 'upload');
    assert.equal(result.delivery.bytes, BIG);
    // ★ 关键:上传用**流**,不是先拼一整块请求体
    assert.equal(result.delivery.uploadBody, 'stream');
    assert.equal(seen.streams, 1);
    assert.equal(seen.reads, 0, '这么大不该整读进内存');
    assert.equal(seen.readInto, 0, '走的是流式,不该退回"单份缓冲"');
    const upload = calls[1];
    assert.equal(upload.url, POLICY.upload_host);
    assert.equal(Number(upload.headers['Content-Length']) > BIG, true, '要带上算好的 Content-Length');
    assert.equal(upload.duplex, 'half', '流式请求体必须声明 half duplex');
    assert.equal(typeof upload.body?.getReader, 'function', 'body 应该是一条流');
    assert.equal(upload.headers.Authorization, undefined, 'OSS 表单上传不该收到 Authorization');
});

test('按路径:超时按"大文件"给(上传 10 分钟 / 对话 5 分钟);过 IPC 那条不放大', async () => {
    const { provider, calls } = makePathProvider({
        script: [
            { status: 200, ok: true, text: JSON.stringify({ data: POLICY }) },
            { status: 200, ok: true, text: '' },
            { status: 200, ok: true, text: okChat() },
        ],
    });
    await provider.understandFromPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER });
    assert.equal(calls[1].timeoutMs, LOCAL_UPLOAD_TIMEOUT_MS);
    assert.equal(calls[2].timeoutMs, LOCAL_CHAT_TIMEOUT_MS);
    assert.equal(LOCAL_UPLOAD_TIMEOUT_MS, 600000);
    assert.equal(LOCAL_CHAT_TIMEOUT_MS, 300000);

    const ipc = makeProvider({ script: [{ status: 200, ok: true, text: okChat() }] });
    await ipc.provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'a.mp4' });
    assert.equal(ipc.calls[0].timeoutMs, 1234, '配置里的值仍说了算');
});

test('按路径:小文件走内联(整读一次合理),不白传一趟 OSS', async () => {
    const { provider, calls, seen } = makePathProvider({
        size: 4096,
        config: () => ({ model: 'qwen3-vl-flash', maxTokens: 100 }),
        script: [{ status: 200, ok: true, text: okChat('小的', 12) }],
    });
    const result = await provider.understandFromPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER });
    assert.equal(result.ok, true);
    assert.equal(result.delivery.mode, 'inline');
    assert.equal(seen.reads, 1);
    assert.equal(calls.length, 1, '内联只该有一次对话请求');
});

test('按路径:流式被拒(duplex/Content-Length 那类)时退回"单份缓冲",仍然只有一份文件', async () => {
    const { provider, calls, seen } = makePathProvider({
        script: [
            { status: 200, ok: true, text: JSON.stringify({ data: POLICY }) },
            { status: null, ok: false, text: '', timedOut: false, networkError: 'Request body is a stream, Content-Length is not allowed' },
            { status: 200, ok: true, text: '' },
            { status: 200, ok: true, text: okChat('退回缓冲也能理解。', 999) },
        ],
    });
    const result = await provider.understandFromPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER });
    assert.equal(result.ok, true);
    assert.equal(result.delivery.uploadBody, 'single-copy-buffer');
    assert.equal(seen.readInto, 1, '兜底那条把文件读进缓冲');
    assert.equal(seen.reads, 0, '绝不能整读成另一份 Buffer');
    assert.equal(calls.length, 4);
});

test('上传那条路也走**流式**:三段耗时都记下来(自标定靠它),而 uploadBody/policyMs 那些老口径照旧', async () => {
    const { provider } = makePathProvider({
        script: [
            { status: 200, ok: true, text: JSON.stringify({ data: POLICY }) },
            { status: 200, ok: true, text: '' },
            {
                status: 200, ok: true,
                text: 'data: {"choices":[{"delta":{"content":"混剪"},"finish_reason":null}]}\n\n'
                    + 'data: {"choices":[{"delta":{"content":"。"},"finish_reason":"stop"}]}\n\n'
                    + 'data: {"choices":[],"usage":{"prompt_tokens":127799,"completion_tokens":2,"total_tokens":128599,"prompt_tokens_details":{"video_tokens":127766,"text_tokens":33}}}\n\n'
                    + 'data: [DONE]\n\n',
            },
        ],
    });
    const events = [];
    const result = await provider.understandFromPath({
        path: LOCAL_FILE, folder: LOCAL_FOLDER, question: '描述一下', onProgress: (p) => events.push(p),
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, '混剪。');
    assert.equal(result.usage.videoTokens, 127766);
    const t = result.delivery.timings;
    for (const key of ['prepareMs', 'uploadMs', 'ttftMs', 'generateMs', 'totalMs']) {
        assert.equal(typeof t[key], 'number', `timings 缺 ${key}`);
    }
    assert.equal(result.delivery.chunks, 2, '分片数进 delivery:报告"流式到底分了多细"要看它');
    // ⚠️ 上传那几段的**老口径**必须留着:报告里"上传到底多快"一直是用它们说的
    assert.equal(typeof result.delivery.uploadMs, 'number');
    assert.equal(typeof result.delivery.policyMs, 'number');
    assert.equal(typeof result.delivery.chatMs, 'number');
    assert.equal(result.delivery.uploadBody, 'stream');

    // 进度事件里必须有"已交由连接"的字节数(上传百分比就是从它来的)
    const uploading = events.filter(e => e.stage === 'uploading');
    assert.ok(uploading.length >= 1, '流式上传必须报进度');
    assert.equal(uploading[0].totalBytes, BIG);
    assert.equal(Number.isFinite(uploading[0].sentBytes), true);
    assert.equal(Number.isFinite(uploading[0].percent), true);
    // 阶段顺序:preparing → prepared → (uploading…) → waiting → generating…
    const order = events.map(e => e.stage);
    assert.equal(order[0], 'preparing');
    assert.equal(order[1], 'prepared');
    assert.equal(order.includes('waiting'), true);
    assert.equal(order.at(-1), 'generating');
    assert.equal(order.indexOf('waiting') < order.lastIndexOf('generating'), true);
});

test('按路径:业务失败(403)不退缓冲 —— 换一种发法也是白传 170 MB', async () => {
    const { provider, calls } = makePathProvider({
        script: [
            { status: 200, ok: true, text: JSON.stringify({ data: POLICY }) },
            { status: 403, ok: false, text: '<Error><Code>AccessDenied</Code></Error>' },
        ],
    });
    const result = await provider.understandFromPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'upload_failed');
    assert.equal(calls.length, 2, '不该再试一次');
});

test('按路径:不存在 / 不在下载目录 / 扩展名不对 / 相对路径 / 空路径 —— 全在一次请求都不发的情况下拒', async () => {
    const { provider, calls } = makePathProvider({});
    const cases = [
        [{ path: `${LOCAL_FOLDER}\\没有这个.mp4`, folder: LOCAL_FOLDER }, 'file_missing'],
        [{ path: 'C:\\Windows\\notepad.mp4', folder: LOCAL_FOLDER }, 'outside_folder'],
        [{ path: `${LOCAL_FOLDER}\\a.txt`, folder: LOCAL_FOLDER }, 'bad_extension'],
        [{ path: 'a.mp4', folder: LOCAL_FOLDER }, 'bad_path'],
        [{ path: '', folder: LOCAL_FOLDER }, 'bad_path'],
    ];
    for (const [input, expected] of cases) {
        const result = await provider.understandFromPath(input);
        assert.equal(result.ok, false, JSON.stringify(input));
        assert.equal(result.code, expected, JSON.stringify(input));
        assert.ok(String(result.reason).length > 0, '每个失败都要有一句能读的中文');
    }
    assert.equal(calls.length, 0, '这些都不该发任何请求');
});

test('按路径:没配密钥时一次请求都不发(与过 IPC 那条同一条规矩)', async () => {
    const { calls, transport } = makeTransport([]);
    const provider = createVideoProvider({
        transport,
        resolveKey: () => ({ ok: false, secret: '', reason: '没有配置 DashScope 密钥。' }),
        config: () => ({}),
        log: { info() {}, warn() {}, error() {} },
        statFile: () => ({ exists: true, isFile: true, size: BIG }),
        readFileBytes: () => new Uint8Array(2),
        openFileStream: () => null,
    });
    const result = await provider.understandFromPath({ path: LOCAL_FILE, folder: LOCAL_FOLDER });
    assert.equal(result.code, 'missing_key');
    assert.equal(calls.length, 0);
});

test('上传流:一次 pull 只喂一块(背压生效)—— 不是"在 start 里一路 enqueue"', async () => {
    // 这条钉住的是**内存口径**:start() 里 enqueue 从不阻塞,消费端慢下来时队列会一路涨
    // (实测那版把 169 MB 全堆进流队列)。pull 模式下一块一块来。
    let produced = 0;
    const fakeFile = {
        getReader() {
            let index = 0;
            return {
                async read() {
                    index += 1;
                    produced += 1;
                    return index > 3 ? { done: true, value: undefined } : { done: false, value: new Uint8Array(16) };
                },
            };
        },
    };
    const stream = composeUploadStream([new Uint8Array([1]), fakeFile, new Uint8Array([2])]);
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    // ★ 背压的判据:还只读了"前缀"这一块,文件那边**一次都没被读过** ——
    //   在 start() 里一路 enqueue 的写法下,这里早就是 4 了。
    assert.equal(produced, 0, '文件流不该在没人要的时候就被读走');
    const chunks = [first.value];
    for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        chunks.push(value);
    }
    assert.equal(chunks.length, 5, '前缀 + 3 块文件 + 后缀');
    assert.equal(produced, 4);
});

// ---------- 图片:与视频同一条路(同一个端点/解析/错误映射,只换 content 项) ----------

test('understandImage:走的是同一个端点与鉴权的**内联**路(不另写一套)', async () => {
    // 一张最小的合法 PNG(签名对就够了:判据只看签名)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const { provider, calls } = makeProvider({ script: [{ status: 200, ok: true, text: okChat('红色', 0) }] });

    const result = await provider.understandImage({ mimeType: 'image/png', bytes: png, question: '什么颜色?' });

    assert.equal(result.ok, true);
    assert.equal(result.text, '红色');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DASHSCOPE_BASE_URL}${CHAT_PATH}`);
    assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);
    const content = JSON.parse(calls[0].body).messages[0].content;
    assert.equal(content[0].type, 'image_url');
    assert.ok(content[0].image_url.url.startsWith('data:image/png;base64,'));
    assert.equal(content[1].text, '什么颜色?');
    assert.equal(result.delivery.mode, 'inline');
});

test('understandImage:错误映射与视频共用同一份(401 → auth_failed)', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const { provider } = makeProvider({
        script: [{ status: 401, ok: false, text: JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided.' } }) }],
    });
    const result = await provider.understandImage({ mimeType: 'image/png', bytes: png, question: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_failed');
});

test('understandImage:字节不是图片时当场拒(判据来自 agent-image 那一份)', async () => {
    const { provider, calls } = makeProvider({});
    const html = new TextEncoder().encode('<html>');
    const result = await provider.understandImage({ mimeType: 'image/png', bytes: html, question: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_input');
    assert.equal(calls.length, 0);
});

// ---------- 密钥与请求体不许外泄 ----------

test('密钥不出现在返回值、日志与上传表单里', async () => {
    const { provider, logLines } = makeProvider({
        script: [
            { status: 200, ok: true, text: JSON.stringify({ data: POLICY }) },
            { status: 200, ok: true, text: '' },
            { status: 200, ok: true, text: okChat() },
        ],
        config: () => ({ inlineLimitBytes: 16 }),
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(logLines.join('\n').includes(SECRET), false);
    // 日志里要能看出走了哪条路,但不能有请求体(base64)与密钥
    assert.match(logLines.join('\n'), /→ upload/);
});

test('失败结果里也没有密钥(鉴权失败那条路最容易顺手把密钥拼进原因)', async () => {
    const { provider, logLines } = makeProvider({
        script: [{ status: 401, ok: false, text: JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided.' } }) }],
    });
    const result = await provider.understand({ mimeType: 'video/mp4', bytes: mp4(512), name: 'v.mp4' });
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(logLines.join('\n').includes(SECRET), false);
});

// ---------- 默认传输层(createFetchTransport)自己的契约 ----------

test('createFetchTransport:成功/失败/网络异常都折成同一个形状,而且**不抛**', async () => {
    const ok = createFetchTransport({
        fetchImpl: async () => ({ status: 200, ok: true, text: async () => 'hello' }),
    });
    assert.deepEqual(await ok({ url: 'u', method: 'POST' }), { status: 200, ok: true, text: 'hello', timedOut: false, networkError: '' });

    const bad = createFetchTransport({ fetchImpl: async () => ({ status: 500, ok: false, text: async () => 'oops' }) });
    assert.equal((await bad({ url: 'u' })).ok, false);

    const boom = createFetchTransport({ fetchImpl: async () => { throw new Error('no route to host'); } });
    const r = await boom({ url: 'u' });
    assert.equal(r.ok, false);
    assert.equal(r.status, null);
    assert.match(r.networkError, /no route to host/);
});

test('createFetchTransport:超时**真的**会中断(不是只把开关置上)', async () => {
    let aborted = false;
    const transport = createFetchTransport({
        // 模拟一个永不返回的请求:监听 abort 信号
        fetchImpl: (url, opts) => new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('The operation was aborted'));
            });
        }),
    });
    const r = await transport({ url: 'u', timeoutMs: 20 });
    assert.equal(aborted, true);
    assert.equal(r.timedOut, true);
    assert.equal(r.ok, false);
    assert.match(r.networkError, /没有回应/);
});

test('createFetchTransport:环境里没有 fetch 时说清楚,而不是 TypeError', async () => {
    const transport = createFetchTransport({ fetchImpl: null, log: { warn() {} } });
    const saved = globalThis.fetch;
    // 临时把全局 fetch 摘掉(这个测试必须把它放回去)
    try {
        globalThis.fetch = undefined;
        const r = await transport({ url: 'u' });
        assert.equal(r.ok, false);
        assert.match(r.networkError, /没有 fetch/);
    } finally {
        globalThis.fetch = saved;
    }
});
