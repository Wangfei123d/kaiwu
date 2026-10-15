// 黏贴截图:剪贴板图片的**校验与组装**。
//
// 为什么单独一个文件、而且全是纯函数:这一张图要从**渲染进程**跨 IPC 到**主进程**,
// 再从主进程过 ACP 的线上协议。三处都要判同一件事(什么能收、什么必须拒、拒了
// 说哪一句中文),各写一份迟早会不一致 —— 而"两边判得不一样"的表现正是最难查的那种:
// 界面说能发、主进程悄悄拒,或者反过来。所以判据只有这一份:
//   渲染层拿它做**即时反馈**(粘下去就知道行不行),主进程拿它做**权威校验**。
//
// ⚠️ 这个文件同时被浏览器(渲染进程)与 Node(主进程/单测)加载,所以
// **不许 import 任何 node: 内置模块**。base64 走"有 Buffer 用 Buffer、没有用 btoa"。
//
// 线上的形状(与装机那份桥对齐,见 dsh-acp/lib/index.js 的 decodeImage):
//   { type:'image', mimeType, data }   data 必须是**规范化 base64**(RFC 4648,
//   带 = 补位、不许有换行、不许 URL-safe 别名),mimeType 只认四种光栅格式。

/** ACP 图片块接受的 MIME(与 dsh-acp 的 IMAGE_MEDIA_TYPES 逐字一致)。 */
export const IMAGE_MIME_TYPES = Object.freeze([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
]);

/** 写进中文原因里的那半句"只支持……"。 */
export const IMAGE_MIME_LABEL = 'PNG / JPEG / WebP / GIF';

/**
 * 单张图的上限。10 MiB。
 *
 * 为什么不是"越小越好":截图(PNG)常见就是 1–5 MB,卡在 1 MB 会让这个功能在
 * 最典型的场景上直接不可用 —— 而"拒掉用户唯一想发的那张图"比慢一点糟得多。
 * 这个值同时是**过 IPC 的上限**:IPC 走结构化克隆传二进制,不膨胀 33%,
 * 10 MiB 的图过一趟是可以接受的;真正会被打爆的是 base64(那一步只在主进程里,
 * 进 ACP 线上时报文本来就得是 base64,躲不掉,所以由下面的总量封顶)。
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 一次提示里所有图片加起来的字节上限。20 MiB。 */
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

/** 一次提示最多几张图。 */
export const MAX_IMAGES_PER_PROMPT = 4;

/** 过 IPC 时每个图片条目里的字段名(渲染进程只递这几个叶子字段)。 */
export const IMAGE_PAYLOAD_FIELDS = Object.freeze(['mimeType', 'bytes']);

/** 人类可读的字节数。用于"超限了"那几句原因 —— 必须能一眼看懂差多少。 */
export function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '未知大小';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 把剪贴板给的 type 收敛成白名单里的那一个。
 *
 * 宽松的地方只有两处,都是有意的:`image/jpg` 是现实里常见的别名,归一到
 * `image/jpeg`;`;charset=...` 这类参数剪掉。其余一律返回空串(调用方据此拒绝)。
 */
export function normalizeImageMime(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === '') return '';
    const bare = raw.split(';')[0].trim();
    const canonical = bare === 'image/jpg' ? 'image/jpeg' : bare;
    return IMAGE_MIME_TYPES.includes(canonical) ? canonical : '';
}

/** 声明之外的**兜底**判据:字节开头那几笔是不是真的这个格式。 */
export function sniffImageMime(bytes) {
    const at = (i) => (bytes !== null && i < bytes.length ? bytes[i] : -1);
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
        && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png';
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
    const ascii = (start) => {
        let out = '';
        for (let i = start; i < start + 4; i += 1) {
            const b = at(i);
            if (b < 0) return '';
            out += String.fromCharCode(b);
        }
        return out;
    };
    if (ascii(0) === 'RIFF' && ascii(8) === 'WEBP') return 'image/webp';
    return '';
}

/**
 * 渲染进程递来的 `bytes` 收敛成 Uint8Array;不是字节就返回 null。
 *
 * 三种形状都收:ArrayBuffer、TypedArray/DataView(IPC 结构化克隆可能给成
 * Uint8Array)、以及普通数字数组(手写的假桥/测试会这么递)。
 */
