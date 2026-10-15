// AI 短剧工作台 · 出图后端
//
// 为什么单独一层:我**自己没有图像模型**,出图能力来自外部。而这台机器上"外部"至少有三种形态,
// 与其把某一种硬编进节点,不如做成适配器:
//   · comfyui  —— 本地/远程 ComfyUI,POST /prompt → 轮询 /history → GET /view 取图(模型是你装的 checkpoint)
//   · openai   —— 任何 OpenAI 兼容的 /v1/images/generations(base_url + key + 模型名)
//   · command  —— 自备脚本/命令行,--prompt / --out 占位,跑完检查文件是否真的出现
//
// 配置来源(前者优先):
//   · 环境变量:DSH_DRAMA_IMAGE_KIND / _BASE_URL / _API_KEY / _MODEL / _SIZE、DSH_DRAMA_COMFY_URL / _CHECKPOINT
//   · 文件    :<DSH_HOME>/ai-drama/backends.json
// 没有配置时**明确报"未配置"**,绝不假装成功 —— 一个假的成功比失败更难查。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_NEGATIVE = 'lowres, blurry, watermark, text, extra fingers, deformed hands, cartoon, 3d render';
const TIMEOUT_MS = 10 * 60 * 1000;

const text = (v) => (v === undefined || v === null ? '' : String(v));

export function configFile(rootDir) {
    return path.join(rootDir, 'backends.json');
}

/** 读配置:环境变量 > backends.json。永不抛(坏文件当没有)。 */
export function readImageConfig(rootDir) {
    let file = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(configFile(rootDir), 'utf8'));
        if (parsed !== null && typeof parsed === 'object') file = parsed.image ?? {};
    } catch { /* 没配过或坏了都当没配置 */ }
    const env = process.env;
    const kind = text(env.DSH_DRAMA_IMAGE_KIND).trim() || text(file.kind).trim();
    const comfy = file.comfyui ?? {};
    const openai = file.openai ?? {};
    const command = file.command ?? {};
    return {
        kind,
        comfyui: {
            baseUrl: text(env.DSH_DRAMA_COMFY_URL).trim() || text(comfy.baseUrl).trim() || 'http://127.0.0.1:8188',
            checkpoint: text(env.DSH_DRAMA_COMFY_CHECKPOINT).trim() || text(comfy.checkpoint).trim(),
            steps: Number(comfy.steps) || 24,
            cfg: Number(comfy.cfg) || 4.5,
            sampler: text(comfy.sampler).trim() || 'euler',
            scheduler: text(comfy.scheduler).trim() || 'normal',
            width: Number(comfy.width) || 1080,
            height: Number(comfy.height) || 1920,
            negative: text(comfy.negative) || DEFAULT_NEGATIVE,
        },
        openai: {
            baseUrl: text(env.DSH_DRAMA_IMAGE_BASE_URL).trim() || text(openai.baseUrl).trim(),
            apiKeyEnv: text(openai.apiKeyEnv).trim() || 'DSH_DRAMA_IMAGE_API_KEY',
            apiKey: text(env.DSH_DRAMA_IMAGE_API_KEY).trim() || text(openai.apiKey).trim(),
            model: text(env.DSH_DRAMA_IMAGE_MODEL).trim() || text(openai.model).trim(),
            size: text(env.DSH_DRAMA_IMAGE_SIZE).trim() || text(openai.size).trim() || '1080x1920',
        },
        command: {
            command: text(command.command).trim(),
            timeoutMs: Number(command.timeoutMs) || TIMEOUT_MS,
        },
    };
}

/** 保存配置(只写 image 段,保留文件里别的东西)。 */
export function writeImageConfig(rootDir, image) {
    let all = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(configFile(rootDir), 'utf8'));
        if (parsed !== null && typeof parsed === 'object') all = parsed;
    } catch { /* 新建 */ }
    all.image = { ...(all.image ?? {}), ...image };
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(configFile(rootDir), JSON.stringify(all, null, 2), 'utf8');
    return all.image;
}

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 出图目录。**传 dir 就用 dir** —— host 那边项目目录是 slug 化过的
 * (中文保留、`·` 变 `_`),后端自己按原始项目名拼会拼出第二个目录,
 * 图和 graph.json 就分家了(踩过)。
 */
