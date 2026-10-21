// EXT-X4 connections domain (packages/app/domains/connections.mjs over packages/apps/connections.mjs): lifecycle
// transitions, generation fencing against stale operations, occupancy under each selection policy (consistent with
// packages/federation/extensions.mjs), X3 revalidation, the outbox, seeded concurrency (tests/helpers/chaos.mjs), the
// occupancy ports, the KD-4 cascades (delegations revoked, link authority removed) on the real AccountController, and
// unchanged legacy app-connection behaviour with INTEGRATIONS_ENABLED off.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppEngine,perform,read} from '../packages/app/engine.mjs';
import {memoryAudit} from '../packages/app/providers.mjs';
import {AppConnections,MESSAGING_INGRESS_MANIFEST,RECOGNIZED_SLOTS} from '../packages/apps/connections.mjs';
import * as C from '../packages/app/domains/connections.mjs';
import {validateIntegrationManifest} from '../packages/federation/integrations.mjs';
import {nextSlotDispatch,recordSlotOutcome,slotOperationResult} from '../packages/federation/extensions.mjs';
import {MESSAGING_INGRESS_SLOT} from '../packages/links/types.mjs';
import {DELEGATION_PURPOSES,signDelegationPop,jwkThumbprint} from '../packages/identity/delegation.mjs';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {forEachSeed,concurrently,tally,fakeClock} from './helpers/chaos.mjs';

const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',ISSUER='https://3sln.example';
const MAILBOX='https://spec.bindle.example/bindlebox/v1/contracts/mailbox',MODEL='https://spec.bindle.example/contracts/decision-model/v1';
const ALL=Object.values(DELEGATION_PURPOSES).sort();
const multi=(name,selection,extra={})=>({id:`https://spec.bindle.example/slots/${name}/v1`,title:name,description:'Test slot.',publisher:'https://spec.bindle.example',fields:{occupants:{title:'Occupants',type:'resource',cardinality:{min:0,max:3},contracts:[MODEL]}},slot:{v:1,field:'occupants',selection,consumers:['application','provider'],...extra}});
const ORDERED=multi('ordered-test','ordered'),BROADCAST=multi('broadcast-test','broadcast'),CHOICE=multi('choice-test','consumer-choice');
const SLOTS={...RECOGNIZED_SLOTS,[ORDERED.id]:ORDERED,[BROADCAST.id]:BROADCAST,[CHOICE.id]:CHOICE};
const BUILTINS={classifier:{name:'3sln.me classifier',manifest:{v:1,extensions:[{slot:ORDERED.id,role:'occupant',ref:'classifier'},{slot:BROADCAST.id,role:'occupant',ref:'classifier'},{slot:CHOICE.id,role:'occupant',ref:'classifier'}],resources:{contracts:[MODEL]}}}};
const code=c=>e=>{assert.equal(e.code,c,`expected ${c}, got ${e.code}: ${e.message}`);return true;};

