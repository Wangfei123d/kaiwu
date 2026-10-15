import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapBoxToCanvas, snapGroupPositions } from '../plugins/drama/snap-alignment.js';

test('近到阈值内时，节点左右边缘和上下边缘吸附到参考线', () => {
    const result = snapBoxToCanvas({
        box: { x: 104, y: 162, width: 150, height: 60 },
        anchors: [{ x: 100, y: 100, width: 150, height: 60 }],
        view: { x: 0, y: 0, scale: 1 },
    });

    assert.deepEqual(result, {
        x: 100, y: 160, guideX: 100, guideY: 160, gridX: false, gridY: false,
    });
});

test('参考线命中一个轴，另一个轴仍按画布网格吸附', () => {
    const result = snapBoxToCanvas({
        box: { x: 104, y: 200, width: 150, height: 60 },
        anchors: [{ x: 100, y: 100, width: 150, height: 60 }],
        view: { x: 0, y: 0, scale: 1 },
    });

    assert.equal(result.x, 100);
    assert.equal(result.guideX, 100);
    assert.equal(result.gridX, false);
    assert.equal(result.y, 198);
    assert.equal(result.guideY, null);
    assert.equal(result.gridY, true);
});

test('画布平移和缩放后，网格吸附仍落在可见的 22px 网格线上', () => {
    const result = snapBoxToCanvas({
        box: { x: 104, y: 100, width: 150, height: 60 },
        anchors: [],
        view: { x: 11, y: -7, scale: 2 },
    });

    assert.equal(result.x, 104.5);
    assert.equal(result.y, 102.5);
    assert.equal(result.guideX, null);
    assert.equal(result.guideY, null);
    assert.equal(result.gridX, true);
    assert.equal(result.gridY, true);
});

test('多选节点作为整体吸附，节点之间的相对位置保持不变', () => {
    const result = snapGroupPositions({
        nodes: [
            { id: 'a', x: 104, y: 162, width: 150, height: 60 },
            { id: 'b', x: 280, y: 220, width: 150, height: 60 },
        ],
        anchors: [{ id: 'anchor', x: 100, y: 100, width: 150, height: 60 }],
        view: { x: 0, y: 0, scale: 1 },
    });

    assert.deepEqual(result.positions, [
        { id: 'a', x: 100, y: 160 },
        { id: 'b', x: 276, y: 218 },
    ]);
    assert.equal(result.guideX, 100);
    assert.equal(result.guideY, 160);
});
