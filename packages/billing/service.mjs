import {PlanChanges} from './changes.mjs';
import {POLAR_CURRENCIES,priceExponent,countryCurrency} from './currencies.mjs';
import {BILLING_PLANS,BILLING_STATE_KEY,BillingError,assertOwner,assertBillingConfiguration,billingEnabled,entitlementFromState,validPlanParameters,metadataPrefix} from './catalog.mjs';

const EVENT_PREFIX='billing/event/';
const EVENT_RETENTION_MS=35*86400000;
const MAX_EVENTS=4096;
export const PAID_HANDLE_MARKER_PREFIX='billing/ever-paid/';
const paidMarkerKey=(server,owner)=>`${PAID_HANDLE_MARKER_PREFIX}${server}/${owner}`;
const boundedId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const orderStatuses=new Set(['draft','pending','paid','refunded','partially_refunded','void']);
function validPaidMarker(marker,owner,config){
  return [1,2].includes(marker?.version)&&marker.source==='polar'&&marker.owner===owner&&marker.server===config.POLAR_SERVER&&['sandbox','production'].includes(marker.server)&&(marker.version===1?['plus','pro']:['paid','plus','ultra']).includes(marker.plan)&&boundedId(marker.productId)&&boundedId(marker.organizationId)&&boundedId(marker.orderId)&&boundedId(marker.subscriptionId)&&Number.isSafeInteger(marker.verifiedAt)&&marker.verifiedAt>=0;
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
  constructor({config,metadata,client,now=Date.now}){this.config=config;this.metadata=metadata;this.clientOverride=client;this.now=now;this.catalogCache=null;this.changes=new PlanChanges(this);}
  async client(){
    assertBillingConfiguration(this.config);
    if(this.clientOverride)return this.clientOverride;
    if(!this.sdk){const {createPolar}=await import('@polar-sh/sdk/2026-10');this.sdk=createPolar({accessToken:this.config.POLAR_ACCESS_TOKEN,environment:this.config.POLAR_SERVER,timeout:5});}
    return this.sdk;
  }
  async catalog(){
    assertBillingConfiguration(this.config);if(this.config.BILLING_CATALOG)return this.config.BILLING_CATALOG.get();
    const ids=assertBillingConfiguration(this.config),fingerprint=JSON.stringify([ids,this.config.POLAR_SERVER,this.config.APP_ORIGIN,this.config.POLAR_CATALOG_MODE??'static',this.config.POLAR_ORGANIZATION_ID??null,metadataPrefix(this.config)]);
    if(this.catalogCache?.fingerprint===fingerprint&&this.catalogCache.expiresAt>this.now())return this.catalogCache;
    const client=await this.client();let products;
    try{if(this.config.POLAR_CATALOG_MODE==='metadata'){products=[];let count;for(let page=1;page<=2;page++){const result=await client.products.list({organization_id:this.config.POLAR_ORGANIZATION_ID,limit:100,page});if(!Array.isArray(result?.items)||result.items.length>100||!Number.isSafeInteger(result.pagination?.total_count)||result.pagination.total_count>200||result.pagination.total_count<0||count!==undefined&&count!==result.pagination.total_count)throw fail();count=result.pagination.total_count;products.push(...result.items);if(products.length===count)break;}if(products.length!==count)throw fail();const marked=new Map();for(const product of products){if(product?.organization_id!==this.config.POLAR_ORGANIZATION_ID)throw fail();const meta=product.metadata;if(meta?.[metadataPrefix(this.config)+'service']!==this.config.APP_ORIGIN)continue;if(product.is_archived===true)continue;if(meta[metadataPrefix(this.config)+'catalog']!=='1'||!['paid','plus','ultra'].includes(meta[metadataPrefix(this.config)+'plan'])||marked.has(meta[metadataPrefix(this.config)+'plan']))throw new BillingError('billing_catalog_mismatch','Marked product metadata is invalid.',503);marked.set(meta[metadataPrefix(this.config)+'plan'],product);}products=['paid','plus','ultra'].map(plan=>marked.get(plan));}else products=await Promise.all(['paid','plus','ultra'].map(plan=>client.products.get(ids[plan])));}catch(error){if(error instanceof BillingError)throw error;throw fail();}
    const entries={};let organizationId;
    for(const [i,plan]of ['paid','plus','ultra'].entries()){
      const product=products[i],expected=BILLING_PLANS[plan],prices=Object.create(null),metadataMode=this.config.POLAR_CATALOG_MODE==='metadata';let parameters={id:plan,name:expected.name,storageBytes:expected.storageBytes,activityHour:2000,activityDay:10000};if(metadataMode&&product){const parse=value=>typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;parameters={id:plan,name:product.name,storageBytes:parse(product.metadata[metadataPrefix(this.config)+'storage_bytes']),activityHour:parse(product.metadata[metadataPrefix(this.config)+'activity_hour']),activityDay:parse(product.metadata[metadataPrefix(this.config)+'activity_day'])};if(!validPlanParameters(parameters))throw new BillingError('billing_catalog_mismatch',`${expected.name} plan: Product name and ${metadataPrefix(this.config)}storage_bytes/activity_hour/activity_day metadata must satisfy the documented plan bounds.`,503);}
      const mismatch=reason=>{throw new BillingError('billing_catalog_mismatch',`${expected.name} plan: ${reason}`,503);};
      if(!product)mismatch('No active product has the required service metadata. Check all three plan products and their metadata.');
      if(!metadataMode&&product.id!==ids[plan]||!boundedId(product.id))mismatch('The product identifier does not match the configured catalog.');
      if(product.is_archived!==false)mismatch('The product must be active, not archived.');
      if(product.is_recurring!==true||product.recurring_interval!=='year')mismatch('The product must have an annual recurring price.');
      if(product.recurring_interval_count!==1)mismatch(`The annual recurrence count must be 1; the provider returned ${product.recurring_interval_count===null?'null':typeof product.recurring_interval_count==='number'?product.recurring_interval_count:typeof product.recurring_interval_count}.`);
      if(!boundedId(product.organization_id)||organizationId&&organizationId!==product.organization_id)mismatch('The product organization does not match the verified catalog.');
      if(!Array.isArray(product.prices)||product.prices.length<1||product.prices.length>256)mismatch('The product must contain a bounded set of fixed catalog prices.');
      for(const price of product.prices){if(price?.is_archived===true)continue;const currency=price?.price_currency;
        if(price?.is_archived!==false)mismatch('An active price is missing its archive status.');
        if(price.source!=='catalog'||price.amount_type!=='fixed')mismatch('Every active price must be a fixed catalog price.');
        if(price.product_id!==product.id||!boundedId(price.id))mismatch('An active price is not bound to this product.');
        if(!POLAR_CURRENCIES.includes(currency))mismatch('An active price uses an unsupported presentment currency.');
        if(Object.hasOwn(prices,currency))mismatch('There must be exactly one active price per currency.');
        if(!Number.isSafeInteger(price.price_amount)||price.price_amount<1||price.price_amount>1000000000)mismatch('An active price amount must be a positive supported integer.');
        prices[currency]={priceId:price.id,currency,amount:price.price_amount,exponent:priceExponent(currency)};
      }
      if(!prices.usd)mismatch('An active fixed USD catalog price is required.');
      if(!metadataMode&&prices.usd.amount!==expected.annualAmount)mismatch('The USD price does not match the reviewed static catalog amount.');
      organizationId=product.organization_id;entries[plan]={id:product.id,priceId:prices.usd.priceId,prices,parameters};
    }
    this.catalogCache={fingerprint,organizationId,entries,expiresAt:this.now()+300000};return this.catalogCache;
  }
  selection(catalog,{country,currency}={}){const currencies=Object.keys(catalog.entries.paid.prices).filter(code=>Object.values(catalog.entries).every(entry=>Object.hasOwn(entry.prices,code))).sort();if(currency!==undefined&&(typeof currency!=='string'||!currencies.includes(currency)))throw new BillingError('invalid_currency','Choose an available billing currency.');const regional=countryCurrency(country);return {catalog,currencies,currency:currency??(currencies.includes(regional)?regional:'usd')};}
  checkoutHints({customerIpAddress,locale}={}){const result={};if(typeof customerIpAddress==='string'&&customerIpAddress.length<=45&&(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(customerIpAddress)&&customerIpAddress.split('.').every(part=>Number(part)<=255)||/^[a-fA-F0-9:]+$/.test(customerIpAddress)&&customerIpAddress.includes(':'))&&!['127.0.0.1','::1','0.0.0.0'].includes(customerIpAddress))result.customer_ip_address=customerIpAddress;if(locale!==undefined){try{if(typeof locale!=='string'||locale.length>100)throw Error();result.locale=Intl.getCanonicalLocales(locale)[0];if(!result.locale)throw Error();}catch{throw new BillingError('invalid_locale','Choose a valid checkout language.');}}return result;}
  async entitlement(owner){assertOwner(owner);const state=await this.metadata.get(BILLING_STATE_KEY);return entitlementFromState(state?.owner===owner?state:null,this.now(),this.config);}
  async paidHandleEligibility(owner){
    assertOwner(owner);
    const markerKey=paidMarkerKey(this.config.POLAR_SERVER,owner),existing=await this.metadata.get(markerKey);
    if(existing!==undefined){if(!validPaidMarker(existing,owner,this.config))throw fail();return true;}
    assertBillingConfiguration(this.config);
    const catalog=await this.catalog(),client=await this.client();
    let pagination,examined=0;const seen=new Set();
    for(let page=1;page<=2;page++){
      let result;
      try{result=await client.orders.list({external_customer_id:owner,organization_id:catalog.organizationId,product_id:['paid','plus','ultra'].map(plan=>catalog.entries[plan].id),status:'paid',limit:100,page});}catch{throw fail();}
      const current=result?.pagination;
      if(!Array.isArray(result?.items)||result.items.length>100||!Number.isSafeInteger(current?.total_count)||current.total_count<0||!Number.isSafeInteger(current?.max_page)||current.max_page<0||current.max_page!==Math.ceil(current.total_count/100)&&!(current.total_count===0&&current.max_page===1))throw fail();
      if(pagination&&(current.total_count!==pagination.total_count||current.max_page!==pagination.max_page))throw fail();
      pagination=current;
      if(result.items.length!==Math.min(100,Math.max(0,current.total_count-(page-1)*100)))throw fail();
      let candidate;
      for(const order of result.items){
        const plan=Object.keys(catalog.entries).find(name=>catalog.entries[name].id===order?.product_id),expected=plan?catalog.entries[plan].prices[order?.currency]:undefined,subscription=order?.subscription;
        if(!boundedId(order?.id)||seen.has(order.id)||!plan||typeof order.paid!=='boolean'||!orderStatuses.has(order.status)||!Number.isFinite(timestamp(order.created_at))||typeof order.currency!=='string'||!['net_amount','total_amount'].every(name=>Number.isSafeInteger(order[name])&&Math.abs(order[name])<=1000000000000)||!Number.isSafeInteger(order.refunded_amount)||order.refunded_amount<0)throw fail();
        seen.add(order.id);examined++;
        if(!boundedId(order.customer_id)||order.customer?.id!==order.customer_id||order.customer.external_id!==owner||order.customer.organization_id!==catalog.organizationId||order.product?.id!==order.product_id||order.product.organization_id!==catalog.organizationId||order.product.is_recurring!==true||order.product.recurring_interval!=='year'||order.product.recurring_interval_count!==1)throw fail();
        if(!boundedId(order.subscription_id)||subscription?.id!==order.subscription_id||subscription.customer_id!==order.customer_id||subscription.product_id!==order.product_id||!expected||subscription.currency!==expected.currency||subscription.recurring_interval!=='year'||subscription.recurring_interval_count!==1||!Number.isSafeInteger(subscription.amount)||subscription.amount!==expected.amount)throw fail();
        const money=['subtotal_amount','discount_amount','net_amount','tax_amount','total_amount','applied_balance_amount','due_amount','refunded_amount','refunded_tax_amount'];if(!money.every(key=>Number.isSafeInteger(order[key])&&Math.abs(order[key])<=1000000000000)||order.discount_amount<0||order.refunded_amount<0||order.refunded_tax_amount<0||order.net_amount+order.tax_amount!==order.total_amount||Math.max(0,order.total_amount+order.applied_balance_amount)!==order.due_amount||![order.net_amount,order.total_amount].includes(order.subtotal_amount-order.discount_amount))throw fail();if(order.paid===true&&order.status==='paid'&&order.currency===expected.currency&&order.net_amount>0&&order.due_amount>0&&order.refunded_amount===0&&order.refunded_tax_amount===0)candidate??={version:2,source:'polar',owner,server:this.config.POLAR_SERVER,organizationId:catalog.organizationId,plan,productId:order.product_id,orderId:order.id,subscriptionId:order.subscription_id,verifiedAt:this.now()};
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
  async status(owner,options={}){
    const entitlement=await this.entitlement(owner),state=await this.metadata.get(BILLING_STATE_KEY);
    let configured=false;try{assertBillingConfiguration(this.config);configured=true;}catch{}
    const paidMarker=await this.metadata.get(paidMarkerKey(this.config.POLAR_SERVER,owner));let pricing,pricingError;
    if(billingEnabled(this.config)){try{pricing=this.selection(await this.catalog(),{...options,...options.currency===undefined&&entitlement.plan!=='free'&&state?.currency?{currency:state.currency}:{}});}catch(error){if(error.code==='invalid_currency')throw error;pricingError=error.code||'billing_provider_unavailable';}}
    const plans=await Promise.all(Object.values(BILLING_PLANS).map(async plan=>{const selected=pricing?.currency??'usd',entry=pricing?.catalog.entries[plan.id]?.prices[selected];return {...plan,...pricing?.catalog.entries[plan.id]?.parameters,priceDigest:pricing&&plan.id!=='free'?await this.changes.quote(owner,state,pricing.catalog,plan.id,selected):null,quoteExpiresAt:pricing?.catalog.expiresAt??null,price:plan.id==='free'?{currency:selected,amount:0,exponent:priceExponent(selected),source:pricing?'polar':'reviewed-base',taxBehavior:'checkout',available:true}:pricing?{currency:entry.currency,amount:entry.amount,exponent:entry.exponent,source:'polar',taxBehavior:'checkout',available:true}:billingEnabled(this.config)?null:{currency:'usd',amount:plan.annualAmount,exponent:2,source:'reviewed-base',taxBehavior:'checkout',available:false}};}));
    return {...entitlement,paidHandleEligible:validPaidMarker(paidMarker,owner,this.config),enabled:billingEnabled(this.config),configured,server:['sandbox','production'].includes(this.config.POLAR_SERVER)?this.config.POLAR_SERVER:null,plans,currencies:pricing?.currencies??['usd'],selectedCurrency:pricing?.currency??'usd',pricingUnavailable:Boolean(pricingError),pricingError:pricingError??null,changeAttempt:await this.changes.view(options.txId),mutationBlocked:Boolean(await this.metadata.get('billing/change-lock')),pendingChange:state?.pendingChange??null,billingAttention:state?.billingAttention??null,subscription:state?.owner===owner?{currency:state.currency??null,status:state.status,cancelAtPeriodEnd:state.cancelAtPeriodEnd||false,validUntil:state.validUntil,reconciledAt:state.reconciledAt}:null};
  }
  async checkout(owner,plan,options={}){
    assertOwner(owner);if(!['paid','plus','ultra'].includes(plan))throw new BillingError('invalid_plan','Choose Paid, Plus or Ultra.');
    const catalog=await this.catalog(),selection=this.selection(catalog,options),hints=this.checkoutHints(options),client=await this.client(),url=returnURL(this.config);
    // Reject duplicate purchases; upgrades and cancellation use the portal.
    const current=await this.reconcile(owner);
    if(current.plan!=='free')throw new BillingError('subscription_exists','Manage your current subscription in the billing portal.',409);
    let session;try{session=await client.checkouts.create({products:[catalog.entries[plan].id],external_customer_id:owner,success_url:url,return_url:url,currency:selection.currency,...hints,allow_trial:false,allow_discount_codes:true});}catch{throw fail();}
    const chosen=catalog.entries[plan].prices[selection.currency];if(session?.currency!==chosen.currency||session.amount!==chosen.amount||session.product_id!==catalog.entries[plan].id||session.organization_id!==catalog.organizationId||session.external_customer_id!==owner||session.allow_discount_codes!==true||!['discount_amount','net_amount','total_amount'].every(key=>Number.isSafeInteger(session[key])&&session[key]>=0)||session.discount_amount>session.amount||session.tax_amount!==null&&(!Number.isSafeInteger(session.tax_amount)||session.tax_amount<0)||![null,'inclusive','exclusive'].includes(session.tax_behavior)||session.total_amount!==session.net_amount+(session.tax_amount??0)||(session.tax_behavior==='inclusive'?session.total_amount:session.net_amount)!==session.amount-session.discount_amount)throw new BillingError('billing_checkout_mismatch','Checkout does not match the displayed price. Please refresh and try again.',503);await this.metadata.put('billing/pending',{owner,productId:catalog.entries[plan].id,currency:selection.currency,createdAt:this.now(),expiresAt:Math.min(Number.isFinite(Date.parse(session.expires_at))?Date.parse(session.expires_at):this.now()+86400000,this.now()+7*86400000)});return {url:portalURL(session.url,this.config.POLAR_SERVER)};
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
    let catalog,catalogError;try{catalog=await this.catalog();}catch(error){catalogError=error;}const client=await this.client();let customer;const organizationId=catalog?.organizationId??this.config.POLAR_ORGANIZATION_ID??previous?.organizationId;
    try{customer=await client.customers.getStateExternal(owner);}catch(error){if(error.statusCode===404)return {owner,source:'polar',catalogVersion:2,plan:'free',validUntil:null,status:'none',reconciledAt:this.now()};throw fail();}
    if(customer?.external_id!==owner||(!organizationId||customer.organization_id!==organizationId)||!customer.id||!Array.isArray(customer.active_subscriptions)||customer.active_subscriptions.length>100)throw fail();
    const base={owner,source:'polar',catalogVersion:2,plan:'free',validUntil:null,status:customer.deleted_at?'deleted':'none',customerId:customer.id,reconciledAt:this.now()};
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
      if(subscription.customer_id!==customer.id||subscription.customer?.external_id!==owner||subscription.customer?.organization_id!==organizationId)throw fail();const fenced=await this.changes.fence(subscription,organizationId);if(fenced?.held){best={...fenced.held,reconciledAt:this.now()};continue;}if(fenced?.confirmed)previous=fenced.confirmed;
      let plan=catalog?Object.keys(catalog.entries).find(name=>catalog.entries[name].id===subscription.product_id):undefined,legacy=false,retained=false;
      const legacyPlan=previous?.catalogVersion===undefined?({plus:'paid',pro:'plus'})[previous?.plan]:[2,3].includes(previous?.catalogVersion)&&previous.legacyCatalogVersion===1&&['paid','plus'].includes(previous.plan)?previous.plan:undefined;
      const legacyAmount=legacyPlan==='paid'?500:legacyPlan==='plus'?3000:undefined;
      if((!plan||subscription.amount!==catalog?.entries[plan]?.prices[subscription.currency]?.amount)&&legacyPlan&&previous.owner===owner&&previous.source==='polar'&&previous.subscriptionId===id&&Number.isFinite(previous.validUntil)&&previous.validUntil>this.now()&&(!previous.customerId||previous.customerId===customer.id)&&(!previous.legacyProductId||previous.legacyProductId===subscription.product_id)&&subscription.currency==='usd'&&subscription.amount===legacyAmount){plan=legacyPlan;legacy=true;}
      if((!plan||subscription.amount!==catalog?.entries[plan]?.prices[subscription.currency]?.amount)&&[2,3].includes(previous?.catalogVersion)&&previous.owner===owner&&previous.source==='polar'&&previous.subscriptionId===id&&(previous.productId??(this.config.POLAR_CATALOG_MODE!=='metadata'?assertBillingConfiguration(this.config)[previous.plan]:undefined))===subscription.product_id&&previous.customerId===customer.id&&(!previous.organizationId||previous.organizationId===organizationId)&&(previous.catalogVersion!==3||previous.origin===this.config.APP_ORIGIN&&previous.server===this.config.POLAR_SERVER&&previous.metadataPrefix===metadataPrefix(this.config)&&previous.catalogMode===(this.config.POLAR_CATALOG_MODE??'static'))&&(previous.catalogVersion===2&&['paid','plus','ultra'].includes(previous.plan)||validPlanParameters(previous.verifiedPlan))&&subscription.currency===(previous.currency??'usd')&&subscription.amount===(previous.annualAmount??BILLING_PLANS[previous.plan]?.annualAmount)){plan=previous.plan;retained=true;}
      if(!plan)continue;const expected=legacy?{currency:'usd',amount:legacyAmount}:retained?{currency:previous.currency??'usd',amount:previous.annualAmount??BILLING_PLANS[previous.plan].annualAmount}:catalog.entries[plan].prices[subscription.currency];if(!expected)throw fail();
      if(subscription.recurring_interval!=='year'||subscription.recurring_interval_count!==1||!expected||subscription.currency!==expected.currency||subscription.amount!==expected.amount)throw fail();
      const start=timestamp(subscription.current_period_start),end=timestamp(subscription.current_period_end),ends=subscription.ends_at?timestamp(subscription.ends_at):end;
      if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(ends)||end<=start)throw fail();
      let validUntil=Math.min(end,ends,...(legacy||retained&&previous.catalogVersion===2)?[previous.validUntil,previous.legacyPaidUntil??previous.validUntil]:[]);
      const ended=subscription.ended_at?timestamp(subscription.ended_at):null;
      if(ended!==null&&!Number.isFinite(ended))throw fail();
      const isPaid=subscription.status==='active'||(subscription.status==='canceled'&&subscription.cancel_at_period_end===true);
      const paidBefore=previous?.owner===owner&&previous.subscriptionId===id&&entitlementFromState(previous,this.now(),this.config).plan===plan&&previous.source==='polar'&&previous.validUntil>this.now();
      // A failed renewal never extends the previous paid-through deadline.
      const pastDue=subscription.status==='past_due'&&paidBefore;
      if(pastDue)validUntil=Math.min(validUntil,previous.validUntil);
      if((!isPaid&&!pastDue)||start>this.now()||validUntil<=this.now()||(ended!==null&&ended<=this.now()))continue;
      const candidate={...base,catalogVersion:3,origin:this.config.APP_ORIGIN,server:this.config.POLAR_SERVER,metadataPrefix:metadataPrefix(this.config),catalogMode:this.config.POLAR_CATALOG_MODE??'static',organizationId,verifiedPlan:legacy?{id:plan,name:BILLING_PLANS[plan].name,storageBytes:BILLING_PLANS[plan].storageBytes,activityHour:2000,activityDay:10000}:retained?(catalog?.entries[plan]?.id===subscription.product_id?catalog.entries[plan].parameters:previous.verifiedPlan??{id:plan,name:BILLING_PLANS[plan].name,storageBytes:BILLING_PLANS[plan].storageBytes,activityHour:2000,activityDay:10000}):catalog?.entries[plan]?.parameters??previous.verifiedPlan,plan,validUntil,currency:expected.currency,annualAmount:expected.amount,productId:subscription.product_id,...legacy?{legacyCatalogVersion:1,legacyProductId:subscription.product_id,legacyAnnualAmount:legacyAmount,legacyPaidUntil:previous.legacyPaidUntil??previous.validUntil}:{},subscriptionId:id,...subscription.pending_update?.product_id&&Number.isFinite(Date.parse(subscription.pending_update.applies_at))?{pendingChange:{plan:Object.keys(catalog?.entries??{}).find(key=>catalog.entries[key].id===subscription.pending_update.product_id)??null,kind:'renewal-downgrade',effectiveAt:Date.parse(subscription.pending_update.applies_at)}}:{},status:subscription.status,cancelAtPeriodEnd:subscription.cancel_at_period_end===true,periodStart:start,periodEnd:end};
      if(best.plan==='free'||candidate.verifiedPlan.storageBytes>(best.verifiedPlan?.storageBytes??BILLING_PLANS[best.plan].storageBytes)||(plan===best.plan&&validUntil>best.validUntil))best=candidate;
    }
    if(catalogError&&best.plan==='free'&&!previous?.subscriptionId)throw catalogError;return best;
  }
  async reconcile(owner){
    assertOwner(owner);assertBillingConfiguration(this.config);
    const ticket=await this.metadata.transaction(async tx=>{const current=await tx.get('billing/revision');if(current!==undefined&&(!Number.isSafeInteger(current)||current<0)||!Number.isSafeInteger((current??0)+1))throw fail();await tx.put('billing/revision',(current??0)+1);return (current??0)+1;});
    const previous=await this.metadata.get(BILLING_STATE_KEY),state=await this.fetchState(owner,previous);
    await this.metadata.transaction(async tx=>{if(await tx.get('billing/revision')===ticket){await tx.put(BILLING_STATE_KEY,state);if(state.plan!=='free')await tx.delete('billing/pending');}});
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
  return {server:config.POLAR_SERVER,organizationId:catalog.organizationId,plans:['paid','plus','ultra'].map(plan=>({...BILLING_PLANS[plan],...catalog.entries[plan].parameters,prices:catalog.entries[plan].prices,productId:catalog.entries[plan].id,priceId:catalog.entries[plan].priceId})),verifiedAt:service.now()};
}
