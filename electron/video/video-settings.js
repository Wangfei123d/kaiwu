// 「视频理解」的配置与密钥存放。
//
// 复用哪一份机制:kaiwu 现有的设置存储 electron/settings-store.js(`<userData>/settings.json`,
// 按命名空间分键读写)。**没有**另造一个存储文件 —— 多一个文件就多一处"用户找不到、
// 备份漏掉、自检忘了清"的地方。这里只在它上面加 video 自己的那几个键。
//
// 密钥怎么放(这是一个真实取舍,如实写下来):
//   · 首选环境变量 `DASHSCOPE_API_KEY` —— 不落盘,最干净,与 kaiwu 既有的
//     DeepSeek 凭证那条路同一个思路;
//   · 其次才存进设置文件。能加密就加密:Electron 的 safeStorage 可用时,
//     存的是 `apiKeyEnc`(safeStorage 密文转 base64);不可用时退回明文 `apiKey`。
//     ⚠️ 明文那一份要说清楚:**settings.json 是明文的**,能读到这个文件的人就能
//     读到密钥。所以界面上的文案说的是"存进开物的设置文件",没有说"安全存放"。
//   · 两处都**绝不**把密钥值读进界面:对外的 summary 只有 `{ok, source, reason}`
//     三个叶子字段(与 agent/credentials.js 同一条约束)。
import {
    DEFAULT_MAX_TOKENS, DEFAULT_VIDEO_MODEL, INLINE_SAFETY_MARGIN_BYTES,
    MAX_DATA_URI_BYTES, MISSING_KEY_REASON, normalizeVideoModel,
} from '../../app/lib/agent-video.js';

/** 设置里的命名空间。插件 id 有格式约束,不会撞上这个。 */
export const VIDEO_NAMESPACE = '__video';
/** 环境变量名(与 DashScope 官方一致;装机那份 harness 也是按这个读)。 */
export const VIDEO_ENV_VAR = 'DASHSCOPE_API_KEY';
/** 明文键与密文键。两个键名而不是一个键两种形状:解不开时能分辨"没配"与"配了但解不开"。 */
export const KEY_SETTING = 'apiKey';
export const KEY_ENC_SETTING = 'apiKeyEnc';
export const MODEL_SETTING = 'model';
export const MAX_TOKENS_SETTING = 'maxTokens';
/** 内联上限的可调覆盖(settings 里的字节数)。默认见 defaultConfig。 */
export const INLINE_LIMIT_SETTING = 'inlineLimitBytes';

/** 输出上限的钳制范围。太小会截出一句半,太大会让一次误触很贵。 */
export const MIN_MAX_TOKENS = 64;
export const MAX_MAX_TOKENS = 8192;

/**
 * 校验用户填进来的密钥。
 *
 * 为什么要管形状(而不是"存进去就行"):最常见的一次失败是**粘错了东西**
 * (整行 `export DASHSCOPE_API_KEY=...`、或者带上了引号/换行)。这种字符串存进去
 * 之后,报错是 401 "Incorrect API key" —— 用户会以为自己复制错了密钥,
 * 其实是这里默默收下了一段带引号的东西。当场拒掉并说清哪里不对,省掉一整轮排查。
 *
 * @returns {{ok:true, value:string}|{ok:false, reason:string}}
 */
export function validateKeyInput(value) {
    const raw = String(value ?? '').trim();
    if (raw === '') return { ok: false, reason: '密钥不能为空' };
    if (/\s/.test(raw)) {
        return {
            ok: false,
            reason: '密钥里不能有空格或换行 —— 是不是把 `export DASHSCOPE_API_KEY=…` 整行粘进来了?只填 sk- 开头的那一串。',
        };
    }
    if (!raw.startsWith('sk-')) {
        return { ok: false, reason: 'DashScope 的密钥以 “sk-” 开头,这一串看起来不是密钥(没有存)' };
    }
    if (raw.length < 20) return { ok: false, reason: '这一串太短了,不像是完整的密钥(没有存)' };
    if (raw.length > 512) return { ok: false, reason: '这一串太长了,不像是密钥(没有存)' };
    return { ok: true, value: raw };
}

