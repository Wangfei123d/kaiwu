import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountLiveMarkdown, serializeMarkdownDom } from '../app/lib/live-markdown.js';
import { renderMarkdownNodes } from '../app/lib/markdown.js';

function text(value) { return { nodeType: 3, nodeValue: value }; }
function element(tag, children = [], attrs = {}) {
    return { nodeType: 1, tagName: tag.toUpperCase(), childNodes: children, textContent: children.map(child => child.nodeValue ?? child.textContent ?? '').join(''), getAttribute: name => attrs[name] ?? null };
}

class FakeElement {
    constructor(tag, ownerDocument) {
        this.nodeType = 1; this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument;
        this.childNodes = []; this.listeners = {}; this.attributes = {}; this.className = '';
        this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); } };
    }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get textContent() { return this.childNodes.map(node => node.nodeType === 3 ? node.nodeValue : node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(this.ownerDocument.createTextNode(value)); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }
    replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    dispatch(type, event = {}) { for (const listener of this.listeners[type] ?? []) listener({ target: this, ...event }); }
    querySelectorAll() { return []; }
    focus() {}
}

function editorRoot() {
    const doc = {
        createElement(tag) { return new FakeElement(tag, doc); },
        createTextNode(nodeValue) { return { nodeType: 3, nodeValue: String(nodeValue), ownerDocument: doc, parentNode: null }; },
        getSelection() { return this.selection ?? null; },
        createRange() {
            return {
                setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
                collapse() { this.collapsed = true; },
            };
        },
    };
    return doc.createElement('div');
}

test('serializes rich inline edits back to Markdown without losing block structure', () => {
    const root = element('div', [
        element('h2', [text('Scene')]),
        element('p', [text('Meet '), element('strong', [text('Mina')]), text(' and '), element('em', [text('Kai')]), text('.')]),
        element('ul', [element('li', [text('first')]), element('li', [text('second')])]),
        element('blockquote', [element('p', [text('remember')])]),
        element('pre', [element('code', [text('const x = 1;')])]),
    ]);
    assert.equal(serializeMarkdownDom(root), '## Scene\n\nMeet **Mina** and *Kai*.\n\n- first\n- second\n\n> remember\n\n```\nconst x = 1;\n```');
});

test('serializes links and escapes unsafe link destinations as plain text', () => {
    const root = element('div', [
        element('p', [element('a', [text('safe')], { href: 'https://example.com' }), text(' '), element('a', [text('bad')], { href: 'javascript:alert(1)' })]),
    ]);
    assert.equal(serializeMarkdownDom(root), '[safe](https://example.com) bad');
});

test('editable rendering preserves empty lines when reopening Markdown', () => {
    for (const source of ['', '\n\n', '正文\n', '正文\n\n\n', '# 标题\n\n正文\n\n']) {
        const root = editorRoot(), editor = mountLiveMarkdown(root, source);
        assert.equal(editor.value(), source, '重新打开不应丢失空行: ' + JSON.stringify(source));
    }
});

test('enables and disables a toolbar-free inline Markdown surface', () => {
    const root = editorRoot(), editor = mountLiveMarkdown(root, '正文', { showToolbar: false }), content = root.childNodes[0];
    assert.doesNotThrow(() => editor.setDisabled(true));
    assert.equal(content.contentEditable, 'false');
    assert.equal(content.getAttribute('aria-disabled'), 'true');
    assert.doesNotThrow(() => editor.setDisabled(false));
    assert.equal(content.contentEditable, 'true');
    assert.equal(content.getAttribute('aria-disabled'), 'false');
});

test('a visual caret placeholder never becomes an extra stored newline', () => {
    const root = element('div', [element('p', [text('正文'), element('br'), element('br', [], { 'data-live-markdown-placeholder': 'true' })])]);
    assert.equal(serializeMarkdownDom(root, { preserveBlankLines: true }), '正文\n');
});

test('keeps blocked remote image Markdown when an editor uses a safe placeholder span', () => {
    const root = element('div', [element('p', [element('span', [text('[图片：cover.png · 未自动加载]')], {
        'data-markdown-image-url': 'https://example.com/cover.png',
        'data-markdown-image-alt': 'cover.png',
    })])]);
    assert.equal(serializeMarkdownDom(root), '![cover.png](https://example.com/cover.png)');
});

