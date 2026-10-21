// EXT-X9b: local provider/fixture conformance; external services and production remain unverified.
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

// EXT-X6: the provider side of §6 against this fixture. The fixture verifies every SET with the X6 reference verifier
// (lookup before any key, ES256 under the event-purpose brokering key, typ, aud, sub, iat) instead of opaque stubs.
test('EXT-X6: provider outbox SETs are verified, coalesced, re-signed on retry and applied in seq order',async t=>{
 const {brokeringKeys}=await import('../packages/federation/signing.mjs'),E=await import('../packages/runtime/integration-events.mjs');
 const store=new Map();let tail=Promise.resolve();
 const metadata={transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(store.get(k)),set:async(k,v)=>{store.set(k,structuredClone(v));},put:async(k,v)=>{store.set(k,structuredClone(v));},delete:async k=>{store.delete(k);},list:async({prefix})=>new Map([...store].filter(([k])=>k.startsWith(prefix)).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>[k,structuredClone(v)]))}));tail=run.catch(()=>{});return run;},get:async k=>structuredClone(store.get(k)),list:async({prefix})=>new Map([...store].filter(([k])=>k.startsWith(prefix)).sort(([a],[b])=>a<b?-1:1))};
 const clock=fakeClock(Date.UTC(2026,9,20)),keys=brokeringKeys({issuer:ISSUER,secret:Buffer.alloc(32,5).toString('base64'),metadata,clock:()=>clock.now()});
 const server=createIntegrationServer({clock,verifyToken:async(token,{kind,audience})=>kind==='event'?(await E.verifySecurityEventToken(token,{subject:SUBJECT,keys:await keys.jwks(),issuer:ISSUER,audience,connection:({connection})=>connection===CONNECTION,now:clock.now()})).claims:null});t.after(()=>server.close());
 const connection={id:CONNECTION,clientId:INTEGRATION+'/bindle/client.json',generation:1,state:'active',integration:{kind:'external',snapshot:{manifest:{events_endpoint:server.endpoints.events}}}};
 const sent=[],down={on:false},values={v:0};
 const egress={async send({url,body}){sent.push(body);if(down.on)throw new Error('down');const r=await server.fetch(url,{method:'POST',headers:{'Content-Type':'application/secevent+jwt'},body});return {status:r.status,bytes:new Uint8Array()};}};
 const Provider=E.integrationEventsProvider({enabled:true,issuer:ISSUER,subject:()=>SUBJECT,signer:keys,egress,snapshot:async()=>({revision:'r'+values.v,values:{...values}}),connections:()=>({outbox:async()=>({events:[],seq:0,gap:false}),ack:async()=>({}),list:async()=>[connection],health:async()=>({})})});
 const harness=await createTestEngine({clock,providers:{integrationEvents:Provider}});t.after(()=>harness.dispose());
 const actor={kind:'system',owner:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},mark=()=>harness.perform(new E.MarkPreferencesUpdated({actor,input:{connection:CONNECTION,fragment:FRAGMENT}})),deliver=()=>harness.perform(new E.DeliverIntegrationEvents({actor}));
 values.v=1;await mark();values.v=2;await mark();await deliver();
 down.on=true;values.v=3;await mark();await deliver();clock.advance(10000);down.on=false;await deliver();
 const claims=sent.map(token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url')));
 assert.equal(sent.length,3,'two markers coalesced into one SET, then one retried SET');
 assert.equal(claims[1].jti,claims[2].jti);assert.notEqual(claims[1].iat,claims[2].iat);
 const state=await server.snapshot();assert.deepEqual(state.events.map(e=>e.seq),[1,2]);assert.deepEqual(state.connections[0].preferences[FRAGMENT].values,{v:3});
});

import {brokeredProvider,OWNER as ACCOUNT_OWNER,ISSUER as PROVIDER,SUBJECT as OWNER_SUBJECT,MODEL,FRAGMENT as MODELS,APP as CONSUMER} from './fixtures/brokered-provider.mjs';
import * as X8 from '../packages/federation/introspection.mjs';
import * as X7 from '../packages/federation/brokered.mjs';
import * as X4 from '../packages/app/domains/connections.mjs';
import {perform} from '../packages/app/engine.mjs';
import {brokeringKeys,mintAccessToken,verifyAccessToken,DEFAULT_LEAD} from '../packages/federation/signing.mjs';
import {verifySecurityEventToken} from '../packages/runtime/integration-events.mjs';
import {MemoryFederationStore,PREFERENCES} from '../packages/federation/index.mjs';
import {SqliteMetadata} from '../apps/node/resources.mjs';
const storage=()=>{const map=new Map();return {map,transaction:fn=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>map.set(k,structuredClone(v)),delete:async k=>map.delete(k)})};};
async function providerResource(t,{write=false}={}){const f=await brokeredProvider(t,{introspection:write,refreshEnabled:true}),record=await f.register('https://models.example/r/fast'),resource=X8.brokeredResourceId(OWNER_SUBJECT,record.id);await f.configure({theme:'dark',model:[resource],store:[]});const token=await f.authorize({resources:{model:[resource],store:[]},methods:{model:{[MODEL]:write?['decide','train']:['decide']}}});return {...f,record,resource,token};}

