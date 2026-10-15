import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsView } from '../app/settings/settings-view.js';

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.listeners = new Map();
        this.value = '';
        this.id = '';
        this.hidden = false;
    }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute() {}
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    trigger(name) { return this.listeners.get(name)?.(); }
}

test('图片密钥设置框不回显，保存后清空输入并只显示配置状态', async () => {
    const els = { searchEl: new Element('input'), navEl: new Element('nav'),
        bodyEl: new Element('main'), overviewEl: new Element('div') };
    const all = () => [els.searchEl, els.navEl, els.bodyEl, els.overviewEl];
    const find = (root, id) => root.id === id ? root : root.children.map((child) => find(child, id)).find(Boolean);
    const doc = {
        createElement: (tag) => new Element(tag),
        getElementById: (id) => all().map((root) => find(root, id)).find(Boolean) ?? null,
    };
    const sent = [];
    let configured = false;
    const bridge = { invoke: async (channel, payload) => {
        sent.push({ channel, payload });
        if (channel === 'drama:image:status') return { ok: configured, model: 'gpt-image-2.5', storage: 'encrypted' };
        if (channel === 'drama:image:key:set') { configured = true; return { ok: true }; }
        return null;
    } };
    const view = createSettingsView({ doc, els, bridge });
    await view.mount();
    const input = doc.getElementById('settingsImageKey');
    assert.equal(input?.type, 'password');
    assert.equal(input.value, '');
    input.value = 'sk-test-not-a-real-key-1234567890';
    await doc.getElementById('settingsImageKeySave').trigger('click');
    assert.equal(input.value, '');
    assert.ok(sent.some(({ channel }) => channel === 'drama:image:key:set'));
    assert.equal(doc.getElementById('settingsImageKeyStatus').textContent.includes('sk-test'), false);
    view.dispose();
});
