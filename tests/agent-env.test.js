import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    buildAgentEnv, createAgentSpawn, resolveKaiwuDshHome, AGENT_PERMISSION_MODE,
} from '../app/lib/agent-env.js';

test('恒定以 read-only 启动 Agent', () => {
    const env = buildAgentEnv({ base: {} });
    assert.equal(env.DSH_PERMISSION_MODE, 'read-only');
    assert.equal(AGENT_PERMISSION_MODE, 'read-only');
});

test('调用方塞进来的权限模式会被覆盖 —— 这条保证不可配置', () => {
    // 这是"AI 不能静默改笔记"的能力边界。能配就等于没有。
    const env = buildAgentEnv({ base: { DSH_PERMISSION_MODE: 'danger-full-access' } });
    assert.equal(env.DSH_PERMISSION_MODE, 'read-only');
});

test('其余环境变量原样透传', () => {
    const env = buildAgentEnv({ base: { PATH: '/x', DEEPSEEK_API_KEY: 'sk-1' } });
    assert.equal(env.PATH, '/x');
    assert.equal(env.DEEPSEEK_API_KEY, 'sk-1');
});

test('给了 dshHome 才写 DSH_HOME(没给就别塞一个空串进去)', () => {
    assert.equal(buildAgentEnv({ base: {} }).DSH_HOME, undefined);
    assert.equal(buildAgentEnv({ base: {}, dshHome: 'C:\\h' }).DSH_HOME, 'C:\\h');
    assert.equal(buildAgentEnv({ base: {}, dshHome: '' }).DSH_HOME, undefined);
});

test('不修改传入的 base(调用方可能还要用)', () => {
    const base = { PATH: '/x' };
    buildAgentEnv({ base, dshHome: 'h' });
    assert.deepEqual(base, { PATH: '/x' });
});

// ---------------------------------------------------------------------------
// Important 3:把 read-only 保证从"约定"变成"结构"
// buildAgentEnv 只是个**构造器**,挡不住谁在别处自己拼一份 env 再 spawn。
// createAgentSpawn 把"唯一的 read-only 出口"和"这个库的 cwd"一起烤进
// 那个零参 spawnChild 里 —— 想拉起 Agent 的最省事路径就是走它。
// ---------------------------------------------------------------------------

test('createAgentSpawn 造出的 spawnChild 恒定带上 read-only 环境(注入假 spawn,不起进程)', () => {
    const calls = [];
    const fakeChild = { pid: 4242 };
    const spawnChild = createAgentSpawn({
        command: 'dsh.exe',
        args: ['--profile', 'acp'],
        dshHome: 'C:\\kaiwu-home',
        cwd: 'C:\\vault',
        // 调用点塞进来的权限模式与 DSH_HOME 一律无效 —— 这条保证不可配置。
        base: { PATH: '/x', DSH_PERMISSION_MODE: 'danger-full-access', DSH_HOME: 'C:\\wrong' },
        spawn: (command, args, options) => { calls.push({ command, args, options }); return fakeChild; },
    });

    assert.equal(typeof spawnChild, 'function');
    // 监护人只认 () => ChildProcess,所以工厂产出的必须是零参函数。
    assert.equal(spawnChild.length, 0, 'spawnChild 必须是零参的:监护人只认 () => ChildProcess');
    assert.equal(spawnChild(), fakeChild);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'dsh.exe');
    assert.deepEqual(calls[0].args, ['--profile', 'acp']);
    assert.equal(calls[0].options.env.DSH_PERMISSION_MODE, 'read-only',
        'read-only 必须由工厂烤进去,而不是留给调用点记得调 buildAgentEnv');
    assert.equal(calls[0].options.env.DSH_HOME, 'C:\\kaiwu-home',
        'DSH_HOME 也必须由工厂显式给出,不许继承调用点的');
    assert.equal(calls[0].options.cwd, 'C:\\vault',
        'cwd 是能力边界的**读**那一半:Agent 的工作目录就是当前 Vault');
    assert.equal(calls[0].options.env.PATH, '/x', '其余环境变量原样透传');
});

test('createAgentSpawn:args 与 cwd 在创建时就固定,之后改不动已经交付的工厂', () => {
    const args = ['--profile', 'acp'];
    const calls = [];
    const spawnChild = createAgentSpawn({
        command: 'node', args, dshHome: 'C:\\kaiwu-home', cwd: 'v', base: {},
        spawn: (command, a, options) => { calls.push({ command, a, options }); return {}; },
    });

    args.push('--oops');                    // 创建之后再改
    spawnChild();
    spawnChild();
    assert.deepEqual(calls.map(c => c.a), [['--profile', 'acp'], ['--profile', 'acp']],
        '创建之后再改 args 不许影响已有工厂');
    assert.equal(calls[1].options.env.DSH_PERMISSION_MODE, 'read-only',
        '每一次 spawn 都是同一份只读环境');
});

