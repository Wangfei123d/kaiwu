import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_ADOPTION, adoptPanes, pane, split } from '../app/lib/panel-tree.js';
test('note-canvas manifest and both adoption tables use approved pane and placement', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../plugins/note-canvas/plugin.json', import.meta.url)));
    assert.equal(manifest.id, 'note-canvas'); assert.deepEqual(manifest.permissions, ['canvas','vault','shell','log']);
    assert.deepEqual(manifest.contributes.panes, [{ id: 'note-canvas', title: '笔记画布', fullTitle: '笔记画布' }]);
    assert.deepEqual(DEFAULT_ADOPTION['note-canvas'], { anchor: 'doc', dir: 'row', sizes: [60,40] });
    const source = fs.readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
    assert.match(source, /'note-canvas':\s*\{\s*anchor:\s*'doc',\s*dir:\s*'row',\s*sizes:\s*\[60,\s*40\]/);
});
test('adoption preserves an existing saved layout containing the canvas', () => {
    const tree = split('row', [71,29], [pane('doc'), pane('note-canvas')]);
    assert.deepEqual(adoptPanes(tree, ['doc','note-canvas']), tree);
});
test('only the note-canvas main view uses two-second precise zoom layout commits', () => {
    const source = fs.readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');
    const mainNavigation = source.match(/const nav=createNavigation\(\{[\s\S]*?onSettled:/)?.[0] ?? '';
    const bodyNavigation = source.match(/scrollNav=createNavigation\(\{[\s\S]*?\}\);scrollNavigations/)?.[0] ?? '';
    assert.doesNotMatch(mainNavigation, /minFrameIntervalMs/);
    assert.match(source, /createZoomLayout\(\{[\s\S]*?intervalMs:\s*2000/);
    assert.match(source, /nc-motion/);
    assert.doesNotMatch(bodyNavigation, /minFrameIntervalMs/);
    assert.doesNotMatch(bodyNavigation, /zoomLayout/);
});
