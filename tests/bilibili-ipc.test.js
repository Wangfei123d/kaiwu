import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CLIPBOARD_OK_MARKER, CLIPBOARD_RETRIES } from '../app/lib/bilibili-copy.js';
import {
    BILIBILI_INVOKE_CHANNELS, BILIBILI_PROXY_BASE, normalizeProxyBase, registerBilibiliIpc,
} from '../electron/bilibili/bilibili-ipc.js';
import { buildCtx } from '../app/runtime/ctx.js';

// 「复制视频」这条 IPC 链路。
//
// ⚠️ 这一组**绝不能碰真剪贴板**:剪贴板是用户的全局资源,单测把它覆盖掉和自检
// 覆盖掉一样不可接受。所以 fetchQueue / runClipboard / statPath 全部注入假货,
// 而且会断言"该调的时候调了、不该调的时候一次都没调"。

const FOLDER = 'D:\\project\\bilidown\\download';
const FILE = `${FOLDER}\\中国人能飞😭 [高清 1080P60] NA.mp4`;

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
    };
}

const doneTask = (over = {}) => ({
    id: 4, status: 'done', folder: FOLDER, fileName: '中国人能飞😭 [高清 1080P60] NA.mp4',
    filePath: FILE, fileReason: '', ...over,
});

function makeHarness({ queue, clipResults, enabled = true, base } = {}) {
    const calls = { clips: [], fetches: [] };
    const results = Array.isArray(clipResults) ? clipResults.slice() : null;
    const ipcMain = makeIpcMain();
    registerBilibiliIpc({
        ipcMain,
        enabled,
        ...(base === undefined ? {} : { resolveBaseUrl: base }),
        fetchQueue: async (url) => {
            calls.fetches.push(url);
            if (typeof queue === 'function') return queue(url);
            if (queue instanceof Error) throw queue;
            return queue ?? { code: 0, message: 'ok', data: { tasks: [doneTask()] } };
        },
        runClipboard: async (req) => {
            calls.clips.push(req);
            if (results !== null) return results.length > 1 ? results.shift() : results[0];
            return { stdout: CLIPBOARD_OK_MARKER, stderr: '', code: 0, timedOut: false };
        },
        statPath: (p) => (p === FILE ? { exists: true, isFile: true, size: 177737264 } : { exists: false, isFile: false, size: 0 }),
        log: { warn() {}, info() {}, error() {} },
    });
    return { ipcMain, calls };
}

// ---------- 注册面 ----------

test('注册的就是那一个频道', () => {
    const { ipcMain } = makeHarness();
    assert.deepEqual([...ipcMain.handlers.keys()], [...BILIBILI_INVOKE_CHANNELS]);
    assert.deepEqual([...BILIBILI_INVOKE_CHANNELS], ['clipboard:copyVideo']);
});

test('preload 放行了它,也没有放行没人注册的 clipboard 频道(两边漂移会静默失效)', () => {
    const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
    const start = preload.indexOf('const ALLOWED_INVOKE');
    const end = preload.indexOf('];', start);
    assert.ok(start >= 0 && end > start, 'preload 里找不到 ALLOWED_INVOKE 列表');
    const block = preload.slice(start, end);
    for (const channel of BILIBILI_INVOKE_CHANNELS) {
        assert.ok(block.includes(`'${channel}'`), `preload 没有放行 ${channel}`);
    }
    for (const quoted of block.matchAll(/'([^']+)'/g)) {
        const channel = quoted[1];
        if (!channel.startsWith('clipboard:')) continue;
        assert.ok(BILIBILI_INVOKE_CHANNELS.includes(channel), `preload 放行了没人注册的频道:${channel}`);
    }
});

test('权限门控:申请了 clipboard 才有 ctx.clipboard,而且它只递 taskId', async () => {
    const seen = [];
    const bridge = { invoke: (channel, payload) => { seen.push({ channel, payload }); return Promise.resolve({ ok: true }); } };
    const descriptor = { id: 'bilibili', name: 'x', version: '1.0.0', root: 'plugin', dir: '', permissions: ['log', 'clipboard'] };
    const ctx = buildCtx({ descriptor, bridge, registries: {}, log: { info() {}, warn() {}, error() {} } });
    assert.equal(typeof ctx.clipboard?.copyVideo, 'function');
    await ctx.clipboard.copyVideo(4);
    assert.deepEqual(seen, [{ channel: 'clipboard:copyVideo', payload: { taskId: 4 } }]);

    // 没申请就没有这个成员
    const denied = buildCtx({
        descriptor: { ...descriptor, permissions: ['log'] }, bridge,
        registries: {}, log: { info() {}, warn() {}, error() {} },
    });
    assert.equal(denied.clipboard, undefined);
});

