import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigation } from '../plugins/note-canvas/navigation.js';

function clock(options = {}) {
    let time = 0, next = 0; const frames = new Map(); const seen = [];
    const nav = createNavigation({ view: { x: 0, y: 0, scale: 1 },
        requestFrame: fn => { frames.set(++next, fn); return next; }, cancelFrame: id => frames.delete(id),
        now: () => time, onFrame: v => seen.push(v), ...options });
    return { nav, seen, get pending() { return frames.size; },
        step(dt = 16) { time += dt; const queued = [...frames.values()]; frames.clear(); queued.forEach(fn => fn(time)); },
        settle() { for (let i = 0; frames.size && i < 1000; i++) this.step(); assert.equal(frames.size, 0); } };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test('pan advances over multiple frames without overshoot and accumulates reversal', () => {
    const c = clock(); c.nav.pan(-100, -60, false); assert.equal(c.nav.view.x, 0);
    c.step(); assert.ok(c.nav.view.x < 0 && c.nav.view.x > -100);
    c.nav.pan(40, 0, false); c.settle(); close(c.nav.view.x, -60); close(c.nav.view.y, -60);
    assert.ok(c.seen.length > 2);
});
test('trackpad responds faster than discrete wheel', () => {
    const a = clock(), b = clock(); a.nav.pan(100, 0, false); b.nav.pan(100, 0, true);
    a.step(38); b.step(38); assert.ok(b.nav.view.x > a.nav.view.x); a.nav.dispose(); b.nav.dispose();
});
test('pan exponential integration is independent of frame interval', () => {
    const a = clock(), b = clock(); a.nav.pan(100, 40); b.nav.pan(100, 40);
    a.step(100); for (let i = 0; i < 10; i++) b.step(10);
    close(a.nav.view.x, b.nav.view.x); close(a.nav.view.y, b.nav.view.y);
});
test('zoom preserves local pointer world anchor on every frame and respects bounds', () => {
    const c = clock(); c.nav.set({ x: 30, y: -20, scale: 1.2 });
    const anchor = { x: (250 - 30) / 1.2, y: (180 + 20) / 1.2 };
    c.nav.zoom(2, 250, 180);
    for (let i = 0; i < 25; i++) { c.step(); close((250 - c.nav.view.x) / c.nav.view.scale, anchor.x); close((180 - c.nav.view.y) / c.nav.view.scale, anchor.y); }
    c.settle(); close(c.nav.view.scale, 2.4); c.nav.zoom(100, 250, 180); c.settle(); close(c.nav.view.scale, 2.5);
    c.nav.zoom(0.0001, 250, 180); c.settle(); close(c.nav.view.scale, .25);
});
test('minimum frame interval coalesces published views while the navigation state keeps advancing', () => {
    const c = clock({ minFrameIntervalMs: 25 });
    c.nav.zoom(2, 250, 180);

    c.step(25);
    const firstPublishedScale = c.seen.at(-1).scale;
    const publishedCount = c.seen.length;
    const anchor = { x: 250, y: 180 };

    c.step(16);
    assert.equal(c.seen.length, publishedCount, '未到 25ms 时不应重复发布节点布局');
    assert.ok(c.nav.view.scale > firstPublishedScale, '内部导航插值仍应逐帧前进');
    c.step(8);
    assert.equal(c.seen.length, publishedCount, '24ms 仍应合并中间帧');
    c.step(1);
    assert.equal(c.seen.length, publishedCount + 1, '达到 25ms 后应发布最新视图');
    for (const view of c.seen) {
        close((anchor.x - view.x) / view.scale, anchor.x);
        close((anchor.y - view.y) / view.scale, anchor.y);
    }
});
test('settled and explicitly stopped navigation publish the exact visible final view', () => {
    const settled = [];
    const c = clock({ minFrameIntervalMs: 25, onSettled: view => settled.push(view) });
    c.nav.zoom(1.8, 120, 90);
    c.settle();
    assert.deepEqual(c.seen.at(-1), c.nav.view);
    assert.deepEqual(settled.at(-1), c.nav.view);

    c.nav.pan(90, 0);
    c.step(25);
    c.step(8);
    const beforeStop = c.seen.length;
    c.nav.stop();
    assert.equal(c.seen.length, beforeStop + 1, '停止时应立即补上尚未发布的最新视图');
    assert.deepEqual(c.seen.at(-1), c.nav.view);

    c.nav.set({ x: 7, y: 8, scale: 1.25 });
    assert.deepEqual(c.seen.at(-1), c.nav.view, '直接设置视图不应受节流影响');

    const instant = clock({ minFrameIntervalMs: 25, reducedMotion: true });
    instant.nav.zoom(1.4, 120, 90);
    assert.deepEqual(instant.seen.at(-1), instant.nav.view, '减少动态效果模式仍应立即发布');
    assert.equal(instant.pending, 0);
});
test('successive reversing zoom events accumulate continuously', () => {
    const c = clock(); c.nav.zoom(1.5, 100, 100); c.step(); c.nav.zoom(1 / 1.5, 100, 100); c.settle(); close(c.nav.view.scale, 1);
});
test('reduced motion updates immediately and suppresses coast', () => {
    const c = clock({ reducedMotion: () => true }); c.nav.pan(50, 20); close(c.nav.view.x, 50);
    c.nav.zoom(2, 0, 0); close(c.nav.view.scale, 2); c.nav.coast(2, 1); assert.equal(c.pending, 0);
});
test('stop, set and disposal cancel remaining frames', () => {
    const c = clock(); c.nav.pan(100, 0); c.step(); const x = c.nav.view.x;
    c.nav.stop(); c.step(); close(c.nav.view.x, x); assert.equal(c.pending, 0);
    c.nav.pan(100, 0); c.nav.set({ x: 9, y: 8, scale: 1 }); assert.equal(c.pending, 0);
    c.nav.pan(100, 0); c.nav.dispose(); c.nav.pan(100, 0); c.step(); close(c.nav.view.x, 9);
});
test('coast decays with 95ms constant and total distance stays within 75px', () => {
    const a = clock(), b = clock(); a.nav.coast(20, 10); b.nav.coast(20, 10);
    a.step(95); for (let i = 0; i < 19; i++) b.step(5); close(a.nav.view.x, b.nav.view.x);
    a.settle(); b.settle(); assert.ok(Math.hypot(a.nav.view.x, a.nav.view.y) <= 75.00001);
});
test('initial invalid viewport falls back to finite values and clamps scale',()=>{
    const c=clock({view:{x:NaN,y:Infinity,scale:99}});assert.deepEqual(c.nav.view,{x:0,y:0,scale:2.5});c.nav.dispose();
    const d=clock({view:{scale:NaN}});assert.deepEqual(d.nav.view,{x:0,y:0,scale:1});d.nav.dispose();
});
test('onFrame can stop or dispose without a frame being resurrected',()=>{
    let c;c=clock({onFrame:()=>c.nav.stop()});c.nav.pan(100,0);c.step();assert.equal(c.pending,0);
    let d;d=clock({onFrame:()=>d.nav.dispose()});d.nav.pan(100,0);d.step();assert.equal(d.pending,0);
});
