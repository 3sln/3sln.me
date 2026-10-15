// Core feature `client-id-metadata.v1` (protocol §2; OAuth Client ID Metadata Document,
// draft-ietf-oauth-client-id-metadata-document-02). A URL `client_id` is resolved to its metadata document through an
// injected SSRF-safe egress port: GET only, no cookies, no redirects, bounded time and size, cached with bounds, rate
// limited per client host and globally, and refused for administrator-blocked hosts. A reviewed registration for the
// same ID (FEDERATION_CLIENTS) always takes precedence and is never fetched. A resolved client is unreviewed: the
// verified client_id origin is its primary label (`name` is that host) and `client_name` is kept only as `claimedName`,
// unverified presentation text. Logos are never fetched or rendered here.
import {fail,object} from './schema.mjs';
export const CLIENT_METADATA_FEATURE='client-id-metadata.v1';
export const CLIENT_METADATA_LIMITS=Object.freeze({maxBytes:16384,timeoutMs:3000,defaultMs:3600000,minMs:300000,maxMs:86400000,negativeMs:60000,cacheEntries:512,blockMs:30000,inFlight:16,
 perHost:Object.freeze({windowMs:60000,limit:6}),global:Object.freeze({windowMs:60000,limit:120})});
const unavailable=()=>fail('invalid_client','This application is not available with this provider.');
// Control, zero-width, line/paragraph separator, bidi and BOM code points (built numerically so no tool rewrites them).
const TEXT_BAD=new RegExp('['+[[0,0x1f],[0x7f,0x9f],[0xad,0xad],[0x61c,0x61c],[0x180e,0x180e],[0x200b,0x200f],[0x2028,0x202e],[0x2060,0x206f],[0xfe00,0xfe0f],[0xfeff,0xfeff],[0xfff9,0xfffb],[0xe0000,0xe0fff]].map(([a,b])=>'\\u{'+a.toString(16)+'}-\\u{'+b.toString(16)+'}').join('')+']','u');
const presentation=(value,max)=>typeof value==='string'&&value.trim()===value&&value.length>0&&[...value].length<=max&&value.isWellFormed()&&!TEXT_BAD.test(value)?value:undefined;
/** DNS host of a public client: lowercase labels, at least one dot, no IP literal and no special-use suffix. */
export function publicClientHost(host){return typeof host==='string'&&host.length<=253&&host.includes('.')&&host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))&&!/^[0-9.]+$/.test(host)&&!/(?:^|\.)(?:localhost|local|internal|invalid|test|onion|arpa|home|lan)$/.test(host);}
/** A URL client ID (syntax only): canonical HTTPS on the default port, a non-root path without dot segments, no
 * query, fragment or userinfo, at most 200 characters (the app-connection identifier bound), and a public DNS host.
 * Comparison is exact string equality (draft §3), so `url.href` must equal the input. */
export function metadataClientURL(value){
 if(typeof value!=='string'||value.length>200)return null;let url;try{url=new URL(value);}catch{return null;}
 if(url.href!==value||url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||url.pathname==='/')return null;
 if(url.pathname.split('/').some(segment=>/^(?:\.|%2e){1,2}$/i.test(segment))||/%2f|%5c|\\/i.test(url.pathname)||!publicClientHost(url.hostname))return null;
 return url;
}
export const metadataClientHost=value=>metadataClientURL(value)?.hostname??null;
/** The host and each parent domain down to two labels (`a.b.app.example` → itself, `b.app.example`, `app.example`):
 * an administrator block on a parent covers every subdomain, so wildcard DNS cannot sidestep it. */
export const hostAndParents=host=>{const labels=host.split('.');return labels.slice(0,-1).map((_,i)=>labels.slice(i).join('.')).filter(name=>name.includes('.'));};
/** Budget grouping without a public-suffix list: the last two labels. Coarse on multi-label suffixes (it then groups
 * more widely, which only tightens budgets) but subdomain churn cannot mint fresh budgets. */
export const clientSite=host=>host.split('.').slice(-2).join('.');
/** Validates a fetched document for `clientId` exactly. Presentation members that fail validation are dropped; any
 * security-relevant member that fails makes the whole document invalid. */
