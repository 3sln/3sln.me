// Exact shapes, semantic digests and signing for every Bindle Messaging signed object (spec §2.3, §3.1, §5, §6, §8.1).
// Structural only: author, certificate and binding checks live in verify.mjs. Envelope parsing rules are
// adapted from core contact-delivery.mjs "One semantic envelope" (copied, not imported).
import {PROFILE,DOMAINS,LIMITS,KINDS,LINK_KINDS,RECORD_TYPES,HELLO_INCARNATION,RECEIPT_PURPOSE} from './constants.mjs';
import {fail,malformed,textEncoder,jcs,sha256,plain,exact,text,time,positive,uuid,isUUID,digestValue,opaque,keyIdValue,mimeValid,compactValue,urlValue,endpointValue,originValue,uriValue,scalarCompare,fromBase64url,sameValue,detach} from './encoding.mjs';
import {jktOf,parseDelegation,signES256} from './certificate.mjs';

// Host-advertised limits may only shrink the §11 maxima.
export const clampLimits=(limits={})=>Object.freeze(Object.fromEntries(Object.entries(LIMITS).map(([k,max])=>[k,Number.isSafeInteger(limits?.[k])&&limits[k]>0?Math.min(limits[k],max):max])));
const o=options=>({local:options.allowLoopback===true,limits:clampLimits(options.limits),maxParticipants:Math.min(Number.isSafeInteger(options.maxParticipants)&&options.maxParticipants>0?options.maxParticipants:LIMITS.maxParticipants,LIMITS.maxParticipants)});
const principalKey=p=>`${p.issuer} ${p.subject}`;

export function validatePrincipal(v,{local=false}={}){
 exact(v,['issuer','subject','identityURI']);originValue(v.issuer,local);uuid(v.subject);
 if(endpointValue(v.identityURI,local).origin!==v.issuer)malformed();return v;
}
// §3.1 author descriptor: identityURI and identityDocument on the issuer's origin; delegate is "jkt:<thumbprint>".
export function validateAuthor(v,{local=false}={}){
 exact(v,['principal','identityDocument','keyId','delegate']);validatePrincipal(v.principal,{local});
 if(endpointValue(v.identityDocument,local).origin!==v.principal.issuer)malformed();keyIdValue(v.keyId);jktOf(v.delegate);return v;
}
export function validateProof(v,kid){
 exact(v,['alg','kid','delegation','signature']);if(v.alg!=='ES256'||v.kid!==kid)malformed();compactValue(v.delegation);fromBase64url(v.signature,64);return v;
}
export function validateContent(v,limits=LIMITS){
 exact(v,['mimeType','byteLength','sha256']);if(!mimeValid(v.mimeType)||!time(v.byteLength))malformed();
 if(v.byteLength>Math.min(limits.maxBodyBytes,LIMITS.maxBodyBytes))fail('too_large');digestValue(v.sha256);return v;
}
const validateTags=v=>{if(!Array.isArray(v)||v.length>LIMITS.maxTags)malformed();for(let i=0;i<v.length;i++){if(!text(v[i],64,1)||v[i].trim()!==v[i])malformed();if(i&&scalarCompare(v[i-1],v[i])>=0)malformed();}return v;};
const validateProfiles=v=>{if(!Array.isArray(v)||!v.length||v.length>LIMITS.maxProfiles)malformed();v.forEach(uriValue);if(new Set(v).size!==v.length||!v.includes(PROFILE))fail('unsupported_profile');return v;};
export function validateLimits(v){
 exact(v,['maxParticipants','maxMessageBytes','maxEnvelopeBytes'],['maxBatchContexts']);
 if(!positive(v.maxParticipants,LIMITS.maxParticipants)||!positive(v.maxMessageBytes,LIMITS.maxBodyBytes)||!positive(v.maxEnvelopeBytes,LIMITS.maxEnvelopeBytes)||(Object.hasOwn(v,'maxBatchContexts')&&!positive(v.maxBatchContexts,LIMITS.maxBatchContexts)))malformed();
 return v;
}
// Conversation binding {ingress, incarnation, profiles, limits, multicast?}. `hello` is reserved for peer-hello tokens.
export function validateBinding(v,{local=false}={}){
 exact(v,['ingress','incarnation','profiles','limits'],['multicast']);const u=endpointValue(v.ingress,local);opaque(v.incarnation);
 if(v.incarnation===HELLO_INCARNATION)malformed();validateProfiles(v.profiles);validateLimits(v.limits);
 if(Object.hasOwn(v,'multicast')&&endpointValue(v.multicast,local).origin!==u.origin)malformed();return v;
}
// §2.3 ingress descriptor (`describe` omits expiresAt). Pass `now` to bound expiresAt to the next hour.
export function validateDescriptor(input,{now,describe=false,allowLoopback=false}={}){
 const v=detach(input),local=allowLoopback===true;
 exact(v,['version','profiles','ingress','limits','kinds',...describe?[]:['expiresAt']],['multicast','verifies']);
 if(v.version!==1)malformed();validateProfiles(v.profiles);const u=endpointValue(v.ingress,local);validateLimits(v.limits);
 if(Object.hasOwn(v,'multicast')&&endpointValue(v.multicast,local).origin!==u.origin)malformed();
 if(Object.hasOwn(v,'verifies')){if(!Array.isArray(v.verifies)||v.verifies.length>LIMITS.maxVerifies)malformed();v.verifies.forEach(x=>originValue(x,local));if(new Set(v.verifies).size!==v.verifies.length)malformed();}
 validateKinds(v.kinds);
 if(!describe&&(!time(v.expiresAt)||(now!==undefined&&(v.expiresAt<=now||v.expiresAt>now+LIMITS.descriptorCacheMs))))malformed();
 return v;
}
export const validateKinds=v=>{if(!Array.isArray(v)||!v.length||v.some((k,i)=>!LINK_KINDS.includes(k)||(i&&!(v[i-1]<k))))malformed();return v;};

