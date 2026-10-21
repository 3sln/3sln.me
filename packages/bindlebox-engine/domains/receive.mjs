import {projectIncoming,removeIncoming} from '../store/item-index.mjs';
// Receive path for link kinds (spec §4.5, §7.1, §8; architecture §11). Cheapest refusal first:
//  edge: credential grammar and the edge index (handleIngress, before any mailbox work);
//  mailbox, read-only: stored exact meta segments, framing/schema, kind/MIME/window bounds, owner budget pre-check;
//  crypto: owner meta signature, then author (verifyEnvelope; status where §3.4 requires it, known revocations else);
//  receipt signer snapshot and body staging (outside any transaction);
//  one admission transaction: replay decision, live authorization recheck, parent quotas, budgets, item, body,
//  replay entry and receipt. A receipt is returned only after that commit, so it never claims custody that a crash
//  could lose; a lost reply is answered on retry with the stored receipt and no new charge, write or notification.
// Classification of public requests runs later (intake.drain), so nothing in this response depends on it (§6.7).
// Records and rejoin (BindleConversation) belong to BB-B4 and are refused here as not_authorized.
import * as P from '../../bindlebox-protocol/index.mjs';
import {verifyES256} from '../../bindlebox-protocol/certificate.mjs';
import {equalDigest} from '../../bindlebox-protocol/encoding.mjs';
import {MailboxAction,MailboxQuery} from '../engine.mjs';
import {MailboxFault,fault} from '../faults.mjs';
import {KEYS,BOUNDS,actorOwner,readConfig,chargeUsage,principalKey} from '../store/mailbox.mjs';
import {linkClaims} from '../store/edge-index.mjs';
import {chargeBudget,ownerExhausted} from './receive-budget.mjs';
import {verificationPorts,knownRevoked,recordRevocation,jktIndex,seenKey,boundedCache} from './delegation.mjs';

const protocol=code=>{throw new P.ProtocolFault(code);};
const unavailable=(code='recipient_unavailable')=>{throw new P.ProtocolFault(code,{retryAfter:60});};
const DAY=86400000,NEGATIVE_REUSE_MS=900000,MAX_DECISIONS=256;
const issuerHost=issuer=>new URL(issuer).host;

export class ReceiveConfigure extends MailboxAction {
 static operation='receive.configure';static deps=['receive'];
 async run({receive}){
  actorOwner(this.actor);const {principal,ingress,plan='free'}=this.input??{};
  try{P.validatePrincipal(principal);const u=new URL(ingress);if(u.protocol!=='https:'||u.search||u.hash||u.href!==ingress)throw new Error();}catch{fault('invalid_input','Choose a valid principal and ingress.',400);}
  if(!['free','paid','plus','ultra'].includes(plan))fault('invalid_input','Choose a valid plan.',400);
  const config={principal:{issuer:principal.issuer,subject:principal.subject,identityURI:principal.identityURI},ingress,plan};
  await receive.store.transaction(tx=>tx.put(KEYS.config,config));return config;
 }
}

// One receipt signer snapshot, read once (never re-read between kid and key: IDKEYS-1 finding 7). It must certify
// the receipt purpose for this principal and this exact ingress, valid at receivedAt; otherwise nothing is admitted.
async function receiptSigner(delegateKeys,config,now){
 let snapshot;try{snapshot=await (typeof delegateKeys?.current==='function'?delegateKeys.current():undefined);}catch{snapshot=undefined;}
 if(!snapshot||typeof snapshot!=='object')unavailable();
 const signer=Object.freeze({kid:snapshot.kid,privateKey:snapshot.privateKey,delegation:snapshot.delegation});
 let c;try{c=P.parseDelegation(signer.delegation).claims;}catch{unavailable();}
 if(signer.kid!==`jkt:${c.jkt}`||c.iss!==config.principal.issuer||c.sub!==config.principal.subject||!c.purposes.includes(P.PURPOSES.receipt)||c.client.ingress!==config.ingress||now<c.iat*1000-P.LIMITS.clockSkewMs||now>c.exp*1000+P.LIMITS.clockSkewMs||now<c.since*1000)unavailable();
 return signer;
}
// Conditional links (§4.6, links §7.5): bounded decision reuse; positive until the UTC day ends, negative 15 minutes.
// The author-signed envelope goes to the provider as the host-verifiable author proof (BB-C1b, core-links review 1).
async function audience({store,providerLink,parent,principal,envelope,now}){
 const key=KEYS.decision(parent.jti,principal),prior=await store.get(key);
 if(prior&&prior.until>now){if(prior.state==='eligible')return null;protocol('audience_ineligible');}
 let state;try{state=(await providerLink.evaluate({jti:parent.jti,principal:{issuer:principal.issuer,subject:principal.subject},proof:envelope}))?.state;}catch{state='unavailable';}
 if(state==='eligible')return {key,value:{state,until:(Math.floor(now/DAY)+1)*DAY}};
 // Negative decisions are cached only while this link holds fewer than MAX_DECISIONS rows (expired rows are pruned
 // first), so verified-but-ineligible principals cannot grow mailbox rows without bound.
 if(state==='ineligible'){await store.transaction(async tx=>{const prefix=`decision/${encodeURIComponent(parent.jti)}/`;let live=0;for(const [k,row] of await tx.list({prefix})){if(row.until<=now)await tx.delete(k);else live++;}if(live<MAX_DECISIONS)await tx.put(key,{state,until:now+NEGATIVE_REUSE_MS});});protocol('audience_ineligible');}
 unavailable('audience_unavailable');
}
const sameSegments=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&equalDigest(a,b);

