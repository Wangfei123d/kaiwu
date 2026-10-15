// 内建图标集。清单里的 icon 要么命中这里的名字,要么被当作单个 emoji/字形
// 直接渲染(见设计文档 §6.6)。
// 用字形而不是图片:省一次文件请求,也不需要给每个插件准备资源。
const GLYPHS = {
    palette: '🎨',
    music: '♪',
    image: '🖼',
    subtitle: '💬',
    download: '⬇',
    video: '🎬',
    sparkle: '✦',
    // 两个解析工具用不同图标 —— 都给 download 的话侧边栏里两行长得一样
    douyin: '🎵',
    bilibili: '📺',
};

export function iconGlyph(icon) {
    if (typeof icon !== 'string' || icon === '') return '•';
    return GLYPHS[icon] ?? icon;
}
