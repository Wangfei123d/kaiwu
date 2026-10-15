// 把 Markdown 正文切成"块"。纯函数,可直接 node --test。
//
// 为什么要切块:编辑器要做到"光标所在的那一块是源码,其余都是渲染结果"
// (接近 Obsidian 的实时预览)。要做到这一点,必须能把正文切成可独立渲染与
// 独立替换的片段,而且要能给出每段在原文里的**精确区间** —— 替换时只动那一段,
// 绝不重排整个文件(重排会丢掉用户的书写细节,比如列表符号是 - 还是 *)。
//
// ⚠️ 分块单位是**行**,不是段落。这一点是刻意的,也是踩过坑之后才定下来的:
//   早先按"空行分隔的段落"分块,于是连续两行属于同一块 —— 在编辑器里按回车
//   只是在块内插了个换行,上一行**仍然显示为源码**,用户看到的现象是
//   "按了回车不渲染,得用鼠标点一下才渲染"。
//   改成一行一块之后:回车 = 在这一行后面新起一行(新行自己就是一块),
//   上一行立刻渲染;上下方向键 = 跳到上一块/下一块。这也正是"每一行都是一个块"。
//
// 只有两种东西必须跨行成块,否则渲染会坏:
//   1. 围栏代码块 —— 切开的话每一行都会被当成独立 markdown,围栏自己变成一段文字
//   2. 表格       —— 表头 / 分隔行 / 数据行必须一起交给渲染器
//
// 空行**也是一块**(零长度区间)。不能跳过它:那样"光标停在一个空行上"就没法
// 表示,按回车新起的那一行也就没地方放。
//
// 每个块都带 start/end(在原文中的字符区间)与 text;区间不含行尾换行
// (换行是块与块之间的分隔符,不属于任何一块)。

/**
 * 把正文切成块(一行一块;代码块与表格跨行)。
 *
 * @param {string} body - 不含 frontmatter 的正文
 * @param {{plain?:boolean}} [options] `plain:true` = **纯文本**正文(见 splitTextBlocks)
 * @returns {Array<{start:number,end:number,text:string,type:string,line:number}>}
 */
export function splitBlocks(body, options = {}) {
    // ⚠️ 纯文本模式:围栏代码块与表格这两条**跨行成块**的规则必须关掉。
    //    .txt 里的 ``` 和 | 就是三个反引号与一根竖线,把它们当 Markdown 结构去合并行,
    //    用户会看到"改一行却动了三行"。其余规则(一行一块、空行一块、区间精确)照旧 ——
    //    编辑器那套"光标所在块是源码、其余是渲染结果"完全靠区间,不能分两套实现。
    const plain = options.plain === true;
    const text = String(body ?? '');
    if (text === '') return [];

    const lines = [];
    // 记录每行的起始偏移,便于算区间
    let offset = 0;
    for (const raw of text.split('\n')) {
        lines.push({ text: raw, start: offset });
        offset += raw.length + 1;             // +1 是换行符
    }

    const blocks = [];
    let i = 0;

    const lineEnd = (idx) => lines[idx].start + lines[idx].text.length;

    while (i < lines.length) {
        const line = lines[i].text;

        // 1) 围栏代码块:整体一块,内部不切
        const fence = plain ? null : /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            const marker = fence[1][0];
            const startLine = i;
            let j = i + 1;
            while (j < lines.length) {
                if (new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[j].text)) { j++; break; }
                j++;
            }
            blocks.push(makeBlock(lines, startLine, j - 1, 'code', lineEnd));
            i = j;
            continue;
        }

        // 2) 表格:当前行含 | 且下一行是分隔行 → 整张表一块
        if (!plain && line.includes('|') && i + 1 < lines.length
            && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].text)) {
            let j = i + 2;
            while (j < lines.length && lines[j].text.includes('|') && lines[j].text.trim() !== '') j++;
            blocks.push(makeBlock(lines, i, j - 1, 'table', lineEnd));
            i = j;
            continue;
        }

        // 3) 空行:自己一块,区间是零长度的插入点
        if (line.trim() === '') {
            blocks.push({
                start: lines[i].start,
                end: lines[i].start,
                text: '',
                type: 'blank',
                line: i + 1,
            });
            i++;
            continue;
        }

        // 4) 其余:一行一块。纯文本一律 paragraph —— 连"这行像不像标题"都不猜,
        //    否则 # 开头的 txt 会被套上标题样式,那正是"要和 Markdown 隔开"要避免的。
        blocks.push(makeBlock(lines, i, i, plain ? 'paragraph' : lineType(line), lineEnd));
        i++;
    }

    return blocks;
}

/**
 * 纯文本正文切块(= splitBlocks 关掉 Markdown 结构规则)。
 *
 * 为什么仍然复用同一套块模型:编辑器靠"每块一个精确区间"做到只重写改动的那一行,
 * 纯文本这条路上这个能力一样要,而且**必须是同一份实现** —— 两套区间算法迟早分叉。
 * 不同的只有两点:不合并围栏/表格,类型一律 paragraph。
 * @param {string} body
 */
export function splitTextBlocks(body) {
    return splitBlocks(body, { plain: true });
}

/** 单行的类型。只用于样式与将来的键位细化,不影响区间计算。 */
function lineType(line) {
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) return 'list-item';
    if (/^#{1,6}\s/.test(line)) return 'heading';
    if (/^\s*>/.test(line)) return 'quote';
    if (isThematicBreak(line)) return 'hr';
    return 'paragraph';
}

function makeBlock(lines, fromLine, toLine, type, lineEnd) {
    return {
        start: lines[fromLine].start,
        end: lineEnd(toLine),
        text: lines.slice(fromLine, toLine + 1).map(l => l.text).join('\n'),
        type,
        line: fromLine + 1,                 // 1 起,便于报错与跳转
    };
}

/** 分隔线:--- / *** / ___ 之类(至少三个同样的符号) */
export function isThematicBreak(line) {
    return /^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line);
}

/**
 * 找到包含指定字符偏移的块下标。找不到返回 -1。
 * 注意空行块是零长度区间,所以"偏移正好落在某个空行块上"能命中它。
 * @param {Array} blocks
 * @param {number} offset
 */
export function blockIndexAt(blocks, offset) {
    for (let i = 0; i < blocks.length; i++) {
        if (offset >= blocks[i].start && offset <= blocks[i].end) return i;
    }
    return -1;
}

/**
 * 用新文本替换某一块,返回新的正文。
 *
 * 只动那一段:[start, end) 被 newText 取代,其余原样保留 ——
 * 所以不会重排用户的书写细节(列表符号、缩进风格都保持)。
 *
 * 空行块(start === end)是插入点:替换它就等于"把这一行写成 newText"。
 *
 * @param {string} body
 * @param {{start:number,end:number}} block
 * @param {string} newText
 * @returns {string}
 */
export function replaceBlock(body, block, newText) {
    const text = String(body ?? '');
    return text.slice(0, block.start) + String(newText ?? '') + text.slice(block.end);
}

/**
 * 光标落在哪一块 —— 编辑器用它决定"哪一块显示源码"。
 * 位置按"最后一个 start <= offset 的块"判断,并允许落在块尾的换行上。
 *
 * @param {Array} blocks
 * @param {number} offset
 */
export function blockIndexForCaret(blocks, offset) {
    if (blocks.length === 0) return -1;
    let found = -1;
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].start <= offset) found = i;
        else break;
    }
    return found;
}
