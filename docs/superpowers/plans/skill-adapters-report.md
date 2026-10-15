# 技能图片生成适配器实现报告

## 范围与实现

仅修改任务指定的四个代码/测试文件，另按要求保存本报告。未提交 Git、未调用真实 API、未改动其他现有用户文件。

- `electron/drama/lib/text-generator.js`：接受 `images=[]`，调用共享 `admitImagePayload`，在创建 runtime 之前拒绝非法图片；有图传 `runtime.send(prompt,{images:admitted.images})`，无图保持单参数调用。独立会话、工具取消、正文收集和释放逻辑保持原状。
- `electron/drama/lib/apinebula-image.js`：共享准入校验覆盖四张限制、单张/总字节限制、真实格式嗅探；额外明确拒绝 GIF。参考图使用原生 FormData POST `/images/edits`，重复 `image` Blob 文件字段，PNG/JPEG/WebP 对应 png/jpg/webp 后缀。每次仍只生成一张，model/size/key/save 行为保持原状，无图仍使用 JSON `/images/generations`。
- 测试新增文本图片传递、纯文本参数个数、创建 runtime 前拒绝；图片编辑请求字段/重复字段/Blob 类型/字节/后缀，以及 GIF、伪造 MIME、URL、张数与共享总大小拒绝。

## TDD 与验证

先添加四个新测试再运行两组测试。首轮：10 个测试中 6 通过、4 失败，失败对应缺失的图片转发、准入和 edits 行为。随后实现功能并重新运行：

`node --test tests/drama-text-generator.test.js tests/drama-apinebula-image.test.js`

结果：10 个测试全部通过，0 失败、0 跳过。真实 ACP 子进程夹具通过（无网络、无真实密钥）。

`git diff --check` 返回 0；仅出现工作区既有文件的 LF/CRLF 提醒，没有空白错误。仓库存在其他并行/用户变动，未清理或覆盖。

## 自查与限制

确认共享模块相对导入路径正确；原生 FormData 未手写 multipart Content-Type；Bearer 授权保留；请求超时仍 300000ms，下载仍 120000ms；请求失败后不重试；下载 HTTPS 与文件保存行为保持原状。每次 batch 请求创建独立 FormData，避免复用请求体。

未进行真实服务请求，远端图片编辑接口仅按任务提供的已核实文档合同及本地请求结构测试验证。未扩展整个项目测试范围。
