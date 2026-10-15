// 那颗球(发送/取消合一按钮)的**纯逻辑**:没有 DOM 也能验的部分。
//
// 为什么单独一个文件:这里放的都是"最容易悄悄写错、又最难在界面上看出来"的东西 ——
// 四类注视来源的**优先级**、方向的命名、眼睛能走多远、平滑系数、以及"一个变化值不值得看"。
// 界面上"它没反应"和"它看错地方"长得一模一样(都是它在自己四处看),所以这些判据必须能直接单测。
// 画的部分(造节点、写 transform、听事件)全在 app/agent/panel.js,那边只负责用这些数。

/**
 * 手感:⑥ 机灵。这一组数是用户在 demo 里挑定的,别随手改 ——
 * 44px 的球代入下面 maxOffset() 正好得到"眼睛 4.95px / 身体 2.23px"。
 */
export const FACE = {
    view: 32,          // 视图单位(= SVG 的 viewBox 边长)。所有几何量都以它为单位,
                       // 这样改球径时只改一处:像素 = 视图单位 × 球径/32。
    headR: 13,         // 头半径
    eyeCx: 4.4,        // 眼睛离中线多远
    eyeRx: 1.9,        // 眼睛横半径
    off: 3.6,          // 眼睛幅度
    ratio: 0.45,       // 身体幅度 / 眼睛幅度
    tilt: 3.6,         // 最大倾角(度)
    tauEye: 70,        // 眼睛时间常数(ms)
    tauBody: 200,      // 身体时间常数(ms)
    wanderMin: 600,    // 四处看时换目标的间隔下限
    wanderMax: 1200,
};

/** 眼睛不许碰到眼眶:上限 = 头半径 − 眼距 − 眼半径。 */
export const EYE_LIMIT = FACE.headR - FACE.eyeCx - FACE.eyeRx;
/** 实际幅度取"想要的"与"塞得下的"里小的那个。 */
export const MAX_OFFSET = Math.min(FACE.off, EYE_LIMIT);

/* ---------------- 阈值(每条都有理由) ---------------- */

/** 鼠标进到这个半径内就算"在跟它互动"。 */
export const NEAR = 110;
/** 鼠标这么久不动就松开。再不动就一直盯着一处,看着像卡住了。 */
export const IDLE_MS = 1600;
/** 看一次"页面变化"看多久。 */
export const NOTICE_MS = 1400;
/** 两次"看变化"之间至少隔多久:变化从来是**成串**来的(重画一次十几条记录),
 *  不节流就会一帧里连改十几次朝向,看起来像抖。 */
export const NOTICE_GAP = 400;
/** 最后一次编辑动作之后,还盯着编辑点多久。打字节奏通常 <1s,1.8s 能盖住"停下来想一下",
 *  又不会永远钉在光标上(用户去点别的地方时,失焦那一刻就松开 —— 见 panel.js)。 */
export const EDIT_HOLD_MS = 1800;
/** 光标矩形最快多久重算一次。打字时 input/selectionchange 很密(每个字都有),
 *  而每次都要读一次 layout —— 80ms ≈ 5 帧,既不会每帧读,又比眼睛自己的时间常数(70ms)快。 */
export const CARET_GAP = 80;
/** 太小的变化不值得看(光标、圆点、1px 的边框)。 */
export const MIN_AREA = 120;
/** 就在自己身上的变化不看(基本都是它自己的更新)。 */
export const MIN_DIST = 24;

/** 眼睛/身体的像素幅度:视图单位 × (球径 / 32)。 */
export function maxOffset(size) {
    const px = Number(size);
    if (!Number.isFinite(px) || px <= 0) return 0;
    return MAX_OFFSET * (px / FACE.view);
}

/** 指数趋近的系数:dt 与 tau 都是毫秒。
 *  ⚠️ dt 必须夹住:切回标签页、或面板隐藏时 rAF 会停,回来的第一帧可能给几百毫秒,
 *  不夹就会"瞬移"到目标(而不是滑过去)。 */
export function ease(dt, tau) {
    const d = Math.max(0, Math.min(Number(dt) || 0, 60));
    const t = Number(tau) > 0 ? Number(tau) : 1;
    return 1 - Math.exp(-d / t);
}

/** 屏幕坐标方向 → 人话。**屏幕坐标系**:y 向下为正,所以负数才是"上"。 */
export function dirLabel(dx, dy) {
    const a = Math.atan2(dy, dx) * 180 / Math.PI;
    if (a >= -22.5 && a < 22.5) return '右边';
    if (a >= 22.5 && a < 67.5) return '右下角';
    if (a >= 67.5 && a < 112.5) return '下边';
    if (a >= 112.5 && a < 157.5) return '左下角';
    if (a >= 157.5 || a < -157.5) return '左边';
    if (a >= -157.5 && a < -112.5) return '左上角';
    if (a >= -112.5 && a < -67.5) return '上边';
    return '右上角';
}

