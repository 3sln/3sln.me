// EXT-X3: the integration manifest (docs/spec/integrations.md §2) is the `bindle_integration` member of a client's OAuth
// metadata (client ID metadata document or operator registration) and nothing else; it is never fetched separately.
// A manifest is presentation and claims only: parsing it grants nothing, assigns nothing and widens no grant. Every URL
// is HTTPS on the client_id origin and path prefix (§2.1). Confidential-only members (`events_endpoint`, `resources`,
// `occupant` extensions) in a public client make the manifest invalid, because the document and the manifest disagree.
// Key continuity (§2.3, AMD-C7): JWK thumbprints (RFC 7638) are pinned at approval; a key set with no pinned key, or any
// change of `jwks_uri`, auth method or `redirect_uris`, is staged for owner review and adopts nothing that widens.
// Unmounted: these are pure validators plus gated engine Queries; INTEGRATIONS_ENABLED and an injected directory are
// required, and no route, token, event or feature declaration is produced here.
import {AppQuery} from '../app/engine.mjs';
import {fail,object} from './schema.mjs';
import {validateExtensions,validateExtensionDigest} from './extensions.mjs';
export const INTEGRATIONS_FEATURE='integrations.v1';
export const PREFERENCES_UPDATED_EVENT='https://spec.bindle.example/events/preferences-updated/v1';
export const INTEGRATION_LIMITS=Object.freeze({manifestBytes:8192,fragments:8,fields:32,methods:32,contracts:32,events:16,keys:16,urlLength:2048,idLength:256});
// Control, zero-width, line/paragraph separator, bidi and BOM code points (built numerically so no tool rewrites them).
export const TEXT_BAD=new RegExp('['+[[0,0x1f],[0x7f,0x9f],[0xad,0xad],[0x61c,0x61c],[0x180e,0x180e],[0x200b,0x200f],[0x2028,0x202e],[0x2060,0x206f],[0xfe00,0xfe0f],[0xfeff,0xfeff],[0xfff9,0xfffb],[0xe0000,0xe0fff]].map(([a,b])=>'\\u{'+a.toString(16)+'}-\\u{'+b.toString(16)+'}').join('')+']','u');
/** Inert plain text: trimmed, nonempty, well-formed, at most `max` code points, no control/bidi/invisible characters. */
export const presentationText=(value,max)=>typeof value==='string'&&value.trim()===value&&value.length>0&&[...value].length<=max&&value.isWellFormed()&&!TEXT_BAD.test(value)?value:undefined;
const utf8=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const DPOP=['none','supported','required'];
/** `client_id` path up to and including its last `/` (§2.1). */
export function clientPrefix(clientId){let url;try{url=new URL(clientId);}catch{return null;}return url.protocol==='https:'?{origin:url.origin,path:url.pathname.slice(0,url.pathname.lastIndexOf('/')+1)}:null;}
/** A manifest URL: canonical HTTPS, no userinfo, query or fragment, no dot or encoded-separator segments, on the
 * client_id origin and under its path prefix. Returns the input or undefined. */
