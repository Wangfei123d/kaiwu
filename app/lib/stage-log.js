// 渲染进程侧的阶段日志。经 IPC 转给主进程写文件。
//
// 为什么不直接用 console.log:主进程虽然能收 console-message,但那是**异步**的,
// 且崩溃/卡死时容易丢最后几行 —— 而最后几行恰恰是排查的关键。
// 走一条专门的 IPC 频道,主进程收到就**同步追加**到文件,顺序与落盘都可靠。
//
// 安全性:复用已有的 IPC 桥(它本身就在模块闭包里),不增加任何新能力 ——
// 只是一个写日志的通道。
import { bridge } from '../shell/bootstrap.js';

let enabled = true;

/** 记录一个阶段。失败绝不抛错 —— 诊断代码不能影响主流程。 */
export function stage(message) {
    if (!enabled) return;
    try {
        // 不 await:日志不该阻塞界面
        bridge.invoke('kaiwu:stage', { message: String(message) }).catch(() => {
            enabled = false;               // 通道不可用就自动闭嘴,别刷屏
        });
    } catch {
        enabled = false;
    }
}

/** 记录一个错误(含堆栈)。 */
export function stageError(where, err) {
    stage(`${where} 抛错: ${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}`);
    const stack = String(err?.stack ?? '').split('\n').slice(0, 6).join(' | ');
    if (stack) stage('    堆栈: ' + stack);
}
