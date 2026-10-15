// 笔记编辑器:实时预览 + 编辑/预览切换。
//
// 交互(按需求定的):
//   - 默认"实时预览":光标所在的那一块显示**源码**,其余块都是渲染好的结果;
//     离开一块就把它渲染掉 —— 也就是"该行编辑完成后直接预渲染"。
//   - 顶栏可切换到"预览":整篇只读,不再有输入框。
//   - 两种模式下都不允许编辑预览内容 —— 预览是渲染结果,不是可编辑控件。
//
// ⚠️ 块的单位是**行**(见 lib/md-blocks.js 的说明)。所以:
//   - 回车 = 在当前这一行后面新起一行(新行自己就是一块),上一行立刻渲染;
//   - ↑/↓ = 跳到上一块/下一块(块内折行了就先把光标在折行里走完);
//   - 行首退格 = 与上一行合并。没有它,按回车造出来的空行就**永远删不掉**:
//     行与行之间的换行不属于任何一块,光标进不去。
//   只有代码块与表格两种多行块例外:它们内部回车就是换行(在中间切一刀会把
//   围栏/表头切开,渲染就坏了)。
//
// 实现要点:
//   - 单容器:块在同一个滚动流里,和预览样式天然一致(不像双栏那样割裂)。
//   - 逐块替换:改一块只动那一段字符串,其余原样保留(见 md-blocks.replaceBlock),
//     所以不会重排用户原有的列表符号与缩进。
//   - textarea 自动长高,避免块内出现滚动条。
import { renderMarkdown, escapeHtml } from '../lib/markdown.js';
import {
    splitBlocks, splitTextBlocks, replaceBlock, blockIndexAt, blockIndexForCaret,
} from '../lib/md-blocks.js';
import { readFrontmatter } from '../lib/frontmatter.js';
import { mountLiveMarkdown } from '../lib/live-markdown.js';

