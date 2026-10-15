// Wiki 链接与标签的解析。纯函数:不碰 DOM、不碰文件系统,可直接 node --test。
//
// 为什么值得单独成模块并写足测试:这是笔记子系统里最容易出错的一层。
// 链接/标签要从**文本流**里认出来,而文本里到处是陷阱:
// 代码块里的 [[不是链接]]、注释里的 #不是标签、行内代码里的 # 也是字面量。
// 认错了的后果不是报错,而是**静默建出错误的链接关系** —— 比崩溃更难发现。

/**
 * 去掉正文里的代码区域(围栏代码块与行内代码),用等长空白占位。
 *
 * 为什么用等长空白而不是删除:调用方拿到的下标要能对应**原始文本**的位置
 * (反链面板要能跳到那一行、编辑器要高亮)。删字符会让所有后续下标错位。
 *
 * @param {string} text - 原始 markdown
 * @returns {string} 等长、但代码区域被抹成空白的文本
 */
export function maskCode(text) {
    if (typeof text !== 'string' || text === '') return '';

    const blank = (s) => s.replace(/[^\n]/g, ' ');
    let out = '';

    // 按行处理,便于识别围栏
    const lines = text.split('\n');
    let fence = null;                 // 当前围栏的标记(``` 或 ~~~),null 表示不在围栏内

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);

        if (fence === null && fenceMatch) {
            fence = fenceMatch[1][0];     // 记下是 ` 还是 ~
            out += blank(line);
        } else if (fence !== null && fenceMatch && fenceMatch[1][0] === fence) {
            fence = null;
            out += blank(line);
        } else if (fence !== null) {
            out += blank(line);           // 围栏内部整体抹掉
        } else {
            out += line;
        }
        if (i < lines.length - 1) out += '\n';
    }

    // 行内代码:`code`,同样等长抹掉(不跨行)
    out = out.replace(/(`+)([^\n]*?)\1/g, (m) => blank(m));

    return out;
}

/**
 * 解析所有 wiki 链接。
 *
 * 支持的写法:
 *   [[笔记名]]                 普通链接
 *   [[笔记名|显示文字]]         别名
 *   [[笔记名#小节]]             指向小节
 *   [[笔记名#小节|显示文字]]    两者兼有
 *   [[笔记名^块引用]]           块引用
 *   ![[笔记名]]                嵌入
 *
 * @param {string} text - markdown 正文
 * @returns {Array<{raw:string,target:string,alias:string|null,heading:string|null,
 *                  block:string|null,embed:boolean,index:number,line:number}>}
 */
export function parseWikilinks(text) {
    if (typeof text !== 'string' || text === '') return [];

    const masked = maskCode(text);
    const results = [];

    // ![[...]] 与 [[...]]:先匹配带 ! 的,避免把 ![[x]] 认成嵌入之外的东西
    const re = /(!?)\[\[([^\[\]\n]+)\]\]/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
        const embed = m[1] === '!';
        const body = m[2];

        // 别名:最后一个 | 之后是显示文字(笔记名里通常不含 |)
        let core = body;
        let alias = null;
        const pipeAt = body.lastIndexOf('|');
        if (pipeAt !== -1) {
            core = body.slice(0, pipeAt);
            alias = body.slice(pipeAt + 1).trim();
        }

        // 小节 / 块引用
        let heading = null;
        let block = null;
        const hashAt = core.indexOf('#');
        const caretAt = core.indexOf('^');
        let cutAt = -1;
        if (hashAt !== -1 && (caretAt === -1 || hashAt < caretAt)) {
            cutAt = hashAt;
            heading = core.slice(hashAt + 1).trim() || null;
        } else if (caretAt !== -1) {
            cutAt = caretAt;
            block = core.slice(caretAt + 1).trim() || null;
        }

        const target = (cutAt === -1 ? core : core.slice(0, cutAt)).trim();

        results.push({
            raw: m[0],
            target,
            alias,
            heading,
            block,
            embed,
            index: m.index,
            line: lineOf(masked, m.index),
        });
    }

    return results;
}

/**
 * 解析标签。
 *
 * 两类来源:
 *   1. frontmatter 里的 tags 字段(由调用方传入,已解析好的数组)
 *   2. 正文里的 #标签
 *
 * 正文标签的规则(与 Obsidian 一致的部分):
 *   - # 前面必须是行首或空白,否则 `abc#tag` 不算(那是 URL 片段或颜色值)
 *   - 不能是纯数字(`#123` 通常是编号,不是标签)
 *   - 允许字母/数字/下划线/连字符/斜杠(斜杠表示层级:#项目/开物)
 *   - 支持中文
 *
 * @param {string} text - markdown 正文
 * @param {string[]} [frontmatterTags] - frontmatter 里已解析的标签
 * @returns {string[]} 去重后的标签(保持首次出现顺序,不含 # 前缀)
 */
export function parseTags(text, frontmatterTags = []) {
    const seen = new Set();
    const out = [];

    const push = (tag) => {
        const t = String(tag).trim().replace(/^#/, '');
        if (t === '' || seen.has(t)) return;
        seen.add(t);
        out.push(t);
    };

    for (const t of frontmatterTags ?? []) push(t);

    if (typeof text === 'string' && text !== '') {
        const masked = maskCode(text);
        const re = /(^|[\s(])#([^\s#,，。、；;：:（）()\[\]{}"'`]+)/g;
        let m;
        while ((m = re.exec(masked)) !== null) {
            const tag = m[2];
            if (tag === '') continue;
            // 纯数字不当标签(#1 通常是编号)
            if (/^\d+$/.test(tag)) continue;
            // 必须是"值的开始":以字母/汉字/下划线开头
            if (!/^[\p{L}_]/u.test(tag)) continue;
            push(tag);
        }
    }

    return out;
}

/**
 * 从正文里抽出标题(H1–H6),用于索引与「指向小节」的链接解析。
 * @param {string} text
 * @returns {Array<{level:number,text:string,line:number,slug:string}>}
 */
export function parseHeadings(text) {
    if (typeof text !== 'string' || text === '') return [];
    const masked = maskCode(text);
    const out = [];
    const lines = masked.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
        if (!m) continue;
        const title = m[2].trim();
        out.push({
            level: m[1].length,
            text: title,
            line: i + 1,
            slug: slugify(title),
        });
    }
    return out;
}

/**
 * 生成与 Obsidian 兼容的标题锚点:小写、空格转连字符、去掉标点。
 * 中文保留(Obsidian 也保留)。
 * @param {string} heading
 * @returns {string}
 */
export function slugify(heading) {
    return String(heading)
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-');
}

/**
 * 计算某个下标落在第几行(1 起)。
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
export function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text[i] === '\n') line++;
    }
    return line;
}

/**
 * 归一化链接目标,用于匹配笔记文件名。
 *
 * 规则:去首尾空白、去掉 .md 后缀、把反斜杠统一成正斜杠、大小写不敏感。
 * 「大小写不敏感」是刻意的:Windows 文件系统本来就大小写不敏感,
 * 若这里敏感,同一个笔记会因 [[Note]] 与 [[note]] 被算成两篇。
 *
 * @param {string} target
 * @returns {string}
 */
export function normalizeLinkTarget(target) {
    return String(target ?? '')
        .trim()
        .replace(/\.md$/i, '')
        .replace(/\\/g, '/')
        .toLowerCase();
}
