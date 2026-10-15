// Provider-agnostic flows across declarations (components-profile decision note
// §5–§6, §8). Every provider here is testing.mjs's mock: no deployed provider
// declares these features yet. Fixtures use .example hosts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSession} from '../src/flows.mjs';
import {createMockProvider,memoryStorage,installPopupDrivers} from '../src/testing.mjs';
import {BindleClient} from '../src/identity.mjs';
import {validateAccessResponse} from '../src/tokens.mjs';

const clientId='https://app.example/client',redirectUri='https://app.example/callback';
const tick=(ms=5)=>new Promise(resolve=>setTimeout(resolve,ms));
function fakeWindow(extra={}){const assigned=[];return {assigned,navigator:{language:'en'},location:{href:'https://app.example/',assign:url=>assigned.push(url)},matchMedia:()=>({matches:false}),...extra};}
async function setup({provider,providers=[provider],decide,blocked,load=true,win=fakeWindow(),...options}){
  const fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:input);const match=providers.find(item=>item.issuer===url.origin);return match?match.fetch(input,init):new Response('',{status:404});};
  const driver=installPopupDrivers(win,providers,{decide,blocked});
  const session=createSession({clientId,redirectUri,fetcher:fetch,storage:memoryStorage(),history:{replaceState(){}},window:win,defaultHost:new URL(provider.issuer).host,...options});
  if(load)await session.loadCapabilities();
  return {session,win,driver,fetch};
}
const entries=provider=>[...provider.entries.values()].filter(entry=>!entry.legacy);
const opened=win=>win.open.length;

test('minimal provider (floor only): identity-pinned redirect, no popup, nothing it cannot do',async()=>{
  const provider=createMockProvider({issuer:'https://minimal.example',declaration:'minimal'});
  const {session,win,driver}=await setup({provider});
  assert.equal(session.capabilities.identityless,false);assert.equal(session.capabilities.popup,false);
  assert.deepEqual(await session.signIn(),{outcome:'discovery-error',code:'identity-required'});
  assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'redirecting'});
  assert.equal(driver.opened.length,0,'popup only when declared');assert.match(win.assigned[0],/request_id=/);
  const callback=provider.authorize(win.assigned[0]);await session.completeCallback(callback);
  assert.equal(session.state,'signed-in');assert.match(session.session.subject,/^https:\/\/minimal\.example\/people\//);
  assert.equal(session.client.session.refresh_token,undefined,'no refresh grant declared');
  for(const run of [()=>session.reauthenticate(),()=>session.endProviderSession()])assert.deepEqual(await run(),{outcome:'discovery-error',code:'unsupported-provider'});
  assert.deepEqual(await session.switchAccount(),{outcome:'canceled',code:'identity-required'});
  assert.deepEqual(await session.switchAccount({identity:'sam'}),{outcome:'redirecting'});assert.ok(session.session,'the current session stays until the new one is ready');
  assert.equal(driver.opened.length,0);
  const before=provider.log.length;await session.signOut({revoke:true});assert.equal(provider.log.length,before,'no revocation endpoint: local sign-out only');
});

test('standard provider: select-account popup, revocation, and no reauth or provider sign-out',async()=>{
  const provider=createMockProvider({issuer:'https://standard.example',declaration:'standard',accounts:[{handle:'alex'},{handle:'sam'}]});
  let choice={decision:'approve'};const {session,driver}=await setup({provider,decide:()=>choice});
  assert.deepEqual(await session.signIn(),{outcome:'completed'});assert.equal(driver.opened.length,1);
  const first=session.client.session;
  choice={decision:'approve',account:provider.accounts[1]};assert.deepEqual(await session.switchAccount({revokePrevious:true}),{outcome:'completed'});
  assert.equal(entries(provider).at(-1).intent,'select-account');await tick();assert.ok(provider.revoked.has(first.refresh_token),'only the previous app session is revoked');
  assert.ok(!provider.revoked.has(session.client.session.refresh_token));
  assert.deepEqual(await session.reauthenticate(),{outcome:'discovery-error',code:'unsupported-provider'});assert.equal(driver.opened.length,2,'no window for an undeclared intent');
});

