// Signed admission evidence for app activity (docs/spec/activity.md "Item identity, attribution, and signed
// evidence"). Every admitted revision, including a retraction tombstone, binds the authenticated app connection,
// destination account, item, revision, operation and exact content metadata with explicit absent values. The
// signature attests which approved connection submitted the operation; it is not publisher authorship.
// Provisional binding: canonical JSON (packages/core/primitives.mjs) signed with ES256 under a purpose label
// distinct from v1 app-message provenance; keys are the issuer's published app-notification key set.
import {canonical} from '../core/primitives.mjs';
import {digest,fromBase64url} from '../core/records.mjs';
import {ACTIVITY_PURPOSE,fail} from './model.mjs';

export const contentDigest=content=>digest(crypto,canonical({subject:content.subject,mimeType:content.mimeType,body:content.body}));
/** The exact evidence object for one revision; every field is present, absent values are null. */
export async function admissionEvidence({actor,item,revision,operation,admittedAt,previousRevision=null}){
 const content=operation.content??null;
 return {
  version:1,purpose:ACTIVITY_PURPOSE,issuer:actor.issuer,account:actor.owner,item,revision,
  app:{issuer:actor.issuer,clientId:actor.app.clientId,origin:actor.app.origin,name:actor.app.name},
  connection:{id:actor.connection.id,generation:actor.connection.generation,admissionGeneration:actor.connection.admissionGeneration},
  operationId:operation.operationId,operationKind:operation.kind,createdAt:operation.createdAt,admittedAt,previousRevision,
  contentDigest:content?await contentDigest(content):null,mimeType:content?.mimeType??null,subject:content?.subject??null,
  tags:content?.tags??null,priority:content?.priority??null,collapseKey:content?.collapseKey??null,expiresAt:content?.expiresAt??null,
 };
}
/** Signs with the injected issuer key ({kid, sign(payload)}); a missing key refuses admission, never stores unsigned. */
export async function attest(keys,evidence){
 if(!keys||typeof keys.kid!=='string'||typeof keys.sign!=='function')fail('temporarily_unavailable','Activity signing is unavailable.',503);
 return {alg:'ES256',kid:keys.kid,signature:await keys.sign(evidence)};
}
/** Verifies a stored revision record as a whole: the signature, and that the signed fields are exactly this account's
 * item, revision, kind and content (recomputed digest), so a valid signature cannot be pasted onto other content. */
export async function verifyRevision(record,{issuer,keys,owner,item}){
 const e=record?.evidence,c=record?.content??null;
 if(!e||e.account!==owner||e.item!==item||e.revision!==record.revision||e.operationKind!==record.kind)return false;
 if(c?[e.contentDigest!==await contentDigest(c),e.mimeType!==c.mimeType,e.subject!==c.subject,JSON.stringify(e.tags)!==JSON.stringify(c.tags),e.priority!==c.priority,e.collapseKey!==c.collapseKey,e.expiresAt!==c.expiresAt].some(Boolean):[e.contentDigest,e.subject,e.tags].some(v=>v!==null))return false;
 return verifyEvidence(e,record.attestation,{issuer,keys});
}
/** Verifies one revision against the issuer's own key set (never a key or URL carried with the item). */
export async function verifyEvidence(evidence,attestation,{issuer,keys}){
 try{
  if(!evidence||evidence.purpose!==ACTIVITY_PURPOSE||evidence.issuer!==issuer||evidence.app?.issuer!==issuer||attestation?.alg!=='ES256')return false;
  const jwk=keys?.keys?.find(k=>k.kid===attestation.kid);if(!jwk)return false;
  const key=await crypto.subtle.importKey('jwk',{kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,fromBase64url(attestation.signature),new TextEncoder().encode(canonical(evidence)));
 }catch{return false;}
}
