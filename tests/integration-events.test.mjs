// EXT-X6 integration event outbox (packages/runtime/integration-events.mjs): signed SETs verified by the conformance
// fixture (tests/fixtures/integration-server.mjs), coalescing and strictly increasing seq, retries with backoff and the
// degraded dead letter, SSRF refusal in the egress adapters, at-least-once delivery across a crash between send and
// ack, invalidation priority, and the alarm-driven slice on the real AccountController. Engine-harness suites dispatch
// the real operations over the X4 connections engine and the X5 brokering keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAppEngine,perform,read,AppQuery} from '../packages/app/engine.mjs';
import {memoryAudit} from '../packages/app/providers.mjs';
import {AppConnections} from '../packages/apps/connections.mjs';
import * as C from '../packages/app/domains/connections.mjs';
import {validateIntegrationManifest,PREFERENCES_UPDATED_EVENT} from '../packages/federation/integrations.mjs';
import {brokeringKeys,mintAccessToken} from '../packages/federation/signing.mjs';
import * as E from '../packages/runtime/integration-events.mjs';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {createIntegrationServer,ISSUER,EVENTS} from './fixtures/integration-server.mjs';
import {createTestEngine,OWNER} from './helpers/app-engine.mjs';
import {fakeClock} from './helpers/chaos.mjs';

const F='https://integration.example/preferences/settings/v1',G='https://integration.example/preferences/layout/v1',H='https://integration.example/preferences/filters/v1';
const SUB=`${ISSUER}/entities/${OWNER}`,SECRET=Buffer.alloc(32,7).toString('base64'),T={...EVENTS};
const decode=token=>({header:JSON.parse(Buffer.from(token.split('.')[0],'base64url')),claims:JSON.parse(Buffer.from(token.split('.')[1],'base64url'))});
const eventOf=token=>{const {claims}=decode(token),[[type,payload]]=Object.entries(claims.events);return {type,...payload};};
function memory(){const map=new Map();let tail=Promise.resolve();return {transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>{map.set(k,structuredClone(v));}}));tail=run.catch(()=>{});return run;}};}
/** A validated X3 approval snapshot for a confidential integration on `host` with an events endpoint. */
function snapshot(host='integration.example',{events}={}){
 const clientId=`https://${host}/bindle/client.json`,redirectUris=[`https://${host}/bindle/callback`],jwksUri=`https://${host}/bindle/jwks.json`;
 const r=validateIntegrationManifest({v:1,events_endpoint:`https://${host}/bindle/events`,...events?{events}:{}},{clientId,confidential:true,redirectUris,jwksUri});assert.equal(r.status,'valid',r.reason);
 return {client:{id:clientId,name:host},snapshot:{clientId,redirectUris,authMethod:'private_key_jwt',jwksUri,thumbprints:['A'.repeat(43)],manifest:r.manifest}};
}
/** A second integration origin: verifies every SET with the same verifier and records it. */
function recorder(keys,clock,connection){
 const seen=[];return {seen,async fetch(url,init){const token=init.body;try{const v=await E.verifySecurityEventToken(token,{subject:SUB,keys:await keys.jwks(),issuer:ISSUER,audience:url,subject:SUB,connection:({connection:id})=>id===connection(),now:clock.now()});seen.push({type:v.type,...v.payload});return new Response(null,{status:202});}catch{return Response.json({err:'authentication_failed'},{status:401});}}};
}

