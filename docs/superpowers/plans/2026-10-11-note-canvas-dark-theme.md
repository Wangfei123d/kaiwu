# 笔记画布近黑主题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将笔记画布配色统一到开物近黑背景、炭灰面板、灰阶边框与浅蓝强调，同时保持交互行为不变。

**Architecture:** 新增笔记画布专属主题样式表，由现有插件样式注入入口在基础样式之后一并加载和隔离；新增 CSS 回归测试。通过 `.nc-pane` 内的画布主题变量和局部覆盖规则映射全局设计令牌，不修改全局主题、短剧画布或画布数据。

**Tech Stack:** CSS, Node.js built-in test runner (`node:test`)

## Global Constraints

- 所有主题改动仅限 `plugins/note-canvas/` 插件内部样式及其样式加载入口。
- 背景采用 `--bg`，文字采用全局文字灰阶，交互强调采用 `--accent`。
- 保留端口靠近显示规则、节点拖动/缩放、连接、Markdown 编辑与语义状态色。
- 不改变全局主题、短剧画布、布局、交互行为或存储格式。

---

### Task 1: 笔记画布近黑配色与回归保护

**Files:**
- Create: `tests/note-canvas-theme.test.js`
- Create: `plugins/note-canvas/theme.css`
- Modify: `plugins/note-canvas/index.js`

**Interfaces:**
- Test reads the new theme stylesheet and plugin loader as UTF-8, verifying theme tokens and that the override is scoped after base CSS.
- The stylesheet consumes existing global tokens `--bg`, `--text`, `--muted`, `--dim`, `--faint`, `--border`, `--border-hi`, and `--accent`.

- [x] **Step 1: Write the failing test**

Create `tests/note-canvas-theme.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const baseCss = readFileSync(new URL('../plugins/note-canvas/style.css', import.meta.url), 'utf8');
const themeUrl = new URL('../plugins/note-canvas/theme.css', import.meta.url);
const themeCss = existsSync(themeUrl) ? readFileSync(themeUrl, 'utf8') : '';
const css = `${baseCss}\n${themeCss}`;
const loader = readFileSync(new URL('../plugins/note-canvas/index.js', import.meta.url), 'utf8');

test('note canvas uses the global near-black theme and keeps existing handle behavior', () => {
    assert.ok(/\.nc-pane\{[^}]*background:var\(--bg\)/.test(css), 'pane background uses the global near-black token');
    assert.ok(/\.nc-canvas\{[^}]*background-color:var\(--bg\)/.test(css), 'canvas background uses the global near-black token');
    assert.ok(/\.nc-node\.selected\{[^}]*outline-color:var\(--accent\)/.test(css), 'selected nodes use the global accent');
    assert.ok(/\.nc-pane \.nc-port:not\(\.nearby\):not\(\.connecting\):not\(:focus-visible\)\{opacity:0/.test(css), 'ports retain proximity visibility');
    assert.ok(/\.nc-pane \.nc-resize\{background:none\}/.test(css), 'resize handle remains visually clean');
    assert.ok(/\.nc-status\.error\{color:#ffaaa7\}/.test(css), 'error status retains its semantic color');
    assert.ok(/theme\.css/.test(loader), 'plugin loader includes the theme stylesheet');
    assert.ok(/scopeCss\(.*themeCss/s.test(loader), 'theme stylesheet is scoped with the plugin CSS');
});
```

- [x] **Step 2: Run test and verify the theme assertion fails**

Run: `node --test tests/note-canvas-theme.test.js`

Expected before implementation: FAIL because there is no theme override and the plugin loader does not include one.

- [x] **Step 3: Add scoped theme overrides**

Create `plugins/note-canvas/theme.css` with this scoped override block. It uses global tokens for shared palette roles and neutral charcoal for plugin-specific surfaces:

