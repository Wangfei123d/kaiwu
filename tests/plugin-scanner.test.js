import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPlugins } from '../electron/plugin-scanner.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(DIR, 'fixtures', 'plugins');

const roots = [{ id: 'plugin', dir: FIXTURES, urlBase: 'toolbox://plugin/' }];

test('扫描到文件夹形态与单文件形态两种', async () => {
    const list = await scanPlugins({ roots });
    const ids = list.map(p => p.id).sort();
    assert.deepEqual(ids, ['bad-json', 'good', 'single']);
});

test('文件夹形态产出完整描述符', async () => {
    const list = await scanPlugins({ roots });
    const good = list.find(p => p.id === 'good');
    assert.equal(good.status, 'ok');
    assert.equal(good.root, 'plugin');
    assert.equal(good.order, 5);
    assert.equal(good.entryUrl, 'toolbox://plugin/good/index.js');
    assert.deepEqual(good.permissions, ['log']);
    assert.equal(good.contributions.tools.length, 1);
    assert.equal(good.needsRuntimeManifest, false);
});

test('文件夹形态的描述符带 name / version / dir', async () => {
    const list = await scanPlugins({ roots });
    const good = list.find(p => p.id === 'good');
    assert.equal(good.name, '示例插件');
    assert.equal(good.version, '1.0.0');
    assert.equal(good.dir, path.join(FIXTURES, 'good'));
});

test('清单非法的文件夹插件标 broken,不抛异常', async () => {
    const list = await scanPlugins({ roots });
    const bad = list.find(p => p.id === 'bad-json');
    assert.equal(bad.status, 'broken');
    assert.ok(bad.error.message);
    assert.equal(bad.error.stage, 'manifest');
});

test('清单非法的错误信息带上来源路径', async () => {
    const list = await scanPlugins({ roots });
    const bad = list.find(p => p.id === 'bad-json');
    assert.match(bad.error.message, /plugin\.json/);
});

test('单文件形态标 needsRuntimeManifest', async () => {
    const list = await scanPlugins({ roots });
    const single = list.find(p => p.id === 'single');
    assert.equal(single.needsRuntimeManifest, true);
    assert.equal(single.entryUrl, 'toolbox://plugin/single.tool.js');
    assert.deepEqual(single.permissions, []);
});

test('单文件形态的 id 取自文件名去掉 .tool.js', async () => {
    const list = await scanPlugins({ roots });
    const single = list.find(p => p.id === 'single');
    assert.equal(single.status, 'ok');
    assert.equal(single.dir, FIXTURES);
    assert.deepEqual(single.contributions, { tools: [], services: [] });
});

test('不存在的根目录不报错,返回空', async () => {
    const list = await scanPlugins({
        roots: [{ id: 'user', dir: path.join(FIXTURES, '不存在'), urlBase: 'toolbox://user/' }],
    });
    assert.deepEqual(list, []);
});

test('两个根出现重复 id 时后者标 duplicate-id', async () => {
    const list = await scanPlugins({
        roots: [
            { id: 'plugin', dir: FIXTURES, urlBase: 'toolbox://plugin/' },
            { id: 'user', dir: FIXTURES, urlBase: 'toolbox://user/' },
        ],
    });
    const good = list.filter(p => p.id === 'good');
    assert.equal(good.length, 2);
    assert.equal(good[0].status, 'ok');
    assert.equal(good[1].status, 'broken');
    assert.equal(good[1].error.stage, 'duplicate-id');
});

test('重复 id 时先出现的那个保持可用', async () => {
    const list = await scanPlugins({
        roots: [
            { id: 'plugin', dir: FIXTURES, urlBase: 'toolbox://plugin/' },
            { id: 'user', dir: FIXTURES, urlBase: 'toolbox://user/' },
        ],
    });
    const good = list.filter(p => p.id === 'good');
    assert.equal(good[0].entryUrl, 'toolbox://plugin/good/index.js');
    assert.equal(good[1].entryUrl, 'toolbox://user/good/index.js');
});

