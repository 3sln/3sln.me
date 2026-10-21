// Author verification (spec §3.3), delegation status (§3.4), delivery-URL bindings (S-2, S-4, S-11) and sender-side
// receipt checks (§8.1). Ports are injected; nothing here fetches:
//  resolveKey({issuer, subject, identityURI, keyId}) -> {keyId, publicJwk, identityURI} | null: the principal's identity key
//   and canonical identityURI from the directory with pinned continuity, looked up by (issuer, subject) only. The returned
//   identityURI must equal the signed one (review BR-1); the status port must derive its URL from the directory too.
//   null means unverifiable (401); a throw means unavailable now (503).
//  status({issuer, subject, identityURI, jkt}) -> {status:'active'} | {status:'revoked', revokedHour?}. Anything else,
//   a throw or a missing port is "cannot be determined" (503 author_unverifiable) where §3.4 requires a check.
import {DOMAINS,PURPOSES,LIMITS,STATUS_REQUIRED_RECORDS,RECEIPT_PURPOSE} from './constants.mjs';
import {fail,plain,time,fromBase64url,sameValue,equalDigest} from './encoding.mjs';
import {jktOf,parseDelegation,verifyDelegation,verifyES256} from './certificate.mjs';
import {validateEnvelope,validateInvitationResponse,validateReceipt,signingInput,payloadDigest,eventId} from './envelope.mjs';

const RETRY_SECONDS=60;
const unverifiable=extra=>fail('author_unverifiable',extra);
const unavailable=()=>unverifiable({status:503,retryAfter:RETRY_SECONDS});
const sameOrigin=(a,b)=>new URL(a).origin===new URL(b).origin;

// Which objects need a live status check before they take effect (§3.4).
export function statusRequired(signed){
 const p=signed?.payload;if(!plain(p))return true;
 if(Object.hasOwn(p,'responder')||p.purpose===RECEIPT_PURPOSE||p.kind==='conversation-init')return true;
 return p.kind==='conversation-record'&&STATUS_REQUIRED_RECORDS.includes(p.record?.type);
}
export async function checkStatus(status,principal,jkt){
 let r;try{r=typeof status==='function'?await status({issuer:principal.issuer,subject:principal.subject,identityURI:principal.identityURI,jkt}):undefined;}catch{r=undefined;}
 if(plain(r)&&r.status==='active')return {status:'active'};
 if(plain(r)&&r.status==='revoked'&&(r.revokedHour===undefined||time(r.revokedHour)))unverifiable({revoked:true,...r.revokedHour===undefined?{}:{revokedHour:r.revokedHour}});
 unavailable();
}
// After learning of a revocation, unapplied records at or after revokedHour − 1 h are quarantined (§3.4).
export const quarantined=(createdAt,revokedHour)=>!time(revokedHour)||createdAt>=(revokedHour-1)*3600000;

// One signed object under one fixed domain and purpose. Cheap structural and claim checks run before the directory
// lookup; the proof is verified before any status fetch, so a forged object costs no network work.
// `atOnly` (receipts, §8.1) checks the certificate lifetime at `at` instead of now.
export async function authenticate(signed,{domain,principal,keyId,purpose,at,atOnly=false,required,resolveKey,status,now,allowLoopback=false,crypto=globalThis.crypto}){
 if(!Object.values(DOMAINS).includes(domain)||!Object.values(PURPOSES).includes(purpose))throw new TypeError('Unknown domain or purpose');
 let jkt,jws;try{jkt=jktOf(signed.proof.kid);jws=parseDelegation(signed.proof.delegation,{allowLoopback});}catch{unverifiable();}
 const c=jws.claims,kid=jws.header.kid;
 if((keyId!==undefined&&kid!==keyId)||c.iss!==principal.issuer||c.sub!==principal.subject||c.jkt!==jkt||!c.purposes.includes(purpose))unverifiable();
 const when=atOnly?at:now;if(!Number.isSafeInteger(when)||when<c.iat*1000-LIMITS.clockSkewMs||when>c.exp*1000+LIMITS.clockSkewMs)unverifiable();
 if(typeof resolveKey!=='function')unverifiable();
 let identityKey;try{identityKey=await resolveKey({issuer:principal.issuer,subject:principal.subject,identityURI:principal.identityURI,keyId:kid});}catch{unavailable();}
 if(!plain(identityKey)||identityKey.identityURI!==principal.identityURI)unverifiable();
 const cert=await verifyDelegation(signed.proof.delegation,{identityKey,principal,keyId:kid,jkt,purpose,now:atOnly?at:now,at:atOnly?undefined:at,allowLoopback,crypto});
 if(!cert.delegateKey||!await verifyES256(cert.delegateKey,fromBase64url(signed.proof.signature,64),signingInput(domain,signed),crypto))unverifiable();
 if(required)await checkStatus(status,principal,jkt);
 return {principal,keyId:kid,jkt,client:cert.claims.client,certificate:cert.claims,delegateKey:cert.delegateKey,statusChecked:Boolean(required)};
}