function toBytes(value) {
    if (value === null || value === undefined) return null;
    if (typeof ArrayBuffer !== 'undefined') {
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
    }
    if (Array.isArray(value)) {
        const out = new Uint8Array(value.length);
        for (let i = 0; i < value.length; i += 1) {
            const n = value[i];
            if (!Number.isInteger(n) || n < 0 || n > 255) return null;
            out[i] = n;
        }
        return out;
    }
    return null;
}

/** 一份候选图的判据(渲染层的即时反馈与主进程的权威校验共用这一处)。 */
function checkCandidate({ mimeType, byteLength, existingBytes = 0, existingCount = 0 } = {}) {
    if (existingCount >= MAX_IMAGES_PER_PROMPT) {
        return {
            ok: false,
            reason: `一次最多发 ${MAX_IMAGES_PER_PROMPT} 张图,已经选了 ${existingCount} 张,这一张被拒绝`,
        };
    }
    const canonical = normalizeImageMime(mimeType);
    if (canonical === '') {
        return {
            ok: false,
            reason: `不支持的图片格式“${String(mimeType ?? '').trim() || '(没有类型)'}”`
                + `——只接受 ${IMAGE_MIME_LABEL}`,
        };
    }
    if (!Number.isFinite(byteLength) || byteLength < 0) {
        return { ok: false, reason: `这张图报不出大小,无法确认能不能发,已拒绝` };
    }
    if (byteLength === 0) {
        return { ok: false, reason: `这张图是空的(0 字节),已拒绝` };
    }
    if (byteLength > MAX_IMAGE_BYTES) {
        return {
            ok: false,
            reason: `这张图 ${formatBytes(byteLength)},超过单张上限 ${formatBytes(MAX_IMAGE_BYTES)},已拒绝`,
        };
    }
    if (existingBytes + byteLength > MAX_TOTAL_IMAGE_BYTES) {
        return {
            ok: false,
            reason: `再加这张(${formatBytes(byteLength)})会超过一次发送的总量上限 `
                + `${formatBytes(MAX_TOTAL_IMAGE_BYTES)}(已选 ${formatBytes(existingBytes)}),已拒绝`,
        };
    }
    return { ok: true, mimeType: canonical };
}

/**
 * 渲染层的即时判断:这一张能不能加进待发列表。
 *
 * @param {{mimeType?:string, byteLength?:number, existing?:Array<{byteLength?:number}>}} input
 * @returns {{ok:true, mimeType:string} | {ok:false, reason:string}}
 */
export function validateImageCandidate({ mimeType, byteLength, existing } = {}) {
    const list = Array.isArray(existing) ? existing : [];
    let bytes = 0;
    for (const item of list) {
        const n = Number(item?.byteLength);
        if (Number.isFinite(n) && n > 0) bytes += n;
    }
    return checkCandidate({ mimeType, byteLength, existingBytes: bytes, existingCount: list.length });
}

/**
 * 主进程侧的**权威**校验:把渲染进程递来的叶子数据收成可用的图片。
 *
 * 渲染进程是不可信输入(截图来自剪贴板),所以这里**从头再判一遍**:类型白名单、
 * 单张与总量上限、张数上限,还要看字节开头那几笔是不是真的那个格式 ——
 * 渲染进程说 `image/png` 不算数。
 *
 * @param {unknown} raw
 * @returns {{ok:true, images:Array<{mimeType:string, bytes:Uint8Array}>} | {ok:false, reason:string}}
 */
