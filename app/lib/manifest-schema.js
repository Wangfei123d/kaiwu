// 清单校验规则。纯函数,主进程(校验文件夹形态的 plugin.json)与渲染进程
// (校验单文件形态内联清单)共用同一份实现 —— 两条路径的校验强度必须一致。
//
// 这是权限模型里"服务命令只能来自清单"那条保证的入口:清单是唯一能引入
// 命令行的地方,所以这里的每一条约束都是结构性的,不是格式挑剔。
export const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// clipboard:把**本地文件**放进系统剪贴板(CF_HDROP)。网页 API 做不到这件事,
// 只能由主进程调 Windows 剪贴板 —— 所以它是一条需要申请的能力。
// vault:读写**当前笔记库**(只递相对路径,绝对路径与越界由主进程的 vault 守卫判)。
// 申请它的典型理由是"我的数据就存在笔记库旁边"——例如短剧项目落在 <笔记库>/短剧/。
// drama:短剧工作台的引擎通道。引擎要用 fs / child_process / crypto,而渲染进程是
// 沙箱 —— 那些只能在主进程跑,插件递叶子字段、主进程按当前笔记库解析路径。
export const KNOWN_PERMISSIONS = ['log', 'settings', 'services', 'dialog', 'shell', 'cookies', 'browser', 'clipboard', 'vault', 'drama', 'sessions', 'canvas'];

const KNOWN_TOP_LEVEL = new Set([
    'id', 'name', 'version', 'description', 'author', 'entry', 'order',
    'permissions', 'contributes',
]);

// 插件目录内的相对路径:不允许绝对路径、不允许 ..
function isSafeRelative(p) {
    return typeof p === 'string'
        && p.length > 0
        && !p.startsWith('/')
        && !p.startsWith('\\')
        && !/^[a-zA-Z]:/.test(p)
        && !p.split(/[\\/]/).includes('..');
}

