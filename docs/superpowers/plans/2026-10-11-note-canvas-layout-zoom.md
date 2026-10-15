# 笔记画布布局级缩放实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply layout-level zoom to note-canvas content so node text is drawn more clearly at high zoom while preserving smooth navigation and coordinate behavior.

**Architecture:** Extract the per-frame CSS values into a small pure helper. Keep `.nc-world` as a translated pan container and put nodes, SVG edges, and marquee inside `.nc-zoom`, whose CSS `zoom` follows the navigation scale. Keep navigation state and logical coordinates unchanged.

**Tech Stack:** Electron/Chromium, CSS, JavaScript ES modules, Node.js built-in test runner.

## Global Constraints

- Preserve navigation scale bounds 0.25–2.5, smooth animation, pointer-anchored zoom, and viewport persistence.
- Preserve all note-canvas data and logical node/edge coordinates.
- Do not add dependencies or change other canvas features.
- Keep `.nc-world` translation-only; apply scale to a shared `.nc-zoom` wrapper containing nodes, SVG connections, and marquee.
- Do not stage or commit the pre-existing untracked `plugins/note-canvas/style.css` or other user files.

---

### Task 1: Define layout-zoom view mapping with a failing unit test

**Files:**
- Create: `plugins/note-canvas/rendering.js`
- Create: `tests/note-canvas-rendering.test.js`
- Modify: `plugins/note-canvas/canvas-view.js`

**Interfaces:**
- Produces `canvasViewStyles(view)` returning `{ worldTransform, zoom, backgroundPosition, backgroundSize }`.
- Produces `screenToWorld(clientX, clientY, rect, view)` for pointer conversion.
- `canvas-view.js` consumes both helpers without changing navigation state shape.

- [x] **Step 1: Write failing behavior tests**

Cover these assertions:

```js
assert.deepEqual(canvasViewStyles({x:24,y:-18,scale:2}), {
  worldTransform:'translate(24px, -18px)', zoom:'2',
  backgroundPosition:'24px -18px', backgroundSize:'48px 48px'
});
assert.deepEqual(screenToWorld(274,162,{left:100,top:40},{x:24,y:-18,scale:2}), {x:75,y:70});
```

- [x] **Step 2: Run the new test and confirm expected failure**

Run: `node --test tests/note-canvas-rendering.test.js`
Expected: FAIL because `rendering.js` does not yet export the tested helpers.

- [x] **Step 3: Implement the pure mapping helpers**

Implement `rendering.js` with these helpers:

```js
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function canvasViewStyles(view = {}) {
  const x = finite(view.x, 0), y = finite(view.y, 0), scale = finite(view.scale, 1);
  return {
    worldTransform: `translate(${x}px, ${y}px)`,
    zoom: String(scale),
    backgroundPosition: `${x}px ${y}px`,
    backgroundSize: `${24 * scale}px ${24 * scale}px`,
  };
}

export function screenToWorld(clientX, clientY, rect, view) {
  return {
    x: (clientX - rect.left - view.x) / view.scale,
    y: (clientY - rect.top - view.y) / view.scale,
  };
}
```

The outer transform must remain translation-only; `scale` is used for CSS `zoom` and grid spacing.

- [x] **Step 4: Run the new test and confirm it passes**

Run: `node --test tests/note-canvas-rendering.test.js`
Expected: all mapping and pointer-coordinate assertions pass.

### Task 2: Put canvas content under the layout-zoom layer

**Files:**
- Modify: `plugins/note-canvas/canvas-view.js`
- Modify: `plugins/note-canvas/style.css`
- Modify: `tests/note-canvas-text-rendering.test.js`

**Interfaces:**
- `.nc-world` remains the translated outer pan layer.
- `.nc-zoom` becomes the common parent of `.nc-connections` and `.nc-nodes`.
- The existing navigation `onFrame` callback applies the helper output to the outer transform, inner `zoom`, and canvas grid.

- [x] **Step 1: Add a failing structure regression assertion**

Assert that `.nc-world` has no `will-change: transform`, `.nc-zoom` has no `transform: scale(...)`, `canvas-view.js` contains `zoomLayer.append(svg,nodes)` followed by `world.append(zoomLayer)`, and the frame callback uses `zoomLayer.style.zoom`.

- [x] **Step 2: Run the focused test and confirm expected failure**

Run: `node --test tests/note-canvas-text-rendering.test.js`
Expected: FAIL until the shared zoom layer and translation-only mapping are wired.

- [x] **Step 3: Integrate the layout zoom layer**

Create `.nc-zoom`, append SVG and nodes to it, and append it to `.nc-world`. In `onFrame`, set outer `transform` from `worldTransform`, set `.nc-zoom.style.zoom`, and keep background grid size/position synchronized. Replace the inline pointer formula with `screenToWorld`.

- [x] **Step 4: Run focused navigation and canvas regression tests**

Run: `node --test tests/note-canvas-rendering.test.js tests/note-canvas-text-rendering.test.js tests/canvas-navigation.test.js tests/note-canvas-theme.test.js tests/note-canvas-port-hover.test.js tests/note-canvas-integration.test.js`
Expected: all tests pass, including anchor/bounds, port behavior, theme, and shared zoom-layer assertions.

- [x] **Step 5: Review exact worktree scope**

Run: `git status --short`; confirm only this task's helper/test additions, its small `canvas-view.js` edits, and intended plan/spec files are new changes beyond the already dirty project tree. Leave all implementation changes unstaged and uncommitted.

### Task 3: Verify whole test suite and report visual limitation

- [x] **Step 1: Run the full test suite once**

Run: `npm test`
Expected: record complete totals; report any known process-cleanup failure without claiming a clean suite.

- [ ] **Step 2: Hand off the app reload check**

Because the running Kaiwu window was not available through the approved UI browser surface, do not claim visual sharpness or restart the user's app. Report that the layout-zoom implementation is ready for their existing restart/visual check, focusing on high zoom, pan anchoring, node drag/resize, ports, and connections.

## Current verification result

- RED confirmed: before implementation, helper exports were missing and the shared `.nc-zoom` layer assertion failed.
- Focused verification passed: 21 tests across rendering mapping, canvas navigation, integration, theme, ports, and text-rendering structure.
- `npm test` was attempted. It reproduced the existing `killImpl 连派生出来的孙进程一起杀掉` failure and then produced no output for over a minute; the run was interrupted, so there is no full-suite summary.
- The running app could not be inspected through the approved UI surface. High-zoom sharpness and interaction behavior still require a visual check after the user restarts Kaiwu.
