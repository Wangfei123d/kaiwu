# 画面生成分层视差动效实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用户选定的第二组 D「分层视差」接到 AI 对话中 `generate_image` 的真实运行状态。

**Architecture:** 独立 SVG 组件构建等待图形，AI 面板按工具调用 ID 缓存元素。在当前轮次的图片工具运行时，把组件作为工具折叠组的兄弟插入时间线；CSS 负责各层动画。录屏确认此前误接短剧画布，相关改动已撤回。

**Tech Stack:** 浏览器 DOM/SVG、CSS 动画、Node.js test runner。

## Global Constraints

- 动效沿用 `docs/previews/image-generation-animation-options-v2.html` 的 D 方案。
- 只响应当前会话、当前轮次的 `generate_image` 工具事件。
- 不显示百分比；示意景观不表示服务中间结果。
- 工具完成、失败、取消、整轮结束或进程断开后移除动效。
- 动效位于 details 外，工具折叠时仍可见；重复工具状态和文本更新保留同一动画元素。
- 系统减少动态效果时各景深层静止。
- 保留工作区其他未提交改动。

---

### Task 1: 临时预览区的生命周期

**Files:**
- Create: `app/agent/image-generation-preview.js`
- Test: `tests/agent-panel.test.js`

**Interfaces:**
- Consumes: ACP `tool_call` / `tool_call_update` 及本轮 busy 状态。
- Produces: `createImageGenerationPreview({ doc, toolCallId })` 和 `isImageGenerationTool(tool)`。

- [x] 先写录屏入口测试：工具组收起、重复事件、完成/失败/取消/断开、历史 pending 不复活。
- [x] 修复前 9 项测试全部因缺少生图动效失败，修复后全部通过。
- [x] 实现静态 SVG 景深层及按调用 ID 缓存，停止时移除临时视图。
- [x] 重跑定向测试。

### Task 2: 接入画布与动效样式

**Files:**
- Modify: `app/agent/panel.js`
- Modify: `app/styles/shell.css`
- Create: `tests/agent-image-generation-smoke.cjs`
- Create: `tests/fixtures/agent-image-generation-smoke.html`

- [x] 在时间线渲染前按当前轮次同步活动图片工具，忙碌状态变化纳入结构指纹。
- [x] 将动效放在工具 details 外，普通工具不触发生图动效。
- [x] 复用同一动画元素，避免文本及工具状态更新重播。
- [x] 真实 Chromium 验证可见尺寸 420×212.625、5 个运行中动画、景深实际位移、完成及取消清理。

### Task 3: 完成检查与重启

- [x] 生图定向测试 9/9 通过；实际渲染器检查通过且无模型/生图服务请求。
- [x] AI 面板及状态全量回归出现 8 个旧断言失败；对照 HEAD 基线，确认相同 8 项也失败，涉及已移除说明文案与重连按钮。
- [x] 对改动 JS 执行 `node --check` 并执行 `git diff --check`。
- [x] 复查完成、失败、取消、整轮收尾及进程断开路径。
- [x] 按用户既有要求重启开物并记录启动状态（主进程 18936，插件 activated=9 broken=0，AI ready）。
- [x] 保存独立中文操作记录，报告定向测试、真实渲染与 8 项基线失败的验证范围。
