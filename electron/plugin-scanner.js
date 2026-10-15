import fs from 'node:fs';
import path from 'node:path';
import { validateManifest } from '../app/lib/manifest-schema.js';

const SINGLE_FILE_RE = /\.tool\.js$/;

// 扫描根目录,产出归一化描述符列表(设计文档 §6.3)。
//
// 单文件形态的清单写在模块内部,主进程读不到(那是渲染进程的 ES 模块,
// 主进程 import 不了),所以这里只做发现,标上 needsRuntimeManifest,
// 等渲染进程 import 后把清单回传主进程校验。
// 这也正是"单文件形态不能声明服务"的原因 —— 见设计文档 §6.2。
export async function scanPlugins({ roots }) {
    const found = [];
    const seenIds = new Set();

    for (const root of roots) {
        let entries;
        try {
            entries = await fs.promises.readdir(root.dir, { withFileTypes: true });
        } catch {
            continue;               // 根目录不存在是正常情况(比如用户还没建过插件)
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const descriptor = await scanFolder(root, entry.name);
                if (descriptor) found.push(descriptor);
            } else if (entry.isFile() && SINGLE_FILE_RE.test(entry.name)) {
                found.push(scanSingleFile(root, entry.name));
            }
        }
    }

    // 去重:先出现的赢,后者标重复。排序稳定,所以"先出现"= 根目录在 roots 里更靠前。
    //
    // 注意只在 status 为 ok 的项之间做去重占位:清单非法的插件没有可信的 id
    // (这里的 id 只是目录名),让它占位会把另一个根里真正合法的同名插件误判成重复。
    return found.map((descriptor) => {
        if (descriptor.status === 'broken') return descriptor;
        if (seenIds.has(descriptor.id)) {
            return {
                ...descriptor,
                status: 'broken',
                error: {
                    stage: 'duplicate-id',
                    message: `插件 id "${descriptor.id}" 与之前扫描到的插件重复,已跳过`,
                },
            };
        }
        seenIds.add(descriptor.id);
        return descriptor;
    });
}

async function scanFolder(root, dirName) {
    const dir = path.join(root.dir, dirName);
    const manifestPath = path.join(dir, 'plugin.json');

    let raw;
    try {
        raw = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    } catch (error) {
        // 没有 plugin.json 的目录不是插件目录,静默跳过;
        // 但有文件却读不成 JSON 的,是坏插件,要报出来。
        if (error.code === 'ENOENT') return null;
        return brokenDescriptor({
            id: dirName,
            root: root.id,
            dir,
            entryUrl: `${root.urlBase}${dirName}/index.js`,
            stage: 'manifest',
            message: `plugin.json 无法解析: ${error.message}`,
        });
    }

    const sourceLabel = path.relative(root.dir, manifestPath);
    const { ok, errors, value } = validateManifest(raw, { sourceLabel });

    if (!ok) {
        return brokenDescriptor({
            id: dirName,
            root: root.id,
            dir,
            entryUrl: `${root.urlBase}${dirName}/index.js`,
            stage: 'manifest',
            message: errors.map(e => `${e.field}: ${e.message}`).join('; '),
        });
    }

    return {
        id: value.id,
        name: value.name,
        version: value.version,
        description: value.description,
        author: value.author,
        order: value.order,
        root: root.id,
        dir,
        entryUrl: `${root.urlBase}${value.id}/${value.entry}`,
        permissions: value.permissions,
        contributions: value.contributes,
        needsRuntimeManifest: false,
        status: 'ok',
        error: null,
    };
}

function scanSingleFile(root, fileName) {
    const id = fileName.replace(SINGLE_FILE_RE, '');
    return {
        id,
        name: id,
        version: '0.0.0',
        description: '',
        author: '',
        order: 1000,
        root: root.id,
        dir: root.dir,
        entryUrl: `${root.urlBase}${fileName}`,
        // 单文件形态的权限只能等渲染进程回传清单后才确定,这里刻意留空。
        permissions: [],
        contributions: { tools: [], services: [] },
        needsRuntimeManifest: true,
        status: 'ok',
        error: null,
    };
}

function brokenDescriptor({ id, root, dir, entryUrl, stage, message }) {
    return {
        id,
        name: id,
        version: '0.0.0',
        description: '',
        author: '',
        order: 1000,
        root,
        dir,
        entryUrl,
        permissions: [],
        contributions: { tools: [], services: [] },
        needsRuntimeManifest: false,
        status: 'broken',
        error: { stage, message },
    };
}
