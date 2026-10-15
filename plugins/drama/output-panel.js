/** 文本生成节点的输出视图。全文由调用方提供，这里只管安全渲染与预览/源码切换。 */
export function createDramaOutputPanel({
    doc, text = '', renderMarkdownNodes, initialMode = 'preview', onModeChange = () => {},
}) {
    const panel = doc.createElement('div');
    panel.className = 'drama-output-panel';

    const head = doc.createElement('div');
    head.className = 'drama-output-head';
    const label = doc.createElement('span');
    label.className = 'drama-output-label';
    label.textContent = '生成结果';
    const status = doc.createElement('span');
    status.className = 'drama-output-status';
    status.textContent = 'Markdown';

    const tabs = doc.createElement('div');
    tabs.className = 'drama-output-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '生成结果显示方式');
    const previewTab = doc.createElement('button');
    previewTab.type = 'button';
    previewTab.className = 'drama-output-tab drama-output-preview-tab';
    previewTab.setAttribute('role', 'tab');
    previewTab.textContent = '预览';
    const sourceTab = doc.createElement('button');
    sourceTab.type = 'button';
    sourceTab.className = 'drama-output-tab drama-output-source-tab';
    sourceTab.setAttribute('role', 'tab');
    sourceTab.textContent = '源码';
    tabs.append(previewTab, sourceTab);
    head.append(label, status, tabs);

    const scroll = doc.createElement('div');
    scroll.className = 'drama-output-scroll';
    const preview = doc.createElement('div');
    preview.className = 'drama-output-markdown';
    const source = doc.createElement('pre');
    source.className = 'drama-output-source';
    scroll.append(preview, source);
    panel.append(head, scroll);

    const setText = (value) => {
        const raw = String(value ?? '');
        preview.replaceChildren(...renderMarkdownNodes(doc, raw, { tables: true }));
        source.textContent = raw;
    };
    const setMode = (value, notify = false) => {
        const mode = value === 'source' ? 'source' : 'preview';
        preview.hidden = mode !== 'preview';
        source.hidden = mode !== 'source';
        previewTab.setAttribute('aria-selected', String(mode === 'preview'));
        sourceTab.setAttribute('aria-selected', String(mode === 'source'));
        if (notify) onModeChange(mode);
    };
    previewTab.addEventListener('click', () => setMode('preview', true));
    sourceTab.addEventListener('click', () => setMode('source', true));
    setText(text);
    setMode(initialMode);

    return {
        element: panel,
        setText,
        setStatus: (value) => { status.textContent = value; },
    };
}
