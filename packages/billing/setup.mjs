import {signupPriceDigest} from './signup.mjs';
import {BillingError,BILLING_STATE_KEY} from './catalog.mjs';
import {isUUID as uuid} from '../core/primitives.mjs';
const key='billing/signup-checkout/v1';
const fail=(code,message,status=409)=>{throw new BillingError(code,message,status);};
export class PaidSignupBilling {
 constructor(billing){this.billing=billing;this.metadata=billing.metadata;}
 validate(owner,admission){if(!uuid(owner)||admission?.version!==1||admission.kind!=='paid'||!['paid','plus','ultra'].includes(admission.plan)||!uuid(admission.incarnation)||!Number.isSafeInteger(admission.checkoutStartUntil))fail('invalid_paid_setup','Paid account setup is invalid.');}
 async checkout(owner,admission,input){
  this.validate(owner,admission);if(!uuid(input?.requestId))fail('invalid_request','A checkout request identifier is required.');
  const catalog=await this.billing.catalog(),selection=this.billing.selection(catalog,{currency:input.currency});
  const digest=await signupPriceDigest(this.billing.config,catalog,admission.plan,selection.currency);
  const attempt=await this.metadata.transaction(async tx=>{const previous=await tx.get(key);if(previous){this.attempt(previous,owner,admission);if(previous.owner!==owner||previous.incarnation!==admission.incarnation||previous.plan!==admission.plan)fail('billing_setup_conflict','This account already has a different checkout setup.');if(previous.currency!==selection.currency)fail('billing_setup_conflict','Continue the existing checkout currency.');return {existing:true,record:previous};}if(input.priceDigest!==digest)fail('billing_price_changed','Refresh and review the current signup price.');if(admission.checkoutStartUntil<=this.billing.now())fail('billing_setup_expired','This unpaid checkout setup has expired.');const record={version:1,owner,incarnation:admission.incarnation,plan:admission.plan,currency:selection.currency,requestId:input.requestId,status:'creating',createdAt:this.billing.now()};await tx.put(key,record);return {existing:false,record};});
  if(attempt.existing){if(attempt.record.status==='ready')return {server:this.billing.config.POLAR_SERVER,status:'checkout_ready',url:attempt.record.url};return {server:this.billing.config.POLAR_SERVER,status:'outcome_unknown',message:'The existing checkout request must be checked before another can be created.'};}
  try{const result=await this.billing.checkout(owner,admission.plan,{currency:selection.currency},{incarnation:admission.incarnation,requestId:attempt.record.requestId});await this.metadata.put(key,{...attempt.record,status:'ready',url:result.url});return {server:this.billing.config.POLAR_SERVER,status:'checkout_ready',url:result.url};}
  catch(error){await this.metadata.put(key,{...attempt.record,status:'unknown'});throw error;}
 }
 attempt(value,owner,admission){if(!value||value.version!==1||value.owner!==owner||value.incarnation!==admission.incarnation||value.plan!==admission.plan||!['creating','ready','unknown'].includes(value.status)||!uuid(value.requestId)||!Number.isSafeInteger(value.createdAt))fail('billing_setup_conflict','Checkout state needs reconciliation.');if(value.status==='ready'){let url;try{url=new URL(value.url);}catch{}const hosts=this.billing.config.POLAR_SERVER==='sandbox'?['sandbox.polar.sh','sandbox-api.polar.sh']:['polar.sh','api.polar.sh'];if(!url||url.protocol!=='https:'||url.username||url.password||url.port||!hosts.includes(url.hostname))fail('billing_setup_conflict','Checkout state needs reconciliation.');}}
 async status(owner,admission){
  this.validate(owner,admission);const checkedAt=this.billing.now(),entitlement=await this.billing.reconcile(owner),state=await this.metadata.get(BILLING_STATE_KEY),attempt=await this.metadata.get(key);if(attempt)this.attempt(attempt,owner,admission);
  const verified=entitlement.plan===admission.plan&&entitlement.provisional!==true&&state?.owner===owner&&state.source==='polar'&&state.catalogVersion===3&&state.plan===admission.plan&&['active','canceled'].includes(state.status)&&state.validUntil>checkedAt&&state.reconciledAt>=checkedAt;
  return {server:this.billing.config.POLAR_SERVER,signupPlan:admission.plan,paymentRequired:true,paymentVerified:verified,checkedAt,validUntil:verified?state.validUntil:null,status:verified?'paid':attempt?.status==='ready'?'checkout_ready':attempt?'outcome_unknown':'payment_required',...(attempt?.owner===owner&&attempt.incarnation===admission.incarnation&&attempt.status==='ready'?{url:attempt.url}:{})};
 }
}