export function validateClientMetadata(document,clientId){
 const url=metadataClientURL(clientId);if(!url||!object(document)||Object.keys(document).length>64)unavailable();
 if(document.client_id!==clientId)unavailable();
 const origin=url.origin,uris=document.redirect_uris;
 if(!Array.isArray(uris)||!uris.length||uris.length>16||new Set(uris).size!==uris.length)unavailable();
 for(const uri of uris){let u;try{u=typeof uri==='string'&&uri.length<=2048?new URL(uri):null;}catch{u=null;}if(!u||u.href!==uri||u.protocol!=='https:'||u.username||u.password||u.hash||u.origin!==origin)unavailable();}
 // Browser public clients only: no shared secrets, key material or confidential authentication methods.
 for(const member of ['client_secret','client_secret_expires_at','jwks','jwks_uri'])if(Object.hasOwn(document,member))unavailable();
 if(document.token_endpoint_auth_method!==undefined&&document.token_endpoint_auth_method!=='none')unavailable();
 if(document.grant_types!==undefined&&(!Array.isArray(document.grant_types)||!document.grant_types.includes('authorization_code')||document.grant_types.some(g=>!['authorization_code','refresh_token'].includes(g))))unavailable();
 if(document.response_types!==undefined&&(!Array.isArray(document.response_types)||document.response_types.some(r=>r!=='code')))unavailable();
 const sameOrigin=value=>{try{const u=typeof value==='string'&&value.length<=2048?new URL(value):null;return u&&u.href===value&&u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&u.origin===origin?value:undefined;}catch{return undefined;}};
 const claimedName=presentation(document.client_name,100),clientUri=sameOrigin(document.client_uri),logoUri=sameOrigin(document.logo_uri);
 return {id:clientId,name:url.host,origin,redirectUris:[...uris],reviewed:false,...claimedName?{claimedName}:{},...clientUri?{clientUri}:{},...logoUri?{logoUri}:{}};
}
/** Shape check for a snapshot crossing a trust boundary inside the runtime (entry store → owner shard). */
export function validClientSnapshot(value){
 if(!object(value)||value.reviewed!==false||Object.keys(value).some(k=>!['id','name','origin','redirectUris','reviewed','claimedName','clientUri','logoUri'].includes(k)))return false;
 const url=metadataClientURL(value.id);if(!url||value.origin!==url.origin||value.name!==url.host)return false;
 try{return JSON.stringify(validateClientMetadata({client_id:value.id,redirect_uris:value.redirectUris,...value.claimedName?{client_name:value.claimedName}:{},...value.clientUri?{client_uri:value.clientUri}:{},...value.logoUri?{logo_uri:value.logoUri}:{}},value.id))===JSON.stringify(value);}catch{return false;}
}
/** In-process sliding-window limiter with the `consume(key,{windowMs,limit})` shape of the runtime ABUSE port. */
export function memoryLimiter({clock=()=>Date.now(),maxKeys=4096}={}){
 const windows=new Map();
 return {async consume(name,{windowMs,limit}){const now=clock();let hits=(windows.get(name)??[]).filter(t=>t>now-windowMs);if(hits.length>=limit){windows.set(name,hits);return false;}hits.push(now);windows.delete(name);windows.set(name,hits);while(windows.size>maxKeys)windows.delete(windows.keys().next().value);return true;}};
}
function maxAge(header,limits){
 const value=typeof header==='string'?header.toLowerCase():'';if(/(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/.test(value))return limits.minMs;
 const match=/(?:^|,)\s*max-age=(\d{1,10})\s*(?:,|$)/.exec(value);const ms=match?Number(match[1])*1000:limits.defaultMs;return Math.min(limits.maxMs,Math.max(limits.minMs,ms));
}
async function boundedBody(response,maxBytes,signal){
 const reader=response.body?.getReader?.();if(!reader)return new Uint8Array();const chunks=[];let size=0;
 const abort=()=>reader.cancel().catch(()=>{});signal?.addEventListener('abort',abort,{once:true});
 try{for(;;){if(signal?.aborted)unavailable();const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array))unavailable();size+=value.byteLength;if(size>maxBytes){abort();unavailable();}chunks.push(value);}}
 finally{signal?.removeEventListener('abort',abort);try{reader.releaseLock();}catch{}}
 const out=new Uint8Array(size);let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.byteLength;}return out;
}
/** Static reviewed clients plus, when `enabled`, metadata-document clients. `fetch(url,{signal})` is the operator's
 * SSRF-safe egress port (Node: the DNS-pinned metadata adapter; Workers: strictly-public global fetch with DoH screening);
 * `limiter` is a `consume` port (fleet-wide where available); `blocked(host)` is the administrator block list. */
