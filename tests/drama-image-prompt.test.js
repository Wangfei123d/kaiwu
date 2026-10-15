import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImagePrompt } from '../app/lib/drama-image-prompt.js';
import { createImagePromptPreview } from '../plugins/drama/image-prompt-preview.js';

test('提示词保留全文和来源顺序，只跳过空内容，单一片段兼容旧节点', () => {
    assert.equal(buildImagePrompt(' 单幅画面 ', ['', '人物', undefined, '风格'], ['', '设定', '', '风格']),
        '【节点提示词】\n单幅画面\n\n【设定】\n人物\n\n【风格】\n风格');
    assert.equal(buildImagePrompt('', ['   ', '全文']), '全文');
    assert.equal(buildImagePrompt('本地提示词', []), '本地提示词');
    assert.equal(buildImagePrompt('  ', ['', undefined]), '');
});

function panel(options = {}) {
    const doc = { createElement: (tag) => ({
        tag, children: [], textContent: '', open: false, listeners: new Map(),
        append(...children) { this.children.push(...children); },
        setAttribute() {}, addEventListener(name, listener) { this.listeners.set(name, listener); },
    }) };
    const preview = createImagePromptPreview({ doc, getPrompt: () => '本地',
        readSources: async () => [], buildPrompt: buildImagePrompt, ...options });
    preview.element.open = true;
    return { ...preview, status: preview.element.children[1], content: preview.element.children[2] };
}

test('预览合并各来源并提示空内容，修改节点提示词会刷新', async () => {
    let prompt = '首帧';
    const p = panel({ getPrompt: () => prompt, readSources: async () => [
        { title: '剧本', text: '雨夜' }, { title: '空白', text: ' ' },
        { title: '<script>', text: '<img onerror=x>' },
    ] });
    await p.refresh();
    assert.equal(p.content.textContent, '【节点提示词】\n首帧\n\n【剧本】\n雨夜\n\n【<script>】\n<img onerror=x>');
    assert.equal(p.status.textContent, '已合并 2 个来源 · 跳过 1 个空内容');
    assert.equal(p.content.children.length, 0, '提示词只写纯文本，不创建 HTML 节点');
    prompt = '俯视图';
    await p.refresh();
    assert.match(p.content.textContent, /俯视图/);
});

test('预览标明未运行来源，读取失败不继续展示旧提示词', async () => {
    let fail = false;
    const p = panel({ readSources: async () => {
        if (fail) throw new Error('读取失败');
        return [{ title: '待生成', text: '', pending: true }];
    } });
    await p.refresh();
    assert.match(p.status.textContent, /1 个上游尚未完成运行/);
    fail = true;
    await p.refresh();
    assert.equal(p.content.textContent, '');
    assert.match(p.status.textContent, /读取失败/);
});

test('迟到的旧预览读取不能覆盖较新的提示词', async () => {
    let resolveOld;
    let reads = 0;
    const p = panel({ readSources: () => ++reads === 1
        ? new Promise(resolve => { resolveOld = resolve; })
        : Promise.resolve([{ title: '新来源', text: '新内容' }]) });
    const old = p.refresh();
    await p.refresh();
    resolveOld([{ title: '旧来源', text: '旧内容' }]);
    await old;
    assert.match(p.content.textContent, /新内容/);
    assert.doesNotMatch(p.content.textContent, /旧内容/);
});
