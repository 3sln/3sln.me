// EXT-X7 brokered resource records and provider-to-integration resource calls (docs/spec/integrations.md §4.3–§4.5,
// §5.3, §5.6, §7.1; docs/spec/bindlebox.md §2.2; extensibility-design X7). Engine-first: `brokeredResourcesProvider`
// is the owner-scoped resource over the account store; the Actions/Queries below are the operations. Everything is
// refused with `not_found` unless INTEGRATIONS_ENABLED is on; records, `describe` and the severance hooks also need
// BROKERING_ENABLED. Nothing here mints consumer tokens or emits events: X8 drains the severance rows written here
// (credential-revoked / resource-detached) and mints from the `mintable` hook.
//
// A brokered record is the provider's coupling: {id, connection, clientId, generation, connectedAt, resource, label,
// contracts, rpcEndpoint, status, assignments[]}. `id` is a fresh provider UUID, unique per (connection, integration
// resource) through an index row; the integration's string is never a provider key. Each assignment links one consumer
// (an app `clientId`, or a provider feature `ref` for a slot it consumes) to one field binding ({fragment, field} or
// {slot}) with the contracts that field requires, and carries its own opaque `grant` (a new one on every
// re-assignment). A record is usable only while its connection is active or degraded, at the record's generation,
// in the same incarnation (`connectedAt`, no disconnect since registration) and under the account's lifecycle fence;
// a generation bumped by resume/approve leaves it stale until an authenticated lookup rebinds it, and a reconnect
// never revives it.
//
// Actors (built by trusted adapters only): {kind:'owner', owner} candidates, discover, records, register, reconfirm,
// unassign, detach, revalidate, scope-describe; {kind:'system', owner} records, revalidate, describe (C1b messaging
// descriptors), mintable, severance, severance-done.
import {Provider} from '../../vendor/ngin/index.js';
import {AppAction,AppQuery} from '../app/engine.mjs';
import {AppFault} from '../app/faults.mjs';
import {UUID} from '../core/primitives.mjs';
import {connectionState,RECOGNIZED_SLOTS} from '../apps/connections.mjs';
import {MESSAGING_INGRESS_SLOT,MESSAGING_ADDRESS_DECLARATION} from '../links/types.mjs';
import {RESOURCE_SCOPING} from '../storage/scoping.mjs';
import {resourceId,DISCOVERY_LIMITS} from './resource-discovery.mjs';

export const MAILBOX_CONTRACT='https://spec.bindle.example/bindlebox/v1/contracts/mailbox';
export const BROKERED_LIMITS=Object.freeze({perConnection:64,perAccount:256,assignments:16,callBytes:16384,severance:1024,overflow:512,probe:8,candidates:100,hintCoalesceMs:60000,failuresToDegrade:3});
/** Provider features that consume a slot through a brokered record (extensions §5.3), by slot: the feature `ref` is
 * the token's `bindle.feature` and the only provider consumer a record for that slot may name. */
export const PROVIDER_CONSUMERS=Object.freeze({[MESSAGING_INGRESS_SLOT]:Object.freeze([MESSAGING_ADDRESS_DECLARATION.ref])});
const RECORD='integrations/record/',INDEX='integrations/resource/',SEVER='integrations/severance/',META='integrations/meta',CONNECTION='resource/',LIFECYCLE='lifecycle/state-v1';
const SERVING=['active','degraded'],BLOCKED=['suspended','purge-review','purging'];
const fault=(code,message,status,extra={})=>{throw Object.assign(new AppFault(code,message,status),extra);};
const notFound=()=>fault('not_found','Not found.',404);
const forbidden=()=>fault('forbidden','This operation is not available to this caller.',403);
const invalid=(message='Unsupported request.')=>fault('invalid_request',message,400);
const unavailable=()=>fault('resource_unavailable','This resource is not available right now.',409);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const only=(v,names)=>v===undefined?{}:plain(v)&&Object.keys(v).every(k=>names.includes(k))?v:invalid();
const idURL=v=>{if(typeof v!=='string'||v.length>256||v.includes('#')||v.includes('?'))return false;try{const u=new URL(v);return u.href===v&&u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const clientURL=v=>{if(typeof v!=='string'||v.length>2048||v.includes('#'))return false;try{const u=new URL(v);return u.href===v&&u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const FIELD=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/,FEATURE=/^[a-z][a-z0-9-]{0,63}$/;
const pad=n=>String(n).padStart(16,'0');
// The lookup anchor: a contract an assignment actually uses, so narrowing elsewhere stays visible in the claims.
const anchorOf=r=>r.assignments.find(a=>a.contracts.length)?.contracts[0]??r.contracts[0];
const epochOf=s=>Number.isSafeInteger(s?.capabilityEpoch)?s.capabilityEpoch:0;
export const brokeringFlag=config=>config?.BROKERING_ENABLED===true||config?.BROKERING_ENABLED==='true';
export const integrationsFlag=config=>config?.INTEGRATIONS_ENABLED===true||config?.INTEGRATIONS_ENABLED==='true';
const indexKey=async(connection,resource)=>INDEX+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`brokered-record/v1\0${connection}\0${resource}`)))].map(b=>b.toString(16).padStart(2,'0')).join('');