/**
 * 默认配置。内联上限**减掉安全余量**(见 agent-video.js 里那段实测说明)。
 *
 * ⚠️ 这里**没有** `autoUnderstand`。曾经有过("拖进来就自动开始理解"),用户改成了
 * "拖入只是草稿,点发送才调用"之后它就没有任何消费者了 —— 于是一并删掉,而不是留着
 * 一个"默认 false 已废弃"的键:一次要花钱的远端调用,配置面上多一个不起作用的开关
 * 比没有更糟(下一个人会以为它能控制什么)。触发点现在只有一个:`video:understand`。
 */
export function defaultConfig() {
    return {
        model: DEFAULT_VIDEO_MODEL,
        maxTokens: DEFAULT_MAX_TOKENS,
        inlineLimitBytes: MAX_DATA_URI_BYTES - INLINE_SAFETY_MARGIN_BYTES,
    };
}

/**
 * @param {object} deps
 * @param {{get:(ns:string,key:string)=>unknown, set:(ns:string,key:string,value:unknown)=>void}} deps.settings
 * @param {object} [deps.env] 环境变量(默认 process.env)
 * @param {{isEncryptionAvailable?:()=>boolean, encryptString?:(s:string)=>Buffer,
 *          decryptString?:(b:Buffer)=>string}|null} [deps.safeStorage]
 *        Electron 的 safeStorage。不传/不可用就退回明文 —— 这是**可用的降级**,
 *        而不是错误;界面文案据此说明存法。
 * @param {object} [deps.log]
 */
