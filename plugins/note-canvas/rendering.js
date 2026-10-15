const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function canvasViewStyles(view = {}, motionScale = 1) {
    const x = finite(view.x, 0), y = finite(view.y, 0), scale = finite(view.scale, 1);
    const visualScale = finite(motionScale, 1) > 0 ? motionScale : 1;
    return {
        worldTransform: `translate(${x}px, ${y}px)`,
        motionTransform: `scale(${visualScale})`,
        backgroundPosition: `${x}px ${y}px`,
        backgroundSize: `${24 * scale}px ${24 * scale}px`,
    };
}

export function screenToWorld(clientX, clientY, rect, view) {
    return {
        x: (clientX - rect.left - view.x) / view.scale,
        y: (clientY - rect.top - view.y) / view.scale,
    };
}
