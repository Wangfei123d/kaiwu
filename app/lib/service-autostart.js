// 「随应用启动」的决策。抽成纯函数是因为它必须**只有一处实现**:
// 启动时是否真的拉起服务、以及界面上显示的"随应用启动"状态,两边都得用同一个
// 判断 —— 否则会出现"服务真的起来了、勾选框却是空的"这种界面在撒谎的情况
// (这个坑真踩过:当时界面只看设置,不看清单)。
//
// 优先级(设计文档 §9):用户设置 > 清单声明 > 默认(不自动启动)。
// 注意 override 判断用的是 `=== true/false` 而不是真值判断 ——
// 设置里存的是 JSON,null/undefined 表示"用户没表过态",必须与 false 区分开。
//
// 现在底部那条服务状态条已经去掉,override 暂时没有界面入口;
// 但键名与优先级先定在这里,设置页(设计文档 §6.1)接上时直接用。

export function shouldAutoStart(spec, override) {
    if (override === true) return true;
    if (override === false) return false;
    return spec?.autoStart === true;
}

/** 设置里存该服务覆盖值用的键名。集中在这里,免得主进程和界面各写一遍字符串。 */
export function autoStartKey(serviceId) {
    return `service.${serviceId}.autoStart`;
}