// Pre-crypto refusal limiter (review BB2-R3): refusals that happen after author verification (ineligible, blocked,
// over quota or budget) are counted per verified principal and per issuer host, in memory and bounded; the next
// attempt claiming that principal or issuer is refused before any crypto, status fetch or links-contract call.
// Only verified refusals count, so nobody can throttle another principal by claiming it.
export const REFUSALS=Object.freeze({windowMs:3600000,principal:20,issuer:200});
const limiters=new WeakMap();
const limiterFor=store=>{let l=limiters.get(store);if(!l){l=boundedCache(4096);limiters.set(store,l);}return l;};
const refusalKeys=principal=>[`p|${principalKey(principal)}`,`i|${issuerHost(principal.issuer)}`];
function checkRefusals(store,principal,now){
 const l=limiterFor(store),[pk,ik]=refusalKeys(principal);
 for(const [key,max] of [[pk,REFUSALS.principal],[ik,REFUSALS.issuer]]){const row=l.get(key,now);if(row&&row.count>=max){const e=new MailboxFault('rate_limited','Too many messages. Try again later.',429);e.retryAfter=Math.max(1,Math.ceil((row.until-now)/1000));throw e;}}
}
function countRefusal(store,principal,now){const l=limiterFor(store);for(const key of refusalKeys(principal)){const row=l.get(key,now)??{count:0,until:now+REFUSALS.windowMs};l.set(key,{count:row.count+1,until:row.until},row.until);}}
const COUNTED=new Set(['audience_ineligible','not_authorized','rate_limited','link_invalid','too_large','operation_conflict']);

// Link quotas, request status and budgets for one new admission. Pure over the rows it is given: run read-only before
// any staging (so refused attempts write nothing anywhere) and again, authoritatively, inside the commit.
function admissionPlan({live,budget,known,principal,bytes,now,plan}){
 const pk=principalKey(principal),day=Math.floor(now/DAY);let usage=live.usage,quota=live.quota??{};
 // Lifetime on unconditional parents, per verified author per UTC day on conditional ones (links §7.1).
 if(live.conditional){const row=quota[pk]?.day===day?quota[pk]:{day,messages:0,bytes:0};if(row.messages+1>live.maxMessages||row.bytes+bytes>live.maxBytes){const e=new MailboxFault('rate_limited','Too many messages. Try again later.',429);e.retryAfter=Math.ceil(((day+1)*DAY-now)/1000);throw e;}
  quota=Object.fromEntries([...Object.entries(quota).filter(([,r])=>r.day===day),[pk,{day,messages:row.messages+1,bytes:row.bytes+bytes}]]);}
 else{if(usage.messages+1>live.maxMessages||usage.bytes+bytes>live.maxBytes)protocol('link_invalid');usage={messages:usage.messages+1,bytes:usage.bytes+bytes};}
 const request=live.public&&!known;
 return {usage,quota,request,pk,budget:chargeBudget(budget,{now,plan,bytes,parent:live.jti,sender:pk,request:request?{sender:pk,domain:issuerHost(principal.issuer)}:undefined})};
}

