# 任务：技能图片生成适配器

只修改 E:/project/kaiwu/electron/drama/lib/text-generator.js、apinebula-image.js 和其对应 tests/drama-text-generator.test.js、tests/drama-apinebula-image.test.js。

这是技能节点自然语言自动启用功能的生成边界；主线程另行完成匹配器、按需执行器与画布。接口：两个 generate 函数都接受 `images=[{mimeType:string,bytes:Uint8Array}]`，不接受任意 URL/路径。

文本：`generate({source='',prompt='',images=[]})` 用共享 app/lib/agent-image.js 的 admitImagePayload 校验；有图传 `runtime.send(buildTextPrompt({source,prompt}),{images:admitted.images})`，无图保持原先只传一个参数，工具取消/独立会话/释放逻辑不变。既有 runtime 支持图片并会拒绝不支持图片的模型。

图片：`generate({prompt,batch,dir,images=[]})` 用共享准入验证(4张、共享字节上限、真实格式嗅探)，支持 PNG/JPEG/WEBP，GIF 明确拒绝(图片编辑不保证支持)。有图用 `https://img-api.apinebula.ai/v1/images/edits`，原生 FormData：model=gpt-image-2.5,prompt,n=1,size=1080x1920,response_format=b64_json，并为每张参考图追加重复 `image` Blob 文件字段和合理后缀；不得手写 multipart content-type。无图保持原 JSON generations。单张请求超时沿用300000ms，下载沿用120000ms，不自动重试。现有 key/模型/文件保存行为不变。

官方 APINebula 文档 https://docs.apinebula.ai/docs/advanced/image/gpt-image-2-1k/ 已由主线程阅读，参考图接口为 images/edits，multipart 使用重复 image 字段；同分组调用模型名 gpt-image-2.5。

在当前目录编辑，preserve existing dirty tree。不创建/提交 Git 提交、不跑真实 API 请求、不修改其它文件。使用 apply_patch。遵循测试先行，补有意义的字节/参数验证用例，运行对应两组测试即可，实际ACP夹具不能启动时报明原因，允许申请执行授权。

把完整实现、自查和检查结果写入 E:/project/kaiwu/docs/superpowers/plans/skill-adapters-report.md；返回简短状态、文件列表和检查结果。