function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateManifest(raw, { sourceLabel = '(未知来源)' } = {}) {
    const errors = [];
    const warnings = [];
    // 每条错误都带上来源:这些信息最终会拼进侧边栏的错误卡片与自检输出,
    // 没有来源标签就无法判断是哪个插件的清单坏了。
    const err = (field, message) => errors.push({ field, message: `${sourceLabel}: ${message}` });
    const warn = (field, message) => warnings.push({ field, message });

    if (!isPlainObject(raw)) {
        err('(root)', '清单必须是一个对象');
        return { ok: false, errors, warnings, value: null };
    }

    for (const key of Object.keys(raw)) {
        if (!KNOWN_TOP_LEVEL.has(key)) {
            warn(key, '未知字段,已忽略(可能是为更新的版本准备的)');
        }
    }

    if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
        err('id', 'id 必填,且只能是小写字母开头的 2–40 位小写字母/数字/连字符');
    }
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
        err('name', 'name 必填且不能为空');
    } else if (raw.name.length > 60) {
        err('name', 'name 不能超过 60 个字符');
    }
    if (typeof raw.version !== 'string' || !VERSION_PATTERN.test(raw.version)) {
        err('version', 'version 必填,格式为 x.y.z');
    }
    if (raw.entry !== undefined && !isSafeRelative(raw.entry)) {
        err('entry', 'entry 必须是插件目录内的相对路径');
    }
    if (raw.order !== undefined && !Number.isFinite(raw.order)) {
        err('order', 'order 必须是数字');
    }

    const permissions = raw.permissions ?? [];
    if (!Array.isArray(permissions)) {
        err('permissions', 'permissions 必须是数组');
    } else {
        permissions.forEach((p, i) => {
            if (!KNOWN_PERMISSIONS.includes(p)) {
                err(`permissions[${i}]`, `未知权限 "${p}",可用:${KNOWN_PERMISSIONS.join(' / ')}`);
            }
        });
    }

    const contributes = isPlainObject(raw.contributes) ? raw.contributes : {};
    const tools = [];
    const services = [];

    if (contributes.tools !== undefined) {
        if (!Array.isArray(contributes.tools)) {
            err('contributes.tools', 'contributes.tools 必须是数组');
        } else {
            contributes.tools.forEach((t, i) => {
                const at = `contributes.tools[${i}]`;
                if (!isPlainObject(t)) {
                    err(at, '必须是对象');
                    return;
                }
                if (typeof t.id !== 'string' || !ID_PATTERN.test(t.id)) {
                    err(`${at}.id`, 'id 必填且格式非法');
                }
                if (typeof t.title !== 'string' || t.title.trim() === '') {
                    err(`${at}.title`, 'title 必填');
                }
                if (typeof t.icon !== 'string' || t.icon === '') {
                    err(`${at}.icon`, 'icon 必填(内建图标名或单个 emoji)');
                }
                if (!isSafeRelative(t.panel)) {
                    err(`${at}.panel`, 'panel 必须是插件目录内的相对路径');
                }
                if (t.style !== undefined && !isSafeRelative(t.style)) {
                    err(`${at}.style`, 'style 必须是插件目录内的相对路径');
                }
                if (t.workspacePane !== undefined && typeof t.workspacePane !== 'boolean') {
                    err(`${at}.workspacePane`, 'workspacePane 必须是布尔值');
                }
                tools.push({
                    id: t.id,
                    title: t.title,
                    icon: t.icon,
                    panel: t.panel,
                    style: t.style ?? null,
                    workspacePane: t.workspacePane === true,
                    pluginId: raw.id,
                });
            });
        }
    }

    if (contributes.services !== undefined) {
        if (!Array.isArray(contributes.services)) {
            err('contributes.services', 'contributes.services 必须是数组');
        } else {
            contributes.services.forEach((s, i) => {
                const at = `contributes.services[${i}]`;
                if (!isPlainObject(s)) {
                    err(at, '必须是对象');
                    return;
                }
                if (typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) {
                    err(`${at}.id`, 'id 必填且格式非法');
                }
                if (typeof s.label !== 'string' || s.label.trim() === '') {
                    err(`${at}.label`, 'label 必填');
                }
                if (typeof s.cwd !== 'string' || s.cwd === '') {
                    err(`${at}.cwd`, 'cwd 必填(相对服务根目录)');
                }
                if (typeof s.command !== 'string' || s.command === '') {
                    err(`${at}.command`, 'command 必填');
                }
                if (s.args !== undefined && !Array.isArray(s.args)) {
                    err(`${at}.args`, 'args 必须是数组');
                }
                if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
                    err(`${at}.port`, 'port 必填,且为 1–65535 的整数');
                }
                if (s.healthPath !== undefined && !String(s.healthPath).startsWith('/')) {
                    err(`${at}.healthPath`, 'healthPath 必须以 / 开头');
                }
                if (s.healthTimeoutMs !== undefined
                    && (!Number.isInteger(s.healthTimeoutMs) || s.healthTimeoutMs < 100)) {
                    err(`${at}.healthTimeoutMs`, 'healthTimeoutMs 若给出,须是 ≥100 的整数(毫秒)');
                }
                services.push({
                    id: s.id,
                    pluginId: raw.id,
                    label: s.label,
                    cwd: s.cwd,
                    command: s.command,
                    args: s.args ?? [],
                    port: s.port,
                    healthPath: s.healthPath ?? null,
                    // 健康检查的单次超时。默认交给 service-runner(5000ms);
                    // 有些服务的 /health 要探自己的上游,响应慢,可以在这里调大。
                    healthTimeoutMs: s.healthTimeoutMs ?? null,
                    autoStart: s.autoStart === true,
                    stopOnExit: s.stopOnExit !== false,     // 默认 true
                });
            });
        }
    }

    // 声明了服务就必须申请 services 权限
    if (services.length > 0 && Array.isArray(permissions) && !permissions.includes('services')) {
        err('permissions', '声明了 contributes.services,但没有申请 "services" 权限');
    }

    // ---- cookieLogin:用开物自带的 Chromium 登一次站点,把 Cookie 交给自己的服务 ----
    //
    // 为什么做成"清单声明"而不是一个通用的"打开任意网址并取 Cookie"接口:
    // 渲染进程递不进任何 URL —— 登录页、Cookie 域、投递目标全部来自清单,且
    // **投递目标只能是本插件自己声明的服务**(端口由主进程从服务清单里查),
    // 所以这条能力不会变成"把任意站点的 Cookie 发到任意地址"。
    const cookieLogin = normalizeCookieLogin(contributes.cookieLogin, {
        err, pluginId: raw.id, services,
    });
    if (cookieLogin && Array.isArray(permissions) && !permissions.includes('cookies')) {
        err('permissions', '声明了 contributes.cookieLogin,但没有申请 "cookies" 权限');
    }

    // ---- browserFetch:用自带浏览器打开页面,抓页面自己发的那个请求的响应 ----
    //
    // 用途:接口被风控守着、签名只能由页面自己的 JS 算的站点(抖音)。
    // 与 cookieLogin 共用同一个持久分区 —— 先登录,再用浏览器取数据。
    const browserFetch = normalizeBrowserFetch(contributes.browserFetch, {
        err, cookieLogin,
    });
    if (browserFetch && Array.isArray(permissions) && !permissions.includes('browser')) {
        err('permissions', '声明了 contributes.browserFetch,但没有申请 "browser" 权限');
    }

    // ---- panes:平铺工作台里的一片面板(参与布局树,能被拖 / 停靠 / 进存档) ----
    //
    // 与 contributes.tools 的区别是**归宿**:工具面板住在内容区,而 pane 由外壳在
    // 挂载工作台时装配、并进布局存档。这里只校验形状;真正登记走运行时的
    // `ctx.panes.register(...)`(与 tools 同一条路:清单声明 + 运行时登记)。
    const panes = [];
    if (contributes.panes !== undefined) {
        if (!Array.isArray(contributes.panes)) {
            err('contributes.panes', 'contributes.panes 必须是数组');
        } else {
            contributes.panes.forEach((p, i) => {
                const at = `contributes.panes[${i}]`;
                if (!isPlainObject(p)) {
                    err(at, '必须是对象');
                    return;
                }
                if (typeof p.id !== 'string' || !ID_PATTERN.test(p.id)) {
                    err(`${at}.id`, 'id 必填且格式非法');
                }
                if (typeof p.title !== 'string' || p.title.trim() === '') {
                    err(`${at}.title`, 'title 必填');
                }
                panes.push({
                    id: p.id,
                    title: p.title,
                    fullTitle: typeof p.fullTitle === 'string' ? p.fullTitle : null,
                    pluginId: raw.id,
                });
            });
        }
    }

    if (errors.length > 0) return { ok: false, errors, warnings, value: null };

    const value = {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        description: typeof raw.description === 'string' ? raw.description : '',
        author: typeof raw.author === 'string' ? raw.author : '',
        entry: raw.entry ?? 'index.js',
        order: raw.order ?? 1000,
        permissions: [...new Set(permissions)],
        contributes: { tools, services, panes, cookieLogin, browserFetch },
    };
    return { ok: true, errors, warnings, value };
}

