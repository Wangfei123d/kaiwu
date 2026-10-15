import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_RATIO, DEFAULT_PANE_IDS, DEFAULT_SIDE_SPLIT, PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI,
    PANE_SIDE, LEGACY_PANE_SPLITS,
    pane, split, isPane, isSplit, normalizeSizes, defaultTree, treeFromWidths, cloneTree,
    listPaneIds, countPanes, findPane, findParent, pathTo, nodeAtPath, formatTree, normalizeTree, validateLayout,
    migrateLegacyTree, migrateV2Tabs, normalizeTabs, tabKey, adoptPanes, DEFAULT_ADOPTION,
    detach, swapPanes, dropOnEdge, dockBottom, setPairRatio, pairSizesFromPx, pairSizesFromDrag,
    moveTabToPane, moveTabToEdge, addPane,
    nextSlotSeq, tabKeysOf,
} from '../app/lib/panel-tree.js';

// 平铺可停靠面板的**树模型**。规格是已批准的 demo(docs/kaiwu-dock-demo.html):
// 落点判定、摘走后的折叠、拖分隔条只动相邻两片 —— 这些全是"树怎么变"的数学。
// 这里钉的就是这些数学,一条 DOM 都不碰。

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

/** 四片:左边一片 a,右边一个上下分割 [b, c] —— 折叠那条规则要靠它验。 */
const A = 'a', B = 'b', C = 'c', D = 'd';
const four = () => split('row', [30, 70], [
    pane(A),
    split('col', [40, 60], [pane(B), pane(C)]),
]);

// ---- 拖标签跨面板 + 不允许空面板(用户选的方案 B)----
// 为什么在这里钉:这两条规则的难点全在"树怎么变",与指针无关。搬一枚、源格空了、
// 空间给谁 —— 全是纯数学,能在 node 里一眼钉死。

/** 三格一行,比例 40/35/25;a 两枚、b 两枚、c 一枚 —— 搬标签要靠它验。 */
const threeWide = () => {
    const t = split('row', [40, 35, 25], [pane('a'), pane('b'), pane('c')]);
    t.children[0].tabs = [{ view: 'a1' }, { view: 'a2' }];
    t.children[0].active = 1;
    t.children[1].tabs = [{ view: 'b1' }, { view: 'b2' }];
    t.children[1].active = 0;
    t.children[2].tabs = [{ view: 'c1' }];
    t.children[2].active = 0;
    return t;
};

test('搬标签:插到指定位置 + 目标当前就显示它 + 源格还在时比例一个字不动', () => {
    const out = moveTabToPane(threeWide(), 'a', 1, 'c', 0);
    assert.deepEqual(findPane(out, 'c').tabs.map((t) => t.view), ['a2', 'c1'], '插在第 0 位');
    assert.equal(findPane(out, 'c').active, 0, '搬完就显示它');
    assert.deepEqual(findPane(out, 'a').tabs.map((t) => t.view), ['a1']);
    assert.deepEqual(out.sizes, [40, 35, 25], '源格没空 → 比例不动');
});

test('搬标签:insertAt 为 null = 追加到末尾,并把 source 的 active 顺移', () => {
    const out = moveTabToPane(threeWide(), 'a', 0, 'b');
    assert.deepEqual(findPane(out, 'b').tabs.map((t) => t.view), ['b1', 'b2', 'a1']);
    assert.equal(findPane(out, 'b').active, 2);
    assert.equal(findPane(out, 'a').active, 0, '搬走的是它前面的那枚 → 当前下标顺移');
});

test('★ 不允许空面板:搬走最后一枚 → 整格消失,空间**整块给邻居**(方案 B)', () => {
    // 先搬掉 a 的第 2 枚(a 还剩 1 枚),再把最后那枚也搬走 → a 必须消失
    const mid = moveTabToPane(threeWide(), 'a', 1, 'c');
    const out = moveTabToPane(mid, 'a', 0, 'c');
    assert.deepEqual(listPaneIds(out), ['b', 'c'], 'a 整格消失,页面里不留空格子');
    // ⚠️ 读数在"detach 的 neighbor 量纲"这一轮**改回来过**:曾经断言 70.24 / 29.76,
    // 那是"摘完之后先把兄弟们按剩余比例放大、再把 removedSize 加给邻居"的产物 ——
    // 那条路径等于把腾出来的空间**发了两遍**,连没被牵动的 c 都从 35 涨到 29.76 的相对值。
    // 规格 §4.3 第 6 条要的是"不改变未涉及分支的比例"、§7 第 2 条要的是"**只**把腾出空间
    // 给相邻槽位",所以正确读数是:b 拿到 a 原来的 40(35+40=75),c 的 25 一个字不动。
    assert.ok(near(out.sizes[0], 75, 0.02), `邻居拿到整块 40:b=${out.sizes[0]}`);
    assert.ok(near(out.sizes[1], 25, 0.02), `未涉及的 c 一个字不动:c=${out.sizes[1]}`);
    assert.equal(sum(out.sizes), 100);
});

test('★ 同一条路径,space=proportional 就是另一条规则(A):两格都变大', () => {
    const mid = moveTabToPane(threeWide(), 'a', 1, 'c');
    const out = moveTabToPane(mid, 'a', 0, 'c', null, { space: 'proportional' });
    assert.deepEqual(listPaneIds(out), ['b', 'c']);
    assert.ok(near(out.sizes[0], 58.33), `按比例摊:b=${out.sizes[0]}`);
    assert.ok(near(out.sizes[1], 41.67), `c 也变大=${out.sizes[1]}`);
});

test('搬标签:原地不动 / 找不到 id / 下标越界 都返回 null(调用方保持旧树)', () => {
    assert.equal(moveTabToPane(threeWide(), 'a', 0, 'a'), null);
    assert.equal(moveTabToPane(threeWide(), 'a', 0, 'zz'), null);
    assert.equal(moveTabToPane(threeWide(), 'a', 9, 'c'), null);
});

// ---- 单标签边缘停靠(moveTabToEdge,契约 v4:一枚标签 = 一个面板)----
//
// 规格(docs 里已批准的那份)§4.3:边缘投放只搬**一枚标签**,为它新建一个槽位插到目标四边。
// ⚠️ 它与 `dropOnEdge` 是两件事:后者搬的是**整片叶子**(整组面板),那是被明令禁止的手势。
// 所以这里钉的第一条就是"源栈剩下的标签与 active 一个字不动" —— 别让整片拖动借尸还魂。

/** 三格一行 + 文档槽位里两篇笔记:`slot:<n>` 槽位 id 与视图名**不再等价**的判据。 */
const edgeTree = () => split('row', [23, 51, 26], [
    pane('slot:7', [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }], 0),
    pane('slot:1', [{ view: 'notes' }], 0),
    pane('links'),
]);

/** 树里所有的槽位 id(顺序即从左到右 / 从上到下)。 */
const slotIds = (t) => listPaneIds(t);
/** 树里除 fixtures 那三个槽位之外的新槽位 id(新拆出来那一个)。 */
const freshIdOf = (t) => listPaneIds(t).filter((i) => !['slot:7', 'slot:1', 'links', 'notes'].includes(i))[0] ?? null;

test('边缘停靠:放一枚标签到目标右侧,源栈其余的标签与 active 一个字不动', () => {
    const t = edgeTree();
    const out = moveTabToEdge(t, 'slot:7', 0, 'links', 'right');
    assert.ok(out, '合法的边缘投放要返回新树');
    // 新槽位在目标右边、只装着被拖的那一枚
    const freshId = freshIdOf(out);
    const fresh = findPane(out, freshId);
    assert.deepEqual(fresh.tabs, [{ view: 'doc', doc: '甲篇.md' }]);
    assert.equal(fresh.active, 0, '新槽位只有一枚、它就是当前标签');
    assert.equal(isPane(fresh), true);
    assert.deepEqual(slotIds(out).slice(2), ['links', freshId], `新槽位排在 links 右边:${slotIds(out)}`);
    // 源槽位还在(它还剩一枚),剩下的那枚与它的 active 都没动
    const src = findPane(out, 'slot:7');
    assert.deepEqual(src.tabs, [{ view: 'doc', doc: '乙篇.md' }], '只有被拖的那一枚被取走');
    assert.equal(src.active, 0, '取走的是 active 之前那枚 → active 顺移回 0,而且指的是乙篇');
    assert.deepEqual(src.tabs[src.active], { view: 'doc', doc: '乙篇.md' });
    // 中间那一格没被动
    assert.deepEqual(findPane(out, 'slot:1').tabs, [{ view: 'notes' }]);
    // 原来那棵树一个字节都没动(纯函数)
    assert.deepEqual(findPane(t, 'slot:7').tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }]);
});

