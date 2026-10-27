const SVG_NS = 'http://www.w3.org/2000/svg';

const resultViews = new WeakMap();
const imageViewers = new WeakMap();

function imageViewerFor(doc) {
    let viewer = imageViewers.get(doc);
    if (viewer) return viewer;
    const dialog = doc.createElement('dialog');
    dialog.className = 'agent-image-viewer';
    dialog.setAttribute('aria-label', '生成图片放大预览');
    const shell = doc.createElement('div');
    shell.className = 'agent-image-viewer-shell';
    const bar = doc.createElement('div');
    bar.className = 'agent-image-viewer-bar';
    const title = doc.createElement('span');
    title.className = 'agent-image-viewer-title';
    title.textContent = '生成图片';
    const zoomLabel = doc.createElement('span');
    zoomLabel.className = 'agent-image-viewer-zoom';
    zoomLabel.setAttribute('aria-live', 'polite');
    const tool = (label, ariaLabel, action) => {
        const button = doc.createElement('button');
        button.className = 'agent-image-viewer-tool';
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-label', ariaLabel);
        button.title = ariaLabel;
        button.addEventListener('click', action);
        return button;
    };
    const original = doc.createElement('a');
    original.className = 'agent-image-viewer-tool agent-image-viewer-original';
    original.textContent = '打开原图';
    original.setAttribute('target', '_blank');
    original.setAttribute('rel', 'noreferrer');
    original.setAttribute('aria-label', '在新窗口打开原图');
    const close = tool('×', '关闭图片预览', () => dialog.close());
    close.classList.add('agent-image-viewer-close');
    bar.append(title, zoomLabel, original,
        tool('−', '缩小', () => setZoom(viewer, viewer.zoom / 1.2)),
        tool('＋', '放大', () => setZoom(viewer, viewer.zoom * 1.2)),
        tool('适配', '适配窗口', () => resetZoom(viewer)), close);
    const stage = doc.createElement('div');
    stage.className = 'agent-image-viewer-stage';
    stage.setAttribute('aria-label', '可拖动查看图片');
    const image = doc.createElement('img');
    image.className = 'agent-image-viewer-image';
    image.draggable = false;
    const hint = doc.createElement('span');
    hint.className = 'agent-image-viewer-hint';
    hint.textContent = '滚轮缩放 · 拖动查看 · Esc 关闭';
    stage.append(image, hint);
    shell.append(bar, stage);
    dialog.appendChild(shell);
    doc.body.appendChild(dialog);
    viewer = { dialog, image, stage, zoomLabel, original, zoom: 1, x: 0, y: 0, drag: null, trigger: null };
    imageViewers.set(doc, viewer);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
        const trigger = viewer.trigger;
        viewer.trigger = null;
        if (trigger?.isConnected) trigger.focus?.({ preventScroll: true });
    });
    stage.addEventListener('wheel', event => {
        event.preventDefault();
        setZoom(viewer, viewer.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    stage.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        viewer.drag = { x: event.clientX, y: event.clientY, ox: viewer.x, oy: viewer.y };
        stage.classList.add('is-dragging');
        stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', event => {
        if (!viewer.drag) return;
        viewer.x = viewer.drag.ox + event.clientX - viewer.drag.x;
        viewer.y = viewer.drag.oy + event.clientY - viewer.drag.y;
        paintViewer(viewer);
    });
    const endDrag = () => {
        viewer.drag = null;
        stage.classList.remove('is-dragging');
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    return viewer;
}

function paintViewer(viewer) {
    viewer.image.style.transform = `translate3d(${viewer.x}px,${viewer.y}px,0) scale(${viewer.zoom})`;
    viewer.zoomLabel.textContent = `${Math.round(viewer.zoom * 100)}%`;
}

function setZoom(viewer, value) {
    viewer.zoom = Math.max(.5, Math.min(5, value));
    paintViewer(viewer);
}

function resetZoom(viewer) {
    viewer.zoom = 1;
    viewer.x = 0;
    viewer.y = 0;
    paintViewer(viewer);
}

function openImageViewer({ doc, url, alt, trigger }) {
    const viewer = imageViewerFor(doc);
    viewer.trigger = trigger;
    viewer.image.src = url;
    viewer.image.alt = alt || '生成图片放大预览';
    viewer.original.href = url;
    resetZoom(viewer);
    if (!viewer.dialog.open) viewer.dialog.showModal();
    else viewer.dialog.focus?.();
}

/** 面板卸载时移除按需创建的文档级大图层。 */
export function disposeImageGenerationViewer(doc) {
    const viewer = imageViewers.get(doc);
    if (!viewer) return;
    if (viewer.dialog.open) viewer.dialog.close();
    viewer.dialog.remove();
    imageViewers.delete(doc);
}

function landscapeLayer(doc, name, paths) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `agent-generation-layer ${name}`);
    svg.setAttribute('viewBox', '0 0 360 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('focusable', 'false');
    for (const [d, className, fill] of paths) {
        const path = doc.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        if (className) path.setAttribute('class', className);
        if (fill) path.setAttribute('fill', fill);
        svg.appendChild(path);
    }
    return svg;
}

