# Task 1 · 笔记画布存储实施报告

完成存储、权限、IPC、版本冲突保护、媒体和引用笔记编辑接口。直接修改既有工作区；未提交、重启、重置、改日志或访问真实笔记库。全部行为测试仅使用自动清理的真实临时目录。

## 文件清单

- 新增 app/lib/note-canvas.js：共享 JSON Canvas 子集验证器。
- 新增 electron/notes/canvas-ipc.js：8 个受限频道、库 token、串行 CAS、媒体导入与读取。
- 修改 app/runtime/ctx.js：canvas 权限门控与 API。
- 修改 app/lib/manifest-schema.js：known permissions 加 canvas。
- 修改 electron/preload.cjs：8 个频道白名单。
- 修改 electron/main.js：notesIpc 初始化后注册，vaultRoot 每次调用 notesIpc.currentVault()。
- 主控制者额外授权修改 electron/notes/note-index.js：可选同步 beforeWrite guard 与最终编码字节上限 maxBytes；旧调用不传时保持原读写/备份/编码与无上限语义；原子写拒绝时清理自己创建的临时文件。
- 新增 tests/note-canvas.test.js、tests/note-canvas-ipc.test.js：23 个新行为用例。
- 新增本报告。

## 实际接口

只在 descriptor.permissions 包含 canvas 时提供 ctx.canvas。公开调用均返回 Promise：

| 方法 | 返回值与约束 |
| --- | --- |
| library() | {boards:[{path,name}],notes:[{path,title,kind}],images:[{path,name}],vault,reason}；kind 为 markdown/text，title 为文件名去扩展。未配置/不可用库返回空数组、vault:null 与中文 reason。 |
| create(name,vault?) | {path,graph,revision,vault}；仅建 画布/name.canvas，不覆盖。 |
| read(path,vault?) | {path,graph,revision,vault}。 |
| write(path,graph,revision,vault) | {path,revision,vault}；主进程要求 token 与当前库匹配、原 revision 与磁盘 SHA256 相同。 |
| importImage(path,{name,bytes,mimeType},vault) | {file,name,vault}；实际文件为 画布/board.assets/originalStem-UUID.ext；重复导入原文件名会得到独立文件，不覆盖。 |
| media(file,vault?) | {dataUrl,vault}；仅库内合法位图，可读取库中现有图片。 |
| readNote(path,vault) | {...readNote原返回,path,revision,vault}；只允许真实 .md/.txt 文件，20 MiB 上限。 |
| writeNote(path,text,revision,vault) | {...writeNote原返回,revision,vault}；库 token、磁盘 CAS、串行化、beforeWrite guard，最终编码含 BOM/CRLF 字节数不得超过 20 MiB。 |

频道分别为 canvas:library/create/read/write/importImage/media/readNote/writeNote。vault 是真实根路径 SHA256，不返回绝对路径；它用于绑定库身份，不是新增通用文件权限。read/create/media 的 token 可省略以兼容当前库，但 UI 已约定显式传入；write/importImage/readNote/writeNote 缺 token 一律拒绝。ctx 的三参数 write 仅能沿用已有 create/read 结果绑定，绝不自行获取新 token；同 path+revision 曾来自两个库时将绑定标成歧义并拒绝隐式保存。绑定缓存限 256 个版本，释放插件时清理。

## RED / GREEN

第一轮 RED：

    node --test tests/note-canvas.test.js tests/note-canvas-ipc.test.js

两文件均以 ERR_MODULE_NOT_FOUND 失败：normalizeCanvas 与 canvas-ipc 模块尚未存在。这是 brief 明确允许的预期 RED。

后续补强 RED：同命令分别暴露缺 MIME 未拒绝、备份路径 junction 未拒绝、非整数几何未归一化、同名素材未使用独立文件、同 revision 跨库隐式绑定被覆盖。逐项实现后 GREEN。

临时文件 ownership 回归 RED：

    node --test --test-name-pattern='never cleans a temporary' tests/note-canvas-ipc.test.js

移除修复时 1 fail（既存其他写入的临时文件被删除，断言读回得到 ENOENT）；恢复仅清理自己创建临时文件的修复后通过。

最终 GREEN：

    node --test --test-reporter=spec tests/note-canvas.test.js tests/note-canvas-ipc.test.js tests/ctx.test.js tests/manifest-schema.test.js tests/notes-ipc.test.js tests/note-index.test.js

