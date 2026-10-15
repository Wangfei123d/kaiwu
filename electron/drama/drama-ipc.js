// 短剧引擎的主进程侧。
//
// ⚠️ 为什么引擎必须住在主进程:渲染进程是**完全沙箱**的
// (electron/main.js 的 createWindow:nodeIntegration:false + sandbox:true + contextIsolation:true),
// 插件拿不到 node:fs / node:path —— 而引擎要用 fs 读写 graph.json、用 child_process
// 跑 shell 节点与出图后端、用 crypto 算指纹。所以引擎只能在这里跑,
// 插件面板通过 IPC 递**叶子字段**(项目名 / 节点 id / 提示词),由这一侧解析路径。
//
// 与 service 方案的区别:不走 HTTP、不占端口、不做服务托管 —— 就是进程内的函数调用。
// 于是"端口被旧版本占用 / 服务没起来 / 假运行中"那一整类问题在这里根本不存在。
import fs from 'node:fs';
import path from 'node:path';
import {
    configure, rootDir, listProjects, readGraph, writeGraph, statePayload,
    runGraph, palette, projectDir, slug, migrateLegacyTextNodes, MAX_IMPORT_BYTES, MAX_SKILL_INPUT_BYTES,
} from './lib/core.js';
import { extractText, IMPORT_EXTENSIONS } from './lib/text.js';
import { importProjectImage } from './lib/skill-resources.js';
// 删除出口与笔记共用一份:"能进回收站就进,不能就落库内 .trash"这条规矩只该有一个实现
// (两处各写一遍,迟早有一处忘了跟进 —— 这次就是先只修了笔记那半边)。
import { removePathWithFallback } from '../notes/notes-ipc.js';
import { resolveDramaRoot, slugProjectName } from '../../app/lib/drama-root.js';

/** 频道名。preload 的白名单必须与它逐字一致(有单测钉这件事)。 */
export const DRAMA_INVOKE_CHANNELS = Object.freeze([
    'drama:root',
    'drama:projects',
    'drama:state',
    'drama:save',
    'drama:run',
    'drama:readOutput',
    'drama:image:status',
    'drama:image:key:set',
    'drama:image:key:clear',
    'drama:create',
    // 项目面板的两条:改名、删除。删除走**系统回收站**(可恢复),不是 fs.rm。
    'drama:rename',
    'drama:remove',
    // 「＋ 导入」:把一个文本文件抽成纯文本交给面板(**只读**,不往项目里拷任何东西)。
    // 从前的 drama:import 是"把文件拷进项目 inputs/ + 在节点上记一个路径",那条路
    // 连同 source / useSource 两个参数一起删了 —— 现在内容进节点,不再有第二处真相。
    'drama:readText',
    // 资源管理器拖到画布的 Word 文件:只递名字和字节,不让渲染进程声明任意磁盘路径。
    'drama:readDroppedText',
    'drama:media',
    'drama:importImage',
]);

/** 一次跑图最多等多久(引擎里那几条 NOT_WIRED 是立刻返回,但出图可能很慢)。 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 项目清单的**结构化**那一份:名字 + 节点数 + 出图张数 + 最近改动时间。
 * 项目面板一行要显示「12 节点 · 3 张图 · 2 天前」,靠的就是它。
 *
 * ⚠️ 老的 `projects:[名字]` 一并保留 —— 画布与既有用例一行都不用改,
 *    两份数据同一次调用给出,面板刷新一次就够。
 */
function projectItems() {
    return listProjects().map((name) => {
        const dir = projectDir(name);
        let shots = 0;
        try {
            shots = fs.readdirSync(path.join(dir, 'shots')).filter((f) => !f.startsWith('.')).length;
        } catch { /* 没有 shots/ 就是 0 张 */ }
        let mtime = 0;
        try { mtime = fs.statSync(dir).mtimeMs; } catch { /* 刚被删掉:当作未知 */ }
        const graph = readGraph(name);
        return {
            name,
            nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
            shots,
            mtime,
        };
    });
}

/**
 * 把一个项目名落到**真实存在的那个目录**上。
 *
 * 名字先过与 `drama:create` 同一把尺(slugProjectName),再要求 graph.json 在 ——
 * 于是"名字里带路径分隔符 / `..` / 指向库外"这一类输入根本走不到 fs 那一步。
 */
