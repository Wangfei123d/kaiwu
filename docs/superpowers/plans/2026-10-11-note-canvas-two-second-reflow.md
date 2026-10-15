# 笔记画布两秒布局重排 Implementation Plan

> **For agentic workers:** Use this plan task-by-task with test-first changes. Preserve existing worktree changes and do not stage or commit implementation files.

**Goal:** Keep note-canvas navigation smooth at animation-frame cadence while committing expensive CSS layout zoom changes no more often than once per 2000ms.

**Architecture:** Add a small tested `createZoomLayout` controller that continuously publishes a temporary visual scale and rate-limits precise layout-scale commits. Keep the outer canvas translation and grid synchronized every navigation frame; wrap node and SVG content in `.nc-motion` so the product of committed CSS `zoom` and temporary `transform: scale()` equals the navigation scale. Board restoration and reduced-motion updates synchronize immediately.

**Tech Stack:** JavaScript ES modules, CSS `zoom` and `transform`, Node.js built-in `node:test`, Electron renderer.

## Global Constraints

- Precise interactive layout-scale commits are at least `2000ms` apart.
- Main canvas pan, visual zoom, and grid updates remain on every `requestAnimationFrame`.
- Only the latest scale is committed; stale intermediate scale values are never replayed.
- Board restoration and reduced-motion updates synchronize layout immediately.
- Pure panning and returning to the committed zoom do not schedule redundant layout work.
- Node-body scroll, Markdown editing, autosave, graph data, scale bounds, and pointer-anchor math remain unchanged.
- Do not stage or commit implementation files; the workspace contains unrelated existing changes.

---

### Task 1: Add a tested two-second layout zoom controller

**Files:**
- Create: `plugins/note-canvas/zoom-layout.js`
- Test: `tests/note-canvas-zoom-layout.test.js`

**Interfaces:**
- Consumes: `initialScale`, `intervalMs`, injected `now`, `setTimer`, and `clearTimer` functions.
- Produces: `createZoomLayout({ initialScale, intervalMs, now, setTimer, clearTimer, onLayoutScale })`, returning `layoutScale`, `update(scale)`, `sync(scale)`, and `dispose()`.
- `update(scale)` returns `currentScale / layoutScale` immediately; the canvas applies that ratio as its temporary transform.
- `onLayoutScale(scale)` receives only the precise layout commit; two interactive commits must be separated by at least `intervalMs`.

- [x] **Step 1: Write controller tests with a fake clock**

