import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    resolveInside, resolveInsideReal, relativeToVault, isNotePath, listNoteFiles, listVaultTree,
} from '../app/lib/vault-path.js';

// Vault 的路径约束是笔记子系统的安全边界,标准与内核的 toolbox:// 守卫一致。

function tmpVault(label) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `kaiwu-vault-${label}-`));
    const root = path.join(base, 'vault');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), '# 秘密');
    return { base, root, outside };
}

// ---------- 词法层 ----------

test('正常相对路径解析到 Vault 之内', () => {
    const r = path.resolve('C:/vault');
    assert.equal(resolveInside(r, 'a/b.md'), path.join(r, 'a', 'b.md'));
});

test('反斜杠写法同样解析正确', () => {
    const r = path.resolve('C:/vault');
    assert.equal(resolveInside(r, 'a\\b.md'), path.join(r, 'a', 'b.md'));
});

test('.. 穿越被拒绝', () => {
    assert.equal(resolveInside('C:/vault', '../secrets.md'), null);
});

test('多层 .. 穿越被拒绝', () => {
    assert.equal(resolveInside('C:/vault', '../../Windows/win.ini'), null);
});

test('编码过的穿越同样被拒绝', () => {
    assert.equal(resolveInside('C:/vault', '..%2fsecrets.md'), null);
});

test('绝对路径被拒绝', () => {
    assert.equal(resolveInside('C:/vault', 'C:/Windows/win.ini'), null);
    assert.equal(resolveInside('C:/vault', '/etc/passwd'), null);
});

test('UNC 路径被拒绝', () => {
    assert.equal(resolveInside('C:/vault', '\\\\server\\share\\x.md'), null);
});

test('空前缀相同但不是子目录的路径被拒绝', () => {
    // vault-evil 以 vault 开头,但不是它的子目录
    assert.equal(resolveInside('C:/vault', '../vault-evil/x.md'), null);
});

test('Vault 根自身被接受', () => {
    assert.equal(resolveInside('C:/vault', '.'), path.resolve('C:/vault'));
});

test('空路径与非字符串被拒绝', () => {
    assert.equal(resolveInside('C:/vault', ''), null);
    assert.equal(resolveInside('C:/vault', null), null);
    assert.equal(resolveInside('C:/vault', undefined), null);
});

// ---------- 真实路径层 ----------

