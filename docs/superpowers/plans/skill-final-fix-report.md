# 技能节点最终审查修复报告

## 范围与结果

完成三项审查修复：提交前保存并登记实际技能输入，运行中通知界面并在生成失败后保留；完整输入独立采用 16 MiB 上限，超过上限在调用适配器前明确拒绝；跨技能按项目文件名首次出现顺序去重参考图，快照图片列表与实际发送顺序一致。不同文件即使字节相同也不会合并，各技能全文及原有指纹继续保留。

修改文件：`electron/drama/lib/core.js`、`electron/drama/drama-ipc.js`、`plugins/drama/index.js`、`tests/drama-skill-execution.test.js`、`tests/drama-ipc.test.js`、`tools/check-skill-canvas.cjs`。本报告是额外文档输出。保留已有脏工作区内容，没有 Git 提交，没有真实模型调用。

## TDD 红灯

先加入提交回调内读取已登记完整输入、失败保留、scoped inputReady、超过 2 MiB 读取、超过 16 MiB 拒绝以及两个技能共享四个文件的回归断言，再运行：

```powershell
Set-Location E:/project/kaiwu
node --test tests/drama-skill-execution.test.js tests/drama-ipc.test.js
```

退出码 1：43 项，38 通过，5 个预期失败。inputReady 未发送；适配器内没有 skillInput；超过 16 MiB 的输入仍提交成功；四个共享文件被计为八张而拒绝。大输入测试在进入 reader 前就暴露未登记快照的缺陷。随后实现同一修复波次。

## 绿灯与最终验证

第一次实现后同一 Node 命令退出码 0，43/43 通过。追加已有行为的待命正文缓存回归，以及画布运行中预览和旧生成图保留断言后最终运行：

```powershell
Set-Location E:/project/kaiwu
node --test tests/drama-skill-execution.test.js tests/drama-ipc.test.js
node tools/check-skill-canvas.cjs
```

Node 退出码 0：44 项全部通过，0 失败、0 跳过。画布退出码 0：参考图导入、端口、拖线、编辑标题、过期匹配、实时激活、运行中实际输入懒读、生成扫光保留、再次运行保留上轮生成图、145px 实际参考图、至少 88px 生成图、内滚动隔离均通过。完整输入在夹具生成 Promise 释放前即可展开读取；完成后复用全文读取缓存。

```powershell
Set-Location E:/project/kaiwu
git diff --check -- electron/drama/lib/core.js electron/drama/drama-ipc.js plugins/drama/index.js tests/drama-skill-execution.test.js tests/drama-ipc.test.js tools/check-skill-canvas.cjs
```

退出码 0，无 whitespace 错误；Git 对四个现有文件提示以后触碰时 LF 转 CRLF，未做额外格式转换。

画布调试曾出现运行中 active 行超时。原因是原夹具 `run` 使用位置参数，但实际插件传入对象，导致夹具事件没有正确 runId；原先完成后渲染掩盖了问题。改为 `run: async ({runId})` 后运行中事件真实进入受 scoped 限制的处理器，所有断言通过。此超时是夹具问题，不是新的生产逻辑失败。

## 具体实现与限制

核心导出共享 `MAX_SKILL_INPUT_BYTES`。仅有选中技能的 llm/image 接收节点创建完整输入快照；UTF-8 字节超过 16 MiB 报错且不会调用适配器。文件写入与 graph.runs 登记均先于 onNodeInput 和适配器。running/failed/ok 记录保留本轮 skillInput。普通无技能流程不增加快照。IPC 为已登记 skillInput 文件采用共享上限，普通输出仍为 2 MB，原文件格式和登记检查保持。

inputReady 界面分支只合并 run 并刷新技能反馈，提前返回，避免移除 generating 集合、停止扫光或重建清空旧生成画廊。根任务已有标题编辑、画廊选择器和最小高度边距计算保持。

验证均为本地替身或隔离 Playwright，未声称真实提供方兼容性。未重复运行整个不变适配器测试或全部套件。快照仍保留原历史标签；当前运行时能读取的是该次已准备、即将提交的完整输入。现有未注册旧快照文件的清理策略不属于本次范围。
