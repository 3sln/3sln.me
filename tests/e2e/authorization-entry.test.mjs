// Real browser against the local Worker with FEDERATION_ENTRY_ENABLED and a loopback embed origin (the runner sets
// E2E_AUTHORIZATION_ENTRIES=1). The provider UI for entries is not built yet, so the owner steps run as same-origin
// fetches from the real entry document; everything else (CORS creation, document policy, member cookies, PKCE code
// exchange, manifest truthfulness and the embed origin) uses real browser networking. Fixture app: .example origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import {launch,baseURL} from './browser.mjs';
const appOrigin='https://bindle-client.example',clientId=appOrigin+'/client',redirectUri=appOrigin+'/callback',embedOrigin=baseURL.replace('localhost','127.0.0.1');

test('authorization entry: cookieless creation, strict entry document, owner selection through member cookies and a PKCE code',async t=>{
 const browser=await launch();t.after(()=>browser.close());
 const context=await browser.newContext({permissions:['local-network-access'],extraHTTPHeaders:{'CF-Connecting-IP':`198.51.100.${40+Math.floor(Math.random()*150)}`}});
 const config=await(await context.request.get(baseURL+'/api/config')).json(),post=(path,data)=>context.request.post(baseURL+path,{headers:{Origin:baseURL},data});
 const signup=await(await post('/api/auth/signup',{method:'password',password:'Authorization entry browser password!',termsAccepted:true,termsVersion:config.termsVersion,turnstileToken:'local-browser-test-token'})).json();assert.ok(signup.pendingToken,JSON.stringify(signup));
 const file=await(await post('/api/auth/recovery/download',{pendingToken:signup.pendingToken})).json();assert.equal((await post('/api/auth/recovery/confirm',{pendingToken:signup.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true})).status(),200);
 // F8: the entry feature is advertised because the routes are mounted; the components profile because the islands shell
 // is built, the embed routes are mounted and DPoP is configured (a loopback embed origin only under LOCAL_DEVELOPMENT).
 const manifest=await(await context.request.get(baseURL+'/.well-known/bindle/manifest.json')).json();
 assert.deepEqual(manifest.features['authorization-entry.v1'],{endpoint:baseURL+'/api/oauth/entries',intents:['login','select-account','reauthenticate','end-session']});assert.deepEqual(manifest.profiles,{'https://3sln.me/artefacts/profiles/components/v1':{embed_origin:embedOrigin,protocol:[1],parts:{avatar:{versions:[1]},'account-switcher':{versions:[1]},'sign-in':{versions:[1]}},credential_binding:['key-binding.v1']}});
 await context.route(appOrigin+'/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Independent fixture app</title><h1>Fixture app</h1>'}));
 const app=await context.newPage();const errors=[];app.on('pageerror',error=>errors.push(error.message));await app.goto(appOrigin+'/');
 const created=await app.evaluate(async({baseURL,clientId,redirectUri})=>{
  const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const verifier=b64(crypto.getRandomValues(new Uint8Array(48))),challenge=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))),state=b64(crypto.getRandomValues(new Uint8Array(24)));
  const response=await fetch(baseURL+'/api/oauth/entries',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId,redirectUri,challenge,challengeMethod:'S256',state,intent:'login',requests:[],presentation:'redirect'})});
  return {status:response.status,body:await response.json(),verifier,state};
 },{baseURL,clientId,redirectUri});
 assert.equal(created.status,201,JSON.stringify(created.body));const entryId=created.body.entryId;assert.match(entryId,/^[A-Za-z0-9_-]{43}$/);
 // The static entry document: its own strict CSP survives the root page hardening (F7), with only the import-map hash added.
 const provider=await context.newPage(),violations=[];provider.on('console',message=>{if(/Content Security Policy|Refused to/.test(message.text()))violations.push(message.text());});provider.on('pageerror',error=>errors.push(error.message));
 const documentResponse=await provider.goto(`${baseURL}/oauth/authorize?entry=${entryId}`);assert.equal(documentResponse.status(),200);
 const headers=documentResponse.headers(),csp=headers['content-security-policy'];
 assert.match(csp,/frame-src 'none'/);assert.match(csp,/frame-ancestors 'none'/);assert.match(csp,/script-src 'self' 'sha256-[A-Za-z0-9+/]{43}='/);assert.equal(csp.includes('challenges.cloudflare.com'),false);
 assert.equal(headers['cross-origin-opener-policy'],'same-origin');assert.equal(headers['cache-control'],'no-store');
 await provider.waitForLoadState('networkidle');
 // Owner steps from the provider document, as its UI will: same-origin fetches with the tab's member selector.
 const outcome=await provider.evaluate(async entryId=>{
  const session=await(await fetch('/api/session')).json(),member={'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'};
  const viewed=await fetch('/api/oauth/entries/'+entryId),view=await viewed.json();if(!viewed.ok)return {step:'view',status:viewed.status,view};
  // Without the page token from the view, the browser's own same-origin request is refused.
  const tokenless=await fetch(`/api/oauth/entries/${entryId}/select`,{method:'POST',headers:member,body:JSON.stringify({nonce:view.entry.nonce})});if(tokenless.status!==403)return {step:'tokenless',status:tokenless.status};
  member['X-Bindle-Entry-Token']=view.pageToken;
  const selected=await fetch(`/api/oauth/entries/${entryId}/select`,{method:'POST',headers:member,body:JSON.stringify({nonce:view.entry.nonce})}),selection=await selected.json();if(!selected.ok)return {step:'select',status:selected.status,selection};
  const inspected=await fetch('/api/oauth/requests/'+selection.requestId);if(!inspected.ok)return {step:'inspect',status:inspected.status,body:await inspected.json()};
  const decided=await fetch(`/api/oauth/entries/${entryId}/decision`,{method:'POST',headers:member,body:JSON.stringify({nonce:view.entry.nonce,approved:[]})});return {step:'decision',status:decided.status,result:await decided.json(),client:view.entry.client,intent:view.entry.intent};
 },entryId);
 assert.equal(outcome.step,'decision',JSON.stringify(outcome));assert.equal(outcome.status,200,JSON.stringify(outcome));assert.equal(outcome.client.id,clientId);assert.equal(outcome.intent,'login');
 const callback=new URL(outcome.result.redirectUri);assert.equal(callback.origin+callback.pathname,redirectUri);assert.equal(callback.searchParams.get('state'),created.state);assert.ok(callback.searchParams.get('code'));assert.equal(outcome.result.claim,undefined,'plain entries never carry an embed claim');
 // The app redeems the code with its PKCE verifier from its own origin.
 const token=await app.evaluate(async({baseURL,clientId,redirectUri,code,verifier})=>{const response=await fetch(baseURL+'/oauth/token',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,client_id:clientId,redirect_uri:redirectUri})});return {status:response.status,body:await response.json()};},{baseURL,clientId,redirectUri,code:callback.searchParams.get('code'),verifier:created.verifier});
 assert.equal(token.status,200,JSON.stringify(token.body));assert.ok(token.body.access_token);assert.match(token.body.subject??token.body.sub??JSON.stringify(token.body),/entities\//);
 // The entry is single-use and a replayed decision cannot mint another code.
 const replay=await provider.evaluate(async entryId=>(await fetch('/api/oauth/entries/'+entryId)).status,entryId);assert.equal(replay,400);
 assert.deepEqual(violations,[]);assert.deepEqual(errors,[]);
});

