import test from 'node:test';import assert from 'node:assert/strict';
import {createRequestEngine,performRequest,PrepareRequest,RequestFlow,ReceiveRequestCode,RedirectRequest,CancelRequest,RequestState,REQUEST_OPERATIONS} from '../../packages/sdk/src/elements/request-engine.mjs';
import {validatePrepareRequest,requestIslandSpec} from '../../packages/sdk/src/elements/request-protocol.mjs';
import {createIslandRequestEngine,ApplyIslandRequest,ActivateIslandRequest,IslandRequestState,runRequestPopup,ISLAND_REQUEST_OPERATIONS} from '../../apps/embed/src/parts/request.mjs';
import {PROFILE,validateOutbound,PARTS} from '../../packages/sdk/src/islands-protocol.mjs';
const issuer='https://provider.example',origin='https://app.example',subject=issuer+'/entities/owner',fragment='https://tasks.example/preferences/v1',state='s'.repeat(43),challenge='c'.repeat(43),code='incremental-code',prepare={v:1,type:'prepare-request',intent:'grant-more',redirectUri:origin+'/callback',state,challenge,requests:[{fragment,fields:['day']}]},configure={v:1,type:'prepare-request',intent:'configure',redirectUri:origin+'/callback',state,target:{fragment,fields:['day']},suggestion:{values:{day:'monday'}}};
const deferred=()=>Promise.withResolvers(),turn=()=>new Promise(r=>setImmediate(r));
function harness(t,{enabled=true,result={outcome:'completed',fragments:[{outcome:'declined'}]},transport={}}={}){const calls=[],io={prepare:async()=>{calls.push('prepare');return {prepare};},complete:async()=>{calls.push('complete');return result;},cancel:async state=>calls.push(['cancel',state]),redirect:async()=>{calls.push('redirect');return {outcome:'redirecting'};},...transport},engine=createRequestEngine({config:{INCREMENTAL_AUTH_ENABLED:enabled},transport:io,origin,issuer});t.after(()=>engine.dispose());return {engine,calls,dispatch:a=>performRequest(engine,a),read:()=>engine.query(new RequestState()).peek()};}
test('request protocol has a bounded enum-only registry and strips no rejected data into messages',()=>{
 assert.deepEqual(PARTS.request.props.kind,['grant-more','configure']);assert.deepEqual(PARTS.request.outbound,['ready','flow','code']);
 assert.ok(validatePrepareRequest(prepare,{kind:'grant-more',origins:[origin]}));assert.ok(validatePrepareRequest(configure,{kind:'configure',origins:[origin]}));
 for(const value of [{...prepare,intent:'configure'},{...prepare,subjectConstraint:subject},{...prepare,requests:[{fragment,required:true}]},{...prepare,redirectUri:'https://other.example/callback'},{...prepare,reason:'x'.repeat(201)},{...configure,challenge},{...configure,dpopJkt:challenge},{...configure,target:{fragment,fields:Array.from({length:9},(_,i)=>String(i))}},{...configure,suggestion:{values:{other:'value'}}},{...configure,suggestion:{values:{day:'x'.repeat(2048)}}}])assert.equal(validatePrepareRequest(value,{origins:[origin]}),null);
 const large={...prepare,reason:'🙂'.repeat(200),requests:[{fragment,fields:['day'],purpose:'x'.repeat(6000)}]};assert.ok(validatePrepareRequest(large,{origins:[origin]}));assert.equal(validatePrepareRequest({...large,requests:[{fragment,purpose:'x'.repeat(8192)}]},{origins:[origin]}),null);
 assert.equal(validateOutbound({v:1,type:'flow',phase:'ended',outcome:'completed',result:'configured'},{part:'request',version:1,issuer}),null);
});
test('all request operations run through the engine, with full result retained only in the query',async t=>{
 const h=harness(t);assert.equal(REQUEST_OPERATIONS.length,6);assert.ok(await h.dispatch(new PrepareRequest({kind:'grant-more'})));assert.deepEqual(h.calls,['prepare']);
 assert.deepEqual(await h.dispatch(new RequestFlow({phase:'started'})),{phase:'started'});assert.equal(await h.dispatch(new ReceiveRequestCode({code,state,iss:issuer})),true);
 assert.equal(await h.dispatch(new ReceiveRequestCode({code,state,iss:issuer})),false);
 assert.deepEqual(await h.dispatch(new RequestFlow({phase:'ended',outcome:'completed'})),{phase:'ended',outcome:'completed'});assert.equal((await h.read()).result.fragments[0].outcome,'declined');assert.equal((await h.read()).held,true);
 assert.equal(await h.dispatch(new PrepareRequest({kind:'grant-more'})),null);assert.equal(await h.dispatch(new RedirectRequest({kind:'grant-more',activation:true})),null);assert.equal(h.calls.filter(c=>c==='prepare').length,1);
 await h.dispatch(new CancelRequest());assert.equal((await h.read()).held,true);await h.dispatch(new CancelRequest({sessionChanged:true}));assert.equal((await h.read()).held,false);
});
test('flag off and missing activation produce no effects; redirect requires a fresh owner action',async t=>{
 const off=harness(t,{enabled:false});assert.equal(await off.dispatch(new PrepareRequest({kind:'grant-more'})),null);assert.equal(await off.dispatch(new RedirectRequest({kind:'grant-more',activation:true})),null);assert.equal(await off.dispatch(new RequestFlow({phase:'started'})),null);assert.deepEqual(off.calls,[]);
 const h=harness(t);assert.equal(await h.dispatch(new RedirectRequest({kind:'configure'})),null);assert.deepEqual(h.calls,[]);assert.deepEqual(await h.dispatch(new RedirectRequest({kind:'configure',activation:true})),{phase:'ended',outcome:'redirecting'});assert.equal(h.calls.at(-1),'redirect');
});
test('configure completion rereads through its provider and emits no settings or result hint',async t=>{
 const h=harness(t,{transport:{prepare:async()=>({prepare:configure}),complete:async()=>({outcome:'completed',preferences:{revision:2,values:{day:'tuesday'}}})}});
 await h.dispatch(new PrepareRequest({kind:'configure'}));await h.dispatch(new RequestFlow({phase:'started'}));assert.equal(await h.dispatch(new ReceiveRequestCode({code,state,iss:issuer})),false);
 assert.deepEqual(await h.dispatch(new RequestFlow({phase:'ended',outcome:'completed'})),{phase:'ended',outcome:'completed'});assert.equal((await h.read()).result.preferences.revision,2);
});
test('cancellation fences late preparation/completion and stale codes fail',async t=>{
 const held=deferred(),h=harness(t,{transport:{prepare:()=>held.promise}}),pending=h.dispatch(new PrepareRequest({kind:'grant-more'}));await turn();await h.dispatch(new CancelRequest());held.resolve({prepare});assert.equal(await pending,null);assert.equal((await h.read()).prepared,null);
 const completion=deferred(),c=harness(t,{transport:{complete:()=>completion.promise}});await c.dispatch(new PrepareRequest({kind:'grant-more'}));await c.dispatch(new RequestFlow({phase:'started'}));assert.equal(await c.dispatch(new ReceiveRequestCode({code,state:'x'.repeat(43),iss:issuer})),false);await c.dispatch(new ReceiveRequestCode({code,state,iss:issuer}));const end=c.dispatch(new RequestFlow({phase:'ended',outcome:'completed'}));await turn();await c.dispatch(new CancelRequest());completion.resolve({fragments:[{outcome:'granted'}]});assert.equal(await end,null);assert.equal((await c.read()).result,null);
});
test('rate limits hold further requests, including redirect fallback',async t=>{const h=harness(t,{transport:{redirect:async()=>{throw Object.assign(Error(),{code:'rate_limited'});}}});assert.deepEqual(await h.dispatch(new RedirectRequest({kind:'grant-more',activation:true})),{phase:'ended',outcome:'rate_limited'});assert.equal(await h.dispatch(new PrepareRequest({kind:'grant-more'})),null);});
function island(t,{enabled=true,popup=true,run=async()=>({outcome:'completed',code,state,iss:issuer})}={}){
 const messages=[],calls=[],model={props:{kind:'grant-more'},parentOrigin:origin,subject:null,requestPrepare:null,flow:null},engine=createIslandRequestEngine({model,enabled,issuer,send:m=>messages.push(m),refresh(){},open:()=>{calls.push('open');return popup?{closed:false,close(){}}:null;},worker:async()=>{calls.push('worker');return {call:async(op,args)=>{calls.push([op,args]);return 'entry'.repeat(8);}};},run:async args=>{await args.createEntry();return run(args);}});t.after(()=>engine.dispose());return {engine,model,messages,calls,dispatch:a=>performRequest(engine,a)};
}
test('island engine keeps inbound messages inert, requires a subject/activation and opens before entry creation',async t=>{
 const h=island(t);assert.equal(ISLAND_REQUEST_OPERATIONS.length,3);assert.equal(await h.dispatch(new ApplyIslandRequest(prepare)),true);assert.deepEqual(h.calls,[]);assert.equal((await h.engine.query(new IslandRequestState()).peek()).disabled,true);
 assert.equal(await h.dispatch(new ActivateIslandRequest({activation:true})),null);await h.dispatch(new ApplyIslandRequest({type:'session',subject}));await h.dispatch(new ApplyIslandRequest(prepare));assert.equal(await h.dispatch(new ActivateIslandRequest()),null);
 assert.equal(await h.dispatch(new ActivateIslandRequest({activation:true})),'completed');assert.deepEqual(h.calls.slice(0,2),['open','worker']);assert.equal(h.calls[2][0],'createRequestEntry');assert.equal(h.calls[2][1].subjectConstraint,subject);assert.equal(h.calls[2][1].prepare.subjectConstraint,undefined);assert.deepEqual(h.messages.map(m=>m.type),['flow','code','flow']);assert.deepEqual(h.messages.at(-1),{v:1,type:'flow',phase:'ended',outcome:'completed'});
});
test('popup blocking creates no entry; flag off cannot open; configure never emits code/details',async t=>{
 const blocked=island(t,{popup:false});await blocked.dispatch(new ApplyIslandRequest({type:'session',subject}));await blocked.dispatch(new ApplyIslandRequest(prepare));assert.equal(await blocked.dispatch(new ActivateIslandRequest({activation:true})),'popup-blocked');assert.deepEqual(blocked.calls,['open']);
 const off=island(t,{enabled:false});await off.dispatch(new ApplyIslandRequest({type:'session',subject}));await off.dispatch(new ApplyIslandRequest(prepare));assert.equal(await off.dispatch(new ActivateIslandRequest({activation:true})),null);assert.deepEqual(off.calls,[]);
 const h=island(t);h.model.props.kind='configure';await h.dispatch(new ApplyIslandRequest({type:'session',subject}));await h.dispatch(new ApplyIslandRequest(configure));await h.dispatch(new ActivateIslandRequest({activation:true}));assert.deepEqual(h.messages,[{v:1,type:'flow',phase:'started'},{v:1,type:'flow',phase:'ended',outcome:'completed'}]);
});
test('popup accepts only its handle, exact issuer, state and entry under the attestation exchange',async()=>{
 const win=new EventTarget(),sent=[],popup={closed:false,location:{replace:u=>sent.push(u)},postMessage:(m,o)=>sent.push([m,o]),close(){this.closed=true;}},entry='e'.repeat(43);
 const message=(data,{origin:from=issuer,source=popup}={})=>{const e=new Event('message');Object.assign(e,{data,origin:from,source});win.dispatchEvent(e);};
 const pending=runRequestPopup({win,popup,issuer,prepare:configure,createEntry:async()=>entry,prove:async()=> 'proof',timeoutMs:500,pollMs:5});await turn();
 const done={v:1,type:'bindle-embed-done',entry,result:'configured',state,iss:issuer};message(done);message({v:1,type:'bindle-embed-hello',entry,challenge:'h'.repeat(16)});await turn();
 let settled=false;pending.then(()=>settled=true);message(done,{origin:'https://evil.example'});message(done,{source:{}});message({...done,state:'x'});message({...done,suppressed:true});await turn();assert.equal(settled,false);
 message(done);assert.deepEqual(await pending,{outcome:'completed'});assert.equal(sent[1][1],issuer);assert.equal(popup.closed,true);
});
test('profile selection is fail closed for missing part, binding, intent, policy and degraded request',()=>{
 const m={features:{'authorization-entry.v1':{intents:['grant-more','configure']}}},profile={parts:{request:{version:1}},bindings:['key-binding.v1']},degraded=new Set(),client={session:{issuer},capabilitiesFor:()=>({profile:true,entry:true,embedOrigin:'https://embed.provider.example'}),capabilities:{manifest:()=>m,declaration:()=>({profiles:{[PROFILE]:profile}}),degraded:()=>degraded}};
 assert.ok(requestIslandSpec(client,'grant-more'));assert.equal(requestIslandSpec(client,'grant-more',{islands:'off'}),null);assert.equal(requestIslandSpec(client,'grant-more',{islandIssuers:[]}),null);degraded.add('part:request');assert.equal(requestIslandSpec(client,'grant-more'),null);degraded.clear();profile.bindings=[];assert.equal(requestIslandSpec(client,'grant-more'),null);
});
