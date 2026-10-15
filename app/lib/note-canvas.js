// JSON Canvas 的共享验证器：主进程与面板使用同一份数据边界。
export const CANVAS_MAX_BYTES = 8 * 1024 * 1024;
export function isCanvasRelativePath(value) {
    if (typeof value !== 'string' || !value || /[\\:\u0000-\u001f]/.test(value) || value.startsWith('/')) return false;
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { return false; }
    return decoded === value && !/[\\:\u0000-\u001f]/.test(decoded) && !decoded.startsWith('/')
        && decoded.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sides = new Set(['top', 'right', 'bottom', 'left']);
const fileType = value => /\.(md|txt|png|jpe?g|webp|gif|bmp)$/i.test(value);
function fields(source, known) {
    if (Object.keys(source).some(key => !known.includes(key))) fail('画布包含当前版本不支持的字段，请保留原文件并使用兼容的编辑器');
}
function color(value) {
    if (value !== undefined && !/^(#[a-f0-9]{6}|[1-6])$/i.test(value)) fail('画布颜色必须是 #RRGGBB 或 1–6');
}
function strings(source, target, keys) {
    for (const key of keys) if (source[key] !== undefined) {
        if (typeof source[key] !== 'string') fail(`画布 ${key} 必须是文本`);
        target[key] = source[key];
    }
}
export function normalizeCanvas(graph) {
    if (!object(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) fail('画布必须包含节点和连线数组');
    if (graph.nodes.length > 1000) fail('画布最多支持 1000 个节点');
    if (graph.edges.length > 5000) fail('画布最多支持 5000 条连线');
    fields(graph, ['nodes', 'edges', 'viewport']);
    let json;
    try { json = JSON.stringify(graph); } catch { fail('画布必须是可序列化的 JSON'); }
    if (new TextEncoder().encode(json).length > CANVAS_MAX_BYTES) fail('画布大小不能超过 8 MiB');
    const ids = new Set(); const nodeIds = new Set();
    const id = item => {
        if (!object(item) || typeof item.id !== 'string' || !item.id.trim()) fail('画布 ID 不能为空');
        if (ids.has(item.id)) fail('画布 ID 重复');
        ids.add(item.id); return item.id;
    };
    const nodes = graph.nodes.map(item => {
        const key = id(item); nodeIds.add(key);
        fields(item, ['id', 'type', 'x', 'y', 'width', 'height', 'text', 'file', 'url', 'label', 'color', 'subpath', 'background', 'backgroundStyle']);
        if (!['text', 'file', 'link', 'group'].includes(item.type)) fail('画布节点类型不支持');
        if (![item.x, item.y, item.width, item.height].every(finite) || item.width <= 0 || item.height <= 0) fail('画布坐标须有限，尺寸须大于零');
        const result = { id: key, type: item.type, x: Math.round(item.x), y: Math.round(item.y), width: Math.max(1, Math.round(item.width)), height: Math.max(1, Math.round(item.height)) };
        strings(item, result, ['text', 'file', 'url', 'label', 'color', 'subpath', 'background', 'backgroundStyle']);
        color(item.color);
        if (item.type === 'text' && typeof item.text !== 'string') fail('文本节点必须有正文');
        if (item.text !== undefined && item.text.length > 200000) fail('单个文本节点不能超过 200000 个字符');
        if (item.type === 'file' && (!isCanvasRelativePath(item.file) || !fileType(item.file))) fail('文件节点必须使用安全的库内笔记或图片文件路径');
        if (item.subpath !== undefined && !item.subpath.startsWith('#')) fail('文件子路径须以 # 开头');
        if (item.background !== undefined && (!isCanvasRelativePath(item.background) || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(item.background))) fail('分组背景须使用安全的库内图片路径');
        if (item.backgroundStyle !== undefined && !['cover', 'ratio', 'repeat'].includes(item.backgroundStyle)) fail('分组背景样式无效');
        if (item.type === 'link') {
            try { if (!['http:', 'https:'].includes(new URL(item.url).protocol)) fail('链接只支持 HTTP/HTTPS'); }
            catch { fail('链接只支持有效的 HTTP/HTTPS 地址'); }
        }
        return result;
    });
    const edges = graph.edges.map(item => {
        const result = { id: id(item), fromNode: item.fromNode, toNode: item.toNode };
        fields(item, ['id', 'fromNode', 'toNode', 'fromSide', 'toSide', 'label', 'color', 'fromEnd', 'toEnd']);
        color(item.color);
        if (!nodeIds.has(item.fromNode) || !nodeIds.has(item.toNode)) fail('连线端点不存在');
        // JSON Canvas 允许省略 side，由显示方自动选择最近侧边。
        for (const key of ['fromSide', 'toSide']) if (item[key] !== undefined) {
            if (!sides.has(item[key])) fail('连线侧边只支持 top/right/bottom/left');
            result[key] = item[key];
        }
        strings(item, result, ['label', 'color', 'fromEnd', 'toEnd']);
        for (const key of ['fromEnd', 'toEnd']) if (result[key] !== undefined && !['none', 'arrow'].includes(result[key])) fail('连线箭头类型不支持');
        return result;
    });
    const result = { nodes, edges };
    if (graph.viewport !== undefined) {
        const v = graph.viewport;
        if (!object(v) || ![v.x, v.y, v.scale].every(finite) || v.scale <= 0) fail('画布视口无效');
        fields(v, ['x', 'y', 'scale']);
        result.viewport = { x: v.x, y: v.y, scale: v.scale };
    }
    return result;
}
