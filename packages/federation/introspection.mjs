// EXT-X8 brokered consumer tokens, severance draining and introspection (docs/spec/integrations.md §5.1, §5.3–§5.5,
// §5.7, §6.2, §7; extensibility-design X8; AMD-C3/C8/C9/C10). Engine-first: `brokeredTokensProvider` is the
// system-scoped handle over the account store, used beside the X7 `brokeredResources` provider; the Actions/Queries
// below are the operations, and the account slice at the bottom composes them. Everything answers not_found unless
// INTEGRATIONS_ENABLED and BROKERING_ENABLED are both on and the owner binding matches.
//
// Minting (§5.3, §7.4) is check → sign → confirm, all against the account store that X7 severance commits use:
//   1. the X7 severance high-water mark, then the live coupling (`mintable`: connection active/degraded at the record's
//      generation and incarnation, lifecycle fence, record available, assignment current) for exactly this consumer
//      (`clientId`) and field binding (fragment, field);
//   2. the token is signed with the attenuated methods (grant ∩ pinned methods ∩ record contracts; write-capable methods
//      only while live introspection is mounted, AMD-C8/C10);
//   3. the coupling is re-read and the severance log is re-checked from the mark. A severance that committed before
//      the confirm discards the token; one that commits after it finds the token already released, so its `exp`
//      (≤ release + 300 s) is inside `access_ends_by` = commit + 360 s. The federation shard brackets this with its own
//      grant/session checks before and after (service.mjs preferencesV2), so a grant revocation races the same way.
// There is no brokered refresh credential: a consumer re-reads preferences/v2, which mints again or reports the
// resource `unavailable` once severed.
//
// Severance (§7.2): X7 commits severance rows in the same transaction as the authority change (step 1). The drain
// turns them, in order, into X6 `credential-revoked` (until = row time + 360 s) and `resource-detached` rows in one
// account-store commit with its own cursor, then acknowledges the X7 rows (a crash between re-reads from the cursor,
// never twice). An X7 overflow row names no grants, so every current grant of that connection is revoked (X7-R4);
// grants removed inside the overflow rely on the 360 s bound. Owner-visible status lists `access_ends_by` per row.
//
// Introspection (§5.7, RFC 7662): an issuer-wide POST endpoint. The calling integration authenticates with an RFC 7523
// `private_key_jwt` assertion verified only against the keys pinned in the token's connection (looked up locally
// before any key fetch); the answer is `active: false` unless the token verifies with the brokering key set, is an
// app-consumer `invoke` token whose audience is that integration's pinned rpc_endpoint, and every live mint check
// still holds in the account and the federation shard. Nothing is cached (`Cache-Control: no-store`); any failure is
// `active: false`, so an integration that requires introspection for write methods fails closed.
import {Provider} from '../../vendor/ngin/index.js';
import {AppAction,AppQuery,createAppEngine,perform,read,operations} from '../app/engine.mjs';
import {AppFault} from '../app/faults.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../app/providers.mjs';
import {UUID} from '../core/primitives.mjs';
import {REVIEWED_CONTRACTS} from '../consent/reviewed-contracts.mjs';
import {brokeredResourcesProvider,readConnection,integrationsFlag,brokeringFlag} from './brokered.mjs';
import {peekAccessToken,BROKERING_JWKS_PATH,ACCESS_LIFETIMES} from './signing.mjs';
import {pinnedKeys} from './integrations.mjs';
import {enqueueIntegrationEvent,currentSeq} from '../runtime/integration-events.mjs';
import {PREFERENCES_V2} from './service.mjs';

export {PREFERENCES_V2};