test('partial: identity-optional login without select-account switches through login at the same provider',async()=>{
  const provider=createMockProvider({issuer:'https://partial.example',supportedIntents:['login'],accounts:[{handle:'alex'},{handle:'sam'}]});
  let choice={decision:'approve'};const {session}=await setup({provider,decide:()=>choice});
  await session.signIn();const first=session.session;
  choice={decision:'approve',account:provider.accounts[1]};assert.deepEqual(await session.switchAccount(),{outcome:'completed'});
  const entry=entries(provider).at(-1);assert.equal(entry.intent,'login');assert.equal(entry.loginHint,undefined);
  assert.notEqual(session.session.subject,first.subject);
  // The previous app session stays held (not revoked), so an island selection can return to it.
  assert.deepEqual(session.selectAccount(first.subject),{outcome:'completed'});assert.equal(session.session.subject,first.subject);
  assert.deepEqual(session.selectAccount('https://partial.example/people/unknown'),{outcome:'canceled',code:'no-session'});
});

test('presentation "popup" before discovery opens speculatively and closes again for an undeclared popup',async()=>{
  const provider=createMockProvider({issuer:'https://minimal.example',declaration:'minimal'});
  const {session,win,driver}=await setup({provider,load:false,presentation:'popup'});
  assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'redirecting'});
  assert.equal(driver.opened.length,1);assert.equal(driver.opened[0].closed,true);assert.equal(win.assigned.length,1);
  assert.equal(session.capabilities.popup,false);
});

test('unsupported (below the floor) and malformed providers report unsupported-provider, never a fallback',async()=>{
  for(const manifestPatch of [{login_presentation:['popup']},{version:'2'},{token_endpoint:'https://elsewhere.example/token'}]){
    const provider=createMockProvider({issuer:'https://below.example',manifestPatch}),def=createMockProvider({issuer:'https://default.example'});
    const {session,driver}=await setup({provider:def,providers:[def,provider]});
    assert.deepEqual(await session.signIn({identity:'alex@below.example'}),{outcome:'discovery-error',code:'unsupported-provider'},JSON.stringify(manifestPatch));
    assert.equal(driver.opened.length,0);
  }
});

test('email fallback: only after a definitive 404/410, only to the configured default host, and never from it',async()=>{
  const def=createMockProvider({issuer:'https://default.example'}),status=code=>async()=>new Response('',{status:code});
  const missing=await setup({provider:def,fetcher:async(input,init)=>new URL(input).host==='mail.example'?new Response('',{status:410}):def.fetch(input,init)});
  const result=await missing.session.signIn({identity:'alex@mail.example'});
  assert.deepEqual([result.code,result.fallback.provider,result.fallback.identity.handle],['no-provider','https://default.example','alex@mail.example']);
  for(const code of [500,403,429]){const {session}=await setup({provider:def,load:false,fetcher:status(code)});assert.deepEqual(await session.signIn({identity:'alex@mail.example'}),{outcome:'discovery-error',code:'discovery-unavailable'});}
  const selfMissing=await setup({provider:def,load:false,fetcher:status(404)});
  const own=await selfMissing.session.signIn({identity:'alex'});assert.equal(own.code,'no-provider');assert.equal(own.fallback,undefined,'no fallback from the default host to itself');
  const disabled=await setup({provider:def,load:false,emailFallback:false,fetcher:status(404)});
  assert.deepEqual(await disabled.session.signIn({identity:'alex@mail.example'}),{outcome:'discovery-error',code:'no-provider'});
});

test('default-host "none" requires complete handles and offers no fallback',async()=>{
  const provider=createMockProvider({issuer:'https://idp.example'});
  const {session}=await setup({provider,defaultHost:'none',load:false,fetcher:async()=>new Response('',{status:404})});
  assert.equal((await session.signIn({identity:'alex'})).code,'invalid-identity');
  assert.deepEqual(await session.signIn(),{outcome:'discovery-error',code:'identity-required'});
  assert.deepEqual(await session.signIn({identity:'alex@mail.example'}),{outcome:'discovery-error',code:'no-provider'});
});

