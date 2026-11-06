import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MOTION_OFF, RESTART_NOTICE, SETTINGS_KEYS, SETTINGS_NS, SETTINGS_SECTIONS,
    badgeCounts, describeAgentProcess, emptySearchText, filterSettings, itemCount, itemSearchText,
    matchesQuery, motionOffFromSetting, motionSettingFromToggle, savePathResultText, validatePathSetting,
} from '../app/lib/settings-page.js';
import { resolveServiceRoot } from '../app/lib/service-root.js';

// 设置页的**纯逻辑**。为什么这些要有单测(而不是只靠自检):
//   · 自检一次 30-60 秒;而"写到哪个键、什么算合法路径、搜索怎么算命中"这几条
//     恰恰是最容易在界面上看起来没事、实际上写错地方的那一类;
//   · 键名是**存档格式**:改错了的表现是"用户设置丢了"(而不是报错)。

// ---------- 键名与命名空间(存档格式) ----------

test('设置键与命名空间:与 electron/main.js 读的是同一批(不许另开一个家)', () => {
    assert.equal(SETTINGS_NS, '__global');
    assert.deepEqual(Object.keys(SETTINGS_KEYS).sort(), ['dshHome', 'motion', 'serviceRoot']);
    assert.equal(SETTINGS_KEYS.dshHome, 'dshHome', 'Agent 的 DSH_HOME');
    assert.equal(SETTINGS_KEYS.serviceRoot, 'serviceRoot', '与 main.js 的 serviceRoot() 同一个键');
    assert.equal(SETTINGS_KEYS.motion, 'ui.motion', '只有动效走 ui.* 前缀');
    for (const key of Object.values(SETTINGS_KEYS)) {
        assert.equal(typeof key, 'string');
        assert.ok(key.length > 0);
        assert.equal(key.includes(' '), false, '键里不许有空格');
    }
});

// ---------- 分区与项目 ----------

test('首选项分区 id 仅使用小写字母', () => {
    // 分区 id 只用小写字母(它们是 dataset 值,自检与搜索都按它取值)
    for (const sec of SETTINGS_SECTIONS) assert.match(sec.id, /^[a-z]+$/);
});

test('分区与项目:11 项、4 个分区,每项都带控件类型与徽标', () => {
    assert.deepEqual(SETTINGS_SECTIONS.map((s) => s.id), ['ai', 'ui', 'svc', 'vault']);
    assert.deepEqual(SETTINGS_SECTIONS.map((s) => s.name), ['AI 与 Agent', '界面', '服务', '笔记库']);
    assert.equal(itemCount(), 11, '8 项已有通道 + 3 个新增设置');
    const items = SETTINGS_SECTIONS.flatMap((s) => s.items);
    const ids = items.map((i) => i.id);
    for (const need of [
        'videoModel', 'videoKey', 'imageKey', 'credential', 'agentKill', 'layout', 'motion',
        'vaultPath', 'indexStatus', 'dshHome', 'serviceRoot',
    ]) {
        assert.ok(ids.includes(need), `缺了设置项:${need}`);
    }
    assert.equal(new Set(ids).size, ids.length, 'id 不许重复');
    for (const it of items) {
        assert.equal(typeof it.title, 'string');
        assert.equal(typeof it.hint, 'string');
        assert.ok(it.title.length > 0 && it.hint.length > 0);
        assert.ok(it.badge === 'has' || it.badge === 'new', `${it.id} 的徽标只能是 has/new`);
        assert.ok(typeof it.ctrl === 'string' && it.ctrl.length > 0, `${it.id} 要有控件类型`);
        assert.equal(typeof it.restart, 'boolean', `${it.id} 要声明"改完是否要重启"`);
        assert.equal(typeof it.kw, 'string', `${it.id} 要有搜索关键词`);
    }
});

