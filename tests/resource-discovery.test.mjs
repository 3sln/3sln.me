// EXT-X7 discovery client (packages/federation/resource-discovery.mjs): query normalization, hostile discovery
// responses, SSRF-safe egress, oversized bodies, budgets, caching and the signed `discover` token.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto as crypto} from 'node:crypto';
import {DiscoveryClient,DiscoveryBudget,discoveryQuery,discoveryResult,integrationEndpoint,resourceId,createIntegrationEgress,createDohResolver,DISCOVERY_LIMITS} from '../packages/federation/resource-discovery.mjs';
import {brokeringKeys,mintAccessToken,verifyAccessToken} from '../packages/federation/signing.mjs';
import {fakeClock} from './helpers/chaos.mjs';

const ISSUER='https://3sln.example',SUBJECT=ISSUER+'/entities/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',HOST='https://models.example';
const MODEL='https://spec.bindle.example/contracts/decision-model/v1',CHAT='https://spec.bindle.example/contracts/chat-model/v1',OTHER='https://spec.bindle.example/contracts/other/v1';
const MANIFEST={v:1,resources:{rpc_endpoint:HOST+'/bindle/rpc',discovery_endpoint:HOST+'/bindle/resources',contracts:[MODEL,CHAT],dpop:'none'}};
const CONNECTION={id:'11111111-1111-4111-8111-111111111111',generation:3,state:'active',manifest:MANIFEST};
const code=c=>e=>{assert.equal(e.code,c,`expected ${c}, got ${e.code}: ${e.message}`);return true;};
const enc=v=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v));
const item=(n,extra={})=>({id:`${HOST}/r/${n}`,label:`Model ${n}`,contracts:[MODEL],container:false,facets_applied:[],...extra});
function memory(){const map=new Map();let tail=Promise.resolve();return {transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},list:async()=>[]}));tail=run.catch(()=>{});return run;}};}

/** A scripted integration behind real egress policy: `answer(request, body)` -> Response. */
function harness({answer=()=>Response.json({v:1,items:[item(1)],cursor:null}),addresses=['93.184.216.34'],clock=fakeClock(Date.UTC(2026,9,20,12)),budgets,egressOptions={}}={}){
 const keys=brokeringKeys({issuer:ISSUER,secret:Buffer.alloc(32,4).toString('base64'),metadata:memory(),clock:clock.now}),seen=[];
 const fetcher=async(url,init)=>{const request=new Request(url,init);seen.push({url,init,token:request.headers.get('authorization')?.slice(7),body:init.body?JSON.parse(init.body):null});return answer(request,init.body?JSON.parse(init.body):null,seen.length);};
 const egress=createIntegrationEgress({fetcher,resolve:async()=>addresses,publicRouting:true,...egressOptions});
 const budget=new DiscoveryBudget({clock:clock.now,...budgets?{budgets}:{}});
 const client=new DiscoveryClient({issuer:ISSUER,mint:claims=>mintAccessToken(keys,claims,{clock:clock.now}),egress,clock:clock.now,budget});
 return {client,keys,seen,clock,discover:(query={contracts:[MODEL]},extra={})=>client.discover({subject:SUBJECT,connection:CONNECTION,query,...extra})};
}

