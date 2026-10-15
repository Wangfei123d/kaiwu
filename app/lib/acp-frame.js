// ACP over stdio 的分帧与编码。**纯函数** —— 放 app/lib 是为了能用 node --test 直跑。
//
// 协议是按行分隔的 JSON-RPC:一条消息一行 JSON,以 \n 结束。
// 分帧唯一的难点是管道给的是**任意切分**的字节块:一条消息可能分几次到达,
// 也可能一次到达好几条。把这件事做成纯函数,是为了让"半条消息"这种
// 最难在真实环境里复现的情况能被直接构造出来测。

/**
 * 把累积缓冲切成完整行,返回剩下的尾巴(由调用方留着等下一块)。
 * @param {string} buffer
 * @returns {{lines: string[], rest: string}}
 */
export function drainLines(buffer) {
    const lines = [];
    let rest = String(buffer ?? '');
    let idx;

    while ((idx = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, idx).trim();
        rest = rest.slice(idx + 1);
        // 空行直接丢:尾部换行不该产出一条空消息
        if (line !== '') lines.push(line);
    }

    return { lines, rest };
}

/**
 * 编码一条 JSON-RPC 消息。**必须带结尾换行** —— 对端按行读,
 * 少了换行这条消息就永远卡在它的缓冲里。
 * @param {object} msg
 * @returns {string}
 */
export function encodeMessage(msg) {
    return JSON.stringify(msg) + '\n';
}

/**
 * 把一行文本解析成消息。坏输入返回 null 而不是抛错:
 * 对端可能往 stdout 打了别的东西(日志、警告),那不该让整条链路炸掉。
 * @param {string} line
 * @returns {object|null}
 */
export function parseMessage(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }
    // 只有对象才算消息:null / 数字 / 字符串都是对端在乱打
    return (parsed !== null && typeof parsed === 'object') ? parsed : null;
}
