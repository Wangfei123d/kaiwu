// 「设置」视图(设计稿 docs/kaiwu-settings-page-demo.html 的**方案 D**:左导航 + 搜索 + 表单)。
//
// 三条立场(决定这个文件为什么这么写):
//   ① **不另写一套通道**:每一项都接到已有的那一条(视频模型/密钥/凭证/布局/库路径/索引);
//      这个模块只负责"读出来画上、写回去",判据全在 app/lib/settings-page.js 里(有单测)。
//   ② **绝不回显密钥**:密钥那一项与 AI 面板密钥卡走同一个通道,输入框永远是空的、
//      状态只显示 `{ ok, source, reason }` 三个叶子字段;看不见的值不画、也不留在 DOM 里。
//   ③ **改了要重启才生效的项必须写明**:服务根目录与 DSH_HOME 都是"下次启动才读"的值,
//      界面上当场写出 RESTART_NOTICE,不让用户以为立刻生效。
//
// 渲染只用 createElement / textContent(绝不用 innerHTML),事件用 addEventListener。

import {
    RESTART_NOTICE, SETTINGS_KEYS, SETTINGS_NS, SETTINGS_SECTIONS,
    badgeCounts, describeAgentProcess, emptySearchText, filterSettings, itemCount,
    motionOffFromSetting, motionSettingFromToggle, savePathResultText, validatePathSetting,
} from '../lib/settings-page.js';
import { describeVideoKeyStatus } from '../lib/agent-video.js';

/** 小工具:建元素(textContent 赋值,永不 innerHTML)。 */
function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

/**
 * @param {object} deps
 * @param {object} deps.doc / deps.win 注入(单测给替身)
 * @param {object} deps.els 骨架里的几个节点(searchEl / navEl / bodyEl / overviewEl)
 * @param {object} deps.bridge IPC 通道(只走既有的那些)
 * @param {() => object|null} [deps.getIndex] 笔记索引(索引状态那一项读它,不另建一份)
 * @param {() => string} [deps.getVaultPath] 当前库路径(顶栏那份读数)
 * @param {() => string} [deps.getLayoutText] 当前布局树文本(工作台那份读数)
 * @param {() => void} [deps.onResetLayout] 「重置布局」—— 复用工作台那个按钮的能力
 * @param {() => void} [deps.onChangeVault] 「更换」—— 复用顶栏那个按钮的能力
 * @param {(off:boolean)=>void} [deps.onMotionChange] 动效开关翻转(外壳负责落盘 + 通知星空)
 */
