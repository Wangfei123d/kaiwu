import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerNotesIpc, volumeHasRecycleBin, VAULT_TRASH_DIR } from '../electron/notes/notes-ipc.js';

// 用替身注册 IPC,然后把频道当普通函数调 —— 这样 handler 的行为能被完整覆盖,
// 不必启动 Electron。
// shell / trash 都是**可注入**的:测试跑在纯 Node 里,没有 Electron 的 shell,
// 所以"把文件丢进回收站"这件事必须能换成记账用的假实现(见 notes:remove 那一节)。
function harness({ vault = null, pickResult = null, shell = null, trash = null } = {}) {
    const handlers = new Map();
    const store = new Map();
    if (vault !== null) store.set('__global:lastVault', vault);

    const ipcMain = {
        handle: (channel, fn) => handlers.set(channel, fn),
        removeHandler: (channel) => handlers.delete(channel),
    };
    const settings = {
        get: (ns, key) => store.get(`${ns}:${key}`),
        set: (ns, key, value) => store.set(`${ns}:${key}`, value),
    };
    const dialog = {
        showOpenDialog: async () => pickResult ?? { canceled: true, filePaths: [] },
    };

    const api = registerNotesIpc({ ipcMain, dialog, settings, getWindow: () => null, shell, trash });
    const call = (channel, payload) => handlers.get(channel)(null, payload);
    return { handlers, call, api, store };
}

function tmpVault(label = 'ipc') {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `kaiwu-${label}-`));
    const root = path.join(base, 'vault');
    fs.mkdirSync(root, { recursive: true });
    return { base, root };
}

const put = (root, rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
};

/**
 * 当前卷的大小写是否不敏感。
 *
 * N1 那条缺陷**只在大小写不敏感的卷上成立**(Windows / macOS 默认卷;本仓库的
 * 临时 Vault 落在 C:\...\Temp = NTFS)。这里不猜平台名,而是**实测**:同一个文件
 * 换个拼写还能 stat 到,就是不敏感。这样在 Linux 的 CI 上用例会明确 [SKIP] 而不是
 * 空转通过 —— "跳过"和"其实什么也没验"必须能被区分开。
 */
