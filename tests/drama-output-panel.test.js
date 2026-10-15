import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownNodes } from '../app/lib/markdown.js';
import { createDramaOutputPanel } from '../plugins/drama/output-panel.js';

class FakeNode {
    constructor(tagName, text = '') {
        this.tagName = tagName.toUpperCase();
        this._text = text;
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.hidden = false;
        this.className = '';
        this.type = '';
    }

    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    click() { this.listeners.get('click')?.(); }
}

const doc = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (value) => new FakeNode('#text', String(value)),
};

function find(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const match = find(child, predicate);
        if (match) return match;
    }
    return null;
}

const byClass = (root, name) => find(root, (node) => node.className.split(/\s+/).includes(name));
const byTag = (root, tag) => find(root, (node) => node.tagName === tag.toUpperCase());

test('文本输出默认显示 Markdown 预览，切换源码后保留完整原文', () => {
    const raw = '# 分镜脚本\n\n**人物**：林夏';
    const modes = [];
    const panel = createDramaOutputPanel({
        doc, text: raw, renderMarkdownNodes, onModeChange: (mode) => modes.push(mode),
    });
    const preview = byClass(panel.element, 'drama-output-markdown');
    const source = byClass(panel.element, 'drama-output-source');
    const sourceButton = byClass(panel.element, 'drama-output-source-tab');
    assert.equal(byTag(preview, 'h1')?.textContent, '分镜脚本');
    assert.equal(byTag(preview, 'strong')?.textContent, '人物');
    assert.equal(source.textContent, raw);
    assert.equal(source.hidden, true);

    sourceButton.click();
    assert.equal(preview.hidden, true);
    assert.equal(source.hidden, false);
    assert.equal(sourceButton.getAttribute('aria-selected'), 'true');
    assert.deepEqual(modes, ['source']);
});

test('更新全文同时更新预览和源码，模型输出不能成为脚本节点', () => {
    const panel = createDramaOutputPanel({ doc, text: '旧稿', renderMarkdownNodes });
    panel.setText('# 新稿\n\n<script>alert(1)</script>');
    const preview = byClass(panel.element, 'drama-output-markdown');
    const source = byClass(panel.element, 'drama-output-source');
    assert.equal(byTag(preview, 'h1')?.textContent, '新稿');
    assert.equal(byTag(preview, 'script'), null);
    assert.match(preview.textContent, /<script>alert\(1\)<\/script>/);
    assert.match(source.textContent, /<script>alert\(1\)<\/script>/);
});

test('文本生成结果中的 Markdown 表格保留行列', () => {
    const raw = '| 场次 | 内容 |\n| --- | --- |\n| 1 | 开场 |';
    const panel = createDramaOutputPanel({ doc, text: raw, renderMarkdownNodes });
    const preview = byClass(panel.element, 'drama-output-markdown');
    assert.equal(byTag(preview, 'table')?.tagName, 'TABLE');
    assert.equal(byTag(preview, 'td')?.textContent, '1');
    assert.equal(byClass(panel.element, 'drama-output-source').textContent, raw);
});