/** D 分层视差：固定等待图形，挂在工具折叠组外，不代表服务中间结果。 */
export function createImageGenerationPreview({ doc, toolCallId }) {
    const preview = doc.createElement('div');
    preview.className = 'agent-image-generation';
    preview.setAttribute('data-tool-call-id', toolCallId);
    preview.setAttribute('role', 'status');
    preview.setAttribute('aria-live', 'polite');
    preview.setAttribute('aria-atomic', 'true');
    preview.setAttribute('data-state', 'generating');
    const scene = doc.createElement('div');
    scene.className = 'agent-generation-scene';
    scene.setAttribute('aria-hidden', 'true');
    const sky = doc.createElement('div');
    sky.className = 'agent-generation-sky';
    const back = landscapeLayer(doc, 'agent-generation-back', [
        ['M0 70L62 30l40 32 62-46 58 49 46-34 92 40v29H0z'],
        ['M0 70L62 30l40 32 62-46 58 49 46-34 92 40', 'agent-generation-contour'],
    ]);
    const middle = landscapeLayer(doc, 'agent-generation-middle', [
        ['M0 49l56 28 54-42 49 37 58-48 56 38 48-18 39 23v33H0z'],
        ['M0 49l56 28 54-42 49 37 58-48 56 38 48-18 39 23', 'agent-generation-contour'],
        ['M236 53V8h18v45M231 8h28l-14-17z', '', '#94b4ca'],
    ]);
    const front = landscapeLayer(doc, 'agent-generation-front', [
        ['M0 38q45 15 84 0t86 1 88-2 102 8v55H0z'],
        ['M0 38q45 15 84 0t86 1 88-2 102 8', 'agent-generation-contour'],
    ]);
    const light = doc.createElement('i');
    light.className = 'agent-generation-light';
    scene.append(sky, back, middle, front, light);
    const caption = doc.createElement('span');
    caption.className = 'agent-generation-caption';
    caption.textContent = '正在生成图片';
    preview.append(scene, caption);
    resultViews.set(preview, { scene, caption, records: new Map(), results: null, aspectRatio: null });
    return preview;
}

function setAspectRatio(preview, state, value) {
    const ratio = Number(value);
    if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 10) return;
    state.aspectRatio = ratio;
    preview.style?.setProperty?.('--agent-image-ratio', String(ratio));
}

/** 保留同一个框；图片加载成功后才收起等待动画。 */
export function showGeneratedImages({ doc, preview, images, aspectRatio = null }) {
    const state = resultViews.get(preview);
    if (!state) return;
    if (aspectRatio !== null && aspectRatio !== undefined) setAspectRatio(preview, state, aspectRatio);
    const urls = new Set(images.map(image => image.url));
    for (const [url, record] of state.records) {
        if (urls.has(url)) continue;
        record.link.parentNode?.removeChild(record.link);
        state.records.delete(url);
    }
    function refresh() {
        const records = [...state.records.values()];
        const ready = records.some(record => record.state === 'ready');
        const loading = records.some(record => record.state === 'loading');
        const status = ready ? 'ready' : loading ? 'loading' : records.length ? 'error' : 'generating';
        preview.setAttribute('data-state', status);
        preview.setAttribute('aria-busy', String(status === 'loading' || status === 'generating'));
        state.scene.hidden = status === 'ready' || status === 'error';
        state.caption.hidden = ready;
        state.caption.textContent = status === 'error' ? '图片加载失败，双击打开原图入口'
            : status === 'loading' ? '正在载入图片' : '正在生成图片';
        if (state.results) state.results.hidden = records.length === 0;
    }
    for (const result of images) {
        if (state.records.has(result.url)) continue;
        if (!state.results) {
            state.results = doc.createElement('div');
            state.results.className = 'agent-generation-results';
            preview.appendChild(state.results);
        }
        const link = doc.createElement('a');
        link.className = 'agent-generation-result';
        link.setAttribute('href', result.url);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noreferrer');
        link.setAttribute('role', 'button');
        link.setAttribute('title', '双击放大图片');
        link.setAttribute('aria-label', '双击放大生成图片');
        link.setAttribute('aria-haspopup', 'dialog');
        link.addEventListener('click', event => {
            event.preventDefault();
            if (event.detail === 0 && !imageViewers.get(doc)?.dialog.open) {
                openImageViewer({ doc, url: result.url, alt: result.alt, trigger: link });
            }
        });
        link.addEventListener('dblclick', event => {
            event.preventDefault();
            openImageViewer({ doc, url: result.url, alt: result.alt, trigger: link });
        });
        link.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openImageViewer({ doc, url: result.url, alt: result.alt, trigger: link });
        });
        const image = doc.createElement('img');
        image.setAttribute('alt', result.alt || '生成的图片');
        image.hidden = true;
        const record = { link, image, state: 'loading' };
        state.records.set(result.url, record);
        image.addEventListener('load', () => {
            if (state.records.get(result.url) !== record) return;
            if (state.aspectRatio === null && image.naturalWidth > 0 && image.naturalHeight > 0) {
                setAspectRatio(preview, state, image.naturalWidth / image.naturalHeight);
            }
            record.state = 'ready';
            image.hidden = false;
            refresh();
        });
        image.addEventListener('error', () => {
            if (state.records.get(result.url) !== record) return;
            record.state = 'error';
            refresh();
        });
        link.appendChild(image);
        state.results.appendChild(link);
        image.setAttribute('src', result.url);
    }
    refresh();
}
