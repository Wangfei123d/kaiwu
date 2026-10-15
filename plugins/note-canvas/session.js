// Recovery lives at plugin-module scope, independent of a pane's DOM lifetime.
const drafts = new Map();
const owners = new Map();
const keyOf = (vault, path) => JSON.stringify([vault, path]);
export const getDraft = (vault, path) => drafts.get(keyOf(vault,path));
export function createSession({ path, vault, graph, revision, write, changed = () => {}, debounce = 800 }) {
    const key = keyOf(vault,path), draft = drafts.get(key);
    const owner=Symbol('canvas session');owners.set(key,owner);
    const recoverGraph=!!draft?.dirty;
    let data = structuredClone(recoverGraph ? draft.graph : graph), rev = recoverGraph ? draft.revision : revision;
    let version = draft?.dirty ? 1 : 0, saved = 0, extras = structuredClone(draft?.extras ?? {});
    let timer = null, writing = null, disposed = false, error = null;
    function remember() {
        // A detached pane may still have a pending write. Only the latest mount
        // owns recovery; old completion/failure callbacks must never touch it.
        if(owners.get(key)!==owner)return;
        if (version > saved || Object.keys(extras).length) drafts.set(key,{ graph:structuredClone(data), revision:rev, dirty:version>saved, extras:structuredClone(extras) });
        else drafts.delete(key);
    }
    const emit = () => { remember(); changed(api); };
    const clear = () => { clearTimeout(timer); timer = null; };
    function schedule() { clear(); if (!disposed) timer = setTimeout(() => api.flush().catch(() => {}),debounce); }
    const api = {
        path, vault, get graph() { return data; }, get revision() { return rev; }, get dirty() { return version > saved; },
        get saving() { return writing !== null; }, get error() { return error; }, get extras() { return structuredClone(extras); },
        edit(fn) { if(disposed) return; fn(data); version++; error=null; emit(); schedule(); },
        setExtras(value) { extras=structuredClone(value); emit(); },
        flush() {
            clear(); if(writing) return writing;
            if(version<=saved) return Promise.resolve();
            // Start in a microtask so even a synchronous write failure sees the assigned promise.
            writing=Promise.resolve().then(async()=>{
                while(version>saved) {
                    const snapshot=structuredClone(data), stamp=version;
                    const result=await write(path,snapshot,rev,vault);
                    if(result.vault!==vault) throw Error('笔记库已经切换，草稿已保留');
                    rev=result.revision; saved=stamp; error=null; emit();
                }
            }).catch(err=>{ error=err; emit(); throw err; }).finally(()=>{ writing=null; emit(); });
            emit(); return writing;
        },
        dispose() { disposed=true; clear(); remember(); },
    };
    remember(); return api;
}
