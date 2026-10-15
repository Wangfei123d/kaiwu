import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeHitSizes, resizeNodeBox } from '../plugins/drama/node-resize.js';

const box = { x: 40, y: 60, width: 150, height: 120 };

test('右边和下边按画布缩放后的位移拉长节点', () => {
    assert.deepEqual(resizeNodeBox({
        box, direction: 'se', clientDx: 40, clientDy: 30, scale: 2,
        minWidth: 100, minHeight: 80,
    }), { x: 40, y: 60, width: 170, height: 135 });
});

test('左上角拉伸时右下角保持固定', () => {
    assert.deepEqual(resizeNodeBox({
        box, direction: 'nw', clientDx: 40, clientDy: 20, scale: 2,
        minWidth: 100, minHeight: 80,
    }), { x: 60, y: 70, width: 130, height: 110 });
});

test('单边拉伸不改变另一轴，且缩到下限时对侧边缘仍固定', () => {
    assert.deepEqual(resizeNodeBox({
        box, direction: 'w', clientDx: 500, clientDy: 80, scale: 1,
        minWidth: 100, minHeight: 80,
    }), { x: 90, y: 60, width: 100, height: 120 });
    assert.deepEqual(resizeNodeBox({
        box, direction: 'n', clientDx: 80, clientDy: 500, scale: 1,
        minWidth: 100, minHeight: 110,
    }), { x: 40, y: 70, width: 150, height: 110 });
});

test('命中区在画布缩放后仍保持屏幕上的可抓宽度', () => {
    assert.deepEqual(resizeHitSizes(1), { edge: 8, corner: 12 });
    assert.deepEqual(resizeHitSizes(0.25), { edge: 32, corner: 48 });
    assert.deepEqual(resizeHitSizes(2), { edge: 4, corner: 6 });
});
