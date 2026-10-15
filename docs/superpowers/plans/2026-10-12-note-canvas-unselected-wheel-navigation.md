# Note Canvas Unselected-Node Wheel Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let wheel input over an unselected note-canvas node pan the canvas, while selected nodes retain smooth body scrolling.

**Architecture:** Preserve the per-body scroll controller. Its wheel handler will allow an unselected event to bubble without cancelling it; selected nodes still cancel and handle the event. The canvas wheel handler will receive bubbled events from unselected node bodies and use the existing navigation function.

**Tech Stack:** Electron renderer JavaScript; Node.js built-in test runner.

## Global Constraints

- Wheel over an unselected node body pans the canvas and does not scroll the node body.
- Wheel over a selected node body continues to scroll that body smoothly.
- Ctrl/⌘ + wheel and wheel outside node bodies retain their existing behavior.
- Restart Kaiwu after the code change and confirm its startup logs.
- Do not commit the implementation files: the shared worktree already contains many staged edits and the affected canvas source is untracked user work.

---

### Task 1: Route unselected-node wheel events to canvas navigation

**Files:**
- Modify: `plugins/note-canvas/canvas-view.js`
- Test: `tests/note-canvas-theme.test.js`

**Interfaces:**
- Keep `attachBodyScroll(body,nodeId)`, `selected`, `wheelNavigation(event)`, and the existing smooth-navigation controllers; introduce no new public API.

- [x] **Step 1: Replace the old suppression assertion with a regression test**

Replace the test named `note canvas only scrolls a selected node body` with the test below. Also relax the existing scrollbar test's listener assertion so it checks that the body wheel listener remains attached, without requiring cancellation to happen before the selection gate:

```js
test('note canvas routes wheel over nodes according to selection', () => {
    assert.match(canvasView, /function attachBodyScroll\(body,nodeId\)/,
        'node scroll handler receives its owning graph-node ID');
    const bodyWheel = canvasView.match(/body\.addEventListener\('wheel',event=>\{([\s\S]*?)\},\{passive:false\}\)/)?.[1] ?? '';
    const selectionGate = bodyWheel.indexOf('if(!visible()||!selected.has(nodeId))return;');
    const cancellation = bodyWheel.indexOf('event.preventDefault()');
    assert.ok(selectionGate >= 0 && (cancellation < 0 || selectionGate < cancellation),
        'unselected node wheel events are not cancelled before they can bubble to the canvas');

    const canvasWheel = canvasView.match(/listen\(canvas,'wheel',event=>\{([\s\S]*?)\},\{passive:false\}\)/)?.[1] ?? '';
    assert.doesNotMatch(canvasWheel, /closest\('\.nc-node-body'\)/,
        'the canvas wheel handler does not discard bubbled events from node bodies');
    assert.match(canvasWheel, /event\.preventDefault\(\);wheelNavigation\(event\)/,
        'bubbled wheel events use the existing canvas navigation behavior');
});
```

- [x] **Step 2: Run the focused regression test and confirm RED**

Run: `node --test tests/note-canvas-theme.test.js`

Expected: the routing test fails because the current node-body handler cancels before checking selection and the canvas handler ignores every node body.

- [x] **Step 3: Make the minimal event-routing change**

In `plugins/note-canvas/canvas-view.js`, check visibility and selection before cancelling a node-body wheel event:

```js
body.addEventListener('wheel',event=>{
    if(!visible()||!selected.has(nodeId))return;
    event.preventDefault();
    event.stopPropagation();
    if(event.ctrlKey||event.metaKey){wheelNavigation(event);return;}
    const d=wheelDelta(event,body);
    scrollNav.pan(d.x,d.y,event.deltaMode===0&&Math.abs(event.deltaY)<50);
},{passive:false});
```

In the canvas wheel listener, remove the early return for `.nc-node-body`; selected-node handlers already stop their own wheel event, while unselected events now bubble here:

```js
listen(canvas,'wheel',event=>{event.preventDefault();wheelNavigation(event);},{passive:false});
```

- [x] **Step 4: Run focused and related tests**

Run: `node --test tests/note-canvas-theme.test.js tests/note-canvas-integration.test.js tests/canvas-navigation.test.js tests/note-canvas-rendering.test.js tests/note-canvas-text-rendering.test.js`

Expected: all tests pass, including the new event-order and bubbling regression assertions.

- [x] **Step 5: Check syntax, then restart Kaiwu**

Run: `node --check plugins/note-canvas/canvas-view.js`, followed by the existing project command `npm run start` after restarting the current app instance.

Expected: syntax check exits successfully; startup logs show the note canvas registered and plugins activated without startup errors. Do not modify user canvas contents during verification.
