import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextMenuTemplate, suggestedFileName } from '../electron/context-menu.js';

// 右键菜单的**规则**用例。为什么值当写用例:它是"什么时候出现哪几项"的规则,
// 而 Electron 默认压根没有右键菜单 —— 写错了的表现是"右键没反应"或"菜单里点了没用",
// 两种都很难从界面上看出是哪里错了。
//
// ⚠️ 只测纯模板那一层(接线那一层是 Menu.buildFromTemplate + 原生弹窗,单测里没有意义)。

const noop = () => {};
const actions = { saveImage: noop, copyImageUrl: noop, openExternal: noop };
const labels = (params) => (contextMenuTemplate(params, actions) ?? []).map((i) => i.label ?? i.role);

test('图片:给保存 / 复制地址 / 浏览器打开三项', () => {
    assert.deepEqual(labels({ mediaType: 'image', srcURL: 'https://cdn.example.com/a.png' }),
        ['保存图片…', '复制图片地址', '在浏览器中打开']);
});

test('图片:点"保存图片"拿到的就是这个地址', () => {
    const got = [];
    const t = contextMenuTemplate({ mediaType: 'image', srcURL: 'https://cdn.example.com/a.png' },
        { ...actions, saveImage: (u) => got.push(u) });
    t[0].click();
    assert.deepEqual(got, ['https://cdn.example.com/a.png']);
});

test('图片:非 http(s) 的地址不给保存/打开(file:// 之类一律不认)', () => {
    for (const bad of ['file:///C:/secret.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)']) {
        assert.equal(contextMenuTemplate({ mediaType: 'image', srcURL: bad }, actions), null,
            `${bad} 不该出现任何菜单项`);
    }
});

test('可编辑区:给剪切/复制/粘贴/全选', () => {
    assert.deepEqual(labels({ isEditable: true, editFlags: { canSelectAll: true } }),
        ['剪切', '复制', '粘贴', '全选']);
});

test('可编辑区里的图片:先给图片那几项,再分隔线,再编辑项', () => {
    const t = contextMenuTemplate(
        { mediaType: 'image', srcURL: 'https://x/a.png', isEditable: true, editFlags: {} }, actions);
    assert.deepEqual(t.map((i) => i.label ?? i.role),
        ['保存图片…', '复制图片地址', '在浏览器中打开', undefined, '剪切', '复制', '粘贴', '全选']);
    assert.equal(t[3].type, 'separator');
});

test('只选中了文字:给一个"复制"', () => {
    assert.deepEqual(labels({ selectionText: '选中的一段话' }), ['复制']);
});

test('空白处右键:不弹菜单(空菜单很怪)', () => {
    assert.equal(contextMenuTemplate({}, actions), null);
    assert.equal(contextMenuTemplate({ selectionText: '   ' }, actions), null);
    assert.equal(contextMenuTemplate(null, actions), null);
});

test('另存为的默认文件名:取 URL 最后一段;取不到就给兜底名', () => {
    assert.equal(suggestedFileName('https://cdn.example.com/chatgpt/abc-123.png'), 'abc-123.png');
    assert.equal(suggestedFileName('https://cdn.example.com/a/b/图%20片.png'), '图 片.png');
    assert.equal(suggestedFileName('https://cdn.example.com/'), 'image.png');
    assert.equal(suggestedFileName('不是地址'), 'image.png');
});
