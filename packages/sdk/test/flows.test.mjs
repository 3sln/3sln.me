// Headless flow tests. Entry-based flows run against testing.mjs only: the
// provider-owned authorization entry (D1/S4) is not implemented on any server yet.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSession,flowTimings} from '../src/flows.mjs';
import {createMockProvider,memoryStorage} from '../src/testing.mjs';
import {handleCallback,callbackChannelName,parseRelayMessage} from '../src/callback.mjs';
import {BindleClient} from '../src/identity.mjs';

const clientId='https://app.example/client',redirectUri='https://app.example/callback';
function fakeWindow(){const assigned=[];return {assigned,navigator:{language:'en'},location:{href:'https://app.example/',assign:url=>assigned.push(url)},matchMedia:()=>({matches:false})};}
// Capabilities are discovered first (as <bindle-session> does on connect), so the
// first click can choose a declared popup synchronously.
async function setup({provider=createMockProvider({issuer:'https://3sln.example'}),decide,blocked,storage=memoryStorage(),load=true,...options}={}){
  const win=fakeWindow(),driver=provider.installPopupDriver(win,{decide,blocked});
  const session=createSession({clientId,redirectUri,fetcher:provider.fetch,storage,history:{replaceState(){}},window:win,defaultHost:'3sln.example',...options});
  if(load)await session.loadCapabilities();
  const events=[];for(const type of ['change','flow-start','flow-end'])session.addEventListener(type,event=>events.push([type,event.detail]));
  return {provider,win,driver,session,events,storage};
}
const entryBodies=provider=>[...provider.entries.values()].filter(entry=>!entry.legacy);

test('popup sign-in completes over the same-origin relay and exposes only the approved identity',async()=>{
  const {provider,session,driver,events}=await setup();
  assert.equal(session.state,'signed-out');assert.equal(session.session,null);
  const result=await session.signIn({identity:'alex'});
  assert.deepEqual(result,{outcome:'completed'});
  assert.equal(session.state,'signed-in');assert.equal(session.session.subject,provider.accounts[0].subject);assert.equal(session.session.issuer,'https://3sln.example');
  assert.equal(session.session.profile,undefined);assert.equal(session.client.session.auth_time,undefined);
  await new Promise(resolve=>setTimeout(resolve,10));const [popup]=driver.opened;assert.equal(popup.url.startsWith('https://3sln.example/oauth/authorize?entry='),true);assert.equal(popup.features,'popup');assert.equal(popup.opener,null);assert.equal(popup.result.mode,'relay');assert.equal(popup.result.acknowledged,true);
  const [entry]=entryBodies(provider);assert.equal(entry.intent,'login');assert.equal(entry.loginHint,'alex@3sln.example');assert.equal(entry.presentation,'popup');assert.equal(entry.subjectConstraint,undefined);assert.equal(entry.challengeMethod,'S256');
  assert.ok(provider.log.every(call=>call.credentials==='omit'));
  assert.deepEqual(events.map(([type])=>type),['flow-start','change','flow-end']);
});

test('identity-optional sign-in sends no handle and provider-side refusals are one generic canceled outcome',async()=>{
  const {provider,session}=await setup({decide:()=>({decision:'deny'})});
  assert.deepEqual(await session.signIn(),{outcome:'canceled'});
  assert.equal(entryBodies(provider)[0].loginHint,undefined);assert.equal(session.session,null);assert.equal(session.state,'signed-out');
});

test('invalid input never opens a window and popup mode requires user activation',async()=>{
  const {session,driver,win}=await setup();
  assert.deepEqual(await session.signIn({identity:'alex@evil.example/path'}),{outcome:'discovery-error',code:'invalid-identity',message:'Enter a handle like alex@provider.example.'});
  assert.equal(driver.opened.length,0);
  win.navigator.userActivation={isActive:false};
  await assert.rejects(session.signIn({identity:'alex'}),{name:'NotAllowedError'});assert.equal(driver.opened.length,0);
});

test('a blocked popup falls back to a fresh redirect entry by default and completes on the callback page',async()=>{
  const storage=memoryStorage(),{provider,session,win}=await setup({blocked:true,storage});
  const events=[];session.addEventListener('flow-state',event=>events.push(event.detail?.fallback));
  assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'redirecting',fallback:true});
  assert.equal(entryBodies(provider)[0].presentation,'redirect');assert.equal(win.assigned.length,1);assert.ok(events.includes(true));
  // The callback page is a fresh document in the same tab, sharing sessionStorage.
  const callback=provider.authorize(win.assigned[0]),returned=createSession({clientId,redirectUri,fetcher:provider.fetch,storage,history:{replaceState(){}},window:fakeWindow()});
  const handled=await handleCallback({session:returned,location:{href:callback},storage,render:false});
  assert.equal(handled.mode,'redirect');assert.equal(handled.outcome,'completed');assert.equal(returned.session.subject,provider.accounts[0].subject);
});

