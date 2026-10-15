/** Convert a client-space pointer position to the drama world's coordinates. */
export function clientToWorldPoint({ clientX, clientY, canvasRect, view = {} }) {
    const scale = Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1;
    return {
        x: (clientX - canvasRect.left - (Number(view.x) || 0)) / scale,
        y: (clientY - canvasRect.top - (Number(view.y) || 0)) / scale,
    };
}

/** Build a positive-size rectangle from two points, independent of drag direction. */
export function normalizeSelectionRect(start, end) {
    return {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
    };
}

/** Return IDs of node boxes that touch or overlap a normalized selection rectangle. */
export function intersectingNodeIds(rect, nodes) {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    return nodes
        .filter((node) => rect.x <= node.x + node.width
            && right >= node.x
            && rect.y <= node.y + node.height
            && bottom >= node.y)
        .map((node) => node.id);
}

/** Replace the selection, or merge marquee hits into it for Shift-drag. */
export function applyMarqueeSelection(currentIds, hitIds, { additive = false } = {}) {
    return additive ? new Set([...currentIds, ...hitIds]) : new Set(hitIds);
}

/** Keep current selection on cancellation, clear on a click, or apply drag hits. */
export function finishMarqueeSelection(currentIds, hitIds, { moved = false, cancelled = false, additive = false } = {}) {
    if (cancelled) return new Set(currentIds);
    if (!moved) return new Set();
    return applyMarqueeSelection(currentIds, hitIds, { additive });
}
