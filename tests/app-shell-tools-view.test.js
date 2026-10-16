import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');

test('主视图不再保留工具栏、侧栏或共享工具内容区', () => {
    for (const id of ['viewTools', 'paneTools', 'toolList', 'pluginErrors', 'content']) {
        assert.equal(html.includes(`id="${id}"`), false, `index.html 不应再有 ${id}`);
    }
    assert.doesNotMatch(main, /createSidebar|createContent/);
});

test('原生菜单仍可按已登记视图打开工作台面板,菜单状态按普通项与工具项分组', () => {
    assert.match(main, /splitPanelMenuTables\(/);
    assert.match(main, /bridge\.reportPanels\(\w+\.views,\s*\w+\.tools\)/);
    assert.match(main, /bridge\.onAddPanel\(/);
    assert.match(main, /openWorkspacePanel/);
});

test('打开工具面板在常驻笔记工作台中聚焦新建视图', () => {
    const start = main.indexOf('function openWorkspacePanel(viewId) {');
    const end = main.indexOf('bridge.onAddPanel(openWorkspacePanel)', start);
    assert.ok(start >= 0 && end > start, '存在唯一的窗口菜单面板处理器');
    const opener = main.slice(start, end);
    assert.doesNotMatch(opener, /onOpenPanel/);
    assert.match(opener, /workspace\.applyTree\(next\)[\s\S]*workspace\.focusView\(viewId\)/);
    assert.match(main, /paneNotes/);
    assert.doesNotMatch(main, /switchView\(/);
});
