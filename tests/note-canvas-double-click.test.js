import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');
const addNodeBody = source.match(/function addNode\(type,fields=\{\},point\)\{([\s\S]*?)\n    \}/)?.[1] ?? '';

test('text node creation keeps the toolbar hint only when text is omitted', () => {
    assert.match(addNodeBody, /Object\.hasOwn\(fields,'text'\)/);
    assert.match(addNodeBody, /n\.text='单击选择，再次点击编辑'/);
});

// The actual double-click gesture is covered in tools/check-note-canvas.cjs --double-click.
