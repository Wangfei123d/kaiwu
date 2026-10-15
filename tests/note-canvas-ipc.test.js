import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCanvasIpc } from '../electron/notes/canvas-ipc.js';
import { buildCtx } from '../app/runtime/ctx.js';
import { KNOWN_PERMISSIONS } from '../app/lib/manifest-schema.js';
import { writeNote } from '../electron/notes/note-index.js';

const graph = (text = '') => ({ nodes: [{ id: 'n', type: 'text', x: 0, y: 0, width: 100, height: 100, text }], edges: [] });
const png = () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function setup(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiwu-canvas-'));
    const root = path.join(base, 'vault'); fs.mkdirSync(root);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    let vault = root;
    const handlers = new Map();
    registerCanvasIpc({ ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) }, vaultRoot: () => vault });
    return { base, root, switchVault: value => { vault = value; }, call: (key, payload) => handlers.get(`canvas:${key}`)(null, payload) };
}

test('canvas storage creates, reads, persists and lists real vault files', async t => {
    const h = setup(t);
    fs.writeFileSync(path.join(h.root, '正文.md'), '# 正文');
    fs.writeFileSync(path.join(h.root, '备忘.txt'), 'text');
    const created = await h.call('create', { name: '计划' });
    assert.equal(created.path, '画布/计划.canvas'); assert.match(created.revision, /^[a-f0-9]{64}$/); assert.ok(created.vault);
    const saved = await h.call('write', { path: created.path, graph: graph('saved'), revision: created.revision, vault: created.vault });
    const read = await h.call('read', { path: created.path });
    assert.equal(read.revision, saved.revision); assert.equal(read.graph.nodes[0].text, 'saved');
    const library = await h.call('library');
    assert.deepEqual(library.boards, [{ path: created.path, name: '计划' }]);
    assert.deepEqual(library.notes.map(n => [n.path, n.kind]), [['备忘.txt', 'text'], ['正文.md', 'markdown']]);
});

test('canvas save keeps the main event loop responsive while disk commit is pending', async t => {
    const h = setup(t); const board = await h.call('create', { name: 'responsive' });
    const expectedPath = path.join(h.root, board.path);
    const syncFsync = fs.fsyncSync, asyncOpen = fs.promises.open;
    let enterSync, releaseSync, saveFinished = false;
    const syncEntered = new Promise(resolve => { enterSync = resolve; });
    fs.fsyncSync = fd => {
        const result = syncFsync(fd);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        return result;
    };
    fs.promises.open = async (file, ...rest) => {
        const handle = await asyncOpen(file, ...rest);
        if (String(file).startsWith(`${expectedPath}.tmp-`)) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
                enterSync();
                await new Promise(resolve => { releaseSync = resolve; });
                return sync();
            };
        }
        return handle;
    };
    const pending = h.call('write', { ...board, graph: graph('saved') }).finally(() => { saveFinished = true; });
    try {
        const usesAsyncCommit = await Promise.race([syncEntered.then(() => true), pending.then(() => false)]);
        assert.equal(usesAsyncCommit, true, 'canvas persistence must use the awaitable file flush');
        const responsive = await new Promise(resolve => setImmediate(() => resolve(!saveFinished)));
        assert.equal(responsive, true, 'a pending disk commit must yield to the main event loop');
    } finally {
        releaseSync?.();
        await pending.catch(() => {});
        fs.fsyncSync = syncFsync;
        fs.promises.open = asyncOpen;
    }
});

