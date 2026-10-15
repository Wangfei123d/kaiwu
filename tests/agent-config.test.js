import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MODEL_CONFIG_ID, REASONING_CONFIG_ID, PREFERRED_EFFORT_SHORT, chipLabel, configOptionOf,
    currentModelEntry, effortIndexOf, effortLevels, effortValueOf, flattenOptions, fullEffortName,
    modelGroups, preferredEffortValue, shortEffortName,
} from '../app/lib/agent-config.js';

// 这一层是"思考强度/模型"这枚胶囊的**判据**:几档、每档显示什么字、清单怎么分组。
// 用例里的形状全部照**真机实测**的那份 configOptions 写(dsh-acp 的 modelAndReasoningOptions)。

// 真机那份的简化版:模型按 provider 分组,思考强度是平表且带英文 description。
const REAL = [
    {
        id: MODEL_CONFIG_ID, name: 'Model', category: 'model', type: 'select',
        currentValue: '["deepseek-official","deepseek-v4-flash"]',
        options: [{
            group: 'deepseek-official', name: 'DeepSeek',
            options: [
                { value: '["deepseek-official","deepseek-v4-flash"]', name: 'DeepSeek-V4-Flash', description: '快、便宜' },
                { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro', description: '更强' },
                { value: '["deepseek-official","deepseek-v4-flash-vision-exp"]', name: 'DeepSeek-V4-Flash-Vision-Exp' },
            ],
        }],
    },
    {
        id: REASONING_CONFIG_ID, name: 'Reasoning effort', category: 'thought_level', type: 'select',
        currentValue: 'high',
        options: [
            { value: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
            { value: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
            { value: 'high', name: 'High', description: 'The default balance for most tasks.' },
            { value: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
        ],
    },
];

test('configOptionOf:按 id 取,取不到给 null(界面据此不画那一条)', () => {
    assert.equal(configOptionOf(REAL, MODEL_CONFIG_ID)?.name, 'Model');
    assert.equal(configOptionOf(REAL, REASONING_CONFIG_ID)?.currentValue, 'high');
    assert.equal(configOptionOf(REAL, 'reasoning'), null);
    assert.equal(configOptionOf(null, MODEL_CONFIG_ID), null);
    assert.equal(configOptionOf([null, 'x'], MODEL_CONFIG_ID), null);
});

test('短名:deepseek 这条梯子显示「关 / 低 / 中 / 高」', () => {
    // ⚠️ high→「中」而不是「高」:对端自述它是 "The default balance for most tasks",
    //    在这条梯子上就是中间那档;max 才是"最难"。
    assert.deepEqual(
        effortLevels(configOptionOf(REAL, REASONING_CONFIG_ID)).map((l) => l.short),
        ['关', '低', '中', '高']);
    assert.deepEqual(
        effortLevels(configOptionOf(REAL, REASONING_CONFIG_ID)).map((l) => l.full),
        ['关闭', '低', '中', '最高']);
});

test('短名兜底:词典里没有的档位,退到 name 首字符;name 也没有就取 value 前两个字', () => {
    assert.equal(shortEffortName('off', 'Off'), '关');
    assert.equal(shortEffortName('OFF'), '关', 'value 大小写不敏感');
    assert.equal(shortEffortName('ultra', 'Ultra'), 'U', '不认识 → name 首字符');
    assert.equal(shortEffortName('ultra'), 'ul', '连 name 都没有 → value 前两个字符');
    assert.equal(shortEffortName('', 'Provider default'), '默', '空 value 是合法的"默认"档');
    assert.equal(fullEffortName('', ''), '默认');
});

test('档位与当前档下标:找不到时停在 0(滑块总要有个位置,不许 NaN)', () => {
    const levels = effortLevels(configOptionOf(REAL, REASONING_CONFIG_ID));
    assert.equal(levels.length, 4);
    assert.equal(effortIndexOf(levels, 'high'), 2);
    assert.equal(effortIndexOf(levels, 'max'), 3);
    assert.equal(effortIndexOf(levels, '没见过的档'), 0);
    assert.equal(effortIndexOf([], 'high'), 0);
});

test('档位数不写死:对端只给一档(只有 Off 的部署)时就是一档', () => {
    const onlyOff = { id: REASONING_CONFIG_ID, options: [{ value: 'off', name: 'Off' }] };
    assert.deepEqual(effortLevels(onlyOff).map((l) => l.short), ['关']);
});

test('"Provider default" 那一档(value 为空串)不许被丢掉', () => {
    const withDefault = {
        id: REASONING_CONFIG_ID,
        options: [{ value: '', name: 'Provider default' }, { value: 'low', name: 'Low' }],
    };
    const levels = effortLevels(withDefault);
    assert.equal(levels.length, 2);
    assert.equal(levels[0].value, '');
    assert.equal(levels[0].short, '默');
});

test('flattenOptions:分组与平表都能摊平,叶子字段齐全', () => {
    const flat = flattenOptions(configOptionOf(REAL, MODEL_CONFIG_ID));
    assert.equal(flat.length, 3);
    assert.equal(flat[0].name, 'DeepSeek-V4-Flash');
    assert.equal(flat[0].description, '快、便宜');
    assert.equal(flat[2].description, '', '对端没给 description 时是空串,不是 undefined');
});

test('modelGroups:保持对端的分组与顺序;平表也能画成一个无名分组', () => {
    const groups = modelGroups(configOptionOf(REAL, MODEL_CONFIG_ID));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].group, 'deepseek-official');
    assert.equal(groups[0].name, 'DeepSeek');
    assert.deepEqual(groups[0].options.map((o) => o.name),
        ['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash-Vision-Exp']);

    const flat = modelGroups({ id: MODEL_CONFIG_ID, options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] });
    assert.deepEqual(flat, [{ group: '', name: '', options: [{ value: 'a', name: 'A', description: '' }, { value: 'b', name: 'B', description: '' }] }]);
    assert.deepEqual(modelGroups(null), []);
});

test('currentModelEntry:按不透明 value 找当前那一条(连分组名一起给)', () => {
    const opt = configOptionOf(REAL, MODEL_CONFIG_ID);
    const hit = currentModelEntry(opt, '["deepseek-official","deepseek-v4-flash"]');
    assert.equal(hit?.name, 'DeepSeek-V4-Flash');
    assert.equal(hit?.group, 'deepseek-official');
    assert.equal(hit?.groupName, 'DeepSeek');
    assert.equal(currentModelEntry(opt, '对端没给过的值'), null);
});

test('chipLabel:收起态是一个汉字,展开态是"思考强度"', () => {
    const levels = effortLevels(configOptionOf(REAL, REASONING_CONFIG_ID));
    assert.deepEqual(chipLabel({ expanded: false, level: levels[2] }), { text: '中', kind: 'value' });
    assert.deepEqual(chipLabel({ expanded: true, level: levels[2] }), { text: '思考强度', kind: 'label' });
    // 一条档位都没给(对端没这条)时也不能空着
    assert.deepEqual(chipLabel({ expanded: false, level: null }), { text: '默', kind: 'value' });
});

test('modelGroups 优先用归一化保留下来的 groups(摊平之后 options 里已经没有嵌套)', () => {
    // 归一化(app/lib/agent-stream.js)会把叶子摊平进 options、并另存分组在 groups。
    // 只读 options 的话分组名会整条丢掉 —— 清单里那行分区标题就没了(实测踩到)。
    const normalized = {
        id: MODEL_CONFIG_ID, currentValue: 'b',
        options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
        groups: [{ group: 'g1', name: '供应商一', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }],
    };
    const g = modelGroups(normalized);
    assert.equal(g.length, 1);
    assert.equal(g[0].name, '供应商一', '分组名必须留住');
    assert.deepEqual(g[0].options.map((o) => o.value), ['a', 'b']);
    assert.equal(currentModelEntry(normalized, 'b')?.groupName, '供应商一');
});

// ---------------------------------------------------------------------------
// kaiwu 自己的默认思考强度「中」(见 electron/agent/agent-runtime.js 的 pinEffort)
// ---------------------------------------------------------------------------

test('默认档:真机那条梯子上「中」= high,而且短名确实是中', () => {
    const option = configOptionOf(REAL, REASONING_CONFIG_ID);
    assert.equal(preferredEffortValue(option), 'high');
    assert.equal(shortEffortName('high'), PREFERRED_EFFORT_SHORT);
});

test('默认档:对端只用 medium 当 id 时也认得出「中」', () => {
    const option = { currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] };
    assert.equal(preferredEffortValue(option), 'medium');
});

