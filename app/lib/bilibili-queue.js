/**
 * B站下载队列的**纯逻辑**:状态/清晰度的中文映射、排序、显示标题的拼法、
 * 以及"要不要继续轮询"的判据。
 *
 * 为什么单独一个文件(与 agent-image/agent-video 那几个同一个理由):
 *   · 这些判据同时被**插件面板**(渲染)与**单测**用着,写成纯函数才能在 node --test 里
 *     逐条钉住 —— 插件本身用 `toolbox://` 导入、跑不进单测;
 *   · 其中「要不要轮询」是这次改动里最要紧的一条:代理对高频请求敏感,
 *     "空闲就别打"必须是**能算出来**的决定,而不是散在某个 setTimeout 里的 if。
 *
 * ⚠️ 不许 import 任何 node: 模块(渲染进程要用)。
 */

/**
 * 状态 → 中文。
 *
 * ⚠️ `running` 是**实测**出来的:2026-10-05 真跑一次 1080P 下载,11 帧采样里
 * `getTaskList` 与 `getActiveTask` 给的都是 `running`(0.18s → 3.59s,原始 JSON 在
 * `%TEMP%\kaiwu-bili-sample.json`)。而 `download`/`merge` 是我们早先从官方前端
 * bundle 里**扫字符串**猜的 —— 猜错的代价是**界面整个冻住**(见 isActiveStatus)。
 * 那两个猜出来的值仍然留着:老版本或别的分支可能真的用过,删掉只会让老任务显示成"处理中"。
 */
export const QUEUE_STATUS_LABEL = Object.freeze({
    waiting: '等待中',
    running: '下载中',
    download: '下载中',
    merge: '合并中',
    pause: '已暂停',
    done: '已完成',
    error: '失败',
});

/**
 * 认不出来的状态显示成什么。**必须是中文** ——
 * 界面上出现 `running` 这种原始 token 就是 bug(用户报的那次就是这个:标签直接回退成了英文)。
 * 原始值不会被丢掉:面板把它放进胶囊的 `title`,排查时悬停就能看到。
 */
export const UNKNOWN_STATUS_LABEL = '处理中';

export function statusLabel(status) {
    const key = String(status ?? '').trim();
    if (key === '') return '未知';
    return QUEUE_STATUS_LABEL[key] ?? UNKNOWN_STATUS_LABEL;
}

/**
 * 状态的 CSS 类名(面板上那个胶囊)。上游给的值是**不可信输入** ——
 * 直接拼进 className 时一个 `"a b"` 就能塞进两个类(甚至影响别的元素)。
 * 只放行小写字母/数字/下划线/连字符,其余一律归成 `unknown`。
 */
export function statusClass(status) {
    const key = String(status ?? '').trim().toLowerCase();
    return /^[a-z0-9_-]+$/.test(key) ? key : 'unknown';
}

/**
 * **终态**:到了这些值就不会再变,轮询可以停。
 *
 * ⚠️ 判据**只列终态**,其余(含我们现在还不认识的值)一律当"还在跑"。
 * 这是这次那个 bug 的根因修法:原来列的是"活跃状态"白名单(`download|merge`),
 * 上游真实用的是 `running` → 一个都不匹配 → `planPoll` 判定"没有进行中的任务" →
 * **停止轮询** → 界面永远停在第一次抓到的那一帧(用户看到的就是那个英文 badge)。
 * 换成"只列终态"之后,上游以后改名/新增状态,最坏的结果只是多轮一会儿,不会冻住。
 */
export const TERMINAL_STATUSES = Object.freeze(['done', 'error', 'pause']);

/**
 * 还在跑吗(轮询、live 动效、进度条都看它)。
 *
 * 空状态也算"还在跑":上游没给状态时,如果当成静止就会**永久冻住**;
 * 当成在跑最坏只是多打几次请求(而且空闲时队列里根本没有任务,轮不到它)。
 */
export function isActiveStatus(status) {
    return TERMINAL_STATUSES.includes(String(status ?? '').trim()) !== true;
}

