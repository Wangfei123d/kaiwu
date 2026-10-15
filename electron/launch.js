// 统一的 Electron 启动器:解析二进制路径 → 清理环境变量 → 拉起 → 透传退出码。
// 既能被 `node electron/launch.js` 直接跑(供 npm start 用),也能被 import 复用。
//
// 为什么需要它:本机的工具会话里 `node` 可能是包装脚本(如 node.cmd),它会
// `set ELECTRON_RUN_AS_NODE=1`。该变量被 electron.exe 继承后会退化成纯 Node:
// 没有 app、窗口起不来、require('electron') 只拿到 npm 包的路径字符串,于是
// `npm start` 变成静默无效。这里显式摘掉变量,普通终端下则没有副作用。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Windows 下是 electron.exe,其余平台是 electron 可执行文件(解包目录里的那个)。
export const ELECTRON_BIN = path.join(
    ROOT,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
);

// 批处理场景的默认超时:Electron 挂死时不能让调用方既没有输出也没有退出码。
const LAUNCH_TIMEOUT_MS = 60000;

// 二进制缓存放在仓库的父目录(仓库根),不写死本机路径 —— 换台机器也能照着提示走。
const CACHE_DIR = path.resolve(ROOT, '..', '.electron-cache');

// 超时错误的 code,让调用方能区分「被我们杀掉」与「进程自己死了」。
export const TIMEOUT_CODE = 'LAUNCH_TIMEOUT';

// 缺二进制时抛错,而不是在这里 process.exit —— 退出码由各入口自己决定。
// 注意:electron@44.4.1 的 package.json 里根本没有 scripts 字段,`npm install`
// 不会去跑 install.js,所以二进制必须再手动补第二步,两步缺一不可。
// 这段文案与 README「首次装依赖」的命令块是同一份内容,改一处要改两处。
function requireElectronBin() {
    if (fs.existsSync(ELECTRON_BIN)) return;
    throw new Error(
        `找不到 Electron 二进制:${ELECTRON_BIN}\n`
        + '请先装依赖并补装 Electron 二进制(两步缺一不可):\n'
        + `    cd "${ROOT}"\n`
        + `    $env:electron_config_cache = "${CACHE_DIR}"   # 必须是小写这个名字\n`
        + '    $env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"\n'
        + '    npm install\n'
        + '    node node_modules\\electron\\install.js',
    );
}

// 摘掉 ELECTRON_RUN_AS_NODE,其余环境变量原样透传。
export function cleanEnv(env = process.env) {
    const copy = { ...env };
    delete copy.ELECTRON_RUN_AS_NODE;
    return copy;
}

// 拉起 Electron 并等待它结束,返回真实退出码(GUI 子系统程序拿不到码时兜底为 1)。
// stdio 默认 'inherit':那是父控制台的句柄而不是管道,不受沙箱 EPERM 影响,而且启动失败
// (import 报错、whenReady 里抛异常)时默认就该让人看见 —— 默认值替调用方吞掉错误输出,
// 正是这一轮在修的那类缺陷。需要静默的调用方(run-selftest.js)必须显式传 'ignore'。
// 声明成 async:二进制缺失与 spawn 失败统一走 Promise 拒绝,由入口决定退出码。
// options.timeoutMs 传 0 表示不设超时 —— 交互式运行(窗口开多久由用户决定)不能用它。
export async function launch(args = [], options = {}) {
    requireElectronBin();
    const timeoutMs = options.timeoutMs ?? LAUNCH_TIMEOUT_MS;
    const child = spawn(ELECTRON_BIN, args, {
        stdio: options.stdio ?? 'inherit',
        env: cleanEnv(options.env),
        cwd: options.cwd ?? ROOT,
    });

    return new Promise((resolve, reject) => {
        const timer = timeoutMs > 0
            ? setTimeout(() => {
                child.kill();
                const error = new Error(`Electron 启动超时(${Math.round(timeoutMs / 1000)} 秒),已强制结束进程`);
                error.code = TIMEOUT_CODE;
                reject(error);
            }, timeoutMs)
            : null;

        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code ?? 1);
        });
    });
}

export function isDirectRun(argv1 = process.argv[1]) {
    return Boolean(argv1) && import.meta.url === pathToFileURL(argv1).href;
}

// 直接作为入口运行时就是 `npm start`:把命令行多余参数转交给应用。
// stdio 与默认值一样是 'inherit',这里仍然显式写出来:这是开发者最常用的命令,
// 启动失败时要能直接看到堆栈,而不是只拿到一句「退出码 1」。同时关掉超时 —— 这是交互式运行,
// 窗口开多久由用户决定,定时杀掉一个正常运行的实例才是 bug。
if (isDirectRun()) {
    try {
        process.exitCode = await launch(
            [ROOT, ...process.argv.slice(2)],
            { stdio: 'inherit', timeoutMs: 0 },
        );
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