/** 从"球心 → 目标"的向量,拆成单位方向 + 距离 + 方向名。 */
export function toward(dx, dy) {
    const dist = Math.hypot(dx, dy);
    if (!(dist > 0)) return { ux: 0, uy: 0, dist: 0, label: dirLabel(0, 0) };
    return { ux: dx / dist, uy: dy / dist, dist, label: dirLabel(dx, dy) };
}

/** 鼠标在附近时朝鼠标看:方向按鼠标、**幅度不超过 max**(向量整体缩到球内,不是夹坐标)。 */
export function towardMouse(dx, dy, max) {
    const dist = Math.hypot(dx, dy);
    if (!(dist > 0)) return { x: 0, y: 0 };
    const k = max / Math.max(dist, 10);   // 分母给个下限:鼠标正好压在球心时不要除出个巨数
    return { x: clamp(dx * k, -max, max), y: clamp(dy * k, -max, max) };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/**
 * 四类来源的仲裁 —— **优先级只有这一份**,别在渲染循环里再散一份。
 *   鼠标 > 编辑点 > 页面变化 > 四处看。
 * 理由:鼠标是"此刻就压在这个像素上"的意图;编辑点是"人正在写东西"的当下意图;
 * 页面变化是事件通知(可以等 1.4s);四处看是待机。
 * `caret` / `notice` 传的是带 `until` 的对象(过期即不算数)。
 */
export function pickSource({ tracking, caret, notice, now }) {
    if (tracking === true) return 'mouse';
    if (caret && now < caret.until) return 'caret';
    if (notice && now < notice.until) return 'notice';
    return 'wander';
}

/**
 * 一个变化值不值得"看过去"。返回 null = 看;否则返回**不看的原因码**。
 * 为什么要把原因返回来:界面上"没反应"和"看错地方"是一样的,而这两种情况的排查方向完全不同
 * (前者是过滤/节流,后者是坐标)。原因码会写进面板的 data-gaze-skip,自检直接读它。
 */
export function glanceVerdict({ area, dist, visible }) {
    if (visible === false) return 'view';
    if (!(area >= MIN_AREA)) return 'area';
    if (!(dist >= MIN_DIST)) return 'dist';
    return null;
}

/* ================= 状态 → 脸 + 注视策略(接进真身后唯一的一份)=================
   用户拍板的默认方案(demo 页 `docs/kaiwu-robot-states-demo.html` 里那一套):
     就绪=现役那套不动;连接中=眼睛贴上沿(半闭);连不上=**9 片全白撕裂 + 熄灯掉电**;
     已停止=平直闭眼;思考中=头部转青蓝 + 眼睛画圈;流式=头部转青绿 + 扫读;
     等你决定=放大 1.08 盯住正前方;长任务=两眼间距随段数加宽。
   ⚠️ 形状归状态、位置归注视 —— 这张表里的 `policy` 就是那道门:
     full  = 注视全开(就绪,现有手感一个字不改)
     low   = 状态占位置,但留 LOW_GAZE 的幅度给鼠标(忙,但你互动它还有反应)
     pause = 注视暂停(这一态在说更要紧的话:我连不上 / 我在等你回答) */
export const LOW_GAZE = 0.4;
export const FACES = {
    idle: { shape: 'round', policy: 'full', color: 'white' },
    starting: { shape: 'half', policy: 'pause', color: 'white' },
    failed: { shape: 'torn', policy: 'pause', color: 'white', tear: true },
    stopped: { shape: 'closed', policy: 'pause', color: 'white' },
    thinking: { shape: 'orbit', policy: 'low', color: 'think' },
    streaming: { shape: 'sweep', policy: 'low', color: 'stream' },
    waiting: { shape: 'wide', policy: 'pause', color: 'white' },
    longtask: { shape: 'spread', policy: 'low', color: 'white' },
};

/** 状态名 → 脸。未知状态按"就绪"处理(不认识的态不该让它变成一张怪脸)。 */
export function faceOf(state) {
    return FACES[state] || FACES.idle;
}
export function gazePolicy(state) { return faceOf(state).policy; }
/** 注视幅度系数:1 / 0.4 / 0(pause 时状态自己摆眼睛,JS 不许再写 transform)。 */
export function gazeScale(state) {
    const p = gazePolicy(state);
    return p === 'full' ? 1 : (p === 'low' ? LOW_GAZE : 0);
}

/* 撕裂层的两个常量:用户看过的是 **9 片**这一版;想换成 6 片(更厚、44px 上更稳)
   只改 TEAR_SLICES 这一个数 —— 每片的高度由它均分,别的都不用动。 */
export const TEAR_SLICES = 9;
/** 撕一次 400ms、每 1.6s 一次(与 demo 页一致:静 70% → 撕 → 静)。 */
export const TEAR_PERIOD_MS = 1600;
/** 熄灯:2.4s 一轮,最低掉到 0.12(demo 页实测:1.0 次/秒、亮占比 44%、最大突降 0.73)。 */
export const LIGHTS_OUT_PERIOD_MS = 2400;
