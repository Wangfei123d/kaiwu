// 原生文件对话框的 filters 收纳。
//
// 为什么单独一个纯模块:filters 是**渲染进程递进来的**,得先洗一遍再用(形状不对的
// 要丢掉,而不是塞给 Electron 让它抛);而"洗干净了没有"这件事只有单测能钉住。
//
// ⚠️ 这里的校验**不是安全边界** —— filters 只影响对话框里默认显示哪些文件,用户照样
// 能切到"全部文件"去选别的,而且选中之后路径仍然由主进程回给渲染进程、由它去读。
// 它挡的是"插件递了一份形状不对的东西,把系统对话框弄崩/弄成空列表"这一类事故。

/** 扩展名只允许这些字符:`*` 单独一个(全部文件)也算合法。 */
const EXT_PATTERN = /^(\*|[a-z0-9][a-z0-9+#-]{0,15})$/i;

/**
 * @param {unknown} raw 渲染进程递上来的 filters
 * @returns {Array<{name:string, extensions:string[]}>} 洗过的;一个都不合法就是空数组
 */
export function sanitizeDialogFilters(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') continue;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (name === '') continue;
        const list = Array.isArray(entry.extensions) ? entry.extensions : [];
        const extensions = [];
        for (const ext of list) {
            if (typeof ext !== 'string') continue;
            // '*.txt' 与 '.srt' 两种写法都收(冒烟测试里就撞到过后一种)
            const clean = ext.trim().replace(/^\*?\./, '').toLowerCase();
            if (!EXT_PATTERN.test(clean)) continue;            // 带分隔符/空格的直接丢
            if (!extensions.includes(clean)) extensions.push(clean);
        }
        if (extensions.length === 0) continue;                 // 空 extensions 的过滤器对 Electron 无意义
        out.push({ name, extensions });
    }
    return out;
}
