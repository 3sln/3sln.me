import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {AccountController,IdentityRepository} from '../packages/runtime/accounts.mjs';
import {PAID_LIFECYCLE_PROTECTION} from '../packages/identity/lifecycle-protection.mjs';
import {lifecycleIdentityPort,lifecycleAdminHoldPort} from '../packages/identity/lifecycle-tombstone.mjs';
import {LifecycleSweep} from '../packages/runtime/lifecycle-scheduler.mjs';
import {lifecycleMode} from '../packages/runtime/lifecycle-runner.mjs';
import {dispatchLifecycleNotice} from '../packages/messaging/dispatcher.mjs';

// Deterministic-clock integration of the lifecycle executor with the real
// portable AccountController, Node SQLite metadata and identity repository.
const DAY=86400000,HOUR=3600000,owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',handle='lifecycle_owner',email='owner@lifecycle.example';
const p256dh=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,7)]).toString('base64url'),auth=Buffer.alloc(16,9).toString('base64url');
const WARNING_SPACING=Math.floor(7*DAY/3),SUSPENDED_SPACING=10*DAY;

function memoryBucket(){
 let version=0;const map=new Map(),bucket={map,deleteFailures:0,writes:[],
  async get(key){const v=map.get(key);if(!v)return null;return {size:v.bytes.byteLength,etag:v.etag,storageClass:v.storageClass,httpMetadata:v.httpMetadata,arrayBuffer:async()=>v.bytes.slice().buffer,text:async()=>new TextDecoder().decode(v.bytes),json:async()=>JSON.parse(new TextDecoder().decode(v.bytes))};},
  async put(key,value,options={}){const old=map.get(key);if(options.onlyIf?.etagMatches&&old?.etag!==options.onlyIf.etagMatches)return null;const bytes=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);map.set(key,{bytes,etag:'e'+(++version),storageClass:options.storageClass??'Standard',httpMetadata:options.httpMetadata});bucket.writes.push({key,storageClass:options.storageClass??'Standard'});return {key};},
  async delete(keys){if(bucket.deleteFailures>0){bucket.deleteFailures--;throw new Error('provider unavailable');}for(const key of [keys].flat())map.delete(key);}};
 return bucket;
}

