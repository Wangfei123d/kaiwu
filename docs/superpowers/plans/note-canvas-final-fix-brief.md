# Note canvas final fix wave

Read this first: requirements for a single scoped fix wave in the user-authorized direct dirty workspace E:/project/kaiwu. No commits/stage/reset/restart, user browser, real Vault, paid calls, unrelated edits. Use apply_patch and TDD; E: shell reads need require_escalated/login:false. Node D:/nodejs/node.exe. Review actual existing UI report and check fixture before editing.

## Important finding (independently reproduced)

canvas-view.js connect() (about line155) inserts an edge without verifying source/target still exist in the current graph. deleteSelection() and newBoard() leave portSource from deleted/old-board nodes intact. Backend correctly rejects dangling edges, but renderer hides them, so later saves remain blocked without a visible invalid-edge removal control.

Repro A: create two text cards; select first and click its port; Delete source; click remaining card port; save. Repro B: click old board card port; create new board; add text card; click its port; save. Independent isolated Edge + real IPC confirmed both: '连线端点不存在', zero visible edges, submitted graph has absent source.

## Required fix and acceptance

- Clear pending connection state on source removal and board/session transitions (including newBoard); clear connecting visual state consistently.
- Before inserting any edge, verify source and target belong to the current session graph, preventing stale/canceled pointer gestures as well as click paths. Keep self-connection rejection and normal valid click/drag connections working.
- Write two regression assertions in tools/check-note-canvas.cjs using actual plugin and temporary Vault. Observe actual RED with unchanged production code for both, then implement and observe GREEN; assert graph endpoints are valid and saves succeed, not only absence of displayed errors. Add scoped unit tests if useful, but do not replace real-browser assertions.
- Run covering tests: node --test tests/canvas-navigation.test.js tests/canvas-session.test.js tests/note-canvas-integration.test.js and node tools/check-note-canvas.cjs. Run syntax and scoped diff--check. Main runs whole suite after stable handoff.

Owned files: plugins/note-canvas/canvas-view.js, tools/check-note-canvas.cjs, any narrowly necessary regression tests; append report to docs/superpowers/plans/note-canvas-ui-report.md. No backend/shared app file changes expected.

Do not expand scope for the separately documented Minor: stopping animation mid-way may not persist the intermediate camera position. Record it, no core content loss.

Report contract: append changed files, exact RED command/failing assertion for each repro, GREEN commands/results, self-review, remaining concerns. Return under15 lines DONE/DONE_WITH_CONCERNS/BLOCKED, no commits, concise test summary, report path. Stop source edits when stable so independent re-review can proceed.