function outDirFor(rootDir, project, dir) {
    const target = text(dir) !== '' ? text(dir) : path.join(rootDir, text(project) === '' ? 'default' : text(project), 'shots');
    fs.mkdirSync(target, { recursive: true });
    return target;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const mimeOf = (file) => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

function saveImageBuffer(dir, buffer, ext = 'png') {
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, buffer);
    return file;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------- comfyui

function comfyWorkflow(cfg, prompt, negative, batch) {
    // 最小可用的 txt2img 图:checkpoint → 正/负提示词 → 空 latent → KSampler → VAE 解码 → 保存
    return {
        4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: cfg.checkpoint } },
        5: { class_type: 'EmptyLatentImage', inputs: { width: cfg.width, height: cfg.height, batch_size: batch } },
        6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
        7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
        3: {
            class_type: 'KSampler',
            inputs: {
                seed: Math.floor(Math.random() * 1e15), steps: cfg.steps, cfg: cfg.cfg,
                sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1,
                model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
            },
        },
        8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
        9: { class_type: 'SaveImage', inputs: { filename_prefix: 'drama', images: ['8', 0] } },
    };
}

async function comfyuiStatus(cfg) {
    try {
        const response = await fetchWithTimeout(`${cfg.baseUrl}/system_stats`, {}, 5000);
        if (!response.ok) return { ok: false, detail: `ComfyUI 返回 ${response.status}` };
        const stats = await response.json().catch(() => ({}));
        const version = stats?.system?.comfyui_version ?? '未知版本';
        return {
            ok: true,
            detail: `ComfyUI ${version} 在线${cfg.checkpoint === '' ? ';但没配 checkpoint(节点参数里选,或写进 backends.json)' : `;checkpoint=${cfg.checkpoint}`}`,
        };
    } catch (error) {
        return { ok: false, detail: `连不上 ${cfg.baseUrl}(${text(error?.message ?? error)})—— ComfyUI 起了吗?` };
    }
}

async function comfyuiListModels(cfg) {
    const response = await fetchWithTimeout(`${cfg.baseUrl}/object_info/CheckpointLoaderSimple`, {}, 8000);
    const info = await response.json();
    const names = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    return Array.isArray(names) ? names : [];
}

async function comfyuiGenerate(cfg, prompt, batch, dir) {
    if (cfg.checkpoint === '') throw new Error('没配 checkpoint:请在 backends.json 写 image.comfyui.checkpoint,或把节点参数 model 填成 checkpoint 文件名');
    const queued = await fetchWithTimeout(`${cfg.baseUrl}/prompt`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: comfyWorkflow(cfg, prompt, cfg.negative, batch) }),
    }, 30000);
    if (!queued.ok) throw new Error(`ComfyUI /prompt 失败:HTTP ${queued.status} ${text(await queued.text()).slice(0, 300)}`);
    const { prompt_id: promptId } = await queued.json();

    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
        if (Date.now() > deadline) throw new Error('等 ComfyUI 出图超时(10 分钟)');
        await sleep(1200);
        const history = await fetchWithTimeout(`${cfg.baseUrl}/history/${promptId}`, {}, 15000);
        const record = (await history.json())?.[promptId];
        if (record === undefined) continue;
        const images = Object.values(record.outputs ?? {}).flatMap((o) => o.images ?? []);
        if (images.length === 0) throw new Error('ComfyUI 跑完了但没有图片输出(工作流里没有 SaveImage?)');
        const files = [];
        for (const image of images) {
            const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
            const view = await fetchWithTimeout(`${cfg.baseUrl}/view?${query}`, {}, 60000);
            if (!view.ok) continue;
            files.push(saveImageBuffer(dir, Buffer.from(await view.arrayBuffer()), image.filename.endsWith('.jpg') ? 'jpg' : 'png'));
        }
        return files;
    }
}

// ---------------------------------------------------------------- openai 兼容

async function openaiStatus(cfg) {
    if (cfg.baseUrl === '') return { ok: false, detail: '没配 baseUrl(backends.json 的 image.openai.baseUrl,或环境变量 DSH_DRAMA_IMAGE_BASE_URL)' };
    if (cfg.model === '') return { ok: false, detail: '没配模型名(backends.json 的 image.openai.model,或 DSH_DRAMA_IMAGE_MODEL)' };
    try {
        const headers = cfg.apiKey === '' ? {} : { authorization: `Bearer ${cfg.apiKey}` };
        const response = await fetchWithTimeout(`${cfg.baseUrl.replace(/\/$/, '')}/models`, { headers }, 8000);
        return response.ok
            ? { ok: true, detail: `服务在线;模型=${cfg.model}` }
            : { ok: false, detail: `服务返回 ${response.status}(模型名/密钥可能不对)` };
    } catch (error) {
        return { ok: false, detail: `连不上 ${cfg.baseUrl}(${text(error?.message ?? error)})` };
    }
}