test('坏掉的插件不参与 id 去重占位', async () => {
    // bad-json 在两个根里都出现,但两个都是 broken(清单非法),
    // 不该被误判成 duplicate-id —— 它压根没有合法的 id 可用。
    const list = await scanPlugins({
        roots: [
            { id: 'plugin', dir: FIXTURES, urlBase: 'toolbox://plugin/' },
            { id: 'user', dir: FIXTURES, urlBase: 'toolbox://user/' },
        ],
    });
    const bad = list.filter(p => p.id === 'bad-json');
    assert.equal(bad.length, 2);
    for (const b of bad) assert.equal(b.error.stage, 'manifest');
});

test('没有 plugin.json 的目录被静默跳过', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-scan-'));
    try {
        fs.mkdirSync(path.join(base, '不是插件'));
        fs.writeFileSync(path.join(base, '不是插件', 'readme.txt'), 'x');
        fs.mkdirSync(path.join(base, '真插件'));
        fs.writeFileSync(path.join(base, '真插件', 'plugin.json'), JSON.stringify({
            id: 'real', name: '真的', version: '1.0.0',
        }));
        const list = await scanPlugins({
            roots: [{ id: 'plugin', dir: base, urlBase: 'toolbox://plugin/' }],
        });
        assert.deepEqual(list.map(p => p.id), ['real']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('plugin.json 不是合法 JSON 时标 broken', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-scan-'));
    try {
        fs.mkdirSync(path.join(base, 'brokenjson'));
        fs.writeFileSync(path.join(base, 'brokenjson', 'plugin.json'), '{ 这不是 JSON');
        const list = await scanPlugins({
            roots: [{ id: 'plugin', dir: base, urlBase: 'toolbox://plugin/' }],
        });
        assert.equal(list.length, 1);
        assert.equal(list[0].status, 'broken');
        assert.equal(list[0].error.stage, 'manifest');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('非 .tool.js 的普通文件被忽略', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-scan-'));
    try {
        fs.writeFileSync(path.join(base, 'readme.md'), '# 不是插件');
        fs.writeFileSync(path.join(base, 'helper.js'), 'export default {}');
        const list = await scanPlugins({
            roots: [{ id: 'plugin', dir: base, urlBase: 'toolbox://plugin/' }],
        });
        assert.deepEqual(list, [], '只有 *.tool.js 才算单文件插件');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('用户根的 entryUrl 指向用户根的 urlBase', async () => {
    const list = await scanPlugins({
        roots: [{ id: 'user', dir: FIXTURES, urlBase: 'toolbox://user/' }],
    });
    assert.equal(list.find(p => p.id === 'good').entryUrl, 'toolbox://user/good/index.js');
    assert.equal(list.find(p => p.id === 'single').entryUrl, 'toolbox://user/single.tool.js');
});

test('清单里的 entry 会被用进 entryUrl', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-scan-'));
    try {
        fs.mkdirSync(path.join(base, 'custom'));
        fs.writeFileSync(path.join(base, 'custom', 'plugin.json'), JSON.stringify({
            id: 'custom', name: '自定义入口', version: '1.0.0', entry: 'main.js',
        }));
        const list = await scanPlugins({
            roots: [{ id: 'plugin', dir: base, urlBase: 'toolbox://plugin/' }],
        });
        assert.equal(list[0].entryUrl, 'toolbox://plugin/custom/main.js');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('描述符形状完整 —— 渲染进程只依赖这些字段', async () => {
    const list = await scanPlugins({ roots });
    for (const p of list) {
        for (const key of ['id', 'name', 'version', 'description', 'author', 'order',
            'root', 'dir', 'entryUrl', 'permissions', 'contributions',
            'needsRuntimeManifest', 'status', 'error']) {
            assert.ok(key in p, `${p.id} 缺少字段 ${key}`);
        }
    }
});
