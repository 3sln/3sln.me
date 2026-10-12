// Decimal GB. Economics and production launch remain provisional in DEVLOG.md.
export const BILLING_PLANS = Object.freeze({
  free: Object.freeze({id:'free',name:'Free',storageBytes:500_000_000,annualAmount:0,currency:'usd'}),
  plus: Object.freeze({id:'plus',name:'Plus',storageBytes:5_000_000_000,annualAmount:500,currency:'usd'}),
  pro: Object.freeze({id:'pro',name:'Pro',storageBytes:100_000_000_000,annualAmount:3000,currency:'usd'})
});
export const BILLING_STATE_KEY = 'billing/state';
export class BillingError extends Error {
  constructor(code,message,status=400){super(message);this.name='BillingError';this.code=code;this.status=status;}
}
export function assertOwner(owner){if(typeof owner!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner))throw new BillingError('invalid_owner','An account UUID is required.');return owner;}
export function billingEnabled(config){return config.BILLING_ENABLED==='true';}
export function productIds(config){return {plus:config.POLAR_PRODUCT_ID_PLUS,pro:config.POLAR_PRODUCT_ID_PRO};}
export function assertBillingConfiguration(config){
  if(!billingEnabled(config))throw new BillingError('billing_disabled','Billing is not enabled.',503);
  const ids=productIds(config);
  if(!config.POLAR_ACCESS_TOKEN||!config.POLAR_WEBHOOK_SECRET||!['sandbox','production'].includes(config.POLAR_SERVER)||!ids.plus||!ids.pro||ids.plus===ids.pro)throw new BillingError('billing_unconfigured','Billing configuration is incomplete.',503);
  return ids;
}
export function entitlementFromState(state,now=Date.now()){
  const valid=state?.source==='polar'&&Object.hasOwn(BILLING_PLANS,state.plan)&&state.plan!=='free'&&Number.isFinite(state.validUntil)&&state.validUntil>now;
  const plan=BILLING_PLANS[valid?state.plan:'free'];
  return {plan:plan.id,storageBytes:plan.storageBytes,validUntil:valid?state.validUntil:null};
}
