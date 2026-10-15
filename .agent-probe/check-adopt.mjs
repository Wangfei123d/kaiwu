// 自查:默认树 + 两片插件面板(都锚在 doc)收编之后会不会算出坏树 / 卡住。
import { adoptPanes, defaultTree, formatTree } from '../app/lib/panel-tree.js';

const ADOPTION = {
    drama: { anchor: 'doc', dir: 'row', sizes: [62, 38] },
    'ai-session': { anchor: 'links', dir: 'col', sizes: [62, 38] },
};
const known = ['notes', 'doc', 'links', 'ai', 'drama', 'ai-session'];

const t0 = Date.now();
const tree = adoptPanes(defaultTree(), known, ADOPTION);
console.log('耗时', Date.now() - t0, 'ms');
console.log(formatTree(tree));
console.log('JSON:', JSON.stringify(tree));
