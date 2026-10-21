import test from 'node:test';
import assert from 'node:assert/strict';
import {busHarness,manifest,app,code} from './event-bus-fixture.mjs';
import {createScheduler,forEachSeed,tally,fakeClock} from './helpers/chaos.mjs';
import {OWNER} from './helpers/app-engine.mjs';
import {CreateView} from '../packages/app/domains/views.mjs';
import {BUS_LIMITS,memoryBusWaits,holdBusRead,publicRead} from '../packages/events/index.mjs';

const limits=overrides=>({...BUS_LIMITS,reads:{...BUS_LIMITS.reads,perSecond:1e6},...overrides});

test('one total order under concurrent publishers: contiguous seqs, per-publisher order kept, every reader sees the same order',async t=>{
 await forEachSeed(6,async random=>{
  const scheduler=createScheduler(random);
  const h=await busHarness(t,{seed:random.seed,wrap:{accountStore:store=>scheduler.wrap(store,'store')}}),bus=await h.create(),publishers=['p1','p2','p3'].map(name=>app(name)),readers=[app('r1'),app('r2')];
  for(const p of publishers)h.grants.allow(p.clientId,['publish']);const cursors=[];for(const r of readers){h.grants.allow(r.clientId,['read']);cursors.push((await h.read(r,bus.id,{})).cursor);}
  // Each publisher commits its own records in order; publishers race one another under seeded interleavings.
  const results=await scheduler.run(publishers.map(p=>async()=>{for(let i=0;i<4;i++)await h.publish(p,bus.id,'created',{task:`${p.clientId}#${i}`});}));
  assert.deepEqual(tally(results),{fulfilled:3});
  const views=await Promise.all(readers.map(async(r,i)=>(await h.read(r,bus.id,{cursor:cursors[i]})).records));
  assert.deepEqual(views[0].map(r=>r.seq),[...Array(12).keys()].map(i=>i+1),'seq is contiguous with no reuse');
  assert.deepEqual(views[0],views[1],'every reader sees the same order');
  for(const p of publishers)assert.deepEqual(views[0].filter(r=>r.publisher.client_id===p.clientId).map(r=>r.data.task),[0,1,2,3].map(i=>`${p.clientId}#${i}`));
 });
});

test('cursor semantics across retention gaps: time, record caps and purge are always reported; below the floor is not a gap',async t=>{
 const h=await busHarness(t,{limits:limits({maxRetainedRecords:5})}),bus=await h.create(),w=app('w'),r=app('r');
 h.grants.allow(w.clientId,['publish']);h.grants.allow(r.clientId,['read']);const start=await h.read(r,bus.id,{});
 for(let i=1;i<=3;i++)await h.publish(w,bus.id,'created',{task:'t'+i});
 const page=await h.read(r,bus.id,{cursor:start.cursor,limit:1});assert.deepEqual(page.records.map(x=>x.seq),[1]);
 for(let i=4;i<=8;i++)await h.publish(w,bus.id,'created',{task:'t'+i});// the cap of 5 ages 1-3 out first
 const capped=await h.read(r,bus.id,{cursor:page.cursor});
 assert.deepEqual([capped.gap,capped.records.map(x=>x.seq),capped.oldest,capped.head],[{from:2,to:3},[4,5,6,7,8],4,8]);
 // Time retention (604800 s here): records older than the effective retention leave without a sweep.
 await h.run('events.retention',{id:bus.id,input:{seconds:3600}});h.clock.advance(3601*1000);await h.publish(w,bus.id,'created',{task:'t9'});
 const aged=await h.read(r,bus.id,{cursor:page.cursor});assert.deepEqual([aged.gap,aged.records.map(x=>x.seq)],[{from:2,to:8},[9]]);
 const resumed=await h.read(r,bus.id,{cursor:capped.cursor});assert.deepEqual([resumed.gap,resumed.records.map(x=>x.seq)],[null,[9]],'a cursor at 8 lost nothing: the next record is 9');
 // A reader approved after the losses: its cursor never reports pre-floor loss as a gap.
 const late=app('late');h.grants.allow(late.clientId,['read']);const lateStart=await h.read(late,bus.id,{start:'oldest'});
 assert.deepEqual([lateStart.records.length,lateStart.gap,lateStart.head,lateStart.oldest],[0,null,null,null]);
 await h.run('events.purge',{id:bus.id});await h.publish(w,bus.id,'created',{task:'t10'});
 const afterPurge=await h.read(r,bus.id,{cursor:aged.cursor});assert.deepEqual([afterPurge.gap,afterPurge.records.map(x=>x.seq)],[null,[10]],'a cursor at 9 had already read the purged record');
 const missed=await h.read(r,bus.id,{cursor:capped.cursor});assert.deepEqual(missed.gap,{from:9,to:9},'the purged record is a reported gap');assert.deepEqual(missed.records.map(x=>x.seq),[10]);
 assert.deepEqual((await h.read(late,bus.id,{cursor:lateStart.cursor})).gap,null,'the late reader floor was 9, so the purge of 9 is below its floor');
 await h.system('events.sweep');assert.equal([...(await h.e.metadata.list({prefix:`evbus/rec/${bus.id}/`})).keys()].length,1);
});

