const RATIO_KEYS = new Set(['aspectratio', 'imageratio', 'ratio', 'size', 'dimensions', 'resolution']);
const NESTED_KEYS = new Set(['input', 'arguments', 'args', 'params', 'parameters', 'options', 'config', 'request', 'data', 'payload', 'generation', 'format', 'image']);

export function isImageGenerationTitle(value) {
    return /^(?:[\w.-]+[.:/])?generate_image(?:$|[\s(])/i.test(String(value ?? '').trim());
}

function ratioNumber(width, height) {
    const w = Number(width), h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    const ratio = w / h;
    return ratio >= 0.1 && ratio <= 10 ? ratio : null;
}

function parseRatio(value) {
    if (typeof value === 'number') return ratioNumber(value, 1);
    if (typeof value !== 'string') return null;
    const text = value.trim().toLowerCase();
    if (/^(?:square|正方(?:形)?|方图)$/.test(text)) return 1;
    if (/^(?:portrait|vertical|竖版|竖屏|竖图|竖构图|纵向|竖向)$/.test(text)) return 2 / 3;
    if (/^(?:story|mobile|手机竖屏|手机壁纸)$/.test(text)) return 9 / 16;
    if (/^(?:landscape|horizontal|横版|横屏|横图|横构图|横向)$/.test(text)) return 3 / 2;
    if (/^(?:widescreen|wide|宽屏)$/.test(text)) return 16 / 9;
    if (/^\d+(?:\.\d+)?$/.test(text)) return ratioNumber(text, 1);
    const match = text.match(/^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/);
    return match ? ratioNumber(match[1], match[2]) : null;
}

function ratioInPrompt(text) {
    if (!/(?:aspect\s*ratio|\bratio\b|比例|宽高比|画幅|portrait|vertical|landscape|horizontal|竖版|竖屏|竖图|竖构图|横版|横屏|横图|横构图|正方)/i.test(text)) return null;
    const numeric = text.match(/(\d+(?:\.\d+)?\s*[:/x×]\s*\d+(?:\.\d+)?)/);
    if (numeric) return parseRatio(numeric[1]);
    return parseRatio(text.match(/\b(?:portrait|vertical|landscape|horizontal|widescreen|square)\b|竖版|竖屏|竖图|竖构图|纵向|竖向|横版|横屏|横图|横构图|横向|正方(?:形)?/i)?.[0] ?? '');
}

/** 从 ACP 的工具原始参数中提取一个安全的宽高比，返回 CSS 可用的小数。 */
export function imageAspectRatioFromInput(rawInput) {
    let root = rawInput;
    if (typeof root === 'string') {
        try { root = JSON.parse(root); } catch { return ratioInPrompt(root); }
    }
    const visited = new Set();
    function visit(value, depth = 0) {
        if (depth > 4 || value === null || typeof value !== 'object' || visited.has(value)) return null;
        visited.add(value);
        if (Array.isArray(value)) {
            for (const item of value.slice(0, 16)) {
                const found = visit(item, depth + 1);
                if (found !== null) return found;
            }
            return null;
        }
        const entries = Object.entries(value).slice(0, 48);
        const normalized = new Map(entries.map(([key, child]) => [key.toLowerCase().replace(/[^a-z]/g, ''), child]));
        const width = normalized.get('width'), height = normalized.get('height');
        if (width !== undefined && height !== undefined) {
            const found = ratioNumber(width, height);
            if (found !== null) return found;
        }
        for (const [key, child] of entries) {
            const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
            if (RATIO_KEYS.has(normalizedKey) || /(?:aspect|ratio|dimensions|resolution|imagesize|outputsize)/.test(normalizedKey)) {
                const found = typeof child === 'object' && child !== null
                    ? visit(child, depth + 1) : parseRatio(child);
                if (found !== null) return found;
            }
            if (/^(?:prompt|description|instruction)$/i.test(key) && typeof child === 'string') {
                const found = ratioInPrompt(child);
                if (found !== null) return found;
            }
        }
        for (const [key, child] of entries) {
            if (!NESTED_KEYS.has(key.toLowerCase())) continue;
            const found = visit(child, depth + 1);
            if (found !== null) return found;
        }
        return null;
    }
    const ratio = visit(root);
    return ratio === null ? null : Number(ratio.toFixed(6));
}
