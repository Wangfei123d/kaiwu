// IPC 桥的唯一入口。
//
// 这个模块是整套隔离的关键,所以值得说清楚它为什么长这样:
//
// 1. 预加载用 contextBridge.executeInMainWorld 把桥**作为参数**交给主世界。
//    (不能用 exposeInMainWorld —— 它建的属性不可写也不可配置,严格模式下
//    连 `delete` 带赋值都会抛 TypeError,桥会永久留在 window 上。已实测。)
// 2. 这里立刻把它收进模块作用域,并把临时全局删掉。
// 3. 于是主世界里不存在任何指向桥的全局名字;只有 import 了本模块的代码
//    才拿得到它 —— 而插件永远不 import 本模块:插件只拿到外壳传给它的 ctx。
//
// 注意本模块必须在任何其他模块**之前**求值:临时全局在它执行完就被删了。
// shell/main.js 第一行 import 它,ES 模块的深度优先求值保证了这一点。
const captured = window.__kaiwuBridgeTemp;
delete window.__kaiwuBridgeTemp;

if (!captured || typeof captured.invoke !== 'function') {
    // 早失败、早报错,而不是等到第一次 IPC 调用时才莫名失败
    throw new Error('IPC 桥交接失败:预加载没有把桥交过来');
}

export const bridge = captured;
