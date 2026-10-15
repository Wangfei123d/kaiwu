import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { detectCredentials, isMissingCredentialError } from '../electron/agent/credentials.js';
import { resolveKaiwuDshHome } from '../app/lib/agent-env.js';

// 用户报的第一件事会是"发出去了没反应"。握手和建会话**不需要**凭证,
// 所以链路全绿也可能是没钥匙 —— 必须能提前、明确地告诉他。

test('环境变量里有就用环境变量', () => {
    const r = detectCredentials({
        env: { DEEPSEEK_API_KEY: 'sk-xxx' },
        home: 'C:\\nope',
        readFile: () => { throw new Error('不该读到文件'); },
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'env');
});

test('没有环境变量时看凭证文件', () => {
    const r = detectCredentials({
        env: {},
        home: 'C:\\dsh',
        readFile: (p) => {
            assert.match(p, /\.credentials\.yaml$/);
            return 'deepseek:\n  apiKey: sk-yyy\n';
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'file');
});

test('两边都没有时给出可直接照做的中文原因', () => {
    const r = detectCredentials({
        env: {},
        home: 'C:\\dsh',
        readFile: () => { throw new Error('ENOENT'); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.source, null);
    assert.match(r.reason, /DEEPSEEK_API_KEY/);
    assert.match(r.reason, /credentials\.yaml/);
});

test('空字符串不算有(环境变量被设成空是常见事故)', () => {
    const r = detectCredentials({ env: { DEEPSEEK_API_KEY: '   ' }, home: 'C:\\dsh', readFile: () => '' });
    assert.equal(r.ok, false);
});

test('返回值里**只有**布尔与来源,绝不带出密钥值', () => {
    const r = detectCredentials({
        env: { DEEPSEEK_API_KEY: 'sk-秘密' }, home: 'x', readFile: () => 'sk-秘密',
    });
    assert.equal(JSON.stringify(r).includes('秘密'), false, '密钥值不许出现在返回值里');
    assert.deepEqual(Object.keys(r).sort(), ['ok', 'reason', 'source']);

    // ⚠️ 文件分支必须**单独**再来一遍:上面那条有环境变量、在 :20 就短路了,
    // readFile 根本没被调用 —— 只测它等于从未测过文件这条路。
    // 少了这一段,将来谁把文件内容拼进 reason 都不会有测试拦得住。
    const fromFile = detectCredentials({
        env: {}, home: 'x', readFile: () => 'deepseek:\n  apiKey: sk-文件秘密\n',
    });
    assert.equal(fromFile.ok, true);
    assert.equal(fromFile.source, 'file');
    assert.equal(JSON.stringify(fromFile).includes('文件秘密'), false,
        '文件里的密钥值不许出现在返回值里');
    assert.deepEqual(Object.keys(fromFile).sort(), ['ok', 'reason', 'source']);

    // 读文件失败那条路同样要查:抛出的错误对象里完全可能带着文件内容,
    // 而这条路恰好是唯一会把 readFile 的痕迹暴露到 reason 的机会。
    const failedFile = detectCredentials({
        env: {}, home: 'x', readFile: () => { throw new Error('sk-读失败秘密'); },
    });
    assert.equal(failedFile.ok, false);
    assert.equal(JSON.stringify(failedFile).includes('读失败秘密'), false,
        'readFile 抛出的错误文本不许出现在返回值里');
});

test('忘了注入 readFile 时不许谎报"没配凭证"(探针接错线要能一眼看出)', () => {
    const r = detectCredentials({ env: {}, home: 'C:\\dsh' });
    assert.equal(r.ok, false);
    assert.equal(r.source, null);
    assert.match(r.reason, /readFile/, '原因里必须点名缺的是 readFile');
    assert.doesNotMatch(r.reason, /没有找到 DeepSeek 凭证/,
        '调用方接错了线,不能对用户说成"你没配凭证"');
});

test('忘了给 home 时不许拿 env.DSH_HOME 顶替 —— 那会给出一个关于**别的家**的结论', () => {
    // 本机实测:进程 env 里的 DSH_HOME 是 harness 自己的家(那里**有** .credentials.yaml),
    // 而 kaiwu 的家没有。旧实现会回落到那个 env,于是这个模块给出一个关于
    // "agent 根本不会用的家"的 verdict —— 在这台机器上就是一句**假**的"没凭证"。
    // home 缺了就是调用方接错线,跟缺 readFile 同一类,不是"用户没配"。
    const r = detectCredentials({
        env: { DSH_HOME: 'C:\\别的家' },
        readFile: () => '',
    });
    assert.equal(r.ok, false);
    assert.equal(r.source, null);
    assert.match(r.reason, /home/, '原因必须点名缺的是 home');
    assert.doesNotMatch(r.reason, /没有找到 DeepSeek 凭证/,
        '调用方接错了线,不能对用户说成"你没配凭证"');
    assert.equal(r.reason.includes('C:\\别的家'), false, '不许把那个"别的家"写进原因里');
});

test('home 传空串/数字与不传是同一件事:都是调用方接错线,不许悄悄用一个空 home', () => {
    for (const home of [undefined, null, '', '   ', 123]) {
        const r = detectCredentials({
            env: { DEEPSEEK_API_KEY: 'sk-x' },
            home,
            readFile: () => '',
        });
        assert.equal(r.ok, false, `home=${JSON.stringify(home)} 应当判为接错线而不是给出结论`);
        assert.equal(r.source, null);
        assert.equal(typeof r.reason, 'string');
        assert.match(r.reason, /home/);
    }
});

// ---------------------------------------------------------------------------
// Important 5:ready ≠ 凭证配好了
// 真实流程是 initialize OK → session/new OK → prompt 报 -32603 "no API key",
// 而监护人**仍然**是 ready。不做这个判定,面板会渲染"已连接",
// 然后让用户面对一个没有解释的失败。
// ---------------------------------------------------------------------------

/** 造一个 acp-client 那种形状的错误:消息带原始文案,code 是结构化字段。 */
const acpErr = (code, message) => Object.assign(new Error(`ACP 错误 ${code}:${message}`), { code });

test('认出"没有 API key"这种 -32603 —— 真实流程里 prompt 就是这样失败的', () => {
    // 对端的措辞是它自己的事,但都要落在"凭证缺失"这一件事上。
    for (const message of [
        'no API key configured',
        'No API key found',
        'api key is not set',
        'DEEPSEEK_API_KEY not set',
        'missing credentials',
        'credentials are not configured',
        '没有找到 API key',
        '未配置密钥',
    ]) {
        assert.equal(isMissingCredentialError(acpErr(-32603, message)), true, message);
    }
});

test('不许吞掉别的 -32603 —— 那些不是"凭证缺失"', () => {
    // 工具炸了、模型报错这类同样是 -32603,但用户要做的事完全不同。
    assert.equal(isMissingCredentialError(acpErr(-32603, '工具执行失败')), false);
    assert.equal(isMissingCredentialError(acpErr(-32603, 'no network: credentials service unreachable')), false,
        '不能只要一句话里同时出现否定词和 credential 就算(会把网络故障误判成没配钥匙)');
    assert.equal(isMissingCredentialError(acpErr(-32603, 'api key 无效')), false,
        '"无效"是另一回事:钥匙在、只是不对,给用户的下一步是另一句话');
    assert.equal(isMissingCredentialError(acpErr(-32603, 'invalid API key')), false);

    // 文案再像,错误码不对也不是这个判定管的事:
    assert.equal(isMissingCredentialError(acpErr(-32000, 'no API key')), false);
    // 契约外输入一律 false,不许抛
    assert.equal(isMissingCredentialError(new Error('no API key')), false, '没有 code 的普通 Error 不算');
    assert.equal(isMissingCredentialError(null), false);
    assert.equal(isMissingCredentialError(undefined), false);
    assert.equal(isMissingCredentialError('no API key'), false);
});

test('resolveKaiwuDshHome 解析出来的那个家,就是 detectCredentials 要检查的家', () => {
    // "一个地方解析、显式传给两边":spawn 与凭证检测必须拿到同一个字符串,
    // 否则就是"agent 能用、界面却说没凭证"。
    const home = resolveKaiwuDshHome({ env: {}, appData: 'C:\\appdata' });
    const seen = [];
    const r = detectCredentials({
        env: {}, home, readFile: (p) => { seen.push(p); return 'deepseek:\n  apiKey: sk-yyy\n'; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'file');
    assert.deepEqual(seen, [path.join(home, '.credentials.yaml')]);
});

test('契约外的 env/home(null、非字符串)只给中文原因,不许抛', () => {
    // env 传 null 只是"用 process.env",这不是错;home 传 null/数字则是**调用方接错了线**,
    // 它必须落在一句能看的 reason 上,不能是 TypeError 崩在 path.join(那还在 try 之外)。
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
        const r = detectCredentials({
            env: null, home: null, readFile: () => { throw new Error('ENOENT'); },
        });
        assert.equal(r.ok, false);
        assert.equal(r.source, null);
        assert.equal(typeof r.reason, 'string');
        assert.match(r.reason, /home/, 'home 缺了必须点名它(见上面那条:不许回落到 env.DSH_HOME)');
        assert.doesNotMatch(r.reason, /没有找到 DeepSeek 凭证/,
            '接错线不能对用户说成"你没配凭证"');
    } finally {
        if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
        else process.env.DEEPSEEK_API_KEY = saved;
    }

    // home 不是字符串时曾经会崩在 path.join 上(而且在那道 try 之外)。
    const badHome = detectCredentials({ env: {}, home: 123, readFile: () => '' });
    assert.equal(badHome.ok, false);
    assert.equal(typeof badHome.reason, 'string');
});
