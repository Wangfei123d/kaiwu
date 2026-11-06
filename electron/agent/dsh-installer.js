// DeepSeek Harness 的按需准备器。仅在用户目录安装与开物 ACP 桥接兼容的固定版本。
import path from 'node:path';
import { mkdir, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveDshEntry, resolveNodeExecutable } from '../../app/lib/agent-command.js';
import { applyDshAcpPatch } from '../../tools/patch-dsh-acp-streaming.mjs';

const mkdirAsync = promisify(mkdir);
const KAIWU_DSH_VERSION = '0.1.5-rc.2';
const DEPENDENCY_REVISION = 5;
const MANAGED_RUNTIME_NAME = 'kaiwu-deepseek-harness-runtime';

// 0.1.5-rc.2 的发布包有几处未声明运行依赖，且 npm 会把部分内部包浮动到
// rc.3，造成 peer 冲突。将运行时依赖扁平固定，并使用 npm 的 legacy peer
// 解析；只作用于这个隔离的用户目录，不改变系统 Node/npm 或项目依赖。
const DEPENDENCIES = Object.freeze({
    '@deepseek-ai/dsh': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-acp': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-acp-app': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-app-boot': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-cmdline': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-home-paths': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-web-app': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-anonymous-user-id': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-attachment': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-bash-local': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-code-runtime': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-compaction': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-fs': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-jobs': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-output-retention': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-sandbox': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-session-persistence': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-session-query': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-session-telemetry': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-session-title-llm': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-settings': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-shell': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-spill': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-subagent-in-process-driver': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-util-time': KAIWU_DSH_VERSION,
    // Workflow 模块单独使用 0.0.1 版本线；rc2 的引擎依赖这个 peer 包。
    '@deepseek-ai/dsh-workflow-worker-thread': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-tool-workflow': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-tool-ralph': KAIWU_DSH_VERSION,
    '@deepseek-ai/dsh-workflow': KAIWU_DSH_VERSION,
    '@deepseek-ai/cordis': '4.0.2',
    '@deepseek-ai/cordis-plugin-loader': '1.0.3',
    '@deepseek-ai/cordis-plugin-include': '1.0.7',
    '@deepseek-ai/cordis-plugin-timer': '1.1.4',
    '@deepseek-ai/cordis-plugin-group': '1.0.2',
    '@deepseek-ai/cordis-plugin-hmr': '1.0.17',
});

function envValue(env, name) {
    if (env === null || typeof env !== 'object') return undefined;
    const direct = env[name];
    if (typeof direct === 'string') return direct;
    const lower = name.toLowerCase();
    for (const key of Object.keys(env)) {
        if (key.toLowerCase() === lower && typeof env[key] === 'string') return env[key];
    }
    return undefined;
}

function setEnvValue(env, name, value) {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? name;
    env[key] = value;
}

