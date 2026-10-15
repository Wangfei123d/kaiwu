import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexVault } from '../electron/notes/note-index.js';

// 用真实文件复现"反链里同一条链接出现两次"。
// 起因:根目录下的笔记,basename 与「去扩展名的全路径」完全相同,
// buildTargetIndex 的两轮登记会把它登记两次。

function tmpVault(label) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `kaiwu-dup-${label}-`));
    const root = path.join(base, 'vault');
    fs.mkdirSync(root, { recursive: true });
    return { base, root };
}

const put = (root, rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
};

test('根目录笔记的反链不重复:目标与来源同在一个根目录下', async () => {
    const { base, root } = tmpVault('flat');
    try {
        // 两篇都在根目录,链接只写一次
        put(root, '目标篇.md', '# 目标篇\n');
        put(root, '来源篇.md', '# 来源篇\n\n见 [[目标篇]]。\n');

        const { graph } = await indexVault(root);
        const bl = graph.backlinks.get('目标篇.md') ?? [];

        assert.equal(bl.length, 1,
            `只链了一次,反链就该只有一条。实际 ${bl.length} 条:`
            + JSON.stringify(bl.map(b => `${b.fromId}@${b.line}`)));
        assert.equal(graph.duplicates.length, 0, '同一篇笔记不该被当成重复 id');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('子目录笔记的反链同样不重复', async () => {
    const { base, root } = tmpVault('nested');
    try {
        put(root, '子/目标篇.md', '# 目标篇\n');
        put(root, '子/来源篇.md', '# 来源篇\n\n见 [[目标篇]]。\n');

        const { graph } = await indexVault(root);
        const bl = graph.backlinks.get('子/目标篇.md') ?? [];
        assert.equal(bl.length, 1, JSON.stringify(bl.map(b => `${b.fromId}@${b.line}`)));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('同一篇被两处链接时,反链应有两条(区分"真重复"与"假重复")', async () => {
    const { base, root } = tmpVault('twice');
    try {
        put(root, '目标篇.md', '# 目标篇\n');
        put(root, '来源篇.md', '# 来源篇\n\n见 [[目标篇]]。\n\n再见 [[目标篇]]。\n');

        const { graph } = await indexVault(root);
        const bl = graph.backlinks.get('目标篇.md') ?? [];
        assert.equal(bl.length, 2, '真的链了两次,就该是两条');
        assert.notEqual(bl[0].line, bl[1].line, '两条应在不同行');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('多种写法([[名]] 与 [[路径/名]])指向同一篇时,各自算一条真实链接', async () => {
    const { base, root } = tmpVault('forms');
    try {
        put(root, '子/目标篇.md', '# 目标篇\n');
        put(root, '来源篇.md', '# 来源篇\n\n短名 [[目标篇]] 与全路径 [[子/目标篇]]。\n');

        const { graph } = await indexVault(root);
        const bl = graph.backlinks.get('子/目标篇.md') ?? [];
        // 一行里链了两次(两种写法),这是两条真实链接,不是重复 bug
        assert.equal(bl.length, 2, JSON.stringify(bl.map(b => `${b.fromId}@${b.line}`)));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- others:非笔记文件也要进索引 ----------
//
// 树里不列它们,那些 shots/ 里的图就无从"拖进文件夹"——
// 这一条守的是"索引层真的把它们带出来了"。
test('indexVault 带出 others(png/docx/json),且不影响 notes 与 folders', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-idx-others-'));
    try {
        fs.mkdirSync(path.join(base, 'shots'), { recursive: true });
        fs.writeFileSync(path.join(base, 'a.md'), '# A');
        fs.writeFileSync(path.join(base, 'shots', 'one.png'), 'x'.repeat(7));
        fs.writeFileSync(path.join(base, 'graph.json'), '{}');
        const r = await indexVault(base);
        assert.deepEqual(r.notes.map(n => n.path), ['a.md']);
        assert.deepEqual(r.folders, ['shots']);
        assert.deepEqual(r.others.map(o => o.path), ['graph.json', 'shots/one.png']);
        assert.equal(r.others.find(o => o.name === 'one.png').size, 7, 'withStats 生效:大小要真的带出来');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('indexVault 的 maxOthers 与 maxFiles 互不挤占', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-idx-cap-'));
    try {
        for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(base, `n${i}.md`), '# x');
        for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(base, `p${i}.png`), 'x');
        const r = await indexVault(base, { maxOthers: 3 });
        assert.equal(r.notes.length, 5, '笔记不受 maxOthers 影响');
        assert.equal(r.others.length, 3, 'others 受 maxOthers 管');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