// A third party's introduction (peer-proposal data.introduction): that peer's own signed invitation response or
// peer-hello, verified against the proposed principal with a status check; its binding must be its certified ingress (S-2).
async function verifyIntroduction(intro,{principal,keyId},options){
 if(Object.hasOwn(intro.payload,'responder')){
  const p=intro.payload,peer=await authenticate(intro,{...options,domain:DOMAINS.invitationResponse,principal,keyId,purpose:PURPOSES.author,at:p.createdAt,required:false});
  if(p.binding.ingress!==peer.client.ingress)unverifiable();
  await checkStatus(options.status,principal,peer.jkt);peer.statusChecked=true;return {kind:'invitation-response',author:peer,binding:p.binding};
 }
 const verified=await verifyEnvelope(intro,options);return {kind:'peer-hello',author:verified.author,binding:intro.payload.record.data.binding};
}

// §3.3 plus kind bindings. Returns {envelope, author, payloadDigest, eventId?, introduction?}. Window, replay,
// credential and live-consent checks belong to the caller's admission transaction (replay.mjs, conversation.mjs).
export async function verifyEnvelope(input,options={}){
 const {allowLoopback=false,crypto=globalThis.crypto}=options,e=await validateEnvelope(input,options),p=e.payload;
 const author=await authenticate(e,{...options,domain:DOMAINS.envelope,principal:p.author.principal,keyId:p.author.keyId,purpose:PURPOSES.author,at:p.createdAt,required:false});
 const ingress=author.client.ingress;let introduction;
 if(p.kind==='conversation-init'){
  const c=p.conversation,g=c.genesis;
  // The creator's binding and return control must be on its certified ingress (S-4, S-11).
  if(c.creatorBinding.ingress!==ingress||!sameOrigin(c.returnControl.resource,ingress))unverifiable();
  // The genesis carries its own delegation outside the signed input; it must certify the same key and principal (BR-9).
  let gc;try{gc=parseDelegation(g.proof.delegation,{allowLoopback}).claims;}catch{unverifiable();}
  if(gc.jkt!==author.jkt||gc.iss!==author.certificate.iss||gc.sub!==author.certificate.sub)unverifiable();
  if(g.payload.createdAt<author.certificate.since*1000-LIMITS.clockSkewMs||!await verifyES256(author.delegateKey,fromBase64url(g.proof.signature,64),signingInput(DOMAINS.genesis,g),crypto))unverifiable();
 }else if(p.kind==='conversation-record'){
  const r=p.record;
  if(['peer-hello','ingress','rejoin'].includes(r.type)&&r.data.binding.ingress!==ingress)unverifiable();
  if(r.type==='peer-proposal'&&r.data.introduction)introduction=await verifyIntroduction(r.data.introduction,r.data,{...options,allowLoopback,crypto});
 }
// Status last: cheap binding and signature checks already passed, so a forged object costs no status fetch.
 if(statusRequired(e)){await checkStatus(options.status,author.principal,author.jkt);author.statusChecked=true;}
 return {envelope:e,author,payloadDigest:await payloadDigest(e,crypto),...p.kind==='conversation-record'?{eventId:await eventId(e,crypto)}:{},...introduction?{introduction}:{}};
}

