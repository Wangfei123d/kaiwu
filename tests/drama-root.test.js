// 短剧项目根的判定。这一层的全部价值是**绝不把项目悄悄落到别处** ——
// 所以下面大半用例都是"该拒绝的必须拒绝,而且原因要能读懂"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDramaRoot, slugProjectName, DRAMA_DIR_NAME } from '../app/lib/drama-root.js';

test('配了笔记库:根 = <笔记库>/短剧,而且是个绝对路径', () => {
    const vault = path.resolve('D:/some/vault');
    const v = resolveDramaRoot(vault);
    assert.equal(v.root, path.join(vault, DRAMA_DIR_NAME));
    assert.equal(path.isAbsolute(v.root), true);
    assert.equal(v.reason, '');
    assert.equal(DRAMA_DIR_NAME, '短剧');
});

test('没配笔记库:拒绝,并说清"项目要落在笔记库旁边"', () => {
    for (const v of [null, undefined, '', '   ']) {
        const r = resolveDramaRoot(v);
        assert.equal(r.root, null, `${String(v)} 应当被拒绝`);
        assert.match(r.reason, /笔记库/, '原因里要提到笔记库,否则用户不知道该去配什么');
    }
});

test('笔记库不是绝对路径:拒绝(相对路径会随进程 cwd 飘)', () => {
    const r = resolveDramaRoot('relative/vault');
    assert.equal(r.root, null);
    assert.match(r.reason, /绝对路径/);
});

test('笔记库路径两端的空白会被修掉(用户粘路径时常带空格)', () => {
    const vault = path.resolve('D:/v');
    assert.equal(resolveDramaRoot(`  ${vault}  `).root, path.join(vault, DRAMA_DIR_NAME));
});

test('非字符串一律当没配(而不是抛)', () => {
    for (const v of [42, {}, [], true]) {
        assert.equal(resolveDramaRoot(v).root, null);
    }
});

// ---- 项目名 → 目录名 ----

test('项目名保留中文与字母数字,其余换成下划线', () => {
    // 引擎自己那份 slug 也这么干,两边口径必须一致,否则"面板里叫 A、盘上叫 B"
    assert.equal(slugProjectName('我在县城卖早点·第3集'), '我在县城卖早点_第3集');
    assert.equal(slugProjectName('abc-123'), 'abc-123');
    assert.equal(slugProjectName('a b/c'), 'a_b_c');
});

test('项目名**递不进路径**:斜杠、反斜杠、点点都被吃掉', () => {
    // 这是安全边界:渲染进程只能递一个名字,由这一侧洗成目录名。
    assert.equal(slugProjectName('../evil').includes('..'), false);
    assert.equal(slugProjectName('../evil').includes('/'), false);
    assert.equal(slugProjectName('..\\..\\windows').includes('\\'), false);
    assert.equal(slugProjectName('C:\\windows').includes(':'), false);
});

test('目录名不以点开头(否则会在笔记树的"跳过隐藏项"规则里消失)', () => {
    assert.equal(slugProjectName('.hidden').startsWith('.'), false);
    assert.equal(slugProjectName('...x').startsWith('.'), false);
});

test('空名 / 全是非法字符:退回 default(而不是空目录名)', () => {
    assert.equal(slugProjectName('   '), 'default');
    assert.equal(slugProjectName(''), 'default');
    assert.equal(slugProjectName('///'), 'default');
    assert.equal(slugProjectName(null), 'default');
});

test('超长名字被截到 60 字符(目录名有上限,且要留余量)', () => {
    const long = 'a'.repeat(300);
    assert.equal(slugProjectName(long).length, 60);
});