async function world(t,{limits,events,crashable=false,enabled=true}={}){
 const clock=fakeClock(Date.UTC(2026,9,20,12)),keys=brokeringKeys({issuer:ISSUER,secret:SECRET,metadata:memory(),clock:()=>clock.now()});
 const crash={next:false},wrap=crashable?{accountStore:store=>new Proxy(store,{get(target,key){const value=Reflect.get(target,key);if(key==='transaction')return async(...args)=>{if(crash.next){crash.next=false;throw Object.assign(new Error('process crashed'),{code:'crashed'});}return value.apply(target,args);};return typeof value==='function'?value.bind(target):value;}})}:{};
 const values=new Map();let revision=0;const setValues=(fragment,v)=>values.set(fragment,{revision:`rev-${++revision}`,values:v});
 const route={mode:'up'},sent=[];let server,other;
 const egress={async send({url,body}){
  sent.push({url,body,at:clock.now()});if(route.mode==='down')throw new Error('connection refused');
  const target=new URL(url).host==='integration.example'?server:other,response=await target.fetch(url,{method:'POST',headers:{'Content-Type':E.SET_MEDIA_TYPE},body});
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(route.mode==='lost'){route.mode='up';throw new Error('connection reset after the receiver processed the request');}
  if(route.mode==='crash'){route.mode='up';crash.next=true;}
  return {status:response.status,bytes};
 }};
 const system={kind:'system',owner:OWNER},owner={kind:'owner',owner:OWNER,authTime:clock.now()};let x4;
 const op=(Operation,actor,input)=>{const o=new Operation({actor,...input===undefined?{}:{input}});return o instanceof AppQuery?read(x4,o):perform(x4,o);};
 const port=()=>({outbox:i=>op(C.ConnectionOutbox,system,i),ack:i=>op(C.AckConnectionOutbox,system,i),list:()=>op(C.ConnectionList,system),health:i=>op(C.ConnectionHealth,system,i)});
 const harness=await createTestEngine({clock,wrap,providers:{integrationEvents:E.integrationEventsProvider({enabled,issuer:ISSUER,signer:keys,egress,snapshot:async({fragment})=>values.get(fragment)??{revision:null,values:null},connections:port,limits})}});
 t.after(()=>harness.dispose());await harness.metadata.put('owner',OWNER);
 const connections=new AppConnections({metadata:harness.metadata,origin:ISSUER,clock:clock.now});
 x4=createAppEngine({providers:{clock,random:{uuid:()=>crypto.randomUUID(),bytes:n=>crypto.getRandomValues(new Uint8Array(n))},audit:memoryAudit({clock}),connections:C.connectionsProvider({connections,enabled:true,account:async()=>({status:'active'})})}});
 t.after(()=>x4.dispose());
 const connection=await op(C.ConnectIntegration,system,snapshot('integration.example',{events}));
 server=createIntegrationServer({clock,connections:[{iss:ISSUER,id:connection.id,sub:SUB,generation:connection.generation}],
  verifyToken:async(token,{kind,audience})=>kind==='event'?(await E.verifySecurityEventToken(token,{subject:SUB,keys:await keys.jwks(),issuer:ISSUER,audience,connection:({connection:id})=>id===connection.id,now:clock.now()})).claims:null});
 t.after(()=>server.close());
 let second;other=recorder(keys,clock,()=>second?.id);
 const ev={
  ingest:()=>harness.perform(new E.IngestIntegrationEvents({actor:system})),
  deliver:input=>harness.perform(new E.DeliverIntegrationEvents({actor:system,...input?{input}:{}})),
  mark:(fragment,id=connection.id)=>harness.perform(new E.MarkPreferencesUpdated({actor:system,input:{connection:id,fragment}})),
  enqueue:input=>harness.perform(new E.EnqueueIntegrationEvent({actor:system,input})),
  status:()=>harness.read(new E.IntegrationEventStatus({actor:system})),
 };
 const pump=async()=>{await ev.ingest();return ev.deliver();};
 const received=async()=>(await server.snapshot()).events,state=async(id=connection.id)=>(await op(C.ConnectionList,system)).connections.find(c=>c.id===id);
 const connectSecond=async()=>{second=await op(C.ConnectIntegration,system,snapshot('other.example'));return second;};
 return {clock,keys,harness,x4,op,system,owner,connection,server,other,egress,route,sent,crash,setValues,ev,pump,received,state,connectSecond};
}

