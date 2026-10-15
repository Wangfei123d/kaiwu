// 视频理解:请求体构造、体积→投递路径分发、错误映射、附件判据。
//
// 为什么全是**纯函数**、而且和 agent-image.js 一样不许 import 任何 node: 内置模块:
// 这份判据有**三个**消费方 —— 渲染层(拖进来时的即时反馈)、主进程(权威校验)、
// 以及单测。三处各写一份,迟早分叉;而分叉的表现恰恰是最难查的那种:界面说能发、
// 主进程悄悄拒,或者反过来。
//
// 架构前提(实测过,不是推测):本机 ffmpeg 被系统策略拦着,所以**不存在**"本地抽帧
// 再送图"这条路。整段视频直接给服务端,抽帧由 DashScope 做。于是这里的一切都围绕
// "怎么把一个视频文件送到那个端点"来设计。
//
// 实测事实(2026-xx,真实 API 调用,证据留在交付报告里):
//   · 端点 https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions,
//     Bearer 鉴权,与图片同一条路(所以图/视频不写两套)。
//   · 内联 base64 走 `data:video/mp4;base64,...`;**上限是服务端给的**
//     "Exceeded limit on max bytes per data-uri item : 20971520"。边界是逐点量出来的:
//     原始 15 MiB(= base64 恰好 20,971,520 字节,加上 22 字节前缀共 20,971,542)
//     **通过**;原始 15.7 MiB(base64 21,950,192)与 16 MiB(base64 22,369,646)被 400 拒。
//     所以判据落在 **base64 那一段**上(`4*ceil(n/3) <= 20971520`),不是整条 data-uri。
//   · `video_url.fps` **被服务端静默忽略**:fps=1 / fps=2 / 不传,video_tokens 完全相同
//     (1080p 4 秒都是 2378)。所以这里不提供 fps 参数,界面上也不暴露这个选项 ——
//     暴露一个不起作用的旋钮只会让人以为自己能控成本。
//   · 该模型**不支持音轨**。界面必须如实说明,不能让用户以为它听懂了对话。
//   · 大文件兜底那条路(**整条实测通过**):先 `GET /api/v1/uploads?action=getPolicy&model=…`
//     拿上传凭证,再 multipart POST 到 `upload_host`,最后用 `oss://<upload_dir>/<文件名>`
//     作为 video_url —— 但要**额外带上头部** `X-DashScope-OssResourceResolve: enable`,
//     不带它服务端根本不去解析 oss://,回的是
//     "The provided URL does not appear to be valid"(实测踩到)。

import { formatBytes, toCanonicalBase64 } from './agent-image.js';

/** 接受的视频容器。与 DashScope 的文档口径一致,但**只有 MP4 是实测跑通的**。 */
export const VIDEO_MIME_TYPES = Object.freeze([
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
]);

/** 写进中文原因里的那半句"只支持……"。 */
export const VIDEO_MIME_LABEL = 'MP4 / MOV / WebM / MKV';

/**
 * **拖入/粘贴**这条入口的单段上限。64 MiB。
 *
 * ⚠️ 这个数管的是**过 IPC 的量**,不是服务端的限制 —— 拖入/粘贴时字节要从渲染进程
 * 结构化克隆进主进程(不膨胀 33%,但一次几 GB 的拷贝会把界面卡住),所以这条入口
 * 必须自己封顶。64 MiB 覆盖"手机随手拍一段一分钟"这个最典型的使用。
 *
 * ⚠️ **已经知道本地路径的场景不要用这个数** —— 队列里下好的文件走
 * `video:understandPath`(主进程**按路径自己读盘**,IPC 只传路径字符串),
 * 那条入口的上限是 `MAX_LOCAL_VIDEO_BYTES`(1024 MB)。文档见下面那个常量。
 */
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

/**
 * **已知本地路径**这条入口的单段上限。1024 MB。
 *
 * 出处:实测上游的 `GET /api/v1/uploads?action=getPolicy` 返回
 * `data.max_file_size_mb = 1024`(2026-09-19,真实调用)。也就是说这是**服务端自己
 * 报出来的**单文件上限,不是我们拍的;我们只是把渲染进程那条 IPC 限制挪开,让
 * 已经落在磁盘上的文件能直接走"临时上传"这条路。
 *
 * 为什么值得为它上传了(这段结论是**改过的**):上一版写着"不值得为一次理解上传",
 * 那是在拿不到本地文件名的情况下写的 —— 那时要把 169 MB 先过一遍 IPC 才能上传,
 * 代价(内存/卡界面)远超收益。现在队列能把本地路径给出来,主进程只读一次盘、
 * 流式发给 OSS,瓶颈只剩上行带宽;而理解一段 8 分钟 1080p60 的成本约 ¥0.045
 * (实测 1080p ≈ 594 token/秒,508 秒 ≈ 30 万 token,flash 单价),这个交换划算。
 */
export const MAX_LOCAL_VIDEO_BYTES = 1024 * 1024 * 1024;

/** 按路径那条入口允许的扩展名(容器白名单的等价物;路径上没有 MIME,只能看后缀)。 */
export const VIDEO_FILE_EXTENSIONS = Object.freeze(['.mp4', '.mov', '.webm', '.mkv']);

/**
 * 服务端对**单个 data-uri 项里 base64 那一段**的字节上限。实测值:错误原文
 * `Exceeded limit on max bytes per data-uri item : 20971520`,边界见文件头。
 */
export const MAX_DATA_URI_BYTES = 20 * 1024 * 1024;

/**
 * 内联判定的安全余量。1 MiB。
 *
 * 为什么不留到"刚好贴着 20 MiB":那个上限是**服务端实现里的一个数字**,不是
 * 契约;贴边就是"某天它调小一点点,今天能发的视频明天就发不出去,而且报的还是
 * 一句英文"。留 1 MiB 余量后,超过它的文件走临时上传那条路 —— 多花一次 HTTP,
 * 换来一个不会突然失效的判据。
 */
export const INLINE_SAFETY_MARGIN_BYTES = 1024 * 1024;

/** 一次只理解**一段**视频。要比较两段就分两次问。 */
export const MAX_VIDEOS_PER_PROMPT = 1;

/** 提问长度上限(UTF-16 码元)。超了截断并**明说**,不静默丢。 */
export const MAX_QUESTION_CHARS = 2000;

/** 用户没写提问时用这一句。它决定了返回的详略,所以要具体,不要"描述这个视频"。 */
export const DEFAULT_VIDEO_QUESTION =
    '用中文详细描述这段视频:画面里有哪些物体(颜色、位置),发生了什么,物体怎么移动。';

/**
 * 音轨说明。**界面必须显示它** —— 这个模型只看画面。
 * 不说这一句,用户会拿着一段"有人在讲解"的视频,对着一份只描述画面的答案
 * 以为模型听漏了,或者更糟:以为它听懂了然后照着它的"理解"去用。
 */
export const VIDEO_AUDIO_NOTICE =
    '注意:这个模型只看画面、听不到声音 —— 对话、旁白与背景音乐都不在理解范围内。';

/** 这个账号上实测可用的两个模型。别的名字会被服务端以 404 拒掉。 */
export const VIDEO_MODELS = Object.freeze([
    { id: 'qwen3-vl-flash', label: 'qwen3-vl-flash(便宜、快)' },
    { id: 'qwen3-vl-plus', label: 'qwen3-vl-plus(更强)' },
]);

/** 默认模型。便宜快,适合"先看一眼这段视频是什么"。 */
export const DEFAULT_VIDEO_MODEL = 'qwen3-vl-flash';

