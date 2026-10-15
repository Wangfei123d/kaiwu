import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    PROGRESS_PHASE_LABEL, QUEUE_STATUS_LABEL, TERMINAL_STATUSES, admitCopyTarget, displayTitle,
    formatBytes, formatClock, formatCountdown, formatDuration, isActiveStatus, isRunningStatus,
    planPoll, progressOf, qualityLabel, sortTasks, statusClass, statusLabel, summarize,
} from '../app/lib/bilibili-queue.js';

// B站下载队列的**纯逻辑**:状态映射、排序、显示标题、以及"要不要继续轮询"。
//
// ⚠️ 这一组里最要紧的是 planPoll():代理对高频请求敏感(今天那次风控问题的同源),
// "空闲就别打"必须是**能算出来**的判据 —— 所以它是一条独立的、被逐条钉住的纯函数,
// 而不是散在插件某个 setTimeout 里的 if。

// ---- 实测夹具:2026-09-19 从本机队列与 D:\project\bilidown\download 真实取到 ----
// 两个任务同标题、只有随机后缀不同 —— 这是"最终文件名"那条链路最难的场景。
const REAL_TASKS = [
    {
        id: 4, bvid: 'BV1BqMX6TEWy', title: '中国人能飞😭 [高清 1080P60]', owner: '是橘长呀',
        status: 'done', format: 116, createAt: '2026-09-19T15:17:34Z',
        createAtMs: 1789831054000, fileName: '中国人能飞😭 [高清 1080P60] NA.mp4',
        filePath: 'D:\\project\\bilidown\\download\\中国人能飞😭 [高清 1080P60] NA.mp4',
        folder: 'D:\\project\\bilidown\\download', fileCandidates: 2, fileAmbiguous: true, duration: 508,
    },
    {
        id: 3, bvid: 'BV1BqMX6TEWy', title: '中国人能飞😭 [高清 1080P60]', owner: '是橘长呀',
        status: 'done', format: 116, createAt: '2026-09-19T15:10:29Z',
        createAtMs: 1789830629000, fileName: '中国人能飞😭 [高清 1080P60] Mw.mp4',
        filePath: 'D:\\project\\bilidown\\download\\中国人能飞😭 [高清 1080P60] Mw.mp4',
        folder: 'D:\\project\\bilidown\\download', fileCandidates: 2, fileAmbiguous: true, duration: 508,
    },
];

// ---------- 状态与清晰度 ----------

test('状态映射:上游那六个取值都有中文,认不出来的一律"未知"而不是空白', () => {
    assert.equal(statusLabel('done'), '已完成');
    assert.equal(statusLabel('download'), '下载中');
    assert.equal(statusLabel('merge'), '合并中');
    assert.equal(statusLabel('waiting'), '等待中');
    assert.equal(statusLabel('pause'), '已暂停');
    assert.equal(statusLabel('error'), '失败');
    assert.equal(statusLabel(''), '未知');
    assert.equal(statusLabel(null), '未知');
    assert.equal(Object.keys(QUEUE_STATUS_LABEL).length >= 6, true);
});

// ---- 用户报的那个真机 bug(2026-10-05):英文 `running` 胶囊 + 界面冻住 ----

test('★ 回归:上游真实用的 `running` 必须有中文标签 —— 界面**永远不许**显示原始英文 token', () => {
    // 实测(11 帧采样):下载全程上游给的都是 running,而标签映射里原先没有它 →
    // statusLabel 回退成原始值 → 用户看到的是一枚英文 `running` 胶囊。
    assert.equal(statusLabel('running'), '下载中');
    // ⚠️ 兜底也不许是 ASCII 英文:以后上游再冒出一个新状态,界面上也只会是中文。
    const unknown = statusLabel('weird-new-status');
    assert.equal(unknown, '处理中');
    assert.equal(/^[\x00-\x7F]*$/.test(unknown), false, `兜底返回了 ASCII:${unknown}`);
    // 大小写/空格也收敛(上游换个写法不该变成英文)
    assert.equal(statusLabel(' Running '), '处理中');
});