test('EXT-X3/X4: approved manifest pins remain generation-fenced through suspension and resume',async t=>{
 const f=await providerResource(t),id=f.integration.id,old=(await f.read(f.token)).values.model[0].token;
 await perform(f.cx,new X4.SuspendConnection({actor:{kind:'owner',owner:ACCOUNT_OWNER},input:{connection:id,expectedGeneration:f.integration.generation}}));
 assert.equal((await f.read(f.token)).values.model[0].status,'unavailable');
 const suspended=(await f.q(X8.BrokeredIntegrationAuth,{connection:id}));assert.equal(suspended.serving,false);
 await perform(f.cx,new X4.ResumeConnection({actor:{kind:'owner',owner:ACCOUNT_OWNER},input:{connection:id,expectedGeneration:f.integration.generation+1}}));
 assert.equal((await f.read(f.token)).values.model[0].status,'unavailable','old generation is never silently revived');assert.equal(typeof old,'string');
});

test('EXT-X5/X9b: ES256 purpose, audience, lookup-before-key, rotation, and read-only verification',async()=>{
 const clock=fakeClock(Date.now()),db=storage(),keys=brokeringKeys({issuer:ISSUER,secret:Buffer.alloc(32,6).toString('base64'),metadata:db,clock:clock.now});
 const input={subject:SUBJECT,audience:INTEGRATION+'/bindle/rpc',clientId:'https://consumer.example/client',connection:CONNECTION,generation:1,resource:RESOURCE,grant:'g',methods:{[CONTRACT]:['deliver']}};
 const minted=await mintAccessToken(keys,input,{clock:clock.now});let fetches=0;
 await assert.rejects(verifyAccessToken(minted.token,{issuer:ISSUER,audience:input.audience,connection:()=>false,keys:()=>{fetches++;return keys.jwks();}}));assert.equal(fetches,0);
 const before=JSON.stringify([...db.map]);await keys.verify(minted.token,{audience:input.audience,now:clock.now()});assert.equal(JSON.stringify([...db.map]),before,'verification never advances or writes the key ring');
 await assert.rejects(keys.verify(minted.token,{audience:INTEGRATION+'/foreign'}));await assert.rejects(keys.verify(minted.token,{audience:input.audience,purposes:['discover']}));
 await keys.rotate('invoke');clock.advance(DEFAULT_LEAD);const next=await mintAccessToken(keys,input,{clock:clock.now});assert.notEqual(minted.kid,next.kid);assert.ok((await keys.jwks()).keys.some(k=>k.kid===minted.kid));
});

test('EXT-X8: push/pull seq and snapshots use the current federation projection without credentials',async t=>{
 // A real connection binding (approval connects the reader), so the reader's tokens, family and grants all carry it.
 const f=await brokeredProvider(t,{connections:true,refreshEnabled:true,seq:async()=>17}),record=await f.register('https://models.example/r/fast'),resource=X8.brokeredResourceId(OWNER_SUBJECT,record.id);
 await f.configure({theme:'dark',model:[resource],store:[]});const token=await f.authorize({resources:{model:[resource],store:[]},methods:{model:{[MODEL]:['decide']}}});
 const out=await f.read(token),binding=f.bindings.get(CONSUMER);assert.equal(out.seq,17);assert.equal(typeof out.values.model[0].token,'string');
 const snapshot=await f.s.integrationSnapshot({connection:binding.id,generation:binding.generation,clientId:CONSUMER,fragment:MODELS});
 assert.equal(snapshot.revision,out.revision);assert.equal(snapshot.values.model[0].id,out.values.model[0].id);for(const k of ['token','token_type','expires_at'])assert.equal(snapshot.values.model[0][k],undefined);
 assert.deepEqual(await f.s.integrationSnapshot({connection:binding.id,generation:binding.generation+1,clientId:CONSUMER,fragment:MODELS}),{revision:out.revision,values:null},'another generation sees nothing');
});

test('EXT-X7: discovery rejects private egress and unavailable records require explicit reconfirmation',async t=>{
 const {createIntegrationEgress}=await import('../packages/federation/resource-discovery.mjs');let sent=0;
 const egress=createIntegrationEgress({publicRouting:true,resolve:async()=>['127.0.0.1'],fetcher:async()=>{sent++;return Response.json({});}});
 await assert.rejects(egress.send({url:'https://private.example/bindle/resources',method:'POST',body:'{}'}));assert.equal(sent,0);
 const f=await providerResource(t);f.presence.available=false;await perform(f.x7,new X7.RevalidateBrokeredRecords({actor:{kind:'owner',owner:ACCOUNT_OWNER},input:{connection:f.integration.id}}));assert.equal((await f.read(f.token)).values.model[0].status,'unavailable');f.presence.available=true;await perform(f.x7,new X7.RevalidateBrokeredRecords({actor:{kind:'owner',owner:ACCOUNT_OWNER},input:{connection:f.integration.id}}));assert.equal((await f.read(f.token)).values.model[0].status,'unavailable');await perform(f.x7,new X7.ReconfirmBrokeredRecord({actor:{kind:'owner',owner:ACCOUNT_OWNER},input:{record:f.record.id}}));await perform(f.x7,new X7.UnassignBrokeredRecord({actor:{kind:'owner',owner:ACCOUNT_OWNER},input:{record:f.record.id,grant:f.record.assignments[0].grant}}));
 assert.equal((await f.read(f.token)).values.model[0].status,'unavailable');const drain=await f.q(X8.DrainBrokeredSeverance);assert.ok(drain.drained>0);
});