// Genesis {payload, proof} (§6.1). The participant list is a proposal, never a roster.
export function validateGenesis(input,options={}){
 const {local,maxParticipants}=o(options),g=detach(input);exact(g,['payload','proof']);
 const p=exact(g.payload,['version','profile','conversationId','createdAt','creator','participants','secretEpoch','secretDigest','subject','content']);
 if(p.version!==1)malformed();if(p.profile!==PROFILE)fail('unsupported_profile');uuid(p.conversationId);if(!time(p.createdAt))malformed();
 validateAuthor(p.creator,{local});uuid(p.secretEpoch);digestValue(p.secretDigest);if(!text(p.subject,LIMITS.maxSubjectPoints))malformed();validateContent(p.content);
 if(!Array.isArray(p.participants)||p.participants.length<2||p.participants.length>LIMITS.maxParticipants)malformed();
 const seen=new Set();for(const entry of p.participants){exact(entry,['principal','keyId']);validatePrincipal(entry.principal,{local});keyIdValue(entry.keyId);const k=principalKey(entry.principal);if(seen.has(k))malformed();seen.add(k);}
 if(p.participants.length>maxParticipants)fail('participants_exceeded');
 const creators=p.participants.filter(x=>sameValue(x.principal,p.creator.principal));if(creators.length!==1||creators[0].keyId!==p.creator.keyId)malformed();
 validateProof(g.proof,p.creator.delegate);return g;
}

