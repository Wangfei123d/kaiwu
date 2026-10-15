import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    splitFrontmatter, parseFrontmatter, parseScalar, splitInlineList,
    serializeFrontmatter, readFrontmatter, writeFrontmatter,
} from '../app/lib/frontmatter.js';

// ---------- splitFrontmatter ----------

test('拆出 frontmatter 与正文', () => {
    const { raw, body, hasFrontmatter } = splitFrontmatter('---\ntitle: T\n---\n正文');
    assert.equal(hasFrontmatter, true);
    assert.equal(raw, 'title: T\n');
    assert.equal(body, '正文');
});

test('没有 frontmatter 时整篇都是正文', () => {
    const { raw, body, hasFrontmatter } = splitFrontmatter('# 就是一篇普通笔记\n内容');
    assert.equal(hasFrontmatter, false);
    assert.equal(raw, '');
    assert.equal(body, '# 就是一篇普通笔记\n内容');
});

test('正文里的 --- 水平线不会被当成 frontmatter(因为不在文件开头)', () => {
    const text = '标题\n\n---\n\n分割线之后';
    const { hasFrontmatter, body } = splitFrontmatter(text);
    assert.equal(hasFrontmatter, false);
    assert.equal(body, text);
});

test('有开头无结尾时不吞掉用户内容', () => {
    const text = '---\ntitle: T\n正文没有结束分隔符';
    const { hasFrontmatter, body } = splitFrontmatter(text);
    assert.equal(hasFrontmatter, false, '不完整的话宁可当普通正文,也不要吞掉内容');
    assert.equal(body, text);
});

test('BOM 不影响识别', () => {
    const { hasFrontmatter } = splitFrontmatter('\uFEFF---\ntitle: T\n---\n正文');
    assert.equal(hasFrontmatter, true);
});

test('空的 frontmatter 块', () => {
    const { hasFrontmatter, raw, body } = splitFrontmatter('---\n---\n正文');
    assert.equal(hasFrontmatter, true);
    assert.equal(raw, '');
    assert.equal(body, '正文');
});

test('splitFrontmatter 对空输入安全', () => {
    assert.deepEqual(splitFrontmatter(''), { raw: '', body: '', hasFrontmatter: false });
    assert.deepEqual(splitFrontmatter(null), { raw: '', body: '', hasFrontmatter: false });
});

// ---------- parseFrontmatter ----------

test('解析标量', () => {
    const d = parseFrontmatter('title: 我的笔记\nauthor: 张三');
    assert.deepEqual(d, { title: '我的笔记', author: '张三' });
});

test('解析布尔与 null', () => {
    const d = parseFrontmatter('draft: true\narchived: false\nempty: null');
    assert.deepEqual(d, { draft: true, archived: false, empty: null });
});

test('解析整数,但保留版本号与日期为字符串', () => {
    const d = parseFrontmatter('order: 12\nversion: 1.0.0\ndate: 2026-09-17');
    assert.equal(d.order, 12);
    assert.equal(d.version, '1.0.0', '1.0.0 不是数字');
    assert.equal(d.date, '2026-09-17', '日期保持字符串,避免时区坑');
});

test('解析行内数组', () => {
    const d = parseFrontmatter('tags: [a, b, c]');
    assert.deepEqual(d.tags, ['a', 'b', 'c']);
});

test('解析空的行内数组', () => {
    assert.deepEqual(parseFrontmatter('tags: []').tags, []);
});

test('解析块数组', () => {
    const d = parseFrontmatter('tags:\n  - a\n  - b');
    assert.deepEqual(d.tags, ['a', 'b']);
});

test('解析简单嵌套对象', () => {
    const d = parseFrontmatter('meta:\n  author: 张三\n  source: 网络');
    assert.deepEqual(d.meta, { author: '张三', source: '网络' });
});

test('引号里的冒号不会被当成分隔符', () => {
    const d = parseFrontmatter('title: "带: 冒号的值"');
    assert.equal(d.title, '带: 冒号的值');
});

