import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const baseCss = readFileSync(new URL('../plugins/note-canvas/style.css', import.meta.url), 'utf8');
const themeUrl = new URL('../plugins/note-canvas/theme.css', import.meta.url);
const themeCss = existsSync(themeUrl) ? readFileSync(themeUrl, 'utf8') : '';
const css = `${baseCss}\n${themeCss}`;
const loader = readFileSync(new URL('../plugins/note-canvas/index.js', import.meta.url), 'utf8');
const canvasView = readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');

test('note canvas uses the global near-black theme and keeps existing handle behavior', () => {
    assert.ok(/\.nc-pane\{[^}]*background:var\(--bg\)/.test(css), 'pane background uses the global near-black token');
    assert.ok(/\.nc-canvas\{[^}]*background-color:var\(--bg\)/.test(css), 'canvas background uses the global near-black token');
    assert.ok(/\.nc-node\.selected\{[^}]*outline-color:var\(--accent\)/.test(css), 'selected nodes use the global accent');
    assert.ok(/\.nc-pane \.nc-port:not\(\.nearby\):not\(\.connecting\):not\(:focus-visible\)\{opacity:0/.test(css), 'ports retain proximity visibility');
    assert.ok(/\.nc-pane \.nc-resize\{background:none\}/.test(css), 'resize handle remains visually clean');
    assert.ok(/\.nc-status\.error\{color:#ffaaa7\}/.test(css), 'error status retains its semantic color');
    assert.ok(/theme\.css/.test(loader), 'plugin loader includes the theme stylesheet');
    assert.ok(/scopeCss\(.*themeCss/s.test(loader), 'theme stylesheet is scoped with the plugin CSS');
});

test('note canvas node content hides scrollbar chrome without disabling scroll', () => {
    assert.match(css, /\.nc-node-body\s*\{\s*scrollbar-width:\s*none\s*;?\s*\}/,
        '普通节点正文在 Firefox 中隐藏滚动条');
    assert.match(css, /\.nc-node-body\.live-markdown \.live-markdown-content\s*\{\s*scrollbar-width:\s*none\s*;?\s*\}/,
        'Markdown 正文在 Firefox 中隐藏滚动条');
    assert.match(css, /\.nc-node-body::-webkit-scrollbar\s*,\s*\.nc-node-body\.live-markdown \.live-markdown-content::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
        'Chromium/WebKit 中隐藏两种节点正文滚动条');
    assert.match(baseCss, /\.nc-node-body\{[^}]*overflow:auto/s,
        '普通节点正文仍保持可滚动');
    assert.match(baseCss, /\.nc-node-body\.live-markdown \.live-markdown-content\{[^}]*overflow:auto/s,
        'Markdown 正文仍保持可滚动');
    assert.match(canvasView, /body\.addEventListener\('wheel',event=>\{[\s\S]*?\},\{passive:false\}\)/,
        '节点正文保留滚轮监听以处理选中节点的平滑滚动');
    assert.match(canvasView, /listen\(canvas,'wheel',event=>\{event\.preventDefault\(\);wheelNavigation\(event\);/,
        '画布可接收并处理冒泡的节点滚轮事件');
});

test('text nodes route wheel scrolling to the actual live Markdown content area', () => {
    const textNodeBranch = canvasView.match(/if\(node\.type==='text'\)\{([\s\S]*?)\}\s*else if\(node\.type==='file'\)/)?.[1] ?? '';
    assert.match(textNodeBranch, /attachBodyScroll\(body\.querySelector\('\.live-markdown-content'\),node\.id\)/,
        '文本节点的滚轮处理器绑定到真正可滚动的 Markdown 内容区');
});

test('note canvas routes wheel over nodes according to selection', () => {
    assert.match(canvasView, /function attachBodyScroll\(body,nodeId\)/,
        'node scroll handler receives its owning node ID');
    const bodyWheel = canvasView.match(/body\.addEventListener\('wheel',event=>\{([\s\S]*?)\},\{passive:false\}\)/)?.[1] ?? '';
    const selectionGate = bodyWheel.indexOf('if(!visible()||!selected.has(nodeId))return;');
    const cancellation = bodyWheel.indexOf('event.preventDefault()');
    assert.ok(selectionGate >= 0 && (cancellation < 0 || selectionGate < cancellation),
        'unselected node wheel events are not cancelled before they can bubble to the canvas');

    const canvasWheel = canvasView.match(/listen\(canvas,'wheel',event=>\{([\s\S]*?)\},\{passive:false\}\)/)?.[1] ?? '';
    assert.doesNotMatch(canvasWheel, /closest\('\.nc-node-body'\)/,
        'the canvas wheel handler does not discard bubbled events from node bodies');
    assert.match(canvasWheel, /event\.preventDefault\(\);wheelNavigation\(event\)/,
        'bubbled wheel events use the existing canvas navigation behavior');
});
