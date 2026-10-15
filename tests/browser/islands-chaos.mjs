// Island sign-in chaos (Chromium) against the real local Worker. The harness below is the islands-embed.mjs harness
// (tests/browser/islands-embed.mjs: Worker start-up, origin forwarding, the real SDK elements page and the provider
// popup stand-in), copied so these fault cases run independently; the only addition is a fault hook that holds or
// fails a chosen provider request. Controls are activated with a trusted keyboard press, which the island accepts
// without the pointer-hover arming delay, so no fixed sleeps are needed. Run: node --test tests/browser/islands-chaos.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve,extname} from 'node:path';
import {randomBytes,webcrypto} from 'node:crypto';
import {chromium,firefox,webkit} from 'playwright';

const ISSUER='https://provider.example',EMBED='https://embed.provider.example',APP='https://app.example',CLIENT=APP+'/client',sleep=ms=>new Promise(r=>setTimeout(r,ms));
const AVATAR_URL=ISSUER+'/branding/3sln-avatar.png';
async function freePort(){const server=createServer();await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});const {port}=server.address();await new Promise(ok=>server.close(ok));return port;}
/** Forwards one request to the Worker with the fixture host; returns status, headers (Set-Cookie kept per line) and body. */
function forwardTo(port,{method,url,headers,body}){
  const target=new URL(url);
  return new Promise((ok,fail)=>{const req=httpRequest({host:'127.0.0.1',port,method,path:target.pathname+target.search,headers:{...headers,host:target.host}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>ok({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',fail);});req.on('error',fail);if(body)req.write(body);req.end();});
}
async function startWorker(){
  const port=await freePort(),directory=await mkdtemp(resolve(await mkdir('.output',{recursive:true}).then(()=>'.output'),'islands-e2e-')),persistence=await mkdtemp(`${tmpdir()}/3sln-islands-state-`);
  const config=JSON.parse(await readFile('wrangler.local.jsonc','utf8'));config.main=resolve(config.main);config.assets.directory=resolve(config.assets.directory);delete config.$schema;
  Object.assign(config.vars,{APP_ORIGIN:ISSUER,RP_ID:'provider.example',EMBED_ORIGIN:EMBED,FEDERATION_ENABLED:'true',FEDERATION_ENTRY_ENABLED:'true',
    FEDERATION_CLIENTS:JSON.stringify([{id:CLIENT,name:'Islands fixture app',origin:APP,redirectUris:[APP+'/callback']}]),
    SIGNUP_SUBNET_DAILY_LIMIT:'500',SIGNUP_REGION_HOURLY_LIMIT:'500',SIGNUP_REGION_DAILY_LIMIT:'500',SIGNUP_GLOBAL_HOURLY_LIMIT:'500',SIGNUP_GLOBAL_DAILY_LIMIT:'500'});
  const recovery=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  await writeFile(resolve(directory,'wrangler.json'),JSON.stringify(config));
  await writeFile(resolve(directory,'.dev.vars'),`KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nSESSION_COOKIE_KEY=${randomBytes(32).toString('base64url')}\nRECOVERY_SIGNING_KEY=${JSON.stringify({kid:webcrypto.randomUUID(),privateJWK:await webcrypto.subtle.exportKey('jwk',recovery.privateKey)})}\n`,{mode:0o600});
  const worker=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--config',resolve(directory,'wrangler.json'),'--port',String(port),'--upstream-protocol','https','--persist-to',persistence],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(directory,'wrangler.log')}});
  let logs='';for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{logs+=chunk;});
  const stop=async()=>{worker.kill('SIGTERM');await new Promise(ok=>{if(worker.exitCode!==null)return ok();worker.once('exit',ok);setTimeout(ok,5000).unref();});await rm(persistence,{recursive:true,force:true});await rm(directory,{recursive:true,force:true});};
  for(let i=0;i<120;i++){if(worker.exitCode!==null)break;try{const r=await forwardTo(port,{method:'GET',url:ISSUER+'/api/config',headers:{}});if(r.status===200&&JSON.parse(r.body).origin===ISSUER)return {port,stop,logs:()=>logs};}catch{}await sleep(500);}
  await stop();throw new Error('Wrangler did not become ready:\n'+logs.slice(-2000));
}

const elementsPage=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Fixture app (elements)</title><body style="margin:1rem">
<script type="module">import '/packages/sdk/src/define.mjs';window.events=[];for(const type of ['bindle-session-change','bindle-sign-in-start','bindle-sign-in-end','bindle-account-change','bindle-account-change-failed','bindle-menu-toggle'])document.addEventListener(type,e=>window.events.push({type,detail:JSON.parse(JSON.stringify(e.detail??null))}));window.sdkReady=true;</script>
<bindle-session client-id="${CLIENT}" redirect-uri="${APP}/callback" default-host="provider.example"><bindle-account actions="switch sign-out manage"><bindle-sign-in slot="signed-out"></bindle-sign-in></bindle-account></bindle-session></body></html>`;
const popupPage=`<!doctype html><meta charset="utf-8"><title>Provider</title><script>
(async()=>{const EMBED=${JSON.stringify(EMBED)},entry=new URL(location.href).searchParams.get('entry');window.log=[];window.hasOpener=!!window.opener;window.nameAtLoad=window.name;
 const post=(p,b,h={})=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json',...h},body:JSON.stringify(b)}).then(r=>r.json());
 addEventListener('message',async e=>{log.push({origin:e.origin,type:e.data&&e.data.type,fromOpener:e.source===window.opener});if(e.origin!==EMBED||e.source!==window.opener)return;
  if(e.data.type==='bindle-embed-proof'){const {pageSecret}=await post('/oauth/entries/'+entry+'/embed-verify',{proof:e.data.proof},page);
   const session=await(await fetch('/api/session')).json(),member={'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext,'X-CSRF-Token':session.csrfToken};
   const view=await(await fetch('/api/oauth/entries/'+entry)).json(),selection=await post('/api/oauth/entries/'+entry+'/select',{nonce:view.entry.nonce,pageSecret},{...member,...page});await fetch('/api/oauth/requests/'+selection.requestId);
   const r=await post('/api/oauth/entries/'+entry+'/decision',{nonce:view.entry.nonce,pageSecret,approved:[]},{...member,...page});window.decision=r;
   window.opener.postMessage({v:1,type:'bindle-embed-done',entry,code:r.code,state:r.state,iss:r.iss,claim:r.claim},EMBED);}
  if(e.data.type==='bindle-embed-ack'){window.acked=true;}});
 // Every page mutation carries the entry's page token from its view.
 const first=await(await fetch('/api/oauth/entries/'+entry)).json(),page=first.pageToken?{'X-Bindle-Entry-Token':first.pageToken}:{};
 const {challenge}=await post('/oauth/entries/'+entry+'/embed-challenge',{},page);
 if(window.opener)window.opener.postMessage({v:1,type:'bindle-embed-hello',entry,challenge},EMBED);})();
</script>`;
// The fixture first opens the app root; these cases then use the real elements page.
const appPage='<!doctype html><meta charset="utf-8"><title>Fixture app</title>';
const instrument=()=>{};
async function disabledFeatures(){const b=await chromium.launch({args:['--enable-automation']}),c=await b.newBrowserCDPSession(),{arguments:a}=await c.send('Browser.getBrowserCommandLine');await b.close();return a.find(x=>x.startsWith('--disable-features=')).slice(19);}
async function launch(name){
  if(name==='chromium'){const df=await disabledFeatures();return chromium.launch({args:['--enable-features=ThirdPartyStoragePartitioning',`--disable-features=${df.split(',').filter(x=>x!=='ThirdPartyStoragePartitioning').join(',')}`],ignoreDefaultArgs:[`--disable-features=${df}`]});}
  if(name==='firefox')return firefox.launch({firefoxUserPrefs:{'network.cookie.cookieBehavior':5}});
  const browser=await webkit.launch();const probe=await Promise.race([browser.newPage().then(p=>p.close().then(()=>'ok')),sleep(15000).then(()=>'hang')]);if(probe!=='ok'){browser.close().catch(()=>{});throw new Error('WebKit newPage() hangs in this environment');}return browser;
}

async function fixture(t,name,faults){
  let browser;try{browser=await launch(name);}catch(error){t.skip(`${name} unavailable: ${error.message.split('\n')[0]}`);return null;}
  t.after(()=>browser.close());
  const log=[],errors=[],remote=`198.51.100.${190+(++fixtures)}`;
  // Playwright cannot route a service worker's script fetch, so registration of /embed/sw.js would reach the real
  // network for the .example host. Service workers are blocked here; their headers are checked against the Worker below.
  const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});await context.addInitScript(instrument);if(process.env.ISLANDS_DEBUG)context.on('console',m=>console.error('ctx',m.type(),m.text()));
  // Playwright route interception does not expose every browser-set Sec-Fetch-* header, so the harness fills absent ones
  // for the two provider origins: same-origin when Origin is the target origin, or for a GET without Origin whose Referer
  // (if any) is on that origin. Test-only emulation of Fetch Metadata; browser-provided values are kept.
  const metadata=(url,headers)=>{if(headers['sec-fetch-site']||![ISSUER,EMBED].includes(url.origin))return {};const same=headers.origin===url.origin||headers.origin==='null'&&url.origin===EMBED||!headers.origin&&(!headers.referer||headers.referer.startsWith(url.origin+'/'));return same?{'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty'}:{'sec-fetch-site':'cross-site','sec-fetch-mode':'cors','sec-fetch-dest':'empty'};};
  const forward=async(route,headers)=>{const request=route.request();
    const response=await forwardTo(worker.port,{method:request.method(),url:request.url(),headers:{...Object.fromEntries(Object.entries(headers).filter(([k])=>!k.startsWith(':')&&!['host','accept-encoding','connection','content-length'].includes(k))),'cf-connecting-ip':remote},body:['GET','HEAD'].includes(request.method())?undefined:request.postDataBuffer()});
    const out={};for(const [k,v] of Object.entries(response.headers))if(!['connection','keep-alive','transfer-encoding','content-length'].includes(k))out[k]=Array.isArray(v)?v.join('\n'):v;
    return {status:response.status,headers:out,body:response.body};};
  // The route handler outlives a closed browser for long-lived requests (the leader's NDJSON stream, which this
  // buffering forwarder can only deliver when the Worker ends it), so late failures are dropped, never unhandled.
  await context.route('**/*',route=>handle(route).catch(()=>route.abort().catch(()=>{})));
  const handle=async route=>{
    const request=route.request(),url=new URL(request.url()),raw=await request.allHeaders(),headers={...raw,...metadata(url,raw)};
    const entry={method:request.method(),url:url.href,headers};log.push(entry);
    if(url.origin===APP){
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin-allow-popups'},body:appPage});
      if(url.pathname==='/elements')return route.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin-allow-popups'},body:elementsPage});
      // The real @3sln/bindle elements, served from this checkout.
      if(/^\/(?:packages\/sdk\/src|packages\/i18n|vendor\/dodo)\//.test(url.pathname)&&!url.pathname.includes('..'))return route.fulfill({contentType:['.mjs','.js'].includes(extname(url.pathname))?'text/javascript':'text/plain',body:await readFile(resolve('.'+url.pathname))});
      return route.fulfill({status:404,body:''});
    }
    if(url.origin===ISSUER&&url.pathname==='/oauth/authorize'&&url.searchParams.has('entry'))return route.fulfill({contentType:'text/html',headers:{'Referrer-Policy':'no-referrer'},body:popupPage});
    if(url.origin===ISSUER&&url.pathname==='/test/blank')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Provider fixture</title>'});
    const fault=faults.find(entry=>entry.method===request.method()&&entry.test(url));if(fault){faults.splice(faults.indexOf(fault),1);fault.seen?.();if(fault.kind==='hold')return new Promise(()=>{});return route.fulfill({status:fault.kind,contentType:'application/json',body:JSON.stringify({error:'temporarily_unavailable'})});}
    if(url.origin===ISSUER||url.origin===EMBED){const response=await forward(route,headers);entry.status=response.status;if(process.env.ISLANDS_DEBUG&&url.pathname.startsWith('/embed/api/'))console.error('api',request.method(),url.pathname,response.status,String(response.body).slice(0,300));return route.fulfill(response);}
    return route.abort();
  };
  // A real provider account (password signup plus recovery confirmation) with a display name and an avatar served from
  // the provider's own static assets.
  const provider=await context.newPage();await provider.goto(ISSUER+'/test/blank');
  const account=await provider.evaluate(async avatar=>{
    const post=(path,body,headers={})=>fetch(path,{method:path==='/api/profile'?'PUT':'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}).then(async r=>{const text=await r.text();try{return {status:r.status,body:JSON.parse(text)};}catch{return {status:r.status,body:{text:text.slice(0,300),path}};}});
    const config=await(await fetch('/api/config')).json();
    const signup=await post('/api/auth/signup',{method:'password',password:'Islands browser fixture password!',termsAccepted:true,termsVersion:config.termsVersion,turnstileToken:'local-browser-test-token'});if(!signup.body.pendingToken)return {error:signup};
    const file=await post('/api/auth/recovery/download',{pendingToken:signup.body.pendingToken});const confirmed=await post('/api/auth/recovery/confirm',{pendingToken:signup.body.pendingToken,recoveryToken:file.body.recoveryToken,downloadConfirmed:true});if(confirmed.status!==200)return {error:confirmed};
    const session=await(await fetch('/api/session')).json(),member={'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext,'X-CSRF-Token':session.csrfToken};
    const profile=await post('/api/profile',{displayName:'Display alex',bio:'',avatar,discloseToContacts:false},member);if(profile.status!==200)return {error:profile};
    return {id:session.account.id,handle:session.account.handle};
  },AVATAR_URL);
  assert.ok(account.id,JSON.stringify(account));await provider.close();
  const open=async()=>{const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));if(process.env.ISLANDS_DEBUG){page.on('console',m=>console.error('console',m.type(),m.text()));page.on('worker',w=>{console.error('worker',w.url());});}page.on('dialog',d=>{errors.push('dialog '+d.type());d.dismiss();});page.on('download',()=>errors.push('download'));await page.goto(APP+'/');return page;};
  return {browser,context,log,errors,open,name,account,subject:`${ISSUER}/entities/${account.id}`,sessionCalls:()=>log.filter(e=>e.method==='POST'&&e.url===`${EMBED}/embed/api/session`).length};
}

let worker=null,fixtures=0;
test.before(async()=>{worker=await startWorker();},{timeout:90000});
test.after(async()=>{await worker?.stop();});
const islandFrame=(page,part)=>page.frames().find(frame=>frame.url().startsWith(EMBED+'/embed?')&&frame.url().endsWith(`#${part}.v1`));
// The islands' CSP forbids eval inside the frame; conditions are re-read with evaluate until a bound.
async function until(frame,predicate,arg,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await frame.evaluate(predicate,arg).catch(()=>false))return;await sleep(50);}throw new Error('until: timed out');}
async function signInPage(t,faults){
  const f=await fixture(t,'chromium',faults);const page=await f.open();await page.goto(APP+'/elements');
  await page.waitForFunction(()=>document.querySelector('bindle-sign-in')?.state.islands==='live',null,{timeout:10000});
  const frame=islandFrame(page,'sign-in');await until(frame,()=>document.documentElement.dataset.part==='sign-in');
  const ends=()=>page.evaluate(()=>window.events.filter(e=>e.type==='bindle-sign-in-end').map(e=>e.detail.outcome));
  const press=async(times=1)=>{await frame.locator('button.signin').focus();for(let i=0;i<times;i++)await frame.locator('button.signin').press('Enter');};
  const busy=()=>frame.locator('button.signin').getAttribute('aria-busy');
  return {f,page,frame,ends,press,busy};
}
const held=()=>{let seen;const promise=new Promise(r=>{seen=r;});return {promise,seen};};

test('island sign-in: a double activation opens one popup, closing it mid-flow ends once as canceled, and a retry completes',{timeout:120000},async t=>{
  const verify=held(),faults=[{method:'POST',kind:'hold',test:url=>url.origin===ISSUER&&/^\/oauth\/entries\/[^/]+\/embed-verify$/.test(url.pathname),seen:verify.seen}];
  const s=await signInPage(t,faults);if(!s.f)return;const {f,page}=s;
  const popups=[];f.context.on('page',p=>{if(p!==page)popups.push(p);});
  await s.press(2);await verify.promise;assert.equal(popups.length,1,'one popup for a double activation');assert.equal(await s.busy(),'true');
  // The person closes the provider window while it is still working.
  await popups[0].close();await page.waitForFunction(()=>window.events.some(e=>e.type==='bindle-sign-in-end'),null,{timeout:10000});
  assert.deepEqual(await s.ends(),['canceled']);await until(s.frame,()=>document.querySelector('button.signin')?.getAttribute('aria-busy')==='false');
  assert.equal(await page.evaluate(()=>window.events.some(e=>e.type==='bindle-session-change'&&e.detail?.signedIn)),false,'no session from a canceled flow');
  await s.press();await page.waitForFunction(()=>window.events.filter(e=>e.type==='bindle-sign-in-end').length===2,null,{timeout:20000});
  assert.deepEqual(await s.ends(),['canceled','completed']);assert.equal(popups.length,2);assert.deepEqual(f.errors,[]);
});

test('island sign-in: provider entry 503 and 429 end as unavailable without stranding a popup, and the next activation completes',{timeout:120000},async t=>{
  const entries=url=>url.origin===ISSUER&&url.pathname==='/api/oauth/entries';
  const faults=[{method:'POST',kind:503,test:entries},{method:'POST',kind:429,test:entries}];
  const s=await signInPage(t,faults);if(!s.f)return;const {f,page}=s;
  for(const attempt of [1,2]){await s.press();await page.waitForFunction(n=>window.events.filter(e=>e.type==='bindle-sign-in-end').length===n,attempt,{timeout:10000});await until(s.frame,()=>document.querySelector('button.signin')?.getAttribute('aria-busy')==='false');}
  assert.deepEqual(await s.ends(),['unavailable','unavailable']);
  assert.equal(f.context.pages().filter(p=>p!==page&&!p.isClosed()).length,0,'the island closed the popups it opened');
  await s.press();await page.waitForFunction(()=>window.events.filter(e=>e.type==='bindle-sign-in-end').length===3,null,{timeout:20000});
  assert.deepEqual(await s.ends(),['unavailable','unavailable','completed']);assert.deepEqual(f.errors,[]);
});
