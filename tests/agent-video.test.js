import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_VIDEO_MODEL, DEFAULT_VIDEO_QUESTION, INLINE_SAFETY_MARGIN_BYTES, MAX_DATA_URI_BYTES,
    MAX_LOCAL_VIDEO_BYTES, MAX_QUESTION_CHARS, MAX_VIDEO_BYTES, MAX_VIDEOS_PER_PROMPT,
    OSS_RESOLVE_HEADER, OSS_RESOLVE_VALUE, VIDEO_AUDIO_NOTICE, VIDEO_FILE_EXTENSIONS,
    VIDEO_KEY_ENV_NOTICE, VIDEO_KEY_PLAIN_NOTICE, VIDEO_MIME_LABEL, VIDEO_MIME_TYPES, VIDEO_MODELS,
    admitVideoPath, admitVideoPayload, base64Length, buildChatBody, buildDataUrl, buildInlineBodyParts,
    buildMediaContent,
    buildMultipartBody, buildMultipartParts, buildOssUrl, buildUploadFormFields, chooseDelivery,
    clampQuestion, classifyChatFailure, dataUriLength, describeVideoKeyStatus, encodeBase64Chunks,
    extractStreamText, INLINE_BODY_CHUNK_BYTES, inlineChunkStep,
    normalizeStreamUsage, normalizeVideoMime, normalizeVideoModel, parseChatResponse, parseErrorBody,
    parseStreamPayload, parseUploadPolicy, safeVideoName, splitSseEvents, sniffVideoMime,
    uniqueUploadName, validateVideoCandidate, videoSniffVerdict,
} from '../app/lib/agent-video.js';
// 一次性编码那一份(内联流式分块必须与它逐字节相同,所以直接拿它来对比)
import { toCanonicalBase64 } from '../app/lib/agent-image.js';

// 视频理解这条链路的**纯逻辑**:什么能收、什么必须拒、体积走哪条路、
// 请求体长什么样、服务端的失败怎么读成人话。
//
// 为什么这些必须是纯函数的用例(与 agent-image.test.js 同一个立场):
//   1. 判据只有一份,渲染层(即时反馈)、主进程(权威校验)、provider 三处都用它 ——
//      判错的方向一边是"用户唯一那段视频被悄悄吞掉",另一边是"不可信的字节被外发";
//   2. 「内联还是上传」的分发**必须**在发请求之前就有确定答案,不能靠"发一次看看
//      服务端怎么说"——那既费流量又要等两秒;
//   3. 错误映射判错的表现是"密钥没配却提示网络问题",用户会照着错的提示去改错的东西。
//
// ⚠️ 这里**一个真实网络请求都没有**:本文件只测纯函数。

// ---- 真实容器签名(只取开头几个字节:判据只看签名,不需要能解码的完整文件) ----
/** MP4:第 5–8 字节是 'ftyp',brand 是 'isom'。 */
const MP4_HEAD = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
]);
/** MOV:同一个 ftyp,但 brand 是 'qt  '(QuickTime)。 */
const MOV_HEAD = new Uint8Array([
    0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
    0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x00, 0x08,
]);
/** WebM:EBML 魔数 + 头里的 DocType "webm"。 */
const WEBM_HEAD = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81,
    0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
    0x04, 0x42, 0xf3, 0x81, 0x08, 0x77, 0x65, 0x62, 0x6d,
]);
/** 一段"自称是 mp4、其实是 HTML"的字节 —— 必须被拒(接下来它会被外发给第三方)。 */
const NOT_A_VIDEO = new Uint8Array([
    0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e,
]);

/** 造一段"够长"的假视频:签名对 + 指定总长度。 */
function fakeVideo(byteLength, head = MP4_HEAD) {
    const out = new Uint8Array(byteLength);
    out.set(head.subarray(0, Math.min(head.length, byteLength)), 0);
    return out;
}

// ---------- MIME 归一与签名 ----------

