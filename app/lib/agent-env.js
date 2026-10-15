// Agent 子进程的环境变量与**唯一的起进程入口**。**纯函数**,放 app/lib 是为了能直接单测。
//
// 这个文件存在的唯一理由:把「Agent 永远没有写盘能力」从一句约定
// 变成一条**不可配置**的代码事实(设计文档 §5.3b)。
// 默认模式下 ACP 的审批根本不出现,read-only 下批准也不生效 ——
// 所以"AI 改笔记"绝不能寄托在审批上,只能靠这个环境变量。
//
// ⚠️ buildAgentEnv 只是**构造器**:它能保证"用它拼出来的 env 是 read-only",
// 但挡不住谁在别处自己拼一份 env 再 spawn —— 那条边界会悄无声息地重新打开。
// 所以这里再出一个 createAgentSpawn:想拉起 Agent 的最省事路径就是走它,
// 而它把 read-only 环境**和这个库的 cwd**一起烤进那个零参 spawnChild 里。
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

/** 不允许任何调用方覆盖。 */
export const AGENT_PERMISSION_MODE = 'read-only';

/**
 * @param {{base?:object, dshHome?:string}} deps
 * @returns {object} 新的 env 对象(不改传入的 base)
 */
export function buildAgentEnv({ base = {}, dshHome } = {}) {
    const env = { ...base };
    // 放在展开之后:调用方递进来的同名字段一律被覆盖
    env.DSH_PERMISSION_MODE = AGENT_PERMISSION_MODE;
    if (typeof dshHome === 'string' && dshHome !== '') env.DSH_HOME = dshHome;
    return env;
}

/**
 * kaiwu 自己的 DSH_HOME 的**唯一**解析点。
 *
 * 为什么要收敛到一处:spawn 与凭证检测各自解析 DSH_HOME 时会**静默不一致**。
 * 本机实测:继承来的 DSH_HOME 是 harness 自己的家(那里**有** .credentials.yaml),
 * 而 kaiwu 的家 `%APPDATA%\kaiwu\dsh-home` 没有 —— 于是 Agent 其实能用,
 * 界面却对用户说"你没配凭证"。两处必须拿到**同一个字符串**。
 *
 * 优先级(从高到低):
 *   ① **设置页里配的**(`configured`)—— 那是用户明确指定、并且能在界面上看见的家;
 *   ② 显式 DSH_HOME(env,只有调用方真的递进来才算);
 *   ③ `%APPDATA%\kaiwu\dsh-home`。
 * ⚠️ ①里给相对路径时**不采信**(退回 ②③):相对的家随子进程 cwd 飘,而 cwd 是用户的
 * Vault —— 那个家会在不同笔记库之间变,是最难查的一类错。设置页也会当场拒掉这种输入。
 *
 * **算不出绝对路径时返回空串**,绝不返回相对路径:相对的家由子进程的 cwd 决定,
 * 而 cwd 是用户的 Vault —— 那个家会在不同笔记库之间飘,里面的 .credentials.yaml
 * 时有时无,而面板检查的是另一个家。旧实现 `path.join('', 'kaiwu', 'dsh-home')`
 * 恰好会在没有 APPDATA 时产出 `kaiwu\dsh-home` 这个相对路径,并被原样写进子进程 env。
 * 空串是"说得出口的失败":上层(createAgentSpawn)据此拒绝启动,而不是递一个飘的家。
 *
 * @param {{env?:object, appData?:string, configured?:unknown}} [deps]
 * @returns {string} 绝对路径,或空串(= 算不出来)
 */
export function resolveKaiwuDshHome({ env, appData, configured } = {}) {
    const fromSettings = typeof configured === 'string' ? configured.trim() : '';
    if (fromSettings !== '' && path.isAbsolute(fromSettings)) return fromSettings;
    const e = env ?? process.env;
    const fromEnv = typeof e.DSH_HOME === 'string' ? e.DSH_HOME.trim() : '';
    if (fromEnv !== '') return path.isAbsolute(fromEnv) ? fromEnv : '';
    const app = appData ?? e.APPDATA;
    // 没有 APPDATA(非 Windows / 被清过的环境)也不能抛 —— 但只能给出空串,
    // 不能用一个相对路径把"解析失败"包装成"解析成功"。
    if (typeof app !== 'string' || app.trim() === '') return '';
    return path.resolve(app, 'kaiwu', 'dsh-home');
}

/**
 * 让"省略 dshHome"也能落到**同一个**解析点上。
 *
 * ⚠️ 解析之前必须把 base 里**继承来的** DSH_HOME 摘掉。base 默认就是 process.env,
 * 于是省略 dshHome 时旧实现会把子进程丢回继承 —— 而继承来的那个 DSH_HOME
 * 本机实测正是 harness 自己的家(那里有 .credentials.yaml),kaiwu 的家却没有:
 * Agent 其实能用,面板却对用户说"你没配凭证"。**继承来的值绝不许决定 Agent 用哪个家**,
 * 所以这里让解析点只按 kaiwu 自己的规则(显式 dshHome > %APPDATA%\kaiwu\dsh-home)
 * 给出 kaiwu 的家。想把 kaiwu 指到别处只有一条路:**显式**传 dshHome
 * (探针就是这么做的:先 resolveKaiwuDshHome({env: process.env}) 再显式递进来)。
 *
 * @param {object} [base]
 * @returns {string}
 */