export function prefixedURL(value,clientId,max=INTEGRATION_LIMITS.urlLength){
 const prefix=clientPrefix(clientId);if(!prefix||typeof value!=='string'||value.length>max)return undefined;let url;try{url=new URL(value);}catch{return undefined;}
 if(url.href!==value||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||value.includes('?')||value.includes('#')||url.origin!==prefix.origin||!url.pathname.startsWith(prefix.path))return undefined;
 if(url.pathname.split('/').some(segment=>/^(?:\.|%2e){1,2}$/i.test(segment))||/%2f|%5c|\\/i.test(url.pathname))return undefined;
 return value;
}
// Identifier URLs (fragments, contracts, events, slots): canonical HTTPS, bounded, no userinfo, query or fragment.
const idURL=value=>{if(typeof value!=='string'||value.length>INTEGRATION_LIMITS.idLength||value.includes('?')||value.includes('#'))return undefined;try{const url=new URL(value);return url.href===value&&url.protocol==='https:'&&!url.username&&!url.password?value:undefined;}catch{return undefined;}};
const idList=(value,max,{empty=false}={})=>Array.isArray(value)&&value.length<=max&&(empty||value.length>0)&&new Set(value).size===value.length&&value.every(idURL)?[...value]:undefined;
function setupFragment(entry){
 if(!object(entry))return undefined;
 // The implemented protocol §3 request names the fragment `fragment`; the integrations §2.1 example uses `id`.
 const id=entry.fragment??entry.id;if(entry.fragment!==undefined&&entry.id!==undefined&&entry.fragment!==entry.id||!idURL(id))return undefined;
 const purpose=presentationText(entry.purpose,1000),fields=entry.fields;if(!purpose||entry.required!==undefined&&typeof entry.required!=='boolean')return undefined;
 if(!Array.isArray(fields)||!fields.length||fields.length>INTEGRATION_LIMITS.fields||new Set(fields).size!==fields.length||fields.some(name=>typeof name!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)))return undefined;
 let methods;if(entry.methods!==undefined){if(!object(entry.methods)||Object.keys(entry.methods).length>INTEGRATION_LIMITS.contracts)return undefined;for(const [contract,list] of Object.entries(entry.methods))if(!idURL(contract)||!Array.isArray(list)||!list.length||list.length>INTEGRATION_LIMITS.methods||new Set(list).size!==list.length||list.some(name=>typeof name!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)))return undefined;methods=structuredClone(entry.methods);}
 if(entry.digest!==undefined)try{validateExtensionDigest(entry.digest);}catch{return undefined;}
 return {fragment:id,required:entry.required===true,purpose,fields:[...fields],...methods?{methods}:{},...entry.digest!==undefined?{digest:entry.digest}:{}};
}
/** Validates `bindle_integration` for one exact client. `confidential` is true only for a validated private_key_jwt
 * client; `redirectUris` and `jwksUri` are the document's own values, which must share the path prefix; `reserved` are
 * the provider's hosts. `slots`/`contracts` are trusted pins for claim validation; without them extension entries stay
 * syntax-checked (`unknown`) so the snapshot never depends on fetch timing. Returns
 * {status:'absent'|'valid'|'unrecognized'|'invalid', manifest?, v?, reason?}; never throws for hostile input. */