function globalDshCandidates(env) {
    const appData = envValue(env, 'APPDATA');
    const roots = [
        envValue(env, 'npm_config_prefix'),
        appData ? path.join(appData, 'npm') : '',
    ].filter((root, index, all) => root && all.indexOf(root) === index);
    return roots.map((root) => path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
}

function installedEntry({ env, appRoot, exists }) {
    const known = resolveDshEntry({ env, exists, appRoot });
    if (known !== null) return known;
    for (const candidate of globalDshCandidates(env)) {
        try { if (exists(candidate)) return candidate; } catch { /* 探测失败当作不存在 */ }
    }
    return null;
}

function findNpmCli({ env, nodePath, appRoot, exists }) {
    const configured = envValue(env, 'KAIWU_NPM_CLI');
    const nodeDir = path.dirname(nodePath);
    const nodeModuleDir = path.dirname(nodeDir);
    const candidates = [
        configured,
        path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeModuleDir, 'npm', 'bin', 'npm-cli.js'),
        appRoot ? path.join(appRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js') : '',
    ].filter(Boolean);

    const pathValue = envValue(env, 'PATH') ?? '';
    for (const rawDir of pathValue.split(path.delimiter)) {
        const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
        if (dir) candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    for (const candidate of candidates) {
        try { if (exists(candidate)) return candidate; } catch { /* 探测失败当作不存在 */ }
    }
    return null;
}

function runProcess(command, args, { cwd, env, spawn = nodeSpawn, signal, timeoutMs = 10 * 60 * 1000 } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(Object.assign(new Error('Harness 安装已取消'), { name: 'AbortError' }));
            return;
        }
        let child;
        try {
            child = spawn(command, args, {
                cwd,
                env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            reject(error);
            return;
        }

        let output = '';
        let settled = false;
        const keepTail = (chunk) => { output = (output + String(chunk)).slice(-12000); };
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => child.kill();
        const timer = setTimeout(() => {
            child.kill();
            finish(reject, Object.assign(new Error('DeepSeek Harness 安装超时'), { output }));
        }, timeoutMs);

        child.stdout?.on('data', keepTail);
        child.stderr?.on('data', keepTail);
        child.once('error', (error) => finish(reject, error));
        child.once('exit', (code, exitSignal) => {
            if (signal?.aborted) {
                finish(reject, Object.assign(new Error('Harness 安装已取消'), { name: 'AbortError' }));
                return;
            }
            if (code === 0) finish(resolve, output.trim());
            else finish(reject, Object.assign(
                new Error(`npm install 退出(${code ?? exitSignal ?? '未知'})`), { output },
            ));
        });
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function conciseInstallError(error) {
    const detail = `${error?.message ?? ''}\n${error?.output ?? ''}`;
    if (/ERESOLVE|peer dep/i.test(detail)) return '安装依赖版本冲突。请查看开物日志中的详细原因后重试。';
    if (/ETARGET|No matching version/i.test(detail)) return '兼容版本暂不可从软件源获取，请检查网络或软件源配置。';
    if (/ECONN|EACCES|ENOTFOUND|ETIMEDOUT|proxy|network/i.test(detail)) return '无法连接 npm 软件源，请检查网络或代理后重试。';
    if (/超时/.test(detail)) return '下载 DeepSeek Harness 超时，请检查网络后重试。';
    return 'DeepSeek Harness 安装失败。请查看开物日志中的详细原因后重试。';
}

function readReadyMarker(markerPath, entry, exists) {
    try {
        if (!exists(markerPath) || !exists(entry)) return false;
        const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
        if (marker.version !== KAIWU_DSH_VERSION
            || marker.dependencyRevision !== DEPENDENCY_REVISION
            || marker.entry !== entry) return false;
        return applyDshAcpPatch({
            target: path.resolve(path.dirname(entry), '..', '..', 'dsh-acp', 'lib', 'index.js'),
            mode: 'check',
        }).ok;
    } catch {
        return false;
    }
}

function readManagedMarker(markerPath, exists) {
    try {
        if (!exists(markerPath)) return null;
        return JSON.parse(readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * 找到可用 Harness,或在用户目录安装开物兼容版本并应用 ACP 补丁。
 * @param {{env?:object, appRoot?:string, appData?:string, exists?:(path:string)=>boolean,
 *   spawn?:Function, signal?:AbortSignal, onProgress?:(message:string)=>void,
 *   log?:{warn?:(...args:any[])=>void,error?:(...args:any[])=>void}} options
 * @returns {Promise<{entry:string, installed:boolean}>}
 */
export async function ensureDeepseekHarness({
    env = process.env,
    appRoot = '',
    appData = envValue(env, 'APPDATA') ?? '',
    exists = existsSync,
    spawn = nodeSpawn,
    signal,
    onProgress = () => {},
    log = console,
} = {}) {
    if (typeof appData !== 'string' || appData.trim() === '') {
        throw new Error('无法确定用户数据目录，不能安全安装 DeepSeek Harness。');
    }

    const runtimeRoot = path.join(path.resolve(appData), 'kaiwu', 'harness-runtime');
    const managedEntry = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const markerPath = path.join(runtimeRoot, '.kaiwu-ready.json');
    if (readReadyMarker(markerPath, managedEntry, exists)) {
        return { entry: managedEntry, installed: false };
    }

    // 兼容已安装的开物托管版本：补丁修订升级时只更新 ACP 桥，不重新下载整套 Harness。
    // 该分支要求原 ready marker 明确对应同一版本和入口，避免误改用户自行安装的依赖。
    const previousMarker = readManagedMarker(markerPath, exists);
    if (exists(managedEntry)
        && previousMarker?.version === KAIWU_DSH_VERSION
        && path.resolve(previousMarker.entry ?? '') === path.resolve(managedEntry)) {
        const patchTarget = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-acp', 'lib', 'index.js');
        const patched = applyDshAcpPatch({ target: patchTarget });
        if (!patched.ok) {
            log.error?.('[agent] DeepSeek Harness ACP 修复失败', patched.output);
            throw new Error('已安装的 DeepSeek Harness 无法完成兼容修复。请查看开物日志后重试。');
        }
        writeFileSync(markerPath, JSON.stringify({
            version: KAIWU_DSH_VERSION,
            dependencyRevision: DEPENDENCY_REVISION,
            entry: managedEntry,
        }, null, 2) + '\n', 'utf8');
        onProgress('DeepSeek Harness 已更新。');
        return { entry: managedEntry, installed: false };
    }

    const already = installedEntry({ env, appRoot, exists });
    if (already !== null) return { entry: already, installed: false };
    if (signal?.aborted) throw Object.assign(new Error('Harness 安装已取消'), { name: 'AbortError' });

    const nodePath = resolveNodeExecutable({ env, exists, appRoot });
    if (nodePath === null) {
        throw new Error('没有找到 Node.js，无法安装 DeepSeek Harness。请安装 Node.js 24 或在设置中指定 KAIWU_NODE。');
    }
    const npmCli = findNpmCli({ env, nodePath, appRoot, exists });
    if (npmCli === null) {
        throw new Error('没有找到 npm 安装器，无法自动安装 DeepSeek Harness。请确认 Node.js 安装包含 npm。');
    }

    await mkdirAsync(runtimeRoot, { recursive: true });
    const manifestPath = path.join(runtimeRoot, 'package.json');
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.name !== MANAGED_RUNTIME_NAME) {
            throw new Error('安装目录中存在非开物管理的 package.json，已停止以保护现有文件。');
        }
    } catch (error) {
        if (error?.message?.startsWith('安装目录中存在')) throw error;
    }
    const manifest = { name: MANAGED_RUNTIME_NAME, private: true, version: '1.0.0', dependencies: DEPENDENCIES };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    onProgress('正在安装 DeepSeek Harness…');
    const childEnv = { ...env };
    const currentPath = envValue(childEnv, 'PATH') ?? '';
    setEnvValue(childEnv, 'PATH', [path.dirname(nodePath), currentPath].filter(Boolean).join(path.delimiter));
    setEnvValue(childEnv, 'npm_config_cache', path.join(runtimeRoot, '.npm-cache'));
    setEnvValue(childEnv, 'npm_config_audit', 'false');
    setEnvValue(childEnv, 'npm_config_fund', 'false');
    try {
        await runProcess(nodePath, [
            npmCli,
            'install',
            '--prefix', runtimeRoot,
            '--no-audit',
            '--no-fund',
            '--legacy-peer-deps',
            '--install-strategy=hoisted',
        ], { cwd: runtimeRoot, env: childEnv, spawn, signal });
    } catch (error) {
        log.error?.('[agent] DeepSeek Harness 安装失败', error?.message, error?.output ?? '');
        if (error?.name === 'AbortError') throw error;
        throw new Error(conciseInstallError(error));
    }

    const entry = managedEntry;
    if (!exists(entry)) throw new Error('DeepSeek Harness 安装未完成：没有找到启动入口。请查看开物日志。');
    const patchTarget = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-acp', 'lib', 'index.js');
    onProgress('正在配置开物 Agent 接口…');
    const patched = applyDshAcpPatch({ target: patchTarget });
    if (!patched.ok) {
        log.error?.('[agent] DeepSeek Harness ACP 配置失败', patched.output);
        throw new Error('DeepSeek Harness 已下载，但开物接口配置失败。请查看开物日志后重试。');
    }

    writeFileSync(markerPath, JSON.stringify({
        version: KAIWU_DSH_VERSION,
        dependencyRevision: DEPENDENCY_REVISION,
        entry,
    }, null, 2) + '\n', 'utf8');
    onProgress('DeepSeek Harness 已就绪。');
    return { entry, installed: true };
}
