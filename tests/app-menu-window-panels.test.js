// 「窗口」菜单里列出**程序目前所有的面板**:点一条 = 把它弄到眼前。
//
// 为什么单独一个文件:菜单模板是纯函数(见 electron/app-menu.js 的头注释),
// 这几条断言全在"模板长什么样",不碰 Electron,也不需要真窗口。
//
// ⚠️ 三态是**必须**的(实测踩过):一格能塞好几个标签,「开着」与「看得见」不是一回事。
//    用户那格里塞着「笔记列表 / AI 会话 / 短剧项目」,当前显示第三个 —— 菜单却给笔记列表
//    打了勾又点不动,于是用户的原话是"笔记列表呢"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate } from '../electron/app-menu.js';

const windowMenuOf = (tpl) => tpl.find((m) => m.label === '窗口');
const panelItemsOf = (tpl) => windowMenuOf(tpl).submenu
    .filter((i) => typeof i.id === 'string' && i.id.startsWith('kaiwu-panel-'));
const toolMenuOf = (tpl) => windowMenuOf(tpl).submenu.find((i) => i.label === '工具');

test('窗口菜单:每个面板一条,id 带前缀(能按 id 找到,才好只改勾不重建)', () => {
    const tpl = buildMenuTemplate({ platform: 'win32', views: [
        { id: 'notes', label: '笔记列表', open: false },
        { id: 'doc', label: '笔记正文', open: false },
        { id: 'drama', label: '短剧画布', open: false },
    ] });
    const items = panelItemsOf(tpl);
    assert.deepEqual(items.map((i) => i.label), ['笔记列表', '笔记正文', '短剧画布']);
    assert.deepEqual(items.map((i) => i.id),
        ['kaiwu-panel-notes', 'kaiwu-panel-doc', 'kaiwu-panel-drama']);
    assert.ok(items.every((i) => i.type === 'checkbox'), '用原生 checkbox:两套系统外观都跟着走');
});

test('★ 三态:没开 → 新加一格;开着但藏着 → 切到眼前(可点!);正显示着 → 点不动', () => {
    const calls = [];
    const tpl = buildMenuTemplate({ platform: 'win32', onAddView: (id) => calls.push(id), views: [
        { id: 'notes', label: '笔记列表', open: true, active: false },      // 只是某格里的非活动标签
        { id: 'ai', label: 'AI 对话', open: true, active: true },           // 正显示着
        { id: 'links', label: '链接', open: false, active: false },         // 没开
    ] });
    const [hidden, showing, closed] = panelItemsOf(tpl);

    assert.equal(hidden.checked, true, '开着(哪怕藏着)→ 打勾');
    assert.equal(hidden.enabled, true, '★ 藏着的那条**必须可点**:点它要把它切到眼前');
    assert.equal(showing.checked, true, '正显示着 → 打勾');
    assert.equal(showing.enabled, false, '正显示着 → 点不动(它已经在眼前了)');
    assert.equal(closed.checked, false);
    assert.equal(closed.enabled, true, '没开 → 可点(新加一格)');

    hidden.click();
    assert.deepEqual(calls, ['notes'], '点"藏着的那条" → 回调拿到它的 id(渲染层据此切到眼前)');
    showing.click();
    assert.deepEqual(calls, ['notes'], '点"正显示着的那条" → 什么都不发生');
    closed.click();
    assert.deepEqual(calls, ['notes', 'links'], '点"没开的那条" → 回调拿到它的 id(渲染层据此新加一格)');
});

test('没给 active 时:开着也**允许点** —— 点了走"切到眼前",已经在眼前时那一步是空操作', () => {
    // 为什么不做成"没给 active 就点不动":那正是用户踩到的死局(勾着、却怎么点都没反应)。
    // "切到眼前"对**已经看得见**的视图是空操作(激活同一枚标签),所以放开是安全的。
    const calls = [];
    const tpl = buildMenuTemplate({ platform: 'win32', onAddView: (id) => calls.push(id), views: [
        { id: 'notes', label: '笔记列表', open: true },
    ] });
    const [item] = panelItemsOf(tpl);
    assert.equal(item.checked, true);
    assert.equal(item.enabled, true);
    item.click();
    assert.deepEqual(calls, ['notes']);
});

test('没有视图表时:窗口菜单与从前**逐条一致**(不出现空的一段)', () => {
    const tpl = buildMenuTemplate({ platform: 'win32' });
    assert.equal(panelItemsOf(tpl).length, 0);
    assert.deepEqual(windowMenuOf(tpl).submenu.map((i) => i.label).filter(Boolean),
        ['最小化', '关闭窗口']);
    const mac = buildMenuTemplate({ platform: 'darwin' });
    assert.deepEqual(windowMenuOf(mac).submenu.map((i) => i.label).filter(Boolean),
        ['最小化', '缩放', '前置全部窗口']);
});

test('面板段落在窗口操作**上面**(新功能在前,窗口操作在后),中间有分隔', () => {
    const tpl = buildMenuTemplate({ platform: 'win32', views: [{ id: 'notes', label: '笔记列表' }] });
    const labels = windowMenuOf(tpl).submenu.map((i) => i.label ?? i.type);
    assert.deepEqual(labels, ['笔记列表', 'separator', '最小化', '关闭窗口']);
});

test('窗口 → 工具:按注册顺序列出独立工具子菜单,并复用面板打开回调', () => {
    const calls = [];
    const tpl = buildMenuTemplate({ platform: 'win32', onAddView: (id) => calls.push(id),
        tools: [
            { id: 'tool:palette:palette', label: '调色板 & 渐变', open: false, active: false },
            { id: 'tool:subtitle:subtitle', label: '字幕格式互转', open: true, active: false },
        ],
        views: [{ id: 'notes', label: '笔记列表', open: false, active: false }],
    });
    const toolMenu = toolMenuOf(tpl);
    assert.ok(toolMenu, '窗口菜单包含工具子菜单');
    assert.deepEqual(toolMenu.submenu.map((item) => item.label), ['调色板 & 渐变', '字幕格式互转']);
    assert.deepEqual(toolMenu.submenu.map((item) => item.id),
        ['kaiwu-tool-tool:palette:palette', 'kaiwu-tool-tool:subtitle:subtitle']);
    assert.equal(toolMenu.submenu[1].checked, true, '打开但隐藏的工具已勾选');
    assert.equal(toolMenu.submenu[1].enabled, true, '打开但隐藏的工具仍可聚焦');
    toolMenu.submenu[0].click();
    toolMenu.submenu[1].click();
    assert.deepEqual(calls, ['tool:palette:palette', 'tool:subtitle:subtitle']);
    assert.equal(panelItemsOf(tpl).some((item) => item.label === '调色板 & 渐变'), false,
        '工具项不会重复进入普通面板区');
});

test('窗口 → 工具:活动工具勾选且禁用,空工具组不产生空菜单或多余分隔', () => {
    const tpl = buildMenuTemplate({ platform: 'win32', tools: [
        { id: 'tool:music:music', label: '音乐试听', open: true, active: true },
    ] });
    const item = toolMenuOf(tpl).submenu[0];
    assert.equal(item.type, 'checkbox');
    assert.equal(item.checked, true);
    assert.equal(item.enabled, false);

    const empty = buildMenuTemplate({ platform: 'win32', views: [], tools: [] });
    assert.equal(toolMenuOf(empty), undefined);
    assert.deepEqual(windowMenuOf(empty).submenu.map((item) => item.label ?? item.type),
        ['最小化', '关闭窗口']);
});
