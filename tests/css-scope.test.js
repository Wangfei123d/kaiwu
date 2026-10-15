import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeCss } from '../app/lib/css-scope.js';

// 作用域化的核心要求:插件私有样式不能串味,但也不能在过程中被改坏。
// 早期实现用正则扫 `[^{}]+\{`,把 @media 的前导也加了前缀,得到非法选择器,
// 整块被 CSS 解析器静默丢弃 —— 插件的响应式规则会凭空消失。这组用例守住它。

const S = (css, id = 'demo') => scopeCss(css, id);

test('普通选择器加上插件前缀', () => {
    assert.equal(S('.swatch { color: red }'),
        '[data-plugin="demo"] .swatch { color: red }');
});

test('选择器列表每一项都加前缀', () => {
    assert.equal(S('.a, .b { color: red }'),
        '[data-plugin="demo"] .a, [data-plugin="demo"] .b { color: red }');
});

test(':root / html / body 不加前缀', () => {
    assert.equal(S(':root { --x: 1 }'), ':root { --x: 1 }');
    assert.equal(S('html { color: red }'), 'html { color: red }');
    assert.equal(S('body { margin: 0 }'), 'body { margin: 0 }');
});

test('@media 的前导保持原样,块内选择器才加前缀', () => {
    const out = S('@media (max-width: 700px) { .a { color: red } }');
    assert.ok(!out.includes('[data-plugin="demo"] @media'),
        '不能给 @media 加前缀 —— 那会变成非法选择器,整块被丢弃');
    assert.ok(out.startsWith('@media (max-width: 700px) {'), out);
    assert.ok(out.includes('[data-plugin="demo"] .a { color: red }'), out);
});

test('@media 里的多条规则都被作用域化', () => {
    const out = S('@media screen { .a { x: 1 } .b { y: 2 } }');
    assert.ok(out.includes('[data-plugin="demo"] .a'), out);
    assert.ok(out.includes('[data-plugin="demo"] .b'), out);
});

test('嵌套 @media 也能逐层处理', () => {
    const out = S('@media a { @media b { .x { c: 1 } } }');
    assert.ok(out.includes('[data-plugin="demo"] .x'), out);
    assert.equal((out.match(/@media/g) || []).length, 2, out);
});

test('@keyframes 整块保留,内部百分比关键帧不加前缀', () => {
    const out = S('@keyframes spin { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }');
    assert.ok(out.includes('@keyframes spin'), out);
    assert.ok(!out.includes('[data-plugin="demo"] from'), out);
    assert.ok(!out.includes('[data-plugin="demo"] 50%'), out);
    assert.ok(!out.includes('[data-plugin="demo"] to'), out);
});

// ---- 2026-10-05 真机 bug:紧跟在注释后面的 @rule 被当成选择器 ----
//
// 症状(用户报的"下载中那条绿色条纹不流动"):computed animation-name 有值、
// animation-play-state 还是 running,但 **transform 恒为 none** —— 因为
// `[data-plugin=x] /* 注释 */ @keyframes …` 不是合法 CSS,整条关键帧被解析器丢掉。
test('★ 回归:注释紧跟 @keyframes 时,关键帧必须原样保留(不许被加上插件前缀)', () => {
    const out = S('/* 说明文字 */\n@keyframes drift { from { transform: translateX(-88px) } to { transform: translateX(0) } }');
    assert.ok(out.includes('@keyframes drift'), out);
    assert.ok(!out.includes('[data-plugin="demo"] /*'), '注释后面的 @keyframes 被当成了选择器');
    assert.ok(!/\[data-plugin="demo"\][^@]*@keyframes/.test(out), out);
    // 注释本身要留住(它是给下一个人看的)
    assert.ok(out.includes('/* 说明文字 */'), out);
});

test('★ 回归:注释紧跟 @media 时,整块也要保留(原来会连块一起被丢掉)', () => {
    const out = S('/* 动效一键关 */\n@media (prefers-reduced-motion: reduce) { .a { animation: none } }');
    assert.ok(out.startsWith('/* 动效一键关 */\n@media'), out);
    assert.ok(!/\[data-plugin="demo"\][^@]*@media/.test(out), out);
    assert.ok(out.includes('[data-plugin="demo"] .a { animation: none }'), out);
});

