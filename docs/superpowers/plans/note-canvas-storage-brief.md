# Task 1 · 独立笔记画布的数据与安全存储

用户已明确选择「独立笔记画布 + 自适应平滑一起落盘」。直接在 E:/project/kaiwu 修改，保留现有全部用户改动，不提交或重启。你只负责下列文件及对应新增测试，其他 UI 文件由主控制者负责。

## Owner files

app/lib/note-canvas.js; electron/notes/canvas-ipc.js; app/runtime/ctx.js; app/lib/manifest-schema.js; electron/preload.cjs; electron/main.js; tests/note-canvas*.test.js。

## Contracts

- export normalizeCanvas(graph) from app/lib/note-canvas.js：纯验证/归一化 JSON Canvas 对象，失败抛中文 Error，返回安全拷贝。
- graph = {nodes:[{id,type:'text'|'file'|'link'|'group',x,y,width,height,text?,file?,url?,label?,color?}],edges:[{id,fromNode,toNode,fromSide,toSide,label?,color?}],viewport?:{x,y,scale}}。
- 支持 text/file/link/group；max1000 节点/5000 边/8MiB JSON/200000 字符单文本；坐标有限、尺寸>0、ID唯一、边端点存在、侧边只 top/right/bottom/left、HTTP/HTTPS URLs、安全库内相对 file 路径。保持 JSON Canvas 兼容。
- export registerCanvasIpc({ipcMain,vaultRoot}) from electron/notes/canvas-ipc.js；vaultRoot 函数每次调用现取，不缓存旧库。注册在 electron/main.js 的 notesIpc 之后，vaultRoot:()=>notesIpc.currentVault()。
- 在 manifest known permissions 加 canvas；仅申请 canvas 时 ctx.canvas 存在。其公开 API：library()->{boards:[{path,name}],notes:[{path,title,kind}],images:[{path,name}]}; create(name)->{path,graph,revision}; read(path)->{path,graph,revision}; write(path,graph,revision)->{path,revision}; importImage(path,{name,bytes,mimeType})->{file,name}; media(file)->{dataUrl}。
- 主进程频道名称 canvas:library/create/read/write/importImage/media，ctx 与 preload 保持对应。文件引用正文使用现有 ctx.vault.readText/writeText，不新增任意 fs 能力。
- 数据只存 <vault>/画布/<name>.canvas，图片只存各画布素材目录（如 <name>.assets），返回 vault-relative 路径。名字拒绝空、100码点以上、Windows保留设备名、非法路径分隔符；重名明确拒绝，不覆盖。
- create/read/write 主进程严格 lex+realpath vault/path 检查，拒绝 Symlink/junction 逃逸、库外/其他非canvas文件、非文件。write 不得新建任意路径，使用当前读取的 sha256 revision 对磁盘 CAS，串行化 compare+atomic write，防止数据丢失；换库时不写进新库同名文件。
- PNG/JPEG/WEBP/GIF/BMP 图片限制20MiB，合法 MIME+extension+magic，拒绝 SVG/HTML，媒体返回 dataURL，禁止任意网络/外部文件读取。
- 未配置 Vault library 返回明确空结果/原因，UI可展示；其余操作明确失败，不自动生成真实库示例。

## Workflow

读取适用技能/项目指令，TDD先新增测试并运行见RED（模块缺失是预期），随后实现安全接口；行为测试必须在真实临时目录读写并覆盖坏输入、冲突并发、重名、切库与媒体。基线可只跑ctx、manifest、notes-ipc相关测试；主控制者最后跑全量。

## Report

完整报告写 E:/project/kaiwu/docs/superpowers/plans/note-canvas-storage-report.md：文件清单、接口实际形态、RED命令/失败原因、GREEN命令/结果、安全边界、自审发现/疑问。返回15行以内状态和测试摘要。不得提交、重置、改用户已有日志或真实库，使用apply_patch。
