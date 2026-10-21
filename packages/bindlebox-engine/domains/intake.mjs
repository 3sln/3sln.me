// Intake: per-parent intake configuration (spec §4.3), bridged public intake `deliver` (spec §9), and public-request
// filtering with the spam tiers of architecture §12.1. Filtering runs after custody in `intake.drain`, so no
// receipt, error, header or timing class at admission depends on classification, score, rule or allowlist (§6.7).
//  - very likely spam: p >= T_high under a threshold pinned to the occupant's {model, version, schema}: auto-reject
//    into the bounded, recoverable Rejected view (500 items or 7 days, whichever is smaller);
//  - could be spam: T_low <= p < T_high: `sys:suspected.spam`, deprioritized, no push;
//  - an unpinned model version (calibration mode), no occupant, no consent or no allowance: never auto-reject;
//    deterministic header heuristics can yield at most "could be spam";
//  - allowlisted principals or addresses are never auto-rejected; the skipped reject is recorded in tagHistory.
// The classifier sees only minimized, redacted text and automation hints: no identifiers, recipients or URLs.
import {INTAKE_CONTRACT,verifyProvenance,intakeDigest,sha256,jcs,fromBase64url} from '../../bindlebox-protocol/index.mjs';
import {MailboxAction,MailboxQuery} from '../engine.mjs';
import {fault} from '../faults.mjs';
import {KEYS,BOUNDS,actorOwner,readConfig,chargeUsage} from '../store/mailbox.mjs';
import {chargeBudget} from './receive-budget.mjs';

