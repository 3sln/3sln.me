// UI-state chaos: real Actions, the real API transport (createAPI over a scripted fetch) and the real
// console renderer in happy-dom. A seeded scheduler answers requests out of order, injects 5xx/429,
// truncated bodies, resets, hangs and session expiry, and interleaves account switches and network
// transitions. After every run the rendered DOM is checked for the user-visible invariants: nothing
// stuck, no other owner's data, honest outcomes. Real-browser coverage lives in tests/e2e/ui-chaos*.
import test from 'node:test';
import assert from 'node:assert/strict';
import {within,waitFor} from '../helpers/async.mjs';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/console'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData','HTMLInputElement','MouseEvent'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
const {Engine,Provider,dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {compilePortalModules}=await import('../../packages/portal/index.mjs');
const {default:StateProvider}=await import('../../apps/web/src/providers/browser-state.mjs');
const {createAPI}=await import('../../apps/web/src/providers/api.mjs');
const {default:createApp}=await import('../../apps/web/src/ui/release-app.mjs');
const release=await import('../../apps/web/src/bl/release.mjs');
const accounts=await import('../../apps/web/src/bl/accounts.mjs');
const incoming=await import('../../apps/web/src/bl/incoming.mjs');
const {createAdminAPI}=await import('../../apps/web/src/providers/admin-api.mjs');
const {default:AdminStateProvider,initialAdminState}=await import('../../apps/web/src/providers/admin-state.mjs');
const ops=await import('../../apps/web/src/bl/admin-console.mjs');
const {accessView}=await import('../../apps/web/src/ui/admin-access.mjs');
const {consoleView}=await import('../../apps/web/src/ui/admin-console.mjs');
const {startEntryPage}=await import('../../apps/web/src/bl/authorize-entry-page.mjs');
// Register lifecycle hooks after imports, so a slow import cannot trigger early global restoration.
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});

function seeded(seed){let a=seed>>>0;const next=()=>{a=a+0x6D2B79F5>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};return {next,pick:list=>list[Math.floor(next()*list.length)],int:n=>Math.floor(next()*n)};}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
/** Waits for a condition across event-loop turns (bounded; never a fixed sleep). */
const until=(check,what='the expected chaos request')=>waitFor(check,what);
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const A='550e8400-e29b-41d4-a716-446655440001',B='550e8400-e29b-41d4-a716-446655440002',handles={[A]:'n.alpha',[B]:'n.bravo'};
const allView={id:'all',name:'All messages',builtin:true,revision:1,filter:{version:1},sort:'activity-desc'};

