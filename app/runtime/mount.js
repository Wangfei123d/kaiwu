// 面板挂载。
//
// 顺序是被现有代码强制的:必须先把 HTML 注入 DOM,再调用 setup ——
// 旧站 7 个 tool-*.js 全都在模块顶层就 document.getElementById(...),
// 面板不存在就会拿到 null。这也是加载分成 activate / setup 两段的原因。
//
// 样式作用域化(scopeCss)住在 app/lib/css-scope.js:它是纯函数,
// 放在 lib 下才能被 node --test 直接覆盖。
import { scopeCss } from '../lib/css-scope.js';

export { scopeCss };

// 判断 toolSpec.panel 是"内联面板"还是"面板文件路径"。
//   "panel.html"                 → 文件路径,要 fetch
//   "<div class='x'>…</div>"     → 内联 HTML
//   "hello"                      → 内联纯文本(单文件形态的极简写法)
// 判据:含 HTML 标签、或不带文件扩展名 → 视为内联。
function isInlineMarkup(value) {
    if (typeof value !== 'string') return false;
    if (/<[a-zA-Z!/]/.test(value)) return true;          // 有标签
    return !/\.[a-zA-Z0-9]{1,8}$/.test(value.trim());     // 没有扩展名
}

// shouldApply() 由调用方注入,用来回答"这次挂载还算数吗"。
// 挂载全程是异步的(要 fetch 面板 HTML、跑 setup),而用户可以在它完成之前
// 就切到别的工具。此时**必须停止写入共享的容器**:如果照样把面板写进去,
// 后完成的旧挂载会覆盖新挂载的 DOM —— 表现是"选中的是 A、显示的却是 B",
// 而且不会有任何报错。调用方虽然可以在拿到 handle 后丢弃它,但那时 DOM
// 已经被写坏了,所以闸门必须设在写入之前。
export async function mountTool({
    descriptor, toolSpec, instance, container, ctx, fetchText, shouldApply = () => true,
}) {
    // 已经过期就直接返回一个空操作句柄,一个字节都不碰容器。
    if (!shouldApply()) return { teardown: async () => {} };

    container.dataset.plugin = descriptor.id;

    // 相对路径要按插件入口的 URL 解析,否则会落到外壳根目录上。
    const resolve = (relative) => new URL(relative, descriptor.entryUrl).toString();

    const panelHtml = isInlineMarkup(toolSpec.panel)
        ? toolSpec.panel
        : await fetchText(resolve(toolSpec.panel));
    // fetch 期间可能已经被取代 —— 写入前再确认一次
    if (!shouldApply()) return { teardown: async () => {} };
    container.innerHTML = panelHtml;

    let styleEl = null;
    if (toolSpec.style) {
        // 内联样式(单文件形态)与外部样式文件两种写法都支持。
        const cssText = isInlineMarkup(toolSpec.style)
            ? toolSpec.style
            : await fetchText(resolve(toolSpec.style));
        if (!shouldApply()) {
            container.innerHTML = '';
            delete container.dataset.plugin;
            return { teardown: async () => {} };
        }
        styleEl = document.createElement('style');
        styleEl.dataset.pluginStyle = descriptor.id;
        styleEl.textContent = scopeCss(cssText, descriptor.id);
        document.head.appendChild(styleEl);
    }

    // setup 可以来自两处:文件夹形态是插件模块的 setup(el, ctx),
    // 单文件形态把它写在 tools.register 的 spec 里(见设计文档 §6.2)。
    const setup = typeof toolSpec.setup === 'function' ? toolSpec.setup : instance?.setup;
    const teardown = typeof toolSpec.teardown === 'function' ? toolSpec.teardown : instance?.teardown;

    if (typeof setup === 'function') {
        await setup.call(instance ?? null, container, ctx);
    }

    let torndown = false;
    return {
        // options.clearContainer 默认 true。传 false 用于"这次挂载已经被更新的一代
        // 取代、但它的 DOM 早就被新挂载替换掉"的场景 —— 此时再清空容器会把**新的**
        // 面板一起抹掉。插件自己的 teardown 仍然要跑(它可能有别的资源要释放)。
        async teardown(options = {}) {
            // 幂等:content.js 切换工具时会先卸载上一个,不能重复跑。
            if (torndown) return;
            torndown = true;
            const clear = options.clearContainer !== false;
            if (typeof teardown === 'function') {
                try {
                    await teardown.call(instance ?? null, container, ctx);
                } catch (err) {
                    ctx.log.error('teardown 抛错', err);
                }
            }
            styleEl?.remove();
            if (clear) {
                container.innerHTML = '';
                delete container.dataset.plugin;
            }
        },
    };
}
