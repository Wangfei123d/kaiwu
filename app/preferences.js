import { bridge } from './shell/bootstrap.js';
import { createSettingsView } from './settings/settings-view.js';

const byId = (id) => document.getElementById(id);
const els = {
    searchEl: byId('settingsSearch'),
    navEl: byId('settingsNav'),
    bodyEl: byId('settingsBody'),
};

let index = null;
let vaultPath = '';

async function refreshContext() {
    const [nextIndex, vault] = await Promise.all([
        bridge.invoke('notes:index', {}).catch(() => null),
        bridge.invoke('notes:vault:status', {}).catch(() => null),
    ]);
    index = nextIndex && typeof nextIndex === 'object' ? nextIndex : null;
    vaultPath = vault?.ok === true && typeof vault.path === 'string' ? vault.path : '';
}

const settingsView = createSettingsView({
    els,
    bridge,
    log: console,
    getIndex: () => index,
    getVaultPath: () => vaultPath,
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

async function refresh() {
    await refreshContext();
    await settingsView.show();
    applyMotionLocal(settingsView.state().motionOff);
}

await refresh();
window.addEventListener('focus', () => { void refresh(); });
