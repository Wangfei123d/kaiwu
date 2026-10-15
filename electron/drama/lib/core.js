// AI 短剧工作台 · host 半
//
// 职责:把"一张图"变成能跑的东西 —— 图的读写、节点类型注册表、拓扑执行、指纹缓存,
// 以及给画布用的同源 API 和给 Agent 用的工具。
//
// 为什么要 host 半而不是全塞客户端:
//   · 图要落盘(纯 JSON,能 git、能手改、Agent 能读);
//   · 执行要用 Node 能力(子进程 / 文件),浏览器里做不了;
//   · Agent 也要能建图跑图 —— 同一份实现,客户端与 Agent 各走一条门(tool / HTTP API)。
//
// 落盘位置:<DSH_HOME>/ai-drama/<项目>/graph.json,可用 DSH_AI_DRAMA_ROOT 覆盖。
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inputEdgeGroups } from '../../../app/lib/drama-connections.js';
import { buildImagePrompt } from '../../../app/lib/drama-image-prompt.js';
import { planSkillExecution } from './skill-plan.js';
import { readProjectImages } from './skill-resources.js';
import { admitImagePayload } from '../../../app/lib/agent-image.js';
import { extractText } from './text.js';
import { configFile as imageConfigFile, imageEdit, imageListModels, imageStatus, readImageConfig, writeImageConfig } from './image.js';

// 这个模块是**引擎**:不依赖 DSH。插件(lib/index.js)与独立程序(standalone/server.mjs)共用它。
/** 只要 tools:webServer 用 ctx.inject 另起子 fiber(见 apply 里的说明)。 */

export const VERSION = '0.2.0';
const API_BASE = '/dsh-ai-drama/api';
/** 单个节点返回给界面/Agent 的文本上限。 */
const MAX_TEXT = 20000;
const MAX_GENERATED_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_INPUT_BYTES = 16 * 1024 * 1024;
/**
 * 一次导入的字节上限。**200 KB**。
 *
 * 为什么要有它:导入现在是"把文件内容灌进节点"(`params.value`),而那是要写进 graph.json 的 ——
 * 不设限就是悄悄往项目档里灌大文件(一个 5 MB 的剧本会让每次存盘都挪一遍那 5 MB)。
 * 200 KB ≈ 10 万字中文,一集剧本够用;超了就**明确拒**,并告诉用户先剪短(不悄悄截断:
 * 截断过的东西用户看不出来,而"以为导进来了"比"被拒"更坏)。
 * 与 MAX_TEXT 的关系:那是**跑图时**给下游的截断(20000 字),这里是**入库时**的上限,两层各自守一段。
 */
export const MAX_IMPORT_BYTES = 200 * 1024;
/** shell 节点的默认超时。 */
const SHELL_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------- 存储

/** 宿主(独立程序/插件)可以显式指定项目根;没指定才回落到环境变量 / DSH 家目录。 */
let ROOT_OVERRIDE = '';
export function configure(options = {}) {
    ROOT_OVERRIDE = typeof options.root === 'string' ? options.root.trim() : '';
}

export function rootDir() {
    if (ROOT_OVERRIDE !== '') return ROOT_OVERRIDE;
    const fromEnv = typeof process.env.DSH_AI_DRAMA_ROOT === 'string' ? process.env.DSH_AI_DRAMA_ROOT.trim() : '';
    if (fromEnv !== '') return fromEnv;
    const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    return path.join(home !== '' ? home : process.cwd(), 'ai-drama');
}

/** 项目名 → 安全的目录名。中文保留(本机中文项目名更常见)。 */
export function slug(value) {
    const s = String(value ?? '').trim().replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60);
    return s === '' ? 'default' : s;
}

export const projectDir = (project) => path.join(rootDir(), slug(project));

/**
 * **老**节点导入文件的落点(和 shots/ 一个约定)。
 *
 * ⚠️ 新版不再往这里写:导入改成把内容灌进节点的 `value`(面板上那个 ＋),不再留原件。
 *    所以这里现在只服务两件事:读出老节点的 `inputs/xxx.txt`(migrateLegacyTextNodes)、
 *    以及读老节点里那个 `source` 路径时把项目目录夹住。
 */
export const inputsDir = (project) => path.join(projectDir(project), 'inputs');

