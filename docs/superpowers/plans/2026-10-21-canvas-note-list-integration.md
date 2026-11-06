# Canvas Files in the Note List Implementation Plan

> **For agentic workers:** Execute this plan inline in the current feature worktree. Preserve unrelated working-tree changes and do not commit or push.

**Goal:** Show `.canvas` boards as distinct file rows in the existing note tree and open the selected board in the existing canvas pane.

**Architecture:** Reuse the note index's existing `others` collection, because it already includes vault-local `.canvas` files and their paths. Special-case `.canvas` in the note renderer for icon, search, selection, and click routing; use narrow window events to open a requested board and refresh the note index when a board is created.

**Tech Stack:** Electron renderer modules, existing note index and canvas IPC, DOM events, CSS, Node syntax checks.

## Global Constraints

- Keep boards in the existing `画布/<name>.canvas` location; the canvas IPC currently accepts boards only from this directory.
- Do not send `.canvas` rows to the operating system or make them draggable into other folders.
- Preserve all unrelated dirty and untracked files in the worktree.
- Do not add or run tests for this request; use syntax and diff checks only.
- Do not commit or push.

## File Map

- `app/notes/notes-view.js`: recognize canvas rows, include them in search results, show the selected canvas, and call an injected open callback.
- `app/styles/shell.css`: draw a canvas-specific icon/accent and selected state in the existing file row.
- `app/main.js`: focus the existing `note-canvas` pane, dispatch open requests, refresh the note list after canvas creation, and synchronize selected-board state.
- `plugins/note-canvas/canvas-view.js`: receive validated open requests, emit opened-board and list-changed events.
- `docs/note-canvas.md`: document that `.canvas` files appear and open from the note tree.

---

### Task 1: Render canvas files in the note tree

**Files:**
- Modify: `app/notes/notes-view.js`
- Modify: `app/styles/shell.css`

**Interface:** `createNotesView` accepts `onOpenCanvas(path)` and exposes `selectCanvas(path)`; canvas paths remain vault-relative strings.

- [x] Identify `.canvas` rows by extension, render a safe DOM SVG icon and `.canvas` kind, keep their file path in `data-path`, and set `aria-selected` from the selected canvas path.
- [x] Route a canvas-row click through `onOpenCanvas(path)` rather than `notes:openPath`; do not bind the generic file move gesture to canvas rows because the canvas IPC only reads boards under `画布/`.
- [x] Include canvas files in flattened keyword search while leaving other binary-file search behavior unchanged.
- [x] Add CSS for the canvas icon color and selected row state.

### Task 2: Connect the row to the existing canvas pane

**Files:**
- Modify: `app/main.js`
- Modify: `plugins/note-canvas/canvas-view.js`

**Events:**
- `kaiwu:open-canvas` with `{ path }`: request to open a vault-relative `.canvas` board.
- `kaiwu:canvas-opened` with `{ path }`: the canvas pane reports its active board.
- `kaiwu:canvas-list-changed`: the canvas pane reports a newly created board.

- [x] In `app/main.js`, pass `onOpenCanvas`; call `workspaceApi.openView('note-canvas')` without a document key, then dispatch `kaiwu:open-canvas` with the selected path.
- [x] In `canvas-view.js`, validate the request shape and confirm the path exists in `library.boards`; refresh the library once if it is stale, then call the existing `openBoard(path)` and surface failures through `showError`.
- [x] After `openBoard` succeeds, emit `kaiwu:canvas-opened`; after `newBoard` refreshes its library, emit `kaiwu:canvas-list-changed`.
- [x] In `app/main.js`, use these events to update note-list selection and call `notesApi.refreshIndex({ keepSelection: true })` after creation.

### Task 3: Document behavior and check source integrity

**Files:**
- Modify: `docs/note-canvas.md`

- [x] Document the canvas type icon, the `.canvas` row in the note tree, and that selecting it opens the board in the canvas pane.
- [x] Run `D:\nodejs\node.exe --check app/notes/notes-view.js`, `D:\nodejs\node.exe --check app/main.js`, and `D:\nodejs\node.exe --check plugins/note-canvas/canvas-view.js`.
- [x] Run `git diff --check` and inspect the final focused diff without staging or committing unrelated changes.
