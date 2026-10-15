import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAutoStart, autoStartKey } from '../app/lib/service-autostart.js';

// 「随应用启动」的决策必须只有一处实现:主进程用它决定拉不拉起服务,
// 状态条的勾选框用它决定显示什么。这两者不一致时,界面会撒谎
// (服务真的起来了、勾选框却是空的)—— 所以这里把优先级钉死。

test('清单声明 autoStart: true → 随应用启动', () => {
    assert.equal(shouldAutoStart({ autoStart: true }, undefined), true);
});

test('清单没声明(或声明 false)→ 不自动启动', () => {
    assert.equal(shouldAutoStart({ autoStart: false }, undefined), false);
    assert.equal(shouldAutoStart({}, undefined), false);
    assert.equal(shouldAutoStart(null, undefined), false);
});

test('用户的设置覆盖清单,两个方向都要能覆盖', () => {
    // 清单说启动、用户关掉
    assert.equal(shouldAutoStart({ autoStart: true }, false), false);
    // 清单没说、用户打开
    assert.equal(shouldAutoStart({ autoStart: false }, true), true);
});

test('null 表示"用户没表过态",不能被当成 false', () => {
    // 设置存储里读不到时给的是 null/undefined,不是 false。
    // 若用真值判断,这里会退化成 false —— 清单声明就被悄悄忽略了。
    assert.equal(shouldAutoStart({ autoStart: true }, null), true);
    assert.equal(shouldAutoStart({ autoStart: true }, undefined), true);
    // 而显式的 false 必须压过清单
    assert.equal(shouldAutoStart({ autoStart: true }, false), false);
});

test('设的键名集中在一处,主进程与界面不会各写一个字符串', () => {
    assert.equal(autoStartKey('qqmusic'), 'service.qqmusic.autoStart');
});