export function createEditor({ els, resolveLink = () => true, onDirtyChange = null, log = console, liveMarkdown = false }) {
    const { rootEl } = els;

    let fullText = '';            // 含 frontmatter 的完整文件内容
    let body = '';                // 不含 frontmatter 的正文
    let blocks = [];
    let activeIndex = -1;         // 哪一块显示为源码
    let activeRange = null;       // 当前源码块在 body 里的区间(见 commitActive 的说明)
    let mode = 'live';            // 'live' | 'preview'
    /** 'markdown' | 'text'。见 load 的说明 —— 纯文本这条路上**一个 Markdown 语法都不解析**。 */
    let kind = 'markdown';
    let dirty = false;
    /**
     * 是否处于"全选整篇"态(Ctrl/Cmd+A)。
     *
     * 为什么需要一个**自己的**状态、而不是直接用浏览器选区:编辑器是块级的
     * —— 一篇笔记被切成 N 块,每一块是一个**独立 textarea**。原生 selection
     * 出不了单个 textarea,所以 Ctrl+A 走默认只选当前那一块(用户报的
     * "只能删一段")。跨块的选择在 DOM 上根本无法表达,只能自己维护。
     */
    let selectAll = false;
    let liveSurface = null;
    let liveMode = false;

    // ---------- 工具 ----------

    const setDirty = (v) => {
        if (dirty !== v) { dirty = v; onDirtyChange?.(v); }
    };

    function currentBlocks() {
        // 纯文本:一行一块,不做围栏/表格的跨行合并(那些是 Markdown 结构)
        return kind === 'text' ? splitTextBlocks(body) : splitBlocks(body);
    }

    const typeClass = (type) => `blk-type-${type || 'paragraph'}`;

    /** 用正文重建完整文件内容(frontmatter 原样保留)。 */
    function compose(nextBody) {
        // ⚠️ 纯文本**没有** frontmatter 这回事:开头写三个减号就是三个减号。
        //    这里若照 Markdown 那条路去切/拼,一篇以 `---` 开头的 txt 会被吃掉一段。
        if (kind === 'text') return nextBody;
        const { raw, hasFrontmatter } = readFrontmatter(fullText);
        if (!hasFrontmatter) return nextBody;
        // raw 是两条 --- 之间的原文,**包含**末尾换行。直接拼会多出一个空行,
        // 于是"打开再保存"就会悄悄改动用户的文件。必须去掉尾随空白再拼。
        const fm = raw.replace(/\s+$/, '');
        return fm === '' ? nextBody : `---\n${fm}\n---\n${nextBody}`;
    }

    /** 让 textarea 长到内容高度,块内不出现滚动条。 */
    function autoGrow(ta) {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
    }

    // ---------- 渲染 ----------

    function render() {
        if (!rootEl) return;
        liveMode = false;

        // 预览模式:整篇只读
        if (mode === 'preview') {
            // 纯文本的"预览"就是原文本身(等宽、保留空白),**不许**过 Markdown 渲染器:
            // 过一遍的话 `# 场景一` 会变成标题、`[[甲]]` 会变成链接 —— 那正是用户要的隔离。
            rootEl.innerHTML = (kind === 'text')
                ? `<div class="text-view">${escapeHtml(body)}</div>`
                : `<div class="md-view">${renderMarkdown(body, { resolveLink })}</div>`;
            if (kind !== 'text') bindInternalLinks();
            return;
        }

        // Markdown 笔记使用单一富文本面：格式原位渲染，也原位编辑；纯文本仍走旧的
        // textarea 路径，避免 .txt 被意外解释成 Markdown。
        if (liveMarkdown && kind === 'markdown') {
            rootEl.innerHTML = '<div class="md-live-editor md-view" data-testid="markdown-editor"></div>';
            const surface = rootEl.querySelector('.md-live-editor');
            if (surface?.replaceChildren && surface?.addEventListener) {
                liveSurface = mountLiveMarkdown(surface, body, { resolveLink, wikilinks: true, tags: true, onInput: value => {
                body = value;
                setDirty(true);
                } });
                liveMode = true;
                bindInternalLinks();
                return;
            }
        }

        blocks = currentBlocks();

        // 空笔记:一个块都没有。这时给一个"虚拟的第 0 块"——
        // 否则新建的笔记点进去只有一行提示,打不了字。
        if (blocks.length === 0) {
            if (activeIndex >= 0) {
                rootEl.innerHTML = '<div class="blk blk-active" data-blk="0">'
                    + '<textarea class="blk-input" data-blk="0" spellcheck="false"'
                    + ' rows="1"></textarea></div>';
                const ta = rootEl.querySelector('textarea.blk-input');
                if (ta) { ta.value = ''; autoGrow(ta); }
            } else {
                rootEl.innerHTML = '<div class="blk blk-blank" data-blk="0">'
                    + '<p class="hint">这篇笔记还是空的,点一下开始写。</p></div>';
            }
            return;
        }

        const parts = [];
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const cls = `blk ${typeClass(b.type)}`;
            if (i === activeIndex) {
                // 源码块:内容用 textContent 赋值,避免把源码里的 HTML 当标记解析
                parts.push(
                    `<div class="${cls} blk-active" data-blk="${i}">`
                    + `<textarea class="blk-input" data-blk="${i}" spellcheck="false" `
                    + `rows="${Math.max(1, b.text.split('\n').length)}"></textarea></div>`,
                );
            } else if (b.type === 'blank') {
                // 空行也要有可点的高度(`<br>` 撑出一行),否则鼠标点不到它,
                // 光标也就放不上去 —— 空行本身也是一个块。
                parts.push(`<div class="${cls}" data-blk="${i}"><br></div>`);
            } else if (kind === 'text') {
                // 纯文本的"渲染结果"就是它自己:原样、等宽、保留空白。
                // ⚠️ 必须走 escapeHtml —— 用户的 txt 里可能有 `<img onerror=...>`,
                //    直接拼进 innerHTML 就是一次注入(与 Markdown 那条路的纪律一致)。
                parts.push(
                    `<div class="${cls} blk-plain" data-blk="${i}">${escapeHtml(b.text)}</div>`,
                );
            } else {
                parts.push(
                    `<div class="${cls}" data-blk="${i}">${
                        renderMarkdown(b.text, { resolveLink })}</div>`,
                );
            }
        }
        rootEl.innerHTML = parts.join('');

        const ta = rootEl.querySelector('textarea.blk-input');
        if (ta) {
            ta.value = blocks[activeIndex]?.text ?? '';
            autoGrow(ta);
        }
        if (kind !== 'text') bindInternalLinks();
    }

    /** 预览里的 wiki 链接 / 标签点击。 */
    function bindInternalLinks() {
        for (const a of rootEl.querySelectorAll('a.wikilink')) {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const target = a.dataset.note;
                onLinkClick?.(target);
            });
        }
    }

    let onLinkClick = null;

    // ---------- 焦点与切换 ----------

    /** 把焦点放进当前源码块,并把光标放到指定位置(不给就放到末尾)。 */
    function focusActive(caret) {
        const ta = rootEl?.querySelector('textarea.blk-input');
        if (!ta) return;
        ta.focus();
        const at = typeof caret === 'number'
            ? Math.max(0, Math.min(caret, ta.value.length))
            : ta.value.length;
        ta.setSelectionRange(at, at);
    }

    /**
     * 把某一块变成"源码态"。
     * 抽出来是因为它有三个触发源:鼠标点(click)、键盘聚焦(focusin)、
     * 以及键位处理(回车/方向键之后重新定位)。
     * 早先只挂了 mousedown,结果自动化用 element.click() 时不会触发 ——
     * 排查起来会以为"点了没反应"。
     *
     * @param {number} idx
     * @param {number|null} [caret] 光标落点(块内偏移)。不给就放行尾 ——
     *   鼠标点进来时会传"点到的那一格",这样单击一次就落在那儿,不用再点第二次。
     */
    function activateBlock(idx, caret = null) {
        if (mode === 'preview') return;
        // 切块本身就是一个"其它动作":先把全选态收掉,否则用户点开另一块之后
        // 再按退格会删掉整篇,而屏幕上并没有任何"全选着"的痕迹。
        if (selectAll) setSelectAll(false);
        // 空笔记时允许激活"虚拟的第 0 块"
        const emptyDoc = blocks.length === 0;
        if (idx < 0) return;
        if (emptyDoc ? idx !== 0 : idx >= blocks.length) return;
        if (!emptyDoc && idx === activeIndex) return;

        commitActive();                    // 先把上一块的改动落回 body
        activeIndex = idx;
        // 记下区间 —— commitActive 依赖它(见那里的说明)
        activeRange = emptyDoc ? { start: 0, end: 0 } : { ...blocks[idx] };
        render();
        focusActive(caret);
    }

    /**
     * 光标放到 body 里的某个**绝对偏移**处,并激活它所在的那一块。
     *
     * 回车 / 方向键 / 合并行都走这条路。它们都会改动 body,所以必须
     * **重新切分之后**再定位 —— 拿改动前的 blocks 下标去激活会错位
     * (这正是"改一块却动了另一块"那类 bug 的来源)。
     */
    function activateAtOffset(offset, caretInBlock = null) {
        blocks = currentBlocks();
        let idx = blockIndexAt(blocks, offset);
        if (idx === -1) idx = blockIndexForCaret(blocks, offset);
        if (idx === -1) {                  // 空文档:虚拟块
            activeIndex = 0;
            activeRange = { start: 0, end: 0 };
            render();
            focusActive(caretInBlock);
            return;
        }
        activeIndex = idx;
        activeRange = { ...blocks[idx] };
        render();
        focusActive(caretInBlock);
    }

    rootEl?.addEventListener('focusin', (e) => {
        if (mode === 'preview') return;
        const ta = e.target.closest?.('textarea.blk-input');
        if (!ta) return;
        activateBlock(Number(ta.dataset.blk));
    });

    // 焦点离开正文根节点 = 点到侧栏 / 标题框 / 别的面板去了 → 退出全选态。
    // 这是"点别处"那条的兜底:点在根节点**外面**时,上面的 mousedown 收不到事件。
    // 用 relatedTarget 判断而不是"收到 focusout 就退":块与块之间挪焦点仍在这个
    // 根节点里面,那条路由 activateBlock 管,不在这里重复处理。
    rootEl?.addEventListener('focusout', (e) => {
        if (!selectAll) return;
        const next = e.relatedTarget;
        if (next && typeof rootEl.contains === 'function' && rootEl.contains(next)) return;
        setSelectAll(false);
    });

    // ---------- 点选 / 拖选 ----------
    //
    // 三种输入必须分开 —— 用户报的"点一次只是选中了文本区、要连点两次才能编辑"
    // 与"拖选只能选中一行"是同一个根因:旧实现把 `mousedown` 直接接到"激活这一块",
    // 于是指针一按下,DOM 就在指针底下被换成 textarea:
    //   ① 原生选择被就地掐断 → 拖选永远落在一行里,复制不了一整段;
    //   ② 浏览器随后的默认聚焦落在**已经被替换掉**的那个元素上 → 光标其实没进
    //      输入框,用户不得不再点一次。
    // 现在:`mousedown` 只记位置;真拖动(超过阈值)就一路保持渲染态,把选择交给浏览器;
    // 松手后的那一次 `click` 才激活目标块,并把光标落在点到的字符附近。
    const DRAG_THRESHOLD_PX = 4;
    /** 上一次按下鼠标的信息。null = 这次 click 不是鼠标点出来的(自动化只发 click)。 */
    let pointerDown = null;

    const inTextarea = (e) => Boolean(e.target?.closest?.('textarea.blk-input'));
    const inWikilink = (e) => Boolean(e.target?.closest?.('a.wikilink'));

    /**
     * "点到的位置"对应这一块**渲染文本**里的第几个字符。
     * 拿不到(测试替身 / 老浏览器 / 点在块外)时返回 null,调用方退回"光标放行尾"。
     */
    function renderedOffsetAt(x, y, blockEl) {
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        if (typeof document.createTreeWalker !== 'function') return null;
        let point = null;
        if (typeof document.caretRangeFromPoint === 'function') {
            const r = document.caretRangeFromPoint(x, y);
            if (r) point = { node: r.startContainer, offset: r.startOffset };
        } else if (typeof document.caretPositionFromPoint === 'function') {
            const p = document.caretPositionFromPoint(x, y);
            if (p) point = { node: p.offsetNode, offset: p.offset };
        }
        if (point === null || point.node === null || point.node === undefined) return null;
        if (typeof blockEl.contains === 'function' && !blockEl.contains(point.node)) return null;

        let rendered = 0;
        const walker = document.createTreeWalker(blockEl, 4 /* NodeFilter.SHOW_TEXT */);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
            if (n === point.node) { rendered += point.offset; break; }
            rendered += String(n.nodeValue ?? '').length;
        }
        return rendered;
    }

    /**
     * 把"渲染文本里的偏移"换成"这一块**源码**里的偏移"。
     *
     * 渲染会吃掉两类字符:标题前缀(`# `)与行内标记(`**`、`[[…]]` 之类)。
     * 前缀总在最前面、长度确定,补上;行内标记让渲染偏移**偏小**,所以最坏是
     * "光标落在点到的地方前面几个字符",不会甩到行尾 —— 这是有意的取舍:
     * 要做到字符级精确,得让渲染器额外产出"渲染位置 ↔ 源码位置"的映射,
     * 那是另一件事(md-blocks / markdown 的职责),不在这里假装能做到。
     */
    function sourceCaretOffset(x, y, blockEl, sourceText) {
        const rendered = renderedOffsetAt(x, y, blockEl);
        if (rendered === null) return null;
        const source = String(sourceText ?? '');
        const prefix = /^#{1,6} /.exec(source)?.[0].length ?? 0;
        return Math.min(rendered + prefix, source.length);
    }

    function onPointerDown(e) {
        if (mode === 'preview') return;
        // 任何一次指针按下都是"用户去干别的了" → 退出全选态。
        // 放在 button 判断**之前**:右键点开上下文菜单同样算"点了别处"。
        // (点到别的地方的 DOM 之外时,由下面的 focusout 兜底。)
        if (selectAll) setSelectAll(false);
        if (e.button !== undefined && e.button !== 0) return;      // 只认左键
        pointerDown = { x: e.clientX ?? 0, y: e.clientY ?? 0, dragging: false };
    }

    function onPointerMove(e) {
        if (pointerDown === null || pointerDown.dragging) return;
        const dx = Math.abs((e.clientX ?? 0) - pointerDown.x);
        const dy = Math.abs((e.clientY ?? 0) - pointerDown.y);
        // 超过阈值就是"在拖选",不是"在点"。4px 是常见手感值:手抖一下不算拖。
        if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) pointerDown.dragging = true;
    }

    /**
     * 松手后的那一次 click。
     *
     * 拖过就什么都不做 —— 那一次选择正是用户要的(可以跨行、可以复制);
     * 没拖才激活目标块。自动化只发 click(没有 mousedown),那时 `pointerDown`
     * 是 null,同样按"没拖"处理。
     */
    function onBlockClick(e) {
        const wasDrag = pointerDown?.dragging === true;
        pointerDown = null;
        if (mode === 'preview') return;
        if (liveMode) return;
        if (wasDrag) return;                                       // 拖选:保留选择
        if (inTextarea(e)) return;                                 // 点在输入框里,浏览器自己放光标
        if (inWikilink(e)) return;                                 // 点在 wiki 链接上,交给链接

        const blk = e.target.closest?.('.blk');
        if (blk) {
            const idx = Number(blk.dataset.blk);
            const source = blocks[idx]?.text ?? '';
            activateBlock(idx, sourceCaretOffset(e.clientX, e.clientY, blk, source));
            return;
        }

        // 点到容器空白 → 收起当前块(退出编辑,让它渲染掉)
        if (activeIndex !== -1) { commitActive(); activeIndex = -1; activeRange = null; render(); }
    }

    rootEl?.addEventListener('mousedown', onPointerDown);
    rootEl?.addEventListener('mousemove', onPointerMove);
    rootEl?.addEventListener('click', onBlockClick);

    /**
     * 把当前源码输入框里的内容落回 body,并**同步区间**。
     *
     * ⚠️ 同步区间这一步不能省。区间是"激活这一块时"记下来的,而用户一打字,
     * body 里那一段就变长了;若还拿旧区间去替换,多出来的尾巴会被再写一遍。
     * 实测症状(修之前):每次 input 都多一个字符、每次 value()(自动保存会调它)
     * 都再追加一份重复的尾巴 —— 而当时的自检只断言 `includes('自检追加。')`,
     * 所以它一路"通过"。见 tests/editor.test.js 里那两条对照用例。
     */
    function applyActiveText(text) {
        if (activeIndex === -1 || activeRange === null) return;
        const value = String(text ?? '');
        body = replaceBlock(body, activeRange, value);
        activeRange = { start: activeRange.start, end: activeRange.start + value.length };
    }

    rootEl?.addEventListener('input', (e) => {
        const ta = e.target?.closest?.('textarea.blk-input');
        if (!ta) return;
        autoGrow(ta);
        const idx = Number(ta.dataset.blk);
        if (idx !== activeIndex) return;
        if (activeRange === null) return;
        // 立刻把块内容写回 body,这样"有未保存改动"是实时的
        applyActiveText(ta.value);
        setDirty(true);
    });

    /**
     * 提交当前块(通常没必要单独调:input 已经实时写回了)。
     * 留着它是因为"程序化改过 textarea.value"这条路径不走 input 事件。
     */
    function commitActive() {
        if (activeIndex === -1 || activeRange === null) return;
        const ta = rootEl?.querySelector('textarea.blk-input');
        if (!ta) return;
        applyActiveText(ta.value);
    }

    // ---------- 全选整篇(Ctrl/Cmd+A)----------
    //
    // 用户报的 bug:"我无法按 Ctrl+A 全选删除,只能删一段"。根因不是没绑键位,
    // 而是**键位绑错了层**:这个编辑器是块级的,一"段"= 一个块 = 一个独立 textarea,
    // 浏览器的 Ctrl+A 只能选中**当前 textarea 里的内容**,于是永远只删得掉一块。
    // 跨块的选区在 DOM 上不存在,所以"全选整篇"只能在编辑器这一层自己实现:
    // 一个状态 + 一条视觉提示,键位在这里裁决。
    //
    // 边界(用户明确要求"不要越界"):这一组的入口只认 `textarea.blk-input`,
    // 而本模块的 keydown 只挂在正文根节点(`.note-doc`)上。标题框(#noteTitle)、
    // 改名输入框、搜索框、标签条全在这个根节点**之外**(见 app/index.html),
    // 它们的事件根本走不到这里 —— 那几处的 Ctrl+A 仍是浏览器原生"选中自己那一格"。
    // 也正因为如此,这里绝不能改成 document/全局监听。

    /**
     * 进入/退出全选态。
     *
     * 为什么把状态**同时**写到根节点的 `data-select-all` 属性上,而不是只留一个变量:
     *   · render() 只重写 rootEl 的 innerHTML,挂在 rootEl 自己身上的属性不会丢,
     *     不必每次重画后再补一遍标(块是重画的,逐个加类最容易漏一个);
     *   · 一条 `.note-doc[data-select-all="1"] .blk{…}` 就能把整篇所有的块描出来;
     *   · 它同时是**外部可读的唯一真相** —— 单测与真窗口自检读这个属性(或
     *     isSelectAll())即可,不必去猜内部变量。
     *
     * 视觉上只用**底色 + 左侧色条**表达"整篇被选中":跨块选区画不出来,那就让
     * 每一个块看起来都被罩住,合起来就是"整篇选中"。不引入任何图标/svg ——
     * 这个项目不喜欢图标,而选中态本来也不是"一个图标"能表达的东西。
     */
    function setSelectAll(next) {
        const v = Boolean(next);
        if (selectAll === v) return;              // 幂等:重复进入/退出不该有副作用
        selectAll = v;
        if (!rootEl || typeof rootEl.setAttribute !== 'function') return;   // 单测里的最小替身
        if (v) rootEl.setAttribute('data-select-all', '1');
        else if (typeof rootEl.removeAttribute === 'function') rootEl.removeAttribute('data-select-all');
    }

    /**
     * Ctrl/Cmd+A:进入全选整篇态。
     *
     * 顺手把当前块的 textarea 原生选区也扩到整块:一来 Ctrl+C 至少能复制当前这一块
     * (跨块复制做不到,理由同上),二来当前块会带上系统级的选中底色,与整篇高亮
     * 叠在一起,用户一眼就知道"这一下真的选中了东西"。
     */
    function enterSelectAll() {
        commitActive();          // 先把输入框里的内容落回 body:高亮的和要删的必须是同一份内容
        setSelectAll(true);
        const ta = rootEl?.querySelector('textarea.blk-input');
        if (ta && typeof ta.setSelectionRange === 'function') {
            ta.setSelectionRange(0, ta.value.length);
        }
    }

    /**
     * 整篇清空:留一篇空笔记(一个空块,光标在里面,可以接着写)。
     *
     * 清的是**正文**(body):带 frontmatter 的 .md 清完之后 frontmatter 仍在
     * ——那是 compose 的既有语义(元数据不是正文,"全选删除"删的是用户看得见的正文)。
     */
    function clearAll() {
        commitActive();
        body = '';
        // ⚠️ 必须标脏:这个编辑器是自动保存的,脏标记才是"该写盘"的信号
        //    (见 notes-view 的 onDirtyChange → AUTOSAVE_MS)。少了它,用户会觉得
        //    "屏幕上删干净了",磁盘上却一个字没动。
        setDirty(true);
        setSelectAll(false);
        // 走"空文档"那条路:activeIndex=0 + 空区间 → render 给出虚拟第 0 块,
        // 于是删完整篇立刻就能接着写,而不是留下一屏"点一下开始写"的提示。
        activeIndex = 0;
        activeRange = { start: 0, end: 0 };
        blocks = currentBlocks();
        render();
        focusActive(0);
    }

    /** 全选态下打字 = 覆盖整篇(与系统里"全选之后打字"的语义一致)。 */
    function replaceAll(text) {
        commitActive();
        body = String(text ?? '');
        setDirty(true);
        setSelectAll(false);
        blocks = currentBlocks();
        activeIndex = 0;
        // 区间取"重新切分后第 0 块"的真实区间。自己凑一个 {0, len} 在
        // body 里有换行/多块时会和真实块对不上,下一次 input 就会错位替换。
        activeRange = blocks.length > 0 ? { ...blocks[0] } : { start: 0, end: 0 };
        render();
        focusActive(body.length);                      // 光标落在新内容末尾,和原生一致
    }

    /**
     * 全选态下按一个键的裁决。返回 true = 这一下已经被消化掉。
     *
     * 只有三条规则,其余一律"退出全选态,再把这一下原样还回去":
     *   ① 退格 / 删除 → 整篇清空;
     *   ② 单个可打印字符 → 覆盖整篇;
     *   ③ 其它键 → 退出全选态。
     *
     * ③ 是**有意**的:绝不能留下"看不见的全选态" —— 否则用户下次按退格会
     * 莫名其妙删掉整篇,而屏幕上没有任何提示。用户原话里的"任何其它动作
     * (点别处、切块、Esc、切笔记)"就是这一条。
     */
    function handleSelectAllKey(e) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            clearAll();
            return true;
        }
        // "可打印字符"的判据:e.key 恰好一个字符、且不带 Ctrl/Meta/Alt
        // (Shift 算 —— 大写字母和符号都是可打印的)。'Enter'/'ArrowUp'/
        // 'Escape'/'F5' 这些长度都不是 1,自然落到 ③。
        if (!e.ctrlKey && !e.metaKey && !e.altKey
            && typeof e.key === 'string' && e.key.length === 1) {
            e.preventDefault();
            replaceAll(e.key);
            return true;
        }
        // Esc 这一下**不** preventDefault:上层拿它关面板/退出编辑的行为照旧,
        // 这里只是不再假装"整篇还选着"。
        setSelectAll(false);
        return false;
    }

    // ---------- 键位:回车换行 / 上下跳块 / 合并行 ----------

    /** 当前源码块的类型。 */
    const activeType = () => blocks[activeIndex]?.type ?? null;

    /** 代码块与表格是"多行块",内部回车就是普通换行,不能在中间切一刀。 */
    const isMultiLineBlock = () => {
        const t = activeType();
        return t === 'code' || t === 'table';
    };

    /**
     * 回车:把光标移到**下一块的开头**;下一块不存在时新起一行。
     *
     * 两条规则合起来才是用户要的手感:
     *   1. 光标处后面已经是个换行(也就是光标已经在行尾)→ 不插新换行,直接落到
     *      下一行。否则每按一次回车都会多出一个空行。
     *   2. 光标在行中间 → 把这一行从光标处切开,后半截成为下一块。
     * 无论哪条,原光标所在的那一行都不再是"源码态",于是立刻渲染出来 ——
     * 这正是"按了回车不渲染、还得用鼠标点一下"那个问题的修法。
     */
    function insertLineBreak(ta) {
        const pos = ta.selectionStart ?? ta.value.length;
        // 先把输入框里已有的内容落回 body(可能还没触发过 input,比如粘贴多行)
        applyActiveText(ta.value);
        const abs = activeRange.start + pos;
        if (body[abs] !== '\n') {
            body = body.slice(0, abs) + '\n' + body.slice(abs);
            setDirty(true);
        }
        activateAtOffset(abs + 1, 0);       // 光标落在下一行的行首
    }

    /**
     * 行首退格:把这一行并回上一行(删掉它们之间那个换行)。
     * 必须自己实现:行与行之间的换行不属于任何一块,textarea 里退格退不出块,
     * 于是空行永远删不掉。
     */
    function mergeWithPrev(ta) {
        if (activeIndex <= 0) return false;
        applyActiveText(ta.value);
        const seam = activeRange.start - 1;      // 被删掉的那个换行
        if (seam < 0 || body[seam] !== '\n') return false;
        body = body.slice(0, seam) + body.slice(seam + 1);
        setDirty(true);
        activateAtOffset(seam, null);            // 光标停在接缝(上一行末尾)
        return true;
    }

    /** 行尾 Delete:把下一行并上来。与行首退格对称。 */
    function mergeWithNext(ta, pos) {
        applyActiveText(ta.value);
        const abs = activeRange.end;         // 这一行的新末尾
        if (body[abs] !== '\n') return false;
        body = body.slice(0, abs) + body.slice(abs + 1);
        setDirty(true);
        activateAtOffset(abs, pos);              // 光标停在原处
        return true;
    }

    /** 行高(px);拿不到就按字号估一个。 */
    function lineHeightOf(ta) {
        if (typeof getComputedStyle !== 'function') return 0;   // 单测里的 DOM 替身
        const cs = getComputedStyle(ta);
        const lh = parseFloat(cs.lineHeight);
        if (lh > 0) return lh;
        const fs = parseFloat(cs.fontSize);
        return fs > 0 ? fs * 1.5 : 0;
    }

    /** 这一块在视觉上占几行(长行会折行,1 个逻辑行可能占好几行)。 */
    function blockVisualRows(ta) {
        const lh = lineHeightOf(ta);
        if (!(lh > 0)) return 1;
        const cs = getComputedStyle(ta);
        const inner = ta.clientHeight
            - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
        return Math.max(1, Math.round(inner / lh));
    }

    // 量"光标在第几个视觉行"用的镜像元素。为什么要量:块是"一行",但一行在
    // textarea 里可能折成好几行 —— 那时按 ↓ 该先在折行内移动,而不是一按就跳走。
    let mirrorEl = null;

    function visualRowOfCaret(ta, pos) {
        try {
            if (typeof getComputedStyle !== 'function' || !document.body) return null;
            const cs = getComputedStyle(ta);
            const lh = lineHeightOf(ta);
            const width = ta.clientWidth
                - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
            if (!(lh > 0) || !(width > 0)) return null;

            if (!mirrorEl) {
                mirrorEl = document.createElement('div');
                mirrorEl.setAttribute('aria-hidden', 'true');
            }
            mirrorEl.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;'
                + 'pointer-events:none;margin:0;padding:0;border:0;'
                + `white-space:${cs.whiteSpace || 'pre-wrap'};`
                + `overflow-wrap:${cs.overflowWrap || 'break-word'};`
                + `word-break:${cs.wordBreak || 'break-word'};`
                + `font:${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily};`
                + `letter-spacing:${cs.letterSpacing};width:${width}px;`;
            mirrorEl.textContent = ta.value.slice(0, pos);
            const marker = document.createElement('span');
            marker.textContent = '\u200b';
            mirrorEl.appendChild(marker);
            if (!mirrorEl.isConnected) document.body.appendChild(mirrorEl);

            const row = Math.round(marker.offsetTop / lh);
            return Number.isFinite(row) ? row : null;
        } catch {
            return null;               // 量不出来就当作"没折行",不要让键位失效
        }
    }

    /** 光标是否已经在块的边缘那一行(是的话方向键就可以跳出这一块)。 */
    function caretAtBlockEdge(ta, direction) {
        const rows = blockVisualRows(ta);
        if (rows <= 1) return true;
        const row = visualRowOfCaret(ta, ta.selectionStart ?? 0);
        if (row === null) return true;
        return direction > 0 ? row >= rows - 1 : row <= 0;
    }

    /** 跳到相邻块;没有就什么都不做(让浏览器自己处理)。 */
    function moveBlock(delta, ta) {
        // 行级块里 selectionStart 就是列号,拿它当"目标块里的落点"
        const col = ta.selectionStart ?? 0;
        commitActive();
        const target = activeIndex + delta;
        blocks = currentBlocks();
        if (target < 0 || target >= blocks.length) return;
        activeIndex = target;
        activeRange = { ...blocks[target] };
        render();
        focusActive(col);
    }

    function onKeyDown(e) {
        if (mode === 'preview') return;
        if (liveMode) return;
        const ta = e.target?.closest?.('textarea.blk-input');
        if (!ta) return;
        // 中文输入法组字期间的回车是"选词",绝不能当成换行
        if (e.isComposing || e.keyCode === 229) return;

        // Ctrl/Cmd+A(不带 Alt):在**正文块**里 = 全选整篇,而不是只选当前这一块。
        // 放在最前面:这一下必须压过 textarea 自己的"全选本框内容"。
        if ((e.ctrlKey || e.metaKey) && !e.altKey
            && String(e.key).toLowerCase() === 'a') {
            e.preventDefault();
            enterSelectAll();
            return;
        }

        // 全选态下的按键先由上面那三条规则裁决 —— 否则会漏给"单块"的默认行为
        // (比如 Delete 只删掉当前块里那几个字符,而用户以为自己选中了整篇)。
        if (selectAll && handleSelectAllKey(e)) return;

        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const pos = ta.selectionStart ?? 0;
        const collapsed = pos === (ta.selectionEnd ?? pos);

        if (e.key === 'Enter' && !e.shiftKey) {
            if (isMultiLineBlock()) return;      // 代码块/表格内部:普通换行
            e.preventDefault();
            insertLineBreak(ta);
            return;
        }

        if (e.key === 'ArrowDown' && !e.shiftKey) {
            if (caretAtBlockEdge(ta, 1)) { e.preventDefault(); moveBlock(1, ta); }
            return;
        }

        if (e.key === 'ArrowUp' && !e.shiftKey) {
            if (caretAtBlockEdge(ta, -1)) { e.preventDefault(); moveBlock(-1, ta); }
            return;
        }

        if (e.key === 'Backspace' && collapsed && pos === 0) {
            if (mergeWithPrev(ta)) e.preventDefault();
            return;
        }

        if (e.key === 'Delete' && collapsed && pos === ta.value.length) {
            if (mergeWithNext(ta, pos)) e.preventDefault();
        }
    }
    rootEl?.addEventListener('keydown', onKeyDown);

    // ---------- 对外接口 ----------

    return {
        /**
         * 载入一篇笔记的内容。
         *
         * @param {string} text 磁盘上的原文(.md 含 frontmatter;.txt 就是全部内容)
         * @param {{kind?:'markdown'|'text'}} [options] `kind:'text'` = **纯文本模式**:
         *        不切 frontmatter、不按 Markdown 渲染任何一块、不解析 [[链接]] 与 #标签。
         *        用户这一轮的明确要求:"可编辑,但和 Markdown 隔开"。
         */
        load(text, options = {}) {
            kind = options.kind === 'text' ? 'text' : 'markdown';
            fullText = String(text ?? '');
            // 纯文本**没有** frontmatter:整份原文就是正文(见 compose 的说明)。
            body = kind === 'text' ? fullText : readFrontmatter(fullText).body;
            liveSurface = null;
            activeIndex = -1;
            activeRange = null;
            // 换了一篇笔记 = 上一个"全选整篇"必须作废 —— 否则用户切过来按退格
            // 会把新的一篇整篇删掉,而屏幕上什么提示都没有。
            setSelectAll(false);
            setDirty(false);
            render();
        },

        /** 当前应写盘的内容(含 frontmatter)。幂等,调用它不会改变内容。 */
        value() {
            commitActive();
            if (liveMode && liveSurface) body = liveSurface.value();
            return compose(body);
        },

        /** 当前在编的是哪一类('markdown' | 'text')。 */
        getKind: () => kind,

        /** 切模式。'live' 实时预览编辑;'preview' 只读预览。 */
        setMode(next) {
            commitActive();
            activeIndex = -1;
            activeRange = null;
            setSelectAll(false);      // 切模式同样是"其它动作":不留隐形的全选态
            mode = next;
            render();
            return mode;
        },
        getMode: () => mode,

        /**
         * 当前是否处于"全选整篇"态(Ctrl/Cmd+A 之后、还没被任何动作打断)。
         * 只读出口:单测与真窗口自检靠它(以及根节点上的 data-select-all 属性)
         * 判断状态,不必去猜内部变量。
         */
        isSelectAll: () => selectAll,

        /** 让光标进入第一块(用户想直接开始写)。空笔记也走同一条路。 */
        focusFirst() {
            if (mode === 'preview') return;
            if (liveMode) { liveSurface?.focus(); return; }
            activateBlock(0);
        },

        isDirty: () => dirty,
        markClean: () => setDirty(false),
        getBody: () => body,
        render,
        /** 供宿主绑定 wiki 链接点击。 */
        setLinkHandler(fn) { onLinkClick = fn; },
    };
}
