// dsh 的**启动器**:kaiwu 起真 Agent 时真正执行的那个脚本。
//
// 为什么需要它(而不是直接 `node <dsh>/lib/bin.js --profile acp`):
//   bin.js 末尾是 `if (import.meta.main) await runCli()`,而 `import.meta.main`
//   是 Node **24.2+** 才有的。本机真实 Node 是 v22.17.0(且 PATH 上的 `node`
//   还是个指向 Electron 的包装脚本) —— 直接跑 bin.js 的表现是
//   **零输出、退出码 0、秒退**,现场什么都留不下,极难排查(见 .agent-probe/dsh-run.mjs)。
//   所以这里自己解析绝对路径、自己 `import { runCli }` 再调用,不依赖那条自执行判据。
//
// 它同时是「dsh 入口在哪」的唯一解析点:候选清单来自 app/lib/agent-command.js
// (纯函数,可单测),这里只做真实文件系统那一下。
//
// ⚠️ 它**不碰环境变量**:DSH_HOME 与 read-only 权限模式全部由
// `app/lib/agent-env.js` 的 `createAgentSpawn` 烤进子进程环境 —— 这个文件里
// 绝不许出现 DSH_PERMISSION_MODE 之类的字面量(那是能力边界的唯一出口)。
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dshEntryCandidates, resolveDshEntry } from '../../app/lib/agent-command.js';

function exitWith(message) {
    process.stderr.write(message + '\n');
    process.exit(2);        // 2 = "起不来",与 dsh 自己的退出码区分开
}

// 自己的 `--app-root <dir>` 必须**先摘掉**:runCli() 直接读 process.argv.slice(2),
// 留着它会被 dsh 的 commander 当成未知 token,而那正好是它"后面的参数交给内部 app"的
// 分界 —— `--profile acp` 会被当成内部参数丢掉,于是 boot 不出 acp profile。
let appRoot = '';
const forwarded = [];
for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--app-root') {
        appRoot = process.argv[i + 1] ?? '';
        i += 1;
        continue;
    }
    // 兼容 `--app-root=<dir>`
    if (arg.startsWith('--app-root=')) {
        appRoot = arg.slice('--app-root='.length);
        continue;
    }
    forwarded.push(arg);
}
// runCli() 自己读 process.argv.slice(2),所以摘掉的参数要**真的**从 argv 里去掉。
process.argv = [process.argv[0], process.argv[1], ...forwarded];

const env = process.env;
const entry = resolveDshEntry({
    env,
    exists: (p) => { try { return existsSync(p); } catch { return false; } },
    appRoot,
});

if (entry === null) {
    exitWith(
        '[kaiwu] 找不到 @deepseek-ai/dsh 的 lib/bin.js,Agent 起不来。找过这些位置:\n  '
        + dshEntryCandidates({ env, appRoot }).join('\n  ')
        + '\n可以用环境变量 DSH_CLI_ENTRY 直接指定入口。',
    );
}

// 命中哪一份会写进 stderr:它进 agent-supervisor 的日志环形缓冲,
// 排查"到底连的是哪个 dsh"时这是唯一的一句话。
process.stderr.write(`[kaiwu] dsh 入口 = ${entry}\n`);

let runCli;
try {
    ({ runCli } = await import(pathToFileURL(entry).href));
} catch (err) {
    // ⚠️ 这段是**为下一个人**写的:连错 dsh 版本时的表现完全不像"路径写错了" ——
    //    报的是插件树/换行协议,查半天落不到"入口不对"上(本次就这么查了很久)。
    exitWith(`[kaiwu] 加载 dsh 入口失败:${entry}\n`
        + '  ⚠️ 若下面出现 "plugin tree failed to load" 或 "the launcher must provide ctx.appExit and ctx.appReady",\n'
        + '     多半是**连错了 dsh 的版本**:那一份 bin.js 没有 `export { runCli }`,'
        + '而且 import 时就会自己 boot。\n'
        + '     开物要的是**成套**的那份(与 acp profile 的行来自同一个安装;本机是 '
        + 'D:/DSHDesktop/DSH Desktop/resources/app/…)。\n'
        + `     用 DSH_CLI_ENTRY 指过去,或看 app/lib/agent-command.js 的候选顺序。\n${err?.stack ?? err}`);
}

if (typeof runCli !== 'function') {
    exitWith(`[kaiwu] dsh 入口没有导出 runCli:${entry}\n`
        + '  ⚠️ 这份 dsh 是旧版(0.1.x 早期没有 runCli 导出)。kaiwu 需要成套的那份,'
        + '见 app/lib/agent-command.js 的候选顺序,或用 DSH_CLI_ENTRY 指路。');
}

try {
    await runCli();
} catch (err) {
    // ⚠️ 绝不能只让进程悄悄退出:对端是 stdio 长连接,一个不说话的退出
    // 在界面上就是"连不上,没有原因"。把栈打给 stderr(进日志环)。
    process.stderr.write(`[kaiwu] dsh 运行失败:${err?.stack ?? err}\n`);
    process.exit(3);
}