test('★ 边缘停靠:源槽位只剩被拖的那一枚 → 源槽位消失,腾出的空间整块给相邻那格', () => {
    // 用"源在目标左边"这一对:摘掉源之后目标就是它唯一的邻居,判据最干净
    const t = split('row', [51, 26], [pane('slot:1', [{ view: 'notes' }], 0), pane('links')]);
    const out = moveTabToEdge(t, 'slot:1', 0, 'links', 'right');
    assert.equal(findPane(out, 'slot:1'), null, '源槽位空了就整格消失(不留空面板)');
    const ids = slotIds(out);
    assert.equal(ids.includes('links'), true, '目标还在');
    assert.equal(ids.length, 2, `两格:目标 + 新拆出来那一格,实际 ${ids}`);
    // 空间整块给邻居(方案 B = `detach(..., {space:'neighbor'})`):
    // 这一层是 [源 51, 目标 26];先把新格从**目标那一份**里切走 30%(26 → 18.2 + 7.8),
    // 再摘掉源 —— 源那 51(= 归一化之后的 66.23)整块加给"目标 + 新格"这一对里
    // **紧邻的左邻**(也就是目标),新格自己那份**一个字不动**。
    // ⚠️ 曾经断言 82 / 18,那是"把兄弟们按剩余比例放大再加"的产物(见 detach 的注释):
    //    新格会被一起撑大,违反"不改变未涉及分支的比例"。正确读数是 90 / 10。
    assert.equal(Math.round(out.sizes.reduce((a, b) => a + b, 0)), 100, `同一层比例和仍是 100:${out.sizes}`);
    assert.equal(Math.round(out.sizes[0]), 90, `邻居(links)独占源腾出的那整块:${out.sizes}`);
    assert.equal(Math.round(out.sizes[1]), 10, `新格只从**目标那一份**里切走 30%,不再被归一化撑大:${out.sizes}`);
});

test('★ 边缘停靠:从多文档的栈里拆出一篇 → 新槽位 id 唯一,两个文档实例各保留一次', () => {
    const out = moveTabToEdge(edgeTree(), 'slot:7', 1, 'slot:1', 'right');
    const ids = slotIds(out);
    assert.equal(new Set(ids).size, ids.length, `槽位 id 必须全局唯一:${ids}`);
    const freshId = freshIdOf(out);
    assert.match(freshId, /^slot:\d+$/, `新槽位拿到的是槽位序号 id,不是视图名:${freshId}`);
    assert.deepEqual(findPane(out, freshId).tabs, [{ view: 'doc', doc: '乙篇.md' }]);
    assert.deepEqual(findPane(out, 'slot:7').tabs, [{ view: 'doc', doc: '甲篇.md' }]);
    // 两篇笔记各在且只在一次
    assert.deepEqual(tabKeysOf(out).filter((k) => k.startsWith('doc')).sort(),
        ['doc\u0000甲篇.md', 'doc\u0000乙篇.md'].sort());
});

test('边缘停靠:同槽位 / 无效边 / 无效下标 / 缺槽位 都返回 null(不产生半更新)', () => {
    assert.equal(moveTabToEdge(edgeTree(), 'slot:7', 0, 'slot:7', 'left'), null, '同槽位投放没有意义');
    assert.equal(moveTabToEdge(edgeTree(), 'slot:7', 0, 'links', 'middle'), null, '无效边');
    assert.equal(moveTabToEdge(edgeTree(), 'slot:7', 0, 'links', ''), null);
    assert.equal(moveTabToEdge(edgeTree(), 'slot:7', 5, 'links', 'left'), null, '下标越界');
    assert.equal(moveTabToEdge(edgeTree(), 'slot:7', -1, 'links', 'left'), null);
    assert.equal(moveTabToEdge(edgeTree(), 'slot:7', 0, 'zz', 'left'), null, '找不到目标槽位');
    assert.equal(moveTabToEdge(edgeTree(), 'zz', 0, 'links', 'left'), null, '找不到源槽位');
    assert.equal(moveTabToEdge(null, 'slot:7', 0, 'links', 'left'), null, '空树');
});

test('边缘停靠:四种边都长在正确的一侧(row / col 跟着边方向),且没有重复 tabKey', () => {
    // 目标在最右的两格树:左右两条边的落点形状一眼可判
    const base = () => split('row', [60, 40], [pane('slot:1', [{ view: 'notes' }, { view: 'ai' }], 0), pane('links')]);
    const outLeft = moveTabToEdge(base(), 'slot:1', 0, 'links', 'left');
    assert.equal(outLeft.dir, 'row', '左右 → row 分割');
    assert.deepEqual(slotIds(outLeft), ['slot:1', 'slot:2', 'links'], '新槽位在目标左边');
    const outRight = moveTabToEdge(base(), 'slot:1', 0, 'links', 'right');
    assert.deepEqual(slotIds(outRight), ['slot:1', 'links', 'slot:2'], '新槽位在目标右边');
    const outTop = moveTabToEdge(base(), 'slot:1', 0, 'links', 'top');
    const colTop = outTop.children.find((c) => c.dir === 'col');
    assert.ok(colTop, '上下 → col 分割');
    assert.deepEqual(colTop.children.map((c) => c.id), ['slot:2', 'links'], '新槽位在目标上边');
    const outBottom = moveTabToEdge(base(), 'slot:1', 0, 'links', 'bottom');
    const colBottom = outBottom.children.find((c) => c.dir === 'col');
    assert.deepEqual(colBottom.children.map((c) => c.id), ['links', 'slot:2'], '新槽位在目标下边');
    // 全树 tabKey 去重
    for (const t of [outLeft, outRight, outTop, outBottom]) {
        const keys = tabKeysOf(t);
        assert.equal(new Set(keys).size, keys.length, `tabKey 不许重复:${keys}`);
    }
});

test('边缘停靠:树里只有这一格时,投放被拒(不能把自己拆到自己旁边)', () => {
    // ⚠️ 这条用例原来写的是"源槽位就是整棵树 → 新槽位包在外面"。**那是做不到的**:
    //    树里只有一格时,唯一可能的源与目标就是同一格,而 `fromId === targetId`
    //    在最前面就返回 null(规格 §1.5"同一个实例只能存在一次"的必然推论 ——
    //    把自己拆到"自己旁边"只会得到两个指着同一格的槽位)。
    //    所以这里钉的是"被拒",而不是"包在外面"。规格 §4.3 第 5 步的"源空则折叠"
    //    只在源还有邻居时发生,与 `detach` 的契约正好一致。
    const only = pane('only', [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }], 1);
    assert.equal(moveTabToEdge(only, 'only', 1, 'only', 'right'), null);
    assert.equal(moveTabToEdge(only, 'only', 1, 'only', 'bottom'), null);
    // 两格时:源还剩标签 → 不折叠;源空了 → 折叠(空间给邻居)
    const pair = split('row', [50, 50], [pane('a', [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }], 0), pane('b')]);
    const step1 = moveTabToEdge(pair, 'a', 0, 'b', 'right');
    assert.deepEqual(slotIds(step1), ['a', 'b', 'slot:1'], '源还剩一枚 → 源槽位留着,新槽位在目标右边');
    assert.deepEqual(findPane(step1, 'a').tabs, [{ view: 'links' }], '源栈里剩下的是没被拖的那一枚');
    const step2 = moveTabToEdge(step1, 'a', 0, 'b', 'right');
    assert.equal(findPane(step2, 'a'), null, '源槽位空了 → 整格消失');
    assert.deepEqual(slotIds(step2).filter((i) => i !== 'a'), ['b', 'slot:2', 'slot:1'], '两枚标签各在且只在一次');
});

test('槽位 id 序号:nextSlotSeq 只挑没被占用的号,且不动原树', () => {
    assert.equal(nextSlotSeq(edgeTree()), 8, '树里已有 slot:7 → 下一个是 slot:8');
    assert.equal(nextSlotSeq(split('row', [50, 50], [pane('notes'), pane('doc')])), 1, '没有任何 slot:N → 从 1 开始');
    assert.equal(nextSlotSeq(pane('slot:3')), 4);
    assert.equal(nextSlotSeq(null), 1);
});

// ---- 「窗口」菜单:点一条视图 = 新加一格(用户选的语义)----
// 为什么在这里钉:菜单那一层只是"把 id 递进来",真正要守的是**树怎么长出这一格** ——
// 尤其是"不许把其余格的比例也改了"。

test('新加一格:空树 → 就是那一个叶子(它自己也有一枚标签)', () => {
    const t = addPane(null, PANE_NOTES);
    assert.equal(isPane(t), true);
    assert.equal(t.id, PANE_NOTES);
    assert.deepEqual(t.tabs.map((x) => x.view), [PANE_NOTES], '新格里就该有它自己那一枚');
});

