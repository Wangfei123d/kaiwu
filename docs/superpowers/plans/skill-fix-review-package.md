# Final fix review package

Read current files if more context is needed. No commits were created; this supplemental current-state package follows the three findings in skill-final-review.md and fix contract skill-final-fix-brief.md.

# 技能节点最终审查修复报告

## 范围与结果

完成三项审查修复：提交前保存并登记实际技能输入，运行中通知界面并在生成失败后保留；完整输入独立采用 16 MiB 上限，超过上限在调用适配器前明确拒绝；跨技能按项目文件名首次出现顺序去重参考图，快照图片列表与实际发送顺序一致。不同文件即使字节相同也不会合并，各技能全文及原有指纹继续保留。

修改文件：`electron/drama/lib/core.js`、`electron/drama/drama-ipc.js`、`plugins/drama/index.js`、`tests/drama-skill-execution.test.js`、`tests/drama-ipc.test.js`、`tools/check-skill-canvas.cjs`。本报告是额外文档输出。保留已有脏工作区内容，没有 Git 提交，没有真实模型调用。

## TDD 红灯

先加入提交回调内读取已登记完整输入、失败保留、scoped inputReady、超过 2 MiB 读取、超过 16 MiB 拒绝以及两个技能共享四个文件的回归断言，再运行：

```powershell
Set-Location E:/project/kaiwu
node --test tests/drama-skill-execution.test.js tests/drama-ipc.test.js
```

退出码 1：43 项，38 通过，5 个预期失败。inputReady 未发送；适配器内没有 skillInput；超过 16 MiB 的输入仍提交成功；四个共享文件被计为八张而拒绝。大输入测试在进入 reader 前就暴露未登记快照的缺陷。随后实现同一修复波次。

## 绿灯与最终验证

第一次实现后同一 Node 命令退出码 0，43/43 通过。追加已有行为的待命正文缓存回归，以及画布运行中预览和旧生成图保留断言后最终运行：

```powershell
Set-Location E:/project/kaiwu
node --test tests/drama-skill-execution.test.js tests/drama-ipc.test.js
node tools/check-skill-canvas.cjs
```

Node 退出码 0：44 项全部通过，0 失败、0 跳过。画布退出码 0：参考图导入、端口、拖线、编辑标题、过期匹配、实时激活、运行中实际输入懒读、生成扫光保留、再次运行保留上轮生成图、145px 实际参考图、至少 88px 生成图、内滚动隔离均通过。完整输入在夹具生成 Promise 释放前即可展开读取；完成后复用全文读取缓存。

```powershell
Set-Location E:/project/kaiwu
git diff --check -- electron/drama/lib/core.js electron/drama/drama-ipc.js plugins/drama/index.js tests/drama-skill-execution.test.js tests/drama-ipc.test.js tools/check-skill-canvas.cjs
```

退出码 0，无 whitespace 错误；Git 对四个现有文件提示以后触碰时 LF 转 CRLF，未做额外格式转换。

画布调试曾出现运行中 active 行超时。原因是原夹具 `run` 使用位置参数，但实际插件传入对象，导致夹具事件没有正确 runId；原先完成后渲染掩盖了问题。改为 `run: async ({runId})` 后运行中事件真实进入受 scoped 限制的处理器，所有断言通过。此超时是夹具问题，不是新的生产逻辑失败。

## 具体实现与限制

核心导出共享 `MAX_SKILL_INPUT_BYTES`。仅有选中技能的 llm/image 接收节点创建完整输入快照；UTF-8 字节超过 16 MiB 报错且不会调用适配器。文件写入与 graph.runs 登记均先于 onNodeInput 和适配器。running/failed/ok 记录保留本轮 skillInput。普通无技能流程不增加快照。IPC 为已登记 skillInput 文件采用共享上限，普通输出仍为 2 MB，原文件格式和登记检查保持。

inputReady 界面分支只合并 run 并刷新技能反馈，提前返回，避免移除 generating 集合、停止扫光或重建清空旧生成画廊。根任务已有标题编辑、画廊选择器和最小高度边距计算保持。