export const T_HIGH=0.97,T_LOW=0.70,SPAM='sys:suspected.spam',FINAL_SPAM='sys:spam',DEFAULT_ALLOWANCE=200,MAX_CLASSIFIER_CHARS=8000;
const invalid=message=>fault('invalid_input',message,400);
const TAG=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const EMAIL=/^[^\s@<>()]{1,64}@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;
const decoder=new TextDecoder('utf-8',{fatal:false});
export const defaultSettings=()=>({classifierConsent:false,allowance:DEFAULT_ALLOWANCE,usage:{day:0,calls:0},pins:[]});
const modelKey=e=>JSON.stringify([e.model,e.version,e.schema]);
const validPin=p=>evidenceOK(p)&&typeof p.high==='number'&&typeof p.low==='number'&&p.low>0&&p.low<p.high&&p.high<=1;
const evidenceOK=e=>e&&typeof e==='object'&&['model','version','schema'].every(k=>typeof e[k]==='string'&&e[k].length>0&&e[k].length<=128);
// Deterministic redaction before any text leaves the mailbox (architecture §12): link capabilities, URLs, bearer-like
// tokens and one-time codes are replaced; the result is bounded (about 2,000 tokens).
export function minimize(text){
 return String(text).replace(/bindle_(meta|data)=[^\s&#]+/gi,'bindle_$1=[redacted]').replace(/\b(?:https?|web\+bindle):\/\/\S+/gi,'[url]').replace(/\b(?:bearer|token|dpop)\s+\S+/gi,'[credential]').replace(/[A-Za-z0-9_\-+/]{24,}={0,2}/g,'[token]').replace(/\b\d{4,8}\b/g,'[code]').slice(0,MAX_CLASSIFIER_CHARS);
}
const ARROW=['list-unsubscribe','auto-submitted','precedence-bulk','dmarc-fail','sender-shape'];
// Header heuristics (bridged mail only). They never finalize a tag and never reject.
export function heuristics(item){
 if(item.origin!=='channel')return [];const hints=new Set(item.asserted.automation.map(h=>h.toLowerCase()));
 if(item.asserted.dmarc==='fail')hints.add('dmarc-fail');return ARROW.filter(h=>hints.has(h));
}
// Pure tier decision. result: {spam:number, evidence:{model,version,schema}} | null.
export function decideTier({result,pins=[],allowlisted=false,hints=[]}){
 if(result&&typeof result.spam==='number'&&result.spam>=0&&result.spam<=1&&evidenceOK(result.evidence)){
  const pin=pins.find(x=>modelKey(x)===modelKey(result.evidence)),p=result.spam,high=pin?.high??T_HIGH,low=pin?.low??T_LOW;
  const tag={id:SPAM,source:'classifier',probability:p,evidence:{model:result.evidence.model,version:result.evidence.version,schema:result.evidence.schema}};
  if(p>=high&&pin)return allowlisted?{tier:'suspect',tags:[tag],history:[{action:'reject-skipped',reason:'allowlist',rule:'default:reject.spam'}]}:{tier:'reject',tags:[tag,{id:FINAL_SPAM,source:'rule',rule:'default:reject.spam'}],history:[{action:'rejected',rule:'default:reject.spam'}]};
  if(p>=high&&!pin)return {tier:'suspect',tags:[tag],history:[{action:'calibration',reason:'unpinned_model'}]};
  if(p>=low)return {tier:'suspect',tags:[tag],history:[]};
  return {tier:'none',tags:[],history:[]};
 }
 if(hints.length)return {tier:'suspect',tags:[{id:SPAM,source:'heuristic',hints}],history:[]};
 return {tier:'none',tags:[],history:[]};
}

// Intake configuration per parent, compare-and-swap on revision (spec §4.3). Owner-private; never disclosed.
export class IntakeUpdate extends MailboxAction {
 static operation='intake.update';static deps=['contacts'];static changes='contacts-changed';
 async run({contacts}){
  actorOwner(this.actor);const {jti,revision,autoTags=[],optionalTags=[]}=this.input??{};
  if(!Array.isArray(autoTags)||!Array.isArray(optionalTags)||autoTags.some(t=>!TAG.test(t))||optionalTags.some(t=>!t||!TAG.test(t.id)||(t.label!==undefined&&(typeof t.label!=='string'||t.label.length>64))))invalid('Choose valid tags.');
  const ids=[...autoTags,...optionalTags.map(t=>t.id)];if(new Set(ids).size!==ids.length||ids.length>32)invalid('Tags must be distinct, at most 32.');
  return contacts.store.transaction(async tx=>{
   const parent=await tx.get(KEYS.parent(jti));if(!parent)fault('not_found','That link does not exist.',404);
   const current=parent.intake??{revision:0,autoTags:[],optionalTags:[]};if(current.revision!==revision)fault('conflict','The intake changed. Reload and try again.',409);
   const intake={revision:revision+1,autoTags:[...autoTags],optionalTags:optionalTags.map(t=>({id:t.id,...t.label?{label:t.label}:{}}))};
   await tx.put(KEYS.parent(jti),{...parent,intake});return intake;
  });
 }
}
// Owner settings: classifier consent, metered allowance, and explicit threshold pins per model version.
export class IntakeSettings extends MailboxAction {
 static operation='intake.settings';static deps=['receive'];
 async run({receive}){
  actorOwner(this.actor);const input=this.input??{};
  return receive.store.transaction(async tx=>{
   const s={...defaultSettings(),...await tx.get(KEYS.settings)};
   if(input.classifierConsent!==undefined)s.classifierConsent=input.classifierConsent===true;
   if(input.allowance!==undefined){if(!Number.isSafeInteger(input.allowance)||input.allowance<0||input.allowance>100000)invalid('Choose a valid allowance.');s.allowance=input.allowance;}
   if(input.pin!==undefined){const pin=input.pin;if(!evidenceOK(pin))invalid('Choose a model version.');const high=pin.high??T_HIGH,low=pin.low??T_LOW;if(!(low>0&&low<high&&high<=1))invalid('Choose valid thresholds.');s.pins=[...s.pins.filter(x=>modelKey(x)!==modelKey(pin)),{model:pin.model,version:pin.version,schema:pin.schema,high,low}].slice(-16);}
   await tx.put(KEYS.settings,s);return s;
  });
 }
}
const principalOf=p=>{if(!p||typeof p.issuer!=='string'||!/^https:\/\/[^/?#]+$/.test(p.issuer)||typeof p.subject!=='string'||!/^[a-f0-9-]{36}$/.test(p.subject))invalid('Choose a valid principal.');return {issuer:p.issuer,subject:p.subject};};
const emailOf=v=>{if(typeof v!=='string'||v.length>254||!EMAIL.test(v))invalid('Choose a valid address.');return v.toLowerCase();};
// Allowlist of principals and (for bridged mail) addresses. Addresses are convenience matches, never identity.
export class IntakeAllow extends MailboxAction {
 static operation='intake.allow';static deps=['receive','clock'];
 async run({receive,clock}){
  actorOwner(this.actor);const input=this.input??{},allowed=input.allowed!==false;
  const key=input.principal?KEYS.allowPrincipal(principalOf(input.principal)):KEYS.allowEmail(emailOf(input.email));
  return receive.store.transaction(async tx=>{
   if(allowed){if(!await tx.get(key)&&(await tx.list({prefix:'allow/'})).size>=BOUNDS.maxAllow)fault('limit_reached','The allowlist is full.',409);await tx.put(key,{at:clock.now(),...input.principal?{principal:principalOf(input.principal)}:{email:emailOf(input.email)}});}
   else await tx.delete(key);return {allowed};
  });
 }
}

// Public-intake `deliver({message, provenance})` from the authenticated consumer (spec §9, review S-6). The app shell
// authenticates the brokered token and passes the consumer origin; the consumer's published key comes from
// providerLink.consumerKey. Dedup on provenance jti and tx. The disposition never reflects later classification.
export class IntakeDeliver extends MailboxAction {
 static operation='intake.deliver';static deps=['receive','providerLink','clock'];static changes='incoming-changed';
 async run({receive,providerLink,clock}){
  actorOwner(this.actor,['ingress']);const {tx:txId,args,consumer,contract}=this.input??{},now=clock.now(),store=receive.store,config=await readConfig(store);
  if(contract!==INTAKE_CONTRACT||typeof txId!=='string'||!/^[a-f0-9-]{36}$/.test(txId)||typeof consumer!=='string')fault('malformed','The request is malformed.',400);
  let kid;try{kid=JSON.parse(decoder.decode(fromBase64url(String(args?.provenance).split('.')[0]))).kid;}catch{fault('malformed','The request is malformed.',400);}
  let consumerKey;try{consumerKey=await providerLink?.consumerKey?.({consumer,keyId:kid});}catch{fault('recipient_unavailable','The recipient is unavailable.',503);}
  const v=await verifyProvenance(args,{consumerKey,consumer,recipient:config.principal,now});
  const address=(v.asserted.sender.headerFrom.match(/<([^<>]+)>\s*$/)?.[1]??v.asserted.sender.headerFrom).trim().toLowerCase(),domain=EMAIL.exec(address)?.[1]??'unknown';
  const digest=await intakeDigest(args.message),txKey=KEYS.intakeTx(`${encodeURIComponent(consumer)}/${txId}`);
  const id=await sha256(globalThis.crypto,jcs(['bindlebox-intake-v1',consumer,v.jti])),bytes=args.message.parts.reduce((n,x)=>n+fromBase64url(x.dataBase64url).byteLength,0);
  return store.transaction(async tx=>{
   // Dedup answers only after provenance verified, per (consumer, tx) and (consumer, jti), and only for the same
   // message digest; the same tx or jti with other content is a conflict, never a stored disposition (BB2-R4).
   const conflict=()=>fault('operation_conflict','The operation conflicts with an earlier one.',409);
   const again=await tx.get(txKey);if(again){if(again.digest!==digest||again.jti!==v.jti)conflict();return {disposition:again.disposition};}
   const seen=await tx.get(KEYS.intakeJti(consumer,v.jti));if(seen){if(seen.digest!==digest)conflict();await tx.put(txKey,seen);return {disposition:seen.disposition};}
   await tx.put(KEYS.budget,chargeBudget(await tx.get(KEYS.budget),{now,plan:config.plan,bytes,parent:`intake:${v.channel}`,sender:`email:${address}`,request:{sender:`email:${address}`,domain,email:true}}));
   const item={id,origin:'channel',kind:'channel',channel:v.channel,asserted:{...v.asserted,address},verifiedSender:false,subject:'',content:null,message:args.message,bodyRef:{storage:'mailbox'},createdAt:v.receivedAt,receivedAt:now,state:'pending',request:true,tags:[],tagHistory:[],quarantined:false,reviewed:false,notification:null};
   await tx.put(KEYS.item(id),item);await tx.put(KEYS.pending(now,id),{id});
   const record={disposition:'stored-receipt',digest,jti:v.jti,at:now};await tx.put(KEYS.intakeJti(consumer,v.jti),record);await tx.put(txKey,record);
   return {disposition:record.disposition};
  });
 }
}

const channelText=item=>item.message.parts.filter(x=>x.mimeType.startsWith('text/plain')).map(x=>decoder.decode(fromBase64url(x.dataBase64url))).join('\n');
// Drains pending public requests: classification outside any transaction, then one result transaction per item that
// rechecks the item is still pending (a quarantine, rescue or crash in between wins). Re-running is safe.
export class IntakeDrain extends MailboxAction {
 static operation='intake.drain';static deps=['receive','classifier','providerLink','clock'];static changes='incoming-changed';
 async run({receive,classifier,providerLink,clock}){
  actorOwner(this.actor,['system','owner']);const store=receive.store,limit=Math.min(Math.max(Number(this.input?.limit)||32,1),256);
  const queue=[...(await store.list({prefix:'pending/'})).entries()].slice(0,limit),out={processed:0,rejected:0,suspected:0,classified:0};
  for(const [pendingKey,{id}] of queue){
   const now=clock.now(),item=await store.get(KEYS.item(id));if(!item||item.state!=='pending'||item.quarantined){await store.transaction(tx=>tx.delete(pendingKey));continue;}
   const settings={...defaultSettings(),...await store.get(KEYS.settings)},day=Math.floor(now/86400000),used=settings.usage.day===day?settings.usage.calls:0;
   // Address matches count only for DMARC-passing mail, so a spoofed allowlisted address cannot skip rejection (BB2-R6).
   const allowlisted=Boolean(item.origin==='native'?await store.get(KEYS.allowPrincipal(item.author.principal)):item.asserted.dmarc==='pass'&&await store.get(KEYS.allowEmail(item.asserted.address)));
   let result=null,called=false;
   // A classifier call is reserved inside a transaction before it is made, so concurrent drains cannot overspend the
   // owner's allowance (BB2-R8).
   if(classifier&&typeof classifier.decide==='function'&&settings.classifierConsent&&used<settings.allowance)called=await store.transaction(async tx=>{const s={...defaultSettings(),...await tx.get(KEYS.settings)},u=s.usage.day===day?s.usage.calls:0;if(!s.classifierConsent||u>=s.allowance)return false;await tx.put(KEYS.settings,{...s,usage:{day,calls:u+1}});return true;});
   if(called){let body='';if(item.origin==='native'&&item.content?.mimeType?.startsWith('text/plain')){const b=await store.get(KEYS.body(id));if(b)body=decoder.decode(b);}
    const text=minimize(item.origin==='channel'?channelText(item):`${item.subject}\n\n${body}`);
    try{const r=await classifier.decide({text,hints:item.origin==='channel'?item.asserted.automation.slice(0,16):[]});result={spam:r?.labels?.spam,evidence:r?.evidence};}catch{result=null;}
    // A host-published calibration for exactly this model version counts as a pin (architecture §12.1). It comes from
    // the owner's provider (providerLink.calibration), never from the occupant being calibrated, and must pass the same
    // threshold checks as an owner pin (BB2-R5).
    const published=result&&typeof providerLink?.calibration==='function'?await Promise.resolve().then(()=>providerLink.calibration(structuredClone(result.evidence))).catch(()=>null):null;
    if(validPin(published)&&modelKey(published)===modelKey(result.evidence))settings.pins=[...settings.pins,{model:published.model,version:published.version,schema:published.schema,high:published.high,low:published.low}];
   }
   const decision=decideTier({result,pins:settings.pins,allowlisted,hints:result?[]:heuristics(item)});
   await store.transaction(async tx=>{
    const current=await tx.get(KEYS.item(id));await tx.delete(pendingKey);
    if(!current||current.state!=='pending'||current.quarantined)return;
    const next={...current,tags:[...current.tags,...decision.tags.map(t=>({...t,at:now}))],tagHistory:[...current.tagHistory,...decision.history.map(h=>({...h,at:now}))]};
    if(decision.tier==='reject'){Object.assign(next,{state:'rejected',rejectedAt:now,notification:null});await tx.put(KEYS.rejected(now,id),{id});await boundRejected(tx,now);out.rejected++;}
    else Object.assign(next,{state:'request',priority:decision.tier==='suspect'?'low':'normal',notification:decision.tier==='suspect'?'quiet':'push'});
    if(decision.tier==='suspect')out.suspected++;await tx.put(KEYS.item(id),next);
   });
   out.processed++;if(called&&result)out.classified++;
  }
  return out;
 }
}
// The Rejected view keeps the most recent 500 items and nothing older than 7 days; erased items lose body and record.
async function boundRejected(tx,now){
 const rows=[...(await tx.list({prefix:'rejected/'})).entries()];let excess=rows.length-BOUNDS.rejectedItems;
 for(const [key,{id}] of rows){const at=Number(key.split('/')[1]);if(excess>0||at+BOUNDS.rejectedMs<now){const item=await tx.get(KEYS.item(id));await tx.delete(key);await tx.delete(KEYS.item(id));await tx.delete(KEYS.body(id));if(item?.hot>0)await chargeUsage(tx,{bytes:-item.hot,items:-1});
  if(item?.author?.jkt)await tx.delete(`by-jkt/${item.author.jkt}/${id}`);if(item?.bodyRef?.storage==='user')await tx.put(`storage-gc/${encodeURIComponent(item.bodyRef.key)}`,{key:item.bodyRef.key});excess--;}}
}
// Erases expired Rejected items, then deletes queued user-storage bodies (erased items and refused-attempt orphans)
// outside any transaction; a failed delete stays queued (BB2-R1, BB2-R7).
export class IntakeSweep extends MailboxAction {
 static operation='intake.sweep';static deps=['receive','userStorage','clock'];static changes='incoming-changed';
 async run({receive,userStorage,clock}){
  actorOwner(this.actor,['system','owner']);const now=clock.now();await receive.store.transaction(tx=>boundRejected(tx,now));let deleted=0,pending=0;
  for(const [key,{key:object}] of await receive.store.list({prefix:'storage-gc/'})){
   try{if(typeof userStorage?.delete!=='function')throw new Error();await userStorage.delete(object);await receive.store.transaction(tx=>tx.delete(key));deleted++;}catch{pending++;}
  }
  return {deleted,pending};
 }
}
// Rescue turns a rejected item into an ordinary request; optionally allowlists its sender.
export class IntakeRescue extends MailboxAction {
 static operation='intake.rescue';static deps=['receive','clock'];static changes='incoming-changed';
 async run({receive,clock}){
  actorOwner(this.actor);const {id,allow=false}=this.input??{},now=clock.now();if(typeof id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(id))invalid('Choose an item.');
  return receive.store.transaction(async tx=>{
   const item=await tx.get(KEYS.item(id));if(!item||item.state!=='rejected')fault('not_found','That item is not in Rejected.',404);
   await tx.delete(KEYS.rejected(item.rejectedAt,id));
   const next={...item,state:'request',priority:'normal',notification:null,reviewed:true,tags:item.tags.filter(t=>t.id!==FINAL_SPAM),tagHistory:[...item.tagHistory,{action:'rescued',at:now}]};await tx.put(KEYS.item(id),next);
   if(allow===true){const key=item.origin==='native'?KEYS.allowPrincipal(item.author.principal):KEYS.allowEmail(item.asserted.address);await tx.put(key,{at:now,...item.origin==='native'?{principal:{issuer:item.author.principal.issuer,subject:item.author.principal.subject}}:{email:item.asserted.address}});}
   return {id,state:'request'};
  });
 }
}
const view=i=>({id:i.id,origin:i.origin,kind:i.kind,author:i.origin==='native'?{principal:i.author.principal,verified:true}:{asserted:{sender:i.asserted.sender,dmarc:i.asserted.dmarc,automation:i.asserted.automation},verified:false},subject:i.subject,receivedAt:i.receivedAt,state:i.state,priority:i.priority??'normal',tags:i.tags,tagHistory:i.tagHistory,rejectedAt:i.rejectedAt??null});
// "Requests" View: suspected requests sorted to the bottom. Rejected view: not searchable, newest first.
export class IntakeRequests extends MailboxQuery {
 static operation='intake.requests';static deps=['receive'];static refreshOn=['incoming-changed'];
 async fetch({receive}){actorOwner(this.actor);return [...(await receive.store.list({prefix:'item/'})).values()].filter(i=>i.state==='request'&&!i.quarantined).sort((a,b)=>(a.priority==='low')-(b.priority==='low')||b.receivedAt-a.receivedAt).map(view);}
}
export class IntakeRejected extends MailboxQuery {
 static operation='intake.rejected';static deps=['receive'];static refreshOn=['incoming-changed'];
 async fetch({receive}){actorOwner(this.actor);const out=[];for(const [,{id}] of [...(await receive.store.list({prefix:'rejected/'})).entries()].reverse()){const i=await receive.store.get(KEYS.item(id));if(i)out.push(view(i));}return out;}
}
export const INTAKE_OPERATIONS=[IntakeUpdate,IntakeSettings,IntakeAllow,IntakeDeliver,IntakeDrain,IntakeSweep,IntakeRescue,IntakeRequests,IntakeRejected];