export function admitImagePayload(raw) {
    if (raw === undefined || raw === null) return { ok: true, images: [] };
    if (!Array.isArray(raw)) return { ok: false, reason: 'images 必须是一个数组' };
    if (raw.length === 0) return { ok: true, images: [] };
    if (raw.length > MAX_IMAGES_PER_PROMPT) {
        return {
            ok: false,
            reason: `一次最多发 ${MAX_IMAGES_PER_PROMPT} 张图,收到 ${raw.length} 张,已拒绝`,
        };
    }

    const images = [];
    let total = 0;
    for (let i = 0; i < raw.length; i += 1) {
        const position = i + 1;
        const item = raw[i];
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            return { ok: false, reason: `第 ${position} 张图不是一个对象,已拒绝` };
        }
        const bytes = toBytes(item.bytes);
        if (bytes === null) {
            return { ok: false, reason: `第 ${position} 张图的字节不是一个字节数组,已拒绝` };
        }
        const verdict = checkCandidate({
            mimeType: item.mimeType,
            byteLength: bytes.byteLength,
            existingBytes: total,
            existingCount: images.length,
        });
        if (verdict.ok !== true) return { ok: false, reason: `第 ${position} 张图:${verdict.reason}` };

        const sniffed = sniffImageMime(bytes);
        if (sniffed === '') {
            return {
                ok: false,
                reason: `第 ${position} 张图声明是 ${verdict.mimeType},但字节不是 `
                    + `${IMAGE_MIME_LABEL},已拒绝`,
            };
        }
        if (sniffed !== verdict.mimeType) {
            return {
                ok: false,
                reason: `第 ${position} 张图声明是 ${verdict.mimeType},字节其实是 ${sniffed},已拒绝`,
            };
        }
        total += bytes.byteLength;
        images.push({ mimeType: verdict.mimeType, bytes });
    }
    return { ok: true, images };
}

/** 规范化 base64(RFC 4648,带 = 补位)。桥那边会逐字比对,所以不许有换行/别名。 */
export function toCanonicalBase64(bytes) {
    const view = toBytes(bytes);
    if (view === null) throw new Error('toCanonicalBase64 需要一个字节数组');
    const B = globalThis.Buffer;
    if (B !== undefined && typeof B.from === 'function') {
        return B.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
    }
    const btoaFn = globalThis.btoa;
    if (typeof btoaFn !== 'function') throw new Error('这个环境里没有 base64 编码器');
    // 分块:一次 fromCharCode 传几万个参数会把调用栈撑爆(真踩过)。
    // ⚠️ 块长**必须是 3 的倍数**:base64 是"3 字节 → 4 字符",非 3 倍数的块会被独立补
    // `=`,拼起来就多出中间的填充符(整个串变成非法 base64)。0x1FFE = 8190 = 3×2730。
    const CHUNK = 0x1FFE;
    let out = '';
    for (let i = 0; i < view.length; i += CHUNK) {
        const slice = view.subarray(i, Math.min(i + CHUNK, view.length));
        let binary = '';
        for (let j = 0; j < slice.length; j += 1) binary += String.fromCharCode(slice[j]);
        out += btoaFn(binary);
    }
    // 最后一块的填充是**对的**(它确实是最后一块);中间的块因为对齐到 3 字节而不会补位。
    return out;
}

/**
 * 组装 ACP `session/prompt` 的 prompt 数组。
 *
 * 形状(与桥的 admitAcpPrompt/decodeImage 对齐):
 *   文本块 `{ type:'text', text }`  —— 非空文本才有;**有图没字也合法**
 *   图片块 `{ type:'image', mimeType, data }` —— data 是规范化 base64
 *
 * ⚠️ 纯文本那条路必须**逐字节不变**:没有图片时输出的就是 `[{type:'text',text}]`,
 * 与从前手写的那一行完全相同。
 *
 * @param {{text?:string, images?:Array<{mimeType?:string, bytes?:unknown}>}} input
 * @returns {{ok:true, blocks:Array<object>} | {ok:false, reason:string}}
 */
export function buildAcpPromptBlocks({ text, images } = {}) {
    const admitted = admitImagePayload(images);
    if (admitted.ok !== true) return { ok: false, reason: admitted.reason };

    const blocks = [];
    const body = typeof text === 'string' ? text : '';
    if (body !== '') blocks.push({ type: 'text', text: body });
    for (const image of admitted.images) {
        blocks.push({
            type: 'image',
            mimeType: image.mimeType,
            data: toCanonicalBase64(image.bytes),
        });
    }
    if (blocks.length === 0) return { ok: false, reason: '提示内容不能为空' };
    return { ok: true, blocks };
}

/**
 * 从 `initialize` 的结果里取出对端广告的能力(叶子字段)。
 *
 * ⚠️ **缺失就是"没有"**:ACP 里 `promptCapabilities` 的字段是可选的,没写 `image`
 *    就等于不收内联图片 —— 装机那份桥正是 `image:false`(见下面 imagePromptFailureHint)。
 *
 * @param {object} result initialize 的返回值
 * @returns {{image:boolean, audio:boolean, embeddedContext:boolean}|null} 认不出来返回 null
 */
