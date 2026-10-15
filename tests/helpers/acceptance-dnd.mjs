// §8 验收动作的**真实指针**驱动脚本(隔离实例,不碰真 %APPDATA%\kaiwu)。
//
// 为什么不用合成 PointerEvent:规格 §8 要的是"真的拖一次"。CDP 的
// `Input.dispatchMouseEvent` 走的是浏览器输入管线(会生成真正的 pointerdown/move/up),
// 和我们自己在 selftest 里 `dispatchEvent(new PointerEvent(...))` 是两回事。
//
// 用法:
//   node tests/helpers/acceptance-dnd.mjs <port> <phase>
//     phase = actions  第一段:做 §8 ① ② ③,并把读数打印出来
//     phase = verify   第二段(重起之后的同一个 user-data-dir):只读回布局
//
// 输出一律是 `ACCEPT <json>` 单行,方便宿主侧 grep。
import process from 'node:process';

const PORT = Number(process.argv[2] ?? 9333);
const PHASE = process.argv[3] ?? 'actions';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连上 CDP 的 page target,返回一个极小的 { send, close }。 */
async function connect() {
    let targets = [];
    for (let i = 0; i < 60; i += 1) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            targets = await res.json();
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return openWs(page.webSocketDebuggerUrl);
        } catch { /* 还没起来,继续等 */ }
        await sleep(500);
    }
    throw new Error(`CDP 没连上(port=${PORT},targets=${JSON.stringify(targets).slice(0, 300)})`);
}

function openWs(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        let nextId = 1;
        const pending = new Map();
        ws.addEventListener('message', (ev) => {
            let msg = null;
            try { msg = JSON.parse(String(ev.data)); } catch { return; }
            if (msg.id && pending.has(msg.id)) {
                const { resolve: rs, reject: rj } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) rj(new Error(JSON.stringify(msg.error)));
                else rs(msg.result);
            }
        });
        ws.addEventListener('error', (err) => reject(err));
        ws.addEventListener('open', () => {
            resolve({
                send(method, params = {}) {
                    const id = nextId++;
                    ws.send(JSON.stringify({ id, method, params }));
                    return new Promise((rs, rj) => {
                        pending.set(id, { resolve: rs, reject: rj });
                        // ⚠️ 给每个 CDP 调用加超时:没有它,一次没回应的调用会让整个脚本
                        //    静默挂到宿主超时(实测踩过)。
                        setTimeout(() => {
                            if (pending.has(id)) { pending.delete(id); rj(new Error('CDP 超时:' + method)); }
                        }, 15000);
                    });
                },
                close() { try { ws.close(); } catch { /* 无所谓 */ } },
            });
        });
    });
}

const js = async (cdp, expression) => {
    const r = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`页面里抛了:${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result?.value;
};

/** 真实鼠标:按下 → 分小步移动(让 pointermove 真的发生)→ 抬起。 */
async function realDrag(cdp, from, to) {
    // ⚠️ 每一步都套一层 Promise.race:哪个 CDP 调用挂住了一看就知道
    //    (实测踩过:WebSocket 层面静默不出声,只留一个 watchdog 读数,定位不了)。
    const step = async (label, fn) => {
        process.stderr.write(`[accept]   step ${label} …\n`);
        const r = await Promise.race([
            fn(),
            sleep(20000).then(() => ({ __timeout: label })),
        ]);
        process.stderr.write(`[accept]   step ${label} ok\n`);
        if (r && r.__timeout) throw new Error(`这一步没回来:${label}`);
        return r;
    };
    await step('mouseMoved', () => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', clickCount: 0 }));
    await step('mousePressed', () => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 }));
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) {
        const x = Math.round(from.x + (to.x - from.x) * (i / steps));
        const y = Math.round(from.y + (to.y - from.y) * (i / steps));
        await step(`mouseMoved#${i}`, () => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }));
        await sleep(30);
    }
    await sleep(60);
    const mid = await step('snapshotDuring', () => snapshot(cdp));
    await step('mouseReleased', () => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }));
    await sleep(300);
    return mid;
}

