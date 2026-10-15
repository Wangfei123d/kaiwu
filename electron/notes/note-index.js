// 笔记索引。主进程专属(需要 fs)。
//
// 设计要点:
//   - 索引是**派生数据**:删掉能从 .md 文件完整重建。所以它可以放心用缓存加速,
//     而用户永远不需要担心"索引坏了笔记就没了"。
//   - 首版**不落数据库**:先把"扫目录 → 解析 → 建图"这条链跑通并测稳,
//     再决定是否要 SQLite 加速。过早引入数据库会把可测试性拖下去。
//   - 不做实时文件监听(fs.watch 在 Windows 上不可靠):调用方按需 refresh()。

import fs from 'node:fs';
import path from 'node:path';
// 纯逻辑都在 app/lib —— 与内核同一套分界
import {
    listVaultTree, resolveInsideReal, relativeToVault, isNotePath, isMarkdownPath, noteKindOf,
} from '../../app/lib/vault-path.js';
import { decodeText, encodeText, newlineStyleOf, applyNewline } from '../../app/lib/text-encoding.js';
import { readFrontmatter, writeFrontmatter, splitFrontmatter } from '../../app/lib/frontmatter.js';
import { parseWikilinks, parseTags, parseHeadings } from '../../app/lib/wikilink.js';
import { buildGraph, baseName } from '../../app/lib/note-graph.js';

/**
 * 解析一篇笔记的原始文本为索引项。
 * 纯计算,不碰文件系统 —— 便于单测直接用字符串构造。
 *
 * @param {{relPath:string, text:string, mtimeMs?:number, size?:number}} input
 * @returns {object} 索引项
 */
export function parseNote({ relPath, text, mtimeMs = 0, size = 0 }) {
    const { data, body } = readFrontmatter(text);

    const fmTags = Array.isArray(data.tags)
        ? data.tags.map(String)
        : (typeof data.tags === 'string' && data.tags !== '' ? [data.tags] : []);

    const links = parseWikilinks(body);
    const headings = parseHeadings(body);
    const tags = parseTags(body, fmTags);

    // 标题优先取 frontmatter.title,否则取第一个 H1,再否则用文件名
    const firstH1 = headings.find(h => h.level === 1);
    const title = (typeof data.title === 'string' && data.title.trim() !== '')
        ? data.title.trim()
        : (firstH1 ? firstH1.text : baseName(relPath).replace(/\.md$/i, ''));

    return {
        id: relPath,
        path: relPath,
        title,
        frontmatter: data,
        tags,
        headings,
        links,
        // 供建议链接与全文搜索用的正文
        body,
        mtimeMs,
        size,
    };
}

/**
 * 扫描整个 Vault,产出索引与链接图。
 *
 * @param {string} root - Vault 绝对路径
 * @param {{maxFiles?:number, log?:object}} [options]
 * @returns {Promise<{root:string, notes:object[], texts:object[], graph:object, errors:Array<{path:string,message:string}>}>}
 */
