import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDialogFilters } from '../app/lib/dialog-filters.js';

// 原生对话框 filters 的洗法。为什么值得单测:它是**渲染进程递进来**的东西,
// 形状不对时 Electron 会抛(或弹出一个空列表的对话框),而那种失败很难从界面上看出来。

test('sanitizeDialogFilters:正常的一份原样收下(*.txt 与 .srt 两种写法都认)', () => {
    const out = sanitizeDialogFilters([
        { name: '文本与剧本', extensions: ['txt', '*.MD', '.srt', 'json'] },
    ]);
    assert.deepEqual(out, [{ name: '文本与剧本', extensions: ['txt', 'md', 'srt', 'json'] }]);
});

test('sanitizeDialogFilters:去重、去空、去形迹可疑的扩展名', () => {
    const out = sanitizeDialogFilters([
        { name: '混的', extensions: ['txt', 'TXT', '../evil', 'a/b', '  ', 'x y', 42, null] },
    ]);
    assert.deepEqual(out, [{ name: '混的', extensions: ['txt'] }],
        '重复/带分隔符/带空格的都必须丢掉,只留干净的');
});

test('sanitizeDialogFilters:星号(全部文件)是合法的', () => {
    assert.deepEqual(sanitizeDialogFilters([{ name: '全部文件', extensions: ['*'] }]),
        [{ name: '全部文件', extensions: ['*'] }]);
});

test('sanitizeDialogFilters:没名字、没扩展名、不是对象的项整条丢掉', () => {
    const out = sanitizeDialogFilters([
        { name: '', extensions: ['txt'] },
        { name: '空的', extensions: [] },
        { name: '全是脏的', extensions: ['..', '/'] },
        'junk',
        null,
        { name: '好的', extensions: ['md'] },
    ]);
    assert.deepEqual(out, [{ name: '好的', extensions: ['md'] }]);
});

test('sanitizeDialogFilters:不是数组就回空(宁可不给过滤器,也不能塞坏的给系统对话框)', () => {
    for (const bad of [undefined, null, 'txt', 42, { name: 'x', extensions: ['txt'] }]) {
        assert.deepEqual(sanitizeDialogFilters(bad), []);
    }
});
