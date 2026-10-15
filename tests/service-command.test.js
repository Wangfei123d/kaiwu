import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 守住一个会让"启动服务"必然失败、而清单校验却一路通过的坑:
//
//   清单里的 command 是**相对服务根目录**的(如 `.python-runtime/python.exe`),
//   而服务自己的 cwd 是另一个子目录(如 `bilidown`)。
//   子进程的 `spawn(command, args, { cwd })` 会把**相对命令按 cwd 解析** ——
//   于是去找 `bilidown/.python-runtime/python.exe`,ENOENT。
//
// electron/main.js 的 resolveCommand() 就是为了修它而存在的。
// 这里既验证"不解析会失败"(说明这个坑是真的),也验证"解析后成功"。

const ROOT = 'D:\\project\\personal_web_project';
const PY = path.join(ROOT, '.python-runtime', 'python.exe');
const SUB = path.join(ROOT, 'bilidown');

test('前置:本地确实有 Python 运行时(没有就跳过这组)', (t) => {
    if (!fs.existsSync(PY)) {
        t.skip('本机没有 .python-runtime,跳过');
        return;
    }
    assert.ok(fs.existsSync(SUB), '服务子目录也该存在');
});

test('不解析相对命令 → spawn 会 ENOENT(证明这个坑是真的)', (t) => {
    if (!fs.existsSync(PY)) return t.skip('无 python 运行时');
    const r = spawnSync('.python-runtime/python.exe', ['-c', 'print(1)'], {
        cwd: SUB, encoding: 'utf8',
    });
    assert.equal(r.error?.code, 'ENOENT',
        '若这里不再 ENOENT,说明 Node 的解析行为变了,resolveCommand 的必要性要重新评估');
});

test('解析成绝对路径后能正常执行', (t) => {
    if (!fs.existsSync(PY)) return t.skip('无 python 运行时');
    const r = spawnSync(PY, ['-c', 'print("ok")'], { cwd: SUB, encoding: 'utf8' });
    assert.equal(r.error, undefined, String(r.error?.message));
    assert.equal(r.status, 0, String(r.stderr));
    assert.equal(r.stdout.trim(), 'ok');
});

test('resolveCommand 的判定规则:裸命令名交给 PATH,带路径的解析到服务根目录', () => {
    // 规则与 electron/main.js 的 resolveCommand 一致。
    // 这里复刻一份,是为了把"什么算路径"这条约定固定下来。
    const looksLikePath = (cmd) => /[\\/]/.test(cmd) || /^[a-zA-Z]:/.test(cmd);

    assert.equal(looksLikePath('node'), false, '裸命令名不该被当路径');
    assert.equal(looksLikePath('python'), false);
    assert.equal(looksLikePath('.python-runtime/python.exe'), true);
    assert.equal(looksLikePath('.python-runtime\\python.exe'), true);
    assert.equal(looksLikePath('D:\\py\\python.exe'), true);
    assert.equal(looksLikePath('/usr/bin/node'), true);
});

test('仓库里所有插件的带路径 command 都能按"服务根目录"解析到', () => {
    const plugins = path.join(import.meta.dirname, '..', 'plugins');
    const resolved = [];
    for (const name of fs.readdirSync(plugins)) {
        const pj = path.join(plugins, name, 'plugin.json');
        if (!fs.existsSync(pj)) continue;
        const raw = JSON.parse(fs.readFileSync(pj, 'utf8'));
        for (const s of raw.contributes?.services ?? []) {
            const cmd = String(s.command ?? '');
            if (!/[\\/]/.test(cmd)) continue;              // 裸命令名跳过
            const abs = path.isAbsolute(cmd) ? cmd : path.resolve(ROOT, cmd);
            resolved.push({ plugin: name, service: s.id, cmd, abs, exists: fs.existsSync(abs) });
        }
    }
    assert.ok(resolved.length > 0, '应当有至少一个带路径的服务命令(抖音/B站用的 python)');
    for (const r of resolved) {
        assert.equal(r.exists, true,
            `${r.plugin}/${r.service}:command 按服务根目录解析不到 → ${r.abs}`);
    }
});
