import fs from 'node:fs';
import path from 'node:path';

// 设置持久化。文件位置:<userData>/settings.json
//
// 按插件 id 分命名空间 —— 这是"设置读写按插件 id 隔离"那条约束的实现处
// (设计文档 §6.5)。注意它在同 realm 下只能做到工程隔离:A 插件理论上
// 能读写 B 插件的键,主进程分辨不出调用方(设计文档 §3.4 已如实记录)。
export function createSettingsStore({ filePath, log = console }) {
    let cache = null;

    function load() {
        if (cache) return cache;
        try {
            cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            // 文件里可能是 null / 数组 / 字符串(被外部改坏),一律当空设置处理,
            // 否则下面 all[pluginId] ??= {} 会在非对象上静默失败或抛错。
            if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) cache = {};
        } catch {
            cache = {};             // 文件不存在或损坏,一律当空设置处理
        }
        return cache;
    }

    function save() {
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
        } catch (err) {
            log.error('[settings] 写入失败', err);
        }
    }

    return {
        get(pluginId, key) {
            return load()?.[pluginId]?.[key];
        },
        set(pluginId, key, value) {
            const all = load();
            all[pluginId] ??= {};
            all[pluginId][key] = value;
            save();
        },
    };
}
