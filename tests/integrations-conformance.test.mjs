// EXT-X9a: passing cases prove fixture behavior only. Provider/JWS conformance
// stays explicitly todo until X5–X8 land; this file makes no production claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine} from './helpers/app-engine.mjs';
import {fakeClock} from './helpers/chaos.mjs';
import {createIntegrationServer,ReceiveIntegrationEvent,IntegrationDiscovery,InvokeIntegrationResource,IntegrationSnapshot,INTEGRATION,ISSUER,SUBJECT,CONNECTION,CONTRACT,EVENTS} from './fixtures/integration-server.mjs';

const FRAGMENT='https://integration.example/preferences/settings/v1',RESOURCE=INTEGRATION+'/r/inbox';
const item=(id=RESOURCE,label='Work inbox')=>({iss:ISSUER,connection:CONNECTION,sub:SUBJECT,item:{id,label,contracts:[CONTRACT],container:false,facets_applied:[]}});
function fixture(t,options={}){
 const clock=fakeClock(Date.UTC(2026,9,20)),server=createIntegrationServer({clock,resources:[item()],...options});t.after(()=>server.close());
 const access=(purpose='invoke',extra={})=>server.issueAccessToken({iss:ISSUER,sub:SUBJECT,aud:purpose==='discover'?server.endpoints.discovery:server.endpoints.rpc,client_id:purpose==='discover'?ISSUER:'https://consumer.example/client.json',iat:clock.now()/1000,exp:clock.now()/1000+(purpose==='discover'?60:300),bindle:{v:1,purpose,connection:CONNECTION,generation:1,...purpose==='invoke'?{resource:RESOURCE,grant:'grant-1',methods:{[CONTRACT]:['deliver']},scope:null}:{},...extra}});
 const event=(type,payload={},jti='event-1')=>server.issueEventToken({iss:ISSUER,sub:SUBJECT,aud:server.endpoints.events,iat:clock.now()/1000,jti,events:{[EVENTS[type]??type]:{connection:CONNECTION,generation:1,seq:1,...payload}}});
 const post=(url,token,body)=>server.fetch(url,{method:'POST',headers:{'Content-Type':body===undefined?'application/secevent+jwt':'application/json',...body===undefined?{}:{Authorization:'Bearer '+token}},body:body===undefined?token:JSON.stringify(body)});
 return {server,clock,access,event,post};
}
const envelope={resource:RESOURCE,contract:CONTRACT,method:'deliver',args:{},tx:'fixture-transaction'};

test('fixture operations run through the app engine harness over an injected provider',async t=>{
 const {server,event,access}=fixture(t),harness=await createTestEngine({clock:server.clock,providers:{federation:server.provider}});t.after(()=>harness.dispose());
 await harness.perform(new ReceiveIntegrationEvent({input:{token:event('preferences-updated',{fragment:FRAGMENT,revision:1,values:{enabled:true}})}}));
 const discovery=await harness.read(new IntegrationDiscovery({input:{token:access('discover'),query:{v:1,contracts:[CONTRACT],limit:0}}}));
 assert.deepEqual(discovery,{v:1,items:[],exists:true});
 assert.deepEqual(await harness.perform(new InvokeIntegrationResource({input:{token:access(),envelope}})),{fixture:true,accepted:true});
 const state=await harness.read(new IntegrationSnapshot());assert.equal(state.connections[0].preferences[FRAGMENT].values.enabled,true);assert.equal(state.invocations.length,1);
 assert.deepEqual(harness.audit.entries.map(entry=>entry.operation),['fixture.integration.event','fixture.integration.invoke']);
});

test('preference webhook snapshots ignore stale seq and acknowledge duplicate or unknown events',async t=>{
 const {server,event,post}=fixture(t),send=(payload,jti)=>post(server.endpoints.events,event('preferences-updated',{fragment:FRAGMENT,revision:1,...payload},jti));
 assert.equal((await send({seq:4,values:{enabled:true}},'new')).status,202);
 assert.equal((await send({seq:3,values:{enabled:false}},'old')).status,202);
 assert.equal((await send({seq:5,values:null},'new')).status,202);
 assert.equal((await post(server.endpoints.events,event('https://integration.example/events/future/v1',{},'unknown'))).status,202);
 const state=await server.snapshot();assert.deepEqual(state.connections[0].preferences[FRAGMENT].values,{enabled:true});assert.equal(state.events.length,3);
 assert.equal(server.endpoints.invalidation,server.endpoints.events);
});

