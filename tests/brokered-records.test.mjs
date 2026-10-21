// EXT-X7 brokered records (packages/federation/brokered.mjs) over the real X4 connection store: flag gating, actor
// separation, registration that trusts only authenticated lookups, stale generations and reconnects, cross-connection
// record mixups, revalidation, severance hooks, the C1b `describe` and its failure modes, the account slice with the
// real link handoff, health reporting and the owner routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppEngine,perform,read} from '../packages/app/engine.mjs';
import {memoryAudit} from '../packages/app/providers.mjs';
import {AppConnections} from '../packages/apps/connections.mjs';
import * as C from '../packages/app/domains/connections.mjs';
import * as B from '../packages/federation/brokered.mjs';
import {DiscoveryClient,DiscoveryBudget,createIntegrationEgress} from '../packages/federation/resource-discovery.mjs';
import {validateIntegrationManifest} from '../packages/federation/integrations.mjs';
import {brokeringKeys,mintAccessToken,verifyAccessToken} from '../packages/federation/signing.mjs';
import {MESSAGING_INGRESS_SLOT,MESSAGING_PROFILE,MESSAGING_CONTACT_LINK_TYPE} from '../packages/links/types.mjs';
import {LinkHandoff} from '../packages/links/handoff.mjs';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {messagingDescribe,stages} from '../packages/runtime/routes/integrations.mjs';
import {DELEGATION_PURPOSES} from '../packages/identity/delegation.mjs';
import {fakeClock} from './helpers/chaos.mjs';

const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ISSUER='https://3sln.example',SUBJECT=`${ISSUER}/entities/${OWNER}`;
const MAILBOX=B.MAILBOX_CONTRACT,MODEL='https://spec.bindle.example/contracts/decision-model/v1',FRAGMENT='https://notes.example/preferences/models/v1',APP='https://notes.example/client.json';
const ALL=Object.values(DELEGATION_PURPOSES).sort();
const code=c=>e=>{assert.equal(e.code,c,`expected ${c}, got ${e.code}: ${e.message}`);return true;};
const SECRET=Buffer.alloc(32,5).toString('base64');
function memory(){const map=new Map();let tail=Promise.resolve();return {transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},list:async()=>[]}));tail=run.catch(()=>{});return run;}};}
const DESCRIBE=host=>({version:1,profiles:[MESSAGING_PROFILE],ingress:`https://${host}/ingress`,limits:{maxParticipants:8,maxMessageBytes:65536,maxEnvelopeBytes:16384},kinds:['conversation-init','one-off']});

