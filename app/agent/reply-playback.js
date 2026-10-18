import { renderMarkdownNodes } from '../lib/markdown.js';

const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** 接收游标和显示游标分开；未显示的文字只留在内存里。 */
export class ReplyTextBuffer {
    received = '';
    cursor = 0;
    done = false;
    rate = 600;
    incomingRate = 160;
    credit = 0;
    lastAt = null;
    arrivalAt = null;

    get text() { return this.received.slice(0, this.cursor); }
    get pending() { return this.cursor < this.received.length; }
    get active() { return !this.done || this.pending; }

    receive(text, done, now) {
        const next = String(text ?? '');
        const wasEmpty = !this.pending;
        const added = next.length - this.received.length;
        if (!next.startsWith(this.received)) {
            let common = 0;
            while (common < this.cursor && next[common] === this.received[common]) common++;
            if (/[\uD800-\uDBFF]/.test(next[common - 1] ?? '')) common--;
            this.cursor = Math.max(0, common);
        }
        if (added > 0) {
            const elapsed = this.arrivalAt === null ? 0 : now - this.arrivalAt;
            if (elapsed >= 12) {
                const sample = Math.min(3000, added * 1000 / elapsed);
                this.incomingRate = this.incomingRate * .65 + sample * .35;
            }
            this.arrivalAt = now;
        }
        this.received = next;
        this.done = done === true;
        if (wasEmpty || this.lastAt === null) {
            this.lastAt = now;
            this.credit = 0;
        }
    }

    advance(now) {
        const elapsed = Math.max(0, Math.min(40, now - (this.lastAt ?? now)));
        this.lastAt = now;
        if (!this.pending) { this.credit = 0; return false; }
        const backlog = this.received.length - this.cursor;
        const target = this.done
            ? Math.min(2200, 750 + backlog * 1.5)
            : backlog > 64
                ? Math.min(1800, 600 + backlog * 2)
                : Math.max(60, Math.min(360, this.incomingRate * .9));
        this.rate = target < this.rate ? target
            : this.rate + (target - this.rate) * Math.min(1, elapsed / 55);
        this.credit += elapsed * this.rate / 1000;
        let count = Math.min(128, Math.floor(this.credit));
        this.credit -= count;
        const start = this.cursor;
        const pending = this.received.slice(start);
        const units = segmenter === null ? Array.from(pending) : segmenter.segment(pending);
        for (const item of units) {
            if (count-- <= 0) break;
            const value = typeof item === 'string' ? item : item.segment;
            // 一个代理对可能跨两次网络增量到达；不先显示半个 emoji。
            if (!this.done && /[\uD800-\uDBFF]$/.test(value)) break;
            this.cursor += value.length;
        }
        return start !== this.cursor;
    }

    flush() { this.cursor = this.received.length; this.credit = 0; }
}

const childrenOf = node => Array.from(node.childNodes ?? node.children ?? []);
const isText = node => node.nodeType === 3 || node.tagName === '#TEXT';

function appendInk(doc, parent, text, glow) {
    if (text === '') return;
    if (!glow) { parent.appendChild(doc.createTextNode(text)); return; }
    for (const value of text) {
        if (/\s/.test(value)) { parent.appendChild(doc.createTextNode(value)); continue; }
        const char = doc.createElement('span');
        char.className = 'agent-reply-new';
        char.textContent = value;
        char.addEventListener('animationend', () => {
            if (char.parentNode !== parent) return;
            const plain = doc.createTextNode(value);
            if (typeof parent.replaceChild === 'function') parent.replaceChild(plain, char);
            else { parent.insertBefore(plain, char); parent.removeChild(char); }
            parent.normalize?.();
        }, { once: true });
        parent.appendChild(char);
    }
}

/** 给解析器的纯文本叶子加稳定容器，后续只追加新到的可见字。 */
function textRuns(doc, node) {
    for (const child of childrenOf(node)) {
        if (isText(child)) {
            const run = doc.createElement('span');
            run.className = 'agent-reply-ink';
            run.replyText = child.textContent ?? '';
            run.appendChild(doc.createTextNode(run.replyText));
            node.insertBefore(run, child);
            node.removeChild(child);
        } else textRuns(doc, child);
    }
}

function activateInk(doc, node, glow) {
    if (node.className === 'agent-code-sweep') glow = false;
    if (typeof node.replyText === 'string') {
        while (node.firstChild) node.removeChild(node.firstChild);
        appendInk(doc, node, node.replyText, glow);
    } else for (const child of childrenOf(node)) activateInk(doc, child, glow);
}

const attributesOf = node => typeof node.getAttributeNames === 'function'
    ? node.getAttributeNames() : Object.keys(node.attrs ?? {});

