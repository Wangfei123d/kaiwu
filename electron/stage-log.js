// 启动诊断日志。写成文件而不是只打控制台 ——
// electron.exe 是 GUI 子系统程序,stdout 到不了父控制台,只看控制台就会
// 变成"靠猜"(这个项目为此已绕了好几圈)。自检模式下日志写得最全。
//
// 用法:
//   import { stage, enableStageLog } from './stage-log.js';
//   enableStageLog({ file: '...' });   // 可选,默认写到 userData/stage-log.txt
//   stage('boot:开始');
//
// 设计上很轻:不开诊断时只是一个空函数调用,不影响正常路径。

import fs from 'node:fs';
import path from 'node:path';

let target = null;
let startedAt = Date.now();

/** 打开阶段日志。file 省略时写到 userData 下。 */
export function enableStageLog({ file }) {
    target = file;
    startedAt = Date.now();
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `=== 开物启动诊断 ${new Date().toISOString()} ===\n`, 'utf8');
    } catch {
        target = null;                 // 写不了就退回"只打控制台"
    }
    return target;
}

/** 记录一个阶段。每行立即可见 —— 不要缓冲,否则崩溃时看不到最后一行。 */
export function stage(message) {
    const line = `+${String(Date.now() - startedAt).padStart(6)}ms  ${message}`;
    // 控制台同时留一份,便于 electron 直接跑时肉眼可见
    try { process.stdout.write(line + '\n'); } catch { /* 忽略 */ }
    if (target === null) return;
    try {
        fs.appendFileSync(target, line + '\n', 'utf8');
    } catch { /* 写不进去就算了,不能因为诊断影响主流程 */ }
}

/** 记录一个错误(含堆栈)。 */
export function stageError(where, err) {
    stage(`${where} 抛错: ${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}`);
    const stack = String(err?.stack ?? '').split('\n').slice(0, 6).join('\n    ');
    if (stack) stage('    堆栈: ' + stack);
}

/** 当前日志文件路径(供上层告知用户)。 */
export function stageLogPath() {
    return target;
}
