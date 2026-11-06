// 设置页的**纯逻辑**:分区与项目清单、搜索过滤、路径校验、动效开关取值、分布统计。
//
// 为什么单独一个纯模块(与 panel-tree.js / agent-video.js 同一个立场):
//   ① 自检一次 30-60 秒,靠它验"判据本身对不对"太贵 —— 这些判据要能被 node --test 直接跑;
//   ② "设置写到哪个键、空值是什么意思、什么算合法路径"这三件事**只能有一份**:
//      界面按它校验、主进程按它读,两边分叉的表现是"界面说存下了、实际没生效";
//   ③ 这些判据将来还要被"关于与诊断"那一类只读汇总复用(设计稿里就有)。
//
// ⚠️ 这个文件**不 import node:*、也不碰 DOM**:它同时被渲染进程与单测使用。

/**
 * 全局设置命名空间。
 *
 * 为什么用 `__global` 而不是新建一个:`electron/main.js` 的 `serviceRoot()` /
 * 布局存档 / 侧栏宽度都在这里,设置页只是同一批键的**另一个入口** ——
 * 新建一个命名空间会让"同一个设置有两个家",那正是漂移的来源。
 */
export const SETTINGS_NS = '__global';

/**
 * 设置页真正读写的键。**改这里就是改存档格式**(单测逐条钉着它们)。
 *
 * · `dshHome`      Agent 子进程的 DSH_HOME(空 = 按 kaiwu 的规则探测)
 * · `serviceRoot`  服务从哪个根目录拉起来(空 = DEFAULT_SERVICE_ROOT)
 * · `ui.motion`    'off' = 强制关掉动效;空 = 跟随系统
 */
export const SETTINGS_KEYS = Object.freeze({
    dshHome: 'dshHome',
    serviceRoot: 'serviceRoot',
    motion: 'ui.motion',
});

/** 「减少动态效果(强制关)」写在存档里的值。 */
export const MOTION_OFF = 'off';

/** 存档里的值 → 开关状态。只认字面 `off`,别的(含空/脏数据)一律当"跟随系统"。 */
export function motionOffFromSetting(raw) {
    return String(raw ?? '').trim() === MOTION_OFF;
}

/** 开关状态 → 写进存档的值(关掉时写空串,等价于"没设过")。 */
export function motionSettingFromToggle(off) {
    return off === true ? MOTION_OFF : '';
}

/**
 * 分区与项目(设计稿 `docs/kaiwu-settings-page-demo.html` 方案 D:左导航 + 搜索 + 表单)。
 *
 * 字段:
 *   · `badge`: 'has' = 通道/能力**已经存在**、只差界面;'new' = 这次要新做(动主进程)
 *   · `ctrl`:  渲染层据此挑控件(select / secret / status / path / toggle / layout / vault / index)
 *   · `restart`: true = **改了要重启开物才生效**(服务在启动时就拉起来了、DSH_HOME 是给
 *              子进程的环境)—— 界面上必须写出来,不许让用户以为立刻生效
 *   · `kw`:    搜索关键词(标题 + 说明之外的同义词,设计稿里就是这么过滤的)
 */
