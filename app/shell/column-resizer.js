// 侧栏宽度可拖(左:笔记列表;右:链接 + AI 面板)。
//
// 为什么单独一个模块:拖动本身是 DOM 事件,但**宽度怎么算**是纯函数 ——
// "往左拖右边栏应该变宽还是变窄""两栏加起来会不会把中间挤没"这类事,
// 用 DOM 测又慢又脆。所以把它拆成 clampWidth / widthFromDrag 两个纯函数
// (可 node --test 直跑),这里只负责接线。
//
// 宽度存进设置(__global / ui.navWidth | ui.sideWidth),重启后还在。

/** 默认宽度:与 shell.css 里的初值一致(改这里记得两边一起改)。 */
export const DEFAULT_NAV_W = 236;
export const DEFAULT_SIDE_W = 240;
/** 上下限:下面是"还看得出是什么",上面是"别把中间挤没"。 */
export const MIN_NAV_W = 180;
export const MAX_NAV_W = 520;
export const MIN_SIDE_W = 200;
export const MAX_SIDE_W = 560;
/** 中间那一栏至少留这么宽 —— 比这窄就不是编辑器了。 */
export const MIN_CENTER_W = 320;

/** 夹到 [min, max]。非数字(设置里存了脏值)一律退回 fallback。 */
export function clampWidth(raw, min, max, fallback) {
    // ⚠️ null 不能当成 0:设置里"没存过"就是 null,当成 0 会被夹成下限 ——
    // 于是"从没调过侧栏宽度"的用户会以最窄的侧栏启动(这条被用例抓到过)
    if (raw === null || raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 拖动中算新宽度。
 * @param {{startWidth:number, startX:number, clientX:number, side:'left'|'right'}} p
 *   side='left'  = 分隔条在左栏**右侧**,跟着指针往右走变宽;
 *   side='right' = 分隔条在右栏**左侧**,指针往左走才变宽(方向相反)。
 */
export function widthFromDrag({ startWidth, startX, clientX, side }) {
    const delta = side === 'right' ? (startX - clientX) : (clientX - startX);
    return Math.round(startWidth + delta);
}

/**
 * 窗口变窄时把两栏按比例收回来,保证中间还剩 MIN_CENTER_W。
 * 返回应当**改小**的那一栏(已经是合法值就返回 null)。
 */
export function shrinkToFit({ containerWidth, navW, sideW, minNav = MIN_NAV_W, minSide = MIN_SIDE_W }) {
    const over = navW + sideW + MIN_CENTER_W - containerWidth;
    if (over <= 0) return null;
    // 先按比例分摊,再夹到各自的下限;一侧到底了就把剩下的推给另一侧
    let navCut = Math.min(navW - minNav, Math.ceil(over * (navW / (navW + sideW))));
    let sideCut = over - navCut;
    if (sideCut > sideW - minSide) {
        sideCut = sideW - minSide;
        navCut = Math.min(navW - minNav, over - sideCut);
    }
    if (navCut <= 0 && sideCut <= 0) return null;
    return { navW: navW - navCut, sideW: sideW - sideCut };
}

/**
 * 把一个拖动句柄接到分隔条上。
 *
 * @param {object} deps
 * @param {object} deps.handle 分隔条元素
 * @param {'left'|'right'} deps.side
 * @param {number} deps.min
 * @param {number} deps.max
 * @param {number} deps.defaultWidth 双击复位到哪
 * @param {() => number} deps.getWidth 当前宽度
 * @param {(w:number) => void} deps.apply 写回宽度(设置 CSS 变量)
 * @param {(w:number) => void} [deps.persist] 只在松手/键盘调完时调一次
 * @param {number} [deps.step] 键盘一次调多少
 * @param {object} [deps.doc]
 */
export function createColumnResizer({
    handle, side, min, max, defaultWidth, getWidth, apply, persist = null,
    step = 16, doc = globalThis.document, win = globalThis.window,
}) {
    if (!handle) return { dispose() {} };

    let startWidth = 0;
    let startX = 0;
    let dragging = false;

    const setWidth = (w, { save = true } = {}) => {
        const next = clampWidth(w, min, max, defaultWidth);
        apply(next);
        handle.setAttribute('aria-valuenow', String(next));
        if (save && persist) persist(next);
        return next;
    };

    const onPointerMove = (e) => {
        if (!dragging) return;
        e.preventDefault?.();
        // 拖动中**不**写设置:一次拖动会来上百个 pointermove,每个都写盘没有必要
        setWidth(widthFromDrag({ startWidth, startX, clientX: e.clientX ?? 0, side }), { save: false });
    };

    const onPointerUp = () => {
        if (!dragging) return;
        dragging = false;
        delete handle.dataset.dragging;
        win?.removeEventListener?.('pointermove', onPointerMove);
        win?.removeEventListener?.('pointerup', onPointerUp);
        win?.removeEventListener?.('pointercancel', onPointerUp);
        persist?.(getWidth());                    // 松手时才落一次设置
    };

    const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        dragging = true;
        startWidth = getWidth();
        startX = e.clientX ?? 0;
        handle.dataset.dragging = '1';
        // ⚠️ 移动/松手挂在 **window** 上,不是挂在分隔条自己身上:
        //   ① 拖快了指针会离开那 6px 的命中区;
        //   ② 自检用的是合成输入,指针捕获对它不一定生效 —— 挂 window 两种情况都稳。
        win?.addEventListener?.('pointermove', onPointerMove);
        win?.addEventListener?.('pointerup', onPointerUp);
        win?.addEventListener?.('pointercancel', onPointerUp);
        // 拖动过程中别让浏览器顺手选中旁边的文字
        e.preventDefault?.();
    };

    const onDoubleClick = () => setWidth(defaultWidth);

    const onKeyDown = (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault?.();
        const stepPx = e.shiftKey ? step * 3 : step;
        // 方向按"把分隔条往哪边推"理解:左栏的箭头直接对应增减,右栏相反
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        setWidth(getWidth() + dir * stepPx * (side === 'right' ? -1 : 1));
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('dblclick', onDoubleClick);
    handle.addEventListener('keydown', onKeyDown);
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(clampWidth(getWidth(), min, max, defaultWidth)));

    return {
        dispose() {
            handle.removeEventListener('pointerdown', onPointerDown);
            handle.removeEventListener('dblclick', onDoubleClick);
            handle.removeEventListener('keydown', onKeyDown);
            win?.removeEventListener?.('pointermove', onPointerMove);
            win?.removeEventListener?.('pointerup', onPointerUp);
            win?.removeEventListener?.('pointercancel', onPointerUp);
        },
    };
}