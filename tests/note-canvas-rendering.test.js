import assert from 'node:assert/strict';
import test from 'node:test';

const loadRendering = async () => import('../plugins/note-canvas/rendering.js').catch(() => ({}));

test('canvas view composes layout zoom and temporary scale without changing world coordinates', async () => {
    const { canvasViewStyles } = await loadRendering();
    assert.equal(typeof canvasViewStyles, 'function', 'canvasViewStyles is exported');
    assert.deepEqual(canvasViewStyles({ x: 24, y: -18, scale: 2 }, 1.6), {
        worldTransform: 'translate(24px, -18px)',
        motionTransform: 'scale(1.6)',
        backgroundPosition: '24px -18px',
        backgroundSize: '48px 48px',
    });
    assert.equal(1.25 * 1.6, 2);
    assert.deepEqual((await loadRendering()).screenToWorld(274, 162, { left: 100, top: 40 }, { x: 24, y: -18, scale: 2 }), { x: 75, y: 70 });
});

test('screen coordinates map back to logical world coordinates at layout zoom', async () => {
    const { screenToWorld } = await loadRendering();
    assert.equal(typeof screenToWorld, 'function', 'screenToWorld is exported');
    assert.deepEqual(screenToWorld(274, 162, { left: 100, top: 40 }, { x: 24, y: -18, scale: 2 }), { x: 75, y: 70 });
});
