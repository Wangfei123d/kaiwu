import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyMarqueeSelection,
    clientToWorldPoint,
    finishMarqueeSelection,
    intersectingNodeIds,
    normalizeSelectionRect,
} from '../plugins/drama/marquee-selection.js';

test('反向拖动仍归一化为正宽高矩形', () => {
    assert.deepEqual(
        normalizeSelectionRect({ x: 140, y: 100 }, { x: 20, y: 30 }),
        { x: 20, y: 30, width: 120, height: 70 },
    );
});

test('节点边缘与框线相碰也算命中，完全离开的节点不选中', () => {
    const hitIds = intersectingNodeIds(
        { x: 10, y: 10, width: 40, height: 30 },
        [
            { id: 'inside', x: 20, y: 20, width: 20, height: 10 },
            { id: 'touching', x: 50, y: 12, width: 15, height: 12 },
            { id: 'outside', x: 51, y: 41, width: 10, height: 10 },
        ],
    );

    assert.deepEqual(hitIds, ['inside', 'touching']);
});

test('平移和缩放后的客户端点正确转换为画布世界坐标', () => {
    assert.deepEqual(
        clientToWorldPoint({
            clientX: 170,
            clientY: 130,
            canvasRect: { left: 100, top: 50 },
            view: { x: 20, y: 10, scale: 2 },
        }),
        { x: 25, y: 35 },
    );
});

test('普通框选替换旧选区，Shift 框选追加并去重', () => {
    assert.deepEqual(
        [...applyMarqueeSelection(new Set(['old']), ['a', 'b'], { additive: false })],
        ['a', 'b'],
    );
    assert.deepEqual(
        [...applyMarqueeSelection(new Set(['a', 'old']), ['a', 'b'], { additive: true })],
        ['a', 'old', 'b'],
    );
});

test('空白单击清选，而指针取消保留原选区', () => {
    assert.deepEqual(
        [...finishMarqueeSelection(new Set(['old']), [], { moved: false })],
        [],
    );
    assert.deepEqual(
        [...finishMarqueeSelection(new Set(['old']), ['new'], { moved: true, cancelled: true })],
        ['old'],
    );
});
