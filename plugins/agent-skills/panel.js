import { renderMarkdownNodes } from 'toolbox://shell/lib/markdown.js';

const ICONS = {
    spark: '<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.4"/><path d="m16 16 4 4"/>',
    refresh: '<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 1-1.8-4.7L20 10"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    empty: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
};

export function setup(host, ctx) {
    const api = ctx.agentSkills;
    const root = document.createElement('section');
    root.className = 'ask-root';
    root.innerHTML = `
      <aside class="ask-nav">
        <div class="ask-brand"><span class="ask-brand-icon">${icon('spark')}</span><span>Skills</span><span class="ask-nav-count" data-total>0</span></div>
        <div class="ask-nav-list" role="navigation" aria-label="技能来源">
          <button class="ask-nav-item active" data-source="all" type="button"><span class="ask-nav-dot all"></span>全部<span class="ask-nav-count" data-count="all">0</span></button>
          <button class="ask-nav-item" data-source="工作区" type="button"><span class="ask-nav-dot workspace"></span>工作区<span class="ask-nav-count" data-count="工作区">0</span></button>
          <button class="ask-nav-item" data-source="用户" type="button"><span class="ask-nav-dot user"></span>用户<span class="ask-nav-count" data-count="用户">0</span></button>
          <button class="ask-nav-item" data-source="内置" type="button"><span class="ask-nav-dot builtin"></span>内置<span class="ask-nav-count" data-count="内置">0</span></button>
        </div>
        <div class="ask-nav-foot">${icon('spark')}<span>由 Agent 沉淀</span></div>
      </aside>
      <section class="ask-list-pane">
        <header class="ask-list-head">
          <div class="ask-list-title"><strong>全部 Skills</strong><button class="ask-icon-button" data-refresh type="button" aria-label="刷新技能列表" title="刷新">${icon('refresh')}</button></div>
          <label class="ask-search">${icon('search')}<input data-search type="search" autocomplete="off" placeholder="搜索技能"></label>
          <div class="ask-filters" role="tablist" aria-label="技能状态">
            <button class="active" data-filter="all" type="button">全部</button><button data-filter="available" type="button">可调用</button>
          </div>
        </header>
        <div class="ask-items" data-items role="listbox" aria-label="Skills"></div>
        <div class="ask-empty-list" data-empty hidden>${icon('empty')}<span>暂无 Skill</span></div>
        <footer class="ask-list-foot"><span class="ask-live-dot"></span><span data-status>正在读取</span></footer>
      </section>
      <section class="ask-detail" data-detail>
        <div class="ask-empty-detail"><span>${icon('spark')}</span><strong>选择一个 Skill</strong></div>
      </section>`;
    host.replaceChildren(root);

    const q = selector => root.querySelector(selector);
    const itemHost = q('[data-items]');
    const detail = q('[data-detail]');
    const search = q('[data-search]');
    let skills = [];
    let selectedId = '';
    let sourceFilter = 'all';
    let statusFilter = 'all';
    let listSequence = 0;
    let detailSequence = 0;
    let disposed = false;

    function renderList() {
        const term = search.value.trim().toLocaleLowerCase();
        const visible = skills.filter(skill => {
            const sourceOk = sourceFilter === 'all' || skill.source === sourceFilter;
            const statusOk = statusFilter === 'all' || skill.available;
            const text = `${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`.toLocaleLowerCase();
            return sourceOk && statusOk && text.includes(term);
        });
        const previousSelection = selectedId;
        const next = visible.find(skill => skill.id === selectedId) ?? visible[0] ?? null;
        selectedId = next?.id ?? '';
        itemHost.replaceChildren(...visible.map(skill => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `ask-item${skill.id === selectedId ? ' active' : ''}`;
            button.dataset.id = skill.id;
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(skill.id === selectedId));
            button.innerHTML = `<span class="ask-item-icon">${icon('file')}</span><span class="ask-item-copy"><strong></strong><small></small></span><span class="ask-item-state" title="${skill.autoMatch ? '可自动匹配' : skill.userInvocable ? '仅手动调用' : '不可调用'}">${skill.autoMatch ? icon('check') : ''}</span>`;
            button.querySelector('strong').textContent = skill.name;
            button.querySelector('small').textContent = skill.source;
            button.addEventListener('click', () => void select(skill.id));
            return button;
        }));
        q('[data-empty]').hidden = visible.length > 0;
        q('[data-count="all"]').textContent = String(skills.length);
        q('[data-total]').textContent = String(skills.length).padStart(2, '0');
        for (const source of ['工作区', '用户', '内置']) {
            q(`[data-count="${source}"]`).textContent = String(skills.filter(item => item.source === source).length);
        }
        if (!next) {
            detail.innerHTML = `<div class="ask-empty-detail"><span>${icon('empty')}</span><strong>${skills.length ? '没有匹配的 Skill' : '暂无 Skill'}</strong><small>${skills.length ? '调整筛选条件' : '让 Agent 将常用流程沉淀为 Skill'}</small></div>`;
        } else if (next.id !== previousSelection) {
            void loadDetail(next.id);
        }
    }

    async function loadDetail(id) {
        const token = ++detailSequence;
        detail.innerHTML = `<div class="ask-loading"><i></i><i></i><i></i></div>`;
        try {
            const result = await api.read(id);
            if (disposed || token !== detailSequence) return;
            if (!result?.ok || !result.skill) throw new Error(result?.reason || '无法读取 Skill');
            renderDetail(result.skill);
        } catch (err) {
            if (disposed || token !== detailSequence) return;
            detail.innerHTML = `<div class="ask-error">${escapeText(err?.message ?? err)}</div>`;
        }
    }

    async function select(id) {
        selectedId = id;
        const meta = skills.find(item => item.id === id);
        if (!meta) return;
        renderList();
        await loadDetail(id);
    }

    function renderDetail(skill) {
        const autoText = skill.autoMatch ? '自动匹配' : skill.userInvocable ? '手动调用' : '不可调用';
        detail.innerHTML = `
          <header class="ask-detail-head"><span class="ask-hero-icon">${icon('spark')}</span><div class="ask-detail-title"><div class="ask-title-row"><h2></h2><span class="ask-source-tag"></span></div><p></p></div><span class="ask-availability ${skill.available ? 'on' : 'off'}">${skill.available ? icon('check') : ''}${autoText}</span></header>
          <div class="ask-detail-scroll"><section class="ask-overview"><div class="ask-section-label">用途</div><p class="ask-description"></p></section><div class="ask-file-label">${icon('file')}<strong>SKILL.md</strong><span>${escapeText(skill.path)}</span></div><article class="ask-markdown"></article></div>`;
        detail.querySelector('h2').textContent = skill.name;
        detail.querySelector('.ask-source-tag').textContent = skill.source;
        detail.querySelector('.ask-detail-title p').textContent = skill.whenToUse || skill.description;
        detail.querySelector('.ask-description').textContent = skill.description;
        const markdown = detail.querySelector('.ask-markdown');
        const instructions = skill.instructions || skill.content;
        markdown.replaceChildren(...renderMarkdownNodes(document, instructions, { wikilinks: false, tags: false }));
    }

    async function refresh() {
        const token = ++listSequence;
        const previousSelection = selectedId;
        q('[data-status]').textContent = '正在同步';
        q('[data-refresh]').classList.add('spinning');
        try {
            const result = await api.list();
            if (disposed || token !== listSequence) return;
            skills = Array.isArray(result?.skills) ? result.skills : [];
            q('[data-status]').textContent = `${skills.length} 个技能`;
            renderList();
            if (selectedId && selectedId === previousSelection) await loadDetail(selectedId);
        } catch (err) {
            if (disposed || token !== listSequence) return;
            q('[data-status]').textContent = '读取失败';
            ctx.log.warn(`读取 Skills 失败:${err?.message ?? err}`);
        } finally {
            q('[data-refresh]')?.classList.remove('spinning');
        }
    }

    q('[data-refresh]').addEventListener('click', () => void refresh());
    search.addEventListener('input', renderList);
    root.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => {
        sourceFilter = button.dataset.source;
        root.querySelectorAll('[data-source]').forEach(item => item.classList.toggle('active', item === button));
        renderList();
    }));
    root.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
        statusFilter = button.dataset.filter;
        root.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
        renderList();
    }));

    void refresh();
    ctx.onDispose(() => { disposed = true; listSequence += 1; detailSequence += 1; });
}
function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS.spark}</svg>`;
}

function escapeText(value) {
    const span = document.createElement('span');
    span.textContent = String(value ?? '');
    return span.innerHTML;
}

