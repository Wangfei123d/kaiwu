// Vault 的路径约束。主进程与渲染进程共用。
//
// 这是笔记子系统的安全边界:Agent 能读笔记、插件可能想访问附件、
// 渲染进程会按相对路径请求文件 —— 三者都必须被限制在 Vault 目录之内。
// 做法与内核的 toolbox:// 守卫**完全一致**(两层),因为踩过的坑是一样的:
//
//   第一层 词法层  —— 挡 ../、绝对路径、盘符、UNC、编码穿越
//   第二层 真实路径层 —— 挡符号链接与目录联接逃逸
//
// 为什么不能省第二层:Vault 里放一个指向 C:\ 的目录联接,vault/escape/secret.txt
// 词法上确实在 Vault 内。内核里已经实测过这个逃逸,笔记这里同样成立。

import fs from 'node:fs';
import path from 'node:path';
// 家族判据只有一份,而且**渲染进程也要用** —— 所以它住在不碰 fs 的 note-kind.js 里,
// 这里只做转发(既有的 import { NOTE_EXT, isNotePath } from 'vault-path.js' 全部照旧)。
import { NOTE_EXT, TEXT_EXT, isNotePath, isMarkdownPath, isTextPath, noteKindOf } from './note-kind.js';

export { NOTE_EXT, TEXT_EXT, isNotePath, isMarkdownPath, isTextPath, noteKindOf };

/**
 * 纯词法层:把相对路径解析到 root 之内,越界返回 null。
 * @param {string} root
 * @param {string} relativePath
 * @returns {string|null}
 */
export function resolveInside(root, relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
    if (typeof root !== 'string' || root.length === 0) return null;

    // 先解码:挡住 ..%2f 这类编码过的穿越
    let decoded;
    try {
        decoded = decodeURIComponent(relativePath);
    } catch {
        return null;                       // 非法百分号编码
    }

    if (path.isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded) || decoded.startsWith('\\\\')) {
        return null;
    }

    const rootAbs = path.resolve(root);
    const target = path.resolve(rootAbs, decoded);

    // 比较时补分隔符,避免 "…/vault-evil" 被误判为在 "…/vault" 之内
    const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
    if (target !== rootAbs && !target.startsWith(prefix)) return null;

    return target;
}

/**
 * 真实路径层:在词法层之上用 realpath 落到真实位置再判包含。
 *
 * 目标可以不存在(新建笔记时还没写盘),这时校验它最近的**已存在祖先** ——
 * 但不能退化成"直接返回祖先路径":那样包含判断会拿根本身去比,恒真,
 * 这一层就废了(内核里踩过这个坑)。所以这里分开做:
 *   - 已存在 → 用 realpath 判包含
 *   - 不存在 → 逐级上溯到最近的已存在祖先,判它在 Vault 内,再拼回剩余部分
 *
 * @param {string} root
 * @param {string} relativePath
 * @returns {string|null} 可安全读写的绝对路径
 */
export function resolveInsideReal(root, relativePath) {
    const lexical = resolveInside(root, relativePath);
    if (lexical === null) return null;

    let realRoot;
    try {
        realRoot = fs.realpathSync(path.resolve(root));
    } catch {
        return null;                       // Vault 本身不存在
    }

    // 逐级上溯:找到 target 自己或它最近的已存在祖先
    const missing = [];
    let probe = lexical;
    let realProbe = null;
    while (true) {
        try {
            realProbe = fs.realpathSync(probe);
            break;
        } catch {
            const parent = path.dirname(probe);
            if (parent === probe) return null;         // 到卷根仍不存在
            missing.unshift(path.basename(probe));
            probe = parent;
        }
    }

    // 已存在部分必须在 Vault 内
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realProbe !== realRoot && !realProbe.startsWith(prefix)) return null;

    // 把还不存在的部分拼回去(它们都在已确认安全的祖先之下)
    return missing.length === 0 ? realProbe : path.join(realProbe, ...missing);
}

/**
 * 把绝对路径转成相对 Vault 的路径(统一用 / 分隔)。
 * 不在 Vault 内返回 null。
 * @param {string} root
 * @param {string} absolutePath
 * @returns {string|null}
 */
