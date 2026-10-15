// 「怎么把 Agent 拉起来」这一件事的**纯函数**实现:找 Node、找 dsh 入口、拼命令行。
//
// 为什么要单独一个纯模块:这三件事都会因机器而异(装在哪、PATH 长什么样、
// DSH 的家在哪),而它们又**没法在跑起来之后补救** —— 找错 node 的表现是
// 「零输出、秒退」,找错 dsh 的表现是「连不上、没有原因」。所以它们必须能被
// `node --test` 直接构造出来测,而不是等踩到某台机器上才发现。
//
// ⚠️ 这个文件**不碰真实文件系统**:存在性一律由注入的 `exists` 回答。
// 真正的起进程在 `app/lib/agent-env.js` 的 `createAgentSpawn`(read-only 唯一出口),
// 这里只负责"命令长什么样"。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** dsh 的 CLI 入口在包里的相对路径。 */
export const DSH_ENTRY_REL = 'node_modules/@deepseek-ai/dsh/lib/bin.js';

/**
 * 本机的 dsh 入口候选清单(按优先级)。
 *
 * 顺序**有意为之**:`D:/DSH Desktop/...` 那一份(0.1.5-rc.2)与 kaiwu 专用
 * DSH_HOME 里建好的 `acp` profile 对齐;`D:/dsh` 那份版本旧(0.1.1-rc.2),
 * 去引它只会撞版本。`DSH_CLI_ENTRY` 永远排第一 —— 换机器时用它指路,
 * 不用改代码。
 *
 * @param {{env?:object, appRoot?:string}} [deps]
 * @returns {string[]}
 */
export function dshEntryCandidates({ env, appRoot } = {}) {
    const e = env ?? {};
    const home = typeof e.DSH_HOME === 'string' ? e.DSH_HOME.trim() : '';
    return [
        typeof e.DSH_CLI_ENTRY === 'string' ? e.DSH_CLI_ENTRY.trim() : '',
        // ⚠️ 必须排在最前面的是**本机真正存在**的那一份,而它之所以是硬条件,是因为
        //    它"成套":dsh / dsh-cmdline / dsh-acp-app / dsh-app-boot 同为 0.1.5-rc.2。
        //    为什么"成套"非要有:kaiwu 的启动器 `import { runCli }` 就是照 0.1.5 写的
        //    (那份 bin.js 末尾是 `export { runCli }`);而 `D:/dsh` 那份是 **0.1.1** ——
        //    它**没有 runCli 导出**、而且 import 时就会自己 boot,于是必然报
        //    「plugin tree failed to load / … the launcher must provide ctx.appExit and
        //    ctx.appReady …」再 exit 2。根子是**混装**:旧 boot(0.1.1)不传 ready,
        //    而 acp profile 的行来自新的 dsh-cmdline(0.1.5),新的那句判定缺一即抛。
        // ⚠️ 路径写法本身也踩过:`DSHDesktop` 与 `DSH Desktop` 是**同一个目录名的两半**,
        //    真实路径是 `D:\DSHDesktop\DSH Desktop\resources\…`;下面那两条历史猜测
        //    (都不带这个组合)**在本机并不存在**,留着只为换机器时还能顶上来。
        //
        // ⚠️ 2026-09-29 DSH 桌面版升级后**重新打包**过:`resources\app\` 变成了
        //    `resources\app.asar` + `resources\app.asar.unpacked\`,而 dsh 那份入口
        //    现在躺在 **app.asar.unpacked** 里。旧路径一夜之间全不存在,于是清单一路
        //    落到 `D:/dsh`(0.1.1,import 就自 boot 然后退出)—— 用户看到的是
        //    AI 面板 `state=crashed`,而根因只是**一个目录名变了**。
        //    两条都留:老安装(未重新打包)仍然走下面那条。
        'D:/DSHDesktop/DSH Desktop/resources/app.asar.unpacked/' + DSH_ENTRY_REL,
        'D:/DSHDesktop/DSH Desktop/resources/app/' + DSH_ENTRY_REL,
        'D:/DSHDesktop/resources/app/' + DSH_ENTRY_REL,
        'D:/DSH Desktop/resources/app/' + DSH_ENTRY_REL,
        'D:/dsh/' + DSH_ENTRY_REL,
        home === '' ? '' : path.join(home, DSH_ENTRY_REL),
        typeof appRoot === 'string' && appRoot !== '' ? path.join(appRoot, DSH_ENTRY_REL) : '',
        path.join(process.cwd(), DSH_ENTRY_REL),
    ].filter((p) => p !== '');
}

