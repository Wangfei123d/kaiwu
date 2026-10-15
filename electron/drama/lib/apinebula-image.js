import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IMAGE_BASE_URL, IMAGE_MODEL, IMAGE_SIZE } from '../image-settings.js';
import { admitImagePayload } from '../../../app/lib/agent-image.js';

export const APINEBULA_IMAGE_SIGNATURE = `${IMAGE_BASE_URL}|${IMAGE_MODEL}|${IMAGE_SIZE}|single-v1`;
const IMAGE_GENERATION_TIMEOUT_MS = 300000;

function saveImageFile(dir, bytes, ext = 'png') {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${randomUUID()}.${ext}`);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return file;
}

/** 一次请求只出一张；重复请求次数由画面节点的“出几张”决定。 */
export function createApinebulaImageGenerator({
    resolveKey, fetchImpl = globalThis.fetch, saveImage = saveImageFile,
} = {}) {
    if (typeof resolveKey !== 'function' || typeof fetchImpl !== 'function'
        || typeof saveImage !== 'function') {
        throw new Error('图片服务缺少密钥解析、网络请求或保存能力');
    }

    return async function generate({ prompt, batch = 1, dir, images = [] } = {}) {
        const description = String(prompt ?? '').trim();
        if (description === '') throw new Error('提示词是空的：请连接上游文本或填写节点提示词');
        const admitted = admitImagePayload(images);
        if (!admitted.ok) throw new Error(admitted.reason);
        if (admitted.images.some((image) => image.mimeType === 'image/gif')) {
            throw new Error('图片编辑不支持 GIF 参考图，请转换为 PNG / JPEG / WebP');
        }
        const credential = resolveKey();
        if (credential?.ok !== true || !credential.secret) {
            throw new Error(credential?.reason ?? '图片密钥未配置，请在设置页录入');
        }
        const count = Math.max(1, Math.min(8, Number(batch) || 1));
        const files = [];
        for (let index = 0; index < count; index += 1) {
            const editing = admitted.images.length > 0;
            const parameters = { model: IMAGE_MODEL, prompt: description, n: 1,
                size: IMAGE_SIZE, response_format: 'b64_json' };
            const headers = { authorization: `Bearer ${credential.secret}` };
            let body;
            if (editing) {
                body = new FormData();
                for (const [key, value] of Object.entries(parameters)) body.append(key, String(value));
                const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
                for (const [imageIndex, image] of admitted.images.entries()) {
                    body.append('image', new Blob([image.bytes], { type: image.mimeType }),
                        `reference-${imageIndex + 1}.${extensions[image.mimeType]}`);
                }
            } else {
                headers['content-type'] = 'application/json';
                body = JSON.stringify(parameters);
            }
            let response;
            try {
                response = await fetchImpl(`${IMAGE_BASE_URL}/images/${editing ? 'edits' : 'generations'}`, {
                    method: 'POST',
                    headers,
                    body,
                    signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
                });
            } catch (error) {
                throw new Error(`第 ${index + 1} 张出图请求失败（已保存 ${files.length} 张）：${error?.message ?? error}`);
            }
            if (!response.ok) {
                throw new Error(`第 ${index + 1} 张出图接口返回 HTTP ${response.status}（已保存 ${files.length} 张）；请核对模型分组与竖屏尺寸`);
            }
            let item;
            try {
                const payload = await response.json();
                item = Array.isArray(payload?.data) ? payload.data[0] : null;
            } catch {
                throw new Error(`第 ${index + 1} 张出图响应不是有效 JSON（已保存 ${files.length} 张）`);
            }
            if (typeof item?.b64_json === 'string' && item.b64_json !== '') {
                files.push(await saveImage(dir, Buffer.from(item.b64_json, 'base64'), 'png'));
            } else if (typeof item?.url === 'string' && item.url !== '') {
                let imageUrl;
                try { imageUrl = new URL(item.url); } catch { /* 在下面统一拒绝 */ }
                if (imageUrl?.protocol !== 'https:') throw new Error('图片下载地址不是 HTTPS，拒绝访问');
                const download = await fetchImpl(imageUrl.href, { signal: AbortSignal.timeout(120000) });
                if (!download.ok) throw new Error(`第 ${index + 1} 张图片下载失败：HTTP ${download.status}`);
                const suffix = path.extname(imageUrl.pathname).toLowerCase();
                const ext = suffix === '.jpg' || suffix === '.jpeg' ? 'jpg'
                    : suffix === '.webp' ? 'webp' : 'png';
                files.push(await saveImage(dir, Buffer.from(await download.arrayBuffer()), ext));
            } else {
                throw new Error(`第 ${index + 1} 张出图响应没有图片（已保存 ${files.length} 张）`);
            }
        }
        return { files, detail: `APINebula · ${IMAGE_MODEL} · ${IMAGE_SIZE} · ${files.length} 张` };
    };
}