function isCaseInsensitiveFs() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-case-'));
    try {
        fs.writeFileSync(path.join(dir, 'probe'), 'x');
        return fs.existsSync(path.join(dir, 'PROBE'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------- Vault 状态与选择 ----------

test('没选过 Vault 时状态为未配置', async () => {
    const { call } = harness();
    const st = await call('notes:vault:status');
    assert.equal(st.configured, false);
    assert.equal(st.ok, false);
});

test('取消选择时不改变状态', async () => {
    const { call } = harness({ pickResult: { canceled: true, filePaths: [] } });
    const r = await call('notes:vault:choose');
    assert.equal(r.ok, false);
    assert.equal(r.canceled, true);
});

test('选定 Vault 后状态可用并记住路径', async () => {
    const { base, root } = tmpVault('choose');
    try {
        const { call, store } = harness({ pickResult: { canceled: false, filePaths: [root] } });
        const r = await call('notes:vault:choose');
        assert.equal(r.ok, true);
        assert.equal(r.status.ok, true);
        assert.equal(r.noteCount, 0);
        assert.equal(store.get('__global:lastVault'), root, '必须记住,下次启动直接用');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('选定已有笔记的目录时报告发现了几篇(家族口径:.md + .txt)', async () => {
    const { base, root } = tmpVault('count');
    try {
        put(root, 'a.md', '# a');
        put(root, '子/b.md', '# b');
        put(root, 'c.txt', 'x');
        const { call } = harness({ pickResult: { canceled: false, filePaths: [root] } });
        const r = await call('notes:vault:choose');
        // ⚠️ 3 而不是 2:txt 现在也是"能打开的笔记",只数 .md 会让一个装满 txt 剧本的
        //    目录被报成"空文件夹"(短剧 inputs/ 里那三个 txt 就是这么被漏掉的)。
        assert.equal(r.noteCount, 3);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('记着的 Vault 被删掉时状态为不可用,并说明原因', async () => {
    const { base, root } = tmpVault('gone');
    const { call } = harness({ vault: root });
    fs.rmSync(base, { recursive: true, force: true });

    const st = await call('notes:vault:status');
    assert.equal(st.configured, true, '配置过');
    assert.equal(st.ok, false, '但当前不可用');
    assert.match(st.reason, /找不到/);
});

test('记着的位置变成文件时也判为不可用', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-notdir-'));
    const filePath = path.join(base, '不是目录');
    try {
        fs.writeFileSync(filePath, 'x');
        const { call } = harness({ vault: filePath });
        const st = await call('notes:vault:status');
        assert.equal(st.ok, false);
        assert.match(st.reason, /不是一个文件夹/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('未配置 Vault 时索引会报错而不是返回空', async () => {
    const { call } = harness();
    await assert.rejects(() => call('notes:index'), /笔记库/);
});

// ---------- 索引 ----------

test('索引返回列表、标签、反链', async () => {
    const { base, root } = tmpVault('idx');
    try {
        put(root, '甲.md', '---\ntags: [项目]\n---\n# 甲\n见 [[乙]] #随手');
        put(root, '乙.md', '# 乙\n见 [[甲]]');
        put(root, '孤岛.md', '# 孤岛');

        const { call } = harness({ vault: root });
        const r = await call('notes:index');

        assert.equal(r.root, fs.realpathSync(root));
        // 不按中文字典序断言 —— 默认排序是 UTF-16 码点序,与拼音序无关,
        // 拿它当断言只会写出脆弱的测试。用集合比较。
        assert.deepEqual([...r.notes.map(n => n.path)].sort(),
            ['孤岛.md', '乙.md', '甲.md'].sort());
        assert.ok(r.tags.some(t => t.tag === '项目'));
        assert.ok(r.tags.some(t => t.tag === '随手'));
        assert.equal(r.backlinks['甲.md'].length, 1);
        assert.deepEqual(r.orphans, ['孤岛.md']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('索引结果里不含正文(列表不需要,别白传)', async () => {
    const { base, root } = tmpVault('nobody');
    try {
        put(root, 'a.md', '# 标题\n很长的正文'.repeat(100));
        const { call } = harness({ vault: root });
        const r = await call('notes:index');
        assert.equal(r.notes[0].body, undefined);
        assert.equal(typeof r.notes[0].linkCount, 'number');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- 读写与安全边界 ----------

test('读写笔记往返', async () => {
    const { base, root } = tmpVault('rw');
    try {
        const { call } = harness({ vault: root });
        await call('notes:create', { path: '新笔记.md', text: '# 你好' });
        assert.equal((await call('notes:read', { path: '新笔记.md' })).text, '# 你好');

        await call('notes:write', { path: '新笔记.md', text: '# 改过了' });
        assert.equal((await call('notes:read', { path: '新笔记.md' })).text, '# 改过了');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('读取拒绝越界路径', async () => {
    const { base, root } = tmpVault('guard');
    try {
        const { call } = harness({ vault: root });
        // 用 .md 结尾,才能真正走到路径守卫那一层
        // (非 .md 会先被扩展名检查拦下,那是另一条规则)
        await assert.rejects(() => call('notes:read', { path: '../外面.md' }), /越出/);
        await assert.rejects(() => call('notes:read', { path: 'C:/Windows/x.md' }), /越出/);
        await assert.rejects(() => call('notes:read', { path: '../../etc/passwd.md' }), /越出/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('非 .md 在路径守卫之前就被拦下', async () => {
    const { base, root } = tmpVault('ext-first');
    try {
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:read', { path: 'C:/Windows/win.ini' }), /只允许/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('写入拒绝越界路径,不落到 Vault 外', async () => {
    const { base, root } = tmpVault('wguard');
    const outside = path.join(base, 'outside');
    try {
        fs.mkdirSync(outside);
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:write', { path: '../outside/x.md', text: 'x' }), /越出/);
        assert.equal(fs.existsSync(path.join(outside, 'x.md')), false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('写入拒绝经目录联接逃逸的路径', async () => {
    const { base, root } = tmpVault('wlink');
    const outside = path.join(base, 'outside');
    try {
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:write', { path: 'escape/偷.md', text: 'x' }), /越出/);
        assert.equal(fs.existsSync(path.join(outside, '偷.md')), false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('只允许家族文件:.md / .txt 能读能写,.png 不行', async () => {
    const { base, root } = tmpVault('ext');
    try {
        const { call } = harness({ vault: root });
        // ⚠️ 从前这里钉的是"x.txt 也要被拒"。用户这一轮的决定是 txt 可编辑 ——
        //    于是它读得到、写得进,而"参不参与 Markdown"是另一问(由界面走纯文本模式)。
        await call('notes:write', { path: 'x.txt', text: '第一行\n' });
        assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), '第一行\n');
        const read = await call('notes:read', { path: 'x.txt' });
        assert.equal(read.kind, 'text');
        assert.equal(read.editable, true);
        await assert.rejects(() => call('notes:read', { path: 'x.png' }), /只允许/);
        await assert.rejects(() => call('notes:write', { path: 'x.docx', text: 'x' }), /只允许/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:index 把 txt 放进 texts 桶(不进 notes —— 链接与标签都碰不到它)', async () => {
    const { base, root } = tmpVault('texts-bucket');
    try {
        put(root, '甲.md', '# 甲\n见 [[乙]]');
        put(root, '剧本.txt', '# 这不是标题\n见 [[乙]] #标签');
        const { call } = harness({ vault: root });
        const idx = await call('notes:index');
        assert.deepEqual(idx.notes.map(n => n.path), ['甲.md'], 'txt 绝不能进 notes');
        assert.deepEqual(idx.texts.map(t => t.path), ['剧本.txt']);
        assert.deepEqual(idx.others.map(o => o.path), [], 'txt 也不再算"其他文件"');
        assert.deepEqual(idx.tags.map(t => t.name), [], 'txt 里的 #标签 不该进标签面板');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:links 对纯文本回一个空结果 + kind,不抛错(界面据此写"不参与链接")', async () => {
    const { base, root } = tmpVault('texts-links');
    try {
        put(root, '剧本.txt', '见 [[甲]]');
        put(root, '甲.md', '# 甲');
        const { call } = harness({ vault: root });
        const r = await call('notes:links', { path: '剧本.txt' });
        assert.equal(r.kind, 'text');
        assert.deepEqual([r.outgoing, r.backlinks, r.unresolved], [[], [], []]);
        const md = await call('notes:links', { path: '甲.md' });
        assert.equal(md.kind, 'markdown');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('text 不是字符串时报错', async () => {
    const { base, root } = tmpVault('type');
    try {
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:write', { path: 'a.md', text: 123 }), /字符串/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('create 不覆盖已有笔记', async () => {
    const { base, root } = tmpVault('dup');
    try {
        put(root, 'a.md', '已有');
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:create', { path: 'a.md', text: '覆盖' }), /已存在/);
        assert.equal((await call('notes:read', { path: 'a.md' })).text, '已有');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- 反链与 frontmatter ----------

test('notes:links 取某篇的出链与反链', async () => {
    const { base, root } = tmpVault('links');
    try {
        put(root, '甲.md', '# 甲\n见 [[乙]]');
        put(root, '乙.md', '# 乙\n见 [[甲]] 与 [[还没写]]');
        const { call } = harness({ vault: root });

        const r = await call('notes:links', { path: '甲.md' });
        assert.deepEqual(r.outgoing.map(o => o.path), ['乙.md']);
        assert.deepEqual(r.backlinks.map(b => b.path), ['乙.md']);

        const r2 = await call('notes:links', { path: '乙.md' });
        assert.equal(r2.unresolved.length, 1);
        assert.equal(r2.unresolved[0].target, '还没写');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:links 对不存在的笔记报错', async () => {
    const { base, root } = tmpVault('nolinks');
    try {
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:links', { path: '没有.md' }), /找不到/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('replaceFrontmatter 只改元数据不动正文', async () => {
    const { base, root } = tmpVault('fm');
    try {
        put(root, 'a.md', '---\ntitle: 旧\n---\n# 正文\n不该被动。');
        const { call } = harness({ vault: root });
        await call('notes:replaceFrontmatter', { path: 'a.md', data: { title: '新' } });
        const after = (await call('notes:read', { path: 'a.md' })).text;
        assert.ok(after.includes('title: 新'));
        assert.ok(after.includes('# 正文\n不该被动。'));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- 重命名 ----------

test('rename 移动笔记', async () => {
    const { base, root } = tmpVault('ren');
    try {
        put(root, 'a.md', '# a');
        const { call } = harness({ vault: root });
        await call('notes:rename', { from: 'a.md', to: '子/b.md' });
        assert.equal(fs.existsSync(path.join(root, 'a.md')), false);
        assert.equal(fs.readFileSync(path.join(root, '子', 'b.md'), 'utf8'), '# a');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('rename 不覆盖已存在的目标', async () => {
    const { base, root } = tmpVault('ren2');
    try {
        put(root, 'a.md', '# a');
        put(root, 'b.md', '# b');
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:rename', { from: 'a.md', to: 'b.md' }), /已存在/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- 改标题:文件名与正文 H1 一起改 ----------
//
// 用户报的缺陷:「命名好后无法保存」。顶栏那个「笔记标题」输入框里的字
// 必须真的落盘,而且落成**两处** —— 文件名 + 正文第一个 H1。
// 只改一处会被另一处盖回去:标题解析顺序是 frontmatter.title → H1 → 文件名。

test('setTitle 改文件名,并把正文 H1 一起换掉', async () => {
    const { base, root } = tmpVault('title');
    try {
        put(root, '未命名.md', '# 未命名\n\n');
        const { call } = harness({ vault: root });
        const r = await call('notes:setTitle', { path: '未命名.md', title: '第一个笔记' });
        assert.equal(r.to, '第一个笔记.md');
        assert.equal(r.renamed, true);
        assert.equal(fs.existsSync(path.join(root, '未命名.md')), false);
        assert.equal(
            fs.readFileSync(path.join(root, '第一个笔记.md'), 'utf8'),
            '# 第一个笔记\n\n',
        );
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 之后索引里的标题就是新标题', async () => {
    // 这条才是用户真正看到的结果:列表与顶栏显示「第一个笔记」。
    // 只改文件名的话,正文里的旧 H1 会把标题盖回「未命名」—— 正是这条要挡的。
    const { base, root } = tmpVault('title2');
    try {
        put(root, '未命名.md', '# 未命名\n\n正文\n');
        const { call } = harness({ vault: root });
        await call('notes:setTitle', { path: '未命名.md', title: '第一个笔记' });
        const idx = await call('notes:index');
        assert.equal(idx.notes.length, 1);
        assert.equal(idx.notes[0].path, '第一个笔记.md');
        assert.equal(idx.notes[0].title, '第一个笔记');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 保住子目录', async () => {
    const { base, root } = tmpVault('title3');
    try {
        put(root, '子/未命名.md', '# 未命名\n');
        const { call } = harness({ vault: root });
        const r = await call('notes:setTitle', { path: '子/未命名.md', title: '新名' });
        assert.equal(r.to, '子/新名.md');
        assert.equal(fs.existsSync(path.join(root, '子', '新名.md')), true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 目标已存在时报错,且两个文件都一个字不动', async () => {
    const { base, root } = tmpVault('title4');
    try {
        put(root, 'a.md', '# 甲\n');
        put(root, 'b.md', '# 乙\n');
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:setTitle', { path: 'a.md', title: 'b' }), /已存在/);
        assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# 甲\n');
        assert.equal(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), '# 乙\n');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 标题为空时报错(界面据此把输入框还原)', async () => {
    const { base, root } = tmpVault('title5');
    try {
        put(root, 'a.md', '# 甲\n');
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:setTitle', { path: 'a.md', title: '   ' }), /标题/);
        await assert.rejects(() => call('notes:setTitle', { path: 'a.md' }), /标题/);
        assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# 甲\n');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 同名时不重命名,但照样同步 H1', async () => {
    // 文件名已经是新的、正文 H1 还是旧的 —— 这一半也必须能修
    const { base, root } = tmpVault('title6');
    try {
        put(root, '第一个笔记.md', '# 未命名\n');
        const { call } = harness({ vault: root });
        const r = await call('notes:setTitle', { path: '第一个笔记.md', title: '第一个笔记' });
        assert.equal(r.renamed, false);
        assert.equal(r.to, '第一个笔记.md');
        assert.equal(fs.readFileSync(path.join(root, '第一个笔记.md'), 'utf8'), '# 第一个笔记\n');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 去掉标题里的非法文件名字符', async () => {
    const { base, root } = tmpVault('title7');
    try {
        put(root, 'a.md', '# a\n');
        const { call } = harness({ vault: root });
        const r = await call('notes:setTitle', { path: 'a.md', title: '  甲/乙:丙*丁?  ' });
        assert.equal(r.to, '甲乙丙丁.md');
        assert.equal(fs.existsSync(path.join(root, '甲乙丙丁.md')), true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 不能借标题把文件写到库外(路径分隔符一律剥掉)', async () => {
    const { base, root } = tmpVault('title8');
    try {
        put(root, 'a.md', '# a\n');
        const { call } = harness({ vault: root });
        const r = await call('notes:setTitle', { path: 'a.md', title: '../../逃逸' });
        assert.equal(r.to, '....逃逸.md', '/ 被剥掉,所以穿越不成立');
        assert.ok(path.resolve(root, r.to).startsWith(path.resolve(root) + path.sep));
        assert.equal(fs.existsSync(path.join(root, '....逃逸.md')), true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- Windows 保留设备名与标题长度 ----------
//
// 这一组挡的是"改标题失败、报错却和标题无关"以及"看起来成功了、其实落成一个
// 读不回来的条目"。两者都源于 sanitizeTitle 只剥了非法字符,没有做平台侧判断。

test('Windows 保留设备名不许当标题:抛中文原因,并且一个文件都不动', async () => {
    // CON/PRN/AUX/NUL/COM1-9/LPT1-9 在 Win32 上是设备而不是文件名 —— 而且**忽略扩展名**,
    // 所以 CON.md 的临时文件 CON.md.tmp-<pid> 打开时同样炸。旧行为有两种表现:
    // CON 抛一句与标题毫无关系的 ENOENT,PRN/AUX 之类不抛错却落成一个读不回来的条目。
    const { base, root } = tmpVault('reserved');
    try {
        put(root, 'a.md', '# 甲\n');
        const { call } = harness({ vault: root });

        for (const title of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'CON.md', 'con.txt']) {
            await assert.rejects(
                () => call('notes:setTitle', { path: 'a.md', title }),
                /设备名/,
                `标题「${title}」必须被当场拒绝,而不是交给 fs 去炸`,
            );
        }

        // 拒绝必须是**动盘之前**:原文件与正文一个字都不能变,"看起来成功"的那条路
        // 正是它以前会留下读不回来的条目。
        assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# 甲\n');
        assert.deepEqual(fs.readdirSync(root), ['a.md'], '不许有 CON.md / CON.md.bak 之类的残留');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('标题长度上限 100 个字符(中文按字符算),超限的消息不许带内部绝对路径', async () => {
    const { base, root } = tmpVault('toolong');
    try {
        put(root, 'a.md', '# 甲\n');
        const { call } = harness({ vault: root });

        for (const title of ['a'.repeat(101), '甲'.repeat(101), 'a'.repeat(300)]) {
            const err = await call('notes:setTitle', { path: 'a.md', title }).then(
                () => null, e => e);
            assert.ok(err instanceof Error, '超长标题必须被拒');
            assert.match(err.message, /100/, '消息要说清上限是多少');
            // 旧行为是交给 fs 去炸,于是 Windows 把整条绝对路径原样递回界面
            // (C:\Users\...\AppData\Local\Temp\...):渲染进程不该看到用户机器的目录结构。
            assert.equal(err.message.includes(root), false, `消息泄露了笔记库绝对路径:${err.message}`);
            assert.equal(err.message.includes(base), false, `消息泄露了临时目录绝对路径:${err.message}`);
        }

        // 边界:正好 100 字必须**能过**(否则"上限 100"是假的)
        const ok = await call('notes:setTitle', { path: 'a.md', title: '甲'.repeat(100) });
        assert.equal(ok.title, '甲'.repeat(100), '100 个字正好在上限内,必须能建');
        assert.equal(fs.existsSync(path.join(root, `${'甲'.repeat(100)}.md`)), true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('合法长标题(60 个中文)照旧可用', async () => {
    const { base, root } = tmpVault('long-ok');
    try {
        put(root, 'a.md', '# a\n');
        const { call } = harness({ vault: root });
        const title = '长'.repeat(60);
        const r = await call('notes:setTitle', { path: 'a.md', title });
        assert.equal(r.to, `${title}.md`);
        assert.equal(fs.existsSync(path.join(root, `${title}.md`)), true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 把标题改成同名只差大小写时必须成功,不能被"目标已存在"挡住', async () => {
    // 在大小写不敏感的 fs 上,目标 Bar.md 与源 bar.md 是**同一个文件** ——
    // 只看 existsSync 会把"目标就是它自己"判成冲突,用户被拒且无从判断。
    // 而且 Windows 的 rename 常常只改目录项大小写的一半:必须走"先临时名再目标名"两步。
    const { base, root } = tmpVault('caserename');
    try {
        put(root, 'bar.md', '# 旧\n');
        const { call } = harness({ vault: root });

        const r = await call('notes:setTitle', { path: 'bar.md', title: 'Bar' });
        assert.equal(r.to, 'Bar.md');
        assert.equal(r.renamed, true, '纯大小写也算真的改了名(目录项要跟着变)');
        assert.equal(fs.existsSync(path.join(root, 'Bar.md')), true);
        assert.deepEqual(fs.readdirSync(root).filter(f => f.endsWith('.md')), ['Bar.md'],
            '旧的小写拼写不许再作为独立条目存在');

        const idx = await call('notes:index');
        assert.equal(idx.notes.length, 1);
        assert.equal(idx.notes[0].path, 'Bar.md', '索引必须报新的大小写');
        assert.equal(idx.notes[0].title, 'Bar', 'H1 也要跟着改(setTitle 的既有契约)');
        assert.equal(fs.readFileSync(path.join(root, 'Bar.md'), 'utf8'), '# Bar\n');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- .bak 的处置(有意保留一代,但必须跟着改名走) ----------

test('setTitle 之后 .bak 跟着走到新名字下,旧名字下不留残留', async () => {
    // .bak 里是**旧内容**(给"AI 改笔记"兜底的那一代)。若把它留在旧文件名下,
    // 旧内容就换了个名字继续住在库里,而列表上谁也看不见它。
    const { base, root } = tmpVault('bak-follow');
    try {
        put(root, 'old.md', '# 旧标题\n\n重要正文\n');
        const { call } = harness({ vault: root });

        const r = await call('notes:setTitle', { path: 'old.md', title: '新标题' });
        assert.equal(r.to, '新标题.md');
        assert.deepEqual(fs.readdirSync(root).sort(), ['新标题.md', '新标题.md.bak'],
            '旧名字下不许留下 .bak');
        assert.equal(fs.readFileSync(path.join(root, '新标题.md.bak'), 'utf8'), '# 旧标题\n\n重要正文\n',
            '备份里必须仍是被改之前的那一代内容');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 连续改名只留一代备份:旧名字下永远不留残留', async () => {
    // "一代"是这个备份的整个语义:它给「AI 改笔记」兜底,不是历史堆叠。
    // 若改名时把它留在旧名字下,库里就会出现一份**看不见的**历史副本,
    // 而且改几次就攒几份。
    const { base, root } = tmpVault('bak-one-gen');
    try {
        put(root, '一.md', '# 一\n');
        const { call } = harness({ vault: root });

        await call('notes:setTitle', { path: '一.md', title: '二' });
        assert.deepEqual(fs.readdirSync(root).sort(), ['二.md', '二.md.bak']);
        assert.equal(fs.readFileSync(path.join(root, '二.md.bak'), 'utf8'), '# 一\n');

        await call('notes:setTitle', { path: '二.md', title: '三' });
        assert.deepEqual(fs.readdirSync(root).sort(), ['三.md', '三.md.bak'],
            '改两次名之后仍然只有一代:旧名字下不许攒出第二份');
        assert.equal(fs.readFileSync(path.join(root, '三.md.bak'), 'utf8'), '# 二\n',
            '这一代是**改名之前**的那份内容');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:rename 也把 .bak 一起搬走,并且只留一代', async () => {
    const { base, root } = tmpVault('bak-rename');
    try {
        put(root, 'a.md', '# a\n');
        put(root, 'a.md.bak', '# 上一代\n');
        const { call } = harness({ vault: root });

        await call('notes:rename', { from: 'a.md', to: '子/b.md' });
        assert.deepEqual(fs.readdirSync(root), ['子'], 'a.md 与 a.md.bak 都必须离开根目录');
        assert.deepEqual(fs.readdirSync(path.join(root, '子')).sort(), ['b.md', 'b.md.bak']);
        assert.equal(fs.readFileSync(path.join(root, '子', 'b.md.bak'), 'utf8'), '# 上一代\n');

        // 再改一次名:旧名字下不许留下"上一代"的那份
        await call('notes:rename', { from: '子/b.md', to: '子/c.md' });
        assert.deepEqual(fs.readdirSync(path.join(root, '子')).sort(), ['c.md', 'c.md.bak']);
        assert.equal(fs.readFileSync(path.join(root, '子', 'c.md.bak'), 'utf8'), '# 上一代\n');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- frontmatter.title 与文件名/H1 保持一致 ----------

test('setTitle 会更新已有的 frontmatter.title(否则列表显示的还是旧标题)', async () => {
    // 标题解析顺序是 frontmatter.title → 第一个 H1 → 文件名。只改文件名与 H1 时,
    // 带 frontmatter.title 的笔记改完标题**列表里一个字都不变** —— 用户回车几次
    // 就真的重命名几次,而界面看起来毫无反应。
    const { base, root } = tmpVault('fm-title');
    try {
        put(root, 'a.md', '---\ntitle: 旧\n---\n# 旧\n');
        const { call } = harness({ vault: root });

        const r = await call('notes:setTitle', { path: 'a.md', title: '新' });
        assert.equal(r.to, '新.md');
        const after = fs.readFileSync(path.join(root, '新.md'), 'utf8');
        assert.equal(after, '---\ntitle: 新\n---\n# 新\n', 'frontmatter 与 H1 必须一起改');

        const idx = await call('notes:index');
        assert.equal(idx.notes.length, 1);
        assert.equal(idx.notes[0].path, '新.md');
        assert.equal(idx.notes[0].title, '新', '列表拿到的标题必须真的变了');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 不新增 frontmatter.title:没有元数据的笔记改完还是干净的', async () => {
    // 用户没写过元数据,应用不该替他写进去。只有**已经有** title 键时才更新它。
    const { base, root } = tmpVault('fm-none');
    try {
        put(root, 'a.md', '# 旧\n\n正文\n');
        const { call } = harness({ vault: root });

        await call('notes:setTitle', { path: 'a.md', title: '新' });
        const after = fs.readFileSync(path.join(root, '新.md'), 'utf8');
        assert.equal(after, '# 新\n\n正文\n', '不许凭空多出 frontmatter');
        assert.equal(after.startsWith('---'), false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 更新 frontmatter.title 时保住其余元数据与正文', async () => {
    const { base, root } = tmpVault('fm-keep');
    try {
        put(root, 'a.md', '---\ntitle: 旧\ntags: [项目]\n---\n# 旧\n\n正文不能动。\n');
        const { call } = harness({ vault: root });
        await call('notes:setTitle', { path: 'a.md', title: '新' });

        const after = fs.readFileSync(path.join(root, '新.md'), 'utf8');
        assert.ok(after.includes('title: 新'), 'title 要更新');
        assert.ok(after.includes('tags: [项目]'), '别的元数据一个字不许动');
        assert.ok(after.includes('# 新\n\n正文不能动。\n'), '正文不许被重排');

        const idx = await call('notes:index');
        assert.deepEqual(idx.notes[0].tags, ['项目']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- 纯大小写改名时的 .bak(N1 的回归钉子) ----------
//
// 这一组必须用**不带过滤的 readdirSync**:上一轮的纯大小写用例在断言前
// `filter(f => f.endsWith('.md'))` 把 `.bak` 滤掉了,于是 N1 那条
// ".bak 被 rm(to) 删掉"的缺陷在用例里完全看不见。断言"列表里有什么"这件事
// 一定要看全量条目 —— 过滤掉的那部分正是最容易出错的那部分。

test('纯大小写改名后 .bak 必须还在,且仍是改名之前那一代(N1)', { skip: !isCaseInsensitiveFs() && '大小写敏感的文件系统上 bar.md.bak 与 Bar.md.bak 本来就是两个文件,复现不了这条缺陷' }, async () => {
    // 成因:大小写不敏感卷上 from 与 to 是**同一个文件**,而旧 moveNoteBackup 先
    // `rm(to)` —— 那等于把手里的待搬文件删了,接着 rename 抛 ENOENT 又被 catch 吞掉。
    // 端到端表现:改完大小写,`.bak` 静默消失,用户刚被承诺的"一代后悔药"没了。
    const { base, root } = tmpVault('caseonly-bak');
    try {
        put(root, 'bar.md', '# bar\n');
        put(root, 'bar.md.bak', '# 上一代\n');
        const { call } = harness({ vault: root });

        const r = await call('notes:rename', { from: 'bar.md', to: 'Bar.md' });
        assert.equal(r.to, 'Bar.md');

        // 不许带 .md 过滤:要的正是"目录里到底有哪几个条目"。
        // 大小写不敏感卷上条目**只会以其中一个拼写存在**(NTFS/FAT 保留创建时的
        // 那个),所以断言"必须是 Bar.md.bak"会是一条与平台实现细节耦合的假断言;
        // 这里钉的是真正重要的两条:`.bak` 还在,且它是新名字的那一份。
        const entries = fs.readdirSync(root);
        assert.equal(entries.length, 2, `.bak 必须留在库里(实测目录:${entries.join(' | ')})`);
        assert.ok(entries.includes('Bar.md'), `笔记必须是 Bar.md(实测目录:${entries.join(' | ')})`);
        const bak = entries.find(f => f.toLowerCase() === 'bar.md.bak' && f !== 'Bar.md');
        assert.ok(bak !== undefined, `找不到新名字对应的 .bak(实测目录:${entries.join(' | ')})`);
        assert.equal(fs.readFileSync(path.join(root, bak), 'utf8'), '# 上一代\n',
            '备份里必须仍是改名之前那一代内容');
        assert.equal(fs.readFileSync(path.join(root, 'Bar.md'), 'utf8'), '# bar\n');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('setTitle 只改大小写时 .bak 也要活下来,并且是新旧那两代各一份(N1)', { skip: !isCaseInsensitiveFs() && '大小写敏感的文件系统上复现不了这条缺陷' }, async () => {
    // setTitle 这条路上 .bak 是**刚被 writeNote 按旧名字写出来**的
    // (改文件名的同时要先把正文 H1 改掉),紧接着 moveNoteBackup 就把它删了 ——
    // 用户看到的是"标题改成功、备份没了",而丢掉的正是这一代。
    const { base, root } = tmpVault('caseonly-title-bak');
    try {
        put(root, 'bar.md', '# bar\n');
        const { call } = harness({ vault: root });

        const r = await call('notes:setTitle', { path: 'bar.md', title: 'Bar' });
        assert.equal(r.to, 'Bar.md');
        assert.equal(fs.readFileSync(path.join(root, 'Bar.md'), 'utf8'), '# Bar\n');

        const entries = fs.readdirSync(root);
        assert.equal(entries.length, 2, `.bak 必须留在库里(实测目录:${entries.join(' | ')})`);
        assert.ok(entries.includes('Bar.md'), `笔记必须是 Bar.md(实测目录:${entries.join(' | ')})`);
        const bak = entries.find(f => f.toLowerCase() === 'bar.md.bak' && f !== 'Bar.md');
        assert.ok(bak !== undefined, `找不到新名字对应的 .bak(实测目录:${entries.join(' | ')})`);
        assert.equal(fs.readFileSync(path.join(root, bak), 'utf8'), '# bar\n',
            '备份里必须是改名之前的那一代(H1 还是旧的 bar)');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- notes:create 也必须过同一套标题规则(N2) ----------
//
// 上一次修复只把 sanitizeTitle 接到了 notes:setTitle 上,create 这条入口漏了。
// 它是**用户可达**的:点笔记里没写过的 [[…]] 链接 → notes-view 的 createNamed()
// → notes:create,名字直接来自用户笔记里的文本。

test('notes:create 也挡超长标题,并且消息里不许出现绝对路径(N2)', async () => {
    const { base, root } = tmpVault('create-toolong');
    try {
        const { call } = harness({ vault: root });

        for (const name of ['z'.repeat(300), '甲'.repeat(300)]) {
            const err = await call('notes:create', { path: `${name}.md` }).then(() => null, e => e);
            assert.ok(err instanceof Error, '超长标题必须被当场拒绝,而不是交给 fs 去炸');
            assert.match(err.message, /100/, '消息要说清上限是多少');
            // 旧行为:createNote 直接把名字交给 fs,ENOENT 的原文里带着
            // C:\Users\…\AppData\Local\Temp\… 那条绝对路径,经全局包装原样递回渲染进程。
            assert.equal(err.message.includes(root), false, `消息泄露了笔记库绝对路径:${err.message}`);
            assert.equal(err.message.includes(base), false, `消息泄露了临时目录绝对路径:${err.message}`);
        }

        // 边界:正好 100 字必须能过(否则"上限 100"是假的)
        const okTitle = '甲'.repeat(100);
        const ok = await call('notes:create', { path: `${okTitle}.md`, text: '# 边界\n' });
        assert.equal(ok.path, `${okTitle}.md`);
        assert.equal(fs.existsSync(path.join(root, `${okTitle}.md`)), true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:create 也挡 Windows 保留设备名(N2)', async () => {
    const { base, root } = tmpVault('create-reserved');
    try {
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:create', { path: 'CON.md' }), /设备名/);
        await assert.rejects(() => call('notes:create', { path: 'con.txt.md' }), /设备名/);
        assert.deepEqual(fs.readdirSync(root), [], '拒绝必须发生在动盘之前');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:create 的 fs 错误也过 sanitizeFsError:消息里只留 <笔记库>,code 保留', async () => {
    const { base, root } = tmpVault('create-sanitize');
    try {
        const { call } = harness({ vault: root });
        put(root, 'b.md', '文件');
        // 把文件当目录用 → 一条真会炸的 fs 路径(mkdir 在文件上)
        const err = await call('notes:create', { path: 'b.md/x.md' }).then(() => null, e => e);
        assert.ok(err instanceof Error, '必须报错,而不是看起来成功了');
        assert.equal(err.message.includes(root), false, `消息泄露了笔记库绝对路径:${err.message}`);
        assert.match(err.message, /<笔记库>/, '库根必须被换成占位符');
        assert.ok(typeof err.code === 'string' && err.code !== '', '诊断用的 code 必须保留');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:create 的合法标题与子目录不受影响', async () => {
    const { base, root } = tmpVault('create-ok');
    try {
        const { call } = harness({ vault: root });
        await call('notes:create', { path: '普通标题.md', text: '# 甲\n' });
        await call('notes:create', { path: '子/目录笔记.md', text: '# 乙\n' });
        assert.equal(fs.readFileSync(path.join(root, '普通标题.md'), 'utf8'), '# 甲\n');
        assert.equal(fs.readFileSync(path.join(root, '子', '目录笔记.md'), 'utf8'), '# 乙\n');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- 清理 ----------

test('dispose 注销所有频道', async () => {
    const { handlers, api } = harness();
    assert.ok(handlers.size > 0);
    api.dispose();
    assert.equal(handlers.size, 0);
});

// ---------- 新建文件夹 + 树状目录的索引数据 ----------
//
// 侧栏要按树展示,而**空文件夹在笔记清单里根本不出现** —— 索引不把目录一起返回,
// 用户刚建的那个文件夹就看不见(看着像"没建成")。这里钉住"索引里有 folders"。

test('notes:mkdir 建出目录,并且笔记清单一并返回它(空目录也要在)', async () => {
    const { base, root } = tmpVault('mkdir');
    try {
        put(root, '甲.md', '# 甲\n');
        const { call } = harness({ vault: root });

        const r = await call('notes:mkdir', { path: '项目' });
        assert.equal(r.path, '项目');
        assert.equal(fs.existsSync(path.join(root, '项目')), true);

        const idx = await call('notes:index');
        assert.deepEqual(idx.folders, ['项目'], '空目录必须出现在 folders 里');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:mkdir 已存在时报错,且不会把已有目录动掉', async () => {
    const { base, root } = tmpVault('mkdir2');
    try {
        fs.mkdirSync(path.join(root, '项目'));
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:mkdir', { path: '项目' }), /已存在/);
        assert.equal(fs.existsSync(path.join(root, '项目')), true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:mkdir 拒绝非法名字(分隔符/保留设备名/超长),且一个字都不写盘', async () => {
    const { base, root } = tmpVault('mkdir3');
    try {
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:mkdir', { path: 'a/b' }), /文件夹名/);
        await assert.rejects(() => call('notes:mkdir', { path: 'CON' }), /设备名/);
        await assert.rejects(() => call('notes:mkdir', { path: 'x'.repeat(101) }), /太长/);
        await assert.rejects(() => call('notes:mkdir', { path: '   ' }), /文件夹名/);
        assert.deepEqual(fs.readdirSync(root), [], '被拒的请求不许留下任何东西');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:mkdir 不能借名字把目录建到库外(分隔符一律拒)', async () => {
    const { base, root } = tmpVault('mkdir4');
    try {
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:mkdir', { path: '../逃逸' }), /文件夹名/);
        assert.equal(fs.existsSync(path.join(base, '逃逸')), false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:index 的 folders 覆盖多级目录(树要按它拼层级)', async () => {
    const { base, root } = tmpVault('mkdir5');
    try {
        put(root, '阅读/2026/一月.md', '# 一月\n');
        fs.mkdirSync(path.join(root, '阅读', '空目录'));
        const { call } = harness({ vault: root });
        const idx = await call('notes:index');
        assert.deepEqual(idx.folders, ['阅读', '阅读/2026', '阅读/空目录']);
        assert.deepEqual(idx.notes.map(n => n.path), ['阅读/2026/一月.md']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- notes:move:拖放的落点(任意文件 / 目录) ----------
//
// 为什么单开一条而不用 notes:rename:rename 的守卫是 isNotePath(只放 .md),
// 而"拖文件进文件夹"要挪的是 png / docx / json / txt,还有**整个目录**。
// 这几条用例守的就是那个放宽 —— 以及放宽之后必须补上的两道防线。

test('move:非笔记文件也能移动(图片/文档/json/txt)', async () => {
    const { base, root } = tmpVault('move-any');
    try {
        put(root, 'shots/one.png', 'PNGDATA');
        put(root, 'a.txt', 'hello');
        put(root, 'g.json', '{}');
        const { call } = harness({ vault: root });

        const r1 = await call('notes:move', { from: 'shots/one.png', to: '归档/one.png' });
        assert.equal(r1.moved, true);
        assert.equal(fs.existsSync(path.join(root, '归档/one.png')), true, '目标要真的在');
        assert.equal(fs.existsSync(path.join(root, 'shots/one.png')), false, '源要真的没了');
        assert.equal(fs.readFileSync(path.join(root, '归档/one.png'), 'utf8'), 'PNGDATA', '内容一个字节都不许变');

        await call('notes:move', { from: 'a.txt', to: '归档/a.txt' });
        await call('notes:move', { from: 'g.json', to: '归档/g.json' });
        assert.deepEqual(fs.readdirSync(path.join(root, '归档')).sort(), ['a.txt', 'g.json', 'one.png']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('move:整个目录能移动,子树跟着走', async () => {
    const { base, root } = tmpVault('move-dir');
    try {
        put(root, '短剧/第3集/shots/a.png', 'A');
        put(root, '短剧/第3集/shots/b.png', 'B');
        put(root, '短剧/第3集/graph.json', '{}');
        const { call } = harness({ vault: root });

        const r = await call('notes:move', { from: '短剧/第3集/shots', to: '归档/shots' });
        assert.equal(r.moved, true);
        assert.equal(r.isDir, true);
        assert.equal(fs.existsSync(path.join(root, '归档/shots/a.png')), true);
        assert.equal(fs.existsSync(path.join(root, '归档/shots/b.png')), true);
        assert.equal(fs.existsSync(path.join(root, '短剧/第3集/shots')), false, '旧目录要整个消失');
        assert.equal(fs.existsSync(path.join(root, '短剧/第3集/graph.json')), true, '兄弟节点不许被带走');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('move:★ 不能把目录移进它自己的子孙(那是个环)', async () => {
    const { base, root } = tmpVault('move-cycle');
    try {
        put(root, 'a/b/c/x.md', '# x');
        const { call } = harness({ vault: root });

        // 直接子孙
        await assert.rejects(() => call('notes:move', { from: 'a', to: 'a/b/inner' }),
            /不能把文件夹移动到它自己的子文件夹里/);
        // 更深一层
        await assert.rejects(() => call('notes:move', { from: 'a', to: 'a/b/c/deep' }),
            /不能把文件夹移动到它自己的子文件夹里/);
        // 自己 → 自己:走最前面的**空操作**分支(moved:false),不是错误 ——
        // 界面本来就不会让用户这么拖,而后端把它当"什么都没要求做"更自然。
        const same = await call('notes:move', { from: 'a', to: 'a' });
        assert.equal(same.moved, false, '同一个路径应当是空操作');
        // 盘上必须一点没动
        assert.equal(fs.existsSync(path.join(root, 'a/b/c/x.md')), true);
        assert.equal(fs.existsSync(path.join(root, 'a/b/inner')), false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('move:目标已存在 → 拒绝,而且两边都不许被改', async () => {
    const { base, root } = tmpVault('move-conflict');
    try {
        put(root, 'a.md', 'AAA');
        put(root, 'dir/a.md', 'BBB');
        const { call } = harness({ vault: root });

        await assert.rejects(() => call('notes:move', { from: 'a.md', to: 'dir/a.md' }),
            /目标已存在/);
        assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'AAA', '源没被改');
        assert.equal(fs.readFileSync(path.join(root, 'dir/a.md'), 'utf8'), 'BBB', '目标没被覆盖');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('move:自己 → 自己 是空操作(不是错误)', async () => {
    const { base, root } = tmpVault('move-self');
    try {
        put(root, 'a.md', 'A');
        const { call } = harness({ vault: root });
        const r = await call('notes:move', { from: 'a.md', to: 'a.md' });
        assert.equal(r.moved, false);
        assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'A');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('move:源不存在 → 报"找不到"(而不是一句含绝对路径的 ENOENT)', async () => {
    const { base, root } = tmpVault('move-missing');
    try {
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:move', { from: 'nope.png', to: 'x/nope.png' }),
            /找不到:nope.png/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('move:路径越界一律拒(../ 与绝对路径)', async () => {
    const { base, root } = tmpVault('move-escape');
    try {
        put(root, 'a.md', 'A');
        const { call } = harness({ vault: root });
        await assert.rejects(() => call('notes:move', { from: '../outside.md', to: 'a.md' }));
        await assert.rejects(() => call('notes:move', { from: 'a.md', to: '../outside.md' }));
        await assert.rejects(() => call('notes:move', { from: path.join(base, 'x'), to: 'a.md' }));
        await assert.rejects(() => call('notes:move', { from: '', to: 'a.md' }), /from 必填/);
        await assert.rejects(() => call('notes:move', { from: 'a.md', to: '' }), /to 必填/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('move:笔记的 .bak 跟着走(与 rename 同一口径)', async () => {
    const { base, root } = tmpVault('move-bak');
    try {
        put(root, 'a.md', '# A');
        const { call } = harness({ vault: root });
        // 先写一次制造 .bak,再移动
        await call('notes:write', { path: 'a.md', text: '# A2' });
        const hadBak = fs.existsSync(path.join(root, 'a.md.bak'));
        await call('notes:move', { from: 'a.md', to: 'dir/a.md' });
        assert.equal(fs.existsSync(path.join(root, 'dir/a.md')), true);
        if (hadBak) {
            assert.equal(fs.existsSync(path.join(root, 'a.md.bak')), false, '旧名字下不该留下 .bak');
            assert.equal(fs.existsSync(path.join(root, 'dir/a.md.bak')), true, '.bak 要跟到新位置');
        }
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- notes:openPath:用系统程序打开非笔记文件 ----------
//
// 这是**新开的一条"打开文件"通道**,所以它的边界必须被钉死:
// 渲染进程只能递**相对路径**,越界一律拒 —— 否则就等于让页面打开任意本地文件。

test('openPath:只接受库内相对路径,并把绝对路径交给 shell(带守卫)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-openpath-'));
    try {
        const root = path.join(base, 'vault');
        fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
        fs.writeFileSync(path.join(root, 'shots', 'a.png'), 'PNG');

        const opened = [];
        const handlers = new Map();
        const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
        const settings = { get: (ns, k) => (k === 'lastVault' ? root : undefined), set: () => {} };
        registerNotesIpc({
            ipcMain,
            dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
            settings,
            getWindow: () => null,
            shell: { openPath: async (p) => { opened.push(p); return ''; } },
        });
        const call = (c, p) => handlers.get(c)(null, p);

        const r = await call('notes:openPath', { path: 'shots/a.png' });
        assert.equal(r.ok, true);
        assert.equal(opened.length, 1);
        assert.equal(opened[0], fs.realpathSync(path.join(root, 'shots', 'a.png')), '交给 shell 的是解析过的绝对路径');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('openPath:越界、空路径、不存在的文件一律拒', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-openpath-deny-'));
    try {
        const root = path.join(base, 'vault');
        fs.mkdirSync(root, { recursive: true });
        const handlers = new Map();
        const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
        const settings = { get: (ns, k) => (k === 'lastVault' ? root : undefined), set: () => {} };
        registerNotesIpc({
            ipcMain,
            dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
            settings,
            getWindow: () => null,
            shell: { openPath: async () => '' },
        });
        const call = (c, p) => handlers.get(c)(null, p);

        await assert.rejects(() => call('notes:openPath', { path: '../outside.png' }));
        await assert.rejects(() => call('notes:openPath', { path: path.join(base, 'x.png') }));
        await assert.rejects(() => call('notes:openPath', { path: '' }), /path 必填/);
        await assert.rejects(() => call('notes:openPath', { path: 'nope.png' }), /找不到/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('openPath:shell 报告失败(没有关联程序)时转成异常,让界面能提示原因', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-openpath-fail-'));
    try {
        const root = path.join(base, 'vault');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'a.weird'), 'x');
        const handlers = new Map();
        const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
        const settings = { get: (ns, k) => (k === 'lastVault' ? root : undefined), set: () => {} };
        registerNotesIpc({
            ipcMain,
            dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
            settings,
            getWindow: () => null,
            shell: { openPath: async () => '没有关联的应用' },
        });
        const call = (c, p) => handlers.get(c)(null, p);
        await assert.rejects(() => call('notes:openPath', { path: 'a.weird' }), /没有关联的应用/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- notes:remove:删除一篇笔记(进系统回收站) ----------
//
// 这是**一条会把用户真实资产挪走的通道**,所以它的边界与"到底把什么交了出去"
// 必须被钉死在纯 Node 里 —— 真删真库是绝对不许发生的事。做法:
//   · trash 注入一个**只记账、不碰盘**的假实现(生产默认是 Electron 的
//     shell.trashItem,单测里根本没有 shell);
//   · 断言它收到的**绝对路径**(而不是渲染层递进来的相对路径);
//   · 断言越界 / 非 .md / 不存在的目标在**调用 trash 之前**就被拒掉。
//
// ⚠️ 这些用例一个字节都不许动真实笔记库:所有库都是 os.tmpdir() 下现建现删的,
//    而且 trash 是假的 —— 文件在断言里仍然躺在临时库里。

/** 记账用的假回收站:只记下被调用的绝对路径。 */
function fakeTrash({ failOn = null, message = '被占用' } = {}) {
    const called = [];
    const trash = async (abs) => {
        called.push(abs);
        if (failOn !== null && String(abs).endsWith(failOn)) throw new Error(message);
    };
    return { called, trash };
}

test('remove:把笔记与它的 .bak 都交给回收站,收到的是解析过的绝对路径', async () => {
    const { base, root } = tmpVault('remove');
    try {
        put(root, '子/甲.md', '# 甲\n');
        put(root, '子/甲.md.bak', '# 甲的上一代\n');

        const { called, trash } = fakeTrash();
        const { call } = harness({ vault: root, trash });

        const r = await call('notes:remove', { path: '子/甲.md' });

        assert.equal(called.length, 2, '.bak 必须一起进回收站,否则库里留下一份看不见的全文');
        assert.equal(called[0], fs.realpathSync(path.join(root, '子', '甲.md')),
            '交给回收站的是主进程解析出来的**绝对路径**,不是渲染层递进来的相对路径');
        assert.equal(called[1], `${fs.realpathSync(path.join(root, '子', '甲.md'))}.bak`,
            '.bak 的路径由主进程按同一个相对路径算出来,渲染层说不出第二个路径');
        assert.deepEqual(r.trashed, ['子/甲.md', '子/甲.md.bak'], '回执里说清都挪走了哪几条');
        assert.equal(r.warning, null);
        // 假 trash 不碰盘:临时库里的文件当然还都在(用例自己也不许真删)
        assert.ok(fs.existsSync(path.join(root, '子', '甲.md')));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('remove:没有 .bak 时只挪一件(绝大多数笔记根本没改过)', async () => {
    const { base, root } = tmpVault('remove-nobak');
    try {
        put(root, '甲.md', '# 甲\n');
        const { called, trash } = fakeTrash();
        const { call } = harness({ vault: root, trash });

        const r = await call('notes:remove', { path: '甲.md' });

        assert.equal(called.length, 1);
        assert.deepEqual(r.trashed, ['甲.md']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('remove:只收库内 .md —— 越界、非 .md、绝对路径、目标不存在都在动 trash 之前拒掉', async () => {
    const { base, root } = tmpVault('remove-deny');
    try {
        put(root, '甲.md', '# 甲\n');
        put(root, '纯文本.txt', 'x');
        put(root, '图.png', 'x');

        const { called, trash } = fakeTrash();
        const { call } = harness({ vault: root, trash });

        // 越界(../ 与绝对路径)
        await assert.rejects(() => call('notes:remove', { path: '../外面.md' }), /越出笔记库/);
        await assert.rejects(() => call('notes:remove', { path: path.join(base, '外面.md') }), /越出笔记库/);
        // 非 .md:这条通道的菜单只出现在 Markdown 笔记行上,但通道自己也要挡
        await assert.rejects(() => call('notes:remove', { path: '纯文本.txt' }), /只允许删除 \.md 笔记/);
        await assert.rejects(() => call('notes:remove', { path: '图.png' }), /只允许删除 \.md 笔记/);
        await assert.rejects(() => call('notes:remove', { path: '' }), /只允许删除 \.md 笔记/);
        await assert.rejects(() => call('notes:remove', {}), /只允许删除 \.md 笔记/);
        // 目标不存在:一句人话,不是带用户机器绝对路径的 fs 原文
        await assert.rejects(() => call('notes:remove', { path: '没有这篇.md' }), /找不到这篇笔记/);
        // 文件夹也不行(不能靠改个名字就让回收站收走一整棵目录)
        fs.mkdirSync(path.join(root, '目录.md'));
        await assert.rejects(() => call('notes:remove', { path: '目录.md' }), /不是一个文件/);

        assert.deepEqual(called, [], '被拒的每一次都不许碰到回收站');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- 系统回收站不可用时的回落:库内 .trash ----------
//
// 2026-09-29 用户报「点击删除笔记或文件夹后无效」。根因与这些分支的逻辑无关:
// **他的库在 E 盘,而 E 是 FAT32 可移动盘 —— 那个卷上没有回收站**,
// `shell.trashItem` 直接失败(真机实测:`Failed to perform delete operation`),
// 于是"删除"整条路静默失败(界面只会看到状态行一句失败,而那句话还可能被后写的
// 「上次修改:…」盖掉 —— 于是用户的感觉就是"点了没反应")。
//
// 对策**不是**退化成永久删除(右键一点就中的手势不该有不可逆的结果),而是搬到
// 库内的 `.trash/<时间戳>/<原相对路径>` —— 可恢复这条保证在任何文件系统上都成立。
// 下面几条用一个"必定失败"的 trash 把那个环境搬进单测:替身不比真机含糊。

test('★ 回收站不可用(如 FAT32 可移动盘)时:笔记与它的 .bak 都挪进库内 .trash,内容一字不差', async () => {
    const { base, root } = tmpVault('vault-trash');
    try {
        put(root, '子/甲.md', '# 甲\n');
        put(root, '子/甲.md.bak', '# 上一代\n');
        const trash = async () => { throw new Error('Failed to perform delete operation'); };
        const { call } = harness({ vault: root, trash });

        const r = await call('notes:remove', { path: '子/甲.md' });

        assert.equal(r.mode, 'vault', '这个卷没有回收站 → 走库内 .trash');
        assert.match(String(r.to), /^\.trash\/\d{4}-\d{2}-\d{2}-\d{6}\/子\/甲\.md$/,
            '回执要说清"挪到哪了"(界面靠它告诉用户东西在哪,否则用户只会觉得"删了但没删掉")');
        assert.equal(fs.existsSync(path.join(root, '子', '甲.md')), false, '原位置必须没了');
        assert.equal(fs.readFileSync(path.join(root, r.to), 'utf8'), '# 甲\n', '内容可恢复');
        assert.equal(fs.existsSync(path.join(root, '子', '甲.md.bak')), false, '.bak 一起挪走');
        assert.deepEqual(r.trashed, ['子/甲.md', '子/甲.md.bak']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('★ 两条路都走不通时才报失败 —— 绝不"假装删了"', async () => {
    const { base, root } = tmpVault('vault-trash-broken');
    try {
        put(root, '甲.md', '# 甲\n');
        // 把库内回收站的位置占成一个**文件**:`.trash/<时间戳>/…` 那个目录就建不出来
        fs.writeFileSync(path.join(root, VAULT_TRASH_DIR), 'x');
        const trash = async () => { throw new Error('Failed to perform delete operation'); };
        const { call } = harness({ vault: root, trash });

        await assert.rejects(() => call('notes:remove', { path: '甲.md' }), /删除失败/);
        assert.ok(fs.existsSync(path.join(root, '甲.md')), '报失败时文件必须原地还在');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('★ 没有 trash 能力的环境(纯 Node)也能删 —— 落库内 .trash,而不是"这个环境不支持"', async () => {
    // 口径变更说明:从前这里是"环境不支持就报错",而后果是**整个删除功能在那种卷上不可用**。
    // 库内 .trash 不依赖任何系统能力,所以改成照删。
    const { base, root } = tmpVault('vault-trash-nocap');
    try {
        put(root, '甲.md', '# 甲\n');
        const { call } = harness({ vault: root });

        const r = await call('notes:remove', { path: '甲.md' });

        assert.equal(r.mode, 'vault');
        assert.equal(fs.existsSync(path.join(root, '甲.md')), false);
        assert.ok(fs.existsSync(path.join(root, r.to)), '东西在 .trash 里');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('volumeHasRecycleBin 按**卷根**判(真机读数:C 盘 true / E 盘 false)', () => {
    const seen = [];
    const spy = (p) => { seen.push(p); return false; };
    assert.equal(volumeHasRecycleBin('E:\\仓库\\子\\甲.md', spy), false);
    assert.equal(seen[0], path.join('E:\\', '$Recycle.Bin'), '看的是卷根的 $Recycle.Bin');
    assert.equal(volumeHasRecycleBin('C:\\Users\\x', () => true), true, '有就回 true');
    // 判断本身探不动时当"没有"(于是走库内 .trash),而不是把删除整个炸掉
    assert.equal(volumeHasRecycleBin('C:\\x', () => { throw new Error('探不动'); }), false);
});

// ---------- notes:removeDir:删一个文件夹(进系统回收站) ----------
//
// 与 notes:remove 的差别全在"守什么":那条只收 `.md` **文件**(菜单只长在笔记行上),
// 这条收的是**目录** —— 于是多了两条必须挡死的东西:
//   · **库根本身**:一次误点该只丢一个文件夹,而不是整个笔记库;
//   · 不是目录的目标(一条 `.md` 得走 remove,不能从这条溜过去)。
// 另外它要回报"带走了多少":删文件夹是这一列表里代价最大的一下,界面上要说得出读数。

test('removeDir:整个文件夹(含子目录里的文件)一次性交给回收站,并回报带走了多少', async () => {
    const { base, root } = tmpVault('rmdir');
    try {
        put(root, '短剧/第1集/甲.md', '# 甲\n');
        put(root, '短剧/第1集/乙.md', '# 乙\n');
        put(root, '短剧/第1集/素材/图.png', 'x');
        put(root, '短剧/第2集/丙.md', '# 丙\n');

        const { called, trash } = fakeTrash();
        const { call } = harness({ vault: root, trash });

        const r = await call('notes:removeDir', { path: '短剧/第1集' });

        assert.equal(called.length, 1, '整个目录一次交给回收站(不是一个文件一次)');
        assert.equal(called[0], path.join(root, '短剧', '第1集'),
            '交给回收站的是主进程解析出来的**绝对路径**,不是渲染层递进来的相对路径');
        assert.equal(r.path, '短剧/第1集');
        assert.equal(r.files, 3, '连子目录里的文件一起数');
        assert.equal(r.notes, 2, '其中两篇是 .md');
        // 假 trash 不碰盘:临时库里的东西都还在(用例自己也不许真删)
        assert.ok(fs.existsSync(path.join(root, '短剧', '第1集', '甲.md')));
        assert.ok(fs.existsSync(path.join(root, '短剧', '第2集', '丙.md')), '兄弟目录一个字节都不许动');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('removeDir:空文件夹也照删,回执说 0 个文件(界面据此显示"空的")', async () => {
    const { base, root } = tmpVault('rmdir-empty');
    try {
        fs.mkdirSync(path.join(root, '空目录'), { recursive: true });
        const { called, trash } = fakeTrash();
        const { call } = harness({ vault: root, trash });

        const r = await call('notes:removeDir', { path: '空目录' });
        assert.equal(called.length, 1);
        assert.deepEqual([r.files, r.notes], [0, 0]);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('removeDir:库根、非目录、不存在、越界 —— 四条都在碰回收站之前拒掉', async () => {
    const { base, root } = tmpVault('rmdir-refuse');
    try {
        put(root, '子/甲.md', '# 甲\n');
        put(root, '甲.md', '# 甲\n');
        const { called, trash } = fakeTrash();
        const { call } = harness({ vault: root, trash });

        // ⚠️ 库根本身:这是这条通道最要紧的一道闸
        for (const p of ['', '.', './', '/', '子/..']) {
            await assert.rejects(() => call('notes:removeDir', { path: p }),
                /哪一个文件夹|不能删笔记库根本身|越出笔记库/, `库根写法「${p}」必须被拒`);
        }
        await assert.rejects(() => call('notes:removeDir', { path: '../外面' }), /越出笔记库/);
        await assert.rejects(() => call('notes:removeDir', { path: '甲.md' }), /不是一个文件夹/,
            '一篇笔记要走 notes:remove,不能从这条溜过去');
        await assert.rejects(() => call('notes:removeDir', { path: '子/没有这个' }), /找不到这个文件夹/);

        assert.deepEqual(called, [], '被拒的每一次都不许碰到回收站');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('★ removeDir:回收站不可用时整个文件夹挪进库内 .trash(计数与落点都回报)', async () => {
    const { base, root } = tmpVault('rmdir-vault-trash');
    try {
        put(root, '子/甲.md', '# 甲\n');
        put(root, '子/深/乙.md', '# 乙\n');
        const trash = async () => { throw new Error('Failed to perform delete operation'); };
        const { call } = harness({ vault: root, trash });

        const r = await call('notes:removeDir', { path: '子' });

        assert.equal(r.mode, 'vault');
        assert.match(String(r.to), /^\.trash\/\d{4}-\d{2}-\d{2}-\d{6}\/子$/);
        assert.deepEqual([r.files, r.notes], [2, 2], '计数照旧(界面那句"含 N 个文件"靠它)');
        assert.equal(fs.existsSync(path.join(root, '子')), false, '原目录必须没了');
        assert.equal(fs.readFileSync(path.join(root, r.to, '深', '乙.md'), 'utf8'), '# 乙\n',
            '整棵子树都在 .trash 里,可以自己捞回来');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('★ removeDir:两条路都走不通时才报失败,目录原样还在', async () => {
    const { base, root } = tmpVault('rmdir-vault-broken');
    try {
        put(root, '子/甲.md', '# 甲\n');
        fs.writeFileSync(path.join(root, VAULT_TRASH_DIR), 'x');
        const trash = async () => { throw new Error('Failed to perform delete operation'); };
        const { call } = harness({ vault: root, trash });

        await assert.rejects(() => call('notes:removeDir', { path: '子' }), /删除失败/);
        assert.ok(fs.existsSync(path.join(root, '子', '甲.md')), '失败时目录必须原地还在');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('★ removeDir:没有 trash 能力的环境(纯 Node)也能删 —— 落库内 .trash', async () => {
    const { base, root } = tmpVault('rmdir-nocap');
    try {
        put(root, '子/甲.md', '# 甲\n');
        const { call } = harness({ vault: root });

        const r = await call('notes:removeDir', { path: '子' });

        assert.equal(r.mode, 'vault');
        assert.equal(fs.existsSync(path.join(root, '子')), false);
        assert.ok(fs.existsSync(path.join(root, r.to, '甲.md')));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- .md 的有损改写:三条会写盘的通道都要挡住 ----------
//
// `notes:read` / `notes:write` 之外,还有两条**自己读原文再写回去**的通道:
// `notes:setTitle`(改文件名 + 换正文 H1)与 `notes:replaceFrontmatter`(只换元数据)。
// 它们从前都是 `readFile(abs,'utf8')` —— 也就是说:一篇含非法字节的 .md,
// 只要用户改一次标题,那一次有损解码的结果就被写回磁盘了。
// 下面这条把三条通道一起钉住,而判据只有一个:**磁盘字节逐字节不变**。

test('解不开的 .md:改标题 / 换 frontmatter 都不许有损改写(磁盘字节必须逐字节不变)', async () => {
    const { base, root } = tmpVault('ipc-illegal-md');
    try {
        const abs = path.join(root, '坏字节.md');
        // "标题" 用合法 UTF-8,后面接一段既非合法 UTF-8、也非 GB18030 的字节
        fs.writeFileSync(abs, Buffer.concat([
            Buffer.from('---\ntitle: 旧\n---\n# 旧标题\n\n正文\n', 'utf8'),
            Buffer.from([0xff, 0x80]),
        ]));
        const before = [...fs.readFileSync(abs)];
        const { call } = harness({ vault: root });

        await assert.rejects(() => call('notes:setTitle', { path: '坏字节.md', title: '新标题' }),
            /不是能安全打开的文本文件|不能保存/);
        await assert.rejects(
            () => call('notes:replaceFrontmatter', { path: '坏字节.md', data: { title: '元数据新' } }),
            /不是能安全打开的文本文件|不能保存/);

        assert.deepEqual([...fs.readFileSync(abs)], before,
            '核心断言:这两条通道读到的必须仍是"解不开",绝不许把替换过的文本写回去');
        // 拒绝要发生在**动盘之前**:连改名都不许发生,备份也不许留
        assert.equal(fs.existsSync(path.join(root, '新标题.md')), false, '不许改出半个名字');
        assert.deepEqual(fs.readdirSync(root), ['坏字节.md'], '拒绝就是什么都没做');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('notes:index 把"打不开"的 .md 如实标出来(列表能一眼看出,而不是点开才发现)', async () => {
    const { base, root } = tmpVault('ipc-index-unreadable');
    try {
        put(root, '好.md', '# 好的\n');
        fs.writeFileSync(path.join(root, '坏.md'),
            Buffer.concat([Buffer.from('# 坏\n', 'utf8'), Buffer.from([0x00])]));
        const { call } = harness({ vault: root });

        const idx = await call('notes:index');
        const broken = idx.notes.find(n => n.path === '坏.md');
        const good = idx.notes.find(n => n.path === '好.md');

        assert.equal(good.readable, true);
        assert.equal(broken.readable, false, '渲染层靠这个字段给那一行挂「打不开」小标');
        assert.ok(String(broken.reason).length > 0, '原因也要递到界面上(状态行要说人话)');
        // 只递叶子字段:不许把整篇正文塞进列表
        assert.equal(Object.prototype.hasOwnProperty.call(broken, 'body'), false,
            '列表项只带界面要用的字段 —— 正文不进列表(既有口径不变)');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
