import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    TAB_BREAKPOINT_PX, TAB_RESERVED_PX, TAB_TEXT_RESERVE_PX, TAB_GAP_PX, RECENT_MAX,
    LEVEL_FULL, LEVEL_TWO, LEVEL_SHORT,
    stripMode, tabLabel, twoCharLabel, shortLabel, estimateTextWidth, chooseLevels,
    useTabKey, findTab, panesWithView, updatePane,
    addTab, activateTab, nextTab, closeTab, closeOthers, closeAll, replaceTabs, appendTabs, openInPane,
    createRecent,
} from '../app/lib/panel-tabs.js';
import {
    pane, split, tabKey, defaultTree, listPaneIds, findPane, DEFAULT_PANE_IDS, DEFAULT_SIDE_SPLIT,
} from '../app/lib/panel-tree.js';

// 面板里的标签页 —— 纯函数层。
//
// 这里钉的是"标签列表怎么变"与"标签文字怎么降级"这两件事的**数学**:
// 它们全是纯函数,DOM 那一层只负责把结果画出来。自检一次两分钟,靠它验数学太贵。
//
// ⚠️ 真身用的是 panel-tree.js 的那一份 tabKey(标签身份 = 视图 + 文档实例)。
// 这里显式注入它:一是证明"注入的那个真的生效",二是不让本模块自己写一份影子实现
// 悄悄和真身岔开(岔了的话"同一篇笔记只开一个标签"这条规则就形同虚设)。
useTabKey(tabKey);

const four = () => split('row', [19, 62, 19], [
    pane('notes'),
    pane('doc', [{ view: 'doc', doc: '甲篇.md' }], 0),
    split('col', DEFAULT_SIDE_SPLIT, [pane('links'), pane('ai')]),
]);

const J = (x) => JSON.stringify(x);

/** 整棵树里所有标签的实例身份(用来断言"同一实例不会存在两份")。 */
const tabKeyOfAll = (tree) => {
    const out = [];
    const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'pane') { for (const t of n.tabs ?? []) out.push(tabKey(t)); return; }
        for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
    return out;
};

// ---- 两段式:220px 阈值 ----

test('stripMode:可用宽度 < 220 → 下拉;≥ 220 → 胶囊;量不到时按最窄画', () => {
    assert.equal(TAB_BREAKPOINT_PX, 220, '阈值就是产品拍板的 220px');
    assert.equal(stripMode(219), 'dropdown');
    assert.equal(stripMode(220), 'capsule');
    assert.equal(stripMode(221), 'capsule');
    assert.equal(stripMode(0), 'dropdown', '首帧 clientWidth=0 → 先按最窄画(下一帧再按真实宽度)');
    assert.equal(stripMode(NaN), 'dropdown');
    assert.equal(stripMode(undefined), 'dropdown');
    assert.equal(stripMode(-5), 'dropdown');
});

// ---- 三级缩写 ----

test('标签文字三级:全名 → 前 2 字+… → 首字(短名字不加省略号,拉丁名字取两个字母)', () => {
    // 第一级就是全名本身
    assert.equal(tabLabel('笔记列表', LEVEL_FULL), '笔记列表');
    // 第二级:前 2 字 + 省略号(U+2026)
    assert.equal(tabLabel('笔记列表', LEVEL_TWO), '笔记…');
    assert.equal(twoCharLabel('笔记列表'), '笔记…');
    assert.equal(twoCharLabel('链接'), '链接', '本身就 2 个字 → 不加省略号(否则反而更长)');
    assert.equal(twoCharLabel('AI 对话'), 'AI…');
    // 第三级:首字
    assert.equal(tabLabel('笔记列表', LEVEL_SHORT), '笔');
    assert.equal(shortLabel('短剧画布'), '短', '没给外壳那一份时就是首字');
    assert.equal(shortLabel('链接'), '链');
    // ⚠️ 设计稿的 VIEWS 表里 ai 的 short 是 'AI' 而不是 'A' —— 一个字面 A 在中文界面里不好认
    assert.equal(shortLabel('AI 对话'), 'AI');
    // ⚠️ 设计稿对真身那几个视图的第三级是**人工挑过的**(笔/正/剧/链/AI/纲):
    // 「笔记列表」与「笔记正文」同头,只看首字会双双退化成「笔」—— 外壳可以把这一份传进来
    assert.equal(tabLabel({ label: '笔记正文', short: '正' }, LEVEL_SHORT), '正');
    assert.equal(tabLabel({ label: '短剧画布', short: '剧' }, LEVEL_SHORT), '剧');
    assert.equal(tabLabel({ label: '笔记正文' }, LEVEL_SHORT), '笔', '没给 short 时兜底首字');
    assert.equal(tabLabel({ label: '笔记正文' }, LEVEL_FULL), '笔记正文');
    assert.equal(tabLabel({ label: '笔记正文' }, LEVEL_TWO), '笔记…');
    // 脏输入不抛、不返回 undefined
    assert.equal(tabLabel('', LEVEL_TWO), '');
    assert.equal(tabLabel(null, LEVEL_SHORT), '');
    assert.equal(tabLabel({}, LEVEL_FULL), '');
    assert.equal(typeof tabLabel('x', 99), 'string');
    assert.equal(typeof estimateTextWidth('笔记列表'), 'number');
    assert.ok(estimateTextWidth('笔记列表') > estimateTextWidth('ab'), '中日韩整宽、ASCII 半宽');
});