// ---- Connection reads (mirror AppConnections.check: the same store, record shape and lifecycle fence) ----
/** The external connection `id` of `owner` as seen inside `tx`, or null. */
export async function readConnection(tx,owner,id){
 if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))return null;
 const r=await tx.get(CONNECTION+id);if(r?.kind!=='app-connection'||r.provider!=='app'||r.owner!==owner||!Number.isSafeInteger(r.generation)||r.integration?.kind!=='external')return null;
 const manifest=r.integration.snapshot?.manifest;if(!plain(manifest))return null;
 const lifecycle=await tx.get(LIFECYCLE),state=connectionState(r),fenced=r.fence!==undefined&&(BLOCKED.includes(lifecycle?.phase)||r.fence!==epochOf(lifecycle));
 return {id,clientId:r.clientId,name:r.name,origin:r.appOrigin??null,state,status:r.status,generation:r.generation,connectedAt:r.connectedAt,disconnectedAt:r.disconnectedAt,manifest:structuredClone(manifest),serving:SERVING.includes(state)&&r.status==='active'&&!fenced,tokenAuth:(SERVING.includes(state)||state==='configuring')&&r.status==='active'&&!fenced};
}
/** 'live' | 'stale' (same incarnation, generation moved on: rebind after an authenticated lookup) | 'ended'. */
export function recordState(record,connection){
 if(!connection||connection.clientId!==record.clientId||connection.connectedAt!==record.connectedAt||connection.disconnectedAt!==undefined&&connection.disconnectedAt>=record.registeredAt||connection.state==='disconnected')return 'ended';
 return connection.generation===record.generation?'live':connection.generation>record.generation?'stale':'ended';
}
const usable=(record,connection)=>recordState(record,connection)==='live'&&connection.serving&&record.status==='available';
const view=(record,connection)=>({id:record.id,connection:record.connection,clientId:record.clientId,resource:record.resource,label:record.label,contracts:[...record.contracts],status:record.status,...record.reason?{reason:record.reason}:{},state:recordState(record,connection),available:Boolean(connection&&usable(record,connection)),unverified:true,registeredAt:record.registeredAt,revalidatedAt:record.revalidatedAt,assignments:record.assignments.map(a=>({grant:a.grant,binding:structuredClone(a.binding),consumer:structuredClone(a.consumer),contracts:[...a.contracts],assignedAt:a.assignedAt}))});

/** Validates a field binding and consumer. Slot bindings take their contracts from the recognized slot pin and only a
 * provider feature that consumes that slot, or an app; fragment bindings take the owner's required contracts (X8
 * reconciles them with the pinned fragment). Returns {binding, consumer, contracts}. */
export function assignmentInput({binding,consumer,contracts},{slots=RECOGNIZED_SLOTS}={}){
 if(!plain(binding)||!plain(consumer))invalid('Choose a field and a consumer.');
 let b,required;
 if(Object.keys(binding).length===1&&idURL(binding.slot)){
  const pin=Object.hasOwn(slots,binding.slot)?slots[binding.slot]:null,field=pin?.fields?.[pin?.slot?.field];if(!field?.contracts?.length)fault('unsupported_slot','This slot is not recognized here.',400);
  b={slot:binding.slot};required=[...field.contracts];if(contracts!==undefined&&JSON.stringify([...contracts].sort())!==JSON.stringify([...required].sort()))invalid('A slot decides its own contracts.');
 }else if(Object.keys(binding).length===2&&idURL(binding.fragment)&&typeof binding.field==='string'&&FIELD.test(binding.field)){
  if(!Array.isArray(contracts)||!contracts.length||contracts.length>DISCOVERY_LIMITS.contracts||new Set(contracts).size!==contracts.length||!contracts.every(idURL))invalid('Name the contracts this field requires.');
  b={fragment:binding.fragment,field:binding.field};required=[...contracts];
 }else invalid('Choose a preference field or a slot.');
 let c;
 if(Object.keys(consumer).length===1&&typeof consumer.feature==='string'&&FEATURE.test(consumer.feature)){if(!b.slot||!(PROVIDER_CONSUMERS[b.slot]??[]).includes(consumer.feature))forbidden();c={feature:consumer.feature};}
 else if(Object.keys(consumer).length===1&&clientURL(consumer.clientId))c={clientId:consumer.clientId};
 else invalid('Choose the app or provider feature that uses this resource.');
 return {binding:b,consumer:c,contracts:required.sort()};
}
const sameAssignment=(a,{binding,consumer})=>JSON.stringify(a.binding)===JSON.stringify(binding)&&JSON.stringify(a.consumer)===JSON.stringify(consumer);

