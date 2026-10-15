import { renderMarkdownNodes } from './markdown.js';

const safeHref = value => {
    if (typeof value !== 'string' || !value.trim()) return false;
    try { return ['http:', 'https:', 'mailto:'].includes(new URL(value, globalThis.location?.href ?? 'https://local.invalid').protocol); }
    catch { return false; }
};

function escapeMarkdownText(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/([\\`*_{}\[\]<])/g, '\\$1');
}

function caretAt(node, index, caret, marker) {
    return caret?.node === node && caret.offset === index ? marker : '';
}

function inline(node, caret = null, marker = '') {
    if (node.nodeType === 3) {
        const value = String(node.nodeValue ?? '');
        if (caret?.node === node) return `${escapeMarkdownText(value.slice(0, caret.offset))}${marker}${escapeMarkdownText(value.slice(caret.offset))}`;
        return escapeMarkdownText(value);
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const children = [...(node.childNodes ?? [])];
    const body = children.map((child, index) => `${caretAt(node, index, caret, marker)}${inline(child, caret, marker)}`).join('')
        + caretAt(node, children.length, caret, marker);
    if (tag === 'br') return `${caret?.node === node ? marker : ''}${node.getAttribute?.('data-live-markdown-placeholder') === 'true' ? '' : '\n'}`;
    if (tag === 'strong' || tag === 'b') return `**${body}**`;
    if (tag === 'em' || tag === 'i') return `*${body}*`;
    if (tag === 'code') return `\`${plainText(node).replace(/`/g, '\\`')}\``;
    if (tag === 'a') {
        const note = node.getAttribute?.('data-note');
        if (note) return `[[${note}]]`;
        const href = node.getAttribute?.('href');
        return safeHref(href) ? `[${body}](${href})` : body;
    }
    if (tag === 'span') {
        const image = node.getAttribute?.('data-markdown-image-url');
        const alt = node.getAttribute?.('data-markdown-image-alt') ?? '';
        if (typeof image === 'string' && /^https?:\/\//i.test(image) && safeHref(image)) return `![${alt}](${image})`;
    }
    if (tag === 'img') {
        const src = node.getAttribute?.('src');
        const alt = node.getAttribute?.('alt') ?? '';
        return safeHref(src) ? `![${alt}](${src})` : '';
    }
    return body;
}

function plainText(node) {
    if (node.nodeType === 3) return String(node.nodeValue ?? '');
    return [...(node.childNodes ?? [])].map(plainText).join('');
}

function plainTextWithCaret(node, caret, marker) {
    if (node.nodeType === 3) {
        const value = String(node.nodeValue ?? '');
        return caret?.node === node ? `${value.slice(0, caret.offset)}${marker}${value.slice(caret.offset)}` : value;
    }
    const children = [...(node.childNodes ?? [])];
    return children.map((child, index) => `${caretAt(node, index, caret, marker)}${plainTextWithCaret(child, caret, marker)}`).join('')
        + caretAt(node, children.length, caret, marker);
}

function block(node, caret = null, marker = '') {
    if (node.nodeType === 3) return inline(node, caret, marker).trim();
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const children = [...(node.childNodes ?? [])];
    if (tag === 'br') return inline(node, caret, marker);
    if (tag === 'pre') {
        const code = plainTextWithCaret(node, caret, marker);
        return `\`\`\`\n${code.replace(/\n?$/, '\n')}\`\`\``;
    }
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${children.map((child, index) => `${caretAt(node, index, caret, marker)}${inline(child, caret, marker)}`).join('')}${caretAt(node, children.length, caret, marker)}`;
    if (tag === 'p' || tag === 'div') return children.map((child, index) => `${caretAt(node, index, caret, marker)}${inline(child, caret, marker)}`).join('') + caretAt(node, children.length, caret, marker);
    if (tag === 'hr') return '---';
    if (tag === 'blockquote') return children.map((child, index) => `${caretAt(node, index, caret, marker)}${block(child, caret, marker)}`).join('\n')
        .concat(caretAt(node, children.length, caret, marker)).split('\n').map(line => `> ${line}`).join('\n');
    if (tag === 'ul' || tag === 'ol') {
        let index = 0;
        return children.filter(child => child.nodeType === 1 && child.tagName.toLowerCase() === 'li')
            .map(child => `${tag === 'ol' ? `${++index}.` : '-'} ${[...(child.childNodes ?? [])].map((part, partIndex) => `${caretAt(child, partIndex, caret, marker)}${inline(part, caret, marker)}`).join('')}${caretAt(child, child.childNodes?.length ?? 0, caret, marker)}`).join('\n');
    }
    if (tag === 'table') {
        const rows = [...node.querySelectorAll?.('tr') ?? []].map(row => `| ${[...(row.children ?? [])].map(cell => {
            const cells = [...(cell.childNodes ?? [])];
            return cells.map((child, index) => `${caretAt(cell, index, caret, marker)}${inline(child, caret, marker)}`).join('') + caretAt(cell, cells.length, caret, marker);
        }).join(' | ')} |`);
        if (rows.length > 1) rows.splice(1, 0, `| ${[...(node.querySelector?.('tr')?.children ?? [])].map(() => '---').join(' | ')} |`);
        return rows.join('\n');
    }
    return children.map((child, index) => `${caretAt(node, index, caret, marker)}${block(child, caret, marker)}`).join('\n') + caretAt(node, children.length, caret, marker);
}

export function serializeMarkdownDom(root, { caret = null, caretMarker = '', preserveBlankLines = false } = {}) {
    const children = [...(root.childNodes ?? [])];
    const blocks = children.map((child, index) => `${caretAt(root, index, caret, caretMarker)}${preserveBlankLines && child.nodeType === 3 ? inline(child, caret, caretMarker) : block(child, caret, caretMarker)}`);
    return (preserveBlankLines ? blocks : blocks.filter(Boolean)).join(preserveBlankLines ? '\n' : '\n\n')
        + caretAt(root, children.length, caret, caretMarker);
}

function selectionInside(root, selection) {
    const node = selection?.anchorNode;
    if (!node || !selection.isCollapsed) return null;
    for (let current = node; current; current = current.parentNode) if (current === root) return { node, offset: selection.anchorOffset };
    return null;
}

function uniqueCaretMarker(source) {
    let marker = '\uFDD0';
    while (source.includes(marker)) marker += '\uFDD0';
    return marker;
}

function restoreCaret(root, marker) {
    if (!marker) return;
    const doc = root.ownerDocument;
    const selection = doc.getSelection?.();
    if (!selection) return;
    const find = node => {
        if (node.nodeType === 3 && String(node.nodeValue ?? '').includes(marker)) return node;
        for (const child of node.childNodes ?? []) { const match = find(child); if (match) return match; }
        return null;
    };
    const text = find(root);
    if (!text) return;
    const value = String(text.nodeValue ?? ''), offset = value.indexOf(marker);
    text.nodeValue = value.slice(0, offset) + value.slice(offset + marker.length);
    // Chromium does not give an empty trailing text node a caret line box.
    // A final BR supplies that box, but is only a display placeholder, not data.
    const parent = text.parentNode;
    let caretPlaceholder = null;
    if ((text.nodeValue === '' || (parent?.tagName === 'CODE' && text.nodeValue.endsWith('\n') && offset === text.nodeValue.length))
        && parent?.childNodes?.[parent.childNodes.length - 1] === text) {
        const placeholder = doc.createElement('br');
        placeholder.setAttribute('data-live-markdown-placeholder', 'true');
        parent.appendChild(placeholder);
        caretPlaceholder = placeholder;
    }
    const range = doc.createRange?.();
    if (!range) return;
    range.setStart(caretPlaceholder ?? text, caretPlaceholder ? 0 : offset); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
}

/** Mount a single-surface rich Markdown editor. User HTML is never parsed: initial content is built by the safe Markdown renderer. */
export function mountLiveMarkdown(root, markdown, { resolveLink = () => true, onInput = null, wikilinks = false, tags = false, renderDocument = null, showToolbar = true } = {}) {
    const doc = root.ownerDocument ?? globalThis.document;
    root.classList.add('live-markdown');
    const content = doc.createElement('div'); content.className = 'live-markdown-content md-view';
    content.setAttribute('contenteditable', 'true'); content.setAttribute('role', 'textbox'); content.setAttribute('aria-multiline', 'true'); content.setAttribute('aria-label', '可直接编辑的 Markdown 笔记'); content.spellcheck = false;
    let status = null, toolbar = null;
    if (showToolbar) {
        toolbar = doc.createElement('div'); toolbar.className = 'live-markdown-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Markdown 格式');
        status = doc.createElement('span'); status.className = 'live-markdown-status'; status.setAttribute('aria-live', 'polite'); status.textContent = '可直接编辑'; toolbar.append(status);
        const tools = [['H1', 'formatBlock', 'H1'], ['H2', 'formatBlock', 'H2'], ['B', 'bold'], ['I', 'italic']];
        for (const [label, command, value] of tools) {
            const button = doc.createElement('button'); button.type = 'button'; button.className = 'live-markdown-tool'; button.textContent = label; button.setAttribute('aria-label', label === 'B' ? '加粗' : label === 'I' ? '斜体' : `标题 ${label.slice(1)}`);
            button.addEventListener('mousedown', event => event.preventDefault());
            button.addEventListener('click', () => { content.focus(); doc.execCommand?.(command, false, value ?? null); status.textContent = '已实时排版'; input(); });
            toolbar.append(button);
        }
        root.replaceChildren(toolbar, content);
    } else {
        root.replaceChildren(content);
    }
    const renderOptions = { resolveLink, tables: true, wikilinks, tags, preserveBlankLines: true };
    const serialize = options => serializeMarkdownDom(content, { preserveBlankLines: true, ...options });
    content.replaceChildren(...renderMarkdownNodes(renderDocument ?? doc, String(markdown ?? ''), renderOptions));
    let composing = false;
    const input = () => {
        if (status) status.textContent = '已实时排版';
        const source = serialize(), caret = selectionInside(content, doc.getSelection?.());
        const marker = caret ? uniqueCaretMarker(source) : '';
        const markdown = caret ? serialize({ caret, caretMarker: marker }) : source;
        content.replaceChildren(...renderMarkdownNodes(renderDocument ?? doc, markdown, renderOptions));
        restoreCaret(content, marker);
        onInput?.(serialize());
    };
    content.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing || composing || event.keyCode === 229
            || event.ctrlKey || event.metaKey || event.altKey) return;
        const selection = doc.getSelection?.();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        let inside = false, inCode = false;
        for (let node = range.startContainer; node; node = node.parentNode) {
            if (node.nodeName === 'PRE' || node.tagName === 'PRE') inCode = true;
            if (node === content) { inside = true; break; }
        }
        if (!inside) return;
        try {
            // A blank-line caret can be anchored to its visual BR. Insert before
            // that void element, never as its invisible child.
            if (range.startContainer.nodeName === 'BR' || range.startContainer.tagName === 'BR') {
                const wasCollapsed = range.collapsed;
                range.setStartBefore(range.startContainer);
                if (wasCollapsed) range.collapse(true);
            }
            range.deleteContents();
            const lineBreak = inCode ? doc.createTextNode('\n') : doc.createElement('br');
            range.insertNode(lineBreak);
            range.setStartAfter(lineBreak);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        } catch {
            return;
        }
        // Chromium's default Enter creates a new block. A trailing empty block has
        // no Markdown text to render, so it disappears during the live rerender.
        // Insert a real hard break instead and round-trip it through Markdown.
        event.preventDefault();
        input();
    });
    content.addEventListener('compositionstart', () => { composing = true; });
    content.addEventListener('compositionend', () => { composing = false; input(); });
    content.addEventListener('input', event => { if (!composing && !event.isComposing) input(); });
    content.addEventListener('paste', event => {
        const plain = event.clipboardData?.getData('text/plain');
        if (plain == null) return;
        event.preventDefault();
        if (doc.execCommand) doc.execCommand('insertText', false, plain);
        else {
        const selection = doc.getSelection?.();
            if (!selection?.rangeCount) return;
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const text = doc.createTextNode(plain);
            range.insertNode(text);
            range.setStartAfter(text); range.collapse(true);
            selection.removeAllRanges(); selection.addRange(range);
        }
        input();
    });
    return {
        value: () => serialize(),
        focus: () => content.focus(),
        setDisabled: disabled => { content.contentEditable = disabled ? 'false' : 'true'; content.setAttribute('aria-disabled', String(Boolean(disabled))); toolbar?.querySelectorAll('button').forEach(button => { button.disabled = Boolean(disabled); }); },
        dispose: () => { content.removeEventListener('input', input); content.removeAttribute('contenteditable'); },
    };
}