/**
 * 按候选清单找 dsh 的 bin.js。
 * @param {{env?:object, exists?:(p:string)=>boolean, appRoot?:string}} deps
 * @returns {string|null}
 */
export function resolveDshEntry({ env, exists, appRoot } = {}) {
    if (typeof exists !== 'function') {
        throw new Error('resolveDshEntry 需要 exists(路径存在性判断)—— 这个模块不碰真实文件系统');
    }
    for (const candidate of dshEntryCandidates({ env, appRoot })) {
        try {
            if (exists(candidate)) return candidate;
        } catch { /* 某一条探不动就当它不存在,别让整个解析炸掉 */ }
    }
    return null;
}

/** 路径分隔符。用 platform 判断而不是 path.sep:测试要能构造另一套平台。 */
function sepOf(platform) {
    return platform === 'win32' ? '\\' : '/';
}

/** 拼一个目录下的可执行文件名。 */
function joinDir(dir, name, platform) {
    if (dir === '') return name;
    const sep = sepOf(platform);
    const trimmed = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir;
    return `${trimmed}${sep}${name}`;
}

/**
 * 这个候选是不是「包装脚本」而不是真正的 node。
 *
 * ⚠️ 本机实测踩过:PATH 上的 `node` 解析到
 * `%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd`,那是一个
 * `set ELECTRON_RUN_AS_NODE=1` + 指向 **Electron** 的包装脚本 —— 拿它去跑
 * dsh 的 bin.js 会得到「零输出、退出码 0、秒退」,极难排查。
 * 所以要跳过 .cmd / .bat / .ps1 这类转发脚本,只认真正的 node 可执行文件。
 */
export function isWrapperScript(p) {
    return /\.(cmd|bat|ps1)$/i.test(String(p ?? ''));
}

/**
 * 从一个可能**只是普通对象**的 env 上按"大小写不敏感"取一个值。
 *
 * ⚠️ 为什么必须有它(本机踩到的大坑):Windows 的环境变量名是大小写不敏感的,
 * `process.env` 自己也一样 —— 它的真实键名是 **`Path`**。可调用方递进来的常常是
 * 一份**拷贝**(典型是 `electron/main.js` 的 `{ ...process.env, APPDATA: … }`),
 * 而普通对象是**大小写敏感**的:`copy.PATH` 于是是 `undefined`。
 * 这一下不是小毛病 —— 它让下面整段 PATH 搜索被静默跳过,直接退化到
 * `%ProgramFiles%\nodejs\node.exe`(本机是 Node v22.17.0),而 PATH 第一位其实是
 * DSH 自带的 Node v24.9.0。用 v22 跑 Agent 的后果是:harness 内部那些靠
 * `import.meta.main` 自执行的辅助进程(Node < 24.2 上它是 undefined)会
 * **零输出、退出码 0、秒退** —— 表现就是 pwsh / glob / grep 这些要起子进程的工具
 * 全挂(`Windows Job runner exited with exit code 0…`、`ripgrep provider failure`),
 * 而 read 这种不起进程的工具照常。查了很久才落到这一行上。
 */
function envValue(env, name) {
    if (env === null || typeof env !== 'object') return undefined;
    const direct = env[name];
    if (typeof direct === 'string') return direct;
    const lower = name.toLowerCase();
    for (const key of Object.keys(env)) {
        if (key.toLowerCase() === lower && typeof env[key] === 'string') return env[key];
    }
    return undefined;
}

