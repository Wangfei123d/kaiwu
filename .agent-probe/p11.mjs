// ① agent:send 必须转交 `shown`(气泡里那句)—— 台账记的是它,不是裹着笔记上下文的 text。
// ② 补两层断言:IPC 接缝一处(单测),自检一处(端到端:记下来的确实是"你打的那句")。
import fs from 'node:fs';

function patch(file, pairs) {
    let s = fs.readFileSync(file, 'utf8');
    const crlf = s.includes('\r\n');
    const fix = (t) => (crlf ? t.replace(/\n/g, '\r\n') : t);
    for (const [from, to] of pairs) {
        const f = fix(from);
        const n = s.split(f).length - 1;
        if (n !== 1) {
            console.error('MISS/不唯一(' + n + ')', file, JSON.stringify(from.slice(0, 80)));
            process.exit(1);
        }
        s = s.replace(f, fix(to));
    }
    fs.writeFileSync(file, s);
    console.log('patched', file);
}

patch('electron/agent/agent-ipc.js', [
    [
        `            if (text.trim() === '' && admitted.images.length === 0) throw new Error('text 不能为空');
            return runtime.send(text, { images: admitted.images });`,
        `            if (text.trim() === '' && admitted.images.length === 0) throw new Error('text 不能为空');
            // ⚠️ \`shown\`(**气泡里显示的那一句**)必须一起转交 —— 会话台账记的是它,不是 \`text\`
            //    (text 里还裹着"当前笔记 / 标题 / 正文"那一整段上下文)。
            //    漏掉这一步的后果是实测出来的:台账里那条"用户消息"变成了整段笔记正文,
            //    标题也跟着被污染(「接着聊」铺回历史时,用户会看到一大段自己没打过的东西)。
            const shown = typeof payload?.shown === 'string' ? payload.shown : '';
            return runtime.send(text, { images: admitted.images, shown });`,
    ],
]);

// 单测:接缝处(运行时单测是直接调 runtime.send 的,漏在这一层正说明接缝要单独钉)
fs.appendFileSync('tests/agent-runtime.test.js', `
test('agent:send 要把 shown(气泡那一句)一起转交 —— 台账记的是它,不是整段笔记上下文', async () => {
    const led = fakeLedger();
    const h = harness({ ledger: led });
    const { registerAgentIpc } = await import('../electron/agent/agent-ipc.js');
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    registerAgentIpc({ ipcMain, getWindow: () => null, runtime: h.runtime, log: { warn() {} } });
    try {
        await h.runtime.start();
        const inFlight = handlers.get('agent:send')(null, {
            text: '【笔记:甲篇】\\n甲篇的正文\\n\\n问题:你好',
            shown: '你好',
        });
        await tick();
        h.client.resolvePrompt({ stopReason: 'end_turn' });
        await inFlight;
        assert.equal(led.calls.user.length, 1);
        assert.equal(led.calls.user[0].text, '你好', '记下来的必须是气泡里那句');
        assert.equal(h.client.calls.prompt[0].text, '【笔记:甲篇】\\n甲篇的正文\\n\\n问题:你好',
            '发给对端的仍然带笔记上下文 —— 两件事互不影响');
    } finally {
        await h.runtime.dispose();
    }
});
`);
console.log('appended tests/agent-runtime.test.js');

// 自检:端到端确认台账里那条"用户消息"不是整段上下文
patch('electron/selftest.js', [
    [
        `        const firstLedger = filesAfterChat.length > 0
            ? fs.readFileSync(path.join(sessionDir, filesAfterChat[0]), 'utf8') : '';`,
        `        const firstLedger = filesAfterChat.length > 0
            ? fs.readFileSync(path.join(sessionDir, filesAfterChat[0]), 'utf8') : '';
        // ⚠️ 台账里那条"用户消息"必须是**气泡里那句**,不是"当前笔记/标题/正文"整段 ——
        //    这条曾经真的错过:agent:send 的 IPC 处理函数把 shown 丢了,于是台账记下了整段
        //    笔记正文,标题也被污染(接回来铺历史时用户会看到一大段自己没打过的东西)。
        const userEntry = firstLedger.split('<!--kaiwu:{"kind":"user"')[1] ?? '';
        const userText = userEntry.split('-->')[1]?.split('<!--kaiwu:')[0]?.trim() ?? '';`,
    ],
    [
        `        // 预置一条"上一次的会话"(模拟上一趟应用留下的记录)。它的 id 是夹具**认得**的那条,`,
        `        r.ok('AI 会话:台账里记的是**你打的那一句**(不是裹着笔记上下文的整段提示)',
            userText !== '' && !userText.includes('当前笔记:') && !userText.includes('标题:')
            && !userText.includes('正文:') && !userText.includes('\\n'),
            JSON.stringify({ userText: userText.slice(0, 120) }));

        // 预置一条"上一次的会话"(模拟上一趟应用留下的记录)。它的 id 是夹具**认得**的那条,`,
    ],
]);
