### Task 3: 移除顶栏设置标签并复用设置页

**Files:**
- Modify: `app/index.html`
- Modify: `app/main.js`
- Modify: `app/lib/settings-page.js`
- Modify: `tests/settings-page.test.js`
- Modify: `app/styles/shell.css`
- Create: `tests/app-shell-settings-preferences.test.js`

**Interfaces:**
- 主界面保留一个“笔记”导航按钮；进入笔记时该按钮有 `aria-current="page"`，进入设置时移除该属性。
- `bridge.onOpenPreferences(openPreferences)` 与自测钩子 `window.__pwTabs.openPreferences()` 共用 `switchView('settings')` 行为。
- `SETTINGS_VIEW` 只保留仍有效的 `view` 与 `paneId`，不再暴露失效的 `tabId`。

- [ ] **Step 1: 先写主界面和设置常量回归测试**

创建 `tests/app-shell-settings-preferences.test.js`，断言 HTML 不含 `id="viewSettings"`，仍有 `id="viewNotes"` 与 `id="paneSettings"`；仅针对 `.topbar-views` 导航确认没有 `role="tablist"`，笔记按钮没有 `role="tab"`；`app/main.js` 订阅 `bridge.onOpenPreferences`、按视图切换 `aria-current` 并提供 `openPreferences` 自测钩子；`electron/main.js` 发送固定菜单事件。更新 `tests/settings-page.test.js` 的常量断言为 `{ view: 'settings', paneId: 'paneSettings' }`。

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SETTINGS_VIEW } from '../app/lib/settings-page.js';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
const electronMain = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');

test('主导航通过首选项事件打开保留的设置页', () => {
    assert.doesNotMatch(html, /id="viewSettings"/);
    assert.match(html, /id="viewNotes"/);
    assert.match(html, /id="paneSettings"/);
    const nav = html.match(/<nav class="topbar-views"[\s\S]*?<\/nav>/)?.[0] ?? '';
    assert.doesNotMatch(nav, /role="tablist"|role="tab"/);
    assert.match(main, /bridge\.onOpenPreferences\(/);
    assert.match(main, /aria-current/);
    assert.match(main, /openPreferences/);
    assert.match(electronMain, /menu:open-preferences/);
    assert.deepEqual(SETTINGS_VIEW, { view: 'settings', paneId: 'paneSettings' });
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/app-shell-settings-preferences.test.js tests/settings-page.test.js`

Expected: 主界面合同与设置常量测试因旧 Settings tab / tabId 仍存在而失败；现有设置逻辑测试通过。

- [ ] **Step 3: 移除旧标签并接入首选项事件**

从 `app/index.html` 删除设置按钮与 tablist/tab 语义；给笔记按钮设置 `aria-current="page"`。更新 `app/styles/shell.css` 活动样式选择器为 `.view-tab[aria-current="page"]`。在 `app/main.js` 用 `switchView` 管理笔记按钮的 `aria-current`，订阅 `bridge.onOpenPreferences(() => switchView('settings'))`，并在原有 `window.__pwTabs` 对象中暴露同一切换函数。移除 `SETTINGS_VIEW.tabId` 及指向顶栏按钮的注释。

```js
function switchView(next) {
    const selected = next === 'settings' ? 'settings' : 'notes';
    $('paneNotes').hidden = selected !== 'notes';
    $('paneSettings').hidden = selected !== 'settings';
    for (const button of document.querySelectorAll('.view-tab')) {
        if (button.dataset.view === selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    if (selected === 'settings') void settingsView.show();
}
bridge.onOpenPreferences(() => switchView('settings'));
// 在现有 window.__pwTabs 对象中加入：
openPreferences: () => switchView('settings'),
```

- [ ] **Step 4: 复跑 shell 与设置测试确认 GREEN**

Run: `node --test tests/app-shell-settings-preferences.test.js tests/settings-page.test.js`

Expected: 新的导航/事件合同与全部现有设置数据、搜索、路径和设置通道测试通过。

