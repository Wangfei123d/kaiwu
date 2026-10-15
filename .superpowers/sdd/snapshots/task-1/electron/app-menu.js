// 应用菜单的**纯函数**部分:只产出模板数据,不碰 Electron。
//
// 为什么拆出来:菜单最容易被"写完了但没人看"——它不在 HTML 里,自检也不好点。
// 做成纯函数之后,「标签有没有漏翻」「开发者项有没有泄漏到产品菜单」
// 「macOS 与 Windows 结构对不对」都能用 `node --test` 直接钉住,
// 接线(Menu.buildFromTemplate + setApplicationMenu)留在 main.js。
//
// 背景:在此之前全项目没有任何 setApplicationMenu,BrowserWindow 也没设
// autoHideMenuBar,所以窗口顶部露出来的是 Electron 的原生英文菜单。

/**
 * @param {{platform?:string, isDev?:boolean,
 *          views?:Array<{id:string,label:string,open?:boolean,active?:boolean}>,
 *          tools?:Array<{id:string,label:string,open?:boolean,active?:boolean}>,
 *          onAddView?:(id:string)=>void}} [options]
 * @returns {Array<object>} Electron 的 MenuItem 模板
 */
export function buildMenuTemplate({ platform = process.platform, isDev = false, views = [], tools = [], onAddView = null } = {}) {
    const darwin = platform === 'darwin';
    const sep = { type: 'separator' };

    // 开发者项只在 --dev 下出现。
    // 产品菜单里摆一个「开发者工具」是内部实现泄漏;但开发时又离不开它,
    // 所以做成开关而不是直接删掉代码。
    const devView = isDev
        ? [
            { label: '重新加载', role: 'reload' },
            { label: '强制重新加载', role: 'forceReload' },
            { label: '开发者工具', role: 'toggleDevTools' },
            sep,
        ]
        : [];

    // macOS 的第一项必须是应用自己的菜单(关于/隐藏/退出都在这里),
    // 而不是照搬 Windows 的「文件 → 退出」。不分支的话,在 mac 上会冒出一个
    // 结构错误的菜单 —— 本机是 Windows,所以这种错误只会在换机器时才暴露。
    const appMenu = {
        label: '开物',
        submenu: [
            { label: '关于开物', role: 'about' },
            sep,
            { label: '隐藏开物', role: 'hide' },
            { label: '隐藏其他', role: 'hideOthers' },
            { label: '显示全部', role: 'unhide' },
            sep,
            { label: '退出开物', role: 'quit' },
        ],
    };

    const fileMenu = {
        label: '文件',
        submenu: darwin
            ? [{ label: '关闭窗口', role: 'close' }]
            : [{ label: '退出', role: 'quit' }],
    };

    const editMenu = {
        label: '编辑',
        submenu: [
            { label: '撤销', role: 'undo' },
            { label: '重做', role: 'redo' },
            sep,
            { label: '剪切', role: 'cut' },
            { label: '复制', role: 'copy' },
            { label: '粘贴', role: 'paste' },
            { label: '全选', role: 'selectAll' },
        ],
    };

    const viewMenu = {
        label: '视图',
        submenu: [
            ...devView,
            { label: '实际大小', role: 'resetZoom' },
            { label: '放大', role: 'zoomIn' },
            { label: '缩小', role: 'zoomOut' },
            sep,
            { label: '全屏', role: 'togglefullscreen' },
        ],
    };

    // 「窗口」先分组列工具面板与其它工作台面板:点一条 = 把它弄到眼前。
    //
    // ⚠️ 两张视图表都由调用方**每次现取**(插件启用/停用会让贡献视图动态出现或消失),
    //    写死一张静态表一定会和注册表脱节 —— 所以这里只接收,不去猜。
    // ⚠️ "已开着"与"看得见"是**两件事**,所以是**三态**而不是两态(这里踩过一个大坑):
    //    · 没开            → 点它**新加一格**;
    //    · 开着但藏着      → 点它**切到前面**(它只是某格里的非活动标签);
    //    · 正显示着        → 无事可做(点不动)。
    //    先前把"开着"一律当成"无事可做":用户那一格里塞着「笔记列表 / AI 会话 / 短剧项目」三个标签,
    //    当前显示第三个,菜单却给笔记列表**打了勾又点不动** —— 用户于是找不到自己的笔记列表
    //    (原话:"笔记列表呢")。判据改成 (open && active) 之后这种"勾着却没救"的状态就没了。
    // ⚠️ 用 `type:'checkbox'` 而不是自己画标记,是为了让 macOS/Windows 原生外观都跟着系统走。
    // ⚠️ 两组都为空时**连分隔线都不加** —— 否则窗口菜单底下会多出一条空段,
    //    既有那几条"窗口菜单长什么样"的断言也会跟着碎。
    const checkableViewItems = (items, prefix) => items.map((v) => {
        const open = v.open === true;
        const active = v.active === true;
        return {
            id: `${prefix}${v.id}`,
            label: v.label,
            type: 'checkbox',
            checked: open,
            enabled: !(open && active),
            click: () => { if (!(open && active)) onAddView?.(v.id); },
        };
    });
    const safeViews = Array.isArray(views) ? views : [];
    const safeTools = Array.isArray(tools) ? tools : [];
    const toolMenu = safeTools.length === 0 ? [] : [{
        label: '工具',
        submenu: checkableViewItems(safeTools, 'kaiwu-tool-'),
    }];
    const panelItems = safeViews.length === 0 ? [] : [
        ...checkableViewItems(safeViews, 'kaiwu-panel-'),
        sep,
    ];
    const groupedPanelItems = [
        ...toolMenu,
        ...(toolMenu.length > 0 && safeViews.length > 0 ? [sep] : []),
        ...panelItems,
        ...(toolMenu.length > 0 && safeViews.length === 0 ? [sep] : []),
    ];

    const windowMenu = {
        label: '窗口',
        submenu: [
            ...groupedPanelItems,
            ...(darwin
                ? [
                    { label: '最小化', role: 'minimize' },
                    { label: '缩放', role: 'zoom' },
                    sep,
                    { label: '前置全部窗口', role: 'front' },
                ]
                : [
                    { label: '最小化', role: 'minimize' },
                    { label: '关闭窗口', role: 'close' },
                ]),
        ],
    };

    const menus = [fileMenu, editMenu, viewMenu, windowMenu];
    return darwin ? [appMenu, ...menus] : menus;
}
