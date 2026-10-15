import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DSH_ENTRY_REL,
    NO_NODE_REASON,
    agentCommandFailureReason,
    dshEntryCandidates,
    isFixtureCommand,
    isWrapperScript,
    resolveAgentCommand,
    resolveDshEntry,
    resolveNodeExecutable,
} from '../app/lib/agent-command.js';

// 这一整个文件都是**纯函数**用例:存在性由注入的 exists 回答,所以不用碰真实文件系统,
// 也不必在乎本机装了什么。这正是这个模块被拆出来的理由 ——
// "找错 node / 找错 dsh"的表现是「零输出、秒退」,那种故障没法靠读日志定位。

/** 只认这些路径,其余一律"不存在"。 */
const only = (...present) => (p) => present.includes(p);

const WIN_ENV = {
    PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
    ProgramFiles: 'C:\\Program Files',
};

// ---------------------------------------------------------------------------
// resolveNodeExecutable
// ---------------------------------------------------------------------------

test('KAIWU_NODE 显式指定时优先用它', () => {
    const node = resolveNodeExecutable({
        env: { ...WIN_ENV, KAIWU_NODE: 'D:\\nodejs\\node.exe' },
        exists: only('D:\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\node.exe'),
        platform: 'win32',
    });
    assert.equal(node, 'D:\\nodejs\\node.exe');
});

test('PATH 里的 node.exe 命中就直接用', () => {
    const node = resolveNodeExecutable({
        env: WIN_ENV,
        exists: only('C:\\Program Files\\nodejs\\node.exe'),
        platform: 'win32',
    });
    assert.equal(node, 'C:\\Program Files\\nodejs\\node.exe');
});

test('env 是**普通对象拷贝**时,键名大小写不许把 PATH 搜索整段吃掉', () => {
    // 这条钉的是本机真踩到的坑:Windows 上 `process.env` 的真实键名是 `Path`,
    // 而调用方(electron/main.js)递进来的常常是 `{ ...process.env, APPDATA: … }`
    // 这样一份**普通对象** —— 它是大小写敏感的,`copy.PATH` 就是 undefined。
    // 后果不是"少找一个候选",而是整段 PATH 搜索被跳过、退化到 %ProgramFiles%
    // 那份更旧的 Node v22:harness 内部靠 `import.meta.main` 自执行的辅助进程
    // (Windows Job runner、ripgrep provider)在 < 24.2 上会**零输出、退出码 0、秒退**,
    // 表现就是 pwsh / glob / grep 全挂,而 read 正常。
    const copy = { Path: 'D:\\DSH Desktop\\resources\\app\\node_modules\\node\\bin', ProgramFiles: 'C:\\Program Files' };
    const node = resolveNodeExecutable({
        env: copy,
        exists: only('D:\\DSH Desktop\\resources\\app\\node_modules\\node\\bin\\node.exe',
            'C:\\Program Files\\nodejs\\node.exe'),
        platform: 'win32',
    });
    assert.equal(node, 'D:\\DSH Desktop\\resources\\app\\node_modules\\node\\bin\\node.exe',
        '`Path` 这个大小写也必须能命中 —— 否则会静默用错 Node');
});

test('dsh 自带的那份 Node 优先于 PATH(它才是 harness 自己跑的那份)', () => {
    const appRoot = 'D:\\DSH Desktop\\resources\\app';
    const bundled = 'D:\\DSH Desktop\\resources\\app\\node_modules\\node\\bin\\node.exe';
    const node = resolveNodeExecutable({
        env: {
            Path: 'C:\\Program Files\\nodejs',
            ProgramFiles: 'C:\\Program Files',
        },
        exists: only(bundled, 'C:\\Program Files\\nodejs\\node.exe'),
        platform: 'win32',
        appRoot,
    });
    assert.equal(node, bundled, '自带的那份在前面 —— 版本与 harness 一致');
});

test('KAIWU_NODE 仍然压过 dsh 自带的那份(显式指定最高优先级)', () => {
    const appRoot = 'D:\\DSH Desktop\\resources\\app';
    const bundled = 'D:\\DSH Desktop\\resources\\app\\node_modules\\node\\bin\\node.exe';
    const node = resolveNodeExecutable({
        env: { Path: 'C:\\x', KAIWU_NODE: 'D:\\my\\node.exe' },
        exists: only(bundled, 'D:\\my\\node.exe'),
        platform: 'win32',
        appRoot,
    });
    assert.equal(node, 'D:\\my\\node.exe');
});