test('queries are normalized against the pinned manifest and refuse anything outside it',()=>{
 assert.deepEqual(discoveryQuery({contracts:[MODEL],text:' work '},{manifest:MANIFEST}),{v:1,contracts:[MODEL],text:'work',facets:{},parent:null,ids:null,cursor:null,limit:50});
 assert.throws(()=>discoveryQuery({contracts:[OTHER]},{manifest:MANIFEST}),code('unsupported_contract'));
 assert.throws(()=>discoveryQuery({contracts:[]},{manifest:MANIFEST}),code('invalid_request'));
 assert.throws(()=>discoveryQuery({contracts:[MODEL],text:'x'.repeat(201)},{manifest:MANIFEST}),code('invalid_request'));
 assert.throws(()=>discoveryQuery({contracts:[MODEL],text:'a‮b'},{manifest:MANIFEST}),code('invalid_request'),'bidi controls never reach the integration');
 assert.throws(()=>discoveryQuery({contracts:[MODEL],facets:{[CHAT]:{}}},{manifest:MANIFEST}),code('invalid_request'),'facets only for requested contracts');
 assert.throws(()=>discoveryQuery({contracts:[MODEL],facets:{[MODEL]:{x:'y'.repeat(5000)}}},{manifest:MANIFEST}),code('invalid_request'));
 assert.throws(()=>discoveryQuery({contracts:[MODEL],ids:[HOST+'/r/1'],text:'x'},{manifest:MANIFEST}),code('invalid_request'),'ids exclude text');
 assert.throws(()=>discoveryQuery({contracts:[MODEL],ids:['https://evil.example/r/1']},{manifest:MANIFEST}),code('invalid_request'));
 assert.throws(()=>discoveryQuery({contracts:[MODEL],limit:101},{manifest:MANIFEST}),code('invalid_request'));
 assert.throws(()=>discoveryQuery({contracts:[MODEL],cursor:'x'.repeat(1025)},{manifest:MANIFEST}),code('invalid_request'));
 assert.throws(()=>discoveryQuery({contracts:[MODEL],extra:1},{manifest:MANIFEST}),code('invalid_request'));
 assert.throws(()=>discoveryQuery({contracts:[MODEL]},{manifest:{v:1}}),code('discovery_unavailable'));
 assert.equal(discoveryQuery({contracts:[MODEL],ids:[HOST+'/r/1',HOST+'/r/2']},{manifest:MANIFEST}).limit,2);
});

test('malicious discovery responses: invalid items are dropped and broken envelopes fail as a whole',()=>{
 const q=discoveryQuery({contracts:[MODEL],facets:{[MODEL]:{size:'s'}}},{manifest:MANIFEST}),result=v=>discoveryResult(enc(v),{query:q,manifest:MANIFEST});
 const ok=item(1,{facets_applied:[MODEL]});
 const out=result({v:1,cursor:'next-1',items:[ok,
  {...ok,id:'https://evil.example/r/x'},// foreign origin
  {...ok,id:HOST+'/r/2',contracts:[MODEL,OTHER]},// contract outside the manifest
  {...ok,id:HOST+'/r/3',contracts:[CHAT]},// missing the requested contract
  {...ok,id:HOST+'/r/4',facets_applied:[]},// silently ignored facet
  ok,// duplicate
  {...ok,id:HOST+'/r/5',label:'Official ‮3sln.me'},// bidi spoof
  {...ok,id:HOST+'/r/6',label:'x'.repeat(101)},
  {...ok,id:HOST+'/r/7',description:'y'.repeat(501)},
  {...ok,id:HOST+'/r/8',container:'yes'},
  {...ok,id:HOST+'/r/9',contracts:[MODEL,MODEL]},
  {...ok,id:'http://models.example/r/10'},
  {...ok,id:HOST+'/r/11#frag'},
  JSON.parse('{"__proto__":{"admin":true},"id":"https://models.example/r/12","label":"P","contracts":["'+MODEL+'"],"facets_applied":["'+MODEL+'"],"token":"leak","rpc":"https://evil.example"}'),
  {id:HOST+'/r/13',label:'Folder',contracts:[],container:true,facets_applied:[MODEL]},
 ]});
 assert.deepEqual(out.items.map(i=>i.id),[HOST+'/r/1',HOST+'/r/12',HOST+'/r/13']);
 assert.equal(out.dropped,12);assert.equal(out.cursor,'next-1');
 assert.deepEqual(Object.keys(out.items[1]).sort(),['assignable','container','contracts','id','label','unverified'],'only known members are copied');
 assert.equal(({}).admin,undefined);assert.equal(out.items[2].assignable,false,'containers are browsable but not assignable');assert.ok(out.items.every(i=>i.unverified===true));
 for(const bad of ['nope',{v:2,items:[]},{v:1},{v:1,items:Array.from({length:101},(_,n)=>item(n))},{v:1,items:[],cursor:'\u0000'},{v:1,items:[],cursor:{}},[1]])assert.throws(()=>result(bad),code('discovery_failed'));
 assert.throws(()=>discoveryResult(new Uint8Array([0xff,0xfe]),{query:q,manifest:MANIFEST}),code('discovery_failed'));
 assert.throws(()=>discoveryResult(new Uint8Array(DISCOVERY_LIMITS.responseBytes+1),{query:q,manifest:MANIFEST}),code('discovery_failed'));
 const probe=discoveryQuery({contracts:[MODEL],limit:0},{manifest:MANIFEST});
 assert.deepEqual(discoveryResult(enc({v:1,items:[],exists:true}),{query:probe,manifest:MANIFEST}),{items:[],exists:true,cursor:null,dropped:0});
 assert.throws(()=>discoveryResult(enc({v:1,items:[item(1)],exists:true}),{query:probe,manifest:MANIFEST}),code('discovery_failed'),'a probe answers no items');
 const ids=discoveryQuery({contracts:[MODEL],ids:[HOST+'/r/1']},{manifest:MANIFEST});
 assert.deepEqual(discoveryResult(enc({v:1,items:[item(1),item(2)],cursor:'c'}),{query:ids,manifest:MANIFEST}).items.map(i=>i.id),[HOST+'/r/1'],'an exact lookup never adopts extra IDs');
 const small=discoveryQuery({contracts:[MODEL],limit:1},{manifest:MANIFEST});assert.equal(discoveryResult(enc({v:1,items:[item(1),item(2)]}),{query:small,manifest:MANIFEST}).items.length,1);
});

