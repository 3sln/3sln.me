// Island worker (apps/embed/src/{keys,restore}.mjs, worker/*): the non-extractable frame key and its proofs, the
// embed API contracts against the real federation stack (claim/session/state/forget, `ath` required), leader-only
// padded restore, leader election with failover and a frozen leader, and the raster pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {openStore,frameKey,thumbprint,saveCredential,listCredentials,readGeneration,deleteCredentials} from '../apps/embed/src/keys.mjs';
import {embedAPI,createEntry,createRequestEntry,restoreAll,normalizeView} from '../apps/embed/src/restore.mjs';
import {createElection} from '../apps/embed/src/worker/leader.mjs';
import {validateBus} from '../apps/embed/src/worker/bus.mjs';
import {monogramPNG,transparentPNG,rasterKind,reencodeAvatar} from '../apps/embed/src/worker/avatar.mjs';
import {createIslandWorker} from '../apps/embed/src/worker/index.mjs';
import {verifyProof,EMBED_PROOF_TYP} from '../packages/federation/dpop.mjs';
import {provider,post,providerPage,pageHeaders,exchange,embedHeaders,issuer,embedOrigin,appOrigin,clientId,redirectUri,pkce,b64} from './authorization-entry-helpers.mjs';

const tick=(ms=5)=>new Promise(resolve=>setTimeout(resolve,ms));
// Same-origin browser metadata for the worker's embed API calls, cross-origin metadata for entry creation.
const browserFetch=(p,log=[])=>async(url,init={})=>{const target=new URL(url),headers={...init.headers};
  if(target.origin===embedOrigin)Object.assign(headers,embedHeaders(),init.headers);else headers.Origin=embedOrigin;
  log.push({url:String(url),method:init.method??'GET',headers});return p.fetch(String(url),{...init,headers});};

test('the frame key is non-extractable, converges across islands and signs proofs the provider verifies',async()=>{
  const store=await openStore({indexedDB:undefined});assert.equal(store.persistent,false,'memory fallback without IndexedDB');
  const [a,b]=await Promise.all([frameKey(store,{issuer,clientId,crypto:webcrypto}),frameKey(store,{issuer,clientId,crypto:webcrypto})]);
  assert.equal(a.jkt,b.jkt);assert.equal(a.jkt,await thumbprint(a.jwk,webcrypto));assert.deepEqual(Object.keys(a.jwk).sort(),['crv','kty','x','y']);
  const record=await store.get('keys',`${issuer}\0${clientId}`);assert.equal(record.privateKey.extractable,false);
  await assert.rejects(webcrypto.subtle.exportKey('jwk',record.privateKey));
  const other=await frameKey(store,{issuer,clientId:'https://other.example/client',crypto:webcrypto});assert.notEqual(other.jkt,a.jkt,'one key per (issuer, client_id)');
  const proof=await a.embedProof({issuer,entry:'e'.repeat(43),challenge:'c'.repeat(22)});
  const verified=await verifyProof(webcrypto,proof,{typ:EMBED_PROOF_TYP,htm:'POST',htu:`${issuer}/oauth/entries/${'e'.repeat(43)}/embed-verify`,now:Date.now(),claims:{entry:'e'.repeat(43)},nonce:async v=>{assert.equal(v,'c'.repeat(22));return {hash:'h',expiresAt:Date.now()+1000};}});
  assert.equal(verified.jkt,a.jkt);
  const dpop=await a.dpop({htu:`${embedOrigin}/embed/api/session`,nonce:'n',ath:'credential'});
  await verifyProof(webcrypto,dpop,{htm:'POST',htu:`${embedOrigin}/embed/api/session`,now:Date.now(),ath:'credential',nonce:async()=>({hash:'h',expiresAt:0})});
  await assert.rejects(verifyProof(webcrypto,dpop,{htm:'POST',htu:`${embedOrigin}/embed/api/session`,now:Date.now(),ath:'another',nonce:async()=>({hash:'h',expiresAt:0})}),'ath binds the credential');
});