test('新加一格:同方向的父节点 → 直接插成兄弟,只从锚点那份里切', () => {
    const base = split('row', [40, 60], [pane(A), pane(B)]);
    const t = addPane(base, C, { anchorId: A, dir: 'row', side: 'right', share: 25 });
    assert.deepEqual(listPaneIds(t), [A, C, B], '插在锚点右边');
    assert.equal(sum(t.sizes), 100);
    assert.ok(near(t.sizes[0], 30), `锚点被切走 25%:a=${t.sizes[0]}`);
    assert.ok(near(t.sizes[1], 10), `新格拿到那一份:c=${t.sizes[1]}`);
    assert.ok(near(t.sizes[2], 60), `其余格**一个字不动**:b=${t.sizes[2]}`);
});

test('新加一格:方向不同 → 锚点整格换成两格,锚点自己的比例不变', () => {
    const base = split('row', [40, 60], [pane(A), pane(B)]);
    const t = addPane(base, C, { anchorId: A, dir: 'col', side: 'bottom', share: 30 });
    assert.equal(isSplit(t.children[0]), true, 'a 那一格变成上下两格');
    assert.equal(t.children[0].dir, 'col');
    assert.ok(near(sum(t.sizes), 100) && near(t.sizes[0], 40), '外层比例不变(锚点的位置与大小照旧)');
    assert.deepEqual(listPaneIds(t), [A, C, B], '上下顺序:b 在下');
});

test('新加一格:shape 不对就返回 null(调用方保持旧树)', () => {
    assert.equal(addPane(four(), ''), null, '空视图 id 不算数');
    // ⚠️ 本函数**不**校验视图在不在注册表里(它没有那份表)—— 认不出的 id 照样长出一格;
    //    那是调用方的责任(「窗口」菜单只列注册表里的视图)。
    assert.equal(isSplit(addPane(four(), 'no-such-view')), true, '锚点在树上 → 长出来的是整棵树');
    assert.equal(addPane(four(), PANE_AI, { anchorId: 'zz' }), null, '认不出的锚点不算数');
});

test('normalizeSizes:任意脏数字都能变成「正数、和恰好 100」', () => {
    assert.deepEqual(normalizeSizes([50, 50], 2), [50, 50]);
    assert.equal(sum(normalizeSizes([1, 9], 2)), 100, '权重会被归一化');
    assert.equal(sum(normalizeSizes([2, 3, 7], 3)), 100);
    assert.deepEqual(normalizeSizes(null, 1), [100]);
    assert.deepEqual(normalizeSizes([5], 1), [100]);
    assert.deepEqual(normalizeSizes([1, 2, 3], 0), []);
    // 脏值用已知值的平均数补,而不是把整层丢掉
    const repaired = normalizeSizes([30, 'x', 30], 3);
    assert.equal(repaired.length, 3);
    assert.equal(sum(repaired), 100);
    assert.ok(near(repaired[1], repaired[0]),
        `中间那片用平均数补(相对权重与邻居相同):${JSON.stringify(repaired)}`);
    // 全是垃圾 → 平分
    assert.deepEqual(normalizeSizes(['a', {}, NaN], 3), [33.33, 33.33, 33.34]);
    assert.equal(sum(normalizeSizes(['a', {}, NaN], 3)), 100);
});

test('defaultTree:链接与 AI 上下叠在右侧(不是横排四栏),比例和都是 100', () => {
    const t = defaultTree();
    assert.equal(t.dir, 'row');
    assert.equal(isSplit(t), true);
    assert.equal(t.children.length, 3);
    assert.deepEqual(listPaneIds(t), DEFAULT_PANE_IDS, '左 → 中 → 右(右栏里 links 在上、ai 在下)');
    assert.ok(t.children[0].type === 'pane' && t.children[1].type === 'pane', '左、中都是叶子');
    assert.equal(sum(t.sizes), 100);
    assert.ok(t.sizes[1] > t.sizes[0] && t.sizes[1] > t.sizes[2], '中间最宽(正文最需要宽度)');
    // 右栏是**嵌套的 col**,里面才是 links 与 ai —— 这就是"四格而不是横排四栏"
    const side = t.children[2];
    assert.equal(side.dir, 'col');
    assert.deepEqual(side.sizes, DEFAULT_SIDE_SPLIT);
    assert.equal(sum(side.sizes), 100);
    assert.deepEqual(listPaneIds(side), [PANE_LINKS, PANE_AI], '链接在上、AI 在下');
    assert.deepEqual(listPaneIds(defaultTree()), [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI]);
});

test('treeFromWidths:旧的两个像素宽度当成权重,这块宽度上渲染出同样的像素', () => {
    const avail = 1254;                       // 容器宽度 - 两条分隔条
    const t = treeFromWidths({ navW: 236, sideW: 240, avail });
    assert.equal(sum(t.sizes), 100);
    assert.ok(near(t.sizes[0] / 100 * avail, 236, 0.5), `左栏回到 236px,实际 ${t.sizes[0] / 100 * avail}`);
    // ⚠️ sideW 是**右栏整列**(links + ai 叠起来那一列)的宽度,不是其中某一块
    assert.ok(near(t.sizes[2] / 100 * avail, 240, 0.5), `右栏回到 240px,实际 ${t.sizes[2] / 100 * avail}`);
    assert.equal(t.children[2].dir, 'col', '右栏内部是上下分割');
    // 比例制:换一个宽度,三片按同一比例缩放(而不是左栏永远 236)
    const wide = 2508;
    assert.ok(near(t.sizes[0] / 100 * wide, 472, 1), '窗口翻倍 → 左栏按比例翻倍');
    // 脏参数不许抛,也不许出现负宽度
    const dirty = treeFromWidths({ navW: NaN, sideW: -5, avail: 0 });
    assert.equal(dirty.children.length, 3);
    assert.ok(dirty.sizes.every((s) => s > 0));
});

test('isPane / isSplit / cloneTree:形状判定与深拷贝(改副本不动原树)', () => {
    assert.equal(isPane(pane('x')), true);
    assert.equal(isPane({ type: 'pane' }), false, '没有 id 不算叶子');
    assert.equal(isSplit(split('row', [50, 50], [pane('a'), pane('b')])), true);
    assert.equal(isSplit({ dir: 'diag', children: [pane('a')] }), false);
    assert.equal(isSplit({ dir: 'row', children: [] }), false, '空分割不算');
    const t = four();
    const c = cloneTree(t);
    assert.deepEqual(c, t);
    c.children[1].children[0].id = 'zzz';
    assert.equal(t.children[1].children[0].id, B, '克隆是深拷贝');
});

test('listPaneIds / countPanes / findPane:深度优先顺序与查找', () => {
    const t = four();
    assert.deepEqual(listPaneIds(t), [A, B, C]);
    assert.equal(countPanes(t), 3);
    assert.equal(findPane(t, C).id, C);
    assert.equal(findPane(t, 'nope'), null);
    assert.deepEqual(listPaneIds(defaultTree()), [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI]);
});

test('findParent / pathTo / nodeAtPath:父节点、路径、按路径取回', () => {
    const t = four();
    const c = findPane(t, C);
    const at = findParent(t, c);
    assert.equal(at.parent.dir, 'col');
    assert.equal(at.index, 1);
    assert.deepEqual(pathTo(t, c), [1, 1]);
    assert.deepEqual(pathTo(t, t), []);
    assert.equal(nodeAtPath(t, [1, 1]), c);
    assert.equal(nodeAtPath(t, []), t);
    assert.equal(nodeAtPath(t, [9, 9]), null);
    assert.equal(pathTo(t, pane('ghost')), null, '不在树里的引用找不到路径');
});

test('formatTree:布局树文本(用户要看的那份"证据")', () => {
    const t = defaultTree();
    const text = formatTree(t, {
        [PANE_NOTES]: '笔记列表', [PANE_DOC]: '笔记正文',
        [PANE_LINKS]: '链接', [PANE_AI]: 'AI 对话',
    });
    assert.equal(text, '{row 19% / 62% / 19%}[ 笔记列表 , 笔记正文 , {col 42% / 58%}[ 链接 , AI 对话 ] ]');
    // 没有标题时退回 id,坏输入不抛
    assert.ok(formatTree(defaultTree()).includes(PANE_NOTES));
    assert.equal(typeof formatTree(null), 'string');
});

test('formatTree:新增的 tabs/active **不改变**读数(逐字稳定,含多标签树)', () => {
    // 这份文本是用户与自检共用的那种"证据"(工作台底栏 / 设置页 / 一串逐字断言)。
    // 契约 v3 给叶子加了 tabs/active,但读数必须一个字符都不变 —— 否则所有既有读数
    // 会在一夜之间变样,而标签页本身在下一个单元有它自己的界面(标签条)。
    const titles = { [PANE_NOTES]: '笔记列表', [PANE_DOC]: '笔记正文', [PANE_LINKS]: '链接', [PANE_AI]: 'AI 对话' };
    const plain = defaultTree();
    // 同一棵树,只是 doc 那片多带了两个标签、活动标签也不是 0
    const tabbed = split('row', [19, 62, 19], [
        pane(PANE_NOTES),
        pane(PANE_DOC, [
            { view: 'doc', doc: '甲篇.md' },
            { view: 'doc', doc: '乙篇.md' },
        ], 1),
        split('col', DEFAULT_SIDE_SPLIT, [pane(PANE_LINKS), pane(PANE_AI)]),
    ]);
    assert.equal(formatTree(tabbed, titles), formatTree(plain, titles), '标签只在树里,不进读数');
    assert.equal(formatTree(tabbed, titles),
        '{row 19% / 62% / 19%}[ 笔记列表 , 笔记正文 , {col 42% / 58%}[ 链接 , AI 对话 ] ]');
});