async function fixture(t,{mode='live',purge='true',cold='true',coldMin,push=true,mail=true,external=false,polar=null}={}){
 polar??=polarClient();// Never-paid by default; purge always needs this live lookup.
 let now=Date.now(),admin={held:false,since:null,releasedAt:null},mailFailure=null;
 const logs=[],mails=[],pushes=[],idDb=new SqliteMetadata(':memory:'),db=new SqliteMetadata(':memory:');t.after(()=>{db.close();idDb.close();});
 const repository=new IdentityRepository({metadata:idDb,config:{}});
 assert.equal(await repository.create({id:owner,handle,assignmentId:'assignment-1',status:'active',createdAt:now-1000,revision:1,verifiedEmail:email,emailVerifiedAt:now-1000,sessions:[],credentials:[],passwordHash:'secret-hash',recoveryHash:'recovery-hash',audit:[]}),true);
 await idDb.put(`email/${email}`,owner);
 const blobs=memoryBucket(),archives=memoryBucket();
 const config={APP_ORIGIN:'https://lifecycle.example',POLAR_SERVER:'sandbox',LIFECYCLE_ENABLED:mode==='off'?'false':'true',...mode==='live'?{LIFECYCLE_DRY_RUN:'false'}:{},LIFECYCLE_PURGE_ENABLED:purge,LIFECYCLE_COLD_STORAGE:cold,LIFECYCLE_COLD_STORAGE_SUPPORTED:true,...coldMin===undefined?{}:{LIFECYCLE_COLD_MIN_BYTES:coldMin},LIFECYCLE_FINANCE_REVIEW:polar?'polar':'local-only',...polar?{BILLING_ENABLED:'true',POLAR_CATALOG_MODE:'metadata',POLAR_ACCESS_TOKEN:'offline',POLAR_WEBHOOK_SECRET:'offline',POLAR_ORGANIZATION_ID:'org'}:{},
  LIFECYCLE_CLOCK:()=>now,LIFECYCLE_LOG:event=>logs.push(event),LIFECYCLE_IDENTITY:lifecycleIdentityPort(repository,{clock:()=>now}),
  LIFECYCLE_ADMIN_HOLD:async id=>{if(admin instanceof Error)throw admin;return {...admin,...(await lifecycleAdminHoldPort({store:null,repository})(id)).held?{held:true}:{}};},
  LIFECYCLE_MAIL:mail?{async sendAccountNotice(input){mails.push(input);if(mailFailure)throw Object.assign(new Error('Mail delivery is temporarily unavailable.'),{code:mailFailure});return {messageId:'mail-'+mails.length};}}:null,
  LIFECYCLE_PUSH:push?{async send(subscription,payload){pushes.push(payload);return {accepted:true};}}:null};
 const controller=new AccountController({metadata:db,gate:new SerialGate(),blobs,archives,config,sql:db.sql});if(polar)controller.billing.clientOverride=polar;
 await controller.warm(owner);await controller.rememberSignupOrigin(owner,{createdAt:now-1000});
 if(push)await controller.subscribe(owner,{subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/lifecycle',keys:{p256dh,auth}}});
 await db.put('resource/hosted-object',{owner,id:'res',provider:'hosted',builtin:true});
 await db.put('hosted-object/res/file',{key:'file',version:'v1',size:4,blobRef:`objects/${owner}/res/v1`});await blobs.put(`objects/${owner}/res/v1`,'data');
 await db.put('foreign-reference',{blobRef:'objects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/res/v1'});await blobs.put('objects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/res/v1','other');
 if(external)await db.put('resource/drive',{owner,id:'drive',provider:'google-drive'});
 const invoke=(method,...args)=>controller.invoke({method,args:[owner,...args]});
 const f={controller,db,idDb,repository,blobs,archives,logs,mails,pushes,invoke,
  get now(){return now;},advance:ms=>now+=ms,at:value=>now=value,admin:value=>admin=value,mailFailure:value=>mailFailure=value,
  tick:()=>controller.lifecycleTick(owner),status:()=>controller.lifecycleStatus(owner),
  touch:()=>invoke('touch'),notices:()=>mails.length};
 return f;
}
// Live alarms fire at least weekly; long waits tick in six-day chunks before the target, like the real scheduler.
async function jumpTo(f,target){while(target-f.now>6*DAY){f.advance(6*DAY);await f.tick();}f.at(target);}
const jump=(f,ms)=>jumpTo(f,f.now+ms);
// Runs the warning or suspended notice episode to its deadline: three spaced accepted attempts.
async function noticeEpisode(f,spacing){
 for(let i=0;i<2;i++){await jump(f,spacing);const result=await f.tick();assert.equal(result.action,'notice-recorded',JSON.stringify(result));assert.equal(result.outcome,'accepted');}
 const view=await f.status();assert.equal(view.deadlineDays>0,true);return view;
}
async function toSuspended(f){
 await f.touch();f.advance(2*DAY);const first=await f.tick();assert.equal(first.action,'notice-recorded');assert.equal((await f.status()).phase,'warning');
 await noticeEpisode(f,WARNING_SPACING);
 await jumpTo(f,(await f.controller.lifecycle.status(owner)).deadline);
 const suspended=await f.tick();assert.equal(suspended.phase,'suspended');return suspended;
}

test('new unused account: check-in after two days, warning, suspension, deletion warnings, then irreversible purge with a tombstoned handle',async t=>{
 const f=await fixture(t);
 assert.equal((await f.touch())?.$fault,undefined);
 f.advance(30*60000);await f.touch();assert.equal((await f.status()).phase,'active');
 f.advance(DAY);assert.equal((await f.tick()).action,'wait');assert.equal(f.notices(),0);
 f.advance(DAY);const warned=await f.tick();assert.equal(warned.action,'notice-recorded');
 assert.deepEqual(f.mails[0],{email,type:'suspension-warning',days:7,owner});
 assert.deepEqual(f.pushes[0],{type:'bindle-account-notice',owner,phase:'warning',days:7,path:`/console?account=${owner}&lifecycle=review`});
 await noticeEpisode(f,WARNING_SPACING);await jumpTo(f,(await f.controller.lifecycle.status(owner)).deadline-1);assert.equal((await f.tick()).action,'wait');
 f.advance(1);const suspended=await f.tick();assert.equal(suspended.phase,'suspended');
 // The first deletion warning goes out in the same tick as suspension.
 assert.equal(f.mails.at(-1).type,'deletion-warning');assert.equal(f.mails.at(-1).days,30);
 assert.equal((await f.invoke('snapshot')).$fault.code,'account_suspended');assert.equal((await f.invoke('snapshot')).$fault.status,423);
 assert.equal((await f.invoke('touch')).$fault.code,'account_suspended');
 assert.equal((await f.status()).reactivationRequired,true);
 // Below the cost threshold (default 4 MiB) the owned object stays Standard; reads are blocked by the fence.
 await f.tick();assert.equal(f.blobs.map.get(`objects/${owner}/res/v1`).storageClass,'Standard');assert.equal(f.blobs.map.get('objects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/res/v1').storageClass,'Standard');
 await noticeEpisode(f,SUSPENDED_SPACING);await jumpTo(f,(await f.controller.lifecycle.status(owner)).deadline);
 const review=await f.tick();assert.equal(review.phase,'purge-review');assert.equal(f.notices(),6);
 assert.equal((await f.invoke('snapshot')).$fault.code,'account_suspended');
 f.advance(60000);const deleted=await f.tick();assert.equal(deleted.action,'deleted');
 assert.equal(f.blobs.map.has(`objects/${owner}/res/v1`),false);assert.equal(f.blobs.map.has('objects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/res/v1'),true);
 assert.deepEqual([...(await f.db.list()).keys()].sort(),['lifecycle/tombstone-v1','owner']);
 const identity=await f.repository.get(owner);assert.equal(identity.status,'deleted');assert.equal(identity.handle,handle);assert.equal(identity.passwordHash,null);assert.equal(identity.recoveryHash,null);assert.equal(identity.verifiedEmail,undefined);
 assert.equal(await f.repository.findByEmail(email),null);assert.equal((await f.repository.findByHandle(handle)).id,owner);
 assert.equal(await f.repository.create({id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',handle,assignmentId:'a2',status:'active',createdAt:f.now,revision:1,sessions:[],credentials:[]}),false);
 assert.equal((await f.invoke('snapshot')).$fault.code,'account_deleted');assert.equal((await f.tick()).action,'deleted');assert.equal(f.notices(),6);
});

test('established account inactive for a year receives the same escalation; activity in the setup hour does not establish use',async t=>{
 const f=await fixture(t);await f.touch();f.advance(HOUR+1);await f.touch();
 f.advance(364*DAY);assert.equal((await f.tick()).action,'wait');assert.equal(f.notices(),0);
 f.advance(DAY);assert.equal((await f.tick()).action,'notice-recorded');assert.equal(f.mails[0].type,'suspension-warning');
 const g=await fixture(t);await g.touch();g.advance(10*60000);await g.touch();g.advance(2*DAY);assert.equal((await g.tick()).action,'notice-recorded');
});

test('paid or ever-paid accounts are exempt at every stage, including after suspension',async t=>{
 const f=await fixture(t);await f.db.put(PAID_LIFECYCLE_PROTECTION,{version:1,owner,firstVerifiedAt:f.now-1,origin:'https://lifecycle.example',server:'sandbox',source:'verified-paid-tier'});
 await f.touch();for(let i=0;i<5;i++){f.advance(400*DAY);assert.equal((await f.tick()).action,'paid-protected');}
 assert.equal(f.notices(),0);assert.equal(f.pushes.length,0);assert.equal((await f.invoke('snapshot')).$fault,undefined);
 const g=await fixture(t);await toSuspended(g);await g.db.put(PAID_LIFECYCLE_PROTECTION,{version:1,owner,firstVerifiedAt:g.now-1,origin:'https://lifecycle.example',server:'sandbox',source:'verified-paid-tier'});
 const result=await g.tick();assert.equal(result.action,'paid-protected');assert.equal(result.phase,'active');assert.equal((await g.invoke('snapshot')).$fault,undefined);
 // Billing reconciliation stays reachable while suspended so payment can lift it.
 const h=await fixture(t);await toSuspended(h);assert.notEqual((await h.invoke('billingStatus')).$fault?.code,'account_suspended');
});

test('administrator hold freezes notices, suspension and purge; release restarts a full year',async t=>{
 const f=await fixture(t);await f.touch();f.admin({held:true,since:f.now,releasedAt:null});
 for(let i=0;i<3;i++){f.advance(400*DAY);const held=await f.tick();assert.equal(held.action,'hold');assert.equal(held.reason,'admin-suspended');}
 assert.equal(f.notices(),0);
 f.admin({held:false,since:null,releasedAt:f.now});const resumed=await f.tick();assert.equal(resumed.phase,'active');assert.equal(resumed.nextWakeAt,f.now+365*DAY);
 f.admin(new Error('admin store down'));f.advance(400*DAY);assert.equal((await f.tick()).reason,'admin-status-unavailable');assert.equal(f.notices(),0);
 // An identity suspended by an administrator also holds, even without an admin store row.
 const g=await fixture(t);await g.touch();const account=await g.repository.get(owner);await g.repository.compareAndSwap(owner,account.revision,{...account,status:'suspended',revision:account.revision+1});g.advance(3*DAY);assert.equal((await g.tick()).reason,'admin-suspended');
 // A hold raised during purge stops further batches.
 const h=await fixture(t);await toSuspended(h);await noticeEpisode(h,SUSPENDED_SPACING);await jumpTo(h,(await h.controller.lifecycle.status(owner)).deadline);await h.tick();
 h.blobs.deleteFailures=1;h.advance(60000);await h.tick();h.admin({held:true,since:h.now,releasedAt:null});h.advance(60000);const frozen=await h.tick();assert.equal(frozen.action,'hold');assert.equal(h.blobs.map.has(`objects/${owner}/res/v1`),true);
 h.admin({held:false,since:null,releasedAt:h.now});h.advance(60000);assert.equal((await h.tick()).action,'deleted');
});

test('reactivation at each stage: activity cancels warning; recent sign-in reactivates suspended and purge-review; purging is irreversible',async t=>{
 const f=await fixture(t);await f.touch();f.advance(2*DAY);await f.tick();assert.equal((await f.status()).phase,'warning');
 f.advance(HOUR);await f.touch();assert.equal((await f.status()).phase,'active');
 const g=await fixture(t);await toSuspended(g);const session=at=>({kind:'owner-session',owner,authenticatedAt:at});
 assert.equal((await g.invoke('lifecycleReactivate',session(g.now-16*60000))).$fault.code,'reauthentication_required');
 assert.equal((await g.invoke('lifecycleReactivate',{...session(g.now),owner:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})).$fault.code,'reauthentication_required');
 const active=await g.invoke('lifecycleReactivate',session(g.now-60000));assert.equal(active.phase,'active');assert.equal((await g.invoke('snapshot')).$fault,undefined);
 assert.equal(await g.db.get('lifecycle/cold-v1'),undefined);
 const h=await fixture(t,{purge:'false'});await toSuspended(h);await noticeEpisode(h,SUSPENDED_SPACING);await jumpTo(h,(await h.controller.lifecycle.status(owner)).deadline);assert.equal((await h.tick()).phase,'purge-review');
 h.advance(DAY);assert.equal((await h.tick()).action,'deletion-review');assert.equal(h.blobs.map.has(`objects/${owner}/res/v1`),true);
 assert.equal((await h.invoke('lifecycleReactivate',session(h.now))).phase,'active');
 const k=await fixture(t);await toSuspended(k);await noticeEpisode(k,SUSPENDED_SPACING);await jumpTo(k,(await k.controller.lifecycle.status(owner)).deadline);await k.tick();k.blobs.deleteFailures=1;k.advance(60000);await k.tick();
 assert.equal((await k.controller.lifecycle.status(owner)).phase,'purging');assert.equal((await k.invoke('lifecycleReactivate',session(k.now))).$fault.code,'account_deleting');assert.equal((await k.invoke('billingCheckout',{})).$fault.code,'account_deleting');
});

test('crash and retry: interrupted purge resumes from its cursor and an unknown send never counts as notice',async t=>{
 const f=await fixture(t);await toSuspended(f);await noticeEpisode(f,SUSPENDED_SPACING);await jumpTo(f,(await f.controller.lifecycle.status(owner)).deadline);await f.tick();
 f.blobs.deleteFailures=1;f.advance(60000);const failed=await f.tick();assert.equal(failed.action,'error');assert.equal((await f.repository.get(owner)).status,'deleted');
 assert.equal((await f.db.get('lifecycle/purge-v1')).stage,'blobs');
 f.advance(60000);assert.equal((await f.tick()).action,'deleted');assert.equal(f.blobs.map.has(`objects/${owner}/res/v1`),false);
 // A thrown provider call is an unknown outcome: no deadline, spacing still applies, no burst retry.
 const g=await fixture(t,{push:false});await g.touch();g.advance(2*DAY);g.mailFailure('mail_delivery_unavailable');
 const unknown=await g.tick();assert.equal(unknown.outcome,'unknown');assert.equal((await g.status()).deadline,null);assert.equal((await g.tick()).action,'wait');assert.equal(g.notices(),1);
});

test('dry run plans actions without sending, fencing, tiering or changing phase',async t=>{
 const f=await fixture(t,{mode:'dry-run'});assert.equal(lifecycleMode({LIFECYCLE_ENABLED:'true'}),'dry-run');
 await f.touch();f.advance(3*DAY);const planned=await f.tick();assert.equal(planned.action,'planned');assert.equal(planned.planned,'notice');assert.equal(planned.deadlineDays,7);
 for(let i=0;i<5;i++){f.advance(30*DAY);assert.equal((await f.tick()).planned,'notice');}
 assert.equal(f.notices(),0);assert.equal(f.pushes.length,0);assert.equal((await f.status()).phase,'active');assert.equal((await f.invoke('snapshot')).$fault,undefined);
 assert.equal(f.blobs.writes.filter(w=>w.storageClass==='InfrequentAccess').length,0);
 assert(f.logs.some(e=>e.mode==='dry-run'&&e.planned==='notice'));assert(f.logs.every(e=>!JSON.stringify(e).includes(email)&&!JSON.stringify(e).includes('fcm.googleapis.com')));
 assert.equal((await f.invoke('lifecycleReactivate',{kind:'owner-session',owner,authenticatedAt:f.now})).$fault.code,'lifecycle_inactive');
 const off=await fixture(t,{mode:'off'});await off.touch();off.advance(800*DAY);assert.deepEqual(await off.tick(),{mode:'off'});assert.equal(off.notices(),0);assert.equal(await off.db.get('lifecycle/state-v1'),undefined);
});

test('notice delivery failures and suppression hold advancement; unreachable accounts are retained',async t=>{
 const f=await fixture(t,{push:false});await f.touch();f.advance(2*DAY);f.mailFailure('E_DELIVERY_FAILED');
 await f.tick();for(let i=0;i<2;i++){await jump(f,WARNING_SPACING);await f.tick();}assert.equal(f.notices(),3);
 await jump(f,100*DAY);const held=await f.tick();assert.equal(held.action,'hold');assert.equal((await f.status()).phase,'warning');assert.equal(f.notices(),3);
 const s=await fixture(t,{push:false});await s.touch();s.advance(2*DAY);s.mailFailure('E_RECIPIENT_SUPPRESSED');await s.tick();assert.equal((await s.status()).hold,'contact-suppressed');await jump(s,100*DAY);assert.equal((await s.tick()).action,'hold');assert.equal((await s.status()).phase,'warning');assert.equal(s.notices(),1);
 // Push still reaches the owner when email fails; acceptance by either channel counts.
 const p=await fixture(t);await p.touch();p.advance(2*DAY);p.mailFailure('E_DELIVERY_FAILED');assert.equal((await p.tick()).outcome,'accepted');
 const none=await fixture(t,{push:false,mail:false});await none.touch();none.advance(400*DAY);assert.equal((await none.tick()).reason,'contact-unavailable');
});

test('accounts with external connector resources are held at purge review; external data is never addressed',async t=>{
 const f=await fixture(t,{external:true});await toSuspended(f);await noticeEpisode(f,SUSPENDED_SPACING);await jumpTo(f,(await f.controller.lifecycle.status(owner)).deadline);await f.tick();
 f.advance(60000);const held=await f.tick();assert.equal(held.reason,'external-mapping-preservation-required');assert.equal((await f.repository.get(owner)).status,'active');assert.equal(f.blobs.map.has(`objects/${owner}/res/v1`),true);
});

test('lifecycle notice dispatch reports honest outcomes per channel',async()=>{
 const attemptId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 assert.deepEqual(await dispatchLifecycleNotice({owner,phase:'warning',days:0,attemptId,subscriptions:[]}),{outcome:'failed'});
 const gone={send:async()=>{throw Object.assign(new Error('gone'),{status:410});}},flaky={send:async()=>{throw Object.assign(new Error('x'),{status:503});}};
 assert.deepEqual(await dispatchLifecycleNotice({push:gone,owner,phase:'warning',days:3,attemptId,subscriptions:[{}]}),{outcome:'failed'});
 assert.deepEqual(await dispatchLifecycleNotice({push:flaky,owner,phase:'warning',days:3,attemptId,subscriptions:[{}]}),{outcome:'unknown'});
 const result=await dispatchLifecycleNotice({push:{send:async()=>({accepted:true})},mail:{sendAccountNotice:async input=>{assert.equal(input.days,1);return {messageId:'m1'};}},owner,phase:'suspended',days:0,attemptId,email,subscriptions:[{}]});
 assert.deepEqual(result,{accepted:true,receipt:'email:m1',channels:['push','email']});
 await assert.rejects(dispatchLifecycleNotice({owner,phase:'deleted',days:1,attemptId}),TypeError);
});

test('sweep is bounded, leased, resumable after a crash and arms accounts without traffic',async t=>{
 const db=new SqliteMetadata(':memory:');t.after(()=>db.close());const ids=Array.from({length:7},(_,i)=>`0000000${i}-0000-4000-8000-000000000000`),ticks=[];let fail=false;
 const repository={async lifecycleCandidates({cursor,limit}){const start=cursor?Number(cursor):0,slice=ids.slice(start,start+Math.min(limit,3));if(fail&&start>=3)throw new Error('shard unavailable');return {accounts:slice.map((id,i)=>({id,status:i===1?'pending':'active'})),cursor:start+slice.length<ids.length?String(start+slice.length):null};}};
 const accounts={get:id=>({invoke:async({method,args})=>{assert.equal(method,'lifecycleTick');assert.equal(args[0],id);ticks.push(id);return {mode:'live',action:'wait'};}})};
 assert.deepEqual(await new LifecycleSweep({metadata:db,repository,accounts,config:{}}).run(),{mode:'off'});
 const sweep=new LifecycleSweep({metadata:db,repository,accounts,config:{LIFECYCLE_ENABLED:'true',LIFECYCLE_SWEEP_BATCH:'4'}});
 fail=true;await assert.rejects(sweep.run());assert.equal((await sweep.status()).running,false);assert.equal((await db.get('lifecycle/sweep-v1')).cursor,'3');
 fail=false;const second=await sweep.run();assert.equal(second.complete,true);assert.equal((await db.get('lifecycle/sweep-v1')).passes,1);
 assert.equal(ticks.length,5);assert.equal(new Set(ticks).size,5);assert(await db.getAlarm());
 await db.put('lifecycle/sweep-v1',{...await db.get('lifecycle/sweep-v1'),lease:{id:'other',until:Date.now()+1000}});assert.equal((await sweep.run()).skipped,'running');
});

test('review follow-ups: an unenforced period restarts notices; tombstones hold in every mode; payment lifts suspension at once',async t=>{
 // Deadlines that elapsed while enforcement was not live never authorise deletion.
 const f=await fixture(t);await toSuspended(f);await noticeEpisode(f,SUSPENDED_SPACING);const sent=f.notices();
 f.controller.config.LIFECYCLE_DRY_RUN='true';assert.equal((await f.invoke('snapshot')).$fault,undefined);
 for(let i=0;i<45;i++){f.advance(DAY);await f.touch();}
 f.controller.config.LIFECYCLE_DRY_RUN='false';const resumed=await f.tick();assert.equal(resumed.phase,'suspended');assert(f.logs.some(e=>e.action==='restarted-after-gap'));
 assert.equal(f.notices(),sent+1);assert.equal(f.blobs.map.has(`objects/${owner}/res/v1`),true);assert.equal((await f.repository.get(owner)).status,'active');
 // After deletion, turning the flag off does not revive the account or its maintenance.
 const g=await fixture(t);await toSuspended(g);await noticeEpisode(g,SUSPENDED_SPACING);await jumpTo(g,(await g.controller.lifecycle.status(owner)).deadline);await g.tick();g.advance(60000);assert.equal((await g.tick()).action,'deleted');
 g.controller.config.LIFECYCLE_ENABLED='false';assert.equal((await g.invoke('touch')).$fault.code,'account_deleted');assert.equal((await g.invoke('receive',{})).$fault.code,'account_deleted');
 await g.controller.alarm();assert.deepEqual([...(await g.db.list()).keys()].sort(),['lifecycle/tombstone-v1','owner']);
 // A verified billing webhook reaches a suspended account, and recorded payment lifts the fence in the same request.
 const h=await fixture(t);await toSuspended(h);assert.notEqual((await h.invoke('billingWebhookVerified',{})).$fault?.code,'account_suspended');
 await h.db.put(PAID_LIFECYCLE_PROTECTION,{version:1,owner,firstVerifiedAt:h.now-1,origin:'https://lifecycle.example',server:'sandbox',source:'verified-paid-tier'});
 assert.equal((await h.invoke('snapshot')).$fault,undefined);assert.equal((await h.status()).phase,'active');
});

test('review follow-ups: accounts older than a day are armed as established; disabled deletion is never announced',async t=>{
 const f=await fixture(t);const account=await f.repository.get(owner);await f.repository.compareAndSwap(owner,account.revision,{...account,createdAt:f.now-10*DAY,revision:account.revision+1});
 await f.touch();await jump(f,3*DAY);assert.equal((await f.tick()).action,'wait');assert.equal(f.notices(),0);
 const g=await fixture(t,{purge:'false'});await toSuspended(g);
 assert.deepEqual(g.mails.at(-1),{email,type:'suspended-notice',owner});assert.equal(g.pushes.at(-1).deletion,false);assert(g.mails.every(m=>m.type!=='deletion-warning'));
 assert.equal((await g.status()).deletionScheduled,false);
});

// Fake Polar lists: any order or subscription for the external customer, with no product/status filter.
function polarClient(){const state={orders:[],subscriptions:[],down:false,queries:[]};const list=kind=>async query=>{state.queries.push([kind,query]);if(state.down)throw Object.assign(new Error('unavailable'),{statusCode:503});const items=state[kind].slice(0,query.limit);return {items,pagination:{total_count:state[kind].length,max_page:state[kind].length?Math.ceil(state[kind].length/query.limit):1}};};return {state,orders:{list:list('orders')},subscriptions:{list:list('subscriptions')}};}
const order=(status,product={id:'archived-product',is_archived:true})=>({id:'order-1',status,product,customer:{external_id:owner,organization_id:'org'}});

test('ever-paid: refunded, charged-back, archived-product and deleted-product payers are exempt via the live lookup',async t=>{
 for(const [label,item] of [['refund',order('refunded')],['partial refund',order('partially_refunded')],['chargeback',{...order('paid'),disputed:true}],['archived product',order('paid')],['product deleted',order('paid',null)]]){
  const polar=polarClient();polar.state.orders.push(item);const f=await fixture(t,{polar});await f.touch();await jump(f,3*DAY);
  const result=await f.tick();assert.equal(result.action,'paid-protected',label);assert.equal(f.notices(),0,label);
  const marker=await f.db.get('lifecycle/ever-paid-v1');assert.equal(marker.source,'api',label);assert.equal(marker.evidence,'order',label);
  for(const [,query]of polar.state.queries){assert.equal(query.external_customer_id,owner);assert.equal(query.status,undefined);assert.equal(query.product_id,undefined);}
  // Monotonic: the marker protects even when the provider later shows nothing or is down.
  polar.state.orders.length=0;polar.state.down=true;await jump(f,400*DAY);assert.equal((await f.tick()).action,'paid-protected',label);assert.equal(f.notices(),0,label);
 }
 const sub=polarClient();sub.state.subscriptions.push({id:'s1',status:'canceled',customer:{external_id:owner}});const g=await fixture(t,{polar:sub});await g.touch();await jump(g,3*DAY);assert.equal((await g.tick()).action,'paid-protected');assert.equal((await g.db.get('lifecycle/ever-paid-v1')).evidence,'subscription');
});

test('ever-paid: a webhook observation persists the marker for any product; a missed webhook is recovered by the API',async t=>{
 const polar=polarClient(),f=await fixture(t,{polar});await f.touch();
 const webhook=await f.invoke('billingWebhookVerified',{owner,type:'order.refunded',organizationId:'org',customerId:'c1',productId:'archived-product',relevant:false,id:'evt1',bodyHash:'a'.repeat(64),eventTimestamp:f.now});
 assert.equal(webhook.$fault,undefined);assert.equal((await f.db.get('lifecycle/ever-paid-v1')).source,'webhook');
 polar.state.down=true;await jump(f,3*DAY);assert.equal((await f.tick()).action,'paid-protected');assert.equal(f.notices(),0);
 assert.equal((await f.invoke('billingWebhookVerified',{owner,type:'customer.updated',customerEvent:true,productIds:[]})).$fault,undefined);
 // Missed webhook: the account reaches suspension while the provider has no record, then the API shows a payment.
 const missed=polarClient(),g=await fixture(t,{polar:missed});await toSuspended(g);assert.equal(await g.db.get('lifecycle/ever-paid-v1'),undefined);
 missed.state.orders.push(order('paid'));await jump(g,SUSPENDED_SPACING);const recovered=await g.tick();assert.equal(recovered.action,'paid-protected');assert.equal(recovered.phase,'active');
 assert.equal((await g.db.get('lifecycle/ever-paid-v1')).source,'api');assert.equal((await g.invoke('snapshot')).$fault,undefined);
});

test('ever-paid: purge requires a successful live lookup; provider outage or ambiguity holds and never deletes',async t=>{
 const polar=polarClient(),f=await fixture(t,{polar});await toSuspended(f);await noticeEpisode(f,SUSPENDED_SPACING);await jumpTo(f,(await f.controller.lifecycle.status(owner)).deadline);
 assert.equal((await f.tick()).phase,'purge-review');polar.state.down=true;
 for(let i=0;i<5;i++){f.advance(DAY);const held=await f.tick();assert.equal(held.action,'hold');}
 assert.equal((await f.repository.get(owner)).status,'active');assert.equal(f.blobs.map.has(`objects/${owner}/res/v1`),true);assert.equal(await f.db.get('lifecycle/purge-v1'),undefined);
 polar.state.down=false;polar.state.orders.push({id:'o',status:'paid',customer:{external_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}});f.advance(DAY);assert.equal((await f.tick()).action,'hold');assert.equal((await f.repository.get(owner)).status,'active');
 polar.state.orders.length=0;f.advance(DAY);assert.equal((await f.tick()).action,'deleted');
 // LIFECYCLE_FINANCE_REVIEW=local-only cannot bypass the live lookup once purge is enabled.
 const g=await fixture(t);g.controller.config.BILLING_ENABLED='false';g.controller.config.LIFECYCLE_FINANCE_REVIEW='local-only';await toSuspended(g).catch(()=>{});assert.equal((await g.status()).phase,'active');assert.equal(g.notices(),0);
});

test('cold tiering moves only objects above the cost threshold; smaller objects stay Standard behind the fence',async t=>{
 const f=await fixture(t);const big=`objects/${owner}/res/big`;await f.blobs.put(big,new Uint8Array(5*1048576));await f.db.put('hosted-object/res/big',{key:'big',version:'v2',size:5*1048576,blobRef:big});
 await toSuspended(f);await f.tick();assert.equal(f.blobs.map.get(big).storageClass,'InfrequentAccess');assert.equal(f.blobs.map.get(`objects/${owner}/res/v1`).storageClass,'Standard');
 assert.equal((await f.invoke('snapshot')).$fault.code,'account_suspended');
 const g=await fixture(t,{coldMin:'4'});await toSuspended(g);await g.tick();assert.equal(g.blobs.map.get(`objects/${owner}/res/v1`).storageClass,'InfrequentAccess');
});

test('ever-paid: webhook evidence is kept for non-active identities through the restricted lifecycle method',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.invoke('lifecycleEverPaid',{type:'customer.updated'}),{recorded:false});
 assert.deepEqual(await f.invoke('lifecycleEverPaid',{type:'order.paid'}),{recorded:true});assert.deepEqual(await f.invoke('lifecycleEverPaid',{type:'subscription.revoked'}),{recorded:false});
 assert.equal((await f.db.get('lifecycle/ever-paid-v1')).evidence,'order.paid');
 const g=await fixture(t);await toSuspended(g);assert.deepEqual(await g.invoke('lifecycleEverPaid',{type:'refund.created'}),{recorded:true});
});
