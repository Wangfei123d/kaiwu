import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    clampWidth, widthFromDrag, shrinkToFit, createColumnResizer,
    DEFAULT_NAV_W, MIN_NAV_W, MAX_NAV_W,
} from '../app/shell/column-resizer.js';

// 侧栏可拖:拖动本身是 DOM 事件,但"宽度怎么算"必须是纯函数 ——
// 否则"两栏加起来会不会把中间挤没""往左拖到底是变宽还是变窄"这类事
// 只能靠在真实窗口里手拖来验,既慢又漏。这里钉的就是这几条。

test('clampWidth:夹到上下限,脏值退回默认', () => {
    assert.equal(clampWidth(300, 180, 520, 236), 300);
    assert.equal(clampWidth(10, 180, 520, 236), 180, '太窄 → 下限');
    assert.equal(clampWidth(9999, 180, 520, 236), 520, '太宽 → 上限');
    assert.equal(clampWidth(300.6, 180, 520, 236), 301, '取整');
    assert.equal(clampWidth('320', 180, 520, 236), 320, '设置里存成字符串也认');
    for (const bad of [undefined, null, NaN, 'abc', {}, Infinity]) {
        assert.equal(clampWidth(bad, 180, 520, 236), 236, `脏值 ${String(bad)} → 默认`);
    }
});

test('widthFromDrag:左栏跟着指针走,右栏方向相反', () => {
    // 左栏的分隔条在它右侧:指针往右 → 左栏变宽
    assert.equal(widthFromDrag({ startWidth: 236, startX: 300, clientX: 360, side: 'left' }), 296);
    // 右栏的分隔条在它左侧:指针往左 → 右栏变宽(往右反而变窄)
    assert.equal(widthFromDrag({ startWidth: 240, startX: 900, clientX: 840, side: 'right' }), 300);
    assert.equal(widthFromDrag({ startWidth: 240, startX: 900, clientX: 960, side: 'right' }), 180);
});

test('shrinkToFit:窗口不够宽时按比例收两栏,并守住各自下限', () => {
    assert.equal(shrinkToFit({ containerWidth: 1400, navW: 236, sideW: 240 }), null,
        '够宽就什么都不做');

    const r = shrinkToFit({ containerWidth: 700, navW: 236, sideW: 240 });
    assert.ok(r !== null, '不够宽时必须收');
    assert.equal(r.navW + r.sideW + 320, 700, '收完刚好给中间留出 320');

    // 极端窄:两栏都到底了就返回 null(不再继续压,免得出现负宽度)
    assert.equal(shrinkToFit({ containerWidth: 300, navW: 180, sideW: 200 }), null);
});

// ---- 接线部分:用最小 DOM 替身跑真实的 createColumnResizer ----

