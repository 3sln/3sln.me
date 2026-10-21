// BRIDGE (implementation-roadmap Wave 7; public-email-bridge.md; messaging-app.md §13; bindlebox.md §9): the provider's
// public email bridge as ngin Actions/Queries over injected providers. The same operations run at every placement:
// the Worker email handler and EmailBridgeObject, the Node adapter and the tests; only the provider set differs.
//
// Placement:
//  edge   bridge.receive: flags, envelope, size, the global ingress budget and the recipient directory BEFORE the
//         stream is read, then one bounded parse, then the owner placement's admit. Every refusal is the same
//         generic SMTP refusal, whatever the reason (unknown, disabled, unpaid, malformed, oversized, over quota).
//  owner  bridge.admit / drain / reply-outcome / accepted / settings / configure / status, inside the owner's
//         single-writer store; bridge.suppress on the sender stores.
//
// Invariants (each has a test in tests/email-bridge*.test.mjs):
//  - SPF/DKIM/DMARC come only from the configured receiving authserv-id and are recorded as the provider's
//    observations (provenance), never as authorship; the occupant shows them as assertions (spec §9).
//  - The single invariant auto-reply is decided at acceptance from the sender gates alone: never for refused mail,
//    never for automated, list, bounce, code or loop mail, never to a sender whose envelope and header From disagree
//    (no backscatter to forged senders), and its bytes never depend on occupancy, delivery, disposition or app state.
//    The owner may switch it off. It is rate limited per recipient, per sender domain and per sender (30-day
//    cooldown) under a global budget, after a suppression-list check.
//  - Delivery goes only to the live public-message-intake occupant through the brokered resource port; with no
//    occupant, the flags off or the owner's switch off, mail stays held (fail closed) and expires visibly. An
//    indeterminate attempt at a removed occupant is reported unknown and never re-sent to the new one.
//  - The acceptance follow-up is sent at most once per accepted item, only after the recipient accepts, only to a
//    sender that passed the reply gates and was DMARC-validated (platform reply or trusted result), under its own caps.
import {Engine,Provider,Action,Query} from '../../vendor/ngin/index.js';
import {INTAKE_CONTRACT,INTAKE_SLOT,intakeDigest,jcs,sha256,decodedLength} from './wire.mjs';
import {mailbox,parseEmail,ingressFingerprint,BridgeMimeError,MIME_LIMITS} from './mime.mjs';
import {buildReply,buildFollowup} from './reply.mjs';

export {INTAKE_SLOT};
export const BRIDGE_REF='email-bridge';
export const BRIDGE_LIMITS=Object.freeze({
 ingressPerHour:20000,sourcePerHour:2000,ownerDaily:200,ownerDailyBytes:16*1048576,queueItems:500,queueBytes:32*1048576,
 // The occupant bounds receivedAt to its last 7 days (spec §9), so mail is held 7 days less an hour, not §13's 30.
 holdMs:7*86400000-3600000,dedupMs:8*86400000,ledgerMs:30*86400000,statusMs:30*86400000,
 senderIntakeDaily:20,recipientRepliesDaily:20,domainRepliesDaily:50,senderCooldownMs:30*86400000,globalRepliesDaily:2000,
 recipientFollowupsDaily:20,senderFollowupsDaily:3,globalFollowupsDaily:1000,
 drainBatch:16,idleMs:15*60000,backoffMs:60000,maxBackoffMs:6*3600000,prune:32,statusItems:100,
});
const L=BRIDGE_LIMITS,DAY=86400000;
export const GENERIC_REFUSAL='Message not accepted.';
const RESERVED=new Set(['postmaster','abuse','hostmaster','webmaster','mailer-daemon','noreply','no-reply','root','admin','security','support','system','sys']);
const TERMINAL=[400,409,413,415];

export class BridgeFault extends Error{constructor(code,message=code,status){super(message);this.name='BridgeFault';this.code=code;if(status!==undefined)this.status=status;}}
const fault=(code,message,status)=>{throw new BridgeFault(code,message,status);};
const flag=v=>v===true||v==='true';
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const pad=n=>String(n).padStart(16,'0');
const hex=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
export const senderKey=address=>hex(`email-bridge-sender-v1\0${address.toLowerCase()}`);
const domainKey=address=>hex(`email-bridge-domain-v1\0${address.slice(address.lastIndexOf('@')+1).toLowerCase()}`);

