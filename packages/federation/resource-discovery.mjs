// EXT-X7 resource discovery (docs/spec/integrations.md §4.1, §4.2, §11 items 1, 6, 8; extensibility-design X7).
// Only the provider calls an integration's discovery endpoint, for an owner action in its authenticated interface or
// for revalidation; applications never reach it. Every call carries a fresh provider-minted `discover` token (60 s,
// `client_id` = issuer, audience = the pinned discovery_endpoint, X5 signing), goes out through an SSRF-safe egress
// port (HTTPS, no redirects, public addresses only, bounded body and deadline) and runs under per-connection and
// per-integration budgets with a failure cool-down, so the provider is never an amplifier against an integration.
// Responses are untrusted: anything not matching §4.2 is dropped item by item, a response that breaks the envelope
// (size, item count, JSON, version) fails as a whole, and integration error text is never surfaced. Successful owner
// searches are cached for at most 5 minutes per (subject, connection, generation, endpoint, query); exact `ids`
// lookups (revalidation, registration) always go to the integration.
//
// Pure module: no storage, no routes. The brokered-record domain (./brokered.mjs) owns connection state, fencing and
// records; the runtime injects `mint` (brokered token minting over the brokering key set) and `egress`.
import {presentationText,TEXT_BAD} from './integrations.mjs';
import {publicAddress} from '../apps/form-fetch-policy.mjs';
import {AppFault} from '../app/faults.mjs';

export const DISCOVERY_LIMITS=Object.freeze({contracts:8,manifestContracts:32,text:200,ids:50,limit:100,defaultLimit:50,cursor:1024,facetsBytes:4096,items:100,responseBytes:65536,id:512,label:100,description:500,timeoutMs:5000,cacheMs:300000,cacheEntries:256});
/** Budgets: per connection and pool (sliding minute and day), per account (minute), per integration origin (minute,
 * concurrency), per process (minute) and cool-downs after consecutive failures. `durable` (optional) is a fleet-wide fixed-window limiter `consume(key,{windowMs,limit})`. */
export const DISCOVERY_BUDGETS=Object.freeze({connectionPerMinute:30,connectionPerDay:600,describeShare:0.5,accountPerMinute:60,integrationPerMinute:120,globalPerMinute:1200,integrationConcurrency:4,failureThreshold:5,cooldownMs:60000,originFailingConnections:3});
const fault=(code,message,status,extra={})=>{throw Object.assign(new AppFault(code,message,status),extra);};
const invalid=message=>fault('invalid_request',message,400);
const unavailable=(message='Discovery is not available for this connection.')=>fault('discovery_unavailable',message,409);
const failed=()=>fault('discovery_failed','The integration did not answer with a valid discovery result.',502);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const only=(v,names)=>plain(v)&&Object.keys(v).every(k=>names.includes(k));
const PRINTABLE=/^[\x21-\x7e]+$/;
const HOST=host=>host.length<=253&&host.includes('.')&&host.split('.').every(l=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))&&!/^[\d.]+$/.test(host)&&!/(?:^|\.)(?:localhost|local|internal|invalid|test|onion|arpa|home|lan|corp)$/.test(host);

/** An integration endpoint the provider may call: canonical HTTPS on port 443 with a public DNS name (never an IP
 * literal or a local/special-use name), no userinfo, query or fragment, never on the issuer's own host or a reserved
 * host. Defence in depth: the manifest (X3) already pinned the same origin and path prefix. Returns a URL or null. */
