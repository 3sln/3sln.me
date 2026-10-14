import {systemBadge} from '../identity/system-bootstrap.mjs';
import {StorageError} from '../storage/policy.mjs';
import {key,canonical} from '../messaging/store.mjs';
import {BILLING_STATE_KEY,entitlementFromState} from '../billing/catalog.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const DEVELOPER_CONTACT_TAGS=Object.freeze({free:['contact:developer','priority:free'],paid:['contact:developer','priority:paid'],plus:['contact:developer','priority:plus'],ultra:['contact:developer','priority:ultra']});
const OPTIONAL=Object.freeze(['topic:bug','topic:feature','topic:general']);
export async function developerContactTier(controller,owner){
 await controller.warm(owner);await controller.billingRefresh(owner,{force:true});
 const state=await controller.metadata.get(BILLING_STATE_KEY);
 if(state?.owner!==owner||!['active','canceled'].includes(state.status))return 'free';
 const now=Date.now(),tier=entitlementFromState({...state,upgrade:undefined},now,controller.config).plan;
 if(tier!=='free'&&(!Number.isSafeInteger(state.reconciledAt)||state.reconciledAt>now||state.reconciledAt<now-300000))throw new StorageError('developer_contact_eligibility_unavailable','Your subscription could not be verified. Please try again shortly.',503);
 return tier;
}
export async function issueDailyDeveloperContact(controller,owner,{beneficiary,tier,requestId},now=Date.now()){
 if(!UUID.test(beneficiary)||!UUID.test(requestId)||!Object.hasOwn(DEVELOPER_CONTACT_TAGS,tier))throw new StorageError('invalid_request','Request a developer contact from your own account.');
 await controller.warm(owner);const day=new Date(now).toISOString().slice(0,10),expiresAt=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),new Date(now).getUTCDate()+1),pointer=`developer-contact/v1/${day}/${beneficiary}/${tier}`;
 const existing=await controller.metadata.get(pointer);
 if(existing){
  if(existing.version!==1||existing.owner!==owner||existing.beneficiary!==beneficiary||existing.tier!==tier||existing.expiresAt!==expiresAt||!UUID.test(existing.grantId))throw new StorageError('developer_contact_unavailable','Developer contact is temporarily unavailable.',503);
  const grant=await controller.metadata.get(key('contact-grant',existing.grantId));
  if(!grant?.active||grant.claims.exp*1000<=now)return {granted:false,reason:'contact-unavailable'};
  if(grant.owner!==owner||grant.internalKind!=='developer-contact/v1'||grant.internalPointer!==pointer||grant.claims.exp*1000!==expiresAt||grant.claims.maxMessages!==5||grant.claims.maxBytes!==65536||grant.claims.maxMessageBytes!==16384||canonical(grant.claims.requiredTags)!==canonical(DEVELOPER_CONTACT_TAGS[tier])||canonical(grant.claims.optionalTags)!==canonical(OPTIONAL)||canonical(grant.claims.mimeTypes)!==canonical(['text/plain','text/html']))throw new StorageError('developer_contact_unavailable','Developer contact needs reconciliation.',503);
  if(await controller.metadata.get(`contact-url/${grant.id}`)!==undefined)return {granted:true,url:await controller.contactURL(owner,grant.id),expiresAt,tier,requiredTags:DEVELOPER_CONTACT_TAGS[tier],optionalTags:OPTIONAL};
  // Resume the exact committed parent after interrupted endpoint/URL finalization.
 }
 // A finite cleanup pass reclaims only expired internal grants. It preserves
 // normal contact grants and all messages/receipts already received from them.
 const grants=await controller.metadata.list({prefix:key('contact-grant')});let cleaned=0;
 for(const [path,grant]of grants){if(cleaned>=50)break;if(grant.owner===owner&&grant.internalKind==='developer-contact/v1'&&grant.claims.exp*1000<=now){await controller.metadata.transaction(async tx=>{const current=await tx.get(path);if(current?.internalKind!=='developer-contact/v1'||current.owner!==owner||current.id!==grant.id||current.claims.exp*1000>now)return;await tx.delete(path);await tx.delete(`contact-name/${grant.id}`);await tx.delete(`contact-url/${grant.id}`);if(typeof current.internalPointer==='string'&&current.internalPointer.startsWith('developer-contact/v1/')){const pointer=await tx.get(current.internalPointer);if(pointer?.version===1&&pointer.owner===owner&&pointer.grantId===current.id)await tx.delete(current.internalPointer);}});cleaned++;}}
 const collection=(await controller.messages.collections(owner)).find(value=>value.active);
 if(!collection)return {granted:false,reason:'contact-unavailable'};
 const result=await controller.createContact(owner,controller.config.DEVELOPER_CONTACT_HANDLE??'ray',{name:'Developer contact',collections:[collection.id],mimeTypes:['text/plain','text/html'],expiresAt,maxMessages:5,maxMessageBytes:16384,maxBytes:65536,requiredTags:DEVELOPER_CONTACT_TAGS[tier],optionalTags:OPTIONAL},{kind:'developer-contact/v1',pointer,binding:{owner,beneficiary,tier,expiresAt}});
 return {granted:true,url:result.url,expiresAt,tier,requiredTags:DEVELOPER_CONTACT_TAGS[tier],optionalTags:OPTIONAL};
}

export async function developerContactRoutes({path,request,env,owner,object,accountHandle,body,json}){
 if(path!=='/api/developer-contact')return null;
 const input=await body(request,1024);
 if(!input||Object.keys(input).some(key=>key!=='requestId')||!UUID.test(input.requestId))throw new StorageError('invalid_request','Request a developer contact from your own account.');
 const recipientHandle=env.DEVELOPER_CONTACT_HANDLE??'ray',recipient=await env.IDENTITY_REPOSITORY.findByHandle(recipientHandle);
 const marker=recipient?.systemIdentity,badge=systemBadge(recipient);
 if(recipient?.status!=='active'||!badge||badge.role!=='developer'||badge.handle!==recipientHandle)return json({granted:false,reason:'developer-unavailable'});
 let tier;try{tier=await object.developerContactTier(owner.account.id);}catch(error){if(error.code==='developer_contact_eligibility_unavailable')return json({granted:false,reason:'eligibility-unavailable'});throw error;}
 if(tier==='free'){
  let policy;try{policy=await env.DEVELOPER_CONTACT_POPULATION?.policy?.();}catch{}
  const now=Date.now();
  if(!policy||!Number.isSafeInteger(policy.observedAt)||!Number.isSafeInteger(policy.validUntil)||policy.observedAt>now||policy.validUntil<=now||policy.validUntil>policy.observedAt+60000||!['all-active','paid-only','unavailable'].includes(policy.mode)||policy.mode==='unavailable')return json({granted:false,reason:'eligibility-unavailable'});
  if(policy.mode==='paid-only')return json({granted:false,reason:'paid-required'});
 }
 const receiver=accountHandle(env,recipient.id);
 await receiver.admitWork(recipient.id,{clientId:'developer-contact:'+owner.account.id,initialize:true});
 try{
  const result=await receiver.issueDailyDeveloperContact(recipient.id,{beneficiary:owner.account.id,tier,requestId:input.requestId});
  return json({...result,...result.granted?{recipientBadge:badge}:{}});
 }catch(error){if(error.code==='grant_limit')return json({granted:false,reason:'contact-capacity'});throw error;}
}
