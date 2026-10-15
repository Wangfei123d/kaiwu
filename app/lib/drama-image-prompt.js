/** 拼装完整提示词，界面预览和执行器共用；只跳过空内容，不截断正文。 */
export function buildImagePrompt(prompt, inputs = [], sourceTitles = []) {
    const sections = [];
    const local = String(prompt ?? '').trim();
    if (local) sections.push({ title: '节点提示词', text: local });
    inputs.forEach((input, index) => {
        const content = String(input ?? '').trim();
        if (content) sections.push({ title: String(sourceTitles[index] ?? '').trim() || `上游内容 ${index + 1}`, text: content });
    });
    if (sections.length === 1) return sections[0].text;
    return sections.map((section) => `【${section.title}】\n${section.text}`).join('\n\n');
}