/** 默认输出上限。800 够一段详细描述,又不至于让一次误触很贵。 */
export const DEFAULT_MAX_TOKENS = 800;

/** 模型名白名单校验。渲染进程递来的模型名必须落在这一份里(它进请求体,不可信)。 */
export function normalizeVideoModel(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return VIDEO_MODELS.some(m => m.id === raw) ? raw : '';
}

// ---------- 密钥卡片上的那几句文案 ----------

/**
 * **环境变量赢了**那一句。这是配置卡上最重要的一句话。
 *
 * 为什么单独抽出来、而且必须有:主进程里 `resolveSecret()` 的顺序是
 * **环境变量 > 设置文件**,所以当用户已经把 `DASHSCOPE_API_KEY` 设在环境里时,
 * 他在界面上保存的那把密钥**根本不生效**。不说这一句,用户就会存了、看着卡片
 * 说"已保存"、然后继续被环境变量那把(可能是旧的、别人的)密钥决定行为 ——
 * 这正是最招人恨的那类静默行为。宁可啰嗦,也要把它写在卡片上。
 */
export const VIDEO_KEY_ENV_NOTICE =
    '⚠ 当前用的是环境变量 DASHSCOPE_API_KEY —— 环境变量优先,在这里保存的密钥不会生效。'
    + '要让它生效,先去掉那个环境变量(或改成正确的那把)再重启开物。';

/** 明文存储那一句。说清后果,而不是含糊地叫"已保存"。 */
export const VIDEO_KEY_PLAIN_NOTICE =
    '这一份存进开物的设置文件,是明文 —— 能读到那个文件的人就能读到密钥。'
    + '要更安全,可以用环境变量,或者让系统加密可用(safeStorage)。';

/**
 * 把 `video:status` 那几个叶子字段翻成卡片上的读数。**纯函数**,所以文案本身
 * 可以被单测逐字钉住(而不是"我写的代码看起来会显示它")。
 *
 * ⚠️ 入参只有叶子字段,返回值里也只有文案 —— 这个函数**没有**、也**不该有**
 * 任何机会碰到密钥值:它的输入里根本不存在那个字段。
 *
 * @param {{ok?:boolean, source?:string|null, storage?:string|null}} input
 * @returns {{configured:boolean, fromEnv:boolean, fromSettings:boolean,
 *            label:string, storageLabel:string, envWins:boolean,
 *            warning:string, detail:string}}
 */
export function describeVideoKeyStatus({ ok, source, storage } = {}) {
    const src = String(source ?? '').trim();
    const st = String(storage ?? '').trim();
    const configured = ok === true;
    const fromEnv = configured && src === 'env';
    const fromSettings = configured && src === 'settings';
    const storageLabel = st === 'encrypted' ? '系统加密' : (st === 'plain' ? '明文' : '');
    const label = !configured
        ? '未配置'
        : (fromEnv ? '已配置(环境变量)' : (fromSettings ? '已配置(设置文件)' : '已配置'));
    return {
        configured,
        fromEnv,
        fromSettings,
        label,
        storageLabel,
        envWins: fromEnv,
        warning: fromEnv ? VIDEO_KEY_ENV_NOTICE : '',
        // 明文只在"真的用着设置文件里那一份"时提醒:环境变量赢的时候它没生效,
        // 再说一遍明文风险只会把卡片弄乱。
        detail: (fromSettings && storageLabel === '明文') ? VIDEO_KEY_PLAIN_NOTICE : '',
    };
}

// ---------- MIME 与字节判据 ----------

/**
 * 把浏览器/系统给的 type 收敛成白名单里的那一个。
 *
 * 宽松的地方只有两处,都是有意的:`video/x-m4v` 与 `video/quicktime` 归一到
 * 各自的规范名(`video/mp4` / `video/quicktime`);`;codecs=...` 这类参数剪掉。
 * 其余一律返回空串(调用方据此拒绝),不猜。
 */
export function normalizeVideoMime(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === '') return '';
    const bare = raw.split(';')[0].trim();
    // `video/x-m4v` 是现实里常见的别名(macOS/QuickTime 会给这个),内容是 MP4 容器。
    const canonical = bare === 'video/x-m4v' ? 'video/mp4' : bare;
    return VIDEO_MIME_TYPES.includes(canonical) ? canonical : '';
}

/**
 * 声明之外的**兜底**判据:字节开头那几笔是不是真的这个容器。
 *
 * 为什么非要有它:渲染进程递来的东西是不可信的(何况"拖进来的文件"是用户本机的
 * 任意文件)。只信声明的话,把 `evil.html` 改名成 `x.mp4` 再声明 `video/mp4`
 * 也能过;而把它当视频发给第三方服务,是**外发**了不该外发的字节。
 * 判据只认容器签名,不去解析内容 —— 解析器本身就是一个攻击面,这里不需要。
 */
export function sniffVideoMime(bytes) {
    const at = (i) => (bytes !== null && bytes !== undefined && i < bytes.length ? bytes[i] : -1);
    const ascii = (start, len) => {
        let out = '';
        for (let i = start; i < start + len; i += 1) {
            const b = at(i);
            if (b < 0) return '';
            out += String.fromCharCode(b);
        }
        return out;
    };
    // ISO BMFF(MP4 / MOV):第 5–8 个字节是 'ftyp',紧随其后是 4 个字节的 brand。
    if (ascii(4, 4) === 'ftyp') {
        const brand = ascii(8, 4);
        // 'qt  ' 是 QuickTime 的 brand;其余常见 brand 都是 MP4 家族
        // (isom/iso2/mp41/mp42/avc1/dash/M4V /MSNV/3gp4……)。认不出 brand 时
        // 按签名本身判:有 ftyp 就是 MP4 容器 —— 这里宁可宽一点,因为代价是
        // "把 mov 当 mp4 发给服务端"(它会自己解析),而不是拒掉用户的视频。
        return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    }
    // EBML(WebM / Matroska):四个魔数字节相同,靠 EBML 头里的 DocType 字符串区分。
    // 只在最前面一段里找 —— DocType 一定在 EBML 头的前几十个字节内。
    if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) {
        const head = ascii(0, Math.min(256, bytes?.length ?? 0)).toLowerCase();
        if (head.includes('webm')) return 'video/webm';
        if (head.includes('matroska')) return 'video/x-matroska';
        // DocType 没出现在前 256 字节里:按 webm 收(两者同源,且这是现实里更常见的
        // 那一个),不因为一个"读不出来"的细节把用户的视频拒掉。
        return 'video/webm';
    }
    return '';
}

