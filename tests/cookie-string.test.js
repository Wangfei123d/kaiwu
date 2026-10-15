import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCookieString, summarizeCookie } from '../app/lib/cookie-string.js';

// 这两件事都必须只有一处实现:拼 Cookie 串(给服务端当请求头用)与
// "这个 Cookie 够不够用"的判断(界面提示、日志、自检都要一致)。

test('拼 Cookie 串:name=value 用分号空格连起来', () => {
    assert.equal(
        buildCookieString([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]),
        'a=1; b=2',
    );
});

test('拼 Cookie 串:跳过空名字与空值', () => {
    assert.equal(
        buildCookieString([
            { name: '', value: 'x' },
            { name: 'a', value: '' },
            { name: 'b', value: '2' },
            null,
            undefined,
        ]),
        'b=2',
    );
    assert.equal(buildCookieString(null), '');
    assert.equal(buildCookieString('nope'), '');
});

test('拼 Cookie 串:同名时优先主域(带点)的那条', () => {
    // Electron 会同时给出 `.douyin.com` 与 `www.douyin.com` 两条同名 Cookie,
    // 直接拼会重复;服务端要的是主域那条。
    const out = buildCookieString([
        { name: 'ttwid', value: 'host-only', domain: 'www.douyin.com' },
        { name: 'ttwid', value: 'main', domain: '.douyin.com' },
    ]);
    assert.equal(out, 'ttwid=main');
});

test('体检:数得出长度与条数', () => {
    const s = summarizeCookie('ttwid=1; sessionid=abc; uifid=xyz');
    assert.equal(s.count, 3);
    assert.equal(s.length, 'ttwid=1; sessionid=abc; uifid=xyz'.length);
    assert.deepEqual(s.names, ['ttwid', 'sessionid', 'uifid']);
});

test('体检:只有 ttwid 的 Cookie 一定不算够用', () => {
    // 实测就是这个组合换来 `403 Blocked by ArgusSecurityPlugin Uifid Not Found`。
    const s = summarizeCookie('ttwid=1%7Cabc');
    assert.equal(s.hasTtwid, true);
    assert.equal(s.hasUifid, false);
    assert.equal(s.hasSessionid, false);
    assert.equal(s.usable, false);
});

test('体检:sessionid_ss 这类也认成登录态;UIFID_TEMP 认成有风控标识', () => {
    const s = summarizeCookie('sessionid_ss=abc; UIFID_TEMP=xyz');
    assert.equal(s.hasSessionid, true);
    assert.equal(s.hasUifid, true);
    assert.equal(s.usable, true);
});

test('体检:空值安全', () => {
    const s = summarizeCookie('');
    assert.equal(s.length, 0);
    assert.equal(s.count, 0);
    assert.equal(s.usable, false);
    assert.deepEqual(summarizeCookie(null).names, []);
});

test('体检:名字两边有空格也能认出来', () => {
    const s = summarizeCookie(' sessionid=abc ;  uifid =x ');
    assert.equal(s.hasSessionid, true);
    assert.equal(s.hasUifid, true);
});