test('chooseLevels:按**每个标签实际分到的宽度**逐级降级(三级都真的会出现)', () => {
    // 注入一个"一字十像素"的量法,断言才不依赖字体
    const measure = (t) => String(t).length * 10;
    const names = ['笔记列表', '笔记正文', '链接', 'AI 对话'];

    // ① 很宽:全部全名
    assert.deepEqual(chooseLevels(names, 900, measure), [LEVEL_FULL, LEVEL_FULL, LEVEL_FULL, LEVEL_FULL]);
    // ② 220px(刚过阈值)、4 个标签:预算 = (180 - 9)/4 - 30 = 12.75
    //    「笔记列表」40 >「笔记…」30 > 12.75 → 首字(10 ≤ 12.75)
    const tight = chooseLevels(names, 220, measure);
    assert.deepEqual(tight, [LEVEL_SHORT, LEVEL_SHORT, LEVEL_SHORT, LEVEL_SHORT]);
    assert.equal(TAB_RESERVED_PX, 40);
    assert.equal(TAB_TEXT_RESERVE_PX, 30);
    // ⚠️ 设计稿那种写死"3 个标签 × 74px"的算法在这里给不出第三级(要 clientWidth<190,
    // 可 <220 已经走下拉了)—— 这条就是钉住第三级真的会出现,不是走不到的死代码
    assert.ok(tight.includes(LEVEL_SHORT), '第三级(首字)必须真的会用到');
    // ③ 中间宽度:预算 35 → 4 字名字降到"前 2 字…"(30 ≤ 35),2 字名字还是全名(20)
    const mid = chooseLevels(names, 309, measure);
    assert.deepEqual(mid, [LEVEL_TWO, LEVEL_TWO, LEVEL_FULL, LEVEL_TWO]);
    // ④ 标签越多,每个分到的越少(同一个宽度下 2 个 vs 6 个)
    const two = chooseLevels(['笔记列表', '笔记正文'], 350, measure);
    const six = chooseLevels(['笔记列表', '笔记正文', '链接', 'AI 对话', '短剧画布', '大纲'], 350, measure);
    assert.ok(two[0] === LEVEL_FULL && six[0] === LEVEL_SHORT,
        `标签数量真的参与计算(2 个:${J(two)} / 6 个:${J(six)})`);
    // ⑤ 人工挑过的第三级会被用上(真身那几个同头视图靠它区分):4 个标签、220px → 预算 28
    const curated = [
        { label: '笔记列表', short: '笔' }, { label: '笔记正文', short: '正' },
        { label: '链接', short: '链' }, { label: 'AI 对话', short: 'AI' },
    ];
    assert.deepEqual(chooseLevels(curated, 220, measure), [LEVEL_SHORT, LEVEL_SHORT, LEVEL_SHORT, LEVEL_SHORT]);
    assert.deepEqual(curated.map((i) => tabLabel(i, LEVEL_SHORT)), ['笔', '正', '链', 'AI'],
        '同头的两个视图在第三级不会糊成同一个字');
    // ⑥ 边界:空列表 / 0 宽度不抛
    assert.deepEqual(chooseLevels([], 500, measure), []);
    assert.equal(chooseLevels(names, 0, measure).length, names.length);
    assert.ok(chooseLevels(names, 0, measure).every((l) => l >= 0 && l <= 2));
    // ⑦ 默认量法(没注入时)也能跑:纯函数零依赖
    assert.equal(chooseLevels(['笔记列表', '链接'], 600).length, 2);
});

