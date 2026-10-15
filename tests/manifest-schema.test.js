import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../app/lib/manifest-schema.js';

const good = {
    id: 'palette',
    name: '调色板 & 渐变',
    version: '1.0.0',
    entry: 'index.js',
    permissions: ['log'],
    contributes: {
        tools: [{ id: 'palette', title: '调色板', icon: 'palette', panel: 'panel.html' }],
    },
};

test('合法清单通过并补齐默认值', () => {
    const r = validateManifest(good, { sourceLabel: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.value.order, 1000);            // 默认排序值
    assert.deepEqual(r.value.contributes.services, []);  // 默认空服务列表
});

test('缺 id 报错', () => {
    const r = validateManifest({ ...good, id: undefined }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'id'));
});

test('id 含大写或下划线报错', () => {
    for (const bad of ['Palette', 'pal_ette', '1palette', 'a']) {
        const r = validateManifest({ ...good, id: bad }, { sourceLabel: 'x' });
        assert.equal(r.ok, false, `应拒绝 id=${bad}`);
    }
});

test('version 不是 x.y.z 报错', () => {
    const r = validateManifest({ ...good, version: 'v1' }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'version'));
});

test('未知权限报错', () => {
    const r = validateManifest({ ...good, permissions: ['log', 'root'] }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'permissions[1]'));
});

