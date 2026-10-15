/* ============================================================
   字幕格式互转 —— 纯转换算法
   ------------------------------------------------------------
   支持的格式:SRT / VTT / ASS

   整体设计是"解析 → 中间结构 → 序列化":
     先把任意格式解析成统一的结构
         [{ start: 秒, end: 秒, text: '字幕内容' }, ...]
     再从这个结构序列化成想输出的格式。

   这样只需要 3 个解析器 + 3 个序列化器 = 6 个小函数,
   就能覆盖 3×3 = 9 种转换组合。如果两两之间各写一个转换函数,
   就得写 6 个,而且以后加第四种格式要再写 6 个。

   三种格式的关键差异:
     ┌──────┬────────────────────────────┬─────────────────────────┐
     │ SRT  │ 00:00:01,000 --> 00:00:04,000 │ 逗号,序号行 + 时间行 + 文本 │
     │ VTT  │ 00:00:01.000 --> 00:00:04.000 │ 点号,首行必须 WEBVTT     │
     │ ASS  │ 0:00:01.00,0:00:04.00        │ 厘秒(1/100秒),放在 [Events] 段 │
     └──────┴────────────────────────────┴─────────────────────────┘

   本模块**刻意不碰 DOM**,这样 node --test 可以直接 import 它做单测
   (见设计文档 §11.1),index.js 只负责界面绑定。
   ============================================================ */


/* ============================================================
   一、时间格式转换
   ============================================================ */

const pad = (n, len = 2) => String(n).padStart(len, '0');

/* 把 "00:00:01,000" / "00:00:01.000" / "00:01.000" 解析成秒数。
   VTT 允许省略小时部分,所以小时那一段是可选的 */
function parseTimestamp(str) {
    const m = (str || '').trim()
        .match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (!m) return null;

    const [, hh, mm, ss, frac] = m;
    /* 小数部分可能是 1~3 位,补到 3 位再当毫秒算:
       ".5" 表示 500 毫秒,补成 "500";".05" 是 50 毫秒,补成 "050" */
    return Number(hh || 0) * 3600
         + Number(mm) * 60
         + Number(ss)
         + Number(frac.padEnd(3, '0')) / 1000;
}

/* ASS 的时间:"0:00:01.00",小数是厘秒(1/100 秒)不是毫秒 */
function parseAssTimestamp(str) {
    const m = (str || '').trim()
        .match(/^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,2})$/);
    if (!m) return null;

    const [, hh, mm, ss, cs] = m;
    return Number(hh) * 3600
         + Number(mm) * 60
         + Number(ss)
         + Number(cs.padEnd(2, '0')) / 100;
}

/* 把"秒"拆成 时/分/秒/毫秒。
   先转成整数毫秒再拆,可以避开浮点误差 ——
   直接算 1.005 秒可能变成 1 秒 4.999 毫秒这种别扭的数 */
function splitSeconds(totalSeconds) {
    let ms = Math.round(Math.max(0, totalSeconds) * 1000);

    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000);   ms -= m * 60000;
    const s = Math.floor(ms / 1000);    ms -= s * 1000;

    return { h, m, s, ms };
}

