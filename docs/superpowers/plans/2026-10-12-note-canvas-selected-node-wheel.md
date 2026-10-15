# Note Canvas Selected-Node Wheel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make node-body wheel input work only when its owning note-canvas node is selected.

**Architecture:** Keep the existing per-body smooth-scroll controller, but pass each node ID into it and gate motion by the current `selected` set. Always prevent native wheel scrolling inside node bodies; selected nodes keep current smooth scrolling and Ctrl/⌘ canvas zoom, while unselected nodes do nothing. Canvas wheel behavior outside node bodies remains unchanged.

**Tech Stack:** Electron renderer JavaScript, Node.js built-in test runner.

## Global Constraints

- Ordinary wheel over a selected node scrolls that node body.
- Ctrl/⌘ + wheel over a selected node retains the existing canvas zoom behavior.
- Wheel over an unselected node body is prevented from native scrolling and triggers neither node motion nor canvas navigation.
- Wheel navigation outside node bodies is unchanged.
- After code changes, restart Kaiwu and verify it launches.

---

### Task 1: Gate smooth node scrolling on selection

**Files:**
- Modify: `plugins/note-canvas/canvas-view.js`
- Test: `tests/note-canvas-theme.test.js`

**Interfaces:**
- `attachBodyScroll(body, nodeId)` consumes the scrollable DOM element and its owning graph-node ID. It continues to use the existing `selected` set, `visible()` check, `wheelDelta()`, `createNavigation()`, and `wheelNavigation()` helpers.
- Text-node Markdown content, Markdown-file content, and the outer node body all pass `node.id` to `attachBodyScroll`.

- [x] **Step 1: Add the failing selection-gate test**

Add this test to `tests/note-canvas-theme.test.js`:

```js
test('note canvas only scrolls a selected node body', () => {
    assert.match(canvasView, /function attachBodyScroll\(body,nodeId\)/,
        'node scroll handler receives its owning node ID');
    assert.equal(canvasView.split("attachBodyScroll(body,node.id)").length - 1, 1,
        'the outer node body is associated with its owning graph node');
    assert.equal(canvasView.split("attachBodyScroll(body.querySelector('.live-markdown-content'),node.id)").length - 1, 2,
        'text and file Markdown scroll areas are associated with their owning graph node');
    assert.match(canvasView,
        /body\.addEventListener\('wheel',event=>\{event\.preventDefault\(\);event\.stopPropagation\(\);if\(!visible\(\)\|\|!selected\.has\(nodeId\)\)return;/,
        'unselected node bodies suppress native scrolling without starting smooth node or canvas motion');
});
```

- [x] **Step 2: Run the test to confirm RED**

Run: `node --test tests/note-canvas-theme.test.js`

Expected: the new test fails because `attachBodyScroll` has no node ID parameter and its call sites do not pass one.

- [x] **Step 3: Implement the minimal selection gate**

In `plugins/note-canvas/canvas-view.js`:

1. Change the text-node Markdown call to `attachBodyScroll(body.querySelector('.live-markdown-content'),node.id)`.
2. Change the node-body call to `attachBodyScroll(body,node.id)`.
3. Change the Markdown-file call to `attachBodyScroll(body.querySelector('.live-markdown-content'),node.id)`.
4. Change the function signature to `function attachBodyScroll(body,nodeId)`.
5. Keep the wheel event's `preventDefault()` and `stopPropagation()` first, then return when `!visible() || !selected.has(nodeId)`. Keep the existing selected-node Ctrl/⌘ zoom and smooth scroll code after that guard.

- [x] **Step 4: Run the focused and related tests**

Run: `node --test tests/note-canvas-theme.test.js tests/note-canvas-rendering.test.js tests/note-canvas-text-rendering.test.js tests/canvas-navigation.test.js`

Expected: all tests pass, including the new ownership/selection assertions and the existing smooth-navigation checks.

- [x] **Step 5: Restart Kaiwu and verify launch**

Use the computer-use procedure to close the running Kaiwu window gracefully, launch it again with the project's existing start script, then confirm the Kaiwu window appears and its canvas loads. Do not modify user canvas contents during this check.

Expected: Kaiwu relaunches successfully; node-body scroll behavior is covered by the focused regression test.