test('清单校验认识 clipboard 这个权限(不认识的权限会被拒)', async () => {
    const { validateManifest } = await import('../app/lib/manifest-schema.js');
    const manifest = {
        id: 'bilibili', name: 'B站解析下载', version: '1.0.0', entry: 'index.js',
        permissions: ['log', 'services', 'settings', 'clipboard'],
    };
    assert.equal(validateManifest(manifest).ok, true);
});

// ---------- 正常路径 ----------

test('成功:只递 taskId,路径由主进程解析;真正执行的是 powershell.exe + -STA + SetFileDropList', async () => {
    const { ipcMain, calls } = makeHarness();
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });

    assert.equal(result.ok, true);
    assert.equal(result.fileName, '中国人能飞😭 [高清 1080P60] NA.mp4');
    assert.equal(result.filePath, FILE);
    assert.equal(result.attempts, 1);
    // 队列是主进程自己去本地代理取的(而且只取了一次)
    assert.deepEqual(calls.fetches, ['http://127.0.0.1:3302/bilibili/tasks']);
    assert.equal(calls.clips.length, 1);
    assert.equal(calls.clips[0].command, 'powershell.exe');
    assert.deepEqual(calls.clips[0].args.slice(0, 2), ['-NoProfile', '-STA']);
    assert.ok(calls.clips[0].args.join(' ').includes('SetFileDropList'));
    assert.ok(calls.clips[0].args.join(' ').includes(FILE), '脚本里必须带上那个真实文件路径');
});

test('成功:多出来的字段(比如渲染进程塞的 filePath)一律不采信 —— 路径只能是主进程解析出来的', async () => {
    const { ipcMain, calls } = makeHarness();
    const result = await ipcMain.invoke('clipboard:copyVideo', {
        taskId: 4,
        filePath: 'C:\\Windows\\System32\\config\\SAM',
        fileName: 'SAM',
    });
    assert.equal(result.ok, true);
    assert.equal(result.filePath, FILE, '用的是队列里那个路径,不是递进来的');
    assert.ok(!calls.clips[0].args.join(' ').includes('SAM'));
});

// ---------- 重试 ----------

test('重试:剪贴板被占用时重试,第二次成功 → attempts=2', async () => {
    const { ipcMain, calls } = makeHarness({
        clipResults: [
            { stdout: '', stderr: 'CLIPBRD_E_CANT_OPEN', code: 1, timedOut: false },
            { stdout: CLIPBOARD_OK_MARKER, stderr: '', code: 0, timedOut: false },
        ],
    });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(calls.clips.length, 2);
});

test('重试:"退出码 0 却没有标记"这种静默失败**不值得**重试(重试也不会变好)', async () => {
    const { ipcMain, calls } = makeHarness({ clipResults: [{ stdout: '', stderr: '', code: 0, timedOut: false }] });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'clipboard_failed');
    assert.match(result.reason, /没有写入剪贴板/);
    assert.equal(calls.clips.length, 1, '不重试:只该调一次');
});

test('重试:一直占用 → 试满 CLIPBOARD_RETRIES 次,并把中文原因带出来', async () => {
    const { ipcMain, calls } = makeHarness({
        clipResults: [{ stdout: '', stderr: 'CLIPBRD_E_CANT_OPEN', code: 1, timedOut: false }],
    });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /剪贴板被别的程序占用/);
    assert.equal(calls.clips.length, CLIPBOARD_RETRIES);
});

// ---------- 前置失败:各有各的码,而且**一次都不该写剪贴板** ----------

test('taskId 非法 → 立刻拒,不取队列、不写剪贴板', async () => {
    const { ipcMain, calls } = makeHarness();
    for (const bad of [0, -3, 'x', null, undefined, 2.5]) {
        const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: bad });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'bad_task_id', `${String(bad)} 该被拒`);
    }
    assert.equal(calls.fetches.length, 0);
    assert.equal(calls.clips.length, 0);
});

test('代理没起来 → proxy_unreachable 且给下一步(而不是一句"失败")', async () => {
    const { ipcMain, calls } = makeHarness({ queue: new Error('fetch failed') });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.code, 'proxy_unreachable');
    assert.match(result.reason, /服务没起来/);
    assert.equal(calls.clips.length, 0);
});

test('代理回了业务失败 → queue_error,把上游那句话带出来', async () => {
    const { ipcMain } = makeHarness({ queue: { code: 1, message: '无法连接 Bilidown', data: null } });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.code, 'queue_error');
    assert.match(result.reason, /无法连接 Bilidown/);
});

