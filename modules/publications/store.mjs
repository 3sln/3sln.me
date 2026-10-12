import {Provider} from '../../vendor/ngin/index.js';
const copy=value=>structuredClone(value);
const validId=id=>{if(typeof id!=='string'||id.length<1||id.length>128)throw new TypeError('A bounded publication id is required.');return id;};
function content(value){if(!value||typeof value.title!=='string'||!value.title.trim()||value.title.length>200||typeof value.body!=='string'||value.body.length>65536||Object.keys(value).some(key=>!['title','body','revision'].includes(key)))throw new TypeError('A publication requires a title and bounded body.');return {title:value.title.trim(),body:value.body};}
// Sample backing store. It is deliberately not selected by a default build;
// a durable store can implement this exact resource interface by injection.
export class MemoryPublicationStorage extends Provider {
 static deps=[];
 #records=new Map();#sequence=0;
 async obtain(){return Object.freeze({
  list:owner=>[...this.#records.values()].filter(item=>item.owner===owner).map(({owner,...item})=>copy(item)),
  create:(owner,value)=>{const entry={...content(value),id:`publication-${++this.#sequence}`,owner,revision:1};this.#records.set(entry.id,entry);const {owner:_,...result}=entry;return copy(result);},
  update:(owner,id,value)=>{const prior=this.#records.get(validId(id));if(!prior||prior.owner!==owner)throw new Error('Publication not found.');if(value.revision!==prior.revision)throw new Error('Publication changed; reload before saving.');const next={...prior,...content(value),revision:prior.revision+1};this.#records.set(id,next);const {owner:_,...result}=next;return copy(result);},
  remove:(owner,id,revision)=>{const prior=this.#records.get(validId(id));if(!prior||prior.owner!==owner)throw new Error('Publication not found.');if(revision!==prior.revision)throw new Error('Publication changed; reload before deleting.');this.#records.delete(id);return {deleted:true};}
 });}
 release(){}
 dispose(){this.#records.clear();}
}
export class PublicationsProvider extends Provider {
 static deps=['portalAccess','publicationStorage'];
 #leases=new WeakMap();
 constructor({portalAccess,publicationStorage}){super();this.access=portalAccess;this.storage=publicationStorage;}
 async obtain({operation='list'}={}){
  if(!['list','create','update','remove'].includes(operation))throw new Error('Unknown publication operation.');
  const permission=await this.access.obtain({capability:`publications.${operation}`});
  let store;
  try{if(typeof permission?.owner!=='string'||!permission.owner)throw new Error('An owner-scoped publication grant is required.');store=await this.storage.obtain();const owner=permission.owner;
   const handle=Object.freeze(operation==='list'?{list:()=>store.list(owner)}:operation==='create'?{create:value=>store.create(owner,value)}:operation==='update'?{update:(id,value)=>store.update(owner,id,value)}:{remove:(id,revision)=>store.remove(owner,id,revision)});
   this.#leases.set(handle,{permission,store});return handle;
  }catch(error){if(store)await this.storage.release(store);await this.access.release(permission);throw error;}
 }
 async release(handle){const lease=this.#leases.get(handle);if(!lease)return;this.#leases.delete(handle);try{await this.storage.release(lease.store);}finally{await this.access.release(lease.permission);}}
}
