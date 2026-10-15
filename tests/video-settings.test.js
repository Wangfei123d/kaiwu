import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DATA_URI_BYTES } from '../app/lib/agent-video.js';
import {
    KEY_ENC_SETTING, KEY_SETTING, MAX_TOKENS_SETTING, MODEL_SETTING,
    VIDEO_ENV_VAR, VIDEO_NAMESPACE, createVideoSettings, defaultConfig, validateKeyInput,
} from '../electron/video/video-settings.js';

// 「视频理解」的配置与密钥存放。
//
// 为什么这些用例重要:kaiwu 原本**不存**任何密钥(DeepSeek 那把只从环境变量或
// `.credentials.yaml` 读),所以视频这条是**第一处**把密钥写进应用自己的设置文件的地方。
// 三件事必须钉住:
//   1. 优先级(环境变量 > 设置文件)—— 顺序错了会出现"我明明改了环境变量却还是旧的";
//   2. 密钥**永不进界面**:summary() 只有 { ok, source, reason };
//   3. 加密不可用时**明确降级**成明文,而不是假装存好了或者静默失败。

/** 设置存储替身(形状与 electron/settings-store.js 的产物一致)。 */
function makeSettings(initial = {}) {
    const data = JSON.parse(JSON.stringify(initial));
    return {
        data,
        get: (ns, key) => data?.[ns]?.[key],
        set: (ns, key, value) => {
            data[ns] ??= {};
            data[ns][key] = value;
        },
    };
}

/** safeStorage 替身:能"加密"成可识别的字节,也能解回来。 */
function makeSafeStorage({ available = true, failDecrypt = false } = {}) {
    return {
        isEncryptionAvailable: () => available,
        encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
        decryptString: (buf) => {
            if (failDecrypt) throw new Error('DPAPI 解不开');
            const text = Buffer.from(buf).toString('utf8');
            if (!text.startsWith('enc:')) throw new Error('不是这份实现加的密');
            return text.slice(4);
        },
    };
}

const KEY = 'sk-ws-abcdefghijklmnopqrstuvwx';

test('validateKeyInput:空、带空白、不像密钥的一律拒,并说清哪里不对', () => {
    assert.equal(validateKeyInput('').ok, false);
    assert.match(validateKeyInput('').reason, /不能为空/);
    // 最常见的一次误操作:把整行 export 粘进来
    const withExport = validateKeyInput(`export ${VIDEO_ENV_VAR}=${KEY}`);
    assert.equal(withExport.ok, false);
    assert.match(withExport.reason, /空格或换行/);
    assert.match(validateKeyInput('hello-world-hello-world').reason, /sk-/);
    assert.match(validateKeyInput('sk-short').reason, /太短/);
    assert.match(validateKeyInput(`sk-${'x'.repeat(600)}`).reason, /太长/);
});

test('validateKeyInput:正常的一串通过,并且去掉首尾空白', () => {
    const r = validateKeyInput(`  ${KEY}  `);
    assert.deepEqual(r, { ok: true, value: KEY });
});

test('没配任何东西时:summary 说没配(resolveSecret 也给同一句)', () => {
    const settings = makeSettings();
    const vs = createVideoSettings({ settings, env: {} });
    const summary = vs.summary();
    assert.equal(summary.ok, false);
    assert.equal(summary.source, null);
    assert.match(summary.reason, /没有配置 DashScope 密钥/);
    assert.equal(vs.resolveSecret().ok, false);
});

test('环境变量优先于设置文件(顺序反了会出现"改了环境变量还是旧的")', () => {
    const settings = makeSettings();
    const vs = createVideoSettings({ settings, env: { [VIDEO_ENV_VAR]: 'sk-ws-from-env-env-env-env' } });
    assert.equal(vs.resolveSecret().secret, 'sk-ws-from-env-env-env-env');
    assert.equal(vs.summary().source, 'env');
    vs.saveKey(KEY);
    // 存了也不该盖过环境变量
    assert.equal(vs.resolveSecret().secret, 'sk-ws-from-env-env-env-env');
    assert.equal(vs.summary().source, 'env');
});

