// 「正在拖什么」的全应用**拖拽总线**。纯逻辑:不碰 DOM、不碰 IPC —— 一个模块级的小状态 + 订阅。
//
// 为什么要它:笔记列表的拖动是**自己画的**指针拖拽(不是浏览器的拖放,没把载荷放进 dataTransfer),
// 所以别的面板(画布、AI 对话、链接……)既收不到 drop 事件,也不知道有人在拖什么。
// 总线把这件事变成一句话:**谁都能问"现在拖的是什么",也都能在松手时接货。**
//
// 三种角色的用法(缺一不可,顺序就是它们出现的顺序):
//   · 拖动的**发起方**(笔记列表):`begin(payload)` … `end({clientX, clientY, insideTree})`
//   · **想接货的面板**:`onEnd(cb)` 订阅松手;拖动途中还能用 `current()` 问"现在拖的是什么"来画反馈
//   · **应用启动时**:`setVaultRoot(<笔记库绝对路径>)` —— 载荷里的绝对路径靠它算出来
//
// ⚠️ 为什么载荷要带**绝对路径**:画布引擎读图/读稿子都是按盘上的路径读的
//    (而且 `参考图` 那条路会把**相对路径拼到项目目录下**,见 electron/drama/lib/image.js:349 ——
//    库内相对路径在那里是错的)。所以总线在派发前就把绝对路径算好,面板不必自己拼、也拼不对。
// ⚠️ 路径的**守卫**在笔记列表那一侧(它只递库内相对路径);总线只做"相对 → 绝对"的拼接,
//    不认识、也不接受库外的路径(库根之外的东西在笔记树里根本不存在)。

/** 扩展名 → 类型。三类是画布能落下的,其余一律 `other`(调用方据此拒绝并说清原因)。 */
const KIND_BY_EXT = Object.freeze({
    txt: 'text', md: 'text', markdown: 'text', docx: 'text', doc: 'text', srt: 'text', rtf: 'text',
    png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', avif: 'image',
    mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
});

/** 文件名(或路径)的小写扩展名,没有就空串。 */
export function extOf(name) {
    const s = String(name ?? '');
    const at = s.lastIndexOf('.');
    if (at <= 0 || at === s.length - 1) return '';
    return s.slice(at + 1).toLowerCase();
}

/** 这个名字属于哪一类(纯函数,单测直接钉)。 */
export function kindOfName(name) {
    return KIND_BY_EXT[extOf(name)] ?? 'other';
}

/** 画布认得的类型 → 中文名(拒绝时要说人话)。 */
export const KIND_LABEL = Object.freeze({
    text: '文本', image: '图片', video: '视频', other: '这种格式',
});

let vaultRoot = '';
let dragging = null;
const endListeners = new Set();
const beginListeners = new Set();

const asText = (v) => (typeof v === 'string' ? v.trim() : '');

/** 应用启动时告诉总线"笔记库在哪"(绝对路径)。空串 = 还不知道。 */
export function setVaultRoot(dir) {
    vaultRoot = asText(dir);
}

export function getVaultRoot() {
    return vaultRoot;
}

/**
 * 库内相对路径 → 绝对路径。
 * ⚠️ 只做拼接,不做词法解析:相对路径由笔记列表给出(它自己已经过库守卫),
 * 而这里拼出来的东西**只用于"引擎按路径读盘"**,不参与任何权限判断。
 * 库根还不知道时回空串 —— 调用方据此拒绝(宁可不落地,也不递一个错的路径)。
 */
export function absOf(relPath) {
    const rel = asText(relPath);
    if (rel === '' || vaultRoot === '') return '';
    const sep = vaultRoot.includes('\\') ? '\\' : '/';
    const root = vaultRoot.endsWith('\\') || vaultRoot.endsWith('/') ? vaultRoot.slice(0, -1) : vaultRoot;
    const parts = rel.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
    // ⚠️ 防御性:出现 `..` 段就**拒绝**(回空串)。库内相对路径本来不会带它(笔记列表那一侧
    //    已经过守卫),但这层是"拼路径"的唯一地方 —— 在这里多挡一次,代价只是一行。
    if (parts.some((s) => s === '..')) return '';
    const tail = parts.join(sep);
    return tail === '' ? '' : `${root}${sep}${tail}`;
}

/**
 * 拖动的发起方:开拖。
 * @param {{relPath:string, name:string, isDir?:boolean}} input
 * @returns {object|null} 记下的载荷(目录不参与:画布只收文件)
 */
export function begin({ relPath, name, isDir = false } = {}) {
    const rel = asText(relPath);
    if (rel === '' || isDir === true) {
        dragging = null;
        return null;
    }
    const base = asText(name) !== '' ? asText(name) : (rel.split(/[\\/]/).pop() ?? '');
    // ⚠️ 类型必须按**路径**认,不能按 name 认:笔记列表递上来的 name 是**标题**
    //    (「甲篇」,没有扩展名)—— 按它认会把 .md / .png 全判成 `other`,
    //    于是"拖上去什么都没发生"(实测就是这么错了半天)。relPath 是盘上的文件名,一定带扩展名。
    const ext = extOf(rel) !== '' ? extOf(rel) : extOf(base);
    dragging = Object.freeze({
        relPath: rel,
        name: base,
        ext,
        kind: KIND_BY_EXT[ext] ?? 'other',
        absPath: absOf(rel),
    });
    for (const cb of beginListeners) {
        try { cb(dragging); } catch { /* 订阅者自己的错不该影响发起方 */ }
    }
    return dragging;
}

/** 现在拖的是什么(没人拖 → null)。想画"接收中"反馈的面板用它。 */
export function current() {
    return dragging;
}

/**
 * 拖动的发起方:松手(或取消)。
 * @param {{clientX?:number, clientY?:number, insideTree?:boolean}} [info]
 *   `insideTree` = 松在笔记树里(那次拖动是"移动笔记",与别的面板无关)。
 * @returns {object|null} 交出去的载荷
 */
export function end(info = {}) {
    const payload = dragging;
    dragging = null;
    if (payload === null) return null;
    const event = {
        payload,
        clientX: Number.isFinite(info.clientX) ? Number(info.clientX) : null,
        clientY: Number.isFinite(info.clientY) ? Number(info.clientY) : null,
        insideTree: info.insideTree === true,
    };
    for (const cb of endListeners) {
        try { cb(event); } catch { /* 同上 */ }
    }
    return payload;
}

/** 订阅"松手"。交回退订函数。 */
export function onEnd(cb) {
    if (typeof cb !== 'function') return () => {};
    endListeners.add(cb);
    return () => endListeners.delete(cb);
}

/** 订阅"开拖"(面板想立刻显示"可以拖到我这儿"时用)。 */
export function onBegin(cb) {
    if (typeof cb !== 'function') return () => {};
    beginListeners.add(cb);
    return () => beginListeners.delete(cb);
}

/** 只给单测:把模块级状态清干净(订阅者与拖动状态)。 */
export function __resetForTest() {
    dragging = null;
    vaultRoot = '';
    endListeners.clear();
    beginListeners.clear();
}