test('credentials and the generation counter change together; forget can target one subject',async()=>{
  const store=await openStore({indexedDB:undefined}),scope={issuer,clientId};
  assert.equal(await readGeneration(store,clientId),0);
  await saveCredential(store,scope,{id:'a'.repeat(24),credential:'x',subject:`${issuer}/entities/1`});await saveCredential(store,scope,{id:'b'.repeat(24),credential:'y',subject:`${issuer}/entities/2`});
  assert.equal(await readGeneration(store,clientId),2);
  await deleteCredentials(store,scope,r=>r.subject===`${issuer}/entities/1`);
  assert.deepEqual((await listCredentials(store,scope)).map(r=>r.id),['b'.repeat(24)]);assert.equal(await readGeneration(store,clientId),3);
});

/** Runs a full island flow against the real provider stack and returns what the app and the island hold. */
async function islandFlow(p,key,log){
  const fetch=browserFetch(p,log),verifier=b64(48),prepare={redirectUri,challenge:pkce(verifier),state:b64(32),requests:[]};
  const entryId=await createEntry({issuer,clientId,key,prepare,fetch});
  const page=pageHeaders(await p.entries.view(entryId)),challenge=(await(await post(p,`${issuer}/oauth/entries/${entryId}/embed-challenge`,{},page)).json()).challenge;
  const verified=await(await post(p,`${issuer}/oauth/entries/${entryId}/embed-verify`,{proof:await key.embedProof({issuer,entry:entryId,challenge})},page)).json();
  const {result}=await providerPage(p,entryId,p.signIn(),{pageSecret:verified.pageSecret});return {result,verifier,prepare,fetch};
}

test('embed API contracts: the island creates its own entry, redeems the claim with a key proof and restores with ath',async()=>{
  const p=await provider(),store=await openStore({indexedDB:undefined}),key=await frameKey(store,{issuer,clientId,crypto:webcrypto}),log=[];
  const {result,verifier,fetch}=await islandFlow(p,key,log);
  assert.deepEqual(Object.keys(result).sort(),['claim','code','iss','state']);
  const entryCall=log.find(e=>e.url===`${issuer}/api/oauth/entries`);assert.equal(entryCall.headers.Origin,embedOrigin);
  const api=embedAPI({origin:embedOrigin,key,fetch}),{credential}=await api.claim(result.claim);
  assert.equal((await restoreAll(api,[{id:'c'.repeat(24),credential}],{issuer,pad:0}))[0].ok,false,'inactive until the app exchanges its code');
  assert.equal((await exchange(p,result.code,verifier)).status,200);
  const [restored]=await restoreAll(api,[{id:'c'.repeat(24),credential}],{issuer,pad:0});
  assert.equal(restored.ok,true);assert.equal(restored.view.handle,'alex');
  // The session view carries the binding's subject (closed in I4), so islands can match the app's session{subject}.
  assert.equal(restored.view.subject,p.accounts[0].subject);assert.equal(restored.view.avatar,false);
  assert.equal((await api.state(restored.session)).view.handle,'alex');
  const calls=log.filter(e=>e.url.startsWith(`${embedOrigin}/embed/api/`)&&!e.url.endsWith('/nonce'));
  assert.ok(calls.every(e=>e.method==='POST'&&e.headers['X-Bindle-Embed']==='1'&&/^ey/.test(e.headers.DPoP)));
  assert.ok(calls.filter(e=>!e.url.endsWith('/claim')).every(e=>/^BindleEmbed(Session)? /.test(e.headers.Authorization)));
  assert.ok(!log.some(e=>JSON.stringify(e).includes(credential)&&!e.url.startsWith(embedOrigin)),'the credential goes only to the embed origin');
  // A different key cannot use the credential, and nothing is revoked by trying.
  const thief=await frameKey(await openStore({indexedDB:undefined}),{issuer,clientId,crypto:webcrypto});
  await assert.rejects(embedAPI({origin:embedOrigin,key:thief,fetch}).session(credential),e=>e.status===401);
  assert.equal((await restoreAll(api,[{id:'c'.repeat(24),credential}],{issuer,pad:0}))[0].ok,true);
  await api.forget(credential);assert.equal((await restoreAll(api,[{id:'c'.repeat(24),credential}],{issuer,pad:0}))[0].ok,false);
});

