// Island client pieces in apps/embed that pair with the SDK elements: the leader's `/embed/api/events` stream and
// `session/end`, and FedCM inside the island (adaptive-app-sign-in §11.3) against a test double of the browser API
// and the provider's assertion endpoint. The FedCM server endpoints do not exist yet (packages/federation), so
// nothing here is evidence of provider conformance or of Chromium behaviour. These tests live with the SDK suite
// because of write ownership; tests/islands-worker.test.mjs covers the rest of the worker against the real stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {openStore,frameKey,saveCredential} from '../../../apps/embed/src/keys.mjs';
import {embedAPI,createEntry} from '../../../apps/embed/src/restore.mjs';
import {createIslandWorker} from '../../../apps/embed/src/worker/index.mjs';
import {createFlows,readFedcmToken,fedcmUsable} from '../../../apps/embed/src/parts/flow.mjs';
import {readConfig} from '../../../apps/embed/src/boot.mjs';

const issuer='https://provider.example',embed='https://embed.provider.example',clientId='https://app.example/client',app='https://app.example';
const tick=(ms=5)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,{timeout=4000,message='condition'}={}){const end=Date.now()+timeout;while(!await predicate()){if(Date.now()>end)throw new Error(`Timed out waiting for ${message}.`);await tick();}}
const decode=jws=>JSON.parse(Buffer.from(jws.split('.')[1],'base64url').toString());
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const subject=`${issuer}/entities/1`,b43=c=>c.repeat(43);

// A fake embed API: sessions, a controllable NDJSON stream per session, session end and avatar 404s.
function embedServer(){
  const calls=[],streams=[];let sessions=0;
  const fetch=async(url,init={})=>{
    const path=new URL(url).pathname;calls.push({path,method:init.method??'GET',headers:init.headers??{},keepalive:init.keepalive===true});
    if(path==='/embed/api/nonce')return json({nonce:'n'+calls.length});
    if(path==='/embed/api/session')return json({session:`session-${++sessions}`,expires_in:600,view:{subject,handle:'alex',name:'Alex',avatar:false}});
    if(path==='/embed/api/session/end')return new Response(null,{status:204});
    if(path==='/embed/api/events'){
      let controller;const body=new ReadableStream({start(c){controller=c;},cancel(){stream.canceled=true;}});
      const stream={session:init.headers.Authorization,canceled:false,push:value=>controller.enqueue(new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)+'\n')),close:()=>controller.close()};
      streams.push(stream);init.signal?.addEventListener('abort',()=>{stream.aborted=true;});
      stream.push({type:'view',view:{subject,handle:'alex',name:'Alex',avatar:false}});
      return new Response(body,{status:200,headers:{'Content-Type':'application/x-ndjson'}});
    }
    return json({error:'not_found'},404);
  };
  return {fetch,calls,streams};
}

