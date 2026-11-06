import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireNativeFileDrop } from '../plugins/drama/drop-bus.js';

function makeFile(name) { return { name, size: 8 }; }

function harness() {
    const listeners = new Map();
    const canvas = {
        dataset: {},
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        setAttribute(name, value) { this.dataset[name.replace('data-', '')] = value; },
        removeAttribute(name) { delete this.dataset[name.replace('data-', '')]; },
    };
    const statuses = [];
    const off = wireNativeFileDrop({ el: { canvas }, setStatus: (text) => statuses.push(text) });
    async function fire(type, files, types = []) {
        let prevented = false;
        await listeners.get(type)({
            dataTransfer: { files, types },
            preventDefault() { prevented = true; },
        });
        return prevented;
    }
    return { canvas, statuses, off, fire };
}

test('资源管理器文件拖到画布时被拦截，提示文本节点仅支持手动输入', async () => {
    const h = harness();
    const prevented = await h.fire('drop', [makeFile('台词终稿.docx')]);
    assert.equal(prevented, true);
    assert.match(h.statuses.at(-1), /只支持手动输入纯文本/);
    assert.equal(h.canvas.dataset.drop, undefined);
    h.off();
});

test('拖动阶段不显示可投放提示，只接管文件以阻止默认打开', async () => {
    const h = harness();
    const nonFilePrevented = await h.fire('dragover', []);
    assert.equal(nonFilePrevented, false);
    const filePrevented = await h.fire('dragover', [makeFile('台词.docx')]);
    assert.equal(filePrevented, true);
    assert.equal(h.canvas.dataset.drop, undefined);
    h.off();
});
