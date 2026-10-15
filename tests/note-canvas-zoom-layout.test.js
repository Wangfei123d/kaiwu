import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomLayout } from '../plugins/note-canvas/zoom-layout.js';

function fakeClock() {
    let time = 0, nextId = 0;
    const timers = new Map();
    return {
        now: () => time,
        setTimer(fn, delay) { const id = ++nextId; timers.set(id, { at: time + delay, fn }); return id; },
        clearTimer(id) { timers.delete(id); },
        advance(ms) {
            const end = time + ms;
            while (true) {
                const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!due || due[1].at > end) break;
                time = due[1].at; timers.delete(due[0]); due[1].fn();
            }
            time = end;
        },
        get pending() { return timers.size; },
    };
}

test('visual ratio tracks every update but layout commits latest scale at 2000ms', () => {
    const clock = fakeClock(), layouts = [];
    const zoom = createZoomLayout({ initialScale: 1, intervalMs: 2000, ...clock,
        onLayoutScale: scale => layouts.push({ at: clock.now(), scale }) });
    zoom.sync(1);
    assert.equal(zoom.update(1.2), 1.2);
    clock.advance(1000);
    assert.equal(zoom.update(1.8), 1.8);
    assert.deepEqual(layouts.map(item => item.scale), [1]);
    clock.advance(999);
    assert.deepEqual(layouts.map(item => item.scale), [1]);
    clock.advance(1);
    assert.deepEqual(layouts, [{ at: 0, scale: 1 }, { at: 2000, scale: 1.8 }]);
    assert.equal(zoom.update(1.8), 1);
    zoom.dispose();
});

test('returning to committed scale cancels pending layout and pure pan needs no reflow', () => {
    const clock = fakeClock(), layouts = [];
    const zoom = createZoomLayout({ initialScale: 1, intervalMs: 2000, ...clock,
        onLayoutScale: scale => layouts.push(scale) });
    zoom.sync(1);
    assert.equal(zoom.update(1.5), 1.5);
    assert.equal(zoom.update(1), 1);
    clock.advance(2000);
    assert.deepEqual(layouts, [1]);
    assert.equal(clock.pending, 0);
    zoom.dispose();
});

test('sync commits immediately and dispose cancels a waiting final layout', () => {
    const clock = fakeClock(), layouts = [];
    const zoom = createZoomLayout({ initialScale: 1, intervalMs: 2000, ...clock,
        onLayoutScale: scale => layouts.push({ at: clock.now(), scale }) });
    zoom.sync(1);
    assert.equal(zoom.update(1.7), 1.7);
    clock.advance(700);
    zoom.sync(1.4);
    assert.deepEqual(layouts, [{ at: 0, scale: 1 }, { at: 700, scale: 1.4 }]);
    zoom.update(1.8);
    zoom.dispose();
    clock.advance(3000);
    assert.deepEqual(layouts, [{ at: 0, scale: 1 }, { at: 700, scale: 1.4 }]);
    assert.equal(clock.pending, 0);
});
