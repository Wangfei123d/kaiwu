// 「AI 会话」台账的**落盘**。住在主进程(渲染进程是沙箱,拿不到 fs)。
//
// 一条会话 = 一个文件:<笔记库>/AI会话/2026-09-26-1302-870dbbb2.md
// 格式与编解码在 app/lib/session-record.js(纯函数,单测钉着),这里只管三件事:
//   ① 把运行中这一轮的增量**攒**在内存里,按节奏落盘;
//   ② 列清单 / 读一份 / 删一份;
//   ③ 同一条会话**接着写**(「接着聊」恢复出来的会话要接在原来那份记录后面,不是另起一份)。
//
// 三条实测得来的纪律:
//   · **不许只在退出时写**:dsh 子进程被杀掉时,它自己那份会话文件里只剩一行头
//     (实测 12 个会话全是空壳)。所以这里一轮一落盘 + 防抖,不赌"退出的那一刻"。
//   · **整份覆盖**(写临时文件再 rename),不追加:文件就是"当前完整记录"的投影,
//     追加会让"改了又改"的工具调用在文件里堆成好几条,读回来还得去重。
//   · **列表只读文件头**:meta 那一行在文件最前面,清单不必把几十万字全读进内存。
import fsDefault from 'node:fs';
import path from 'node:path';
import {
    SESSION_DIR, addEnd, addText, addTool, addUser, entryFromUpdate, fileNameOf, newRecord,
    parseRecord, renderRecord, rowOf, withModel,
} from '../../app/lib/session-record.js';

/** meta 行读多少字节就够:标题(24 字)+ 路径 + 模型值,远小于这个数。 */
const HEAD_BYTES = 4096;
/** 落盘防抖:一轮里增量几百条,不防抖就是几百次写盘。 */
export const DEFAULT_FLUSH_DEBOUNCE_MS = 1500;

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

/**
 * 空台账:什么都不记,但也**什么都不炸**。
 *
 * 为什么要有它:运行时不负责决定"要不要记账"(那是应用装配的事),所以它的默认值必须是
 * 一个安全的空实现 —— 否则单测里那个 `vaultRoot: () => 'E:\\vault-a'` 会让运行时
 * **真的往 E: 盘写文件**(实测:测试挂住 120s,而且凭空造出目录)。
 * 生产那边由 electron/main.js 显式注入真的台账;忘了注入的后果是"没记录",不是"崩"。
 */
export const nullLedger = Object.freeze({
    begin: async () => null,
    user: () => null,
    text: () => null,
    update: () => null,
    end: () => null,
    model: () => null,
    peek: () => null,
    flush: async () => [],
    close: async () => {},
    list: async () => ({ ok: false, reason: '没有开启会话台账', rows: [], dir: null }),
    read: async () => ({ ok: false, reason: '没有开启会话台账', record: null }),
    remove: async () => ({ ok: false, reason: '没有开启会话台账', removed: false }),
});

/**
 * @param {object} deps
 * @param {() => (string|null)} deps.vaultRoot 当前笔记库(换库会变,所以是函数)
 * @param {object} [deps.fs] node:fs 替身(测试用真 fs + 临时目录,这里只为可注入)
 * @param {() => number} [deps.now]
 * @param {number} [deps.flushDebounceMs]
 * @param {{info?:Function,warn?:Function,error?:Function}} [deps.log]
 * @param {(info:{id:string,file:string}) => void} [deps.onWrite] 落盘后的通知(界面刷新清单)
 */
