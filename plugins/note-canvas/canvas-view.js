import { renderMarkdownNodes } from 'toolbox://shell/lib/markdown.js';
import { mountLiveMarkdown } from 'toolbox://shell/lib/live-markdown.js';
import { onEnd } from 'toolbox://shell/lib/drag-bus.js';
import { createNavigation } from './navigation.js';
import { createZoomLayout } from './zoom-layout.js';
import { canvasViewStyles, screenToWorld } from './rendering.js';
import { createSession } from './session.js';

const imagePath = file => /\.(png|jpe?g|webp|gif|bmp)$/i.test(file);
const notePath = file => /\.(md|txt)$/i.test(file);
const safeUrl = value => { try { return ['http:','https:'].includes(new URL(value).protocol); } catch { return false; } };
const uid = () => crypto.randomUUID();
const contained = (a,b) => b.x>=a.x && b.y>=a.y && b.x+b.width<=a.x+a.width && b.y+b.height<=a.y+a.height;
const overlaps = (a,b) => a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y;

export function mountCanvas(host,ctx) {
    const doc=host.ownerDocument;let dead=false,epoch=0,listEpoch=0,session=null,library={boards:[],notes:[],images:[],vault:null};
    let selected=new Set(),clipboard=null,editor=null,modal=null,gesture=null,portSource=null,nearbyPort=null,space=false,vaultMismatch=false,lastPointer={x:40,y:40},clickCandidate=null,inlineEditId=null,draggedPointer=false;
    const resources=new Map(),scrollNavigations=new Set(),unsubs=[];let refreshing=null,loadingPath=null;
    function el(tag,className,text) {const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
    function button(text,action,className='') {const b=el('button',className,text);b.type='button';b.addEventListener('click',()=>Promise.resolve(action()).catch(showError));return b;}
    const pane=el('section','nc-pane');pane.tabIndex=0;pane.setAttribute('aria-label','笔记画布');
    const side=el('aside','nc-sidebar'),sideHead=el('div','nc-sidebar-head');sideHead.append(el('strong','','画布'),button('新建画布',newBoard),button('刷新',()=>refreshLibrary()));
    const boards=el('div','nc-boards'),assets=el('div','nc-assets');side.append(sideHead,boards,el('h3','','笔记与素材'),assets);
    const main=el('main','nc-main'),toolbar=el('div','nc-toolbar'),title=el('strong','nc-board-title','笔记画布'),status=el('span','nc-status','正在读取笔记库…');status.setAttribute('role','status');
    const imageInput=el('input','nc-image-input');imageInput.type='file';imageInput.accept='.png,.jpg,.jpeg,.webp,.gif,.bmp';imageInput.multiple=true;imageInput.hidden=true;
    const tools=el('div','nc-tools');tools.append(button('文本',()=>addNode('text')),button('分组',()=>addGroup()),button('链接',()=>linkForm()),button('图片',()=>imageInput.click()),button('保存',()=>flushActive()),button('导出草稿',exportDraft),button('素材',()=>pane.classList.toggle('show-assets'),'nc-assets-toggle'));
    toolbar.append(title,tools,status);const canvas=el('div','nc-canvas');canvas.tabIndex=0;canvas.setAttribute('aria-label','画布编辑区');
    const world=el('div','nc-world'),zoomLayer=el('div','nc-zoom'),motionLayer=el('div','nc-motion'),svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('nc-connections');const nodes=el('div','nc-nodes');motionLayer.append(svg,nodes);zoomLayer.append(motionLayer);world.append(zoomLayer);
    const empty=el('div','nc-empty',''),hint=el('div','nc-hint','空白框选 · Space / 中键平移 · Ctrl + 滚轮缩放 · Alt 选择正文');
    canvas.append(world,empty,hint);main.append(toolbar,canvas,imageInput);pane.append(side,main);host.replaceChildren(pane);
    const media=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduced=()=>media?.matches===true || doc.documentElement.dataset.motion==='off';
    const visible=()=>!dead && !doc.hidden && host.isConnected && host.getClientRects().length>0 && host.offsetWidth>0 && host.offsetHeight>0;
    const zoomLayout=createZoomLayout({initialScale:1,intervalMs:2000,onLayoutScale:scale=>{zoomLayer.style.zoom=String(scale);motionLayer.style.transform='scale(1)';}});
    const nav=createNavigation({view:{x:40,y:40,scale:1},reducedMotion:reduced,onFrame:view=>{
        if(!visible()){nav.stop();return;}const motionScale=reduced()?zoomLayout.sync(view.scale):zoomLayout.update(view.scale);const styles=canvasViewStyles(view,motionScale);world.style.transform=styles.worldTransform;motionLayer.style.transform=styles.motionTransform;
        canvas.style.backgroundPosition=styles.backgroundPosition;canvas.style.backgroundSize=styles.backgroundSize;
    },onSettled:()=>saveViewport()});
    nav.set({x:40,y:40,scale:1});
    function listen(target,type,fn,options) {target.addEventListener(type,fn,options);unsubs.push(()=>target.removeEventListener(type,fn,options));}
    function showError(error) {if(!dead){status.textContent=error?.message??String(error);status.classList.add('error');}}
    function updateStatus(){if(dead)return;status.classList.toggle('error',!!session?.error||vaultMismatch);
        status.textContent=vaultMismatch?'笔记库已切换；旧草稿已保留，请导出':session?.error?`${session.error.message} · 草稿已保留，可重试保存`:editor?'正在编辑':session?.saving?'正在保存…':Object.keys(session?.extras.inlineMarkdown??{}).length?'原笔记有未保存修改 · 可在节点内保存':session?.dirty?'未保存 · 800ms 后自动保存':session?'已保存':library.reason||'新建画布，或从左侧打开画布';}
    const editable=()=>session && !vaultMismatch && session.vault===library.vault;
    function mutate(fn){if(!editable()){showError(Error('请先打开当前笔记库的画布；旧草稿可导出'));return false;}session.edit(fn);return true;}
    function saveViewport(){if(editable()){const view=nav.view;if(JSON.stringify(session.graph.viewport)!==JSON.stringify(view))mutate(g=>g.viewport=view);}}
    function clearConnection(){portSource=null;pane.querySelectorAll('.nc-port.connecting').forEach(p=>p.classList.remove('connecting'));if(gesture?.kind==='port'){try{if(canvas.hasPointerCapture(gesture.pointer))canvas.releasePointerCapture(gesture.pointer);}catch{}gesture=null;}}
    function clearNearbyPort(){nearbyPort?.classList.remove('nearby');nearbyPort=null;}
    function revealNearestPort(event){let nearest=null,nearestDistance=54;
        for(const port of nodes.querySelectorAll('.nc-port')){const rect=port.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,distance=Math.hypot(event.clientX-x,event.clientY-y);
            if(distance>nearestDistance)continue;const card=port.closest('.nc-node'),topCard=doc.elementFromPoint(x,y)?.closest('.nc-node');if(topCard&&topCard!==card)continue;
            nearest=port;nearestDistance=distance;
        }
        if(nearbyPort===nearest)return;nearbyPort?.classList.remove('nearby');nearbyPort=nearest;nearbyPort?.classList.add('nearby');
    }
    function stopMotion(){clearConnection();nav.stop();scrollNavigations.forEach(n=>n.stop());if(gesture){gesture=null;canvas.classList.remove('panning');pane.querySelector('.nc-marquee')?.remove();}}
    function stopBodyMotion(){scrollNavigations.forEach(n=>n.dispose());scrollNavigations.clear();}
    function worldPoint(clientX,clientY){const rect=canvas.getBoundingClientRect(),v=nav.view;return screenToWorld(clientX,clientY,rect,v);}
    function center(){const r=canvas.getBoundingClientRect();return worldPoint(r.left+r.width/2,r.top+r.height/2);}
    function validAsync(stamp,current){return !dead&&stamp===epoch&&current===session&&!vaultMismatch;}

    async function refreshLibrary(){
        const stamp=++listEpoch;
        const pending=ctx.canvas.library();refreshing=pending;
        try {const result=await pending;if(dead||stamp!==listEpoch)return;
            const changed=library.vault!==result.vault;library=result;
            if(changed && session && session.vault!==result.vault){stopMotion();exitInlineEdit();clickCandidate=null;epoch++;vaultMismatch=true;resources.clear();if(editor){editor.setDisabled(true);editor.save.disabled=true;}nodes.querySelectorAll('.live-markdown-content').forEach(content=>{content.contentEditable='false';content.setAttribute('aria-disabled','true');content.closest('.nc-node')?.querySelectorAll('.live-markdown-tool,.nc-note-save,.nc-note-reload').forEach(control=>control.disabled=true);});updateStatus();}
            renderLibrary();
            if(!session && result.boards.length)await openBoard(result.boards[0].path);
            else if(!session){empty.hidden=false;empty.textContent=result.reason||'这座笔记库还没有画布。点击「新建画布」开始。';updateStatus();}
        } catch(err){showError(err);} finally {if(refreshing===pending)refreshing=null;}
    }
    function renderLibrary(){boards.replaceChildren();assets.replaceChildren();
        for(const board of library.boards){const b=button(board.name,()=>openBoard(board.path),'nc-board-row');b.dataset.path=board.path;b.classList.toggle('active',board.path===session?.path&&library.vault===session?.vault);boards.append(b);}
        for(const item of [...library.notes,...library.images]){const b=button(item.title??item.name,()=>addFile(item.path),'nc-asset-row');b.dataset.file=item.path;b.draggable=true;b.title=item.path;b.addEventListener('dragstart',event=>event.dataTransfer.setData('application/x-kaiwu-note',JSON.stringify({file:item.path,vault:library.vault})));assets.append(b);}
        sideHead.querySelectorAll('button')[0].disabled=!library.vault;
    }
    async function flushActive(){if(editor && editor.readText()!==editor.original)throw Error('请先应用或保存当前编辑；编辑草稿已保留');if(vaultMismatch)throw Error('笔记库已切换；请导出旧草稿');if(session)await session.flush();updateStatus();}
    async function openBoard(path){
        if(session?.path===path && session.vault===library.vault && !vaultMismatch){if(loadingPath){epoch++;loadingPath=null;clearConnection();resources.clear();renderGraph();}return;}
        await flushActive();if(dead)return;const stamp=++epoch,vault=library.vault;stopMotion();
        loadingPath=path;let result;try{result=await ctx.canvas.read(path,vault);}finally{if(stamp===epoch)loadingPath=null;}if(dead||stamp!==epoch||vault!==library.vault||result.vault!==vault)return;
        session?.dispose();session=createSession({...result,write:ctx.canvas.write,changed:updateStatus});vaultMismatch=false;selected.clear();resources.clear();clearConnection();
        title.textContent=path.split('/').pop().replace(/\.canvas$/i,'');const viewport=session.graph.viewport??{x:40,y:40,scale:1};zoomLayout.sync(viewport.scale);nav.set(viewport);renderLibrary();renderGraph();updateStatus();
        const draft=session.extras.editor;if(draft)openEditorDraft(draft);
    }
    function closeModal(){modal?.remove();modal=null;}
    function form(caption,initial,submit,{action='应用',placeholder=''}={}){
        closeModal();const overlay=el('div','nc-overlay'),f=el('form','nc-form'),heading=el('h3','',caption),input=el('input');input.value=initial;input.placeholder=placeholder;input.required=true;
        const error=el('p','nc-form-error'),actions=el('div','nc-form-actions'),apply=el('button','',action);apply.type='submit';actions.append(button('取消',closeModal),apply);f.append(heading,input,error,actions);overlay.append(f);pane.append(overlay);modal=overlay;
        f.addEventListener('submit',async event=>{event.preventDefault();apply.disabled=true;try{await submit(input.value);if(modal===overlay)closeModal();}catch(err){error.textContent=err.message;}finally{apply.disabled=false;}});input.focus();return f;
    }
    function newBoard(){if(!library.vault)return;form('新建画布','',async name=>{
        await flushActive();stopMotion();const vault=library.vault,stamp=++epoch,result=await ctx.canvas.create(name.trim(),vault);
        if(dead||stamp!==epoch||vault!==library.vault||result.vault!==vault)return;
        session?.dispose();session=createSession({...result,write:ctx.canvas.write,changed:updateStatus});selected.clear();resources.clear();clearConnection();vaultMismatch=false;title.textContent=name.trim();zoomLayout.sync(1);nav.set({x:40,y:40,scale:1});renderGraph();updateStatus();await refreshLibrary();
    },{action:'创建',placeholder:'画布名称'});}
    function addNode(type,fields={},point){
        let origin;
        if(point)origin={x:point.x-140,y:point.y-90};
        else{const r=canvas.getBoundingClientRect(),start=worldPoint(r.left+30,r.top+30),cols=Math.max(1,Math.floor((r.width/nav.view.scale-60)/310));let index=0;
            do{origin={x:start.x+(index%cols)*310,y:start.y+Math.floor(index/cols)*210};index++;}while(index<1001 && session?.graph.nodes.some(n=>n.type!=='group'&&overlaps({...origin,width:280,height:180},n)));}
        const n={id:uid(),type,x:Math.round(origin.x),y:Math.round(origin.y),width:280,height:180,...fields};if(type==='text'&&!Object.hasOwn(fields,'text'))n.text='单击选择，再次点击编辑';
        if(!mutate(g=>g.nodes.push(n)))return;selected=new Set([n.id]);renderGraph();return n;
    }
    function addFile(file,point){if(!notePath(file)&&!imagePath(file)){showError(Error('只支持 Markdown、TXT 和位图素材'));return;}return addNode('file',{file},point);}
    function addGroup(){if(!editable())return;const members=session.graph.nodes.filter(n=>selected.has(n.id));let area;
        if(members.length){const x=Math.min(...members.map(n=>n.x)),y=Math.min(...members.map(n=>n.y));area={x:x-30,y:y-40,width:Math.max(...members.map(n=>n.x+n.width))-x+60,height:Math.max(...members.map(n=>n.y+n.height))-y+70};}
        else{const p=center();area={x:p.x-210,y:p.y-150,width:420,height:300};}
        const group={id:uid(),type:'group',label:'分组',...area};mutate(g=>g.nodes.push(group));selected=new Set([group.id]);renderGraph();}
    function linkForm(){if(!editable())return;form('添加网页链接','',url=>{if(!safeUrl(url))throw Error('只支持有效的 HTTP/HTTPS 链接');addNode('link',{url,label:url});},{action:'添加',placeholder:'https://…'});}
    async function importImages(files,point=center()){
        if(!editable())throw Error('请先打开画布');const current=session,stamp=epoch,vault=current.vault;
        for(const file of files){if(!imagePath(file.name)||file.size>20*1024*1024)throw Error('仅支持 20 MiB 以内的 PNG/JPEG/WEBP/GIF/BMP');
            const bytes=await file.arrayBuffer();if(!validAsync(stamp,current))return;
            const extension=file.name.split('.').pop().toLowerCase(),mimeType=file.type||({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',bmp:'image/bmp'}[extension]);
            const result=await ctx.canvas.importImage(current.path,{name:file.name,bytes,mimeType},vault);if(!validAsync(stamp,current)||result.vault!==vault)return;
            addFile(result.file,point);point={x:point.x+32,y:point.y+32};
        }imageInput.value='';
    }
    function exportDraft(){if(!session)return;const data={path:session.path,graph:session.graph,editDrafts:session.extras};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=`${title.textContent||'画布'}-草稿.json`;pane.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0);}

    // The facade prevents img.src from ever being set on a real image element.
    const safeDoc={createTextNode:text=>doc.createTextNode(text),createElement:tag=>{
        if(tag!=='img')return doc.createElement(tag);const span=el('span','nc-remote-image','[远程图片未自动加载]');
        const set=span.setAttribute.bind(span);span.setAttribute=(name,value)=>{if(name==='alt'){set('data-markdown-image-alt',value);span.textContent=`[图片：${value||'未命名'} · 未自动加载]`;}else if(name==='src')set('data-markdown-image-url',value);else set(name,value);};return span;
    }};
    function markdown(body,text){body.replaceChildren(...renderMarkdownNodes(safeDoc,text,{tables:true}));}
    function paintSelection(){nodes.querySelectorAll('.nc-node').forEach(n=>n.classList.toggle('selected',selected.has(n.dataset.nodeId)));}
    const cardById=id=>[...nodes.children].find(card=>card.dataset.nodeId===id);
    function titleOf(node){return node.label||(node.type==='file'?node.file:node.type==='text'?'文本':node.type==='group'?'分组':'网页链接');}
    function position(element,node){Object.assign(element.style,{left:`${node.x}px`,top:`${node.y}px`,width:`${node.width}px`,height:`${node.height}px`});}
    function exitInlineEdit(){if(!inlineEditId)return;const card=cardById(inlineEditId);card?._ncLiveMarkdown?.setDisabled(true);card?.classList.remove('editing');inlineEditId=null;}
    function canClickEdit(node,card){if(!editable())return false;if(node.type==='text'||node.type==='group')return true;return node.type==='file'&&notePath(node.file)&&card.dataset.nodeEditable==='true';}
    function focusLiveSurface(surface,event){surface.focus({preventScroll:true});let range=doc.caretRangeFromPoint?.(event.clientX,event.clientY);
        if(!range){const caret=doc.caretPositionFromPoint?.(event.clientX,event.clientY);if(caret){range=doc.createRange();range.setStart(caret.offsetNode,caret.offset);range.collapse(true);}}
        if(!range||!surface.contains(range.startContainer))return;const selection=doc.getSelection();if(!selection)return;selection.removeAllRanges();selection.addRange(range);}
    function enterInlineEdit(card,event){const surface=card.querySelector('.live-markdown-content'),mounted=card._ncLiveMarkdown;if(!surface||!mounted)return;
        exitInlineEdit();mounted.setDisabled(false);inlineEditId=card.dataset.nodeId;card.classList.add('editing');focusLiveSurface(surface,event);}
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
    function nodeClick(event){const target=event.target?.closest?event.target:event.target?.parentElement,card=target?.closest?.('.nc-node'),id=card?.dataset.nodeId;
        if(inlineEditId){const active=cardById(inlineEditId)?.querySelector('.live-markdown-content');if(id===inlineEditId&&active?.contains(target)){clickCandidate=null;return;}exitInlineEdit();}
        if(draggedPointer){draggedPointer=false;clickCandidate=null;return;}
        if(event.shiftKey||!card||target.closest('button,a,input,textarea,select,.nc-port,.nc-resize,[contenteditable="true"]')){clickCandidate=null;return;}
        const node=session?.graph.nodes.find(item=>item.id===id);if(!node||!canClickEdit(node,card)){clickCandidate=null;return;}
        if(clickCandidate!==id){clickCandidate=id;return;}
        clickCandidate=null;
        if(node.type==='text'||node.type==='file'&&/\.md$/i.test(node.file))enterInlineEdit(card,event);
        else void editNode(id).catch(showError);
    }
    function nodeElement(node){
        const card=el('article','nc-node');card.dataset.nodeId=node.id;card.dataset.type=node.type;position(card,node);
        card.dataset.nodeEditable=String(node.type==='text'||node.type==='group');
        if(node.color){const colors=['#c55b65','#ca8752','#c4af55','#62aa84','#648ec8','#9573c3'];card.style.setProperty('--node-color',colors[Number(node.color)-1]??node.color);}
        const head=el('div','nc-node-head'),label=el('span','nc-node-title',titleOf(node));head.append(label);
        if(node.type==='file'&&/\.md$/i.test(node.file)){const save=button('保存',()=>saveInlineNote(node.id,save),'nc-note-save'),reload=button('重载原文',()=>reloadInlineNote(node.id,reload),'nc-note-reload');save.disabled=true;reload.hidden=true;head.append(save,reload);}
        const body=el('div','nc-node-body');if(node.type==='text'){card._ncLiveMarkdown=mountLiveMarkdown(body,node.text,{resolveLink:()=>true,renderDocument:safeDoc,showToolbar:false,onInput:text=>{if(!body.isConnected||!editable())return;mutate(g=>{const target=g.nodes.find(item=>item.id===node.id);if(target)target.text=text;});}});card._ncLiveMarkdown.setDisabled(true);attachBodyScroll(body.querySelector('.live-markdown-content'),node.id);}
        else if(node.type==='file'){body.textContent='正在读取…';void loadFile(node,body,card);}
        else if(node.type==='link'){body.append(el('p','',node.url),button('打开链接',()=>safeUrl(node.url)?ctx.shell.openExternal(node.url):Promise.reject(Error('链接地址不安全'))));}
        body.addEventListener('click',event=>{const link=event.target.closest('a');if(!link)return;event.preventDefault();event.stopPropagation();const url=link.getAttribute('href');if(safeUrl(url))ctx.shell.openExternal(url).catch(showError);});
        if(node.type==='text')card.append(body);else card.append(head,body);for(const side of ['top','right','bottom','left']){const port=el('button','nc-port');port.type='button';port.dataset.side=side;port.setAttribute('aria-label',`${side} 连接端口`);port.addEventListener('click',()=>portClick(node.id,side));card.append(port);}
        const resize=el('div','nc-resize');resize.title='拖动调整大小';card.append(resize);attachBodyScroll(body,node.id);return card;
    }
    async function resource(file){if(resources.has(file))return resources.get(file);const current=session,stamp=epoch;
        const promise=(imagePath(file)?ctx.canvas.media(file,current.vault):ctx.canvas.readNote(file,current.vault)).then(result=>{if(!validAsync(stamp,current)||result.vault!==current.vault)throw Error('笔记库或画布已经切换');return result;});
        resources.set(file,promise);promise.catch(()=>{if(resources.get(file)===promise)resources.delete(file);});return promise;
    }
    async function loadFile(node,body,card){const current=session,stamp=epoch;try{const result=await resource(node.file);if(!validAsync(stamp,current)||!card.isConnected)return;
        if(imagePath(node.file)){card.dataset.nodeEditable='false';const img=el('img');img.alt=node.file;img.draggable=false;img.src=result.dataUrl;body.classList.add('nc-image-body');body.replaceChildren(img);}
        else if(result.kind==='markdown'){
            const savedDraft=current.extras.inlineMarkdown?.[node.id],original=savedDraft?.original??result.text,revision=savedDraft?.revision??result.revision,start=savedDraft?.text??result.text,canEdit=result.editable!==false&&!vaultMismatch;
            card.dataset.nodeEditable=String(canEdit);
            const save=card.querySelector('.nc-note-save'),reload=card.querySelector('.nc-note-reload'),error=el('p','nc-inline-error',savedDraft?.error??'');error.hidden=!savedDraft?.error;reload.hidden=!/^原笔记已被外部修改/.test(savedDraft?.error??'');
            card._ncLiveMarkdown=mountLiveMarkdown(body,start,{resolveLink:()=>true,renderDocument:safeDoc,showToolbar:false,onInput:text=>{if(!body.isConnected||!validAsync(stamp,current))return;const drafts={...(current.extras.inlineMarkdown??{})};
                if(text===original)delete drafts[node.id];else drafts[node.id]={text,original,revision,editable:canEdit,reason:result.reason,error:''};
                const extras=current.extras;if(Object.keys(drafts).length)extras.inlineMarkdown=drafts;else delete extras.inlineMarkdown;current.setExtras(extras);
                save.disabled=!canEdit||text===original;error.hidden=true;updateStatus();}});
            card._ncLiveMarkdown.setDisabled(true);
            if(!canEdit){save.disabled=true;save.title=result.reason||'该笔记为只读';}
            else save.disabled=start===original;
            body.append(error);attachBodyScroll(body.querySelector('.live-markdown-content'),node.id);
        } else {card.dataset.nodeEditable=String(result.editable!==false&&!vaultMismatch);body.textContent=result.text;body.classList.add('nc-text-body');}
    }catch(error){if(validAsync(stamp,current)&&card.isConnected)body.textContent=error.message;}}
    function renderGraph(){exitInlineEdit();clickCandidate=null;draggedPointer=false;clearNearbyPort();stopBodyMotion();nodes.replaceChildren();svg.replaceChildren();if(!session){empty.hidden=false;return;}empty.hidden=true;
        for(const node of [...session.graph.nodes].sort((a,b)=>(a.type==='group'?-1:0)-(b.type==='group'?-1:0)))nodes.append(nodeElement(node));paintSelection();if(portSource)cardById(portSource.node)?.querySelector(`.nc-port[data-side="${portSource.side}"]`)?.classList.add('connecting');renderEdges();}
    function endpoint(node,side='right'){return{x:node.x+(side==='left'?0:side==='right'?node.width:node.width/2),y:node.y+(side==='top'?0:side==='bottom'?node.height:node.height/2)};}
    function renderEdges(){svg.replaceChildren();if(!session)return;const lookup=new Map(session.graph.nodes.map(n=>[n.id,n]));
        for(const edge of session.graph.edges){const from=lookup.get(edge.fromNode),to=lookup.get(edge.toNode);if(!from||!to)continue;const a=endpoint(from,edge.fromSide),b=endpoint(to,edge.toSide??'left');
            const group=doc.createElementNS(svg.namespaceURI,'g'),path=doc.createElementNS(svg.namespaceURI,'path');group.dataset.edgeId=edge.id;group.classList.add('nc-edge');path.setAttribute('d',`M ${a.x} ${a.y} C ${a.x+(b.x-a.x)/2} ${a.y}, ${a.x+(b.x-a.x)/2} ${b.y}, ${b.x} ${b.y}`);group.append(path);
            if(edge.label){const label=doc.createElementNS(svg.namespaceURI,'text');label.classList.add('nc-edge-label');label.setAttribute('x',(a.x+b.x)/2);label.setAttribute('y',(a.y+b.y)/2-8);label.textContent=edge.label;group.append(label);}
            group.addEventListener('dblclick',()=>edgeForm(edge));svg.append(group);
        }
    }
    function edgeForm(edge){form('编辑连线标签',edge.label||'',label=>{mutate(g=>g.edges.find(e=>e.id===edge.id).label=label);renderEdges();});const remove=button('移除连线',()=>{mutate(g=>g.edges=g.edges.filter(e=>e.id!==edge.id));renderEdges();closeModal();});modal?.querySelector('.nc-form-actions').prepend(remove);modal?.querySelector('input').removeAttribute('required');}
    function connect(target,side){if(!portSource)return;const source=portSource;clearConnection();if(!editable()||!session.graph.nodes.some(n=>n.id===source.node)||!session.graph.nodes.some(n=>n.id===target))return;
        if(source.node===target){showError(Error('不能连接到自身'));return;}mutate(g=>g.edges.push({id:uid(),fromNode:source.node,toNode:target,fromSide:source.side,toSide:side}));renderEdges();}
    function portClick(node,side){if(!editable())return;if(portSource)connect(node,side);else if(session.graph.nodes.some(n=>n.id===node)){portSource={node,side};cardById(node)?.querySelector(`.nc-port[data-side="${side}"]`)?.classList.add('connecting');}}
    function attachBodyScroll(body,nodeId){let scrollNav;scrollNav=createNavigation({view:{x:0,y:0,scale:1},reducedMotion:reduced,onFrame:v=>{
        if(!visible()||!body.isConnected){scrollNav.stop();return;}body.scrollLeft=v.x;body.scrollTop=v.y;if(Math.abs(body.scrollLeft-v.x)>.5||Math.abs(body.scrollTop-v.y)>.5)scrollNav.set({x:body.scrollLeft,y:body.scrollTop,scale:1});}});scrollNavigations.add(scrollNav);
        body.addEventListener('wheel',event=>{if(!visible()||!selected.has(nodeId))return;event.preventDefault();event.stopPropagation();if(event.ctrlKey||event.metaKey){wheelNavigation(event);return;}const d=wheelDelta(event,body);scrollNav.pan(d.x,d.y,event.deltaMode===0&&Math.abs(event.deltaY)<50);},{passive:false});
        body.addEventListener('scroll',()=>{if(!scrollNav)return;const v=scrollNav.view;if(Math.abs(v.x-body.scrollLeft)>1||Math.abs(v.y-body.scrollTop)>1)scrollNav.set({x:body.scrollLeft,y:body.scrollTop,scale:1});});
    }
    function wheelDelta(event,area){const multiplier=event.deltaMode===1?16:event.deltaMode===2?area.clientHeight:1;let x=event.deltaX*multiplier,y=event.deltaY*multiplier;if(event.shiftKey&&x===0){x=y;y=0;}return{x,y};}
    function wheelNavigation(event){if(!editable()||!visible())return;const d=wheelDelta(event,canvas),r=canvas.getBoundingClientRect();if(event.ctrlKey||event.metaKey)nav.zoom(Math.exp(-d.y*.0015),event.clientX-r.left,event.clientY-r.top);else nav.pan(-d.x,-d.y,event.deltaMode===0&&Math.abs(event.deltaY)<50);}
    function clearInlineDraft(id){if(!session)return;const extras=session.extras,drafts={...(extras.inlineMarkdown??{})};delete drafts[id];if(Object.keys(drafts).length)extras.inlineMarkdown=drafts;else delete extras.inlineMarkdown;session.setExtras(extras);}
    async function reloadInlineNote(id,button){if(!editable())throw Error('笔记库已经切换，请导出旧草稿');const current=session,node=current.graph.nodes.find(item=>item.id===id),stamp=epoch;if(!node)return;
        if(doc.defaultView?.confirm&&!doc.defaultView.confirm('重载原文会丢弃此节点未保存的修改，是否继续？'))return;button.disabled=true;
        try{const latest=await ctx.canvas.readNote(node.file,current.vault);if(!validAsync(stamp,current)||latest.vault!==current.vault)throw Error('笔记库已切换；草稿仍保留');resources.set(node.file,Promise.resolve(latest));clearInlineDraft(id);renderGraph();updateStatus();}
        catch(error){showError(error);}finally{if(button.isConnected)button.disabled=false;}}
    async function saveInlineNote(id,button){if(!editable())throw Error('笔记库已经切换，请导出旧草稿');const current=session,node=current.graph.nodes.find(item=>item.id===id),draft=current.extras.inlineMarkdown?.[id];if(!node||!draft||draft.editable===false)return;
        button.disabled=true;try{const latest=await ctx.canvas.readNote(node.file,current.vault);if(!validAsync(epoch,current)||latest.vault!==current.vault)throw Error('笔记库已切换；编辑草稿已保留');
            if(latest.revision!==draft.revision||latest.text!==draft.original)throw Error('原笔记已被外部修改；节点内草稿已保留，请检查后重新载入原文');
            const saved=await ctx.canvas.writeNote(node.file,draft.text,draft.revision,current.vault);if(!validAsync(epoch,current)||saved.vault!==current.vault)throw Error('笔记库已切换；编辑草稿已保留');
            resources.delete(node.file);clearInlineDraft(id);renderGraph();updateStatus();
        }catch(error){if(validAsync(epoch,current)){const extras=current.extras,drafts={...(extras.inlineMarkdown??{})},previous=drafts[id];if(previous)drafts[id]={...previous,error:error.message};current.setExtras({...extras,...(Object.keys(drafts).length?{inlineMarkdown:drafts}:{})});const card=cardById(id),message=card?.querySelector('.nc-inline-error');if(message){message.textContent=error.message;message.hidden=false;}if(/^原笔记已被外部修改/.test(error.message)){const reload=card?.querySelector('.nc-note-reload');if(reload)reload.hidden=false;}showError(error);}}
        finally{if(button.isConnected)button.disabled=!current.extras.inlineMarkdown?.[id]||current.extras.inlineMarkdown[id].editable===false;}}
    async function editNode(id){if(!editable())throw Error('笔记库已经切换，请导出旧草稿');const node=session.graph.nodes.find(n=>n.id===id);if(!node)return;
        if(node.type==='group'){form('分组名称',node.label??'',label=>{mutate(g=>g.nodes.find(n=>n.id===id).label=label);renderGraph();});return;}
        if(node.type==='text'){openEditorDraft({kind:'text',nodeId:id,text:node.text,original:node.text});return;}
        if(node.type==='file'&&notePath(node.file)){const current=session,stamp=epoch,data=await ctx.canvas.readNote(node.file,current.vault);if(!validAsync(stamp,current)||data.vault!==current.vault)return;resources.set(node.file,Promise.resolve(data));
            openEditorDraft({kind:'note',nodeId:id,file:node.file,text:data.text,original:data.text,revision:data.revision,editable:data.editable,reason:data.reason});}
    }
    function openEditorDraft(draft){closeModal();const current=session,stamp=epoch;const overlay=el('div','nc-overlay'),content=el('div','nc-editor'),heading=el('h3','',draft.kind==='note'?`编辑原笔记 · ${draft.file}`:'编辑 Markdown 文本');
        const rich=draft.kind==='text'||(draft.kind==='note'&&/\.md$/i.test(draft.file));
        const textarea=rich?null:el('textarea'),surface=rich?el('div','nc-live-markdown'):null;
        if(textarea){textarea.value=draft.text;textarea.spellcheck=false;textarea.maxLength=200000;textarea.disabled=draft.editable===false||vaultMismatch;}
        const error=el('p','nc-form-error',draft.reason||''),actions=el('div','nc-form-actions');const cancel=button('取消',()=>{editor=null;const extras=current.extras;delete extras.editor;current.setExtras(extras);closeModal();updateStatus();});
        const save=button(draft.kind==='note'?'保存原文件':'应用',async()=>{
            if(!validAsync(stamp,current))throw Error('笔记库或画布已经切换，编辑草稿已保留');save.disabled=true;
            try {const text=readText();
                if(draft.kind==='note'){if(draft.editable===false)throw Error(draft.reason||'该笔记为只读');const latest=await ctx.canvas.readNote(draft.file,current.vault);
                    if(!validAsync(stamp,current)||latest.vault!==current.vault)throw Error('笔记库已切换');
                    if(latest.revision!==draft.revision||latest.text!==draft.original)throw Error('原笔记已被外部修改；编辑草稿已保留，请复制正文后重新打开');
                    const saved=await ctx.canvas.writeNote(draft.file,text,draft.revision,current.vault);if(!validAsync(stamp,current)||saved.vault!==current.vault)throw Error('笔记库已切换；编辑草稿已保留');resources.delete(draft.file);
                }else {if(text.length>200000)throw Error('文本节点不能超过 200000 字符');mutate(g=>{const node=g.nodes.find(n=>n.id===draft.nodeId);if(node)node.text=text;});}
                editor=null;const extras=current.extras;delete extras.editor;current.setExtras(extras);closeModal();renderGraph();updateStatus();
            } catch(err){error.textContent=err.message;showError(err);}finally{if(editor)save.disabled=draft.editable===false||vaultMismatch;}
        });save.disabled=textarea?.disabled??(draft.editable===false||vaultMismatch);actions.append(cancel,save);content.append(heading,rich?surface:textarea,error,actions);overlay.append(content);pane.append(overlay);modal=overlay;
        let changed=draft.text!==draft.original;
        const mounted=rich?mountLiveMarkdown(surface,draft.text,{resolveLink:()=>true,onInput:()=>{changed=true;remember();}}):null;
        function readText(){return mounted?(changed?mounted.value():draft.text):textarea.value;}
        function remember(){current.setExtras({...current.extras,editor:{...draft,text:mounted?(changed?mounted.value():draft.text):textarea?.value??draft.text}});}
        if(textarea)textarea.addEventListener('input',remember);remember();
        editor={...draft,textarea,input:surface??textarea,save,readText,setDisabled:disabled=>{if(textarea)textarea.disabled=disabled;else mounted?.setDisabled(disabled);}};updateStatus();if(mounted)mounted.focus();else textarea.focus();
    }

    function copySelection(){if(!session)return;clipboard={nodes:structuredClone(session.graph.nodes.filter(n=>selected.has(n.id))),edges:structuredClone(session.graph.edges.filter(e=>selected.has(e.fromNode)&&selected.has(e.toNode)))};}
    function paste(point){if(!clipboard?.nodes.length||!editable())return;const pasted=structuredClone(clipboard),mapping=new Map(pasted.nodes.map(n=>[n.id,uid()]));let dx=32,dy=32;
        if(point){dx=point.x-Math.min(...pasted.nodes.map(n=>n.x));dy=point.y-Math.min(...pasted.nodes.map(n=>n.y));}
        pasted.nodes.forEach(n=>{n.id=mapping.get(n.id);n.x+=dx;n.y+=dy;});pasted.edges.forEach(e=>{e.id=uid();e.fromNode=mapping.get(e.fromNode);e.toNode=mapping.get(e.toNode);});mutate(g=>{g.nodes.push(...pasted.nodes);g.edges.push(...pasted.edges);});selected=new Set(pasted.nodes.map(n=>n.id));renderGraph();}
    function deleteSelection(){if(!selected.size||editor)return;if(selected.has(portSource?.node)||gesture?.kind==='port'&&selected.has(gesture.node))clearConnection();mutate(g=>{g.nodes=g.nodes.filter(n=>!selected.has(n.id));g.edges=g.edges.filter(e=>!selected.has(e.fromNode)&&!selected.has(e.toNode));});selected.clear();renderGraph();}
    function contextMenu(event){if(!session||event.target.closest('input,textarea,[contenteditable="true"]'))return;event.preventDefault();pane.querySelector('.nc-context')?.remove();const card=event.target.closest('.nc-node'),edge=event.target.closest('.nc-edge');
        if(card&&!selected.has(card.dataset.nodeId)){selected=new Set([card.dataset.nodeId]);paintSelection();}
        const menu=el('div','nc-context'),r=pane.getBoundingClientRect();menu.style.left=`${Math.max(0,Math.min(r.width-150,event.clientX-r.left))}px`;menu.style.top=`${Math.max(0,Math.min(r.height-120,event.clientY-r.top))}px`;
        const act=fn=>()=>{menu.remove();fn();};if(edge){const data=session.graph.edges.find(e=>e.id===edge.dataset.edgeId);menu.append(button('编辑标签',act(()=>edgeForm(data))),button('移除连线',act(()=>{mutate(g=>g.edges=g.edges.filter(e=>e.id!==data.id));renderEdges();})));}
        else menu.append(button('复制',act(copySelection)),button('粘贴',act(()=>paste(worldPoint(event.clientX,event.clientY)))),button('删除',act(deleteSelection)));pane.append(menu);
    }
    function pointerDown(event){if(event.button===2||!editable())return;draggedPointer=false;pane.querySelector('.nc-context')?.remove();const target=event.target,card=target.closest('.nc-node'),port=target.closest('.nc-port');
        if(target.closest('input,textarea,select,a,button,[contenteditable="true"]')&&!port)return;
        nav.stop();const p=worldPoint(event.clientX,event.clientY);lastPointer=p;
        if(space||event.button===1){event.preventDefault();nav.stop();gesture={kind:'pan',x:event.clientX,y:event.clientY,view:nav.view,lastX:event.clientX,lastY:event.clientY,lastTime:performance.now(),vx:0,vy:0,started:false,pointer:event.pointerId};return;}
        if(port){gesture={kind:'port',node:card.dataset.nodeId,side:port.dataset.side,x:event.clientX,y:event.clientY,pointer:event.pointerId,started:false};return;}
        if(event.altKey||(!doc.getSelection()?.isCollapsed&&target.closest('.live-markdown-content[contenteditable="true"]')))return;
        if(card){const id=card.dataset.nodeId;if(event.shiftKey){if(selected.has(id))selected.delete(id);else selected.add(id);}else if(!selected.has(id))selected=new Set([id]);paintSelection();
            const node=session.graph.nodes.find(n=>n.id===id),resize=!!target.closest('.nc-resize');const moving=new Set(selected);if(node.type==='group'&&!resize)session.graph.nodes.filter(n=>n.id!==node.id&&contained(node,n)).forEach(n=>moving.add(n.id));
            gesture={kind:resize?'resize':'nodes',node:id,x:event.clientX,y:event.clientY,initial:session.graph.nodes.filter(n=>moving.has(n.id)).map(n=>({id:n.id,x:n.x,y:n.y,width:n.width,height:n.height})),pointer:event.pointerId,started:false};
        } else if(!target.closest('.nc-edge')){gesture={kind:'marquee',start:p,x:event.clientX,y:event.clientY,previous:event.shiftKey?new Set(selected):new Set(),pointer:event.pointerId,started:false};if(!event.shiftKey){selected.clear();paintSelection();}}
    }
    function pointerMove(event){revealNearestPort(event);if(!gesture)return;const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;if(!gesture.started&&Math.hypot(dx,dy)<5)return;
        if(!gesture.started){gesture.started=true;draggedPointer=true;clickCandidate=null;try{canvas.setPointerCapture(gesture.pointer);}catch{}doc.getSelection()?.removeAllRanges();if(gesture.kind==='pan')canvas.classList.add('panning');}
        event.preventDefault();const v=nav.view,worldDx=dx/v.scale,worldDy=dy/v.scale;
        if(gesture.kind==='pan'){nav.set({...gesture.view,x:gesture.view.x+dx,y:gesture.view.y+dy});const t=performance.now(),dt=Math.max(1,t-gesture.lastTime);gesture.vx=(event.clientX-gesture.lastX)/dt;gesture.vy=(event.clientY-gesture.lastY)/dt;gesture.lastX=event.clientX;gesture.lastY=event.clientY;gesture.lastTime=t;}
        else if(gesture.kind==='nodes'||gesture.kind==='resize'){mutate(g=>{for(const original of gesture.initial){const n=g.nodes.find(n=>n.id===original.id);if(gesture.kind==='resize'){if(n.id!==gesture.node)continue;n.width=Math.max(120,Math.round(original.width+worldDx));n.height=Math.max(90,Math.round(original.height+worldDy));}else{n.x=Math.round(original.x+worldDx);n.y=Math.round(original.y+worldDy);}position(cardById(n.id),n);}});renderEdges();}
        else if(gesture.kind==='marquee'){const p=worldPoint(event.clientX,event.clientY),area={x:Math.min(p.x,gesture.start.x),y:Math.min(p.y,gesture.start.y),width:Math.abs(p.x-gesture.start.x),height:Math.abs(p.y-gesture.start.y)};selected=new Set([...gesture.previous,...session.graph.nodes.filter(n=>overlaps(area,n)).map(n=>n.id)]);paintSelection();let marquee=pane.querySelector('.nc-marquee');if(!marquee){marquee=el('div','nc-marquee');motionLayer.append(marquee);}position(marquee,area);}
    }
    function pointerUp(event){if(!gesture)return;const action=gesture;gesture=null;try{if(canvas.hasPointerCapture(action.pointer))canvas.releasePointerCapture(action.pointer);}catch{}pane.querySelector('.nc-marquee')?.remove();canvas.classList.remove('panning');
        if(action.kind==='pan'){saveViewport();if(action.started && performance.now()-action.lastTime<80)nav.coast(action.vx,action.vy);}
        else if(action.kind==='port'&&action.started){const port=doc.elementFromPoint(event.clientX,event.clientY)?.closest('.nc-port');clearConnection();if(port){portSource={node:action.node,side:action.side};connect(port.closest('.nc-node').dataset.nodeId,port.dataset.side);}}
    }
    listen(pane,'pointerdown',event=>{const target=event.target,insideNode=target.closest?.('.nc-node');if(inlineEditId){const surface=cardById(inlineEditId)?.querySelector('.live-markdown-content');if(!surface?.contains(target))exitInlineEdit();}if(!insideNode)clickCandidate=null;});
    listen(canvas,'pointerdown',pointerDown);listen(canvas,'pointermove',pointerMove);listen(canvas,'pointerup',pointerUp);listen(canvas,'click',nodeClick);listen(canvas,'dblclick',createTextAtDoubleClick);listen(canvas,'pointerleave',clearNearbyPort);listen(canvas,'pointercancel',stopMotion);listen(canvas,'contextmenu',contextMenu);
    listen(canvas,'wheel',event=>{event.preventDefault();wheelNavigation(event);},{passive:false});
    listen(pane,'keydown',event=>{if(event.key==='Escape'&&inlineEditId){event.preventDefault();event.stopPropagation();exitInlineEdit();clickCandidate=null;return;}if(event.target.closest('input,textarea,select,[contenteditable="true"]'))return;if(event.code==='Space'){event.preventDefault();space=true;}if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteSelection();}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'){const selection=doc.getSelection();if(selection&&!selection.isCollapsed&&pane.contains(selection.anchorNode)&&selection.toString())return;event.preventDefault();copySelection();}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v'){event.preventDefault();paste();}if(event.key==='Escape'){clickCandidate=null;clearConnection();pane.querySelector('.nc-context')?.remove();}});
    listen(doc,'keyup',event=>{if(event.code==='Space')space=false;});listen(globalThis,'blur',()=>{space=false;stopMotion();});listen(doc,'visibilitychange',()=>{if(doc.hidden)stopMotion();});listen(doc,'kaiwu:motion',stopMotion);if(media)listen(media,'change',stopMotion);
    listen(canvas,'dragover',event=>event.preventDefault());listen(canvas,'drop',event=>{event.preventDefault();const point=worldPoint(event.clientX,event.clientY),internal=event.dataTransfer.getData('application/x-kaiwu-note');if(internal){try{const data=JSON.parse(internal);if(data.vault!==session?.vault)throw Error('素材来自其它笔记库');addFile(data.file,point);}catch(err){showError(err);}}else importImages([...event.dataTransfer.files],point).catch(showError);});
    listen(imageInput,'change',()=>importImages([...imageInput.files]).catch(showError));
    const unsubDrop=onEnd(event=>{if(dead||event.insideTree||!editable()||!visible())return;const r=canvas.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)return;const path=event.payload?.relPath;if(notePath(path)||imagePath(path))addFile(path,worldPoint(event.clientX,event.clientY));});unsubs.push(unsubDrop);
    const observer=new ResizeObserver(()=>{pane.classList.toggle('narrow',host.clientWidth<600);if(!visible())stopMotion();});observer.observe(host);unsubs.push(()=>observer.disconnect());
    listen(globalThis,'focus',()=>refreshLibrary());const interval=setInterval(()=>{if(!dead&&visible()&&!refreshing)void refreshLibrary();},2500);unsubs.push(()=>clearInterval(interval));
    void refreshLibrary();
    return ()=>{if(dead)return;dead=true;epoch++;listEpoch++;stopMotion();nav.dispose();zoomLayout.dispose();stopBodyMotion();unsubs.forEach(fn=>fn());if(editor&&session)session.setExtras({editor:{kind:editor.kind,nodeId:editor.nodeId,file:editor.file,text:editor.readText(),original:editor.original,revision:editor.revision,editable:editor.editable,reason:editor.reason}});session?.dispose();host.replaceChildren();};
}
