/**
 * Snap a moving group box to nearby node edges/centres, then to the visible canvas grid.
 * All box coordinates are world coordinates; gridStep and tolerance are CSS screen pixels.
 */
export function snapBoxToCanvas({ box, anchors = [], view = {}, gridStep = 22, tolerance = 10 }) {
    const scale = Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1;
    const step = Number.isFinite(gridStep) && gridStep > 0 ? gridStep : 22;
    const threshold = Math.max(0, Number(tolerance) || 0) / scale;
    const validAnchors = anchors.filter((anchor) =>
        Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
        && Number.isFinite(anchor.width) && Number.isFinite(anchor.height));

    const findGuide = (axis, origin, extent) => {
        const offsets = [0, extent / 2, extent];
        let best = null;
        for (const anchor of validAnchors) {
            const anchorOrigin = axis === 'x' ? anchor.x : anchor.y;
            const anchorExtent = axis === 'x' ? anchor.width : anchor.height;
            const targets = [anchorOrigin, anchorOrigin + anchorExtent / 2, anchorOrigin + anchorExtent];
            for (const target of targets) {
                for (const offset of offsets) {
                    const delta = target - (origin + offset);
                    const distance = Math.abs(delta);
                    if (distance <= threshold && (best === null || distance < best.distance)) {
                        best = { delta, distance, coordinate: target };
                    }
                }
            }
        }
        return best;
    };

    const snapAxis = (axis, origin, extent) => {
        const guide = findGuide(axis, origin, extent);
        if (guide !== null) {
            return { position: origin + guide.delta, guide: guide.coordinate, grid: false };
        }
        const offset = axis === 'x' ? (Number(view.x) || 0) : (Number(view.y) || 0);
        const screenPosition = offset + origin * scale;
        const snappedScreenPosition = Math.round(screenPosition / step) * step;
        return { position: (snappedScreenPosition - offset) / scale, guide: null, grid: true };
    };

    const x = snapAxis('x', box.x, box.width);
    const y = snapAxis('y', box.y, box.height);
    return {
        x: x.position,
        y: y.position,
        guideX: x.guide,
        guideY: y.guide,
        gridX: x.grid,
        gridY: y.grid,
    };
}

/** Move a set of nodes by the same snapped offset, preserving their relative layout. */
export function snapGroupPositions({ nodes, anchors = [], view = {}, gridStep = 22, tolerance = 10 }) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return { positions: [], x: 0, y: 0, guideX: null, guideY: null, gridX: false, gridY: false };
    }
    const left = Math.min(...nodes.map((node) => node.x));
    const top = Math.min(...nodes.map((node) => node.y));
    const right = Math.max(...nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));
    const result = snapBoxToCanvas({
        box: { x: left, y: top, width: right - left, height: bottom - top },
        anchors, view, gridStep, tolerance,
    });
    const dx = result.x - left;
    const dy = result.y - top;
    return {
        ...result,
        positions: nodes.map((node) => ({ id: node.id, x: node.x + dx, y: node.y + dy })),
    };
}