Add a fake timer clock and these behaviors to `tests/note-canvas-zoom-layout.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomLayout } from '../plugins/note-canvas/zoom-layout.js';

function fakeClock() {
    let time = 0, nextId = 0;
    const timers = new Map();
    return {
        now: () => time,
        setTimer(fn, delay) { const id = ++nextId; timers.set(id, { at: time + delay, fn }); return id; },
        clearTimer(id) { timers.delete(id); },
        advance(ms) {
            const end = time + ms;
            while (true) {
                const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!due || due[1].at > end) break;
                time = due[1].at; timers.delete(due[0]); due[1].fn();
            }
            time = end;
        },
        get pending() { return timers.size; },
    };
}

test('visual ratio tracks every update but layout commits latest scale at 2000ms', () => {
    const clock = fakeClock(), layouts = [];
    const zoom = createZoomLayout({ initialScale: 1, intervalMs: 2000, ...clock,
        onLayoutScale: scale => layouts.push({ at: clock.now(), scale }) });
    zoom.sync(1);
    assert.equal(zoom.update(1.2), 1.2);
    clock.advance(1000);
    assert.equal(zoom.update(1.8), 1.8);
    assert.deepEqual(layouts.map(item => item.scale), [1]);
    clock.advance(999);
    assert.deepEqual(layouts.map(item => item.scale), [1]);
    clock.advance(1);
    assert.deepEqual(layouts, [{ at: 0, scale: 1 }, { at: 2000, scale: 1.8 }]);
    assert.equal(zoom.update(1.8), 1);
    zoom.dispose();
});

test('returning to committed scale cancels pending layout and pure pan needs no reflow', () => {
    const clock = fakeClock(), layouts = [];
    const zoom = createZoomLayout({ initialScale: 1, intervalMs: 2000, ...clock,
        onLayoutScale: scale => layouts.push(scale) });
    zoom.sync(1);
    assert.equal(zoom.update(1.5), 1.5);
    assert.equal(zoom.update(1), 1);
    clock.advance(2000);
    assert.deepEqual(layouts, [1]);
    assert.equal(clock.pending, 0);
    zoom.dispose();
});

test('sync commits immediately and dispose cancels a waiting final layout', () => {
    const clock = fakeClock(), layouts = [];
    const zoom = createZoomLayout({ initialScale: 1, intervalMs: 2000, ...clock,
        onLayoutScale: scale => layouts.push({ at: clock.now(), scale }) });
    zoom.sync(1);
    assert.equal(zoom.update(1.7), 1.7);
    clock.advance(700);
    zoom.sync(1.4);
    assert.deepEqual(layouts, [{ at: 0, scale: 1 }, { at: 700, scale: 1.4 }]);
    zoom.update(1.8);
    zoom.dispose();
    clock.advance(3000);
    assert.deepEqual(layouts, [{ at: 0, scale: 1 }, { at: 700, scale: 1.4 }]);
    assert.equal(clock.pending, 0);
});
```

- [x] **Step 2: Run the test and confirm it fails for the missing module**

Run: `node --test tests/note-canvas-zoom-layout.test.js`

Expected: test loading fails because `plugins/note-canvas/zoom-layout.js` does not exist yet.

- [x] **Step 3: Implement the minimal controller**

Create `plugins/note-canvas/zoom-layout.js` with this behavior:

```js
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
        else if (timer === null) timer = setTimer(() => { timer = null; commit(); }, remaining);
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
```

- [x] **Step 4: Run controller tests and verify they pass**

Run: `node --test tests/note-canvas-zoom-layout.test.js`

Expected: all three timer, cadence, scale-reset, and disposal tests pass.

---

### Task 2: Keep canvas motion smooth while committing precise layout zoom

**Files:**
- Modify: `plugins/note-canvas/canvas-view.js`
- Modify: `plugins/note-canvas/rendering.js`
- Modify: `plugins/note-canvas/style.css`
- Test: `tests/note-canvas-rendering.test.js`
- Test: `tests/note-canvas-integration.test.js`

**Interfaces:**
- Consumes: `createZoomLayout()` from Task 1.
- Produces: `.nc-motion` wraps the connection SVG and node layer; the main canvas updates translation/grid every frame and uses `createZoomLayout` only for precise CSS layout zoom.

- [x] **Step 1: Update rendering tests before production changes**

Update `tests/note-canvas-rendering.test.js` so `canvasViewStyles(view, layoutScale)` returns world translation, a temporary transform ratio, and a grid synced to the current view:

```js
test('canvas view composes layout zoom and temporary scale without changing world coordinates', async () => {
    const { canvasViewStyles, screenToWorld } = await loadRendering();
    assert.deepEqual(canvasViewStyles({ x: 24, y: -18, scale: 2 }, 1.6), {
        worldTransform: 'translate(24px, -18px)',
        motionTransform: 'scale(1.6)',
        backgroundPosition: '24px -18px',
        backgroundSize: '48px 48px',
    });
    assert.equal(1.25 * 1.6, 2);
    assert.deepEqual(screenToWorld(274, 162, { left: 100, top: 40 }, { x: 24, y: -18, scale: 2 }), { x: 75, y: 70 });
});
```

- [x] **Step 2: Run the renderer test to confirm the new contract fails**

