import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    extractAllMediaBlocks,
    extractMediaBlock, parseCssRules, transformAngleDeg, transformIsIdentity, formatAngle,
} from '../app/lib/motion-assert.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_CSS = path.join(HERE, '..', 'app', 'styles', 'base.css');

/**
 * 自检里那条 `prefers-reduced-motion` 断言用的判据,原样搬到这里。
 * 它必须是**两条独立规则**:只关 transition 不够(旋转会瞬间完成、位移依然发生)。
 */
function reducedMotionOk(css) {
    const block = extractMediaBlock(css, 'prefers-reduced-motion');
    if (block === null) return false;
    const rules = parseCssRules(block);
    const plusOwn = rules.find(u => u.selector === '.icon-plus');
    const plusOnHover = rules.find(u => u.selector === '.icon-btn:hover:not(:disabled) .icon-plus'
        || u.selector === '.icon-btn:active:not(:disabled) .icon-plus'
        || /\.icon-btn:hover[^{]*\.icon-plus/.test(u.selector));
    return plusOwn !== undefined && /\btransition:\s*none\b/.test(plusOwn.body)
        && plusOnHover !== undefined && /\btransform:\s*none\b/.test(plusOnHover.body);
}

test('reduced-motion 断言在真实 base.css 上成立', () => {
    assert.equal(reducedMotionOk(fs.readFileSync(BASE_CSS, 'utf8')), true);
});

test('reduced-motion 断言**有牙**:删掉块里 .icon-plus 的 transition: none 就必须变红', () => {
    // 这条替身是评审抓到的那次教训的固化:旧正则
    // `/prefers-reduced-motion[\s\S]{0,400}\.icon-plus[^}]*transform:\s*none/`
    // 里的 `[^}]*` 会从第一个 .icon-plus 跨过逗号吃到第三个选择器,
    // 于是删掉 `.icon-plus { transition: none; }` 那一行它**照样通过**。
    const real = fs.readFileSync(BASE_CSS, 'utf8');
    const toothless = '@media (prefers-reduced-motion: reduce) {\n'
        + '    .icon-btn:hover:not(:disabled) .icon-plus,\n'
        + '    .icon-btn:active:not(:disabled) .icon-plus { transform: none; }\n'
        + '}\n';
    assert.equal(reducedMotionOk(toothless), false,
        '只关 transform、没关 transition 时必须判红 —— 否则这条断言等于没有');
    assert.equal(
        /prefers-reduced-motion[\s\S]{0,400}\.icon-plus[^}]*transform:\s*none/.test(toothless),
        true,
        '旧正则对这种输入**仍然通过** —— 这正是它没牙的证据(留着当反例)');

    // 只删那一行,别的原样:这才是"真实文件被改坏了"的形态。
    // ⚠️ 必须容忍 CRLF:仓库里这份 base.css 检出到工作区是 CRLF 的(git autocrlf),
    // 只按 '\n' 去替换会**什么都不替换**,下面那条断言就变成空转 —— 这正是本用例
    // 自己在防的那类错法(替身改不动,却以为测过了)。
    const removed = real.replace(/ {4}\.icon-plus \{ transition: none; \}\r?\n/, '');
    assert.notEqual(removed, real, '替换必须真的发生了(否则下面那条断言是空转)');
    assert.equal(reducedMotionOk(removed), false, '少了 transition: none 就必须变红');
    assert.equal(
        /prefers-reduced-motion[\s\S]{0,400}\.icon-plus[^}]*transform:\s*none/.test(removed),
        true,
        '而旧正则对被改坏的**真实文件**照样通过 —— 评审那次"删了还绿"的原样复现');
});

test('extractMediaBlock 按大括号配对切片,不跨过块边界', () => {
    const css = 'a{color:red}\n@media (prefers-reduced-motion: reduce) {\n  .x { transform: none; }\n}\n.y{color:blue}\n';
    const block = extractMediaBlock(css, 'prefers-reduced-motion');
    assert.ok(block.includes('.x { transform: none; }'));
    assert.equal(block.includes('.y'), false, '块外的东西不许被吃进来');
    assert.equal(extractMediaBlock(css, 'print'), null, '没有这个媒体查询时返回 null');
    assert.equal(extractMediaBlock('@media (x) { a { b: c }', 'x'), null,
        '大括号不配对时返回 null,不许猜');
});

