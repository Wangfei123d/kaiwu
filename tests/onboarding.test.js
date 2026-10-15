import { test } from 'node:test';
import assert from 'node:assert/strict';

// 复现并守住一个真实竞态:向导按钮在 HTML 里一开始就存在,而外壳在
// 「查笔记库状态」那次 await 上是挂起的 —— 用户完全可能在那之前就点了按钮。
// 若之后再把**过期的**状态喂给 apply(),就会把已经进去的界面又盖回向导。
//
// 这个 bug 在真实使用中出现过:用户选完文件夹,笔记界面其实已经打开,
// 却又被一张向导盖住,而且那张向导还残留着「发现 7 篇笔记」——
// 看起来就像"选了却没反应"。

class El {
    constructor() {
        this.hidden = false;
        this.textContent = '';
        this.innerHTML = '';
        this.listeners = {};
        this.disabled = false;
    }
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
    async click() { for (const f of this.listeners.click ?? []) await f({ preventDefault() {} }); }
}

function harness(chooseResult) {
    const els = {
        '#onboardingLead': new El(),
        '#onboardingNote': new El(),
        '#onboardingPath': new El(),
        '#onboardingChoose': new El(),
        '#onboardingSkip': new El(),
    };
    const root = new El();
    root.querySelector = (sel) => els[sel] ?? null;

    globalThis.window = {
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    };

    const bridge = { invoke: async () => chooseResult };
    return { root, els, bridge };
}

const OK_WITH_7 = {
    ok: true, canceled: false, noteCount: 7,
    status: { configured: true, ok: true, path: 'D:\\vault', reason: null },
};
const NOT_CONFIGURED = { configured: false, ok: false, path: null, reason: '还没有选择笔记库' };

async function makeOnboarding(chooseResult) {
    const h = harness(chooseResult);
    const { createOnboarding } = await import('../app/notes/onboarding.js');
    const ready = [];
    const onb = createOnboarding({
        el: h.root,
        bridge: h.bridge,
        log: { info() {}, error() {} },
        onVaultReady: (s) => { ready.push(s); },
    });
    return { ...h, onb, ready };
}

const settle = () => new Promise(r => setTimeout(r, 0));

test('正常流程:apply 先显示向导,选完后隐藏并回调', async () => {
    const h = await makeOnboarding(OK_WITH_7);
    assert.equal(h.onb.apply(NOT_CONFIGURED), true);
    assert.equal(h.root.hidden, false);

    await h.els['#onboardingChoose'].click();
    await settle();

    assert.equal(h.root.hidden, true, '选完之后向导必须隐藏');
    assert.equal(h.ready.length, 1);
    assert.equal(h.ready[0].path, 'D:\\vault');
});

test('竞态:用户在 apply 之前就选完了,过期状态不得把向导盖回来', async () => {
    const h = await makeOnboarding(OK_WITH_7);

    // 模拟"向导按钮先被点到"(此时 boot 还卡在查状态那一步)
    await h.els['#onboardingChoose'].click();
    await settle();
    assert.equal(h.root.hidden, true, '选完就已经进去了');
    assert.equal(h.ready.length, 1);

    // boot 那次 await 现在才返回,带着**过期**的"未配置"状态
    const showed = h.onb.apply(NOT_CONFIGURED);

    assert.equal(showed, false, '过期状态不能判定为"要显示向导"');
    assert.equal(h.root.hidden, true, '向导必须保持隐藏 —— 这正是那个 bug');
});

test('竞态:按了跳过之后,过期状态也不该再弹向导', async () => {
    const h = await makeOnboarding(OK_WITH_7);
    await h.els['#onboardingSkip'].click();
    await settle();
    assert.equal(h.root.hidden, true);

    assert.equal(h.onb.apply(NOT_CONFIGURED), false);
    assert.equal(h.root.hidden, true);
});

test('未配置且未操作时,apply 照常显示向导', async () => {
    const h = await makeOnboarding(OK_WITH_7);
    assert.equal(h.onb.apply(NOT_CONFIGURED), true);
    assert.equal(h.root.hidden, false);
});

test('已配置且可用时 apply 直接放行,不显示向导', async () => {
    const h = await makeOnboarding(OK_WITH_7);
    const showed = h.onb.apply({ configured: true, ok: true, path: 'D:\\vault', reason: null });
    assert.equal(showed, false);
    assert.equal(h.root.hidden, true);
});

test('配置过但路径失效时显示向导并说明原因', async () => {
    const h = await makeOnboarding(OK_WITH_7);
    const showed = h.onb.apply({
        configured: true, ok: false, path: 'D:\\没了', reason: '上次的笔记库找不到了',
    });
    assert.equal(showed, true);
    assert.equal(h.root.hidden, false);
    assert.match(h.els['#onboardingLead'].textContent, /找不到/);
    assert.match(h.els['#onboardingPath'].textContent, /没了/);
});

test('点「更换」会重新打开向导,并复位说明文字', async () => {
    const h = await makeOnboarding(OK_WITH_7);
    await h.els['#onboardingChoose'].click();
    await settle();
    assert.equal(h.root.hidden, true);

    h.onb.open();
    assert.equal(h.root.hidden, false, '「更换」应当重新显示向导');
    // 复位说明文字:不该残留上一次的"发现 N 篇笔记"
    assert.ok(!h.els['#onboardingNote'].textContent.includes('发现'),
        '重新打开向导时说明文字要复位,实际:' + h.els['#onboardingNote'].textContent);
});

test('进入笔记库失败时不把用户困住:向导回到可见且可再点', async () => {
    const h = await makeOnboarding(OK_WITH_7);
    // 让 onVaultReady 抛错
    const { createOnboarding } = await import('../app/notes/onboarding.js');
    const root2 = new El();
    const els2 = {
        '#onboardingLead': new El(), '#onboardingNote': new El(),
        '#onboardingPath': new El(), '#onboardingChoose': new El(), '#onboardingSkip': new El(),
    };
    root2.querySelector = (s) => els2[s] ?? null;
    const onb2 = createOnboarding({
        el: root2,
        bridge: { invoke: async () => OK_WITH_7 },
        log: { info() {}, error() {} },
        onVaultReady: () => { throw new Error('索引炸了'); },
    });
    onb2.apply(NOT_CONFIGURED);
    await els2['#onboardingChoose'].click();
    await settle();

    assert.equal(root2.hidden, false, '载入失败要把向导还给用户');
    assert.match(els2['#onboardingLead'].textContent, /载入失败/);
    assert.equal(els2['#onboardingChoose'].disabled, false, '按钮要恢复可点');
});

test('用户取消选择时不改变状态、不回调', async () => {
    const h = await makeOnboarding({ ok: false, canceled: true, status: NOT_CONFIGURED });
    h.onb.apply(NOT_CONFIGURED);
    await h.els['#onboardingChoose'].click();
    await settle();

    assert.equal(h.root.hidden, false, '取消后向导应当还在');
    assert.equal(h.ready.length, 0);
});
