// Reusable EV-4 host contract. EV4_BUS_ADAPTER=/absolute/adapter.mjs substitutes a third-party host factory;
// controls must reach its real owner/test-issuer interfaces, never implement the bus rules in the adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createIntegrationBus,busManifest,BUS_RESOURCE,BUS_MANIFEST,clientId,ConfigureIntegrationBus,PublishIntegrationBus,ReadIntegrationBus,IntegrationBusSnapshot} from './fixtures/integration-bus.mjs';
import {INTEGRATION,ISSUER,ENDPOINTS} from './fixtures/integration-server.mjs';
import {createTestEngine} from './helpers/app-engine.mjs';
import {createBusReader,readProblems,publishProblems,EVENT_BUS_CONTRACT,jsonBytes} from '../packages/events/index.mjs';

const fault=(work,code)=>assert.rejects(work,error=>error.code===code,code),tx=()=>crypto.randomUUID();
const approve=(host,client,methods=['read'],extra={})=>host.control({op:'approve',client,methods,...extra});
const publish=(host,token,task='t',transaction=tx(),resource)=>host.call(token,'publish',{type:'created',data:{task}},transaction,resource);
const full=['publish','read','subscribe','unsubscribe','describe'];
const readPage=async(host,token,args={start:'oldest'},resource)=>{const page=await host.call(token,'read',args,undefined,resource);assert.deepEqual(readProblems(page),[]);return page;};

/** Register the same unskipped scenarios for any asynchronous createHost(options) adapter (docs/integration.md).
 * Every case starts with a fresh owner and the manifest/resource IDs in the fixture. Test clocks avoid real waits.
 */
