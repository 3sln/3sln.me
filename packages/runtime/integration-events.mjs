// EXT-X6, the integration event outbox and its delivery (docs/spec/integrations.md §6, §7.2–7.3, §10, §11;
// docs/architecture/extensibility-design.md EX-7/EX-8, §10 X6). Engine-first: the `integrationEvents` provider is an
// actor-scoped handle over the account store; the Actions/Queries below are the operations, and the account slice at
// the bottom (installed through packages/runtime/account/index.mjs) composes them for the alarm. Everything refuses with
// `not_found` unless INTEGRATIONS_ENABLED is on, and nothing is ingested or sent until a signer (the brokering `event`
// key, packages/federation/signing.mjs) and an SSRF-safe egress port are configured.
//
// Rows. The X4 connections outbox (packages/apps/connections.mjs) is drained into per-connection rows here, in one
// transaction with an ingest cursor, and acknowledged afterwards (a lost ack re-reads from the cursor, never twice):
// `connection-revoked` (generation_floor = the post-bump generation) and `connection-resumed` map to SETs; the other X4
// events carry nothing an integration may see. Other writers append in their own commit with enqueueIntegrationEvent(tx)
// (credential-revoked, resource-detached, preferences-updated markers), or across single writers with the idempotent
// system Actions. Coalescing: one marker per (connection, fragment) and per detached resource, a newer marker replacing
// an undelivered or in-flight older one; a connection-revoked supersedes pending ones it covers (floors only rise) and
// pending resumes below its floor; a resume supersedes older resumes.
//
// Delivery (RFC 8417 SETs pushed per RFC 8935). Per connection, revocations go first, then resumes, then the rest; across
// connections every due revocation goes before any other row. Each attempt is leased (attempt id, next time) in its own
// commit before anything is signed, then signed afresh (new iat, same jti) and POSTed to the pinned events_endpoint; the
// outcome is settled in a second commit that only applies to the same lease. `seq` is assigned when a row is first sent
// and increases strictly per connection id across generations; a preferences snapshot is rebuilt at every attempt, and a
// changed snapshot (or generation) gets a fresh jti and seq, so a receiver that already processed the old jti never
// drops newer state (at-least-once; receivers dedupe by jti and order by seq). 202 acknowledges; 400 is a permanent
// rejection; anything else is retried with exponential backoff (≤ 10 s first, ≤ 1 h apart) for 72 h, after which a
// non-revocation row is dropped and the connection becomes `degraded` (X4 health), and a revocation is recorded as
// unacknowledged (§7.3). A later acknowledgment clears the degradation this module caused.
//
// Host composition installs: the AccountController alarm calling `integrationEventsAlarm(owner)`, X4 commits
// calling `integrationEventsKick(owner)`, and the Worker/Node composition of INTEGRATION_EVENT_PORTS (signer over the
// brokering store, the egress adapters below, X8's preferences snapshot port).
import {Provider} from '../../vendor/ngin/index.js';
import {AppAction,AppQuery,createAppEngine,operations,perform,read} from '../app/engine.mjs';
import {AppFault} from '../app/faults.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../app/providers.mjs';
import {integrationsEnabled} from '../app/domains/connections.mjs';
import {PREFERENCES_UPDATED_EVENT,prefixedURL} from '../federation/integrations.mjs';
import {publicAddress} from '../apps/form-fetch-policy.mjs';
// ==== EV-3 doorbell hunk (imports) ====
import {BUS_ADVANCED_EVENT,doorbellTarget,markDoorbellSent,eventDoorbellsProvider,RingEventDoorbells,CancelEventDoorbells,SetEventBusPush,EventBusSubscriptions,EVENT_DOORBELL_APP_OPERATIONS} from '../events/doorbell.mjs';
import {eventBusesEnabled} from '../events/limits.mjs';
import {busKeys} from '../events/cursor.mjs';
// ==== end EV-3 doorbell hunk ====

