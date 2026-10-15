import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../plugins/note-canvas/style.css', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');
const worldRule = css.match(/\.nc-world\s*\{([^}]*)\}/)?.[1] ?? '';

test('note canvas world does not permanently force transform compositing for text', () => {
    assert.ok(worldRule, 'the note canvas world rule exists');
    assert.doesNotMatch(worldRule, /\bwill-change\s*:\s*transform\b/i);
    assert.match(worldRule, /\btransform-origin\s*:\s*0\s+0\b/i);
});

test('node text, connections and marquee share a motion layer inside precise layout zoom', () => {
    assert.match(css, /\.nc-zoom\s*\{[^}]*position:\s*absolute[^}]*\}/);
    assert.match(css, /\.nc-motion\s*\{[^}]*transform-origin:\s*0\s+0[^}]*\}/);
    assert.match(viewSource, /motionLayer\.append\(svg,nodes\);zoomLayer\.append\(motionLayer\);world\.append\(zoomLayer\)/);
    assert.match(viewSource, /motionLayer\.append\(marquee\)/, 'The selection box uses the same effective zoom transform as nodes');
    assert.doesNotMatch(viewSource, /world\.append\(marquee\)/, 'The selection box is not left in the translation-only layer');
    assert.match(viewSource, /onLayoutScale:scale=>\{[^}]*motionLayer\.style\.transform=['"]scale\(1\)['"]/, 'A precise zoom commit clears the temporary motion scale');
    assert.match(viewSource, /zoomLayer\.style\.zoom\s*=/);
    assert.doesNotMatch(viewSource, /world\.style\.transform\s*=\s*`translate\([^`]*scale\(/);
});