test('per-provider client IDs: a map, a resolver, and client-id-metadata only where declared',async()=>{
  const a=createMockProvider({issuer:'https://a.example',clients:[{clientId:'app-at-a',redirectUris:[redirectUri]}]}),b=createMockProvider({issuer:'https://b.example',clients:[{clientId:'app-at-b',redirectUris:[redirectUri]}]});
  const {session}=await setup({provider:a,providers:[a,b],clientId:{'https://a.example':'app-at-a','https://b.example':'app-at-b'}});
  assert.deepEqual(await session.signIn(),{outcome:'completed'});assert.equal(entries(a)[0].clientId,'app-at-a');
  // A typed provider whose declaration is not known yet: "auto" redirects (no speculative popup).
  assert.deepEqual(await session.signIn({identity:'alex@b.example'}),{outcome:'redirecting'});assert.equal(entries(b)[0].clientId,'app-at-b');
  await session.completeCallback(b.authorize(entries(b)[0].entryId));assert.equal(session.client.session.client_id,'app-at-b');assert.equal(session.session.issuer,'https://b.example');
  const resolver=await setup({provider:a,providers:[a,b],clientId:issuer=>issuer==='https://a.example'?'app-at-a':null});
  assert.deepEqual(await resolver.session.signIn({identity:'alex@b.example'}),{outcome:'discovery-error',code:'unregistered-client'});assert.equal(entries(b).length,1,'no entry before the client is known');
  const metadataUrl='https://app.example/bindle-client.json';
  const declaring=createMockProvider({issuer:'https://cimd.example',clientMetadata:true,clients:[{clientId:metadataUrl,redirectUris:[redirectUri]}]});
  const viaMetadata=await setup({provider:declaring,providers:[declaring,a],clientId:{'https://a.example':'app-at-a'},clientMetadataUrl:metadataUrl});
  assert.deepEqual(await viaMetadata.session.signIn(),{outcome:'completed'});assert.equal(entries(declaring)[0].clientId,metadataUrl);
  const undeclared=createMockProvider({issuer:'https://plain.example',clients:[{clientId:metadataUrl,redirectUris:[redirectUri]}]});
  const refused=await setup({provider:undeclared,clientId:undefined,clientMetadataUrl:metadataUrl});
  assert.deepEqual(await refused.session.signIn(),{outcome:'discovery-error',code:'unregistered-client'});assert.equal(refused.driver.opened.length,0,'reported before any provider page opens');assert.equal(entries(undeclared).length,0);
  assert.throws(()=>new BindleClient({clientMetadataUrl:'https://elsewhere.example/client.json',redirectUri}),/callback origin/);
  assert.throws(()=>new BindleClient({clientMetadataUrl:'https://app.example/',redirectUri}),/callback origin/);
});