const EVENT=name=>`https://spec.bindle.example/events/${name}/v1`;
export const INTEGRATION_EVENT_TYPES=Object.freeze({'preferences-updated':PREFERENCES_UPDATED_EVENT,...Object.fromEntries(['credential-revoked','connection-revoked','connection-resumed','resource-detached'].map(name=>[name,EVENT(name)])),'bus-advanced':BUS_ADVANCED_EVENT/* EV-3 */});
export const SET_TYP='secevent+jwt',SET_MEDIA_TYPE='application/secevent+jwt';
const REVOCATION=new Set(['connection-revoked','credential-revoked']),CONTROL=new Set([...REVOCATION,'connection-resumed']),LIVE=['configuring','active','degraded'];
const PRIORITY=Object.freeze({'connection-revoked':0,'credential-revoked':0,'connection-resumed':1,'preferences-updated':2,'resource-detached':2,'bus-advanced':3/* EV-3: lowest */});
const FIELDS=Object.freeze({'preferences-updated':['fragment'],'credential-revoked':['grants','until'],'connection-revoked':['floor','terminal'],'connection-resumed':['generation'],'resource-detached':['resource'],'bus-advanced':['bus','resource']/* EV-3 */});
/** Spec bounds (§6.4, §11.6, §11.10). `window` ≥ 72 h; `firstRetry` ≤ 10 s; `maxRetry` ≤ 1 h; events responses ≤ 4 KiB. */
export const INTEGRATION_EVENT_LIMITS=Object.freeze({rows:512,perConnection:64,window:72*3600000,firstRetry:10000,maxRetry:3600000,timeoutMs:5000,responseBytes:4096,setBytes:32768,sends:8,perConnectionSends:2,deadlineMs:20000,ingest:200,log:128,unacked:64,doorbellRows:64,doorbellsPerConnection:32/* EV-3: a separate doorbell row budget */});
const L=INTEGRATION_EVENT_LIMITS;
const ROW='integration-events/row/',CONN='integration-events/conn/',META='integration-events/meta',LOG='integration-events/log/',UNACKED='integration-events/unacked/';
const pad=n=>String(n).padStart(16,'0'),fault=(code,message,status=400)=>{throw new AppFault(code,message,status);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const UUID=/^[a-f0-9-]{36}$/,CONNECTION=/^[A-Za-z0-9._~-]{1,128}$/,GRANT=/^[A-Za-z0-9._~-]{1,128}$/,CODE=/^[a-z0-9_]{1,64}$/;
const httpsId=(v,max=256)=>{if(typeof v!=='string'||v.length>max||/[\u0000- \u007f]/.test(v))return false;try{const u=new URL(v);return u.protocol==='https:'&&u.href===v&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}};
const b64u=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
const utf8=new TextEncoder(),size=v=>utf8.encode(JSON.stringify(v)).length;
const token16=random=>b64u(random.bytes(16));

// ---- Outbox rows (pure transaction functions over tx.get/put/delete/list) ----
function eventInput(e){
 if(!plain(e)||!Object.hasOwn(FIELDS,e.type)||typeof e.connection!=='string'||!CONNECTION.test(e.connection)||Object.keys(e).some(k=>!['type','connection',...FIELDS[e.type]].includes(k)))fault('invalid_request','Unsupported integration event.');
 const out={type:e.type,connection:e.connection},ok=(test)=>{if(!test)fault('invalid_request','Unsupported integration event.');};
 if(e.type==='preferences-updated'){ok(httpsId(e.fragment));out.fragment=e.fragment;}
 else if(e.type==='resource-detached'){ok(httpsId(e.resource,512));out.resource=e.resource;}
 else if(e.type==='connection-revoked'){ok(Number.isSafeInteger(e.floor)&&e.floor>=1&&typeof e.terminal==='boolean');Object.assign(out,{floor:e.floor,terminal:e.terminal});}
 else if(e.type==='connection-resumed'){ok(Number.isSafeInteger(e.generation)&&e.generation>=1);out.generation=e.generation;}
 else if(e.type==='bus-advanced'){ok(typeof e.bus==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e.bus)&&httpsId(e.resource,512));Object.assign(out,{bus:e.bus,resource:e.resource});}/* EV-3 */
 else{ok(Array.isArray(e.grants)&&e.grants.length>0&&e.grants.length<=64&&new Set(e.grants).size===e.grants.length&&e.grants.every(g=>typeof g==='string'&&GRANT.test(g))&&Number.isSafeInteger(e.until)&&e.until>0);Object.assign(out,{grants:[...e.grants],until:e.until});}
 return out;
}
async function meta(tx){const m=await tx.get(META);return m?.v===1?{bells:0,...m}:{v:1,cursor:0,order:0,rows:0,log:0,unacked:0,bells:0};}
async function conn(tx,id){const k=await tx.get(CONN+id);return k?.v===1?k:{v:1,seq:0,generation:0};}
async function remove(tx,m,key){await tx.delete(key);if(bell(key))m.bells=Math.max(0,m.bells-1);/* EV-3 */else m.rows=Math.max(0,m.rows-1);}
async function log(tx,m,entry,limits){m.log++;await tx.put(LOG+pad(m.log),entry);if(m.log>limits.log)await tx.delete(LOG+pad(m.log-limits.log));}
async function unacked(tx,m,entry,limits){m.unacked++;await tx.put(UNACKED+pad(m.unacked),entry);if(m.unacked>limits.unacked)await tx.delete(UNACKED+pad(m.unacked-limits.unacked));}
// Appends (or coalesces) one validated event, mutating `m`; the caller writes META. Fails visibly when bounds are full.
async function put(tx,m,e,now,limits){
 // EV-3: doorbells take their own budget and never count against (or get evicted by) the rows below.
 if(e.type==='bus-advanced')return putDoorbell(tx,m,e,now,limits);
 const prefix=ROW+e.connection+'/',rows=[...(await tx.list({prefix,limit:limits.perConnection+limits.doorbellsPerConnection+1/* EV-3 */})).entries()].filter(([k])=>!bell(k)),drop=new Set();let key,carry;
 const supersede=k=>{const old=rows.find(([x])=>x===k)?.[1];if(old){drop.add(k);carry=old.firstAttemptAt;}};
 if(e.type==='preferences-updated'){key=prefix+'p:'+encodeURIComponent(e.fragment);supersede(key);}
 else if(e.type==='resource-detached'){key=prefix+'d:'+encodeURIComponent(e.resource);supersede(key);}
 else if(e.type==='connection-resumed'){
  if(rows.some(([,r])=>r.type==='connection-resumed'&&r.generation>=e.generation||r.type==='connection-revoked'&&r.floor>e.generation))return {coalesced:true};
  for(const [k,r] of rows)if(r.type==='connection-resumed')drop.add(k);key=prefix+'s';
 }else if(e.type==='connection-revoked'){
  // Floors only rise: a pending revoke at or above this floor that is at least as terminal already says everything.
  if(rows.some(([,r])=>r.type==='connection-revoked'&&r.floor>=e.floor&&(r.terminal||!e.terminal)))return {coalesced:true};
  for(const [k,r] of rows)if(r.type==='connection-revoked'&&r.floor<=e.floor&&(e.terminal||!r.terminal)||r.type==='connection-resumed'&&r.generation<e.floor)drop.add(k);
  key=prefix+'r:'+pad(m.order+1);
 }else key=prefix+'c:'+pad(m.order+1);
 // X6-S1: a revocation is never refused inside a severance commit. Over the caps it evicts this connection's
 // non-control rows (an integration that misses them reads @preferences); only the hard ceiling (twice the caps,
 // reachable by revocations alone) fails, and visibly.
 if(REVOCATION.has(e.type)){const over=Math.max(rows.length-drop.size+1-limits.perConnection,m.rows-drop.size+1-limits.rows);if(over>0)for(const [k,r] of rows.filter(([k,r])=>!drop.has(k)&&!CONTROL.has(r.type)).slice(0,over))drop.add(k);}
 const ceiling=REVOCATION.has(e.type)?2:1;
 if(rows.length-drop.size+1>limits.perConnection*ceiling||m.rows-drop.size+1>limits.rows*ceiling)fault('integration_events_full','Too many integration events are pending.',503);
 for(const k of drop)await remove(tx,m,k);
 m.order++;m.rows++;
 await tx.put(key,{...e,key,order:m.order,priority:PRIORITY[e.type],createdAt:now,nextAt:now,attempts:0,...carry===undefined?{}:{firstAttemptAt:carry}});
 return {coalesced:drop.size>0};
}
// ==== EV-3 doorbell hunk (rows): docs/spec/events.md §7.2, packages/events/doorbell.mjs ====
// At most one pending `bus-advanced` row per (connection, bus), keyed `b:<bus>`; an existing row is kept (its payload
// is rebuilt at send time). Rows count in `m.bells` against doorbellRows/doorbellsPerConnection only, so a full
// doorbell budget refuses only the doorbell (the ring coalesces it) and never an owner write or a revocation.
const bell=key=>key.slice(ROW.length).split('/')[1]?.startsWith('b:')===true;
async function putDoorbell(tx,m,e,now,limits){
 const prefix=ROW+e.connection+'/',key=prefix+'b:'+e.bus;if(await tx.get(key))return {coalesced:true};
 if((await tx.list({prefix:prefix+'b:',limit:limits.doorbellsPerConnection+1})).size>=limits.doorbellsPerConnection||m.bells>=limits.doorbellRows)fault('integration_events_full','Too many integration events are pending.',503);
 m.order++;m.bells++;await tx.put(key,{...e,key,order:m.order,priority:PRIORITY[e.type],createdAt:now,nextAt:now,attempts:0});return {coalesced:false};
}
/** Same-commit cancellation of one pending doorbell (unsubscribe, revocation, owner pause). */
export async function cancelIntegrationDoorbell(tx,{connection,bus}){
 if(typeof connection!=='string'||!CONNECTION.test(connection)||typeof bus!=='string')return false;
 const key=ROW+connection+'/b:'+bus;if(!await tx.get(key))return false;const m=await meta(tx);await remove(tx,m,key);await tx.put(META,m);return true;
}
// ==== end EV-3 doorbell hunk ====
/** Same-commit enqueue for other writers of this account store (X7 credential-revoked/resource-detached, X8 markers):
 * call inside the transaction that changes the authority or configuration (transactional outbox, §6.3, §7.2). */
