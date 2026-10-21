// Drafts are browser-local and account-scoped; never persist bearer tokens or recipient secrets.
export function browserProvider({window,owner,storage=window.localStorage}={}){
 if(typeof owner!=='string'||!owner)throw new TypeError('An authenticated owner scope is required');
 const prefix='bb:draft:'+encodeURIComponent(owner)+':';
 return {id:()=>window.crypto.randomUUID(),drafts:{async get(id){return storage.getItem(prefix+id);},async set(id,text){if(text)storage.setItem(prefix+id,text);else storage.removeItem(prefix+id);}}};
}