test('revocation mid-read: a held long-poll resumes forbidden, rings the wait object and refunds the unused wait budget',async t=>{
 const clock=fakeClock(),waits=memoryBusWaits({clock}),h=await busHarness(t,{notifier:waits,clock}),bus=await h.create(),r=app('r'),w=app('w');
 h.grants.allow(r.clientId,['read']);h.grants.allow(w.clientId,['publish']);const start=await h.read(r,bus.id,{});
 const held=await h.read(r,bus.id,{cursor:start.cursor,wait:20},{hold:true});assert.ok(held.wait?.lease);assert.equal(held.records.length,0);
 assert.equal(publicRead(held).wait,undefined,'the lease and raw head never leave the host');
 const waiting=waits.wait({owner:OWNER,bus:bus.id,mark:held.wait.mark,until:held.wait.until});
 await h.system('events.reader-revoked',{input:{clientId:r.clientId}});h.grants.revoke(r.clientId);
 assert.deepEqual(await waiting,{reason:'revoked'});
 assert.equal(await code(h.read(r,bus.id,{cursor:start.cursor},{resume:held.wait.lease})),'forbidden','no record is returned after the revocation');
 const day=Math.floor(h.clock.now()/86400000);assert.equal(await h.e.metadata.get(`evbus/meter/${day}/wait`),0,'the lease was released and its unused seconds refunded');
 assert.equal([...(await h.e.metadata.list({prefix:'evbus/wait/'})).keys()].length,0);
 // Re-approval later starts a new floor; the old cursor does not resume.
 h.grants.allow(r.clientId,['read'],'e2');assert.equal(await code(h.read(r,bus.id,{cursor:start.cursor})),'invalid_args');
});

test('long-poll in the separate wait object: publish wakes the waiter, the edge recheck answers forbidden within the slice',async t=>{
 const clock=fakeClock(),waits=memoryBusWaits({clock}),h=await busHarness(t,{notifier:waits,clock}),bus=await h.create(),r=app('r'),w=app('w');
 h.grants.allow(r.clientId,['read']);h.grants.allow(w.clientId,['publish']);const start=await h.read(r,bus.id,{});
 const read=lease=>h.read(r,bus.id,{cursor:start.cursor,wait:10},lease?{resume:lease}:{hold:true});
 const begun=Date.now(),polling=holdBusRead({owner:OWNER,read,waits,clock:h.clock});
 setTimeout(()=>h.publish(w,bus.id,'created',{task:'woke'}),30);
 const result=await polling;assert.deepEqual(result.records.map(x=>x.data.task),['woke']);assert.ok(Date.now()-begun<3000,'woken by the publish, not by the timeout');
 // No revocation hook rang: the edge's own grant recheck between slices ends the wait and nothing is returned.
 const next=await h.read(r,bus.id,{cursor:result.cursor});let rechecks=0;
 const denied=holdBusRead({owner:OWNER,waits,clock:h.clock,revokeCheckMs:50,read:lease=>h.read(r,bus.id,{cursor:next.cursor,wait:10},lease?{resume:lease}:{hold:true}),
  recheck:async()=>{rechecks++;if(rechecks>=2){h.grants.revoke(r.clientId);throw Object.assign(new Error('revoked'),{code:'forbidden'});}}});
 const started=Date.now();assert.equal(await code(denied),'forbidden');assert.ok(Date.now()-started<2000);
 assert.equal([...(await h.e.metadata.list({prefix:'evbus/wait/'})).keys()].length,0,'the lease is always resumed and released');
 // Without the adapter (`hold` unset) a wait is served as 0: the account object never holds a request.
 h.grants.allow(r.clientId,['read'],'e1');const unheld=await h.read(r,bus.id,{cursor:next.cursor,wait:25});assert.equal(unheld.wait,undefined);
});

