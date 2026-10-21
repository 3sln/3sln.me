// Instance-wide edge credential index (spec §7.4; architecture §11 step 1). A bad link credential is refused here
// without waking any mailbox. Entries hold digests only: {owner, claimsDigest, revoked, generation}, never a meta,
// secret or plaintext token. Keyed by (meta iss, jti) so two providers' jti spaces cannot collide on a shared host.
// The mailbox always re-verifies in full; the index is a cheap pre-filter that may lag (a stale entry only costs work).
import {parseCredential,parseCompact,sha256,ProtocolFault} from '../../bindlebox-protocol/index.mjs';
import {equalDigest} from '../../bindlebox-protocol/encoding.mjs';

export const LINK_META_TYPE='bindle-link-meta+jwt';
const DUMMY='A'.repeat(43);
const linkInvalid=()=>{throw new ProtocolFault('link_invalid');};
// claimsDigest: SHA-256 over the received meta signing input `segment1.segment2` (the links §4 `md` input).
export const claimsDigest=compact=>sha256(globalThis.crypto,compact.split('.').slice(0,2).join('.'));
export const edgeKey=(iss,jti)=>`link/${encodeURIComponent(iss)}/${encodeURIComponent(jti)}`;
// Unverified routing read of a link meta: strict JWS grammar and I-JSON only. Never an authorization decision.
export function linkClaims(compact){
 let jws;try{jws=parseCompact(compact,LINK_META_TYPE);}catch{linkInvalid();}
 const c=jws.claims;if(typeof c.iss!=='string'||typeof c.jti!=='string'||!c.jti||c.jti.length>128||c.iss.length>2048)linkInvalid();return jws;
}

export function createEdgeIndex(store){
 if(!store||typeof store.get!=='function'||typeof store.put!=='function')throw new TypeError('The edge index needs a store');
 return Object.freeze({
  // Returns {owner, jti, scheme} for a credential that matches a live entry. Unknown, revoked and mismatched links
  // all fail as the same `link_invalid` after the same digest work; conversation credentials have no entries yet
  // (BB-B4) and fail as `not_authorized`.
  async check(header){
   const credential=parseCredential(header);
   if(credential.scheme!=='BindleLink'){if(credential.scheme==='BindleConversation')throw new ProtocolFault('not_authorized');linkInvalid();}
   const jws=linkClaims(credential.value),digest=await claimsDigest(credential.value),entry=await store.get(edgeKey(jws.claims.iss,jws.claims.jti));
   const live=entry&&entry.revoked===false&&typeof entry.claimsDigest==='string';
   const same=equalDigest(digest,live?entry.claimsDigest:DUMMY);
   if(!live||!same)linkInvalid();
   return {owner:entry.owner,jti:jws.claims.jti,iss:jws.claims.iss,scheme:'BindleLink'};
  },
  // Monotonic per (iss, jti): an older generation never overwrites a newer one, and another owner never takes over.
  async publish(entry){
   const key=edgeKey(entry.iss,entry.jti),prior=await store.get(key);
   if(prior&&(prior.owner!==entry.owner||prior.generation>=entry.generation))return false;
   await store.put(key,{owner:entry.owner,claimsDigest:entry.claimsDigest,revoked:entry.revoked===true,generation:entry.generation});return true;
  },
  get:(iss,jti)=>store.get(edgeKey(iss,jti)),
 });
}
// Delivers queued publications from one mailbox to the edge index, then deletes exactly the rows it delivered.
// Safe to repeat after a crash at any point: publish is idempotent and generation-ordered.
export async function flushEdgeOutbox(mailboxStore,edge,owner){
 const rows=await mailboxStore.list({prefix:'edge-outbox/'});let published=0;
 for(const [,entry] of rows){await edge.publish({...entry,owner});published++;}
 if(rows.size)await mailboxStore.transaction(async tx=>{for(const [key,entry] of rows){const current=await tx.get(key);if(current&&current.generation===entry.generation)await tx.delete(key);}});
 return published;
}
