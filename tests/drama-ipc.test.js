import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerDramaIpc, DRAMA_INVOKE_CHANNELS } from '../electron/drama/drama-ipc.js';

// 短剧引擎主进程侧的用例。与 notes-ipc.test.js 同一个写法:用替身注册 IPC,
// 再把频道当普通函数调 —— 不必起 Electron。
//
// 这一组盯的是**项目面板要用的那三条**:
//   · drama:projects 给的结构化清单(节点数 / 张数 / 时间)对不对;
//   · drama:rename 是不是"只改名字" —— 目录改了、title 跟上了、图内部的 id 没动;
//   · drama:remove 走的是**回收站**而不是 fs.rm,而且路径逃逸根本走不到 fs 那一步。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, '..', 'electron', 'preload.cjs');

test('技能匹配经当前文本模型运行并发送实时结果，实际输入可通过受限频道读取', async () => {
    const events = [];
    const { handlers, call, root } = harness({
        generateText: async () => JSON.stringify({ selected: [{ id: 'skill', reason: '人物一致', evidence: '同一个人' }] }),
        generateImage: async () => ({ files: [], detail: 'ok' }),
    });
    const project = '技能测试';
    putProject(root, project, { nodes: 0, shots: 0 });
    await call('drama:save', { project, graph: { nodes: [
        { id: 'skill', type: 'skill', params: { purpose: '人物一致性', value: '角色衣着设定' } },
        { id: 'out', type: 'image', params: { prompt: '保持同一个人' } },
    ], edges: [{ from: 'skill', to: 'out', toPort: 1 }], runs: {} } });
    const result = await handlers.get('drama:run')({ sender: { send: (_channel, payload) => events.push(payload) } },
        { project, target: 'out', runId: 'test' });
    assert.ok(events.find(event => event.status === 'skillMatched')?.skillMatch.selected.length === 1);
    const ready = events.find(event => event.status === 'inputReady');
    assert.equal(ready?.project, project);
    assert.equal(ready?.runId, 'test');
    assert.equal(ready?.run.status, 'running');
    const input = result.state.graph.runs.out.skillInput;
    assert.match((await call('drama:readOutput', { project, file: input.file })).text, /角色衣着设定/);
});

test('超过 2 MiB 的已登记技能实际输入可在提交时完整读取', async () => {
    let call;
    let observed;
    const body = 'x'.repeat(2 * 1024 * 1024 + 100);
    const h = harness({
        generateText: async () => JSON.stringify({ selected: [{ id: 'skill', reason: 'r', evidence: '人物' }] }),
        generateImage: async args => {
            const state = await call('drama:state', { project: '大输入' });
            observed = await call('drama:readOutput', { project: '大输入', file: state.graph.runs.out.skillInput.file });
            assert.equal(observed.text, args.prompt);
            return { files: [], detail: 'ok' };
        },
    });
    call = h.call;
    putProject(h.root, '大输入', { nodes: 0, shots: 0 });
    await call('drama:save', { project: '大输入', graph: { nodes: [
        { id: 'source', type: 'text', params: { value: body } },
        { id: 'skill', type: 'skill', params: { purpose: '人物', value: '' } },
        { id: 'out', type: 'image', params: { prompt: '人物' } },
    ], edges: [{ from: 'source', to: 'skill', toPort: 0 }, { from: 'skill', to: 'out', toPort: 1 }], runs: {} } });
    const result = await call('drama:run', { project: '大输入', target: 'out' });
    assert.doesNotMatch(result.summary, /失败/);
    assert.ok(observed.text.includes(body));
});

test('图片输入导入真实字节到项目且不可导入伪装图片', async () => {
    const { call, root } = harness();
    const source = path.join(root, 'source.png');
    const png = Buffer.from('89504e470d0a1a0a0001', 'hex');
    fs.writeFileSync(source, png);
    const result = await call('drama:importImage', { project: '图片技能', file: source });
    assert.deepEqual(fs.readFileSync(path.join(root, '图片技能', 'shots', result.file)), png);
    fs.writeFileSync(source, 'not an image');
    await assert.rejects(call('drama:importImage', { project: '图片技能', file: source }), /图片|图像/);
});

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-drama-'));
}

/**
 * 替身注册。`trash` 默认是"记账 + 真删"——真删是为了让"删完之后清单里没有它"
 * 这条断言成立;生产环境那一下是 Electron 的 shell.trashItem(进回收站)。
 *
 * ⚠️ `trash` 的三态要分清:**不传**(用默认那套)、`null`(这个环境没有回收站能力)、
 *    函数(注入)。默认值写成 `trash = null` 会把"没有能力"那一种吃掉 —— 实测踩到过。
 */