test('endpoint and resource ID policy: public HTTPS names only, never the issuer, IP literals or local names',()=>{
 assert.ok(integrationEndpoint(HOST+'/bindle/resources',{issuer:ISSUER}));
 for(const bad of ['http://models.example/r','https://127.0.0.1/r','https://[::1]/r','https://10.0.0.8/r','https://localhost/r','https://box.local/r','https://svc.internal/r','https://models.example:8443/r','https://u:p@models.example/r','https://models.example/r?x=1','https://3sln.example/r','https://api.3sln.example/r','https://0x7f000001/r','https://2130706433/r'])assert.equal(integrationEndpoint(bad,{issuer:ISSUER}),null,bad);
 assert.equal(integrationEndpoint('https://embed.example/r',{issuer:ISSUER,reserved:['embed.example']}),null);
 assert.equal(resourceId(HOST+'/r/1',MANIFEST.resources.rpc_endpoint),HOST+'/r/1');assert.equal(resourceId('https://models.example.evil.example/r',MANIFEST.resources.rpc_endpoint),undefined);
});

test('SSRF-safe egress: private resolutions, redirects, encodings and oversized bodies are refused',async()=>{
 assert.throws(()=>createIntegrationEgress({fetcher:fetch,resolve:async()=>[]}),TypeError,'strictly public routing is mandatory');
 const call=async(options)=>{const h=harness(options);return {h,result:await h.discover().then(v=>({value:v}),error=>({error}))};};
 for(const addresses of [['10.0.0.5'],['93.184.216.34','192.168.1.1'],['::1'],['169.254.169.254'],[]]){const {h,result}=await call({addresses});assert.equal(result.error?.code,'egress_refused',String(addresses));assert.equal(h.seen.length,0,'nothing is sent to a private address');}
 let r=await call({answer:()=>new Response(null,{status:302,headers:{Location:'http://169.254.169.254/latest'}})});assert.equal(r.result.error.code,'discovery_failed','redirects are never followed');assert.equal(r.h.seen[0].init.redirect,'manual');
 r=await call({answer:()=>new Response(JSON.stringify({v:1,items:[]}),{headers:{'Content-Type':'application/json','Content-Encoding':'gzip'}})});assert.equal(r.result.error.code,'discovery_failed');
 r=await call({answer:()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(70000)}})});assert.equal(r.result.error.code,'discovery_failed');
 const huge=new ReadableStream({pull(c){c.enqueue(new Uint8Array(16384));}});// endless body without Content-Length
 r=await call({answer:()=>new Response(huge,{headers:{'Content-Type':'application/json'}})});assert.equal(r.result.error.code,'egress_refused','the body bound holds while streaming');
 r=await call({answer:()=>new Response(JSON.stringify({v:1,items:[]}),{headers:{'Content-Type':'text/html'}})});assert.equal(r.result.error.code,'discovery_failed');
 r=await call({answer:()=>new Promise(()=>{}),egressOptions:{timeoutMs:50}});assert.equal(r.result.error.code,'egress_refused','the deadline holds against a stalled integration');
 const doh=createDohResolver({fetcher:async url=>{const type=Number(new URL(url).searchParams.get('type'));return Response.json({Status:0,Question:[{name:'models.example.',type}],Answer:type===1?[{type:1,data:'10.1.2.3'}]:[]},{headers:{'Content-Type':'application/dns-json'}});}});
 assert.deepEqual(await doh('models.example'),['10.1.2.3']);r=await call({addresses:await doh('models.example')});assert.equal(r.result.error.code,'egress_refused');
});