test('单引号同样生效', () => {
    assert.equal(parseFrontmatter("title: '单引号: 也行'").title, '单引号: 也行');
});

test('未加引号的值可以带行尾注释', () => {
    const d = parseFrontmatter('title: hello # 这是注释');
    assert.equal(d.title, 'hello');
});

test('整行注释与空行被跳过', () => {
    const d = parseFrontmatter('# 注释\n\ntitle: T');
    assert.deepEqual(d, { title: 'T' });
});

test('不认识的行被跳过而不是抛错', () => {
    const d = parseFrontmatter('title: T\n这行没有冒号\nother: O');
    assert.equal(d.title, 'T');
    assert.equal(d.other, 'O');
});

test('值里含逗号的引号数组元素不被切开', () => {
    assert.deepEqual(parseScalar('["a,b", "c"]'), ['a,b', 'c']);
});

test('parseScalar 对布尔/null/数字/字符串的判定', () => {
    assert.equal(parseScalar('true'), true);
    assert.equal(parseScalar('false'), false);
    assert.equal(parseScalar('null'), null);
    assert.equal(parseScalar('~'), null);
    assert.equal(parseScalar('42'), 42);
    assert.equal(parseScalar('-7'), -7);
    assert.equal(parseScalar('4.2'), '4.2', '小数保持字符串,避免浮点显示问题');
    assert.equal(parseScalar('text'), 'text');
});

test('splitInlineList 尊重引号并去掉空项', () => {
    assert.deepEqual(splitInlineList('a, b ,, c'), ['a', 'b', 'c']);
    assert.deepEqual(splitInlineList('"x, y", z'), ['"x, y"', 'z']);
});

// ---------- 序列化与往返 ----------

test('序列化标量与数组', () => {
    const s = serializeFrontmatter({ title: 'T', tags: ['a', 'b'] });
    assert.equal(s, 'title: T\ntags: [a, b]');
});

test('含特殊字符的值被加引号', () => {
    assert.equal(serializeFrontmatter({ title: '带: 冒号' }), 'title: "带: 冒号"');
});

test('元素含逗号时退化为块数组', () => {
    const s = serializeFrontmatter({ tags: ['a,b', 'c'] });
    assert.ok(s.includes('tags:\n  - '), s);
});

test('frontmatter 往返一致(标量 + 数组)', () => {
    const data = { title: '我的笔记', tags: ['a', 'b'], draft: true, order: 3 };
    const round = parseFrontmatter(serializeFrontmatter(data));
    assert.deepEqual(round, data);
});

test('含引号与中文的值往返一致', () => {
    const data = { title: '带"引号"的标题', note: '中文 值' };
    const round = parseFrontmatter(serializeFrontmatter(data));
    assert.deepEqual(round, data);
});

test('writeFrontmatter 拼回完整文件', () => {
    const out = writeFrontmatter({ title: 'T' }, '正文内容');
    assert.equal(out, '---\ntitle: T\n---\n正文内容');
});

test('没有元数据时不产生空的 frontmatter 块', () => {
    assert.equal(writeFrontmatter({}, '正文'), '正文');
});

test('readFrontmatter 一行拿到对象与正文', () => {
    const r = readFrontmatter('---\ntags: [x]\n---\n这里是正文');
    assert.deepEqual(r.data, { tags: ['x'] });
    assert.equal(r.body, '这里是正文');
    assert.equal(r.hasFrontmatter, true);
});

test('readFrontmatter 对无 frontmatter 的文件安全', () => {
    const r = readFrontmatter('# 只有正文');
    assert.deepEqual(r.data, {});
    assert.equal(r.body, '# 只有正文');
});

test('正文内容里的 --- 不会被序列化影响', () => {
    const body = '上面\n\n---\n\n下面';
    const text = writeFrontmatter({ title: 'T' }, body);
    const r = readFrontmatter(text);
    assert.equal(r.body, body);
});