export function createSessionLedger({
    vaultRoot,
    fs = fsDefault,
    now = () => Date.now(),
    flushDebounceMs = DEFAULT_FLUSH_DEBOUNCE_MS,
    log = console,
    onWrite = null,
} = {}) {
    /** id → 运行中的记录(只有**正在录**的会话在这里)。 */
    const live = new Map();
    /** id → 已经排队的写盘 promise(同一条会话的写要串行,免得两次 rename 打架)。 */
    const writing = new Map();
    const timers = new Map();
    let closed = false;

    const root = () => {
        const raw = typeof vaultRoot === 'function' ? vaultRoot() : vaultRoot;
        const s = typeof raw === 'string' ? raw.trim() : '';
        return s === '' ? null : s;
    };

    /** 记录目录(没有笔记库时返回 null —— 那时**什么都不写**,而不是往某个默认目录里倒)。 */
    function dir() {
        const r = root();
        return r === null ? null : path.join(r, SESSION_DIR);
    }

    async function ensureDir() {
        const d = dir();
        if (d === null) return null;
        await fs.promises.mkdir(d, { recursive: true });
        return d;
    }

    async function readHead(file) {
        const handle = await fs.promises.open(file, 'r');
        try {
            const buf = Buffer.alloc(HEAD_BYTES);
            const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
            return buf.subarray(0, bytesRead).toString('utf8');
        } finally {
            await handle.close();
        }
    }

    /** meta 那一行 → 资料行;不是台账文件(或坏文件)返回 null。 */
    async function headRowOf(file, name) {
        try {
            const head = await readHead(file);
            const firstLine = head.split('\n', 1)[0] ?? '';
            const parsed = parseRecord(`${firstLine}\n`);
            if (parsed === null) return null;
            return rowOf(parsed, { fileName: name, now: now() });
        } catch (err) {
            log.warn?.(`[sessions] 读不了 ${name}:${err?.message ?? err}`);
            return null;
        }
    }

    /**
     * 列清单:新的在前。
     *
     * ⚠️ 只认**我们写的**文件(meta 标记对得上),别的 .md 一律跳过 ——
     * 这个目录是笔记库的一部分,用户往里放任何东西都不该让清单崩掉或者多出一行。
     */
    async function list() {
        const d = dir();
        if (d === null) return { ok: false, reason: '还没有打开笔记库', rows: [], dir: null };
        let names = [];
        try {
            names = await fs.promises.readdir(d);
        } catch (err) {
            if (err?.code === 'ENOENT') return { ok: true, rows: [], dir: d };
            return { ok: false, reason: `读不了会话目录:${err?.message ?? err}`, rows: [], dir: d };
        }
        const rows = [];
        for (const name of names) {
            if (!name.toLowerCase().endsWith('.md')) continue;
            const row = await headRowOf(path.join(d, name), name);
            if (row !== null && row.id !== '') rows.push(row);
        }
        rows.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? 1 : -1));
        return { ok: true, rows, dir: d };
    }

    /** 按 id 找到它在磁盘上的文件名(可能还没有)。 */
    async function locate(id) {
        const d = dir();
        if (d === null) return null;
        let names = [];
        try {
            names = await fs.promises.readdir(d);
        } catch {
            return null;
        }
        for (const name of names) {
            if (!name.toLowerCase().endsWith('.md')) continue;
            const row = await headRowOf(path.join(d, name), name);
            if (row !== null && row.id === id) return { file: path.join(d, name), name };
        }
        return null;
    }

    async function writeFileAtomic(file, text) {
        const tmp = `${file}.tmp-${process.pid}-${now()}`;
        const handle = await fs.promises.open(tmp, 'w');
        try {
            await handle.writeFile(text, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.promises.rename(tmp, file);
    }

    /** 真正落盘一份(串行;失败只记日志 —— 记不下来不该把一轮对话弄失败)。 */
    function flushOne(id) {
        const record = live.get(id);
        if (record === undefined) return Promise.resolve(null);
        const prev = writing.get(id) ?? Promise.resolve();
        const next = prev.then(async () => {
            const d = await ensureDir();
            if (d === null) return null;
            // ⚠️ 文件名按**创建时间**定,而且要沿用已有的那一个:
            //    换模型/改标题都不该让同一会话换一个文件(那会变成两份记录)。
            const found = await locate(id);
            const file = found === null ? path.join(d, fileNameOf(record)) : found.file;
            await writeFileAtomic(file, renderRecord(record));
            onWrite?.({ id, file });
            return file;
        }).catch((err) => {
            log.warn?.(`[sessions] 写不动会话记录 ${id}:${err?.message ?? err}`);
            return null;
        });
        writing.set(id, next);
        return next;
    }

    /** 该落盘了(防抖):一轮里被调很多次,只在安静下来之后写一次。 */
    function schedule(id) {
        if (closed || flushDebounceMs <= 0) return;
        const old = timers.get(id);
        if (old !== undefined) clearTimeout(old);
        timers.set(id, setTimeout(() => {
            timers.delete(id);
            void flushOne(id);
        }, flushDebounceMs));
        // ⚠️ 定时器不该把进程吊住(Electron 退出时要能干净地走)。
        timers.get(id)?.unref?.();
    }

    /** 立刻把某一条(或全部)写下去。 */
    async function flush(id) {
        const ids = typeof id === 'string' && id !== '' ? [id] : [...live.keys()];
        const out = [];
        for (const one of ids) {
            const t = timers.get(one);
            if (t !== undefined) { clearTimeout(t); timers.delete(one); }
            out.push(await flushOne(one));
        }
        return out;
    }

    /**
     * 开始录一条会话。
     *
     * ⚠️ **同 id 接着写**:「接着聊」把一条旧会话恢复回来时,它在磁盘上已经有记录了,
     *    这时要把旧记录读回来继续追加,而不是从零另起一份(否则同一个会话会变成两份,
     *    清单里还会出现一条只有一句"刚接回来"的空壳)。
     */
    async function begin({ id, cwd = '', model = '', modelValue = '', effort = '', effortValue = '', createdAt } = {}) {
        const sid = String(id ?? '');
        if (sid === '') return null;
        // ⚠️ 没有笔记库就**不录**:会话记录是写进库里的,没有库时"录着"只会在内存里
        //    攒一份永远落不了盘的东西,调用方还会以为记下来了(单测抓到过这条)。
        if (dir() === null) return null;
        if (live.has(sid)) {
            const again = live.get(sid);
            return withModel(again, { model, modelValue, effort, effortValue });
        }
        const found = await locate(sid);
        if (found !== null) {
            try {
                const text = await fs.promises.readFile(found.file, 'utf8');
                const parsed = parseRecord(text);
                if (parsed !== null) {
                    const revived = withModel({
                        ...newRecord({ id: sid, cwd: parsed.cwd || cwd, createdAt: parsed.createdAt || createdAt }),
                        title: parsed.title,
                        createdAt: parsed.createdAt || (Number.isFinite(createdAt) ? createdAt : now()),
                        updatedAt: parsed.updatedAt || parsed.createdAt || now(),
                        turns: parsed.turns,
                        entries: parsed.entries,
                    }, { model: parsed.model || model, modelValue, effort: parsed.effort || effort, effortValue });
                    live.set(sid, revived);
                    // 「接着聊」把旧会话接回来:立刻把已存在的记录落一次(内容通常没变,
                    // 但"这条正在被用"这件事值得落一次时间戳)。
                    void flushOne(sid);
                    return revived;
                }
            } catch (err) {
                log.warn?.(`[sessions] 读不回旧记录,按新会话记:${err?.message ?? err}`);
            }
        }
        const created = Number.isFinite(createdAt) ? createdAt : now();
        const record = withModel(newRecord({ id: sid, cwd, createdAt: created, model, modelValue, effort, effortValue }), {});
        record.updatedAt = created;
        live.set(sid, record);
        // ⚠️ **立刻**落盘,不等防抖:会话是"一点就建"的(用户拍板的那条),
        //    台账要当场看得见那一条 —— 否则界面上写着"已建好",磁盘上却什么都没有,
        //    而"这条会话到底建了没有"正是用户唯一能核对的东西(实测:等防抖就晚 1.5 秒)。
        void flushOne(sid);
        return record;
    }

    return {
        begin,
        list,
        flush,
        /** 运行中的记录(测试与"当前这条会话"读数用)。 */
        peek: (id) => live.get(String(id ?? '')) ?? null,
        /** 全部丢掉定时器并落盘:Electron 退出时调。 */
        async close() {
            closed = true;
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
            await flush();
        },
        /** 用户说了话(一轮的开始)。 */
        user({ id, text = '', images = 0, at } = {}) {
            const sid = String(id ?? '');
            const record = live.get(sid);
            if (record === undefined) return null;
            const next = addUser(record, { text, images, at });
            live.set(sid, next);
            schedule(sid);
            return next;
        },
        /** 助手的一条文字(回复 / 思考)。 */
        text({ id, kind, text = '', at } = {}) {
            const sid = String(id ?? '');
            const record = live.get(sid);
            if (record === undefined) return null;
            const next = addText(record, kind, text, at);
            if (next === record) return record;
            live.set(sid, next);
            // 文字增量很密:这里**不**每次都排落盘,由 end() 与轮内防抖兜住。
            schedule(sid);
            return next;
        },
        /** 一条 ACP 增量(工具调用走它;文字也走它也成)。 */
        update({ id, update, at } = {}) {
            const sid = String(id ?? '');
            const record = live.get(sid);
            if (record === undefined) return null;
            const entry = entryFromUpdate(update, Number.isFinite(at) ? at : now());
            if (entry === null) return record;
            const next = entry.kind === 'tool' ? addTool(record, entry) : addText(record, entry.kind, entry.text, entry.at);
            live.set(sid, next);
            return next;
        },
        /** 这一轮收尾(带 error 就是"最后一条错")。 */
        end({ id, stopReason = '', error = '', at } = {}) {
            const sid = String(id ?? '');
            const record = live.get(sid);
            if (record === undefined) return null;
            const next = addEnd(record, { stopReason, error, at });
            live.set(sid, next);
            schedule(sid);
            return next;
        },
        /** 模型 / 强度变了。 */
        model({ id, model, modelValue, effort, effortValue } = {}) {
            const sid = String(id ?? '');
            const record = live.get(sid);
            if (record === undefined) return null;
            const next = withModel(record, { model, modelValue, effort, effortValue });
            live.set(sid, next);
            schedule(sid);
            return next;
        },
        /** 一份完整记录(清单之外的用途:回看、铺回对话)。 */
        async read(id) {
            const sid = String(id ?? '');
            const running = live.get(sid);
            if (running !== undefined) return { ok: true, record: running, running: true };
            const found = await locate(sid);
            if (found === null) return { ok: false, reason: '这条会话没有记录', record: null };
            try {
                const parsed = parseRecord(await fs.promises.readFile(found.file, 'utf8'));
                if (parsed === null) return { ok: false, reason: '这个文件不是会话记录', record: null };
                return { ok: true, running: false, record: { ...parsed, entries: asArray(parsed.entries) }, file: found.name };
            } catch (err) {
                return { ok: false, reason: `读不了:${err?.message ?? err}`, record: null };
            }
        },
        /** 删掉一条记录(用户明确要删才走这里)。 */
        async remove(id) {
            const sid = String(id ?? '');
            const t = timers.get(sid);
            if (t !== undefined) { clearTimeout(t); timers.delete(sid); }
            live.delete(sid);
            const found = await locate(sid);
            if (found === null) return { ok: true, removed: false };
            try {
                await fs.promises.unlink(found.file);
                return { ok: true, removed: true };
            } catch (err) {
                return { ok: false, reason: `删不掉:${err?.message ?? err}`, removed: false };
            }
        },
    };
}
