/**
 * 「复制视频」这一步的**纯逻辑**:拼 PowerShell 脚本、核对参数、把失败翻成中文。
 *
 * 背景(实测,不是推测):网页 API 放不进"文件"——`navigator.clipboard` 只能写
 * 文本/图片,而"粘到资源管理器/微信/剪映里直接出现文件"要的是剪贴板的
 * **CF_HDROP**(文件拖放列表)。所以这件事只能由主进程调 Windows 的剪贴板 API 来做。
 *
 * ⚠️ 实现路径**只能**是 Windows PowerShell 5.1 + `-STA` +
 * `[System.Windows.Forms.Clipboard]::SetFileDropList`:
 *   · pwsh(PowerShell 7)默认跑在 **MTA** 线程里,`Set-Clipboard -Path` 在 MTA 下
 *     **静默失败** —— 退出码 0、没有任何报错,而剪贴板里什么都不会变(实测);
 *   · `-STA` 是必需的,不能省(哪怕 5.1 的默认是 STA,也显式写出来:
 *     省掉之后一旦哪天换成 pwsh 就是"成功但没效果"这种最难查的失败)。
 *
 * 本文件是纯函数(不 import node:、不碰进程),所以脚本长什么样、参数怎么传、
 * 失败怎么解释,都能在 node --test 里逐条钉住。
 */

/** 走哪一支 PowerShell:必须是 5.1 的 powershell.exe(见文件头)。 */
export const POWERSHELL_EXE = 'powershell.exe';

/** 成功时脚本会打这一行 —— 用它区分"真写了"与"退出码 0 但什么都没干"。 */
export const CLIPBOARD_OK_MARKER = 'KAIWU_CLIPBOARD_OK';

/** 重试次数与间隔:剪贴板是全局独占资源,别的程序开着时 OpenClipboard 会直接失败。 */
export const CLIPBOARD_RETRIES = 5;
export const CLIPBOARD_RETRY_DELAY_MS = 120;

/** 单次调用的超时:正常几毫秒就完;卡住多半是剪贴板被死锁,不该无限等。 */
export const CLIPBOARD_TIMEOUT_MS = 8000;

/**
 * 复制目标允许的扩展名。
 *
 * 为什么要有白名单:这个通道会把一个**路径**交给系统的"文件"剪贴板,
 * 而路径来自代理。收窄到视频/音频容器,即使上游数据被换成了别的路径,
 * 也不会变成一个"任意文件进剪贴板"的通道。
 */
export const COPY_EXTENSIONS = Object.freeze(['.mp4', '.mkv', '.flv', '.mov', '.webm', '.m4a', '.aac']);

/** PowerShell 单引号字符串里的转义:一个单引号写成两个。 */
function psLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 校验一个路径能不能进这个通道。**主进程用它挡最后一道**。
 * @returns {{ok:true, path:string}|{ok:false, reason:string}}
 */
export function admitClipboardPath(filePath) {
    const raw = String(filePath ?? '');
    if (raw.trim() === '') return { ok: false, reason: '文件路径是空的' };
    if (/[\u0000-\u001f]/.test(raw)) return { ok: false, reason: '文件路径里有控制字符(换行等),已拒绝' };
    if (!/^[a-zA-Z]:\\/.test(raw)) return { ok: false, reason: `只接受本地绝对路径(形如 D:\\…),收到:${raw}` };
    const dot = raw.lastIndexOf('.');
    const ext = dot === -1 ? '' : raw.slice(dot).toLowerCase();
    if (!COPY_EXTENSIONS.includes(ext)) {
        return { ok: false, reason: `只允许复制视频文件(${COPY_EXTENSIONS.join(' / ')}),收到:${ext || '(没有扩展名)'}` };
    }
    if (raw.length > 1024) return { ok: false, reason: '文件路径太长了,已拒绝' };
    return { ok: true, path: raw };
}

