# 笔记画布节点重排节奏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit visible updates for the note-canvas main viewport to at most one publication per 25ms while keeping navigation interpolation and final viewport state exact.

**Architecture:** Add an optional `minFrameIntervalMs` publication gate to `createNavigation`, defaulting to `0` so existing consumers remain unchanged. Configure only the note-canvas main navigation with `25`; its body scroll navigators continue publishing every animation frame. The navigation model still integrates each animation frame, while the canvas applies complete coherent snapshots and always receives an exact final snapshot.

**Tech Stack:** JavaScript ES modules, Node.js built-in `node:test`, Electron renderer canvas.

## Global Constraints

- Main note-canvas publication minimum interval: `25ms`.
- Other navigation consumers default to `0ms` and keep existing per-frame behavior.
- Final animation state, `set()`, reduced-motion updates, and explicit `stop()` must not remain visually stale.
- Preserve layout-level CSS `zoom`, pointer anchoring, the current scale bounds, and all saved graph data.
- Do not alter Markdown input re-rendering, note autosave, or node-body scrolling cadence.

---

### Task 1: Add optional view-publication cadence to navigation

**Files:**
- Modify: `plugins/note-canvas/navigation.js`
- Test: `tests/canvas-navigation.test.js`

**Interfaces:**
- Consumes: existing `createNavigation({ view, onFrame, onSettled, requestFrame, cancelFrame, now, reducedMotion })` API.
- Produces: optional `createNavigation({ minFrameIntervalMs: number })`; default `0` preserves current callback cadence.

- [x] **Step 1: Write the failing cadence test**

Add to `tests/canvas-navigation.test.js`:

```js
test('minimum frame interval coalesces published views while the navigation state keeps advancing', () => {
    const c = clock({ minFrameIntervalMs: 25 });
    c.nav.zoom(2, 250, 180);

    c.step(25);
    const firstPublishedScale = c.seen.at(-1).scale;
    const publishedCount = c.seen.length;
    const anchor = { x: 250, y: 180 };

    c.step(16);
    assert.equal(c.seen.length, publishedCount, '未到 25ms 时不应重复发布节点布局');
    assert.ok(c.nav.view.scale > firstPublishedScale, '内部导航插值仍应逐帧前进');
    c.step(8);
    assert.equal(c.seen.length, publishedCount, '24ms 仍应合并中间帧');
    c.step(1);
    assert.equal(c.seen.length, publishedCount + 1, '达到 25ms 后应发布最新视图');
    for (const view of c.seen) {
        close((anchor.x - view.x) / view.scale, anchor.x);
        close((anchor.y - view.y) / view.scale, anchor.y);
    }
});
```

- [x] **Step 2: Run the test and confirm the expected failure**

Run: `node --test tests/canvas-navigation.test.js`

Expected: the new test fails at the first `assert.equal(c.seen.length, publishedCount)` because the current navigation emits every animation frame.

- [x] **Step 3: Implement the minimal publication gate**

In `createNavigation` destructure `minFrameIntervalMs = 0` and normalize it to a finite non-negative interval. Keep `current` integration unchanged. Use this publication helper and cancellation path:

```js
const frameInterval = Number.isFinite(minFrameIntervalMs) ? Math.max(0, minFrameIntervalMs) : 0;
let nextPublishAt = Number.NEGATIVE_INFINITY;
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
    frame = null;
    target = { ...current };
    anchor = null;
    inertia = null;
    if (flush && wasRunning && !disposed) emit(true);
}
```

In `tick(stamp)`, use `emit(true, stamp)` in the settled branch before `onSettled`, and `emit(false, stamp)` in the continuing branch. Keep the existing animation scheduling condition after emission. Expose `stop() { cancel(true); }`; make `set()` call `cancel(false)` before assigning its new state and force-publish once; make `dispose()` call `cancel(false)` before setting `disposed = true`. In the reduced-motion branch, call `cancel(false)`, assign `current = { ...target }`, then force-publish and settle once. This ensures direct operations do not publish an obsolete state before the new one.

- [x] **Step 4: Add final-state and stop/set regression tests**

Add to `tests/canvas-navigation.test.js`:

