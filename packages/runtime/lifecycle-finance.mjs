import {rememberEverPaid} from '../identity/lifecycle-protection.mjs';

// Live ever-paid lookup for the account lifecycle. It asks Polar whether this
// external customer ever had any order (paid, refunded, partially refunded,
// disputed or pending) or any subscription (any status), for any product,
// including archived or deleted products: no product or status filter is sent.
// A positive answer persists the monotonic ever-paid marker. Only an exact,
// consistent zero from both lists counts as never-paid; any provider failure,
// malformed page or customer mismatch throws so the caller holds.
const bounded=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const unavailable=()=>Object.assign(new Error('Payment history could not be verified.'),{code:'financial_review_unavailable'});
export async function everPaidReview({billing,config,owner,metadata,now=Date.now()}){
 if(config.BILLING_ENABLED!=='true')throw unavailable();
 let client,organizationId=config.POLAR_ORGANIZATION_ID;
 try{client=await billing.client();if(!bounded(organizationId))organizationId=(await billing.catalog()).organizationId;}catch{throw unavailable();}
 if(!bounded(organizationId))throw unavailable();
 for(const kind of ['orders','subscriptions']){
  let page;try{page=await client[kind].list({external_customer_id:owner,organization_id:organizationId,limit:1,page:1});}catch{throw unavailable();}
  const items=page?.items,total=page?.pagination?.total_count;
  if(!Array.isArray(items)||items.length>1||!Number.isSafeInteger(total)||total<0)throw unavailable();
  const item=items[0],external=item?.customer?.external_id;
  if(item&&external!==undefined&&external!==owner)throw unavailable();
  if(item&&item.organization_id!==undefined&&item.organization_id!==organizationId&&item.customer?.organization_id!==organizationId)throw unavailable();
  if(items.length||total>0){await rememberEverPaid(metadata,owner,{source:'api',evidence:kind==='orders'?'order':'subscription',now});return {everPaid:true,evidence:kind};}
 }
 return {everPaid:false};
}