export class ReceiveDeliver extends MailboxAction {
 static operation='receive.deliver';static deps=['receive','directory','delegateKeys','providerLink','userStorage','random','clock'];static changes='incoming-changed';
 async run({receive,directory,delegateKeys,providerLink,userStorage,random,clock}){
  actorOwner(this.actor,['ingress']);
  const {contentType,body,authorization,idempotencyKey,ingress}=this.input??{},store=receive.store,now=clock.now(),config=await readConfig(store);
  if(ingress!==config.ingress)protocol('ingress_moved');
  // Credential and parent: exact stored header/claims segments, no crypto (§4.5 steps 1-3).
  const credential=P.parseCredential(authorization);
  if(credential.scheme!=='BindleLink')protocol(credential.scheme==='BindleConversation'?'not_authorized':'link_invalid');
  const meta=linkClaims(credential.value),parent=await store.get(KEYS.parent(meta.claims.jti));
  if(!parent||parent.revoked||parent.iss!==meta.claims.iss||!sameSegments(credential.value.split('.').slice(0,2).join('.'),parent.segments)||parent.claims.exp*1000<=now)protocol('link_invalid');
  // Framing, schema and the link's own bounds.
  const delivery=await P.parseDelivery(contentType,body,{idempotencyKey,limits:{maxBodyBytes:parent.maxMessageBytes}}),envelope=delivery.envelope,p=envelope.payload;
  P.checkCredentialKind(envelope,credential);
  P.checkLinkRecipient(envelope,{issuer:config.principal.issuer,owner:config.principal.subject,jti:parent.jti,resource:parent.resource});
  if(!parent.kinds.includes(p.kind)||(p.content&&!parent.mimeTypes.includes(p.content.mimeType)))protocol('link_invalid');
  P.checkWindow(envelope,now);
  // Read-only pre-checks before crypto; an already admitted operation is answered as a replay instead.
  const id=await P.sha256(globalThis.crypto,P.replayKey(envelope)),prior=await store.get(KEYS.replay(id));
  if(!prior){ownerExhausted(await store.get(KEYS.budget),{now,plan:config.plan});checkRefusals(store,p.author.principal,now);}
  // Owner meta signature under an active owner key from the directory; a stored-claims match alone is not validity.
  const learned=[],ports=verificationPorts({directory,store,now,learned});
  let ownerKey;try{ownerKey=await ports.resolveKey({issuer:config.principal.issuer,subject:config.principal.subject,identityURI:config.principal.identityURI,keyId:parent.header.kid});}catch{unavailable();}
  if(!ownerKey||ownerKey.keyId!==parent.header.kid||!await verifyES256(ownerKey.publicJwk,meta.signature,meta.signingInput))protocol('link_invalid');
  // Author (§3.3, §3.4). A revocation learned here is persisted (with quarantine) even though this delivery fails.
  let verified;
  try{verified=await P.verifyEnvelope(envelope,{resolveKey:ports.resolveKey,status:ports.status,now});}
  catch(error){if(learned.length)await store.transaction(async tx=>{for(const r of learned)await recordRevocation(tx,{...r,now});}).catch(()=>{});throw error;}
  const author=verified.author,principal={issuer:author.principal.issuer,subject:author.principal.subject};
  if(!P.statusRequired(envelope)&&await knownRevoked({directory,store,now},author.jkt))throw new P.ProtocolFault('author_unverifiable',{revoked:true});
  const bytes=delivery.body?.byteLength??0;let staged=null;
  try{
   if(await store.get(KEYS.block(principal)))protocol('not_authorized');
   const decision=parent.conditional?await audience({store,providerLink,parent,principal,envelope,now}):null;
   // Quotas and budgets read-only before staging or signing (review BB2-R1): a refused attempt writes nothing.
   if(!prior){const live=await store.get(KEYS.parent(parent.jti));if(!live||live.revoked)protocol('link_invalid');admissionPlan({live,budget:await store.get(KEYS.budget),known:await store.get(`known/${principalKey(principal)}`),principal,bytes,now,plan:config.plan});}
   // Receipt signed before the commit and released only after it.
   const signer=await receiptSigner(delegateKeys,config,now);
   const receipt=await P.signReceipt(await P.receiptPayload(envelope,{recipient:config.principal,ingress:config.ingress,receivedAt:now,bodyDigest:delivery.bodyDigest}),signer);
   // Large bodies go to the owner's storage resource first, under a key unique to this attempt so no attempt can
   // overwrite an admitted body (review BB2-R2); otherwise into the bounded hot allowance.
   if(!prior&&delivery.body&&bytes>=BOUNDS.inlineBodyBytes&&userStorage&&typeof userStorage.put==='function'){const key=`bindlebox/v1/items/${id}/${random.uuid()}`;try{await userStorage.put(key,delivery.body);staged={storage:'user',key};}catch{staged=null;}}
   const result=await store.transaction(async tx=>{
    const prior=await tx.get(KEYS.replay(id)),outcome=P.replayDecision(prior,{payloadDigest:delivery.payloadDigest});
    // Live authorization is rechecked inside the commit, for replays too: a link revoked, a principal blocked or a
    // key learned revoked after the checks above never yields a receipt.
    const live=await tx.get(KEYS.parent(parent.jti));
    if(!live||live.revoked||live.segments!==parent.segments)protocol('link_invalid');
    if(await tx.get(KEYS.block(principal)))protocol('not_authorized');
    if(await tx.get(KEYS.revoked(author.jkt)))throw new P.ProtocolFault('author_unverifiable',{revoked:true});
    if(outcome==='replay')return {receipt:prior.receipt,replay:true};
    const plan=admissionPlan({live,budget:await tx.get(KEYS.budget),known:await tx.get(`known/${principalKey(principal)}`),principal,bytes,now,plan:config.plan}),request=plan.request;let hot=0;
    await tx.put(KEYS.budget,plan.budget);
    if(delivery.body&&bytes>=BOUNDS.inlineBodyBytes&&!staged){const u=await tx.get(KEYS.usage)??{hotBytes:0,hotItems:0};if(u.hotBytes+bytes>BOUNDS.hotBytes||u.hotItems+1>BOUNDS.hotItems)unavailable('recipient_storage_unavailable');await chargeUsage(tx,{bytes});hot=bytes;}
    const intake=live.intake??{revision:0,autoTags:[],optionalTags:[]},offered=new Set(intake.optionalTags.map(t=>t.id));
    const tags=[...intake.autoTags.map(id=>({id,source:'intake'})),...p.optionalTags.filter(t=>offered.has(t)).map(id=>({id,source:'sender'}))];
    const item={id,origin:'native',kind:p.kind,author:{principal:author.principal,keyId:author.keyId,jkt:author.jkt,client:{client_id:author.client.client_id,origin:author.client.origin}},
     jti:live.jti,operationId:p.operationId,subject:p.subject,content:p.content,bodyRef:delivery.body?(staged??{storage:'mailbox'}):null,createdAt:p.createdAt,receivedAt:now,
     state:request?'pending':'inbox',request,hot,tags,tagHistory:[],payloadDigest:delivery.payloadDigest,quarantined:false,reviewed:false,notification:request?null:'push',envelope};
    await tx.put(KEYS.item(id),item);await projectIncoming(tx,item);if(delivery.body&&item.bodyRef.storage==='mailbox')await tx.put(KEYS.body(id),delivery.body);
    if(request)await tx.put(KEYS.pending(now,id),{id});
    await tx.put(jktIndex(author.jkt,id),1);
    const seen=await tx.get(seenKey(author.jkt));await tx.put(seenKey(author.jkt),{jkt:author.jkt,principal:author.principal,lastSeen:now,checkedAt:seen?.checkedAt??(author.statusChecked?now:0)});
    await tx.put(KEYS.replay(id),{payloadDigest:delivery.payloadDigest,itemId:id,receipt,retainUntil:P.retainUntil(envelope,now)});
    await tx.put(KEYS.parent(live.jti),{...live,usage:plan.usage,quota:plan.quota});if(decision)await tx.put(decision.key,decision.value);
    return {receipt,replay:false,committed:true};
   });
   if(!result.committed&&staged)await discard(userStorage,store,staged.key);
   return {receipt:result.receipt,replay:result.replay};
  }catch(error){
   if(staged)await discard(userStorage,store,staged.key);
   if(COUNTED.has(error?.code))countRefusal(store,principal,now);
   throw error;
  }
 }
}
// A staged body that no committed item references is deleted now, or queued for the storage sweep if that fails.
async function discard(userStorage,store,key){
 try{if(typeof userStorage?.delete!=='function')throw new Error();await userStorage.delete(key);}catch{await store.transaction(tx=>tx.put(`storage-gc/${encodeURIComponent(key)}`,{key})).catch(()=>{});}
}