test('白名单与"只支持"那句文案是一对(界面照着它说原因)', () => {
    assert.deepEqual([...VIDEO_MIME_TYPES], ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']);
    assert.equal(VIDEO_MIME_LABEL, 'MP4 / MOV / WebM / MKV');
});

test('normalizeVideoMime 只认白名单,大小写与 codecs 参数都归一', () => {
    assert.equal(normalizeVideoMime('video/mp4'), 'video/mp4');
    assert.equal(normalizeVideoMime('VIDEO/MP4'), 'video/mp4');
    assert.equal(normalizeVideoMime('  video/webm  '), 'video/webm');
    assert.equal(normalizeVideoMime('video/mp4; codecs=avc1'), 'video/mp4');
    // macOS/QuickTime 常给这个别名,内容是 MP4 容器
    assert.equal(normalizeVideoMime('video/x-m4v'), 'video/mp4');
});

test('normalizeVideoMime 对白名单之外的一律返回空串(不猜)', () => {
    for (const bad of ['', '   ', 'video/avi', 'video/x-msvideo', 'image/png', 'mp4', 'video', null, undefined, 42]) {
        assert.equal(normalizeVideoMime(bad), '', `${String(bad)} 不该被当成能收的视频`);
    }
});

test('sniffVideoMime 认得出 mp4 / mov / webm 的签名', () => {
    assert.equal(sniffVideoMime(MP4_HEAD), 'video/mp4');
    assert.equal(sniffVideoMime(MOV_HEAD), 'video/quicktime');
    assert.equal(sniffVideoMime(WEBM_HEAD), 'video/webm');
});

test('sniffVideoMime 不认得的字节返回空串(HTML 改名成 .mp4 会被这一步抓出来)', () => {
    assert.equal(sniffVideoMime(NOT_A_VIDEO), '');
    assert.equal(sniffVideoMime(new Uint8Array(0)), '');
    assert.equal(sniffVideoMime(null), '');
});

// ---------- 单段的即时判断(渲染层用的那一条) ----------

test('一段正常的 mp4 通过,并回一个归一过的 mime', () => {
    const v = validateVideoCandidate({ mimeType: 'VIDEO/MP4', byteLength: 1024, existing: [] });
    assert.deepEqual(v, { ok: true, mimeType: 'video/mp4' });
});

test('格式不在白名单:拒绝,而且原因里点名"只接受哪几种"', () => {
    const v = validateVideoCandidate({ mimeType: 'video/avi', byteLength: 1024, existing: [] });
    assert.equal(v.ok, false);
    assert.match(v.reason, /不支持的视频格式/);
    assert.match(v.reason, /video\/avi/);
    assert.ok(v.reason.includes(VIDEO_MIME_LABEL));
});

test('第二段被拒(服务端一次只听一段)', () => {
    const v = validateVideoCandidate({ mimeType: 'video/mp4', byteLength: 1024, existing: [{ byteLength: 2048 }] });
    assert.equal(v.ok, false);
    assert.match(v.reason, new RegExp(`一次只能理解 ${MAX_VIDEOS_PER_PROMPT} 段`));
});

test('单段超限:原因里同时给出这一段多大、上限多少', () => {
    const v = validateVideoCandidate({ mimeType: 'video/mp4', byteLength: MAX_VIDEO_BYTES + 1, existing: [] });
    assert.equal(v.ok, false);
    assert.match(v.reason, /超过单段上限/);
    assert.match(v.reason, /64\.0 MB/);
});

test('0 字节与"报不出大小"都被拒(不是静默收下)', () => {
    assert.match(validateVideoCandidate({ mimeType: 'video/mp4', byteLength: 0, existing: [] }).reason, /空的/);
    assert.match(validateVideoCandidate({ mimeType: 'video/mp4', byteLength: NaN, existing: [] }).reason, /报不出大小/);
});

// ---------- 主进程侧的权威校验 ----------

test('admitVideoPayload:叶子数据收成字节 + 声明与签名一致才算过', () => {
    const r = admitVideoPayload([{ mimeType: 'video/mp4', bytes: fakeVideo(64), name: 'a.mp4' }]);
    assert.equal(r.ok, true);
    assert.equal(r.videos.length, 1);
    assert.equal(r.videos[0].mimeType, 'video/mp4');
    assert.equal(r.videos[0].bytes.byteLength, 64);
    assert.equal(r.videos[0].name, 'a.mp4');
});

test('admitVideoPayload:空/未给时是"没有视频",不是失败', () => {
    assert.deepEqual(admitVideoPayload(undefined), { ok: true, videos: [] });
    assert.deepEqual(admitVideoPayload([]), { ok: true, videos: [] });
});

test('admitVideoPayload:HTML 改名成 mp4 —— 声明对上、字节对不上,拒', () => {
    const r = admitVideoPayload([{ mimeType: 'video/mp4', bytes: NOT_A_VIDEO, name: 'x.mp4' }]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /字节不是/);
});

test('admitVideoPayload:声明与签名是不相容的两种容器时拒(比如声明 mp4、字节是 webm)', () => {
    const r = admitVideoPayload([{ mimeType: 'video/mp4', bytes: WEBM_HEAD, name: 'x.mp4' }]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /字节其实是 video\/webm/);
});

test('admitVideoPayload:mp4 与 mov 同源,互相声明不算"声明不实"', () => {
    const r = admitVideoPayload([{ mimeType: 'video/quicktime', bytes: MP4_HEAD, name: 'x.mov' }]);
    assert.equal(r.ok, true);
    assert.equal(r.videos[0].mimeType, 'video/quicktime');
});

test('admitVideoPayload:两段直接拒(不看到底哪一段有问题)', () => {
    const one = { mimeType: 'video/mp4', bytes: MP4_HEAD, name: 'a.mp4' };
    const r = admitVideoPayload([one, one]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /收到 2 段/);
});

test('admitVideoPayload:bytes 不是字节数组时拒(普通字符串/对象都不收)', () => {
    for (const bad of ['字符串', 42, { length: 3 }, null]) {
        const r = admitVideoPayload([{ mimeType: 'video/mp4', bytes: bad, name: 'a.mp4' }]);
        assert.equal(r.ok, false, `${String(bad)} 不该被当成字节`);
    }
});

test('admitVideoPayload 收得下数字数组(手写的假桥/测试会这么递)', () => {
    const r = admitVideoPayload([{ mimeType: 'video/mp4', bytes: [...MP4_HEAD], name: 'a.mp4' }]);
    assert.equal(r.ok, true);
    assert.equal(r.videos[0].bytes.byteLength, MP4_HEAD.length);
});

// ---------- 体积 → 投递路径(核心判据) ----------

test('base64Length 就是服务端那个上限判的那一段长度(4*ceil(n/3))', () => {
    assert.equal(base64Length(3), 4);
    assert.equal(base64Length(1), 4);
    assert.equal(base64Length(0), 0);
    // 实测:15 MiB 的原始文件 → base64 恰好 20,971,520 字节,**服务端接受**
    assert.equal(base64Length(15 * 1024 * 1024), 20971520);
    // 实测:15.7 MiB → base64 21,950,192(整条 data-uri 21,950,214),**被 400 拒**
    assert.equal(base64Length(16462643), 21950192);
});

test('dataUriLength 包含 data: 前缀(它只用于日志里的读数,判据不用它)', () => {
    assert.equal(dataUriLength('video/mp4', 3), 'data:video/mp4;base64,'.length + 4);
});

test('分发:小文件走内联,大文件走临时上传,超上限直接拒', () => {
    const small = chooseDelivery({ byteLength: 1024 * 1024, mimeType: 'video/mp4' });
    assert.equal(small.mode, 'inline');
    assert.match(small.reason, /直接内联/);

    // 15 MiB 虽然服务端收得下,但默认留了 1 MiB 余量 —— 所以这里判成上传。
    const big = chooseDelivery({ byteLength: 15 * 1024 * 1024, mimeType: 'video/mp4' });
    assert.equal(big.mode, 'upload');
    assert.match(big.reason, /改走临时上传/);

    const over = chooseDelivery({ byteLength: MAX_VIDEO_BYTES + 1, mimeType: 'video/mp4' });
    assert.equal(over.mode, 'reject');
    assert.match(over.reason, /超过这条入口的单段上限/);
});

test('分发:上限按**入口**换 —— 本地路径那条用服务端自己报的 1024 MB', () => {
    // 169.5 MB(用户那个真实的文件):拖入/粘贴那条会被拒(过 IPC 的量太大);
    // 按路径那条应当放行,并判成"走临时上传"。
    const big = 177737264;
    const viaIpc = chooseDelivery({ byteLength: big, mimeType: 'video/mp4' });
    assert.equal(viaIpc.mode, 'reject');
    assert.equal(viaIpc.maxBytes, MAX_VIDEO_BYTES);

    const viaPath = chooseDelivery({ byteLength: big, mimeType: 'video/mp4', maxBytes: MAX_LOCAL_VIDEO_BYTES });
    assert.equal(viaPath.mode, 'upload');
    assert.equal(viaPath.maxBytes, MAX_LOCAL_VIDEO_BYTES);
    assert.match(viaPath.reason, /改走临时上传/);

    const overPath = chooseDelivery({
        byteLength: MAX_LOCAL_VIDEO_BYTES + 1, mimeType: 'video/mp4', maxBytes: MAX_LOCAL_VIDEO_BYTES,
    });
    assert.equal(overPath.mode, 'reject');
    assert.match(overPath.reason, /1024\.0 MB/);
});

test('分发:把余量去掉之后,实测通过的那个边界(15 MiB)确实判成内联', () => {
    const d = chooseDelivery({
        byteLength: 15 * 1024 * 1024,
        mimeType: 'video/mp4',
        inlineLimitBytes: MAX_DATA_URI_BYTES,
    });
    assert.equal(d.mode, 'inline');
    // 再多一个字节就越过服务端的硬上限,必须改走上传
    const over = chooseDelivery({
        byteLength: 15 * 1024 * 1024 + 1,
        mimeType: 'video/mp4',
        inlineLimitBytes: MAX_DATA_URI_BYTES,
    });
    assert.equal(over.mode, 'upload');
});

test('分发:大小报不出来(0 / NaN)时拒绝,而不是当成小文件内联', () => {
    assert.equal(chooseDelivery({ byteLength: 0 }).mode, 'reject');
    assert.equal(chooseDelivery({ byteLength: NaN }).mode, 'reject');
    assert.equal(chooseDelivery({}).mode, 'reject');
});

test('分发的默认内联上限就是"服务端硬上限 - 1 MiB 余量"', () => {
    const d = chooseDelivery({ byteLength: 1024 });
    assert.equal(d.inlineLimitBytes, MAX_DATA_URI_BYTES - INLINE_SAFETY_MARGIN_BYTES);
});

// ---------- 请求体构造 ----------

test('buildDataUrl 的形状与实测跑通的那次逐字一致', () => {
    assert.equal(buildDataUrl({ mimeType: 'video/mp4', base64: 'AAAA' }), 'data:video/mp4;base64,AAAA');
});

test('buildMediaContent:视频在前、提问在后(实测跑通的顺序)', () => {
    const content = buildMediaContent({ url: 'data:video/mp4;base64,AA', question: '里面有什么?' });
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AA' } });
    assert.deepEqual(content[1], { type: 'text', text: '里面有什么?' });
});

test('buildMediaContent 也覆盖图片(同一个 provider 一条路,不写两套)', () => {
    const content = buildMediaContent({ url: 'data:image/png;base64,AA', question: '什么颜色?', kind: 'image' });
    assert.deepEqual(content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } });
});

