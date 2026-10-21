// IA-3 mock-first wire tests. Extend the SDK double locally: its shared login
// contract remains read-only and these draft intents are not provider conformance.
import {test as nodeTest,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
import {createMockProvider,memoryStorage} from '../src/testing.mjs';
import {BindleClient} from '../src/identity.mjs';
import {handleCallback} from '../src/callback.mjs';
import {createIncrementalClient,createIncrementalEngine,BeginIncrementalAuthorization,CompleteIncrementalAuthorization,CancelIncrementalAuthorization,IncrementalResult,INCREMENTAL_OPERATIONS} from '../src/incremental.mjs';

const test=(name,fn)=>nodeTest(name,{timeout:10000},fn),cleanups=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
const issuer='https://provider.example',clientId='https://app.example/client',redirectUri='https://app.example/callback?app=tasks',fragment='https://tasks.example/preferences/summary/v1',contract='https://contracts.example/calendar/v1';
const digest='sha256-'+ 'a'.repeat(43),request={requests:[{fragment,digest,purpose:'Add due dates.',fields:['calendar'],methods:{calendar:{[contract]:['read','create']}}}]};
const full={fields:['calendar','day'],methods:{calendar:{[contract]:['read','create','delete']}}};
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
const hash=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('base64url');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function dispatch(engine,action){const feed=engine.dispatch(action);let result;feed.addEventListener('result',event=>{result=event.detail;});await feed.next('complete');return result;}
async function harness({enabled=true,presentation='popup',blocked=false,declare=['grant-more','configure'],dpop=false,token:tokenOverride,entryResponse,tokenResponse,readPreferences,...options}={}){
 const provider=createMockProvider({issuer,clients:[{clientId,redirectUris:[redirectUri]}],supportedIntents:['login','reauthenticate',...declare],extensionKeys:['reason','target','suggestion'],dpop}),calls=[],codes=new Map(),state={token:tokenOverride,choice:'configured',preferences:{revision:2,values:{day:'monday'}}};
 const fetcher=async(input,init)=>{
  const req=input instanceof Request?input:new Request(input,init),path=new URL(req.url).pathname,body=req.method==='POST'?await req.clone().text():null;calls.push({path,body,headers:req.headers,credentials:req.credentials});
  if(path==='/api/oauth/entries'){
   const entry=JSON.parse(body);
   if(['grant-more','configure'].includes(entry.intent)){
    if(entryResponse)return entryResponse(entry);
    assert.equal(entry.subjectConstraint,provider.accounts[0].subject);assert.equal(entry.maxAge,undefined);
    if(entry.intent==='configure'){assert.equal(entry.challenge,undefined);assert.equal(entry.requests,undefined);assert.equal(entry.dpopJkt,undefined);}
    else{assert.equal(entry.target,undefined);assert.equal(entry.suggestion,undefined);assert.equal(entry.challengeMethod,'S256');assert.match(entry.challenge,/^[A-Za-z0-9_-]{43}$/);assert.ok(entry.requests.every(request=>!request.required));}
    const entryId=crypto.randomUUID().replaceAll('-','');provider.entries.set(entryId,{...entry,entryId});return json({entryId},201);
   }
  }
  if(path==='/oauth/token'){
   const form=new URLSearchParams(body),record=codes.get(form.get('code'));
   if(record){assert.equal(await hash(form.get('code_verifier')),record.challenge);assert.equal(form.get('client_id'),clientId);assert.equal(form.get('redirect_uri'),redirectUri);if(tokenResponse)return tokenResponse({req,form,record,state});codes.delete(form.get('code'));return json(state.token??{fragment_outcomes:[{fragment,outcome:'granted',granted:full}]});}
  }
  return provider.fetch(req);
 };
 const client=new BindleClient({clientId,redirectUri,defaultHost:'provider.example',fetcher,storage:memoryStorage(),history:{replaceState(){}},...options.clientOptions});
 await client.discoverHost('provider.example');const login=await client.beginAuthorization({intent:'login',dpop:false});await client.completeLogin(provider.authorize(login.authorizationUrl));
 client.session={...client.session,granted_fragments:[{grant:'old',fragment,digest,fields:['day','calendar'],methods:{calendar:{[contract]:['read']}}}]};client.sessions.set(`${issuer} ${client.session.subject}`,client.session);
 client.readPreferences=async(...args)=>readPreferences?readPreferences(...args):state.preferences;
 const assigned=[],win={navigator:{language:'en',userActivation:{isActive:true}},location:{href:'https://app.example/',assign:url=>assigned.push(url)},matchMedia:()=>({matches:false})};
 function authorize(value){
  const entry=provider.entries.get(new URL(value).searchParams.get('entry'));assert.ok(entry);assert.equal(entry.opened,undefined);entry.opened=true;
  const callback=new URL(entry.redirectUri);callback.searchParams.set('state',entry.state);callback.searchParams.set('iss',issuer);
  if(entry.intent==='configure')callback.searchParams.set('result',state.choice);else{const code=crypto.randomUUID().replaceAll('-','');codes.set(code,entry);callback.searchParams.set('code',code);}return callback.href;
 }
 provider.drivePopup=async(popup,value,{BroadcastChannel:Channel})=>{
  const callback=authorize(value);popup.callbackUrl=callback;
  popup.result=await handleCallback({location:{href:callback},history:{replaceState(){}},storage:memoryStorage(),BroadcastChannel:Channel,render:false,close:false});
 };
 const driver=provider.installPopupDriver(win,{blocked}),helper=createIncrementalClient({client,enabled,window:win,presentation,...options});
 cleanups.push(async()=>{await helper.dispose();driver.uninstall();});calls.length=0;
 const engine=createIncrementalEngine({client,enabled});cleanups.push(()=>engine.dispose());
 return {client,helper,engine,provider,calls,driver,win,assigned,state,authorize};
}

test('engine harness drives every registered operation and full grants need no delta merge',async()=>{
 const h=await harness(),original=h.client.session;
 assert.deepEqual(INCREMENTAL_OPERATIONS.map(op=>op.operation),['sdk.incremental.begin','sdk.incremental.complete','sdk.incremental.cancel','sdk.incremental.result']);
 const started=await dispatch(h.engine,new BeginIncrementalAuthorization({intent:'grant-more',request,presentation:'popup'})),result=await dispatch(h.engine,new CompleteIncrementalAuthorization({url:h.authorize(started.authorizationUrl)}));
 assert.equal(result.outcome,'completed');assert.deepEqual(result.fragments[0].granted,full);assert.deepEqual(result.fragments[0].methods.calendar[contract],{granted:['read','create'],missing:[]});assert.equal(Object.isFrozen(result.fragments[0].granted),true);assert.equal(h.client.session,original);
 assert.deepEqual(await h.engine.query(new IncrementalResult()).peek(),result);assert.equal(await dispatch(h.engine,new CancelIncrementalAuthorization()),true);assert.equal(await h.engine.query(new IncrementalResult()).peek(),null);
});
test('default-off operations and facade create neither entries nor windows',async()=>{
 const h=await harness({enabled:false});assert.equal(h.client.islandPolicy.islands,'auto');assert.equal((await h.helper.grantMore(request)).code,'incremental-disabled');assert.equal(await h.helper.loadCapabilities(),null);
 await assert.rejects(dispatch(h.engine,new BeginIncrementalAuthorization({intent:'grant-more',request})),{code:'incremental-disabled'});await assert.rejects(dispatch(h.engine,new CompleteIncrementalAuthorization({url:redirectUri})),{code:'incremental-disabled'});assert.equal(h.calls.length,0);assert.equal(h.driver.opened.length,0);
});
test('real flow popup transport and callback relay return partial with complete current grant',async()=>{
 const granted={fields:['calendar','day'],methods:{calendar:{[contract]:['read','delete']}}},h=await harness({tokenResponse:({record})=>json({access_token:'partial-access',token_type:'Bearer',expires_in:60,issuer,client_id:clientId,subject:record.subjectConstraint,audience:issuer+'/rpc',grants:['old','partial'],granted_fragments:[{grant:'partial',fragment,digest,fields:granted.fields}],fragment_outcomes:[{fragment,outcome:'partial',granted}]})}),original=h.client.session;
 const result=await h.helper.grantMore({...request,reason:'Calendar due dates.'});
 assert.deepEqual(result.fragments[0].granted,granted);assert.deepEqual(result.fragments[0].methods.calendar[contract],{granted:['read'],missing:['create']});assert.equal(h.client.session,original);assert.equal(h.driver.opened.length,1);assert.equal(h.driver.opened[0].features,'popup');assert.equal(h.driver.opened[0].opener,null);
 assert.equal(h.calls.filter(call=>call.path==='/api/oauth/entries').length,1);assert.equal(h.calls.filter(call=>call.path==='/oauth/token').length,1);assert.ok(h.calls.every(call=>call.credentials==='omit'));assert.deepEqual(await h.helper.result(),result);
});
test('declined, absent, unsupported and unavailable outcomes preserve previous access without retries',async()=>{
 for(const outcome of ['declined',null,'unsupported','unavailable']){
  const h=await harness({token:{fragment_outcomes:outcome?[{fragment,outcome}]:[]}}),original=h.client.session,result=await h.helper.grantMore(request);
  assert.equal(result.fragments[0].outcome,outcome??'declined');assert.deepEqual(result.fragments[0].methods.calendar[contract],{granted:['read'],missing:['create']});assert.equal(h.client.session,original);assert.equal(h.calls.length,2);
 }
});
test('redirect completion survives a fresh helper and consumes the state exactly once',async()=>{
 const h=await harness({presentation:'redirect'});assert.equal((await h.helper.grantMore(request)).outcome,'redirecting');assert.equal(h.driver.opened.length,0);
 const callback=h.authorize(h.assigned[0]),returned=createIncrementalClient({client:h.client,enabled:true,window:h.win,presentation:'redirect'});cleanups.push(()=>returned.dispose());
 const result=await handleCallback({session:returned,location:{href:callback},storage:h.client.storage,render:false});assert.equal(result.mode,'redirect');assert.equal(result.fragments[0].outcome,'granted');
 assert.equal((await returned.completeCallback(callback)).code,'invalid-callback');assert.equal(h.calls.filter(call=>call.path==='/oauth/token').length,1);
});
test('configured and unchanged hints both require an authoritative fresh preferences read',async()=>{
 for(const result of ['configured','unchanged']){
  const reads=[],h=await harness({readPreferences:async(...args)=>{reads.push(args);return {revision:19,values:{day:'friday'}};}}),original=h.client.session;h.state.choice=result;
  const returned=await h.helper.configure({target:{fragment,fields:['day']},suggestion:{values:{day:'monday'}},reason:'Weekly summaries.'});
  assert.equal(returned.outcome,result);assert.equal(returned.preferences.values.day,'friday');assert.equal(returned.preferences.revision,19);assert.equal(reads.length,1);assert.equal(reads[0][0],fragment);assert.equal(h.client.session,original);assert.equal(h.calls.some(call=>call.path==='/oauth/token'),false);
 }
});
test('configure redirect never trusts its hint without restoring the same connected app session',async()=>{
 const h=await harness({presentation:'redirect'});await h.helper.configure({target:{fragment,fields:['day']}});const callback=h.authorize(h.assigned[0]);
 h.client.session=null;const returned=createIncrementalClient({client:h.client,enabled:true,window:h.win});cleanups.push(()=>returned.dispose());assert.equal((await returned.completeCallback(callback)).code,'no-session');assert.equal(h.calls.some(call=>call.path==='/oauth/token'),false);
});
test('rate limits expose Retry-After and an issuer-bound review link without retrying',async()=>{
 for(const retry of ['3600',new Date(Date.now()+3600000).toUTCString()]){
  const h=await harness({entryResponse:()=>json({error:'rate_limited',owner_review_uri:issuer+'/access/apps/tasks'},429,{'Retry-After':retry})}),result=await h.helper.grantMore(request);
  assert.equal(result.outcome,'rate_limited');assert.ok(result.retryAfter>=3598&&result.retryAfter<=3600);assert.equal(result.ownerReviewUri,issuer+'/access/apps/tasks');assert.equal(h.calls.length,1);assert.equal(h.driver.opened[0].closed,true);
 }
 const h=await harness({entryResponse:()=>json({error:'rate_limited',owner_review_uri:'https://attacker.example/review'},429)});assert.equal((await h.helper.configure({target:{fragment}})).ownerReviewUri,undefined);
});
test('invalid requests fail before network; suggestions cannot nominate resources or fields outside target',async()=>{
 const h=await harness();
 for(const input of [{requests:[]},{requests:Array(5).fill(request.requests[0])},{requests:[{...request.requests[0],required:true}]},{...request,reason:'😀'.repeat(201)},{...request,maxAge:0},{...request,target:{fragment}},{requests:[{...request.requests[0],digest:'invalid'}]}])await assert.rejects(dispatch(h.engine,new BeginIncrementalAuthorization({intent:'grant-more',request:input})),{code:'invalid_request'});
 for(const input of [{target:{fragment,fields:[]}},{target:{fragment,fields:Array.from({length:9},(_,i)=>'f'+i)}},{target:{fragment,fields:['day']},suggestion:{values:{enabled:true}}},{target:{fragment},suggestion:{values:{calendar:{id:issuer+'/resources/r1'}}}},{target:{fragment},suggestion:{values:{day:'x'.repeat(2048)}}},{target:{fragment},requests:[]}])await assert.rejects(dispatch(h.engine,new BeginIncrementalAuthorization({intent:'configure',request:input})),{code:'invalid_request'});
 assert.equal(h.calls.length,0);
});
test('unsupported intent and provider fallback remain explicit and never send an undeclared intent',async()=>{
 const h=await harness({declare:[]});assert.equal((await h.helper.grantMore(request)).code,'unsupported-provider');assert.equal((await h.helper.configure({target:{fragment}})).code,'unsupported-provider');assert.equal(h.calls.length,0);assert.equal(h.driver.opened.length,0);
 const missing=await harness({entryResponse:()=>json({},404)});assert.equal((await missing.helper.grantMore(request)).code,'unsupported-provider');assert.equal((await missing.helper.grantMore(request)).code,'unsupported-provider');assert.equal(missing.calls.length,1);
});
test('blocked popup creates no request with prompt fallback; default fallback uses one redirect',async()=>{
 const h=await harness({blocked:true,popupFallback:'prompt'});assert.equal((await h.helper.grantMore(request)).outcome,'popup-blocked');assert.equal(h.calls.length,0);
 const fallback=await harness({blocked:true});assert.equal((await fallback.helper.configure({target:{fragment}})).outcome,'redirecting');assert.equal(fallback.calls.length,1);assert.equal(fallback.assigned.length,1);
});
test('callback checks bind exact URI, state, issuer and result kind before consuming',async()=>{
 for(const intent of ['grant-more','configure']){
  const h=await harness(),start=await dispatch(h.engine,new BeginIncrementalAuthorization({intent,request:intent==='configure'?{target:{fragment}}:request,presentation:'popup'})),callback=h.authorize(start.authorizationUrl);
  for(const alter of [url=>{url.pathname='/elsewhere';},url=>url.searchParams.set('iss','https://other.example'),url=>url.searchParams.append('state',start.state),url=>url.searchParams.set('app','wrong'),url=>{url.hash='x';},url=>url.searchParams.set(intent==='configure'?'code':'result','wrong')]){
   const url=new URL(callback);alter(url);await assert.rejects(dispatch(h.engine,new CompleteIncrementalAuthorization({url:url.href})),{code:'invalid-callback'});
  }
  await dispatch(h.engine,new CompleteIncrementalAuthorization({url:callback}));
 }
});
test('uncertain exchange loss is single-use and never replayed',async()=>{
 const h=await harness({tokenResponse:()=>{throw Error('response lost');}}),start=await dispatch(h.engine,new BeginIncrementalAuthorization({intent:'grant-more',request,presentation:'popup'})),callback=h.authorize(start.authorizationUrl);
 await assert.rejects(dispatch(h.engine,new CompleteIncrementalAuthorization({url:callback})),/response lost/);await assert.rejects(dispatch(h.engine,new CompleteIncrementalAuthorization({url:callback})),{code:'invalid-callback'});assert.equal(h.calls.filter(call=>call.path==='/oauth/token').length,1);
});
test('malformed or missing full grants never become permissions',async()=>{
 for(const token of [{fragment_outcomes:[{fragment,outcome:'partial'}]},{fragment_outcomes:[{fragment,outcome:'partial',granted:full}]},{fragment_outcomes:[{fragment,outcome:'suppressed'}]},{fragment_outcomes:[{fragment,outcome:'granted',granted:{fields:4}}]},{fragment_outcomes:[{fragment,outcome:'declined'},{fragment,outcome:'declined'}]},{refresh_token:'unexpected',fragment_outcomes:[]}]){
  const h=await harness({token}),result=await h.helper.grantMore(request);assert.equal(result.code,'invalid_token_response');assert.equal(h.calls.length,2);
 }
});
test('cancellation and account changes fence late completion and never change an app session',async()=>{
 const entered=deferred(),held=deferred(),h=await harness({tokenResponse:async()=>{entered.resolve();await held.promise;return json({fragment_outcomes:[{fragment,outcome:'granted',granted:full}]});}}),original=h.client.session;
 const result=h.helper.grantMore(request);await entered.promise;await h.helper.cancel();held.resolve();assert.equal((await result).outcome,'dismissed');assert.equal(h.client.session,original);
 const read=deferred(),resume=deferred(),configured=await harness({readPreferences:async()=>{read.resolve();await resume.promise;return {revision:2,values:{}};}}),pending=configured.helper.configure({target:{fragment}});await read.promise;configured.client.signOut();resume.resolve();assert.equal((await pending).code,'canceled');assert.equal(configured.client.session,null);
});
test('DOM click preserves popup activation and uses the existing callback relay',async()=>{
 const h=await harness(),window=new Window({url:'https://app.example/'}),button=window.document.createElement('button');button.textContent='Add calendar access';window.document.body.append(button);let returned;
 button.addEventListener('click',()=>{returned=h.helper.grantMore(request);assert.equal(h.driver.opened.length,1);});button.click();assert.equal((await returned).fragments[0].outcome,'granted');await window.happyDOM.close();
 h.win.navigator.userActivation.isActive=false;await assert.rejects(h.helper.configure({target:{fragment}}),{name:'NotAllowedError'});assert.equal(h.driver.opened.length,1);
});
test('incremental code and ngin stay outside the static first-render element bundle',async()=>{
 const result=await build({entryPoints:['packages/sdk/src/define.mjs'],bundle:true,write:false,format:'esm',splitting:true,outdir:'.output/ia-sdk-budget',metafile:true,logLevel:'silent'});
 assert.equal(Object.keys(result.metafile.inputs).some(path=>path.endsWith('/incremental.mjs')),false);
 assert.equal(Object.keys(result.metafile.inputs).some(path=>path.startsWith('vendor/ngin/')),false);
});
test('DPoP outcome-only exchange retries one nonce challenge and releases its unused key',async()=>{
 const proofs=[];let tries=0;
 const h=await harness({dpop:true,tokenResponse:async({req,record})=>{
  const [header,payload,signature]=req.headers.get('DPoP').split('.'),jwk=JSON.parse(Buffer.from(header,'base64url')),proof=JSON.parse(Buffer.from(payload,'base64url'));proofs.push(proof);
  assert.equal(proof.htu,issuer+'/oauth/token');assert.equal(proof.htm,'POST');assert.equal(proof.ath,undefined);assert.ok(record.dpopJkt);
  const key=await crypto.subtle.importKey('jwk',jwk.jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+payload)),true);
  return ++tries===1?json({error:'use_dpop_nonce'},400,{'DPoP-Nonce':'server-nonce'}):json({fragment_outcomes:[{fragment,outcome:'declined'}]});
 }});
 const result=await h.helper.grantMore(request);assert.equal(result.fragments[0].outcome,'declined');assert.equal(proofs.length,2);assert.equal(proofs[1].nonce,'server-nonce');assert.notEqual(proofs[0].jti,proofs[1].jti);assert.equal(h.client.dpopKeys.size,0);
});
test('new token responses validate subject, lifetime and outcomes and leave session ownership explicit',async()=>{
 for(const patch of [null,{subject:issuer+'/people/wrong'},{expires_in:3600},{fragment_outcomes:[{fragment,outcome:'declined'}]}]){
  const h=await harness({tokenResponse:({record})=>json({access_token:'incremental-access',token_type:'Bearer',expires_in:60,issuer,client_id:clientId,subject:record.subjectConstraint,audience:issuer+'/rpc',grants:['old','new'],granted_fragments:[{grant:'new',fragment,digest,fields:full.fields}],fragment_outcomes:[{fragment,outcome:'partial',granted:full}],...patch})}),original=h.client.session,result=await h.helper.grantMore(request);
  assert.equal(h.client.session,original);
  if(patch){assert.equal(result.code,'invalid_token_response');assert.equal(h.provider.revoked.has('incremental-access'),true);}
  else{assert.ok(result.issuedSession,JSON.stringify(result));assert.equal(result.issuedSession.access_token,'incremental-access');assert.equal(result.fragments[0].outcome,'partial');await h.client.revokeSession(result.issuedSession);assert.equal(h.provider.revoked.has('incremental-access'),true);}
 }
});
test('a grant redirect can finish in a genuinely new client document with outcome-only exchange',async()=>{
 const h=await harness({presentation:'redirect'});await h.helper.grantMore(request);const callback=h.authorize(h.assigned[0]);
 const client=new BindleClient({clientId,redirectUri,fetcher:h.client.fetcher,storage:h.client.storage});await client.discoverHost('provider.example');assert.equal(client.session,null);
 const returned=createIncrementalClient({client,enabled:true,window:h.win});cleanups.push(()=>returned.dispose());assert.equal((await returned.completeCallback(callback)).fragments[0].outcome,'granted');assert.equal(client.session,null);
});
test('foreign stored token endpoints cannot receive a verifier',async()=>{
 const h=await harness({presentation:'redirect'});await h.helper.grantMore(request);const callback=h.authorize(h.assigned[0]),storage=h.client.storage,key=storage.key(0),record=JSON.parse(storage.getItem(key));record.tokenEndpoint='https://attacker.example/token';storage.setItem(key,JSON.stringify(record));
 const returned=createIncrementalClient({client:h.client,enabled:true,window:h.win});cleanups.push(()=>returned.dispose());assert.equal((await returned.completeCallback(callback)).code,'invalid-callback');assert.equal(h.calls.length,1);
});
test('explicit cancellation removes a redirect verifier and only the helper transaction namespace',async()=>{
 const h=await harness({presentation:'redirect'});await h.helper.grantMore(request);const callback=h.authorize(h.assigned[0]);h.client.storage.setItem('other-app','keep');await h.helper.cancel();
 assert.equal((await h.helper.completeCallback(callback)).code,'invalid-callback');assert.equal(h.client.storage.getItem('other-app'),'keep');assert.equal(h.calls.length,1);
});
test('a later decline retains the full current grant learned by an earlier request',async()=>{
 const h=await harness();await h.helper.grantMore(request);h.state.token={fragment_outcomes:[{fragment,outcome:'declined'}]};const result=await h.helper.grantMore(request);
 assert.equal(result.fragments[0].outcome,'declined');assert.deepEqual(result.fragments[0].methods.calendar[contract],{granted:['read','create'],missing:[]});assert.deepEqual(result.fragments[0].granted.fields,full.fields);
});
test('a late error from a canceled exchange cannot contaminate a newer request result',async()=>{
 const entered=deferred(),held=deferred(),reading=deferred(),resume=deferred(),h=await harness({tokenResponse:async()=>{entered.resolve();await held.promise;throw Error('late response loss');},readPreferences:async()=>{reading.resolve();await resume.promise;return {revision:3,values:{day:'friday'}};}});
 const old=h.helper.grantMore(request);await entered.promise;await h.helper.cancel();assert.equal((await old).outcome,'dismissed');
 const next=h.helper.configure({target:{fragment}});await reading.promise;held.resolve();await new Promise(setImmediate);resume.resolve();assert.equal((await next).outcome,'configured');
});