export class ClientDirectory {
 constructor({clients=[],enabled=false,fetch,limiter,blocked,clock=()=>Date.now(),limits={},reservedHosts=[]}={}){
  // The provider's own hosts (issuer, embed origin) and their subdomains are never third-party clients.
  this.reservedHosts=reservedHosts.filter(host=>typeof host==='string'&&host).map(host=>host.toLowerCase());
  this.static=new Map(clients.map(client=>[client.id,client]));this.limits={...CLIENT_METADATA_LIMITS,...limits};
  this.enabled=enabled===true&&typeof fetch==='function';Object.assign(this,{fetcher:fetch,limiter:limiter??memoryLimiter({clock}),blockedPort:blocked,clock});
  this.cache=new Map();this.blocks=new Map();this.inFlight=new Map();
 }
 /** True for an ID this provider would resolve from a metadata document (never a reviewed static ID). */
 isMetadataId(clientId){if(!this.enabled||this.static.has(clientId))return false;const url=metadataClientURL(clientId);return url!==null&&!this.reservedHosts.some(host=>url.hostname===host||url.hostname.endsWith('.'+host));}
 known(clientId){return this.static.has(clientId)||this.isMetadataId(clientId);}
 /** The client's web origin without any fetch: registered, or derived from the URL ID (redirect URIs must share it). */
 originOf(clientId){return this.static.get(clientId)?.origin??(this.isMetadataId(clientId)?new URL(clientId).origin:null);}
 remember(map,name,value,max){map.delete(name);map.set(name,value);while(map.size>max)map.delete(map.keys().next().value);}
 async isBlocked(host){return (await Promise.all(hostAndParents(host).map(name=>this.blockedName(name)))).some(Boolean);}
 async blockedName(host){
  if(typeof this.blockedPort!=='function')return false;const now=this.clock(),cached=this.blocks.get(host);if(cached&&cached.until>now)return cached.blocked;
  let blocked;try{blocked=await this.blockedPort(host)===true;}catch{return true;}// Fails closed and is not cached.
  this.remember(this.blocks,host,{blocked,until:now+this.limits.blockMs},this.limits.cacheEntries);return blocked;
 }
 /** Refuses a blocked metadata client without fetching (code exchange, refresh, CORS). Static clients pass. */
 async assertAllowed(clientId){if(this.static.has(clientId))return;if(!this.isMetadataId(clientId)||await this.isBlocked(new URL(clientId).hostname))unavailable();}
 /** Forget a host's cached block decision and documents (administrator changes take effect here immediately). */
 invalidate(host){for(const name of hostAndParents(host))this.blocks.delete(name);for(const id of [...this.cache.keys()])if(metadataClientHost(id)===host)this.cache.delete(id);}
 /** A reviewed client, or a freshly validated snapshot of a metadata client. Throws `invalid_client` otherwise. */
 async resolve(clientId){
  const registered=this.static.get(clientId);if(registered)return structuredClone(registered);
  if(!this.isMetadataId(clientId))unavailable();const host=new URL(clientId).hostname;if(await this.isBlocked(host))unavailable();
  const now=this.clock(),cached=this.cache.get(clientId);
  if(cached&&cached.until>now){if(!cached.client)unavailable();return structuredClone(cached.client);}
  let pending=this.inFlight.get(clientId);
  if(!pending){if(this.inFlight.size>=this.limits.inFlight)unavailable();pending=this.fetchDocument(clientId,host).finally(()=>this.inFlight.delete(clientId));this.inFlight.set(clientId,pending);}
  let client;
  // A known-good document past its freshness is served for up to one more hour when budgets refuse a refetch, so
  // cold-miss floods from other callers cannot take down a working client.
  try{client=await pending;}catch(error){if(error?.code==='rate_limited'&&cached?.client&&cached.until+3600000>now)return structuredClone(cached.client);throw error;}
  if(!client)unavailable();return structuredClone(client);
 }
 async fetchDocument(clientId,host){
  const limits=this.limits;
  // Budgets come before any egress, so a refused ID cannot be used to amplify fetches.
  if(!await this.limiter.consume(`client-metadata/global`,limits.global)||!await this.limiter.consume(`client-metadata/site/${clientSite(host)}`,limits.perHost))fail('rate_limited','Too many sign-in attempts for this application. Try again shortly.');
  const controller=new AbortController();let timer,result=null,ttl=limits.negativeMs;
  try{
   const work=(async()=>{
    const response=await this.fetcher(clientId,{method:'GET',redirect:'manual',credentials:'omit',headers:{Accept:'application/json'},signal:controller.signal});
    // No redirects of any kind; only an exact 200 is a document.
    if(!response||response.status!==200){await response?.body?.cancel?.().catch(()=>{});unavailable();}
    const type=(response.headers.get('Content-Type')??'').split(';')[0].trim().toLowerCase(),length=response.headers.get('Content-Length'),encoding=response.headers.get('Content-Encoding');
    if(type!=='application/json'||encoding&&encoding.toLowerCase()!=='identity'||length!==null&&(!/^\d{1,9}$/.test(length)||Number(length)>limits.maxBytes)){await response.body?.cancel?.().catch(()=>{});unavailable();}
    const bytes=await boundedBody(response,limits.maxBytes,controller.signal);let document;
    try{document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{unavailable();}
    return {client:validateClientMetadata(document,clientId),ttl:maxAge(response.headers.get('Cache-Control'),limits)};
   })();
   work.catch(()=>{});
   const outcome=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},limits.timeoutMs);})]);
   result=outcome.client;ttl=outcome.ttl;
  }catch{result=null;}
  finally{clearTimeout(timer);}
  // Only a validated document whose client_id equals this exact key is cached under it; failures are remembered
  // briefly (never as documents) so a broken or hostile host is not refetched on every request.
  this.remember(this.cache,clientId,{client:result,until:this.clock()+ttl},limits.cacheEntries);
  return result;
 }
}