/**
 * 找一个真正的 Node 可执行文件。
 *
 * 为什么要单独找:Electron 里 `process.execPath` 是 **electron.exe** 而不是 node,
 * 拿它去跑一个 Node 脚本等于把整个应用再启动一次(而且不会执行那个脚本)。
 *
 * 优先级(与计划一致):
 *   1. `env.KAIWU_NODE`(显式指定,换机器时用)
 *   2. **dsh 自带的那份 node**(`<appRoot>/node_modules/node/bin/node.exe`)——
 *      为什么它排在 PATH 前面:harness 自己的辅助进程是按它那份 Node 写的
 *      (本机 v24.9.0),而系统 PATH 上常常是更旧的 v22 —— 详见 envValue 的说明。
 *   3. PATH 里逐个目录找 `node.exe`(Windows)/ `node`(POSIX),**跳过包装脚本**
 *   4. `%ProgramFiles%\nodejs\node.exe`
 *
 * 返回 string 或 null —— 找不到是**正常结局**,不是异常:面板要把它变成一句中文。
 *
 * @param {{env?:object, exists?:(p:string)=>boolean, platform?:string, appRoot?:string}} deps
 * @returns {string|null}
 */
export function resolveNodeExecutable({ env, exists, platform, appRoot } = {}) {
    if (typeof exists !== 'function') {
        throw new Error('resolveNodeExecutable 需要 exists(路径存在性判断)—— 这个模块不碰真实文件系统');
    }
    const e = env ?? {};
    const plat = platform ?? process.platform;
    const name = plat === 'win32' ? 'node.exe' : 'node';

    const ok = (p) => {
        const s = typeof p === 'string' ? p.trim() : '';
        if (s === '' || isWrapperScript(s)) return false;
        try { return exists(s) === true; } catch { return false; }
    };

    const explicit = envValue(e, 'KAIWU_NODE');
    if (ok(explicit)) return String(explicit).trim();

    // dsh 自带的那份 —— 与它自己跑的是同一个 Node,最不容易出"辅助进程秒退"
    if (typeof appRoot === 'string' && appRoot !== '') {
        const bundled = joinDir(
            joinDir(joinDir(joinDir(appRoot, 'node_modules', plat), 'node', plat), 'bin', plat),
            name, plat);
        if (ok(bundled)) return bundled;
    }

    const pathValue = envValue(e, 'PATH') ?? '';
    const separator = plat === 'win32' ? ';' : ':';
    for (const raw of pathValue.split(separator)) {
        const dir = raw.trim().replace(/^"(.*)"$/, '$1');
        if (dir === '') continue;
        // Windows 的 PATH 里习惯把 `node.exe` 写成裸 `node`(PATHEXT 展开),
        // 所以两种写法都试一遍。
        for (const candidateName of (plat === 'win32' ? [name, 'node'] : [name])) {
            const candidate = joinDir(dir, candidateName, plat);
            if (ok(candidate)) return candidate;
        }
    }

    const programFiles = (envValue(e, 'ProgramFiles') ?? '').trim();
    if (programFiles !== '') {
        const candidate = joinDir(joinDir(programFiles, 'nodejs', plat), name, plat);
        if (ok(candidate)) return candidate;
    }

    return null;
}

/** 找不到 node 时给用户看的中文原因(面板会显示它)。 */
export const NO_NODE_REASON =
    '找不到 Node 可执行文件。开物需要真正的 node 来运行 Agent 子进程(Electron 自带的 '
    + 'process.execPath 是 electron.exe,不能顶替)。请安装 Node 22+,或用环境变量 KAIWU_NODE 指定 node 的绝对路径。';

/** 找不到 dsh 入口时给用户看的中文原因(面板会显示它)。 */
export function noDshReason({ env, appRoot } = {}) {
    return '找不到 @deepseek-ai/dsh 的 lib/bin.js。找过这些位置:\n  '
        + dshEntryCandidates({ env, appRoot }).join('\n  ')
        + '\n可以用环境变量 DSH_CLI_ENTRY 直接指定入口。';
}

