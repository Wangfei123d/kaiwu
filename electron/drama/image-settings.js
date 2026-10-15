/** APINebula 图片服务凭证只在主进程内解析，不进入项目文件或 IPC 状态。 */
export const IMAGE_MODEL = 'gpt-image-2.5';
export const IMAGE_BASE_URL = 'https://img-api.apinebula.ai/v1';
export const IMAGE_SIZE = '1080x1920';
export const IMAGE_KEY_ENV = 'DSH_DRAMA_IMAGE_API_KEY';

const NAMESPACE = '__image';
const ENCRYPTED_KEY = 'apiKeyEnc';
const PLAIN_KEY = 'apiKey';

export function createImageSettings({ settings, safeStorage = null, env = process.env } = {}) {
    if (typeof settings?.get !== 'function' || typeof settings?.set !== 'function') {
        throw new Error('图片服务设置需要 settings 存储');
    }

    function canEncrypt() {
        try {
            return safeStorage?.isEncryptionAvailable?.() === true
                && typeof safeStorage.encryptString === 'function'
                && typeof safeStorage.decryptString === 'function';
        } catch { return false; }
    }

    function fromEnvironment() {
        return typeof env?.[IMAGE_KEY_ENV] === 'string' ? env[IMAGE_KEY_ENV].trim() : '';
    }

    function fromSettings() {
        const encoded = settings.get(NAMESPACE, ENCRYPTED_KEY);
        if (typeof encoded !== 'string' || encoded === '') return { secret: '', broken: false };
        if (!canEncrypt()) return { secret: '', broken: true };
        try {
            const secret = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
            return { secret: String(secret ?? '').trim(), broken: false };
        } catch { return { secret: '', broken: true }; }
    }

    function resolveKey() {
        const external = fromEnvironment();
        if (external !== '') return { ok: true, secret: external, source: 'env', reason: null };
        const stored = fromSettings();
        if (stored.broken) return { ok: false, secret: '', source: null,
            reason: '已保存的图片密钥无法解密，请在设置页重新录入' };
        if (stored.secret !== '') return { ok: true, secret: stored.secret, source: 'settings', reason: null };
        return { ok: false, secret: '', source: null,
            reason: '图片密钥未配置，请在设置页录入，或设置 DSH_DRAMA_IMAGE_API_KEY' };
    }

    function status() {
        const { ok, source, reason } = resolveKey();
        return {
            ok, source, reason,
            storage: source === 'env' ? 'env' : canEncrypt() ? 'encrypted' : 'unavailable',
            model: IMAGE_MODEL, baseUrl: IMAGE_BASE_URL, size: IMAGE_SIZE,
        };
    }

    function saveKey(value) {
        const secret = String(value ?? '').trim();
        if (!/^sk-\S{17,509}$/.test(secret)) {
            return { ok: false, reason: '请输入完整的 sk- 开头图片密钥，不能含空格或换行' };
        }
        if (!canEncrypt()) {
            return { ok: false, reason: '系统加密不可用，未保存明文；可改用环境变量 DSH_DRAMA_IMAGE_API_KEY' };
        }
        try {
            const encrypted = safeStorage.encryptString(secret);
            settings.set(NAMESPACE, ENCRYPTED_KEY, Buffer.from(encrypted).toString('base64'));
            settings.set(NAMESPACE, PLAIN_KEY, '');
            return { ok: true, storage: 'encrypted' };
        } catch {
            return { ok: false, reason: '图片密钥加密或保存失败，未保存明文' };
        }
    }

    function clearKey() {
        settings.set(NAMESPACE, ENCRYPTED_KEY, '');
        settings.set(NAMESPACE, PLAIN_KEY, '');
        return { ok: true };
    }

    return { status, saveKey, clearKey, resolveKey };
}
