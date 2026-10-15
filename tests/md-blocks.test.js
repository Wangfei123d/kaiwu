import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    splitBlocks, replaceBlock, blockIndexAt, blockIndexForCaret, isThematicBreak,
} from '../app/lib/md-blocks.js';

// 分块是"实时预览编辑器"的地基:要能只替换一段而不重排整个文件。
// 所以重点测**区间正确性**与"替换只动那一段"。
//
// ⚠️ 契约是"一行一块"(例外只有围栏代码块与表格,它们必须跨行)。
// 这不是随手定的:早先按空行分隔的段落分块,结果连续两行属于同一块,
// 在编辑器里按回车只是在块内加了个换行、上一行不渲染,用户看到的现象是
// "按了回车得再用鼠标点一下才渲染"。这些用例把这个契约钉住。

const texts = (blocks) => blocks.map(b => b.text);
const types = (blocks) => blocks.map(b => b.type);
const roundTrip = (body) => {
    // 把每块按区间拼回去,应当与原文**完全一致**
    // (空行自己也是块,所以不再有"区间之外的字符")
    const bs = splitBlocks(body);
    let out = '';
    let cursor = 0;
    for (const b of bs) {
        out += body.slice(cursor, b.start) + b.text;
        cursor = b.end;
    }
    return out + body.slice(cursor);
};

test('空输入返回空数组', () => {
    assert.deepEqual(splitBlocks(''), []);
    assert.deepEqual(splitBlocks(null), []);
    assert.deepEqual(splitBlocks(undefined), []);
});

test('一行一块(不是空行分隔的段落一块)', () => {
    const bs = splitBlocks('第一行\n第二行\n第三行');
    assert.deepEqual(texts(bs), ['第一行', '第二行', '第三行']);
    assert.ok(bs.every(b => b.type === 'paragraph'));
});

test('空行自己也是一块(零长度区间)', () => {
    const bs = splitBlocks('第一段\n\n第二段');
    assert.deepEqual(texts(bs), ['第一段', '', '第二段']);
    assert.equal(bs[1].type, 'blank');
    assert.equal(bs[1].start, bs[1].end, '空行块的区间必须是零长度,它就是一个插入点');
});

test('空行块可以当成插入点写进内容', () => {
    const src = '甲\n\n乙';
    const bs = splitBlocks(src);
    assert.equal(replaceBlock(src, bs[1], '中间'), '甲\n中间\n乙');
});

test('标题、引用、分隔线各自一块,类型也对', () => {
    const bs = splitBlocks('# 标题\n\n> 引用\n\n---');
    assert.deepEqual(texts(bs), ['# 标题', '', '> 引用', '', '---']);
    assert.deepEqual(types(bs), ['heading', 'blank', 'quote', 'blank', 'hr']);
});

test('列表逐项成块(这样才能只编辑其中一项)', () => {
    const bs = splitBlocks('- 甲\n- 乙\n- 丙');
    assert.deepEqual(texts(bs), ['- 甲', '- 乙', '- 丙']);
    assert.ok(bs.every(b => b.type === 'list-item'));
});

test('有序列表同样逐项成块', () => {
    assert.deepEqual(texts(splitBlocks('1. 甲\n2. 乙')), ['1. 甲', '2. 乙']);
});

test('围栏代码块整体一块(内部不切,否则围栏自己会被渲染成文字)', () => {
    const bs = splitBlocks('前\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n后');
    assert.deepEqual(texts(bs), ['前', '', '```js\nconst a = 1;\n\nconst b = 2;\n```', '', '后']);
    assert.equal(bs[2].type, 'code');
});

test('代码块内部的空行不会切成块', () => {
    const src = '```\na\n\nb\n```';
    const bs = splitBlocks(src);
    assert.equal(bs.length, 1);
    assert.equal(bs[0].text, src);
});

test('未闭合的围栏代码块把剩余内容都算进去', () => {
    const bs = splitBlocks('前\n\n```\nabc\ndef');
    assert.equal(bs[2].type, 'code');
    assert.equal(bs[2].text, '```\nabc\ndef');
});

