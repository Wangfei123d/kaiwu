import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, getDraft } from '../plugins/note-canvas/session.js';
const graph = () => ({ nodes: [], edges: [] });
const session = (path, write, extra = {}) => createSession({ path, vault:'fixture', graph:graph(), revision:'r1', write, debounce:100000, ...extra });
test('serial flush preserves edits made while the first snapshot is being written', async () => {
    const calls=[]; let release;
    const s=session('serial', async (...args)=>{ calls.push(args); if(calls.length===1) await new Promise(r=>release=r); return {revision:`r${calls.length+1}`,vault:'fixture'}; });
    s.edit(g=>g.nodes.push({id:'a'})); const pending=s.flush(); await Promise.resolve();
    s.edit(g=>g.nodes.push({id:'b'})); assert.equal(calls[0][1].nodes.length,1); release(); await pending;
    assert.equal(calls.length,2); assert.equal(calls[1][2],'r2'); assert.equal(calls[1][1].nodes.length,2); assert.equal(s.dirty,false); s.dispose();
});
test('failed save retains draft and original revision and a retry can persist it', async () => {
    let fails=true; const s=session('retry', async(_p,_g,r)=>{ assert.equal(r,'r1'); if(fails)throw Error('disk failure'); return{revision:'r2',vault:'fixture'}; });
    s.edit(g=>g.nodes.push({id:'draft'})); await assert.rejects(s.flush(),/disk failure/); assert.equal(s.dirty,true);
    assert.equal(getDraft('fixture','retry').graph.nodes[0].id,'draft'); fails=false; await s.flush(); assert.equal(s.dirty,false); s.dispose();
});
test('disposal retains unsaved graph and editor extras for a later mount', () => {
    const s=session('restore', async()=>{throw Error('offline');}); s.edit(g=>g.nodes.push({id:'keep'})); s.setExtras({note:{text:'unsaved original note'}}); s.dispose();
    const r=session('restore', async()=>({revision:'r2',vault:'fixture'})); assert.equal(r.graph.nodes[0].id,'keep'); assert.equal(r.extras.note.text,'unsaved original note'); assert.equal(r.dirty,true); r.dispose();
});
test('mismatching vault response never clears a pending draft', async () => {
    const s=session('token',async()=>({revision:'r2',vault:'other'}));s.edit(g=>g.nodes.push({id:'secret'}));await assert.rejects(s.flush(),/笔记库/);assert.equal(s.dirty,true);s.dispose();
});
test('clean disposal creates no sample or recoverable draft',()=>{const s=session('empty',async()=>{});s.dispose();assert.equal(getDraft('fixture','empty'),undefined);});
test('clean graph recovery keeps note-node extras but uses the latest saved graph revision',()=>{
    const s=session('clean-with-note-draft',async()=>{});s.setExtras({inlineMarkdown:{n1:{text:'draft',original:'source',revision:'note-r1'}}});s.dispose();
    const latest={nodes:[{id:'external'}],edges:[]},r=session('clean-with-note-draft',async()=>{},{graph:latest,revision:'canvas-r2'});
    assert.deepEqual(r.graph,latest);assert.equal(r.revision,'canvas-r2');assert.equal(r.extras.inlineMarkdown.n1.text,'draft');assert.equal(r.dirty,false);r.dispose();
});
test('an older disposed save cannot delete a newer remount draft',async()=>{
    let release;const a=session('owner-success',async()=>{await new Promise(r=>release=r);return{revision:'r2',vault:'fixture'};});a.edit(g=>g.nodes.push({id:'first'}));const pending=a.flush();await Promise.resolve();a.dispose();
    const b=session('owner-success',async()=>({revision:'r2',vault:'fixture'}));b.edit(g=>g.nodes.push({id:'newer'}));b.dispose();release();await pending;
    const c=session('owner-success',async()=>({revision:'r3',vault:'fixture'}),{graph:{nodes:[{id:'first'}],edges:[]},revision:'r2'});assert.deepEqual(c.graph.nodes.map(n=>n.id),['first','newer']);assert.equal(c.revision,'r1','No unsafe implicit rebase');c.dispose();
});
test('an old failed save cannot overwrite a newer draft',async()=>{
    let reject;const a=session('owner-failure',async()=>new Promise((_r,j)=>reject=j));a.edit(g=>g.nodes.push({id:'first'}));const pending=a.flush();await Promise.resolve();a.dispose();const b=session('owner-failure',async()=>({revision:'r2',vault:'fixture'}));b.edit(g=>g.nodes.push({id:'newer'}));b.dispose();reject(Error('old failure'));await assert.rejects(pending,/old failure/);assert.deepEqual(getDraft('fixture','owner-failure').graph.nodes.map(n=>n.id),['first','newer']);
});
test('an old failed save cannot revive a draft already saved by a newer owner',async()=>{
    let reject;const a=session('owner-clean',async()=>new Promise((_r,j)=>reject=j));a.edit(g=>g.nodes.push({id:'first'}));const pending=a.flush();await Promise.resolve();a.dispose();const b=session('owner-clean',async()=>({revision:'r2',vault:'fixture'}));b.edit(g=>g.nodes.push({id:'newer'}));await b.flush();b.dispose();assert.equal(getDraft('fixture','owner-clean'),undefined);reject(Error('old failure'));await assert.rejects(pending,/old failure/);assert.equal(getDraft('fixture','owner-clean'),undefined);
});