export async function enqueueIntegrationEvent(tx,event,{now=Date.now(),limits=L}={}){const e=eventInput(event),m=await meta(tx),out=await put(tx,m,e,now,limits);await tx.put(META,m);return out;}
/** X6-S8: the connection's current configuration `seq`, for X8's preferences/v2 reads (§5.1, §6.2), read in the same
 * account-store transaction as the projection. X6 is the sole consumer of the X4 outbox and acknowledges what it ingests. */
export async function currentSeq(tx,connection){return (await conn(tx,connection)).seq;}
const fromConnectionEvent=e=>!plain(e)||typeof e.connection!=='string'||!CONNECTION.test(e.connection)||!Number.isSafeInteger(e.generation)||e.generation<1?null:e.type==='connection-revoked'?{type:'connection-revoked',connection:e.connection,floor:e.generation,terminal:e.terminal===true}:e.type==='connection-resumed'?{type:'connection-resumed',connection:e.connection,generation:e.generation}:null;

// ---- Endpoint policy and egress (§11.1, §11.6; protocol §2 SSRF rules) ----
const publicHostname=host=>host.length<=253&&host.includes('.')&&host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))&&!/^\d+(?:\.\d+)*$/.test(host)&&!/(?:^|\.)(?:localhost|local|internal|invalid|test|onion|arpa|home)$/.test(host);
/** A deliverable events endpoint: canonical HTTPS on 443, a public DNS name (no IP literal, no special-use name), no
 * userinfo, query or fragment, and never the issuer's own host. Returns a URL or null. */
export function eventEndpointURL(value,{issuer}={}){
 if(typeof value!=='string'||value.length>2048)return null;let u;try{u=new URL(value);}catch{return null;}
 if(u.href!==value||u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||value.includes('#')||value.includes('?')||!publicHostname(u.hostname))return null;
 if(issuer!==undefined){let own;try{own=new URL(issuer).hostname;}catch{return null;}if(own===u.hostname||u.hostname.endsWith('.'+own))return null;}
 return u;
}
// The pinned snapshot is the only source of the URL: on the client_id origin and path prefix (X3), external, not built-in.
function endpointOf(c,issuer){
 const url=c?.integration?.kind==='external'?c.integration.snapshot?.manifest?.events_endpoint:undefined;
 return typeof url==='string'&&prefixedURL(url,c.clientId)===url&&eventEndpointURL(url,{issuer})?url:null;
}
const subscribed=c=>c.integration?.snapshot?.manifest?.events??[PREFERENCES_UPDATED_EVENT];
const egressError=()=>Object.assign(new Error('The events endpoint could not be reached safely.'),{code:'event_transport_unavailable'});
function egressLimits({timeoutMs=L.timeoutMs,maxConcurrent=4}={}){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>16)throw new TypeError('Event egress needs timeoutMs ≤ 10 s and maxConcurrent ≤ 16.');return {timeoutMs,maxConcurrent};}
function egressInput({url,body,timeoutMs}={},issuer,limit){const u=eventEndpointURL(url,{issuer});if(!u||typeof body!=='string'||!body.length||body.length>4*L.setBytes||!/^[A-Za-z0-9_.-]+$/.test(body))throw egressError();return {u,body:utf8.encode(body),timeout:Math.min(Number.isSafeInteger(timeoutMs)&&timeoutMs>0?timeoutMs:limit,limit)};}
const REQUEST_HEADERS=Object.freeze({'Content-Type':SET_MEDIA_TYPE,Accept:'application/json','Accept-Encoding':'identity'});
/** Node egress: DNS-pinned, globally routable IPv4 only (the reviewed form-postback policy), original-hostname TLS
 * verification, port 443, POST, no redirects (3xx is returned and treated as a failure), identity encoding, a 4 KiB
 * body bound and one deadline. `lookup` (node:dns/promises) and `request` (node:https) are injected so this module
 * stays importable by the Worker bundle. */
export function createNodeEventEgress({lookup,request,issuer,...limits}={}){
 if(typeof lookup!=='function'||typeof request!=='function')throw new TypeError('Node event egress needs injected lookup and request.');
 const {timeoutMs,maxConcurrent}=egressLimits(limits);let active=0;
 return {async send(input){const {u,body,timeout}=egressInput(input,issuer,timeoutMs);if(active>=maxConcurrent)throw egressError();active++;
  try{return await new Promise((resolve,reject)=>{
   let req,res,done=false;const timer=setTimeout(()=>finish(egressError()),timeout);
   function finish(error,value){if(done)return;done=true;clearTimeout(timer);if(error){res?.destroy();req?.destroy();reject(egressError());}else resolve(value);}
   Promise.resolve().then(()=>lookup(u.hostname,{all:true,family:4,verbatim:true})).then(records=>{
    if(done)return;if(!Array.isArray(records)||!records.length||records.length>64||records.some(r=>r?.family!==4||typeof r.address!=='string'||r.address.includes(':')||!publicAddress(r.address)))throw egressError();const selected=records[0].address;
    const pinned=(_host,opts,cb)=>{if(typeof opts==='function'){cb=opts;opts={};}if(opts?.all)cb(null,[{address:selected,family:4}]);else cb(null,selected,4);};
    req=request({protocol:'https:',hostname:u.hostname,port:443,path:u.pathname,method:'POST',servername:u.hostname,lookup:pinned,agent:false,rejectUnauthorized:true,maxHeaderSize:8192,headers:{...REQUEST_HEADERS,Host:u.host,'Content-Length':String(body.length)}},incoming=>{
     res=incoming;if(done){res.destroy();return;}try{
      const status=res.statusCode;if(!Number.isInteger(status)||status<200||status>599)throw egressError();
      if(status>=300&&status<400){finish(null,{status,bytes:new Uint8Array()});res.destroy();return;}
      const length=res.headers['content-length'],encoding=res.headers['content-encoding'];if(encoding&&encoding.toLowerCase()!=='identity'||length!==undefined&&(!/^\d+$/.test(length)||Number(length)>L.responseBytes))throw egressError();
      const chunks=[];let total=0;res.on('data',chunk=>{if(done)return;total+=chunk.length;if(total>L.responseBytes){finish(egressError());return;}chunks.push(new Uint8Array(chunk));});res.once('error',()=>finish(egressError()));res.once('aborted',()=>finish(egressError()));
      res.once('end',()=>{const out=new Uint8Array(total);let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}finish(null,{status,bytes:out});});
     }catch{finish(egressError());}
    });req.once('error',()=>finish(egressError()));req.end(body);
   }).catch(()=>finish(egressError()));
  });}finally{active--;}
 }};
}
/** Workers egress: requires `global_fetch_strictly_public` (publicRouting) and screens A/AAAA over DoH, refusing any
 * non-public answer. DoH screening is NOT connection pinning (DNS can change before the native fetch), so the
 * strictly-public routing flag is the actual guard, the residual risk recorded for client-id-metadata.v1. No
 * credentials, no redirects (returned and treated as a failure), identity encoding, a 4 KiB body bound, one deadline.
 * Only the global public fetch is injected; never a VPC or service-binding fetch. */
