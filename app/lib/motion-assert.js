// 动效断言的**纯函数**部分:切 CSS 块、读计算样式的角度。
//
// 为什么抽到 app/lib:自检(selftest.js)跑在 Electron 里,一次 30-60 秒,
// 而这些判据本身是纯计算 —— 放在自检里就只能靠"跑一次真应用"来验证,
// 于是"这条断言有没有牙"永远说不清。抽出来以后,它和内核其它安全关键件
// 一样可以 `node --test` 直跑(项目一条既有约定:纯逻辑放 app/lib)。

/**
 * 去掉 CSS 注释(`/*` 到 `*/`),并用**空格**等长占位(不是删掉)。
 *
 * 为什么要留等长占位:调用方按"找到 @media 之后从这里往后数大括号"来切片,
 * 直接把注释删掉会让后面的下标整体前移,切出来的就是错位的垃圾。
 * 占位成空格则让下标与原文**一一对应** —— 这一点比"省几个字节"重要得多。
 *
 * 为什么不假装是解析器:字符串字面量里的 `/*` 会被误判成注释。CSS 里那几乎
 * 只出现在 content: 属性上,而本文件只服务自检的媒体查询/规则判据,
 * 误判方向也是"找不到块"(判红),不会假绿。
 *
 * @param {string} css
 * @returns {string} 与入参**等长**、注释已被空格替换的文本
 */
function blankCssComments(css) {
    let out = '';
    let i = 0;
    while (i < css.length) {
        if (css[i] === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            // 注释没闭合:按到结尾处理(同样等长占位)
            const stop = end === -1 ? css.length : end + 2;
            out += ' '.repeat(stop - i);
            i = stop;
            continue;
        }
        out += css[i];
        i++;
    }
    return out;
}

/**
 * 取出**所有**匹配某个媒体查询的块,按出现顺序返回。
 *
 * 为什么需要它:一个样式表里可以有**多个** `@media (prefers-reduced-motion: reduce)`
 * 块 —— 各自贴着自己管的那段规则(分隔条的、图标的、流式动效的)。只取第一个会漏掉
 * 后面的,而断言里"找不到规则"就等于"这条规则没写"(假红)。实测踩到过:
 * 分隔条那个块排在前面,于是后面流式动效的免责规则永远读不到。
 *
 * @param {string} css
 * @param {string} conditionSubstring 例如 'prefers-reduced-motion'
 * @returns {string[]} 块内容(不含 @media 前导与最外层大括号)
 */
export function extractAllMediaBlocks(css, conditionSubstring) {
    const text = String(css ?? '');
    const out = [];
    let from = 0;
    for (;;) {
        const rest = text.slice(from);
        const block = extractMediaBlock(rest, conditionSubstring);
        if (block === null) break;
        out.push(block);
        const at = rest.indexOf(block);
        if (at < 0) break;                       // 不该发生;真发生了就停,别死循环
        from += at + block.length;
    }
    return out;
}

/**
 * 从样式表文本里切出某个 `@media (...)` 块的**内容**(不含 @media 前导与最外层大括号)。
 *
 * 为什么必须按大括号配对切片:用正则"从这里往后找某条声明"会跨过块边界 ——
 * 块里少一条规则照样匹配得上,那条断言就成了摆设(实测:删掉媒体查询里的
 * `.icon-plus { transition: none; }`,旧正则依然通过)。
 *
 * 为什么先抹掉注释:被注释掉的媒体查询不是媒体查询。现在 base.css 里只有 1 条
 * `@media`,所以碰不到;但谁顺手把一段含 @media 的 CSS 注释掉,旧实现就会把
 * CSS 注释符之间的碎片当块内容交回去 —— 方向是判红(安全),但红得指向错误的地方。
 *
 * @param {string} css
 * @param {string} conditionSubstring 例如 'prefers-reduced-motion'
 * @returns {string|null} 块内容;找不到或大括号不配对返回 null(不猜)
 */
export function extractMediaBlock(css, conditionSubstring) {
    // 占位替换后下标与原文一一对应,所以切出来的可以直接是原始文本(带原来的换行)
    const text = blankCssComments(String(css ?? ''));
    const re = new RegExp(`@media[^{]*${conditionSubstring}[^{]*\\{`, 'i');
    const m = re.exec(text);
    if (!m) return null;

    const start = m.index + m[0].length;
    let depth = 1;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i);
        }
    }
    return null;
}

/**
 * 把一段 CSS 文本拆成 `{ selector, body }` 列表(一层块结构)。
 *
 * 只用来找媒体查询里的普通规则,不假装是个解析器:嵌套块会被平铺,
 * 选择器带上 '@media …' 前缀。够用即可。
 *
 * @param {string|null} css
 * @returns {Array<{selector:string, body:string}>}
 */
