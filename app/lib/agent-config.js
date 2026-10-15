// 「模型 / 思考强度」这两个配置项的**解析与短名**。纯逻辑,不碰 IPC、不碰 DOM。
//
// 为什么单独一层:对端给的 configOptions 是任意结构(模型那条还是**按 provider 分组**的),
// 而界面要的是三样很具体的东西:
//   · 滑块有几档、当前在第几档;
//   · 每一档显示什么(紧凑态只放得下一个字);
//   · 模型清单按谁分组、每条写什么。
// 这些判据全在这里,单测直接钉;面板那边只负责画。
//
// ⚠️ 两条不许破的纪律:
//   ① `value` 一律**不透明** —— 我们不解析、不拼装、不假设它是 `provider/model`;
//      (对端现在用的确实是 `["provider","model"]` 的 JSON 串,那是它的事。)
//   ② 对端的 `name` / `description` **原样保留**(不翻译)。界面上出现的对端文案
//      就是它给的那一份,中文那一列是**我们自己的短名**,两者不混。

export const MODEL_CONFIG_ID = 'model';
export const REASONING_CONFIG_ID = 'reasoning_effort';

/**
 * kaiwu 想要的**默认**思考强度:梯子上「中」那一档。
 *
 * 为什么要有 kaiwu 自己的默认,而不是"对端给什么就是什么":对端的默认值来自**它自己的
 * 配置**(装的哪条 provider、DSH 那边怎么配的),本机实测是 `high`,但那是巧合不是约定 ——
 * 换台机器、换条 provider 就可能变成 `off` 或 `max`。用户拍板的是"默认中",那这件事就得由
 * kaiwu 说了算(见 electron/agent/agent-runtime.js 的 pinEffort)。
 *
 * 判据用**短名**而不是写死 `high`:短名词典把 `medium` 与 `high` 都算「中」(见 EFFORT_SHORT),
 * 而对端的档位 id 是它自己的事 —— 拿 `'中'` 当判据,对端换 id 也认得出中间那一档。
 */
export const PREFERRED_EFFORT_SHORT = '中';

/**
 * 当前生效的思考强度值。
 *
 * ⚠️ 三种"没有"要分开:
 *   · 对端**没给这一项** → `null`;
 *   · 给了但 `currentValue` 不是字符串 → `null`(脏数据,当没有);
 *   · `currentValue` 是**空串** → 原样返回 `''` —— 那是 ACP 的 "Provider default" 那一档,
 *     是个合法值,不能和"没有"混为一谈。
 */
export function effortValueOf(configOptions) {
    const option = configOptionOf(configOptions, REASONING_CONFIG_ID);
    if (option === null) return null;
    return typeof option.currentValue === 'string' ? option.currentValue : null;
}

/**
 * 思考强度的中文短名。
 *
 * ⚠️ 为什么 `high` 是「中」而不是「高」:deepseek 这条梯子是
 *    `off / low / high / max`,而 `high` 的自述是 "The default balance for most tasks"
 *    (默认平衡档)—— 它在这条梯子上是**中间那一档**,`max` 才是"最难、质量优先"。
 *    按字面把 high 写成「高」,四点滑块上就会出现两个"高",用户看不出区别。
 *    (这条映射是用户看过预览后拍板的:关 / 低 / 中 / 高。)
 */
const EFFORT_SHORT = Object.freeze({
    off: '关',
    none: '关',
    low: '低',
    medium: '中',
    high: '中',
    max: '高',
    xhigh: '高',
});

/** 短名的**全称**(浮层标题与 aria 用):比短名多一个字,说清"最高/关闭"。 */
const EFFORT_FULL = Object.freeze({
    off: '关闭',
    none: '关闭',
    low: '低',
    medium: '中',
    high: '中',
    max: '最高',
    xhigh: '最高',
});

/**
 * 一个档位的短名:先查词典(按 value),再退到对端 name 的首字符,最后退到 value 的前两个字。
 *
 * 为什么要三层兜底:对端随时可能加新档位(`value:"ultra"` 之类)——
 * 那种时候**不能崩、也不能空着**,显示一个"不太好看但认得出"的字就够,
 * 完整名字永远在浮层里与悬停里。
 *
 * @param {string} value 对端给的不透明档位值
 * @param {string} [name] 对端给的档位名(英文,如 "High")
 */
