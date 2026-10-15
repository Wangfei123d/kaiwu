import { skillCandidates, skillMatchKey } from '../../../app/lib/drama-skills.js';
import { createSkillMatcher, validateSkillSelection } from './skill-matcher.js';

/** 分析可达接收端需求后扩展依赖；未选技能边不进入执行拓扑。 */
export async function planSkillExecution(graph, target, force, options, topoOrder) {
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    if (target && !byId.has(target)) throw new Error(`没有这个节点:${target}`);
    if (target && byId.get(target).type === 'skill') return [];
    const roots = target ? [target] : graph.nodes.filter(node => node.type !== 'skill'
        && !(graph.edges ?? []).some(edge => edge.from === node.id && byId.has(edge.to))).map(node => node.id);
    const skillEdges = (graph.edges ?? []).filter(edge => byId.get(edge.from)?.type === 'skill');
    const effective = { ...graph, edges: (graph.edges ?? []).filter(edge => byId.get(edge.from)?.type !== 'skill') };
    const processed = new Set();
    const match = options.matchSkills ?? createSkillMatcher({ generateText: options.generateText });
    graph.skillMatches = { ...graph.skillMatches };
    let order;
    while (true) {
        order = [...new Map(roots.flatMap(root => topoOrder(effective, root)).map(node => [node.id, node])).values()];
        const receivers = order.filter(node => ['llm', 'image'].includes(node.type) && !processed.has(node.id));
        if (receivers.length === 0) break;
        for (const node of receivers) {
            processed.add(node.id);
            const candidates = skillCandidates(graph, node.id);
            if (candidates.length === 0) {
                delete graph.skillMatches[node.id];
                continue;
            }
            const prompt = String(node.params?.prompt ?? '');
            const key = skillMatchKey(prompt, candidates);
            let result;
            try {
                const previous = graph.skillMatches[node.id];
                if (!force && previous?.key === key && !previous.error) {
                    result = validateSkillSelection(previous, prompt, candidates);
                } else {
                    options.onNodeStatus?.({ nodeId: node.id, status: 'running' });
                    result = validateSkillSelection(await match({ prompt, candidates }), prompt, candidates);
                }
            } catch (error) {
                const message = `技能匹配失败：${error?.message ?? error}`;
                graph.skillMatches[node.id] = { key, prompt, candidates, selected: [], error: message, at: Date.now() };
                const failure = new Error(message);
                failure.nodeId = node.id;
                throw failure;
            }
            graph.skillMatches[node.id] = { key, prompt, candidates, ...result, at: Date.now() };
            try { options.onSkillMatch?.({ nodeId: node.id, skillMatch: graph.skillMatches[node.id] }); } catch { /* 界面通知不改变执行 */ }
            const selected = new Set(result.selected.map(item => item.id));
            effective.edges.push(...skillEdges.filter(edge => edge.to === node.id && edge.toPort === 1 && selected.has(edge.from)));
        }
    }
    return order;
}
