import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeCanvas, isCanvasRelativePath, CANVAS_MAX_BYTES } from '../../app/lib/note-canvas.js';
import { resolveInsideReal, listVaultTree } from '../../app/lib/vault-path.js';
import { noteKindOf } from '../../app/lib/note-kind.js';
import { readNote, writeNote } from './note-index.js';

const IMAGE_MAX = 20 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
function safeName(value) {
    if (typeof value !== 'string' || !value.trim() || [...value].length > 100 || value !== value.trim()
        || /[<>:"/\\|?*%\u0000-\u001f]/.test(value) || /[. ]$/.test(value)
        || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) fail('名称无效：请使用不超过 100 字的安全文件名');
    return value;
}
function imageType(name, bytes, mimeType) {
    const ext = path.extname(name).toLowerCase();
    const signature = bytes.subarray(0, 12);
    const formats = [
        { exts: ['.png'], mime: 'image/png', valid: signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
        { exts: ['.jpg', '.jpeg'], mime: 'image/jpeg', valid: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 },
        { exts: ['.webp'], mime: 'image/webp', valid: signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP' },
        { exts: ['.gif'], mime: 'image/gif', valid: ['GIF87a', 'GIF89a'].includes(signature.toString('ascii', 0, 6)) },
        { exts: ['.bmp'], mime: 'image/bmp', valid: signature.toString('ascii', 0, 2) === 'BM' },
    ];
    if (!bytes.length || bytes.length > IMAGE_MAX) fail('图片大小必须在 20 MiB 以内');
    const format = formats.find(f => f.exts.includes(ext) && f.valid && (mimeType === undefined || mimeType === f.mime));
    if (!format) fail('图片扩展名、类型和文件内容不一致；仅支持 PNG/JPEG/WEBP/GIF/BMP');
    return format.mime;
}

export function registerCanvasIpc({ ipcMain, vaultRoot }) {
    const queues = new Map();
    function context(token, required = false) {
        const root = vaultRoot();
        if (typeof root !== 'string' || !root) fail('尚未配置可用的笔记库');
        let real;
        try { real = fs.realpathSync(root); if (!fs.statSync(real).isDirectory()) fail('笔记库不是目录'); }
        catch { fail('笔记库目录不可用'); }
        const vault = digest(real);
        if ((required && !token) || (token !== undefined && token !== vault)) fail('笔记库已经切换，请重新打开画布');
        return { root: real, vault };
    }
    const ensure = ctx => context(ctx.vault, true);
    function safePath(ctx, relative, { board = false, existing = false } = {}) {
        if (!isCanvasRelativePath(relative)) fail('路径必须是安全的库内相对路径');
        if (board && !/^画布\/[^/]+\.canvas$/.test(relative)) fail('只允许访问画布目录内的 .canvas 文件');
        const abs = resolveInsideReal(ctx.root, relative);
        if (!abs) fail('路径越出笔记库');
        // 所有路径组件拒绝符号链接/目录联接，即使指向库内也不提供别名写入口。
        let probe = ctx.root;
        for (const part of relative.split('/')) {
            probe = path.join(probe, part);
            try { if (fs.lstatSync(probe).isSymbolicLink()) fail('路径不能使用符号链接或目录联接'); }
            catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
        if (existing) {
            try { if (!fs.statSync(abs).isFile()) fail('目标不是普通文件'); }
            catch (err) { if (err.code === 'ENOENT') fail('文件不存在'); throw err; }
        }
        return abs;
    }
    function serial(key, fn) {
        if (process.platform === 'win32') key = key.toLowerCase();
        const previous = queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(fn);
        queues.set(key, next);
        next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
        return next;
    }
    async function bytesAt(abs, max = CANVAS_MAX_BYTES) {
        if ((await fs.promises.stat(abs)).size > max) fail('文件大小超过允许上限');
        return fs.promises.readFile(abs);
    }
    async function compare(ctx, relative, revision, board = true) {
        ensure(ctx);
        const abs = safePath(ctx, relative, { board, existing: true });
        if (typeof revision !== 'string' || digest(await bytesAt(abs, board ? CANVAS_MAX_BYTES : IMAGE_MAX)) !== revision) fail('保存冲突：文件已被修改，请重新读取');
        return abs;
    }
    async function atomic(abs, bytes, guard) {
        const tmp = `${abs}.tmp-${randomUUID()}`;
        let handle;
        let created = false;
        try {
            await guard();
            handle = await fs.promises.open(tmp, 'wx'); created = true;
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close(); handle = undefined;
            await guard();
            // 守卫与替换保持在同一个主进程回合，避免版本校验后插入另一笔应用内写入。
            fs.renameSync(tmp, abs);
        } finally {
            if (handle) await handle.close();
            if (created) {
                try { await fs.promises.unlink(tmp); }
                catch (err) { if (err?.code !== 'ENOENT') throw err; }
            }
        }
    }
    const handlers = {
        library: async () => {
            let ctx;
            try { ctx = context(); } catch (err) { return { boards: [], notes: [], images: [], vault: null, reason: err.message }; }
            const tree = await listVaultTree(ctx.root);
            ensure(ctx);
            const boards = []; const notes = []; const images = [];
            for (const rel of [...tree.files, ...tree.texts.map(item => item.path), ...tree.others.map(item => item.path)]) {
                try { safePath(ctx, rel, { existing: true }); } catch { continue; }
                const name = path.posix.basename(rel);
                if (/^画布\/[^/]+\.canvas$/.test(rel)) boards.push({ path: rel, name: name.slice(0, -7) });
                else if (noteKindOf(rel)) notes.push({ path: rel, title: name.replace(/\.(md|txt)$/i, ''), kind: noteKindOf(rel) });
                else if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(rel)) images.push({ path: rel, name });
            }
            for (const items of [boards, notes, images]) items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
            return { boards, notes, images, vault: ctx.vault, reason: null };
        },
        create: async ({ name, vault } = {}) => {
            const ctx = context(vault); safeName(name);
            const rel = `画布/${name}.canvas`;
            return serial(`${ctx.root}/${rel}`, () => {
                ensure(ctx); const abs = safePath(ctx, rel, { board: true });
                if (fs.existsSync(abs)) fail('画布已存在，请使用其他名称');
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                safePath(ctx, rel, { board: true }); ensure(ctx);
                const graph = { nodes: [], edges: [] }; const bytes = Buffer.from(JSON.stringify(graph, null, 2));
                fs.writeFileSync(abs, bytes, { flag: 'wx' });
                return { path: rel, graph, revision: digest(bytes), vault: ctx.vault };
            });
        },
        read: async ({ path: rel, vault } = {}) => {
            const ctx = context(vault); const abs = safePath(ctx, rel, { board: true, existing: true });
            const bytes = await bytesAt(abs); let graph;
            try { graph = normalizeCanvas(JSON.parse(bytes.toString('utf8'))); }
            catch (err) { fail(`画布文件无效：${err.message}`); }
            ensure(ctx); return { path: rel, graph, revision: digest(bytes), vault: ctx.vault };
        },
        write: async ({ path: rel, graph, revision, vault } = {}) => {
            const ctx = context(vault, true); const normalized = normalizeCanvas(graph);
            return serial(`${ctx.root}/${rel}`, async () => {
                const abs = await compare(ctx, rel, revision); const bytes = Buffer.from(JSON.stringify(normalized, null, 2));
                if (bytes.length > CANVAS_MAX_BYTES) fail('画布大小不能超过 8 MiB');
                await atomic(abs, bytes, () => compare(ctx, rel, revision));
                return { path: rel, revision: digest(bytes), vault: ctx.vault };
            });
        },
        importImage: async ({ path: rel, name, bytes, mimeType, vault } = {}) => {
            const ctx = context(vault, true); safePath(ctx, rel, { board: true, existing: true }); safeName(name);
            if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) fail('图片必须提供二进制字节');
            if (typeof mimeType !== 'string') fail('图片必须声明合法的 MIME 类型');
            if (!bytes.byteLength || bytes.byteLength > IMAGE_MAX) fail('图片大小必须在 20 MiB 以内');
            const data = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
            imageType(name, data, mimeType);
            const ext = path.extname(name).toLowerCase();
            const stem = [...name.slice(0, -path.extname(name).length)].slice(0, 45).join('');
            const file = `${rel.slice(0, -7)}.assets/${stem}-${randomUUID()}${ext}`;
            return serial(`${ctx.root}/${file}`, () => {
                ensure(ctx); safePath(ctx, rel, { board: true, existing: true }); const abs = safePath(ctx, file);
                if (fs.existsSync(abs)) fail('图片已存在，请使用其他名称');
                fs.mkdirSync(path.dirname(abs), { recursive: true }); safePath(ctx, file); ensure(ctx);
                fs.writeFileSync(abs, data, { flag: 'wx' }); return { file, name, vault: ctx.vault };
            });
        },
        media: async ({ file, vault } = {}) => {
            const ctx = context(vault); const abs = safePath(ctx, file, { existing: true });
            const bytes = await bytesAt(abs, IMAGE_MAX); const mime = imageType(file, bytes);
            ensure(ctx); return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, vault: ctx.vault };
        },
        readNote: async ({ path: rel, vault } = {}) => {
            const ctx = context(vault, true); if (!noteKindOf(rel)) fail('只允许读取 .md / .txt 笔记');
            const abs = safePath(ctx, rel, { existing: true }); const revision = digest(await bytesAt(abs, IMAGE_MAX));
            const note = await readNote(ctx.root, rel);
            await compare(ctx, rel, revision, false);
            return { ...note, path: rel, revision, vault: ctx.vault };
        },
        writeNote: async ({ path: rel, text, revision, vault } = {}) => {
            const ctx = context(vault, true); if (!noteKindOf(rel)) fail('只允许写入 .md / .txt 笔记');
            if (typeof text !== 'string') fail('笔记正文必须是文本');
            return serial(`${ctx.root}/${rel}`, async () => {
                const abs = await compare(ctx, rel, revision, false);
                const guard = async () => { await compare(ctx, rel, revision, false); safePath(ctx, `${rel}.bak`); };
                const result = await writeNote(ctx.root, rel, text, { beforeWrite: guard, maxBytes: IMAGE_MAX });
                ensure(ctx); safePath(ctx, rel, { existing: true });
                return { ...result, revision: digest(await bytesAt(abs, IMAGE_MAX)), vault: ctx.vault };
            });
        },
    };
    for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`canvas:${name}`, async (_event, payload) => {
        try { return await handler(payload); }
        catch (err) {
            // 原生 fs 错误含绝对路径；返回面板时只保留可理解的相对路径语境。
            if (err?.code) fail(`文件操作失败（${err.code}），请检查笔记库和文件状态`);
            throw err;
        }
    });
    return { dispose() { for (const name of Object.keys(handlers)) ipcMain.removeHandler(`canvas:${name}`); } };
}
