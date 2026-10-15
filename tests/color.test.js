import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, rgbToHex, hexToHsl, hslToHex, hslToRgb } from '../app/lib/color.js';

test('hexToRgb 基本转换', () => {
    assert.deepEqual(hexToRgb('#7ec8ff'), { r: 126, g: 200, b: 255 });
});

test('hexToRgb 支持 #abc 简写', () => {
    assert.deepEqual(hexToRgb('#abc'), { r: 170, g: 187, b: 204 });
});

test('rgbToHex 补零到两位', () => {
    assert.equal(rgbToHex(0, 15, 255), '#000fff');
});

test('rgbToHex 会夹住越界值', () => {
    assert.equal(rgbToHex(-5, 300, 128), '#00ff80');
});

test('hex → hsl → hex 往返一致', () => {
    for (const hex of ['#7ec8ff', '#000000', '#ffffff', '#ff0000', '#12ab34']) {
        assert.equal(hslToHex(...Object.values(hexToHsl(hex)).slice(0, 3)), hex);
    }
});

test('hslToRgb 对负角度取模正确', () => {
    // -30 度等价于 330 度;JS 里 -30 % 360 === -30,这里最容易写错
    const a = hslToRgb(-30, 100, 50);
    const b = hslToRgb(330, 100, 50);
    assert.deepEqual(a, b);
});

test('灰色没有色相', () => {
    const { h, s } = hexToHsl('#808080');
    assert.equal(s, 0);
    assert.equal(h, 0);
});
