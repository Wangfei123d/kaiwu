import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    LAYOUT_KEY, LAYOUT_NAMESPACE, LAYOUT_VERSION, LAYOUT_VERSION_PREV,
    encodeLayout, decodeLayout, decodeLayoutResult, createLayoutStore,
} from '../app/lib/panel-layout-store.js';
import {
    DEFAULT_PANE_IDS, DEFAULT_SIDE_SPLIT, PANE_AI, PANE_DOC, PANE_LINKS, PANE_NOTES, PANE_SIDE,
    defaultTree, listPaneIds, pane, split, dropOnEdge, dockBottom, formatTree, MIN_RATIO,
    adoptPanes, DEFAULT_ADOPTION, findPane, LEGACY_PANE_SPLITS, migrateV2Tabs, normalizeTabs,
    moveTabToEdge, moveTabToPane, tabKeysOf, nextSlotSeq, normalizeTree,
} from '../app/lib/panel-tree.js';
/** 短剧画布作为"第五片"接入时的 known 集合与位置表(与外壳将来传的一致)。 */
const DRAMA = 'drama';
const WITH_DRAMA = [...DEFAULT_PANE_IDS, DRAMA];
const PLACE = { [DRAMA]: { anchor: PANE_DOC, dir: 'row', sizes: [62, 38] } };

// 布局存档(契约 v3)。这一层的全部价值只有一句话:**坏档绝不能把界面带塌**。
// 所以下面大半用例都是"喂垃圾进去,必须原样退回默认树,而且绝不抛"。
// 唯一的例外是**读得懂的旧档**,有两类:
//   · 已知的旧面板 id:`side` 拆成 links + ai(见文件末尾的迁移用例);
//   · 已知的旧契约版本:v2 没有标签结构,补成单视图(见下面那组 v2 用例)。
// ⚠️ v3 与 v2 的差别是**每个面板多带 tabs/active**。本次改动最容易做错的地方是
// "解码时按 id 重建节点、把 tabs 整片剥掉" —— 树形与面板数量照样全对,测试也就照样绿。
// 所以下面专门有一组"标签存得住"的回归用例钉住它。

const memory = (initial) => {
    let value = initial;
    return {
        read: () => value,
        write: (text) => { value = text; },
        peek: () => value,
    };
};

test('键带命名空间,版本号是 4(v4 = 槽位里前后叠放的面板,槽位 id 不再等于视图名)', () => {
    assert.equal(LAYOUT_VERSION, 4);
    assert.equal(LAYOUT_VERSION_PREV, 2, '上一个契约版本要单独有名字:升级路径就靠它');
    assert.equal(LAYOUT_NAMESPACE, '__global');
    assert.match(LAYOUT_KEY, /^[\w.-]+$/);
    assert.ok(LAYOUT_KEY.includes('.'), '带命名空间的键,不裸用一个全局名');
});

test('encodeLayout/decodeLayout:树 → 文本 → 树,回来还是同一棵', () => {
    for (const tree of [defaultTree(), dockBottom(defaultTree(), PANE_AI),
        dropOnEdge(defaultTree(), 'notes', 'doc', 'bottom')]) {
        const text = encodeLayout(tree);
        assert.equal(typeof text, 'string');
        assert.equal(JSON.parse(text).v, LAYOUT_VERSION, '档里必须带版本号');
        assert.deepEqual(decodeLayout(text, DEFAULT_PANE_IDS), tree);
    }
});

test('decodeLayout:空 / 坏 JSON / 未知版本 / 形状不对 —— 一律默认树,绝不抛', () => {
    const junk = [
        undefined, null, '', '   ', '{', 'null', '[]', '"x"', '42',
        JSON.stringify({ v: 1, tree: defaultTree() }),                 // 太老(从没发布过 v1)
        JSON.stringify({ v: LAYOUT_VERSION + 1, tree: defaultTree() }),// ★ 未来版本(v5):唯一安全的做法是承认看不懂
        JSON.stringify({ v: LAYOUT_VERSION }),                         // 没有 tree
        JSON.stringify({ v: LAYOUT_VERSION, tree: 'nope' }),
        JSON.stringify({ v: LAYOUT_VERSION, tree: [1, 2, 3] }),
        JSON.stringify({ v: LAYOUT_VERSION, tree: { dir: 'row', sizes: [50, 50], children: [] } }),
        JSON.stringify(defaultTree()),                                 // 裸树,没有版本包装
        {}, [], 42, true,
    ];
    for (const bad of junk) {
        const tree = decodeLayout(bad, DEFAULT_PANE_IDS);
        assert.deepEqual(listPaneIds(tree), DEFAULT_PANE_IDS,
            `${String(bad).slice(0, 40)} 应退回默认三栏`);
        assert.equal(decodeLayoutResult(bad, DEFAULT_PANE_IDS).ok, false);
    }
    // ⚠️ 这一版的**两处**判据变化:
    //   ① v2 是**读得懂**的旧档,所以它从上表里出去(见下面那组 v2 用例);
    //   ② "一棵混进未知视图的档"也**不再**算坏档:槽位 id 与视图名解耦之后,
    //      "未知"只剩**标签视图**这一种,而它按规格 §5.5 走"过滤 + 收拢 + 收编"那条
    //      安全路径(见下面那条独立用例)。
    // "未来版本"那条判据一个字都没松(fixture 跟着版本号走,现在是 v5)。
});

test('decodeLayout:v2(上一个契约)照旧算「读得懂」,ok=true 而不是坏档', () => {
    // 这份 v2 档是升级前那版代码写下的形状:有版本号、有树、**没有 tabs**
    const v2 = JSON.stringify({
        v: LAYOUT_VERSION_PREV,
        tree: {
            dir: 'row', sizes: [19, 62, 19],
            children: [
                { type: 'pane', id: PANE_NOTES },
                { type: 'pane', id: PANE_DOC },
                {
                    dir: 'col', sizes: DEFAULT_SIDE_SPLIT,
                    children: [{ type: 'pane', id: PANE_LINKS }, { type: 'pane', id: PANE_AI }],
                },
            ],
        },
    });
    const result = decodeLayoutResult(v2, DEFAULT_PANE_IDS);
    assert.equal(result.ok, true, 'v2 是旧契约,不是坏档');
    assert.deepEqual(listPaneIds(result.tree), DEFAULT_PANE_IDS);
    // v2 的坏档:形状不对照旧退回默认 —— 版本旧不等于什么都收
    for (const bad of [
        JSON.stringify({ v: LAYOUT_VERSION_PREV, tree: 'nope' }),
        JSON.stringify({ v: LAYOUT_VERSION_PREV, tree: { dir: 'row', sizes: [50, 50], children: [] } }),
    ]) {
        const r = decodeLayoutResult(bad, DEFAULT_PANE_IDS);
        assert.equal(r.ok, false, `${bad.slice(0, 60)} 仍算坏档`);
        assert.deepEqual(listPaneIds(r.tree), DEFAULT_PANE_IDS);
    }
    // ⚠️ 而"v2 + 未知视图"从 v4 起**不算坏档**:那一格被丢掉、它认得的东西一个不少。
    //    判据的变化写在下面那条用例里(以及 panel-tree.js 的 validateLayout 注释)。
    const stranger = decodeLayoutResult(
        JSON.stringify({ v: LAYOUT_VERSION_PREV, tree: { dir: 'row', sizes: [50, 50], children: [{ type: 'pane', id: PANE_NOTES }, { type: 'pane', id: '外人' }] } }),
        DEFAULT_PANE_IDS,
    );
    assert.equal(stranger.ok, true);
    assert.deepEqual([...listPaneIds(stranger.tree)].sort(), [...DEFAULT_PANE_IDS].sort(), '四个视图一个不少');
    assert.equal(listPaneIds(stranger.tree).includes('外人'), false, '那一格被丢掉');
});