/** A scripted service. Every fetch is parked until the seeded scheduler answers it (in any order). */
function service(random,{faults=true}={}){
 const signedIn=new Set([A,B]),parked=[],calls=[];let active=A,created=0,saved=0,closed=false;
 const owner=headers=>headers['X-Bindle-Account']??active;
 const reply=({path,method,headers,body})=>{const who=owner(headers),url=new URL(path,'https://space.example');
  if(url.pathname==='/api/session')return signedIn.has(active)?json({authenticated:true,account:{id:active,handle:handles[active]},csrfToken:'csrf-'+active,sessionContext:'ctx-'+active}):json({authenticated:false});
  if(url.pathname==='/api/auth/accounts')return json({accounts:[...signedIn].map(id=>({account:{id,handle:handles[id]},sessionContext:'ctx-'+id,expiresAt:Date.now()+3600000})),revision:(signedIn.size===2?'r':'s').repeat(43),activeOwner:active,pickerToken:'picker',limit:5,cleanupPending:false});
  if(url.pathname==='/api/auth/accounts/switch'){const next=body.owner;if(!signedIn.has(next))return json({error:'account_unavailable',message:'That account is not signed in.'},409);active=next;return json({account:{id:next,handle:handles[next]},csrfToken:'csrf-'+next,sessionContext:'ctx-'+next});}
  if(!signedIn.has(who))return json({error:'unauthorized',message:'Sign in to continue.'},401);
  if(url.pathname==='/api/account')return json({account:{id:who,handle:handles[who]},collections:[],messages:[],contacts:[],rules:[],resources:[],views:[allView,{id:'p-'+who,name:handles[who]+'-private-view',revision:1,filter:{version:1},sort:'activity-desc'}]});
  if(url.pathname==='/api/views'&&method==='GET')return json({views:[allView,{id:'p-'+who,name:handles[who]+'-private-view',revision:1,filter:{version:1},sort:'activity-desc'}]});
  if(url.pathname==='/api/views'&&method==='POST'){created++;return json({view:{id:'v'+created,name:body.name,revision:1}});}
  if(url.pathname==='/api/incoming')return json({items:[{id:'item-'+who,type:'message',mimeType:'text/plain',receivedAt:1,subject:handles[who]+'-private-item',organizationRevision:1}],cursor:null});
  return json({error:'not_found',message:'Not found.'},404);};
 const fetch=(path,options={})=>{if(closed)return Promise.reject(new Error('Chaos fixture closed.'));const request={path,method:options.method??'GET',headers:options.headers??{},body:options.body?JSON.parse(options.body):undefined};calls.push(request);
  return new Promise((resolve,reject)=>{const entry={request,resolve,reject,settled:false};parked.push(entry);options.signal?.addEventListener('abort',()=>{if(entry.settled)return;entry.settled=true;parked.splice(parked.indexOf(entry),1);reject(options.signal.reason);},{once:true});});};
 /** Answer one parked request, chosen by the seed, with the real reply or a seeded fault. */
 const answer=()=>{const entry=parked.splice(random.int(parked.length),1)[0];entry.settled=true;const roll=faults?random.next():1;
  if(roll<0.06)return entry.reject(new TypeError('Failed to fetch'));
  if(roll<0.12)return entry.resolve(json({error:'unavailable',message:'The service is temporarily unavailable.'},random.pick([500,503])));
  if(roll<0.15)return entry.resolve(json({error:'rate_limited',message:'Please wait before trying again.'},429,{'Retry-After':'30'}));
  if(roll<0.18)return entry.resolve(new Response('{"account":{"id":"',{status:200,headers:{'content-type':'application/json'}}));
  if(entry.request.method==='POST'&&entry.request.path==='/api/views')saved++;entry.resolve(reply(entry.request));};
 return {fetch,parked,calls,answer,signedIn,close(){closed=true;for(const entry of parked.splice(0)){entry.settled=true;entry.reject(new Error('Chaos fixture closed.'));}},get active(){return active;},get saved(){return saved;},expire(id){signedIn.delete(id);}};
}
function consoleFixture(seed,options,apiOptions={}){
 const random=seeded(seed),server=service(random,options),secrets={accountPickerIssuedAt:Date.now()};let ids=0;
 const api=createAPI(apiOptions);const fetchBefore=globalThis.fetch;globalThis.fetch=(...args)=>server.fetch(...args);
 const browser={preferences:()=>({}),language:()=> 'en',applyLocale(){},savePreferences(){},inputFocused:()=>false,onFocus:()=>()=>{},route:()=>({kind:'home'}),online:()=>true,restorePending:()=>null,pushPermission:()=> 'unsupported',installCaptcha(){},applyBrand(){},setCaptchaAction(){},installWorker(){},onNetwork:()=>()=>{},now:()=>Date.now(),delay:()=>()=>{},id:()=>'id-'+(++ids),navigate(){},captureFocus(){},modalFocus(){},restoreFocus(){},focusAccounts(){},announceAccounts(){},clearOwnerContext(){},cancelDeviceEntry(){},clearPending(){},captcha:()=>({}),
  secret:key=>secrets[key],storeSecret:(key,value)=>{secrets[key]=value;},savePending(){},consumeSubmission(){throw new Error('unused');}};
 const registry=compilePortalModules([{id:'chaos',contributions:{}}]);
 const engine=new Engine({providers:{portalContributions:Provider.fromSingleton(registry),state:StateProvider,api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),recoveryFile:Provider.fromSingleton({})}});
 const root=document.createElement('main'),app=createApp();let latest;const subscription=engine.query(new release.BrowserState()).subscribe({next:state=>{latest=state;}});
 const pending=new Set(),failures=[],act=action=>{
  const completion=engine.dispatch(action).next('complete');
  pending.add(completion);completion.then(()=>pending.delete(completion),()=>pending.delete(completion));
  const run=within(completion,`${action.constructor.name} dispatch`);
  run.catch(error=>failures.push(error));return run;
 };
 const render=()=>{dodo.reconcile(root,[app(latest)]);return root;};
 /** Answer requests in seeded order until no Action is running and nothing is parked. */
 const drain=async()=>{await until(()=>{
  if(failures.length)throw new AggregateError(failures,'Chaos dispatch failed');
  if(server.parked.length){server.answer();return false;}return !pending.size;
 },'chaos actions and scripted requests to settle');};
 return {engine,api,server,random,secrets,act,drain,render,state:()=>latest,async close(){
  // Requests and queued dispatches must finish while their DOM realm and fetch are installed.
  server.close();
  try{await within(Promise.allSettled([...pending]),'chaos dispatches during teardown');await engine.dispose();subscription.unsubscribe();}
  finally{globalThis.fetch=fetchBefore;}
 }};
}
const STUCK=root=>[...root.querySelectorAll('button')].filter(button=>button.textContent.trim()==='Please wait…').length+root.querySelectorAll('.boot-screen,[aria-busy=true]').length;

