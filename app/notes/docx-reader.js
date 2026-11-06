const ALLOWED_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's', 'del',
    'sub', 'sup', 'br', 'hr', 'ol', 'ul', 'li', 'table', 'thead', 'tbody',
    'tr', 'td', 'th', 'a', 'img', 'blockquote', 'pre', 'code',
]);
const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template']);
const SAFE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const PAGE_PADDING = 76;

function safeExternalUrl(raw) {
    try {
        const url = new URL(String(raw ?? ''), globalThis.location?.href ?? 'http://localhost/');
        return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function copySafeNode(node, doc) {
    if (node.nodeType === 3) return doc.createTextNode(node.nodeValue ?? '');
    if (node.nodeType !== 1) return null;
    const tag = String(node.tagName ?? '').toLowerCase();
    if (DROP_CONTENT_TAGS.has(tag)) return null;

    const children = () => {
        const fragment = doc.createDocumentFragment();
        for (const child of Array.from(node.childNodes ?? [])) {
            const safe = copySafeNode(child, doc);
            if (safe) fragment.appendChild(safe);
        }
        return fragment;
    };
    if (!ALLOWED_TAGS.has(tag)) return children();

    const clean = doc.createElement(tag);
    if (tag === 'a') {
        const href = safeExternalUrl(node.getAttribute('href'));
        if (href) {
            clean.href = href;
            clean.rel = 'noopener noreferrer';
        }
    } else if (tag === 'img') {
        const src = String(node.getAttribute('src') ?? '');
        if (!SAFE_IMAGE.test(src)) return null;
        clean.src = src.replace(/\s/g, '');
        clean.alt = String(node.getAttribute('alt') ?? '').slice(0, 500);
    } else if (tag === 'td' || tag === 'th') {
        for (const attr of ['colspan', 'rowspan']) {
            const n = Number(node.getAttribute(attr));
            if (Number.isInteger(n) && n >= 1 && n <= 50) clean.setAttribute(attr, String(n));
        }
    } else if (tag === 'ol' || tag === 'li') {
        const start = Number(node.getAttribute(tag === 'ol' ? 'start' : 'value'));
        if (Number.isInteger(start) && start >= 1 && start <= 100000) {
            clean.setAttribute(tag === 'ol' ? 'start' : 'value', String(start));
        }
    }
    if (tag !== 'img' && tag !== 'br' && tag !== 'hr') clean.appendChild(children());
    return clean;
}

function sanitizeHtml(doc, html) {
    const parsed = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const fragment = doc.createDocumentFragment();
    for (const node of Array.from(parsed.body.childNodes)) {
        const safe = copySafeNode(node, doc);
        if (safe) fragment.appendChild(safe);
    }
    return fragment;
}

function button(doc, label, title, action) {
    const el = doc.createElement('button');
    el.type = 'button';
    el.className = 'docx-reader-button';
    el.textContent = label;
    el.title = title;
    el.addEventListener('click', action);
    return el;
}

function plainTextBlock(doc, node) {
    const p = doc.createElement('p');
    p.appendChild(doc.createTextNode(node.nodeValue ?? ''));
    return p;
}

function clearSearchMarks(root) {
    for (const mark of Array.from(root.querySelectorAll('mark.docx-search-hit'))) {
        mark.replaceWith(root.ownerDocument.createTextNode(mark.textContent ?? ''));
    }
    root.normalize();
}

function highlightMatches(doc, root, query) {
    const term = String(query ?? '').trim();
    if (term === '') return [];
    const matches = [];
    const walker = doc.createTreeWalker(root, 4);
    const nodes = [];
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeValue?.trim() && !node.parentElement?.closest('mark.docx-search-hit')) nodes.push(node);
    }
    const folded = term.toLocaleLowerCase();
    for (const node of nodes) {
        const value = node.nodeValue ?? '';
        const haystack = value.toLocaleLowerCase();
        let at = 0;
        let found = haystack.indexOf(folded, at);
        if (found < 0) continue;
        const fragment = doc.createDocumentFragment();
        while (found >= 0) {
            if (found > at) fragment.appendChild(doc.createTextNode(value.slice(at, found)));
            const mark = doc.createElement('mark');
            mark.className = 'docx-search-hit';
            mark.textContent = value.slice(found, found + term.length);
            fragment.appendChild(mark);
            matches.push(mark);
            at = found + term.length;
            found = haystack.indexOf(folded, at);
        }
        if (at < value.length) fragment.appendChild(doc.createTextNode(value.slice(at)));
        node.replaceWith(fragment);
    }
    return matches;
}