export function validateIntegrationManifest(value,{clientId,confidential=false,redirectUris=[],jwksUri,reserved=[],slots,contracts={}}={}){
 if(value===undefined)return {status:'absent'};
 const invalid=reason=>({status:'invalid',reason});
 const prefix=clientPrefix(clientId);if(!prefix)return invalid('invalid_client');
 const host=new URL(clientId).hostname;if(reserved.some(name=>host===name||host.endsWith('.'+name)))return invalid('issuer_origin');
 if(!object(value))return invalid('invalid_manifest');
 let size;try{size=utf8(value);}catch{return invalid('invalid_manifest');}if(size>INTEGRATION_LIMITS.manifestBytes)return invalid('manifest_too_large');
 if(value.v!==1)return Number.isSafeInteger(value.v)&&value.v>1?{status:'unrecognized',v:value.v}:invalid('invalid_version');
 // The member applies to this exact document: its own redirect and key URLs must sit under the same prefix.
 if(!Array.isArray(redirectUris)||redirectUris.some(uri=>!prefixedURL(uri,clientId))||jwksUri!==undefined&&!prefixedURL(jwksUri,clientId))return invalid('path_prefix');
 const declaresOccupant=Array.isArray(value.extensions)&&value.extensions.some(entry=>object(entry)&&entry.role==='occupant');
 if(!confidential&&(Object.hasOwn(value,'events_endpoint')||Object.hasOwn(value,'resources')||declaresOccupant))return invalid('confidential_required');
 const manifest={v:1};
 if(object(value.setup)&&Array.isArray(value.setup.fragments)&&value.setup.fragments.length<=INTEGRATION_LIMITS.fragments){const fragments=value.setup.fragments.map(setupFragment);if(fragments.length&&fragments.every(Boolean)&&new Set(fragments.map(f=>f.fragment)).size===fragments.length)manifest.setup={fragments};}
 const management=prefixedURL(value.management_url,clientId);if(management)manifest.management_url=management;
 const events=prefixedURL(value.events_endpoint,clientId);
 if(events){manifest.events_endpoint=events;const subscribed=value.events===undefined?[PREFERENCES_UPDATED_EVENT]:idList(value.events,INTEGRATION_LIMITS.events,{empty:true});if(subscribed)manifest.events=subscribed;else manifest.events=[PREFERENCES_UPDATED_EVENT];}
 const r=value.resources;
 if(object(r)){
  const rpc=prefixedURL(r.rpc_endpoint,clientId),discovery=prefixedURL(r.discovery_endpoint,clientId),list=idList(r.contracts,INTEGRATION_LIMITS.contracts),dpop=r.dpop===undefined?'none':DPOP.includes(r.dpop)?r.dpop:undefined;
  if(rpc&&discovery&&list&&dpop)manifest.resources={rpc_endpoint:rpc,discovery_endpoint:discovery,contracts:list,dpop};
 }
 // Each audience names exactly one purpose; a collision is a security-relevant defect, never silently repaired.
 const endpoints=[manifest.events_endpoint,manifest.resources?.rpc_endpoint,manifest.resources?.discovery_endpoint].filter(Boolean);
 if(new Set(endpoints).size!==endpoints.length||endpoints.includes(manifest.management_url))return invalid('endpoint_collision');
 if(value.extensions!==undefined){
  const results=validateExtensions(value.extensions,{kind:'integration',...slots?{slots}:{},contracts});
  const entries=results.filter(result=>result.status==='valid'||result.status==='unknown').map(result=>result.entry);if(entries.length)manifest.extensions=entries;
 }
 return {status:'valid',manifest};
}
/** Shape check of a stored `integration` snapshot value: a valid manifest must re-derive exactly from itself. */
export function validIntegrationValue(value,context){
 if(!object(value))return false;
 if(value.status==='unrecognized')return Object.keys(value).length===2&&Number.isSafeInteger(value.v)&&value.v>1;
 if(value.status==='invalid')return Object.keys(value).length===2&&typeof value.reason==='string'&&/^[a-z_]{1,40}$/.test(value.reason);
 if(value.status!=='valid'||Object.keys(value).length!==2)return false;
 try{return JSON.stringify(validateIntegrationManifest(value.manifest,context))===JSON.stringify(value);}catch{return false;}
}

