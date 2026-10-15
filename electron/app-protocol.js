// toolbox:// 的 Electron 接线层:注册协议特权 + 把处理器挂到 protocol.handle。
// 请求处理逻辑本身在 app/lib/app-protocol-core.js(纯实现,可单测),
// 这里只做必须依赖 electron 模块的那一步。
import { protocol } from 'electron';
import { createRequestHandler } from '../app/lib/app-protocol-core.js';

export const PROTOCOL = 'toolbox';

// MIME 表与判定函数在 app/lib/path-guard.js,主/渲染共用同一份。重新导出,
// 保持既有引用不受影响。
export { MIME_TYPES, mimeFor } from '../app/lib/path-guard.js';
export { createRequestHandler } from '../app/lib/app-protocol-core.js';

// 必须在 app ready 之前调用
export function registerScheme() {
    protocol.registerSchemesAsPrivileged([{
        scheme: PROTOCOL,
        privileges: {
            standard: true,      // 有正常的 URL 语义(host/path),ES Module 才能相对解析
            secure: true,        // 视为安全上下文,navigator.clipboard 等才可用
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true,
        },
    }]);
}

// 在 app ready 之后调用。roots: { shell: 绝对路径, plugin: …, user: … }
export function registerAppProtocol(roots, deps = {}) {
    protocol.handle(PROTOCOL, createRequestHandler(roots, deps));
}
