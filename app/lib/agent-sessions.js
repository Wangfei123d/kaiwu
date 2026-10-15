// 「AI 会话」里**对端那半边**的判据:会话状态、失败原因说人话。纯逻辑,不碰 IPC/fs/DOM。
//
// 为什么要单独一层:对端(ACP 桥)只回 `{sessionId, cwd}`,而界面要回答的是
// "这条还能不能接着聊"。这条判定有**三条实测约束**(见 dsh-acp 的 resumeSession):
//   · `cwd` 必须与当初建会话时是同一个目录(realpath 比较)→ 换过库的会话续不了;
//   · 会话正在活跃 → 拒;子代理派生出来的会话 → 拒;
//   · `session/list` **不列正在活跃的会话** —— 所以"我方已经接上的那些"必须自己记着,
//     拿它去补对端那份清单(否则刚接上的那条会从清单里"消失")。
// 这三条都是英文错误串,翻译与归类都放在这里,单测直接钉。

/** 一条会话在"能不能接着聊"这件事上的状态。 */
export const SESSION_STATE = Object.freeze({
    /** 这条连接里已经活着 —— 本地切过去就行,不必问对端。 */
    LIVE: 'live',
    /** 对端那份清单里有它 —— 可以 resume。 */
    RESUMABLE: 'resumable',
    /** 对端明确没有它(而且这次清单是**问到了**的)→ 只能只读回看。 */
    GONE: 'gone',
    /** 还没问到(没连接 / 问失败)→ 不知道,不猜。 */
    UNKNOWN: 'unknown',
});

/** 状态 → 界面上那个小徽标的字。`''` = 不显示徽标。 */
export const STATE_LABEL = Object.freeze({
    live: '正在聊',
    resumable: '可接着聊',
    gone: '上下文已不在',
    unknown: '',
});

const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * 一条会话的状态。
 *
 * @param {object} input
 * @param {string} input.id
 * @param {Set<string>|Array<string>} input.liveIds 这条连接里已经接上的
 * @param {Set<string>|Array<string>} input.peerIds 对端清单里的(通常是**不含活跃会话**的那些)
 * @param {boolean} input.peerOk 这次清单**问到了**没有(没问到 → 不许说"已不在")
 */
export function sessionStateOf({ id, liveIds, peerIds, peerOk }) {
    const sid = String(id ?? '');
    if (sid === '') return SESSION_STATE.UNKNOWN;
    const has = (set) => (set instanceof Set ? set.has(sid) : asArray(set).includes(sid));
    if (has(liveIds)) return SESSION_STATE.LIVE;
    if (has(peerIds)) return SESSION_STATE.RESUMABLE;
    // ⚠️ "不在清单里"只有在**清单真的问到了**时才算数:没连接的情况下说"上下文已不在"
    //    是拿"不知道"冒充"没有",用户会以为记录废了(实测这条最容易写错)。
    return peerOk === true ? SESSION_STATE.GONE : SESSION_STATE.UNKNOWN;
}

/**
 * 台账的行 + 对端清单 → 界面要画的行。
 * @param {Array<object>} rows 台账来的(带 id/title/updatedAt/…)
 * @param {{liveIds?:Set|Array, peerIds?:Set|Array, peerOk?:boolean}} peer
 * @param {string} [currentId] 当前正在聊的那一条
 */
export function decorateRows(rows, peer = {}, currentId = '') {
    return asArray(rows).map((row) => {
        const state = sessionStateOf({
            id: row.id,
            liveIds: peer.liveIds ?? [],
            peerIds: peer.peerIds ?? [],
            peerOk: peer.peerOk === true,
        });
        return {
            ...row,
            state,
            stateLabel: STATE_LABEL[state] ?? '',
            current: String(row.id) === String(currentId),
        };
    });
}

/**
 * resume 失败时对端说的话 → 归类 + 一句中文。
 *
 * ⚠️ 认不出就回 `kind: null` 且 `reason: null` —— **原样把英文交给用户**,
 *    不许硬翻成一句"恢复失败"了事(那样排障时什么都看不到)。
 *
 * @returns {{kind:'live'|'gone'|'wrong-cwd'|null, reason:string|null}}
 */
export function resumeFailureOf(raw) {
    const text = String(raw ?? '');
    if (/is already active/i.test(text)) {
        return { kind: 'live', reason: '这条会话在对端还开着 —— 开物直接用它继续聊。' };
    }
    if (/is not resumable/i.test(text)) {
        return { kind: 'gone', reason: '对端已经不留这条会话的上下文了(它可能是子代理派生出来的,或已被清理)。只能只读回看。' };
    }
    if (/cwd does not match/i.test(text)) {
        return { kind: 'wrong-cwd', reason: '这条会话是在**另一个笔记库**里聊的 —— 会话的上下文绑着当时的工作目录,换库之后接不回来。' };
    }
    return { kind: null, reason: null };
}

/** 会话目录的相对路径(插件与文档里都要用同一个写法)。 */
export const SESSION_DIR_HINT = 'AI会话/';
