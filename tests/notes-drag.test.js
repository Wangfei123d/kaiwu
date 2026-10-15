import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDropTarget } from '../app/notes/notes-view.js';

// resolveDropTarget 是**纯函数**:不碰 DOM、不碰 bridge,所以能直接钉。
// 判据错了在界面上的表现是"东西去了别处"(或者没动),都很安静 —— 必须有用例。

const base = {
    dragPath: 'a/笔记.md', dragIsDir: false,
    targetPath: 'b', targetIsDir: true,
    frac: 0.5,
};

test('悬在文件夹中段 → 移进它', () => {
    const v = resolveDropTarget(base);
    assert.equal(v.kind, 'into');
    assert.equal(v.destFolder, 'b');
    assert.equal(v.reason, '');
});

test('悬在文件夹上/下 1/4 → 插到它前后(落到它的父目录)', () => {
    const up = resolveDropTarget({ ...base, frac: 0.1 });
    assert.equal(up.kind, 'sibling');
    assert.equal(up.destFolder, '', 'b 的父目录是根');

    const down = resolveDropTarget({ ...base, frac: 0.9 });
    assert.equal(down.kind, 'sibling');
    assert.equal(down.destFolder, '');
});

test('★ 拖到**一篇笔记**上 → 等同于放进那篇笔记所在的文件夹', () => {
    const v = resolveDropTarget({
        ...base, targetPath: '短剧/第3集/双向链接.md', targetIsDir: false, frac: 0.5,
    });
    assert.equal(v.kind, 'sibling', '笔记不能"装"东西,所以不是 into');
    assert.equal(v.destFolder, '短剧/第3集', '落到它所在的那个文件夹');
});

test('拖到根目录下的笔记上 → 落到笔记库根', () => {
    const v = resolveDropTarget({ ...base, targetPath: '待办.md', targetIsDir: false, frac: 0.5 });
    assert.equal(v.kind, 'sibling');
    assert.equal(v.destFolder, '');
});

test('★ 同一层内拖动被认出来(sameLevel:true)—— 这一版不做自定义排序', () => {
    const v = resolveDropTarget({
        dragPath: '阅读/读书笔记.md', dragIsDir: false,
        targetPath: '阅读/待办.md', targetIsDir: false, frac: 0.5,
    });
    assert.equal(v.kind, 'sibling');
    assert.equal(v.destFolder, '阅读');
    assert.equal(v.sameLevel, true, '要能让调用方提示"什么都没变"');
});

test('跨层拖动 sameLevel:false', () => {
    const v = resolveDropTarget({
        dragPath: '阅读/读书笔记.md', dragIsDir: false,
        targetPath: 'a/b', targetIsDir: true, frac: 0.5,
    });
    assert.equal(v.sameLevel, false);
    assert.equal(v.destFolder, 'a/b');
});

test('拖到自己身上 → 禁止', () => {
    const v = resolveDropTarget({ ...base, targetPath: 'a/笔记.md', targetIsDir: false });
    assert.equal(v.kind, 'forbidden');
    assert.match(v.reason, /自己/);
});

test('★ 把文件夹拖进它自己的子孙 → 禁止(那是个环)', () => {
    const direct = resolveDropTarget({
        dragPath: 'a', dragIsDir: true, targetPath: 'a/b', targetIsDir: true, frac: 0.5,
    });
    assert.equal(direct.kind, 'forbidden');
    assert.match(direct.reason, /子文件夹/);

    const deep = resolveDropTarget({
        dragPath: 'a', dragIsDir: true, targetPath: 'a/b/c/d', targetIsDir: true, frac: 0.5,
    });
    assert.equal(deep.kind, 'forbidden', '再深一层同样是环');
});

test('但**同级的另一个文件夹**是可以进的(别把防环写宽了)', () => {
    const v = resolveDropTarget({
        dragPath: 'a', dragIsDir: true, targetPath: 'b', targetIsDir: true, frac: 0.5,
    });
    assert.equal(v.kind, 'into');
    assert.equal(v.destFolder, 'b');
});

test('名字前缀相同但不是子孙 → 允许(别用 startsWith 裸判)', () => {
    // 'ab' 不是 'a' 的子孙(裸 startsWith('a') 会误判)
    const v = resolveDropTarget({
        dragPath: 'a', dragIsDir: true, targetPath: 'ab', targetIsDir: true, frac: 0.5,
    });
    assert.equal(v.kind, 'into', '"ab" 与 "a" 是两棵不同的子树');
});

test('根投放带:落到笔记库根;本来就在根上时 sameLevel 为真', () => {
    const fromFolder = resolveDropTarget({ ...base, rootPath: true });
    assert.equal(fromFolder.destFolder, '');
    assert.equal(fromFolder.sameLevel, false);

    const alreadyRoot = resolveDropTarget({ ...base, dragPath: '待办.md', rootPath: true });
    assert.equal(alreadyRoot.sameLevel, true);
});

test('没有正在拖的东西 → 禁止(而不是默默用空路径去移)', () => {
    assert.equal(resolveDropTarget({ ...base, dragPath: '' }).kind, 'forbidden');
    assert.equal(resolveDropTarget({ ...base, dragPath: null }).kind, 'forbidden');
});
