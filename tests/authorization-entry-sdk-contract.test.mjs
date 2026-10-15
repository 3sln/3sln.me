// Runs the SDK flow expectations (packages/sdk/test/flows.test.mjs, written against testing.mjs) against the real
// entry, token and revocation handlers. The provider page is simulated over real HTTP: view, select, inspect, decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession} from '../packages/sdk/src/flows.mjs';
import {memoryStorage} from '../packages/sdk/src/testing.mjs';
import {handleCallback} from '../packages/sdk/src/callback.mjs';
import {provider,post,providerPage,pageHeaders,issuer,clientId,redirectUri} from './authorization-entry-helpers.mjs';
const host=new URL(issuer).host;
function fakeWindow(){const assigned=[];return {assigned,navigator:{language:'en'},location:{href:'https://app.example/',assign:url=>assigned.push(url)},matchMedia:()=>({matches:false})};}
/** The first-party page outcome for an entry URL: the callback URL the provider would navigate to. */
async function authorize(p,url,{decision='approve',account=p.accounts[0],authTime}={}){
 const entryId=new URL(url).searchParams.get('entry'),page=await p.entries.view(entryId),view=page.entry,session=p.signIn(account,authTime);
 if(view.intent==='end-session')return (await(await post(p,`${issuer}/api/oauth/entries/${entryId}/end-session`,{nonce:view.nonce,confirmed:decision==='approve'},pageHeaders(page,{Cookie:session.cookie,'X-CSRF-Token':session.csrf}))).json()).redirectUri;
 const done=await providerPage(p,entryId,session,{decision});if(done.result?.redirectUri)return done.result.redirectUri;
 // The page refused the chosen account (wrong account, stale sign-in): the user cancels from the chooser.
 return (await(await post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.nonce,denied:true},pageHeaders(page))).json()).redirectUri;
}
function installPopupDriver(p,win,{decide=()=>({decision:'approve'}),blocked=false}={}){
 const opened=[];win.open=(url,target,features)=>{if(blocked)return null;const popup={url,target,features,closed:false,opener:win,document:{title:'',body:{textContent:''}},close(){popup.closed=true;},focus(){},location:{}};
  Object.defineProperty(popup.location,'href',{get:()=>popup.url,set:value=>{popup.url=value;if(new URL(value).origin!==issuer)return;queueMicrotask(async()=>{const choice=await decide();const callback=await authorize(p,value,choice);popup.callbackUrl=callback;popup.result=await handleCallback({location:{href:callback},history:{replaceState(){}},storage:memoryStorage(),BroadcastChannel:globalThis.BroadcastChannel,render:false,close:false});});}});
  opened.push(popup);return popup;};return {opened};
}
// Test-only adapter: the reference runtime does not advertise the authorization entry while its routes are
// unmounted (release gate F8), so this merges the real entries module's own declaration (`entries.manifest()`,
// protocol §2 `features` form) into the served manifest. It also declares `popup`, because these tests drive the
// popup relay with a simulated window (the reference provider has no popup pages yet). Every other byte comes
// from the real handlers.
function declared(p){return async(input,init)=>{
 const response=await p.fetch(input,init),url=new URL(input instanceof Request?input.url:input);
 if(url.pathname!=='/.well-known/bindle/manifest.json'||!response.ok)return response;
 const manifest=await response.json(),entry=p.entries.manifest();
 return new Response(JSON.stringify({...manifest,login_presentation:['redirect','popup'],features:{...manifest.features,...entry.features}}),{status:200,headers:{'Content-Type':'application/json'}});
};}
async function setup({decide,blocked,storage=memoryStorage(),endSession=false,...options}={}){
 const p=await provider({endSession}),win=fakeWindow(),driver=installPopupDriver(p,win,{decide,blocked}),fetcher=declared(p);
 const session=createSession({clientId,redirectUri,fetcher,storage,history:{replaceState(){}},window:win,defaultHost:host,...options});await session.loadCapabilities();return {p,win,driver,session,storage,fetcher};
}
const entryRecords=async p=>(await p.entries.store.transaction(tx=>tx.list('entry/'))).map(r=>r.value);

test('SDK contract: popup sign-in through the real entry exposes only the approved identity, without cookies',async()=>{
 const {p,session,driver}=await setup();
 assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'completed'});assert.equal(session.state,'signed-in');assert.equal(session.session.subject,p.accounts[0].subject);assert.equal(session.client.session.auth_time,undefined);
 const [popup]=driver.opened;assert.match(popup.url,new RegExp(`^${issuer}/oauth/authorize\\?entry=[A-Za-z0-9_-]{43}$`));assert.equal(popup.result.mode,'relay');
 const [entry]=await entryRecords(p);assert.equal(entry.intent,'login');assert.equal(entry.loginHint,`alex@${host}`);assert.equal(entry.presentation,'popup');
 assert.ok(p.log.every(call=>!call.headers.cookie||call.url.startsWith(`${issuer}/api/oauth/entries/`)||call.url.startsWith(`${issuer}/api/oauth/requests/`)));
});

test('SDK contract: identity-optional sign-in and provider refusal are one canceled outcome',async()=>{
 const {p,session}=await setup({decide:()=>({decision:'deny'})});
 assert.deepEqual(await session.signIn(),{outcome:'canceled'});assert.equal((await entryRecords(p))[0].loginHint,undefined);assert.equal(session.session,null);
});