test('工具缺 panel 报错', () => {
    const r = validateManifest({
        ...good,
        contributes: { tools: [{ id: 'p', title: 'P', icon: 'i' }] },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.tools[0].panel'));
});

test('工具 panel 含 ../ 报错', () => {
    const r = validateManifest({
        ...good,
        contributes: { tools: [{ id: 'p', title: 'P', icon: 'i', panel: '../evil.html' }] },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
});

test('服务端口越界报错', () => {
    const r = validateManifest({
        ...good,
        permissions: ['services'],
        contributes: {
            tools: good.contributes.tools,
            services: [{ id: 's', label: 'S', cwd: 'x', command: 'node', port: 70000 }],
        },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.services[0].port'));
});

test('声明服务但未申请 services 权限报错', () => {
    const r = validateManifest({
        ...good,
        permissions: ['log'],
        contributes: {
            tools: good.contributes.tools,
            services: [{ id: 's', label: 'S', cwd: 'x', command: 'node', port: 3300 }],
        },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'permissions'));
});

test('未知顶层字段只给警告不影响通过', () => {
    const r = validateManifest({ ...good, futureField: 1 }, { sourceLabel: 'x' });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => w.field === 'futureField'));
});

// ---- 以下用例是补的:计划只给了上面十条,但校验器承担的边界不止这些 ----

test('清单不是对象时报错并返回 null 值', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
        const r = validateManifest(raw, { sourceLabel: 'x' });
        assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(raw)}`);
        assert.equal(r.value, null);
    }
});

test('name 为空或过长报错', () => {
    assert.equal(validateManifest({ ...good, name: '   ' }, { sourceLabel: 'x' }).ok, false);
    assert.equal(validateManifest({ ...good, name: 'x'.repeat(61) }, { sourceLabel: 'x' }).ok, false);
});

test('entry 是绝对路径或含 .. 时报错', () => {
    for (const bad of ['/abs/index.js', 'C:/x/index.js', '..\\x.js', 'a/../../b.js', '\\x.js']) {
        const r = validateManifest({ ...good, entry: bad }, { sourceLabel: 'x' });
        assert.equal(r.ok, false, `应拒绝 entry=${bad}`);
    }
});

test('permissions 不是数组时报错', () => {
    const r = validateManifest({ ...good, permissions: 'log' }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'permissions'));
});

test('权限重复只保留一份', () => {
    const r = validateManifest({ ...good, permissions: ['log', 'log'] }, { sourceLabel: 'x' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.permissions, ['log']);
});

test('工具归一化后带上 pluginId 与 style 默认值', () => {
    const r = validateManifest(good, { sourceLabel: 'x' });
    const tool = r.value.contributes.tools[0];
    assert.equal(tool.pluginId, 'palette');
    assert.equal(tool.style, null);
});

test('工具 workspacePane 布尔值会保留,其它类型报在对应字段', () => {
    const marked = validateManifest({
        ...good,
        contributes: { tools: [{ ...good.contributes.tools[0], workspacePane: true }] },
    });
    assert.equal(marked.ok, true);
    assert.equal(marked.value.contributes.tools[0].workspacePane, true);

    const invalid = validateManifest({
        ...good,
        contributes: { tools: [{ ...good.contributes.tools[0], workspacePane: 'yes' }] },
    });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.some((e) => e.field === 'contributes.tools[0].workspacePane'));
});

test('工具的 style 非法时报错', () => {
    const r = validateManifest({
        ...good,
        contributes: { tools: [{ id: 'p', title: 'P', icon: 'i', panel: 'a.html', style: '../x.css' }] },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.tools[0].style'));
});

test('工具字段缺失逐项报错', () => {
    const r = validateManifest({
        ...good,
        contributes: { tools: [{ }] },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    const fields = r.errors.map(e => e.field);
    for (const f of ['contributes.tools[0].id', 'contributes.tools[0].title',
        'contributes.tools[0].icon', 'contributes.tools[0].panel']) {
        assert.ok(fields.includes(f), `缺少 ${f} 的报错,实际:${fields.join(', ')}`);
    }
});

test('contributes.tools 不是数组时报错', () => {
    const r = validateManifest({ ...good, contributes: { tools: {} } }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.tools'));
});

test('服务归一化:args / healthPath / autoStart / stopOnExit 默认值', () => {
    const r = validateManifest({
        ...good,
        permissions: ['log', 'services'],
        contributes: {
            services: [{ id: 'svc', label: 'S', cwd: 'sub', command: 'node', port: 3300 }],
        },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, true);
    const svc = r.value.contributes.services[0];
    assert.deepEqual(svc.args, []);
    assert.equal(svc.healthPath, null);
    assert.equal(svc.autoStart, false);
    assert.equal(svc.stopOnExit, true);        // 默认 true:退出时要清掉自己拉起的服务
    assert.equal(svc.pluginId, 'palette');
});

test('healthPath 不以 / 开头时报错', () => {
    const r = validateManifest({
        ...good,
        permissions: ['log', 'services'],
        contributes: {
            services: [{ id: 's', label: 'S', cwd: 'x', command: 'node', port: 3300, healthPath: 'health' }],
        },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.services[0].healthPath'));
});

test('服务 args 不是数组时报错', () => {
    const r = validateManifest({
        ...good,
        permissions: ['log', 'services'],
        contributes: {
            services: [{ id: 's', label: 'S', cwd: 'x', command: 'node', port: 3300, args: 'a' }],
        },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.services[0].args'));
});

test('端口必须是整数:小数与字符串都拒绝', () => {
    for (const port of [3300.5, '3300', 0, -1, 65536, null]) {
        const r = validateManifest({
            ...good,
            permissions: ['log', 'services'],
            contributes: {
                services: [{ id: 's', label: 'S', cwd: 'x', command: 'node', port }],
            },
        }, { sourceLabel: 'x' });
        assert.equal(r.ok, false, `应拒绝 port=${JSON.stringify(port)}`);
        assert.ok(r.errors.some(e => e.field === 'contributes.services[0].port'),
            `port=${JSON.stringify(port)} 应报 port 字段错误`);
    }
});

test('order 不是数字时报错', () => {
    const r = validateManifest({ ...good, order: '5' }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'order'));
});

test('contributes 缺失时补成空贡献', () => {
    const r = validateManifest({ id: 'x1', name: 'X', version: '1.0.0' }, { sourceLabel: 'x' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.contributes,
        { tools: [], services: [], panes: [], cookieLogin: null, browserFetch: null });
});

// ---- panes:平铺工作台里的一片面板 ----
// 与 tools 的区别是**归宿**:工具面板住内容区,pane 参与布局树(能被拖、进存档)。
test('contributes.panes:合法声明被收下,并带上 pluginId', () => {
    const r = validateManifest({
        ...good,
        contributes: {
            panes: [{ id: 'drama', title: '短剧画布', fullTitle: '短剧工作台 · 节点画布' }],
        },
    }, { sourceLabel: 'x' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.value.contributes.panes,
        [{ id: 'drama', title: '短剧画布', fullTitle: '短剧工作台 · 节点画布', pluginId: good.id }]);
});

test('contributes.panes:id 与 title 缺失都报错(面板没有标题就没法在标题栏显示)', () => {
    const noId = validateManifest({ ...good, contributes: { panes: [{ title: 'X' }] } }, { sourceLabel: 'x' });
    assert.equal(noId.ok, false);
    assert.ok(noId.errors.some(e => e.field === 'contributes.panes[0].id'));

    const noTitle = validateManifest({ ...good, contributes: { panes: [{ id: 'drama' }] } }, { sourceLabel: 'x' });
    assert.equal(noTitle.ok, false);
    assert.ok(noTitle.errors.some(e => e.field === 'contributes.panes[0].title'));
});

test('contributes.panes 不是数组时报错', () => {
    const r = validateManifest({ ...good, contributes: { panes: { id: 'x' } } }, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.panes'));
});

// ---- cookieLogin:「登录一次,自动记住 Cookie」 ----
// 这条能力的边界全在清单校验里:登录页必须 https、Cookie 域必须是域名、
// 投递目标必须是**本插件自己声明的服务** —— 否则它就成了"把任意站点 Cookie
// 发到任意地址"的后门。所以这几条必须钉住。

const withService = (extra) => ({
    ...good,
    permissions: ['services', 'cookies'],
    contributes: {
        services: [{
            id: 'svc', label: 'S', cwd: 'd', command: 'node', args: [], port: 3999,
        }],
        cookieLogin: {
            loginUrl: 'https://example.com/',
            cookieDomain: 'example.com',
            target: { service: 'svc', path: '/cookie' },
            ...extra,
        },
    },
});

test('cookieLogin 正常声明会被归一化', () => {
    const r = validateManifest(withService({ title: '登录示例' }), { sourceLabel: 'x' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const c = r.value.contributes.cookieLogin;
    assert.equal(c.title, '登录示例');
    assert.equal(c.loginUrl, 'https://example.com/');
    assert.equal(c.cookieDomain, 'example.com');
    assert.deepEqual(c.target, { service: 'svc', path: '/cookie' });
});

test('cookieLogin:没写 title 时给个默认标题', () => {
    const r = validateManifest(withService({}), { sourceLabel: 'x' });
    assert.equal(r.value.contributes.cookieLogin.title, '登录');
});

test('cookieLogin:登录页必须 https(登录页要能放密码)', () => {
    const r = validateManifest(withService({ loginUrl: 'http://example.com/' }), { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.cookieLogin.loginUrl'));
});

test('cookieLogin:cookieDomain 必须是域名', () => {
    const r = validateManifest(withService({ cookieDomain: '不是域名' }), { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.cookieLogin.cookieDomain'));
});

test('cookieLogin:投递目标只能是本插件自己声明的服务', () => {
    const r = validateManifest(
        withService({ target: { service: '别人的服务', path: '/cookie' } }),
        { sourceLabel: 'x' },
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.cookieLogin.target.service'));
});

test('cookieLogin:target.path 必须以 / 开头', () => {
    const r = validateManifest(withService({ target: { service: 'svc', path: 'cookie' } }), { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.cookieLogin.target.path'));
});

test('cookieLogin:声明了就必须申请 cookies 权限', () => {
    const m = withService({});
    m.permissions = ['services'];                 // 故意不申请 cookies
    const r = validateManifest(m, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'permissions' && e.message.includes('cookies')));
});

test('cookieLogin:不是对象时报错', () => {
    const m = withService({});
    m.contributes.cookieLogin = 'nope';
    const r = validateManifest(m, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.cookieLogin'));
});

// ---- browserFetch:「用自带浏览器取数据」 ----
// 这条能力的边界同样在清单里:只能打开 allow 列出的网址前缀,只能抓 capture
// 命中的响应。没有 allow 它就等于"用带登录态的浏览器打开任意网页"。

const withBrowser = (extra) => {
    const m = withService({});
    m.permissions = ['services', 'cookies', 'browser'];
    m.contributes.browserFetch = {
        allow: ['https://www.douyin.com/'],
        capture: ['/aweme/v1/web/aweme/detail/'],
        ...extra,
    };
    return m;
};

test('browserFetch 正常声明会被归一化', () => {
    const r = validateManifest(withBrowser({}), { sourceLabel: 'x' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.value.contributes.browserFetch, {
        allow: ['https://www.douyin.com/'],
        capture: ['/aweme/v1/web/aweme/detail/'],
    });
});

test('browserFetch:allow 必须是 https,且不能为空', () => {
    const a = validateManifest(withBrowser({ allow: ['http://www.douyin.com/'] }), { sourceLabel: 'x' });
    assert.equal(a.ok, false);
    assert.ok(a.errors.some(e => e.field === 'contributes.browserFetch.allow[0]'));

    const b = validateManifest(withBrowser({ allow: [] }), { sourceLabel: 'x' });
    assert.equal(b.ok, false);
    assert.ok(b.errors.some(e => e.field === 'contributes.browserFetch.allow'));
});

test('browserFetch:capture 不能为空', () => {
    const r = validateManifest(withBrowser({ capture: [] }), { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.browserFetch.capture'));
});

test('browserFetch:必须同时声明 cookieLogin(它复用那个持久分区的登录态)', () => {
    const m = withService({});
    m.permissions = ['services', 'cookies', 'browser'];
    delete m.contributes.cookieLogin;
    m.contributes.browserFetch = { allow: ['https://a.com/'], capture: ['/x/'] };
    const r = validateManifest(m, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'contributes.browserFetch'
        && e.message.includes('cookieLogin')));
});

test('browserFetch:声明了就必须申请 browser 权限', () => {
    const m = withBrowser({});
    m.permissions = ['services', 'cookies'];      // 故意不申请 browser
    const r = validateManifest(m, { sourceLabel: 'x' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'permissions' && e.message.includes('browser')));
});

test('sourceLabel 出现在错误信息里,便于定位是哪个插件', () => {
    const r = validateManifest({ ...good, id: 'BAD' }, { sourceLabel: 'plugins/foo/plugin.json' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.message.includes('plugins/foo/plugin.json')),
        '错误信息应带上来源标签');
});
