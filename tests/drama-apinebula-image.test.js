import { test } from 'node:test';
import assert from 'node:assert/strict';

const fakeKey = 'sk-test-not-a-real-key-1234567890';
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('参考图使用原生 multipart edits，重复 image 字段保留格式和字节', async () => {
    const { createApinebulaImageGenerator } = await import('../electron/drama/lib/apinebula-image.js');
    const requests = [];
    const jpeg = Uint8Array.from([255, 216, 255]);
    const webp = Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
    const generate = createApinebulaImageGenerator({
        resolveKey: () => ({ ok: true, secret: fakeKey }),
        fetchImpl: async (url, init) => { requests.push({ url, init }); return {
            ok: true, json: async () => imagePayload({ b64_json: 'aW1hZ2U=' }),
        }; },
        saveImage: () => 'shot.png',
    });
    await generate({ prompt: '修改画面', batch: 2, images: [
        { mimeType: 'image/png', bytes: png }, { mimeType: 'image/jpg', bytes: jpeg },
        { mimeType: 'image/webp', bytes: webp },
    ] });
    assert.equal(requests.length, 2);
    for (const { url, init } of requests) {
        assert.equal(url, 'https://img-api.apinebula.ai/v1/images/edits');
        assert.equal(init.headers['content-type'], undefined);
        assert.equal(init.headers.authorization, `Bearer ${fakeKey}`);
        assert.ok(init.body instanceof FormData);
        for (const [key, value] of Object.entries({ model: 'gpt-image-2.5', prompt: '修改画面',
            n: '1', size: '1080x1920', response_format: 'b64_json' })) assert.equal(init.body.get(key), value);
        const images = init.body.getAll('image');
        assert.deepEqual(images.map((image) => image.type), ['image/png', 'image/jpeg', 'image/webp']);
        assert.deepEqual(images.map((image) => image.name.split('.').pop()), ['png', 'jpg', 'webp']);
        for (const [index, bytes] of [png, jpeg, webp].entries()) {
            assert.deepEqual(new Uint8Array(await images[index].arrayBuffer()), bytes);
        }
    }
});

test('参考图拒绝 GIF、伪造字节、URL、过多图片和共享大小超限，绝不请求', async () => {
    const { createApinebulaImageGenerator } = await import('../electron/drama/lib/apinebula-image.js');
    const { MAX_IMAGE_BYTES } = await import('../app/lib/agent-image.js');
    let calls = 0;
    const generate = createApinebulaImageGenerator({ resolveKey: () => ({ ok: true, secret: fakeKey }),
        fetchImpl: async () => { calls++; }, saveImage: () => '' });
    const large = new Uint8Array(MAX_IMAGE_BYTES); large.set(png);
    for (const [images, reason] of [
        [[{ mimeType: 'image/gif', bytes: [71, 73, 70, 56] }], /GIF/],
        [[{ mimeType: 'image/jpeg', bytes: png }], /字节其实/],
        [[{ mimeType: 'image/png', url: 'https://example.test/a.png' }], /字节数组/],
        [Array(5).fill({ mimeType: 'image/png', bytes: png }), /最多发 4/],
        [Array(3).fill({ mimeType: 'image/png', bytes: large }), /总量上限/],
    ]) await assert.rejects(() => generate({ prompt: '画面', images }), reason);
    assert.equal(calls, 0);
});
const imagePayload = (item) => ({ created: 1784867600, data: [item], quality: 'medium',
    size: '1080x1920', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });

test('APINebula 每张图单独请求 n=1，模型和竖屏尺寸统一', async () => {
    const { createApinebulaImageGenerator } = await import('../electron/drama/lib/apinebula-image.js');
    const requests = [];
    const saved = [];
    const replies = [
        imagePayload({ b64_json: Buffer.from('first').toString('base64') }),
        imagePayload({ b64_json: Buffer.from('second').toString('base64') }),
    ];
    const generate = createApinebulaImageGenerator({
        resolveKey: () => ({ ok: true, secret: fakeKey }),
        fetchImpl: async (url, init) => {
            requests.push({ url, init });
            return { ok: true, status: 200, json: async () => replies.shift() };
        },
        saveImage: (dir, bytes) => { saved.push({ dir, bytes: Buffer.from(bytes) });
            return `${dir}/${saved.length}.png`; },
    });

    const result = await generate({ prompt: '竖屏短剧画面', batch: 2, dir: 'shots' });
    assert.deepEqual(result.files, ['shots/1.png', 'shots/2.png']);
    assert.deepEqual(saved.map((item) => item.bytes.toString()), ['first', 'second']);
    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(request.url, 'https://img-api.apinebula.ai/v1/images/generations');
        assert.deepEqual(JSON.parse(request.init.body), {
            model: 'gpt-image-2.5', prompt: '竖屏短剧画面', n: 1,
            size: '1080x1920', response_format: 'b64_json',
        });
        assert.equal(request.init.headers.authorization, `Bearer ${fakeKey}`);
    }
});

test('APINebula 单张图片请求超时上限为 5 分钟', async () => {
    const { createApinebulaImageGenerator } = await import('../electron/drama/lib/apinebula-image.js');
    const originalTimeout = AbortSignal.timeout;
    let timeoutMs = 0;
    AbortSignal.timeout = (ms) => {
        timeoutMs = ms;
        return new AbortController().signal;
    };
    try {
        const generate = createApinebulaImageGenerator({
            resolveKey: () => ({ ok: true, secret: fakeKey }),
            fetchImpl: async () => ({ ok: true, status: 200,
                json: async () => imagePayload({ b64_json: Buffer.from('image').toString('base64') }) }),
            saveImage: () => 'shot.png',
        });
        await generate({ prompt: '画面', dir: 'shots' });
        assert.equal(timeoutMs, 300000);
    } finally {
        AbortSignal.timeout = originalTimeout;
    }
});

test('APINebula 可下载 URL 响应；无密钥或 HTTP 失败不重试', async () => {
    const { createApinebulaImageGenerator } = await import('../electron/drama/lib/apinebula-image.js');
    const requests = [];
    const fetchImpl = async (url) => {
        requests.push(url);
        if (url.endsWith('/images/generations')) {
            return { ok: true, status: 200, json: async () => imagePayload({ url: 'https://cdn.example.test/shot.png' }) };
        }
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('downloaded') };
    };
    let saved = '';
    const generate = createApinebulaImageGenerator({
        resolveKey: () => ({ ok: true, secret: fakeKey }), fetchImpl,
        saveImage: (_dir, bytes) => { saved = Buffer.from(bytes).toString(); return 'shot.png'; },
    });
    assert.deepEqual((await generate({ prompt: '画面', batch: 1, dir: 'shots' })).files, ['shot.png']);
    assert.equal(saved, 'downloaded');
    assert.equal(requests.length, 2);

    let calls = 0;
    const withoutKey = createApinebulaImageGenerator({
        resolveKey: () => ({ ok: false, reason: '请设置密钥' }),
        fetchImpl: async () => { calls++; throw new Error('不应请求'); },
        saveImage: () => '',
    });
    await assert.rejects(() => withoutKey({ prompt: '画面', dir: 'shots' }), /请设置密钥/);
    assert.equal(calls, 0);

    const failed = createApinebulaImageGenerator({
        resolveKey: () => ({ ok: true, secret: fakeKey }),
        fetchImpl: async () => { calls++; return { ok: false, status: 400 }; },
        saveImage: () => '',
    });
    await assert.rejects(() => failed({ prompt: '画面', batch: 2, dir: 'shots' }), /HTTP 400/);
    assert.equal(calls, 1, '失败后不可自动重试或继续扣费');
});
