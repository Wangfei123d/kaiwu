# Standalone Preferences Window and Notes Button Removal

## Goal

Remove the **笔记** button from the main window's top bar and make global preferences available in a dedicated window opened from **编辑 > 首选项…**. Plugin-specific settings remain in their respective plugin panels.

## Current state

- **编辑 > 首选项…** already exists in `electron/app-menu.js` and calls an optional main-process callback.
- The main process currently forwards the menu action to the primary renderer as `menu:open-preferences`.
- The global settings UI is implemented by `app/settings/settings-view.js` and is embedded as a full-screen pane in `app/index.html`.
- Main-window actions passed into the settings view include resetting the workspace layout, opening vault onboarding, and applying motion preferences. A separate renderer cannot directly call these main-renderer functions.
- The top bar currently includes a **笔记** view button. Notes are also the main workbench and should remain visible in the primary window while Preferences is open.

## Chosen design

Open a dedicated, modeless Electron `BrowserWindow` for global preferences. Reuse `createSettingsView` and its existing controls rather than duplicating the preferences UI or launching another full workbench. The window is a singleton: selecting **编辑 > 首选项…** while it is open focuses it; after it closes, the menu creates a fresh window. The primary window remains usable and stays on Notes.

Create a lightweight preferences page/renderer entry point that loads the existing settings view. Fetch its initial index and vault state through existing allow-listed bridge calls. Persisted preferences continue to use the existing settings IPC APIs. Route the three main-window-only actions through narrowly scoped, fixed IPC messages: reset the main workspace layout, open vault onboarding in the main renderer, and apply a motion preference there. Do not add a generic renderer-to-renderer command channel or expose arbitrary IPC.

Remove the **笔记** top-bar button and view-tab navigation when no longer needed. Notes remain the main window's content; the preferences window is reached through the application menu.

## Preserved boundaries

- Global application settings live in the Preferences window.
- Plugin-specific controls, including plugin-owned credentials and configuration, stay in their respective plugin panels.
- Existing settings search, sections, values, persistence, and controls remain available.
- The Preferences window does not initialize a second workbench or AI session.

## Alternatives considered

1. **Standalone modeless Preferences window (chosen).** It removes the top-bar button while keeping Notes accessible, reuses the existing settings component, and has predictable singleton/focus behavior.
2. **Keep Preferences as a pane in the main window.** This conflicts with the requested independent window and would replace the Notes workbench while settings are open.
3. **Load the whole main application in another window.** This would initialize duplicate workbench and AI features for a settings-only task.

## Behavior and acceptance criteria

- The main window has no **笔记** top-bar button or settings view tab; Notes remains its normal primary content.
- **编辑 > 首选项…** creates and shows a dedicated, non-modal Preferences window.
- Re-selecting the menu item focuses the existing Preferences window instead of creating a duplicate.
- Closing Preferences allows the menu item to create it again.
- The main window remains interactive while Preferences is open.
- Existing global settings controls, search, persisted values, and status data remain available in the Preferences window.
- Layout reset, vault change, and motion preference actions are applied to the main window through fixed, allow-listed IPC routes.
- Plugin-specific settings remain in their own plugin panels.
- Closing the primary window also closes its Preferences child window cleanly; no orphaned window remains.

## Scope

- Extract or host the settings pane in a dedicated preferences HTML/renderer entry point while reusing `createSettingsView`.
- Add singleton window lifecycle and focused-window behavior to `electron/main.js`.
- Keep menu ownership in `electron/app-menu.js` and add only the narrowly scoped IPC/preload APIs needed by the separate renderer.
- Remove the Notes button and obsolete view-tab switching from the primary renderer.
- Update existing assertions and self-test navigation to target the menu/window flow.
- Preserve plugin settings ownership.

## Risks and mitigations

- **Separate-renderer action ownership:** resetting layout, changing vault, and applying motion affect the main renderer. Use fixed IPC channels with explicit payload validation and dispatch only the known actions.
- **Window lifecycle:** retain one reference, focus it when already open, clear it on `closed`, and parent it to the main window so app shutdown closes both.
- **Stale settings snapshots:** load fresh index/vault state whenever a new Preferences renderer starts; continue using existing IPC for persisted settings and live status.
- **Layout styles assume the main shell:** give the preferences page a small dedicated wrapper or targeted style overrides while sharing the existing settings styles.

## Self-review

- The design honors the user's explicit request to remove the top-bar Notes button and their selected independent-window solution.
- It preserves the established boundary that plugin settings belong to plugin panels.
- It names all behavior needed to review the change: opening, focusing, closing, primary-window interaction, and main-renderer-only actions.
- IPC remains limited to specific operations; no arbitrary channel or command bridge is proposed.
- The existing in-main-window design is superseded because the user subsequently chose an independent Preferences window.