test('★ 回归:`running` 算"进行中"(轮询 + live 动效的判据都看它)', () => {
    // 这就是那个 bug 的根因:白名单里只有 download|merge,running 一个都不匹配。
    assert.equal(isActiveStatus('running'), true);
    assert.deepEqual([...TERMINAL_STATUSES], ['done', 'error', 'pause']);
    // 只列终态:认识的不认识的都当"还在跑"
    for (const other of ['download', 'merge', 'waiting', 'weird-new-status', 'Running']) {
        assert.equal(isActiveStatus(other), true, `${other} 应该算进行中`);
    }
    for (const terminal of ['done', 'error', 'pause']) {
        assert.equal(isActiveStatus(terminal), false, `${terminal} 是终态`);
    }
    // 空状态也当"还在跑":上游没给状态时当成静止会**永久冻住**(宁可多轮几次)
    assert.equal(isActiveStatus(''), true);
    assert.equal(isActiveStatus(null), true);
});

test('live 动效的判据:排队中要轮询但**不画进度**(还没开始,一根 0% 的条像是卡住了)', () => {
    assert.equal(isRunningStatus('running'), true);
    assert.equal(isRunningStatus('download'), true);
    assert.equal(isRunningStatus('merge'), true);
    assert.equal(isRunningStatus('weird-new-status'), true);
    assert.equal(isRunningStatus('waiting'), false);
    for (const terminal of ['done', 'error', 'pause']) assert.equal(isRunningStatus(terminal), false);
});

test('★ 回归:队列里有一条 running → **必须继续轮询**(否则界面永远停在第一帧)', () => {
    const plan = planPoll({ tasks: [{ id: 7, status: 'running' }, { id: 6, status: 'done' }] });
    assert.equal(plan.poll, true);
    assert.equal(plan.delayMs, 1500);
    assert.match(plan.reason, /有 1 个进行中的任务/);
    const stats = summarize([{ status: 'running' }, { status: 'done' }]);
    assert.deepEqual(stats, { total: 2, done: 1, active: 1, failed: 0, hasActive: true });
});

test('状态类名:只放行安全字符(上游的值是不可信输入,不许直接拼进 className)', () => {
    assert.equal(statusClass('running'), 'running');
    assert.equal(statusClass(' Download '), 'download');
    // 一个带空格的"状态"能塞进两个类 —— 必须被收敛
    assert.equal(statusClass('a b'), 'unknown');
    assert.equal(statusClass('x" onload="y'), 'unknown');
    assert.equal(statusClass(''), 'unknown');
    assert.equal(statusClass(null), 'unknown');
});

test('清晰度标签:认识那几档,不认识的退回数字(不显示空白)', () => {
    assert.equal(qualityLabel(116), '高清 1080P60');
    assert.equal(qualityLabel(80), '高清 1080P');
    assert.equal(qualityLabel(999), '999');
    assert.equal(qualityLabel(undefined), '');
    // 0 当"没给清晰度":显示成 "[0]" 是纯噪音
    assert.equal(qualityLabel(0), '');
});

// ---------- 显示标题(设计稿第一版撞过的坑) ----------

test('displayTitle:上游标题里**已经带**清晰度后缀时不再补一遍', () => {
    const t = REAL_TASKS[0];
    assert.equal(displayTitle(t), '中国人能飞😭 [高清 1080P60]');
    assert.equal((displayTitle(t).match(/\[高清 1080P60\]/g) ?? []).length, 1, '后缀只许出现一次');
});

test('displayTitle:标题里没有后缀时才补上;没有标题给占位', () => {
    assert.equal(displayTitle({ title: '某视频', format: 80 }), '某视频 [高清 1080P]');
    assert.equal(displayTitle({ title: '', format: 80 }), '(无标题) [高清 1080P]');
    assert.equal(displayTitle({ title: '某视频', format: 0 }), '某视频');
    assert.equal(displayTitle(null), '(无标题)');
});

// ---------- 时间/体积/进度 ----------