/**
 * 归一化 contributes.browserFetch。返回 null 表示没声明。
 *
 * 形状:
 *   {
 *     "allow":   ["https://www.douyin.com/"],              // 只允许打开这些前缀的页面
 *     "capture": ["/aweme/v1/web/aweme/detail/"]           // 只抓 URL 里含这些片段的响应
 *   }
 *
 * 为什么必须有 allow:渲染进程会把"要打开哪个网址"递上来,没有白名单它就成了
 * "用带登录态的浏览器打开任意网页"的能力。
 */
function normalizeBrowserFetch(raw, { err, cookieLogin }) {
    if (raw === undefined || raw === null) return null;
    const at = 'contributes.browserFetch';
    if (!isPlainObject(raw)) {
        err(at, '必须是对象');
        return null;
    }

    const allow = Array.isArray(raw.allow) ? raw.allow : [];
    if (allow.length === 0) {
        err(`${at}.allow`, 'allow 必填,且至少一项(只允许打开这些前缀的页面)');
    }
    allow.forEach((u, i) => {
        if (typeof u !== 'string' || !/^https:\/\//i.test(u)) {
            err(`${at}.allow[${i}]`, '必须是 https 开头的地址前缀');
        }
    });

    const capture = Array.isArray(raw.capture) ? raw.capture : [];
    if (capture.length === 0) {
        err(`${at}.capture`, 'capture 必填,且至少一项(要抓哪个请求的响应)');
    }
    capture.forEach((c, i) => {
        if (typeof c !== 'string' || c.trim() === '') {
            err(`${at}.capture[${i}]`, '必须是非空字符串(响应 URL 里要包含的片段)');
        }
    });

    // 复用 cookieLogin 的持久分区:没有登录态的话,页面抓到的也只会是空响应
    if (!cookieLogin) {
        err(at, 'browserFetch 需要同时声明 contributes.cookieLogin(它复用那个持久分区)');
    }

    return {
        allow: allow.filter(u => typeof u === 'string'),
        capture: capture.filter(c => typeof c === 'string' && c.trim() !== ''),
    };
}