test('decodeLayoutResult:合法档 ok=true 并能分辨「没存过」与「存坏了」', () => {
    const good = encodeLayout(defaultTree());
    assert.equal(decodeLayoutResult(good, DEFAULT_PANE_IDS).ok, true);
    assert.equal(decodeLayoutResult(undefined, DEFAULT_PANE_IDS).ok, false, '从没存过');
    assert.equal(decodeLayoutResult('{oops', DEFAULT_PANE_IDS).ok, false, '存坏了');
});

test('createLayoutStore:存档往返 —— save 写进去的,load 能原样读回来', async () => {
    const storage = memory(undefined);
    const store = createLayoutStore({ storage, knownIds: DEFAULT_PANE_IDS });
    const laid = dockBottom(defaultTree(), PANE_AI);

    assert.equal(await store.save(laid), true);
    assert.equal(typeof storage.peek(), 'string', '存进通道的是文本');
    const { ok, tree } = await store.load();
    assert.equal(ok, true);
    assert.deepEqual(tree, laid);
});

test('createLayoutStore:从没存过 → 默认树且 ok=false(外壳据此用旧的像素宽度当权重)', async () => {
    const store = createLayoutStore({ storage: memory(undefined), knownIds: DEFAULT_PANE_IDS });
    const { ok, tree } = await store.load();
    assert.equal(ok, false);
    assert.deepEqual(tree, defaultTree());
});

test('createLayoutStore:读通道抛错 → 默认树,绝不抛', async () => {
    const store = createLayoutStore({
        storage: { read: () => { throw new Error('设置通道坏了'); }, write: () => {} },
        knownIds: DEFAULT_PANE_IDS,
        log: { warn() {} },
    });
    const { ok, tree } = await store.load();
    assert.equal(ok, false);
    assert.deepEqual(listPaneIds(tree), DEFAULT_PANE_IDS);
});

test('createLayoutStore:写通道抛错 → 返回 false,绝不抛', async () => {
    const store = createLayoutStore({
        storage: { read: () => undefined, write: () => { throw new Error('盘满了'); } },
        knownIds: DEFAULT_PANE_IDS,
        log: { warn() {} },
    });
    assert.equal(await store.save(defaultTree()), false);
});

test('createLayoutStore:绝不把一棵坏树写进档里(写之前先归一化)', async () => {
    const storage = memory(undefined);
    const store = createLayoutStore({ storage, knownIds: DEFAULT_PANE_IDS });
    await store.save(split('row', [50, 50], [pane('notes'), pane('外人')]));
    const saved = JSON.parse(storage.peek());
    assert.deepEqual(listPaneIds(saved.tree), DEFAULT_PANE_IDS, '坏树被换成了默认三栏');
    assert.equal(saved.v, LAYOUT_VERSION);
});

test('createLayoutStore:clear 之后回到默认三栏', async () => {
    const storage = memory(undefined);
    const store = createLayoutStore({ storage, knownIds: DEFAULT_PANE_IDS });
    await store.save(dockBottom(defaultTree(), 'doc'));
    await store.clear();
    const { ok } = await store.load();
    assert.equal(ok, false, '空串 = 没存过');
});

test('createLayoutStore:没有 storage(通道没接上)也安全退化', async () => {
    const store = createLayoutStore({});
    const { ok, tree } = await store.load();
    assert.equal(ok, false);
    assert.deepEqual(listPaneIds(tree), DEFAULT_PANE_IDS);
    assert.equal(await store.save(defaultTree()), false);
    assert.equal(store.key, LAYOUT_KEY);
});

test('可选视图:存档读写保留缺席的工具面板,布局比例不变', async () => {
    const tool = 'tool:bilibili';
    const knownIds = [...DEFAULT_PANE_IDS, tool];
    const rawTree = defaultTree();
    const saved = encodeLayout(rawTree);
    const storage = memory(saved);

    const decoded = decodeLayoutResult(saved, knownIds, DEFAULT_ADOPTION, DEFAULT_PANE_IDS);
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.tree, rawTree);
    assert.equal(listPaneIds(decoded.tree).includes(tool), false);

    const store = createLayoutStore({ storage, knownIds, requiredIds: DEFAULT_PANE_IDS });
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.tree, rawTree);
    assert.equal(await store.save(loaded.tree), true);
    assert.deepEqual(decodeLayoutResult(storage.peek(), knownIds, DEFAULT_ADOPTION, DEFAULT_PANE_IDS).tree, rawTree);
});

test('createLayoutStore:异步 storage(真外壳走 IPC,是 Promise)', async () => {
    let value;
    const store = createLayoutStore({
        storage: {
            read: async () => value,
            write: async (text) => { await new Promise((r) => setTimeout(r, 1)); value = text; },
        },
        knownIds: DEFAULT_PANE_IDS,
    });
    const laid = dropOnEdge(defaultTree(), 'notes', PANE_AI, 'bottom');
    assert.equal(await store.save(laid), true);
    assert.deepEqual((await store.load()).tree, laid);
});

// ---- 旧档迁移(`side` → links + ai)----
//
// 这一组是这次改动里**最容易悄悄坏掉**的地方:用户已经有持久化的旧布局,而我们换了
// 面板 id。丢掉 `side` 的后果不是"界面出错",而是"他明明没动过设置,排布却被打回默认" ——
// 结构断言照样全绿。所以这里把三条路都钉住:非默认排布、**恰好是默认排布**、以及
// "其它未知 id 照旧不算数"。

/** 用户实测的那份旧档(设置文件里的形状,原样抄下来)。 */
const USER_LEGACY_TEXT = JSON.stringify({
    v: LAYOUT_VERSION,
    tree: {
        dir: 'row', sizes: [17.35, 82.65],
        children: [
            pane(PANE_NOTES),
            { dir: 'row', sizes: [75.27, 24.73], children: [pane(PANE_SIDE), pane(PANE_DOC)] },
        ],
    },
});

