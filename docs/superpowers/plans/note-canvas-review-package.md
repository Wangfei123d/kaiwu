# Scoped current-worktree review package

Base/HEAD: ab1373e5d617257ed8069a4d1d07383df636747c. No task commits exist: user explicitly authorized direct edits and preserving the dirty working tree. A branch-wide diff would include unrelated prior user work. This package therefore names the new files to read in full and exact shared-file task hunks; review actual files, not only implementer prose.

## Task 2 new files (all contents belong to this task)

- plugins/note-canvas/plugin.json
- plugins/note-canvas/index.js
- plugins/note-canvas/canvas-view.js
- plugins/note-canvas/navigation.js
- plugins/note-canvas/session.js
- plugins/note-canvas/style.css
- tests/canvas-navigation.test.js
- tests/canvas-session.test.js
- tests/note-canvas-integration.test.js
- tools/check-note-canvas.cjs

## Shared Task 2 hunks

app/main.js adoption object and app/lib/panel-tree.js DEFAULT_ADOPTION each add:

```diff
+ 'note-canvas': { anchor: 'doc', dir: 'row', sizes: [60, 40] },
```

Do not attribute other dirty hunks to Task 2.

## Whole-feature integration inputs

Task 1 new files: app/lib/note-canvas.js, electron/notes/canvas-ipc.js, tests/note-canvas.test.js, tests/note-canvas-ipc.test.js.
Task 1 shared additions: canvas permission in app/lib/manifest-schema.js; ctx.canvas in app/runtime/ctx.js; eight canvas IPC channels in electron/preload.cjs; registerCanvasIpc wiring in electron/main.js; optional beforeWrite/maxBytes safety hooks in electron/notes/note-index.js. Storage report/review describe these precisely.

Usage: docs/note-canvas.md. Reports: note-canvas-storage-report.md, note-canvas-storage-review.md, note-canvas-ui-report.md. Requirements: note-canvas-ui-brief.md and 2026-10-09-note-canvas.md (Global Constraints and Task 3).

Root fresh full test result: 2027 total / 2026 pass / 1 skip / 0 fail, 14481.5412ms. Browser and targeted test evidence in UI report. Review is read-only; isolated diagnostics only, no real Vault/app/browser mutation.
