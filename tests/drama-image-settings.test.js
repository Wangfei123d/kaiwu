import { test } from 'node:test';
import assert from 'node:assert/strict';

function memorySettings() {
    const data = new Map();
    return {
        get: (ns, key) => data.get(`${ns}:${key}`),
        set: (ns, key, value) => data.set(`${ns}:${key}`, value),
    };
}

const fakeKey = 'sk-test-not-a-real-key-1234567890';

test('图片密钥仅密文落盘，状态不回显，主进程能解密读取', async () => {
    const { createImageSettings } = await import('../electron/drama/image-settings.js');
    const settings = memorySettings();
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`cipher:${value}`),
        decryptString: (bytes) => bytes.toString().slice('cipher:'.length),
    };
    const image = createImageSettings({ settings, safeStorage, env: {} });

    assert.equal(image.saveKey(fakeKey).ok, true);
    assert.equal(settings.get('__image', 'apiKey'), '');
    assert.notEqual(settings.get('__image', 'apiKeyEnc'), fakeKey);
    assert.equal(image.status().ok, true);
    assert.equal(JSON.stringify(image.status()).includes(fakeKey), false);
    assert.equal(image.resolveKey().secret, fakeKey);
    assert.equal(image.clearKey().ok, true);
    assert.equal(image.status().ok, false);
});

test('图片密钥不在加密不可用时明文保存，环境变量优先', async () => {
    const { createImageSettings } = await import('../electron/drama/image-settings.js');
    const settings = memorySettings();
    const image = createImageSettings({ settings, safeStorage: null, env: {} });
    assert.equal(image.saveKey(fakeKey).ok, false);
    assert.equal(settings.get('__image', 'apiKeyEnc'), undefined);
    assert.equal(settings.get('__image', 'apiKey'), undefined);

    const withEnv = createImageSettings({ settings, safeStorage: null,
        env: { DSH_DRAMA_IMAGE_API_KEY: fakeKey } });
    assert.equal(withEnv.status().source, 'env');
    assert.equal(withEnv.resolveKey().secret, fakeKey);
    assert.equal(JSON.stringify(withEnv.status()).includes(fakeKey), false);
});