// Owner listing of admitted items. Pending, rejected and quarantined items never appear here (see intake queries).
const itemView=i=>({id:i.id,origin:i.origin,kind:i.kind,author:i.origin==='native'?{principal:i.author.principal,verified:true}:{asserted:i.asserted,verified:false},subject:i.subject,content:i.content,receivedAt:i.receivedAt,state:i.state,request:i.request,priority:i.priority??'normal',tags:i.tags,tagHistory:i.tagHistory,quarantined:Boolean(i.quarantined)});
export class ReceiveItems extends MailboxQuery {
 static operation='receive.items';static deps=['receive'];static refreshOn=['incoming-changed'];
 async fetch({receive}){actorOwner(this.actor);const items=[...(await receive.store.list({prefix:'item/'})).values()];return {items:items.filter(i=>!i.quarantined&&(i.state==='inbox'||i.state==='request')).sort((a,b)=>(a.priority==='low')-(b.priority==='low')||b.receivedAt-a.receivedAt).map(itemView),quarantined:items.filter(i=>i.quarantined).map(itemView)};}
}
// Retention sweep (spec §8.2): replay entries and receipts past retainUntil, and expired audience decisions, are
// dropped; items stay.
export class ReceiveSweep extends MailboxAction {
 static operation='receive.sweep';static deps=['receive','clock'];
 async run({receive,clock}){
  actorOwner(this.actor,['system','owner']);const now=clock.now();
  return receive.store.transaction(async tx=>{let dropped=0,decisions=0;for(const [key,entry] of await tx.list({prefix:'replay/'}))if(entry.retainUntil<now){await tx.delete(key);dropped++;}for(const [key,row] of await tx.list({prefix:'decision/'}))if(row.until<=now){await tx.delete(key);decisions++;}return {dropped,decisions};});
 }
}
export const RECEIVE_OPERATIONS=[ReceiveConfigure,ReceiveDeliver,ReceiveItems,ReceiveSweep];

