// 「用自带浏览器取数据」:让页面自己发请求,我们把响应体抓回来。
//
// 为什么需要它:有些站点的接口被风控守着,而通过风控的**签名是页面自己的 JS 算的**。
// 抖音就是典型:a_bogus 那套复刻已经跟当前的 Argus 对不上(纯 HTTP 一律
// "Signature Not Found"),但页面自己发的请求一定是 200 —— 实测那条
// /aweme/v1/web/aweme/detail/ 的响应有 109KB,标题/作者/播放地址全在里面。
//
// 所以这里不试图复刻签名,而是:打开那个页面 → 挂 CDP → 把页面**自己**那个请求的
// 响应体读出来。页面用什么签名都无所谓,那是它自己的事。
//
// 三个必须记住的坑(都是实测踩出来的,不是推测):
//   1. **绝不在 CDP 的 message 回调里 await sendCommand** —— 会死锁,整个进程挂住。
//      把 requestId 排进队列,等导航结束后再取 body。
//   2. **别在窗口刚建好就 debugger.attach** —— 会拿到
//      "target closed while handling command"。顺序要:先 loadURL → 再 attach →
//      Network.enable → reload(这样第二遍加载的请求能被抓到)。
//   3. **getResponseBody 会失败**(HTML 里那几个同名请求有的已回收,报
//      "No resource with given identifier found")。所以要把队列里每个都试着取,
//      取不到的留着下次再试,而不是取一次就丢。
import { BrowserWindow } from 'electron';

const DEFAULT_TIMEOUT_MS = 45000;
const POLL_MS = 700;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 在指定会话分区里打开 url,抓取 URL 命中 capture 之一的响应体,解析成 JSON 返回。
 *
 * @param {object} opts
 * @param {string} opts.url         要打开的页面
 * @param {string[]} opts.capture   响应 URL 需要包含的片段(命中任一即可)
 * @param {string} opts.partition   Electron 会话分区(通常是登录用的持久分区)
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.log]
 * @returns {Promise<{ok:boolean, json?:any, url?:string, status?:number,
 *                    bytes?:number, error?:string, seen?:number}>}
 */
export async function fetchJsonViaPage({
    url,
    capture,
    partition,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = console,
}) {
    const patterns = (Array.isArray(capture) ? capture : []).filter(p => typeof p === 'string' && p);
    if (patterns.length === 0) return { ok: false, error: 'capture 为空:没说要抓哪个请求' };

    const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
            partition,
            contextIsolation: true,
            nodeIntegration: false,
            // 隐藏窗口会被 Chromium 节流(定时器降频),页面可能因此不发数据请求
            backgroundThrottling: false,
        },
    });

    const seen = [];
    try {
        win.webContents.setAudioMuted(true);

        // 1) 先正常加载一次(让 target 就绪、顺便把 Cookie 带上)
        await win.loadURL(url).catch(err => log.warn?.('[browser] 首次加载失败', err));

        // 2) 再挂 CDP,然后 reload —— 这一遍的请求才会被抓到
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Network.enable');
        win.webContents.debugger.on('message', (_e, method, params) => {
            if (method !== 'Network.responseReceived') return;
            const u = params.response?.url ?? '';
            if (!patterns.some(p => u.includes(p))) return;
            // 只排队,绝不在回调里 await(见文件头第 1 条)
            seen.push({ id: params.requestId, url: u, status: params.response.status });
        });
        win.webContents.reload();

        // 3) 轮询取 body:取不到的先留着,下一轮再试
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await sleep(POLL_MS);
            if (win.isDestroyed()) return { ok: false, error: '窗口被提前关掉了', seen: seen.length };
            for (let i = 0; i < seen.length; i++) {
                const item = seen[i];
                if (item.dead) continue;
                try {
                    const body = await win.webContents.debugger.sendCommand(
                        'Network.getResponseBody', { requestId: item.id });
                    const text = body?.body ?? '';
                    if (!text) continue;
                    if (body.base64Encoded) continue;
                    let json = null;
                    try { json = JSON.parse(text); } catch { continue; }
                    return {
                        ok: true, json, url: item.url, status: item.status, bytes: text.length,
                        seen: seen.length,
                    };
                } catch {
                    // 这个请求的响应体已经回收了:标记一下,试下一个
                    item.tries = (item.tries ?? 0) + 1;
                    if (item.tries >= 3) item.dead = true;
                }
            }
        }
        return { ok: false, error: `等了 ${Math.round(timeoutMs / 1000)} 秒也没抓到页面自己的请求`, seen: seen.length };
    } catch (err) {
        return { ok: false, error: String(err?.message ?? err), seen: seen.length };
    } finally {
        try { win.webContents.debugger.detach(); } catch { /* 没挂上或已销毁 */ }
        if (!win.isDestroyed()) win.destroy();
    }
}
