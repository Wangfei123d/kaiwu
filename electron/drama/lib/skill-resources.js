import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { admitImagePayload, sniffImageMime, MAX_IMAGE_BYTES } from '../../../app/lib/agent-image.js';

export function readProjectImages(dir, files = []) {
    if (!Array.isArray(files)) throw new Error('技能图片列表无效');
    const names = [...new Set(files)];
    const images = [];
    const hash = createHash('sha256');
    const shots = path.resolve(dir, 'shots');
    for (const file of names) {
        if (typeof file !== 'string' || path.basename(file) !== file || !file) throw new Error('图片必须位于项目 shots 目录内');
        const target = path.resolve(shots, file);
        if (!fs.existsSync(target)) throw new Error(`技能图片不在了：${file}（请重新导入）`);
        const realShots = fs.realpathSync(shots);
        const real = fs.realpathSync(target);
        if (!real.startsWith(realShots + path.sep)) throw new Error('图片必须位于项目目录内');
        const st = fs.statSync(real);
        if (!st.isFile() || st.size > MAX_IMAGE_BYTES) throw new Error(`技能图片大小不符合要求：${file}`);
        const bytes = fs.readFileSync(real);
        const mimeType = sniffImageMime(bytes);
        images.push({ mimeType, bytes });
        hash.update(file).update('\0').update(bytes);
    }
    const accepted = admitImagePayload(images);
    if (!accepted.ok) throw new Error(`技能图片不可读取：${accepted.reason}`);
    return { images: accepted.images, files: names, signature: hash.digest('hex') };
}

export function importProjectImage(dir, absolutePath) {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) throw new Error('请选择本地图片文件');
    const st = fs.statSync(absolutePath);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) throw new Error('图片文件超过大小上限或不是文件');
    const bytes = fs.readFileSync(absolutePath);
    const mimeType = sniffImageMime(bytes);
    const admitted = admitImagePayload([{ mimeType, bytes }]);
    if (!admitted.ok) throw new Error(`图片导入失败：${admitted.reason}`);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mimeType];
    const shots = path.join(dir, 'shots');
    fs.mkdirSync(shots, { recursive: true });
    const file = `${randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(shots, file), bytes, { flag: 'wx' });
    return { file, mime: mimeType, name: path.basename(absolutePath) };
}

