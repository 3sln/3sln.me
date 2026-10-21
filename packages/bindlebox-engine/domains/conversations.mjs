import {requireRestored} from '../store/restore.mjs';
import {projectIncoming} from '../store/item-index.mjs';
// BB-B4 conversations (spec §6, §7.1, §7.4, §8.2; architecture §7, §9.5, §16). Option A, provisional pending user
// confirmation (DEVLOG 2026-10-20): a shared secret gate, independently signed author events, each owner's
// accepted-peer set, no sequencer and direct mesh delivery. Nothing here is mounted or flag-enabled; the outbox the
// composition supplies carries BINDLEBOX_ENABLED, and its `authorize` must include `withConversations`.
//  - Create/invite: one creator-signed genesis, a per-invitee creatorBinding, return control and nonce (§6.1); the
//    conversation-init travels on the invitee's contact link through BB-B3's queue and BB-B2's link admission.
//  - Accept: the invitee signs a response (§6.2) and both sides can send at once (review P-1). The creator relays each
//    accepted participant's own signed response as a peer-proposal introduction; participants then exchange direct
//    peer-hellos, auto-accepted only under acceptListed or an accepted proposal (review P-2, S-2).
//  - Send: the stream head and event ID are persisted before signing (P-3); one event is signed once per recipient
//    with a frozen audience and submitted to BB-B3. One snapshot of the delegate key supplies kid, key and certificate
//    (never re-read between them: IDKEYS-1 finding 7).
//  - Receive: edge pair-gate (createConversationEdge) before any mailbox; then the mailbox repeats the gate from its
//    own secrets, verifies the author (status where §3.4 requires it), and commits replay, frontier, effects and the
//    receipt in one transaction. A receipt is released only after that commit.
// In this module secrets live only under conv/secret/, pending rotation rows and unsubmitted op rows (BB-B3 task rows
// also hold secret parts: review BB4-I2); no query, audit entry or progress event returns them.
import * as P from '../../bindlebox-protocol/index.mjs';
import {equalDigest,isUUID} from '../../bindlebox-protocol/encoding.mjs';
import {MailboxAction,MailboxQuery} from '../engine.mjs';
import {fault} from '../faults.mjs';
import {MailboxDomain,KEYS,actorOwner,readConfig,principalKey,pad} from '../store/mailbox.mjs';
import {parseLinkURL,contactMeta} from './contacts.mjs';
import {verificationPorts,knownRevoked,recordRevocation} from './delegation.mjs';
import {handleIngress,ingressError} from './receive.mjs';

const DAY=86400000,HOUR=3600000,te=new TextEncoder(),td=new TextDecoder();
// Provisional mailbox policy (architecture §7.7, spec §11); protocol maxima come from P.LIMITS.
export const CONVERSATION_LIMITS=Object.freeze({liveConversations:500,peers:64,pendingOffers:16,rotations:16,rejoinPerDay:1,workPerDrain:64,workAttempts:20,responseAttempts:20,bootstrapMs:7*DAY});
const pk=p=>principalKey(p);
const C={settings:'conv/settings',room:c=>`conv/room/${c}`,rooms:'conv/room/',secret:(c,e)=>`conv/secret/${c}/${e}`,secrets:c=>`conv/secret/${c}/`,peer:(c,p)=>`conv/peer/${c}/${pk(p)}`,peers:c=>`conv/peer/${c}/`,
 stream:(c,j)=>`conv/stream/${c}/${j}`,frontier:(c,p,j)=>`conv/frontier/${c}/${pk(p)}/${j}`,frontiers:c=>`conv/frontier/${c}/`,event:(c,id)=>`conv/event/${c}/${id}`,events:c=>`conv/event/${c}/`,body:(c,id)=>`conv/body/${c}/${id}`,
 replay:d=>`conv/replay/${d}`,op:id=>`conv/op/${id}`,ops:'conv/op/',work:id=>`conv/work/${encodeURIComponent(id)}`,works:'conv/work/',invite:(c,p)=>`conv/invite/${c}/${pk(p)}`,route:t=>`conv/route/${t}`,
 response:c=>`conv/response/${c}`,responses:'conv/response/',intro:(c,p)=>`conv/intro/${c}/${pk(p)}`,intros:c=>`conv/intro/${c}/`,rotation:(c,e)=>`conv/rotation/${c}/${e}`,rotations:c=>`conv/rotation/${c}/`,
 mutations:c=>`conv/mutations/${c}`,placeholder:(c,id)=>`conv/placeholder/${c}/${id}`,evidence:(c,id)=>`conv/evidence/${c}/${id}`,byJkt:(j,c,id)=>`conv/by-jkt/${j}/${c}/${id}`,decided:id=>`conv/decided/${id}`,
 edgeSeq:'conv-edge-seq',edgeOutbox:n=>`conv-edge-outbox/${pad(n)}`};