验证均为本地替身或隔离 Playwright，未声称真实提供方兼容性。未重复运行整个不变适配器测试或全部套件。快照仍保留原历史标签；当前运行时能读取的是该次已准备、即将提交的完整输入。现有未注册旧快照文件的清理策略不属于本次范围。
### core final input lifecycle
    }

    let ran = 0;
    let cached = 0;
    for (const node of order) {
        const type = typeOf(node.type);
        const ups = incomingOf.get(node.id) ?? [];
        const ins = ups.map((from) => from ? outputs.get(from) : undefined);
        const selected = graph.skillMatches?.[node.id]?.selected ?? [];
        const bundles = selected.map(item => skillData.get(item.id));
        let images = [];
        let skillText = '';
        let skillFiles = [];
        let resourceSignature = '';
        try {
            if (bundles.some(bundle => !bundle)) throw new Error('已选技能未完成读取，请检查技能连线');
            const seenFiles = new Set();
            for (const bundle of bundles) {
                bundle.files.forEach((file, index) => {
                    if (seenFiles.has(file)) return;
                    seenFiles.add(file);
                    skillFiles.push(file);
                    images.push(bundle.images[index]);
                });
            }
            if (type?.id === 'image-input') resourceSignature = readProjectImages(projectDir(project), node.params?.files ?? []).signature;
            if (type?.id === 'skill') {
                skillText = [text(node.params?.value).trim(), ...ins.map((value, index) => {
                    const full = text(value).trim();
                    return full ? `【${sourceTitles.get(ups[index])}】\n${full}` : '';
                })].filter(Boolean).join('\n\n');
                skillFiles = (inputGroups.get(node.id)?.[1] ?? []).flatMap(edge => graph.runs?.[edge.from]?.media ?? []);
                const resources = readProjectImages(projectDir(project), skillFiles);
                if (!skillText && resources.images.length === 0) throw new Error('技能内容为空，请连入文本或图片');
                resourceSignature = `${skillText}\0${resources.signature}`;
                skillData.set(node.id, { text: skillText, ...resources });
            } else if (['llm', 'image'].includes(type?.id) && graph.skillMatches?.[node.id]) {
                const admitted = admitImagePayload(images);
                if (!admitted.ok) throw new Error(`技能参考图片无法发送：${admitted.reason}`);
                images = admitted.images;
                resourceSignature = JSON.stringify([graph.skillMatches[node.id].key,
                    selected.map(item => item.id), bundles.map(bundle => [bundle.text, bundle.signature])]);
            }
        } catch (error) {
            graph.runs[node.id] = { status: 'failed', error: text(error.message), at: Date.now() };
            writeGraph(project, graph);
            try { options.onNodeStatus?.({ nodeId: node.id, status: 'failed' }); } catch { /* 界面通知不改变执行 */ }
            return `失败于「${node.title ?? node.id}」:${error.message}`;
        }
        const skillSections = bundles.map((bundle, index) => bundle.text
            ? `【技能 · ${sourceTitles.get(selected[index].id)}】\n${bundle.text}` : '').filter(Boolean);
        const textSource = type?.id === 'llm' ? [text(ins[0]), ...skillSections].filter(Boolean).join('\n\n') : undefined;
        const ordinaryPrompt = type?.id === 'image'
            ? buildImagePrompt(node.params?.prompt, ins, ups.map((from) => sourceTitles.get(from))) : '';
        const imagePrompt = [ordinaryPrompt, ...skillSections].filter(Boolean).join('\n\n');
        const fp = fingerprint(node, [...ups.map((from) => from ? hashes.get(from) : undefined),
            ...selected.map(item => hashes.get(item.id))], options.imageSignature, imagePrompt, resourceSignature);
        const prev = graph.runs?.[node.id];
        // 上一轮是 ok 或 cached 都算"已有可用结果"。这里**必须**把 cached 也算上:
        // 否则"跑一次 → 全 cached → 再跑一次"会把所有节点重新执行一遍 ——
        // 对出图节点就是**重新生成、重复花钱**,而且状态看起来还正常,极难发现。
        const cachedFile = type?.id === 'llm' && typeof prev?.file === 'string'
            ? path.resolve(projectDir(project), prev.file) : null;
        const canReuse = type?.id !== 'skill' && (type?.id !== 'llm' || (cachedFile !== null
            && cachedFile.startsWith(path.resolve(projectDir(project), 'outputs') + path.sep)
            && fs.existsSync(cachedFile)));
        if (!force && canReuse && prev !== undefined && (prev.status === 'ok' || prev.status === 'cached') && prev.fp === fp) {
            outputs.set(node.id, type?.id === 'llm' ? fs.readFileSync(cachedFile, 'utf8')
                : type?.id === 'text' ? readTextContainer(node, project).text
                    : type?.id === 'template' ? text(fill(node.params?.template, ins)) : prev.output);
            hashes.set(node.id, fp);
            graph.runs[node.id] = { ...prev, status: 'cached', at: Date.now() };
            graph = writeGraph(project, graph);
            cached += 1;
            continue;
        }
        if (type === undefined) {
            graph.runs[node.id] = { status: 'failed', error: `未知节点类型:${node.type}`, at: Date.now() };
            writeGraph(project, graph);
            return `失败于「${node.title ?? node.id}」:未知节点类型 ${node.type}`;
        }
        graph.runs[node.id] = { status: 'running', at: Date.now(), fp };
        graph = writeGraph(project, graph);
        if (type.id === 'llm' || type.id === 'image') {
            try { options.onNodeStatus?.({ nodeId: node.id, status: 'running' }); } catch { /* 进度通知不能中断生成 */ }
        }
        const t0 = Date.now();
        let skillInput;
        try {
            if (['llm', 'image'].includes(type.id) && selected.length > 0) {
                const inputText = type.id === 'image' ? imagePrompt : `【用户提示词】\n${node.params?.prompt ?? ''}\n\n${textSource}`;
                if (Buffer.byteLength(inputText, 'utf8') > MAX_SKILL_INPUT_BYTES) {
                    throw new Error('实际技能输入超过 16 MiB 上限，已拒绝提交');
                }
                const outputDir = path.join(projectDir(project), 'outputs');
                fs.mkdirSync(outputDir, { recursive: true });
                const file = `${randomUUID()}.txt`;
                fs.writeFileSync(path.join(outputDir, file), inputText, { encoding: 'utf8', flag: 'wx' });
                skillInput = { file: `outputs/${file}`, text: clamp(inputText), images: skillFiles };
                graph.runs[node.id] = { ...graph.runs[node.id], skillInput };
                graph = writeGraph(project, graph);
                try { options.onNodeInput?.({ nodeId: node.id, run: graph.runs[node.id] }); } catch { /* 通知不影响生成 */ }
            }
            const value = await type.run(node, ins, { project, projectDir: projectDir(project), graph,
                generateText: options.generateText, generateImage: options.generateImage, imagePrompt,
                textSource, images, skillText, skillFiles });
            // 节点可以返回 { text, media } —— media 是产出的文件名列表(出图/改图用),
            // 画布拿它渲染缩略图;纯文本节点照旧只返回字符串。
            const rich = value !== null && typeof value === 'object' && typeof value.text === 'string';
            outputs.set(node.id, rich ? value.text : value);
            hashes.set(node.id, fp);
            graph.runs[node.id] = {
                status: 'ok',
                output: clamp(text(rich ? value.text : value)),
                media: rich && Array.isArray(value.media) ? value.media : [],
                file: rich && typeof value.file === 'string' ? value.file : null,
                ms: Date.now() - t0, at: Date.now(), fp,
                ...(skillInput ? { skillInput } : {}),
            };
            graph = writeGraph(project, graph);
            if (type.id === 'llm' || type.id === 'image') {
                try { options.onNodeStatus?.({ nodeId: node.id, status: 'ok' }); } catch { /* 同上 */ }
            }
            ran += 1;
        } catch (error) {
            const message = text(error?.message ?? error);
            graph.runs[node.id] = { status: 'failed', error: message, ms: Date.now() - t0, at: Date.now(), fp,
                ...(skillInput ? { skillInput } : {}) };
            writeGraph(project, graph);
            if (type.id === 'llm' || type.id === 'image') {
                try { options.onNodeStatus?.({ nodeId: node.id, status: 'failed' }); } catch { /* 同上 */ }
            }
            return `失败于「${node.title ?? node.id}」:${message}`;
        }
    }
    return `跑完 ${order.length} 个节点(实跑 ${ran},缓存命中 ${cached})`;
}