function kaiwuOwnDshHome(base) {
    const rest = { ...(base !== null && typeof base === 'object' ? base : {}) };
    delete rest.DSH_HOME;
    return resolveKaiwuDshHome({ env: rest });
}
/**
 * 造一个**零参**的 `spawnChild`(监护人注入的就是这个形状:
 * `() => ChildProcess`),它每次调用都:
 *   - 用 `buildAgentEnv` 产出那份**不可配置**的 read-only 环境;
 *   - 把 `cwd` 固定成当前 Vault —— 这是同一条能力边界的**读**那一半
 *     (设计文档 §5.4:Agent 的 cwd 就是当前 Vault);
 *   - 给出 `dshHome`(见 resolveKaiwuDshHome):省略/空值时由唯一的解析点
 *     算出 kaiwu 自己的家,**不靠继承**。
 *
 * env / args / cwd 在**创建时**就冻结:调用点没有任何机会在两次 spawn 之间
 * 悄悄改掉它们,也没有"忘了调 buildAgentEnv"这个错法。
 *
 * @param {object} deps
 * @param {string} deps.command 可执行文件(node 或 dsh 入口)
 * @param {string[]} [deps.args]
 * @param {string} [deps.dshHome] kaiwu 自己的 DSH_HOME(用 resolveKaiwuDshHome 解析)。
 *   可省略:省略或给空/纯空白时,工厂自己走 resolveKaiwuDshHome 算出 kaiwu 的家 ——
 *   省略参数绝不许退化成"继承 base 里的 DSH_HOME"(那正是"agent 能用、面板说没凭证"那条缝)。
 * @param {string} deps.cwd 当前 Vault —— Agent 的工作目录,必填
 * @param {object} [deps.base] 继承用的进程环境;默认 process.env —— 子进程 spawn
 *   本来就默认继承,不继承会让 Agent 连 PATH 都没有
 * @param {Function} [deps.spawn] 注入点:测试用假 spawn,不真的起进程
 * @returns {() => import('node:child_process').ChildProcess}
 */
export function createAgentSpawn({
    command,
    args = [],
    dshHome,
    cwd,
    base = process.env,
    spawn = nodeSpawn,
} = {}) {
    if (typeof command !== 'string' || command === '') {
        throw new Error('createAgentSpawn 需要 command(可执行文件),接错线的工厂不该拖到起进程才炸');
    }
    if (typeof cwd !== 'string' || cwd === '') {
        // 没有"这是哪个库"就不该起 Agent:cwd 是能力边界的读那一半。
        throw new Error('createAgentSpawn 需要 cwd(当前 Vault)—— 没有它 Agent 就没有工作目录');
    }
    // ⚠️ 这里**先归一化再解析**:'' 与纯空白在 buildAgentEnv 眼里就是"没给",
    // 于是一个笔误同样会把子进程丢回继承 —— 所以空值一并交给解析点兜底。
    const explicitHome = typeof dshHome === 'string' ? dshHome.trim() : '';
    const home = explicitHome !== '' ? explicitHome : kaiwuOwnDshHome(base);
    // 家算不出来就**不许起进程**:一个相对的家会按子进程 cwd 解析(而 cwd 是用户的
    // Vault),于是 Agent 用的家随笔记库飘,而面板检查的是另一个家 —— 用户看到
    // "agent 明明能用、界面却说没凭证",或者反过来。宁可不启动,也不递一个飘的家。
    if (home === '' || !path.isAbsolute(home)) {
        throw new Error('createAgentSpawn 算不出 kaiwu 的 DSH_HOME(既没有显式的绝对路径,'
            + '也没有可用的 %APPDATA%)—— 宁可不启动 Agent,也不给它一个相对的家');
    }
    // 冻结在创建那一刻:args 拷贝一份,env 只算一次。
    const frozenArgs = [...args];
    const options = {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: buildAgentEnv({ base, dshHome: home }),
        // ⚠️ 这一条**不是**"Agent 起不来"那个故障的原因 —— 两个方向都实测过
        // (加上它 ready、摘掉它同样 ready),别把它当成那次修复。
        // 留着它是因为它本来就该有:kaiwu 是 GUI 进程(没有控制台),而 Agent 是控制台程序,
        // 不写这一条时 Windows 会给子进程**新建一个控制台窗口**(机器上多一个 conhost.exe),
        // 用户会看到一个黑窗口挂在那儿。写上是 CREATE_NO_WINDOW:不新建、不闪窗口。
        windowsHide: true,
    };

    return function spawnChild() {
        return spawn(command, [...frozenArgs], options);
    };
}
