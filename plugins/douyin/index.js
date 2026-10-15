import { createServiceBadge } from 'toolbox://shell/shell/service-badge.js';
import { createCoverPlaceholder } from 'toolbox://shell/shell/media-placeholder.js';

// 抖音解析。数据来自本地 douyin_parse 服务(3301)。
//
// 一个绕不开的坎:抖音的 CDN 会检查 Referer,从页面直接请求视频地址会被 403。
// 所以图片和视频都必须走本地服务的中转端点(/douyin/proxy?url=…),
// 由服务端带正确的请求头去取再吐回来。
//
// 第二个坎(2026-09 起):详情接口被风控挡着。只带 ttwid 的请求一律回
// 403 "Blocked by ArgusSecurityPlugin Uifid Not Found" —— 这不是代码能绕过去的,
// 必须放真实浏览器 Cookie(uifid / sessionid / msToken)。所以面板上有一个
// Cookie 设置区:服务端把它写进 douyin_cookie.txt 并**立即生效**(不用重启)。
//
// 与旧站的区别:服务不再靠用户去双击 .bat —— 由应用托管,随应用自动启动。
const DOUYIN_API = 'http://localhost:3301';
const SERVICE_ID = 'douyin-api';

export default {
    activate(ctx) {
        // 服务由 plugin.json 声明,这里只留一个引用位给 setup 用
        this.onPanelState = null;
        this.ctx = ctx;
    },

    setup(el, ctx) {
        const input = el.querySelector('#douyinInput');
        const btn = el.querySelector('#douyinBtn');
        const result = el.querySelector('#douyinResult');
        const cookieBox = el.querySelector('#douyinCookieBox');
        const cookieInput = el.querySelector('#douyinCookieInput');
        const cookieState = el.querySelector('#douyinCookieState');
        const cookieSave = el.querySelector('#douyinCookieSave');
        const cookieMsg = el.querySelector('#douyinCookieMsg');
        const cookieLogin = el.querySelector('#douyinCookieLogin');
        const cookieRelogin = el.querySelector('#douyinCookieRelogin');

        // 服务状态徽标:抽成共享组件,music / douyin / bilibili 三处复用的同一份
        const badge = createServiceBadge({
            el: el.querySelector('#douyinService'),
            ctx,
            serviceId: SERVICE_ID,
            hint: '服务随应用启动,没起来就点「启动服务」',
        });
        this.badge = badge;

        const proxy = (u) => DOUYIN_API + '/douyin/proxy?url=' + encodeURIComponent(u);

        /** 统一请求封装:网络层失败 = 服务没起来。 */
        async function api(path, options) {
            let res;
            try {
                res = await fetch(DOUYIN_API + path, options);
            } catch {
                throw new Error('解析服务未启动:等「服务状态」变成运行中,或点上方的「启动服务」');
            }
            const json = await res.json();
            if (json.code !== 0) {
                const err = new Error(json.message || '接口返回错误');
                err.data = json.data;
                throw err;
            }
            return json.data;
        }

        function message(msg, link) {
            result.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'music-empty';
            p.textContent = msg;
            if (link) {
                p.appendChild(document.createElement('br'));
                const a = document.createElement('a');
                a.className = 'douyin-open';
                a.href = link.href;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = link.text;
                p.appendChild(a);
            }
            result.appendChild(p);
        }

        // ---------- Cookie 设置 ----------

        function renderCookieState(data) {
            if (!data) { cookieState.textContent = ''; return; }
            if (!data.configured) {
                cookieState.textContent = '未配置(解析会被风控拦)';
                cookieState.dataset.state = 'missing';
            } else if (!data.hasUifid || !data.hasSessionid) {
                // 只配了 ttwid 之类是不够的 —— 直接说清楚缺什么,
                // 否则用户会以为"我配了 Cookie 怎么还失败"
                const lack = [!data.hasUifid && 'uifid', !data.hasSessionid && 'sessionid']
                    .filter(Boolean).join(' / ');
                cookieState.textContent = `已配置,但缺少 ${lack}`;
                cookieState.dataset.state = 'weak';
            } else {
                cookieState.textContent = `已配置(${data.length} 字符)`;
                cookieState.dataset.state = 'ok';
            }
        }

        async function loadCookieState() {
            try {
                renderCookieState(await api('/douyin/cookie'));
            } catch {
                cookieState.textContent = '服务未启动,读不到';
                cookieState.dataset.state = 'missing';
            }
        }

        /** 解析失败且原因是风控 → 把 Cookie 区展开,别让用户去猜。 */
        function openCookieBox(msg) {
            if (cookieBox) cookieBox.open = true;
            if (cookieMsg) cookieMsg.textContent = msg ?? '';
        }

        /**
         * 「登录抖音并自动记住」。
         *
         * 真正的活全在主进程:它按插件清单里声明的登录页/Cookie 域开一个
         * **持久分区**的登录窗(和用户日常浏览器互不影响),轮询到登录态就自动关窗,
         * 然后把 Cookie 直接 POST 给本插件的服务(值不经过这里)。
         * 面板只负责按钮状态与结果提示。
         */
        async function loginWithBrowser(force) {
            if (!ctx.cookies) {
                if (cookieMsg) {
                    cookieMsg.textContent = '这个插件没申请 cookies 权限,只能用下面的手动粘贴';
                    cookieMsg.className = 'hint status-error';
                }
                return;
            }
            const buttons = [cookieLogin, cookieRelogin].filter(Boolean);
            buttons.forEach(b => { b.disabled = true; });
            if (cookieMsg) {
                cookieMsg.className = 'hint';
                cookieMsg.textContent = '登录窗已打开 —— 扫码登录后会**自动**完成,不用手动关窗…';
            }
            try {
                const r = await ctx.cookies.login({ force });
                if (r?.ok) {
                    if (cookieMsg) {
                        const s = r.summary ?? {};
                        cookieMsg.textContent = `已拿到登录态并交给服务`
                            + `(sessionid=${s.hasSessionid ? '有' : '无'},`
                            + `uifid=${s.hasUifid ? '有' : '无'},`
                            + `${s.length ?? 0} 字符)。现在可以解析了。`;
                        cookieMsg.className = 'hint status-ok';
                    }
                    await loadCookieState();
                } else {
                    if (cookieMsg) {
                        cookieMsg.textContent = `没成功:${r?.error ?? '未知原因'}`
                            + (r?.reason ? `(${r.reason})` : '');
                        cookieMsg.className = 'hint status-error';
                    }
                    await loadCookieState();
                }
            } catch (err) {
                if (cookieMsg) {
                    cookieMsg.textContent = '取 Cookie 失败:' + err.message;
                    cookieMsg.className = 'hint status-error';
                }
            } finally {
                buttons.forEach(b => { b.disabled = false; });
            }
        }

        cookieLogin?.addEventListener('click', () => loginWithBrowser(false));
        // 「换账号」:即使已经有登录态也重开登录窗
        cookieRelogin?.addEventListener('click', () => loginWithBrowser(true));

        cookieSave?.addEventListener('click', async () => {
            const value = (cookieInput?.value ?? '').trim();
            if (value === '') { if (cookieMsg) cookieMsg.textContent = '先粘 Cookie 再保存'; return; }
            cookieSave.disabled = true;
            if (cookieMsg) cookieMsg.textContent = '保存中…';
            try {
                const data = await api('/douyin/cookie', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie: value }),
                });
                renderCookieState(data);
                if (cookieMsg) {
                    cookieMsg.textContent = '已保存,再点一次「解析」试试';
                    cookieMsg.className = 'hint status-ok';
                }
            } catch (err) {
                if (cookieMsg) {
                    cookieMsg.textContent = '保存失败:' + err.message;
                    cookieMsg.className = 'hint status-error';
                }
            } finally {
                cookieSave.disabled = false;
            }
        });

        /** 图集 → 九宫格;视频 → 原生播放器。两者都可能挂一条"新标签打开"。 */
        function render(info) {
            result.innerHTML = '';

            const card = document.createElement('div');
            card.className = 'douyin-card';

            const title = document.createElement('p');
            title.className = 'douyin-title';
            title.textContent = info.desc || '(无标题)';
            card.appendChild(title);

            const author = document.createElement('p');
            author.className = 'douyin-author';
            author.textContent = '作者:' + (info.author_nickname || '未知')
                + (info.content_type === 'image'
                    ? ' · 图集共 ' + (info.image_count ?? '?') + ' 张' : '');
            card.appendChild(author);

            // 优先无水印地址,没有就退回清晰度列表第一档
            const best = info.nwm_url || info.qualities?.[0]?.url;

            if (info.content_type === 'image' && Array.isArray(info.image_urls)) {
                const grid = document.createElement('div');
                grid.className = 'douyin-images';
                for (const u of info.image_urls.slice(0, 20)) {
                    const img = document.createElement('img');
                    img.src = proxy(u);
                    img.loading = 'lazy';       // 滚到可视区才加载,省流量
                    img.alt = '图集图片';
                    // 上游删图 / 代理取不到时换矢量占位图,别留一个碎图图标
                    img.addEventListener('error', () => {
                        img.replaceWith(createCoverPlaceholder({
                            label: '图片加载失败',
                            className: 'douyin-img-fallback',
                        }));
                    }, { once: true });
                    grid.appendChild(img);
                }
                card.appendChild(grid);
            } else if (best) {
                const video = document.createElement('video');
                video.controls = true;
                video.preload = 'metadata';     // 只取元信息,不预下整段
                video.src = proxy(best);
                card.appendChild(video);
            } else {
                // 既没有图也没有播放地址:给一张占位图,别只留一行标题
                card.appendChild(createCoverPlaceholder({
                    label: '没有可预览的画面',
                    className: 'douyin-cover-fallback',
                }));
            }

            if (best || info.cover_url) {
                const open = document.createElement('a');
                open.className = 'douyin-open';
                open.href = proxy(best || info.cover_url);
                open.target = '_blank';
                open.rel = 'noopener noreferrer';
                open.textContent = '新标签打开(可右键另存为)';
                card.appendChild(open);
            }

            result.appendChild(card);
        }

        /**
         * 兜底:让**开物自带的浏览器**去把这个页面打开,把它自己发的那个请求的
         * 响应抓回来,再交给服务抽取。
         *
         * 为什么需要:抖音的 a_bogus 签名已经跟当前的 Argus 对不上,纯 HTTP 一律
         * "Signature Not Found"(本地服务就是这条路);而页面自己发的请求一定是对的,
         * 因为签名是它自己的 JS 算的。实测抓回来的 aweme_detail 有 100KB 以上,
         * 标题 / 作者 / 播放地址齐全。
         *
         * @returns {Promise<boolean>} 是否已经拿到并渲染出结果
         */
        async function browserFallback(text) {
            if (!ctx.browser) return false;
            message('本地接口被风控挡了,正在用自带浏览器重新取一次(要开一下页面,约 10 秒)…');
            let target;
            try {
                target = await api('/douyin/resolve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: text }),
                });
            } catch {
                return false;
            }
            const pageUrl = `https://www.douyin.com/${target.isNote ? 'note' : 'video'}/${target.awemeId}`;
            let captured;
            try {
                captured = await ctx.browser.fetchJson({ url: pageUrl });
            } catch (err) {
                ctx.log.warn(`浏览器取数据失败:${err.message}`);
                return false;
            }
            if (!captured?.ok) {
                ctx.log.warn(`浏览器没抓到数据:${captured?.error}`);
                return false;
            }
            try {
                render(await api('/douyin/from-detail', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ detail: captured.json }),
                }));
                return true;
            } catch (err) {
                ctx.log.warn(`上游数据处理失败:${err.message}`);
                return false;
            }
        }

        async function parse() {
            const text = input.value.trim();
            if (text === '') return;

            btn.disabled = true;
            message('解析中,可能需要几秒…');
            try {
                render(await api('/douyin/parse', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: text }),
                }));
            } catch (err) {
                // 本地接口不行就走浏览器兜底(登录态 Cookie 与这个兜底是两条独立的路:
                // 前者让本地纯 HTTP 请求尽量过得去,后者完全不依赖签名复刻)
                if (await browserFallback(text)) return;   // 成功了,finally 会恢复按钮
                // 两条都不行:如果是风控,把 Cookie 区摆出来(用户自己能解决的那种)
                if (err.data?.needCookie) {
                    message('抖音风控拦下了本地请求,浏览器兜底也没成 —— 先在下面登录一次,再试');
                    openCookieBox('先点「登录抖音并自动记住」,再点「解析」');
                    loadCookieState();
                } else {
                    message(err.message);
                }
            } finally {
                btn.disabled = false;
            }
        }

        btn.addEventListener('click', parse);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') parse();
        });

        // 面板打开时读一次 Cookie 状态(服务可能还没起来,读不到就显示占位)
        loadCookieState();
    },

    teardown() {
        this.badge?.dispose();
        this.badge = null;
    },
};