test('经目录联接逃出 Vault 被拒绝', () => {
    const { base, root, outside } = tmpVault('junction');
    try {
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');

        // 先确认真实现场成立:词法层放行,文件也真的存在
        const lexical = resolveInside(root, 'escape/secret.md');
        assert.notEqual(lexical, null, '词法层应当放行 —— 所以光靠它不够');
        assert.equal(fs.statSync(lexical).isFile(), true);

        assert.equal(resolveInsideReal(root, 'escape/secret.md'), null);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('Vault 内的真实文件被接受', () => {
    const { base, root } = tmpVault('inside');
    try {
        fs.writeFileSync(path.join(root, 'ok.md'), '# ok');
        assert.notEqual(resolveInsideReal(root, 'ok.md'), null);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('不存在的新笔记路径被接受(新建时要能算出来)', () => {
    const { base, root } = tmpVault('new');
    try {
        // 这是关键:新建笔记时文件还不存在,不能因此判定越界
        const p = resolveInsideReal(root, '子目录/新笔记.md');
        assert.notEqual(p, null, '不存在的路径也要能解析 —— 否则没法新建笔记');
        assert.ok(p.endsWith('新笔记.md'));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('不存在的路径若其已存在祖先越界,同样被拒绝', () => {
    const { base, root, outside } = tmpVault('ancestor');
    try {
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
        // escape 本身在 Vault 内(词法),但它的真实位置在外部 ——
        // 连它下面的**不存在**文件也必须被拒
        assert.equal(resolveInsideReal(root, 'escape/还没建的.md'), null);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('Vault 不存在时返回 null', () => {
    assert.equal(resolveInsideReal(path.join(os.tmpdir(), 'kaiwu-__不存在__'), 'a.md'), null);
});

// ---------- relativeToVault ----------

test('相对路径换算', () => {
    const root = path.resolve('C:/vault');
    assert.equal(relativeToVault(root, path.join(root, 'a', 'b.md')), 'a/b.md');
});

test('Vault 之外返回 null', () => {
    const root = path.resolve('C:/vault');
    assert.equal(relativeToVault(root, path.resolve('C:/other/x.md')), null);
});

test('Vault 根自身返回 null(它不是某一篇笔记)', () => {
    const root = path.resolve('C:/vault');
    assert.equal(relativeToVault(root, root), null);
});

// ---------- isNotePath(家族门:读/写/改名) ----------

test('家族门认两种:.md 与 .txt,大小写不敏感', () => {
    assert.equal(isNotePath('a.md'), true);
    assert.equal(isNotePath('a.MD'), true);
    // ⚠️ 这一条**变了**(用户这一轮的决定:txt 可编辑):
    //    以前只认 .md,现在 .txt 也是家族成员 —— 于是"读/写/改名"三道门对它放开。
    //    而"参不参与 Markdown 语义"是另一问,由 isMarkdownPath 把关(它只认 .md)。
    assert.equal(isNotePath('a.txt'), true);
    assert.equal(isNotePath('a.TXT'), true);
    assert.equal(isNotePath('a.png'), false);
    assert.equal(isNotePath('a.docx'), false);
    assert.equal(isNotePath('md'), false);
    assert.equal(isNotePath(null), false);
});

// ---------- listNoteFiles ----------

test('列出所有 .md 并跳过隐藏目录与 node_modules', async () => {
    const { base, root } = tmpVault('list');
    try {
        fs.mkdirSync(path.join(root, '子目录'));
        fs.mkdirSync(path.join(root, '.obsidian'));
        fs.mkdirSync(path.join(root, 'node_modules'));
        fs.writeFileSync(path.join(root, 'a.md'), '# a');
        fs.writeFileSync(path.join(root, '子目录', 'b.md'), '# b');
        fs.writeFileSync(path.join(root, '子目录', 'c.txt'), 'x');
        fs.writeFileSync(path.join(root, '.obsidian', 'config.md'), 'x');
        fs.writeFileSync(path.join(root, 'node_modules', 'dep.md'), 'x');

        const list = await listNoteFiles(root);
        assert.deepEqual(list, ['a.md', '子目录/b.md'], '隐藏目录与 node_modules 要跳过');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('列出结果稳定排序,便于测试与展示', async () => {
    const { base, root } = tmpVault('sort');
    try {
        for (const n of ['c.md', 'a.md', 'b.md']) fs.writeFileSync(path.join(root, n), '# x');
        assert.deepEqual(await listNoteFiles(root), ['a.md', 'b.md', 'c.md']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('空 Vault 返回空数组', async () => {
    const { base, root } = tmpVault('empty');
    try {
        assert.deepEqual(await listNoteFiles(root), []);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('目录不存在时返回空数组而不是抛异常', async () => {
    assert.deepEqual(await listNoteFiles(path.join(os.tmpdir(), 'kaiwu-__没有这个目录__')), []);
});

// ---------- listVaultTree 的 texts / others:三类文件各归各的桶 ----------
//
// 为什么需要它:笔记树原来只列 .md,于是短剧项目里那 25 张 png、1 个 docx、
// 1 个 json **在树里根本看不见** —— 也就无从"拖进文件夹"。
//
// ⚠️ `.txt` 现在**不归 others**,而是单独一桶 `texts`:用户要的是"纯文本可编辑,
//    但和 Markdown 隔开"。放进 `files` 会跟着进链接图与标签(污染);留在 `others`
//    又只能丢给系统程序(不可编辑)。单独一桶让"隔开"由数据结构保证。

test('三类各归各的桶:md→files,txt→texts,其余→others,且都带 size 与 mtime', async () => {
    const { base, root } = tmpVault('others');
    try {
        fs.mkdirSync(path.join(root, 'shots'));
        fs.writeFileSync(path.join(root, 'a.md'), '# 笔记');
        fs.writeFileSync(path.join(root, 'shots', 'one.png'), 'x'.repeat(11));
        fs.writeFileSync(path.join(root, 'shots', 'two.txt'), 'yy');
        fs.writeFileSync(path.join(root, 'graph.json'), '{}');

        const { files, folders, texts, others } = await listVaultTree(root, { withStats: true });
        assert.deepEqual(files, ['a.md'], '笔记那一份的语义不能变');
        assert.deepEqual(folders, ['shots']);
        assert.deepEqual(texts.map(o => o.path), ['shots/two.txt'], 'txt 单独一桶,不进 others');
        assert.deepEqual(others.map(o => o.path), ['graph.json', 'shots/one.png'], 'others 里不再有 txt');
        assert.equal(others[0].name, 'graph.json');
        assert.equal(others.find(o => o.path === 'shots/one.png').size, 11, 'withStats 时要给出真实大小');
        assert.equal(others.find(o => o.path === 'shots/one.png').mtimeMs > 0, true, 'mtime 要能读到');
        assert.equal(texts[0].size, 2, 'txt 也要有真实大小(树里要显示)');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('texts 不给 withStats 时 size/mtime 是 0(与 others 同一条规矩)', async () => {
    const { base, root } = tmpVault('texts-nostat');
    try {
        fs.writeFileSync(path.join(root, '剧本文本.txt'), 'x'.repeat(30));
        const { texts } = await listVaultTree(root);
        assert.deepEqual(texts.map(o => [o.path, o.size, o.mtimeMs]), [['剧本文本.txt', 0, 0]]);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('maxTexts 独立:一个装满 txt 的目录不会把 Markdown 笔记名额吃光', async () => {
    const { base, root } = tmpVault('texts-cap');
    try {
        fs.writeFileSync(path.join(root, '正文.md'), '# x');
        for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `t${i}.txt`), 'x');
        const { files, texts } = await listVaultTree(root, { maxTexts: 2 });
        assert.deepEqual(files, ['正文.md'], 'maxTexts 不该影响笔记');
        assert.equal(texts.length, 2);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('others 不给 withStats 时 size/mtime 是 0(不必为每个文件多一次 stat)', async () => {
    const { base, root } = tmpVault('others-nostat');
    try {
        fs.writeFileSync(path.join(root, 'big.png'), 'x'.repeat(100));
        const { others } = await listVaultTree(root);
        assert.deepEqual(others.map(o => [o.path, o.size, o.mtimeMs]), [['big.png', 0, 0]]);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('others 跳过隐藏文件与隐藏目录、node_modules(否则 .DS_Store 刷屏)', async () => {
    const { base, root } = tmpVault('others-hidden');
    try {
        fs.mkdirSync(path.join(root, '.obsidian'));
        fs.mkdirSync(path.join(root, 'node_modules'));
        fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
        fs.writeFileSync(path.join(root, '.obsidian', 'workspace.json'), 'x');
        fs.writeFileSync(path.join(root, 'node_modules', 'dep.json'), 'x');
        fs.writeFileSync(path.join(root, 'keep.json'), '{}');
        const { others } = await listVaultTree(root);
        assert.deepEqual(others.map(o => o.path), ['keep.json']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('maxOthers 独立于 maxFiles:装满图的 shots 不会把笔记名额吃光', async () => {
    const { base, root } = tmpVault('others-cap');
    try {
        for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(root, `n${i}.md`), '# x');
        for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `p${i}.png`), 'x');

        const a = await listVaultTree(root, { maxFiles: 100, maxOthers: 4 });
        assert.equal(a.files.length, 6, '笔记不受 maxOthers 影响');
        assert.equal(a.others.length, 4, 'others 受 maxOthers 管');

        const b = await listVaultTree(root, { maxFiles: 3, maxOthers: 100 });
        assert.equal(b.files.length, 3, '笔记受 maxFiles 管');
        assert.equal(b.others.length, 20, 'others 不受 maxFiles 影响');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('others 排序稳定(字典序),便于树里逐行渲染与断言', async () => {
    const { base, root } = tmpVault('others-sort');
    try {
        for (const n of ['c.png', 'a.png', 'b.png']) fs.writeFileSync(path.join(root, n), 'x');
        const { others } = await listVaultTree(root);
        assert.deepEqual(others.map(o => o.path), ['a.png', 'b.png', 'c.png']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
