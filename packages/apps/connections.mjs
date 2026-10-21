import {digest} from '../messaging/store.mjs';
import {validateIntegrationManifest} from '../federation/integrations.mjs';
import {validateSlotManifest,validateExtensions,createSlotOperation} from '../federation/extensions.mjs';
import {MESSAGING_INGRESS_SLOT} from '../links/types.mjs';
import classifierSlot from '../../docs/artefacts/slots/item-classifier-v1.json' with {type:'json'};
export class AppConnectionError extends Error{constructor(code,message,status=400){super(message);Object.assign(this,{code,status});}}
const fail=(code,message,status)=>{throw new AppConnectionError(code,message,status);};
const prefix='resource/';
// EXT-X4 (docs/spec/integrations.md §1, §3, §7; docs/spec/extensions.md §3, §5): the app connection is the integration
// connection. A record written before X4 has no `state` and reads as `active`/`disconnected` from `status`; X4 writes
// `state` (and keeps `status` derived from it, so every legacy check stays exact) the first time a migrated path touches
// it, and only while INTEGRATIONS_ENABLED (packages/runtime/account/connections.mjs). Fencing is record-driven, never
// flag-driven: a suspended or manifest-invalid record refuses a legacy re-authorization even with the flag off.
export const CONNECTION_STATES=Object.freeze(['configuring','active','degraded','manifest-invalid','suspended','disconnected']);
const LIVE=['configuring','active','degraded'],SERVING=['active','degraded'],PAUSED=['suspended','manifest-invalid'];
export const connectionStatus=state=>LIVE.includes(state)?'active':state==='disconnected'?'disconnected':'suspended';
export const connectionState=r=>r?.state??(r?.status==='active'?'active':'disconnected');
const valid=r=>r?.kind==='app-connection'&&r.provider==='app'&&Number.isSafeInteger(r.generation)&&r.generation>0&&(r.state===undefined||CONNECTION_STATES.includes(r.state)&&r.status===connectionStatus(r.state));
// Slot occupancy is the owner's value for the slot's resource field (extensions §1): one ordered record per slot.
// Outbox rows are the transactional events later slices drain (X6 delivery, X7 credential revocation, X8 projection);
// cascade rows are durable intents for effects owned by other modules (key-delegation revocation), drained after commit.
const SLOT='connections/slot/',OUTBOX='connections/outbox/',CASCADE='connections/cascade/',CASCADE_ALL=CASCADE+'~all',META='connections/meta',LIFECYCLE_STATE='lifecycle/state-v1';
export const OUTBOX_LIMIT=4096,CASCADE_LIMIT=256,SLOT_RECORDS_LIMIT=64,RECENT_AUTH_MS=900000;
const BLOCKED=['suspended','purge-review','purging'];
// Slots whose occupant holds key-delegation.v1 certificates (packages/identity/delegation.mjs): a change of occupant,
// generation, ingress or consented purposes revokes or reconciles them through a cascade row (review KD-4).
export const DELEGATION_SLOTS=Object.freeze([MESSAGING_INGRESS_SLOT]);
// Provider-recognized slot manifests (trusted pins, exact URL). The messaging-ingress manifest is bindlebox.md §2.1.
export const MESSAGING_INGRESS_MANIFEST=Object.freeze({id:MESSAGING_INGRESS_SLOT,title:'Receives messages',description:'The one app that receives peer messages, contact links and bridged email for you.',publisher:'https://spec.bindle.example',fields:{occupants:{title:'Messaging app',type:'resource',cardinality:{min:0,max:1},contracts:['https://spec.bindle.example/bindlebox/v1/contracts/mailbox']}},slot:{v:1,field:'occupants',selection:'exclusive',consumers:['provider'],supersedes:null}});
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const ITEM_CLASSIFIER_MANIFEST=freeze(classifierSlot);
export const RECOGNIZED_SLOTS=Object.freeze({[MESSAGING_INGRESS_SLOT]:MESSAGING_INGRESS_MANIFEST,[classifierSlot.id]:ITEM_CLASSIFIER_MANIFEST});
const pad=n=>String(n).padStart(16,'0');
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const only=(v,names)=>plain(v)&&Object.keys(v).every(k=>names.includes(k));
const ID=/^[a-f0-9-]{36}$/,SEAT=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&/^[\x21-\x7e]+$/.test(v);
const httpsId=v=>{if(typeof v!=='string'||v.length>256)return false;try{const u=new URL(v);return u.protocol==='https:'&&u.href===v&&!u.username&&!u.password&&!u.hash;}catch{return false;}};
const purposesValid=v=>Array.isArray(v)&&v.length<=8&&v.every((p,i)=>httpsId(p)&&(i===0||v[i-1]<p));
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const epochOf=s=>Number.isSafeInteger(s?.capabilityEpoch)?s.capabilityEpoch:0;
const requiresSetup=m=>Boolean(m?.setup?.fragments?.some(f=>f.required===true)||m?.extensions?.some(e=>e.role==='consumer'&&e.required===true));
const bump=(r,field='generation')=>{if(!Number.isSafeInteger(r[field])||r[field]>=Number.MAX_SAFE_INTEGER)fail('unavailable','Connection generation unavailable.',503);r[field]++;};
const cnxOf=entry=>`${entry.seat}.${entry.generation}`;
/** Validates an approval snapshot (packages/federation/integrations.mjs integrationSnapshot): the manifest must re-derive
 * exactly from the snapshot's own client members, so a stored pin can never be widened by editing it. */
