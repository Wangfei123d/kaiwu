// 布局存档(契约 **v4**)。
//
// 只做两件事:把「树 + 版本号」编成一段文本;把任何东西解回一棵**合法**的树。
//
// 为什么这么小心:布局是**偏好**,不是数据。坏档唯一的代价只能是
// "回到默认布局",绝不能是"界面起不来"或"某个面板整片消失"。所以:
// 空串 / 坏 JSON / 未知版本 / 形状不对 / 面板对不上 —— **一律退回默认树,绝不抛**。
//
// ⚠️ 唯一的例外是**读得懂的旧档**,有两类:
//   · 旧面板 id(`side` 拆成 links + ai,见 migrateLegacyTree);
//   · 旧契约版本(v2 没有标签结构,见 migrateV2Tabs;v3 有 tabs 但叶子 id 还等于视图名)。
// 它们不是坏档,是能读懂的旧档 —— 必须保住用户原本的排布,不许退回默认。
//
// v2 与 v1(没有 v1 发布过,这里只是把契约钉死)的区别:v1 只存两个像素宽度,
// v2 存**整棵树 + 每层比例** —— 像素宽度的表达力不够。
//
// v3 与 v2 的区别:v2 的面板**只有一个视图**,面板 id 就是那个视图;v3 的每个面板带
// `tabs`(标签列表,顺序即显示顺序)+ `active`(活动标签),标签的身份是"视图 + 文档实例"。
//
// v4 与 v3 的区别(**本次交接的核心**):
//   · `pane.id` 从"面板 / 视图的身份"变成**槽位 id** —— 新拆出的槽位叫 `slot:<序号>`,
//     与它里面装哪个视图毫无关系;
//   · 于是"叶子 id 与 knownIds 一一对应"这条判据**作废**(`paneSetMatches`)。
//     把一枚标签拖进别格之后,叶子天然少一个 —— 那是正常布局,不是坏档。
//     新判据问的是**标签**:槽位 id 全局唯一、每条标签的 view 已注册、
//     每个必需视图至少一枚实例、全部实例按 tabKey 全局唯一(见 panel-tree 的 validateLayout);
//   · 归一化时**不得**按 `pane.id` 补回 `{view: pane.id}`(那会让合并过的布局重启后
//     凭空复活面板)。只有 v2 迁移那条路才补单视图标签。
// v3 的 JSON 形状与 v4 完全相同,不需要破坏性转换:它只是被**重新解释**为
// "槽位里前后叠放的面板",下次成功保存时自然写成 v4。
import {
    defaultTree, migrateLegacyTree, migrateV2Tabs, adoptPanes, normalizeTree, isPane, isSplit,
    validateLayout, DEFAULT_PANE_IDS, DEFAULT_ADOPTION,
} from './panel-tree.js';

export const LAYOUT_VERSION = 4;

/**
 * 上一个契约版本。它只用来认"老档":解到 v2 就先迁移成"每个面板都有标签"的形状,
 * 再照当前规则走下去。单独一个常量(而不是在比较里写裸 2)是因为**升级路径要有名字**
 * —— 下次再升版本时,这里就是"还认得哪些老版本"的唯一一处清单。
 *
 * ⚠️ v3 不需要单独的常量:它的**形状**与 v4 一模一样(同样有 tabs/active),
 * 区别只在"槽位 id 等于视图名"这条**解释**上 —— 而 v4 的解码路径本来就接受这种树
 * (槽位 id 是什么都行,只要求唯一)。所以 v3 直接走当前版本那条路。
 */
export const LAYOUT_VERSION_PREV = 2;

/** 设置通道里的命名空间与键 —— 带命名空间,不裸用一个全局键。 */
export const LAYOUT_NAMESPACE = '__global';
export const LAYOUT_KEY = 'ui.panelLayout';

/** 树 → 存档文本。编码失败(循环引用之类)返回 null,由调用方决定怎么办。 */
export function encodeLayout(tree) {
    try {
        return JSON.stringify({ v: LAYOUT_VERSION, tree });
    } catch {
        return null;
    }
}

/**
 * 存档 → { ok, tree }。ok 表示"这是一个能读懂的档"(当前契约 v4,或能迁移上来的 v2/v3);
 * 无论 ok 与否,tree 都是**可直接渲染**的合法树。
 *
 * 需要 ok 的唯一原因:外壳想把"从来没存过"的情形渲染成与改动前逐像素一致的
 * 默认布局(用旧的 ui.navWidth / ui.sideWidth 当权重),而"存档坏了"则老老实实
 * 退回默认树。两者都给默认树就把这个区别丢了。
 *
 * ⚠️ 旧档迁移出来的树也算 ok=true —— 它**读懂了**,外壳该照着它渲染。
 * "版本号不认识"(例如将来才写的 v5)照旧算坏档 —— 这条不许放宽。
 */
