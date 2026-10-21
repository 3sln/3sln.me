// Conversation gate and causal bookkeeping (spec §6.3–§6.5, §7.1, §7.4): pair tokens, credential headers, edge-index
// keys, per-stream counter frontiers with bounded gap exceptions, causal bounds, pending mutations and frozen audiences.
// Pure: callers persist the returned state inside their own transaction.
import {PAIR_DOMAIN,HELLO_INCARNATION,LIMITS} from './constants.mjs';
import {fail,malformed,textEncoder,base64url,jcs,sha256,isUUID,uuid,opaque,originValue,compactValue,digestValue,time,equalDigest} from './encoding.mjs';

const party=p=>{if(!p||typeof p!=='object')malformed();originValue(p.issuer);uuid(p.subject);return `${p.issuer} ${p.subject}`;};
// pairToken = base64url(HMAC-SHA256(secret, "bindlebox-pair-v1\n" || conversationId || "\n" || author || "\n" || recipient || "\n" || incarnation)).
// Every component is delimiter-free (UUIDs, origins, visible-ASCII incarnations), so the input is injective.
export async function pairToken(secret,{conversationId,author,recipient,incarnation},crypto=globalThis.crypto){
 if(!(secret instanceof Uint8Array)||secret.byteLength!==32)malformed();uuid(conversationId);opaque(incarnation);
 const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return base64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,textEncoder.encode(`${PAIR_DOMAIN}${conversationId}\n${party(author)}\n${party(recipient)}\n${incarnation}`))));
}
export const secretDigest=(secret,crypto=globalThis.crypto)=>{if(!(secret instanceof Uint8Array)||secret.byteLength!==32)malformed();return sha256(crypto,secret);};

// Authorization header grammar: exactly `BindleLink <compact>` or `BindleConversation <epoch>.<token>`; no other scheme,
// whitespace or casing. Absent yields {scheme:null}. Link values that fail grammar are link_malformed (§4.5).
export function parseCredential(header){
 if(header===undefined||header===null)return {scheme:null};
 if(typeof header!=='string'||header.length>LIMITS.maxHeaderChars)fail('malformed');
 const m=/^(BindleLink|BindleConversation) ([^\s]+)$/.exec(header);if(!m)fail('malformed');
 if(m[1]==='BindleLink'){try{compactValue(m[2]);}catch{fail('link_malformed');}return {scheme:'BindleLink',value:m[2]};}
 const [epoch,token,...rest]=m[2].split('.');if(rest.length||!isUUID(epoch))fail('not_authorized');try{digestValue(token);}catch{fail('not_authorized');}
 return {scheme:'BindleConversation',value:m[2],epoch,token};
}
export const formatCredential=credential=>credential.scheme==='BindleConversation'?`BindleConversation ${uuid(credential.epoch)}.${digestValue(credential.token)}`:`BindleLink ${compactValue(credential.value)}`;
// The one credential each envelope travels with (§7.1): links for link kinds, the pair token for records, none for rejoin.
export const credentialScheme=envelope=>envelope.payload.kind!=='conversation-record'?'BindleLink':envelope.payload.record.type==='rejoin'?null:'BindleConversation';
export function checkCredentialKind(envelope,credential){
 const expected=credentialScheme(envelope);
 if((credential?.scheme??null)!==expected)fail(expected==='BindleLink'?'link_invalid':'not_authorized');
 if(expected==='BindleConversation'&&credential.epoch!==envelope.payload.record.epoch)fail('not_authorized');
 return expected;
}
// §4.5 step 4: the payload recipient must name the presented link's jti, resource, issuer and owner.
export function checkLinkRecipient(envelope,{issuer,owner,jti,resource}){
 const r=envelope.payload.recipient;if(r.issuer!==issuer||r.owner!==owner||r.contactId!==jti||r.resource!==resource)fail('link_invalid');
}

// §7.4 edge index: H(conversationId, author principal, recipient owner) -> SHA-256(expected pair token). No secrets.
export const edgeKey=({conversationId,author,owner},crypto=globalThis.crypto)=>{uuid(conversationId);party(author);party(owner);return sha256(crypto,jcs(['bindlebox-edge-v1',conversationId,author.issuer,author.subject,owner.issuer,owner.subject]));};
export const tokenDigest=(token,crypto=globalThis.crypto)=>{digestValue(token);return sha256(crypto,token);};
// Pre-authentication gate (§6.4), before any crypto or directory work. `entry` is the edge/peer row:
// {tokenDigests:{[epoch]:digest}, helloDigests?:{[epoch]:digest}, incarnation}. Hello and ordinary digests are kept
// apart, so a token computed for one incarnation never admits the other (review BR-4). Failures are not_authorized.
export async function checkPairGate(credential,envelope,entry,crypto=globalThis.crypto){
 const deny=()=>fail('not_authorized'),p=envelope.payload;
 if(credential?.scheme!=='BindleConversation'||!entry||typeof entry!=='object')deny();
 const hello=p.record.type==='peer-hello',expected=(hello?entry.helloDigests:entry.tokenDigests)?.[credential.epoch];if(typeof expected!=='string')deny();
 if(!equalDigest(await tokenDigest(credential.token,crypto),expected))deny();
 if(credential.epoch!==p.record.epoch)deny();
 const incarnation=p.record.type==='peer-hello'?HELLO_INCARNATION:entry.incarnation;
 if(p.recipient.incarnation!==incarnation)fail(p.record.type!=='peer-hello'&&typeof entry.incarnation==='string'?'incarnation_stale':'not_authorized');
 return true;
}

