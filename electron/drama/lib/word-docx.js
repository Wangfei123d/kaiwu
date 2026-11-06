// 生成可由 Word / WPS 打开的最小 OpenXML 文档，不依赖外部命令或额外包。
const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let value = n;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[n] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const [name, value] of entries) {
        const nameBytes = Buffer.from(name, 'utf8');
        const data = Buffer.from(value, 'utf8');
        const checksum = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
        local.writeUInt16LE(0, 8); // Store，无压缩
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        localParts.push(local, nameBytes, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBytes);
        offset += local.length + nameBytes.length + data.length;
    }
    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlText(value) {
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function paragraph(line) {
    const runs = line.split('\t').map((part, index) => `${index ? '<w:tab/>' : ''}<w:t xml:space="preserve">${xmlText(part)}</w:t>`).join('');
    return `<w:p><w:r>${runs}</w:r></w:p>`;
}

/** 将纯文本保留换行地封装为 DOCX。 */
export function createWordDocument(content) {
    const paragraphs = String(content).replace(/\r\n?/g, '\n').split('\n').map(paragraph).join('');
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
        `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ` +
        `w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`;
    return zipStore([
        ['[Content_Types].xml', contentTypes],
        ['_rels/.rels', rootRels],
        ['word/document.xml', documentXml],
    ]);
}
