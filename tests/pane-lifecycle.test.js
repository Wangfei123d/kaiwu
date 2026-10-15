import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaneLifecycle } from '../app/lib/pane-lifecycle.js';

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

test('同一已打开视图重复或并发 activate 只挂载一次', async () => {
    let mounts = 0;
    const handle = { teardown() {} };
    const lifecycle = createPaneLifecycle({
        async mountPane() { mounts += 1; return handle; },
    });
    lifecycle.reconcile(['tool:palette']);

    const first = lifecycle.activate('tool:palette', {});
    const second = lifecycle.activate('tool:palette', {});
    assert.equal(await first, handle);
    assert.equal(await second, handle);
    assert.equal(await lifecycle.activate('tool:palette', {}), handle);
    assert.equal(mounts, 1);
});

test('仍在布局中的 pane 切换活动标签不会 teardown', async () => {
    let teardowns = 0;
    const lifecycle = createPaneLifecycle({
        async mountPane() { return { teardown() { teardowns += 1; } }; },
    });
    lifecycle.reconcile(['tool:music', 'notes']);
    await lifecycle.activate('tool:music', {});

    // 同一组打开视图、活动标签改变，不代表 pane 被移出布局。
    lifecycle.reconcile(['tool:music', 'notes']);
    assert.equal(teardowns, 0);
    lifecycle.reconcile(['notes']);
    assert.equal(teardowns, 1);
});

test('pane 从布局移除时 teardown 一次', async () => {
    let teardowns = 0;
    const lifecycle = createPaneLifecycle({
        async mountPane() { return { teardown() { teardowns += 1; } }; },
    });
    lifecycle.reconcile(['tool:subtitle']);
    await lifecycle.activate('tool:subtitle', {});

    lifecycle.reconcile([]);
    lifecycle.reconcile([]);
    assert.equal(teardowns, 1);
});

test('异步挂载完成前 pane 被移除,句柄返回后立即 teardown', async () => {
    const pending = deferred();
    let mounts = 0;
    let teardowns = 0;
    const handle = { teardown() { teardowns += 1; } };
    const lifecycle = createPaneLifecycle({
        mountPane() { mounts += 1; return mounts === 1 ? pending.promise : handle; },
    });
    lifecycle.reconcile(['tool:douyin']);
    const activation = lifecycle.activate('tool:douyin', {});
    lifecycle.reconcile([]);
    pending.resolve({ teardown() { teardowns += 1; } });
    await activation;

    assert.equal(teardowns, 1);
    lifecycle.reconcile(['tool:douyin']);
    await lifecycle.activate('tool:douyin', {});
    assert.equal(mounts, 2, '过期挂载不能占住 in-flight 表,视图重新打开后可以再挂一次');
});