// ---- 摘叶子 + 折叠 ----

test('detach:摘走一片后面板数 -1,同层其它片只重新归一化(渲染比例不变)', () => {
    const t = split('row', [30, 70], [pane(A), pane(B)]);
    const d = detach(t, A);
    assert.equal(countPanes(d.tree), 1, '只剩一片');
    assert.equal(d.leaf.id, A);
    assert.equal(d.tree.id, B, '父节点只剩一个孩子 → 折叠,幸存者顶上去');
});

test('detach:父节点只剩一个孩子就折叠,比例并回上一层 —— 旁边的面板恰好占满', () => {
    const t = four();                                  // row[30 / 70][ a , col[40 / 60][ b , c ] ]
    const before = t.sizes.slice();
    const d = detach(t, C);                            // 摘掉右下的 c
    assert.equal(countPanes(d.tree), 2);
    assert.deepEqual(listPaneIds(d.tree), [A, B]);
    assert.equal(d.tree.dir, 'row');
    assert.deepEqual(d.tree.sizes, before,
        '祖父那一格的比例不变 —— 无关的 a 不会被挤瘦(demo 的 sum 写法会让 a 从 30% 缩到 17.6%)');
    assert.ok(isPane(d.tree.children[1]), '幸存者顶替掉那个只剩一个孩子的 col 节点');
    assert.equal(d.tree.children[1].id, B);
    assert.equal(sum(d.tree.sizes), 100);
});

test('detach:摘走一片不改原树(纯函数),找不到的 id 返回 null', () => {
    const t = four();
    const snapshot = JSON.stringify(t);
    detach(t, C);
    assert.equal(JSON.stringify(t), snapshot, '原树一个字节都不该变');
    assert.equal(detach(t, 'nope'), null);
});

test('detach:整棵树就是这一片时,返回 tree=null(调用方据此放弃这次落点)', () => {
    const d = detach(pane(A), A);
    assert.equal(d.tree, null);
    assert.equal(d.leaf.id, A);
});

test('detach:摘走三片里的一片,剩下两片按原权重比例重新归一化(和仍为 100)', () => {
    const t = split('row', [19, 62, 19], [pane(A), pane(B), pane(C)]);
    const d = detach(t, C);
    assert.deepEqual(listPaneIds(d.tree), [A, B]);
    assert.equal(sum(d.tree.sizes), 100);
    assert.ok(near(d.tree.sizes[0] / d.tree.sizes[1], 19 / 62, 0.01), '比例关系没变,只是重新归一化');
});

// ---- 四种落点 + 换位 + 整宽底栏 ----

const sides = [
    ['left', 'row', 0], ['right', 'row', 1],
    ['top', 'col', 0], ['bottom', 'col', 1],
];

for (const [side, dir, pos] of sides) {
    test(`dropOnEdge:拖到目标「${side}」→ 用 {${dir}} 分割替换目标节点,被拖的那片在 ${
        pos === 0 ? '前' : '后'}面`, () => {
        const t = four();                                  // row[a, col[b, c]]
        const next = dropOnEdge(t, C, A, side);            // 把 c 拖到 a 的那一侧
        assert.deepEqual(listPaneIds(next), pos === 0 ? [C, A, B] : [A, C, B], '面板一个不多一个不少');
        const node = next.children[0];                     // 目标 a 本来就在第 0 位
        assert.equal(node.dir, dir, `{${dir}} 分割`);
        assert.deepEqual(listPaneIds(node), pos === 0 ? [C, A] : [A, C]);
        assert.deepEqual(node.sizes, [50, 50]);
        assert.equal(next.sizes.length, 2);
        assert.equal(countPanes(next), 3);
    });
}

test('dropOnEdge:左/右是 row 分割,上/下是 col 分割(demo 的四种落点)', () => {
    const t = four();
    assert.equal(dropOnEdge(t, C, A, 'right').children[0].dir, 'row');
    assert.equal(dropOnEdge(t, C, A, 'bottom').children[0].dir, 'col');
    const left = dropOnEdge(t, A, C, 'left');
    const parentOfC = findParent(left, findPane(left, C)).parent;
    assert.equal(parentOfC.dir, 'row');
    assert.deepEqual(listPaneIds(parentOfC), [A, C]);
});

test('dropOnEdge:先摘出来再插回去,总数守恒;落到自己身上 / 未知目标 / 坏方向 → 原样', () => {
    const t = four();
    for (const side of ['left', 'right', 'top', 'bottom']) {
        for (const from of [A, B, C]) {
            for (const to of [A, B, C]) {
                const next = dropOnEdge(t, from, to, side);
                assert.equal(countPanes(next), 3, `${from}→${to}(${side}) 面板数必须守恒`);
                assert.deepEqual([...listPaneIds(next)].sort(), [A, B, C].sort());
            }
        }
    }
    assert.equal(dropOnEdge(t, A, A, 'left'), t, '落到自己身上 = 不动');
    assert.equal(dropOnEdge(t, A, 'ghost', 'left'), t, '目标不在树里 = 不动');
    assert.equal(dropOnEdge(t, A, B, 'diag'), t, '不是四个方向之一 = 不动');
});

test('dropOnEdge:被拖的那片是唯一一片时不动(没地方可挪)', () => {
    const only = pane(A);
    assert.equal(dropOnEdge(only, A, A, 'left'), only);
});

test('swapPanes:中间落点 = 两片换位,树形与比例一点不动', () => {
    const t = four();
    const next = swapPanes(t, A, B);
    assert.equal(listPaneIds(next)[0], B, '两个 id 换了个位置');
    assert.deepEqual(listPaneIds(next), [B, A, C]);
    assert.deepEqual(next.sizes, t.sizes, '比例不动');
    assert.deepEqual(next.children[1].sizes, t.children[1].sizes);
    assert.equal(countPanes(next), 3);
    assert.deepEqual([...listPaneIds(next)].sort(), [A, B, C].sort());
    assert.equal(swapPanes(t, A, A), t, '换自己 = 不动');
    assert.equal(swapPanes(t, A, 'ghost'), t, '有一片不在树里 = 不动');
});

test('dockBottom:整宽底栏 —— 整棵树被 {col:[原树, 被拖]} 包起来', () => {
    const t = split('row', [50, 50], [pane(A), pane(B)]);
    const next = dockBottom(t, B);
    assert.equal(next.dir, 'col');
    assert.equal(next.children.length, 2);
    assert.equal(sum(next.sizes), 100);
    assert.deepEqual(next.sizes, [72, 28], 'demo 用的 72 / 28');
    assert.equal(next.children[1].id, B, '被拖的那片在下面(整宽那条带)');
    assert.equal(countPanes(next), 2, '面板数守恒');
    assert.ok(isPane(next.children[0]), '原树摘走后只剩 a,父节点被折叠了');
    assert.equal(next.children[0].id, A);
});

test('dockBottom:右栏(链接 + AI 那一列)拖到底部 → 上面还剩两栏,总数守恒', () => {
    const next = dockBottom(defaultTree(), PANE_AI);
    assert.equal(next.dir, 'col');
    assert.deepEqual(listPaneIds(next), [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI], '顺序不变,只是最后一片整宽到底部');
    assert.equal(next.children[0].dir, 'row');
    assert.equal(countPanes(next), 4);
    // 把**整列**(links + ai)拖到底部也可以:它是一棵子树,面板数照样守恒
    const column = dockBottom(defaultTree(), PANE_LINKS);
    assert.deepEqual(listPaneIds(column), [PANE_NOTES, PANE_DOC, PANE_AI, PANE_LINKS]);
    assert.equal(countPanes(column), 4);
    const only = pane(A);
    assert.equal(dockBottom(only, A), only, '唯一一片没法再分');
});

// ---- 拖分隔条:只动相邻两片 ----

test('setPairRatio:只改相邻两片,其余片一个都不动,两片之和不变', () => {
    const t = split('row', [20, 30, 50], [pane(A), pane(B), pane(C)]);
    const next = setPairRatio(t, t, 0, 30);
    assert.deepEqual(next.sizes, [30, 20, 50], '第 0、1 片互换份额;第 2 片纹丝不动');
    assert.deepEqual(t.sizes, [20, 30, 50], '纯函数:原树不动');
    const next2 = setPairRatio(t, t, 1, 60);
    assert.deepEqual(next2.sizes, [20, 60, 20]);
});

