// Replay namespaces, acceptance windows and idempotency (spec §8.2). Every key is keyed by the verified author
// principal, so one author can never squat or probe another author's operation IDs. Keys are JCS arrays: injective.
import {LIMITS} from './constants.mjs';
import {fail,malformed,jcs,uuid,originValue,digestValue,time} from './encoding.mjs';

const principalParts=p=>{originValue(p.issuer);uuid(p.subject);return [p.issuer,p.subject];};
// Receiver namespace. Link kinds: (recipient owner, contactId, author principal, operationId).
// Records: (recipient owner, conversationId, author principal, stream, counter); eventId is compared alongside.
export function replayKey(envelope){
 const p=envelope.payload,r=p.recipient,a=principalParts(p.author.principal);
 return p.kind==='conversation-record'?jcs(['bindlebox-replay-record-v1',r.issuer,r.owner,r.conversationId,...a,p.record.stream,p.record.counter]):jcs(['bindlebox-replay-link-v1',r.issuer,r.owner,r.contactId,...a,p.operationId]);
}
// Sender-local operation namespace (app send API, Idempotency-Key): (author principal, operationId).
export const operationKey=(principal,operationId)=>jcs(['bindlebox-operation-v1',...principalParts(principal),uuid(operationId)]);
// Invitation nonces are single-use per (creator conversation, nonce).
export const invitationKey=(conversationId,nonce)=>jcs(['bindlebox-invitation-v1',uuid(conversationId),nonce]);

// Window (§8.2, §8.3): link kinds 24 h past / 60 s future; records 7 days past / 60 s future.
export function checkWindow(envelope,now){
 if(!Number.isSafeInteger(now))malformed();const t=envelope.payload.createdAt;
 if(t>now+LIMITS.clockSkewMs)fail('clock_skew',{serverTime:now});
 if(t<now-(envelope.payload.kind==='conversation-record'?LIMITS.recordWindowMs:LIMITS.linkWindowMs))fail('envelope_expired');
 return true;
}
// Prior entry {payloadDigest, eventId?} under the same replay key:
//  none -> 'new'; identical payloadDigest -> 'replay' (return the stored receipt after rechecking live authorization,
//  with no new charge, write or notification); records with the same eventId but another delivery context (for example
//  a re-acceptance incarnation) -> 'duplicate-event' (no reapplication); records with another eventId -> 'equivocation'
//  (keep both, quarantine, stop the stream); link kinds with another digest -> operation_conflict.
export function replayDecision(prior,{payloadDigest,eventId}){
 digestValue(payloadDigest);if(prior===undefined||prior===null)return 'new';
 if(prior.payloadDigest===payloadDigest)return 'replay';
 if(eventId===undefined)fail('operation_conflict');
 return prior.eventId===eventId?'duplicate-event':'equivocation';
}
// Invitation responses (§6.2): identical bytes return the stored result; different bytes are invitation_used.
export const invitationDecision=(prior,responseDigest)=>{digestValue(responseDigest);if(prior===undefined||prior===null)return 'new';if(prior.responseDigest===responseDigest)return 'replay';fail('invitation_used');};
// Retention (§8.2): receipts and fences for 9 days past admission or the end of the acceptance window, whichever is later.
export const retainUntil=(envelope,admittedAt)=>{if(!time(admittedAt))malformed();const p=envelope.payload;return Math.max(admittedAt,p.createdAt+(p.kind==='conversation-record'?LIMITS.recordWindowMs:LIMITS.linkWindowMs))+LIMITS.retentionMs;};
// After restore (S-9): an envelope older than the restored checkpoint is admitted only from the imported replay set.
export const admissibleAfterRestore=(envelope,{checkpointAt,imported})=>envelope.payload.createdAt>=checkpointAt||imported===true;
