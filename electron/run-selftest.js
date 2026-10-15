// electron.exe 是 GUI 子系统程序,stdout 不回父控制台,退出码也拿不到。
// 这个纯 Node 包装器负责:拉起 → 等待 → 读结果文件 → 打印 → 透传退出码。
// 具体的拉起方式(二进制路径、摘掉 ELECTRON_RUN_AS_NODE 等)统一在 launch.js 里。
//
// 传 --acceptance 时会额外跑验收用例(设计文档 §14 的标准 5 与 6)。
// 那组用例需要在 plugins/ 下放临时夹具,所以在**拉起之前**建好、结束之后删掉,
// 无论自检通过还是失败都不会把夹具留在仓库里。
import fs from 'node:fs';
import path from 'node:path';
import { launch, ROOT, TIMEOUT_CODE } from './launch.js';

const RESULT_FILE = path.join(ROOT, 'selftest-result.txt');
const PLUGIN_DIR = path.join(ROOT, 'plugins');
const acceptance = process.argv.includes('--acceptance');

// ---- Agent 夹具 ----
// 自检**绝不**拉起真 dsh:它要凭证、要联网、冷启动有 10 秒级抖动(M3-A 实测),
// 而"发一条提示,界面上出现回复"这条验收必须**确定性**地跑。
// 用 M3-A 的假 agent 夹具:真子进程、真 stdio、零凭证、零联网。
// --tool-call / --permission 两个开关让 M3 的工具卡片与权限卡片也能被断言。
// 经环境变量传给主进程(launch 会把环境原样透传),主进程的 resolveAgentCommand
// 优先认它 —— 于是自检期间永远不会有真 dsh 被拉起来。
const AGENT_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'fake-acp-agent.mjs');
process.env.KAIWU_AGENT_SCRIPT = AGENT_FIXTURE;
// --echo-prompt 让夹具把"它收到的提示原文"回显一条,自检因此能断言
// 「界面真的把当前笔记的上下文发出去了」,而不是只看界面自己画了什么。
// --thought 让它先推一段思考 —— 自检据此断言思考收成**一条**折叠条、正文一到自动收起。
// --markdown 让正文里带上 Markdown 与一段不可信的 HTML —— 自检据此端到端断言
// "助手回复被排版成元素、而模型给的标签仍然只是文字"。
// --question 再补一次"提问"(toolCall.kind='question')—— 自检据此断言界面画的是
// **提问卡**而不是授权卡,而且点选项真的回到了 agent 那一侧。
process.env.KAIWU_AGENT_ARGS = '--tool-call --permission --echo-prompt --thought --markdown --question';

// 等待上限自己声明,不吃 launch 的默认值 —— 那是另一个文件的常量,它一改这里就跟着变,
// 而「多久算挂死」是这份包装器自己的判定,不能由别的文件替它决定。
//
// ⚠️ 2026-09 从 60s 提到 120s。依据:加了短剧画布那一组断言(10 条)之后,自检实际耗时
// 约 70-80 秒 —— 那几条要在真窗口里等面板渲染、等引擎跑图、还要切视图再切回来,
// 都是真实的异步等待,不是空转。60s 会让"用例本身很慢"和"真的挂死"混在一起,
// 于是每次运行都被杀在半路、连结果文件都写不出来(排查时踩过)。
//
// ⚠️ 2026-09 再提到 300s。依据(本轮实测,同一台机器):
//   · `npm run selftest`(323 项):窗口在合成时 ~50s;机器被占满时最长 ~196s;
//   · `npm run selftest:acceptance`(359-362 项):126s / 142s / 196s 三次都没跑完 120s,
//     被包装器**杀在半路**、连结果文件都没有 —— 而它本身是绿的(只是慢)。
//   "慢"与"挂死"必须分开:这条上限是"多久算挂死",不是"多久算太慢"。300s 对上面这些
//   实测留了 1.5 倍余量;真挂了(例如窗口起不来)仍然会被它拦住。
const SELFTEST_TIMEOUT_MS = 300000;