test('seeded account, network and response chaos never renders another owner’s data, never sticks, and never claims a failed save',async()=>{
 for(let seed=1;seed<=100;seed++){
  const f=consoleFixture(seed);try{
   f.act(new release.InitializeSpace());await f.drain();
   for(let step=0;step<30;step++){
    const roll=f.random.next(),other=(f.state().session?.account?.id??A)===A?B:A;
    if(roll<0.14)f.act(new accounts.OpenAccounts());
    else if(roll<0.28){f.secrets.accountPickerIssuedAt=Date.now();f.act(new accounts.SwitchAccount({owner:other}));}
    else if(roll<0.42)f.act(new incoming.SelectView({id:f.random.pick(['all','p-'+A,'p-'+B])}));
    else if(roll<0.52)f.act(new release.NetworkChanged({online:f.random.next()<0.5}));
    else if(roll<0.62)f.act(new release.RecheckSession());
    else if(roll<0.74)f.act(new incoming.SaveView({values:{name:'Chaos '+step,tagsAll:'',read:'any',type:'any',classification:'any',sort:'activity-desc'}}));
    else if(roll<0.78&&f.server.signedIn.size>1)f.server.expire(f.random.pick([A,B]));
    else if(roll<0.9)f.act(new incoming.LoadIncoming({}));
    // Answer a seeded number of parked requests before the next intent: replies race user input.
    for(let n=f.random.int(3);n>0&&f.server.parked.length;n--){f.server.answer();await turn();}
   }
   await f.drain();f.act(new release.NetworkChanged({online:true}));await f.drain();
   const state=f.state(),root=f.render(),text=root.textContent,owner=state.session?.account?.id;
   assert.equal(state.busy,false,`seed ${seed}: busy released`);assert.equal(STUCK(root),0,`seed ${seed}: nothing stuck on screen: ${[...root.querySelectorAll('[aria-busy=true],.boot-screen')].map(node=>node.className+' '+node.textContent.slice(0,80)).join(' | ')} ${JSON.stringify({loading:state.loading,accountsLoading:state.accountsLoading,incomingLoading:state.incomingLoading,accountPicker:state.accountPicker,error:state.error})}`);
   for(const id of [A,B])if(id!==owner)assert.equal(text.includes(handles[id]+'-private'),false,`seed ${seed}: no ${handles[id]} data while ${owner?handles[owner]:'signed out'} is shown`);
   if(owner)assert.equal(f.api.account,owner,`seed ${seed}: transport context matches the rendered account`);
   if(state.notice==='View saved.')assert.ok(f.server.saved>0,`seed ${seed}: "saved" is shown only after the service confirmed a save`);
   if(owner&&state.data)assert.equal(state.data.account?.id,owner,`seed ${seed}: rendered data belongs to the rendered account`);
   assert.equal(/Failed to fetch|Unexpected (end|token)|JSON/.test(text),false,`seed ${seed}: no raw transport errors rendered`);
  }finally{await f.close();}
 }
});

