/** Add a focused instruction only when the user explicitly asks to create a reusable Skill. */
export function skillCreationInstruction(question) {
    const text = typeof question === 'string' ? question : '';
    if (!/(skill|技能)/i.test(text) || !/(创建|新建|建立|编写|制作|生成|沉淀|保存|更新|修改)/.test(text)) return '';
    return [
        '开物 Skill 约定：用户明确要求创建或更新可复用 Skill。请把最终技能写入当前工作区 `.agents/skills/<小写-kebab-name>/SKILL.md`，使用 YAML frontmatter，至少包含 `name` 与 `description`；正文写可复用的步骤、约束和输出格式，不要把本次任务的临时内容写成通用规则。若写入需要授权，先请求授权并等待。完成后确认文件与 frontmatter 有效，再向用户简要说明技能名称和用途。',
    ].join('\n');
}
