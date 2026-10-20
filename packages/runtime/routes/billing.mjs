// HTTP routes of slice 7, Billing (docs/architecture/app-engine.md §12): the verified Polar webhook, billing status, checkout, plan changes and the portal.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {everPaidEvent} from '../../identity/lifecycle-protection.mjs';
import {verifyPolarWebhook} from '../../billing/index.mjs';
import {UUID as uuidPattern} from '../../core/primitives.mjs';
import {json,body,limit,accountHandle} from './shared.mjs';

export function allowedMethods(path){
 if(['/api/billing/checkout','/api/billing/change-plan','/api/billing/cancel-change','/api/billing/portal'].includes(path))return ['POST'];
 if(path==='/api/billing')return ['GET'];
 return null;
}
// Paying and changing plans are never refused for capacity.
export const admission={exempt:path=>['/api/billing/checkout','/api/billing/change-plan','/api/billing/cancel-change','/api/billing/portal'].includes(path)};
export const stages={
 async public({request,env,path}){
   if(path==='/api/billing/webhook'){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    const verified=await verifyPolarWebhook(request,env);if(verified.ignored)return json({accepted:true,ignored:true});if(verified.catalog){if(!env.BILLING_CATALOG)throw Object.assign(new Error('Catalog registry is unavailable.'),{code:'billing_unconfigured',status:503});if(!await env.BILLING_CATALOG.relevant(verified))return json({accepted:true,ignored:true});return json(await env.BILLING_CATALOG.applyWebhook(verified));}if(verified.refund){if(!env.BILLING_CATALOG)throw Object.assign(new Error('Catalog registry is unavailable.'),{code:'billing_unconfigured',status:503});Object.assign(verified,await env.BILLING_CATALOG.resolveRefund(verified));}
    if(!verified.owner||!uuidPattern.test(verified.owner))return json({accepted:true,ignored:true});
    verified.relevant=env.BILLING_CATALOG?await env.BILLING_CATALOG.relevant(verified):Object.values({paid:env.POLAR_PRODUCT_ID_PAID,plus:env.POLAR_PRODUCT_ID_PLUS,ultra:env.POLAR_PRODUCT_ID_ULTRA}).some(id=>id&&(id===verified.productId||verified.productIds?.includes(id)));
    const account=await env.IDENTITY_REPOSITORY.get(verified.owner);
    // Lifecycle ever-paid evidence is kept for every non-deleted identity, before the billing status filter.
    if(account&&account.status!=='deleted'&&everPaidEvent(verified))await accountHandle(env,verified.owner).lifecycleEverPaid(verified.owner,{type:verified.type,productIds:verified.productIds});
    if(!account||(account.status!=='active'&&!(['pending','recovering'].includes(account.status)&&account.admission?.version===1&&account.admission.kind==='paid'&&account.admission.initialPaymentRequired!==false)))return json({accepted:true,ignored:true});
    return json(await accountHandle(env,verified.owner).billingWebhookVerified(verified.owner,verified));
   }
 },
 async owner({request,env,url,path,id,object,context}){
    if(path==='/api/billing'&&request.method==='GET'){if([...url.searchParams.keys()].some(key=>!['currency','txId'].includes(key))||url.searchParams.getAll('currency').length>1||url.searchParams.getAll('txId').length>1)throw Object.assign(new Error('Choose a supported payment currency.'),{code:'invalid_currency',status:400});return json(await object.billingStatus(id,{country:context.region,...url.searchParams.has('currency')?{currency:url.searchParams.get('currency')}:{},...url.searchParams.has('txId')?{txId:url.searchParams.get('txId')}:{}}));}
    if(path==='/api/billing/cancel-change'&&request.method==='POST'){if(!await limit(env,{operation:'billing',remoteIP:context.remoteIP}))return json({error:'rate_limited'},429,{'Retry-After':'3600'});const input=await body(request);if(Object.keys(input).some(key=>!['txId','scheduledTxId'].includes(key)))throw Object.assign(new Error('Confirm the scheduled change to cancel.'),{code:'invalid_args',status:400});return json(await object.billingCancelChange(id,input));}
    if(path==='/api/billing/change-plan'&&request.method==='POST'){if(!await limit(env,{operation:'billing',remoteIP:context.remoteIP}))return json({error:'rate_limited'},429,{'Retry-After':'3600'});const input=await body(request);if(Object.keys(input).some(key=>!['plan','txId','priceDigest'].includes(key)))throw Object.assign(new Error('Review the target plan before confirming.'),{code:'invalid_args',status:400});return json(await object.billingChangePlan(id,input));}
    if(path==='/api/billing/checkout'&&request.method==='POST'){const input=await body(request);if(Object.keys(input).some(key=>!['plan','currency','locale'].includes(key)))throw Object.assign(new Error('Choose a plan and payment currency.'),{code:'invalid_args',status:400});return json(await object.billingCheckout(id,input.plan,{country:context.region,customerIpAddress:context.remoteIP,...Object.hasOwn(input,'currency')?{currency:input.currency}:{},...Object.hasOwn(input,'locale')?{locale:input.locale}:{}}));}
    if(path==='/api/billing/portal'&&request.method==='POST')return json(await object.billingPortal(id));
 },
};
