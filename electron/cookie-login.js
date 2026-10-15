// 「登录一次,自动记住 Cookie」的主进程实现。
//
// 背景:抖音的详情接口被风控挡着(403 Blocked by ArgusSecurityPlugin Uifid Not Found),
// 而 uifid / msToken 是**页面 JS 在客户端算出来**的,requests 拿不到。
// 实测:纯 HTTP + 签名 → 403;开物自带的真 Chromium 匿名访问 → 只拿到 UIFID_TEMP,
// 还是 403;只有**登录态**那一整套才过得去。
//
// 所以这里用开物自己的 Chromium 开一个**持久分区**的登录窗:用户扫码一次,
// 登录态就留在那个分区里(以后重启应用也还在),之后随时能把 Cookie 取出来。
//
// 三个刻意的设计:
//   1. 分区是持久的(`persist:` 前缀)—— 否则每次都要重新扫码,这个功能就没意义了。
//   2. 登录页、Cookie 域、投递目标**全部来自插件清单**,渲染进程递不进任何 URL。
//   3. 轮询到登录态(`sessionid`)就**自动关窗**:用户不需要知道"关掉窗口才算完成"。
//
// 依赖全部注入吗?这里没有像 service-supervisor 那样做到完全注入 ——
// 因为它做的事就是"开一个窗口、等用户",脱离 Electron 也没法有意义地测。
// 能纯函数化的部分(拼 Cookie、体检 Cookie)已经抽到 app/lib/cookie-string.js。
import { BrowserWindow, session } from 'electron';

import { buildCookieString, summarizeCookie } from '../app/lib/cookie-string.js';

export const PARTITION_PREFIX = 'persist:kaiwu-login:';
const POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** 每个登录目标一个分区:同一站点只需登录一次,互不干扰。 */
export function partitionFor(cookieDomain) {
    return PARTITION_PREFIX + String(cookieDomain || 'default').replace(/[^a-z0-9.-]/gi, '_');
}

/**
 * 读某个分区里目标域的 Cookie(不打开任何窗口)。
 * @returns {Promise<{cookie:string, summary:object, cookies:Array}>}
 */
export async function readCookies({ cookieDomain }) {
    const ses = session.fromPartition(partitionFor(cookieDomain));
    const cookies = await ses.cookies.get({ domain: cookieDomain });
    const cookie = buildCookieString(cookies);
    return { cookie, summary: summarizeCookie(cookie), cookies };
}

/**
 * 确保拿到可用的 Cookie:已经有登录态就直接返回,否则开登录窗等用户。
 *
 * @param {object} opts
 * @param {string} opts.loginUrl     清单声明的登录页(https)
 * @param {string} opts.cookieDomain 取哪些域(含子域)的 Cookie
 * @param {string} [opts.title]      窗口标题
 * @param {object} [opts.parent]     父窗口(有的话登录窗居中在它上面)
 * @param {Function} [opts.log]
 * @param {boolean} [opts.force]     true = 即使已有登录态也开窗(用户想换账号)
 * @param {number} [opts.timeoutMs]  等用户的上限
 */
export async function captureLoginCookies({
    loginUrl,
    cookieDomain,
    title = '登录',
    parent = null,
    log = console,
    force = false,
    show = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
    const existing = await readCookies({ cookieDomain });
    if (!force && existing.summary.hasSessionid) {
        return { ...existing, opened: false, reused: true, reason: '已有登录态' };
    }

    const ses = session.fromPartition(partitionFor(cookieDomain));
    // 登录窗用桌面版 UA:很多站点对非常规 UA 会走去降级的页面
    ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

    const win = new BrowserWindow({
        width: 1000,
        height: 760,
        title,
        show,
        parent: parent ?? undefined,
        autoHideMenuBar: true,
        backgroundColor: '#12100f',
        webPreferences: {
            partition: partitionFor(cookieDomain),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    let closed = false;
    const done = new Promise((resolve) => {
        let timer = null;
        const finish = (reason) => {
            if (closed) return;
            closed = true;
            if (timer) clearInterval(timer);
            resolve(reason);
        };
        win.on('closed', () => finish('窗口被用户关闭'));
        timer = setInterval(async () => {
            if (win.isDestroyed()) { finish('窗口已销毁'); return; }
            try {
                const now = await ses.cookies.get({ domain: cookieDomain, name: 'sessionid' });
                if (now && now.length > 0) {
                    // 登录成功了。给页面一点时间把 uifid 之类也发下来再关。
                    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 1500);
                    finish('检测到登录态');
                }
            } catch (err) {
                log.warn?.('[cookies] 轮询登录态失败', err);
            }
        }, POLL_MS);
        setTimeout(() => finish('等待超时'), timeoutMs);
    });

    try {
        await win.loadURL(loginUrl);
    } catch (err) {
        log.warn?.('[cookies] 登录页加载失败', err);
    }
    const reason = await done;
    log.info?.(`[cookies] 登录窗结束:${reason}`);

    // 窗口关掉之后再读一次:Cookie 是随响应下发的,关窗不影响已有 Cookie
    const after = await readCookies({ cookieDomain });
    return { ...after, opened: true, reused: false, reason };
}
