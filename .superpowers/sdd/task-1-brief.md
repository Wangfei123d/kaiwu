### Task 1: 将“首选项…”加入编辑菜单

**Files:**
- Modify: `electron/app-menu.js`
- Test: `tests/app-menu.test.js`

**Interfaces:**
- `buildMenuTemplate({ ..., onOpenPreferences = null } = {})` 增加可选回调 `onOpenPreferences: () => void`。
- “编辑”菜单在现有“全选”后添加分隔线和“首选项…”项；点击只调用回调。

- [ ] **Step 1: 先写菜单行为测试**

扩展 `tests/app-menu.test.js`：分别构建 Windows 与 macOS 菜单，定位“编辑”菜单，断言末尾为 `全选 / separator / 首选项…`，点击“首选项…”只调用一次传入的回调；断言撤销、剪切、复制、粘贴、全选 role 均保持原值。

```js
test('编辑菜单在 Windows 与 macOS 都提供首选项入口', () => {
    for (const platform of ['win32', 'darwin']) {
        let opened = 0;
        const edit = buildMenuTemplate({ platform, onOpenPreferences: () => { opened += 1; } })
            .find((menu) => menu.label === '编辑');
        assert.deepEqual(edit.submenu.slice(-3).map((item) =>
            item.type === 'separator' ? 'separator' : item.label), ['全选', 'separator', '首选项…']);
        edit.submenu.at(-1).click();
        assert.equal(opened, 1);
        assert.deepEqual(edit.submenu.filter((item) => item.role).map((item) => item.role),
            ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
    }
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/app-menu.test.js`

Expected: 新断言因菜单尚无“首选项…”或回调参数未接入而失败，既有菜单断言通过。

- [ ] **Step 3: 实现最小菜单改动**

给 `buildMenuTemplate` 增加 `onOpenPreferences = null` 参数；在编辑菜单标准命令之后追加分隔线和下列菜单项。不改变其它平台菜单。

```js
{ label: '全选', role: 'selectAll' },
sep,
{ label: '首选项…', click: () => onOpenPreferences?.() },
```

- [ ] **Step 4: 运行菜单测试确认 GREEN**

Run: `node --test tests/app-menu.test.js tests/app-menu-window-panels.test.js`

Expected: 两个文件全部通过，原有普通面板和工具子菜单行为不变。