// ---------------------------------------------------------------- 宿主共用的小工具
// 一个发 JSON、一个读请求体、一个判"是不是本机"。放在 core 里,
// 是因为**插件与独立程序都要用** —— 这类东西复制两份必然分叉。



export function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
}

export async function readBody(request) {
### IPC final event/reader
            if (typeof project !== 'string' || project.trim() === '') throw new Error('project 必填');
            const onNodeStatus = typeof runId === 'string' && runId.length > 0 && runId.length <= 100
                && typeof event?.sender?.send === 'function'
                ? (payload) => {
                    if (event.sender.isDestroyed?.()) return;
                    event.sender.send('drama:runEvent', { project, runId, ...payload });
                } : undefined;
            const task = runGraph(project, target, force === true,
                { generateText, generateImage, imageSignature, onNodeStatus,
                    onNodeInput: payload => onNodeStatus?.({ ...payload, status: 'inputReady' }),
                    onSkillMatch: payload => onNodeStatus?.({ ...payload, status: 'skillMatched' }) });
            if (wait === false) {
                void task.then((s) => log.info?.(`[drama] ${s}`)).catch(() => {});
                return { started: true };
            }
            const summary = await withTimeout(task, RUN_TIMEOUT_MS);
            return { summary, state: statePayload(project) };
        },

        'drama:readOutput': async (_event, { project, file } = {}) => {
            requireRoot();
            if (typeof project !== 'string' || project.trim() === '' || typeof file !== 'string'
                || !/^outputs\/[\w-]+\.txt$/.test(file)) {
                throw new Error('只能读取文本生成结果');
            }
            const graph = readGraph(project);
            if (!Object.values(graph.runs ?? {}).some((run) => run?.file === file || run?.skillInput?.file === file)) {
                throw new Error('只能读取文本生成结果');
            }
            const target = path.join(projectDir(project), file);
            const st = fs.statSync(target);
            const isSkillInput = Object.values(graph.runs ?? {}).some(run => run?.skillInput?.file === file);
            const limit = isSkillInput ? MAX_SKILL_INPUT_BYTES : 2 * 1024 * 1024;
            if (!st.isFile() || st.size > limit) throw new Error(`文本结果不可读取或超过 ${isSkillInput ? '16 MiB' : '2 MB'}`);
            return { text: fs.readFileSync(target, 'utf8'), file };
        },

        // 「＋ 导入」:把一个文件抽成纯文本交给面板,面板把它填进节点的「手输内容」。
        //
