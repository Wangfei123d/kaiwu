import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const preloadSource = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

test('首选项动效动作限于布尔值且主窗口事件能取消订阅', () => {
    const listeners = new Map();
    const removed = [];
    const sent = [];
    const ipcRenderer = {
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
            removed.push([channel, listener]);
            if (listeners.get(channel) === listener) listeners.delete(channel);
        },
        invoke() {}, send: (...args) => sent.push(args),
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
    assert.equal(typeof bridge.onPreferencesMotionChange, 'function');
    for (const callback of [null, undefined, false, 0, 'callback', {}]) {
        assert.throws(() => bridge.onPreferencesMotionChange(callback), /需要一个函数/);
    }
    let received;
    const dispose = bridge.onPreferencesMotionChange((...args) => { received = args; });
    assert.equal(typeof dispose, 'function');
    const listener = listeners.get('preferences:main-motion-change');
    assert.equal(typeof listener, 'function');
    listener({ off: true });
    assert.equal(JSON.stringify(received), '[{"off":true}]');
    dispose();
    assert.deepEqual(removed, [['preferences:main-motion-change', listener]]);
    assert.equal(listeners.has('preferences:main-motion-change'), false);
    assert.throws(() => bridge.requestPreferencesMotionChange('off'), /必须是布尔值/);
    bridge.requestPreferencesMotionChange(true);
    assert.equal(JSON.stringify(sent), '[["preferences:motion-change",{"off":true}]]');
});