test('没写提问时用默认那一句(不是空文本 —— 空问题等于什么都没问)', () => {
    const content = buildMediaContent({ url: 'x', question: '   ' });
    assert.equal(content[1].text, DEFAULT_VIDEO_QUESTION);
});

test('提问过长要截断,而且**明说**被截断了', () => {
    const long = '啊'.repeat(MAX_QUESTION_CHARS + 50);
    const r = clampQuestion(long);
    assert.equal(r.truncated, true);
    assert.ok(r.text.includes('已截断'));
});

test('buildChatBody:模型收敛到白名单,而且**不带 fps**(它被服务端静默忽略)', () => {
    const body = buildChatBody({ model: 'QWEN3-VL-PLUS', content: [{ type: 'text', text: 'x' }] });
    assert.equal(body.model, 'qwen3-vl-plus');
    assert.equal(body.max_tokens, 800);
    assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]);
    assert.equal('fps' in body, false);
    assert.equal(JSON.stringify(body).includes('fps'), false);
});

test('buildChatBody:不认识的模型退回默认,非法 max_tokens 退回默认', () => {
    const body = buildChatBody({ model: 'gpt-4o', content: [], maxTokens: -5 });
    assert.equal(body.model, DEFAULT_VIDEO_MODEL);
    assert.equal(body.max_tokens, 800);
});

test('normalizeVideoModel 只认实测可用的那两三个', () => {
    assert.equal(normalizeVideoModel('qwen3-vl-flash'), 'qwen3-vl-flash');
    assert.equal(normalizeVideoModel(' qwen3-vl-plus '), 'qwen3-vl-plus');
    assert.equal(normalizeVideoModel('qwen-max'), '');
    assert.ok(VIDEO_MODELS.some(m => m.id === DEFAULT_VIDEO_MODEL));
});

test('音频说明不是空话:它明说模型听不到声音(界面必须显示这一句)', () => {
    assert.match(VIDEO_AUDIO_NOTICE, /听不到声音/);
    assert.match(VIDEO_AUDIO_NOTICE, /对话|旁白/);
});

// ---------- 返回解析 ----------

test('parseChatResponse:摘出正文、用量,以及**视频部分的真实 token**(成本读数)', () => {
    const parsed = parseChatResponse({
        model: 'qwen3-vl-flash',
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: '一个红方块从左向右移动。' }, finish_reason: 'stop' }],
        usage: {
            prompt_tokens: 352, completion_tokens: 231, total_tokens: 583,
            prompt_tokens_details: { text_tokens: 30, video_tokens: 322, cached_tokens: 256 },
        },
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.text, '一个红方块从左向右移动。');
    assert.equal(parsed.usage.videoTokens, 322);
    assert.equal(parsed.usage.promptTokens, 352);
    assert.equal(parsed.usage.completionTokens, 231);
    assert.equal(parsed.model, 'qwen3-vl-flash');
    assert.equal(parsed.requestId, 'chatcmpl-1');
});

test('parseChatResponse:content 是数组时也要读出来(有的兼容层这么回)', () => {
    const parsed = parseChatResponse({ choices: [{ message: { content: [{ type: 'text', text: '红' }, { text: '色' }] } }] });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.text, '红色');
});

test('parseChatResponse:空正文是失败,不是"成功但没内容"', () => {
    const parsed = parseChatResponse({ choices: [{ message: { content: '   ' }, finish_reason: 'length' }] });
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /输出上限/);
});

