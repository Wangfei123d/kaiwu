# Note Canvas Click-to-Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make editable note-canvas nodes require one click to select and a second click on the same node to edit.

**Architecture:** Keep node selection and dragging in the existing canvas pointer handlers. Add a small consecutive-click gate at the canvas click layer; text and Markdown nodes stay rendered but read-only until armed, while TXT and group nodes open their existing modal editors on the second click. Explicit controls and non-editable image/link nodes keep their current behavior.

**Tech Stack:** Electron renderer JavaScript modules, Node.js test runner, existing isolated Edge integration harness.

## Global Constraints

- First click selects only; a subsequent click on the same editable node enters its existing edit mode.
- Text and `.md` nodes edit inline; `.txt` stays plain text in its existing editor; groups edit their label.
- Image and link nodes are not made editable by this change.
- Buttons, links, ports, resize handles, and drag gestures must not trigger node editing.
- Work only in the existing project checkout and preserve all unrelated local changes.

---

### Task 1: Implement and verify two-stage node editing

**Files:**
- Modify: `plugins/note-canvas/canvas-view.js`
- Modify: `tools/check-note-canvas.cjs`

**Interfaces:**
- Reuse `mountLiveMarkdown(...).setDisabled(boolean)` for the existing inline editor surfaces.
- Reuse `editNode(id)` for the existing TXT and group modal editors.
- Keep `.nc-node` identifiers in `data-node-id` and types in `data-type`.

- [x] **Step 1: Add failing real-browser regression checks**

In the isolated Edge harness, assert for a new text node that the first body click leaves its live Markdown surface disabled and the node selected, while the second click enables the inline editor. Repeat the sequence for a Markdown-file node, TXT node, and group; verify TXT still opens a plain-text textarea, group opens the label form, and image/link nodes do not open an editor. Include Escape-to-exit for inline editing and confirm a drag does not count as the second click.

- [x] **Step 2: Run the focused harness and confirm it fails on current behavior**

Run: `node tools/check-note-canvas.cjs`
Expected: FAIL at the first-click assertion because text nodes currently mount as immediately editable.

- [x] **Step 3: Implement minimal click gating in `canvas-view.js`**

Mount text and Markdown live surfaces disabled and retain their handles on the rendered cards. Record the first eligible node click; on the next eligible click for the same node, enable inline editing or call `editNode(id)` for TXT/group. Reset the pending click on a different node, blank canvas, non-node interaction, or drag. Remove the TXT/group one-click edit shortcuts and old double-click edit listeners so the two-stage rule is consistent. Exit inline edit when clicking elsewhere or pressing Escape.

- [x] **Step 4: Update the existing harness flow to use the new interaction**

Before editing text/Markdown nodes, click the same node twice. Open TXT/group editors through two node clicks rather than their removed shortcuts. Keep save/reload controls and existing drag, selection, and persistence checks intact.

- [x] **Step 5: Run focused and project test suites**

Run: `node tools/check-note-canvas.cjs`
Expected: PASS with the real isolated Edge harness summary and no page errors.

Run: `npm test`
Observed: the suite reported `killImpl 连派生出来的孙进程一起杀掉` as a failure, then stayed without further output for more than two minutes and was interrupted. This service-process cleanup issue is outside the note-canvas scope; no unrelated source was changed.

**Verification result:** `node tools/check-note-canvas.cjs` passes in isolated Edge, including text selection/drag/edit, Markdown selection with an existing text selection, TXT and group editing, and non-editable image/link nodes. Relevant note-canvas and live-Markdown Node tests are run separately.