export const BROKERED_RESOURCES_FEATURE='brokered-resources.v1',INTROSPECTION_PATH='/oauth/brokering/introspect';
export const CLIENT_ASSERTION_TYPE='urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** §7.2 step 3: 300 s token lifetime + 30 s verifier leeway + 30 s verifier clock error. */
export const ACCESS_ENDS_BY_MS=(ACCESS_LIFETIMES.invoke+30+30)*1000;
export const BROKERED_TOKEN_LIMITS=Object.freeze({drain:200,log:128,grantsPerEvent:64,assertionLifetime:60,assertionSkew:30,introspectPerMinute:600,unauthenticatedPerMinute:60000,replay:4096,body:8192});
const L=BROKERED_TOKEN_LIMITS,X8='integrations/x8/meta',REVOKED='integrations/x8/revoked/',CONNECTION='resource/';
const READ_EFFECTS=['read','pure'];
const fault=(code,message,status)=>{throw new AppFault(code,message,status);};
const notFound=()=>fault('not_found','Not found.',404);
const unavailable=()=>fault('resource_unavailable','This resource is not available right now.',409);
const invalid=()=>fault('invalid_request','Unsupported brokered token request.',400);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const only=(v,names)=>v===undefined?{}:plain(v)&&Object.keys(v).every(k=>names.includes(k))?v:invalid();
const https=(v,max=2048)=>{if(typeof v!=='string'||v.length>max||v.includes('#'))return false;try{const u=new URL(v);return u.href===v&&u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const FIELD=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/,METHOD=/^[A-Za-z][A-Za-z0-9_]{0,63}$/,JKT=/^[A-Za-z0-9_-]{43}$/,CONN=/^[A-Za-z0-9._~-]{1,128}$/;
const b64u=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};

// ---- Contract pins (AMD-C10): method effects decide write capability; unknown effects count as writes ----
/** Pins: {[contract]: {methods: {[name]: {effect, introspect?}}, brokerable?}}. The reviewed catalogue is the base;
 * `extra` (trusted composition data, never request input) adds or overrides contracts. */
export function contractPins(extra={}){
 const out={};for(const [contract,entry] of Object.entries(REVIEWED_CONTRACTS))out[contract]={methods:Object.fromEntries(Object.entries(entry.methods).map(([m,v])=>[m,{effect:v.effect}]))};
 const more=typeof extra==='string'?JSON.parse(extra):extra??{};if(!plain(more))throw new TypeError('Brokered contract pins must be an object.');
 for(const [contract,entry] of Object.entries(more)){
  if(!https(contract,512)||!plain(entry)||!plain(entry.methods)||entry.brokerable!==undefined&&typeof entry.brokerable!=='boolean'||Object.keys(entry.methods).length>64)throw new TypeError(`Invalid brokered contract pin ${contract}.`);
  const methods={};for(const [m,v] of Object.entries(entry.methods)){if(!METHOD.test(m)||!plain(v)||typeof v.effect!=='string'||v.introspect!==undefined&&typeof v.introspect!=='boolean')throw new TypeError(`Invalid brokered method pin ${contract}#${m}.`);methods[m]={effect:v.effect,...v.introspect?{introspect:true}:{}};}
  out[contract]={methods,...entry.brokerable===false?{brokerable:false}:{}};
 }
 return Object.freeze(out);
}
const brokerable=(pins,contract)=>Object.hasOwn(pins,contract)&&pins[contract].brokerable!==false;
/** A method needs live introspection (no cached authorization) unless its pinned effect is read or pure. */
export const writeCapable=(pins,contract,method)=>{const m=pins?.[contract]?.methods?.[method];return !m||m.introspect===true||!READ_EFFECTS.includes(m.effect);};
/** Exact attenuation: requested ∩ record contracts ∩ pinned brokerable methods; write-capable methods only with live
 * introspection mounted. Returns a sorted {contract: [methods]} with empty contracts dropped. */
export function attenuate(requested,contracts,pins,{introspection=false}={}){
 const out={};for(const contract of Object.keys(requested).sort()){if(!contracts.includes(contract)||!brokerable(pins,contract))continue;
  const list=[...new Set(requested[contract])].filter(m=>Object.hasOwn(pins[contract].methods,m)&&(introspection||!writeCapable(pins,contract,m))).sort();if(list.length)out[contract]=list;}
 return out;
}
const methodsInput=v=>{if(!plain(v)||!Object.keys(v).length||Object.keys(v).length>16)invalid();for(const [c,list] of Object.entries(v))if(!https(c,512)||!Array.isArray(list)||!list.length||list.length>64||list.some(m=>typeof m!=='string'||!METHOD.test(m)))invalid();return v;};
/** The federation resource id of a brokered record: an opaque provider reference that never contains the
 * integration's string (§4.3). Its `generation` is the record id, so detach + re-add needs consumer approval again. */
export const brokeredResourceId=(subject,record)=>`${subject}/resources/brokered/${record}`;

// ---- Provider ----
/** `store`: the account store (X7 records, X4 connections, X6 rows). `mint(claims)` -> {token, tokenType, expiresAt}:
 * mintAccessToken over the brokering key set for app consumers. `enqueue(tx, event, {now})` and `seq(tx, connection)`:
 * the X6 same-commit outbox and configuration `seq`. `introspection`: the endpoint is mounted (write methods mintable). */
export function brokeredTokensProvider({store,issuer,enabled=false,mint,pins=contractPins(),introspection=false,enqueue,seq,clock=()=>Date.now()}={}){
 return class extends BrokeredTokensProvider{static deps=[];constructor(){super();Object.assign(this,{store,issuer,enabled:enabled===true,mint,pins,introspection:introspection===true,enqueue,seq,clock});}};
}
export class BrokeredTokensProvider extends Provider{
 async obtain({actor}={}){
  if(!this.enabled||!this.store)notFound();
  if(!UUID.test(actor?.owner??'')||!['owner','system'].includes(actor?.kind))fault('unauthorized','Sign in to continue.',401);
  const bound=await this.store.get('owner');if(bound!==undefined&&bound!==actor.owner)fault('forbidden','Account owner mismatch.',403);
  return Object.freeze(scope(this,actor));
 }
 release(){}
}
async function x8meta(tx){const m=await tx.get(X8);return plain(m)&&m.v===1&&Number.isSafeInteger(m.cursor)?m:{v:1,cursor:0,log:[]};}
function scope(p,actor){
 const owner=actor.owner,subject=`${p.issuer}/entities/${owner}`,system=()=>{if(actor.kind!=='system')fault('forbidden','This operation is not available to this caller.',403);};
 const tx=fn=>p.store.transaction(fn);
 const connectionOf=id=>tx(t=>readConnection(t,owner,id));
 /** The record and this consumer's assignment for (fragment, field); app consumers only. */
 /** X8-R1: the latest revocation of assignment grant `grant`: drained ones remembered for access_ends_by, plus committed
  * rows not yet drained. X7 keeps a grant id across unavailable → reconfirm and narrowing, so a revoked id must neither
  * mint again inside its window (integrations reject it until `until`) nor revive a token issued before it. */
 const revokedAt=async(br,grant,connection)=>{const kept=await p.store.get(REVOKED+grant),rows=(await br.severance({after:(await tx(x8meta)).cursor,limit:500})).rows;
  return Math.max(Number.isSafeInteger(kept?.at)?kept.at:0,...rows.filter(r=>r.grants.includes(grant)||r.type==='overflow'&&r.connection===connection).map(r=>r.at));};
 const assignmentOf=async(br,record,match)=>{const {records}=await br.records();const r=records.find(x=>x.id===record);const a=r?.assignments.find(match);if(!r||!a)unavailable();return {record:r,assignment:a};};
 return {
  /** §5.3 consumer token for one app, record and field binding. `methods` are the federation grant's (already
   * intersected with the pinned descriptor); they are attenuated again here. */
  async mint(br,input){
   system();if(typeof p.mint!=='function')fault('brokering_unavailable','Brokered tokens are unavailable.',503);
   const v=only(input,['clientId','record','fragment','field','methods','jkt']);
   if(!https(v.clientId)||v.clientId===p.issuer||typeof v.record!=='string'||!UUID.test(v.record)||!https(v.fragment,256)||typeof v.field!=='string'||!FIELD.test(v.field)||v.jkt!==undefined&&(typeof v.jkt!=='string'||!JKT.test(v.jkt)))invalid();methodsInput(v.methods);
   const mark=(await br.severance({limit:1})).seq;
   const {record,assignment}=await assignmentOf(br,v.record,a=>a.consumer.clientId===v.clientId&&a.binding.fragment===v.fragment&&a.binding.field===v.field);
   let c;try{c=await br.mintable({record:record.id,grant:assignment.grant});}catch(e){if(e?.code==='not_found')unavailable();throw e;}
   if(c.clientId!==v.clientId||c.feature!==undefined)unavailable();
   const revoked=await revokedAt(br,c.grant,c.connection);if(revoked&&p.clock()<revoked+ACCESS_ENDS_BY_MS)unavailable();
   const methods=attenuate(v.methods,c.contracts,p.pins,{introspection:p.introspection});if(!Object.keys(methods).length)unavailable();
   // §5.4: a DPoP-bound consumer is always bound where the integration supports it; `required` without a key mints nothing.
   if(c.dpop==='required'&&!v.jkt)unavailable();const jkt=['supported','required'].includes(c.dpop)?v.jkt:undefined;
   const signedAt=p.clock(),minted=await p.mint({subject:c.subject,audience:c.audience,clientId:v.clientId,purpose:'invoke',connection:c.connection,generation:c.generation,resource:c.resource,grant:c.grant,methods,scope:null,...jkt?{jkt}:{}});
   if(typeof minted?.token!=='string'||!Number.isSafeInteger(minted.expiresAt)||minted.expiresAt>signedAt+ACCESS_LIFETIMES.invoke*1000+1000||!['Bearer','DPoP'].includes(minted.tokenType))fault('brokering_unavailable','Brokered tokens are unavailable.',503);
   // Confirm (§7.4): nothing that invalidates this token committed between the check and now.
   let again;try{again=await br.mintable({record:record.id,grant:assignment.grant});}catch{unavailable();}
   if(['subject','audience','connection','generation','resource','grant','dpop','clientId'].some(k=>again[k]!==c[k])||Object.keys(methods).some(k=>!again.contracts.includes(k)))unavailable();
   const after=await br.severance({after:mark,limit:500});
   if(after.seq!==mark&&(after.rows.length<after.seq-mark||after.rows.some(r=>r.connection===c.connection)))unavailable();
   return {token:minted.token,tokenType:minted.tokenType,expiresAt:minted.expiresAt,connection:c.connection,grant:c.grant,jti:typeof minted.jti==='string'?minted.jti:null,methods,endpoint:c.audience,origin:new URL(c.audience).origin,resource:c.resource};
  },
  /** Federation resource descriptors for the account's brokered records (for the federation resource sync). Contracts
   * carry the pinned brokerable methods that are mintable here (write-capable ones only with introspection mounted), so
   * consent, projection and snapshots never show more than a token carries; an unpinned contract is not offered. */
  async descriptors(br){
   system();const {records}=await br.records();const out=[];
   for(const r of records){if(r.state==='ended')continue;const c=await connectionOf(r.connection),endpoint=c?.manifest?.resources?.rpc_endpoint;if(!endpoint)continue;
    const contracts=Object.fromEntries(r.contracts.filter(k=>brokerable(p.pins,k)).map(k=>[k,Object.keys(p.pins[k].methods).filter(m=>p.introspection||!writeCapable(p.pins,k,m)).sort()]).filter(([,list])=>list.length));if(!Object.keys(contracts).length)continue;
    out.push({id:brokeredResourceId(subject,r.id),label:String(r.label??'').slice(0,100),provider:'brokered',contracts,generation:r.id,broker:{record:r.id,connection:r.connection,endpoint,origin:new URL(endpoint).origin,resource:r.resource,available:r.available===true}});}
   return out.sort((a,b)=>a.id<b.id?-1:1);
  },
  /** Live checks for introspection (account half). Inactive is `{active:false}`, never a fault. */
  async introspect(br,input){
   system();const v=only(input,['connection','generation','resource','grant','methods','clientId','audience','iat']);
   try{
    if(!Number.isSafeInteger(v.iat)||typeof v.connection!=='string'||!Number.isSafeInteger(v.generation)||typeof v.resource!=='string'||typeof v.grant!=='string'||!https(v.clientId)||v.clientId===p.issuer||typeof v.audience!=='string')return {active:false};methodsInput(v.methods);
    const c=await connectionOf(v.connection);if(!c?.serving||c.manifest.resources?.rpc_endpoint!==v.audience)return {active:false};
    const {records}=await br.records({connection:v.connection}),r=records.find(x=>x.resource===v.resource&&x.assignments.some(a=>a.grant===v.grant)),a=r?.assignments.find(x=>x.grant===v.grant);
    if(!r||a.consumer.clientId!==v.clientId||!a.binding.fragment)return {active:false};
    const revoked=await revokedAt(br,a.grant,v.connection);if(revoked&&v.iat*1000<=revoked+1000)return {active:false};
    const live=await br.mintable({record:r.id,grant:a.grant});
    if(live.generation!==v.generation||live.clientId!==v.clientId||live.audience!==v.audience||live.resource!==v.resource)return {active:false};
    if(Object.entries(v.methods).some(([k,list])=>!live.contracts.includes(k)||!brokerable(p.pins,k)||list.some(m=>!Object.hasOwn(p.pins[k].methods,m)||writeCapable(p.pins,k,m)&&!p.introspection)))return {active:false};
    return {active:true,record:r.id,resourceId:brokeredResourceId(subject,r.id),fragment:a.binding.fragment,field:a.binding.field};
   }catch{return {active:false};}
  },
  /** The introspection caller's pin, read locally before any key fetch: only an external confidential connection. */
  async integrationAuth(input){
   system();const v=only(input,['connection']);if(typeof v.connection!=='string'||!UUID.test(v.connection))return null;
   return tx(async t=>{const c=await readConnection(t,owner,v.connection),raw=await t.get(CONNECTION+v.connection),s=raw?.integration?.snapshot;
    if(!c||s?.authMethod!=='private_key_jwt'||s.clientId!==c.clientId||typeof s.jwksUri!=='string'||!Array.isArray(s.thumbprints)||!s.thumbprints.length)return null;
    return {clientId:c.clientId,jwksUri:s.jwksUri,thumbprints:[...s.thumbprints],serving:c.serving,tokenAuth:c.tokenAuth===true,endpoints:{rpc:c.manifest.resources?.rpc_endpoint??null,discovery:c.manifest.resources?.discovery_endpoint??null,events:c.manifest.events_endpoint??null}};});
  },
  /** §5.1: an integration reader's configuration `seq` (X6-S8); null for anything that is not an external connection. */
  async seq(input){system();const v=only(input,['connection']);if(typeof v.connection!=='string'||!CONN.test(v.connection)||typeof p.seq!=='function')return null;
   return tx(async t=>await readConnection(t,owner,v.connection)?p.seq(t,v.connection):null);},
  /** §7.2 step 2: committed X7 severance rows → X6 revocation rows, with the X8 cursor in the same commit. */
  async drain(br){
   system();if(typeof p.enqueue!=='function')return {drained:0,ready:false};
   const cursor=(await tx(x8meta)).cursor,{rows}=await br.severance({after:cursor,limit:L.drain});if(!rows.length)return {drained:0,cursor};
   const overflow=new Set(rows.filter(r=>r.type==='overflow').map(r=>r.connection)),current={};
   if(overflow.size)for(const r of (await br.records()).records)if(overflow.has(r.connection))(current[r.connection]??=[]).push(...r.assignments.map(a=>a.grant));
   const now=p.clock(),through=rows.at(-1).seq;
   const done=await tx(async t=>{const m=await x8meta(t);if(m.cursor!==cursor)return false;
    const revoked=new Map(),detached=[];
    for(const row of rows){const grants=row.type==='overflow'?current[row.connection]??[]:row.grants,until=Math.ceil((row.at+ACCESS_ENDS_BY_MS)/1000);
     if(grants.length){const g=revoked.get(row.connection)??{grants:new Set(),until:0};for(const x of grants)g.grants.add(x);g.until=Math.max(g.until,until);revoked.set(row.connection,g);}
     if(row.type==='detached'&&typeof row.resource==='string')detached.push({connection:row.connection,resource:row.resource});
     m.log.push({seq:row.seq,at:row.at,type:row.type,connection:row.connection,grants:grants.length,accessEndsBy:row.at+ACCESS_ENDS_BY_MS,drainedAt:now});}
    for(const [connection,{grants,until}] of revoked){const list=[...grants];for(let i=0;i<list.length;i+=L.grantsPerEvent)await p.enqueue(t,{type:'credential-revoked',connection,grants:list.slice(i,i+L.grantsPerEvent),until},{now});}
    for(const d of detached)await p.enqueue(t,{type:'resource-detached',connection:d.connection,resource:d.resource},{now});
    for(const [,{grants}] of revoked)for(const g of grants)await t.put(REVOKED+g,{at:now,until:now+ACCESS_ENDS_BY_MS});
    for(const [k,row] of await t.list({prefix:REVOKED,limit:4096}))if(!(row?.until>now))await t.delete(k);
    m.cursor=through;m.log=m.log.slice(-L.log);await t.put(X8,m);return true;});
   if(done)await br.severanceDone({through});return {drained:done?rows.length:0,cursor:done?through:cursor,more:rows.length===L.drain};
  },
  /** Owner-visible §7.3 report: `access_ends_by` per drained severance and how many committed rows await draining. */
  async status(br){system();const m=await tx(x8meta),{seq}=await br.severance({after:m.cursor,limit:1});return {cursor:m.cursor,pending:Math.max(0,seq-m.cursor),severances:m.log.map(e=>({...e}))};},
 };
}

// ---- Operations (system actors; the account slice checks the owner binding first) ----
const DEPS=['brokeredResources','brokeredTokens'];
/** `brokeredResources` is the X7 handle; its operations are reused through it (same store, same transactions). */
const bridge=br=>({records:input=>br.records(input),mintable:input=>br.mintable(input),severance:input=>br.severance(input??{}),severanceDone:input=>br.severanceDone(input)});
export class MintBrokeredToken extends AppAction{static operation='brokered.mint';static deps=DEPS;static gate='none';run({brokeredResources,brokeredTokens}){return brokeredTokens.mint(bridge(brokeredResources),this.input);}}
export class BrokeredDescriptors extends AppQuery{static operation='brokered.descriptors';static deps=DEPS;static gate='none';fetch({brokeredResources,brokeredTokens}){return brokeredTokens.descriptors(bridge(brokeredResources));}}
export class IntrospectBrokeredToken extends AppQuery{static operation='brokered.introspect';static deps=DEPS;static gate='none';fetch({brokeredResources,brokeredTokens}){return brokeredTokens.introspect(bridge(brokeredResources),this.input);}}
export class BrokeredIntegrationAuth extends AppQuery{static operation='brokered.integration-auth';static deps=['brokeredTokens'];static gate='none';fetch({brokeredTokens}){return brokeredTokens.integrationAuth(this.input);}}
export class BrokeredSeq extends AppQuery{static operation='brokered.seq';static deps=['brokeredTokens'];static gate='none';fetch({brokeredTokens}){return brokeredTokens.seq(this.input);}}
export class DrainBrokeredSeverance extends AppAction{static operation='brokered.drain';static deps=DEPS;static lifecycle='purging';run({brokeredResources,brokeredTokens}){return brokeredTokens.drain(bridge(brokeredResources));}}
export class BrokeredSeveranceStatus extends AppQuery{static operation='brokered.severance-status';static deps=DEPS;fetch({brokeredResources,brokeredTokens}){return brokeredTokens.status(bridge(brokeredResources));}}
export const BROKERED_TOKEN_OPERATIONS=operations(MintBrokeredToken,BrokeredDescriptors,IntrospectBrokeredToken,BrokeredIntegrationAuth,BrokeredSeq,DrainBrokeredSeverance,BrokeredSeveranceStatus);

// The X7 provider needs a discovery client to obtain; nothing here performs discovery, so every call refuses.
const NO_DISCOVERY=Object.freeze({forget(){},endpoint(){fault('discovery_unavailable','Discovery is not available here.',503);},discover(){fault('discovery_unavailable','Discovery is not available here.',503);},call(){fault('discovery_unavailable','Discovery is not available here.',503);}});
/** One engine over an account store with the X7 and X8 providers. Used by the account slice and the tests. */
export function brokeredTokensEngine({store,issuer,integrations=false,brokering=false,mint,pins,introspection=false,enqueue=enqueueIntegrationEvent,seq=currentSeq,slots,clock=systemClock,random=cryptoRandom,audit=nullAudit}){
 const enabled=integrations===true&&brokering===true;
 return createAppEngine({providers:{clock,random,audit,brokeredResources:brokeredResourcesProvider({store,discovery:NO_DISCOVERY,issuer,integrations,brokering,...slots?{slots}:{},clock:()=>clock.now()}),brokeredTokens:brokeredTokensProvider({store,issuer,enabled,mint,...pins?{pins}:{},introspection,enqueue,seq,clock:()=>clock.now()})}});
}
export const runBrokered=(engine,Operation,params)=>{const operation=new Operation(params);return operation instanceof AppQuery?read(engine,operation):perform(engine,operation);};

// ---- AccountController slice (registered in packages/runtime/account/index.mjs) ----
// Config ports: BROKERING_CONSUMER_MINT(claims) (app-consumer `invoke` minting over the brokering key set),
// BROKERED_CONTRACT_PINS (trusted pins beyond the reviewed catalogue), BROKERED_INTROSPECTION_MOUNTED (the endpoint
// below is mounted by the adapter). Without the mint port, minting answers brokering_unavailable.
const engines=new WeakMap();
function engineOf(c){let engine=engines.get(c);if(!engine){engine=brokeredTokensEngine({store:c.metadata,issuer:c.config.APP_ORIGIN,integrations:integrationsFlag(c.config),brokering:brokeringFlag(c.config),mint:typeof c.config.BROKERING_CONSUMER_MINT==='function'?c.config.BROKERING_CONSUMER_MINT:undefined,pins:contractPins(c.config.BROKERED_CONTRACT_PINS),introspection:c.config.BROKERED_INTROSPECTION_MOUNTED===true,...c.config.CONNECTION_SLOTS?{slots:c.config.CONNECTION_SLOTS}:{}});engines.set(c,engine);}return engine;}
async function bound(c,owner){if(!integrationsFlag(c.config)||!brokeringFlag(c.config)||typeof owner!=='string'||!UUID.test(owner)||await c.metadata.get('owner')!==owner)notFound();}
const system=(c,owner,Operation,input)=>runBrokered(engineOf(c),Operation,{actor:{kind:'system',owner},...input===undefined?{}:{input}});
export const account={
 methods:{
  /** Federation shard → account: {clientId, record, fragment, field, methods, jkt?}. */
  async brokeredFederationEvent(owner,{source,event}={}){await bound(this,owner);if(typeof source!=='string'||source.length>128)invalid();const out=await this.metadata.transaction(async tx=>{const now=Date.now(),key='integrations/x8/federation/'+source;if(await tx.get(key))return {duplicate:true};for(const [k,v]of await tx.list({prefix:'integrations/x8/federation/'}))if(v<=now)await tx.delete(k);if((await tx.list({prefix:'integrations/x8/federation/',limit:1025})).size>=1024)fault('rate_limited','Too many pending federation events.',429);await enqueueIntegrationEvent(tx,event,{now});if(event.type==='credential-revoked')for(const grant of event.grants)await tx.put(REVOKED+grant,{at:now});await tx.put(key,now+86400000);return {enqueued:true};});await this.integrationEventsKick(owner);return out;},
  async brokeredMint(owner,input){await bound(this,owner);return system(this,owner,MintBrokeredToken,input);},
  async brokeredSeq(owner,input){await bound(this,owner);return system(this,owner,BrokeredSeq,input);},
  /** Federation resource sync (runtime/federation.mjs resourceProvider): brokered records as descriptors. */
  async brokeredDescriptors(owner){if(!integrationsFlag(this.config)||!brokeringFlag(this.config)||await this.metadata.get('owner')!==owner)return [];return system(this,owner,BrokeredDescriptors);},
  async brokeredIntrospect(owner,input){await bound(this,owner);return system(this,owner,IntrospectBrokeredToken,input);},
  async brokeredIntegrationAuth(owner,input){await bound(this,owner);return system(this,owner,BrokeredIntegrationAuth,input);},
  /** Account alarm / after X7 owner writes: drain severance into X6 and wake its delivery. */
  async brokeredSeveranceDrain(owner){await bound(this,owner);const out=await system(this,owner,DrainBrokeredSeverance);if(out.drained&&typeof this.integrationEventsKick==='function')await this.integrationEventsKick(owner);return out;},
  async brokeredSeveranceStatus(owner){await bound(this,owner);return system(this,owner,BrokeredSeveranceStatus);},
 },
 // Called across objects by the federation shard and the issuer front, never while they hold this account's gate.
 rpc:{brokeredFederationEvent:{gate:'none'},brokeredMint:{gate:'none'},brokeredSeq:{gate:'none'},brokeredDescriptors:{gate:'none'},brokeredIntrospect:{gate:'none'},brokeredIntegrationAuth:{gate:'none'}},
};

// ---- X6 snapshot port (replaces integration-ports.mjs `pendingPreferencesSnapshot`) ----
/** `federationFor(owner)` -> an object with `integrationSnapshot(input)` (FederationService, over the federation
 * shard of that owner). The shard reads only its own store, never the account, so the X6 alarm cannot deadlock. */
export function preferencesSnapshotPort(federationFor){
 if(typeof federationFor!=='function')throw new TypeError('A federation shard resolver is required.');
 return Object.freeze(Object.assign(async input=>{if(!plain(input)||typeof input.owner!=='string'||!UUID.test(input.owner))fault('snapshot_unavailable','Preference snapshot unavailable.',503);const {owner,...rest}=input;return (await federationFor(owner)).integrationSnapshot(rest);},{available:true}));
}

// ---- Feature declaration (EXT-X2 registry row in packages/runtime/federation.mjs) ----
/** brokered-resources.v1 members (§12); `brokering_jwks_uri` moved here as `jwks_uri` (EXT-X5 follow-up). */
export const brokeredResourcesDeclaration=(issuer,{introspection=false}={})=>({features:{[BROKERED_RESOURCES_FEATURE]:{jwks_uri:`${issuer}${BROKERING_JWKS_PATH}`,preferences_contract:PREFERENCES_V2,...introspection?{introspection_endpoint:`${issuer}${INTROSPECTION_PATH}`}:{}}}});

// ---- RFC 7523 client assertion ----
const text=new TextEncoder();
const ALGS=Object.freeze({
 ES256:{kty:'EC',crv:'P-256',importer:{name:'ECDSA',namedCurve:'P-256'},verifier:{name:'ECDSA',hash:'SHA-256'},bytes:64},
 ES384:{kty:'EC',crv:'P-384',importer:{name:'ECDSA',namedCurve:'P-384'},verifier:{name:'ECDSA',hash:'SHA-384'},bytes:96},
 EdDSA:{kty:'OKP',crv:'Ed25519',importer:{name:'Ed25519'},verifier:{name:'Ed25519'},bytes:64},
 RS256:{kty:'RSA',importer:{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},verifier:{name:'RSASSA-PKCS1-v1_5'}},
 PS256:{kty:'RSA',importer:{name:'RSA-PSS',hash:'SHA-256'},verifier:{name:'RSA-PSS',saltLength:32}},
});
const assertionFault=reason=>{throw Object.assign(new AppFault('invalid_client','Client authentication failed.',401),{reason});};
const unb64u=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value)||value.length%4===1)assertionFault('encoding');const out=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));if(b64u(out)!==value)assertionFault('encoding');return out;};
const jsonPart=value=>{let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unb64u(value)));}catch(e){if(e.reason)throw e;assertionFault('encoding');}if(!plain(parsed))assertionFault('encoding');return parsed;};
/** Verifies a private_key_jwt assertion (RFC 7523 §3) against `keys` only (the connection's pinned public keys):
 * iss = sub = clientId, aud = the endpoint URL, exp − iat ≤ 60 s, a unique jti consumed through `replay(clientId, jti,
 * expiresAtMs)` (false when already seen). Returns the verifying key's thumbprint; throws invalid_client otherwise. */
