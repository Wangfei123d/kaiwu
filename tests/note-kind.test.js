import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    NOTE_EXT, TEXT_EXT, noteKindOf, isNotePath, isMarkdownPath, isTextPath, noteKindLabel,
} from '../app/lib/note-kind.js';

// 这一层是"家族判据"的唯一口径:主进程(读/写/改名)与渲染进程(树里点一下干什么)
// 都用它。所以两边必须 import 同一个函数 —— 这里的用例就是那条口径的合同。
//
// ⚠️ 用户这一轮的明确要求:txt **可编辑**,但**必须和 Markdown 隔开**
//    (不解析 [[链接]]、不认标签、不当 Markdown 渲染)。
//    于是判据被拆成两问,用例分别钉住:
//      isNotePath    —— 能不能读/写/改名(两种都算)
//      isMarkdownPath —— 参不参与 Markdown 语义(只有 .md)

test('扩展名常量:Markdown 与纯文本各一个', () => {
    assert.equal(NOTE_EXT, '.md');
    assert.equal(TEXT_EXT, '.txt');
});

test('noteKindOf:按扩展名分类,大小写不敏感', () => {
    assert.equal(noteKindOf('甲篇.md'), 'markdown');
    assert.equal(noteKindOf('短剧/x/剧本.TXT'), 'text');
    assert.equal(noteKindOf('a/b/剧本.docx.txt'), 'text');
    assert.equal(noteKindOf('shot-01.png'), null);
    assert.equal(noteKindOf('剧本.docx'), null);
    assert.equal(noteKindOf(''), null);
    assert.equal(noteKindOf(null), null);
    assert.equal(noteKindOf(undefined), null);
});

test('isNotePath 覆盖两种(读/写/改名那道门)', () => {
    assert.equal(isNotePath('甲.md'), true);
    assert.equal(isNotePath('甲.txt'), true);
    assert.equal(isNotePath('甲.docx'), false);
});

test('isMarkdownPath 只认 .md —— 链接图 / 标签 / frontmatter / 改标题都靠它', () => {
    assert.equal(isMarkdownPath('甲.md'), true);
    assert.equal(isMarkdownPath('甲.txt'), false, 'txt 绝不能进 Markdown 那条链');
    assert.equal(isMarkdownPath('甲.png'), false);
});

test('isTextPath 只认 .txt', () => {
    assert.equal(isTextPath('甲.txt'), true);
    assert.equal(isTextPath('甲.md'), false);
});

test('noteKindLabel:给界面看的那两个词', () => {
    assert.equal(noteKindLabel('markdown'), 'Markdown');
    assert.equal(noteKindLabel('text'), '纯文本');
    assert.equal(noteKindLabel(null), '');
});