export function integrationBusConformance(createHost,label='reference fake'){
 const host=async(t,options={})=>{const h=await createHost({enabled:true,...options});t.after(()=>h.close());return h;};
 const scenario=(name,run)=>test(`EV-4 ${label}: ${name}`,run);

 scenario('manifest pinning is immutable, exact, and covers unknown top-level members',async t=>{
  const h=await host(t),document=busManifest(),first=await h.control({op:'pin',manifest:document});
  assert.match(first.digest,/^sha256-/);assert.deepEqual(await h.control({op:'pin',manifest:document,digest:first.digest}),first);
  await fault(h.control({op:'pin',manifest:document,digest:'sha256-'+'A'.repeat(43)}),'digest_mismatch');
  for(const mutate of [m=>m.slot.bus.types.push('renamed'),m=>m.title='Different title',m=>m.future={purpose:'changed'}]){
   const changed=busManifest();mutate(changed);await fault(h.control({op:'pin',manifest:changed}),'schema_changed');
  }
  const successor=busManifest();successor.id=BUS_MANIFEST+'/v2';successor.slot.supersedes=BUS_MANIFEST;
  const resource=BUS_RESOURCE+'-v2';await h.control({op:'create',manifest:successor,resource});
  const a=await approve(h,'reader',full,{history:true}),b=await approve(h,'reader',full,{history:true,resource});
  const transaction=tx();await publish(h,a,'t',transaction);assert.equal((await readPage(h,b,{start:'oldest'},resource)).records.length,0,'new URL has no copied records');
  await fault(publish(h,b,'t',transaction,resource),'tx_conflict','a client cannot reuse a transaction ID on another resource');
  await fault(h.call(a,'read',{start:'oldest'},undefined,resource),'forbidden');
  const digestMismatch=await approve(h,'wrong-digest',full,{binding:{digest:'sha256-'+'B'.repeat(43)}});
  await fault(publish(h,digestMismatch),'forbidden');
  const urlMismatch=await approve(h,'wrong-url',full,{binding:{fragment:BUS_MANIFEST+'?lookalike'}});
  await fault(publish(h,urlMismatch),'forbidden');
 });

 scenario('invalid manifests are rejected before becoming occupants',async t=>{
  const mutations=[m=>m.fields.extra={title:'Other',type:'boolean'},m=>m.slot.selection='multiple',m=>m.fields.bus.cardinality.max=2,
   m=>m.slot.crit=[],m=>m.slot.bus.payload.pattern='(a+)+$',m=>m.slot.bus.payload.$ref='https://schema.example/bomb',
   m=>delete m.slot.bus.payload.properties.task.maxLength,m=>m.slot.bus.retention.min_seconds=3601,m=>m.slot.bus.max_record_bytes=16385];
  for(const mutate of mutations){const document=busManifest();mutate(document);await fault(createHost({enabled:true,manifest:document}),'unsupported_fragment');}
  await fault(createHost({enabled:true,manifest:busManifest({retention:{min_seconds:3600,max_seconds:3600}}),limits:{retentionSeconds:60}}),'unsupported_fragment');
 });

 scenario('pull-only descriptor and publisher attribution are host-stamped',async t=>{
  const h=await host(t),token=await approve(h,'consumer',full,{history:true}),descriptor=await h.call(token,'describe');
  assert.equal(descriptor.id,BUS_RESOURCE);assert.equal(descriptor.manifest,BUS_MANIFEST);
  const limits=descriptor.limits;assert.equal(limits.push,false);
  for(const key of ['maxRecordBytes','retentionSeconds','maxRetainedRecords','maxRetainedBytes','publishPerMinute','maxWaitSeconds','txRetentionSeconds','maxRequestBytes','maxResultBytes'])assert.ok(Number.isSafeInteger(limits[key])&&limits[key]>=0,key);
  assert.ok(limits.txRetentionSeconds>=3600);assert.ok(limits.maxRecordBytes<=h.manifest.slot.bus.max_record_bytes);
  for(const method of ['subscribe','unsubscribe'])await fault(h.call(token,method),'unsupported_method');
  const result=await publish(h,token);assert.deepEqual(publishProblems(result),[]);
  const page=await readPage(h,token);assert.equal(page.records.length,1);
  assert.deepEqual(page.records[0].publisher,{kind:'application',client_id:clientId('consumer'),origin:'https://consumer.example'});
  assert.equal(page.records[0].attested_by,INTEGRATION);assert.equal(page.records[0].published_at,result.published_at);
  await fault(h.call(token,'publish',{type:'created',data:{task:'t'},publisher:{kind:'provider',feature:'fake'}},tx()),'invalid_args');
 });

 scenario('cursor pagination, latest default, widening and client/bus/floor binding',async t=>{
  const h=await host(t),a=await approve(h,'a',full,{history:true}),b=await approve(h,'b',full,{history:true});
  for(let i=1;i<=3;i++)await publish(h,a,'t'+i);
  const first=await readPage(h,a,{start:'oldest',limit:1});assert.deepEqual(first.records.map(r=>r.seq),[1]);
  const second=await readPage(h,a,{cursor:first.cursor,limit:1});assert.deepEqual(second.records.map(r=>r.seq),[2]);
  assert.deepEqual((await readPage(h,a,{cursor:first.cursor,limit:1})),second,'read has no cursor side effect');
  assert.equal((await readPage(h,a,{})).records.length,0);assert.equal((await readPage(h,a,{start:'latest'})).records.length,0);
  const widened=await approve(h,'a',full,{history:true,floorAt:Math.floor(h.clock.now()/1000),grant:'widened'});
  assert.deepEqual((await readPage(h,widened,{cursor:first.cursor})).records.map(r=>r.seq),[2,3]);
  await fault(h.call(b,'read',{cursor:first.cursor}),'invalid_args');
  const other=busManifest();other.id=BUS_MANIFEST+'/other';await h.control({op:'create',manifest:other,resource:BUS_RESOURCE+'-other'});
  const otherToken=await approve(h,'a',full,{history:true,resource:BUS_RESOURCE+'-other'});
  await fault(h.call(otherToken,'read',{cursor:first.cursor},undefined,BUS_RESOURCE+'-other'),'invalid_args');
  const forged=(first.cursor.startsWith('A')?'B':'A')+first.cursor.slice(1);
  for(const cursor of [forged,'foreign','',42,'x'.repeat(513)])await fault(h.call(a,'read',{cursor}),'invalid_args');
  for(const args of [{cursor:first.cursor,start:'oldest'},{start:'wrong'},{limit:0},{limit:101},{wait:-1},{wait:26},{unknown:true}])await fault(h.call(a,'read',args),'invalid_args');
  await h.control({op:'revoke',token:a,acknowledged:true});await h.control({op:'advance',seconds:1});
  const reapproved=await approve(h,'a',full,{history:true});await fault(h.call(reapproved,'read',{cursor:first.cursor}),'invalid_args');
 });

 scenario('floor_at is strict and hides pre-approval heads, oldest and gaps; history needs owner opt-in',async t=>{
  const h=await host(t),writer=await approve(h,'writer',['publish']);await publish(h,writer,'before');
  const floorAt=Math.floor(h.clock.now()/1000),reader=await approve(h,'reader',['read'],{floorAt});
  await publish(h,writer,'same-second');const first=await readPage(h,reader);
  assert.deepEqual([first.records,first.head,first.oldest,first.gap],[[],null,null,null]);
  const earlier=await approve(h,'earlier',['read'],{history:true});assert.deepEqual((await readPage(h,earlier)).records.map(r=>r.seq),[1,2],'only explicit history opt-in reveals earlier records');
  await h.control({op:'purge'});const hidden=await readPage(h,reader,{cursor:first.cursor});assert.deepEqual([hidden.head,hidden.oldest,hidden.gap],[null,null,null]);
  await h.control({op:'advance',seconds:1});await publish(h,writer,'after');
  const page=await readPage(h,reader,{cursor:hidden.cursor});assert.deepEqual(page.records.map(r=>r.data.task),['after']);assert.equal(page.oldest,3);assert.equal(page.gap,null);
  const historic=await approve(h,'historic',['read'],{history:true});assert.deepEqual((await readPage(h,historic)).records.map(r=>r.seq),[3]);
  const missing=await approve(h,'missing',['read'],{binding:{bus:undefined}});await fault(h.call(missing,'read',{}),'forbidden');
  const never=await host(t,{manifest:busManifest({history:'never'})});await fault(approve(never,'reader',['read'],{history:true}),'forbidden');
 });

 scenario('retention caps and purge report gaps, and the provider client follows them',async t=>{
  const h=await host(t,{limits:{maxRetainedRecords:2}}),token=await approve(h,'reader',full,{history:true}),gaps=[];
  const reader=createBusReader({attestor:h.origin,brokered:{floorAt:Math.floor(h.clock.now()/1000),history:true},onGap:gap=>gaps.push(gap),call:(method,args,transaction)=>h.call(token,method,args,transaction)});
  const empty=await reader.pull();assert.equal(empty.head,null);
  for(let i=1;i<=4;i++)await publish(h,token,'t'+i);
  const page=await reader.pull();assert.deepEqual(page.records.map(r=>r.seq),[3,4]);assert.deepEqual(page.gap,{from:1,to:2});
  assert.deepEqual(gaps,[{from:1,to:2}]);assert.equal(page.oldest,3);assert.equal(page.head,4);
  await publish(h,token,'purged');await h.control({op:'purge'});
  const purged=await reader.pull();assert.deepEqual([purged.records,purged.head,purged.oldest,purged.gap],[[],5,null,{from:5,to:5}]);
  await publish(h,token,'resumed');assert.deepEqual((await reader.pull()).records.map(r=>r.seq),[6]);
  assert.equal((await reader.pull()).records.length,0);
 });

 scenario('time retention and byte caps lose oldest records and never reject a publish',async t=>{
  const h=await host(t,{manifest:busManifest({retention:{min_seconds:0,max_seconds:1}})}),token=await approve(h,'reader',full,{history:true});
  const empty=await readPage(h,token);await publish(h,token);await h.control({op:'advance',seconds:2});
  const expired=await readPage(h,token,{cursor:empty.cursor});assert.deepEqual([expired.records,expired.gap],[[],{from:1,to:1}]);
  const bytes=await host(t,{limits:{maxRetainedBytes:800}}),b=await approve(bytes,'reader',full,{history:true}),start=await readPage(bytes,b);
  for(let i=0;i<6;i++)assert.deepEqual(publishProblems(await publish(bytes,b,'x'.repeat(180))),[]);
  const clipped=await readPage(bytes,b,{cursor:start.cursor});assert.ok(clipped.gap);assert.equal(clipped.records.at(-1).seq,6);assert.ok(clipped.records.length<6);
 });

 scenario('every publish introspects live, including cached tx replies; revocation, budget and outages fail closed',async t=>{
  const h=await host(t),token=await approve(h,'writer',full,{history:true}),transaction=tx(),before=(await h.snapshot()).introspections.length;
  const first=await publish(h,token,'one',transaction);assert.deepEqual(await publish(h,token,'one',transaction),first);
  assert.equal((await h.snapshot()).introspections.length-before,2,'no cached publish authorization');
  await h.control({op:'revoke',token});await fault(publish(h,token,'one',transaction),'forbidden');await fault(publish(h,token,'two'),'forbidden');
  const other=await approve(h,'other',full,{history:true});
  for(const mode of ['inactive','budget','outage']){await h.control({op:'introspection',mode});await fault(publish(h,other,mode),'forbidden');}
  await h.control({op:'introspection',mode:'active'});assert.deepEqual((await readPage(h,other)).records.map(r=>r.data.task),['one']);
  assert.equal((await h.snapshot()).introspections.length-before,7);
 });

 scenario('read revocation is bounded, acknowledged revocation immediate, and method ceilings exact',async t=>{
  const h=await host(t),writer=await approve(h,'writer',['publish']),reader=await approve(h,'reader',['read'],{history:true});
  const start=await readPage(h,reader);await publish(h,writer);
  await fault(h.call(writer,'read',{}),'forbidden');await fault(publish(h,reader),'forbidden');
  await h.control({op:'revoke',token:reader});await h.control({op:'advance',seconds:361});await fault(h.call(reader,'read',{cursor:start.cursor}),'invalid_token');
  const fresh=await approve(h,'fresh',['read'],{history:true}),page=await readPage(h,fresh);await h.control({op:'revoke',token:fresh,acknowledged:true});
  await fault(h.call(fresh,'read',{cursor:page.cursor}),'forbidden');
  const wrongAudience=await approve(h,'foreign',full,{claims:{aud:ISSUER+'/bindle/rpc'}});await fault(publish(h,wrongAudience),'invalid_token');
  const wrongPurpose=await approve(h,'discovery',full,{binding:{purpose:'discover'}});await fault(publish(h,wrongPurpose),'invalid_token');
  const unknown=await approve(h,'resource',full,{binding:{resource:INTEGRATION+'/r/foreign'}});await fault(publish(h,unknown),'forbidden');
  assert.equal((await h.snapshot()).introspections.length,1,'read-only and invalid tokens never become publish authority');
 });

 scenario('pinned payload and UTF-8 record/request/response size limits',async t=>{
  const h=await host(t,{limits:{maxRecordBytes:64,maxResultBytes:2048}}),token=await approve(h,'writer',full,{history:true});
  const exact={task:'x'.repeat(53)};assert.equal(jsonBytes(exact),64);
  await h.call(token,'publish',{type:'created',data:exact},tx());
  for(const args of [{type:'unknown',data:{task:'t'}},{type:'created',data:{}},{type:'created',data:{task:'t',extra:1}},
   {type:'created',data:{task:1}},{type:'created',data:{task:'t',n:101}},{type:'created',data:{task:'t',n:1.5}},
   {type:'created',data:{task:'x'.repeat(54)}},{type:'created',data:{task:'😀'.repeat(14)}},{type:'created',data:{task:'t'},extra:1}])await fault(h.call(token,'publish',args,tx()),'invalid_args');
  const large=await host(t,{manifest:busManifest({max_record_bytes:2048}),limits:{maxRequestBytes:512}}),largeToken=await approve(large,'writer',full,{history:true});
  await fault(publish(large,largeToken,'x'.repeat(500)),'invalid_args');
  const pinned=await host(t),pinnedToken=await approve(pinned,'writer',full,{history:true});await fault(publish(pinned,pinnedToken,'x'.repeat(256)),'invalid_args','the manifest bound is enforced independently of the smaller-host-limit case');
  for(let i=0;i<8;i++)await publish(h,token,'n'+i);
  let cursor,seen=[];for(let i=0;i<10;i++){
   const page=await readPage(h,token,cursor?{cursor,limit:2}:{start:'oldest',limit:2});assert.ok(jsonBytes(page)<=2048);seen.push(...page.records.map(r=>r.seq));cursor=page.cursor;if(!page.records.length)break;
  }
  assert.deepEqual(seen,[1,2,3,4,5,6,7,8,9],'invalid attempts store no records and bounded pages eventually return everything');
 });

 scenario('concurrent publishers share a total order; tx journal survives lost replies and its advertised lifetime',async t=>{
  const h=await host(t),a=await approve(h,'a',full,{history:true}),b=await approve(h,'b',full,{history:true});
  const transaction=tx(),results=await Promise.all(Array.from({length:20},(_,i)=>publish(h,i%2?a:b,'t'+i)));
  assert.equal(new Set(results.map(r=>r.receipt)).size,20);results.forEach(result=>assert.deepEqual(publishProblems(result),[]));
  const page=await readPage(h,a);assert.deepEqual(page.records.map(r=>r.seq),Array.from({length:20},(_,i)=>i+1));
  assert.equal(new Set(page.records.map(r=>r.data.task)).size,20);
  for(const client of ['a','b']){const values=page.records.filter(r=>r.publisher.client_id===clientId(client)).map(r=>Number(r.data.task.slice(1)));assert.deepEqual(values,[...values].sort((a,b)=>a-b),'per-publisher order is preserved');}
  const duplicate=await Promise.all(Array.from({length:4},()=>publish(h,a,'duplicate',transaction)));duplicate.forEach(result=>assert.deepEqual(result,duplicate[0]));
  await fault(publish(h,a,'different',transaction),'tx_conflict');
  await h.control({op:'lose-reply'});const uncertain=tx();await fault(publish(h,a,'uncertain',uncertain),'indeterminate');
  const replay=await publish(h,a,'uncertain',uncertain);assert.deepEqual(publishProblems(replay),[]);
  assert.equal((await readPage(h,a)).records.length,22,'lost replies and concurrent replays never duplicate records');
  const limits=(await h.call(a,'describe')).limits;await h.control({op:'advance',seconds:limits.txRetentionSeconds-1});
  const renewed=await approve(h,'a',full,{history:true});assert.deepEqual(await publish(h,renewed,'duplicate',transaction),duplicate[0]);
 });

 scenario('journal has a ten-minute floor even when record retention is shorter; tx is scoped to the publisher',async t=>{
  const h=await host(t,{manifest:busManifest({retention:{min_seconds:0,max_seconds:1}})}),a=await approve(h,'a',full,{history:true}),b=await approve(h,'b',full,{history:true});
  assert.ok((await h.call(a,'describe')).limits.txRetentionSeconds>=600);
  const transaction=tx(),first=await publish(h,a,'one',transaction),other=await publish(h,b,'one',transaction);assert.notEqual(other.receipt,first.receipt);
  await h.control({op:'advance',seconds:599});const renewed=await approve(h,'a',full,{history:true});
  assert.deepEqual(await publish(h,renewed,'one',transaction),first,'the journal survives token renewal and record expiry');
  assert.equal((await readPage(h,renewed)).records.length,0,'receipt replay does not republish an aged-out record');
 });
}

