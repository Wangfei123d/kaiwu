# Task 1 Report: Edit → 首选项…

## Result

Added the optional `onOpenPreferences` callback to `buildMenuTemplate` and appended a separator plus `首选项…` item after `全选` in the Edit menu. The preferences item's click handler invokes the callback optionally. The new behavior is covered for Windows and macOS, including preservation of the existing menu roles.

## Files changed for Task 1

- `tests/app-menu.test.js` — added a focused test for both platforms, checking the final three entries, callback invocation once per click, and unchanged undo/redo/cut/copy/paste/selectAll roles.
- `electron/app-menu.js` — added the optional callback parameter and the menu item.

`electron/app-menu.js` already had staged and unstaged changes before this task. Those prior edits were preserved; nothing was staged or committed.

## TDD evidence

RED command:

```text
node --test tests/app-menu.test.js
```

Representative output before implementation:

```text
✖ 编辑菜单在 Windows 与 macOS 都提供首选项入口
  Expected ... ['全选', 'separator', '首选项…']
  actual ... ['复制', '粘贴', '全选']
ℹ tests 8
ℹ pass 7
ℹ fail 1
```

GREEN command:

```text
node --test tests/app-menu.test.js tests/app-menu-window-panels.test.js
```

Representative output after implementation:

```text
✔ 编辑菜单在 Windows 与 macOS 都提供首选项入口
ℹ tests 15
ℹ pass 15
ℹ fail 0
```

## Review

The menu additions are limited to the end of the Edit submenu, after all existing standard roles. The callback is optional, so callers that do not supply it retain a non-throwing menu item. No commits were created.