export function createWorkerEventEgress({publicRouting=false,fetcher=globalThis.fetch,issuer,...limits}={}){
 if(publicRouting!==true)throw new TypeError('Event egress requires global_fetch_strictly_public.');
 const {timeoutMs,maxConcurrent}=egressLimits(limits);let active=0;
 async function bounded(response,max){const reader=response.body?.getReader();if(!reader)return new Uint8Array();const chunks=[];let total=0;try{for(;;){const r=await reader.read();if(r.done)break;total+=r.value.byteLength;if(total>max)throw egressError();chunks.push(r.value);}}catch(e){reader.cancel().catch(()=>{});throw e;}const out=new Uint8Array(total);let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}return out;}
 async function dns(host,type,signal){
  const endpoint=new URL('https://cloudflare-dns.com/dns-query');endpoint.searchParams.set('name',host);endpoint.searchParams.set('type',String(type));
  const response=await fetcher(endpoint.href,{method:'GET',headers:{Accept:'application/dns-json'},credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal});
  if(response.status!==200||!(response.headers.get('Content-Type')||'').toLowerCase().includes('application/dns-json')){await response.body?.cancel();throw egressError();}
  let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(response,16384)));}catch{throw egressError();}
  if(result?.Status!==0||result.TC===true||!Array.isArray(result.Question)||result.Question.length!==1||result.Question[0].name?.replace(/\.$/,'').toLowerCase()!==host||result.Question[0].type!==type||result.Answer!==undefined&&!Array.isArray(result.Answer))throw egressError();
  const answers=result.Answer??[];if(answers.length>64||answers.some(r=>![5,type].includes(r?.type)))throw egressError();
  const addresses=answers.filter(r=>r.type===type).map(r=>r.data);if(addresses.some(a=>!publicAddress(a)||type===1&&a.includes(':')||type===28&&!a.includes(':')))throw egressError();return addresses;
 }
 return {async send(input){const {u,body,timeout}=egressInput(input,issuer,timeoutMs);if(active>=maxConcurrent)throw egressError();active++;
  const controller=new AbortController();let timer;
  const run=async()=>{
   const a=await dns(u.hostname,1,controller.signal),aaaa=await dns(u.hostname,28,controller.signal);if(!a.length&&!aaaa.length)throw egressError();
   const response=await fetcher(u.href,{method:'POST',headers:REQUEST_HEADERS,body,credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
   const status=response.status;if(!Number.isInteger(status)||status<200||status>599){await response.body?.cancel();throw egressError();}
   if(status>=300&&status<400){await response.body?.cancel();return {status,bytes:new Uint8Array()};}
   const length=response.headers.get('Content-Length'),encoding=response.headers.get('Content-Encoding');if(encoding&&encoding.toLowerCase()!=='identity'||length!==null&&(!/^\d+$/.test(length)||Number(length)>L.responseBytes)){await response.body?.cancel();throw egressError();}
   return {status,bytes:await bounded(response,L.responseBytes)};
  };
  try{return await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(egressError());},timeout);})]);}
  catch{controller.abort();throw egressError();}finally{clearTimeout(timer);active--;}
 }};
}

// ---- SET verification (the §6.1 checklist; used by the conformance fixture and available to integrations) ----
const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,HALF=N>>1n;
const big=bytes=>BigInt('0x'+(Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')||'0'));
const invalid=reason=>{throw Object.assign(new AppFault('invalid_token','The security event token is invalid.',401),{reason});};
const unb64u=(value,reason)=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value)||value.length%4===1)invalid(reason);let raw;try{raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));}catch{invalid(reason);}const out=Uint8Array.from(raw,c=>c.charCodeAt(0));if(b64u(out)!==value)invalid(reason);return out;};
const segment=(value,reason)=>{let raw,parsed;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(unb64u(value,reason));parsed=JSON.parse(raw);}catch(e){if(e.code)throw e;invalid(reason);}if(!plain(parsed)||JSON.stringify(parsed)!==raw)invalid(reason);return parsed;};
/** Verifies a provider SET in the §6.1 order: `typ`/`alg`, then `connection({iss, connection})` (reject an unknown
 * connection before any key is consulted), then the signature under `keys` (a JWKS object, or `async kid => jwks` with
 * the caller's cache rules), then `aud`, `sub` and the `iat` window (10 min back, 30 s ahead). Duplicate
 * `jti` handling and `seq` comparison are the receiver's. Throws `invalid_token` with a `reason`. */
export async function verifySecurityEventToken(token,{keys,issuer,audience,connection,subject,now=Date.now(),crypto=globalThis.crypto}={}){
 // X6-S4: the §6.1 step-2 lookup and step-5 subject are mandatory, never skipped by omission.
 if(typeof connection!=='function'||typeof subject!=='string'||typeof issuer!=='string'||typeof audience!=='string')throw new TypeError('SET verification needs issuer, audience, subject and a connection lookup.');
 if(typeof token!=='string'||token.length>4*L.setBytes)invalid('malformed');const parts=token.split('.');if(parts.length!==3)invalid('malformed');
 const header=segment(parts[0],'header'),claims=segment(parts[1],'claims');
 if(Object.keys(header).length!==3||header.typ!==SET_TYP)invalid('typ');if(header.alg!=='ES256')invalid('alg');if(typeof header.kid!=='string'||!/^event\.[A-Za-z0-9_-]{22}$/.test(header.kid))invalid('kid');
 const events=plain(claims.events)?Object.entries(claims.events):[];if(events.length!==1||!plain(events[0][1]))invalid('events');
 if(claims.iss!==issuer)invalid('iss');
 if(typeof events[0][1].connection!=='string')invalid('events');
 if(!await connection({iss:claims.iss,connection:events[0][1].connection}))invalid('connection');
 const set=typeof keys==='function'?await keys(header.kid):keys;if(!plain(set)||!Array.isArray(set.keys)||set.keys.length>64)invalid('jwks');
 const matches=set.keys.filter(k=>k?.kid===header.kid);if(matches.length!==1)invalid('kid');const jwk=matches[0];
 if(jwk.kty!=='EC'||jwk.crv!=='P-256'||jwk.alg!==undefined&&jwk.alg!=='ES256'||jwk.d!==undefined||![jwk.x,jwk.y].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)))invalid('jwks');
 const signature=unb64u(parts[2],'signature');if(signature.length!==64||big(signature.slice(32))>HALF)invalid('signature');
 let key;try{key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}catch{invalid('jwks');}
 if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,signature,utf8.encode(`${parts[0]}.${parts[1]}`)))invalid('signature');
 const names=Object.keys(claims);if(names.length!==6||!['iss','sub','aud','iat','jti','events'].every(n=>names.includes(n)))invalid('claims');
 if(claims.aud!==audience)invalid('aud');if(claims.sub!==subject)invalid('sub');
 const seconds=Math.floor(now/1000);if(!Number.isSafeInteger(claims.iat)||claims.iat>seconds+30||claims.iat<seconds-600)invalid('iat');
 if(typeof claims.jti!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(claims.jti))invalid('jti');
 return {header,claims,type:events[0][0],payload:events[0][1]};
}

