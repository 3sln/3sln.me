import {systemBadge} from '../identity/system-bootstrap.mjs';
import {StorageError} from '../storage/policy.mjs';
import {key,canonical} from '../messaging/store.mjs';
import {BILLING_STATE_KEY,entitlementFromState} from '../billing/catalog.mjs';
import {UUID} from '../core/primitives.mjs';
import {developerPolicy,evaluateRegisteredPolicy} from '../links/policies.mjs';
export const DEVELOPER_CONTACT_TAGS=Object.freeze({free:['contact:developer','priority:free'],paid:['contact:developer','priority:paid'],plus:['contact:developer','priority:plus'],ultra:['contact:developer','priority:ultra']});
export async function developerContactTier(controller,owner){
 await controller.warm(owner);await controller.billingRefresh(owner,{force:true});
 const state=await controller.metadata.get(BILLING_STATE_KEY);
 if(state?.owner!==owner||!['active','canceled'].includes(state.status))return 'free';
 const now=Date.now(),tier=entitlementFromState({...state,upgrade:undefined},now,controller.config).plan;
 if(tier!=='free'&&(!Number.isSafeInteger(state.reconciledAt)||state.reconciledAt>now||state.reconciledAt<now-300000))throw new StorageError('developer_contact_eligibility_unavailable','Your subscription could not be verified. Please try again shortly.',503);
 return tier;
}
// Developer contact is one conditional link owned by the system developer identity
// (links §7, architecture bindle-links "Developer contact"). The operator policy registry
// (packages/links/policies.mjs, slice C1a) holds its policy; nobody else can name or parameterize a policy.
export {DEVELOPER_CONTACT_POLICY,developerPolicy,linkPolicyRegistry} from '../links/policies.mjs';
const OPTIONAL=Object.freeze(['topic:bug','topic:feature','topic:general']),LABELS=Object.freeze({'topic:bug':{en:'Bug report',es:'Informe de error'},'topic:feature':{en:'Feature idea',es:'Idea de función'},'topic:general':{en:'General question',es:'Pregunta general'}});
// Same-host principals only; the decision depends on nothing the audience supplies beyond the principal.
export function evaluateLinkPolicy(controller,policy,principal){return evaluateRegisteredPolicy({origin:controller.config.APP_ORIGIN,config:controller.config,policy,principal,evaluators:{[developerPolicy(controller.config)]:subject=>developerEvaluation(controller,subject)}});}
// The developer-contact evaluator of the registry: billing tier first, then the active-population mode.
async function developerEvaluation(controller,principal){
 let tier;try{if(principal.subject===await controller.metadata.get('owner'))tier=await controller.gated(()=>developerContactTier(controller,principal.subject));else{const result=await controller.config.CONVERSATION_ACCOUNT?.(principal.subject)?.invoke({method:'developerContactTier',args:[principal.subject]});if(typeof result!=='string')return {state:'unavailable'};tier=result;}}catch{return {state:'unavailable'};}
 if(Object.hasOwn(DEVELOPER_CONTACT_TAGS,tier)&&tier!=='free')return {eligible:true,tier,tags:['priority:'+tier],final:tier==='ultra'};
 let population;try{population=await controller.config.DEVELOPER_CONTACT_POPULATION?.policy?.();}catch{}
 const now=Date.now();
 if(!population||!Number.isSafeInteger(population.observedAt)||!Number.isSafeInteger(population.validUntil)||population.observedAt>now||population.validUntil<=now||population.validUntil>population.observedAt+60000||!['all-active','paid-only'].includes(population.mode))return {state:'unavailable'};
 return population.mode==='paid-only'?{eligible:false,reason:'paid-required',tier:'free'}:{eligible:true,tier:'free',tags:['priority:free'],final:false};
}
// Expired legacy daily grants are reclaimed in bounded passes; messages and receipts stay.
export async function cleanupDailyDeveloperGrants(controller,owner,now=Date.now()){
 let cleaned=0;for(const [path,grant]of await controller.metadata.list({prefix:key('contact-grant'),limit:1001})){if(cleaned>=50)break;if(grant.owner!==owner||grant.internalKind!=='developer-contact/v1'||grant.claims.exp*1000>now)continue;await controller.metadata.transaction(async tx=>{const current=await tx.get(path);if(current?.internalKind!=='developer-contact/v1'||current.owner!==owner||current.id!==grant.id||current.claims.exp*1000>now)return;await tx.delete(path);await tx.delete(`contact-name/${grant.id}`);await tx.delete(`contact-url/${grant.id}`);if(typeof current.internalPointer==='string'&&current.internalPointer.startsWith('developer-contact/v1/')){const pointer=await tx.get(current.internalPointer);if(pointer?.version===1&&pointer.owner===owner&&pointer.grantId===current.id)await tx.delete(current.internalPointer);}});cleaned++;}
 return cleaned;
}
// Runs on the developer account outside its gate; creation and renewal take the gate.
// A revoked link stays revoked (no silent re-creation); a link near expiry is renewed.
export async function developerContactLink(controller,owner,handle,now=Date.now()){
 const pointer='developer-contact/v2',current=async()=>{const record=await controller.metadata.get(pointer);return record?.version===2&&UUID.test(record.grantId)?await controller.metadata.get(key('contact-grant',record.grantId)):null;};
 let grant=await current();
 if(grant&&!grant.active)return {available:false,reason:'contact-unavailable'};
 if(!grant||grant.claims.exp*1000<=now+7*86400000)grant=await controller.gated(async()=>{
  const latest=await current();if(latest&&(!latest.active||latest.claims.exp*1000>now+7*86400000))return latest;
  await cleanupDailyDeveloperGrants(controller,owner,now);const collection=(await controller.messages.collections(owner)).find(value=>value.active);if(!collection)return null;
  const issued=await controller.createSystemContactLink(owner,handle,{collections:[collection.id],mimeTypes:['text/plain','text/html'],expiresAt:now+365*86400000,maxMessages:5,maxBytes:65536,maxMessageBytes:16384,kinds:['one-off'],audience:{policy:developerPolicy(controller.config)},requiredTags:['contact:developer'],optionalTags:[...OPTIONAL],tagLabels:structuredClone(LABELS)},'Developer contact');
  // A renewed parent shares the per-author daily quota family of the link it replaces (no doubled allowance).
  if(latest){const path=key('contact-grant',issued.id),fresh=await controller.metadata.get(path);await controller.metadata.put(path,{...fresh,quotaFamily:latest.quotaFamily??latest.id});}
  await controller.metadata.put(pointer,{version:2,grantId:issued.id});return controller.metadata.get(key('contact-grant',issued.id));
 });
 if(!grant?.active)return {available:false,reason:'contact-unavailable'};
 return {available:true,grantId:grant.id,url:await controller.contactURL(owner,grant.id),expiresAt:grant.claims.exp*1000,policy:developerPolicy(controller.config)};
}

