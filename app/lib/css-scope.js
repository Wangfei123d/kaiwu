// 插件样式作用域化。纯函数:输入 CSS 文本,输出加了 [data-plugin="<id>"] 前缀的
// CSS 文本。不碰 DOM、不碰 Node 专属 API,所以能在 node --test 里直接跑。
//
// 这里必须做真正的块结构解析,不能拿正则扫 `[^{}]+\{`:
//   - @media / @supports / @container 这类分组规则的前导不是选择器。
//     给它们加前缀会得到 `[data-plugin=x] @media (…) {…}` 这样的非法选择器,
//     整块被 CSS 解析器**静默丢弃** —— 插件的响应式样式会凭空消失。
//     正确做法是保留前导、递归处理块内内容。
//   - 注释里的半角逗号会被当成选择器分隔符,把一个选择器列表切坏。所以注释整体跳过。
//
// ⚠️ 2026-10-05 修掉的一个真 bug(用户报的"进度条纹不流动"就是它):
//   **紧跟在注释后面的 @rule 会被当成选择器**。`prelude` 里带着前面那段注释,
//   于是 `trimmed` 以 `/*` 开头 —— 三个 `startsWith('@')` / GROUP_AT_RULE 判断全部落空,
//   走进"给选择器加前缀"那条路,产出
//       [data-plugin="bilibili"] /* 注释 */ @keyframes bili-q-bg-drift { … }
//   这**不是**合法 CSS,整条 @keyframes 被解析器丢掉:动画名照样被引用(computed
//   animation-name 还有值、playState 还是 running),但关键帧不存在 →
//   transform 恒为 none → 条纹静止不动。同一条病还会吃掉 `/* 注释 */ @media(…)`。
//   修法:判断分支时用**去掉注释后**的 prelude,输出仍用原样的 prelude。
export function scopeCss(cssText, pluginId) {
    if (typeof cssText !== 'string') return '';
    const scope = `[data-plugin="${pluginId}"]`;

    // 顶层分组规则:前缀保留,内部递归
    const GROUP_AT_RULE = /^@(media|supports|container|layer|scope|document)\b/i;

    /** 去掉注释后的前导:只用来**判断这一块是什么**,输出仍然用原文(注释要留住)。 */
    const bareOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').trim();

    let i = 0;
    let out = '';

    while (i < cssText.length) {
        // 1. 注释整体搬走,不参与选择器切分
        if (cssText.startsWith('/*', i)) {
            const end = cssText.indexOf('*/', i + 2);
            const stop = end === -1 ? cssText.length : end + 2;
            out += cssText.slice(i, stop);
            i = stop;
            continue;
        }

        // 2. 找当前块的边界
        const braceAt = cssText.indexOf('{', i);
        if (braceAt === -1) {
            out += cssText.slice(i);            // 尾部残留(通常只是空白)
            break;
        }

        const prelude = cssText.slice(i, braceAt);
        const closeAt = findMatchingBrace(cssText, braceAt);
        if (closeAt === -1) {
            out += cssText.slice(i);            // 括号不配对,原样保留,不猜
            break;
        }

        const body = cssText.slice(braceAt + 1, closeAt);
        const bare = bareOf(prelude);
        const leading = prelude.slice(0, prelude.length - prelude.trimStart().length);

        if (bare === '') {
            // 前导只有注释/空白:那不是选择器,原样留着(注释必须留住)
            out += prelude + '{' + body + '}';
        } else if (GROUP_AT_RULE.test(bare)) {
            out += prelude + '{' + scopeCss(body, pluginId) + '}';   // 前导不动,内部递归
        } else if (bare.startsWith('@')) {
            out += prelude + '{' + body + '}';                      // @keyframes 等内部不是选择器
        } else if (needsNoScope(bare)) {
            out += prelude + '{' + body + '}';                      // :root / html / body
        } else {
            const trimmed = prelude.trim();
            // ⚠️ 注释**不参与**选择器切分:把它从选择器里摘出来、放到前缀**前面**。
            // 否则"注释里有一个半角逗号"会把选择器列表切坏(`[data-plugin] /* a` +
            // ` b */ .sel` = 两个都不成立的选择器,整条规则被丢弃),而且输出会变成
            // `[data-plugin=x] /* 注释 */ .sel` —— 合法但难看。摘出来之后两个问题一起没了。
            const comments = trimmed.match(/\/\*[\s\S]*?\*\//g) ?? [];
            const selectorText = trimmed.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
            const scoped = selectorText.split(',').map(sel => {
                const s = sel.trim();
                if (s === '') return s;
                return needsNoScope(s) ? s : `${scope} ${s}`;
            }).join(', ');
            const prefix = comments.length > 0 ? `${comments.join(' ')} ` : '';
            out += `${leading}${prefix}${scoped} {${body}}`;
        }

        i = closeAt + 1;
    }

    return out;
}

// 这些选择器描述的是文档根或全局上下文,加插件前缀就没有意义了。
function needsNoScope(selectorText) {
    return /^(:root|html|body)\b/.test(selectorText)
        || selectorText === 'from' || selectorText === 'to'
        || /^\d+(\.\d+)?%$/.test(selectorText);
}

// 从 openAt 处的 '{' 找到与之配对的 '}'。要跳过注释与字符串里的括号,
// 否则插件样式里一句 content: "{" 就会让配对错位。
function findMatchingBrace(text, openAt) {
    let depth = 0;
    let i = openAt;
    while (i < text.length) {
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        const ch = text[i];
        if (ch === '"' || ch === "'") {
            i++;
            while (i < text.length && text[i] !== ch) {
                if (text[i] === '\\') i++;
                i++;
            }
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    return -1;
}