test('SETs are ES256 secevent+jwt with exactly the §6.1 claims, minimized snapshots and fixture-verified signatures',async t=>{
 const w=await world(t),resource={id:`${ISSUER}/entities/x/resources/r-1`,label:'Inbox',status:'available',contracts:['https://spec.bindle.example/contracts/c/v1'],token:'secret-brokered-token',token_type:'Bearer',expires_at:1792500000,broker:{endpoint:'https://models.example/bindle/rpc',origin:'https://models.example',resource:'https://models.example/r/abc'}};
 w.setValues(F,{store:[resource],retention:30,token:'a field the owner named token'});await w.ev.mark(F);
 const r=await w.pump();assert.equal(r.acknowledged,1);assert.equal(w.sent.length,1);
 const {header,claims}=decode(w.sent[0].body);
 assert.deepEqual(Object.keys(header).sort(),['alg','kid','typ']);assert.equal(header.alg,'ES256');assert.equal(header.typ,'secevent+jwt');assert.match(header.kid,/^event\./);
 assert.deepEqual(Object.keys(claims).sort(),['aud','events','iat','iss','jti','sub']);
 assert.equal(claims.iss,ISSUER);assert.equal(claims.aud,'https://integration.example/bindle/events');assert.equal(claims.sub,SUB);assert.equal(claims.iat,Math.floor(w.clock.now()/1000));
 const event=eventOf(w.sent[0].body);assert.equal(event.type,PREFERENCES_UPDATED_EVENT);
 assert.deepEqual(Object.keys(event).sort(),['connection','fragment','generation','revision','seq','type','values']);
 assert.deepEqual({connection:event.connection,generation:event.generation,seq:event.seq,fragment:event.fragment},{connection:w.connection.id,generation:1,seq:1,fragment:F});
 assert.deepEqual(Object.keys(event.values.store[0]).sort(),['broker','contracts','id','label','status'],'resource references carry no token, token_type or expires_at');
 assert.equal(event.values.token,'a field the owner named token','ordinary fields are untouched');assert.equal(w.sent[0].body.includes('secret-brokered'),false);
 const fixture=await w.server.snapshot();assert.equal(fixture.connections[0].preferences[F].values.retention,30);assert.equal(fixture.connections[0].preferences[F].seq,1);
 // Forgery: tampered payload, a foreign key under the real kid, and an at+jwt brokered token are all refused (401).
 const post=body=>w.server.fetch('https://integration.example/bindle/events',{method:'POST',headers:{'Content-Type':E.SET_MEDIA_TYPE},body});
 const [h,p,s]=w.sent[0].body.split('.'),forged=Buffer.from(JSON.stringify({...claims,events:{[PREFERENCES_UPDATED_EVENT]:{...event,type:undefined,seq:99,values:{retention:0}}}})).toString('base64url');
 assert.equal((await post(`${h}.${forged}.${s}`)).status,401);
 const foreign=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign']),input=`${h}.${forged}`;
 assert.equal((await post(`${input}.${Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},foreign.privateKey,new TextEncoder().encode(input))).toString('base64url')}`)).status,401);
 const access=await mintAccessToken(w.keys,{subject:SUB,audience:'https://integration.example/bindle/rpc',clientId:'https://consumer.example/client.json',connection:w.connection.id,generation:1,resource:'https://integration.example/r/x',grant:'g1',methods:{'https://spec.bindle.example/contracts/c/v1':['deliver']}},{clock:()=>w.clock.now()});
 assert.equal((await post(access.token)).status,401,'an access token is never accepted as a SET');
 // Replay: within the window it is acknowledged and not reprocessed; after 10 minutes it fails freshness.
 assert.equal((await post(w.sent[0].body)).status,202);assert.equal((await w.received()).length,1);
 w.clock.advance(601000);assert.equal((await post(w.sent[0].body)).status,401);
 assert.equal(p.length>0,true);
});

test('the verifier checks typ and the connection before consulting any key',async t=>{
 const w=await world(t);let fetched=0;const keys=async()=>{fetched++;return w.keys.jwks();};
 const {token}=await w.keys.sign('event',{iss:ISSUER,sub:SUB,aud:'https://integration.example/bindle/events',iat:Math.floor(w.clock.now()/1000),jti:'A'.repeat(22),events:{[T['connection-revoked']]:{connection:'unknown',generation:2,seq:1,generation_floor:2,terminal:true}}});
 await assert.rejects(E.verifySecurityEventToken(token,{subject:SUB,keys,issuer:ISSUER,audience:'https://integration.example/bindle/events',connection:()=>false,now:w.clock.now()}),e=>e.reason==='connection');assert.equal(fetched,0);
 const verified=await E.verifySecurityEventToken(token,{keys,issuer:ISSUER,audience:'https://integration.example/bindle/events',subject:SUB,connection:()=>true,now:w.clock.now()});assert.equal(verified.payload.generation_floor,2);assert.equal(fetched,1);
 await assert.rejects(E.verifySecurityEventToken(token,{subject:SUB,keys,issuer:ISSUER,audience:'https://other.example/bindle/events',connection:()=>true,now:w.clock.now()}),e=>e.reason==='aud');
 await assert.rejects(E.verifySecurityEventToken(token,{keys,issuer:ISSUER,audience:'https://integration.example/bindle/events',subject:`${ISSUER}/entities/other`,connection:()=>true,now:w.clock.now()}),e=>e.reason==='sub');
 await assert.rejects(E.verifySecurityEventToken(token,{subject:SUB,keys,issuer:ISSUER,audience:'https://integration.example/bindle/events',connection:()=>true,now:w.clock.now()-31000}),e=>e.reason==='iat','iat more than 30 s ahead');
 const invoke=(await w.keys.sign('invoke',{a:1})).token;await assert.rejects(E.verifySecurityEventToken(invoke,{subject:SUB,keys,issuer:ISSUER,audience:'x',connection:()=>true,now:w.clock.now()}),e=>e.reason==='typ');
});

