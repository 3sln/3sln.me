import {projectIncoming,removeIncoming} from '../store/item-index.mjs';
// Consumer side of delegated-certificate status (spec §3.4; architecture §4.3 items 3 and 5). The receiver resolves
// identity keys and `active`/`revoked` status through the injected `directory` provider ({resolveKey, status}), with
// bounded in-memory caches (5 minutes for active status, revocations kept). A learned revocation is persisted in the
// mailbox and quarantines every not-yet-reviewed item from that jkt created at or after revokedHour - 1 h.
// The provider side (issuance, renewal, the status route) is IDKEYS-2; nothing here signs or issues certificates.
import {LIMITS,quarantined} from '../../bindlebox-protocol/index.mjs';
import {MailboxAction} from '../engine.mjs';
import {KEYS,actorOwner} from '../store/mailbox.mjs';

export const STATUS_CACHE_MAX=1024,KEY_CACHE_MS=300000;
// Bounded LRU with per-entry expiry. Memory only: a restart forgets active entries (revocations are persisted).
export function boundedCache(max=STATUS_CACHE_MAX){
 const map=new Map();
 return {get(key,now){const hit=map.get(key);if(!hit)return undefined;if(hit.until<now){map.delete(key);return undefined;}map.delete(key);map.set(key,hit);return hit.value;},
  set(key,value,until){map.delete(key);map.set(key,{value,until});while(map.size>max)map.delete(map.keys().next().value);},
  get size(){return map.size;},clear:()=>map.clear()};
}
const caches=new WeakMap();
// One cache pair per directory provider instance (a mailbox engine shares it across operations).
export function cachesFor(directory){let c=caches.get(directory);if(!c){c={status:boundedCache(),keys:boundedCache()};caches.set(directory,c);}return c;}

// Ports for verifyEnvelope/verifyReceipt. A missing directory means no fetch at all: keys resolve to null (401).
// `learned` collects revocations seen during this verification so the caller can persist them after it fails.
export function verificationPorts({directory,store,now,learned=[]}){
 if(!directory||typeof directory.resolveKey!=='function')return {resolveKey:async()=>null,status:undefined,learned};
 const cache=cachesFor(directory);
 const resolveKey=async query=>{
  const key=JSON.stringify([query.issuer,query.subject,query.keyId]),hit=cache.keys.get(key,now);if(hit)return structuredClone(hit);
  const value=await directory.resolveKey(query);if(value&&typeof value==='object')cache.keys.set(key,structuredClone(value),now+KEY_CACHE_MS);return value;
 };
 const status=typeof directory.status!=='function'?undefined:async query=>{
  const persisted=await store.get(KEYS.revoked(query.jkt));if(persisted)return {status:'revoked',revokedHour:persisted.revokedHour};
  const hit=cache.status.get(query.jkt,now);if(hit)return hit;
  const value=await directory.status(query);
  if(value?.status==='active')cache.status.set(query.jkt,{status:'active'},now+LIMITS.statusCacheMs);
  else if(value?.status==='revoked'){const r={status:'revoked',...Number.isSafeInteger(value.revokedHour)&&value.revokedHour>=0?{revokedHour:value.revokedHour}:{}};cache.status.set(query.jkt,r,Number.MAX_SAFE_INTEGER);learned.push({jkt:query.jkt,revokedHour:r.revokedHour,principal:{issuer:query.issuer,subject:query.subject}});return r;}
  return value;
 };
 return {resolveKey,status,learned};
}
// Known revocation without a network fetch, for kinds where §3.4 permits relying on certificate expiry.
export async function knownRevoked({directory,store,now},jkt){
 if(await store.get(KEYS.revoked(jkt)))return true;
 return directory?cachesFor(directory).status.get(jkt,now)?.status==='revoked':false;
}
// Persists a revocation and quarantines unreviewed items (inside the caller's transaction). Without revokedHour the
// protocol treats every unapplied record as affected.
export async function recordRevocation(tx,{jkt,revokedHour,principal,now}){
 const prior=await tx.get(KEYS.revoked(jkt));
 if(!prior)await tx.put(KEYS.revoked(jkt),{jkt,...revokedHour===undefined?{}:{revokedHour},principal,learnedAt:now});
 let count=0;
 for(const [key] of await tx.list({prefix:`by-jkt/${jkt}/`})){
  const id=key.slice(key.lastIndexOf('/')+1),item=await tx.get(KEYS.item(id));
  if(!item||item.quarantined||item.reviewed||!quarantined(item.createdAt,revokedHour))continue;
  item.quarantined={reason:'delegation_revoked',at:now};await tx.put(KEYS.item(id),item);await projectIncoming(tx,item);
  if(item.state==='pending')await tx.delete(KEYS.pending(item.receivedAt,id));count++;
 }
 return count;
}
export const jktIndex=(jkt,id)=>`by-jkt/${jkt}/${id}`;
export const seenKey=jkt=>`seen-jkt/${jkt}`;

// System sweep: re-checks status of recently seen author keys whose last check is older than the status cache, so
// a revocation is learned (and quarantine applied) even without new traffic from that key. Bounded per run.
export class DelegationRecheck extends MailboxAction {
 static operation='delegation.recheck';static deps=['receive','directory','clock'];static changes='incoming-changed';
 async run({receive,directory,clock}){
  actorOwner(this.actor,['system','owner']);const now=clock.now(),limit=Math.min(Math.max(Number(this.input?.limit)||32,1),128);
  if(!directory||typeof directory.status!=='function')return {checked:0,revoked:0,status:'no_directory'};
  const due=[...(await receive.store.list({prefix:'seen-jkt/'})).values()].filter(s=>s.checkedAt+LIMITS.statusCacheMs<=now&&s.lastSeen+LIMITS.retentionMs>=now).sort((a,b)=>a.checkedAt-b.checkedAt).slice(0,limit);
  let revoked=0,unavailable=0;
  for(const seen of due){
   let value;try{value=await directory.status({issuer:seen.principal.issuer,subject:seen.principal.subject,identityURI:seen.principal.identityURI,jkt:seen.jkt});}catch{unavailable++;continue;}
   await receive.store.transaction(async tx=>{
    const current=await tx.get(seenKey(seen.jkt));if(current)await tx.put(seenKey(seen.jkt),{...current,checkedAt:now});
    if(value?.status==='revoked'){revoked++;await recordRevocation(tx,{jkt:seen.jkt,revokedHour:Number.isSafeInteger(value.revokedHour)?value.revokedHour:undefined,principal:seen.principal,now});await tx.delete(seenKey(seen.jkt));}
   });
   if(value?.status==='revoked')cachesFor(directory).status.set(seen.jkt,{status:'revoked'},Number.MAX_SAFE_INTEGER);
  }
  return {checked:due.length,revoked,unavailable};
 }
}
export const DELEGATION_OPERATIONS=[DelegationRecheck];