// Per-stream counters (§6.3, §8.2): `high` is the highest counter seen; `gaps` are skipped counters below it, at most
// 256, each expiring with the 7-day window. A counter more than 1,024 above the frontier is counter_gap. When the
// bound is exceeded the oldest gaps are abandoned: a late event for an abandoned counter reads as a duplicate.
// `start` is the first expected counter (peer-hello startCounter; 1 for a fresh stream).
export const streamState=(start=1)=>{if(!Number.isSafeInteger(start)||start<1)malformed();return {high:start-1,gaps:[]};};
export const frontier=state=>state.gaps.length?Math.min(...state.gaps.map(g=>g.counter))-1:state.high;
export function admitCounter(state,counter,{now}){
 if(!Number.isSafeInteger(counter)||counter<1||!Number.isSafeInteger(now))malformed();
 const s={high:state.high,gaps:state.gaps.filter(g=>g.until>now)};
 if(counter>s.high){
  if(counter-frontier(s)>LIMITS.maxCounterJump)fail('counter_gap');
  for(let c=Math.max(s.high+1,counter-LIMITS.maxGapExceptions);c<counter;c++)s.gaps.push({counter:c,until:now+LIMITS.recordWindowMs});
  s.high=counter;s.gaps=s.gaps.sort((a,b)=>a.counter-b.counter).slice(-LIMITS.maxGapExceptions);
  return {status:'new',state:s};
 }
 const at=s.gaps.findIndex(g=>g.counter===counter);if(at<0)return {status:'duplicate',state:s};
 s.gaps.splice(at,1);return {status:'new',state:s};
}
// Equivocation (§6.5): a different event already holds this (author, conversation, stream, counter).
export const equivocates=(knownEventId,incomingEventId)=>knownEventId!==undefined&&knownEventId!==null&&knownEventId!==incomingEventId;

// Missing parents (§6.3): placeholders up to 64 outstanding, beyond that one collapsed gap marker; the event is accepted.
export function placeholderPlan(parents,known,outstanding){
 if(!Array.isArray(parents)||parents.length>LIMITS.maxParents)malformed();
 const missing=parents.filter(id=>!known.has(id)),room=Math.max(0,LIMITS.maxPlaceholders-outstanding);
 return {placeholders:missing.slice(0,room),collapsed:missing.length>room};
}
// Edit/retract before the target (§6.3): pending keyed by (author principal, target), at most 64, oldest dropped.
export function queueMutation(pending,mutation){
 if(!mutation||typeof mutation!=='object')malformed();digestValue(mutation.target);party(mutation.author);
 const next=[...pending.filter(m=>!(m.target===mutation.target&&m.author.issuer===mutation.author.issuer&&m.author.subject===mutation.author.subject&&m.eventId===mutation.eventId)),mutation];
 return {pending:next.slice(-LIMITS.maxPendingMutations),dropped:next.slice(0,Math.max(0,next.length-LIMITS.maxPendingMutations))};
}
// A mutation applies only when the target's author equals the mutation's author; a known mismatch is record_forbidden.
export const checkMutationAuthor=(target,author)=>{if(target.author.issuer!==author.issuer||target.author.subject!==author.subject)fail('record_forbidden');};

// Audience frozen at local acceptance (§7.3): accepted peers with reciprocal bindings, sorted and unique, with a digest
// that later audits compare. Edits/retractions use the target audience intersected with still-authorized peers.
const member=p=>{party(p);opaque(p.incarnation);return {issuer:p.issuer,subject:p.subject,incarnation:p.incarnation};};
export async function freezeAudience(peers,crypto=globalThis.crypto){
 if(!Array.isArray(peers)||peers.length>LIMITS.maxParticipants)malformed();
 const members=peers.map(member).sort((a,b)=>a.issuer<b.issuer?-1:a.issuer>b.issuer?1:a.subject<b.subject?-1:a.subject>b.subject?1:0);
 for(let i=1;i<members.length;i++)if(members[i].issuer===members[i-1].issuer&&members[i].subject===members[i-1].subject)malformed();
 return Object.freeze({members:Object.freeze(members.map(Object.freeze)),digest:await sha256(crypto,jcs(['bindlebox-audience-v1',...members.map(m=>[m.issuer,m.subject,m.incarnation])]))});
}
export const mutationAudience=(target,authorized)=>target.members.filter(m=>authorized.some(a=>a.issuer===m.issuer&&a.subject===m.subject));
