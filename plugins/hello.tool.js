// 单文件插件示例。一个文件就是一整个工具:清单、面板 HTML、逻辑全在里面。
// 适合快速丢一个小工具进来;需要后台服务时请升级成文件夹形态
// (单文件形态刻意不允许声明服务,理由见设计文档 §6.2)。
export default {
    manifest: {
        id: 'hello',
        name: '单文件示例',
        version: '1.0.0',
        description: '演示单文件插件形态:一个文件就是一个工具',
        permissions: ['log'],
    },

    activate(ctx) {
        // 只注册贡献点。面板 HTML 内联在下面,不碰 DOM ——
        // 此时面板还没有被注入(见设计文档 §5.3)。
        ctx.tools.register({
            id: 'hello',
            title: '单文件示例',
            icon: 'sparkle',
            order: 9999,
            workspacePane: true,
            panel: `
                <div class="tool-block">
                    <h3>单文件插件</h3>
                    <p class="tool-block-desc">
                        这个工具的全部内容都写在 <code>plugins/hello.tool.js</code> 一个文件里:
                        清单、面板 HTML、逻辑。适合快速丢一个小工具进来。
                    </p>
                    <p class="hint" id="helloStamp"></p>
                </div>`,

            // 单文件形态的 setup 写在注册的 spec 里(文件夹形态则写在模块的
            // 默认导出上)。运行时两种都认。
            setup(el, ctx) {
                el.querySelector('#helloStamp').textContent =
                    `插件 ${ctx.plugin.id} v${ctx.plugin.version} 已激活`;
            },
        });
    },
};
