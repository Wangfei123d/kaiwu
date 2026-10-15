// 「窗口」菜单里那份**面板表**:已知视图 × (开着没有, 此刻看得见没有)。
//
// 为什么单独一个纯函数:这段映射连着几个各自出过错的地方 ——
//   · "开没开"的判据(按**视图**判,不按槽位 id 判,见 panel-tree.js 的 viewsOpenIn);
//   · "看得见没有"是另一件事(一格能塞好几个标签,只有当前那个看得见);
//   · "哪些视图存在"来自注册表,而注册表是动态的(插件启用/停用会让短剧画布这类视图出现或消失)。
// 放在页面里没法单测(它要一个真布局树),抽出来之后"用户档里明明开着却没勾 / 勾着却点不动"
// 这类回归可以用 `node --test` 直接钉住 —— 不必开窗口、也不必点原生菜单。
import { viewsOpenIn, activeViewsIn } from './panel-tree.js';

/**
 * @param {{knownIds?:string[], titleOf?:(id:string)=>(string|null|undefined), tree?:object|null}} [options]
 * @returns {Array<{id:string, label:string, open:boolean, active:boolean}>} 交给 buildMenuTemplate 的 views
 */
export function panelMenuTable({ knownIds = [], titleOf = () => null, tree = null } = {}) {
    const open = viewsOpenIn(tree);
    const active = activeViewsIn(tree);
    return (Array.isArray(knownIds) ? knownIds : [])
        .filter((id) => typeof id === 'string' && id !== '')
        .map((id) => {
            const title = titleOf(id);
            return {
                id,
                label: (typeof title === 'string' && title !== '') ? title : id,
                open: open.has(id),
                // `active` 只在 open 为真时有意义;这里照实报,菜单那边按 (open && active) 判"无事可做"。
                active: open.has(id) && active.has(id),
            };
        });
}

/**
 * 把窗口菜单里的工具面板和普通工作台面板分开。
 * 工具注册信息是动态的,但只有已经登记为 pane 的 workspacePane 工具才能进入菜单;
 * 同一个工具视图不会再重复出现在普通面板组。
 */
export function splitPanelMenuTables({ knownIds = [], tools = [], titleOf = () => null, tree = null } = {}) {
    const known = Array.isArray(knownIds) ? knownIds : [];
    const toolIds = (Array.isArray(tools) ? tools : [])
        .filter((tool) => tool?.workspacePane === true
            && typeof tool.pluginId === 'string' && tool.pluginId !== ''
            && typeof tool.id === 'string' && tool.id !== '')
        .map((tool) => `tool:${tool.pluginId}:${tool.id}`)
        .filter((id) => known.includes(id));
    const toolIdSet = new Set(toolIds);
    return {
        views: panelMenuTable({ knownIds: known.filter((id) => !toolIdSet.has(id)), titleOf, tree }),
        tools: panelMenuTable({ knownIds: toolIds, titleOf, tree }),
    };
}
