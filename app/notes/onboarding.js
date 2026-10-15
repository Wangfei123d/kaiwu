// 首启向导与「更换笔记库」。设计文档 §4.6。
//
// 三态,不是一个布尔:
//   未配置      → 引导用户选一个
//   配置但失效  → **明确告知上次的库找不到了**,而不是当成空库新建
//                 (那会让用户以为笔记丢了 —— 这是本模块存在的主要理由)
//   配置且可用  → 不需要向导

const SKIP_KEY = 'kaiwu.onboarding.skipped';

// 诊断埋点。向导的可见性变化是这次排查的核心,所以每一次变化都记下来 ——
// 只在代码里读顺序已经骗过我一次了(日志证明点击其实生效了,
// 但界面上看到的还是向导)。需要真实的时间线。
let traceFn = null;
function setTrace(fn) { traceFn = fn; }
function t(message) {
    try { traceFn?.(message); } catch { /* 诊断不能影响主流程 */ }
}

export function createOnboarding({ el, bridge, onVaultReady, log = console }) {
    const lead = el.querySelector('#onboardingLead');
    const note = el.querySelector('#onboardingNote');
    const pathBox = el.querySelector('#onboardingPath');
    const chooseBtn = el.querySelector('#onboardingChoose');
    const skipBtn = el.querySelector('#onboardingSkip');

    let skipped = false;
    try {
        skipped = window.localStorage.getItem(SKIP_KEY) === '1';
    } catch { /* localStorage 不可用时当作没跳过 */ }

    // 用户是否已经走过向导(自己选了库、或按了跳过)。
    // 存在的理由是一个真实竞态:向导按钮在 HTML 里一开始就存在,而外壳在
    // 「查笔记库状态」那次 await 上是挂起的 —— 用户完全可能在那之前就点了按钮。
    // 若此时再把**过期的**状态喂给 apply(),就会把已经进去的界面又盖回向导。
    let settled = false;

    function show(why) {
        el.hidden = false;
        t(`show(${why}) → hidden=false 计算样式=${computedDisplay()}`);
    }
    function hide(why) {
        el.hidden = true;
        const d = computedDisplay();
        // 只在真的没藏住时才警告。这正是那个真实 bug:`.onboarding{display:flex}`
        // 压过了 UA 的 [hidden]{display:none},于是 el.hidden 设了也没用 ——
        // 日志说"已隐藏",界面照旧显示向导,排查时极易误判成时序问题。
        if (d !== 'none') {
            t(`⚠ hide(${why}) 后计算样式仍是 ${d} —— hidden 被 CSS 覆盖了!`);
            log?.error?.('[notes] 向导的 hidden 被 CSS 覆盖,界面不会真的隐藏');
        } else {
            t(`hide(${why}) → hidden=true 计算样式=none(确实隐藏)`);
        }
    }

    /** 读回真实的计算样式 —— 光看 el.hidden 会被 CSS 骗。 */
    function computedDisplay() {
        try {
            return window.getComputedStyle(el).display;
        } catch {
            return '(取不到)';
        }
    }

    function renderInvalid(status) {
        lead.textContent = `${status.reason}:`;
        pathBox.hidden = false;
        pathBox.textContent = status.path ?? '';
        note.textContent = '它可能被删掉、被移走,或者外接盘没插上。'
            + '重新选一个文件夹即可 —— 原来的笔记不会被改动。';
        chooseBtn.textContent = '重新选择文件夹';
    }

    function renderFresh() {
        lead.textContent = '先选一个文件夹当你的笔记库。';
        pathBox.hidden = true;
        // 说明文字也要一起复位。早先这里漏了 note,导致上一次选择的
        // 「发现 N 篇笔记」残留在界面上,看起来像是选完了却没反应。
        note.textContent = '笔记就是普通的 .md 文件,放在你自己选的目录里 ——'
            + '用别的编辑器能打开,能用 git 管,也能随时整个拷走。';
        chooseBtn.textContent = '选择文件夹';
    }

    async function choose() {
        chooseBtn.disabled = true;
        try {
            const r = await bridge.invoke('notes:vault:choose', {});
            if (r.canceled) return;
            if (!r.ok) {
                renderInvalid(r.status);
                return;
            }

            const s = r.status;
            // 先把该做的状态变更做完,再动文案 ——
            // 文案是给用户看的"结果",不该在结果还没落地时就先显示出来。
            skipped = false;
            settled = true;
            t(`choose:对话框返回 ok=true noteCount=${r.noteCount}`);
            try { window.localStorage.removeItem(SKIP_KEY); } catch { /* 忽略 */ }
            hide('choose:成功');

            const count = r.noteCount;
            try {
                await onVaultReady(s);
                t('choose:onVaultReady 成功');
            } catch (err) {
                // 进来之后失败了,也不该把用户困在按钮已经禁用的向导里
                t(`choose:onVaultReady 抛错 ${err.message}`);
                log?.error?.('[notes] 进入笔记库失败', err);
                lead.textContent = `打开了笔记库,但载入失败:${err.message}`;
                note.textContent = '可以再选一次,或者换一个文件夹。';
                show('choose:onVaultReady 失败');
                return;
            }

            // 成功之后再报"发现 N 篇笔记"(此时界面已经切走,这条文案只会在
            // 用户下次点「更换」时看到)
            note.textContent = count > 0
                ? `发现 ${count} 篇笔记,将作为笔记库打开。`
                : '这是个空文件夹,将在这里新建笔记库。';
            log?.info?.(`[notes] 选定笔记库:${s.path}(已有 ${count} 篇)`);
        } catch (err) {
            log?.error?.('[notes] 选择笔记库失败', err);
            lead.textContent = `选择失败:${err.message}`;
        } finally {
            chooseBtn.disabled = false;
        }
    }

    chooseBtn.addEventListener('click', choose);
    skipBtn.addEventListener('click', () => {
        skipped = true;
        settled = true;
        try { window.localStorage.setItem(SKIP_KEY, '1'); } catch { /* 忽略 */ }
        hide('skip');
        onVaultReady(null);
    });

    return {
        /** 接上诊断输出(由 app/main.js 注入,写进启动日志)。 */
        setTrace,
        /**
         * 决定是否要显示向导。
         * @param {{configured:boolean, ok:boolean, path:string|null, reason:string|null}} status
         * @returns {boolean} 是否显示了向导
         */
        apply(status) {
            // 用户已经走过向导就别再拿过期状态盖回来 —— 见上面 settled 的说明。
            if (settled) { t('apply:已 settled,跳过'); return false; }

            if (status.configured && status.ok) { hide('apply:库可用'); return false; }

            // 配置过但失效 —— 无论之前是否跳过,都要再问一次:
            // 用户需要知道"我的笔记去哪了",这比不打扰更重要。
            if (status.configured && !status.ok) {
                settled = true;
                renderInvalid(status);
                show('apply:库失效');
                return true;
            }

            // 从没配置过:尊重此前的"跳过"
            if (skipped) { hide('apply:曾跳过'); return false; }
            renderFresh();
            show('apply:未配置');
            return true;
        },
        /** 用户从顶栏点「更换」 */
        open() {
            t('open:更换按钮被点击');
            settled = false;
            renderFresh();
            show('open:更换');
        },
        hide: () => hide('外部调用'),
    };
}
