// EXT-X8 brokered consumer tokens and severance (packages/federation/introspection.mjs) over the real X4 connection
// store and X7 records: exact claims and scope attenuation, consumer/binding fencing, DPoP, mint versus sever races under
// the chaos scheduler, commit-first draining into X6 revocation rows, the 360 s bound with every invalidation lost, stale
// generations, overflow, live introspection for write methods (and its abuse cases), and flag gating.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppEngine,perform,read} from '../packages/app/engine.mjs';
import {memoryAudit} from '../packages/app/providers.mjs';
import {AppConnections} from '../packages/apps/connections.mjs';
import * as C from '../packages/app/domains/connections.mjs';
import * as B from '../packages/federation/brokered.mjs';
import * as X from '../packages/federation/introspection.mjs';
import {DiscoveryClient,DiscoveryBudget,createIntegrationEgress} from '../packages/federation/resource-discovery.mjs';
import {validateIntegrationManifest,validateJwks} from '../packages/federation/integrations.mjs';
import {brokeringKeys,mintAccessToken,verifyAccessToken} from '../packages/federation/signing.mjs';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {forEachSeed,createScheduler,fakeClock} from './helpers/chaos.mjs';

const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ISSUER='https://3sln.example',SUBJECT=`${ISSUER}/entities/${OWNER}`;
const MODEL='https://spec.bindle.example/contracts/decision-model/v1',FRAGMENT='https://notes.example/preferences/models/v1',APP='https://notes.example/client.json',OTHER_APP='https://other.example/client.json';
const PINS=X.contractPins({[MODEL]:{methods:{decide:{effect:'read'},train:{effect:'write'}}}});
const SECRET=Buffer.alloc(32,8).toString('base64'),ROW_PREFIX='integration-events/row/';
const code=c=>e=>{assert.equal(e.code,c,`expected ${c}, got ${e.code}: ${e.message}`);return true;};
const b64u=bytes=>Buffer.from(bytes).toString('base64url');
function memory(){const map=new Map();let tail=Promise.resolve();return {transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},list:async()=>[]}));tail=run.catch(()=>{});return run;}};}
const sharedKeys=brokeringKeys({issuer:ISSUER,secret:SECRET,metadata:memory()});

