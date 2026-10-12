import {digest} from '../messaging/store.mjs';
export class AppConnectionError extends Error{constructor(code,message,status=400){super(message);Object.assign(this,{code,status});}}
const fail=(code,message,status)=>{throw new AppConnectionError(code,message,status);};
const prefix='resource/';
const valid=r=>r?.kind==='app-connection'&&r.provider==='app'&&Number.isSafeInteger(r.generation)&&r.generation>0;
export class AppConnections{
 constructor({metadata,origin,clock=()=>Date.now()}){Object.assign(this,{metadata,origin,clock});}
 async id(owner,clientId){const encoded=await digest(globalThis.crypto,`app-connection/v1\0${owner}\0${clientId}`);const hex=[...atob(encoded.replace(/-/g,'+').replace(/_/g,'/'))].slice(0,16).map(c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
 async binding(owner,clientId){const id=await this.id(owner,clientId);const r=await this.metadata.get(prefix+id);if(r&&!valid(r))fail('unavailable','Invalid connection record.',503);return {id,generation:r?.generation??0};}
 async registerBrowser(owner){return this.register(owner,{id:`${this.origin}/automation/browser`,name:'Browser automation'},undefined,{transport:'browser',provenance:{kind:'owner-browser-consent'}});}
 async register(owner,client,expected,trusted={}){
  if(typeof owner!=='string'||typeof client?.id!=='string'||!client.id||client.id.length>200||typeof client.name!=='string'||!client.name||client.name.length>100)fail('invalid_request','Invalid app connection.');
  const id=await this.id(owner,client.id);
  return this.metadata.transaction(async tx=>{
   const prior=await tx.get(prefix+id);if(prior&&!valid(prior))fail('unavailable','Invalid connection record.',503);if(prior&&prior.owner!==owner)fail('forbidden','Connection belongs to another account.',403);
   if(expected!==undefined&&(prior?.generation??0)!==expected)fail('consent_stale','Connection changed. Start a fresh authorization.',409);
   const generation=prior?.status==='active'?prior.generation:(prior?.generation??0)+1;
   if(!Number.isSafeInteger(generation)||generation<1)fail('unavailable','Connection generation unavailable.',503);
   if(!prior&&[...(await tx.list({prefix,limit:201})).values()].filter(r=>r.kind==='app-connection').length>=100)fail('connection_limit','This account has reached its new-app connection limit. Previously connected apps can still reconnect.',429);
   const record={id,owner,clientId:client.id,name:client.name,status:'active',generation,connectedAt:prior?.status==='active'?prior.connectedAt:this.clock(),kind:'app-connection',provider:'app',transport:trusted.transport??'mcp',resourceURI:`${this.origin}/entities/${encodeURIComponent(owner)}/resources/${id}`,contracts:[],...client.metadata?{metadata:structuredClone(client.metadata)}:{},provenance:trusted.provenance??{kind:'oauth-consent',issuer:`${this.origin}/mcp/oauth`}};
   await tx.put(prefix+id,record);return this.view(record);
  });
 }
 view(record){const {owner,...value}=record;return value;}
 async list(owner){const rows=await this.metadata.list({prefix,limit:201});if(rows.size>200)fail('connection_limit','Resource listing exceeds the account limit.',429);return [...rows].filter(([,v])=>v.kind==='app-connection').map(([,v])=>{if(v.owner!==owner)fail('forbidden','Connection belongs to another account.',403);return this.view(v);}).sort((a,b)=>b.connectedAt-a.connectedAt);}
 async check(owner,id,generation,clientId){const r=typeof id==='string'&&await this.metadata.get(prefix+id);if(!valid(r)||r.owner!==owner||r.status!=='active'||r.generation!==generation||clientId!==undefined&&r.clientId!==clientId)fail('invalid_token','The app was disconnected. Reconnect with fresh consent.',401);return true;}
 async disconnect(owner,id){if(!/^[a-f0-9-]{36}$/.test(id))fail('not_found','App connection not found.',404);return this.metadata.transaction(async tx=>{const r=await tx.get(prefix+id);if(!valid(r)||r.owner!==owner)fail('not_found','App connection not found.',404);if(r.status!=='disconnected'){if(r.generation>=Number.MAX_SAFE_INTEGER)fail('unavailable','Connection generation unavailable.',503);r.status='disconnected';r.generation++;r.disconnectedAt=this.clock();await tx.put(prefix+id,r);}return {disconnected:true,app:this.view(r)};});}
}
