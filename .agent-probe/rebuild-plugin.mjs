// 重建 plugins/ai-session/{panel.js,style.css}:
// 原件在 %TEMP%\ai-session\(我当初写的那两份),之后的三处改动都是脚本化的、脚本也还在 ——
// 按当时的顺序重放:①notice 提示条那一层 ②CSS 的 .ses-right/.ses-notice-bar ③「新建会话」那一批。
// ⚠️ 不复用 patch-new-2-wiring.mjs 原脚本:它同时改 5 个文件,而另外 3 个(ipc/preload/ctx)是好的、
//    已经改过了 —— 整脚本重放会在那些文件上找不到锚点。
import fs from 'node:fs';

const panel = 'plugins/ai-session/panel.js';
const css = 'plugins/ai-session/style.css';

fs.copyFileSync('C:\\Users\\Administrator\\AppData\\Local\\Temp\\ai-session\\panel.js', panel);
fs.copyFileSync('C:\\Users\\Administrator\\AppData\\Local\\Temp\\ai-session\\style.css', css);

function sub(file, from, to, label) {
    let s = fs.readFileSync(file, 'utf8');
    const crlf = s.includes('\r\n');
    const fix = (t) => (crlf ? t.replace(/\n/g, '\r\n') : t);
    const f = fix(from);
    if (!s.includes(f)) {
        console.error(`✗ [${label}] ${file} 锚点没找到`);
        process.exitCode = 1;
        return false;
    }
    s = s.replace(f, fix(to));
    fs.writeFileSync(file, s);
    console.log(`✓ [${label}] ${file}`);
    return true;
}

// ---- ① panel.js:提示条那一层(不能被重画抹掉) ----
sub(panel, `    // ---- 骨架:左清单 + 右回看 ----
    const root = el('div', 'ses-pane');
    const listCol = el('div', 'ses-list');
    const detailCol = el('div', 'ses-detail');
    root.append(listCol, detailCol);
    host.append(root);`,
`    // ---- 骨架:左清单 + 右回看 + 顶部一条**不会被重画**的提示条 ----
    //
    // ⚠️ 提示条为什么必须单独一层:回看那一栏每次都是 replaceChildren() 重画的,
    //    把提示 prepend 进那一栏就会被紧接着的重画抹掉 —— 表现是"点了按钮什么都没说",
    //    连失败原因都留不住(自检实测:notice 读到空字符串)。
    const root = el('div', 'ses-pane');
    const listCol = el('div', 'ses-list');
    const rightCol = el('div', 'ses-right');
    const noticeBar = el('div', 'ses-notice-bar');
    noticeBar.hidden = true;
    const detailCol = el('div', 'ses-detail');
    rightCol.append(noticeBar, detailCol);
    root.append(listCol, rightCol);
    host.append(root);`, 'panel/骨架+提示条');

sub(panel, `    /** 一条错误/提示(顶部横条,不打断布局)。 */
    function showNotice(text, kind = 'info') {
        const old = detailCol.querySelector('.ses-notice');
        if (old !== null) old.remove();
        const bar = el('div', \`ses-notice \${kind}\`, text);
        detailCol.prepend(bar);
        setTimeout(() => { bar.remove(); }, 8000);
    }`,
`    /** 一条错误/提示(顶部横条,不打断布局;住在那层不会被重画的地方)。 */
    let noticeTimer = null;
    function showNotice(text, kind = 'info') {
        noticeBar.textContent = text;
        noticeBar.className = \`ses-notice-bar \${kind}\`;
        noticeBar.hidden = false;
        if (noticeTimer !== null) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => { noticeBar.hidden = true; }, 8000);
    }`, 'panel/showNotice');

sub(panel, `    async function activate(id) {
        if (id === '' || busy) return;
        busy = true;
        renderList();
        const r = await sessions.activate(id);
        busy = false;`,
`    async function activate(id) {
        if (id === '' || busy) return;
        busy = true;
        renderList();
        const r = await sessions.activate(id);
        busy = false;
        // ⚠️ 结果写进宿主 dataset:自检据此判"切没切过去" —— 靠中文提示判断成功与否
        //    是验不出这件事的(而且提示 8 秒后自己就消失了)。
        try {
            host.dataset.lastActivate = JSON.stringify({
                ok: r?.ok === true, sessionId: r?.sessionId ?? null,
                reused: r?.reused === true, reason: r?.reason ?? '',
            });
        } catch { /* dataset 写不进去不该影响功能 */ }`, 'panel/activate 结果留痕');

// ---- ② style.css:.ses-right + .ses-notice-bar ----
sub(css, `.ses-notice {
  margin: 8px 13px 0;
  border: 1px solid #2b3a49;
  background: rgba(126, 200, 255, .08);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  color: #c9dcea;
}
.ses-notice.bad { border-color: #4a2c2a; background: rgba(255, 138, 128, .08); color: #f0c4bf; }
.ses-notice.ok { border-color: #274434; background: rgba(125, 220, 154, .08); color: #cfeeda; }`,
`.ses-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* ⚠️ 提示条住在**不会被重画**的那一层(见 panel.js 的骨架说明):它不能跟着回看区
   一起被 replaceChildren 抹掉,否则"点了按钮什么都没说"。 */
.ses-notice-bar {
  margin: 8px 13px 0;
  border: 1px solid #2b3a49;
  background: rgba(126, 200, 255, .08);
  border-radius: 8px;
  padding: 7px 10px;
  font: 12px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #c9dcea;
}
.ses-notice-bar[hidden] { display: none; }
.ses-notice-bar.bad { border-color: #4a2c2a; background: rgba(255, 138, 128, .08); color: #f0c4bf; }
.ses-notice-bar.ok { border-color: #274434; background: rgba(125, 220, 154, .08); color: #cfeeda; }`, 'css/ses-right+notice-bar');