export function decodeLayoutResult(raw, knownIds = DEFAULT_PANE_IDS, adoption = DEFAULT_ADOPTION, requiredIds = knownIds) {
    const known = Array.isArray(knownIds) ? knownIds.filter((id) => typeof id === 'string' && id) : [];
    const required = (Array.isArray(requiredIds) ? requiredIds : known).filter((id) => known.includes(id));
    // 退回默认树。⚠️ 这里**也必须过 adoptPanes**:`defaultTree()` 只有外壳自带的那四片,
    // 而"从没存过布局"(ok=false)是最常见的情形 —— 插件带来的第五片若只在这里被漏掉,
    // 用户会看到"插件明明激活了、面板却不存在",而且存档一旦写下就再也不会补进来。
    // ok 仍然报 false(它回答的是"读没读到一个能用的档"),与树里有没有插件面板无关。
    const fallback = () => ({ ok: false, tree: adoptPanes(defaultTree(), required, adoption) });
    try {
        let value = raw;
        if (typeof raw === 'string') {
            if (raw.trim() === '') return fallback();
            value = JSON.parse(raw);
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback();
        // ⚠️ 认哪些版本是**升版时唯一的判断题**:只认 2(上一个需要迁移的契约)与当前 4。
        // v3 与 v4 同形,理所当然算当前版本(见上面 LAYOUT_VERSION_PREV 的注释)。
        // 未知版本(含没有版本号的裸树、将来的 v5)一律退回默认树 —— 这条不许放宽:
        // 拿旧代码去读新档,唯一安全的做法就是承认"我看不懂"。
        if (value.v !== LAYOUT_VERSION_PREV && value.v !== 3 && value.v !== LAYOUT_VERSION) return fallback();
        const saved = value.tree;
        if (!isPane(saved) && !isSplit(saved)) return fallback();   // 形状就不对
        // ⚠️ 三处迁移/收编都必须排在"校验"**之前**,标签迁移排在最前:
        // 它把 v2 的"一个面板一个视图"翻译成当前的 tabs/active;后面几处(以及它们的
        // 深拷贝)都要重建节点,先让每个面板都有标签,它们才有东西可保。
        // 排在这里的另一半理由:兜底分支是给"形状不对 / 读不懂"的档用的,
        // 一份 v2/v3 老档属于"读得懂",不该和坏档走同一条路(否则用户没动过设置,
        // 排布却被打回默认,而且 ok 还是 false,外壳只当"没存过")。
        const tabbed = value.v === LAYOUT_VERSION_PREV ? migrateV2Tabs(saved) : saved;
        // ⚠️ 旧面板 id 迁移必须在"校验"之**前**做:旧档里是合并的 `side`,
        // 直接校验会判成"这些视图没有标签实例"→ 整棵树被丢掉 → 用户明明没动过设置,
        // 排布却被打回默认。迁移只把 `side` 就地拆成 links + ai,其它规则一概不变。
        const migrated = migrateLegacyTree(tabbed, { knownIds: known });
        // ⚠️ 收编新面板也必须在校验**之前**:插件带来一片新面板时,存档里当然没有它,
        // 直接校验会判成"缺视图"→ 用户拖了半天的布局被静默打回默认。
        // adoptPanes 把它就地插进存档树(集合一致时它一个字节都不动)。
        const adopted = adoptPanes(migrated, required, adoption);
        // ⚠️ v4 的验收判据(v3 的 `paneSetMatches` 已作废,见文件头):
        // 问标签而不是问叶子数 —— 合并过的布局叶子天然更少,那是好档。
        const normalized = normalizeTree(adopted, known, required);
        if (!validateLayout(normalized, known, required).ok) return fallback();
        return { ok: true, tree: normalized };
    } catch {
        return fallback();
    }
}

/** 存档 → 树。**绝不抛**,读不懂一律退回默认树。 */
export function decodeLayout(raw, knownIds = DEFAULT_PANE_IDS, adoption = DEFAULT_ADOPTION, requiredIds = knownIds) {
    return decodeLayoutResult(raw, knownIds, adoption, requiredIds).tree;
}

/**
 * 存档读写。storage 由调用方注入(真外壳走设置通道,单测给内存实现),
 * 于是这个模块既没有 DOM 也没有 IPC 依赖,可以被 node --test 直接跑。
 *
 * @param {object} p
 * @param {{read:()=>any, write:(text:string)=>any}} p.storage read/write 都可以是异步的
 * @param {string[]} p.knownIds
 * @param {string} p.key 存档键(默认 LAYOUT_KEY,只为单测能换)
 */
export function createLayoutStore({
    storage, knownIds = DEFAULT_PANE_IDS, requiredIds = knownIds, adoption = DEFAULT_ADOPTION, key = LAYOUT_KEY, log = console,
} = {}) {
    const read = async () => {
        if (!storage || typeof storage.read !== 'function') return undefined;
        return await storage.read();
    };
    const write = async (text) => {
        if (!storage || typeof storage.write !== 'function') return false;
        await storage.write(text);
        return true;
    };

    return {
        key,
        /** → { ok, tree }。读失败(通道坏了)也返回默认树,只是 ok=false。 */
        async load() {
            try {
                return decodeLayoutResult(await read(), knownIds, adoption, requiredIds);
            } catch (err) {
                log?.warn?.('[layout] 读布局存档失败,退回默认布局', err);
                return { ok: false, tree: defaultTree() };
            }
        },
        /** 存一棵树。会先归一化 —— 绝不把一棵坏树写进档里。 */
        async save(tree) {
            const text = encodeLayout(normalizeTree(tree, knownIds, requiredIds));
            if (text === null) return false;
            try {
                return await write(text);
            } catch (err) {
                log?.warn?.('[layout] 写布局存档失败(下次启动会回到默认布局)', err);
                return false;
            }
        },
        /** 清掉存档(退回默认树)。写失败也不抛。 */
        async clear() {
            try {
                return await write('');
            } catch (err) {
                log?.warn?.('[layout] 清布局存档失败', err);
                return false;
            }
        },
    };
}