test('没有 safeStorage 时:存成明文,而且 summary 的 storage 如实说"plain"', () => {
    const settings = makeSettings();
    const vs = createVideoSettings({ settings, env: {} });
    const saved = vs.saveKey(KEY);
    assert.deepEqual(saved, { ok: true, storage: 'plain' });
    assert.equal(settings.get(VIDEO_NAMESPACE, KEY_SETTING), KEY);
    assert.equal(settings.get(VIDEO_NAMESPACE, KEY_ENC_SETTING), '');
    assert.equal(vs.summary().ok, true);
    assert.equal(vs.summary().source, 'settings');
    assert.equal(vs.summary().storage, 'plain');
    assert.equal(vs.resolveSecret().secret, KEY);
});

test('有 safeStorage 时:存成密文,明文键清空,读的时候解得回来', () => {
    const settings = makeSettings();
    const vs = createVideoSettings({ settings, env: {}, safeStorage: makeSafeStorage() });
    const saved = vs.saveKey(KEY);
    assert.deepEqual(saved, { ok: true, storage: 'encrypted' });
    assert.equal(settings.get(VIDEO_NAMESPACE, KEY_SETTING), '');
    const stored = settings.get(VIDEO_NAMESPACE, KEY_ENC_SETTING);
    assert.equal(Buffer.from(stored, 'base64').toString('utf8'), `enc:${KEY}`);
    assert.equal(vs.resolveSecret().secret, KEY);
    assert.equal(vs.summary().storage, 'encrypted');
});

test('存过密文但这次解不开:说"解不开,请重填",**不许**说成"你没配"', () => {
    const settings = makeSettings({
        [VIDEO_NAMESPACE]: { [KEY_ENC_SETTING]: Buffer.from('enc:' + KEY).toString('base64') },
    });
    // 这次环境里没有可用的 safeStorage(换了机器/系统账户的典型表现)
    const vs = createVideoSettings({ settings, env: {} });
    const summary = vs.summary();
    assert.equal(summary.ok, false);
    assert.match(summary.reason, /解不开/);
    assert.equal(vs.resolveSecret().ok, false);
    assert.match(vs.resolveSecret().reason, /重新填/);

    // 有 safeStorage 但解密自己失败(比如换了系统账户)
    const vs2 = createVideoSettings({ settings, env: {}, safeStorage: makeSafeStorage({ failDecrypt: true }) });
    assert.match(vs2.summary().reason, /解不开/);
});

test('summary 只有三个叶子字段,任何情况下都不含密钥值', () => {
    const settings = makeSettings();
    const vs = createVideoSettings({ settings, env: {}, safeStorage: makeSafeStorage() });
    vs.saveKey(KEY);
    assert.deepEqual(Object.keys(vs.summary()).sort(), ['ok', 'reason', 'source', 'storage']);
    assert.equal(JSON.stringify(vs.summary()).includes(KEY), false);
    assert.equal(JSON.stringify(vs.summary()).includes('enc:'), false);
});

test('saveKey 失败(加密抛错)时**不静默退回明文**,并给出替代方案', () => {
    const settings = makeSettings();
    const broken = {
        isEncryptionAvailable: () => true,
        encryptString: () => { throw new Error('没有可用的密钥环'); },
        decryptString: () => '',
    };
    const vs = createVideoSettings({ settings, env: {}, safeStorage: broken, log: { warn() {} } });
    const saved = vs.saveKey(KEY);
    assert.equal(saved.ok, false);
    assert.equal(saved.code, 'encrypt_failed');
    assert.match(saved.reason, /没有保存/);
    assert.equal(settings.get(VIDEO_NAMESPACE, KEY_SETTING), undefined);
});

test('saveKey 拒绝非法输入时**什么都不写**', () => {
    const settings = makeSettings();
    const vs = createVideoSettings({ settings, env: {} });
    const saved = vs.saveKey('not-a-key');
    assert.equal(saved.ok, false);
    assert.equal(saved.code, 'invalid_key');
    assert.equal(settings.get(VIDEO_NAMESPACE, KEY_SETTING), undefined);
});