export function parseCssRules(css) {
    if (typeof css !== 'string' || css === '') return [];
    const out = [];
    let i = 0;
    while (i < css.length) {
        const open = css.indexOf('{', i);
        if (open === -1) break;
        const selector = css.slice(i, open).split('}').pop().trim();
        let depth = 1;
        let j = open + 1;
        for (; j < css.length && depth > 0; j++) {
            if (css[j] === '{') depth++;
            else if (css[j] === '}') depth--;
        }
        const body = css.slice(open + 1, depth === 0 ? j - 1 : css.length);
        if (selector !== '') out.push({ selector, body });
        i = j;
    }
    return out;
}

/** 计算样式是不是"没有变换" —— 那正是**未悬停时的终态**(不是"过渡中途"。见下)。 */
export function transformIsIdentity(value) {
    const raw = String(value ?? '').trim();
    if (raw === '' || raw === 'none') return true;
    // 六元矩阵:没有旋转、没有缩放/斜切时,剩下的自由分量只有平移(e、f)。
    // 为什么必须接受纯平移:悬停态哪天加了位移,移开后的终态就是
    // `matrix(1, 0, 0, 1, tx, ty)` —— 它就是"回到原状",旧判据只认字面 identity
    // 会把它判成"还在变换",于是那条断言误报失败(方向安全,但会把断言变成噪音)。
    return matrixIsPureTranslation(raw) !== null;
}

/**
 * 解析 `matrix(a, b, c, d, e, f)`,判断它是不是"无旋转、无缩放/斜切,只有平移"。
 *
 * 判据与 transformAngleDeg 同源(同一套 a~d 检查),这样"是终态吗"与"转了多少度"
 * 不会各说各话。认不出的形态返回 null,由调用方各自决定是"不猜"还是"判红"。
 *
 * @param {string} raw 已 trim
 * @returns {{tx:number, ty:number}|null}
 */
function matrixIsPureTranslation(raw) {
    const m = /^matrix\(([^)]+)\)$/.exec(raw);
    if (!m) return null;                        // matrix3d 等形态不在本自检的判据内
    const parts = m[1].split(',').map(p => Number(p.trim()));
    if (parts.length !== 6 || parts.some(n => !Number.isFinite(n))) return null;
    const [a, b, c, d, e, f] = parts;
    if (Math.abs(a - 1) > 0.01 || Math.abs(b) > 0.01
        || Math.abs(c) > 0.01 || Math.abs(d - 1) > 0.01) return null;
    return { tx: e, ty: f };
}

/**
 * 把 `getComputedStyle().transform` 解析成**角度**(度)。
 *
 * 为什么要角度而不是"字符串不等于 none":`transform` 带 `.18s ease` 过渡,
 * 读数落在中途会拿到 `matrix(0.363334, 0.931659, …)`(约 68°)这种中间值 ——
 * 它既不是 none,也远没转到 90°。"非 none 即通过"会把中间态判成通过(空转通过),
 * 于是那条断言其实从未验证"转到了 90°"。
 *
 * @param {string} value
 * @returns {number|null} 纯旋转时的角度;`none`、matrix3d、纯平移、或带缩放/斜切时返回 null
 */
export function transformAngleDeg(value) {
    const raw = String(value ?? '').trim();
    if (raw === '' || raw === 'none') return null;
    const m = /^matrix\(([^)]+)\)$/.exec(raw);
    if (!m) return null;                        // matrix3d 等形态不在本自检的判据内
    const parts = m[1].split(',').map(p => Number(p.trim()));
    if (parts.length !== 6 || parts.some(n => !Number.isFinite(n))) return null;
    const [a, b, c, d] = parts;
    // 先确认它是**纯旋转**:缩放/斜切会让角度变成一个好看但没意义的数
    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    if (Math.abs(scaleX - scaleY) > 0.01) return null;
    // 两列正交 ⟺ 没有斜切(a*c + b*d 是两列的点积)
    if (Math.abs(a * c + b * d) > 0.01) return null;
    // 有**实际位移**的纯平移没有旋转可言 —— 与 transformIsIdentity 共用同一份解析,
    // 否则"是终态吗"说"没有变换"、"转了多少度"却说 0°,两处判据会互相打架。
    // 而单位矩阵(位移恰为 0)保留既有契约:它仍是 0°(既有用例钉着这一点)。
    const translation = matrixIsPureTranslation(raw);
    if (translation !== null && (translation.tx !== 0 || translation.ty !== 0)) return null;
    const deg = Math.atan2(b, a) * 180 / Math.PI;
    return Math.abs(deg) < 0.01 ? 0 : deg;
}

/** 角度的人类可读形态(给结果文件看 —— 失败时一眼能看出差多少度)。 */
export function formatAngle(deg) {
    return deg === null ? '无旋转' : `${deg.toFixed(1)}°`;
}