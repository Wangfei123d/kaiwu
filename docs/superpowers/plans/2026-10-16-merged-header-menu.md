# Merged Header Menu Implementation Plan

**Goal:** Apply preview B to the Windows main window: merge the title bar and app header, use an icon-only brand control, and reveal the existing file/edit/view/window commands in an animated popup.

**Architecture:** Use Windows `titleBarStyle: hidden` with `titleBarOverlay` so native window controls sit in the 46px app header. Hide the native application menu on Windows and render a safe HTML menu model derived from the existing Electron menu template. Route actions through fixed, sender-checked IPC; keep native menus unchanged on other platforms.

**Tech Stack:** Electron 44, Chromium HTML/CSS, isolated preload bridge, existing `buildMenuTemplate`.

## Global Constraints

- Preserve the existing native menu on macOS and Linux.
- Keep panel and tool entries synchronized with `sanitizePanelMenuReport` output.
- Expose only fixed IPC actions and accept menu commands only from the primary window.
- Keep menu labels and plugin-provided view labels in `textContent`, never HTML interpolation.
- Honor the app's reduced-motion setting and the operating system reduced-motion preference.
- Do not add or run tests in this task; perform syntax and diff checks only.

## Task 1: Merge the Windows title bar and brand header

**Files:**
- Modify: `electron/main.js`
- Modify: `app/index.html`
- Modify: `app/styles/shell.css`
- Modify: `electron/selftest.js`

- [ ] Configure the primary Windows `BrowserWindow` with hidden title text and a 46px `titleBarOverlay`; set the application menu to `null` only on Windows.
- [ ] Replace the static brand `div` with an accessible icon-only menu button.
- [ ] Reserve the native window-control area in the header and put the header above the workspace with a local stacking context.

## Task 2: Reuse the menu template through a constrained HTML menu bridge

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.cjs`
- Create: `app/shell/application-menu.js`
- Modify: `app/main.js`
- Modify: `app/index.html`

- [ ] Serialize the existing menu template into plain data, preserving separators, enabled/checked state, submenus, roles, preferences, and dynamic panel ids.
- [ ] Add fixed `appmenu:get`, `appmenu:state`, and `appmenu:action` channels; sender-check all requests and allow only known roles, preferences, and currently registered panel ids.
- [ ] Render the four top-level categories and nested commands with DOM APIs, outside-click/Escape closing, focus semantics, and dynamic model refresh.
- [ ] Update the existing selftest expectations for an icon-only brand and the Windows HTML menu; keep its existing workspace/menu scenarios intact.

## Task 3: Add the approved opening motion

**Files:**
- Modify: `app/styles/shell.css`

- [ ] Animate popup fade/scale/vertical entrance, stagger top-level categories, and reveal nested commands.
- [ ] Disable these animations when either reduced-motion preference is active.

## Completion checks

- Run `node --check` on modified JavaScript files and `git diff --check`.
- Confirm the working tree diff changes only the intended shell/menu code and planning document plus the already-existing preview artifacts.
- Do not claim automated test coverage; tests were not requested and are not run.