test('clearKey 清掉两份,环境变量那份不受影响', () => {
    const settings = makeSettings();
    const vs = createVideoSettings({ settings, env: {} });
    vs.saveKey(KEY);
    assert.deepEqual(vs.clearKey(), { ok: true });
    assert.equal(vs.summary().ok, false);
    assert.equal(settings.get(VIDEO_NAMESPACE, KEY_SETTING), '');
    assert.equal(settings.get(VIDEO_NAMESPACE, KEY_ENC_SETTING), '');

    const withEnv = createVideoSettings({ settings, env: { [VIDEO_ENV_VAR]: 'sk-ws-env-stays-env-stays' } });
    withEnv.clearKey();
    assert.equal(withEnv.summary().ok, true);
});

test('config:默认值与纯模块里的默认值一致(不是这里另写一份)', () => {
    const vs = createVideoSettings({ settings: makeSettings(), env: {} });
    const cfg = vs.config();
    assert.deepEqual(cfg, defaultConfig());
    assert.equal(cfg.model, 'qwen3-vl-flash');
    assert.equal(cfg.maxTokens, 800);
    assert.equal(cfg.inlineLimitBytes, MAX_DATA_URI_BYTES - 1024 * 1024);
    // "自动理解"这个概念已经不存在了:配置里不该再有那个键(留着它下一个人会以为
    // 它能控制什么,而真正决定"发不发"的只有用户按不按发送)
    assert.equal('autoUnderstand' in cfg, false);
});

test('config:设置里的非法值一律退回默认(不抛、不把非法值送进请求体)', () => {
    const settings = makeSettings({
        [VIDEO_NAMESPACE]: {
            [MODEL_SETTING]: 'gpt-4o',
            [MAX_TOKENS_SETTING]: 999999,
        },
    });
    const cfg = createVideoSettings({ settings, env: {} }).config();
    assert.equal(cfg.model, 'qwen3-vl-flash');
    assert.equal(cfg.maxTokens, 800);
});

test('config:合法值生效', () => {
    const settings = makeSettings({
        [VIDEO_NAMESPACE]: {
            [MODEL_SETTING]: 'qwen3-vl-plus',
            [MAX_TOKENS_SETTING]: 1600,
        },
    });
    const cfg = createVideoSettings({ settings, env: {} }).config();
    assert.equal(cfg.model, 'qwen3-vl-plus');
    assert.equal(cfg.maxTokens, 1600);
});

test('设置里残留的 autoUnderstand 键一律被忽略(升级上来的老设置不该改变行为)', () => {
    // 老版本可能已经把 autoUnderstand 写进了设置文件;新的 config() 不再读它,
    // 于是"拖进来就发请求"这类老行为不会因为一个残留键复活。
    const settings = makeSettings({ [VIDEO_NAMESPACE]: { autoUnderstand: true } });
    const cfg = createVideoSettings({ settings, env: {} }).config();
    assert.deepEqual(cfg, defaultConfig());
});

test('config:内联上限不许被调到服务端硬上限之上(那是一个注定 400 的值)', () => {
    const settings = makeSettings({ [VIDEO_NAMESPACE]: { inlineLimitBytes: MAX_DATA_URI_BYTES * 2 } });
    const cfg = createVideoSettings({ settings, env: {} }).config();
    assert.equal(cfg.inlineLimitBytes, defaultConfig().inlineLimitBytes);
});

test('setModel 只认白名单里的模型', () => {
    const vs = createVideoSettings({ settings: makeSettings(), env: {} });
    assert.deepEqual(vs.setModel('qwen3-vl-plus'), { ok: true, model: 'qwen3-vl-plus' });
    const bad = vs.setModel('qwen-max');
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad_model');
    assert.equal(vs.config().model, 'qwen3-vl-plus');
});

test('接线错了要当场抛(不是等用户拖进视频才炸)', () => {
    assert.throws(() => createVideoSettings({}), /需要 settings/);
    assert.throws(() => createVideoSettings({ settings: {} }), /需要 settings/);
});