const adapter=process.env.EV4_BUS_ADAPTER?await import(pathToFileURL(resolve(process.env.EV4_BUS_ADAPTER)).href):null;
if(adapter&&typeof adapter.createIntegrationBus!=='function')throw new TypeError('EV4_BUS_ADAPTER must export createIntegrationBus(options).');
integrationBusConformance(adapter?.createIntegrationBus??createIntegrationBus,adapter?'third-party adapter':'reference fake');

// These cases exercise the reference fixture's engine composition, not a third party's implementation details.
test('EV-4 fixture is default off and the four private operations run through the account engine harness',async t=>{
 const disabled=await createIntegrationBus();t.after(()=>disabled.close());await fault(disabled.control({op:'pin',manifest:busManifest()}),'not_found');
 const host=await createIntegrationBus({enabled:true});t.after(()=>host.close());
 const harness=await createTestEngine({clock:host.clock,providers:{federation:host.provider}});t.after(()=>harness.dispose());
 const token=await harness.perform(new ConfigureIntegrationBus({input:{op:'approve',client:'harness',methods:full,history:true}}));
 const envelope={resource:BUS_RESOURCE,contract:EVENT_BUS_CONTRACT,method:'publish',args:{type:'created',data:{task:'engine'}},tx:tx()};
 await harness.perform(new PublishIntegrationBus({input:{token,envelope}}));
 const page=await harness.read(new ReadIntegrationBus({input:{token,envelope:{...envelope,method:'read',args:{start:'oldest'}}}}));assert.equal(page.records[0].data.task,'engine');
 const before=await harness.read(new IntegrationBusSnapshot());await harness.read(new ReadIntegrationBus({input:{token,envelope:{...envelope,method:'read',args:{cursor:page.cursor}}}}));
 assert.deepEqual(await harness.read(new IntegrationBusSnapshot()),before,'reads write no fixture state');
 assert.deepEqual(harness.audit.entries.map(e=>e.operation),['fixture.bus.configure','fixture.bus.publish']);
 assert.equal(ENDPOINTS.rpc,INTEGRATION+'/bindle/rpc');
});