function toSrtTime(sec) {
    const { h, m, s, ms } = splitSeconds(sec);
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function toVttTime(sec) {
    const { h, m, s, ms } = splitSeconds(sec);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function toAssTime(sec) {
    /* ASS 用厘秒,所以这里以"厘秒"为最小单位重新拆一遍,
       避免先算毫秒再除 10 时出现 100 这种越界的值 */
    let cs = Math.round(Math.max(0, sec) * 100);

    const h = Math.floor(cs / 360000); cs -= h * 360000;
    const m = Math.floor(cs / 6000);   cs -= m * 6000;
    const s = Math.floor(cs / 100);    cs -= s * 100;

    /* ASS 的小时通常不补零(写 0:00:01.00 而不是 00:00:01.00) */
    return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}


/* ============================================================
   二、解析器:各种格式 → 中间结构
   ============================================================ */

/* SRT 和 VTT 的结构几乎一样,共用一个解析器。
   区别只有三点,都在这个函数里处理掉了:
     1. VTT 第一行必须是 WEBVTT,后面还可能跟着 NOTE / STYLE 等块
     2. VTT 的时间用点号、SRT 用逗号 —— parseTimestamp 两种都认
     3. VTT 的时间行末尾可能带 align:start 这类设置,要丢掉 */
function parseSrtOrVtt(text, { isVtt = false } = {}) {
    /* 先把换行符统一成 \n:
       Windows 存的字幕是 \r\n,老 Mac 是 \r,不统一后面切分就乱了 */
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const cues = [];
    let i = 0;

    /* 跳过 WEBVTT 头 */
    if (isVtt && lines[0] && lines[0].trim().startsWith('WEBVTT')) {
        i = 1;
        while (i < lines.length && lines[i].trim() !== '') i++;
    }

    while (i < lines.length) {
        /* 跳过空行 */
        while (i < lines.length && !lines[i].trim()) i++;
        if (i >= lines.length) break;

        /* NOTE / STYLE / REGION 块不是字幕内容,整块跳过 */
        if (isVtt && /^(NOTE|STYLE|REGION)\b/.test(lines[i].trim())) {
            i++;
            while (i < lines.length && lines[i].trim() !== '') i++;
            continue;
        }

        /* 时间行前面可能有一行"cue 标识"(VTT 允许),先让过去 */
        if (!lines[i].includes('-->')) {
            i++;
            if (i >= lines.length) break;
        }

        const timeLineNo = i + 1;             /* 记下来是为了报错时说清是第几行 */
        const timeLine = lines[i];

        /* 起始时间 --> 结束时间。
           结束时间用 \S+ 只取一个词,后面跟着的 align:start 之类就自动丢掉了 */
        const m = timeLine.match(/^\s*(.+?)\s*-->\s*(\S+)/);
        if (!m) {
            throw new Error(
                `第 ${timeLineNo} 行应该是时间行（形如 00:00:01,000 --> 00:00:04,000），` +
                `实际内容是：${timeLine.trim() || '（空行）'}`
            );
        }

        const start = parseTimestamp(m[1]);
        const end = parseTimestamp(m[2]);
        if (start === null) {
            throw new Error(`第 ${timeLineNo} 行的起始时间看不懂：${m[1]}`);
        }
        if (end === null) {
            throw new Error(`第 ${timeLineNo} 行的结束时间看不懂：${m[2]}`);
        }

        i++;

        /* 时间行下面的非空行都是字幕文本,直到遇到空行为止 */
        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
            textLines.push(lines[i]);
            i++;
        }

        cues.push({ start, end, text: textLines.join('\n') });
    }

    return cues;
}

/* ASS:字幕藏在 [Events] 段里,每行以 Dialogue: 开头 */
function parseAss(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const cues = [];

    let inEvents = false;
    /* [Events] 段里的 Format: 行定义了字段的顺序。
       正常情况下它一定是标准的那个顺序,但规范允许改,
       所以按它声明的顺序来解析最稳妥 */
    let fields = null;

    lines.forEach((line, index) => {
        const lineNo = index + 1;
        const trimmed = line.trim();

        /* 遇到 [xxx] 就切换当前段 */
        if (/^\[.*\]$/.test(trimmed)) {
            inEvents = /^\[Events\]$/i.test(trimmed);
            return;
        }

        if (!inEvents) return;

        /* Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text */
        if (/^Format\s*:/i.test(trimmed)) {
            fields = trimmed.slice(trimmed.indexOf(':') + 1)
                .split(',')
                .map(s => s.trim().toLowerCase());
            return;
        }

        if (/^Comment\s*:/i.test(trimmed)) return;      /* 注释行,不是字幕 */
        if (!/^Dialogue\s*:/i.test(trimmed)) return;

        const payload = line.slice(line.indexOf(':') + 1);

        /* 关键一步:字幕文本是最后一个字段,里面本身可能带逗号。
           所以只能按逗号切出前面 N 个字段,剩下的一整块全算文本,
           不能整行 split(',') —— 那样文本里的逗号会把它切碎。 */
        const textIndex = fields ? fields.indexOf('text') : 9;
        const splitAt = textIndex > 0 ? textIndex : 9;

        const parts = payload.split(',');
        const head = parts.slice(0, splitAt);
        const content = parts.slice(splitAt).join(',');

        /* 按 Format 声明的顺序取 start / end,取不到就退回标准位置 */
        const pick = (name, fallbackIndex) => {
            const idx = fields ? fields.indexOf(name) : -1;
            return (idx >= 0 && idx < head.length) ? head[idx] : head[fallbackIndex];
        };

        const startStr = pick('start', 1);
        const endStr = pick('end', 2);

        const start = parseAssTimestamp(startStr);
        const end = parseAssTimestamp(endStr);

        if (start === null || end === null) {
            throw new Error(
                `第 ${lineNo} 行的时间格式不对。ASS 的时间应该长这样：0:00:01.00,0:00:04.00` +
                `（小数是厘秒，两位），实际读到：${(startStr || '').trim()} / ${(endStr || '').trim()}`
            );
        }

        cues.push({
            start,
            end,
            /* ASS 用 \N 表示换行,转成真正的换行符存进中间结构 */
            text: content.replace(/\\N/gi, '\n')
        });
    });

    return cues;
}


/* ============================================================
   三、序列化:中间结构 → 各种格式
   ============================================================ */

/* ASS 的样式覆盖标签,形如 {\pos(100,200)} 或 {\fs60}。
   这些标签只在 ASS 里有意义,转成 SRT/VTT 时必须去掉,
   否则播放器会把大括号里的内容当字幕显示出来。
   （所以只在"从 ASS 转出"时才清,免得误伤原文里正常的大括号） */
function stripAssTags(text) {
    return text.replace(/\{[^}]*\}/g, '');
}