test('ordering and coalescing: one snapshot per fragment, strictly increasing seq, newer markers supersede in-flight ones',async t=>{
 const w=await world(t);
 for(const v of [1,2,3]){w.setValues(F,{v});await w.ev.mark(F);}
 assert.equal((await w.ev.status()).pending.length,1,'three markers for one fragment coalesce');
 assert.equal((await w.pump()).acknowledged,1);let got=await w.received();assert.equal(got.length,1);assert.deepEqual([got[0].seq,got[0].values],[1,{v:3}]);
 w.setValues(F,{v:4});await w.ev.mark(F);w.setValues(G,{g:1});await w.ev.mark(G);
 await w.ev.deliver();got=await w.received();assert.deepEqual(got.map(e=>[e.fragment,e.seq]),[[F,1],[F,2],[G,3]]);
 // A failed attempt freezes jti and seq; a newer marker replaces it with a fresh jti and seq, and the old SET is never retried.
 w.route.mode='down';w.setValues(F,{v:5});await w.ev.mark(F);assert.equal((await w.ev.deliver()).retrying,1);
 const failed=(await w.ev.status()).pending[0];assert.equal(failed.seq,4);const firstAttemptAt=failed.firstAttemptAt;
 w.setValues(F,{v:6});await w.ev.mark(F);const replaced=(await w.ev.status()).pending[0];assert.equal(replaced.seq,undefined);assert.equal(replaced.firstAttemptAt,firstAttemptAt,'the retry window carries over a superseded failure');
 w.route.mode='up';assert.equal((await w.ev.deliver()).acknowledged,1);got=await w.received();assert.deepEqual([got.at(-1).seq,got.at(-1).values],[5,{v:6}]);
 assert.equal(w.sent.filter(s=>eventOf(s.body).seq===4).length,1);
 // An unchanged retry is re-signed with a fresh iat and the same jti and seq.
 w.route.mode='down';w.setValues(F,{v:7});await w.ev.mark(F);await w.ev.deliver();w.clock.advance(11000);w.route.mode='up';await w.ev.deliver();
 const [a,b]=w.sent.slice(-2).map(s=>decode(s.body).claims);assert.equal(a.jti,b.jti);assert.notEqual(a.iat,b.iat);assert.equal(eventOf(w.sent.at(-1).body).seq,6);
 const seqs=w.sent.map(s=>eventOf(s.body).seq);assert.deepEqual([...new Set(seqs)],[...new Set(seqs)].sort((x,y)=>x-y),'seq never goes backwards');
 // Unsubscribed types are dropped, never sent.
 await w.ev.enqueue({type:'resource-detached',connection:w.connection.id,resource:'https://integration.example/r/1'});const before=w.sent.length;await w.ev.deliver();assert.equal(w.sent.length,before);
 assert.equal((await w.ev.status()).log.at(-1).code,'unsubscribed');
});

test('retries back off from ≤ 10 s to ≤ 1 h for 72 h, then the dead letter degrades the connection; delivery recovers it',async t=>{
 const w=await world(t);w.route.mode='down';w.setValues(F,{v:1});await w.ev.mark(F);
 const start=w.clock.now();assert.equal((await w.ev.deliver()).retrying,1);const delays=[];let last=start,result;
 for(let i=0;i<200;i++){const [row]=(await w.ev.status()).pending;if(!row)break;delays.push(row.nextAt-last);last=row.nextAt;w.clock.set(row.nextAt);result=await w.ev.deliver();}
 assert.ok(delays[0]<=10000&&delays[0]>=5000,`first retry ${delays[0]}`);assert.ok(delays.every(d=>d<=3600000));
 assert.ok(delays.every((d,i)=>i===0||d>=delays[i-1]||delays[i-1]>=1800000),'delays grow until the cap');
 assert.equal(result.expired,1);assert.ok(w.clock.now()-start>=72*3600000);
 const s=await w.ev.status();assert.equal(s.pending.length,0);assert.equal(s.log.at(-1).outcome,'expired');assert.equal(s.connections[0].degraded,true);
 assert.equal((await w.state()).state,'degraded');assert.ok(w.harness.audit.entries.some(e=>e.operation==='integration-events.delivery'&&e.outcome==='expired'));
 w.route.mode='up';w.setValues(F,{v:2});await w.ev.mark(F);assert.equal((await w.ev.deliver()).acknowledged,1);
 assert.equal((await w.state()).state,'active');assert.equal((await w.ev.status()).connections[0].degraded,false);
 // A revocation past its window is recorded as unacknowledged and never degrades the connection.
 w.route.mode='down';await w.ev.enqueue({type:'credential-revoked',connection:w.connection.id,grants:['g-1'],until:Math.floor(w.clock.now()/1000)+80*3600});
 await w.ev.deliver();for(let i=0;i<200;i++){const [row]=(await w.ev.status()).pending;if(!row)break;w.clock.set(row.nextAt);await w.ev.deliver();}
 const after=await w.ev.status();assert.equal(after.unacknowledged.at(-1).reason,'expired');assert.equal(after.unacknowledged.at(-1).type,'credential-revoked');assert.equal((await w.state()).state,'active');
});