// ---- Delivery ----
// Least data (§6.2, §11.5): resource references in a snapshot lose `token`, `token_type` and `expires_at`.
const STRIP=['token','token_type','expires_at'];
// X6-S5: any object with a string `id` is a resource reference; the keys go at every depth inside it, so nothing under
// `broker` or a contract-less reference carries a credential. Owner fields outside references are untouched.
function minimize(value,depth=0,inside=false){
 if(depth>16)fault('unavailable','Preference snapshot too deep.',503);
 if(Array.isArray(value))return value.map(v=>minimize(v,depth+1,inside));
 if(value===null||['string','boolean'].includes(typeof value)||Number.isFinite(value))return value;
 if(!plain(value))fault('unavailable','Preference snapshot is not plain data.',503);
 const resource=inside||typeof value.id==='string';
 return Object.fromEntries(Object.entries(value).filter(([k])=>!(resource&&STRIP.includes(k))).map(([k,v])=>[k,minimize(v,depth+1,resource)]));
}
function backoff(x,attempts){const base=Math.min(x.limits.maxRetry,x.limits.firstRetry*2**Math.min(attempts-1,30));return Math.max(1,Math.floor(base*(0.5+0.5*x.random.bytes(1)[0]/255)));}
function classify(response){
 if(!plain(response)||!Number.isInteger(response.status))return {kind:'retry',code:'transport'};
 if(response.status===202)return {kind:'ack'};
 if(response.status===400){let code='invalid_request';try{const doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.bytes));if(typeof doc?.err==='string'&&CODE.test(doc.err))code=doc.err;}catch{}return {kind:'rejected',code};}
 return {kind:'retry',code:response.status>=300&&response.status<400?'redirect':'http_'+response.status};
}
function payloadOf(r,c,snap,target){
 if(r.type==='preferences-updated')return {generation:c.generation,body:{fragment:r.fragment,revision:snap.revision??null,values:snap.values===null?null:minimize(snap.values)}};
 if(r.type==='connection-revoked')return {generation:r.floor,body:{generation_floor:r.floor,terminal:r.terminal}};
 if(r.type==='connection-resumed')return {generation:r.generation,body:{}};
 if(r.type==='credential-revoked')return {generation:c.generation,body:{grants:r.grants,until:r.until}};
 if(r.type==='bus-advanced')return {generation:c.generation,body:{bus:target.bus,head:target.head}};/* EV-3: data-free */
 return {generation:c.generation,body:{resource:r.resource}};
}
async function drop(x,r,code){
 const now=x.clock.now();
 await x.store.transaction(async tx=>{const cur=await tx.get(r.key);if(!cur||cur.order!==r.order)return;const m=await meta(tx);await remove(tx,m,r.key);
  const entry={at:now,connection:r.connection,type:r.type,outcome:'dropped',code};await log(tx,m,entry,x.limits);if(REVOCATION.has(r.type)&&code==='unknown_connection')await unacked(tx,m,{...entry,reason:code},x.limits);await tx.put(META,m);});
 return 'dropped';
}
async function attempt(x,owner,port,r,c){
 const now=x.clock.now(),endpoint=endpointOf(c,x.issuer);
 if(!c)return drop(x,r,'unknown_connection');if(!endpoint)return drop(x,r,'no_endpoint');
 // Revocations are always deliverable; anything else needs a live connection (§3.1: no events while paused).
 if(!REVOCATION.has(r.type)&&!LIVE.includes(c.state))return c.state==='disconnected'?drop(x,r,'disconnected'):now-r.createdAt>=x.limits.window?drop(x,r,'stale'):'held';
 if(!CONTROL.has(r.type)&&!subscribed(c).includes(INTEGRATION_EVENT_TYPES[r.type]))return drop(x,r,'unsubscribed');
 if(r.type==='credential-revoked'&&r.until*1000<=now)return drop(x,r,'moot');
 let snap;
 if(r.type==='preferences-updated'){
  if(typeof x.snapshot!=='function')return 'held';
  try{snap=await x.snapshot({owner,connection:c.id,clientId:c.clientId,generation:c.generation,fragment:r.fragment});}catch{snap=undefined;}
  if(!plain(snap)||!Object.hasOwn(snap,'values')||snap.values!==null&&!plain(snap.values)||snap.revision!==undefined&&snap.revision!==null&&!(typeof snap.revision==='string'&&snap.revision.length<=128||Number.isSafeInteger(snap.revision)))snap=undefined;
 }
 // EV-3: a doorbell's body comes from live subscription state, re-checked inside the lease commit below.
 let target;if(r.type==='bus-advanced'){target=await doorbellTarget(x.store,{row:r,connection:c,owner,subscribed:x.doorbellGrant??null});if(!target)return drop(x,r,'moot');}
 let built;try{built=snap===undefined&&r.type==='preferences-updated'?null:payloadOf(r,c,snap,target);}catch{built=null;}
 const lease=await x.store.transaction(async tx=>{
  const cur=await tx.get(r.key);if(!cur||cur.order!==r.order||cur.nextAt>now)return null;
  if(r.type==='bus-advanced'){const again=await doorbellTarget(tx,{row:r,connection:c});if(!again)return {moot:true};built=payloadOf(r,c,snap,again);await markDoorbellSent(tx,{row:r,now});}/* EV-3 */
  if(built&&(!cur.jti||JSON.stringify([cur.sentGeneration,cur.body])!==JSON.stringify([built.generation,built.body]))){
   const k=await conn(tx,c.id);if(k.seq>=Number.MAX_SAFE_INTEGER)fault('unavailable','Event sequence exhausted.',503);
   Object.assign(cur,{jti:token16(x.random),seq:++k.seq,sentGeneration:built.generation,body:built.body});await tx.put(CONN+c.id,k);
  }
  cur.attempts++;cur.firstAttemptAt??=now;cur.nextAt=now+backoff(x,cur.attempts);cur.attempt=token16(x.random);await tx.put(r.key,cur);return cur;
 });
 if(!lease)return 'skipped';
 if(lease.moot||r.type==='bus-advanced'&&!await doorbellTarget(x.store,{row:r,connection:c,owner,subscribed:x.doorbellGrant??null}))return drop(x,r,'moot');/* EV-3: re-checked just before egress (EV3-R5) */
 let outcome;
 if(!built)outcome={kind:'retry',code:'snapshot_unavailable'};
 else{
  const claims={iss:x.issuer,sub:x.subject(owner),aud:endpoint,iat:Math.floor(now/1000),jti:lease.jti,events:{[INTEGRATION_EVENT_TYPES[r.type]]:{connection:c.id,generation:lease.sentGeneration,seq:lease.seq,...lease.body}}};
  if(size(claims)>x.limits.setBytes)outcome={kind:'rejected',code:'oversize'};
  else try{const signed=await x.signer.sign('event',claims);if(typeof signed?.token!=='string')throw egressError();outcome=classify(await x.egress.send({url:endpoint,body:signed.token,timeoutMs:x.limits.timeoutMs}));}catch{outcome={kind:'retry',code:'transport'};}
 }
 return settle(x,owner,port,r,c,lease,outcome);
}
async function settle(x,owner,port,r,c,lease,outcome){
 const now=x.clock.now();
 const s=await x.store.transaction(async tx=>{
  const cur=await tx.get(r.key);if(!cur||cur.attempt!==lease.attempt)return {result:'superseded'};
  const m=await meta(tx),k=await conn(tx,c.id),entry={at:now,connection:c.id,type:r.type,seq:lease.seq??null,attempts:cur.attempts};let result,health;
  if(outcome.kind==='ack'){await remove(tx,m,r.key);k.delivered={seq:lease.seq,at:now};if(k.degraded){delete k.degraded;health=false;}result='acknowledged';}
  else if(outcome.kind==='rejected'){await remove(tx,m,r.key);result='rejected';if(REVOCATION.has(r.type))await unacked(tx,m,{...entry,reason:outcome.code},x.limits);}
  else if(now-cur.firstAttemptAt>=x.limits.window){
   // X6-S2: the endpoint failed for the whole window, so the connection's backlog expires with this row instead of
   // starting its own 72 h one row at a time; revocations among it are recorded as unacknowledged.
   result='expired';for(const [key,row] of await tx.list({prefix:ROW+c.id+'/',limit:x.limits.perConnection*2+x.limits.doorbellsPerConnection+1/* EV-3 */})){await remove(tx,m,key);
    if(REVOCATION.has(row.type))await unacked(tx,m,{...entry,type:row.type,seq:row.seq??null,reason:'expired'},x.limits);else if(!k.degraded){k.degraded=true;health=true;}
    if(key!==r.key)await log(tx,m,{at:now,connection:c.id,type:row.type,outcome:'expired',code:'backlog'},x.limits);}}
  else{cur.lastError=outcome.code;await tx.put(r.key,cur);result='retrying';}
  if(result!=='retrying')await log(tx,m,{...entry,outcome:result,...outcome.code?{code:outcome.code}:{}},x.limits);
  await tx.put(CONN+c.id,k);await tx.put(META,m);return {result,health};
 });
 // X4 health is fenced by generation; a stale generation (the connection moved on) changes nothing.
 if(s.health!==undefined)try{await port.health({connection:c.id,expectedGeneration:c.generation,degraded:s.health});}catch{}
 if(!['retrying','superseded'].includes(s.result))x.audit.record({operation:'integration-events.delivery',actor:{kind:'system',owner},outcome:s.result,connection:c.id,type:r.type,seq:lease.seq??null,...outcome.code?{code:outcome.code}:{}});
 return s.result;
}
const listed=async port=>{const out=await port.list(),list=Array.isArray(out)?out:out?.connections;if(!Array.isArray(list))fault('unavailable','Connections are unavailable.',503);return list;};
async function ingest(x,owner){
 const port=x.connections(owner),before=await x.store.get(META),start=before?.v===1?before.cursor:0;
 const out=await port.outbox({after:start,limit:x.limits.ingest});
 if(!plain(out)||!Array.isArray(out.events)||typeof out.gap!=='boolean')fault('unavailable','The connections outbox is unavailable.',503);
 const connections=out.gap||before?.resync?await listed(port):null,now=x.clock.now();
 const result=await x.store.transaction(async tx=>{
  const m=await meta(tx);if(m.cursor!==start)return {ingested:0,cursor:m.cursor,raced:true};
  let ingested=0,full=false;
  for(const e of out.events.filter(e=>Number.isSafeInteger(e?.seq)&&e.seq>m.cursor).sort((a,b)=>a.seq-b.seq)){
   const mapped=fromConnectionEvent(e);
   if(mapped)try{await put(tx,m,mapped,now,x.limits);ingested++;}catch(error){if(error?.code==='integration_events_full'){full=true;break;}throw error;}
   if(mapped||typeof e.connection==='string'&&CONNECTION.test(e.connection)&&Number.isSafeInteger(e.generation)){const k=await conn(tx,e.connection);if(e.generation>k.generation){k.generation=e.generation;await tx.put(CONN+e.connection,k);}}
   m.cursor=e.seq;
  }
  // A gap (X4 trimmed rows we never saw) is repaired from current state: every generation we did not see advance is
  // revoked below its current value, and a live connection is resumed at it. Retried until it fits.
  if(out.gap)m.resync=true;
  if(m.resync&&!full&&connections){
   try{for(const c of connections){if(!endpointOf(c,x.issuer)||!Number.isSafeInteger(c.generation))continue;const k=await conn(tx,c.id);if(c.generation<=k.generation)continue;
    await put(tx,m,{type:'connection-revoked',connection:c.id,floor:c.generation,terminal:c.state==='disconnected'},now,x.limits);if(LIVE.includes(c.state))await put(tx,m,{type:'connection-resumed',connection:c.id,generation:c.generation},now,x.limits);
    k.generation=c.generation;await tx.put(CONN+c.id,k);ingested++;}delete m.resync;}catch(error){if(error?.code!=='integration_events_full')throw error;full=true;}
  }
  await tx.put(META,m);return {ingested,cursor:m.cursor,full,gap:out.gap};
 });
 if(result.cursor>start)try{await port.ack({through:result.cursor});}catch{/* The cursor already guards against re-ingest. */}
 return result;
}
async function deliver(x,owner,{limit}={}){
 if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>x.limits.sends))fault('invalid_request','Unsupported delivery request.');
 const port=x.connections(owner),started=x.clock.now(),max=limit??x.limits.sends,conns=new Map((await listed(port)).map(c=>[c.id,c]));
 const held=r=>!REVOCATION.has(r.type)&&!LIVE.includes(conns.get(r.connection)?.state??'active')||r.type==='preferences-updated'&&typeof x.snapshot!=='function',load=async()=>[...(await x.store.list({prefix:ROW,limit:x.limits.rows+x.limits.doorbellRows+1/* EV-3 */})).values()].sort((a,b)=>a.priority-b.priority||a.order-b.order);
 // Head of line per connection: a pending revocation (due or backing off) holds back resumes and other events.
 const head=(rows,id,gone=new Set())=>Math.min(...rows.filter(r=>r.connection===id&&!gone.has(r.key)&&!held(r)).map(r=>r.priority));
 const rows=await load(),gone=new Set(),per=new Map(),failed=new Map(),tally={acknowledged:0,rejected:0,retrying:0,expired:0,dropped:0,held:0,skipped:0,superseded:0};let sent=0;
 for(const r of rows){
  if(sent>=max||x.clock.now()-started>=x.limits.deadlineMs)break;
  if(failed.has(r.connection)||r.nextAt>x.clock.now()||(per.get(r.connection)??0)>=x.limits.perConnectionSends||r.priority>head(rows,r.connection,gone))continue;
  const outcome=await attempt(x,owner,port,r,conns.get(r.connection));tally[outcome]++;
  if(['acknowledged','rejected','retrying','expired'].includes(outcome)){sent++;per.set(r.connection,(per.get(r.connection)??0)+1);}
  if(!['retrying','held','skipped'].includes(outcome))gone.add(r.key);
  // One failure stops this connection until that row's retry: its endpoint is down or slow and must not starve others.
  if(outcome==='retrying')failed.set(r.connection,(await x.store.get(r.key))?.nextAt??x.clock.now());
 }
 const rest=await load();let next=null;
 for(const r of rest)if(!held(r)&&r.priority===head(rest,r.connection))next=Math.min(next??Infinity,Math.max(r.nextAt,failed.get(r.connection)??0));
 return {...tally,sent,pending:rest.length,next};
}
async function status(x){
 const values=async(prefix,limit)=>[...(await x.store.list({prefix,limit})).entries()];
 return {
  pending:(await values(ROW,x.limits.rows+x.limits.doorbellRows+1/* EV-3 */)).map(([,r])=>({connection:r.connection,type:r.type,attempts:r.attempts,createdAt:r.createdAt,nextAt:r.nextAt,...r.firstAttemptAt?{firstAttemptAt:r.firstAttemptAt}:{},...r.seq?{seq:r.seq}:{},...r.lastError?{lastError:r.lastError}:{}})),
  connections:(await values(CONN,257)).map(([k,v])=>({connection:k.slice(CONN.length),seq:v.seq,degraded:v.degraded===true,delivered:v.delivered??null})),
  unacknowledged:(await values(UNACKED,x.limits.unacked+1)).map(([,v])=>v),
  log:(await values(LOG,x.limits.log+1)).map(([,v])=>v),
 };
}

