# 笔记画布双击新建文本节点实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在可编辑笔记画布空白处双击时，于鼠标位置新建空白文本节点并立即进入节点内编辑。

**Architecture:** 在 `canvas-view.js` 的画布事件层增加双击入口，过滤节点和连线目标，复用现有 `worldPoint`、`addNode`、选择状态、渲染和 `enterInlineEdit`。文本节点创建器保留调用方显式提供的空字符串；工具栏未提供文本时仍显示现有提示语。

**Tech Stack:** Electron renderer DOM、ES modules、Node.js 22、`node:test`。

## Global Constraints

- 只响应画布空白处的双击；双击已有节点、节点控制点或连线不创建新节点，现有行为保持不变。
- 只在画布可编辑且当前画布已加载时创建节点；只读或未加载状态不产生变更。
- 使用双击屏幕坐标经现有 `worldPoint` 换算后的画布坐标，将新建节点中心放在双击位置，避免缩放或平移时坐标偏移。
- 创建空白文本节点，选中该节点并立即启用节点内 Markdown 编辑器，焦点落在正文中以便直接输入。新建内容不写入工具栏当前使用的教学提示文本。
- 新建沿用现有文本节点尺寸、保存/自动保存和选择状态逻辑；节点仍通过现有画布会话持久化。新建流程可显式指定空文本，同时保留工具栏创建节点的默认提示语。
- 不引入新依赖；不改变既有节点单击选择、二次点击编辑、画布导航和边编辑行为。

---

### Task 1: 在画布空白处双击创建并编辑文本节点

**Files:**
- Modify: `plugins/note-canvas/canvas-view.js`
- Create: `tests/note-canvas-double-click.test.js`

**Interfaces:**
- Consumes: 现有 `worldPoint(clientX, clientY)`、`addNode(type, fields, point)`、`cardById(id)` 和 `enterInlineEdit(card, event)`。
- Produces: `createTextAtDoubleClick(event)` 画布事件处理器；节点创建支持区分未提供 `text` 与显式空字符串。

- [ ] **Step 1: 写失败测试，锁定创建器兼容性与双击范围**

新建 `tests/note-canvas-double-click.test.js`：

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../plugins/note-canvas/canvas-view.js', import.meta.url), 'utf8');
const addNodeBody = source.match(/function addNode\(type,fields=\{\},point\)\{([\s\S]*?)\n    \}/)?.[1] ?? '';
const doubleClickBody = source.match(/function createTextAtDoubleClick\(event\)\{([\s\S]*?)\n    \}/)?.[1] ?? '';

test('text node creation keeps the toolbar hint only when text is omitted', () => {
    assert.match(addNodeBody, /Object\.hasOwn\(fields,'text'\)/);
    assert.match(addNodeBody, /n\.text='单击选择，再次点击编辑'/);
});

test('blank canvas double click creates an empty centered text node and starts inline editing', () => {
    assert.ok(doubleClickBody, 'double-click handler exists');
    assert.match(doubleClickBody, /if\(!editable\(\)\)return/);
    assert.match(doubleClickBody, /\.nc-node,\.nc-edge/);
    assert.match(doubleClickBody, /worldPoint\(event\.clientX,event\.clientY\)/);
    assert.match(doubleClickBody, /addNode\('text',\{text:''\},point\)/);
    assert.match(doubleClickBody, /enterInlineEdit\(card,event\)/);
    assert.match(source, /listen\(canvas,'dblclick',createTextAtDoubleClick\)/);
});
```

- [ ] **Step 2: 运行新测试，确认当前代码失败**

Run: `node --test tests/note-canvas-double-click.test.js`

Expected: FAIL，因为当前创建器会覆盖空字符串，且画布还没有空白处双击处理器。

- [ ] **Step 3: 保留显式空文本，并接入受限双击处理器**

在 `addNode` 中将创建对象和默认提示赋值改为：

```js
const n={id:uid(),type,x:Math.round(origin.x),y:Math.round(origin.y),width:280,height:180,...fields};
if(type==='text'&&!Object.hasOwn(fields,'text'))n.text='单击选择，再次点击编辑';
```

在 `enterInlineEdit` 后添加处理器：

```js
function createTextAtDoubleClick(event){
    if(!editable())return;
    const target=event.target?.closest?event.target:event.target?.parentElement;
    if(target?.closest?.('.nc-node,.nc-edge'))return;
    event.preventDefault();
    clickCandidate=null;
    const point=worldPoint(event.clientX,event.clientY);
    const node=addNode('text',{text:''},point);
    if(!node)return;
    const card=cardById(node.id);
    if(card)enterInlineEdit(card,event);
}
```

将监听器放在现有画布监听器附近：

```js
listen(canvas,'dblclick',createTextAtDoubleClick);
```

`addNode` 已将传入点作为节点中心并自动选中、渲染；因此 handler 使用现有坐标转换和创建流程即可。`.nc-node` 覆盖节点正文与端口/尺寸控制器，`.nc-edge` 覆盖连线，过滤后只在空白画布上触发。

- [ ] **Step 4: 运行相关测试并核对交互回归**

Run: `node --test tests/note-canvas-double-click.test.js tests/note-canvas-integration.test.js tests/note-canvas-rendering.test.js tests/note-canvas-theme.test.js tests/note-canvas-text-rendering.test.js tests/note-canvas-zoom-layout.test.js tests/note-canvas-port-hover.test.js tests/note-canvas.test.js tests/canvas-navigation.test.js tests/canvas-session.test.js`

Expected: 所有列出的测试 PASS。

在重启后的开物笔记画布手动确认：

1. 在空白处双击，只创建一个空文本节点；节点中心落在双击点，且正文立即获得焦点。
2. 输入 Markdown 和换行，内容按现有编辑/保存行为更新。
3. 改变画布平移和缩放后重复双击，节点仍出现在指针下方。
4. 双击节点（包括端口和尺寸控制器）或连线不额外创建节点；连线原有双击编辑行为正常。
5. 工具栏“文本”仍保留默认提示语；画布不可编辑或尚未加载时双击不创建。
6. 按用户的常驻偏好，测试通过后重启开物并确认画布可打开。

- [ ] **Step 5: 只提交本任务文件**

```powershell
git add -- tests/note-canvas-double-click.test.js plugins/note-canvas/canvas-view.js
git commit --only -m "feat: create note text node on canvas double click" -- tests/note-canvas-double-click.test.js plugins/note-canvas/canvas-view.js
```

提交前检查仅本任务文件进入提交，保留仓库现有的其他暂存和未暂存改动。

## 自审

- 规格覆盖：空白处双击创建、世界坐标定位、空内容、选中并立即编辑、只读保护、节点/连线过滤、原工具栏默认提示、导航与既有点击行为不变，均由 Task 1 覆盖。
- 无占位步骤：测试源码、命令、预期结果、实现代码、手动验收项和提交命令均明确。
- 接口一致：处理器使用已经存在的 `worldPoint`、`addNode`、`cardById` 和 `enterInlineEdit`；不增加新的运行时接口。
