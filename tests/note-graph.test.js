import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTargetIndex, buildGraph, backlinksOf, suggestLinks, baseName,
} from '../app/lib/note-graph.js';

const link = (target, line = 1, extra = {}) => ({ target, line, alias: null, embed: false, ...extra });

// 夹具刻意用双字标题:minTitleLength 默认是 2,单字标题(如「的」「一」)
// 会命中任何正文,是有意过滤掉的噪音。
//
// 文件名与标题保持一致:wiki 链接是按**文件名**解析的([[乙篇]] 找 乙篇.md),
// 不是按 frontmatter 里的 title。
const NOTES = [
    { id: 'a', path: '甲篇.md', title: '甲篇', links: [link('乙篇', 3), link('丙篇', 7)] },
    { id: 'b', path: '乙篇.md', title: '乙篇', links: [link('甲篇', 1)] },
    { id: 'c', path: '丙篇.md', title: '丙篇', links: [] },
    { id: 'd', path: '孤岛.md', title: '孤岛', links: [] },
];

test('baseName 兼容两种分隔符', () => {
    assert.equal(baseName('a/b/c.md'), 'c.md');
    assert.equal(baseName('a\\b\\c.md'), 'c.md');
    assert.equal(baseName('c.md'), 'c.md');
});

test('按文件名与相对路径都能建成目标索引', () => {
    const notes = [{ id: 'x', path: '子目录/笔记.md' }];
    const { byTarget } = buildTargetIndex(notes);
    assert.equal(byTarget.get('笔记'), 'x');
    assert.equal(byTarget.get('子目录/笔记'), 'x');
});

test('同名文件不会互相覆盖,并报出冲突', () => {
    const notes = [
        { id: '1', path: 'a/重名.md' },
        { id: '2', path: 'b/重名.md' },
    ];
    const { byTarget, duplicates } = buildTargetIndex(notes);
    assert.equal(byTarget.get('重名'), '1', '短名先登记者优先,结果与数组顺序无关');
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].kept, '1');
    assert.equal(duplicates[0].dropped, '2');
});

test('全路径总能解析到正确的笔记,即使短名冲突', () => {
    const notes = [
        { id: '1', path: 'a/重名.md' },
        { id: '2', path: 'b/重名.md' },
    ];
    const { byTarget } = buildTargetIndex(notes);
    assert.equal(byTarget.get('b/重名'), '2');
});

test('反链记录来源、行号与别名', () => {
    const g = buildGraph(NOTES);
    const bl = backlinksOf(g, 'c');       // 丙篇 被 甲篇 在第 7 行链接
    assert.equal(bl.length, 1);
    assert.equal(bl[0].fromId, 'a');
    assert.equal(bl[0].fromTitle, '甲篇');
    assert.equal(bl[0].line, 7);
});

test('出链去重', () => {
    const notes = [{ id: 'a', path: 'A.md', links: [link('B'), link('B')] },
        { id: 'b', path: 'B.md', links: [] }];
    const g = buildGraph(notes);
    assert.deepEqual(g.outgoing.get('a'), ['b']);
});

test('未解析链接被单独收集,不是丢弃', () => {
    const notes = [{ id: 'a', path: '甲篇.md', title: '甲篇', links: [link('不存在的笔记', 5)] }];
    const g = buildGraph(notes);
    assert.equal(g.unresolved.length, 1);
    assert.equal(g.unresolved[0].target, '不存在的笔记');
    assert.equal(g.unresolved[0].line, 5);
});

test('孤儿 = 没有出链也没有反链', () => {
    const g = buildGraph(NOTES);
    assert.deepEqual(g.orphans, ['d']);
});

test('互相链接的两篇都不算孤儿', () => {
    const g = buildGraph(NOTES);
    assert.ok(!g.orphans.includes('a'));
    assert.ok(!g.orphans.includes('b'));
});

test('反链按来源标题稳定排序', () => {
    // 这里刻意让文件名与标题不同,验证反链展示用的是**标题**而不是文件名
    const notes = [
        { id: 't', path: '目标.md', title: '目标', links: [] },
        { id: 'z', path: 'Zeta.md', title: 'Zeta', links: [link('目标', 2)] },
        { id: 'a', path: 'Alpha.md', title: 'Alpha', links: [link('目标', 9)] },
    ];
    const g = buildGraph(notes);
    assert.deepEqual(backlinksOf(g, 't').map(b => b.fromTitle), ['Alpha', 'Zeta']);
});

test('没有反链时返回空数组而不是 undefined', () => {
    const g = buildGraph(NOTES);
    assert.deepEqual(backlinksOf(g, '不存在'), []);
});

