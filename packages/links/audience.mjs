// Core links: audience evaluation, decisions, response signing and replay state (links §7.2–§7.5, §8, §9).
// Moved from packages/runtime/contact-links.mjs (extraction slice C1a), which re-exports these. Methods taking
// `c` run on the AccountController; the ungated ones never hold the account gate across cross-account lookups.
import {StorageError} from '../storage/policy.mjs';
import {key,digest,fail} from '../core/records.mjs';
import {contactIntake} from '../messaging/tag-policy.mjs';
import {LinkReplayRecord} from './replay.mjs';
import {prepareLinkResponse,signLinkResponse,verifyLinkResponse} from '../identity/link-response.mjs';
import {evaluateLinkPolicy} from '../runtime/developer-contact.mjs';
import {UUID} from '../core/primitives.mjs';
const DAY=86400000,CONTACT_PATH=/^\/users\/(?:[a-z0-9][a-z0-9_-]{2,31}|n\.[0-9abcdefghjkmnpqrstvwxyz]{1,9})\/contact\/[a-f0-9-]{36}$/;
const local=c=>c.config.LOCAL_DEVELOPMENT==='true';
const decisionPath=async(parent,principal)=>`link-audience/${parent}/${await digest(crypto,`${principal.issuer}\u0000${principal.subject}`)}`;
const invalid=()=>{throw new StorageError('link_invalid','This contact link is invalid or no longer active.',401);};
// Host-policy decision for one (parent, verified principal), with bounded reuse (links §7.5):
// a final positive decision lasts the UTC day, anything lower or negative at most 15 minutes.
export async function linkAudienceDecide(c,owner,parent,principal){
 if(!UUID.test(parent)||typeof principal?.issuer!=='string'||!UUID.test(principal?.subject??''))return {state:'unavailable'};
 const grant=await c.metadata.get(key('contact-grant',parent)),audience=grant?.endpoint?.claims?.audience;if(grant?.owner!==owner||!grant.active||!audience)return {state:'unavailable'};
 return cachedDecision(c,parent,principal,audience.policy);
}
// Links-contract `evaluate` port for app-declared links (LinkService `decide`, bindlebox §4.2): the same bounded
// reuse, with the decision bound to the policy it was made under, so a policy change never reuses an old positive.
export async function decideLinkAudience(c,{parent,policy,principal}){
 if(!UUID.test(parent??'')||typeof principal?.issuer!=='string'||!UUID.test(principal?.subject??''))return {state:'unavailable'};
 return cachedDecision(c,parent,principal,policy,true);
}
async function cachedDecision(c,parent,principal,policy,bindPolicy=false){
 const path=await decisionPath(parent,principal),now=Date.now(),cached=await c.metadata.get(path);
 if(cached?.version===1&&cached.issuer===principal.issuer&&cached.subject===principal.subject&&cached.expiresAt>now&&cached.decidedAt<=now&&(!bindPolicy||cached.policy===(policy??null)))return cached;
 let result;try{result=await evaluateLinkPolicy(c,policy,principal);}catch{result=null;}
 if(!result||result.state==='unavailable')return {state:'unavailable'};
 const dayEnd=(Math.floor(now/DAY)+1)*DAY,record={version:1,issuer:principal.issuer,subject:principal.subject,state:result.eligible?'eligible':'ineligible',...result.reason?{reason:result.reason}:{},...result.tier?{tier:result.tier}:{},tags:result.eligible?result.tags??[]:[],decidedAt:now,expiresAt:result.eligible&&result.final?dayEnd:Math.min(dayEnd,now+900000),...bindPolicy?{policy:policy??null}:{}};
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