Run: `node --test tests/note-canvas-rendering.test.js`

Expected: the existing helper does not return `motionTransform`, so the new assertion fails.

- [x] **Step 3: Add scale-composition output to `canvasViewStyles`**

Change `canvasViewStyles(view = {})` in `plugins/note-canvas/rendering.js` to accept a second `motionScale` parameter (the ratio returned by `zoomLayout.update()`), normalize it to a finite positive value, and return:

```js
return {
    worldTransform: `translate(${x}px, ${y}px)`,
    motionTransform: `scale(${motionScale})`,
    backgroundPosition: `${x}px ${y}px`,
    backgroundSize: `${24 * scale}px ${24 * scale}px`,
};
```

Keep `screenToWorld()` unchanged; it continues using the current navigation scale.

- [x] **Step 4: Integrate the controller and wrapper in the note canvas**

In `plugins/note-canvas/canvas-view.js`:

1. Import `createZoomLayout` from `./zoom-layout.js`.
2. Create `motionLayer=el('div','nc-motion')`; append it inside `zoomLayer`, then append `svg` and `nodes` inside `motionLayer`.
3. Create the controller with `initialScale:1`, `intervalMs:2000`, and `onLayoutScale:scale=>zoomLayer.style.zoom=String(scale)`.
4. Remove `minFrameIntervalMs:25` from the main `createNavigation` options. In every `onFrame`, get `motionScale=zoomLayout.update(view.scale)`, calculate `canvasViewStyles(view, motionScale)`, update world translation and grid as before, and assign the returned `motionTransform` to the wrapper.
5. Before `nav.set()` in `openBoard()` and `newBoard()`, call `zoomLayout.sync()` with the saved viewport scale or `1`, respectively.
6. When reduced motion is active, call `zoomLayout.sync(view.scale)` instead of `update(view.scale)` so the existing immediate behavior remains precise.
7. Call `zoomLayout.dispose()` in the canvas cleanup path before removing DOM nodes.

Add `.nc-motion{position:absolute;inset:0;transform-origin:0 0;pointer-events:none}` to `plugins/note-canvas/style.css`; leave `.nc-node-body` overflow and scroll behavior unchanged.

- [x] **Step 5: Add the integration cadence guard**

In `tests/note-canvas-integration.test.js`, assert that the main canvas no longer configures `minFrameIntervalMs`, creates `createZoomLayout` with `intervalMs:2000`, and includes an `.nc-motion` wrapper. Also assert that the body-scroll navigation has no zoom-layout controller.

- [x] **Step 6: Run renderer and integration tests**

Run: `node --test tests/note-canvas-rendering.test.js tests/note-canvas-integration.test.js tests/note-canvas-zoom-layout.test.js`

Expected: all controller timing, scale composition, saved-view synchronization, and main-vs-body navigation tests pass.

---

### Task 3: Run focused regressions and review changed behavior

**Files:**
- Verify: `plugins/note-canvas/zoom-layout.js`
- Verify: `plugins/note-canvas/canvas-view.js`
- Verify: `plugins/note-canvas/rendering.js`
- Verify: `plugins/note-canvas/style.css`
- Verify: all tests listed below

- [x] **Step 1: Run focused navigation and canvas regression tests**

Run: `node --test tests/canvas-navigation.test.js tests/note-canvas-zoom-layout.test.js tests/note-canvas-integration.test.js tests/note-canvas-rendering.test.js tests/note-canvas-theme.test.js tests/note-canvas-port-hover.test.js`

Expected: all tests pass, including existing pointer-anchor, body scroll, theme, port hit-target, and resize behavior.

- [x] **Step 2: Review the final file contents and workspace status**

Read the changed files and confirm only the two-second visual/layout separation changed. Check only the relevant paths with `git status --short`; preserve all unrelated staged, unstaged, and untracked user work. Do not restart the currently running app unless the user asks, because it may contain live canvas state.