test('parseChatResponse:响应体里有 error 就按失败处理', () => {
    const parsed = parseChatResponse({ error: { message: 'boom' } });
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /boom/);
});

test('parseChatResponse:不是对象/坏响应都要有一句中文,不抛', () => {
    for (const bad of [null, '字符串', 42, []]) {
        const parsed = parseChatResponse(bad);
        assert.equal(parsed.ok, false);
        assert.ok(String(parsed.reason).length > 0);
    }
});

// ---------- 错误映射(实测到的三条 + 超时/网络/限流) ----------

test('classtify:401 + invalid_api_key → auth_failed(界面据此亮出密钥输入框)', () => {
    // 实测原文:Incorrect API key provided. For details, see: …
    const r = classifyChatFailure({
        status: 401,
        body: { error: { message: 'Incorrect API key provided. For details, see: https://help.aliyun.com/…', code: 'invalid_api_key' } },
    });
    assert.equal(r.code, 'auth_failed');
    assert.match(r.reason, /鉴权失败/);
    assert.match(r.reason, /Incorrect API key/);
});

test('classtify:404 + model_not_found → model_not_found(与"密钥不对"分得开)', () => {
    // 实测原文:The model `qwen3-vl-nonexistent-xyz` does not exist or you do not have access to it.
    const r = classifyChatFailure({
        status: 404,
        body: { error: { message: 'The model `qwen3-vl-nonexistent-xyz` does not exist or you do not have access to it.', code: 'model_not_found' } },
    });
    assert.equal(r.code, 'model_not_found');
    assert.match(r.reason, /模型不存在/);
});

test('classtify:400 + data-uri 上限那句原文 → payload_too_large(并给出下一步)', () => {
    const r = classifyChatFailure({
        status: 400,
        body: { error: { message: 'Exceeded limit on max bytes per data-uri item : 20971520', code: null } },
    });
    assert.equal(r.code, 'payload_too_large');
    assert.match(r.reason, /太大/);
    assert.match(r.reason, /临时上传/);
});

test('classtify:超时与网络故障各有各的码(不能都说成"密钥不对")', () => {
    assert.equal(classifyChatFailure({ status: null, timedOut: true }).code, 'timeout');
    assert.equal(classifyChatFailure({ status: null, network: true, message: 'fetch failed' }).code, 'network');
});

test('classtify:429 / 5xx / 其他 400 各归各的', () => {
    assert.equal(classifyChatFailure({ status: 429, body: {} }).code, 'rate_limited');
    assert.equal(classifyChatFailure({ status: 503, body: {} }).code, 'server_error');
    assert.equal(classifyChatFailure({ status: 400, body: { error: { message: 'bad' } } }).code, 'bad_request');
    assert.equal(classifyChatFailure({}).code, 'unknown');
});

test('parseErrorBody 同时认兼容模式(error 包一层)与百炼原生(顶层 code/message)', () => {
    assert.deepEqual(parseErrorBody({ error: { code: 'c1', message: 'm1' } }), { code: 'c1', message: 'm1' });
    assert.deepEqual(parseErrorBody({ code: 'c2', message: 'm2' }), { code: 'c2', message: 'm2' });
    assert.deepEqual(parseErrorBody(null), { code: '', message: '' });
});

// ---------- 临时上传那条路 ----------

