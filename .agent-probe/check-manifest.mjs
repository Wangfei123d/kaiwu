// 清单校验一次性自查:新插件的 plugin.json 过不过 validateManifest。
import fs from 'node:fs';
import { validateManifest } from '../app/lib/manifest-schema.js';

const raw = JSON.parse(fs.readFileSync(new URL('../plugins/ai-session/plugin.json', import.meta.url), 'utf8'));
const r = validateManifest(raw, { dir: 'plugins/ai-session', sourceLabel: 'ai-session/plugin.json' });
console.log('ok =', r.ok);
console.log('errors =', JSON.stringify(r.errors ?? null));
console.log('descriptor =', JSON.stringify(r.descriptor ?? null).slice(0, 500));