### UI final scoped event

    ctx.onDispose(ctx.drama.onRunEvent((event) => {
        if (event?.runId !== state.activeRunId || event?.project !== state.project) return;
        const nodeType = nodeById(event.nodeId)?.type;
        if (nodeType !== 'llm' && nodeType !== 'image') return;
        if (event.status === 'skillMatched') {
            state.graph.skillMatches = { ...state.graph.skillMatches, [event.nodeId]: event.skillMatch };
            refreshSkillFeedback();
            return;
        }
        if (event.status === 'inputReady') {
            state.graph.runs = { ...state.graph.runs, [event.nodeId]: {
                ...state.graph.runs?.[event.nodeId], ...event.run,
            } };
            refreshSkillFeedback();
            return;
        }
        const running = event.status === 'running';
        if (running) {
            state.generatingNodes.add(event.nodeId);
            if (nodeType === 'image') {
                const previous = state.graph?.runs?.[event.nodeId];
                if (Array.isArray(previous?.media) && previous.media.length > 0) {
                    state.priorMediaRuns.set(event.nodeId, previous);
                }
            }
        }
        else state.generatingNodes.delete(event.nodeId);
        const card = [...el.world.querySelectorAll('.drama-node')]
            .find((item) => item.dataset.nodeId === event.nodeId);
        if (!card) return;
        card.classList.toggle('generating', running);
        const badge = card.querySelector('.drama-status');
        if (badge) {
            badge.className = `drama-status drama-status-${event.status}`;
            badge.textContent = statusText({ status: event.status });
            badge.title = running ? (nodeType === 'image' ? '正在生成画面' : '正在生成文本') : '';
        }
    }));

    function inboundOf(id) {
        const node = nodeById(id);
        const type = typeById(node?.type);
        return inputEdgeGroups(state.graph, id, type?.inputs?.length ?? 0, type?.multipleInputs);
    }

    function render() {
        hideSnapFeedback();
        hideMarqueeFeedback();
### Current tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure, writeGraph, readGraph, runGraph, palette } from '../electron/drama/lib/core.js';
import { validateConnection } from '../app/lib/drama-connections.js';

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-skill-run-'));
    configure({ root });
    const graph = { nodes: [
        { id: 'text', type: 'text', params: { value: '角色设定全文' } },
        { id: 'refs', type: 'image-input', params: { files: ['missing.png'] } },
        { id: 'skill', type: 'skill', title: '人物一致性', params: { purpose: '保持同一个人物', value: '' } },
        { id: 'out', type: 'image', params: { prompt: '生成雨夜镜头' } }], edges: [
        { from: 'text', to: 'skill', toPort: 0 }, { from: 'refs', to: 'skill', toPort: 1 },
        { from: 'skill', to: 'out', toPort: 1 }], runs: {} };
    writeGraph('test', graph);
    return { root, graph, dir: path.join(root, 'test') };
}

test('技能有双输入和专用输出；只可接生成节点技能汇聚端口', () => {
    const types = palette();
    const graph = { nodes: [{ id: 's', type: 'skill' }, { id: 'o', type: 'image' }], edges: [] };
    assert.deepEqual(types.find(t => t.id === 'skill')?.inputs, ['文本', '图集']);
    assert.equal(validateConnection(graph, types, 's', 0, 'o', 1).ok, true);
    assert.equal(validateConnection(graph, types, 's', 0, 'o', 0).ok, false);
});

