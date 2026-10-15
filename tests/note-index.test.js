import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseNote, indexVault, readNote, writeNote, createNote, createFolder, replaceFrontmatter,
    setBodyTitle,
} from '../electron/notes/note-index.js';

function tmpVault(label = 'idx') {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `kaiwu-${label}-`));
    const root = path.join(base, 'vault');
    fs.mkdirSync(root, { recursive: true });
    return { base, root };
}

const write = (root, rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
};

// ---------- parseNote:纯计算 ----------

test('parseNote 抽出标题、标签、链接与标题结构', () => {
    const n = parseNote({
        relPath: '笔记.md',
        text: '# 我的标题\n\n见 [[另一篇]] 与 #项目/开物\n\n## 小节\n',
    });
    assert.equal(n.id, '笔记.md');
    assert.equal(n.title, '我的标题');
    assert.deepEqual(n.tags, ['项目/开物']);
    assert.equal(n.links.length, 1);
    assert.equal(n.links[0].target, '另一篇');
    assert.deepEqual(n.headings.map(h => h.text), ['我的标题', '小节']);
});

test('frontmatter 的 title 优先于 H1', () => {
    const n = parseNote({
        relPath: '笔记.md',
        text: '---\ntitle: 元数据标题\n---\n# 正文标题\n',
    });
    assert.equal(n.title, '元数据标题');
});

test('没有 frontmatter 也没有 H1 时用文件名做标题', () => {
    const n = parseNote({ relPath: '子目录/某个笔记.md', text: '就是一段话。' });
    assert.equal(n.title, '某个笔记');
});

test('frontmatter 的 tags 与正文标签合并', () => {
    const n = parseNote({
        relPath: 'x.md',
        text: '---\ntags: [甲, 乙]\n---\n正文提到 #丙\n',
    });
    assert.deepEqual(n.tags, ['甲', '乙', '丙']);
});

test('frontmatter 里的 tags 写成单个字符串也认', () => {
    const n = parseNote({ relPath: 'x.md', text: '---\ntags: 单独一个\n---\n' });
    assert.deepEqual(n.tags, ['单独一个']);
});

test('parseNote 保留 frontmatter 对象供调用方使用', () => {
    const n = parseNote({ relPath: 'x.md', text: '---\norder: 3\ndraft: true\n---\n' });
    assert.equal(n.frontmatter.order, 3);
    assert.equal(n.frontmatter.draft, true);
});

test('parseNote 记录 mtime 与大小', () => {
    const n = parseNote({ relPath: 'x.md', text: 'abc', mtimeMs: 123, size: 3 });
    assert.equal(n.mtimeMs, 123);
    assert.equal(n.size, 3);
});

// ---------- indexVault ----------

