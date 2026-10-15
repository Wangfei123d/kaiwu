import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    KIND_LABEL, __resetForTest, absOf, begin, current, end, extOf, getVaultRoot, kindOfName, onBegin,
    onEnd, setVaultRoot,
} from '../app/lib/drag-bus.js';

// 拖拽总线:纯逻辑,单测直接钉。两条最要紧的判据 ——
//   ① 类型分派(画布只认三类,其余必须能被认出来是 other 并拒绝);
//   ② 载荷里的**绝对路径**:引擎按盘上的路径读图/读稿子,而"参考图"那条路会把相对路径
//      拼到**项目目录**下(electron/drama/lib/image.js:349)—— 所以拼错就是把图读成"不存在"。

const fresh = (root = 'E:\\vault') => { __resetForTest(); setVaultRoot(root); };

test('类型分派:三类认得出来,其余是 other', () => {
    assert.equal(kindOfName('分镜.md'), 'text');
    assert.equal(kindOfName('台词终稿.DOCX'), 'text', '大小写不敏感');
    assert.equal(kindOfName('定妆照-小满.png'), 'image');
    assert.equal(kindOfName('参考片头.mp4'), 'video');
    assert.equal(kindOfName('打包.zip'), 'other');
    assert.equal(kindOfName('没有扩展名'), 'other');
    assert.equal(kindOfName('.gitignore'), 'other', '点开头的不算扩展名');
    assert.equal(kindOfName('末尾有点.'), 'other');
    assert.equal(extOf('a/b/c.MP4'), 'mp4', '带目录也认');
});

test('类型按**路径**认,不按标题认:笔记列表递上来的 name 是标题(没有扩展名)', () => {
    // 这个坑实测踩过:笔记树那一侧 begin({name: info.name}),而 info.name 是**标题**
    // (「甲篇」)。按 name 认类型 → .md 被判成 other → 画布回一句"这种格式还用不了",
    // 现象却是"拖上去什么都没发生"。relPath 是盘上的文件名,一定带扩展名。
    fresh('E:\\vault');
    const md = begin({ relPath: '短剧/甲篇.md', name: '甲篇' });
    assert.equal(md.kind, 'text', '扩展名从 relPath 取');
    assert.equal(md.ext, 'md');
    assert.equal(md.name, '甲篇', '显示用的名字保持标题原样');
    assert.equal(md.absPath, 'E:\\vault\\短剧\\甲篇.md');
    end({ clientX: 1, clientY: 2, insideTree: true });

    assert.equal(begin({ relPath: '素材/定妆照.png', name: '定妆照' }).kind, 'image');
    end({});
    // name 自己带扩展名时也认(没有 relPath 的调用方照样能用)
    assert.equal(begin({ relPath: 'a/b', name: '旁白.srt' }).kind, 'text');
    end({});
    assert.equal(begin({ relPath: '素材/参考.mp4', name: '' }).kind, 'video', 'name 空时回落到路径末段');
    end({});
});

test('路径:库内相对路径 → 绝对路径(两种分隔符都收,输出跟随库根的写法)', () => {
    fresh('E:\\project\\kaiwu-demo-vault');
    assert.equal(absOf('短剧/第3集/分镜.md'), 'E:\\project\\kaiwu-demo-vault\\短剧\\第3集\\分镜.md');
    assert.equal(absOf('短剧\\第3集\\分镜.md'), 'E:\\project\\kaiwu-demo-vault\\短剧\\第3集\\分镜.md');
    assert.equal(absOf('./甲篇.md'), 'E:\\project\\kaiwu-demo-vault\\甲篇.md');
    fresh('E:/vault/');
    assert.equal(absOf('a/b.png'), 'E:/vault/a/b.png', '库根带尾斜杠也对');
});

test('路径:带 .. 段一律拒绝(防御性:拼路径的这层不该接受越界段)', () => {
    fresh('E:\\\\vault');
    assert.equal(absOf('..\\\\Windows\\\\win.ini'), '');
    assert.equal(absOf('a/../../b.md'), '');
});

test('路径:库根还不知道时**回空串**(宁可不落地,也不递一个错的路径)', () => {
    __resetForTest();
    assert.equal(getVaultRoot(), '');
    assert.equal(absOf('甲篇.md'), '');
    fresh('E:\\vault');
    assert.equal(absOf('   '), '');
});

test('开拖:记下载荷(名字/扩展名/类型/绝对路径),目录不参与', () => {
    fresh('E:\\vault');
    const p = begin({ relPath: '短剧/定妆照.png', name: '定妆照.png' });
    assert.equal(p.kind, 'image');
    assert.equal(p.ext, 'png');
    assert.equal(p.absPath, 'E:\\vault\\短剧\\定妆照.png');
    assert.equal(current(), p, '拖的过程中谁都问得到');
    // 目录:画布只收文件
    assert.equal(begin({ relPath: '短剧', name: '短剧', isDir: true }), null);
    assert.equal(current(), null);
    // 名字缺省时从路径里取
    assert.equal(begin({ relPath: 'a/b/分镜.md' }).name, '分镜.md');
});

test('松手:载荷交给订阅者,并带上落点与"是不是松在树里"', () => {
    fresh('E:\\vault');
    const seen = [];
    const off = onEnd((e) => seen.push(e));
    begin({ relPath: '甲篇.md', name: '甲篇.md' });
    const handed = end({ clientX: 620, clientY: 380, insideTree: false });
    assert.equal(handed.name, '甲篇.md');
    assert.equal(seen.length, 1);
    assert.deepEqual(
        { x: seen[0].clientX, y: seen[0].clientY, inTree: seen[0].insideTree, kind: seen[0].payload.kind },
        { x: 620, y: 380, inTree: false, kind: 'text' });
    assert.equal(current(), null, '松手之后没人还在拖');
    off();
    begin({ relPath: 'b.png', name: 'b.png' });
    end({});
    assert.equal(seen.length, 1, '退订之后不再收到');
});

test('松手:没人在拖时什么都不发生(不会凭空派发一条载荷)', () => {
    fresh('E:\\vault');
    let n = 0;
    onEnd(() => { n += 1; });
    assert.equal(end({ clientX: 1, clientY: 2 }), null);
    assert.equal(n, 0);
    // 缺省落点也不许炸:坐标回 null(面板据此选择不接)
    begin({ relPath: '甲.md', name: '甲.md' });
    const p = end();
    assert.equal(p.kind, 'text');
});

test('开拖也有订阅(面板据此提前亮出"可以拖到我这儿")', () => {
    fresh('E:\\vault');
    const seen = [];
    const off = onBegin((p) => seen.push(p.kind));
    begin({ relPath: 'a.mp4', name: 'a.mp4' });
    assert.deepEqual(seen, ['video']);
    off();
    begin({ relPath: 'b.png', name: 'b.png' });
    assert.deepEqual(seen, ['video'], '退订之后不再收到');
});

test('订阅者抛错不影响发起方(拖拽不能因为某个面板的 bug 而卡住)', () => {
    fresh('E:\\vault');
    onEnd(() => { throw new Error('这个面板坏了'); });
    let ok = 0;
    onEnd(() => { ok += 1; });
    begin({ relPath: 'a.md', name: 'a.md' });
    assert.equal(end({}).kind, 'text');
    assert.equal(ok, 1, '坏订阅者不影响后面的');
});

test('中文名与 KIND_LABEL:拒绝时要说人话', () => {
    assert.equal(KIND_LABEL.other, '这种格式');
    assert.equal(KIND_LABEL.image, '图片');
});
