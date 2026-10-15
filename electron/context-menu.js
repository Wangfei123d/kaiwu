// 右键菜单。Electron **默认不提供**任何右键菜单 —— 所以"图片右键保存不了"不是图片的问题,
// 是根本没有菜单可点(实测用户反馈的原话:"图片无法右键保存")。
//
// 分工:**纯模板**在这里(可 node --test 直测),接线只有薄薄一层(installContextMenu)。
// 这样"什么时候该出现哪几项"是一条能被钉住的规则,而不是藏在事件回调里的一段 if。
//
// 纪律与 window-open 一致:只认 http(s)。渲染进程里的东西(包括模型给的图片地址)
// 都当**不可信输入** —— `file://`、`javascript:` 之类一律不给"保存/打开"。

/** 图片扩展名之外还可能有查询串,所以判据只看协议,不看后缀。 */
function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** 文件名:从 URL 里取最后一段,取不到就给个兜底名(它只是"另存为"的默认值)。 */
export function suggestedFileName(url) {
    try {
        const last = new URL(url).pathname.split('/').filter((s) => s !== '').pop();
        return last === undefined || last === '' ? 'image.png' : decodeURIComponent(last);
    } catch {
        return 'image.png';
    }
}

/**
 * 根据 Electron 的 context-menu 参数算出菜单项。
 *
 * @param {object} params webContents 的 'context-menu' 事件参数
 * @param {{saveImage:Function, copyImageUrl:Function, openExternal:Function}} actions
 * @returns {Array|null} 菜单模板;返回 null = 不弹菜单(空白处右键不该冒出空菜单)
 */
export function contextMenuTemplate(params, actions) {
    const p = (params !== null && typeof params === 'object') ? params : {};
    const items = [];

    // 1) 图片:菜单的主体就是它
    if (p.mediaType === 'image' && isHttpUrl(p.srcURL)) {
        items.push({ label: '保存图片…', click: () => actions.saveImage(p.srcURL) });
        items.push({ label: '复制图片地址', click: () => actions.copyImageUrl(p.srcURL) });
        items.push({ label: '在浏览器中打开', click: () => actions.openExternal(p.srcURL) });
    }

    // 2) 可编辑区(输入框、笔记编辑器):常规的剪切/复制/粘贴。
    //    这些用 role 而不是自己实现 —— 交给 Electron 才有原生的快捷键与剪贴板行为。
    if (p.isEditable === true) {
        if (items.length > 0) items.push({ type: 'separator' });
        items.push({ role: 'cut', label: '剪切' });
        items.push({ role: 'copy', label: '复制' });
        items.push({ role: 'paste', label: '粘贴' });
        if (p.editFlags?.canSelectAll !== false) items.push({ role: 'selectAll', label: '全选' });
        return items;
    }

    // 3) 选中了文字:至少给一个"复制"(聊天里想复制一段回复时很常用)
    if (typeof p.selectionText === 'string' && p.selectionText.trim() !== '') {
        if (items.length > 0) items.push({ type: 'separator' });
        items.push({ role: 'copy', label: '复制' });
    }

    // 没图、没选中、也不可编辑 → 不弹(空白处右键弹一个空菜单很怪)
    return items.length === 0 ? null : items;
}

/**
 * 把一个窗口接上右键菜单。每个窗口调一次;窗口销毁时监听随 webContents 一起消失。
 *
 * "保存图片"走 Electron 自己的下载流程 + **另存为**对话框。⚠️ 不挂 will-download 的话,
 * downloadURL 会**直接落到默认下载目录**、什么也不问 —— 用户以为"没保存",其实是存到了
 * 他不知道的地方(这正是要避开的那种"静默"行为)。
 *
 * @param {object} win BrowserWindow
 * @param {{Menu:object, clipboard:object, shell:object, dialog?:object, log?:object}} deps
 */
export function installContextMenu(win, deps) {
    const { Menu, clipboard, shell, log = console } = deps;
    const actions = {
        saveImage: (url) => {
            try {
                win.webContents.downloadURL(url);
            } catch (err) {
                log.warn?.('[菜单] 保存图片失败:' + (err?.message ?? err));
            }
        },
        copyImageUrl: (url) => {
            try {
                clipboard.writeText(url);
            } catch (err) {
                log.warn?.('[菜单] 复制图片地址失败:' + (err?.message ?? err));
            }
        },
        openExternal: (url) => {
            // 与 window-open 同一条纪律:只放行 http(s)
            if (isHttpUrl(url)) shell.openExternal(url);
        },
    };

    // 只挂一次的"下载即另存为":session 是跨窗口共享的,挂两次会叠加。
    const session = win.webContents.session;
    if (session !== undefined && session.__kaiwuSaveDialog !== true) {
        session.__kaiwuSaveDialog = true;
        session.on('will-download', (_event, item) => {
            item.setSaveDialogOptions({
                title: '保存图片',
                defaultPath: suggestedFileName(item.getURL()),
            });
        });
    }

    win.webContents.on('context-menu', (_event, params) => {
        const template = contextMenuTemplate(params, actions);
        if (template === null) return;
        Menu.buildFromTemplate(template).popup({ window: win });
    });
}