/** 渲染进程递来的 bytes 收敛成 Uint8Array;不是字节就返回 null。 */function toBytes(value) {
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

/**
 * `data:` URL 的长度(字符数 = 字节数,base64 全是 ASCII)。
 *
 * 为什么要**算**而不是等报错:这是"内联还是上传"那个分发的唯一判据,
 * 而它必须是一个纯函数 —— 真去 POST 一次再看服务端脸色,是拿用户的流量和
 * 两秒延迟换一个本来能算出来的答案。
 */
export function dataUriLength(mimeType, byteLength) {
    const n = Number(byteLength);
    if (!Number.isFinite(n) || n < 0) return Number.POSITIVE_INFINITY;
    const prefix = `data:${String(mimeType ?? '')};base64,`.length;
    return prefix + base64Length(n);
}

/**
 * base64 编码之后的字符数(= 字节数)。
 *
 * ⚠️ **服务端那个上限判的就是这一个数**,不是整条 data-uri:实测里
 * 15 MiB 的文件(前缀 22 + base64 20,971,520 = 20,971,542 字节的 data-uri)
 * **通过**,而 base64 到 21,950,192 就被 400 拒。所以分发的判据必须落在这一段上 ——
 * 拿整条 data-uri 去比,会凭空少掉前缀那二十几个字节的余量(方向是"更保守",
 * 但那个保守没有依据,而且会把边界计算说得含糊)。
 */
export function base64Length(byteLength) {
    const n = Number(byteLength);
    if (!Number.isFinite(n) || n < 0) return Number.POSITIVE_INFINITY;
    return 4 * Math.ceil(n / 3);
}

/**
 * 体积 → 投递路径的分发。**这是本功能的核心判据,判错两个方向都很难看**:
 * 判成内联而实际超限 → 一次注定 400 的请求;判成上传而本可以内联 → 用户白等一次
 * 上传(而且临时文件会在服务端留一份)。
 *
 * @param {{byteLength?:number, mimeType?:string, inlineLimitBytes?:number, maxBytes?:number}} input
 *        `maxBytes` 是这条入口自己的封顶:拖入/粘贴那条用默认的 MAX_VIDEO_BYTES,
 *        已知本地路径那条传 MAX_LOCAL_VIDEO_BYTES(1024 MB,服务端实测值)。
 * @returns {{mode:'inline'|'upload'|'reject', reason:string, dataUriBytes:number,
 *            base64Bytes:number, inlineLimitBytes:number, maxBytes:number}}
 */
export function chooseDelivery({ byteLength, mimeType = 'video/mp4', inlineLimitBytes, maxBytes } = {}) {
    const n = Number(byteLength);
    const limit = Number.isFinite(inlineLimitBytes) && inlineLimitBytes > 0
        ? inlineLimitBytes : (MAX_DATA_URI_BYTES - INLINE_SAFETY_MARGIN_BYTES);
    const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_VIDEO_BYTES;
    const uriBytes = dataUriLength(mimeType, n);
    const b64 = base64Length(n);

    if (!Number.isFinite(n) || n <= 0) {
        return { mode: 'reject', reason: '这段视频报不出大小(或者大小是 0),无法确认能不能发', dataUriBytes: 0, base64Bytes: 0, inlineLimitBytes: limit, maxBytes: cap };
    }
    if (n > cap) {
        return {
            mode: 'reject',
            reason: `这段视频 ${formatBytes(n)},超过这条入口的单段上限 ${formatBytes(cap)},已拒绝`,
            dataUriBytes: uriBytes,
            base64Bytes: b64,
            inlineLimitBytes: limit,
            maxBytes: cap,
        };
    }
    if (b64 <= limit) {
        return {
            mode: 'inline',
            reason: `base64 约 ${formatBytes(b64)},在上限内,直接内联`,
            dataUriBytes: uriBytes,
            base64Bytes: b64,
            inlineLimitBytes: limit,
            maxBytes: cap,
        };
    }
    return {
        mode: 'upload',
        reason: `base64 约 ${formatBytes(b64)},超过内联上限,改走临时上传`,
        dataUriBytes: uriBytes,
        base64Bytes: b64,
        inlineLimitBytes: limit,
        maxBytes: cap,
    };
}

/**
 * 「按本地路径读盘」这条入口的准入判据。**纯函数**(stat 的结果由调用方递进来)。
 *
 * ⚠️ 为什么这条判据必须存在、而且必须严:渲染进程递一个**路径**进来,意味着
 * "能让主进程读任意文件并发给第三方"。所以这里从头核四件事:
 *   ① 绝对路径(盘符形式)、没有控制字符;
 *   ② 扩展名在视频容器白名单里(路径上没有 MIME,只能看后缀);
 *   ③ 文件存在、且不是目录;
 *   ④ **如果给了下载目录,路径必须落在它里面** —— 队列那边给的 folder 是已知的,
 *      把可读范围钉在"这条队列自己的下载目录"里,比"任意路径"窄得多。
 * 渲染进程额外塞的字段一律不采信(调用方只把 taskId/路径本名递进来)。
 *
 * @param {{path?:string, folder?:string, exists?:boolean, isFile?:boolean, size?:number,
 *          maxBytes?:number}} input
 * @returns {{ok:true, path:string, size:number, extension:string}|{ok:false, code:string, reason:string}}
 */
export function admitVideoPath({ path: rawPath, folder, exists, isFile, size, maxBytes } = {}) {
    const p = String(rawPath ?? '');
    const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_LOCAL_VIDEO_BYTES;
    if (p.trim() === '') return { ok: false, code: 'bad_path', reason: '视频路径是空的' };
    if (/[\u0000-\u001f]/.test(p)) return { ok: false, code: 'bad_path', reason: '视频路径里有控制字符(换行等),已拒绝' };
    if (!/^[a-zA-Z]:\\/.test(p)) {
        return { ok: false, code: 'bad_path', reason: `只接受本地绝对路径(形如 D:\\…),收到:${p}` };
    }
    const dot = p.lastIndexOf('.');
    const ext = dot === -1 ? '' : p.slice(dot).toLowerCase();
    if (!VIDEO_FILE_EXTENSIONS.includes(ext)) {
        return {
            ok: false,
            code: 'bad_extension',
            reason: `按路径只接受视频文件(${VIDEO_FILE_EXTENSIONS.join(' / ')}),收到:${ext || '(没有扩展名)'}`,
        };
    }

    const knownFolder = String(folder ?? '').trim();
    if (knownFolder !== '') {
        // 与 bilibili-copy.js 的 admitClipboardPath 同一套纪律:大小写与斜杠方向都归一,
        // 必须是"目录 + 反斜杠"前缀(避免 D:\a 匹配上 D:\ab)。
        const normalize = (value) => String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        const normFolder = normalize(knownFolder);
        const normPath = normalize(p);
        if (!normPath.startsWith(`${normFolder}\\`)) {
            return {
                ok: false,
                code: 'outside_folder',
                reason: `这个路径不在它自己的下载目录里,已拒绝(路径:${p},目录:${knownFolder})`,
            };
        }
    }

    if (exists !== true) return { ok: false, code: 'file_missing', reason: `文件不在了:${p}` };
    if (isFile === false) return { ok: false, code: 'not_a_file', reason: `这个路径不是一个文件:${p}` };
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return { ok: false, code: 'bad_size', reason: `读不出这个文件的大小:${p}` };
    }
    if (bytes > cap) {
        return {
            ok: false,
            code: 'too_large',
            reason: `这段视频 ${formatBytes(bytes)},超过这条入口的单段上限 ${formatBytes(cap)}`
                + `(服务端自己报的单文件上限是 1024 MB),已拒绝`,
        };
    }
    return { ok: true, path: p, size: bytes, extension: ext };
}

// ---------- 附件判据(渲染层即时反馈 + 主进程权威校验,共用这一处) ----------

/**
 * 一份候选视频的判据。
 *
 * ⚠️ 每个失败都带一个 `code`:调用方(provider)要据此决定给界面哪一个机器可读的
 * 码 —— "太大了"与"这不是视频"对用户是两个完全不同的下一步(换短一点 vs 换个文件),
 * 而**只看中文文案**去分支的代码改一次措辞就悄悄坏一处。文案照旧给人看。
 */
