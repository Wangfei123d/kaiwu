// 短剧项目根的判定。主进程与渲染进程共用同一份口径(渲染进程那边只用来显示)。
//
// 为什么单独一个纯模块:这条规则决定了"项目落在哪",而它的失败模式是
// **静默落到一个错误的目录** —— 出问题时人已经在别处找原因了。所以把判据收敛到
// 一处、用单测钉住(与 app/lib/service-root.js 同一个理由)。
//
// 口径:
//   · 笔记库路径必须是**绝对路径**且非空 → 根 = <笔记库>/短剧;
//   · 没配笔记库 / 路径不是绝对的 → 拒绝,并给出可读的原因。
//
// ⚠️ 为什么**拒绝**而不是退回一个默认目录:短剧项目必须跟着笔记库一起备份、
// 同步、进版本控制("放在笔记库旁边"就是这条决策的全部意义)。退回一个默认目录
// 会让项目悄悄落到笔记库之外 —— 那正是这条决策要避免的事。
import path from 'node:path';

/** 项目根在笔记库里的目录名。 */
export const DRAMA_DIR_NAME = '短剧';

/**
 * @param {string|null|undefined} vaultPath 当前笔记库的绝对路径
 * @returns {{root:string|null, reason:string}} root 为 null 表示"现在不能用"
 */
export function resolveDramaRoot(vaultPath) {
    const raw = typeof vaultPath === 'string' ? vaultPath.trim() : '';
    if (raw === '') {
        return { root: null, reason: '还没有配置笔记库 —— 短剧项目要落在它旁边' };
    }
    if (!path.isAbsolute(raw)) {
        return { root: null, reason: `笔记库路径不是绝对路径(${raw}),拒绝把项目落在不确定的位置` };
    }
    return { root: path.join(raw, DRAMA_DIR_NAME), reason: '' };
}

/**
 * 把一个**项目名**变成安全的目录名。
 *
 * 与引擎里那份 slug 同口径(引擎也有一份,因为它不依赖宿主):保留中日韩文字与
 * 字母数字,其余一律换成下划线,再把开头那几个点去掉 —— 目录名以点开头会让它
 * 在笔记树的"跳过隐藏项"规则里消失。
 *
 * @param {unknown} value
 */
export function slugProjectName(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    const cleaned = raw
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
        .slice(0, 60)
        .replace(/^[._]+/, '');
    return cleaned === '' ? 'default' : cleaned;
}