export async function verifyClientAssertion(assertion,{clientId,audience,keys,now=Date.now(),replay,crypto=globalThis.crypto}){
 if(typeof assertion!=='string'||assertion.length>4096)assertionFault('malformed');const parts=assertion.split('.');if(parts.length!==3)assertionFault('malformed');
 const header=jsonPart(parts[0]),claims=jsonPart(parts[1]),alg=Object.hasOwn(ALGS,header.alg)?ALGS[header.alg]:null;
 if(!alg||Object.keys(header).some(k=>!['alg','kid','typ'].includes(k))||header.typ!==undefined&&!['JWT','jwt'].includes(header.typ)||header.kid!==undefined&&(typeof header.kid!=='string'||header.kid.length>128))assertionFault('header');
 const seconds=Math.floor(now/1000),aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];
 if(claims.iss!==clientId||claims.sub!==clientId||aud.length!==1||aud[0]!==audience)assertionFault('claims');
 if(!Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(claims.iat)||claims.exp<=claims.iat||claims.exp-claims.iat>L.assertionLifetime||claims.exp<=seconds||claims.iat>seconds+L.assertionSkew||claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>seconds+L.assertionSkew))assertionFault('time');
 if(typeof claims.jti!=='string'||!/^[\x21-\x7e]{16,128}$/.test(claims.jti))assertionFault('jti');
 const signature=unb64u(parts[2]);if(alg.bytes&&signature.length!==alg.bytes)assertionFault('signature');
 const candidates=(keys??[]).filter(k=>k?.kty===alg.kty&&(alg.crv===undefined||k.crv===alg.crv)&&(k.alg===undefined||k.alg===header.alg)&&(header.kid===undefined||k.kid===undefined||k.kid===header.kid));
 let verified=null;
 for(const k of candidates){try{const {thumbprint,kid,alg:ignored,...jwk}=k;const key=await crypto.subtle.importKey('jwk',{...jwk,ext:true},alg.importer,false,['verify']);if(await crypto.subtle.verify(alg.verifier,key,signature,text.encode(`${parts[0]}.${parts[1]}`))){verified={thumbprint:thumbprint??null};break;}}catch{/* next key */}}
 if(!verified)assertionFault('signature');
 if(typeof replay!=='function'||await replay(clientId,claims.jti,claims.exp*1000)!==true)assertionFault('replay');
 return {thumbprint:verified.thumbprint,jti:claims.jti};
}
/** Bounded in-memory jti cache per process (a fleet adapter may inject a durable one). */
export function memoryReplayCache({limit=L.replay,clock=()=>Date.now()}={}){
 const seen=new Map();
 return async(clientId,jti,until)=>{const now=clock();for(const [k,t] of seen){if(t>now)break;seen.delete(k);}const k=`${clientId}\n${jti}`;if(seen.has(k)&&seen.get(k)>now)return false;
  if(seen.size>=limit)return false;// Full: refuse rather than forget a live jti.
  seen.set(k,until);return true;};
}
/** Per-key sliding windows (per connection after authentication; one shared key before it). */
export function introspectionLimiter({perMinute=L.introspectPerMinute,unauthenticated=L.unauthenticatedPerMinute,clock=()=>Date.now(),keys=4096}={}){
 const windows=new Map();
 return {admit(key){const now=clock(),limit=key==='*'?unauthenticated:perMinute;let w=windows.get(key);if(!w||w.start+60000<=now){w={start:now,n:0};windows.delete(key);if(windows.size>=keys)windows.delete(windows.keys().next().value);windows.set(key,w);}if(w.n>=limit)return false;w.n++;return true;}};
}

