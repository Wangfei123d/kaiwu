// URL 里的相对路径 → 文件系统路径的安全解析。主进程与渲染进程共用。
//
// 分两层,职责不同,都不能省:
//   resolveWithin     —— 纯词法层。挡 '../'、绝对路径、盘符、UNC、编码穿越。
//                        不碰文件系统,所以能在任何环境(含浏览器)里跑。
//   resolveWithinReal —— 真实路径层。挡符号链接 / 目录联接逃逸。
//                        词法层对此无能为力:plugins/escape 指向 D:\ 时,
//                        "escape/secret.txt" 词法上确实在根目录内。
import fs from 'node:fs';
import path from 'node:path';

// 纯函数:只做词法判断,不访问文件系统。解析失败(越界)返回 null。
export function resolveWithin(root, relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) return null;

    // 先解码:挡住 ..%2f 这类编码过的穿越。
    // 注意调用方可能已经解过一次码(见 app-protocol.js),这里再解一次是幂等的,
    // 单一编码不会被重复解码成穿越路径。
    let decoded;
    try {
        decoded = decodeURIComponent(relativePath);
    } catch {
        return null;            // 非法百分号编码
    }

    // 绝对路径一律拒绝(Windows 盘符、UNC、以及以 / 开头的)
    if (path.isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded) || decoded.startsWith('\\\\')) {
        return null;
    }

    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, decoded);

    // 解析后必须仍在根目录内。比较时补上分隔符,避免
    // "C:\a\plugins-evil" 被误判为在 "C:\a\plugins" 之内。
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    if (target !== resolvedRoot && !target.startsWith(prefix)) return null;

    return target;
}

// 在词法检查之上再解析真实路径,挡住链接逃逸。
// 返回可安全读取的、已解链接的真实路径;越界、不存在、或根本身不存在时返回 null。
//
// 「不存在也返回 null」是刻意的:不存在的东西没有「真实路径」可言,而若改用
// 「最近已存在祖先的真实路径」代替,根目录下任何不存在的文件都会返回根本身 ——
// 那个值恒等于 realRoot,包含判断必然通过,等于把这一层变成空操作。
export function resolveWithinReal(root, relativePath) {
    const target = resolveWithin(root, relativePath);
    if (target === null) return null;

    // 目标必须真实存在;realpath 会顺带把链接解掉,并让后续的包含判断
    // 作用在真实位置上,而不是用户写出来的那个路径上。
    let realTarget;
    try {
        realTarget = fs.realpathSync(target);
    } catch {
        return null;
    }

    // 根本身也可能是链接(用户可能把 userData 链到别处),两边都取真实路径再比较。
    let realRoot;
    try {
        realRoot = fs.realpathSync(path.resolve(root));
    } catch {
        return null;
    }

    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realTarget !== realRoot && !realTarget.startsWith(prefix)) return null;

    return realTarget;
}

// 扩展名 → Content-Type。主进程与渲染进程共用同一份,避免两边对同一个文件
// 给出不同的类型(自定义协议响应与 fetch 的判定必须一致)。
export const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    // 媒体类型:本地文件经 toolbox:// 播放时要靠这些类型,
    // 否则 <audio>/<video> 拿不到可解码的 Content-Type。
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
};

export function mimeFor(filePath) {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// 解析 HTTP Range 请求头。只支持单段 "bytes=a-b" 的三种写法。
//
// 返回 {status, start, end}:
//   'range'         可用区间
//   'unsatisfiable' 语法合法但区间落在文件之外 / 长度为 0 —— RFC 9110 要求回 416
//   'unsupported'   多段或语法不认 —— 一律回 200 整份(RFC 允许忽略 Range)
//
// 为什么要区分后两者:多段 Range 只是"没实现",不该冒充"你要的东西不存在";
// 一旦回 416,<audio>/<video> 会把它当成媒体不可用而直接失败。
//
// 为什么必须支持 Range:自定义协议要能承载本地媒体文件播放,
// 而媒体元素靠 Range 请求做跳转与流式读取;只会回整份内容时跳转会失效。
export function parseRange(header, size) {
    if (typeof header !== 'string' || !header.startsWith('bytes=')) {
        return { status: 'unsupported', start: 0, end: 0 };
    }

    const spec = header.slice('bytes='.length).trim();
    if (spec.includes(',')) return { status: 'unsupported', start: 0, end: 0 };

    const match = /^(\d*)-(\d*)$/.exec(spec);
    if (!match) return { status: 'unsupported', start: 0, end: 0 };

    const [, rawStart, rawEnd] = match;
    const unsat = () => ({ status: 'unsatisfiable', start: 0, end: 0 });

    // 空文件:任何区间都不可满足。
    if (size === 0) return unsat();

    // "bytes=-N":最后 N 字节
    if (rawStart === '') {
        if (rawEnd === '') return { status: 'unsupported', start: 0, end: 0 };
        const suffix = Number(rawEnd);
        if (suffix <= 0) return unsat();
        return { status: 'range', start: Math.max(0, size - suffix), end: size - 1 };
    }

    const start = Number(rawStart);

    // "bytes=N-":从 N 到结尾
    if (rawEnd === '') {
        if (start >= size) return unsat();
        return { status: 'range', start, end: size - 1 };
    }

    const end = Number(rawEnd);
    if (start > end || start >= size) return unsat();
    return { status: 'range', start, end: Math.min(end, size - 1) };
}