test('迁移:含 side 的旧档解出来是 links + ai,没有 side,尺寸合理且排布不变', () => {
    const result = decodeLayoutResult(USER_LEGACY_TEXT, DEFAULT_PANE_IDS);
    assert.equal(result.ok, true, '旧档是**读得懂**的,不许当成坏档');
    const tree = result.tree;
    const ids = listPaneIds(tree);
    assert.deepEqual(ids, [PANE_NOTES, PANE_LINKS, PANE_AI, PANE_DOC], '原槽位里:链接在上、AI 在下');
    assert.equal(ids.includes(PANE_SIDE), false, '旧 id 不许留下');
    assert.equal(ids.length, DEFAULT_PANE_IDS.length);
    // 用户原本的排列大体不变:笔记还在最左,正文还在内层 row 的右边
    assert.deepEqual(tree.sizes, [17.35, 82.65]);
    assert.deepEqual(tree.children[1].sizes, [75.27, 24.73]);
    assert.equal(tree.children[1].children[1].id, PANE_DOC);
    const slot = tree.children[1].children[0];
    assert.equal(slot.dir, 'col');
    assert.deepEqual(slot.sizes, DEFAULT_SIDE_SPLIT);
    assert.ok(slot.sizes.every((s) => s >= MIN_RATIO && s <= 100 - MIN_RATIO), '两片都不在细缝里');
    // 存档往返:迁移后的树再存再读还是它(迁移是幂等的)
    assert.deepEqual(decodeLayout(encodeLayout(tree), DEFAULT_PANE_IDS), tree);
});

test('迁移:用户当前布局**恰好是默认布局**时也要能迁移(不许只在非默认分支里处理)', () => {
    // 旧默认 = 一行三栏(左列表 / 中正文 / 右 side)
    const legacyDefault = JSON.stringify({
        v: LAYOUT_VERSION,
        tree: { dir: 'row', sizes: [19, 62, 19], children: [pane(PANE_NOTES), pane(PANE_DOC), pane(PANE_SIDE)] },
    });
    const result = decodeLayoutResult(legacyDefault, DEFAULT_PANE_IDS);
    assert.equal(result.ok, true);
    assert.deepEqual(listPaneIds(result.tree), [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI]);
    assert.equal(formatTree(result.tree), formatTree(defaultTree()), '拆出来就是新的默认布局');
    assert.equal(result.tree.children[2].dir, 'col');
});

test('迁移:side 被停在整宽底栏时左右并排(上下切会拆成两条细缝)', () => {
    const legacyBottom = JSON.stringify({
        v: LAYOUT_VERSION,
        tree: {
            dir: 'col', sizes: [72, 28],
            children: [split('row', [50, 50], [pane(PANE_NOTES), pane(PANE_DOC)]), pane(PANE_SIDE)],
        },
    });
    const { ok, tree } = decodeLayoutResult(legacyBottom, DEFAULT_PANE_IDS);
    assert.equal(ok, true);
    assert.deepEqual(listPaneIds(tree), [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI]);
    assert.equal(tree.children[1].dir, 'row', '宽扁的底栏里左右并排');
    assert.deepEqual(tree.children[1].sizes, DEFAULT_SIDE_SPLIT);
});

test('迁移:其它未知 id 照旧不算数(迁移不会让一棵坏树蒙混过关)', () => {
    // `side` 能被读懂,但多出来的 `外人` 不能 —— 面板集合对不上,照旧退回默认树
    const withStranger = JSON.stringify({
        v: LAYOUT_VERSION,
        tree: {
            dir: 'row', sizes: [35, 35, 30],
            children: [pane(PANE_NOTES), pane(PANE_SIDE), pane('外人')],
        },
    });
    const result = decodeLayoutResult(withStranger, DEFAULT_PANE_IDS);
    // ⚠️ v3 里这条判的是 `ok === false`(有未知 id → 整棵档算坏 → 退回默认树)。
    // v4 起 `pane.id` 是**槽位键**,不再与视图名一一对应 —— 但 `外人` 不是"槽位名怪",
    // 它是一条**读不懂的标签视图**,于是走规格 §5.5 那条路:过滤掉它、把它腾出来的位置
    // 交还给需要它的视图。判据换成"视图一个不少、外人一个不留",而不是"整棵树作废"。
    assert.equal(result.ok, true, '读得懂的部分必须留住(不许整棵退回默认)');
    assert.deepEqual([...listPaneIds(result.tree)].sort(), [...DEFAULT_PANE_IDS].sort());
    assert.equal(listPaneIds(result.tree).includes(PANE_SIDE), false);
    assert.equal(listPaneIds(result.tree).includes('外人'), false);
    assert.equal(new Set(tabKeysOf(result.tree)).size, tabKeysOf(result.tree).length, '实例身份全局唯一');
});

test('迁移:只认得旧 id 的老调用方(knownIds 里没有 links/ai)行为不变', () => {
    // 老调用方传的还是三个旧 id:这时 `side` **不展开**(它本来就认得这一片),
    // 于是那份旧档原样读回来 —— 迁移是按调用方给的 knownIds 决定的,不越权替它改形状
    const legacyIds = [PANE_NOTES, PANE_DOC, PANE_SIDE];
    const legacyDefault = JSON.stringify({
        v: LAYOUT_VERSION,
        tree: { dir: 'row', sizes: [19, 62, 19], children: [pane(PANE_NOTES), pane(PANE_DOC), pane(PANE_SIDE)] },
    });
    const result = decodeLayoutResult(legacyDefault, legacyIds);
    assert.equal(result.ok, true);
    assert.deepEqual(listPaneIds(result.tree), legacyIds);
    assert.equal(listPaneIds(result.tree).includes(PANE_SIDE), true, '老调用方这边 side 还在');
    assert.equal(listPaneIds(result.tree).includes(PANE_LINKS), false, '没有被塞进新 id');
    // 同一份档换新调用方读:这一次 `side` 被拆开(下面那条用例已经在测,这里再钉一次对照)
    assert.deepEqual(listPaneIds(decodeLayout(legacyDefault, DEFAULT_PANE_IDS)),
        [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI]);
});

test('迁移:store.load 也走迁移(真外壳读存档那条路)', async () => {
    const store = createLayoutStore({ storage: memory(USER_LEGACY_TEXT), knownIds: DEFAULT_PANE_IDS });
    const { ok, tree } = await store.load();
    assert.equal(ok, true);
    assert.deepEqual(listPaneIds(tree), [PANE_NOTES, PANE_LINKS, PANE_AI, PANE_DOC]);
});

// ---------------------------------------------------------------------------
// v2 → v3 的标签迁移。
//
// 这一组是本次改动的**第一半**:契约从 v2 升到 v3(每个面板多带 tabs/active)。
// 升级那一刻所有用户手里都只有 v2 档 —— 老档必须**读懂**(补成单视图标签、
// 排布一个字节不动、ok=true),绝不能被判成坏档而整份打回默认(那等于清空用户
// 辛苦拖出来的布局,而且界面上只会表现成"我的布局没了")。
//
// ⚠️ 下面这份 fixture **必须手写 `{type:'pane', id}` 字面量**:面板工厂 `pane()`
// 现在会补上单视图标签,用它造出来的东西已经不是 v2 档了 —— 那样就测不到迁移。
// ---------------------------------------------------------------------------

/** 一份**真实的 v2 存档**(抄自设置文件):v=2、裸叶子(没有 tabs)、比例是用户拖出来的。 */
const REAL_V2_TEXT = JSON.stringify({
    v: 2,
    tree: {
        dir: 'row', sizes: [17.35, 82.65],
        children: [
            { type: 'pane', id: PANE_NOTES },
            {
                dir: 'row', sizes: [75.27, 24.73],
                children: [{ type: 'pane', id: PANE_SIDE }, { type: 'pane', id: PANE_DOC }],
            },
        ],
    },
});

