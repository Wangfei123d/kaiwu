import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../app/lib/manifest-schema.js';

// 清单校验只保证"字段齐全、格式对",**管不住路径写错**:
// command 打错一个字、cwd 指向不存在的目录,校验都会通过,
// 而用户点「启动服务」时才失败 —— 那时排查成本高得多。
// 所以这里把每个插件的服务声明真的解析一遍,确认目标存在。

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS = path.join(DIR, '..', 'plugins');

// 与 electron/main.js 的 DEFAULT_SERVICE_ROOT 保持一致。
// 服务清单里的 cwd 是**相对服务根目录**的,根目录在设置里。
const DEFAULT_SERVICE_ROOT = 'D:\\project\\personal_web_project';

function loadManifests() {
    const out = [];
    for (const name of fs.readdirSync(PLUGINS)) {
        const pj = path.join(PLUGINS, name, 'plugin.json');
        if (!fs.existsSync(pj)) continue;
        const raw = JSON.parse(fs.readFileSync(pj, 'utf8'));
        const r = validateManifest(raw, { sourceLabel: `${name}/plugin.json` });
        out.push({ name, dir: path.join(PLUGINS, name), result: r });
    }
    return out;
}

test('仓库里每个插件的清单都通过校验', () => {
    const all = loadManifests();
    assert.ok(all.length >= 4, `应当至少扫到 4 个插件,实际 ${all.length}`);
    for (const { name, result } of all) {
        assert.equal(result.ok, true,
            `${name} 清单不合法:` + JSON.stringify(result.errors));
    }
});

test('插件 id 互不重复', () => {
    const ids = loadManifests().map(m => m.result.value?.id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, '重复的插件 id:' + ids.join(','));
});

test('工具 id 互不重复', () => {
    const toolIds = loadManifests()
        .flatMap(m => (m.result.value?.contributes.tools ?? []).map(t => t.id));
    assert.equal(new Set(toolIds).size, toolIds.length,
        '重复的工具 id:' + toolIds.join(','));
});

test('指定的五个文件夹插件工具声明使用工作台面板', () => {
    const targets = new Set(['bilibili', 'douyin', 'music', 'palette', 'subtitle']);
    const all = loadManifests();
    for (const pluginId of targets) {
        const manifest = all.find((item) => item.result.value?.id === pluginId);
        assert.ok(manifest, `找不到目标插件清单:${pluginId}`);
        assert.ok(manifest.result.value.contributes.tools.some((tool) => tool.workspacePane === true),
            `${pluginId} 至少有一个工具必须标记为工作台面板`);
    }
});

test('服务 id 互不重复', () => {
    const svcIds = loadManifests()
        .flatMap(m => (m.result.value?.contributes.services ?? []).map(s => s.id));
    assert.equal(new Set(svcIds).size, svcIds.length,
        '重复的服务 id:' + svcIds.join(','));
});

test('服务端口互不冲突(两个服务抢同一端口会有一个永远起不来)', () => {
    const seen = new Map();
    for (const m of loadManifests()) {
        for (const s of m.result.value?.contributes.services ?? []) {
            if (seen.has(s.port)) {
                assert.fail(`端口 ${s.port} 被两个服务占用:`
                    + `${seen.get(s.port)} 与 ${s.id}`);
            }
            seen.set(s.port, s.id);
        }
    }
});

test('声明的服务:工作目录与命令都能在服务根目录下解析到', () => {
    for (const m of loadManifests()) {
        for (const s of m.result.value?.contributes.services ?? []) {
            const cwd = path.resolve(DEFAULT_SERVICE_ROOT, s.cwd);
            assert.ok(fs.existsSync(cwd),
                `${m.name} 的服务 ${s.id}:cwd 不存在 → ${cwd}`);

            // command 有两种写法,校验方式不同:
            //   "node"                     → 裸命令名,靠 PATH 解析,查不到文件是正常的
            //   ".python-runtime/python.exe" → 带路径,相对**服务根目录**解析
            //                                  (注意不是相对 cwd —— 两者容易混)
            const looksLikePath = /[\\/]/.test(s.command) || /^[a-zA-Z]:/.test(s.command);
            if (looksLikePath) {
                const candidates = path.isAbsolute(s.command)
                    ? [s.command]
                    : [path.resolve(DEFAULT_SERVICE_ROOT, s.command),
                        path.resolve(cwd, s.command)];
                assert.ok(candidates.some(c => fs.existsSync(c)),
                    `${m.name} 的服务 ${s.id}:command 找不到,试过:\n  `
                    + candidates.join('\n  '));
            }

            // 参数里若写了脚本文件,也要存在(否则是"命令对了、脚本名打错")
            for (const arg of s.args ?? []) {
                if (/\.(py|js|mjs|cjs)$/.test(arg)) {
                    const script = path.resolve(cwd, arg);
                    assert.ok(fs.existsSync(script),
                        `${m.name} 的服务 ${s.id}:入口脚本不存在 → ${script}`);
                }
            }
        }
    }
});

test('每个服务的 healthPath 都以 / 开头(否则健康检查永远失败)', () => {
    for (const m of loadManifests()) {
        for (const s of m.result.value?.contributes.services ?? []) {
            if (s.healthPath !== null) {
                assert.ok(s.healthPath.startsWith('/'),
                    `${m.name}/${s.id} 的 healthPath 必须以 / 开头`);
            }
        }
    }
});

test('每个工具都有对应的面板文件', () => {
    for (const { name, dir, result } of loadManifests()) {
        for (const t of result.value?.contributes.tools ?? []) {
            const panel = path.resolve(dir, t.panel);
            assert.ok(fs.existsSync(panel),
                `${name} 的工具 ${t.id}:面板文件不存在 → ${panel}`);
            if (t.style) {
                const style = path.resolve(dir, t.style);
                assert.ok(fs.existsSync(style),
                    `${name} 的工具 ${t.id}:样式文件不存在 → ${style}`);
            }
        }
    }
});

test('每个插件的 entry 都存在', () => {
    for (const { name, dir, result } of loadManifests()) {
        const entry = path.resolve(dir, result.value.entry);
        assert.ok(fs.existsSync(entry),
            `${name}:入口不存在 → ${entry}`);
    }
});