/** A validated approval snapshot for an external integration on `host` occupying `slots` with `contracts`. */
function snapshot(host,{slots=[MESSAGING_INGRESS_SLOT],contracts=[MAILBOX],required=false}={}){
 const clientId=`https://${host}/bindle/client.json`,redirectUris=[`https://${host}/bindle/callback`],jwksUri=`https://${host}/bindle/jwks.json`;
 const raw={v:1,resources:{rpc_endpoint:`https://${host}/bindle/rpc`,discovery_endpoint:`https://${host}/bindle/resources`,contracts},extensions:slots.map((slot,i)=>({slot,role:'occupant',ref:'r'+i})),...required?{setup:{fragments:[{fragment:'https://spec.bindle.example/preferences/setup/v1',required:true,purpose:'Settings.',fields:['store']}]}}:{}};
 const r=validateIntegrationManifest(raw,{clientId,confidential:true,redirectUris,jwksUri});assert.equal(r.status,'valid',r.reason);
 return {client:{id:clientId,name:host},snapshot:{clientId,redirectUris,authMethod:'private_key_jwt',jwksUri,thumbprints:['A'.repeat(43)],manifest:r.manifest}};
}
async function engineFixture({enabled=true,account=async()=>({status:'active'}),clock=fakeClock(Date.UTC(2026,9,20,12))}={}){
 const metadata=new SqliteMetadata(':memory:');await metadata.put('owner',OWNER);
 let n=0;const connections=new AppConnections({metadata,origin:ISSUER,clock:clock.now,slots:SLOTS,builtins:BUILTINS,uuid:()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`});
 const engine=createAppEngine({providers:{clock,random:{uuid:()=>crypto.randomUUID(),bytes:k=>crypto.getRandomValues(new Uint8Array(k))},audit:memoryAudit({clock}),connections:C.connectionsProvider({connections,enabled,account})}});
 const owner={kind:'owner',owner:OWNER,authTime:clock.now()},system={kind:'system',owner:OWNER};
 const op=(Operation,actor,input)=>{const o=new Operation({actor,...input===undefined?{}:{input}});return o instanceof C.SlotOccupant||o instanceof C.ConnectionList||o instanceof C.SlotList||o instanceof C.SlotOperation||o instanceof C.ConnectionOutbox||o instanceof C.ConnectionCascades?read(engine,o):perform(engine,o);};
 const connect=async(host,options)=>{const s=snapshot(host,options);return op(C.ConnectIntegration,system,s);};
 const occupant=slot=>op(C.SlotOccupant,system,{slot});
 return {metadata,connections,engine,clock,owner,system,op,connect,occupant,dispose:()=>metadata.close()};
}

test('flag off: the domain is not_found, the controller entry refuses, and legacy connections write no X4 state', async t=>{
 const f=await engineFixture({enabled:false});t.after(f.dispose);
 await assert.rejects(f.op(C.ConnectionList,f.owner),code('not_found'));
 await assert.rejects(f.connect('box.example'),code('not_found'));
 const c=await account(t,{INTEGRATIONS_ENABLED:'false'});
 await assert.rejects(c.account.connectionsOwner(OWNER,{operation:'connections.list'}),code('not_found'));
 assert.equal(await c.account.linkSlotOccupant({owner:OWNER,slot:MESSAGING_INGRESS_SLOT}),null);
 const app=await c.account.appBindleConnect(OWNER,{id:'https://legacy.example/client.json',name:'Legacy',origin:'https://legacy.example'},0);
 assert.equal(app.state,undefined);assert.equal(app.status,'active');assert.equal(app.generation,1);
 await c.account.appConnectionCheck(OWNER,app.id,1,'https://legacy.example/client.json');
 const gone=await c.account.appDisconnect(OWNER,app.id);assert.equal(gone.app.status,'disconnected');assert.equal(gone.app.state,undefined);assert.equal(gone.app.generation,2);
 assert.equal((await c.db.list({prefix:'connections/'})).size,0,'no outbox, cascade or slot rows for legacy connections');
 await assert.rejects(c.account.appConnectionCheck(OWNER,app.id,1),code('invalid_token'));
 const again=await c.account.appBindleConnect(OWNER,{id:'https://legacy.example/client.json',name:'Legacy',origin:'https://legacy.example'},2);assert.equal(again.generation,3);
});

test('lifecycle: configuring -> active -> degraded -> suspended -> resumed -> disconnected, with generations and derived status', async t=>{
 const f=await engineFixture();t.after(f.dispose);
 const a=await f.connect('box.example',{required:true});
 assert.deepEqual([a.state,a.status,a.generation,a.integration.kind],['configuring','active',1,'external']);
 await f.connections.check(OWNER,a.id,1,a.clientId);// configuring may read approved fragments (integrations §3.1)
 const ready=await f.op(C.ConnectionConfigured,f.system,{connection:a.id,expectedGeneration:1,configured:true});assert.equal(ready.state,'active');
 const sick=await f.op(C.ConnectionHealth,f.system,{connection:a.id,expectedGeneration:1,degraded:true});assert.deepEqual([sick.state,sick.status,sick.generation],['degraded','active',1]);
 await f.op(C.ConnectionHealth,f.system,{connection:a.id,expectedGeneration:1,degraded:false});
 const paused=await f.op(C.SuspendConnection,f.owner,{connection:a.id});assert.deepEqual([paused.state,paused.status,paused.generation],['suspended','suspended',2]);
 await assert.rejects(f.connections.check(OWNER,a.id,2,a.clientId),code('invalid_token'),'suspended is equivalent to disconnected for authority');
 // An authorization never resumes: only the owner, from the provider interface, with the generation they saw.
 await assert.rejects(f.connections.register(OWNER,{id:a.clientId,name:'x',origin:'https://box.example'},undefined,{transport:'bindle'}),code('connection_suspended'));
 await assert.rejects(f.op(C.ResumeConnection,f.owner,{connection:a.id}),code('invalid_request'));
 await assert.rejects(f.op(C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:1}),code('connection_stale'));
 const back=await f.op(C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:2});assert.deepEqual([back.state,back.generation],['active',3]);
 const gone=await f.op(C.DisconnectConnection,f.owner,{connection:a.id});assert.deepEqual([gone.app.state,gone.app.status,gone.app.generation],['disconnected','disconnected',4]);
 await assert.rejects(f.op(C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:4}),code('connection_disconnected'));
 const fresh=await f.connect('box.example');assert.deepEqual([fresh.state,fresh.generation],['active',5],'reconnect is a new generation');
 // Owner-only and system-only operations do not cross.
 await assert.rejects(f.op(C.ConnectIntegration,f.owner,snapshot('x.example')),code('forbidden'));
 await assert.rejects(f.op(C.SuspendConnection,f.system,{connection:a.id}),code('forbidden'));
 await assert.rejects(f.op(C.SeverAccountConnections,f.owner,{reason:'suspended'}),code('forbidden'));
 await assert.rejects(f.op(C.ConnectionList,{kind:'owner',owner:OTHER}),code('forbidden'),'the store is bound to another owner');
});

test('generation fencing: stale system and owner operations are refused, and old seats never serve a new generation', async t=>{
 const f=await engineFixture();t.after(f.dispose);
 const a=await f.connect('box.example');
 const seated=await f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:a.id,purposes:ALL});const seat=seated.occupants[0].seat;
 const before=(await f.occupant(MESSAGING_INGRESS_SLOT)).occupants[0];assert.equal(before.cnx,`${seat}.1`);
 await f.op(C.SuspendConnection,f.owner,{connection:a.id,expectedGeneration:1});
 assert.deepEqual((await f.occupant(MESSAGING_INGRESS_SLOT)).occupants,[],'a suspended occupant is unavailable');
 for(const [Operation,input] of [[C.ConnectionHealth,{degraded:true}],[C.ConnectionConfigured,{configured:true}],[C.ConnectionRevalidated,{result:{decision:'unchanged',changes:[]}}]])
  await assert.rejects(f.op(Operation,f.system,{connection:a.id,expectedGeneration:1,...input}),code('connection_stale'),Operation.operation);
 await assert.rejects(f.op(C.SetSeatIngress,f.system,{slot:MESSAGING_INGRESS_SLOT,seat,generation:1,ingress:'https://box.example/ingress'}),code('connection_stale'));
 await assert.rejects(f.op(C.DisconnectConnection,f.owner,{connection:a.id,expectedGeneration:1}),code('connection_stale'));
 await f.op(C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:2});
 const after=(await f.occupant(MESSAGING_INGRESS_SLOT)).occupants[0];
 assert.equal(after.seat,seat,'configuration is retained across suspension');assert.equal(after.cnx,`${seat}.3`,'but the incarnation changed');
 await assert.rejects(f.op(C.SetSeatIngress,f.system,{slot:MESSAGING_INGRESS_SLOT,seat,generation:1,ingress:'https://box.example/ingress'}),code('connection_stale'));
 await assert.rejects(f.op(C.SetSeatIngress,f.system,{slot:MESSAGING_INGRESS_SLOT,seat,generation:3,ingress:'https://evil.example/ingress'}),code('invalid_request'),'ingress stays on the app origin');
 const set=await f.op(C.SetSeatIngress,f.system,{slot:MESSAGING_INGRESS_SLOT,seat,generation:3,ingress:'https://box.example/ingress'});assert.equal(set.occupants[0].ingress,'https://box.example/ingress');
 await f.op(C.DisconnectConnection,f.owner,{connection:a.id});
 const reconnected=await f.connect('box.example');assert.equal(reconnected.generation,5);
 assert.deepEqual((await f.op(C.SlotList,f.owner)).find(s=>s.slot===MESSAGING_INGRESS_SLOT).occupants,[],'disconnect vacates; reconnect revives nothing');
 assert.equal(await f.occupant(MESSAGING_INGRESS_SLOT).then(r=>r.occupants.length),0);
});

test('occupancy: exclusive needs explicit, recently authenticated replacement; declarations and live state gate every seat', async t=>{
 const f=await engineFixture();t.after(f.dispose);
 const a=await f.connect('box.example'),b=await f.connect('other.example'),plain=await f.connect('plain.example',{slots:[],contracts:[MAILBOX]});
 const legacy=await f.connections.register(OWNER,{id:'https://legacy.example/client.json',name:'Legacy',origin:'https://legacy.example'},undefined,{transport:'bindle'});
 await assert.rejects(f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:plain.id}),code('not_an_occupant'),'no occupant declaration');
 await assert.rejects(f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:legacy.id}),code('not_an_occupant'),'legacy apps have no manifest');
 await assert.rejects(f.op(C.OccupySlot,f.owner,{slot:'https://spec.bindle.example/slots/unknown/v1',connection:a.id}),code('unsupported_slot'));
 const wrong=await f.connect('wrong.example',{contracts:[MODEL]});
 await assert.rejects(f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:wrong.id}),code('not_an_occupant'),'required contracts are not offered');
 await f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:a.id});
 await assert.rejects(f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:b.id}),code('slot_occupied'),'a new connection never displaces the occupant');
 await assert.rejects(f.op(C.OccupySlot,{kind:'owner',owner:OWNER},{slot:MESSAGING_INGRESS_SLOT,connection:b.id,replace:true}),code('reauthentication_required'));
 await assert.rejects(f.op(C.OccupySlot,{kind:'owner',owner:OWNER,authTime:f.clock.now()-16*60000},{slot:MESSAGING_INGRESS_SLOT,connection:b.id,replace:true}),code('reauthentication_required'));
 const replaced=await f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:b.id,replace:true});
 assert.deepEqual(replaced.occupants.map(o=>o.clientId),[b.clientId]);assert.equal(replaced.selection,'exclusive');assert.equal(replaced.host,'spec.bindle.example');
 assert.equal((await f.occupant(MESSAGING_INGRESS_SLOT)).occupants[0].clientId,b.clientId);
 await f.op(C.SuspendConnection,f.owner,{connection:a.id});
 await assert.rejects(f.op(C.OccupySlot,f.owner,{slot:ORDERED.id,connection:a.id}),code('connection_unavailable'));
 const cascades=await f.op(C.ConnectionCascades,f.system);
 assert.ok(cascades.some(r=>r.kind==='delegations'&&r.clientId===a.clientId),'replacing the messaging occupant revokes its delegations');
});

test('occupancy under ordered, broadcast and consumer-choice drives the extensions selection machine', async t=>{
 const f=await engineFixture();t.after(f.dispose);
 const x=await f.connect('x.example',{slots:[ORDERED.id,BROADCAST.id,CHOICE.id],contracts:[MODEL]}),y=await f.connect('y.example',{slots:[ORDERED.id,BROADCAST.id,CHOICE.id],contracts:[MODEL]});
 const builtin=await f.op(C.ConnectBuiltIn,f.owner,{integration:'classifier'});assert.deepEqual([builtin.integration.kind,builtin.state,builtin.clientId],['built-in','active',`${ISSUER}/integrations/classifier`]);
 await assert.rejects(f.op(C.ConnectBuiltIn,f.owner,{integration:'drive'}),code('not_found'));
 // ordered: owner order with insert positions, capped by the slot's max; duplicates refused; reorder is a permutation.
 await f.op(C.OccupySlot,f.owner,{slot:ORDERED.id,connection:x.id});
 await f.op(C.OccupySlot,f.owner,{slot:ORDERED.id,connection:builtin.id,position:0});
 let view=await f.op(C.OccupySlot,f.owner,{slot:ORDERED.id,connection:y.id,resource:'model-1',position:1});
 assert.deepEqual(view.occupants.map(o=>o.clientId),[builtin.clientId,y.clientId,x.clientId]);
 await assert.rejects(f.op(C.OccupySlot,f.owner,{slot:ORDERED.id,connection:y.id,resource:'model-2'}),code('slot_full'));
 await assert.rejects(f.op(C.ReorderSlot,f.owner,{slot:ORDERED.id,seats:[view.occupants[0].seat]}),code('invalid_request'));
 await assert.rejects(f.op(C.ReorderSlot,f.owner,{slot:ORDERED.id,seats:view.occupants.map(o=>o.seat),expectedRevision:1}),code('slot_changed'));
 view=await f.op(C.ReorderSlot,f.owner,{slot:ORDERED.id,seats:[view.occupants[2].seat,view.occupants[0].seat,view.occupants[1].seat],expectedRevision:view.revision});
 assert.deepEqual(view.occupants.map(o=>o.clientId),[x.clientId,builtin.clientId,y.clientId]);
 await f.op(C.SuspendConnection,f.owner,{connection:x.id});// the first occupant becomes unavailable
 let state=await f.op(C.SlotOperation,f.owner,{slot:ORDERED.id,consumer:'application'});
 let step=nextSlotDispatch(state,{tx:crypto.randomUUID()});assert.equal(step.dispatch.occupant.id,view.occupants[1].seat,'ordered skips the unavailable occupant');
 state=recordSlotOutcome(step.state,{tx:step.dispatch.tx,httpStatus:503});assert.equal(nextSlotDispatch(state,{tx:crypto.randomUUID()}).dispatch,null,'pre-dispatch failover never advances after an ambiguous outcome');
 // broadcast: every available occupant, per-occupant outcomes.
 await f.op(C.OccupySlot,f.owner,{slot:BROADCAST.id,connection:y.id});await f.op(C.OccupySlot,f.owner,{slot:BROADCAST.id,connection:builtin.id});
 state=await f.op(C.SlotOperation,f.owner,{slot:BROADCAST.id,consumer:'provider',featureEnabled:true});
 const sent=[];for(;;){const s=nextSlotDispatch(state,{tx:crypto.randomUUID()});if(!s.dispatch)break;sent.push(s.dispatch.occupant.id);state=recordSlotOutcome(s.state,{tx:s.dispatch.tx,ok:true});}
 assert.equal(sent.length,2);assert.equal(slotOperationResult(state).status,'succeeded');
 // consumer-choice: the consumer picks among available occupants; nothing is chosen for it.
 await f.op(C.OccupySlot,f.owner,{slot:CHOICE.id,connection:y.id});const pick=await f.op(C.OccupySlot,f.owner,{slot:CHOICE.id,connection:builtin.id});
 state=await f.op(C.SlotOperation,f.owner,{slot:CHOICE.id,consumer:'application'});
 assert.equal(nextSlotDispatch(state,{tx:crypto.randomUUID()}).dispatch,null);
 assert.equal(nextSlotDispatch(state,{tx:crypto.randomUUID(),choice:pick.occupants[1].seat}).dispatch.occupant.id,pick.occupants[1].seat);
 // Vacate removes one seat and records the event; the exclusive-only ports never answer for multi-occupant slots.
 const left=await f.op(C.VacateSlot,f.owner,{slot:CHOICE.id,seat:pick.occupants[0].seat});assert.deepEqual(left.occupants.map(o=>o.clientId),[builtin.clientId]);
 const {events}=await f.op(C.ConnectionOutbox,f.system,{after:0,limit:500});
 assert.ok(events.some(e=>e.type==='occupant-removed'&&e.slot===CHOICE.id&&e.clientId===y.clientId));
 assert.deepEqual(events.map(e=>e.seq),[...events.map(e=>e.seq)].sort((a,b)=>a-b));
});

test('X3 revalidation: invalid and security-relevant changes fence the connection; clearing or owner approval starts a new generation', async t=>{
 const f=await engineFixture();t.after(f.dispose);
 const a=await f.connect('box.example');await f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:a.id,purposes:ALL});
 const pinned=a.integration.snapshot;
 const narrowed=structuredClone(pinned);narrowed.manifest.resources.contracts=[MAILBOX];// no-op adoption keeps the seat
 let r=await f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:1,result:{decision:'adopt',changes:['management_url_changed'],next:narrowed}});assert.equal(r.state,'active');
 r=await f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:1,result:{decision:'invalid',changes:['client_gone']}});
 assert.deepEqual([r.state,r.status,r.generation],['manifest-invalid','suspended',2]);assert.deepEqual((await f.occupant(MESSAGING_INGRESS_SLOT)).occupants,[]);
 r=await f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:2,result:{decision:'unchanged',changes:[]}});
 assert.deepEqual([r.state,r.generation],['active',3]);assert.equal((await f.occupant(MESSAGING_INGRESS_SLOT)).occupants[0].cnx.endsWith('.3'),true);
 // A takeover-style key replacement stages the change and fences; only the owner's approval resumes.
 const staged=structuredClone(pinned);staged.thumbprints=['B'.repeat(43)];
 r=await f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:3,result:{decision:'review',changes:['keys_replaced'],next:pinned,staged}});
 assert.deepEqual([r.state,r.generation],['manifest-invalid',4]);
 await assert.rejects(f.op(C.ApproveConnectionChange,f.owner,{connection:a.id,expectedGeneration:3}),code('connection_stale'));
 r=await f.op(C.ApproveConnectionChange,f.owner,{connection:a.id,expectedGeneration:4});
 assert.deepEqual([r.state,r.generation,r.integration.snapshot.thumbprints],['active',5,['B'.repeat(43)]]);
 // A snapshot that does not re-derive from its own client members (an off-prefix endpoint) never validates.
 const forged=structuredClone(pinned);forged.manifest.resources.rpc_endpoint='https://evil.example/rpc';
 await assert.rejects(f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:5,result:{decision:'adopt',changes:[],next:forged}}),code('invalid_request'));
 await assert.rejects(f.connect('3sln.example'),code('invalid_integration'),'issuer-origin integrations are refused');
 // A manifest that drops the occupant declaration loses its seat on adoption.
 const dropped=snapshot('box.example',{slots:[]}).snapshot;dropped.thumbprints=['B'.repeat(43)];
 await f.op(C.ApproveConnectionChange,f.owner,{connection:a.id,expectedGeneration:5}).catch(()=>{});
 await f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:5,result:{decision:'review',changes:['extensions_changed'],next:r.integration.snapshot,staged:dropped}});
 r=await f.op(C.ApproveConnectionChange,f.owner,{connection:a.id,expectedGeneration:5});assert.equal(r.state,'active');
 assert.deepEqual((await f.occupant(MESSAGING_INGRESS_SLOT)).occupants,[]);
});

test('outbox: ordered events, acknowledgment and gap detection', async t=>{
 const f=await engineFixture();t.after(f.dispose);
 const a=await f.connect('box.example');await f.op(C.SuspendConnection,f.owner,{connection:a.id});await f.op(C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:2});await f.op(C.DisconnectConnection,f.owner,{connection:a.id});
 const {events,seq}=await f.op(C.ConnectionOutbox,f.system,{});
 assert.deepEqual(events.map(e=>[e.type,e.generation,e.terminal]),[['connection-activated',1,undefined],['connection-revoked',2,false],['connection-resumed',3,undefined],['connection-revoked',4,true]]);
 await f.op(C.AckConnectionOutbox,f.system,{through:2});
 const rest=await f.op(C.ConnectionOutbox,f.system,{after:0});assert.deepEqual(rest.events.map(e=>e.seq),[3,4]);assert.equal(rest.gap,true,'a reader behind the acknowledged floor must resync');assert.equal(rest.seq,seq);
 assert.equal((await f.op(C.ConnectionOutbox,f.system,{after:2})).gap,false);
});

test('concurrency (seeded): one exclusive winner, suspend vs occupy, and disconnect vs port reads stay consistent', async t=>{
 await forEachSeed(8,async random=>{
  const f=await engineFixture();
  try{
   const conns=[];for(const host of random.shuffle(['a.example','b.example','c.example']))conns.push(await f.connect(host));
   const results=await concurrently(random.shuffle(conns).map(c=>()=>f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:c.id})));
   assert.deepEqual(tally(results,()=>'ok'),{ok:1,slot_occupied:2});
   const holder=(await f.occupant(MESSAGING_INGRESS_SLOT)).occupants[0],holderId=conns.find(c=>c.clientId===holder.clientId).id;
   // Suspend racing a re-seat attempt and port reads: never an available occupant of a non-current generation.
   const race=await concurrently(random.shuffle([()=>f.op(C.SuspendConnection,f.owner,{connection:holderId}),()=>f.op(C.OccupySlot,f.owner,{slot:ORDERED.id,connection:holderId}).catch(e=>e.code),()=>f.occupant(MESSAGING_INGRESS_SLOT)]));
   assert.equal(race.filter(r=>r.status==='rejected').length,0);
   assert.deepEqual((await f.occupant(MESSAGING_INGRESS_SLOT)).occupants,[]);
   const after=await concurrently(random.shuffle([()=>f.op(C.DisconnectConnection,f.owner,{connection:holderId}),()=>f.op(C.ResumeConnection,f.owner,{connection:holderId,expectedGeneration:2}),()=>f.occupant(MESSAGING_INGRESS_SLOT)]));
   const record=await f.metadata.get('resource/'+holderId);assert.equal(record.state,'disconnected');
   assert.ok(after.every(r=>r.status==='fulfilled'||['connection_disconnected','connection_stale'].includes(r.reason.code)),JSON.stringify(after.map(r=>r.reason?.code)));
   assert.deepEqual((await f.occupant(MESSAGING_INGRESS_SLOT)).occupants,[],'a disconnect always wins over a racing resume');
   const gens=(await f.op(C.ConnectionOutbox,f.system,{limit:500})).events.filter(e=>e.connection===holderId&&e.type.startsWith('connection-')).map(e=>e.generation);
   assert.deepEqual(gens,[...gens].sort((a,b)=>a-b),'events carry monotonic generations');
  }finally{f.dispose();}
 });
});

// ---- The ports and the KD-4 cascades on the real AccountController ----
async function account(t,overrides={}){
 const db=new SqliteMetadata(':memory:');t.after(()=>db.close());const identity={status:'active'};
 const config={APP_ORIGIN:ISSUER,KEY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),INTEGRATIONS_ENABLED:'true',BINDLEBOX_ENABLED:'true',IDENTITY_ACCOUNT:async owner=>owner===OWNER?{status:identity.status,handle:'alice'}:null,...overrides};
 const bucket={put:async()=>{},get:async()=>null,delete:async()=>{}};
 const a=new AccountController({metadata:db,gate:new SerialGate(),blobs:bucket,archives:bucket,config,sql:db.sql});await a.touch(OWNER);
 const sys=(operation,input)=>a.connectionsSystem(OWNER,{operation,input}),own=(operation,input,authTime=Date.now())=>a.connectionsOwner(OWNER,{operation,input},{authTime});
 const install=async host=>{const s=snapshot(host);const c=await sys('connections.connect',s);const seat=(await own('connections.occupy',{slot:MESSAGING_INGRESS_SLOT,connection:c.id,purposes:ALL,replace:true})).occupants[0];await sys('connections.set-ingress',{slot:MESSAGING_INGRESS_SLOT,seat:seat.seat,generation:c.generation,ingress:`https://${host}/ingress`});return {...c,seat:seat.seat};};
 const key=async()=>{const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey);const jwk={kty,crv,x,y};return {...pair,jwk,jkt:await jwkThumbprint(jwk)};};
 const issue=async(clientId,k)=>a.delegationOperation(OWNER,{actor:{kind:'app',owner:OWNER,clientId},operation:'delegations.issue',input:{delegate:k.jwk,purposes:ALL,proof:await signDelegationPop({privateKey:k.privateKey,issuer:ISSUER,clientId,jkt:k.jkt,subject:OWNER,iat:Math.floor(Date.now()/1000)})}});
 const links=clientId=>a.linkOperation(OWNER,{actor:{kind:'app',owner:OWNER,clientId,handle:'alice'},operation:'links.list'});
 const delegations=async()=>(await a.listDelegations(OWNER)).delegations;
 return {db,account:a,identity,sys,own,install,key,issue,links,delegations};
}

test('ports: the messaging-ingress occupant is certified and holds link authority; nobody else does', async t=>{
 const c=await account(t),app=await c.install('box.example');
 assert.deepEqual(await c.account.delegationSlotOccupant({owner:OWNER,slot:MESSAGING_INGRESS_SLOT}),{clientId:app.clientId,origin:'https://box.example',ingress:'https://box.example/ingress',cnx:`${app.seat}.1`,purposes:ALL});
 assert.equal(await c.account.delegationSlotOccupant({owner:OTHER,slot:MESSAGING_INGRESS_SLOT}),null,'another owner is never answered');
 assert.equal(await c.account.linkSlotOccupant({owner:OWNER,slot:'https://spec.bindle.example/slots/unknown/v1'}),null);
 const k=await c.key(),issued=await c.issue(app.clientId,k);assert.equal(issued.purposes.length,3);
 assert.deepEqual(await c.links(app.clientId),{links:[]});
 await assert.rejects(c.links('https://evil.example/client.json'),code('forbidden'));
 await assert.rejects(c.issue('https://evil.example/client.json',await c.key()),code('forbidden'));
 // Withdrawing a consented purpose reconciles at once (KD-2 through the cascade).
 await c.own('connections.configure-seat',{slot:MESSAGING_INGRESS_SLOT,seat:app.seat,purposes:[DELEGATION_PURPOSES.author]});
 assert.equal((await c.delegations()).find(d=>d.jkt===k.jkt).state,'revoked');
});

test('KD-4 cascades: disconnect (owner route and legacy route), suspension, vacate and replacement revoke delegations and link authority', async t=>{
 // Owner disconnect through the connections domain.
 let c=await account(t),app=await c.install('box.example'),k=await c.key();await c.issue(app.clientId,k);
 await c.own('connections.disconnect',{connection:app.id});
 let record=(await c.delegations()).find(d=>d.jkt===k.jkt);assert.deepEqual([record.state,record.reason],['revoked','uninstalled']);
 await assert.rejects(c.links(app.clientId),code('forbidden'));assert.equal((await c.account.delegationStatus(OWNER,k.jkt)).status,'revoked');
 assert.equal((await c.db.list({prefix:'connections/cascade/'})).size,0,'drained');
 // The legacy disconnect route (/api/apps, deleteResource) cascades through the severed hook.
 c=await account(t);app=await c.install('box.example');k=await c.key();await c.issue(app.clientId,k);
 await c.account.appDisconnect(OWNER,app.id);
 record=(await c.delegations()).find(d=>d.jkt===k.jkt);assert.deepEqual([record.state,record.reason],['revoked','uninstalled']);
 c=await account(t);app=await c.install('box.example');k=await c.key();await c.issue(app.clientId,k);
 await c.account.deleteResource(OWNER,app.id);assert.equal((await c.delegations()).find(d=>d.jkt===k.jkt).state,'revoked');
 // Owner suspension: revoked; resume gives a new cnx, the old key never revives, and a new key is certified.
 c=await account(t);app=await c.install('box.example');k=await c.key();await c.issue(app.clientId,k);
 await c.own('connections.suspend',{connection:app.id});
 assert.equal((await c.delegations()).find(d=>d.jkt===k.jkt).state,'revoked');await assert.rejects(c.links(app.clientId),code('forbidden'));
 await c.own('connections.resume',{connection:app.id,expectedGeneration:2});
 await assert.rejects(c.issue(app.clientId,k),code('delegation_revoked'));
 assert.equal((await c.account.delegationSlotOccupant({owner:OWNER,slot:MESSAGING_INGRESS_SLOT})).cnx,`${app.seat}.3`,'seat configuration is retained under a new incarnation');
 const fresh=await c.key(),renewed=await c.issue(app.clientId,fresh);assert.ok(renewed.certificate);assert.deepEqual(await c.links(app.clientId),{links:[]});
 // Vacate, then replacement by another app with recent authentication.
 await c.own('connections.vacate',{slot:MESSAGING_INGRESS_SLOT,seat:app.seat});
 assert.equal((await c.delegations()).find(d=>d.jkt===fresh.jkt).state,'revoked');await assert.rejects(c.links(app.clientId),code('forbidden'));
 c=await account(t);app=await c.install('box.example');k=await c.key();await c.issue(app.clientId,k);
 const other=await c.install('other.example');
 assert.equal((await c.delegations()).find(d=>d.jkt===k.jkt).state,'revoked');await assert.rejects(c.links(app.clientId),code('forbidden'));
 assert.deepEqual(await c.links(other.clientId),{links:[]});
});

test('KD-4 account suspension: the hook, the directory status and the lifecycle epoch each sever every connection and revoke every delegation', async t=>{
 // 1. The registered hook (lifecycle/admin paths call connectionsSeverAccount).
 let c=await account(t),app=await c.install('box.example'),k=await c.key();await c.issue(app.clientId,k);
 const second=await c.sys('connections.connect',snapshot('second.example'));
 assert.deepEqual(await c.account.invoke({method:'connectionsSeverAccount',args:[OWNER,{reason:'suspended'}]}),{severed:2});
 let record=(await c.delegations()).find(d=>d.jkt===k.jkt);assert.deepEqual([record.state,record.reason],['revoked','suspended']);
 for(const id of [app.id,second.id])assert.equal((await c.db.get('resource/'+id)).state,'disconnected');
 await assert.rejects(c.links(app.clientId),code('forbidden'));
 // 2. Directory status observed by the public status port, then reactivation: nothing revives.
 c=await account(t);app=await c.install('box.example');k=await c.key();await c.issue(app.clientId,k);
 c.identity.status='suspended';
 assert.equal((await c.account.delegationStatus(OWNER,k.jkt)).status,'revoked');
 c.identity.status='active';
 assert.equal((await c.account.delegationStatus(OWNER,k.jkt)).status,'revoked');
 record=(await c.delegations()).find(d=>d.jkt===k.jkt);assert.equal(record.state,'revoked');
 assert.equal((await c.db.get('resource/'+app.id)).state,'disconnected');await assert.rejects(c.links(app.clientId),code('forbidden'));
 // 3. A lifecycle suspension that ended before anyone looked: the capability epoch moved.
 c=await account(t);app=await c.install('box.example');k=await c.key();await c.issue(app.clientId,k);
 await c.db.put('lifecycle/state-v1',{version:1,owner:OWNER,phase:'active',generation:3,capabilityEpoch:2});
 assert.equal((await c.account.delegationStatus(OWNER,k.jkt)).status,'revoked');
 assert.equal((await c.delegations()).find(d=>d.jkt===k.jkt).reason,'suspended');assert.equal((await c.db.get('resource/'+app.id)).state,'disconnected');
 // 4. A failing directory is an error, never an occupant, and severs nothing.
 c=await account(t,{IDENTITY_ACCOUNT:async()=>{throw new Error('down');}});app=await c.install('box.example');
 await assert.rejects(c.account.delegationSlotOccupant({owner:OWNER,slot:MESSAGING_INGRESS_SLOT}));
 assert.equal((await c.db.get('resource/'+app.id)).state,'active');
});

test('migration: legacy records read as active/disconnected, are migrated on first X4 transition, and stay fenced with the flag off', async t=>{
 const c=await account(t);
 const legacy=await c.account.appBindleConnect(OWNER,{id:'https://legacy.example/client.json',name:'Legacy',origin:'https://legacy.example'},0);
 assert.equal(legacy.state,undefined);
 const listed=(await c.own('connections.list')).connections.find(x=>x.id===legacy.id);assert.equal(listed.status,'active');
 const paused=await c.own('connections.suspend',{connection:legacy.id});assert.deepEqual([paused.state,paused.status,paused.generation],['suspended','suspended',2]);
 // Turning the flag off never revives a paused connection through a legacy re-authorization.
 const off=new AccountController({metadata:c.db,gate:new SerialGate(),blobs:{},archives:{},config:{APP_ORIGIN:ISSUER,KEY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')},sql:c.db.sql});
 await assert.rejects(off.appBindleConnect(OWNER,{id:'https://legacy.example/client.json',name:'Legacy',origin:'https://legacy.example'},2),code('connection_suspended'));
 await assert.rejects(off.appConnectionCheck(OWNER,legacy.id,2),code('invalid_token'));
 const gone=await off.appDisconnect(OWNER,legacy.id);assert.deepEqual([gone.app.state,gone.app.status,gone.app.generation],['disconnected','disconnected',3]);
 const back=await off.appBindleConnect(OWNER,{id:'https://legacy.example/client.json',name:'Legacy',origin:'https://legacy.example'},3);assert.equal(back.generation,4);assert.equal(back.state,undefined,'a fresh legacy authorization is a legacy record again');
 // A same-incarnation re-approval keeps X4 fields instead of dropping them.
 const integ=await c.sys('connections.connect',snapshot('box.example'));
 const reapproved=await c.account.appBindleConnect(OWNER,{id:integ.clientId,name:'box',origin:'https://box.example'},integ.generation);
 assert.equal(reapproved.state,'active');assert.equal(reapproved.integration.kind,'external');
});

test('the recognized slots include the BindleBox ingress and canonical classifier manifests', ()=>{
 assert.deepEqual(Object.keys(RECOGNIZED_SLOTS),[MESSAGING_INGRESS_SLOT,'https://3sln.me/artefacts/slots/item-classifier/v1']);
 assert.equal(MESSAGING_INGRESS_MANIFEST.slot.selection,'exclusive');assert.deepEqual(MESSAGING_INGRESS_MANIFEST.slot.consumers,['provider']);
 assert.ok(C.CONNECTION_OWNER_OPERATIONS.every(name=>C.CONNECTION_OPERATIONS.some(O=>O.operation===name)));
});

test('review X4-R1..R6 regressions: no re-entrant drain loop, fence laundering, silent re-consent, foreign origin, stale stage or configuring gap', async t=>{
 // R1: a pending reconcile while the lifecycle is blocked drains once, without recursion, and revokes.
 let c=await account(t),app=await c.install('box.example'),k=await c.key();await c.issue(app.clientId,k);
 await c.db.put('lifecycle/state-v1',{version:1,owner:OWNER,phase:'suspended',generation:2,capabilityEpoch:1});
 await assert.rejects(c.sys('connections.set-ingress',{slot:MESSAGING_INGRESS_SLOT,seat:app.seat,generation:1,ingress:'https://box.example/in2'}),code('account_suspended'));
 await c.db.put('connections/cascade/0000000000000099',{kind:'reconcile',at:1});
 assert.equal((await c.account.delegationStatus(OWNER,k.jkt)).status,'revoked');
 assert.equal((await c.db.list({prefix:'connections/cascade/'})).size,0);
 const writes=(await c.db.get('connections/meta')).seq;await c.account.delegationSlotOccupant({owner:OWNER,slot:MESSAGING_INGRESS_SLOT});
 assert.equal((await c.db.get('connections/meta')).seq,writes,'repeated port reads while blocked write nothing');
 // R2: an unseated connection fails its RPC check after a missed suspension; a paused one cannot resume past it.
 c=await account(t);const unseated=await c.sys('connections.connect',snapshot('plain.example')),paused=await c.install('box.example');
 await c.own('connections.suspend',{connection:paused.id});
 await c.db.put('lifecycle/state-v1',{version:1,owner:OWNER,phase:'active',generation:3,capabilityEpoch:2});
 await assert.rejects(c.account.appConnectionCheck(OWNER,unseated.id,unseated.generation),code('invalid_token'));
 const resumed=await c.own('connections.resume',{connection:paused.id,expectedGeneration:2});assert.equal(resumed.state,'disconnected');
 assert.equal((await c.db.get('resource/'+unseated.id)).state,'disconnected');
 // R3: re-consent with a changed snapshot is a new generation and drops seats it no longer qualifies for.
 c=await account(t);app=await c.install('box.example');k=await c.key();await c.issue(app.clientId,k);
 const narrowed=await c.sys('connections.connect',snapshot('box.example',{slots:[]}));assert.equal(narrowed.generation,2);
 assert.equal(await c.account.delegationSlotOccupant({owner:OWNER,slot:MESSAGING_INGRESS_SLOT}),null);assert.equal((await c.delegations()).find(d=>d.jkt===k.jkt).state,'revoked');
 // R4: the origin must be the client_id origin.
 const s=snapshot('evil-origin.example');s.client.origin='https://other.example';await assert.rejects(c.sys('connections.connect',s),code('invalid_request'));
 // R5: an invalid manifest discards any earlier stage, so approval cannot revive it.
 const f=await engineFixture();t.after(f.dispose);const a=await f.connect('box.example'),stage=structuredClone(a.integration.snapshot);stage.manifest.management_url='https://box.example/bindle/manage';
 await f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:1,result:{decision:'review',changes:['setup_changed'],staged:stage}});
 await f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:1,result:{decision:'invalid',changes:['client_gone']}});
 await assert.rejects(f.op(C.ApproveConnectionChange,f.owner,{connection:a.id,expectedGeneration:2}),code('invalid_state'));
 // R6: leaving SERVING through configured:false starts a new generation; returning re-seats under it.
 await f.op(C.ConnectionRevalidated,f.system,{connection:a.id,expectedGeneration:2,result:{decision:'unchanged',changes:[]}});
 await f.op(C.OccupySlot,f.owner,{slot:MESSAGING_INGRESS_SLOT,connection:a.id});
 const unready=await f.op(C.ConnectionConfigured,f.system,{connection:a.id,expectedGeneration:3,configured:false});assert.deepEqual([unready.state,unready.generation],['configuring',4]);
 assert.ok((await f.op(C.ConnectionCascades,f.system)).some(r=>r.clientId===a.clientId));
 await f.op(C.ConnectionConfigured,f.system,{connection:a.id,expectedGeneration:4,configured:true});
 assert.ok((await f.occupant(MESSAGING_INGRESS_SLOT)).occupants[0].cnx.endsWith('.4'));
});