/** 更完整的一份 v2 档:**四个面板**,里面还带着升级前那个合并面板 `side`。 */
const V2_FOUR_PANES_TEXT = JSON.stringify({
    v: 2,
    tree: {
        dir: 'row', sizes: [17, 44, 20, 19],
        children: [
            { type: 'pane', id: PANE_NOTES },
            { type: 'pane', id: PANE_DOC },
            { type: 'pane', id: DRAMA },
            { type: 'pane', id: PANE_SIDE },
        ],
    },
});

test('v2 升级:用户那份真 v2 档(含 side)解码 ok=true,面板一个都不少,排布/比例不变', () => {
    const result = decodeLayoutResult(REAL_V2_TEXT, DEFAULT_PANE_IDS);
    assert.equal(result.ok, true, 'v2 老档是**读得懂**的:不许判成坏档(判坏了 = 整份布局被清空)');
    const tree = result.tree;
    // 旧档面板集合:sidenote 三个面板;side 按既有规则就地拆成 links + ai → 四个
    const v2Ids = listPaneIds(JSON.parse(REAL_V2_TEXT).tree);
    assert.deepEqual(v2Ids, [PANE_NOTES, PANE_SIDE, PANE_DOC], 'fixture 确实是 v2(裸叶子、含 side)');
    assert.deepEqual(listPaneIds(tree), [PANE_NOTES, PANE_LINKS, PANE_AI, PANE_DOC],
        '面板一个都不少(side 拆成 links+ai,顺序仍按它原来的槽位)');
    assert.equal(listPaneIds(tree).length, v2Ids.length + LEGACY_PANE_SPLITS[PANE_SIDE].length - 1,
        '少一片或多一片都算丢数据');
    // 每个面板都补上了"单视图"标签
    for (const id of listPaneIds(tree)) {
        const leaf = findPane(tree, id);
        assert.deepEqual(leaf.tabs, [{ view: id }], `${id} 应补成单视图标签`);
        assert.equal(leaf.active, 0, `${id} 的活动标签应是 0`);
    }
    // 比例与顺序等其它字段一个字节都没变
    assert.deepEqual(tree.sizes, [17.35, 82.65]);
    assert.deepEqual(tree.children[1].sizes, [75.27, 24.73]);
    assert.equal(tree.children[1].children[1].id, PANE_DOC);
    assert.equal(formatTree(tree), '{row 17% / 83%}[ notes , {row 75% / 25%}[ {col 42% / 58%}[ links , ai ] , doc ] ]',
        '布局树文本与升级前解同一份档时逐字一致(标签不进读数)');
    // 读回来之后再写回去:写的是 v3(下一次启动就只剩 v3 这条路了)
    assert.equal(JSON.parse(encodeLayout(tree)).v, LAYOUT_VERSION);
});

test('v2 升级:四个面板(含 side)一个不少 —— 每个旧面板都有归宿', () => {
    const raw = JSON.parse(V2_FOUR_PANES_TEXT);
    const v2Ids = listPaneIds(raw.tree);
    assert.equal(v2Ids.length, 4, 'fixture 是四个面板的 v2 档');
    assert.deepEqual(v2Ids, [PANE_NOTES, PANE_DOC, DRAMA, PANE_SIDE]);
    const result = decodeLayoutResult(V2_FOUR_PANES_TEXT, WITH_DRAMA, PLACE);
    assert.equal(result.ok, true);
    const ids = listPaneIds(result.tree);
    assert.deepEqual(ids, [PANE_NOTES, PANE_DOC, DRAMA, PANE_LINKS, PANE_AI],
        '四个旧面板一个都没少(side 变两片)');
    assert.deepEqual(result.tree.sizes, [17, 44, 20, 19], '顶层比例没被动过');
    for (const id of ids) {
        assert.deepEqual(findPane(result.tree, id).tabs, [{ view: id }]);
        assert.equal(findPane(result.tree, id).active, 0);
    }
    // 同一份档走 store.load(真外壳那条路)结果相同
    return createLayoutStore({ storage: memory(V2_FOUR_PANES_TEXT), knownIds: WITH_DRAMA, adoption: PLACE })
        .load()
        .then(({ ok, tree }) => {
            assert.equal(ok, true);
            assert.deepEqual(listPaneIds(tree), ids);
        });
});

test('v2 升级 + 收编:老档里没有插件面板时,迁移与收编一起走,标签与排布都不丢', () => {
    // v2 老档只有外壳那三片(notes / side / doc),而这次 known 里多了 drama。
    // 两处迁移必须**都**排在"面板集合比对"之前:标签迁移让每个面板先有标签,
    // 收编再把 drama 插进来。任何一步插错位置,结果都是"整份布局被打回默认"。
    const v2 = JSON.stringify({
        v: 2,
        tree: {
            dir: 'row', sizes: [19, 62, 19],
            children: [
                { type: 'pane', id: PANE_NOTES },
                { type: 'pane', id: PANE_DOC },
                { type: 'pane', id: PANE_SIDE },
            ],
        },
    });
    const { ok, tree } = decodeLayoutResult(v2, WITH_DRAMA, PLACE);
    assert.equal(ok, true, '老档 + 新面板集合:必须仍然是"读得懂"');
    assert.deepEqual(listPaneIds(tree), [PANE_NOTES, PANE_DOC, DRAMA, PANE_LINKS, PANE_AI]);
    // 老面板补成单视图;新收编的插件面板也是单视图 —— 两边规矩一致
    for (const id of listPaneIds(tree)) {
        assert.deepEqual(findPane(tree, id).tabs, [{ view: id }], `${id} 的标签`);
        assert.equal(findPane(tree, id).active, 0);
    }
    // 用户原来的排布没被动过:notes 仍是 19%、右侧那一列仍是 19%,只有"正文那一格"
    // 按收编位置表(62/38)分给了新面板 —— 这正是 adoptPanes 一贯的行为,与从前一致
    assert.deepEqual(tree.sizes, [19, 38.44, 23.56, 19],
        '只有正文那 62% 被 62/38 分给新面板;另两片一格没动');
    assert.equal(tree.children[3].dir, 'col');
    assert.deepEqual(tree.children[3].sizes, DEFAULT_SIDE_SPLIT);
});

test('v2 升级:migrateV2Tabs 幂等、不认识 tabs 的节点不覆盖、新档一个字节都不动', () => {
    const migrated = migrateV2Tabs(JSON.parse(REAL_V2_TEXT).tree);
    assert.deepEqual(migrateV2Tabs(migrated), migrated, '迁移两次结果一样');
    assert.equal(migrateV2Tabs(migrated), migrated, '已经迁移过的树:同一个引用返回(不重写)');
    // 已经有标签的节点必须原样保留,绝不能被覆盖成单视图
    const tabbed = split('row', [50, 50], [
        pane(PANE_NOTES),
        pane(PANE_DOC, [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }], 1),
    ]);
    assert.equal(migrateV2Tabs(tabbed), tabbed, '一个节点都不用补 → 原样返回(新档一个字节都不动)');
    assert.deepEqual(findPane(migrateV2Tabs(tabbed), PANE_DOC).tabs,
        [{ view: 'doc', doc: '甲篇.md' }, { view: 'links' }]);
    // 脏输入不抛
    for (const bad of [null, undefined, 42, 'x', { dir: 'row', children: 'x' }]) {
        assert.doesNotThrow(() => migrateV2Tabs(bad));
    }
});

