// EV-3 push doorbells (packages/events/doorbell.mjs and the EV-3 hunks of packages/runtime/integration-events.mjs):
// data-free `bus-advanced` SETs signed by the brokering event key and verified by the conformance fixture
// (tests/fixtures/integration-server.mjs), one pending doorbell per subscription under publish storms, live-grant and
// revocation gating, the separate doorbell budget that never blocks owner writes or revocation SETs, and a cursor
// read after the doorbell. Engine-harness suites dispatch the real EV-2, X4, X6 and EV-3 operations on one store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppEngine,perform,read,AppQuery} from '../packages/app/engine.mjs';
import {memoryAudit} from '../packages/app/providers.mjs';
import {AppConnections} from '../packages/apps/connections.mjs';
import * as C from '../packages/app/domains/connections.mjs';
import {validateIntegrationManifest,PREFERENCES_UPDATED_EVENT} from '../packages/federation/integrations.mjs';
import {brokeringKeys} from '../packages/federation/signing.mjs';
import * as E from '../packages/runtime/integration-events.mjs';
import {eventBusProvider,EVENT_BUS_APP_OPERATIONS,CreateEventBus,ApproveEventBusReader,RevokeEventBusReader,DeleteEventBus} from '../packages/app/domains/events.mjs';
import {busKeys,createBusReader,readProblems} from '../packages/events/index.mjs';
import {BUS_LIMITS} from '../packages/events/limits.mjs';
import * as D from '../packages/events/doorbell.mjs';
import {createIntegrationServer,ISSUER} from './fixtures/integration-server.mjs';
import {createTestEngine,OWNER} from './helpers/app-engine.mjs';
import {fakeClock} from './helpers/chaos.mjs';
import {manifest,grantRegistry,app} from './event-bus-fixture.mjs';

const SUB=`${ISSUER}/entities/${OWNER}`,SECRET=Buffer.alloc(32,7).toString('base64'),BELL=D.BUS_ADVANCED_EVENT;
const busLimits={...BUS_LIMITS,reads:{...BUS_LIMITS.reads,perSecond:1e6},publishPerMinute:1e6,busPublishPerMinute:1e6};
const decode=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
function memory(){const map=new Map();let tail=Promise.resolve();return {transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>{map.set(k,structuredClone(v));}}));tail=run.catch(()=>{});return run;}};}
function snapshot(host='integration.example',events=[PREFERENCES_UPDATED_EVENT,BELL]){
 const clientId=`https://${host}/bindle/client.json`,redirectUris=[`https://${host}/bindle/callback`],jwksUri=`https://${host}/bindle/jwks.json`;
 const r=validateIntegrationManifest({v:1,events_endpoint:`https://${host}/bindle/events`,events},{clientId,confidential:true,redirectUris,jwksUri});assert.equal(r.status,'valid',r.reason);
 return {client:{id:clientId,name:host},snapshot:{clientId,redirectUris,authMethod:'private_key_jwt',jwksUri,thumbprints:['A'.repeat(43)],manifest:r.manifest}};
}
const code=async promise=>{try{await promise;return 'ok';}catch(error){return error.code??String(error);}};

