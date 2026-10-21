// Mailbox key schema and owner-bound domain handles over `mailboxStore` (the single-writer commit boundary).
// Every admission, contact and intake effect commits inside one `transaction`; network I/O never runs inside one.
import {Provider} from '../../../vendor/ngin/index.js';
import {MailboxFault,fault} from '../faults.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const part=value=>encodeURIComponent(String(value));
// Principals are keyed by exact (issuer, subject); never by display handle or identityURI.
export const principalKey=p=>`${part(p.issuer)}|${part(p.subject)}`;
export const pad=n=>String(n).padStart(16,'0');
export const KEYS=Object.freeze({
 owner:'owner',config:'config',settings:'settings/intake',budget:'budget/v1',usage:'usage/v1',edgeSeq:'edge-seq',
 parent:jti=>`parent/${part(jti)}`,contact:id=>`contact/${part(id)}`,block:p=>`block/${principalKey(p)}`,
 allowPrincipal:p=>`allow/p/${principalKey(p)}`,allowEmail:address=>`allow/e/${part(address.toLowerCase())}`,
 decision:(jti,p)=>`decision/${part(jti)}/${principalKey(p)}`,replay:digest=>`replay/${digest}`,
 item:id=>`item/${id}`,body:id=>`body/${id}`,rejected:(at,id)=>`rejected/${pad(at)}/${id}`,pending:(at,id)=>`pending/${pad(at)}/${id}`,
 revoked:jkt=>`revoked/${jkt}`,intakeJti:(iss,jti)=>`intake/jti/${part(iss)}/${part(jti)}`,intakeTx:tx=>`intake/tx/${tx}`,
 edgeOutbox:seq=>`edge-outbox/${pad(seq)}`,
});
// Bounds from architecture §8 and §12.1 (provisional policy values, not protocol limits).
export const BOUNDS=Object.freeze({inlineBodyBytes:4096,hotBytes:64*1048576,hotItems:5000,rejectedItems:500,rejectedMs:7*86400000,maxContacts:1024,maxParents:1024,maxAllow:1024});

// Actor kinds: `owner` (the signed-in user), `ingress` (the edge, acting on this mailbox's ingress) and `system`
// (alarms). Each operation names the kinds it accepts; an ingress or system actor can never run an owner operation.
export function actorOwner(actor,kinds=['owner']){
 if(!actor||typeof actor!=='object'||!kinds.includes(actor.kind)||typeof actor.owner!=='string'||!UUID.test(actor.owner))fault('unauthorized','Sign in to continue.',401);
 return actor.owner;
}
// Domain handle: binds the mailbox owner before any domain code runs (OwnerScopedProvider semantics, plus the
// ingress and system actor kinds). Handles are frozen and carry no other authority than the bound store.
export class MailboxDomain extends Provider {
 static deps=['mailboxStore'];static kinds=['owner','ingress','system'];
 #deps;#held=new WeakMap();
 constructor(deps){super();this.#deps=deps;}
 async obtain({actor}={}){
  const owner=actorOwner(actor,this.constructor.kinds),store=await this.#deps.mailboxStore.obtain();
  try{
   const bound=await store.get(KEYS.owner);if(bound!==owner)throw new MailboxFault('forbidden','Mailbox owner mismatch.',403);
   const handle=Object.freeze({owner,kind:actor.kind,store});this.#held.set(handle,store);return handle;
  }catch(error){await this.#deps.mailboxStore.release(store);throw error;}
 }
 async release(handle){const store=this.#held.get(handle);if(!store)return;this.#held.delete(handle);await this.#deps.mailboxStore.release(store);}
}
export class ContactsDomain extends MailboxDomain {}
export class ReceiveDomain extends MailboxDomain {}

// Hot-allowance accounting for bodies held in the mailbox when user storage is unavailable (architecture §8).
export async function chargeUsage(tx,{bytes,items=1,rejected=false}){
 const usage=await tx.get(KEYS.usage)??{hotBytes:0,hotItems:0,rejected:0};
 const next={...usage,hotBytes:usage.hotBytes+bytes,hotItems:usage.hotItems+items,rejected:usage.rejected+(rejected?1:0)};
 if(next.hotBytes<0||next.hotItems<0||next.rejected<0)fault('internal_error','Usage accounting is inconsistent.',500);
 await tx.put(KEYS.usage,next);return next;
}
export async function readConfig(store){
 const config=await store.get(KEYS.config);if(!config)fault('recipient_unavailable','The recipient is unavailable.',503);return config;
}
// Edge-index publications are written in the same transaction as the parent change; flushEdgeOutbox delivers them.
export async function queueEdge(tx,entry){const seq=(await tx.get(KEYS.edgeSeq)??0)+1;await tx.put(KEYS.edgeSeq,seq);await tx.put(KEYS.edgeOutbox(seq),{...entry,generation:seq});return seq;}