test('rerenders Markdown typed into the inline editor while preserving its Markdown value', () => {
    const root = editorRoot();
    const editor = mountLiveMarkdown(root, '');
    const content = root.childNodes[1];

    content.replaceChildren(content.ownerDocument.createTextNode('### 你好'));
    const sourceText = content.childNodes[0];
    content.ownerDocument.selection = {
        isCollapsed: true, anchorNode: sourceText, anchorOffset: sourceText.nodeValue.length,
        removeAllRanges() { this.anchorNode = null; },
        addRange(range) { this.anchorNode = range.startContainer; this.anchorOffset = range.startOffset; },
    };
    content.dispatch('input');

    assert.equal(content.children[0]?.tagName, 'H3', '标题标记应立即变为渲染后的标题元素');
    assert.equal(content.textContent, '你好', '标题标记不应继续显示在编辑界面');
    assert.equal(editor.value(), '### 你好', '底层 Markdown 内容仍应完整保留');
    assert.equal(content.ownerDocument.selection.anchorNode.nodeValue, '你好', '光标应落在重新渲染后的正文中');
    assert.equal(content.ownerDocument.selection.anchorOffset, 2, '输入在末尾时光标应留在标题末尾');
});

test('keeps the caret when Enter places it on the browser line-break placeholder', () => {
    const root = editorRoot();
    mountLiveMarkdown(root, '是粉色');
    const content = root.childNodes[1], doc = content.ownerDocument;
    const emptyLine = doc.createElement('p'), placeholder = doc.createElement('br');
    emptyLine.appendChild(placeholder); content.appendChild(emptyLine);
    doc.selection = {
        isCollapsed: true, anchorNode: placeholder, anchorOffset: 0,
        removeAllRanges() { this.anchorNode = null; },
        addRange(range) { this.anchorNode = range.startContainer; this.anchorOffset = range.startOffset; },
    };

    content.dispatch('input');

    assert.notEqual(doc.selection.anchorNode, placeholder, '重渲染后光标不能留在已脱离画布的旧 <br>');
    let current = doc.selection.anchorNode;
    while (current && current !== content) current = current.parentNode;
    assert.equal(current, content, '光标应留在节点内的新空行');
});

test('Enter inserts and renders a Markdown line break inside the live editor', () => {
    const root = editorRoot();
    const editor = mountLiveMarkdown(root, '是粉色');
    const content = root.childNodes[1], doc = content.ownerDocument;
    const paragraph = content.childNodes[0], currentText = paragraph.childNodes[0];
    let range;
    doc.selection = {
        isCollapsed: true, rangeCount: 1, anchorNode: currentText, anchorOffset: currentText.nodeValue.length,
        getRangeAt() { return range; },
        removeAllRanges() { this.anchorNode = null; },
        addRange(next) { this.anchorNode = next.startContainer; this.anchorOffset = next.startOffset; },
    };
    range = {
        startContainer: currentText, startOffset: currentText.nodeValue.length,
        deleteContents() {},
        insertNode(node) { paragraph.appendChild(node); },
        setStartAfter(node) { this.startContainer = node.parentNode; this.startOffset = node.parentNode.childNodes.indexOf(node) + 1; },
        collapse() { this.collapsed = true; },
    };
    let prevented = false;

    content.dispatch('keydown', { key: 'Enter', preventDefault() { prevented = true; } });

    assert.equal(prevented, true, '默认 Enter 生成的空块会被 Markdown 解析器丢弃，必须改为插入硬换行');
    assert.equal(editor.value(), '是粉色\n', '回车应作为同一段中的 Markdown 换行保存');
    assert.equal(content.children[0]?.tagName, 'P');
    assert.ok(content.children[0]?.children?.some(child => child.tagName === 'BR'), '实时渲染后应仍看得到下一行');
    let caret = doc.selection.anchorNode;
    while (caret && caret !== content) caret = caret.parentNode;
    assert.equal(caret, content, '渲染后光标应留在编辑区');
});
