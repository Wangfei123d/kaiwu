# Task 2 implementation report

Status: complete. No files staged, reverted, or committed. Focused validation passed; full suite intentionally deferred to Task 5.

## Files changed

- `electron/main.js`: initialize `let win = null` before menu construction; assign after `createWindow()` returns; use a null/destroyed guard for `onAddView`; provide `onOpenPreferences` that sends only the fixed `menu:open-preferences` channel with no payload. Replace obsolete TDZ comment with the actual early-menu lifecycle explanation.
- `electron/preload.cjs`: add `onOpenPreferences(callback)` with synchronous nonfunction validation and `bridge.on('menu:open-preferences', () => callback())`. Existing subscription wrapper strips the Electron event and returns the listener disposer.
- `tests/preload-preferences.test.js`: execute real preload source in `node:vm` with a minimal Electron mock. Assert method existence, several nonfunction inputs, zero callback arguments, returned disposer, removal of the identical registered listener, and listener-map removal.

## RED evidence

Test was created before production source changes.

Command (working directory `E:\project\kaiwu`):

```text
node --test tests/preload-preferences.test.js
```

Exit code: 1. Relevant output:

```text
tests 1
pass 0
fail 1
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected
+ 'undefined'
- 'function'
at tests/preload-preferences.test.js:30:12
```

This is the required missing-method assertion. VM initialization succeeded and produced the bridge before the assertion.

## GREEN evidence

Required command:

```text
node --check electron/main.js; node --check electron/preload.cjs; node --test tests/preload-preferences.test.js tests/app-menu.test.js
```

Exit code: 0. Relevant test output:

```text
✔ 编辑菜单在 Windows 与 macOS 都提供首选项入口
✔ 首选项事件只传零参数并能取消订阅
tests 9
pass 9
fail 0
cancelled 0
skipped 0
todo 0
```

Individual syntax exit codes were then confirmed explicitly:

```powershell
node --check electron/main.js
Write-Output "main syntax exit: $LASTEXITCODE"
node --check electron/preload.cjs
Write-Output "preload syntax exit: $LASTEXITCODE"
```

Output: `main syntax exit: 0`, `preload syntax exit: 0`.

## Self-review

Compared both production files to `.superpowers/sdd/snapshots/task-2/electron/` using `git diff --no-index`. Task changes are limited to the menu lifecycle variable, two guarded callbacks, comment correction, window assignment, and the dedicated preload subscription method. Pre-existing unrelated staged/unstaged changes remain in place.

Main sends no event payload. The page callback intentionally receives zero arguments, even though generic `bridge.on` supplies a payload argument; the zero-argument adapter is essential here. Invalid callbacks throw before registering a listener. Disposal removes the exact wrapper registered for the fixed channel. Initial menu creation can safely precede window creation, and retained callbacks safely no-op after destruction.

Concerns/limits: no live Electron interaction or broad suite run in this task. Main-process lifetime guards were reviewed against the brief; the focused automated test exercises the preload contract and existing menu-template tests. Task 5 owns broad integration validation.

Environment: initial default-sandbox project read was denied. Retrying authorized project reads and Node checks with `require_escalated` succeeded. All local edits used `apply_patch`.
