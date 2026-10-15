import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeText, encodeText, newlineStyleOf, applyNewline, SNIFF_BYTES,
} from '../app/lib/text-encoding.js';

// 纯文本文件是**别人给的**(docx 导出的剧本、下载的日志、别的工具写的配置),
// 所以"按什么编码读、能不能写回去"不能靠猜。这里的用例钉住三件事:
//   ① 二进制不当文本打开;② GBK 要能读出来、但**不许**写回;
//   ③ 写回要还原 BOM 与换行(否则"打开再保存"就悄悄改了用户的文件)。
//
// 实测背景:中文环境里 .txt 大量是 GBK。按 UTF-8 硬读会得到一屏"锟斤拷",
// 而更要命的是**保存**:读成乱码再写回 UTF-8,原件就毁了 —— 所以只读是刻意的设计,
// 不是没做完。

const utf8 = (s) => Buffer.from(s, 'utf8');
const gbk = (...bytes) => Buffer.from(bytes);

test('UTF-8(无 BOM):能读能写,换行 LF', () => {
    const r = decodeText(utf8('剧本：早点摊\n第二行\n'));
    assert.equal(r.ok, true);
    assert.equal(r.encoding, 'utf-8');
    assert.equal(r.editable, true);
    assert.equal(r.bom, false);
    assert.equal(r.newline, 'lf');
    assert.equal(r.text, '剧本：早点摊\n第二行\n');
});

test('UTF-8 BOM:认出来,而且写回时把 BOM 补回去', () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('甲\n乙\n')]);
    const r = decodeText(raw);
    assert.equal(r.encoding, 'utf-8-bom');
    assert.equal(r.bom, true);
    assert.equal(r.editable, true);
    assert.equal(r.text, '甲\n乙\n', 'BOM 不该出现在正文里');

    const back = encodeText(r.text, r);
    assert.deepEqual([...back.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 要原样补回');
    assert.equal(back.subarray(3).toString('utf8'), '甲\n乙\n');
});

test('GBK/GB18030:读得出来,但**只读**(绝不改成 UTF-8 写回)', () => {
    // "剧本：" 的 GBK 字节 + CRLF
    const r = decodeText(gbk(0xbe, 0xe7, 0xb1, 0xbe, 0xa3, 0xba, 0x0d, 0x0a));
    assert.equal(r.ok, true);
    assert.equal(r.encoding, 'gb18030');
    assert.equal(r.text, '剧本：\r\n');
    assert.equal(r.editable, false, 'Node 的 TextEncoder 只出 UTF-8,编不回去就不许写');
    assert.match(r.reason, /不是 UTF-8/);
    assert.throws(() => encodeText(r.text, r), /不能安全写回/);
});

test('严格 UTF-8 解码失败才回退 —— 不许拿"全是问号"当读成功', () => {
    // 0xFF 在 UTF-8 里是非法起始字节。若用默认解码器(非 fatal)会得到 U+FFFD,
    // 那种"能读"比读不了更坏:用户会以为文件坏了、还会把它存回去。
    const r = decodeText(gbk(0xff, 0xfe, 0x41));
    assert.notEqual(r.encoding, 'utf-8');
});

test('二进制(前 8 KB 有 NUL):不当文本打开', () => {
    const r = decodeText(gbk(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00));
    assert.equal(r.ok, false);
    assert.equal(r.encoding, 'binary');
    assert.equal(r.editable, false);
    assert.match(r.reason, /不是文本文件/);
});

test('UTF-16 带 BOM:能读(它天然带 NUL),但不写回', () => {
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('早点', 'utf16le')]);
    const r = decodeText(raw);
    assert.equal(r.ok, true, 'BOM 判定必须排在 NUL 判定之前,否则 UTF-16 会被误判成二进制');
    assert.equal(r.encoding, 'utf-16le');
    assert.equal(r.text, '早点');
    assert.equal(r.editable, false);
});

test('空文件:算作空的 UTF-8(新建的空 txt 要能打开)', () => {
    const r = decodeText(Buffer.alloc(0));
    assert.equal(r.ok, true);
    assert.equal(r.text, '');
    assert.equal(r.newline, 'none');
});

test('SNIFF_BYTES 之外的 NUL 不影响判定(不看全文 —— 那会把内存吃掉)', () => {
    // NUL 从第 SNIFF_BYTES+8 个字节才开始 → 探测窗口里一个都没有。
    const buf = Buffer.concat([utf8('a'.repeat(SNIFF_BYTES + 8)), Buffer.alloc(32)]);
    assert.equal(decodeText(buf).ok, true);
});

test('换行风格:crlf / lf / cr / none', () => {
    assert.equal(newlineStyleOf('a\r\nb\r\n'), 'crlf');
    assert.equal(newlineStyleOf('a\nb\n'), 'lf');
    assert.equal(newlineStyleOf('a\rb'), 'cr');
    assert.equal(newlineStyleOf('单行没有换行'), 'none');
});

test('applyNewline:按原风格把换行统一回去(保存路径用)', () => {
    assert.equal(applyNewline('a\nb\n', 'crlf'), 'a\r\nb\r\n');
    assert.equal(applyNewline('a\r\nb', 'lf'), 'a\nb');
    assert.equal(applyNewline('a\nb', 'cr'), 'a\rb');
    assert.equal(applyNewline('a\nb', 'none'), 'a\nb');
});

test('往返:UTF-8 原文 → 解码 → 编码,字节完全一致(打开再保存不该改文件)', () => {
    const original = utf8('第一行\r\n\r\n带空行\r\n');
    const r = decodeText(original);
    const back = encodeText(applyNewline(r.text, r.newline), r);
    assert.deepEqual([...back], [...original]);
});