test('formatDuration:不足一小时是 m:ss,超过是 h:mm:ss;0 给 --:--', () => {
    assert.equal(formatDuration(508), '8:28');
    assert.equal(formatDuration(61), '1:01');
    assert.equal(formatDuration(3661), '1:01:01');
    assert.equal(formatDuration(0), '--:--');
    assert.equal(formatDuration('abc'), '--:--');
});

test('formatClock:UTC 的 createAt 要按**本地时区**显示;认不出来给空串', () => {
    const iso = '2026-09-19T15:17:34Z';
    const d = new Date(iso);
    const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    assert.equal(formatClock(iso), expected);
    assert.equal(formatClock(''), '');
    assert.equal(formatClock('昨天'), '');
});

test('formatBytes:三级单位,0/非法给小空串(不显示 0 B 那种噪音)', () => {
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(177737264), '169.5 MB');
    assert.equal(formatBytes(0), '');
    assert.equal(formatBytes(-1), '');
});

// ---- 解析被风控时的冷却倒计时(界面上那行「已暂停请求,1:58 后恢复」) ----

test('formatCountdown:M:SS,与代理侧那份格式一致;负数/非数给 0:00(不倒着数)', () => {
    assert.equal(formatCountdown(120), '2:00');
    assert.equal(formatCountdown(118), '1:58');
    assert.equal(formatCountdown(95), '1:35');
    assert.equal(formatCountdown(7), '0:07');
    assert.equal(formatCountdown(0), '0:00');
    // 冷却刚过去的那一瞬、以及脏输入,都不许出现 "-0:01" / "NaN:NaN"
    assert.equal(formatCountdown(-3), '0:00');
    assert.equal(formatCountdown(Number.NaN), '0:00');
    assert.equal(formatCountdown(null), '0:00');
    assert.equal(formatCountdown('x'), '0:00');
    assert.equal(formatCountdown(59.9), '0:59');
});

// ---- 进度:单位与字段语义都是**实测**出来的(2026-10-05 真跑一次 1080P 下载) ----
//
// 实测那 11 帧(原始 JSON 在 kaiwu-bili-sample.json):
//   status 全程 running,最后 done;
//   audio: 0 → .067 → .423 → 1      video: 0 → .0038 → .0386 → .275 → 1
//   merge: 0 → .985 → 1             progress/speed: **每一帧都没有**

/** 实测序列(时间顺序)。用它钉住"单调"这条性质。 */
const MEASURED_FRAMES = [
    { status: 'running', videoProgress: 0, audioProgress: 0, mergeProgress: 0 },
    { status: 'running', videoProgress: 0, audioProgress: 0.06673019641873205, mergeProgress: 0 },
    { status: 'running', videoProgress: 0, audioProgress: 0.4228180058933605, mergeProgress: 0 },
    { status: 'running', videoProgress: 0, audioProgress: 1, mergeProgress: 0 },
    { status: 'running', videoProgress: 0.0038380590814985397, audioProgress: 1, mergeProgress: 0 },
    { status: 'running', videoProgress: 0.0385815021251269, audioProgress: 1, mergeProgress: 0 },
    { status: 'running', videoProgress: 0.27483540382533084, audioProgress: 1, mergeProgress: 0 },
    { status: 'running', videoProgress: 1, audioProgress: 1, mergeProgress: 0 },
    { status: 'running', videoProgress: 1, audioProgress: 1, mergeProgress: 0.9852941176470589 },
    { status: 'running', videoProgress: 1, audioProgress: 1, mergeProgress: 1 },
    { status: 'done', videoProgress: 1, audioProgress: 1, mergeProgress: 1 },
];