test('restore is serial and padded to at least 300 ms per credential whatever the outcome',async()=>{
  let now=0;const waits=[],api={session:async c=>{now+=c==='slow'?500:10;if(c==='bad')throw Object.assign(new Error(),{status:401});return {session:'s',expires_in:600,view:{handle:'h'}};}};
  const results=await restoreAll(api,[{id:'1',credential:'fast'},{id:'2',credential:'bad'},{id:'3',credential:'slow'}],{issuer,clock:()=>now,wait:async ms=>{waits.push(ms);now+=ms;}});
  assert.deepEqual(results.map(r=>r.ok),[true,false,true]);assert.deepEqual(waits,[290,290]);
  assert.equal(normalizeView({handle:'x'.repeat(400),subject:'https://evil.example/entities/1',avatar:'u'},{issuer}).handle.length,320);
  assert.equal(normalizeView({handle:'x',subject:'https://evil.example/entities/1'},{issuer}).subject,null);
});

// ---- Leader election ----------------------------------------------------------------------------------------
function harness({locks=navigator.locks,channel=`bus-${b64(6)}`}={}){
  let now=1_000_000,term=0;const timers=new Set(),nodes=[];
  const clock=()=>now,setTimer=(fn,ms)=>{const t={fn,at:now+ms};timers.add(t);return t;},clearTimer=t=>timers.delete(t);
  /** Advances time; timers of frozen instances do not run (a frozen document runs no tasks). */
  async function advance(ms){const end=now+ms;while(true){const due=[...timers].filter(t=>t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!due)break;now=due.at;timers.delete(due);if(due.owner?.frozen){due.owner.held.push(due);continue;}due.fn();await tick(2);}now=end;await tick(5);}
  function node(id,{visible=true}={}){
    const n={id,visible,frozen:false,held:[],led:[],demoted:0,received:[]};
    n.election=createElection({name:`lock-${channel}`,instance:id.padEnd(22,'x'),locks,openBus:()=>new BroadcastChannel(channel),nextTerm:async()=>++term,
      lead:async({term:t})=>{n.led.push(t);},demote:()=>{n.demoted++;},receive:m=>n.received.push(m),isVisible:()=>n.visible,clock,
      setTimer:(fn,ms)=>{const t=setTimer(fn,ms);t.owner=n;return t;},clearTimer,heartbeatMs:15000,missedBeats:3,stealCooldownMs:60000});
    nodes.push(n);return n;
  }
  return {node,advance,clock,channel,thaw:async n=>{n.frozen=false;for(const t of n.held.splice(0)){t.fn();await tick(2);}await tick(5);},stop:()=>{for(const n of nodes)n.election.stop();}};
}

test('one leader per partition; on pagehide it resigns and the next island leads with a higher term',async()=>{
  const h=harness(),a=h.node('a'),b=h.node('b'),c=h.node('c');
  a.election.start();await tick(20);b.election.start();c.election.start();await tick(20);
  assert.deepEqual([a.election.leading,b.election.leading,c.election.leading],[true,false,false]);
  assert.ok(a.election.publish({views:[],issuedAt:1}));assert.equal(b.election.publish({views:[],issuedAt:1}),false,'followers cannot publish');
  await tick(20);assert.equal(b.received.filter(m=>m.type==='snapshot').length,1);
  a.election.stop();await tick(30);
  const leaders=[b,c].filter(n=>n.election.leading);assert.equal(leaders.length,1);assert.ok(leaders[0].election.term>1);
  h.stop();
});