async function world(t,{events,limits,enabled=true,plan='free'}={}){
 const clock=fakeClock(Date.UTC(2026,9,20,12,0,1)),keys=brokeringKeys({issuer:ISSUER,secret:SECRET,metadata:memory(),clock:()=>clock.now()});
 const busKeyset=await busKeys({KEY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')}),grants=grantRegistry(),kicks=[],sent=[];let server;
 const egress={async send({url,body}){sent.push({url,body,at:clock.now(),claims:decode(body)});const response=await server.fetch(url,{method:'POST',headers:{'Content-Type':E.SET_MEDIA_TYPE},body});return {status:response.status,bytes:new Uint8Array(await response.arrayBuffer())};}};
 const system={kind:'system',owner:OWNER},ownerActor={kind:'owner',owner:OWNER};let x4;
 const op=(Operation,actor,input)=>{const o=new Operation({actor,...input===undefined?{}:{input}});return o instanceof AppQuery?read(x4,o):perform(x4,o);};
 const port=()=>({outbox:i=>op(C.ConnectionOutbox,system,i),ack:i=>op(C.AckConnectionOutbox,system,i),list:()=>op(C.ConnectionList,system),health:i=>op(C.ConnectionHealth,system,i)});
 // The live grant port (EV3-R1): the reader's grant still holds read and subscribe under the same read approval.
 const doorbellGrant=async({clientId,epoch})=>{const g=grants.held.get(clientId);return !!g&&g.methods.has('read')&&g.methods.has('subscribe')&&g.epoch===epoch;};
 const x6limits=limits?{...E.INTEGRATION_EVENT_LIMITS,...limits}:undefined;
 const harness=await createTestEngine({clock,providers:{
  eventBus:eventBusProvider({enabled:true,keys:async()=>busKeyset,issuer:ISSUER,plan,grants,notifier:D.withDoorbellKick(null,owner=>kicks.push(owner),{store:{list:o=>harness.metadata.list(o)}}),limits:busLimits}),
  integrationEvents:E.integrationEventsProvider({enabled:true,issuer:ISSUER,signer:keys,egress,snapshot:async()=>({revision:'r1',values:{on:true}}),connections:port,limits,doorbellGrant}),
  eventDoorbells:D.eventDoorbellsProvider({enabled,keys:async()=>busKeyset,enqueue:(tx,event,{now})=>E.enqueueIntegrationEvent(tx,event,{now,...x6limits?{limits:x6limits}:{}}),cancel:E.cancelIntegrationDoorbell,subscribed:doorbellGrant,issuer:ISSUER}),
 }});
 t.after(()=>harness.dispose());await harness.metadata.put('owner',OWNER);
 const connections=new AppConnections({metadata:harness.metadata,origin:ISSUER,clock:clock.now});
 x4=createAppEngine({providers:{clock,random:{uuid:()=>crypto.randomUUID(),bytes:n=>crypto.getRandomValues(new Uint8Array(n))},audit:memoryAudit({clock}),connections:C.connectionsProvider({connections,enabled:true,account:async()=>({status:'active'})})}});
 t.after(()=>x4.dispose());
 const connection=await op(C.ConnectIntegration,system,snapshot('integration.example',events));
 server=createIntegrationServer({clock,connections:[{iss:ISSUER,id:connection.id,sub:SUB,generation:connection.generation}],
  verifyToken:async(token,{kind,audience})=>kind==='event'?(await E.verifySecurityEventToken(token,{subject:SUB,keys:await keys.jwks(),issuer:ISSUER,audience,connection:({connection:id})=>id===connection.id,now:clock.now()})).claims:null});
 t.after(()=>server.close());
 const bus=(await harness.perform(new CreateEventBus({actor:ownerActor,input:{url:manifest().id,manifest:manifest()}}))).bus;
 const reader={kind:'app',owner:OWNER,clientId:'https://integration.example/bindle/client.json',origin:'https://integration.example',connection:{id:connection.id,generation:connection.generation}};
 const resource=`${ISSUER}/entities/${OWNER}/buses/${bus.id}`,epoch='grant:rs-1',publisher=app('tasks');
 grants.allow(reader.clientId,['read','subscribe','unsubscribe'],epoch);grants.allow(publisher.clientId,['publish']);
 await harness.perform(new ApproveEventBusReader({actor:system,id:bus.id,input:{clientId:reader.clientId,epoch}}));
 let n=0;const publish=(data={task:`t-${++n}`,title:'File taxes'})=>harness.perform(new EVENT_BUS_APP_OPERATIONS.publish({actor:publisher,id:bus.id,input:{type:'created',data},tx:crypto.randomUUID()}));
 const busRead=(args={})=>harness.perform(new EVENT_BUS_APP_OPERATIONS.read({actor:reader,id:bus.id,input:args}));
 const subscribe=(actor=reader,options={})=>harness.perform(new D.SubscribeEventBus({actor,id:bus.id,resource,epoch,...options}));
 const ring=()=>harness.perform(new D.RingEventDoorbells({actor:system}));
 const deliver=()=>harness.perform(new E.DeliverIntegrationEvents({actor:system}));
 const alarm=async()=>{const rang=await ring();const delivered=await deliver();return {rang,delivered};};
 const bells=async()=>(await server.snapshot()).events.filter(e=>e.type===BELL);
 const status=()=>harness.read(new E.IntegrationEventStatus({actor:system}));
 return {clock,keys,harness,op,system,ownerActor,connection,server,sent,kicks,grants,bus,reader,resource,epoch,publisher,publish,busRead,subscribe,ring,deliver,alarm,bells,status,busKeyset};
}

test('EV-3 flags: doorbell operations are not_found unless EVENT_BUSES_ENABLED and INTEGRATIONS_ENABLED are on',async t=>{
 const w=await world(t,{enabled:false});
 assert.equal(await code(w.subscribe()),'not_found');assert.equal(await code(w.ring()),'not_found');
 assert.equal(await code(w.harness.perform(new D.SetEventBusPush({actor:w.ownerActor,id:w.bus.id,input:{enabled:false}}))),'not_found');
 for(const config of [{INTEGRATIONS_ENABLED:'true'},{EVENT_BUSES_ENABLED:'true'},{}]){
  const c={config,metadata:{get:async()=>OWNER}};
  await assert.rejects(E.methods.eventDoorbellApp.call(c,OWNER,{method:'subscribe'}),{code:'not_found'});
  assert.deepEqual(await E.methods.eventDoorbellCancel.call(c,OWNER,{clientId:'x'}),{cancelled:0});
  await assert.rejects(E.methods.eventDoorbellOwner.call(c,OWNER,{operation:'events.push'}),{code:'not_found'});
 }
});

test('publish kicks, the fixture verifies a data-free bus-advanced SET, and the subscriber then reads via its cursor',async t=>{
 const w=await world(t);
 const first=await w.busRead({});assert.deepEqual(first.records,[]);
 await w.publish({task:'before'});assert.deepEqual(w.kicks,[],'a bus without subscriptions does not kick (EV3-R4)');
 assert.deepEqual(await w.subscribe(),{subscribed:true});assert.deepEqual(await w.subscribe(),{subscribed:true},'subscribe is idempotent');
 await w.publish();await w.publish();assert.deepEqual(w.kicks,[OWNER,OWNER],'every committed publish on a subscribed bus kicks the account alarm');
 const {rang,delivered}=await w.alarm();assert.equal(rang.rung,1);assert.equal(delivered.acknowledged,1);
 const [bell]=await w.bells();assert.ok(bell,'the conformance fixture verified and recorded the doorbell');
 const claims=w.sent.at(-1).claims,[[type,payload]]=Object.entries(claims.events);
 assert.equal(type,BELL);assert.deepEqual(Object.keys(payload).sort(),['bus','connection','generation','head','seq']);
 assert.deepEqual(Object.keys(claims).sort(),['aud','events','iat','iss','jti','sub']);
 assert.equal(payload.bus,w.resource,'bus is the subscriber\'s own resource id');assert.equal(payload.head,3);assert.equal(payload.connection,w.connection.id);
 const raw=Buffer.from(w.sent.at(-1).body.split('.')[1],'base64url').toString();
 for(const leak of ['File taxes','t-1','t-2','created','tasks.example',w.publisher.clientId])assert.equal(raw.includes(leak),false,`no record data or publisher identity in the doorbell (${leak})`);
 // The integration pulls from its own cursor; the doorbell's head is a hint it can compare.
 const reader=createBusReader({call:(method,args)=>w.busRead(args),attestor:ISSUER,cursor:first.cursor});
 const pulled=await reader.pull();assert.deepEqual(pulled.records.map(r=>r.data.task),['before','t-1','t-2']);assert.equal(pulled.head,payload.head);
 assert.deepEqual(readProblems({records:pulled.records,cursor:reader.cursor,head:pulled.head,oldest:pulled.oldest,gap:pulled.gap}),[]);
 assert.equal((await w.alarm()).rang.rung,0,'no new head, no doorbell');
 assert.equal((await w.harness.read(new D.EventBusSubscriptions({actor:w.ownerActor,id:w.bus.id}))).subscriptions[0].clientId,w.reader.clientId,'the owner sees subscription health');
});

test('coalescing under a publish storm: one pending doorbell per subscriber and at most one per 5 s window',async t=>{
 const w=await world(t);await w.subscribe();
 for(let i=0;i<60;i++){await w.publish();await w.ring();w.clock.advance(100);
  const pending=(await w.status()).pending.filter(r=>r.type==='bus-advanced');assert.ok(pending.length<=1,`at most one pending doorbell (${pending.length})`);}
 assert.equal(w.sent.length,0,'nothing was delivered yet');
 assert.equal((await w.deliver()).acknowledged,1);
 // Six seconds of storm with an alarm after every publish: the 5 s window allows at most two doorbells.
 for(let i=0;i<60;i++){await w.publish();await w.alarm();w.clock.advance(100);}
 const bells=await w.bells();assert.ok(bells.length>=2&&bells.length<=3,`doorbells ${bells.length} for 120 publishes`);
 for(let i=1;i<w.sent.length;i++)assert.ok(w.sent[i].at-w.sent[i-1].at>=5000,'spaced by the coalescing window');
 assert.equal(bells.at(-1).head<=120,true);assert.ok(new Set(bells.map(b=>b.seq)).size===bells.length,'seq increases');
 const {rang}=await w.alarm();assert.equal(rang.windowed+rang.rung<=1,true);
 w.clock.advance(5000);await w.alarm();assert.equal((await w.bells()).at(-1).head,120,'the coalesced advance is rung once the window passes');
});

test('revoked subscribers get nothing: reader revocation, revocation between ring and send, disconnect and bus deletion',async t=>{
 const w=await world(t);await w.subscribe();await w.publish();await w.ring();
 assert.equal((await w.status()).pending.filter(r=>r.type==='bus-advanced').length,1);
 // Revoked after the ring enqueued: the send-time check (and the lease re-check) drops the row unsigned.
 await w.harness.perform(new RevokeEventBusReader({actor:w.system,id:w.bus.id,input:{clientId:w.reader.clientId}}));
 const d=await w.deliver();assert.equal(d.dropped,1);assert.equal(w.sent.length,0,'nothing signed or sent');
 assert.equal((await w.status()).log.at(-1).code,'moot');
 await w.publish();assert.equal((await w.ring()).cancelled,1,'the dead subscription is deleted');assert.equal((await w.deliver()).sent,0);
 // Re-approval is a new read approval: the old subscription never comes back by itself.
 w.grants.allow(w.reader.clientId,['read','subscribe','unsubscribe'],'grant:rs-2');
 await w.harness.perform(new ApproveEventBusReader({actor:w.system,id:w.bus.id,input:{clientId:w.reader.clientId,epoch:'grant:rs-2'}}));
 assert.equal(await code(w.subscribe()),'forbidden','a subscription needs the current read approval');
 await w.subscribe(w.reader,{epoch:'grant:rs-2'});await w.publish();await w.ring();
 // The cancellation hook deletes the subscription and its pending doorbell in one commit.
 assert.deepEqual(await w.harness.perform(new D.CancelEventDoorbells({actor:w.system,input:{clientId:w.reader.clientId}})),{cancelled:1});
 assert.equal((await w.status()).pending.filter(r=>r.type==='bus-advanced').length,0);assert.equal((await w.deliver()).sent,0);
 // Disconnect: the generation and status change kill the subscription; the revocation SET still goes out.
 await w.subscribe(w.reader,{epoch:'grant:rs-2'});await w.publish();await w.ring();
 await w.op(C.DisconnectConnection,w.ownerActor,{connection:w.connection.id});
 await w.harness.perform(new E.IngestIntegrationEvents({actor:w.system}));await w.ring();const out=await w.deliver();
 assert.equal((await w.bells()).length,0,'no doorbell after disconnect');assert.equal(w.sent.some(s=>Object.keys(s.claims.events)[0]===E.INTEGRATION_EVENT_TYPES['connection-revoked']),true,out);
});

test('review EV3-R1/R1b: a revoked or reduced grant stops doorbells even without the reader hook; R6a resource binding',async t=>{
 const w=await world(t);await w.subscribe();await w.publish();await w.ring();
 w.grants.revoke(w.reader.clientId);// grant revoked; the reader floor row is still there
 assert.equal((await w.deliver()).dropped,1,'a pending doorbell is dropped before signing');assert.equal(w.sent.length,0);
 await w.publish();assert.equal((await w.ring()).cancelled,1);
 const v=await world(t);await v.subscribe();
 v.grants.allow(v.reader.clientId,['read'],v.epoch);// subscribe removed, read kept (same read approval)
 await v.publish();const r=await v.alarm();assert.equal(r.rang.cancelled,1);assert.equal((await v.bells()).length,0);
 assert.equal(await code(v.subscribe()),'forbidden','subscribe needs the subscribe method in the live grant');
 v.grants.allow(v.reader.clientId,['read','subscribe'],v.epoch);
 assert.equal(await code(v.subscribe(v.reader,{resource:`${ISSUER}/entities/${OWNER}/buses/${crypto.randomUUID()}`})),'forbidden','the resource must name this bus');
 // Without the live grant port nothing is subscribed or rung (fail closed).
 const bare=await createTestEngine({providers:{eventDoorbells:D.eventDoorbellsProvider({enabled:true,keys:async()=>v.busKeyset,enqueue:E.enqueueIntegrationEvent,cancel:E.cancelIntegrationDoorbell,issuer:ISSUER})}});t.after(()=>bare.dispose());
 assert.equal(await code(bare.perform(new D.RingEventDoorbells({actor:{kind:'system',owner:OWNER}}))),'temporarily_unavailable');
});

test('review EV3-R3: dead rows never count toward caps; a connection holds at most 8 subscriptions',async t=>{
 const w=await world(t,{plan:'paid'});
 for(let i=0;i<20;i++)await w.harness.metadata.put(`evbus/sub/${w.bus.id}/gone-${String(i).padStart(2,'0')}`,{bus:w.bus.id,connection:`gone-${i}`,principal:'x',epoch:'x'});
 assert.deepEqual(await w.subscribe(),{subscribed:true},'stale rows are reaped, not counted');
 assert.equal([...(await w.harness.metadata.list({prefix:'evbus/sub/'})).keys()].length,1);
 for(let i=2;i<=9;i++){const m={...manifest(),id:`${manifest().id}/${i}`};const bus=(await w.harness.perform(new CreateEventBus({actor:w.ownerActor,input:{url:m.id,manifest:m}}))).bus;
  await w.harness.perform(new ApproveEventBusReader({actor:w.system,id:bus.id,input:{clientId:w.reader.clientId,epoch:w.epoch}}));
  const out=await code(w.harness.perform(new D.SubscribeEventBus({actor:w.reader,id:bus.id,resource:`${ISSUER}/entities/${OWNER}/buses/${bus.id}`,epoch:w.epoch})));
  assert.equal(out,i<=8?'ok':'rate_limited');}
});

test('subscribe gating: live read approval, a pushable integration, caps and owner pause',async t=>{
 const w=await world(t,{events:[PREFERENCES_UPDATED_EVENT]});
 assert.equal(await code(w.subscribe()),'unsupported_method','the manifest does not list bus-advanced/v1');
 const v=await world(t);
 assert.equal(await code(v.subscribe(v.reader,{epoch:'grant:other'})),'forbidden');
 assert.equal(await code(v.subscribe({...v.reader,connection:{...v.reader.connection,generation:v.reader.connection.generation+1}})),'forbidden','stale connection generation');
 assert.equal(await code(v.subscribe(v.reader,{resource:'http://bad.example/x'})),'forbidden');
 assert.equal(await code(v.harness.perform(new D.SubscribeEventBus({actor:v.reader,id:v.bus.id,input:{push:true},resource:v.resource,epoch:v.epoch}))),'invalid_request','no wire arguments');
 await v.subscribe();await v.publish();
 await v.harness.perform(new D.SetEventBusPush({actor:v.ownerActor,id:v.bus.id,input:{enabled:false}}));
 assert.equal((await v.alarm()).rang.paused,1);assert.equal((await v.bells()).length,0,'paused by the owner');
 await v.harness.perform(new D.SetEventBusPush({actor:v.ownerActor,id:v.bus.id,input:{enabled:true}}));
 assert.equal((await v.alarm()).delivered.acknowledged,1);
 // Unsubscribe is idempotent and removes the pending doorbell.
 await v.publish();v.clock.advance(5000);await v.ring();
 const unsub=()=>v.harness.perform(new D.UnsubscribeEventBus({actor:v.reader,id:v.bus.id}));
 assert.deepEqual(await unsub(),{subscribed:false});assert.deepEqual(await unsub(),{subscribed:false});
 assert.equal((await v.status()).pending.filter(r=>r.type==='bus-advanced').length,0);
 // Bus deletion: a pending doorbell is dropped unsigned, and the ring deletes the subscription.
 await v.subscribe();await v.publish();v.clock.advance(5000);assert.equal((await v.ring()).rung,1);
 await v.harness.perform(new DeleteEventBus({actor:v.ownerActor,id:v.bus.id}));const sentBefore=v.sent.length;
 assert.equal((await v.deliver()).dropped,1);assert.equal(v.sent.length,sentBefore);assert.equal((await v.ring()).cancelled,1);
 // An owner query is not reachable with an app actor.
 assert.equal(await code(v.harness.read(new D.EventBusSubscriptions({actor:v.reader,id:v.bus.id}))),'forbidden');
});

test('doorbell budgets: an exhausted budget coalesces, never blocks owner writes or revocation SETs',async t=>{
 const w=await world(t,{limits:{doorbellsPerConnection:1,doorbellRows:1,perConnection:2}});await w.subscribe();
 // Exhaust the subscription's hourly fair share.
 let rung=0;for(let i=0;i<D.DOORBELL_LIMITS.perSubscriptionHourly+3;i++){await w.publish();const r=await w.alarm();rung+=r.rang.rung;w.clock.advance(5000);}
 assert.equal(rung,D.DOORBELL_LIMITS.perSubscriptionHourly);const r=await w.ring();assert.equal(r.budget,1);assert.ok(r.next>w.clock.now());
 const day=Math.floor(w.clock.now()/86400000);
 assert.ok([...(await w.harness.metadata.list({prefix:`evbus/meter/${day}/bell/`})).keys()].length>=2,'doorbells are metered in the event-allowance counters');
 // Budget exhausted with a doorbell pending in a full doorbell row budget: owner writes (preferences markers) and
 // revocations still enqueue, and the revocation SET is delivered first.
 w.clock.set(Math.ceil(w.clock.now()/3600000)*3600000+1000);await w.publish();assert.equal((await w.ring()).rung,1);
 const F='https://integration.example/preferences/settings/v1',G='https://integration.example/preferences/layout/v1';
 await w.harness.perform(new E.MarkPreferencesUpdated({actor:w.system,input:{connection:w.connection.id,fragment:F}}));
 await w.harness.perform(new E.MarkPreferencesUpdated({actor:w.system,input:{connection:w.connection.id,fragment:G}}));
 await w.harness.perform(new E.EnqueueIntegrationEvent({actor:w.system,input:{type:'credential-revoked',connection:w.connection.id,grants:['g-1'],until:Math.floor(w.clock.now()/1000)+300}}));
 const typeOf=sent=>Object.keys(sent.claims.events)[0],before=w.sent.length;await w.deliver();w.clock.advance(1000);await w.deliver();w.clock.advance(1000);await w.deliver();
 const types=w.sent.slice(before).map(typeOf);
 assert.equal(types[0],E.INTEGRATION_EVENT_TYPES['credential-revoked'],'the revocation SET goes first');assert.equal(types.at(-1),BELL,'the doorbell goes last');
 assert.ok(types.includes(PREFERENCES_UPDATED_EVENT),'an owner write marker enqueued beside a full doorbell budget is delivered');
 // A second bus over the per-connection doorbell budget is coalesced (never queued, never failed) and rung later.
 const m2={...manifest(),id:manifest().id+'/2'};const bus2=(await w.harness.perform(new CreateEventBus({actor:w.ownerActor,input:{url:m2.id,manifest:m2}}))).bus;
 await w.harness.perform(new ApproveEventBusReader({actor:w.system,id:bus2.id,input:{clientId:w.reader.clientId,epoch:w.epoch}}));
 await w.harness.perform(new D.SubscribeEventBus({actor:w.reader,id:bus2.id,resource:`${ISSUER}/entities/${OWNER}/buses/${bus2.id}`,epoch:w.epoch}));
 w.clock.advance(5000);await w.publish();
 await w.harness.perform(new EVENT_BUS_APP_OPERATIONS.publish({actor:w.publisher,id:bus2.id,input:{type:'created',data:{task:'x'}},tx:crypto.randomUUID()}));
 const full=await w.ring();assert.equal(full.rung,1);assert.equal(full.full,1);
 assert.equal((await w.status()).pending.filter(r=>r.type==='bus-advanced').length,1);
 await w.deliver();const later=await w.ring();assert.equal(later.rung,1,'the coalesced bus is rung once the budget frees');
 await w.deliver();assert.deepEqual((await w.bells()).slice(-2).map(b=>b.bus),[w.resource,`${ISSUER}/entities/${OWNER}/buses/${bus2.id}`]);
});
