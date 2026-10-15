// 笔记子系统的 IPC 注册。与 main.js 解耦,便于单测与阅读。
//
// 与内核一致的原则:**路径与鉴权都在主进程**。
// 渲染进程只能递**相对 Vault 的相对路径**,绝对路径一律由主进程解析 ——
// 这样"渲染进程递进一个绝对路径把笔记写到系统目录"这条路从结构上就不存在。

import fs from 'node:fs';
import path from 'node:path';
import {
    indexVault, readNote, writeNote, createNote, createFolder, replaceFrontmatter, setBodyTitle,
    moveNoteBackup, isSameFile, renameCaseOnly,
} from './note-index.js';
import { resolveInsideReal, isNotePath, isMarkdownPath, noteKindOf } from '../../app/lib/vault-path.js';
import { readFrontmatter } from '../../app/lib/frontmatter.js';

// 全局设置的命名空间(不属于任何插件)。与 main.js 的 GLOBAL_NS 保持一致。
const GLOBAL_NS = '__global';
const LAST_VAULT_KEY = 'lastVault';

/**
 * 标题的字符数上限。
 *
 * 按**字符**而不是字节算:中文标题一个字就是一个字符,按字节算会让中文用户
 * 在三分之一长度上就被拒。100 对"给一篇笔记起名字"这个用途绰绰有余,
 * 而它离 Windows 的路径上限(约 260 字符)还留着一大截余量 —— 上限的意义是
 * 在**动盘之前**给出人话,而不是等 fs 抛出那句不含标题的 ENOENT。
 */
const MAX_TITLE_LENGTH = 100;

/**
 * Windows 保留设备名。Win32 把它们当设备而不是文件,而且**忽略扩展名**
 * (`CON`、`CON.md`、`con.txt` 是同一个东西)。
 *
 * 为什么必须在这里挡:`writeNote` 的原子写会先开 `${路径}.tmp-<pid>-<ts>` ——
 * `CON.md.tmp-…` 忽略扩展名后仍然是设备,打开就炸。旧行为有两种表现,都不能接受:
 * `CON` 抛一句与标题毫无关系的 ENOENT(用户无从诊断),`PRN`/`AUX`/`NUL` 之类
 * 不抛错、却落成一个目录里看得见、读不回来的条目("日志说成功、其实没有")。
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 把用户输入的标题收拾成一个能当文件名用的名字。
 *
 * 与渲染进程 createNamed 的字符集保持一致(`\/:*?"<>|` 在 Windows 上是非法的)。
 * 放主进程是因为**这里是权威**:渲染进程递进来的永远是"用户想叫什么",
 * 能不能落地、落成什么名字由这里决定。空标题直接报错而不是兜底成「未命名」——
 * 用户清空输入框通常是想反悔,这时悄悄建/改一个「未命名」比报错更糟。
 *
 * 长度与设备名同样在这一层挡:让 fs 去炸只会把用户机器的绝对路径递回界面,
 * 而"看起来成功了"的那种失败更贵(A9 的亲戚)。
 */
