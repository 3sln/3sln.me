// Decimal GB. Economics and production launch remain provisional in DEVLOG.md.
import {UUID} from '../core/primitives.mjs';
export const BILLING_PLANS = Object.freeze({
  free: Object.freeze({id:'free',name:'Free',storageBytes:500_000_000,annualAmount:0,currency:'usd'}),
  paid: Object.freeze({id:'paid',name:'Paid',storageBytes:5_000_000_000,annualAmount:500,currency:'usd'}),
  plus: Object.freeze({id:'plus',name:'Plus',storageBytes:100_000_000_000,annualAmount:3500,currency:'usd'}),
  ultra: Object.freeze({id:'ultra',name:'Ultra',storageBytes:1_000_000_000_000,annualAmount:25000,currency:'usd'})
});
export const BILLING_STATE_KEY = 'billing/state';
export class BillingError extends Error {
  constructor(code,message,status=400){super(message);this.name='BillingError';this.code=code;this.status=status;}
}
export function assertOwner(owner){if(typeof owner!=='string'||!UUID.test(owner))throw new BillingError('invalid_owner','An account UUID is required.');return owner;}
export function billingEnabled(config){return config.BILLING_ENABLED==='true';}
export function productIds(config){return {paid:config.POLAR_PRODUCT_ID_PAID,plus:config.POLAR_PRODUCT_ID_PLUS,ultra:config.POLAR_PRODUCT_ID_ULTRA};}
export function metadataPrefix(config){const prefix=config.POLAR_METADATA_PREFIX??'3sln_me_';if(typeof prefix!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_]{0,25}_$/.test(prefix))throw new BillingError('billing_unconfigured','Billing metadata prefix is invalid.',503);return prefix;}
export function assertBillingConfiguration(config){
  metadataPrefix(config);
  if(!billingEnabled(config))throw new BillingError('billing_disabled','Billing is not enabled.',503);
  if(config.POLAR_CATALOG_MODE!==undefined&&!['static','metadata'].includes(config.POLAR_CATALOG_MODE))throw new BillingError('billing_unconfigured','Choose an explicit billing catalog mode.',503);
  const ids=productIds(config);if(config.POLAR_CATALOG_MODE==='metadata'){if(!config.POLAR_ACCESS_TOKEN||!config.POLAR_WEBHOOK_SECRET||!['sandbox','production'].includes(config.POLAR_SERVER)||typeof config.POLAR_ORGANIZATION_ID!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(config.POLAR_ORGANIZATION_ID))throw new BillingError('billing_unconfigured','Billing configuration is incomplete.',503);return ids;}
  if(!config.POLAR_ACCESS_TOKEN||!config.POLAR_WEBHOOK_SECRET||!['sandbox','production'].includes(config.POLAR_SERVER)||Object.values(ids).some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id))||new Set(Object.values(ids)).size!==3)throw new BillingError('billing_unconfigured','Billing configuration is incomplete.',503);
  return ids;
}
export function entitlementFromState(state,now=Date.now(),config){
  const mapped=[2,3].includes(state?.catalogVersion)?state.plan:state?.catalogVersion===undefined?({plus:'paid',pro:'plus'})[state?.plan]:undefined;
  const valid=state?.source==='polar'&&Object.hasOwn(BILLING_PLANS,mapped)&&mapped!=='free'&&Number.isFinite(state.validUntil)&&state.validUntil>now;
  const plan=BILLING_PLANS[valid?mapped:'free'];if(valid&&state.catalogVersion===3){const params=state.verifiedPlan;if(config&&(state.origin!==config.APP_ORIGIN||state.server!==config.POLAR_SERVER||state.metadataPrefix!==metadataPrefix(config)||state.catalogMode!==(config.POLAR_CATALOG_MODE??'static')||config.POLAR_CATALOG_MODE==='metadata'&&(state.organizationId!==config.POLAR_ORGANIZATION_ID||state.metadataPrefix!==metadataPrefix(config))))return {plan:'free',storageBytes:BILLING_PLANS.free.storageBytes,validUntil:null};if(!validPlanParameters(params)||params.id!==mapped||![state.organizationId,state.productId,state.subscriptionId].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value)))return {plan:'free',storageBytes:BILLING_PLANS.free.storageBytes,validUntil:null};const upgrade=state.upgrade;if(upgrade?.version===1&&validPlanParameters(upgrade.parameters)&&upgrade.parameters.id===upgrade.plan&&upgrade.owner===state.owner&&upgrade.origin===state.origin&&upgrade.server===state.server&&upgrade.organizationId===state.organizationId&&upgrade.subscriptionId===state.subscriptionId&&typeof upgrade.targetProductId==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(upgrade.targetProductId)&&upgrade.currency===state.currency&&Number.isSafeInteger(upgrade.startedAt)&&Number.isSafeInteger(upgrade.expiresAt)&&upgrade.startedAt<=now&&upgrade.expiresAt>now&&upgrade.expiresAt<=upgrade.startedAt+900000&&upgrade.expiresAt<=state.validUntil&&({paid:1,plus:2,ultra:3})[upgrade.plan]>({paid:1,plus:2,ultra:3})[mapped])return {plan:upgrade.plan,storageBytes:upgrade.parameters.storageBytes,activityHour:upgrade.parameters.activityHour,activityDay:upgrade.parameters.activityDay,validUntil:state.validUntil,provisional:true,activationUntil:upgrade.expiresAt};return {plan:mapped,storageBytes:params.storageBytes,activityHour:params.activityHour,activityDay:params.activityDay,validUntil:state.validUntil};}
  return {plan:plan.id,storageBytes:plan.storageBytes,validUntil:valid?state.validUntil:null};
}

export function validPlanParameters(plan){return plan&&['paid','plus','ultra'].includes(plan.id)&&typeof plan.name==='string'&&plan.name.length>0&&plan.name.length<=100&&!/[\u0000-\u001f\u007f]/.test(plan.name)&&Number.isSafeInteger(plan.storageBytes)&&plan.storageBytes>0&&plan.storageBytes<=1000000000000&&Number.isSafeInteger(plan.activityHour)&&plan.activityHour>0&&Number.isSafeInteger(plan.activityDay)&&plan.activityDay>=plan.activityHour&&plan.activityDay<=100000;}
