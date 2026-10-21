import {storageClient} from '../../../packages/bindlebox-engine/store/archive-writer.mjs';
// Ordinary object-storage contract adapter; no bucket implementation crosses the app boundary.
export function objectStoragePort({services,store}){
 if(typeof services?.objectStorage!=='function')return null;
 const port={call:async(method,args)=>services.objectStorage({owner:await store.get('owner'),method,args})},client=storageClient(port);
 return {...port,get:key=>client.get(key),put:(key,bytes)=>client.put(key,bytes,{absent:true}),async delete(key){const got=await client.get(key);if(got)return client.delete(key,got.version);return true;}};
}
export function archiveKeyPort({services,store}){
 if(typeof services?.archiveKeys!=='function')return null;
 return Object.fromEntries(['current','unwrap','attest'].map(method=>[method,async input=>services.archiveKeys({owner:await store.get('owner'),method,input})]));
}
