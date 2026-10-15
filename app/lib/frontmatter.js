// YAML frontmatter 的解析与序列化。纯函数,可直接 node --test。
//
// 刻意只支持一个**子集**,不引 YAML 库。理由:
//   1. 笔记里的 frontmatter 实际只用得到标量、数组、简单嵌套;
//   2. 完整 YAML 有大量边角(锚点、多行折叠、类型标签),实现全了也没人用;
//   3. 「解析不了就原样保留」比「猜错」安全 —— 见下面的 parseFrontmatter 契约。
//
// 支持的语法:
//   ---
//   title: 我的笔记
//   tags: [a, b]            # 行内数组
//   tags2:                  # 块数组
//     - a
//     - b
//   nested:
//     key: value
//   quoted: "带: 冒号的值"
//   ---
//
// **明确不支持**(遇到会当字符串处理,不会抛错):
// 多行折叠(| 与 >)、锚点与别名(& 与 *)、显式类型标签(!!str)、
// 复杂嵌套(三层以上)、日期类型推断(日期就是字符串,避免时区坑)。

const DELIM = '---';

/**
 * 拆分出 frontmatter 与正文。
 *
 * 契约:**只有** 文件以 `---` 开头(允许前面有 BOM)、且能在后面找到
 * 结束的 `---` 时才算有 frontmatter。否则 raw 为空、body 是全文。
 * 这条契约重要:正文里出现一条水平分割线 `---` 不该被误认为 frontmatter 结束。
 *
 * @param {string} text
 * @returns {{raw: string, body: string, hasFrontmatter: boolean}}
 */
export function splitFrontmatter(text) {
    if (typeof text !== 'string' || text === '') {
        return { raw: '', body: '', hasFrontmatter: false };
    }

    // 去掉 BOM,否则第一行匹配不上
    let s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

    const firstLineEnd = s.indexOf('\n');
    if (firstLineEnd === -1) return { raw: '', body: s, hasFrontmatter: false };

    const firstLine = s.slice(0, firstLineEnd).trim();
    if (firstLine !== DELIM) return { raw: '', body: s, hasFrontmatter: false };

    // 从第二行起找结束分隔符
    let pos = firstLineEnd + 1;
    while (pos <= s.length) {
        const lineEnd = s.indexOf('\n', pos);
        const lineStop = lineEnd === -1 ? s.length : lineEnd;
        const line = s.slice(pos, lineStop).trim();

        if (line === DELIM) {
            const raw = s.slice(firstLineEnd + 1, pos);
            const body = lineEnd === -1 ? '' : s.slice(lineEnd + 1);
            return { raw, body, hasFrontmatter: true };
        }
        if (lineEnd === -1) break;
        pos = lineEnd + 1;
    }

    // 有开头没有结尾:不当 frontmatter,整篇都是正文(避免吞掉用户内容)
    return { raw: '', body: s, hasFrontmatter: false };
}

/**
 * 解析 frontmatter 文本为对象。
 * @param {string} raw - splitFrontmatter 返回的 raw(不含两条 --- 行)
 * @returns {object}
 */
export function parseFrontmatter(raw) {
    const out = {};
    if (typeof raw !== 'string' || raw.trim() === '') return out;

    const lines = raw.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // 跳过空行与整行注释
        if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }

        const m = /^([^\s:][^:]*):(.*)$/.exec(line);
        if (!m) { i++; continue; }                  // 不认识的行直接跳过,不猜

        const key = m[1].trim();
        const rest = m[2].trim();

        if (rest === '') {
            // 可能是块数组或嵌套对象 —— 看下一行的缩进
            const items = [];
            const nested = {};
            let sawList = false;
            let sawNested = false;
            let j = i + 1;

            while (j < lines.length) {
                const next = lines[j];
                if (next.trim() === '') { j++; continue; }
                // 缩进没有了 → 本键结束
                if (!/^\s/.test(next)) break;

                const listItem = /^\s*-\s*(.*)$/.exec(next);
                if (listItem) {
                    sawList = true;
                    items.push(parseScalar(listItem[1]));
                    j++;
                    continue;
                }
                const kv = /^\s+([^\s:][^:]*):(.*)$/.exec(next);
                if (kv) {
                    sawNested = true;
                    nested[kv[1].trim()] = parseScalar(kv[2].trim());
                    j++;
                    continue;
                }
                j++;
            }

            if (sawList) out[key] = items;
            else if (sawNested) out[key] = nested;
            else out[key] = null;
            i = j;
            continue;
        }

        out[key] = parseScalar(rest);
        i++;
    }

    return out;
}

