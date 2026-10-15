import {StorageError} from '../storage/policy.mjs';
import {key,digest,fail} from '../messaging/store.mjs';
import {contactIntake} from '../messaging/tag-policy.mjs';
import {LinkReplayRecord} from '../messaging/link-replay.mjs';
import {parseLinkQuery,parseLinkMeta,strictJSON,CONTACT_LINK_TYPE} from '../messaging/bindle-links.mjs';
import {createAuthoredEnvelope,localIdentityDescriptor} from '../messaging/contact-delivery.mjs';
import {prepareLinkResponse,signLinkResponse,verifyLinkResponse} from '../identity/link-response.mjs';
import {evaluateLinkPolicy} from './developer-contact.mjs';
import {UUID} from '../core/primitives.mjs';
// Owner-host wiring for Bindle links (docs/spec/links.md §6–§9). Methods taking `c` run on the
// AccountController; the ungated ones never hold the account gate across cross-account lookups.
const DAY=86400000,CONTACT_PATH=/^\/users\/(?:[a-z0-9][a-z0-9_-]{2,31}|n\.[0-9abcdefghjkmnpqrstvwxyz]{1,9})\/contact\/[a-f0-9-]{36}$/;
const local=c=>c.config.LOCAL_DEVELOPMENT==='true';
const decisionPath=async(parent,principal)=>`link-audience/${parent}/${await digest(crypto,`${principal.issuer}\u0000${principal.subject}`)}`;
const invalid=()=>{throw new StorageError('link_invalid','This contact link is invalid or no longer active.',401);};
// Host-policy decision for one (parent, verified principal), with bounded reuse (links §7.5):
// a final positive decision lasts the UTC day, anything lower or negative at most 15 minutes.
export async function linkAudienceDecide(c,owner,parent,principal){
 if(!UUID.test(parent)||typeof principal?.issuer!=='string'||!UUID.test(principal?.subject??''))return {state:'unavailable'};
 const grant=await c.metadata.get(key('contact-grant',parent)),audience=grant?.endpoint?.claims?.audience;if(grant?.owner!==owner||!grant.active||!audience)return {state:'unavailable'};
 const path=await decisionPath(parent,principal),now=Date.now(),cached=await c.metadata.get(path);
 if(cached?.version===1&&cached.issuer===principal.issuer&&cached.subject===principal.subject&&cached.expiresAt>now&&cached.decidedAt<=now)return cached;
 let result;try{result=await evaluateLinkPolicy(c,audience.policy,principal);}catch{result=null;}
 if(!result||result.state==='unavailable')return {state:'unavailable'};
 const dayEnd=(Math.floor(now/DAY)+1)*DAY,record={version:1,issuer:principal.issuer,subject:principal.subject,state:result.eligible?'eligible':'ineligible',...result.reason?{reason:result.reason}:{},...result.tier?{tier:result.tier}:{},tags:result.eligible?result.tags??[]:[],decidedAt:now,expiresAt:result.eligible&&result.final?dayEnd:Math.min(dayEnd,now+900000)};
 await c.metadata.put(path,record);return record;
}
// Admission-time port (ContactDeliveryService audience.admit): reads only the recorded decision.
export async function admitLinkAudience(tx,{grant,principal,now}){
 const record=await tx.get(await decisionPath(grant.id,principal));
 if(record?.version!==1||record.issuer!==principal.issuer||record.subject!==principal.subject||!(record.expiresAt>now))fail('audience_unavailable');
 if(record.state!=='eligible')fail('audience_ineligible');return {tags:record.tags??[]};
}
// links §7.3 same-host audience lookup for verifyLinkResponse.
async function audienceRecord(c,{sub,handle,kid}){const record=await c.identityRecord(sub,kid);return record&&{active:record.accountActive===true,handle:record.handle,key:{kid,alg:record.alg,publicJwk:record.publicJwk,active:record.active===true,purpose:record.purpose}};}
// JSON inspection (links §8): the only representation that evaluates and consumes bindle_data.
export async function inspectContactLink(c,owner,url){
 const inspected=await c.endpoints.inspect(url,{allowData:true}),{grant}=inspected;if(grant.owner!==owner)fail('unauthorized');
 const intake=contactIntake(grant),link=inspected.form==='link',policy=link?grant.endpoint.claims.audience?.policy:undefined;
 const base={form:inspected.form,kinds:link?grant.endpoint.claims.kinds:['one-off'],authorship:['identity'],mimeTypes:grant.claims.mimeTypes,maxMessageBytes:grant.claims.maxMessageBytes,expiresAt:grant.claims.exp*1000,conditional:Boolean(inspected.conditional),optionalTags:intake?.optionalTags??[],...policy?{policy}:{}};
 if(!link)return {...base,collections:await c.messages.collections(owner).then(all=>all.filter(x=>grant.claims.collections.includes(x.id)).map(({id,name})=>({id,name})))};
 if(!inspected.conditional)return base;if(inspected.data===undefined)return {...base,audience:{state:'required'}};
 let checked;try{checked=await verifyLinkResponse({meta:inspected.meta,data:inspected.data,origin:c.config.APP_ORIGIN,resolve:request=>audienceRecord(c,request)});}catch(error){if(error.code==='audience_malformed')throw error;return {...base,audience:{state:error.code==='audience_stale'?'stale':'unverifiable'}};}
 c.linkReplay??=new LinkReplayRecord({metadata:c.metadata});
 try{await c.linkReplay.consume({parent:inspected.meta.claims.jti,iss:checked.principal.iss,sub:checked.principal.sub,key:checked.replay.key,expiresAt:checked.replay.expiresAt});}catch(error){return {...base,audience:{state:error.code==='audience_stale'?'stale':'unavailable'}};}
 const decision=await linkAudienceDecide(c,owner,grant.id,{issuer:checked.principal.iss,subject:checked.principal.sub});
 return {...base,audience:{state:decision.state,...decision.state==='ineligible'&&decision.reason?{reason:decision.reason}:{}}};
}
// links §9 step 2: the signed-in opener's own provider signs, after an explicit click, for a same-host link only.
export async function signOwnLinkResponse(c,owner,handle,link){
 let meta;try{meta=prepareLinkResponse(link,{allowInsecureLocalhost:local(c)});if(new URL(link).origin!==c.config.APP_ORIGIN||meta.claims.iss!==c.config.APP_ORIGIN||!CONTACT_PATH.test(new URL(link).pathname))fail('link_invalid');}catch{invalid();}
 if(typeof handle!=='string'||!handle)throw new StorageError('unauthorized','Sign in again to continue.',401);
 const signer=await c.signingKey(owner);
 return signLinkResponse({meta,principal:{iss:c.config.APP_ORIGIN,sub:owner,handle:`${handle}@${new URL(c.config.APP_ORIGIN).host}`},key:signer,allowInsecureLocalhost:local(c)});
}
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
// Bounded expiry sweeps for receipt fences, per-author days, decisions and replay rows.
async function sweep(c,prefix,expired,limit=128){
 const cursorKey='link-gc-cursor/'+prefix,cursor=await c.metadata.get(cursorKey);let rows=await c.metadata.list({prefix,...cursor?{startAfter:cursor}:{},limit});if(!rows.size&&cursor)rows=await c.metadata.list({prefix,limit});
 const now=Date.now(),stale=[...rows].filter(([,row])=>expired(row,now)).map(([path])=>path);for(let i=0;i<stale.length;i+=64)await c.metadata.delete(stale.slice(i,i+64));
 if(rows.size)await c.metadata.put(cursorKey,[...rows.keys()].at(-1));else await c.metadata.delete(cursorKey);return rows.size===limit;
}
export async function collectLinkState(c,owner){
 let more=false;
 more=await sweep(c,key('contact-delivery-receipt',owner),(row,now)=>Number.isSafeInteger(row?.retainUntil)&&row.retainUntil<=now)||more;
 more=await sweep(c,key('contact-author-day',owner),(row,now)=>Number.isSafeInteger(row?.expiresAt)&&row.expiresAt<=now)||more;
 more=await sweep(c,'link-audience/',(row,now)=>!(row?.expiresAt>now))||more;
 c.linkReplay??=new LinkReplayRecord({metadata:c.metadata});
 for(const grant of (await c.metadata.list({prefix:key('contact-grant'),limit:1001})).values())if(grant?.owner===owner&&grant.endpoint?.claims?.audience)await c.linkReplay.purge(grant.id,64);
 if(more)await c.scheduleAlarm(Date.now()+3600000);
}
