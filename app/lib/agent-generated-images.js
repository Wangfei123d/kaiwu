import { parseMarkdown } from './markdown.js';
import { imageAspectRatioFromInput, isImageGenerationTitle } from './image-aspect-ratio.js';

export const failedImageTool = tool => ['failed', 'error', 'cancelled'].includes(String(tool?.status ?? ''));
export function isImageGenerationTool(tool) {
    return isImageGenerationTitle(tool?.title);
}

function imageReferences(message) {
    const text = String(message.text ?? '');
    if (!/https?:\/\//i.test(text)) return [];
    const images = new Map();
    function visit(value) {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== 'object') return;
        if (value.type === 'image') {
            try {
                if (!['http:', 'https:'].includes(new URL(value.url).protocol)) return;
            } catch { return; }
            // 末尾尚在增长的裸地址不能被前面代码示例中的同名完整地址提前判定为结果。
            const at = text.lastIndexOf(value.url);
            const complete = message.done === true || /^[\s)\]。？，,;!?]/.test(text.slice(at + value.url.length));
            const previous = images.get(value.url);
            images.set(value.url, { url: value.url, alt: value.alt || previous?.alt || '', complete: complete || previous?.complete === true });
            return;
        }
        for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
    }
    visit(parseMarkdown(text, { wikilinks: false, tags: false, tables: true }));
    return [...images.values()];
}

/** 回复可能在工具之前创建、在工具结束后继续追加，所以按整轮关联结果。 */
export function planGeneratedImages(timeline) {
    const turns = [[]];
    for (const item of timeline) {
        if (item.kind === 'message' && item.message.role === 'user') turns.push([]);
        turns[turns.length - 1].push(item);
    }
    const generations = [], omittedByMessage = new Map();
    turns.forEach((items, turn) => {
        const userMessage = items.find(item => item.kind === 'message' && item.message.role === 'user')?.message;
        const promptAspectRatio = imageAspectRatioFromInput({ prompt: String(userMessage?.text ?? '') });
        const calls = items.filter(item => item.kind === 'tool' && isImageGenerationTool(item.tool))
            .map(item => ({
                toolCallId: item.tool.toolCallId, tool: item.tool, turn, images: [],
                aspectRatio: item.tool.aspectRatio ?? promptAspectRatio,
            }));
        generations.push(...calls);
        const eligible = calls.filter(call => !failedImageTool(call.tool));
        if (eligible.length === 0) return;
        const owners = new Map();
        for (const item of items) {
            if (item.kind !== 'message' || item.message.role !== 'assistant') continue;
            const references = imageReferences(item.message);
            if (references.length) omittedByMessage.set(item.message.id, new Set(references.map(image => image.url)));
            for (const { url, alt, complete } of references) {
                if (!complete || owners.has(url)) continue;
                const owner = eligible.find(call => call.images.length === 0) ?? eligible[eligible.length - 1];
                owner.images.push({ url, alt });
                owners.set(url, owner);
            }
        }
    });
    return { generations, omittedByMessage, currentTurn: turns.length - 1 };
}
