import { bridge } from './bootstrap.js';

const $ = (id) => document.getElementById(id);

function makeMenuList(items, depth = 0) {
    const list = document.createElement('div');
    list.className = depth === 0 ? 'app-menu-groups' : 'app-menu-children';
    list.setAttribute('role', 'menu');

    for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
        if (item?.type === 'separator') {
            const separator = document.createElement('div');
            separator.className = 'app-menu-separator';
            separator.setAttribute('role', 'separator');
            list.append(separator);
            continue;
        }

        const group = document.createElement('div');
        group.className = depth === 0 ? 'app-menu-group' : 'app-menu-command';
        group.style.setProperty('--menu-index', String(index));

        const button = document.createElement('button');
        button.className = depth === 0 ? 'app-menu-button app-menu-heading' : 'app-menu-button';
        button.type = 'button';
        button.setAttribute('role', item?.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem');
        button.disabled = item?.enabled === false;

        if (item?.type === 'checkbox') button.setAttribute('aria-checked', item.checked === true ? 'true' : 'false');
        const label = document.createElement('span');
        label.className = 'app-menu-label';
        label.textContent = String(item?.label ?? '');
        button.append(label);

        const children = Array.isArray(item?.items) ? item.items : null;
        if (children) {
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-haspopup', 'menu');
            const chevron = document.createElement('span');
            chevron.className = 'app-menu-chevron';
            chevron.setAttribute('aria-hidden', 'true');
            chevron.textContent = '›';
            button.append(chevron);

            const submenu = makeMenuList(children, depth + 1);
            submenu.hidden = true;
            button.addEventListener('click', () => {
                if (button.disabled) return;
                const wasOpen = button.getAttribute('aria-expanded') === 'true';
                for (const sibling of list.children) {
                    const siblingButton = sibling.querySelector(':scope > .app-menu-button[aria-expanded="true"]');
                    if (!siblingButton || siblingButton === button) continue;
                    siblingButton.setAttribute('aria-expanded', 'false');
                    sibling.querySelector(':scope > .app-menu-children')?.setAttribute('hidden', '');
                }
                button.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
                submenu.hidden = wasOpen;
            });
            group.append(button, submenu);
        } else {
            if (typeof item?.action === 'string' && item.action !== '') {
                button.addEventListener('click', () => {
                    if (button.disabled) return;
                    if (item.action.startsWith('role:')
                        && /^(undo|redo|cut|copy|paste|selectAll)$/.test(item.action.slice('role:'.length))
                        && lastWorkFocus?.isConnected) {
                        lastWorkFocus.focus({ preventScroll: true });
                    }
                    bridge.requestApplicationMenuAction(item.action);
                    document.dispatchEvent(new CustomEvent('kaiwu:app-menu-close'));
                });
            } else {
                button.disabled = true;
            }
            group.append(button);
        }

        list.append(group);
    }
    return list;
}

export function createApplicationMenu() {
    const trigger = $('topbarBrand');
    const host = $('applicationMenu');
    const popup = $('applicationMenuPopup');
    if (!trigger || !host || !popup || typeof bridge.getApplicationMenu !== 'function') return;

    let model = null;
    let open = false;
    let lastWorkFocus = null;

    document.addEventListener('focusout', (event) => {
        if (event.target instanceof HTMLElement && !host.contains(event.target)) lastWorkFocus = event.target;
    });
    trigger.addEventListener('pointerdown', () => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== trigger && !host.contains(active)) lastWorkFocus = active;
    });

    const paint = () => {
        popup.replaceChildren();
        trigger.disabled = !Array.isArray(model) || model.length === 0;
        if (trigger.disabled) {
            trigger.removeAttribute('aria-haspopup');
            document.documentElement.removeAttribute('data-custom-chrome');
        } else {
            trigger.setAttribute('aria-haspopup', 'menu');
            document.documentElement.dataset.customChrome = 'true';
        }
        if (!Array.isArray(model) || model.length === 0) return;
        popup.append(makeMenuList(model));
    };

    const close = ({ restoreFocus = false } = {}) => {
        open = false;
        popup.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        popup.querySelectorAll('.app-menu-button[aria-expanded="true"]').forEach((button) => {
            button.setAttribute('aria-expanded', 'false');
        });
        popup.querySelectorAll('.app-menu-children:not([hidden])').forEach((children) => { children.hidden = true; });
        if (restoreFocus) trigger.focus();
    };

    trigger.addEventListener('click', () => {
        if (!Array.isArray(model) || model.length === 0) return;
        open = !open;
        trigger.setAttribute('aria-expanded', String(open));
        popup.hidden = !open;
        if (!open) close();
    });

    document.addEventListener('click', (event) => {
        if (open && !host.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && open) {
            event.preventDefault();
            close({ restoreFocus: true });
        }
    });
    document.addEventListener('kaiwu:app-menu-close', () => close());

    bridge.onApplicationMenuChange((next) => {
        model = Array.isArray(next) ? next : null;
        paint();
        if (!model && open) close();
    });
    void bridge.getApplicationMenu().then((next) => {
        model = Array.isArray(next) ? next : null;
        paint();
        if (!model && open) close();
    }).catch((err) => console.warn('[shell] 读取应用菜单失败', err));
}
