# Standalone Preferences Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the main-window Notes button and open global preferences in a singleton, modeless window from **编辑 > 首选项…**.

**Architecture:** Add a lightweight preferences renderer that reuses `createSettingsView`; keep the primary renderer responsible for workspace reset, vault onboarding, and applying motion. Add fixed IPC routes between the preferences window and the main process, with sender validation and narrowly scoped main-renderer notifications. The main window stays on Notes.

**Tech Stack:** Electron BrowserWindow, sandboxed preload bridge, vanilla JavaScript ES modules, existing CSS and renderer components.

## Global Constraints

- Plugin-specific settings remain in their respective plugin panels.
- Existing global settings storage and settings controls remain in use.
- The Preferences window is modeless and singleton; the menu focuses it if it is already open.
- IPC routes for main-window-only actions are fixed and allow-listed; no generic command bridge is introduced.
- Do not add or run tests for this task; update existing test/self-test source assertions where required and perform source-only checks.

---

### Task 1: Create a standalone Preferences renderer

**Files:**
- Create: `app/preferences.html` — standalone page shell and existing settings DOM anchors.
- Create: `app/preferences.js` — initialize the settings component and supply fresh vault/index readings plus fixed IPC action callbacks.
- Modify: `app/styles/settings-page.css` — make the settings pane fill a standalone page without the main shell grid.

**Interfaces:**
- Consumes: existing `createSettingsView`, bridge settings APIs, `notes:index`, `notes:vault:status`.
- Produces: a dedicated `toolbox://shell/preferences.html` page with the same search, sections, controls, and status readings.

- [x] Create the preferences HTML using shared token/base/settings styles and `#settingsSearch`, `#settingsOverview`, `#settingsNav`, and `#settingsBody` anchors.
- [x] Initialize `createSettingsView` with fresh vault/index data and IPC-backed layout reset, vault change, and motion callbacks.
- [x] Add standalone CSS so `.pane-settings` fills the window and scrolls correctly.

### Task 2: Add singleton window and fixed IPC routes

**Files:**
- Modify: `electron/main.js` — own the singleton BrowserWindow, open/focus lifecycle, sender-validated action handlers, and main-window action notifications.
- Modify: `electron/preload.cjs` — allow-list fixed action sends and subscriptions to main-window actions.

**Interfaces:**
- Consumes: existing menu callback `onOpenPreferences` and `BrowserWindow` creation security settings.
- Produces: `openPreferencesWindow()` creates/focuses the child window; preferences renderer can request only the fixed layout reset, vault change, and motion actions; a fixed layout-text request/report keeps the displayed tree synchronized.

- [x] Add one `preferencesWindow` reference; create a parented modeless `BrowserWindow` with the existing sandboxed preload/security options and load `toolbox://shell/preferences.html`.
- [x] Change the menu callback to focus the live preferences window or create it when closed.
- [x] Clear the reference on `closed`; make primary-window shutdown close the child naturally through the parent relationship.
- [x] Add the fixed action and layout-text channels to the preload send/on allowlists and expose narrow convenience methods.
- [x] Validate that incoming preference action messages originate from the current Preferences renderer before forwarding fixed events to the primary renderer.

### Task 3: Remove Notes view navigation and update existing assertions

**Files:**
- Modify: `app/index.html` — remove the Notes tab and embedded settings pane.
- Modify: `app/main.js` — remove settings-view ownership and Notes/settings tab switching; wire fixed main-window action listeners.
- Modify: `electron/selftest.js` — target the Preferences BrowserWindow for its existing settings assertions and replace removed Notes-tab clicks with direct Notes-pane checks.
- Modify: `app/lib/settings-page.js` and `tests/settings-page.test.js` — preserve/update the existing settings-view metadata assertion if still applicable after extraction.

**Interfaces:**
- Consumes: primary renderer's existing `workspaceRef`, `onboarding`, and `applyMotionOff` functions.
- Produces: the main window has Notes as its permanent content, no `.view-tab` or embedded preferences pane, and applies only the three fixed preference actions.

- [x] Remove the sole Notes `.view-tab` and obsolete `#paneSettings` section from `app/index.html`.
- [x] Remove `createSettingsView`, `switchView`, and `onOpenPreferences` usage from `app/main.js`; keep Notes as the sole workbench.
- [x] Register fixed main-window listeners for layout reset, vault onboarding, and motion changes, and remove unnecessary tab-click routing.
- [x] Update existing settings self-test probes to use a Preferences `BrowserWindow` reference, asserting singleton reuse and that the main Notes pane remains visible.
- [x] Replace remaining self-test clicks on `viewNotes` with direct checks or no-op navigation, preserving each test's original purpose.
- [x] Update obsolete settings-page metadata assertions and descriptions.

### Task 4: Source-only review and application restart

**Files:**
- Review: `docs/superpowers/specs/2026-10-16-preferences-menu-design.md`
- Review: all files listed above.

- [x] Run `git diff --check` and inspect the complete diff.
- [x] Search application/self-test source for removed IDs and obsolete `menu:open-preferences` renderer switching.
- [x] Restart Kaiwu from this workspace after the task, as requested.