// --- Key sets (RFC 7517) and thumbprints (RFC 7638) ---
const B64=/^[A-Za-z0-9_-]+$/,PRIVATE=['d','p','q','dp','dq','qi','oth','k'];
const ALGS={EC:{'P-256':['ES256'],'P-384':['ES384']},OKP:{Ed25519:['EdDSA','Ed25519']},RSA:{'':['RS256','PS256']}};
function publicJwk(key){
 if(!object(key))return null;const crv=key.crv??'';if(key.use!==undefined&&key.use!=='sig')return null;
 if(key.key_ops!==undefined&&(!Array.isArray(key.key_ops)||!key.key_ops.includes('verify')))return null;
 if(key.kid!==undefined&&!presentationText(key.kid,128))return null;
 const algs=ALGS[key.kty]?.[key.kty==='RSA'?'':crv];if(!algs||key.alg!==undefined&&!algs.includes(key.alg))return null;
 const b=(v,min,max)=>typeof v==='string'&&v.length>=min&&v.length<=max&&B64.test(v);
 let clean;
 if(key.kty==='EC'){const n=crv==='P-256'?43:64;if(!b(key.x,n,n)||!b(key.y,n,n))return null;clean={kty:'EC',crv,x:key.x,y:key.y};}
 else if(key.kty==='OKP'){if(!b(key.x,43,43))return null;clean={kty:'OKP',crv,x:key.x};}
 else{if(!b(key.n,342,1366)||!b(key.e,2,8))return null;clean={kty:'RSA',n:key.n,e:key.e};}
 return {...clean,...key.alg!==undefined?{alg:key.alg}:{},...key.kid!==undefined?{kid:key.kid}:{}};
}
const importParams=key=>key.kty==='EC'?{name:'ECDSA',namedCurve:key.crv}:key.kty==='OKP'?{name:'Ed25519'}:{name:key.alg==='PS256'?'RSA-PSS':'RSASSA-PKCS1-v1_5',hash:'SHA-256'};
const b64url=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
/** RFC 7638 SHA-256 thumbprint over the required members in lexicographic order. */
export async function jwkThumbprint(crypto,key){
 const members=key.kty==='EC'?{crv:key.crv,kty:'EC',x:key.x,y:key.y}:key.kty==='OKP'?{crv:key.crv,kty:'OKP',x:key.x}:{e:key.e,kty:'RSA',n:key.n};
 return b64url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(members))));
}
/** Validates a fetched JWK Set: any private or symmetric member rejects the whole set (it signals a leaked key); keys
 * not usable for signature verification are skipped; every kept key must import. Returns
 * {keys,thumbprints(sorted)} or null when no usable public signing key remains. */
export async function validateJwks(crypto,document){
 if(!object(document)||!Array.isArray(document.keys)||!document.keys.length||document.keys.length>INTEGRATION_LIMITS.keys)return null;
 if(document.keys.some(key=>!object(key)||key.kty==='oct'||PRIVATE.some(member=>Object.hasOwn(key,member))))return null;
 const keys=[],seen=new Set();
 for(const raw of document.keys){const key=publicJwk(raw);if(!key)continue;
  try{await crypto.subtle.importKey('jwk',{...key,ext:true},importParams(key),false,['verify']);}catch{continue;}
  const thumbprint=await jwkThumbprint(crypto,key);if(seen.has(thumbprint))continue;seen.add(thumbprint);keys.push({...key,thumbprint});}
 return keys.length?{keys,thumbprints:[...seen].sort()}:null;
}
/** The only keys that may authenticate this client: fetched keys whose thumbprints are pinned. */
export const pinnedKeys=(keySet,thumbprints)=>(keySet?.keys??[]).filter(key=>Array.isArray(thumbprints)&&thumbprints.includes(key.thumbprint));

// --- Approval snapshot and change classification (§2.3) ---
/** The connection pin taken at approval: the validated manifest, client identity members and key thumbprints. */
export function integrationSnapshot(client,keySet){
 if(client?.integration?.status!=='valid')fail('invalid_integration','The integration manifest is not valid.');
 const confidential=client.authMethod==='private_key_jwt';if(confidential&&!keySet?.thumbprints?.length)fail('invalid_integration','The integration key set is unavailable.');
 return {clientId:client.id,redirectUris:[...client.redirectUris].sort(),authMethod:confidential?'private_key_jwt':'none',...confidential?{jwksUri:client.jwksUri,thumbprints:[...keySet.thumbprints]}:{},manifest:structuredClone(client.integration.manifest)};
}
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const sorted=list=>[...list??[]].sort();
/** Classifies a refetch against a pin. `observed` is {client}, {gone:true} (definitive 404/410) or {transient:true};
 * `keySet` is the validated current key set, null when the set was invalid, or undefined when its fetch failed
 * transiently. Returns {decision:'unchanged'|'adopt'|'review'|'invalid', changes, next, staged?}: `next` is the pin to
 * keep now (only narrowing or audited same-prefix endpoint moves are adopted); `staged` awaits owner review. */
