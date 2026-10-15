import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../app/lib/app-protocol-core.js';

// 这套用例覆盖 toolbox:// 处理器的真实行为,跑在纯 Node 下 ——
// 处理器在 app/lib/app-protocol-core.js 里,只依赖 fs 与 URL,
// 所以不需要 electron,也不需要启动 Electron。

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-proto-'));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>hello</h1>');
    fs.writeFileSync(path.join(root, 'data.json'), '{"a":1}');
    fs.writeFileSync(path.join(root, 'bytes.txt'), '0123456789');
    fs.writeFileSync(path.join(root, 'empty.txt'), '');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'deep.css'), 'body{}');
    return { base, root, outside };
}

const get = (url, headers = {}) => new Request(url, {
    method: 'GET',
    headers,
});

test('正常文件返回 200、正确类型与内容', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/index.html'));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.equal(await res.text(), '<h1>hello</h1>');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('子目录中的文件可访问,类型按扩展名判定', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/sub/deep.css'));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('未知资源根返回 404', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://nope/x.js'));
        assert.equal(res.status, 404);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('不存在的文件在根目录内也返回 403(与越界同码)', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/nope.js'));
        // resolveWithinReal 把「越界」与「不存在」都收敛成 null,处理器无法区分。
        // 一律 403 是刻意的:越界探测不该靠响应码反推出文件是否存在。
        assert.equal(res.status, 403);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('目录返回 404 而不是目录内容', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/sub'));
        assert.equal(res.status, 404);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('文件在守卫通过后消失时返回 404', async () => {
    const { base, root } = fixture();
    try {
        // 守卫返回真实路径,但 stat 时说文件没了(竞态:守卫与 stat 之间被删掉)。
        // 这条覆盖 404 分支 —— 正常拼写错误会先被守卫拦成 403,走不到这里。
        const racingFs = {
            promises: {
                stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
                readFile: fs.promises.readFile,
            },
        };
        const handle = createRequestHandler({ shell: root }, { fileSystem: racingFs });
        const res = await handle(get('toolbox://shell/index.html'));
        assert.equal(res.status, 404);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('畸形百分号编码返回 400,不抛异常', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/%zz'));
        assert.equal(res.status, 400);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('编码过的穿越返回 403', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        // %2e%2e%2f 不是 dot-segment,能原样抵达处理器;真实存在的同级文件
        // 保证这条断言测的是守卫,而不是「文件不存在」的 404。
        const res = await handle(get('toolbox://shell/%2e%2e%2foutside%2fsecret.txt'));
        assert.equal(res.status, 403);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('经目录联接逃出根目录返回 403', async () => {
    const { base, root, outside } = fixture();
    try {
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
        // 先确认真实现场成立:文件确实存在、内容确实可读。
        assert.equal(fs.statSync(path.join(root, 'escape', 'secret.txt')).isFile(), true);

        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/escape/secret.txt'));
        assert.equal(res.status, 403, '词法检查会放行,只有真实路径层能挡住');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('Range: bytes=0-3 返回 206 与正确片段', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/bytes.txt', { range: 'bytes=0-3' }));
        assert.equal(res.status, 206);
        assert.equal(res.headers.get('content-range'), 'bytes 0-3/10');
        assert.equal(res.headers.get('accept-ranges'), 'bytes');
        assert.equal(await res.text(), '0123');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('Range: bytes=4- 一直取到结尾', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/bytes.txt', { range: 'bytes=4-' }));
        assert.equal(res.status, 206);
        assert.equal(res.headers.get('content-range'), 'bytes 4-9/10');
        assert.equal(await res.text(), '456789');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('Range: bytes=-3 取最后三字节', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/bytes.txt', { range: 'bytes=-3' }));
        assert.equal(res.status, 206);
        assert.equal(res.headers.get('content-range'), 'bytes 7-9/10');
        assert.equal(await res.text(), '789');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('Range 终点超出文件长度时截到末尾', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/bytes.txt', { range: 'bytes=8-99' }));
        assert.equal(res.status, 206);
        assert.equal(res.headers.get('content-range'), 'bytes 8-9/10');
        assert.equal(await res.text(), '89');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('Range 起点越界返回 416 并告知真实长度', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/bytes.txt', { range: 'bytes=99-' }));
        assert.equal(res.status, 416);
        assert.equal(res.headers.get('content-range'), 'bytes */10');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('多段 Range 不支持,回退成 200 整份', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/bytes.txt', { range: 'bytes=0-1,4-5' }));
        assert.equal(res.status, 200);
        assert.equal(await res.text(), '0123456789');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('无 Range 时返回 200 并带 accept-ranges', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/bytes.txt'));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('accept-ranges'), 'bytes');
        assert.equal(res.headers.get('content-length'), '10');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('空文件返回 200 且长度为 0', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/empty.txt'));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-length'), '0');
        assert.equal(await res.text(), '');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('HEAD 只返回头,不带体', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(new Request('toolbox://shell/bytes.txt', { method: 'HEAD' }));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-length'), '10');
        assert.equal(await res.text(), '');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('JSON 文件用 application/json', async () => {
    const { base, root } = fixture();
    try {
        const handle = createRequestHandler({ shell: root });
        const res = await handle(get('toolbox://shell/data.json'));
        assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