/**
 * 文本容器的取内容规则。
 *
 * ⚠️ 这是**给老节点留的兼容路**:新节点只有 `value`(导入就是把内容灌进它,没有别的入口)。
 *    老节点还带着 `source` / `useSource` 时按老规矩走 —— 一条都不认会让那些稿子静默变空。
 *    正常情况下 `migrateLegacyTextNodes()` 已经在载入时把它们搬完了,这里是兜底:
 *    文件不在了(用户删了 inputs/)时仍然报一句人话,而不是假装成功。
 *
 * 返回 { text, from, file } —— from 是 'source' | 'value' | 'empty'。
 */
export function readTextContainer(node, project) {
    const source = text(node?.params?.source).trim();
    const useSource = text(node?.params?.useSource).trim().toLowerCase();
    const wantsSource = useSource === '' ? source !== '' : (useSource === 'true' || useSource === '1' || useSource === 'yes');
    if (wantsSource && source !== '') {
        const full = path.resolve(projectDir(project), source);
        // 夹在项目目录内:导入的都是项目文件,不允许用 ../ 指到别处
        if (!full.startsWith(path.resolve(projectDir(project)) + path.sep)) {
            throw new Error(`导入文件必须在项目目录内:${source}`);
        }
        if (!fs.existsSync(full)) throw new Error(`导入的文件不在了:${source}(请重新导入)`);
        return { text: fs.readFileSync(full, 'utf8'), from: 'source', file: source };
    }
    const value = text(node?.params?.value);
    return { text: value, from: value.trim() === '' ? 'empty' : 'value', file: '' };
}

/**
 * 把**老节点**的正文搬进 `value`,然后清掉那几个老字段。一次性、幂等。
 *
 * 为什么必须有这一步:老节点把正文存在 `<项目>/inputs/xxx.txt` 里,`value` 是空的 ——
 * 删掉那两个字段而不搬,表现是"这个节点的稿子**静默变空**"(跑图才发现的空上游)。
 *
 * 规矩:
 *   · `value` 已经非空 → 只清老字段(以手输的为准,不覆盖用户后来手写的东西);
 *   · 文件读不到(被删了 / 不在项目内)→ **原样留着**老字段:老节点照旧能跑(会报"导入的文件不在了"),
 *     搬一半反而更糟;
 *   · 一个都没搬 → **不写盘**(载入一次就写一次档是不可接受的副作用)。
 *
 * @returns {{ migrated: number }} 真搬了几个节点
 */
export function migrateLegacyTextNodes(project) {
    let graph;
    try {
        graph = readGraph(project);
    } catch {
        return { migrated: 0 };
    }
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    let migrated = 0;
    for (const node of nodes) {
        if (node?.type !== 'text') continue;
        const params = (node.params !== null && typeof node.params === 'object') ? node.params : {};
        const hasLegacy = typeof params.source === 'string' && params.source.trim() !== '';
        if (!hasLegacy) continue;
        const currentValue = text(params.value);
        if (currentValue.trim() === '') {
            try {
                const { text: fromFile } = readTextContainer(
                    { params: { source: params.source, useSource: 'true' } }, project,
                );
                if (fromFile.trim() === '') continue;      // 空文件:搬了也等于没搬,留着老字段
                node.params = { ...params, value: fromFile };
            } catch {
                continue;                                  // 读不到 → 原样留着(见上)
            }
        }
        const next = { ...node.params };
        delete next.source;
        delete next.useSource;
        delete next.sourceChars;
        delete next.sourceNote;
        delete next.sourceImportedAt;
        node.params = next;
        migrated += 1;
    }
    if (migrated > 0) writeGraph(project, graph);
    return { migrated };
}
const graphFile = (project) => path.join(projectDir(project), 'graph.json');

export function emptyGraph(project) {
    return { version: 1, id: slug(project), title: String(project ?? ''), nodes: [], edges: [], runs: {} };
}

/**
 * 规范化一张图。**这一步不是洁癖,是踩过的坑**:外部(画布或 Agent)存进来的图
 * 可能没有 runs 字段,于是执行器里 `graph.runs[id] = …` 当场 TypeError,
 * 而它是 async 函数内部的同步抛错 —— 会被 promise 吞掉,表现成"点了运行什么都没发生"。
 * 读写两侧都过这里,执行器就不必到处判空。
 */