export function createVideoSettings({ settings, env = process.env, safeStorage = null, log = console } = {}) {
    if (settings === null || typeof settings?.get !== 'function' || typeof settings?.set !== 'function') {
        throw new Error('createVideoSettings 需要 settings(createSettingsStore 的产物)');
    }

    function canEncrypt() {
        try {
            return typeof safeStorage?.isEncryptionAvailable === 'function'
                && safeStorage.isEncryptionAvailable() === true
                && typeof safeStorage.encryptString === 'function'
                && typeof safeStorage.decryptString === 'function';
        } catch (err) {
            log.warn?.('[video] safeStorage 不可用,退回明文', err);
            return false;
        }
    }

    /** 从环境变量读。空串/非字符串一律当没有。 */
    function envSecret() {
        const e = env ?? {};
        const raw = typeof e[VIDEO_ENV_VAR] === 'string' ? e[VIDEO_ENV_VAR].trim() : '';
        return raw === '' ? '' : raw;
    }

    /** 从设置里读并(必要时)解密。解不开时返回 `{secret:'', broken:true}`。 */
    function storedSecret() {
        const enc = settings.get(VIDEO_NAMESPACE, KEY_ENC_SETTING);
        if (typeof enc === 'string' && enc !== '') {
            if (!canEncrypt()) {
                // 加密存过、但现在这台机器上没有可用的 safeStorage:如实说"解不开",
                // 不许当"没配"——那会让用户以为自己没填过,反复重填同一个东西。
                return { secret: '', broken: true };
            }
            try {
                const text = safeStorage.decryptString(globalThis.Buffer.from(enc, 'base64'));
                return { secret: String(text ?? '').trim(), broken: false };
            } catch (err) {
                log.warn?.('[video] 密钥解密失败', err);
                return { secret: '', broken: true };
            }
        }
        const plain = settings.get(VIDEO_NAMESPACE, KEY_SETTING);
        return { secret: typeof plain === 'string' ? plain.trim() : '', broken: false };
    }

    /** 对外的凭证状态。**只有三个叶子字段,绝不含密钥值。** */
    function summary() {
        if (envSecret() !== '') return { ok: true, source: 'env', reason: null, storage: 'env' };
        const stored = storedSecret();
        if (stored.broken) {
            return {
                ok: false,
                source: null,
                storage: canEncrypt() ? 'encrypted' : 'plain',
                reason: '存下来的密钥解不开(换过机器或系统账户?)。重新填一次就好。',
            };
        }
        if (stored.secret !== '') {
            return {
                ok: true,
                source: 'settings',
                reason: null,
                storage: canEncrypt() ? 'encrypted' : 'plain',
            };
        }
        return {
            ok: false,
            source: null,
            reason: MISSING_KEY_REASON,
            storage: canEncrypt() ? 'encrypted' : 'plain',
        };
    }

    /** 给 provider 的密钥。**只有主进程内部会调它**,返回值绝不进任何 IPC 结果。 */
    function resolveSecret() {
        const fromEnv = envSecret();
        if (fromEnv !== '') return { ok: true, secret: fromEnv, source: 'env', reason: null };
        const stored = storedSecret();
        if (stored.broken) return { ok: false, secret: '', source: null, reason: '存下来的密钥解不开,请重新填一次' };
        if (stored.secret !== '') return { ok: true, secret: stored.secret, source: 'settings', reason: null };
        return { ok: false, secret: '', source: null, reason: MISSING_KEY_REASON };
    }

    /**
     * 存一把密钥。成功返回 `{ok:true, storage}` —— **不回显任何值**。
     * 存的时候把另一种形状清掉,免得"改了密钥但读到的是旧的"。
     */
    function saveKey(value) {
        const verdict = validateKeyInput(value);
        if (verdict.ok !== true) return { ok: false, code: 'invalid_key', reason: verdict.reason };
        if (canEncrypt()) {
            try {
                const enc = safeStorage.encryptString(verdict.value);
                settings.set(VIDEO_NAMESPACE, KEY_ENC_SETTING, globalThis.Buffer.from(enc).toString('base64'));
                settings.set(VIDEO_NAMESPACE, KEY_SETTING, '');
                return { ok: true, storage: 'encrypted' };
            } catch (err) {
                // 加密失败**不静默退回明文**:那会让用户以为存的是密文。
                log.warn?.('[video] 加密失败,没有保存', err);
                return { ok: false, code: 'encrypt_failed', reason: `系统加密不可用,密钥没有保存(${String(err?.message ?? err)})。可以改用环境变量 DASHSCOPE_API_KEY。` };
            }
        }
        settings.set(VIDEO_NAMESPACE, KEY_SETTING, verdict.value);
        settings.set(VIDEO_NAMESPACE, KEY_ENC_SETTING, '');
        return { ok: true, storage: 'plain' };
    }

    /** 清掉保存的密钥(环境变量那份不受影响 —— 那不该由应用来改)。 */
    function clearKey() {
        settings.set(VIDEO_NAMESPACE, KEY_ENC_SETTING, '');
        settings.set(VIDEO_NAMESPACE, KEY_SETTING, '');
        return { ok: true };
    }

    /** 生效的模型 / 输出上限。非法值一律退回默认(不抛)。 */
    function config() {
        const d = defaultConfig();
        const rawModel = normalizeVideoModel(settings.get(VIDEO_NAMESPACE, MODEL_SETTING));
        const rawTokens = Number(settings.get(VIDEO_NAMESPACE, MAX_TOKENS_SETTING));
        const rawInline = Number(settings.get(VIDEO_NAMESPACE, INLINE_LIMIT_SETTING));
        return {
            model: rawModel === '' ? d.model : rawModel,
            maxTokens: Number.isFinite(rawTokens) && rawTokens >= MIN_MAX_TOKENS && rawTokens <= MAX_MAX_TOKENS
                ? Math.floor(rawTokens) : d.maxTokens,
            // 上限只许在 (1 MiB, MAX_DATA_URI_BYTES] 之间调 —— 超过服务端的硬上限
            // 就是"调了一个注定 400 的值",那比不许调更糟。
            inlineLimitBytes: Number.isFinite(rawInline) && rawInline > 1024 * 1024 && rawInline <= MAX_DATA_URI_BYTES
                ? Math.floor(rawInline) : d.inlineLimitBytes,
        };
    }

    /** 换模型。白名单之外一律拒(它进请求体,不可信)。 */
    function setModel(value) {
        const model = normalizeVideoModel(value);
        if (model === '') return { ok: false, code: 'bad_model', reason: `不认识的模型:${String(value ?? '').trim() || '(空)'}` };
        settings.set(VIDEO_NAMESPACE, MODEL_SETTING, model);
        return { ok: true, model };
    }

    return { summary, resolveSecret, saveKey, clearKey, config, setModel };
}