test('徽标分布:8 项已有通道 + 3 个新增设置', () => {
    assert.deepEqual(badgeCounts(), { has: 8, isNew: 3 });
    const byId = Object.fromEntries(SETTINGS_SECTIONS.flatMap((s) => s.items).map((i) => [i.id, i.badge]));
    assert.equal(byId.dshHome, 'new', 'DSH_HOME 是可配化那笔欠账');
    assert.equal(byId.serviceRoot, 'new', '服务根目录是可配化那笔欠账');
    assert.equal(byId.videoKey, 'has', '密钥走的是既有通道');
    assert.equal(byId.agentKill, 'has', '「停止 Agent 进程」走的是既有的 agent:stop 通道');
    assert.equal(byId.videoModel, 'has');
});

test('「停止 Agent 进程」是可找得到的常驻入口,而且挂在 AI 与 Agent 下', () => {
    const ai = SETTINGS_SECTIONS.find((s) => s.id === 'ai');
    const item = ai.items.find((i) => i.id === 'agentKill');
    assert.ok(item !== undefined, '那一行上的按钮改成"出事才出现"之后,这里必须有一个常驻入口');
    assert.equal(item.ctrl, 'kill');
    assert.match(item.hint, /重试/, '必须写清"停掉之后去哪儿再连"');
    assert.match(item.kw, /卡住/, '搜索"卡住"要能找到它');
});

test('AI 设置页有图片服务密钥入口，保存后无需重启', () => {
    const ai = SETTINGS_SECTIONS.find((s) => s.id === 'ai');
    const item = ai.items.find((i) => i.id === 'imageKey');
    assert.equal(item?.ctrl, 'image-secret');
    assert.equal(item?.restart, false);
    assert.match(item?.hint ?? '', /不回显/);
});

test('Agent 进程读数:状态翻成中文,并判"现在值不值得按停止"', () => {
    assert.deepEqual(describeAgentProcess({ state: 'ready', pid: 4242 }),
        { state: 'ready', label: '已连接', canStop: true, detail: 'pid 4242' });
    // 未连接 → 没有东西可停(按钮该是灰的),但读数还是要说清
    assert.deepEqual(describeAgentProcess({ state: 'stopped' }),
        { state: 'stopped', label: '未连接', canStop: false, detail: '' });
    // 起不来 / 崩了:这正是要用它的时刻,原因要跟着显示
    assert.equal(describeAgentProcess({ state: 'failed', error: '握手超时' }).canStop, true);
    assert.equal(describeAgentProcess({ state: 'failed', error: '握手超时' }).detail, '握手超时');
    assert.equal(describeAgentProcess({ state: 'crashed' }).canStop, true);
    // 脏输入不抛(通道可能什么都没回)
    assert.equal(describeAgentProcess(null).canStop, false);
    assert.equal(describeAgentProcess('nope').label, '读不到');
    assert.equal(describeAgentProcess({ state: '???', pid: null }).canStop, true, '不认识的状态宁可让用户能按');
});

test('路径类设置才声明"要重启才生效"(DSH_HOME / 服务根目录)', () => {
    const restart = SETTINGS_SECTIONS.flatMap((s) => s.items).filter((i) => i.restart === true).map((i) => i.id);
    assert.deepEqual(restart.sort(), ['dshHome', 'serviceRoot']);
    assert.match(RESTART_NOTICE, /重启/);
});

// ---------- 搜索 ----------

test('搜索:标题 / 说明 / 关键词三处都算命中,而且是跨分区的', () => {
    assert.equal(matchesQuery(SETTINGS_SECTIONS[0].items[1], '密钥'), true, '标题命中');
    assert.equal(matchesQuery(SETTINGS_SECTIONS[0].items[1], 'dashscope'), true, '说明/关键词命中');
    assert.equal(matchesQuery(SETTINGS_SECTIONS[0].items[1], '阿里云'), true, '关键词命中');
    assert.equal(matchesQuery(SETTINGS_SECTIONS[0].items[1], 'sha256'), false);
    assert.equal(matchesQuery(SETTINGS_SECTIONS[0].items[1], ''), true, '空查询 = 全匹配');
    assert.equal(matchesQuery(SETTINGS_SECTIONS[0].items[1], '   '), true, '纯空白也当没输入');

    const r = filterSettings('服务');
    assert.ok(r.total >= 1);
    assert.deepEqual(r.sections.map((s) => s.id), ['ai', 'svc'], '图片服务和服务设置都应命中');
    for (const section of r.sections) assert.equal(section.hits, section.items.length);
});