221 tests / 221 pass / 0 fail / 0 skip，1394.0453ms。包含 23 个画布新测试与 198 个相关既有回归。此前初版聚焦验证为 217 pass；下面记录独立审查发现与修复。主控制者另行执行全量测试。

语法检查：node --check electron/main.js、electron/preload.cjs、electron/notes/canvas-ipc.js 均 exit 0。git diff --check 指定 owner 文件 exit 0；仅现存 Git CRLF 提示，无 whitespace error。

## 安全边界与自审

- 纯 normalizeCanvas 保留 JSON Canvas text/file/link/group、edge sides/end/label/color、file subpath、group background/backgroundStyle 以及本应用 viewport。坐标与尺寸落盘归一到整数，尺寸至少 1；side 可省略以兼容规范。未知字段明确拒绝，避免静默丢失用户扩展。顶级 nodes/edges 都须数组，这是本次受支持子集。
- 1000 节点、5000 连线、8 MiB JSON、200000 单文本字符；ID 唯一、端点存在、有限坐标、正尺寸、HTTP/HTTPS 链接、合法 JSON Canvas 颜色与箭头枚举。file 引用限 md/txt/五类位图，路径限安全库内相对路径；不允许绝对路径、盘符、反斜杠、控制字符、点段、编码变换或尾部点/空格。
- canvas 文件严格限 画布/<name>.canvas，write 必须目标存在且是普通文件。lexical + realpath 再检查每个路径组件，拒绝 symlink/junction（即使别名指回库内也拒绝）。create mkdir 前后都检查路径。
- 主进程每次现取 root；排队前捕获库身份，入队后/异步读取后/写盘前重查。队列 Windows key 不区分大小写。canvas compare+write 使用不让出事件循环的同步段；临时写 fsync 后最终 CAS，再原子 rename。
- 笔记复用 note-index readNote/writeNote：UTF-8/BOM、CRLF 与非 UTF-8 只读判据不分叉。beforeWrite 在原子临时文件之前、备份之前及最终 rename 之前同步重查 token/磁盘 revision/原路径/备份路径；最后 guard 与 rename 不再 await。maxBytes 在 encodeText 完成且 CRLF/BOM 已还原后、任何备份复制或原子写之前判长度；拒绝时正文与既有备份都不变。旧调用省略 maxBytes 时无上限。拒绝原子写时清理自己的临时文件。
- 自审发现并修复 .bak symlink/junction 逃逸；真实目录联接用例证明拒绝且原文不变。也修复同 path+revision 跨库隐式 token 缓存覆盖与临时文件 ownership 清理风险。
- PNG/JPEG/WEBP/GIF/BMP 验证 MIME、扩展、magic，20 MiB；SVG/HTML 或不匹配内容拒绝；无任意网络或外部文件读取。导入先检查 byteLength 再复制字节；媒体返回 dataURL。
- fs 错误经频道包装转为中文状态与 code，避免绝对路径泄露。未配置库不生成示例。
- CAS/队列保护本应用并发请求，并在最终写入前发现外部编辑；不声称提供与任意外部程序协作的 OS 级文件锁。图中的安全相对引用不要求目标当下存在；实际 readNote/media 操作仍严格执行真实路径守卫。

## 独立审查 fix wave · 最终编码超限

主控制者复现 Important 数据问题：writeNote 先写入超 20 MiB 正文，随后生成响应的 bytesAt 抛错，导致「保存失败」但磁盘正文已被替换。按授权修复，未扩展其它功能。

补充 RED：

    node --test --test-name-pattern='oversized final|optional note maxBytes' tests/note-canvas-ipc.test.js

4 项全部失败：ASCII UTF8 超限、多字节 UTF8 超限、输入小于上限但 CRLF+BOM 转换后超限，均显示原文件实际被替换；可选 maxBytes 的 BOM 计数用例未拒绝。

实现 writeNote options.maxBytes 对最终编码 Buffer 计数，严格排在 backup 之前；canvas 通道传 20 MiB。新增文件同样先校验再原子写；默认旧调用无上限。现有 readNote 编码只读行为保持。

同一命令 GREEN：4 pass / 0 fail，981.6156ms。所有超限例断言正文及已有 .bak 不变且无临时残留；小额 maxBytes 用例证明 BOM 计入上限、默认写入仍成功、新文件超限不创建。最终全套聚焦回归 221 pass / 0 fail，1394.0453ms。

无阻塞疑问。此次修复已稳定，等待审查代理继续只读复核。
