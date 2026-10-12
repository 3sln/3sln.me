import {BILLING_PLANS,BILLING_STATE_KEY,BillingError,assertOwner,assertBillingConfiguration,billingEnabled,entitlementFromState} from './catalog.mjs';

const EVENT_PREFIX='billing/event/';
const EVENT_RETENTION_MS=35*86400000;
const MAX_EVENTS=4096;
export const PAID_HANDLE_MARKER_PREFIX='billing/ever-paid/';
const paidMarkerKey=(server,owner)=>`${PAID_HANDLE_MARKER_PREFIX}${server}/${owner}`;
const boundedId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const orderStatuses=new Set(['draft','pending','paid','refunded','partially_refunded','void']);
function validPaidMarker(marker,owner,config){
  return marker?.version===1&&marker.source==='polar'&&marker.owner===owner&&marker.server===config.POLAR_SERVER&&['sandbox','production'].includes(marker.server)&&['plus','pro'].includes(marker.plan)&&boundedId(marker.productId)&&boundedId(marker.organizationId)&&boundedId(marker.orderId)&&boundedId(marker.subscriptionId)&&Number.isSafeInteger(marker.verifiedAt)&&marker.verifiedAt>=0;
}
const fail=()=>new BillingError('billing_provider_unavailable','Billing could not be verified. Please retry later.',503);
const timestamp=value=>typeof value==='string'?Date.parse(value):NaN;
function portalURL(value,server){
  let url;try{url=new URL(value);}catch{throw fail();}
  const permitted=server==='sandbox'?['sandbox.polar.sh','sandbox-api.polar.sh']:['polar.sh','api.polar.sh'];
  if(url.protocol!=='https:'||url.username||url.password||url.port||!permitted.includes(url.hostname))throw fail();
  return url.href;
}
function returnURL(config){
  let url;try{url=new URL(config.APP_ORIGIN);}catch{throw new BillingError('billing_unconfigured','The app origin is unavailable.',503);}
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||(url.protocol!=='https:'&&!(config.LOCAL_DEVELOPMENT==='true'&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new BillingError('billing_unconfigured','The app origin is invalid.',503);
  return `${url.origin}/`;
}
// The enclosing account controller serializes these methods with its account
// gate. Do not acquire that gate a second time. Transactions remain short and
// provider requests never run inside a metadata transaction.
export class BillingService {
  constructor({config,metadata,client,now=Date.now}){this.config=config;this.metadata=metadata;this.clientOverride=client;this.now=now;this.catalogCache=null;}
  async client(){
    assertBillingConfiguration(this.config);
    if(this.clientOverride)return this.clientOverride;
    if(!this.sdk){const {createPolar}=await import('@polar-sh/sdk/2026-10');this.sdk=createPolar({accessToken:this.config.POLAR_ACCESS_TOKEN,environment:this.config.POLAR_SERVER,timeout:5});}
    return this.sdk;
  }
  async catalog(){
    const ids=assertBillingConfiguration(this.config),fingerprint=JSON.stringify([ids,this.config.POLAR_SERVER]);
    if(this.catalogCache?.fingerprint===fingerprint&&this.catalogCache.expiresAt>this.now())return this.catalogCache;
    const client=await this.client();let products;
    try{products=await Promise.all(['plus','pro'].map(plan=>client.products.get(ids[plan])));}catch{throw fail();}
    const entries={};let organizationId;
    for(const [i,plan]of ['plus','pro'].entries()){
      const product=products[i],expected=BILLING_PLANS[plan],prices=product?.prices?.filter(price=>price.is_archived===false);
      if(product?.id!==ids[plan]||product.is_archived!==false||product.is_recurring!==true||product.recurring_interval!=='year'||product.recurring_interval_count!==1||!product.organization_id||prices?.length!==1||prices[0].source!=='catalog'||prices[0].amount_type!=='fixed'||prices[0].product_id!==product.id||prices[0].price_currency!==expected.currency||prices[0].price_amount!==expected.annualAmount||(organizationId&&organizationId!==product.organization_id))throw new BillingError('billing_catalog_mismatch','Configured billing products do not match the annual plan catalog.',503);
      organizationId=product.organization_id;entries[plan]={id:product.id,priceId:prices[0].id};
    }
    this.catalogCache={fingerprint,organizationId,entries,expiresAt:this.now()+300000};return this.catalogCache;
  }
  async entitlement(owner){assertOwner(owner);const state=await this.metadata.get(BILLING_STATE_KEY);return entitlementFromState(state?.owner===owner?state:null,this.now());}
  async paidHandleEligibility(owner){
    assertOwner(owner);
    const markerKey=paidMarkerKey(this.config.POLAR_SERVER,owner),existing=await this.metadata.get(markerKey);
    if(existing!==undefined){if(!validPaidMarker(existing,owner,this.config))throw fail();return true;}
    assertBillingConfiguration(this.config);
    const catalog=await this.catalog(),client=await this.client();
    let pagination,examined=0;const seen=new Set();
    for(let page=1;page<=2;page++){
      let result;
      try{result=await client.orders.list({external_customer_id:owner,organization_id:catalog.organizationId,product_id:['plus','pro'].map(plan=>catalog.entries[plan].id),status:'paid',limit:100,page});}catch{throw fail();}
      const current=result?.pagination;
      if(!Array.isArray(result?.items)||result.items.length>100||!Number.isSafeInteger(current?.total_count)||current.total_count<0||!Number.isSafeInteger(current?.max_page)||current.max_page<0||current.max_page!==Math.ceil(current.total_count/100)&&!(current.total_count===0&&current.max_page===1))throw fail();
      if(pagination&&(current.total_count!==pagination.total_count||current.max_page!==pagination.max_page))throw fail();
      pagination=current;
      if(result.items.length!==Math.min(100,Math.max(0,current.total_count-(page-1)*100)))throw fail();
      let candidate;
      for(const order of result.items){
        const plan=Object.keys(catalog.entries).find(name=>catalog.entries[name].id===order?.product_id),expected=BILLING_PLANS[plan],subscription=order?.subscription;
        if(!boundedId(order?.id)||seen.has(order.id)||!plan||typeof order.paid!=='boolean'||!orderStatuses.has(order.status)||!Number.isFinite(timestamp(order.created_at))||typeof order.currency!=='string'||!['net_amount','total_amount','refunded_amount'].every(name=>Number.isSafeInteger(order[name])&&order[name]>=0))throw fail();
        seen.add(order.id);examined++;
        if(!boundedId(order.customer_id)||order.customer?.id!==order.customer_id||order.customer.external_id!==owner||order.customer.organization_id!==catalog.organizationId||order.product?.id!==order.product_id||order.product.organization_id!==catalog.organizationId||order.product.is_recurring!==true||order.product.recurring_interval!=='year'||order.product.recurring_interval_count!==1)throw fail();
        if(!boundedId(order.subscription_id)||subscription?.id!==order.subscription_id||subscription.customer_id!==order.customer_id||subscription.product_id!==order.product_id||subscription.currency!==expected.currency||subscription.recurring_interval!=='year'||subscription.recurring_interval_count!==1||!Number.isSafeInteger(subscription.amount)||subscription.amount!==expected.annualAmount)throw fail();
        if(order.paid===true&&order.status==='paid'&&order.currency==='usd'&&order.net_amount>0&&order.net_amount>=expected.annualAmount&&order.total_amount>=order.net_amount&&order.refunded_amount===0)candidate??={version:1,source:'polar',owner,server:this.config.POLAR_SERVER,organizationId:catalog.organizationId,plan,productId:order.product_id,orderId:order.id,subscriptionId:order.subscription_id,verifiedAt:this.now()};
      }
      // An authenticated qualifying order is sufficient even when older
      // history is longer than the scan budget. No negative cache is stored.
      if(candidate){
        if(!validPaidMarker(candidate,owner,this.config))throw fail();
        await this.metadata.transaction(async tx=>{const prior=await tx.get(markerKey);if(prior!==undefined){if(!validPaidMarker(prior,owner,this.config))throw fail();return;}await tx.put(markerKey,candidate);});
        return true;
      }
      if(examined===pagination.total_count)return false;
    }
    throw new BillingError('billing_order_capacity','Payment history needs operator reconciliation. Please retry later.',503);
  }
  async status(owner){
    const entitlement=await this.entitlement(owner),state=await this.metadata.get(BILLING_STATE_KEY);
    let configured=false;try{assertBillingConfiguration(this.config);configured=true;}catch{}
    const paidMarker=await this.metadata.get(paidMarkerKey(this.config.POLAR_SERVER,owner));
    return {...entitlement,paidHandleEligible:validPaidMarker(paidMarker,owner,this.config),enabled:billingEnabled(this.config),configured,server:['sandbox','production'].includes(this.config.POLAR_SERVER)?this.config.POLAR_SERVER:null,plans:Object.values(BILLING_PLANS),subscription:state?.owner===owner?{status:state.status,cancelAtPeriodEnd:state.cancelAtPeriodEnd||false,validUntil:state.validUntil,reconciledAt:state.reconciledAt}:null};
  }
  async checkout(owner,plan){
    assertOwner(owner);if(!['plus','pro'].includes(plan))throw new BillingError('invalid_plan','Choose Plus or Pro.');
    const catalog=await this.catalog(),client=await this.client(),url=returnURL(this.config);
    // Reject duplicate purchases; upgrades and cancellation use the portal.
    const current=await this.reconcile(owner);
    if(current.plan!=='free')throw new BillingError('subscription_exists','Manage your current subscription in the billing portal.',409);
    let session;try{session=await client.checkouts.create({products:[catalog.entries[plan].id],external_customer_id:owner,success_url:url,return_url:url,currency:'usd',allow_trial:false,allow_discount_codes:false});}catch{throw fail();}
    return {url:portalURL(session.url,this.config.POLAR_SERVER)};
  }
  async portal(owner){
    assertOwner(owner);const catalog=await this.catalog(),client=await this.client();
    let state;try{state=await client.customers.getStateExternal(owner);}catch{throw fail();}
    if(state?.external_id!==owner||state.organization_id!==catalog.organizationId||state.deleted_at)throw new BillingError('billing_customer_unavailable','Billing customer is unavailable.',404);
    let session;try{session=await client.customerSessions.create({customer_id:state.id,return_url:returnURL(this.config)});}catch{throw fail();}
    if(session.customer_id!==state.id||session.customer?.external_id!==owner)throw fail();
    return {url:portalURL(session.customer_portal_url,this.config.POLAR_SERVER)};
  }
  async fetchState(owner,previous){
    const catalog=await this.catalog(),client=await this.client();let customer;
    try{customer=await client.customers.getStateExternal(owner);}catch(error){if(error.statusCode===404)return {owner,source:'polar',plan:'free',validUntil:null,status:'none',reconciledAt:this.now()};throw fail();}
    if(customer?.external_id!==owner||customer.organization_id!==catalog.organizationId||!customer.id||!Array.isArray(customer.active_subscriptions)||customer.active_subscriptions.length>100)throw fail();
    const base={owner,source:'polar',plan:'free',validUntil:null,status:customer.deleted_at?'deleted':'none',customerId:customer.id,reconciledAt:this.now()};
    if(customer.deleted_at)return base;
    const ids=new Set(customer.active_subscriptions.map(s=>s.id));
    if(previous?.owner===owner&&previous.subscriptionId)ids.add(previous.subscriptionId);
    if(ids.size>8)throw new BillingError('billing_subscription_capacity','Billing subscriptions need operator reconciliation.',503);
    const subscriptions=await Promise.all([...ids].map(async id=>{
      if(typeof id!=='string'||!id||id.length>200)throw fail();
      try{return await client.subscriptions.get(id);}catch(error){if(error.statusCode===404)return null;throw fail();}
    }));
    let best=base;
    for(const subscription of subscriptions){
      if(!subscription)continue;
      const id=subscription.id;if(!ids.has(id))throw fail();
      if(subscription.customer_id!==customer.id||subscription.customer?.external_id!==owner||subscription.customer?.organization_id!==catalog.organizationId)throw fail();
      const plan=Object.keys(catalog.entries).find(name=>catalog.entries[name].id===subscription.product_id);if(!plan)continue;
      const expected=BILLING_PLANS[plan];
      if(subscription.recurring_interval!=='year'||subscription.recurring_interval_count!==1||subscription.currency!==expected.currency||subscription.amount!==expected.annualAmount)throw fail();
      const start=timestamp(subscription.current_period_start),end=timestamp(subscription.current_period_end),ends=subscription.ends_at?timestamp(subscription.ends_at):end;
      if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(ends)||end<=start)throw fail();
      let validUntil=Math.min(end,ends);
      const ended=subscription.ended_at?timestamp(subscription.ended_at):null;
      if(ended!==null&&!Number.isFinite(ended))throw fail();
      const isPaid=subscription.status==='active'||(subscription.status==='canceled'&&subscription.cancel_at_period_end===true);
      const paidBefore=previous?.owner===owner&&previous.subscriptionId===id&&previous.plan===plan&&previous.source==='polar'&&previous.validUntil>this.now();
      // A failed renewal never extends the previous paid-through deadline.
      const pastDue=subscription.status==='past_due'&&paidBefore;
      if(pastDue)validUntil=Math.min(validUntil,previous.validUntil);
      if((!isPaid&&!pastDue)||start>this.now()||validUntil<=this.now()||(ended!==null&&ended<=this.now()))continue;
      const candidate={...base,plan,validUntil,subscriptionId:id,status:subscription.status,cancelAtPeriodEnd:subscription.cancel_at_period_end===true,periodStart:start};
      if(expected.storageBytes>BILLING_PLANS[best.plan].storageBytes||(plan===best.plan&&validUntil>best.validUntil))best=candidate;
    }
    return best;
  }
  async reconcile(owner){
    assertOwner(owner);assertBillingConfiguration(this.config);
    const ticket=await this.metadata.transaction(async tx=>{const current=await tx.get('billing/revision')||0;await tx.put('billing/revision',current+1);return current+1;});
    const previous=await this.metadata.get(BILLING_STATE_KEY),state=await this.fetchState(owner,previous);
    await this.metadata.transaction(async tx=>{if(await tx.get('billing/revision')===ticket)await tx.put(BILLING_STATE_KEY,state);});
    return this.entitlement(owner);
  }
  async applyWebhook(verified){
    assertBillingConfiguration(this.config);assertOwner(verified?.owner);
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(verified.id||'')||!/^[a-f0-9]{64}$/.test(verified.bodyHash||'')||!Number.isFinite(verified.eventTimestamp)||typeof verified.type!=='string')throw new BillingError('invalid_webhook','Verified webhook descriptor is invalid.');
    const path=EVENT_PREFIX+verified.id,prior=await this.metadata.get(path);
    if(prior){if(prior.bodyHash!==verified.bodyHash)throw new BillingError('webhook_id_conflict','Webhook identifier was reused.',409);return {duplicate:true,...await this.entitlement(verified.owner)};}
    // Bounded durable replay history is kept in the recipient account shard.
    const rows=await this.metadata.list({prefix:EVENT_PREFIX,limit:MAX_EVENTS+1}),expired=[];
    for(const [key,row]of rows)if(row.receivedAt+EVENT_RETENTION_MS<=this.now())expired.push(key);
    if(rows.size-expired.length>=MAX_EVENTS)throw new BillingError('billing_event_capacity','Billing events need reconciliation before retry.',503);
    const result=await this.reconcile(verified.owner);
    await this.metadata.transaction(async tx=>{for(const key of expired)await tx.delete(key);await tx.put(path,{bodyHash:verified.bodyHash,type:verified.type,eventTimestamp:verified.eventTimestamp,receivedAt:this.now()});});
    return {duplicate:false,...result};
  }
}

// Operator-only preflight: product reads are available while the application's
// billing flag remains disabled. This never writes state or creates a checkout.
export async function verifyBillingCatalog(config,{client}={}){
  const service=new BillingService({config:{...config,BILLING_ENABLED:'true'},client,metadata:null}),catalog=await service.catalog();
  return {server:config.POLAR_SERVER,organizationId:catalog.organizationId,plans:['plus','pro'].map(plan=>({...BILLING_PLANS[plan],productId:catalog.entries[plan].id,priceId:catalog.entries[plan].priceId})),verifiedAt:service.now()};
}
