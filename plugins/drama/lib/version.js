// 引擎版本与"还没搬什么"的一句话说明。
//
// 为什么单开一个文件:面板、日志与将来的自检都要读它,而它必须是**纯常量** ——
// 一旦从这里 import 真引擎,骨架就会开始依赖 node:fs(见下面那条注意事项)。
//
// ⚠️ 引擎(lib/core.js 等)用的是 node:fs / node:path,而插件面板跑在**渲染进程**里 ——
// 那边没有 fs。所以引擎不能直接 import 进面板,只能经由主进程的 IPC 通道
// (与笔记子系统同一条路)。这一步在 P1 做,现在面板只报版本。

export const DRAMA_VERSION = '0.2.0';

export const DRAMA_ENGINE_NOTE = '引擎走主进程 IPC(渲染进程没有 fs),P1 接上';