test('a View create retried after a lost reply reuses its operation ID; a new create gets a fresh one',async()=>{
 const f=consoleFixture(5,{faults:false});try{
  f.act(new release.InitializeSpace());await f.drain();
  const values={name:'Retry me',tagsAll:'work',read:'any',type:'any',classification:'any',sort:'activity-desc'},posts=()=>f.server.calls.filter(call=>call.method==='POST'&&call.path==='/api/views');
  // The service may have created the View, but its reply is lost.
  const lost=f.act(new incoming.SaveView({values}));await until(()=>f.server.parked.some(entry=>entry.request.method==='POST'));
  const entry=f.server.parked.splice(f.server.parked.findIndex(entry=>entry.request.method==='POST'),1)[0];entry.settled=true;entry.reject(new TypeError('Failed to fetch'));await lost;await f.drain();
  assert.notEqual(f.state().notice,'View saved.');
  f.act(new incoming.SaveView({values}));await f.drain();assert.equal(f.state().notice,'View saved.');
  f.act(new incoming.SaveView({values:{...values,name:'Another'}}));await f.drain();
  const ids=posts().map(call=>call.body.operationId);assert.equal(ids.length,3);
  assert.ok(ids.every(Boolean),'every create carries an operation ID');assert.equal(ids[1],ids[0],'the retry reuses the lost attempt’s ID');assert.notEqual(ids[2],ids[0],'a new create attempt gets a new ID');
  assert.equal(f.state().viewCreateAttempt,null,'a confirmed create clears the attempt');
 }finally{await f.close();}
});

test('a request that never answers ends in an honest timeout and releases the sign-in form',async t=>{
 const f=consoleFixture(3,{faults:false},{timeout:40});try{
  f.server.expire(A);f.server.expire(B);f.act(new release.InitializeSpace());await f.drain();
  await f.engine.container.use({state:{write:true}},({state})=>state.transition(s=>Object.assign(s,{auth:'login',authMethod:'password'})));
  // The login request is parked and never answered: only the client deadline can end it.
  const signin=f.act(new release.SignIn({values:{handle:'n.alpha',password:'Correct horse battery staple'}}));await until(()=>f.server.calls.some(call=>call.path==='/api/auth/login/password'));
  assert.equal([...f.render().querySelectorAll('button')].some(button=>button.textContent==='Please wait…'),true,'busy while pending');
  await signin;const root=f.render(),submit=root.querySelector('.auth-card form button[type=submit]');
  assert.equal(f.state().busy,false);assert.equal(submit.textContent,'Sign in with password');assert.equal(submit.disabled,false);assert.match(root.querySelector('[role=alert]').textContent,/did not respond in time\. Check whether your request went through/);assert.equal(f.state().session,null);
 }finally{f.server.parked.length=0;await f.close();}
 const fetchBefore=globalThis.fetch;t.after(()=>{globalThis.fetch=fetchBefore;});globalThis.fetch=(path,{signal}={})=>new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 for(const [method,expected] of [['GET',/did not respond in time\. Please try again/],['POST',/did not respond in time\. Check whether your request went through/]]){
  const api=createAPI({timeout:20});await assert.rejects(method==='GET'?api.get('/api/session'):api.request('/api/views',{}),error=>error.code==='request_timeout'&&expected.test(error.message)&&error.status===undefined);
 }
 // A caller's own deadline keeps its identity (device sign-in words its own timeout).
 const api=createAPI({timeout:1000});await assert.rejects(api.request('/api/auth/device/poll',{},'POST',{signal:AbortSignal.timeout(10)}),error=>error.name==='TimeoutError');
});

test('transport failures are mapped to translatable messages; an unreadable success is never a refusal',async t=>{
 const fetchBefore=globalThis.fetch;t.after(()=>{globalThis.fetch=fetchBefore;});const api=createAPI({});
 globalThis.fetch=async()=>{throw new TypeError('Failed to fetch');};
 await assert.rejects(api.get('/api/account'),error=>error.code==='network_unavailable'&&/could not be reached/.test(error.message));
 await assert.rejects(api.request('/api/views',{}),error=>error.code==='network_unavailable'&&/request went through/.test(error.message));
 globalThis.fetch=async()=>new Response('{"outcome":"conf',{status:200,headers:{'content-type':'application/json'}});
 await assert.rejects(api.request('/api/billing/change-plan',{}),error=>error.code==='response_unreadable'&&error.status===undefined);
 globalThis.fetch=async()=>new Response('<html>Bad gateway</html>',{status:502});
 await assert.rejects(api.get('/api/account'),error=>error.status===502);
 const {createLocalization}=await import('../../apps/web/src/shared/i18n.mjs');const es=createLocalization({locale:'es'});
 for(const message of ['The service could not be reached. Check your connection and try again.','The connection was interrupted before the service replied. Check whether your request went through before trying again.','The service replied, but the reply could not be read. Check whether your request went through before trying again.','The service did not respond in time. Please try again.','The service did not respond in time. Check whether your request went through before trying again.','Your change was saved, but the latest information could not be loaded. Reload to see it.'])assert.notEqual(es.t(message),message,`Spanish translation for “${message}”`);
});

