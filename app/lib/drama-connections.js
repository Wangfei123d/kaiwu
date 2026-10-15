/** 将新边的显式端口与旧图的顺序入边映射到同一组输入槽。 */
export function inputEdges(graph, nodeId, inputCount) {
    return inputEdgeGroups(graph, nodeId, inputCount).map((group) => group[0] ?? null);
}

/** 每个端口返回一组入边；汇聚端口按图中的连入顺序保留所有来源。 */
export function inputEdgeGroups(graph, nodeId, inputCount, multipleInputs = []) {
    const slots = Array.from({ length: Math.max(0, inputCount) }, () => []);
    const multiple = new Set(multipleInputs);
    const edges = (graph?.edges ?? []).filter((edge) => edge.to === nodeId);
    for (const edge of edges) {
        if (Number.isInteger(edge.toPort) && edge.toPort >= 0 && edge.toPort < slots.length) {
            if (multiple.has(edge.toPort) || slots[edge.toPort].length === 0) slots[edge.toPort].push(edge);
        }
    }
    for (const edge of edges) {
        if (Number.isInteger(edge.toPort)) continue;
        const index = slots.findIndex((slot, i) => multiple.has(i) || slot.length === 0);
        if (index !== -1) slots[index].push(edge);
    }
    const positions = new Map(edges.map((edge, index) => [edge, index]));
    for (const group of slots) group.sort((a, b) => positions.get(a) - positions.get(b));
    return slots;
}

/** 不修改图；返回可添加的边，或适合直接显示给用户的拒绝原因。 */
export function validateConnection(graph, types, from, fromPort, to, toPort) {
    const fail = (reason) => ({ ok: false, reason });
    const source = graph?.nodes?.find((node) => node.id === from);
    const target = graph?.nodes?.find((node) => node.id === to);
    if (!source || !target) return fail('节点不存在');
    if (from === to) return fail('不能连接节点自身');
    const sourceType = types.find((type) => type.id === source.type);
    const targetType = types.find((type) => type.id === target.type);
    const output = sourceType?.outputs?.[fromPort];
    const input = targetType?.inputs?.[toPort];
    if (!Number.isInteger(fromPort) || output === undefined) return fail('输出端口不存在');
    if (!Number.isInteger(toPort) || input === undefined) return fail('输入端口不存在');
    if (output !== input) return fail('端口类型不匹配');
    const incoming = inputEdgeGroups(graph, to, targetType.inputs.length, targetType.multipleInputs)[toPort];
    if (incoming.some((edge) => edge.from === from && (edge.fromPort ?? 0) === fromPort)) {
        return fail('连线已存在');
    }
    if (incoming.length > 0 && !targetType.multipleInputs?.includes(toPort)) return fail('输入端口已有连线');
    const visited = new Set();
    const pending = [to];
    while (pending.length > 0) {
        const id = pending.pop();
        if (id === from) return fail('连接会形成环');
        if (visited.has(id)) continue;
        visited.add(id);
        for (const edge of graph.edges ?? []) if (edge.from === id) pending.push(edge.to);
    }
    return { ok: true, edge: { from, fromPort, to, toPort } };
}