test('embed origin over real browser networking: inert shell for unknown clients, per-client frame-ancestors, no cookies, app routes absent',async t=>{
 const browser=await launch();t.after(()=>browser.close());const context=await browser.newContext({permissions:['local-network-access'],extraHTTPHeaders:{'CF-Connecting-IP':`198.51.100.${40+Math.floor(Math.random()*150)}`}});
 const known=await context.request.get(`${embedOrigin}/embed?client=${encodeURIComponent(clientId)}`);assert.equal(known.status(),200);
 assert.match(known.headers()['content-security-policy'],new RegExp(`frame-ancestors ${appOrigin.replaceAll('.','\\.')}`));assert.equal(known.headers()['set-cookie'],undefined);assert.equal(known.headers()['x-frame-options'],undefined);
 const unknown=await context.request.get(`${embedOrigin}/embed?client=${encodeURIComponent('https://unknown.example/client')}`);assert.match(unknown.headers()['content-security-policy'],/frame-ancestors 'none'/);assert.equal(await unknown.text(),'<!doctype html><meta charset="utf-8"><title></title>');
 for(const path of ['/console','/api/session','/.well-known/bindle/manifest.json','/oauth/authorize'])assert.equal((await context.request.get(embedOrigin+path)).status(),404,path);
 // A cross-site page cannot use the embed API: Fetch Metadata gate, no CORS.
 const island=`${embedOrigin}/embed?client=${encodeURIComponent(clientId)}`;await context.route(appOrigin+'/**',route=>route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname==='/frame'?`<!doctype html><title>Fixture</title><iframe id="island" src="${island}"></iframe>`:'<!doctype html><title>Fixture</title>'}));const page=await context.newPage();await page.goto(appOrigin+'/');
 const blocked=await page.evaluate(async url=>{try{const response=await fetch(url,{method:'POST',headers:{'X-Bindle-Embed':'1'}});return response.status;}catch{return 'blocked';}},embedOrigin+'/embed/api/nonce');assert.equal(blocked,'blocked');
 // Framing the shell from the registered app origin is permitted by frame-ancestors (inert here: no element handshake).
 const framed=page.waitForResponse(response=>response.url()===island);await page.goto(appOrigin+'/frame');assert.equal((await framed).status(),200);const frame=await(await page.$('#island')).contentFrame();await frame.waitForLoadState();assert.equal(frame.url(),island);assert.equal(await frame.evaluate(()=>document.title),'');
});