test('duplicate device-poll events and a duplicate session check apply one authorization once',async()=>{
 const f=consoleFixture(7,{faults:false});try{
  // A device login is pending on a signed-out screen; two due events fire in the same turn.
  f.server.expire(A);f.server.expire(B);f.act(new release.InitializeSpace());await f.drain();
  let generation=1;const browser=await f.engine.container.use(['browser'],({browser})=>browser);Object.assign(browser,{deviceEntryLive:g=>g===generation,deviceEntrySignal:()=>new AbortController().signal,deviceGeneration:()=>generation,cancelDeviceEntry(){generation++;}});
  await f.engine.container.use({state:{write:true}},({state})=>state.transition(s=>Object.assign(s,{deviceGeneration:1,deviceContextGeneration:s.beamGeneration??0,captchaPurpose:'device',deviceLogin:{requestId:'550e8400-e29b-41d4-a716-446655440011',userCode:'23456789',status:'authorization_pending',expiresAt:Date.now()+60000,interval:5,nextPollAt:Date.now()}})));
  f.secrets.deviceCode='private-device';const polls=()=>f.server.calls.filter(call=>call.path==='/api/auth/device/poll').length;
  f.server.signedIn.add(A);
  f.act(new release.PollDeviceLogin());f.act(new release.PollDeviceLogin());await until(()=>polls()>=1);for(let i=0;i<10;i++)await turn();
  assert.equal(polls(),1,'the busy reservation absorbs the duplicate poll');
  const entry=f.server.parked.find(item=>item.request.path==='/api/auth/device/poll');f.server.parked.splice(f.server.parked.indexOf(entry),1);entry.settled=true;entry.resolve(json({status:'authorized',account:{id:A,handle:handles[A]},csrfToken:'csrf-'+A,sessionContext:'ctx-'+A}));
  await f.drain();f.act(new release.RecheckSession());f.act(new release.RecheckSession());await f.drain();
  const state=f.state(),root=f.render();assert.equal(state.session.account.id,A);assert.equal(state.deviceLogin,null);assert.equal(polls(),1);assert.equal(STUCK(root),0);
  assert.equal(root.querySelectorAll('.user-summary').length,1);assert.equal([...root.querySelectorAll('.collection-link')].filter(node=>node.textContent.includes('n.alpha-private-view')).length,1,'refreshed data is applied once, not duplicated');
}finally{await f.close();}
});

