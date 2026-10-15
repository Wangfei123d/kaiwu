import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');
const addNodeBody = source.match(/function addNode\(type,fields=\{\},point\)\{([\s\S]*?)\n    \}/)?.[1] ?? '';
const doubleClickBody = source.match(/function createTextAtDoubleClick\(event\)\{([\s\S]*?)\n    \}/)?.[1] ?? '';

test('text node creation keeps the toolbar hint only when text is omitted', () => {
    assert.match(addNodeBody, /Object\.hasOwn\(fields,'text'\)/);
    assert.match(addNodeBody, /n\.text='单击选择，再次点击编辑'/);
});

test('blank canvas double click creates an empty centered text node and starts inline editing', () => {
    assert.ok(doubleClickBody, 'double-click handler exists');
    assert.match(doubleClickBody, /if\(!editable\(\)\)return/);
    assert.match(doubleClickBody, /\.nc-node,\.nc-edge/);
    assert.match(doubleClickBody, /worldPoint\(event\.clientX,event\.clientY\)/);
    assert.match(doubleClickBody, /addNode\('text',\{text:''\},point\)/);
    assert.match(doubleClickBody, /enterInlineEdit\(card,event\)/);
    assert.match(source, /listen\(canvas,'dblclick',createTextAtDoubleClick\)/);
});
