// IA-1: incremental authorization (`grant-more`) and configuration requests (`configure`) as engine operations
// (docs/spec/incremental-authorization.md; host design docs/architecture/consent-experience.md). The pre-owner entry
// store (authorization-entries.mjs) pins client, exact callback, PKCE, state, nonce and the intent members; this module
// is its owner-shard half over the `incremental` provider:
//   admit    creation-time checks against the app's own state (live connection, grant coverage, suggestion schema),
//            the unreviewed-app tier-4 refusal (CX-1), caps and the decline ladder (suppression.mjs), supersession;
//   begin    the provider-page view: delta, already-allowed items, inline setup, pre-declined (suppressed) items;
//   decide   the owner's decision after the arming dwell: grants change only by union of approved delta items,
//            preference values only by the owner's save; suppression, ladder steps and resets commit atomically;
//   abandon  page cancel without a decision: declined / unchanged, caps only;
//   exchange the single-use code → `fragment_outcomes`, plus tokens only when a commit actually added access.
// Rules held here (spec §12): `configure` never calls the grants port; a suggestion is never applied without an owner
// acceptance, sensitive fields never by bulk; apps learn only `declined`/`unchanged` for a suppressed request, through
// the same code, dwell and counters as a decline. Ports (grants, preferences, sessions, consent, pinSchema, clients,
// registrableDomain) are trusted composition data; their contracts are documented on createIncrementalProvider.
// Behind INCREMENTAL_AUTH_ENABLED (default off); nothing here is routed (runtime/incremental-authorization.mjs).
import {AppAction,operations} from '../app/engine.mjs';
import {digest,base64url,boundedString,canonical} from '../messaging/store.mjs';
import {fail,object,https,validateValue} from './schema.mjs';
import {EVENT_BUS_CONTRACT} from './event-buses.mjs';
import {RequestSuppressions,appSite,ladderTarget,suppresses,suppressionKey as key,REQUEST_LIMITS,SuppressionList,SuppressionAdd,SuppressionRemove,SuppressionExport,SuppressionErase,RequestOwnerActed} from './suppression.mjs';
export const INCREMENTAL_INTENTS=Object.freeze(['grant-more','configure']);
export const FRAGMENT_OUTCOMES=Object.freeze(['granted','partial','declined','unsupported','unavailable']);
export const CONFIGURE_RESULTS=Object.freeze(['configured','unchanged']);
/** Entry bounds (§3, §10) and host timing. `minDwellMs` is the server floor under every decision control, including the
 * blocked notice's return, so a return can never be faster than a decline (§9.3). */
export const INCREMENTAL_LIMITS=Object.freeze({fragments:4,fields:8,reason:200,suggestionBytes:2048,entryTtl:600000,codeTtl:60000,minDwellMs:1500,decidingMs:30000,chain:8});
const ID=/^[A-Za-z0-9_-]{43}$/,FIELD=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/,METHOD=/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/,DIGEST=/^(?:sha256-)?[A-Za-z0-9_-]{43}$/,CODE=/^ia1\.[A-Za-z0-9_-]{43}$/;
const copy=value=>structuredClone(value),bare=value=>String(value).replace(/^sha256-/,'');
const generic=()=>fail('invalid_request','The authorization entry could not be created.');
const expired=()=>fail('invalid_request','This request expired. Start again from the application.');
/** Inert app text (§3 `reason`): bounded by code points, no control or line/paragraph separators. Never markup. */
export const plainText=(value,max)=>typeof value==='string'&&value.length>0&&[...value].length<=max&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
const atomicJSON=value=>['string','number','boolean'].includes(typeof value)||Array.isArray(value)&&value.length<=16&&value.every(item=>['string','number','boolean'].includes(typeof item));
const hostOf=value=>{try{return new URL(value).hostname.toLowerCase();}catch{return null;}};
/** Structural validation of the members an incremental entry adds (§3), at creation in the pre-owner store. Anything
 * unexpected is the generic `invalid_request`; owner-state checks happen in `admit`. */
export function incrementalMembers(input){
 if(!object(input)||!INCREMENTAL_INTENTS.includes(input.intent))generic();
 if(input.reason!==undefined&&!plainText(input.reason,INCREMENTAL_LIMITS.reason))generic();
 const reason=input.reason!==undefined?{reason:input.reason}:{};
 if(input.intent==='grant-more'){
  if(input.target!==undefined||input.suggestion!==undefined||!Array.isArray(input.requests)||!input.requests.length||input.requests.length>INCREMENTAL_LIMITS.fragments)generic();
  const seen=new Set(),requests=input.requests.map(r=>{
   // `required` MUST be absent or false (rule 1): incremental requests are always optional.
   if(!object(r)||Object.keys(r).some(k=>!['fragment','required','purpose','fields','methods','digest'].includes(k))||r.required!==undefined&&r.required!==false||!boundedString(r.purpose,1000)||!Array.isArray(r.fields)||!r.fields.length||r.fields.length>32||r.fields.some(f=>typeof f!=='string'||!FIELD.test(f))||new Set(r.fields).size!==r.fields.length||r.digest!==undefined&&(typeof r.digest!=='string'||!DIGEST.test(r.digest))||seen.has(r.fragment))generic();
   try{https(r.fragment);}catch{generic();}seen.add(r.fragment);const methods={};
   if(r.methods!==undefined){if(!object(r.methods)||Object.keys(r.methods).length>32)generic();
    for(const [field,contracts] of Object.entries(r.methods)){if(!r.fields.includes(field)||!object(contracts)||!Object.keys(contracts).length||Object.keys(contracts).length>16)generic();methods[field]={};
     for(const [contract,list] of Object.entries(contracts)){try{https(contract);}catch{generic();}if(!Array.isArray(list)||!list.length||list.length>32||list.some(m=>typeof m!=='string'||!METHOD.test(m))||new Set(list).size!==list.length)generic();methods[field][contract]=[...list];}}}
   return {fragment:r.fragment,purpose:r.purpose,fields:[...r.fields],methods,...r.digest?{digest:r.digest}:{}};
  });
  if(new TextEncoder().encode(canonical(requests)).length>16384)generic();return {requests,...reason};
 }
 // `configure`: no requests, a target of one fragment, and an optional suggestion of atomic values within it.
 if(input.requests!==undefined)generic();const t=input.target;
 if(!object(t)||Object.keys(t).some(k=>!['fragment','digest','fields'].includes(k))||t.digest!==undefined&&(typeof t.digest!=='string'||!DIGEST.test(t.digest)))generic();try{https(t.fragment);}catch{generic();}
 if(t.fields!==undefined&&(!Array.isArray(t.fields)||!t.fields.length||t.fields.length>INCREMENTAL_LIMITS.fields||t.fields.some(f=>typeof f!=='string'||!FIELD.test(f))||new Set(t.fields).size!==t.fields.length))generic();
 let suggestion;
 if(input.suggestion!==undefined){const s=input.suggestion;if(!object(s)||Object.keys(s).length!==1||!object(s.values)||!Object.keys(s.values).length||Object.keys(s.values).length>INCREMENTAL_LIMITS.fields||new TextEncoder().encode(JSON.stringify(s)).length>INCREMENTAL_LIMITS.suggestionBytes)generic();
  for(const [name,value] of Object.entries(s.values))if(!FIELD.test(name)||t.fields&&!t.fields.includes(name)||!atomicJSON(value))generic();suggestion={values:copy(s.values)};}
 return {target:{fragment:t.fragment,...t.digest?{digest:t.digest}:{},...t.fields?{fields:[...t.fields]}:{}},...suggestion?{suggestion}:{},...reason};
}
/** Delta of one request against the current grant (§4.1): only items not already held. */
export function grantDelta(request,current){
 const held=new Set(current?.fields??[]),fields=request.fields.filter(f=>!held.has(f)),methods={};
 for(const [field,contracts] of Object.entries(request.methods??{}))for(const [contract,list] of Object.entries(contracts)){const missing=list.filter(m=>!current?.methods?.[field]?.[contract]?.includes(m));if(missing.length)(methods[field]??={})[contract]=missing;}
 return {fields,methods,empty:!fields.length&&!Object.keys(methods).length};
}
const grantView=grant=>({fields:[...grant?.fields??[]].sort(),methods:copy(grant?.methods??{}),...grant?.resources&&Object.keys(grant.resources).length?{resources:copy(grant.resources)}:{}});
/** Per-fragment outcome (§6.1) from the authoritative grant after the decision. `granted` always lists the complete
 * current grant on that fragment; `declined` carries none. */
