import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
import {SqliteMetadata,SerialGate} from '../../apps/node/resources.mjs';
import {AccountLifecycle} from '../../packages/runtime/account-lifecycle.mjs';

// Actual workerd + SQLite Durable Objects + R2. The Worker clock cannot be
// injected, so a valid suspended or purge-review lifecycle record is produced
// by the same model on a past clock and installed into the account object.
const DAY=86400000;
async function pastState(owner,origin,target){
 const metadata=new SqliteMetadata(':memory:');await metadata.put('owner',owner);let now=Date.now()-100*DAY;
 const model=new AccountLifecycle({metadata,gate:new SerialGate(),config:{APP_ORIGIN:origin,POLAR_SERVER:'sandbox',POLAR_CATALOG_MODE:'metadata',POLAR_ORGANIZATION_ID:'org'},clock:()=>now,protection:async()=>({status:'unpaid'}),contact:async()=>({verified:true,available:true,revision:'c1'}),reviewFinance:async args=>({...args,neverPaid:true,checkedAt:now,expiresAt:now+60000}),sendNotice:async args=>({accepted:true,receipt:'r-'+args.attemptId}),adminHold:async()=>({held:false,since:null,releasedAt:null})});
 await model.recordActivation(owner,{createdAt:now-1000,activatedAt:now});now+=3*DAY;
 const episode=async()=>{await model.step(owner);for(let i=0;i<2;i++){now+=model.spacing((await model.status(owner)).phase);await model.step(owner);}now=(await model.status(owner)).deadline;await model.step(owner);};
 await episode();if(target==='purge-review')await episode();
 const state=await metadata.get('lifecycle/state-v1');metadata.close();assert.equal(state.phase,target);return state;
}

test('Worker adapter: suspension fences HTTP APIs, restricted reactivation, cron sweep and irreversible purge with a tombstoned handle',async t=>{
 const polar=[];
 // Purge needs a successful live Polar ever-paid lookup; workerd's outbound fetch answers it with an empty history.
 const outboundService=async request=>{const url=new URL(request.url);polar.push(url.pathname+url.search);if(/^\/v1\/(?:orders|subscriptions)\/?$/.test(url.pathname))return Response.json({items:[],pagination:{total_count:0,max_page:1}});return new Response('{}',{status:404,headers:{'Content-Type':'application/json'}});};
 const h=await createHarness({outboundService,bindings:{LIFECYCLE_ENABLED:'true',LIFECYCLE_DRY_RUN:'false',LIFECYCLE_PURGE_ENABLED:'true',BILLING_ENABLED:'true',POLAR_SERVER:'sandbox',POLAR_CATALOG_MODE:'metadata',POLAR_ACCESS_TOKEN:'offline-test',POLAR_WEBHOOK_SECRET:'offline-test',POLAR_ORGANIZATION_ID:'org'}});t.after(()=>h.close());
 const {result,cookie}=await h.signup(),owner=result.account.id,handle=(await h.directory.get(owner)).handle;
 const headers={Cookie:cookie,'X-Bindle-Account':owner,'X-Bindle-Session-Context':result.sessionContext};
 const mutate={...headers,Origin:h.origin,'X-CSRF-Token':result.csrfToken};
 assert.equal((await h.request('/api/account',{headers})).status,200);
 const account=h.accounts.get(h.accounts.idFromName(owner));
 // The first authenticated use armed the inactivity clock in account-local storage.
 assert.equal((await (await h.request('/api/account/lifecycle',{headers})).json()).phase,'active');
 await account.seed(owner,[['lifecycle/state-v1',await pastState(owner,h.origin,'suspended')]]);
 const denied=await h.request('/api/account',{headers});assert.equal(denied.status,423);assert.equal((await denied.json()).error,'account_suspended');
 assert.equal((await h.request('/api/contacts',{method:'POST',value:{name:'x'},headers:mutate})).status,423);
 const status=await (await h.request('/api/account/lifecycle',{headers})).json();assert.equal(status.phase,'suspended');assert.equal(status.reactivationRequired,true);
 assert.equal((await h.request('/api/account/lifecycle/reactivate',{method:'POST',value:{},headers})).status,403);
 const reactivated=await h.request('/api/account/lifecycle/reactivate',{method:'POST',value:{},headers:mutate});assert.equal(reactivated.status,200);assert.equal((await reactivated.json()).phase,'active');
 assert.equal((await h.request('/api/account',{headers})).status,200);
 // The cron sweep runs in its own Durable Object over the real sharded identity directory.
 const scheduler=(await h.mf.getDurableObjectNamespace('LIFECYCLE_SCHEDULER')),sweep=await scheduler.get(scheduler.idFromName('lifecycle-sweep-v1')).run({trigger:'cron'});
 assert.equal(sweep.mode,'live');assert(sweep.processed>=1);
 // Final grace elapsed: purge removes hosted data and all account storage, keeps the handle forever.
 const blobs=await h.mf.getR2Bucket('BLOBS'),ref=`objects/${owner}/hosted/v1`;await blobs.put(ref,'hosted bytes');
 await account.seed(owner,[['lifecycle/state-v1',await pastState(owner,h.origin,'purge-review')],['hosted-object/file',{key:'file',version:'v1',blobRef:ref}],['lifecycle/live-v1',{at:Date.now()}]]);
 const deleted=await account.lifecycleTick(owner,{source:'test'});assert.equal(deleted.action,'deleted');
 assert(polar.some(path=>path.startsWith('/v1/orders')&&path.includes('external_customer_id='+owner)&&!path.includes('status=')&&!path.includes('product_id=')));
 assert.equal(await blobs.get(ref),null);
 assert.deepEqual((await account.rows()).map(([key])=>key).sort(),['lifecycle/tombstone-v1','owner']);
 const identity=await h.directory.get(owner);assert.equal(identity.status,'deleted');assert.equal(identity.handle,handle);assert.deepEqual(identity.sessions,[]);
 assert.equal((await h.directory.findByHandle(handle)).id,owner);
 assert.equal((await h.request('/api/account',{headers})).status,401);
 const again=await h.request('/api/auth/login/password',{method:'POST',value:{handle,password:'isolated test account password',turnstileToken:'local-browser-test-token'},headers:{Origin:h.origin}});assert.equal(again.status,401);
});