test('discovery supports contract filters, exact IDs, probes and pagination without crossing connections',async t=>{
 const {server,access,post}=fixture(t,{resources:[item(),item(INTEGRATION+'/r/personal','Personal inbox'),{...item(INTEGRATION+'/r/foreign'),connection:'another-connection'}]}),token=access('discover');
 const query=async input=>(await post(server.endpoints.discovery,token,{v:1,contracts:[CONTRACT],...input})).json();
 const first=await query({limit:1});assert.deepEqual(first.items.map(value=>value.id),[RESOURCE]);assert.equal(first.cursor,'1');
 const second=await query({limit:1,cursor:first.cursor});assert.equal(second.items[0].label,'Personal inbox');assert.equal(second.cursor,null);
 assert.deepEqual(await query({ids:[RESOURCE],limit:0}),{v:1,items:[],exists:true});
 assert.deepEqual(await query({ids:[INTEGRATION+'/r/missing'],limit:0}),{v:1,items:[],exists:false});
 assert.equal((await post(server.endpoints.discovery,token,{v:1,contracts:['https://integration.example/contracts/other/v1']})).status,400);
 assert.equal((await query({text:'personal'})).items.length,1);
 assert.equal((await post(server.endpoints.discovery,token,{v:1,contracts:[CONTRACT],facets:{[CONTRACT]:{unknown:true}}})).status,400);
});

test('opaque brokered-token stubs fail closed for audience, purpose, resource and expiry',async t=>{
 const {server,clock,access,post}=fixture(t),token=access();
 assert.equal((await post(server.endpoints.rpc,token,envelope)).status,200);
 assert.equal((await post(server.endpoints.rpc,access('discover'),envelope)).status,401);
 assert.equal((await post(server.endpoints.rpc,access('describe'),envelope)).status,401);
 assert.equal((await post(server.endpoints.rpc,access('invoke',{generation:2}),envelope)).status,401);
 assert.equal((await post(server.endpoints.rpc,access('invoke',{scope:{path:'restricted'}}),envelope)).status,501);
 assert.equal((await post(server.endpoints.rpc,token,{...envelope,resource:INTEGRATION+'/r/hidden'})).status,403);
 assert.equal((await post(server.endpoints.rpc,'unknown-token',envelope)).status,401);
 clock.advance(331000);assert.equal((await post(server.endpoints.rpc,token,envelope)).status,401);
 const state=await server.snapshot();assert.equal(state.invocations.length,1);assert.equal(JSON.stringify(state).includes(token),false);
});

test('invalidation rejects grants and raises generation floors even when events arrive out of seq',async t=>{
 const {server,event,access,post}=fixture(t),token=access();
 assert.equal((await post(server.endpoints.invalidation,event('credential-revoked',{seq:9,grants:['grant-1'],until:server.clock.now()/1000+360},'grant'))).status,202);
 assert.equal((await post(server.endpoints.rpc,token,envelope)).status,401);
 const other=access('invoke',{grant:'grant-2'});assert.equal((await post(server.endpoints.rpc,other,envelope)).status,200);
 await post(server.endpoints.invalidation,event('connection-revoked',{seq:8,generation_floor:2,terminal:true},'connection'));
 assert.equal((await post(server.endpoints.rpc,other,envelope)).status,401);
 await post(server.endpoints.events,event('connection-resumed',{generation:2,seq:10},'resume'));
 const reconnected=access('invoke',{generation:2,grant:'grant-3'});assert.equal((await post(server.endpoints.rpc,reconnected,envelope)).status,200);
 await post(server.endpoints.invalidation,event('connection-revoked',{generation_floor:2,terminal:true},'late-terminal'));
 assert.equal((await post(server.endpoints.rpc,reconnected,envelope)).status,200);
});

test('fixture supports loopback HTTP with logical HTTPS audiences and rejects malformed requests',async t=>{
 const {server,event,access,post}=fixture(t),origin=await server.listen();assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
 const response=await fetch(origin+'/bindle/events',{method:'POST',headers:{'Content-Type':'application/secevent+jwt'},body:event('preferences-updated',{fragment:FRAGMENT,values:null})});assert.equal(response.status,202);
 assert.equal((await server.fetch(server.endpoints.rpc)).status,405);
 assert.equal((await server.fetch('https://foreign.example/bindle/rpc')).status,404);
 assert.equal((await server.fetch(server.endpoints.rpc,{method:'POST',body:'x'})).status,415);
 assert.equal((await server.fetch(server.endpoints.rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
 assert.equal((await post(server.endpoints.discovery,access('discover'),{v:1,contracts:[CONTRACT],cursor:'x'.repeat(1025)})).status,400);
 assert.equal((await server.fetch(server.endpoints.events,{method:'POST',headers:{'Content-Type':'application/secevent+jwt'},body:'x'.repeat(65537)})).status,413);
});

test.todo('EXT-X3/X4: provider manifest snapshots, confidential-client authentication and lifecycle binding');
test.todo('EXT-X5/X9b: ES256 JWS/SET verification, lookup before fetch, key rotation and DPoP vectors');
test.todo('EXT-X6: provider transactional outbox, coalescing, re-signed retries and push/pull seq ordering');
test.todo('EXT-X7: provider SSRF-safe discovery, item validation, hints and unavailable-record reconfirmation');
test.todo('EXT-X8: preferences v1/v2 projection and atomic severance under mint/refresh races and offline delivery');
test.todo('EXT-X8/X9b: write-capable contracts require live introspection without cached authorization');
