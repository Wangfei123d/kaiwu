/* ============================================================
   字幕转换算法的单元测试(设计文档 §11.1 点名的 subtitle-convert)
   ------------------------------------------------------------
   被测的是 plugins/subtitle/convert.js —— 纯函数,不碰 DOM,
   所以 node --test 能直接 import。界面逻辑在 index.js,不在这里测。
   覆盖:三种格式互转、时间码格式、逗号 vs 点号、ASS 厘秒单位、行号重排。
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSubtitle, detectSubtitleFormat } from '../plugins/subtitle/convert.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
第一句

2
00:00:04,000 --> 00:00:06,000
第二句
`;

/* ASS 的完整骨架:没有 [Script Info] 就识别不出来,
   所以构造样例时必须把头带上 */
const ASS = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,第一句
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,第二句
`;


/* ---- 格式识别 ---- */

test('识别出 SRT', () => {
    assert.equal(convertSubtitle(SRT, 'vtt').format, 'srt');
});

test('识别出 VTT 靠的是 WEBVTT 头,不是 --> 箭头', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n';
    assert.equal(detectSubtitleFormat(vtt), 'vtt');
});

test('识别出 ASS 靠的是 [Script Info]', () => {
    assert.equal(detectSubtitleFormat(ASS), 'ass');
});

test('只有 Dialogue 行、没有 [Script Info] 也算 ASS', () => {
    assert.equal(detectSubtitleFormat('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,嗨\n'), 'ass');
});


/* ---- SRT → VTT:逗号变点号 ---- */

test('SRT → VTT 时间码逗号变点号', () => {
    const r = convertSubtitle(SRT, 'vtt');
    assert.ok(r.ok);
    assert.ok(r.output.startsWith('WEBVTT'));
    assert.ok(r.output.includes('00:00:01.000 --> 00:00:03.500'));
    assert.ok(r.output.includes('00:00:04.000 --> 00:00:06.000'));
    assert.ok(!r.output.includes(',000'));
});


/* ---- SRT → ASS:厘秒单位 + 完整样式头 ---- */

test('SRT → ASS 时间单位变成厘秒且带样式头', () => {
    const r = convertSubtitle(SRT, 'ass');
    assert.ok(r.ok);
    assert.ok(r.output.includes('[Script Info]'));
    assert.ok(r.output.includes('[V4+ Styles]'));
    assert.ok(r.output.includes('[Events]'));
    assert.ok(r.output.includes('Dialogue:'));
    assert.ok(r.output.includes('0:00:01.00'));       // 1 秒 = 100 厘秒
});

test('SRT → ASS 的厘秒是"逢百进秒",不是毫秒截断', () => {
    // 3.5 秒 = 350 厘秒 → 0:00:03.50;若误按毫秒处理会写成 .35 或 .350
    const r = convertSubtitle(SRT, 'ass');
    assert.ok(r.output.includes('0:00:03.50'), '3.5 秒应写成 0:00:03.50');
    assert.ok(!r.output.includes('0:00:03.050'));
});


/* ---- SRT → SRT:行号重排 ---- */

test('SRT → SRT 行号重排且条数不变', () => {
    const r = convertSubtitle(SRT, 'srt');
    assert.equal(r.cueCount, 2);
    assert.ok(r.output.includes('1\n00:00:01,000 --> 00:00:03,500'));
    assert.ok(r.output.includes('2\n00:00:04,000 --> 00:00:06,000'));
});

test('SRT → SRT 会把乱掉的序号重新编号', () => {
    // 源文件里序号写乱了(9、7),输出必须重排成 1、2
    const messy = '9\n00:00:01,000 --> 00:00:02,000\n甲\n\n7\n00:00:03,000 --> 00:00:04,000\n乙\n';
    const r = convertSubtitle(messy, 'srt');
    assert.equal(r.cueCount, 2);
    assert.ok(r.output.startsWith('1\n00:00:01,000'));
    assert.ok(r.output.includes('\n2\n00:00:03,000'));
    assert.ok(!r.output.includes('\n9\n'));
    assert.ok(!r.output.includes('\n7\n'));
});


/* ---- VTT ---- */

test('VTT 输入的 WEBVTT 头不会变成一条字幕', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n';
    const r = convertSubtitle(vtt, 'srt');
    assert.equal(r.cueCount, 1);
    assert.equal(r.output.trim(), '1\n00:00:01,000 --> 00:00:02,000\n你好');
});

test('VTT 的 NOTE / STYLE 块被跳过,不算字幕', () => {
    const vtt = 'WEBVTT\n\nNOTE 这是备注\n不该变成字幕\n\n'
              + 'STYLE\n::cue { color: red }\n\n'
              + '00:00:01.000 --> 00:00:02.000\n真正的字幕\n';
    const r = convertSubtitle(vtt, 'srt');
    assert.equal(r.cueCount, 1);
    assert.ok(r.output.includes('真正的字幕'));
    assert.ok(!r.output.includes('这是备注'));
    assert.ok(!r.output.includes('::cue'));
});

test('VTT 时间行尾部的 align 设置被丢掉', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:10%\n带设置的一行\n';
    const r = convertSubtitle(vtt, 'srt');
    assert.ok(r.ok);
    assert.equal(r.cueCount, 1);
    assert.ok(r.output.includes('00:00:01,000 --> 00:00:02,000'));
    assert.ok(!r.output.includes('align:start'));
});

test('VTT 省略小时的时间码(00:01.000)也认', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.500\n省略小时\n';
    const r = convertSubtitle(vtt, 'srt');
    assert.ok(r.ok);
    assert.equal(r.cueCount, 1);
    assert.ok(r.output.includes('00:00:01,000 --> 00:00:02,500'));
});


/* ---- ASS ---- */

test('ASS → SRT 厘秒被换算回毫秒', () => {
    const r = convertSubtitle(ASS, 'srt');
    assert.ok(r.ok);
    assert.equal(r.format, 'ass');
    assert.equal(r.cueCount, 2);
    // 350 厘秒 = 3.5 秒 = 3500 毫秒
    assert.ok(r.output.includes('00:00:01,000 --> 00:00:03,500'));
    assert.ok(r.output.includes('00:00:04,000 --> 00:00:06,000'));
});

test('ASS → SRT 去掉样式标签,但保留文本自身的逗号', () => {
    const ass = '[Script Info]\n\n[Events]\n'
              + 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
              + 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(100,200)}你好，世界\n';
    const r = convertSubtitle(ass, 'srt');
    assert.ok(r.ok);
    assert.equal(r.cueCount, 1);
    assert.ok(r.output.includes('你好，世界'), '文本里的逗号不能被吃掉');
    assert.ok(!r.output.includes('\\pos'), '样式标签必须清掉');
    assert.ok(!r.output.includes('{'));
});

test('ASS 的 \\N 换行符转出来是真换行,再转回去还是 \\N', () => {
    const ass = '[Script Info]\n\n[Events]\n'
              + 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
              + 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,上面\\N下面\n';
    const srt = convertSubtitle(ass, 'srt');
    assert.ok(srt.ok);
    assert.ok(srt.output.includes('上面\n下面'));

    const back = convertSubtitle(srt.output, 'ass');
    assert.ok(back.ok);
    assert.ok(back.output.includes('上面\\N下面'), '一条字幕不能被拆成两条 Dialogue');
    assert.equal(back.cueCount, 1);
});


/* ---- 往返一致 ---- */

test('SRT → VTT → SRT 往返后内容一致', () => {
    const vtt = convertSubtitle(SRT, 'vtt');
    assert.ok(vtt.ok);
    const back = convertSubtitle(vtt.output, 'srt');
    assert.ok(back.ok);
    assert.equal(back.format, 'vtt');
    assert.equal(back.cueCount, 2);
    // 序号、时间码(逗号)、文本三者都应回到原样
    assert.equal(back.output.trim(), SRT.trim());
});

test('SRT → ASS → SRT 往返后文本与时间一致(丢掉 ASS 不支持的样式)', () => {
    const ass = convertSubtitle(SRT, 'ass');
    assert.ok(ass.ok);
    const back = convertSubtitle(ass.output, 'srt');
    assert.ok(back.ok);
    assert.equal(back.format, 'ass');
    assert.equal(back.cueCount, 2);
    assert.equal(back.output.trim(), SRT.trim());
});

test('VTT → ASS → VTT 往返后条数不变', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n甲\n\n00:00:03.000 --> 00:00:04.000\n乙\n';
    const ass = convertSubtitle(vtt, 'ass');
    const back = convertSubtitle(ass.output, 'vtt');
    assert.ok(back.ok);
    assert.equal(back.cueCount, 2);
    assert.ok(back.output.startsWith('WEBVTT'));
    assert.ok(back.output.includes('00:00:01.000 --> 00:00:02.000'));
});


/* ---- Windows 换行 ---- */

test('CRLF 换行的字幕照样解析', () => {
    const crlf = SRT.replace(/\n/g, '\r\n');
    const r = convertSubtitle(crlf, 'vtt');
    assert.ok(r.ok);
    assert.equal(r.cueCount, 2);
    assert.ok(r.output.includes('00:00:01.000 --> 00:00:03.500'));
});


/* ---- 错误路径:报错而不是抛异常 ---- */

test('空输入报错而不是抛异常', () => {
    const r = convertSubtitle('', 'srt');
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(r.cueCount, 0);
});

test('只有空白字符也算空输入', () => {
    const r = convertSubtitle('   \n\n  \t ', 'srt');
    assert.equal(r.ok, false);
    assert.ok(r.error);
});

test('无法识别的内容报错', () => {
    const r = convertSubtitle('这不是字幕', 'srt');
    assert.equal(r.ok, false);
    assert.equal(r.format, null);
    assert.equal(r.output, '');
});

test('时间行写坏时报出带行号的具体错误,而不是抛异常', () => {
    // 有 --> 箭头(所以能认出是 SRT),但起始时间不是合法时间码
    const broken = '1\n00:00:01,000 --> 乱码\n内容\n';
    const r = convertSubtitle(broken, 'srt');
    assert.equal(r.ok, false);
    assert.equal(r.format, 'srt');
    assert.ok(r.error, '必须带回可显示的错误原因');
    assert.ok(r.error.includes('第'), '错误里应指出是第几行');
});

test('没有 --> 箭头的内容连格式都认不出来', () => {
    // 格式识别本身就要求箭头,所以这里落到"认不出格式"那条,而不是解析错误
    const r = convertSubtitle('1\n00:00:01,000 00:00:02,000\n少了箭头\n', 'srt');
    assert.equal(r.ok, false);
    assert.equal(r.format, null);
    assert.ok(r.error);
});

test('目标格式写错时退化成 ASS 而不是崩掉', () => {
    const r = convertSubtitle(SRT, 'ass');
    assert.ok(r.ok);
    assert.ok(r.output.includes('[Script Info]'));
});
