// 笔记家族的类型判据。**纯逻辑,不碰 fs** —— 渲染进程也要用它
// (笔记列表要按类型决定"点一下是进编辑器还是丢给系统程序")。
//
// 为什么从 vault-path.js 里拆出来:vault-path.js 要 walk 目录、要 node:fs,
// 于是渲染进程根本 import 不了它(沙箱里没有 node)。而"这个路径算不算笔记"这条
// 判据是**两侧都要用**的同一份口径 —— 放在这里,主进程与渲染进程 import 的是同一个函数,
// 不会出现"主进程认、界面不认"的分叉。
//
// ⚠️ 家族里现在有两种**语义完全不同**的东西,不能混:
//   · markdown(.md)—— 有 frontmatter、有 [[wiki 链接]]、有 #标签、按 Markdown 渲染;
//   · text(.txt)    —— **纯文本**:不解析任何 Markdown 语法,不进链接图、不进标签、
//                       不认 frontmatter(开头三个减号就是三个减号)。
//   用户明确要的就是这个隔离:"可编辑,但和 Markdown 隔开"。

/** Markdown 笔记的扩展名(既有语义,不许动)。 */
export const NOTE_EXT = '.md';

/** 纯文本笔记的扩展名。 */
export const TEXT_EXT = '.txt';

/**
 * 一个相对路径属于哪一类。
 * @param {string} relPath
 * @returns {'markdown'|'text'|null} null = 不是笔记家族(图片 / docx / json……)
 */
export function noteKindOf(relPath) {
    if (typeof relPath !== 'string' || relPath === '') return null;
    const low = relPath.toLowerCase();
    if (low.endsWith(NOTE_EXT)) return 'markdown';
    if (low.endsWith(TEXT_EXT)) return 'text';
    return null;
}

/**
 * 是不是笔记家族(两种都算)。
 *
 * ⚠️ 这个名字的历史语义是"能读能写的那种文件",所以**读 / 写 / 改名**三道门都用它;
 *    而"参与 Markdown 语法"的门要用 isMarkdownPath —— 两件事从此分开。
 * @param {string} relPath
 */
export function isNotePath(relPath) {
    return noteKindOf(relPath) !== null;
}

/** 只有 Markdown 笔记:链接图、标签、frontmatter、改标题都只认它。 */
export function isMarkdownPath(relPath) {
    return noteKindOf(relPath) === 'markdown';
}

/** 纯文本笔记。 */
export function isTextPath(relPath) {
    return noteKindOf(relPath) === 'text';
}

/** 给界面看的一行说明(状态栏/提示用)。 */
export function noteKindLabel(kind) {
    if (kind === 'text') return '纯文本';
    if (kind === 'markdown') return 'Markdown';
    return '';
}