/** `KAIWU_AGENT_ARGS`:空格分隔的额外参数,不做引号解析(自检就是这么传的)。 */
function extraAgentArgs(env) {
    const raw = typeof env.KAIWU_AGENT_ARGS === 'string' ? env.KAIWU_AGENT_ARGS : '';
    return raw.split(/\s+/).filter((s) => s !== '');
}

/**
 * 拼出把 Agent 拉起来用的那条命令。
 *
 * 优先级(契约,不许改):
 *   1. `KAIWU_AGENT_SCRIPT` 非空 → 跑那个脚本(自检用的假 agent,零凭证),
 *      `args = [脚本, ...KAIWU_AGENT_ARGS]`,`reason: 'fixture'`
 *   2. 否则 → 走 kaiwu 自己的启动器 `electron/agent/dsh-launcher.mjs`,
 *      `args = [启动器, '--app-root', appRoot, '--profile', 'acp']`,`reason: 'dsh'`
 *   3. node 找不到 / dsh 入口找不到 → 返回 `null`(调用方把 reason 显示给用户)
 *
 * ⚠️ 真 dsh 那条路**必须**经过启动器,不能直接 `node bin.js`:
 * 本机真实 Node 是 v22.17.0,而 `bin.js` 的自执行判据是 `import.meta.main` ——
 * 它在 Node < 24.2 上是 `undefined`,于是直接跑 bin.js 会「零输出、退出码 0、秒退」。
 * 启动器自己 `import { runCli }` 再调用,不依赖那条自执行判据(见 .agent-probe/dsh-run.mjs)。
 *
 * @param {{env?:object, exists?:(p:string)=>boolean, appRoot?:string, launcherPath?:string}} deps
 * @returns {{command:string, args:string[], reason:string}|null}
 */
export function resolveAgentCommand({ env, exists, appRoot, launcherPath } = {}) {
    const e = env ?? {};
    // ⚠️ appRoot 要一起递进去:优先用 dsh 自带的那份 Node(见 resolveNodeExecutable)
    const node = resolveNodeExecutable({ env: e, exists, appRoot });

    const script = typeof e.KAIWU_AGENT_SCRIPT === 'string' ? e.KAIWU_AGENT_SCRIPT.trim() : '';
    if (script !== '') {
        if (node === null) return null;      // 夹具也是拿 node 跑的:没有 node 一样起不来
        return { command: node, args: [script, ...extraAgentArgs(e)], reason: 'fixture' };
    }

    if (node === null) return null;
    // 入口解析放在这里(而不是只留给启动器)是为了**能提前说话**:面板拿到的会是一句
    // 点名了所有候选位置的中文,而不是"子进程退出了,退出码 2"。
    if (resolveDshEntry({ env: e, exists, appRoot }) === null) return null;

    const launcher = typeof launcherPath === 'string' && launcherPath !== ''
        ? launcherPath
        : path.join(path.dirname(fileURLToPath(import.meta.url)),
            '..', '..', 'electron', 'agent', 'dsh-launcher.mjs');

    const args = [launcher];
    if (typeof appRoot === 'string' && appRoot !== '') args.push('--app-root', appRoot);
    args.push('--profile', 'acp');
    return { command: node, args, reason: 'dsh' };
}

/**
 * 把 `resolveAgentCommand` 的失败变成一句能显示给用户的中文。
 * 成功时返回 null。
 */
export function agentCommandFailureReason({ env, exists, appRoot } = {}) {
    const resolved = resolveAgentCommand({ env, exists, appRoot });
    if (resolved !== null) return null;
    const e = env ?? {};
    if (resolveNodeExecutable({ env: e, exists }) === null) return NO_NODE_REASON;
    return noDshReason({ env: e, appRoot });
}

/** 测试与「面板要不要显示重试」用得到:这个命令是不是自检夹具。 */
export function isFixtureCommand(resolved) {
    return resolved !== null && typeof resolved === 'object' && resolved.reason === 'fixture';
}