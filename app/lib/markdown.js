// 最小 Markdown 渲染子集。纯函数,可直接 node --test。
//
// 为什么不引 markdown-it:先把界面跑起来,接口留成可替换的
// (设计文档 §4.3 已记:不足时换实现,调用方不用改)。
//
// ⚠️ **安全**:这是一条注入边界,两个使用方都不可信(笔记正文、模型输出)。
// 规则:**先转义,再做标记替换** —— 绝不让原文里的 < > & 以标签形式落地。
// wiki 链接的 href 也只用我们自己的 data-note 属性,不做 URL 拼接。
//
// 结构:解析与输出**分开**,因为同一套解析要喂两个输出端 ——
//   · renderMarkdown(md)         → HTML 字符串(笔记预览塞 innerHTML 用)
//   · renderMarkdownNodes(doc, md) → **DOM 节点**(对话面板用:那里一个 innerHTML 都不出现)
// 两条路各写一遍解析,"改一处要改两处"是迟早出错的;AST 让规则只有一份。
//
// 支持:标题 / 粗体 / 斜体 / 行内代码 / 围栏代码 / 无序与有序列表 /
//       引用 / 分隔线 / 表格 / [[wiki 链接]] / #标签

/** HTML 转义。所有进入输出的原文都必须先过这里。 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------- 行内解析 ----------
//
// 行内标记规则按**优先级**排列,扫描时取"起点最靠前"的那一条(同一起点按这个顺序)。
// ⚠️ 与旧实现的等价性:旧实现是"先把行内代码抠成占位符,再依次做替换",所以
//   代码里的 * 不会被当成强调、而代码/链接可以出现在粗体**里面**。扫描式解析保持同样的结果。
// ⚠️ 带 lead 的规则(强调、标签)前面那个字符属于**正文**(比如 `a *b*` 里的空格),
//   所以它要被当文字发出去、而不是随标记一起吃掉。
const INLINE_RULES = [
    { kind: 'code', re: /`([^`\n]+)`/ },
    { kind: 'wikilink', re: /(!?)\[\[([^\[\]\n]+)\]\]/ },
    { kind: 'tag', re: /(^|[\s(])#([^\s#,，。、；;：:（）()\[\]{}"'`&]+)/, lead: 1 },
    { kind: 'strong', re: /\*\*([^*\n]+)\*\*/ },
    { kind: 'em', re: /(^|[^*\w])\*([^*\n]+)\*/, lead: 1 },
    // ⚠️ 图片必须排在链接**前面**:`![alt](url)` 里也含 `[alt](url)`,让链接先匹配的话
    // `!` 会被当成字面文字、后半截变成普通链接 —— 用户看到的正是"一个带感叹号的链接",
    // 图永远出不来(实测踩过)。只认 http(s):`javascript:` / `data:` 一律不成立。
    { kind: 'image', re: /!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/ },
    { kind: 'link', re: /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/ },
    // 裸地址。模型不一定记得写 Markdown —— 实测它两次用了两种写法:
    // 一次 `![图](url)`,一次直接贴 `https://…png`。不认裸地址的话,第二次就什么都不显示。
    // 末尾的中英文标点要在处理时裁掉(否则会把句号吃进 URL)。
    { kind: 'bare', re: /https?:\/\/[^\s<>()"'`，。、；：！？]+/ },
];

/**
 * 把一行文本解析成行内节点序列。
 * @returns {Array<object>} 节点:text / code / strong / em / link / wikilink / tag
 */
function parseInline(src, options = {}) {
    const wikilinks = options.wikilinks !== false;
    const tags = options.tags !== false;
    const resolveLink = options.resolveLink ?? options.noteExists ?? null;
    const nodes = [];
    const pushText = (t) => { if (t !== '') nodes.push({ type: 'text', text: t }); };

    let rest = String(src ?? '');
    // 纯防御:规则本身都要求内容非空,不会真的转不停
    let guard = 0;
    while (rest !== '' && guard++ < 5000) {
        let best = null;
        for (const rule of INLINE_RULES) {
            if (rule.kind === 'wikilink' && !wikilinks) continue;
            if (rule.kind === 'tag' && !tags) continue;
            const m = rule.re.exec(rest);
            if (m === null) continue;
            const at = m.index + (rule.lead ?? 0);
            if (best === null || at < best.at) best = { rule, m, at };
        }
        if (best === null) { pushText(rest); break; }

        pushText(rest.slice(0, best.m.index));
        const lead = best.rule.lead ?? 0;
        if (lead > 0) pushText(best.m[1]);

        const m = best.m;
        if (best.rule.kind === 'code') {
            nodes.push({ type: 'code', text: m[1] });
        } else if (best.rule.kind === 'strong') {
            nodes.push({ type: 'strong', children: parseInline(m[1], options) });
        } else if (best.rule.kind === 'em') {
            nodes.push({ type: 'em', children: parseInline(m[2], options) });
        } else if (best.rule.kind === 'link') {
            nodes.push({ type: 'link', text: m[1], url: m[2] });
        } else if (best.rule.kind === 'image') {
            nodes.push({ type: 'image', alt: m[1], url: m[2] });
        } else if (best.rule.kind === 'bare') {
            // 裁掉末尾标点,再把它们**还回正文** —— 扫描器已经把它整段吃掉了,
            // 不还回去的话"图在 https://…png。后面还有字"里的句号会消失。
            const raw = m[0];
            const url = raw.replace(/[.,;:!?、。]+$/, '');
            const isImage = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(url);
            nodes.push(isImage ? { type: 'image', alt: '', url } : { type: 'link', text: url, url });
            pushText(raw.slice(url.length));
        } else if (best.rule.kind === 'tag') {
            nodes.push({ type: 'tag', text: `#${m[2]}` });
        } else {
            // [[目标|别名]] / [[目标#小节]] / ![[目标]]
            let core = m[2];
            let alias = null;
            const pipe = core.lastIndexOf('|');
            if (pipe !== -1) { alias = core.slice(pipe + 1).trim(); core = core.slice(0, pipe); }
            const hash = core.indexOf('#');
            const caret = core.indexOf('^');
            let cut = -1;
            if (hash !== -1 && (caret === -1 || hash < caret)) cut = hash;
            else if (caret !== -1) cut = caret;
            const target = (cut === -1 ? core : core.slice(0, cut)).trim();
            const label = alias !== null && alias !== '' ? alias : target;
            nodes.push({
                type: 'wikilink',
                target,
                label,
                bang: m[1] === '!',
                missing: resolveLink ? !resolveLink(target) : true,
            });
        }
        rest = rest.slice(m.index + m[0].length);
    }
    return nodes;
}

// ---------- 块级解析 ----------

/**
 * 解析成中间结构(纯数据,可直接 JSON.stringify —— 里面没有节点、没有函数)。
 * @param {string} markdown
 * @param {{resolveLink?:Function, noteExists?:Function, wikilinks?:boolean, tags?:boolean, tables?:boolean}} [options]
 * @returns {Array<object>} 块节点
 */
export function parseMarkdown(markdown, options = {}) {
    const src = String(markdown ?? '');
    if (src.trim() === '' && !options.preserveBlankLines) return [];
    const tables = options.tables !== false;
    const lines = src.split('\n');
    const blocks = [];
    let i = 0;

    const inline = (text) => parseInline(text, options);

    const flushList = (ordered) => {
        const items = [];
        const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        while (i < lines.length) {
            const m = re.exec(lines[i]);
            if (!m) break;
            items.push(inline(m[1]));
            i++;
        }
        blocks.push({ type: 'list', ordered, items });
    };

    while (i < lines.length) {
        const line = lines[i];

        // 围栏代码块
        const fence = /^\s*(```+|~~~+)\s*([^\s]*)\s*$/.exec(line);
        if (fence) {
            const marker = fence[1][0];
            const body = [];
            i++;
            while (i < lines.length) {
                const end = new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i]);
                if (end) { i++; break; }
                body.push(lines[i]);
                i++;
            }
            // 代码内容整体当字面文字,不做任何标记解析
            blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
            continue;
        }

        // 分隔线(必须在列表之前判断,否则 --- 会被当成列表项)
        if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
            blocks.push({ type: 'hr' });
            i++;
            continue;
        }

        // 标题。
        // ⚠️ 正文用 `(.*?)` 而不是 `(.+?)`:CommonMark 里「井号 + 空白 + 什么都没有」
        //    是一个**空标题**(`# ` → `<h1></h1>`),而 `(.+?)` 要求至少一个字符、匹配不上 ——
        //    于是这一行会掉到下面"段落"那段被它的**块起始终止判据**(`#{1,6}\s`)拒收,
        //    一个分支都吃不下 → 主循环一行也不前进 → 死循环(详见段落尾部那条兜底注释)。
        //    井号后**没有**空白仍然不是标题:`#标签` 必须留给行内标签那条路。
        const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (h) {
            blocks.push({ type: 'heading', level: h[1].length, inlines: inline(h[2]) });
            i++;
            continue;
        }

        // 表格:当前行含 | 且下一行是分隔行
        if (tables && line.includes('|') && i + 1 < lines.length
            && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
            const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
                .split('|').map(c => c.trim());
            const head = cells(line).map(inline);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(cells(lines[i]).map(inline));
                i++;
            }
            blocks.push({ type: 'table', head, rows });
            continue;
        }

        // 引用
        if (/^\s*>\s?/.test(line)) {
            const body = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                body.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            blocks.push({ type: 'quote', blocks: parseMarkdown(body.join('\n'), options) });
            continue;
        }

        // 列表
        if (/^\s*[-*+]\s+/.test(line)) { flushList(false); continue; }
        if (/^\s*\d+\.\s+/.test(line)) { flushList(true); continue; }

        // 空行
        if (line.trim() === '') {
            if (options.preserveBlankLines) blocks.push({ type: 'blank', text: line });
            i++; continue;
        }

        // 段落:收连续的普通行
        const para = [];
        while (i < lines.length && lines[i].trim() !== ''
            && !/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|~~~)/.test(lines[i])
            && !/^\s*([-*_])\s*\1\s*\1/.test(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        // ⚠️ 兜底 —— 它是"主循环每轮必须让 i 前进"这条不变式的**唯一保证**,删了它就会
        //    重现真机故障。
        //
        //    上面那条 while 的终止判据是一串"块起始"的**粗**正则,它们比真正的块处理**更宽**,
        //    于是存在"哪个分支都吃不下"的行:
        //      · `#   `(井号 + 空白 + 没有正文)命中 `#{1,6}\s`,却曾经因为标题要 `(.+?)` 匹配不上;
        //      · ` ```js foo ` 命中 ` ``` `,却因为围栏只接一个**不含空白**的信息串而匹配不上。
        //    这些行一个分支也吃不下 → `i` 不前进 → 外层 while **永远转下去**。
        //    真机实测(2026-09-25):`E:\仓库\未命名.md` 的内容恰好是两个字节 `"# "`,
        //    布局存档里那个 `{"view":"doc","doc":"未命名.md"}` 标签让启动时就把这篇笔记装进编辑器,
        //    渲染线程随即占满一个核、IPC 一条都不回复 —— 用户看到的就是"程序卡住了"
        //    (窗口并不报未响应:卡住的是渲染进程,不是窗口消息泵)。
        //    所以这里定死一条不变式:**若段落循环一行也没吃下,就由这里吃掉当前行**当普通段落。
        //    于是每一轮外层循环都至少前进一行,`parseMarkdown` 对任何输入都必然收敛。
        if (para.length === 0) { para.push(line); i++; }
        blocks.push({ type: 'paragraph', lines: para.map(inline) });
    }

    return blocks;
}

// ---------- 输出端一:HTML 字符串(笔记预览) ----------

function renderInlineHtml(nodes) {
    let out = '';
    for (const node of nodes) {
        switch (node.type) {
            case 'text': out += escapeHtml(node.text); break;
            case 'code': out += `<code>${escapeHtml(node.text)}</code>`; break;
            case 'strong': out += `<strong>${renderInlineHtml(node.children)}</strong>`; break;
            case 'em': out += `<em>${renderInlineHtml(node.children)}</em>`; break;
            case 'link':
                out += `<a href="${escapeHtml(node.url)}" target="_blank" rel="noreferrer">`
                    + `${escapeHtml(node.text)}</a>`;
                break;
            case 'image':
                // alt 与 src 都过 escapeHtml —— 与链接同一条纪律:原文进来先转义。
                out += `<img src="${escapeHtml(node.url)}" alt="${escapeHtml(node.alt)}" loading="lazy">`;
                break;
            case 'wikilink': {
                const cls = node.missing ? 'wikilink missing' : 'wikilink';
                const title = node.missing ? ' title="这篇还没写"' : '';
                // data-note 是唯一的"传参"方式,href 一律 #,不拼 URL
                out += `<a class="${cls}"${title} data-note="${escapeHtml(node.target)}" href="#">`
                    + (node.bang ? '📄 ' : '') + escapeHtml(node.label) + '</a>';
                break;
            }
            case 'tag': out += `<span class="tag">${escapeHtml(node.text)}</span>`; break;
            case 'br': out += '<br>'; break;
            default: break;
        }
    }
    return out;
}

function renderBlockHtml(block) {
    switch (block.type) {
        case 'blank':
            return `<p>${escapeHtml(block.text)}<br data-live-markdown-placeholder="true"></p>`;
        case 'heading':
            return `<h${block.level}>${renderInlineHtml(block.inlines)}</h${block.level}>`;
        case 'paragraph':
            return `<p>${block.lines.map(renderInlineHtml).join('<br>')}</p>`;
        case 'code':
            return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        case 'list': {
            const items = block.items.map(item => `<li>${renderInlineHtml(item)}</li>`).join('');
            return block.ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
        }
        case 'quote':
            return `<blockquote>${block.blocks.map(renderBlockHtml).join('\n')}</blockquote>`;
        case 'hr':
            return '<hr>';
        case 'table': {
            const th = block.head.map(c => `<th>${renderInlineHtml(c)}</th>`).join('');
            const trs = block.rows.map(r =>
                `<tr>${r.map(c => `<td>${renderInlineHtml(c)}</td>`).join('')}</tr>`).join('');
            return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
        }
        default:
            return '';
    }
}

// ---------- Agent code fences ----------
//
// Keep this deliberately small and DOM-only: the Agent renderer never injects
// token HTML, and unknown languages remain readable as plain code.
const CODE_LANGUAGES = new Map([
    ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
    ['ts', 'typescript'], ['tsx', 'typescript'],
    ['py', 'python'], ['py3', 'python'],
    ['html', 'html'], ['xml', 'html'], ['svg', 'html'], ['xhtml', 'html'],
    ['json', 'json'], ['jsonc', 'json'], ['json5', 'json'],
    ['text', 'plain'], ['txt', 'plain'], ['plain', 'plain'], ['plaintext', 'plain'],
    ['sh', 'bash'], ['shell', 'bash'], ['zsh', 'bash'], ['bash', 'bash'],
    ['ps1', 'powershell'], ['powershell', 'powershell'], ['pwsh', 'powershell'],
    ['yml', 'yaml'], ['yaml', 'yaml'], ['sql', 'sql'], ['css', 'css'],
    ['java', 'java'], ['c', 'c'], ['h', 'c'], ['cpp', 'cpp'], ['cc', 'cpp'],
    ['cxx', 'cpp'], ['rs', 'rust'], ['rust', 'rust'], ['go', 'go'],
    ['php', 'php'], ['rb', 'ruby'], ['ruby', 'ruby'], ['swift', 'swift'],
    ['kt', 'kotlin'], ['kotlin', 'kotlin'], ['cs', 'csharp'], ['csharp', 'csharp'],
]);

const CODE_KEYWORDS = {
    javascript: 'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while yield',
    typescript: 'abstract any as asserts async await boolean break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new number object of package private protected public readonly require return set static string super switch this throw try type typeof undefined unique unknown var void while yield',
    python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
    bash: 'case do done elif else esac fi for function if in select then time until while',
    powershell: 'begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in param process return switch throw trap try until using var while',
    sql: 'add all alter analyze and as asc begin between by case cast check column commit constraint create cross current_date current_timestamp database default delete desc distinct drop else end except exists explain false fetch for foreign from full grant group having in index inner insert into is join left like limit not null offset on or order outer primary references returning right rollback select set table then true union unique update values view when where with',
    css: 'important',
    java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while',
    c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while',
    cpp: 'alignas alignof asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long namespace new noexcept nullptr operator private protected public register return short signed sizeof static struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while',
    rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type union unsafe use where while',
    go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
    php: 'abstract and array as break callable case catch class clone const continue declare default do else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include instanceof insteadof interface namespace new or private protected public require return static switch throw trait try use var while xor',
    ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
    swift: 'associatedtype break case class continue default defer deinit do else enum extension fallthrough false fileprivate for func guard if import in init inout internal is let nil open operator private protocol public repeat rethrows return self static struct subscript super switch throw throws true try typealias var where while',
    kotlin: 'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while',
    csharp: 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while',
};
for (const language of Object.keys(CODE_KEYWORDS)) CODE_KEYWORDS[language] = new Set(CODE_KEYWORDS[language].split(' '));

function canonicalCodeLanguage(raw) {
    const value = String(raw ?? '').trim().toLowerCase().replace(/^language-/, '');
    return CODE_LANGUAGES.get(value) ?? (Object.hasOwn(CODE_KEYWORDS, value) ? value : '');
}

function inferCodeLanguage(source) {
    const text = String(source ?? '').trim();
    if (text === '') return '';
    if (/^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(text)) {
        try { JSON.parse(text); return 'json'; } catch { /* keep checking */ }
    }
    if (/^(?:<!doctype\s+html|<!--[\s\S]*?-->|<html\b|<\/?[a-z][^>]*>)/i.test(text)) return 'html';
    if (/^(?:#!.*\b(?:ba|z|k)?sh\b|(?:[$#]\s*)?(?:npm|pnpm|yarn|node|git|cd|ls|mkdir|python|pip|cargo|go)\s)/i.test(text)) return 'bash';
    if (/^(?:from\s+[\w.]+\s+import\b|import\s+[\w.]+|def\s+\w+\s*\(|class\s+\w+\s*(?:\(|:)|print\s*\()/m.test(text)) return 'python';
    if (/^\s*(?:select|insert|update|delete|create|alter|with)\b/i.test(text)) return 'sql';
    if (/^\s*(?:[.#][\w-]+|[a-z][\w-]*)\s*\{[^}]*:[^}]*\}/i.test(text)) return 'css';
    if (/\b(?:const|let|var|function|console\.|=>|export\s+default|interface\s+\w+)\b/.test(text)) return 'javascript';
    return '';
}

function languageLabel(language, raw) {
    const labels = {
        javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', html: 'HTML',
        json: 'JSON', plain: 'Text', bash: 'Shell', powershell: 'PowerShell', yaml: 'YAML', sql: 'SQL', css: 'CSS', java: 'Java',
        c: 'C', cpp: 'C++', rust: 'Rust', go: 'Go', php: 'PHP', ruby: 'Ruby',
        swift: 'Swift', kotlin: 'Kotlin', csharp: 'C#',
    };
    return labels[language] ?? (String(raw ?? '').trim().slice(0, 18) || 'CODE');
}

function appendCodeToken(doc, parent, value, kind) {
    if (!value) return;
    if (!kind) { parent.appendChild(doc.createTextNode(value)); return; }
    const token = doc.createElement('span');
    token.className = `agent-code-token-${kind}`;
    token.appendChild(doc.createTextNode(value));
    parent.appendChild(token);
}

function highlightMarkup(doc, parent, source) {
    let i = 0;
    while (i < source.length) {
        if (source.startsWith('<!--', i)) {
            const end = source.indexOf('-->', i + 4);
            const stop = end < 0 ? source.length : end + 3;
            appendCodeToken(doc, parent, source.slice(i, stop), 'comment'); i = stop; continue;
        }
        if (source[i] !== '<' || !/^<\/?[A-Za-z!?]/.test(source.slice(i, i + 3))) {
            const found = source.indexOf('<', i + (source[i] === '<' ? 1 : 0));
            const next = found === -1 ? source.length : found;
            appendCodeToken(doc, parent, source.slice(i, next)); i = next; continue;
        }
        appendCodeToken(doc, parent, '<', 'punct'); i++;
        if (source[i] === '/') { appendCodeToken(doc, parent, '/', 'punct'); i++; }
        if (source[i] === '!') {
            let end = source.indexOf('>', i);
            if (end < 0) end = source.length - 1;
            appendCodeToken(doc, parent, source.slice(i, end + 1), 'comment'); i = end + 1; continue;
        }
        const name = /^[\w:-]+/.exec(source.slice(i));
        if (name) { appendCodeToken(doc, parent, name[0], 'tag'); i += name[0].length; }
        while (i < source.length && source[i] !== '>') {
            if (/\s/.test(source[i])) { appendCodeToken(doc, parent, source[i++]); continue; }
            if (source[i] === '/') { appendCodeToken(doc, parent, '/', 'punct'); i++; continue; }
            if (source[i] === '=') { appendCodeToken(doc, parent, '=', 'operator'); i++; continue; }
            if (source[i] === '"' || source[i] === "'") {
                const quote = source[i]; let end = i + 1;
                while (end < source.length && source[end] !== quote) end++;
                if (end < source.length) end++;
                appendCodeToken(doc, parent, source.slice(i, end), 'string'); i = end; continue;
            }
            const attr = /^[^\s=/>]+/.exec(source.slice(i));
            if (attr) { appendCodeToken(doc, parent, attr[0], 'property'); i += attr[0].length; }
            else { appendCodeToken(doc, parent, source[i++]); }
        }
        if (source[i] === '>') { appendCodeToken(doc, parent, '>', 'punct'); i++; }
    }
}

function highlightCode(doc, code, source, language) {
    code.setAttribute('data-language', language || 'plain');
    if (!language || language === 'plain') { code.appendChild(doc.createTextNode(source)); return; }
    if (language === 'html') { highlightMarkup(doc, code, source); return; }
    const keywords = CODE_KEYWORDS[language] ?? CODE_KEYWORDS.javascript;
    const supportsSlashComments = ['javascript', 'typescript', 'java', 'c', 'cpp', 'rust', 'go', 'php', 'swift', 'kotlin', 'csharp', 'css'].includes(language);
    const supportsHashComments = ['python', 'bash', 'powershell', 'yaml', 'ruby'].includes(language);
    const supportsSqlComments = language === 'sql';
    const operators = ['>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&', '||', '??=', '??', '?.', '=>', '->', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '<<', '>>', '**', '::', '...'];
    const operatorChars = '=+-*/%<>!&|^~?:';
    const isSpace = value => value !== '' && /\s/.test(value);
    const isIdentifierStart = value => value !== '' && /^[\p{L}_$]$/u.test(value);
    const isIdentifierPart = value => value !== '' && /^[\p{L}\p{N}_$]$/u.test(value);
    let i = 0;
    let previousWord = '';
    let previousNonSpace = '';
    while (i < source.length) {
        const ch = source[i];
        if (isSpace(ch)) {
            const start = i++;
            while (i < source.length && isSpace(source[i])) i++;
            appendCodeToken(doc, code, source.slice(start, i)); continue;
        }
        if (supportsSlashComments && (source.startsWith('//', i) || source.startsWith('/*', i))) {
            const line = source.startsWith('//', i);
            const end = line ? source.indexOf('\n', i + 2) : source.indexOf('*/', i + 2);
            const stop = end < 0 ? source.length : line ? end : end + 2;
            appendCodeToken(doc, code, source.slice(i, stop), 'comment'); i = stop; previousNonSpace = '/'; continue;
        }
        if (supportsSqlComments && (source.startsWith('--', i) || source.startsWith('/*', i))) {
            const line = source.startsWith('--', i);
            const end = line ? source.indexOf('\n', i + 2) : source.indexOf('*/', i + 2);
            const stop = end < 0 ? source.length : line ? end : end + 2;
            appendCodeToken(doc, code, source.slice(i, stop), 'comment'); i = stop; previousNonSpace = '/'; continue;
        }
        if (supportsHashComments && ch === '#' && (language !== 'yaml' || i === 0 || isSpace(source[i - 1]))) {
            const end = source.indexOf('\n', i);
            const stop = end < 0 ? source.length : end;
            appendCodeToken(doc, code, source.slice(i, stop), 'comment'); i = stop; previousNonSpace = '#'; continue;
        }
        const quote = ch;
        if (quote === '"' || quote === "'" || (quote === '`' && ['javascript', 'typescript'].includes(language))) {
            const triple = language === 'python' && source.startsWith(quote.repeat(3), i);
            const delimiter = triple ? quote.repeat(3) : quote;
            let end = i + delimiter.length;
            while (end < source.length) {
                if (source[end] === '\\') { end += 2; continue; }
                if (source.startsWith(delimiter, end)) { end += delimiter.length; break; }
                end++;
            }
            const value = source.slice(i, end);
            const prop = language === 'json' && /^\s*:/.test(source.slice(end));
            appendCodeToken(doc, code, value, prop ? 'property' : 'string'); i = end; previousWord = ''; previousNonSpace = quote; continue;
        }
        if (/\d/.test(ch) || (ch === '.' && /\d/.test(source[i + 1] ?? ''))) {
            const number = /^(?:0[xX][\da-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?n?)/.exec(source.slice(i));
            if (number) { appendCodeToken(doc, code, number[0], 'number'); i += number[0].length; previousWord = ''; previousNonSpace = '0'; continue; }
        }
        const point = source.codePointAt(i);
        const char = point === undefined ? '' : String.fromCodePoint(point);
        if (isIdentifierStart(char)) {
            let end = i + char.length;
            while (end < source.length) {
                const nextPoint = source.codePointAt(end);
                const next = nextPoint === undefined ? '' : String.fromCodePoint(nextPoint);
                if (!isIdentifierPart(next)) break;
                end += next.length;
            }
            const word = source.slice(i, end);
            let afterIndex = end;
            while (afterIndex < source.length && isSpace(source[afterIndex])) afterIndex++;
            const after = source[afterIndex] ?? '';
            let kind = '';
            if (keywords.has(word)) kind = 'keyword';
            else if (/^(?:true|false|null|undefined|None|True|False|nil|NaN|Infinity)$/i.test(word)) kind = 'literal';
            else if (['new', 'extends', 'implements', 'instanceof', 'class', 'interface', 'type'].includes(previousWord)) kind = 'type';
            else if (after === '(' || ['function', 'def', 'func', 'fn'].includes(previousWord)) kind = 'function';
            else if (['json', 'yaml', 'css'].includes(language) && after === ':') kind = 'property';
            else if (['javascript', 'typescript'].includes(language) && previousNonSpace === '.') kind = after === '(' ? 'function' : 'property';
            appendCodeToken(doc, code, word, kind);
            previousWord = word; previousNonSpace = source[end - 1]; i = end; continue;
        }
        if ('()[]{}.,;:'.includes(ch)) {
            appendCodeToken(doc, code, ch, 'punct'); i++; previousWord = ''; previousNonSpace = ch; continue;
        }
        if (operatorChars.includes(ch)) {
            const operator = operators.find(value => source.startsWith(value, i)) ?? ch;
            appendCodeToken(doc, code, operator, 'operator'); i += operator.length; previousWord = ''; previousNonSpace = operator.at(-1); continue;
        }
        appendCodeToken(doc, code, ch);
        previousWord = ''; previousNonSpace = ch;
        i++;
    }
}

function createCodeCopyButton(doc, code, label) {
    const button = doc.createElement('button');
    button.className = 'agent-code-copy';
    button.type = 'button';
    button.setAttribute('aria-label', `复制 ${label} 代码`);
    button.setAttribute('title', `复制 ${label} 代码`);
    button.setAttribute('data-tooltip', `复制 ${label} 代码`);
    button.setAttribute('data-reply-static', 'true');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const back = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    back.setAttribute('class', 'copy-shape');
    for (const [name, value] of Object.entries({ x: '8', y: '8', width: '12', height: '12', rx: '2' })) back.setAttribute(name, value);
    const front = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    front.setAttribute('class', 'copy-shape'); front.setAttribute('d', 'M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3');
    const check = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    check.setAttribute('class', 'check-shape'); check.setAttribute('d', 'm5 12 4 4 10-9');
    svg.append(back, front, check); button.appendChild(svg);
    button.addEventListener('click', async () => {
        const text = code.textContent ?? '';
        let copied = false;
        const clipboard = doc.defaultView?.navigator?.clipboard;
        try {
            if (typeof clipboard?.writeText === 'function') {
                try { await clipboard.writeText(text); copied = true; }
                catch { /* use the local selection fallback below */ }
            }
            if (!copied) {
                const input = doc.createElement('textarea');
                input.value = text;
                input.setAttribute('readonly', '');
                input.style.position = 'fixed'; input.style.opacity = '0';
                doc.body.appendChild(input); input.select();
                copied = doc.execCommand?.('copy') === true;
                input.remove();
            }
        } catch { copied = false; }
        button.dataset.state = copied ? 'copied' : 'error';
        button.setAttribute('aria-label', copied ? '代码已复制' : '复制失败');
        button.setAttribute('title', copied ? '代码已复制' : '复制失败');
        button.setAttribute('data-tooltip', copied ? '已复制' : '复制失败');
        const view = doc.defaultView;
        if (button.copyResetTimer) view?.clearTimeout?.(button.copyResetTimer);
        button.copyResetTimer = view?.setTimeout?.(() => {
            if (!button.isConnected) return;
            delete button.dataset.state;
            button.setAttribute('aria-label', `复制 ${label} 代码`);
            button.setAttribute('title', `复制 ${label} 代码`);
            button.setAttribute('data-tooltip', `复制 ${label} 代码`);
        }, copied ? 1500 : 3000);
    });
    return button;
}

function renderCodeBlockNodes(doc, block, options) {
    const source = block.text ?? '';
    const language = canonicalCodeLanguage(block.lang) || inferCodeLanguage(source);
    const label = languageLabel(language, block.lang);
    const code = doc.createElement('code');
    code.className = 'agent-code-source';
    if (options.codeBlockTools) highlightCode(doc, code, source, language);
    else code.appendChild(doc.createTextNode(source));
    const pre = doc.createElement('pre');
    pre.appendChild(code);
    if (!options.codeBlockTools) return [pre];

    const wrapper = doc.createElement('div');
    wrapper.className = 'agent-code-block';
    wrapper.setAttribute('data-language', language || 'plain');
    const tools = doc.createElement('div');
    tools.className = 'agent-code-tools';
    tools.setAttribute('data-reply-static', 'true');
    const languageName = doc.createElement('span');
    languageName.className = 'agent-code-language';
    languageName.textContent = label;
    const copy = createCodeCopyButton(doc, code, label);
    tools.append(languageName, copy);
    wrapper.append(tools, pre);
    return [wrapper];
}

/**
 * 渲染 markdown 为 HTML。
 *
 * @param {string} markdown
 * @param {{resolveLink?:(target:string)=>boolean, noteExists?:(target:string)=>boolean}} [options]
 *        resolveLink 用于判断 wiki 链接是否指向已存在的笔记(不存在就画成虚线)
 * @returns {string} HTML
 */
export function renderMarkdown(markdown, options = {}) {
    return parseMarkdown(markdown, options).map(renderBlockHtml).join('\n');
}

// ---------- 输出端二:DOM 节点(对话面板) ----------
//
// 面板的规矩是"一律 textContent、绝不 innerHTML 拼字符串",而对话里的内容来自模型。
// 所以这一段**一个 innerHTML 都不出现**:文字一律 createTextNode,结构一律 createElement。
// 于是"注入"在这条路上不是"转义得好不好"的问题,而是**结构上不可能**。
//
// 默认只出**常用子集**(标题 / 粗斜体 / 行内码 / 围栏码 / 列表 / 引用 / 分隔线 / http(s) 链接):
// 表格、[[wiki]]、#标签 在对话里保持字面文字 —— 面板不碰笔记频道,[[x]] 点了也去不了,
// 画成一个"还没写的虚线链接"是骗人。

function inlineNodes(doc, nodes, options) {
    const out = [];
    for (const node of nodes) {
        switch (node.type) {
            case 'text': out.push(doc.createTextNode(node.text)); break;
            case 'code': {
                const code = doc.createElement('code');
                code.appendChild(doc.createTextNode(node.text));
                out.push(code);
                break;
            }
            case 'strong': {
                const el = doc.createElement('strong');
                for (const child of inlineNodes(doc, node.children, options)) el.appendChild(child);
                out.push(el);
                break;
            }
            case 'em': {
                const el = doc.createElement('em');
                for (const child of inlineNodes(doc, node.children, options)) el.appendChild(child);
                out.push(el);
                break;
            }
            case 'link': {
                const a = doc.createElement('a');
                a.setAttribute('href', node.url);
                // 新窗口一律交给主进程的 setWindowOpenHandler(只放行 http/https),
                // 而 will-navigate 会挡住应用自身被导航走。
                a.setAttribute('target', '_blank');
                a.setAttribute('rel', 'noreferrer');
                a.appendChild(doc.createTextNode(node.text));
                out.push(a);
                break;
            }
            case 'br': out.push(doc.createElement('br')); break;
            case 'image': {
                if (options.omitImageUrls?.has(node.url)) break;
                // ⚠️ 建节点、**不拼 HTML**:src/alt 都是显式属性,不存在"注入进标签"这回事。
                // 只认 http(s)(规则层已经卡住),`javascript:` / `data:` 到不了这里。
                const img = doc.createElement('img');
                img.setAttribute('src', node.url);
                img.setAttribute('alt', node.alt);
                img.setAttribute('loading', 'lazy');
                out.push(img);
                break;
            }
            // wikilink / tag 不在对话子集里(解析时已关掉,这里只是兜底:当文字)
            case 'wikilink': out.push(doc.createTextNode(node.label)); break;
            case 'tag': out.push(doc.createTextNode(node.text)); break;
            default: break;
        }
    }
    return out;
}

function blockNodes(doc, block, options) {
    switch (block.type) {
        case 'blank': {
            const el = doc.createElement('p'), placeholder = doc.createElement('br');
            el.appendChild(doc.createTextNode(block.text));
            placeholder.setAttribute('data-live-markdown-placeholder', 'true');
            el.appendChild(placeholder);
            return [el];
        }
        case 'heading': {
            const el = doc.createElement(`h${block.level}`);
            for (const child of inlineNodes(doc, block.inlines, options)) el.appendChild(child);
            return [el];
        }
        case 'paragraph': {
            const el = doc.createElement('p');
            block.lines.forEach((line, index) => {
                if (index > 0) el.appendChild(doc.createElement('br'));
                for (const child of inlineNodes(doc, line, options)) el.appendChild(child);
            });
            return [el];
        }
        case 'code': return renderCodeBlockNodes(doc, block, options);
        case 'list': {
            const el = doc.createElement(block.ordered ? 'ol' : 'ul');
            for (const item of block.items) {
                const li = doc.createElement('li');
                for (const child of inlineNodes(doc, item, options)) li.appendChild(child);
                el.appendChild(li);
            }
            return [el];
        }
        case 'quote': {
            const el = doc.createElement('blockquote');
            for (const child of block.blocks) {
                for (const node of blockNodes(doc, child, options)) el.appendChild(node);
            }
            return [el];
        }
        case 'hr':
            return [doc.createElement('hr')];
        // 调用方显式开启表格时，用安全 DOM 节点保留所有单元格。
        case 'table': {
            const el = doc.createElement('table');
            const thead = doc.createElement('thead');
            const headerRow = doc.createElement('tr');
            for (const cell of block.head) {
                const th = doc.createElement('th');
                for (const node of inlineNodes(doc, cell, options)) th.appendChild(node);
                headerRow.appendChild(th);
            }
            thead.appendChild(headerRow);
            el.appendChild(thead);
            const tbody = doc.createElement('tbody');
            for (const row of block.rows) {
                const tr = doc.createElement('tr');
                for (const cell of row) {
                    const td = doc.createElement('td');
                    for (const node of inlineNodes(doc, cell, options)) td.appendChild(node);
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
            el.appendChild(tbody);
            return [el];
        }
        default:
            return [];
    }
}

/**
 * 把 markdown 渲染成**节点数组**(面板直接 appendChild 用)。
 *
 * @param {Document} doc 造节点用的 document(注入,便于单测)
 * @param {string} markdown
 * @param {{resolveLink?:Function, wikilinks?:boolean, tags?:boolean, tables?:boolean, omitImageUrls?:Set<string>, codeBlockTools?:boolean}} [options]
 * @returns {Node[]}
 */
export function renderMarkdownNodes(doc, markdown, options = {}) {
    const opts = { wikilinks: false, tags: false, tables: false, codeBlockTools: false, ...options };
    const blocks = parseMarkdown(markdown, opts);
    const out = [];
    for (const block of blocks) out.push(...blockNodes(doc, block, opts));
    return out;
}
