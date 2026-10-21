// IA-4's sole IA-3 hook: local prepareOnly PKCE/state, with the existing completion and cancellation operations.
import test from 'node:test';import assert from 'node:assert/strict';
import {BindleClient} from '../../packages/sdk/src/identity.mjs';import {createMockProvider,memoryStorage} from '../../packages/sdk/src/testing.mjs';
import {createIncrementalEngine,BeginIncrementalAuthorization,CompleteIncrementalAuthorization,CancelIncrementalAuthorization} from '../../packages/sdk/src/incremental.mjs';
import {performRequest} from '../../packages/sdk/src/elements/request-engine.mjs';import {validatePrepareRequest} from '../../packages/sdk/src/elements/request-protocol.mjs';
const issuer='https://provider.example',origin='https://app.example',redirectUri=origin+'/callback',fragment='https://tasks.example/preferences/v1';
async function harness(t,{enabled=true,dpop=false}={}){
 const calls=[],provider=createMockProvider({issuer,supportedIntents:['login','grant-more','configure'],dpop}),client=new BindleClient({clientId:origin+'/client',redirectUri,storage:memoryStorage(),history:{replaceState(){}},defaultHost:'provider.example',fetcher:async(input,init)=>{const req=new Request(input,init);calls.push(req.url);if(new URL(req.url).pathname==='/oauth/token'&&new URLSearchParams(await req.clone().text()).get('code')==='incremental-code')return new Response(JSON.stringify({fragment_outcomes:[{fragment,outcome:'declined'}]}),{headers:{'Content-Type':'application/json'}});return provider.fetch(req);}});
 await client.discoverHost('provider.example');const begun=await client.beginAuthorization({intent:'login',dpop:false});await client.completeLogin(provider.authorize(begun.authorizationUrl));calls.length=0;
 const engine=createIncrementalEngine({client,enabled});t.after(()=>engine.dispose());return {engine,client,calls,dispatch:a=>performRequest(engine,a)};
}
test('grant-more prepares only public inputs, no entry/network/session and exchanges its bound code once',async t=>{
 const h=await harness(t),original=h.client.session,request={requests:[{fragment,fields:['day']}],reason:'Set a day.'},result=await h.dispatch(new BeginIncrementalAuthorization({intent:'grant-more',presentation:'popup',prepareOnly:true,request}));
 assert.equal(result.authorizationUrl,undefined);assert.ok(validatePrepareRequest(result.prepare,{kind:'grant-more',origins:[origin]}));assert.equal(result.prepare.verifier,undefined);assert.equal(result.prepare.subjectConstraint,undefined);assert.equal(result.prepare.clientId,undefined);assert.deepEqual(h.calls,[]);assert.equal(h.client.session,original);
 const callback=new URL(redirectUri);for(const [k,v]of Object.entries({state:result.state,iss:issuer,code:'incremental-code'}))callback.searchParams.set(k,v);
 assert.equal((await h.dispatch(new CompleteIncrementalAuthorization({url:callback.href}))).fragments[0].outcome,'declined');assert.equal(h.client.session,original);await assert.rejects(h.dispatch(new CompleteIncrementalAuthorization({url:callback.href})),{code:'invalid-callback'});
});
test('configure preparation carries no challenge/key and completion always rereads preferences',async t=>{
 const h=await harness(t);let reads=0;h.client.readPreferences=async value=>{reads++;assert.equal(value,fragment);return {revision:2,values:{day:'tuesday'}};};
 const result=await h.dispatch(new BeginIncrementalAuthorization({intent:'configure',presentation:'popup',prepareOnly:true,request:{target:{fragment,fields:['day']},suggestion:{values:{day:'monday'}}}}));assert.ok(validatePrepareRequest(result.prepare,{kind:'configure',origins:[origin]}));assert.equal(result.prepare.challenge,undefined);assert.equal(result.prepare.dpopJkt,undefined);assert.deepEqual(h.calls,[]);
 const callback=new URL(redirectUri);for(const [k,v]of Object.entries({state:result.state,iss:issuer,result:'unchanged'}))callback.searchParams.set(k,v);
 const done=await h.dispatch(new CompleteIncrementalAuthorization({url:callback.href}));assert.equal(reads,1);assert.equal(done.preferences.revision,2);assert.deepEqual(h.calls,[]);
});
test('prepare hook is default off, popup-only, and canceled state cannot complete',async t=>{
 const off=await harness(t,{enabled:false}),input={intent:'grant-more',presentation:'popup',prepareOnly:true,request:{requests:[{fragment}]}};await assert.rejects(off.dispatch(new BeginIncrementalAuthorization(input)),{code:'incremental-disabled'});assert.deepEqual(off.calls,[]);
 const h=await harness(t);await assert.rejects(h.dispatch(new BeginIncrementalAuthorization({...input,presentation:'redirect'})),{code:'invalid_request'});const result=await h.dispatch(new BeginIncrementalAuthorization(input));await h.dispatch(new CancelIncrementalAuthorization({state:result.state}));const callback=new URL(redirectUri);for(const [k,v]of Object.entries({state:result.state,iss:issuer,code:'incremental-code'}))callback.searchParams.set(k,v);await assert.rejects(h.dispatch(new CompleteIncrementalAuthorization({url:callback.href})),{code:'invalid-callback'});assert.deepEqual(h.calls,[]);
});
test('DPoP preparation keeps the app key private and cancellation removes it without contacting the provider',async t=>{
 const h=await harness(t,{dpop:true}),result=await h.dispatch(new BeginIncrementalAuthorization({intent:'grant-more',presentation:'popup',prepareOnly:true,request:{requests:[{fragment}]}}));
 assert.match(result.prepare.dpopJkt,/^[A-Za-z0-9_-]{43}$/);assert.equal(h.client.dpopKeys.has(result.prepare.dpopJkt),true);assert.equal(JSON.stringify(result.prepare).includes('privateKey'),false);assert.deepEqual(h.calls,[]);await h.dispatch(new CancelIncrementalAuthorization({state:result.state}));assert.equal(h.client.dpopKeys.has(result.prepare.dpopJkt),false);
});