test('the leader streams /embed/api/events per held session, applies changed views and ends sessions on pagehide',async t=>{
  const server=embedServer(),store=await openStore({indexedDB:undefined}),events=[];
  await saveCredential(store,{issuer,clientId},{id:'c'.repeat(24),credential:'cred',subject,delivered:true,createdAt:0,pendingUntil:0});
  const worker=createIslandWorker({post:m=>events.push(m),storeFactory:async()=>store,crypto:webcrypto,fetch:server.fetch,indexedDB:undefined,BroadcastChannel:undefined,locks:undefined,timing:{restorePadMs:0}});
  t.after(()=>worker({op:'pagehide'}));
  await worker({id:1,op:'start',args:{config:{issuer,clientId,origin:embed},instance:'A'.repeat(22),role:'member',bucket:64,scheme:'light'}});
  const views=()=>events.filter(e=>e.event==='views').at(-1)?.views??[];
  await until(()=>views()[0]?.name==='Alex',{message:'restored view'});
  await until(()=>server.streams.length===1,{message:'stream'});
  const open=server.calls.find(c=>c.path==='/embed/api/events');
  assert.equal(open.method,'GET');assert.equal(open.headers.Authorization,'BindleEmbedSession session-1');assert.equal(open.headers['X-Bindle-Embed'],'1');
  assert.deepEqual({htm:decode(open.headers.DPoP).htm,htu:decode(open.headers.DPoP).htu},{htm:'GET',htu:`${embed}/embed/api/events`},'a GET key proof bound to the stream URL');
  const before=events.length;
  server.streams[0].push({type:'ping'});server.streams[0].push({type:'view',view:{subject,handle:'alex',name:'Alex',avatar:false}});await tick(30);
  assert.equal(events.length,before,'pings and unchanged views cost nothing');
  // A partial line is buffered until its newline; a changed view is fanned out at once.
  server.streams[0].push('{"type":"view","view":{"subject":"'+subject+'","handle":"alex",');server.streams[0].push('"name":"Alex Renamed","avatar":false}}\n');
  await until(()=>views()[0]?.name==='Alex Renamed',{message:'streamed view'});
  assert.deepEqual(views(),[{subject,handle:'alex',name:'Alex Renamed',delivered:true}]);
  // The document is told the held session tokens, because it ends them itself on pagehide (the worker is often
  // terminated before it reads that message); the worker then aborts the stream and ends nothing twice.
  assert.deepEqual(events.filter(e=>e.event==='sessions').at(-1),{event:'sessions',tokens:['session-1']});
  await worker({op:'pagehide'});await tick(20);
  assert.equal(server.streams[0].aborted,true);
  assert.deepEqual(events.filter(e=>e.event==='sessions').at(-1),{event:'sessions',tokens:[]});
  assert.equal(server.calls.filter(c=>c.path==='/embed/api/session/end').length,0);
});

test('a demoted leader (lock stolen) ends its own sessions with keepalive, bearer only',async t=>{
  const server=embedServer(),store=await openStore({indexedDB:undefined});
  await saveCredential(store,{issuer,clientId},{id:'e'.repeat(24),credential:'cred',subject,delivered:true,createdAt:0,pendingUntil:0});
  // A persistent store with fake Web Locks whose grant can be revoked, as a steal does.
  let reject;const locks={request:(name,options,callback)=>new Promise((ok,fail)=>{reject=fail;Promise.resolve(callback()).then(ok,fail);})};
  class Bus{postMessage(){}close(){}}
  const worker=createIslandWorker({post:()=>{},storeFactory:async()=>({...store,persistent:true}),crypto:webcrypto,fetch:server.fetch,indexedDB:undefined,BroadcastChannel:Bus,locks,timing:{restorePadMs:0}});
  t.after(()=>worker({op:'pagehide'}));
  await worker({id:1,op:'start',args:{config:{issuer,clientId,origin:embed},instance:'C'.repeat(22),role:'member',bucket:64}});
  await until(()=>server.streams.length===1,{message:'stream'});
  reject(Object.assign(new Error('stolen'),{name:'AbortError'}));await tick(20);
  const end=server.calls.filter(c=>c.path==='/embed/api/session/end');
  assert.equal(end.length,1);assert.equal(end[0].method,'POST');assert.equal(end[0].keepalive,true);
  assert.equal(end[0].headers.Authorization,'BindleEmbedSession session-1');assert.equal(end[0].headers.DPoP,undefined);
  assert.equal(server.streams[0].aborted,true);
});

test('a stream the server ends is followed by a fresh restore; renewal ends the replaced session',{timeout:20000},async t=>{
  const server=embedServer(),store=await openStore({indexedDB:undefined});
  await saveCredential(store,{issuer,clientId},{id:'d'.repeat(24),credential:'cred',subject,delivered:true,createdAt:0,pendingUntil:0});
  const worker=createIslandWorker({post:()=>{},storeFactory:async()=>store,crypto:webcrypto,fetch:server.fetch,indexedDB:undefined,BroadcastChannel:undefined,locks:undefined,timing:{restorePadMs:0}});
  t.after(()=>worker({op:'pagehide'}));
  await worker({id:1,op:'start',args:{config:{issuer,clientId,origin:embed},instance:'B'.repeat(22),role:'member',bucket:64}});
  await until(()=>server.streams.length===1,{message:'stream'});
  server.streams[0].close(); // expiry, eviction by a newer stream, or the binding stopped being live
  await until(()=>server.calls.filter(c=>c.path==='/embed/api/session').length===2,{timeout:5000,message:'restore after the stream ended'});
  await until(()=>server.streams.length===2,{message:'stream reopened'});
  assert.equal(server.streams[1].session,'BindleEmbedSession session-2');
  assert.deepEqual(server.calls.filter(c=>c.path==='/embed/api/session/end').map(c=>c.headers.Authorization),['BindleEmbedSession session-1'],'the replaced session is ended');
});