export function integrationEndpoint(value,{issuer,reserved=[]}={}){
 if(typeof value!=='string'||value.length>2048)return null;let u;try{u=new URL(value);}catch{return null;}
 if(u.href!==value||u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||value.includes('?')||value.includes('#')||!HOST(u.hostname))return null;
 let own;try{own=new URL(issuer).hostname;}catch{return null;}
 if(u.hostname===own||u.hostname.endsWith('.'+own)||reserved.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return null;
 return u;
}
/** A discovered resource ID (§4.2): canonical HTTPS on the rpc_endpoint origin, at most 512 characters, no userinfo
 * or fragment. Returns the string or undefined. */
export function resourceId(value,rpcEndpoint){
 if(typeof value!=='string'||value.length>DISCOVERY_LIMITS.id||value.includes('#')||TEXT_BAD.test(value))return undefined;let u,rpc;try{u=new URL(value);rpc=new URL(rpcEndpoint);}catch{return undefined;}
 return u.href===value&&u.protocol==='https:'&&!u.username&&!u.password&&u.origin===rpc.origin?value:undefined;
}
const contractList=(value,allowed,max)=>Array.isArray(value)&&value.length>0&&value.length<=max&&new Set(value).size===value.length&&value.every(c=>typeof c==='string')?value:undefined;
/** Normalizes an owner query against the pinned manifest into the §4.1 body. Throws invalid_request,
 * unsupported_contract or discovery_unavailable. */
export function discoveryQuery(input,{manifest}={}){
 const r=manifest?.resources;if(!r||!Array.isArray(r.contracts))unavailable();
 if(!only(input,['contracts','text','facets','parent','ids','cursor','limit']))invalid('Unsupported discovery request.');
 const contracts=contractList(input.contracts,r.contracts,DISCOVERY_LIMITS.contracts);if(!contracts)invalid('Choose between one and eight contracts.');
 if(contracts.some(c=>!r.contracts.includes(c)))fault('unsupported_contract','This integration does not offer that contract.',400);
 let text=null;if(input.text!==undefined&&input.text!==null){if(typeof input.text!=='string'||[...input.text].length>DISCOVERY_LIMITS.text||!input.text.isWellFormed()||TEXT_BAD.test(input.text))invalid('Search text is too long or contains unsupported characters.');text=input.text.trim()||null;}
 let facets={};if(input.facets!==undefined&&input.facets!==null){
  if(!plain(input.facets)||Object.keys(input.facets).some(k=>!contracts.includes(k)||!plain(input.facets[k])))invalid('Facets are keyed by a requested contract.');
  let raw;try{raw=JSON.stringify(input.facets);}catch{invalid('Unsupported facets.');}if(new TextEncoder().encode(raw).length>DISCOVERY_LIMITS.facetsBytes)invalid('Facets are too large.');facets=JSON.parse(raw);
 }
 const parent=input.parent===undefined||input.parent===null?null:resourceId(input.parent,r.rpc_endpoint);if(parent===undefined)invalid('Unsupported parent.');
 let ids=null;if(input.ids!==undefined&&input.ids!==null){
  if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>DISCOVERY_LIMITS.ids||new Set(input.ids).size!==input.ids.length||input.ids.some(id=>!resourceId(id,r.rpc_endpoint)))invalid('Look up between one and fifty resource IDs.');
  if(text!==null||Object.keys(facets).length||parent!==null)invalid('An exact lookup cannot be combined with text, facets or a parent.');ids=[...input.ids];
 }
 const cursor=input.cursor===undefined||input.cursor===null?null:typeof input.cursor==='string'&&input.cursor.length<=DISCOVERY_LIMITS.cursor&&PRINTABLE.test(input.cursor)?input.cursor:invalid('Unsupported cursor.');
 const limit=input.limit===undefined?(ids?ids.length:DISCOVERY_LIMITS.defaultLimit):Number.isSafeInteger(input.limit)&&input.limit>=0&&input.limit<=DISCOVERY_LIMITS.limit?input.limit:invalid('Choose a page size from 0 to 100.');
 return {v:1,contracts:[...contracts],text,facets,parent,ids,cursor,limit};
}
/** Validates a §4.2 response body (bytes) for `query` under `manifest`. Whole-response failures (encoding, JSON,
 * envelope, version, more than 100 items) throw discovery_failed; invalid items are dropped and counted. Items claiming
 * a contract outside the manifest, missing a requested contract (unless a container), ignoring a requested facet,
 * repeating an ID or answering outside an exact lookup are dropped. Only known members are copied. */
