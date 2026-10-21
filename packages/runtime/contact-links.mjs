import {StorageError} from '../storage/policy.mjs';
import {parseLinkQuery,parseLinkMeta,strictJSON,CONTACT_LINK_TYPE} from '../links/envelope.mjs';
import {createAuthoredEnvelope,localIdentityDescriptor} from '../messaging/contact-delivery.mjs';
import {UUID} from '../core/primitives.mjs';
// Owner-host wiring for Bindle contact links (docs/spec/links.md §6–§9). The generic audience, decision, response
// and replay functions moved to packages/links/audience.mjs (slice C1a) and are re-exported here; envelope
// authoring stays until BindleBox signs locally (extraction plan §2.3).
export {linkAudienceDecide,admitLinkAudience,inspectContactLink,signOwnLinkResponse,collectLinkState} from '../links/audience.mjs';
const DAY=86400000,CONTACT_PATH=/^\/users\/(?:[a-z0-9][a-z0-9_-]{2,31}|n\.[0-9abcdefghjkmnpqrstvwxyz]{1,9})\/contact\/[a-f0-9-]{36}$/;
const local=c=>c.config.LOCAL_DEVELOPMENT==='true';
const invalid=()=>{throw new StorageError('link_invalid','This contact link is invalid or no longer active.',401);};
// Recipient binding from a same-host link the author chose (new form or legacy carve-out, links §10).
function linkRecipient(c,link){
 let target;try{target=new URL(link);}catch{invalid();}
 if(typeof link!=='string'||link.length>18000||target.origin!==c.config.APP_ORIGIN||target.username||target.password||target.hash||!CONTACT_PATH.test(target.pathname))invalid();
 let query;try{query=parseLinkQuery(link);}catch{throw new StorageError('link_malformed','This contact link is malformed.',400);}
 const audience=target.origin+target.pathname,issuer=c.config.APP_ORIGIN;
 if(query.form==='link'){if(query.data!==undefined||target.search!==`?bindle_meta=${query.meta}`)throw new StorageError('link_malformed','Remove extra link parameters before sending.',400);let claims;try{claims=parseLinkMeta(query.meta).claims;}catch{invalid();}if(claims.type!==CONTACT_LINK_TYPE||claims.iss!==issuer||claims.aud!==audience||!UUID.test(claims.sub??'')||!UUID.test(claims.jti??'')||typeof claims.resource!=='string')invalid();return {issuer,owner:claims.sub,contactId:claims.jti,resource:claims.resource};}
 if(query.form!=='legacy'||[...target.searchParams.keys()].join()!=='sig')invalid();
 let claims;try{claims=strictJSON(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(target.searchParams.get('sig').split('.')[1].replaceAll('-','+').replaceAll('_','/')),ch=>ch.charCodeAt(0))));}catch{invalid();}
 if(claims?.iss!==issuer||claims.aud!==audience||!UUID.test(claims.sub??'')||!UUID.test(claims.jti??''))invalid();
 return {issuer,owner:claims.sub,contactId:claims.jti,resource:`${issuer}/entities/${encodeURIComponent(claims.sub)}/contacts/${encodeURIComponent(claims.jti)}`};
}
// The author's provider signs only an envelope it constructs (contact-delivery author proof).
export async function authorLinkEnvelope(c,owner,input){
 const allowed=['link','mimeType','subject','optionalTags','byteLength','sha256','operationId','createdAt'];if(!input||Object.keys(input).some(k=>!allowed.includes(k)))throw new StorageError('invalid_envelope','Review the message and try again.');
 const now=Date.now(),createdAt=input.createdAt===undefined?now:input.createdAt;if(!Number.isSafeInteger(createdAt)||createdAt<now-DAY||createdAt>now+60000)throw new StorageError('operation_expired','Start a new message.');
 const recipient=linkRecipient(c,input.link),signer=await c.signingKey(owner);
 const {envelope}=await createAuthoredEnvelope({author:localIdentityDescriptor(c.config.APP_ORIGIN,owner,signer.kid),privateKey:signer.privateKey,recipient,mimeType:input.mimeType,byteLength:input.byteLength,sha256:input.sha256,subject:input.subject??'',optionalTags:input.optionalTags??[],operationId:input.operationId,createdAt,allowInsecureLocalhost:local(c)});
 return {envelope};
}