test('error answers map to provider faults without echoing integration text',async()=>{
 const answer=status=>()=>Response.json({error:'unsupported_facet',message:'<script>steal()</script>'},{status});
 let h=harness({answer:answer(400)});await assert.rejects(h.discover(),e=>e.code==='unsupported_facet'&&!e.message.includes('script'));
 h=harness({answer:answer(401)});await assert.rejects(h.discover(),code('discovery_rejected'));
 h=harness({answer:answer(429)});await assert.rejects(h.discover(),code('discovery_rate_limited'));
 h=harness({answer:answer(500)});await assert.rejects(h.discover(),code('discovery_failed'));
 h=harness();await assert.rejects(h.client.discover({subject:SUBJECT,connection:{...CONNECTION,state:'suspended'},query:{contracts:[MODEL]}}),code('discovery_unavailable'));
 await assert.rejects(h.client.discover({subject:SUBJECT,connection:{...CONNECTION,manifest:{v:1,resources:{...MANIFEST.resources,discovery_endpoint:'https://10.0.0.1/r'}}},query:{contracts:[MODEL]}}),code('discovery_unavailable'));
 assert.equal(h.seen.length,0);
});

test('every call carries a fresh 60 s discover token for the pinned discovery endpoint',async()=>{
 const h=harness();await h.discover({contracts:[MODEL],text:'fast'});
 const {token,body,url}=h.seen[0];assert.equal(url,MANIFEST.resources.discovery_endpoint);assert.equal(body.text,'fast');
 const {claims}=await verifyAccessToken(token,{keys:await h.keys.jwks(),issuer:ISSUER,audience:MANIFEST.resources.discovery_endpoint,purposes:['discover'],now:h.clock.now()});
 assert.equal(claims.client_id,ISSUER);assert.equal(claims.sub,SUBJECT);assert.equal(claims.exp-claims.iat,60);assert.deepEqual([claims.bindle.connection,claims.bindle.generation,claims.bindle.resource],[CONNECTION.id,3,undefined]);
 await assert.rejects(verifyAccessToken(token,{keys:await h.keys.jwks(),issuer:ISSUER,audience:MANIFEST.resources.rpc_endpoint,purposes:['invoke'],now:h.clock.now()}),code('invalid_token'),'a discover token is useless at the RPC endpoint');
});

test('caching: owner searches are served for at most 5 minutes per generation; exact lookups always go out',async()=>{
 const h=harness();await h.discover();await h.discover();assert.equal(h.seen.length,1);
 await h.client.discover({subject:SUBJECT,connection:{...CONNECTION,generation:4},query:{contracts:[MODEL]}});assert.equal(h.seen.length,2,'a new generation misses');
 await h.discover({contracts:[MODEL]},{fresh:true});assert.equal(h.seen.length,3);
 await h.discover({contracts:[MODEL],ids:[HOST+'/r/1']});await h.discover({contracts:[MODEL],ids:[HOST+'/r/1']});assert.equal(h.seen.length,5);
 h.clock.advance(300001);await h.discover();assert.equal(h.seen.length,6);
 h.client.forget(CONNECTION.id);await h.discover();assert.equal(h.seen.length,7);
 const bad=harness({answer:()=>new Response('x',{headers:{'Content-Type':'application/json'}})});await assert.rejects(bad.discover());await assert.rejects(bad.discover());assert.equal(bad.seen.length,2,'failures are never cached');
});