test('未选技能不执行来源，缺失图片也不阻止接收节点；运行全部同样跳过', async () => {
    const { graph } = setup();
    // 一个未知/不能运行的来源只能进入待命技能，不可提前触发。
    graph.nodes[0].type = 'not-runnable';
    writeGraph('test', graph);
    let calls = 0;
    const options = { matchSkills: async () => ({ selected: [] }), generateImage: async () => { calls++; return { files: [], detail: 'image' }; } };
    const result = await runGraph('test', 'out', false, options);
    assert.doesNotMatch(result, /失败|异常/);
    let runs = readGraph('test').runs;
    assert.equal(runs.out.status, 'ok');
    assert.equal(runs.text, undefined);
    assert.equal(runs.refs, undefined);
    assert.equal(runs.skill, undefined);
    await runGraph('test', null, true, options);
    assert.equal(calls, 2);
    runs = readGraph('test').runs;
    assert.equal(runs.refs, undefined);
});

test('选中技能读取当前全文和图片字节；正文变化失效缓存，用途/提示词变化重匹配', async () => {
    const { graph, dir } = setup();
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'shots', 'missing.png'), Buffer.from('89504e470d0a1a0a0001', 'hex'));
    graph.nodes[0].params.value = '角色设定'.repeat(6000);
    graph.nodes[3].params.prompt = '保持同一个人';
    writeGraph('test', graph);
    let matches = 0;
    const calls = [];
    const options = { matchSkills: async () => { matches++; return { selected: [{ id: 'skill', reason: '要求同一角色', evidence: '同一个人' }] }; },
        generateImage: async args => { calls.push(args); return { files: [], detail: 'image' }; } };
    assert.doesNotMatch(await runGraph('test', 'out', false, options), /失败|异常/);
    assert.match(calls[0].prompt, /角色设定/);
    assert.ok(calls[0].prompt.includes(graph.nodes[0].params.value));
    assert.equal(calls[0].images[0].mimeType, 'image/png');
    await runGraph('test', 'out', false, options);
    assert.equal(matches, 1);
    assert.equal(calls.length, 1);
    const changed = readGraph('test');
    changed.nodes[0].params.value = '全新的角色';
    writeGraph('test', changed);
    await runGraph('test', 'out', false, options);
    assert.equal(matches, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /全新的角色/);
    assert.equal(readGraph('test').skillMatches.out.selected[0].id, 'skill');
    changed.nodes[2].params.purpose = '更新同一角色用途';
    writeGraph('test', changed);
    await runGraph('test', 'out', false, options);
    assert.equal(matches, 2);
});

test('匹配错误/越界 ID 在任何来源和生成执行前被拦住', async () => {
    setup();
    let calls = 0;
    const result = await runGraph('test', 'out', false, {
        matchSkills: async () => ({ selected: [{ id: 'foreign', reason: 'r', evidence: '雨夜' }] }),
        generateImage: async () => { calls++; throw new Error('不应调用'); },
    });
    assert.match(result, /技能匹配/);
    assert.equal(calls, 0);
    assert.equal(readGraph('test').runs.refs, undefined);
});

test('断开已启用技能后不复用旧匹配；无选中技能的用途变化仍重匹配和生成', async () => {
    const { graph } = setup();
    graph.edges = graph.edges.filter(edge => edge.from !== 'refs');
    writeGraph('test', graph);
    let matches = 0;
    const calls = [];
    const options = { matchSkills: async () => { matches++; return { selected: matches === 1
        ? [{ id: 'skill', reason: 'r', evidence: '雨夜' }] : [] }; },
        generateImage: async args => { calls.push(args); return { files: [], detail: 'ok' }; } };
    await runGraph('test', 'out', false, options);
    const disconnected = readGraph('test');
    disconnected.edges = disconnected.edges.filter(edge => edge.from !== 'skill');
    writeGraph('test', disconnected);
    assert.doesNotMatch(await runGraph('test', 'out', false, options), /失败|异常/);
    assert.equal(readGraph('test').skillMatches.out, undefined);
    assert.doesNotMatch(calls.at(-1).prompt, /角色设定/);
    const reconnected = readGraph('test');
    reconnected.edges.push({ from: 'skill', to: 'out', toPort: 1 });
    writeGraph('test', reconnected);
    await runGraph('test', 'out', false, options);
    const changed = readGraph('test');
    changed.nodes[2].params.purpose = '另一项用途';
    writeGraph('test', changed);
    await runGraph('test', 'out', false, options);
    assert.equal(matches, 3);
    assert.equal(calls.length, 4);
});

