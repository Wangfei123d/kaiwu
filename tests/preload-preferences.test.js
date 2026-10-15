import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const preloadSource = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

test('首选项事件只传零参数并能取消订阅', () => {
    const listeners = new Map();
    const removed = [];
    const ipcRenderer = {
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
            removed.push([channel, listener]);
            if (listeners.get(channel) === listener) listeners.delete(channel);
        },
        invoke() {}, send() {},
    };
    const pageWindow = { addEventListener() {} };
    const sandbox = {
        require: (name) => {
            assert.equal(name, 'electron');
            return { contextBridge: { executeInMainWorld: ({ func, args }) => func(...args) }, ipcRenderer };
        },
        window: pageWindow,
        console,
    };
    vm.runInNewContext(preloadSource, sandbox, { filename: 'preload.cjs' });
    const bridge = pageWindow.__kaiwuBridgeTemp;
    assert.equal(typeof bridge.onOpenPreferences, 'function');
    for (const callback of [null, undefined, false, 0, 'callback', {}]) {
        assert.throws(() => bridge.onOpenPreferences(callback), /需要一个函数/);
    }
    let received;
    const dispose = bridge.onOpenPreferences((...args) => { received = args; });
    assert.equal(typeof dispose, 'function');
    const listener = listeners.get('menu:open-preferences');
    assert.equal(typeof listener, 'function');
    listener({ sender: 'must-not-cross-the-bridge' });
    assert.deepEqual(received, []);
    dispose();
    assert.deepEqual(removed, [['menu:open-preferences', listener]]);
    assert.equal(listeners.has('menu:open-preferences'), false);
});
