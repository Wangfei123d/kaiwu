import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWordDropPreview } from '../plugins/drama/drop-preview.js';

function element(tag = 'div') {
    return {
        tagName: tag.toUpperCase(),
        className: '', style: {}, hidden: false, textContent: '', children: [], parentElement: null,
        append(...nodes) {
            for (const node of nodes) { node.parentElement = this; this.children.push(node); }
        },
        setAttribute(name, value) { this[name] = value; },
        remove() {
            if (!this.parentElement) return;
            const siblings = this.parentElement.children;
            const at = siblings.indexOf(this);
            if (at !== -1) siblings.splice(at, 1);
            this.parentElement = null;
        },
    };
}

test('Word 轮廓和真实节点共用图坐标，离开与销毁均不留临时 DOM', () => {
    const world = element();
    const canvas = element();
    canvas.dataset = {};
    canvas.setAttribute = (key, value) => { canvas.dataset[key] = value; };
    canvas.removeAttribute = (key) => { delete canvas.dataset[key]; };
    canvas.ownerDocument = { createElement: element };
    canvas.getBoundingClientRect = () => ({ left: 100, top: 50 });
    const preview = createWordDropPreview({
        el: { canvas, world },
        state: { view: { x: 10, y: 20, scale: 2 }, graph: { nodes: [] } },
    });

    preview.show('分镜.docx', 210, 270);
    const outline = world.children.find((child) => child.className === 'drama-drop-preview');
    assert.ok(outline, '预落位节点应在随画布平移缩放的 world 中');
    assert.equal(outline.style.left, '50px');
    assert.equal(outline.style.top, '100px');
    assert.equal(outline.hidden, false);
    assert.equal(outline.children[1].textContent, '分镜.docx');
    assert.equal(canvas.dataset['data-drop-preview'], 'word');

    preview.reading();
    assert.match(outline.children[2].textContent, /正在读取/);
    preview.hide();
    assert.equal(outline.hidden, true);
    assert.equal(canvas.dataset['data-drop-preview'], undefined);
    preview.dispose();
    assert.equal(world.children.includes(outline), false);
});