function normalizeGraph(project, parsed) {
    const base = emptyGraph(project);
    if (parsed === null || typeof parsed !== 'object') return base;
    return {
        ...base,
        ...parsed,
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        runs: (parsed.runs !== null && typeof parsed.runs === 'object') ? parsed.runs : {},
    };
}

export function readGraph(project) {
    try {
        return normalizeGraph(project, JSON.parse(fs.readFileSync(graphFile(project), 'utf8')));
    } catch { /* 没有或坏了都当空图:画布不该因为一个坏文件打不开 */ }
    return emptyGraph(project);
}

export function writeGraph(project, graph) {
    fs.mkdirSync(projectDir(project), { recursive: true });
    const next = normalizeGraph(project, graph);
    fs.writeFileSync(graphFile(project), JSON.stringify(next, null, 2), 'utf8');
    return next;
}

export function listProjects() {
    try {
        return fs.readdirSync(rootDir(), { withFileTypes: true })
            .filter((e) => e.isDirectory() && fs.existsSync(path.join(rootDir(), e.name, 'graph.json')))
            .map((e) => e.name);
    } catch { return []; }
}

// ---------------------------------------------------------------- 节点类型

const text = (v) => (v === undefined || v === null ? '' : String(v));
const clamp = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n…(截断,共 ${s.length} 字)` : s);

/** 模板里 {{0}} {{1}} 用上游第 n 个输入替换;{{input}} 是第一个输入。 */
function fill(template, inputs) {
    let out = text(template);
    inputs.forEach((v, i) => { out = out.split(`{{${i}}}`).join(text(v)); });
    return out.split('{{input}}').join(text(inputs[0]));
}

function runShell(command, cwd, timeoutMs = SHELL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
            { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error !== null && error !== undefined && stdout === '') {
                    reject(new Error(`${error.message}${stderr !== '' ? `\n${stderr}` : ''}`));
                    return;
                }
                resolve(`$ ${command}\n${stdout}${stderr !== '' ? `\n[stderr]\n${stderr}` : ''}`);
            });
    });
}

const NOT_WIRED = (what) => `[[未接线]]${what}还没接。接上之后再点这个节点重跑即可。`;

/**
 * 节点类型注册表。**画布的节点库与 Agent 的 drama_types 都从这里出**,不写第二份。
 * inputs/outputs 只是给界面画端口用的类型名;执行只看 run。
 */
export const TYPES = [
    {
        // 文本容器:既能手输,也能从文件导入(见 lib/text.js)。
        //
        // ⚠️ 从前的三个参数(value / source / useSource)在 2026-09 收敛成一个:
        //    「导入的文件」+「用导入文件 true/false」删掉了 —— 导入这件事改成把**内容**灌进
        //    value(面板上那个 ＋),节点就只有一个正文,不再"节点记路径、正文在别处"。
        //    老节点由 migrateLegacyTextNodes() 一次性搬过来(不搬的话稿子会静默变空)。
        //    `importable: true` 是**参数级**标记:面板据此在标签行右边画那个 ＋;
        //    别的 textarea(备注、提示词)没有这个标记,就不会长出这个按钮。
        id: 'text', label: '文本 / 剧本', category: '输入', color: 'text', inputs: [], outputs: ['文本'],
        params: [
            { key: 'value', label: '手输内容', type: 'textarea', default: '', importable: true },
        ],
        run: (node, _inputs, ctx) => readTextContainer(node, ctx.project),
    },
    {
        id: 'image-input', label: '图片输入', category: '输入', color: 'img', inputs: [], outputs: ['图集'],
        params: [],
        run: (node, _inputs, ctx) => {
            const files = node.params?.files ?? [];
            readProjectImages(ctx.projectDir, files);
            if (files.length === 0) throw new Error('请先导入参考图片');
            return { text: `参考图片 ${files.length} 张`, media: files };
        },
    },
    {
        id: 'skill', label: '技能', category: '技能', color: 'text', inputs: ['文本', '图集'],
        outputs: ['技能'], multipleInputs: [0, 1],
        params: [
            { key: 'purpose', label: '适用需求（用于自动匹配）', type: 'textarea', default: '' },
            { key: 'scenarios', label: '适用场景 / 需求示例', type: 'textarea', default: '' },
            { key: 'exclude', label: '排除条件', type: 'textarea', default: '' },
            { key: 'value', label: '技能正文（可与连入文本共同使用）', type: 'textarea', default: '', importable: true },
        ],
        run: (_node, _inputs, ctx) => ({ text: ctx.skillText, media: ctx.skillFiles }),
    },
    {
        id: 'template', label: '模板拼装', category: '文本', color: 'text', inputs: ['文本'], outputs: ['文本'],
        params: [{ key: 'template', label: '模板(用 {{0}} {{1}} 占位)', type: 'text', default: '{{input}}' }],
        run: (node, inputs) => text(fill(node.params?.template, inputs)),
    },
    {
        id: 'note', label: '备注', category: '文本', color: 'text', inputs: [], outputs: [],
        params: [{ key: 'value', label: '备注', type: 'textarea', default: '' }],
        run: () => '',
    },
    {
        id: 'shell', label: '命令 / ffmpeg', category: '工具', color: 'vid', inputs: ['文本'], outputs: ['文本'],
        params: [
            { key: 'command', label: '命令(可用 {{0}} 取上游)', type: 'text', default: 'Get-ChildItem' },
            { key: 'timeoutMs', label: '超时(ms)', type: 'number', default: SHELL_TIMEOUT_MS },
        ],
        run: (node, inputs, ctx) => runShell(fill(node.params?.command, inputs), ctx.projectDir,
            Number(node.params?.timeoutMs) || SHELL_TIMEOUT_MS),
    },
    {
        id: 'llm', label: '文本生成', category: '文本', color: 'text', inputs: ['文本', '技能'], outputs: ['文本'], multipleInputs: [1],
        params: [{ key: 'prompt', label: '提示词', type: 'textarea', default: '' }],
        run: async (node, inputs, ctx) => {
            if (typeof ctx.generateText !== 'function') throw new Error('文本生成模型尚未连接');
            const source = ctx.textSource ?? text(inputs[0]);
            const prompt = text(node.params?.prompt);
            if (source.trim() === '' && prompt.trim() === '') throw new Error('请连接文本/剧本节点或填写提示词');
            const generated = await ctx.generateText({ source, prompt, images: ctx.images ?? [] });
            if (typeof generated !== 'string' || generated.trim() === '') throw new Error('模型没有返回文本');
            if (Buffer.byteLength(generated, 'utf8') > MAX_GENERATED_BYTES) {
                throw new Error('生成文本超过 2 MB，请让模型分段输出');
            }
            const dir = path.join(ctx.projectDir, 'outputs');
            fs.mkdirSync(dir, { recursive: true });
            const file = `${randomUUID()}.txt`;
            fs.writeFileSync(path.join(dir, file), generated, { encoding: 'utf8', flag: 'wx' });
            return { text: generated, file: `outputs/${file}` };
        },
    },
    {
        id: 'image', label: '画面生成', category: '画面', color: 'img', inputs: ['文本', '技能'], outputs: ['图集'],
        multipleInputs: [0, 1],
        params: [
            { key: 'prompt', label: '补充提示词(与全部上游内容合并)', type: 'textarea', default: '' },
            { key: 'batch', label: '出几张', type: 'number', default: 1 },
        ],
        // 模型与密钥统一由主进程设置提供；老图里的 params.model 保留但不再使用。
        run: async (node, inputs, ctx) => {
            if (typeof ctx.generateImage !== 'function') throw new Error('图片生成服务尚未连接');
            const prompt = ctx.imagePrompt ?? buildImagePrompt(node.params?.prompt, inputs);
            const result = await ctx.generateImage({
                project: ctx.project,
                dir: path.join(ctx.projectDir, 'shots'),
                prompt,
                batch: Number(node.params?.batch) || 1,
                images: ctx.images ?? [],
            });
            // 返回 { text, media }:media 是文件名列表,画布据此渲染缩略图(执行器认这个形状)。
            return {
                text: `${result.detail}\n${result.files.map((file) => path.basename(file)).join('\n')}`,
                media: result.files.map((file) => path.basename(file)),
            };
        },
    },
    {
        // 改图:拿参考图 + 提示词改出新画面。短剧的**角色一致性**就靠这条 ——
        // 不是每次从零生成,而是"拿定妆图去改"。
        id: 'edit', label: '改图 / 角色一致性', category: '画面', color: 'img',
        inputs: ['文本', '参考图'], outputs: ['图集'],
        params: [
            { key: 'prompt', label: '要改成什么(上游为空时用这个)', type: 'textarea', default: '' },
            { key: 'reference', label: '参考图路径(上游为空时用这个;一行一个)', type: 'textarea', default: '' },
            { key: 'size', label: '尺寸(留空用后端默认)', type: 'text', default: '' },
        ],
        run: async (node, inputs, ctx) => {
            const reference = text(inputs[1]) !== '' ? inputs[1] : text(node.params?.reference);
            const result = await imageEdit(rootDir(), {
                project: ctx.project,
                dir: path.join(ctx.projectDir, 'shots'),
                prompt: text(inputs[0]) !== '' ? inputs[0] : node.params?.prompt,
                reference,
                size: node.params?.size,
            });
            return {
                text: `${result.detail}\n${result.files.map((file) => path.basename(file)).join('\n')}`,
                media: result.files.map((file) => path.basename(file)),
            };
        },
    },
    {
        id: 'video', wired: false, label: '图生视频', category: '画面', color: 'vid', inputs: ['图集'], outputs: ['视频'],
        params: [{ key: 'seconds', label: '单段秒数', type: 'number', default: 4 }],
        run: () => NOT_WIRED('图生视频节点'),
    },
    {
        id: 'tts', wired: false, label: 'TTS 配音', category: '音频', color: 'aud', inputs: ['文本'], outputs: ['音轨'],
        params: [{ key: 'voice', label: '声线', type: 'text', default: '林晚·清冷' }],
        run: () => NOT_WIRED('TTS 配音节点'),
    },
    {
        id: 'render', wired: false, label: '合成导出', category: '后期', color: 'vid', inputs: ['视频', '音轨'], outputs: ['视频'],
        params: [{ key: 'size', label: '画幅', type: 'text', default: '1080x1920' }],
        run: () => NOT_WIRED('合成导出节点(ffmpeg)'),
    },
    {
        id: 'publish', wired: false, label: '发布清单', category: '发布', color: 'img', inputs: ['视频'], outputs: ['清单'],
        params: [{ key: 'channels', label: '渠道', type: 'text', default: '抖音,视频号' }],
        run: () => NOT_WIRED('发布清单节点'),
    },
];

export const typeOf = (id) => TYPES.find((t) => t.id === id);
/**
 * 给界面的节点库:不带 run(函数过不了 JSON)。
 *
 * ⚠️ 额外把 `wired` 一并递出去(没标的默认 true)。为什么必须有这个字段:
 *    画布的类型菜单要在跑不动的类型旁标一句「未接线」—— 而判据是"它的 run 是不是
 *    NOT_WIRED 那个桩",那只有这一侧知道(渲染进程拿到的是剥掉 run 的那一份)。
 *    不递的话插件只能自己再抄一份"哪几个没接线"的名单,那份名单迟早和这里漂移。
 */
export const palette = () => TYPES.map((entry) => {
    const { run, ...rest } = entry;
    return { ...rest, wired: entry.wired !== false };
});

// ---------------------------------------------------------------- 执行器

function fingerprint(node, upstreamHashes, imageSignature = '', imagePrompt = '', resourceSignature = '') {
    const h = createHash('sha1');
    h.update(text(node.type));
    h.update('\u0000');
    // 旧节点的 checkpoint 不再参与运行；统一图片配置变化则必须使缓存失效。
    const params = node.type === 'image'
        ? Object.fromEntries(Object.entries(node.params ?? {}).filter(([key]) => key !== 'model'))
        : node.params ?? {};
    h.update(JSON.stringify(params));
    if (node.type === 'image') h.update(`\u0000${imageSignature}\u0000image-prompt\u0000${imagePrompt}`);
    if (resourceSignature) h.update(`\u0000resources\u0000${resourceSignature}`);
    for (const up of upstreamHashes) h.update(`\u0000${text(up)}`);
    return h.digest('hex').slice(0, 16);
}

/** 目标节点 + 它所有上游,按依赖先后排好;有环就抛(画布上已禁止成环,这里是兜底)。 */
export function topoOrder(graph, target) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const incoming = new Map(graph.nodes.map((n) => [n.id, []]));
    for (const e of graph.edges ?? []) {
        if (byId.has(e.to) && byId.has(e.from)) incoming.get(e.to).push(e.from);
    }
    const out = [];
    const state = new Map();
    const visit = (id) => {
        const mark = state.get(id);
        if (mark === 'done') return;
        if (mark === 'visiting') throw new Error(`图里有环:${id}`);
        state.set(id, 'visiting');
        for (const from of incoming.get(id) ?? []) visit(from);
        state.set(id, 'done');
        out.push(byId.get(id));
    };
    if (target === undefined || target === null || target === '') {
        for (const n of graph.nodes) visit(n.id);
    } else {
        if (!byId.has(target)) throw new Error(`没有这个节点:${target}`);
        visit(target);
    }
    return out;
}

/**
 * 跑图。返回一句人话结果;每个节点的状态都写回 graph.runs。
 *
 * ⚠️ 外面这层 try/catch 是必需的:执行器里任何一处同步抛错(比如图里缺字段),
 * 在 async 函数里都会变成"被吞掉的 rejection" —— 现象就是"点了运行,什么都没发生",
 * 日志里也没有。所以异常一律记进 graph.lastError,让画布与 state API 都能看见。
 */
export async function runGraph(project, target, force = false, options = {}) {
    try {
        return await runGraphInner(project, target, force, options);
    } catch (error) {
        const message = text(error?.message ?? error);
        const graph = readGraph(project);
        graph.lastError = { message, stack: text(error?.stack).slice(0, 4000), at: Date.now() };
        writeGraph(project, graph);
        console.error(`[ai-drama] 跑图异常:${error?.stack ?? message}`);
        return `跑图异常:${message}`;
    }
}

/** 执行器的本体(拓扑 + 指纹缓存);异常交给上面的 runGraph 收尾。 */
async function runGraphInner(project, target, force = false, options = {}) {
    let graph = readGraph(project);
    graph.runs = { ...graph.runs };          // 执行中会就地改,先拷一份,避免污染别人手里的引用
    let order;
    try {
        order = await planSkillExecution(graph, target, force, options, topoOrder);
        graph = writeGraph(project, graph);
    } catch (error) {
        if (!error.nodeId) throw error;
        const message = text(error.message);
        graph.runs[error.nodeId] = { status: 'failed', error: message, at: Date.now() };
        writeGraph(project, graph);
        try { options.onNodeStatus?.({ nodeId: error.nodeId, status: 'failed' }); } catch { /* 进度不影响生成 */ }
        return `失败于「${error.nodeId}」:${message}`;
    }
    if (target && graph.nodes.find(node => node.id === target)?.type === 'skill') {
        return '技能按接收端需求启用，请运行连接的生成节点。';
    }
    const outputs = new Map();
    const hashes = new Map();
    const skillData = new Map();
    const inputGroups = new Map();
    const incomingOf = new Map(graph.nodes.map((n) => [n.id, []]));
    const sourceTitles = new Map(graph.nodes.map((n) => [n.id, n.title ?? typeOf(n.type)?.label ?? n.id]));
    for (const node of graph.nodes) {
        const type = typeOf(node.type);
        const groups = inputEdgeGroups(graph, node.id, type?.inputs?.length ?? 0, type?.multipleInputs);
        inputGroups.set(node.id, groups);
        incomingOf.set(node.id, type?.id === 'image'
            ? (groups[0] ?? []).map((edge) => edge.from)
            : type?.id === 'skill' ? (groups[0] ?? []).map(edge => edge.from)
                : type?.id === 'llm' ? [groups[0]?.[0]?.from ?? null]
                    : groups.map((group) => group[0]?.from ?? null));
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
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.trim() === '') return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

/** 只信本机:这是本地开发工具,不该被外部页面驱动。 */
export function isLoopback(request) {
    const address = request.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function statePayload(project) {
    // 注意:空串不能走 ??(它只挡 null/undefined)—— 前端首次加载就是空串,?? 会让它去读一个不存在的项目。
    const wanted = text(project).trim();
    const id = slug(wanted === '' ? (listProjects()[0] ?? 'default') : wanted);
    return { version: VERSION, root: rootDir(), projects: listProjects(), project: id, graph: readGraph(id), types: palette() };
}