/**
 * 排序权重(小在前)。与 `isActiveStatus` **同一条判据**:只列已知的那几档,
 * 其余全部落到"进行中"那一档 —— 用户点完下载就是在等它,沉底等于看不见。
 */
export function statusRank(status) {
    const key = String(status ?? '').trim();
    if (key === 'done') return 4;
    if (key === 'error') return 1;
    if (key === 'pause') return 2;
    if (key === 'waiting') return 3;
    return 0;                       // 进行中(含 running 与以后新增的值)
}

/**
 * **真的在下/在合了吗**(决定 live 动效与进度条画不画)。
 *
 * 与 `isActiveStatus` 的差别只有一处:`waiting` 算活跃(要轮询,它随时会开始)
 * 但**不算在下**(还没开始,画一根 0% 的条 + 扫光只会让人以为卡住了)。
 * 上游那个卡 bug 只在"活跃判据"上,这一条纯粹是显示层的分寸。
 */
export function isRunningStatus(status) {
    const key = String(status ?? '').trim();
    return isActiveStatus(key) === true && key !== 'waiting';
}

/** 清晰度 → 中文。与代理侧 web_api.py 的 QUALITY_LABELS 是同一套(代理也会直接给 formatLabel)。 */
export const QUALITY_LABELS = Object.freeze({
    116: '高清 1080P60',
    112: '高清 1080P+',
    80: '高清 1080P',
    74: '高清 720P60',
    64: '高清 720P',
    32: '清晰 480P',
    16: '流畅 360P',
});

/** 阶段 → 中文。进度条旁边那一小段字,告诉用户"现在在下/合的是哪一段"。 */
export const PROGRESS_PHASE_LABEL = Object.freeze({
    audio: '音频',
    video: '视频',
    merge: '合并',
    final: '收尾',
});

export function qualityLabel(format) {
    const n = Number(format);
    // 0 与非法值都当"上游没给清晰度":渲染成 "某视频 [0]" 是纯噪音。
    if (!Number.isFinite(n) || n <= 0) return '';
    return QUALITY_LABELS[n] ?? String(n);
}

/**
 * 面板上显示的名字。
 *
 * ⚠️ 上游 getTaskList 的 title **已经**带清晰度后缀(代理建任务时就拼进去了:
 * `中国人能飞😭 [高清 1080P60]`),所以这里只在这个后缀**不在**标题里时才补 ——
 * 否则会渲染成"…[高清 1080P60] [高清 1080P60]"(设计稿第一版就撞上了)。
 */
export function displayTitle(task) {
    const title = String(task?.title ?? '').trim() || '(无标题)';
    const label = qualityLabel(task?.format);
    if (label === '' || title.includes(label)) return title;
    return `${title} [${label}]`;
}

