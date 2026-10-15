/**
 * 页面级 Ctrl+A 守卫的**判据**(纯逻辑,零 DOM 依赖 —— 由 tests/select-all-guard.test.js 钉着)。
 *
 * 为什么需要这道守卫:
 *   正文是**块级**编辑器(一段 = 一个 textarea,见 app/notes/editor.js),跨块选区在 DOM 上
 *   不存在,所以"全选整篇"只能在编辑器那一层自己实现(一个状态 + 一条 CSS 高亮)。上一轮
 *   只处理了"焦点在正文块输入区"这一种情形 —— 那时浏览器的**页面级**默认还留着:焦点不在
 *   任何输入框时按 Ctrl+A,Chromium 会把整个 app 页面(顶栏、笔记列表、AI 对话,连底部那行
 *   布局树读数)全部选上。屏幕上并没有任何可编辑的东西,却整片被框住,用户看到的就是
 *   "一次性全选了整个页面的文本"。
 *
 * 判据为什么必须是"可编辑元素一律放行":
 *   · 搜索框、重命名输入框、笔记标题框、AI 对话输入框、正文块 textarea —— 它们各自的
 *     Ctrl+A 都是**浏览器原生**的"选中这一格",这是用户预期的行为。外壳在捕获期先看一眼,
 *     一旦发现目标可编辑就立刻撒手,原生行为与编辑器那条路(editor.js 在正文根节点上
 *     自己接管 Ctrl+A)一个字都不动;
 *   · 反过来,**只**判 `tagName === 'INPUT'` 是不够的:富文本区(contenteditable)没有
 *     INPUT 标签,漏掉它就会把"编辑器以外的富文本区"一起劫持掉。所以口径是
 *     `closest(EDITABLE_SELECTOR)` —— 命中元素**或其内部**就算可编辑。
 *
 * 这一层只做"挡住页面级全选"这一件事,不附带任何新功能(例如"在列表上 Ctrl+A 就选全部
 * 笔记"是产品决定,不在这里做)。
 */

/**
 * 「可编辑」的判据口径。
 *
 * 为什么把 `[contenteditable=""]`(`contenteditable` 的布尔写法,浏览器序列化成空串)
 * 与 `[contenteditable="plaintext-only"]` 一起写上:它们都是**真的可编辑**,少写一个就等于
 * 把那一类富文本区当成"非编辑目标"、把它原生的全选挡掉。`="false"` 不列 —— 那不是可编辑。
 */
export const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

/**
 * 这一下按键是不是"全选"组合键。
 *
 * 判据与需求一字不差:`Ctrl/Cmd + A`,且**不带** Alt。两边都认(Windows/Linux 用 Ctrl,
 * macOS 用 Cmd),`key` 大小写都算(按住 Shift 时 `key` 是 'A')。
 * Alt 必须排除:Windows 上 AltGr = Ctrl+Alt,不排除的话某些键盘布局里打一个字符就会
 * 被当成全选。
 */
export function isSelectAllChord(e) {
    if (!e) return false;
    if (e.ctrlKey !== true && e.metaKey !== true) return false;
    if (e.altKey === true) return false;
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    return key === 'a';
}

/**
 * 事件目标是不是可编辑元素(**或它内部**)。
 *
 * 用 `closest` 而不是自己往上走 parentNode:块输入框、富文本区内部都可能嵌套很深,
 * `closest` 一次就能给出"命中元素或其内部"这个语义(这正是我们要的口径);拿不到
 * `closest`(单测里的最小替身 / 非元素目标)一律当"不可编辑",让守卫去挡 ——
 * 挡错的代价是"少了原生全选",不挡错的代价是"整页被选上",两害相权取其轻。
 * `closest` 抛异常(选择器在极老的环境里不被支持)同样退回"不可编辑",绝不把
 * 一次按键变成一次崩溃。
 */
export function isEditableTarget(target) {
    if (!target || typeof target.closest !== 'function') return false;
    try {
        return target.closest(EDITABLE_SELECTOR) !== null;
    } catch {
        return false;
    }
}

/**
 * 外壳的裁决:这一下该不该被挡掉(返回 true = 调用方要 `preventDefault()`）。
 *
 * 顺序是"先认键、再认目标":不是全选组合键就什么都不做(绝不吞掉别的快捷键);
 * 是组合键但目标可编辑就放行(原生全选那一格 / 编辑器自己那条路照旧)。
 */
export function shouldBlockPageSelectAll(e, target = e?.target) {
    if (!isSelectAllChord(e)) return false;
    return !isEditableTarget(target);
}
