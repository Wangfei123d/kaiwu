const validScale = (value, fallback = 1) => Number.isFinite(value) && value > 0 ? value : fallback;
const sameScale = (a, b) => Math.abs(a - b) < 1e-6;

export function createZoomLayout({ initialScale = 1, intervalMs = 2000, now = () => performance.now(),
    setTimer = setTimeout, clearTimer = clearTimeout, onLayoutScale = () => {} } = {}) {
    const interval = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : 2000;
    let layoutScale = validScale(initialScale), currentScale = layoutScale, lastCommitAt = now(), timer = null, disposed = false;

    function clearPending() {
        if (timer !== null) clearTimer(timer);
        timer = null;
    }
    function commit() {
        clearPending();
        if (disposed || sameScale(currentScale, layoutScale)) return;
        layoutScale = currentScale;
        lastCommitAt = now();
        onLayoutScale(layoutScale);
    }
    function update(value) {
        if (disposed) return 1;
        currentScale = validScale(value, layoutScale);
        if (sameScale(currentScale, layoutScale)) { clearPending(); return 1; }
        const remaining = lastCommitAt + interval - now();
        if (remaining <= 0) { commit(); return 1; }
        if (timer === null) timer = setTimer(() => { timer = null; commit(); }, remaining);
        return currentScale / layoutScale;
    }
    function sync(value) {
        if (disposed) return 1;
        clearPending();
        currentScale = layoutScale = validScale(value, layoutScale);
        lastCommitAt = now();
        onLayoutScale(layoutScale);
        return 1;
    }

    return {
        get layoutScale() { return layoutScale; },
        update,
        sync,
        dispose() { if (disposed) return; clearPending(); disposed = true; },
    };
}