// ---- 树的标签操作(纯函数:返回新树,绝不改原树) ----

test('addTab:＋ = 并列(追加并激活),同一个实例已开则**激活它**而不是再开一个', () => {
    const tree = four();
    const before = J(tree);
    // ⚠️ 往 links 面板里加 **links** 不算新增 —— 它本来就开着,应当**激活**
    const same = addTab(tree, 'links', { view: 'links' });
    assert.equal(same.created, false);
    assert.equal(same.paneId, 'links');
    assert.equal(same.index, 0);

    // links 面板追加 ai → 并列,两个标签;ai 原来在另一个面板里 → **搬家**(它只有一份 DOM)
    const r2 = addTab(tree, 'links', { view: 'ai' });
    assert.equal(r2.created, true);
    assert.equal(r2.movedFrom, 'ai', 'ai 原来在另一个面板里 → 是搬家不是复制');
    assert.deepEqual(findPane(r2.tree, 'links').tabs, [{ view: 'links' }, { view: 'ai' }]);
    assert.equal(findPane(r2.tree, 'links').active, 1, '新标签成为当前标签');
    assert.deepEqual(findPane(r2.tree, 'ai').tabs, [], '搬走了 → 原面板变成空面板(面板本身还在)');
    assert.deepEqual(listPaneIds(r2.tree), listPaneIds(tree), '面板一个不多一个不少');
    assert.equal(J(tree), before, '原树一个字节都没动(纯函数)');

    // 同一个实例(视图 + 文档)已经开着 → 激活它,不新增
    const twice = addTab(r2.tree, 'links', { view: 'ai' });
    assert.equal(twice.created, false);
    assert.equal(twice.paneId, 'links');
    assert.equal(twice.index, 1);
    assert.equal(listPaneIds(twice.tree).length, 4);

    // 同一篇笔记(同型不同文档实例)算**不同**标签
    const a = addTab(tree, 'doc', { view: 'doc', doc: '乙篇.md' });
    assert.equal(a.created, true);
    assert.deepEqual(findPane(a.tree, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }]);
    // ＋ 到**别的面板**要一个已经开在别处的实例 = 把它搬过来(不是复制,也不是"跳到那边去")
    const moved = addTab(a.tree, 'notes', { view: 'doc', doc: '甲篇.md' });
    assert.equal(moved.created, true);
    assert.equal(moved.movedFrom, 'doc');
    assert.deepEqual(findPane(moved.tree, 'notes').tabs, [{ view: 'notes' }, { view: 'doc', doc: '甲篇.md' }]);
    assert.equal(findPane(moved.tree, 'notes').active, 1);
    assert.deepEqual(findPane(moved.tree, 'doc').tabs, [{ view: 'doc', doc: '乙篇.md' }], '原来那边少了一个');
    // 脏输入不抛
    assert.equal(addTab(tree, 'links', null).created, false);
    assert.equal(addTab(tree, 'links', { view: '' }).created, false);
    assert.equal(addTab(tree, '没有这个面板', { view: 'links' }).created, false);
});

