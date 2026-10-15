/** 按需读取上游全文；预览只读取内容，不触发文本或图片生成。 */
export function createImagePromptPreview({ doc, getPrompt, readSources, buildPrompt, onUpdate = () => {} }) {
    const element = doc.createElement('details');
    element.className = 'drama-image-prompt';
    const summary = doc.createElement('summary');
    summary.textContent = '最终提示词预览';
    const status = doc.createElement('div');
    status.className = 'drama-image-prompt-status';
    status.setAttribute('aria-live', 'polite');
    const content = doc.createElement('pre');
    content.className = 'drama-image-prompt-content';
    element.append(summary, status, content);
    let revision = 0;

    async function refresh() {
        if (!element.open) return;
        const request = ++revision;
        status.textContent = '读取上游内容…';
        try {
            const sources = await readSources();
            if (request !== revision || !element.open) return;
            content.textContent = buildPrompt(getPrompt(), sources.map((source) => source.text),
                sources.map((source) => source.title)) || '提示词为空';
            const pending = sources.filter((source) => source.pending).length;
            const included = sources.filter((source) => String(source.text ?? '').trim() !== '').length;
            const empty = sources.filter((source) => !source.pending && String(source.text ?? '').trim() === '').length;
            status.textContent = pending > 0
                ? `${pending} 个上游尚未完成运行；运行时将读取最新内容`
                : `已合并 ${included} 个来源${empty > 0 ? ` · 跳过 ${empty} 个空内容` : ''}`;
        } catch {
            if (request !== revision || !element.open) return;
            content.textContent = '';
            status.textContent = '上游内容读取失败，请检查来源节点';
        }
        onUpdate();
    }
    element.addEventListener('toggle', () => {
        onUpdate();
        if (element.open) void refresh();
        else revision += 1;
    });
    return { element, refresh };
}