test('prompt fallback reports popup-blocked and Continue in this tab starts a fresh redirect transaction',async()=>{
  const {provider,session,win}=await setup({blocked:true,popupFallback:'prompt'});
  assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'popup-blocked',code:'popup-blocked'});
  assert.equal(session.flow.phase,'blocked');assert.equal(provider.entries.size,0);
  assert.deepEqual(await session.continueInTab(),{outcome:'redirecting'});assert.equal(win.assigned.length,1);assert.equal(provider.entries.size,1);
});

test('switching keeps the old session until a new approval completes, then optionally revokes it',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example',accounts:[{handle:'alex'},{handle:'sam'}]});
  let choice={decision:'approve'};const {session}=await setup({provider,decide:()=>choice});
  await session.signIn({identity:'alex'});const first=session.session,firstTokens=session.client.session;
  choice={decision:'deny'};assert.deepEqual(await session.switchAccount(),{outcome:'canceled'});assert.equal(session.session,first);
  choice={decision:'approve',account:provider.accounts[1]};assert.deepEqual(await session.switchAccount({revokePrevious:true}),{outcome:'completed'});
  assert.equal(session.session.subject,provider.accounts[1].subject);
  const entry=[...provider.entries.values()].at(-1);assert.equal(entry.intent,'select-account');assert.equal(entry.subjectConstraint,undefined);
  await new Promise(resolve=>setTimeout(resolve,5));assert.ok(provider.revoked.has(firstTokens.refresh_token));
});

test('reauthentication requires the same subject and a fresh auth_time, and failures keep the current session',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example',accounts:[{handle:'alex'},{handle:'sam'}]});
  let choice={decision:'approve'};const {session}=await setup({provider,decide:()=>choice});
  await session.signIn({identity:'alex'});const original=session.client.session;
  choice={decision:'approve',account:provider.accounts[1]};assert.deepEqual(await session.reauthenticate({maxAge:60}),{outcome:'canceled'});assert.equal(session.client.session,original);
  choice={decision:'approve',authTime:Date.now()-120000};assert.deepEqual(await session.reauthenticate({maxAge:60}),{outcome:'canceled'});assert.equal(session.client.session,original);
  choice={decision:'approve'};assert.deepEqual(await session.reauthenticate({maxAge:60}),{outcome:'completed'});
  assert.notEqual(session.client.session,original);assert.equal(session.client.session.subject,original.subject);assert.ok(Number.isSafeInteger(session.client.session.auth_time));
  const entry=[...provider.entries.values()].at(-1);assert.equal(entry.subjectConstraint,original.subject);assert.equal(entry.maxAge,60);
});

test('provider end-session always clears app tokens; app sign-out never contacts the provider session',async()=>{
  let choice={decision:'approve'};const {provider,session}=await setup({decide:()=>choice});
  await session.signIn({identity:'alex'});choice={decision:'deny'};
  assert.deepEqual(await session.endProviderSession(),{outcome:'canceled'});assert.equal(session.session,null);
  choice={decision:'approve'};await session.signIn({identity:'alex'});
  assert.deepEqual(await session.endProviderSession(),{outcome:'completed'});assert.equal(session.session,null);
  await session.signIn({identity:'alex'});const tokens=session.client.session,entries=provider.entries.size;
  assert.deepEqual(await session.signOut({revoke:true}),{outcome:'completed'});
  assert.equal(session.session,null);assert.equal(provider.entries.size,entries);assert.ok(provider.revoked.has(tokens.refresh_token));
  assert.deepEqual(await session.switchAccount(),{outcome:'canceled',code:'no-session'});
});

test('starting a login does not cancel RPCs or clear the current session (EE-08)',async()=>{
  const {session,provider}=await setup({decide:()=>new Promise(()=>{})});
  session.client.session=Object.freeze({issuer:'https://3sln.example',subject:provider.accounts[0].subject,granted_fragments:[],access_token:'a',expiresAt:Date.now()+300000,rpcEndpoint:'https://3sln.example/rpc'});
  const generation=session.client.generation;session.signIn({identity:'alex'});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(session.client.generation,generation);assert.ok(session.client.session);
  session.cancelFlow();assert.ok(session.client.session);session.dispose();
});