export function connectionSnapshotValid(s,clientId,{reserved=[]}={}){
 if(!only(s,['clientId','redirectUris','authMethod','jwksUri','thumbprints','pendingThumbprints','manifest'])||s.clientId!==clientId||bytes(s)>16384)return false;
 if(!Array.isArray(s.redirectUris)||s.redirectUris.length>16||s.redirectUris.some(u=>typeof u!=='string'))return false;
 const tp=v=>Array.isArray(v)&&v.length>0&&v.length<=16&&v.every(t=>typeof t==='string'&&/^[A-Za-z0-9_-]{43}$/.test(t));
 if(s.authMethod==='private_key_jwt'){if(typeof s.jwksUri!=='string'||!tp(s.thumbprints)||s.pendingThumbprints!==undefined&&!tp(s.pendingThumbprints))return false;}
 else if(s.authMethod!=='none'||s.jwksUri!==undefined||s.thumbprints!==undefined||s.pendingThumbprints!==undefined)return false;
 let r;try{r=validateIntegrationManifest(s.manifest,{clientId,confidential:s.authMethod==='private_key_jwt',redirectUris:s.redirectUris,jwksUri:s.jwksUri,reserved});}catch{return false;}
 return r.status==='valid'&&JSON.stringify(r.manifest)===JSON.stringify(s.manifest);
}
/** A provider-authored built-in manifest: {v:1, setup?, extensions?, resources?:{contracts}} with valid extension claims. */
export function builtInManifestValid(m){
 if(!only(m,['v','setup','extensions','resources'])||m.v!==1||bytes(m)>8192)return false;
 if(m.resources!==undefined&&(!only(m.resources,['contracts'])||!Array.isArray(m.resources.contracts)||m.resources.contracts.length>32||!m.resources.contracts.every(httpsId)))return false;
 if(m.extensions!==undefined&&(!Array.isArray(m.extensions)||validateExtensions(m.extensions,{kind:'integration'}).some(r=>r.status==='invalid')))return false;
 return m.setup===undefined||only(m.setup,['fragments'])&&Array.isArray(m.setup.fragments)&&m.setup.fragments.length<=8;
}
export class AppConnections{
 /** `slots`: provider-recognized slot manifests by exact URL (trusted pins). `builtins`: provider-authored built-in
  * integrations by id -> {name, manifest}. `severed(owner)`: optional hook run after a legacy disconnect that wrote
  * cascade rows (the account controller drains them); its failure never undoes the committed disconnect. */
 constructor({metadata,origin,clock=()=>Date.now(),slots=RECOGNIZED_SLOTS,builtins={},severed,uuid=()=>crypto.randomUUID()}){Object.assign(this,{metadata,origin,clock,slotPins:slots,builtins,severed,uuid});}
 async id(owner,clientId){const encoded=await digest(globalThis.crypto,`app-connection/v1\0${owner}\0${clientId}`);const hex=[...atob(encoded.replace(/-/g,'+').replace(/_/g,'/'))].slice(0,16).map(c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
 async binding(owner,clientId){const id=await this.id(owner,clientId);const r=await this.metadata.get(prefix+id);if(r&&!valid(r))fail('unavailable','Invalid connection record.',503);return {id,generation:r?.generation??0,notificationGeneration:r?.notifications?.generation??1};}
 async registerBrowser(owner){return this.register(owner,{id:`${this.origin}/automation/browser`,name:'Browser automation'},undefined,{transport:'browser',provenance:{kind:'owner-browser-consent'}});}
 /** `trusted.integration` ({kind:'external'|'built-in', snapshot, builtin?}) is set only by the X4 connect paths: it
  * writes the lifecycle state, the pinned snapshot and the account capability fence. Without it the legacy record shape
  * is kept, except that a same-incarnation re-approval carries X4 fields forward instead of dropping them. */
 async register(owner,client,expected,trusted={}){
  if(typeof owner!=='string'||typeof client?.id!=='string'||!client.id||client.id.length>200||typeof client.name!=='string'||!client.name||client.name.length>100)fail('invalid_request','Invalid app connection.');
  const id=await this.id(owner,client.id);
  const result=await this.metadata.transaction(async tx=>{
   const prior=await tx.get(prefix+id);if(prior&&!valid(prior))fail('unavailable','Invalid connection record.',503);if(prior&&prior.owner!==owner)fail('forbidden','Connection belongs to another account.',403);
   if(expected!==undefined&&(prior?.generation??0)!==expected)fail('consent_stale','Connection changed. Start a fresh authorization.',409);
   // Only the owner resumes, from the provider's own interface (integrations §3.1); an authorization never does.
   if(PAUSED.includes(prior?.state))fail('connection_suspended','This connection is paused. Resume it from your account first.',409);
   if(trusted.notifications===true&&trusted.expectedNotificationGeneration!==undefined&&(prior?.notifications?.generation??1)!==trusted.expectedNotificationGeneration)fail('consent_stale','Message permission changed. Review again.',409);
   const changed=Boolean(trusted.integration&&prior?.status==='active'&&(JSON.stringify(prior.integration??null)!==JSON.stringify(trusted.integration)||prior.appOrigin!==client.origin));
   const same=prior?.status==='active',generation=same?prior.generation+(changed?1:0):(prior?.generation??0)+1;
   if(!Number.isSafeInteger(generation)||generation<1)fail('unavailable','Connection generation unavailable.',503);
   if(!prior&&[...(await tx.list({prefix,limit:201})).values()].filter(r=>r.kind==='app-connection').length>=100)fail('connection_limit','This account has reached its new-app connection limit. Previously connected apps can still reconnect.',429);
   let notifications=prior?.notifications??{enabled:false,generation:1};if(trusted.notifications===true&&!notifications.enabled){if(!Number.isSafeInteger(notifications.generation)||notifications.generation<1||notifications.generation>=Number.MAX_SAFE_INTEGER)fail('unavailable','Notification generation unavailable.',503);notifications={enabled:true,generation:notifications.generation+1};}if(prior?.status==='disconnected')notifications={enabled:trusted.notifications===true,generation:(prior.notifications?.generation??1)+1};
   const record={id,owner,clientId:client.id,name:client.name,status:'active',generation,connectedAt:same?prior.connectedAt:this.clock(),kind:'app-connection',provider:'app',transport:trusted.transport??'mcp',...trusted.transport==='bindle'?{appOrigin:client.origin,notifications}:{},resourceURI:`${this.origin}/entities/${encodeURIComponent(owner)}/resources/${id}`,contracts:[],...client.metadata?{metadata:structuredClone(client.metadata)}:{},provenance:trusted.provenance??{kind:'oauth-consent',issuer:`${this.origin}/mcp/oauth`}};
   const events=[];
   if(trusted.integration){
    const lifecycle=await tx.get(LIFECYCLE_STATE);if(BLOCKED.includes(lifecycle?.phase))fail('account_suspended','This account is suspended.',423);
    const manifest=trusted.integration.snapshot?.manifest??trusted.integration.manifest,configured=same&&prior.configured===true||!requiresSetup(manifest);
    Object.assign(record,{state:configured?(same&&prior.state==='degraded'?'degraded':'active'):'configuring',configured,stateChangedAt:this.clock(),fence:same&&prior.fence!==undefined?prior.fence:epochOf(lifecycle),integration:structuredClone(trusted.integration)});
    record.status=connectionStatus(record.state);
    events.push({type:'connection-activated',connection:id,clientId:client.id,generation,state:record.state,kind:trusted.integration.kind});
   }else if(same&&prior.state!==undefined)for(const k of ['state','configured','stateChangedAt','fence','integration'])if(prior[k]!==undefined)record[k]=structuredClone(prior[k]);
   await tx.put(prefix+id,record);if(events.length)await this.#emit(tx,events);
   if(changed){await this.#cascade(tx,this.#delegationRows(await this.#affected(tx,id),'system'));await this.#reseat(tx,record);}
   return this.view(record);
  });
  return result;
 }
 view(record){const {owner,...value}=record;return value;}
 async list(owner){const rows=await this.metadata.list({prefix,limit:201});if(rows.size>200)fail('connection_limit','Resource listing exceeds the account limit.',429);return [...rows].filter(([,v])=>v.kind==='app-connection').map(([,v])=>{if(v.owner!==owner)fail('forbidden','Connection belongs to another account.',403);return this.view(v);}).sort((a,b)=>b.connectedAt-a.connectedAt);}
 async check(owner,id,generation,clientId){const r=typeof id==='string'&&await this.metadata.get(prefix+id);if(!valid(r)||r.owner!==owner||r.status!=='active'||r.generation!==generation||clientId!==undefined&&r.clientId!==clientId)fail('invalid_token','The app was disconnected. Reconnect with fresh consent.',401);
  // X4-R2: a migrated connection outlives no account suspension, even one that ended before anyone looked.
  if(r.fence!==undefined){const lifecycle=await this.metadata.get(LIFECYCLE_STATE);if(BLOCKED.includes(lifecycle?.phase)||r.fence!==epochOf(lifecycle))fail('invalid_token','The app was disconnected. Reconnect with fresh consent.',401);}
  return true;}
 async notificationSettings(owner,id,input){return this.metadata.transaction(async tx=>{const r=await tx.get(prefix+id);if(!valid(r)||r.owner!==owner||r.transport!=='bindle')fail('not_found','App connection not found.',404);const current=r.notifications??{enabled:false,generation:1};if(!Number.isSafeInteger(current.generation)||current.generation<1||typeof current.enabled!=='boolean')fail('unavailable','Notification settings unavailable.',503);if(input===undefined)return current;if(!input||Object.keys(input).length!==1||typeof input.enabled!=='boolean')fail('invalid_request','Choose whether this app may send messages.');if(r.status!=='active')fail('invalid_token','Reconnect this application first.',401);if(current.enabled!==input.enabled){if(current.generation>=Number.MAX_SAFE_INTEGER)fail('unavailable','Notification settings unavailable.',503);r.notifications={enabled:input.enabled,generation:current.generation+1};await tx.put(prefix+id,r);}return r.notifications??current;});}
 /** Severs one connection (integrations §7.1 Disconnect). A legacy record keeps exactly its old effect; a migrated one,
  * or one holding slot seats, also vacates every seat, enqueues `connection-revoked` (terminal) and the delegation
  * cascade in the same transaction, then runs the `severed` hook. */
 async disconnect(owner,id,{reason='uninstalled',expectedGeneration}={}){
  if(!/^[a-f0-9-]{36}$/.test(id))fail('not_found','App connection not found.',404);
  const out=await this.metadata.transaction(async tx=>{
   const r=await tx.get(prefix+id);if(!valid(r)||r.owner!==owner)fail('not_found','App connection not found.',404);
   if(expectedGeneration!==undefined&&expectedGeneration!==r.generation)fail('connection_stale','The connection changed. Reload and try again.',409);
   let cascaded=false;
   if(r.status!=='disconnected'){
    if(r.generation>=Number.MAX_SAFE_INTEGER)fail('unavailable','Connection generation unavailable.',503);
    const migrated=r.state!==undefined;r.status='disconnected';r.generation++;r.disconnectedAt=this.clock();
    if(migrated){r.state='disconnected';r.stateChangedAt=r.disconnectedAt;}
    await tx.put(prefix+id,r);
    const removed=await this.#vacateConnection(tx,id);
    if(migrated||removed.length){
     await this.#emit(tx,[{type:'connection-revoked',connection:id,clientId:r.clientId,generation:r.generation,terminal:true,reason}]);
     await this.#cascade(tx,[{kind:'delegations',clientId:r.clientId,reason:['deleted','system'].includes(reason)?reason:'uninstalled'}]);cascaded=true;
    }
   }
   return {result:{disconnected:true,app:this.view(r)},cascaded};
  });
  if(out.cascaded&&typeof this.severed==='function')try{await this.severed(owner);}catch{/* Durable cascade rows are retried. */}
  return out.result;
 }

 // ---- X4 connections domain (called by packages/app/domains/connections.mjs; INTEGRATIONS_ENABLED is checked there) ----
 async #load(tx,owner,id){if(typeof id!=='string'||!ID.test(id))fail('not_found','Connection not found.',404);const r=await tx.get(prefix+id);if(!valid(r)||r.owner!==owner)fail('not_found','Connection not found.',404);if(r.state===undefined)r.state=connectionState(r);return r;}
 #fenced(r,expected,required){if(expected===undefined){if(required)fail('invalid_request','The expected connection generation is required.');return;}if(!Number.isSafeInteger(expected)||expected!==r.generation)fail('connection_stale','The connection changed. Reload and try again.',409);}
 async #meta(tx){const m=await tx.get(META);return m&&Number.isSafeInteger(m.seq)?m:{seq:0,low:0,cascade:0,pending:0};}
 async #emit(tx,events){const m=await this.#meta(tx),at=this.clock();for(const e of events){m.seq++;await tx.put(OUTBOX+pad(m.seq),{seq:m.seq,at,...e});if(m.seq-m.low>OUTBOX_LIMIT){m.low++;await tx.delete?.(OUTBOX+pad(m.low));}}await tx.put(META,m);}
 // Over-revocation is always safe: past the bound, pending cascades collapse into one revoke-all row.
 async #cascade(tx,rows){if(!rows.length)return;const m=await this.#meta(tx),at=this.clock();for(const row of rows){if(m.pending>=CASCADE_LIMIT){await tx.put(CASCADE_ALL,{kind:'delegations',all:true,reason:'system',at});continue;}m.cascade++;m.pending++;await tx.put(CASCADE+pad(m.cascade),{...row,at});}await tx.put(META,m);}
 #slot(url){
  const schema=typeof url==='string'&&Object.hasOwn(this.slotPins,url)?this.slotPins[url]?.schema??this.slotPins[url]:null;
  let result=null;try{result=schema?validateSlotManifest(schema,url):null;}catch{result=null;}if(result?.status!=='valid')fail('unsupported_slot','This slot is not recognized here.',400);
  const field=result.schema.fields[result.slot.field];return {url,schema:result.schema,policy:result.slot,max:field.cardinality.max,contracts:field.contracts};
 }
 async #seats(tx,url){const key=SLOT+await digest(globalThis.crypto,url),r=await tx.get(key);return {key,record:r?.slot===url&&Array.isArray(r.occupants)?r:{slot:url,revision:0,occupants:[]}};}
 async #slotRows(tx){const rows=[...(await tx.list({prefix:SLOT,limit:SLOT_RECORDS_LIMIT+1})).entries()];if(rows.length>SLOT_RECORDS_LIMIT)fail('unavailable','Too many slot records.',503);return rows.filter(([,v])=>typeof v?.slot==='string'&&Array.isArray(v.occupants));}
 #summary(rec){return rec.occupants.map(e=>({seat:e.seat,connection:e.connection,clientId:e.clientId,generation:e.generation}));}
 async #vacateConnection(tx,id,{keep}={}){
  const removed=[];
  for(const [key,rec] of await this.#slotRows(tx)){
   const gone=rec.occupants.filter(e=>e.connection===id&&!keep?.(rec.slot,e));if(!gone.length)continue;
   rec.occupants=rec.occupants.filter(e=>!gone.includes(e));rec.revision=(rec.revision??0)+1;await tx.put(key,rec);
   for(const e of gone)removed.push({slot:rec.slot,entry:e});
   await this.#emit(tx,[...gone.map(e=>({type:'occupant-removed',slot:rec.slot,seat:e.seat,connection:id,clientId:e.clientId,generation:e.generation})),{type:'slot-changed',slot:rec.slot,revision:rec.revision,occupants:this.#summary(rec)}]);
  }
  return removed;
 }
 // Delegation cascades for seats leaving (or changing generation in) a delegation slot.
 #delegationRows(changes,reason){return changes.filter(c=>DELEGATION_SLOTS.includes(c.slot)).map(c=>({kind:'delegations',clientId:c.entry.clientId,reason}));}
 #eligible(r,slot){
  const manifest=r.integration?.snapshot?.manifest??r.integration?.manifest;if(!manifest)return false;
  const declared=(manifest.extensions??[]).some(e=>e.slot===slot.url&&e.role==='occupant'),offered=manifest.resources?.contracts??[];
  return declared&&slot.contracts.every(c=>offered.includes(c));
 }
 // Re-binds this connection's seats to its new generation (resume/approve), dropping seats it no longer qualifies for.
 async #reseat(tx,r){
  const removed=await this.#vacateConnection(tx,r.id,{keep:(url,e)=>{try{return this.#eligible(r,this.#slot(url));}catch{return false;}}});
  for(const [key,rec] of await this.#slotRows(tx)){let changed=false;for(const e of rec.occupants)if(e.connection===r.id&&e.generation!==r.generation){e.generation=r.generation;changed=true;}if(changed){rec.revision=(rec.revision??0)+1;await tx.put(key,rec);await this.#emit(tx,[{type:'slot-changed',slot:rec.slot,revision:rec.revision,occupants:this.#summary(rec)}]);if(DELEGATION_SLOTS.includes(rec.slot))await this.#cascade(tx,[{kind:'reconcile'}]);}}
  await this.#cascade(tx,this.#delegationRows(removed,'system'));
 }
 #affected=async(tx,id)=>(await this.#slotRows(tx)).flatMap(([,rec])=>rec.occupants.filter(e=>e.connection===id).map(entry=>({slot:rec.slot,entry})));

