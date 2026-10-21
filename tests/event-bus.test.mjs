import test from 'node:test';
import assert from 'node:assert/strict';
import {busHarness,manifest,url,app,code,ISSUER} from './event-bus-fixture.mjs';
import {OWNER} from './helpers/app-engine.mjs';
import {EventBuses,PublishEvent} from '../packages/app/domains/events.mjs';
import {readProblems,publishProblems,createBusReader,EVENT_BUS_CONTRACT} from '../packages/events/index.mjs';
import {eventBusResourceMethod} from '../packages/runtime/account/events.mjs';
import {ACCOUNT_OPERATIONS} from '../packages/app/operations.mjs';

test('EV-2 flag off: every bus operation is not_found and nothing is owner-dispatchable through the account registry',async t=>{
 const h=await busHarness(t,{enabled:false});
 assert.equal(await code(h.e.read(new EventBuses({actor:{kind:'owner',owner:OWNER}}))),'not_found');
 assert.equal(await code(h.e.perform(new PublishEvent({actor:app(),id:crypto.randomUUID(),input:{type:'created',data:{task:'t'}},tx:crypto.randomUUID()}))),'not_found');
 assert.equal(Object.keys(ACCOUNT_OPERATIONS).some(name=>name.startsWith('events.')),false);
 assert.equal(await code(eventBusResourceMethod({config:{EVENT_BUSES_ENABLED:'false'}},OWNER,{contract:EVENT_BUS_CONTRACT,method:'read'})),'not_found');
});

test('built-in occupant: created once per manifest by the owner, EV-1 re-validated, plan bus and retention limits',async t=>{
 const h=await busHarness(t);const bus=await h.create();
 assert.equal(bus.retention.seconds,604800);assert.match(bus.digest,/^sha256-/);
 assert.deepEqual((await h.run('events.create',{input:{url,manifest:manifest()}})).created,false,'one bus per (account, manifest)');
 const bad=manifest();bad.slot.bus.payload.properties.task.pattern='^(a+)+$';
 assert.equal(await code(h.run('events.create',{input:{url:url+'x',manifest:{...bad,id:url+'x'}}})),'invalid_bus');
 const long=manifest({retention:{min_seconds:8*86400,max_seconds:30*86400}});long.id=url+'/long';
 assert.equal(await code(h.run('events.create',{input:{url:long.id,manifest:long}})),'retention_unavailable','Free keeps at most 7 days, so a 8-day minimum cannot be hosted');
 for(let i=0;i<7;i++){const m=manifest();m.id=`${url}/${i}`;await h.run('events.create',{input:{url:m.id,manifest:m}});}
 const ninth=manifest();ninth.id=url+'/9';assert.equal(await code(h.run('events.create',{input:{url:ninth.id,manifest:ninth}})),'bus_limit');
 assert.equal((await h.run('events.buses')).length,8);
 const paid=await busHarness(t,{plan:'paid'});const longBus=await paid.create(long);assert.equal(longBus.retention.seconds,30*86400);
 assert.equal(await code(h.run('events.retention',{id:bus.id,input:{seconds:60}})),'invalid_request');
 assert.equal((await h.run('events.retention',{id:bus.id,input:{seconds:7200}})).retention.seconds,7200);
});

