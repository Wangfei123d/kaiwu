# 技能按需求启用实施计划

> **For agentic workers:** 使用 subagent-driven-development 接入独立适配器任务，主线程完成执行器与画布集成，在当前已授权项目执行，不提交用户改动。

**Goal:** 技能节点支持文本/图片来源；接收端自然语言需求决定技能的按需读取。

**Architecture:** 新增技能元信息与严格结构化匹配器；拓扑执行先去除待命技能边，再按匹配结果扩展依赖。生成适配器接收 `{mimeType, bytes}` 图片，画布显示上一轮匹配理由和待命状态。

**Tech Stack:** Electron、原生 JavaScript、现有 ACP 文本会话、APINebula Images API。

## Global Constraints

- 直接在 E:/project/kaiwu 修改，保留现有未提交文件，不创建提交。
- 只从已连接技能选择；自然语言需求无需 @ 或声明式指令。
- 未启用技能及其独占上游不执行、不读图；普通共享分支继续执行。
- 候选阶段只使用元信息；正文与图片在匹配后读取。
- 否定/歧义/仅举例的描述不启用；匹配失败或非法返回阻止本次生成。
- 模型和密钥沿用设置；不执行付费验证或修改真实项目数据。

## Task 1: 元信息、匹配与资源

Files: app/lib/drama-skills.js、electron/drama/lib/skill-matcher.js、electron/drama/lib/skill-resources.js、tests/drama-skills.test.js。

- [x] 定义 `skillCandidates(graph,nodeId)`、`skillMatchKey(prompt,candidates)`；只取 skill 输出到 llm/image 的技能端口；元信息包含 id/name/purpose/scenarios/exclude/inputTypes，不含 value、正文、文件路径。
- [x] `createSkillMatcher({generateText})` 返回 `{selected:[{id,reason,evidence}]}`；严格 JSON 校验 ID、类型、数量、证据需来自当前提示词，去重并按候选次序排列；空提示词无调用。
- [x] `readProjectImages(dir,files)` 验证 shots 内 realpath、真实图像字节和共享数量/大小限额，产出实际字节及内容指纹；`importProjectImage(dir,abs)` 导入本地图并返回 shots 文件名。
- [x] 针对非法 ID、否定指令契约、元信息隔离、目录逃逸、无效图片做行为检查。

## Task 2: 生成适配器图片输入

Files: electron/drama/lib/text-generator.js、electron/drama/lib/apinebula-image.js、对应已有 tests。

- [x] `generateText({source,prompt,images=[]})` 校验图片，非空时 `runtime.send(buildTextPrompt(...),{images})`；空图保持单参数发送兼容，能力由既有 runtime 检查。
- [x] `generateImage({prompt,batch,dir,images=[]})` 有图改用 `/images/edits`，原生 FormData 重复 image 文件字段；无图保持现有 generations；图片验证发生在发请求前；超时仍 300000ms，不自动重试。
- [x] 模型 gpt-image-2.5、尺寸 1080x1920、n=1、b64_json 保持；有图请求不手写 multipart content-type。
- [x] 检查真实 multipart 图片字节、无图兼容、非法图拒绝、ACP 图片内容传递。禁止真实网络调用。

## Task 3: 按需拓扑和 IPC

Files: electron/drama/lib/core.js、electron/drama/drama-ipc.js、electron/main.js、app/runtime/ctx.js、electron/preload.cjs、tests/drama-skill-execution.test.js。

- [x] 注册 skill(文本/图集输入，技能输出，多来源)、image-input(图集输出，本地参考图)；llm/image 增加独立技能汇聚输入。
- [x] 使用普通终点根集合和移除技能输出边的图计算待执行节点；匹配可达接收端，加入选中技能边并迭代到稳定，未选独占来源不执行。
- [x] 将完整技能文本与接收文本拼装；选中技能图片读入并传给适配器。技能文本/图片指纹纳入接收端缓存，未选正文不纳入。force 重新匹配。
- [x] 持久化 graph.skillMatches、上一轮实际文本输入和参考图文件名，失败保留具体原因。
- [x] IPC 新增 drama:importImage；直接图输入存于 shots；上下文和 preload 白名单同步。
- [x] 接收端运行测试涵盖未选 shell/缺失图跳过、共享普通支线、多个技能、全文、缓存、无效匹配、运行全部、图片路径守卫。

## Task 4: 画布展示与验证

Files: plugins/drama/index.js、plugins/drama/style.css、plugins/drama/skill-panel.js。

- [x] 技能元信息与正文编辑、两个来源端口、图片输入导入按钮与节点内预览。
- [x] 技能连线待命虚线/启用实线；接收端显示上一轮匹配需求与理由；提示词或元信息改变后显示待匹配。
- [x] 展示实际技能提示词/图片预览，沿用节点尺寸和扫光规则。
- [x] 运行相关回归及隔离画布交互，不调用真实模型；自查并完成代码审查。
