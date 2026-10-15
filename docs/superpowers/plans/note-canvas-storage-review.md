# Task1 独立规格与质量审查

2026-10-09，由全新只读审查者 /root/note_canvas_storage_review 根据 scoped review brief 执行；不审无关用户 dirty 历史，不修改代码或 Git 状态。主代理也读取新增模型/存储源码，并独立运行相关测试及真实临时库探针。

## 结论

规格通过，质量通过。Critical 0 / 未解决 Important 0 / Minor 0。

确认 lex/realpath/junction 防线、同名画布拒绝、串行 SHA256 CAS、Vault token 与最终写入 guard、权限/桥接一致、图片 MIME/扩展/magic 与限额。原笔记编码/备份默认语义保持。

## 已修复 Important

初始 canvas.writeNote 没有写入限额。20 MiB+1 ASCII 输入会先覆盖原笔记，再在写后 hash 大小检查报错；多字节 UTF-8 与原 txt CRLF/BOM 展开后超限同样存在。主代理真实临时库探针得到 error「文件大小超过允许上限」，磁盘 size20971521，原文被替换。

修复：note-index.writeNote 新增可选 maxBytes，在最终编码字节计算后、备份与原子写之前检查；canvas 明确传20MiB，旧notes无此选项则行为不变。4个新增行为用例分别验证ASCII/multibyte/BOM+CRLF/maxBytes，拒绝时原文和已有备份不变。

独立审查者观察4项RED，然后重读修复并独立运行6个文件：221 tests / 221 pass / exit0。没有其他阻塞发现，可进入Task2。

所有行为探针使用自动清理的真实临时库，没有写入真实笔记库，没有重启/模型请求。