test('DPoP: bound refresh with a non-extractable key, nonce retry, lifted lifetime, DPoP-typed RPC',async()=>{
  const provider=createMockProvider({issuer:'https://full.example',declaration:'full',dpopTokenType:true});
  const {session}=await setup({provider});
  assert.deepEqual(await session.signIn(),{outcome:'completed'});
  const tokens=session.client.session,[entry]=entries(provider);
  assert.equal(entry.dpopJkt,tokens.dpopJkt);assert.equal(tokens.tokenType,'DPoP');assert.equal(tokens.refresh_expires_in,2592000);
  assert.equal((await session.client.dpopKey(tokens.dpopJkt)).privateKey.extractable,false);
  const exchanges=provider.log.filter(call=>call.path==='/oauth/token');assert.equal(exchanges.length,2,'one use_dpop_nonce retry');assert.ok(exchanges.every(call=>call.dpop));
  const result=await session.client.rpc({resource:'@profile',contract:'https://contracts.example/x',method:'read'});assert.equal(result.result.subject,tokens.subject);
  const rpc=provider.log.filter(call=>call.path==='/rpc');assert.ok(rpc.every(call=>call.dpop),'every DPoP-typed RPC carries a proof');
  const renewed=await session.client.refresh();assert.equal(renewed.dpopJkt,tokens.dpopJkt);assert.ok(renewed.refreshExpiresAt<=renewed.refreshAbsoluteAt);
  // Memory-only (unbound) refresh tokens keep the 8 h ceiling; a DPoP-typed token without a proven key is refused.
  const base={issuer:'https://i.example',client_id:'c',token_type:'Bearer',access_token:'a',expires_in:300,audience:'https://i.example/rpc',subject:'https://i.example/u/1',granted_fragments:[],refresh_token:'r',refresh_expires_in:2592000};
  const context={issuer:'https://i.example',clientId:'c',rpcEndpoint:'https://i.example/rpc',clock:Date.now};
  assert.throws(()=>validateAccessResponse(base,context),/renewal credential/);
  assert.ok(validateAccessResponse({...base,refresh_idle_expires_in:604800},{...context,dpopJkt:'k'.repeat(43)}));
  // A long lifetime needs both the proven key and the provider's bound-session description (refresh_idle_expires_in).
  assert.throws(()=>validateAccessResponse(base,{...context,dpopJkt:'k'.repeat(43)}),/renewal credential/);
  assert.throws(()=>validateAccessResponse({...base,token_type:'DPoP',refresh_expires_in:100},context),/access token/);
});

test('subject URLs: any HTTPS path on the issuer origin; other origins, queries and fragments are refused',()=>{
  const base={issuer:'https://i.example',client_id:'c',token_type:'bearer',access_token:'a',expires_in:300,audience:'https://i.example/rpc',granted_fragments:[]};
  const context={issuer:'https://i.example',clientId:'c',rpcEndpoint:'https://i.example/rpc',clock:Date.now};
  for(const subject of ['https://i.example/entities/10000000-0000-4000-8000-000000000001','https://i.example/u/ada','https://i.example/~alex/id'])assert.equal(validateAccessResponse({...base,subject},context).subject,subject);
  for(const subject of ['https://other.example/u/1','https://i.example/u/1?x=1','https://i.example/u/1#f','https://user@i.example/u/1','https://i.example/'+'x'.repeat(2048)])assert.throws(()=>validateAccessResponse({...base,subject},context),/subject|access token/);
});

test('a declared entry endpoint that is not implemented degrades for this issuer and falls back to the floor',async()=>{
  const provider=createMockProvider({issuer:'https://broken.example',entryStatus:501});
  const {session}=await setup({provider});const changes=[];session.addEventListener('capabilities-change',event=>changes.push(event.detail.capabilities.entry));
  assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'completed'});
  assert.ok([...provider.entries.values()][0].legacy,'identity-pinned request after degradation');
  assert.equal(session.capabilities.entry,false);assert.deepEqual(changes,[false]);
});