export async function indexVault(root, options = {}) {
    const log = options.log ?? console;
    const errors = [];

    let absRoot;
    try {
        absRoot = fs.realpathSync(path.resolve(root));
    } catch {
        return { root: path.resolve(root), notes: [], texts: [], graph: buildGraph([]), errors: [{ path: String(root), message: 'Vault 目录不存在' }] };
    }

    const { files: relPaths, folders, texts, others } = await listVaultTree(absRoot, {
        maxFiles: options.maxFiles,
        maxTexts: options.maxTexts,
        maxOthers: options.maxOthers,
        // 树里要显示"多大 / 多久没动",所以这里明确要 stat。
        withStats: true,
    });
    const notes = [];

    for (const relPath of relPaths) {
        // 经过真实路径层再读 —— 挡住 Vault 内的符号链接逃逸
        const abs = resolveInsideReal(absRoot, relPath);
        if (abs === null) {
            errors.push({ path: relPath, message: '路径越出 Vault,已跳过' });
            continue;
        }
        try {
            const stat = await fs.promises.stat(abs);
            // ⚠️ 这里从前是 `readFile(abs,'utf8')` —— 于是**仅仅把列表列出来**这一个动作,
            //    就会把非法字节有损替换成 U+FFFD 塞进内存、再当作"用户的正文"递给渲染进程。
            //    现在与 readNote 同一套判据:解得开才解析;解不开的只**列出来并标成打不开**,
            //    正文一律留空 —— 宁可列表上少一点信息,也不许把替换过的文本当内容。
            const buf = await fs.promises.readFile(abs);
            const decoded = decodeText(buf);
            if (decoded.ok !== true) {
                const reason = decodeFailureMessage(relPath, decoded);
                errors.push({ path: relPath, message: reason });
                log.warn?.(`[notes] ${reason}`);
                // 只有 .md 会走到这个循环(见 listVaultTree:files 只收 Markdown);
                // 判一次是为了将来树的口径变了也不会把 .txt 混进 notes。
                if (isMarkdownPath(relPath)) {
                    notes.push(unreadableNote({ relPath, stat, reason }));
                }
                continue;
            }
            notes.push({
                ...parseNote({ relPath, text: decoded.text, mtimeMs: stat.mtimeMs, size: stat.size }),
                readable: true,
            });
        } catch (err) {
            // 单篇读失败不该让整次索引失败 —— 与内核"坏插件不拖垮应用"同一原则
            errors.push({ path: relPath, message: err.message });
            log.warn?.(`[notes] 读取失败 ${relPath}: ${err.message}`);
        }
    }

    // `texts`:纯文本笔记(.txt)。⚠️ **刻意不解析**:不读 frontmatter、不取 [[链接]]、
    // 不取 #标签、不进 buildGraph —— 用户要的就是"和 Markdown 隔开"。
    // 这里只把树要用的三样东西带上(路径 / 名字 / 大小 mtime),它们在树里是**能点开编辑的**行。
    // `others`:非笔记文件(png / docx / json …)。树里把它们显示出来,
    // "拖进文件夹"才有意义 —— 只列 .md 的话,那些 shots/ 里的图根本无从拖起。
    return { root: absRoot, notes, texts, folders, others, graph: buildGraph(notes), errors };
}

/**
 * 把"解不开"翻译成**给用户看的一句话**(带文件名)。
 *
 * 为什么要在 decodeText 的 reason 之上再包一层:那句 reason 是说"通用文本"的
 * (它不知道自己正在读一篇笔记),而用户需要听到三件事:
 *   ① 是**哪一篇**(列表里可以有很多篇);
 *   ② **为什么**(NUL / 不是合法 UTF-8 / 认不出编码);
 *   ③ **为什么宁可不打开** —— 这一条最要紧:开物不是"打不开",而是**有意**不打开。
 *      唯一能把它"打开"的办法是把非法字节有损替换成 U+FFFD,而那等于替用户
 *      把笔记改坏(真库里已经有一篇这样了:5306 B、1203 个字面 U+FFFD、不可逆)。
 *
 * @param {string} relPath
 * @param {{encoding:string, ok:boolean}} decoded decodeText 的结果
 * @returns {string}
 */
function decodeFailureMessage(relPath, decoded) {
    const cause = decoded.encoding === 'binary'
        ? '开头就出现了 NUL 字节,不是文本'
        : '字节既不是合法 UTF-8,也认不出是哪种中文编码';
    return `「${relPath}」不是能安全打开的文本文件:${cause}(可能被别的程序写坏了)—— 为避免把它改坏,开物不打开它`;
}

/**
 * 一篇**解不开**的 .md 在索引里长什么样。
 *
 * 为什么不干脆把它从列表里摘掉:它是**用户的文件**。一篇笔记在列表里凭空消失,
 * 比"列着但打不开"更吓人(用户会以为笔记丢了)。所以照常列出来,但:
 *   · `readable:false` —— 界面据此挂「打不开」小标,点开时给状态行一句人话;
 *   · 正文 / 链接 / 标签**全部留空** —— 绝不把有损解码的结果当用户的内容交出去;
 *   · 标题退回文件名 —— 不猜(猜出来的标题本身就是替换过的字节)。
 *
 * @param {{relPath:string, stat:{mtimeMs:number, size:number}, reason:string}} input
 */