test('链接大小写不敏感地解析到同一篇', () => {
    const notes = [
        { id: 'a', path: 'A.md', links: [link('b')] },
        { id: 'b', path: 'B.md', links: [] },
    ];
    const g = buildGraph(notes);
    assert.deepEqual(g.outgoing.get('a'), ['b']);
});

test('带 .md 后缀的链接也能解析', () => {
    const notes = [
        { id: 'a', path: 'A.md', links: [link('B.md')] },
        { id: 'b', path: 'B.md', links: [] },
    ];
    assert.deepEqual(buildGraph(notes).outgoing.get('a'), ['b']);
});

test('空输入安全', () => {
    const g = buildGraph([]);
    assert.equal(g.backlinks.size, 0);
    assert.deepEqual(g.orphans, []);
    assert.deepEqual(buildGraph(null).unresolved, []);
});

test('笔记缺少 links 字段时按无出链处理', () => {
    const g = buildGraph([{ id: 'a', path: 'A.md' }]);
    assert.deepEqual(g.outgoing.get('a'), []);
    assert.deepEqual(g.orphans, ['a']);
});

// ---------- 建议链接 ----------

test('正文提到但未链接的笔记会被建议', () => {
    const notes = [
        { id: 'a', path: '甲篇.md', title: '甲篇', body: '这里提到了乙篇这个概念', links: [] },
        { id: 'b', path: '乙篇.md', title: '乙篇', links: [] },
    ];
    const g = buildGraph(notes);
    const s = suggestLinks(notes[0], notes, g);
    assert.deepEqual(s.map(x => x.id), ['b']);
});

test('已经链接过的不再建议', () => {
    const notes = [
        { id: 'a', path: '甲篇.md', title: '甲篇', body: '提到了乙篇', links: [link('乙篇')] },
        { id: 'b', path: '乙篇.md', title: '乙篇', links: [] },
    ];
    const g = buildGraph(notes);
    assert.deepEqual(suggestLinks(notes[0], notes, g), []);
});

test('已有反链的不再建议', () => {
    const notes = [
        { id: 'a', path: '甲篇.md', title: '甲篇', body: '提到了乙篇', links: [] },
        { id: 'b', path: '乙篇.md', title: '乙篇', links: [link('甲篇')] },
    ];
    const g = buildGraph(notes);
    assert.deepEqual(suggestLinks(notes[0], notes, g), []);
});

test('不建议自己', () => {
    const notes = [{ id: 'a', path: '甲篇.md', title: '甲篇', body: '甲篇 甲篇 甲篇', links: [] }];
    assert.deepEqual(suggestLinks(notes[0], notes, buildGraph(notes)), []);
});

test('太短的标题不参与建议(避免噪音)', () => {
    const notes = [
        { id: 'a', path: '甲篇.md', title: '甲篇', body: '这篇提到了 的 字', links: [] },
        { id: 'b', path: '的.md', title: '的', links: [] },
    ];
    assert.deepEqual(suggestLinks(notes[0], notes, buildGraph(notes)), []);
});

test('minTitleLength 可调', () => {
    const notes = [
        { id: 'a', path: '甲篇.md', title: '甲篇', body: '提到了 短', links: [] },
        { id: 'b', path: '短.md', title: '短', links: [] },
    ];
    const s = suggestLinks(notes[0], notes, buildGraph(notes), { minTitleLength: 1 });
    assert.deepEqual(s.map(x => x.id), ['b']);
});

test('limit 限制建议条数', () => {
    const notes = [
        { id: 'a', path: '甲一.md', title: '甲一', body: '这里提到乙二与丙三', links: [] },
        { id: 'b', path: '乙二.md', title: '乙二', links: [] },
        { id: 'c', path: '丙三.md', title: '丙三', links: [] },
    ];
    const s = suggestLinks(notes[0], notes, buildGraph(notes), { limit: 1 });
    assert.equal(s.length, 1);
});

test('正文为空时不建议', () => {
    const notes = [
        { id: 'a', path: '甲篇.md', title: '甲篇', body: '', links: [] },
        { id: 'b', path: '乙篇.md', title: '乙篇', links: [] },
    ];
    assert.deepEqual(suggestLinks(notes[0], notes, buildGraph(notes)), []);
});

test('建议里带上原因,便于界面展示', () => {
    const notes = [
        { id: 'a', path: 'A.md', title: '甲一', body: '这里提到了乙二', links: [] },
        { id: 'b', path: 'B.md', title: '乙二', links: [] },
    ];
    const [s] = suggestLinks(notes[0], notes, buildGraph(notes));
    assert.ok(s.reason.includes('乙二'));
});