/** The `connections`-style provider class for createAppEngine. `store`: the account's transactional metadata (the
 * same store as the connection records). `discovery`: a DiscoveryClient (mint + egress injected). `brokering`:
 * BROKERING_ENABLED. `issuer`: the provider origin. */
export function brokeredResourcesProvider({store,discovery,issuer,integrations=false,brokering=false,slots=RECOGNIZED_SLOTS,clock=()=>Date.now(),uuid=()=>crypto.randomUUID()}={}){
 return class extends BrokeredResourcesProvider{static deps=[];constructor(){super();Object.assign(this,{store,discovery,issuer,integrations:integrations===true,brokering:brokering===true,slots,clock,uuid});}};
}
export class BrokeredResourcesProvider extends Provider{
 async obtain({actor}={}){
  if(!this.integrations||!this.store||!this.discovery)notFound();
  if(!UUID.test(actor?.owner??'')||!['owner','system'].includes(actor?.kind))fault('unauthorized','Sign in to continue.',401);
  const bound=await this.store.get('owner');if(bound!==undefined&&bound!==actor.owner)fault('forbidden','Account owner mismatch.',403);
  return Object.freeze(scope(this,actor));
 }
 release(){}
}

function scope(p,actor){
 const owner=actor.owner,system=actor.kind==='system',subject=`${p.issuer}/entities/${owner}`;
 const ownerOnly=()=>{if(system)forbidden();},systemOnly=()=>{if(!system)forbidden();},records=()=>{if(!p.brokering)notFound();};
 const tx=fn=>p.store.transaction(fn);
 const connection=id=>tx(t=>readConnection(t,owner,id));
 const serving=async id=>{const c=await connection(id);if(!c)notFound();if(!c.serving)fault('connection_unavailable','This connection is not active.',409);if(!c.manifest.resources)fault('discovery_unavailable','This integration offers no resources.',409);return c;};
 const meta=async t=>{const m=await t.get(META);return plain(m)&&Number.isSafeInteger(m.seq)?m:{seq:0,low:0,health:{},hints:{}};};
 // Severance rows commit with the change (§7.2 step 1) and are never refused: past the bound, rows collapse into one
 // `overflow` row per connection, which X8 must treat as revoking every grant of that connection (X7-R4).
 const sever=async(t,rows)=>{rows=rows.filter(r=>r.grants.length||r.type==='detached');if(!rows.length)return;const m=await meta(t),at=p.clock();
  for(const row of rows){m.seq++;if(m.seq-m.low>BROKERED_LIMITS.severance)await t.put(SEVER+'~'+row.connection,{seq:m.seq,at,type:'overflow',connection:row.connection,generation:row.generation,grants:[]});else await t.put(SEVER+pad(m.seq),{seq:m.seq,at,...row});}
  await t.put(META,m);};
 // Numbered rows and per-connection overflow rows are listed separately, so overflow never falls outside a listing.
 const severanceEntries=async t=>[...(await t.list({prefix:SEVER+'0',limit:BROKERED_LIMITS.severance+1})).entries(),...(await t.list({prefix:SEVER+'~',limit:BROKERED_LIMITS.overflow})).entries()];
 const severanceRows=async t=>(await severanceEntries(t)).map(([,row])=>row);
 /** Narrows a record to `kept` and returns the severance row for the assignments that lose a contract (X7-R3). */
 const narrow=(r,kept)=>{const hit=r.assignments.filter(a=>a.contracts.some(k=>!kept.includes(k))).map(a=>a.grant);r.contracts=[...kept];for(const a of r.assignments)a.contracts=a.contracts.filter(k=>kept.includes(k));return hit.length?[{type:'narrowed',connection:r.connection,generation:r.generation,resource:r.resource,grants:hit}]:[];};
 const allRecords=async t=>{const rows=[...(await t.list({prefix:RECORD,limit:BROKERED_LIMITS.perAccount+1})).values()];if(rows.length>BROKERED_LIMITS.perAccount)fault('unavailable','Too many brokered records.',503);return rows.filter(r=>r?.v===1&&r.owner===owner);};
 const load=async(t,id)=>{if(typeof id!=='string'||!UUID.test(id))notFound();const r=await t.get(RECORD+id);if(r?.v!==1||r.owner!==owner)notFound();return r;};
 const remove=async(t,r)=>{await t.delete(RECORD+r.id);await t.delete(await indexKey(r.connection,r.resource));};
 /** One authenticated exact lookup of `ids` (anchor contract: narrowing is visible in the claims). */
 const lookup=(c,contract,ids)=>p.discovery.discover({subject,connection:c,query:{contracts:[contract],ids},fresh:true});
 async function health(connectionId,ok){
  return tx(async t=>{const m=await meta(t),h=m.health[connectionId]??{failures:0,degraded:false};
   if(ok){const change=h.degraded?'recovered':null;delete m.health[connectionId];await t.put(META,m);return change;}
   h.failures++;const change=!h.degraded&&h.failures>=BROKERED_LIMITS.failuresToDegrade?'degraded':null;if(change)h.degraded=true;m.health[connectionId]=h;
   if(Object.keys(m.health).length>BROKERED_LIMITS.candidates)delete m.health[Object.keys(m.health)[0]];await t.put(META,m);return change;});
 }
 /** A provider-feature brokered call (bindlebox §2.2) or the scoping `describe` (§5.6), bounded and envelope-checked. */
 async function brokeredCall(c,record,{purpose,contract,method,grant,feature,pool='owner'}){
  if(c.manifest.resources?.dpop==='required')unavailable();// The provider consumer holds no DPoP key (§5.4).
  const url=p.discovery.endpoint(c,'rpc_endpoint');if(resourceId(record.resource,url.href)!==record.resource)unavailable();
  const txId=p.uuid(),answer=await p.discovery.call({connection:c,url,pool,maxBytes:BROKERED_LIMITS.callBytes,claims:{subject,purpose,connection:c.id,generation:c.generation,resource:record.resource,grant,methods:{[contract]:[method]},scope:null,lifetime:60,...feature?{feature}:{}},body:{version:"0",tx:txId,resource:record.resource,contract,method,args:{}}});
  if(answer.status!==200||!/^application\/json(?:\s*;.*)?$/i.test(answer.contentType??''))fault('describe_failed','The integration did not describe this resource.',502);
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(answer.bytes));}catch{body=null;}
  if(!plain(body)||Object.keys(body).some(k=>!['version','tx','result','error'].includes(k))||body.version!=='0'||body.tx!==txId||Object.hasOwn(body,'error')||!plain(body.result))fault('describe_failed','The integration did not describe this resource.',502);
  return body.result;
 }
 return {
  /** Connections that can offer every contract in `contracts` (the picker's first step). `probe` (owner, at most 8
   * candidates) asks each integration whether anything matches (§4.2 `limit: 0`); a failed probe reads `exists: null`. */
  async candidates(input){
   const v=only(input,['contracts','probe']);if(!Array.isArray(v.contracts)||!v.contracts.length||v.contracts.length>DISCOVERY_LIMITS.contracts||!v.contracts.every(idURL))invalid('Choose between one and eight contracts.');if(v.probe!==undefined&&typeof v.probe!=='boolean')invalid();
   const list=await tx(async t=>{const rows=[...(await t.list({prefix:CONNECTION,limit:201})).entries()].filter(([,r])=>r?.kind==='app-connection');const out=[];for(const [key] of rows){const c=await readConnection(t,owner,key.slice(CONNECTION.length));if(c?.serving&&c.manifest.resources&&v.contracts.every(x=>c.manifest.resources.contracts.includes(x)))out.push(c);}return out;});
   const out=list.map(c=>({connection:c.id,name:c.name,clientId:c.clientId,origin:c.origin,generation:c.generation,state:c.state,contracts:[...c.manifest.resources.contracts],unverified:true}));
   if(v.probe===true){ownerOnly();for(const [i,c] of list.entries()){if(i>=BROKERED_LIMITS.probe)break;try{out[i].exists=(await p.discovery.discover({subject,connection:c,query:{contracts:v.contracts,limit:0}})).exists;}catch{out[i].exists=null;}}}
   return {candidates:out};
  },
  /** Owner search, filter and browse through one connection's discovery endpoint (§4.1). */
  async discover(input){ownerOnly();const {connection:id,...query}=only(input,['connection','contracts','text','facets','parent','ids','cursor','limit']);const c=await serving(id);
   try{const result=await p.discovery.discover({subject,connection:c,query}),recovered=await health(c.id,true);return {connection:c.id,generation:c.generation,...result,...recovered?{health:recovered}:{}};}
   catch(error){if(['discovery_failed','discovery_rejected','egress_refused'].includes(error?.code))error.health=await health(c.id,false);throw error;}
  },
  async records(input){records();const v=only(input,['connection']);if(v.connection!==undefined&&typeof v.connection!=='string')invalid();
   return tx(async t=>{const out=[];for(const r of await allRecords(t)){if(v.connection!==undefined&&r.connection!==v.connection)continue;out.push(view(r,await readConnection(t,owner,r.connection)));}return {records:out.sort((a,b)=>a.registeredAt-b.registeredAt||(a.id<b.id?-1:1))};});
  },
  /** Registers (or re-assigns) a discovered item for one field binding and consumer. The item is re-read through a
   * fresh authenticated lookup: nothing the owner's browser sends about it (label, contracts) is trusted (§4.5). */
  async register(input){
   ownerOnly();records();const v=only(input,['connection','resource','binding','consumer','contracts']);
   const a=assignmentInput(v,{slots:p.slots}),c=await serving(v.connection);
   if(!resourceId(v.resource,c.manifest.resources.rpc_endpoint))invalid('Choose a resource this integration offered.');
   if(a.contracts.some(x=>!c.manifest.resources.contracts.includes(x)))fault('unsupported_contract','This integration does not offer the contracts this field needs.',400);
   const {items}=await p.discovery.discover({subject,connection:c,query:{contracts:a.contracts,ids:[v.resource]},fresh:true}),item=items.find(i=>i.id===v.resource&&i.assignable);
   if(!item)fault('resource_unavailable','The integration no longer offers this resource for that field.',409);
   return tx(async t=>{
    const now=await readConnection(t,owner,c.id);if(!now?.serving||now.generation!==c.generation||now.connectedAt!==c.connectedAt)fault('connection_stale','The connection changed. Reload and try again.',409);
    const key=await indexKey(c.id,item.id),existing=await t.get(key),at=p.clock(),contracts=item.contracts.filter(x=>now.manifest.resources.contracts.includes(x)).sort(),rows=[];
    let r=existing?await t.get(RECORD+existing):null;if(r&&(r.v!==1||r.owner!==owner||r.connection!==c.id))r=null;
    if(r&&recordState(r,now)==='ended'){rows.push({type:'detached',connection:r.connection,generation:r.generation,resource:r.resource,grants:r.assignments.map(x=>x.grant)});await remove(t,r);r=null;}
    if(!r){const all=await allRecords(t);if(all.length>=BROKERED_LIMITS.perAccount||all.filter(x=>x.connection===c.id).length>=BROKERED_LIMITS.perConnection)fault('record_limit','This account has reached its brokered resource limit.',429);
     r={v:1,id:p.uuid(),owner,connection:c.id,clientId:now.clientId,connectedAt:now.connectedAt,registeredAt:at,resource:item.id,assignments:[]};}
    if(r.contracts)rows.push(...narrow(r,r.contracts.filter(k=>contracts.includes(k))));// the owner's re-registration may widen; others never silently narrow
    Object.assign(r,{generation:now.generation,label:item.label,contracts,rpcEndpoint:now.manifest.resources.rpc_endpoint,status:'available',revalidatedAt:at});delete r.reason;
    const old=r.assignments.find(x=>sameAssignment(x,a));if(old)rows.push({type:'reassigned',connection:r.connection,generation:r.generation,resource:r.resource,grants:[old.grant]});
    r.assignments=r.assignments.filter(x=>x!==old);if(r.assignments.length>=BROKERED_LIMITS.assignments)fault('record_limit','This resource is assigned to too many fields.',429);
    r.assignments.push({grant:p.uuid(),binding:a.binding,consumer:a.consumer,contracts:a.contracts.filter(x=>contracts.includes(x)),assignedAt:at});
    await sever(t,rows);await t.put(RECORD+r.id,r);await t.put(key,r.id);return view(r,now);
   });
  },
  /** Owner reconfirmation of an `unavailable` (or stale) record after a fresh lookup still finds it (§4.4). */
  async reconfirm(input){
   ownerOnly();records();const v=only(input,['record']);const r=await tx(t=>load(t,v.record)),c=await serving(r.connection);
   if(recordState(r,c)==='ended')unavailable();
   const found=(await lookup(c,anchorOf(r),[r.resource])).items.find(i=>i.id===r.resource);if(!found)unavailable();
   return tx(async t=>{const x=await load(t,r.id),now=await readConnection(t,owner,x.connection);if(!now?.serving||now.generation!==c.generation||recordState(x,now)==='ended')fault('connection_stale','The connection changed. Reload and try again.',409);
    const kept=x.contracts.filter(k=>found.contracts.includes(k));if(!kept.length)unavailable();const rows=narrow(x,kept);
    Object.assign(x,{generation:now.generation,label:found.label,status:'available',revalidatedAt:p.clock()});delete x.reason;
    await sever(t,rows);await t.put(RECORD+x.id,x);return view(x,now);});
  },
  /** Removes one assignment (the owner took the resource out of a field, or replaced its consumer). */
  async unassign(input){ownerOnly();records();const v=only(input,['record','grant']);if(typeof v.grant!=='string')invalid();
   return tx(async t=>{const r=await load(t,v.record),a=r.assignments.find(x=>x.grant===v.grant);if(!a)notFound();r.assignments=r.assignments.filter(x=>x!==a);
    await sever(t,[{type:'unassigned',connection:r.connection,generation:r.generation,resource:r.resource,grants:[a.grant]}]);await t.put(RECORD+r.id,r);return view(r,await readConnection(t,owner,r.connection));});
  },
  /** Detach (§7.1): the record and every assignment go in one commit with the severance row X8 turns into
   * credential-revoked for every grant, then resource-detached. */
  async detach(input){ownerOnly();records();const v=only(input,['record']);
   const r=await tx(async t=>{const r=await load(t,v.record);await sever(t,[{type:'detached',connection:r.connection,generation:r.generation,resource:r.resource,grants:r.assignments.map(a=>a.grant)}]);await remove(t,r);return r;});
   p.discovery.forget(r.connection);return {detached:true,record:r.id};
  },
  /** Revalidation (§4.4): exact lookups in batches of 50 per anchor contract. Missing -> unavailable until the owner
   * reconfirms; narrowed -> contracts removed; widened -> ignored; network failure -> unchanged, health counted.
   * Records of an ended incarnation are pruned (the connection-level revocation already covers them). `reason`:
   * 'owner' | 'scheduled' | 'hint' (hints coalesce within 60 s). */
  async revalidate(input){
   records();const v=only(input,['connection','reason']);const reason=v.reason??(system?'scheduled':'owner');if(!['owner','scheduled','hint'].includes(reason)||!system&&reason!=='owner')invalid();
   const c=await connection(v.connection);if(!c&&!system)notFound();
   const mine=await tx(async t=>{const out=[],ended=[];for(const r of await allRecords(t))if(r.connection===v.connection)(recordState(r,c)==='ended'?ended:out).push(r);for(const r of ended)await remove(t,r);
    if(reason==='hint'){const m=await meta(t),last=m.hints[v.connection]??0;if(p.clock()-last<BROKERED_LIMITS.hintCoalesceMs)return {coalesced:true,pruned:ended.length};m.hints[v.connection]=p.clock();for(const k of Object.keys(m.hints))if(p.clock()-m.hints[k]>BROKERED_LIMITS.hintCoalesceMs)delete m.hints[k];await t.put(META,m);}
    return {records:out,pruned:ended.length};});
   if(mine.coalesced)return {coalesced:true,checked:0,pruned:mine.pruned};
   if(!c?.serving||!c.manifest.resources||!mine.records.length)return {checked:0,pruned:mine.pruned,skipped:!c?.serving};
   p.discovery.forget(c.id);
   const groups=new Map();for(const r of mine.records){const anchor=anchorOf(r);if(!anchor)continue;if(!groups.has(anchor))groups.set(anchor,[]);groups.get(anchor).push(r);}
   const seen=new Map();
   try{for(const [anchor,list] of groups)for(let i=0;i<list.length;i+=DISCOVERY_LIMITS.ids){const ids=list.slice(i,i+DISCOVERY_LIMITS.ids).map(r=>r.resource);for(const item of (await lookup(c,anchor,ids)).items)seen.set(item.id,item);}}
   catch(error){if(['discovery_rate_limited','brokering_unavailable','discovery_unavailable'].includes(error?.code))throw error;return {checked:0,pruned:mine.pruned,failed:true,health:await health(c.id,false)};}
   const recovered=await health(c.id,true);
   const changes=await tx(async t=>{const now=await readConnection(t,owner,c.id);if(!now||now.generation!==c.generation)fault('connection_stale','The connection changed. Reload and try again.',409);const rows=[],counts={unavailable:0,narrowed:0,rebound:0};
    for(const old of mine.records){let r;try{r=await load(t,old.id);}catch{continue;}if(recordState(r,now)==='ended')continue;const found=seen.get(r.resource),at=p.clock();
     if(!found){if(r.status!=='unavailable'){r.status='unavailable';r.reason='missing';counts.unavailable++;rows.push({type:'unavailable',connection:r.connection,generation:r.generation,resource:r.resource,grants:r.assignments.map(a=>a.grant)});}}
     else{const kept=r.contracts.filter(k=>found.contracts.includes(k));if(kept.length<r.contracts.length){counts.narrowed++;rows.push(...narrow(r,kept));}
      if(r.generation<now.generation&&r.status==='available'){r.generation=now.generation;counts.rebound++;}}
     r.revalidatedAt=at;await t.put(RECORD+r.id,r);}
    await sever(t,rows);return counts;});
   return {checked:mine.records.length,pruned:mine.pruned,...changes,...recovered?{health:recovered}:{}};
  },
  /** C1b: the messaging occupant's `describe` (bindlebox §2.2) through the brokered record its seat names, as the
   * `messaging-address` provider feature. `seat` is the occupancy port's answer ({seat, connection, clientId,
   * generation, resource, cnx}); every link of seat -> record -> connection is re-checked here, so a seat pointing at
   * another connection's record, a stale generation, a detached or unavailable record or a DPoP-required integration
   * all answer resource_unavailable. Returns the raw `result`; the caller validates it against §2.3. */
  async describe(input){
   systemOnly();records();const v=only(input,['slot','seat']);const seat=v.seat,feature=(PROVIDER_CONSUMERS[v.slot]??[])[0];
   if(!feature||!plain(seat)||typeof seat.resource!=='string'||!UUID.test(seat.resource)||typeof seat.connection!=='string'||!Number.isSafeInteger(seat.generation)||typeof seat.cnx!=='string'||!/^[a-f0-9-]{36}\.\d{1,16}$/.test(seat.cnx))unavailable();
   let {record:r,connection:c}=await tx(async t=>{let r;try{r=await load(t,seat.resource);}catch{unavailable();}return {record:r,connection:await readConnection(t,owner,r.connection)};});
   const assignment=r.assignments.find(a=>a.binding.slot===v.slot&&a.consumer.feature===feature&&a.contracts.includes(MAILBOX_CONTRACT));
   if(!assignment||r.connection!==seat.connection||!c||c.clientId!==seat.clientId||c.generation!==seat.generation||!c.serving||r.status!=='available')unavailable();
   // A stale record is never rebound from here: a public descriptor request must not cause lookups (X7-R2). The
   // account alarm and owner revalidation rebind it.
   if(!usable(r,c)||!r.contracts.includes(MAILBOX_CONTRACT))unavailable();
   return brokeredCall(c,r,{purpose:'invoke',contract:MAILBOX_CONTRACT,method:'describe',grant:`${assignment.grant}.${seat.cnx}`,feature,pool:'describe'});
  },
  /** §5.6 step 1: the scoping contract's `describe`, for the owner choosing scope controls on a brokered record. */
  async scopeDescribe(input){ownerOnly();records();const v=only(input,['record']);const {record:r,connection:c}=await tx(async t=>{const r=await load(t,v.record);return {record:r,connection:await readConnection(t,owner,r.connection)};});
   if(!usable(r,c)||!r.contracts.includes(RESOURCE_SCOPING))unavailable();return brokeredCall(c,r,{purpose:'describe',contract:RESOURCE_SCOPING,method:'describe',grant:`scope.${r.id}`});
  },
  /** X8 minting hook: the live coupling for one assignment, or resource_unavailable. Methods are the caller's (the
   * grant ∩ this assignment's contracts); minting must run in this account's serialization domain. */
  async mintable(input){systemOnly();records();const v=only(input,['record','grant']);
   return tx(async t=>{const r=await load(t,v.record),c=await readConnection(t,owner,r.connection),a=r.assignments.find(x=>x.grant===v.grant);if(!a||!c||!usable(r,c))unavailable();
    return {subject,audience:c.manifest.resources.rpc_endpoint,connection:c.id,generation:c.generation,resource:r.resource,grant:a.grant,contracts:a.contracts.filter(k=>r.contracts.includes(k)),dpop:c.manifest.resources.dpop??'none',...a.consumer.feature?{feature:a.consumer.feature}:{clientId:a.consumer.clientId}};});
  },
  /** X8 severance hooks: committed rows in order, and acknowledgment once their events are durably enqueued. */
  async severance(input){systemOnly();records();const v=only(input,['after','limit']),after=v.after??0,limit=v.limit??100;if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>500)invalid();
   return tx(async t=>{const m=await meta(t);return {rows:(await severanceRows(t)).filter(r=>r.seq>after).sort((a,b)=>a.seq-b.seq).slice(0,limit),seq:m.seq};});
  },
  async severanceDone(input){systemOnly();records();const v=only(input,['through']);if(!Number.isSafeInteger(v.through)||v.through<0)invalid();
   return tx(async t=>{const m=await meta(t),upto=Math.min(v.through,m.seq);let removed=0;for(const [key,row] of await severanceEntries(t))if(row.seq<=upto){await t.delete(key);removed++;}m.low=Math.max(m.low,upto);await t.put(META,m);return {acknowledged:upto,removed};});
  },
 };
}