function unreadableNote({ relPath, stat, reason }) {
    return {
        id: relPath,
        path: relPath,
        title: baseName(relPath).replace(/\.md$/i, ''),
        frontmatter: {},
        tags: [],
        headings: [],
        links: [],
        body: '',
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        readable: false,
        reason,
    };
}

/**
 * 读一篇笔记的原文(.md 或 .txt)。
 *
 * ⚠️ **两条路走同一套编解码判据**(见 app/lib/text-encoding.js),都不写死 utf8:
 *   · 别人给的 .txt 可能是 GBK/UTF-16;.md 也一样(笔记库会被别的程序碰);
 *   · 二进制与认不出编码的文件**拒绝**当文本打开,给出人话原因 ——
 *     关键在"拒绝"两个字,见下面的 .md 说明;
 *   · 顺带把"能不能写回"告诉界面:只有 UTF-8(含 BOM)能 —— GBK 编不回去就不许写。
 *
 * ⚠️ 为什么 .md 从前写死 utf8 是一件**会毁数据**的事,而不是"读出来是乱码"那么轻:
 *   Node 的 `readFile(abs,'utf8')` 会把非法字节**有损替换**成 U+FFFD(且不报错),
 *   而保存时 `Buffer.from(payload,'utf8')` 又把那些 U+FFFD 编回去。
 *   ⇒ **打开一次 + 保存一次,用户的原文就被永久改写成一堆 U+FFFD**,不可逆。
 *   真库里的前后两态就是这么来的(`AI会话/2026-09-27-…md` 非法 → `短剧/未命名 2.md`
 *   1203 个字面 U+FFFD)。所以现在的规矩只有一句:**宁可拒绝,也不许有损改写** ——
 *   既不许把有损解码的结果交给编辑器,也不许把它写回磁盘。
 *
 * @param {string} root
 * @param {string} relPath
 * @returns {Promise<{text:string, mtimeMs:number, size:number, kind:string, encoding:string,
 *                    bom:boolean, newline:string, editable:boolean, reason:string}>}
 */
export async function readNote(root, relPath) {
    const kind = noteKindOf(relPath);
    if (kind === null) throw new Error('只允许读写 .md / .txt 笔记文件');
    const abs = resolveInsideReal(root, relPath);
    if (abs === null) throw new Error('路径越出 Vault');
    const stat = await fs.promises.stat(abs);

    const buf = await fs.promises.readFile(abs);
    const decoded = decodeText(buf);
    if (decoded.ok !== true) {
        // .md 与 .txt 的差别只在这一句人话上:.md 是我们自己那一族,要用"哪一篇 + 为什么"
        // 说清楚;.txt 是"别人给的文件",沿用 decodeText 那句通用原因(既有文案不许变)。
        throw new Error(kind === 'markdown'
            ? decodeFailureMessage(relPath, decoded)
            : (decoded.reason || '这份文件不是文本,不能按文本打开'));
    }

    return {
        text: decoded.text, mtimeMs: stat.mtimeMs, size: stat.size, kind,
        encoding: decoded.encoding, bom: decoded.bom, newline: decoded.newline,
        editable: decoded.editable, reason: decoded.reason,
    };
}