test('publish: host-stamped producer, attested_by, opaque receipts, journal dedup and tx_conflict',async t=>{
 const h=await busHarness(t),bus=await h.create(),a=app('tasks'),b=app('other');
 h.grants.allow(a.clientId,['publish','read']);h.grants.allow(b.clientId,['read']);
 await h.read(b,bus.id,{});// floor set at approval-equivalent first contact (head 0)
 const tx=crypto.randomUUID(),first=await h.publish(a,bus.id,'created',{task:'t1',title:'File taxes'},tx);
 assert.deepEqual(publishProblems(first),[]);assert.notEqual(first.receipt,'1');
 assert.deepEqual(await h.publish(a,bus.id,'created',{task:'t1',title:'File taxes'},tx),first,'same tx and arguments return the original result');
 assert.equal(await code(h.publish(a,bus.id,'created',{task:'t2'},tx)),'tx_conflict');
 const second=await h.publish(a,bus.id,'completed',{task:'t1'});assert.notEqual(second.receipt,first.receipt);
 // A payload cannot name its producer: the manifest forbids unknown members and the envelope is host-stamped.
 assert.equal(await code(h.publish(a,bus.id,'created',{task:'t3',publisher:{kind:'provider',feature:'x'}})),'invalid_args');
 const page=await h.read(b,bus.id,{start:'oldest'});assert.deepEqual(readProblems(page,{floorSeq:0}),[]);
 assert.deepEqual(page.records.map(r=>[r.seq,r.type]),[[1,'created'],[2,'completed']]);
 assert.deepEqual(page.records[0].publisher,{kind:'application',client_id:a.clientId,origin:a.origin});assert.equal(page.records[0].attested_by,ISSUER);
 assert.equal(page.head,2);assert.equal(page.oldest,1);assert.equal(page.gap,null);
});

test('schema rejection stores nothing: types, members, bounds, formats, sizes and argument shape',async t=>{
 const h=await busHarness(t),small=manifest({max_record_bytes:100}),bus=await h.create(small),a=app();h.grants.allow(a.clientId,['publish','read']);
 for(const [type,data]of [['deleted',{task:'t'}],['created',{}],['created',{task:'t',extra:1}],['created',{task:7}],['created',{task:'x'.repeat(129)}],['created',{task:'t',n:-1}],['created',{task:'t',n:2**53}],['created',{task:'t',n:1.5}],
  ['created',{task:'t',link:'http://tasks.example/x'}],['created',{task:'t',at:'yesterday'}],['created',{task:'t',tags:['a','b','c','d']}],['created',{task:'t',title:'y'.repeat(100)}],['created',null],['created',['t']]])
  assert.equal(await code(h.publish(a,bus.id,type,data)),'invalid_args',JSON.stringify([type,data]));
 assert.equal(await code(h.e.perform(new PublishEvent({actor:a,id:bus.id,input:{type:'created',data:{task:'t'},extra:true},tx:crypto.randomUUID()}))),'invalid_args');
 assert.equal(await code(h.e.perform(new PublishEvent({actor:a,id:bus.id,input:{type:'created',data:{task:'t'}}}))),'invalid_args','a transaction id is required');
 const valid=await h.publish(a,bus.id,'created',{task:'t',n:3,at:'2026-10-20T10:00:00Z',link:'https://x.example/a'});assert.ok(valid.receipt);
 assert.equal((await h.run('events.bus',{id:bus.id})).head,1,'only the valid record was stored');
});

test('grants are fragment methods checked live: write-only reads nothing, read-only cannot publish, revocation mid-stream',async t=>{
 const h=await busHarness(t),bus=await h.create(),writer=app('writer'),reader=app('reader');
 h.grants.allow(writer.clientId,['publish']);h.grants.allow(reader.clientId,['read']);
 const start=await h.read(reader,bus.id,{});await h.publish(writer,bus.id,'created',{task:'t1'});
 assert.equal(await code(h.read(writer,bus.id,{})),'forbidden','a publish-only grant never reads records, heads or cursors');
 assert.equal(await code(h.publish(reader,bus.id,'created',{task:'t'})),'forbidden');
 assert.equal((await h.read(reader,bus.id,{cursor:start.cursor})).records.length,1);
 h.grants.revoke(reader.clientId);assert.equal(await code(h.read(reader,bus.id,{cursor:start.cursor})),'forbidden');
 h.grants.revoke(writer.clientId);assert.equal(await code(h.publish(writer,bus.id,'created',{task:'t2'})),'forbidden');
 const appOnlyReaders=await busHarness(t),noApps=await appOnlyReaders.create(manifest({publishers:['provider']}));appOnlyReaders.grants.allow(writer.clientId,['publish']);
 assert.equal(await code(appOnlyReaders.publish(writer,noApps.id,'created',{task:'t'})),'forbidden','the manifest excludes application publishers');
 assert.equal(await code(h.read({...reader,connection:{id:'x',generation:1.5}},bus.id,{})),'unauthorized');
});

