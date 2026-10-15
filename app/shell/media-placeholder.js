// 媒体兜底占位图(内联 SVG)。
//
// 为什么是内联 SVG,不是 <img src="xxx.svg">:
//   1. 零网络请求 —— 封面取不到的时候再去请求一个占位图,失败路径上又叠一次网络;
//   2. 跟着 currentColor 走,浅色主题也不用再改一份;
//   3. 不受插件资源根 / CSP 限制。
//
// 用在两处:bilibili 没有封面(或封面加载失败)时顶替封面;douyin 图集里
// 某张图取不到时顶替一个格子。样式由调用方给(尺寸/间距两边不一样)。

const NS = 'http://www.w3.org/2000/svg';

/**
 * 画一个"图片"图标:圆角外框 + 太阳 + 山。
 * @param {{label?: string, className?: string}} options
 * @returns {SVGElement}
 */
export function createCoverPlaceholder({ label = '暂无封面', className = 'media-fallback' } = {}) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('class', className);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);

    const frame = document.createElementNS(NS, 'rect');
    frame.setAttribute('x', '5');
    frame.setAttribute('y', '9');
    frame.setAttribute('width', '38');
    frame.setAttribute('height', '30');
    frame.setAttribute('rx', '4');
    frame.setAttribute('fill', 'none');
    frame.setAttribute('stroke', 'currentColor');
    frame.setAttribute('stroke-width', '2');
    frame.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(frame);

    const sun = document.createElementNS(NS, 'circle');
    sun.setAttribute('cx', '17');
    sun.setAttribute('cy', '19');
    sun.setAttribute('r', '3');
    sun.setAttribute('fill', 'currentColor');
    svg.appendChild(sun);

    // 山:两条斜线,底部贴住外框内沿
    const hill = document.createElementNS(NS, 'path');
    hill.setAttribute('d', 'M8 35.5 19.5 24l7 7 5.5-5 8 9.5');
    hill.setAttribute('fill', 'none');
    hill.setAttribute('stroke', 'currentColor');
    hill.setAttribute('stroke-width', '2');
    hill.setAttribute('stroke-linecap', 'round');
    hill.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(hill);

    return svg;
}