test('默认档:对端**没有**「中」这一档时给 null —— 绝不臆造一个它没广告过的值', () => {
    const option = {
        currentValue: 'off',
        options: [{ value: 'off', name: 'Off' }, { value: 'max', name: 'Max' }],
    };
    assert.equal(preferredEffortValue(option), null);
    assert.equal(preferredEffortValue(null), null);
    assert.equal(preferredEffortValue({ currentValue: 'high' }), null, '一项 options 都没给 → 没有可发的值');
});

test('默认档:两档都映射成「中」时取对端排在前面的那一个(不挑食、不拼装)', () => {
    const option = { options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] };
    assert.equal(preferredEffortValue(option), 'medium');
});

test('当前档:三种"没有"要分开 —— 没这一项 / 脏数据给 null,空串是合法值', () => {
    assert.equal(effortValueOf(REAL), 'high');
    assert.equal(effortValueOf([{ id: MODEL_CONFIG_ID, currentValue: 'x' }]), null, '对端没给强度这一项');
    assert.equal(effortValueOf([{ id: REASONING_CONFIG_ID, currentValue: 42 }]), null, 'currentValue 不是字符串');
    assert.equal(effortValueOf([{ id: REASONING_CONFIG_ID }]), null);
    // ⚠️ "Provider default" 那一档就是空串 —— 它与"没有"是两件事(见 effortValueOf 的说明)
    assert.equal(effortValueOf([{ id: REASONING_CONFIG_ID, currentValue: '' }]), '');
});
