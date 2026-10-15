// 通用贡献点注册表。与贡献点种类无关 —— 本阶段实例化 tools / services 两类,
// 子项目 2 新增 settings / themes / commands / statusbar 只需再 new 一个实例,
// 不用改运行时。
export function createRegistry(kind) {
    const items = new Map();
    const listeners = new Set();

    function notify() {
        for (const cb of listeners) {
            try {
                cb();
            } catch (err) {
                // 订阅者自己的异常不能影响注册表的其他订阅者
                console.error(`[registries:${kind}] onChange 回调抛错`, err);
            }
        }
    }

    return {
        kind,

        // 返回 true 表示登记成功;false 表示被拒绝(id 缺失或重复)。
        // 刻意不抛异常:调用方是插件,一次重复注册不该炸掉整个激活流程。
        define(spec) {
            if (!spec || typeof spec.id !== 'string' || spec.id === '') return false;
            if (items.has(spec.id)) return false;
            items.set(spec.id, { order: 1000, ...spec });
            notify();
            return true;
        },

        get(id) {
            return items.get(id) ?? null;
        },

        // 返回快照(复制每一项),外部改动不会污染注册表内部状态。
        list() {
            return [...items.values()]
                .sort((a, b) => {
                    if (a.order !== b.order) return a.order - b.order;
                    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                })
                .map(item => ({ ...item }));
        },

        // 插件激活失败时用它回滚,避免留下"幽灵工具"。
        // 没有任何项被移除时不发通知 —— 没变化就不要惊动订阅者。
        removeByPlugin(pluginId) {
            let removed = false;
            for (const [id, spec] of items) {
                if (spec.pluginId === pluginId) {
                    items.delete(id);
                    removed = true;
                }
            }
            if (removed) notify();
        },

        onChange(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
    };
}

export function createRegistries() {
    return {
        tools: createRegistry('tools'),
        services: createRegistry('services'),
        // 平铺工作台的一片面板(笔记列表 / 笔记正文 / 链接 / AI 对话是外壳自带的四片,
        // 插件带来的第五片走这里)。与 tools 分开:工具面板住在**内容区**,
        // 而 pane 参与布局树 —— 能被拖、能停靠、进布局存档,两者的生命周期与归宿都不同。
        panes: createRegistry('panes'),
    };
}
