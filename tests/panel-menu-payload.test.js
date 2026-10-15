import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePanelMenuReport } from '../electron/panel-menu-payload.js';

test('窗口菜单报告:只保留两组菜单必需的纯数据字段', () => {
    const report = sanitizePanelMenuReport({
        views: [{ id: 'notes', label: '笔记', open: true, active: true, script: 'ignored' }],
        tools: [{ id: 'tool:palette:palette', open: 1, active: false, pluginObject: {} }],
    });

    assert.deepEqual(report, {
        views: [{ id: 'notes', label: '笔记', open: true, active: true }],
        tools: [{ id: 'tool:palette:palette', label: 'tool:palette:palette', open: false, active: false }],
    });
});

test('窗口菜单报告:非法组和空视图 id 被过滤,缺失工具组默认为空', () => {
    const report = sanitizePanelMenuReport({
        views: [null, {}, { id: '', label: '空' }, { id: 'doc' }],
    });

    assert.deepEqual(report, {
        views: [{ id: 'doc', label: 'doc', open: false, active: false }],
        tools: [],
    });
    assert.deepEqual(sanitizePanelMenuReport(null), { views: [], tools: [] });
});