test('任务不存在 / 还没完成 / 还没定位到文件 / 不在自己目录里 / 文件没了 —— 五个分支各有各的码', async () => {
    const cases = [
        [{ tasks: [doneTask({ id: 9 })] }, 'task_missing'],
        [{ tasks: [doneTask({ status: 'download' })] }, 'task_not_done'],
        [{ tasks: [doneTask({ filePath: '', fileReason: '下载目录里没有以这个标题开头的视频文件' })] }, 'file_unresolved'],
        [{ tasks: [doneTask({ filePath: 'C:\\Windows\\notepad.mp4' })] }, 'outside_folder'],
        [{ tasks: [doneTask({ filePath: `${FOLDER}\\gone.mp4` })] }, 'file_missing'],
    ];
    for (const [queue, expected] of cases) {
        const { ipcMain, calls } = makeHarness({ queue: { code: 0, message: 'ok', data: queue } });
        const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
        assert.equal(result.code, expected, JSON.stringify(queue.tasks[0]));
        assert.ok(String(result.reason).length > 0, '每个失败都要有一句能读的中文');
        assert.equal(calls.clips.length, 0, `${expected} 不该去写剪贴板`);
    }
});

// ---------- 自检守卫 ----------

test('自检模式(enabled:false):链路照走,但**一次都不碰系统剪贴板**', async () => {
    const { ipcMain, calls } = makeHarness({ enabled: false });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.code, 'selftest');
    assert.equal(result.fileName, '中国人能飞😭 [高清 1080P60] NA.mp4', '文件名照给,界面才能显示');
    assert.equal(calls.clips.length, 0, '自检绝不能覆盖用户的剪贴板');
    // 队列照取(那条链路要证到)
    assert.equal(calls.fetches.length, 1);
});

test('自检模式:前置失败仍按正常语义返回(守卫只管"要不要真写")', async () => {
    const { ipcMain } = makeHarness({ enabled: false, queue: { code: 0, message: 'ok', data: { tasks: [] } } });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'task_missing');
});

test('dispose 摘掉处理器', () => {
    const ipcMain = makeIpcMain();
    const handle = registerBilibiliIpc({
        ipcMain,
        fetchQueue: async () => ({ code: 0, data: { tasks: [] } }),
        runClipboard: async () => ({ stdout: '', stderr: '', code: 0 }),
        statPath: () => ({ exists: false }),
        log: { warn() {} },
    });
    assert.equal(ipcMain.handlers.size, 1);
    handle.dispose();
    assert.equal(ipcMain.handlers.size, 0);
    handle.dispose();
    assert.equal(ipcMain.handlers.size, 0);
});

test('接线错了要当场抛(不是等用户点复制才炸)', () => {
    assert.throws(() => registerBilibiliIpc({}), /需要 ipcMain/);
});

// ---------- 代理地址 ----------

test('代理地址:空/空白/末尾斜杠都收敛好,默认是 3302', () => {
    assert.equal(normalizeProxyBase(''), BILIBILI_PROXY_BASE);
    assert.equal(normalizeProxyBase('   '), BILIBILI_PROXY_BASE);
    assert.equal(normalizeProxyBase(null), BILIBILI_PROXY_BASE);
    assert.equal(normalizeProxyBase('http://127.0.0.1:3399/'), 'http://127.0.0.1:3399');
    assert.equal(normalizeProxyBase(' http://127.0.0.1:3399/// '), 'http://127.0.0.1:3399');
});

test('代理地址:与界面读的是**同一个**设置(可以覆盖;写死就会出现"界面看 A、复制问 B")', async () => {
    const { ipcMain, calls } = makeHarness({ base: () => 'http://127.0.0.1:3399/' });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.fetches, ['http://127.0.0.1:3399/bilibili/tasks']);

    // 给函数时每次都现取(设置可能在运行中变)
    let current = 'http://127.0.0.1:3400';
    const second = makeHarness({ base: () => current });
    await second.ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    current = 'http://127.0.0.1:3401';
    await second.ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.deepEqual(second.calls.fetches, [
        'http://127.0.0.1:3400/bilibili/tasks',
        'http://127.0.0.1:3401/bilibili/tasks',
    ]);
});

test('代理回了 HTTP 404(旧版本代理没有队列端点):要说是版本问题,别让用户去重启服务瞎试', async () => {
    const err = new Error('代理返回 HTTP 404');
    err.httpStatus = 404;
    const { ipcMain, calls } = makeHarness({ queue: err });
    const result = await ipcMain.invoke('clipboard:copyVideo', { taskId: 4 });
    assert.equal(result.code, 'proxy_http_error');
    assert.match(result.reason, /HTTP 404/);
    assert.match(result.reason, /旧版本/);
    assert.equal(calls.clips.length, 0);
});
