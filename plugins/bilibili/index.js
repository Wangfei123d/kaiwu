import { createServiceBadge } from 'toolbox://shell/shell/service-badge.js';
import { createCoverPlaceholder } from 'toolbox://shell/shell/media-placeholder.js';
// 队列的**纯逻辑**(状态/清晰度中文、排序、显示标题、要不要轮询)住在 app/lib 下:
// 那些判据同时被面板与单测用着,写成纯函数才能逐条钉住(插件本身跑不进 node --test)。
import {
    PROGRESS_PHASE_LABEL, displayTitle, formatBytes, formatClock, formatCountdown, formatDuration,
    isRunningStatus, planPoll, progressOf, sortTasks, statusClass, statusLabel, summarize,
} from 'toolbox://shell/lib/bilibili-queue.js';

// B 站解析下载。数据来自本地代理(3302),它再转发给 Bilidown 本体(8098)。
//
// 注意两件事:
//   1. Bilidown 的解析接口要**登录态**;没登录时上游直接返回「未登录」。
//      所以出错分支专门给了登录入口,而不是让用户自己猜。
//   2. 下载不由页面做:页面只负责"建任务",真正的下载与音视频合并(需要 ffmpeg)
//      都是 Bilidown 在干;进度现在能在下面的队列区看到(方案 A)。
const BILI_API = 'http://localhost:3302';
const BILI_HOME = 'http://localhost:8098';      // Bilidown 自带界面:扫码登录 / 看进度
const SERVICE_ID = 'bilidown-api';

/**
 * 队列的轮询间隔(只在**有进行中的任务**时才用得上)。
 * 1.5 秒:官方前端差不多也是这个量级,而实测 getTaskList/getActiveTask 是读本地库
 * (中位 1–2ms),真正敏感的是解析那条要回源 B 站的链路。
 */
const POLL_ACTIVE_MS = 1500;

