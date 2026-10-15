import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    maskCode, parseWikilinks, parseTags, parseHeadings,
    slugify, normalizeLinkTarget, lineOf,
} from '../app/lib/wikilink.js';

// ---------- maskCode ----------

test('maskCode 抹掉围栏代码块但保持长度与行数', () => {
    const text = 'a\n```\n[[不是链接]]\n```\nb';
    const masked = maskCode(text);
    assert.equal(masked.length, text.length, '长度必须一致,否则下标会错位');
    assert.equal(masked.split('\n').length, text.split('\n').length, '行数必须一致');
    assert.ok(!masked.includes('不是链接'));
});

test('maskCode 支持 ~~~ 围栏', () => {
    const masked = maskCode('~~~\n[[x]]\n~~~');
    assert.ok(!masked.includes('[[x]]'));
});

test('maskCode 抹掉行内代码', () => {
    const masked = maskCode('正常 [[链接]] 和 `[[不是链接]]` 结束');
    assert.ok(masked.includes('[[链接]]'));
    assert.ok(!masked.includes('[[不是链接]]'));
});

test('maskCode 空输入安全', () => {
    assert.equal(maskCode(''), '');
    assert.equal(maskCode(null), '');
    assert.equal(maskCode(undefined), '');
});

test('maskCode 未闭合的围栏:其后内容都算代码', () => {
    const masked = maskCode('```\n[[x]]');
    assert.ok(!masked.includes('[[x]]'));
});

// ---------- parseWikilinks ----------

test('解析最简单的链接', () => {
    const links = parseWikilinks('见 [[数据库设计]] 一文');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, '数据库设计');
    assert.equal(links[0].alias, null);
    assert.equal(links[0].embed, false);
});

test('解析别名', () => {
    const [l] = parseWikilinks('[[数据库设计|那篇设计]]');
    assert.equal(l.target, '数据库设计');
    assert.equal(l.alias, '那篇设计');
});

test('解析指向小节的链接', () => {
    const [l] = parseWikilinks('[[数据库设计#索引策略]]');
    assert.equal(l.target, '数据库设计');
    assert.equal(l.heading, '索引策略');
});

test('小节与别名同时存在', () => {
    const [l] = parseWikilinks('[[笔记#小节|显示名]]');
    assert.equal(l.target, '笔记');
    assert.equal(l.heading, '小节');
    assert.equal(l.alias, '显示名');
});

test('解析块引用', () => {
    const [l] = parseWikilinks('[[笔记^块id]]');
    assert.equal(l.target, '笔记');
    assert.equal(l.block, '块id');
});

test('解析嵌入 ![[...]]', () => {
    const [l] = parseWikilinks('![[一张图.png]]');
    assert.equal(l.target, '一张图.png');
    assert.equal(l.embed, true);
});

test('一句话里的多个链接都被解析', () => {
    const links = parseWikilinks('[[A]] 与 [[B]] 以及 ![[C]]');
    assert.deepEqual(links.map(l => l.target), ['A', 'B', 'C']);
    assert.deepEqual(links.map(l => l.embed), [false, false, true]);
});

test('代码块里的链接不算链接', () => {
    const links = parseWikilinks('```\n[[不是链接]]\n```\n[[是链接]]');
    assert.deepEqual(links.map(l => l.target), ['是链接']);
});

test('行内代码里的链接不算链接', () => {
    const links = parseWikilinks('写 `[[x]]` 表示链接,比如 [[真链接]]');
    assert.deepEqual(links.map(l => l.target), ['真链接']);
});

test('记录链接所在行号', () => {
    const links = parseWikilinks('第一行\n第二行 [[这里]]\n第三行');
    assert.equal(links[0].line, 2);
});

test('名字里带空格的链接保留空格', () => {
    const [l] = parseWikilinks('[[我的 笔记 名]]');
    assert.equal(l.target, '我的 笔记 名');
});

test('不闭合的 [[ 不产生链接', () => {
    assert.deepEqual(parseWikilinks('[[没有闭合'), []);
});

test('空链接 [[ ]] 不产生链接', () => {
    assert.deepEqual(parseWikilinks('[[]]'), []);
});