test('parseUploadPolicy:真实字段一个不少地收下(注意**没有** x_oss_security_token)', () => {
    // 实测返回的 key 集合就是这一组(证据在交付报告里)
    const r = parseUploadPolicy({
        request_id: 'r1',
        data: {
            policy: 'eyJ…', signature: 'sig', upload_dir: 'dashscope-instant/a/2026-09-19/b',
            upload_host: 'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com',
            oss_access_key_id: 'LTAI…', x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true', expire_in_seconds: 300, max_file_size_mb: 1024,
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.policy.objectAcl, 'private');
    assert.equal(r.policy.forbidOverwrite, 'true');
    assert.equal(r.policy.securityToken, '');
    assert.equal(r.policy.maxFileSizeMb, 1024);
    assert.equal(r.policy.expireInSeconds, 300);
});

test('parseUploadPolicy:缺字段时点名缺的是哪一个(别把一个残缺的表单递出去)', () => {
    const r = parseUploadPolicy({ data: { policy: 'p', signature: 's', upload_host: 'h' } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /uploadDir|uploadHost/);
});

test('parseUploadPolicy:没有 data 时把服务端那句话带出来', () => {
    const r = parseUploadPolicy({ code: 'BadRequest.RequestMethodNotAllowed', message: 'The method is not allowed for the requested URL.' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /没有返回 data/);
    assert.match(r.reason, /not allowed/);
});

test('表单字段的顺序与名字是实测跑通的那一份(含 x-oss-forbid-overwrite)', () => {
    const fields = buildUploadFormFields({
        uploadDir: 'dashscope-instant/a', fileName: 'v.mp4',
        policy: 'P', signature: 'S', accessKeyId: 'K',
        securityToken: '', objectAcl: 'private', forbidOverwrite: 'true',
    });
    assert.deepEqual(fields.map(f => f[0]),
        ['key', 'policy', 'signature', 'OSSAccessKeyId', 'x-oss-object-acl', 'x-oss-forbid-overwrite', 'success_action_status']);
    assert.deepEqual(fields[0], ['key', 'dashscope-instant/a/v.mp4']);
    // 服务端没给 SecurityToken 时**不许**带一个空值字段(会被策略比对打回来)
    assert.equal(fields.some(f => f[0] === 'SecurityToken'), false);
});

test('表单字段:有 SecurityToken 时才带上它', () => {
    const fields = buildUploadFormFields({ uploadDir: 'd', fileName: 'v.mp4', policy: 'P', signature: 'S', accessKeyId: 'K', securityToken: 'T' });
    assert.deepEqual(fields[fields.length - 1], ['SecurityToken', 'T']);
});

test('buildOssUrl 就是官方说的 oss:// + key 的形状', () => {
    assert.equal(buildOssUrl('dashscope-instant/a/2026-09-19/b', 'v.mp4'), 'oss://dashscope-instant/a/2026-09-19/b/v.mp4');
    // 上传目录末尾多一个斜杠不该拼出双斜杠
    assert.equal(buildOssUrl('dashscope-instant/a/', 'v.mp4'), 'oss://dashscope-instant/a/v.mp4');
});

test('multipart 请求体:字段都在、文件字节一个不少、结尾闭合', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { contentType, body } = buildMultipartBody({
        fields: [['key', 'a/b.mp4'], ['policy', 'P']],
        file: { name: 'b.mp4', mimeType: 'video/mp4', bytes },
        boundary: 'BOUND',
    });
    assert.equal(contentType, 'multipart/form-data; boundary=BOUND');
    const text = new TextDecoder().decode(body);
    assert.ok(text.includes('Content-Disposition: form-data; name="key"\r\n\r\na/b.mp4'));
    assert.ok(text.includes('Content-Disposition: form-data; name="policy"\r\n\r\nP'));
    assert.ok(text.includes('Content-Disposition: form-data; name="file"; filename="b.mp4"'));
    assert.ok(text.includes('Content-Type: video/mp4'));
    assert.ok(text.endsWith('--BOUND--\r\n'));
    // 文件字节原样在请求体里
    assert.ok(body.length > bytes.length);
    assert.ok(body.includes(1) && body.includes(5));
});

test('multipart:file 段**最后**(官方明确要求),缺 boundary 直接抛', () => {
    const { body } = buildMultipartBody({
        fields: [['a', '1']],
        file: { name: 'x.mp4', bytes: new Uint8Array([9]) },
        boundary: 'B',
    });
    const text = new TextDecoder().decode(body);
    assert.ok(text.indexOf('name="a"') < text.indexOf('name="file"'));
    assert.throws(() => buildMultipartBody({ fields: [], file: { name: 'x' }, boundary: '' }), /boundary/);
});

test('safeVideoName:路径分隔符、引号、控制字符一律洗掉(它要拼进 OSS 的对象 key)', () => {
    assert.equal(safeVideoName('../../etc/passwd.mp4'), 'passwd.mp4');
    assert.equal(safeVideoName('a\\b\\c.mp4'), 'c.mp4');
    assert.equal(safeVideoName('a"b<c>.mp4'), 'abc.mp4');
    assert.equal(safeVideoName('..'), 'video.mp4');
    assert.equal(safeVideoName(''), 'video.mp4');
    // 中文名保留(用户看得懂),但换行之类必须没
    const cleaned = safeVideoName('录屏 2026\n.mp4');
    assert.ok(!cleaned.includes('\n'));
    assert.ok(cleaned.includes('录屏'));
});

test('safeVideoName:过长的名字截断但**保住扩展名**', () => {
    const name = safeVideoName('x'.repeat(300) + '.mp4');
    assert.ok(name.length <= 80);
    assert.ok(name.endsWith('.mp4'));
});

test('uniqueUploadName:同一个文件两次要得到不同的名字(策略禁覆盖,重名会 403)', () => {
    const a = uniqueUploadName('v.mp4', { now: 1, random: () => 0.1 });
    const b = uniqueUploadName('v.mp4', { now: 1, random: () => 0.9 });
    assert.notEqual(a, b);
    assert.ok(a.endsWith('.mp4'));
    assert.ok(b.endsWith('.mp4'));
    assert.equal(uniqueUploadName('无扩展名', { now: 5, random: () => 0.5 }).includes('.'), false);
});

test('OSS 解析头是官方要求的那一个(少了它 oss:// 会被当成非法 URL)', () => {
    assert.equal(OSS_RESOLVE_HEADER, 'X-DashScope-OssResourceResolve');
    assert.equal(OSS_RESOLVE_VALUE, 'enable');
});

// ---------- 声明与字节是否相容(渲染层读完字节后与主进程共用这一份) ----------

test('videoSniffVerdict:声明与字节相符就通过', () => {
    const v = videoSniffVerdict({ mimeType: 'video/mp4', bytes: MP4_HEAD });
    assert.equal(v.ok, true);
    assert.equal(v.mimeType, 'video/mp4');
    assert.equal(v.sniffed, 'video/mp4');
});

test('videoSniffVerdict:mp4/mov 与 webm/mkv 是同源,互相声明不算错配', () => {
    assert.equal(videoSniffVerdict({ mimeType: 'video/quicktime', bytes: MP4_HEAD }).ok, true);
    assert.equal(videoSniffVerdict({ mimeType: 'video/x-matroska', bytes: WEBM_HEAD }).ok, true);
    assert.equal(videoSniffVerdict({ mimeType: 'video/webm', bytes: WEBM_HEAD }).ok, true);
});

test('videoSniffVerdict:HTML 改名成 mp4 → not_a_video(原因里点名只接受哪几种)', () => {
    const v = videoSniffVerdict({ mimeType: 'video/mp4', bytes: NOT_A_VIDEO });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'not_a_video');
    assert.match(v.reason, /字节不是/);
    assert.ok(v.reason.includes(VIDEO_MIME_LABEL));
});

test('videoSniffVerdict:真正错配的两种容器各有各的码', () => {
    const mismatch = videoSniffVerdict({ mimeType: 'video/mp4', bytes: WEBM_HEAD });
    assert.equal(mismatch.code, 'mime_mismatch');
    assert.match(mismatch.reason, /字节其实是 video\/webm/);
    assert.equal(videoSniffVerdict({ mimeType: 'video/avi', bytes: MP4_HEAD }).code, 'bad_type');
});

// ---------- 密钥卡片上的文案(纯函数,所以文案本身可以被钉住) ----------

test('密钥状态:未配 → 说"未配置",而且**不**出现环境变量那句警告', () => {
    const d = describeVideoKeyStatus({ ok: false, source: null, storage: 'plain' });
    assert.equal(d.configured, false);
    assert.equal(d.label, '未配置');
    assert.equal(d.envWins, false);
    assert.equal(d.warning, '');
    assert.equal(d.detail, '');
});

test('密钥状态:环境变量已配 → **必须**明说"在这里保存不会生效"(否则用户存了没反应)', () => {
    const d = describeVideoKeyStatus({ ok: true, source: 'env', storage: 'plain' });
    assert.equal(d.label, '已配置(环境变量)');
    assert.equal(d.envWins, true);
    assert.equal(d.warning, VIDEO_KEY_ENV_NOTICE);
    assert.match(d.warning, /环境变量优先/);
    assert.match(d.warning, /在这里保存的密钥不会生效/);
    // 环境变量赢的时候,设置文件里那份(明文/密文)没生效 —— 不再重复提醒它
    assert.equal(d.detail, '');
});

test('密钥状态:设置文件 + 密文 → 说清来源与存法', () => {
    const d = describeVideoKeyStatus({ ok: true, source: 'settings', storage: 'encrypted' });
    assert.equal(d.label, '已配置(设置文件)');
    assert.equal(d.storageLabel, '系统加密');
    assert.equal(d.envWins, false);
    assert.equal(d.warning, '');
});

test('密钥状态:设置文件 + 明文 → 标出"明文"并把后果写出来', () => {
    const d = describeVideoKeyStatus({ ok: true, source: 'settings', storage: 'plain' });
    assert.equal(d.storageLabel, '明文');
    assert.equal(d.detail, VIDEO_KEY_PLAIN_NOTICE);
    assert.match(d.detail, /能读到那个文件的人就能读到密钥/);
});

test('密钥状态:入参里根本没有"密钥值"这个字段 —— 它结构上就不可能泄露', () => {
    const d = describeVideoKeyStatus({ ok: true, source: 'settings', storage: 'encrypted' });
    assert.deepEqual(Object.keys(d).sort(),
        ['configured', 'detail', 'envWins', 'fromEnv', 'fromSettings', 'label', 'storageLabel', 'warning']);
    // 传进来的多余字段(比如有人手滑塞了 secret)也不会被带出去
    const dirty = describeVideoKeyStatus({ ok: true, source: 'env', storage: 'plain', secret: 'sk-ws-LEAK', key: 'sk-ws-LEAK' });
    assert.equal(JSON.stringify(dirty).includes('sk-ws-LEAK'), false);
});

// ---------- 按本地路径那条入口的准入判据 ----------

const LOCAL_FOLDER = 'D:\\project\\bilidown\\download';
const LOCAL_FILE = `${LOCAL_FOLDER}\\中国人能飞😭 [高清 1080P60] NA.mp4`;
const bigFile = { path: LOCAL_FILE, folder: LOCAL_FOLDER, exists: true, isFile: true, size: 177737264 };

test('路径准入:169.5 MB 通过(上限是服务端自己报的 1024 MB,不是过 IPC 那条的 64 MiB)', () => {
    const verdict = admitVideoPath(bigFile);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.size, 177737264);
    assert.equal(verdict.extension, '.mp4');
    assert.equal(MAX_LOCAL_VIDEO_BYTES, 1024 * 1024 * 1024);
});

test('路径准入:只接受本地绝对路径 + 视频扩展名(路径上没有 MIME,只能看后缀)', () => {
    assert.equal(admitVideoPath({ ...bigFile, path: 'a.mp4' }).code, 'bad_path');
    assert.equal(admitVideoPath({ ...bigFile, path: '\\\\server\\share\\a.mp4' }).code, 'bad_path');
    assert.equal(admitVideoPath({ ...bigFile, path: `${LOCAL_FOLDER}\\a.txt` }).code, 'bad_extension');
    assert.equal(admitVideoPath({ ...bigFile, path: `${LOCAL_FOLDER}\\a` }).code, 'bad_extension');
    assert.equal(admitVideoPath({ ...bigFile, path: 'D:\\a\\x.mp4\nrm' }).code, 'bad_path');
    assert.equal(admitVideoPath({}).code, 'bad_path');
    assert.deepEqual([...VIDEO_FILE_EXTENSIONS], ['.mp4', '.mov', '.webm', '.mkv']);
});

test('路径准入:**必须落在给定的下载目录里**(这是"递路径"这件事的安全边界)', () => {
    const outside = admitVideoPath({ ...bigFile, path: 'C:\\Windows\\System32\\config\\SAM.mp4' });
    assert.equal(outside.code, 'outside_folder');
    assert.match(outside.reason, /不在它自己的下载目录里/);

    // 前缀相邻的目录不算"在里面"(D:\download-2 不该匹配 D:\download)
    assert.equal(admitVideoPath({ ...bigFile, path: 'D:\\project\\bilidown\\download-2\\a.mp4' }).code, 'outside_folder');

    // 大小写与斜杠方向都归一(Windows 上两样都会变)
    assert.equal(admitVideoPath({
        ...bigFile, folder: 'd:/Project/BiliDown/Download/', path: 'D:\\project\\bilidown\\download\\a.mp4',
    }).ok, true);

    // 不给 folder 时不做包含性检查(但其它三条照样判)
    assert.equal(admitVideoPath({ ...bigFile, folder: undefined }).ok, true);
});

test('路径准入:文件不存在 / 是目录 / 读不出大小 / 超过 1024 MB —— 各有各的码', () => {
    assert.equal(admitVideoPath({ ...bigFile, exists: false }).code, 'file_missing');
    assert.equal(admitVideoPath({ ...bigFile, isFile: false }).code, 'not_a_file');
    assert.equal(admitVideoPath({ ...bigFile, size: 0 }).code, 'bad_size');
    assert.equal(admitVideoPath({ ...bigFile, size: undefined }).code, 'bad_size');
    const over = admitVideoPath({ ...bigFile, size: MAX_LOCAL_VIDEO_BYTES + 1 });
    assert.equal(over.code, 'too_large');
    assert.match(over.reason, /1024\.0 MB/);
    assert.match(over.reason, /服务端自己报的单文件上限/);
});

test('multipart 三段:长度算得准,而且拼起来与"整块拼"完全一致', () => {
    const fields = [['key', 'a/b.mp4'], ['policy', 'P']];
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const boundary = 'BOUND';
    const parts = buildMultipartParts({ fields, file: { name: 'b.mp4', mimeType: 'video/mp4', byteLength: bytes.byteLength }, boundary });
    assert.equal(parts.contentType, 'multipart/form-data; boundary=BOUND');
    assert.equal(parts.contentLength, parts.prefix.byteLength + bytes.byteLength + parts.suffix.byteLength);

    const whole = buildMultipartBody({ fields, file: { name: 'b.mp4', mimeType: 'video/mp4', bytes }, boundary }).body;
    const joined = new Uint8Array(parts.contentLength);
    joined.set(parts.prefix, 0);
    joined.set(bytes, parts.prefix.byteLength);
    joined.set(parts.suffix, parts.prefix.byteLength + bytes.byteLength);
    assert.deepEqual([...joined], [...whole]);
    // 文件字节在中间那一段的位置上,一个不差
    assert.deepEqual([...joined.slice(parts.prefix.byteLength, parts.prefix.byteLength + 4)], [9, 8, 7, 6]);
});

// ---------- SSE(流式)解析 ----------
//
// 「等待首个字 / 生成正文」这两段的**全部读数**都来自这里,而判错的两种表现都很糟:
// 少拼一个字(用户看到的正文缺字)或者把半截 JSON 当正文(显示一段乱码)。
// 真实的流是按 TCP 分片给的,切片位置与事件边界无关,所以下面这些用例**一律按
// 最恶劣的切法**喂进去(切在 `data:` 中间、切在 JSON 中间、切在空行上)。

test('SSE:半截事件必须留着(buffer 不能丢),而且按空行切', () => {
    const first = splitSseEvents('', 'data: {"a":1}\n\ndata: {"b":');
    assert.deepEqual(first.events, ['{"a":1}']);
    assert.equal(first.rest, 'data: {"b":');
    // 下一片补上后半截:两条事件都在
    const second = splitSseEvents(first.rest, '2}\n\ndata: [DONE]\n\n');
    assert.deepEqual(second.events, ['{"b":2}', '[DONE]']);
    assert.equal(second.rest, '');
});

test('SSE:CRLF、多行 data、没有结尾空行的最后一条 —— 都读得出来', () => {
    assert.deepEqual(splitSseEvents('', 'data: {"a":1}\r\n\r\n').events, ['{"a":1}']);
    // 多行 data 按 SSE 规定拼接
    assert.deepEqual(splitSseEvents('', 'data: {"a":\ndata: 1}\n\n').events, ['{"a":1}']);
    // 最后一条没有空行收尾:留在 rest 里(不许当成完整事件)
    const noTail = splitSseEvents('', 'data: {"a":1}\n\ndata: {"b":2}');
    assert.deepEqual(noTail.events, ['{"a":1}']);
    assert.equal(noTail.rest, 'data: {"b":2}');
    // 空 data 行不算事件(SSE 的心跳注释/空行不该被当成正文)
    assert.deepEqual(splitSseEvents('', 'data:\n\n').events, []);
});

test('SSE:一条正文增量 / usage 尾包 / 只有 finish_reason 的收尾包,三种都认得出来', () => {
    assert.deepEqual(parseStreamPayload('{"choices":[{"delta":{"content":"红块"},"finish_reason":null}]}'),
        { kind: 'delta', delta: '红块', finishReason: '' });
    // content 是数组(有的兼容层会这么回)
    assert.deepEqual(parseStreamPayload('{"choices":[{"delta":{"content":[{"type":"text","text":"甲"}]}}]}'),
        { kind: 'delta', delta: '甲', finishReason: '' });
    // 收尾那一包往往没有正文,只有 finish_reason —— 必须单独认出来
    assert.deepEqual(parseStreamPayload('{"choices":[{"delta":{},"finish_reason":"length"}]}'),
        { kind: 'finish', finishReason: 'length' });
    const usage = parseStreamPayload('{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7,"prompt_tokens_details":{"video_tokens":2}}}');
    assert.equal(usage.kind, 'usage');
    assert.equal(usage.usage.videoTokens, 2);
    // [DONE] / 坏 JSON / 带 error 的 200 —— 各有各的归宿
    assert.deepEqual(parseStreamPayload('[DONE]'), { kind: 'done' });
    assert.deepEqual(parseStreamPayload('{不是 JSON'), { kind: 'other' });
    assert.equal(parseStreamPayload('{"error":{"message":"上游挂了"}}').kind, 'error');
    assert.match(parseStreamPayload('{"error":{"message":"上游挂了"}}').reason, /上游挂了/);
    assert.deepEqual(parseStreamPayload(''), { kind: 'other' });
    assert.deepEqual(parseStreamPayload(null), { kind: 'other' });
});

test('SSE:usage 归一化对缺字段 / 空值一视同仁(都收敛成 0,不抛)', () => {
    assert.deepEqual(normalizeStreamUsage(null), null);
    assert.deepEqual(normalizeStreamUsage({}), null, '一个 token 字段都没有 = 不是 usage 包');
    assert.deepEqual(normalizeStreamUsage({ prompt_tokens: 5, completion_tokens: null, total_tokens: 'x' }), {
        promptTokens: 5, completionTokens: 0, totalTokens: 0, videoTokens: 0, textTokens: 0, imageTokens: 0,
    });
    // content 取值:字符串 / 数组 / 别的形状
    assert.equal(extractStreamText('甲'), '甲');
    assert.equal(extractStreamText([{ text: '甲' }, { text: '乙' }, { nope: 1 }]), '甲乙');
    assert.equal(extractStreamText(null), '');
    assert.equal(extractStreamText({ text: '甲' }), '');
});

// ---------- 内联请求体:**分块**编码 + 切段流式发(方案 2) ----------
//
// 为什么这几条必须存在:内联那条路原来是把整段 base64 拼好、一次发出去 —— 于是
// "已经发出多少字节"根本观测不到,界面上小文件连进度条都没有。改成逐块编码 + 流式发送
// 之后,正确性的全部风险压在一件事上:**分块编码接起来必须与一次性编码逐字节相同**。
// 错一个字节的表现是服务端回一个 400,而原因离现场十万八千里(这就是这里不留余地的理由)。

/** 造一段**有内容**的字节(全 0 的 base64 太规整,错位也可能"看起来对")。 */
function pseudoBytes(byteLength) {
    const out = new Uint8Array(byteLength);
    let x = 0x9e3779b9;
    for (let i = 0; i < byteLength; i += 1) {
        x = (x * 1103515245 + 12345) & 0xffffffff;
        out[i] = (x >>> 16) & 0xff;
    }
    return out;
}

test('分块 base64 与**一次性**编码逐字节相同(3 的倍数 / 余 1 / 余 2 / 极短 / 空)', () => {
    // 覆盖三种补位情形与两个"整块边界":余 0/1/2 是逐块编码唯一可能出错的地方
    const lengths = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        1000, 1001, 1002, 4095, 4096, 4097,
        INLINE_BODY_CHUNK_BYTES - 1, INLINE_BODY_CHUNK_BYTES, INLINE_BODY_CHUNK_BYTES + 1,
        INLINE_BODY_CHUNK_BYTES + 2, 2 * INLINE_BODY_CHUNK_BYTES + 1,
    ];
    for (const n of lengths) {
        const bytes = pseudoBytes(n);
        const oneShot = toCanonicalBase64(bytes);
        const chunks = encodeBase64Chunks(bytes);
        assert.equal(chunks.join(''), oneShot, `${n} 字节:分块编码与一次性编码必须逐字节相同`);
        // 与 Node 的权威实现也对比一次(上面那份是我们的实现,两份互相印证)
        assert.equal(chunks.join(''), Buffer.from(bytes).toString('base64'), `${n} 字节:与 Buffer 的实现相同`);
        // 空文件 → 没有任何块(不返回 ['']:那会在请求体里插进一个空字符串)
        if (n === 0) {
            assert.deepEqual(chunks, []);
            continue;
        }
        // ⚠️ 只有**最后**一块允许有 '=';中间那块出现 '=' 就是把 3 字节对齐搞丢了
        chunks.forEach((text, i) => {
            const isLast = i === chunks.length - 1;
            assert.equal(text.includes('=') && isLast === false, false, `${n} 字节:第 ${i + 1} 块中间出现了 '='`);
            assert.equal(/^[A-Za-z0-9+/]*={0,2}$/.test(text), true, `${n} 字节:第 ${i + 1} 块不是规范 base64`);
        });
        assert.equal(chunks.length, Math.max(1, Math.ceil(n / INLINE_BODY_CHUNK_BYTES)), `${n} 字节的块数`);
    }
});