test('进度:三个字段是 **0–1 的比例**(旧代码按 0–100 读,填充条最多只走 1%)', () => {
    // 实测里 done 时三个都是 1 —— 这说明单位是比例,不是百分比
    assert.equal(progressOf(MEASURED_FRAMES[10]).percent, 100);
    // 音频下完(1)、视频刚起步(.0038)→ 三段等权平均约 33%
    assert.equal(progressOf(MEASURED_FRAMES[4]).percent, 33);
    // 旧代码会把这个读成 0.0038%,也就是填充条永远看不见 —— 这就是第二处"看着像有进度其实没有"
    assert.equal(progressOf({ status: 'running', videoProgress: 0.5, audioProgress: 1, mergeProgress: 0 }).percent, 50);
});

test('进度:整条实测序列**单调不减**(换段时不许倒退)', () => {
    const percents = MEASURED_FRAMES.map(f => progressOf(f).percent);
    for (let i = 1; i < percents.length; i += 1) {
        assert.ok(percents[i] >= percents[i - 1], `第 ${i} 帧倒退了:${percents.join(' → ')}`);
    }
    assert.deepEqual(percents, [0, 2, 14, 33, 33, 35, 42, 67, 100, 100, 100]);
});

test('进度:阶段名按实测顺序 音频 → 视频 → 合并 → 收尾(状态全程是 running,阶段只能推)', () => {
    assert.deepEqual(MEASURED_FRAMES.map(f => progressOf(f).phase),
        ['audio', 'audio', 'audio', 'video', 'video', 'video', 'video', 'merge', 'merge', 'final', 'final']);
    assert.equal(PROGRESS_PHASE_LABEL.audio, '音频');
    assert.equal(PROGRESS_PHASE_LABEL.video, '视频');
    assert.equal(PROGRESS_PHASE_LABEL.merge, '合并');
    assert.equal(PROGRESS_PHASE_LABEL.final, '收尾');
    // 面板上会出现的那句话(阶段 + 百分比),抽一条实测帧验一遍
    const p = progressOf(MEASURED_FRAMES[6]);
    assert.equal(`${PROGRESS_PHASE_LABEL[p.phase]} ${p.percent}%`, '视频 42%');
});

test('进度:三个字段一个都没有时是"不确定"(known=false)—— 面板据此**不画进度条**', () => {
    for (const task of [{ status: 'running' }, { status: 'running', progress: 1 }, null, {}, { videoProgress: 'x', audioProgress: null, mergeProgress: NaN }]) {
        const p = progressOf(task);
        assert.equal(p.known, false, `${JSON.stringify(task)} 不该给出进度`);
        assert.equal(p.percent, null);
        assert.equal(p.phase, '');
    }
    // `progress` 这个字段上游从来没有(实测 11 帧全是 null):它**不能**被当成进度来源
    assert.equal(progressOf({ status: 'running', progress: 1 }).known, false);
    // 只要有一个字段给了,就算"有读数"(缺的那两段按 0 算)
    const partial = progressOf({ videoProgress: 0.6 });
    assert.equal(partial.known, true);
    assert.equal(partial.percent, 20);
});

test('进度:脏值收敛(负数/超界/字符串),不抛也不给出界值', () => {
    assert.equal(progressOf({ videoProgress: -5, audioProgress: 0, mergeProgress: 0 }).percent, 0);
    assert.equal(progressOf({ videoProgress: 900, audioProgress: 1, mergeProgress: 1 }).percent, 100);
    assert.equal(progressOf({ videoProgress: '0.3', audioProgress: 0, mergeProgress: 0 }).percent, 10);
});

// ---------- 排序与汇总 ----------