// ---------------------------------------------------------------------------
// ★ 标签存得住(本次改动的**第二半**,也是直击那个坑的回归)。
//
// `normalizeTree` 从前是 `pane(node.id)` —— 按 id 重建节点,多余字段全丢。
// 后果:存档里写得好好的 tabs/active 在**加载时**被整片剥掉,而树形、面板数量、
// 比例全都对得上 —— 迁移测试照样绿,数据已经没了。下面这几条就是钉住这件事:
// 带标签的树 encode → decode 之后,tabs/active 必须原样回来。
// ---------------------------------------------------------------------------

/**
 * 一棵带多标签的树:doc 那个面板里有**两篇不同文档**的标签。
 *
 * ⚠️ 这里刻意**不**放 `{view:'links'}` 之类的重复视图:v4 里"一枚实例只能在一格",
 * 而树里本来就有一格叫 `links` —— 那种档是"用户把 links 拖进了 doc 的标签条",
 * 属于**去重**那条路的判据(单独一条用例),不该混进"标签存得住"这条。
 */
const tabbedTree = () => split('row', [19, 62, 19], [
    pane(PANE_NOTES),
    pane(PANE_DOC, [
        { view: 'doc', doc: '甲篇.md' },
        { view: 'doc', doc: '乙篇.md' },
    ], 1),
    split('col', DEFAULT_SIDE_SPLIT, [pane(PANE_LINKS), pane(PANE_AI)]),
]);

test('★ 标签存得住:带标签的树 encode → decode 后 tabs/active 原样保留、顺序不变', () => {
    const tree = tabbedTree();
    const text = encodeLayout(tree);
    assert.match(text, /甲篇\.md/, '标签真的写进了存档文本(而不是被编码丢掉)');
    const { ok, tree: back } = decodeLayoutResult(text, DEFAULT_PANE_IDS);
    assert.equal(ok, true);
    const docPane = findPane(back, PANE_DOC);
    assert.deepEqual(docPane.tabs, [
        { view: 'doc', doc: '甲篇.md' },
        { view: 'doc', doc: '乙篇.md' },
    ], '⚠️ tabs 原样保留且顺序不变 —— 这条挂了就是"按 id 重建把字段剥掉"复发');
    assert.equal(docPane.active, 1, '活动标签的下标也要原样保留');
    // 同型不同文档实例 = 两个不同标签(身份是"视图 + 文档实例",不是"视图类型")
    assert.notDeepEqual(docPane.tabs[0], docPane.tabs[1]);
    // 其它面板照旧是单视图,没被带偏
    assert.deepEqual(findPane(back, PANE_NOTES).tabs, [{ view: PANE_NOTES }]);
    assert.deepEqual(findPane(back, PANE_LINKS).tabs, [{ view: PANE_LINKS }]);
    assert.deepEqual(findPane(back, PANE_AI).tabs, [{ view: PANE_AI }]);
    // 树形与比例不受影响
    assert.deepEqual(listPaneIds(back), DEFAULT_PANE_IDS);
    assert.deepEqual(back.sizes, tree.sizes);
    // v4:解一次之后就是不动点(标签结构不再被归一化改动)
    assert.deepEqual(back, tree);
});

test('v4:同一枚实例出现在两格时按"内容型格子优先"去重,不走"先到先得"', () => {
    // "把 links 拖进 doc 的标签条"落盘之后的样子:doc 槽位里有 links,而 links 那一格还在。
    // 去重必须把这一枚留给**内容型**的 doc(doc 槽位的 id 只是槽位键,标签才是它的内容),
    // 于是 links 那一格空掉、被收拢 —— 这正是"拖过去之后源槽位消失"的应有形状。
    const dup = split('row', [19, 62, 19], [
        pane(PANE_NOTES),
        pane(PANE_DOC, [{ view: PANE_DOC, doc: '甲篇.md' }, { view: PANE_LINKS }], 1),
        split('col', DEFAULT_SIDE_SPLIT, [pane(PANE_LINKS), pane(PANE_AI)]),
    ]);
    const { ok, tree } = decodeLayoutResult(encodeLayout(dup), DEFAULT_PANE_IDS);
    assert.equal(ok, true, '这是好档(用户动作的产物)');
    const keys = tabKeysOf(tree);
    assert.equal(new Set(keys).size, keys.length, `实例身份必须全局唯一:${keys}`);
    assert.equal(keys.filter((k) => k === PANE_LINKS).length, 1, 'links 只剩一枚实例');
    assert.deepEqual(findPane(tree, PANE_DOC).tabs,
        [{ view: PANE_DOC, doc: '甲篇.md' }, { view: PANE_LINKS }], '留在内容型的 doc 槽位里');
    assert.equal(listPaneIds(tree).includes(PANE_LINKS), false, '同名那一格空掉 → 收拢');
    assert.equal(tabKeysOf(tree).some((k) => k === PANE_DOC || k.startsWith(PANE_DOC + '\u0000')), true,
        'doc 视图还在(不能因为它那一格被收拢就丢)');
});

test('★ 空面板存得住:关掉最后一个标签之后,重启不会"复活"一个用户已经关掉的视图', () => {
    // ⚠️ 口径(v4 之后):存档文本里 `tabs: []` 仍然**原样写得进去**(`encodeLayout` 不过滤),
    //    但解码时它是一种"读得出、却没有内容"的槽位 —— 按规格 §5.5「绝不写出空槽位」,
    //    归一化会**收拢**它,而它腾出来的那个视图如果没有任何标签实例,会作为**独立一格**
    //    被补回来。这条用例钉的是那个要害:**不许**把空面板当成"没有 tabs 字段"而
    //    按 `pane.id` 给它补一枚 `{view:'doc'}` —— 那才是"用户关掉的视图复活"。
    const tree = split('row', [19, 62, 19], [
        pane(PANE_NOTES),
        pane(PANE_DOC, [], 0),                                  // ← 空面板(doc 的标签被关光了)
        split('col', DEFAULT_SIDE_SPLIT, [pane(PANE_LINKS), pane(PANE_AI)]),
    ]);
    const text = encodeLayout(tree);
    assert.match(text, /"tabs":\[\]/, '空面板原样写进存档(编码层不动它)');
    const { ok, tree: back } = decodeLayoutResult(text, DEFAULT_PANE_IDS);
    assert.equal(ok, true, '这份档读得懂:空面板不是坏档');
    // ① 空槽位被收拢,不许留在树里
    assert.equal(listPaneIds(back).every((id) => (findPane(back, id).tabs ?? []).length > 0), true,
        '树里不许有空槽位');
    // ② 那个视图由**独立一格单视图**补回,而不是继续顶着 doc 那个槽位名的空壳
    assert.equal(tabKeysOf(back).filter((k) => k === PANE_DOC).length, 1, 'doc 恰好一枚实例');
    assert.deepEqual([...new Set(tabKeysOf(back))].sort(), [...DEFAULT_PANE_IDS].sort(), '四个视图一个不少');
    assert.equal(new Set(tabKeysOf(back)).size, tabKeysOf(back).length, '实例身份全局唯一');
    // ③ 面板总数不变(收拢一格、补回一格)
    assert.equal(listPaneIds(back).length, DEFAULT_PANE_IDS.length);
    // ④ 再编再解是同一份文本(不动点:补过的那一格不会再变)
    assert.equal(encodeLayout(decodeLayout(encodeLayout(back), DEFAULT_PANE_IDS)), encodeLayout(back));
    // ⚠️ 对照:v2 老档那条路(节点**没有** tabs 字段)照旧补成单视图
    const v2 = JSON.stringify({
        v: LAYOUT_VERSION_PREV,
        tree: {
            dir: 'row', sizes: [19, 62, 19],
            children: [
                { type: 'pane', id: PANE_NOTES }, { type: 'pane', id: PANE_DOC },
                { type: 'pane', id: PANE_LINKS }, { type: 'pane', id: PANE_AI },
            ],
        },
    });
    const old = decodeLayoutResult(v2, DEFAULT_PANE_IDS);
    assert.equal(old.ok, true);
    for (const id of DEFAULT_PANE_IDS) {
        assert.deepEqual(findPane(old.tree, id).tabs, [{ view: id }], `${id} 应补成单视图`);
    }
});