export function discoveryResult(bytes,{query,manifest}={}){
 const r=manifest?.resources;if(!r)failed();if(!(bytes instanceof Uint8Array)||bytes.length>DISCOVERY_LIMITS.responseBytes)failed();
 let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{failed();}
 if(!plain(body)||body.v!==1||!Array.isArray(body.items)||body.items.length>DISCOVERY_LIMITS.items)failed();
 if(query.limit===0){if(body.items.length||typeof body.exists!=='boolean')failed();return {items:[],exists:body.exists,cursor:null,dropped:0};}
 const facetKeys=Object.keys(query.facets??{}),seen=new Set(),items=[];let dropped=0;
 for(const raw of body.items){
  const item=plain(raw)?raw:{},id=resourceId(item.id,r.rpc_endpoint),label=presentationText(item.label,DISCOVERY_LIMITS.label);
  const description=item.description===undefined||item.description===null?null:presentationText(item.description,DISCOVERY_LIMITS.description)??false;
  const container=item.container===undefined?false:item.container;
  const claimed=contractList(item.contracts??[],r.contracts,DISCOVERY_LIMITS.manifestContracts)??(Array.isArray(item.contracts)&&!item.contracts.length?[]:undefined);
  const applied=item.facets_applied===undefined?[]:Array.isArray(item.facets_applied)&&item.facets_applied.length<=DISCOVERY_LIMITS.contracts&&item.facets_applied.every(f=>typeof f==='string')?item.facets_applied:undefined;
  const ok=id&&label&&description!==false&&typeof container==='boolean'&&claimed&&applied&&claimed.every(c=>r.contracts.includes(c))&&!seen.has(id)&&(query.ids===null||query.ids.includes(id))&&facetKeys.every(f=>applied.includes(f))&&(container||query.contracts.every(c=>claimed.includes(c)));
  if(!ok||items.length>=query.limit){dropped++;continue;}
  seen.add(id);items.push({id,label,...description?{description}:{},contracts:[...claimed],container,assignable:query.contracts.every(c=>claimed.includes(c)),unverified:true});
 }
 const cursor=query.ids!==null||body.cursor===undefined||body.cursor===null?null:typeof body.cursor==='string'&&body.cursor.length<=DISCOVERY_LIMITS.cursor&&PRINTABLE.test(body.cursor)?body.cursor:failed();
 return {items,cursor,dropped};
}

// ---- Egress ----
/** SSRF-safe POST egress over a Fetch implementation: `resolve(host)` -> addresses (the Worker DoH screen or a Node
 * resolver) must answer only globally routable addresses; redirects are never followed (a 3xx is returned as is and
 * refused by the caller); identity encoding only; the body is read with a hard byte bound under one deadline.
 * Without connection pinning, DNS can change between the screen and the connection: Workers rely on
 * `global_fetch_strictly_public` for that, and Node needs a DNS-pinned transport with the same `send` shape
 * (residual risk recorded for client-id-metadata.v1 applies). Returns {send({url,headers,body,maxBytes,signal})}
 * -> {status, contentType, bytes}. */