function harness({ root = tmpRoot(), trash = undefined, shell = null, vault = 'C:\\vault', generateText = null,
    imageSettings = null, generateImage = null, imageSignature = '' } = {}) {
    const handlers = new Map();
    const ipcMain = {
        handle: (channel, fn) => handlers.set(channel, fn),
        removeHandler: (channel) => handlers.delete(channel),
    };
    const trashed = [];
    const useTrash = trash !== undefined ? trash : ((abs) => {
        trashed.push(abs);
        fs.rmSync(abs, { recursive: true, force: true });
    });
    registerDramaIpc({
        ipcMain,
        getVaultPath: () => vault,
        rootOverride: root,
        shell,
        trash: useTrash,
        generateText,
        imageSettings,
        generateImage,
        imageSignature,
        log: { warn() {}, info() {}, error() {} },
    });
    const call = (channel, payload) => handlers.get(channel)(null, payload);
    return { handlers, call, root, trashed, vault };
}

test('画面生成统一模型：旧节点 model 保留但不覆盖，配置变化才使缓存失效', async () => {
    const root = tmpRoot();
    const project = '统一图片';
    const dir = putProject(root, project, { nodes: 0, shots: 0 });
    const graph = graphOf(root, project);
    graph.nodes = [{ id: 'picture', type: 'image', title: '画面生成',
        params: { prompt: '竖屏分镜', batch: 1, model: 'old-checkpoint' } }];
    graph.runs = {};
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph), 'utf8');
    const calls = [];
    const generateImage = async (options) => {
        calls.push(options);
        return { files: [path.join(dir, 'shots', 'shot.png')], detail: '测试图片' };
    };
    const first = harness({ root, generateImage, imageSignature: 'image-config-a' });
    const type = (await first.call('drama:state', { project })).types.find((entry) => entry.id === 'image');
    assert.deepEqual(type.params.map((param) => param.key), ['prompt', 'batch']);
    assert.match((await first.call('drama:run', { project, target: 'picture' })).summary, /实跑 1/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].checkpoint, undefined);
    assert.equal(graphOf(root, project).nodes[0].params.model, 'old-checkpoint');

    const changed = graphOf(root, project);
    changed.nodes[0].params.model = 'another-old-checkpoint';
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(changed), 'utf8');
    assert.match((await first.call('drama:run', { project, target: 'picture' })).summary, /缓存命中 1/);
    assert.equal(calls.length, 1);

    const next = harness({ root, generateImage, imageSignature: 'image-config-b' });
    assert.match((await next.call('drama:run', { project, target: 'picture' })).summary, /实跑 1/);
    assert.equal(calls.length, 2);
});

test('图片密钥 IPC 仅返回无密钥状态，且三个频道进入白名单', async () => {
    const secret = 'sk-test-not-a-real-key-1234567890';
    let saved = '';
    const imageSettings = {
        status: () => ({ ok: saved !== '', model: 'gpt-image-2.5' }),
        saveKey: (value) => { saved = value; return { ok: true }; },
        clearKey: () => { saved = ''; return { ok: true }; },
    };
    const { call } = harness({ imageSettings });
    for (const channel of ['drama:image:status', 'drama:image:key:set', 'drama:image:key:clear']) {
        assert.ok(DRAMA_INVOKE_CHANNELS.includes(channel));
    }
    assert.equal((await call('drama:image:key:set', { key: secret })).ok, true);
    const status = await call('drama:image:status');
    assert.equal(status.ok, true);
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal((await call('drama:image:key:clear')).ok, true);
});

test('汇聚画面节点合并所有来源和节点提示词，任一来源变化或断开会失效缓存', async () => {
    const calls = [];
    const { call, root } = harness({ generateImage: async options => {
        calls.push(options);
        return { files: ['frame.png'], detail: '测试图片' };
    } });
    const project = '汇聚画面';
    putProject(root, project, { nodes: 0, shots: 0 });
    const graph = graphOf(root, project);
    graph.nodes = [
        { id: 'script', type: 'text', title: '剧本', params: { value: '雨夜便利店' } },
        { id: 'person', type: 'text', title: '人物', params: { value: '蓝白制服' } },
        { id: 'style', type: 'text', title: '风格', params: { value: '冷色电影光' } },
        { id: 'picture', type: 'image', params: { prompt: '生成镜头首帧', batch: 2 } },
    ];
    graph.edges = [
        { from: 'script', to: 'picture' },
        { from: 'person', fromPort: 0, to: 'picture', toPort: 0 },
        { from: 'style', to: 'picture' },
    ];
    await call('drama:save', { project, graph });
    const first = await call('drama:run', { project, target: 'picture' });
    assert.equal(first.state.graph.runs.picture.status, 'ok');
    assert.equal(calls[0].prompt, '【节点提示词】\n生成镜头首帧\n\n【剧本】\n雨夜便利店\n\n【人物】\n蓝白制服\n\n【风格】\n冷色电影光');
    assert.equal(calls[0].batch, 2);
    assert.deepEqual(first.state.types.find(entry => entry.id === 'image').multipleInputs, [0, 1]);
    const second = await call('drama:run', { project, target: 'picture' });
    assert.equal(second.state.graph.runs.picture.status, 'cached');
    assert.equal(calls.length, 1);
    const changed = second.state.graph;
    changed.nodes[2].params.value = '暖色电影光';
    await call('drama:save', { project, graph: changed });
    const third = await call('drama:run', { project, target: 'picture' });
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /暖色电影光/);
    changed.edges = changed.edges.filter(edge => edge.from !== 'person');
    await call('drama:save', { project, graph: changed });
    await call('drama:run', { project, target: 'picture' });
    assert.equal(calls.length, 3);
    assert.doesNotMatch(calls[2].prompt, /蓝白制服/);
    assert.equal(third.state.graph.runs.picture.status, 'ok');
});

