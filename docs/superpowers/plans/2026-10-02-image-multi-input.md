# 画面生成汇聚端口实施计划

**目标：** 采用用户已选择的“汇聚端口”，一个图片节点的文本输入端口允许多个文本来源，按连入顺序合并来源全文与节点提示词。

**架构：** 连线与执行器共用按端口分组的入边映射。仅图片节点的第 0 个输入允许多连线；其他节点维持原规则。提示词拼装提取为浏览器和主进程共用的纯函数，图片缓存加入最终提示词，确保所有来源及标题变化生效。

**技术：** 原有 JavaScript 模块、Node 测试、原生 DOM；保留当前项目中的其他改动，直接落盘。

**实施状态：** 已完成。新增回归用例先验证旧规则失败；落盘后相关 56 项测试全部通过。隔离浏览器加载真实画布组件，验证一个端口连入三个来源、重复连线拒绝、全文预览、编辑态保留来源、单条断开和内部滚动。没有调用真实模型，没有修改真实短剧项目；运行中的开物需要重启加载新规则。

## 连线及执行

- [x] 在 `tests/drama-node-connections.test.js` 和 `tests/drama-ipc.test.js` 增加多来源连接、重复拒绝、合并全文、单来源兼容与缓存回归用例，先运行确认新规则失败。
- [x] 在 `app/lib/drama-connections.js` 添加 `inputEdgeGroups(graph, nodeId, inputCount, multipleInputs = [])`，返回每个端口的入边数组；`inputEdges` 保持代表边兼容接口。显式端口优先映射，旧边继续兼容，多来源组保留图中连入顺序。
- [x] `validateConnection` 根据类型的 `multipleInputs: [0]` 放开端口占用检查，仍拒绝重复、类型错误、自连接和闭环。
- [x] 添加 `app/lib/drama-image-prompt.js` 的 `buildImagePrompt(prompt, inputs, sourceTitles = [])`。跳过空白；单个非空片段保持纯文本；多个片段以标题及空行分隔。
- [x] `electron/drama/lib/core.js` 图片类型声明 `multipleInputs: [0]`，参数标注为补充提示词；执行器展平图片入边并传递全部全文，最终提示词进入图片指纹和模型调用。

## 节点界面

- [x] `plugins/drama/index.js` 保留一个端口，展示所有来源的顺序和节点名称，每条来源可单独断开；编辑态也保留来源列表。
- [x] 添加 `plugins/drama/image-prompt-preview.js`，用原生折叠区域预览合并内容；文本生成来源通过现有全文读取接口加载，未运行来源给出明确提示。
- [x] `plugins/drama/style.css` 为来源标题及提示词预览添加局部样式，适配图片节点的弹性高度。

## 验证

- [x] 运行 `node --test tests/drama-node-connections.test.js tests/drama-ipc.test.js tests/drama-image-prompt.test.js`，确认多来源/单来源/全文缓存和预览状态。
- [x] 运行相关图片服务与设置测试，不调用真实图片模型。
- [x] 检查修改模块的语法和差异格式，再逐项核对已选择方案；不提交其他改动。