export function createIntegrationEgress({fetcher=globalThis.fetch,resolve,publicRouting=false,timeoutMs=DISCOVERY_LIMITS.timeoutMs,maxConcurrent=16}={}){
 if(typeof fetcher!=='function'||typeof resolve!=='function'||publicRouting!==true)throw new TypeError('Integration egress needs a fetcher, an address screen and strictly public routing.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>64)throw new TypeError('Invalid integration egress limits.');
 const refuse=()=>fault('egress_refused','The integration could not be reached safely.',502);let active=0;
 return {async send({url,headers={},body,maxBytes,requestBytes=65536,signal}={}){
  let u;try{u=new URL(url);}catch{refuse();}if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||!HOST(u.hostname)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>DISCOVERY_LIMITS.responseBytes||!Number.isSafeInteger(requestBytes)||requestBytes<1||requestBytes>1500000||typeof body!=='string'||new TextEncoder().encode(body).length>requestBytes)refuse();
  if(active>=maxConcurrent)fault('egress_busy','The provider is busy. Try again shortly.',503,{retryAfter:1});// Local pressure: neutral for budgets and health.
  active++;const controller=new AbortController(),stop=()=>controller.abort();signal?.addEventListener('abort',stop,{once:true});let reader,timer;
  // One deadline for screen, connection and body, enforced even against a transport that ignores the abort signal.
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{stop();reader?.cancel().catch(()=>{});reject(Object.assign(new AppFault('egress_refused','The integration could not be reached safely.',502)));},timeoutMs);});
  const exchange=async()=>{
   const addresses=await resolve(u.hostname,{signal:controller.signal});if(!Array.isArray(addresses)||!addresses.length||addresses.length>64||addresses.some(a=>!publicAddress(a)))refuse();
   const response=await fetcher(u.href,{method:'POST',headers:{...headers,'Accept-Encoding':'identity'},body,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
   const status=response.status,contentType=response.headers.get('Content-Type')??'',encoding=response.headers.get('Content-Encoding'),length=response.headers.get('Content-Length');
   if(!Number.isInteger(status)||status<200||status>599||status>=300&&status<400||encoding&&encoding.toLowerCase()!=='identity'||length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){await response.body?.cancel().catch(()=>{});return {status:status>=300&&status<400?status:502,contentType:'',bytes:new Uint8Array()};}
   reader=response.body?.getReader();const chunks=[];let size=0;
   if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel().catch(()=>{});refuse();}chunks.push(value);}
   const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.byteLength;}
   return {status,contentType:contentType.slice(0,128),bytes};
  };
  try{return await Promise.race([exchange(),deadline]);}
  catch(error){stop();reader?.cancel().catch(()=>{});if(error?.code==='egress_refused')throw error;refuse();}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);active--;}
 }};
}
/** DNS-over-HTTPS address screen for createIntegrationEgress on Workers (A and AAAA, Status 0, no truncation, bounded). */
export function createDohResolver({fetcher=globalThis.fetch,endpoint='https://cloudflare-dns.com/dns-query'}={}){
 const refuse=()=>fault('egress_refused','The integration could not be reached safely.',502);
 const ask=async(host,type,signal)=>{const u=new URL(endpoint);u.searchParams.set('name',host);u.searchParams.set('type',String(type));
  const response=await fetcher(u.href,{method:'GET',headers:{Accept:'application/dns-json'},credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal});
  if(response.status!==200||!(response.headers.get('Content-Type')||'').toLowerCase().includes('application/dns-json')){await response.body?.cancel().catch(()=>{});refuse();}
  const text=await response.text();if(text.length>16384)refuse();let result;try{result=JSON.parse(text);}catch{refuse();}
  if(result?.Status!==0||result.TC===true||!Array.isArray(result.Question)||result.Question.length!==1||result.Question[0].name?.replace(/\.$/,'').toLowerCase()!==host||result.Question[0].type!==type||result.Answer!==undefined&&!Array.isArray(result.Answer))refuse();
  const answers=result.Answer??[];if(answers.length>64||answers.some(a=>![5,type].includes(a?.type)))refuse();return answers.filter(a=>a.type===type).map(a=>a.data);};
 return async(host,{signal}={})=>[...await ask(host,1,signal),...await ask(host,28,signal)];
}

// ---- Budgets ----
/** Sliding-window budgets. One instance per process is shared by default (`sharedDiscoveryBudget`) so every account
 * served by an isolate draws on the same per-integration and global allowance; `durable` adds a fleet-wide window.
 * Pools separate who spends: `owner` (searches, registration, revalidation) and `describe` (provider-feature calls a
 * public descriptor request can cause), so anonymous traffic never exhausts the owner's allowance (X7-R2).
 * Cool-downs are per (connection, origin); an origin cools down for everyone only when several distinct connections
 * fail within the window, so one tenant cannot switch an integration off for the others (X7-R1). Release outcomes:
 * 'ok' | 'neutral' (owner input, refusals, local pressure) | 'fail' (the integration is unhealthy). */