test('表格整体一块(表头/分隔行/数据行必须一起渲染)', () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 |';
    const bs = splitBlocks(src);
    assert.equal(bs.length, 1);
    assert.equal(bs[0].type, 'table');
    assert.equal(bs[0].text, src);
});

test('区间精确:text 与 [start,end) 完全一致', () => {
    const src = '# 标题\n\n一段话\n\n- 甲\n\n```js\nconst x = 1;\n```';
    for (const b of splitBlocks(src)) {
        assert.equal(src.slice(b.start, b.end), b.text,
            `块的 text 必须与它的区间一致:${JSON.stringify(b.text)}`);
    }
});

test('按区间拼接能**完全**还原原文(空行也不再落在区间之外)', () => {
    const src = '# 标题\n\n一段话,带 [[链接]]。\n\n- 甲\n- 乙\n\n> 引用\n\n---\n\n```js\nconst x = 1;\n```\n';
    assert.equal(roundTrip(src), src);
});

test('替换某一块只动那一段,其余原样', () => {
    const src = '# 标题\n\n- 甲\n- 乙\n- 丙';
    const bs = splitBlocks(src);
    // 0:'# 标题' 1:'' 2:'- 甲' 3:'- 乙' 4:'- 丙'
    assert.equal(replaceBlock(src, bs[2], '- 甲改过了'), '# 标题\n\n- 甲改过了\n- 乙\n- 丙');
});

test('替换保留用户原有的列表符号(不重排)', () => {
    const src = '* 甲\n* 乙';
    const bs = splitBlocks(src);
    const next = replaceBlock(src, bs[1], '* 乙改了');
    assert.ok(next.startsWith('* 甲'), '没被碰过的那一项必须保持原样');
    assert.equal(next, '* 甲\n* 乙改了');
});

test('替换成多行也正常', () => {
    const src = '甲\n\n乙';
    const bs = splitBlocks(src);
    assert.equal(replaceBlock(src, bs[0], '甲\n甲续'), '甲\n甲续\n\n乙');
});

test('按偏移找块', () => {
    const src = '甲\n\n乙';
    const bs = splitBlocks(src);        // 0:'甲' 1:'' 2:'乙'
    assert.equal(blockIndexAt(bs, 0), 0);
    assert.equal(blockIndexAt(bs, bs[1].start), 1, '空行块自己的位置要能命中它');
    assert.equal(blockIndexAt(bs, bs[2].start), 2);
    assert.equal(blockIndexAt(bs, 99999), -1);
});

test('按下标找块:块与块之间的换行归到前一块', () => {
    const src = '甲\n\n乙';
    const bs = splitBlocks(src);
    assert.equal(blockIndexForCaret(bs, 1), 0, '第 0 行末尾那个换行属于第 0 块');
    assert.equal(blockIndexForCaret(bs, bs[2].start + 1), 2);
});

test('按光标位置找块:没有块时返回 -1', () => {
    assert.equal(blockIndexForCaret([], 0), -1);
});

test('isThematicBreak 认三种符号,不误判列表项', () => {
    assert.equal(isThematicBreak('---'), true);
    assert.equal(isThematicBreak('***'), true);
    assert.equal(isThematicBreak('___'), true);
    assert.equal(isThematicBreak('- - -'), true);
    assert.equal(isThematicBreak('- 甲'), false, '列表项不是分隔线');
    assert.equal(isThematicBreak('--'), false);
});

test('frontmatter 之外的正文才参与分块(由调用方剥离,这里只验正文)', () => {
    // 调用方传入的是 readFrontmatter().body,所以这里不含 --- 元数据
    assert.deepEqual(texts(splitBlocks('# 标题\n\n正文')), ['# 标题', '', '正文']);
});

test('行号是 1 起的,方便报错与跳转', () => {
    const bs = splitBlocks('甲\n\n乙');
    assert.deepEqual(bs.map(b => b.line), [1, 2, 3]);
});

test('列表与段落相邻时不会互相吞并', () => {
    const bs = splitBlocks('一段话\n- 甲\n- 乙');
    assert.deepEqual(texts(bs), ['一段话', '- 甲', '- 乙']);
    assert.deepEqual(types(bs), ['paragraph', 'list-item', 'list-item']);
});
