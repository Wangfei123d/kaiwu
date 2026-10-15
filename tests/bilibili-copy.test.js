import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CLIPBOARD_OK_MARKER, CLIPBOARD_RETRIES, COPY_EXTENSIONS, POWERSHELL_EXE,
    admitClipboardPath, buildClipboardInvocation, buildClipboardScript,
    interpretClipboardResult, isRetryableClipboardResult,
} from '../app/lib/bilibili-copy.js';

// 「复制视频」那条链路里**能纯函数化的部分**:脚本长什么样、参数怎么传、
// 结果怎么判定、什么值得重试。
//
// 为什么这些要单独钉住:这条链路的失败模式极其阴——最坏的一种是
// "退出码 0、没有报错、剪贴板里却什么都没变"(pwsh 默认 MTA 时的实测行为)。
// 所以判定必须**只认脚本自己打出来的标记**,而不是退出码。

const REAL_FILE = 'D:\\project\\bilidown\\download\\中国人能飞😭 [高清 1080P60] NA.mp4';

// ---------- 路径准入 ----------

test('路径准入:本地绝对路径 + 视频扩展名才放行', () => {
    assert.equal(admitClipboardPath(REAL_FILE).ok, true);
    assert.equal(admitClipboardPath('D:\\a\\b.MP4').ok, true, '大小写不敏感');
    assert.deepEqual([...COPY_EXTENSIONS].slice(0, 3), ['.mp4', '.mkv', '.flv']);
});

test('路径准入:UNC/相对/空/控制字符/别的扩展名一律拒(这个通道只该搬视频)', () => {
    for (const bad of ['', '   ', 'relative\\x.mp4', '\\\\server\\share\\x.mp4', 'D:\\a\\x.exe', 'D:\\a\\x', 'D:\\a\\x.mp4\nrm -rf']) {
        const verdict = admitClipboardPath(bad);
        assert.equal(verdict.ok, false, `${JSON.stringify(bad)} 不该通过`);
        assert.ok(verdict.reason.length > 0);
    }
    assert.match(admitClipboardPath('D:\\a\\x.exe').reason, /只允许复制视频文件/);
    assert.match(admitClipboardPath('D:\\a\\x.mp4\n').reason, /控制字符/);
});

test('路径准入:超长路径拒(避免把一串东西塞进命令行)', () => {
    const long = `D:\\${'x'.repeat(1100)}.mp4`;
    assert.equal(admitClipboardPath(long).ok, false);
    assert.match(admitClipboardPath(long).reason, /太长/);
});

// ---------- 脚本与参数 ----------

test('脚本:必须用 SetFileDropList 写 CF_HDROP,并打成功标记', () => {
    const script = buildClipboardScript(REAL_FILE);
    assert.match(script, /Add-Type -AssemblyName System\.Windows\.Forms/);
    assert.match(script, /\[System\.Windows\.Forms\.Clipboard\]::SetFileDropList\(\$files\)/);
    assert.match(script, /New-Object System\.Collections\.Specialized\.StringCollection/);
    assert.match(script, new RegExp(CLIPBOARD_OK_MARKER));
    // 路径原样在脚本里(用 PS 单引号字面量包着)
    assert.ok(script.includes(`'${REAL_FILE}'`));
});

test('脚本:路径里的单引号被转义成两个(否则会把 PowerShell 语法打开一个口子)', () => {
    const nasty = "D:\\a\\it's a 'test'.mp4";
    const script = buildClipboardScript(nasty);
    assert.ok(script.includes("'D:\\a\\it''s a ''test''.mp4'"));
    // 转义之后引号数量必须是偶数
    const line = script.split('\n').find(l => l.includes('$files.Add('));
    assert.equal((line.match(/'/g) ?? []).length % 2, 0);
});

test('调用参数:-STA 与 -NoProfile 必须在(STA 是这条链路成立的前提)', () => {
    const { command, args } = buildClipboardInvocation(REAL_FILE);
    assert.equal(command, POWERSHELL_EXE);
    assert.equal(command, 'powershell.exe', '必须是 5.1 的 powershell.exe,不是 pwsh');
    assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass']);
    assert.equal(args[4], '-Command');
    assert.equal(args.length, 6);
    assert.ok(args[5].includes('SetFileDropList'));
});

test('调用:非法路径直接抛(不让它走到起进程那一步)', () => {
    assert.throws(() => buildClipboardInvocation('D:\\a\\x.exe'), /只允许复制视频文件/);
    assert.throws(() => buildClipboardScript(''), /路径是空的/);
});

// ---------- 结果判定 ----------

test('判定:看见标记才算成功 —— 退出码 0 不算', () => {
    assert.deepEqual(interpretClipboardResult({ stdout: CLIPBOARD_OK_MARKER, code: 0 }), { ok: true, reason: '' });
    assert.deepEqual(
        interpretClipboardResult({ stdout: `noise\n${CLIPBOARD_OK_MARKER}\n`, code: 0 }).ok,
        true,
        '标记前后有别的输出也算',
    );
});

test('判定:"退出码 0 但没有标记"要说成静默失败(MTA 那一类),不能报成功', () => {
    const verdict = interpretClipboardResult({ stdout: '', stderr: '', code: 0 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /没有写入剪贴板/);
    assert.match(verdict.reason, /STA/);
});

test('判定:剪贴板被占用 / WinForms 用不了 / 超时,各有各的中文', () => {
    const busy = interpretClipboardResult({ stdout: '', stderr: 'Exception calling "SetFileDropList": CLIPBRD_E_CANT_OPEN', code: 1 });
    assert.match(busy.reason, /剪贴板被别的程序占用/);

    const noForms = interpretClipboardResult({ stdout: '', stderr: 'Add-Type : Cannot add type. The assembly System.Windows.Forms could not be found.', code: 1 });
    assert.match(noForms.reason, /System\.Windows\.Forms/);

    const timeout = interpretClipboardResult({ timedOut: true });
    assert.match(timeout.reason, /超时/);

    const noCode = interpretClipboardResult({ stdout: '', stderr: '', code: null });
    assert.match(noCode.reason, /没能启动 Windows PowerShell/);
});

test('判定:有报错时把原文带上(排查靠它,不能只给一句"失败了")', () => {
    const verdict = interpretClipboardResult({ stdout: '', stderr: 'x is not recognized as the name of a cmdlet', code: 1 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /is not recognized/);
});

// ---------- 重试决策 ----------

test('重试决策:占用与超时值得重试;路径被拒/标记缺失这类不值', () => {
    assert.equal(isRetryableClipboardResult({ code: 1, reason: '剪贴板被别的程序占用,重试 5 次仍失败' }), true);
    assert.equal(isRetryableClipboardResult({ timedOut: true, reason: '写系统剪贴板超时' }), true);
    assert.equal(isRetryableClipboardResult({ code: 1, reason: '别的错' }), true);
    assert.equal(isRetryableClipboardResult({ code: 0, reason: 'PowerShell 报告成功,但没有写入剪贴板' }), false);
    assert.equal(CLIPBOARD_RETRIES >= 3, true, '重试次数不能少到形同没做');
});