test('搜索:分区标题带命中数,多分区命中时都会出现', () => {
    const r = filterSettings('路径');
    assert.ok(r.total >= 2, `"路径"应当命中多项,实际 ${r.total}`);
    assert.equal(r.total, r.sections.reduce((n, s) => n + s.hits, 0));
    for (const s of r.sections) assert.equal(s.hits, s.items.length);
    // 命中数就是 items 的长度 —— 界面直接拿它写 `名称(N)`
    assert.equal(r.sections.every((s) => s.items.length > 0), true);
});

test('搜索:没有命中时 total=0 且给出一句中文(界面照着它写)', () => {
    const r = filterSettings('zzz-不存在的词');
    assert.equal(r.total, 0);
    assert.deepEqual(r.sections, []);
    assert.equal(emptySearchText('zzz-不存在的词'), '没有匹配的设置项:zzz-不存在的词');
    assert.match(emptySearchText('  密钥  '), /没有匹配的设置项:密钥/, '查询串会 trim');
});

test('搜索:大小写与空白不影响命中(界面输入框原样传进来)', () => {
    assert.equal(matchesQuery({ title: 'DSH_HOME', hint: '', kw: '' }, 'dsh_home'), true);
    assert.equal(matchesQuery({ title: 'DSH_HOME', hint: '', kw: '' }, '  dsh  '), true);
    assert.equal(itemSearchText({ title: '甲', hint: '乙', kw: '丙' }), '甲 乙 丙');
});

// ---------- 路径校验 ----------

test('路径校验:空值 = 用默认/自动探测(合法,不是错误)', () => {
    for (const raw of ['', '   ', null, undefined]) {
        const v = validatePathSetting(raw);
        assert.equal(v.ok, true, `${String(raw)} 应当是合法的空值`);
        assert.equal(v.value, '');
        assert.equal(v.empty, true);
    }
    assert.equal(validatePathSetting('""').empty, true, '只有一对引号也算空');
});

test('路径校验:绝对路径通过(盘符两种斜杠 + UNC)', () => {
    assert.deepEqual(validatePathSetting('D:\\kaiwu\\data'), { ok: true, value: 'D:\\kaiwu\\data', reason: '', empty: false });
    assert.equal(validatePathSetting('D:/kaiwu/data').ok, true);
    assert.equal(validatePathSetting('  C:\\Users\\x  ').value, 'C:\\Users\\x', '前后空白会 trim');
    const unc = validatePathSetting('\\\\server\\share\\dir');
    assert.equal(unc.ok, true);
    assert.equal(unc.value, '\\\\server\\share\\dir');
    assert.equal(validatePathSetting('"D:\\kaiwu\\data"').value, 'D:\\kaiwu\\data', '成对引号会去掉');
});

test('路径校验:相对路径一律拒(会随进程 cwd 飘)', () => {
    for (const raw of ['kaiwu\\data', 'data', '..\\data', './data', '/home/x']) {
        const v = validatePathSetting(raw);
        assert.equal(v.ok, false, `${raw} 应当被拒`);
        assert.match(v.reason, /绝对路径/);
        assert.equal(v.value, raw, '被拒时仍把原值带回去,界面才能让用户改');
    }
});

test('路径校验:Windows 非法字符与多余的冒号各有各的说法', () => {
    for (const raw of ['D:\\a<b', 'D:\\a>b', 'D:\\a"b', 'D:\\a|b', 'D:\\a?b', 'D:\\a*b']) {
        const v = validatePathSetting(raw);
        assert.equal(v.ok, false, `${raw} 应当被拒`);
        assert.match(v.reason, /不接受的字符/);
    }
    const colon = validatePathSetting('D:\\a:b');
    assert.equal(colon.ok, false);
    assert.match(colon.reason, /冒号/);
    assert.equal(validatePathSetting('D:\\a\\b').ok, true, '正常路径不受影响');
});