// §6.2 processing order (S-11): nonce, conversation, genesis digest, participant and expiry before any crypto,
// directory lookup or status fetch. Failures are the uniform not_authorized, except expiry.
export function precheckInvitationResponse(input,{conversationId,genesisDigest,nonce,participants,expiresAt,now}){
 const p=input?.payload;if(!plain(p))fail('malformed');
 if(!equalDigest(p.nonce,nonce)||p.conversationId!==conversationId||!equalDigest(p.genesisDigest,genesisDigest))fail('not_authorized');
 const entry=Array.isArray(participants)?participants.find(x=>x.principal.issuer===p.responder?.principal?.issuer&&x.principal.subject===p.responder?.principal?.subject):undefined;
 if(!entry||!sameValue(entry.principal,p.responder.principal)||entry.keyId!==p.responder.keyId)fail('not_authorized');
 if(!time(expiresAt))fail('not_authorized');if(!Number.isSafeInteger(now)||now>expiresAt)fail('invitation_expired');
 return entry;
}
// The single-use nonce check (identical bytes replay, different bytes invitation_used) is the caller's, keyed by
// replay.invitationDecision, and runs between precheck and this verification.
export async function verifyInvitationResponse(input,{invitation,...options}){
 const v=await validateInvitationResponse(input,options);precheckInvitationResponse(v,{...invitation,now:options.now});const p=v.payload;
 const responder=await authenticate(v,{...options,domain:DOMAINS.invitationResponse,principal:p.responder.principal,keyId:p.responder.keyId,purpose:PURPOSES.author,at:p.createdAt,required:false});
 if(p.binding&&p.binding.ingress!==responder.client.ingress)unverifiable();
 await checkStatus(options.status,responder.principal,responder.jkt);responder.statusChecked=true;
 return {response:v,responder,decision:p.decision,acceptListed:p.acceptListed===true,binding:p.binding??null,digest:await payloadDigest(v,options.crypto??globalThis.crypto)};
}

// Sender-side §8.1. Never throws: anything short of every check leaves the obligation `unknown` with a reason.
// obligation: {principal:{issuer, subject}, ingress, operationId, payloadDigest, bodyDigest (null without body), kind, eventId?}.
export async function verifyReceipt(input,{obligation,resolveKey,status,now,allowLoopback=false,crypto=globalThis.crypto}){
 const unknown=reason=>({state:'unknown',reason});
 let v;try{v=validateReceipt(input,{allowLoopback});}catch{return unknown('malformed');}
 const p=v.payload,o=obligation;
 if(p.recipient.issuer!==o.principal.issuer||p.recipient.subject!==o.principal.subject||(o.principal.identityURI!==undefined&&p.recipient.identityURI!==o.principal.identityURI))return unknown('recipient');
 if(p.ingress!==o.ingress)return unknown('ingress');
 if(p.operationId!==o.operationId||p.kind!==o.kind||p.payloadDigest!==o.payloadDigest||p.bodyDigest!==(o.bodyDigest??null)||(p.eventId??null)!==(o.eventId??null))return unknown('digest');
 if(!Number.isSafeInteger(now)||p.receivedAt>now+LIMITS.clockSkewMs)return unknown('received_at');
 let signer;try{signer=await authenticate(v,{domain:DOMAINS.receipt,principal:p.recipient,purpose:PURPOSES.receipt,at:p.receivedAt,atOnly:true,required:true,resolveKey,status,now,allowLoopback,crypto});}
 catch(error){return unknown(error?.revoked?'revoked':error?.status===503?'status_unavailable':'certificate');}
 const c=signer.certificate;
 if(p.receivedAt<c.iat*1000-LIMITS.clockSkewMs||p.receivedAt>c.exp*1000+LIMITS.clockSkewMs||p.receivedAt<c.since*1000||p.receivedAt>now+LIMITS.clockSkewMs)return unknown('received_at');
 if(signer.client.ingress!==o.ingress)return unknown('ingress');
 return {state:'delivered',receivedAt:p.receivedAt,receipt:v,signer:{jkt:signer.jkt,cnx:c.cnx,client:c.client}};
}