test('long-poll caps and the daily wait budget answer rate_limited with Retry-After instead of degrading to tight polling',async t=>{
 const h=await busHarness(t,{limits:limits({waits:{...BUS_LIMITS.waits,dailySeconds:60}})}),bus=await h.create(),readers=['a','b','c'].map(n=>app(n));
 const extra=manifest();extra.id+='/2';const bus2=await h.create(extra);
 for(const r of readers)h.grants.allow(r.clientId,['read']);
 const [a,b,c]=readers,first=await h.read(a,bus.id,{wait:15},{hold:true});assert.ok(first.wait);
 const again=await h.read(a,bus.id,{wait:15},{hold:true}).catch(error=>error);assert.deepEqual([again.code,again.retryAfter>=10],['rate_limited',true],'one wait per (grant, bus)');
 await h.read(a,bus2.id,{wait:15},{hold:true});await h.read(c,bus.id,{wait:25},{hold:true});
 const budget=await h.read(b,bus.id,{wait:25},{hold:true}).catch(error=>error);assert.deepEqual([budget.code,budget.retryAfter>=60],['rate_limited',true],'the daily wait-second budget is spent');
 await h.read(a,bus.id,{},{resume:first.wait.lease});assert.ok((await h.read(b,bus.id,{wait:15},{hold:true})).wait,'a released lease refunds unused seconds');
 const capped=await busHarness(t,{limits:limits({waits:{...BUS_LIMITS.waits,perAccount:1}})}),one=await capped.create(),x=app('x'),y=app('y');capped.grants.allow(x.clientId,['read']);capped.grants.allow(y.clientId,['read']);
 await capped.read(x,one.id,{wait:5},{hold:true});assert.equal(await code(capped.read(y,one.id,{wait:5},{hold:true})),'rate_limited');
});

test('quota exhaustion never blocks owner writes: a separate event allowance, publisher shares, readers never starve publishers',async t=>{
 // allowance 20: publisher share 10; charged empty reads: 5 for all readers, 2 per reader (EV2-S2).
 const h=await busHarness(t,{limits:limits({allowance:{free:20,paid:200},reads:{...BUS_LIMITS.reads,perSecond:1e6,freeEmptyPerDay:1}})}),bus=await h.create(),p=app('p'),q=app('q'),readers=['r1','r2','r3'].map(n=>app(n));
 for(const x of [p,q])h.grants.allow(x.clientId,['publish']);for(const r of readers)h.grants.allow(r.clientId,['read']);
 const results=[];for(let i=0;i<11;i++)results.push(await code(h.publish(p,bus.id,'created',{task:'p'+i})));
 assert.deepEqual(results.slice(9),['ok','rate_limited'],'one publisher gets at most half of the daily allowance');
 const share=await h.publish(p,bus.id,'created',{task:'px'}).catch(error=>error);assert.ok(share.retryAfter>0&&share.retryAfter<=86400);
 const [r1,r2,r3]=readers,empty=async r=>code(h.read(r,bus.id,{start:'latest'}));
 assert.deepEqual([await empty(r1),await empty(r1),await empty(r1),await empty(r1)],['ok','ok','ok','rate_limited'],'1 free empty read, then 2 charged, then this reader is refused');
 assert.deepEqual([await empty(r2),await empty(r2),await empty(r2),await empty(r3),await empty(r3),await empty(r3)],['ok','ok','ok','ok','ok','rate_limited'],'readers together draw at most 5 units');
 for(let i=0;i<10;i++)assert.equal(await code(h.publish(q,bus.id,'created',{task:'q'+i})),'ok','charged reads never consume what publishers need');
 assert.equal(await code(h.publish(q,bus.id,'created',{task:'q10'})),'rate_limited');
 assert.ok((await h.read(r1,bus.id,{start:'oldest'})).records.length>0,'non-empty reads stay free');
 // Owner writes are untouched: feed owner operations, and ordinary account writes through the same engine.
 await h.run('events.retention',{id:bus.id,input:{seconds:7200}});await h.run('events.purge',{id:bus.id});
 const view=await h.e.perform(new CreateView({actor:{kind:'owner',owner:OWNER},input:{name:'Work',filter:{version:1,tagsAll:['work']},operationId:crypto.randomUUID()}}));assert.ok(view.id);
 const keys=[...(await h.e.metadata.list({prefix:''})).keys()];assert.equal(keys.some(k=>k.startsWith('work/')||k.startsWith('storage-write')),false,'feeds never draw the owner storage-write or work meters');
 h.clock.advance(86400*1000);assert.equal(await code(h.publish(p,bus.id,'created',{task:'next day'})),'ok');
});