test('reader floors: new readers start at approval, head/oldest/gap clipped, history only by owner opt-in before the floor',async t=>{
 const h=await busHarness(t),bus=await h.create(),writer=app('writer'),late=app('late'),historic=app('historic');
 h.grants.allow(writer.clientId,['publish']);for(let i=1;i<=3;i++)await h.publish(writer,bus.id,'created',{task:'t'+i});
 h.grants.allow(late.clientId,['read']);
 const first=await h.read(late,bus.id,{start:'oldest'});assert.deepEqual([first.records.length,first.head,first.oldest,first.gap],[0,null,null,null],'nothing before the floor is revealed');
 await h.run('events.history',{id:bus.id,input:{clientId:historic.clientId}});h.grants.allow(historic.clientId,['read']);
 assert.deepEqual((await h.read(historic,bus.id,{start:'oldest'})).records.map(r=>r.seq),[1,2,3]);
 assert.equal(await code(h.run('events.history',{id:bus.id,input:{clientId:late.clientId}})),'reader_floor_set','an existing floor is never lowered');
 await h.publish(writer,bus.id,'created',{task:'t4'});const next=await h.read(late,bus.id,{cursor:first.cursor});
 assert.deepEqual([next.records.map(r=>r.seq),next.head,next.oldest],[[4],4,4]);
 const never=await busHarness(t),closed=await never.create(manifest({history:'never'}));
 assert.equal(await code(never.run('events.history',{id:closed.id,input:{clientId:late.clientId}})),'history_unavailable');
 // The consent hook sets the floor at approval time, before the first read; the same epoch never moves it.
 const approved=app('approved');await h.system('events.reader-approved',{id:bus.id,input:{clientId:approved.clientId,epoch:'e1'}});
 await h.publish(writer,bus.id,'created',{task:'t5'});h.grants.allow(approved.clientId,['read']);
 assert.deepEqual((await h.read(approved,bus.id,{start:'oldest'})).records.map(r=>r.seq),[5]);
 assert.deepEqual(await h.system('events.reader-approved',{id:bus.id,input:{clientId:approved.clientId,epoch:'e1'}}),{floor:'kept'});
});

test('cursors bind bus, client, floor and nonce: foreign, forged and re-approved cursors fail without revealing anything',async t=>{
 const h=await busHarness(t),bus=await h.create(),a=app('a'),b=app('b');h.grants.allow(a.clientId,['read']);h.grants.allow(b.clientId,['read']);
 const page=await h.read(a,bus.id,{});await h.read(b,bus.id,{});
 assert.equal(await code(h.read(b,bus.id,{cursor:page.cursor})),'invalid_args','another client');
 const [payload,mac]=page.cursor.split('.'),tampered=Buffer.from(JSON.stringify([1,'x',0,'y',0])).toString('base64url')+'.'+mac;
 for(const cursor of [tampered,payload+'.'+'A'.repeat(43),'x'.repeat(600),'',42])assert.equal(await code(h.read(a,bus.id,{cursor})),'invalid_args');
 const other=manifest();other.id=url+'/other';const second=await h.create(other);assert.equal(await code(h.read(a,second.id,{cursor:page.cursor})),'invalid_args','another bus');
 // Widening (same epoch) keeps the cursor; revocation and re-approval (new epoch) set a new floor and invalidate it.
 h.grants.allow(a.clientId,['read','publish'],'e1');assert.equal((await h.read(a,bus.id,{cursor:page.cursor})).records.length,0);
 h.grants.revoke(a.clientId);h.grants.allow(a.clientId,['read'],'e2');assert.equal(await code(h.read(a,bus.id,{cursor:page.cursor})),'invalid_args');
 assert.equal(await code(h.read(a,bus.id,{cursor:page.cursor,start:'oldest'})),'invalid_args');
 assert.equal(await code(h.read(a,bus.id,{limit:101})),'invalid_args');assert.equal(await code(h.read(a,bus.id,{wait:26})),'invalid_args');
});