class El {
    constructor() {
        this.dataset = {}; this.attrs = {}; this.listeners = {};
    }
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
    removeEventListener(t, f) {
        this.listeners[t] = (this.listeners[t] ?? []).filter(x => x !== f);
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    fire(type, event = {}) {
        for (const f of this.listeners[type] ?? []) f({ preventDefault() {}, ...event });
    }
}

/** 假的 window:拖动期间的 pointermove/pointerup 挂在这儿(见模块里的说明)。 */
function fakeWin() {
    const listeners = {};
    return {
        listeners,
        addEventListener(t, f) { (listeners[t] ??= []).push(f); },
        removeEventListener(t, f) { listeners[t] = (listeners[t] ?? []).filter(x => x !== f); },
        fire(type, event = {}) { for (const f of listeners[type] ?? []) f({ preventDefault() {}, ...event }); },
        count(type) { return (listeners[type] ?? []).length; },
    };
}

function makeResizer(overrides = {}) {
    const handle = new El();
    const win = fakeWin();
    const applied = [];
    const persisted = [];
    let width = overrides.startWidth ?? DEFAULT_NAV_W;
    createColumnResizer({
        handle, side: 'left', min: MIN_NAV_W, max: MAX_NAV_W, defaultWidth: DEFAULT_NAV_W,
        getWidth: () => width,
        apply: (w) => { width = w; applied.push(w); },
        persist: (w) => persisted.push(w),
        win,
        ...overrides.deps,
    });
    return { handle, win, applied, persisted, width: () => width };
}

test('拖动:按下 → 移动 → 松手,松手时才写一次设置', () => {
    const r = makeResizer();
    r.handle.fire('pointerdown', { button: 0, clientX: 300 });
    assert.equal(r.handle.dataset.dragging, '1', '拖动中给个标记(CSS 用它点亮分隔条)');
    assert.equal(r.win.count('pointermove'), 1,
        '移动挂在 window 上 —— 拖快了指针会离开那 6px 命中区,挂在分隔条自己身上会丢事件');

    // 关键:move 发在 window 上(不是 handle 上),模拟"指针已经离开分隔条"
    r.win.fire('pointermove', { clientX: 340 });
    r.win.fire('pointermove', { clientX: 380 });
    assert.equal(r.width(), 316, '236 + 80');
    assert.deepEqual(r.persisted, [], '拖动中一次都不写设置(一次拖动有上百个 move)');

    r.win.fire('pointerup', {});
    assert.deepEqual(r.persisted, [316], '松手才落一次');
    assert.equal(r.handle.dataset.dragging, undefined);
    assert.equal(r.win.count('pointermove'), 0, '松手后要摘掉 window 上的监听器');
});

test('拖动:上下限在拖动过程中就生效(不是松手才夹)', () => {
    const r = makeResizer();
    r.handle.fire('pointerdown', { button: 0, clientX: 300 });
    r.win.fire('pointermove', { clientX: 10 });      // 想拖到 0
    assert.equal(r.width(), MIN_NAV_W, '下限');
    r.win.fire('pointermove', { clientX: 5000 });    // 想拖到天上去
    assert.equal(r.width(), MAX_NAV_W, '上限');
});

test('右键按下不启动拖动;没按下时移动不改变宽度', () => {
    const r = makeResizer();
    r.handle.fire('pointerdown', { button: 2, clientX: 300 });
    r.win.fire('pointermove', { clientX: 400 });
    assert.equal(r.width(), DEFAULT_NAV_W, '右键不拖');
    assert.equal(r.win.count('pointermove'), 0, '右键根本不该挂监听器');

    r.win.fire('pointermove', { clientX: 500 });
    assert.equal(r.width(), DEFAULT_NAV_W, '没按下时的移动不该改宽度');
});

test('双击复位到默认宽度,并写进设置', () => {
    const r = makeResizer();
    r.handle.fire('pointerdown', { button: 0, clientX: 300 });
    r.win.fire('pointermove', { clientX: 460 });
    r.win.fire('pointerup', {});
    r.handle.fire('dblclick');
    assert.equal(r.width(), DEFAULT_NAV_W);
    assert.equal(r.persisted.at(-1), DEFAULT_NAV_W);
});

test('键盘:←/→ 能调,Shift 步子更大(无障碍不该只靠鼠标)', () => {
    const r = makeResizer();
    r.handle.fire('keydown', { key: 'ArrowRight' });
    assert.equal(r.width(), DEFAULT_NAV_W + 16);
    r.handle.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
    assert.equal(r.width(), DEFAULT_NAV_W + 16 - 48, 'Shift = 3 倍步长');
    assert.equal(r.persisted.length, 2, '键盘调完每次都落设置');
    r.handle.fire('keydown', { key: 'a' });
    assert.equal(r.width(), DEFAULT_NAV_W - 32, '别的键不管');
});

test('右栏的键盘方向是反的(往左才是变宽)', () => {
    let width = 240;
    const handle = new El();
    createColumnResizer({
        handle, side: 'right', min: 200, max: 560, defaultWidth: 240,
        getWidth: () => width, apply: (w) => { width = w; }, persist: () => {},
    });
    handle.fire('keydown', { key: 'ArrowLeft' });
    assert.equal(width, 256, '指针往左 = 右栏变宽');
    handle.fire('keydown', { key: 'ArrowRight' });
    assert.equal(width, 240);
});

test('句柄缺失时安全退化(外壳布局改了也不该炸)', () => {
    const r = createColumnResizer({
        handle: null, side: 'left', min: 1, max: 2, defaultWidth: 1,
        getWidth: () => 1, apply: () => {},
    });
    assert.equal(typeof r.dispose, 'function');
});

test('dispose 之后事件不再生效', () => {
    const handle = new El();
    let width = 236;
    const inst = createColumnResizer({
        handle, side: 'left', min: 180, max: 520, defaultWidth: 236,
        getWidth: () => width, apply: (w) => { width = w; },
    });
    inst.dispose();
    handle.fire('keydown', { key: 'ArrowRight' });
    assert.equal(width, 236, 'dispose 之后按键不再改宽度');
    assert.deepEqual(handle.listeners.pointerdown, [], '监听器要真的摘掉(别留悬挂引用)');
});