/** An integration's ES256 client key with the RFC 7638 thumbprint X3 pins. */
async function clientKey(){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey);const set=await validateJwks(crypto,{keys:[{kty,crv,x,y,kid:'k1',alg:'ES256',use:'sig'}]});return {pair,set};}
async function assertion(key,{clientId,audience=ISSUER+X.INTROSPECTION_PATH,iat=Math.floor(Date.now()/1000),exp=iat+60,jti=b64u(crypto.getRandomValues(new Uint8Array(16))),extra={}}){
 const head=b64u(Buffer.from(JSON.stringify({alg:'ES256',kid:'k1',typ:'JWT'}))),body=b64u(Buffer.from(JSON.stringify({iss:clientId,sub:clientId,aud:audience,iat,exp,jti,...extra})));
 return `${head}.${body}.${b64u(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.pair.privateKey,new TextEncoder().encode(`${head}.${body}`))))}`;
}
function snapshot(host,{dpop,thumbprints=['A'.repeat(43)]}={}){
 const clientId=`https://${host}/bindle/client.json`,redirectUris=[`https://${host}/bindle/callback`],jwksUri=`https://${host}/bindle/jwks.json`;
 const r=validateIntegrationManifest({v:1,resources:{rpc_endpoint:`https://${host}/bindle/rpc`,discovery_endpoint:`https://${host}/bindle/resources`,contracts:[MODEL],...dpop?{dpop}:{}}},{clientId,confidential:true,redirectUris,jwksUri});assert.equal(r.status,'valid',r.reason);
 return {client:{id:clientId,name:host},snapshot:{clientId,redirectUris,authMethod:'private_key_jwt',jwksUri,thumbprints,manifest:r.manifest}};
}
function integration(host,keys,clock){
 const items=[{id:`https://${host}/r/fast`,label:'Fast model',contracts:[MODEL]},{id:`https://${host}/r/slow`,label:'Slow model',contracts:[MODEL]}];
 return {items,fetch:async(url,init)=>{const token=new Request(url,init).headers.get('authorization')?.slice(7),body=JSON.parse(init.body);
  try{await verifyAccessToken(token,{keys:await keys.jwks(),issuer:ISSUER,audience:url,purposes:['discover'],now:clock.now()});}catch{return Response.json({error:'invalid_token'},{status:401});}
  const found=items.filter(i=>body.contracts.every(c=>i.contracts.includes(c))&&(!body.ids||body.ids.includes(i.id)));return Response.json({v:1,items:found.map(i=>({container:false,facets_applied:[],...i})),cursor:null});}};
}
/** X4 + X7 + X8 engines over one SQLite account store. `wrap(store)` decorates the store the X7/X8 engines see. */
async function fixture(t,{introspection=false,wrap,clock=fakeClock(Date.now()),keys=sharedKeys}={}){
 const metadata=new SqliteMetadata(':memory:');await metadata.put('owner',OWNER);t.after(()=>metadata.close());
 let n=0;const connections=new AppConnections({metadata,origin:ISSUER,clock:clock.now,uuid:()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`});
 const random={uuid:()=>crypto.randomUUID(),bytes:k=>crypto.getRandomValues(new Uint8Array(k))},audit=memoryAudit({clock});
 const cx=createAppEngine({providers:{clock,random,audit,connections:C.connectionsProvider({connections,enabled:true,account:async()=>({status:'active'})})}});
 const routes={},route=(url,init)=>{const host=new URL(url).hostname;if(!routes[host])throw Object.assign(new Error('unrouted'),{code:'egress_refused'});return routes[host].fetch(url,init);};
 const discovery=new DiscoveryClient({issuer:ISSUER,mint:claims=>mintAccessToken(keys,claims,{clock:clock.now}),egress:createIntegrationEgress({fetcher:route,resolve:async()=>['93.184.216.34'],publicRouting:true}),budget:new DiscoveryBudget({budgets:{connectionPerMinute:1000,integrationPerMinute:1000}}),clock:clock.now});
 const store=wrap?wrap(metadata):metadata,signer=claims=>mintAccessToken(keys,claims,{clock:clock.now});
 const x7=createAppEngine({providers:{clock,random,audit,brokeredResources:B.brokeredResourcesProvider({store,discovery,issuer:ISSUER,integrations:true,brokering:true,clock:clock.now})}});
 const x8=X.brokeredTokensEngine({store,issuer:ISSUER,integrations:true,brokering:true,mint:signer,pins:PINS,introspection,clock,random,audit});
 const owner={kind:'owner',owner:OWNER,authTime:clock.now()},system={kind:'system',owner:OWNER};
 const op=(engine,Operation,actor,input)=>{const o=new Operation({actor,...input===undefined?{}:{input}});return o instanceof C.ConnectionList?read(engine,o):perform(engine,o);};
 const q=(Operation,input,actor=system)=>X.runBrokered(x8,Operation,{actor,...input===undefined?{}:{input}});
 const connect=async(host,options)=>{routes[host]??=integration(host,keys,clock);return op(cx,C.ConnectIntegration,system,snapshot(host,options));};
 const register=async(connection,resource,{clientId=APP,field='model'}={})=>perform(x7,new B.RegisterBrokeredRecord({actor:owner,input:{connection,resource,binding:{fragment:FRAGMENT,field},consumer:{clientId},contracts:[MODEL]}}));
 const severance=async(after=0)=>read(x7,new B.BrokeredSeverance({actor:system,input:{after}}));
 const mint=(input={})=>q(X.MintBrokeredToken,{clientId:APP,fragment:FRAGMENT,field:'model',methods:{[MODEL]:['decide','train']},...input});
 const verify=async(token,{now=clock.now(),leeway=30,audience}={})=>verifyAccessToken(token,{keys:await keys.jwks(),issuer:ISSUER,audience,purposes:['invoke'],now,leeway});
 return {metadata,clock,keys,cx,x7,x8,owner,system,op,q,connect,register,severance,mint,verify,routes};
}
const unassign=(f,record,grant)=>perform(f.x7,new B.UnassignBrokeredRecord({actor:f.owner,input:{record,grant}}));
const detach=(f,record)=>perform(f.x7,new B.DetachBrokeredRecord({actor:f.owner,input:{record}}));
const x6rows=async f=>[...(await f.metadata.list({prefix:ROW_PREFIX})).values()];

test('mint: exact RFC 9068 claims, scope attenuation by grant, record and pin, and consumer/binding fencing',async t=>{
 const f=await fixture(t),a=await f.connect('models.example'),r=await f.register(a.id,'https://models.example/r/fast'),grant=r.assignments[0].grant;
 const m=await f.mint({record:r.id,methods:{[MODEL]:['decide','train','unpinned'],'https://spec.bindle.example/contracts/other/v1':['x']}});
 assert.deepEqual(m.methods,{[MODEL]:['decide']},'write-capable `train` needs live introspection; unpinned methods and unrecorded contracts drop');
 assert.equal(m.endpoint,'https://models.example/bindle/rpc');assert.equal(m.origin,'https://models.example');assert.equal(m.resource,'https://models.example/r/fast');assert.equal(m.tokenType,'Bearer');
 const {claims,header}=await f.verify(m.token,{audience:m.endpoint});
 assert.equal(header.typ,'at+jwt');assert.equal(claims.client_id,APP);assert.equal(claims.sub,SUBJECT);assert.equal(claims.exp-claims.iat,300);assert.equal(claims.exp*1000,m.expiresAt);
 assert.deepEqual(claims.bindle,{v:1,purpose:'invoke',connection:a.id,generation:a.generation,resource:'https://models.example/r/fast',grant,methods:{[MODEL]:['decide']},scope:null});
 const g=await fixture(t,{introspection:true}),b=await g.connect('models.example'),s=await g.register(b.id,'https://models.example/r/fast');
 assert.deepEqual((await g.mint({record:s.id})).methods,{[MODEL]:['decide','train']},'with introspection mounted, write methods are mintable');
 assert.deepEqual((await g.mint({record:s.id,methods:{[MODEL]:['train']}})).methods,{[MODEL]:['train']},'never wider than the grant asks');
 // Confused deputy: another app, another field, the issuer itself or an unknown record never borrows this assignment.
 await assert.rejects(f.mint({record:r.id,clientId:OTHER_APP}),code('resource_unavailable'));
 await assert.rejects(f.mint({record:r.id,field:'other'}),code('resource_unavailable'));
 await assert.rejects(f.mint({record:r.id,fragment:'https://notes.example/preferences/other/v1'}),code('resource_unavailable'));
 await assert.rejects(f.mint({record:r.id,clientId:ISSUER}),code('invalid_request'));
 await assert.rejects(f.mint({record:crypto.randomUUID()}),code('resource_unavailable'));
 await assert.rejects(f.mint({record:r.id,methods:{[MODEL]:['train']}}),code('resource_unavailable'),'nothing left after attenuation mints nothing');
 await assert.rejects(f.q(X.MintBrokeredToken,{clientId:APP,record:r.id,fragment:FRAGMENT,field:'model',methods:{[MODEL]:['decide']}},f.owner),code('forbidden'),'owners never mint consumer tokens');
});

test('DPoP: a bound consumer is bound where supported; `required` without a key mints nothing (§5.4)',async t=>{
 const f=await fixture(t),jkt='J'.repeat(43);
 const sup=await f.connect('sup.example',{dpop:'supported'}),req=await f.connect('req.example',{dpop:'required'});
 const rs=await f.register(sup.id,'https://sup.example/r/fast'),rr=await f.register(req.id,'https://req.example/r/fast');
 const bound=await f.mint({record:rs.id,jkt});assert.equal(bound.tokenType,'DPoP');assert.equal((await f.verify(bound.token,{audience:bound.endpoint})).claims.cnf.jkt,jkt);
 assert.equal((await f.mint({record:rs.id})).tokenType,'Bearer');
 await assert.rejects(f.mint({record:rr.id}),code('resource_unavailable'));assert.equal((await f.mint({record:rr.id,jkt})).tokenType,'DPoP');
});

test('mint versus sever under the chaos scheduler: a token is released before the commit or refused, never after',async t=>{
 const outcomes={minted:0,refused:0};
 await forEachSeed(24,async random=>{
  const scheduler=createScheduler(random),clock=fakeClock(Date.now());
  // Every account-store transaction advances time, so commit order is visible in timestamps.
  const timed=store=>new Proxy(store,{get(target,key){const v=Reflect.get(target,key);if(key==='transaction')return fn=>{clock.advance(1000);return v.call(target,fn);};return typeof v==='function'?v.bind(target):v;}});
  let gated;const f=await fixture(t,{clock,wrap:store=>gated=scheduler.wrap(timed(store),'store')}),a=await f.connect('models.example'),r=await f.register(a.id,'https://models.example/r/fast'),grant=r.assignments[0].grant;
  // The severance arrives after a random delay (parked reads), so both orders occur.
  const delay=random.int(14),sever=async()=>{for(let i=0;i<delay;i++)await gated.get('owner');return random.chance(0.5)?detach(f,r.id):unassign(f,r.id,grant);};
  const [m,s]=await scheduler.run([()=>f.mint({record:r.id}),sever]);
  assert.equal(s.status,'fulfilled',String(s.reason?.message));
  const row=(await f.severance()).rows.find(x=>x.grants.includes(grant));assert.ok(row,'the severance row committed with the change');
  if(m.status==='fulfilled'){outcomes.minted++;
   assert.ok(m.value.expiresAt<=row.at+300000,`exp ${m.value.expiresAt} must not outlive commit ${row.at} + 300 s`);
   await assert.rejects(f.verify(m.value.token,{audience:m.value.endpoint,now:row.at+X.ACCESS_ENDS_BY_MS-30000}),code('invalid_token'),'dead by access_ends_by even with the verifier clock 30 s behind');
  }else{outcomes.refused++;assert.equal(m.reason.code,'resource_unavailable',String(m.reason?.message));}
  await assert.rejects(f.mint({record:r.id}),code('resource_unavailable'),'no refresh after severance');
 });
 assert.ok(outcomes.minted>0&&outcomes.refused>0,`both orders exercised: ${JSON.stringify(outcomes)}`);
});

test('severance commits first, drains in order into X6 revocations with access_ends_by, and the bound holds when every event is lost',async t=>{
 const f=await fixture(t),a=await f.connect('models.example'),fast=await f.register(a.id,'https://models.example/r/fast'),slow=await f.register(a.id,'https://models.example/r/slow');
 const token=await f.mint({record:fast.id}),grant=fast.assignments[0].grant;
 f.clock.advance(10000);await unassign(f,fast.id,grant);const unassignedAt=f.clock.now();
 await assert.rejects(f.mint({record:fast.id}),code('resource_unavailable'),'refresh is refused from the commit, before any event');
 assert.equal((await x6rows(f)).length,0,'nothing is sent before the drain; the X7 row is the durable outbox');
 f.clock.advance(1000);await detach(f,slow.id);const detachedAt=f.clock.now();
 assert.deepEqual((await f.q(X.BrokeredSeveranceStatus)).pending,2);
 const drained=await f.q(X.DrainBrokeredSeverance);assert.equal(drained.drained,2);
 const rows=await x6rows(f),revoked=rows.filter(r=>r.type==='credential-revoked'),detachedRows=rows.filter(r=>r.type==='resource-detached');
 assert.deepEqual(revoked.flatMap(r=>r.grants).sort(),[grant,slow.assignments[0].grant].sort());
 assert.equal(revoked[0].until,Math.ceil((detachedAt+X.ACCESS_ENDS_BY_MS)/1000),'one coalesced row per connection carries the latest until');
 assert.deepEqual(detachedRows.map(r=>r.resource),['https://models.example/r/slow']);
 assert.equal((await f.severance()).rows.length,0,'X7 rows are acknowledged only after the X6 commit');
 const status=await f.q(X.BrokeredSeveranceStatus);assert.equal(status.pending,0);
 assert.deepEqual(status.severances.map(s=>[s.type,s.accessEndsBy]),[['unassigned',unassignedAt+360000],['detached',detachedAt+360000]]);
 assert.deepEqual(await f.q(X.DrainBrokeredSeverance),{drained:0,cursor:status.cursor},'idempotent');assert.equal((await x6rows(f)).length,rows.length);
 // Every invalidation lost: a conforming verifier that never heard of the revocation still rejects by access_ends_by.
 const {claims}=await f.verify(token.token,{audience:token.endpoint});assert.ok(claims.exp*1000<=unassignedAt+300000);
 await assert.rejects(f.verify(token.token,{audience:token.endpoint,now:unassignedAt+X.ACCESS_ENDS_BY_MS-30000}),code('invalid_token'));
});

test('a crashed drain re-reads from its cursor and never duplicates; overflow revokes every current grant of the connection',async t=>{
 let failAck=true;const f=await fixture(t),a=await f.connect('models.example'),fast=await f.register(a.id,'https://models.example/r/fast'),slow=await f.register(a.id,'https://models.example/r/slow');
 await unassign(f,fast.id,fast.assignments[0].grant);
 const engine=X.brokeredTokensEngine({store:f.metadata,issuer:ISSUER,integrations:true,brokering:true,mint:()=>{},pins:PINS,clock:f.clock,random:{uuid:()=>crypto.randomUUID(),bytes:k=>crypto.getRandomValues(new Uint8Array(k))},audit:memoryAudit({clock:f.clock})});
 // The X8 commit lands, then the X7 acknowledgment is lost.
 const original=B.BrokeredResourcesProvider.prototype.obtain;
 B.BrokeredResourcesProvider.prototype.obtain=async function(options){const h=await original.call(this,options);return failAck?Object.freeze({...h,severanceDone:async()=>{failAck=false;throw Object.assign(new Error('lost'),{code:'injected_fault'});}}):h;};
 t.after(()=>{B.BrokeredResourcesProvider.prototype.obtain=original;});
 await assert.rejects(X.runBrokered(engine,X.DrainBrokeredSeverance,{actor:f.system}),code('injected_fault'));
 assert.equal((await x6rows(f)).length,1);assert.equal((await f.severance()).rows.length,1,'X7 row still unacknowledged');
 assert.equal((await X.runBrokered(engine,X.DrainBrokeredSeverance,{actor:f.system})).drained,0,'the cursor skips what was already enqueued');
 assert.equal((await x6rows(f)).length,1);assert.equal((await f.severance()).rows.length,1);
 // A later row acknowledges through the cursor.
 await f.metadata.transaction(async tx=>{const m=await tx.get('integrations/meta');m.seq++;await tx.put('integrations/severance/~'+a.id,{seq:m.seq,at:f.clock.now(),type:'overflow',connection:a.id,generation:a.generation,grants:[]});await tx.put('integrations/meta',m);});
 assert.equal((await f.q(X.DrainBrokeredSeverance)).drained,1);assert.equal((await f.severance()).rows.length,0);
 const overflow=(await x6rows(f)).filter(r=>r.type==='credential-revoked').at(-1);assert.deepEqual(overflow.grants,[slow.assignments[0].grant],'X7-R4: every current grant of the overflowing connection');
});

test('stale generations and paused connections mint nothing and introspect inactive',async t=>{
 const f=await fixture(t),a=await f.connect('models.example'),r=await f.register(a.id,'https://models.example/r/fast'),m=await f.mint({record:r.id});
 const live=input=>f.q(X.IntrospectBrokeredToken,{connection:a.id,generation:a.generation,resource:r.resource,grant:r.assignments[0].grant,methods:{[MODEL]:['decide']},clientId:APP,audience:m.endpoint,iat:Math.floor(f.clock.now()/1000),...input});
 assert.equal((await live()).active,true);assert.equal((await live({generation:a.generation+1})).active,false,'a generation the record does not carry');
 await f.op(f.cx,C.SuspendConnection,f.owner,{connection:a.id});await assert.rejects(f.mint({record:r.id}),code('resource_unavailable'));assert.equal((await live()).active,false);
 await f.op(f.cx,C.ResumeConnection,f.owner,{connection:a.id,expectedGeneration:a.generation+1});
 await assert.rejects(f.mint({record:r.id}),code('resource_unavailable'),'resume leaves the record stale until an authenticated lookup rebinds it');
 assert.equal((await live()).active,false);assert.equal((await live({generation:a.generation+2})).active,false);
 await f.op(f.cx,C.DisconnectConnection,f.owner,{connection:a.id});await assert.rejects(f.mint({record:r.id}),code('resource_unavailable'));
});

/** The issuer-side endpoint with real account checks and a controllable federation half. */
async function introspection(t){
 const key=await clientKey(),intruder=await clientKey(),f=await fixture(t,{introspection:true});
 const a=await f.connect('models.example',{thumbprints:key.set.thumbprints}),b=await f.connect('evil.example',{thumbprints:intruder.set.thumbprints});
 const r=await f.register(a.id,'https://models.example/r/fast');let grantLive=true;const calls=[];
 const ports={issuer:ISSUER,enabled:true,clock:f.clock.now,replay:X.memoryReplayCache({clock:f.clock.now}),limiter:X.introspectionLimiter({clock:f.clock.now}),
  verifyToken:(token,options)=>f.keys.verify(token,{...options,now:f.clock.now()}),
  account:owner=>({brokeredIntegrationAuth:input=>{calls.push(['auth',owner,input]);return f.q(X.BrokeredIntegrationAuth,input);},brokeredIntrospect:input=>f.q(X.IntrospectBrokeredToken,input)}),
  federation:()=>({brokeredGrantLive:async input=>{calls.push(['grant',input]);return grantLive;}}),
  clientKeys:async ({clientId})=>clientId===a.clientId?key.set:clientId===b.clientId?intruder.set:null};
 const post=async(fields,{method='POST',type='application/x-www-form-urlencoded',origin=ISSUER}={})=>X.handleBrokeredIntrospection(new Request(origin+X.INTROSPECTION_PATH,{method,headers:{'Content-Type':type},...method==='POST'?{body:new URLSearchParams(fields).toString()}:{}}),ports);
 const ask=async(token,signer=key,clientId=a.clientId,extra={})=>post({token,client_assertion_type:X.CLIENT_ASSERTION_TYPE,client_assertion:await assertion(signer,{clientId,iat:Math.floor(f.clock.now()/1000),...extra}),...extra.fields??{}});
 return {f,a,b,r,key,intruder,ports,post,ask,calls,setGrant:v=>{grantLive=v;}};
}
/** A conforming write-capable resource server: local §5.5 checks, then live introspection for write methods (AMD-C8). */
async function integrationWrite(env,token,method){
 try{await env.f.verify(token,{audience:'https://models.example/bindle/rpc'});}catch{return 401;}
 if(!X.writeCapable(PINS,MODEL,method))return 200;
 const response=await env.ask(token);if(response.status!==200)return 503;const body=await response.json();return body.active===true&&body.bindle.methods[MODEL]?.includes(method)?200:403;
}

test('introspection: a write is admitted live and refused right after severance, well inside the token lifetime',async t=>{
 const env=await introspection(t),{f,r}=env,m=await f.mint({record:r.id});assert.deepEqual(m.methods,{[MODEL]:['decide','train']});
 const response=await env.ask(m.token);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 const body=await response.json();assert.equal(body.active,true);assert.equal(body.client_id,APP);assert.equal(body.aud,'https://models.example/bindle/rpc');assert.deepEqual(body.bindle.methods,{[MODEL]:['decide','train']});
 assert.ok(env.calls.some(([kind,input])=>kind==='grant'&&input.resourceId===X.brokeredResourceId(SUBJECT,r.id)&&input.fragment===FRAGMENT&&input.field==='model'),'the federation grant is checked live');
 assert.equal(await integrationWrite(env,m.token,'train'),200);
 f.clock.advance(5000);await unassign(f,r.id,r.assignments[0].grant);
 assert.equal(await integrationWrite(env,m.token,'decide'),200,'read-only methods rely on the 360 s bound');
 assert.equal(await integrationWrite(env,m.token,'train'),403,'the write is refused at once, with no cached authorization');
 assert.deepEqual(await(await env.ask(m.token)).json(),{active:false});
 const again=await f.register(env.a.id,'https://models.example/r/fast'),fresh=await f.mint({record:again.id});
 assert.equal(await integrationWrite(env,fresh.token,'train'),200);assert.equal(await integrationWrite(env,m.token,'train'),403,'re-adding never revives the old grant');
 env.setGrant(false);assert.equal(await integrationWrite(env,fresh.token,'train'),403,'a revoked federation grant is inactive');
});

test('introspection abuse: client authentication, cross-integration tokens, audience and purpose confusion, replay',async t=>{
 const env=await introspection(t),{f,a,b,r,key,intruder}=env,m=await f.mint({record:r.id});
 assert.equal((await env.ask(m.token,intruder)).status,401,'a key that is not pinned to the token\'s connection');
 assert.equal((await env.ask(m.token,intruder,b.clientId)).status,401,'another integration presenting this connection\'s token');
 assert.equal((await env.ask(m.token,key,a.clientId,{audience:'https://3sln.example/oauth/token'})).status,401,'assertion audience');
 assert.equal((await env.ask(m.token,key,a.clientId,{exp:Math.floor(f.clock.now()/1000)+3600})).status,401,'assertion lifetime');
 assert.equal((await env.ask(m.token,key,a.clientId,{fields:{client_id:b.clientId}})).status,401,'client_id must name the authenticated client');
 const jti='replayed-assertion-0001';assert.equal((await env.ask(m.token,key,a.clientId,{jti})).status,200);assert.equal((await env.ask(m.token,key,a.clientId,{jti})).status,401,'jti replay');
 assert.equal((await env.post({token:m.token,client_assertion_type:'urn:other',client_assertion:'x'})).status,401);
 assert.equal((await env.ask('not-a-token')).status,401,'no connection to authenticate against, and nothing fetched');
 // A token naming a connection the caller cannot prove: forged sub and an unknown connection never fetch keys.
 const fetched=[];env.ports.clientKeys=async input=>{fetched.push(input.clientId);return input.clientId===a.clientId?key.set:intruder.set;};
 const unknown=await mintAccessToken(f.keys,{subject:SUBJECT,audience:'https://models.example/bindle/rpc',clientId:APP,connection:crypto.randomUUID(),generation:1,resource:'https://models.example/r/fast',grant:'g',methods:{[MODEL]:['train']}});
 assert.equal((await env.ask(unknown.token)).status,401);assert.deepEqual(fetched,[],'lookup before fetch');
 // Authenticated, but the token is not an app invoke token for this integration's rpc endpoint.
 const ask=async token=>(await(await env.ask(token)).json()).active;
 const discover=await mintAccessToken(f.keys,{subject:SUBJECT,audience:'https://models.example/bindle/resources',clientId:ISSUER,purpose:'discover',connection:a.id,generation:a.generation});
 assert.equal(await ask(discover.token),false,'discover tokens');
 const describe=await mintAccessToken(f.keys,{subject:SUBJECT,audience:'https://models.example/bindle/rpc',clientId:ISSUER,purpose:'describe',connection:a.id,generation:a.generation,resource:r.resource,grant:r.assignments[0].grant,methods:{'https://3sln.me/artefacts/contracts/resource-scoping/v1':['describe']}});
 assert.equal(await ask(describe.token),false,'describe tokens');
 const elsewhere=await mintAccessToken(f.keys,{subject:SUBJECT,audience:'https://evil.example/bindle/rpc',clientId:APP,connection:a.id,generation:a.generation,resource:'https://evil.example/r/fast',grant:r.assignments[0].grant,methods:{[MODEL]:['train']}});
 assert.equal(await ask(elsewhere.token),false,'audience of another integration');
 const widened=await mintAccessToken(f.keys,{subject:SUBJECT,audience:m.endpoint,clientId:APP,connection:a.id,generation:a.generation,resource:r.resource,grant:r.assignments[0].grant,methods:{[MODEL]:['train','delete']}});
 assert.equal(await ask(widened.token),false,'methods beyond the pin');
 const forged=m.token.slice(0,-4)+(m.token.endsWith('AAAA')?'BBBB':'AAAA');assert.equal(await ask(forged),false,'signature');
 f.clock.advance(301000);assert.equal(await ask(m.token),false,'expired, with no leeway at introspection');
 assert.equal((await env.post({token:m.token},{method:'GET'})).status,405);assert.equal((await env.post({token:m.token},{type:'application/json'})).status,400);
 assert.equal((await env.post({token:m.token},{origin:'https://evil.example'})).status,403);
 assert.equal(await X.handleBrokeredIntrospection(new Request(ISSUER+X.INTROSPECTION_PATH,{method:'POST'}),{...env.ports,enabled:false}),null,'unmounted without the flags');
});

test('flags, actors and the account slice: not_found unless both flags are on and the owner binding matches',async t=>{
 const metadata=new SqliteMetadata(':memory:');await metadata.put('owner',OWNER);t.after(()=>metadata.close());
 const controller=config=>({config:{APP_ORIGIN:ISSUER,...config},metadata});
 for(const config of [{},{INTEGRATIONS_ENABLED:'true'},{BROKERING_ENABLED:'true'}]){
  await assert.rejects(X.account.methods.brokeredMint.call(controller(config),OWNER,{}),code('not_found'));assert.deepEqual(await X.account.methods.brokeredDescriptors.call(controller(config),OWNER),[]);
 }
 const on=controller({INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true'});
 await assert.rejects(X.account.methods.brokeredMint.call(on,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',{}),code('not_found'),'another owner');
 await assert.rejects(X.account.methods.brokeredMint.call(on,OWNER,{clientId:APP,record:crypto.randomUUID(),fragment:FRAGMENT,field:'model',methods:{[MODEL]:['decide']}}),code('brokering_unavailable'),'no consumer mint port');
 assert.deepEqual(await X.account.methods.brokeredDescriptors.call(on,OWNER),[]);assert.deepEqual(Object.keys(X.account.rpc).sort(),['brokeredDescriptors','brokeredFederationEvent','brokeredIntegrationAuth','brokeredIntrospect','brokeredMint','brokeredSeq']);
 const off=X.brokeredTokensEngine({store:metadata,issuer:ISSUER,integrations:true,brokering:false,mint:()=>{},clock:fakeClock(),random:{uuid:()=>crypto.randomUUID(),bytes:k=>new Uint8Array(k)},audit:memoryAudit()});
 await assert.rejects(X.runBrokered(off,X.BrokeredDescriptors,{actor:{kind:'system',owner:OWNER}}),code('not_found'));
 const {integrationPorts}=await import('../packages/runtime/integration-ports.mjs'),mint=async claims=>claims;
 const ports=integrationPorts({INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true',APP_ORIGIN:ISSUER},{mint,introspection:true,snapshot:X.preferencesSnapshotPort(()=>({integrationSnapshot:async()=>({revision:null,values:null})}))});
 assert.equal(ports.INTEGRATION_EVENT_PORTS.snapshot.available,true);assert.equal(ports.BROKERED_INTROSPECTION_MOUNTED,true);
 await assert.rejects(async()=>ports.BROKERING_CONSUMER_MINT({purpose:'invoke',clientId:ISSUER}),code('invalid_request'),'the consumer port never mints provider-consumer tokens');
 await assert.rejects(async()=>ports.BROKERING_CONSUMER_MINT({purpose:'discover',clientId:APP}),code('invalid_request'));
 assert.equal(integrationPorts({INTEGRATIONS_ENABLED:'true',APP_ORIGIN:ISSUER},{mint,snapshot:ports.INTEGRATION_EVENT_PORTS.snapshot}).INTEGRATION_EVENT_PORTS.snapshot.available,false,'X8 snapshots need BROKERING_ENABLED');
});

test('X8-R1: a grant revoked by unavailable → reconfirm neither mints inside its window nor revives an older token',async t=>{
 const f=await fixture(t),a=await f.connect('models.example'),r=await f.register(a.id,'https://models.example/r/fast'),grant=r.assignments[0].grant,old=await f.mint({record:r.id});
 const iat=Math.floor(f.clock.now()/1000),live=input=>f.q(X.IntrospectBrokeredToken,{connection:a.id,generation:a.generation,resource:r.resource,grant,methods:{[MODEL]:['decide']},clientId:APP,audience:old.endpoint,iat,...input});
 const box=f.routes['models.example'],kept=[...box.items];box.items.splice(0,box.items.length,...kept.filter(i=>i.id!==r.resource));
 f.clock.advance(5000);await perform(f.x7,new B.RevalidateBrokeredRecords({actor:f.owner,input:{connection:a.id}}));
 box.items.splice(0,box.items.length,...kept);f.clock.advance(1000);const back=await perform(f.x7,new B.ReconfirmBrokeredRecord({actor:f.owner,input:{record:r.id}}));
 assert.equal(back.assignments[0].grant,grant,'X7 keeps the grant id');
 await assert.rejects(f.mint({record:r.id}),code('resource_unavailable'),'undrained revocation');assert.equal((await live()).active,false,'no ABA revival');
 await f.q(X.DrainBrokeredSeverance);await assert.rejects(f.mint({record:r.id}),code('resource_unavailable'),'drained revocation, inside access_ends_by');assert.equal((await live()).active,false);
 f.clock.advance(X.ACCESS_ENDS_BY_MS+1000);const fresh=await f.mint({record:r.id});assert.equal((await live({iat:Math.floor(f.clock.now()/1000)})).active,true,'usable again once every integration has dropped the revocation');assert.ok(fresh.token);
 assert.equal((await live()).active,false,'the pre-revocation token never revives');
});

test('X8-R4: unauthenticated junk does not starve an authenticated integration',async t=>{
 const env=await introspection(t),m=await env.f.mint({record:env.r.id});
 for(let i=0;i<1300;i++)assert.equal((await env.post({token:'junk',client_assertion_type:X.CLIENT_ASSERTION_TYPE,client_assertion:'x'})).status,401);
 assert.equal((await env.ask(m.token)).status,200);
});

test('W5-S5: forged introspections naming a real connection cannot spend its authenticated window',async t=>{
 const env=await introspection(t),{f,r}=env,m=await f.mint({record:r.id});env.ports.limiter=X.introspectionLimiter({clock:f.clock.now,perMinute:2});
 for(let i=0;i<5;i++)assert.equal((await env.ask(m.token,env.intruder)).status,401,'a wrong key is refused');
 for(let i=0;i<2;i++)assert.equal((await (await env.ask(m.token)).json()).active,true,'the integration keeps its full window');
 assert.equal((await env.ask(m.token)).status,429,'the authenticated window still binds the integration itself');
});