test('provider features publish and read only when the owner enabled them; owner purge and delete',async t=>{
 const h=await busHarness(t),bus=await h.create(),feature={kind:'feature',owner:OWNER,feature:'classifier'},reader=app('reader');
 assert.equal(await code(h.publish(feature,bus.id,'created',{task:'f'})),'forbidden');
 await h.run('events.feature',{id:bus.id,input:{feature:'classifier',read:false,publish:true}});h.grants.allow(reader.clientId,['read']);
 const start=await h.read(reader,bus.id,{});await h.publish(feature,bus.id,'created',{task:'f'});
 const page=await h.read(reader,bus.id,{cursor:start.cursor});assert.deepEqual(page.records[0].publisher,{kind:'provider',feature:'classifier'});
 assert.equal(await code(h.read(feature,bus.id,{})),'forbidden');
 await h.publish(feature,bus.id,'created',{task:'g'});await h.run('events.purge',{id:bus.id});
 const purged=await h.read(reader,bus.id,{cursor:page.cursor});assert.deepEqual([purged.records.length,purged.gap,purged.head,purged.oldest],[0,{from:2,to:2},2,null]);
 await h.run('events.delete',{id:bus.id});assert.equal(await code(h.read(reader,bus.id,{})),'not_found');
 assert.equal((await h.run('events.create',{input:{url,manifest:manifest()}})).created,true,'a deleted bus frees its manifest for a new, empty bus');
 const sweep=await h.system('events.sweep');assert.equal(sweep.more,false);
 assert.equal([...(await h.e.metadata.list({prefix:`evbus/rec/${bus.id}/`})).keys()].length,0,'sweeps remove the deleted bus rows');
});

test('the pull client discards foreign attestation, deduplicates by seq and reports gaps',async t=>{
 const h=await busHarness(t),bus=await h.create(),a=app();h.grants.allow(a.clientId,['read','publish']);await h.read(a,bus.id,{});
 const gaps=[];const reader=createBusReader({attestor:ISSUER,onGap:gap=>gaps.push(gap),call:(method,args)=>method==='read'?h.read(a,bus.id,args):h.publish(a,bus.id,args.type,args.data)});
 await h.publish(a,bus.id,'created',{task:'1'});assert.deepEqual((await reader.pull()).records.map(r=>r.seq),[1]);
 const spoofed=createBusReader({attestor:'https://elsewhere.example',call:(method,args)=>h.read(a,bus.id,args)});assert.equal((await spoofed.pull()).discarded,1);
 await h.run('events.purge',{id:bus.id});await h.publish(a,bus.id,'created',{task:'2'});const after=await reader.pull();assert.deepEqual(after.records.map(r=>r.seq),[2]);assert.deepEqual(gaps,[]);
});