test('没有 appRoot / 自带那份不存在时,照旧走 PATH', () => {
    const node = resolveNodeExecutable({
        env: { Path: 'C:\\Program Files\\nodejs' },
        exists: only('C:\\Program Files\\nodejs\\node.exe'),
        platform: 'win32',
    });
    assert.equal(node, 'C:\\Program Files\\nodejs\\node.exe');
    const noRoot = resolveNodeExecutable({
        env: { PATH: 'C:\\Program Files\\nodejs' },
        exists: only('C:\\Program Files\\nodejs\\node.exe'),
        platform: 'win32',
        appRoot: 'D:\\DSH Desktop\\resources\\app',
    });
    assert.equal(noRoot, 'C:\\Program Files\\nodejs\\node.exe', '自带那份不存在时不许卡住');
});

test('PATH 里只有 node.cmd 时**跳过它**,继续往后找', () => {
    // 这条钉的是本机实测踩到的坑:PATH 上的 node 解析到一个
    // `set ELECTRON_RUN_AS_NODE=1` + 指向 Electron 的包装脚本,
    // 拿它跑 dsh 的 bin.js 会「零输出、退出码 0、秒退」。
    const env = {
        PATH: 'C:\\Users\\me\\AppData\\Roaming\\dsh-desktop\\harness\\.desktop-bin',
        ProgramFiles: 'C:\\Program Files',
    };
    const wrapper = 'C:\\Users\\me\\AppData\\Roaming\\dsh-desktop\\harness\\.desktop-bin\\node.cmd';
    assert.equal(isWrapperScript(wrapper), true);
    const node = resolveNodeExecutable({
        env,
        exists: only(wrapper, 'C:\\Program Files\\nodejs\\node.exe'),
        platform: 'win32',
    });
    assert.equal(node, 'C:\\Program Files\\nodejs\\node.exe', '不许把包装脚本当成 node');
});

test('PATH 里只有 node.cmd、且 ProgramFiles 那份也没有时返回 null(不是抛错)', () => {
    const env = { PATH: 'C:\\bin', ProgramFiles: 'C:\\Program Files' };
    const node = resolveNodeExecutable({
        env,
        exists: only('C:\\bin\\node.cmd'),
        platform: 'win32',
    });
    assert.equal(node, null);
});

test('PATH 里一条都不命中时回落到 %ProgramFiles%\\nodejs\\node.exe', () => {
    const node = resolveNodeExecutable({
        env: { PATH: 'C:\\nope', ProgramFiles: 'C:\\Program Files' },
        exists: only('C:\\Program Files\\nodejs\\node.exe'),
        platform: 'win32',
    });
    assert.equal(node, 'C:\\Program Files\\nodejs\\node.exe');
});

test('全都是不存在时返回 null —— 找不到是正常结局,不是异常', () => {
    const node = resolveNodeExecutable({ env: {}, exists: () => false, platform: 'win32' });
    assert.equal(node, null);
});

test('POSIX 上找的是不带扩展名的 node', () => {
    const node = resolveNodeExecutable({
        env: { PATH: '/usr/local/bin:/usr/bin' },
        exists: only('/usr/local/bin/node'),
        platform: 'linux',
    });
    assert.equal(node, '/usr/local/bin/node');
});

test('没有注入 exists 时当场抛错,而不是偷偷摸真实文件系统', () => {
    assert.throws(() => resolveNodeExecutable({ env: {} }), /exists/);
});

// ---------------------------------------------------------------------------
// dsh 入口
// ---------------------------------------------------------------------------

test('DSH_CLI_ENTRY 命中时就是它', () => {
    const entry = resolveDshEntry({
        env: { DSH_CLI_ENTRY: 'X:\\dsh\\bin.js', DSH_HOME: 'C:\\home' },
        exists: only('X:\\dsh\\bin.js', path.join('C:\\home', DSH_ENTRY_REL)),
    });
    assert.equal(entry, 'X:\\dsh\\bin.js');
});

test('没给 DSH_CLI_ENTRY 时按候选清单往后找(带空格的那份也认)', () => {
    const spaced = 'D:/DSH Desktop/resources/app/' + DSH_ENTRY_REL;
    const entry = resolveDshEntry({ env: { DSH_HOME: 'C:\\home' }, exists: only(spaced) });
    assert.equal(entry, spaced);
});