export function fragmentOutcome(item,before,after){
 if(item.status)return {fragment:item.fragment,outcome:item.status};
 const missing=grantDelta(item,after),wanted=grantDelta(item,before),size=delta=>delta.fields.length+countMethods(delta.methods);if(missing.empty)return {fragment:item.fragment,outcome:'granted',granted:grantView(after)};
 return size(missing)<size(wanted)?{fragment:item.fragment,outcome:'partial',granted:grantView(after)}:{fragment:item.fragment,outcome:'declined'};
}
const countMethods=methods=>Object.values(methods).reduce((n,contracts)=>n+Object.values(contracts).reduce((m,list)=>m+list.length,0),0);
/** §5.2 rule 5: sensitive fields need an individual acceptance; bulk acceptance never covers them. */
export function fieldSensitivity(field,receivers=[]){
 const reasons=[...field?.sensitive===true?['marked']:[],...field?.type==='url'?['url']:[],...field?.type==='string'&&['email','hostname'].includes(field.format)?[field.format]:[],...receivers.length?['shared']:[]];return {sensitive:reasons.length>0,reasons};
}
/** The host to display beside a suggested URL, email domain or hostname (§5.2). */
export function displayHost(field,value){
 if(Array.isArray(value)){const hosts=value.map(item=>displayHost(field,item));return hosts.some(Boolean)?hosts:null;}if(typeof value!=='string')return null;if(field?.type==='url')return hostOf(value);
 if(field?.format==='email'){const at=value.lastIndexOf('@');return at>0?value.slice(at+1).toLowerCase():null;}return field?.format==='hostname'?value.toLowerCase():null;
}
/** §4.2: a resource whose origin shares a registrable domain with the requesting client is never offered as an
 * occupant inside that client's own flow. Unresolvable origins are omitted (fail closed). */
export function occupantCandidates(candidates,site,registrableDomain){return (candidates??[]).filter(c=>{const host=hostOf(c?.origin);if(!host)return false;const domain=registrableDomain(host);return typeof domain==='string'&&domain!==site;});}
/** CX-1 grant cards for the tier-4 refusal of unreviewed apps (consent-experience §11, Q7). */
export function consentGrants(items){
 const grants=[];
 for(const item of items){if(item.status)continue;for(const contracts of Object.values(item.methods??{}))for(const [contract,methods] of Object.entries(contracts)){
  if(contract===EVENT_BUS_CONTRACT){const modes=new Set(methods.map(m=>m==='publish'?'write':'read'));grants.push({kind:'bus',fragment:item.fragment,mode:modes.size===2?'readwrite':[...modes][0]});}
  else grants.push({kind:'contract',contract,methods:[...methods]});}}
 return grants;
}
/**
 * The `incremental` provider. Ports (all trusted composition, never request input):
 * - `grants`: owner-shard grant store. `connection({subject,clientId})` → truthy for a live connection;
 *   `current({subject,clientId,fragment})` → `{fields,methods,resources?}` or null; `commit({subject,clientId,decision,
 *   changes:[{fragment,digest,fields,methods,resources?}]})` → `{results:[{fragment,before,after}]}`, atomic, union-only
 *   and idempotent per `decision`, reading `before` in the same transaction as the write.
 * - `preferences`: `read({subject,fragment})` → `{revision,values}` or null; `receivers({subject,fragment,field,clientId})`
 *   → other apps/features that currently receive the field; `candidates({subject,fragment,field})` → `[{id,label,origin}]`;
 *   `save({subject,fragment,values,expectedRevision})` → `{revision}` (values only; it never changes grants).
 * - `sessions`: `newest({subject,clientId})` → `{expiresAt|null,authTime}` or null; `issue({subject,clientId,dpopJkt,
 *   notAfter,authTime})` → token response plus internal `family`; `revoke({subject,clientId,family})`.
 * - `consent`: the CX-1 provider (`model`), used only to refuse tier-4 items for unreviewed apps.
 * - `pinSchema(url)` → `{schema,digest}` (immutable pins); errors `unsupported_fragment`/`unavailable` map to outcomes.
 * - `clients(clientId)` → verified client snapshot for owner operations; `registrableDomain(host)` → PSL domain.
 */