// 结果文件缺失有两种原因,不能都说成「进程自己死了」:超时那次是我们杀的。
const DIED_HINT = '(没有结果文件 —— 进程可能在写入前就死了)';
const TIMEOUT_HINT = `(没有结果文件 —— 等待超过 ${Math.round(SELFTEST_TIMEOUT_MS / 1000)} 秒,被包装器超时强制结束)`;

// ---- 验收夹具 ----
// 只在 --acceptance 下存在。文件名带 acceptance 前缀,便于一眼看出是临时物。
const PROBE_NAME = 'acceptance-probe.tool.js';
const BROKEN_DIR = 'acceptance-broken';

// 一个完全合法、但仓库里原本没有的单文件插件:
// 用它验证"往 plugins/ 丢一个文件就能用,不需要改任何其它文件"。
const PROBE_SOURCE = `export default {
    manifest: {
        id: 'accprobe',
        name: '验收探针',
        version: '1.0.0',
        description: '验收标准 5 用的临时单文件插件',
    },
    activate(ctx) {
        ctx.tools.register({
            id: 'accprobe',
            title: '验收探针',
            icon: 'sparkle',
            order: 5000,
            workspacePane: true,
            panel: '<div class="tool-block"><h3>验收探针</h3></div>',
        });
    },
};
`;

// 清单非法(panel 指向插件目录之外),用来验证坏插件被隔离且错误可见。
const BROKEN_MANIFEST = JSON.stringify({
    id: 'accbroken',
    name: '坏插件夹具',
    version: '1.0.0',
    contributes: {
        tools: [{ id: 'accbroken', title: '坏', icon: 'i', panel: '../evil.html' }],
    },
}, null, 2);

function writeFixtures() {
    fs.writeFileSync(path.join(PLUGIN_DIR, PROBE_NAME), PROBE_SOURCE);
    fs.mkdirSync(path.join(PLUGIN_DIR, BROKEN_DIR), { recursive: true });
    fs.writeFileSync(path.join(PLUGIN_DIR, BROKEN_DIR, 'plugin.json'), BROKEN_MANIFEST);
    fs.writeFileSync(path.join(PLUGIN_DIR, BROKEN_DIR, 'index.js'),
        'export default { activate() {} };\n');
}

function removeFixtures() {
    for (const p of [
        path.join(PLUGIN_DIR, PROBE_NAME),
        path.join(PLUGIN_DIR, BROKEN_DIR, 'plugin.json'),
        path.join(PLUGIN_DIR, BROKEN_DIR, 'index.js'),
    ]) {
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch { /* 清理尽力而为,不该影响自检结论 */ }
    }
    try {
        fs.rmdirSync(path.join(PLUGIN_DIR, BROKEN_DIR));
    } catch { /* 目录非空或不存在都无所谓 */ }
}

fs.rmSync(RESULT_FILE, { force: true });
if (acceptance) writeFixtures();

// 这里显式传 stdio: 'ignore':结果只走结果文件、不依赖控制台,也正是为了在受限沙箱里
// 避开管道的 EPERM —— 批处理不需要(也不该)继承控制台。库的默认值是 'inherit',不适用。
// 缺二进制、spawn 失败、超时都会让 launch 拒绝,同样要留下输出,不能只是静默退出。
const args = [ROOT, '--selftest'];
if (acceptance) args.push('--acceptance');

let code = 1;
let timedOut = false;
try {
    code = await launch(args, {
        stdio: 'ignore',
        timeoutMs: SELFTEST_TIMEOUT_MS,
    });
} catch (error) {
    timedOut = error.code === TIMEOUT_CODE;
    process.stderr.write(`${error.message}\n`);
} finally {
    if (acceptance) removeFixtures();
}

const text = fs.existsSync(RESULT_FILE)
    ? fs.readFileSync(RESULT_FILE, 'utf8')
    : (timedOut ? TIMEOUT_HINT : DIED_HINT);
process.stdout.write(text + '\n');
// 用 exitCode 而不是 process.exit():后者可能截断还没冲洗干净的 stdout 管道,
// 而这里的结果正是通过管道被上层(如测试框架)捕获的。
process.exitCode = code;
