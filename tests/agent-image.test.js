import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    IMAGE_MIME_LABEL, IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES_PER_PROMPT,
    MAX_TOTAL_IMAGE_BYTES, admitImagePayload, buildAcpPromptBlocks, formatBytes,
    imagePromptFailureHint, imageCapabilityRefusal, promptCapabilitiesOf,
    stripIpcWrapper,
    normalizeImageMime, toCanonicalBase64, validateImageCandidate,
} from '../app/lib/agent-image.js';

// 黏贴截图这条路的**纯逻辑**:什么能收、什么必须拒、拒了说哪一句中文,
// 以及送出去的那几个 prompt 块长什么样。
//
// 为什么这些必须是纯函数的用例:同一份判据被三处用着(渲染层的即时反馈、
// 主进程的权威校验、ACP 线上组装)。判错的两个方向都很难看 ——
// 一边是"用户唯一想发的那张图被悄悄吞掉",另一边是"不可信的字节能过边界"。

/** 真图的开头几个字节(签名就够:这里只测判据,不需要能解码的完整图)。 */
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const GIF_HEAD = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80]);
const WEBP_HEAD = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
/** 一张"自称是 png、其实是别的东西"的字节。 */
const NOT_AN_IMAGE = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x00, 0x00]);

// ---------- MIME 归一 ----------

