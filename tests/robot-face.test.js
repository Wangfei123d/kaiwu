// 那颗球(发送/取消合一按钮)的纯逻辑测试。
//
// 为什么这些判据值得单独钉:界面上"它没反应"和"它看错地方"长得一模一样(都是它在自己四处看),
// 而这两种情况的排查方向完全不同 —— 优先级写错会表现为"偶尔不跟鼠标",
// 幅度/上限写错会表现为"眼睛偶尔飘出眼眶",过滤写错会表现为"什么都不看"。
// 这些都不会报错,只能靠这里的断言钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CARET_GAP, EDIT_HOLD_MS, EYE_LIMIT, FACE, FACES, IDLE_MS, LOW_GAZE, MAX_OFFSET, MIN_AREA, MIN_DIST,
    NEAR, NOTICE_GAP, NOTICE_MS, TEAR_SLICES, dirLabel, ease, faceOf, gazeScale, glanceVerdict, maxOffset,
    pickSource, toward, towardMouse,
} from '../app/lib/robot-face.js';

test('⑥ 机灵那组数:44px 的球 → 眼睛 4.95px、身体 2.23px(用户挑的手感,别悄悄变)', () => {
    assert.equal(Number(maxOffset(44).toFixed(2)), 4.95);
    assert.equal(Number((maxOffset(44) * FACE.ratio).toFixed(2)), 2.23);
    // 球径变了,幅度跟着变(手感按比例,不是写死的像素)
    assert.equal(Number(maxOffset(88).toFixed(2)), 9.9);
    assert.equal(maxOffset(0), 0);
    assert.equal(maxOffset(NaN), 0);
});

test('眼睛幅度取"想要的"与"塞得进眼眶的"里小的那个', () => {
    // 6.7 是几何上限(头半径 − 眼距 − 眼半径);⑥ 机灵要的 3.6 比它小,所以取 3.6
    assert.equal(Number(EYE_LIMIT.toFixed(1)), 6.7);
    assert.equal(MAX_OFFSET, Math.min(FACE.off, EYE_LIMIT));
    assert.equal(MAX_OFFSET, FACE.off);
});

test('优先级只有这一条:鼠标 > 编辑点 > 页面变化 > 四处看', () => {
    const now = 1000;
    const caret = { until: now + 100 };
    const notice = { until: now + 100 };
    assert.equal(pickSource({ tracking: true, caret, notice, now }), 'mouse');
    assert.equal(pickSource({ tracking: false, caret, notice, now }), 'caret');
    assert.equal(pickSource({ tracking: false, caret: null, notice, now }), 'notice');
    assert.equal(pickSource({ tracking: false, caret: null, notice: null, now }), 'wander');
});

test('过期的编辑点/变化不算数(过期的必须掉回四处看,不然它会一直盯着旧地方)', () => {
    const now = 5000;
    assert.equal(pickSource({ tracking: false, caret: { until: now - 1 }, notice: null, now }), 'wander');
    assert.equal(pickSource({ tracking: false, caret: null, notice: { until: now - 1 }, now }), 'wander');
    // 编辑点过期但变化还在 → 让位给变化(不是直接四处看)
    assert.equal(pickSource({
        tracking: false, caret: { until: now - 1 }, notice: { until: now + 1 }, now,
    }), 'notice');
    // 边界:until 就等于 now 时算过期(用 < 而不是 <=)
    assert.equal(pickSource({ tracking: false, caret: null, notice: { until: now }, now }), 'wander');
});

test('方向名:四角与四边都对(屏幕坐标系,y 向下为正)', () => {
    assert.equal(dirLabel(100, 0), '右边');
    assert.equal(dirLabel(0, 100), '下边');
    assert.equal(dirLabel(-100, 0), '左边');
    assert.equal(dirLabel(0, -100), '上边');
    assert.equal(dirLabel(100, 100), '右下角');
    assert.equal(dirLabel(-100, 100), '左下角');
    assert.equal(dirLabel(-100, -100), '左上角');
    assert.equal(dirLabel(100, -100), '右上角');
    // 45° 边界的归属:正好 22.5° 归"角"(用 >= 的写法)
    assert.equal(dirLabel(100, 42), '右下角');
    assert.equal(dirLabel(100, 41), '右边');
});

test('toward:单位向量 + 距离 + 方向名;零距离不炸(不许除出 NaN)', () => {
    const v = toward(30, 40);
    assert.equal(v.dist, 50);
    assert.equal(Number(v.ux.toFixed(2)), 0.6);
    assert.equal(Number(v.uy.toFixed(2)), 0.8);
    assert.equal(v.label, '右下角');
    const zero = toward(0, 0);
    assert.equal(zero.dist, 0);
    assert.equal(zero.ux, 0);
    assert.equal(zero.uy, 0);
});