export const SETTINGS_SECTIONS = Object.freeze([
    {
        id: 'ai',
        name: 'AI 与 Agent',
        items: Object.freeze([
            {
                id: 'videoModel',
                title: '视频理解模型',
                hint: '决定「理解这一段视频」用哪个模型(走 video:model:set 这条已有通道)',
                badge: 'has', ctrl: 'select', restart: false,
                kw: '模型 视频 理解 ai flash plus qwen',
            },
            {
                id: 'videoKey',
                title: 'DashScope 密钥',
                hint: '与 AI 面板那张密钥卡同一个通道:不回显、不进日志、不进任何状态返回值',
                badge: 'has', ctrl: 'secret', restart: false,
                kw: '密钥 key dashscope 阿里云 凭证',
            },
            {
                id: 'imageKey',
                title: '图片服务密钥',
                hint: '画面生成统一使用 APINebula gpt-image-2.5；密钥不回显、不写进短剧项目',
                badge: 'new', ctrl: 'image-secret', restart: false,
                kw: '图片 画面 生图 apinebula image 密钥',
            },
            {
                id: 'credential',
                title: '凭证状态',
                hint: 'deepseek.apiKey 是否已配置(只读读数,不显示值)',
                badge: 'has', ctrl: 'status', restart: false,
                kw: '凭证 状态 deepseek agent 登录',
            },
            {
                id: 'agentKill',
                title: '停止 Agent 进程',
                hint: 'Agent 卡住 / 起不来时的退路(与 AI 面板输入卡片上那个按钮同一件事);'
                    + '停掉之后回对话面板点「重试」再连',
                badge: 'has', ctrl: 'kill', restart: false,
                kw: '停止 进程 kill agent 卡住 没反应 重启 退出',
            },
            {
                id: 'dshHome',
                title: 'DSH_HOME',
                hint: '留空 = 用 kaiwu 自己的家(先看显式 DSH_HOME,再看 %APPDATA%\\kaiwu\\dsh-home)',
                badge: 'new', ctrl: 'path', restart: true,
                kw: 'dsh home 环境 凭证 agent 路径',
            },
        ]),
    },
    {
        id: 'ui',
        name: '界面',
        items: Object.freeze([
            {
                id: 'layout',
                title: '布局',
                hint: '拖乱之后的唯一出口;右边就是当前布局树文本(与底部那条读数条同源)',
                badge: 'has', ctrl: 'layout', restart: false,
                kw: '布局 面板 重置 拖动 树',
            },
            {
                id: 'motion',
                title: '减少动态效果',
                hint: '跟随系统已经生效;这个开关是强制关(扫光 / 队列流光 / 不确定态光带 / 星空)',
                badge: 'has', ctrl: 'toggle', restart: false,
                kw: '动效 动画 无障碍 reduced motion 星空',
            },
        ]),
    },
    {
        id: 'svc',
        name: '服务',
        items: Object.freeze([
            {
                id: 'serviceRoot',
                title: '服务根目录',
                hint: '服务从哪个根目录拉起来(cwd 与相对命令都按它解析);留空 = 用内置默认值',
                badge: 'new', ctrl: 'path', restart: true,
                kw: '服务 根目录 路径 serviceRoot 插件',
            },
        ]),
    },
    {
        id: 'vault',
        name: '笔记库',
        items: Object.freeze([
            {
                id: 'vaultPath',
                title: '库路径',
                hint: '换库的**唯一入口**(顶栏那块已按用户要求撤掉):点「更换」走首启向导那套流程,换完这里立刻显示新路径',
                badge: 'has', ctrl: 'vault', restart: false,
                kw: '笔记库 路径 vault 更换 目录',
            },
            {
                id: 'indexStatus',
                title: '索引状态',
                hint: '已载入多少篇笔记(读的是笔记视图那份索引,不另建一份)',
                badge: 'has', ctrl: 'index', restart: false,
                kw: '索引 笔记 数量 篇 载入',
            },
        ]),
    },
]);

/** 一条设置的搜索文本:标题 + 说明 + 关键词(设计稿里就是这个口径)。 */
export function itemSearchText(item) {
    const src = (item !== null && typeof item === 'object') ? item : {};
    return [src.title, src.hint, src.kw]
        .map((s) => String(s ?? ''))
        .join(' ')
        .toLowerCase();
}

/** 这一条匹配查询串吗(空查询 = 全匹配)。 */
export function matchesQuery(item, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (q === '') return true;
    return itemSearchText(item).includes(q);
}

/**
 * 跨分区过滤。命中即显示该分区,分区标题带命中数(`名称(2)`)—— 设计稿的行为。
 *
 * @returns {{total:number, sections:Array<{id:string,name:string,items:object[],hits:number}>}}
 */
export function filterSettings(query, sections = SETTINGS_SECTIONS) {
    const q = String(query ?? '').trim();
    const list = Array.isArray(sections) ? sections : [];
    const out = [];
    let total = 0;
    for (const sec of list) {
        const items = (Array.isArray(sec?.items) ? sec.items : []).filter((it) => matchesQuery(it, q));
        if (items.length === 0) continue;
        total += items.length;
        out.push({ id: sec.id, name: sec.name, items, hits: items.length });
    }
    return { total, sections: out };
}

/** 没有匹配项时那句中文(设计稿原文)。 */
export function emptySearchText(query) {
    const q = String(query ?? '').trim();
    return `没有匹配的设置项:${q}`;
}

/** 徽标分布(给页面顶部那行总览用:`已有通道 7 · 需要新做 2`)。 */
export function badgeCounts(sections = SETTINGS_SECTIONS) {
    let has = 0;
    let isNew = 0;
    for (const sec of (Array.isArray(sections) ? sections : [])) {
        for (const it of (Array.isArray(sec?.items) ? sec.items : [])) {
            if (it?.badge === 'has') has += 1;
            else if (it?.badge === 'new') isNew += 1;
        }
    }
    return { has, isNew };
}

/** 项目总数(分区标题下面那句"N 项")。 */
export function itemCount(sections = SETTINGS_SECTIONS) {
    return (Array.isArray(sections) ? sections : [])
        .reduce((n, sec) => n + (Array.isArray(sec?.items) ? sec.items.length : 0), 0);
}