test('parseCssRules 拆出选择器与声明体', () => {
    const rules = parseCssRules('.a { color: red; }\n.b, .c { transform: none; }');
    assert.deepEqual(rules.map(u => u.selector), ['.a', '.b, .c']);
    assert.equal(rules[1].body.trim(), 'transform: none;');
    assert.deepEqual(parseCssRules(null), []);
});

test('transformAngleDeg:过渡中途的值不许被当成"已经转到 90°"', () => {
    // 评审实测到的那个中间值(约 68°):它既不是 none,也远没到 90°
    assert.ok(Math.abs(transformAngleDeg('matrix(0.363334, 0.931659, -0.931659, 0.363334, 0, 0)') - 68.7) < 0.5);
    // 终态
    assert.equal(Math.round(transformAngleDeg('matrix(0, 1, -1, 0, 0, 0)')), 90);
    assert.equal(Math.round(transformAngleDeg('matrix(-1, 0, 0, -1, 0, 0)')), 180);
    // 没在转
    assert.equal(transformAngleDeg('none'), null);
    assert.equal(transformAngleDeg('matrix(1, 0, 0, 1, 0, 0)'), 0, '单位矩阵是 0°,不是"无旋转"');
    // 带缩放/斜切的矩阵不是纯旋转:宁可返回 null(断言会判它不合规),也不要一个好看的假角度
    assert.equal(transformAngleDeg('matrix(0.86, 0, 0, 1, 0, 0)'), null, '各向异性缩放:角度没有意义');
    assert.equal(transformAngleDeg('matrix(1, 0, 0.5, 1, 0, 0)'), null, '斜切:两列不正交');
    assert.equal(transformAngleDeg('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)'), null);
    // 但**各向同性**缩放配旋转,角度仍然有意义(按下态正是 rotate(90deg) scale(.86))
    assert.equal(Math.round(transformAngleDeg('matrix(0, 0.86, -0.86, 0, 0, 0)')), 90);
});

test('formatAngle 把 null 与角度都说成人话(失败时要看得出差多少度)', () => {
    assert.equal(formatAngle(null), '无旋转');
    assert.equal(formatAngle(90), '90.0°');
});

// ---------- N6 的两处边界 ----------
//
// 两处都只会**误报失败**,不会空转通过(方向是安全的),但误报会把一条本来
// 有效的断言变成噪音,最后没人再看它 —— 所以顺手收掉。两条都要证明
// "该红的仍然红":放松了平移这一种形态,旋转/缩放必须照样被拒。

test('transformIsIdentity:纯平移也算"没有变换",但旋转/缩放不算(N6-1)', () => {
    // 悬停态加位移的那天,`translate` 的终态是 matrix(1,0,0,1,tx,ty):
    // 它没有旋转、没有缩放/斜切,就是"移开了"这个终态本身。旧判据只认字面
    // identity,会把它判成"还在变换",于是"移开后回到原状"那条误报失败。
    for (const v of [
        'matrix(1, 0, 0, 1, 10, 20)',
        'matrix(1,0,0,1,0,0)',
        'matrix(1, 0, 0, 1, -3, 0)',
        'matrix(1, 0, 0, 1, 0.5, -0.5)',
    ]) {
        assert.equal(transformIsIdentity(v), true, `${v} 是纯平移,必须判为"没有变换"`);
    }
    // 该红的仍然红:有旋转或有缩放就不是终态
    assert.equal(transformIsIdentity('matrix(0, 1, -1, 0, 0, 0)'), false, '90° 旋转不算无变换');
    assert.equal(transformIsIdentity('matrix(0, 0.86, -0.86, 0, 0, 0)'), false, '带缩放的旋转不算');
    assert.equal(transformIsIdentity('matrix(0.86, 0, 0, 1, 0, 0)'), false, '各向异性缩放不算');
    assert.equal(transformIsIdentity('matrix(1, 0, 0.5, 1, 0, 0)'), false, '斜切不算');
    // 非矩阵形态与坏输入照旧:不猜
    assert.equal(transformIsIdentity('none'), true);
    assert.equal(transformIsIdentity(''), true);
    assert.equal(transformIsIdentity('rotate(90deg)'), false, '认不出的形态宁可判"还在变换"');
    assert.equal(transformIsIdentity('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)'), false);
    assert.equal(transformIsIdentity('matrix(1, 0, 0, 1, NaN, 0)'), false, 'NaN 不许被当成 0');
});