test('块大小不是 3 的倍数时**向下取整**(绝不能把中间那块补成 "=")', () => {
    const bytes = pseudoBytes(100);
    // 10 → 9:若按 10 切,每一块都不是 3 的倍数 → 每块都被补 '=',拼起来就是非法 base64
    const chunks = encodeBase64Chunks(bytes, { chunkBytes: 10 });
    assert.equal(chunks.join(''), toCanonicalBase64(bytes));
    // 100 字节 = 11 块 × 9 字节 + 1 字节 → 11 块是 12 个字符(无补位),最后一块 4 个字符(带 '==')
    assert.deepEqual(chunks.map(c => c.length), [...Array(11).fill(12), 4]);
    // 比 3 还小 / 非法值 → 退回默认块长(而不是抛,也不是切出 0 长度的死循环)
    assert.equal(encodeBase64Chunks(bytes, { chunkBytes: 1 }).join(''), toCanonicalBase64(bytes));
    assert.equal(encodeBase64Chunks(bytes, { chunkBytes: Number.NaN }).join(''), toCanonicalBase64(bytes));
    assert.equal(encodeBase64Chunks(bytes, { chunkBytes: -9 }).join(''), toCanonicalBase64(bytes));
});

test('inlineChunkStep:块长永远是 3 的倍数(发送那条流也用它,不能两处各写一遍)', () => {
    assert.equal(inlineChunkStep(10), 9);
    assert.equal(inlineChunkStep(9), 9);
    assert.equal(inlineChunkStep(INLINE_BODY_CHUNK_BYTES), INLINE_BODY_CHUNK_BYTES);
    assert.equal(inlineChunkStep(INLINE_BODY_CHUNK_BYTES) % 3, 0, '默认块长必须是 3 的倍数');
    for (const bad of [1, 2, 0, -3, Number.NaN, 'x', undefined]) {
        assert.equal(inlineChunkStep(bad), INLINE_BODY_CHUNK_BYTES, `非法块长(${String(bad)})要退回默认值`);
    }
});