test('FedCM: used when declared and available; failures after the activation expired continue as a redirect',async()=>{
  const provider=createMockProvider({issuer:'https://full.example',declaration:'full'});
  const win=fakeWindow({IdentityCredential:function(){}}),fedcm=provider.installFedCM(win);
  const {session,driver}=await setup({provider,win});
  assert.equal(session.capabilities.fedcm,true);
  assert.deepEqual(await session.signIn(),{outcome:'completed'});assert.equal(driver.opened.length,0);
  const call=fedcm.calls[0].options;assert.equal(call.mediation,'required');assert.equal(call.identity.providers[0].configURL,'https://full.example/fedcm/config.json');assert.equal(call.identity.providers[0].params.v,1);
  assert.equal(entries(provider)[0].presentation,'fedcm');
  // Non-user failure after the click's activation expired: redirect, never a NotAllowedError rejection.
  const failing=fakeWindow({IdentityCredential:function(){}});provider.installFedCM(failing,{decide:()=>{failing.navigator.userActivation={isActive:false};return {error:'activation expired',name:'NotAllowedError'};}});
  const fallback=await setup({provider,win:failing});const starts=[];fallback.session.addEventListener('flow-start',event=>starts.push(event.detail));
  assert.deepEqual(await fallback.session.signIn(),{outcome:'redirecting'});assert.equal(starts.length,1,'the fallback continues the announced flow');assert.equal(failing.assigned.length,1);assert.equal(fallback.driver.opened.length,0);
  assert.equal(entries(provider).at(-1).presentation,'redirect');
  // User dismissal ends the flow; it never falls back to another window.
  const dismissed=fakeWindow({IdentityCredential:function(){}});provider.installFedCM(dismissed,{decide:()=>({error:'dismissed',name:'AbortError'})});
  const canceled=await setup({provider,win:dismissed});
  assert.deepEqual(await canceled.session.signIn(),{outcome:'canceled'});assert.equal(dismissed.assigned.length,0);
  // Browsers report a dismissed dialog as a generic NetworkError: still a cancel, never a redirect, never a degradation.
  const generic=fakeWindow({IdentityCredential:function(){}});provider.installFedCM(generic,{decide:()=>({error:'Error retrieving a token.',name:'NetworkError'})});
  const quiet=await setup({provider,win:generic});
  for(let i=0;i<2;i++)assert.deepEqual(await quiet.session.signIn(),{outcome:'canceled'});
  assert.equal(generic.assigned.length,0);assert.equal(quiet.session.capabilities.fedcm,true);
});

test('island hooks: prepare keeps PKCE in memory; codes are validated like callbacks; several flows pend at once',async()=>{
  const provider=createMockProvider({issuer:'https://full.example',declaration:'full'});
  let release;const {session,driver}=await setup({provider,decide:()=>new Promise(resolve=>release=resolve)});
  const prepared=await session.prepareIsland('https://full.example');
  assert.equal(session.client.storage.length,0,'island records never touch storage');assert.ok(prepared.dpopJkt);
  const popupFlow=session.signIn();await tick(10);assert.equal(session.client.storage.length,1,'a popup transaction pends alongside');
  // The island creates its own entry with the prepare inputs (here: directly at the mock).
  const created=await (await provider.fetch('https://full.example/api/oauth/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:prepared.clientId,redirectUri:prepared.redirectUri,challenge:prepared.challenge,challengeMethod:'S256',state:prepared.state,intent:'login',requests:[],presentation:'popup',dpopJkt:prepared.dpopJkt})})).json();
  const code=new URL(provider.authorize(created.entryId)).searchParams.get('code');
  assert.deepEqual(await session.completeIslandCode({code,state:prepared.state,iss:'https://other.example'}),{outcome:'network-error',code:'invalid-callback'});
  // A code is bound to the transport that created its record: an island cannot complete a popup transaction.
  const popupState=[...session.client.storage.length?[JSON.parse(session.client.storage.getItem(session.client.storage.key(0))).state]:[]][0];
  assert.deepEqual(await session.completeIslandCode({code,state:popupState,iss:'https://full.example'}),{outcome:'network-error',code:'invalid-callback'});
  await assert.rejects(session.client.completeCode({code,state:prepared.state,iss:'https://full.example'}),{code:'invalid-callback'},'the transport binding is required');
  await assert.rejects(session.client.completeLogin(`https://app.example/callback?state=${prepared.state}&iss=https%3A%2F%2Ffull.example&code=${code}`),{code:'invalid-callback'},'island records never complete through a URL callback');
  assert.ok(session.client.hasPending(popupState),'the popup transaction survives');
  // A mismatched response is refused without consuming the record, exactly like a forged callback.
  assert.deepEqual(await session.completeIslandCode({code,state:prepared.state,iss:'https://full.example'}),{outcome:'completed'});
  assert.equal(session.client.session.dpopJkt,prepared.dpopJkt);
  assert.deepEqual(await session.completeIslandCode({code,state:prepared.state,iss:'https://full.example'}),{outcome:'network-error',code:'invalid-callback'},'single use');
  release({decision:'approve'});assert.deepEqual(await popupFlow,{outcome:'completed'});assert.equal(driver.opened.length,1);
});