function existingProject(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') throw new Error('项目名不能为空');
    const name = slugProjectName(text);
    const dir = projectDir(name);
    if (!fs.existsSync(path.join(dir, 'graph.json'))) throw new Error(`项目「${text}」不存在`);
    return { name, dir };
}

/**
 * 洗一个**新的**项目名出来。
 *
 * ⚠️ 与 create 那条路唯一的差别:这里要挡住"输入整个是标点 / 路径分隔符"——
 *    slugProjectName 对那种输入会回 `default`,照它改名就等于**把名字非法悄悄变成
 *    改了另一个项目的名字**。宁可直接拒。
 */
function safeNewName(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') throw new Error('新名字不能为空');
    const safe = slugProjectName(text);
    if (safe === 'default' && text !== 'default') {
        throw new Error('这个名字里没有可用的字符(字母 / 数字 / 中文)');
    }
    return safe;
}

/**
 * 注册短剧频道。
 *
 * @param {object} p
 * @param {object} p.ipcMain
 * @param {() => string|null} p.getVaultPath 当前笔记库(取不到就 null)—— 复用 notes-ipc
 *        那一份真值,不信任渲染进程递进来的路径。
 * @param {string|null} [p.rootOverride] 固定根。**只给自检用**:它把项目放在临时库
 *        之外(免得 graph.json 与 inputs/*.txt 被笔记索引收进笔记清单)。生产环境不传。
 * @param {(msg:string)=>void} [p.log]
 * @param {object|null} [p.shell] Electron 的 shell(默认从它取 trashItem)
 * @param {(abs:string)=>Promise<void>|null} [p.trash] 可注入:生产默认取 shell.trashItem,
 *        纯 Node 的单测递假实现 —— "删一个项目会进回收站"这件事必须能被记账式地验到。
 */
