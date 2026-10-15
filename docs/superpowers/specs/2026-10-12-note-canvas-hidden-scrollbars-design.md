# 笔记画布节点隐藏滚动条设计

## 目标

隐藏笔记画布节点框内部可见的滚动条，让节点外观更简洁；节点正文仍可用鼠标滚轮滚动，并保留已有的平滑滚动体验。

## 范围

- 覆盖普通节点正文 `.nc-node-body`。
- 覆盖 Markdown 节点内层正文 `.nc-node-body.live-markdown .live-markdown-content`。
- 仅隐藏上述滚动区的滚动条外观；继续保留现有 `overflow`、滚动位置与滚轮处理。
- 不改变侧栏、设置页、其他面板、节点布局、画布缩放/平移或键盘交互。

## 方案

采用节点范围内的 CSS 隐藏：Firefox 使用 `scrollbar-width: none`；Chromium/WebKit 使用对应滚动区的 `::-webkit-scrollbar { display: none; }`。不改 JavaScript 滚轮事件，也不使用 `overflow: hidden`，避免切断可滚动能力。

普通正文的滚轮由 `attachBodyScroll` 平滑滚动；Markdown 正文由同一滚动辅助函数接管。画布级滚轮监听会跳过 `.nc-node-body` 内的事件，因此节点内容滚动不会触发画布平移或缩放。

## 验收与测试

1. 普通/分组节点正文及 Markdown 节点正文都不显示滚动条。
2. 内容超出可视范围时，鼠标滚轮仍可在节点内平滑滚动。
3. 在节点外滚动时，既有画布导航行为不变。
4. 自动化测试覆盖两个滚动区的隐藏规则，并确认滚动仍通过可滚动的 `overflow` 与原有节点滚轮路由实现。

## 风险控制

样式只使用 `.nc-node-body` 及其 Markdown 正文的限定选择器，不作用到全局滚动容器。若不同 Chromium 平台对滚动条伪元素的支持不同，Firefox/Chromium 两种规则均需保留。