/** 保留已显示节点、代码滚动位置和图片；扫光容器自身不被重建。 */
function reconcile(doc, parent, desired, glow) {
    const old = childrenOf(parent);
    desired.forEach((next, index) => {
        const current = old[index];
        if (current && current.tagName === next.tagName) {
            if (typeof next.replyText === 'string' && typeof current.replyText === 'string') {
                if (next.replyText.startsWith(current.replyText)) {
                    appendInk(doc, current, next.replyText.slice(current.replyText.length), glow);
                } else {
                    while (current.firstChild) current.removeChild(current.firstChild);
                    appendInk(doc, current, next.replyText, false);
                }
                current.replyText = next.replyText;
            } else {
                for (const name of attributesOf(current)) {
                    if (next.getAttribute(name) === null) current.removeAttribute?.(name);
                }
                for (const name of attributesOf(next)) {
                    if (current.getAttribute(name) !== next.getAttribute(name)) {
                        current.setAttribute(name, next.getAttribute(name));
                    }
                }
                reconcile(doc, current, childrenOf(next), glow && next.className !== 'agent-code-sweep');
            }
        } else {
            activateInk(doc, next, glow);
            parent.insertBefore(next, current ?? null);
            if (current) parent.removeChild(current);
        }
    });
    for (const child of old.slice(desired.length)) parent.removeChild(child);
}

// Chromium 的祖先 background-clip:text 不能正确裁剪已横向滚动的代码文字。
// 代码光层放进代码自己的滚动内容里，两层由同一个 pre 一起裁剪和滚动。
function codeSweeps(doc, node, overlay) {
    if (node.tagName === 'PRE') {
        const code = node.firstChild;
        if (!code) return;
        const content = doc.createElement('div'); content.className = 'agent-code-content';
        node.removeChild(code); content.appendChild(code); node.appendChild(content);
        if (!overlay) {
            const light = doc.createElement('code'); light.className = 'agent-code-sweep';
            light.setAttribute('aria-hidden', 'true');
            light.appendChild(doc.createTextNode(code.textContent ?? ''));
            content.appendChild(light);
        }
    } else for (const child of childrenOf(node)) codeSweeps(doc, child, overlay);
}

/** 一条实时回复的稳定 DOM 与帧任务，历史消息不经过播放器。 */
export function createReplyPlayback({ doc, onPaint = () => {} }) {
    const view = doc.defaultView;
    const requestFrame = view?.requestAnimationFrame?.bind(view);
    const cancelFrame = view?.cancelAnimationFrame?.bind(view);
    const clock = () => view?.performance?.now?.() ?? Date.now();
    const reduced = view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    const animate = typeof requestFrame === 'function' && !reduced;
    const buffer = new ReplyTextBuffer();
    const root = doc.createElement('div'); root.className = 'agent-stream';
    const base = doc.createElement('div'); base.className = 'agent-stream-base';
    const sweep = doc.createElement('div'); sweep.className = 'agent-sweep';
    sweep.setAttribute('aria-hidden', 'true');
    sweep.setAttribute('inert', '');
    root.appendChild(base);
    let frameId = null;
    let disposed = false;
    let paintedText = null;
    let paintedActive = null;

    function paint() {
        const changed = paintedText !== buffer.text;
        const activeChanged = paintedActive !== buffer.active;
        if (changed) {
            const nodes = renderMarkdownNodes(doc, buffer.text, { tables: true });
            nodes.forEach(node => { codeSweeps(doc, node, false); textRuns(doc, node); });
            reconcile(doc, base, nodes, animate);
            // 副本也只来自显示游标，永远拿不到缓冲区里的未来文字。
            const overlay = renderMarkdownNodes(doc, buffer.text, { tables: true });
            overlay.forEach(node => { codeSweeps(doc, node, true); textRuns(doc, node); });
            reconcile(doc, sweep, overlay, false);
            paintedText = buffer.text;
        }
        if (buffer.active && sweep.parentNode !== root) root.appendChild(sweep);
        else if (!buffer.active && sweep.parentNode === root) root.removeChild(sweep);
        root.hidden = buffer.text === '';
        root.setAttribute('data-active', String(buffer.active));
        paintedActive = buffer.active;
        if (changed || activeChanged) onPaint();
    }

    function schedule() {
        if (frameId !== null || disposed || !buffer.pending) return;
        frameId = requestFrame(now => {
            frameId = null;
            if (disposed) return;
            if (buffer.advance(now)) paint();
            schedule();
        });
    }

    const syncScroll = event => {
        const blocks = Array.from(base.querySelectorAll?.('pre') ?? []);
        const index = blocks.indexOf(event.target);
        const overlay = sweep.querySelectorAll?.('pre')?.[index];
        if (overlay) overlay.scrollLeft = event.target.scrollLeft;
    };
    base.addEventListener('scroll', syncScroll, true);

    return {
        element: root,
        get text() { return buffer.text; },
        get active() { return buffer.active; },
        update(text, done) {
            if (disposed) return;
            buffer.receive(text, done, clock());
            if (!animate) buffer.flush();
            paint();
            if (animate) schedule();
        },
        dispose() {
            disposed = true;
            if (frameId !== null) cancelFrame?.(frameId);
            frameId = null;
            base.removeEventListener?.('scroll', syncScroll, true);
        },
    };
}
