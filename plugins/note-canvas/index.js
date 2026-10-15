import { mountCanvas } from './canvas-view.js';
import { scopeCss } from 'toolbox://shell/lib/css-scope.js';

async function injectStyles(ctx) {
    try {
        const [baseCss, themeCss] = await Promise.all([
            fetch(new URL('./style.css', import.meta.url)).then(response => response.text()),
            fetch(new URL('./theme.css', import.meta.url)).then(response => response.text()),
        ]);
        let style=document.querySelector('style[data-plugin-style="note-canvas"]');
        if(!style){style=document.createElement('style');style.dataset.pluginStyle='note-canvas';document.head.append(style);}
        style.textContent = scopeCss(`${baseCss}\n${themeCss}`, 'note-canvas');
    } catch(error) { ctx.log.warn('笔记画布样式加载失败',error); }
}
export default { activate(ctx) {
    void injectStyles(ctx);
    ctx.panes.register({id:'note-canvas',title:'笔记画布',fullTitle:'笔记画布',mount:host=>mountCanvas(host,ctx)});
    ctx.log.info('笔记画布已登记');
} };
