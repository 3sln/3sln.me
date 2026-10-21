// EV-4 consumer-side checks use the actual EV-2 client and hostile host answers, plus the engine-backed bus.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBusReader,readProblems,publishProblems} from '../packages/events/client.mjs';
import {createIntegrationBus,clientId} from './fixtures/integration-bus.mjs';
import {INTEGRATION} from './fixtures/integration-server.mjs';

const record=(seq=1,extra={})=>({seq,type:'created',published_at:101,publisher:{kind:'application',client_id:clientId('tasks'),origin:'https://tasks.example'},attested_by:INTEGRATION,data:{task:'t'},...extra});
const page=(records=[record()],extra={})=>({records,cursor:'opaque-next',head:records.at(-1)?.seq??null,oldest:records[0]?.seq??null,gap:null,...extra});
const invalid=work=>assert.rejects(work,error=>error.code==='invalid_result');

test('EV-4 client rejects malformed envelopes and metadata before advancing its cursor',async()=>{
 const malformed=[null,{},page([record(0)]),page([record(-1)]),page([record(1,{published_at:undefined})]),page([record(1,{published_at:1.5})]),
  page([record(1,{type:undefined})]),page([record(1,{type:'NOT A TYPE'})]),page([record(1,{data:undefined})]),
  page([record(1,{attested_by:undefined})]),page([record(1,{publisher:{kind:'application'}})]),page([record(1,{publisher:{kind:'provider'}})]),
  page([record(1)],{head:null}),page([record(1)],{oldest:null}),page([record(1)],{oldest:2}),page([record(2)],{head:1}),
  page([record(2),record(1)]),page([record(1),record(1)]),page([],{cursor:''}),page([],{cursor:'x'.repeat(513)}),
  page([],{gap:{from:1,to:2,other:true},head:2}),page([],{gap:{from:1,to:3},head:2}),page([],{unexpected:'reader-list'})];
 for(const result of malformed){
  let calls=0;const reader=createBusReader({attestor:INTEGRATION,cursor:'previous',call:async()=>{calls++;return result;}});
  await invalid(reader.pull());assert.equal(reader.cursor,'previous',JSON.stringify(result));assert.equal(calls,1,'invalid responses never trigger a retry');
 }
 assert.deepEqual(readProblems(page([record(2),record(4)],{head:8,oldest:1})),[],'holes in retained sequences are legal');
 assert.deepEqual(readProblems(page([record(4)],{gap:{from:2,to:3},head:4,oldest:4})),[]);
 assert.ok(readProblems(page([record(4)],{oldest:3}),{floorSeq:3}).includes('oldest-floor'));
 assert.ok(readProblems(page([record(5)],{oldest:5,gap:{from:1,to:4}}),{floorSeq:3}).includes('gap-floor'));
});

test('EV-4 client filters foreign attestation and strict brokered floor, deduplicates and reports gaps',async()=>{
 const calls=[],gaps=[],answers=[page([record(1,{published_at:99}),record(2,{published_at:100}),record(3,{published_at:101,attested_by:'https://foreign.example'}),record(4,{published_at:101})],{head:4,oldest:1,cursor:'c1'}),
  page([record(4),record(6)],{head:6,oldest:4,cursor:'c2'}),page([record(9)],{gap:{from:7,to:8},head:9,oldest:9,cursor:'c3'})];
 const reader=createBusReader({attestor:INTEGRATION,brokered:{floorAt:100,history:false},limit:10,onGap:gap=>gaps.push(gap),call:async(method,args)=>{calls.push({method,args});return answers.shift();}});
 const first=await reader.pull({wait:25});assert.deepEqual(first.records.map(r=>r.seq),[4]);assert.equal(first.discarded,3);
 const second=await reader.pull();assert.deepEqual(second.records.map(r=>r.seq),[6]);assert.equal(second.discarded,1);
 const third=await reader.pull();assert.deepEqual(third.records.map(r=>r.seq),[9]);assert.deepEqual(gaps,[{from:7,to:8}]);
 assert.deepEqual(calls,[{method:'read',args:{start:'oldest',limit:10,wait:25}},{method:'read',args:{cursor:'c1',limit:10}},{method:'read',args:{cursor:'c2',limit:10}}]);
 const history=createBusReader({attestor:INTEGRATION,brokered:{floorAt:100,history:true},call:async()=>page([record(1,{published_at:50})])});assert.equal((await history.pull()).records.length,1);
});