test('SDK contract: a blocked popup falls back to a redirect entry that completes on the callback page',async()=>{
 const storage=memoryStorage(),{p,session,win}=await setup({blocked:true,storage});
 assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'redirecting',fallback:true});assert.equal((await entryRecords(p))[0].presentation,'redirect');
 const callback=await authorize(p,win.assigned[0]),returned=createSession({clientId,redirectUri,fetcher:declared(p),storage,history:{replaceState(){}},window:fakeWindow(),defaultHost:host});
 const handled=await handleCallback({session:returned,location:{href:callback},storage,render:false});assert.equal(handled.outcome,'completed');assert.equal(returned.session.subject,p.accounts[0].subject);
});

test('SDK contract: switching keeps the old session until approval, then revokes the previous refresh family at the real endpoint',async()=>{
 let choice={decision:'approve'};const {p,session}=await setup({decide:()=>choice});
 await session.signIn({identity:'alex'});const first=session.session,firstTokens=session.client.session;
 choice={decision:'deny'};assert.deepEqual(await session.switchAccount(),{outcome:'canceled'});assert.equal(session.session,first);
 choice={decision:'approve',account:p.accounts[1]};assert.deepEqual(await session.switchAccount({revokePrevious:true}),{outcome:'completed'});assert.equal(session.session.subject,p.accounts[1].subject);
 assert.equal((await entryRecords(p)).at(-1).intent,'select-account');
 await new Promise(resolve=>setTimeout(resolve,10));
 const reuse=await p.fetch(`${issuer}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:firstTokens.refresh_token,client_id:clientId})});assert.equal(reuse.status,400);
});

test('SDK contract: reauthentication requires the same subject and a fresh auth_time from the real token response',async()=>{
 let choice={decision:'approve'};const {p,session}=await setup({decide:()=>choice});
 await session.signIn({identity:'alex'});const original=session.client.session;
 choice={decision:'approve',account:p.accounts[1]};assert.deepEqual(await session.reauthenticate({maxAge:60}),{outcome:'canceled'});assert.equal(session.client.session,original);
 choice={decision:'approve',authTime:p.clock()-120000};assert.deepEqual(await session.reauthenticate({maxAge:60}),{outcome:'canceled'});assert.equal(session.client.session,original);
 choice={decision:'approve'};assert.deepEqual(await session.reauthenticate({maxAge:60}),{outcome:'completed'});
 assert.equal(session.client.session.subject,original.subject);assert.ok(Number.isSafeInteger(session.client.session.auth_time));
 const entry=(await entryRecords(p)).at(-1);assert.equal(entry.subjectConstraint,original.subject);assert.equal(entry.maxAge,60);
});

test('SDK contract: provider end-session returns completed or canceled and signOut revokes through RFC 7009',async()=>{
 let choice={decision:'approve'};const {p,session}=await setup({decide:()=>choice,endSession:true});
 await session.signIn({identity:'alex'});choice={decision:'deny'};assert.deepEqual(await session.endProviderSession(),{outcome:'canceled'});assert.equal(session.session,null);assert.equal(p.ended.length,0);
 choice={decision:'approve'};await session.signIn({identity:'alex'});assert.deepEqual(await session.endProviderSession(),{outcome:'completed'});assert.equal(p.ended.length,1);
 await session.signIn({identity:'alex'});const tokens=session.client.session;assert.deepEqual(await session.signOut({revoke:true}),{outcome:'completed'});
 const reuse=await p.fetch(`${issuer}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:clientId})});assert.equal(reuse.status,400);
});

test('SDK contract: without end-session configured the SDK refuses that intent from the real manifest',async()=>{
 const {session}=await setup();await session.signIn({identity:'alex'});const result=await session.endProviderSession();assert.equal(result.code,'unsupported-provider');
});

test('SDK contract: a DPoP-bound app session uses a non-extractable key, the nonce retry, the provider lifetime and per-session revocation',async()=>{
 const {p,session}=await setup();
 assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'completed'});
 const tokens=session.client.session,[entry]=await entryRecords(p);
 assert.equal(entry.dpopJkt,tokens.dpopJkt);assert.equal(tokens.tokenType,'Bearer');assert.ok(tokens.refresh_expires_in>28800);assert.ok(Number.isSafeInteger(tokens.refresh_idle_expires_in));
 const key=await session.client.dpopKey(tokens.dpopJkt);assert.equal(key.privateKey.extractable,false);
 const exchanges=p.log.filter(call=>call.url===`${issuer}/oauth/token`);assert.equal(exchanges.length,2,'one use_dpop_nonce retry');assert.ok(exchanges.every(call=>call.headers.dpop));
 const renewed=await session.client.refresh();assert.notEqual(renewed.refresh_token,tokens.refresh_token);assert.equal(renewed.dpopJkt,tokens.dpopJkt);
 // Without its key the refresh token neither renews nor revokes the session.
 const stolen=await p.fetch(`${issuer}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:renewed.refresh_token,client_id:clientId})});assert.equal(stolen.status,400);
 assert.deepEqual(await session.signOut({revoke:true}),{outcome:'completed'});
 const after=await p.fetch(`${issuer}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:renewed.refresh_token,client_id:clientId})});assert.equal(after.status,400);
 assert.equal(session.client.dpopKeys.size,0,'keys are released with their sessions');
});
