/** 管理工作台工具 pane 的惰性挂载与卸载。 */
export function createPaneLifecycle({ mountPane } = {}) {
    const openViewIds = new Set();
    const mounted = new Map();
    const mounting = new Map();
    let disposed = false;

    const teardown = async (handle) => {
        const fn = typeof handle === 'function' ? handle : handle?.teardown;
        if (typeof fn !== 'function') return;
        try {
            await fn.call(handle);
        } catch (error) {
            console.warn('[workspace] pane teardown 抛错', error);
        }
    };

    const reconcile = (viewIds) => {
        const next = new Set(Array.isArray(viewIds)
            ? viewIds.filter((id) => typeof id === 'string' && id !== '')
            : []);
        for (const id of openViewIds) {
            if (!next.has(id)) {
                openViewIds.delete(id);
                // 删除正在进行的条目会使它的 Promise 过期;新一轮重新打开可立即重新挂载。
                mounting.delete(id);
            }
        }
        for (const id of next) openViewIds.add(id);

        const cleanups = [];
        for (const [id, record] of mounted) {
            if (next.has(id)) continue;
            mounted.delete(id);
            cleanups.push(teardown(record.handle));
        }
        return Promise.all(cleanups).then(() => undefined);
    };

    return {
        async activate(viewId, host) {
            if (disposed || !openViewIds.has(viewId) || typeof mountPane !== 'function') return null;
            const existing = mounted.get(viewId);
            if (existing) return existing.handle;
            const pending = mounting.get(viewId);
            if (pending) return pending.promise;

            const record = { host, promise: null };
            record.promise = Promise.resolve()
                .then(() => mountPane(viewId, host))
                .then(async (handle) => {
                    // 如果布局已移除或视图被重新打开并启动了另一轮挂载,不能提交这份旧结果。
                    if (disposed || !openViewIds.has(viewId) || mounting.get(viewId) !== record) {
                        await teardown(handle);
                        return null;
                    }
                    mounting.delete(viewId);
                    mounted.set(viewId, { host, handle });
                    return handle;
                })
                .catch((error) => {
                    if (mounting.get(viewId) === record) mounting.delete(viewId);
                    throw error;
                });
            mounting.set(viewId, record);
            return record.promise;
        },

        reconcile,

        async dispose() {
            disposed = true;
            await reconcile([]);
        },
    };
}