export function createIncrementalProvider({store,issuer,crypto=globalThis.crypto,clock=()=>Date.now(),registrableDomain,grants,preferences,sessions,consent,pinSchema,clients,limits={}}={}){
 if(!store?.transaction||typeof issuer!=='string'||!grants||!preferences||!sessions||typeof pinSchema!=='function'||typeof registrableDomain!=='function')throw new TypeError('The incremental provider needs a store, issuer, grants, preferences, sessions, pinSchema and a registrable-domain resolver.');
 const L={...INCREMENTAL_LIMITS,...limits},now=()=>clock(),sup=new RequestSuppressions({clock,crypto,registrableDomain,limits:limits.requests});
 const random=(size=32)=>base64url(crypto.getRandomValues(new Uint8Array(size)));
 const subjectOf=owner=>`${issuer}/entities/${owner}`;
 const validSubject=subject=>typeof subject==='string'&&subject.startsWith(`${issuer}/entities/`)&&subject.length<=issuer.length+46;
 const entryKey=hash=>key('e',hash);
 const ownerReviewUri=`${issuer}/access/apps`;
 /** The fragment and every manifest it supersedes, up to `chain` hops; unpinnable predecessors end the chain. */
 async function chainOf(url,pinned){const chain=[url];let schema=pinned.schema;for(let n=0;n<L.chain;n++){const prior=schema?.supersedes??schema?.slot?.supersedes;if(typeof prior!=='string'||chain.includes(prior))break;try{https(prior);chain.push(prior);schema=(await pinSchema(prior)).schema;}catch{break;}}return chain;}
 const describe=async(url,site,pinned)=>{const chain=await chainOf(url,pinned),host=hostOf(url);return {chain,host,own:registrableDomain(host)===site,root:chain[chain.length-1]};};
 const targets=record=>record.intent==='grant-more'?record.items.filter(i=>!i.status).map(i=>ladderTarget({kind:'grant-more',...i})):record.item.fields.map(field=>ladderTarget({kind:'configure',...record.item,field}));
 const itemFor=(record,item,field)=>({kind:record.intent,chain:item.chain,host:item.host,own:item.own,...field?{field}:{}});
 async function pinned(url,digestValue){const result=await pinSchema(url);if(digestValue!==undefined&&bare(digestValue)!==bare(result.digest))generic();return result;}
 async function admit(input){
  const {entryHash,subject,clientId,client,intent,binding}=input??{};
  if(typeof entryHash!=='string'||!ID.test(entryHash)||!validSubject(subject)||!INCREMENTAL_INTENTS.includes(intent)||client?.id!==clientId||!object(binding)||typeof binding.redirectUri!=='string'||intent==='grant-more'!==(typeof binding.challenge==='string'))generic();
  const site=appSite(client,registrableDomain);if(!await grants.connection({subject,clientId}))generic();
  let record;
  if(intent==='grant-more'){
   const items=[];
   for(const r of input.requests){
    let pin;try{pin=await pinned(r.fragment,r.digest);}catch(error){if(['unsupported_fragment','unavailable'].includes(error?.code)){items.push({fragment:r.fragment,purpose:r.purpose,fields:[...r.fields],methods:copy(r.methods),status:error.code==='unavailable'?'unavailable':'unsupported'});continue;}generic();}
    const fields=pin.schema.fields;for(const f of r.fields)if(!Object.hasOwn(fields,f))generic();
    for(const [field,contracts] of Object.entries(r.methods))for(const contract of Object.keys(contracts))if(fields[field].type!=='resource'||!fields[field].contracts.includes(contract))generic();
    items.push({fragment:r.fragment,purpose:r.purpose,fields:[...r.fields],methods:copy(r.methods),digest:pin.digest,types:Object.fromEntries(r.fields.map(f=>[f,fields[f].type])),...await describe(r.fragment,site,pin)});
   }
   // Unreviewed apps cannot ask for act-as-you, money, identity or public access (CX-1 tier 4). Fails closed.
   const cards=consentGrants(items);if(client.reviewed===false&&cards.length){if(!consent?.model)generic();let model;try{model=await consent.model({app:clientId,grants:cards});}catch{generic();}
    // IA-R1: a method the consent facts cannot classify (no pinned effect/categories) is treated as tier 4.
    if((model?.grants??[]).some(card=>(card.rows??[]).some(row=>row.risk?.missingEffect===true||row.risk?.tier===4)))generic();}
   record={items};
  }else{
   const {target,suggestion}=input;let pin;try{pin=await pinned(target.fragment,target.digest);}catch{generic();}
   const current=await grants.current({subject,clientId,fragment:target.fragment});if(!current?.fields?.length)generic();
   // Only fields the app already holds a grant on (§5.1); the suggestion stays within them and is atomic (§5.2 1–2).
   const opened=target.fields??[...current.fields].sort();if(opened.some(f=>!current.fields.includes(f)||!Object.hasOwn(pin.schema.fields,f)))generic();
   for(const [name,value] of Object.entries(suggestion?.values??{})){const field=pin.schema.fields[name];if(!opened.includes(name)||field.type==='resource')generic();try{validateValue(field,value);}catch{generic();}}
   record={item:{fragment:target.fragment,digest:pin.digest,fields:opened,...await describe(target.fragment,site,pin)},...suggestion?{suggestion:copy(suggestion)}:{}};
  }
  Object.assign(record,{v:1,entryHash,subject,clientId,client:{id:client.id,name:client.name,origin:client.origin,reviewed:client.reviewed!==false},site,intent,binding:{redirectUri:binding.redirectUri,...binding.challenge?{challenge:binding.challenge}:{},...binding.dpopJkt?{dpopJkt:binding.dpopJkt}:{}},...input.reason!==undefined?{reason:input.reason}:{},status:'open',createdAt:now(),expiresAt:now()+L.entryTtl});
  return store.transaction(async tx=>{
   if(await tx.get(entryKey(entryHash)))generic();
   // Caps and the ladder only: suppression is never consulted at creation (§9.3 item 1).
   const {times,until}=await sup.checkCaps(tx,{subject,site}),wait=Math.max(until,await sup.cooling(tx,{subject,site,targets:targets(record)}));
   if(wait>now())throw Object.assign(new Error('Too many requests. Try again later.'),{code:'rate_limited',retryAfter:Math.max(1,Math.ceil((wait-now())/1000)),ownerReviewUri});
   // One open entry per app and account: a newer one supersedes it (no ladder step; §10).
   const open=await tx.get(key('o',subject,site));if(open&&open.entryHash!==entryHash){const old=await tx.get(entryKey(open.entryHash));if(old?.status==='open'){old.status='superseded';await tx.set(entryKey(open.entryHash),old);}}
   await sup.count(tx,{subject,site,times});await tx.set(key('o',subject,site),{entryHash,expiresAt:record.expiresAt});await tx.set(entryKey(entryHash),record);return {admitted:true};
  });
 }
 async function load(entryHash,subject){if(typeof entryHash!=='string'||!ID.test(entryHash))expired();const record=await store.transaction(tx=>tx.get(entryKey(entryHash)));if(!record||record.v!==1||record.expiresAt<=now())expired();if(subject!==undefined&&record.subject!==subject)fail('account_mismatch','Sign in to the account this application is connected to.');return record;}
 /** Live state of an entry: current grants, deltas, values and which items suppression pre-declines. */
 async function state(record){
  const records=await store.transaction(tx=>sup.records(tx,record.subject,record.site)),blocked=item=>records.some(r=>suppresses(r,item));
  if(record.intent==='grant-more'){
   const items=[];
   for(const item of record.items){if(item.status){items.push({...item});continue;}const current=await grants.current({subject:record.subject,clientId:record.clientId,fragment:item.fragment});items.push({...item,current,delta:grantDelta(item,current),suppressed:blocked(itemFor(record,item))});}
   return {items,blocked:items.some(i=>!i.status&&!i.delta.empty)&&items.filter(i=>!i.status&&!i.delta.empty).every(i=>i.suppressed)};
  }
  const item=record.item,pin=await pinSchema(item.fragment),current=await grants.current({subject:record.subject,clientId:record.clientId,fragment:item.fragment}),prefs=await preferences.read({subject:record.subject,fragment:item.fragment});
  const fields=[];
  // A field revoked since creation is no longer opened (§5.1).
  for(const name of item.fields){if(!current?.fields?.includes(name))continue;const field=pin.schema.fields[name],receivers=await preferences.receivers({subject:record.subject,fragment:item.fragment,field:name,clientId:record.clientId})??[];fields.push({name,field,receivers,current:prefs&&Object.hasOwn(prefs.values,name)?prefs.values[name]:null,suppressed:blocked(itemFor(record,item,name)),...fieldSensitivity(field,receivers)});}
  return {fields,revision:prefs?.revision??null,values:copy(prefs?.values??{}),schema:pin.schema,blocked:fields.length>0&&fields.every(f=>f.suppressed)};
 }
 async function candidatesFor(record,fragment,field){return occupantCandidates(await preferences.candidates({subject:record.subject,fragment,field})??[],record.site,registrableDomain);}
 /** Provider-page view (host contract for CX-2; never sent to the app). */
 async function view(record,s){
  const common={intent:record.intent,client:copy(record.client),...record.reason!==undefined?{reason:record.reason}:{},blocked:s.blocked,armAt:record.begunAt+L.minDwellMs,offerAppScope:await store.transaction(tx=>sup.offerAppScope(tx,{subject:record.subject,site:record.site}))};
  if(record.intent==='grant-more'){
   const requests=[];
   for(const i of s.items){
    if(i.status){requests.push({fragment:i.fragment,purpose:i.purpose,status:i.status});continue;}
    const prefs=await preferences.read({subject:record.subject,fragment:i.fragment}),setup=[];
    for(const f of i.delta.fields)if(!prefs||!Object.hasOwn(prefs.values,f))setup.push({field:f,type:i.types[f],...i.types[f]==='resource'?{candidates:await candidatesFor(record,i.fragment,f)}:{}});
    requests.push({fragment:i.fragment,digest:i.digest,purpose:i.purpose,alreadyAllowed:grantView(i.current),delta:{fields:i.delta.fields,methods:i.delta.methods},suppressed:i.suppressed,setup,ownSite:i.own});
   }
   return {...common,requests};
  }
  return {...common,fragment:record.item.fragment,digest:record.item.digest,ownSite:record.item.own,revision:s.revision,fields:await Promise.all(s.fields.map(async f=>{const suggested=record.suggestion&&Object.hasOwn(record.suggestion.values,f.name)&&!f.suppressed?{suggested:copy(record.suggestion.values[f.name]),...displayHost(f.field,record.suggestion.values[f.name])?{suggestedHost:displayHost(f.field,record.suggestion.values[f.name])}:{}}:{};
   return {name:f.name,type:f.field.type,current:f.current,...suggested,sensitive:f.sensitive,sensitivity:f.reasons,receivers:copy(f.receivers),suppressed:f.suppressed,...f.field.type==='resource'?{occupant:f.current===null?{candidates:await candidatesFor(record,record.item.fragment,f.name)}:'settings'}:{}};}))};
 }
 async function mint(tx,record,result){
  if(record.intent==='configure')return {result:result.result};
  const code=`ia1.${random()}`;await tx.set(key('k',await digest(crypto,`incremental-code\0${code}`)),{entryHash:record.entryHash,subject:record.subject,clientId:record.clientId,binding:copy(record.binding),outcomes:copy(result.outcomes),added:result.added===true,expiresAt:now()+L.codeTtl});return {code};
 }
 /** Completes the entry once: the completion is stored, so a retried decision returns the same answer (CX §6.7). */
 async function finish(record,{token,result,decisionHash,effects=async()=>{}}){
  return store.transaction(async tx=>{const current=await tx.get(entryKey(record.entryHash));if(!current||current.status==='completed'||(token===undefined?current.deciding&&(current.deciding.committing||current.deciding.expiresAt>now()):current.deciding?.token!==token))expired();await effects(tx);const completion=await mint(tx,current,result);Object.assign(current,{status:'completed',completion,decisionHash,completedAt:now()});delete current.deciding;await tx.set(entryKey(record.entryHash),current);const open=await tx.get(key('o',current.subject,current.site));if(open?.entryHash===current.entryHash)await tx.delete(key('o',current.subject,current.site));return completion;});
 }
 const declinedResult=(record,s)=>record.intent==='configure'?{result:'unchanged'}:{outcomes:s.items.map(i=>fragmentOutcome(i,i.current,i.current)),added:false};
 async function begin({entryHash,subject}={}){
  const record=await load(entryHash,subject);if(record.status==='superseded'){await store.transaction(async tx=>{const current=await tx.get(entryKey(entryHash));if(current?.status==='superseded'&&!current.begunAt){current.begunAt=now();await tx.set(entryKey(entryHash),current);}});return {view:{superseded:true}};}if(record.status!=='open')expired();
  const s=await state(record);
  // Nothing new: complete without a page, every outcome `granted`, and no tokens (§4.1).
  if(record.intent==='grant-more'&&s.items.every(i=>i.status||i.delta.empty))return {complete:await finish(record,{result:{outcomes:s.items.map(i=>fragmentOutcome(i,i.current,i.current)),added:false}})};
  if(record.intent==='configure'&&!s.fields.length)return {complete:await finish(record,{result:{result:'unchanged'}})};
  const begun=await store.transaction(async tx=>{const current=await tx.get(entryKey(entryHash));if(current?.status!=='open')expired();current.begunAt??=now();await tx.set(entryKey(entryHash),current);return current;});
  return {view:await view(begun,s)};
 }
 const validSuppress=(record,input)=>{
  const normalized=sup.normalize(input);if(normalized.kind&&normalized.kind!==record.intent)fail('invalid_args');
  const fragments=record.intent==='grant-more'?record.items.map(i=>i.fragment):[record.item.fragment];
  if(normalized.fragment&&!fragments.includes(normalized.fragment))fail('invalid_args');if(normalized.field&&(record.intent!=='configure'||!record.item.fields.includes(normalized.field)))fail('invalid_args');return input;
 };
 /** grant-more Allow: validated approvals (subsets of the request; already-held items ignored, never reduced). */
 async function approve(record,s,decision){
  const keys=['fragment','fields','methods','resources'];if(!Array.isArray(decision.approved)||!decision.approved.length||decision.approved.length>record.items.length)fail('invalid_args');
  const seen=new Set(),changes=[],lifted=[];
  for(const selection of decision.approved){
   if(!object(selection)||Object.keys(selection).some(k=>!keys.includes(k))||seen.has(selection.fragment))fail('invalid_args');seen.add(selection.fragment);
   const item=s.items.find(i=>i.fragment===selection.fragment&&!i.status);if(!item)fail('invalid_args');
   const fields=selection.fields??[],methods=selection.methods??{};if(!Array.isArray(fields)||fields.some(f=>!item.fields.includes(f))||new Set(fields).size!==fields.length||!object(methods))fail('invalid_args');
   const held=new Set([...item.current?.fields??[],...fields]),addFields=fields.filter(f=>!item.current?.fields?.includes(f)),addMethods={};
   for(const [field,contracts] of Object.entries(methods)){if(!object(contracts)||!held.has(field))fail('invalid_args');for(const [contract,list] of Object.entries(contracts)){if(!Array.isArray(list)||list.some(m=>!item.methods?.[field]?.[contract]?.includes(m)))fail('invalid_args');const added=list.filter(m=>!item.current?.methods?.[field]?.[contract]?.includes(m));if(added.length)(addMethods[field]??={})[contract]=[...new Set(added)];}}
   // IA-R7: resources only for a field the grant holds none on, chosen from the §4.2-filtered candidates.
   let resources;if(selection.resources!==undefined){if(!object(selection.resources))fail('invalid_args');for(const [field,ids] of Object.entries(selection.resources)){if(!held.has(field)||item.types[field]!=='resource'||!Array.isArray(ids)||!ids.length||ids.length>16||new Set(ids).size!==ids.length||ids.some(id=>!boundedString(id,2048))||(item.current?.resources?.[field]??[]).length)fail('invalid_args');const allowed=(await candidatesFor(record,item.fragment,field)).map(c=>c.id);if(ids.some(id=>!allowed.includes(id)))fail('invalid_args');}resources=copy(selection.resources);}
   if(!addFields.length&&!Object.keys(addMethods).length&&!resources)continue;
   // A pre-declined (suppressed) item is answered only after the owner revealed it; answering lifts the block (§9.3 2).
   if(item.suppressed){if(decision.reveal!==true)fail('invalid_args');lifted.push(itemFor(record,item));}
   changes.push({fragment:item.fragment,digest:item.digest,fields:addFields,methods:addMethods,...resources?{resources}:{}});
  }
  return {changes,lifted};
 }
 /** Inline setup inside grant-more Allow (§4.2): atomic values, or an occupant for an empty slot field from the
  * filtered candidates. Never replaces an occupant, never offers the app's own site, never creates a resource. */
 async function setup(record,s,decision,changes){
  if(decision.setup===undefined)return [];if(!Array.isArray(decision.setup)||decision.setup.length>record.items.length)fail('invalid_args');const saves=[],seen=new Set();
  for(const step of decision.setup){
   if(!object(step)||Object.keys(step).some(k=>!['fragment','values','sharedAcknowledged'].includes(k))||!object(step.values)||seen.has(step.fragment))fail('invalid_args');seen.add(step.fragment);
   const item=s.items.find(i=>i.fragment===step.fragment&&!i.status);if(!item||!changes.some(c=>c.fragment===item.fragment))fail('invalid_args');
   const pin=await pinSchema(item.fragment),prefs=await preferences.read({subject:record.subject,fragment:item.fragment}),values=copy(prefs?.values??{});let shared=false;
   for(const [name,value] of Object.entries(step.values)){
    const field=pin.schema.fields[name];if(!item.fields.includes(name)||!field)fail('invalid_args');try{validateValue(field,value);}catch{fail('invalid_args');}
    const had=prefs&&Object.hasOwn(prefs.values,name),change=changes.find(c=>c.fragment===item.fragment);
    // IA-R9: setup fills only empty fields the owner is approving now; existing values change in Settings or configure.
    if(had||!change.fields.includes(name)&&!Object.hasOwn(change.methods,name))fail('replace_in_settings','Change this in Settings.');
    if(field.type==='resource'){if(had)fail('replace_in_settings','Change this in Settings.');const allowed=(await candidatesFor(record,item.fragment,name)).map(c=>c.id),list=Array.isArray(value)?value:[value];if(list.some(v=>!allowed.includes(object(v)?v.resource:v)))fail('invalid_args');}
    else if(had&&canonical(prefs.values[name])!==canonical(value)&&(await preferences.receivers({subject:record.subject,fragment:item.fragment,field:name,clientId:record.clientId})??[]).length)shared=true;
    values[name]=copy(value);
   }
   if(shared&&step.sharedAcknowledged!==true)fail('shared_confirmation_required','Confirm the change for the other apps first.');
   saves.push({fragment:item.fragment,values,fields:copy(step.values),expectedRevision:prefs?.revision??null});
  }
  return saves;
 }
 /** configure Save: each value is the owner's own edit, or a suggestion the owner took per field (bulk never covers a
  * sensitive field). Values only; the grants port is never called. */
 async function configureChanges(record,s,decision){
  if(!Array.isArray(decision.changes)||decision.changes.length>s.fields.length)fail('invalid_args');const values=copy(s.values),seen=new Set(),lifted=[],changedFields=[];let changed=false,shared=false;
  for(const change of decision.changes){
   if(!object(change)||Object.keys(change).some(k=>!['field','take','via','value'].includes(k))||seen.has(change.field))fail('invalid_args');seen.add(change.field);
   const f=s.fields.find(x=>x.name===change.field);if(!f)fail('invalid_args');if(f.suppressed){if(decision.reveal!==true)fail('invalid_args');lifted.push(itemFor(record,record.item,f.name));}
   let value;
   if(change.take==='suggested'){if(Object.hasOwn(change,'value')||!['field','bulk'].includes(change.via)||!record.suggestion||!Object.hasOwn(record.suggestion.values,f.name))fail('invalid_args');if(change.via==='bulk'&&f.sensitive)fail('individual_acceptance_required','Choose this value on its own row.');value=copy(record.suggestion.values[f.name]);}
   else{if(change.take!==undefined||change.via!==undefined||!Object.hasOwn(change,'value'))fail('invalid_args');try{validateValue(f.field,change.value);}catch{fail('invalid_args');}value=copy(change.value);
    if(f.field.type==='resource'){if(f.current!==null)fail('replace_in_settings','Change this in Settings.');const allowed=(await candidatesFor(record,record.item.fragment,f.name)).map(c=>c.id);if((Array.isArray(value)?value:[value]).some(v=>!allowed.includes(object(v)?v.resource:v)))fail('invalid_args');}}
   if(canonical(value)===canonical(f.current))continue;changed=true;changedFields.push(f.name);if(f.receivers.length)shared=true;values[f.name]=value;
  }
  if(shared&&decision.sharedAcknowledged!==true)fail('shared_confirmation_required','Confirm the change for the other apps first.');
  return {values,changed,lifted,changedFields};
 }
 async function decide({entryHash,subject,decision}={}){
  if(!object(decision))fail('invalid_args');const decisionHash=await digest(crypto,canonical(decision));
  const claim=await store.transaction(async tx=>{
   const record=await tx.get(entryKey(entryHash));if(!record||record.v!==1||record.expiresAt<=now())expired();if(record.subject!==subject)fail('account_mismatch','Sign in to the account this application is connected to.');
   if(record.status==='completed'){if(record.decisionHash===decisionHash)return {done:record.completion};expired();}
   if(!record.begunAt||now()<record.begunAt+L.minDwellMs)fail('decision_not_armed','Wait for the buttons to be ready.');
   if(record.status==='superseded')return {record,superseded:true};
   if(record.deciding&&(record.deciding.expiresAt>now()||record.deciding.committing&&record.deciding.decisionHash!==decisionHash))fail('decision_in_progress','This decision is still being saved.');
   record.deciding={token:random(16),expiresAt:now()+L.decidingMs,decisionHash,...record.deciding?.committing?{committing:true,...record.deciding.plan?{plan:record.deciding.plan}:{}}:{}};await tx.set(entryKey(entryHash),record);return {record,token:record.deciding.token};
  });
  if(claim.done)return claim.done;const {record,token}=claim;
  const keys=record.intent==='grant-more'?['approved','denied','notice','suppress','reveal','setup']:['changes','denied','notice','suppress','reveal','sharedAcknowledged'];
  let committing=false;const release=()=>committing?null:store.transaction(async tx=>{const current=await tx.get(entryKey(entryHash));if(current?.deciding?.token===token){delete current.deciding;await tx.set(entryKey(entryHash),current);}});
  // IA-R8: once a port write may have happened the entry is never reopened; only this decision (idempotent per entry) can finish it.
  // The plan (validated approvals, setup values, the configure values) is journaled with the lease, so a retry of the
  // same decision after a partial failure resumes it instead of re-validating against its own already-saved values.
  const commit=plan=>{committing=true;return store.transaction(async tx=>{const current=await tx.get(entryKey(entryHash));if(current?.deciding?.token!==token||current.status==='completed')expired();current.deciding.committing=true;current.deciding.plan=copy(plan);await tx.set(entryKey(entryHash),current);});};
  const resumed=record.deciding?.plan?copy(record.deciding.plan):null;if(resumed)committing=true;
  const saved=async(fragment,fields)=>{const prefs=await preferences.read({subject,fragment});return !!prefs&&Object.entries(fields).every(([k,v])=>Object.hasOwn(prefs.values,k)&&canonical(prefs.values[k])===canonical(v));};
  const s=await state(record);
  // A superseded page answers declined / unchanged with no ladder step; a stop-asking choice made there still counts.
  // A superseded page answers declined / unchanged. The owner saw it and decided, so an explicit decline or notice
  // return steps the ladder (IA-R5: superseding on purpose cannot erase a decision) and a stop-asking choice counts.
  if(claim.superseded){
   if(Object.keys(decision).some(k=>!['denied','notice','suppress'].includes(k))||decision.denied!==true&&decision.notice!=='return'||decision.denied!==undefined&&decision.notice!==undefined)fail('invalid_args');
   const suppress=decision.suppress!==undefined?validSuppress(record,decision.suppress):undefined,ladder=record.intent==='grant-more'?s.items.filter(i=>!i.status&&!i.delta.empty).map(i=>ladderTarget({kind:'grant-more',...i})):targets(record);
   return finish(record,{decisionHash,result:declinedResult(record,s),effects:async tx=>{if(suppress)await sup.add(tx,{subject,site:record.site,input:suppress,source:'decline'});await sup.step(tx,{subject,site:record.site,targets:ladder});}});
  }
  try{
   if(Object.keys(decision).some(k=>!keys.includes(k)))fail('invalid_args');
   const declining=decision.denied===true,notice=decision.notice==='return',allowing=record.intent==='grant-more'?decision.approved!==undefined:decision.changes!==undefined;
   if([declining,notice,allowing].filter(Boolean).length!==1||decision.denied!==undefined&&decision.denied!==true||decision.notice!==undefined&&decision.notice!=='return'||decision.reveal!==undefined&&decision.reveal!==true)fail('invalid_args');
   if(decision.suppress!==undefined&&allowing||allowing===false&&(decision.reveal!==undefined||decision.setup!==undefined||decision.sharedAcknowledged!==undefined))fail('invalid_args');
   // The blocked notice exists only when every delta-bearing item is suppressed.
   if(notice&&!s.blocked)fail('invalid_args');
   const suppress=decision.suppress!==undefined?validSuppress(record,decision.suppress):undefined,ladder=record.intent==='grant-more'?s.items.filter(i=>!i.status&&!i.delta.empty).map(i=>ladderTarget({kind:'grant-more',...i})):targets(record);
   if(!allowing)return await finish(record,{token,decisionHash,result:declinedResult(record,s),effects:async tx=>{if(suppress)await sup.add(tx,{subject,site:record.site,input:suppress,source:notice?'notice':'decline'});await sup.step(tx,{subject,site:record.site,targets:ladder});}});
   if(record.intent==='configure'){
    let plan=resumed?.configure;
    if(!plan){const {values,changed,lifted,changedFields}=await configureChanges(record,s,decision);
     if(!changed)return await finish(record,{token,decisionHash,result:{result:'unchanged'},effects:async tx=>{await sup.step(tx,{subject,site:record.site,targets:ladder});}});
     plan={values,lifted,changedFields,revision:s.revision};await commit({configure:plan});}
    const {lifted,changedFields}=plan;
    if(!await saved(record.item.fragment,Object.fromEntries(changedFields.map(f=>[f,plan.values[f]]))))await preferences.save({subject,fragment:record.item.fragment,values:plan.values,expectedRevision:plan.revision});
    return await finish(record,{token,decisionHash,result:{result:'configured'},effects:async tx=>{for(const item of lifted)await sup.lift(tx,{subject,site:record.site,item});await sup.reset(tx,{subject,site:record.site,targets:changedFields.map(field=>ladderTarget({kind:'configure',...record.item,field}))});}});
   }
   let plan=resumed?.grant;
   if(!plan){const {changes,lifted}=await approve(record,s,decision),saves=await setup(record,s,decision,changes);plan={changes,lifted,saves};if(saves.length||changes.length)await commit({grant:plan});}
   const {changes,lifted,saves}=plan;
   for(const save of saves)if(!await saved(save.fragment,save.fields))await preferences.save({subject,fragment:save.fragment,values:save.values,expectedRevision:save.expectedRevision});
   const committed=changes.length?await grants.commit({subject,clientId:record.clientId,decision:entryHash,changes}):{results:[]},byFragment=new Map((committed?.results??[]).map(r=>[r.fragment,r]));
   // Tokens only when the authoritative commit changed a grant, never on an unchanged one (§4.4).
   const added=[...byFragment.values()].some(r=>canonical(grantView(r.before))!==canonical(grantView(r.after)));
   const outcomes=s.items.map(i=>{const r=byFragment.get(i.fragment);return fragmentOutcome(i,r?r.before:i.current,r?r.after:i.current);});
   const approvedTargets=s.items.filter((i,n)=>!i.status&&outcomes[n].outcome==='granted'&&!i.delta.empty).map(i=>ladderTarget({kind:'grant-more',...i})),declinedTargets=s.items.filter((i,n)=>!i.status&&!i.delta.empty&&outcomes[n].outcome==='declined').map(i=>ladderTarget({kind:'grant-more',...i}));
   return await finish(record,{token,decisionHash,result:{outcomes,added},effects:async tx=>{for(const item of lifted)await sup.lift(tx,{subject,site:record.site,item});await sup.reset(tx,{subject,site:record.site,targets:approvedTargets});if(declinedTargets.length)await sup.step(tx,{subject,site:record.site,targets:declinedTargets});}});
  }catch(error){await release();throw error;}
 }
 /** Page cancel without a decision (no owner needed): declined / unchanged, counted by caps only (§10). */
 async function abandon({entryHash}={}){const record=await load(entryHash);if(record.status==='completed')expired();const s=await state(record);return finish(record,{result:declinedResult(record,s)});}
 async function exchange(input={}){
  const {clientId,code,redirectUri,codeVerifier,dpopJkt}=input,refuse=()=>fail('invalid_grant','The authorization code is invalid or expired.');
  if(typeof code!=='string'||!CODE.test(code)||typeof codeVerifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier))refuse();const name=key('k',await digest(crypto,`incremental-code\0${code}`));
  // Single redemption: a replay burns the code and revokes whatever it issued (RFC 6749 §4.1.2).
  const status=await store.transaction(async tx=>{const record=await tx.get(name);if(!record||record.expiresAt<=now()&&!record.used)return {};if(record.used){record.reused=true;const revoke=!!record.family&&!record.revoked;if(revoke)record.revoked=true;await tx.set(name,record);return {replayed:revoke?record:null};}
   if(record.clientId!==clientId||record.binding.redirectUri!==redirectUri||await digest(crypto,codeVerifier)!==record.binding.challenge||record.binding.dpopJkt!==undefined&&record.binding.dpopJkt!==dpopJkt)return {};record.used=true;record.expiresAt=now()+L.codeTtl;await tx.set(name,record);return {record};});
  if(status.replayed?.family)await sessions.revoke({subject:status.replayed.subject,clientId:status.replayed.clientId,family:status.replayed.family}).catch(()=>{});if(!status.record)refuse();const record=status.record;
  const response={fragment_outcomes:copy(record.outcomes)};if(!record.added)return response;
  // The new session never outlives the connection's newest session (expiry and auth_time); none live → outcomes only.
  const newest=await sessions.newest({subject:record.subject,clientId:record.clientId});if(!newest)return response;
  const {family,...tokens}=await sessions.issue({subject:record.subject,clientId:record.clientId,...record.binding.dpopJkt?{dpopJkt:record.binding.dpopJkt}:{},notAfter:newest.expiresAt??null,authTime:newest.authTime});
  // The family is revoked exactly once: by the first replay that sees it, or here when a replay came first.
  const reused=await store.transaction(async tx=>{const current=await tx.get(name);if(!current)return true;current.family=family;const replayed=current.reused===true&&!current.revoked;if(replayed)current.revoked=true;await tx.set(name,current);return replayed;});
  if(reused){await sessions.revoke({subject:record.subject,clientId:record.clientId,family}).catch(()=>{});refuse();}
  return {...response,...tokens};
 }
 /** IA-R2 (§9.1 "Login on an existing connection"): the delta of a `login`/`select-account`/`reauthenticate` entry on
  * a connection that already exists is a `grant-more` for caps, the ladder, suppression and the tier-4 refusal, under
  * the same app-site counters and targets, so alternating intents dodges nothing. Called at owner selection (creation
  * knows no subject). Blocked delta items are pre-declined by narrowing the request to access already held, so the
  * app sees exactly a decline (a missing outcome); every request becomes optional (required binds a first connection
  * only). Idempotent per entry and subject. Returns `{first:true}` for a first connection. */
 async function loginDelta({entryHash,subject,clientId,client,requests}={}){
  if(typeof entryHash!=='string'||!ID.test(entryHash)||!validSubject(subject)||client?.id!==clientId||!Array.isArray(requests))generic();
  if(!requests.length)return {first:true};const site=appSite(client,registrableDomain),name=key('L',entryHash,subject),prior=await store.transaction(tx=>tx.get(name));if(prior)return copy(prior.answer);
  // IA-R2a: "existing connection" is per app site, so a fresh sibling client ID (a metadata app can mint one at will)
  // is not a first connection when the site is connected or has any request history with this account.
  const history=await store.transaction(async tx=>{for(const kind of ['s','c','l','d'])if((await tx.list(key(kind,subject,site,''))).length||await tx.get(key(kind,subject,site)))return true;return false;});
  if(!await grants.connection({subject,clientId})&&!await grants.siteConnection?.({subject,site})&&!history)return {first:true};
  const items=[];
  for(const [index,r] of requests.entries()){
   const current=await grants.current({subject,clientId,fragment:r.fragment}),delta=grantDelta({fields:r.fields,methods:r.methods??{}},current);let described=null,tier4=false;
   if(!delta.empty){try{const pin=await pinSchema(r.fragment);described=await describe(r.fragment,site,pin);}catch{described=null;}
    if(client.reviewed===false){const cards=consentGrants([{fragment:r.fragment,methods:delta.methods}]);if(cards.length){try{const model=await consent?.model?.({app:clientId,grants:cards});tier4=!model||(model.grants??[]).some(card=>(card.rows??[]).some(row=>row.risk?.missingEffect===true||row.risk?.tier===4));}catch{tier4=true;}}}}
   items.push({index,request:r,current,delta,described,tier4});
  }
  const additions=items.filter(i=>!i.delta.empty);
  return store.transaction(async tx=>{
   const again=await tx.get(name);if(again)return copy(again.answer);
   let capped=false;
   if(additions.length){const {times,until}=await sup.checkCaps(tx,{subject,site});if(until>now())capped=true;else await sup.count(tx,{subject,site,times});}
   const records=await sup.records(tx,subject,site),out=[],presented=[],predeclined=[],suppressed=[];
   for(const i of items){
    let blocked=false,target=null;
    if(!i.delta.empty){
     // An unpinnable fragment still gets a ladder target by URL, so no fragment escapes counting.
     const d=i.described??{chain:[i.request.fragment],host:hostOf(i.request.fragment),own:false,root:i.request.fragment};target=ladderTarget({kind:'grant-more',...d});
     const isSuppressed=records.some(r=>suppresses(r,{kind:'grant-more',...d})),cooling=await sup.cooling(tx,{subject,site,targets:[target]})>now();
     blocked=capped||i.tier4||cooling||isSuppressed;
     // IA-R2b: a suppressed item steps the ladder on an armed decision exactly as a declined one (§9.3 item 4).
     if(isSuppressed&&!capped&&!cooling&&!i.tier4)suppressed.push(target);
    }
    const r={...copy(i.request),required:false};
    if(blocked){predeclined.push(i.request.fragment);const fields=r.fields.filter(f=>i.current?.fields?.includes(f));if(!fields.length)continue;const methods={};for(const [field,contracts] of Object.entries(r.methods??{}))for(const [contract,list] of Object.entries(contracts)){const held=list.filter(m=>i.current?.methods?.[field]?.[contract]?.includes(m));if(held.length&&fields.includes(field))(methods[field]??={})[contract]=held;}r.fields=fields;r.methods=methods;}
    else if(target)presented.push({fragment:i.request.fragment,target,delta:{fields:i.delta.fields,methods:i.delta.methods}});
    out.push({index:i.index,request:r});
   }
   const answer={first:false,requests:out.map(o=>o.request),keep:out.map(o=>o.index),additions:presented.map(({fragment,delta})=>({fragment,delta})),predeclined};
   await tx.set(name,{answer,subject,clientId,site,presented,suppressed,begunAt:now(),expiresAt:now()+L.entryTtl});return copy(answer);
  });
 }
 /** The owner's decision on such a login: a delta item fully approved resets its target; one with nothing of its
  * delta approved (or a decline/cancel) steps the ladder once, if the page was armed (else caps only). */
 async function loginOutcome({entryHash,subject,approved}={}){
  if(typeof entryHash!=='string'||!ID.test(entryHash))return {counted:0};
  return store.transaction(async tx=>{let counted=0;
   // IA-R2c: only the deciding account. An ownerless cancel counts only when exactly one account selected.
   const rows=await tx.list(key('L',entryHash,'')),mine=subject!==undefined?rows.filter(row=>row.value.subject===subject):rows.length===1?rows:[];
   for(const row of mine){const record=row.value;if(record.done)continue;record.done=true;await tx.set(row.key,record);if(now()<record.begunAt+L.minDwellMs)continue;
    const step=[...record.suppressed??[]],reset=[];
    for(const item of record.presented){const sel=Array.isArray(approved)?approved.find(a=>a?.fragment===item.fragment):null,fields=Array.isArray(sel?.fields)?sel.fields:[],methods=object(sel?.methods)?sel.methods:{};
     const missing=grantDelta({fields:item.delta.fields,methods:item.delta.methods},{fields,methods}),total=item.delta.fields.length+countMethods(item.delta.methods),left=missing.fields.length+countMethods(missing.methods);
     if(left===0)reset.push(item.target);else if(left===total)step.push(item.target);}
    if(reset.length)await sup.reset(tx,{subject:record.subject,site:record.site,targets:reset});if(step.length){await sup.step(tx,{subject:record.subject,site:record.site,targets:step});counted+=step.length;}}
   return {counted};});
 }
 async function cleanup({limit=256}={}){return store.transaction(async tx=>{let removed=0;const at=now();for(const prefix of [key('L',''),key('e',''),key('k',''),key('o',''),key('c',''),key('l',''),key('d','')])for(const row of await tx.list(prefix)){if(removed>=limit)break;if(Number.isFinite(row.value?.expiresAt)&&row.value.expiresAt<=at){await tx.delete(row.key);removed++;}}return {removed};});}
 /** Owner operations for suppression.mjs. The owner names an app by client ID; records are per app site. */
 const siteOf=clientId=>{const client=typeof clients==='function'?clients(clientId):null;if(!client)fail('invalid_args','Unknown application.');return appSite(client,registrableDomain);};
 return Object.freeze({admit,begin,decide,abandon,exchange,cleanup,loginDelta,loginOutcome,
  suppressionList:(owner,input={})=>store.transaction(tx=>sup.list(tx,{subject:subjectOf(owner),...input.clientId!==undefined?{site:siteOf(input.clientId)}:{}})),
  suppressionAdd:(owner,{clientId,...rest}={})=>{const site=siteOf(clientId);return store.transaction(tx=>sup.add(tx,{subject:subjectOf(owner),site,input:rest,source:'settings'}));},
  suppressionRemove:(owner,{clientId,id}={})=>{const site=siteOf(clientId);return store.transaction(tx=>sup.remove(tx,{subject:subjectOf(owner),site,id}));},
  suppressionExport:owner=>store.transaction(tx=>sup.export(tx,{subject:subjectOf(owner)})),
  suppressionErase:owner=>store.transaction(tx=>sup.erase(tx,{subject:subjectOf(owner)})),
  async ownerActed(owner,{clientId,kind,fragment,fields}={}){
   const site=siteOf(clientId);if(!['grant-more','configure'].includes(kind))fail('invalid_args');let pin;try{pin=await pinSchema(fragment);}catch{fail('invalid_args');}const d=await describe(fragment,site,pin);
   const list=kind==='configure'?(Array.isArray(fields)&&fields.length?fields:Object.keys(pin.schema.fields)).map(field=>ladderTarget({kind,...d,field})):[ladderTarget({kind,...d})];
   return store.transaction(async tx=>{await sup.reset(tx,{subject:subjectOf(owner),site,targets:list});return {reset:list.length};});
  }});
}
const enabled=config=>{if(config?.INCREMENTAL_AUTH_ENABLED!==true&&config?.INCREMENTAL_AUTH_ENABLED!=='true')fail('not_found','Not found.');};
/** System operations called by the entry store and the token route (runtime/incremental-authorization.mjs). */
export class IncrementalAdmit extends AppAction {static operation='federation.incremental.admit';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.admit(this.input);}}
export class IncrementalBegin extends AppAction {static operation='federation.incremental.begin';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.begin(this.input);}}
export class IncrementalDecide extends AppAction {static operation='federation.incremental.decide';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.decide(this.input);}}
export class IncrementalAbandon extends AppAction {static operation='federation.incremental.abandon';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.abandon(this.input);}}
export class IncrementalExchange extends AppAction {static operation='federation.incremental.exchange';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.exchange(this.input);}}
export class IncrementalLoginDelta extends AppAction {static operation='federation.incremental.login-delta';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.loginDelta(this.input);}}
export class IncrementalLoginOutcome extends AppAction {static operation='federation.incremental.login-outcome';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.loginOutcome(this.input);}}
export class IncrementalCleanup extends AppAction {static operation='federation.incremental.cleanup';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.cleanup(this.input);}}
export {REQUEST_LIMITS};
/** Every IA-1/IA-2 engine operation (a local registry; not account-routed). */
export const INCREMENTAL_OPERATIONS=operations(IncrementalAdmit,IncrementalBegin,IncrementalDecide,IncrementalAbandon,IncrementalExchange,IncrementalLoginDelta,IncrementalLoginOutcome,IncrementalCleanup,SuppressionList,SuppressionAdd,SuppressionRemove,SuppressionExport,SuppressionErase,RequestOwnerActed);