test('链接里的目标会被 trim', () => {
    const [l] = parseWikilinks('[[  前后空格  ]]');
    assert.equal(l.target, '前后空格');
});

test('alias 为空时保留空字符串而不是 null', () => {
    const [l] = parseWikilinks('[[笔记|]]');
    assert.equal(l.target, '笔记');
    assert.equal(l.alias, '');
});

// ---------- parseTags ----------

test('解析行内标签', () => {
    assert.deepEqual(parseTags('这是 #项目 的内容'), ['项目']);
});

test('解析中文与层级标签', () => {
    assert.deepEqual(parseTags('#项目/开物 和 #随想'), ['项目/开物', '随想']);
});

test('行首的标签也认', () => {
    assert.deepEqual(parseTags('#行首\n正文'), ['行首']);
});

test('a#b 不算标签(前面不是空白)', () => {
    assert.deepEqual(parseTags('abc#不是标签'), []);
});

test('纯数字不当标签', () => {
    assert.deepEqual(parseTags('见 #123 条'), []);
});

test('代码块里的 #标签 不算', () => {
    assert.deepEqual(parseTags('```\n#不是标签\n```\n#是标签'), ['是标签']);
});

test('标题的 # 不算标签', () => {
    // "# 标题" 里 # 后面紧跟空格,不构成标签
    assert.deepEqual(parseTags('# 一级标题\n## 二级'), []);
});

test('frontmatter 的标签与正文标签合并去重', () => {
    const tags = parseTags('正文提到 #共同', ['共同', '独有']);
    assert.deepEqual(tags, ['共同', '独有']);
});

test('标签保持首次出现顺序', () => {
    assert.deepEqual(parseTags('#b #a #b #c'), ['b', 'a', 'c']);
});

test('frontmatter 标签可以带 # 前缀', () => {
    assert.deepEqual(parseTags('', ['#带井号']), ['带井号']);
});

test('括号包围的标签也认', () => {
    assert.deepEqual(parseTags('(#括号里)'), ['括号里']);
});

// ---------- parseHeadings ----------

test('解析各级标题并给出行号与锚点', () => {
    const hs = parseHeadings('# 一级\n\n正文\n\n## 二级标题\n');
    assert.deepEqual(hs.map(h => [h.level, h.text]), [[1, '一级'], [2, '二级标题']]);
    assert.equal(hs[1].line, 5);
    assert.equal(hs[1].slug, '二级标题');
});

test('标题末尾的 # 被去掉', () => {
    const [h] = parseHeadings('## 标题 ##');
    assert.equal(h.text, '标题');
});

test('代码块里的 # 标题不算标题', () => {
    const hs = parseHeadings('```\n# 不是标题\n```\n# 是标题');
    assert.deepEqual(hs.map(h => h.text), ['是标题']);
});

test('slugify 处理空格、大小写与标点', () => {
    assert.equal(slugify('Hello World!'), 'hello-world');
    assert.equal(slugify('中文 标题'), '中文-标题');
});

// ---------- lineOf / normalizeLinkTarget ----------

test('lineOf 数到指定下标所在行', () => {
    const t = 'a\nbb\nccc';
    assert.equal(lineOf(t, 0), 1);
    assert.equal(lineOf(t, 2), 2);
    assert.equal(lineOf(t, 5), 3);
});

test('normalizeLinkTarget 去掉 .md 并统一大小写与斜杠', () => {
    assert.equal(normalizeLinkTarget('Note.md'), 'note');
    assert.equal(normalizeLinkTarget('Note'), 'note');
    assert.equal(normalizeLinkTarget('a\\b'), 'a/b');
    assert.equal(normalizeLinkTarget('  Note.MD  '), 'note');
});

test('normalizeLinkTarget 对空值安全', () => {
    assert.equal(normalizeLinkTarget(null), '');
    assert.equal(normalizeLinkTarget(undefined), '');
});

test('大小写不同的链接归一到同一个目标', () => {
    // Windows 文件系统大小写不敏感,若这里敏感,同一篇笔记会被算成两篇
    assert.equal(normalizeLinkTarget('Note'), normalizeLinkTarget('note'));
});