test('★ 标签存得住:走 store.save / store.load(真外壳那条路)也不丢', async () => {
    const storage = memory(undefined);
    const store = createLayoutStore({ storage, knownIds: DEFAULT_PANE_IDS });
    assert.equal(await store.save(tabbedTree()), true);
    const { ok, tree } = await store.load();
    assert.equal(ok, true);
    assert.deepEqual(findPane(tree, PANE_DOC).tabs,
        [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }]);
    assert.equal(findPane(tree, PANE_DOC).active, 1);
});

test('★ 标签存得住:拖动(摘走/换位/落点)不会把标签结构抹掉', () => {
    // 这三条是树上"重建叶子"的路径 —— `pane(node.id)` 那类写法一旦混进来,拖一下就丢标签
    const tree = tabbedTree();
    for (const next of [
        dropOnEdge(tree, PANE_NOTES, PANE_AI, 'bottom'),
        dockBottom(tree, PANE_AI),
    ]) {
        assert.deepEqual(findPane(next, PANE_DOC).tabs, findPane(tree, PANE_DOC).tabs,
            '拖动之后 doc 面板的标签还在');
        assert.equal(findPane(next, PANE_DOC).active, 1);
        // 拖完再存再读,标签也还在(拖动路径与存档路径要一致)
        assert.deepEqual(findPane(decodeLayout(encodeLayout(next), DEFAULT_PANE_IDS), PANE_DOC).tabs,
            findPane(tree, PANE_DOC).tabs);
    }
});

test('往返相等:encode → decode → encode,两次文本逐字相同(解一次之后是不动点)', () => {
    const cases = [
        ['默认树', defaultTree()],
        ['整宽底栏', dockBottom(defaultTree(), PANE_AI)],
        ['标签树', tabbedTree()],
    ];
    for (const [name, tree] of cases) {
        const once = encodeLayout(tree);
        const twice = encodeLayout(decodeLayout(once, DEFAULT_PANE_IDS));
        const thrice = encodeLayout(decodeLayout(twice, DEFAULT_PANE_IDS));
        assert.equal(twice, once, `${name}:已经是 v3 契约的树,编解码一轮后文本逐字相同`);
        assert.equal(thrice, twice, `${name}:再解再编仍是同一份文本`);
    }
    // 没有标签的裸树(理论上只有手写 JSON 才会出现):第一轮会补上单视图标签,
    // 从第二轮起稳定 —— 这正是"补默认标签"该有的样子,不是每次读都变一次。
    const raw = JSON.stringify({ v: LAYOUT_VERSION, tree: split('row', [50, 50], [{ type: 'pane', id: PANE_NOTES }, { type: 'pane', id: PANE_DOC }]) });
    const first = encodeLayout(decodeLayout(raw, [PANE_NOTES, PANE_DOC]));
    const second = encodeLayout(decodeLayout(first, [PANE_NOTES, PANE_DOC]));
    assert.equal(second, first, '补过一次之后就稳定了');
    assert.deepEqual(findPane(JSON.parse(first).tree, PANE_DOC).tabs, [{ view: PANE_DOC }]);
});

// ---------------------------------------------------------------------------
// 新增面板的收编(adoptPanes)。
//
// 这一组守的是**最容易悄悄发生的那种数据损失**:插件带来一片新面板时,存档里当然
// 没有它,原来的"面板集合必须恰好一致"就会把整棵树判成坏档 → 用户拖了半天的布局
// 被打回默认,而且一句报错都没有(ok 还会是 false,外壳只当"没存过")。
// ---------------------------------------------------------------------------

test('收编:缺一片新面板时,保住用户已有的排布,只把它补进去', () => {
    // 用户把右侧拖成上下分(非默认),再让它读"认得 drama"的新集合
    const user = split('row', [19, 62, 19], [
        pane(PANE_NOTES),
        pane(PANE_DOC),
        split('col', [42, 58], [pane(PANE_LINKS), pane(PANE_AI)]),
    ]);
    const next = adoptPanes(user, WITH_DRAMA, PLACE);
    assert.equal(listPaneIds(next).length, WITH_DRAMA.length, '五片都在');
    for (const id of WITH_DRAMA) assert.equal(listPaneIds(next).includes(id), true, `有 ${id}`);
    // ⚠️ 关键断言:用户那棵树**没被打回默认** —— notes/doc 仍是顶行,右侧仍是上下分
    assert.deepEqual(listPaneIds(next), [PANE_NOTES, PANE_DOC, DRAMA, PANE_LINKS, PANE_AI]);
    assert.equal(next.dir, 'row', '顶层仍是那一行');
    const right = next.children[next.children.length - 1];
    assert.equal(right.dir, 'col', '右侧仍然上下分(没被拉平成一排)');
    assert.deepEqual(listPaneIds(right), [PANE_LINKS, PANE_AI]);
    // 每一项比例都是正数、总和 100
    assert.equal(Math.round(next.sizes.reduce((a, b) => a + b, 0)), 100);
    for (const s of next.sizes) assert.equal(s > 0, true, `比例必须为正:${s}`);
});

test('收编:集合一致时一个字节都不动(新档不受影响)', () => {
    const t = defaultTree();
    assert.equal(adoptPanes(t, DEFAULT_PANE_IDS, DEFAULT_ADOPTION), t, '同一引用原样返回');
});

test('收编:有外来 id 时不越权(交给上层判坏档)', () => {
    const withForeign = split('row', [50, 50], [pane(PANE_NOTES), pane('外人')]);
    assert.equal(adoptPanes(withForeign, WITH_DRAMA, PLACE), withForeign, '原样返回');
});