test('createAgentSpawn 缺 command / cwd 时当场抛:接错线的工厂不该拖到起进程才炸', () => {
    assert.throws(() => createAgentSpawn({ cwd: 'v', spawn: () => ({}) }), /command/);
    assert.throws(() => createAgentSpawn({ command: 'node', spawn: () => ({}) }), /cwd/,
        '没有"这是哪个库"就不该造工厂');
    assert.throws(() => createAgentSpawn({ command: 'node', cwd: '', spawn: () => ({}) }), /cwd/);
});

test('resolveKaiwuDshHome 是 kaiwu 的 DSH_HOME 的唯一解析点(spawn 与凭证检测共用它)', () => {
    // 两处独立解析 DSH_HOME 会**静默不一致**:agent 能用、界面却说"没凭证"。
    assert.equal(
        resolveKaiwuDshHome({ env: { DSH_HOME: 'C:\\explicit' }, appData: 'C:\\appdata' }),
        'C:\\explicit', '显式给了就用它(优先级不变)');
    assert.equal(
        resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata' }),
        path.join('C:\\appdata', 'kaiwu', 'dsh-home'));
    assert.equal(
        resolveKaiwuDshHome({ env: { DSH_HOME: '   ' }, appData: 'C:\\appdata' }),
        path.join('C:\\appdata', 'kaiwu', 'dsh-home'), '空串等于没给');
    assert.equal(typeof resolveKaiwuDshHome({ env: {}, appData: undefined }), 'string',
        '连 APPDATA 都没有也不能抛');
});

test('设置页配的 DSH_HOME 优先级最高;相对路径不采信(会退回探测)', () => {
    // 用户能在设置页显式指定"Agent 的家" —— 那是他看得见、也说得出口的一个选择,
    // 比继承来的环境变量更"显式"。但它必须是绝对路径:相对的家随子进程 cwd 飘,
    // 而 cwd 是用户的 Vault(换个库就换一个家),那种错最难查。
    assert.equal(
        resolveKaiwuDshHome({
            env: { DSH_HOME: 'C:\\from-env' }, appData: 'C:\\appdata', configured: 'D:\\kaiwu\\dsh-home',
        }),
        'D:\\kaiwu\\dsh-home', '设置 > 显式 env');
    assert.equal(
        resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata', configured: '  D:\\x  ' }),
        'D:\\x', '前后空白会 trim');
    // 相对路径 / 空 / 非字符串 → 一律退回探测(不许当场抛)
    assert.equal(
        resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata', configured: 'dsh-home' }),
        path.join('C:\\appdata', 'kaiwu', 'dsh-home'), '相对路径不采信');
    assert.equal(
        resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata', configured: '   ' }),
        path.join('C:\\appdata', 'kaiwu', 'dsh-home'), '空值 = 没配');
    assert.equal(
        resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata', configured: 42 }),
        path.join('C:\\appdata', 'kaiwu', 'dsh-home'), '非字符串 = 没配');
    // 没配 + 有环境变量 → 还是环境变量那条老路
    assert.equal(
        resolveKaiwuDshHome({ env: { DSH_HOME: 'C:\\from-env' }, appData: 'C:\\appdata', configured: '' }),
        'C:\\from-env');
});

test('createAgentSpawn 与 resolveKaiwuDshHome 接得上:同一个家同时给 spawn 与凭证检测', () => {
    const dshHome = resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata' });
    const calls = [];
    const spawnChild = createAgentSpawn({
        command: 'node', dshHome, cwd: 'v', base: {},
        spawn: (command, a, options) => { calls.push({ options }); return {}; },
    });
    spawnChild();
    assert.equal(calls[0].options.env.DSH_HOME, dshHome,
        'spawn 用的家必须就是解析出来的那一个 —— 这正是"唯一解析点"的意义');
});

