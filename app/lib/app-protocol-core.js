// toolbox:// 请求处理器的纯实现:只依赖 fs 与 URL,不碰 electron 模块。
//
// 为什么放在 app/lib 而不是 electron/:这里沿用项目的分界 —— 标注"纯"的模块
// 不碰 DOM、不碰 Node 专属 API(或只碰可注入的 Node API),因此能在 node --test
// 里直接跑;electron/ 下的模块一律需要真实 Electron。
// 处理器是安全边界所在,必须能被单测直接覆盖,所以它留在这里;
// electron/app-protocol.js 只负责把它接到 protocol.handle 上。
import fs from 'node:fs';
import { resolveWithinReal, parseRange, mimeFor } from './path-guard.js';

function response(body, status, headers = {}) {
    return new Response(body, { status, headers });
}

// roots: { shell: 绝对路径, plugin: …, user: … }
// deps.fileSystem / deps.resolveReal 可注入,便于单测构造链接逃逸等现场。
export function createRequestHandler(roots, deps = {}) {
    const fileSystem = deps.fileSystem ?? fs;
    const resolveReal = deps.resolveReal ?? resolveWithinReal;

    return async function handleRequest(request) {
        let url;
        try {
            url = new URL(request.url);
        } catch {
            return response('URL 无法解析', 400);
        }

        const rootId = url.hostname;              // toolbox://plugin/palette/index.js → 'plugin'
        const rootDir = roots[rootId];
        if (!rootDir) return response('未知的资源根: ' + rootId, 404);

        // 畸形百分号编码(如 %zz)不能让处理函数抛出去 —— 否则请求方拿到的是
        // 未处理的异常而不是状态码。这也是一道边界:解码失败就不该继续往下走。
        let decodedPath;
        try {
            decodedPath = decodeURIComponent(url.pathname);
        } catch {
            return response('URL 编码非法', 400);
        }

        // 用真实路径层:词法层的 resolveWithin 挡不住符号链接 / 目录联接逃逸
        // (plugins/escape 指向 D:\ 时,"escape/secret.txt" 词法上确实在根目录内)。
        //
        // 注意 resolveWithinReal 把「越界」与「不存在」都收敛成 null,这里无法区分,
        // 一律回 403。这是刻意的取舍:越界探测不该靠响应码区分出「文件是否存在」;
        // 而正常路径下的拼写错误会落到下面 stat 抛错的 404 分支 —— 只有真实存在的
        // 越界目标才会走到这一行。
        const target = resolveReal(rootDir, decodedPath.replace(/^\//, ''));
        if (target === null) return response('路径越界', 403);

        let stats;
        try {
            stats = await fileSystem.promises.stat(target);
        } catch {
            return response('文件不存在', 404);
        }
        if (!stats.isFile()) return response('不是文件', 404);

        const type = mimeFor(target);
        const rangeHeader = request.headers?.get?.('range') ?? null;
        const range = rangeHeader === null
            ? { status: 'none' }
            : parseRange(rangeHeader, stats.size);

        // 语法合法但区间不可满足 → 416,并告知真实长度。
        // 'unsupported'(多段 / 语法不认)不算错误,按下面走 200 整份。
        if (range.status === 'unsatisfiable') {
            return response(null, 416, {
                'content-range': `bytes */${stats.size}`,
                'accept-ranges': 'bytes',
            });
        }

        const partial = range.status === 'range';
        const start = partial ? range.start : 0;
        const end = partial ? range.end : stats.size - 1;
        const length = stats.size === 0 ? 0 : end - start + 1;

        // HEAD 只要头,不要体。
        if (request.method === 'HEAD') {
            return response(null, partial ? 206 : 200, {
                'content-type': type,
                'content-length': String(length),
                'accept-ranges': 'bytes',
                ...(partial ? { 'content-range': `bytes ${start}-${end}/${stats.size}` } : {}),
            });
        }

        let body;
        try {
            body = await fileSystem.promises.readFile(target);
        } catch {
            return response('读取失败', 500);
        }

        const slice = partial ? body.subarray(start, end + 1) : body;

        return response(slice, partial ? 206 : 200, {
            'content-type': type,
            'content-length': String(slice.length),
            'accept-ranges': 'bytes',
            ...(partial ? { 'content-range': `bytes ${start}-${end}/${stats.size}` } : {}),
        });
    };
}