test('多个技能汇入文本生成，同时保留待命技能共享的普通分支', async () => {
    const { graph, dir } = setup();
    graph.nodes[3].type = 'llm';
    graph.nodes.push({ id: 'skill2', type: 'skill', title: '文风', params: { value: '克制对白' } });
    graph.edges = [{ from: 'text', to: 'out', toPort: 0 },
        { from: 'text', to: 'skill', toPort: 0 }, { from: 'refs', to: 'skill', toPort: 1 },
        { from: 'skill', to: 'out', toPort: 1 }, { from: 'skill2', to: 'out', toPort: 1 }];
    writeGraph('test', graph);
    const calls = [];
    const options = { matchSkills: async () => ({ selected: [{ id: 'skill2', reason: 'r', evidence: '雨夜' }] }),
        generateText: async args => { calls.push(args); return '正文'; } };
    assert.doesNotMatch(await runGraph('test', null, false, options), /失败|异常/);
    assert.match(calls[0].source, /角色设定全文/);
    assert.match(calls[0].source, /技能 · 文风/);
    assert.equal(readGraph('test').runs.refs, undefined);
    assert.equal(readGraph('test').runs.skill, undefined);
    const actual = readGraph('test').runs.out.skillInput;
    assert.match(fs.readFileSync(path.join(dir, actual.file), 'utf8'), /克制对白/);
});

test('实际技能输入在提交前登记并在失败后保留', async () => {
    const { graph, dir } = setup();
    graph.edges = graph.edges.filter(edge => edge.from !== 'refs');
    writeGraph('test', graph);
    const events = [];
    const result = await runGraph('test', 'out', false, {
        matchSkills: async () => ({ selected: [{ id: 'skill', reason: 'r', evidence: '雨夜' }] }),
        onNodeInput: payload => events.push(payload),
        generateImage: async args => {
            const run = readGraph('test').runs.out;
            assert.equal(run.status, 'running');
            assert.equal(fs.readFileSync(path.join(dir, run.skillInput.file), 'utf8'), args.prompt);
            assert.equal(events[0].run.skillInput.file, run.skillInput.file);
            throw new Error('fixture generation failed');
        },
    });
    assert.match(result, /fixture generation failed/);
    assert.equal(readGraph('test').runs.out.status, 'failed');
    assert.ok(readGraph('test').runs.out.skillInput);
});

test('超过 16 MiB 的实际技能输入在提交前拒绝', async () => {
    const { graph } = setup();
    graph.edges = graph.edges.filter(edge => edge.from !== 'refs');
    graph.nodes[0].params.value = 'x'.repeat(16 * 1024 * 1024);
    writeGraph('test', graph);
    let calls = 0;
    const result = await runGraph('test', 'out', false, {
        matchSkills: async () => ({ selected: [{ id: 'skill', reason: 'r', evidence: '雨夜' }] }),
        generateImage: async () => { calls++; return { files: [], detail: 'ok' }; },
    });
    assert.match(result, /16 MiB/);
    assert.equal(calls, 0);
});

test('两个技能共享四张参考图只按首次文件顺序发送一次', async () => {
    const { graph, dir } = setup();
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
    const files = ['a.png', 'b.png', 'c.png', 'd.png'];
    for (const file of files) fs.writeFileSync(path.join(dir, 'shots', file), Buffer.from('89504e470d0a1a0a0001', 'hex'));
    graph.nodes[1].params.files = files;
    graph.nodes.push({ id: 'skill2', type: 'skill', params: { value: '第二个技能全文' } });
    graph.edges.push({ from: 'refs', to: 'skill2', toPort: 1 }, { from: 'skill2', to: 'out', toPort: 1 });
    writeGraph('test', graph);
    let sent;
    const result = await runGraph('test', 'out', false, {
        matchSkills: async () => ({ selected: ['skill', 'skill2'].map(id => ({ id, reason: 'r', evidence: '雨夜' })) }),
        generateImage: async args => { sent = args; return { files: [], detail: 'ok' }; },
    });
    assert.doesNotMatch(result, /失败/);
    assert.equal(sent.images.length, 4);
    assert.match(sent.prompt, /第二个技能全文/);
    assert.deepEqual(readGraph('test').runs.out.skillInput.images, files);
});

