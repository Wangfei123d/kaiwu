// 收"从笔记列表拖过来的文件"—— 全应用**拖拽总线**的接货方(方案丙)。
//
// 为什么单独一个模块:index.js 已经 1800 行,而"接货"这件事的判据(类型分派、图坐标换算、
// 参考图要绝对路径)自成一套,抽出来既好读、又好单独钉。
//
// 总线在 app/lib/drag-bus.js(外壳侧);插件通过 toolbox://shell/lib/drag-bus.js 拿到同一份
// 实例 —— 同一个 realm 里的模块单例,所以"谁在拖"这件事是共享的,不需要 IPC。
//
// 三条纪律:
//   · 只接**松在画布范围内**、且**不是松在笔记树里**的那一拖(树内 = 一次笔记移动);
//   · 落点用**图坐标**(屏幕 - 画布 - view,再除以 scale)—— 与"拖节点"同一套换算;
//   · 拖动途中只画一层虚线反馈(靠 data-drop 属性 + CSS 伪元素),**绝不重建图**。
//
// ⚠️ 图片必须写**绝对路径**:引擎把相对路径拼到**项目目录**下(electron/drama/lib/image.js:349),
//    库内相对路径在那条路上读不到图。总线载荷里已经带好 absPath。

/** 画布认得的类型 → 中文名(其余一律拒绝,并说人话)。 */
export const DROP_KINDS = Object.freeze({ text: '文本', image: '图片', video: '视频' });

/**
 * @param {object} deps 全是 index.js 里现成的闭包(不新造状态)
 * @param {object} deps.ctx  插件上下文
 * @param {object} deps.el   index.js 的元素表(el.canvas / el.world)
 * @param {object} deps.state 画布状态(state.view / state.selection / state.graph / state.project)
 * @param {(id:string)=>object|null} deps.nodeById
 * @param {(type:string,x:number,y:number)=>object|null} deps.createNode
 * @param {()=>void} deps.scheduleSave
 * @param {(text:string)=>void} deps.setStatus
 * @returns {Promise<()=>void>} 退订函数(面板被拆掉时调)
 */