// ---- Introspection endpoint (issuer origin, unmounted until an adapter routes INTROSPECTION_PATH here) ----
const HEADERS={'Cache-Control':'no-store',Pragma:'no-cache','Content-Type':'application/json','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const reply=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{...HEADERS,...extra}});
const SUBJECT=issuer=>new RegExp(`^${issuer.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/entities/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`);
async function boundedBody(request,max){const reader=request.body?.getReader();if(!reader)return '';const chunks=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();return null;}chunks.push(value);}const bytes=new Uint8Array(size);let o=0;for(const c of chunks){bytes.set(c,o);o+=c.length;}try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}}
/** RFC 7662 introspection for write-capable brokered contracts (§5.7, AMD-C8). Returns null for other paths.
 * Ports: `verifyToken(token, {audience, purposes, leeway})` (brokeringKeys.verify: published set + signed-while);
 * `account(owner)` -> {brokeredIntegrationAuth, brokeredIntrospect}; `federation(owner)` -> {brokeredGrantLive};
 * `clientKeys({clientId, jwksUri})` -> validated key set (ClientDirectory.resolveKeys); `replay`, `limiter`. */
export async function handleBrokeredIntrospection(request,{issuer,enabled=false,verifyToken,account,federation,clientKeys,replay,limiter,clock=()=>Date.now(),crypto=globalThis.crypto}={}){
 const url=new URL(request.url);if(url.pathname!==INTROSPECTION_PATH||enabled!==true)return null;
 if(url.origin!==issuer)return reply({error:'invalid_request'},403);
 if(request.method!=='POST')return reply({error:'method_not_allowed'},405,{Allow:'POST'});
 if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/x-www-form-urlencoded')return reply({error:'invalid_request'},400);
 const raw=await boundedBody(request,L.body);if(raw===null)return reply({error:'invalid_request'},400);
 const params=new URLSearchParams(raw),names=[...params.keys()];
 if(new Set(names).size!==names.length||names.some(k=>!['token','token_type_hint','client_assertion_type','client_assertion','client_id'].includes(k))||!params.get('token'))return reply({error:'invalid_request'},400);
 const unauthorized=()=>reply({error:'invalid_client'},401,{'WWW-Authenticate':'Bearer realm="brokering-introspection"'}),inactive=()=>reply({active:false});
 replay??=sharedReplay;limiter??=sharedLimiter;
 if(!limiter.admit('*'))return reply({error:'rate_limited'},429,{'Retry-After':'60'});
 if(params.get('client_assertion_type')!==CLIENT_ASSERTION_TYPE||!params.get('client_assertion'))return unauthorized();
 // §5.5 step 1 analogue: the token names the connection; it is looked up locally before any key is fetched.
 let peek;try{peek=peekAccessToken(params.get('token'));}catch{return unauthorized();}
 const owner=typeof peek.claims.sub==='string'&&peek.claims.iss===issuer?SUBJECT(issuer).exec(peek.claims.sub)?.[1]:null,connection=peek.connection;
 if(!owner||typeof connection!=='string'||!UUID.test(connection))return unauthorized();
 let auth;try{auth=await account(owner).brokeredIntegrationAuth({connection});}catch{auth=null;}
 if(!auth||params.has('client_id')&&params.get('client_id')!==auth.clientId)return unauthorized();
 let keys;try{keys=pinnedKeys(await clientKeys({clientId:auth.clientId,jwksUri:auth.jwksUri}),auth.thumbprints);}catch{keys=[];}if(!keys.length)return unauthorized();
 try{await verifyClientAssertion(params.get('client_assertion'),{clientId:auth.clientId,audience:`${issuer}${INTROSPECTION_PATH}`,keys,now:clock(),replay,crypto});}catch{return unauthorized();}
 // X8-R4/W5-S5: the per-connection window is charged only after the integration authenticated, so forged tokens naming
 // a real connection cannot spend its budget and fail its writes closed. Unauthenticated work before this point is bounded
 // by the adapter's per-IP/subnet introspection class (packages/runtime/routes/federation.mjs) and the `*` ceiling.
 if(!limiter.admit(`c:${connection}`))return reply({error:'rate_limited'},429,{'Retry-After':'60'});
 // Authenticated as the integration of this connection. Active only when every check below holds (§5.7).
 try{
  if(!auth.serving||!auth.endpoints.rpc||peek.claims.aud!==auth.endpoints.rpc)return inactive();
  // Standard leeway for the signed-while key window (a key activated within the token's iat second); expiry is strict.
  const {claims}=await verifyToken(params.get('token'),{audience:auth.endpoints.rpc,purposes:['invoke']});
  const b=claims.bindle;if(claims.exp*1000<=clock()||b.connection!==connection||claims.client_id===issuer||b.feature!==undefined||b.scope!==null)return inactive();
  const live=await account(owner).brokeredIntrospect({connection,iat:claims.iat,generation:b.generation,resource:b.resource,grant:b.grant,methods:b.methods,clientId:claims.client_id,audience:claims.aud});
  if(live?.active!==true)return inactive();
  if(await federation(owner).brokeredGrantLive({clientId:claims.client_id,resourceId:live.resourceId,fragment:live.fragment,field:live.field,methods:b.methods,jti:claims.jti,iat:claims.iat})!==true)return inactive();
  return reply({active:true,iss:claims.iss,sub:claims.sub,aud:claims.aud,client_id:claims.client_id,iat:claims.iat,exp:claims.exp,jti:claims.jti,token_type:claims.cnf?'DPoP':'Bearer',bindle:{v:1,purpose:b.purpose,connection:b.connection,generation:b.generation,resource:b.resource,grant:b.grant,methods:b.methods,scope:b.scope},...claims.cnf?{cnf:{jkt:claims.cnf.jkt}}:{}});
 }catch{return inactive();}
}
const sharedReplay=memoryReplayCache(),sharedLimiter=introspectionLimiter();
