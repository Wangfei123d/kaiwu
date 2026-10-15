/* ============================================================
   AI 会话台账 —— 插件入口

   它贡献的是**工作台里的一片面板**(不是内容区的工具面板):用户能把它拖到任何地方,
   位置进布局存档,而且天然与「AI 对话」并排 —— 那正是它要的用法:
   左边一条条历史,点一条就在右边的对话格里接着聊(dsh / ChatGPT 那栏同一种用法)。

   数据有两半,各自的主人不一样(这一点是这个面板的全部复杂度所在):
     · **历史内容**(聊过什么)只存在于开物自己写的台账里(<笔记库>/AI会话/*.md)——
       对端的 session/resume **不重放旧消息**(实测),它恢复的只是"记性";
     · **能不能接着聊**由对端说了算(session/list 里有它、或这条连接已经接上过它)。
   两半的判据都不在这个文件里:格式在 app/lib/session-record.js,
   状态在 app/lib/agent-sessions.js,主进程合成好之后经 ctx.sessions 递过来。
   ============================================================ */

// ⚠️ 这一行不是装饰:少了它,`setup` 在模块作用域里根本不存在,面板**整片不出现**,
//    而错误只出现在渲染进程控制台(`ReferenceError: setup is not defined`)——
//    自检当场红了 15 项(实测)。视图逻辑住在 panel.js,这里只负责接线。
import { setup } from './panel.js';

const PANE_ID = 'ai-session';

export default {
    activate(ctx) {
        void injectStyles(ctx);

        ctx.panes.register({
            id: PANE_ID,
            title: 'AI 会话',
            fullTitle: 'AI 会话台账(历次对话 · 接着聊)',
            mount: (host) => setup(host, ctx),
        });
        ctx.log.info('AI 会话台账:面板已登记');
    },
};

/**
 * 把插件自己的 style.css 注入到 <head>,并加上作用域。
 *
 * ⚠️ 与短剧那片同一个理由:pane 这条路**没有** mountTool 那一步(它会把工具面板的
 *    style.css fetch 回来、过 scopeCss 再塞进 <head>),外壳只造宿主 div 然后调 mount()。
 *    不自己注入,面板就是一堆无样式的块级流。
 */
async function injectStyles(ctx) {
    try {
        const { scopeCss } = await import('toolbox://shell/lib/css-scope.js');
        const url = new URL('style.css', import.meta.url).toString();
        const cssText = await (await fetch(url)).text();
        // ⚠️ owner 用**插件 id**:外壳与自检都按 `style[data-plugin-style="<pluginId>"]` 认领
        //    (短剧那片就是 'drama')。写成别的名字,样式其实注入进去了、却谁都找不到它 ——
        //    自检里那条"样式真的注入了"会假红(实测踩到)。
        const owner = ctx.plugin.id;
        let node = document.querySelector(`style[data-plugin-style="${owner}"]`);
        if (node === null) {
            node = document.createElement('style');
            node.dataset.pluginStyle = owner;
            document.head.appendChild(node);
        }
        node.textContent = scopeCss(cssText, ctx.plugin.id);
    } catch (err) {
        ctx.log.warn(`样式注入失败(面板会难看但还能用):${err?.message ?? err}`);
    }
}