test('排序:进行中的置顶(含 running 与不认识的新状态),失败次之,已完成的沉底;同权重按创建时间新的在前', () => {
    const tasks = [
        { id: 1, status: 'done', createAtMs: 100 },
        { id: 2, status: 'waiting', createAtMs: 200 },
        { id: 3, status: 'download', createAtMs: 300 },
        { id: 4, status: 'error', createAtMs: 400 },
        { id: 5, status: 'merge', createAtMs: 500 },
        { id: 6, status: 'pause', createAtMs: 600 },
        // ⚠️ running 是实测里真实的那一个:它必须与 download/merge 一样被当成进行中;
        // 连"不认识的新状态"也要排在进行中那一档 —— 沉底就等于用户看不见正在下的任务。
        { id: 7, status: 'running', createAtMs: 700 },
        { id: 8, status: 'weird-new-status', createAtMs: 800 },
    ];
    assert.deepEqual(sortTasks(tasks).map(t => t.id), [8, 7, 5, 3, 4, 6, 2, 1]);
    // 不改原数组(面板里那份状态要照旧)
    assert.deepEqual(tasks.map(t => t.id), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('汇总:总数/已完成/进行中/失败;hasActive 就是"要不要轮询"的第一手信号', () => {
    assert.deepEqual(summarize(REAL_TASKS), { total: 2, done: 2, active: 0, failed: 0, hasActive: false });
    const mixed = summarize([{ status: 'download' }, { status: 'merge' }, { status: 'error' }, { status: 'done' }]);
    assert.deepEqual(mixed, { total: 4, done: 1, active: 2, failed: 1, hasActive: true });
    assert.deepEqual(summarize(null), { total: 0, done: 0, active: 0, failed: 0, hasActive: false });
});

// ---------- ★ 轮询节流(这次改动的要害) ----------

test('轮询:队列空 → **不轮**(刚打开面板不该有任何后台流量)', () => {
    const plan = planPoll({ tasks: [] });
    assert.equal(plan.poll, false);
    assert.equal(plan.delayMs, 0);
    assert.match(plan.reason, /队列是空的/);
});

test('轮询:有任务但都不是进行中 → **停止轮询**(设计稿要的就是"空闲彻底安静")', () => {
    const plan = planPoll({ tasks: REAL_TASKS });          // 两条都是 done
    assert.equal(plan.poll, false);
    assert.equal(plan.delayMs, 0);
    assert.match(plan.reason, /没有进行中的任务,停止轮询/);
});

test('轮询:有进行中的任务 → 按 1~2 秒轮一次,理由里带上是几个', () => {
    const plan = planPoll({ tasks: [{ status: 'download' }, { status: 'done' }] });
    assert.equal(plan.poll, true);
    assert.equal(plan.delayMs, 1500);
    assert.match(plan.reason, /有 1 个进行中的任务/);
    // 间隔可注入(单测与将来的"省电模式"都靠它)
    assert.equal(planPoll({ tasks: [{ status: 'merge' }], activeMs: 2000 }).delayMs, 2000);
    // 实测里真正会出现的那个状态
    assert.equal(planPoll({ tasks: [{ status: 'running' }] }).poll, true);
});

test('轮询:上一次取队列失败 → 不轮(继续打只会刷日志),由界面给「重试」', () => {
    const plan = planPoll({ tasks: null, failed: true });
    assert.equal(plan.poll, false);
    assert.equal(plan.delayMs, 0);
    assert.match(plan.reason, /停止轮询/);
});

test('轮询:还没取到队列(undefined)→ 不轮;非法间隔退回 1500', () => {
    assert.equal(planPoll({}).poll, false);
    assert.equal(planPoll({ tasks: [{ status: 'download' }], activeMs: -1 }).delayMs, 1500);
    assert.equal(planPoll({ tasks: [{ status: 'download' }], activeMs: NaN }).delayMs, 1500);
});

// ---------- 复制之前的核对(主进程用) ----------

/** stat 替身:只有这些路径"存在"。 */
function statOf(map) {
    return (p) => (map[p] ? { exists: true, isFile: map[p] !== 'dir', size: map[p] === 'dir' ? 0 : 177737264 } : { exists: false, isFile: false, size: 0 });
}
const queueWith = (tasks) => ({ tasks });
const statReal = statOf({ [REAL_TASKS[0].filePath]: 'file' });

test('核对:已完成 + 文件在 + 路径在自己的下载目录里 → 通过,并把文件信息带出来', () => {
    const verdict = admitCopyTarget({ queue: queueWith(REAL_TASKS), taskId: 4, stat: statReal });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.taskId, 4);
    assert.equal(verdict.filePath, REAL_TASKS[0].filePath);
    assert.equal(verdict.fileName, REAL_TASKS[0].fileName);
    assert.equal(verdict.size, 177737264);
});

test('核对:taskId 只认正整数(渲染进程递什么都挡在这里)', () => {
    for (const bad of [0, -1, 1.5, 'abc', null, undefined, '']) {
        const verdict = admitCopyTarget({ queue: queueWith(REAL_TASKS), taskId: bad, stat: statReal });
        assert.equal(verdict.ok, false, `${String(bad)} 不该通过`);
        assert.equal(verdict.code, 'bad_task_id');
    }
    // 数字字符串是渲染进程常见形状,收敛即可(它来自按钮上的 data-task-id)
    assert.equal(admitCopyTarget({ queue: queueWith(REAL_TASKS), taskId: '4', stat: statReal }).ok, true);
});

test('核对:任务不存在 / 还没完成 → 各有各的码与中文原因', () => {
    const missing = admitCopyTarget({ queue: queueWith(REAL_TASKS), taskId: 999, stat: statReal });
    assert.equal(missing.code, 'task_missing');
    assert.match(missing.reason, /没有任务 999/);

    const notDone = admitCopyTarget({
        queue: queueWith([{ id: 5, status: 'download', folder: 'D:\\x', filePath: 'D:\\x\\a.mp4' }]),
        taskId: 5, stat: statReal,
    });
    assert.equal(notDone.code, 'task_not_done');
    assert.match(notDone.reason, /还不是「已完成」\(下载中\)/);
});

test('核对:没定位到文件 → 用它给出的原因(而不是一句"失败了")', () => {
    const verdict = admitCopyTarget({
        queue: queueWith([{ id: 6, status: 'done', folder: 'D:\\x', filePath: '', fileReason: '下载目录里没有以这个标题开头的视频文件' }]),
        taskId: 6, stat: statReal,
    });
    assert.equal(verdict.code, 'file_unresolved');
    assert.match(verdict.reason, /没有以这个标题开头/);
});

test('核对:路径不在它自己的下载目录里 → 拒(防的是队列数据被换成别的路径)', () => {
    const verdict = admitCopyTarget({
        queue: queueWith([{ id: 7, status: 'done', folder: 'D:\\project\\bilidown\\download', filePath: 'C:\\Windows\\System32\\config\\SAM' }]),
        taskId: 7, stat: statReal,
    });
    assert.equal(verdict.code, 'outside_folder');
    assert.match(verdict.reason, /不在这个任务的下载目录里/);
});

test('核对:路径比较不区分大小写与斜杠方向(Windows 上两样都会变)', () => {
    const verdict = admitCopyTarget({
        queue: queueWith([{
            id: 8, status: 'done', folder: 'D:/Project/BiliDown/Download',
            filePath: 'd:\\project\\bilidown\\download\\x.mp4',
        }]),
        taskId: 8, stat: statOf({ 'd:\\project\\bilidown\\download\\x.mp4': 'file' }),
    });
    assert.equal(verdict.ok, true);
});

test('核对:文件不在了 / 路径是个目录 → 分别说清是哪一步', () => {
    const gone = admitCopyTarget({ queue: queueWith(REAL_TASKS), taskId: 4, stat: () => ({ exists: false }) });
    assert.equal(gone.code, 'file_missing');
    assert.match(gone.reason, /文件不在了/);

    const isDir = admitCopyTarget({ queue: queueWith(REAL_TASKS), taskId: 4, stat: () => ({ exists: true, isFile: false }) });
    assert.equal(isDir.code, 'not_a_file');
});

test('核对:没拿到 stat / 队列不是对象 → 都是**接线错误**,不能伪装成"文件没了"', () => {
    const wiring = admitCopyTarget({ queue: queueWith(REAL_TASKS), taskId: 4 });
    assert.equal(wiring.code, 'wiring');
    assert.match(wiring.reason, /接错|没有拿到 stat/);

    assert.equal(admitCopyTarget({ queue: null, taskId: 4, stat: statReal }).code, 'bad_queue');
});