const RECORD_SHAPES={message:{body:true},edit:{body:true,target:true},retract:{target:true},'peer-proposal':{data:true},'peer-response':{data:true},'peer-hello':{data:true},rotate:{data:true,secret:true},rejoin:{data:true},'secret-share':{data:true,secret:true},leave:{},ingress:{data:true}};
export const recordShape=type=>RECORD_SHAPES[type];
async function validateRecord(p,options){
 const {local}=o(options),r=p.record;
 if(!plain(r))malformed();if(typeof r.type!=='string')malformed();if(!RECORD_TYPES.includes(r.type))fail('record_unsupported');
 const shape=RECORD_SHAPES[r.type];
 exact(r,['type','conversationId','epoch','stream','counter','previous','parents',...shape.target?['target']:[],...shape.data?['data']:[]]);
 if(r.conversationId!==p.recipient.conversationId)malformed();uuid(r.epoch);if(r.stream!==p.author.delegate)malformed();
 if(!positive(r.counter,Number.MAX_SAFE_INTEGER))malformed();
 if(r.previous===null){if(r.counter!==1)malformed();}else digestValue(r.previous);
 if(!Array.isArray(r.parents)||r.parents.length>LIMITS.maxParents)malformed();r.parents.forEach(digestValue);if(new Set(r.parents).size!==r.parents.length)malformed();
 if(shape.target)digestValue(r.target);
 if((shape.body===true)!==(p.content!==null))malformed();
 if((r.type==='peer-hello')!==(p.recipient.incarnation===HELLO_INCARNATION))malformed();
 const d=r.data;
 switch(r.type){
  case 'peer-proposal':{
   exact(d,['principal','keyId'],['introduction']);validatePrincipal(d.principal,{local});keyIdValue(d.keyId);
   if(Object.hasOwn(d,'introduction')){
    const intro=d.introduction;if(!plain(intro)||!plain(intro.payload))malformed();
    if(Object.hasOwn(intro.payload,'responder')){await validateInvitationResponse(intro,options);if(!sameValue(intro.payload.responder.principal,d.principal)||intro.payload.responder.keyId!==d.keyId||intro.payload.decision!=='accept')malformed();}
    else{await validateEnvelope(intro,{...options,nested:true});if(intro.payload.record?.type!=='peer-hello'||!sameValue(intro.payload.author.principal,d.principal)||intro.payload.author.keyId!==d.keyId)malformed();}
    if(intro.payload.conversationId!==undefined?intro.payload.conversationId!==r.conversationId:intro.payload.record.conversationId!==r.conversationId)malformed();
   }
   break;
  }
  case 'peer-response':exact(d,['proposal','decision']);digestValue(d.proposal);if(!['accept','decline'].includes(d.decision))malformed();break;
  case 'peer-hello':exact(d,['binding','startCounter']);validateBinding(d.binding,{local});if(!positive(d.startCounter,Number.MAX_SAFE_INTEGER))malformed();break;
  case 'rotate':exact(d,['newEpoch','secretDigest']);uuid(d.newEpoch);digestValue(d.secretDigest);if(d.newEpoch===r.epoch)malformed();break;
  case 'secret-share':exact(d,['epoch','secretDigest']);uuid(d.epoch);digestValue(d.secretDigest);break;
  case 'rejoin':case 'ingress':exact(d,['binding']);validateBinding(d.binding,{local});break;
 }
}

async function validateConversation(c,p,options){
 const {local,limits}=o(options);
 exact(c,['genesis','sharedSecret','returnControl','creatorBinding']);validateGenesis(c.genesis,options);
 const g=c.genesis.payload;
 if(!sameValue(g.creator,p.author)||g.createdAt>p.createdAt||!sameValue(g.content,p.content)||g.subject!==p.subject)malformed();
 if(g.participants.filter(x=>x.principal.issuer===p.recipient.issuer&&x.principal.subject===p.recipient.owner).length!==1)malformed();
 const secret=fromBase64url(c.sharedSecret,32);if(await sha256(options.crypto??globalThis.crypto,secret)!==g.secretDigest)malformed();
 const rc=exact(c.returnControl,['resource','nonce','expiresAt','maxResponseBytes']);endpointValue(rc.resource,local);fromBase64url(rc.nonce,16);
 if(!time(rc.expiresAt)||rc.expiresAt<=p.createdAt||rc.expiresAt>p.createdAt+limits.maxBootstrapMs||rc.maxResponseBytes!==LIMITS.maxInvitationResponseBytes)malformed();
 validateBinding(c.creatorBinding,{local});
}