async function openaiGenerate(cfg, prompt, batch, dir) {
    if (cfg.baseUrl === '') throw new Error('没配 baseUrl(DSH_DRAMA_IMAGE_BASE_URL 或 backends.json)');
    if (cfg.model === '') throw new Error('没配模型名(DSH_DRAMA_IMAGE_MODEL 或 backends.json)');
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey !== '') headers.authorization = `Bearer ${cfg.apiKey}`;
    const response = await fetchWithTimeout(`${cfg.baseUrl.replace(/\/$/, '')}/images/generations`, {
        method: 'POST', headers,
        body: JSON.stringify({ model: cfg.model, prompt, n: batch, size: cfg.size, response_format: 'b64_json' }),
    }, TIMEOUT_MS);
    if (!response.ok) throw new Error(`出图接口返回 HTTP ${response.status}:${text(await response.text()).slice(0, 400)}`);
    const payload = await response.json();
    const items = Array.isArray(payload?.data) ? payload.data : [];
    if (items.length === 0) throw new Error(`出图接口没有返回图片:${JSON.stringify(payload).slice(0, 300)}`);
    const files = [];
    for (const item of items) {
        if (typeof item?.b64_json === 'string' && item.b64_json !== '') {
            files.push(saveImageBuffer(dir, Buffer.from(item.b64_json, 'base64')));
        } else if (typeof item?.url === 'string' && item.url !== '') {
            const image = await fetchWithTimeout(item.url, {}, 120000);
            if (image.ok) files.push(saveImageBuffer(dir, Buffer.from(await image.arrayBuffer())));
        }
    }
    if (files.length === 0) throw new Error('出图接口的响应里既没有 b64_json 也没有可下载的 url');
    return files;
}

/**
 * 改图:把参考图 + 提示词交给 /images/edits。
 * 短剧里这条比生成更关键 —— **角色一致性**靠的就是"拿定妆图去改",而不是每次从零生成。
 * @param {string[]} referencePaths 参考图绝对路径(至少一张)
 */
async function openaiEdit(cfg, prompt, referencePaths, size, dir) {
    if (cfg.baseUrl === '') throw new Error('没配 baseUrl(DSH_DRAMA_IMAGE_BASE_URL 或 backends.json)');
    if (cfg.model === '') throw new Error('没配模型名(DSH_DRAMA_IMAGE_MODEL 或 backends.json)');
    if (referencePaths.length === 0) throw new Error('改图至少要一张参考图(把上游「画面生成」节点接过来,或在参数里写参考图路径)');
    const form = new FormData();
    for (const file of referencePaths) {
        if (!fs.existsSync(file)) throw new Error(`参考图不存在:${file}`);
        form.append('image[]', new Blob([fs.readFileSync(file)], { type: mimeOf(file) }), path.basename(file));
    }
    form.append('model', cfg.model);
    form.append('prompt', prompt);
    if (size !== '') form.append('size', size);

    const headers = cfg.apiKey === '' ? {} : { authorization: `Bearer ${cfg.apiKey}` };
    const response = await fetchWithTimeout(`${cfg.baseUrl.replace(/\/$/, '')}/images/edits`, { method: 'POST', headers, body: form }, TIMEOUT_MS);
    if (!response.ok) throw new Error(`改图接口返回 HTTP ${response.status}:${text(await response.text()).slice(0, 400)}`);
    const payload = await response.json();
    const items = Array.isArray(payload?.data) ? payload.data : [];
    if (items.length === 0) throw new Error(`改图接口没有返回图片:${JSON.stringify(payload).slice(0, 300)}`);
    const files = [];
    for (const item of items) {
        if (typeof item?.b64_json === 'string' && item.b64_json !== '') files.push(saveImageBuffer(dir, Buffer.from(item.b64_json, 'base64')));
        else if (typeof item?.url === 'string' && item.url !== '') {
            const image = await fetchWithTimeout(item.url, {}, 120000);
            if (image.ok) files.push(saveImageBuffer(dir, Buffer.from(await image.arrayBuffer())));
        }
    }
    if (files.length === 0) throw new Error('改图接口的响应里既没有 b64_json 也没有可下载的 url');
    return files;
}

// ---------------------------------------------------------------- 自备命令

function runCommand(command, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
            { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => (error === null || error === undefined ? resolve(text(stdout)) : reject(new Error(text(error.message)))));
    });
}

