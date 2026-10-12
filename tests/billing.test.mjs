import test from 'node:test';
import assert from 'node:assert/strict';
import {Webhook} from 'standardwebhooks';
import {BillingService,verifyBillingCatalog,BILLING_PLANS,BILLING_STATE_KEY,entitlementFromState,verifyPolarWebhook,MAX_WEBHOOK_BYTES} from '../packages/billing/index.mjs';

const owner='aa111111-1111-4111-8111-111111111111',other='bb222222-2222-4222-8222-222222222222';
const secret='whsec_'+Buffer.alloc(32,39).toString('base64');
const config={BILLING_ENABLED:'true',POLAR_SERVER:'sandbox',POLAR_ACCESS_TOKEN:'offline-only',POLAR_WEBHOOK_SECRET:secret,POLAR_PRODUCT_ID_PLUS:'plus-product',POLAR_PRODUCT_ID_PRO:'pro-product',APP_ORIGIN:'https://3sln.example'};
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
  const products=Object.fromEntries(['plus','pro'].map(plan=>{const id=config[`POLAR_PRODUCT_ID_${plan.toUpperCase()}`];return [id,{id,is_archived:false,is_recurring:true,recurring_interval:'year',recurring_interval_count:1,organization_id:'org',prices:[{id:plan+'-price',product_id:id,source:'catalog',is_archived:false,amount_type:'fixed',price_currency:'usd',price_amount:BILLING_PLANS[plan].annualAmount}]}];}));
  const customer={id:'customer',external_id:owner,organization_id:'org',deleted_at:null,active_subscriptions:[]};
  const subscription={id:'subscription',customer_id:customer.id,customer:{...customer},product_id:config.POLAR_PRODUCT_ID_PRO,amount:3000,currency:'usd',recurring_interval:'year',recurring_interval_count:1,status:'active',current_period_start:new Date(now-1000).toISOString(),current_period_end:new Date(now+365*86400000).toISOString(),cancel_at_period_end:false,ended_at:null,ends_at:null};
  const client={products:{get:async id=>{calls.push(['product',id]);return structuredClone(products[id]);}},customers:{getStateExternal:async id=>{calls.push(['customer',id]);return structuredClone(customer);}},subscriptions:{get:async id=>{calls.push(['subscription',id]);return structuredClone(subscription);}},checkouts:{create:async body=>{calls.push(['checkout',body]);return {url:'https://sandbox.polar.sh/checkout/test'};}},customerSessions:{create:async body=>{calls.push(['portal',body]);return {customer_id:customer.id,customer:structuredClone(customer),customer_portal_url:'https://sandbox.polar.sh/test/portal'};}}};
  let clock=now;return {metadata,products,customer,subscription,client,calls,now,advance:ms=>clock+=ms,service:new BillingService({config,metadata,client,now:()=>clock})};
}
function eventRequest({event={type:'customer.state_changed',timestamp:new Date().toISOString(),api_version:'2026-10',data:{external_id:owner}},id='evt_test',date=new Date(),tamper,headers={}}={}){
  const body=JSON.stringify(event),signer=new Webhook(secret);
  return new Request('https://3sln.example/api/billing/webhook',{method:'POST',body:tamper??body,headers:{'content-type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(date.getTime()/1000)),'webhook-signature':signer.sign(id,date,body),...headers}});
}
test('plan quotas use decimal bytes and expired entitlements fall back to the 500 MB free plan',()=>{
  assert.deepEqual(Object.values(BILLING_PLANS).map(p=>[p.storageBytes,p.annualAmount]),[[500000000,0],[5000000000,500],[100000000000,3000]]);
  assert.equal(entitlementFromState({source:'polar',plan:'pro',validUntil:5},5).storageBytes,500000000);
  assert.equal(entitlementFromState({source:'browser',plan:'pro',validUntil:Infinity},0).plan,'free');
});
test('disabled or incomplete billing never invokes the provider',async()=>{
  const f=fixture(),service=new BillingService({config:{...config,BILLING_ENABLED:'false'},metadata:f.metadata,client:f.client});
  assert.equal((await service.status(owner)).enabled,false);
  await assert.rejects(service.checkout(owner,'plus'),{code:'billing_disabled'});
  await assert.rejects(verifyPolarWebhook(eventRequest(),{...config,POLAR_ACCESS_TOKEN:''}),{code:'billing_unconfigured'});
  assert.equal(f.calls.length,0);
});
test('explicit operator preflight verifies both products while app billing remains disabled and creates no effects',async()=>{
  const f=fixture(),settings={...config,BILLING_ENABLED:'false'};
  const result=await verifyBillingCatalog(settings,{client:f.client});assert.equal(settings.BILLING_ENABLED,'false');assert.equal(result.organizationId,'org');assert.deepEqual(result.plans.map(p=>p.annualAmount),[500,3000]);assert.deepEqual(f.calls,[['product','plus-product'],['product','pro-product']]);assert.equal(f.metadata.rows.size,0);
  await assert.rejects(verifyBillingCatalog({...settings,POLAR_ACCESS_TOKEN:''},{client:f.client}),{code:'billing_unconfigured'});
});
test('actual SDK verifies offline Standard Webhooks signatures, timestamp, exact body and API version',async()=>{
  const verified=await verifyPolarWebhook(eventRequest(),config);assert.equal(verified.owner,owner);assert.equal(verified.id,'evt_test');assert.match(verified.bodyHash,/^[a-f0-9]{64}$/);
  await assert.rejects(verifyPolarWebhook(eventRequest({tamper:'{}'}),config),{code:'invalid_webhook_signature'});
  await assert.rejects(verifyPolarWebhook(eventRequest({date:new Date(Date.now()-301000)}),config),{code:'invalid_webhook_signature'});
  await assert.rejects(verifyPolarWebhook(eventRequest({date:new Date(Date.now()+301000)}),config),{code:'invalid_webhook_signature'});
  await assert.rejects(verifyPolarWebhook(eventRequest({event:{type:'customer.state_changed',timestamp:new Date().toISOString(),api_version:'2026-04',data:{external_id:owner}}}),config),{code:'invalid_webhook'});
});
test('routing never falls back to customer metadata or email and rejects oversized raw streams',async()=>{
  await assert.rejects(verifyPolarWebhook(eventRequest({event:{type:'customer.state_changed',timestamp:new Date().toISOString(),api_version:'2026-10',data:{metadata:{owner},email:owner}}}),config),{code:'invalid_owner'});
  await assert.rejects(verifyPolarWebhook(eventRequest({tamper:' '.repeat(MAX_WEBHOOK_BYTES+1)}),config),{code:'webhook_too_large'});
  const subscriptionEvent={type:'subscription.updated',timestamp:new Date().toISOString(),api_version:'2026-10',data:{customer:{external_id:owner},metadata:{owner:other}}};
  assert.equal((await verifyPolarWebhook(eventRequest({event:subscriptionEvent}),config)).owner,owner);
});
test('catalog is checked against provider products before checkout and owner UUID is server supplied',async()=>{
  const f=fixture();await f.service.checkout(owner,'plus');
  const body=f.calls.find(([kind])=>kind==='checkout')[1];assert.deepEqual(body.products,['plus-product']);assert.equal(body.external_customer_id,owner);assert.equal(body.allow_trial,false);assert.equal(body.allow_discount_codes,false);assert.equal(body.success_url,'https://3sln.example/');
  assert(!Object.hasOwn(body,'customer_metadata'));assert.equal((await f.service.entitlement(owner)).plan,'free');
  const bad=fixture();bad.products['plus-product'].prices[0].price_amount=501;
  await assert.rejects(bad.service.checkout(owner,'plus'),{code:'billing_catalog_mismatch'});assert(!bad.calls.some(([kind])=>kind==='checkout'));
});
test('portal uses a verified provider customer and refuses mismatched external identity',async()=>{
  const f=fixture();assert.match((await f.service.portal(owner)).url,/^https:\/\/sandbox.polar.sh\//);assert.equal(f.calls.find(([kind])=>kind==='portal')[1].customer_id,'customer');
  f.customer.external_id=other;await assert.rejects(f.service.portal(owner),{code:'billing_customer_unavailable'});
  await assert.rejects(f.service.reconcile(owner),{code:'billing_provider_unavailable'});
});
test('checkout and portal reject unexpected hosted URLs and browser-derived return origins',async()=>{
  const f=fixture();f.client.checkouts.create=async()=>({url:'https://checkout.evil.example/'});
  await assert.rejects(f.service.checkout(owner,'plus'),{code:'billing_provider_unavailable'});
  f.client.customerSessions.create=async()=>({customer_id:f.customer.id,customer:f.customer,customer_portal_url:'https://sandbox.polar.sh.evil.example/portal'});
  await assert.rejects(f.service.portal(owner),{code:'billing_provider_unavailable'});
  const bad=new BillingService({config:{...config,APP_ORIGIN:'https://3sln.example/path'},metadata:f.metadata,client:f.client});
  await assert.rejects(bad.checkout(owner,'plus'),{code:'billing_unconfigured'});
});
test('signed notifications reconcile fresh provider state, replay idempotently and survive recreation',async()=>{
  const f=fixture();f.customer.active_subscriptions=[{id:f.subscription.id}];const verified=await verifyPolarWebhook(eventRequest(),config);
  assert.equal((await f.service.applyWebhook(verified)).plan,'pro');assert.equal((await f.metadata.get(BILLING_STATE_KEY)).owner,owner);
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
  assert.equal((await f.service.reconcile(owner)).plan,'pro');
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