 /** Connect from an approved integration manifest snapshot (system actor: the federation consent adapter). */
 async connect(owner,{client,snapshot,expectedGeneration}={}){
  if(!only(client,['id','name','origin'])||typeof client.id!=='string')fail('invalid_request','Invalid integration client.');
  let origin;try{origin=new URL(client.id).origin;}catch{fail('invalid_request','Invalid integration client.');}
  if(!origin.startsWith('https://')||client.origin!==undefined&&client.origin!==origin)fail('invalid_request','The integration origin must be its client_id origin.');
  if(!connectionSnapshotValid(snapshot,client.id,{reserved:[new URL(this.origin).hostname]}))fail('invalid_integration','The integration manifest snapshot is not valid.',400);
  return this.register(owner,{id:client.id,name:client.name,origin},expectedGeneration,{transport:'bindle',integration:{kind:'external',snapshot:structuredClone(snapshot)},provenance:{kind:'oauth-consent',issuer:this.origin}});
 }
 /** Built-in integrations are connections too (integrations §3.2): the owner's explicit action is the authorization. */
 async connectBuiltIn(owner,{integration}={}){
  const def=typeof integration==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(integration)&&Object.hasOwn(this.builtins,integration)?this.builtins[integration]:null;
  if(!def||typeof def.name!=='string'||!builtInManifestValid(def.manifest))fail('not_found','Built-in integration not found.',404);
  return this.register(owner,{id:`${this.origin}/integrations/${integration}`,name:def.name,origin:this.origin},undefined,{transport:'bindle',integration:{kind:'built-in',builtin:integration,manifest:structuredClone(def.manifest)},provenance:{kind:'owner-built-in'}});
 }
 /** Lifecycle transitions (integrations §3.1, §7.1). `op`: suspend | resume | configured | health | approve. */
 async transition(owner,id,op,input={}){
  return this.metadata.transaction(async tx=>{
   const r=await this.#load(tx,owner,id),now=this.clock(),from=r.state,events=[];
   const set=state=>{r.state=state;r.status=connectionStatus(state);r.stateChangedAt=now;};
   if(from==='disconnected')fail('connection_disconnected','This connection was disconnected. Connect again with fresh consent.',409);
   if(op==='suspend'){
    this.#fenced(r,input.expectedGeneration,false);if(from==='suspended')return this.view(r);
    bump(r);set('suspended');events.push({type:'connection-revoked',connection:id,clientId:r.clientId,generation:r.generation,terminal:false,reason:'suspended'});
    await this.#cascade(tx,this.#delegationRows(await this.#affected(tx,id),'system'));
   }else if(op==='resume'){
    this.#fenced(r,input.expectedGeneration,true);if(from!=='suspended')fail('invalid_state','Only a paused connection can be resumed.',409);
    const lifecycle=await tx.get(LIFECYCLE_STATE);if(BLOCKED.includes(lifecycle?.phase))fail('account_suspended','This account is suspended.',423);
    if(r.fence!==undefined&&r.fence!==epochOf(lifecycle)){await this.#severAllTx(tx,owner,'suspended');return this.view(await tx.get(prefix+id));}
    bump(r);set(r.integration?.invalid||r.integration?.review?'manifest-invalid':r.configured===false?'configuring':'active');r.fence=epochOf(lifecycle);
    events.push({type:r.state==='manifest-invalid'?'connection-state':'connection-resumed',connection:id,clientId:r.clientId,generation:r.generation,state:r.state});
    if(r.state!=='manifest-invalid')await this.#reseat(tx,r);
   }else if(op==='configured'){
    this.#fenced(r,input.expectedGeneration,true);if(typeof input.configured!=='boolean')fail('invalid_request','Say whether setup is complete.');
    if(!LIVE.includes(from))fail('invalid_state','This connection is not live.',409);
    r.configured=input.configured;const to=input.configured?(from==='configuring'?'active':from):'configuring';
    if(to!==from){if(to==='configuring'){bump(r);await this.#cascade(tx,this.#delegationRows(await this.#affected(tx,id),'system'));}set(to);events.push({type:'connection-state',connection:id,clientId:r.clientId,generation:r.generation,state:to});if(SERVING.includes(to))await this.#reseat(tx,r);}
   }else if(op==='health'){
    this.#fenced(r,input.expectedGeneration,true);if(typeof input.degraded!=='boolean')fail('invalid_request','Say whether the connection is degraded.');
    const to=input.degraded&&from==='active'?'degraded':!input.degraded&&from==='degraded'?'active':from;if(to!==from){set(to);events.push({type:'connection-state',connection:id,clientId:r.clientId,generation:r.generation,state:to});}
   }else if(op==='approve'){
    // The owner approves a staged manifest change (integrations §2.3); a security-relevant one left the connection
    // manifest-invalid, so approval starts a new generation and re-checks every seat against the approved manifest.
    this.#fenced(r,input.expectedGeneration,true);const staged=r.integration?.staged;
    if(r.integration?.kind!=='external'||!staged)fail('invalid_state','There is no change to review.',409);
    if(r.integration.invalid)fail('manifest_invalid','The integration manifest is unavailable or invalid. Wait for it to be fixed.',409);
    if(!connectionSnapshotValid(staged,r.clientId,{reserved:[new URL(this.origin).hostname]}))fail('invalid_integration','The staged manifest is not valid.',409);
    r.integration={kind:'external',snapshot:structuredClone(staged)};
    if(from==='manifest-invalid'){bump(r);set(r.configured===false||requiresSetup(staged.manifest)&&r.configured!==true?'configuring':'active');events.push({type:'connection-resumed',connection:id,clientId:r.clientId,generation:r.generation,state:r.state});}
    else events.push({type:'manifest-adopted',connection:id,clientId:r.clientId,generation:r.generation,changes:['owner_approved']});
    if(from!=='suspended')await this.#reseat(tx,r);
   }else fail('invalid_request','Unsupported connection change.');
   await tx.put(prefix+id,r);if(events.length)await this.#emit(tx,events);return this.view(r);
  });
 }
 /** Applies an X3 revalidation result (classifyIntegrationChange) under the generation the caller observed. */
 async revalidated(owner,id,{expectedGeneration,result}={}){
  return this.metadata.transaction(async tx=>{
   const r=await this.#load(tx,owner,id),now=this.clock(),events=[];this.#fenced(r,expectedGeneration,true);
   if(r.integration?.kind!=='external'||!r.integration.snapshot)fail('invalid_state','This connection has no integration manifest.',409);
   if(!only(result,['decision','changes','next','staged'])||!['unchanged','adopt','review','invalid'].includes(result.decision)||!Array.isArray(result.changes)||result.changes.length>32||result.changes.some(c=>typeof c!=='string'||!/^[a-z_]{1,40}$/.test(c)))fail('invalid_request','Unsupported revalidation result.');
   if(r.state==='disconnected')fail('connection_disconnected','This connection was disconnected.',409);
   const reserved=[new URL(this.origin).hostname],okNext=result.next===undefined||connectionSnapshotValid(result.next,r.clientId,{reserved});if(!okNext)fail('invalid_request','Unsupported revalidation result.');
   const set=state=>{r.state=state;r.status=connectionStatus(state);r.stateChangedAt=now;};
   const invalidate=reason=>{if(r.state==='manifest-invalid'||r.state==='suspended')return;bump(r);set('manifest-invalid');events.push({type:'connection-revoked',connection:id,clientId:r.clientId,generation:r.generation,terminal:false,reason});};
   const security=result.changes.filter(c=>['identity_changed','keys_replaced','endpoint_collision','client_gone','client_invalid','client_mismatch','manifest_removed','manifest_invalid'].includes(c));
   let affected=[];
   if(result.decision==='invalid'){r.integration.invalid={reason:result.changes[0]??'manifest_invalid'};delete r.integration.staged;affected=await this.#affected(tx,id);invalidate('manifest-invalid');}
   else{
    if(result.next&&JSON.stringify(result.next)!==JSON.stringify(r.integration.snapshot)){r.integration.snapshot=structuredClone(result.next);events.push({type:'manifest-adopted',connection:id,clientId:r.clientId,generation:r.generation,changes:result.changes.slice(0,32)});}
    if(result.decision==='review'){
     r.integration.staged=result.staged!==undefined&&connectionSnapshotValid(result.staged,r.clientId,{reserved})?structuredClone(result.staged):r.integration.staged;
     if(security.length){r.integration.review={changes:security};affected=await this.#affected(tx,id);invalidate('manifest-review');}
    }else{
     const wasInvalid=Boolean(r.integration.invalid||r.integration.review);delete r.integration.invalid;delete r.integration.review;
     if(wasInvalid&&r.state==='manifest-invalid'){bump(r);set(r.configured===false?'configuring':'active');events.push({type:'connection-resumed',connection:id,clientId:r.clientId,generation:r.generation,state:r.state});}
    }
    if(SERVING.includes(r.state)||r.state==='configuring')await this.#reseat(tx,r);
   }
   if(affected.length&&r.state==='manifest-invalid')await this.#cascade(tx,this.#delegationRows(affected,'system'));
   await tx.put(prefix+id,r);if(events.length)await this.#emit(tx,events);return this.view(r);
  });
 }
 /** Account recovery, suspension or deletion severs every connection (integrations §3.1, §7.1; review KD-4). */
 async severAll(owner,{reason='suspended'}={}){
  if(!['suspended','deleted','system'].includes(reason))fail('invalid_request','Unsupported reason.');
  return this.metadata.transaction(async tx=>{const bound=await tx.get('owner');if(bound!==undefined&&bound!==owner)fail('forbidden','Account owner mismatch.',403);return this.#severAllTx(tx,owner,reason);});
 }
 // Every connection, paginated (storage resources share the prefix). Idempotent: a repeat for the same lifecycle
 // incarnation that severs nothing writes nothing (X4-R1, R8d); otherwise one revoke-all cascade row is enqueued.
 async #severAllTx(tx,owner,reason){
  let severed=0,after='';const now=this.clock(),lifecycle=await tx.get(LIFECYCLE_STATE),mark=`${lifecycle?.generation??0}:${epochOf(lifecycle)}:${lifecycle?.phase??'none'}`;
  for(;;){
   const rows=[...(await tx.list({prefix,startAfter:after,limit:200})).entries()];
   for(const [key,r] of rows)if(r?.kind==='app-connection'&&valid(r)&&r.owner===owner&&r.status!=='disconnected'){
    bump(r);r.status='disconnected';r.state='disconnected';r.disconnectedAt=now;r.stateChangedAt=now;await tx.put(key,r);severed++;
    await this.#vacateConnection(tx,r.id);await this.#emit(tx,[{type:'connection-revoked',connection:r.id,clientId:r.clientId,generation:r.generation,terminal:true,reason:'account-'+reason}]);
   }
   if(rows.length<200)break;const next=rows.at(-1)[0];if(next<=after)break;after=next;
  }
  const m=await this.#meta(tx);if(!severed&&m.severed===mark)return {severed};
  await this.#cascade(tx,[{kind:'delegations',all:true,reason}]);const m2=await this.#meta(tx);m2.severed=mark;await tx.put(META,m2);
  return {severed};
 }

 // ---- Slot occupancy (extensions §3, §5.1): only the owner assigns, reorders or removes occupants ----
 /** `input`: {slot, connection, resource?, position?, replace?, purposes?, expectedRevision?}. `actor.authTime`: when
  * the owner last authenticated (trusted adapter), required for replacing an exclusive provider-consumed occupant. */
 async occupy(owner,input,actor={}){
  if(!only(input,['slot','connection','resource','position','replace','purposes','expectedRevision']))fail('invalid_request','Unsupported occupancy request.');
  const slot=this.#slot(input.slot);
  if(input.resource!==undefined&&!text(input.resource,128))fail('invalid_request','Choose a resource.');
  if(input.purposes!==undefined&&!purposesValid(input.purposes))fail('invalid_request','Choose recognized purposes in ascending order.');
  if(input.position!==undefined&&(!Number.isSafeInteger(input.position)||input.position<0))fail('invalid_request','Choose a position.');
  if(input.replace!==undefined&&typeof input.replace!=='boolean')fail('invalid_request','Unsupported occupancy request.');
  return this.metadata.transaction(async tx=>{
   const r=await this.#load(tx,owner,input.connection),lifecycle=await tx.get(LIFECYCLE_STATE);
   if(!SERVING.includes(r.state)||r.status!=='active')fail('connection_unavailable','Only an active connection can occupy a slot.',409);
   if(!this.#eligible(r,slot))fail('not_an_occupant','This integration does not declare this role with the required contracts.',403);
   if(BLOCKED.includes(lifecycle?.phase)||r.fence!==epochOf(lifecycle))fail('connection_stale','The connection changed. Reload and try again.',409);
   const {key,record}=await this.#seats(tx,slot.url);
   if(input.expectedRevision!==undefined&&input.expectedRevision!==record.revision)fail('slot_changed','The slot changed. Reload and try again.',409);
   const resource=input.resource??null;
   if(record.occupants.some(e=>e.connection===r.id&&e.resource===resource))fail('already_occupied','This resource already occupies the slot.',409);
   const removed=[];
   if(slot.policy.selection==='exclusive'&&record.occupants.length){
    if(input.replace!==true)fail('slot_occupied','Another occupant fills this slot. Replace it explicitly.',409);
    // extensions §3.4: replacing an exclusive occupant that a provider feature consumes needs recent authentication.
    if(slot.policy.consumers.includes('provider')&&!(Number.isSafeInteger(actor.authTime)&&this.clock()-actor.authTime<=RECENT_AUTH_MS&&actor.authTime<=this.clock()))fail('reauthentication_required','Confirm it is you before replacing this occupant.',401);
    removed.push(...record.occupants.map(entry=>({slot:slot.url,entry})));record.occupants=[];
   }else if(record.occupants.length>=slot.max)fail('slot_full','This slot is full.',409);
   const entry={seat:this.uuid(),connection:r.id,clientId:r.clientId,generation:r.generation,resource,purposes:structuredClone(input.purposes??[]),ingress:null,assignedAt:this.clock()};
   const at=Math.min(input.position??record.occupants.length,record.occupants.length);record.occupants.splice(at,0,entry);record.revision=(record.revision??0)+1;
   await tx.put(key,record);
   await this.#emit(tx,[...removed.map(c=>({type:'occupant-removed',slot:slot.url,seat:c.entry.seat,connection:c.entry.connection,clientId:c.entry.clientId,generation:c.entry.generation})),{type:'slot-changed',slot:slot.url,revision:record.revision,occupants:this.#summary(record)}]);
   await this.#cascade(tx,[...this.#delegationRows(removed,'system'),...DELEGATION_SLOTS.includes(slot.url)?[{kind:'reconcile'}]:[]]);
   return this.#slotView(tx,slot,record);
  });
 }
 /** `input`: {slot, seat, expectedRevision?}. */
 async vacate(owner,input){
  if(!only(input,['slot','seat','expectedRevision'])||!SEAT.test(input.seat??''))fail('invalid_request','Unsupported occupancy request.');
  const slot=this.#slot(input.slot);
  return this.metadata.transaction(async tx=>{
   const {key,record}=await this.#seats(tx,slot.url);if(input.expectedRevision!==undefined&&input.expectedRevision!==record.revision)fail('slot_changed','The slot changed. Reload and try again.',409);
   const entry=record.occupants.find(e=>e.seat===input.seat);if(!entry)fail('not_found','Occupant not found.',404);
   record.occupants=record.occupants.filter(e=>e!==entry);record.revision++;await tx.put(key,record);
   await this.#emit(tx,[{type:'occupant-removed',slot:slot.url,seat:entry.seat,connection:entry.connection,clientId:entry.clientId,generation:entry.generation},{type:'slot-changed',slot:slot.url,revision:record.revision,occupants:this.#summary(record)}]);
   await this.#cascade(tx,this.#delegationRows([{slot:slot.url,entry}],'system'));
   return this.#slotView(tx,slot,record);
  });
 }
 /** `input`: {slot, seats:[seat...] (a permutation), expectedRevision?}. Order is the owner's priority. */
 async reorder(owner,input){
  if(!only(input,['slot','seats','expectedRevision'])||!Array.isArray(input.seats))fail('invalid_request','Unsupported occupancy request.');
  const slot=this.#slot(input.slot);
  return this.metadata.transaction(async tx=>{
   const {key,record}=await this.#seats(tx,slot.url);if(input.expectedRevision!==undefined&&input.expectedRevision!==record.revision)fail('slot_changed','The slot changed. Reload and try again.',409);
   if(input.seats.length!==record.occupants.length||new Set(input.seats).size!==input.seats.length||input.seats.some(s=>!record.occupants.some(e=>e.seat===s)))fail('invalid_request','List every current occupant exactly once.');
   record.occupants=input.seats.map(s=>record.occupants.find(e=>e.seat===s));record.revision++;await tx.put(key,record);
   await this.#emit(tx,[{type:'slot-changed',slot:slot.url,revision:record.revision,occupants:this.#summary(record)}]);
   return this.#slotView(tx,slot,record);
  });
 }
 /** `input`: {slot, seat, purposes}: the owner's consented purposes for this occupant (withdrawal reconciles at once). */
 async configureSeat(owner,input){
  if(!only(input,['slot','seat','purposes'])||!SEAT.test(input.seat??'')||!purposesValid(input.purposes))fail('invalid_request','Unsupported occupancy request.');
  const slot=this.#slot(input.slot);
  return this.metadata.transaction(async tx=>{
   if(BLOCKED.includes((await tx.get(LIFECYCLE_STATE))?.phase))fail('account_suspended','This account is suspended.',423);
   const {key,record}=await this.#seats(tx,slot.url),entry=record.occupants.find(e=>e.seat===input.seat);if(!entry)fail('not_found','Occupant not found.',404);
   entry.purposes=structuredClone(input.purposes);record.revision++;await tx.put(key,record);
   await this.#emit(tx,[{type:'slot-changed',slot:slot.url,revision:record.revision,occupants:this.#summary(record)}]);
   if(DELEGATION_SLOTS.includes(slot.url))await this.#cascade(tx,[{kind:'reconcile'}]);
   return this.#slotView(tx,slot,record);
  });
 }
 /** System (the C1b `describe` adapter): records the occupant's validated ingress, on the connection's own origin,
  * for the seat incarnation the adapter observed. `input`: {slot, seat, generation, ingress}. */
 async setIngress(owner,input){
  if(!only(input,['slot','seat','generation','ingress'])||!SEAT.test(input.seat??'')||typeof input.ingress!=='string'||input.ingress.length>2048)fail('invalid_request','Unsupported occupancy request.');
  const slot=this.#slot(input.slot);
  return this.metadata.transaction(async tx=>{
   if(BLOCKED.includes((await tx.get(LIFECYCLE_STATE))?.phase))fail('account_suspended','This account is suspended.',423);
   const {key,record}=await this.#seats(tx,slot.url),entry=record.occupants.find(e=>e.seat===input.seat);if(!entry)fail('not_found','Occupant not found.',404);
   const r=await this.#load(tx,owner,entry.connection);if(entry.generation!==input.generation||r.generation!==input.generation||!SERVING.includes(r.state))fail('connection_stale','The connection changed. Reload and try again.',409);
   let u;try{u=new URL(input.ingress);}catch{fail('invalid_request','Invalid ingress.');}
   if(u.origin!==r.appOrigin||u.href!==input.ingress||u.username||u.password||u.hash||u.search)fail('invalid_request','The ingress must be on the app origin.');
   if(entry.ingress!==input.ingress){entry.ingress=input.ingress;record.revision++;await tx.put(key,record);await this.#emit(tx,[{type:'slot-changed',slot:slot.url,revision:record.revision,occupants:this.#summary(record)}]);if(DELEGATION_SLOTS.includes(slot.url))await this.#cascade(tx,[{kind:'reconcile'}]);}
   return this.#slotView(tx,slot,record);
  });
 }
 async #slotView(tx,slot,record){
  const out=[];for(const e of record.occupants){const r=await tx.get(prefix+e.connection);out.push({seat:e.seat,connection:e.connection,clientId:e.clientId,name:r?.name??null,resource:e.resource,purposes:[...e.purposes??[]],ingress:e.ingress??null,available:Boolean(r&&valid(r)&&SERVING.includes(connectionState(r))&&r.status==='active'&&r.generation===e.generation),assignedAt:e.assignedAt});}
  return {slot:slot.url,title:slot.schema.title,host:new URL(slot.url).host,selection:slot.policy.selection,max:slot.max,revision:record.revision,occupants:out};
 }
 /** Owner view: every recognized slot with its occupants (built-in and external alike, in owner order). */
 async slots(owner){return this.metadata.transaction(async tx=>{const out=[];for(const url of Object.keys(this.slotPins)){let slot;try{slot=this.#slot(url);}catch{continue;}out.push(await this.#slotView(tx,slot,(await this.#seats(tx,url)).record));}return out;});}
 /** The occupancy port core. Available occupants in owner order, plus the account fence: `sever` is true when the
  * account lifecycle is blocked, or its capability epoch moved since a seated connection was (re)activated, meaning a
  * suspension happened that no hook reported (review KD-4). */
 async occupant(owner,url){
  const slot=this.#slot(url);
  return this.metadata.transaction(async tx=>{
   const bound=await tx.get('owner');if(bound!==undefined&&bound!==owner)return {slot:slot.url,selection:slot.policy.selection,occupants:[],sever:false};
   const lifecycle=await tx.get(LIFECYCLE_STATE),{record}=await this.#seats(tx,slot.url),occupants=[];let sever=BLOCKED.includes(lifecycle?.phase);
   if(!sever)for(let after='';;){const rows=[...(await tx.list({prefix,startAfter:after,limit:200})).entries()];if(rows.some(([,r])=>r?.kind==='app-connection'&&r.owner===owner&&r.status!=='disconnected'&&r.fence!==undefined&&r.fence!==epochOf(lifecycle))){sever=true;break;}if(rows.length<200||rows.at(-1)[0]<=after)break;after=rows.at(-1)[0];}
   for(const e of record.occupants){
    const r=await tx.get(prefix+e.connection);if(!valid(r)||r.owner!==owner)continue;
    if(r.status==='active'&&r.fence!==undefined&&r.fence!==epochOf(lifecycle))sever=true;
    if(SERVING.includes(connectionState(r))&&r.status==='active'&&r.generation===e.generation&&r.fence===epochOf(lifecycle))occupants.push({seat:e.seat,connection:e.connection,clientId:e.clientId,origin:r.appOrigin??null,generation:e.generation,cnx:cnxOf(e),resource:e.resource,purposes:[...e.purposes??[]],ingress:e.ingress??null,kind:r.integration?.kind??'external'});
   }
   return {slot:slot.url,selection:slot.policy.selection,occupants:sever?[]:occupants,sever};
  });
 }
 /** A selection state machine (packages/federation/extensions.mjs createSlotOperation) over the current occupancy:
  * configured occupants in owner order, unavailable ones marked so, for a consumer of this slot. */
 async slotOperation(owner,url,{consumer='provider',featureEnabled=false}={}){
  const slot=this.#slot(url),view=await this.metadata.transaction(async tx=>this.#slotView(tx,slot,(await this.#seats(tx,slot.url)).record)),live=await this.occupant(owner,url);
  const occupants=view.occupants.map(o=>({id:o.seat,status:!live.sever&&live.occupants.some(a=>a.seat===o.seat)?'available':'unavailable',credentialCurrent:true}));
  return createSlotOperation(slot.schema,slot.max===1?occupants[0]:occupants,{consumer,featureEnabled});
 }

 // ---- Outbox and cascades (system actors only) ----
 async outbox(owner,{after=0,limit=100}={}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>500)fail('invalid_request','Unsupported outbox request.');
  return this.metadata.transaction(async tx=>{const m=await this.#meta(tx),rows=[...(await tx.list({prefix:OUTBOX,limit:OUTBOX_LIMIT+1})).values()].filter(e=>e.seq>after).sort((a,b)=>a.seq-b.seq);return {events:rows.slice(0,limit),seq:m.seq,gap:after<m.low};});
 }
 async ack(owner,{through}={}){
  if(!Number.isSafeInteger(through)||through<0)fail('invalid_request','Unsupported acknowledgment.');
  return this.metadata.transaction(async tx=>{const m=await this.#meta(tx),upto=Math.min(through,m.seq);let removed=0;for(const [key,e] of await tx.list({prefix:OUTBOX,limit:OUTBOX_LIMIT+1}))if(e.seq<=upto){await tx.delete(key);removed++;}m.low=Math.max(m.low,upto);await tx.put(META,m);return {acknowledged:upto,removed};});
 }
 async cascades(owner){return this.metadata.transaction(async tx=>[...(await tx.list({prefix:CASCADE,limit:CASCADE_LIMIT+2})).entries()].map(([key,row])=>({key,...row})));}
 async cascadeDone(owner,key){
  if(typeof key!=='string'||!key.startsWith(CASCADE))fail('invalid_request','Unsupported cascade.');
  return this.metadata.transaction(async tx=>{if(await tx.get(key)===undefined)return {done:false};await tx.delete(key);if(key!==CASCADE_ALL){const m=await this.#meta(tx);m.pending=Math.max(0,m.pending-1);await tx.put(META,m);}return {done:true};});
 }
}
