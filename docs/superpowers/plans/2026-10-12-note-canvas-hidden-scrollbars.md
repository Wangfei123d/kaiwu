# 笔记画布节点隐藏滚动条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 隐藏笔记画布节点普通正文及 Markdown 正文的滚动条外观，同时保留节点内现有平滑鼠标滚轮滚动。

**Architecture:** 继续使用现有滚动容器和 `attachBodyScroll` 事件处理，不改 JavaScript 导航。只在笔记画布主题 CSS 中为两种节点内容滚动区隐藏 Firefox 与 Chromium/WebKit 的滚动条。

**Tech Stack:** Electron/Chromium、CSS、Node.js `node:test`。

## Global Constraints

- 仅影响 `.nc-node-body` 与 `.nc-node-body.live-markdown .live-markdown-content`。
- 两个区域继续使用现有可滚动 overflow 与鼠标滚轮处理。
- 不改侧栏、设置、其他面板、画布缩放/平移、节点布局或键盘行为。
- 不改动工作区中与本功能无关的已有文件或改动。

---

### Task 1: 隐藏节点正文滚动条并锁定回归行为

**Files:**
- Modify: `plugins/note-canvas/theme.css`
- Test: `tests/note-canvas-theme.test.js`
- Reference only: `plugins/note-canvas/style.css`
- Reference only: `plugins/note-canvas/canvas-view.js`

**Interfaces:**
- Consumes: 插件主题样式加载器已将 `theme.css` 与基础样式一起作用于 `.nc-pane`。
- Produces: 两个目标滚动区无可见滚动条，但仍保留各自在基础样式中的 `overflow:auto` 以及 `attachBodyScroll` 提供的平滑滚轮滚动。

- [x] **Step 1: 先添加失败测试**

在 `tests/note-canvas-theme.test.js` 末尾新增用例，要求目标节点正文和 Markdown 正文分别包含 Firefox 与 Chromium/WebKit 隐藏规则，同时检查基础样式仍保留滚动：

```js
// 在测试文件顶部读取既有节点滚轮路由。
const canvasView = readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');

test('note canvas node content hides scrollbar chrome without disabling scroll', () => {
    assert.match(css, /\.nc-node-body\s*\{\s*scrollbar-width:\s*none\s*;?\s*\}/,
        '普通节点正文在 Firefox 中隐藏滚动条');
    assert.match(css, /\.nc-node-body\.live-markdown \.live-markdown-content\s*\{\s*scrollbar-width:\s*none\s*;?\s*\}/,
        'Markdown 正文在 Firefox 中隐藏滚动条');
    assert.match(css, /\.nc-node-body::-webkit-scrollbar\s*,\s*\.nc-node-body\.live-markdown \.live-markdown-content::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
        'Chromium/WebKit 中隐藏两种节点正文滚动条');
    assert.match(baseCss, /\.nc-node-body\{[^}]*overflow:auto/s,
        '普通节点正文仍保持可滚动');
    assert.match(baseCss, /\.nc-node-body\.live-markdown \.live-markdown-content\{[^}]*overflow:auto/s,
        'Markdown 正文仍保持可滚动');
    assert.match(canvasView, /body\.addEventListener\('wheel',event=>\{event\.preventDefault\(\);event\.stopPropagation\(\);/,
        '节点正文继续由现有平滑滚轮逻辑处理');
    assert.match(canvasView, /listen\(canvas,'wheel',event=>\{if\(event\.target\.closest\('\.nc-node-body'\)\)return;/,
        '节点正文滚轮仍不会触发画布导航');
});
```

- [x] **Step 2: 运行测试确认 RED**

Run: `node --test tests/note-canvas-theme.test.js`

Expected: 新测试因主题 CSS 尚无 `scrollbar-width:none` 与 `::-webkit-scrollbar` 规则而失败；基础 overflow 断言通过。

- [x] **Step 3: 增加最小 CSS 规则**

在 `plugins/note-canvas/theme.css` 末尾添加：

```css
.nc-node-body { scrollbar-width: none; }
.nc-node-body.live-markdown .live-markdown-content { scrollbar-width: none; }
.nc-node-body::-webkit-scrollbar,
.nc-node-body.live-markdown .live-markdown-content::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
```

不改现有 `overflow:auto` 和滚轮事件，以避免内容无法滚动或事件传播到画布导航。

- [x] **Step 4: 运行测试确认 GREEN**

Run: `node --test tests/note-canvas-theme.test.js`

Expected: 全部断言通过，输出 `# fail 0`。

- [x] **Step 5: 运行相关回归测试**

Run: `node --test tests/note-canvas-theme.test.js tests/note-canvas-rendering.test.js tests/note-canvas-text-rendering.test.js tests/canvas-navigation.test.js`

Expected: 所有相关测试通过；其中导航用例确认画布平滑缩放/平移逻辑未受 CSS 变更影响。

- [x] **Step 6: 保留为未提交的工作区改动**

实现文件在本任务开始前就已是未跟踪文件，其中包含已有工作区内容。为避免把那些既有内容一并提交，本次不提交实现文件；交付时说明相关改动保留在当前工作区。