test('budgets: a pass sends at most two rows per connection and a failing endpoint stops after one',async t=>{
 const w=await world(t);for(const f of [F,G,H]){w.setValues(f,{f});await w.ev.mark(f);}
 const first=await w.ev.deliver();assert.equal(first.acknowledged,2);assert.ok(first.next<=w.clock.now());
 assert.equal((await w.ev.deliver()).acknowledged,1);
 for(const f of [F,G]){w.setValues(f,{again:true});await w.ev.mark(f);}w.route.mode='down';
 const failing=await w.ev.deliver();assert.equal(failing.retrying,1);assert.equal(failing.pending,2);assert.ok(failing.next>w.clock.now(),'a failing connection sleeps until its retry');
 await assert.rejects(w.ev.deliver({limit:99}),{code:'invalid_request'});
 await assert.rejects(w.ev.mark('http://integration.example/x'),{code:'invalid_request'});
 await assert.rejects(w.ev.enqueue({type:'credential-revoked',connection:w.connection.id,grants:['g'],until:1,url:'https://evil.example/'}),{code:'invalid_request'},'callers cannot name a destination');
});

test('SSRF: endpoints must be public HTTPS names off the issuer; adapters refuse private resolution and never follow redirects',async t=>{
 for(const url of ['http://integration.example/e','https://10.0.0.1/e','https://[::1]/e','https://2130706433/e','https://localhost/e','https://metadata.internal/e','https://integration.example:8443/e','https://u:p@integration.example/e','https://integration.example/e?x=1','https://integration.example/e#f','https://provider.example/e','https://api.provider.example/e','https://integration.example/./e'])
  assert.equal(E.eventEndpointURL(url,{issuer:ISSUER}),null,url);
 assert.ok(E.eventEndpointURL('https://integration.example/bindle/events',{issuer:ISSUER}));
 const body='a.b.c',calls=[];
 const request=(options,callback)=>{calls.push(options);const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();Object.assign(res,{statusCode:options.respond??302,headers:{},destroy(){}});callback(res);setImmediate(()=>{if(options.big)res.emit('data',Buffer.alloc(5000));res.emit('end');});};return req;};
 const node=address=>E.createNodeEventEgress({issuer:ISSUER,lookup:async()=>[{address,family:4}],request});
 for(const address of ['10.0.0.5','127.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1'])await assert.rejects(node(address).send({url:'https://integration.example/bindle/events',body}),{code:'event_transport_unavailable'},address);
 assert.equal(calls.length,0,'nothing is sent to a private address');
 await assert.rejects(node('93.184.216.34').send({url:'https://provider.example/events',body}),{code:'event_transport_unavailable'});
 const redirected=await node('93.184.216.34').send({url:'https://integration.example/bindle/events',body});assert.equal(redirected.status,302);
 const [options]=calls;assert.equal(options.headers['Content-Type'],'application/secevent+jwt');assert.equal(options.agent,false);assert.equal(options.servername,'integration.example');
 options.lookup('integration.example',{all:true},(error,list)=>assert.deepEqual(list,[{address:'93.184.216.34',family:4}]));
 const bigRequest=(o,cb)=>request({...o,respond:202,big:true},cb);
 await assert.rejects(E.createNodeEventEgress({issuer:ISSUER,lookup:async()=>[{address:'93.184.216.34',family:4}],request:bigRequest}).send({url:'https://integration.example/bindle/events',body}),{code:'event_transport_unavailable'},'responses are bounded to 4 KiB');
 assert.throws(()=>E.createWorkerEventEgress({fetcher:fetch}),TypeError);
 const fetched=[];const dohFetcher=answer=>async(url,init)=>{fetched.push({url,init});const u=new URL(url);if(u.host==='cloudflare-dns.com'){const type=Number(u.searchParams.get('type'));return Response.json({Status:0,Question:[{name:u.searchParams.get('name'),type}],Answer:type===1?[{type:1,data:answer}]:[]},{headers:{'Content-Type':'application/dns-json'}});}return new Response(null,{status:202});};
 await assert.rejects(E.createWorkerEventEgress({publicRouting:true,fetcher:dohFetcher('127.0.0.1')}).send({url:'https://integration.example/bindle/events',body}),{code:'event_transport_unavailable'});
 assert.equal(fetched.some(f=>f.init.method==='POST'),false);
 const ok=await E.createWorkerEventEgress({publicRouting:true,fetcher:dohFetcher('93.184.216.34')}).send({url:'https://integration.example/bindle/events',body});assert.equal(ok.status,202);
 const post=fetched.find(f=>f.init.method==='POST');assert.equal(post.init.redirect,'manual');assert.equal(post.init.credentials,'omit');assert.equal(post.init.headers['Content-Type'],'application/secevent+jwt');
 // Delivery: a redirect is a failure (retried, never followed) and the destination is only ever the pinned endpoint.
 const w=await world(t);w.egress.send=async input=>{calls.push(input);return {status:307,bytes:new Uint8Array()};};
 w.setValues(F,{v:1});await w.ev.mark(F);const r=await w.ev.deliver();assert.equal(r.retrying,1);assert.equal((await w.ev.status()).pending[0].lastError,'redirect');
 assert.equal(calls.at(-1).url,'https://integration.example/bindle/events');
});