test('DSH_HOME 下的那份也在候选里', () => {
    const home = 'C:\\Users\\me\\AppData\\Roaming\\kaiwu\\dsh-home';
    const inHome = path.join(home, DSH_ENTRY_REL);
    const entry = resolveDshEntry({ env: { DSH_HOME: home }, exists: only(inHome) });
    assert.equal(entry, inHome);
});

test('候选清单里不出现空串(空串去 exists 会得到莫名其妙的结果)', () => {
    const list = dshEntryCandidates({ env: {}, appRoot: '' });
    assert.equal(list.includes(''), false);
    assert.ok(list.length >= 3);
});

test('★ 成套的那份(D:/DSHDesktop/DSH Desktop)必须排在旧的 D:/dsh 前面', () => {
    // 这条是**混装事故**的回归守卫:kaiwu 的启动器 `import { runCli }` 只有 0.1.5 那份
    // 才有;0.1.1 那份没有这个导出、import 时还会自己 boot,连上就 exit 2。
    // 而当时候选清单里两条 Desktop 路径都拼错了(少了 `DSH Desktop` 这一半),
    // 于是**静默**掉到旧的那份 —— 表现是"Agent 连不上",不是"路径写错了"。
    const list = dshEntryCandidates({ env: {}, appRoot: '' });
    const real = 'D:/DSHDesktop/DSH Desktop/resources/app/' + DSH_ENTRY_REL;
    const stale = 'D:/dsh/' + DSH_ENTRY_REL;
    assert.ok(list.includes(real), '本机真实存在的那份必须在候选里');
    assert.ok(list.indexOf(real) < list.indexOf(stale),
        '成套的那份必须先试:旧的 D:/dsh 缺 runCli 导出,连上必崩');
});

test('★ 重新打包后的那份(app.asar.unpacked)必须**排在最前** —— DSH 升级会换掉目录名', () => {
    // 2026-09-29 实测:DSH 桌面版升级后重新打包,`resources\app\` 变成了
    // `resources\app.asar` + `resources\app.asar.unpacked\`,dsh 入口搬进了 unpacked。
    // 旧路径一夜之间全不存在 → 候选清单一路落到 D:/dsh(0.1.1,自 boot 后退出),
    // 用户看到的是 AI 面板 `state=crashed`,而根因只是**一个目录名变了**。
    const list = dshEntryCandidates({ env: {}, appRoot: '' });
    const packed = 'D:/DSHDesktop/DSH Desktop/resources/app.asar.unpacked/' + DSH_ENTRY_REL;
    const oldLayout = 'D:/DSHDesktop/DSH Desktop/resources/app/' + DSH_ENTRY_REL;
    assert.equal(list[0], packed, '新的那份要排第一(它才是升级后真实存在的那个)');
    assert.ok(list.indexOf(packed) < list.indexOf(oldLayout),
        '老安装那条要留着兜底,但必须排在新的后面');
    assert.ok(list.indexOf(packed) < list.indexOf('D:/dsh/' + DSH_ENTRY_REL));
    // 换机器时仍然可以用 DSH_CLI_ENTRY 顶掉一切
    assert.equal(dshEntryCandidates({ env: { DSH_CLI_ENTRY: 'D:\\x\\bin.js' }, appRoot: '' })[0],
        'D:\\x\\bin.js');
});

test('一条都不命中时返回 null', () => {
    assert.equal(resolveDshEntry({ env: { DSH_HOME: 'C:\\h' }, exists: () => false }), null);
});

// ---------------------------------------------------------------------------
// resolveAgentCommand
// ---------------------------------------------------------------------------

test('KAIWU_AGENT_SCRIPT 非空时跑那个脚本,并把 KAIWU_AGENT_ARGS 原样带上', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const env = {
        PATH: 'C:\\Program Files\\nodejs',
        ProgramFiles: 'C:\\Program Files',
        KAIWU_AGENT_SCRIPT: 'E:\\project\\kaiwu\\tests\\fixtures\\fake-acp-agent.mjs',
        // 自检就是这么传的:夹具要开工具卡片与权限卡片两条路
        KAIWU_AGENT_ARGS: '--tool-call --permission',
    };
    const resolved = resolveAgentCommand({ env, exists: only(node), platform: 'win32' });
    assert.equal(resolved.command, node);
    assert.deepEqual(resolved.args, [
        'E:\\project\\kaiwu\\tests\\fixtures\\fake-acp-agent.mjs',
        '--tool-call',
        '--permission',
    ]);
    assert.equal(resolved.reason, 'fixture');
    assert.equal(isFixtureCommand(resolved), true);

    // 多余的空白不该变成空参数(夹具见到空参数会当成未知开关)
    const spaced = resolveAgentCommand({
        env: { ...env, KAIWU_AGENT_ARGS: '  --tool-call   --permission  ' },
        exists: only(node),
        platform: 'win32',
    });
    assert.deepEqual(spaced.args.slice(1), ['--tool-call', '--permission']);
});