test('embed API: events reject a non-OK response; session end never throws',async()=>{
  const key=await frameKey(await openStore({indexedDB:undefined}),{issuer,clientId,crypto:webcrypto});
  const api=embedAPI({origin:embed,key,fetch:async url=>new URL(url).pathname.endsWith('/nonce')?json({nonce:'x'}):json({},401)});
  await assert.rejects(async()=>{for await(const _ of api.events('s'));},{status:401});
  assert.equal(await embedAPI({origin:embed,key,fetch:async()=>{throw new TypeError('offline');}}).end('s'),false);
});

test('FedCM entry and proof: embed-fedcm delivery, entry-bound proof over a server nonce at the assertion URL',async()=>{
  const key=await frameKey(await openStore({indexedDB:undefined}),{issuer,clientId,crypto:webcrypto});let body;
  const entry=await createEntry({issuer,clientId,key,prepare:{redirectUri:app+'/callback',challenge:b43('c'),state:b43('s'),requests:[]},delivery:'embed-fedcm',fetch:async(url,init)=>{body=JSON.parse(init.body);return json({entryId:b43('e')});}});
  assert.equal(entry,b43('e'));assert.equal(body.delivery,'embed-fedcm');assert.equal(body.presentation,'fedcm');assert.equal(body.embedJkt,key.jkt);
  const proof=await key.fedcmProof({assertUrl:`${issuer}/fedcm/api/assert`,entry,nonce:'server-nonce'}),[head]=proof.split('.');
  assert.equal(JSON.parse(Buffer.from(head,'base64url')).typ,'bindle-embed+jwt');
  const payload=decode(proof);assert.deepEqual({htm:payload.htm,htu:payload.htu,nonce:payload.nonce,entry:payload.entry},{htm:'POST',htu:`${issuer}/fedcm/api/assert`,nonce:'server-nonce',entry});
  assert.ok(payload.jti&&payload.iat);
});

test('shell config: optional FedCM endpoints must both be on the issuer origin',()=>{
  const doc=config=>({getElementById:()=>({getAttribute:()=>'application/json',textContent:JSON.stringify({v:1,issuer,clientId,origins:[app],parts:['sign-in'],worker:'/embed/assets/w.0123456789abcdef.js',...config})})});
  assert.equal(readConfig(doc({})).fedcm,null);
  assert.deepEqual(readConfig(doc({fedcm:{configUrl:`${issuer}/fedcm/config.json`,assertUrl:`${issuer}/fedcm/api/assert`}})).fedcm,{configUrl:`${issuer}/fedcm/config.json`,assertUrl:`${issuer}/fedcm/api/assert`});
  assert.equal(readConfig(doc({fedcm:{configUrl:'https://evil.example/fedcm.json',assertUrl:`${issuer}/fedcm/api/assert`}})),null);
  assert.equal(readConfig(doc({fedcm:{configUrl:`${issuer}/fedcm/config.json`}})),null);
});

// ---- FedCM inside the island, against a test double -------------------------------------------------------------
const fedcm={configUrl:`${issuer}/fedcm/config.json`,assertUrl:`${issuer}/fedcm/api/assert`};
function harness({allowed=true,identity=true,get,popup=null}={}){
  const sent=[],calls=[],opened=[];
  const win={IdentityCredential:identity?function IdentityCredential(){}:undefined,navigator:{credentials:{get:async options=>{calls.push(options);return get(options);}}},open:(...args)=>{opened.push(args);return popup;}};
  const doc={featurePolicy:{allowsFeature:name=>name==='identity-credentials-get'&&allowed}};
  const client={async call(op,args){calls.push({op,args});if(op==='createEntry')return b43('e');if(op==='fedcmProof')return 'proof.jws.sig';if(op==='redeem')return true;throw new Error(op);}};
  const model={prepare:{redirectUri:app+'/callback',challenge:b43('c'),state:b43('s'),requests:[]},parentOrigin:app,sandboxed:false,flow:null};
  const start=createFlows({model,send:message=>{sent.push(message);return true;},worker:async()=>client,issuer,clientId,fedcm,win,doc});
  return {start,sent,calls,opened,model};
}
const kinds=sent=>sent.map(m=>m.type==='flow'?`flow:${m.phase}${m.outcome?':'+m.outcome:''}`:m.type);