export function relativeToVault(root, absolutePath) {
    const rootAbs = path.resolve(root);
    const target = path.resolve(absolutePath);
    const rel = path.relative(rootAbs, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}

/**
 * 列出 Vault 下的 Markdown 笔记、纯文本、**目录**、以及**其他文件**。
 *
 * 为什么目录也要返回:侧栏要按树状展示,而"空文件夹"在笔记清单里根本不出现 ——
 * 用户刚建的那个文件夹会看不见,看着就像"没建成"。跳过的目录与笔记同一套规则
 * (以 . 开头的、node_modules),排序稳定(字典序),便于测试与界面展示。
 *
 * 为什么还要返回 `others`:笔记树原来只列 `.md`,于是短剧项目里那 25 张 png、
 * 1 个 docx、1 个 json **在树里根本看不见** —— 也就无从"拖进文件夹"。
 * 整理文件是真实诉求,所以把非笔记文件也列出来(带大小与 mtime,便于显示与拖动)。
 *
 * 为什么 `.txt` 要单独一桶(而不是塞进 `files`):用户明确要求纯文本**可编辑但和
 * Markdown 隔开** —— 不进链接图、不进标签、不认 frontmatter。索引与建图只读 `files`,
 * 于是"隔开"这件事**由数据结构保证**,而不是靠每个消费方记得去过滤。
 *
 * ⚠️ `maxFiles` 仍然是**Markdown 笔记数的上限**(既有语义不能变:`notes.errors` 与
 * "已载入 N 篇"都读它)。纯文本与非笔记文件各有自己的上限,三者互不挤占 ——
 * 否则一个装满图的 `shots/` 会把笔记名额吃光。
 *
 * @param {string} root
 * @param {{maxFiles?:number, maxTexts?:number, maxOthers?:number, withStats?:boolean}} [options]
 * @returns {Promise<{files:string[], folders:string[], texts:Array<{path:string,name:string,size:number,mtimeMs:number}>, others:Array<{path:string,name:string,size:number,mtimeMs:number}>}>}
 */
export async function listVaultTree(root, options = {}) {
    const maxFiles = options.maxFiles ?? 20000;
    // 纯文本笔记与 Markdown 笔记同等对待(它也是"用户的笔记"),所以同一个数量级。
    const maxTexts = options.maxTexts ?? maxFiles;
    // 默认比笔记上限小一个量级:文件是"顺带看得见",不该把索引拖成几万条。
    const maxOthers = options.maxOthers ?? 2000;
    // 要 size/mtime 就得多一次 stat(每文件一次系统调用)—— 明确要求时才做。
    const withStats = options.withStats === true;
    const files = [];
    const folders = [];
    const texts = [];
    const others = [];

    async function walk(dirAbs, relPrefix) {
        let entries;
        try {
            entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
        } catch {
            return;                        // 读不了就跳过,不让单个坏目录炸掉整次索引
        }

        for (const entry of entries) {
            const name = entry.name;

            if (entry.isDirectory()) {
                if (name.startsWith('.') || name === 'node_modules') continue;
                const rel = relPrefix ? `${relPrefix}/${name}` : name;
                folders.push(rel);
                await walk(path.join(dirAbs, name), rel);
                continue;
            }

            if (!entry.isFile()) continue;
            const rel = relPrefix ? `${relPrefix}/${name}` : name;

            if (isMarkdownPath(name)) {
                if (files.length >= maxFiles) continue;
                files.push(rel);
                continue;
            }

            // 纯文本:与"其他文件"同一套忽略规则,但要带大小与 mtime(树里要显示、要拖)。
            if (isTextPath(name)) {
                if (name.startsWith('.')) continue;
                if (texts.length >= maxTexts) continue;
                const item = { path: rel, name, size: 0, mtimeMs: 0 };
                if (withStats) {
                    try {
                        const st = await fs.promises.stat(path.join(dirAbs, name));
                        item.size = st.size;
                        item.mtimeMs = st.mtimeMs;
                    } catch { /* 单个文件 stat 失败不该影响整次索引 */ }
                }
                texts.push(item);
                continue;
            }

            if (others.length >= maxOthers) continue;
            // 与目录同一套忽略规则:隐藏文件不进树(否则 .DS_Store 之类会刷屏)
            if (name.startsWith('.')) continue;
            const item = { path: rel, name, size: 0, mtimeMs: 0 };
            if (withStats) {
                try {
                    const st = await fs.promises.stat(path.join(dirAbs, name));
                    item.size = st.size;
                    item.mtimeMs = st.mtimeMs;
                } catch { /* 单个文件 stat 失败不该影响整次索引 */ }
            }
            others.push(item);
        }
    }

    await walk(path.resolve(root), '');
    const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return {
        files: files.sort(),
        folders: folders.sort(),
        texts: texts.sort(byPath),
        others: others.sort(byPath),
    };
}

/**
 * 列出 Vault 下所有 Markdown 笔记的相对路径(树接口的薄封装,签名保持不变)。
 *
 * ⚠️ 语义**没有**跟着家族扩大而变:这里仍然只回 `.md` —— "已载入 N 篇"读的是它。
 * @param {string} root
 * @param {{maxFiles?:number}} [options]
 * @returns {Promise<string[]>}
 */
export async function listNoteFiles(root, options = {}) {
    return (await listVaultTree(root, options)).files;
}
