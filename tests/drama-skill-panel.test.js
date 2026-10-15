import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillPanel } from '../plugins/drama/skill-panel.js';

class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.open = false; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this._text = ''; this.children = items; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute() {}
}
const doc = { createElement: tag => new Element(tag) };
function find(root, name) { return root.className === name ? root : root.children.map(c => find(c, name)).find(Boolean); }

test('待匹配及未启用技能只显示元信息，不读取正文或图片', async () => {
    let reads = 0;
    const candidates = [{ id: 's', name: '角色' }];
    let match = null;
    const panel = createSkillPanel({ doc, getState: () => ({ candidates, match }),
        readInput: async () => { reads++; return '技能正文'; } });
    assert.match(panel.element.textContent, /待匹配/);
    assert.equal(reads, 0);
    match = { selected: [] };
    panel.refresh();
    assert.match(panel.element.textContent, /未启用/);
    assert.match(panel.element.textContent, /角色/);
    assert.equal(reads, 0);
    assert.equal(find(panel.element, 'drama-skill-actual'), undefined);
});

test('展示启用理由，只有展开上轮实际输入才加载全文；修改需求回到待匹配', async () => {
    let reads = 0;
    const candidates = [{ id: 's', name: '角色' }];
    let match = { selected: [{ id: 's', reason: '保持外观', evidence: '同一个人' }] };
    const run = { skillInput: { file: 'outputs/input.txt', text: '摘要', images: [] } };
    const panel = createSkillPanel({ doc, getState: () => ({ candidates, match, run }),
        readInput: async () => { reads++; return '完整技能正文'; } });
    assert.match(panel.element.textContent, /保持外观/);
    assert.match(panel.element.textContent, /同一个人/);
    assert.equal(reads, 0);
    const details = find(panel.element, 'drama-skill-actual');
    details.open = true;
    await details.listeners.toggle();
    assert.equal(reads, 1);
    assert.match(details.textContent, /完整技能正文/);
    match = null;
    panel.refresh();
    assert.match(panel.element.textContent, /待匹配/);
    assert.match(panel.element.textContent, /历史记录/);
});