test('canvas storage rejects collisions, bad names, paths and stale revisions', async t => {
    const h = setup(t); const created = await h.call('create', { name: '计划' });
    for (const name of ['', '../x', 'a/b', 'CON', 'con.txt', 'x'.repeat(101), 'name.']) await assert.rejects(h.call('create', { name }), /[\u4e00-\u9fff]/);
    await assert.rejects(h.call('create', { name: '计划' }), /存在/);
    for (const unsafe of ['../escape.canvas', '正文.md', '画布/missing.canvas', '画布/sub/a.canvas', path.join(h.root, '画布/计划.canvas')]) {
        await assert.rejects(h.call('read', { path: unsafe }), /[\u4e00-\u9fff]/);
        await assert.rejects(h.call('write', { path: unsafe, graph: graph(), revision: created.revision, vault: created.vault }));
    }
    fs.mkdirSync(path.join(h.root, '画布', 'directory.canvas'));
    await assert.rejects(h.call('read', { path: '画布/directory.canvas' }), /文件/);
    const results = await Promise.allSettled(['a', 'b'].map(text => h.call('write', { ...created, graph: graph(text) })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /冲突/);
    await assert.rejects(h.call('write', { ...created, graph: graph('old') }), /冲突/);
});

test('canvas storage binds old writes and imported images to their vault', async t => {
    const h = setup(t); const old = await h.call('create', { name: '同名' });
    const second = path.join(h.base, 'second'); fs.mkdirSync(second); h.switchVault(second);
    const current = await h.call('create', { name: '同名' });
    assert.equal(old.revision, current.revision);
    await assert.rejects(h.call('write', { ...old, graph: graph('old data') }), /笔记库/);
    await assert.rejects(h.call('importImage', { path: old.path, vault: old.vault, name: 'image.png', bytes: png(), mimeType: 'image/png' }), /笔记库/);
    assert.deepEqual((await h.call('read', { path: current.path })).graph, current.graph);
    h.switchVault(null);
    const lib = await h.call('library'); assert.deepEqual(lib.boards, []); assert.match(lib.reason, /笔记库/);
    await assert.rejects(h.call('create', { name: 'x' }), /笔记库/);
});

test('canvas storage confines image bytes, MIME, extension and media reads', async t => {
    const h = setup(t); const board = await h.call('create', { name: '素材' });
    const image = await h.call('importImage', { path: board.path, vault: board.vault, name: 'image.png', bytes: png(), mimeType: 'image/png' });
    assert.match(image.file, /^画布\/素材\.assets\/image-[a-f0-9-]+\.png$/);
    assert.match((await h.call('media', { file: image.file })).dataUrl, /^data:image\/png;base64,/);
    const second = await h.call('importImage', { path: board.path, vault: board.vault, name: 'image.png', bytes: png(), mimeType: 'image/png' });
    assert.notEqual(second.file, image.file); assert.equal(second.name, 'image.png');
    for (const bad of [{ name: 'bad.svg', mimeType: 'image/svg+xml', bytes: png() }, { name: '../bad.png', mimeType: 'image/png', bytes: png() }, { name: 'bad.jpg', mimeType: 'image/jpeg', bytes: png() }, { name: 'bad.png', mimeType: 'image/png', bytes: Uint8Array.from([60, 104, 116, 109, 108]) }, { name: 'huge.png', mimeType: 'image/png', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }]) {
        await assert.rejects(h.call('importImage', { path: board.path, vault: board.vault, ...bad }), /[\u4e00-\u9fff]/);
    }
    fs.writeFileSync(path.join(h.root, 'external.png'), png());
    assert.match((await h.call('media', { file: 'external.png' })).dataUrl, /^data:image\/png/);
    for (const file of ['https://example.com/a.png', '../external.png', '正文.md']) await assert.rejects(h.call('media', { file }));
});

test('canvas storage refuses canvas directory junctions escaping the vault', async t => {
    const h = setup(t); const outside = path.join(h.base, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(h.root, '画布'), 'junction');
    await assert.rejects(h.call('create', { name: 'escape' }), /路径/);
    fs.writeFileSync(path.join(outside, 'escape.canvas'), JSON.stringify(graph()));
    await assert.rejects(h.call('read', { path: '画布/escape.canvas' }), /路径/);
    assert.deepEqual((await h.call('library')).boards, []);
});

test('canvas capability is explicit and preserves vault binding across delayed saves', async () => {
    const calls = []; const bridge = { invoke: async (channel, payload) => { calls.push([channel, payload]); return channel === 'canvas:read' ? { path: payload.path, graph: graph(), revision: 'rev', vault: 'old' } : {}; } };
    const make = permissions => buildCtx({ descriptor: { id: 'test', permissions }, bridge, registries: {} });
    assert.equal(make([]).canvas, undefined); assert.ok(KNOWN_PERMISSIONS.includes('canvas'));
    const ctx = make(['canvas']); const board = await ctx.canvas.read('画布/a.canvas');
    await ctx.canvas.write(board.path, graph(), board.revision);
    assert.deepEqual(calls.at(-1), ['canvas:write', { path: board.path, graph: graph(), revision: 'rev', vault: 'old' }]);
    await ctx.canvas.importImage(board.path, { name: 'a.png', bytes: png(), mimeType: 'image/png' }, 'old');
    assert.equal(calls.at(-1)[1].vault, 'old');
});

test('canvas note editing preserves encoding and refuses external edits and changed vaults', async t => {
    const h = setup(t); fs.writeFileSync(path.join(h.root, 'note.txt'), '\ufeffold\r\ntext');
    const vault = (await h.call('library')).vault;
    const note = await h.call('readNote', { path: 'note.txt', vault });
    assert.equal(note.editable, true); assert.equal(note.bom, true);
    const saved = await h.call('writeNote', { path: 'note.txt', text: 'new\ntext', revision: note.revision, vault });
    assert.equal(fs.readFileSync(path.join(h.root, 'note.txt'), 'utf8'), '\ufeffnew\r\ntext'); assert.ok(saved.revision);
    fs.writeFileSync(path.join(h.root, 'note.txt'), 'external edit');
    await assert.rejects(h.call('writeNote', { path: 'note.txt', text: 'overwrite', revision: saved.revision, vault }), /冲突/);
    h.switchVault(null);
    await assert.rejects(h.call('writeNote', { path: 'note.txt', text: 'overwrite', revision: saved.revision, vault }), /笔记库/);
});

test('canvas note edits stop when the vault changes during asynchronous preparation', async t => {
    const h = setup(t); fs.writeFileSync(path.join(h.root, 'note.md'), 'original');
    const vault = (await h.call('library')).vault;
    const note = await h.call('readNote', { path: 'note.md', vault });
    const pending = h.call('writeNote', { path: 'note.md', text: 'overwrite', revision: note.revision, vault });
    h.switchVault(null);
    await assert.rejects(pending, /笔记库/);
    assert.equal(fs.readFileSync(path.join(h.root, 'note.md'), 'utf8'), 'original');
});

test('canvas import requires declared MIME and supports all five safe bitmap formats', async t => {
    const h = setup(t); const board = await h.call('create', { name: 'formats' });
    await assert.rejects(h.call('importImage', { path: board.path, vault: board.vault, name: 'undeclared.png', bytes: png() }), /类型/);
    for (const [name, mimeType, data] of [
        ['a.png', 'image/png', png()], ['a.jpg', 'image/jpeg', [255, 216, 255, 0]],
        ['a.webp', 'image/webp', Buffer.from('RIFF0000WEBP')], ['a.gif', 'image/gif', Buffer.from('GIF89a00')], ['a.bmp', 'image/bmp', Buffer.from('BM000000')],
    ]) {
        const result = await h.call('importImage', { path: board.path, vault: board.vault, name, mimeType, bytes: Uint8Array.from(data) });
        assert.match((await h.call('media', { file: result.file, vault: board.vault })).dataUrl, new RegExp(`^data:${mimeType};base64,`));
    }
});

test('canvas note writes refuse a backup symlink without touching external bytes', async t => {
    const h = setup(t); fs.writeFileSync(path.join(h.root, 'note.md'), 'original');
    const outside = path.join(h.base, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(h.root, 'note.md.bak'), 'junction');
    const vault = (await h.call('library')).vault;
    const note = await h.call('readNote', { path: 'note.md', vault });
    await assert.rejects(h.call('writeNote', { path: 'note.md', text: 'overwrite', revision: note.revision, vault }), /路径/);
    assert.equal(fs.readFileSync(path.join(h.root, 'note.md'), 'utf8'), 'original');
});

test('note writer final guard rejection leaves original intact and cleans temporary file', async t => {
    const h = setup(t); fs.writeFileSync(path.join(h.root, 'note.md'), 'original');
    let checks = 0;
    await assert.rejects(writeNote(h.root, 'note.md', 'changed', { backup: false, beforeWrite() {
        checks += 1; if (checks === 3) throw new Error('最终守卫拒绝');
    } }), /最终守卫/);
    assert.equal(checks, 3); assert.equal(fs.readFileSync(path.join(h.root, 'note.md'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(h.root), ['note.md']);
});

test('note writer never cleans a temporary file owned by another write', async t => {
    const h = setup(t); fs.writeFileSync(path.join(h.root, 'note.md'), 'original');
    const oldNow = Date.now; Date.now = () => 123456789;
    const temporary = path.join(h.root, `note.md.tmp-${process.pid}-123456789`);
    fs.writeFileSync(temporary, 'other write');
    try {
        await assert.rejects(writeNote(h.root, 'note.md', 'changed', { backup: false }), /EEXIST/);
        assert.equal(fs.readFileSync(temporary, 'utf8'), 'other write');
        assert.equal(fs.readFileSync(path.join(h.root, 'note.md'), 'utf8'), 'original');
    } finally { Date.now = oldNow; }
});

test('ctx never rebinds an identical old revision to another vault implicitly', async () => {
    let current = 'old'; const calls = [];
    const bridge = { invoke: async (channel, payload) => { calls.push([channel, payload]); return channel === 'canvas:read' ? { path: payload.path, revision: 'same', vault: current } : {}; } };
    const ctx = buildCtx({ descriptor: { id: 'test', permissions: ['canvas'] }, bridge, registries: {} });
    await ctx.canvas.read('画布/same.canvas'); current = 'new'; await ctx.canvas.read('画布/same.canvas');
    await ctx.canvas.write('画布/same.canvas', graph(), 'same');
    assert.notEqual(calls.at(-1)[1].vault, 'new');
});

test('canvas note APIs keep non-UTF8 readonly and enforce bounded hash reads', async t => {
    const h = setup(t); fs.writeFileSync(path.join(h.root, 'readonly.txt'), Buffer.from([255, 254, 65, 0]));
    const vault = (await h.call('library')).vault;
    const note = await h.call('readNote', { path: 'readonly.txt', vault });
    assert.equal(note.editable, false);
    await assert.rejects(h.call('writeNote', { path: 'readonly.txt', text: 'modified', revision: note.revision, vault }), /UTF-8/);
    fs.writeFileSync(path.join(h.root, 'large.txt'), Buffer.alloc(20 * 1024 * 1024 + 1, 65));
    await assert.rejects(h.call('readNote', { path: 'large.txt', vault }), /大小/);
    await assert.rejects(h.call('writeNote', { path: 'readonly.txt', text: 'modified', revision: note.revision }), /笔记库/);
    await assert.rejects(h.call('readNote', { path: 'readonly.txt' }), /笔记库/);
});

test('canvas media and queued mutations reject switched vault tokens', async t => {
    const h = setup(t); const board = await h.call('create', { name: 'queued' });
    const image = await h.call('importImage', { path: board.path, vault: board.vault, name: 'a.png', bytes: png(), mimeType: 'image/png' });
    const pending = h.call('write', { ...board, graph: graph('late') });
    h.switchVault(null); await assert.rejects(pending, /笔记库/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.root, board.path), 'utf8')), board.graph);
    await assert.rejects(h.call('media', { file: image.file, vault: board.vault }), /笔记库/);
});