test('未启用技能只改待命正文时继续复用匹配和生成缓存', async () => {
    setup();
    let matches = 0;
    let calls = 0;
    const options = {
        matchSkills: async () => { matches++; return { selected: [] }; },
        generateImage: async () => { calls++; return { files: [], detail: 'ok' }; },
    };
    await runGraph('test', 'out', false, options);
    const changed = readGraph('test');
    changed.nodes[0].params.value = '新待命来源正文';
    changed.nodes[2].params.value = '新待命技能正文';
    // 保持元信息中的文本类型不变，再只改正文。
    writeGraph('test', changed);
    await runGraph('test', 'out', false, options);
    const sameMetadata = readGraph('test');
    sameMetadata.nodes[0].params.value = '再次修改来源';
    sameMetadata.nodes[2].params.value = '再次修改技能正文';
    writeGraph('test', sameMetadata);
    const before = [matches, calls];
    await runGraph('test', 'out', false, options);
    assert.deepEqual([matches, calls], before);
});
// 隔离画布验证：使用真实插件和类型表，所有模型/文件接口由本地夹具替代。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/18014/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const projectRoot = path.resolve(__dirname, '..');
(async () => {
    const { palette } = await import('file:///E:/project/kaiwu/electron/drama/lib/core.js');
    const { skillCandidates, skillMatchKey } = await import('file:///E:/project/kaiwu/app/lib/drama-skills.js');
    const graph = { nodes: [
        { id: 'text', type: 'text', title: '人物设定', x: 15, y: 25, w: 220, params: { value: '人物外观素材' } },
        { id: 'refs', type: 'image-input', title: '参考图片', x: 15, y: 150, w: 220, params: { files: [] } },
        { id: 'skill', type: 'skill', title: '人物一致性', x: 280, y: 25, w: 280,
            params: { purpose: '同一人物外观', scenarios: '保持长相', exclude: '不需要人物', value: '保持黑色短发' } },
        { id: 'out', type: 'image', title: '画面生成', x: 615, y: 25, w: 340, h: 500,
            params: { prompt: '生成同一个人的雨夜镜头', batch: 1 } },
    ], edges: [{ from: 'text', to: 'skill', toPort: 0 }, { from: 'skill', to: 'out', toPort: 1 }], runs: {} };
    graph.skillMatches = { out: { key: skillMatchKey(graph.nodes[3].params.prompt, skillCandidates(graph, 'out')),
        selected: [{ id: 'skill', reason: '要求保持人物长相', evidence: '同一个人' }] } };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKQAAAABJRU5ErkJggg==';
    const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app/styles/tokens.css"><style>*{box-sizing:border-box}body{margin:0;padding:15px;background:var(--bg);color:var(--text)}#host{height:800px}</style></head><body><div id="host" data-plugin="drama"></div><script type="module">
    import plugin from '/plugins/drama/index.js';
    import {skillCandidates,skillMatchKey} from '/app/lib/drama-skills.js';
    let graph=${JSON.stringify(graph)}; const types=${JSON.stringify(palette())};
    window.saved=graph;window.calls={imports:0,media:0,reads:0};let listener;const panes=[];
    const ctx={onDispose(){},log:{info(){},warn(...a){console.error(...a)}},panes:{register(p){panes.push(p)}},
      dialog:{openFile:async()=>['C:/fixture/ref.png']},drama:{root:async()=>({root:'fixture',reason:null}),
      projects:async()=>({projects:['fixture'],items:[{name:'fixture'}]}),state:async()=>({project:'fixture',graph,types}),
      save:async(_p,g)=>{graph=structuredClone(g);window.saved=graph},onRunEvent:fn=>{listener=fn;return()=>{}},
      importImage:async()=>{window.calls.imports++;return{file:'ref.png'}},
      media:async()=>{window.calls.media++;return{mime:'image/png',base64:'${png}'}},
      readOutput:async()=>{window.calls.reads++;return{text:'完整实际输入：人物外观素材，保持黑色短发'}},
      run:async({runId})=>{
        const skillMatch={key:skillMatchKey(graph.nodes.find(n=>n.id==='out').params.prompt,skillCandidates(graph,'out')),
          selected:[{id:'skill',reason:'要求保持人物长相',evidence:'同一个人'}]};
        graph.skillMatches={out:skillMatch};
        listener({project:'fixture',runId,nodeId:'out',status:'skillMatched',skillMatch});
        listener({project:'fixture',runId,nodeId:'out',status:'running'});
        graph.runs.out={status:'running',skillInput:{file:'outputs/input.txt',text:'摘要',images:['ref.png']}};
        listener({project:'fixture',runId,nodeId:'out',status:'inputReady',run:graph.runs.out});
        await new Promise(r=>{window.finishGeneration=r});
        graph.runs.out={status:'ok',media:['frame.png'],skillInput:{file:'outputs/input.txt',text:'摘要',images:['ref.png']}};
        listener({project:'fixture',runId,nodeId:'out',status:'ok'});
        return{summary:'夹具生成完成',state:{graph}};
      }}};
    plugin.activate(ctx);panes.find(p=>p.id==='drama').mount(document.getElementById('host'));
    </script></body></html>`;
    const server = http.createServer((req, res) => {
        const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (relative === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8');res.end(html);return; }
        const file = path.resolve(projectRoot, '.' + relative);
        if (!file.startsWith(projectRoot + path.sep) || !fs.existsSync(file)) { res.writeHead(404);res.end();return; }
        const source = fs.readFileSync(file, 'utf8');
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        res.end(file.endsWith('.js') ? source.replaceAll('toolbox://shell/', '/app/') : source);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1270, height: 840 } });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const out = page.locator('[data-node-id="out"]');
        const skill = page.locator('[data-node-id="skill"]');
        const refs = page.locator('[data-node-id="refs"]');
        await out.locator('.drama-skill-row.active').waitFor();
        assert.equal(await out.locator('.drama-port-input').count(), 2);
        assert.equal(await skill.locator('.drama-port-input').count(), 2);
        assert.equal(await page.locator('.drama-edge-skill.active').count(), 1);
        assert.equal((await page.evaluate(() => window.calls)).media, 0, '待命时没有偷偷读取技能图片');
        await refs.locator('.drama-reference-add').click();
        await refs.locator('.drama-image-main:not([hidden])').waitFor();
        assert.equal((await page.evaluate(() => window.calls)).imports, 1);
        const from = await refs.locator('.drama-port-output').boundingBox();
        const to = await skill.locator('.drama-port-input[data-port-index="1"]').boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });await page.mouse.up();
        await out.locator('.drama-skill-caption').filter({ hasText: '待匹配' }).waitFor();
        assert.equal(await page.locator('.drama-edge-skill.dormant').count(), 1);
        await skill.locator('.drama-node-head').click();await skill.locator('.drama-node-head').click();
        await skill.locator('input[data-skill-name]').fill('角色一致性');
        await skill.locator('textarea[data-param-key="purpose"]').fill('保持同一人物外观和服装');
        assert.equal(await skill.locator('.drama-disconnect').count(), 2);
        await out.locator('.drama-node-head').click();
        await page.locator('.drama-runhere').click();
        await out.locator('.drama-skill-row.active').waitFor();
        assert.equal((await page.evaluate(() => window.calls)).reads, 0);
        await out.locator('.drama-skill-actual summary').click();
        await out.locator('.drama-skill-input').filter({ hasText: '完整实际输入' }).waitFor();
        assert.ok(await out.evaluate(el=>el.classList.contains('generating')), 'inputReady 保持生成扫光');
        await page.evaluate(()=>window.finishGeneration());
        await out.locator('.drama-node-body > .drama-image-gallery .drama-image-main:not([hidden])').waitFor();
        // 完成后面板会重建，复用已懒读的正文。
        await out.locator('.drama-skill-actual summary').click();
        await out.locator('.drama-skill-input').filter({ hasText: '完整实际输入' }).waitFor();
        assert.equal(await out.locator('.drama-skill-actual .drama-image-feature').evaluate(el => el.offsetHeight), 145);
        assert.ok(await out.locator('.drama-node-body > .drama-image-gallery .drama-image-feature').evaluate(el => el.offsetHeight) >= 88);
        assert.equal((await page.evaluate(() => window.calls)).reads, 1);
        // 再次运行时保持上一轮生成图，并在 pending 阶段更新实际输入。
        await page.locator('.drama-runhere').click();
        await page.waitForFunction(() => document.querySelector('[data-node-id="out"]').classList.contains('generating'));
        assert.equal(await out.locator('.drama-node-body > .drama-image-gallery .drama-image-main:not([hidden])').count(), 1);
        await out.locator('.drama-skill-actual summary').click();
        await out.locator('.drama-skill-input').filter({ hasText: '完整实际输入' }).waitFor();
        assert.equal((await page.evaluate(() => window.calls)).reads, 1, '同一快照全文读取复用缓存');
        await page.evaluate(()=>window.finishGeneration());
        await page.waitForFunction(() => !document.querySelector('[data-node-id="out"]').classList.contains('generating'));
        await out.locator('.drama-skill-actual summary').click();
        await out.locator('.drama-skill-input').filter({ hasText: '完整实际输入' }).waitFor();
        const before = await page.locator('.drama-world').evaluate(el => el.style.transform);
        await out.locator('.drama-skill-input').evaluate(el => el.textContent += '\n技能正文'.repeat(80));
        await out.locator('.drama-skill-input').hover();await page.mouse.wheel(0, 180);
        await page.waitForFunction(() => document.querySelector('.drama-skill-input').scrollTop > 0);
        assert.equal(await page.locator('.drama-world').evaluate(el => el.style.transform), before);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(projectRoot, 'docs/superpowers/plans/skill-canvas-check.png'), fullPage: true });
        console.log('Skill canvas passed: reference import/preview, typed ports, drag connection, stale metadata, live activation, lazy actual input and contained scroll. No real model calls.');
    } finally { if (browser) await browser.close();await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error);process.exitCode = 1; });

