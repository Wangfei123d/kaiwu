/** 匹配面板只读元信息；实际输入是已完成运行的快照，展开时才读取。 */
export function createSkillPanel({ doc, getState, readInput, renderImages = () => null, onUpdate = () => {} }) {
    const element = doc.createElement('section');
    element.className = 'drama-skill-panel';
    let revision = 0;
    function refresh() {
        const request = ++revision;
        const { candidates = [], match, run } = getState();
        element.replaceChildren();
        const status = doc.createElement('div');
        status.className = 'drama-skill-caption';
        status.textContent = match?.error ? match.error : !match ? '技能 · 待匹配（运行时判断需求）'
            : match.selected.length ? `技能 · 已启用 ${match.selected.length} 项` : '技能 · 未启用，来源保持待命';
        element.append(status);
        for (const candidate of candidates) {
            const selected = match?.selected?.find(item => item.id === candidate.id);
            const row = doc.createElement('div');
            row.className = selected ? 'drama-skill-row active' : 'drama-skill-row dormant';
            row.textContent = selected ? `${candidate.name} · ${selected.reason}\n需求：${selected.evidence}`
                : `${candidate.name} · ${match ? '待命' : '等待判断'}`;
            element.append(row);
        }
        if (run?.skillInput) {
            const details = doc.createElement('details');
            details.className = 'drama-skill-actual';
            const summary = doc.createElement('summary');
            summary.textContent = '上次运行实际输入';
            const note = doc.createElement('div');
            note.className = 'drama-skill-note';
            note.textContent = '历史记录，修改节点或技能后需运行才能更新';
            const content = doc.createElement('pre');
            content.className = 'drama-skill-input';
            details.append(summary, note, content);
            let loaded = false;
            details.addEventListener('toggle', async () => {
                onUpdate();
                if (!details.open || loaded) return;
                loaded = true;
                content.textContent = '加载实际输入…';
                try {
                    const text = await readInput(run.skillInput);
                    if (request !== revision) return;
                    content.textContent = text;
                    const images = renderImages(run.skillInput.images ?? []);
                    if (images) details.append(images);
                } catch {
                    if (request !== revision) return;
                    loaded = false;
                    content.textContent = '实际输入读取失败，请检查输出文件';
                }
                onUpdate();
            });
            element.append(details);
        }
    }
    refresh();
    return { element, refresh };
}
