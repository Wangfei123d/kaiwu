import { mountTool } from '../runtime/mount.js';

// 内容区:按需挂载工具面板(懒 setup),切换前先卸载上一个。
//
// 关键一:可挂载的工具集合来自**注册表**(registries.tools),不是描述符的
// contributions.tools。原因:单文件插件在扫描阶段拿不到自己的清单,
// 它的 tools 只在 activate 里经 ctx.tools.register 登记进注册表,
// 描述符上的 contributions.tools 始终是空的。侧边栏读注册表,
// 所以这里也必须读注册表,否则会出现"侧边栏有按钮、点开却是空面板"。
//
// 关键二:每一次挂载都带一个"代次(generation)"。挂载是异步的(要 fetch
// 面板 HTML、应用样式、跑 setup),而用户可以在它完成之前就点开另一个工具。
// 没有这个闸门时,后完成的旧挂载会把自己写进共享容器,覆盖掉新挂载的 DOM ——
// 表现是"选中的是 A、显示的却是 B",而且没有任何报错。
// 实测:自检跑 10 次里约有 2 次会命中,极难复现,所以闸门必须做。
export function createContent({ container, registries, fetchText }) {
    const byToolId = new Map();     // toolId → { descriptor, instance, ctx }
    let current = null;             // { toolId, handle }
    let generation = 0;             // 每次 show 自增;过期的挂载一律丢弃

    function showHint(text) {
        container.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = text;
        container.appendChild(p);
    }

    async function show(toolId) {
        if (current?.toolId === toolId) return;

        // 认领这一代。在我之前发起、之后才回来的挂载都会被丢弃。
        const myGeneration = ++generation;

        if (current) {
            const previous = current;
            current = null;         // 先摘掉,避免重入时又去卸载同一个
            try {
                await previous.handle.teardown();
            } catch (err) {
                console.error('[content] 卸载上一个工具失败', err);
            }
            // 卸载也是异步的,期间可能又有人点了别的工具;以最新意图为准。
            if (myGeneration !== generation) return;
        }

        const entry = byToolId.get(toolId);
        container.innerHTML = '';
        if (!entry) {
            showHint('这个工具没有可用的面板。');
            return;
        }

        // toolSpec 来自注册表:注册时插件已经把面板地址 / 内联 HTML 交进来了。
        const toolSpec = registries.tools.get(toolId);
        if (!toolSpec) {
            showHint('这个工具没有可用的面板。');
            return;
        }

        try {
            const handle = await mountTool({
                descriptor: entry.descriptor,
                toolSpec,
                instance: entry.instance,
                container,
                ctx: entry.ctx,
                fetchText,
                // 闸门必须交给 mountTool 在**写入容器之前**判断。
                // 只在拿到 handle 之后丢弃是来不及的:那时旧面板已经把
                // 新面板的 DOM 覆盖掉了。
                shouldApply: () => myGeneration === generation,
            });

            if (myGeneration !== generation) return;    // 已经过期,不写回状态
            current = { toolId, handle };
        } catch (err) {
            if (myGeneration !== generation) return;
            entry.ctx.log.error('面板挂载失败', err);
            showHint(`面板挂载失败:${err.message}`);
        }
    }

    return {
        // loadPlugins 的 activated 数组,每项 { descriptor, instance, ctx }
        setActivated(activated) {
            byToolId.clear();
            // 注册表里的每个工具都归它的来源插件所有,按 pluginId 找回去。
            const byPluginId = new Map(activated.map(a => [a.descriptor.id, a]));
            for (const tool of registries.tools.list()) {
                const entry = byPluginId.get(tool.pluginId);
                if (entry) byToolId.set(tool.id, entry);
            }
        },
        showHint,
        show,
    };
}