test('setPairRatio:最小比例保底(6%),两边都夹住,和恒为 100', () => {
    const t = split('row', [50, 50], [pane(A), pane(B)]);
    const min = 100 * (MIN_RATIO / 100);
    assert.deepEqual(setPairRatio(t, t, 0, 0).sizes, [min, 100 - min], '想拖到 0 → 夹在 6%');
    assert.deepEqual(setPairRatio(t, t, 0, 999).sizes, [100 - min, min], '想拖到天上 → 右边保底 6%');
    assert.equal(sum(setPairRatio(t, t, 0, 33.3).sizes), 100);
});

test('setPairRatio:接受路径(拖动中树被换成新对象,调用方只能持路径)', () => {
    const t = four();
    const next = setPairRatio(t, [1], 0, 10);
    assert.deepEqual(next.children[1].sizes, [10, 90]);
    assert.deepEqual(next.sizes, [30, 70], '别层不动');
    assert.equal(setPairRatio(t, [7], 0, 10), t, '坏路径原样返回');
    assert.equal(setPairRatio(t, t, 5, 10), t, '坏下标原样返回');
    assert.equal(setPairRatio(t, t, 0, NaN), t, '非数字原样返回');
});

test('pairSizesFromDrag:拖 80px 就真的宽 80px,两片像素和不变', () => {
    const sizes = [50, 50];
    const out = pairSizesFromDrag(sizes, 0, 1000, 500, 80);
    assert.ok(near(out[0] / 100 * 1000, 580, 0.5), `左片 500 → 580,实际 ${out[0] / 100 * 1000}`);
    assert.ok(near(out[1] / 100 * 1000, 420, 0.5));
    assert.equal(sum(out), 100);
    // 往左拖回原点
    const back = pairSizesFromDrag(out, 0, 1000, 580, -80);
    assert.ok(near(back[0], 50, 0.02));
});

test('pairSizesFromDrag:拖动中就把两片夹在 6% 以上(不是松手才夹)', () => {
    const out = pairSizesFromDrag([50, 50], 0, 1000, 500, -10000);
    assert.ok(near(out[0] / 100 * 1000, 60, 0.5), `左片保底 6% = 60px,实际 ${out[0] / 100 * 1000}`);
    const out2 = pairSizesFromDrag([50, 50], 0, 1000, 500, 10000);
    assert.ok(near(out2[0] / 100 * 1000, 940, 0.5), '右片保底 6%');
    assert.equal(sum(out2), 100);
});

test('pairSizesFromPx:零宽 / 零权重不产生 NaN 或负数', () => {
    assert.deepEqual(pairSizesFromPx([50, 50], 0, 0, 10), [50, 50]);
    assert.deepEqual(pairSizesFromPx([0, 0], 0, 800, 400), [0, 0]);
    const out = pairSizesFromPx([50, 50], 0, 800, 800, MIN_RATIO);
    assert.ok(out.every((v) => v > 0));
});

// ---- 脏存档 ----

test('normalizeTree:空 / 坏 JSON / 数组 / 缺字段 —— 一律退回默认树,绝不抛', () => {
    const junk = [
        undefined, null, '', '   ', '{', '[]', 'null', '42', 'not json at all',
        [], 42, 'x', {}, { dir: 'row' }, { dir: 'row', sizes: [50, 50] },
        { type: 'pane' }, { type: 'pane', id: '' }, { v: 2 }, { children: [] },
        { dir: 'diag', sizes: [50, 50], children: [pane(A), pane(B)] },
        (() => { const c = { dir: 'row', sizes: [50, 50], children: [] }; c.children.push(c); return c; })(),
    ];
    for (const bad of junk) {
        const t = normalizeTree(bad, [A, B]);
        assert.deepEqual(listPaneIds(t), [A, B], `${Object.prototype.toString.call(bad)} 应退回默认树`);
        assert.equal(t.dir, 'row');
    }
});

test('normalizeTree:未知 id 丢掉 —— 丢掉之后面板对不上,就退回默认树', () => {
    const t = normalizeTree({
        dir: 'row', sizes: [50, 50], children: [pane(A), pane('外人')],
    }, [A, B]);
    assert.deepEqual(listPaneIds(t), [A, B], '少一片 → 默认树(少一片意味着有个面板没有归宿)');
});

test('normalizeTree:重复 id 算坏档', () => {
    const t = normalizeTree({
        dir: 'row', sizes: [34, 33, 33], children: [pane(A), pane(A), pane(B)],
    }, [A, B]);
    assert.deepEqual(listPaneIds(t), [A, B], '重复 → 退回默认');
});

test('normalizeTree:单孩子的分割折叠掉;折叠后对不上也退回默认', () => {
    const t = normalizeTree({
        dir: 'row', sizes: [50, 50], children: [pane(A), split('col', [50, 50], [pane(B)])],
    }, [A, B]);
    assert.deepEqual(listPaneIds(t), [A, B]);
    assert.equal(t.dir, 'row');
    assert.ok(t.children.every(isPane), '单孩子的 col 被折叠掉了');
});

test('normalizeTree:比例脏但形状对 —— 修比例,不丢树', () => {
    const t = normalizeTree({
        dir: 'row', sizes: ['x', null, null], children: [pane(A), pane(B), pane(C)],
    }, [A, B, C]);
    assert.deepEqual(listPaneIds(t), [A, B, C], '形状是对的,树要保住');
    assert.deepEqual(t.sizes, [33.33, 33.33, 33.34]);
    assert.equal(sum(t.sizes), 100);
});

test('normalizeTree:合法的树原样留下(形状、嵌套、比例都保住)', () => {
    const good = {
        dir: 'row', sizes: [24, 32, 44],
        children: [pane(A), split('col', [60, 40], [pane(B), pane(C)]), pane(D)],
    };
    assert.deepEqual(normalizeTree(good, [A, B, C, D]), good);
    assert.deepEqual(normalizeTree(cloneTree(good), [A, B, C, D]), good, '往返一次还是一样的树');
});

test('normalizeTree:known 不是默认那三个时,默认树按 known 的顺序与数量造', () => {
    const t = normalizeTree(null, ['x', 'y']);
    assert.deepEqual(listPaneIds(t), ['x', 'y']);
    assert.equal(t.dir, 'row');
    assert.equal(normalizeTree(null, []).children.length, 3, 'known 为空时退回内置三栏');
});

test('可选视图:缺席不补回,必需视图仍会补回且布局有效', () => {
    const tool = 'tool:bilibili';
    const knownIds = [...DEFAULT_PANE_IDS, tool];
    const requiredIds = DEFAULT_PANE_IDS;

    const full = normalizeTree(defaultTree(), knownIds, requiredIds);
    assert.deepEqual(listPaneIds(full), DEFAULT_PANE_IDS);
    assert.equal(validateLayout(full, knownIds, requiredIds).ok, true);

    const partial = normalizeTree(pane(PANE_NOTES), knownIds, requiredIds);
    assert.deepEqual([...listPaneIds(partial)].sort(), [...DEFAULT_PANE_IDS].sort());
    assert.equal(listPaneIds(partial).includes(tool), false);
});

test('normalizeTree:脏树被换掉之后,树里绝不能少面板(那会让面板整片消失)', () => {
    const cases = [
        null,
        { dir: 'row', sizes: [50, 50], children: [pane(PANE_NOTES), pane('x')] },
        { dir: 'row', sizes: [50, 50], children: [pane(PANE_NOTES), pane(PANE_NOTES)] },
        { dir: 'col', sizes: [0, 0], children: [] },
    ];
    for (const bad of cases) {
        const t = normalizeTree(bad, DEFAULT_PANE_IDS);
        assert.deepEqual([...listPaneIds(t)].sort(), [...DEFAULT_PANE_IDS].sort());
    }
});

// ---- 标签结构(tabs / active,契约 v3)----
//
// ⚠️ 这一组的头号目的是防**复发**:`normalizeTree` 从前是 `pane(node.id)`
// —— 按 id 重建叶子,多余字段全被剥掉。于是存档里的 tabs/active 在加载那一刻就没了,
// 而树形、面板数量、比例全都对得上:迁移测试照样绿,数据已经丢了。
// 下面第一条就是钉住它的(`tabs` 必须穿过 normalizeTree)。

test('★ 标签:normalizeTree 保留并规范化 tabs/active(不许按 id 重建把字段剥掉)', () => {
    const saved = split('row', [19, 62, 19], [
        pane(PANE_NOTES),
        pane(PANE_DOC, [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }], 1),
        split('col', [42, 58], [pane(PANE_LINKS), pane(PANE_AI)]),
    ]);
    const clean = normalizeTree(saved, DEFAULT_PANE_IDS);
    const doc = findPane(clean, PANE_DOC);
    assert.deepEqual(doc.tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }],
        '⚠️ 两个标签必须原样穿过归一化(挂了就是"按 id 重建丢字段"复发)');
    assert.equal(doc.active, 1, 'active 也要原样保留');
    // 平面节点(没有标签的)按"单视图"补上
    assert.deepEqual(findPane(clean, PANE_AI).tabs, [{ view: PANE_AI }]);
    assert.equal(findPane(clean, PANE_AI).active, 0);
    // 树形与比例照旧
    assert.deepEqual(listPaneIds(clean), DEFAULT_PANE_IDS);
    assert.deepEqual(clean.sizes, [19, 62, 19]);
});