function checkCandidate({ mimeType, byteLength, existingBytes = 0, existingCount = 0 } = {}) {
    if (existingCount >= MAX_VIDEOS_PER_PROMPT) {
        return {
            ok: false,
            code: 'too_many',
            reason: `一次只能理解 ${MAX_VIDEOS_PER_PROMPT} 段视频,已经选了 ${existingCount} 段,这一段被拒绝`,
        };
    }
    const canonical = normalizeVideoMime(mimeType);
    if (canonical === '') {
        return {
            ok: false,
            code: 'bad_type',
            reason: `不支持的视频格式“${String(mimeType ?? '').trim() || '(没有类型)'}”——只接受 ${VIDEO_MIME_LABEL}`,
        };
    }
    if (!Number.isFinite(byteLength) || byteLength < 0) {
        return { ok: false, code: 'unknown_size', reason: '这段视频报不出大小,无法确认能不能发,已拒绝' };
    }
    if (byteLength === 0) {
        return { ok: false, code: 'empty', reason: '这段视频是空的(0 字节),已拒绝' };
    }
    if (byteLength > MAX_VIDEO_BYTES) {
        return {
            ok: false,
            code: 'too_large',
            reason: `这段视频 ${formatBytes(byteLength)},超过单段上限 ${formatBytes(MAX_VIDEO_BYTES)},已拒绝`,
        };
    }
    return { ok: true, mimeType: canonical };
}

/** 渲染层的即时判断:这一段能不能加进待发列表(字节还没读,只按声明与大小)。 */
export function validateVideoCandidate({ mimeType, byteLength, existing } = {}) {
    const list = Array.isArray(existing) ? existing : [];
    let bytes = 0;
    for (const item of list) {
        const n = Number(item?.byteLength);
        if (Number.isFinite(n) && n > 0) bytes += n;
    }
    return checkCandidate({ mimeType, byteLength, existingBytes: bytes, existingCount: list.length });
}

/**
 * 两种容器是不是"同一家"。
 *
 * mp4 与 mov 用的是同一个 ISO BMFF 容器(只是 brand 不同),webm 与 mkv 都是 EBML
 * (只是 DocType 不同)。现实里同一个文件被不同工具贴上这两对里的任意一个 type 都很常见,
 * 所以它们之间不算"声明不实" —— 那几对组合里,**只有真正的错配**(比如声明 mp4、字节是 webm)
 * 才拒。
 */
export function sameContainerFamily(a, b) {
    return (a === b)
        || (a === 'video/mp4' && b === 'video/quicktime')
        || (a === 'video/quicktime' && b === 'video/mp4')
        || (a === 'video/webm' && b === 'video/x-matroska')
        || (a === 'video/x-matroska' && b === 'video/webm');
}

/**
 * "声明的类型与字节开头那几笔相容吗"。
 *
 * 为什么要单独导出它:渲染层在**读字节之后**也能用同一份判据 —— 用户在本地就能被
 * 告知"这个 .mp4 其实不是视频",而不必先把它递给主进程、再等服务端(甚至 DashScope)
 * 来告诉他。判据只有一份,两边判得一模一样。
 *
 * @param {{mimeType?:string, bytes?:unknown}} input
 * @returns {{ok:true, mimeType:string, sniffed:string}|{ok:false, code:string, reason:string}}
 */
export function videoSniffVerdict({ mimeType, bytes } = {}) {
    const canonical = normalizeVideoMime(mimeType);
    if (canonical === '') {
        return {
            ok: false,
            code: 'bad_type',
            reason: `不支持的视频格式“${String(mimeType ?? '').trim() || '(没有类型)'}”——只接受 ${VIDEO_MIME_LABEL}`,
        };
    }
    const sniffed = sniffVideoMime(toBytes(bytes));
    if (sniffed === '') {
        return {
            ok: false,
            code: 'not_a_video',
            reason: `这段视频声明是 ${canonical},但字节不是 ${VIDEO_MIME_LABEL} 里任何一种容器,已拒绝`,
        };
    }
    if (!sameContainerFamily(sniffed, canonical)) {
        return {
            ok: false,
            code: 'mime_mismatch',
            reason: `这段视频声明是 ${canonical},字节其实是 ${sniffed},已拒绝`,
        };
    }
    return { ok: true, mimeType: canonical, sniffed };
}

/**
 * 主进程侧的**权威**校验:把渲染进程递来的叶子数据收成可用的视频。
 *
 * 与图片那条路同一个立场:渲染进程的话不算数。这里从头再判一遍类型白名单、
 * 单段上限、段数上限,并且**看字节开头那几笔**是不是真的那个容器 ——
 * 因为接下来这些字节会被 POST 给第三方服务。
 *
 * @param {unknown} raw
 * @returns {{ok:true, videos:Array<{mimeType:string, bytes:Uint8Array, name:string}>}|{ok:false, reason:string}}
 */
export function admitVideoPayload(raw) {
    if (raw === undefined || raw === null) return { ok: true, videos: [] };
    if (!Array.isArray(raw)) return { ok: false, code: 'bad_shape', reason: 'videos 必须是一个数组' };
    if (raw.length === 0) return { ok: true, videos: [] };
    if (raw.length > MAX_VIDEOS_PER_PROMPT) {
        return { ok: false, code: 'too_many', reason: `一次只能理解 ${MAX_VIDEOS_PER_PROMPT} 段视频,收到 ${raw.length} 段,已拒绝` };
    }

    const videos = [];
    for (let i = 0; i < raw.length; i += 1) {
        const position = i + 1;
        const item = raw[i];
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            return { ok: false, code: 'bad_shape', reason: `第 ${position} 段视频不是一个对象,已拒绝` };
        }
        const bytes = toBytes(item.bytes);
        if (bytes === null) {
            return { ok: false, code: 'bad_shape', reason: `第 ${position} 段视频的字节不是一个字节数组,已拒绝` };
        }
        const verdict = checkCandidate({ mimeType: item.mimeType, byteLength: bytes.byteLength });
        if (verdict.ok !== true) {
            return { ok: false, code: verdict.code ?? 'invalid_input', reason: `第 ${position} 段视频:${verdict.reason}` };
        }

        // 声明与签名必须相容(判据与渲染层用的是**同一个** videoSniffVerdict)
        const sniffVerdict = videoSniffVerdict({ mimeType: item.mimeType, bytes });
        if (sniffVerdict.ok !== true) {
            return { ok: false, code: sniffVerdict.code, reason: `第 ${position} 段视频:${sniffVerdict.reason}` };
        }
        videos.push({ mimeType: verdict.mimeType, bytes, name: safeVideoName(item.name, verdict.mimeType) });
    }
    return { ok: true, videos };
}

/**
 * 文件名洗一遍。它有两个去处:界面上的 chip(那里只走 textContent,安全)与
 * **OSS 的对象 key**(那里是拼进 URL/表单的字符串)。所以这里不许出现路径分隔符、
 * 控制字符、引号与反斜杠 —— 一个用户可控的字符串不该有机会改写那个 key。
 */
