import test from 'node:test';
import assert from 'node:assert/strict';
import {BillingService,PAID_HANDLE_MARKER_PREFIX} from '../packages/billing/service.mjs';
import {BILLING_PLANS,BILLING_STATE_KEY} from '../packages/billing/catalog.mjs';
import {SqliteMetadata} from '../apps/node/resources.mjs';
const owner='aa111111-1111-4111-8111-111111111111';
const config={BILLING_ENABLED:'true',POLAR_SERVER:'sandbox',POLAR_ACCESS_TOKEN:'offline-token',POLAR_WEBHOOK_SECRET:'offline-secret',POLAR_PRODUCT_ID_PLUS:'plus-product',POLAR_PRODUCT_ID_PRO:'pro-product',APP_ORIGIN:'https://billing.example'};
const markerKey=PAID_HANDLE_MARKER_PREFIX+'sandbox/'+owner;
function fixture(){
 const metadata=new SqliteMetadata(':memory:'),calls=[];
 const products=Object.fromEntries(['plus','pro'].map(plan=>{const id=config[`POLAR_PRODUCT_ID_${plan.toUpperCase()}`];return[id,{id,is_archived:false,is_recurring:true,recurring_interval:'year',recurring_interval_count:1,organization_id:'org',prices:[{id:plan+'-price',product_id:id,source:'catalog',is_archived:false,amount_type:'fixed',price_currency:'usd',price_amount:BILLING_PLANS[plan].annualAmount}]}];}));
 const customer={id:'customer',external_id:owner,organization_id:'org',deleted_at:null,active_subscriptions:[]};
 const order={id:'order',created_at:'2020-01-01T00:00:00Z',paid:true,status:'paid',currency:'usd',net_amount:500,total_amount:550,refunded_amount:0,customer_id:'customer',customer:{...customer},product_id:'plus-product',product:{id:'plus-product',organization_id:'org',is_recurring:true,recurring_interval:'year',recurring_interval_count:1},subscription_id:'subscription',subscription:{id:'subscription',customer_id:'customer',product_id:'plus-product',currency:'usd',amount:500,recurring_interval:'year',recurring_interval_count:1,status:'canceled'}};
 const pages=[{items:[order],pagination:{total_count:1,max_page:1}}];
 const client={products:{get:async id=>{calls.push(['product',id]);return structuredClone(products[id]);}},orders:{list:async query=>{calls.push(['orders',query]);return structuredClone(pages[query.page-1]);}},customers:{getStateExternal:async()=>structuredClone(customer)},subscriptions:{get:async()=>{throw new Error('No active subscriptions should be inspected.');}}};
 const service=new BillingService({metadata,client,config,now:()=>123456});
 return{metadata,calls,order,pages,products,client,service,close:()=>metadata.close()};
}
test('actual historical paid order grants immutable eligibility after cancellation and survives service restart',async()=>{
 const f=fixture();try{
  assert.equal((await f.service.status(owner)).paidHandleEligible,false);assert.equal(f.calls.length,0);
  assert.equal(await f.service.paidHandleEligibility(owner),true);
  assert.deepEqual(f.calls.find(([kind])=>kind==='orders')[1],{external_customer_id:owner,organization_id:'org',product_id:['plus-product','pro-product'],status:'paid',limit:100,page:1});
  const marker=await f.metadata.get(markerKey);assert.equal(marker.source,'polar');assert.equal(marker.orderId,'order');
  await f.service.reconcile(owner);assert.equal((await f.service.entitlement(owner)).plan,'free');
  const afterReconcile=f.calls.length;
  f.client.orders.list=async()=>{throw new Error('must use retained marker');};
  const restarted=new BillingService({metadata:f.metadata,client:f.client,config,now:()=>999999999});
  assert.equal(await restarted.paidHandleEligibility(owner),true);assert.equal((await restarted.status(owner)).paidHandleEligible,true);
  assert.equal(f.calls.length,afterReconcile);assert.deepEqual(await f.metadata.get(markerKey),marker);
 }finally{f.close();}
});
test('active plan fixtures, unpaid zero-value discounted refunded and wrong-currency orders cannot create eligibility',async()=>{
 for(const patch of [{paid:false},{status:'pending'},{net_amount:0},{net_amount:499},{refunded_amount:1},{currency:'eur'},{total_amount:499}]){
  const f=fixture();try{
   await f.metadata.put(BILLING_STATE_KEY,{owner,source:'polar',plan:'pro',validUntil:999999999,status:'active'});
   Object.assign(f.order,patch);assert.equal(await f.service.paidHandleEligibility(owner),false);assert.equal(await f.metadata.get(markerKey),undefined);
   assert.equal((await f.service.status(owner)).paidHandleEligible,false);
  }finally{f.close();}
 }
});
test('identity product organization and subscription mismatches or malformed fields fail closed',async()=>{
 const patches=[o=>o.customer.external_id='another',o=>o.customer.id='another',o=>o.customer.organization_id='another',o=>o.product.organization_id='another',o=>o.product_id='other-product',o=>o.subscription.id='another',o=>o.subscription.customer_id='another',o=>o.subscription.product_id='another',o=>o.subscription.recurring_interval='month',o=>o.subscription.amount=300,o=>delete o.refunded_amount,o=>o.net_amount='500',o=>o.subscription=null,o=>o.created_at='invalid',o=>o.status='open'];
 for(const patch of patches){const f=fixture();try{patch(f.order);await assert.rejects(f.service.paidHandleEligibility(owner),{code:'billing_provider_unavailable'});assert.equal(await f.metadata.get(markerKey),undefined);}finally{f.close();}}
});
test('bounded history checks a second page and never interprets truncated or malformed history as unpaid',async()=>{
 const f=fixture();try{
  f.pages[0]={items:Array.from({length:100},(_,i)=>({...structuredClone(f.order),id:'first-'+i,net_amount:0})),pagination:{total_count:101,max_page:2}};
  f.pages[1]={items:[f.order],pagination:{total_count:101,max_page:2}};
  assert.equal(await f.service.paidHandleEligibility(owner),true);assert.equal(f.calls.filter(([kind])=>kind==='orders').length,2);
 }finally{f.close();}
 const truncated=fixture();try{
  truncated.pages[0]={items:Array.from({length:100},(_,i)=>({...structuredClone(truncated.order),id:'first-'+i,net_amount:0})),pagination:{total_count:201,max_page:3}};
  truncated.pages[1]={items:Array.from({length:100},(_,i)=>({...structuredClone(truncated.order),id:'second-'+i,net_amount:0})),pagination:{total_count:201,max_page:3}};
  await assert.rejects(truncated.service.paidHandleEligibility(owner),{code:'billing_order_capacity'});assert.equal(truncated.calls.filter(([kind])=>kind==='orders').length,2);
 }finally{truncated.close();}
 for(const page of [{items:[],pagination:{total_count:1,max_page:1}},{items:[],pagination:{total_count:0,max_page:2}},{items:[],pagination:{total_count:Infinity,max_page:1}}]){const malformed=fixture();try{malformed.pages[0]=page;await assert.rejects(malformed.service.paidHandleEligibility(owner),{code:'billing_provider_unavailable'});}finally{malformed.close();}}
});
test('wrong server or owner markers cannot grant eligibility and provider failure does not create a marker',async()=>{
 const f=fixture();try{
  assert.equal(await f.service.paidHandleEligibility(owner),true);
  const production=new BillingService({metadata:f.metadata,client:f.client,config:{...config,POLAR_SERVER:'production'}});
  assert.equal((await production.status(owner)).paidHandleEligible,false);
  f.client.orders.list=async()=>{throw new Error('offline');};await assert.rejects(production.paidHandleEligibility(owner),{code:'billing_provider_unavailable'});
  assert.equal(await f.metadata.get(PAID_HANDLE_MARKER_PREFIX+'production/'+owner),undefined);
  const forged={...await f.metadata.get(markerKey),owner:'bb222222-2222-4222-8222-222222222222'};await f.metadata.put(markerKey,forged);
  assert.equal((await f.service.status(owner)).paidHandleEligible,false);await assert.rejects(f.service.paidHandleEligibility(owner),{code:'billing_provider_unavailable'});
 }finally{f.close();}
});
test('concurrent verifications retain the first verified immutable payment marker',async()=>{
 const f=fixture();try{
  const second=new BillingService({metadata:f.metadata,client:f.client,config,now:()=>987654});
  assert.deepEqual(await Promise.all([f.service.paidHandleEligibility(owner),second.paidHandleEligibility(owner)]),[true,true]);
  const marker=await f.metadata.get(markerKey);assert([123456,987654].includes(marker.verifiedAt));
  assert.equal(await second.paidHandleEligibility(owner),true);assert.deepEqual(await f.metadata.get(markerKey),marker);
 }finally{f.close();}
});

test('verified past payment survives billing disablement and later catalog rotation without provider reads',async()=>{
 const f=fixture();try{
  assert.equal(await f.service.paidHandleEligibility(owner),true);
  const marker=await f.metadata.get(markerKey),count=f.calls.length;
  const disabled=new BillingService({metadata:f.metadata,client:f.client,config:{...config,BILLING_ENABLED:'false',POLAR_ACCESS_TOKEN:'',POLAR_PRODUCT_ID_PLUS:'replacement-plus',POLAR_PRODUCT_ID_PRO:'replacement-pro'}});
  assert.equal(await disabled.paidHandleEligibility(owner),true);
  assert.equal((await disabled.status(owner)).paidHandleEligible,true);
  assert.equal(f.calls.length,count);assert.deepEqual(await f.metadata.get(markerKey),marker);
  const fresh='bb222222-2222-4222-8222-222222222222';
  await assert.rejects(disabled.paidHandleEligibility(fresh),{code:'billing_disabled'});assert.equal(f.calls.length,count);
 }finally{f.close();}
});