test('收编:anchor 找不到(或就在根上)时挂到最外层那一行的末尾,不丢面板', () => {
    const user = split('row', [19, 62, 19], [pane(PANE_NOTES), pane(PANE_DOC), pane(PANE_LINKS), pane(PANE_AI)]);
    // 位置表指向一个根本不存在的 anchor → 兜底:追加到最外层那一行的末尾
    const next = adoptPanes(user, WITH_DRAMA, { [DRAMA]: { anchor: '不存在', dir: 'row', sizes: [50, 50] } });
    assert.deepEqual(listPaneIds(next), [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI, DRAMA]);
    assert.equal(next.children.length, 5);
    assert.equal(next.children[next.children.length - 1].id, DRAMA, '落在最后那一个槽位');
});

test('收编:表里没写位置的新 id 也能进来(走兜底)', () => {
    const user = defaultTree();
    const next = adoptPanes(user, WITH_DRAMA, {});
    assert.deepEqual(listPaneIds(next), WITH_DRAMA);
});

test('收编:脏档不抛,原样返回', () => {
    assert.equal(adoptPanes(null, WITH_DRAMA, PLACE), null);
    assert.equal(adoptPanes('nope', WITH_DRAMA, PLACE), 'nope');
    assert.equal(adoptPanes({ dir: 'row', children: 'x' }, WITH_DRAMA, PLACE).dir, 'row');
});

test('收编:decodeLayoutResult 走这条路 —— 老档 + 新面板集合 = ok 且保住布局', () => {
    const user = split('row', [19, 62, 19], [
        pane(PANE_NOTES), pane(PANE_DOC), split('col', [42, 58], [pane(PANE_LINKS), pane(PANE_AI)]),
    ]);
    const raw = encodeLayout(user);

    // 老调用方(只认四片):照旧 ok,四片
    const before = decodeLayoutResult(raw, DEFAULT_PANE_IDS);
    assert.equal(before.ok, true);
    assert.deepEqual(listPaneIds(before.tree), DEFAULT_PANE_IDS);

    // 新调用方(多认一片):仍然 ok=true —— 这是本条的要害,不能退回 ok=false
    const after = decodeLayoutResult(raw, WITH_DRAMA, PLACE);
    assert.equal(after.ok, true, '不能因为多一片就把用户的档判成"没存过"');
    assert.deepEqual(listPaneIds(after.tree), [PANE_NOTES, PANE_DOC, DRAMA, PANE_LINKS, PANE_AI]);
    const right = after.tree.children[after.tree.children.length - 1];
    assert.equal(right.dir, 'col', '用户原来"右侧上下分"的排布被保住');
});

test('收编:store.load 也走这条路(真外壳读存档那条路)', async () => {
    const user = dockBottom(defaultTree(), PANE_AI);          // 一个"非默认"的排布
    const store = createLayoutStore({
        storage: memory(encodeLayout(user)), knownIds: WITH_DRAMA, adoption: PLACE,
    });
    const { ok, tree } = await store.load();
    assert.equal(ok, true);
    assert.equal(listPaneIds(tree).length, WITH_DRAMA.length, '五片都在');
    assert.equal(listPaneIds(tree).includes(DRAMA), true, '新面板进来了');
    // 原树是 {col:[顶行, ai]};收编后 ai 落在底栏那一半里,顶行仍是顶行
    assert.equal(tree.dir, 'col', '用户"把 AI 拖成整宽底栏"这件事被保住');
    assert.equal(listPaneIds(tree.children[1]).includes(PANE_AI), true, 'AI 仍在底栏那一半');
});

// ===========================================================================
// 契约 v4:槽位里前后叠放的面板(槽位 id ≠ 视图名)
// ===========================================================================
//
// 规格里最要命的一条: **叶子数量不再等于视图数量**。
// 从前 `paneSetMatches()` 要求"叶子 id 与 knownIds 一一对应" —— 两枚标签并进一个槽位后
// 叶子天然少一个,重启时它会被当成坏档,把用户刚拖好的布局静默打回默认。
// 下面这一组钉的就是"合并过的布局必须存得住、读得回"。

/** v3 形状(叶子 id 还等于视图名)的一份真实档 —— 它必须被 v4 原样读懂。 */
const V3_MERGED_TEXT = JSON.stringify({
    v: 3,
    tree: {
        dir: 'row', sizes: [23, 51, 26],
        children: [
            { type: 'pane', id: PANE_NOTES, tabs: [{ view: PANE_NOTES }], active: 0 },
            { type: 'pane', id: PANE_DOC, tabs: [{ view: PANE_DOC, doc: '甲篇.md' }], active: 0 },
            {
                dir: 'col', sizes: [55, 45],
                children: [
                    { type: 'pane', id: PANE_LINKS, tabs: [{ view: PANE_LINKS }], active: 0 },
                    { type: 'pane', id: PANE_AI, tabs: [{ view: PANE_AI }, { view: PANE_DOC, doc: '乙篇.md' }], active: 1 },
                ],
            },
        ],
    },
});

test('v4:v3 布局保留原比例与标签顺序,下次保存写成 v4', () => {
    const r = decodeLayoutResult(V3_MERGED_TEXT, DEFAULT_PANE_IDS);
    assert.equal(r.ok, true, 'v3 是读得懂的旧档(v4 只是重新解释 tabs)');
    // 比例与形状原样
    assert.deepEqual(r.tree.sizes, [23, 51, 26]);
    assert.deepEqual(r.tree.children[2].sizes, [55, 45]);
    // 标签顺序与 active 原样
    const ai = findPane(r.tree, PANE_AI);
    assert.deepEqual(ai.tabs, [{ view: PANE_AI }, { view: PANE_DOC, doc: '乙篇.md' }]);
    assert.equal(ai.active, 1, '当前前景标签仍是那一篇文档');
    // 再编码一次 → v4(下次成功保存时的形状)
    const text = encodeLayout(r.tree);
    assert.equal(JSON.parse(text).v, 4);
    // 而且 v4 文本再读一次还是同一棵树(不动点)
    assert.deepEqual(decodeLayout(text, DEFAULT_PANE_IDS), r.tree);
});

test('★ v4:叶子数少于视图数(标签合并过)仍然成功解码,绝不退回默认布局', () => {
    // 一个槽位里同时装着 notes / doc / links / ai 四枚 —— 树只剩这一个叶子。
    // v3 的 paneSetMatches 会把这种档判成"面板对不上"→ 整棵打回默认。
    const merged = pane('slot:1', [
        { view: PANE_NOTES }, { view: PANE_DOC, doc: '甲篇.md' },
        { view: PANE_LINKS }, { view: PANE_AI },
    ], 3);
    const r = decodeLayoutResult(encodeLayout(merged), DEFAULT_PANE_IDS);
    assert.equal(r.ok, true, '合并过的布局是**好档**,不是坏档');
    assert.deepEqual(listPaneIds(r.tree), ['slot:1'], '不退回默认:就这一个槽位');
    assert.deepEqual(findPane(r.tree, 'slot:1').tabs.map((t) => t.view),
        [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI], '四枚标签、顺序不乱');
    assert.equal(findPane(r.tree, 'slot:1').active, 3, '当前前景标签保留');

    // 换个"槽位 id 与视图名完全无关"的合并(插件卸掉之后视图会被过滤掉),同样不退回默认
    const two = split('row', [61, 39], [
        pane('slot:4', [{ view: PANE_NOTES }, { view: PANE_LINKS }], 1),
        pane('slot:5', [{ view: PANE_DOC, doc: '甲篇.md' }, { view: PANE_AI }], 1),
    ]);
    const r2 = decodeLayoutResult(encodeLayout(two), DEFAULT_PANE_IDS);
    assert.equal(r2.ok, true);
    assert.deepEqual(listPaneIds(r2.tree), ['slot:4', 'slot:5']);
});