test('openInPane:**点击打开的替换语义** —— 已经在本面板开着就只激活(不许把旁边的标签关掉)', () => {
    const tree = updatePane(four(), 'doc', (leaf) => {
        leaf.tabs = [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }];
        leaf.active = 1;
    });
    // ① 换一篇**没开着**的笔记 → 整份标签被替换,原标签交出来(收进最近关闭 / 撤销用)
    const r = openInPane(tree, 'doc', { view: 'doc', doc: '丙篇.md' });
    assert.equal(r.replaced.length, 2);
    assert.deepEqual(findPane(r.tree, 'doc').tabs, [{ view: 'doc', doc: '丙篇.md' }]);
    assert.equal(findPane(r.tree, 'doc').active, 0);
    assert.deepEqual(findPane(r.tree, 'notes').tabs, [{ view: 'notes' }], '别的面板一个字不动');
    assert.deepEqual(listPaneIds(r.tree), listPaneIds(tree), '面板总数不变');
    // ② 点一篇**已经在本面板开着**的笔记 → 只激活,旁边的标签不许消失
    const again = openInPane(tree, 'doc', { view: 'doc', doc: '甲篇.md' });
    assert.equal(again.activated, true);
    assert.deepEqual(again.replaced, [], '没有标签被替换掉');
    assert.deepEqual(findPane(again.tree, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }]);
    assert.equal(findPane(again.tree, 'doc').active, 0, '激活到点的那一个');
    // ③ 同一个实例开在**别的面板**时:把那一个收掉再过替换语义(否则同一实例会存在两份)
    const moved = openInPane(tree, 'links', { view: 'doc', doc: '甲篇.md' });
    assert.equal(moved.replaced.length, 2, 'links 面板自己那一个被替换 + 原来在 doc 面板里的那一个被收走');
    assert.deepEqual(findPane(moved.tree, 'links').tabs, [{ view: 'doc', doc: '甲篇.md' }]);
    assert.deepEqual(findPane(moved.tree, 'doc').tabs, [{ view: 'doc', doc: '乙篇.md' }], '同一篇不会留在两个面板里');
    assert.equal(tabKeyOfAll(moved.tree).length, new Set(tabKeyOfAll(moved.tree)).size, '同一实例不会存在两份');
    // 脏输入不抛
    assert.equal(openInPane(tree, 'doc', null).activated, false);
});

test('closeTab:× 关掉一个;关掉的若是当前标签,活动标签顺延;最后一个 → 空面板', () => {
    // ai 搬进 links 之后:面板集合与顺序都没变(空面板也还在)
    const tree = addTab(four(), 'links', { view: 'ai' }).tree;
    assert.deepEqual(listPaneIds(tree), ['notes', 'doc', 'links', 'ai']);
    const links = findPane(tree, 'links');
    assert.deepEqual(links.tabs, [{ view: 'links' }, { view: 'ai' }]);
    assert.equal(links.active, 1);

    const r = closeTab(tree, 'links', 1);
    assert.equal(r.closed.view, 'ai');
    assert.deepEqual(findPane(r.tree, 'links').tabs, [{ view: 'links' }]);
    assert.equal(findPane(r.tree, 'links').active, 0);
    assert.ok(findPane(r.tree, 'links').active < findPane(r.tree, 'links').tabs.length,
        'active 必须落在范围内');

    // 关到最后一个:纯函数**只把标签拿掉**、树形一个字不动
    // (要不要把空掉的格子整格收起,是工作台那一层的事 —— 见 panel-workspace 的 collapseIfEmpty)
    let cur = tree;
    for (let guard = 0; guard < 10 && findPane(cur, 'links').tabs.length > 0; guard++) {
        cur = closeTab(cur, 'links', 0).tree;
    }
    assert.deepEqual(findPane(cur, 'links').tabs, [], '关掉最后一个 → 标签为空');
    assert.equal(findPane(cur, 'links').active, 0);
    assert.deepEqual(listPaneIds(cur), listPaneIds(tree), '纯函数不动树形(收不收整格是上层的事)');
    // 空面板上再关:什么都不发生
    assert.equal(closeTab(cur, 'links', 0).closed, null);
    // 关当前标签时 active 跟着走:三个标签、active=2、关掉它 → active=1(最后一个)
    const three = updatePane(four(), 'doc', (leaf) => {
        leaf.tabs = [{ view: 'doc', doc: 'a.md' }, { view: 'doc', doc: 'b.md' }, { view: 'doc', doc: 'c.md' }];
        leaf.active = 2;
    });
    assert.equal(closeTab(three, 'doc', 2).tree.children[1].active, 1);
    // 关掉前面的标签:active 减一(还是同一个实例)
    assert.equal(closeTab(three, 'doc', 0).tree.children[1].active, 1);
    assert.equal(closeTab(three, 'doc', 0).tree.children[1].tabs[1].doc, 'c.md');
});