const BODY_TYPES=new Set(['message','edit']);
// Conversation records have their own receive allowance (architecture §11), separate from BB-B2's link budgets:
// per author per conversation and per owner, per UTC day, with a bounded key count. Provisional policy values.
export const CONVERSATION_ALLOWANCE=Object.freeze({authorRecords:5000,authorBytes:256*1048576,ownerRecords:50000,ownerBytes:2048*1048576,keys:4096});
const ALLOWANCE_KEY='conv/allowance';
function chargeAllowance(state,{now,key,bytes,check=false}){
 const day=Math.floor(now/DAY),s=state?.day===day?structuredClone(state):{day,records:0,bytes:0,authors:{}},a=s.authors[key]??{records:0,bytes:0},A=CONVERSATION_ALLOWANCE;
 const over=check?s.records>=A.ownerRecords||s.bytes>=A.ownerBytes:(!s.authors[key]&&Object.keys(s.authors).length>=A.keys)||a.records+1>A.authorRecords||a.bytes+bytes>A.authorBytes||s.records+1>A.ownerRecords||s.bytes+bytes>A.ownerBytes;
 if(over)protocol('rate_limited',{retryAfter:Math.max(1,Math.ceil(((day+1)*DAY-now)/1000))});
 if(!check){s.authors[key]={records:a.records+1,bytes:a.bytes+bytes};s.records++;s.bytes+=bytes;}return s;
}
// Only shared content advances causal heads; pairwise control records (hellos, proposals, shares) are never parents,
// since other replicas never hold them.
const CONTENT_TYPES=new Set(['message','edit','retract']);
const protocol=(code,extra)=>{throw new P.ProtocolFault(code,extra);};
const principal=p=>({issuer:p.issuer,subject:p.subject});
const same=(a,b)=>Boolean(a&&b)&&a.issuer===b.issuer&&a.subject===b.subject;
// Security tokens (secrets, nonces, incarnations, route tokens) always come from Web Crypto, never the injected
// development PRNG; IDs that a restarted seeded PRNG could repeat are also drawn here.
const token=(n=24)=>P.base64url(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const newId=()=>globalThis.crypto.randomUUID();
const invalid=message=>fault('invalid_input',message,400);
const textOf=(v,max)=>{if(typeof v!=='string'||!v.isWellFormed()||/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(v.replace(/[\n\t]/g,''))||te.encode(v).byteLength>max)invalid('Write a shorter message.');return v;};
const operationOf=v=>{if(v===undefined)return newId();if(!isUUID(v))invalid('Choose a valid operation.');return v;};
const cidOf=v=>{if(!isUUID(v))invalid('Choose a conversation.');return v;};

export class ConversationsDomain extends MailboxDomain {}

async function settingsOf(store){const s=await store.get(C.settings);return {maxParticipants:s?.maxParticipants??P.LIMITS.maxParticipants,identityDocument:s?.identityDocument??null};}
const limitsOf=s=>({maxParticipants:s.maxParticipants,maxMessageBytes:P.LIMITS.maxBodyBytes,maxEnvelopeBytes:P.LIMITS.maxEnvelopeBytes});
const bindingOf=(config,settings,incarnation)=>({ingress:config.ingress,incarnation,profiles:[P.PROFILE],limits:limitsOf(settings)});

// One delegate-key snapshot: kid, private key and certificate are read together and checked against this mailbox's
// principal, certified ingress, purpose and lifetime. `fail` decides the caller-visible refusal.
async function snapshot(delegateKeys,config,settings,now,{purpose=P.PURPOSES.author,fail=()=>fault('signing_unavailable','Messaging signing is unavailable. Reconnect BindleBox.',503)}={}){
 let s;try{s=await (typeof delegateKeys?.current==='function'?delegateKeys.current():undefined);}catch{s=undefined;}
 if(!s||typeof s!=='object')fail();
 const signer={kid:s.kid,privateKey:s.privateKey,delegation:s.delegation};let jws;
 try{jws=P.parseDelegation(signer.delegation);}catch{fail();}
 const c=jws.claims,skew=P.LIMITS.clockSkewMs;
 if(signer.kid!==`jkt:${c.jkt}`||c.iss!==config.principal.issuer||c.sub!==config.principal.subject||!c.purposes.includes(purpose)||c.client.ingress!==config.ingress||now<c.iat*1000-skew||now>c.exp*1000+skew||now<c.since*1000-skew)fail();
 return Object.freeze({...signer,jkt:c.jkt,author:{principal:{issuer:config.principal.issuer,subject:config.principal.subject,identityURI:config.principal.identityURI},identityDocument:settings.identityDocument??`${config.principal.identityURI}/identity.json`,keyId:jws.header.kid,delegate:signer.kid}});
}
const receiptSnapshot=(delegateKeys,config,settings,now)=>snapshot(delegateKeys,config,settings,now,{purpose:P.PURPOSES.receipt,fail:()=>protocol('recipient_unavailable',{retryAfter:60})});

// ---- Edge index (spec §7.4): H(conversation, author, recipient) -> digests of expected pair tokens per epoch, the
// recipient's incarnation, whether rejoin is admissible and, while a rejoining mailbox awaits its secret, a digest of
// the incarnation it issued. Entries hold no secret and no plaintext token.
const liveEpochs=(room,now)=>Object.entries(room.epochs).filter(([,e])=>e.until===null||e.until>now).map(([id])=>id);
async function digests(tx,room,author,me,incarnation,now){
 const out={};for(const epoch of liveEpochs(room,now)){const s=await tx.get(C.secret(room.id,epoch));if(s)out[epoch]=await P.tokenDigest(await P.pairToken(Uint8Array.from(s),{conversationId:room.id,author:principal(author),recipient:principal(me),incarnation}));}return out;
}
// Acceptance policy is applied after the author is verified; removal, decline and departure are sticky until the owner
// readmits (readmission starts its own hello).
async function gateEntry(tx,room,peer,author,me,now){
 const active=room.state==='active',accepted=active&&peer?.state==='accepted'&&typeof peer.inbound==='string';
 // Hello: accepted peers, and genesis participants this owner has not removed, declined or seen leave (§6.4; BB4-S3).
 const listed=room.participants.some(x=>same(x.principal,author)),helloable=active&&!room.awaitingSecret&&(peer?.state==='accepted'||(listed&&!['removed','declined','left','blocked'].includes(peer?.state)));
 return {tokenDigests:accepted&&!room.awaitingSecret?await digests(tx,room,author,me,peer.inbound,now):{},helloDigests:helloable?await digests(tx,room,author,me,P.HELLO_INCARNATION,now):{},...accepted?{incarnation:peer.inbound}:{},rejoin:accepted,awaiting:accepted&&room.awaitingSecret?await P.sha256(globalThis.crypto,peer.inbound):null};
}
async function queueEdge(tx,entry){const seq=(await tx.get(C.edgeSeq)??0)+1;await tx.put(C.edgeSeq,seq);await tx.put(C.edgeOutbox(seq),{...entry,generation:seq});}
async function publishPeer(tx,room,peer,config,now){
 const entry=await gateEntry(tx,room,peer,peer.principal,config.principal,now),key=await P.edgeKey({conversationId:room.id,author:principal(peer.principal),owner:principal(config.principal)});
 await queueEdge(tx,{kind:'peer',key,...entry,epochUntil:Object.fromEntries(Object.entries(room.epochs).map(([e,v])=>[e,v.until]))});
}
async function publishRoom(tx,room,config,now){for(const [,peer] of await tx.list({prefix:C.peers(room.id)}))await publishPeer(tx,room,peer,config,now);}
async function putPeer(tx,room,row,config,now){await tx.put(C.peer(room.id,row.principal),row);await publishPeer(tx,room,row,config,now);}
// Group bound (spec §6.5, review P-12): this owner's accepted peers plus itself never exceed maxParticipants, the
// smaller of the bound recorded at acceptance and the owner's current setting.
async function admit(tx,room,row,config,now,{soft=false}={}){
 const others=[...(await tx.list({prefix:C.peers(room.id)})).values()].filter(p=>p.state==='accepted'&&!same(p.principal,row.principal)).length;
 if(await tx.get(KEYS.block(row.principal))){if(soft)return false;protocol('not_authorized');}
 if(others+2>Math.min(room.maxParticipants,(await settingsOf(tx)).maxParticipants)){if(soft)return false;protocol('participants_exceeded');}
 await putPeer(tx,room,row,config,now);return true;
}

export function createConversationEdge(store,{now=()=>Date.now()}={}){
 if(!store||typeof store.get!=='function'||typeof store.put!=='function')throw new TypeError('The conversation edge needs a store');
 return Object.freeze({
  // Returns the routed mailbox owner, or throws the uniform not_authorized (incarnation_stale for a known peer's old
  // incarnation, as §6.5 requires). Unknown entries cost the same digest work as known ones.
  async check(credential,envelope){
   const p=envelope.payload,r=p.record,key=await P.edgeKey({conversationId:r.conversationId,author:principal(p.author.principal),owner:{issuer:p.recipient.issuer,subject:p.recipient.owner}}),entry=await store.get(`conv-peer/${key}`),t=now();
   if(!entry){await P.sha256(globalThis.crypto,`${key}${credential?.token??''}`);protocol('not_authorized');}
   if(r.type==='rejoin'){if(credential?.scheme!=null||!entry.rejoin)protocol('not_authorized');return entry.owner;}
   if(entry.awaiting&&(r.type==='peer-hello'||equalDigest(await P.sha256(globalThis.crypto,p.recipient.incarnation),entry.awaiting)))return entry.owner;
   const live=d=>Object.fromEntries(Object.entries(d??{}).filter(([e])=>entry.epochUntil?.[e]===null||entry.epochUntil?.[e]>t));
   await P.checkPairGate(credential,envelope,{...entry,tokenDigests:live(entry.tokenDigests),helloDigests:live(entry.helloDigests)});
   return entry.owner;
  },
  async route(t){const r=typeof t==='string'&&/^[A-Za-z0-9_-]{32}$/.test(t)?await store.get(`conv-route/${t}`):undefined;if(!r)protocol('not_authorized');return r.owner;},
  // Monotonic per key and owner, like the link index: an older generation or another owner never overwrites.
  async publish(entry){const key=entry.kind==='route'?`conv-route/${entry.token}`:`conv-peer/${entry.key}`,prior=await store.get(key);if(prior&&(prior.owner!==entry.owner||prior.generation>=entry.generation))return false;await store.put(key,entry);return true;},
 });
}
export async function flushConversationEdge(mailboxStore,edge,owner){
 const rows=await mailboxStore.list({prefix:'conv-edge-outbox/'});for(const [,entry] of rows)await edge.publish({...entry,owner});
 if(rows.size)await mailboxStore.transaction(async tx=>{for(const [key,entry] of rows){const current=await tx.get(key);if(current&&current.generation===entry.generation)await tx.delete(key);}});
 return rows.size;
}

// Edge adapter: return-control POSTs (§6.2), link kinds (BB-B2 handleIngress) and conversation records, each refused
// before a mailbox is woken when the credential does not match.
const RETURN=/\/return\/([A-Za-z0-9_-]{32})$/;
export async function handleConversationIngress(request,{edge,conversationEdge,deliverLink,deliverRecord,deliverResponse,now=()=>Date.now()}){
 const ok=json=>Response.json(json,{status:200,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 try{
  if(request?.method!=='POST'||!(request.body instanceof Uint8Array))protocol('malformed');
  if(request.body.byteLength>P.LIMITS.maxRequestBytes)protocol('too_large');
  const headers=Object.fromEntries(Object.entries(request.headers??{}).map(([k,v])=>[k.toLowerCase(),v])),route=RETURN.exec(new URL(request.url).pathname);
  if(route){if(request.body.byteLength>P.LIMITS.maxInvitationResponseBytes)protocol('too_large');const owner=await conversationEdge.route(route[1]);return ok(await deliverResponse(owner,{token:route[1],contentType:headers['content-type'],body:request.body}));}
  const credential=P.parseCredential(headers.authorization);
  if(credential.scheme==='BindleLink')return handleIngress(request,{edge,deliver:deliverLink,now});
  const delivery=await P.parseDelivery(headers['content-type'],request.body,{idempotencyKey:headers['idempotency-key']});
  P.checkCredentialKind(delivery.envelope,credential);
  const owner=await conversationEdge.check(credential,delivery.envelope);
  const result=await deliverRecord(owner,{contentType:headers['content-type'],body:request.body,authorization:headers.authorization,idempotencyKey:headers['idempotency-key'],ingress:request.url});
  return ok({receipt:result.receipt});
 }catch(error){return ingressError(error,now());}
}

// ---- BB-B3 authorization hook. Reads live local consent with the outbox transaction and no network I/O: a task is
// deliverable only while its recipient is an accepted, unblocked peer bound to the exact incarnation in the envelope.
// Re-acceptance issues a new incarnation, so obligations cancelled for an old one stay cancelled.
export async function authorizeConversationTask(tx,task){
 const p=task?.envelope?.payload;
 if(p?.kind==='conversation-init'){const cid=p.conversation.genesis.payload.conversationId,to={issuer:p.recipient.issuer,subject:p.recipient.owner},room=await tx.get(C.room(cid)),peer=await tx.get(C.peer(cid,to));return Boolean(room?.state==='active'&&room.role==='creator'&&['invited','accepted'].includes(peer?.state)&&!await tx.get(KEYS.block(to)));}
 if(p?.kind!=='conversation-record')return undefined;
 const r=p.record,room=await tx.get(C.room(r.conversationId)),to={issuer:p.recipient.issuer,subject:p.recipient.owner};
 if(!room||(room.state!=='active'&&!(room.state==='left'&&r.type==='leave'))||await tx.get(KEYS.block(to)))return false;
 const peer=await tx.get(C.peer(r.conversationId,to));if(peer?.state!=='accepted')return false;
 if(r.type==='peer-hello'||r.type==='rejoin')return true;
 return peer.outbound?.incarnation===p.recipient.incarnation;
}
export const withConversations=(authorize=()=>false)=>async(tx,task,owner)=>{const decision=await authorizeConversationTask(tx,task);return decision===undefined?authorize(tx,task,owner):decision;};

// ---- Durable work queued by admission (replies, introductions, catch-up), submitted by the owner drain.
const workId=w=>[w.type,w.cid??'',w.principal?pk(w.principal):'',w.about?pk(w.about):'',w.generation??'',w.proposal??''].join('|');
async function enqueue(tx,work){const id=workId(work),key=C.work(id);if(await tx.get(key))return;await tx.put(key,{...work,id,operationId:newId(),attempts:0,nextAt:0});}

// ---- Emission: allocate (stream head, event ID, frozen audience, credentials) in one transaction before signing;
// sign each recipient's envelope once; persist the prepared set; submit to BB-B3. Every phase is idempotent per
// operationId, so a crash or retry never re-allocates a counter or changes signed bytes after they are stored.
async function audienceOf(tx,room,target){
 const peers=[...(await tx.list({prefix:C.peers(room.id)})).values()];if(!target)return peers;
 const t=await tx.get(C.event(room.id,target)),members=t?.audience?.members??[];return peers.filter(p=>members.some(m=>same(m,p.principal)));
}
async function emit(ctx,{cid,type,to=null,target=null,data=null,body=null,mimeType='text/plain',secret=null,epoch=null,operationId,resendOf}){
 const {store,signer,config}=ctx;
 const op=await store.get(C.op(operationId))??await store.transaction(async tx=>{
  const existing=await tx.get(C.op(operationId));if(existing)return existing;
  const now=ctx.clock.now(),room=await tx.get(C.room(cid));
  if(!room)fault('not_found','Conversation not found.',404);
  if(room.state!=='active'&&type!=='leave')fault('conversation_inactive','This conversation is no longer active.',409);
  const recipients=[];
  for(const peer of to?[await tx.get(C.peer(cid,to))].filter(Boolean):await audienceOf(tx,room,target)){
   if(peer.state!=='accepted'||await tx.get(KEYS.block(peer.principal)))continue;
   const hello=type==='peer-hello',ingress=hello?peer.outbound?.ingress??peer.introIngress:peer.outbound?.ingress,incarnation=hello?P.HELLO_INCARNATION:peer.outbound?.incarnation;
   if(!ingress||!incarnation||(!to&&peer.ready===false))continue;
   recipients.push({principal:principal(peer.principal),incarnation,ingress,peer});
  }
  if(to&&!recipients.length)fault('peer_unavailable','That person cannot receive this yet.',409);
  const recordEpoch=epoch??room.current,s=type==='rejoin'?null:await tx.get(C.secret(cid,recordEpoch));
  if(type!=='rejoin'&&!s)fault('secret_unavailable','This conversation is waiting for its secret.',409);
  const stream=await tx.get(C.stream(cid,signer.jkt)),counter=(stream?.counter??0)+1,previous=stream?stream.head:room.lastOwn??null;
  const recordData=typeof data==='function'?data({counter,peer:recipients[0]?.peer}):data;
  const record={type,conversationId:cid,epoch:recordEpoch,stream:signer.kid,counter,previous,parents:room.heads.slice(-P.LIMITS.maxParents),...target?{target}:{},...recordData?{data:recordData}:{}};
  const content=body?await P.contentDescriptor(mimeType,body):null;
  const payload={version:1,profile:P.PROFILE,kind:'conversation-record',noReply:false,operationId,createdAt:now,content,subject:'',optionalTags:[],author:signer.author,record,...resendOf?{resendOf}:{}};
  const eventId=await P.eventId({payload:{...payload,recipient:null},proof:{alg:'ES256',kid:signer.kid}});
  for(const r of recipients){r.credential=type==='rejoin'?null:P.formatCredential({scheme:'BindleConversation',epoch:recordEpoch,token:await P.pairToken(Uint8Array.from(s),{conversationId:cid,author:principal(config.principal),recipient:r.principal,incarnation:r.incarnation})});delete r.peer;}
  const audience=await P.freezeAudience(recipients.map(r=>({...r.principal,incarnation:r.incarnation})));
  await tx.put(C.stream(cid,signer.jkt),{jkt:signer.jkt,counter,head:eventId});
  const ev={eventId,type,author:{principal:principal(config.principal),keyId:signer.author.keyId,jkt:signer.jkt},counter,stream:signer.kid,previous,parents:record.parents,epoch:recordEpoch,target,content,createdAt:now,receivedAt:now,own:true,revisions:[],retracted:null,quarantined:false,audience,operationId};
  await tx.put(C.event(cid,eventId),ev);if(body)await tx.put(C.body(cid,eventId),Array.from(body));
  if(type==='edit'||type==='retract')await mutate(tx,room,ev);
  room.lastOwn=eventId;if(CONTENT_TYPES.has(type)){room.heads=[eventId];await projectRoom(tx,room,now);}await tx.put(C.room(cid),room);
  const row={operationId,cid,eventId,type,kid:signer.kid,payload,recipients,secret:secret?Array.from(secret):null,hasBody:Boolean(body),knownRotation:Object.keys(room.epochs).length>1,prepared:null,submitted:!recipients.length,abandoned:false,createdAt:now};
  await tx.put(C.op(operationId),row);return row;
 });
 return submitOp(ctx,op);
}
const opView=op=>({operationId:op.operationId,eventId:op.eventId,recipients:op.recipients.length,submitted:op.submitted,...op.abandoned?{abandoned:true}:{}});
async function submitOp(ctx,op){
 if(op.submitted||op.abandoned)return opView(op);
 const {store}=ctx;let prepared=op.prepared;
 if(!prepared){
  // An allocation names one delegate key; after a key change it can never be signed, so it is abandoned (its counter
  // stays a gap) and queued work re-emits under a new operation.
  if(op.kid!==ctx.signer.kid){await store.transaction(async tx=>{const cur=await tx.get(C.op(op.operationId));if(cur&&!cur.prepared){cur.abandoned=true;await tx.put(C.op(op.operationId),cur);}});return {...opView(op),abandoned:true};}
  const list=[];for(const r of op.recipients)list.push({envelope:await P.signEnvelope({...op.payload,recipient:{issuer:r.principal.issuer,owner:r.principal.subject,conversationId:op.cid,incarnation:r.incarnation}},ctx.signer),ingress:r.ingress,credential:r.credential,knownRotation:op.knownRotation});
  prepared=await store.transaction(async tx=>{const cur=await tx.get(C.op(op.operationId));if(cur.prepared)return cur.prepared;cur.prepared=list;await tx.put(C.op(op.operationId),cur);return list;});
 }
 const body=op.hasBody?Uint8Array.from(await store.get(C.body(op.cid,op.eventId))):null,secret=op.secret?Uint8Array.from(op.secret):null;
 const send=recipients=>ctx.outbox.submit({operationId:op.operationId,body,recipients:recipients.map(r=>({...r,...secret?{secret}:{}}))});
 try{await send(prepared);}
 catch(error){
  // A recipient removed between allocation and submission: submit the still-authorized subset once.
  if(error?.code!=='not_authorized')throw error;
  const allowed=await store.transaction(async tx=>{const out=[];for(const r of prepared)if(await authorizeConversationTask(tx,r))out.push(r);return out;});
  if(allowed.length)await send(allowed);
 }
 // The outbox now holds the delivery; secret parts and init envelopes (which embed the secret) leave this row (BB4-S2).
 await store.transaction(async tx=>{const cur=await tx.get(C.op(op.operationId));if(CONTENT_TYPES.has(op.type)&&prepared[0]){const ev=await tx.get(C.event(op.cid,op.eventId));await tx.put(C.event(op.cid,op.eventId),{...ev,envelope:prepared[0].envelope});}cur.submitted=true;if(cur.secret||cur.type==='conversation-init'){cur.secret=null;cur.prepared=null;}await tx.put(C.op(op.operationId),cur);});
 return {...opView(op),submitted:true};
}

// ---- Event folding: edits and retractions keep every revision (Peek); a retraction is never undone by a later edit;
// mutations that overtake their target wait, bounded, and apply only to a target by the same author (§6.3, P-8).
async function mutate(tx,room,ev){
 const target=await tx.get(C.event(room.id,ev.target));
 if(!target){
  // At most 16 pending per author, so one member cannot push out others' mutations (BB4-S8).
  let pending=await tx.get(C.mutations(room.id))??[];const theirs=pending.filter(m=>same(m.author,ev.author.principal));if(theirs.length>=16)pending=pending.filter(m=>m!==theirs[0]);
  const q=P.queueMutation(pending,{target:ev.target,author:principal(ev.author.principal),eventId:ev.eventId});await tx.put(C.mutations(room.id),q.pending);return 'pending';}
 P.checkMutationAuthor({author:principal(target.author.principal)},principal(ev.author.principal));
 if(target.type!=='message')protocol('record_forbidden');
 // Every retraction is kept, so a quarantined one never hides the author's genuine one (BB4-S6).
 if(ev.type==='edit')target.revisions=[...new Set([...target.revisions??[],ev.eventId])];else target.retractions=[...new Set([...target.retractions??[],ev.eventId])];
 await tx.put(C.event(room.id,target.eventId),target);return 'applied';
}
async function applyPending(tx,room,ev){
 const pending=await tx.get(C.mutations(room.id))??[],mine=pending.filter(m=>m.target===ev.eventId);if(!mine.length)return;
 await tx.put(C.mutations(room.id),pending.filter(m=>m.target!==ev.eventId));
 for(const m of mine){if(!same(m.author,ev.author.principal))continue;const row=await tx.get(C.event(room.id,m.eventId));if(row&&!row.quarantined)await mutate(tx,room,row);}
}
// Deterministic topological order over shared content events (genesis, messages, edits, retractions) and their parents,
// with an event-ID tie-break (§7.4): valid for the same validated set on every replica. Pairwise control records and
// stream predecessors are excluded, since replicas hold different subsets of them. Timestamps never decide order.
export function orderEvents(all){
 const rows=all.filter(e=>e.type==='genesis'||CONTENT_TYPES.has(e.type)),ids=new Set(rows.map(e=>e.eventId)),children=new Map(),indegree=new Map(rows.map(e=>[e.eventId,0]));
 for(const e of rows)for(const parent of new Set(e.parents??[]))if(ids.has(parent)&&parent!==e.eventId){indegree.set(e.eventId,indegree.get(e.eventId)+1);if(!children.has(parent))children.set(parent,[]);children.get(parent).push(e.eventId);}
 // A content event with no known parent is ordered after the genesis, never before it (BB4-S7).
 const genesis=rows.find(e=>e.type==='genesis')?.eventId;
 if(genesis)for(const e of rows)if(e.eventId!==genesis&&indegree.get(e.eventId)===0){indegree.set(e.eventId,1);if(!children.has(genesis))children.set(genesis,[]);children.get(genesis).push(e.eventId);}
 const ready=[...indegree].filter(([,n])=>!n).map(([id])=>id).sort(),out=[];
 while(ready.length){const id=ready.shift();out.push(id);for(const c of children.get(id)??[]){indegree.set(c,indegree.get(c)-1);if(!indegree.get(c)){ready.push(c);ready.sort();}}}
 return out;
}

// ---- Receive gate. Run read-only before verification and again inside the commit (live recheck).
async function admitGate(s,{cid,author,envelope,credential,me,now}){
 const p=envelope.payload,r=p.record,room=await s.get(C.room(cid));
 if(!room||room.state!=='active'||await s.get(KEYS.block(author)))protocol('not_authorized');
 const peer=await s.get(C.peer(cid,author));
 if(r.type==='rejoin'){if(peer?.state!=='accepted')protocol('not_authorized');return {room,peer,mode:'rejoin'};}
 if(room.awaitingSecret){
  if(peer?.state==='accepted'&&r.type==='secret-share'&&p.recipient.incarnation===peer.inbound)return {room,peer,mode:'awaiting'};
  // Until a secret-share arrives, accepted peers are asked to retry, but only after their signature verifies, so the
  // answer reveals nothing to anyone else (§6.6; BB4-S9).
  if(peer?.state==='accepted')return {room,peer,mode:'defer'};
  protocol('not_authorized');
 }
 if((await s.get(C.frontier(cid,author,r.stream)))?.quarantined)protocol('not_authorized');
 await P.checkPairGate(credential,envelope,await gateEntry(s,room,peer,author,me,now));
 return {room,peer,mode:r.type==='peer-hello'?'hello':'record'};
}
// Quarantine conversation events signed by a revoked delegate key at or after revokedHour - 1 h (§3.4, review S-3).
async function quarantineJkt(tx,jkt,revokedHour,now){
 for(const [key] of await tx.list({prefix:`conv/by-jkt/${jkt}/`})){const [cid,id]=key.split('/').slice(-2),ev=await tx.get(C.event(cid,id));if(ev&&!ev.quarantined&&P.quarantined(ev.createdAt,revokedHour)){ev.quarantined={reason:'delegation_revoked',at:now};await tx.put(C.event(cid,id),ev);}}
}

// Record effects inside the admission transaction. Each may queue replies; none performs network I/O.
async function onHello(tx,{room,peer,author,r,ev,config,now}){
 const binding=r.data.binding;
 if(peer?.state==='accepted'){const reply=!peer.awaitingHello;await putPeer(tx,room,{...peer,outbound:binding,awaitingHello:false,ready:true},config,now);if(reply)await enqueue(tx,{type:'hello',cid:room.id,principal:author,generation:peer.generation});return;}
 const listed=room.participants.find(x=>same(x.principal,author)&&x.keyId===ev.author.keyId);
 if(peer?.state==='listed'&&room.acceptListed&&listed&&!await tx.get(KEYS.block(author))){const row={...peer,state:'accepted',inbound:token(),outbound:binding,awaitingHello:false,ready:true,generation:(peer.generation??0)+1,via:'hello',acceptedAt:now};await admit(tx,room,row,config,now);await enqueue(tx,{type:'hello',cid:room.id,principal:author,generation:row.generation});return;}
 await offer(tx,room,{...peer??{principal:principal(author),keyId:ev.author.keyId,generation:0},state:'pending',previous:peer?.state??null,offer:{binding,eventId:ev.eventId,at:now}},config,now);
}
async function offer(tx,room,row,config,now){
 const rows=[...(await tx.list({prefix:C.peers(room.id)})).values()];
 if(!rows.some(p=>same(p.principal,row.principal))&&rows.length>=CONVERSATION_LIMITS.peers)protocol('rate_limited',{retryAfter:3600});
 if(rows.filter(p=>['pending','proposed'].includes(p.state)&&!same(p.principal,row.principal)).length>=CONVERSATION_LIMITS.pendingOffers)protocol('rate_limited',{retryAfter:3600});
 await putPeer(tx,room,row,config,now);
}
async function onProposal(tx,{room,author,r,ev,verified,config,now}){
 const about=principal(r.data.principal),listed=room.participants.find(x=>same(x.principal,about)&&x.keyId===r.data.keyId);if(same(about,config.principal)||!listed)return;
 const existing=await tx.get(C.peer(room.id,about));if(['accepted','blocked'].includes(existing?.state)||await tx.get(KEYS.block(about)))return;
 // A proposal creates no row without the proposed principal's own verified introduction (BB4-S4).
 if(!existing&&!verified.introduction)return;
 const introIngress=verified.introduction?.binding.ingress??existing?.introIngress??null;
 const base={...existing??{principal:r.data.principal,keyId:r.data.keyId,generation:0},proposedBy:principal(author),proposal:ev.eventId,introIngress};
 if(room.acceptListed&&listed&&introIngress&&(!existing||existing.state==='listed')){const row={...base,state:'accepted',inbound:token(),outbound:null,awaitingHello:true,ready:true,generation:base.generation+1,via:'proposal',acceptedAt:now};if(await admit(tx,room,row,config,now,{soft:true})){await enqueue(tx,{type:'hello',cid:room.id,principal:about,generation:row.generation});return;}}
 if(existing&&['removed','left','declined','pending'].includes(existing.state))return;
 await offer(tx,room,{...base,state:'proposed'},config,now);
}
async function onRotate(tx,{room,author,r,ev,delivery,now}){
 const epoch=r.data.newEpoch;if(room.epochs[epoch]||await tx.get(C.rotation(room.id,epoch)))return;
 // One pending proposal per proposer (its latest), and a bound overall, so one member cannot evict others' (BB4-S8).
 for(const [key,x] of await tx.list({prefix:C.rotations(room.id)}))if(x.state==='pending'&&same(x.proposer,author))await tx.delete(key);
 const rows=[...(await tx.list({prefix:C.rotations(room.id)}))].filter(([,x])=>x.state==='pending').sort(([,a],[,b])=>a.at-b.at);
 if(rows.length>=CONVERSATION_LIMITS.rotations)await tx.delete(rows[0][0]);
 await tx.put(C.rotation(room.id,epoch),{epoch,base:r.epoch,proposer:principal(author),secret:Array.from(delivery.secret),secretDigest:r.data.secretDigest,at:now,eventId:ev.eventId,state:'pending'});
}
async function onRejoin(tx,{room,peer,author,r,config,now}){
 const day=Math.floor(now/DAY),used=peer.rejoin?.day===day?peer.rejoin.count:0;
 if(used>=CONVERSATION_LIMITS.rejoinPerDay)protocol('rate_limited',{retryAfter:Math.max(1,Math.ceil(((day+1)*DAY-now)/1000))});
 const row={...peer,outbound:r.data.binding,inbound:token(),awaitingHello:true,ready:true,generation:(peer.generation??0)+1,rejoin:{day,count:used+1}};
 await putPeer(tx,room,row,config,now);
 await enqueue(tx,{type:'secret-share',cid:room.id,principal:author,generation:row.generation});await enqueue(tx,{type:'hello',cid:room.id,principal:author,generation:row.generation});
}
// Rejoining mailbox: the share is bound to the incarnation this mailbox issued in its rejoin; the secret must match the
// digest this mailbox recorded for that epoch (control state survives an app switch, secrets do not), and the
// presented pair token must verify under it. A member therefore cannot plant an unknown epoch or a wrong secret.
async function onSecretShare(tx,{room,peer,author,r,mode,delivery,credential,config,now}){
 if(mode!=='awaiting'||r.data.epoch!==r.epoch)return;
 const expected=await P.pairToken(delivery.secret,{conversationId:room.id,author:principal(author),recipient:principal(config.principal),incarnation:peer.inbound});
 if(!equalDigest(expected,credential.token))protocol('not_authorized');
 if(!room.epochs[r.epoch]?.digest||!equalDigest(room.epochs[r.epoch].digest,r.data.secretDigest))protocol('not_authorized');
 if(await tx.get(C.secret(room.id,r.epoch)))return;
 await tx.put(C.secret(room.id,r.epoch),Array.from(delivery.secret));
 if(!await tx.get(C.secret(room.id,room.current)))room.current=r.epoch;
 room.awaitingSecret=false;
}

async function projectRoom(tx,room,now){room.activityRevision=(room.activityRevision??0)+1;await projectIncoming(tx,{id:room.id,type:'conversation',kind:'conversation',subject:room.subject,receivedAt:room.createdAt,activityAt:now,activityRevision:room.activityRevision});}

// ---- Owner configuration.
export class ConversationsConfigure extends MailboxAction {
 static operation='conversations.configure';static deps=['conversations'];static changes='conversations-changed';
 async run({conversations:h}){
  actorOwner(this.actor);const {maxParticipants=P.LIMITS.maxParticipants,identityDocument=null}=this.input??{};
  if(!Number.isSafeInteger(maxParticipants)||maxParticipants<2||maxParticipants>P.LIMITS.maxParticipants)invalid('Choose a group size between 2 and 32.');
  if(identityDocument!==null){try{const u=new URL(identityDocument);if(u.protocol!=='https:'||u.href!==identityDocument)throw new Error();}catch{invalid('Choose a valid identity document.');}}
  const settings={maxParticipants,identityDocument};await h.store.transaction(tx=>tx.put(C.settings,settings));return settings;
 }
}

// ---- Create and invite (§6.1). Participants: [{principal, keyId, link, ingress}], where `link` is the invitee's contact
// link and `ingress` its resolved descriptor ingress (descriptor resolution belongs to the composition).
export class ConversationsCreate extends MailboxAction {
 static operation='conversations.create';static deps=['conversations','outbox','delegateKeys','clock'];static changes='conversations-changed';
 async run({conversations:h,outbox,delegateKeys,clock}){
  actorOwner(this.actor);const store=h.store,now=clock.now(),config=await readConfig(store),settings=await settingsOf(store),input=this.input??{};
  const subject=input.subject??'',text=textOf(input.text??'',P.LIMITS.maxBodyBytes),operationId=operationOf(input.operationId);
  if(typeof subject!=='string'||[...subject].length>200||/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(subject))invalid('Choose a shorter subject.');
  const people=input.participants;if(!Array.isArray(people)||!people.length)invalid('Choose who to invite.');
  if(people.length+1>settings.maxParticipants)fault('participants_exceeded','That group is larger than you accept.',403);
  const prior=await store.get(C.op(operationId));if(prior)return {conversationId:prior.cid,...await submitOp({store,outbox,signer:await snapshot(delegateKeys,config,settings,now),config,clock},prior)};
  if([...(await store.list({prefix:C.rooms})).values()].filter(r=>r.state==='active').length>=CONVERSATION_LIMITS.liveConversations)fault('limit_reached','Too many conversations.',409);
  const signer=await snapshot(delegateKeys,config,settings,now),seen=new Set([pk(config.principal)]),invitees=[];
  for(const x of people){
   try{P.validatePrincipal(x?.principal);if(typeof x.keyId!=='string'||!x.keyId||x.keyId.length>200)throw new Error();const u=new URL(x.ingress);if(u.protocol!=='https:'||u.search||u.hash||u.href!==x.ingress)throw new Error();}catch{invalid('Choose valid participants.');}
   const {meta}=parseLinkURL(x.link),{claims:c}=contactMeta(meta);
   if(c.iss!==x.principal.issuer||c.sub!==x.principal.subject||!c.kinds.includes('conversation-init')||c.exp*1000<=now)invalid('That contact link cannot carry an invitation.');
   if(seen.has(pk(x.principal)))invalid('Choose each person once.');seen.add(pk(x.principal));
   invitees.push({principal:{issuer:x.principal.issuer,subject:x.principal.subject,identityURI:x.principal.identityURI},keyId:x.keyId,ingress:x.ingress,meta,recipient:{issuer:c.iss,owner:c.sub,contactId:c.jti,resource:c.resource},incarnation:token(),nonce:token(16),route:token(24)});
  }
  const cid=newId(),epoch=newId(),secret=globalThis.crypto.getRandomValues(new Uint8Array(32)),body=te.encode(text),content=await P.contentDescriptor('text/plain',body),expiresAt=now+CONVERSATION_LIMITS.bootstrapMs;
  const participants=[{principal:signer.author.principal,keyId:signer.author.keyId},...invitees.map(i=>({principal:i.principal,keyId:i.keyId}))];
  const genesis=await P.signGenesis({version:1,profile:P.PROFILE,conversationId:cid,createdAt:now,creator:signer.author,participants,secretEpoch:epoch,secretDigest:await P.secretDigest(secret),subject,content},signer),genesisDigest=await P.genesisDigest(genesis);
  const recipients=[];
  for(const i of invitees){
   const returnControl={resource:`${config.ingress}/return/${i.route}`,nonce:i.nonce,expiresAt,maxResponseBytes:P.LIMITS.maxInvitationResponseBytes};
   const envelope=await P.signEnvelope({version:1,profile:P.PROFILE,kind:'conversation-init',noReply:false,operationId,createdAt:now,recipient:i.recipient,content,subject,optionalTags:[],author:signer.author,conversation:{genesis,sharedSecret:P.base64url(secret),returnControl,creatorBinding:bindingOf(config,settings,i.incarnation)}},signer);
   recipients.push({envelope,ingress:i.ingress,credential:`BindleLink ${i.meta}`});
  }
  const room={id:cid,role:'creator',state:'active',subject,createdAt:now,creator:{principal:signer.author.principal,keyId:signer.author.keyId},participants,genesisDigest,genesisEpoch:epoch,secretDigest:genesis.payload.secretDigest,acceptListed:false,epochs:{[epoch]:{until:null,digest:genesis.payload.secretDigest}},current:epoch,maxParticipants:settings.maxParticipants,heads:[genesisDigest],lastOwn:null,placeholders:0,gap:false,awaitingSecret:false};
  const op=await store.transaction(async tx=>{
   const existing=await tx.get(C.op(operationId));if(existing)return existing;
   await projectRoom(tx,room,now);await tx.put(C.room(cid),room);await tx.put(C.secret(cid,epoch),Array.from(secret));
   await tx.put(C.event(cid,genesisDigest),{signedGenesis:genesis,eventId:genesisDigest,type:'genesis',author:{principal:principal(signer.author.principal),keyId:signer.author.keyId,jkt:signer.jkt},parents:[],previous:null,content,createdAt:now,receivedAt:now,own:true,revisions:[],retracted:null,quarantined:false});
   await tx.put(C.body(cid,genesisDigest),Array.from(body));
   for(const i of invitees){
    await tx.put(C.invite(cid,i.principal),{principal:i.principal,nonce:i.nonce,incarnation:i.incarnation,expiresAt,route:i.route,response:null});
    await tx.put(C.route(i.route),{cid,principal:principal(i.principal)});await queueEdge(tx,{kind:'route',token:i.route});
    await putPeer(tx,room,{principal:i.principal,keyId:i.keyId,state:'invited',inbound:i.incarnation,outbound:null,ready:true,generation:0,via:'invitation'},config,now);
   }
   const row={operationId,cid,eventId:genesisDigest,type:'conversation-init',kid:signer.kid,recipients:[],prepared:recipients,secret:null,hasBody:true,submitted:false,abandoned:false,createdAt:now};
   await tx.put(C.op(operationId),row);return row;
  });
  const result=await submitOp({store,outbox,signer,config,clock},op);
  return {conversationId:op.cid,...result};
 }
}

// Pending invitations admitted by BB-B2 (contact link, conversation-init). The roster is the creator's unverified proposal.
export class ConversationsInvitations extends MailboxQuery {
 static operation='conversations.invitations';static deps=['conversations'];static refreshOn=['incoming-changed','conversations-changed'];
 async fetch({conversations:h}){
  actorOwner(this.actor);const out=[];
  for(const [,item] of await h.store.list({prefix:'item/'})){
   if(item.kind!=='conversation-init'||item.quarantined||!['inbox','pending'].includes(item.state)||await h.store.get(C.decided(item.id)))continue;
   const g=item.envelope.payload.conversation.genesis.payload;
   out.push({itemId:item.id,conversationId:g.conversationId,creator:principal(g.creator.principal),subject:g.subject,proposedParticipants:g.participants.map(x=>principal(x.principal)),rosterVerified:false,expiresAt:item.envelope.payload.conversation.returnControl.expiresAt,request:Boolean(item.request)});
  }
  return {invitations:out};
 }
}

// Invitation responses are sent directly to the creator's return control (they are not envelopes), retried with
// backoff until expiresAt. Identical bytes are resent, so the creator's single-use nonce answers a retry with its
// stored result. The creator joins this owner's audience only after its response is confirmed.
async function sendResponse(store,egress,clock,cid){
 const row=await store.get(C.response(cid));if(!row||row.state!=='pending')return row;
 let status=0;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{const res=await egress.fetch(row.resource,{method:'POST',redirect:'manual',credentials:'omit',signal:controller.signal,headers:{'Content-Type':'application/json'},body:te.encode(P.jcs(row.response))});status=res.status;await res.body?.cancel?.().catch(()=>{});}catch{status=0;}finally{clearTimeout(timer);}
 return store.transaction(async tx=>{
  const cur=await tx.get(C.response(cid));if(!cur||cur.state!=='pending')return cur;const now=clock.now();cur.attempts++;cur.status=status;
  if(status===200){cur.state='delivered';if(cur.decision==='accept'){const peer=await tx.get(C.peer(cid,cur.creator));if(peer){peer.ready=true;await tx.put(C.peer(cid,cur.creator),peer);}}}
  else if([400,401,403,409,410,413,415].includes(status))cur.state='failed';
  else{cur.nextAt=now+Math.min(HOUR,5000*2**Math.min(10,cur.attempts));if(cur.nextAt>=cur.expiresAt||cur.attempts>=CONVERSATION_LIMITS.responseAttempts)cur.state='expired';}
  await tx.put(C.response(cid),cur);return cur;
 });
}

export class ConversationsAccept extends MailboxAction {
 static operation='conversations.accept';static deps=['conversations','delegateKeys','egress','clock'];static changes='conversations-changed';
 async run({conversations:h,delegateKeys,egress,clock}){
  actorOwner(this.actor);const store=h.store,now=clock.now(),config=await readConfig(store),settings=await settingsOf(store),{itemId,decision='accept',acceptListed=false}=this.input??{};
  if(typeof itemId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(itemId)||!['accept','decline'].includes(decision)||typeof acceptListed!=='boolean')invalid('Choose an invitation.');
  const item=await store.get(KEYS.item(itemId));if(!item||item.kind!=='conversation-init'||item.quarantined)fault('not_found','Invitation not found.',404);
  const decided=await store.get(C.decided(itemId));if(decided)return {conversationId:decided.conversationId,decision:decided.decision,response:(await store.get(C.response(decided.conversationId)))?.state??null};
  const envelope=await P.validateEnvelope(item.envelope),p=envelope.payload,c=p.conversation,g=c.genesis.payload,cid=g.conversationId;
  if(!same(item.author.principal,p.author.principal))fault('not_found','Invitation not found.',404);
  if(c.returnControl.expiresAt<=now)fault('invitation_expired','This invitation has expired.',410);
  if(decision==='accept'&&g.participants.length>settings.maxParticipants)fault('participants_exceeded','That group is larger than you accept.',403);
  // A second invitation reusing a conversation ID (a resend or a spoof) never touches the first one's room or response (BB4-S1).
  if(await store.get(C.room(cid))||await store.get(C.response(cid)))fault('conversation_conflict','You already answered an invitation to this conversation.',409);
  if(await store.get(KEYS.block(principal(p.author.principal))))fault('not_found','Invitation not found.',404);
  const signer=await snapshot(delegateKeys,config,settings,now),inbound=token(),genesisDigest=await P.genesisDigest(c.genesis);
  const response=await P.signInvitationResponse({version:1,profile:P.PROFILE,conversationId:cid,genesisDigest,nonce:c.returnControl.nonce,decision,...decision==='accept'?{acceptListed,binding:bindingOf(config,settings,inbound)}:{},responder:signer.author,createdAt:now},signer);
  const creator=principal(g.creator.principal),secret=P.fromBase64url(c.sharedSecret,32);
  await store.transaction(async tx=>{
   if(await tx.get(C.decided(itemId)))return;
   if(await tx.get(C.room(cid))||await tx.get(C.response(cid)))fault('conversation_conflict','You already answered an invitation to this conversation.',409);
   await tx.put(C.decided(itemId),{decision,at:now,conversationId:cid});
   // Once decided, the secret is removed from the admitted invitation item, so it lives only under conv/secret/.
   const admitted=await tx.get(KEYS.item(itemId));if(admitted?.envelope?.payload?.conversation){delete admitted.envelope.payload.conversation.sharedSecret;admitted.secretRedacted=true;await tx.put(KEYS.item(itemId),admitted);}
   await tx.put(C.response(cid),{resource:c.returnControl.resource,response,expiresAt:c.returnControl.expiresAt,decision,creator,state:'pending',attempts:0,nextAt:now});
   if(decision!=='accept')return;
   if([...(await tx.list({prefix:C.rooms})).values()].filter(r=>r.state==='active').length>=CONVERSATION_LIMITS.liveConversations)fault('limit_reached','Too many conversations.',409);
   const room={id:cid,role:'invitee',state:'active',subject:g.subject,createdAt:g.createdAt,creator:{principal:creator,keyId:g.creator.keyId},participants:g.participants,genesisDigest,genesisEpoch:g.secretEpoch,secretDigest:g.secretDigest,acceptListed,epochs:{[g.secretEpoch]:{until:null,digest:g.secretDigest}},current:g.secretEpoch,maxParticipants:settings.maxParticipants,heads:[genesisDigest],lastOwn:null,placeholders:0,gap:false,awaitingSecret:false,itemId};
   await projectRoom(tx,room,now);await tx.put(C.room(cid),room);await tx.put(C.secret(cid,g.secretEpoch),Array.from(secret));
   const body=await tx.get(KEYS.body(itemId));
   await tx.put(C.event(cid,genesisDigest),{signedGenesis:c.genesis,eventId:genesisDigest,type:'genesis',author:{principal:creator,keyId:g.creator.keyId,jkt:P.jktOf(g.creator.delegate)},parents:[],previous:null,content:g.content,createdAt:g.createdAt,receivedAt:now,own:false,revisions:[],retracted:null,quarantined:false});
   if(body)await tx.put(C.body(cid,genesisDigest),Array.from(body));
   await putPeer(tx,room,{principal:g.creator.principal,keyId:g.creator.keyId,state:'accepted',inbound,outbound:c.creatorBinding,ready:false,epoch:g.secretEpoch,generation:1,via:'invitation',acceptedAt:now},config,now);
   for(const x of g.participants)if(!same(x.principal,creator)&&!same(x.principal,config.principal))await putPeer(tx,room,{principal:x.principal,keyId:x.keyId,state:'listed',inbound:null,outbound:null,ready:true,generation:0,via:'genesis'},config,now);
  });
  const sent=await sendResponse(store,egress,clock,cid);
  return {conversationId:cid,decision,response:sent?.state??null};
 }
}

// Creator side of §6.2: nonce, conversation, genesis digest, participant and expiry before any crypto (S-11).
export class ConversationsRespond extends MailboxAction {
 static operation='conversations.respond';static deps=['conversations','directory','clock'];static changes='conversations-changed';
 async run({conversations:h,directory,clock}){
  actorOwner(this.actor,['ingress']);const store=h.store,now=clock.now(),{token:t,body,contentType}=this.input??{};
  if(typeof t!=='string'||!(body instanceof Uint8Array)||!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(contentType??''))protocol('malformed');
  await requireRestored(store);
  const route=await store.get(C.route(t));if(!route)protocol('not_authorized');
  const v=await P.validateInvitationResponse(P.strictJSON(body,{maxBytes:P.LIMITS.maxInvitationResponseBytes}));
  const room=await store.get(C.room(route.cid)),invite=await store.get(C.invite(route.cid,route.principal));
  if(!room||!invite||room.role!=='creator'||!same(v.payload.responder.principal,route.principal))protocol('not_authorized');
  const invitation={conversationId:room.id,genesisDigest:room.genesisDigest,nonce:invite.nonce,participants:room.participants,expiresAt:invite.expiresAt};
  P.precheckInvitationResponse(v,{...invitation,now});
  const digest=await P.payloadDigest(v);if(P.invitationDecision(invite.response,digest)==='replay')return invite.response.result;
  const ports=verificationPorts({directory,store,now});
  const verified=await P.verifyInvitationResponse(v,{invitation,resolveKey:ports.resolveKey,status:ports.status,now});
  const config=await readConfig(store);
  return store.transaction(async tx=>{
   await requireRestored(tx);const inv=await tx.get(C.invite(room.id,route.principal));if(P.invitationDecision(inv.response,digest)==='replay')return inv.response.result;
   const live=await tx.get(C.room(room.id));if(!live||live.state!=='active'||await tx.get(KEYS.block(route.principal)))protocol('not_authorized');
   const peer=await tx.get(C.peer(room.id,route.principal));let state='declined';
   if(verified.decision==='accept'){
    await admit(tx,live,{...peer,state:'accepted',inbound:inv.incarnation,outbound:verified.binding,ready:true,epoch:live.genesisEpoch,generation:(peer?.generation??0)+1,via:'invitation',acceptListed:verified.acceptListed,acceptedAt:now},config,now);state='accepted';
    await tx.put(C.intro(room.id,route.principal),verified.response);
    // Relay each accepted participant's own signed response to the others (§6.3 peer-proposal introductions).
    for(const [,other] of await tx.list({prefix:C.intros(room.id)})){const about=principal(other.payload.responder.principal);if(same(about,route.principal))continue;await enqueue(tx,{type:'introduce',cid:room.id,principal:route.principal,about});await enqueue(tx,{type:'introduce',cid:room.id,principal:about,about:route.principal});}
   }else await putPeer(tx,live,{...peer,state:'declined',inbound:null},config,now);
   const result={result:{state}};await tx.put(C.invite(room.id,route.principal),{...inv,response:{responseDigest:digest,result}});return result;
  });
 }
}

// ---- Conversation records received through the conversation edge.
export class ConversationsReceive extends MailboxAction {
 static operation='conversations.receive';static deps=['conversations','directory','delegateKeys','clock'];static changes='conversations-changed';
 async run({conversations:h,directory,delegateKeys,clock}){
  actorOwner(this.actor,['ingress']);const store=h.store,now=clock.now(),config=await readConfig(store),settings=await settingsOf(store),me=config.principal;
  const {contentType,body,authorization,idempotencyKey,ingress}=this.input??{};
  await requireRestored(store);if(ingress!==config.ingress)protocol('ingress_moved');
  const credential=P.parseCredential(authorization),delivery=await P.parseDelivery(contentType,body,{idempotencyKey}),envelope=delivery.envelope,p=envelope.payload;
  if(p.kind!=='conversation-record')protocol('not_authorized');
  P.checkCredentialKind(envelope,credential);
  const r=p.record,cid=r.conversationId,author=principal(p.author.principal),gate={cid,author,envelope,credential,me,now};
  if(p.recipient.issuer!==me.issuer||p.recipient.owner!==me.subject||same(author,me))protocol('not_authorized');
  const early=await admitGate(store,gate);
  P.checkWindow(envelope,now);
  const replayId=await P.sha256(globalThis.crypto,P.replayKey(envelope)),prior=await store.get(C.replay(replayId));
  await requireRestored(store,{envelope,replay:!!prior});
  // Owner-level pre-check only (no author identity yet, so it is not an oracle) before any crypto.
  if(!prior)chargeAllowance(await store.get(ALLOWANCE_KEY),{now,check:true});
  const learned=[],ports=verificationPorts({directory,store,now,learned});let verified;
  try{verified=await P.verifyEnvelope(envelope,{resolveKey:ports.resolveKey,status:ports.status,now});}
  catch(error){if(learned.length)await store.transaction(async tx=>{for(const l of learned){await recordRevocation(tx,{...l,now});await quarantineJkt(tx,l.jkt,l.revokedHour,now);}}).catch(()=>{});throw error;}
  const a=verified.author;
  if(early.mode==='defer')protocol('recipient_unavailable',{retryAfter:30});
  if(!P.statusRequired(envelope)&&await knownRevoked({directory,store,now},a.jkt))protocol('author_unverifiable',{revoked:true});
  const signer=await receiptSnapshot(delegateKeys,config,settings,now);
  const receipt=await P.signReceipt(await P.receiptPayload(envelope,{recipient:me,ingress:config.ingress,receivedAt:now,bodyDigest:delivery.bodyDigest}),signer);
  return store.transaction(async tx=>{
   await requireRestored(tx,{envelope,replay:!!await tx.get(C.replay(replayId))});const {room,peer,mode}=await admitGate(tx,gate);if(mode==='defer')protocol('recipient_unavailable',{retryAfter:30});
   if(await tx.get(KEYS.revoked(a.jkt)))protocol('author_unverifiable',{revoked:true});
   const prior=await tx.get(C.replay(replayId)),outcome=P.replayDecision(prior,{payloadDigest:delivery.payloadDigest,eventId:verified.eventId});
   if(outcome==='replay')return {receipt:prior.receipt,replay:true};
   const fkey=C.frontier(cid,author,r.stream),front=await tx.get(fkey);
   if(outcome==='equivocation'){
    // Keep both as evidence, never apply the later one, and stop the stream until the owner acts (§6.5).
    await tx.put(C.evidence(cid,verified.eventId),{eventId:verified.eventId,conflictsWith:prior.eventId,author:principal(author),stream:r.stream,counter:r.counter,envelope,at:now});
    await tx.put(fkey,{...front??P.streamState(1),quarantined:{at:now,evidence:[prior.eventId,verified.eventId]}});
    return {receipt,replay:false,equivocation:true};
   }
   if(outcome==='duplicate-event'){await tx.put(C.replay(replayId),{...prior,contexts:[...prior.contexts??[],delivery.payloadDigest].slice(-8)});return {receipt,replay:false,duplicate:true};}
   const start=r.type==='peer-hello'?Math.min(r.data.startCounter,r.counter):1,admitted=P.admitCounter(front??P.streamState(start),r.counter,{now});
   if(admitted.status==='duplicate'&&await tx.get(C.event(cid,verified.eventId)))return {receipt,replay:false,duplicate:true};
   // New streams are bounded per author (a key change opens one), so one member cannot exhaust others' (BB4-S8).
   if(!front&&((await tx.list({prefix:C.frontiers(cid)})).size>=CONVERSATION_LIMITS.peers*4||(await tx.list({prefix:`conv/frontier/${cid}/${pk(author)}/`})).size>=8))protocol('rate_limited',{retryAfter:3600});
   // Every admitted record is charged (control records at zero bytes), so no record type grows rows without bound.
   await tx.put(ALLOWANCE_KEY,chargeAllowance(await tx.get(ALLOWANCE_KEY),{now,key:`${cid}|${pk(author)}`,bytes:delivery.body?.byteLength??0}));
   const ev={envelope,eventId:verified.eventId,type:r.type,author:{principal:principal(a.principal),keyId:a.keyId,jkt:a.jkt},counter:r.counter,stream:r.stream,previous:r.previous,parents:r.parents,epoch:r.epoch,target:r.target??null,content:p.content,createdAt:p.createdAt,receivedAt:now,own:false,revisions:[],retracted:null,quarantined:false,continuation:!front&&r.counter===1&&r.previous!==null,...p.resendOf?{resendOf:p.resendOf}:{}};
   await tx.put(C.event(cid,ev.eventId),ev);if(delivery.body&&BODY_TYPES.has(r.type))await tx.put(C.body(cid,ev.eventId),Array.from(delivery.body));
   const args={room,peer,author,r,ev,verified,delivery,credential,mode,config,now};
   switch(r.type){
    case 'message':await applyPending(tx,room,ev);break;
    case 'edit':case 'retract':await mutate(tx,room,ev);break;
    case 'peer-proposal':await onProposal(tx,args);break;
    case 'peer-response':await tx.put(C.peer(cid,author),{...peer,responses:Object.fromEntries([...Object.entries(peer.responses??{}).filter(([k])=>k!==r.data.proposal),[r.data.proposal,r.data.decision]].slice(-16))});break;
    case 'peer-hello':await onHello(tx,args);break;
    case 'rotate':await onRotate(tx,args);break;
    case 'rejoin':await onRejoin(tx,args);break;
    case 'secret-share':await onSecretShare(tx,args);break;
    case 'leave':await putPeer(tx,room,{...peer,state:'left',inbound:null,outbound:null,generation:(peer.generation??0)+1},config,now);break;
    case 'ingress':await tx.put(C.peer(cid,author),{...peer,outbound:r.data.binding});break;
   }
   // Causal bookkeeping: placeholders for missing parents, collapsing into one gap marker past 64 (§6.3).
   if(await tx.get(C.placeholder(cid,ev.eventId))){await tx.delete(C.placeholder(cid,ev.eventId));room.placeholders=Math.max(0,room.placeholders-1);}
   const known=new Set();for(const id of r.parents)if(await tx.get(C.event(cid,id))||await tx.get(C.placeholder(cid,id)))known.add(id);
   const plan=P.placeholderPlan(r.parents,known,room.placeholders);for(const id of plan.placeholders)await tx.put(C.placeholder(cid,id),{at:now});room.placeholders+=plan.placeholders.length;if(plan.collapsed)room.gap=true;
   if(CONTENT_TYPES.has(r.type))room.heads=[...room.heads.filter(id=>!r.parents.includes(id)),ev.eventId].slice(-P.LIMITS.maxParents);
   if(CONTENT_TYPES.has(r.type))await projectRoom(tx,room,now);await tx.put(C.room(cid),room);if(r.type==='secret-share'&&mode==='awaiting'&&!room.awaitingSecret)await publishRoom(tx,room,config,now);
   await tx.put(fkey,{...admitted.state,start:front?.start??start});
   await tx.put(C.replay(replayId),{payloadDigest:delivery.payloadDigest,eventId:ev.eventId,receipt,retainUntil:P.retainUntil(envelope,now)});
   await tx.put(C.byJkt(a.jkt,cid,ev.eventId),1);
   const current=await tx.get(C.peer(cid,author));if(current){current.lastSeen=now;if(mode!=='rejoin'&&mode!=='awaiting')current.epoch=r.epoch;await tx.put(C.peer(cid,author),current);}
   // Any authenticated record from a peer starts catch-up of its expired in-window obligations (architecture §9.6).
   await enqueue(tx,{type:'catch-up',principal:author});
   return {receipt,replay:false};
  });
 }
}

// ---- Owner operations that emit records.
const ownerContext=async({conversations:h,outbox,delegateKeys,clock})=>{const store=h.store,config=await readConfig(store),settings=await settingsOf(store);return {store,outbox,config,settings,clock,signer:await snapshot(delegateKeys,config,settings,clock.now())};};
async function activeRoom(store,cid){const room=await store.get(C.room(cidOf(cid)));if(!room||room.state!=='active')fault('not_found','Conversation not found.',404);return room;}
async function ownMessage(store,cid,target){const t=typeof target==='string'?await store.get(C.event(cid,target)):null;if(!t||!t.own||t.type!=='message')fault('not_found','Message not found.',404);return t;}
const EMITTING=['conversations','outbox','delegateKeys','clock'];

export class ConversationsSend extends MailboxAction {
 static operation='conversations.send';static deps=EMITTING;static changes='conversations-changed';
 async run(deps){actorOwner(this.actor);const ctx=await ownerContext(deps),{conversationId,text,operationId}=this.input??{};await activeRoom(ctx.store,conversationId);return emit(ctx,{cid:conversationId,type:'message',body:te.encode(textOf(text,P.LIMITS.maxBodyBytes)),operationId:operationOf(operationId)});}
}
export class ConversationsEdit extends MailboxAction {
 static operation='conversations.edit';static deps=EMITTING;static changes='conversations-changed';
 async run(deps){actorOwner(this.actor);const ctx=await ownerContext(deps),{conversationId,target,text,operationId}=this.input??{};await activeRoom(ctx.store,conversationId);const t=await ownMessage(ctx.store,conversationId,target);if(t.retractions?.length)fault('conflict','That message was deleted.',409);return emit(ctx,{cid:conversationId,type:'edit',target,body:te.encode(textOf(text,P.LIMITS.maxBodyBytes)),operationId:operationOf(operationId)});}
}
export class ConversationsRetract extends MailboxAction {
 static operation='conversations.retract';static deps=EMITTING;static changes='conversations-changed';
 async run(deps){actorOwner(this.actor);const ctx=await ownerContext(deps),{conversationId,target,operationId}=this.input??{};await activeRoom(ctx.store,conversationId);await ownMessage(ctx.store,conversationId,target);return emit(ctx,{cid:conversationId,type:'retract',target,operationId:operationOf(operationId)});}
}
// Rotation is a proposal (§6.5): the proposer selects it locally; others choose explicitly. The previous epoch stays
// accepted for 7 days after selection.
async function selectEpoch(tx,room,epoch,secret,config,now){
 await tx.put(C.secret(room.id,epoch),Array.from(secret));
 for(const [id,e] of Object.entries(room.epochs))if(e.until===null&&id!==epoch)room.epochs[id]={...e,until:now+P.LIMITS.rotationOverlapMs};
 room.epochs[epoch]={until:null,digest:await P.secretDigest(secret)};room.current=epoch;await tx.put(C.room(room.id),room);await publishRoom(tx,room,config,now);
}
export class ConversationsRotate extends MailboxAction {
 static operation='conversations.rotate';static deps=EMITTING;static changes='conversations-changed';
 async run(deps){
  actorOwner(this.actor);const ctx=await ownerContext(deps),{conversationId,operationId}=this.input??{},room=await activeRoom(ctx.store,conversationId),op=operationOf(operationId);
  const prior=await ctx.store.get(C.op(op));if(prior)return submitOp(ctx,prior);
  const epoch=newId(),secret=globalThis.crypto.getRandomValues(new Uint8Array(32));
  const sent=await emit(ctx,{cid:room.id,type:'rotate',data:{newEpoch:epoch,secretDigest:await P.secretDigest(secret)},secret,epoch:room.current,operationId:op});
  await ctx.store.transaction(async tx=>{const live=await tx.get(C.room(room.id));await selectEpoch(tx,live,epoch,secret,ctx.config,ctx.clock.now());});
  return {...sent,epoch};
 }
}
export class ConversationsSelectRotation extends MailboxAction {
 static operation='conversations.select-rotation';static deps=['conversations','clock'];static changes='conversations-changed';
 async run({conversations:h,clock}){
  actorOwner(this.actor);const {conversationId,epoch,decision}=this.input??{},store=h.store,config=await readConfig(store);await activeRoom(store,conversationId);
  if(!isUUID(epoch)||!['accept','decline'].includes(decision))invalid('Choose a rotation.');
  return store.transaction(async tx=>{
   const room=await tx.get(C.room(conversationId)),row=await tx.get(C.rotation(conversationId,epoch));if(!row||row.state!=='pending')fault('not_found','Rotation not found.',404);
   if(decision==='accept'){await selectEpoch(tx,room,epoch,Uint8Array.from(row.secret),config,clock.now());const proposer=await tx.get(C.peer(conversationId,row.proposer));if(proposer)await tx.put(C.peer(conversationId,row.proposer),{...proposer,epoch});}
   await tx.put(C.rotation(conversationId,epoch),{...row,secret:null,state:decision==='accept'?'selected':'declined',decidedAt:clock.now()});
   return {epoch,decision,current:room.current};
  });
 }
}
// Owner decision on a proposal or a hello offer. Accepting issues a fresh incarnation and starts (or answers) a hello.
export class ConversationsDecide extends MailboxAction {
 static operation='conversations.decide';static deps=['conversations','clock'];static changes='conversations-changed';
 async run({conversations:h,clock}){
  actorOwner(this.actor);const {conversationId,principal:who,decision}=this.input??{},store=h.store,config=await readConfig(store),now=clock.now();await activeRoom(store,conversationId);
  if(!['accept','decline'].includes(decision)||typeof who?.issuer!=='string'||typeof who?.subject!=='string')invalid('Choose a person and a decision.');
  return store.transaction(async tx=>{
   const room=await tx.get(C.room(conversationId)),peer=await tx.get(C.peer(conversationId,who));if(!peer||!['pending','proposed'].includes(peer.state))fault('not_found','Nothing is waiting for that person.',404);
   if(await tx.get(KEYS.block(who)))fault('forbidden','That person is blocked.',403);
   if(decision==='decline'){await putPeer(tx,room,{...peer,state:'declined',offer:null,inbound:null},config,now);}
   else{
    const binding=peer.offer?.binding??null,row={...peer,state:'accepted',inbound:token(),outbound:binding,awaitingHello:!binding,ready:true,offer:null,generation:(peer.generation??0)+1,via:peer.state==='proposed'?'proposal':'hello',acceptedAt:now};
    if(!binding&&!peer.introIngress)fault('conflict','There is no verified address for that person yet.',409);
    try{await admit(tx,room,row,config,now);}catch(error){if(error?.code==='participants_exceeded')fault('participants_exceeded','This conversation is at your group size limit.',403);throw error;}
    await enqueue(tx,{type:'hello',cid:room.id,principal:who,generation:row.generation});
   }
   if(peer.proposedBy&&peer.proposal)await enqueue(tx,{type:'peer-response',cid:room.id,principal:peer.proposedBy,proposal:peer.proposal,decision});
   return {principal:principal(who),state:decision==='accept'?'accepted':'declined'};
  });
 }
}
// Local removal: invalidates the incarnation now (edge and mailbox refuse late records) and cancels obligations to the
// peer through the outbox authorization hook. Readmission issues a fresh incarnation through a hello.
export class ConversationsRemove extends MailboxAction {
 static operation='conversations.remove';static deps=['conversations','clock'];static changes='conversations-changed';
 async run({conversations:h,clock}){
  actorOwner(this.actor);const {conversationId,principal:who}=this.input??{},store=h.store,config=await readConfig(store),now=clock.now();await activeRoom(store,conversationId);
  return store.transaction(async tx=>{const room=await tx.get(C.room(conversationId)),peer=await tx.get(C.peer(conversationId,who??{}));if(!peer||peer.state!=='accepted')fault('not_found','That person is not in this conversation.',404);
   await putPeer(tx,room,{...peer,state:'removed',inbound:null,awaitingHello:false,generation:(peer.generation??0)+1,removedAt:now},config,now);
   for(const [key,w] of await tx.list({prefix:C.works}))if(w.principal&&same(w.principal,who)&&w.cid===conversationId)await tx.delete(key);
   return {principal:principal(who),state:'removed'};});
 }
}
export class ConversationsReadmit extends MailboxAction {
 static operation='conversations.readmit';static deps=['conversations','clock'];static changes='conversations-changed';
 async run({conversations:h,clock}){
  actorOwner(this.actor);const {conversationId,principal:who}=this.input??{},store=h.store,config=await readConfig(store),now=clock.now();await activeRoom(store,conversationId);
  return store.transaction(async tx=>{const room=await tx.get(C.room(conversationId)),peer=await tx.get(C.peer(conversationId,who??{}));if(!peer||!['removed','left'].includes(peer.state)||!(peer.outbound?.ingress||peer.introIngress))fault('not_found','That person cannot be readmitted.',404);
   if(await tx.get(KEYS.block(who)))fault('forbidden','That person is blocked.',403);
   const row={...peer,state:'accepted',inbound:token(),introIngress:peer.outbound?.ingress??peer.introIngress,outbound:null,awaitingHello:true,ready:true,generation:(peer.generation??0)+1,acceptedAt:now};
   await admit(tx,room,row,config,now);await enqueue(tx,{type:'hello',cid:room.id,principal:who,generation:row.generation});return {principal:principal(who),state:'accepted'};});
 }
}
export class ConversationsLeave extends MailboxAction {
 static operation='conversations.leave';static deps=EMITTING;static changes='conversations-changed';
 async run(deps){
  actorOwner(this.actor);const ctx=await ownerContext(deps),{conversationId,operationId}=this.input??{},room=await activeRoom(ctx.store,conversationId);
  const sent=await emit(ctx,{cid:room.id,type:'leave',operationId:operationOf(operationId)});
  await ctx.store.transaction(async tx=>{const live=await tx.get(C.room(room.id));live.state='left';live.leftAt=ctx.clock.now();await tx.put(C.room(room.id),live);await publishRoom(tx,live,ctx.config,ctx.clock.now());});
  return {...sent,state:'left'};
 }
}
// After an app switch (§6.6): the new occupant restores control state without secrets, then sends `rejoin` to every
// accepted peer with a fresh incarnation each, and waits for their secret-share.
export class ConversationsRejoin extends MailboxAction {
 static operation='conversations.rejoin';static deps=EMITTING;static changes='conversations-changed';
 async run(deps){
  actorOwner(this.actor);const ctx=await ownerContext(deps),now=ctx.clock.now(),only=this.input?.conversationId,sent=[];
  for(const [,room] of await ctx.store.list({prefix:C.rooms})){
   if(room.state!=='active'||(only&&room.id!==only))continue;
   const targets=await ctx.store.transaction(async tx=>{
    const live=await tx.get(C.room(room.id));live.awaitingSecret=!await tx.get(C.secret(room.id,live.current));live.rejoinedAt=now;await tx.put(C.room(room.id),live);
    const out=[];for(const [,peer] of await tx.list({prefix:C.peers(room.id)})){if(peer.state!=='accepted'||!peer.outbound?.ingress)continue;const row={...peer,inbound:token(),generation:(peer.generation??0)+1,awaitingHello:false};await putPeer(tx,live,row,ctx.config,now);out.push(row);}
    return out;
   });
   for(const peer of targets)sent.push(await emit(ctx,{cid:room.id,type:'rejoin',to:peer.principal,data:{binding:bindingOf(ctx.config,ctx.settings,peer.inbound)},operationId:newId()}));
  }
  return {rejoins:sent.length};
 }
}
export class ConversationsResolveStream extends MailboxAction {
 static operation='conversations.resolve-stream';static deps=['conversations'];static changes='conversations-changed';
 async run({conversations:h}){
  actorOwner(this.actor);const {conversationId,principal:who,stream}=this.input??{};
  return h.store.transaction(async tx=>{const key=C.frontier(cidOf(conversationId),who??{},stream),f=await tx.get(key);if(!f?.quarantined)fault('not_found','That stream is not quarantined.',404);await tx.put(key,{...f,quarantined:null,resolved:f.quarantined});return {resolved:true};});
 }
}

// Owner drain: invitation responses, queued replies/introductions/catch-up, and unsubmitted operations.
async function runWork(ctx,w){
 const {store}=ctx;
 if(w.type==='catch-up')return ctx.outbox.catchUp(principal(w.principal));
 const room=await store.get(C.room(w.cid));if(!room||room.state!=='active')return;
 const peer=await store.get(C.peer(w.cid,w.principal));if(peer?.state!=='accepted')return;
 if(w.type==='hello'){if(peer.generation!==w.generation)return;return emit(ctx,{cid:w.cid,type:'peer-hello',to:w.principal,data:({counter,peer:p})=>({binding:bindingOf(ctx.config,ctx.settings,p.inbound),startCounter:counter}),operationId:w.operationId});}
 if(w.type==='secret-share'){if(peer.generation!==w.generation)return;const s=await store.get(C.secret(w.cid,room.current));if(!s)throw new Error('secret unavailable');const secret=Uint8Array.from(s);return emit(ctx,{cid:w.cid,type:'secret-share',to:w.principal,data:{epoch:room.current,secretDigest:await P.secretDigest(secret)},secret,operationId:w.operationId});}
 if(w.type==='introduce'){const intro=await store.get(C.intro(w.cid,w.about)),about=await store.get(C.peer(w.cid,w.about));if(!intro||about?.state!=='accepted')return;return emit(ctx,{cid:w.cid,type:'peer-proposal',to:w.principal,data:{principal:intro.payload.responder.principal,keyId:intro.payload.responder.keyId,introduction:intro},operationId:w.operationId});}
 if(w.type==='peer-response')return emit(ctx,{cid:w.cid,type:'peer-response',to:w.principal,data:{proposal:w.proposal,decision:w.decision},operationId:w.operationId});
}
export class ConversationsDrain extends MailboxAction {
 static operation='conversations.drain';static deps=['conversations','outbox','delegateKeys','egress','clock'];static changes='conversations-changed';
 async run({conversations:h,outbox,delegateKeys,egress,clock}){
  actorOwner(this.actor);const store=h.store,now=clock.now(),config=await readConfig(store),settings=await settingsOf(store);let responses=0,work=0,failed=0,submitted=0,signer;
  for(const [key,row] of await store.list({prefix:C.responses}))if(row.state==='pending'&&row.nextAt<=now){await sendResponse(store,egress,clock,key.slice(C.responses.length));responses++;}
  const ctx={store,outbox,config,settings,clock,get signer(){return signer;}};
  const ensureSigner=async()=>{signer??=await snapshot(delegateKeys,config,settings,clock.now());};
  for(const [key,w] of [...await store.list({prefix:C.works})].slice(0,CONVERSATION_LIMITS.workPerDrain)){
   if(w.nextAt>now)continue;
   try{if(w.type!=='catch-up')await ensureSigner();const result=await runWork(ctx,w);if(result?.abandoned){await store.transaction(async tx=>{const cur=await tx.get(key);if(cur)await tx.put(key,{...cur,operationId:newId()});});continue;}await store.transaction(tx=>tx.delete(key));work++;}
   catch{failed++;await store.transaction(async tx=>{const cur=await tx.get(key);if(!cur)return;const attempts=cur.attempts+1;if(attempts>=CONVERSATION_LIMITS.workAttempts)await tx.delete(key);else await tx.put(key,{...cur,attempts,nextAt:clock.now()+Math.min(HOUR,5000*2**Math.min(10,attempts))});});}
  }
  for(const [,op] of await store.list({prefix:C.ops}))if(!op.submitted&&!op.abandoned){try{if(!op.prepared)await ensureSigner();await submitOp(ctx,op);submitted++;}catch{failed++;}}
  return {responses,work,submitted,failed,pending:(await store.list({prefix:C.works})).size};
 }
}
// Retention (spec §8.2): replay rows past retainUntil, and secrets of epochs past their overlap that no peer uses.
export class ConversationsSweep extends MailboxAction {
 static operation='conversations.sweep';static deps=['conversations','clock'];
 async run({conversations:h,clock}){
  actorOwner(this.actor,['system','owner']);const now=clock.now();
  return h.store.transaction(async tx=>{let replays=0,secrets=0;
   for(const [key,row] of await tx.list({prefix:'conv/replay/'}))if(row.retainUntil<now){await tx.delete(key);replays++;}
   for(const [,room] of await tx.list({prefix:C.rooms})){const used=new Set([...(await tx.list({prefix:C.peers(room.id)})).values()].map(p=>p.epoch));for(const [id,e] of Object.entries(room.epochs))if(e.until!==null&&e.until<=now&&!used.has(id)&&await tx.get(C.secret(room.id,id))){await tx.delete(C.secret(room.id,id));secrets++;}}
   return {replays,secrets};});
 }
}

// ---- Views. No secret, pair token, incarnation or credential is ever returned.
const peerView=(p,room)=>({principal:principal(p.principal),state:p.state,via:p.via??null,ready:p.ready!==false,epoch:p.epoch??null,rotationDisagreement:p.state==='accepted'&&p.epoch!=null&&p.epoch!==room.current,limitsDiffer:Boolean(p.outbound?.limits&&p.outbound.limits.maxParticipants!==room.maxParticipants),awaitingHello:Boolean(p.awaitingHello),offered:p.state==='pending'||p.state==='proposed',proposedBy:p.proposedBy??null});
const roomView=room=>({id:room.id,role:room.role,state:room.state,subject:room.subject,createdAt:room.createdAt,creator:principal(room.creator.principal),proposedParticipants:room.participants.map(x=>principal(x.principal)),rosterVerified:false,acceptListed:room.acceptListed,epoch:room.current,epochs:Object.keys(room.epochs).length,awaitingSecret:Boolean(room.awaitingSecret),secretConflict:Boolean(room.secretConflict),maxParticipants:room.maxParticipants,gap:Boolean(room.gap),placeholders:room.placeholders});
async function timeline(store,room,{limit=40,offset}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||offset!==undefined&&(!Number.isSafeInteger(offset)||offset<0))invalid('Choose a timeline page.');
 const rows=[...(await store.list({prefix:C.events(room.id)})).values()],ids=orderEvents(rows),byId=new Map(rows.map(r=>[r.eventId,r])),pos=new Map(ids.map((id,i)=>[id,i]));
 const text=async id=>{const b=await store.get(C.body(room.id,id));return b?td.decode(Uint8Array.from(b)):null;},out=[];
 const visible=ids.filter(id=>['message','genesis'].includes(byId.get(id).type)&&!byId.get(id).quarantined),start=offset??Math.floor(Math.max(0,visible.length-1)/limit)*limit;
 for(const id of visible.slice(start,start+limit)){
  const e=byId.get(id);
  const revisions=(e.revisions??[]).map(r=>byId.get(r)).filter(r=>r&&!r.quarantined).sort((a,b)=>pos.get(a.eventId)-pos.get(b.eventId));
  const deleted=(e.retractions??[]).some(id=>byId.get(id)&&!byId.get(id).quarantined);
  out.push({eventId:id,type:e.type,author:principal(e.author.principal),own:e.own,createdAt:e.createdAt,text:deleted?null:await text((revisions.at(-1)??e).eventId),edited:revisions.length>0,deleted,deletedNote:deleted?(e.own?'Deleted for people whose apps accepted the deletion':'Deleted by the sender'):null,historyTruncated:revisions.length>19,history:await Promise.all([e,...revisions].slice(-20).map(async r=>({eventId:r.eventId,text:await text(r.eventId)}))),...e.resendOf?{resent:true}:{}});
 }
 return {timeline:out,pagination:{offset:start,limit,total:visible.length,previous:start>0?Math.max(0,start-limit):null,next:start+limit<visible.length?start+limit:null},quarantined:rows.filter(r=>r.quarantined).length};
}
export class ConversationsList extends MailboxQuery {
 static operation='conversations.list';static deps=['conversations'];static refreshOn=['conversations-changed'];
 async fetch({conversations:h}){actorOwner(this.actor);return {conversations:[...(await h.store.list({prefix:C.rooms})).values()].map(roomView)};}
}
export class ConversationsGet extends MailboxQuery {
 static operation='conversations.get';static deps=['conversations'];static refreshOn=['conversations-changed'];
 async fetch({conversations:h}){
  actorOwner(this.actor);const store=h.store,cid=cidOf(this.input?.conversationId),room=await store.get(C.room(cid));if(!room)fault('not_found','Conversation not found.',404);
  const peers=[...(await store.list({prefix:C.peers(cid)})).values()],rotations=[...(await store.list({prefix:C.rotations(cid)})).values()],pending=rotations.filter(r=>r.state==='pending');
  const streams=[...(await store.list({prefix:C.frontiers(cid)})).values()].filter(f=>f.quarantined).length,response=await store.get(C.response(cid));
  return {...roomView(room),...await timeline(store,room,this.input),peers:peers.map(p=>peerView(p,room)),someCannotSeeEveryone:peers.some(p=>peerView(p,room).limitsDiffer),rotations:rotations.map(r=>({epoch:r.epoch,proposer:r.proposer,state:r.state,at:r.at})),rotationConflict:pending.length>1,quarantinedStreams:streams,invitationResponse:response?{state:response.state,attempts:response.attempts}:null};
 }
}
// Honest per-recipient status of one own event (architecture §9.4–§9.5): the outbox states over the frozen audience,
// plus peers accepted now but absent from it, labelled as joined after the message. Owner-only.
export class ConversationsStatus extends MailboxQuery {
 static operation='conversations.status';static deps=['conversations','outbox'];static refreshOn=['conversations-changed','outbox-changed'];
 async fetch({conversations:h,outbox}){
  actorOwner(this.actor);const store=h.store,cid=cidOf(this.input?.conversationId),ev=await store.get(C.event(cid,this.input?.eventId??''));if(!ev?.own||!ev.operationId)fault('not_found','Message not found.',404);
  const op=await store.get(C.op(ev.operationId)),view=op?.submitted&&op.recipients.length?await outbox.get(ev.operationId):null;
  const states=new Map((view?.recipients??[]).map(r=>[pk(r.principal),r]));
  const recipients=(ev.audience?.members??[]).map(m=>{const s=states.get(pk(m));return {principal:principal(m),state:s?.state??(op?.submitted?'cancelled':'queued'),...s?.reason?{reason:s.reason}:{},...s?.class?{class:s.class}:{},...s?{nextAttemptAt:s.nextAttemptAt,deadline:s.deadline}:{}};});
  const joinedAfter=[...(await store.list({prefix:C.peers(cid)})).values()].filter(p=>p.state==='accepted'&&!(ev.audience?.members??[]).some(m=>same(m,p.principal))).map(p=>({principal:principal(p.principal),state:'joined_after'}));
  return {eventId:ev.eventId,operationId:ev.operationId,...view?{delivered:view.delivered,pending:view.pending,failed:view.failed,cancelled:view.cancelled}:{delivered:0,pending:recipients.length,failed:0,cancelled:0},recipients,joinedAfter};
 }
}

export const CONVERSATION_OPERATIONS=[ConversationsConfigure,ConversationsCreate,ConversationsInvitations,ConversationsAccept,ConversationsRespond,ConversationsReceive,ConversationsSend,ConversationsEdit,ConversationsRetract,ConversationsRotate,ConversationsSelectRotation,ConversationsDecide,ConversationsRemove,ConversationsReadmit,ConversationsLeave,ConversationsRejoin,ConversationsResolveStream,ConversationsDrain,ConversationsSweep,ConversationsList,ConversationsGet,ConversationsStatus];