/** 矢量图标:勾号(已完成)与复制。参数与设计稿逐字一致。 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_CHECK = 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Zm-2.7 6.4 1.9 1.9 3.6-3.8';
const ICON_COPY = 'M5.6 5.6V3.3c0-.4.3-.7.7-.7h6.4c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H10.4M3.3 5.6h6.4c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H3.3a.7.7 0 0 1-.7-.7V6.3c0-.4.3-.7.7-.7Z';

// 下载按钮里的小箭头图标。写成常量而不是拼字符串,是为了让"有图标"这件事
// 一眼可见;文字部分交给 setDownloadLabel(),免得改文字时把图标一起抹掉。
const DL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + '<path d="M8 1.6v8.2m0 0 3.3-3.3M8 9.8 4.7 6.5M2.6 13.2h10.8"'
    + ' fill="none" stroke="currentColor" stroke-width="1.7"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

export default {
    activate() {
        this.badge = null;
    },

    setup(el, ctx) {
        const input = el.querySelector('#biliInput');
        const btn = el.querySelector('#biliBtn');
        const result = el.querySelector('#biliResult');

        const badge = createServiceBadge({
            el: el.querySelector('#biliService'),
            ctx,
            serviceId: SERVICE_ID,
            hint: '服务随应用启动,没起来就点「启动服务」',
        });
        this.badge = badge;

        let info = null;        // 解析到的视频信息
        let page = null;        // 当前选中的分P

        // ---- 解析被风控时的冷却(界面那一半;判据与状态在代理进程里)----
        //
        // 为什么要本地也存一份截止时刻:代理已经**拒发**上游请求了(它才是权威),
        // 但界面得让用户看得见"现在是在暂停,还剩多久" —— 一个灰着的按钮加一句
        // 倒计时,比"点了又弹同一句失败"有用得多。
        // ⚠️ 状态必须能重建:插件的面板**切走就卸**,再回来时这份变量是空的 ——
        // 所以挂载时会问一次代理的 /bilibili/parse-state(它不碰上游)。
        let cooldownUntil = 0;      // 本地时钟上的截止时刻(0 = 不在冷却)
        let cooldownTimer = null;
        let cooldownEl = null;

        // 代理地址:默认 3302,允许用插件设置覆盖。
        // 为什么要可配:服务端口写死在清单里,而**自检**要在真窗口里验队列与复制,
        // 又绝不能依赖"用户机器上那个服务此刻在不在"——它会把夹具地址写进设置。
        let apiBase = BILI_API;

        /**
         * 统一请求封装:网络层失败=服务没起来;业务失败=透传上游的中文提示。
         *
         * ⚠️ 业务失败时把 `data` 一起挂在 Error 上:代理会用
         * `data.reason === 'session_blocked'` 说明"这次是**登录会话**被风控"
         * (以及冷却还剩多久)。界面据此决定要不要给"重新扫码登录"的入口与倒计时 ——
         * 靠中文文案去猜那种状态是很脆的(改一个字就失效)。
         */
        async function api(path, options) {
            let res;
            try {
                res = await fetch(apiBase + path, options);
            } catch {
                throw new Error('解析服务未启动:等「服务状态」变成运行中,或点上方的「启动服务」');
            }
            if (res.ok !== true) {
                // HTTP 层就不对时别只给一句"接口返回错误":队列那两个端点是**新加的**,
                // 用户机器上那个还在跑的代理很可能是旧版本 —— 这是最可能的一种 404。
                throw new Error(`代理返回 HTTP ${res.status}`
                    + (res.status === 404 ? '(代理可能是旧版本,重启服务后再试)' : ''));
            }
            const json = await res.json();
            if (json.code !== 0) {
                const err = new Error(json.message || '接口返回错误');
                err.data = (json.data !== null && typeof json.data === 'object') ? json.data : null;
                throw err;
            }
            return json.data;
        }

        /** 只换按钮上的文字,保住里面的图标 —— 直接写 textContent 会把图标抹掉。 */
        function setDownloadLabel(btn, text) {
            const span = btn.querySelector('span');
            if (span) span.textContent = text;
            else btn.textContent = text;
        }

        /**
         * 封面格子:有封面放图,没有(或图加载失败)放内联矢量占位图。
         * 为什么连加载失败也要管:B 站图床会查 Referer,封面是走本地代理取的,
         * 代理一时取不到就会留一个碎图图标 —— 那比没有封面还难看。
         */
        function coverBox(src) {
            const box = document.createElement('div');
            box.className = 'bili-cover';
            if (!src) {
                box.appendChild(createCoverPlaceholder({ label: '暂无封面' }));
                return box;
            }
            const img = document.createElement('img');
            // 封面也走代理:B 站图床会查 Referer
            img.src = `${apiBase}/bilibili/proxy?url=${encodeURIComponent(src)}`;
            img.alt = '视频封面';
            img.loading = 'lazy';
            img.addEventListener('error', () => {
                img.remove();
                box.appendChild(createCoverPlaceholder({ label: '封面加载失败' }));
            }, { once: true });
            box.appendChild(img);
            return box;
        }

        function message(msg, link) {
            result.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'music-empty';
            p.textContent = msg;
            if (link) {
                p.appendChild(document.createElement('br'));
                const a = document.createElement('a');
                a.className = 'bili-open';
                a.href = link.href;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = link.text;
                p.appendChild(a);
            }
            result.appendChild(p);
        }

        /** 冻结/解冻输入区:冷却期间按钮与输入框都不可用(点了也只会再看到同一句)。 */
        function setParseLocked(locked) {
            if (btn) btn.disabled = locked === true;
            if (input) input.disabled = locked === true;
        }

        function stopParseCooldown() {
            if (cooldownTimer !== null && typeof clearInterval === 'function') clearInterval(cooldownTimer);
            cooldownTimer = null;
            cooldownUntil = 0;
            cooldownEl = null;
            setParseLocked(false);
        }

        /** 每秒把倒计时刷一次;到点了就解锁,并明说"可以再试了"。 */
        function tickParseCooldown() {
            const left = Math.max(0, Math.round((cooldownUntil - Date.now()) / 1000));
            if (left <= 0) {
                stopParseCooldown();
                if (result) {
                    const done = document.createElement('p');
                    done.className = 'bili-notice';
                    done.textContent = '暂停结束,可以再试一次解析了(如果还是同样一句,说明这份登录会话仍未恢复,建议先去重新扫码登录)。';
                    result.appendChild(done);
                }
                return;
            }
            if (cooldownEl === null) return;
            cooldownEl.textContent = `已暂停请求,${formatCountdown(left)} 后恢复`;
            // 面板可能已经重画过一遍(元素被换掉):那就在结果区重新挂上
            if (cooldownEl.parentNode !== result) result.appendChild(cooldownEl);
        }

        /**
         * 进入冷却:把代理那边的说明显示出来 + 每秒刷倒计时 + 锁住输入区。
         * @param {number} remainingS 代理给的剩余秒数
         */
        function startParseCooldown(remainingS) {
            const seconds = Number(remainingS);
            cooldownUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 0) * 1000;
            if (cooldownEl === null) {
                cooldownEl = document.createElement('p');
                cooldownEl.className = 'bili-notice';
                result.appendChild(cooldownEl);
            }
            setParseLocked(true);
            tickParseCooldown();
            if (cooldownTimer === null && typeof setInterval === 'function') {
                cooldownTimer = setInterval(tickParseCooldown, 1000);
            }
        }

        /**
         * 解析这条路上所有失败的**唯一**落点(解析按钮、取清晰度都走它)。
         *
         * 三种情形分开:①会话被风控(带倒计时 + 重新登录入口);②没登录(带登录入口);
         * ③其它(原样显示上游那句中文)。分开的理由见各自分支的注释。
         */
        function handleParseFailure(err, notice) {
            const data = (err?.data !== null && typeof err?.data === 'object') ? err.data : null;
            const text = String(err?.message ?? err);
            if (data?.reason === 'session_blocked') {
                message(text, { href: BILI_HOME, text: '打开 Bilidown 界面重新扫码登录' });
                startParseCooldown(data.cooldownRemainingS);
                return;
            }
            if (text.includes('未登录')) {
                message('还没登录 B 站 —— 请在 Bilidown 界面扫码登录一次,再回来解析',
                    { href: BILI_HOME, text: '打开 Bilidown 界面扫码登录' });
                return;
            }
            if (notice) { notice.className = 'bili-notice'; notice.textContent = text; return; }
            message(text);
        }

        /**
         * 挂载时问一次代理"现在是不是在暂停中"(不碰上游)。
         *
         * 为什么必须有这一步:面板切走就卸,本地那份截止时刻跟着没了 ——
         * 不重建的话,用户切回来会看到一个看起来正常的「解析」按钮,
         * 点下去才发现还在冷却(而且那一下本来就不该发)。
         */
        async function syncParseState() {
            try {
                const state = await api('/bilibili/parse-state');
                if (state?.cooling === true) {
                    message(state.messageText || 'B 站风控了当前登录会话,已暂停请求。',
                        { href: BILI_HOME, text: '打开 Bilidown 界面重新扫码登录' });
                    startParseCooldown(state.cooldownRemainingS);
                }
            } catch {
                // 代理没起来/旧版本(没有这个端点):静默跳过 —— 解析那一步自己会报出来
            }
        }

        function duration(sec) {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = Math.floor(sec % 60);
            const mm = String(m).padStart(2, '0');
            const ss = String(s).padStart(2, '0');
            return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
        }

        async function loadQualities(qualSel, dlBtn, notice) {
            // 结果区可能已被下一次解析覆盖,拿不到元素就直接退出
            if (!qualSel || !dlBtn || !page) return;
            qualSel.disabled = true;
            dlBtn.disabled = true;
            if (notice) { notice.className = 'bili-notice'; notice.textContent = ''; }

            try {
                const data = await api('/bilibili/qualities?bvid='
                    + encodeURIComponent(info.bvid) + '&cid=' + page.cid);
                qualSel.innerHTML = '';
                for (const q of data.qualities) {
                    const opt = document.createElement('option');
                    opt.value = String(q.id);       // 提交下载任务时要带上这个 id
                    opt.textContent = q.label;
                    qualSel.appendChild(opt);
                }
                qualSel.disabled = false;
                dlBtn.disabled = false;
            } catch (err) {
                qualSel.innerHTML = '';
                const opt = document.createElement('option');
                opt.textContent = '不可用';
                qualSel.appendChild(opt);
                // 取清晰度也带着会话,所以它同样可能撞上风控 —— 落点与解析按钮同一个
                handleParseFailure(err);
            }
        }

        async function startDownload(dlBtn, qualSel, notice) {
            const quality = Number(qualSel.value);
            if (!quality || !page) return;
            dlBtn.disabled = true;
            setDownloadLabel(dlBtn, '提交中…');
            try {
                const data = await api('/bilibili/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        bvid: info.bvid,
                        cid: page.cid,
                        quality,
                        title: info.title,
                        pagePart: page.part,
                        pageIndex: page.page,
                        pageCount: info.pages.length,
                        owner: info.owner,
                        cover: info.cover,
                    }),
                });
                setDownloadLabel(dlBtn, '已加入队列');
                if (notice) {
                    notice.className = 'bili-notice ok';
                    notice.textContent = `已加入下载队列:${data.title}`
                        + `(清晰度 ${data.quality},${data.size})`;
                }
                // 刚建了任务就**立刻**取一次队列:用户点完就等着看它出现在下面,
                // 不该等下一次轮询(而"下一次"本来要等有进行中的任务才安排)。
                void refreshQueue({ manual: true });
            } catch (err) {
                // 失败时把按钮恢复成可再点一次
                dlBtn.disabled = false;
                setDownloadLabel(dlBtn, '加入下载队列');
                // 这条路也要经过同一个失败落点:加入队列同样会走 getPlayInfo(带会话),
                // 撞上风控时该给的是"重新登录 + 倒计时",不是光一句原因。
                handleParseFailure(err, notice);
            }
        }

        function render(v) {
            result.innerHTML = '';
            const card = document.createElement('div');
            card.className = 'bili-card';

            // 上半:左封面 + 右标题/UP主/时长
            const head = document.createElement('div');
            head.className = 'bili-head';

            // 封面格子一直在:有封面放图,没有(或图没加载成功)放矢量占位图。
            // 不留空档是为了布局稳定 —— 少一个图块会让右边的标题跟着跳。
            head.appendChild(coverBox(v.cover || ''));

            const meta = document.createElement('div');
            meta.className = 'bili-meta';

            const title = document.createElement('p');
            title.className = 'bili-title';
            title.textContent = v.title || '(无标题)';
            meta.appendChild(title);

            const author = document.createElement('p');
            author.className = 'bili-author';
            author.textContent = `UP主:${v.owner || '未知'}`
                + ` · 时长 ${duration(v.duration || 0)}`
                + (v.view ? ` · 播放 ${v.view}` : '')
                + ` · ${v.pages.length} 个分P`;
            meta.appendChild(author);

            const open = document.createElement('a');
            open.className = 'bili-open';
            open.href = `https://www.bilibili.com/video/${v.bvid}`;
            open.target = '_blank';
            open.rel = 'noopener noreferrer';
            open.textContent = '在 B 站打开';
            meta.appendChild(open);

            head.appendChild(meta);
            card.appendChild(head);

            // 下半:分P / 清晰度 / 下载按钮
            const actions = document.createElement('div');
            actions.className = 'bili-actions';

            const dlBtn = document.createElement('button');
            dlBtn.type = 'button';
            dlBtn.className = 'tool-search-btn bili-dl';
            dlBtn.disabled = true;
            // 图标 + 文字分开放:提交中/已加入队列只改 <span>,图标留着
            dlBtn.innerHTML = `${DL_ICON}<span>加入下载队列</span>`;

            const qualSel = document.createElement('select');
            qualSel.className = 'bili-quality';
            qualSel.disabled = true;
            const loading = document.createElement('option');
            loading.textContent = '清晰度加载中…';
            qualSel.appendChild(loading);

            // 单P 视频没什么好选的,直接不显示
            if (v.pages.length > 1) {
                const pageSel = document.createElement('select');
                pageSel.className = 'bili-page';
                v.pages.forEach((p, index) => {
                    const opt = document.createElement('option');
                    opt.value = String(index);      // 用下标,取的时候直接 pages[下标]
                    opt.textContent = `P${p.page} ${p.part || ''}(${duration(p.duration)})`;
                    pageSel.appendChild(opt);
                });
                pageSel.addEventListener('change', () => {
                    page = v.pages[Number(pageSel.value)];
                    loadQualities(qualSel, dlBtn, notice);   // 换分P 要重新取清晰度
                });
                actions.appendChild(pageSel);
            }

            actions.append(qualSel, dlBtn);
            card.appendChild(actions);

            const notice = document.createElement('p');
            notice.className = 'bili-notice';
            card.appendChild(notice);

            dlBtn.addEventListener('click', () => startDownload(dlBtn, qualSel, notice));

            result.appendChild(card);
            // 元素已进 DOM,可以取清晰度了
            loadQualities(qualSel, dlBtn, notice);
        }

        // ---------- 下载队列(方案 A:就在解析按钮下面长出来)----------
        //
        // 数据从本地代理 3302 取(它再转发 Bilidown 8098)—— **不为此新增 IPC 数据通道**:
        // 插件本来就有 fetch,而 CORS 由代理处理。
        //
        // ⚠️ 轮询是这一段里最要紧的东西。代理对高频请求敏感(今天那次风控问题的同源),
        // 所以"该不该轮"必须是一个**算得出来**的决定,而不是散在 setTimeout 里的 if ——
        // 判据在 app/lib/bilibili-queue.js 的 planPoll():队列空 / 没有一个进行中的任务 /
        // 上一次取失败 → 一律**停止轮询**,一个请求都不再发。
        const queueEl = document.createElement('div');
        queueEl.className = 'bili-q';
        queueEl.hidden = true;
        // 机器可读的状态(自检据此断言"空闲不轮询",不去猜中文文案):
        queueEl.dataset.taskCount = '0';
        queueEl.dataset.activeCount = '0';
        queueEl.dataset.polling = 'false';
        queueEl.dataset.pollCount = '0';
        queueEl.dataset.lastCopy = '';
        queueEl.dataset.lastCopyReason = '';
        el.appendChild(queueEl);

        const queueState = {
            tasks: [],
            timer: null,
            inFlight: false,
            failed: false,
            pollCount: 0,
            reason: '',            // 上一次"要不要轮"的理由(排错时一眼可见)
            started: false,
        };

        /** 把状态写进 data-* (自检读它们;人读 reason 走 title)。 */
        function syncQueueDataset() {
            queueEl.dataset.taskCount = String(queueState.tasks.length);
            queueEl.dataset.activeCount = String(summarize(queueState.tasks).active);
            queueEl.dataset.polling = queueState.timer === null ? 'false' : 'true';
            queueEl.dataset.pollCount = String(queueState.pollCount);
        }

        /**
         * 一条任务行的**结构指纹**:只包含会改变行内 DOM 结构的东西。
         *
         * ⚠️ 刻意**不含**百分比/阶段:那两个每次轮询都在变,放进指纹就等于每 1.5 秒
         * 重建一次行 —— 行里的进度条动画(1.6s 一圈)会被不断打回起点,用户看到的
         * 就是"条纹不动 / 每 1.5 秒跳一下"(真机报的那个 bug)。
         * 读数由 patchQueueRow **原地**写。
         */
        function queueRowShape(task) {
            const live = isRunningStatus(task.status);
            const prog = live ? progressOf(task) : { known: false, percent: null, phase: '' };
            const why = (task.status === 'error' && task.error) ? 'err'
                : ((task.status === 'done' && task.fileReason) ? 'reason' : '');
            return [
                String(task.status || ''),
                live ? `live:${prog.known === true ? 'known' : 'unknown'}` : 'idle',
                why,
                task.status === 'done' && Boolean(task.filePath) ? 'copy' : 'nocopy',
            ].join('|');
        }

        /** 行下面那行小字(每次轮询都会变,所以单独一个函数,只改 textContent)。 */
        function queueMeta(task) {
            const live = isRunningStatus(task.status);
            const prog = live ? progressOf(task) : { known: false, percent: null, phase: '' };
            const meta = [];
            meta.push(task.owner || '未知UP');
            meta.push(formatDuration(task.duration));
            if (task.status === 'done') {
                const clock = formatClock(task.createAt);
                if (clock) meta.push(`加入于 ${clock}`);
                if (task.fileName) meta.push(formatBytes(task.fileSize) || '已下载');
                // 同标题多份时如实说明:我们只能按创建时间挑最接近的那一个
                if (task.fileAmbiguous === true) meta.push(`同标题 ${task.fileCandidates} 份,取最接近的一个`);
            } else {
                if (task.speed) meta.push(task.speed);
                // 进度读数:阶段 + 百分比。
                // ⚠️ 阶段名必须写出来 —— `running` 一个状态盖住了"下音频 / 下视频 / 合并"
                // 三件事(实测),不写阶段的话用户不知道这 47% 是哪一段的。
                // 拿不到读数(known=false)时**一个字都不写**,不编一个 0%。
                if (live === true && prog.known === true) {
                    meta.push(`${PROGRESS_PHASE_LABEL[prog.phase] ?? ''} ${prog.percent}%`.trim());
                }
                // 这里曾经还有一条 `else if (Number(task.progress) > 0)`:上游**从来没有**
                // progress 这个字段(实测 11 帧全是 null),那条分支永远不会成立 —— 删掉,
                // 不留一行"看着像在读进度、其实读的是空"的代码。
            }
            return meta.join(' · ');
        }

        /**
         * 建一条任务行(结构照设计稿;类名统一带 bili-q- 前缀,便于自检选中)。
         *
         * 只在**新建**或**结构变了**的时候调它 —— 平时靠 patchQueueRow 原地改。
         * 返回行与要原地改的那几个节点(名字/状态胶囊/按钮区/读数/进度条)。
         */
        function buildQueueRow(task) {
            const row = document.createElement('div');
            row.className = 'bili-q-task';
            row.dataset.taskId = String(task.id ?? '');

            const live = isRunningStatus(task.status);
            const prog = live ? progressOf(task) : { known: false, percent: null, phase: '' };
            let track = null;
            let fill = null;
            if (live) {
                track = document.createElement('div');
                track.className = 'bili-q-prog';
                if (prog.known === true) {
                    // 有真读数才画填充段。宽度来自**实测过语义**的比例(0–1 的三段等权平均,
                    // 见 progressOf):拿不到读数时这一段**不挂上去**,只留那层游走的流光 ——
                    // 一根永远 0% 的条比不画更糟(用户会以为卡死了)。
                    fill = document.createElement('i');
                    fill.style.width = `${prog.percent}%`;
                    fill.appendChild(document.createElement('b'));   // 流光只铺在已完成的那一段
                    track.appendChild(fill);
                }
                row.appendChild(track);              // 绝对定位,不进 grid 流
            }

            // 封面:走代理(与解析结果那张封面同一个理由:B 站图床查 Referer)。
            // 取不到就退化成一个同尺寸的方块,不让布局跳。
            if (task.cover) {
                const img = document.createElement('img');
                img.className = 'bili-q-cover';
                img.src = `${apiBase}/bilibili/proxy?url=${encodeURIComponent(task.cover)}`;
                img.alt = '';
                img.loading = 'lazy';
                img.addEventListener('error', () => {
                    const box = document.createElement('div');
                    box.className = 'bili-q-cover';
                    img.replaceWith(box);
                }, { once: true });
                row.appendChild(img);
            } else {
                const box = document.createElement('div');
                box.className = 'bili-q-cover';
                row.appendChild(box);
            }

            const body = document.createElement('div');
            body.className = 'bili-q-body';

            const line = document.createElement('div');
            line.className = 'bili-q-line';
            const name = document.createElement('span');
            name.className = 'bili-q-name';
            line.appendChild(name);

            // 已完成用勾号图标(状态与操作都挤在右边缘,中文标签会把行撑长);
            // 其余状态用中文胶囊。两者互斥,所以它是**结构**的一部分(见 queueRowShape)。
            let ok = null;
            let chip = null;
            if (task.status === 'done') {
                ok = document.createElement('span');
                ok.className = 'bili-q-ok';
                ok.title = '已完成';
                ok.appendChild(queueIcon(ICON_CHECK));
                line.appendChild(ok);
            } else {
                chip = document.createElement('span');
                line.appendChild(chip);
            }

            const acts = document.createElement('div');
            acts.className = 'bili-q-acts';

            if (task.status === 'done') {
                // 「理解这一段视频」:把**本地文件路径**交给 AI 面板 —— 字节不过 IPC,
                // 由主进程按路径自己读(所以 169.5 MB 这种也能进去理解)。
                // 这里只在页面内派一个 DOM 事件;真正的 IPC 通道是 video:understandPath,
                // 而准入判据在主进程(绝对路径 / 扩展名 / 文件存在 / 路径必须在该下载目录里)。
                const understand = document.createElement('button');
                understand.type = 'button';
                understand.className = 'bili-q-icon bili-q-understand';
                understand.textContent = '理解';
                understand.setAttribute('aria-label', '理解这一段视频');
                understand.title = task.filePath
                    ? '把这一段交给 AI 理解(只看画面、听不到声音;大文件会上传到服务端)'
                    : (task.fileReason || '还没定位到这个任务的文件,没法理解');
                understand.disabled = !task.filePath;
                understand.addEventListener('click', () => requestUnderstand(task));
                acts.appendChild(understand);

                const canCopy = typeof ctx.clipboard?.copyVideo === 'function';
                const copy = document.createElement('button');
                copy.type = 'button';
                copy.className = 'bili-q-icon bili-q-copy';
                copy.setAttribute('aria-label', '复制视频');
                copy.title = canCopy
                    ? '复制视频文件本身(可直接粘到资源管理器 / 微信 / 剪映)'
                    : '这个插件没有申请 clipboard 权限,无法把文件放进剪贴板';
                copy.disabled = !canCopy;
                copy.appendChild(queueIcon(ICON_COPY));
                copy.addEventListener('click', () => copyVideoFile(task, copy));
                acts.appendChild(copy);
            }

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'bili-q-icon bili-q-del';
            del.setAttribute('aria-label', '从队列移除');
            del.title = '从队列移除(不会删掉已下载的文件)';
            del.textContent = '×';
            del.addEventListener('click', () => deleteTask(task, del));
            acts.appendChild(del);

            line.appendChild(acts);
            body.appendChild(line);

            const metaEl = document.createElement('div');
            metaEl.className = 'bili-q-meta';
            body.appendChild(metaEl);

            let whyEl = null;
            if ((task.status === 'error' && task.error) || (task.status === 'done' && task.fileReason)) {
                // 失败的原因 / 定位不到文件的原因:都要说清,不能只留一个灰按钮
                whyEl = document.createElement('div');
                whyEl.className = 'bili-q-meta bili-q-why';
                body.appendChild(whyEl);
            }

            row.appendChild(body);
            return { row, name, chip, metaEl, whyEl, track, fill };
        }

        /**
         * 原地把这行的读数刷进去(**不**重建任何节点)。
         *
         * 这就是"条纹在动"的前提:`.bili-q-prog i b` 这个节点从建出来到下载结束
         * 一直是同一个,动画不会被打断。宽度变化交给 CSS 的 transition。
         */
        function patchQueueRow(task, parts) {
            const live = isRunningStatus(task.status);
            const prog = live ? progressOf(task) : { known: false, percent: null, phase: '' };
            const { row } = parts;
            row.dataset.status = String(task.status || '');
            if (live) row.classList.add('is-live');
            else row.classList.remove('is-live');
            if (prog.phase !== '') row.dataset.phase = prog.phase;
            else delete row.dataset.phase;

            parts.name.textContent = displayTitle(task);
            if (parts.chip !== null) {
                // ⚠️ 类名走 statusClass:上游给的状态是不可信输入,直接拼进 className
                // 时一个 "a b" 就能塞进两个类。
                parts.chip.className = `bili-q-st ${statusClass(task.status)}`;
                // 标签**永远是中文**(statusLabel 的兜底是「处理中」,绝不回退成原始 token)。
                // 原始值放到 title 里:排查时悬停就能看到上游到底给的什么。
                parts.chip.textContent = statusLabel(task.status);
                parts.chip.title = `上游状态:${String(task.status || '(空)')}`;
            }
            parts.metaEl.textContent = queueMeta(task);
            if (parts.whyEl !== null) {
                parts.whyEl.textContent = task.status === 'error' ? `→ ${task.error}` : task.fileReason;
            }
            // 进度填充:有读数就写宽度(transition 会自己补间),没有就不动它
            if (parts.fill !== null && prog.known === true) {
                parts.fill.style.width = `${prog.percent}%`;
            }
        }

        /** 内联矢量图标(勾号/复制):用 currentColor,状态色直接压在 stroke 上。 */
        function queueIcon(pathData) {
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 16 16');
            svg.setAttribute('class', 'ic');
            svg.setAttribute('aria-hidden', 'true');
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', pathData);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', 'currentColor');
            path.setAttribute('stroke-width', '1.6');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(path);
            return svg;
        }

        const noteEl = document.createElement('p');
        noteEl.className = 'bili-q-note';
        noteEl.hidden = true;

        /** 队列区的提示行(空队列 / 取失败 / 上一次复制的结果)。 */
        function queueNote(text, kind = '') {
            queueEl.dataset.noteKind = kind;
            noteEl.className = `bili-q-note${kind ? ` ${kind}` : ''}`;
            noteEl.textContent = text;
            noteEl.hidden = text === '';
        }

        const headEl = document.createElement('div');
        headEl.className = 'bili-q-head';
        const titleEl = document.createElement('span');
        titleEl.className = 'bili-q-title';
        const sumEl = document.createElement('span');
        sumEl.className = 'bili-q-sum';
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn btn-sm bili-q-open';
        openBtn.textContent = '打开文件夹';
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn btn-sm bili-q-retry';
        retryBtn.textContent = '重试';
        retryBtn.hidden = true;
        retryBtn.addEventListener('click', () => { void refreshQueue({ manual: true }); });
        headEl.append(titleEl, sumEl, openBtn, retryBtn);
        queueEl.append(headEl, noteEl);

        const listEl = document.createElement('div');
        listEl.className = 'bili-q-list';
        queueEl.appendChild(listEl);

        // 行缓存:taskId → { parts, shape }。**按 id 复用行**,只在结构变了才重建。
        // 为什么要缓存:原来每次轮询都 `replaceChildren(...tasks.map(queueRow))`,
        // 每 1.5 秒把所有行连同里面的进度条一起重建 —— CSS 动画(1.6s 一圈)每 1.5 秒
        // 被打回起点,用户看到的就是"条纹不动 / 每 1.5 秒跳一下"(真机报的那个 bug)。
        const rowCache = new Map();

        function renderQueue() {
            const tasks = sortTasks(queueState.tasks);
            const stat = summarize(tasks);
            titleEl.textContent = `下载队列 (${stat.total})`;
            sumEl.textContent = `已完成 ${stat.done}`
                + (stat.active > 0 ? ` · 进行中 ${stat.active}` : '')
                + (stat.failed > 0 ? ` · 失败 ${stat.failed}` : '');
            openBtn.disabled = tasks.length === 0;
            openBtn.title = tasks.length === 0 ? '队列是空的' : '在系统里打开下载目录';
            retryBtn.hidden = queueState.failed !== true;

            // ① 逐条:复用行 / 结构变了才重建 / 读数原地刷
            const wanted = [];
            const live = new Set();
            for (const task of tasks) {
                const id = String(task.id ?? '');
                live.add(id);
                let entry = rowCache.get(id);
                if (entry === undefined) {
                    entry = { parts: null, shape: '' };
                    rowCache.set(id, entry);
                }
                const shape = queueRowShape(task);
                if (entry.parts === null || entry.shape !== shape) {
                    const parts = buildQueueRow(task);
                    if (entry.parts !== null) listEl.replaceChild(parts.row, entry.parts.row);
                    else listEl.appendChild(parts.row);
                    entry.parts = parts;
                    entry.shape = shape;
                }
                patchQueueRow(task, entry.parts);
                wanted.push(entry.parts.row);
            }
            // ② 已经不在队列里的行:摘掉
            for (const [id, entry] of [...rowCache]) {
                if (live.has(id)) continue;
                entry.parts?.row.remove?.();
                rowCache.delete(id);
            }
            // ③ 顺序:只移动**位置不对**的那些节点。
            // 为什么不能直接 replaceChildren(...wanted):那会把每一行都重新插一遍,
            // 而"重新插入"会让它的 CSS 动画从头开始 —— 正是要避免的事。
            let cursor = listEl.firstChild;
            for (const row of wanted) {
                if (cursor === row) { cursor = cursor.nextSibling; continue; }
                listEl.insertBefore(row, cursor);
            }
            while (cursor !== null) {
                const next = cursor.nextSibling;
                cursor.remove?.();
                cursor = next;
            }

            queueEl.hidden = tasks.length === 0 && queueState.failed !== true;
            syncQueueDataset();
        }

        async function refreshQueue({ manual = false } = {}) {
            if (queueState.inFlight) return;
            queueState.inFlight = true;
            queueState.pollCount += 1;
            syncQueueDataset();
            try {
                const data = await api('/bilibili/tasks');
                queueState.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
                queueState.failed = false;
                queueState.reason = '';
                queueNote('');
                renderQueue();
            } catch (err) {
                // 取不到就把原因说出来 + 给「重试」,而不是安静地什么都不显示
                queueState.failed = true;
                queueState.tasks = [];
                queueState.reason = err.message;
                renderQueue();       // failed=true 时队列区会保持可见
                queueNote(`取下载队列失败:${err.message}`, 'error');
            } finally {
                queueState.inFlight = false;
                // ⚠️ 轮询的唯一决策点(纯函数,单测钉着)
                const plan = planPoll({
                    tasks: queueState.failed ? null : queueState.tasks,
                    failed: queueState.failed,
                    activeMs: POLL_ACTIVE_MS,
                });
                queueState.reason = plan.reason;
                queueEl.dataset.pollReason = plan.reason;
                if (queueState.timer !== null) {
                    clearTimeout(queueState.timer);
                    queueState.timer = null;
                }
                if (plan.poll === true) {
                    queueState.timer = setTimeout(() => {
                        queueState.timer = null;
                        void refreshQueue();
                    }, plan.delayMs);
                }
                syncQueueDataset();
            }
        }

        /**
         * 请 AI 面板理解这一段(本地文件走路径,不过 IPC 传字节)。
         *
         * 为什么用 DOM 事件:这是**同一个页面内**两块面板的协作(插件面板 → AI 面板),
         * 而事件里只有叶子字段(路径/目录/名字/大小);准入判据在主进程侧。
         * 壳里本来就有同类先例(kaiwu:shell-ready)。
         */
        function requestUnderstand(task) {
            const payload = {
                path: String(task.filePath || ''),
                folder: String(task.folder || ''),
                name: String(task.fileName || task.title || ''),
                size: Number(task.fileSize) || 0,
            };
            if (payload.path === '') {
                queueNote('这个任务还没定位到文件,没法理解(见卡片上的说明)', 'error');
                return;
            }
            queueNote(`已把「${task.title || payload.name}」交给 AI 面板理解:`
                + '它只在右侧对话里回答,而且只看画面、听不到声音。', 'ok');
            document.dispatchEvent(new CustomEvent('kaiwu:understand-video', { detail: payload }));
        }

        /** 「复制视频」:只递 taskId —— 路径由主进程自己去代理那边解析与核对。 */
        async function copyVideoFile(task, btn) {
            btn.disabled = true;
            queueEl.dataset.lastCopy = '';
            queueEl.dataset.lastCopyReason = '';
            try {
                const result = await ctx.clipboard.copyVideo(task.id);
                if (result?.ok === true) {
                    queueEl.dataset.lastCopy = 'ok';
                    btn.classList.add('done-flash');
                    queueNote(`已把文件放进剪贴板:${result.fileName || task.fileName || ''}`
                        + (result.skipped === true ? '(自检模式:没有真去写剪贴板)' : ''), 'ok');
                    setTimeout(() => btn.classList.remove('done-flash'), 1600);
                } else {
                    queueEl.dataset.lastCopy = 'failed';
                    queueEl.dataset.lastCopyReason = String(result?.reason ?? '');
                    queueNote(String(result?.reason ?? '复制失败(没有给出原因)'), 'error');
                }
            } catch (err) {
                queueEl.dataset.lastCopy = 'failed';
                queueEl.dataset.lastCopyReason = String(err?.message ?? err);
                queueNote(`复制失败:${String(err?.message ?? err)}`, 'error');
            } finally {
                btn.disabled = false;
            }
        }

        /** 「从队列移除」:只删队列记录,不动磁盘上的文件。 */
        async function deleteTask(task, btn) {
            btn.disabled = true;
            try {
                await api(`/bilibili/tasks/delete?id=${encodeURIComponent(task.id)}`);
                await refreshQueue({ manual: true });
            } catch (err) {
                queueNote(`移除失败:${err.message}`, 'error');
                btn.disabled = false;
            }
        }

        openBtn.addEventListener('click', async () => {
            const first = sortTasks(queueState.tasks)[0];
            if (!first) return;
            try {
                await api(`/bilibili/tasks/show?taskId=${encodeURIComponent(first.id)}`);
            } catch (err) {
                queueNote(`打开文件夹失败:${err.message}`, 'error');
            }
        });

        // 服务从"没起来"变成"运行中"时自动再取一次:那张取失败的卡片不该等用户自己去点重试。
        const offService = ctx.services?.on?.(SERVICE_ID, 'change', (state) => {
            if (state?.status === 'running' && queueState.failed === true) {
                void refreshQueue({ manual: true });
            }
        });

        // 首次取队列 + 解析冷却状态 + 代理地址覆盖。
        // ⚠️ 顺序要紧:**先**把代理地址定下来,再做那两件要打接口的事。
        // (踩过一次:syncParseState 原来是独立的一次 `void syncParseState()`,
        //  它会在 apiBase 还是默认 3302 的时候就发出去 —— 真机上自定了端口就会打到
        //  一个不该打的地址,自检里则打到用户真实的 3302。)
        // ⚠️ 立即取一次是刻意的:面板一露面就该看到队列(用户上次的下载还在),
        // 而**之后**轮不轮完全由 planPoll 决定 —— 空闲时一个请求都不再发。
        void (async () => {
            if (typeof ctx.settings?.get === 'function') {
                try {
                    const configured = await ctx.settings.get('apiBase', '');
                    if (typeof configured === 'string' && configured.trim() !== '') {
                        apiBase = configured.trim().replace(/\/+$/, '');
                    }
                } catch { /* 读不到就用默认的 3302 */ }
            }
            // 面板切走就卸,本地那份冷却截止时刻跟着没了 —— 挂载时问一次代理重建它
            // (这个端点**不碰上游**,所以它不需要冷却自己)
            await syncParseState();
            await refreshQueue();
        })();

        // 面板卸载时**必须**停掉定时器:插件被切走之后还在后台打接口,
        // 既是无意义的负载,也会让"空闲就安静"这条承诺失效。
        this.queueDispose = () => {
            if (queueState.timer !== null) clearTimeout(queueState.timer);
            queueState.timer = null;
            queueState.stopped = true;
            syncQueueDataset();
            if (typeof offService === 'function') offService();
        };
        // 冷却倒计时的定时器同理:**不**停掉的话,切走的面板还会每秒跑一次 tick
        // (改一个已经不在页面上的节点)。顺着 teardown 一起收。
        this.cooldownDispose = () => {
            if (cooldownTimer !== null && typeof clearInterval === 'function') clearInterval(cooldownTimer);
            cooldownTimer = null;
            cooldownEl = null;
        };

        async function parse() {
            const text = input.value.trim();
            if (text === '') return;

            btn.disabled = true;
            message('解析中,需要回源 B 站,可能要几秒…');
            try {
                const v = await api('/bilibili/info?text=' + encodeURIComponent(text));
                info = v;
                page = v.pages[0] || null;          // 默认选中第一个分P
                render(v);
            } catch (err) {
                // 三种失败各走各的(会话被风控 / 没登录 / 其它),落点只有一个
                handleParseFailure(err);
            } finally {
                btn.disabled = false;
            }
        }

        btn.addEventListener('click', parse);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') parse();
        });
    },

    teardown() {
        this.badge?.dispose();
        this.badge = null;
        // 队列的定时器与订阅必须跟着面板一起走(理由见 setup 里那段);
        // 冷却倒计时的定时器同理 —— 面板没了还留一个每秒跑的 interval 就是泄漏。
        this.queueDispose?.();
        this.queueDispose = null;
        this.cooldownDispose?.();
        this.cooldownDispose = null;
    },
};