export function safeVideoName(raw, mimeType = 'video/mp4') {
    let name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
    name = name.split(/[\\/]/).pop() ?? '';
    name = name.replace(/["'<>\r\n\t]/g, '');
    name = name.replace(/[^0-9A-Za-z\u4e00-\u9fa5._-]/g, '_');
    name = name.replace(/^[.]+/, '');            // 去掉开头的点:不许出现 ".." 之类
    if (name === '') {
        const ext = String(mimeType ?? '').split('/')[1]?.replace(/[^0-9a-z]/g, '') || 'mp4';
        name = `video.${ext === 'quicktime' ? 'mov' : ext}`;
    }
    // OSS 的 key 有长度限制,名字太长就截断(留出 upload_dir 与分隔符的余量)。
    if (name.length > 80) {
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot) : '';
        name = name.slice(0, 80 - ext.length) + ext;
    }
    return name;
}

// ---------- 请求体构造 ----------

/** 把归一化 base64 包成 data: URL(内联那条路唯一被服务端接受的形状)。 */
export function buildDataUrl({ mimeType, base64 } = {}) {
    return `data:${String(mimeType ?? 'video/mp4')};base64,${String(base64 ?? '')}`;
}

/**
 * 内联请求体分块的**源字节**数。
 *
 * ⚠️ **必须是 3 的倍数**:base64 是"3 字节 → 4 字符",块长不是 3 的倍数时每一块都会被
 * 独立补 `=`,拼起来中间就多出填充符 —— 整个请求体变成非法 base64,而服务端只会回一个
 * 400,极难查。768 KiB = 3 × 0x40000(一个块编出来 1 MiB 文本,发完即弃)。
 */
export const INLINE_BODY_CHUNK_BYTES = 3 * 0x40000;

/** 先按**整包**拼一次 JSON 再切段用的哨兵(见 buildInlineBodyParts)。 */
const INLINE_BODY_SENTINEL = '__KAIWU_INLINE_BODY__';

/**
 * 分块编码的**块长**(源字节数):向下取整到 3 的倍数,非法值退回默认块长。
 *
 * 单独抽出来是因为它有两个消费方:纯编码器 `encodeBase64Chunks`,以及真正往外发的那条流
 * (`composeInlineBodyStream` 一次只编一块)。两处各写一遍,迟早只有一处被改对。
 */
export function inlineChunkStep(chunkBytes = INLINE_BODY_CHUNK_BYTES) {
    const wanted = Number(chunkBytes);
    // < 3 会让 0 长度的块无限循环;非数字同理 —— 这种输入只可能来自代码写错,不该让它发出请求
    return (Number.isFinite(wanted) && wanted >= 3)
        ? Math.floor(wanted / 3) * 3
        : INLINE_BODY_CHUNK_BYTES;
}

/**
 * 把字节**分块**编码成 base64,拼起来与一次性编码**逐字节相同**。
 *
 * 为什么这么写(而不是"先整段 base64 再切"):后者在内存里同时留着原始字节与整段
 * base64(13.9 MiB 的文件就是 ~19.4 MB 的字符串),等于没做流式。这里逐块编码、发完即弃。
 *
 * 正确性的根据只有一条:除最后一块外,每一块都是 3 的倍数个字节 → 它的 base64 **没有
 * 补位**;而 base64 是每 3 字节对齐到 4 字符的,所以把这些无补位的片段直接接起来,与
 * 一次性编码完全一致。最后一块允许补 `=`(它确实是最后一块)。
 *
 * ⚠️ 真正发请求体时**不要**用这个返回值去批量编码(那会把整段 base64 留在内存里):
 * 发出去那条流是**一次只编一块**的,它调的也是同一个函数(一次给一个窗口)。
 *
 * @param {Uint8Array} bytes 源字节(这条路上它本来就在内存里 —— 是过 IPC 递进来的)
 * @param {{chunkBytes?:number}} [opts] 块大小;会被向下取整到 3 的倍数
 * @returns {string[]} 每块的 base64 文本(空文件 → `[]`)
 */
export function encodeBase64Chunks(bytes, { chunkBytes = INLINE_BODY_CHUNK_BYTES } = {}) {
    const view = toBytesForChunks(bytes);
    if (view === null) throw new Error('encodeBase64Chunks 需要一个字节数组');
    const step = inlineChunkStep(chunkBytes);
    const out = [];
    for (let at = 0; at < view.length; at += step) {
        out.push(toCanonicalBase64(view.subarray(at, Math.min(at + step, view.length))));
    }
    return out;
}

/** 收一个 Uint8Array / 其它 TypedArray / ArrayBuffer 视图,统一成 Uint8Array。 */
function toBytesForChunks(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (ArrayBuffer.isView(bytes) === true) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    return null;
}

/**
 * 内联请求体切成"前缀 / base64 正文 / 后缀"三段,好让基座直接流式发出去。
 *
 * ⚠️ 前缀与后缀是**从整包 JSON 里切出来的**(拿一个哨兵 data URL 先 stringify 一次,
 * 再以哨兵为锚点切开)—— 这样它们与今天整包发出去的那份**逐字节相同**,不靠人肉拼
 * JSON 字符串(那种写法迟早与 buildChatBody 漂移)。切成三段之后,`prefix + base64 + suffix`
 * 与整包一模一样,这件事由单测直接对比两种产物钉住。
 *
 * @returns {{prefix:Uint8Array, suffix:Uint8Array, base64Chars:number, contentLength:number}}
 */
export function buildInlineBodyParts({
    model, mimeType, question, maxTokens = DEFAULT_MAX_TOKENS, stream = false, byteLength = 0,
} = {}) {
    const mime = normalizeVideoMime(mimeType) || 'video/mp4';
    const sentinelUrl = buildDataUrl({ mimeType: mime, base64: INLINE_BODY_SENTINEL });
    const content = buildMediaContent({ url: sentinelUrl, question, kind: 'video' });
    const whole = JSON.stringify(buildChatBody({ model, content, maxTokens, stream }));
    const at = whole.indexOf(INLINE_BODY_SENTINEL);
    if (at === -1) throw new Error('内联请求体里找不到哨兵 —— buildChatBody/buildDataUrl 的拼法变了?');
    const encode = new TextEncoder();
    const prefix = encode.encode(whole.slice(0, at));
    const suffix = encode.encode(whole.slice(at + INLINE_BODY_SENTINEL.length));
    const base64Chars = base64Length(byteLength);
    if (Number.isFinite(base64Chars) === false) throw new Error('内联请求体:源字节数不可用,算不出长度');
    return {
        prefix,
        suffix,
        base64Chars,
        // 请求体的**真实**字节数:前缀 + base64 正文 + 后缀。它同时会作为 Content-Length
        // 发出去 —— 于是"最后一块发完时计数正好等于长度"这件事由 HTTP 层再兜一道。
        contentLength: prefix.byteLength + base64Chars + suffix.byteLength,
    };
}

/** 截断提问。超长时**明说**被截断 —— 不让模型以为用户只问了这半句。 */
export function clampQuestion(value) {
    const raw = String(value ?? '').replace(/\r\n?/g, '\n').trim();
    if (raw === '') return { text: DEFAULT_VIDEO_QUESTION, truncated: false };
    if (raw.length <= MAX_QUESTION_CHARS) return { text: raw, truncated: false };
    return { text: `${raw.slice(0, MAX_QUESTION_CHARS)}\n(提问过长,已截断)`, truncated: true };
}

/**
 * content 数组。视频在前、提问在后 —— 与实测跑通的那次调用逐字同形。
 *
 * @param {{url:string, question?:string, kind?:'video'|'image'}} input
 */
export function buildMediaContent({ url, question, kind = 'video' } = {}) {
    const asked = clampQuestion(question);
    const item = kind === 'image'
        ? { type: 'image_url', image_url: { url: String(url ?? '') } }
        : { type: 'video_url', video_url: { url: String(url ?? '') } };
    return [item, { type: 'text', text: asked.text }];
}

/**
 * 完整请求体。
 *
 * ⚠️ 这里**没有** `fps` 字段,是刻意的:实测 fps=1 / fps=2 / 不传,
 * video_tokens 一字不差(服务端静默忽略)。写一个不起作用的参数,下一个人会以为
 * 它能控成本,然后照着它做预算。
 */
export function buildChatBody({ model, content, maxTokens = DEFAULT_MAX_TOKENS, stream = false } = {}) {
    const m = normalizeVideoModel(model) || DEFAULT_VIDEO_MODEL;
    const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS;
    const body = { model: m, messages: [{ role: 'user', content }], max_tokens: tokens };
    if (stream === true) {
        body.stream = true;
        // ⚠️ 必须一起要 usage:流式模式下 usage 只在**最后一个**分片里出现,
        // 不带这个开关就永远拿不到(而 video_tokens 是这条链路唯一的成本读数)。
        body.stream_options = { include_usage: true };
    }
    return body;
}

// ---------- 返回解析 ----------

function pickNumber(...vals) {
    for (const v of vals) {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return 0;
}

/**
 * 解析一次成功的响应。
 *
 * usage 里的 `prompt_tokens_details.video_tokens` 是**视频那部分的真实 token 数**
 * (实测:1080p 4 秒 2378,320×240 4 秒 322)—— 它是这个功能唯一能拿到的成本读数,
 * 所以单独摘出来放进界面可见的 usage,而不是整个 usage 原样塞进状态。
 *
 * @param {unknown} raw 已经 JSON.parse 过的响应体
 * @returns {{ok:true, text:string, usage:object, model:string, requestId:string}|{ok:false, reason:string}}
 */
export function parseChatResponse(raw) {
    const body = (raw !== null && typeof raw === 'object') ? raw : null;
    if (body === null) return { ok: false, reason: '服务端返回的不是一个 JSON 对象' };
    if (body.error !== null && typeof body.error === 'object') {
        const message = String(body.error.message ?? '').trim();
        return { ok: false, reason: message === '' ? '服务端返回了一个错误(没给原因)' : message };
    }
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = choices[0];
    const message = (first !== null && typeof first === 'object' && first.message !== null
        && typeof first.message === 'object') ? first.message : null;
    // ⚠️ content 可能是数组(有的兼容层会回 [{type:'text',text}]),这里按数组再取一次 ——
    // 只认字符串的话,一次成功的调用会被判成"返回是空的",而那是**假**失败。
    let text = '';
    if (message !== null) {
        if (typeof message.content === 'string') text = message.content;
        else if (Array.isArray(message.content)) {
            text = message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('');
        }
    }
    text = text.trim();
    if (text === '') {
        const finish = String(first?.finish_reason ?? '').trim();
        return {
            ok: false,
            reason: finish === 'length'
                ? '模型把这一段用完了输出上限(只回了空内容)。把 max_tokens 调大,或者把提问问得更短。'
                : '服务端回了一次空结果(没有正文)。',
        };
    }
    const u = (body.usage !== null && typeof body.usage === 'object') ? body.usage : {};
    const pd = (u.prompt_tokens_details !== null && typeof u.prompt_tokens_details === 'object')
        ? u.prompt_tokens_details : {};
    return {
        ok: true,
        text,
        usage: {
            promptTokens: pickNumber(u.prompt_tokens),
            completionTokens: pickNumber(u.completion_tokens),
            totalTokens: pickNumber(u.total_tokens),
            // 视频那部分的真实 token(可能为 0:纯图片/纯文本的调用没有它)。
            videoTokens: pickNumber(pd.video_tokens),
            textTokens: pickNumber(pd.text_tokens),
            imageTokens: pickNumber(pd.image_tokens),
        },
        model: String(body.model ?? '').trim(),
        requestId: String(body.request_id ?? body.id ?? '').trim(),
    };
}

// ---------- 错误映射 ----------

/** 把响应的错误体摘成 `{code, message}`(认不出来就给空)。 */
export function parseErrorBody(raw) {
    const body = (raw !== null && typeof raw === 'object') ? raw : null;
    if (body === null) return { code: '', message: '' };
    // 兼容模式(OpenAI 形状):{ error: { code, message } };百炼原生是顶层 { code, message }
    const err = (body.error !== null && typeof body.error === 'object') ? body.error : null;
    return {
        code: String((err?.code ?? body.code ?? '')).trim(),
        message: String((err?.message ?? body.message ?? '')).trim(),
    };
}

/**
 * HTTP 失败 → 一个机器可读的 code + 一句中文。
 *
 * 为什么必须分开这两样:code 是给代码用的(界面据此决定"要不要亮出密钥输入框"),
 * 中文是给人看的。混成一句中文,界面就只能靠**匹配中文文案**来决定行为 ——
 * 改一次措辞就悄悄坏一处,而且不报错。
 *
 * 实测到的两条(证据在交付报告里):
 *   401 + code `invalid_api_key` → "Incorrect API key provided."
 *   404 + code `model_not_found` → "The model ... does not exist or you do not have access to it."
 *   400 + 无 code,message `Exceeded limit on max bytes per data-uri item : 20971520`
 *
 * @param {{status?:number, body?:unknown, message?:string, timedOut?:boolean, network?:boolean}} input
 * @returns {{code:string, reason:string}}
 */
export function classifyChatFailure({ status, body, message = '', timedOut = false, network = false } = {}) {
    const parsed = parseErrorBody(body);
    const detail = parsed.message || String(message ?? '').trim();
    const original = detail === '' ? '' : `(原话:${detail})`;
    const s = Number(status);
    const code = parsed.code.toLowerCase();

    if (timedOut === true) {
        return { code: 'timeout', reason: `请求超时了 —— 服务端在限定时间内没有回应${original}` };
    }
    if (network === true) {
        return { code: 'network', reason: `连不上 DashScope 服务${original}` };
    }
    if (s === 401 || s === 403 || code === 'invalid_api_key' || code === 'authentication_error') {
        return { code: 'auth_failed', reason: `鉴权失败:密钥不对、被停用、或者没有这个模型的权限${original}` };
    }
    if (s === 404 || code === 'model_not_found') {
        return { code: 'model_not_found', reason: `模型不存在(或者这个账号没有它的权限)${original}` };
    }
    if (s === 429 || code === 'rate_limit_exceeded' || code === 'throttling') {
        return { code: 'rate_limited', reason: `被限流了,过一会儿再试${original}` };
    }
    // 上下文超限:508 秒的 1080p60 实测能到约 30 万 video token,超过模型的上下文窗口
    // 时服务端回的就是这一类(原话里带 "context" / "too long" / "max length")。
    // 单独给一个码,是为了让界面能说清"这段太长"而不是"请求有问题"。
    if (/context[\s_-]?length|too long|exceed.*max.*(length|token)|maximum context/i.test(detail)) {
        return {
            code: 'context_too_long',
            reason: `这段视频太长,超过了模型的上下文窗口${original}`
                + ' —— 换更短的一段,或先用剪辑工具截出要看的那几分钟。',
        };
    }
    if (s === 413 || /max bytes|too large|payload too large|request entity too large/i.test(detail)) {
        return {
            code: 'payload_too_large',
            reason: `这段视频对服务端来说太大了(内联 data-uri 有体积上限)${original}`
                + ' —— 换成更短的一段,或者走临时上传那条路。',
        };
    }
    if (s >= 500) {
        return { code: 'server_error', reason: `DashScope 服务端出错了(${s})${original}` };
    }
    if (s === 400) {
        return { code: 'bad_request', reason: `服务端拒绝了这次请求(400)${original}` };
    }
    if (!Number.isFinite(s)) {
        return { code: 'unknown', reason: `请求没有正常完成${original}` };
    }
    return { code: 'unknown', reason: `请求失败(HTTP ${s})${original}` };
}

/** 缺密钥时给用户看的那一句(**只说怎么配,不涉及值**)。 */
export const MISSING_KEY_REASON =
    '没有配置 DashScope 密钥。两种配法任选一种:'
    + '① 设置环境变量 DASHSCOPE_API_KEY 后再启动开物;'
    + '② 在 AI 面板的视频卡片里点「配置密钥」填一次(存进开物的设置文件,不进界面、不进日志)。';

// ---------- 临时上传(大文件兜底) ----------

/**
 * 用 `oss://` 作为 video_url 时**必须**带的请求头。
 *
 * 少了它,服务端不做 oss:// 解析,直接回
 * `400 InternalError.Algo.InvalidParameter: The provided URL does not appear to be valid`
 * —— 实测踩过,而且那句英文完全不提头部,极易被误判成"URL 拼错了"。
 * 官方文档明确写了 HTTP 调用时要自己加(SDK 会自动加,我们不用 SDK,所以必须自己加)。
 */
export const OSS_RESOLVE_HEADER = 'X-DashScope-OssResourceResolve';
export const OSS_RESOLVE_VALUE = 'enable';


/**
 * 解析 getPolicy 的响应。
 *
 * ⚠️ 三处与"想当然"不同的实测事实(都验过,证据在交付报告里):
 *   1. 这个接口是 **GET**,不是 POST —— POST 一律回
 *      `405 BadRequest.RequestMethodNotAllowed`(路径与方法都没写错,就是只认 GET);
 *   2. 响应里**没有** `x_oss_security_token`。真实字段是:
 *      policy / signature / upload_dir / upload_host / oss_access_key_id /
 *      x_oss_object_acl / x_oss_forbid_overwrite / expire_in_seconds /
 *      max_file_size_mb / capacity_limit_mb。少发 SecurityToken 不影响上传
 *      (要它的是 STS 那条路,这里用的是"主账号 + 表单策略签名");
 *   3. `x_oss_forbid_overwrite = "true"` 是**策略里的一个条件**,它要求表单里
 *      必须出现同名同值的字段,否则 OSS 直接 403
 *      (`Policy Condition failed: ["eq", "$x-oss-forbid-overwrite", "true"]`)——
 *      第一次实测就是踩在这一条上。所以下面把它当**必填**传下去。
 *
 * 为什么要**逐字段校验**而不是"拿到 data 就用":少一个字段时,拼出来的 multipart
 * 会被 OSS 以一个语焉不详的 XML 拒掉,而排查要一路回到这里。
 *
 * @param {unknown} raw
 * @returns {{ok:true, policy:object}|{ok:false, reason:string}}
 */
export function parseUploadPolicy(raw) {
    const body = (raw !== null && typeof raw === 'object') ? raw : null;
    if (body === null) return { ok: false, reason: '上传策略接口返回的不是一个 JSON 对象' };
    const data = (body.data !== null && typeof body.data === 'object') ? body.data : null;
    if (data === null) {
        const parsed = parseErrorBody(body);
        return {
            ok: false,
            reason: `上传策略接口没有返回 data${parsed.message === '' ? '' : `(原话:${parsed.message})`}`,
        };
    }
    const need = {
        uploadHost: data.upload_host,
        uploadDir: data.upload_dir,
        policy: data.policy,
        signature: data.signature,
        accessKeyId: data.oss_access_key_id,
    };
    const missing = Object.entries(need).filter(([, v]) => String(v ?? '').trim() === '').map(([k]) => k);
    if (missing.length > 0) {
        return { ok: false, reason: `上传策略接口少给了字段:${missing.join(' / ')}(这样拼出的表单会被 OSS 拒掉)` };
    }
    return {
        ok: true,
        policy: {
            ...need,
            objectAcl: String(data.x_oss_object_acl ?? 'private').trim() || 'private',
            // 默认 true:策略里报了 forbid_overwrite 而表单没带这一项时,上传会 403。
            forbidOverwrite: String(data.x_oss_forbid_overwrite ?? 'true').trim() || 'true',
            // 可能为空:这条路上服务端不给 STS token,空字符串表示"不带这个字段"。
            securityToken: String(data.x_oss_security_token ?? '').trim(),
            expireInSeconds: Number(data.expire_in_seconds) || 0,
            maxFileSizeMb: Number(data.max_file_size_mb) || 0,
        },
    };
}

/**
 * OSS 表单上传要带的字段(**顺序固定**,与实测跑通的形状一致)。
 *
 * `x-oss-object-acl=private` 与 `success_action_status=200` 是必须的:
 * 前者保证这个临时对象不是公开可读的,后者让 OSS 回 200 而不是默认的 204
 * (只看状态码判断成败的地方,204 会被当成"没成功")。
 * SecurityToken 只在服务端真的给了时才带 —— 带一个空值会被策略比对打回来。
 */
export function buildUploadFormFields({
    uploadDir, fileName, policy, signature, accessKeyId,
    securityToken = '', objectAcl = 'private', forbidOverwrite = 'true',
} = {}) {
    const fields = [
        ['key', `${uploadDir}/${fileName}`],
        ['policy', String(policy)],
        ['signature', String(signature)],
        ['OSSAccessKeyId', String(accessKeyId)],
        ['x-oss-object-acl', String(objectAcl)],
        ['x-oss-forbid-overwrite', String(forbidOverwrite)],
        ['success_action_status', '200'],
    ];
    if (String(securityToken).trim() !== '') fields.push(['SecurityToken', String(securityToken)]);
    return fields;
}

/**
 * 让上传的文件名**唯一**。
 *
 * 为什么必须:策略里 `x-oss-forbid-overwrite=true`,同一个 key 再传一次就是 403
 * (实测:第二次传同一个 key 直接 `Policy Condition failed`)。
 * 而用户完全可能把同一个文件拖进来两次 —— 第二次要能成功,不能因为"上次传过"
 * 就失败。所以这里在扩展名之前插一段时间戳 + 随机串。
 */
export function uniqueUploadName(name, { now = Date.now(), random = Math.random } = {}) {
    const safe = String(name ?? 'video.mp4');
    const dot = safe.lastIndexOf('.');
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';
    const stamp = Math.floor(Number(now) || 0).toString(36);
    const noise = Math.floor((typeof random === 'function' ? random() : 0.5) * 0x100000000).toString(36);
    return `${base}-${stamp}${noise}${ext}`;
}

/** 上传成功后送进 messages 的那个 URL 形状。 */
export function buildOssUrl(uploadDir, fileName) {
    return `oss://${String(uploadDir ?? '').replace(/\/+$/, '')}/${fileName}`;
}

/**
 * 拼 multipart/form-data 的请求体(纯字节运算,不碰网络)。
 *
 * 为什么要自己拼:DashScope 的 OSS 表单上传要求字段顺序与 `file` 段同在,
 * 而 Electron 主进程里可用的 FormData 不一定带得上我们需要的字段顺序与自定义
 * 字段(而且"零运行时依赖"这条约束下,没有别的选择)。这里生成的是确定性字节,
 * 单测可以直接断言里面有什么。
 *
 * ⚠️ 这个函数会把**整份请求体**放进一块内存里(文件字节一份 + 请求体一份)。
 * 几十 MB 的文件没问题;169 MB 那种必须用下面的 `buildMultipartParts()` ——
 * 它只给出"文件之前"与"文件之后"两小段,中间那段文件字节由调用方**流式**送去,
 * 于是内存里始终只有一条流,而不是两份拷贝。
 *
 * @param {{fields:Array<[string,string]>, file:{name:string, mimeType?:string, bytes:Uint8Array},
 *          boundary:string}} input
 * @returns {{contentType:string, body:Uint8Array}}
 */
export function buildMultipartBody({ fields, file, boundary } = {}) {
    const parts = buildMultipartParts({ fields, file, boundary });
    const bytes = toBytes(file?.bytes) ?? new Uint8Array(0);
    const body = new Uint8Array(parts.prefix.byteLength + bytes.byteLength + parts.suffix.byteLength);
    body.set(parts.prefix, 0);
    body.set(bytes, parts.prefix.byteLength);
    body.set(parts.suffix, parts.prefix.byteLength + bytes.byteLength);
    return { contentType: parts.contentType, body };
}

/**
 * multipart 的**三段**:文件之前的前缀、文件之后的后缀,以及总长度。
 *
 * 为什么单独给这一个:大文件不能把整份请求体拼成一块 Buffer(那等于让文件在内存里
 * 同时存在两份)。有了这三段,调用方就能:① 流式发(前缀 → 文件流 → 后缀),
 * 内存里只有一条流;② 或者先按 `contentLength` 开一块缓冲区,把文件**直接读进中间**
 * (`fs.read` 带 offset),这样文件也**只有一份**。
 *
 * `contentLength` 是算出来的(前缀 + 文件字节数 + 后缀),所以即使流式发送也能带上
 * 准确的 `Content-Length` —— 有些服务端对 chunked 的 POST 表单不友好,这个数就是
 * 为那种情况准备的。
 *
 * @param {{fields:Array<[string,string]>, file:{name:string, mimeType?:string, byteLength?:number},
 *          boundary:string}} input
 * @returns {{contentType:string, prefix:Uint8Array, suffix:Uint8Array,
 *            contentLength:number, boundary:string}}
 */
export function buildMultipartParts({ fields, file, boundary } = {}) {
    const b = String(boundary ?? '');
    if (b === '') throw new Error('buildMultipartParts 需要 boundary');
    const encode = (text) => new TextEncoder().encode(text);

    const head = [];
    for (const [name, value] of Array.isArray(fields) ? fields : []) {
        head.push(`--${b}\r\n`);
        head.push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
        head.push(`${String(value)}\r\n`);
    }
    head.push(`--${b}\r\n`);
    head.push(`Content-Disposition: form-data; name="file"; filename="${String(file?.name ?? 'video.mp4')}"\r\n`);
    head.push(`Content-Type: ${String(file?.mimeType ?? 'application/octet-stream')}\r\n\r\n`);

    const prefix = encode(head.join(''));
    const suffix = encode(`\r\n--${b}--\r\n`);
    const byteLength = Number(file?.byteLength);
    return {
        contentType: `multipart/form-data; boundary=${b}`,
        prefix,
        suffix,
        contentLength: prefix.byteLength + (Number.isFinite(byteLength) && byteLength > 0 ? Math.floor(byteLength) : 0) + suffix.byteLength,
        boundary: b,
    };
}

/** 让体积读数也能在界面上出现(与图片那条路共用同一份格式化)。 */
export { formatBytes, toCanonicalBase64 };

// ---------- 流式(SSE)解析 ----------
//
// 为什么把这两步做成纯函数:"等待首个字 / 生成正文"这两段的进度**只能**从 SSE 流里读出来,
// 而判据错了的表现是"进度在骗人" —— 那比没有进度条更糟。所以它必须能被逐条钉住
// (单测按真实分片方式喂进去)。

/**
 * 把一段 SSE 文本切成**完整**事件,并返回剩下的半截。
 *
 * ⚠️ 半截必须留着:网络分片不会按事件边界切(实测一次 322 字的回答分了 227 片),
 * 把半行丢掉就是"偶尔漏几个字"。SSE 事件以**空行**分隔,所以按 `\r?\n\r?\n` 切,
 * 最后一段一定是没写完的。
 *
 * @param {string} buffer 上一次剩下的
 * @param {string} chunk 这一次收到的
 * @returns {{rest:string, events:string[]}} events 是每条事件的 data 体(已 trim)
 */
export function splitSseEvents(buffer, chunk) {
    const text = String(buffer ?? '') + String(chunk ?? '');
    const parts = text.split(/\r?\n\r?\n/);
    const rest = parts.pop() ?? '';
    const events = [];
    for (const block of parts) {
        // 一条事件里允许多行 data:(SSE 规定用 \n 连接),这里照做
        const data = block.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice('data:'.length).trim())
            .join('');
        if (data !== '') events.push(data);
    }
    return { rest, events };
}

/** 从 content 里取文本:可能是字符串,也可能是 [{type,text}] 数组。 */
export function extractStreamText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('');
    }
    return '';
}