export function shortEffortName(value, name = '') {
    const key = String(value ?? '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EFFORT_SHORT, key)) return EFFORT_SHORT[key];
    // ⚠️ value 是空串是合法的:ACP 用 "" 表示 "Provider default"(见 effortLevels 的说明)
    if (key === '') return '默';
    const label = String(name ?? '').trim();
    if (label !== '') return [...label][0];
    return [...key].slice(0, 2).join('');
}

/** 一个档位的全称(短名不够用时用)。 */
export function fullEffortName(value, name = '') {
    const key = String(value ?? '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EFFORT_FULL, key)) return EFFORT_FULL[key];
    if (key === '') return '默认';
    const label = String(name ?? '').trim();
    return label !== '' ? label : String(value ?? '');
}

/** 按 id 取一条配置项;没有返回 null(界面据此"这一条对端没给,不画")。 */
export function configOptionOf(configOptions, id) {
    const list = Array.isArray(configOptions) ? configOptions : [];
    return list.find((o) => o !== null && typeof o === 'object' && o.id === id) ?? null;
}

/**
 * 把一条配置项的选项**摊平**。
 *
 * ACP 里 options 有两种形状:平的 `[{value,name}]`,或分组的
 * `[{group,name,options:[…]}]`(模型那条就是分组的)。界面两处都要:
 * 分组那份画清单,平的那份找"当前这一项叫什么"。
 *
 * ⚠️ 空 value **不丢**:它是 "Provider default" 那一档的合法值。
 */
export function flattenOptions(option) {
    const out = [];
    for (const raw of (Array.isArray(option?.options) ? option.options : [])) {
        if (raw === null || raw === undefined || typeof raw !== 'object') continue;
        if (Array.isArray(raw.options)) {
            for (const leaf of raw.options) {
                if (leaf === null || typeof leaf !== 'object') continue;
                out.push({ value: String(leaf.value ?? ''), name: String(leaf.name ?? ''), description: String(leaf.description ?? '') });
            }
            continue;
        }
        out.push({ value: String(raw.value ?? ''), name: String(raw.name ?? ''), description: String(raw.description ?? '') });
    }
    return out;
}

/**
 * 思考强度那几档(滑块用)。
 *
 * @returns {Array<{value:string,name:string,description:string,short:string,full:string}>}
 */
export function effortLevels(option) {
    return flattenOptions(option).map((o) => ({
        ...o,
        short: shortEffortName(o.value, o.name),
        full: fullEffortName(o.value, o.name),
    }));
}

/** 当前在第几档(找不到返回 0 —— 滑块总要停在一个位置上)。 */
export function effortIndexOf(levels, currentValue) {
    const want = String(currentValue ?? '');
    const at = levels.findIndex((l) => l.value === want);
    return at >= 0 ? at : 0;
}

/**
 * 「中」那一档的值;对端这份清单里**没有中** → `null`。
 *
 * ⚠️ null 不是失败,是纪律:kaiwu 绝不**臆造**一个档位值往对端发。对端只给
 *    `off / low / max` 时就没有"中"可言,那时候只能放弃补,而不是硬塞一个它没广告过的值。
 */
export function preferredEffortValue(option) {
    const hit = effortLevels(option).find((l) => l.short === PREFERRED_EFFORT_SHORT);
    return hit === undefined ? null : hit.value;
}

/**
 * 模型清单(按 provider 分组,保持对端给的顺序)。
 *
 * ⚠️ **优先用 `option.groups`**:状态里的 configOptions 是**归一化过**的
 *    (见 app/lib/agent-stream.js 的 normalizeConfigOptions)—— 那一层会把叶子摊平成
 *    `options`、并**另存一份分组结构在 `groups`**。摊平之后 `options` 里已经没有嵌套了,
 *    只看它会把分组名整条丢掉(实测踩到:清单里"供应商 P"那行标题消失)。
 *    没有 `groups` 时再按对端原始形状解析(单测直接用原文,旧外壳也可能给未归一化的数据)。
 * ⚠️ 对端**没分组**(只给平表)时也要能画:整份塞进一个无名分组。
 * @returns {Array<{group:string,name:string,options:Array<{value,name,description}>}>}
 */
export function modelGroups(option) {
    const leafOf = (l) => ({
        value: String(l?.value ?? ''),
        name: String(l?.name ?? ''),
        description: String(l?.description ?? ''),
    });
    const groups = [];
    if (Array.isArray(option?.groups)) {
        for (const g of option.groups) {
            if (g === null || g === undefined || typeof g !== 'object') continue;
            const leafs = (Array.isArray(g.options) ? g.options : [])
                .filter((l) => l !== null && typeof l === 'object').map(leafOf);
            if (leafs.length === 0) continue;
            groups.push({ group: String(g.group ?? ''), name: String(g.name ?? g.group ?? ''), options: leafs });
        }
        if (groups.length > 0) return groups;
    }
    for (const raw of (Array.isArray(option?.options) ? option.options : [])) {
        if (raw === null || raw === undefined || typeof raw !== 'object') continue;
        if (Array.isArray(raw.options)) {
            const leafs = raw.options
                .filter((l) => l !== null && typeof l === 'object')
                .map(leafOf);
            if (leafs.length === 0) continue;
            groups.push({ group: String(raw.group ?? ''), name: String(raw.name ?? raw.group ?? ''), options: leafs });
            continue;
        }
        const leaf = leafOf(raw);
        const last = groups[groups.length - 1];
        if (last !== undefined && last.group === '') last.options.push(leaf);
        else groups.push({ group: '', name: '', options: [leaf] });
    }
    return groups;
}

/** 当前模型那一条(分组的或平的都能找)。找不到返回 null。 */
export function currentModelEntry(option, currentValue) {
    const want = String(currentValue ?? '');
    for (const g of modelGroups(option)) {
        const hit = g.options.find((o) => o.value === want);
        if (hit !== undefined) return { ...hit, group: g.group, groupName: g.name };
    }
    return null;
}

/**
 * 胶囊上那一行字:收起态显示当前档位的短名(一个汉字),展开态显示通用标签。
 *
 * 为什么要这个纯函数:它是"一个字"这件事的唯一判据 —— 面板重画很多次,
 * 每次都要算出同一个字;写在面板里就会与单测各算一份。
 */
export function chipLabel({ expanded, level }) {
    if (expanded === true) return { text: '思考强度', kind: 'label' };
    return { text: level?.short ?? '默', kind: 'value' };
}