test('a crash between send and ack is at-least-once; the receiver dedupes by jti and orders by seq',async t=>{
 const w=await world(t,{crashable:true});
 // The reply is lost after the receiver processed the SET.
 w.setValues(F,{v:1});await w.ev.mark(F);w.route.mode='lost';assert.equal((await w.ev.deliver()).retrying,1);assert.equal((await w.received()).length,1);
 w.clock.advance(10000);assert.equal((await w.ev.deliver()).acknowledged,1);
 assert.equal(w.sent.length,2);assert.equal(decode(w.sent[0].body).claims.jti,decode(w.sent[1].body).claims.jti);assert.equal((await w.received()).length,1,'the duplicate jti was acknowledged, not reprocessed');
 // The process dies after the receiver answered 202 but before the acknowledgment commit.
 w.setValues(F,{v:2});await w.ev.mark(F);w.route.mode='crash';await assert.rejects(w.ev.deliver(),{code:'crashed'});
 const leased=(await w.ev.status()).pending[0];assert.equal(leased.attempts,1);assert.equal(leased.seq,2);
 w.clock.advance(10000);assert.equal((await w.ev.deliver()).acknowledged,1);
 const got=await w.received();assert.deepEqual(got.map(e=>e.seq),[1,2]);
 // A newer snapshot wins over a late replay of an older SET, which is still within the freshness window.
 w.setValues(F,{v:3});await w.ev.mark(F);await w.ev.deliver();
 const stale=w.sent.find(s=>eventOf(s.body).seq===2).body;
 assert.equal((await w.server.fetch('https://integration.example/bindle/events',{method:'POST',headers:{'Content-Type':E.SET_MEDIA_TYPE},body:stale})).status,202);
 assert.deepEqual((await w.server.snapshot()).connections[0].preferences[F].values,{v:3});
});

test('invalidation priority: revocations first, then resumes, then snapshots; across connections too; disconnect drops snapshots',async t=>{
 const w=await world(t),id=w.connection.id;
 w.setValues(F,{v:1});await w.ev.mark(F);
 await w.op(C.SuspendConnection,w.owner,{connection:id});await w.op(C.ResumeConnection,w.owner,{connection:id,expectedGeneration:2});
 await w.ev.ingest();assert.deepEqual((await w.ev.status()).pending.map(r=>r.type).sort(),['connection-resumed','connection-revoked','preferences-updated']);
 for(let i=0;i<3;i++)await w.ev.deliver();
 const types=w.sent.map(s=>eventOf(s.body));assert.deepEqual(types.map(e=>e.type),[T['connection-revoked'],T['connection-resumed'],PREFERENCES_UPDATED_EVENT]);
 assert.deepEqual(types.map(e=>e.seq),[1,2,3]);assert.deepEqual([types[0].generation_floor,types[0].terminal,types[1].generation,types[2].generation],[2,false,3,3]);
 let fixture=(await w.server.snapshot()).connections[0];assert.deepEqual([fixture.floor,fixture.highest,fixture.preferences[F].generation],[2,3,3]);
 // Revocation coalescing: suspend, resume, suspend collapse to the highest floor before anything is sent.
 await w.op(C.SuspendConnection,w.owner,{connection:id});await w.op(C.ResumeConnection,w.owner,{connection:id,expectedGeneration:4});await w.op(C.SuspendConnection,w.owner,{connection:id});
 await w.ev.ingest();const pending=(await w.ev.status()).pending;assert.deepEqual(pending.map(r=>r.type),['connection-revoked']);
 await w.ev.deliver();assert.equal(eventOf(w.sent.at(-1).body).generation_floor,6);
 // Snapshots are held while paused and dropped on disconnect; the terminal revocation still goes out.
 w.setValues(F,{v:2});await w.ev.mark(F);assert.equal((await w.ev.deliver()).held,1);
 await w.op(C.DisconnectConnection,w.owner,{connection:id});await w.pump();await w.ev.deliver();
 const last=eventOf(w.sent.at(-1).body);assert.deepEqual([last.type,last.terminal,last.generation_floor],[T['connection-revoked'],true,7]);
 assert.equal((await w.ev.status()).pending.length,0);assert.ok((await w.ev.status()).log.some(e=>e.code==='disconnected'));
 fixture=(await w.server.snapshot()).connections[0];assert.equal(fixture.floor,7);
 // Across connections, every due revocation goes before any other row.
 const second=await w.connectSecond();w.setValues(G,{g:1});await w.ev.mark(G,second.id);
 await w.ev.enqueue({type:'credential-revoked',connection:second.id,grants:['grant-9'],until:Math.floor(w.clock.now()/1000)+360});
 await w.ev.deliver();assert.deepEqual(w.other.seen.map(e=>e.type),[T['credential-revoked'],PREFERENCES_UPDATED_EVENT]);assert.deepEqual(w.other.seen.map(e=>e.seq),[1,2]);
});

