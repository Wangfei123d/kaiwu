/** Word 拖入时的临时节点。只碰 DOM，不修改 graph 或存档。 */
export function createWordDropPreview({ el, state }) {
    const doc = el.canvas.ownerDocument;
    const outline = doc.createElement('div');
    outline.className = 'drama-drop-preview';
    outline.setAttribute('aria-hidden', 'true');
    outline.hidden = true;

    const heading = doc.createElement('div');
    heading.className = 'drama-drop-preview-head';
    heading.textContent = '文本 / 剧本';
    const name = doc.createElement('div');
    name.className = 'drama-drop-preview-name';
    const note = doc.createElement('div');
    note.className = 'drama-drop-preview-note';
    outline.append(heading, name, note);

    const guides = [0, 1].map(() => {
        const guide = doc.createElement('div');
        guide.className = 'drama-drop-guide';
        guide.setAttribute('aria-hidden', 'true');
        guide.hidden = true;
        el.world.append(guide);
        return guide;
    });
    el.world.append(outline);

    const hideGuides = () => guides.forEach((guide) => { guide.hidden = true; });
    const hide = () => {
        outline.hidden = true;
        hideGuides();
        el.canvas.removeAttribute('data-drop-preview');
    };

    function show(fileName, clientX, clientY) {
        const rect = el.canvas.getBoundingClientRect();
        const scale = state.view.scale || 1;
        const x = (Number(clientX) - rect.left - state.view.x) / scale;
        const y = (Number(clientY) - rect.top - state.view.y) / scale;
        if (!Number.isFinite(x) || !Number.isFinite(y)) { hide(); return; }
        outline.style.left = `${Math.round(x)}px`;
        outline.style.top = `${Math.round(y)}px`;
        name.textContent = String(fileName || 'Word 文件');
        note.textContent = '松开后导入正文';
        outline.hidden = false;
        el.canvas.setAttribute('data-drop-preview', 'word');

        const cx = x + 75;
        const cy = y + 28;
        const nearby = (state.graph?.nodes ?? [])
            .filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y))
            .map((node) => {
                const dx = node.x + 75 - cx;
                const dy = node.y + 28 - cy;
                return { dx, dy, distance: Math.hypot(dx, dy) };
            })
            .filter((point) => point.distance > 0 && point.distance < 440)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, guides.length);
        guides.forEach((guide, index) => {
            const point = nearby[index];
            if (!point) { guide.hidden = true; return; }
            guide.style.left = `${Math.round(cx)}px`;
            guide.style.top = `${Math.round(cy)}px`;
            guide.style.width = `${Math.round(point.distance)}px`;
            guide.style.transform = `rotate(${Math.atan2(point.dy, point.dx)}rad)`;
            guide.hidden = false;
        });
    }

    function reading() {
        if (outline.hidden) return;
        note.textContent = '正在读取 Word 正文…';
        hideGuides();
    }

    function dispose() {
        hide();
        outline.remove();
        guides.forEach((guide) => guide.remove());
    }

    return { show, reading, hide, dispose };
}