export function createSettingsView({
    doc = globalThis.document,
    win = globalThis.window,
    els = {},
    bridge,
    getIndex = () => null,
    getVaultPath = () => '',
    getLayoutText = () => '',
    onResetLayout = () => {},
    onChangeVault = () => {},
    onMotionChange = () => {},
    log = console,
} = {}) {
    const state = {
        section: SETTINGS_SECTIONS[0].id,
        query: '',
        motionOff: false,
        video: null,          // video:status 的叶子字段(绝不含密钥值)
        image: null,          // 图片密钥状态(绝不含密钥值)
        credential: null,     // agent:credentials 的叶子字段
        agent: null,          // agent:status 的叶子字段(「停止 Agent 进程」那行的读数)
        paths: { dshHome: '', serviceRoot: '' },
        mounted: false,
    };
    let navButtons = new Map();
    let disposers = [];

    function on(target, type, fn) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, fn);
        disposers.push(() => target.removeEventListener(type, fn));
    }

    const invoke = async (channel, payload) => {
        try {
            return await bridge.invoke(channel, payload ?? {});
        } catch (err) {
            log.warn?.(`[settings] ${channel} 失败`, err);
            return null;
        }
    };

    /**
     * 把反馈写在**当前那个**节点上。
     *
     * ⚠️ 为什么不能直接改闭包里的 `note`:这些处理器都是 `await → renderBody() → 写反馈`,
     * 而 renderBody 会把整块 DOM 重建 —— 闭包里那个 note 已经**脱离文档**了,写上去
     * 屏幕上什么都不变(用户点保存、按钮闪一下、然后没有任何回话)。
     * 所以按 id 把新的那一个找回来再写。
     */
    function setNote(id, text, ok) {
        const node = typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
        if (node === null) return;
        node.textContent = String(text ?? '');
        node.dataset.state = ok === true ? 'ok' : 'bad';
    }

    // ---------------- 读数 ----------------

    /** 一次把"只读读数"全读回来:视频状态(含当前模型)、凭证状态、两个路径、动效开关。 */
    async function loadReadings() {
        const [video, image, credential, agent, dshHome, serviceRoot, motion] = await Promise.all([
            invoke('video:status'),
            invoke('drama:image:status'),
            invoke('agent:credentials'),
            invoke('agent:status'),
            invoke('kaiwu:settings:get', { pluginId: SETTINGS_NS, key: SETTINGS_KEYS.dshHome }),
            invoke('kaiwu:settings:get', { pluginId: SETTINGS_NS, key: SETTINGS_KEYS.serviceRoot }),
            invoke('kaiwu:settings:get', { pluginId: SETTINGS_NS, key: SETTINGS_KEYS.motion }),
        ]);
        state.video = (video !== null && typeof video === 'object') ? video : null;
        state.image = (image !== null && typeof image === 'object') ? image : null;
        state.credential = (credential !== null && typeof credential === 'object') ? credential : null;
        state.agent = (agent !== null && typeof agent === 'object') ? agent : null;
        state.paths.dshHome = typeof dshHome === 'string' ? dshHome : '';
        state.paths.serviceRoot = typeof serviceRoot === 'string' ? serviceRoot : '';
        state.motionOff = motionOffFromSetting(motion);
        return state;
    }

    // ---------------- 文案(每一项的"右半边") ----------------

    function videoModelText() {
        const v = state.video;
        if (v === null) return '读不到(video:status 没回话)';
        const list = Array.isArray(v.models) ? v.models : [];
        const hit = list.find((m) => m.id === v.model);
        if (!hit) return String(v.model ?? '—');
        // 模型清单里的 label 已经带上了 id(例如「qwen3-vl-flash(便宜、快)」),
        // 别把 id 再拼一遍 —— 读起来像两件事。
        return String(hit.label).includes(String(hit.id)) ? String(hit.label) : `${hit.label}(${hit.id})`;
    }

    function credentialText() {
        const c = state.credential;
        if (c === null) return '读不到(agent:credentials 没回话)';
        if (c.ok === true) return `已配置${c.source ? `(${c.source})` : ''}`;
        return `未配置${c.reason ? ` —— ${c.reason}` : ''}`;
    }

    /**
     * 「DashScope 密钥」那一行的状态/警告/后果三句。
     *
     * ⚠️ 这三句原来只有 AI 面板那张密钥卡上有;那张卡的**按钮入口**按用户要求删掉之后,
     * 人工入口只剩设置页 —— 于是"环境变量优先,在这里保存不会生效"这类话必须也搬到这里,
     * 否则它就成了一句永远没人看得到的提示(正是这次改动最容易丢掉的信息)。
     * 文案由纯函数 describeVideoKeyStatus 出(单测逐字钉着),这里只负责摆上去。
     */
    function videoKeyText() {
        const d = describeVideoKeyStatus(state.video ?? {});
        const storage = d.storageLabel === '' ? '' : `,${d.storageLabel}`;
        return { status: `密钥:${d.label}${storage}`, warning: d.warning, detail: d.detail };
    }

    function indexText() {
        const idx = getIndex();
        const n = Array.isArray(idx?.notes) ? idx.notes.length : null;
        if (n === null) return '索引还没载入';
        return `已载入 ${n} 篇`;
    }

    function vaultText() {
        const p = String(getVaultPath() ?? '');
        return p === '' ? '未选择笔记库' : p;
    }

    // ---------------- 渲染 ----------------

    function sectionById(id) {
        return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0];
    }

    /** 左导航(分区)。 */
    function renderNav() {
        const nav = els.navEl;
        if (!nav) return;
        nav.replaceChildren();
        navButtons = new Map();
        for (const sec of SETTINGS_SECTIONS) {
            const b = el(doc, 'button', 'settings-nav-btn', sec.name);
            b.type = 'button';
            b.dataset.section = sec.id;
            b.setAttribute('aria-selected', String(sec.id === state.section));
            on(b, 'click', () => {
                state.section = sec.id;
                state.query = '';
                if (els.searchEl) els.searchEl.value = '';
                renderNav();
                renderBody();
            });
            navButtons.set(sec.id, b);
            nav.appendChild(b);
        }
    }

    /** 顶部那行总览:分区数 / 项目数 / 徽标分布。 */
    function renderOverview() {
        if (!els.overviewEl) return;
        const counts = badgeCounts();
        els.overviewEl.textContent = `${SETTINGS_SECTIONS.length} 个分区 · ${itemCount()} 项 · `
            + `已有通道 ${counts.has} · 需要新做 ${counts.isNew}`;
    }

    /** 一项右侧的控件。 */
    function renderControl(item) {
        const box = el(doc, 'div', 'settings-ctrl');
        if (item.ctrl === 'image-secret') {
            const input = el(doc, 'input', 'settings-input');
            input.type = 'password';
            input.id = 'settingsImageKey';
            input.placeholder = 'sk-…(不回显)';
            input.setAttribute('aria-label', 'APINebula 图片服务密钥(不回显)');
            const save = el(doc, 'button', 'btn btn-sm btn-primary', '保存');
            save.type = 'button';
            save.id = 'settingsImageKeySave';
            const clear = el(doc, 'button', 'btn btn-sm', '清除');
            clear.type = 'button';
            clear.id = 'settingsImageKeyClear';
            const note = el(doc, 'span', 'settings-note', '');
            note.id = 'settingsImageKeyNote';
            const status = el(doc, 'span', 'settings-note', '');
            status.id = 'settingsImageKeyStatus';
            status.textContent = state.image?.ok === true
                ? `已配置 · ${state.image.model ?? 'gpt-image-2.5'} · ${state.image.storage ?? '本机'}`
                : `未配置${state.image?.reason ? ` · ${state.image.reason}` : ''}`;
            on(save, 'click', async () => {
                const value = String(input.value ?? '').trim();
                if (value === '') { setNote(note.id, '请先输入图片密钥', false); return; }
                const pending = invoke('drama:image:key:set', { key: value });
                input.value = '';
                const result = await pending;
                await loadReadings();
                renderBody();
                setNote(note.id, result?.ok === true ? '已保存(密钥不回显)' : `保存失败:${result?.reason ?? '通道无响应'}`,
                    result?.ok === true);
            });
            on(clear, 'click', async () => {
                input.value = '';
                const result = await invoke('drama:image:key:clear');
                await loadReadings();
                renderBody();
                setNote(note.id, result?.ok === true ? '已清除本机密钥' : `清除失败:${result?.reason ?? '通道无响应'}`,
                    result?.ok === true);
            });
            box.append(input, save, clear, note, status);
            return box;
        }
        if (item.ctrl === 'secret') {
            // ⚠️ 输入框**永远为空**:密钥不回显(与 AI 面板那张卡同一条纪律)。
            const input = el(doc, 'input', 'settings-input');
            input.type = 'password';
            input.id = 'settingsVideoKey';
            input.placeholder = 'sk-…(不回显)';
            input.setAttribute('aria-label', 'DashScope 密钥(不回显)');
            const save = el(doc, 'button', 'btn btn-sm btn-primary', '保存');
            save.type = 'button';
            save.id = 'settingsVideoKeySave';
            const clear = el(doc, 'button', 'btn btn-sm', '清除');
            clear.type = 'button';
            clear.id = 'settingsVideoKeyClear';
            const note = el(doc, 'span', 'settings-note', '');
            note.id = 'settingsVideoKeyNote';
            const finish = (text, ok) => {
                note.textContent = text;
                note.dataset.state = ok === true ? 'ok' : 'bad';
                input.value = '';                    // 无论成败都不留值在 DOM 里
            };
            on(save, 'click', async () => {
                const value = String(input.value ?? '').trim();
                if (value === '') { finish('先填一把密钥再保存', false); return; }
                const r = await invoke('video:key:set', { key: value });
                // ⚠️ 先清空**当前那个**输入框(renderBody 之前):明文不该在 DOM 里多留一帧
                input.value = '';
                await loadReadings();
                renderBody();
                setNote(note.id,
                    r?.ok === true ? '已保存(密文/明文由系统决定,不进日志)' : `保存失败:${r?.reason ?? '通道没回话'}`,
                    r?.ok === true);
            });
            on(clear, 'click', async () => {
                const r = await invoke('video:key:clear');
                input.value = '';
                await loadReadings();
                renderBody();
                setNote(note.id, r?.ok === true ? '已清除' : `清除失败:${r?.reason ?? '通道没回话'}`, r?.ok === true);
            });
            // 状态 + 警告 + 后果:原来在 AI 面板那张卡上,现在这里是唯一的人工入口
            const keys = videoKeyText();
            const status = el(doc, 'span', 'settings-note', keys.status);
            status.id = 'settingsVideoKeyStatus';
            const warn = el(doc, 'span', 'settings-warn', keys.warning);
            warn.id = 'settingsVideoKeyWarn';
            warn.hidden = keys.warning === '';
            const detail = el(doc, 'span', 'settings-note', keys.detail);
            detail.id = 'settingsVideoKeyDetail';
            detail.hidden = keys.detail === '';
            box.append(input, save, clear, note, status, warn, detail);
            return box;
        }
        if (item.ctrl === 'kill') {
            // 「停止 Agent 进程」:从输入卡片那一行搬来的**常驻入口**(那一行的按钮改成
            // 出事才出现,所以这里必须有一个"永远找得到"的地方)。
            // 读数来自 agent:status,按钮的可用性由纯函数 describeAgentProcess 判 ——
            // 进程已经不在了就别让用户按一个没有意义的按钮。
            const info = describeAgentProcess(state.agent);
            const line = el(doc, 'div', 'settings-stat');
            const dot = el(doc, 'span', 'settings-dot');
            dot.dataset.state = info.state === 'ready' ? 'ok' : 'bad';
            const value = el(doc, 'span', null,
                `Agent:${info.label}${info.detail === '' ? '' : `(${info.detail})`}`);
            value.id = 'settingsAgentState';
            line.append(dot, value);
            const btn = el(doc, 'button', 'btn btn-sm', '停止进程');
            btn.type = 'button';
            btn.id = 'settingsAgentKill';
            btn.disabled = info.canStop !== true;
            const note = el(doc, 'span', 'settings-note', '');
            note.id = 'settingsAgentKillNote';
            on(btn, 'click', async () => {
                const r = await invoke('agent:stop');
                await loadReadings();
                renderBody();
                // ⚠️ 停掉之后**必须**说清下一步按哪儿:面板上「发送」会变灰,
                // 而「重试」只有在提示卡里才出现(见 panel.js 的 killProcess / onEvent)。
                const after = describeAgentProcess(state.agent);
                const ok = r === null ? false : (r?.ok === false ? false : true);
                setNote(note.id,
                    ok
                        ? `已停止(现在是:${after.label})—— 回对话面板点「重试」再连`
                        : '没停成(通道没回话或报错),再试一次',
                    ok);
            });
            box.append(line, btn, note);
            return box;
        }
        if (item.ctrl === 'status') {
            const text = item.id === 'credential' ? credentialText() : '';
            const ok = item.id === 'credential' ? state.credential?.ok === true : false;
            const line = el(doc, 'div', 'settings-stat');
            const dot = el(doc, 'span', 'settings-dot');
            dot.dataset.state = ok === true ? 'ok' : 'bad';
            const value = el(doc, 'span', null, text);
            value.id = `settingsValue-${item.id}`;
            line.append(dot, value);
            box.appendChild(line);
            return box;
        }
        if (item.ctrl === 'layout') {
            const btn = el(doc, 'button', 'btn btn-sm', '重置布局');
            btn.type = 'button';
            btn.id = 'settingsLayoutReset';
            on(btn, 'click', () => { onResetLayout(); renderBody(); });
            const tree = el(doc, 'span', 'settings-mono', String(getLayoutText() ?? ''));
            tree.id = 'settingsLayoutTree';
            tree.title = String(getLayoutText() ?? '');
            box.append(btn, tree);
            return box;
        }
        if (item.ctrl === 'toggle') {
            const label = el(doc, 'label', 'settings-switch');
            const input = el(doc, 'input');
            input.type = 'checkbox';
            input.id = 'settingsMotionOff';
            input.checked = state.motionOff === true;
            input.setAttribute('aria-label', '减少动态效果(强制关)');
            const track = el(doc, 'i');
            label.append(input, track);
            on(input, 'change', async () => {
                const off = input.checked === true;
                state.motionOff = off;
                const wrote = await invoke('kaiwu:settings:set', {
                    pluginId: SETTINGS_NS, key: SETTINGS_KEYS.motion, value: motionSettingFromToggle(off),
                });
                onMotionChange(off);
                const note = box.querySelector?.('.settings-note');
                if (note) note.textContent = wrote === null ? '没写进设置(通道出错)' : (off ? '已强制关掉动效' : '已恢复跟随系统');
            });
            const note = el(doc, 'span', 'settings-note', state.motionOff === true ? '已强制关掉动效' : '跟随系统');
            note.id = 'settingsMotionNote';
            box.append(label, note);
            return box;
        }
        if (item.ctrl === 'path') {
            const input = el(doc, 'input', 'settings-input');
            input.type = 'text';
            input.id = `settingsPath-${item.id}`;
            input.value = state.paths[item.id] ?? '';
            input.placeholder = '留空 = 用默认';
            input.setAttribute('aria-label', item.title);
            const save = el(doc, 'button', 'btn btn-sm btn-primary', '保存');
            save.type = 'button';
            save.id = `settingsPathSave-${item.id}`;
            const note = el(doc, 'span', 'settings-note', item.restart === true ? RESTART_NOTICE : '');
            note.id = `settingsPathNote-${item.id}`;
            note.dataset.restart = String(item.restart === true);
            on(save, 'click', async () => {
                const verdict = validatePathSetting(input.value);
                if (verdict.ok !== true) {
                    note.dataset.state = 'bad';
                    note.textContent = verdict.reason;
                    return;                          // 非法值**不写**存档
                }
                const wrote = await invoke('kaiwu:settings:set', {
                    pluginId: SETTINGS_NS, key: SETTINGS_KEYS[item.id], value: verdict.value,
                });
                state.paths[item.id] = verdict.value;
                input.value = verdict.value;
                note.dataset.state = wrote === null ? 'bad' : 'ok';
                note.textContent = savePathResultText(verdict, wrote !== null, item.restart === true);
            });
            box.append(input, save, note);
            return box;
        }
        if (item.ctrl === 'vault') {
            const text = el(doc, 'span', 'settings-mono', vaultText());
            text.id = 'settingsVaultPath';
            const btn = el(doc, 'button', 'btn btn-sm', '更换');
            btn.type = 'button';
            btn.id = 'settingsVaultChange';
            on(btn, 'click', () => onChangeVault());
            box.append(text, btn);
            return box;
        }
        if (item.ctrl === 'index') {
            const text = el(doc, 'span', 'settings-mono', indexText());
            text.id = 'settingsIndexStatus';
            box.appendChild(text);
            return box;
        }
        // select:视频理解模型(video:model:set 那条既有通道)
        const select = el(doc, 'select', 'settings-select');
        select.id = 'settingsVideoModel';
        box.id = 'settingsVideoModelBox';      // 反馈要在重建之后按 id 找回这一格(见 setNote 的注释)
        const models = Array.isArray(state.video?.models) ? state.video.models : [];
        if (models.length === 0) {
            const op = el(doc, 'option', null, '读不到模型清单');
            op.value = '';
            select.appendChild(op);
        }
        for (const m of models) {
            const op = el(doc, 'option', null, m.label);
            op.value = m.id;
            if (m.id === state.video?.model) op.selected = true;
            select.appendChild(op);
        }
        on(select, 'change', async () => {
            const r = await invoke('video:model:set', { model: select.value });
            await loadReadings();
            renderBody();
            // 同上:反馈写在重建之后的新节点上(闭包里那个已经不在文档里了)
            const fresh = el(doc, 'span', 'settings-note',
                r?.ok === true ? `已切到 ${select.value}` : `切换失败:${r?.reason ?? '通道没回话'}`);
            const boxAfter = typeof doc.getElementById === 'function'
                ? doc.getElementById('settingsVideoModelBox')
                : null;
            if (boxAfter !== null) boxAfter.appendChild(fresh);
        });
        const current = el(doc, 'span', 'settings-note', videoModelText());
        current.id = 'settingsVideoModelNow';
        box.append(select, current);
        return box;
    }

    function renderItem(item) {
        const row = el(doc, 'div', 'settings-item');
        row.dataset.item = item.id;
        const label = el(doc, 'div', 'settings-label');
        const title = el(doc, 'div', 'settings-title');
        title.appendChild(el(doc, 'span', null, item.title));
        title.appendChild(el(doc, 'span', `settings-badge ${item.badge === 'has' ? 'has' : 'new'}`,
            item.badge === 'has' ? '已有通道' : '需要新做'));
        label.appendChild(title);
        label.appendChild(el(doc, 'div', 'settings-hint', item.hint));
        const restart = el(doc, 'div', 'settings-restart',
            item.restart === true ? `⚠ ${RESTART_NOTICE}(服务/子进程启动时就读了它)` : '');
        label.appendChild(restart);
        row.append(label, renderControl(item));
        return row;
    }

    function renderBody() {
        const body = els.bodyEl;
        if (!body) return;
        const result = filterSettings(state.query);
        if (result.total === 0) {
            const empty = el(doc, 'div', 'settings-empty', emptySearchText(state.query));
            empty.id = 'settingsEmpty';
            body.replaceChildren(empty);
            return;
        }
        const frag = [];
        for (const sec of result.sections) {
            const section = el(doc, 'section', 'settings-section');
            section.dataset.section = sec.id;
            // 搜索时标题带命中数(设计稿的行为);不搜索时显示这一节有多少项
            const heading = state.query.trim() === '' ? sec.name : `${sec.name}(${sec.hits})`;
            section.appendChild(el(doc, 'h2', 'settings-section-title', heading));
            if (state.query.trim() === '') section.appendChild(el(doc, 'div', 'settings-section-desc', `${sec.hits} 项`));
            const card = el(doc, 'div', 'settings-card');
            for (const item of sec.items) card.appendChild(renderItem(item));
            section.appendChild(card);
            frag.push(section);
        }
        body.replaceChildren(...frag);
    }

    /** 按当前分区/查询重画(不动数据)。 */
    function render() {
        renderNav();
        renderOverview();
        renderBody();
    }

    async function mount() {
        if (state.mounted !== true) {
            state.mounted = true;
            if (els.searchEl) {
                on(els.searchEl, 'input', () => {
                    state.query = String(els.searchEl.value ?? '');
                    renderBody();
                });
            }
        }
        await loadReadings();
        render();
        return state;
    }

    /** 打开设置视图时调一次:先把只读读数重新读一遍(库/索引/布局都可能刚改过),再画。 */
    async function show() {
        if (state.mounted !== true) return await mount();
        await loadReadings();
        render();
        return state;
    }

    return {
        mount,
        render,
        show,
        refresh: show,
        state: () => ({ ...state, paths: { ...state.paths } }),
        dispose() {
            for (const off of disposers.splice(0)) off();
        },
    };
}
