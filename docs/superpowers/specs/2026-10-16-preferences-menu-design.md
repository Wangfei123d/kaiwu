# Move global settings to Edit > Preferences

## Goal

Make **Edit > Preferences…** the only entry point for Kaiwu's global settings. Plugin-specific settings remain in their respective plugin panels.

## Current state

- `electron/app-menu.js` already declares **Edit > Preferences…** and invokes an optional callback.
- `electron/main.js` forwards that menu action to the renderer as `menu:open-preferences`.
- `electron/preload.cjs` exposes `onOpenPreferences`, but the renderer does not subscribe to it.
- The renderer currently exposes the global settings screen as a top-level **Settings** tab. Its existing search, sections, live status, persistence, and actions are implemented in `app/settings/settings-view.js`.

## Chosen approach

Wire the existing menu event to the existing settings screen, and remove the top-level **Settings** tab. Keep the current settings screen and its storage/API behavior intact. The menu action will switch the main renderer to that screen and trigger its existing refresh behavior.

Do not migrate plugin-specific controls such as Douyin Cookie configuration into global preferences. They stay in their plugin panels.

## Alternatives considered

1. **Reuse the current settings screen (chosen).** This is the smallest change, preserves its existing behavior, and makes the existing menu item functional.
2. **Create a separate native preferences window or modal.** This would make preferences visually distinct, but duplicates or relocates the existing settings screen and adds window lifecycle and state-synchronization work without a user requirement for a separate window.

## Behavior and acceptance criteria

- The top-level **Settings** tab is absent.
- Selecting **Edit > Preferences…** opens the existing global settings screen.
- The existing settings search, sections, values, and actions continue to work.
- Plugin-specific settings remain available in their own panels.
- The menu remains safe to invoke after renderer initialization; its event is handled through the existing preload bridge.

## Implementation scope

- Update `app/index.html` and `app/main.js` to remove the tab entry and subscribe to the preferences bridge event.
- Update existing assertions and descriptions that currently require Settings to be a top-level tab.

## Risks

- Existing tests or self-test assertions may depend on the Settings tab and need to be updated to assert the menu path instead.
- The settings screen remains a full renderer view rather than a separate native window; this follows the approved design.
