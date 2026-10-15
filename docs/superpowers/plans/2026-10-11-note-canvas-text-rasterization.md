# 笔记画布放大文字清晰度实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make note-canvas node text crisp after zooming in while keeping the existing smooth navigation behavior.

**Architecture:** Keep the current CSS transform and navigation math. Add a regression test for the `.nc-world` compositor hint, then remove only its persistent `will-change: transform` declaration so Chromium can rasterize text at the settled zoom scale.

**Tech Stack:** Electron/Chromium, CSS, Node.js built-in test runner.

## Global Constraints

- Preserve smooth navigation, the current CSS transform, scale bounds, coordinate conversion, nodes, SVG connections, and saved canvas data.
- Remove only the persistent `.nc-world` `will-change: transform` hint; do not introduce layout zoom or inverse-scaled text.
- If text remains blurry after the focused visual check, stop and investigate the rendering architecture again instead of stacking speculative fixes.
- The existing `plugins/note-canvas` tree is untracked user work. Do not stage or commit its CSS file, because doing so would capture the entire pre-existing file.

---

### Task 1: Remove the persistent compositor hint with a regression test

**Files:**
- Create: `tests/note-canvas-text-rendering.test.js`
- Modify: `plugins/note-canvas/style.css` (`.nc-world` rule only)

**Interfaces:**
- Consumes: the note-canvas stylesheet and existing `canvas-navigation.test.js` behavior.
- Produces: a test proving `.nc-world` is not permanently pinned for transform compositing while retaining its origin alignment.

- [x] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../plugins/note-canvas/style.css', import.meta.url), 'utf8');
const worldRule = css.match(/\.nc-world\s*\{([^}]*)\}/)?.[1] ?? '';

test('note canvas world does not permanently force transform compositing for text', () => {
    assert.ok(worldRule, 'the note canvas world rule exists');
    assert.doesNotMatch(worldRule, /\bwill-change\s*:\s*transform\b/i);
    assert.match(worldRule, /\btransform-origin\s*:\s*0\s+0\b/i);
});
```

- [x] **Step 2: Run the test and confirm the expected failure**

Run: `node --test tests/note-canvas-text-rendering.test.js`
Expected: FAIL because `.nc-world` currently declares `will-change: transform`.

- [x] **Step 3: Make the smallest implementation change**

In `plugins/note-canvas/style.css`, remove only `will-change:transform;` from `.nc-world`. Keep `position`, `inset`, `transform-origin`, and `pointer-events` unchanged.

- [x] **Step 4: Run focused regression tests**

Run: `node --test tests/note-canvas-text-rendering.test.js tests/canvas-navigation.test.js tests/note-canvas-theme.test.js tests/note-canvas-port-hover.test.js`
Expected: all tests pass, including the existing smooth-navigation scale-bound and pointer-anchor assertions.

- [x] **Step 5: Preserve the shared worktree state**

Inspect `git status --short` and leave the change unstaged and uncommitted. The stylesheet was already an untracked user file before this task; staging it would capture pre-existing user content unrelated to the one declaration being removed.

## Outcome / follow-up

The focused test suite passed (16/16), but the post-reload visual check still showed blurry node text. Therefore this minimal change does not meet the goal. The `.nc-world` still receives `translate(...) scale(...)` from `canvas-view.js` on every navigation frame, so removing the compositor hint alone does not change the scaled-world rendering architecture. Stop here rather than applying an unapproved layout-zoom or per-node scaling redesign; agree on that next design before changing zoom/layout behavior. The full `npm test` run was interrupted after an unrelated process-tree cleanup test failed and emitted no final suite summary.