// Edge adapter (placement `edge`): framing bound and edge-index credential check before any mailbox is woken, then
// one `receive.deliver` dispatch to the routed owner's mailbox. Bodies are {error, message} with fixed messages;
// 429 and 503 carry Retry-After; clock_skew carries serverTime. Unknown failures are a 500 without detail.
const MESSAGES={malformed:'The request is malformed.',link_malformed:'The link is malformed.',link_invalid:'The link is not valid.',envelope_expired:'The message has expired.',clock_skew:'The message is dated in the future.',author_unverifiable:'The author cannot be verified.',author_required:'An author is required.',not_authorized:'Not authorized.',audience_ineligible:'Not eligible for this link.',operation_conflict:'The operation conflicts with an earlier one.',too_large:'The request is too large.',record_unsupported:'Unsupported record.',unsupported_profile:'Unsupported profile.',rate_limited:'Too many messages. Try again later.',recipient_unavailable:'The recipient is unavailable.',recipient_storage_unavailable:'The recipient is unavailable.',audience_unavailable:'Eligibility is unavailable.',ingress_moved:'The ingress has moved.',counter_gap:'Counter gap.',incarnation_stale:'Stale incarnation.',participants_exceeded:'Too many participants.',record_forbidden:'Record forbidden.'};
export function ingressError(error,now){
 const code=error?.code,headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
 if(typeof code!=='string'||!Object.hasOwn(P.ERRORS,code))return Response.json({error:'internal_error',message:'The request could not be completed.'},{status:500,headers});
 const status=code==='author_unverifiable'&&error.status===503?503:P.ERRORS[code];
 if(status===429||status===503)headers['Retry-After']=String(Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?error.retryAfter:60);
 return Response.json({error:code,message:MESSAGES[code]??'The request could not be completed.',...code==='clock_skew'?{serverTime:Number.isSafeInteger(error.serverTime)?error.serverTime:now}:{}},{status,headers});
}
export async function handleIngress(request,{edge,deliver,now=()=>Date.now()}){
 try{
  if(request?.method!=='POST'||!(request.body instanceof Uint8Array))protocol('malformed');
  if(request.body.byteLength>P.LIMITS.maxRequestBytes)protocol('too_large');
  const headers=Object.fromEntries(Object.entries(request.headers??{}).map(([k,v])=>[k.toLowerCase(),v]));
  const routed=await edge.check(headers.authorization);
  const result=await deliver(routed.owner,{contentType:headers['content-type'],body:request.body,authorization:headers.authorization,idempotencyKey:headers['idempotency-key'],ingress:request.url});
  return Response.json({receipt:result.receipt},{status:200,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 }catch(error){return ingressError(error,now());}
}