/** A validated approval snapshot for an external integration on `host` (X4 shape). */
function snapshot(host,{contracts=[MAILBOX,MODEL],slots=[MESSAGING_INGRESS_SLOT],dpop}={}){
 const clientId=`https://${host}/bindle/client.json`,redirectUris=[`https://${host}/bindle/callback`],jwksUri=`https://${host}/bindle/jwks.json`;
 const raw={v:1,resources:{rpc_endpoint:`https://${host}/bindle/rpc`,discovery_endpoint:`https://${host}/bindle/resources`,contracts,...dpop?{dpop}:{}},extensions:slots.map((slot,i)=>({slot,role:'occupant',ref:'r'+i}))};
 const r=validateIntegrationManifest(raw,{clientId,confidential:true,redirectUris,jwksUri});assert.equal(r.status,'valid',r.reason);
 return {client:{id:clientId,name:host},snapshot:{clientId,redirectUris,authMethod:'private_key_jwt',jwksUri,thumbprints:['A'.repeat(43)],manifest:r.manifest}};
}
/** A conforming test integration: verifies every provider JWT with the real brokering keys before answering. */
function stubIntegration(host,keys,{items=[{id:`https://${host}/r/mailbox`,label:'Mailbox',contracts:[MAILBOX,MODEL]}],describe=DESCRIBE(host)}={}){
 const s={items,describe,calls:[],tokens:[],answer:null,during:null};
 s.fetch=async(url,init)=>{
  const request=new Request(url,init),token=request.headers.get('authorization')?.slice(7),body=JSON.parse(init.body),path=new URL(url).pathname;s.calls.push({path,body});
  if(s.during)await s.during(path,body);
  let claims;try{({claims}=await verifyAccessToken(token,{keys:await keys.jwks(),issuer:ISSUER,audience:url,purposes:path.endsWith('/resources')?['discover']:['invoke','describe'],now:Date.now()}));}catch{return Response.json({error:'invalid_token'},{status:401});}
  s.tokens.push(claims);if(s.answer)return s.answer(path,body,claims);
  if(path.endsWith('/resources')){const found=s.items.filter(i=>body.contracts.every(c=>i.contracts.includes(c))&&(!body.ids||body.ids.includes(i.id))&&(!body.text||i.label.toLowerCase().includes(body.text.toLowerCase())));return body.limit===0?Response.json({v:1,items:[],exists:found.length>0}):Response.json({v:1,items:found.map(i=>({container:false,facets_applied:[],...i})),cursor:null});}
  return Response.json({version:'0',tx:body.tx,result:s.describe});
 };
 return s;
}
/** Engine fixture: the X4 connections engine and the X7 engine over one SQLite account store. */
async function fixture(t,{integrations=true,brokering=true,routes={}}={}){
 const metadata=new SqliteMetadata(':memory:');await metadata.put('owner',OWNER);t.after(()=>metadata.close());
 const clock=fakeClock(Date.now()),keys=brokeringKeys({issuer:ISSUER,secret:SECRET,metadata:memory()});let n=0;
 const connections=new AppConnections({metadata,origin:ISSUER,clock:clock.now,uuid:()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`});
 const random={uuid:()=>crypto.randomUUID(),bytes:k=>crypto.getRandomValues(new Uint8Array(k))};
 const cx=createAppEngine({providers:{clock,random,audit:memoryAudit({clock}),connections:C.connectionsProvider({connections,enabled:true,account:async()=>({status:'active'})})}});
 const route=(url,init)=>{const host=new URL(url).hostname;if(!routes[host])throw Object.assign(new Error('unrouted'),{code:'egress_refused'});return routes[host].fetch(url,init);};
 const discovery=new DiscoveryClient({issuer:ISSUER,mint:claims=>mintAccessToken(keys,claims),egress:createIntegrationEgress({fetcher:route,resolve:async()=>['93.184.216.34'],publicRouting:true}),budget:new DiscoveryBudget({budgets:{connectionPerMinute:1000,integrationPerMinute:1000}}),clock:clock.now});
 const audit=memoryAudit({clock});
 const engine=createAppEngine({providers:{clock,random,audit,brokeredResources:B.brokeredResourcesProvider({store:metadata,discovery,issuer:ISSUER,integrations,brokering,clock:clock.now})}});
 const owner={kind:'owner',owner:OWNER,authTime:clock.now()},system={kind:'system',owner:OWNER};
 const op=(Operation,actor,input)=>{const o=new Operation({actor,...input===undefined?{}:{input}});return o instanceof C.SlotOccupant||o instanceof C.ConnectionList||o instanceof C.SlotList?read(cx,o):o instanceof B.IntegrationCandidates||o instanceof B.DiscoverResources||o instanceof B.BrokeredRecords||o instanceof B.DescribeOccupant||o instanceof B.DescribeScoping||o instanceof B.MintableRecord||o instanceof B.BrokeredSeverance?read(engine,o):o.constructor.operation.startsWith('connections.')?perform(cx,o):perform(engine,o);};
 const connect=async(host,options)=>op(C.ConnectIntegration,system,snapshot(host,options));
 const integration=(host,options)=>{routes[host]=stubIntegration(host,keys,options);return routes[host];};
 const register=(connection,resource,extra={})=>op(B.RegisterBrokeredRecord,owner,{connection,resource,binding:{fragment:FRAGMENT,field:'model'},consumer:{clientId:APP},contracts:[MODEL],...extra});
 const seatFor=async(connection,record)=>{const slot=await op(C.OccupySlot,owner,{slot:MESSAGING_INGRESS_SLOT,connection,resource:record,purposes:ALL,replace:true});const port=await op(C.SlotOccupant,system,{slot:MESSAGING_INGRESS_SLOT});return port.occupants.find(o=>o.seat===slot.occupants[0].seat);};
 const describe=seat=>op(B.DescribeOccupant,system,{slot:MESSAGING_INGRESS_SLOT,seat});
 return {metadata,clock,keys,discovery,engine,cx,audit,owner,system,op,connect,integration,register,seatFor,describe,routes};
}

test('flags and actors: everything is not_found without INTEGRATIONS_ENABLED, records need BROKERING_ENABLED, and system-only hooks refuse the owner',async t=>{
 const off=await fixture(t,{integrations:false});const a=await off.connect('box.example');
 await assert.rejects(off.op(B.DiscoverResources,off.owner,{connection:a.id,contracts:[MODEL]}),code('not_found'));
 const f=await fixture(t,{brokering:false}),b=await f.connect('box.example');f.integration('box.example');
 assert.equal((await f.op(B.DiscoverResources,f.owner,{connection:b.id,contracts:[MODEL]})).items.length,1,'discovery is integrations.v1');
 await assert.rejects(f.register(b.id,'https://box.example/r/mailbox'),code('not_found'));
 await assert.rejects(f.op(B.BrokeredRecords,f.owner),code('not_found'));
 const g=await fixture(t),c=await g.connect('box.example');g.integration('box.example');
 await assert.rejects(g.op(B.RegisterBrokeredRecord,g.system,{connection:c.id,resource:'https://box.example/r/mailbox',binding:{fragment:FRAGMENT,field:'model'},consumer:{clientId:APP},contracts:[MODEL]}),code('forbidden'));
 await assert.rejects(g.op(B.DiscoverResources,g.system,{connection:c.id,contracts:[MODEL]}),code('forbidden'));
 for(const Operation of [B.DescribeOccupant,B.MintableRecord,B.BrokeredSeverance,B.AckBrokeredSeverance])await assert.rejects(g.op(Operation,g.owner,{}),code('forbidden'));
 await assert.rejects(g.op(B.BrokeredRecords,{kind:'app',owner:OWNER}),code('unauthorized'));
 await assert.rejects(g.op(B.BrokeredRecords,{kind:'owner',owner:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),code('forbidden'),'the store is bound to its owner');
});

test('registration trusts only a fresh authenticated lookup; field, consumer and contract inputs are checked',async t=>{
 const f=await fixture(t),a=await f.connect('box.example'),box=f.integration('box.example');
 await assert.rejects(f.register(a.id,'https://evil.example/r/mailbox'),code('invalid_request'),'IDs from another origin');
 await assert.rejects(f.register(a.id,'https://box.example/r/missing'),code('resource_unavailable'),'an ID the integration does not return');
 await assert.rejects(f.register(a.id,'https://box.example/r/mailbox',{contracts:['https://spec.bindle.example/contracts/unoffered/v1']}),code('unsupported_contract'));
 await assert.rejects(f.register(a.id,'https://box.example/r/mailbox',{consumer:{feature:'messaging-address'}}),code('forbidden'),'a provider feature only for a slot it consumes');
 await assert.rejects(f.register(a.id,'https://box.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'email-bridge'},contracts:undefined}),code('forbidden'));
 await assert.rejects(f.register(a.id,'https://box.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:[MODEL]}),code('invalid_request'),'a slot decides its contracts');
 await assert.rejects(f.register(a.id,'https://box.example/r/mailbox',{label:'Spoofed'}),code('invalid_request'),'the browser cannot set a label');
 box.items[0].label='Inbox ‮gnp.exe';await assert.rejects(f.register(a.id,'https://box.example/r/mailbox'),code('resource_unavailable'),'a hostile label invalidates the item');
 box.items[0].label='Mailbox';
 const r=await f.register(a.id,'https://box.example/r/mailbox');
 assert.deepEqual([r.connection,r.resource,r.label,r.status,r.state,r.available,r.unverified],[a.id,'https://box.example/r/mailbox','Mailbox','available','live',true,true]);
 assert.deepEqual(r.contracts,[MAILBOX,MODEL].sort());assert.deepEqual(r.assignments.map(x=>[x.binding,x.consumer,x.contracts]),[[{fragment:FRAGMENT,field:'model'},{clientId:APP},[MODEL]]]);
 const lookup=box.calls.at(-1).body;assert.deepEqual([lookup.ids,lookup.contracts],[['https://box.example/r/mailbox'],[MODEL]]);
 const again=await f.register(a.id,'https://box.example/r/mailbox');assert.equal(again.id,r.id,'one record per (connection, resource)');
 assert.notEqual(again.assignments[0].grant,r.assignments[0].grant,'a re-assignment gets a new grant');
 const {rows}=await f.op(B.BrokeredSeverance,f.system,{});assert.deepEqual(rows.map(x=>[x.type,x.grants]),[['reassigned',[r.assignments[0].grant]]]);
 const slot=await f.register(a.id,'https://box.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:undefined});
 assert.equal(slot.assignments.length,2);assert.deepEqual(slot.assignments[1].contracts,[MAILBOX]);
 const mint=await f.op(B.MintableRecord,f.system,{record:r.id,grant:slot.assignments[1].grant});
 assert.deepEqual([mint.audience,mint.resource,mint.generation,mint.feature,mint.contracts],['https://box.example/bindle/rpc','https://box.example/r/mailbox',a.generation,'messaging-address',[MAILBOX]]);
});

test('stale generations: suspend makes records unusable, resume leaves them stale until an authenticated lookup rebinds, and a reconnect never revives them',async t=>{
 const f=await fixture(t),a=await f.connect('box.example'),box=f.integration('box.example');
 const r=await f.register(a.id,'https://box.example/r/mailbox'),grant=r.assignments[0].grant;
 await f.op(C.SuspendConnection,f.owner,{connection:a.id});
 let [v]=(await f.op(B.BrokeredRecords,f.owner)).records;assert.deepEqual([v.state,v.available],['stale',false]);
 await assert.rejects(f.op(B.MintableRecord,f.system,{record:r.id,grant}),code('resource_unavailable'));
 await assert.rejects(f.op(B.DiscoverResources,f.owner,{connection:a.id,contracts:[MODEL]}),code('connection_unavailable'));
 await assert.rejects(f.register(a.id,'https://box.example/r/mailbox'),code('connection_unavailable'));
 await f.op(C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:2});
 [v]=(await f.op(B.BrokeredRecords,f.owner)).records;assert.deepEqual([v.state,v.available],['stale',false]);
 await assert.rejects(f.op(B.MintableRecord,f.system,{record:r.id,grant}),code('resource_unavailable'),'a stale record mints nothing');
 const result=await f.op(B.RevalidateBrokeredRecords,f.owner,{connection:a.id});assert.equal(result.rebound,1);
 assert.equal((await f.op(B.MintableRecord,f.system,{record:r.id,grant})).generation,3);
 // A lookup that races a suspension never commits against the newer generation.
 box.during=async path=>{if(path.endsWith('/resources')){box.during=null;await f.op(C.SuspendConnection,f.owner,{connection:a.id});}};
 await assert.rejects(f.register(a.id,'https://box.example/r/mailbox'),code('connection_stale'));
 await f.op(C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:4});
 await f.op(C.DisconnectConnection,f.owner,{connection:a.id});f.clock.advance(5);
 const back=await f.connect('box.example');assert.equal(back.id,a.id);assert.ok(back.generation>5);
 [v]=(await f.op(B.BrokeredRecords,f.owner)).records;assert.deepEqual([v.state,v.available],['ended',false],'a reconnect is a new incarnation');
 await assert.rejects(f.op(B.MintableRecord,f.system,{record:r.id,grant}),code('resource_unavailable'));
 assert.equal((await f.op(B.RevalidateBrokeredRecords,f.owner,{connection:a.id})).pruned,1);
 const fresh=await f.register(a.id,'https://box.example/r/mailbox');assert.notEqual(fresh.id,r.id);assert.notEqual(fresh.assignments[0].grant,grant);
});

test('revalidation: missing -> unavailable until reconfirmed, narrowed contracts removed, widened ignored, failures leave records and count health',async t=>{
 const f=await fixture(t),a=await f.connect('box.example'),box=f.integration('box.example',{items:[{id:'https://box.example/r/a',label:'A',contracts:[MAILBOX,MODEL]},{id:'https://box.example/r/b',label:'B',contracts:[MODEL]}]});
 const ra=await f.register(a.id,'https://box.example/r/a'),rb=await f.register(a.id,'https://box.example/r/b');
 box.items=[{id:'https://box.example/r/a',label:'A',contracts:[MODEL]}];
 const out=await f.op(B.RevalidateBrokeredRecords,f.owner,{connection:a.id});assert.deepEqual([out.checked,out.unavailable,out.narrowed],[2,1,1]);
 const by=Object.fromEntries((await f.op(B.BrokeredRecords,f.owner)).records.map(r=>[r.id,r]));
 assert.deepEqual(by[ra.id].contracts,[MODEL],'narrowed');assert.deepEqual([by[rb.id].status,by[rb.id].reason,by[rb.id].available],['unavailable','missing',false]);
 await assert.rejects(f.op(B.MintableRecord,f.system,{record:rb.id,grant:rb.assignments[0].grant}),code('resource_unavailable'));
 await assert.rejects(f.op(B.ReconfirmBrokeredRecord,f.owner,{record:rb.id}),code('resource_unavailable'));
 box.items.push({id:'https://box.example/r/b',label:'B again',contracts:[MODEL,MAILBOX]});
 assert.equal((await f.op(B.RevalidateBrokeredRecords,f.owner,{connection:a.id})).unavailable,0);assert.equal((await f.op(B.BrokeredRecords,f.owner)).records.find(r=>r.id===rb.id).status,'unavailable','revalidation alone never restores');
 const ok=await f.op(B.ReconfirmBrokeredRecord,f.owner,{record:rb.id});assert.deepEqual([ok.status,ok.label,ok.contracts],['available','B again',[MODEL]],'a widened claim is ignored');
 const rows=(await f.op(B.BrokeredSeverance,f.system,{})).rows;assert.deepEqual(rows.map(r=>r.type),['unavailable'],'narrowing that no assignment uses revokes no grant');
 box.answer=()=>new Response('nope',{status:500});
 for(let i=1;i<=3;i++){const r=await f.op(B.RevalidateBrokeredRecords,f.system,{connection:a.id,reason:'scheduled'});assert.equal(r.failed,true);assert.equal(r.health,i===3?'degraded':null);}
 assert.equal((await f.op(B.BrokeredRecords,f.owner)).records.find(r=>r.id===ra.id).status,'available','network failure changes no record');
 box.answer=null;assert.equal((await f.op(B.RevalidateBrokeredRecords,f.system,{connection:a.id,reason:'hint'})).health,'recovered');
 assert.equal((await f.op(B.RevalidateBrokeredRecords,f.system,{connection:a.id,reason:'hint'})).coalesced,true,'hints coalesce within 60 s');
 await assert.rejects(f.op(B.RevalidateBrokeredRecords,f.owner,{connection:a.id,reason:'hint'}),code('invalid_request'));
});

test('detach and unassign commit severance rows for X8; the backlog is bounded and acknowledged in order',async t=>{
 const f=await fixture(t),a=await f.connect('box.example');f.integration('box.example');
 const r=await f.register(a.id,'https://box.example/r/mailbox'),two=await f.register(a.id,'https://box.example/r/mailbox',{binding:{fragment:FRAGMENT,field:'backup'}});
 const removed=await f.op(B.UnassignBrokeredRecord,f.owner,{record:r.id,grant:r.assignments[0].grant});assert.equal(removed.assignments.length,1);
 assert.deepEqual(await f.op(B.DetachBrokeredRecord,f.owner,{record:r.id}),{detached:true,record:r.id});
 await assert.rejects(f.op(B.MintableRecord,f.system,{record:r.id,grant:two.assignments[1].grant}),code('not_found'));
 const {rows,seq}=await f.op(B.BrokeredSeverance,f.system,{});assert.deepEqual(rows.map(x=>[x.type,x.grants.length,x.resource]),[['unassigned',1,'https://box.example/r/mailbox'],['detached',1,'https://box.example/r/mailbox']]);
 assert.deepEqual(await f.op(B.AckBrokeredSeverance,f.system,{through:seq}),{acknowledged:seq,removed:2});assert.equal((await f.op(B.BrokeredSeverance,f.system,{})).rows.length,0);
 await f.metadata.put('integrations/meta',{seq:2000,low:2000-B.BROKERED_LIMITS.severance,health:{},hints:{}});
 const again=await f.register(a.id,'https://box.example/r/mailbox');assert.equal((await f.op(B.DetachBrokeredRecord,f.owner,{record:again.id})).detached,true,'a revocation is never refused (X7-R4)');
 const overflow=(await f.op(B.BrokeredSeverance,f.system,{after:1999})).rows;assert.deepEqual(overflow.map(r=>[r.type,r.connection]),[['overflow',a.id]],'past the bound rows collapse into one connection-wide row');
});

test('C1b describe: a provider-feature invoke token for exactly the mailbox describe, validated envelope, and every failure leaves the descriptor unavailable',async t=>{
 const f=await fixture(t),a=await f.connect('box.example'),box=f.integration('box.example');
 const r=await f.register(a.id,'https://box.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:undefined});
 const seat=await f.seatFor(a.id,r.id);
 assert.deepEqual(await f.describe(seat),DESCRIBE('box.example'));
 const claims=box.tokens.at(-1),call=box.calls.at(-1).body;
 assert.deepEqual([claims.aud,claims.client_id,claims.sub,claims.exp-claims.iat,claims.bindle.purpose,claims.bindle.feature,claims.bindle.resource,claims.bindle.generation],['https://box.example/bindle/rpc',ISSUER,SUBJECT,60,'invoke','messaging-address','https://box.example/r/mailbox',a.generation]);
 assert.deepEqual(claims.bindle.methods,{[MAILBOX]:['describe']});assert.equal(claims.bindle.grant,`${r.assignments[0].grant}.${seat.cnx}`,'the grant changes with the seat incarnation');
 assert.deepEqual([call.version,call.contract,call.method,call.args,call.resource],['0',MAILBOX,'describe',{},'https://box.example/r/mailbox']);
 const answers={status:()=>new Response('{}',{status:500}),error:(p,b)=>Response.json({version:'0',tx:b.tx,error:{code:'temporarily_unavailable',message:'x'}}),tx:()=>Response.json({version:'0',tx:'00000000-0000-4000-8000-000000000000',result:DESCRIBE('box.example')}),extra:(p,b)=>Response.json({version:'0',tx:b.tx,result:DESCRIBE('box.example'),token:'x'}),big:(p,b)=>Response.json({version:'0',tx:b.tx,result:{...DESCRIBE('box.example'),pad:'x'.repeat(17000)}}),html:(p,b)=>new Response(JSON.stringify({version:'0',tx:b.tx,result:DESCRIBE('box.example')}),{headers:{'Content-Type':'text/html'}})};
 for(const [name,answer] of Object.entries(answers)){box.answer=answer;await assert.rejects(f.describe(seat),e=>['describe_failed','egress_refused'].includes(e.code),name);}
 box.answer=null;
 await assert.rejects(f.describe({...seat,generation:seat.generation+1}),code('resource_unavailable'),'a seat from another generation');
 await assert.rejects(f.describe({...seat,resource:crypto.randomUUID()}),code('resource_unavailable'));
 await assert.rejects(f.op(B.DescribeOccupant,f.system,{slot:'https://spec.bindle.example/slots/public-message-intake/v1',seat}),code('resource_unavailable'),'only a provider consumer of that slot');
 // An app assignment on the same record never authorizes the provider call: remove the feature assignment.
 const plain=await f.register(a.id,'https://box.example/r/mailbox');await f.op(B.UnassignBrokeredRecord,f.owner,{record:r.id,grant:plain.assignments.find(x=>x.consumer.feature).grant});const before=box.calls.length;
 await assert.rejects(f.describe(seat),code('resource_unavailable'));assert.equal(box.calls.length,before,'nothing is sent once the provider assignment is gone');
 const d=await fixture(t),b=await d.connect('strict.example',{dpop:'required'}),strict=d.integration('strict.example');
 const rs=await d.register(b.id,'https://strict.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:undefined});const n=strict.calls.length;
 await assert.rejects(d.describe(await d.seatFor(b.id,rs.id)),code('resource_unavailable'),'the provider holds no DPoP key');assert.equal(strict.calls.length,n);
});

test('cross-connection mixups: a seat naming another connection\'s record, or the same resource string under two connections, never couples them',async t=>{
 const f=await fixture(t),a=await f.connect('box.example'),b=await f.connect('other.example');const boxA=f.integration('box.example');f.integration('other.example');
 const ra=await f.register(a.id,'https://box.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:undefined});
 const rb=await f.register(b.id,'https://other.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:undefined});
 assert.notEqual(ra.id,rb.id);
 const seatB=await f.seatFor(b.id,ra.id);const before=boxA.calls.length;// the owner (or a confused UI) seats B with A's record
 await assert.rejects(f.describe(seatB),code('resource_unavailable'));assert.equal(boxA.calls.length,before,'A is never called for B\'s seat');
 await assert.rejects(f.register(b.id,'https://box.example/r/mailbox'),code('invalid_request'),'B cannot register A\'s resource');
 const good=await f.seatFor(b.id,rb.id);assert.equal((await f.describe(good)).ingress,'https://other.example/ingress');
});

test('fixture conformance: discovery, probes, pagination and registration against tests/fixtures/integration-server.mjs with real JWS verification',async t=>{
 const {createIntegrationServer,INTEGRATION,CONTRACT}=await import('./fixtures/integration-server.mjs');
 const f=await fixture(t),host=new URL(INTEGRATION).hostname,a=await f.connect(host,{contracts:[CONTRACT],slots:[]});
 const item=(id,label,extra={})=>({iss:ISSUER,connection:a.id,sub:SUBJECT,item:{id:INTEGRATION+id,label,contracts:[CONTRACT],container:false,facets_applied:[]},...extra});
 const server=createIntegrationServer({clock:{now:()=>Date.now()},connections:[{iss:ISSUER,id:a.id,sub:SUBJECT,generation:a.generation}],contracts:[CONTRACT],resources:[item('/r/work','Work inbox'),item('/r/home','Home inbox'),{...item('/r/other','Other'),connection:'someone-else'}],
  verifyToken:async(token,{audience})=>(await verifyAccessToken(token,{keys:await f.keys.jwks(),issuer:ISSUER,audience,purposes:['discover','invoke'],now:Date.now()})).claims});
 t.after(()=>server.close());f.routes[host]={fetch:server.fetch};
 const {candidates}=await f.op(B.IntegrationCandidates,f.owner,{contracts:[CONTRACT],probe:true});assert.deepEqual(candidates.map(c=>[c.connection,c.exists]),[[a.id,true]]);
 assert.deepEqual((await f.op(B.IntegrationCandidates,f.owner,{contracts:[MODEL]})).candidates,[]);
 const page=await f.op(B.DiscoverResources,f.owner,{connection:a.id,contracts:[CONTRACT],limit:1});assert.equal(page.items.length,1);assert.equal(page.cursor,'1');
 const next=await f.op(B.DiscoverResources,f.owner,{connection:a.id,contracts:[CONTRACT],limit:1,cursor:page.cursor});assert.equal(next.cursor,null);
 assert.deepEqual([...page.items,...next.items].map(i=>i.id).sort(),[INTEGRATION+'/r/home',INTEGRATION+'/r/work'],'never another connection\'s resources');
 assert.deepEqual((await f.op(B.DiscoverResources,f.owner,{connection:a.id,contracts:[CONTRACT],text:'work'})).items.map(i=>i.label),['Work inbox']);
 await assert.rejects(f.op(B.DiscoverResources,f.owner,{connection:a.id,contracts:[CONTRACT],facets:{[CONTRACT]:{size:'s'}}}),code('unsupported_facet'));
 const r=await f.op(B.RegisterBrokeredRecord,f.owner,{connection:a.id,resource:INTEGRATION+'/r/work',binding:{fragment:FRAGMENT,field:'inbox'},consumer:{clientId:APP},contracts:[CONTRACT]});assert.equal(r.status,'available');
 server.setResources([item('/r/home','Home inbox')]);assert.equal((await f.op(B.RevalidateBrokeredRecords,f.owner,{connection:a.id})).unavailable,1);
 const snap=await server.snapshot();assert.ok(snap.verifications.length>=6);assert.ok(snap.verifications.every(v=>v.kind==='access'&&v.audience===INTEGRATION+'/bindle/resources'));
 // Fixture's own RPC accepts our real invoke token shape but is not a mailbox: its answer is no describe envelope.
 const slot=await fixture(t),b=await slot.connect(host,{contracts:[MAILBOX]});slot.routes[host]={fetch:createIntegrationServer({clock:{now:()=>Date.now()},connections:[{iss:ISSUER,id:b.id,sub:SUBJECT,generation:b.generation}],contracts:[MAILBOX],resources:[{iss:ISSUER,connection:b.id,sub:SUBJECT,item:{id:INTEGRATION+'/r/mailbox',label:'Mailbox',contracts:[MAILBOX],container:false,facets_applied:[]}}],verifyToken:async(token,{audience})=>(await verifyAccessToken(token,{keys:await slot.keys.jwks(),issuer:ISSUER,audience,purposes:['discover','invoke'],now:Date.now()})).claims}).fetch};
 const rm=await slot.register(b.id,INTEGRATION+'/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:undefined});
 await assert.rejects(slot.describe(await slot.seatFor(b.id,rm.id)),code('describe_failed'),'the fixture authorizes the token but answers no envelope');
});

/** The real AccountController with the X7 slice, its ports and the link handoff over them. */
async function account(t,{answer,intake=false}={}){
 const db=new SqliteMetadata(':memory:');t.after(()=>db.close());const keys=brokeringKeys({issuer:ISSUER,secret:SECRET,metadata:memory()}),routes={};
 const egress=createIntegrationEgress({fetcher:(url,init)=>routes[new URL(url).hostname].fetch(url,init),resolve:async()=>['93.184.216.34'],publicRouting:true});
 const config={EMAIL_BRIDGE_ENABLED:intake?'true':'false',APP_ORIGIN:ISSUER,KEY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true',BINDLEBOX_ENABLED:'true',IDENTITY_ACCOUNT:async owner=>owner===OWNER?{status:'active',handle:'alice'}:null,BROKERING_MINT:claims=>mintAccessToken(keys,claims),INTEGRATION_EGRESS:egress,INTEGRATION_DISCOVERY_BUDGET:new DiscoveryBudget()};
 const bucket={put:async()=>{},get:async()=>null,delete:async()=>{}};
 const a=new AccountController({metadata:db,gate:new SerialGate(),blobs:bucket,archives:bucket,config,sql:db.sql});await a.touch(OWNER);
 const slot=intake?B.INTAKE_SLOT:MESSAGING_INGRESS_SLOT,contract=intake?B.INTAKE_CONTRACT:MAILBOX,s=snapshot('box.example',{slots:[slot],contracts:[contract,MODEL]}),c=await a.connectionsSystem(OWNER,{operation:'connections.connect',input:s});routes['box.example']=stubIntegration('box.example',keys,{items:[{id:'https://box.example/r/mailbox',label:'Mailbox',contracts:[contract,MODEL]}]});
 const record=await a.integrationsOwner(OWNER,{operation:'integrations.register',input:{connection:c.id,resource:'https://box.example/r/mailbox',binding:{slot},consumer:{feature:intake?'email-bridge':'messaging-address'}}});
 await a.connectionsOwner(OWNER,{operation:'connections.occupy',input:{slot,connection:c.id,resource:record.id,...intake?{}:{purposes:ALL},replace:true}},{authTime:Date.now()});
 const link={record:{owner:OWNER,type:MESSAGING_CONTACT_LINK_TYPE},meta:{claims:{kinds:['one-off'],exp:Math.floor(Date.now()/1000)+86400}}};
 const handoff=new LinkHandoff({service:{verify:async()=>structuredClone(link)},occupant:q=>a.linkSlotOccupant(q),describe:messagingDescribe(a)});
 return {a,c,record,routes,handoff,db};
}

test('account slice: the MESSAGING_DESCRIBE port resolves descriptors through the real link handoff and records the ingress; failures are recipient_unavailable',async t=>{
 const {a,c,routes,handoff}=await account(t);
 const descriptor=await handoff.descriptor('https://3sln.example/l/x');
 assert.deepEqual([descriptor.ingress,descriptor.kinds,descriptor.version],['https://box.example/ingress',['one-off'],1]);
 assert.equal((await a.delegationSlotOccupant({owner:OWNER,slot:MESSAGING_INGRESS_SLOT})).ingress,'https://box.example/ingress','the validated ingress is recorded on the seat');
 routes['box.example'].describe={...DESCRIBE('box.example'),ingress:'https://evil.example/ingress'};handoff.cache.clear();
 await assert.rejects(handoff.descriptor('https://3sln.example/l/x'),code('recipient_unavailable'),'an ingress off the occupant origin');
 routes['box.example'].answer=()=>new Response('down',{status:503});handoff.cache.clear();await assert.rejects(handoff.descriptor('https://3sln.example/l/x'),code('recipient_unavailable'));
 await assert.rejects(a.integrationsMessagingDescribe({owner:OWNER,slot:MESSAGING_INGRESS_SLOT,occupant:{clientId:'https://other.example/bindle/client.json',generation:c.generation}}),code('recipient_unavailable'),'a mid-switch occupant');
 await a.connectionsOwner(OWNER,{operation:'connections.suspend',input:{connection:c.id}});routes['box.example'].answer=null;handoff.cache.clear();
 await assert.rejects(handoff.descriptor('https://3sln.example/l/x'),code('recipient_unavailable'),'no occupant while suspended');
});

test('account slice: discovery failures degrade the connection and recovery restores it; the owner routes are flag-gated',async t=>{
 const {a,c,routes}=await account(t),box=routes['box.example'];box.answer=()=>new Response('{}',{status:500});
 for(let i=0;i<3;i++)await assert.rejects(a.integrationsSearch(OWNER,{operation:'integrations.discover',input:{connection:c.id,contracts:[MODEL],text:'q'+i}}),code('discovery_failed'));
 const state=async()=>(await a.connectionsOwner(OWNER,{operation:'connections.list'})).connections.find(x=>x.id===c.id).state;
 assert.equal(await state(),'degraded');box.answer=null;
 const found=await a.integrationsSearch(OWNER,{operation:'integrations.discover',input:{connection:c.id,contracts:[MODEL]}});assert.equal(found.health,'recovered');assert.equal(await state(),'active');
 await assert.rejects(a.integrationsSearch(OWNER,{operation:'integrations.register',input:{}}),code('not_found'),'search never writes');
 await assert.rejects(a.integrationsOwner(OWNER,{operation:'integrations.describe',input:{}}),code('not_found'),'system operations are not owner RPC');
 assert.equal((await a.integrationsRevalidateDue(OWNER,{now:Date.now()+86400001})).revalidated,1);
 const calls=[],object=new Proxy({},{get:(_,m)=>async(...args)=>{calls.push([m,args[1]?.operation]);return {ok:true};}});
 const req=(method,path,body)=>({request:new Request('https://3sln.example'+path,{method,headers:{'Content-Type':'application/json'},...body?{body:JSON.stringify(body)}:{}}),env:{INTEGRATIONS_ENABLED:'true'},path:new URL('https://3sln.example'+path).pathname,url:new URL('https://3sln.example'+path),object,id:OWNER});
 assert.equal(await stages.owner({...req('POST','/api/integrations/discover',{}),env:{INTEGRATIONS_ENABLED:'false'}}),undefined,'flag off: nothing answers');
 assert.equal((await stages.owner(req('POST','/api/integrations/discover',{connection:c.id}))).status,200);
 assert.equal((await stages.owner(req('GET','/api/integrations/records'))).status,200);
 assert.equal((await stages.owner(req('DELETE',`/api/integrations/records/${c.id}`))).status,200);
 assert.equal((await stages.owner(req('PUT','/api/integrations/records'))).status,405);
 assert.equal((await stages.owner(req('GET','/api/integrations/records?connection=../x'))).status,400);
 assert.deepEqual(calls.filter(([m])=>m!=='admitWork'),[['integrationsSearch','integrations.discover'],['integrationsOwner','integrations.records'],['integrationsOwner','integrations.detach']]);
});

test('review regressions: describe has its own budget pool, never rebinds from the public path, and re-registration narrowing revokes (X7-R2, R3, R6)',async t=>{
 const f=await fixture(t),a=await f.connect('box.example'),box=f.integration('box.example');
 const r=await f.register(a.id,'https://box.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:undefined});
 const app=await f.register(a.id,'https://box.example/r/mailbox');const seat=await f.seatFor(a.id,r.id);
 f.discovery.budget=new DiscoveryBudget({budgets:{connectionPerMinute:4,describeShare:0.5}});
 await f.describe(seat);await f.describe(seat);await assert.rejects(f.describe(seat),code('discovery_rate_limited'),'the describe pool is half the connection allowance');
 assert.equal((await f.op(B.DiscoverResources,f.owner,{connection:a.id,contracts:[MODEL]})).items.length,1,'anonymous describes never exhaust the owner pool');
 f.discovery.budget=new DiscoveryBudget();
 await f.op(C.SuspendConnection,f.owner,{connection:a.id});await f.op(C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:2});
 const resumed=(await f.op(C.SlotOccupant,f.system,{slot:MESSAGING_INGRESS_SLOT})).occupants[0],before=box.calls.length;
 await assert.rejects(f.describe(resumed),code('resource_unavailable'));assert.equal(box.calls.length,before,'a stale record causes no lookup from the public path');
 assert.equal((await f.op(B.RevalidateBrokeredRecords,f.system,{connection:a.id,reason:'scheduled'})).rebound,1);
 assert.equal((await f.describe(resumed)).ingress,'https://box.example/ingress');
 box.items[0].contracts=[MAILBOX];// the integration drops the model contract; the owner re-registers the slot assignment
 await f.register(a.id,'https://box.example/r/mailbox',{binding:{slot:MESSAGING_INGRESS_SLOT},consumer:{feature:'messaging-address'},contracts:undefined});
 const rows=(await f.op(B.BrokeredSeverance,f.system,{})).rows;assert.ok(rows.some(x=>x.type==='narrowed'&&x.grants.includes(app.assignments.find(y=>y.consumer.clientId).grant)),'the app assignment that lost its contract is revoked');
 assert.deepEqual((await f.op(B.BrokeredRecords,f.owner)).records[0].assignments.find(y=>y.consumer.clientId).contracts,[]);
});

test('review regressions: account slice remembers describe failures for a minute and binds the ingress to the client_id origin (X7-R2, R5)',async t=>{
 const {a,c,routes,handoff}=await account(t),box=routes['box.example'];box.answer=()=>new Response('down',{status:503});
 const ask=()=>a.integrationsMessagingDescribe({owner:OWNER,slot:MESSAGING_INGRESS_SLOT,occupant:{clientId:c.clientId,generation:c.generation}});
 await assert.rejects(ask(),code('recipient_unavailable'));const n=box.calls.length;await assert.rejects(ask(),code('recipient_unavailable'));assert.equal(box.calls.length,n,'the refusal is remembered');
 box.answer=null;box.describe={...DESCRIBE('box.example'),ingress:'https://box.example.evil.example/ingress'};
 const fresh=await account(t);fresh.routes['box.example'].describe={...DESCRIBE('box.example'),ingress:'https://other.example/ingress'};
 await assert.rejects(fresh.handoff.descriptor('https://3sln.example/l/x'),code('recipient_unavailable'));
 assert.equal((await fresh.a.delegationSlotOccupant({owner:OWNER,slot:MESSAGING_INGRESS_SLOT})).ingress,null,'nothing is recorded for a foreign ingress');
});


test('BRIDGE account RPCs: current paid entitlement, live intake seat, signed brokered deliver and stale-seat refusal',async t=>{
 const {a,c,db,routes}=await account(t,{intake:true}),box=routes['box.example'];
 assert.equal(await a.emailBridgeEntitled(OWNER),false);assert.equal(await a.integrationsIntakeSeat(OWNER),null);
 await db.put('billing/state',{owner:OWNER,source:'polar',catalogVersion:2,plan:'paid',validUntil:Date.now()+3600000});
 assert.equal(await a.emailBridgeEntitled(OWNER),true);assert.equal(await a.emailBridgeEntitled(crypto.randomUUID()),false);
 const seat=await a.integrationsIntakeSeat(OWNER);assert.equal(seat.resource,'https://box.example/r/mailbox');assert.equal(seat.connection,c.id);
 const tx=crypto.randomUUID(),body=new TextEncoder().encode(JSON.stringify({version:'0',tx,resource:seat.resource,contract:B.INTAKE_CONTRACT,method:'deliver',args:{message:{parts:[{mimeType:'text/plain',dataBase64url:Buffer.from('large '.repeat(15000)).toString('base64url')}]},provenance:'signed-by-bridge'}}));
 box.answer=(path,rpc)=>Response.json({version:'0',tx:rpc.tx,result:{disposition:'stored-receipt'}});
 const result=await a.integrationsIntakeDeliver(OWNER,{seat,body});assert.equal(result.status,200);assert.equal(result.json.tx,tx);assert.equal(result.json.result.disposition,'stored-receipt');
 const token=box.tokens.at(-1);assert.equal(token.bindle.feature,'email-bridge');assert.deepEqual(token.bindle.methods,{[B.INTAKE_CONTRACT]:['deliver']});assert.equal(box.calls.at(-1).body.tx,tx);
 await assert.rejects(a.integrationsIntakeDeliver(OWNER,{seat:{...seat,resource:'https://box.example/r/other'},body}),code('recipient_unavailable'));
 await a.connectionsOwner(OWNER,{operation:'connections.suspend',input:{connection:c.id}});assert.equal(await a.integrationsIntakeSeat(OWNER),null);await assert.rejects(a.integrationsIntakeDeliver(OWNER,{seat,body}),code('recipient_unavailable'));
});

test('BRIDGE authenticated links hook: only the live intake occupant can notify acceptance; disabled and changed grants fail closed',async t=>{
 const {a,c,db}=await account(t,{intake:true}),{linksResourceMethod}=await import('../packages/runtime/account/links.mjs'),{LINKS_CONTRACT}=await import('../packages/links/types.mjs'),sent=[];
 await db.put('billing/state',{owner:OWNER,source:'polar',catalogVersion:2,plan:'paid',validUntil:Date.now()+3600000});
 a.config.FEDERATION_IDENTITY_CHECK=async()=>true;a.config.EMAIL_BRIDGE_OWNER={accepted:async(owner,jti)=>{sent.push({owner,jti});return {status:'sent'};}};
 const context={authority:'bindle',resource:`${ISSUER}/entities/${OWNER}/links`,resourceGeneration:OWNER,contract:LINKS_CONTRACT,method:'accepted',args:{jti:crypto.randomUUID()},clientId:c.clientId,connection:{id:c.id,generation:c.generation},epoch:'current'};
 assert.deepEqual(await linksResourceMethod(a,OWNER,context),{status:'sent'});assert.equal(sent.length,1);assert.equal(sent[0].owner,OWNER);
 await assert.rejects(linksResourceMethod(a,OWNER,{...context,args:{...context.args,owner:crypto.randomUUID()}}),code('forbidden'));
 a.config.EMAIL_BRIDGE_ENABLED='false';await assert.rejects(linksResourceMethod(a,OWNER,context),code('not_found'));a.config.EMAIL_BRIDGE_ENABLED='true';
 await a.connectionsOwner(OWNER,{operation:'connections.vacate',input:{slot:B.INTAKE_SLOT,seat:(await a.integrationsIntakeSeat(OWNER)).seat}});
 await assert.rejects(linksResourceMethod(a,OWNER,context),code('forbidden'));assert.equal(sent.length,1);
});