// §5.1. Async only for the conversation-init secret digest. Returns a detached, validated copy.
// Options: allowLoopback (development only), limits (host-advertised, never above §11), maxParticipants.
export async function validateEnvelope(input,options={}){
 const {local,limits}=o(options),e=detach(input);
 if(!plain(e)||!plain(e.payload))malformed();
 if(e.payload.author==null||e.proof==null)fail('author_required');
 exact(e,['payload','proof']);const p=e.payload;
 exact(p,['version','profile','kind','noReply','operationId','createdAt','recipient','content','subject','optionalTags','author'],['conversation','record','resendOf']);
 if(p.version!==1)malformed();if(p.profile!==PROFILE)fail(typeof p.profile==='string'?'unsupported_profile':'malformed');
 if(!KINDS.includes(p.kind)||p.noReply!==(p.kind==='one-off')||!isUUID(p.operationId)||!time(p.createdAt)||!text(p.subject,LIMITS.maxSubjectPoints))malformed();
 validateAuthor(p.author,{local});validateProof(e.proof,p.author.delegate);validateTags(p.optionalTags);
 if(p.content!==null)validateContent(p.content,limits);
 if(p.kind==='conversation-record'){
  if(Object.hasOwn(p,'conversation')||!Object.hasOwn(p,'record')||p.optionalTags.length)malformed();
  exact(p.recipient,['issuer','owner','conversationId','incarnation']);originValue(p.recipient.issuer,local);uuid(p.recipient.owner);uuid(p.recipient.conversationId);opaque(p.recipient.incarnation);
  if(Object.hasOwn(p,'resendOf'))digestValue(p.resendOf);
  if(options.nested&&p.record?.type==='peer-proposal')malformed();
  await validateRecord(p,options);
 }else{
  if(Object.hasOwn(p,'record')||Object.hasOwn(p,'conversation')!==(p.kind==='conversation-init')||p.content===null||options.nested)malformed();
  exact(p.recipient,['issuer','owner','contactId','resource']);originValue(p.recipient.issuer,local);uuid(p.recipient.owner);
  if(!text(p.recipient.contactId,128,1)||!text(p.recipient.resource,128,1))malformed();
  if(Object.hasOwn(p,'resendOf'))uuid(p.resendOf);
  if(p.kind==='conversation-init')await validateConversation(p.conversation,p,options);
 }
 if(textEncoder.encode(jcs(e)).byteLength>limits.maxEnvelopeBytes)fail('too_large');
 return e;
}

// §6.2 invitation response. `binding` exactly on accept; acceptListed optional (absent means false).
export async function validateInvitationResponse(input,options={}){
 const {local}=o(options),v=detach(input);
 exact(v,['payload','proof']);const p=exact(v.payload,['version','profile','conversationId','genesisDigest','nonce','decision','responder','createdAt'],['acceptListed','binding']);
 if(p.version!==1)malformed();if(p.profile!==PROFILE)fail(typeof p.profile==='string'?'unsupported_profile':'malformed');
 uuid(p.conversationId);digestValue(p.genesisDigest);fromBase64url(p.nonce,16);if(!['accept','decline'].includes(p.decision)||!time(p.createdAt))malformed();
 if(Object.hasOwn(p,'acceptListed')&&typeof p.acceptListed!=='boolean')malformed();
 validateAuthor(p.responder,{local});if(Object.hasOwn(p,'binding')!==(p.decision==='accept'))malformed();if(p.binding)validateBinding(p.binding,{local});
 validateProof(v.proof,p.responder.delegate);
 if(textEncoder.encode(jcs(v)).byteLength>LIMITS.maxInvitationResponseBytes)fail('too_large');
 return v;
}

// §8.1 receipt. `eventId` exactly for conversation-record; `bodyDigest` is null exactly when the envelope had no body.
export function validateReceipt(input,{allowLoopback=false}={}){
 const v=detach(input),local=allowLoopback===true;
 exact(v,['payload','proof']);const p=exact(v.payload,['version','purpose','recipient','ingress','operationId','payloadDigest','bodyDigest','kind','receivedAt','state','custody'],['eventId']);
 if(p.version!==1||p.purpose!==RECEIPT_PURPOSE||p.state!=='delivered'||p.custody!=='complete'||!KINDS.includes(p.kind)||!time(p.receivedAt))malformed();
 validatePrincipal(p.recipient,{local});endpointValue(p.ingress,local);uuid(p.operationId);digestValue(p.payloadDigest);if(p.bodyDigest!==null)digestValue(p.bodyDigest);
 if(Object.hasOwn(p,'eventId')!==(p.kind==='conversation-record'))malformed();if(p.eventId!==undefined)digestValue(p.eventId);
 if(!plain(v.proof))malformed();jktOf(v.proof.kid);validateProof(v.proof,v.proof.kid);return v;
}