test('two controllers on one page keep separate pending transactions',async()=>{
  const storage=memoryStorage(),provider=createMockProvider({issuer:'https://3sln.example',clients:[{clientId,redirectUris:[redirectUri]},{clientId:'https://other.example/client',redirectUris:['https://other.example/callback']}]});
  const a=new BindleClient({clientId,redirectUri,storage,fetcher:provider.fetch}),b=new BindleClient({clientId:'https://other.example/client',redirectUri:'https://other.example/callback',storage,fetcher:provider.fetch});
  const first=await a.beginAuthorization({identity:'alex@3sln.example'}),second=await b.beginAuthorization({identity:'alex@3sln.example'});
  assert.ok(a.hasPending(first.state));assert.ok(b.hasPending(second.state));assert.ok(!a.hasPending(second.state));assert.ok(!b.hasPending(first.state));
  // Several transactions of one client may be pending at once (redirect, popup, island); each is keyed by state.
  const third=await a.beginAuthorization({identity:'alex@3sln.example'});assert.ok(a.hasPending(first.state)&&a.hasPending(third.state));
  a.cancelLogin(first.state);assert.ok(!a.hasPending(first.state));assert.ok(a.hasPending(third.state));
});

test('relay messages are exact-shape, state-bound and single-use',async()=>{
  assert.equal(parseRelayMessage({v:1,type:'bindle-callback',state:'s',code:'c',extra:1}),null);
  assert.equal(parseRelayMessage({v:1,type:'bindle-callback',state:'s',code:'c',error:'access_denied'}),null);
  assert.equal(parseRelayMessage(Object.assign(Object.create(null),{v:1,type:'bindle-callback',state:'s',code:'c'})),null);
  let release;const {session,provider}=await setup({decide:()=>new Promise(resolve=>release=resolve)});
  const pending=session.signIn({identity:'alex'});await new Promise(resolve=>setTimeout(resolve,10));
  const entry=[...provider.entries.values()][0],channel=new BroadcastChannel(await callbackChannelName(entry.state));
  channel.postMessage({v:1,type:'bindle-callback',state:'wrong',code:'c'.repeat(43),iss:'https://3sln.example'});
  channel.postMessage({v:1,type:'bindle-callback',state:entry.state,code:'c'.repeat(43),iss:'https://3sln.example',extra:true});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(session.flow.phase,'waiting');
  release({decision:'approve'});assert.deepEqual(await pending,{outcome:'completed'});
  channel.postMessage({v:1,type:'bindle-callback',state:entry.state,code:'d'.repeat(43),iss:'https://3sln.example'});await new Promise(resolve=>setTimeout(resolve,10));
  channel.close();assert.equal(session.session.subject,provider.accounts[0].subject);
});

test('waiting state offers recovery after the linger delay and expires as dismissed',async()=>{
  const timers=[];const fake={setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{}};
  const {session}=await setup({decide:()=>new Promise(()=>{}),timers:fake});
  const pending=session.signIn({identity:'alex'});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(session.flow.lingering,false);timers.find(timer=>timer.ms===flowTimings.lingerAfter).fn();assert.equal(session.flow.lingering,true);
  session.showWindow();timers.find(timer=>timer.ms===flowTimings.entryLifetime).fn();assert.deepEqual(await pending,{outcome:'dismissed'});assert.equal(session.client.readPending(),null);
});

test('providers without the entry keep identity-pinned login and refuse other intents',async()=>{
  const {session,provider}=await setup({provider:createMockProvider({issuer:'https://3sln.example',supportsEntry:false})});
  assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'completed'});assert.ok([...provider.entries.values()][0].legacy);
  // CP-10: without select-account or identity-optional login, "Use another account" needs a typed handle.
  assert.deepEqual(await session.switchAccount(),{outcome:'canceled',code:'identity-required'});assert.ok(session.session);
  assert.deepEqual(await session.signIn(),{outcome:'discovery-error',code:'identity-required'});
  assert.deepEqual(await session.reauthenticate(),{outcome:'discovery-error',code:'unsupported-provider'});
});

