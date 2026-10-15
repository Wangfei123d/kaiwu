// 「窗口」菜单那份面板表的回归:用户档里**明明开着却显示没勾**。
//
// 真实故障(用户报的):面板里短剧项目开着,「窗口」菜单里那一条却没有勾,
// 而且点一下还会再开出第二份。根因不在菜单模板(它对每条都照 `open` 画勾),
// 在**判"开没开"的口径**:v4 起 `pane.id` 只是**槽位键**,标签一旦被拖进别的格子,
// 视图就住在 id 完全不同的格里 —— 按槽位 id 判就会给出错的答案。
// 下面第一棵树**逐字取自用户机器上的布局存档**(只是把笔记路径换成了占位符)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelMenuTable, splitPanelMenuTables } from '../app/lib/panel-menu-table.js';
import { viewsOpenIn, addPane, listPaneIds, findPane } from '../app/lib/panel-tree.js';
import { buildMenuTemplate } from '../electron/app-menu.js';

/** 用户真实档的结构:四个格子,其中两格的 id 与它们装的**视图**完全不同名。 */
const userTree = () => ({
    dir: 'row',
    sizes: [18.29, 35.13, 21.58, 25],
    children: [
        {
            dir: 'col',
            sizes: [76.6, 23.4],
            children: [
                { type: 'pane', id: 'notes', tabs: [{ view: 'notes' }, { view: 'ai-session' }, { view: 'drama-projects' }], active: 2 },
                { type: 'pane', id: 'slot:2', tabs: [{ view: 'links' }], active: 0 },
            ],
        },
        { type: 'pane', id: 'drama', tabs: [{ view: 'doc', doc: '短剧/某项目/inputs/稿子.md' }], active: 0 },
        { type: 'pane', id: 'ai', tabs: [{ view: 'ai' }], active: 0 },
        { type: 'pane', id: 'slot:3', tabs: [{ view: 'drama' }], active: 0 },
    ],
});

const TITLES = {
    notes: '笔记列表', doc: '笔记正文', links: '链接', ai: 'AI 对话',
    'ai-session': 'AI 会话', drama: '短剧画布', 'drama-projects': '短剧项目',
};
const knownIds = ['notes', 'doc', 'links', 'ai', 'ai-session', 'drama', 'drama-projects'];
const tableOf = (tree) => panelMenuTable({ knownIds, titleOf: (id) => TITLES[id], tree });

test('★ 用户档:住在别的格子里的视图,也算"开着"(短剧项目住在 notes 格、短剧画布住在 slot:3 格)', () => {
    const open = viewsOpenIn(userTree());
    for (const id of ['notes', 'ai-session', 'drama-projects', 'links', 'doc', 'ai', 'drama']) {
        assert.equal(open.has(id), true, `${id} 明明在窗口里开着`);
    }
    // 反例钉一下:这不是"什么都说开着"
    assert.equal(open.has('不存在的视图'), false);
});

test('★ 用户档 → 面板表:开着的那几条 open=true,**看得见**的只有每格当前标签那一个', () => {
    const table = tableOf(userTree());
    const byId = Object.fromEntries(table.map((r) => [r.id, r.open]));
    assert.deepEqual(byId, {
        notes: true, doc: true, links: true, ai: true,
        'ai-session': true, drama: true, 'drama-projects': true,
    });
    // ⚠️ 这就是"笔记列表呢"那件事:`notes` 那一格塞了三个标签、当前显示的是第三个(短剧项目),
    //    所以笔记列表**开着但看不见** —— 菜单必须让它可点(点了切到眼前),不能勾着又点不动。
    const active = Object.fromEntries(table.map((r) => [r.id, r.active]));
    assert.deepEqual(active, {
        notes: false, 'ai-session': false, 'drama-projects': true,   // 同一格里,只有当前那个看得见
        links: true, doc: true, ai: true, drama: true,
    });
    // 标签来自注册表(菜单里显示的是中文名,不是 id)
    assert.equal(table.find((r) => r.id === 'drama-projects').label, '短剧项目');
});

test('★ 用户档 → 菜单:「笔记列表」勾着但**可点**(它就是用户要救回来的那一条)', () => {
    const tpl = buildMenuTemplate({ platform: 'win32', views: tableOf(userTree()) });
    const items = tpl.find((m) => m.label === '窗口').submenu
        .filter((i) => typeof i.id === 'string' && i.id.startsWith('kaiwu-panel-'));
    assert.equal(items.length, knownIds.length);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    for (const id of knownIds) {
        assert.equal(byId[`kaiwu-panel-${id}`].type, 'checkbox');
        assert.equal(byId[`kaiwu-panel-${id}`].checked, true, `${id} 开着 → 打勾`);
    }
    assert.equal(byId['kaiwu-panel-notes'].enabled, true, '笔记列表只是藏着 → 必须可点');
    assert.equal(byId['kaiwu-panel-ai-session'].enabled, true, 'AI 会话同理');
    assert.equal(byId['kaiwu-panel-drama-projects'].enabled, false, '正显示着 → 点不动');
    assert.equal(byId['kaiwu-panel-doc'].enabled, false, '笔记正文正显示着 → 点不动');
    assert.equal(byId['kaiwu-panel-drama'].enabled, false, '短剧画布正显示着 → 点不动');
});

