import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate } from '../electron/app-menu.js';

// 用户报的:「顶部菜单栏包括选项换成中文」。
//
// 之前全项目**没有任何 `Menu.setApplicationMenu`**,BrowserWindow 也没设
// autoHideMenuBar,所以露出来的是 Electron 的原生英文菜单(File/Edit/View/Window)。
//
// 这组用例钉住三件事:标签全中文、开发者项按开关收放、macOS 与 Windows 的结构差异。

/** 把所有菜单的顶层与子项标签摊平,便于逐条检查。 */
function allLabels(template) {
    const out = [];
    for (const menu of template) {
        out.push(menu.label);
        for (const item of menu.submenu ?? []) if (item.label) out.push(item.label);
    }
    return out;
}

const PLATFORMS = ['win32', 'darwin'];

test('顶层菜单都是中文', () => {
    // 刻意不做「帮助」菜单:它需要一个「关于」对话框,而那是用户没要求的新界面。
    // 用户截图里露出来的也正是 File/Edit/View/Window 这四个。
    assert.deepEqual(buildMenuTemplate({ platform: 'win32' }).map(m => m.label),
        ['文件', '编辑', '视图', '窗口']);
    assert.deepEqual(buildMenuTemplate({ platform: 'darwin' }).map(m => m.label),
        ['开物', '文件', '编辑', '视图', '窗口']);
});

test('所有标签都是中文(没有漏翻的英文)', () => {
    for (const platform of PLATFORMS) {
        for (const label of allLabels(buildMenuTemplate({ platform }))) {
            assert.match(label, /[\u4e00-\u9fa5]/, `「${label}」里一个汉字都没有`);
            assert.equal(/[A-Za-z]/.test(label), false, `「${label}」里混了英文字母`);
        }
    }
});

test('非 dev 时不出现开发者项', () => {
    const labels = allLabels(buildMenuTemplate({ platform: 'win32', isDev: false }));
    for (const devOnly of ['重新加载', '强制重新加载', '开发者工具']) {
        assert.equal(labels.includes(devOnly), false, `「${devOnly}」不该出现在产品菜单里`);
    }
});

test('dev 时开发者项都在', () => {
    const labels = allLabels(buildMenuTemplate({ platform: 'win32', isDev: true }));
    for (const devOnly of ['重新加载', '强制重新加载', '开发者工具']) {
        assert.ok(labels.includes(devOnly), `--dev 下应当有「${devOnly}」`);
    }
});

test('macOS 首项是应用菜单,Windows 不是', () => {
    const mac = buildMenuTemplate({ platform: 'darwin' });
    assert.equal(mac[0].label, '开物', 'macOS 第一项应当是应用自己的名字');
    assert.ok(mac[0].submenu.some(i => i.role === 'about'), '应用菜单里要有「关于」');

    const win = buildMenuTemplate({ platform: 'win32' });
    assert.equal(win.some(m => m.label === '开物'), false, 'Windows 不该有那一条应用菜单');
});

test('每个可点项都有 role 或 click —— 否则会渲染成一个按不动的死项', () => {
    for (const platform of PLATFORMS) {
        for (const menu of buildMenuTemplate({ platform })) {
            for (const item of menu.submenu ?? []) {
                if (item.type === 'separator') continue;
                assert.ok(item.role !== undefined || typeof item.click === 'function',
                    `${menu.label} / ${item.label ?? '(无标签)'} 既没有 role 也没有 click`);
            }
        }
    }
});

test('分隔线不放在首位或末位(看着像菜单坏了)', () => {
    for (const platform of PLATFORMS) {
        for (const menu of buildMenuTemplate({ platform })) {
            const items = menu.submenu ?? [];
            if (items.length === 0) continue;
            assert.notEqual(items[0].type, 'separator', `${menu.label} 的第一项是分隔线`);
            assert.notEqual(items[items.length - 1].type, 'separator', `${menu.label} 的最后一项是分隔线`);
        }
    }
});