test('an outbox gap is repaired from current connection state',async t=>{
 const w=await world(t),id=w.connection.id;await w.ev.ingest();
 // X4 rows this module never saw are acknowledged behind its back, so its cursor falls below the outbox low mark.
 await w.op(C.SuspendConnection,w.owner,{connection:id});await w.op(C.ResumeConnection,w.owner,{connection:id,expectedGeneration:2});
 const out=await w.op(C.ConnectionOutbox,w.system,{});await w.op(C.AckConnectionOutbox,w.system,{through:out.seq});
 const r=await w.ev.ingest();assert.equal(r.gap,true);
 assert.deepEqual((await w.ev.status()).pending.map(p=>p.type).sort(),['connection-resumed','connection-revoked']);
 for(let i=0;i<2;i++)await w.ev.deliver();const fixture=(await w.server.snapshot()).connections[0];assert.deepEqual([fixture.floor,fixture.highest],[3,3]);
 assert.equal((await w.ev.ingest()).ingested,0,'repair runs once');
});

test('review regressions: revocations always fit, a dead backlog expires together, verifier options are mandatory, deep stripping',async t=>{
 const w=await world(t,{limits:{perConnection:4,rows:8}}),id=w.connection.id;
 // X6-S1: a full connection still accepts revocations (evicting snapshot markers), and ingest keeps going.
 for(let i=0;i<4;i++){const f=`https://integration.example/preferences/f${i}/v1`;w.setValues(f,{i});await w.ev.mark(f);}
 await assert.rejects(w.ev.mark('https://integration.example/preferences/f9/v1'),{code:'integration_events_full'});
 await w.ev.enqueue({type:'credential-revoked',connection:id,grants:['g-1'],until:Math.floor(w.clock.now()/1000)+360});
 await w.op(C.SuspendConnection,w.owner,{connection:id});const ingested=await w.ev.ingest();assert.equal(ingested.full,false);
 const types=(await w.ev.status()).pending.map(r=>r.type);assert.ok(types.includes('credential-revoked')&&types.includes('connection-revoked'));assert.ok(types.filter(t=>t==='preferences-updated').length<=2);
 // Held rows of a paused connection age out after the window instead of occupying the caps forever.
 await w.ev.deliver();await w.ev.deliver();w.clock.advance(72*3600000);await w.ev.deliver();assert.equal((await w.ev.status()).pending.length,0);
 assert.ok((await w.ev.status()).log.some(e=>e.code==='stale'));
 // X6-S3: drops for an endpoint-less connection are not reported as unacknowledged revocations.
 assert.equal((await w.ev.status()).unacknowledged.length,0);
 // X6-S2: when the head row expires after 72 h of failure, the whole backlog of that connection expires with it.
 await w.op(C.ResumeConnection,w.owner,{connection:id,expectedGeneration:2});await w.ev.ingest();await w.ev.deliver();
 w.route.mode='down';for(const f of [F,G,H]){w.setValues(f,{x:1});await w.ev.mark(f);}
 for(let i=0;i<1000;i++){const rows=(await w.ev.status()).pending;if(!rows.length)break;w.clock.set(Math.min(...rows.map(r=>r.nextAt)));await w.ev.deliver();}
 assert.equal((await w.ev.status()).pending.length,0);assert.ok(w.clock.now()-Date.UTC(2026,9,20,12)<80*3600000+72*3600000,'one window, not one per row');
 // X6-S4: connection lookup and subject cannot be omitted.
 const {token}=await w.keys.sign('event',{iss:ISSUER,sub:SUB,aud:'https://integration.example/bindle/events',iat:Math.floor(w.clock.now()/1000),jti:'B'.repeat(22),events:{[T['connection-revoked']]:{connection:id,generation:9,seq:1,generation_floor:9,terminal:false}}});
 await assert.rejects(E.verifySecurityEventToken(token,{keys:await w.keys.jwks(),issuer:ISSUER,audience:'https://integration.example/bindle/events',now:w.clock.now()}),TypeError);
 // X6-S5: credentials nested under broker, or in contract-less references, are stripped too.
 w.route.mode='up';w.setValues(F,{store:{id:'r-1',label:'x',broker:{endpoint:'https://m.example/rpc',token:'nested-secret',expires_at:1}},token:'owner field'});await w.ev.mark(F);await w.ev.deliver();
 const body=w.sent.at(-1).body;assert.equal(Buffer.from(body.split('.')[1],'base64url').toString().includes('nested-secret'),false);assert.equal(eventOf(body).values.token,'owner field');
});