export function classifyIntegrationChange(pinned,observed,keySet){
 const out=(decision,changes,next=pinned,staged)=>({decision,changes,next:structuredClone(next),...staged?{staged}:{}});
 if(observed?.transient||!observed?.gone&&!observed?.invalid&&!observed?.client)return out('unchanged',['transient']);
 if(observed.gone)return out('invalid',['client_gone']);
 if(observed.invalid)return out('invalid',['client_invalid']);
 const client=observed.client;if(client.id!==pinned.clientId)return out('invalid',['client_mismatch']);
 const integration=client.integration;
 if(!integration||integration.status==='absent')return out('invalid',['manifest_removed']);
 if(integration.status==='invalid')return out('invalid',['manifest_invalid']);
 if(integration.status==='unrecognized')return out('review',['manifest_version'],pinned,{v:integration.v});
 const current=integration.manifest,changes=[],review=[],next=structuredClone(pinned);
 const authMethod=client.authMethod==='private_key_jwt'?'private_key_jwt':'none';
 const identity=!same(sorted(client.redirectUris),pinned.redirectUris)||authMethod!==pinned.authMethod||(client.jwksUri??undefined)!==pinned.jwksUri;
 if(identity)review.push('identity_changed');
 let keysOk=!identity;
 if(!identity&&authMethod==='private_key_jwt'){
  if(keySet===undefined)keysOk=false;// Key fetch failed transiently: nothing is adopted, nothing is staged.
  else if(!keySet||!keySet.thumbprints.some(t=>pinned.thumbprints.includes(t))){review.push('keys_replaced');keysOk=false;}
  else{
   // X3-S1: a public key appearing next to a pinned one proves no possession (a takeover domain can copy the archived
   // set). Dropped pinned keys are adopted at once; added keys are only `pendingThumbprints` until a fresh assertion
   // signed by a pinned key promotes them (promotePendingKeys). While keys are pending, no endpoint move is adopted.
   const kept=pinned.thumbprints.filter(t=>keySet.thumbprints.includes(t)),added=keySet.thumbprints.filter(t=>!pinned.thumbprints.includes(t));
   if(kept.length<pinned.thumbprints.length){changes.push('keys_removed');next.thumbprints=kept;}
   if(added.length){keysOk=false;next.pendingThumbprints=added;if(!same(added,pinned.pendingThumbprints))changes.push('keys_pending');}
   else if(pinned.pendingThumbprints){delete next.pendingThumbprints;changes.push('keys_pending');}
  }
 }
 const old=pinned.manifest,pr=old.resources,cr=current.resources;
 // Narrowing is always adopted, even while identity is under review.
 if(pr&&!cr){changes.push('resources_removed');delete next.manifest.resources;}
 else if(pr&&cr){
  const kept=pr.contracts.filter(c=>cr.contracts.includes(c));if(kept.length<pr.contracts.length){changes.push('contracts_narrowed');if(kept.length)next.manifest.resources.contracts=kept;else delete next.manifest.resources;}
  if(cr.contracts.some(c=>!pr.contracts.includes(c)))review.push('contracts_widened');
 }else if(cr)review.push('resources_added');
 if(old.events_endpoint&&!current.events_endpoint){changes.push('events_removed');delete next.manifest.events_endpoint;delete next.manifest.events;}
 else if(!old.events_endpoint&&current.events_endpoint)review.push('events_added');
 if(!same(old.setup,current.setup))review.push('setup_changed');
 if(!same(old.extensions,current.extensions))review.push('extensions_changed');
 if(old.events_endpoint&&current.events_endpoint&&!same(old.events,current.events))review.push('events_changed');
 // Same-prefix endpoint moves and DPoP strengthening are adopted only while client identity and keys hold.
 if(keysOk){
  if(old.management_url!==current.management_url){changes.push('management_url_changed');if(current.management_url)next.manifest.management_url=current.management_url;else delete next.manifest.management_url;}
  if(old.events_endpoint&&current.events_endpoint&&old.events_endpoint!==current.events_endpoint){changes.push('events_endpoint_changed');next.manifest.events_endpoint=current.events_endpoint;}
  if(cr&&next.manifest.resources)for(const name of ['rpc_endpoint','discovery_endpoint'])if(pr[name]!==cr[name]){changes.push(name+'_changed');next.manifest.resources[name]=cr[name];}
 }
 if(pr&&cr&&pr.dpop!==cr.dpop){if(DPOP.indexOf(cr.dpop)<DPOP.indexOf(pr.dpop))review.push('dpop_weakened');else if(keysOk&&next.manifest.resources){changes.push('dpop_strengthened');next.manifest.resources.dpop=cr.dpop;}}
 // Endpoint collisions between adopted and pinned values are impossible to repair silently; stage them instead.
 const endpoints=[next.manifest.events_endpoint,next.manifest.resources?.rpc_endpoint,next.manifest.resources?.discovery_endpoint].filter(Boolean);
 if(new Set(endpoints).size!==endpoints.length||endpoints.includes(next.manifest.management_url))return out('review',['endpoint_collision',...review],pinned,currentSnapshot(client,keySet));
 if(review.length)return out('review',[...review,...changes],next,currentSnapshot(client,keySet));
 return out(changes.length?'adopt':'unchanged',changes,next);
}
/** Promotes pending thumbprints into the pin only on proof of possession by the current pin: `signedBy` is the
 * thumbprint of the key that verified a fresh private_key_jwt assertion observed after the keys appeared. */