/**
 * 归一化 contributes.cookieLogin。返回 null 表示没声明。
 *
 * 形状:
 *   {
 *     "title": "登录抖音",                     // 登录窗口标题(可选)
 *     "loginUrl": "https://www.douyin.com/",   // 必须是 https
 *     "cookieDomain": "douyin.com",            // 取哪些域的 Cookie(含子域)
 *     "target": { "service": "douyin-api", "path": "/douyin/cookie" }
 *   }
 */
function normalizeCookieLogin(raw, { err, pluginId, services }) {
    if (raw === undefined || raw === null) return null;
    const at = 'contributes.cookieLogin';
    if (!isPlainObject(raw)) {
        err(at, '必须是对象');
        return null;
    }

    const loginUrl = raw.loginUrl;
    if (typeof loginUrl !== 'string' || !/^https:\/\//i.test(loginUrl)) {
        err(`${at}.loginUrl`, 'loginUrl 必填,且必须是 https 地址(登录页要能放密码)');
    }
    const cookieDomain = raw.cookieDomain;
    if (typeof cookieDomain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cookieDomain)) {
        err(`${at}.cookieDomain`, 'cookieDomain 必填,且必须是域名(例如 douyin.com)');
    }

    const target = isPlainObject(raw.target) ? raw.target : {};
    const ownsService = services.some(s => s.id === target.service);
    if (typeof target.service !== 'string' || target.service === '') {
        err(`${at}.target.service`, 'target.service 必填(要投递给哪个服务)');
    } else if (!ownsService) {
        // 只能投给自己声明的服务 —— 否则这条能力就成了"把 Cookie 发到任意地方"
        err(`${at}.target.service`,
            `服务 "${target.service}" 不是本插件声明的服务(可用:${services.map(s => s.id).join(' / ') || '无'})`);
    }
    if (typeof target.path !== 'string' || !target.path.startsWith('/')) {
        err(`${at}.target.path`, 'target.path 必填,且必须以 / 开头(投递到该服务的哪个路径)');
    }

    return {
        pluginId,
        title: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : '登录',
        loginUrl: typeof loginUrl === 'string' ? loginUrl : '',
        cookieDomain: typeof cookieDomain === 'string' ? cookieDomain : '',
        target: {
            service: typeof target.service === 'string' ? target.service : '',
            path: typeof target.path === 'string' ? target.path : '',
        },
    };
}
