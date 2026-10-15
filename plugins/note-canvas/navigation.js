const clamp = n => Math.max(.25, Math.min(2.5, n));
const normalize = value => ({x:Number.isFinite(value?.x)?value.x:0,y:Number.isFinite(value?.y)?value.y:0,scale:clamp(Number.isFinite(value?.scale)?value.scale:1)});
/** Exponential target integration in milliseconds; no duration depends on frame rate. */
export function createNavigation({ view = { x: 0, y: 0, scale: 1 }, onFrame = () => {}, onSettled = () => {},
    requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, now = () => performance.now(), reducedMotion = () => false,
    minFrameIntervalMs = 0 }) {
    let current = normalize(view), target = { ...current }, frame = null, time = now(), tau = 110, anchor = null, inertia = null, disposed = false, generation = 0;
    const frameInterval = Number.isFinite(minFrameIntervalMs) ? Math.max(0, minFrameIntervalMs) : 0;
    let nextPublishAt = Number.NEGATIVE_INFINITY;
    const reduced = () => typeof reducedMotion === 'function' ? reducedMotion() : reducedMotion;
    function emit(force = false, stamp = now()) {
        if (!force && stamp < nextPublishAt) return false;
        nextPublishAt = frameInterval > 0 ? stamp + frameInterval : Number.NEGATIVE_INFINITY;
        onFrame({ ...current });
        return true;
    }
    function cancel(flush) {
        const wasRunning = frame !== null;
        generation++;
        if (frame !== null) cancelFrame(frame);
        frame = null; target = { ...current }; anchor = null; inertia = null;
        if (flush && wasRunning && !disposed) emit(true);
    }
    function stop() { cancel(true); }
    function schedule() { if (frame === null && !disposed) { time = now(); frame = requestFrame(tick); } }
    function tick(stamp) {
        frame = null; if (disposed) return; const stampGeneration=generation;
        const dt = Math.max(0, stamp - time); time = stamp;
        if (reduced()) { current = { ...target }; inertia = null; }
        else if (inertia) {
            const decay = Math.exp(-dt / 95), a = 95 * (1 - decay);
            current.x += inertia.x * a; current.y += inertia.y * a;
            inertia.x *= decay; inertia.y *= decay; target = { ...current };
            if (Math.hypot(inertia.x, inertia.y) < .00001) inertia = null;
        } else {
            const a = 1 - Math.exp(-dt / tau);
            current.scale += (target.scale - current.scale) * a;
            if (anchor) { current.x = anchor.cx - anchor.wx * current.scale; current.y = anchor.cy - anchor.wy * current.scale; }
            else { current.x += (target.x - current.x) * a; current.y += (target.y - current.y) * a; }
        }
        if (!inertia && Math.max(Math.abs(target.x - current.x), Math.abs(target.y - current.y), Math.abs(target.scale - current.scale)) < .000001) {
            current = { ...target }; anchor = null; emit(true, stamp); onSettled({ ...current }); return;
        }
        emit(false, stamp); if(!disposed && generation===stampGeneration) frame = requestFrame(tick);
    }
    const api = {
        get view() { return { ...current }; },
        pan(dx, dy, trackpad = false) {
            if (disposed) return; anchor = null; inertia = null; tau = trackpad ? 38 : 110;
            target.x += dx; target.y += dy;
            if (reduced()) { const next = { ...target }; cancel(false); current = next; target = { ...next }; emit(true); onSettled({ ...current }); } else schedule();
        },
        zoom(factor, cx, cy) {
            if (disposed || !(factor > 0) || !Number.isFinite(factor)) return;
            inertia = null; tau = 100;
            anchor = { cx, cy, wx: (cx - current.x) / current.scale, wy: (cy - current.y) / current.scale };
            target.scale = clamp(target.scale * factor); target.x = cx - anchor.wx * target.scale; target.y = cy - anchor.wy * target.scale;
            if (reduced()) { const next = { ...target }; cancel(false); current = next; target = { ...next }; emit(true); onSettled({ ...current }); } else schedule();
        },
        set(value) { if (disposed) return; cancel(false); current = normalize(value); target = { ...current }; emit(true); },
        coast(vx, vy) {
            if (disposed) return; cancel(false); if (reduced()) return;
            const length = Math.hypot(vx, vy); if (!length) return;
            const k = Math.min(1, 75 / (length * 95)); inertia = { x: vx * k, y: vy * k }; schedule();
        },
        stop, dispose() { cancel(false); disposed = true; },
    };
    return api;
}