test('分块编码认的是**视图的边界**:非零 byteOffset 的切片不会多编也不会少编', () => {
    // 现实里的调用是 `bytes.subarray(at, at + step)` —— 若实现里错用了 `.buffer`,
    // 编出来的就是"从整块缓冲区开头算起"的字节,而长度还对得上(错得很安静)
    const whole = pseudoBytes(300);
    const view = whole.subarray(7, 208);         // 201 字节,byteOffset = 7
    const gold = toCanonicalBase64(whole.slice(7, 208));
    assert.equal(encodeBase64Chunks(view, { chunkBytes: 9 }).join(''), gold);
    assert.equal(encodeBase64Chunks(view).join(''), gold);
    // 空视图 → 没有块(不是 [''] 也不是抛)
    assert.deepEqual(encodeBase64Chunks(whole.subarray(5, 5)), []);
    assert.throws(() => encodeBase64Chunks('不是字节'), /字节数组/);
});

test('切段:prefix + 分块 base64 + suffix 与**整包** JSON 逐字节相同,总长也是真长度', () => {
    for (const n of [1, 2, 3, 4096, 5000, INLINE_BODY_CHUNK_BYTES + 7]) {
        const bytes = pseudoBytes(n);
        const parts = buildInlineBodyParts({
            model: 'qwen3-vl-flash', mimeType: 'video/mp4', question: '里面有什么?',
            maxTokens: 456, stream: true, byteLength: n,
        });
        const chunks = encodeBase64Chunks(bytes);
        const encoder = new TextEncoder();
        const assembled = new Uint8Array(
            parts.prefix.byteLength + chunks.join('').length + parts.suffix.byteLength,
        );
        assembled.set(parts.prefix, 0);
        assembled.set(encoder.encode(chunks.join('')), parts.prefix.byteLength);
        assembled.set(parts.suffix, parts.prefix.byteLength + chunks.join('').length);

        // 一次性整包那份(今天真正被服务端接受的形状)作为唯一判据
        const oneShot = JSON.stringify(buildChatBody({
            model: 'qwen3-vl-flash',
            content: buildMediaContent({
                url: buildDataUrl({ mimeType: 'video/mp4', base64: toCanonicalBase64(bytes) }),
                question: '里面有什么?', kind: 'video',
            }),
            maxTokens: 456, stream: true,
        }));
        assert.equal(new TextDecoder().decode(assembled), oneShot, `${n} 字节:切段流的产物必须与整包一模一样`);
        // 总长:前缀 + base64 正文 + 后缀,而且**等于**真实字节数(它会当作 Content-Length 发出去)
        assert.equal(parts.contentLength, assembled.byteLength, `${n} 字节:contentLength 必须正好等于请求体长度`);
        assert.equal(parts.contentLength, parts.prefix.byteLength + base64Length(n) + parts.suffix.byteLength);
        // 解出来还得是原来那段字节(不是"看着像")
        const body = JSON.parse(new TextDecoder().decode(assembled));
        const url = body.messages[0].content[0].video_url.url;
        assert.deepEqual(new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')), bytes);
    }
});