/** 只读快照:树的文本 + 每一格的槽位 id / 标签 / 活动标签 / 宽度。 */
async function snapshot(cdp) {
    return js(cdp, `(() => {
        const desk = document.getElementById('panelWorkspace');
        const panes = [...(desk?.querySelectorAll('.pw-pane') ?? [])].map((p) => {
            const leafTabs = [...p.querySelectorAll('.pw-tab')].map((t) => t.textContent);
            return {
                slot: p.dataset.paneId,
                mode: p.querySelector('.pw-tabs')?.dataset.mode ?? null,
                cur: p.querySelector('.pw-tabs-cur')?.textContent ?? null,
                tabs: leafTabs,
                label: p.getAttribute('aria-label'),
                w: Math.round(p.getBoundingClientRect().width),
            };
        });
        return {
            tree: document.getElementById('layoutTree')?.textContent ?? null,
            panes,
            hintOn: document.getElementById('panelHint')?.classList.contains('pw-on') ?? null,
            leftovers: desk?.querySelectorAll('.pw-tab-dragging, .pw-pane-drop, .pw-tabs-drop').length ?? null,
        };
    })()`);
}

/** 某个槽位里第 index 枚胶囊的中点(真实屏幕坐标)。 */
const pillPoint = (cdp, slot, index) => js(cdp, `(() => {
    const p = document.querySelector('.pw-pane[data-pane-id=' + JSON.stringify(${JSON.stringify(slot)}) + ']');
    const pill = (p?.querySelectorAll('.pw-tab')[${index}]) ?? p?.querySelector('.pw-tabs-cur');
    if (!pill) return null;
    const r = pill.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);

const paneRect = (cdp, slot) => js(cdp, `(() => {
    const p = document.querySelector('.pw-pane[data-pane-id=' + JSON.stringify(${JSON.stringify(slot)}) + ']');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
})()`);

const stateOf = (snap) => ({
    tree: snap.tree,
    slots: snap.panes.map((p) => `${p.slot}[${(p.tabs.length ? p.tabs : [p.cur ?? '空']).join('|')}]`).join(' '),
    active: snap.panes.map((p) => p.label).join(' | '),
    widths: snap.panes.map((p) => p.w).join(','),
});

const mark = (m) => process.stderr.write('[accept] ' + m + '\n');

async function main() {
    // ⚠️ 看门狗:任何一步静默挂住都要有读数,而不是等到宿主超时(实测踩过一次)。
    setTimeout(() => {
        process.stderr.write('[accept] WATCHDOG\n');
        process.stdout.write('ACCEPT {"error":"watchdog 超时一句读数都没有"}\n');
        process.exit(4);
    }, 300000);
    console.error('[accept] 连接 CDP…');
    const cdp = await connect();
    console.error('[accept] 已连接');

    // 等界面真的挂好(AI 面板出来 = 工作台与插件都就位)
    for (let i = 0; i < 60; i += 1) {
        const ready = await js(cdp, `Boolean(document.querySelector('.pw-pane[data-pane-id="ai"]') && document.getElementById('layoutTree'))`);
        if (ready) break;
        await sleep(500);
    }

    if (PHASE === 'verify') {
        const snap = await snapshot(cdp);
        console.log(`ACCEPT ${JSON.stringify({ phase: 'verify', ...stateOf(snap) })}`);
        cdp.close();
        return;
    }

    // ---- 第一段:先把布局重置成默认,再做 §8 ①②③ ----
    await js(cdp, `document.getElementById('layoutReset')?.click()`);
    await sleep(500);
    mark('reset 完成');
    const base = await snapshot(cdp);
    mark('base 快照完成');
    const out = { phase: 'actions', base: stateOf(base) };

    // ① 把「笔记正文」那一枚拖到 AI 槽位的**正文中央** → 同一槽位、被拖的在前
    const src1 = await pillPoint(cdp, 'doc', 0);
    const aiRect = await paneRect(cdp, 'ai');
    if (!src1 || !aiRect) throw new Error(`找不到拖动起点或目标:${JSON.stringify({ src1, aiRect })}`);
    // 正文中央:避开四边 28px 带、也避开顶上那条标签条
    const center1 = { x: Math.round(aiRect.left + aiRect.w / 2), y: Math.round(aiRect.top + aiRect.h * 0.6) };
    mark(`第①次拖动 ${JSON.stringify({ src1, center1 })}`);
    const mid1 = await realDrag(cdp, src1, center1);
    mark('第①次拖动结束');
    const after1 = await snapshot(cdp);
    out.drag1 = { from: src1, to: center1, hintDuring: mid1.hintOn, ...stateOf(after1) };

    // 找现在装着「笔记正文」的那个槽位(合并之后它的 id 就是目标槽位)
    const host1 = await js(cdp, `(() => {
        const host = [...document.querySelectorAll('.pw-pane')].find((p) => (p.getAttribute('aria-label') ?? '').startsWith('笔记正文'));
        return host ? host.dataset.paneId : null;
    })()`);
    out.hostAfterMerge = host1;

    // ② 把其中一枚拖到**另一个槽位的右边缘** → 右侧出现单标签新槽位,未拖的留在原栈。
    //
    // ⚠️ 这里与规格 §8 ② 的字面写法("拖到 AI 槽位右边")有一处**必须说明的冲突**:
    //    合并之后那一格就是 AI 槽位自己,而"把一枚标签拖到自己那一格的边缘"在
    //    行为模型 demo 里是**取消**的(`z.slotId === drag.slotId → 取消,树不动`),
    //    本实现照 demo 的判据实现(交接单明确要求"照它的判据实现,不要自创")。
    //    所以②用**邻近的另一个槽位**当目标 —— 判据完全一样(单标签新槽位 + 源栈留下未拖的那枚),
    //    同时把"拖到自己那一格"的读数一并记下来(见 selfEdge)。
    const linkRect = await paneRect(cdp, 'links');
    const src2 = host1 === null ? null : await pillPoint(cdp, host1, 0);
    if (!src2 || !linkRect) throw new Error(`第二次拖动找不到起点/目标:${JSON.stringify({ src2, linkRect, host1 })}`);
    const right2 = { x: linkRect.right - 6, y: Math.round(linkRect.top + linkRect.h * 0.5) };
    mark(`第②次拖动 ${JSON.stringify({ src2, right2 })}`);
    const mid2 = await realDrag(cdp, src2, right2);
    mark('第②次拖动结束');
    const after2 = await snapshot(cdp);
    out.drag2 = { from: src2, to: right2, hintDuring: mid2.hintOn, ...stateOf(after2) };

    // ②b 记录读数:拖到自己那一格的边缘 → 按 demo 的判据应当**取消**(树不动)
    const selfPoint = await pillPoint(cdp, host1, 0);
    const selfRect = await paneRect(cdp, host1);
    const beforeSelf = await snapshot(cdp);
    const midSelf = await realDrag(cdp, selfPoint, { x: selfRect.right - 6, y: Math.round(selfRect.top + selfRect.h * 0.5) });
    const afterSelf = await snapshot(cdp);
    out.selfEdge = {
        from: selfPoint, to: { x: selfRect.right - 6, y: Math.round(selfRect.top + selfRect.h * 0.5) },
        hintDuring: midSelf.hintOn, sameTree: afterSelf.tree === beforeSelf.tree, tree: afterSelf.tree,
    };

    // ③ 抓手 / 条上空白 / 正文上按下拖动 → 布局一个字都不动
    //
    // ⚠️ 坐标必须**落在空白区**,不能落进胶囊里 —— 替身/真身都一样:胶囊是**唯一**的
    //    拖动起点,点在胶囊上本来就该开始拖一枚标签。所以每一步都先问
    //    `elementFromPoint` 它到底是什么,并把读数写进结果里(这一条本身也是"证据")。
    const before3 = await snapshot(cdp);
    const inert = {};
    for (const [name, sel] of [
        ['grip', '.pw-pane[data-pane-id="' + host1 + '"] .pw-grip'],
        ['grabpad', '.pw-pane[data-pane-id="' + host1 + '"] .pw-grabpad'],
        ['body', '.pw-pane[data-pane-id="' + host1 + '"] .pw-body'],
        ['tabsBlank', '.pw-pane[data-pane-id="' + host1 + '"] .pw-tabs'],
    ]) {
        const pt = await js(cdp, `(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            // 取该元素几何中心:抓手/条上空白/正文的**中心**都在空白里,
            // 而胶囊永远靠条的最左边(所以"条的中心"不会压在胶囊上)。
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            const under = document.elementFromPoint(x, y);
            return { x, y, under: under ? (under.className || under.tagName) : null,
                     onTab: Boolean(under?.closest?.('.pw-tab')) };
        })()`);
        if (!pt) { inert[name] = { skipped: true }; continue; }
        const mid = await realDrag(cdp, pt, { x: pt.x + 120, y: pt.y + 90 });
        const after = await snapshot(cdp);
        inert[name] = { ...pt, hintDuring: mid.hintOn, sameTree: after.tree === before3.tree, tree: after.tree };
    }
    const after3 = await snapshot(cdp);
    out.inert = inert;
    out.after3 = stateOf(after3);
    out.leftoversAtEnd = after3.leftovers;

    console.log(`ACCEPT ${JSON.stringify(out)}`);
    cdp.close();
}

main().then(() => process.exit(0)).catch((err) => {
    console.log(`ACCEPT ${JSON.stringify({ error: String(err?.message ?? err) })}`);
    process.exit(1);
});


