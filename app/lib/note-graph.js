// 链接图的推导:反链、未解析链接、建议链接。纯函数,可直接 node --test。
//
// 输入是"已索引的笔记"数组,输出是各种关系。刻意不做 IO ——
// 这样图谱逻辑能用构造数据完整覆盖,而不用先造一堆文件。

import { normalizeLinkTarget } from './wikilink.js';

/**
 * 由笔记列表建立"目标名 → 笔记"的查找表。
 *
 * 一篇笔记可能被多个名字引用,按优先级依次登记(先登记者优先,
 * 同名冲突时保留靠前的,并在 duplicates 里报出来):
 *   1. 文件名(不含目录、不含 .md)  ← 最常见的 [[笔记名]]
 *   2. 相对 vault 的路径(不含 .md) ← 支持 [[子目录/笔记名]]
 * 均为大小写不敏感(见 normalizeLinkTarget)。
 *
 * @param {Array<{id:string,path:string,title?:string}>} notes
 * @returns {{byTarget: Map<string, string>, duplicates: Array<{target:string,kept:string,dropped:string}>}}
 */
export function buildTargetIndex(notes) {
    const byTarget = new Map();
    const duplicates = [];

    const register = (key, id) => {
        if (key === '') return;
        if (byTarget.has(key)) {
            const kept = byTarget.get(key);
            // 同一篇笔记被两种写法登记到同一个 key 时**不算冲突** ——
            // 根目录下的笔记就是这样:basename 与「去扩展名的全路径」完全相同。
            // 只有真正不同的两篇抢同一个名字才算重复。
            if (kept !== id) duplicates.push({ target: key, kept, dropped: id });
            return;
        }
        byTarget.set(key, id);
    };

    // 两轮登记:先文件名(短名优先),再全路径。
    // 分两轮是为了让 [[笔记]] 稳定优于 [[目录/笔记]] —— 否则结果取决于数组顺序。
    for (const n of notes) {
        const base = baseName(n.path);
        register(normalizeLinkTarget(base), n.id);
    }
    for (const n of notes) {
        const noExt = n.path.replace(/\.md$/i, '');
        register(normalizeLinkTarget(noExt), n.id);
    }

    return { byTarget, duplicates };
}

/** 取路径最后一段,兼容 / 与 \。 */
export function baseName(p) {
    const s = String(p ?? '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i === -1 ? s : s.slice(i + 1);
}

/**
 * 构造完整链接图。
 *
 * @param {Array<{id:string,path:string,title?:string,tags?:string[],links?:Array}>} notes
 * @returns {{
 *   byTarget: Map<string,string>,
 *   backlinks: Map<string, Array<{fromId:string,fromTitle:string,line:number,alias:string|null,embed:boolean}>>,
 *   outgoing: Map<string, string[]>,
 *   unresolved: Array<{fromId:string,fromTitle:string,target:string,line:number}>,
 *   orphans: string[],
 *   duplicates: Array
 * }}
 */
export function buildGraph(notes) {
    const list = Array.isArray(notes) ? notes : [];
    const { byTarget, duplicates } = buildTargetIndex(list);

    const byId = new Map(list.map(n => [n.id, n]));
    const backlinks = new Map();
    const outgoing = new Map();
    const unresolved = [];

    for (const note of list) {
        const outs = [];
        for (const link of note.links ?? []) {
            const targetId = byTarget.get(normalizeLinkTarget(link.target));

            if (targetId === undefined) {
                unresolved.push({
                    fromId: note.id,
                    fromTitle: note.title ?? baseName(note.path),
                    target: link.target,
                    line: link.line ?? 1,
                });
                continue;
            }
            outs.push(targetId);

            // 自链接也记进反链(Obsidian 也显示),但调用方可以自行过滤
            if (!backlinks.has(targetId)) backlinks.set(targetId, []);
            backlinks.get(targetId).push({
                fromId: note.id,
                fromTitle: note.title ?? baseName(note.path),
                line: link.line ?? 1,
                alias: link.alias ?? null,
                embed: link.embed === true,
            });
        }
        outgoing.set(note.id, [...new Set(outs)]);
    }

    // 孤儿 = 既没有出链、也没有任何反链的笔记
    const orphans = [];
    for (const note of list) {
        const hasOut = (outgoing.get(note.id) ?? []).length > 0;
        const hasIn = (backlinks.get(note.id) ?? []).length > 0;
        if (!hasOut && !hasIn) orphans.push(note.id);
    }

    return { byTarget, backlinks, outgoing, unresolved, orphans, duplicates };
}

/**
 * 取某篇笔记的反链,按来源标题排序(稳定输出,便于测试与界面展示)。
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {string} noteId
 */
export function backlinksOf(graph, noteId) {
    const list = graph.backlinks.get(noteId) ?? [];
    return [...list].sort((a, b) => {
        if (a.fromTitle !== b.fromTitle) return a.fromTitle < b.fromTitle ? -1 : 1;
        return a.line - b.line;
    });
}

/**
 * 找出「提到过但还没链接」的笔记,用于建议链接。
 *
 * 判据:标题或文件名出现在正文里,但既没有出链指向它、也没有从它来的反链。
 * 这是"AI 参与链接"的基础能力 —— 先有确定的候选,再让 AI 排序。
 *
 * @param {{id:string,path:string,title?:string,body?:string}} note - 当前笔记(需带正文)
 * @param {Array<{id:string,path:string,title?:string}>} allNotes
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {{limit?:number,minTitleLength?:number}} [options]
 * @returns {Array<{id:string,title:string,reason:string}>}
 */
export function suggestLinks(note, allNotes, graph, options = {}) {
    const limit = options.limit ?? 10;
    // 太短的标题匹配噪音太大(比如「笔记」两个字会命中一切)
    const minLen = options.minTitleLength ?? 2;

    const body = String(note?.body ?? '');
    if (body === '') return [];

    const existing = new Set(graph.outgoing.get(note.id) ?? []);
    const incoming = new Set((graph.backlinks.get(note.id) ?? []).map(b => b.fromId));

    const out = [];
    for (const other of allNotes ?? []) {
        if (other.id === note.id) continue;
        if (existing.has(other.id)) continue;      // 已经链接过了
        if (incoming.has(other.id)) continue;      // 已经互相引用

        const title = other.title || baseName(other.path).replace(/\.md$/i, '');
        if (title.length < minLen) continue;
        if (!body.includes(title)) continue;       // 正文里没提到

        out.push({ id: other.id, title, reason: `正文里提到了「${title}」` });
        if (out.length >= limit) break;
    }

    return out;
}