test('budgets: per connection, per integration, concurrency and a cool-down after repeated failures',async()=>{
 let h=harness({budgets:{connectionPerMinute:3}});
 for(let i=0;i<3;i++)await h.discover({contracts:[MODEL],text:'q'+i});
 await assert.rejects(h.discover({contracts:[MODEL],text:'q9'}),e=>e.code==='discovery_rate_limited'&&e.retryAfter===60);
 h.clock.advance(60001);await h.discover({contracts:[MODEL],text:'later'});
 h=harness({budgets:{integrationPerMinute:2}});const other={...CONNECTION,id:'22222222-2222-4222-8222-222222222222'};
 await h.discover();await h.client.discover({subject:SUBJECT,connection:other,query:{contracts:[MODEL]}});
 await assert.rejects(h.client.discover({subject:SUBJECT,connection:{...other,id:'33333333-3333-4333-8333-333333333333'},query:{contracts:[MODEL]}}),code('discovery_rate_limited'),'one integration is protected across connections');
 let release;const gate=new Promise(r=>{release=r;});
 h=harness({budgets:{integrationConcurrency:1},answer:async()=>{await gate;return Response.json({v:1,items:[]});}});
 const first=h.discover();await new Promise(r=>setTimeout(r,10));await assert.rejects(h.discover({contracts:[MODEL],text:'b'}),code('discovery_rate_limited'));release();await first;
 h=harness({budgets:{failureThreshold:2,cooldownMs:30000},answer:()=>new Response('{}',{status:500})});
 await assert.rejects(h.discover({contracts:[MODEL],text:'1'}),code('discovery_failed'));await assert.rejects(h.discover({contracts:[MODEL],text:'2'}),code('discovery_failed'));
 await assert.rejects(h.discover({contracts:[MODEL],text:'3'}),e=>e.code==='discovery_rate_limited'&&e.retryAfter===30);assert.equal(h.seen.length,2,'the cool-down sends nothing');
 h.clock.advance(30001);await assert.rejects(h.discover({contracts:[MODEL],text:'4'}),code('discovery_failed'));
 const durable={calls:0,consume:async()=>{durable.calls++;return false;}};h=harness();h.client.budget=new DiscoveryBudget({durable});await assert.rejects(h.discover(),code('discovery_rate_limited'));assert.equal(durable.calls,1);assert.equal(h.seen.length,0);
});

test('review regressions: one tenant cannot cool an integration down for others; only unavailability counts (X7-R1, R7)',async()=>{
 const clock=fakeClock(Date.UTC(2026,9,20,12)),budget=new DiscoveryBudget({clock:clock.now,budgets:{failureThreshold:2,cooldownMs:30000}}),origin=HOST;
 const fail=async c=>(await budget.admit(c,origin))('fail');
 await fail('tenant-1');await fail('tenant-1');await assert.rejects(budget.admit('tenant-1',origin),code('discovery_rate_limited'));
 (await budget.admit('tenant-2',origin))('ok');
 await fail('tenant-2');await fail('tenant-2');await fail('tenant-3');await fail('tenant-3');
 await assert.rejects(budget.admit('tenant-4',origin),code('discovery_rate_limited'),'three distinct failing connections cool the origin down');
 clock.advance(30001);(await budget.admit('tenant-4',origin))('ok');
 for(let i=0;i<5;i++)(await budget.admit('tenant-5',origin))('neutral');(await budget.admit('tenant-5',origin))('ok');
 const h=harness({budgets:{failureThreshold:1},answer:()=>Response.json({error:'invalid_token'},{status:401})});
 await assert.rejects(h.discover({contracts:[MODEL],text:'a'}),code('discovery_rejected'));await assert.rejects(h.discover({contracts:[MODEL],text:'b'}),code('discovery_rejected'),'a 401 is about this connection, never a cool-down');
 let release;const gate=new Promise(r=>{release=r;});const busy=harness({budgets:{failureThreshold:1,integrationConcurrency:8},egressOptions:{maxConcurrent:1},answer:async()=>{await gate;return Response.json({v:1,items:[]});}});
 const first=busy.discover();await new Promise(r=>setTimeout(r,10));await assert.rejects(busy.discover({contracts:[MODEL],text:'x'}),code('egress_busy'));release();await first;
 await busy.discover({contracts:[MODEL],text:'y'});// local pressure was neutral: no cool-down
 const lru=new DiscoveryBudget({clock:clock.now,maxKeys:24,budgets:{integrationPerMinute:2}});(await lru.admit('c0',origin))('ok');
 for(let i=1;i<20;i++){(await lru.admit('c'+i,'https://o'+i+'.example'))('ok');if(i%3===0)await lru.admit('cx'+i,origin).then(r=>r('ok'),()=>{});}
 await assert.rejects(lru.admit('late',origin),code('discovery_rate_limited'),'a hot per-integration window survives a burst of new keys');
 const shared=new DiscoveryBudget({clock:clock.now,budgets:{accountPerMinute:3}});for(let i=0;i<3;i++)(await shared.admit('k'+i,'https://own'+i+'.example','owner','subject-1'))('ok');
 await assert.rejects(shared.admit('k9','https://own9.example','owner','subject-1'),code('discovery_rate_limited'),'one account cannot drain the process window through many connections');
 (await shared.admit('k9','https://own9.example','owner','subject-2'))('ok');
});
