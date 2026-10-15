### Task 2: 安全接通主进程与 preload 事件

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.cjs`
- Create: `tests/preload-preferences.test.js`

**Interfaces:**
- 主进程构建菜单时提供回调；用户点击后向现有窗口发送固定频道 `menu:open-preferences`，不带 payload。
- preload 桥新增 `onOpenPreferences(callback)`；非函数输入同步报错；回调不接收 IPC event；返回取消订阅函数。

- [ ] **Step 1: 先写 preload 桥测试**

创建 `tests/preload-preferences.test.js`，使用 `node:vm` 执行 `electron/preload.cjs`，注入 mock `electron` 模块并取得传给 `contextBridge.executeInMainWorld` 的桥对象。测试：方法存在；非函数回调抛错；mock `ipcRenderer.on` 触发 listener 时页面回调收到零个参数；返回的 disposer 调用 `ipcRenderer.removeListener` 并移除同一个 listener。

```js
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
        removeListener: (channel, listener) => removed.push([channel, listener]),
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
    assert.throws(() => bridge.onOpenPreferences(null), /需要一个函数/);
    let received;
    const dispose = bridge.onOpenPreferences((...args) => { received = args; });
    const listener = listeners.get('menu:open-preferences');
    listener({ sender: 'must-not-cross-the-bridge' });
    assert.deepEqual(received, []);
    dispose();
    assert.deepEqual(removed, [['menu:open-preferences', listener]]);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/preload-preferences.test.js`

Expected: 因 `onOpenPreferences` 尚不存在而失败，不应出现 VM 初始化错误。

- [ ] **Step 3: 实现主进程发送与 preload 订阅**

在 `electron/main.js` 的 `buildMenuTemplate` 参数中传入 `onOpenPreferences`，仅在 `win !== null && !win.isDestroyed()` 时执行 `win.webContents.send('menu:open-preferences')`。因为初始菜单在主窗口创建前安装，先在该闭包作用域声明 `let win = null`，后将 `const win = createWindow()` 改为 `win = createWindow()`，避免菜单项被提前点击时读到暂时性死区。`onAddView` 的窗口存活守卫同步使用 null 安全判断。在 `electron/preload.cjs` 桥对象中新增校验并复用 `bridge.on('menu:open-preferences', () => callback())`，沿用现有 listener 对 IPC event 的剥离和取消订阅逻辑。

```js
onOpenPreferences(callback) {
    if (typeof callback !== 'function') throw new Error('onOpenPreferences 需要一个函数');
    return bridge.on('menu:open-preferences', () => callback());
},
```

主进程回调只发送固定事件且不带参数：

```js
onOpenPreferences: () => {
    if (win !== null && !win.isDestroyed()) win.webContents.send('menu:open-preferences');
},
```

- [ ] **Step 4: 复跑 IPC 测试和语法检查**

Run: `node --check electron/main.js; node --check electron/preload.cjs; node --test tests/preload-preferences.test.js tests/app-menu.test.js`

Expected: 语法检查退出码为 0，目标测试全部通过。