// ---- ③ 「＋ 新建会话」那一批 ----
sub(panel, `    /** 最近一次清单(行动作用在它上面)。 */
    let rows = [];`,
`    /** 最近一次清单(行动作用在它上面)。 */
    let rows = [];
    /** 在飞的一轮(清单里带回来的):新建 / 接着聊都要禁用。 */
    let busyTurn = false;`, 'panel/busyTurn');

sub(panel, `        const refresh = el('button', 'ses-refresh', '刷新');
        refresh.type = 'button';
        refresh.addEventListener('click', () => { void load(); });
        head.append(refresh);`,
`        // 「＋ 新建会话」:点了**立刻**让对端开一条新的(用户在两个方案里选的那条)。
        // ⚠️ 文案带一个加号,与标签条上那个"加一片面板"的 ＋ 区分开 —— 它加的是**一条会话**。
        const create = el('button', 'ses-new', '＋ 新建会话');
        create.type = 'button';
        create.disabled = busyTurn;
        create.title = busyTurn
            ? '这一轮还没结束 —— 等它跑完(或取消)再新建'
            : '立刻开一条全新的会话(对端当场建,台账里立刻会出现一条 0 轮的记录)';
        create.addEventListener('click', () => { void createSession(); });
        head.append(create);
        const refresh = el('button', 'ses-refresh', '刷新');
        refresh.type = 'button';
        refresh.addEventListener('click', () => { void load(); });
        head.append(refresh);`, 'panel/新建按钮');

sub(panel, `            item.append(el('div', 'ses-title', row.title || '(没有标题)'));`,
`            // 0 轮 = 已经建好但一句话都还没说(「点了立刻建」会造出来的那种)。
            // 叫它「新会话(还没说话)」而不是「(没有标题)」—— 前者说清了它是什么。
            const label = row.turns > 0 ? (row.title || '(没有标题)') : '新会话(还没说话)';
            item.append(el('div', 'ses-title', label));`, 'panel/0 轮行标题');

sub(panel, `            meta.append(el('span', '', clockOf(row.updatedAt)));
            if (row.turns > 0) meta.append(el('span', '', \`\${row.turns} 轮\`));`,
`            meta.append(el('span', '', clockOf(row.updatedAt)));
            if (row.turns > 0) meta.append(el('span', '', \`\${row.turns} 轮\`));
            else meta.append(el('span', 'ses-empty-turn', '0 轮'));`, 'panel/0 轮标记');

sub(panel, `        const r = await sessions.list();
        if (r?.ok !== true) {`,
`        const r = await sessions.list();
        busyTurn = r?.busy === true;
        if (r?.ok !== true) {`, 'panel/读 busy');

sub(panel, `    async function activate(id) {`,
`    /**
     * 新建一条会话(「＋ 新建会话」)。
     * ⚠️ 是**立刻建**:点了对端就真的开一条,台账当场多一个 0 轮的记录 ——
     *    所以点错/点了不聊会留下空记录,面板每一行都要能一步删掉。
     */
    async function createSession() {
        if (busy) return;
        busy = true;
        renderList();
        const r = await sessions.create();
        busy = false;
        try {
            host.dataset.lastCreate = JSON.stringify({
                ok: r?.ok === true, sessionId: r?.sessionId ?? null, reason: r?.reason ?? '',
            });
        } catch { /* dataset 写不进去不该影响功能 */ }
        if (r?.ok !== true) {
            showNotice(\`没能新建会话:\${r?.reason ?? '未知原因'}\`, 'bad');
            await load();
            return;
        }
        selected = r.sessionId;
        showNotice('新会话已建好 —— 在「AI 对话」那一格里说第一句话就开始。', 'ok');
        await load();
    }

    async function activate(id) {`, 'panel/createSession');

sub(panel, `        const note = el('div', 'ses-note');
        if (row?.state === 'gone') {`,
`        const note = el('div', 'ses-note');
        if (Number(row?.turns ?? 0) === 0) {
            note.classList.add('warn');
            note.textContent = '这条会话已经建好了,但一句话都还没说 —— 不需要它就点「删除记录」(两步确认)。';
        } else if (row?.state === 'gone') {`, 'panel/0 轮说明条');

sub(css, `.ses-refresh {`,
`.ses-new {
  margin-left: auto;
  font: 11.5px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #0e0e0e;
  background: #7ec8ff;
  border: 1px solid #7ec8ff;
  border-radius: 7px;
  padding: 4px 8px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.ses-new:disabled { color: #565049; background: #1a1917; border-color: #2a2927; cursor: not-allowed; font-weight: 400; }
.ses-new + .ses-refresh { margin-left: 0; }
.ses-empty-turn { color: #6b6660; }
.ses-refresh {`, 'css/新建按钮样式');

// ---- ④ 导出 setup(当初是用 PowerShell 改的,没进补丁脚本) ----
sub(panel, `function setup(host, ctx) {`, `export function setup(host, ctx) {`, 'panel/export setup');

console.log(process.exitCode === 1 ? '\n有锚点没对上 —— 需要人工看' : '\n全部重建完成');