test('closeOthers / closeAll:都交出来被关掉的标签(收进最近关闭用)', () => {
    const tree = updatePane(four(), 'doc', (leaf) => {
        leaf.tabs = [{ view: 'doc', doc: 'a.md' }, { view: 'doc', doc: 'b.md' }, { view: 'links' }];
        leaf.active = 1;
    });
    const only = closeOthers(tree, 'doc', 1);
    assert.deepEqual(only.closed.map((t) => t.doc ?? t.view), ['a.md', 'links']);
    assert.deepEqual(findPane(only.tree, 'doc').tabs, [{ view: 'doc', doc: 'b.md' }]);
    assert.equal(findPane(only.tree, 'doc').active, 0, '留下的那个成为当前标签');
    // 只剩一个时"关闭其他"没有可关的 → 原树返回
    assert.equal(closeOthers(only.tree, 'doc', 0).tree, only.tree);

    const all = closeAll(tree, 'doc');
    assert.equal(all.closed.length, 3);
    assert.deepEqual(findPane(all.tree, 'doc').tabs, []);
    assert.equal(closeAll(all.tree, 'doc').tree, all.tree, '已经空了 → 原树返回');
    assert.deepEqual(listPaneIds(all.tree), listPaneIds(tree));
});

test('replaceTabs / appendTabs:点击打开的替换语义 + 撤销的追加语义', () => {
    const tree = four();
    const r = replaceTabs(tree, 'doc', [{ view: 'doc', doc: '乙篇.md' }], 0);
    assert.deepEqual(findPane(r.tree, 'doc').tabs, [{ view: 'doc', doc: '乙篇.md' }]);
    assert.deepEqual(r.replaced, [{ view: 'doc', doc: '甲篇.md' }], '被替换掉的标签交出来(进最近关闭)');
    assert.equal(J(tree).includes('乙篇'), false, '纯函数:原树没被改');
    // 撤销 = 把原来那组追加回去
    const undo = appendTabs(r.tree, 'doc', r.replaced);
    assert.deepEqual(findPane(undo.tree, 'doc').tabs, [{ view: 'doc', doc: '乙篇.md' }, { view: 'doc', doc: '甲篇.md' }]);
    assert.equal(findPane(undo.tree, 'doc').active, 1, '恢复回来的那个成为当前标签');
    assert.equal(appendTabs(tree, 'doc', []).added, 0);
});

test('activateTab / nextTab:切换与循环(只有一个标签时不动)', () => {
    const tree = updatePane(four(), 'doc', (leaf) => {
        leaf.tabs = [{ view: 'doc', doc: 'a.md' }, { view: 'doc', doc: 'b.md' }];
        leaf.active = 0;
    });
    assert.equal(activateTab(tree, 'doc', 1).children[1].active, 1);
    assert.equal(activateTab(tree, 'doc', 9).children[1].active, 0, '越界不动');
    assert.equal(activateTab(tree, 'doc', -1).children[1].active, 0);
    assert.equal(nextTab(tree, 'doc').children[1].active, 1, '切下一个');
    assert.equal(nextTab(nextTab(tree, 'doc'), 'doc').children[1].active, 0, '循环回第一个');
    assert.equal(nextTab(four(), 'notes').children[0].active, 0, '只有一个标签 → 不动');
});

test('findTab / panesWithView / updatePane:按身份查找、按视图找面板、找不到不动原树', () => {
    const tree = four();
    const hit = findTab(tree, { view: 'doc', doc: '甲篇.md' }, tabKey);
    assert.equal(hit.paneId, 'doc');
    assert.equal(hit.index, 0);
    assert.equal(findTab(tree, { view: 'doc', doc: '乙篇.md' }, tabKey), null);
    assert.equal(findTab(tree, { view: '不存在' }, tabKey), null);
    assert.deepEqual(panesWithView(tree, 'doc'), ['doc']);
    assert.deepEqual(panesWithView(tree, 'ai'), ['ai']);
    assert.deepEqual(panesWithView(tree, '没有'), []);
    assert.equal(updatePane(tree, '没有这个面板', () => { throw new Error('不该被调用'); }), tree);
    // 去重 + active 夹回都在 updatePane 里兜住
    const dirty = updatePane(tree, 'doc', (leaf) => {
        leaf.tabs = [{ view: 'doc', doc: 'a.md' }, { view: 'doc', doc: 'a.md' }, { view: '' }];
        leaf.active = 7;
    });
    assert.deepEqual(findPane(dirty, 'doc').tabs, [{ view: 'doc', doc: 'a.md' }]);
    assert.equal(findPane(dirty, 'doc').active, 0);
});

// ---- 最近关闭 ----