/** 秒 → m:ss / h:mm:ss。0 或非数给 `--:--`(队列里 duration 可能是 0)。 */
export function formatDuration(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return '--:--';
    const total = Math.floor(n);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** 加入时间 → 本地 hh:mm。认不出来就空串(宁可不显示,也不显示 Invalid Date)。 */
export function formatClock(createAt) {
    const raw = String(createAt ?? '').trim();
    if (raw === '') return '';
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 倒计时读数 `M:SS`(解析被风控冷却时那行「已暂停请求,1:58 后恢复」用它)。
 *
 * 与代理侧的 python `_format_mmss` 是同一个格式 —— 两边都要显示它(proxy 在失败文案里、
 * 面板每秒刷新一次),格式必须一致,否则同一次冷却在界面上会出现两种写法。
 * 负数/非数一律给 `0:00`(不倒着数)。
 */
export function formatCountdown(seconds) {
    const n = Number(seconds);
    const total = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 字节 → 人能读的大小(复制/打开之前提示用得到)。 */
export function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 把上游那个比例收敛到 0–1;缺字段/非法值给 **null**(而不是 0 —— 两者意思完全不同)。 */
function fraction(raw) {
    // ⚠️ `Number(null) === 0`、`Number('') === 0`:不显式排掉空值,"没给这个字段"
    // 就会被读成"进度 0" —— 那正是"画一根永远不动的假进度条"的来源。
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    if (Number.isFinite(n) !== true) return null;
    return Math.max(0, Math.min(1, n));
}

/**
 * 进度:当前**阶段** + 一个**单调**的整体百分比。
 *
 * 实测出处(可复核):2026-10-05 真跑一次 1080P 下载(68 秒的片子),每 120ms 同时采
 * `getTaskList` 与 `getActiveTask`,11 个不同的帧(原始 JSON 在报告里):
 *
 *   status  : running ……(全程)→ done
 *   audio   : 0 → 0.067 → 0.423 → 1
 *   video   : 0 → 0.0038 → 0.0386 → 0.275 → 1
 *   merge   : 0 → 0.985 → 1
 *   progress: **每一帧都是 null** —— 上游根本没有这个字段(代理里那个 `progress` 恒为 0)
 *   speed   : 同样从来没有
 *
 * 三个结论(都是量出来的,不是猜的):
 *   ① 单位是 **0–1 的比例**,不是 0–100 —— 旧代码按百分比读,于是填充条最多只走 1%;
 *   ② 顺序是 **音频 → 视频 → 合并**(音频先下完,video 才开始涨);
 *   ③ 没有"整体进度"这个字段,得自己从这三段算。
 *
 * 为什么整体进度取**三段等权平均**,而不是"当前这一段自己的百分比":
 *   分段各自的百分比在换段时会归零(音频 1 → 视频 0),而状态标签现在统一是「下载中」
 *   (实测 running 覆盖了全过程),没有任何东西解释那次归零 —— 看起来就是进度倒退。
 *   等权平均在实测序列上是**单调**的:0 → 2 → 14 → 33 → 33 → 35 → 42 → 67 → 100。
 *   ⚠️ "等权"是一个**显示约定**,不是上游给的数 —— 所以它写在注释里,而不是假装是量出来的。
 *
 * `known:false` = 三个字段一个都没给(比如上游换了字段名)。这时面板**不许画进度条**:
 * 画一根永远 0% 的条比不画更糟(用户会以为卡死了)。
 *
 * @returns {{known:boolean, percent:number|null, phase:string}}
 */
export function progressOf(task) {
    const v = fraction(task?.videoProgress);
    const a = fraction(task?.audioProgress);
    const m = fraction(task?.mergeProgress);
    if (v === null && a === null && m === null) return { known: false, percent: null, phase: '' };
    const percent = Math.max(0, Math.min(100, Math.round((((v ?? 0) + (a ?? 0) + (m ?? 0)) / 3) * 100)));
    // 阶段 = 第一段还没满的。三段都满而状态还没到终态 = 收尾(实测里有 1.3 秒这一档)。
    const phase = (a ?? 1) < 1 ? 'audio' : ((v ?? 1) < 1 ? 'video' : ((m ?? 1) < 1 ? 'merge' : 'final'));
    return { known: true, percent, phase };
}

/** 按状态权重排序(不改原数组);同权重按创建时间新的在前。 */
export function sortTasks(tasks) {
    const list = Array.isArray(tasks) ? tasks.slice() : [];
    return list.sort((a, b) => {
        const oa = statusRank(a?.status);
        const ob = statusRank(b?.status);
        if (oa !== ob) return oa - ob;
        const ta = Number(a?.createAtMs) || 0;
        const tb = Number(b?.createAtMs) || 0;
        return tb - ta;
    });
}

/** 头部那行汇总:总数 / 已完成 / 进行中。 */
export function summarize(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const done = list.filter(t => t?.status === 'done').length;
    const active = list.filter(t => isActiveStatus(t?.status)).length;
    const failed = list.filter(t => t?.status === 'error').length;
    return { total: list.length, done, active, failed, hasActive: active > 0 };
}

/**
 * **要不要继续轮询** —— 这次改动里最要紧的一条判据。
 *
 * 三条规则(都能被单测逐条钉住):
 *   1. 队列空 → 不轮(刚打开面板、或者任务都被删了);
 *   2. 有任务但没有一个在进行中 → **不轮**(用户要的是"空闲就彻底安静");
 *   3. 上一次取队列失败 → 不轮(服务多半没起来;继续打只会刷日志,
 *      由界面给一个「重试」按钮 + 服务状态变化时自动再来一次)。
 *
 * @param {{tasks?:Array, failed?:boolean, activeMs?:number}} input
 * @returns {{poll:boolean, delayMs:number, reason:string}}
 */
export function planPoll({ tasks, failed = false, activeMs = 1500 } = {}) {
    const interval = Number.isFinite(activeMs) && activeMs > 0 ? Math.floor(activeMs) : 1500;
    if (failed === true) {
        return { poll: false, delayMs: 0, reason: '上一次取队列失败,已停止轮询(点「重试」或等服务起来)' };
    }
    const list = Array.isArray(tasks) ? tasks : null;
    if (list === null) return { poll: false, delayMs: 0, reason: '还没取到队列,先不轮询' };
    if (list.length === 0) return { poll: false, delayMs: 0, reason: '队列是空的,不轮询' };
    const active = list.filter(t => isActiveStatus(t?.status)).length;
    if (active === 0) {
        return { poll: false, delayMs: 0, reason: '没有进行中的任务,停止轮询' };
    }
    return { poll: true, delayMs: interval, reason: `有 ${active} 个进行中的任务,每 ${interval}ms 取一次` };
}

/**
 * 复制之前对文件名的判定(纯函数,由主进程使用)。
 *
 * 为什么要有它:代理已经给了解析好的 `filePath`,但**渲染进程递进来的 taskId 不可信**,
 * 而路径最终会进剪贴板。所以主进程要重新把"这个任务 + 这个路径"核一遍:
 * 路径必须是那一个任务自己的、必须真的存在、必须落在它自己的下载目录里。
 * 宁可在这里拒掉,也不要复制一个来源不明的路径。
 */
export function admitCopyTarget({ queue, taskId, stat } = {}) {
    const id = Number(taskId);
    if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, code: 'bad_task_id', reason: `taskId 必须是一个正整数,收到:${String(taskId)}` };
    }
    const tasks = Array.isArray(queue?.tasks) ? queue.tasks : null;
    if (tasks === null) {
        return { ok: false, code: 'bad_queue', reason: '取到的下载队列不是一个带 tasks 数组的对象' };
    }
    const task = tasks.find(t => Number(t?.id) === id);
    if (task === undefined) {
        return { ok: false, code: 'task_missing', reason: `下载队列里没有任务 ${id}(可能已经被删掉了)` };
    }
    if (task.status !== 'done') {
        return {
            ok: false,
            code: 'task_not_done',
            reason: `任务 ${id} 现在还不是「已完成」(${statusLabel(task.status)}),没有可复制的文件`,
        };
    }
    const filePath = String(task.filePath ?? '').trim();
    if (filePath === '') {
        return {
            ok: false,
            code: 'file_unresolved',
            reason: task.fileReason || '这个任务还没定位到最终文件(可能还没下载完,或文件名被改过)',
        };
    }
    const folder = String(task.folder ?? '').trim();
    if (folder === '') {
        return { ok: false, code: 'folder_missing', reason: '这个任务没有下载目录,无法确认文件位置' };
    }
    // 路径必须落在它自己声明的下载目录里 —— 防的是"队列数据被换成别的路径"
    const normalize = (value) => String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const normalizedFolder = normalize(folder);
    const normalizedPath = normalize(filePath);
    if (!normalizedPath.startsWith(normalizedFolder + '\\')) {
        return {
            ok: false,
            code: 'outside_folder',
            reason: `解析出的文件不在这个任务的下载目录里,已拒绝(路径:${filePath})`,
        };
    }
    if (typeof stat !== 'function') {
        return { ok: false, code: 'wiring', reason: '内部错误:admitCopyTarget 没有拿到 stat,无法确认文件是否存在' };
    }
    const info = stat(filePath);
    if (info === null || info === undefined || info.exists !== true) {
        return { ok: false, code: 'file_missing', reason: `文件不在了:${filePath}` };
    }
    if (info.isFile === false) {
        return { ok: false, code: 'not_a_file', reason: `这个路径不是一个文件:${filePath}` };
    }
    return { ok: true, taskId: id, filePath, fileName: String(task.fileName ?? ''), size: Number(info.size) || 0 };
}