test('one app cannot spend the account wait budget: per-client daily share (EV2-S3)',async t=>{
 const h=await busHarness(t,{limits:limits({waits:{...BUS_LIMITS.waits,dailySeconds:100}})}),bus=await h.create(),a=app('a'),b=app('b');
 const extra=manifest();extra.id+='/2';const bus2=await h.create(extra);h.grants.allow(a.clientId,['read']);h.grants.allow(b.clientId,['read']);
 const one=await h.read(a,bus.id,{wait:25},{hold:true});const two=await h.read(a,bus2.id,{wait:25},{hold:true});
 h.clock.advance(25000);await h.read(a,bus.id,{},{resume:one.wait.lease});await h.read(a,bus2.id,{},{resume:two.wait.lease});
 assert.equal(await code(h.read(a,bus.id,{wait:1},{hold:true})),'rate_limited','a has spent its 50 s share');
 assert.ok((await h.read(b,bus.id,{wait:25},{hold:true})).wait,'b still waits');
});

test('publish rate windows: per publisher and per bus, Retry-After from the caller window only',async t=>{
 const h=await busHarness(t,{limits:limits({publishPerMinute:2,busPublishPerMinute:3})}),bus=await h.create(),p=app('p'),q=app('q');
 h.grants.allow(p.clientId,['publish']);h.grants.allow(q.clientId,['publish']);
 assert.deepEqual([await code(h.publish(p,bus.id,'created',{task:'1'})),await code(h.publish(p,bus.id,'created',{task:'2'})),await code(h.publish(p,bus.id,'created',{task:'3'}))],['ok','ok','rate_limited']);
 assert.equal(await code(h.publish(q,bus.id,'created',{task:'4'})),'ok');const shared=await h.publish(q,bus.id,'created',{task:'5'}).catch(error=>error);
 assert.equal(shared.code,'rate_limited');assert.ok(shared.retryAfter>=1&&shared.retryAfter<=60);
 h.clock.advance(60000);assert.equal(await code(h.publish(q,bus.id,'created',{task:'6'})),'ok');
});

test('reads are rate limited per grant across operations (2 per second)',async t=>{
 const h=await busHarness(t,{limits:BUS_LIMITS}),bus=await h.create(),r=app('r'),s=app('s');h.grants.allow(r.clientId,['read']);h.grants.allow(s.clientId,['read']);
 assert.deepEqual([await code(h.read(r,bus.id,{})),await code(h.read(r,bus.id,{})),await code(h.read(r,bus.id,{}))],['ok','ok','rate_limited']);
 assert.equal(await code(h.read(s,bus.id,{})),'ok','another reader has its own window');
 h.clock.advance(1000);assert.equal(await code(h.read(r,bus.id,{})),'ok');
});
