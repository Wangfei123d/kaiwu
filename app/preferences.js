import { bridge } from './shell/bootstrap.js';
import { createSettingsView } from './settings/settings-view.js';
import { LAYOUT_KEY, LAYOUT_NAMESPACE } from './lib/panel-layout-store.js';
import { formatTree } from './lib/panel-tree.js';

const byId = (id) => document.getElementById(id);
const els = {
    searchEl: byId('settingsSearch'),
    navEl: byId('settingsNav'),
    bodyEl: byId('settingsBody'),
    overviewEl: byId('settingsOverview'),
};

let index = null;
let vaultPath = '';
let layoutText = '';

async function refreshContext() {
    const [nextIndex, vault, savedLayout] = await Promise.all([
        bridge.invoke('notes:index', {}).catch(() => null),
        bridge.invoke('notes:vault:status', {}).catch(() => null),
        bridge.invoke('kaiwu:settings:get', { pluginId: LAYOUT_NAMESPACE, key: LAYOUT_KEY }).catch(() => null),
    ]);
    index = nextIndex && typeof nextIndex === 'object' ? nextIndex : null;
    vaultPath = vault?.ok === true && typeof vault.path === 'string' ? vault.path : '';
    try {
        const parsed = typeof savedLayout === 'string' ? JSON.parse(savedLayout) : savedLayout;
        layoutText = parsed?.tree ? formatTree(parsed.tree) : '';
    } catch {
        layoutText = '';
    }
}

const settingsView = createSettingsView({
    els,
    bridge,
    log: console,
    getIndex: () => index,
    getVaultPath: () => vaultPath,
    getLayoutText: () => layoutText,
    onResetLayout: () => bridge.requestPreferencesResetLayout(),
    onChangeVault: () => bridge.requestPreferencesChangeVault(),
    onMotionChange: (off) => {
        applyMotionLocal(off);
        bridge.requestPreferencesMotionChange(off);
    },
});

function applyMotionLocal(off) {
    if (off === true) document.documentElement.setAttribute('data-motion', 'off');
    else document.documentElement.removeAttribute('data-motion');
}

bridge.onPreferencesLayoutText(({ text } = {}) => {
    if (typeof text !== 'string') return;
    layoutText = text;
    settingsView.render();
});

async function refresh() {
    await refreshContext();
    bridge.requestPreferencesLayoutText();
    await settingsView.show();
    applyMotionLocal(settingsView.state().motionOff);
}

await refresh();
window.addEventListener('focus', () => { void refresh(); });