const CHANGED='brokered-records-changed';
export class IntegrationCandidates extends AppQuery{static operation='integrations.candidates';static deps=['brokeredResources'];fetch({brokeredResources}){return brokeredResources.candidates(this.input);}}
export class DiscoverResources extends AppQuery{static operation='integrations.discover';static deps=['brokeredResources'];static gate='none';fetch({brokeredResources}){return brokeredResources.discover(this.input);}}
export class BrokeredRecords extends AppQuery{static operation='integrations.records';static deps=['brokeredResources'];static refreshOn=[CHANGED];fetch({brokeredResources}){return brokeredResources.records(this.input);}}
/** Owner. `input`: {connection, resource, binding, consumer, contracts?}. */
export class RegisterBrokeredRecord extends AppAction{static operation='integrations.register';static deps=['brokeredResources'];static changes=CHANGED;run({brokeredResources}){return brokeredResources.register(this.input);}}
export class ReconfirmBrokeredRecord extends AppAction{static operation='integrations.reconfirm';static deps=['brokeredResources'];static changes=CHANGED;run({brokeredResources}){return brokeredResources.reconfirm(this.input);}}
export class UnassignBrokeredRecord extends AppAction{static operation='integrations.unassign';static deps=['brokeredResources'];static changes=CHANGED;run({brokeredResources}){return brokeredResources.unassign(this.input);}}
export class DetachBrokeredRecord extends AppAction{static operation='integrations.detach';static deps=['brokeredResources'];static changes=CHANGED;run({brokeredResources}){return brokeredResources.detach(this.input);}}
export class RevalidateBrokeredRecords extends AppAction{static operation='integrations.revalidate';static deps=['brokeredResources'];static changes=CHANGED;run({brokeredResources}){return brokeredResources.revalidate(this.input);}}
/** System (C1b). `input`: {slot, seat}. */
export class DescribeOccupant extends AppQuery{static operation='integrations.describe';static deps=['brokeredResources'];static gate='none';fetch({brokeredResources}){return brokeredResources.describe(this.input);}}
export class DescribeScoping extends AppQuery{static operation='integrations.scope-describe';static deps=['brokeredResources'];static gate='none';fetch({brokeredResources}){return brokeredResources.scopeDescribe(this.input);}}
export class MintableRecord extends AppQuery{static operation='integrations.mintable';static deps=['brokeredResources'];fetch({brokeredResources}){return brokeredResources.mintable(this.input);}}
export class BrokeredSeverance extends AppQuery{static operation='integrations.severance';static deps=['brokeredResources'];fetch({brokeredResources}){return brokeredResources.severance(this.input);}}
export class AckBrokeredSeverance extends AppAction{static operation='integrations.severance-done';static deps=['brokeredResources'];run({brokeredResources}){return brokeredResources.severanceDone(this.input);}}

export const BROKERED_OPERATIONS=Object.freeze([IntegrationCandidates,DiscoverResources,BrokeredRecords,RegisterBrokeredRecord,ReconfirmBrokeredRecord,UnassignBrokeredRecord,DetachBrokeredRecord,RevalidateBrokeredRecords,DescribeOccupant,DescribeScoping,MintableRecord,BrokeredSeverance,AckBrokeredSeverance]);
export const BROKERED_OWNER_OPERATIONS=Object.freeze(['integrations.candidates','integrations.discover','integrations.records','integrations.register','integrations.reconfirm','integrations.unassign','integrations.detach','integrations.revalidate','integrations.scope-describe']);