test('路径校验:脏输入不抛(界面把用户输入原样递进来)', () => {
    for (const raw of ['', ' ', '\n', '\t\t', '""', 42, {}, [], true]) {
        assert.doesNotThrow(() => validatePathSetting(raw));
    }
    assert.equal(validatePathSetting(42).ok, false, '数字不是路径');
    assert.equal(validatePathSetting({}).ok, false);
});

test('保存提示:合法 + 写成功 + 要重启 → 明说"重启才生效"', () => {
    const ok = validatePathSetting('D:\\kaiwu');
    assert.match(savePathResultText(ok, true, true), /已保存/);
    assert.match(savePathResultText(ok, true, true), /重启/);
    assert.equal(savePathResultText(ok, true, false), '已保存', '不需要重启的项不许乱提重启');
    assert.match(savePathResultText(validatePathSetting(''), true, true), /清空/);
    assert.match(savePathResultText(ok, false, true), /没写进设置/);
    assert.match(savePathResultText(validatePathSetting('rel'), true, true), /绝对路径/);
    assert.doesNotThrow(() => savePathResultText(null, true, true));
});

// ---------- 动效开关 ----------

test('动效开关:只认字面 off,别的(空/脏数据)一律当"跟随系统"', () => {
    assert.equal(MOTION_OFF, 'off');
    assert.equal(motionOffFromSetting('off'), true);
    assert.equal(motionOffFromSetting(' off '), true);
    for (const raw of ['', ' ', null, undefined, 'on', 'OFF ', 0, false, {}]) {
        assert.equal(motionOffFromSetting(raw), false, `${String(raw)} 应当当"跟随系统"`);
    }
    assert.equal(motionSettingFromToggle(true), 'off');
    assert.equal(motionSettingFromToggle(false), '', '关掉开关 = 写空串(等价于没设过)');
    assert.equal(motionSettingFromToggle(undefined), '');
});

// ---------- 服务根目录的回退 ----------

test('服务根目录:绝对路径的设置有最高优先级,来源标成 settings', () => {
    const r = resolveServiceRoot({ configured: 'E:\\project\\personal_web_project', fallback: 'D:\\fallback' });
    assert.deepEqual(r, { root: 'E:\\project\\personal_web_project', source: 'settings', reason: '' });
});

test('服务根目录:空 / 非字符串 / 相对路径一律退回默认,并说清为什么', () => {
    const def = resolveServiceRoot({ configured: '', fallback: 'D:\\fallback' });
    assert.deepEqual(def, { root: 'D:\\fallback', source: 'default', reason: '' });
    assert.equal(resolveServiceRoot({ configured: '   ', fallback: 'D:\\fallback' }).source, 'default');
    assert.equal(resolveServiceRoot({ configured: null, fallback: 'D:\\fallback' }).source, 'default');
    assert.equal(resolveServiceRoot({ configured: 42, fallback: 'D:\\fallback' }).source, 'default');
    const rel = resolveServiceRoot({ configured: 'personal_web_project', fallback: 'D:\\fallback' });
    assert.equal(rel.root, 'D:\\fallback');
    assert.equal(rel.source, 'default');
    assert.match(rel.reason, /不是绝对路径/, '退回默认要有原因可记(启动日志里能看到)');
});

test('服务根目录:注入 isAbsolute 时判据跟着走(不依赖真实文件系统)', () => {
    const win = resolveServiceRoot({ configured: 'C:\\x', fallback: 'F:\\y', isAbsolute: (p) => p.startsWith('C:') });
    assert.equal(win.source, 'settings');
    const notAbs = resolveServiceRoot({ configured: 'C:\\x', fallback: 'F:\\y', isAbsolute: () => false });
    assert.equal(notAbs.source, 'default');
    assert.deepEqual(resolveServiceRoot({}).root, '', '连默认值都没给 → 空串,不抛');
});