/**
 * 解析一个标量或行内数组。
 * @param {string} s
 * @returns {string|number|boolean|null|Array}
 */
export function parseScalar(s) {
    const v = String(s).trim();

    if (v === '') return '';
    if (v === 'null' || v === '~') return null;
    if (v === 'true') return true;
    if (v === 'false') return false;

    // 行内数组 [a, b, c] / ["a", "b"]
    if (v.startsWith('[') && v.endsWith(']')) {
        const inner = v.slice(1, -1).trim();
        if (inner === '') return [];
        return splitInlineList(inner).map(parseScalar);
    }

    // 引号包裹:去掉引号并反转义,允许里面含冒号、# 等
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)
        || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
        const inner = v.slice(1, -1);
        // 双引号里的 \" 与 \\ 需要反转义 —— 序列化时加上的,读回时必须还原,
        // 否则 title: '带"引号"' 往返一次就会变成 带\"引号\"。
        // 单引号按 YAML 惯例用 '' 表示一个单引号,这里同样还原。
        if (v.startsWith('"')) {
            return inner.replace(/\\(["\\])/g, '$1');
        }
        return inner.replace(/''/g, "'");
    }

    // 去掉行尾注释(未加引号时才处理)
    const hashAt = v.indexOf(' #');
    if (hashAt !== -1) return parseScalar(v.slice(0, hashAt).trim());

    // 纯数字才转 number —— 保留 "1.0.0"、"2026-09-17" 这类为字符串
    if (/^-?\d+$/.test(v)) return Number(v);

    return v;
}

/** 按逗号切分行内数组,尊重引号里的逗号。 */
export function splitInlineList(inner) {
    const parts = [];
    let cur = '';
    let quote = null;
    for (const ch of inner) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === ',') { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts.map(p => p.trim()).filter(p => p !== '');
}

/**
 * 把对象序列化回 frontmatter 文本(不含两条 --- 行)。
 *
 * 何时需要它:AI 修改了 title/tags 之类元数据后要写回文件。
 * 刻意不做"保留原格式与原注释"——那需要完整的 YAML 语法树,
 * 而笔记的 frontmatter 很短,重排一遍的代价可以接受。
 * 但调用方应只在**确实改了 frontmatter** 时才回写,否则会白白重排用户的文件。
 *
 * @param {object} data
 * @returns {string}
 */
export function serializeFrontmatter(data) {
    if (!data || typeof data !== 'object') return '';
    const lines = [];

    for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;

        if (Array.isArray(value)) {
            if (value.length === 0) { lines.push(`${key}: []`); continue; }
            // 元素里有逗号或特殊字符就走块数组,避免歧义
            const needsBlock = value.some(v => /[,\[\]{}]/.test(String(v)));
            if (needsBlock) {
                lines.push(`${key}:`);
                for (const v of value) lines.push(`  - ${formatScalar(v)}`);
            } else {
                lines.push(`${key}: [${value.map(formatScalar).join(', ')}]`);
            }
            continue;
        }

        if (value !== null && typeof value === 'object') {
            lines.push(`${key}:`);
            for (const [k2, v2] of Object.entries(value)) {
                lines.push(`  ${k2}: ${formatScalar(v2)}`);
            }
            continue;
        }

        lines.push(`${key}: ${formatScalar(value)}`);
    }

    return lines.join('\n');
}

function formatScalar(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    const s = String(v);
    // 含特殊字符就加引号,避免解析回来时被当成结构
    if (s === '' || /[:#\[\]{},"']/.test(s) || /^\s|\s$/.test(s)) {
        return '"' + s.replace(/"/g, '\\"') + '"';
    }
    return s;
}

/**
 * 便捷入口:直接拿解析好的对象与正文。
 * @param {string} text
 * @returns {{data: object, body: string, raw: string, hasFrontmatter: boolean}}
 */
export function readFrontmatter(text) {
    const { raw, body, hasFrontmatter } = splitFrontmatter(text);
    return { data: parseFrontmatter(raw), body, raw, hasFrontmatter };
}

/**
 * 把 frontmatter 与正文拼回完整文件内容。
 * @param {object} data
 * @param {string} body
 * @returns {string}
 */
export function writeFrontmatter(data, body) {
    const raw = serializeFrontmatter(data);
    if (raw.trim() === '') return String(body ?? '');
    return `${DELIM}\n${raw}\n${DELIM}\n${body ?? ''}`;
}