/**
 * 一棵**面板集合完整**的树(notes / doc / links / ai 都在),标签只改 doc 那一片。
 *
 * ⚠️ 这一组必须用完整集合:normalizeTree 的规则是"每个视图都要有标签实例",
 * 少一片会由收编补回来 —— 那样测到的是兜底,不是标签规范化。
 *
 * ⚠️ 另一个坑(第六段踩过):`pane(PANE_DOC, tabs)` 里的 tabs **不能**出现
 * `notes` / `links` / `ai` 这些**与别的槽位同名**的视图 —— 全局去重按
 * "同名格优先"归位,那些枚会被它们自己的格子认领,doc 这一格反而被剥成空、
 * 整格收拢。要测"多标签留在这一格",标签就应该用**只属于这里**的实例
 * (同一视图的不同文档实例,或者同一视图的重复写入)。
 */
const treeWithDocTabs = (tabs, active) => split('row', [19, 62, 19], [
    pane(PANE_NOTES),
    pane(PANE_DOC, tabs, active),
    split('col', DEFAULT_SIDE_SPLIT, [pane(PANE_LINKS), pane(PANE_AI)]),
]);

test('标签规范化:未知 view 丢掉(丢掉之后空的回退单视图)', () => {
    // view 与面板 id 共用一个命名空间:不认得的 view = 读不懂的标签,与未知面板 id 同待遇
    const t = normalizeTree(treeWithDocTabs([{ view: 'doc', doc: '甲篇.md' }, { view: '外人' }, { view: 'doc', doc: '乙篇.md' }], 0),
        DEFAULT_PANE_IDS);
    assert.deepEqual(findPane(t, PANE_DOC).tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }]);
    // 丢掉的那条正好是活动标签时:active 不能指到不存在的下标上
    const activeBad = normalizeTree(treeWithDocTabs([{ view: 'doc', doc: '甲篇.md' }, { view: '外人' }], 1), DEFAULT_PANE_IDS);
    const leaf = findPane(activeBad, PANE_DOC);
    assert.deepEqual(leaf.tabs, [{ view: 'doc', doc: '甲篇.md' }]);
    assert.equal(leaf.active, 0, '活动标签被丢掉 → 回到第一个');
    assert.ok(leaf.active < leaf.tabs.length);
    // ⚠️ v4 改了"全都不认得"的口径:从前它会回退成"这个面板自己"(按 pane.id 猜视图名)——
    // 槽位 id 与视图名解耦之后那已经是**改数据**(一个叫 doc 的槽位里可能装着 links)。
    // 现在的规则:读不出的标签丢掉;槽位因此空掉就收拢;缺的视图由收编补回来。
    // 判据见下面这条独立的用例(`v4:全都不认得 …`)。
});

test('v4:全都不认得 / 不是数组 —— 不再按 pane.id 猜视图,而是"空槽位收拢 + 收编缺的视图"', () => {
    const probe = split('row', [19, 62, 19], [
        pane(PANE_NOTES),
        pane(PANE_DOC, [{ view: '外人' }, { view: '' }, 42], 0),
        split('col', DEFAULT_SIDE_SPLIT, [pane(PANE_LINKS), pane(PANE_AI)]),
    ]);
    const out = normalizeTree(probe, DEFAULT_PANE_IDS);
    // doc 槽位里那三条读不懂的标签被丢掉 → 该槽位空掉 → 收拢(不留空面板)。
    // ⚠️ 判据不能写 `findPane(out, 'doc') === null`:doc 这个**视图**没有标签实例了,
    //    会被补回一格,而新格的 id 可能是任意唯一的槽位 id —— 这里要钉的是
    //    "**原槽位**被收拢、doc 是**新增**了一格",所以按标签内容判。
    const slots = listPaneIds(out);
    assert.equal(slots.length, DEFAULT_PANE_IDS.length, `补回来的那一格是新增的:${slots}`);
    assert.equal(tabKeysOf(out).filter((k) => k === PANE_DOC).length, 1, 'doc 视图恰好一枚实例');
    assert.equal(tabKeysOf(out).includes(PANE_DOC), true, 'doc 视图被补回来');
    assert.equal(tabKeysOf(out).includes('notes'), true, 'notes 视图还在');
    assert.deepEqual([...new Set(tabKeysOf(out))].sort(), [...DEFAULT_PANE_IDS].sort(), '四个视图一个不少');
    assert.equal(new Set(tabKeysOf(out)).size, tabKeysOf(out).length, '实例身份全局唯一');
    // 一个节点的 tabs **不是数组**(v2 旧节点)也不能按 id 猜视图:空槽位收拢、视图按标签补回。
    // ⚠️ 从前那条断言是 `normalizeTree({id:'doc'})` 回来 `tabs:[{view:'doc'}]` ——
    // 那正是 v4 要禁掉的"按 pane.id 猜视图"(一个叫 doc 的槽位里可能装着 links)。
    // 现在只钉"doc 这个视图仍在树里、且只有一枚实例"。
    const legacyNode = normalizeTree({ type: 'pane', id: PANE_DOC }, [PANE_DOC]);
    assert.equal(tabKeysOf(legacyNode).filter((k) => k === PANE_DOC).length, 1, 'doc 视图被补回来了一枚');
});

test('标签规范化:active 越界一律夹回 0(负数 / 太大 / 非数字 / 空 tabs)', () => {
    const build = (tabs, active) => findPane(normalizeTree(treeWithDocTabs(tabs, active), DEFAULT_PANE_IDS), PANE_DOC);
    // ⚠️ 两枚都用**只属于这一格**的文档实例(理由见 treeWithDocTabs 的注释)
    const two = [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }];
    for (const bad of [2, 99, -1, -99, NaN, 'x', null, undefined, 1.7]) {
        const leaf = build(two, bad);
        assert.deepEqual(leaf.tabs, two, `active=${String(bad)} 时标签不该被动`);
        assert.ok(leaf.active >= 0 && leaf.active < leaf.tabs.length,
            `active=${String(bad)} 必须落在 [0, ${leaf.tabs.length}) 内,实际 ${leaf.active}`);
    }
    assert.equal(build(two, 1).active, 1, '合法的 active 照旧保留');
    assert.equal(build(two, 0).active, 0);
    // ⚠️ `treeWithDocTabs` 用的是 `pane(...)`,而 pane() 自己就把越界的 active 夹回 0 了
    // (v4 起活动的口径见 pane 与 normalizeTree 里 placePaneTabs 的注释)——
    // 所以"active=2 仍是第 1 枚"这条不该在这里断言;这里只保证**下标永远合法**。
    // ⚠️ 第四轮补的:显式 `tabs: []` = **空面板**(用户把最后一条也关掉了,这是接上界面之后的
    // 合法状态),与"没有 tabs 字段的 v2 旧节点 = 单视图"必须分得开 ——
    // 混在一起的话,要么空面板在重启后复活一个用户已经关掉的视图,
    // 要么 v2 老档里的每个面板都变成空面板(那就等于把老档读坏了)。
    // ⚠️ v4 起 `pane(id, [], 0)` 的**结果**是"空面板",但 normalizeTree 拿到它之后会
    // 把这一格收拢掉(不留空面板)—— 两层各自的口径见各自的注释。
    assert.deepEqual(pane(PANE_NOTES, [], 0), { type: 'pane', id: PANE_NOTES, tabs: [], active: 0 });
    // ⚠️ `pane()` 是**形状级**工厂,它没有视图注册表、也不该有(见函数注释):
    // 一条"读不懂的 view"在这里会原样穿过,由 normalizeTree 的 known 过滤 + 收拢负责。
    // 这里钉的是:第四参缺省时**不会**按 id 补一枚视图。
    assert.deepEqual(pane(PANE_NOTES, [{ view: '外人' }], 0),
        { type: 'pane', id: PANE_NOTES, tabs: [{ view: '外人' }], active: 0 },
        '工厂不做视图注册表校验(那是 normalizeTree 的活)');
    assert.deepEqual(pane(PANE_NOTES, [{ view: '外人' }], 0, PANE_AI).tabs, [{ view: '外人' }],
        '有东西可读时不追加 fallback');
    assert.deepEqual(pane(PANE_NOTES, [{ view: '外人' }], 0, '').tabs, [{ view: '外人' }],
        '第四参是"读不出时退回到哪枚视图",不是过滤器');
    assert.equal(pane(PANE_NOTES).tabs.length, 1, '不给 tabs 参数 = 单视图(旧档那条路)');
});

