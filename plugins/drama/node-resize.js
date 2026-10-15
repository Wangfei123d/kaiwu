/** Resize a graph-space node box from one edge or corner using client-space motion. */
export function resizeNodeBox({
    box, direction, clientDx, clientDy, scale = 1, minWidth = 150, minHeight = 92,
}) {
    const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const dx = clientDx / zoom;
    const dy = clientDy / zoom;
    const widthFloor = Math.max(1, Math.ceil(minWidth));
    const heightFloor = Math.max(1, Math.ceil(minHeight));
    let x = Math.round(box.x);
    let y = Math.round(box.y);
    let width = Math.round(box.width);
    let height = Math.round(box.height);

    if (direction.includes('w')) {
        width = Math.max(widthFloor, Math.round(box.width - dx));
        x = Math.round(box.x + box.width) - width;
    } else if (direction.includes('e')) {
        width = Math.max(widthFloor, Math.round(box.width + dx));
    }
    if (direction.includes('n')) {
        height = Math.max(heightFloor, Math.round(box.height - dy));
        y = Math.round(box.y + box.height) - height;
    } else if (direction.includes('s')) {
        height = Math.max(heightFloor, Math.round(box.height + dy));
    }

    return { x, y, width, height };
}

/** Keep invisible resize hit areas the same size in client pixels at every zoom. */
export function resizeHitSizes(scale) {
    const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return { edge: 8 / zoom, corner: 12 / zoom };
}