test('a frozen leader is replaced by a visible follower, and its stale messages are dropped when it thaws',async()=>{
  const h=harness(),a=h.node('a'),b=h.node('b'),c=h.node('c',{visible:false});
  a.election.start();await tick(20);b.election.start();c.election.start();await tick(20);
  assert.equal(a.election.term,1);
  a.frozen=true;                       // a's document stops running tasks: no heartbeats
  await h.advance(15000*3+1);          // three missed beats: the next follower tick steals
  await h.advance(15000);
  assert.equal(b.election.leading,true,'the visible follower stole the lock');assert.equal(c.election.leading,false,'hidden followers never steal');
  assert.ok(b.election.term>1);await tick(30);
  assert.equal(a.election.leading,false,'the stolen lock demotes the old holder');assert.equal(a.demoted,1);
  const before=c.received.length;await h.thaw(a);
  const bus=new BroadcastChannel(h.channel);bus.postMessage({type:'snapshot',term:1,seq:99,views:[],issuedAt:1});bus.postMessage({type:'heartbeat',term:1,seq:100});await tick(20);
  assert.equal(c.received.length,before,'stale-term traffic from the thawed leader is dropped');
  b.election.publish({views:[],issuedAt:2});await tick(20);assert.equal(c.received.at(-1).type,'snapshot');
  // Steals are rate-limited: b leading means no further steal for 60 s even if a misses beats again.
  bus.close();h.stop();
});

test('without Web Locks every island leads alone (no SharedWorker fallback)',async t=>{
  const h=harness({locks:null}),a=h.node('a'),b=h.node('b');t.after(h.stop);a.election.start();b.election.start();await tick(20);
  assert.equal(a.election.leading&&b.election.leading,true);assert.equal(a.election.solo,true);
});

test('bus messages are schema-checked',()=>{
  assert.ok(validateBus({type:'hello',instance:'i'.repeat(22),avatarBucket:128}));
  for(const bad of [{type:'hello',instance:'i'.repeat(22),avatarBucket:100},{type:'snapshot',term:1,seq:1,views:new Array(9).fill(null),issuedAt:1},{type:'term',term:-1,instance:'i'.repeat(22)},{type:'leader',term:1},{type:'forget',instance:'i'.repeat(22),subject:''}])assert.equal(validateBus(bad),null);
});

// ---- Rasters --------------------------------------------------------------------------------------------------
test('rasters: monogram and transparent tiles are fixed-size PNGs; only PNG/WebP avatar bytes are accepted',async()=>{
  const png=await monogramPNG(`${issuer}/entities/1`,{size:128,scheme:'dark'});assert.equal(await rasterKind(png),'image/png');
  const header=new DataView(await png.slice(16,24).arrayBuffer());assert.deepEqual([header.getUint32(0),header.getUint32(4)],[128,128]);
  assert.equal(await rasterKind(await transparentPNG(512)),'image/png');
  const svg=new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],{type:'image/svg+xml'});
  assert.equal(await rasterKind(svg),null);assert.equal(await reencodeAvatar(svg,128),null);
  const webp=new Blob([new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80,0])]);assert.equal(await rasterKind(webp),'image/webp');
  assert.equal((await reencodeAvatar(png,128,{createImageBitmap:undefined})).type,'image/png','server-re-encoded raster passes through without a canvas');
  assert.equal(await reencodeAvatar(png,100),null,'only fixed buckets');
});