```js
test('settled and explicitly stopped navigation publish the exact visible final view', () => {
    const settled = [];
    const c = clock({ minFrameIntervalMs: 25, onSettled: view => settled.push(view) });
    c.nav.zoom(1.8, 120, 90);
    c.settle();
    assert.deepEqual(c.seen.at(-1), c.nav.view);
    assert.deepEqual(settled.at(-1), c.nav.view);

    c.nav.pan(90, 0);
    c.step(25);
    c.step(8);
    const beforeStop = c.seen.length;
    c.nav.stop();
    assert.equal(c.seen.length, beforeStop + 1, '停止时应立即补上尚未发布的最新视图');
    assert.deepEqual(c.seen.at(-1), c.nav.view);

    c.nav.set({ x: 7, y: 8, scale: 1.25 });
    assert.deepEqual(c.seen.at(-1), c.nav.view, '直接设置视图不应受节流影响');

    const instant = clock({ minFrameIntervalMs: 25, reducedMotion: true });
    instant.nav.zoom(1.4, 120, 90);
    assert.deepEqual(instant.seen.at(-1), instant.nav.view, '减少动态效果模式仍应立即发布');
    assert.equal(instant.pending, 0);
});
```

- [x] **Step 5: Run the navigation tests**

Run: `node --test tests/canvas-navigation.test.js`

Expected: all navigation tests pass, including the new cadence and flush cases; existing default-cadence tests remain green.

### Task 2: Enable cadence only for the note-canvas main view

**Files:**
- Modify: `plugins/note-canvas/canvas-view.js`
- Test: `tests/note-canvas-integration.test.js`

**Interfaces:**
- Consumes: `createNavigation({ minFrameIntervalMs })` added in Task 1.
- Produces: the main canvas navigation uses `minFrameIntervalMs: 25`; body-scroll navigation keeps the default.

- [x] **Step 1: Write a failing configuration regression test**

Add to `tests/note-canvas-integration.test.js`:

```js
test('only the note-canvas main view enables the 25ms publication interval', () => {
    const source = fs.readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');
    const mainNavigation = source.match(/const nav=createNavigation\(\{[\s\S]*?onSettled:/)?.[0] ?? '';
    const bodyNavigation = source.match(/scrollNav=createNavigation\(\{[\s\S]*?\}\);scrollNavigations/)?.[0] ?? '';
    assert.match(mainNavigation, /minFrameIntervalMs:\s*25/);
    assert.doesNotMatch(bodyNavigation, /minFrameIntervalMs/);
});
```

- [x] **Step 2: Run the test and confirm the expected failure**

Run: `node --test tests/note-canvas-integration.test.js`

Expected: the new test fails because the main navigation has no configured interval yet.

- [x] **Step 3: Configure only the main navigation**

Replace the existing main-navigation construction with:

```js
const nav=createNavigation({view:{x:40,y:40,scale:1},minFrameIntervalMs:25,reducedMotion:reduced,onFrame:view=>{
    if(!visible()){nav.stop();return;}const styles=canvasViewStyles(view);world.style.transform=styles.worldTransform;zoomLayer.style.zoom=styles.zoom;
    canvas.style.backgroundPosition=styles.backgroundPosition;canvas.style.backgroundSize=styles.backgroundSize;
},onSettled:()=>saveViewport()});
```

Leave `attachBodyScroll`'s `scrollNav=createNavigation({view:{x:0,y:0,scale:1},reducedMotion:reduced,onFrame:...})` unchanged, so node-body scroll cadence remains at the default `0ms` interval.

- [x] **Step 4: Run focused tests**

Run: `node --test tests/canvas-navigation.test.js tests/note-canvas-integration.test.js tests/note-canvas-rendering.test.js tests/note-canvas-theme.test.js tests/note-canvas-port-hover.test.js`

Expected: all focused tests pass.

- [x] **Step 5: Review the final diff and runtime constraints**

Run: `git diff -- plugins/note-canvas/navigation.js plugins/note-canvas/canvas-view.js tests/canvas-navigation.test.js tests/note-canvas-integration.test.js`

Confirm only cadence, synchronization, and regression coverage changed. Do not stage or commit implementation files; the working tree already contains unrelated staged and unstaged work.
