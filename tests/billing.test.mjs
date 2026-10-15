import test from 'node:test';
import assert from 'node:assert/strict';
import {Webhook} from 'standardwebhooks';
import {BillingService,verifyBillingCatalog,BILLING_PLANS,BILLING_STATE_KEY,entitlementFromState,verifyPolarWebhook,MAX_WEBHOOK_BYTES} from '../packages/billing/index.mjs';

const owner='aa111111-1111-4111-8111-111111111111',other='bb222222-2222-4222-8222-222222222222';
const secret='whsec_'+Buffer.alloc(32,39).toString('base64');
const config={BILLING_ENABLED:'true',POLAR_SERVER:'sandbox',POLAR_ACCESS_TOKEN:'offline-only',POLAR_WEBHOOK_SECRET:secret,POLAR_PRODUCT_ID_PAID:'paid-product',POLAR_PRODUCT_ID_PLUS:'plus-product',POLAR_PRODUCT_ID_ULTRA:'ultra-product',APP_ORIGIN:'https://3sln.example'};
class Metadata {
  constructor(){this.rows=new Map();this.tail=Promise.resolve();}
  async get(k){return structuredClone(this.rows.get(k));}
  async put(k,v){this.rows.set(k,structuredClone(v));}
  async delete(k){this.rows.delete(k);}
  async list({prefix='',limit=100000}={}){return new Map([...this.rows].filter(([k])=>k.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));}
  async transaction(fn){const previous=this.tail;let release;this.tail=new Promise(r=>release=r);await previous;const snapshot=structuredClone(this.rows);try{return await fn(this);}catch(e){this.rows=snapshot;throw e;}finally{release();}}
}
function fixture(){
  const now=Date.now(),metadata=new Metadata(),calls=[];
  const products=Object.fromEntries(['paid','plus','ultra'].map(plan=>{const id=config[`POLAR_PRODUCT_ID_${plan.toUpperCase()}`];return [id,{id,is_archived:false,is_recurring:true,recurring_interval:'year',recurring_interval_count:1,organization_id:'org',prices:[{id:plan+'-price',product_id:id,source:'catalog',is_archived:false,amount_type:'fixed',price_currency:'usd',price_amount:BILLING_PLANS[plan].annualAmount}]}];}));
  const customer={id:'customer',external_id:owner,organization_id:'org',deleted_at:null,active_subscriptions:[]};
  const subscription={id:'subscription',customer_id:customer.id,customer:{...customer},product_id:config.POLAR_PRODUCT_ID_PLUS,amount:3500,currency:'usd',recurring_interval:'year',recurring_interval_count:1,status:'active',current_period_start:new Date(now-1000).toISOString(),current_period_end:new Date(now+365*86400000).toISOString(),cancel_at_period_end:false,ended_at:null,ends_at:null};
  const client={products:{get:async id=>{calls.push(['product',id]);return structuredClone(products[id]);}},customers:{getStateExternal:async id=>{calls.push(['customer',id]);return structuredClone(customer);}},subscriptions:{get:async id=>{calls.push(['subscription',id]);return structuredClone(subscription);}},checkouts:{create:async body=>{calls.push(['checkout',body]);const selected=products[body.products[0]].prices.find(price=>price.price_currency===body.currency);return {url:'https://sandbox.polar.sh/checkout/test',currency:body.currency,amount:selected.price_amount,discount_amount:0,net_amount:selected.price_amount,total_amount:selected.price_amount,tax_amount:null,tax_behavior:null,allow_discount_codes:true,product_id:body.products[0],organization_id:'org',external_customer_id:body.external_customer_id};}},customerSessions:{create:async body=>{calls.push(['portal',body]);return {customer_id:customer.id,customer:structuredClone(customer),customer_portal_url:'https://sandbox.polar.sh/test/portal'};}}};
  let clock=now;return {metadata,products,customer,subscription,client,calls,now,advance:ms=>clock+=ms,service:new BillingService({config,metadata,client,now:()=>clock})};
}
function eventRequest({event={type:'customer.state_changed',timestamp:new Date().toISOString(),api_version:'2026-10',data:{id:'customer',organization_id:'org',external_id:owner}},id='evt_test',date=new Date(),tamper,headers={}}={}){
  const body=JSON.stringify(event),signer=new Webhook(secret);
  return new Request('https://3sln.example/api/billing/webhook',{method:'POST',body:tamper??body,headers:{'content-type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(date.getTime()/1000)),'webhook-signature':signer.sign(id,date,body),...headers}});
}
test('plan quotas use decimal bytes and expired entitlements fall back to the 500 MB free plan',()=>{
  assert.deepEqual(Object.values(BILLING_PLANS).map(p=>[p.storageBytes,p.annualAmount]),[[500000000,0],[5000000000,500],[100000000000,3500],[1000000000000,25000]]);
  assert.equal(entitlementFromState({source:'polar',catalogVersion:2,plan:'plus',validUntil:5},5).storageBytes,500000000);
  assert.equal(entitlementFromState({source:'browser',plan:'plus',validUntil:Infinity},0).plan,'free');
});
test('disabled or incomplete billing never invokes the provider',async()=>{
  const f=fixture(),service=new BillingService({config:{...config,BILLING_ENABLED:'false'},metadata:f.metadata,client:f.client});
  assert.equal((await service.status(owner)).enabled,false);
  await assert.rejects(service.checkout(owner,'paid'),{code:'billing_disabled'});
  assert.equal((await verifyPolarWebhook(eventRequest(),{...config,POLAR_ACCESS_TOKEN:''})).owner,owner);
  assert.equal(f.calls.length,0);
});
test('explicit operator preflight verifies all three products while app billing remains disabled and creates no effects',async()=>{
  const f=fixture(),settings={...config,BILLING_ENABLED:'false'};
  const result=await verifyBillingCatalog(settings,{client:f.client});assert.equal(settings.BILLING_ENABLED,'false');assert.equal(result.organizationId,'org');assert.deepEqual(result.plans.map(p=>p.annualAmount),[500,3500,25000]);assert.deepEqual(f.calls,[['product','paid-product'],['product','plus-product'],['product','ultra-product']]);assert.equal(f.metadata.rows.size,0);
  await assert.rejects(verifyBillingCatalog({...settings,POLAR_ACCESS_TOKEN:''},{client:f.client}),{code:'billing_unconfigured'});
});
test('actual SDK verifies offline Standard Webhooks signatures, timestamp, exact body and API version',async t=>{
  // Frozen wall time: the 300 s tolerance is probed one second outside on both sides, independent of test speed.
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,14,12)});
  const verified=await verifyPolarWebhook(eventRequest(),config);assert.equal(verified.owner,owner);assert.equal(verified.id,'evt_test');assert.match(verified.bodyHash,/^[a-f0-9]{64}$/);
  await assert.rejects(verifyPolarWebhook(eventRequest({tamper:'{}'}),config),{code:'invalid_webhook_signature'});
  await assert.rejects(verifyPolarWebhook(eventRequest({date:new Date(Date.now()-301000)}),config),{code:'invalid_webhook_signature'});
  await assert.rejects(verifyPolarWebhook(eventRequest({date:new Date(Date.now()+301000)}),config),{code:'invalid_webhook_signature'});
  await assert.rejects(verifyPolarWebhook(eventRequest({event:{type:'customer.state_changed',timestamp:new Date().toISOString(),api_version:'2026-04',data:{id:'customer',organization_id:'org',external_id:owner}}}),config),{code:'invalid_webhook'});
});
test('routing never falls back to customer metadata or email and rejects oversized raw streams',async()=>{
  assert.equal((await verifyPolarWebhook(eventRequest({event:{type:'customer.state_changed',timestamp:new Date().toISOString(),api_version:'2026-10',data:{metadata:{owner},email:owner}}}),config)).ignored,true);
  await assert.rejects(verifyPolarWebhook(eventRequest({tamper:' '.repeat(MAX_WEBHOOK_BYTES+1)}),config),{code:'webhook_too_large'});
  const subscriptionEvent={type:'subscription.updated',timestamp:new Date().toISOString(),api_version:'2026-10',data:{id:'subscription',product_id:'plus-product',customer_id:'customer',customer:{external_id:owner,organization_id:'org'},metadata:{owner:other}}};
  assert.equal((await verifyPolarWebhook(eventRequest({event:subscriptionEvent}),config)).owner,owner);
});
test('catalog is checked against provider products before checkout and owner UUID is server supplied',async()=>{
  const f=fixture();await f.service.checkout(owner,'paid');
  const body=f.calls.find(([kind])=>kind==='checkout')[1];assert.deepEqual(body.products,['paid-product']);assert.equal(body.external_customer_id,owner);assert.equal(body.allow_trial,false);assert.equal(body.allow_discount_codes,true);assert.equal(body.success_url,'https://3sln.example/');
  assert(!Object.hasOwn(body,'customer_metadata'));assert.equal((await f.service.entitlement(owner)).plan,'free');
  const bad=fixture();bad.products['plus-product'].prices[0].price_amount=501;
  await assert.rejects(bad.service.checkout(owner,'paid'),{code:'billing_catalog_mismatch'});assert(!bad.calls.some(([kind])=>kind==='checkout'));
});
test('portal uses a verified provider customer and refuses mismatched external identity',async()=>{
  const f=fixture();assert.match((await f.service.portal(owner)).url,/^https:\/\/sandbox.polar.sh\//);assert.equal(f.calls.find(([kind])=>kind==='portal')[1].customer_id,'customer');
  f.customer.external_id=other;await assert.rejects(f.service.portal(owner),{code:'billing_customer_unavailable'});
  await assert.rejects(f.service.reconcile(owner),{code:'billing_provider_unavailable'});
});
test('checkout and portal reject unexpected hosted URLs and browser-derived return origins',async()=>{
  const f=fixture(),create=f.client.checkouts.create;f.client.checkouts.create=async input=>({...await create(input),url:'https://checkout.evil.example/'});
  await assert.rejects(f.service.checkout(owner,'paid'),{code:'billing_provider_unavailable'});
  f.client.customerSessions.create=async()=>({customer_id:f.customer.id,customer:f.customer,customer_portal_url:'https://sandbox.polar.sh.evil.example/portal'});
  await assert.rejects(f.service.portal(owner),{code:'billing_provider_unavailable'});
  const bad=new BillingService({config:{...config,APP_ORIGIN:'https://3sln.example/path'},metadata:f.metadata,client:f.client});
  await assert.rejects(bad.checkout(owner,'paid'),{code:'billing_unconfigured'});
});
test('signed notifications reconcile fresh provider state, replay idempotently and survive recreation',async()=>{
  const f=fixture();f.customer.active_subscriptions=[{id:f.subscription.id}];const verified=await verifyPolarWebhook(eventRequest(),config);
  assert.equal((await f.service.applyWebhook(verified)).plan,'plus');assert.equal((await f.metadata.get(BILLING_STATE_KEY)).owner,owner);
  const calls=f.calls.length;const restarted=new BillingService({config,metadata:f.metadata,client:f.client,now:()=>f.now});
  assert.equal((await restarted.applyWebhook(verified)).duplicate,true);assert.equal(f.calls.length,calls);
  await assert.rejects(restarted.applyWebhook({...verified,bodyHash:'0'.repeat(64)}),{code:'webhook_id_conflict'});
  f.customer.active_subscriptions=[];f.subscription.ended_at=new Date(f.now).toISOString();f.subscription.status='canceled';
  // A delayed old notification cannot regrant its old payload: provider state wins.
  assert.equal((await restarted.applyWebhook({...verified,id:'evt_delayed',eventTimestamp:verified.eventTimestamp-1000})).plan,'free');
});
test('cancellation keeps paid access until expiry, past_due cannot extend and revocation removes access',async()=>{
  const f=fixture();f.customer.active_subscriptions=[{id:f.subscription.id}];const paid=await f.service.reconcile(owner),deadline=paid.validUntil;
  f.customer.active_subscriptions=[];f.subscription.status='canceled';f.subscription.cancel_at_period_end=true;
  assert.equal((await f.service.reconcile(owner)).plan,'plus');
  f.subscription.status='past_due';f.subscription.current_period_end=new Date(deadline+365*86400000).toISOString();
  assert.equal((await f.service.reconcile(owner)).validUntil,deadline);
  f.advance(deadline-f.now+1);assert.equal((await f.service.entitlement(owner)).plan,'free');
  const initial=fixture();initial.customer.active_subscriptions=[{id:initial.subscription.id}];initial.subscription.status='past_due';assert.equal((await initial.service.reconcile(owner)).plan,'free');
  const revoked=fixture();revoked.customer.active_subscriptions=[{id:revoked.subscription.id}];await revoked.service.reconcile(owner);revoked.subscription.status='canceled';revoked.subscription.cancel_at_period_end=false;assert.equal((await revoked.service.reconcile(owner)).plan,'free');
});
test('provider failure preserves last paid deadline and webhook remains retryable',async()=>{
  const f=fixture();f.customer.active_subscriptions=[{id:f.subscription.id}];await f.service.reconcile(owner);const before=await f.metadata.get(BILLING_STATE_KEY);
  const verified=await verifyPolarWebhook(eventRequest(),config);f.client.customers.getStateExternal=async()=>{throw new Error('offline failure');};
  await assert.rejects(f.service.applyWebhook(verified),{code:'billing_provider_unavailable'});assert.deepEqual(await f.metadata.get(BILLING_STATE_KEY),before);assert.equal(await f.metadata.get('billing/event/'+verified.id),undefined);
});
test('trialing, unpaid and paused subscriptions never grant new paid capacity',async()=>{
  for(const status of ['trialing','unpaid','paused','incomplete','incomplete_expired']){const f=fixture();f.customer.active_subscriptions=[{id:f.subscription.id}];f.subscription.status=status;assert.equal((await f.service.reconcile(owner)).plan,'free');}
});
test('an earlier overlapping reconciliation cannot overwrite a later provider snapshot',async()=>{
  const f=fixture();f.customer.active_subscriptions=[{id:f.subscription.id}];let release,started;
  const waiting=new Promise(r=>started=r),blocked=new Promise(r=>release=r),read=f.service.fetchState.bind(f.service);let first=true;
  f.service.fetchState=async(...args)=>{const value=await read(...args);if(first){first=false;started();await blocked;}return value;};
  const old=f.service.reconcile(owner);await waiting;
  f.subscription.status='canceled';f.subscription.cancel_at_period_end=false;await f.service.reconcile(owner);release();await old;
  assert.equal((await f.service.entitlement(owner)).plan,'free');
});
test('replay history capacity fails closed and expired history is cleaned within a bounded page',async()=>{
  const f=fixture(),verified=await verifyPolarWebhook(eventRequest(),config);
  for(let i=0;i<4096;i++)await f.metadata.put('billing/event/old_'+i,{bodyHash:'0'.repeat(64),receivedAt:f.now});
  await assert.rejects(f.service.applyWebhook(verified),{code:'billing_event_capacity'});assert.equal(f.calls.length,0);
  f.advance(36*86400000);await f.service.applyWebhook(verified);
  assert.equal((await f.metadata.list({prefix:'billing/event/'})).size,1);
});

test('versioned catalog preserves legacy bytes and rejects unknown versions without automatic tier escalation',()=>{for(const [old,plan,bytes]of [['plus','paid',5000000000],['pro','plus',100000000000]])assert.deepEqual(entitlementFromState({source:'polar',plan:old,validUntil:1000},0),{plan,storageBytes:bytes,validUntil:1000});for(const state of [{catalogVersion:3,plan:'ultra'},{catalogVersion:2,plan:'pro'},{plan:'ultra'},{plan:'paid'}])assert.equal(entitlementFromState({source:'polar',validUntil:1000,...state},0).plan,'free');for(const plan of ['paid','plus','ultra'])assert.equal(entitlementFromState({source:'polar',catalogVersion:2,plan,validUntil:1000},0).plan,plan);});
test('verified legacy prepaid Pro period survives reconcile/restart without extending oldprice deadline',async()=>{const f=fixture(),deadline=f.now+100000;f.customer.active_subscriptions=[{id:'subscription'}];Object.assign(f.subscription,{product_id:'legacy-pro-product',amount:3000,current_period_end:new Date(f.now+86400000).toISOString()});await f.metadata.put(BILLING_STATE_KEY,{owner,source:'polar',plan:'pro',customerId:'customer',subscriptionId:'subscription',validUntil:deadline});assert.equal((await f.service.reconcile(owner)).plan,'plus');const migrated=await f.metadata.get(BILLING_STATE_KEY);assert.equal(migrated.catalogVersion,3);assert.equal(migrated.legacyPaidUntil,deadline);assert.equal(migrated.validUntil,deadline);const restarted=new BillingService({config,metadata:f.metadata,client:f.client,now:()=>f.now+1000});f.subscription.current_period_end=new Date(f.now+2*86400000).toISOString();assert.equal((await restarted.reconcile(owner)).validUntil,deadline);f.subscription.ended_at=new Date(f.now).toISOString();assert.equal((await restarted.reconcile(owner)).plan,'free');});
test('unknown oldprice subscriptions cannot create migrated entitlement without a pinned prior verified subscription',async()=>{const f=fixture();f.customer.active_subscriptions=[{id:'subscription'}];Object.assign(f.subscription,{product_id:'legacy-pro-product',amount:3000});assert.equal((await f.service.reconcile(owner)).plan,'free');});

function currencies(f){for(const [id,product] of Object.entries(f.products))for(const [currency,amount] of [['eur',id==='paid-product'?450:id==='plus-product'?3200:23000],['jpy',id==='paid-product'?800:id==='plus-product'?5500:38000],['isk',id==='paid-product'?65000:id==='plus-product'?450000:3200000]])product.prices.push({...product.prices[0],id:id+'-'+currency,price_currency:currency,price_amount:amount});}
test('regional prices read Polar fixed catalog without checkout side effects and use provider decimal factors',async()=>{const f=fixture();currencies(f);for(const [country,currency,amount,exponent]of [['DE','eur',450,2],['JP','jpy',800,0],['IS','isk',65000,2],['ZZ','usd',500,2]]){const status=await f.service.status(owner,{country});assert.equal(status.selectedCurrency,currency);assert.deepEqual(status.plans.find(p=>p.id==='paid').price,{currency,amount,exponent,source:'polar',taxBehavior:'checkout',available:true});}assert.equal(f.calls.filter(([kind])=>kind==='product').length,3);assert.equal(f.calls.filter(([kind])=>kind==='checkout').length,0);assert.equal((await f.service.status(owner,{country:'JP',currency:'eur'})).selectedCurrency,'eur');await assert.rejects(f.service.status(owner,{currency:'kwd'}),{code:'invalid_currency'});});
test('checkout forwards exact selected catalog currency and trusted hints and rejects stale returned price',async()=>{const f=fixture();currencies(f);await f.service.checkout(owner,'paid',{country:'JP',customerIpAddress:'203.0.113.8',locale:'ja-JP'});const body=f.calls.find(([kind])=>kind==='checkout')[1];assert.equal(body.currency,'jpy');assert.equal(body.customer_ip_address,'203.0.113.8');assert.equal(body.locale,'ja-JP');assert.equal(body.amount,undefined);const create=f.client.checkouts.create;f.client.checkouts.create=async input=>({...await create(input),currency:'usd'});await assert.rejects(f.service.checkout(owner,'paid',{currency:'jpy'}),{code:'billing_checkout_mismatch'});});
test('catalog refuses duplicate currency, unsupported provider currency or invalid amount rather than quoting a fallback',async()=>{for(const mutate of [p=>p.prices.push({...p.prices[0],id:'duplicate'}),p=>p.prices.push({...p.prices[0],id:'kwd',price_currency:'kwd'}),p=>p.prices.push({...p.prices[0],id:'eur',price_currency:'eur',price_amount:0})]){const f=fixture();mutate(f.products['paid-product']);const status=await f.service.status(owner,{country:'JP'});assert.equal(status.pricingUnavailable,true);assert.equal(status.plans.find(p=>p.id==='paid').price,null);await assert.rejects(f.service.checkout(owner,'paid'),{code:'billing_catalog_mismatch'});}});
test('configured foreign subscription amounts grant verified product capacity and do not reuse USD-only legacy prices',async()=>{const f=fixture();currencies(f);f.customer.active_subscriptions=[{id:'subscription'}];Object.assign(f.subscription,{product_id:'paid-product',currency:'jpy',amount:800});assert.equal((await f.service.reconcile(owner)).plan,'paid');assert.equal((await f.metadata.get(BILLING_STATE_KEY)).currency,'jpy');Object.assign(f.subscription,{amount:801});await assert.rejects(f.service.reconcile(owner),{code:'billing_provider_unavailable'});});

test('checkout permits provider-entered discounts while validating base price and returned discount/tax arithmetic',async()=>{const f=fixture(),create=f.client.checkouts.create;f.client.checkouts.create=async input=>({...await create(input),discount_amount:1,net_amount:499,total_amount:499});assert.equal((await f.service.checkout(owner,'paid')).url,'https://sandbox.polar.sh/checkout/test');for(const patch of [{amount:499},{discount_amount:501},{net_amount:498},{total_amount:498},{tax_amount:1},{allow_discount_codes:false}]){f.client.checkouts.create=async input=>({...await create(input),...patch});await assert.rejects(f.service.checkout(owner,'paid'),{code:'billing_checkout_mismatch'});}f.client.checkouts.create=async input=>({...await create(input),discount_amount:100,net_amount:350,total_amount:400,tax_amount:50,tax_behavior:'inclusive'});assert.equal((await f.service.checkout(owner,'paid')).url,'https://sandbox.polar.sh/checkout/test');});

test('signed unknown events are ignored only after dual-format Polar signature authentication',async()=>{const event={type:'subscription.future_unexpected',data:{},api_version:'2026-10',timestamp:new Date().toISOString()};assert.equal((await verifyPolarWebhook(eventRequest({event}),config)).ignored,true);const id='raw_utf8',time=Math.floor(Date.now()/1000),body=JSON.stringify(event),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']),signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(id+'.'+time+'.'+body))).toString('base64'),request=()=>new Request(config.APP_ORIGIN+'/api/billing/webhook',{method:'POST',body,headers:{'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':String(time),'webhook-signature':'v1,'+signature}});assert.equal((await verifyPolarWebhook(request(),config)).ignored,true);await assert.rejects(verifyPolarWebhook(eventRequest({event,headers:{'webhook-signature':'v1,invalid'}}),config),{code:'invalid_webhook_signature'});await assert.rejects(verifyPolarWebhook(eventRequest({event,date:new Date(Date.now()-600000)}),config),{code:'invalid_webhook_signature'});});
test('authenticated unrelated owners and organizations are ignored while relevant malformed envelopes fail',async()=>{for(const data of [{external_id:'outside-service'},{external_id:null},{external_id:owner,organization_id:'other'}]){assert.equal((await verifyPolarWebhook(eventRequest({event:{type:'customer.state_changed',timestamp:new Date().toISOString(),api_version:'2026-10',data}}),{...config,POLAR_ORGANIZATION_ID:'org'})).ignored,true);}await assert.rejects(verifyPolarWebhook(eventRequest({event:{type:'customer.state_changed',timestamp:'bad',api_version:'2026-10',data:{id:'customer',organization_id:'org',external_id:owner}}}),config),{code:'invalid_webhook'});});

test('paid signup binds checkout metadata and fixed console return, while mismatch cannot be trusted',async()=>{const f=fixture(),setup={incarnation:crypto.randomUUID(),requestId:crypto.randomUUID()},create=f.client.checkouts.create;f.client.checkouts.create=async input=>({...await create(input),metadata:input.metadata});await f.service.checkout(owner,'paid',{},setup);const request=f.calls.find(([kind])=>kind==='checkout')[1];assert.equal(request.external_customer_id,owner);assert.equal(request.success_url,config.APP_ORIGIN+'/console?setupBilling=1');assert.deepEqual(request.metadata,{bindle_setup_incarnation:setup.incarnation,bindle_setup_request:setup.requestId});const bad=fixture();await assert.rejects(bad.service.checkout(owner,'paid',{},setup),{code:'billing_checkout_mismatch'});});