export async function developerContactRoutes({path,request,env,owner,accountHandle,json,limit,remoteIP}){
 if(path!=='/api/developer-contact')return null;
 if(request.method!=='GET')return json({error:'method_not_allowed'},405,{Allow:'GET'});
 if(limit&&!await limit(env,{operation:'developer-contact',remoteIP,handle:owner.account.id}))return json({error:'rate_limited',message:'Please wait before checking again.'},429,{'Retry-After':'60'});
 const recipientHandle=env.DEVELOPER_CONTACT_HANDLE??'ray',recipient=await env.IDENTITY_REPOSITORY.findByHandle(recipientHandle);
 const badge=systemBadge(recipient);
 if(recipient?.status!=='active'||!badge||badge.role!=='developer'||badge.handle!==recipientHandle)return json({available:false,reason:'developer-unavailable'});
 const receiver=accountHandle(env,recipient.id),link=await receiver.developerContactLink(recipient.id,recipient.handle);
 if(!link.available)return json({available:false,reason:link.reason??'contact-unavailable'});
 // Eligibility is the link's own host policy, reused within its bounded window.
 const decision=await receiver.linkAudienceDecide(recipient.id,link.grantId,{issuer:env.APP_ORIGIN,subject:owner.account.id});
 return json({available:true,url:link.url,expiresAt:link.expiresAt,policy:link.policy,recipientBadge:badge,eligibility:{state:decision.state,...decision.reason?{reason:decision.reason}:{},...decision.tier?{tier:decision.tier}:{}}});
}
