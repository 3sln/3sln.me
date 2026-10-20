// Real browser against the local Worker with FEDERATION_ENTRY_ENABLED and a loopback embed origin (run with
// E2E_AUTHORIZATION_ENTRIES=1 node scripts/run-browser-checks.mjs tests/e2e/authorization-entry-ui.test.mjs).
// Exercises the provider entry page (slice A7) end to end: real member cookies, real entry routes, real
// handshake, real code exchange. Only the app documents (https://bindle-client.example, a reserved .example host)
// are Playwright fixtures; end-session runs against the Worker's real session-ending hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {launch,baseURL,screenshot} from './browser.mjs';
const appOrigin='https://bindle-client.example',clientId=appOrigin+'/client',redirectUri=appOrigin+'/callback',embedOrigin=baseURL.replace('localhost','127.0.0.1');
const password='Authorization entry UI password 2026!',sleep=ms=>new Promise(r=>setTimeout(r,ms));
let browser;
test.before(async()=>{const config=await(await fetch(`${baseURL}/api/config`)).json();assert.equal(config.localDevelopment,true,'local Worker required');browser=await launch();});
test.after(async()=>{await browser?.close();});
// Each request family gets its own documentation-range pseudonym, so no two signups in this suite ever share the
// per-IP signup cooldown (random picks collided by chance). The suite makes well under 245 calls.
let host=10;const ip=()=>`198.51.100.${host++}`;
async function signup(context){const headers={Origin:baseURL,'Content-Type':'application/json','CF-Connecting-IP':ip()};const pending=await(await context.request.post(baseURL+'/api/auth/signup',{headers,data:{method:'password',password,termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}})).json();assert.ok(pending.pendingToken,JSON.stringify(pending));const file=await(await context.request.post(baseURL+'/api/auth/recovery/download',{headers,data:{pendingToken:pending.pendingToken}})).json();const done=await context.request.post(baseURL+'/api/auth/recovery/confirm',{headers,data:{pendingToken:pending.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true}});assert.equal(done.status(),200);return (await done.json()).account;}
const login=async(context,handle)=>{const response=await context.request.post(baseURL+'/api/auth/login/password',{headers:{Origin:baseURL,'Content-Type':'application/json','CF-Connecting-IP':ip()},data:{handle,password,turnstileToken:'local-browser-test-token'}});assert.equal(response.status(),200,await response.text());};
// The fixture app: PKCE entry creation from its own origin (real CORS), an explicit popup button, and a callback
// page. It records every message it receives so the test can prove nothing arrives before approval.
const appPage=`<!doctype html><meta charset="utf-8"><title>Fixture app</title><button id="open">Sign in</button><div id="slot"></div><script>
const ISSUER=${JSON.stringify(baseURL)},EMBED=${JSON.stringify(embedOrigin)},CLIENT=${JSON.stringify(clientId)},REDIRECT=${JSON.stringify(redirectUri)};
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
window.msgs=[];addEventListener('message',e=>msgs.push({origin:e.origin,type:e.data?.type??typeof e.data}));
window.pkce=async()=>{const verifier=b64(crypto.getRandomValues(new Uint8Array(48))),challenge=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))),state=b64(crypto.getRandomValues(new Uint8Array(24)));return {verifier,challenge,state};};
window.createEntry=async extra=>{const p=await pkce();sessionStorage.setItem('pending',JSON.stringify(p));const r=await fetch(ISSUER+'/api/oauth/entries',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:CLIENT,redirectUri:REDIRECT,challenge:p.challenge,challengeMethod:'S256',state:p.state,requests:[],...extra})});return {status:r.status,body:await r.json(),...p};};
window.exchange=async(code,verifier)=>{const r=await fetch(ISSUER+'/oauth/token',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,client_id:CLIENT,redirect_uri:REDIRECT})});return {status:r.status,body:await r.json()};};
document.getElementById('open').onclick=()=>{window.handle=window.open(window.target,'_blank','popup');};
// Islands harness pattern (tests/browser/islands-embed.mjs): the minimal embedder half of the island handshake.
window.islands={};window.mount=(id,part,o={})=>{const nonce=b64(crypto.getRandomValues(new Uint8Array(16))),iframe=document.createElement('iframe');iframe.src=EMBED+'/embed?client='+encodeURIComponent(CLIENT)+'#'+part+'.v1';iframe.name='bindle-island;v=1;n='+nonce+';l=en;cs=light';iframe.title=part;iframe.setAttribute('referrerpolicy','no-referrer');iframe.style.cssText='display:block;border:0;width:'+(o.w??240)+'px;height:'+(o.h??44)+'px';
 const rec={messages:[],loads:0,port:null};iframe.addEventListener('load',()=>{rec.loads++;if(rec.loads>1)return;const ch=new MessageChannel();rec.port=ch.port1;ch.port1.onmessage=async e=>{rec.messages.push(e.data);if(e.data.type==='code'){const p=JSON.parse(sessionStorage.getItem('pending'));window.exchanged=await window.exchange(e.data.code,p.verifier);window.codeMessage=e.data;}};
 iframe.contentWindow.postMessage({v:1,type:'bindle-island-init',nonce,part,version:1,theme:{seq:0,tokens:{}},locale:'en',colorScheme:'light',props:{seq:0}},EMBED,[ch.port2]);});document.getElementById('slot').append(iframe);islands[id]=rec;};
window.prepare=async id=>{const p=await pkce();sessionStorage.setItem('pending',JSON.stringify(p));islands[id].port.postMessage({v:1,type:'prepare',redirectUri:REDIRECT,challenge:p.challenge,state:p.state,requests:[]});};
window.types=id=>islands[id].messages.map(m=>m.type==='flow'?'flow:'+m.phase+(m.outcome?':'+m.outcome:''):m.type);
</script>`;
// Fixture frame on the embed origin (see the frame-initiated test): the shipped frame modules, no island shell.
const frameFixture=`<!doctype html><meta charset="utf-8"><title>Frame</title><button id="signin" type="button">Continue with provider</button><script type="module">
import {openPopup,runPopupFlow} from './bridge.mjs';import {openStore,frameKey} from './keys.mjs';import {embedAPI,createEntry} from './restore.mjs';
const ISSUER=${JSON.stringify(baseURL)},CLIENT=${JSON.stringify(clientId)},PARENT=${JSON.stringify(appOrigin)};
const key=await frameKey(await openStore(),{issuer:ISSUER,clientId:CLIENT}),api=embedAPI({origin:location.origin,key});let prepare=null;
addEventListener('message',e=>{if(e.source===parent&&e.origin===PARENT&&e.data?.type==='prepare')prepare=e.data;});
document.getElementById('signin').onclick=()=>{const popup=openPopup(window);if(!popup||!prepare){parent.postMessage({v:1,type:'flow',phase:'ended',outcome:'unavailable'},PARENT);return;}
 runPopupFlow({win:window,popup,issuer:ISSUER,prepare,createEntry:()=>createEntry({issuer:ISSUER,clientId:CLIENT,key,prepare}),prove:args=>key.embedProof({issuer:ISSUER,...args})}).then(async result=>{
  if(result.outcome!=='completed'){parent.postMessage({v:1,type:'flow',phase:'ended',outcome:result.outcome},PARENT);return;}
  parent.postMessage({v:1,type:'code',code:result.code,state:result.state,iss:result.iss},PARENT);
  try{const value=await api.claim(result.claim);window.credential=typeof value.credential==='string';}catch(error){window.credential=false;window.claimError=error.status;}
  parent.postMessage({v:1,type:'flow',phase:'ended',outcome:'completed'},PARENT);});};
window.makeEntry=()=>createEntry({issuer:ISSUER,clientId:CLIENT,key,prepare:{redirectUri:${JSON.stringify(redirectUri)},challenge:'c'.repeat(43),state:'s'.repeat(32),requests:[]}});
parent.postMessage({v:1,type:'ready'},PARENT);
</script>`;
async function fixture(t,{colorScheme='light',viewport={width:1100,height:860}}={}){
 const context=await browser.newContext({permissions:['local-network-access'],colorScheme,viewport,extraHTTPHeaders:{'CF-Connecting-IP':ip()}});t.after(()=>context.close());
 const errors=[],documents=[];context.on('page',page=>{page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(process.env.ENTRY_DEBUG)console.error('console',page.url(),m.text());if(/Content Security Policy|Refused to/.test(m.text()))errors.push(m.text());});});
 context.on('response',response=>{if(response.url().includes('/oauth/authorize?entry='))documents.push({url:response.url(),coop:response.headers()['cross-origin-opener-policy']??null});});
 await context.route(appOrigin+'/**',route=>{const url=new URL(route.request().url());route.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin-allow-popups'},body:url.pathname==='/callback'?'<!doctype html><title>Callback</title><h1>Callback</h1>':appPage});});
 const first=await signup(context),second=await signup(context);
 const app=await context.newPage();await app.goto(appOrigin+'/');
 return {context,app,first,second,errors,documents};
}
const subject=account=>`${baseURL}/entities/${account.id}`;
const entryFrom=async(app,extra)=>{const created=await app.evaluate(extra=>window.createEntry(extra),extra);assert.equal(created.status,201,JSON.stringify(created.body));return created;};
async function openPopup(f,entryId){await f.app.evaluate(url=>{window.target=url;},`${baseURL}/oauth/authorize?entry=${entryId}`);const popupPromise=f.context.waitForEvent('page');await f.app.click('#open');const popup=await popupPromise;return popup;}
const callbackOf=async page=>{await page.waitForURL(url=>url.href.startsWith(redirectUri),{timeout:15000});return new URL(page.url());};
const tokenSubject=body=>body.subject??body.sub;

test('app-initiated popup: existing per-account sessions, one click, code to the registered callback, nothing disclosed before approval',async t=>{
 const f=await fixture(t),created=await entryFrom(f.app,{intent:'login',presentation:'popup'});
 const requests=[];f.context.on('request',r=>requests.push(r.url()));
 const popup=await openPopup(f,created.body.entryId);
 await popup.locator('.account-row').nth(1).waitFor();assert.equal(f.documents.at(-1).coop,'same-origin','app-opened entries are COOP-isolated');
 for(const account of [f.first,f.second])await popup.getByText(account.handle+'@',{exact:false}).first().waitFor();
 // Before approval: the app received no message, holds no usable handle and saw only its own entry URL.
 assert.deepEqual(await f.app.evaluate(()=>window.msgs),[]);assert.equal(await f.app.evaluate(()=>{try{return window.handle.document?'readable':'none';}catch{return 'blocked';}}),'blocked');
 assert.deepEqual([...new URL(popup.url()).searchParams.keys()],['entry']);assert.equal(await popup.evaluate(()=>window.opener),null);
 assert.equal(requests.filter(u=>u.startsWith(appOrigin)).length,0,'no request reached the app before approval');
 await screenshot(popup,'authorization-entry-chooser');
 // One click in provider UI (Playwright waits for aria-disabled to clear: the delay-to-arm).
 const started=Date.now();await popup.getByRole('button',{name:new RegExp(`Continue as .*${f.second.handle}@`)}).click();
 const callback=await callbackOf(popup);assert.equal(callback.searchParams.get('state'),created.state);assert.equal(callback.searchParams.get('iss'),baseURL);assert.equal(callback.searchParams.get('claim'),null);
 const token=await f.app.evaluate(({code,verifier})=>window.exchange(code,verifier),{code:callback.searchParams.get('code'),verifier:created.verifier});
 assert.equal(token.status,200,JSON.stringify(token.body));assert.equal(tokenSubject(token.body),subject(f.second),'the chosen account, not the default one');
 assert.ok(Date.now()-started<15000);assert.deepEqual(f.errors,[]);
});

test('redirect fallback: the same chooser at top level returns to the registered callback; cancel returns a generic denial',async t=>{
 const f=await fixture(t,{colorScheme:'dark',viewport:{width:390,height:844}}),created=await entryFrom(f.app,{intent:'select-account',presentation:'redirect'});
 await f.app.goto(`${baseURL}/oauth/authorize?entry=${created.body.entryId}`);await f.app.locator('.account-row').nth(1).waitFor();
 assert.match(await f.app.locator('h1').innerText(),/Choose an account for \u2068?Independent fixture app/);
 assert.equal(await f.app.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no horizontal scroll at phone width');
 await screenshot(f.app,'authorization-entry-redirect-dark-mobile');
 await f.app.getByRole('button',{name:new RegExp(`Continue as .*${f.first.handle}@`)}).click();
 const callback=await callbackOf(f.app);assert.equal(callback.searchParams.get('state'),created.state);
 await f.app.goto(appOrigin+'/');const token=await f.app.evaluate(({code,verifier})=>window.exchange(code,verifier),{code:callback.searchParams.get('code'),verifier:created.verifier});assert.equal(token.status,200,JSON.stringify(token.body));assert.equal(tokenSubject(token.body),subject(f.first));
 const denied=await entryFrom(f.app,{intent:'login',presentation:'redirect'});await f.app.goto(`${baseURL}/oauth/authorize?entry=${denied.body.entryId}`);await f.app.locator('.account-row').first().waitFor();
 await f.app.getByRole('button',{name:'Cancel',exact:true}).click();const back=await callbackOf(f.app);
 assert.deepEqual(Object.fromEntries(back.searchParams),{error:'access_denied',state:denied.state,iss:baseURL});assert.deepEqual(f.errors,[]);
});

test('reauthenticate honours maxAge: a stale session needs a fresh sign-in, then continues only as the requested account',async t=>{
 const f=await fixture(t),maxAge=6;await sleep((maxAge+1)*1000);
 const created=await entryFrom(f.app,{intent:'reauthenticate',presentation:'popup',subjectConstraint:subject(f.first),maxAge});
 const popup=await openPopup(f,created.body.entryId);await popup.locator('.account-row').first().waitFor();
 assert.equal(await popup.locator('.account-row').count(),1,'only the requested account');assert.equal(await popup.getByText(f.second.handle+'@').count(),0);
 await popup.getByRole('button',{name:/Continue as/}).click();await popup.locator('main[data-phase="reauth"]').waitFor();
 assert.match(await popup.locator('main').innerText(),/sign in again as/);
 const consolePromise=f.context.waitForEvent('page');await popup.getByRole('link',{name:'Sign in again'}).click();const consoleTab=await consolePromise;
 await consoleTab.waitForLoadState();assert.match(consoleTab.url(),/\/console\?signin$/);assert.equal(await consoleTab.evaluate(()=>window.opener),null,'the sign-in tab has no opener');await consoleTab.close();
 // A fresh credential proof for the same owner replaces its member session; the entry page re-reads the inventory.
 await login(f.context,f.first.handle);await popup.bringToFront();await popup.getByRole('button',{name:'Check again'}).click();await popup.getByText('Updated the accounts').waitFor();
 await popup.getByRole('button',{name:/signed in again, continue/}).click();
 const callback=await callbackOf(popup);const token=await f.app.evaluate(({code,verifier})=>window.exchange(code,verifier),{code:callback.searchParams.get('code'),verifier:created.verifier});
 assert.equal(token.status,200,JSON.stringify(token.body));assert.equal(tokenSubject(token.body),subject(f.first));assert.deepEqual(f.errors,[]);
});

test('end-session: explicit confirmation naming the account ends only that account in this browser; completed/canceled only',async t=>{
 const f=await fixture(t);
 const manifest=await(await f.context.request.get(baseURL+'/.well-known/bindle/manifest.json')).json();assert.equal(manifest.features['authorization-entry.v1'].intents.includes('end-session'),true,'the Worker mounts the session-ending hook');
 const kept=await entryFrom(f.app,{intent:'end-session',presentation:'redirect',subjectConstraint:subject(f.first)});
 await f.app.goto(`${baseURL}/oauth/authorize?entry=${kept.body.entryId}`);await f.app.getByRole('button',{name:'Stay signed in'}).click();
 const canceled=await callbackOf(f.app);assert.deepEqual(Object.fromEntries(canceled.searchParams),{result:'canceled',state:kept.state,iss:baseURL});
 await f.app.goto(appOrigin+'/'); const created=await entryFrom(f.app,{intent:'end-session',presentation:'redirect',subjectConstraint:subject(f.first)}),posted=[];
 f.context.on('request',request=>{if(request.url().endsWith('/end-session'))posted.push({body:request.postDataJSON(),headers:request.headers()});});
 await f.app.goto(`${baseURL}/oauth/authorize?entry=${created.body.entryId}`);await f.app.getByText(f.first.handle+'@').first().waitFor();
 const text=await f.app.locator('main').innerText();assert.match(await f.app.locator('h1').innerText(),new RegExp(`Sign out .*${f.first.handle}@`));assert.match(text,/Other accounts on this browser/);assert.equal(text.includes(f.second.handle),false,'other accounts are not shown');
 await screenshot(f.app,'authorization-entry-end-session');
 await f.app.getByRole('button',{name:'Sign out'}).click();const done=await callbackOf(f.app);assert.deepEqual(Object.fromEntries(done.searchParams),{result:'completed',state:created.state,iss:baseURL});
 assert.equal(posted[0].body.confirmed,true);assert.equal(posted[0].headers['x-bindle-account'],f.first.id);assert.ok(posted[0].headers['x-csrf-token'],'the member CSRF');assert.match(posted[0].headers['x-bindle-entry-token'],/^[A-Za-z0-9_-]{43}$/);
 // Only the named account left this browser: the other account stays signed in.
 const inventory=await(await f.context.request.get(baseURL+'/api/auth/accounts',{headers:{Origin:baseURL}})).json(),accounts=inventory.accounts.map(a=>a.account.id);
 assert.equal(accounts.includes(f.first.id),false);assert.equal(accounts.includes(f.second.id),true);assert.deepEqual(f.errors,[]);
});

test('frame-initiated popup: the real embed bridge and keys attest the opener; delivery reaches only the embed origin',async t=>{
 const f=await fixture(t);
 const manifest=await(await f.context.request.get(baseURL+'/.well-known/bindle/manifest.json')).json(),profile=manifest.profiles?.['https://3sln.me/artefacts/profiles/components/v1'];
 if(!profile){t.skip('islands shell not built: no components profile to discover the embed origin');return;}assert.equal(profile.embed_origin,embedOrigin);
 // The islands shell refuses a non-HTTPS issuer (apps/embed/src/boot.mjs readConfig), so the frame here is a fixture
 // document on the real embed origin that runs the shipped frame modules: bridge.mjs (unnamed popup, exact-origin
 // handshake), keys.mjs (non-extractable key, embed proofs) and restore.mjs (entry creation, claim redemption).
 await f.context.route(`${embedOrigin}/__fixture/**`,async route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/__fixture/frame')return route.fulfill({contentType:'text/html',body:frameFixture});
  const file={'/__fixture/bridge.mjs':'apps/embed/src/bridge.mjs','/__fixture/keys.mjs':'apps/embed/src/keys.mjs','/__fixture/restore.mjs':'apps/embed/src/restore.mjs'}[path];
  return file?route.fulfill({contentType:'text/javascript',body:await readFile(file,'utf8')}):route.fulfill({status:404,body:''});});
 await f.app.evaluate(src=>{window.frameMsgs=[];addEventListener('message',async e=>{if(e.origin!==new URL(src).origin)return;window.frameMsgs.push(e.data);if(e.data?.type==='code'){const p=JSON.parse(sessionStorage.getItem('pending'));window.codeMessage=e.data;window.exchanged=await window.exchange(e.data.code,p.verifier);}});
  const iframe=document.createElement('iframe');iframe.src=src;iframe.id='frame';iframe.style.cssText='width:260px;height:60px;border:0';document.getElementById('slot').append(iframe);},`${embedOrigin}/__fixture/frame`);
 await f.app.waitForFunction(()=>window.frameMsgs.some(m=>m.type==='ready'),null,{timeout:10000});
 await f.app.evaluate(async()=>{const p=await window.pkce();sessionStorage.setItem('pending',JSON.stringify(p));document.getElementById('frame').contentWindow.postMessage({v:1,type:'prepare',redirectUri:REDIRECT,challenge:p.challenge,state:p.state,requests:[]},EMBED);});
 const frame=await(await f.app.$('#frame')).contentFrame(),popupPromise=f.context.waitForEvent('page',{timeout:10000});
 await frame.click('#signin');const popup=await popupPromise;
 await popup.locator('.account-row').first().waitFor({timeout:10000});
 assert.equal(f.documents.at(-1).coop,'unsafe-none','the embed popup document keeps its opener');assert.equal(new URL(popup.url()).searchParams.get('mode'),null,'attested, not plain');
 assert.equal(await popup.evaluate(()=>window.name),'','the popup is never named');
 assert.deepEqual(f.app.isClosed(),false);assert.equal((await f.app.evaluate(()=>window.msgs)).filter(m=>String(m.type).startsWith('bindle-embed')).length,0,'the app window never sees bridge messages');
 assert.deepEqual(await f.app.evaluate(()=>window.frameMsgs.map(m=>m.type)),['ready'],'nothing reaches the app before approval');
 await popup.getByRole('button',{name:new RegExp(`Continue as .*${f.first.handle}@`)}).click();
 await f.app.waitForFunction(()=>window.exchanged,null,{timeout:15000});const exchanged=await f.app.evaluate(()=>window.exchanged);
 assert.equal(exchanged.status,200,JSON.stringify(exchanged.body));assert.equal(tokenSubject(exchanged.body),subject(f.first));
 assert.deepEqual(Object.keys(await f.app.evaluate(()=>window.codeMessage)).sort(),['code','iss','state','type','v'],'the app gets only {code,state,iss}, never the claim');
 if(!popup.isClosed())await popup.waitForEvent('close',{timeout:5000});assert.equal(popup.isClosed(),true,'acknowledged: the popup closed itself');
 await f.app.waitForFunction(()=>window.frameMsgs.some(m=>m.type==='flow'),null,{timeout:10000});assert.equal(await frame.evaluate(()=>window.credential),true,'the frame redeemed its key-bound claim');
 assert.equal((await f.app.evaluate(()=>window.msgs)).filter(m=>String(m.type).startsWith('bindle-embed')).length,0);
 // The same kind of embed entry opened by the app itself: its hello is dropped by targetOrigin, so the page replaces
 // itself with the COOP-isolated plain page; the code can only reach the registered callback, with no claim.
 // The entry is bound to the frame's real key (cookieless CORS creation from the embed origin), as if the app learned its ID.
 const leaked=await frame.evaluate(()=>window.makeEntry());assert.match(leaked,/^[A-Za-z0-9_-]{43}$/);const own=await openPopup(f,leaked);
 await own.waitForURL(/mode=plain/,{timeout:10000});await own.locator('.account-row').first().waitFor();assert.equal(f.documents.at(-1).coop,'same-origin');
 assert.equal((await f.app.evaluate(()=>window.msgs)).filter(m=>String(m.type).startsWith('bindle-embed')).length,0);
 await own.getByRole('button',{name:new RegExp(`Continue as .*${f.first.handle}@`)}).click();const callback=await callbackOf(own);assert.ok(callback.searchParams.get('code'));assert.equal(callback.searchParams.get('claim'),null);
 assert.deepEqual(f.errors,[]);
});
