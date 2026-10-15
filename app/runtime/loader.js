import { buildCtx } from './ctx.js';
import { mountTool } from './mount.js';

// 加载管线:import → activate。每一步单独 try/catch,坏的插件只影响自己。
//
// importFn 由调用方注入,好处有两个:
//   1. 单测里可以不碰 Electron 直接跑整条管线
//   2. 生产环境传 (url) => import(url),浏览器原生行为
// bridge 必须显式传入 —— 不要挂在 descriptor 上,那样 descriptor 就成了
// 一个穿梭于各层的杂物袋,而且单测里要伪造 descriptor 才能跑。
export async function loadPlugins({
    descriptors, registries, importFn, bridge, log = console,
    fetchText = (url) => fetch(url).then((response) => response.text()),
}) {
    const activated = [];
    const broken = [];

    for (const descriptor of descriptors) {
        // 扫描阶段就已经坏掉的,不必再试
        if (descriptor.status === 'broken') {
            broken.push({
                descriptor,
                stage: descriptor.error?.stage ?? 'scan',
                error: new Error(descriptor.error?.message ?? '扫描阶段失败'),
            });
            continue;
        }

        let module;
        try {
            module = await importFn(descriptor.entryUrl);
        } catch (error) {
            broken.push({ descriptor, stage: 'import', error });
            continue;
        }

        const instance = module?.default;
        if (!instance || typeof instance !== 'object') {
            broken.push({
                descriptor,
                stage: 'no-default-export',
                error: new Error('插件入口必须 `export default { activate, setup? }`'),
            });
            continue;
        }

        const ctx = buildCtx({ descriptor, bridge, registries, log });

        // 清单里声明的工具在这里统一登记。
        //
        // 为什么必须有这一步:文件夹形态的工具写在 plugin.json 的
        // contributes.tools 里,而侧边栏与内容区都只读**注册表** ——
        // 主进程只把 contributes.services 交给了服务托管器,工具这一半
        // 原先没人管。结果是"清单里声明了、activate 里忘了 register"的插件
        // 会彻底不出现,而设计文档 §6.1 明确说工具由清单声明。
        //
        // 插件在 activate 里再 register 一次是无害的:注册表对重复 id 返回
        // false 而不覆盖(见 registries.js),所以两种写法都成立。
        for (const tool of descriptor.contributions?.tools ?? []) {
            registries.tools.define({
                order: 1000,
                ...tool,
                pluginId: descriptor.id,
            });
        }

        // ⚠️ 面板**不在这里自动登记**,与 tools 那条刻意不同。
        //
        // tools 可以先登记再让插件补一次(ctx.tools.register 撞重复 id 只会返回 false,
        // 而工具面板靠 panel.html 渲染,不依赖那个 spec 里的函数),所以清单那份够用。
        //
        // 面板不一样:它必须带一个 `mount(host, ctx)` 回调,而函数过不了 JSON,
        // 只能来自插件的 activate。若这里先用清单那份占住 id,插件的
        // ctx.panes.register 就会因为**重复 id 被拒**,mount 永远进不来 ——
        // 现象是"面板出现了但一片空白",而且不会有任何报错。
        //
        // 所以清单里的 contributes.panes 只用于校验与文档,登记一律由插件自己做。
        // (manifest-schema.js 仍然校验它,形状写错在扫描阶段就会报出来。)

        try {
            if (typeof instance.activate === 'function') {
                await instance.activate(ctx);
            }
        } catch (error) {
            // 激活失败要回滚它已经注册的贡献点,否则会留下"幽灵工具"。
            // 回滚顺序与申请顺序相反:先撤贡献点(外壳还看得见它们),
            // 再跑插件自己的 onDispose(释放它占的资源)。
            registries.tools.removeByPlugin(descriptor.id);
            registries.services.removeByPlugin(descriptor.id);
            registries.panes.removeByPlugin(descriptor.id);
            ctx.__dispose();
            broken.push({ descriptor, stage: 'activate', error });
            continue;
        }

        // 只有显式标记的工具才升级为按需挂载的工作台 pane。
        // 清单工具在上面已经登记;单文件工具则会在 activate 中通过 ctx.tools.register 登记。
        // 两种来源最后都复用 mountTool,因此 HTML、CSS、setup 与 teardown 仍走原路径。
        for (const toolSpec of registries.tools.list()) {
            if (toolSpec.pluginId !== descriptor.id || toolSpec.workspacePane !== true) continue;
            const viewId = `tool:${descriptor.id}:${toolSpec.id}`;
            registries.panes.define({
                id: viewId,
                title: toolSpec.title,
                optional: true,
                pluginId: descriptor.id,
                mount: (host) => mountTool({
                    descriptor, toolSpec, instance, container: host, ctx, fetchText,
                }),
            });
        }

        activated.push({ descriptor, instance, ctx });
    }

    return { activated, broken };
}
