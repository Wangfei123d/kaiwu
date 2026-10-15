// 服务根目录的**唯一解析点**:设置 > 内置默认。
//
// 为什么要单独一个纯函数(而不是留在 electron/main.js 里):
//   · 它决定"服务从哪儿拉起来"—— spec.cwd 与相对命令都按它解析,写错的表现是
//     "服务起不来/起错目录",而报错往往在几十行之外;
//   · 设置页现在能改它,于是"空值/非法值怎么办"必须有**一处**说得清的口径,
//     并且要被单测钉住(自检一次 30-60 秒,不适合验这条)。
//
// 口径:
//   · 设置里是**绝对路径** → 用它,来源记 'settings';
//   · 空 / 不是字符串 / 相对路径 → 一律退回内置默认值,来源记 'default'
//     (相对路径**故意**不当根:path.resolve 会拿进程 cwd 去补,而 cwd 是用户随时
//      能换的笔记库 —— 同一个设置在不同库里指向不同目录,是最难查的那种错)。
import path from 'node:path';

/**
 * @param {{configured?:unknown, fallback?:string, isAbsolute?:Function}} [deps]
 * @returns {{root:string, source:'settings'|'default', reason:string}}
 */
export function resolveServiceRoot({ configured, fallback, isAbsolute = path.isAbsolute } = {}) {
    const def = typeof fallback === 'string' ? fallback.trim() : '';
    const raw = typeof configured === 'string' ? configured.trim() : '';
    if (raw === '') return { root: def, source: 'default', reason: '' };
    if (isAbsolute(raw) !== true) {
        return { root: def, source: 'default', reason: `设置里的服务根目录不是绝对路径(${raw}),已退回默认` };
    }
    return { root: raw, source: 'settings', reason: '' };
}