test('transformAngleDeg:纯平移没有旋转,角度必须是"无旋转"(N6-1)', () => {
    // 平移矩阵的旋转分量是 0°,但在"转了多少度"这个问题上它没有旋转可言。
    // 注意单位矩阵(位移恰为 0)保留既有契约 0° —— 见上面那条既有用例。
    assert.equal(transformAngleDeg('matrix(1, 0, 0, 1, 10, 20)'), null);
});

test('extractMediaBlock 跳过 CSS 注释里的 @media(N6-2)', () => {
    const commented = '/* @media (prefers-reduced-motion) { */\n.a { transform: none; }\n/* } */\n.b {}\n';
    // 旧行为:把注释里那一行当真的媒体查询,交回 ` */ .a{transform:none} /* ` 这段垃圾。
    assert.equal(extractMediaBlock(commented, 'prefers-reduced-motion'), null,
        '注释掉的媒体查询不是媒体查询 —— 返回 null 才诚实(返回垃圾会让断言判红并指向错误的地方)');

    const withReal = commented
        + '@media (prefers-reduced-motion: reduce) {\n    .icon-plus { transition: none; }\n}\n';
    const block = extractMediaBlock(withReal, 'prefers-reduced-motion');
    assert.ok(block !== null && block.includes('.icon-plus'), '注释之后那条**真的**媒体查询必须照旧被找到');
    assert.equal(block.includes('*'), false, '切片不许把注释符号吃进来');
    assert.equal(block.includes('.b'), false, '块外的东西不许被吃进来');

    // 反向:该红的仍然红 —— 真的媒体查询里少了那行,判据照样变红
    const toothless = '@media (prefers-reduced-motion: reduce) {\n    .icon-btn:hover .icon-plus { transform: none; }\n}\n';
    assert.equal(reducedMotionOk(toothless), false, '真块里少了 transition: none 仍旧必须判红');
});

// 一个样式表里可以有**多个** @media(prefers-reduced-motion) 块 —— 各自贴着自己管的
// 那段规则。extractMediaBlock 只取第一个,于是"后面那个块里的规则"永远读不到,
// 断言会以一句"规则没写"假红(实测:分隔条的块排在前面,流式动效的免责规则就漏了)。

test('extractAllMediaBlocks:多个同名媒体块都要取到,顺序按出现先后', () => {
    const css = [
        '@media (prefers-reduced-motion: reduce) {',
        '  .a { transition: none; }',
        '}',
        '.x { color: red; }',
        '@media (prefers-reduced-motion: reduce) {',
        '  .b { animation: none; }',
        '}',
    ].join('\n');
    const blocks = extractAllMediaBlocks(css, 'prefers-reduced-motion');
    assert.equal(blocks.length, 2, '两个块都要拿到');
    assert.match(blocks[0], /\.a\b/);
    assert.match(blocks[1], /\.b\b/, '第二个块里的规则不许漏');
    // 单个块的接口保持原契约(只取第一个)
    assert.equal(extractMediaBlock(css, 'prefers-reduced-motion').includes('.a'), true);
});

test('extractAllMediaBlocks:没有该媒体查询时返回空数组,不会死循环', () => {
    assert.deepEqual(extractAllMediaBlocks('.a { color: red }', 'prefers-reduced-motion'), []);
    assert.deepEqual(extractAllMediaBlocks('', 'prefers-reduced-motion'), []);
});