test('towardMouse:幅度随距离缩,但**永不超出上限**(眼睛不许飘出眼眶)', () => {
    const max = 4.95;
    const far = towardMouse(600, 800, max);          // 距离 1000
    assert.equal(Number(Math.hypot(far.x, far.y).toFixed(2)), max);
    const near = towardMouse(2, 0, max);
    assert.equal(Math.hypot(near.x, near.y) <= max, true, '近处的目标幅度只许更小');
    const zero = towardMouse(0, 0, max);
    assert.deepEqual(zero, { x: 0, y: 0 });
    const huge = towardMouse(1e6, 0, max);
    assert.equal(huge.x, max);
});

test('ease:dt 被夹在 60ms 内(切回标签页时 rAF 会给一大跳,不许瞬移)', () => {
    assert.equal(Number(ease(0, 70).toFixed(4)), 0);
    const oneFrame = ease(16.7, 70);
    assert.equal(oneFrame > 0.2 && oneFrame < 0.25, true, `一帧(16.7ms/tau=70)应当约 0.21,实际 ${oneFrame}`);
    // 夹住之后:给 5000ms 与给 60ms 的结果必须一样
    assert.equal(ease(5000, 70), ease(60, 70));
    // ⚠️ 这个数值正是夹住的证据:不夹的话 140ms/tau=70 应当到 1-e^-2 ~ 0.86,
    //    夹到 60ms 之后是 1-e^(-60/70) ~ 0.58 —— 第一帧最多走一半多一点,不会瞬移。
    assert.equal(Number(ease(140, 70).toFixed(2)), 0.58);
    assert.equal(ease(0, 0) >= 0, true, 'tau 非法时不许出 NaN/负数');
});

test('glanceVerdict:太小的变化、太近的变化、视口外的变化都不看,并且**给出原因**', () => {
    assert.equal(glanceVerdict({ area: 5000, dist: 400, visible: true }), null);
    assert.equal(glanceVerdict({ area: MIN_AREA - 1, dist: 400, visible: true }), 'area');
    assert.equal(glanceVerdict({ area: 5000, dist: MIN_DIST - 1, visible: true }), 'dist');
    assert.equal(glanceVerdict({ area: 5000, dist: 400, visible: false }), 'view');
    // 面积算不出来(NaN)时按"太小"处理,不能当成"看"
    assert.equal(glanceVerdict({ area: NaN, dist: 400, visible: true }), 'area');
});

test('阈值本身:都必须是正数,而且互相之间的次序有意义', () => {
    for (const [name, v] of Object.entries({
        NEAR, IDLE_MS, NOTICE_MS, NOTICE_GAP, EDIT_HOLD_MS, CARET_GAP, MIN_AREA, MIN_DIST,
    })) {
        assert.equal(Number.isFinite(v) && v > 0, true, `${name} 必须是正数`);
    }
    // 帧预算:光标矩形重算(80ms)必须比"编辑保持"(1800ms)频繁得多,否则打字时光标是僵的
    assert.equal(CARET_GAP < EDIT_HOLD_MS, true);
    // 变化节流窗口必须小于"看一次"的时长,否则连续变化会把上一次的注视切断
    assert.equal(NOTICE_GAP < NOTICE_MS, true);
});

test('状态门:哪几个态留注视、哪几个态暂停(接真身时唯一的一道门)', () => {
    // full = 就绪(现有手感不改);low = 忙碌态(留 40% 跟随);pause = 状态自己在说话
    assert.equal(gazeScale('idle'), 1);
    assert.equal(gazeScale('thinking'), LOW_GAZE);
    assert.equal(gazeScale('streaming'), LOW_GAZE);
    assert.equal(gazeScale('longtask'), LOW_GAZE);
    assert.equal(gazeScale('starting'), 0);
    assert.equal(gazeScale('failed'), 0);
    assert.equal(gazeScale('stopped'), 0);
    assert.equal(gazeScale('waiting'), 0);
    assert.equal(Number(LOW_GAZE.toFixed(2)), 0.4);
    // 不认识的态按"就绪"处理:不能让一个新状态把它变成一张怪脸
    assert.equal(gazeScale('火星态'), 1);
    assert.equal(faceOf('火星态'), FACES.idle);
});

test('八个状态各有自己的脸;撕裂层只有"连不上"才需要', () => {
    const names = ['idle', 'starting', 'failed', 'stopped', 'thinking', 'streaming', 'waiting', 'longtask'];
    const shapes = names.map((n) => faceOf(n).shape);
    assert.equal(new Set(shapes).size, names.length, '八张脸的形状读数必须两两不同');
    assert.equal(faceOf('failed').tear, true);
    assert.equal(names.filter((n) => faceOf(n).tear === true).length, 1, '只有连不上要额外图层');
    assert.equal(TEAR_SLICES >= 6, true, '切片数至少 6(用户看过的是 9)');
});