/**
 * 原子写入一篇笔记(.md 或 .txt)。
 *
 * 为什么要原子写:直接 writeFile 时若中途断电/崩溃,用户会得到一个**被截断的笔记**。
 * 笔记是用户的资产,这种损失不可接受。做法:写临时文件 → fsync → rename。
 * rename 在同一卷上是原子的,所以文件要么是旧的完整内容,要么是新的完整内容。
 *
 * 另:覆盖已有文件前留一份 .bak —— 这是给「AI 改笔记」兜底的第二道防线
 * (第一道是 diff 提案与用户确认)。
 *
 * ⚠️ 落盘前**一定先读懂磁盘上那一份**(.md 与 .txt 都要):
 *   ① **解不开的一律拒绝写**:含非法字节 / NUL 的内容不许 decode-then-re-encode 写回去
 *      —— 那正是"打开一次就把笔记毁掉"的那条流水线(见 readNote 的说明);
 *   ② **不许把编不回去的编码写回去**:Node 的 TextEncoder 只出 UTF-8,所以
 *      GBK / UTF-16 一律拒绝写盘(界面早就把它显示成只读了,这里是第二道闸);
 *   ③ **换行按原文还原**(只对 .txt):CRLF 的 txt 保存后仍然是 CRLF —— 否则在 git/diff 里
 *      "一行没改却全亮",而用户根本没动过内容。.md 不做这一步,理由见下面。
 *
 * ⚠️ 顺序也是契约:①②③ 与留备份都必须**排在 atomic 写之前**,而且**拒绝要拒绝得干净**
 *    —— 一次被拒绝的保存不在用户的笔记库里留下任何东西(连 .bak 都不留)。
 *
 * @param {string} root
 * @param {string} relPath
 * @param {string} text
 * @param {{backup?:boolean, beforeWrite?:()=>void|Promise<void>, maxBytes?:number}} [options] 落盘前守卫可阻止切库/版本冲突；maxBytes 限制最终编码字节。
 */
export async function writeNote(root, relPath, text, options = {}) {
    const kind = noteKindOf(relPath);
    if (kind === null) throw new Error('只允许读写 .md / .txt 笔记文件');

    const abs = resolveInsideReal(root, relPath);
    if (abs === null) throw new Error('路径越出 Vault');

    await options.beforeWrite?.();
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });

    // 纯文本:按**磁盘上那份文件**的编码与换行决定怎么落盘(不信任调用方传什么)。
    //
    // ⚠️ 这一道闸现在对 **.md 同样**开着,而且必须排在**留备份之前**:
    //    · 从前的 .md 直接 `Buffer.from(payload,'utf8')` —— 于是"打开一篇含非法字节的
    //      .md 再保存"就把有损解码的结果永久写了回去(本次要修的就是这条);
    //    · .md 也必须过"能不能安全写回":GBK / UTF-16 解得开但编不回去,
    //      写回去等于把用户的文件悄悄换成另一种编码;
    //    · **拒绝就要拒绝得干净** —— 先挡再备份:一次被拒绝的保存不该在用户的笔记库里
    //      留下任何东西(.bak 也不行,那会让"什么都没发生"变成长出一个同名副本)。
    let payload = String(text ?? '');
    const bounded = bytes => {
        if (options.maxBytes !== undefined && bytes.length > options.maxBytes) {
            throw new Error('笔记保存大小超过允许上限');
        }
        return bytes;
    };
    if (fs.existsSync(abs)) {
        const current = decodeText(await fs.promises.readFile(abs));
        if (current.ok !== true) {
            throw new Error(`不能保存:${decodeFailureMessage(relPath, current)}`);
        }
        if (current.editable !== true) {
            throw new Error(`这份文件是 ${current.encoding},开物不能安全写回(只支持 UTF-8);请用系统程序编辑`);
        }
        // 纯文本还多一道:换行按原文还原(CRLF 的 txt 存回去仍然是 CRLF)。
        // ⚠️ .md **不做**这一步:它的行尾由编辑器原样带回来,在这里再"统一"一次会把
        //    混合行尾的文件改出一次凭空多出来的 diff(逐字节往返那条用例钉着这一点)。
        if (kind === 'text') payload = applyNewline(payload, current.newline);

        // 先按原编码补回 BOM / 行尾，再判字节上限；拒绝不能动正文或已有备份。
        const encoded = bounded(encodeText(payload, current));
        const backup = options.backup !== false;
        if (backup) {
            await options.beforeWrite?.();
            try {
                await fs.promises.copyFile(abs, abs + '.bak');
            } catch {
                // 备份失败不阻断写入:它只是额外的保险,不是主路径
            }
        }
        // 原样按读进来时的编码落回(BOM 要补回去,否则往返就不是逐字节一致了)
        return { path: relPath, ...(await writeAtomic(abs, encoded, options.beforeWrite)) };
    }

    // 磁盘上还没有这一篇:没有"原来是什么编码"这个问题,新文件一律 UTF-8 无 BOM。
    return { path: relPath, ...(await writeAtomic(abs, bounded(Buffer.from(payload, 'utf8')), options.beforeWrite)) };
}

