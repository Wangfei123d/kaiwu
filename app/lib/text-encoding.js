// 文本文件的编解码判据。**纯逻辑,只依赖 TextDecoder/Buffer**,可直接 node --test。
//
// 为什么必须有这一层:笔记原先是"我们自己建、自己写"的 .md,所以
// `readFile(abs,'utf8')` 是天经地义的。而 .txt 是**别人给的**(docx 导出的剧本、
// 下载的日志、别的工具写出来的配置),于是三件事必须分开判:
//
//   ① **是不是文本**:前 8 KB 里出现 NUL → 大概率是二进制(伪装成 .txt 的 dll/图)。
//      硬套解码器只会得到一屏乱码,还白读一整个文件进内存。
//   ② **用哪种编码**:
//        BOM(EF BB BF / FF FE / FE FF)→ 按 BOM 认,这是最硬的证据;
//        否则先试**严格** UTF-8(fatal:true)—— 通过了就是 UTF-8;
//        不通过再试 GB18030 —— 中文环境里 .txt 大量是 GBK,这是唯一能救回它们的一步。
//   ③ **能不能安全写回**:只有 UTF-8(含 BOM)能写回。
//      GB18030 / UTF-16 我们解得开、但**编不回去**(Node 的 TextEncoder 只出 UTF-8,
//      而仓库不引第三方编码库)→ 这类文件一律**只读**,绝不"读成 UTF-8、写回去变成另一种文件"。
//
// ⚠️ 判据只看**开头**:一个 12 MB 的文件里第 5 MB 处有一个 NUL,不影响"它是文本";
//    真要逐字节判定得读全文,而那一读就已经把内存吃掉了 —— 不值得。

/** 判二进制时看多少字节(够常见格式暴露自己了)。 */
export const SNIFF_BYTES = 8192;

/** 能原样写回的编码。其余一律只读。 */
const WRITABLE = new Set(['utf-8', 'utf-8-bom']);

/**
 * 换行风格。写回时按它还原 —— 否则"打开一篇 CRLF 的 txt 再保存"会把它整篇换成 LF,
 * 在 diff / git 里就是一行没改却全亮。
 * @param {string} text
 * @returns {'crlf'|'lf'|'cr'|'none'}
 */
export function newlineStyleOf(text) {
    const s = String(text ?? '');
    const crlf = (s.match(/\r\n/g) ?? []).length;
    const lf = (s.match(/(?<!\r)\n/g) ?? []).length;
    const cr = (s.match(/\r(?!\n)/g) ?? []).length;
    if (crlf >= lf && crlf >= cr && crlf > 0) return 'crlf';
    if (lf >= cr && lf > 0) return 'lf';
    if (cr > 0) return 'cr';
    return 'none';
}

/** 按换行风格把文本的换行统一回去(保存路径用)。 */
export function applyNewline(text, style) {
    const s = String(text ?? '');
    if (style === 'crlf') return s.replace(/\r\n|\r|\n/g, '\r\n');
    if (style === 'lf') return s.replace(/\r\n|\r|\n/g, '\n');
    if (style === 'cr') return s.replace(/\r\n|\r|\n/g, '\r');
    return s;
}

/**
 * 一段字节 → 文本 + 编码结论。
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {{
 *   ok:boolean,                  // 能不能当文本打开
 *   text:string,
 *   encoding:string,             // 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'binary' | 'unknown'
 *   bom:boolean,                 // 原文有 BOM(写回时要补上)
 *   newline:'crlf'|'lf'|'cr'|'none',
 *   editable:boolean,            // 能不能安全写回
 *   reason:string,               // ok=false 时给人看的原因
 * }}
 */
export function decodeText(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    const sniff = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));

    // ---- ① BOM 优先:它是最硬的证据,而且 UTF-16 里**天然**带 NUL,
    //         如果先判 NUL 会把所有 UTF-16 文本误判成二进制(顺序不能反)。
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        const text = buf.subarray(3).toString('utf8');
        return { ok: true, text, encoding: 'utf-8-bom', bom: true, newline: newlineStyleOf(text), editable: true, reason: '' };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        const text = new TextDecoder('utf-16le').decode(buf.subarray(2));
        return { ok: true, text, encoding: 'utf-16le', bom: true, newline: newlineStyleOf(text), editable: false, reason: '' };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const text = new TextDecoder('utf-16be').decode(buf.subarray(2));
        return { ok: true, text, encoding: 'utf-16be', bom: true, newline: newlineStyleOf(text), editable: false, reason: '' };
    }

    // ---- ② 没有 BOM:先看是不是二进制
    if (sniff.includes(0)) {
        return {
            ok: false, text: '', encoding: 'binary', bom: false, newline: 'none', editable: false,
            reason: '这不是文本文件(开头就有 NUL 字节),开物不按文本打开它',
        };
    }

    // ---- ③ 严格 UTF-8:通过就是它。⚠️ 必须 fatal —— 默认的"替换成 U+FFFD"
    //         会把 GBK 文件伪装成"能读但全是问号",那是更坏的结果。
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return { ok: true, text, encoding: 'utf-8', bom: false, newline: newlineStyleOf(text), editable: true, reason: '' };
    } catch { /* 不是合法 UTF-8,往下试 GB18030 */ }

    // ---- ④ 回退 GB18030(GBK 的超集,能覆盖绝大多数中文老文件)
    try {
        const text = new TextDecoder('gb18030', { fatal: true }).decode(buf);
        return {
            ok: true, text, encoding: 'gb18030', bom: false, newline: newlineStyleOf(text), editable: false,
            reason: '这份文件不是 UTF-8(按 GB18030 读出来的),开物只能读它 —— 保存请用系统程序',
        };
    } catch { /* 也解不开,当二进制处理 */ }

    return {
        ok: false, text: '', encoding: 'unknown', bom: false, newline: 'none', editable: false,
        reason: '这份文件的编码认不出来,开物不按文本打开它',
    };
}

/** 文本 → 要写进磁盘的字节(按读进来时的编码与换行原样还原)。 */
export function encodeText(text, { encoding = 'utf-8', bom = false } = {}) {
    if (!WRITABLE.has(encoding)) {
        throw new Error(`这份文件是 ${encoding},开物不能安全写回(只支持 UTF-8)`);
    }
    const body = Buffer.from(String(text ?? ''), 'utf8');
    const wantBom = bom === true || encoding === 'utf-8-bom';
    return wantBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}