test('discovery failures report stable codes',async()=>{
  const offline=await setup({fetcher:async()=>{throw new Error('offline');}});
  assert.deepEqual(await offline.session.signIn({identity:'alex'}),{outcome:'discovery-error',code:'discovery-unavailable'});
  // Without a known declaration, presentation "auto" never opens a speculative popup.
  assert.equal(offline.driver.opened.length,0);
  const missing=await setup({fetcher:async()=>new Response('',{status:404})});
  const result=await missing.session.signIn({identity:'alex@mail.example'});assert.equal(result.outcome,'discovery-error');assert.equal(result.code,'no-provider');assert.equal(result.fallback.kind,'email-fallback');
  // The fallback is only ever the configured default host.
  assert.equal(result.fallback.provider,'https://3sln.example');
});

test('pluggable transports run first inside the activation and can fall back; entry extensions add but never override fields',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example',extensionKeys:['dpop_jkt']});
  const calls=[];const transport={name:'test-transport',available:({intent})=>intent==='login',authorize:({intent,client})=>{calls.push([intent,typeof client.beginAuthorization]);return Promise.resolve({outcome:'unavailable'});}};
  const {session,driver}=await setup({provider,transports:[transport],entryExtensions:async()=>({dpop_jkt:'thumbprint-value'})});
  assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'completed'});
  assert.deepEqual(calls,[['login','function']]);assert.equal(driver.opened.length,1);
  assert.equal(entryBodies(provider)[0].dpop_jkt,'thumbprint-value');
  const handled={name:'handled',available:()=>true,authorize:()=>Promise.resolve({outcome:'canceled'})};
  const other=await setup({transports:[handled]});assert.deepEqual(await other.session.signIn({identity:'alex'}),{outcome:'canceled'});assert.equal(other.driver.opened.length,0);
  const overriding=await setup({entryExtensions:async()=>({state:'x'})});
  assert.equal((await overriding.session.signIn({identity:'alex'})).outcome,'network-error');
});

test('callback page: incomplete links are ignored, expired redirect returns are not relayed, unacknowledged relays say so',async()=>{
  const replaced=[],history={replaceState:(a,b,url)=>replaced.push(url)};
  assert.deepEqual(await handleCallback({location:{href:'https://app.example/?state=x&code=y'},history,storage:memoryStorage(),render:false}),{mode:'none'});assert.equal(replaced.length,0);
  const storage=memoryStorage();storage.setItem('bindle.pending-login:x',JSON.stringify({state:'s',expiresAt:Date.now()-1}));
  assert.deepEqual(await handleCallback({location:{href:'https://app.example/callback?state=s&iss=https%3A%2F%2F3sln.example&code=c'},history,storage,render:false}),{mode:'expired'});assert.equal(replaced.at(-1),'/callback');
  const relayed=await handleCallback({location:{href:'https://app.example/callback?state=nobody&iss=https%3A%2F%2F3sln.example&code=c'},history,storage:memoryStorage(),render:false,close:false,ackTimeout:20});
  assert.deepEqual(relayed,{mode:'relay',relayed:true,acknowledged:false});
});

test('end-session clears app tokens even when the provider answers with an error or the window is dismissed',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example'});
  // Dismissed end-session flow: tokens cleared.
  const {session:second}=await setup({provider,decide:(entry)=>entry.intent==='end-session'?new Promise(()=>{}):{decision:'approve'}});
  await second.signIn({identity:'alex'});const pending=second.endProviderSession();await new Promise(resolve=>setTimeout(resolve,10));second.cancelFlow();
  assert.deepEqual(await pending,{outcome:'dismissed'});assert.equal(second.session,null);assert.equal(second.client.readPending(),null);
});

test('callback page: a popup holding a copied record for another state still relays (stale opener records)',async()=>{
  const {session,provider}=await setup({decide:()=>new Promise(()=>{})});
  const pending=session.signIn({identity:'alex'});await new Promise(resolve=>setTimeout(resolve,10));
  const entry=[...provider.entries.values()][0],copied=memoryStorage();
  copied.setItem('bindle.pending-login:'+JSON.stringify(['https://app.example/callback','stale-state']),JSON.stringify({state:'stale-state',redirectUri:'https://app.example/callback',expiresAt:Date.now()+60000}));
  const callback=provider.authorize(entry.entryId);
  const relayed=await handleCallback({location:{href:callback},history:{replaceState(){}},storage:copied,render:false,close:false});
  assert.deepEqual(relayed,{mode:'relay',relayed:true,acknowledged:true});assert.deepEqual(await pending,{outcome:'completed'});
});