test('recovery unlock: a lost reply keeps the decrypted file for an explicit retry and never navigates on failure',{timeout:10000},async()=>{
 const f=consoleFixture(11,{faults:false});try{
  const browser=await f.engine.container.use(['browser'],({browser})=>browser),navigations=[];Object.assign(browser,{recoveryChallenge:()=>'local-browser-test-token',clearRecoveryChallenge(){},navigate:url=>navigations.push(url)});
  const recoveryFile=await f.engine.container.use(['recoveryFile'],({recoveryFile})=>recoveryFile);// This is a UI scheduling test; real Argon2 is covered by the recovery crypto suites.
  recoveryFile.decrypt=async()=>({version:1,recoveryToken:'opaque-recovery-token'});
  await f.engine.container.use({state:{write:true}},({state})=>state.transition(s=>Object.assign(s,{loading:false,route:{kind:'recovery-restore'},unlockQuestions:[{id:'q',prompt:'Passphrase'}],config:{origin:'https://space.example'}})));
  f.secrets.restoreFile='encrypted-file-text';
  const first=f.act(new release.RecoverAccount({values:{'unlock:q':'answer'}}));const second=f.act(new release.RecoverAccount({values:{'unlock:q':'answer'}}));
  const recovers=()=>f.server.calls.filter(call=>call.path==='/api/auth/recover');await until(()=>recovers().length>=1,'the first recovery request');
  // The second dispatch uses a timer. Event-loop turns do not prove it ran:
  // keep the first request parked until the duplicate has completed while busy.
  await second;assert.equal(recovers().length,1,'double submit sends one recovery');
  const entry=f.server.parked.find(item=>item.request.path==='/api/auth/recover');f.server.parked.splice(f.server.parked.indexOf(entry),1);entry.settled=true;entry.reject(new TypeError('Failed to fetch'));await Promise.all([first,second]);
  assert.equal(f.secrets.restoreFile,'encrypted-file-text','file kept for an explicit retry');assert.deepEqual(navigations,[]);assert.match(f.state().error,/request went through/);assert.equal(f.state().busy,false);
  const retry=f.act(new release.RecoverAccount({values:{'unlock:q':'answer'}}));await until(()=>recovers().length>=2);const again=f.server.parked.find(item=>item.request.path==='/api/auth/recover');f.server.parked.splice(f.server.parked.indexOf(again),1);again.settled=true;again.resolve(json({pendingToken:'pending',credentialRequired:true}));await retry;
  assert.equal(recovers().length,2);assert.deepEqual(navigations,['/recovery/setup']);assert.equal(f.secrets.restoreFile,null);
 }finally{await f.close();}
});

// ---- Host administration: step-up under faults ----------------------------------------------------------
const now=Date.now(),overview=()=>({actor:{kind:'admin',owner:A},boot:null,catalog:{version:1,capabilities:{},roles:{},badgeClasses:{}},catalogRevision:1,badges:[],reservations:{static:[],runtime:[]},claims:[],audit:{seq:1}});
async function adminFixture(script,extra={}){
 const calls=[],secrets=new Map(),events=[];const fetch=async(path,options)=>{const call={path,body:JSON.parse(options.body??'{}')};calls.push(call);return script(call);};
 const account=createAPI({});account.setContext({account:{id:A},sessionContext:'ctx',csrfToken:'csrf'});const api=createAdminAPI({fetch,account});
 const browser={route:()=>({mode:'admin'}),origin:()=>'https://space.example',now:()=>Date.now(),language:()=>'en',applyLocale(){},setTitle(){},every:()=>()=>{},secret:k=>secrets.get(k)??null,storeSecret:(k,v)=>v==null?secrets.delete(k):secrets.set(k,v),clearSecrets:()=>secrets.clear(),authenticatePasskey:async()=>({id:'cred',response:{}}),navigate(){},rememberFocus(){},restoreFocus(){},focus(){}};
 const engine=new Engine({providers:{api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),state:class extends AdminStateProvider{constructor(){super(initialAdminState({mode:'admin',now,phase:'console',account:{id:A,handle:'ops',passkey:true},...extra}));}}}});
 engine.feed.addEventListener('admin-retry',event=>events.push(event.detail));const read=await engine.container.use(['state'],({state})=>state.snapshot);
 return {engine,calls,events,read:()=>read(),act:action=>engine.dispatch(action).next('complete'),close:()=>engine.dispose()};
}
test('admin step-up: double confirm sends one credential; a reset or 5xx keeps the modal recoverable and never retries the operation',async()=>{
 let stepFault='reset',stepped=false,release,hold=new Promise(resolve=>{release=resolve;});
 const f=await adminFixture(({path})=>{if(path==='/api/admin/overview')return stepped?json(overview()):json({error:'step_up_required',message:'Step up.'},403);if(path==='/api/admin/step-up/begin')return json({passkey:true,password:false,authenticationOptions:{challenge:'a'}});
  if(path==='/api/admin/step-up'){if(hold){const gate=hold;hold=null;return gate.then(()=>{throw new TypeError('Failed to fetch');});}if(stepFault==='reset')throw new TypeError('Failed to fetch');if(stepFault===429)return json({error:'rate_limited',message:'Wait.'},429);stepped=true;return json({stepUpUntil:Date.now()+300000});}return json({error:'not_found'},404);});
 try{
  await f.act(new ops.LoadOverview({kind:'reload-overview'}));assert.equal(f.read().modal.kind,'step-up');
  // The first credential is still in flight (held) when the second confirm arrives.
  const first=f.act(new ops.StepUpConfirm({method:'passkey'}));await until(()=>f.calls.some(call=>call.path==='/api/admin/step-up'));await f.act(new ops.StepUpConfirm({method:'passkey'}));release();await first;
  assert.equal(f.calls.filter(call=>call.path==='/api/admin/step-up').length,1,'one credential sent for a double confirm');
  assert.equal(f.read().modal?.kind,'step-up','the modal stays open after a reset');assert.equal(f.read().modal.error.code,'network');assert.equal(f.read().busy,false);assert.equal(f.events.length,0,'the operation is not retried without a confirmed step-up');assert.equal(f.read().phase,'console');
  const root=document.createElement('main');dodo.reconcile(root,[consoleView(f.read())]);assert.equal(STUCK(root),0);
  stepFault=429;await f.act(new ops.StepUpConfirm({method:'passkey'}));assert.equal(f.read().modal?.kind,'step-up');assert.equal(f.read().modal.error.code,'rate_limited');assert.equal(f.events.length,0);
  stepFault=null;await f.act(new ops.StepUpConfirm({method:'passkey'}));assert.equal(f.read().modal,null);assert.deepEqual(f.events,[{kind:'reload-overview'}],'exactly one retry after success');
 }finally{await f.close();}
});