export function promptCapabilitiesOf(result) {
    const caps = result?.agentCapabilities?.promptCapabilities;
    if (caps === null || caps === undefined || typeof caps !== 'object') return null;
    return {
        image: caps.image === true,
        audio: caps.audio === true,
        embeddedContext: caps.embeddedContext === true,
    };
}

/**
 * 发图之前的那句拒绝理由(能直接给用户看)。
 *
 * 为什么要单独一个纯函数:主进程(最后一道闸)与界面(pre-flight 先拦)必须说
 * **同一句话** —— 各写一份文案迟早分叉,而用户看到的就是"两次说法不一样"。
 *
 * @param {{image:boolean}|null} caps
 * @param {string} [model] 当前会话钉的模型 id(拿得到就写进句子,用户才知道该换哪个)
 */
export function imageCapabilityRefusal(caps, model = '') {
    const name = String(model ?? '').trim();
    const who = name === '' ? '当前模型' : `当前模型(${name})`;
    // caps 为 null 表示"还不知道",那种情况不该走到这里 —— 调用方只在明确 false 时拒绝。
    // ⚠️ 文案里**不列**"换哪个模型":用户很可能**已经**换好了(图片能力是连接建立时确定的,
    //    换完要重连才生效),再推荐一遍就成了嘲讽。要说的是那一步动作。
    return `${who}不接受图片输入 —— 图片能力是**建立连接时**确定的(这条连接握手时声明了 `
        + 'promptCapabilities.image=false),换模型之后要**重连**才会生效。'
        + '点胶囊里的「重连以启用图片」,或者把图片里的内容用文字描述给它。';
}

/**
 * 把桥/附件存储拒绝图片时那句英文，翻成一句能读的中文。
 *
 * 为什么要它:装机那份 acp profile 钉的模型是 `deepseek-v4-flash`,而它在
 * dsh-llm-deepseek 的目录里**没有**声明 `inputModalities:['text','image']` ——
 * 于是桥在 initialize 时广告 `promptCapabilities.image = false`(实测过),
 * 带图片的提示会被它当场以 -32602 拒掉,原文是
 * `inline image prompts were not advertised by this connection`。
 * 那句英文对用户等于没说,所以这里给它一个中文出口(不是掩盖:原因照说,而且给出下一步)。
 *
 * @param {string} message
 * @returns {string|null} 认不出来就返回 null(调用方照旧用原文)
 */
export function imagePromptFailureHint(message) {
    const raw = String(message ?? '');
    if (raw === '') return null;
    if (/not advertised by this connection/i.test(raw)) {
        return '这条 Agent 连接没有广告图片能力(initialize 时 promptCapabilities.image=false),'
            + '图片被拒绝。当前钉的模型路由大概不支持图片输入 —— '
            + '换成支持图片的模型再试。';
    }
    if (/does not declare image input/i.test(raw)) {
        return '当前模型路由没有声明支持图片输入,图片被拒绝。换成支持图片的模型再试。';
    }
    if (/no attachment store is mounted/i.test(raw)) {
        return 'Agent 那边没有挂载附件存储,图片无处安放,被拒绝。';
    }
    return null;
}

/**
 * 剥掉 Electron 给 IPC 错误加的那层壳。
 *
 * 主进程里抛出的错误经 `ipcRenderer.invoke` 回来时会被裹成
 * `Error invoking remote method 'agent:send': Error: 真正的原因` —— 前半段是**通道名**,
 * 对用户等于噪声。实测那条超时提示就长这样:
 * `这次没能发出去:Error invoking remote method 'agent:send': Error: 提示超时(180000ms …)`
 * 重点被埋在了中间。
 *
 * 为什么放在这里(而不是 preload 的 invoke 里):preload 是 CJS、加进去就没有测试落点,
 * 而"把桥的壳层话翻成人话"正是这个模块的职责。认不出那个形状就**原样返回** ——
 * 绝不吞掉真原因(宁可留一句长的,也不能显示一句空话)。
 *
 * @param {string} message
 * @returns {string}
 */
export function stripIpcWrapper(message) {
    const raw = String(message ?? '');
    // 只剥开头这一层:`Error invoking remote method '<频道>': ` 以及紧随其后的 `Error: `。
    // 频道名用单引号括着、里面不会有单引号,所以 [^']* 足够。
    return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