test('菜单状态表:工具面板独立分组,不进入普通面板列表,只收已登记的工作台工具', () => {
    const groups = splitPanelMenuTables({
        knownIds: ['notes', 'tool:palette:palette'],
        tools: [
            { pluginId: 'palette', id: 'palette', workspacePane: true },
            { pluginId: 'hello', id: 'hello', workspacePane: false },
            { pluginId: 'gone', id: 'gone', workspacePane: true },
        ],
        titleOf: (id) => ({
            notes: '笔记列表',
            'tool:palette:palette': '调色板 & 渐变',
            'tool:hello:hello': '单文件示例',
        })[id],
        tree: userTree(),
    });

    assert.deepEqual(groups.views.map((row) => row.id), ['notes']);
    assert.deepEqual(groups.tools.map((row) => row.id), ['tool:palette:palette']);
    assert.equal(groups.tools[0].label, '调色板 & 渐变');
    assert.equal(groups.views.some((row) => row.id === 'tool:palette:palette'), false);
});

test('★ 视图名被别的格子占着时,新开的那一格发 slot:<序号>(树上不许出现两个同名 id)', () => {
    const tree = userTree();
    // 用户档里 `drama` 这个 id 被"笔记正文"那格占着,而短剧画布视图本身在 slot:3 ——
    // 先把它关掉(模拟用户关掉短剧画布),再走菜单"新加一格"这条路。
    const closed = {
        ...tree,
        children: tree.children.filter((c) => c.id !== 'slot:3'),
    };
    assert.equal(viewsOpenIn(closed).has('drama'), false, '短剧画布视图确实关掉了');
    const next = addPane(closed, 'drama', { anchorId: 'notes', dir: 'row', side: 'right' });
    assert.notEqual(next, null);
    const ids = listPaneIds(next);
    assert.equal(new Set(ids).size, ids.length, `槽位 id 不许重复:${ids.join(' / ')}`);
    assert.equal(findPane(next, 'drama').tabs[0].view, 'doc', '原来那格仍是笔记正文,没被改名');
    const freshId = ids.find((id) => id.startsWith('slot:'));
    assert.ok(freshId !== undefined, '新格用 slot:<序号>');
    assert.equal(findPane(next, freshId).tabs[0].view, 'drama', '新格里装的才是短剧画布');
});

test('视图名没被占用时:新格仍然直接用视图名当槽位 id(与老档一致,不无谓改名)', () => {
    const tree = { type: 'pane', id: 'notes', tabs: [{ view: 'notes' }], active: 0 };
    const next = addPane(tree, 'drama', { anchorId: 'notes', dir: 'row', side: 'right' });
    assert.ok(listPaneIds(next).includes('drama'));
});

// 追加两条:**判据不许退回按槽位 id 判**(源码级契约 + 有牙)。
// 为什么要有这一条:纯函数本身测不出"调用方用没用它" ——
// 而这次的真实故障正是**调用方**那一行(`open: listPaneIds(tree).includes(id)`)。
// 只测 viewsOpenIn 的话,哪天有人把那行改回去,测试会全绿而菜单又开始骗人。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(HERE, '..', 'app', 'main.js');

/** 调用方是否守着"按视图判"这条口径(见上面第一棵树那个故障)。 */
const viewBasedOpenOk = (src) => src.includes('panelMenuTable(')
    || src.includes('splitPanelMenuTables(')
    ? !/listPaneIds\(tree\)\s*\.includes/.test(src)
        && !/open:\s*onTree\.includes/.test(src)
    : false;

test('★ 调用方:上报面板表必须走 panelMenuTable(不许退回"按槽位 id 判")', () => {
    assert.equal(viewBasedOpenOk(fs.readFileSync(MAIN_JS, 'utf8')), true);
});

test('上面那条**有牙**:把判据换回旧的写法,必须变红', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const bogus = src.replace('splitPanelMenuTables(', 'listPaneIds(tree).includes(');
    assert.notEqual(bogus, src, '替身必须真的改到了东西');
    assert.equal(viewBasedOpenOk(bogus), false);
});
