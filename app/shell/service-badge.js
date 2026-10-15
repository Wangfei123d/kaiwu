// 共享的「服务状态徽标 + 启动按钮」组件。插件面板里复用。
//
// 为什么抽出来:music / douyin / bilibili 三个插件都需要同一套东西 ——
// 显示服务状态、给一个启动按钮、把失败原因说清楚。早先 music 自己写了一遍,
// 再往两个插件里各抄一遍就是三份会各自漂移的代码。
//
// 用法(面板 HTML 里放一个容器):
//   <div class="svc" id="xxxService"></div>
//
//   const badge = createServiceBadge({
//       el: panel.querySelector('#xxxService'),
//       ctx, serviceId: 'douyin',
//       hint: '点了「启动服务」才会开始解析',
//   });
//   badge.start();          // 初始拉一次状态并订阅
//   badge.dispose();        // teardown 时调用
//
// 约定:面板容器里这些元素由组件**自己创建**,插件 HTML 不需要预置,
// 这样三处用法完全一致,也便于以后统一改视觉。

const STATUS_TEXT = {
    stopped: '未启动',
    starting: '启动中…',
    ready: '运行中',
    external: '已在运行(接管)',
    stopping: '停止中…',
    failed: '启动失败',
};

const RUNNING = new Set(['ready', 'external', 'starting']);

export function createServiceBadge({ el, ctx, serviceId, hint = '', startLabel = '启动服务' }) {
    if (!el) return { start() {}, dispose() {} };

    const dot = document.createElement('span');
    dot.className = 'status-dot';

    const label = document.createElement('span');
    label.className = 'svc-state';
    label.textContent = '服务状态未知';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm';
    button.textContent = startLabel;

    const hintEl = document.createElement('span');
    hintEl.className = 'hint svc-hint';

    el.classList.add('svc');
    el.append(dot, label, button, hintEl);

    let disposed = false;

    function render(state) {
        if (disposed || !state) return;
        label.textContent = STATUS_TEXT[state.status] ?? state.status;
        dot.dataset.status = state.status;
        hintEl.textContent = state.error ? state.error : (state.status === 'stopped' ? hint : '');
        // 接管来的服务不归我们管;正在跑的也不必再点
        button.disabled = RUNNING.has(state.status);
    }

    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const state = await ctx.services.start(serviceId);
            render(state);
        } catch (err) {
            ctx.log.error(`启动服务 ${serviceId} 失败`, err);
            button.disabled = false;
            hintEl.textContent = '启动失败:' + err.message;
        }
    });

    const off = ctx.services.on(serviceId, 'change', render);
    // 面板打开时先拉一次(服务可能在应用启动时就已接管)
    ctx.services.status(serviceId).then(render).catch(() => {});

    return {
        start() { /* 订阅已在构造时建立 */ },
        dispose() {
            disposed = true;
            off?.();
        },
    };
}