export async function wireDrop({ ctx, el, state, nodeById, createNode,
    scheduleSave, setStatus, preview, bus: suppliedBus }) {
    let bus = suppliedBus ?? null;
    try {
        bus ??= await import('toolbox://shell/lib/drag-bus.js');
    } catch (err) {
        // 拿不到总线不影响画布其它功能 —— 只是收不了拖进来的文件
        ctx?.log?.warn?.(`拖拽总线接不上(画布收不了拖进来的文件):${err?.message ?? err}`);
        return () => {};
    }

    /** 屏幕坐标 → 图坐标(唯一的换算口,与拖节点那段口径一致)。 */
    const toWorld = (clientX, clientY) => {
        const rect = el.canvas.getBoundingClientRect();
        const s = state.view.scale || 1;
        return {
            x: (Number(clientX) - rect.left - state.view.x) / s,
            y: (Number(clientY) - rect.top - state.view.y) / s,
        };
    };
    const insideCanvas = (clientX, clientY) => {
        if (!Number.isFinite(Number(clientX)) || !Number.isFinite(Number(clientY))) return false;
        const r = el.canvas.getBoundingClientRect();
        // 判定的**读数**也留一份:落点被判"不在范围内"时,只有把 rect 说出来才知道
        // 是"元素不是我看到的那个"(rect 全 0)还是"坐标真的偏了"(实测踩到过)。
        try {
            el.canvas.dataset.dropRect = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)} connected=${el.canvas.isConnected === true} xy=${clientX},${clientY}`;
        } catch { /* 写不进去就算了 */ }
        return Number(clientX) >= r.left && Number(clientX) <= r.right
            && Number(clientY) >= r.top && Number(clientY) <= r.bottom;
    };
    const selectedNode = () => {
        for (const id of state.selection) return nodeById(id);
        return null;
    };
    // ⚠️ 踩过的坑:`createNode` 返回的是**字符串 id**,不是节点对象(见 index.js:1214)。
    //    照对象用(target.id)会拿到 undefined → nodeById(undefined) → null →
    //    每一步都"静默不落地"(现象和"接货逻辑没接上"一模一样)。这里只认 id;
    //    顺手兼容两种形状(将来若改成返回对象也不用再修一遍)。
    const fail = (msg) => { setStatus(msg); trace(`applyDrop 停:${msg}`); };
    const makeNode = (type, at) => {
        const made = createNode(type, at.x, at.y);
        if (made === null || made === undefined) { fail('画布还没准备好(没有打开的项目?)'); return null; }
        const id = typeof made === 'string' ? made : made.id;
        const node = nodeById(id);
        if (node === null || node === undefined) { fail('这个节点已经不在了'); return null; }
        return node;
    };
    const arm = (on) => {
        if (on) el.canvas.setAttribute('data-drop', 'armed');
        else el.canvas.removeAttribute('data-drop');
    };

    /** 把一次落下的文件变成节点。 */
    async function applyDrop(payload, at) {
        if (payload.kind === 'text') {
            // 已选中的就是「文本 / 剧本」→ 导进它;否则**新建一个**再导(落点就是它的位置)
            const sel = selectedNode();
            const node = (sel !== null && sel.type === 'text') ? sel : makeNode('text', at);
            if (node === null) return;
            try {
                setStatus('正在读取文件…');
                const r = await ctx.drama.readText({ path: payload.absPath });
                node.params = { ...(node.params ?? {}), value: r.text };
                scheduleSave();
                trace(`文本已落:${r.chars} 字 → 节点 ${node.id}`);
                setStatus(`已导入 ${r.name} · ${r.chars} 字${r.note === '' || r.note === undefined ? '' : ` · ${r.note}`}`);
            } catch (err) {
                setStatus(`导入失败:${err?.message ?? err}`);
            }
            return;
        }

        if (payload.kind === 'video') {
            // ⚠️ 引擎里**没有"视频输入"槽**(「图生视频」的输入是图集,不是视频文件)——
            //    所以这里只能诚实记一条备注 + 给出可复制的抽帧命令,不假装它能接进产物链。
            const node = makeNode('note', at);
            if (node === null) return;
            node.params = {
                ...(node.params ?? {}),
                value: `素材视频:${payload.name}\n${payload.absPath}\n\n需要抽帧时可以跑:\nffmpeg -i "${payload.absPath}" -vf fps=1 frames-%03d.png`,
            };
            scheduleSave();
            setStatus(`${payload.name}:记成备注了 —— 引擎里没有"视频输入"槽,它接不到产物链上`);
            return;
        }

        setStatus(`这种格式画布还用不了:${payload.name}`);
    }

    // 拖动途中:指针进到画布范围就亮出"可以放这儿";离开 / 松手就收掉
    const onEnter = () => {
        const now = bus.current?.();
        if (now !== null && now !== undefined && now.kind !== 'image'
            && DROP_KINDS[now.kind] !== undefined) arm(true);
    };
    const hidePreviews = () => preview?.hide();
    const onLeave = () => { arm(false); hidePreviews(); };
    // 笔记行拖动时持有 pointer capture，画布可能收不到 pointerenter/move。
    // document 上的坐标仍是实际指针位置；这里只更新临时 DOM，不改 graph。
    const onMove = (event) => {
        const now = bus.current?.();
        if (now === null || now === undefined || now.kind === 'image' || DROP_KINDS[now.kind] === undefined
            || !insideCanvas(event.clientX, event.clientY)) {
            arm(false);
            hidePreviews();
            return;
        }
        arm(true);
        if (now.kind === 'text' && String(now.ext ?? '').toLowerCase() === 'docx'
            && state.graph !== null && state.graph !== undefined && selectedNode()?.type !== 'text') {
            preview?.show(now.name, event.clientX, event.clientY);
        } else {
            hidePreviews();
        }
    };
    const moveDoc = el.canvas.ownerDocument ?? globalThis.document;
    el.canvas.addEventListener('pointerenter', onEnter);
    el.canvas.addEventListener('pointerleave', onLeave);
    moveDoc?.addEventListener('pointermove', onMove);

    // 逐步留痕:接货这条路有五个判断,而**失败在任何一步的现象都一样**("松手什么都没发生")——
    // 所以每一步都写到 DOM 上(自检里读得到;页面日志只在自检抛异常时才打印,静默失败查不出来)。
    // ⚠️ 必须**只追加**(dropLog):先前只留"最后一句",于是 `applyDrop 停:…` 会被后面那句
    //    `applyDrop 回来了:…` 覆盖掉 —— 真凶当场被自己的日志埋了(实测就这么白跑了一轮)。
    const traceLines = [];
    const trace = (text) => {
        try {
            traceLines.push(text);
            if (traceLines.length > 12) traceLines.shift();
            el.canvas.dataset.dropLast = text;
            el.canvas.dataset.dropLog = traceLines.join(' | ');
        } catch { /* 写不进去就算了 */ }
    };
    const off = bus.onEnd(({ payload, clientX, clientY, insideTree }) => {
        arm(false);
        hidePreviews();
        trace(`onEnd kind=${payload?.kind ?? 'null'} insideTree=${insideTree} xy=${clientX},${clientY}`);
        // 松在树里 = 一次笔记移动(与画布无关);松在画布外 = 不关我的事
        if (insideTree === true || payload === null || payload === undefined) { trace('停:松在树里,或没有载荷'); return; }
        if (!insideCanvas(clientX, clientY)) { trace('停:落点不在画布范围内'); return; }
        if (DROP_KINDS[payload.kind] === undefined) {
            setStatus(`这种格式画布还用不了:${payload.name}(只收文本 / 视频)`);
            trace(`停:不认这种格式(${payload.kind})`);
            return;
        }
        if (payload.kind === 'image') {
            setStatus('图片不再通过拖动添加到画布；请使用图片节点的导入按钮，再右键复制节点');
            trace('停:图片拖动导入已关闭');
            return;
        }
        // ⚠️ 空路径必须**当场拒绝**:引擎按路径读盘,空路径不报错、只是读出空内容 ——
        //    于是"节点建出来了但里面什么都没有",看着像导入坏了。真正的线索是载荷里没有绝对路径。
        if (String(payload.absPath ?? '') === '') {
            setStatus(`拿不到「${payload.name}」的绝对路径(笔记库位置还没就位)—— 这次没有落地`);
            trace('停:载荷里没有绝对路径(库根没设?)');
            return;
        }
        trace(`接住:${payload.name} kind=${payload.kind} abs=${payload.absPath}`);
        void applyDrop(payload, toWorld(clientX, clientY)).then(
            () => trace(`applyDrop 回来了:${payload.name}`),
            (err) => trace(`applyDrop 抛错:${err?.message ?? err}`),
        );
    });

    return () => {
        off?.();
        el.canvas.removeEventListener('pointerenter', onEnter);
        el.canvas.removeEventListener('pointerleave', onLeave);
        moveDoc?.removeEventListener('pointermove', onMove);
        arm(false);
        hidePreviews();
    };
}

/**
 * 接住资源管理器原生拖进来的 Word 文件。
 *
 * 与 wireDrop 的区别:这里没有可信的库内路径。File.arrayBuffer() 是浏览器给的实际字节,
 * 主进程再按大小与格式复核并抽正文;渲染进程不获得、也不递交任意磁盘路径。
 */
export function wireNativeWordDrop({ ctx, el, state, nodeById, createNode, scheduleSave, setStatus, preview }) {
    const toWorld = (clientX, clientY) => {
        const rect = el.canvas.getBoundingClientRect();
        const scale = state.view.scale || 1;
        return {
            x: (Number(clientX) - rect.left - state.view.x) / scale,
            y: (Number(clientY) - rect.top - state.view.y) / scale,
        };
    };
    const filesOf = (event) => Array.from(event?.dataTransfer?.files ?? []);
    const arm = (on) => {
        if (on) el.canvas.setAttribute?.('data-drop', 'armed');
        else el.canvas.removeAttribute?.('data-drop');
    };
    const hasFiles = (event) => filesOf(event).length > 0
        || Array.from(event?.dataTransfer?.types ?? []).includes('Files');
    const reject = (message) => { preview?.hide(); setStatus(message); };
    const showPreview = (event) => {
        if (state.graph === null || state.graph === undefined) return;
        const [file] = filesOf(event);
        preview?.show(file?.name || 'Word 文件', event.clientX, event.clientY);
    };

    const onDragEnter = (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault?.();
        arm(true);
        showPreview(event);
    };
    const onDragOver = (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault?.();
        arm(true);
        showPreview(event);
    };
    const onDragLeave = (event) => {
        // 划过画布子元素时也会触发 dragleave;仍在画布内就别让投放提示闪烁。
        if (event?.relatedTarget !== null && event?.relatedTarget !== undefined
            && el.canvas.contains?.(event.relatedTarget)) return;
        arm(false);
        preview?.hide();
    };
    const onDrop = async (event) => {
        const files = filesOf(event);
        if (files.length === 0) { arm(false); preview?.hide(); return; }
        event.preventDefault?.();
        arm(false);
        if (files.length !== 1) {
            reject('一次只能拖入一个 Word(.docx) 文件');
            return;
        }
        const [file] = files;
        const name = typeof file?.name === 'string' ? file.name.trim() : '';
        if (/\.doc$/i.test(name)) {
            reject('旧版 Word(.doc)不支持；请先在 Word / WPS 中另存为 .docx');
            return;
        }
        if (!/\.docx$/i.test(name)) {
            reject('画布只支持 Word(.docx) 文件');
            return;
        }
        const size = Number(file?.size);
        if (!Number.isFinite(size) || size <= 0) {
            reject('文件为空，无法导入');
            return;
        }
        if (size > 200 * 1024) {
            reject('这个文件超过 200 KB 的导入上限；请先把不用的部分剪掉再导入');
            return;
        }
        if (typeof file.arrayBuffer !== 'function') {
            reject('浏览器没有提供这个文件的可读取字节');
            return;
        }
        try {
            preview?.reading();
            setStatus('正在读取 Word 正文…');
            const bytes = await file.arrayBuffer();
            const result = await ctx.drama.readDroppedText({ name, bytes });
            // 只有正文确实读出来之后才动图;损坏 / 超限 / 不支持都不会留下空节点。
            preview?.hide();
            const at = toWorld(event.clientX, event.clientY);
            const made = createNode('text', at.x, at.y);
            const id = typeof made === 'string' ? made : made?.id;
            const node = nodeById(id);
            if (node === null || node === undefined) {
                reject('画布还没准备好(没有打开的项目?)');
                return;
            }
            node.params = { ...(node.params ?? {}), value: result.text };
            scheduleSave();
            setStatus(`已导入 ${result.name} · ${result.chars} 字${result.note ? ` · ${result.note}` : ''}`);
        } catch (err) {
            reject(`导入失败:${err?.message ?? err}`);
        }
    };

    el.canvas.addEventListener('dragenter', onDragEnter);
    el.canvas.addEventListener('dragover', onDragOver);
    el.canvas.addEventListener('dragleave', onDragLeave);
    el.canvas.addEventListener('drop', onDrop);
    return () => {
        el.canvas.removeEventListener('dragenter', onDragEnter);
        el.canvas.removeEventListener('dragover', onDragOver);
        el.canvas.removeEventListener('dragleave', onDragLeave);
        el.canvas.removeEventListener('drop', onDrop);
        arm(false);
        preview?.hide();
    };
}

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif)$/i;

function isImageFile(file) {
    return IMAGE_EXTENSIONS.test(String(file?.name ?? ''))
        || /^image\//i.test(String(file?.type ?? ''));
}

function hasImageDrag(event) {
    return filesOf(event).some(isImageFile)
        || Array.from(event?.dataTransfer?.items ?? []).some((item) =>
            item?.kind === 'file' && /^image\//i.test(String(item.type ?? '')));
}

function filesOf(event) { return Array.from(event?.dataTransfer?.files ?? []); }

/** Block native image file drops so they cannot create nodes or open the file in the window. */
export function wireNativeImageDrop({ el, setStatus }) {
    const intercept = (event) => {
        event.preventDefault?.();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    };
    const onDragEnter = (event) => {
        if (!hasImageDrag(event)) return;
        intercept(event);
    };
    const onDragOver = (event) => {
        if (!hasImageDrag(event)) return;
        intercept(event);
        try { event.dataTransfer.dropEffect = 'none'; } catch { /* read-only DataTransfer */ }
    };
    const onDrop = (event) => {
        if (!hasImageDrag(event)) return;
        intercept(event);
        setStatus('图片不再通过拖动添加到画布；请使用图片节点的导入按钮，再右键复制节点');
    };

    el.canvas.addEventListener('dragenter', onDragEnter);
    el.canvas.addEventListener('dragover', onDragOver);
    el.canvas.addEventListener('drop', onDrop);
    return () => {
        el.canvas.removeEventListener('dragenter', onDragEnter);
        el.canvas.removeEventListener('dragover', onDragOver);
        el.canvas.removeEventListener('drop', onDrop);
    };
}