test('汇聚画面使用缓存的文本生成全文，单来源保持原提示词', async () => {
    const longText = '人物设定'.repeat(6000);
    const calls = [];
    const { call, root } = harness({ generateText: async () => longText,
        generateImage: async options => { calls.push(options.prompt); return { files: ['frame.png'], detail: '图片' }; } });
    const project = '汇聚全文';
    putProject(root, project, { nodes: 0, shots: 0 });
    const graph = graphOf(root, project);
    graph.nodes = [
        { id: 'writer', type: 'llm', title: '人物设定', params: { prompt: '人物设定' } },
        { id: 'picture', type: 'image', params: { prompt: '' } },
    ];
    graph.edges = [{ from: 'writer', to: 'picture' }];
    await call('drama:save', { project, graph });
    const first = await call('drama:run', { project, target: 'picture' });
    assert.equal(calls[0], longText);
    const changed = first.state.graph;
    changed.nodes[1].params.prompt = '使用所有人物设定';
    await call('drama:save', { project, graph: changed });
    const second = await call('drama:run', { project, target: 'picture' });
    assert.equal(second.state.graph.runs.writer.status, 'cached');
    assert.equal(calls[1], `【节点提示词】\n使用所有人物设定\n\n【人物设定】\n${longText}`);
});

/** 在根下造一个项目:graph.json + shots/ 两张图。 */
function putProject(root, name, { nodes = 1, shots = 2, title = null } = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
    for (let i = 0; i < shots; i += 1) {
        fs.writeFileSync(path.join(dir, 'shots', `s${i}.png`), 'x');
    }
    const graph = {
        version: 1,
        id: name,
        title: title ?? name,
        nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}`, type: 'text', title: `节点${i}` })),
        edges: [],
        runs: { n0: { status: 'ok', hash: 'h' } },
    };
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');
    return dir;
}

const graphOf = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name, 'graph.json'), 'utf8'));

/** 只含 word/document.xml 的最小未压缩 zip，足够驱动真实 docx 解析器。 */
function minimalDocx(text) {
    const name = Buffer.from('word/document.xml', 'utf8');
    const data = Buffer.from(`<w:document><w:body><w:p><w:t>${text}</w:t></w:p></w:body></w:document>`, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt32LE(data.length, 18);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(data.length, 20);
    const centralOffset = local.length + name.length + data.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(centralOffset, 16);
    return Buffer.concat([local, name, data, central, name, end]);
}

test('drama:projects 一次给两份:老的名字数组 + 新的结构化 items', async () => {
    const { call, root } = harness();
    putProject(root, '被除名的养女', { nodes: 3, shots: 2 });
    putProject(root, '替嫁新娘', { nodes: 5, shots: 0 });

    const r = await call('drama:projects', {});
    assert.deepEqual(r.projects.slice().sort(), ['替嫁新娘', '被除名的养女'],
        '老字段必须是**纯名字数组**:画布那条路与既有用例都还用它');
    const byName = Object.fromEntries(r.items.map((it) => [it.name, it]));
    assert.equal(byName['被除名的养女'].nodes, 3, '节点数取自 graph.json');
    assert.equal(byName['被除名的养女'].shots, 2, '张数取自 shots/');
    assert.equal(byName['替嫁新娘'].shots, 0, '没有图就是 0 张(不是 undefined)');
    assert.ok(byName['被除名的养女'].mtime > 0, '最近改动时间要给出来(面板显示"2 天前"要用)');
});

test('drama:create 建完就出现在 items 里(空图 0 节点 0 张)', async () => {
    const { call } = harness();
    const r = await call('drama:create', { name: '盲山' });
    assert.equal(r.project, '盲山');
    assert.deepEqual(r.projects, ['盲山']);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].nodes, 0);
    assert.equal(r.items[0].shots, 0);
});

test('drama:rename 只改名字:目录改了、title 跟上、图内部的 id 不动', async () => {
    const { call, root } = harness();
    putProject(root, '旧名', { nodes: 2, shots: 1 });

    const r = await call('drama:rename', { from: '旧名', to: '新名' });
    assert.equal(r.project, '新名');
    assert.equal(fs.existsSync(path.join(root, '旧名')), false, '旧目录必须没了');
    assert.equal(fs.existsSync(path.join(root, '新名', 'graph.json')), true, '新目录里要有图');
    assert.equal(fs.existsSync(path.join(root, '新名', 'shots', 's0.png')), true, 'shots/ 一起搬过去');

    const after = graphOf(root, '新名');
    assert.equal(after.title, '新名', 'title 要跟着改名 —— 否则面板叫 A、图里 title 是 B');
    assert.equal(after.id, '旧名', 'id 是图内部标识(runs 的指纹挂在它上面),**不许**跟着改');
    assert.deepEqual(after.runs, { n0: { status: 'ok', hash: 'h' } }, '跑过的东西不许因为改名丢掉');

    const list = await call('drama:projects', {});
    assert.deepEqual(list.projects, ['新名']);
    assert.equal(list.items[0].name, '新名');
    assert.equal(list.items[0].nodes, 2, '改名之后统计照旧');
});

test('drama:rename 改成同一个名字不算错,而且盘上什么都不动', async () => {
    const { call, root } = harness();
    putProject(root, '原名');
    const before = fs.statSync(path.join(root, '原名')).mtimeMs;
    const r = await call('drama:rename', { from: '原名', to: '原名' });
    assert.equal(r.project, '原名');
    assert.equal(fs.statSync(path.join(root, '原名')).mtimeMs, before, '同一名字不该去动目录');
});

test('drama:rename 的拒绝路径:目标已存在 / 空名字 / 全是标点 / 源不存在', async () => {
    const { call, root } = harness();
    putProject(root, '甲');
    putProject(root, '乙');

    await assert.rejects(() => call('drama:rename', { from: '甲', to: '乙' }), /已经存在/);
    await assert.rejects(() => call('drama:rename', { from: '甲', to: '   ' }), /不能为空/);
    // ⚠️ 这条最要紧:slugProjectName 对"整个是标点"会回 `default`,照它改名就等于
    //    把"名字非法"悄悄变成"改了另一个项目的名字"。必须拒。
    await assert.rejects(() => call('drama:rename', { from: '甲', to: '///' }), /没有可用的字符/);
    await assert.rejects(() => call('drama:rename', { from: '不存在', to: '丙' }), /不存在/);

    assert.equal(fs.existsSync(path.join(root, '甲')), true, '被拒的这几次都不许动到盘上');
    assert.equal(fs.existsSync(path.join(root, '乙')), true);
});

test('drama:remove 走的是回收站(不是 fs.rm),删完清单里就没它了', async () => {
    const trashed = [];
    const { call, root } = harness({
        trash: (abs) => { trashed.push(abs); fs.rmSync(abs, { recursive: true, force: true }); },
    });
    const dir = putProject(root, '要删的');
    const r = await call('drama:remove', { project: '要删的' });
    assert.deepEqual(trashed, [dir], '交给回收站的一定是**那个项目的目录**');
    assert.equal(r.project, '要删的');
    assert.deepEqual(r.projects, []);
    assert.equal(fs.existsSync(dir), false);
});

test('★ drama:remove:回收站不可用(如 FAT32 可移动盘)时整个项目搬进库内 .trash', async () => {
    // 2026-09-29:用户库在 E 盘(FAT32 可移动、没有回收站),`shell.trashItem` 在那个卷上
    // 直接失败 —— 从前这条通道只写 trashItem,于是"删项目"也表现得像点了没反应。
    // 这里把项目放在**库内**的 短剧/ 下(与生产一致),验它整棵树落进库内 .trash。
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-drama-vault-'));
    const root = path.join(vault, '短剧');
    try {
        putProject(root, '要删的');
        const { call } = harness({
            root,
            vault,
            trash: async () => { throw new Error('Failed to perform delete operation'); },
        });

        await call('drama:remove', { project: '要删的' });

        assert.equal(fs.existsSync(path.join(root, '要删的')), false, '原项目目录必须没了');
        const stamps = fs.readdirSync(path.join(vault, '.trash'));
        assert.equal(stamps.length, 1, '一次删除一个时间戳目录');
        assert.ok(fs.existsSync(path.join(
            vault, '.trash', stamps[0], '短剧', '要删的', 'shots', 's0.png')),
            '整棵项目树都在 .trash 里,可以自己捞回来');
        assert.ok(fs.existsSync(path.join(vault, '.trash', stamps[0], '短剧', '要删的', 'graph.json')));
    } finally {
        fs.rmSync(vault, { recursive: true, force: true });
    }
});

test('★ drama:remove:两条路都走不通时明确报失败,项目原地还在', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-drama-vault2-'));
    const root = path.join(vault, '短剧');
    try {
        putProject(root, '要删的');
        // 把库内回收站的位置占成一个文件 → `.trash/<时间戳>/…` 建不出来
        fs.writeFileSync(path.join(vault, '.trash'), 'x');
        const { call } = harness({
            root,
            vault,
            trash: async () => { throw new Error('Failed to perform delete operation'); },
        });

        await assert.rejects(() => call('drama:remove', { project: '要删的' }), /删除项目失败/);
        assert.ok(fs.existsSync(path.join(root, '要删的', 'graph.json')), '报失败时项目必须原地还在');
    } finally {
        fs.rmSync(vault, { recursive: true, force: true });
    }
});

test('drama:remove 的拒绝路径:项目不存在 / 这个环境没有回收站能力', async () => {
    const { call, root } = harness();
    putProject(root, '在的');
    await assert.rejects(() => call('drama:remove', { project: '不在的' }), /不存在/);

    // 没有回收站能力时**宁可失败**:绝不许退回 fs.rm —— 那会把"点错了能捞回来"变成永久删。
    const bare = harness({ root, trash: null });
    await assert.rejects(() => bare.call('drama:remove', { project: '在的' }), /不支持移到回收站/);
    assert.equal(fs.existsSync(path.join(root, '在的')), true, '被拒之后项目还在');
});

test('项目名里塞路径不会逃出根:洗名之后找不到,而且库外一个字节都没动', async () => {
    const { call, root } = harness();
    putProject(root, '正常项目');
    const outside = path.join(root, '..', 'kaiwu-escape-probe');
    fs.mkdirSync(path.join(outside, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'graph.json'), '{}', 'utf8');
    try {
        await assert.rejects(() => call('drama:remove', { project: '../kaiwu-escape-probe' }), /不存在/);
        await assert.rejects(() => call('drama:rename', { from: '../../kaiwu-escape-probe', to: 'x' }), /不存在/);
        assert.equal(fs.existsSync(path.join(outside, 'graph.json')), true, '库外那个目录必须原封不动');
    } finally {
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('drama:state 的类型表带 wired 标记(菜单靠它标「未接线」,插件不许自己抄一份名单)', async () => {
    const { call, root } = harness();
    putProject(root, '甲', {});
    const s = await call('drama:state', { project: '甲' });
    const byId = Object.fromEntries(s.types.map((t) => [t.id, t]));

    // 剩下的 4 条 run 是 NOT_WIRED 桩:它们跑起来会标红,菜单要能提前说
    for (const id of ['video', 'tts', 'render', 'publish']) {
        assert.equal(byId[id]?.wired, false, `${id} 应当标成未接线`);
    }
    for (const id of ['text', 'template', 'note', 'shell', 'llm', 'image', 'edit']) {
        assert.equal(byId[id]?.wired, true, `${id} 是真接线的`);
    }
    // 判据在**主进程**这一侧:名单不能靠插件再抄一份,所以 palette 必须自己给出来
    assert.equal(s.types.every((t) => typeof t.wired === 'boolean'), true);
    assert.equal(s.types.some((t) => 'run' in t), false, 'run 是函数,过不了 IPC(递的是叶子字段)');
});

test('文本节点只剩一个参数(value,带 importable 标记),两个老字段已从类型表里删掉', async () => {
    const { call, root } = harness();
    putProject(root, '甲', {});
    const s = await call('drama:state', { project: '甲' });
    const text = s.types.find((t) => t.id === 'text');
    assert.deepEqual(text.params.map((p) => p.key), ['value'],
        '「导入的文件」「用导入文件」必须从类型表里消失 —— 面板是照它画表单的');
    assert.equal(text.params[0].importable, true, '手输内容要带 importable:面板据此画那个 ＋');
    // 别的 textarea 不该长这个按钮(判据在类型表里,不是面板里写死的)
    const note = s.types.find((t) => t.id === 'note');
    assert.equal(note.params.some((p) => p.importable === true), false);
});

test('文本生成节点读取上游剧本与提示词，产出可继续连线的文本和项目内 txt', async () => {
    const calls = [];
    const { call, root } = harness({
        generateText: async ({ source, prompt }) => {
            calls.push({ source, prompt });
            return `续写：${source.slice(0, 12)}；${prompt}`;
        },
    });
    const project = '生成测试';
    putProject(root, project, { nodes: 0, shots: 0 });
    const graph = graphOf(root, project);
    graph.nodes = [
        { id: 'source', type: 'text', title: '剧本', params: { value: '第一幕：林晚走进旧宅。' } },
        { id: 'writer', type: 'llm', title: '文本生成', params: { prompt: '写下一幕' } },
        { id: 'next', type: 'template', title: '下游', params: { template: '收到 {{0}}' } },
    ];
    graph.edges = [{ from: 'source', to: 'writer' }, { from: 'writer', to: 'next' }];
    await call('drama:save', { project, graph });

    const first = await call('drama:run', { project, target: 'next' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { source: '第一幕：林晚走进旧宅。', prompt: '写下一幕' });
    assert.match(first.state.graph.runs.next.output, /收到 续写/);
    const file = first.state.graph.runs.writer.file;
    assert.match(file, /^outputs\/[\w-]+\.txt$/);
    assert.equal(fs.readFileSync(path.join(root, project, file), 'utf8'), first.state.graph.runs.writer.output);
    assert.equal((await call('drama:readOutput', { project, file })).text, first.state.graph.runs.writer.output);

    const second = await call('drama:run', { project, target: 'next' });
    assert.equal(calls.length, 1, '同一输入命中缓存，不重复调用模型');
    assert.match(second.state.graph.runs.next.output, /收到 续写/);
    await assert.rejects(() => call('drama:readOutput', { project, file: '../graph.json' }), /只能读取文本生成结果/);
});

test('文本生成失败不伪装为成功，也不写空文件', async () => {
    const { call, root } = harness({ generateText: async () => { throw new Error('模型不可用'); } });
    const project = '失败测试';
    putProject(root, project, { nodes: 0, shots: 0 });
    const graph = graphOf(root, project);
    graph.nodes = [{ id: 'writer', type: 'llm', title: '文本生成', params: { prompt: '写一段' } }];
    await call('drama:save', { project, graph });
    const result = await call('drama:run', { project, target: 'writer' });
    assert.match(result.summary, /模型不可用/);
    assert.equal(result.state.graph.runs.writer.status, 'failed');
    assert.equal(fs.existsSync(path.join(root, project, 'outputs')), false);
});

test('文本生成运行时只向发起窗口推送开始和结束，缓存命中不触发扫光', async () => {
    let finishGeneration;
    const pending = new Promise((resolve) => { finishGeneration = resolve; });
    const { call, handlers, root } = harness({ generateText: async () => pending });
    const project = '扫光测试';
    putProject(root, project, { nodes: 0, shots: 0 });
    const graph = graphOf(root, project);
    graph.nodes = [{ id: 'writer', type: 'llm', title: '文本生成', params: { prompt: '写一段' } }];
    await call('drama:save', { project, graph });

    const events = [];
    const owner = { sender: { send: (channel, payload) => events.push([channel, payload]) } };
    const running = handlers.get('drama:run')(owner, { project, target: 'writer', runId: 'run-1' });
    await new Promise((resolve) => setImmediate(resolve));
    const duringGeneration = events.slice();
    finishGeneration('生成的内容');
    await running;
    assert.deepEqual(duringGeneration, [['drama:runEvent', {
        project, runId: 'run-1', nodeId: 'writer', status: 'running',
    }]]);
    assert.deepEqual(events.at(-1), ['drama:runEvent', {
        project, runId: 'run-1', nodeId: 'writer', status: 'ok',
    }]);
    await handlers.get('drama:run')(owner, { project, target: 'writer', runId: 'run-2' });
    assert.equal(events.length, 2, '缓存命中时不应播放生成扫光');
});

test('文本生成失败时推送失败状态以停止扫光', async () => {
    const { call, handlers, root } = harness({ generateText: async () => { throw new Error('模型不可用'); } });
    const project = '扫光失败测试';
    putProject(root, project, { nodes: 0, shots: 0 });
    const graph = graphOf(root, project);
    graph.nodes = [{ id: 'writer', type: 'llm', params: { prompt: '写一段' } }];
    await call('drama:save', { project, graph });
    const events = [];
    const owner = { sender: { send: (channel, payload) => events.push([channel, payload]) } };
    await handlers.get('drama:run')(owner, { project, target: 'writer', runId: 'run-fail' });
    assert.deepEqual(events.map(([, payload]) => payload.status), ['running', 'failed']);
});

test('长剧本与长生成结果命中缓存后，下游仍拿到全文而非 2 万字预览', async () => {
    const source = '剧'.repeat(22000);
    const generated = '文'.repeat(23000);
    const calls = [];
    const { call, root } = harness({ generateText: async ({ source: received, prompt }) => {
        calls.push(prompt);
        if (prompt === '整理') {
            assert.equal(received, source);
            return generated;
        }
        assert.equal(received, generated, '下游必须拿到生成全文');
        return '已收全文';
    } });
    const project = '长文测试';
    putProject(root, project, { nodes: 0, shots: 0 });
    const graph = graphOf(root, project);
    graph.nodes = [
        { id: 'source', type: 'text', params: { value: source } },
        { id: 'writer', type: 'llm', params: { prompt: '整理' } },
        { id: 'next', type: 'llm', params: { prompt: '使用全文' } },
    ];
    graph.edges = [{ from: 'source', to: 'writer' }, { from: 'writer', to: 'next' }];
    await call('drama:save', { project, graph });
    const first = await call('drama:run', { project, target: 'next' });
    const second = await call('drama:run', { project, target: 'next' });
    assert.deepEqual(calls, ['整理', '使用全文']);
    assert.equal((await call('drama:readOutput', { project, file: first.state.graph.runs.writer.file })).text, generated);
    assert.equal(second.state.graph.runs.next.status, 'cached');
    const changed = second.state.graph;
    changed.nodes[2].params.prompt = '再次使用全文';
    await call('drama:save', { project, graph: changed });
    const third = await call('drama:run', { project, target: 'next' });
    assert.deepEqual(calls, ['整理', '使用全文', '再次使用全文']);
    assert.equal(third.state.graph.runs.writer.status, 'cached');
});

test('drama:state 把导入要用的常量一起给出来(格式清单来自引擎,不让插件另抄一份)', async () => {
    const { call, root } = harness();
    putProject(root, '甲', {});
    const s = await call('drama:state', { project: '甲' });
    assert.equal(s.textImport.maxBytes, 200 * 1024);
    for (const ext of ['txt', 'md', 'srt', 'json', 'csv', 'rtf', 'docx']) {
        assert.ok(s.textImport.extensions.includes(ext), `扩展名清单里应当有 ${ext}`);
    }
});

test('drama:readText:utf-8 文本连编码一起报出来', async () => {
    const { call, root } = harness();
    const file = path.join(root, '稿子.md');
    fs.writeFileSync(file, '# 第一幕\n林晚回到村口。', 'utf8');
    const r = await call('drama:readText', { path: file });
    assert.equal(r.name, '稿子.md');
    assert.match(r.text, /林晚回到村口/);
    assert.equal(r.chars, r.text.length);
    assert.match(r.note, /utf-8/, '编码要报出来 —— 中文乱码是这条路上最常见的事故');
});

test('drama:readText:GBK/GB18030 的文件不许读成乱码(中文 Windows 导出的 srt 十有八九是它)', async () => {
    const { call, root } = harness();
    const file = path.join(root, '第1集.srt');
    // 「中文」在 GBK 里就是这四个字节(中=D6D0 文=CEC4)—— 用它造一个**真**的非法
    // UTF-8 文件,不靠猜。⚠️ 上一版我把「文」写成了 C4C4(那是"哪"),断言当场红;
    //    所以这四字节先用 node 实测过再写进来。
    fs.writeFileSync(file, Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]));
    const r = await call('drama:readText', { path: file });
    assert.equal(r.text, '中文', '严格 UTF-8 失败后要回落到 gb18030,而不是给一屏替换字符');
    assert.match(r.note, /gb18030/);
});

test('drama:readText:引擎不支持的类型明确拒绝(不假装成功)', async () => {
    const { call, root } = harness();
    const file = path.join(root, '剧本.pdf');
    fs.writeFileSync(file, Buffer.from('%PDF-1.4 fake'));
    await assert.rejects(() => call('drama:readText', { path: file }), /PDF 没有可靠的纯文本层/);
});

test('drama:readText:找不到 / 不是文件 / 超过上限,三条都拒而且说得清', async () => {
    const { call, root } = harness();
    await assert.rejects(() => call('drama:readText', { path: path.join(root, '没有这个.txt') }), /找不到文件/);
    await assert.rejects(() => call('drama:readText', { path: root }), /不是一个文件/);
    await assert.rejects(() => call('drama:readText', {}), /需要 path/);

    const big = path.join(root, '太大.txt');
    fs.writeFileSync(big, 'a'.repeat(200 * 1024 + 10));
    await assert.rejects(() => call('drama:readText', { path: big }), /超过 200 KB 的导入上限/);
});

test('drama:readDroppedText 只从 docx 字节提取正文,不需要也不接受路径', async () => {
    const { call } = harness();
    const r = await call('drama:readDroppedText', { name: '台词终稿.docx', bytes: minimalDocx('第一场 雨声') });
    assert.equal(r.name, '台词终稿.docx');
    assert.equal(r.kind, 'docx');
    assert.equal(r.text, '第一场 雨声');
    assert.equal(r.chars, r.text.length);
});

test('drama:readDroppedText 拒绝旧 doc、空字节和过大的字节载荷', async () => {
    const { call } = harness();
    await assert.rejects(() => call('drama:readDroppedText', { name: '旧稿.doc', bytes: Uint8Array.of(1) }), /另存为 .docx/);
    await assert.rejects(() => call('drama:readDroppedText', { name: '空.docx', bytes: new Uint8Array() }), /文件为空/);
    await assert.rejects(() => call('drama:readDroppedText', {
        name: '太大.docx', bytes: new Uint8Array(200 * 1024 + 1),
    }), /超过 200 KB 的导入上限/);
});

test('老节点一次性搬运:inputs/ 里的正文搬进 value,老字段清掉(id 与别的参数不动)', async () => {
    const { call, root } = harness();
    const dir = putProject(root, '老项目', { nodes: 1, shots: 0 });
    fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'inputs', '稿子.txt'), '旧版导入进来的正文', 'utf8');
    // 老形状:value 空着,正文在 source 指的文件里
    const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
    graph.nodes[0] = {
        id: 'n0', type: 'text', title: '稿子', x: 10, y: 20,
        params: { value: '', source: 'inputs/稿子.txt', useSource: 'true', sourceChars: 9 },
    };
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');

    const s = await call('drama:state', { project: '老项目' });
    const node = s.graph.nodes.find((n) => n.id === 'n0');
    assert.equal(node.params.value, '旧版导入进来的正文', '正文必须搬进 value —— 不搬就是静默变空');
    for (const gone of ['source', 'useSource', 'sourceChars']) {
        assert.equal(gone in node.params, false, `${gone} 应当被清掉`);
    }
    assert.equal(node.x, 10, '搬运只动 params,坐标等一概不动');

    // 幂等:第二次载入一个字节都不该再写(载入一次写一次档是不可接受的副作用)
    const first = fs.readFileSync(path.join(dir, 'graph.json'), 'utf8');
    await call('drama:state', { project: '老项目' });
    assert.equal(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'), first, '第二次载入不该再写盘');
});

test('老节点搬运的两种例外:value 非空以手输为准;文件不在了就原样留着(别搬一半)', async () => {
    const { call, root } = harness();
    const dir = putProject(root, '老项目', { nodes: 2, shots: 0 });
    const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
    graph.nodes[0] = {
        id: 'n0', type: 'text', title: '手写过', x: 0, y: 0,
        params: { value: '我自己写的', source: 'inputs/旧.txt', useSource: 'true' },
    };
    graph.nodes[1] = {
        id: 'n1', type: 'text', title: '文件没了', x: 0, y: 100,
        params: { value: '', source: 'inputs/不在了.txt', useSource: 'true' },
    };
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');

    const s = await call('drama:state', { project: '老项目' });
    const byId = Object.fromEntries(s.graph.nodes.map((n) => [n.id, n]));
    assert.equal(byId.n0.params.value, '我自己写的', '手输的不许被搬运覆盖');
    assert.equal('source' in byId.n0.params, false, '老字段仍然要清掉(搬运的意图是收敛到一个正文)');
    assert.equal(byId.n1.params.value, '', '文件读不到就不搬');
    assert.equal(byId.n1.params.source, 'inputs/不在了.txt', '老字段原样留着 —— 老节点照旧能跑并报出原因');
});

test('preload 的白名单与 DRAMA_INVOKE_CHANNELS 逐字对上(两边漂移过一次就会静默失效)', () => {
    const text = fs.readFileSync(PRELOAD, 'utf8');
    const start = text.indexOf('const ALLOWED_INVOKE');
    const end = text.indexOf('];', start);
    assert.ok(start >= 0 && end > start, 'preload 里找不到 ALLOWED_INVOKE 列表');
    const listed = text.slice(start, end);
    for (const channel of DRAMA_INVOKE_CHANNELS) {
        assert.ok(listed.includes(`'${channel}'`),
            `preload 的 ALLOWED_INVOKE 里少了 ${channel} —— 渲染进程调它会被"未授权的 IPC 频道"挡掉`);
    }
    // 新的两条确实在表里(免得上面那条因为两边都漏了而空转通过)
    assert.ok(DRAMA_INVOKE_CHANNELS.includes('drama:rename'));
    assert.ok(DRAMA_INVOKE_CHANNELS.includes('drama:remove'));
});
