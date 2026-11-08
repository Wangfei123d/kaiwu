import { setup } from './panel.js';

export default {
    activate(ctx) {
        void injectStyles(ctx);
        ctx.panes.register({
            id: 'agent-skills',
            title: 'Skills',
            fullTitle: 'Agent Skills',
            mount: host => setup(host, ctx),
        });
    },
};

async function injectStyles(ctx) {
    try {
        const { scopeCss } = await import('toolbox://shell/lib/css-scope.js');
        const url = new URL('style.css', import.meta.url).toString();
        const cssText = await (await fetch(url)).text();
        let node = document.querySelector('style[data-plugin-style="agent-skills"]');
        if (!node) {
            node = document.createElement('style');
            node.dataset.pluginStyle = 'agent-skills';
            document.head.appendChild(node);
        }
        node.textContent = scopeCss(cssText, 'agent-skills');
    } catch (err) {
        ctx.log.warn(`样式注入失败:${err?.message ?? err}`);
    }
}
