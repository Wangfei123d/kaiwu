export const SKILL_MATCH_VERSION = 'semantic-v1';

/** 候选阶段只暴露用途元信息，不读取或返回正文、图片路径。 */
export function skillCandidates(graph, nodeId) {
    const nodes = new Map((graph?.nodes ?? []).map(node => [node.id, node]));
    if (!['llm', 'image'].includes(nodes.get(nodeId)?.type)) return [];
    const ids = [...new Set((graph.edges ?? []).filter(edge => edge.to === nodeId
        && edge.toPort === 1 && nodes.get(edge.from)?.type === 'skill').map(edge => edge.from))];
    return ids.map(id => {
        const node = nodes.get(id);
        const params = node.params ?? {};
        const incoming = (graph.edges ?? []).filter(edge => edge.to === id);
        return { id, name: String(node.title ?? '技能'), purpose: String(params.purpose ?? ''),
            scenarios: String(params.scenarios ?? ''), exclude: String(params.exclude ?? ''),
            inputTypes: [...new Set(incoming.map(edge => edge.toPort === 1 ? '图片' : '文本')
                .concat(params.value ? ['文本'] : []))] };
    });
}

export function skillMatchKey(prompt, candidates) {
    return JSON.stringify([SKILL_MATCH_VERSION, String(prompt ?? ''), candidates]);
}

export function currentSkillMatch(graph, nodeId) {
    const node = graph?.nodes?.find(node => node.id === nodeId);
    const match = graph?.skillMatches?.[nodeId];
    return match?.key === skillMatchKey(node?.params?.prompt, skillCandidates(graph, nodeId)) ? match : null;
}