test('admin: a transient 503 during step-up wipes privileged data and leaves a visible way back',async()=>{
 let unavailable=true;
 const f=await adminFixture(({path})=>{if(path==='/api/admin/step-up/begin')return json({passkey:true,password:false,authenticationOptions:{challenge:'a'}});if(path==='/api/admin/overview')return unavailable?json({error:'step_up_required'},403):json(overview());if(path==='/api/admin/step-up')return json({error:'temporarily_unavailable',message:'Busy.'},503);if(path==='/api/admin/access')return json({admin:true,handle:'ops',passkey:true});return json({error:'not_found'},404);},{overview:overview()});
 try{
  assert.ok(f.read().overview,'privileged data is on screen before the fault');
  await f.act(new ops.LoadOverview({kind:'reload-overview'}));await f.act(new ops.StepUpConfirm({method:'passkey'}));
  const state=f.read(),root=document.createElement('main');dodo.reconcile(root,[state.phase==='console'?consoleView(state):accessView(state)]);
  assert.equal(STUCK(root),0);assert.equal(state.overview??null,null,'no privileged data is left behind');
  // Reported limitation: a transient 503 closes the console honestly ("not available right now"); the way back is a link to the space, not an in-place retry.
  const controls=[...root.querySelectorAll('button:not([disabled]),a[href]')].map(node=>node.textContent.trim());
  assert.ok(controls.some(text=>/Try again|Retry|Reload|Check again|Back to your space/.test(text)),`a way back is offered in phase ${state.phase}: ${JSON.stringify(controls)}`);
 }finally{await f.close();}
});

