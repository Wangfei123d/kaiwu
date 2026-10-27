# Schedule Panel Preview Implementation Plan

> **For agentic workers:** Execute inline in this worktree. Preserve unrelated changes and do not commit or push.

**Goal:** Create one standalone HTML preview that compares four Kaiwu schedule and calendar panel layouts using mixed appointments and tasks.

**Architecture:** Keep the preview self-contained in `docs/previews/schedule-panel-options.html`, with inline CSS and JavaScript. Show four panel mockups in a responsive comparison grid; let the viewer select, expand, and change dates without connecting to application data.

**Tech Stack:** HTML, CSS, vanilla JavaScript, inline SVG icons.

## Global Constraints

- Match the existing Kaiwu dark interface and preview conventions.
- Keep all four layouts visible for comparison on desktop and stack them on narrow screens.
- Do not modify app source, add tests, stage files, commit, or push.

---

### Task 1: Build and inspect the four layout preview

**Files:**
- Create: `docs/previews/schedule-panel-options.html`

**Interfaces:**
- Provides four selectable mock panel concepts: month + daily agenda, week timeline + mini month, agenda table + month calendar, and event month grid + task agenda.
- Preview-only interactions update the selected date, selected concept, expanded concept, and confirmation toast locally.

- [x] Create the self-contained page with Kaiwu colors, four distinct panel mockups, and shared mixed schedule sample data.
- [x] Add responsive layout and local-only controls for choosing a concept, expanding a mockup, and selecting dates.
- [x] Check the embedded JavaScript syntax; browser inspection was blocked because the file URL policy permits only HTTP and HTTPS.