test('最近关闭:每个面板一份、先进后出、同一个实例只留最近一次、超出上限丢最旧的', () => {
    const recent = createRecent();
    assert.equal(RECENT_MAX, 3, '设计稿 route-demo 的上限就是 3');
    recent.push('doc', { view: 'doc', doc: '甲篇.md' });
    recent.push('doc', { view: 'doc', doc: '乙篇.md' });
    assert.equal(recent.peek('doc').doc, '乙篇.md', '最近的是最后推进去的那个');
    assert.deepEqual(recent.list('doc').map((t) => t.doc), ['乙篇.md', '甲篇.md']);
    // 再来一个已经在栈里的:去重后置顶
    recent.push('doc', { view: 'doc', doc: '甲篇.md' });
    assert.deepEqual(recent.list('doc').map((t) => t.doc), ['甲篇.md', '乙篇.md']);
    // 上限
    recent.push('doc', { view: 'doc', doc: '丙篇.md' });
    recent.push('doc', { view: 'doc', doc: '丁篇.md' });
    assert.equal(recent.list('doc').length, RECENT_MAX);
    assert.deepEqual(recent.list('doc').map((t) => t.doc), ['丁篇.md', '丙篇.md', '甲篇.md']);
    // 面板各一份
    recent.push('links', { view: 'links' });
    assert.equal(recent.peek('links').view, 'links');
    assert.equal(recent.peek('doc').doc, '丁篇.md', '另一个面板的栈不受影响');
    assert.equal(recent.peek('没有这个面板'), null);
    // pop 弹出;peek 不弹(恢复失败时不该把它吃掉)
    assert.equal(recent.pop('doc').doc, '丁篇.md');
    assert.equal(recent.pop('doc').doc, '丙篇.md');
    assert.equal(recent.peek('doc').doc, '甲篇.md');
    // pushAll(关闭全部时,后关的在上)
    recent.pushAll('ai', [{ view: 'ai' }, { view: 'links' }]);
    assert.deepEqual(recent.list('ai').map((t) => t.view), ['links', 'ai']);
    recent.clear('ai');
    assert.deepEqual(recent.list('ai'), []);
    // 脏输入不抛
    assert.doesNotThrow(() => {
        recent.push('doc', null);
        recent.push('', { view: 'notes' });
        recent.pop('没有');
    });
});

test('默认的标签身份实现与 panel-tree 的 tabKey 同口径(注入的那个真的生效)', () => {
    // 本模块自带一份兜底实现(零依赖),外壳会注入 panel-tree 的那一份。
    // 两者的口径必须一致,否则"同一篇笔记只开一个标签"会在两条路径上给出不同答案。
    const samples = [
        { view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' },
        { view: 'links' }, { view: 'links' }, { view: 'doc' },
    ];
    for (const t of samples) assert.equal(typeof tabKey(t), 'string');
    // 用注入后的实现查找:同一篇找到、另一篇找不到
    assert.equal(findTab(four(), samples[0], tabKey).paneId, 'doc');
    assert.equal(findTab(four(), samples[1], tabKey), null);
    // 不带参数的 useTabKey 不该把实现弄坏(仍然按内置的那一份兜底 = panel-tree 的同口径)
    useTabKey(undefined);
    assert.equal(findTab(defaultTree(), { view: 'doc' }, tabKey).paneId, 'doc');
    useTabKey(tabKey);
});

test('端到端:一个面板里的多标签经过"关闭 → 最近关闭 → 恢复"仍然对得上', () => {
    let tree = four();
    tree = replaceTabs(tree, 'doc', [{ view: 'doc', doc: '甲篇.md' }], 0).tree;
    tree = addTab(tree, 'doc', { view: 'links' }).tree;
    assert.deepEqual(findPane(tree, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }]);
    const recent = createRecent();
    const closed = closeTab(tree, 'doc', 1);
    recent.push('doc', closed.closed);
    assert.deepEqual(findPane(closed.tree, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }]);
    // Ctrl+Shift+T:恢复
    assert.deepEqual(recent.pop('doc'), { view: 'links' });
    const restored = addTab(closed.tree, 'doc', { view: 'links' }).tree;
    assert.deepEqual(findPane(restored, 'doc').tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }]);
    assert.equal(findPane(restored, 'doc').active, 1);
    assert.deepEqual(listPaneIds(restored), listPaneIds(four()), '面板集合与顺序自始至终没变');
});