// ---- Provider and operations ----
function limitsOf(over={}){
 const l={...L,...over};
 if(Object.keys(l).some(k=>!Object.hasOwn(L,k)||!Number.isSafeInteger(l[k])||l[k]<1)||l.window<L.window||l.firstRetry>L.firstRetry||l.maxRetry>L.maxRetry||l.responseBytes>L.responseBytes||l.timeoutMs>10000||l.rows>L.rows||l.perConnection>L.perConnection||l.doorbellRows>L.doorbellRows||l.doorbellsPerConnection>L.doorbellsPerConnection/* EV-3 */)throw new TypeError('Integration event limits must stay within the integrations §6.4 and §11 bounds.');
 return Object.freeze(l);
}
/** The `integrationEvents` provider class for createAppEngine. `connections(owner)` -> {outbox, ack, list, health}: the
 * X4 system operations for that owner. `signer.sign('event', claims)` -> {token}: brokering keys (X5). `egress.send({url,
 * body, timeoutMs})` -> {status, bytes}: an adapter above. `snapshot({owner, connection, clientId, generation, fragment})`
 * -> {revision, values}: X8's preferences/v2 projection for the integration (values null when its grant is revoked). */
export function integrationEventsProvider({enabled=false,issuer,subject,connections,signer,egress,snapshot,limits,doorbellGrant/* EV-3 */}={}){
 const options=Object.freeze({enabled:enabled===true,issuer,subject:subject??(owner=>`${issuer}/entities/${owner}`),connections,signer,egress,snapshot,limits:limitsOf(limits),doorbellGrant});
 return class extends IntegrationEventsProvider{static deps=['accountStore','clock','random','audit'];constructor(deps){super(deps,options);}};
}
export class IntegrationEventsProvider extends Provider{
 #deps;#options;#held=new WeakMap();
 constructor(deps,options){super();this.#deps=deps;this.#options=options;}
 async obtain({actor}={}){
  const o=this.#options;if(!o?.enabled)fault('not_found','Not found.',404);
  if(!UUID.test(actor?.owner??'')||!['owner','system'].includes(actor?.kind))fault('unauthorized','Sign in to continue.',401);
  const resources={},obtained=[];
  try{
   for(const name of ['accountStore','clock','random','audit']){resources[name]=await this.#deps[name].obtain();obtained.push(name);}
   const bound=await resources.accountStore.get('owner');if(bound!==undefined&&bound!==actor.owner)fault('forbidden','Account owner mismatch.',403);
   const handle=Object.freeze(scope({...o,store:resources.accountStore,clock:resources.clock,random:resources.random,audit:resources.audit},actor));this.#held.set(handle,{resources,obtained});return handle;
  }catch(error){for(const name of obtained)await this.#deps[name].release(resources[name]);throw error;}
 }
 async release(handle){const held=this.#held.get(handle);if(!held)return;this.#held.delete(handle);for(const name of held.obtained)await this.#deps[name].release(held.resources[name]);}
}
const ready=x=>typeof x.connections==='function'&&typeof x.signer?.sign==='function'&&typeof x.egress?.send==='function'&&typeof x.issuer==='string';
function scope(x,actor){
 const owner=actor.owner,system=()=>{if(actor.kind!=='system')fault('forbidden','This operation is not available to this caller.',403);};
 const input=(value,names)=>{if(value===undefined)return {};if(!plain(value)||Object.keys(value).some(k=>!names.includes(k)))fault('invalid_request','Unsupported integration events request.');return value;};
 const enqueue=event=>x.store.transaction(tx=>enqueueIntegrationEvent(tx,event,{now:x.clock.now(),limits:x.limits}));
 return {
  status:()=>status(x),
  enqueue:value=>{system();const v=input(value,['type','connection','grants','until','resource']);if(!['credential-revoked','resource-detached'].includes(v.type))fault('invalid_request','Unsupported integration event.');return enqueue(v);},
  mark:value=>{system();const v=input(value,['connection','fragment']);if(typeof x.snapshot!=='function')fault('unavailable','Preference snapshots are unavailable.',503);return enqueue({type:'preferences-updated',connection:v.connection,fragment:v.fragment});},
  ingest:()=>{system();return ready(x)?ingest(x,owner):{ready:false};},
  deliver:value=>{system();return ready(x)?deliver(x,owner,input(value,['limit'])):{ready:false};},
 };
}
const CHANGED='integration-events-changed';
/** System. Drains the X4 connections outbox into delivery rows (one commit with the cursor), then acknowledges it. */
export class IngestIntegrationEvents extends AppAction{static operation='integration-events.ingest';static deps=['integrationEvents'];static changes=CHANGED;static lifecycle='purging';run({integrationEvents}){return integrationEvents.ingest();}}
/** System. `input`: {limit?}. One bounded delivery pass; returns the outcome tally and `next` (the earliest wake). */
export class DeliverIntegrationEvents extends AppAction{static operation='integration-events.deliver';static deps=['integrationEvents'];static changes=CHANGED;static lifecycle='purging';run({integrationEvents}){return integrationEvents.deliver(this.input);}}
/** System. `input`: {connection, fragment}: a preferences-updated marker from another single writer (idempotent). */
export class MarkPreferencesUpdated extends AppAction{static operation='integration-events.mark';static deps=['integrationEvents'];static changes=CHANGED;run({integrationEvents}){return integrationEvents.mark(this.input);}}
/** System. `input`: {type:'credential-revoked', connection, grants, until} | {type:'resource-detached', connection, resource}. */
export class EnqueueIntegrationEvent extends AppAction{static operation='integration-events.enqueue';static deps=['integrationEvents'];static changes=CHANGED;static lifecycle='purging';run({integrationEvents}){return integrationEvents.enqueue(this.input);}}
/** Owner or system: pending rows, per-connection seq and health, unacknowledged revocations and the delivery log
 * (owner-visible metadata without payloads, §7.3, §10). */
export class IntegrationEventStatus extends AppQuery{static operation='integration-events.status';static deps=['integrationEvents'];static refreshOn=[CHANGED];fetch({integrationEvents}){return integrationEvents.status();}}
export const INTEGRATION_EVENT_OPERATIONS=operations(IngestIntegrationEvents,DeliverIntegrationEvents,MarkPreferencesUpdated,EnqueueIntegrationEvent,IntegrationEventStatus);

// ---- AccountController slice (packages/runtime/account/index.mjs) ----
// `INTEGRATION_EVENT_PORTS` ({signer, egress, snapshot?, limits?}); snapshot.available=false holds X8 markers. is composed by the Worker and Node adapters. Without a
// signer and egress nothing is ingested or sent (the X4 outbox keeps its bounded rows).
const engines=new WeakMap();
function eventsEngine(c){
 let engine=engines.get(c);
 if(!engine){
  const ports=c.config.INTEGRATION_EVENT_PORTS??{},system=(owner,operation,input)=>c.connectionsSystem(owner,{operation,...input===undefined?{}:{input}});
  engine=createAppEngine({providers:{clock:systemClock,random:cryptoRandom,audit:ports.audit??nullAudit,accountStore:c.metadata,integrationEvents:integrationEventsProvider({enabled:integrationsEnabled(c.config),issuer:c.config.APP_ORIGIN,signer:ports.signer,egress:ports.egress,snapshot:ports.snapshot?.available===false?undefined:ports.snapshot,limits:ports.limits,doorbellGrant:ports.doorbellGrant/* EV-3 */,
   connections:owner=>({outbox:input=>system(owner,'connections.outbox',input),ack:input=>system(owner,'connections.ack',input),list:()=>system(owner,'connections.list'),health:input=>system(owner,'connections.health',input)})}),
   // EV-3 doorbell hunk: the doorbell provider shares this engine's account store and X6 rows.
   eventDoorbells:eventDoorbellsProvider({enabled:doorbellsEnabled(c.config),keys:()=>busKeys(c.config),enqueue:(tx,event,{now})=>enqueueIntegrationEvent(tx,event,{now,limits:limitsOf(ports.limits)}),cancel:cancelIntegrationDoorbell,subscribed:ports.doorbellGrant,issuer:c.config.APP_ORIGIN})}});
  engines.set(c,engine);
 }
 return engine;
}
const doorbellsEnabled=config=>integrationsEnabled(config)&&eventBusesEnabled(config);/* EV-3 */
async function bound(c,owner){return integrationsEnabled(c.config)&&typeof owner==='string'&&UUID.test(owner)&&await c.metadata.get('owner')===owner;}
export const methods={
 /** The account alarm hook: ingest, one bounded delivery pass, then re-arm for the earliest due row. */
 async integrationEventsAlarm(owner){
  if(!await bound(this,owner))return {ready:false};const engine=eventsEngine(this),actor={kind:'system',owner};
  const ingested=await perform(engine,new IngestIntegrationEvents({actor}));if(ingested.ready===false)return {ready:false};
  const rang=doorbellsEnabled(this.config)?await perform(engine,new RingEventDoorbells({actor})):null;/* EV-3 */
  const delivered=await perform(engine,new DeliverIntegrationEvents({actor}));
  const next=Math.min(Number.isSafeInteger(delivered.next)?delivered.next:Infinity,Number.isSafeInteger(rang?.next)?rang.next:Infinity);/* EV-3 */
  if(Number.isSafeInteger(next))await this.scheduleAlarm(Math.max(next,Date.now()+1000));
  return {ingested,delivered,...rang?{rang}:{}};
 },
 /** After any commit that enqueued events (X4 transitions, X7/X8 enqueues): wake the alarm now. */
 async integrationEventsKick(owner){if(!await bound(this,owner))return false;await this.scheduleAlarm(Date.now());return true;},
 async integrationEventsMark(owner,input){if(!await bound(this,owner))throw new AppFault('not_found','Not found.',404);const out=await perform(eventsEngine(this),new MarkPreferencesUpdated({actor:{kind:'system',owner},input}));await this.scheduleAlarm(Date.now());return out;},
 async integrationEventsEnqueue(owner,input){if(!await bound(this,owner))throw new AppFault('not_found','Not found.',404);const out=await perform(eventsEngine(this),new EnqueueIntegrationEvent({actor:{kind:'system',owner},input}));await this.scheduleAlarm(Date.now());return out;},
 // ==== EV-3 doorbell hunk (controller methods; internal until account/events.mjs and the owner RPC mount them) ====
 /** The `event-bus/v1` subscribe/unsubscribe handler body: `context` as eventBusResourceMethod verified it, plus the
  * bus `id` it parsed and the actor it built; `epoch` is `grant:<readSince>`. Then kicks the alarm. */
 async eventDoorbellApp(owner,{method,id,actor,resource,epoch}={}){
  if(!doorbellsEnabled(this.config)||!await bound(this,owner))throw new AppFault('not_found','Not found.',404);
  const Operation=Object.hasOwn(EVENT_DOORBELL_APP_OPERATIONS,method)?EVENT_DOORBELL_APP_OPERATIONS[method]:null;if(!Operation)throw new AppFault('unsupported_method','Unsupported feed method.',400);
  const result=await perform(eventsEngine(this),new Operation({actor,id,resource,epoch}));await this.integrationEventsKick(owner);return result;
 },
 /** Revocation, reduction, disconnect and bus-deletion hooks: {id?, clientId?, connection?}. */
 async eventDoorbellCancel(owner,{id,...input}={}){if(!doorbellsEnabled(this.config)||!await bound(this,owner))return {cancelled:0};return perform(eventsEngine(this),new CancelEventDoorbells({actor:{kind:'system',owner},...id!==undefined?{id}:{},input}));},
 /** Owner: 'events.push' {enabled} or 'events.subscriptions' for bus `id`. */
 async eventDoorbellOwner(owner,{operation,id,input}={}){
  if(!doorbellsEnabled(this.config)||!await bound(this,owner)||!['events.push','events.subscriptions'].includes(operation))throw new AppFault('not_found','Not found.',404);
  const actor={kind:'owner',owner};if(operation==='events.subscriptions')return read(eventsEngine(this),new EventBusSubscriptions({actor,id}));const result=await perform(eventsEngine(this),new SetEventBusPush({actor,id,input}));await this.integrationEventsKick(owner);return result;
 },
 // ==== end EV-3 doorbell hunk ====
 async integrationEventsStatus(owner){if(!await bound(this,owner))throw new AppFault('not_found','Not found.',404);return read(eventsEngine(this),new IntegrationEventStatus({actor:{kind:'system',owner}}));},
};
// Internal only: nothing here is reachable through `invoke` until a later slice mounts it.
export const rpc={};