test('索引整个 Vault 并建立链接关系', async () => {
    const { base, root } = tmpVault('index');
    try {
        write(root, '甲.md', '# 甲\n见 [[乙]]');
        write(root, '乙.md', '# 乙\n见 [[甲]]');
        write(root, '孤岛.md', '# 孤岛\n没人链接我');

        const { notes, graph, errors } = await indexVault(root);
        assert.equal(notes.length, 3);
        assert.deepEqual(errors, []);
        assert.equal(graph.backlinks.get('乙.md').length, 1);
        assert.deepEqual(graph.orphans, ['孤岛.md']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('索引遇到单篇读失败时继续,不整次失败', async () => {
    const { base, root } = tmpVault('partial');
    try {
        write(root, '好.md', '# 好');
        const { notes, errors } = await indexVault(root, { log: { warn() {} } });
        assert.equal(notes.length, 1);
        assert.deepEqual(errors, []);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('Vault 不存在时返回错误说明而不是抛异常', async () => {
    const r = await indexVault(path.join(os.tmpdir(), 'kaiwu-__没有__'));
    assert.deepEqual(r.notes, []);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].message, /不存在/);
});

test('Vault 内的目录联接逃逸不会读到外部笔记', async () => {
    const { base, root } = tmpVault('escape');
    const outside = path.join(base, 'outside');
    try {
        fs.mkdirSync(outside);
        write(outside, '外部秘密.md', '# 不该被索引到');
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');

        const { notes } = await indexVault(root, { log: { warn() {} } });
        const names = notes.map(n => n.path);
        assert.ok(!names.some(p => p.includes('外部秘密')),
            `外部笔记不该出现在索引里,实际:${names.join(',')}`);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- 读写 ----------

test('readNote 读回原文', async () => {
    const { base, root } = tmpVault('read');
    try {
        write(root, 'a.md', '# 标题\n正文');
        const r = await readNote(root, 'a.md');
        assert.equal(r.text, '# 标题\n正文');
        assert.ok(r.size > 0);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('readNote 拒绝越界路径', async () => {
    const { base, root } = tmpVault('readguard');
    try {
        await assert.rejects(() => readNote(root, '../外面.md'), /越出 Vault/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('readNote 拒绝非家族文件(.png / .docx),但 .txt 现在是家族成员', async () => {
    const { base, root } = tmpVault('readext');
    try {
        await assert.rejects(() => readNote(root, 'x.png'), /只允许/);
        await assert.rejects(() => readNote(root, 'x.docx'), /只允许/);
        // ⚠️ 这一条**反过来了**(用户这一轮的决定:txt 可编辑)。从前 .txt 被拒;
        //    现在它读得出来,而且带回"编码 / 能不能写回"那几个字段(见 readNote)。
        fs.writeFileSync(path.join(root, 'x.txt'), '剧本:第一场\n', 'utf8');
        const r = await readNote(root, 'x.txt');
        assert.equal(r.text, '剧本:第一场\n');
        assert.equal(r.kind, 'text');
        assert.equal(r.encoding, 'utf-8');
        assert.equal(r.editable, true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 写入内容', async () => {
    const { base, root } = tmpVault('write');
    try {
        await writeNote(root, 'a.md', '# 新内容');
        assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# 新内容');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 自动建父目录', async () => {
    const { base, root } = tmpVault('mkdir');
    try {
        await writeNote(root, '深/更深/a.md', '内容');
        assert.equal(fs.readFileSync(path.join(root, '深', '更深', 'a.md'), 'utf8'), '内容');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 覆盖前留一份 .bak', async () => {
    const { base, root } = tmpVault('backup');
    try {
        write(root, 'a.md', '旧内容');
        await writeNote(root, 'a.md', '新内容');
        assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '新内容');
        assert.equal(fs.readFileSync(path.join(root, 'a.md.bak'), 'utf8'), '旧内容',
            'AI 改笔记的兜底:覆盖前必须留备份');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 可关闭备份', async () => {
    const { base, root } = tmpVault('nobackup');
    try {
        write(root, 'a.md', '旧');
        await writeNote(root, 'a.md', '新', { backup: false });
        assert.equal(fs.existsSync(path.join(root, 'a.md.bak')), false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 不留下临时文件', async () => {
    const { base, root } = tmpVault('tmpclean');
    try {
        await writeNote(root, 'a.md', '内容');
        const left = fs.readdirSync(root).filter(f => f.includes('.tmp-'));
        assert.deepEqual(left, [], '原子写的临时文件必须被 rename 掉,不能残留');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 拒绝越界与非家族文件', async () => {
    const { base, root } = tmpVault('writeguard');
    try {
        await assert.rejects(() => writeNote(root, '../外面.md', 'x'), /越出 Vault/);
        await assert.rejects(() => writeNote(root, 'x.png', 'x'), /只允许/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 写 .txt:保持原换行(CRLF 的存回去还是 CRLF)', async () => {
    const { base, root } = tmpVault('writetext');
    try {
        const abs = path.join(root, '剧本.txt');
        fs.writeFileSync(abs, '第一行\r\n第二行\r\n', 'utf8');
        await writeNote(root, '剧本.txt', '第一行\n第二行\n第三行\n');
        // ⚠️ 不还原换行的话,"打开再保存"会让整个文件在 git/diff 里全亮(一行没改却全变)
        assert.equal(fs.readFileSync(abs, 'utf8'), '第一行\r\n第二行\r\n第三行\r\n');
        assert.equal(fs.existsSync(abs + '.bak'), true, '覆盖前照旧留一代备份');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 拒绝写回非 UTF-8 的 txt(GBK 编不回去,就不能假装能写)', async () => {
    const { base, root } = tmpVault('writegbk');
    try {
        const abs = path.join(root, 'gbk.txt');
        // "剧本:" 的 GBK 字节
        fs.writeFileSync(abs, Buffer.from([0xbe, 0xe7, 0xb1, 0xbe, 0xa3, 0xba]));
        await assert.rejects(() => writeNote(root, 'gbk.txt', '改成 UTF-8 了'), /不能安全写回/);
        assert.deepEqual([...fs.readFileSync(abs)], [0xbe, 0xe7, 0xb1, 0xbe, 0xa3, 0xba], '原件一个字节都不许动');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('writeNote 拒绝经联接逃逸的路径', async () => {
    const { base, root } = tmpVault('writeescape');
    const outside = path.join(base, 'outside');
    try {
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
        await assert.rejects(() => writeNote(root, 'escape/偷写.md', 'x'), /越出 Vault/);
        assert.equal(fs.existsSync(path.join(outside, '偷写.md')), false, '绝不能写到 Vault 外');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('createNote 新建笔记', async () => {
    const { base, root } = tmpVault('create');
    try {
        await createNote(root, '新笔记.md', '# 你好');
        assert.equal(fs.readFileSync(path.join(root, '新笔记.md'), 'utf8'), '# 你好');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('createNote 遇到已存在的笔记会报错,不覆盖', async () => {
    const { base, root } = tmpVault('dup');
    try {
        write(root, 'a.md', '已有内容');
        await assert.rejects(() => createNote(root, 'a.md', '覆盖'), /已存在/);
        assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '已有内容');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- replaceFrontmatter ----------

test('replaceFrontmatter 只换元数据,正文一字不动', () => {
    const text = '---\ntitle: 旧\n---\n# 正文\n\n这里是**正文**,不该被动。\n';
    const out = replaceFrontmatter(text, { title: '新', tags: ['x'] });
    assert.ok(out.includes('title: 新'));
    assert.ok(out.includes('tags: [x]'));
    assert.ok(out.includes('# 正文\n\n这里是**正文**,不该被动。'));
});

test('replaceFrontmatter 可以给原本没有元数据的笔记加上', () => {
    const out = replaceFrontmatter('# 只有正文\n内容', { title: 'T' });
    assert.ok(out.startsWith('---\ntitle: T\n---\n'));
    assert.ok(out.includes('# 只有正文\n内容'));
});

test('replaceFrontmatter 对含水平线的正文安全', () => {
    const text = '---\ntitle: 旧\n---\n上\n\n---\n\n下';
    const out = replaceFrontmatter(text, { title: '新' });
    assert.ok(out.includes('上\n\n---\n\n下'), '正文里的分割线必须原样保留');
});

// ---------- setBodyTitle ----------
//
// 为什么需要它:标题解析顺序是 frontmatter.title → **第一个 H1** → 文件名。
// 所以「改文件名」单独做是不够的 —— 正文里那个旧 H1 会把新标题盖回去,
// 表现就是"命名好了、列表里却还是旧名字"。
// 这组用例钉住:只改第一个 H1、其余一个字不许动。

test('setBodyTitle 换掉第一个 H1', () => {
    assert.equal(setBodyTitle('# 未命名\n\n正文', '第一个笔记'), '# 第一个笔记\n\n正文');
});

test('setBodyTitle 没有 H1 时原样返回(此时标题由文件名决定)', () => {
    const src = '只有正文,没有标题。\n';
    assert.equal(setBodyTitle(src, '新'), src);
});

test('setBodyTitle 只改第一个 H1,后面的标题不动', () => {
    const out = setBodyTitle('# 旧\n\n## 小节\n\n# 另一个 H1\n', '新');
    assert.ok(out.startsWith('# 新\n'));
    assert.ok(out.includes('## 小节'));
    assert.ok(out.includes('# 另一个 H1'));
});

test('setBodyTitle 不碰 frontmatter', () => {
    const src = '---\ntitle: 元数据\n---\n# 旧\n\n正文\n';
    const out = setBodyTitle(src, '新');
    assert.ok(out.startsWith('---\ntitle: 元数据\n---\n'), 'frontmatter 必须原样保留');
    assert.ok(out.includes('\n# 新\n'));
    assert.ok(out.includes('正文'));
    assert.equal(out.includes('# 旧'), false);
});

test('setBodyTitle 不把代码块里的 # 当标题', () => {
    // 与 parseHeadings 保持一致(它已经把围栏内容抹掉了)—— 否则会把代码改掉
    const src = '正文在前\n\n```\n# 这是代码\n```\n';
    assert.equal(setBodyTitle(src, '新'), src);
});

test('setBodyTitle 把标题里的换行压成空格(否则会写出两行)', () => {
    assert.equal(setBodyTitle('# 旧\n', '甲\n乙'), '# 甲 乙\n');
});

test('setBodyTitle 沿用那一行原来的行尾:CRLF 笔记不许被改出孤零零的 LF', () => {
    // 功能上认得出标题,但 diff 会凭空多一处行尾变化 —— 对 git 用户是噪音,
    // 而且会把"只改了标题"这件事描述成"改了标题 + 改了行尾"。
    assert.equal(setBodyTitle('# 旧\r\n\r\n正文\r\n', '新'), '# 新\r\n\r\n正文\r\n');
    // 顺带钉住"别把别的行也换掉":混合行尾里只动被改的那一行。
    assert.equal(setBodyTitle('# 旧\r\n\r\n正文\n', '新'), '# 新\r\n\r\n正文\n');
    // 没有回车时一切照旧(不能被上面的改动带偏)
    assert.equal(setBodyTitle('# 旧\n', '新'), '# 新\n');
});

// ---------- createFolder ----------

test('createFolder 建单层目录;父目录不存在时报错(不递归替用户猜)', async () => {
    const { base, root } = tmpVault('folder');
    try {
        const r = await createFolder(root, '阅读');
        assert.equal(r.path, '阅读');
        assert.equal(fs.statSync(path.join(root, '阅读')).isDirectory(), true);

        // 父目录在的时候,多一级也允许
        const r2 = await createFolder(root, '阅读/2026');
        assert.equal(r2.path, '阅读/2026');

        // 父目录不在:报错而不是一路 recursive 造出来 —— 多级路径是调用方出错了
        await assert.rejects(() => createFolder(root, '没有/这一层'), /上层文件夹不存在/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('createFolder 拒绝越界路径,且不会在库外留下任何东西', async () => {
    const { base, root } = tmpVault('folder2');
    try {
        await assert.rejects(() => createFolder(root, '../逃逸'), /越出 Vault/);
        assert.equal(fs.existsSync(path.join(base, '逃逸')), false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('indexVault 连**空目录**一起返回(树状列表要用它显示刚建的文件夹)', async () => {
    const { base, root } = tmpVault('folder3');
    try {
        write(root, '甲.md', '# 甲\n');
        fs.mkdirSync(path.join(root, '空目录'));
        fs.mkdirSync(path.join(root, '.隐藏'));
        const idx = await indexVault(root);
        assert.deepEqual(idx.folders, ['空目录'], '以 . 开头的目录仍然跳过');
        assert.deepEqual(idx.notes.map(n => n.path), ['甲.md']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------- .md 的编解码,以及"绝不许有损改写" ----------
//
// 这一组钉的是一个**会悄悄毁掉用户笔记**的缺陷。字节证据 + 代码双向确认过:
//
//   · 真库 `AI会话/2026-09-27-0125-…md`(4963 B):**严格 UTF-8 非法**,字面 U+FFFD = 0。
//   · 真库 `短剧/未命名 2.md`(5306 B):**严格 UTF-8 合法**,字面 U+FFFD = **1203**,NUL 30。
//
// 这两篇是同一件事的前后两态:后者正是"非法字节被**有损解码**成 U+FFFD,再按 UTF-8
// **重新编码**"的产物。而代码侧的不对称就是那条流水线:
//
//   .md 分支:`readFile(abs,'utf8')` → Node 把非法字节替换成 U+FFFD
//              → 保存时 `Buffer.from(payload,'utf8')` 把它编回去
//   ⇒ **打开一次 + 保存一次 = 永久损坏,不可逆。**
//
// 新判据与 .txt 完全同一套(见 app/lib/text-encoding.js 的 decodeText/encodeText):
// 解得开就正确解(GBK / UTF-16 / 带 BOM 都能读出来),解不开就**拒绝打开**,
// 并且**绝不允许**把 decode-then-re-encode 的结果写回磁盘。宁可拒绝,也不许改写。

/** 磁盘上那一份的原始字节。断言"没被改写"时用它做逐字节比较。 */
const rawBytes = (abs) => [...fs.readFileSync(abs)];

/**
 * 一段既不是合法 UTF-8、也不是任何 GB18030 序列的字节。
 *
 * 为什么挑 0xFF / 0x80 这两个:它们不是"刚好被某个中文编码认下来"的字节 ——
 * 一个孤立的高位字节正是"文件被别的程序写坏"最常见的形态,而它**必须**落到
 * "解不开"这一支上(编码试探那一步也不许把它蒙过去)。
 */
const ILLEGAL_BYTES = Buffer.from([0xff, 0x80]);

test('含非法 UTF-8 字节的 .md:拒绝打开,而且一个字节都不许被改写', async () => {
    const { base, root } = tmpVault('md-illegal');
    try {
        const abs = path.join(root, '坏字节.md');
        fs.writeFileSync(abs, Buffer.concat([
            Buffer.from('# 标题\n\n正文\n', 'utf8'), ILLEGAL_BYTES, Buffer.from('尾巴\n', 'utf8'),
        ]));
        const before = rawBytes(abs);

        // ① 读路径:必须拒绝 —— 而不是"有损解码之后交出去"(那正是原文被毁的第一步)
        await assert.rejects(() => readNote(root, '坏字节.md'), /不是能安全打开的文本文件/,
            '解不开的 .md 必须拒绝打开,不许把 U+FFFD 版本当成用户的内容');

        // ② 写路径:即使调用方硬写,也必须被挡在原子写之前
        await assert.rejects(() => writeNote(root, '坏字节.md', '# 被改写\n'),
            /不能保存|不是能安全打开的文本文件/);

        // ③ 核心断言:整轮下来磁盘字节**逐字节一致** —— 没有 decode-then-re-encode 的任何痕迹
        assert.deepEqual(rawBytes(abs), before,
            '被拒绝的笔记:磁盘内容必须逐字节不变(这正是"打开一次就毁掉"那条路被掐断的证据)');
        // 拒绝必须发生在**任何**落盘动作之前:既不留 .bak,也不留原子写的临时文件
        assert.deepEqual(fs.readdirSync(root), ['坏字节.md'],
            '拒绝就是什么都没做:不许留下 .bak / .tmp- 之类的痕迹');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('含 NUL 的 .md:同样拒绝打开,字节不变(NUL 不是文本,不该被当笔记改)', async () => {
    const { base, root } = tmpVault('md-nul');
    try {
        const abs = path.join(root, '带NUL.md');
        fs.writeFileSync(abs, Buffer.concat([
            Buffer.from('# 标题\n', 'utf8'), Buffer.from([0x00]), Buffer.from('正文\n', 'utf8'),
        ]));
        const before = rawBytes(abs);

        await assert.rejects(() => readNote(root, '带NUL.md'), /不是能安全打开的文本文件/);
        await assert.rejects(() => writeNote(root, '带NUL.md', '改一下'), /不能保存|不是能安全打开的文本文件/);
        assert.deepEqual(rawBytes(abs), before, 'NUL 的 .md 也必须原样不动');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('GBK 的 .md 能**正确解码**(与 .txt 同一套编解码),但只读、不许写回', async () => {
    const { base, root } = tmpVault('md-gbk');
    try {
        const abs = path.join(root, 'gbk.md');
        const raw = Buffer.from([0xb1, 0xea, 0xcc, 0xe2]);   // "标题" 的 GBK 字节
        fs.writeFileSync(abs, raw);
        const before = rawBytes(abs);

        const r = await readNote(root, 'gbk.md');
        // 这一条是"能救回来的就别丢":GBK 解得开,所以必须被正确读出来 ——
        // 从前写死 utf8 会得到一屏 U+FFFD,而且一保存就把那些 U+FFFD 永久写回去。
        assert.equal(r.text, '标题', 'GBK 的 .md 必须被正确读出来,而不是一屏 U+FFFD');
        assert.equal(r.encoding, 'gb18030');
        assert.equal(r.editable, false, '编不回去的编码一律只读(与 .txt 同一条规矩)');

        await assert.rejects(() => writeNote(root, 'gbk.md', '改成 UTF-8'), /不能安全写回/);
        assert.deepEqual(rawBytes(abs), before, '只读就是只读:一个字节都不许动');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('正常 .md 的往返逐字节一致 —— 换行、混合行尾、BOM、非 ASCII 都不许被"整理"', async () => {
    const { base, root } = tmpVault('md-roundtrip');
    try {
        const cases = {
            'lf.md': '# 标题\n\n正文\n',
            'crlf.md': '# 标题\r\n\r\n正文\r\n',
            // 混合行尾是最容易被"顺手统一"掉的一种:统一了就是一次凭空多出来的 diff
            'mixed.md': '第一行\r\n第二行\n第三行\r\n',
            'bom.md': '\uFEFF# 带 BOM 的标题\n正文\n',
            'cjk.md': '# 标题 🎬\n\n正文 —— 全角标点、emoji、[[链接]]\n',
        };
        for (const [name, src] of Object.entries(cases)) {
            const raw = Buffer.from(src, 'utf8');
            fs.writeFileSync(path.join(root, name), raw);

            const r = await readNote(root, name);
            await writeNote(root, name, r.text, { backup: false });

            assert.deepEqual(rawBytes(path.join(root, name)), [...raw],
                `${name} 读进来再原样写回去,必须逐字节一致(这是"不许回归"的那条底线)`);
        }
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('indexVault 不把解不开的 .md 当正文交出去(标成"打不开",而不是有损解码)', async () => {
    const { base, root } = tmpVault('idx-broken');
    try {
        write(root, '好.md', '# 好的\n\n见 [[好的]]\n');
        const abs = path.join(root, '坏.md');
        fs.writeFileSync(abs, Buffer.concat([Buffer.from('# 坏\n', 'utf8'), ILLEGAL_BYTES]));
        const bad = rawBytes(abs);

        const { notes, errors } = await indexVault(root, { log: { warn() {} } });
        const good = notes.find(n => n.path === '好.md');
        const broken = notes.find(n => n.path === '坏.md');

        assert.equal(good.readable, true, '解得开的笔记照旧可读');
        assert.equal(good.title, '好的');

        assert.ok(broken !== undefined,
            '解不开的 .md 仍然要出现在列表里 —— 它是用户的文件,凭空消失比"列着但打不开"更吓人');
        assert.equal(broken.readable, false, '但它必须被标成"打不开"');
        assert.equal(broken.body, '', '绝不能把有损解码的正文交出去');
        assert.equal(broken.title, '坏', '标题退回文件名,不猜');
        assert.ok(String(broken.reason).length > 0, '要带上给人看的原因');

        assert.deepEqual(rawBytes(abs), bad, '索引是只读的:扫一遍不许动文件的内容');
        assert.ok(errors.some(e => e.path === '坏.md'),
            '错误清单里也要有它 —— 诊断时"哪一篇读不了"必须有据可查');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('新建 .md 与覆盖 .md 的既有语义不变(原子写、一代备份)', async () => {
    const { base, root } = tmpVault('md-regression');
    try {
        // 覆盖一份**不存在**的 .md:没有"磁盘上那一份"要判,直接按 UTF-8 落盘
        await writeNote(root, '新.md', '# 新的\n');
        assert.equal(fs.readFileSync(path.join(root, '新.md'), 'utf8'), '# 新的\n');
        assert.equal(fs.existsSync(path.join(root, '新.md.bak')), false, '第一次写没有上一代可留');

        // 再写一次:覆盖前照旧留一份 .bak(给「AI 改笔记」兜底的那一代)
        await writeNote(root, '新.md', '# 改过的\n');
        assert.equal(fs.readFileSync(path.join(root, '新.md'), 'utf8'), '# 改过的\n');
        assert.equal(fs.readFileSync(path.join(root, '新.md.bak'), 'utf8'), '# 新的\n');
        assert.deepEqual(fs.readdirSync(root).filter(f => f.includes('.tmp-')), [],
            '原子写的临时文件不许残留');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});