export function registerDramaIpc({
    ipcMain, getVaultPath, rootOverride = null, shell = null, trash = null, log = console,
    generateText = null, imageSettings = null, generateImage = null, imageSignature = '',
}) {
    /**
     * 删项目用的那一下。与 notes-ipc 的 `notes:remove` 共用**同一个出口**:
     * 能进系统回收站就进,这个卷没有回收站(实测用户库所在的 E 盘是 FAT32 可移动盘)
     * 就搬进**库内** `.trash/<时间戳>/…` —— 两条路都可恢复,绝不永久删。
     *
     * ⚠️ 这里从前只写 `trashItem(found.dir)`:在那种卷上它会直接失败,于是"删项目"
     *    表现得和"点了没反应"一样(与笔记删除那次是同一个 bug,只是另一个入口)。
     */
    const trashItem = typeof trash === 'function'
        ? trash
        : (typeof shell?.trashItem === 'function' ? shell.trashItem.bind(shell) : null);

    // 引擎的根是模块级的,注册时按当时的笔记库定一次;换库之后由 refreshRoot() 重定。
    let configuredRoot = null;

    function refreshRoot() {
        // rootOverride:自检用。生产环境永远不传,一律走"当前笔记库"。
        if (typeof rootOverride === 'string' && rootOverride !== '') {
            configuredRoot = rootOverride;
            configure({ root: configuredRoot });
            return { root: configuredRoot, reason: '' };
        }
        const vault = typeof getVaultPath === 'function' ? getVaultPath() : null;
        const verdict = resolveDramaRoot(vault);
        if (verdict.root === null) {
            configuredRoot = null;
            return verdict;
        }
        configuredRoot = verdict.root;
        configure({ root: configuredRoot });
        return verdict;
    }

    /** 每个频道进来都重新定一次根:换库之后不必重启应用。 */
    function requireRoot() {
        const verdict = refreshRoot();
        if (verdict.root === null) throw new Error(verdict.reason);
        return verdict.root;
    }

    const handlers = {
        'drama:image:status': () => imageSettings?.status()
            ?? { ok: false, reason: '图片服务设置未接入' },
        'drama:image:key:set': (_event, { key } = {}) => imageSettings?.saveKey(key)
            ?? { ok: false, reason: '图片服务设置未接入' },
        'drama:image:key:clear': () => imageSettings?.clearKey()
            ?? { ok: false, reason: '图片服务设置未接入' },
        // 面板要显示"项目落在哪" —— 没配笔记库时说清原因,而不是给一个空串。
        'drama:root': async () => {
            const verdict = refreshRoot();
            return { root: verdict.root, reason: verdict.reason, dir: '短剧' };
        },

        'drama:projects': async () => {
            requireRoot();
            fs.mkdirSync(rootDir(), { recursive: true });
            return { projects: listProjects(), items: projectItems() };
        },

        // 一次给全:项目清单 + 当前项目的整张图 + 节点类型表 + 导入要用的常量。
        // 面板据此一次渲染完,不用来回问三趟。
        'drama:state': async (_event, { project } = {}) => {
            requireRoot();
            fs.mkdirSync(rootDir(), { recursive: true });
            // ⚠️ 载入前先把**老节点**搬一次:老节点把正文存在 inputs/xxx.txt 里、value 是空的,
            //    而那两个老字段已经被删了 —— 不搬就是"稿子静默变空"(幂等,搬完不写盘)。
            migrateLegacyTextNodes(project);
            const state = statePayload(project);
            return {
                ...state,
                types: palette(),
                // 导入要用的两样都从**引擎**给:能读哪些格式只有 text.js 知道,
                // 插件自己抄一份名单迟早漂移(对话框里会选不到其实支持的类型)。
                textImport: { extensions: IMPORT_EXTENSIONS, maxBytes: MAX_IMPORT_BYTES },
            };
        },

        'drama:save': async (_event, { project, graph } = {}) => {
            requireRoot();
            if (typeof project !== 'string' || project.trim() === '') throw new Error('project 必填');
            if (graph === null || typeof graph !== 'object') throw new Error('graph 必填');
            writeGraph(project, graph);
            return statePayload(project);
        },

        // 建项目:写一张空图。名字由这一侧洗成安全目录名 —— 渲染进程递不进路径。
        'drama:create': async (_event, { name } = {}) => {
            requireRoot();
            const safe = slugProjectName(name);
            const dir = projectDir(safe);
            if (fs.existsSync(path.join(dir, 'graph.json'))) {
                throw new Error(`项目「${safe}」已经存在`);
            }
            fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
            writeGraph(safe, { version: 1, id: slug(safe), title: safe, nodes: [], edges: [], runs: {} });
            return { project: safe, projects: listProjects(), items: projectItems() };
        },

        /**
         * 改项目名。**只是把目录改名**,图里的 `id` 不动 ——
         * id 是图内部的标识,runs 的键也挂在它上面,跟着名字变会让历史指纹对不上。
         * `title` 要跟着改:否则面板上叫 A、图里 title 还是 B,两边永远对不齐。
         */
        'drama:rename': async (_event, { from, to } = {}) => {
            requireRoot();
            const src = existingProject(from);
            const safe = safeNewName(to);
            // 改成同一个名字不算错(用户只是确认了一遍),也不该去动盘上任何东西。
            if (safe === src.name) {
                return { project: safe, projects: listProjects(), items: projectItems() };
            }
            const dst = projectDir(safe);
            if (fs.existsSync(dst)) throw new Error(`项目「${safe}」已经存在`);
            fs.renameSync(src.dir, dst);
            try {
                const graph = readGraph(safe);
                if (graph.title !== safe) writeGraph(safe, { ...graph, title: safe });
            } catch (err) {
                // 改完名同步 title 失败**不回滚**:目录已经改名成功了,回滚只会让
                // "名字改了、图里的 title 是旧的"变成"名字没改但用户以为改了"。
                // 这条只影响标题显示,记一笔日志让人能查到。
                log.warn?.('[drama] 改名之后同步 graph.title 失败', err);
            }
            return { project: safe, projects: listProjects(), items: projectItems() };
        },

        /**
         * 删一个项目(整个目录,连同 shots/ 与 inputs/)。
         * 走**回收站**,这个卷没有回收站时落**库内 .trash** —— 用户点错了能捞回来,
         * 这是与笔记删除同一条决策(实现也共用一份:removePathWithFallback)。
         */
        'drama:remove': async (_event, { project } = {}) => {
            requireRoot();
            const found = existingProject(project);
            const vault = getVaultPath();
            const rel = typeof vault === 'string' && vault !== ''
                ? path.relative(vault, found.dir).split(path.sep).join('/')
                : '';
            // 项目目录不在库内时(自检的 rootOverride 可能这样配)只走回收站那条 ——
            // 库内 .trash 是按**库内相对路径**摆放的,库外的东西塞进去会算错位置。
            const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
            if (!inside && trashItem === null) throw new Error('这个环境不支持移到回收站');
            try {
                await removePathWithFallback({
                    root: inside ? vault : found.dir,
                    abs: found.dir,
                    rel: inside ? rel : path.basename(found.dir),
                    trashItem,
                });
            } catch (err) {
                throw new Error(`删除项目失败:${err?.message ?? err}`);
            }
            return { project: found.name, projects: listProjects(), items: projectItems() };
        },

        // 跑图。默认**同步等结果**(面板点一下就该看到状态变化);
        // wait:false 时立刻回 202 那种"已开始",留给以后需要长轮询的场景。
        'drama:run': async (event, { project, target, force, wait = true, runId } = {}) => {
            requireRoot();
            if (typeof project !== 'string' || project.trim() === '') throw new Error('project 必填');
            const onNodeStatus = typeof runId === 'string' && runId.length > 0 && runId.length <= 100
                && typeof event?.sender?.send === 'function'
                ? (payload) => {
                    if (event.sender.isDestroyed?.()) return;
                    event.sender.send('drama:runEvent', { project, runId, ...payload });
                } : undefined;
            const task = runGraph(project, target, force === true,
                { generateText, generateImage, imageSignature, onNodeStatus,
                    onNodeInput: payload => onNodeStatus?.({ ...payload, status: 'inputReady' }),
                    onSkillMatch: payload => onNodeStatus?.({ ...payload, status: 'skillMatched' }) });
            if (wait === false) {
                void task.then((s) => log.info?.(`[drama] ${s}`)).catch(() => {});
                return { started: true };
            }
            const summary = await withTimeout(task, RUN_TIMEOUT_MS);
            return { summary, state: statePayload(project) };
        },

        'drama:readOutput': async (_event, { project, file } = {}) => {
            requireRoot();
            if (typeof project !== 'string' || project.trim() === '' || typeof file !== 'string'
                || !/^outputs\/[\w-]+\.txt$/.test(file)) {
                throw new Error('只能读取文本生成结果');
            }
            const graph = readGraph(project);
            if (!Object.values(graph.runs ?? {}).some((run) => run?.file === file || run?.skillInput?.file === file)) {
                throw new Error('只能读取文本生成结果');
            }
            const target = path.join(projectDir(project), file);
            const st = fs.statSync(target);
            const isSkillInput = Object.values(graph.runs ?? {}).some(run => run?.skillInput?.file === file);
            const limit = isSkillInput ? MAX_SKILL_INPUT_BYTES : 2 * 1024 * 1024;
            if (!st.isFile() || st.size > limit) throw new Error(`文本结果不可读取或超过 ${isSkillInput ? '16 MiB' : '2 MB'}`);
            return { text: fs.readFileSync(target, 'utf8'), file };
        },

        // 「＋ 导入」:把一个文件抽成纯文本交给面板,面板把它填进节点的「手输内容」。
        //
        // ⚠️ **只读**:不往项目里拷任何东西(从前的 drama:import 会拷进 inputs/ 并在节点上
        //    记 source/useSource —— 那套已删)。内容进了节点就是唯一真相,再留一份原件
        //    就是两处真相(用户定的口径:"移除导入文件")。
        // 上限在**读之前**按文件大小判:先读完再判,就是白白把 5 MB 读进内存。
        'drama:readText': async (_event, { path: srcPath, name } = {}) => {
            if (typeof srcPath !== 'string' || srcPath.trim() === '') throw new Error('需要 path');
            let st = null;
            try {
                st = fs.statSync(srcPath);
            } catch {
                throw new Error(`找不到文件:${srcPath}`);
            }
            if (!st.isFile()) throw new Error(`这不是一个文件:${srcPath}`);
            if (st.size > MAX_IMPORT_BYTES) {
                throw new Error(`这个文件 ${Math.round(st.size / 1024)} KB,超过 `
                    + `${Math.round(MAX_IMPORT_BYTES / 1024)} KB 的导入上限 —— 请先把不用的部分剪掉,`
                    + '或者只把需要的那一段存成一个小文件再导入。');
            }
            const buffer = fs.readFileSync(srcPath);
            const fileName = (typeof name === 'string' && name.trim() !== '') ? name.trim() : path.basename(srcPath);
            // extractText 认不出来会**明确拒绝**并给办法(.pdf / .doc / .xlsx…),不假装成功
            const { text: extracted, kind, note } = extractText(fileName, buffer);
            return { name: fileName, text: extracted, chars: extracted.length, kind, note };
        },

        // 系统文件拖放不能复用 drama:readText:那条是用户主动选文件后的路径入口。
        // 拖放这条只收 File.arrayBuffer() 的字节,这样渲染进程没有新增的任意路径读取能力。
        'drama:readDroppedText': async (_event, { name, bytes } = {}) => {
            const fileName = typeof name === 'string' ? name.trim() : '';
            if (fileName === '') throw new Error('需要文件名');
            if (path.extname(fileName).toLowerCase() !== '.docx') {
                throw new Error('只支持 Word(.docx)；旧版 .doc 请先在 Word / WPS 中另存为 .docx');
            }
            if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
                throw new Error('没有可读取的文件字节');
            }
            const buffer = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
            if (buffer.length === 0) throw new Error('文件为空，无法导入');
            if (buffer.length > MAX_IMPORT_BYTES) {
                throw new Error(`这个文件 ${Math.round(buffer.length / 1024)} KB,超过 `
                    + `${Math.round(MAX_IMPORT_BYTES / 1024)} KB 的导入上限 —— 请先把不用的部分剪掉,`
                    + '或者只把需要的那一段存成一个小文件再导入。');
            }
            const { text: extracted, kind, note } = extractText(fileName, buffer);
            return { name: fileName, text: extracted, chars: extracted.length, kind, note };
        },

        // 取一张出图。只允许项目自己的 shots/ 目录内 —— 这条与 v1 的 /api/media 同口径。
        'drama:importImage': async (_event, { project, file } = {}) => {
            requireRoot();
            if (typeof project !== 'string' || !project.trim()) throw new Error('请先选择项目');
            return importProjectImage(projectDir(project), file);
        },
        'drama:media': async (_event, { project, file } = {}) => {
            requireRoot();
            if (typeof project !== 'string' || typeof file !== 'string' || file === '') {
                throw new Error('project 与 file 必填');
            }
            const shots = path.join(projectDir(project), 'shots');
            const target = path.resolve(shots, file);
            if (!target.startsWith(path.resolve(shots) + path.sep)) {
                throw new Error('只能在项目目录内取图');
            }
            if (!fs.existsSync(target)) throw new Error('没有这张图');
            const ext = path.extname(target).slice(1).toLowerCase();
            const mime = {
                png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                webp: 'image/webp', gif: 'image/gif',
            }[ext] ?? 'application/octet-stream';
            // 递**字节**而不是路径:渲染进程拿不到 fs,只能经这条通道把图读进去。
            const bytes = fs.readFileSync(target);
            return { mime, base64: bytes.toString('base64') };
        },
    };

    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, payload) => {
            try {
                return await handler(event, payload);
            } catch (err) {
                // 与 notes-ipc 同一口径:渲染进程拿到的是可读 message,而不是
                // 一个被 Electron 包装过的难懂对象。code 保留(ENOENT/EACCES 处境不同)。
                const wrapped = new Error(String(err?.message ?? err));
                if (err?.code !== undefined) wrapped.code = err.code;
                throw wrapped;
            }
        });
    }

    return {
        /** 面板启动时问一次"根在哪"(没配库时 reason 要说清)。 */
        currentRoot: () => refreshRoot(),
        dispose: () => {
            for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
        },
    };
}

/** 给跑图加一个上限:引擎自己不管超时,而面板不该无限等下去。 */
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`跑图超过 ${Math.round(ms / 1000)} 秒仍未结束`)), ms);
        Promise.resolve(promise).then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}