export function promotePendingKeys(pinned,{signedBy}={}){
 if(!pinned?.pendingThumbprints?.length||!pinned.thumbprints?.includes(signedBy))return structuredClone(pinned);
 const {pendingThumbprints,...rest}=structuredClone(pinned);return {...rest,thumbprints:[...new Set([...rest.thumbprints,...pendingThumbprints])].sort()};
}
const currentSnapshot=(client,keySet)=>({clientId:client.id,redirectUris:sorted(client.redirectUris),authMethod:client.authMethod==='private_key_jwt'?'private_key_jwt':'none',...client.jwksUri?{jwksUri:client.jwksUri,thumbprints:keySet?.thumbprints?[...keySet.thumbprints]:[]}:{},manifest:structuredClone(client.integration.manifest)});

// --- Engine edge operations (unmounted; INTEGRATIONS_ENABLED required) ---
/** `directory` is a ClientDirectory constructed with `integrations:true`; `slots`/`contracts` are trusted pins. */
export function createIntegrationsProvider({directory,slots,contracts={}}={}){
 return Object.freeze({
  manifest:input=>validateIntegrationManifest(input?.manifest,{clientId:input?.clientId,confidential:input?.confidential===true,redirectUris:input?.redirectUris,jwksUri:input?.jwksUri,reserved:directory?.reservedHosts??[],slots,contracts}),
  resolve:input=>{if(!directory?.integrations)fail('integrations_disabled');return directory.resolve(input?.clientId);},
  revalidate:input=>{if(!directory?.integrations)fail('integrations_disabled');return directory.revalidateIntegration(input?.clientId,input?.pinned);},
 });
}
function enabled(config){if(config?.INTEGRATIONS_ENABLED!==true&&config?.INTEGRATIONS_ENABLED!=='true')fail('integrations_disabled');}
export class IntegrationManifest extends AppQuery {static operation='integrations.manifest';static deps=['config','integrations'];fetch({config,integrations}){enabled(config);return integrations.manifest(this.input);}}
export class IntegrationClient extends AppQuery {static operation='integrations.client';static deps=['config','integrations'];fetch({config,integrations}){enabled(config);return integrations.resolve(this.input);}}
export class IntegrationRevalidation extends AppQuery {static operation='integrations.revalidate';static deps=['config','integrations'];fetch({config,integrations}){enabled(config);return integrations.revalidate(this.input);}}