test('★ 回归:注释紧跟 @supports / @font-face 同样按 at-rule 处理', () => {
    const supports = S('/* c */ @supports (display: grid) { .a { display: grid } }');
    assert.ok(!/\[data-plugin="demo"\][^@]*@supports/.test(supports), supports);
    assert.ok(supports.includes('[data-plugin="demo"] .a'), supports);
    const face = S('/* c */ @font-face { font-family: X }');
    assert.equal(face, '/* c */ @font-face { font-family: X }');
});

test('★ 回归:只有注释、没有选择器的"前导"原样保留(别加前缀也别丢)', () => {
    const out = S('.a { color: red }\n/* 段落注释 */\n.b { color: blue }');
    assert.ok(out.includes('[data-plugin="demo"] .a'), out);
    assert.ok(out.includes('/* 段落注释 */'), out);
    // 注释被摘到前缀**前面**,选择器本身干干净净地加上前缀
    assert.ok(out.includes('/* 段落注释 */ [data-plugin="demo"] .b { color: blue }'), out);
    // 块内的注释与花括号仍然不影响配对
    const nested = S('.a { /* { 别乱配对 */ color: red }');
    assert.ok(nested.includes('[data-plugin="demo"] .a'), nested);
    assert.ok(nested.includes('/* { 别乱配对 */'), nested);
});

test('★ 回归:中间那段注释里带逗号,也不许把选择器列表切坏', () => {
    // 这条是"注释整体跳过"那个设计承诺的真正考验:文件开头的注释被单独跳过了,
    // 但**夹在两条规则之间**的注释原来会被并进下一个选择器,里面的逗号就把列表切开。
    const out = S('.a { x: 1 }\n/* 主色, 点缀色 */\n.b, .c { color: red }');
    assert.ok(out.includes('[data-plugin="demo"] .b, [data-plugin="demo"] .c { color: red }'), out);
    assert.equal((out.match(/\[data-plugin="demo"\]/g) || []).length, 3, out);
});

test('@font-face / @import 不被加前缀', () => {
    assert.equal(S('@font-face { font-family: X }'), '@font-face { font-family: X }');
});

test('注释里的半角逗号不会把选择器列表切坏', () => {
    // 早期实现里 `/* a, b */ .a{}` 会把注释尾巴和选择器拼成一块再按逗号切开
    const out = S('/* 主色, 点缀色 */\n.a { color: red }');
    assert.ok(out.includes('/* 主色, 点缀色 */'), out);
    assert.ok(out.includes('[data-plugin="demo"] .a { color: red }'), out);
});

test('注释原样保留,注释里的花括号不影响配对', () => {
    const out = S('/* 这里有个 { 花括号 */ .a { color: red }');
    assert.ok(out.includes('/* 这里有个 { 花括号 */'), out);
    assert.ok(out.includes('[data-plugin="demo"] .a { color: red }'), out);
});

test('字符串里的花括号不影响块配对', () => {
    const out = S('.a { content: "}" } .b { color: red }');
    assert.ok(out.includes('[data-plugin="demo"] .a'), out);
    assert.ok(out.includes('[data-plugin="demo"] .b'), out);
});

test('多条规则依次处理,顺序不变', () => {
    const out = S('.a { x: 1 }\n.b { y: 2 }');
    assert.ok(out.indexOf('.a') < out.indexOf('.b'), out);
    assert.equal((out.match(/\[data-plugin="demo"\]/g) || []).length, 2, out);
});

test('已经是空规则/空输入时安全返回', () => {
    assert.equal(S(''), '');
    assert.equal(S('   '), '   ');
    assert.equal(S('.a {}'), '[data-plugin="demo"] .a {}');
});

test('非字符串输入返回空串而不是抛异常', () => {
    assert.equal(scopeCss(null, 'x'), '');
    assert.equal(scopeCss(undefined, 'x'), '');
    assert.equal(scopeCss(42, 'x'), '');
});

test('插件 id 出现在前缀里,不同插件互不串味', () => {
    assert.ok(S('.a {}', 'palette').includes('[data-plugin="palette"]'));
    assert.ok(S('.a {}', 'music').includes('[data-plugin="music"]'));
});

test('括号不配对时原样保留,不猜也不抛', () => {
    const broken = '.a { color: red';
    assert.equal(S(broken), broken);
});

test('@media 之后的顶层规则照常加前缀', () => {
    const out = S('@media x { .a { c: 1 } }\n.b { d: 2 }');
    assert.ok(out.includes('[data-plugin="demo"] .b'), out);
});