// ---- Authorization entry page under faults --------------------------------------------------------------
const issuer='https://provider.example',appOrigin='https://app.example',entryId='E'.repeat(43),nonce='N'.repeat(22),pageToken='T'.repeat(43);
const entryView=()=>({entry:{client:{id:appOrigin+'/client',name:'Example app',origin:appOrigin},redirectUri:appOrigin+'/callback',intent:'login',requests:[],presentation:'popup',delivery:'popup',nonce,expiresAt:Date.now()+600000},pageToken});
/** Resolves when the rendered entry satisfies `check` (re-evaluated every macrotask), bounded by `ms`; the arming delay is real time. */
async function rendered(root,check,ms=3000){const deadline=Date.now()+ms;while(!check()){if(Date.now()>deadline)throw new Error('Rendered state not reached: '+root.textContent.slice(0,160));await new Promise(resolve=>setTimeout(resolve,5));}}
function press(button){const down=new window.Event('pointerdown',{bubbles:true});Object.defineProperty(down,'isTrusted',{value:true});button.dispatchEvent(down);const event=new window.MouseEvent('click',{bubbles:true,cancelable:true,detail:1});Object.defineProperty(event,'isTrusted',{value:true});button.dispatchEvent(event);}
function entryHarness(route){
 const root=document.createElement('div');document.body.replaceChildren(root);window.document.hasFocus=()=>true;const nav=[],calls=[];
 const win=Object.assign(new EventTarget(),{document,location:window.location,opener:null,BroadcastChannel:undefined,setInterval:()=>0,clearInterval(){},open(){return null;}});
 const browser={win,origin:issuer,get location(){return {pathname:'/oauth/authorize',search:`?entry=${entryId}`};},framed:()=>false,sandboxed:()=>false,now:()=>Date.now(),replace:url=>nav.push({replace:url}),assign:url=>nav.push({assign:url}),close:()=>nav.push({close:true})};
 const fetch=async(path,options={})=>{const call={path,method:options.method??'GET',headers:options.headers??{},body:options.body?JSON.parse(options.body):undefined};calls.push(call);return route(call);};
 const page=startEntryPage({root,preferredLocale:'en',win,fetch,browser});return {root,nav,calls,page};
}
test('authorization entry: a dropped connection, 5xx or 429 while loading reads as unavailable, never as expired',async()=>{
 for(const [fault,phase] of [['reset','not available right now'],[503,'not available right now'],[429,'not available right now'],[404,'expired']]){
  const h=entryHarness(()=>{if(fault==='reset')throw new TypeError('Failed to fetch');return json({error:fault===404?'not_found':'unavailable'},fault);});
  try{await rendered(h.root,()=>/not available right now|has expired/.test(h.root.textContent));assert.match(h.root.querySelector('h1').textContent,new RegExp(phase),`${fault} → ${phase}`);assert.equal(STUCK(h.root),0);assert.deepEqual(h.nav,[]);}finally{h.page.dispose();}
 }
});
test('authorization entry: a double press selects once, a lost decision reply stays on the chooser, and a retry returns exactly once',async()=>{
 const account='550e8400-e29b-41d4-a716-446655440002',requestId=`${account}.${'R'.repeat(43)}`;let releaseSelect,decisions=0;
 const h=entryHarness(call=>{const key=`${call.method} ${call.path}`;
  if(key===`GET /api/oauth/entries/${entryId}`)return json(entryView());
  if(key==='GET /api/auth/accounts')return json({accounts:[{account:{id:account,handle:'sam'},sessionContext:'cb',expiresAt:Date.now()+3600000}]});
  if(key==='GET /api/session')return json({authenticated:true,account:{id:account,handle:'sam'},csrfToken:'csrf-sam',sessionContext:'cb'});
  if(key===`POST /api/oauth/entries/${entryId}/select`)return releaseSelect?json({requestId}):new Promise(resolve=>{releaseSelect=()=>resolve(json({requestId}));});
  if(key===`GET /api/oauth/requests/${encodeURIComponent(requestId)}`)return json({requestId,authenticated:true,client:{id:appOrigin+'/client',name:'Example app',origin:appOrigin,redirectUris:[appOrigin+'/callback']},requests:[]});
  if(key===`POST /api/oauth/entries/${entryId}/decision`){decisions++;if(decisions===1)throw new TypeError('Failed to fetch');return json({redirectUri:`${appOrigin}/callback?code=CODE&state=S&iss=${encodeURIComponent(issuer)}`});}
  return json({error:'not_found'},404);});
 try{
  const approve=()=>h.root.querySelector('[data-entry-approve]');await rendered(h.root,()=>approve()&&!approve().hasAttribute('aria-disabled'));
  press(approve());press(approve());await until(()=>releaseSelect);await turn();assert.equal(h.calls.filter(call=>call.path.endsWith('/select')).length,1,'one select for a double press');
  releaseSelect();await rendered(h.root,()=>Boolean(h.root.querySelector('[role=alert]')?.textContent));
  assert.deepEqual(h.nav,[],'no navigation after a lost decision reply');assert.equal(decisions,1);assert.doesNotMatch(h.root.textContent,/Returning to/);assert.equal(STUCK(h.root),0);
  await rendered(h.root,()=>approve()&&!approve().hasAttribute('aria-disabled'));press(approve());await rendered(h.root,()=>h.nav.length>0);
  assert.deepEqual(h.nav,[{assign:`${appOrigin}/callback?code=CODE&state=S&iss=${encodeURIComponent(issuer)}`}]);assert.equal(decisions,2);assert.equal(h.calls.filter(call=>call.path.endsWith('/select')).length,2,'the retry selects again explicitly');
 }finally{h.page.dispose();}
});