// §5.4: every proof's signature and delegation removed at any depth (outer, genesis, introductions).
const strip=v=>Array.isArray(v)?v.map(strip):plain(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='proof'&&plain(x)?strip(Object.fromEntries(Object.entries(x).filter(([n])=>n!=='signature'&&n!=='delegation'))):strip(x)])):v;
export const semanticObject=signed=>strip(signed);
export const payloadDigest=(signed,crypto=globalThis.crypto)=>sha256(crypto,jcs(strip(signed)));
// Event ID: the semantic digest without `recipient`, so one author event has one ID across recipients.
export const eventId=(envelope,crypto=globalThis.crypto)=>{if(envelope?.payload?.kind!=='conversation-record')malformed();const {recipient,...payload}=envelope.payload;return sha256(crypto,jcs(strip({payload,proof:envelope.proof})));};
export const genesisDigest=(genesis,crypto=globalThis.crypto)=>sha256(crypto,jcs(strip(genesis)));
export const signingInput=(domain,{payload,proof})=>{if(!Object.values(DOMAINS).includes(domain))malformed();return textEncoder.encode(domain+jcs({alg:proof.alg,kid:proof.kid,payload}));};
export const contentDescriptor=async(mimeType,body,crypto=globalThis.crypto)=>{if(!(body instanceof Uint8Array))malformed();return validateContent({mimeType,byteLength:body.byteLength,sha256:await sha256(crypto,body)});};

// Signers sign only a detached copy they validated themselves, under the domain the object type fixes;
// they never sign caller bytes. `delegation` must certify the signing key's jkt.
const PLACEHOLDER='A'.repeat(86);
async function sign(domain,validate,payload,kid,{privateKey,delegation},options){
 const crypto=options.crypto??globalThis.crypto;jktOf(kid);
 if(parseDelegation(delegation,{allowLoopback:options.allowLoopback===true}).claims.jkt!==kid.slice(4))malformed();
 const v=await validate({payload:detach(payload),proof:{alg:'ES256',kid,delegation,signature:PLACEHOLDER}},options);
 v.proof.signature=await signES256(privateKey,signingInput(domain,v),crypto);return v;
}
export const signEnvelope=(payload,signer,options={})=>sign(DOMAINS.envelope,validateEnvelope,payload,payload?.author?.delegate,signer,options);
export const signGenesis=(payload,signer,options={})=>sign(DOMAINS.genesis,async(g,opt)=>validateGenesis(g,opt),payload,payload?.creator?.delegate,signer,options);
export const signInvitationResponse=(payload,signer,options={})=>sign(DOMAINS.invitationResponse,validateInvitationResponse,payload,payload?.responder?.delegate,signer,options);
export const signReceipt=(payload,signer,options={})=>sign(DOMAINS.receipt,async(r,opt)=>validateReceipt(r,opt),payload,signer.kid,signer,options);
// The custody receipt for one admitted envelope (recipient side). `ingress` is the URL the sender POSTed to.
export async function receiptPayload(envelope,{recipient,ingress,receivedAt,bodyDigest},crypto=globalThis.crypto){
 const p=envelope.payload;return {version:1,purpose:RECEIPT_PURPOSE,recipient,ingress,operationId:p.operationId,...p.kind==='conversation-record'?{eventId:await eventId(envelope,crypto)}:{},payloadDigest:await payloadDigest(envelope,crypto),bodyDigest:p.content===null?null:bodyDigest??p.content.sha256,kind:p.kind,receivedAt,state:'delivered',custody:'complete'};
}