test('夹具优先于 dsh:哪怕 dsh 入口一个都找不到也照跑夹具', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const resolved = resolveAgentCommand({
        env: {
            PATH: 'C:\\Program Files\\nodejs',
            ProgramFiles: 'C:\\Program Files',
            KAIWU_AGENT_SCRIPT: 'E:\\fake.mjs',
        },
        exists: only(node),                      // 没有任何 dsh 入口
        platform: 'win32',
    });
    assert.equal(resolved.reason, 'fixture');
});

test('默认(真 agent)形状:node + kaiwu 启动器 + --profile acp', () => {
    const node = 'D:\\nodejs\\node.exe';
    const entry = 'D:/DSH Desktop/resources/app/' + DSH_ENTRY_REL;
    const launcher = 'E:\\project\\kaiwu\\electron\\agent\\dsh-launcher.mjs';
    const resolved = resolveAgentCommand({
        env: { KAIWU_NODE: node, DSH_HOME: 'C:\\home' },
        exists: only(node, entry),
        appRoot: 'E:\\project\\kaiwu',
        launcherPath: launcher,
    });
    assert.equal(resolved.command, node);
    assert.deepEqual(resolved.args, [
        launcher, '--app-root', 'E:\\project\\kaiwu', '--profile', 'acp',
    ]);
    assert.equal(resolved.reason, 'dsh');
    assert.equal(isFixtureCommand(resolved), false);
});

test('没有 appRoot 时不塞一个空的 --app-root 进去', () => {
    const node = 'D:\\nodejs\\node.exe';
    const entry = 'D:' + '/DSHDesktop/resources/app/' + DSH_ENTRY_REL;
    const resolved = resolveAgentCommand({
        env: { KAIWU_NODE: node },
        exists: only(node, entry),
        launcherPath: 'L.mjs',
    });
    assert.deepEqual(resolved.args, ['L.mjs', '--profile', 'acp']);
});

test('找不到 node 时返回 null,并给一句点明 KAIWU_NODE 的中文原因', () => {
    const resolved = resolveAgentCommand({ env: {}, exists: () => false, platform: 'win32' });
    assert.equal(resolved, null);
    const reason = agentCommandFailureReason({ env: {}, exists: () => false, platform: 'win32' });
    assert.equal(reason, NO_NODE_REASON);
    assert.match(reason, /Node/);
    assert.match(reason, /KAIWU_NODE/);
});

test('有 node 但没有 dsh 入口时返回 null,原因里逐个列出候选位置', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const env = { PATH: 'C:\\Program Files\\nodejs', ProgramFiles: 'C:\\Program Files' };
    const resolved = resolveAgentCommand({ env, exists: only(node), platform: 'win32' });
    assert.equal(resolved, null);

    const reason = agentCommandFailureReason({ env, exists: only(node), platform: 'win32' });
    assert.match(reason, /bin\.js/);
    assert.match(reason, /DSH_CLI_ENTRY/);
    // 每一个候选都被列出来 —— 用户照着它去看自己机器上哪一份是对的
    for (const candidate of dshEntryCandidates({ env })) {
        assert.ok(reason.includes(candidate), `原因里应当列出候选:${candidate}`);
    }
});

// ---------------------------------------------------------------------------
// 启动器真的跑得起来(不是纯函数能覆盖的部分)
// ---------------------------------------------------------------------------

const LAUNCHER = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'electron', 'agent', 'dsh-launcher.mjs',
);