test('EXT-X8: real brokered tokens stop by 360 s with every webhook lost, including worst verifier clock skew',async t=>{
 const f=await providerResource(t),read=await f.read(f.token),m=read.values.model[0],clock=fakeClock(f.clock.now());
 const server=createIntegrationServer({issuer:PROVIDER,subject:OWNER_SUBJECT,integration:'https://models.example',clock,connections:[{iss:PROVIDER,id:f.integration.id,sub:OWNER_SUBJECT,generation:1}],resources:[{iss:PROVIDER,connection:f.integration.id,sub:OWNER_SUBJECT,item:{id:m.broker.resource,label:'Fast',contracts:[MODEL]}}],verifyToken:async(token,{audience})=>(await verifyAccessToken(token,{issuer:PROVIDER,audience,keys:await import('./fixtures/brokered-provider.mjs').then(x=>x.providerKeys.jwks()),now:clock.now()})).claims});t.after(()=>server.close());
 const post=()=>server.fetch(server.endpoints.rpc,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+m.token},body:JSON.stringify({resource:m.broker.resource,contract:MODEL,method:'decide',args:{}})});
 assert.equal((await post()).status,200);await perform(f.x7,new X7.DetachBrokeredRecord({actor:{kind:'owner',owner:ACCOUNT_OWNER},input:{record:f.record.id}}));
 assert.equal((await f.read(f.token)).values.model?.[0]?.token,undefined);clock.advance(360000-30000);assert.equal((await post()).status,401,'360 s real time with verifier 30 s slow and leeway 30 s');
});

test('EXT-X8/X9b: write methods introspect on every call and fail closed without caching',async t=>{
 const f=await providerResource(t,{write:true}),m=(await f.read(f.token)).values.model[0];let calls=0;const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),pub=await crypto.subtle.exportKey('jwk',pair.publicKey),set=await import('../packages/federation/integrations.mjs').then(x=>x.validateJwks(crypto,{keys:[{...pub,kid:'client',alg:'ES256',use:'sig'}]}));await f.metadata.transaction(async tx=>{const key='resource/'+f.integration.id,c=await tx.get(key);c.integration.snapshot.thumbprints=set.thumbprints;await tx.put(key,c);});
 const server=createIntegrationServer({issuer:PROVIDER,subject:OWNER_SUBJECT,integration:'https://models.example',clock:f.clock,connections:[{iss:PROVIDER,id:f.integration.id,sub:OWNER_SUBJECT,generation:1}],resources:[{iss:PROVIDER,connection:f.integration.id,sub:OWNER_SUBJECT,item:{id:m.broker.resource,label:'Fast',contracts:[MODEL]}}],verifyToken:async(token,{audience})=>(await verifyAccessToken(token,{issuer:PROVIDER,audience,keys:await import('./fixtures/brokered-provider.mjs').then(x=>x.providerKeys.jwks())})).claims,requiresIntrospection:(_,method)=>method==='train',introspect:async token=>{calls++;const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(f.clock.now()/1000),client=f.integration.clientId,input=b64({alg:'ES256',kid:'client',typ:'JWT'})+'.'+b64({iss:client,sub:client,aud:PROVIDER+X8.INTROSPECTION_PATH,iat:now,exp:now+60,jti:crypto.randomUUID()}),sig=Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(input))).toString('base64url'),response=await X8.handleBrokeredIntrospection(new Request(PROVIDER+X8.INTROSPECTION_PATH,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,client_assertion_type:X8.CLIENT_ASSERTION_TYPE,client_assertion:input+'.'+sig})}),{issuer:PROVIDER,enabled:true,clock:f.clock.now,verifyToken:(token,options)=>import('./fixtures/brokered-provider.mjs').then(x=>x.providerKeys.verify(token,options)),clientKeys:async()=>set,account:()=>({brokeredIntegrationAuth:input=>f.q(X8.BrokeredIntegrationAuth,input),brokeredIntrospect:input=>f.q(X8.IntrospectBrokeredToken,input)}),federation:()=>f.s});return response.json();}});t.after(()=>server.close());
 const post=()=>server.fetch(server.endpoints.rpc,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+m.token},body:JSON.stringify({resource:m.broker.resource,contract:MODEL,method:'train',args:{}})});
 assert.equal((await post()).status,200);await f.s.revoke(f.owner,f.token.grants[0]);assert.equal((await post()).status,401);assert.equal(calls,2);assert.equal((await server.snapshot()).invocations.length,1);
});
