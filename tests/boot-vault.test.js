import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerNotesIpc } from '../electron/notes/notes-ipc.js';

// 「已配置好笔记库时,启动后不能停在向导上」——这是用户实际报过的回归。
// 复现方式:模拟一次完整的启动状态查询,确认它明确回答"可用"。
// 只要这个回答正确,app/main.js 的 boot 就会走"不显示向导"那条路
// (boot 的判定逻辑在 tests/onboarding.test.js 里另有覆盖)。

function harness(store) {
    const handlers = new Map();
    const ipcMain = {
        handle: (c, f) => handlers.set(c, f),
        removeHandler: (c) => handlers.delete(c),
    };
    const settings = {
        get: (ns, k) => store.get(`${ns}:${k}`),
        set: (ns, k, v) => store.set(`${ns}:${k}`, v),
    };
    registerNotesIpc({
        ipcMain,
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        settings,
        getWindow: () => null,
    });
    return (c, p) => handlers.get(c)(null, p);
}

function makeVault(label) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `kaiwu-boot-${label}-`));
    const root = path.join(base, 'vault');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '一篇.md'), '# 一篇\n', 'utf8');
    return { base, root };
}

test('已记住且存在的笔记库:状态查询回答 ok=true(于是启动不进向导)', async () => {
    const { base, root } = makeVault('ok');
    try {
        const store = new Map([['__global:lastVault', root]]);
        const call = harness(store);

        const st = await call('notes:vault:status', {});
        assert.equal(st.configured, true, '配置过');
        assert.equal(st.ok, true, '必须明确回答可用 —— 否则启动会误进向导');
        assert.equal(st.path, fs.realpathSync(root));
        assert.equal(st.reason, null);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('已记住但已消失的笔记库:ok=false 且带原因(此时才该显示向导)', async () => {
    const { base, root } = makeVault('gone');
    const store = new Map([['__global:lastVault', root]]);
    fs.rmSync(base, { recursive: true, force: true });

    const call = harness(store);
    const st = await call('notes:vault:status', {});
    assert.equal(st.configured, true);
    assert.equal(st.ok, false);
    assert.match(st.reason, /找不到/);
});

test('一次成功的启动:状态可用 + 索引能读出笔记', async () => {
    const { base, root } = makeVault('boot');
    try {
        fs.writeFileSync(path.join(root, '二篇.md'), '# 二篇\n', 'utf8');
        const store = new Map([['__global:lastVault', root]]);
        const call = harness(store);

        const st = await call('notes:vault:status', {});
        assert.equal(st.ok, true);

        const idx = await call('notes:index', {});
        assert.equal(idx.notes.length, 2, '索引要能列出笔记,否则界面会是空的');
        assert.deepEqual(idx.errors, []);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