/** 归一化流式尾包里的 usage(与整包里那份同形,字段名沿用同一套)。 */
export function normalizeStreamUsage(raw) {
    if (raw === null || typeof raw !== 'object') return null;
    const pd = (raw.prompt_tokens_details !== null && typeof raw.prompt_tokens_details === 'object')
        ? raw.prompt_tokens_details : {};
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const has = ['prompt_tokens', 'completion_tokens', 'total_tokens'].some(k => typeof raw[k] === 'number');
    if (has !== true) return null;
    return {
        promptTokens: num(raw.prompt_tokens),
        completionTokens: num(raw.completion_tokens),
        totalTokens: num(raw.total_tokens),
        videoTokens: num(pd.video_tokens),
        textTokens: num(pd.text_tokens),
        imageTokens: num(pd.image_tokens),
    };
}

/**
 * 解析一条 SSE 事件的 data 体。
 * @returns {{kind:'done'}|{kind:'delta',delta:string,finishReason:string}
 *          |{kind:'usage',usage:object}|{kind:'finish',finishReason:string}
 *          |{kind:'error',reason:string}|{kind:'other'}}
 */
export function parseStreamPayload(dataText) {
    const raw = String(dataText ?? '').trim();
    if (raw === '[DONE]') return { kind: 'done' };
    let body = null;
    try {
        body = JSON.parse(raw);
    } catch {
        return { kind: 'other' };
    }
    const bodyObj = (body !== null && typeof body === 'object') ? body : {};
    if (bodyObj.error !== null && typeof bodyObj.error === 'object') {
        return { kind: 'error', reason: String(bodyObj.error.message ?? '流式响应里带了一个错误') };
    }
    const choice = (Array.isArray(bodyObj.choices) ? bodyObj.choices[0] : null) ?? null;
    const usage = normalizeStreamUsage(bodyObj.usage);
    // usage 尾包通常没有 choices(或 choices 为空),先认它
    if (usage !== null && (choice === null || extractStreamText(choice?.delta?.content) === '')) {
        return { kind: 'usage', usage };
    }
    const delta = extractStreamText(choice?.delta?.content) || extractStreamText(choice?.message?.content);
    const finishReason = String(choice?.finish_reason ?? '');
    if (delta !== '') return { kind: 'delta', delta, finishReason };
    if (usage !== null) return { kind: 'usage', usage };
    // 收尾那一包常常只有 finish_reason 而没有正文。**必须单独认出来** ——
    // 不然"被输出上限截断"与"服务端什么都没回"在界面上是同一句含糊的话。
    if (finishReason !== '') return { kind: 'finish', finishReason };
    return { kind: 'other' };
}