function sanitizeTitle(raw) {
    const clean = String(raw ?? '').trim().replace(/[\\/:*?"<>|]/g, '').trim();
    assertTitleUsable(clean);
    return clean;
}

/**
 * 校验一个**已经是文件名形态**的名字(字符已经收拾干净)。
 *
 * 为什么把"收拾"与"校验"拆开:`notes:create` 收到的是**相对路径**(`子/名.md`),
 * 路径分隔符在那里是合法的、必须原样保住;但它的文件名部分要与标题走**同一套**
 * 规则 —— 上限、保留设备名、非法字符。上一轮只把 sanitizeTitle 接到了
 * `notes:setTitle`,于是"点笔记里没写过的 [[…]] 链接"这条用户可达的路
 * (`createNamed` → `notes:create`)能把 300 字的标题直接交给 fs,
 * 而 ENOENT 的原文里带着用户机器的绝对路径,原样递回界面。
 *
 * @param {string} clean 已去掉非法字符、trim 过的文件名(不含扩展名)
 */
function assertTitleUsable(clean) {
    if (clean === '') throw new Error('标题不能为空');

    // 按**字符**数而不是字节数:中文标题一个字就是一个字符,按字节算会让中文用户
    // 在三分之一长度上就被拒(UTF-8 下一个汉字 3 字节)。展开运算符按码点计数。
    if ([...clean].length > MAX_TITLE_LENGTH) {
        throw new Error(`标题太长(最多 ${MAX_TITLE_LENGTH} 个字)`);
    }

    // 只看第一个点之前的部分:`CON.md`、`con.txt` 都算 CON(扩展名会被 Win32 忽略)
    const stem = clean.split('.')[0];
    if (WINDOWS_RESERVED_NAMES.test(stem)) {
        throw new Error(`「${clean}」在 Windows 上是设备名,不能当文件名`);
    }
}

/**
 * 校验一条**相对路径**的文件名部分(basename 去掉 `.md`),子目录部分原样保留。
 *
 * 为什么只查 basename:规则本身是"这个**文件**能不能叫这个名字" —— 目录名是
 * 另一件产品语义上的事(而且用户已经能在库里建任意目录),这里不擅自扩大范围。
 * 扩展名由 isNotePath 单独把关。
 *
 * @param {string} relPath
 */
function assertNoteNameUsable(relPath) {
    const base = path.posix.basename(String(relPath ?? ''));
    assertTitleUsable(base.replace(/\.md$/i, ''));
}

/**
 * 文件夹名的校验。与笔记名同一套规则(长度 / 保留设备名),但**不**去掉扩展名
 * (`阅读.md` 当文件夹名是合法的,而 `CON` 依然不行),并且显式挡掉路径分隔符 ——
 * 文件夹这一层不靠"用户输入的字符已经被洗过"这个假设。
 *
 * @param {string} relPath
 */
function assertFolderNameUsable(relPath) {
    const raw = String(relPath ?? '');
    const base = path.posix.basename(raw);
    if (base === '' || base === '.' || base === '..') throw new Error('文件夹名不能为空');
    if (/[\\/:*?"<>|]/.test(raw)) throw new Error('文件夹名里不能有 \\ / : * ? " < > |');
    assertTitleUsable(base);
}

/**
 * 把会被递到界面上的错误消息里的**笔记库绝对路径**换成 `<笔记库>`。
 *
 * 为什么:fs 的错误原文里带着 `C:\Users\…\AppData\…\vault\…`,那既没用也是隐私 ——
 * 用户需要知道"哪个文件出了什么事",不需要知道自己的目录结构被递进了渲染进程。
 * `code` 原样保留:诊断靠它(ENOENT / EACCES / EPERM 是三种完全不同的处境)。
 *
 * @param {Error & {code?:string}} err
 * @param {string} vaultRoot
 * @returns {Error}
 */
function sanitizeFsError(err, vaultRoot) {
    const raw = String(err?.message ?? err);
    const message = vaultRoot === '' ? raw : raw.split(vaultRoot).join('<笔记库>');
    const wrapped = new Error(message);
    if (err?.code !== undefined) wrapped.code = err.code;
    return wrapped;
}

/**
 * 记住上次用的 Vault。默认不预置路径(设计文档 §4.6)——
 * 用户第一次启动要自己选。
 */
function readLastVault(settings) {
    const v = settings.get(GLOBAL_NS, LAST_VAULT_KEY);
    return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * 判断记着的 Vault 当前是否可用。
 *
 * **关键**:目录不存在时不能当成"空 Vault"直接新建 —— 那会让用户以为笔记丢了。
 * 必须回到向导并明确告知「上次的 Vault 找不到了:<路径>」。
 */
function vaultStatus(vaultPath) {
    if (vaultPath === null) {
        return { configured: false, ok: false, path: null, reason: '还没有选择笔记库' };
    }
    try {
        const stat = fs.statSync(vaultPath);
        if (!stat.isDirectory()) {
            return { configured: true, ok: false, path: vaultPath, reason: '那个位置现在不是一个文件夹' };
        }
        return { configured: true, ok: true, path: fs.realpathSync(vaultPath), reason: null };
    } catch {
        return { configured: true, ok: false, path: vaultPath, reason: '上次的笔记库找不到了' };
    }
}

/**
 * 数一个目录里有多少文件、其中多少篇是笔记。**删之前**数(删完就问不出来了)。
 *
 * 读不动的子目录**跳过而不是抛**:数数只是为了给界面一句话,不该因为一个权限怪目录
 * 把"删除"整件事挡下来 —— 真正删的时候 trashItem 自己会报错。
 */
function countTree(absDir) {
    let files = 0;
    let notes = 0;
    const walk = (dir) => {
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name));
                continue;
            }
            files += 1;
            if (entry.name.toLowerCase().endsWith('.md')) notes += 1;
        }
    };
    walk(absDir);
    return { files, notes };
}

/**
 * 库内回收站目录名。
 *
 * ⚠️ 为什么需要它(2026-09-29 实测踩到,用户报"点删除没反应"):**不是每个卷都有回收站**。
 *    用户的笔记库在 **E 盘,而 E 是 FAT32 可移动盘** —— 那个卷上 `shell.trashItem` 直接失败
 *    (`Failed to perform delete operation`),于是"删除笔记"和"删除文件夹"两条都**什么都不做**。
 *    我们**不**退化成永久删除:这条路的触发点太轻(右键一点就中),而删掉的是用户的真实资产。
 *    改成搬进库内的 `.trash/<时间戳>/<原相对路径>` —— 可恢复这条保证在任何文件系统上都成立。
 *
 * 为什么它不会污染笔记树:`listVaultTree` 跳过以 `.` 开头的目录(既有规则),
 * 所以 `.trash` 不出现在列表里,也不进索引。
 */
export const VAULT_TRASH_DIR = '.trash';

/**
 * 这个卷上有没有系统回收站。
 * 判据是卷根的 `$Recycle.Bin`(NTFS 上有;FAT32 可移动盘上没有 —— 实测 E 盘为 false,
 * 而同一个文件在 C 盘上 `shell.trashItem` 正常)。
 *
 * @param {string} absPath 卷内任意绝对路径
 * @param {(p:string)=>boolean} exists 注入的存在性判断(这个模块不直接摸 fs,便于单测)
 */
export function volumeHasRecycleBin(absPath, exists) {
    try {
        const parsed = path.parse(path.resolve(absPath));
        return exists(path.join(parsed.root, '$Recycle.Bin')) === true;
    } catch {
        return false;
    }
}

/** 时间戳(`2026-09-29-230512`):本地时间,可读可排序。 */
function stampNow(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
        + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * 把一条路径搬进**库内回收站**,返回它在库里的相对路径。
 *
 * 同一卷上优先 `rename`(原子的,不动字节);跨卷或被占用时退回"复制 + 删原件"。
 * 同一秒内删两样东西会撞同一个时间戳目录:撞了就 `-2`、`-3` 往后排,不覆盖。
 */
function moveIntoVaultTrash(root, abs, rel) {
    const base = path.join(root, VAULT_TRASH_DIR, stampNow());
    let dir = base;
    for (let i = 2; fs.existsSync(dir) && i < 100; i += 1) dir = `${base}-${i}`;
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
        fs.renameSync(abs, dest);
    } catch {
        fs.cpSync(abs, dest, { recursive: true });
        fs.rmSync(abs, { recursive: true, force: true });
    }
    return path.posix.join(path.relative(root, dir).split(path.sep).join('/'), rel);
}

/**
 * 删一条路径的**唯一出口**:优先系统回收站,这个卷没有回收站时回落进库内 `.trash/`。
 *
 * ⚠️ 两条路都"可恢复",这是有意的:右键一点就中的手势不该有不可逆的结果。
 *    回落**不区分失败原因**是安全的 —— 它要么真的把东西搬进 `.trash`(成功,仍可恢复),
 *    要么自己抛错(调用方照旧报失败),绝不会出现"假装删了其实没动"。
 *
 * @returns {Promise<{mode:'trash'|'vault', to:string|null}>} `to` 只在 mode='vault' 时有值
 */
export async function removePathWithFallback({ root, abs, rel, trashItem }) {
    if (trashItem !== null && volumeHasRecycleBin(abs, (p) => fs.existsSync(p))) {
        try {
            await trashItem(abs);
            return { mode: 'trash', to: null };
        } catch { /* 回收站这条走不通 —— 下面落库内 .trash(实测 E 盘就是这样) */ }
    }
    return { mode: 'vault', to: moveIntoVaultTrash(root, abs, rel) };
}

/**
 * 注册所有 notes:* 频道。
 *
 * @param {{ipcMain:object, dialog:object, settings:object, getWindow:()=>object|null,
 *          shell?:object|null, trash?:(abs:string)=>Promise<void>|null}} deps
 *        trash 可注入:生产默认取 shell.trashItem,纯 Node 的单测递假实现。
 * @returns {{currentVault:()=>string|null, setVault:(p:string|null)=>void, dispose:()=>void}}
 */
export function registerNotesIpc({ ipcMain, dialog, settings, getWindow, shell = null, trash = null }) {
    let vaultPath = readLastVault(settings);

    /**
     * "把这个绝对路径丢进系统回收站"这件事本身。
     *
     * 为什么做成**可注入的依赖**而不是直接写 `shell.trashItem`:
     * `npm test` 跑在纯 Node 里,那里根本没有 Electron 的 `shell` —— 直接调就等于
     * 这条通道只能靠真窗口验证。注入之后单测可以递一个记账用的假 trash,
     * 把"被调用的绝对路径是哪几条、.bak 有没有一起进去"钉在纯 Node 里。
     *
     * 默认仍然取 Electron 的 shell.trashItem(回收站,**不是** fs.unlink):
     * 删的是用户真实资产,一次误点不该不可逆。
     */
    const trashItem = typeof trash === 'function'
        ? trash
        : (typeof shell?.trashItem === 'function' ? shell.trashItem.bind(shell) : null);
    const requireVault = () => {
        const st = vaultStatus(vaultPath);
        if (!st.ok) throw new Error(st.reason ?? '笔记库不可用');
        return st.path;
    };

    const handlers = {
        // ---- Vault 选择 ----
        'notes:vault:status': () => vaultStatus(vaultPath),

        'notes:vault:choose': async () => {
            const win = getWindow();
            const result = await dialog.showOpenDialog(win, {
                title: '选择笔记库文件夹',
                properties: ['openDirectory', 'createDirectory'],
                buttonLabel: '用这个文件夹',
            });
            if (result.canceled || result.filePaths.length === 0) {
                return { ok: false, canceled: true, status: vaultStatus(vaultPath) };
            }

            const picked = result.filePaths[0];

            // 目录里已有笔记就告知"发现 N 篇笔记";空的就说"将新建"。
            // ⚠️ 数的是**整个家族**(.md + .txt):txt 现在也是"能打开、能编辑的笔记",
            //    只数 .md 会让一个装满 txt 剧本的目录报"这是空文件夹"。
            // ⚠️ 字段名从 mdCount 改成 noteCount 也是为这个 —— 名字与它数的东西必须一致。
            let noteCount = 0;
            try {
                noteCount = (fs.readdirSync(picked, { recursive: true }) ?? [])
                    .filter(f => isNotePath(String(f))).length;
            } catch {
                noteCount = 0;
            }

            vaultPath = picked;
            settings.set(GLOBAL_NS, LAST_VAULT_KEY, picked);

            return { ok: true, canceled: false, status: vaultStatus(vaultPath), noteCount };
        },

        'notes:vault:clear': () => {
            vaultPath = null;
            settings.set(GLOBAL_NS, LAST_VAULT_KEY, null);
            return vaultStatus(null);
        },

        // 直接指定 Vault(不经目录选择器)。
        // 用途:自检与验收需要非交互地指向一个临时笔记库 —— 走 dialog 就没法自动化。
        // 安全上不放松:这里只是一个绝对路径的赋值,写入仍然要过 Vault 内的
        // 路径守卫(见下面各频道),所以它不构成"渲染进程可任意写盘"的通道。
        'notes:vault:set': (_event, { path: p } = {}) => {
            if (typeof p !== 'string' || p === '') throw new Error('path 必填');
            const st = vaultStatus(p);
            if (!st.ok) throw new Error(st.reason ?? '笔记库不可用');
            vaultPath = st.path;
            settings.set(GLOBAL_NS, LAST_VAULT_KEY, st.path);
            return st;
        },

        // ---- 索引与列表 ----
        'notes:index': async () => {
            const root = requireVault();
            const { notes, folders, texts, others, graph, errors } = await indexVault(root);

            // 只把界面需要的字段送过去 —— 不要把整篇正文塞进列表里。
            // ⚠️ `readable` / `reason` 是给"这一篇打不开"用的**叶子字段**(没有正文):
            //    列表据此挂一枚「打不开」小标,点开时状态行说出原因。仍然只递叶子。
            const list = notes.map(n => ({
                id: n.id,
                path: n.path,
                title: n.title,
                tags: n.tags,
                mtimeMs: n.mtimeMs,
                linkCount: n.links.length,
                readable: n.readable !== false,
                reason: n.reason ?? '',
            }));

            return {
                root,
                notes: list,
                // 树状列表要连**空文件夹**一起显示,否则刚建的那个看不见
                folders,
                // 纯文本笔记(.txt):树里是**能点开编辑的**行,与笔记同一套位置,
                // 但**不进**上面的 notes —— 不参与链接、标签、Markdown 渲染。
                texts: texts.map(t => ({
                    path: t.path, name: t.name, size: t.size, mtimeMs: t.mtimeMs,
                })),
                // 非笔记文件(图片 / 文档 / json …)。
                // 侧栏把它们也列出来,"拖进文件夹"才有的可拖 —— 只列 .md 的话,
                // 短剧项目里那 25 张图在树里根本不存在。
                others: others.map(o => ({
                    path: o.path, name: o.name, size: o.size, mtimeMs: o.mtimeMs,
                })),
                tags: collectTags(notes),
                backlinks: mapToObject(graph.backlinks),
                unresolved: graph.unresolved,
                orphans: graph.orphans,
                errors,
            };
        },

        // ---- 单篇读写 ----
        'notes:read': async (_event, { path: relPath } = {}) => {
            const root = requireVault();
            return readNote(root, relPath);
        },

        'notes:write': async (_event, { path: relPath, text } = {}) => {
            const root = requireVault();
            if (typeof text !== 'string') throw new Error('text 必须是字符串');
            return writeNote(root, relPath, text);
        },

        'notes:create': async (_event, { path: relPath, text = '' } = {}) => {
            const root = requireVault();
            // 文件名部分与 setTitle 同一套规则(上限/保留设备名/非法字符)。
            // 这条通道**用户可达**:笔记里点没写过的 [[…]] 链接就会走到这里,
            // 不校验的话超长名字会以一句带绝对路径的 ENOENT 递回界面。
            assertNoteNameUsable(relPath);
            try {
                return await createNote(root, relPath, text);
            } catch (err) {
                // fs 错误一律遮蔽库根:渲染进程不需要知道用户机器的目录结构,
                // 而 code 保留 —— ENOENT / EEXIST / EACCES 是三种完全不同的处境。
                throw sanitizeFsError(err, root);
            }
        },

        // ---- 新建文件夹(树状列表用) ----
        'notes:mkdir': async (_event, { path: relPath } = {}) => {
            const root = requireVault();
            assertFolderNameUsable(relPath);
            try {
                return await createFolder(root, relPath);
            } catch (err) {
                // 与 notes:create 同一条规矩:fs 错误遮蔽库根,code 保留
                throw sanitizeFsError(err, root);
            }
        },

        // ---- 单篇的反链 / 出链(点开某篇时才要) ----
        'notes:links': async (_event, { path: relPath } = {}) => {
            const root = requireVault();

            // ⚠️ 纯文本文件**明确不参与链接**:它不在索引里(见 indexVault),所以这里
            //    不能像以前那样"找不到就抛错"——那会让界面在链接面板上看到一句报错。
            //    回一个带 kind 的空结果,由界面写清楚"纯文本不参与链接与标签"。
            const kind = noteKindOf(relPath);
            if (kind === 'text') {
                return { kind, outgoing: [], backlinks: [], unresolved: [] };
            }

            const { notes, graph } = await indexVault(root);
            const me = notes.find(n => n.path === relPath);
            if (!me) throw new Error(`找不到笔记:${relPath}`);

            const toList = (idOrPath) => {
                const n = notes.find(x => x.id === idOrPath);
                return n ? { id: n.id, path: n.path, title: n.title } : null;
            };

            return {
                kind: 'markdown',
                outgoing: (graph.outgoing.get(me.id) ?? []).map(toList).filter(Boolean),
                backlinks: (graph.backlinks.get(me.id) ?? []).map(b => ({
                    path: b.fromId, title: b.fromTitle, line: b.line, alias: b.alias,
                })),
                unresolved: graph.unresolved.filter(u => u.fromId === me.id),
            };
        },

        // ---- frontmatter 单独替换(AI 改元数据时用,正文一字不动) ----
        'notes:replaceFrontmatter': async (_event, { path: relPath, data } = {}) => {
            const root = requireVault();
            // ⚠️ 原文必须走 readNote 那套**判据**,不能自己 readFile(abs,'utf8'):
            //    这里读到的每个字后面都会被写回磁盘,有损解码一步就等于替用户改坏笔记。
            //    (writeNote 那道闸也在,但错误信息只有在这里才说得清"是哪一篇、为什么"。)
            const text = (await readNote(root, relPath)).text;
            const next = replaceFrontmatter(text, data ?? {});
            return writeNote(root, relPath, next);
        },

        // ---- 重命名 / 移动(供后续里程碑用) ----
        'notes:rename': async (_event, { from, to } = {}) => {
            const root = requireVault();
            if (!isNotePath(from) || !isNotePath(to)) throw new Error('只允许重命名 .md / .txt 笔记');
            const absFrom = resolveInsideReal(root, from);
            const absTo = resolveInsideReal(root, to);
            if (absFrom === null || absTo === null) throw new Error('路径越出笔记库');

            try {
                // 同一个文件(纯大小写改名)不算冲突 —— 那个"目标"就是它自己
                if (from !== to && fs.existsSync(absTo) && !isSameFile(absFrom, absTo)) {
                    throw new Error(`目标已存在:${to}`);
                }

                await fs.promises.mkdir(path.dirname(absTo), { recursive: true });
                // 同一个文件(大小写不敏感卷上的纯大小写改名)要走两步,否则目录项里
                // 存下来的常常还是旧拼写 —— 用户"改了大小写"而列表纹丝不动。
                if (from !== to && isSameFile(absFrom, absTo)) {
                    await renameCaseOnly(absFrom, absTo);
                } else if (from !== to) {
                    await fs.promises.rename(absFrom, absTo);
                }
                // 备份跟着走,否则旧名字下会留下完整的一代内容(列表上看不见)
                await moveNoteBackup(root, to, from);
            } catch (err) {
                throw sanitizeFsError(err, root);
            }
            return { from, to };
        },

        // ---- 用系统程序打开一个**非笔记文件** ----
        //
        // 树里现在也列图片 / docx / json / txt(不列的话它们根本无从"拖进文件夹"),
        // 而它们没有正文可编辑 —— 点一下的自然语义就是"用系统程序打开"。
        //
        // 边界与其它 notes:* 通道一致:渲染进程只递**相对路径**,由主进程过
        // resolveInsideReal 的真实路径层(挡 ../ 与符号链接逃逸)再交给 shell。
        // 不这样做就等于开了一条"让渲染进程打开任意本地文件"的通道。
        'notes:openPath': async (_event, { path: relPath } = {}) => {
            const root = requireVault();
            if (typeof relPath !== 'string' || relPath === '') throw new Error('path 必填');
            const abs = resolveInsideReal(root, relPath);
            if (abs === null) throw new Error('路径越出笔记库');
            if (!fs.existsSync(abs)) throw new Error(`找不到:${relPath}`);
            if (typeof shell?.openPath !== 'function') throw new Error('这个环境不支持打开外部程序');
            // openPath 返回**错误字符串**(空串表示成功),不抛 —— 这里转成异常,
            // 让渲染进程那条统一的 catch 拿到可读原因。
            const message = await shell.openPath(abs);
            if (typeof message === 'string' && message !== '') throw new Error(message);
            return { ok: true };
        },

        // ---- 移动:任意文件或目录在笔记库内挪位置(拖放的落点) ----
        //
        // 与 notes:rename 的分工:`rename` 是"给一篇**笔记**改名字"(空制 .md、
        // 只换路径不动类型);这里是"把**任意东西**挪到另一个目录下"——
        // 图片、docx、json、以及**整个文件夹**都要能挪,否则"拖文件进文件夹"
        // 在树里根本没有对应的能力(shots/ 那 25 张图就是这么被挡在外面的)。
        //
        // ⚠️ 两道防线(渲染层拦一次、这里再拦一次,与路径守卫同一口径):
        //   ① 路径越界 —— resolveInsideReal 的**真实路径层**挡符号链接/目录联接逃逸;
        //   ② 移进自己的子孙 —— 那会把目录变成自己的儿子,是个环,文件系统上
        //      表现为 "EPERM/ENOTEMPTY" 之类的怪错,或者更糟:静默移进自己内部。
        'notes:move': async (_event, { from, to } = {}) => {
            const root = requireVault();
            if (typeof from !== 'string' || from === '') throw new Error('from 必填');
            if (typeof to !== 'string' || to === '') throw new Error('to 必填');
            if (from === to) return { from, to, moved: false };

            const absFrom = resolveInsideReal(root, from);
            const absTo = resolveInsideReal(root, to);
            if (absFrom === null || absTo === null) throw new Error('路径越出笔记库');

            try {
                if (!fs.existsSync(absFrom)) throw new Error(`找不到:${from}`);
                const srcIsDir = fs.statSync(absFrom).isDirectory();

                // ② 防环:目标落在源**自己**里面(含"就是它自己"那一层)
                const realFrom = fs.realpathSync(absFrom);
                const parentOfTo = path.dirname(absTo);
                if (absTo === realFrom) throw new Error('不能移动到它自己身上');
                if (srcIsDir) {
                    const parentReal = fs.existsSync(parentOfTo) ? fs.realpathSync(parentOfTo) : parentOfTo;
                    if (parentReal === realFrom || parentReal.startsWith(realFrom + path.sep)) {
                        throw new Error('不能把文件夹移动到它自己的子文件夹里');
                    }
                }

                // 撞名:拒绝,绝不覆盖、也不静默改名(与 notes:rename 同一口径)。
                // 纯大小写改名(同一个文件)不算冲突。
                if (fs.existsSync(absTo) && !isSameFile(absFrom, absTo)) {
                    throw new Error(`目标已存在:${to}`);
                }

                await fs.promises.mkdir(path.dirname(absTo), { recursive: true });
                if (isSameFile(absFrom, absTo)) await renameCaseOnly(absFrom, absTo);
                else await fs.promises.rename(absFrom, absTo);

                // 笔记的 .bak 跟着走;非笔记(没有 .bak)时这个调用是无害的空操作
                if (!srcIsDir && isNotePath(to)) await moveNoteBackup(root, to, from);

                return { from, to, moved: true, isDir: srcIsDir };
            } catch (err) {
                throw sanitizeFsError(err, root);
            }
        },

        // ---- 改标题:文件名、正文 H1、已有 frontmatter.title **一起**改 ----
        // 顶栏那个「笔记标题」输入框提交时调它。三处都改的原因见 setBodyTitle:
        // 标题解析顺序是 frontmatter.title → 第一个 H1 → 文件名,
        // 只改一处会被另一处盖回去(表现就是"命名好了、列表里还是旧名字")。
        //
        // ⚠️ 这里有两处**有意保留的代价**,别当 bug 改掉:
        //   1. frontmatter.title 只在**已经有这个键**时更新。用户没写过元数据,
        //      就不该替他写一份进去(那会改变他自己的文件格式)。
        //   2. rename 与 writeNote 是**两次独立操作**。第二步失败时,文件停在新名字上
        //      而正文 H1 还是旧的 —— 语义上确实是半截。但不会出现半篇正文:
        //      writeNote 是"临时文件 → rename"的原子写,要么整篇旧、要么整篇新。
        //      这一点用"先写完再改名"也换不掉(改名本身就没有和写文件合成一个原子操作
        //      的办法),而顺序反过来会让失败停下来的是"旧名字 + 新内容",更难解释。
        'notes:setTitle': async (_event, { path: relPath, title } = {}) => {
            const root = requireVault();
            // ⚠️ 改标题**只给 Markdown**:这条路的实现是"改文件名 + 把正文里那个 H1 换掉"
            //    (下面 setBodyTitle 就是干这个的),纯文本没有 H1 这个语义,
            //    硬跑一遍等于往用户的 txt 里塞一行 `# 标题`。界面上那个标题框对纯文本是只读的。
            if (!isMarkdownPath(relPath)) throw new Error('只允许给 .md 笔记改标题');

            const clean = sanitizeTitle(title);
            // 相对路径统一用 / 分隔(vault-path 的约定),保住原来的子目录
            const dir = path.posix.dirname(relPath);
            const to = dir === '.' ? `${clean}.md` : `${dir}/${clean}.md`;

            const absFrom = resolveInsideReal(root, relPath);
            const absTo = resolveInsideReal(root, to);
            if (absFrom === null || absTo === null) throw new Error('路径越出笔记库');

            try {
                // 先挡冲突再动任何文件:否则会出现"改了一半"的状态。
                // 同一个文件(Windows/macOS 上的纯大小写改名)不算冲突。
                const caseOnly = to !== relPath && isSameFile(absFrom, absTo);
                if (to !== relPath && !caseOnly && fs.existsSync(absTo)) {
                    throw new Error(`目标已存在:${to}`);
                }

                // ⚠️ 读原文这一步必须走 readNote(同一套编解码判据),**不许**自己
                //    readFile(absFrom,'utf8'):那一下会把非法字节有损替换成 U+FFFD,
                //    而紧接着的 writeNote 就把替换过的文本写回去了 ——
                //    "改一次标题"于是变成"毁一篇笔记"。这里先拿不到明文就先抛出人话原因。
                const cur = await readNote(root, relPath);
                if (cur.editable !== true) {
                    throw new Error(`这份文件是 ${cur.encoding},开物不能安全写回(只支持 UTF-8);请用系统程序编辑`);
                }
                const text = cur.text;
                let nextText = setBodyTitle(text, clean);

                // frontmatter **已有** title 键时同步它:否则列表按 frontmatter 显示,
                // 用户会觉得"改了但没改",而界面的"没改就不做"判断也随之失效
                // (每次回车都真的再改一次文件名)。没有这个键就一个字都不加。
                //
                // ⚠️ 用 readFrontmatter 而不是 splitFrontmatter:后者只切出 raw 文本,
                // **不给解析好的对象**(这是它的契约,别在这里另解析一遍)。
                const { data, hasFrontmatter } = readFrontmatter(nextText);
                if (hasFrontmatter && Object.prototype.hasOwnProperty.call(data, 'title')) {
                    nextText = replaceFrontmatter(nextText, { ...data, title: clean });
                }

                if (to !== relPath) {
                    await fs.promises.mkdir(path.dirname(absTo), { recursive: true });
                    // 覆盖前留一代备份的既有行为不变(见 writeNote 的注释),但这一步要
                    // 在**改名之前**按旧名字做:改完名再让 writeNote 去打备份,旧名字下
                    // 那份就会停在原地 —— 一份换了名字继续住在库里的旧内容,列表上看不见。
                    if (nextText !== text) {
                        await writeNote(root, relPath, nextText, { backup: true });
                    }
                    if (caseOnly) {
                        await renameCaseOnly(absFrom, absTo);
                    } else {
                        await fs.promises.rename(absFrom, absTo);
                    }
                    // 备份跟着走:上面刚按**旧名字**留过一份,这里把它搬到新名字下
                    // (没留过就什么都不做)——
                    await moveNoteBackup(root, to, relPath);
                } else if (nextText !== text) {
                    // 没改名:照旧走原子写,和 notes:write 同一条路径
                    await writeNote(root, to, nextText);
                }
            } catch (err) {
                throw sanitizeFsError(err, root);
            }

            return { from: relPath, to, title: clean, renamed: to !== relPath };
        },

        // ---- 删除一篇笔记(产品原话:「右击添加删除笔记选项」) ----
        //
        // 三个决定写在这里,免得后来的人改掉:
        //
        // ① **进系统回收站,不是永久删**。用的不是 fs.unlink/rm 而是 shell.trashItem
        //    (Windows 上是回收站,可还原)。理由是这条路的触发点太轻:右键菜单一点
        //    就中,而删掉的是用户真实的笔记资产 —— 一次误点不该不可逆。有了回收站,
        //    即使渲染层的"再点一次确认"被绕过,代价也只是去回收站里捡回来。
        //
        // ② **`.md.bak` 一起进回收站**。备份是 writeNote 有意留下的一代兜底内容
        //    (见 HANDOFF「.md.bak 是有意的、只留一代、随改名一起搬」)。只把笔记本身
        //    丢了的话,库里会剩下"这篇的完整内容还住在磁盘上、列表里却看不见"的孤儿 ——
        //    用户以为删掉了,内容其实还在。两条都进回收站,用户仍然能整体恢复。
        //    备份不存在就跳过(绝大多数笔记没有改过,本来就没有 .bak)。
        //
        // ③ **只接受库内相对路径这一个叶子字段**。绝对路径由这里解析,与其它
        //    notes:* 通道同一口径:过了 resolveInsideReal 的**真实路径层**才算数
        //    (`../` 与符号链接逃逸都在那里被挡)。而且只收 `.md` —— 纯文本与非笔记
        //    文件不在这个菜单里,通道也不给它开口子。
        'notes:remove': async (_event, { path: relPath } = {}) => {
            const root = requireVault();
            if (!isMarkdownPath(relPath)) throw new Error('只允许删除 .md 笔记');

            const abs = resolveInsideReal(root, relPath);
            if (abs === null) throw new Error('路径越出笔记库');

            // "不存在"要给一句人话,而不是把 fs 的 ENOENT 原文(带用户机器的绝对路径)
            // 递回界面 —— 与 notes:openPath 同一条规矩。
            let stat = null;
            try {
                stat = fs.statSync(abs);
            } catch {
                throw new Error(`找不到这篇笔记:${relPath}`);
            }
            if (!stat.isFile()) throw new Error(`「${relPath}」不是一个文件`);

            // ⚠️ 不再要求"必须有系统回收站":这个卷没有回收站时(实测 E 盘 FAT32 可移动)
            //    回落到**库内** `.trash/` —— 见 removePathWithFallback。删除在任何卷上都该能用。
            //
            // 先笔记、后备份。主件失败 = 什么都没发生,原样抛出;
            // 备份失败**不回滚**(它已经挪走了,回不去),但也不吞掉 ——
            // 返回一句 warning,由界面把它并进状态行说出来(见下面的返回值)。
            let result = null;
            try {
                result = await removePathWithFallback({ root, abs, rel: relPath, trashItem });
            } catch (err) {
                throw sanitizeFsError(new Error(`删除失败:${err?.message ?? err}`), root);
            }

            const trashed = [relPath];
            let warning = null;
            const backupAbs = `${abs}.bak`;
            if (fs.existsSync(backupAbs)) {
                try {
                    await removePathWithFallback({
                        root, abs: backupAbs, rel: `${relPath}.bak`, trashItem,
                    });
                    trashed.push(`${relPath}.bak`);
                } catch (err) {
                    // 不静默:界面上会带出来,否则库里留下的是一份谁也看不见的全文。
                    warning = `${relPath}.bak 没能挪走:${err?.message ?? err}`;
                }
            }

            return { path: relPath, trashed, warning, mode: result.mode, to: result.to };
        },

        // 删一个**文件夹**(连同里面的全部内容),走系统回收站。
        //
        // 为什么单开一条通道、不让 notes:remove 收目录:两条路的闸门**不一样** ——
        // `remove` 只收 `.md`(那个菜单只长在笔记行上,旁边还有 `.md.bak` 的连带规则);
        // 目录要守的是另一套,其中最要紧的一条是**绝不能是库根本身**:一次误点该只丢一个
        // 文件夹,而不是整个笔记库。守卫不同却混进同一条通道,迟早有一类输入从另一条路溜过去。
        'notes:removeDir': async (_event, { path: relPath } = {}) => {
            const root = requireVault();
            const rel = typeof relPath === 'string' ? relPath.trim() : '';
            if (rel === '' || rel === '.' || rel === './') throw new Error('要删的是哪一个文件夹?');

            const abs = resolveInsideReal(root, rel);
            if (abs === null) throw new Error('路径越出笔记库');
            // 库根再用**解析后的真实路径**挡一次:`.`、`./`、尾斜杠、大小写这些写法
            // 在字符串上看各不相同,落到盘上是同一个目录 —— 只在字符串上判会漏。
            if (path.resolve(abs) === path.resolve(root)) throw new Error('不能删笔记库根本身');

            let stat = null;
            try {
                stat = fs.statSync(abs);
            } catch {
                throw new Error(`找不到这个文件夹:${rel}`);
            }
            if (!stat.isDirectory()) throw new Error(`「${rel}」不是一个文件夹`);

            // ⚠️ **先数再扔**:扔完就问不出来了,而"这一下带走了多少"正是用户要看的读数
            // (界面上那句"已把文件夹《X》移入回收站(含 12 个文件,其中 3 篇笔记)")。
            const counts = countTree(abs);
            // 与 notes:remove 同一条出口:能进系统回收站就进,不能就落库内 `.trash/`
            let result = null;
            try {
                result = await removePathWithFallback({ root, abs, rel, trashItem });
            } catch (err) {
                throw sanitizeFsError(new Error(`删除失败:${err?.message ?? err}`), root);
            }
            return { path: rel, ...counts, mode: result.mode, to: result.to };
        },
    };

    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, payload) => {
            try {
                return await handler(event, payload);
            } catch (err) {
                // 统一把错误变成可读消息:渲染进程拿到的是 message,
                // 而不是一个被 Electron 包装过的难懂对象。
                // code 一并带上 —— sanitizeFsError 有意保留它(ENOENT / EEXIST /
                // EACCES 是三种完全不同的处境),在这里丢掉就等于白保留。
                const wrapped = new Error(String(err?.message ?? err));
                if (err?.code !== undefined) wrapped.code = err.code;
                throw wrapped;
            }
        });
    }

    return {
        currentVault: () => vaultStatus(vaultPath).path,
        setVault: (p) => {
            vaultPath = p;
            settings.set(GLOBAL_NS, LAST_VAULT_KEY, p);
        },
        dispose: () => {
            for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
        },
    };
}

/** 标签 → 计数,按出现次数降序(界面上的标签面板)。 */
function collectTags(notes) {
    const counts = new Map();
    for (const n of notes) {
        for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
}

/** Map 不能过 IPC,转成普通对象。 */
function mapToObject(map) {
    const out = {};
    for (const [k, v] of map) out[k] = v;
    return out;
}
