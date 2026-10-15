// ⚠️ 临时探针(跑完即删):在**旧代码**上读 §7 新断言的失败读数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPaneIds } from '../app/lib/panel-tree.js';

test('探针:旧代码上 §7 那几条新断言的读数', async () => {
    const mod = await import('../app/lib/panel-tree.js');
    const out = { hasMoveTabToEdge: typeof mod.moveTabToEdge, hasNextSlotSeq: typeof mod.nextSlotSeq };
    try {
        const t = mod.split('row', [23, 51, 26], [
            mod.pane('slot:7', [{ view: 'doc', doc: '甲篇.md' }, { view: 'doc', doc: '乙篇.md' }], 0),
            mod.pane('doc'), mod.pane('links'),
        ]);
        out.edge = mod.moveTabToEdge(t, 'slot:7', 0, 'links', 'right');
    } catch (err) { out.edge = `THROW ${err.message}`; }
    try { out.nextSlotSeq = mod.nextSlotSeq(mod.defaultTree()); }
    catch (err) { out.nextSlotSeq = `THROW ${err.message}`; }
    const store = await import('../app/lib/panel-layout-store.js');
    out.layoutVersion = store.LAYOUT_VERSION;
    const merged = mod.pane('slot:1', [
        { view: 'notes' }, { view: 'doc', doc: '甲篇.md' }, { view: 'links' }, { view: 'ai' },
    ], 3);
    const r = store.decodeLayoutResult(store.encodeLayout(merged), ['notes', 'doc', 'links', 'ai']);
    out.mergedOk = r.ok;
    out.mergedIds = listPaneIds(r.tree);
    out.mergedTabCount = (mod.findPane(r.tree, 'slot:1')?.tabs ?? []).length;
    console.log('PROBE-READING ' + JSON.stringify(out));
    assert.ok(true);
});