function toSrt(cues, { fromAss = false } = {}) {
    return cues.map((cue, i) => {
        const text = fromAss ? stripAssTags(cue.text) : cue.text;
        /* 序号从 1 开始,每块 = 序号行 + 时间行 + 文本 + 一个空行 */
        return `${i + 1}\n${toSrtTime(cue.start)} --> ${toSrtTime(cue.end)}\n${text}\n`;
    }).join('\n');
}

function toVtt(cues, { fromAss = false } = {}) {
    const body = cues.map(cue => {
        const text = fromAss ? stripAssTags(cue.text) : cue.text;
        return `${toVttTime(cue.start)} --> ${toVttTime(cue.end)}\n${text}\n`;
    }).join('\n');

    /* 第一行必须是 WEBVTT,后面空一行 */
    return 'WEBVTT\n\n' + body;
}

function toAss(cues) {
    /* ASS 文件必须自带完整的头和样式定义,播放器才认。
       字体、字号这些是能正常显示中文的通用配置。 */
    const header = [
        '[Script Info]',
        '; 由 开物 工具箱从其他字幕格式转换生成',
        'ScriptType: v4.00+',
        'WrapStyle: 0',
        'ScaledBorderAndShadow: yes',
        'PlayResX: 1920',
        'PlayResY: 1080',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Default,Microsoft YaHei,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,40,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ].join('\n');

    const events = cues.map(cue => {
        /* 真正的换行符要转回 \N,否则一条字幕会被拆成两行,把 ASS 结构破坏掉 */
        const text = cue.text.replace(/\r?\n/g, '\\N');
        return `Dialogue: 0,${toAssTime(cue.start)},${toAssTime(cue.end)},Default,,0,0,0,,${text}`;
    }).join('\n');

    return header + '\n' + events + '\n';
}


/* ============================================================
   四、格式识别
   ============================================================ */
export function detectSubtitleFormat(text) {
    const head = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!head) return null;

    /* 顺序有讲究:VTT 也有 --> 箭头,所以必须先查 WEBVTT 头,
       放在最后查的话 VTT 会被误判成 SRT */
    if (/^WEBVTT/.test(head)) return 'vtt';
    if (/\[Script Info\]/i.test(head) || /^Dialogue\s*:/im.test(head)) return 'ass';
    if (/\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}\s*-->/.test(head)) return 'srt';

    return null;
}

export const FORMAT_LABELS = { srt: 'SRT', vtt: 'VTT', ass: 'ASS' };


/* ============================================================
   五、统一入口
   ============================================================ */

/* 把任意格式的字幕转成目标格式。**纯函数**:字符串进、字符串出,不碰 DOM。
   参数:
     text    源字幕全文
     target  'srt' | 'vtt' | 'ass'
   返回:
     {
       ok:       boolean,
       format:   识别出的源格式('srt'|'vtt'|'ass'),认不出来时为 null,
       output:   转换结果;失败时为空串,
       error:    失败原因(界面直接显示),成功时为 null,
       cueCount: 解析出的字幕条数;失败时为 0,
     }
   注意:**从不抛异常**。解析错误统一装进 error 返回,
   界面层(以及单测)不用套 try/catch。 */
export function convertSubtitle(text, target) {
    const source = String(text ?? '');

    /* 空输入单独给一句更好懂的提示,不要落到"认不出来"那条上 */
    if (!source.trim()) {
        return {
            ok: false, format: null, output: '',
            error: '请先粘贴字幕内容，或把字幕文件拖到上面的输入框里',
            cueCount: 0,
        };
    }

    const format = detectSubtitleFormat(source);
    if (!format) {
        return {
            ok: false, format: null, output: '',
            error: '认不出这段文本的字幕格式。SRT 应该有 "00:00:01,000 --> 00:00:04,000" 这样的时间行；'
                 + 'ASS 应该有 [Script Info] 和 [Events] 段；VTT 开头应该是 WEBVTT',
            cueCount: 0,
        };
    }

    let cues;
    try {
        cues = format === 'ass' ? parseAss(source)
            : format === 'vtt' ? parseSrtOrVtt(source, { isVtt: true })
            : parseSrtOrVtt(source);
    } catch (err) {
        /* 这里带的是"第 12 行应该是时间行…"这类具体信息,原样交给界面显示 */
        return { ok: false, format, output: '', error: err.message, cueCount: 0 };
    }

    if (cues.length === 0) {
        return {
            ok: false, format, output: '',
            error: '解析成功，但里面一条字幕都没有，请检查文件内容是否完整',
            cueCount: 0,
        };
    }

    /* 从 ASS 转出来的 SRT/VTT 要把样式覆盖标签清掉;
       目标就是 ASS 时不必清,免得误伤原文里正常的大括号 */
    const fromAss = format === 'ass';
    const output = target === 'srt' ? toSrt(cues, { fromAss })
        : target === 'vtt' ? toVtt(cues, { fromAss })
        : toAss(cues);

    return { ok: true, format, output, error: null, cueCount: cues.length };
}