test('启动器没有候选命中时以退出码 2 收场,并在 stderr 里逐个列出候选位置', async (t) => {
    // ⚠️ 这一条**只在候选真的全都不存在的机器上**才跑得起来(本机 2026-09-18 就是)。
    // 有 dsh 的机器上跳过,而不是把断言放宽 —— 放宽之后就再也测不到"说清楚"那一半了。
    const { spawn } = await import('node:child_process');
    const probeEnv = {
        ...process.env,
        DSH_CLI_ENTRY: 'C:\\definitely-not-here\\bin.js',
        // ⚠️ 必须清掉继承来的 DSH_HOME:否则"kaiwu 的家"会退化成 harness 自己的家,
        // 而那里**有**一份 dsh —— 候选就命中了,这条会变成在测别的东西。
        DSH_HOME: '',
    };
    const appRoot = 'C:\\definitely-not-here';
    const candidates = dshEntryCandidates({ env: probeEnv, appRoot });
    const existsReal = (p) => { try { return fs.existsSync(p); } catch { return false; } };
    if (resolveDshEntry({ env: probeEnv, appRoot, exists: existsReal }) !== null) {
        t.skip('本机存在 dsh 入口,这条用例只在候选全不存在的机器上有意义');
        return;
    }

    const child = spawn(process.execPath, [LAUNCHER, '--app-root', appRoot], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: probeEnv,
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const code = await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 15000);
        child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
        child.stdin.end();
    });

    assert.equal(code, 2, `没有入口时必须退 2,实际 code=${code},stderr=${err}`);
    for (const candidate of candidates) {
        assert.ok(err.includes(candidate), `stderr 里应当逐个列出候选:${candidate}`);
    }
    assert.match(err, /DSH_CLI_ENTRY/, '要告诉用户还有哪条路可以走');
});

test('启动器自己摘掉 --app-root 再把参数交给 runCli(留着它 dsh 会把 --profile 当内部参数)', async () => {
    // 这一条钉的是**参数转发**:`--app-root` 是启动器自己的开关,而 dsh 的 commander
    // 把"第一个不认识的 token"当成分界 —— 留着它,`--profile acp` 会被当成内部参数
    // 丢掉,于是 boot 不出 acp profile。用假入口把 runCli 看到的 argv 打出来验证。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-launcher-args-'));
    const entry = path.join(dir, 'bin.js');
    fs.writeFileSync(entry,
        'export async function runCli() { process.stdout.write(JSON.stringify(process.argv.slice(2))); }\n',
        'utf8');
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [LAUNCHER, '--app-root', dir, '--profile', 'acp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DSH_CLI_ENTRY: entry },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    const code = await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 15000);
        child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    try {
        assert.equal(code, 0, `启动器应当正常退出,输出=${out}`);
        assert.deepEqual(JSON.parse(out), ['--profile', 'acp'], '--app-root 不许漏给 dsh');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('启动器存在,且不靠 import.meta.main 自执行(那条路在 Node < 24.2 上是死的)', () => {
    const raw = fs.readFileSync(LAUNCHER, 'utf8');
    // 注释里**必须**能提这件事(它正是这个文件存在的理由),所以先剥掉行注释再判。
    const code = raw.split('\n').map((line) => line.replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.match(code, /runCli/, '必须自己 import runCli 再调用');
    assert.doesNotMatch(code, /import\.meta\.main/, '不许依赖 import.meta.main');
    // 能力边界的唯一出口是 agent-env:启动器里绝不许自己拼权限模式
    assert.doesNotMatch(code, /DSH_PERMISSION_MODE/);
});

test('临时目录里的假 dsh 入口能被启动器加载(用 DSH_CLI_ENTRY 指路)', async () => {
    // 这一条**不启动真的 dsh**:假入口自己就是一个 .mjs,启动器只需要
    // "解析路径 → 动态 import → 调 runCli"。于是"启动器那一段接线对不对"
    // 可以脱机验证,不必依赖本机装没装 dsh、也不需要凭证。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-launcher-'));
    const entry = path.join(dir, 'bin.js');
    fs.writeFileSync(entry, 'export async function runCli() { process.stdout.write("runCli-ok\\n"); }\n', 'utf8');

    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [LAUNCHER, '--app-root', dir, '--profile', 'acp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DSH_CLI_ENTRY: entry },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const code = await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 15000);
        child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
    });

    try {
        assert.equal(code, 0, `启动器应当正常退出,stderr=${err}`);
        assert.match(out, /runCli-ok/);
        assert.match(err, /dsh 入口 = /, '命中的入口必须写进 stderr(进日志环)');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});