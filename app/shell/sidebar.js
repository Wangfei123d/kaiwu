import { iconGlyph } from './icons.js';

// 侧边栏:工具列表 + 搜索过滤 + 坏插件错误卡片。
export function createSidebar({ listEl, errorsEl, searchEl, registries, onSelect }) {
    let selectedId = null;
    let keyword = '';
    let brokenList = [];

    function renderList() {
        const all = registries.tools.list();
        const visible = keyword
            ? all.filter(t => t.title.toLowerCase().includes(keyword))
            : all;

        listEl.innerHTML = '';
        for (const tool of visible) {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('role', 'tab');
            btn.dataset.toolId = tool.id;
            btn.setAttribute('aria-selected', String(tool.id === selectedId));
            // 用 textContent 而不是 innerHTML 拼图标:插件提供的图标字符串
            // 不该有机会注入标记(设计文档 §6.6)。
            btn.textContent = `${iconGlyph(tool.icon)} ${tool.title}`;
            btn.addEventListener('click', () => select(tool.id, { user: true }));
            li.appendChild(btn);
            listEl.appendChild(li);
        }
    }

    function renderErrors() {
        errorsEl.innerHTML = '';
        for (const { descriptor, stage, error } of brokenList) {
            const details = document.createElement('details');
            details.className = 'plugin-error';

            const summary = document.createElement('summary');
            summary.textContent = `${descriptor.name || descriptor.id} 加载失败(${stage})`;

            const pre = document.createElement('pre');
            pre.textContent = error?.stack || error?.message || String(error);

            details.append(summary, pre);
            errorsEl.appendChild(details);
        }
    }

    /**
     * 选中一个工具。
     *
     * `user` 区分**用户点的**和**程序自己选的**:启动时侧栏要"总有一个选中的工具",
     * 于是 render() 会自动选第一个。那次选中只该把面板挂进内容区,
     * 不该把外壳从笔记视图带走 —— 否则每次启动都会落在工具页上
     * (产品方向是"打开先看到笔记 / 对话",工具是侧栏附属,见设计文档 §零)。
     */
    function select(toolId, { user = false } = {}) {
        selectedId = toolId;
        renderList();
        onSelect(toolId, { user });
    }

    searchEl.addEventListener('input', () => {
        keyword = searchEl.value.trim().toLowerCase();
        renderList();
    });

    registries.tools.onChange(renderList);

    return {
        // broken 来自 loadPlugins 的返回值,结构是 { descriptor, stage, error }
        render({ broken = [] } = {}) {
            brokenList = broken;
            renderList();
            renderErrors();
            if (!selectedId || !registries.tools.get(selectedId)) {
                const first = registries.tools.list()[0];
                if (first) select(first.id);
            }
        },
        select,
    };
}