/**
 * Mount a locally converted DOCX as a sanitized, read-only reader.
 * @param {{document:Document,root:HTMLElement,html:string,fileName:string,size:number,mtimeMs:number,openExternal?:(url:string)=>void}} options
 * @returns {{destroy:()=>void}}
 */
export function createDocxReader({ document: doc, root, html, fileName, size, mtimeMs, openExternal = null }) {
    const host = doc.createElement('section');
    host.className = 'docx-reader';
    host.setAttribute('aria-label', `${fileName} DOCX 阅读器`);

    const toolbar = doc.createElement('div');
    toolbar.className = 'docx-reader-toolbar';
    const readOnly = doc.createElement('span');
    readOnly.className = 'docx-reader-readonly';
    readOnly.textContent = '只读';
    const search = doc.createElement('input');
    search.type = 'search';
    search.className = 'docx-reader-search';
    search.placeholder = '搜索正文…';
    search.setAttribute('aria-label', '搜索 DOCX 正文');
    const searchCount = doc.createElement('span');
    searchCount.className = 'docx-reader-search-count';
    searchCount.setAttribute('aria-live', 'polite');
    const zoomValue = doc.createElement('span');
    zoomValue.className = 'docx-reader-zoom-value';
    const pageValue = doc.createElement('span');
    pageValue.className = 'docx-reader-page-value';
    const prevPage = button(doc, '上一页', '跳到上一页', () => scrollToPage(activePage - 1));
    const nextPage = button(doc, '下一页', '跳到下一页', () => scrollToPage(activePage + 1));
    const zoomOut = button(doc, '−', '缩小', () => setZoom(zoom - 0.1));
    const zoomIn = button(doc, '+', '放大', () => setZoom(zoom + 0.1));
    const fitPage = button(doc, '适合页面', '按可用宽度缩放', () => {
        const available = Math.max(360, viewport.clientWidth - 36);
        setZoom(available / PAGE_WIDTH);
    });
    const findPrev = button(doc, '上一个', '上一个搜索结果', () => visitMatch(matchIndex - 1));
    const findNext = button(doc, '下一个', '下一个搜索结果', () => visitMatch(matchIndex + 1));
    const fileInfo = doc.createElement('span');
    fileInfo.className = 'docx-reader-file-info';
    const sizeText = size >= 1024 * 1024
        ? `${(size / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(size / 1024))} KB`;
    fileInfo.textContent = `${sizeText} · ${new Date(mtimeMs).toLocaleString()}`;
    fileInfo.title = fileName;

    toolbar.append(readOnly, search, findPrev, findNext, searchCount, zoomOut, zoomValue, zoomIn, fitPage, prevPage, pageValue, nextPage, fileInfo);

    const body = doc.createElement('div');
    body.className = 'docx-reader-body';
    const viewport = doc.createElement('main');
    viewport.className = 'docx-reader-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', 'DOCX 文档正文');
    const pages = doc.createElement('div');
    pages.className = 'docx-reader-pages';
    viewport.appendChild(pages);
    body.appendChild(viewport);
    host.append(toolbar, body);
    root.replaceChildren(host);

    const content = sanitizeHtml(doc, html);
    const blocks = [];
    for (const node of Array.from(content.childNodes)) {
        if (node.nodeType === 3) {
            if (node.nodeValue?.trim()) blocks.push(plainTextBlock(doc, node));
        } else if (node.nodeType === 1) blocks.push(node);
    }
    if (blocks.length === 0) {
        const p = doc.createElement('p');
        p.textContent = '这个 DOCX 文档没有可显示的正文。';
        blocks.push(p);
    }

    let zoom = 1;
    let activePage = 0;
    let matchIndex = -1;
    let matches = [];
    let resizeObserver = null;
    let resizeTimer = null;
    let currentMarkTimer = null;
    let destroyed = false;
    const onWindowResize = () => paginate();

    function setZoom(next) {
        zoom = Math.round(Math.max(0.6, Math.min(1.8, next)) * 10) / 10;
        zoomValue.textContent = `${Math.round(zoom * 100)}%`;
        paginate();
    }

    function createPage(index) {
        const page = doc.createElement('section');
        page.className = 'docx-reader-page';
        page.dataset.page = String(index);
        page.style.width = `${PAGE_WIDTH * zoom}px`;
        page.style.height = `${PAGE_HEIGHT * zoom}px`;
        page.style.padding = `${PAGE_PADDING * zoom}px`;
        const inner = doc.createElement('div');
        inner.className = 'docx-reader-page-content';
        inner.style.fontSize = `${16 * zoom}px`;
        page.appendChild(inner);
        return { page, inner };
    }

    function paginate() {
        if (destroyed) return;
        const previous = activePage;
        pages.replaceChildren();
        let current = createPage(0);
        pages.appendChild(current.page);
        let blockCount = 0;
        for (const block of blocks) {
            current.inner.appendChild(block);
            const overflow = current.inner.scrollHeight > current.inner.clientHeight + 2;
            if (overflow && blockCount > 0) {
                current.inner.removeChild(block);
                current = createPage(Number(current.page.dataset.page) + 1);
                pages.appendChild(current.page);
                current.inner.appendChild(block);
                blockCount = 0;
            }
            blockCount += 1;
        }
        activePage = Math.max(0, Math.min(previous, pages.children.length - 1));
        updatePageReadout();
        if (previous > 0) scrollToPage(activePage, false);
    }

    function updatePageReadout() {
        const total = pages.children.length;
        pageValue.textContent = `${total === 0 ? 0 : activePage + 1} / ${total}`;
        prevPage.disabled = activePage <= 0;
        nextPage.disabled = activePage >= total - 1;
    }

    function scrollToPage(index, smooth = true) {
        const page = pages.children[Math.max(0, Math.min(Number(index) || 0, pages.children.length - 1))];
        if (!page) return;
        activePage = Number(page.dataset.page) || 0;
        page.scrollIntoView?.({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
        updatePageReadout();
    }

    function updateActivePage() {
        const pagesNow = Array.from(pages.children);
        if (pagesNow.length === 0) return;
        const top = viewport.getBoundingClientRect().top + 16;
        let best = 0;
        for (let i = 0; i < pagesNow.length; i++) {
            if (pagesNow[i].getBoundingClientRect().top <= top) best = i;
            else break;
        }
        activePage = best;
        updatePageReadout();
    }

    function visitMatch(index) {
        if (matches.length === 0) return;
        matchIndex = (index % matches.length + matches.length) % matches.length;
        matches[matchIndex].scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        clearTimeout(currentMarkTimer);
        matches.forEach((mark, i) => mark.classList.toggle('is-current', i === matchIndex));
        currentMarkTimer = setTimeout(() => matches[matchIndex]?.classList.remove('is-current'), 1100);
        searchCount.textContent = `${matchIndex + 1} / ${matches.length}`;
        updateActivePage();
    }

    function runSearch() {
        clearTimeout(currentMarkTimer);
        clearSearchMarks(pages);
        matches = highlightMatches(doc, pages, search.value);
        matchIndex = -1;
        searchCount.textContent = matches.length > 0 ? `0 / ${matches.length}` : (search.value.trim() ? '无结果' : '');
        if (matches.length > 0) visitMatch(0);
    }

    function openLink(event) {
        const anchor = event.target?.closest?.('a[href]');
        if (!anchor || !host.contains(anchor)) return;
        event.preventDefault();
        const href = safeExternalUrl(anchor.href);
        if (href && typeof openExternal === 'function') openExternal(href);
    }

    search.addEventListener('input', runSearch);
    viewport.addEventListener('scroll', updateActivePage, { passive: true });
    host.addEventListener('click', openLink);
    setZoom(1);
    if (typeof globalThis.ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => paginate(), 120);
        });
        resizeObserver.observe(viewport);
    } else {
        globalThis.addEventListener?.('resize', onWindowResize);
    }

    return {
        destroy() {
            destroyed = true;
            clearTimeout(resizeTimer);
            clearTimeout(currentMarkTimer);
            resizeObserver?.disconnect?.();
            globalThis.removeEventListener?.('resize', onWindowResize);
            host.removeEventListener('click', openLink);
            viewport.removeEventListener('scroll', updateActivePage);
            root.replaceChildren();
        },
    };
}

export function showDocxReaderError({ document: doc, root, message, fileName, onBack = null }) {
    const box = doc.createElement('section');
    box.className = 'docx-reader-error';
    box.setAttribute('role', 'alert');
    const title = doc.createElement('h2');
    title.textContent = '无法预览此 DOCX';
    const detail = doc.createElement('p');
    detail.textContent = `${fileName}：${String(message ?? '文档解析失败')}`;
    const hint = doc.createElement('p');
    hint.textContent = '原文件未被修改。请确认文档未损坏、未加密，且文件与转换结果均未超过 64 MiB。';
    const back = doc.createElement('button');
    back.type = 'button';
    back.className = 'docx-reader-button';
    back.textContent = '关闭预览并返回';
    back.addEventListener('click', () => onBack?.());
    box.append(title, detail, hint, back);
    root.replaceChildren(box);
}