test('标签规范化:按**实例身份**去重 —— 同型不同文档实例是两个标签', () => {
    // 同一篇笔记的编辑器只能有一个标签;不同笔记 = 不同标签
    assert.notEqual(tabKey({ view: 'doc', doc: '甲篇.md' }), tabKey({ view: 'doc', doc: '乙篇.md' }));
    assert.equal(tabKey({ view: 'doc', doc: '甲篇.md' }), tabKey({ view: 'doc', doc: ' 甲篇.md ' }),
        '同一个文档实例(前后空白不算区别)');
    assert.equal(tabKey({ view: 'links' }), tabKey({ view: 'links' }));
    assert.notEqual(tabKey({ view: 'links' }), tabKey({ view: 'ai' }));
    assert.equal(tabKey({ view: 'doc' }), tabKey({ view: 'doc' }), '还没有文档实例的 doc 也是一种实例');

    const t = normalizeTree(treeWithDocTabs([
        { view: 'doc', doc: '甲篇.md' },
        { view: 'doc', doc: '甲篇.md' },        // 同一篇:重复,去掉
        { view: 'doc', doc: '乙篇.md' },        // 另一篇:留着
        { view: 'links' },
        { view: 'links' },                      // 同一个视图:重复,去掉
    ], 1), DEFAULT_PANE_IDS);
    const leaf = findPane(t, PANE_DOC);
    assert.deepEqual(leaf.tabs, [
        { view: 'doc', doc: '甲篇.md' },
        { view: 'doc', doc: '乙篇.md' },
        { view: 'links' },
    ], '重复的实例被去掉、不同的实例都留下,顺序不乱');
    // ⚠️ active=1 本来指着"重复的那一个甲篇":去重后它必须跟着**实例**落到 0(还是甲篇),
    // 而不是留在下标 1 上变成"乙篇"(那会让用户打开错的那篇笔记)
    assert.equal(leaf.active, 0);
    assert.deepEqual(leaf.tabs[leaf.active], { view: 'doc', doc: '甲篇.md' });
});

test('标签规范化:normalizeTabs 只认 known 里的 view(空列表交给调用方回退)', () => {
    const tabs = [{ view: 'doc', doc: '甲篇.md' }, { view: '外人' }, { view: 'links' }];
    assert.deepEqual(normalizeTabs(tabs, DEFAULT_PANE_IDS), [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }]);
    assert.deepEqual(normalizeTabs(tabs, ['doc']), [{ view: 'doc', doc: '甲篇.md' }]);
    assert.deepEqual(normalizeTabs(tabs, []), [], '没有认得的 view → 空(回退是调用方的事)');
    assert.deepEqual(normalizeTabs(null, DEFAULT_PANE_IDS), []);
    assert.deepEqual(normalizeTabs(tabs, DEFAULT_PANE_IDS, PANE_AI), [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }],
        '有认得的标签时不追加 fallback');
    assert.deepEqual(normalizeTabs([{ view: '外人' }], DEFAULT_PANE_IDS, PANE_AI), [{ view: PANE_AI }],
        '一条都不认得时才回退成 fallback 的单视图');
    // ⚠️ 显式空数组 = 空面板,原样保留([]≠"回退单视图")
    assert.deepEqual(normalizeTabs([], DEFAULT_PANE_IDS, PANE_AI), []);
    assert.deepEqual(normalizeTabs([], DEFAULT_PANE_IDS), []);
});

test('标签:pane()/cloneTree 造出来的叶子永远带 tabs+active(拖动不会抹掉标签)', () => {
    // 树上每一次拖动都在重建叶子 —— 只要有一条路能造出没有标签的叶子,拖一次就丢数据
    assert.deepEqual(pane(A), { type: 'pane', id: A, tabs: [{ view: A }], active: 0 });
    const tabbed = pane(A, [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }], 1);
    assert.deepEqual(tabbed.tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }]);
    assert.equal(tabbed.active, 1);
    // 深拷贝带着标签走,而且改副本不动原树
    const copy = cloneTree(tabbed);
    assert.deepEqual(copy, tabbed);
    copy.tabs.push({ view: 'ai' });
    assert.equal(tabbed.tabs.length, 2, '克隆是深拷贝(标签数组也是)');
    // 树上的几条"重建叶子"的路都要保住标签
    const tree = split('row', [50, 50], [pane(A), pane(B, [{ view: 'doc', doc: '甲篇.md' }], 0)]);
    const docTabs = [{ view: 'doc', doc: '甲篇.md' }];
    assert.deepEqual(findPane(detach(tree, A).tree, B).tabs, docTabs);
    assert.deepEqual(findPane(dockBottom(tree, A), B).tabs, docTabs);
    assert.deepEqual(findPane(dropOnEdge(tree, A, B, 'bottom'), B).tabs, docTabs);
    assert.deepEqual(findPane(setPairRatio(tree, tree, 0, 30), B).tabs, docTabs);
    // 换位:换的是**整片面板**(id + 标签),所以两片各自带着自己的标签走到对方那一格 ——
    // 绝不会出现"面板 id 换了、标签还留在原地"那种对不上的树
    const swapped = swapPanes(tree, A, B);
    assert.deepEqual(listPaneIds(swapped), [B, A], '两片换了位置');
    assert.deepEqual(findPane(swapped, B).tabs, docTabs, 'B 带着自己的标签走到第 1 格');
    assert.deepEqual(findPane(swapped, A).tabs, [{ view: A }], 'A 带着自己的标签走到第 2 格');
});

test('迁移 v2→v3:migrateV2Tabs 给每个面板补单视图标签,已有标签一个字节不动', () => {
    // v2 的形状:裸叶子(没有 tabs)
    const v2 = {
        dir: 'row', sizes: [17.35, 82.65],
        children: [
            { type: 'pane', id: PANE_NOTES },
            { dir: 'row', sizes: [75.27, 24.73], children: [{ type: 'pane', id: PANE_SIDE }, { type: 'pane', id: PANE_DOC }] },
        ],
    };
    const after = migrateV2Tabs(v2);
    assert.deepEqual(after, {
        dir: 'row', sizes: [17.35, 82.65],
        children: [
            { type: 'pane', id: PANE_NOTES, tabs: [{ view: PANE_NOTES }], active: 0 },
            {
                dir: 'row', sizes: [75.27, 24.73],
                children: [
                    { type: 'pane', id: PANE_SIDE, tabs: [{ view: PANE_SIDE }], active: 0 },
                    { type: 'pane', id: PANE_DOC, tabs: [{ view: PANE_DOC }], active: 0 },
                ],
            },
        ],
    }, '比例/形状一个字节不动,只补 tabs+active');
    assert.deepEqual(v2.children[0], { type: 'pane', id: PANE_NOTES }, '纯函数:原树不动');
    // 幂等 + 已迁移过的树原样返回(同一个引用)
    assert.deepEqual(migrateV2Tabs(after), after);
    assert.equal(migrateV2Tabs(after), after);
    // 已经有标签的节点绝不被覆盖成单视图
    const tabbed = split('row', [50, 50], [pane(A), pane(B, [{ view: 'doc', doc: '甲篇.md' }], 0)]);
    assert.equal(migrateV2Tabs(tabbed), tabbed, '一个节点都不用补 → 原样返回(新档一个字节都不动)');
    assert.deepEqual(findPane(migrateV2Tabs(tabbed), B).tabs, [{ view: 'doc', doc: '甲篇.md' }]);
    // 脏输入不抛
    for (const bad of [null, undefined, 42, 'x', { dir: 'row', children: 'x' }]) {
        assert.doesNotThrow(() => migrateV2Tabs(bad));
    }
});

test('收编行为不变:adoptPanes 保住用户已有的标签,只给新面板补单视图', () => {
    const DRAMA = 'drama';
    const user = split('row', [19, 62, 19], [
        pane(PANE_NOTES),
        pane(PANE_DOC, [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }], 1),
        split('col', [42, 58], [pane(PANE_LINKS), pane(PANE_AI)]),
    ]);
    const next = adoptPanes(user, [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI, DRAMA],
        { [DRAMA]: { anchor: PANE_DOC, dir: 'row', sizes: [62, 38] } });
    assert.deepEqual(listPaneIds(next), [PANE_NOTES, PANE_DOC, DRAMA, PANE_LINKS, PANE_AI],
        '只把缺的那片插到 anchor 后面,用户原有的排布不变');
    // 用户面板的标签原样保留(收编不许顺手重置别人的标签)
    assert.deepEqual(findPane(next, PANE_DOC).tabs, [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }]);
    assert.equal(findPane(next, PANE_DOC).active, 1);
    // 新面板拿到的就是"单视图"默认值
    assert.deepEqual(findPane(next, DRAMA).tabs, [{ view: DRAMA }]);
    assert.equal(findPane(next, DRAMA).active, 0);
    // ⚠️ 集合一致时照旧**原样返回同一个引用**(新档一个字节都不动)
    const same = defaultTree();
    assert.equal(adoptPanes(same, DEFAULT_PANE_IDS), same);
});