test('account adapter: owner create from the reviewed registry only; the resource handler fails closed without a matching fragment grant',async t=>{
 const {SqliteMetadata}=await import('../apps/node/resources.mjs');const {methods}=await import('../packages/runtime/account/events.mjs');
 const metadata=new SqliteMetadata(':memory:');t.after(()=>metadata.close());await metadata.put('owner',OWNER);
 const origin='https://3sln.example',client='https://tasks.example/bindle/client.json',checks=[];
 const c={metadata,config:{EVENT_BUSES_ENABLED:'true',APP_ORIGIN:origin,KEY_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64'),FEDERATION_SCHEMAS:JSON.stringify({[url]:manifest()}),FEDERATION_IDENTITY_CHECK:async(owner,epoch)=>epoch==='epoch-1'},
  scheduleAlarm:time=>metadata.setAlarm(time),warm:async()=>{},apps:{check:async(...args)=>{checks.push(args);return true;}}};
 Object.assign(c,methods);
 assert.equal(await code(c.eventBusOwner(OWNER,{operation:'events.create',input:{url:url+'/unregistered'}})),'untrusted_schema_host');
 assert.equal(await code(c.eventBusOwner(OWNER,{operation:'events.create',input:{url,manifest:{forged:true}}})),'invalid_request','the owner cannot supply the manifest document');
 assert.equal(await code(c.eventBusOwner(OWNER,{operation:'events.reader-approved',input:{}})),'not_found','system operations are not owner-dispatchable');
 const {bus}=await c.eventBusOwner(OWNER,{operation:'events.create',input:{url}});
 await metadata.put('resource/cnx-1',{owner:OWNER,kind:'app-connection',status:'active',generation:1,clientId:client});
 const digest=bus.digest.replace(/^sha256-/,''),context=(method,args,extra={})=>({authority:'bindle',subject:`${origin}/entities/${OWNER}`,epoch:'epoch-1',clientId:client,connection:{id:'cnx-1',generation:1},resource:`${origin}/entities/${OWNER}/buses/${bus.id}`,contract:EVENT_BUS_CONTRACT,method,args,tx:crypto.randomUUID(),grant:{fragment:url,digest,readSince:'approval-1'},...extra});
 const start=await eventBusResourceMethod(c,OWNER,context('read',{}));assert.equal(start.records.length,0);
 const published=await eventBusResourceMethod(c,OWNER,context('publish',{type:'created',data:{task:'t1'}}));assert.ok(published.receipt);
 const page=await eventBusResourceMethod(c,OWNER,context('read',{cursor:start.cursor}));assert.deepEqual(page.records[0].publisher,{kind:'application',client_id:client,origin:'https://tasks.example'});
 assert.equal(await code(eventBusResourceMethod(c,OWNER,context('subscribe',{}))),'unsupported_method','push doorbells are EV-3');
 assert.equal(await code(eventBusResourceMethod(c,OWNER,{...context('read',{}),grant:undefined})),'forbidden','no fragment grant, no access');
 assert.equal(await code(eventBusResourceMethod(c,OWNER,context('read',{},{grant:{fragment:url,digest:'other',readSince:'approval-1'}}))),'forbidden','a grant pinned to another manifest digest');
 assert.equal(await code(eventBusResourceMethod(c,OWNER,context('read',{},{grant:{fragment:url+'/v2',digest,readSince:'approval-1'}}))),'forbidden','a grant on another manifest URL');
 assert.equal(await code(eventBusResourceMethod(c,OWNER,context('read',{},{epoch:'stale'}))),'forbidden');
 assert.equal(await code(eventBusResourceMethod(c,OWNER,context('read',{},{resource:`${origin}/entities/${OWNER}/buses/../x`}))),'forbidden');
 await new Promise(resolve=>setTimeout(resolve,600));// the production read rate is 2 per second per grant
 assert.equal((await eventBusResourceMethod(c,OWNER,context('read',{cursor:page.cursor,wait:25}))).wait,undefined,'without the holding adapter wait is served as 0');
 // EV2-S1/S6: the floor epoch is the read approval, not the connection generation. Re-approval invalidates old cursors;
 // a generation change with the same approval keeps them.
 await new Promise(resolve=>setTimeout(resolve,1100));
 await eventBusResourceMethod(c,OWNER,context('publish',{type:'created',data:{task:'during revocation'}}));
 assert.equal(await code(eventBusResourceMethod(c,OWNER,context('read',{cursor:page.cursor},{grant:{fragment:url,digest,readSince:'approval-2'}}))),'invalid_args','a re-approved reader starts a new floor');
 assert.equal(await code(eventBusResourceMethod(c,OWNER,{...context('read',{}),grant:{fragment:url,digest}})),'forbidden','no read-approval identity, no access');
 await metadata.put('resource/cnx-1',{owner:OWNER,kind:'app-connection',status:'active',generation:2,clientId:client});
 assert.equal(await code(eventBusResourceMethod(c,OWNER,context('publish',{type:'created',data:{task:'t2'}}))),'forbidden','the commit re-checks the live connection generation');
 assert.ok(checks.length>0,'the connection check ran before the engine');
});