/** Effective deployment switch: EMAIL_BRIDGE_ENABLED and BINDLEBOX_ENABLED, an exact HTTPS origin and a receiving domain. */
export function bridgeConfig(config={}){
 let origin=null;try{const u=new URL(config.APP_ORIGIN);if(u.protocol==='https:'&&u.origin===config.APP_ORIGIN)origin=u.origin;}catch{}
 const domain=String(config.EMAIL_BRIDGE_DOMAIN??(origin?new URL(origin).hostname:'')).toLowerCase();
 const enabled=flag(config.EMAIL_BRIDGE_ENABLED)&&flag(config.BINDLEBOX_ENABLED)&&!!origin&&/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain);
 return {enabled,origin,domain,link:origin?`${origin}/`:null,// A configured authserv-id is honoured only with the operator's attestation that the receiving MTA removes
 // sender-supplied Authentication-Results bearing it (RFC 8601 §5; review EB-1). Cloudflare: leave both unset.
 authservId:flag(config.EMAIL_BRIDGE_AUTHSERV_STRIPS)&&typeof config.EMAIL_BRIDGE_AUTHSERV_ID==='string'&&/^[A-Za-z0-9.-]{1,253}$/.test(config.EMAIL_BRIDGE_AUTHSERV_ID)?config.EMAIL_BRIDGE_AUTHSERV_ID:null};
}
// RFC 9562 UUIDv5 (URL namespace) over (feature ref, contract, entity, ingress fingerprint), as spec §9 derives `tx`.
const NAMESPACE=Uint8Array.from('6ba7b8119dad11d180b400c04fd430c8'.match(/../g),h=>parseInt(h,16));
export async function deliveryTx(owner,fingerprint){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-1',new Uint8Array([...NAMESPACE,...new TextEncoder().encode(`${BRIDGE_REF}|${INTAKE_CONTRACT}|${owner}|${fingerprint}`)]))).slice(0,16);
 bytes[6]=bytes[6]&15|80;bytes[8]=bytes[8]&63|128;const h=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
 return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// ---- Catalogue and composition ----
const row=(placement,summary)=>Object.freeze({placement,summary});
export const PROVIDERS=Object.freeze({
 config:row('both','Frozen deployment configuration; EMAIL_BRIDGE_ENABLED and BINDLEBOX_ENABLED decide everything.'),
 clock:row('both','{now()} in epoch milliseconds.'),
 random:row('both','{uuid()}.'),
 audit:row('both','{record(entry)}; never records input.'),
 directory:row('edge','{resolve(handle)} -> {owner, principal, active, entitled} | null: the public handle directory and current paid entitlement.'),
 limiter:row('edge','{consume(key,{limit,windowMs})} -> boolean: fleet-wide fixed windows (ingress budget).'),
 owners:row('edge','{admit(owner,input)}: the owner placement (EmailBridgeObject, Node store, test engine).'),
 stores:row('owner','{for(owner)} -> transactional store {get,put,delete,list,transaction}.'),
 senders:row('owner','{consume(key,{limit,windowMs}), refund(key), suppressed(key), suppress(key,{until})}: sender-keyed reply budgets and the suppression list.'),
 occupant:row('owner','{seat(owner)} -> {id,resource}|null and {deliver(owner,{seat,tx,args})} -> {disposition}: the public-message-intake occupant through the brokered resource.'),
 signer:row('owner','{sign(claims)} -> compact bindle-intake-provenance+jwt JWS under the bridge key.'),
 mail:row('owner','{send({to,subject,text,headers})} -> {messageId}: the follow-up transport (fixed sender role).'),
});
const auditTrail=Object.freeze({deps:['audit'],
 leave({audit},ctx){if(ctx.action)return audit.record({operation:ctx.action.constructor.operation,outcome:'ok'});},
 error({audit},ctx){if(ctx.action)return audit.record({operation:ctx.action.constructor.operation,outcome:'error',...ctx.error?.code?{code:String(ctx.error.code)}:{}});},
 abort({audit},ctx){if(ctx.action)return audit.record({operation:ctx.action.constructor.operation,outcome:'abort'});}});
export function createBridgeEngine({providers={},interceptors=[]}={}){
 for(const name of Object.keys(providers))if(!Object.hasOwn(PROVIDERS,name))throw new TypeError(`Uncatalogued bridge provider: ${name}`);
 for(const name of ['config','clock','random','audit'])if(providers[name]==null)throw new TypeError(`The bridge engine requires a ${name} provider`);
 return new Engine({providers:Object.fromEntries(Object.entries(providers).filter(([,v])=>v!=null).map(([name,value])=>[name,typeof value==='function'&&value.prototype instanceof Provider?value:Provider.fromSingleton(value)])),interceptors:[auditTrail,...interceptors]});
}
export async function perform(engine,action){const feed=engine.dispatch(action);let result;feed.addEventListener('result',e=>{result=e;},{once:true});await feed.next('complete');if(!result)throw new Error(`${action.constructor.name} completed without a result`);return result.detail;}
export const read=(engine,query)=>engine.query(query).peek();
export const operate=(engine,op)=>op instanceof Query?read(engine,op):perform(engine,op);
class BridgeAction extends Action{constructor({actor,input}={}){super();this.actor=actor;this.input=input;}async execute(resources,context){context.dispatchFeed.dispatchEvent(new CustomEvent('result',{detail:await this.run(resources,context)}));}}
class BridgeQuery extends Query{constructor({actor,input}={}){super();this.actor=actor;this.input=input;}async boot(resources,{notify}){notify(await this.fetch(resources));}}
const ownerOf=(actor,kinds=['system'])=>{if(!kinds.includes(actor?.kind)||typeof actor.owner!=='string'||!/^[a-f0-9-]{36}$/.test(actor.owner))fault('unauthorized','Sign in to continue.',401);return actor.owner;};
const live=config=>{const c=bridgeConfig(config);if(!c.enabled)fault('not_found','Not found.',404);return c;};

// ---- Owner store rows ----
export const defaultSettings=()=>({enabled:false,autoReply:true,revision:0});
const settingsOf=v=>({...defaultSettings(),...plain(v)?v:{}});
const windowed=(v,now,ms=DAY)=>plain(v)&&v.start+ms>now?v:{start:now,count:0,bytes:0};
const metaOf=v=>({queued:0,queuedBytes:0,seq:0,...plain(v)?v:{}});
const K={settings:'settings',meta:'meta',budget:'budget/intake',replies:'budget/replies',followups:'budget/followups',item:id=>`item/${id}`,queue:(at,seq)=>`queue/${pad(at)}/${pad(seq)}`,fp:fp=>`fp/${fp}`,mid:h=>`mid/${h}`,ledger:jti=>`reply/${jti}`,exp:(until,key)=>`exp/${pad(until)}/${key}`};
async function expire(tx,key,until){await tx.put(K.exp(until,key),key);}
async function prune(tx,now){
 let n=0;for(const [k,target] of await tx.list({prefix:'exp/',limit:L.prune})){if(Number(k.slice(4,20))>now)break;const row=await tx.get(target);
  if(row&&!(target.startsWith('item/')&&row.state==='queued')&&!(Number.isSafeInteger(row.until)&&row.until>now))await tx.delete(target);await tx.delete(k);n++;}
 return n;
}

// ---- Edge: SMTP admission ----
/** input: {envelope:{from,to}, rawSize, read(limit) -> Uint8Array, dmarcGate:'platform'|'trusted'|'unavailable'}. Returns
 * {action:'reject', reason: GENERIC_REFUSAL} or {action:'accept', owner, reply: {from,to,raw,jti,owner}|null}
 * (`owner` is for the adapter's drain trigger only; it never reaches the sender). */
export class BridgeReceive extends BridgeAction{
 static operation='bridge.receive';static deps=['config','directory','limiter','owners'];
 async run({config,directory,limiter,owners}){
  const reject={action:'reject',reason:GENERIC_REFUSAL},c=bridgeConfig(config),v=this.input??{};
  if(this.actor?.kind!=='edge'||!c.enabled)return reject;
  const to=typeof v.envelope?.to==='string'?mailbox(v.envelope.to):null,rawFrom=v.envelope?.from;
  if(!to)return reject;const local=to.slice(0,to.lastIndexOf('@')).toLowerCase(),domain=to.slice(to.lastIndexOf('@')+1);
  // Exact envelope recipient only; no plus-addressing, no reserved system names, never header To/Cc/Delivered-To.
  if(domain!==c.domain||RESERVED.has(local)||!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/.test(local))return reject;
  const envelopeFrom=rawFrom===''||rawFrom==='<>'||rawFrom==null?'':mailbox(String(rawFrom));if(envelopeFrom===null)return reject;
  if(!Number.isSafeInteger(v.rawSize)||v.rawSize<0||v.rawSize>MIME_LIMITS.rawBytes||typeof v.read!=='function')return reject;
  // Per-source bucket before any directory work (review EB-3 re-review): the envelope sender's domain hashed into 256
  // buckets, so lookups for nonexistent handles are throttled without allocating a key per attacker domain.
  const bucket=parseInt((await hex(`email-bridge-src-v1\0${envelopeFrom?envelopeFrom.slice(envelopeFrom.lastIndexOf('@')+1):'<>'}`)).slice(0,2),16);
  if(!await limiter.consume(`email-bridge/source-v1/${bucket}`,{limit:L.sourcePerHour,windowMs:3600000}))return reject;
  let target;try{target=await directory.resolve(local);}catch{return reject;}
  if(!target||target.active!==true||target.entitled!==true||!/^[a-f0-9-]{36}$/.test(target.owner??''))return reject;
  // Charged only for eligible recipients (review EB-3), so mail to nonexistent handles cannot exhaust bridge intake.
  if(!await limiter.consume('email-bridge/ingress-v1',{limit:L.ingressPerHour,windowMs:3600000}))return reject;
  let parsed;try{parsed=await parseEmail(await v.read(MIME_LIMITS.rawBytes),{envelopeFrom,authservId:c.authservId});}catch(error){if(error instanceof BridgeMimeError)return reject;throw error;}
  const admitted=await owners.admit(target.owner,{envelope:{from:envelopeFrom,to},principal:target.principal,parsed,dmarcGate:['platform','trusted'].includes(v.dmarcGate)?v.dmarcGate:'unavailable'});
  return admitted?.accepted===true?{action:'accept',owner:target.owner,reply:admitted.reply?{...admitted.reply,owner:target.owner}:null}:reject;
 }
}

// ---- Owner: admit into the holding queue and decide the reply ----
export class BridgeAdmit extends BridgeAction{
 static operation='bridge.admit';static deps=['config','clock','random','stores','senders'];
 async run({config,clock,random,stores,senders}){
  const owner=ownerOf(this.actor),c=bridgeConfig(config);if(!c.enabled)return {accepted:false};
  const {envelope,principal,parsed,dmarcGate}=this.input??{},now=clock.now(),store=stores.for(owner);
  const {message,from,replyTo,messageId,hints,auth,headerFrom,multipleReplyTo}=parsed,envelopeFrom=envelope.from;
  const digest=await intakeDigest(message),fp=await ingressFingerprint({owner,envelopeFrom,messageId,digest}),tx=await deliveryTx(owner,fp);
  const bytes=message.parts.reduce((n,p)=>n+decodedLength(p.dataBase64url),0),jti=random.uuid();
  const midKey=messageId?K.mid(await hex(`${envelopeFrom.toLowerCase()}\0${messageId}`)):null,key=envelopeFrom?await senderKey(envelopeFrom):'null',senderBudget=`budget/sender/${key}`;
  // Reply-safe: a non-null sender whose envelope, single header From and any Reply-To are the same mailbox, with no
  // automation hint at all. This is what keeps replies off forged and third-party addresses (no backscatter).
  const same=a=>a&&a.toLowerCase()===envelopeFrom.toLowerCase();
  const eligible=!!envelopeFrom&&same(from.address)&&(!replyTo||same(replyTo.address))&&!multipleReplyTo&&hints.length===0;
  // 'platform': the per-event reply() enforces DMARC itself (Cloudflare); 'trusted': only a trusted dmarc=pass; else no reply.
  const dmarcOK=dmarcGate==='platform'||dmarcGate==='trusted'&&auth.dmarc==='pass';
  const claims={bindle:'intake-provenance',v:1,iss:c.origin,channel:'email',recipient:principal,receivedAt:now,sender:{envelopeFrom,headerFrom,...replyTo?{replyTo:replyTo.address}:{}},dmarc:auth.dmarc,automation:hints,ingressFingerprint:fp,normalizedDigest:digest,jti};
  const out=await store.transaction(async t=>{
   const s=settingsOf(await t.get(K.settings));if(!s.enabled)return {accepted:false};
   const seen=await t.get(K.fp(fp));if(seen&&seen.until>now)return {accepted:true,duplicate:true};
   if(midKey){const m=await t.get(midKey);if(m&&m.until>now&&m.digest!==digest)return {accepted:false};}// a reused Message-ID with other content is a conflict
   const budget=windowed(await t.get(K.budget),now),meta=metaOf(await t.get(K.meta)),perSender=windowed(await t.get(senderBudget),now);
   // One envelope sender cannot fill a recipient's day (review EB-3); the owner's totals bound everything else.
   if(budget.count+1>L.ownerDaily||budget.bytes+bytes>L.ownerDailyBytes||perSender.count+1>L.senderIntakeDaily||meta.queued+1>L.queueItems||meta.queuedBytes+bytes>L.queueBytes)return {accepted:false};
   await t.put(senderBudget,{start:perSender.start,count:perSender.count+1,until:perSender.start+DAY});if(!perSender.count)await expire(t,senderBudget,perSender.start+DAY);
   const item={id:fp,tx,jti,receivedAt:now,expiresAt:now+L.holdMs,bytes,message,claims,auth:{...auth},state:'queued',attempts:0,nextAt:now};
   await t.put(K.item(fp),item);await t.put(K.queue(now,meta.seq+1),fp);
   await t.put(K.fp(fp),{until:now+L.dedupMs});await expire(t,K.fp(fp),now+L.dedupMs);
   if(midKey){await t.put(midKey,{digest,until:now+L.dedupMs});await expire(t,midKey,now+L.dedupMs);}
   await t.put(K.budget,{...budget,count:budget.count+1,bytes:budget.bytes+bytes});await t.put(K.meta,{queued:meta.queued+1,queuedBytes:meta.queuedBytes+bytes,seq:meta.seq+1});
   // The recipient cap is only read here and charged once every sender gate passed (review EB-2).
   const reply=eligible&&dmarcOK&&s.autoReply&&windowed(await t.get(K.replies),now).count<L.recipientRepliesDaily;
   await t.put(K.ledger(jti),{sender:envelopeFrom,eligible,gate:dmarcGate,dmarc:auth.dmarc,initial:reply?'pending':'none',followup:null,item:fp,until:now+L.ledgerMs});await expire(t,K.ledger(jti),now+L.ledgerMs);
   await prune(t,now);return {accepted:true,reply};
  });
  if(!out.accepted||!out.reply)return {accepted:out.accepted,reply:null};
  // Sender-side gates after the owner commit, narrowest first (review EB-2): suppression (read-only), the sender's
  // 30-day cooldown, then the domain and global budgets, which are charged only for a sender that is otherwise due a
  // reply and refunded if the reply is not sent. Allocated sender keys are bounded by accepted intake. A failing
  // sender store costs the reply, never the acceptance (review EB-7).
  let reason=null,cooled=false;const charged=[];
  try{
   if(await senders.suppressed(key))reason='suppressed';
   else if(!(cooled=await senders.consume(`sender/${key}`,{limit:1,windowMs:L.senderCooldownMs})))reason='cooldown';
   else{const domain=`domain/${await domainKey(envelopeFrom)}`,d=await senders.consume(domain,{limit:L.domainRepliesDaily,windowMs:DAY});
    if(!d)reason='domain';else{charged.push({key:domain,start:d});const g=await senders.consume('global/replies-v1',{limit:L.globalRepliesDaily,windowMs:DAY});if(!g)reason='global';else charged.push({key:'global/replies-v1',start:g});}}
  }catch{reason='error';}
  // Claimed before sending, with the recipient cap charged in the same commit: a crash after this point leaves
  // `claimed` and the reply is never sent again.
  const claimed=await store.transaction(async t=>{const l=await t.get(K.ledger(jti));if(!l)return 'missing';let why=reason;
   if(!why){const r=windowed(await t.get(K.replies),now);if(r.count>=L.recipientRepliesDaily)why='recipient';else await t.put(K.replies,{...r,count:r.count+1});}
   await t.put(K.ledger(jti),{...l,initial:why?`suppressed:${why}`:'claimed',charged:why?[]:charged,repliesWindow:windowed(await t.get(K.replies),now).start});return why;});
  // A budget miss gives the sender's cooldown back too, so exhaustion elsewhere never costs a later legitimate reply.
  if(claimed){await refund(senders,cooled?[...charged,{key:`sender/${key}`,start:cooled}]:charged);return {accepted:true,reply:null};}
  return {accepted:true,reply:{from:envelope.to,to:envelopeFrom,jti,raw:buildReply({from:envelope.to,to:envelopeFrom,link:c.link,now,messageId:(await hex(`email-bridge-reply-v1\0${fp}`)).slice(0,32)})}};
 }
}
/** The adapter reports what the per-event `reply()` did. Nothing is ever retried: unknown stays unknown. */
export class BridgeReplyOutcome extends BridgeAction{
 static operation='bridge.reply-outcome';static deps=['config','stores','senders'];
 async run({config,stores,senders}){
  const owner=ownerOf(this.actor);live(config);const {jti,outcome,code}=this.input??{};
  if(typeof jti!=='string'||!['sent','failed','unknown'].includes(outcome))fault('invalid_input','Invalid reply outcome.',400);
  const l=await stores.for(owner).transaction(async t=>{const l=await t.get(K.ledger(jti));if(!l||l.initial!=='claimed')return null;await t.put(K.ledger(jti),{...l,initial:outcome});
   // A reply the platform refused (e.g. DMARC on a forged sender) gives back the recipient, domain and global units.
   if(outcome==='failed'){const r=await t.get(K.replies);if(plain(r)&&r.start===l.repliesWindow&&r.count>0)await t.put(K.replies,{...r,count:r.count-1});}return l;});
  if(l&&outcome==='failed'){try{await refund(senders,l.charged??[]);if(['E_RECIPIENT_SUPPRESSED','E_RECIPIENT_NOT_ALLOWED'].includes(code))await senders.suppress(await senderKey(l.sender),{until:null});}catch{}}
  return {recorded:!!l};
 }
}

// ---- Owner: deliver held mail to the public-message-intake occupant ----
// Refunds name the window they were charged in, so a refund across a rollover never lowers the new window.
const refund=async(senders,charges)=>{for(const c of charges){try{if(c&&typeof c.key==='string')await senders.refund?.(c.key,{start:c.start});}catch{}}};
const backoff=attempts=>Math.min(L.maxBackoffMs,L.backoffMs*2**Math.min(attempts,16));
export class BridgeDrain extends BridgeAction{
 static operation='bridge.drain';static deps=['config','clock','stores','occupant','signer'];
 async run({config,clock,stores,occupant,signer}){
  const owner=ownerOf(this.actor),c=bridgeConfig(config),store=stores.for(owner);if(!c.enabled)return {delivered:0,held:true,reason:'disabled'};
  const s=settingsOf(await store.get(K.settings));if(!s.enabled)return {delivered:0,held:true,reason:'paused'};
  const rows=[...(await store.list({prefix:'queue/',limit:L.drainBatch})).entries()];let seat=null;
  if(rows.length){try{const found=await occupant?.seat(owner);seat=found&&typeof found.id==='string'&&typeof found.resource==='string'?found:null;}catch{seat=null;}}
  const finish=(t,item,queueKey,state,extra={})=>(async()=>{const now=clock.now(),meta=metaOf(await t.get(K.meta));await t.delete(queueKey);
   await t.put(K.item(item.id),{id:item.id,jti:item.jti,receivedAt:item.receivedAt,claims:{sender:item.claims.sender,dmarc:item.claims.dmarc,automation:item.claims.automation},auth:item.auth,state,finishedAt:now,attempts:item.attempts,...extra,until:now+L.statusMs});
   await expire(t,K.item(item.id),now+L.statusMs);await t.put(K.meta,{...meta,queued:Math.max(0,meta.queued-1),queuedBytes:Math.max(0,meta.queuedBytes-item.bytes)});})();
  const update=(id,queueKey,change)=>store.transaction(async t=>{const item=await t.get(K.item(id));if(!item||item.state!=='queued'){await t.delete(queueKey);return null;}return change(t,item);});
  let delivered=0,next=null;const later=at=>{next=next===null?at:Math.min(next,at);};
  for(const [queueKey,id] of rows){
   const now=clock.now();
   const step=await update(id,queueKey,async(t,item)=>{
    if(now>=item.expiresAt){await finish(t,item,queueKey,'expired');return null;}
    if(item.nextAt>now){later(item.nextAt);return null;}
    if(!seat){await t.put(K.item(id),{...item,reason:'no-occupant',nextAt:now+L.idleMs});later(now+L.idleMs);return null;}
    // §13 step 2 / extensibility §7.1 step 5: an uncertain attempt at an occupant that has since been replaced.
    if(item.uncertainSeat&&item.uncertainSeat!==seat.id){await finish(t,item,queueKey,'unknown',{reason:'occupant-changed'});return null;}
    const attempt={...item,uncertainSeat:seat.id,attempts:item.attempts+1,nextAt:now+backoff(item.attempts)};await t.put(K.item(id),attempt);return attempt;
   });
   if(!step)continue;
   let result,error;try{const provenance=await signer.sign(step.claims);result=await occupant.deliver(owner,{seat,tx:step.tx,args:{message:step.message,provenance}});}catch(e){error=e;}
   const disposition=result?.disposition;
   await update(id,queueKey,async(t,item)=>{
    if(!error&&['stored-receipt','stored-invitation','refused'].includes(disposition)){await finish(t,item,queueKey,'delivered',{disposition,seat:seat.id});delivered++;return;}
    const status=error?.status,definite=Number.isSafeInteger(status)&&error?.indeterminate!==true;
    if(definite&&TERMINAL.includes(status)){await finish(t,item,queueKey,'refused',{reason:typeof error.code==='string'?error.code.slice(0,64):'refused'});return;}
    // A definite answer (429, 503, 401/403 before storage) cleared the attempt; anything else keeps it uncertain.
    const signing=error?.code==='signer_unavailable';
    await t.put(K.item(id),{...item,...definite||signing?{uncertainSeat:null}:{},reason:signing?'signer':definite?'occupant-busy':'indeterminate'});later(item.nextAt);
   });
  }
  return {delivered,more:rows.length===L.drainBatch,nextAt:next};
 }
}

// ---- Owner: the acceptance follow-up ----
export class BridgeAccepted extends BridgeAction{
 static operation='bridge.accepted';static deps=['config','clock','stores','senders','mail'];
 async run({config,clock,stores,senders,mail}){
  const owner=ownerOf(this.actor,['owner','system']),c=live(config),{jti}=this.input??{},now=clock.now(),store=stores.for(owner);
  if(typeof jti!=='string'||jti.length>128)fault('invalid_input','Choose an accepted message.',400);
  const suppressed={status:'suppressed'};
  const claim=await store.transaction(async t=>{
   const l=await t.get(K.ledger(jti)),s=settingsOf(await t.get(K.settings));
   if(!l||!(l.until>now)||l.followup||!s.enabled||!s.autoReply)return null;
    // With the platform gate only a reply the platform actually sent proves DMARC; a header result counts only under
   // the trusted gate (review EB-1).
   if(!l.eligible||!(l.gate==='platform'?l.initial==='sent':l.gate==='trusted'&&l.dmarc==='pass')){await t.put(K.ledger(jti),{...l,followup:'ineligible'});return null;}
   const f=windowed(await t.get(K.followups),now);if(f.count>=L.recipientFollowupsDaily){await t.put(K.ledger(jti),{...l,followup:'suppressed:recipient'});return null;}
   await t.put(K.followups,{...f,count:f.count+1});await t.put(K.ledger(jti),{...l,followup:'pending'});return l.sender;
  });
  if(!claim)return suppressed;
  const key=await senderKey(claim);let reason=null;
  if(await senders.suppressed(key))reason='suppressed';
  else if(!await senders.consume('global/followups-v1',{limit:L.globalFollowupsDaily,windowMs:DAY}))reason='global';
  else if(!await senders.consume(`followup/${key}`,{limit:L.senderFollowupsDaily,windowMs:DAY}))reason='sender';
  const mark=state=>store.transaction(async t=>{const l=await t.get(K.ledger(jti));if(l)await t.put(K.ledger(jti),{...l,followup:state});});
  if(reason||typeof mail?.send!=='function'){await mark(`suppressed:${reason??'transport'}`);return suppressed;}
  await mark('claimed');
  try{await mail.send(buildFollowup({to:claim,link:c.link}));}catch(error){await mark('failed');if(['E_RECIPIENT_SUPPRESSED','E_RECIPIENT_NOT_ALLOWED'].includes(error?.code))await senders.suppress(key,{until:null});return {status:'failed'};}
  await mark('sent');return {status:'sent'};
 }
}

// ---- Owner settings and status; operator suppression ----
export class BridgeSettings extends BridgeQuery{
 static operation='bridge.settings';static deps=['config','stores'];
 async fetch({config,stores}){const owner=ownerOf(this.actor,['owner','system']);live(config);const s=settingsOf(await stores.for(owner).get(K.settings));return {enabled:s.enabled,autoReply:s.autoReply,revision:s.revision};}
}
export class BridgeConfigure extends BridgeAction{
 static operation='bridge.configure';static deps=['config','stores'];
 async run({config,stores}){
  const owner=ownerOf(this.actor,['owner']);live(config);const v=this.input??{};
  if(!plain(v)||Object.keys(v).some(k=>!['enabled','autoReply'].includes(k))||Object.values(v).some(x=>typeof x!=='boolean'))fault('invalid_input','Choose on or off.',400);
  return stores.for(owner).transaction(async t=>{const s=settingsOf(await t.get(K.settings)),next={...s,...v,revision:s.revision+1};await t.put(K.settings,next);return {enabled:next.enabled,autoReply:next.autoReply,revision:next.revision};});
 }
}
export class BridgeStatus extends BridgeQuery{
 static operation='bridge.status';static deps=['config','stores'];
 async fetch({config,stores}){
  const owner=ownerOf(this.actor,['owner','system']);live(config);const store=stores.for(owner),meta=metaOf(await store.get(K.meta)),items=[];
  for(const [,row] of await store.list({prefix:'item/',limit:L.statusItems}))items.push({id:row.id,jti:row.jti,state:row.state,receivedAt:row.receivedAt,sender:row.claims?.sender,dmarc:row.claims?.dmarc,auth:row.auth,automation:row.claims?.automation,...row.disposition?{disposition:row.disposition}:{},...row.reason?{reason:row.reason}:{},attempts:row.attempts});
  return {queued:meta.queued,queuedBytes:meta.queuedBytes,items:items.sort((a,b)=>b.receivedAt-a.receivedAt)};
 }
}
export class BridgeSuppress extends BridgeAction{
 static operation='bridge.suppress';static deps=['config','senders'];
 async run({config,senders}){if(this.actor?.kind!=='system')fault('unauthorized','Not available.',401);live(config);const address=mailbox(this.input?.address);if(!address)fault('invalid_input','Enter an address.',400);await senders.suppress(await senderKey(address),{until:null});return {suppressed:true};}
}
export const BRIDGE_OPERATIONS=Object.freeze(Object.fromEntries([BridgeReceive,BridgeAdmit,BridgeReplyOutcome,BridgeDrain,BridgeAccepted,BridgeSettings,BridgeConfigure,BridgeStatus,BridgeSuppress].map(O=>[O.operation,O])));

// ---- Ports over plain stores (Node, tests and the Worker object share them) ----
/** Sender-keyed fixed windows and the suppression list over one transactional store; rows expire. */
export function storeSenders(store,{clock={now:()=>Date.now()}}={}){
 return {
  async consume(key,{limit,windowMs}){if(typeof key!=='string'||key.length>200||!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(windowMs)||windowMs<1000)return false;const now=clock.now();
   // Returns the charged window's start (truthy) or false.
   return store.transaction(async t=>{const w=windowed(await t.get(`w/${key}`),now,windowMs);if(w.count+1>limit)return false;await t.put(`w/${key}`,{start:w.start,count:w.count+1,until:w.start+windowMs});
    if(!w.count)await t.put(`x/${pad(w.start+windowMs)}/${key}`,1);
    // Expiry index (review EB-8): windows are removed in end-time order, a few per call.
    for(const [k] of await t.list({prefix:'x/',limit:8})){const end=Number(k.slice(2,18)),target=`w/${k.slice(19)}`;if(end>now)break;const row=await t.get(target);if(row&&!(row.until>now))await t.delete(target);await t.delete(k);}
    return w.start||1;});},
  async refund(key,{start}={}){const now=clock.now();await store.transaction(async t=>{const w=await t.get(`w/${key}`);if(plain(w)&&w.start===start&&w.until>now&&w.count>0)await t.put(`w/${key}`,{...w,count:w.count-1});});},
  async suppressed(key){const row=await store.get(`s/${key}`);return !!row&&(row.until===null||row.until>clock.now());},
  async suppress(key,{until=null}={}){await store.put(`s/${key}`,{until,at:clock.now()});},
 };
}
/** Signs provenance claims as a compact ES256 JWS (`typ` bindle-intake-provenance+jwt) with the bridge key. */
export function provenanceSigner({privateKey,keyId}){
 if(!privateKey||typeof keyId!=='string'||!keyId)return {async sign(){fault('signer_unavailable','The bridge key is not configured.',503);}};
 const b64=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');},enc=v=>b64(new TextEncoder().encode(JSON.stringify(v)));
 return {async sign(claims){const head=`${enc({alg:'ES256',kid:keyId,typ:'bindle-intake-provenance+jwt'})}.${enc(claims)}`;return `${head}.${b64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,new TextEncoder().encode(head))))}`;}};
}
/** Occupant deliver through a brokered resource call: builds the exact §9 RPC body for the seat's resource. `call` is
 * the brokered transport ({owner, seat, body} -> {status, json}); answers map to dispositions or classified faults. */
export function brokeredOccupant({seat,call}){
 return {
  seat:owner=>typeof seat==='function'?seat(owner):null,
  async deliver(owner,{seat:s,tx,args}){
   if(typeof call!=='function')throw Object.assign(new Error('Occupant transport unavailable.'),{code:'recipient_unavailable',status:503});
   const body=new TextEncoder().encode(JSON.stringify({version:'0',tx,resource:s.resource,contract:INTAKE_CONTRACT,method:'deliver',args}));
   let answer;try{answer=await call({owner,seat:s,body});}catch(error){throw Object.assign(new Error('Delivery outcome unknown.'),{code:error?.code??'indeterminate',...Number.isSafeInteger(error?.status)?{status:error.status}:{},indeterminate:error?.code==='indeterminate'||!Number.isSafeInteger(error?.status)||error?.indeterminate===true});}
   if(answer?.status!==200||!plain(answer.json))throw Object.assign(new Error('Delivery refused.'),{code:answer?.json?.error?.code??'delivery_failed',status:Number.isSafeInteger(answer?.status)?answer.status:502,...Number.isSafeInteger(answer?.status)?{}:{indeterminate:true}});
   if(answer.json.error)throw Object.assign(new Error('Delivery refused.'),{code:String(answer.json.error.code??'refused'),status:400});
   if(answer.json.tx!==tx)throw Object.assign(new Error('Delivery outcome unknown.'),{code:'indeterminate',indeterminate:true});
   return answer.json.result;
  },
 };
}
/** Serialized copy-on-write memory store with the DO/SqliteMetadata interface (tests and loopback development only). */
export function memoryStore(){
 let data=new Map(),tail=Promise.resolve();
 const view=map=>({get:async k=>structuredClone(map.get(k)),put:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>map.delete(k),
  list:async({prefix='',limit=100000}={})=>new Map([...map.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(k=>[k,structuredClone(map.get(k))]))});
 const store={get:k=>view(data).get(k),list:o=>view(data).list(o),put:(k,v)=>store.transaction(t=>t.put(k,v)),delete:k=>store.transaction(t=>t.delete(k)),
  transaction(work){const r=tail.then(async()=>{const draft=new Map(data),value=await work(view(draft));data=draft;return value;});tail=r.catch(()=>{});return r;},
  dump:()=>new Map(data)};
 return store;
}
export const jcsDigest=value=>sha256(jcs(value));