test('FedCM in frame: mediation required, entry + key proof params, code to the app, claim redeemed; no popup',async()=>{
  const h=harness({get:async()=>({token:JSON.stringify({v:1,code:'the-code',state:b43('s'),iss:issuer,claim:'k'.repeat(43)})})});
  h.start();await until(()=>kinds(h.sent).includes('flow:ended:completed'));
  assert.deepEqual(kinds(h.sent),['flow:started','code','flow:ended:completed']);assert.deepEqual(h.opened,[],'no popup when FedCM is used');
  const create=h.calls.find(c=>c.op==='createEntry'),proof=h.calls.find(c=>c.op==='fedcmProof'),get=h.calls.find(c=>c.identity);
  assert.equal(create.args.delivery,'embed-fedcm');assert.deepEqual(proof.args,{entry:b43('e'),assertUrl:fedcm.assertUrl});
  assert.equal(get.mediation,'required','never auto-selected (AS-R2-7)');
  assert.deepEqual(get.identity,{providers:[{configURL:fedcm.configUrl,clientId,params:{v:1,entry:b43('e'),proof:'proof.jws.sig'}}],mode:'active',context:'signin'});
  assert.deepEqual(h.sent[1],{v:1,type:'code',code:'the-code',state:b43('s'),iss:issuer});
  assert.deepEqual(h.calls.find(c=>c.op==='redeem').args,{claim:'k'.repeat(43),delivered:true});
});

test('FedCM in frame: an object token (Chrome 143+) and a claimless (auto-selected) token deliver the code without a binding',async()=>{
  const h=harness({get:async()=>({token:{v:1,code:'c2',state:b43('s'),iss:issuer}})});
  h.start();await until(()=>kinds(h.sent).includes('flow:ended:completed'));
  assert.equal(h.calls.some(c=>c.op==='redeem'),false,'C5: no component credential without a user choice');
});

test('FedCM in frame: dismissal cancels, pre-UI errors are unavailable, a forged token is refused; detection falls back to the popup',async()=>{
  for(const [error,outcome] of [[Object.assign(new Error('x'),{name:'NetworkError'}),'canceled'],[Object.assign(new Error('x'),{name:'NotAllowedError'}),'unavailable']]){
    const h=harness({get:async()=>{throw error;}});h.start();await until(()=>h.sent.length===2);
    assert.deepEqual(kinds(h.sent),['flow:started',`flow:ended:${outcome}`]);
  }
  for(const token of [JSON.stringify({v:1,code:'c',state:b43('x'),iss:issuer}),JSON.stringify({v:1,code:'c',state:b43('s'),iss:'https://evil.example'}),'not json',JSON.stringify({v:1,code:'c',state:b43('s'),iss:issuer,extra:1})]){
    const h=harness({get:async()=>({token})});h.start();await until(()=>h.sent.length===2);
    assert.deepEqual(kinds(h.sent),['flow:started','flow:ended:canceled'],token);
  }
  // Not delegated (no allow="identity-credentials-get"), or no IdentityCredential: the popup path, chosen synchronously.
  for(const options of [{allowed:false},{identity:false}]){
    const h=harness({...options,get:async()=>{throw new Error('must not be called');}});h.start();await tick(10);
    assert.equal(h.opened.length,1);assert.deepEqual(h.opened[0],['about:blank','_blank','popup']);assert.deepEqual(kinds(h.sent),['flow:started','flow:ended:unavailable'],'the null popup is unavailable');
  }
  assert.equal(fedcmUsable({fedcm:null,win:{IdentityCredential:function(){},navigator:{credentials:{get(){}}}},doc:{featurePolicy:{allowsFeature:()=>true}}}),false,'no endpoints configured');
  assert.equal(readFedcmToken('{"v":1,"code":"c","state":"s","iss":"i","claim":"short"}',{state:'s',issuer:'i'}),null);
});