/**
 * 拼出要执行的 PowerShell 脚本。
 *
 * 为什么把主逻辑写成脚本、而不是 `-Command` 里塞一长串:这样
 * `buildClipboardInvocation()` 的产物可以被单测逐字断言(脚本里必须有
 * SetFileDropList、必须有 -STA 侧的证据标记),而不是"我觉得它写对了"。
 */
export function buildClipboardScript(filePath) {
    const verdict = admitClipboardPath(filePath);
    if (verdict.ok !== true) throw new Error(verdict.reason);
    return [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.Windows.Forms',
        '$files = New-Object System.Collections.Specialized.StringCollection',
        `[void]$files.Add(${psLiteral(verdict.path)})`,
        '[System.Windows.Forms.Clipboard]::SetFileDropList($files)',
        `Write-Output ${psLiteral(CLIPBOARD_OK_MARKER)}`,
    ].join('\n');
}

/**
 * 拼出完整调用(命令 + 参数)。参数形状在这里定死,单测钉它。
 * @returns {{command:string, args:string[], script:string}}
 */
export function buildClipboardInvocation(filePath) {
    const script = buildClipboardScript(filePath);
    return {
        command: POWERSHELL_EXE,
        // -NoProfile:用户的 profile 可能改 $ErrorActionPreference / 输出编码;
        // -STA:见文件头(这是这条链路能不能成立的关键);
        // -ExecutionPolicy Bypass:脚本是命令行内联的,不受脚本文件策略影响,
        //   但显式写上能避开某些企业策略对 -Command 的额外拦截。
        args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
        script,
    };
}

/**
 * 把一次调用的结果翻成"能不能算成功"。
 *
 * ⚠️ 只有**看见标记**才算成功:退出码 0 不足以证明剪贴板真的变了
 * (MTA 下正是"退出码 0 + 什么都没发生")。
 *
 * @param {{stdout?:string, stderr?:string, code?:number|null, timedOut?:boolean}} result
 * @returns {{ok:boolean, reason:string}}
 */
export function interpretClipboardResult({ stdout = '', stderr = '', code = null, timedOut = false } = {}) {
    const out = String(stdout ?? '');
    const err = String(stderr ?? '').trim();
    if (timedOut === true) {
        return { ok: false, reason: `写系统剪贴板超时(${CLIPBOARD_TIMEOUT_MS}ms 没有返回)` };
    }
    if (out.includes(CLIPBOARD_OK_MARKER)) return { ok: true, reason: '' };
    if (/CLIPBRD_E_CANT_OPEN|OpenClipboard|剪切板|剪贴板.*占用|failed to open/i.test(err)) {
        return { ok: false, reason: `剪贴板被别的程序占用,重试 ${CLIPBOARD_RETRIES} 次仍失败` };
    }
    if (/Add-Type|System\.Windows\.Forms|is not recognized|CommandNotFound/i.test(err)) {
        return { ok: false, reason: `这台机器上的 Windows PowerShell 用不了 System.Windows.Forms:${err.slice(0, 160)}` };
    }
    if (code === null || code === undefined) {
        return { ok: false, reason: `没能启动 Windows PowerShell(没拿到退出码)${err === '' ? '' : `:${err.slice(0, 160)}`}` };
    }
    if (err !== '') return { ok: false, reason: `写剪贴板失败(退出码 ${code}):${err.slice(0, 200)}` };
    // 退出码 0、没报错、却没有标记 —— 现实里就是"MTA 下静默失败"那一类
    return {
        ok: false,
        reason: `PowerShell 报告成功,但没有写入剪贴板(通常是线程不是 STA)。请反馈:这是"静默失败"那一类`,
    };
}

/** 这个失败值不值得重试(剪贴板被占用 = 值;路径不存在/被拒 = 不值)。 */
export function isRetryableClipboardResult({ code = 0, timedOut = false, reason = '' } = {}) {
    if (timedOut === true) return true;
    if (/占用|CLIPBRD|failed to open/i.test(String(reason))) return true;
    if (typeof code === 'number' && code !== 0) return true;
    return false;
}