export class DiscoveryBudget{
 constructor({budgets=DISCOVERY_BUDGETS,clock=()=>Date.now(),durable,maxKeys=4096}={}){Object.assign(this,{budgets:{...DISCOVERY_BUDGETS,...budgets},clock,durable,maxKeys,windows:new Map(),active:new Map(),failures:new Map(),origins:new Map()});}
 // Least-recently-used eviction: a burst of fresh keys never evicts a hot per-integration or global window (X7-R7).
 #touch(map,key,make){let value=map.get(key);if(value===undefined){value=make();while(map.size>=this.maxKeys)map.delete(map.keys().next().value);}else map.delete(key);map.set(key,value);return value;}
 #count(key,windowMs,limit,now){const list=this.#touch(this.windows,key,()=>[]);while(list.length&&list[0]<=now-windowMs)list.shift();return list.length<limit;}
 /** Admits one call for (connection, integration origin) in `pool` or throws discovery_rate_limited with
  * `retryAfter`. Returns a release function that must be called once with the outcome. */
 async admit(connection,origin,pool='owner',account=connection){
  const b=this.budgets,now=this.clock(),limited=seconds=>fault('discovery_rate_limited','Too many discovery requests. Try again shortly.',429,{retryAfter:Math.max(1,Math.ceil(seconds))});
  const pair=`${connection}|${origin}`,cool=Math.max(this.failures.get(pair)?.until??0,this.origins.get(origin)?.until??0);if(cool>now)limited((cool-now)/1000);
  const scale=pool==='describe'?b.describeShare:1,keys=[[`${pool}:c:${connection}:m`,60000,Math.max(1,Math.floor(b.connectionPerMinute*scale))],[`${pool}:c:${connection}:d`,86400000,Math.max(1,Math.floor(b.connectionPerDay*scale))],[`a:${account}:m`,60000,b.accountPerMinute],[`i:${origin}:m`,60000,b.integrationPerMinute],['g:m',60000,b.globalPerMinute]];// one account never drains the process window
  for(const [key,windowMs,limit] of keys)if(!this.#count(key,windowMs,limit,now))limited(windowMs===86400000?3600:60);
  if((this.active.get(origin)??0)>=b.integrationConcurrency)limited(1);
  if(this.durable&&!await this.durable.consume(`integration-discovery:${origin}`,{windowMs:60000,limit:b.integrationPerMinute*10}))limited(60);
  for(const [key] of keys)this.windows.get(key).push(now);
  this.active.set(origin,(this.active.get(origin)??0)+1);let done=false;
  return outcome=>{if(done)return;done=true;const n=(this.active.get(origin)??1)-1;if(n>0)this.active.set(origin,n);else this.active.delete(origin);
   if(outcome==='ok'){this.failures.delete(pair);return;}if(outcome!=='fail')return;
   const at=this.clock(),f=this.#touch(this.failures,pair,()=>({count:0,until:0}));f.count++;if(f.count<b.failureThreshold)return;f.until=at+b.cooldownMs;f.count=0;
   const o=this.#touch(this.origins,origin,()=>({connections:new Map(),until:0}));o.connections.set(connection,at);for(const [k,t] of o.connections)if(t<=at-b.cooldownMs)o.connections.delete(k);
   if(o.connections.size>=b.originFailingConnections){o.until=at+b.cooldownMs;o.connections.clear();}};
 }
}
export const sharedDiscoveryBudget=new DiscoveryBudget();

// ---- Client ----
const JSON_TYPE=/^application\/json(?:\s*;.*)?$/i;
/** Maps a non-200 discovery answer to a provider fault without echoing integration text. */
function answerFault(status,bytes){
 let code;try{const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(0,4096)));code=typeof parsed?.error==='string'?parsed.error:undefined;}catch{code=undefined;}
 if(status===400&&code==='unsupported_facet')fault('unsupported_facet','The integration cannot apply these filters.',400);
 if(status===429||status===503)fault('discovery_rate_limited','The integration is busy. Try again shortly.',429,{retryAfter:60});
 if(status===401||status===403)fault('discovery_rejected','The integration refused the provider\'s request. Its connection may need attention.',502);
 failed();
}
export class DiscoveryClient{
 /** `mint(claims)` -> {token}: brokered minting (packages/federation/signing.mjs mintAccessToken over the brokering key
  * set). `egress`: {send}. `reserved`: provider hosts never called. */
 constructor({issuer,mint,egress,clock=()=>Date.now(),budget=sharedDiscoveryBudget,reserved=[],cacheMs=DISCOVERY_LIMITS.cacheMs,cacheEntries=DISCOVERY_LIMITS.cacheEntries}={}){
  if(typeof issuer!=='string')throw new TypeError('A provider issuer is required.');
  if(!Number.isSafeInteger(cacheMs)||cacheMs<0||cacheMs>DISCOVERY_LIMITS.cacheMs||!Number.isSafeInteger(cacheEntries)||cacheEntries<1)throw new TypeError('Discovery cache bounds are invalid.');
  Object.assign(this,{issuer,mint,egress,clock,budget,reserved,cacheMs,cacheEntries,cache:new Map()});
 }
 get available(){return typeof this.mint==='function'&&typeof this.egress?.send==='function';}
 /** The endpoint a connection's call goes to, or discovery_unavailable. `kind`: discovery_endpoint | rpc_endpoint. */
 endpoint(connection,kind='discovery_endpoint'){const u=integrationEndpoint(connection?.manifest?.resources?.[kind],{issuer:this.issuer,reserved:this.reserved});if(!u)unavailable();return u;}
 /** One authenticated provider call to an integration endpoint: admitted under the budgets, minted fresh and posted
  * through egress. Returns the egress answer; the caller validates it. Exposed for the brokered `describe`. */
 async call({connection,url,claims,body,maxBytes,requestBytes=65536,pool='owner'}){
  if(!this.available)unavailable('Brokered calls are not configured on this provider.');
  const release=await this.budget.admit(connection.id,url.origin,pool,claims.subject);let outcome='fail';
  try{
   let token;try{({token}=await this.mint({...claims,audience:url.href,clientId:this.issuer}));}catch{outcome='neutral';fault('brokering_unavailable','Brokering keys are unavailable.',503);}
   const answer=await this.egress.send({url:url.href,headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body),maxBytes,requestBytes});
   // Only unavailability counts against the integration's cool-down: a refused filter is the owner's input, and a
   // 401/403/404 is about this connection (its health, not the integration's availability for others).
   outcome=answer?.status===200?'ok':answer?.status>=500||answer?.status===429?'fail':'neutral';return answer;
  }catch(error){if(error?.code==='egress_busy')outcome='neutral';throw error;}
  finally{release(outcome);}
 }
 /** `connection`: {id, generation, state, manifest} as the brokered domain read it inside its fence; `subject`: the
  * entity URL. `fresh` bypasses the cache (exact lookups always do). */
 async discover({subject,connection,query,fresh=false}){
  if(!connection||!['active','degraded'].includes(connection.state))unavailable();
  const url=this.endpoint(connection),q=discoveryQuery(query,{manifest:connection.manifest});
  const key=JSON.stringify([subject,connection.id,connection.generation,url.href,q]),now=this.clock(),hit=this.cache.get(key);
  if(hit&&hit.until>now&&!fresh&&q.ids===null)return structuredClone(hit.value);
  if(hit)this.cache.delete(key);
  const answer=await this.call({connection,url,claims:{subject,purpose:'discover',connection:connection.id,generation:connection.generation},body:q,maxBytes:DISCOVERY_LIMITS.responseBytes});
  if(answer.status!==200)answerFault(answer.status,answer.bytes??new Uint8Array());
  if(!JSON_TYPE.test(answer.contentType??''))failed();
  const value=discoveryResult(answer.bytes,{query:q,manifest:connection.manifest});
  if(q.ids===null&&this.cacheMs>0){while(this.cache.size>=this.cacheEntries)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,{until:now+this.cacheMs,connection:connection.id,value:structuredClone(value)});}
  return value;
 }
 /** Drops cached answers for a connection (detach, change hint, generation change). */
 forget(connectionId){for(const [key,entry] of this.cache)if(entry.connection===connectionId)this.cache.delete(key);}
}
