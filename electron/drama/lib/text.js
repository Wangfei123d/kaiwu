// 文本容器节点的"读文件"能力:把各种文件变成纯文本。**零依赖**。
//
// 支持:
//   .txt .md .markdown .json .csv .tsv .srt .vtt .log .yml .yaml .html .xml  → 按文本读(带编码嗅探)
//   .rtf   → 去控制字(粗略但够用)
//   .docx  → 解 zip 取 word/document.xml,抽 <w:t> 文本(真正的 Word 2007+ 格式)
//   .doc .pdf .xlsx 等 → 明确报"不支持",并告诉用户怎么办(不假装成功)
//
// 编码:先看 BOM;再按 **严格 UTF-8** 试(不合法就抛),失败回落 GB18030 ——
// 中文 Windows 上导出的 txt/srt 十有八九是 GBK/GB18030,只按 UTF-8 读会得到乱码。
import zlib from 'node:zlib';

const TEXT_EXT = new Set([
    'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'srt', 'vtt', 'log',
    'yml', 'yaml', 'html', 'htm', 'xml', 'ini', 'conf', 'text',
]);

export function extensionOf(name) {
    const clean = String(name ?? '').trim().toLowerCase();
    const at = clean.lastIndexOf('.');
    return at < 0 ? '' : clean.slice(at + 1);
}

/**
 * 面板拿去拼"文件类型"过滤器的扩展名清单 —— 排序固定,便于断言与阅读。
 *
 * ⚠️ 为什么要从这一侧给出去:能读哪些格式**只有这里知道**(TEXT_EXT + rtf + docx)。
 *    插件要是自己抄一份',txt,md,srt…',两份名单迟早漂移 —— 表现是"对话框里选不到
 *    某个其实支持的类型"。与节点类型的 `wired` 标记同一个理由:判据放在知道它的那一侧。
 */
export const IMPORT_EXTENSIONS = Object.freeze([
    ...[...TEXT_EXT].sort(),
    'rtf',
    'docx',
]);

/** 带编码嗅探的解码。返回 { text, encoding }。 */
export function decodeText(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8 (BOM)' };
    }
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        try { return { text: new TextDecoder('utf-16le').decode(buffer), encoding: 'utf-16le' }; } catch { /* 继续 */ }
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        try { return { text: new TextDecoder('utf-16be').decode(buffer), encoding: 'utf-16be' }; } catch { /* 继续 */ }
    }
    try {
        // fatal:true —— 只要有一个字节不合法 UTF-8 就抛,交给下面的回落。
        // 这一条是关键:否则 Node 会默默用替换字符兜住,得到一屏乱码还以为成功。
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
    } catch { /* 不是合法 UTF-8 */ }
    try {
        return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
    } catch { /* 环境没带这个编码 */ }
    return { text: buffer.toString('utf8'), encoding: 'utf-8 (非法字节被替换)' };
}

/** 极简 zip 读取:只取中央目录里点名的那一条。docx 就是一个 zip。 */
function readZipEntry(buffer, wanted) {
    let eocd = -1;
    const floor = Math.max(0, buffer.length - 66000);
    for (let i = buffer.length - 22; i >= floor; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip/docx(找不到中央目录)');
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i += 1) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        if (wanted.includes(name)) {
            const localNameLength = buffer.readUInt16LE(localOffset + 26);
            const localExtraLength = buffer.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            const raw = buffer.subarray(dataStart, dataStart + compressedSize);
            return method === 0 ? raw : zlib.inflateRawSync(raw);
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return null;
}

/** docx → 纯文本。段落 → 换行,<w:tab> → 制表,<w:br> → 换行。 */
export function docxToText(buffer) {
    const xml = readZipEntry(buffer, ['word/document.xml']);
    if (xml === null) throw new Error('这个 .docx 里没有 word/document.xml(文件可能损坏,或者是 .doc 改名来的)');
    let out = xml.toString('utf8');
    out = out.replace(/<w:tab\b[^>]*\/?>/g, '\t');
    out = out.replace(/<w:br\b[^>]*\/?>/g, '\n');
    out = out.replace(/<\/w:p>/g, '\n');
    out = out.replace(/<[^>]+>/g, '');
    out = out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');   // & 必须放最后,否则 &amp;lt; 会被二次解码
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** rtf → 纯文本(粗略:去控制字与目标组,还原 \'hh 十六进制转义)。 */
export function rtfToText(buffer) {
    const { text } = decodeText(buffer);
    let out = text;
    out = out.replace(/\{\\\*[^{}]*\}/g, '');
    out = out.replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
    out = out.replace(/\\par[d]?\b/g, '\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t');
    out = out.replace(/\\[a-zA-Z]+-?\d*\s?/g, '');
    out = out.replace(/[{}]/g, '');
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

const UNSUPPORTED = {
    doc: '旧版 Word(.doc)是二进制格式,这里解不了。请在 Word / WPS 里「另存为 .docx」再导入。',
    pdf: 'PDF 没有可靠的纯文本层可提取。建议从原始 Word / Markdown 导入,或先转成 .txt。',
    xlsx: '表格请先导出为 .csv 再导入。',
    xls: '表格请先导出为 .csv 再导入。',
    pptx: '演示稿建议先导出成 .txt / .md 再导入。',
    zip: '压缩包请先解压,再导入里面的文件。',
};

/**
 * 把任意受支持的文件转成纯文本。
 * @param {string} name 文件名(用来看扩展名)
 * @param {Buffer} buffer 文件内容
 * @returns {{ text: string, kind: string, note: string }}
 */
export function extractText(name, buffer) {
    const ext = extensionOf(name);
    if (ext === 'docx') {
        return { text: docxToText(buffer), kind: 'docx', note: 'Word(.docx):已抽取正文文字(格式会丢,表格按单元格顺序拼接)' };
    }
    if (ext === 'rtf') {
        return { text: rtfToText(buffer), kind: 'rtf', note: 'RTF:已去掉控制字(格式会丢,文字保留)' };
    }
    if (UNSUPPORTED[ext] !== undefined) throw new Error(UNSUPPORTED[ext]);
    if (TEXT_EXT.has(ext) || ext === '') {
        const { text, encoding } = decodeText(buffer);
        return { text, kind: TEXT_EXT.has(ext) ? ext : 'txt', note: `纯文本(${encoding})` };
    }
    // 未知扩展名:仍当文本试一次(剧本常有 .fountain / .spmd 这类);真乱码会看得出来
    const { text, encoding } = decodeText(buffer);
    return { text, kind: ext, note: `按纯文本读(${encoding});扩展名 .${ext} 未特别处理` };
}