// ---- Worker composition -----------------------------------------------------------------------------------------
test('worker: only the leader restores, followers render the fanned-out snapshot, forget clears both',async t=>{
  const p=await provider(),events=[[],[]],log=[],fetch=browserFetch(p,log),channel=`it-${b64(6)}`;
  // Test shim emulating the requested server change: the session view names its subject (gap recorded above).
  const subject=p.accounts[0].subject,shimmed=async(url,init)=>{const response=await fetch(url,init);if(!String(url).endsWith('/embed/api/session')||!response.ok)return response;const body=await response.json();body.view.subject=subject;return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});};
  class Channel extends BroadcastChannel{constructor(){super(channel);}}
  const memory=await openStore({indexedDB:undefined}),store={...memory,persistent:true},config={issuer,clientId,origin:embedOrigin};
  // Two islands on one top-level site share one (persistent, as IndexedDB would be) partition store and bus.
  const workers=[0,1].map(i=>createIslandWorker({post:m=>events[i].push(m),storeFactory:async()=>store,crypto:webcrypto,fetch:shimmed,indexedDB:undefined,BroadcastChannel:Channel,timing:{restorePadMs:0}}));
  t.after(async()=>{for(const w of workers)await w({op:'pagehide'});});
  await workers[0]({id:1,op:'start',args:{config,instance:'A'.repeat(22),role:'member',bucket:64,scheme:'light'}});await tick(30);
  await workers[1]({id:1,op:'start',args:{config,instance:'B'.repeat(22),role:'member',bucket:64,scheme:'light'}});await tick(30);
  assert.ok(events[0].some(e=>e.event==='views'),'the leader publishes even with zero bindings');
  const key=await frameKey(store,{issuer,clientId,crypto:webcrypto}),{result,verifier}=await islandFlow(p,key,log);
  assert.equal((await exchange(p,result.code,verifier)).status,200);
  await workers[1]({id:2,op:'redeem',args:{claim:result.claim,delivered:true}});await tick(150);
  const last=list=>list.filter(e=>e.event==='views').at(-1)?.views;
  assert.deepEqual(last(events[0]),[{subject,handle:'alex',name:'Display alex',delivered:true}]);
  assert.deepEqual(last(events[1]),last(events[0]),'the follower renders the leader snapshot');
  assert.equal(log.filter(e=>e.url.endsWith('/embed/api/session')).length,1,'restore is leader-only');
  await workers[1]({id:3,op:'selectable',args:{subject}});assert.equal(events[1].find(e=>e.id===3).value,true);
  await workers[1]({id:4,op:'render',args:{subjects:[subject,null],bucket:64}});const tiles=events[1].find(e=>e.id===4).value;
  assert.equal(tiles.length,2);assert.equal(await rasterKind(tiles[0]),'image/png');assert.equal(await rasterKind(tiles[1]),'image/png');
  await workers[1]({id:5,op:'forget',args:{subject}});await tick(150);
  assert.deepEqual(last(events[0]),[]);assert.deepEqual(last(events[1]),[]);assert.deepEqual(await listCredentials(store,{issuer,clientId}),[]);
  for(const w of workers)await w({op:'pagehide'});
});

test('worker: a restore that loses the race with the app exchange retries quickly instead of waiting seconds',async t=>{
  const p=await provider(),events=[],log=[],fetch=browserFetch(p,log),channel=`it-${b64(6)}`,subject=p.accounts[0].subject;
  const shimmed=async(url,init)=>{const response=await fetch(url,init);if(!String(url).endsWith('/embed/api/session')||!response.ok)return response;const body=await response.json();body.view.subject=subject;return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});};
  class Channel extends BroadcastChannel{constructor(){super(channel);}}
  const store={...await openStore({indexedDB:undefined}),persistent:true},config={issuer,clientId,origin:embedOrigin};
  const worker=createIslandWorker({post:m=>events.push(m),storeFactory:async()=>store,crypto:webcrypto,fetch:shimmed,indexedDB:undefined,BroadcastChannel:Channel,timing:{restorePadMs:0}});t.after(()=>worker({op:'pagehide'}));
  await worker({id:1,op:'start',args:{config,instance:'D'.repeat(22),role:'member',bucket:64,scheme:'light'}});await tick(30);
  const key=await frameKey(store,{issuer,clientId,crypto:webcrypto}),{result,verifier}=await islandFlow(p,key,log);
  await worker({id:2,op:'redeem',args:{claim:result.claim,delivered:true}});await tick(100);
  assert.equal(log.filter(e=>e.url.endsWith('/embed/api/session')).length,1,'the first restore ran before the app exchanged');
  assert.equal((await exchange(p,result.code,verifier)).status,200);const started=Date.now();
  while(!events.filter(e=>e.event==='views').at(-1)?.views.length&&Date.now()-started<1500)await tick(25);
  assert.deepEqual(events.filter(e=>e.event==='views').at(-1).views.map(v=>v.subject),[subject],'restored within a short retry, not after 2 s or more');
  await worker({op:'pagehide'});
});

