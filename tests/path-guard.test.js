import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWithin, resolveWithinReal } from '../app/lib/path-guard.js';

const ROOT = 'D:\\project\\kaiwu\\plugins';

test('正常相对路径被解析到根目录之内', () => {
    assert.equal(resolveWithin(ROOT, 'palette/index.js'),
        'D:\\project\\kaiwu\\plugins\\palette\\index.js');
});

test('反斜杠写法同样解析正确', () => {
    assert.equal(resolveWithin(ROOT, 'palette\\panel.html'),
        'D:\\project\\kaiwu\\plugins\\palette\\panel.html');
});

test('../ 穿越被拒绝', () => {
    assert.equal(resolveWithin(ROOT, '../secrets.txt'), null);
});

test('多层 ../ 穿越被拒绝', () => {
    assert.equal(resolveWithin(ROOT, '../../Windows/win.ini'), null);
});

test('编码过的穿越同样被拒绝', () => {
    assert.equal(resolveWithin(ROOT, '..%2fsecrets.txt'), null);
});

test('绝对路径被拒绝', () => {
    assert.equal(resolveWithin(ROOT, 'D:/Windows/win.ini'), null);
});

test('空路径被拒绝', () => {
    assert.equal(resolveWithin(ROOT, ''), null);
});

test('前缀相同但并非子目录的路径被拒绝', () => {
    // "plugins-evil" 以 "plugins" 开头,却不是它的子目录。
    // 比较时补上分隔符(而不是直接 startsWith)就是为了挡住这一类。
    assert.equal(resolveWithin(ROOT, '../plugins-evil/x.js'), null);
});

test('根目录自身被接受', () => {
    assert.equal(resolveWithin(ROOT, '.'), path.resolve(ROOT));
});

// ---- 以下用例依赖真实文件系统 ----
//
// resolveWithin 是纯词法函数,结构上挡不住符号链接:当 plugins/escape 是指向
// D:\ 的链接时,"escape/secret.txt" 词法上确实落在根目录内。这一层由
// resolveWithinReal 负责。测试用「目录联接(junction)」构造真实越界现场 ——
// Windows 上普通符号链接需要管理员权限,而 junction 不需要。

function tempRoot(label) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `kaiwu-${label}-`));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
    return { base, root, outside };
}

test('经目录联接逃出根目录的路径被拒绝', () => {
    const { base, root, outside } = tempRoot('junction');
    try {
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');

        // 先确认真实现场成立:词法层放行,而且文件确实读得到。
        const lexical = resolveWithin(root, 'escape/secret.txt');
        assert.notEqual(lexical, null, '词法层应当放行 —— 所以光靠它不够');
        assert.equal(fs.statSync(lexical).isFile(), true);

        // 真实路径层必须挡住它。
        assert.equal(resolveWithinReal(root, 'escape/secret.txt'), null);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('根目录内的真实文件仍被接受', () => {
    const { base, root } = tempRoot('inside');
    try {
        fs.writeFileSync(path.join(root, 'ok.txt'), 'fine');
        assert.equal(resolveWithinReal(root, 'ok.txt'),
            fs.realpathSync(path.join(root, 'ok.txt')));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('通过联接绕回根目录内部的路径仍被接受', () => {
    const { base, root } = tempRoot('selflink');
    try {
        fs.writeFileSync(path.join(root, 'ok.txt'), 'fine');
        fs.symlinkSync(root, path.join(root, 'self'), 'junction');
        assert.notEqual(resolveWithinReal(root, 'self/ok.txt'), null,
            '指回根目录自身的链接不该被误判为越界');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('不存在的文件返回 null,由调用方决定 404', () => {
    const { base, root } = tempRoot('missing');
    try {
        assert.equal(resolveWithinReal(root, 'nope.txt'), null);
        // 关键:不能退化成「返回最近已存在祖先的真实路径」——
        // 那样根目录下任何不存在的文件都会返回根本身,包含判断必然通过。
        assert.equal(resolveWithinReal(root, 'deep/not/created/yet.txt'), null);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('不存在的根目录返回 null,不抛异常', () => {
    assert.equal(resolveWithinReal(path.join(os.tmpdir(), 'kaiwu-__不存在__'), 'a.js'), null);
});