test('白名单就是 ACP 那四种光栅格式(与桥的 IMAGE_MEDIA_TYPES 对齐)', () => {
    assert.deepEqual([...IMAGE_MIME_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
});

test('normalizeImageMime 只认白名单,大小写与参数都归一', () => {
    assert.equal(normalizeImageMime('image/png'), 'image/png');
    assert.equal(normalizeImageMime('IMAGE/PNG'), 'image/png');
    assert.equal(normalizeImageMime('  image/jpeg  '), 'image/jpeg');
    // `;charset=...` 这类参数剪掉
    assert.equal(normalizeImageMime('image/webp; charset=utf-8'), 'image/webp');
});

test('normalizeImageMime 把 image/jpg 当 image/jpeg(现实里最常见的别名)', () => {
    assert.equal(normalizeImageMime('image/jpg'), 'image/jpeg');
    assert.equal(normalizeImageMime('image/JPEG'), 'image/jpeg');
});

test('normalizeImageMime 对不属于白名单的一律返回空串', () => {
    for (const bad of ['', '   ', 'image/bmp', 'image/svg+xml', 'text/plain', 'image', 'png', null, undefined, 42]) {
        assert.equal(normalizeImageMime(bad), '', `${String(bad)} 不该被当成能收的图片`);
    }
});

// ---------- 单张的即时判断(渲染层用的那一条) ----------

test('一张正常的 png 通过,并回一个归一过的 mime', () => {
    const v = validateImageCandidate({ mimeType: 'IMAGE/PNG', byteLength: 1024, existing: [] });
    assert.deepEqual(v, { ok: true, mimeType: 'image/png' });
});

test('格式不在白名单:拒绝,而且原因里点名"只接受哪几种"', () => {
    const v = validateImageCandidate({ mimeType: 'image/bmp', byteLength: 1024, existing: [] });
    assert.equal(v.ok, false);
    assert.match(v.reason, /不支持的图片格式/);
    assert.match(v.reason, /image\/bmp/);
    assert.match(v.reason, new RegExp(IMAGE_MIME_LABEL.replace(/\//g, '\\/')));
});

test('没有类型的字节也被拒(不是静默收下)', () => {
    const v = validateImageCandidate({ mimeType: '', byteLength: 10, existing: [] });
    assert.equal(v.ok, false);
    assert.match(v.reason, /没有类型/);
});

test('单张超限:原因里同时给出这张多大、上限多少(用户要知道差多少)', () => {
    const v = validateImageCandidate({ mimeType: 'image/png', byteLength: MAX_IMAGE_BYTES + 1, existing: [] });
    assert.equal(v.ok, false);
    assert.match(v.reason, /超过单张上限/);
    assert.match(v.reason, /10\.0 MB/);
});

test('刚好等于单张上限的那一张是**收**的(边界不许提前一格拒)', () => {
    const v = validateImageCandidate({ mimeType: 'image/png', byteLength: MAX_IMAGE_BYTES, existing: [] });
    assert.equal(v.ok, true);
});

test('空图(0 字节)被拒 —— 发一张空图等于让模型猜', () => {
    const v = validateImageCandidate({ mimeType: 'image/png', byteLength: 0, existing: [] });
    assert.equal(v.ok, false);
    assert.match(v.reason, /空的\(0 字节\)/);
});

test('总量超限:原因里给出这张、已选、上限三个数', () => {
    const existing = [{ byteLength: MAX_TOTAL_IMAGE_BYTES - 100 }];
    const v = validateImageCandidate({ mimeType: 'image/png', byteLength: 200, existing });
    assert.equal(v.ok, false);
    assert.match(v.reason, /超过一次发送的总量上限/);
    assert.match(v.reason, /20\.0 MB/);
});

test('张数上限:已经选满时不再收,原因里点名最多几张', () => {
    const existing = Array.from({ length: MAX_IMAGES_PER_PROMPT }, () => ({ byteLength: 10 }));
    const v = validateImageCandidate({ mimeType: 'image/png', byteLength: 10, existing });
    assert.equal(v.ok, false);
    assert.match(v.reason, new RegExp(`一次最多发 ${MAX_IMAGES_PER_PROMPT} 张图`));
});

test('报不出大小的那一张被拒(宁可说清楚,也不按 0 放行)', () => {
    const v = validateImageCandidate({ mimeType: 'image/png', byteLength: undefined, existing: [] });
    assert.equal(v.ok, false);
    assert.match(v.reason, /报不出大小/);
});

// ---------- 主进程的权威校验 ----------

test('admitImagePayload 收下 ArrayBuffer / Uint8Array / 普通数字数组三种形状', () => {
    const fromBuffer = admitImagePayload([{ mimeType: 'image/png', bytes: PNG_HEAD.buffer.slice(0) }]);
    assert.equal(fromBuffer.ok, true);
    assert.equal(fromBuffer.images[0].mimeType, 'image/png');
    assert.equal(fromBuffer.images[0].bytes.byteLength, PNG_HEAD.byteLength);

    const fromView = admitImagePayload([{ mimeType: 'image/gif', bytes: GIF_HEAD }]);
    assert.equal(fromView.ok, true);
    assert.deepEqual([...fromView.images[0].bytes], [...GIF_HEAD]);

    const fromArray = admitImagePayload([{ mimeType: 'image/jpeg', bytes: [...JPEG_HEAD] }]);
    assert.equal(fromArray.ok, true);
    assert.deepEqual([...fromArray.images[0].bytes], [...JPEG_HEAD]);
});

test('admitImagePayload 对 undefined / null / 空数组回"没有图片",不报错', () => {
    for (const raw of [undefined, null, []]) {
        assert.deepEqual(admitImagePayload(raw), { ok: true, images: [] });
    }
});

test('admitImagePayload 不收非数组(不能是别的通道塞进来的东西)', () => {
    const v = admitImagePayload({ mimeType: 'image/png' });
    assert.equal(v.ok, false);
    assert.match(v.reason, /必须是一个数组/);
});

test('admitImagePayload 在第 15 张之前就按张数拒(不许先把 list 铺开)', () => {
    const many = Array.from({ length: MAX_IMAGES_PER_PROMPT + 1 },
        () => ({ mimeType: 'image/png', bytes: PNG_HEAD }));
    const v = admitImagePayload(many);
    assert.equal(v.ok, false);
    assert.match(v.reason, new RegExp(`一次最多发 ${MAX_IMAGES_PER_PROMPT} 张图`));
    assert.match(v.reason, new RegExp(`收到 ${MAX_IMAGES_PER_PROMPT + 1} 张`));
});

test('admitImagePayload 逐张点名:第几张、为什么(而不是笼统一句"参数错")', () => {
    const v = admitImagePayload([
        { mimeType: 'image/png', bytes: PNG_HEAD },
        { mimeType: 'image/bmp', bytes: PNG_HEAD },
    ]);
    assert.equal(v.ok, false);
    assert.match(v.reason, /^第 2 张图:/);
});

test('admitImagePayload 拒掉不是字节的 bytes', () => {
    for (const bytes of [null, undefined, 'data:image/png;base64,AAAA', { 0: 1 }, [1, 2, 999]]) {
        const v = admitImagePayload([{ mimeType: 'image/png', bytes }]);
        assert.equal(v.ok, false, `${JSON.stringify(bytes)} 不该被当成字节`);
        assert.match(v.reason, /字节不是一个字节数组/);
    }
});

test('admitImagePayload 拒掉"声明是 png 但字节不是图"的那一张(渲染进程说了不算)', () => {
    const v = admitImagePayload([{ mimeType: 'image/png', bytes: NOT_AN_IMAGE }]);
    assert.equal(v.ok, false);
    assert.match(v.reason, /字节不是 PNG \/ JPEG \/ WebP \/ GIF/);
});

test('admitImagePayload 看出"声明与字节不符" —— 名字写 png、其实是 jpeg', () => {
    const v = admitImagePayload([{ mimeType: 'image/png', bytes: JPEG_HEAD }]);
    assert.equal(v.ok, false);
    assert.match(v.reason, /声明是 image\/png,字节其实是 image\/jpeg/);
});

test('admitImagePayload 认得出 webp(RIFF....WEBP,不是靠前四字节就能定的那一种)', () => {
    const v = admitImagePayload([{ mimeType: 'image/webp', bytes: WEBP_HEAD }]);
    assert.equal(v.ok, true);
    assert.equal(v.images[0].mimeType, 'image/webp');
});

test('admitImagePayload 在总量上封顶(单张都合法、加起来超标也要拒)', () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(PNG_HEAD, 0);
    const v = admitImagePayload([
        { mimeType: 'image/png', bytes: big },
        { mimeType: 'image/png', bytes: big },
        { mimeType: 'image/png', bytes: big },
        { mimeType: 'image/png', bytes: big },
    ]);
    assert.equal(v.ok, false);
    assert.match(v.reason, /第 4 张图:/);
    assert.match(v.reason, /超过一次发送的总量上限/);
});

// ---------- base64 与 prompt 块组装 ----------

test('toCanonicalBase64 产出的是规范化 base64(无换行、带 = 补位),与 Buffer 逐字一致', () => {
    for (const bytes of [PNG_HEAD, JPEG_HEAD, GIF_HEAD, WEBP_HEAD, new Uint8Array([1]), new Uint8Array([1, 2])]) {
        const out = toCanonicalBase64(bytes);
        assert.equal(out, Buffer.from(bytes).toString('base64'));
        assert.match(out, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            '桥的 decodeImage 只认规范 base64');
    }
});

test('buildAcpPromptBlocks:纯文本时输出的就是从前那一行,逐字节不变', () => {
    const built = buildAcpPromptBlocks({ text: '你好' });
    assert.equal(built.ok, true);
    assert.deepEqual(built.blocks, [{ type: 'text', text: '你好' }]);
    // 不传 images 与传空数组必须一样
    assert.deepEqual(buildAcpPromptBlocks({ text: '你好', images: [] }).blocks, built.blocks);
});

test('buildAcpPromptBlocks:只发图片(没写字)也合法 —— 文本块直接不出现', () => {
    const built = buildAcpPromptBlocks({ text: '', images: [{ mimeType: 'image/png', bytes: PNG_HEAD }] });
    assert.equal(built.ok, true);
    assert.equal(built.blocks.length, 1);
    assert.equal(built.blocks[0].type, 'image');
    assert.equal(built.blocks[0].mimeType, 'image/png');
    assert.equal(built.blocks[0].data, Buffer.from(PNG_HEAD).toString('base64'));
});

test('buildAcpPromptBlocks:文字在前、图片在后(与用户黏贴时看到的一句话+一张图同序)', () => {
    const built = buildAcpPromptBlocks({
        text: '看这张图',
        images: [
            { mimeType: 'image/png', bytes: PNG_HEAD },
            { mimeType: 'image/jpeg', bytes: JPEG_HEAD },
        ],
    });
    assert.equal(built.ok, true);
    assert.deepEqual(built.blocks.map(b => b.type), ['text', 'image', 'image']);
    assert.deepEqual(built.blocks.map(b => b.mimeType), [undefined, 'image/png', 'image/jpeg']);
});

test('buildAcpPromptBlocks:图片块上没有多余字段(线上只认 type/mimeType/data)', () => {
    const built = buildAcpPromptBlocks({ text: '', images: [{ mimeType: 'image/gif', bytes: GIF_HEAD }] });
    assert.deepEqual(Object.keys(built.blocks[0]).sort(), ['data', 'mimeType', 'type']);
});

test('buildAcpPromptBlocks:文字与图片都空时拒绝(不许发一次空提示)', () => {
    const built = buildAcpPromptBlocks({ text: '', images: [] });
    assert.equal(built.ok, false);
    assert.match(built.reason, /不能为空/);
});

test('buildAcpPromptBlocks:图片不合法时把原因原样带出来(不在这一层另编一句)', () => {
    const built = buildAcpPromptBlocks({ text: '看', images: [{ mimeType: 'image/tiff', bytes: GIF_HEAD }] });
    assert.equal(built.ok, false);
    assert.match(built.reason, /不支持的图片格式/);
});

// ---------- 人话 ----------

test('formatBytes 给出能一眼看懂的三个量级', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(MAX_IMAGE_BYTES), '10.0 MB');
    assert.equal(formatBytes(Number.NaN), '未知大小');
    assert.equal(formatBytes(-1), '未知大小');
});

test('imagePromptFailureHint 把桥那两句英文翻成中文(而且给出下一步)', () => {
    const notAdvertised = imagePromptFailureHint(
        'ACP 错误 -32602:inline image prompts were not advertised by this connection');
    assert.ok(notAdvertised !== null && notAdvertised.includes('没有广告图片能力'));
    assert.ok(notAdvertised.includes('换成支持图片的模型'));

    const noDeclare = imagePromptFailureHint(
        'ACP 错误 -32602:model "deepseek-v4-flash" does not declare image input');
    assert.ok(noDeclare !== null && noDeclare.includes('没有声明支持图片输入'));

    const noStore = imagePromptFailureHint('no attachment store is mounted');
    assert.ok(noStore !== null && noStore.includes('附件存储'));
});

test('imagePromptFailureHint 认不出来就返回 null(不许把别的错误硬翻成图片问题)', () => {
    assert.equal(imagePromptFailureHint('ACP 错误 -32603:no API key for provider route'), null);
    assert.equal(imagePromptFailureHint(''), null);
    assert.equal(imagePromptFailureHint(undefined), null);
});

test('stripIpcWrapper 剥掉 Electron 那层壳,而且剥得**刚刚好**', () => {
    // 用户实测贴回来的那一行(原文)
    const real = "Error invoking remote method 'agent:send': Error: 提示超时(180000ms 没有任何进展),已经请求对端取消";
    assert.equal(stripIpcWrapper(real), '提示超时(180000ms 没有任何进展),已经请求对端取消');

    // 没有内层 `Error:` 的形状
    assert.equal(stripIpcWrapper("Error invoking remote method 'notes:remove': 文件不是笔记"),
        '文件不是笔记');
    // 没有壳的原文必须**逐字**不动(不许顺手把别的东西当壳剥掉)
    assert.equal(stripIpcWrapper('ACP 错误 -32603:no API key for provider route'),
        'ACP 错误 -32603:no API key for provider route');
    assert.equal(stripIpcWrapper('提示超时(180000ms 没有任何进展)'), '提示超时(180000ms 没有任何进展)');
    // 句子中间出现同样的字样**不算**壳(只剥开头那一层)
    assert.equal(stripIpcWrapper('原因不详(Error invoking remote method 被谁吞了)'),
        '原因不详(Error invoking remote method 被谁吞了)');
    assert.equal(stripIpcWrapper(''), '');
    assert.equal(stripIpcWrapper(undefined), '');
});

test('剥壳之后图片那两句英文照样认得出来(两道处理是接得上的)', () => {
    // 顺序错了就会出现"带壳时翻不出来"的窟窿:全靠调用方先 strip 再 hint
    const wrapped = "Error invoking remote method 'agent:send': Error: ACP 错误 -32602:"
        + 'inline image prompts were not advertised by this connection';
    const hint = imagePromptFailureHint(stripIpcWrapper(wrapped));
    assert.ok(hint !== null && hint.includes('没有广告图片能力'));
});

// ---------- 发图之前的那道闸 ----------
//
// 与 imagePromptFailureHint(事后翻译)是一对:这个负责**事前**拦。
// 判据来自 initialize 的 `agentCapabilities.promptCapabilities` —— ACP 规定
// 只有对方广告了才准发内联图片;没写 image 就是"不收"。

test('promptCapabilitiesOf:只认三个布尔,缺字段就是 false', () => {
    assert.deepEqual(promptCapabilitiesOf({
        agentCapabilities: { promptCapabilities: { image: true, audio: false, embeddedContext: true } },
    }), { image: true, audio: false, embeddedContext: true });

    // 装机那份桥就是这个形状:字段压根没写
    assert.deepEqual(promptCapabilitiesOf({ agentCapabilities: { promptCapabilities: {} } }),
        { image: false, audio: false, embeddedContext: false });

    // 认不出结构 → null(调用方据此"不拦":还不知道 ≠ 不支持)
    assert.equal(promptCapabilitiesOf(null), null);
    assert.equal(promptCapabilitiesOf({}), null);
    assert.equal(promptCapabilitiesOf({ agentCapabilities: {} }), null);
});

test('imageCapabilityRefusal:说清是哪个模型 + 下一步是"重连"(不是"换模型")', () => {
    const named = imageCapabilityRefusal({ image: false }, 'deepseek-v4-flash');
    assert.match(named, /deepseek-v4-flash/);
    assert.match(named, /不接受图片输入/);
    // ⚠️ 下一步必须是**重连**:用户很可能已经换好模型了,而图片能力是连接建立时确定的
    //    (实测就是这个场景:换到视觉模型之后仍然发不出去,界面还在推荐"换成支持图片的模型")。
    assert.match(named, /重连/);

    const unnamed = imageCapabilityRefusal({ image: false });
    assert.match(unnamed, /当前模型不接受图片输入/);
});