test('worker review fixes: forget during a bfcache resume is queued; unknown-subject records fail closed; views drop at once',async()=>{
  const store=await openStore({indexedDB:undefined}),events=[],config={issuer,clientId,origin:embedOrigin};let opened=0;
  const worker=createIslandWorker({post:m=>events.push(m),storeFactory:async()=>{opened++;return store;},crypto:webcrypto,fetch:async()=>new Response('{}',{status:401}),indexedDB:undefined,BroadcastChannel:undefined,locks:undefined,timing:{restorePadMs:0}});
  await worker({id:1,op:'start',args:{config,instance:'C'.repeat(22),role:'none',bucket:64}});
  await saveCredential(store,{issuer,clientId},{id:'u'.repeat(24),credential:'x',subject:null});
  await saveCredential(store,{issuer,clientId},{id:'k'.repeat(24),credential:'y',subject:`${issuer}/entities/other`});
  await worker({op:'pagehide'});
  const resumed=worker({op:'pageshow'}),forgotten=worker({id:2,op:'forget',args:{subject:`${issuer}/entities/1`}});await Promise.all([resumed,forgotten]);
  assert.equal(events.find(e=>e.id===2)?.ok,true,'queued until the store reopened (IMPL-1)');
  assert.deepEqual((await listCredentials(store,{issuer,clientId})).map(r=>r.id),['k'.repeat(24)],'a subject-less record matches any subject-scoped forget (IMPL-2)');
  assert.equal(opened,2);await worker({op:'pagehide'});
});


test('IA-4 worker creates subject-constrained incremental entries with its frame key and no login binding',async t=>{
 const subject=issuer+'/entities/owner',events=[],store=await openStore({indexedDB:undefined}),calls=[],fetch=async(url,init)=>{calls.push({url,...init,body:JSON.parse(init.body)});return Response.json({entryId:'e'.repeat(43)});},worker=createIslandWorker({post:m=>events.push(m),storeFactory:async()=>store,crypto:webcrypto,fetch,indexedDB:undefined,BroadcastChannel:undefined,locks:undefined});
 t.after(()=>worker({op:'pagehide'}));await worker({id:1,op:'start',args:{config:{issuer,clientId,origin:embedOrigin},instance:'R'.repeat(22),role:'none'}});
 for(const intent of ['grant-more','configure']){
  const prepare={v:1,type:'prepare-request',intent,redirectUri,state:'s'.repeat(43),...intent==='grant-more'?{challenge:'c'.repeat(43),requests:[{fragment:'https://tasks.example/settings/v1',purpose:'Settings',fields:['day']}]}:{target:{fragment:'https://tasks.example/settings/v1',fields:['day']},suggestion:{values:{day:'monday'}}}};
  await worker({id:2,op:'createRequestEntry',args:{prepare,subjectConstraint:subject}});assert.equal(events.at(-1).value,'e'.repeat(43));const call=calls.at(-1);assert.equal(call.url,issuer+'/api/oauth/entries');assert.equal(call.credentials,'omit');assert.equal(call.body.delivery,'embed-popup');assert.equal(call.body.subjectConstraint,subject);assert.equal(call.body.intent,intent);assert.equal(call.body.embedJkt,(await frameKey(store,{issuer,clientId,crypto:webcrypto})).jkt);assert.equal(call.body.v,undefined);assert.equal(call.body.type,undefined);assert.equal(call.body.challengeMethod,intent==='grant-more'?'S256':undefined);
 }
 assert.deepEqual(await listCredentials(store,{issuer,clientId}),[]);assert.equal(calls.length,2,'request worker starts no restore or election');
});