test('★ v4:重启往返 —— 中央合并与边缘拆分之后的树逐字段保持一致', async () => {
    // ① 中央合并:把 links 那一枚并进 notes(源槽位空 → 消失,空间给邻居)
    const merged = moveTabToPane(defaultTree(), PANE_LINKS, 0, PANE_NOTES, null, { space: 'neighbor' });
    assert.deepEqual(findPane(merged, PANE_NOTES).tabs.map((t) => t.view), [PANE_NOTES, PANE_LINKS]);
    // ② 边缘拆分:再把 links 从 notes 里拖到 **ai** 的右边(新槽位 + 源栈保留未拖的那枚)
    const splitOff = moveTabToEdge(merged, PANE_NOTES, 1, PANE_AI, 'right');
    assert.ok(splitOff, '合法的边缘停靠');
    const freshId = listPaneIds(splitOff).find((i) => i.startsWith('slot:'));
    assert.match(freshId, /^slot:\d+$/, `新槽位 id 是槽位序号:${freshId}`);
    assert.equal(findPane(splitOff, PANE_NOTES).tabs.length, 1, '未拖的那枚留在原栈');
    assert.deepEqual(findPane(splitOff, freshId).tabs, [{ view: PANE_LINKS }], '新槽位只装被拖的那一枚');

    // ③ 存 → 读(模拟重启)→ 再存,三次逐字段一致
    const text1 = encodeLayout(splitOff);
    const back = decodeLayout(text1, DEFAULT_PANE_IDS);
    assert.deepEqual(back, splitOff, '重启后树逐字段一致(形状 / 比例 / 槽位 id / 标签顺序 / 当前前景)');
    assert.deepEqual(encodeLayout(back), text1, '再存一次文本逐字相同(解一次之后是不动点)');
    // ④ 真的"重启"两次:load 走 store 那条路也一样(外壳用的就是它)
    const store = createLayoutStore({ storage: memory(text1), knownIds: DEFAULT_PANE_IDS });
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.tree, splitOff, 'store.load 读回来仍是同一棵树');
});

test('v4:重复槽位 id / 重复 tabKey / 未知标签视图 —— 安全规范化,不让应用崩溃', () => {
    // ① 重复槽位 id:后来的那一格丢掉,但视图一个都不能丢(丢视图 = 面板整片消失)
    const dupId = split('row', [50, 50], [
        pane('slot:1', [{ view: PANE_NOTES }], 0),
        pane('slot:1', [{ view: PANE_DOC, doc: '甲篇.md' }], 0),
    ]);
    const r1 = decodeLayoutResult(encodeLayout(dupId), DEFAULT_PANE_IDS);
    assert.equal(r1.ok, true);
    const ids1 = listPaneIds(r1.tree);
    assert.equal(new Set(ids1).size, ids1.length, `槽位 id 不许重复:${ids1}`);
    assert.deepEqual([...tabKeysOf(r1.tree)].sort(), ['doc\u0000甲篇.md', 'notes', 'links', 'ai'].sort(),
        '重复 id 丢掉之后,缺的视图被收编回来(视图一个都不少)');

    // ② 全树重复的 tabKey:同一个面板实例只能存在一次(同一个实例在两格里是坏档)
    const dupTab = split('row', [50, 50], [
        pane('slot:1', [{ view: PANE_LINKS }], 0),
        pane('slot:2', [{ view: PANE_LINKS }], 0),
    ]);
    const r2 = decodeLayoutResult(encodeLayout(dupTab), DEFAULT_PANE_IDS);
    assert.equal(r2.ok, true);
    const keys2 = tabKeysOf(r2.tree);
    assert.equal(new Set(keys2).size, keys2.length, `tabKey 必须全局唯一:${keys2}`);
    assert.equal(keys2.filter((k) => k === 'links').length, 1, 'links 只剩一个实例');

    // ③ 未知标签视图:按"未知视图不可渲染"过滤;过滤后空掉的槽位收拢,绝不写出空槽位
    const ghost = split('row', [41, 59], [
        pane('slot:1', [{ view: 'ghost' }], 0),                 // 这一格过滤后整个空掉 → 收拢
        pane('slot:2', [
            { view: PANE_NOTES }, { view: 'ghost' },
            { view: PANE_DOC }, { view: PANE_LINKS }, { view: PANE_AI },
        ], 0),
    ]);
    const r3 = decodeLayoutResult(encodeLayout(ghost), DEFAULT_PANE_IDS);
    assert.equal(r3.ok, true);
    assert.deepEqual(listPaneIds(r3.tree), ['slot:2'], '空槽位被收拢,不留空面板');
    assert.deepEqual(findPane(r3.tree, 'slot:2').tabs.map((t) => t.view),
        [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI], '幽灵视图被过滤,其余顺序不乱、一个不少');

    // ④ 脏输入一律不抛
    for (const bad of [null, 'nope', { v: 4, tree: { dir: 'row', children: 'x' } }, { v: 4, tree: null }]) {
        assert.ok(decodeLayoutResult(bad, DEFAULT_PANE_IDS).tree);
    }
});

test('v4:归一化不再按 pane.id 自动补回单视图(合并过的布局重启不许复活面板)', () => {
    // 这一格叫 doc,里面装的是 links —— 槽位 id 与视图名无关,是**合法**的 v4 形状
    const t = split('row', [50, 50], [
        pane(PANE_DOC, [{ view: PANE_LINKS }], 0),
        pane('slot:9', [{ view: PANE_NOTES }, { view: PANE_AI }], 0),
    ]);
    // doc 这个视图在树里没有自己的标签实例 → 必须**补一格**回来,
    // 而不是把那个叫 doc 的槽位(它装的是 links)改成 doc 视图。
    const out = normalizeTree(t, DEFAULT_PANE_IDS);
    assert.deepEqual(findPane(out, PANE_DOC).tabs, [{ view: PANE_LINKS }],
        '⚠️ 不许因为槽位 id 是 doc 就把它的标签改成 doc(那正是"按 id 补回单视图"的复发)');
    assert.deepEqual([...new Set(tabKeysOf(out))].sort(), [PANE_NOTES, PANE_DOC, PANE_LINKS, PANE_AI].sort(),
        '四个视图一个不少');
    assert.equal(new Set(tabKeysOf(out)).size, tabKeysOf(out).length, '实例身份全局唯一');

    // 反过来:一个**没有 tabs 字段**的节点是 v2 那种旧节点 —— 它的语义就是"这一格是这个视图",
    // 所以照旧补成单视图(那条路只有 v2 迁移走得到)
    const legacy = normalizeTree({ type: 'pane', id: PANE_DOC }, [PANE_DOC]);
    assert.equal(tabKeysOf(legacy).some((k) => k === PANE_DOC || k.startsWith(PANE_DOC + '\u0000')), true,
        'v2 那种裸节点仍按单视图处理');
    assert.equal(listPaneIds(legacy).length, 1, '就这一格');
});