test('EV-4 client rejects invalid brokered claims and read bounds before any RPC',async()=>{
 for(const brokered of [{},{floorAt:100},{history:false},{floorAt:'100',history:false},{floorAt:NaN,history:false},{floorAt:-1,history:false},{floorAt:100,history:'true'}])
  assert.throws(()=>createBusReader({attestor:INTEGRATION,brokered,call:async()=>assert.fail('no RPC')}),TypeError);
 for(const limit of [0,-1,101,1.5])assert.throws(()=>createBusReader({attestor:INTEGRATION,limit,call:async()=>assert.fail('no RPC')}),TypeError);
 const reader=createBusReader({attestor:INTEGRATION,call:async()=>assert.fail('no RPC')});
 for(const wait of [-1,26,NaN,'25'])await assert.rejects(reader.pull({wait}),TypeError);
});

test('EV-4 client validates opaque publish receipts and never retries indeterminate under another tx',async()=>{
 for(const result of [{receipt:'1',published_at:100},{receipt:'',published_at:100},{receipt:'x'.repeat(129),published_at:100},{receipt:'opaque'},
  {receipt:'opaque',published_at:-1},{receipt:'opaque',published_at:100,seq:1}]){
  assert.ok(publishProblems(result).length);let calls=0;
  const reader=createBusReader({attestor:INTEGRATION,call:async()=>{calls++;return result;}});await invalid(reader.publish('created',{task:'t'},'same-tx'));assert.equal(calls,1);
 }
 const calls=[],uncertain=Object.assign(new Error('Reply lost'),{code:'indeterminate'}),result={receipt:'opaque',published_at:100};
 const reader=createBusReader({attestor:INTEGRATION,call:async(...args)=>{calls.push(args);if(calls.length===1)throw uncertain;return result;}});
 await assert.rejects(reader.publish('created',{task:'t'},'same-tx'),error=>error===uncertain);assert.equal(calls.length,1);
 assert.deepEqual(await reader.publish('created',{task:'t'},'same-tx'),result);
 assert.deepEqual(calls,[['publish',{type:'created',data:{task:'t'}},'same-tx'],['publish',{type:'created',data:{task:'t'}},'same-tx']]);
});

test('EV-4 provider client runs the engine-backed host lifecycle without subscriptions',async t=>{
 const host=await createIntegrationBus({enabled:true});t.after(()=>host.close());
 const floorAt=Math.floor(host.clock.now()/1000),token=await host.control({op:'approve',client:'provider-consumer',methods:['read','publish']}),calls=[];
 const reader=createBusReader({attestor:host.origin,brokered:{floorAt,history:false},call:(...args)=>{calls.push(args);return host.call(token,...args);}});
 await reader.pull();await host.control({op:'advance',seconds:1});const transaction=crypto.randomUUID();
 await host.control({op:'lose-reply'});await assert.rejects(reader.publish('created',{task:'once'},transaction),error=>error.code==='indeterminate');
 await reader.publish('created',{task:'once'},transaction);assert.deepEqual((await reader.pull()).records.map(r=>r.data.task),['once']);
 await host.control({op:'revoke',token});await assert.rejects(reader.publish('created',{task:'revoked'},crypto.randomUUID()),error=>error.code==='forbidden');
 await host.control({op:'revoke',token,acknowledged:true});const cursor=reader.cursor;
 await assert.rejects(reader.pull(),error=>error.code==='forbidden');assert.equal(reader.cursor,cursor);
 assert.ok(calls.every(([method])=>['read','publish'].includes(method)));
});