/**
 * 原子落盘:写临时文件 → fsync → rename。
 *
 * 单拆出来是因为调用方不止一处(新建 / 覆盖 / 未来的 Proposal 落盘),
 * 而"原子"这件事只该有一份实现 —— 两份迟早有一份忘了 fsync。
 *
 * @param {string} abs 绝对路径(已经过 resolveInsideReal)
 * @param {Buffer} bytes
 */
async function writeAtomic(abs, bytes, beforeWrite) {
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    let handle;
    let created = false;
    try {
        await beforeWrite?.();
        handle = await fs.promises.open(tmp, 'wx');
        created = true;
        await handle.writeFile(bytes);
        await handle.sync();               // 落盘,再 rename
        await handle.close();
        handle = null;
        // 守卫与最终 rename 同一同步段，检查之后不再让出事件循环。
        await beforeWrite?.();
        fs.renameSync(tmp, abs);
    } finally {
        if (handle) await handle.close();
        if (created && fs.existsSync(tmp)) await fs.promises.unlink(tmp);
    }
    const stat = await fs.promises.stat(abs);
    // ⚠️ 只回 mtime/size:`path` 由调用方补**相对路径**(从前就是这么回的 ——
    //    这里若回绝对路径,渲染进程那边的 currentPath 会突然变成绝对路径)。
    return { mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * 新建一篇笔记。已存在则抛错(不覆盖用户已有的内容)。
 * @param {string} root
 * @param {string} relPath
 * @param {string} [text]
 */
export async function createNote(root, relPath, text = '') {
    // ⚠️ 只有 **Markdown** 能由界面新建。.txt 是"别人给的文件",开物只负责打开与改它,
    //    不负责凭空造一个(新建笔记那条路会写 frontmatter/标题,那是 Markdown 的语义)。
    if (!isMarkdownPath(relPath)) throw new Error('只允许创建 .md 笔记文件');
    const abs = resolveInsideReal(root, relPath);
    if (abs === null) throw new Error('路径越出 Vault');
    if (fs.existsSync(abs)) throw new Error(`笔记已存在:${relPath}`);

    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, text, 'utf8');
    return { path: relPath };
}

/**
 * 新建一个**文件夹**(Vault 内的相对目录)。
 *
 * 为什么不让调用方直接 mkdir:这一步同样过 Vault 的路径守卫(两层),
 * 而且**不递归**创建 —— recursive 会把 `a/b/c` 一路造出来,而界面上的
 * "新建文件夹"永远是单层的:真递进来一个多级路径,那是调用方出错了,
 * 应该报错而不是替它猜。
 *
 * @param {string} root
 * @param {string} relPath Vault 内的相对目录路径
 */
export async function createFolder(root, relPath) {
    const rel = String(relPath ?? '').trim();
    if (rel === '') throw new Error('文件夹名不能为空');
    const abs = resolveInsideReal(root, rel);
    if (abs === null) throw new Error('路径越出 Vault');
    if (fs.existsSync(abs)) throw new Error(`文件夹已存在:${rel}`);

    const parent = path.dirname(abs);
    if (!fs.existsSync(parent)) throw new Error('上层文件夹不存在');
    await fs.promises.mkdir(abs);
    return { path: rel.split(path.sep).join('/') };
}

/**
 * 把文件内容里的 frontmatter 换掉,正文原样保留。
 *
 * 存在的意义:AI 改元数据(标题/标签)时**不应该**碰正文一个字。
 * 这个函数保证只有 frontmatter 段被重写。
 *
 * @param {string} text
 * @param {object} data
 * @returns {string}
 */
export function replaceFrontmatter(text, data) {
    const { body } = readFrontmatter(text);
    return writeFrontmatter(data, body);
}

/**
 * 把正文里**第一个 H1** 的标题换掉;没有 H1 就原样返回。
 *
 * 为什么需要它:标题解析顺序是 `frontmatter.title → 第一个 H1 → 文件名`(见 parseNote)。
 * 所以给笔记改名时**只改文件名是不够的** —— 正文里那个旧 H1 会把新标题盖回去,
 * 用户看到的就是"命名好了、列表里却还是旧名字"。反过来,笔记本来没有 H1 时,
 * 标题由文件名决定,正文一个字都不该动。
 *
 * 用 parseHeadings 找 H1 而不是自己写正则:它已经把围栏代码块里的内容抹掉了,
 * 与 parseNote 的标题判定**同源**,不会出现"索引说这行是标题、这里说不是"。
 *
 * @param {string} text
 * @param {string} title
 * @returns {string}
 */
export function setBodyTitle(text, title) {
    const { raw, body, hasFrontmatter } = splitFrontmatter(text);
    const firstH1 = parseHeadings(body).find(h => h.level === 1);
    if (firstH1 === undefined) return text;

    // 换行必须压成空格:否则这一行会被写成两行,后一半漏进正文
    const clean = String(title ?? '').replace(/\r?\n/g, ' ').trim();

    const lines = body.split('\n');
    lines[firstH1.line - 1] = replaceBodyTitleLine(lines[firstH1.line - 1], clean);

    const nextBody = lines.join('\n');
    // 拼回原来的 frontmatter 原文(raw 自带结尾换行),不重新序列化 —— 元数据一字不动
    return hasFrontmatter ? `---\n${raw}---\n${nextBody}` : nextBody;
}

/**
 * 只换掉 H1 那一行,并**沿用该行原来的行尾**。
 *
 * 为什么不能直接写 `# ${clean}`:CRLF 笔记里被改的那一行会变成孤零零的 LF,
 * 于是用户"只改了标题",git diff 却说他改了标题**和**行尾(整行都变)。
 * 这类噪音不会报错,只会让人不敢改标题。
 *
 * @param {string} line 原来那一行的文本(body 按 '\n' 切过,所以 CRLF 行尾的 \r 还在)
 * @param {string} title 已经压好换行的新标题
 * @returns {string}
 */
function replaceBodyTitleLine(line, title) {
    const eol = typeof line === 'string' && line.endsWith('\r') ? '\r' : '';
    return `# ${title}${eol}`;
}

/**
 * 纯大小写改名。
 *
 * Windows 与 macOS 的默认卷大小写不敏感:`bar.md` → `Bar.md` 里"目标"已经存在,
 * 于是旧实现抛「目标已存在」。而直接 rename 也常常只改了一半(目录项里存下来的
 * 仍是旧拼写),索引与列表上就看不出改过。两步法(先临时名、再目标名)两边都解决。
 *
 * 放在这里(与 moveNoteBackup 同处)是因为**笔记本身与它的 .bak 都需要这一步**:
 * 只在笔记上做、.bak 不做,结果就是 `Bar.md` 旁边躺着一个 `bar.md.bak` ——
 * 同一次改名,两个名字两套拼写。
 *
 * @param {string} absFrom
 * @param {string} absTo
 */
export async function renameCaseOnly(absFrom, absTo) {
    const tmp = `${absFrom}.case-${process.pid}-${Date.now()}`;
    await fs.promises.rename(absFrom, tmp);
    try {
        await fs.promises.rename(tmp, absTo);
    } catch (err) {
        // 第二步失败要退回原名,否则用户的笔记会停在一个谁也想不到的临时名字上
        try { await fs.promises.rename(tmp, absFrom); } catch { /* 退回也失败就只能照实报错 */ }
        throw err;
    }
}

/**
 * 把 `<旧名>.bak` 搬到 `<新名>.bak`,覆盖已存在的那份。
 *
 * 为什么备份必须跟着改名走:`writeNote` 的注释说明了备份是**有意的一代**兜底
 * (给「AI 改笔记」留的后悔药)。但备份名是"当前文件名 + .bak",改名以后它就停在
 * **旧名字**下了 —— 列表上看不见它,可它带着完整内容继续住在用户的笔记库里,
 * 而且下一次改名还会再留一份。搬过去 = 一共只有一代,且它对应的就是这个名字。
 *
 * 失败不阻断改名:README 那条理由(备份是额外保险,不是主路径)在这里同样成立 ——
 * 为一个搬不动的备份把改名整个拦下,代价比收益大。
 *
 * ⚠️ 判等必须用 isSameFile 而不是字符串:在大小写不敏感的卷上,纯大小写改名时
 * `bar.md.bak` 与 `Bar.md.bak` 是**同一个文件** —— 那时先 `rm(to)` 就等于把手里的
 * 待搬文件删了,紧接着的 rename 抛 ENOENT 又被下面的 catch 吞掉,净结果是
 * **备份静默消失**(用户刚被承诺的那一代后悔药没了,而且没有任何日志)。
 *
 * @param {string} root
 * @param {string} relPath 改名**后**的相对路径
 * @param {string} previousRelPath 改名**前**的相对路径
 */
export async function moveNoteBackup(root, relPath, previousRelPath) {
    if (relPath === previousRelPath) return;
    const from = resolveInsideReal(root, `${previousRelPath}.bak`);
    const to = resolveInsideReal(root, `${relPath}.bak`);
    if (from === null || to === null || from === to) return;
    if (!fs.existsSync(from)) return;
    try {
        // 同一个文件(纯大小写改名)时**不能** rm(to):那会先把待搬的 from 删掉。
        // 但也不能就这样收工 —— 目录项里存下来的还是旧拼写(`bar.md.bak` 挨着
        // `Bar.md`),而"改大小写"的全部意义就是让目录项跟着变,所以走与笔记
        // 本身相同的两步改名。
        if (isSameFile(from, to)) {
            await renameCaseOnly(from, to);
            return;
        }
        await fs.promises.rm(to, { force: true });
        await fs.promises.rename(from, to);
    } catch {
        // 见上:搬不动就留着,但绝不让它把改名弄失败。
        // 取舍写在这里:一个搬不动的 .bak(被占用/权限/跨卷)只在库里留下一份
        // 旧名字下的备份 —— 不完美,但比"为一个额外保险让用户改不了名"便宜。
    }
}

/**
 * 两个绝对路径是否指向**同一个文件**。
 *
 * 为什么不能只比字符串:在大小写不敏感的 fs(Windows / macOS 默认卷)上,
 * `bar.md` 与 `Bar.md` 是同一个文件。把 `Bar.md` 判成"别人占着"会把
 * "只改大小写"这种最正常的改名整个拒掉,而那个"别人"就是他自己。
 *
 * 优先比 ino+dev(唯一标识一个文件,与拼写无关);比不了(有的 fs 不给 ino)时
 * 退回 realpath 比较。两者都不下结论时返回 false —— 交回给"目标已存在"那条路。
 *
 * 放在这里(而不是 notes-ipc.js)是因为**改名与搬备份两处都要用同一份判据**:
 * 各写一份迟早会分叉,而分叉的后果正是 N1 —— 改名那半认得出"是同一个文件",
 * 搬备份那半只比字符串,于是把待搬的文件自己删了。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameFile(a, b) {
    if (a === b) return true;
    try {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        if (sa.ino !== 0 && sb.ino !== 0) return sa.ino === sb.ino && sa.dev === sb.dev;
    } catch {
        // 有一边不存在(或读不了)就换下一条判据
    }
    try {
        return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
        return false;
    }
}


/** 供 Uint8Array 之外的地方复用:相对路径校验。 */
export { relativeToVault };