test('flag off and missing ports: nothing is refused silently, nothing is sent',async t=>{
 const w=await world(t,{enabled:false});await assert.rejects(w.ev.status(),{code:'not_found'});await assert.rejects(w.ev.deliver(),{code:'not_found'});
 const clock=fakeClock(Date.UTC(2026,9,20,12)),harness=await createTestEngine({clock,providers:{integrationEvents:E.integrationEventsProvider({enabled:true,issuer:ISSUER,connections:()=>{throw new Error('never');}})}});t.after(()=>harness.dispose());
 assert.deepEqual(await harness.perform(new E.DeliverIntegrationEvents({actor:{kind:'system',owner:OWNER}})),{ready:false});
 await assert.rejects(harness.perform(new E.DeliverIntegrationEvents({actor:{kind:'owner',owner:OWNER}})),{code:'forbidden'});
 assert.throws(()=>E.integrationEventsProvider({limits:{window:3600000}}),TypeError,'the 72 h window cannot be shortened');
 assert.throws(()=>E.integrationEventsProvider({limits:{firstRetry:60000}}),TypeError);
});

test('alarm-driven draining on the real AccountController (shared by the Worker object and Node)',async t=>{
 const db=new SqliteMetadata(':memory:');t.after(()=>db.close());const keys=brokeringKeys({issuer:ISSUER,secret:SECRET,metadata:memory()});
 const route={mode:'down'};let server;
 const egress={async send({url,body}){if(route.mode==='down')throw new Error('down');const response=await server.fetch(url,{method:'POST',headers:{'Content-Type':E.SET_MEDIA_TYPE},body});return {status:response.status,bytes:new Uint8Array(await response.arrayBuffer())};}};
 const config={APP_ORIGIN:ISSUER,KEY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),INTEGRATIONS_ENABLED:'true',IDENTITY_ACCOUNT:async owner=>owner===OWNER?{status:'active',handle:'alice'}:null,INTEGRATION_EVENT_PORTS:{signer:keys,egress,snapshot:async()=>({revision:'r1',values:{enabled:true}})}};
 const bucket={put:async()=>{},get:async()=>null,delete:async()=>{}},a=new AccountController({metadata:db,gate:new SerialGate(),blobs:bucket,archives:bucket,config,sql:db.sql});await a.touch(OWNER);
 const c=await a.connectionsSystem(OWNER,{operation:'connections.connect',input:snapshot()});
 server=createIntegrationServer({clock:{now:()=>Date.now()},connections:[{iss:ISSUER,id:c.id,sub:SUB,generation:c.generation}],verifyToken:async(token,{audience})=>(await E.verifySecurityEventToken(token,{subject:SUB,keys:await keys.jwks(),issuer:ISSUER,audience,connection:({connection})=>connection===c.id})).claims});t.after(()=>server.close());
 await a.integrationEventsMark(OWNER,{connection:c.id,fragment:F});assert.ok(await db.getAlarm()<=Date.now(),'marking wakes the alarm');
 const failed=await a.integrationEventsAlarm(OWNER);assert.equal(failed.delivered.retrying,1);
 const alarm=await db.getAlarm();assert.ok(alarm>=Date.now()+500&&alarm<=Date.now()+10500,`retry alarm ${alarm-Date.now()}`);
 route.mode='up';for(const [key,row] of await db.list({prefix:'integration-events/row/'}))await db.put(key,{...row,nextAt:0});
 const done=await a.integrationEventsAlarm(OWNER);assert.equal(done.delivered.acknowledged,1);assert.equal((await server.snapshot()).connections[0].preferences[F].values.enabled,true);
 assert.equal((await a.integrationEventsStatus(OWNER)).log.at(-1).outcome,'acknowledged');
 await a.connectionsOwner(OWNER,{operation:'connections.disconnect',input:{connection:c.id}});assert.equal(await a.integrationEventsKick(OWNER),true);
 await a.integrationEventsAlarm(OWNER);const fixture=(await server.snapshot()).connections[0];assert.equal(fixture.floor,c.generation+1);
 assert.equal((await a.connectionsSystem(OWNER,{operation:'connections.outbox',input:{}})).events.length,0,'ingested rows are acknowledged in the X4 outbox');
 const off=new AccountController({metadata:new SqliteMetadata(':memory:'),gate:new SerialGate(),blobs:bucket,archives:bucket,config:{...config,INTEGRATIONS_ENABLED:'false'},sql:db.sql});
 assert.deepEqual(await off.integrationEventsAlarm(OWNER),{ready:false});await assert.rejects(off.integrationEventsMark(OWNER,{connection:c.id,fragment:F}),{code:'not_found'});
});
