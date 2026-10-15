import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const style = fs.readFileSync(new URL('../plugins/note-canvas/style.css', import.meta.url), 'utf8');
const view = fs.readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');

test('connection ports stay hidden until the pointer is near one port', () => {
    assert.ok(/\.nc-pane \.nc-port:not\(\.nearby\):not\(\.connecting\):not\(:focus-visible\)\{[^}]*opacity:0[^}]*pointer-events:none/.test(style), 'base ports are hidden and do not intercept pointer events');
    assert.ok(/\.nc-pane \.nc-port\{transition:opacity[^}]*transform/.test(style), 'port appearance is smoothly animated');
    assert.ok(/\.nc-port\.nearby/.test(style), 'the nearby port is revealed');
    assert.ok(/\.nc-pane \.nc-port:not\(\.nearby\):not\(\.connecting\)/.test(style), 'the hidden-state rule overrides legacy hover and selection selectors');
    assert.ok(/nearestDistance\s*=\s*54/.test(view), 'the reveal radius is bounded to 54 screen pixels');
});

test('pointer movement updates the nearest port even when no drag gesture is active', () => {
    const match = view.match(/function pointerMove\(event\)\{([\s\S]*?)\n\s*function pointerUp/);
    assert.ok(match, 'pointerMove handler is present');
    const revealAt = match[1].indexOf('revealNearestPort(event)');
    const earlyReturnAt = match[1].indexOf('if(!gesture)return');
    assert.ok(revealAt >= 0 && revealAt < earlyReturnAt,
        'proximity is checked before the no-gesture early return');
});

test('the connection source remains visible and proximity state clears when leaving the canvas', () => {
    assert.ok(/\.nc-port\.connecting/.test(style), 'connecting source remains revealed');
    assert.ok(/listen\(canvas,'pointerleave',clearNearbyPort\)/.test(view), 'proximity state clears when leaving the canvas');
});

test('node resize handle keeps resizing but has no diagonal corner decoration', () => {
    const resizeRules = [...style.matchAll(/\.nc-resize\{([^}]+)\}/g)].map(match => match[1]);
    assert.ok(resizeRules.length, 'resize handle rule is present');
    assert.ok(resizeRules.some(rule => /cursor:nwse-resize/.test(rule)), 'resize cursor remains available');
    assert.ok(/\.nc-pane \.nc-resize\{background:none\}/.test(style), 'the override outranks the legacy resize rule');
});