```css
.nc-pane{--nc-panel:#171615;--nc-panel-raised:#1e1d1b;--nc-panel-high:#272624;--nc-control:#141312;--nc-grid:#292724;background:var(--bg);color:var(--text)}
.nc-pane button{color:var(--text);border-color:var(--border);background:var(--nc-panel-high)}
.nc-pane button:hover{background:#33312e}
.nc-pane input,.nc-pane textarea{color:var(--text);background:var(--nc-control);border-color:var(--border)}
.nc-pane input:focus,.nc-pane textarea:focus,.nc-live-markdown:focus,.nc-editor .nc-live-markdown:focus{border-color:var(--accent)}
.nc-sidebar{background:var(--nc-panel);border-color:var(--border)}
.nc-sidebar h3,.nc-live-markdown .live-markdown-status,.nc-node-body.live-markdown .live-markdown-status{color:var(--dim)}
.nc-pane .nc-board-row.active{background:#282725;border-color:var(--border-hi)}
.nc-toolbar{background:var(--nc-panel);border-color:var(--border)}
.nc-status,.nc-empty{color:var(--muted)}
.nc-canvas{background-color:var(--bg);background-image:radial-gradient(var(--nc-grid) 1px,transparent 1px)}
.nc-node{background:var(--nc-panel-raised);border-color:var(--node-color,var(--border-hi))}
.nc-node.selected{outline-color:var(--accent)}
.nc-node[data-type=group]{background:rgba(255,255,255,.025);border-color:var(--node-color,var(--border-hi))}
.nc-node-head{background:var(--nc-panel-high);border-color:var(--border);color:var(--text)}
.nc-node[data-type=group] .nc-node-head{background:var(--nc-panel)}
.nc-node-body{scrollbar-color:var(--border-hi) var(--nc-panel)}
.nc-node-body pre,.nc-node-body code,.nc-node-body.live-markdown .live-markdown-content pre,.nc-live-markdown pre{background:var(--nc-control)}
.nc-node-body th,.nc-node-body td,.nc-live-markdown th,.nc-live-markdown td{border-color:var(--border)}
.nc-node-body a,.nc-live-markdown a{color:var(--accent)}
.nc-remote-image{color:var(--dim)}
.nc-pane .nc-port{border-color:var(--accent);background:#242321}
.nc-pane .nc-resize{background:none}
.nc-edge path{stroke:var(--accent)}
.nc-edge:hover path{stroke:var(--text)}
.nc-edge-label{fill:var(--text);stroke:var(--bg)}
.nc-marquee{background:rgba(126,200,255,.12);border-color:var(--accent)}
.nc-hint{color:var(--dim);background:rgba(20,19,18,.88)}
.nc-overlay{background:rgba(0,0,0,.72)}
.nc-form,.nc-editor,.nc-context{background:var(--nc-panel-raised);border-color:var(--border-hi)}
.nc-form-error,.nc-inline-error{background:#332222;border-color:#70444b}
.nc-live-markdown,.nc-editor .nc-live-markdown{background:var(--nc-control);border-color:var(--border)}
.nc-live-markdown .live-markdown-toolbar,.nc-node-body.live-markdown .live-markdown-toolbar{background:var(--nc-panel);border-color:var(--border);color:var(--text)}
.nc-live-markdown .live-markdown-tool,.nc-node-body.live-markdown .live-markdown-tool{background:var(--nc-panel-high);border-color:var(--border)}
.nc-node-body.live-markdown .live-markdown-content{scrollbar-color:var(--border-hi) var(--nc-panel)}
.nc-node-body.live-markdown .live-markdown-content:focus{box-shadow:inset 0 0 0 1px rgba(126,200,255,.34)}
```

In `plugins/note-canvas/index.js`, replace the single stylesheet fetch inside `injectStyles` with:

```js
const [baseCss, themeCss] = await Promise.all([
    fetch(new URL('./style.css', import.meta.url)).then(response => response.text()),
    fetch(new URL('./theme.css', import.meta.url)).then(response => response.text()),
]);
```

Then replace `style.textContent=scopeCss(css,'note-canvas');` with:

```js
style.textContent = scopeCss(`${baseCss}\n${themeCss}`, 'note-canvas');
```

The existing `.nc-port` proximity visibility declarations and `.nc-status.error` semantic color remain in place; do not edit other stylesheets.

- [x] **Step 4: Run focused tests**

Run: `node --test tests/note-canvas-theme.test.js tests/note-canvas-port-hover.test.js tests/note-canvas-integration.test.js`

Expected: all focused theme, port-hover, and canvas integration tests PASS.

- [ ] **Step 5: Run the complete test suite**

Run: `npm test`

Expected: exit code 0 and no failed tests. If the existing baseline has unrelated failures, report the exact failing tests separately without changing their files.
