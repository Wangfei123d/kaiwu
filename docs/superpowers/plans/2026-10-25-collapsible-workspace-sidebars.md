# 可收起工作区侧栏实施计划

> **For agentic workers:** This plan is being executed inline because the user explicitly requested implementation.

**Goal:** Add independently collapsible left and right workspace sidebars with hover-revealed edge handles, preserving the user's dock tree and widths.

**Architecture:** Treat the first and last branches of the root horizontal workspace split as the left and right sidebars. Collapse those rendered branches temporarily without editing or persisting the dock tree; persist only the two collapsed flags in the existing global settings store. Open sidebars receive a collapse control in their outermost pane tab strip, and hidden sidebars are reopened through accessible edge handles.

**Tech Stack:** Electron renderer, vanilla JavaScript ES modules, CSS, existing settings bridge.

## Global Constraints

- Preserve the saved dock tree and its branch ratios while sidebars are collapsed.
- Do not alter unrelated dirty files or run/add tests unless explicitly requested.
- Respect reduced-motion and keyboard/touch access for edge handles.

---

### Task 1: Add independent sidebar collapse state to the workspace renderer

**Files:**
- Modify: `app/shell/panel-workspace.js`

- [x] Identify the root horizontal split's first and last branches and their adjacent gutters.
- [x] Add independently toggled collapse state that temporarily zeroes only the selected branch and hides its adjacent gutter.
- [x] Add collapse buttons to the edge leaf tab strips and expand handles at the workspace edges.
- [x] Reapply state after tree renders and expose the current state to the caller.

### Task 2: Style edge proximity handles and collapsed branches

**Files:**
- Modify: `app/styles/panel-workspace.css`

- [x] Add low-profile controls in sidebar tab strips.
- [x] Reveal edge handles on hover or focus, with touch-device visibility and reduced-motion support.
- [x] Ensure collapsed branches clip their contents and the center expands into reclaimed space.

### Task 3: Persist sidebar state in global settings

**Files:**
- Modify: `app/main.js`

- [x] Read and sanitize `ui.collapsedSidebars` alongside existing sidebar width settings.
- [x] Pass the initial state to the workspace and persist independent updates through the existing settings bridge.

### Task 4: Restart the running app and report the result

**Files:**
- No source files.

- [x] Restart Kaiwu using its existing launch flow so the user can inspect the implementation.
- [x] Report the changed behavior and whether automated tests were run.

**Verification note:** `node --check` passed for `app/shell/panel-workspace.js` and `app/main.js`. No automated tests were added or run. Kaiwu restarted successfully after retrying with access to its existing user-data directory; both sidebar controls were exercised in the live window, and the final window state has both sidebars expanded.