async function commandGenerate(cfg, prompt, batch, dir) {
    if (cfg.command === '') throw new Error('没配命令(backends.json 的 image.command.command)');
    const files = [];
    for (let i = 0; i < batch; i += 1) {
        const out = path.join(dir, `${Date.now().toString(36)}-${i}.png`);
        const line = cfg.command.split('{{prompt}}').join(prompt.split('"').join('\\"')).split('{{out}}').join(out);
        await runCommand(line, dir, cfg.timeoutMs || TIMEOUT_MS);
        if (!fs.existsSync(out)) throw new Error(`命令跑完了但没生成文件:${out}`);
        files.push(out);
    }
    return files;
}

// ---------------------------------------------------------------- 对外

export async function imageStatus(rootDir) {
    const cfg = readImageConfig(rootDir);
    if (cfg.kind === '') {
        return {
            kind: '', ok: false,
            detail: '还没配出图后端。三种任选:comfyui(本地 ComfyUI)/ openai(OpenAI 兼容的 images API)/ command(自备命令)。',
            configFile: configFile(rootDir),
        };
    }
    const probe = cfg.kind === 'comfyui' ? await comfyuiStatus(cfg.comfyui)
        : cfg.kind === 'openai' ? await openaiStatus(cfg.openai)
            : { ok: cfg.command.command !== '', detail: cfg.command.command === '' ? '没配命令' : '命令已配置(跑一次才知道通不通)' };
    return { kind: cfg.kind, ...probe, configFile: configFile(rootDir) };
}

export async function imageListModels(rootDir) {
    const cfg = readImageConfig(rootDir);
    if (cfg.kind !== 'comfyui') return [];
    try { return await comfyuiListModels(cfg.comfyui); } catch { return []; }
}

/**
 * 出图。返回 { files, detail }。失败一律抛错(节点会标红),不返回"看起来成功"的占位。
 * @param {string} rootDir 插件根目录
 * @param {{project:string, prompt:string, batch?:number, checkpoint?:string}} options
 */
export async function imageGenerate(rootDir, options) {
    const cfg = readImageConfig(rootDir);
    const batch = Math.max(1, Math.min(8, Number(options.batch) || 1));
    const dir = outDirFor(rootDir, options.project, options.dir);
    if (cfg.kind === '') throw new Error('没配出图后端:先在画布上配 comfyui / openai / command 之一(见 backends.json)');
    const prompt = text(options.prompt).trim();
    if (prompt === '') throw new Error('提示词是空的:把上游文本接到这个节点,或在节点参数里写 prompt');
    if (cfg.kind === 'comfyui') {
        const comfy = { ...cfg.comfyui };
        if (text(options.checkpoint).trim() !== '') comfy.checkpoint = text(options.checkpoint).trim();
        return { files: await comfyuiGenerate(comfy, prompt, batch, dir), detail: `comfyui · ${comfy.checkpoint} · ${comfy.width}x${comfy.height} · ${batch} 张` };
    }
    if (cfg.kind === 'openai') {
        return { files: await openaiGenerate(cfg.openai, prompt, batch, dir), detail: `openai 兼容接口 · ${cfg.openai.model} · ${cfg.openai.size} · ${batch} 张` };
    }
    if (cfg.kind === 'command') {
        return { files: await commandGenerate(cfg.command, prompt, batch, dir), detail: `自备命令 · ${batch} 张` };
    }
    throw new Error(`不认识的出图后端:${cfg.kind}(可选 comfyui / openai / command)`);
}

/**
 * 改图(参考图 → 新画面)。目前只有 openai 型后端支持;
 * comfyui 要走 img2img 工作流,等接上再说 —— 这里明确报错,不做"假装改过"。
 * @param {string} rootDir
 * @param {{project:string, prompt:string, reference?:string[]|string, size?:string, dir?:string}} options
 */
export async function imageEdit(rootDir, options) {
    const cfg = readImageConfig(rootDir);
    const dir = outDirFor(rootDir, options.project, options.dir);
    const prompt = text(options.prompt).trim();
    if (prompt === '') throw new Error('提示词是空的:改图也要说清要改成什么');
    const raw = Array.isArray(options.reference) ? options.reference : text(options.reference).split(/\r?\n/);
    const references = raw.map((entry) => text(entry).trim()).filter((entry) => entry !== '')
        .map((entry) => (path.isAbsolute(entry) ? entry : path.join(dir, entry)));
    if (cfg.kind === 'openai') {
        const files = await openaiEdit(cfg.openai, prompt, references, text(options.size).trim() || cfg.openai.size, dir);
        return { files, detail: `改图 · ${cfg.openai.model} · 参考图 ${references.length} 张` };
    }
    if (cfg.kind === '') throw new Error('没配出图后端');
    throw new Error(`当前后端(${cfg.kind})还不支持改图:改图需要 OpenAI 兼容的 /images/edits,或 ComfyUI 的 img2img 工作流`);
}