/** Windows 路径里不允许出现的字符(盘符后面那个冒号单独判)。 */
const ILLEGAL_PATH_CHARS = /[<>"|?*\u0000-\u001f]/;

/**
 * 校验"路径类"设置。
 *
 * 口径(与设计稿上的说明一致):
 *   · 空(或纯空白)= **用默认/自动探测**,这是合法值,不是错误;
 *   · 必须**绝对路径**(`X:\…` / `X:/…` / UNC `\\server\share`):相对路径会随进程的
 *     工作目录飘 —— 而服务那条路的 cwd 是用户随时可以换的笔记库,飘起来最难查;
 *   · 不允许 Windows 非法字符,也不允许多出一个冒号(多半是把命令行参数粘进来了);
 *   · 包在外面的成对引号会去掉(从资源管理器复制路径常带引号)。
 *
 * @param {unknown} raw
 * @returns {{ok:boolean, value:string, reason:string, empty:boolean}}
 */
export function validatePathSetting(raw) {
    let text = String(raw ?? '').trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
    if (text === '') return { ok: true, value: '', reason: '', empty: true };
    const driveAbsolute = /^[A-Za-z]:[\\/]/.test(text);
    const unc = text.startsWith('\\\\');
    if (driveAbsolute !== true && unc !== true) {
        return {
            ok: false, value: text, empty: false,
            reason: '要写绝对路径(例如 D:\\kaiwu\\data)—— 相对路径会随进程的工作目录飘',
        };
    }
    if (ILLEGAL_PATH_CHARS.test(text)) {
        return { ok: false, value: text, empty: false, reason: '路径里有 Windows 不接受的字符(< > " | ? *)' };
    }
    // 盘符那个冒号之外还有冒号 → 基本是把 `--flag:value` 之类粘进来了
    if (text.slice(2).includes(':')) {
        return { ok: false, value: text, empty: false, reason: '路径里多了一个冒号 —— 只允许盘符后面那一个' };
    }
    return { ok: true, value: text, reason: '', empty: false };
}

/** 「改了要重启才生效」那句中文 —— 每一项自己声明(restart),界面照着它写。 */
export const RESTART_NOTICE = '改完要重启开物才生效';

/**
 * Agent 进程状态那几个名字 → 界面上的中文。
 *
 * 与 AI 面板里的 STATE_LABEL 是**同一批词**(那里给读屏用,这里给设置页那行读数用):
 * 两处写岔了就会变成"面板说已连接、设置页说未连接"。
 */
export const AGENT_STATE_LABEL = Object.freeze({
    stopped: '未连接',
    starting: '连接中…',
    ready: '已连接',
    stopping: '正在停止…',
    failed: '连接失败',
    crashed: '已断开(崩溃)',
});

/**
 * `agent:status` 的叶子字段 → 「停止 Agent 进程」那一项的读数与按钮状态。
 *
 * 为什么要有 `canStop`:**进程已经不在的时候按下去没有任何意义**,按钮该是灰的 ——
 * 但"连接失败/崩溃/正在起"都必须能按,那正是用户真正需要它的时刻(卡住的三种样子)。
 *
 * @param {unknown} status agent:status 的返回(只有叶子字段)
 * @returns {{state:string, label:string, canStop:boolean, detail:string}}
 */
export function describeAgentProcess(status) {
    const s = (status !== null && typeof status === 'object') ? status : null;
    if (s === null) return { state: 'unknown', label: '读不到', canStop: false, detail: 'agent:status 没回话' };
    const state = String(s.state ?? 'unknown');
    const label = AGENT_STATE_LABEL[state] ?? state;
    const pid = Number.isFinite(s.pid) ? `pid ${s.pid}` : '';
    const err = String(s.error ?? '').trim();
    const detail = err !== '' ? err : pid;
    return { state, label, canStop: state !== 'stopped', detail };
}

/**
 * 一次保存的结果提示(界面把它写在那一行下面)。
 *
 * @param {{ok:boolean, empty:boolean, reason:string}} verdict validatePathSetting 的结果
 * @param {boolean} wrote 真的写进设置了吗
 * @param {boolean} restart 这一项是不是"要重启才生效"
 */
export function savePathResultText(verdict, wrote, restart) {
    if (verdict?.ok !== true) return String(verdict?.reason ?? '这个值不能用');
    if (wrote !== true) return '没写进设置(通道出错,再试一次)';
    const base = verdict.empty === true ? '已清空:改回默认/自动探测' : '已保存';
    return restart === true ? `${base} —— ${RESTART_NOTICE}` : base;
}