for (const [label, payload] of [
    ['ASCII UTF8', () => 'x'.repeat(20 * 1024 * 1024 + 1)],
    ['multibyte UTF8', () => '汉'.repeat(Math.floor(20 * 1024 * 1024 / 3) + 1)],
    ['CRLF conversion plus BOM', () => 'x\n'.repeat(Math.floor(20 * 1024 * 1024 / 3) + 1)],
]) test(`canvas rejects oversized final ${label} bytes before changing original or backup`, async t => {
    const h = setup(t); const rel = label.includes('CRLF') ? 'note.txt' : 'note.md';
    const original = label.includes('CRLF') ? '\ufefforiginal\r\ntext' : 'original';
    fs.writeFileSync(path.join(h.root, rel), original);
    fs.writeFileSync(path.join(h.root, `${rel}.bak`), 'older backup');
    const vault = (await h.call('library')).vault;
    const note = await h.call('readNote', { path: rel, vault });
    const text = payload();
    if (label.includes('CRLF')) assert.ok(Buffer.byteLength(text) < 20 * 1024 * 1024);
    await assert.rejects(h.call('writeNote', { path: rel, text, revision: note.revision, vault }), /大小|上限/);
    assert.ok(fs.readFileSync(path.join(h.root, rel), 'utf8') === original, '拒绝后原文须逐字节不变');
    assert.equal(fs.readFileSync(path.join(h.root, `${rel}.bak`), 'utf8'), 'older backup');
    assert.deepEqual(fs.readdirSync(h.root).sort(), [rel, `${rel}.bak`].sort());
});

test('optional note maxBytes measures BOM and preserves default unlimited writing', async t => {
    const h = setup(t); fs.writeFileSync(path.join(h.root, 'bom.md'), '\ufeffold');
    await assert.rejects(writeNote(h.root, 'bom.md', 'abc', { maxBytes: 5 }), /大小|上限/);
    assert.equal(fs.readFileSync(path.join(h.root, 'bom.md'), 'utf8'), '\ufeffold');
    assert.deepEqual(fs.readdirSync(h.root), ['bom.md']);
    await writeNote(h.root, 'bom.md', 'abc');
    assert.equal(fs.readFileSync(path.join(h.root, 'bom.md'), 'utf8'), '\ufeffabc');
    await assert.rejects(writeNote(h.root, 'new.md', 'abcdef', { maxBytes: 5 }), /大小|上限/);
    assert.equal(fs.existsSync(path.join(h.root, 'new.md')), false);
});