// ---- 旧档迁移:`side`(反向链接 + AI 合并成的那个面板)----
//
// 这一组的存在理由:用户**已经有**持久化的旧布局。把 `side` 当未知 id 丢掉的后果是
// "他明明没动过设置,面板却凭空少一个、排布被打回默认" —— 那是这次改动最容易出错、
// 也最容易被单测漏掉的地方(结构断言照样全绿,只是用户的排布没了)。

/** 用户实测的那份旧档(设置文件里原样抄下来的形状)。 */
const USER_LEGACY = () => ({
    dir: 'row', sizes: [17.35, 82.65],
    children: [
        pane(PANE_NOTES),
        { dir: 'row', sizes: [75.27, 24.73], children: [pane(PANE_SIDE), pane(PANE_DOC)] },
    ],
});

test('迁移:用户那份旧档(含 side)→ 就地拆成 links + ai,槽位与比例都不动', () => {
    const before = USER_LEGACY();
    const after = migrateLegacyTree(before, { knownIds: DEFAULT_PANE_IDS });
    assert.deepEqual(listPaneIds(after), [PANE_NOTES, PANE_LINKS, PANE_AI, PANE_DOC], 'side 变成了 links + ai');
    assert.equal(listPaneIds(after).includes(PANE_SIDE), false, '旧 id 不许留下');
    assert.deepEqual(after.sizes, before.sizes, '外层的 17.35 / 82.65 一点不动');
    const inner = after.children[1];
    assert.deepEqual(inner.sizes, before.children[1].sizes, '内层的 75.27 / 24.73 也一点不动');
    // side 原来那个槽位(内层 row 的第 0 格)现在是一个**上下分割**
    assert.equal(inner.children[0].dir, 'col');
    assert.deepEqual(listPaneIds(inner.children[0]), [PANE_LINKS, PANE_AI], '链接在上、AI 在下');
    assert.deepEqual(inner.children[0].sizes, DEFAULT_SIDE_SPLIT);
    assert.equal(inner.children[1].id, PANE_DOC, '正文还在它原来的位置上');
    // "别拆出两条细缝":两片都在最小比例之上
    assert.ok(inner.children[0].sizes.every((s) => s >= MIN_RATIO), JSON.stringify(inner.children[0].sizes));
});

test('迁移:旧的三栏默认布局 → 拆出来就是**新的默认布局**(两者是同一种排法)', () => {
    const legacyDefault = {
        dir: 'row', sizes: [19, 62, 19],
        children: [pane(PANE_NOTES), pane(PANE_DOC), pane(PANE_SIDE)],
    };
    const migrated = migrateLegacyTree(legacyDefault, { knownIds: DEFAULT_PANE_IDS });
    assert.deepEqual(migrated, defaultTree(), '旧默认迁移后逐字段等于 defaultTree()(链接与 AI 叠在右侧)');
    // 从没存过档时那条路(用旧的像素宽当权重)形状也必须一样,只是权重是按像素算的
    const byPx = treeFromWidths({ navW: 236, sideW: 240, avail: 1254 });
    assert.deepEqual(listPaneIds(byPx), listPaneIds(migrated));
    assert.deepEqual(byPx.children.map((c) => c.dir), migrated.children.map((c) => c.dir));
    assert.deepEqual(byPx.children[2].sizes, migrated.children[2].sizes);
});

test('迁移:side 就是整棵树 / side 在 col 里(整宽底栏)—— 切法跟着槽位的形状走', () => {
    // ① 整棵树就是 side(单面板档):窄高的槽位 → 上下叠
    const only = migrateLegacyTree(pane(PANE_SIDE), { knownIds: DEFAULT_PANE_IDS });
    assert.equal(only.dir, 'col');
    assert.deepEqual(listPaneIds(only), [PANE_LINKS, PANE_AI]);
    // ② side 被停靠在整宽底栏里:{col 72/28}[ 原树, side ] → 宽扁的槽位 → **左右并排**
    const docked = {
        dir: 'col', sizes: [72, 28],
        children: [split('row', [50, 50], [pane(PANE_NOTES), pane(PANE_DOC)]), pane(PANE_SIDE)],
    };
    const after = migrateLegacyTree(docked, { knownIds: DEFAULT_PANE_IDS });
    assert.deepEqual(listPaneIds(after), [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI]);
    assert.equal(after.children[0].dir, 'row', '原来的两栏不动');
    assert.equal(after.children[1].dir, 'row', '底栏里左右并排(上下切才会是两条细缝)');
    assert.deepEqual(after.children[1].sizes, DEFAULT_SIDE_SPLIT);
});

test('迁移:没有旧 id 的树**原样返回**(新档一个字节都不动),脏输入不抛', () => {
    const modern = defaultTree();
    assert.equal(migrateLegacyTree(modern, { knownIds: DEFAULT_PANE_IDS }), modern, '同一个引用');
    const weird = { dir: 'row', sizes: [50, 50], children: [pane('notes'), pane('外人')] };
    assert.equal(migrateLegacyTree(weird, { knownIds: DEFAULT_PANE_IDS }), weird);
    // 脏档:migrate 不负责兜底(那是 normalizeTree 的活),但**绝不许抛**
    const cyclic = { dir: 'row', sizes: [50, 50], children: [pane(PANE_SIDE)] };
    cyclic.children.push(cyclic);
    assert.doesNotThrow(() => migrateLegacyTree(cyclic, { knownIds: DEFAULT_PANE_IDS }));
    for (const bad of [null, undefined, 42, 'x']) {
        assert.doesNotThrow(() => migrateLegacyTree(bad, { knownIds: DEFAULT_PANE_IDS }));
    }
});

test('迁移:未知视图的丢弃行为(v3「整棵退回默认」→ v4「过滤 + 收拢 + 收编」)', () => {
    // ⚠️ 这条用例在 v4 里**换了判据**,原因写清楚:
    //   · v3 里 `pane.id` 与 `view` 共用一个命名空间,于是"未知 id"只有一种解释 ——
    //     那一格读不懂 → 整棵档算坏 → 退回默认树;
    //   · v4 里 `pane.id` 是**槽位键**(新槽位叫 `slot:<序号>`),"id 不在注册表里"是正常的,
    //     "未知"只剩**标签视图**这一种。而未知视图按规格 §5.5 走另一条路:
    //     过滤掉它 → 槽位因此空掉就收拢 → 缺掉的必需视图由收编补回。
    //   这条改动是**刻意的**:v3 的判据会让"用户刚合并好的布局 + 插件被卸掉"这两种
    //   互不相干的事一起把布局打回默认,而后者恰恰是 §5 要保住的。
    const withStranger = {
        dir: 'row', sizes: [34, 33, 33],
        children: [pane(PANE_NOTES), pane(PANE_SIDE), pane('外人')],
    };
    const migrated = migrateLegacyTree(withStranger, { knownIds: DEFAULT_PANE_IDS });
    assert.deepEqual(listPaneIds(migrated).includes('外人'), true, 'migrate 自己不做丢弃');
    const clean = normalizeTree(migrated, DEFAULT_PANE_IDS);
    assert.deepEqual([...listPaneIds(clean)].sort(), [...DEFAULT_PANE_IDS].sort(),
        '外人 那一格被丢掉,但它占掉的视图一个都不能少(收编补回)');
    assert.equal(countPanes(clean), DEFAULT_PANE_IDS.length);
    // 映射里的 id 调用方一个都不认得(例如只认得旧 id 的老调用方)时:迁移**保持原样**
    const kept = migrateLegacyTree(pane(PANE_SIDE), { knownIds: ['notes', 'doc'] });
    assert.deepEqual(kept, pane(PANE_SIDE));
    assert.deepEqual([...listPaneIds(normalizeTree(kept, ['notes', 'doc']))].sort(), ['doc', 'notes']);
});

test('迁移:幂等(迁移过的树再迁移一次,结果一模一样)', () => {
    const once = migrateLegacyTree(USER_LEGACY(), { knownIds: DEFAULT_PANE_IDS });
    const twice = migrateLegacyTree(once, { knownIds: DEFAULT_PANE_IDS });
    assert.deepEqual(twice, once);
});

test('迁移 + 归一化:旧档走完整解码路径后,面板一个不少、旧 id 不出现', () => {
    const decoded = normalizeTree(migrateLegacyTree(USER_LEGACY(), { knownIds: DEFAULT_PANE_IDS }), DEFAULT_PANE_IDS);
    assert.deepEqual([...listPaneIds(decoded)].sort(), [...DEFAULT_PANE_IDS].sort());
    assert.equal(countPanes(decoded), 4);
    assert.equal(LEGACY_PANE_SPLITS[PANE_SIDE].join(','), 'links,ai', '映射就是这一个(顺序 = 槽位里的先后)');
});