test('createAgentSpawn 省略 dshHome 也不许继承:base 里那个敌意的 DSH_HOME 必须输给 kaiwu 自己的家', () => {
    // 这条缝就是"静默继承":base 默认是 process.env,而 buildAgentEnv 只在 dshHome
    // 非空时才写 DSH_HOME —— 于是省略参数 = 把子进程丢回继承,一个**别的家**
    // (本机实测:继承来的正是 harness 自己的家,那里有 .credentials.yaml)
    // 就悄悄成了 Agent 的家,而面板检查的是 kaiwu 的家 ——
    // 用户看到的是"agent 明明能用,界面却说没凭证"。
    const HOSTILE = 'C:\\Users\\someone\\AppData\\Roaming\\dsh-desktop\\harness';
    const calls = [];
    const spawnChild = createAgentSpawn({
        command: 'node',
        cwd: 'C:\\vault',
        // 连 base 都带着这个敌意值:它绝不许决定 Agent 用哪个家。
        base: { PATH: '/x', DSH_HOME: HOSTILE, APPDATA: 'C:\\appdata' },
        spawn: (command, a, options) => { calls.push({ options }); return {}; },
    });
    spawnChild();

    assert.equal(calls[0].options.env.DSH_HOME,
        resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata' }),
        '省略 dshHome 时必须由那个**唯一的解析点**给出 kaiwu 自己的家');
    assert.notEqual(calls[0].options.env.DSH_HOME, HOSTILE,
        '继承来的 DSH_HOME 绝不许悄悄变成 Agent 的家');
    assert.equal(calls[0].options.env.PATH, '/x', '其余环境变量照旧从 base 继承');
});

test('createAgentSpawn:dshHome 传空串/纯空白等于没给(它同样把子进程丢回继承)', () => {
    // buildAgentEnv 只认非空字符串,所以 '' 与省略是同一个洞。
    const calls = [];
    const spawnChild = createAgentSpawn({
        command: 'node', cwd: 'v', dshHome: '   ',
        base: { DSH_HOME: 'C:\\harness-home', APPDATA: 'C:\\appdata' },
        spawn: (command, a, options) => { calls.push({ options }); return {}; },
    });
    spawnChild();
    assert.equal(calls[0].options.env.DSH_HOME, path.join('C:\\appdata', 'kaiwu', 'dsh-home'),
        '空/空白 dshHome 也必须落到 kaiwu 自己的家,而不是继承');
});

test('createAgentSpawn 算不出**绝对**的家时当场抛:宁可不启动,也不给子进程一个相对的家', () => {
    // base 不是对象时 kaiwuOwnDshHome 拿到 {} → 没有 APPDATA → 旧实现用
    // path.join('', 'kaiwu', 'dsh-home') 拼出 'kaiwu\\dsh-home' 这个**相对路径**,
    // 原样写进子进程的 env。相对的家会按子进程 cwd 解析 —— 那里没有 .credentials.yaml,
    // 于是子进程找凭证失败,而面板检查的却是另一个家:两边静默不一致(正是这个文件
    // 顶部那段注释要防的事)。相对路径在 Windows 上是**盘符相关**的,连"哪个家"都不确定。
    assert.throws(
        () => createAgentSpawn({ command: 'node', cwd: 'v', base: null, spawn: () => ({}) }),
        /DSH_HOME/,
        '宁可不启动,也不递一个相对的家给子进程',
    );
    assert.throws(
        () => createAgentSpawn({
            command: 'node', cwd: 'v',
            base: { DSH_HOME: 'rel/home' },          // 显式,但是相对路径
            spawn: () => ({}) }),
        /DSH_HOME/,
        '显式给的相对路径同样不能用:它按子进程 cwd 解析,家会飘',
    );
});

test('resolveKaiwuDshHome 算不出绝对路径时返回空串(而不是一个相对路径)', () => {
    // 唯一的解析点只能给出"绝对路径"或"空串"两种答案:空串是**说得出口的失败**,
    // 相对路径是一个看着像答案的错误答案。上层看到空串就知道该拒。
    assert.equal(resolveKaiwuDshHome({ env: {}, appData: undefined }), '',
        '没有 APPDATA 时不许拼出相对的家');
    assert.equal(resolveKaiwuDshHome({ env: {}, appData: 42 }), '',
        'appData 不是字符串时同样算不出来');
    assert.equal(resolveKaiwuDshHome({ env: { DSH_HOME: 'rel/home' }, appData: 'C:\\appdata' }), '',
        '显式给的相对 DSH_HOME 也不接受:它是个飘的家,不是家');
    // 正常路径一个字不变(契约里"显式 > APPDATA"的优先级也没变)
    assert.equal(resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata' }),
        path.join('C:\\appdata', 'kaiwu', 'dsh-home'));
});
