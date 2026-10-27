import { parentPort, workerData } from 'node:worker_threads';
import mammoth from 'mammoth';

const MAX_HTML_BYTES = 64 * 1024 * 1024;

try {
    const buffer = Buffer.from(workerData);
    if (buffer.length < 4) throw new Error('文件太短，不是有效的 DOCX 文档');
    if (buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
        throw new Error('文档使用 Office 加密容器，可能受密码保护；开物无法预览');
    }
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('文件不是有效的 DOCX 文档');
    const result = await mammoth.convertToHtml({ buffer }, {
        externalFileAccess: false,
        includeEmbeddedStyleMap: false,
        // Images stay embedded in the result. The renderer applies a MIME allowlist.
        convertImage: mammoth.images.imgElement((image) => image.readAsBase64String().then((data) => ({
            src: `data:${image.contentType};base64,${data}`,
        }))),
    });
    const html = String(result.value ?? '');
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
        throw new Error('转换后的 DOCX 预览过大(超过 64 MiB)');
    }
    parentPort?.postMessage({
        ok: true,
        result: {
            html,
            messages: (Array.isArray(result.messages) ? result.messages : []).map((item) => ({
                type: String(item?.type ?? 'warning'),
                message: String(item?.message ?? ''),
            })),
        },
    });
} catch (err) {
    parentPort?.postMessage({ ok: false, error: String(err?.message ?? err) });
}
