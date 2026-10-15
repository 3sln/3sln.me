// Real-browser checks for the provider islands (apps/embed; embed-islands §19 I2–I4, adaptive A5 client pieces) against
// the local Worker. The test starts its own `wrangler dev` with the built public tree, the authorization-entry store and a
// dedicated embed origin. Fixture origins are reserved .example names: provider.example (the issuer, APP_ORIGIN),
// embed.provider.example (EMBED_ORIGIN) and app.example (the registered client). Playwright route interception forwards
// the two provider origins to the Worker with their Host header, and `--upstream-protocol https` makes the Worker see
// https URLs, so the shell, its hashed assets, the island worker, the embed API (session view with `subject`, avatar,
// claim) and the token endpoint are all the real routes. Only the app page and the provider popup document (slice A7,
// a stand-in that drives the real entry routes as the provider page will) are test pages. Chromium runs with third-party
// storage partitioning re-enabled (Playwright disables it by default; COOP spike), Firefox with cookieBehavior 5.
// Requires `npm run build:assets`. Run: node --test tests/browser/islands-embed.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomBytes,webcrypto} from 'node:crypto';
import {chromium,firefox,webkit} from 'playwright';
import {monogramColors} from '../../packages/sdk/src/islands-protocol.mjs';

const ISSUER='https://provider.example',EMBED='https://embed.provider.example',APP='https://app.example',CLIENT=APP+'/client',sleep=ms=>new Promise(r=>setTimeout(r,ms));
const AVATAR_URL=ISSUER+'/branding/3sln-avatar.png';

// ---- Local Worker ---------------------------------------------------------------------------------------------
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

// Element-side harness: the minimal embedder half of the handshake (the real elements are slice I5). The app redeems
// the island's code at the real token endpoint with its PKCE verifier.
const appPage=`<!doctype html><meta charset="utf-8"><title>Fixture app</title><body style="margin:0"><button id="before">before</button><div id="slot" style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:2px"></div><button id="after">after</button>
<script>
const EMBED=${JSON.stringify(EMBED)},ISSUER=${JSON.stringify(ISSUER)},CLIENT=${JSON.stringify(CLIENT)};
const b64=n=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
window.islands={};window.msgs=[];addEventListener('message',e=>msgs.push({origin:e.origin,data:e.data}));
window.mount=(id,part,o={})=>{const nonce=o.nonce??b64(16),cs=o.cs??'light',lang=o.lang??'en',iframe=document.createElement('iframe');
  iframe.src=EMBED+'/embed?client='+encodeURIComponent(o.client??CLIENT)+(o.fragment??('#'+part+'.v1'));iframe.name='bindle-island;v=1;n='+nonce+';l='+lang+';cs='+cs;iframe.title=part;iframe.setAttribute('referrerpolicy','no-referrer');
  iframe.allow="storage-access 'none'; browsing-topics 'none'";if(o.sandbox!=null)iframe.setAttribute('sandbox',o.sandbox);
  iframe.style.cssText='display:block;border:0;width:'+(o.w??40)+'px;height:'+(o.h??40)+'px;color-scheme:'+cs;
  const rec={messages:[],loads:0,port:null};
  iframe.addEventListener('load',()=>{rec.loads++;if(rec.loads>1)return;const ch=new MessageChannel();rec.port=ch.port1;
    ch.port1.onmessage=e=>{rec.messages.push(e.data);if(e.data.type==='code')fetch(ISSUER+'/oauth/token',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:e.data.code,code_verifier:window.pending.verifier,client_id:CLIENT,redirect_uri:'${APP}/callback'})}).then(async r=>{window.exchanged={status:r.status,body:await r.json()};});};
    iframe.contentWindow.postMessage({v:1,type:'bindle-island-init',nonce:o.initNonce??nonce,part,version:1,theme:{seq:0,tokens:{}},locale:lang,colorScheme:cs,props:o.props??{seq:0}},EMBED,[ch.port2]);});
  document.getElementById('slot').append(iframe);islands[id]=rec;};
window.send=(id,m)=>islands[id].port.postMessage(m);
window.types=id=>islands[id].messages.map(m=>m.type==='flow'?'flow:'+m.phase+(m.outcome?':'+m.outcome:''):m.type);
window.prepare=async id=>{const verifier=b64(48),d=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))),challenge=btoa(String.fromCharCode(...d)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''),state=b64(32);
  window.pending={verifier,state};send(id,{v:1,type:'prepare',redirectUri:'${APP}/callback',challenge,state,requests:[]});};
window.openOwn=url=>{window.own=window.open(url,'_blank');};
</script>`;
// Stand-in for the A7 provider popup document: static, no COOP header, no account state before the handshake. After the
// opener-key handshake it performs the owner steps against the real entry routes with the tab's member headers.
const popupPage=`<!doctype html><meta charset="utf-8"><title>Provider</title><script>
(async()=>{const EMBED=${JSON.stringify(EMBED)},entry=new URL(location.href).searchParams.get('entry');window.log=[];window.hasOpener=!!window.opener;window.nameAtLoad=window.name;
 const post=(p,b,h={})=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json',...h},body:JSON.stringify(b)}).then(r=>r.json());
 addEventListener('message',async e=>{log.push({origin:e.origin,type:e.data&&e.data.type,fromOpener:e.source===window.opener});if(e.origin!==EMBED||e.source!==window.opener)return;
  if(e.data.type==='bindle-embed-proof'){const {pageSecret}=await post('/oauth/entries/'+entry+'/embed-verify',{proof:e.data.proof});
   const session=await(await fetch('/api/session')).json(),member={'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext,'X-CSRF-Token':session.csrfToken};
   const view=await(await fetch('/api/oauth/entries/'+entry)).json(),selection=await post('/api/oauth/entries/'+entry+'/select',{nonce:view.entry.nonce,pageSecret},member);await fetch('/api/oauth/requests/'+selection.requestId);
   const r=await post('/api/oauth/entries/'+entry+'/decision',{nonce:view.entry.nonce,pageSecret,approved:[]},member);window.decision=r;
   window.opener.postMessage({v:1,type:'bindle-embed-done',entry,code:r.code,state:r.state,iss:r.iss,claim:r.claim},EMBED);}
  if(e.data.type==='bindle-embed-ack'){window.acked=true;}});
 const {challenge}=await post('/oauth/entries/'+entry+'/embed-challenge',{});
 if(window.opener)window.opener.postMessage({v:1,type:'bindle-embed-hello',entry,challenge},EMBED);})();
</script>`;
// Records P8-relevant calls in every frame, including the cross-origin islands.
const instrument=()=>{const log=window.__p8={calls:[],csp:[]};for(const name of ['alert','confirm','prompt','print'])window[name]=(...a)=>{log.calls.push(name);};
  const open=window.open.bind(window);window.open=(...a)=>{log.calls.push('open:'+a.map(String).join('|'));return open(...a);};
  if(Document.prototype.requestStorageAccess)Document.prototype.requestStorageAccess=function(){log.calls.push('requestStorageAccess');return Promise.reject();};
  const show=HTMLDialogElement.prototype.showModal;HTMLDialogElement.prototype.showModal=function(){log.calls.push('showModal');return show.call(this);};
  document.addEventListener('securitypolicyviolation',e=>log.csp.push(e.violatedDirective+' '+e.blockedURI));
  const W=window.Worker;log.workers=[];window.Worker=function(url,options){const w=new W(url,options);const rec={url:String(url),errors:[],messages:[]};log.workers.push(rec);w.addEventListener('error',e=>rec.errors.push(String(e.message||'error')));w.addEventListener('message',e=>rec.messages.push(JSON.stringify(e.data,(k,v)=>v instanceof Blob?'blob':v).slice(0,300)));return w;};};

async function disabledFeatures(){const b=await chromium.launch({args:['--enable-automation']}),c=await b.newBrowserCDPSession(),{arguments:a}=await c.send('Browser.getBrowserCommandLine');await b.close();return a.find(x=>x.startsWith('--disable-features=')).slice(19);}
async function launch(name){
  if(name==='chromium'){const df=await disabledFeatures();return chromium.launch({args:['--enable-features=ThirdPartyStoragePartitioning',`--disable-features=${df.split(',').filter(x=>x!=='ThirdPartyStoragePartitioning').join(',')}`],ignoreDefaultArgs:[`--disable-features=${df}`]});}
  if(name==='firefox')return firefox.launch({firefoxUserPrefs:{'network.cookie.cookieBehavior':5}});
  const browser=await webkit.launch();const probe=await Promise.race([browser.newPage().then(p=>p.close().then(()=>'ok')),sleep(15000).then(()=>'hang')]);if(probe!=='ok'){browser.close().catch(()=>{});throw new Error('WebKit newPage() hangs in this environment');}return browser;
}

let worker=null;
test.before(async()=>{worker=await startWorker();},{timeout:90000});
test.after(async()=>{await worker?.stop();});

async function fixture(t,name){
  let browser;try{browser=await launch(name);}catch(error){t.skip(`${name} unavailable: ${error.message.split('\n')[0]}`);return null;}
  t.after(()=>browser.close());
  const log=[],errors=[],remote=`198.51.100.${40+Math.floor(Math.random()*150)}`;
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
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),raw=await request.allHeaders(),headers={...raw,...metadata(url,raw)};
    const entry={method:request.method(),url:url.href,headers};log.push(entry);
    if(url.origin===APP){
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin-allow-popups'},body:appPage});
      return route.fulfill({status:404,body:''});
    }
    if(url.origin===ISSUER&&url.pathname==='/oauth/authorize'&&url.searchParams.has('entry'))return route.fulfill({contentType:'text/html',headers:{'Referrer-Policy':'no-referrer'},body:popupPage});
    if(url.origin===ISSUER&&url.pathname==='/test/blank')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Provider fixture</title>'});
    if(url.origin===ISSUER||url.origin===EMBED){const response=await forward(route,headers);entry.status=response.status;if(process.env.ISLANDS_DEBUG&&url.pathname.startsWith('/embed/api/'))console.error('api',request.method(),url.pathname,response.status,String(response.body).slice(0,300));return route.fulfill(response);}
    return route.abort();
  });
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
const ready=(page,id)=>page.waitForFunction(i=>window.islands[i]?.messages.some(m=>m.type==='ready'),id,{timeout:8000});
const types_=(page,id)=>page.evaluate(i=>window.types(i),id);
const p8=frame=>frame.evaluate(()=>window.__p8);
// The islands' CSP forbids eval, which Playwright's waitForFunction relies on inside a frame; poll with evaluate.
async function until(frame,predicate,arg,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await frame.evaluate(predicate,arg).catch(()=>false))return;await sleep(100);}throw new Error('until: timed out');}

for(const name of ['chromium','firefox','webkit'])test(`islands in ${name}`,{timeout:180000},async t=>{
  const f=await fixture(t,name);if(!f)return;
  const page=await f.open();
  await page.evaluate(()=>{for(const [id,part,o] of [['a1','avatar',{w:40,h:40}],['s1','sign-in',{w:240,h:44,fragment:'#sign-in'}],['w1','account-switcher',{w:320,h:320}]])window.mount(id,part,o);});
  for(const id of ['a1','s1','w1'])await ready(page,id);
  const frames=Object.fromEntries(await Promise.all(['a1','s1','w1'].map(async(id,i)=>[id,(await page.$$('#slot iframe'))[i]].map(x=>x)).map(async p=>{const [id,el]=await p;return [id,await el.contentFrame()];})));
  const subject=f.subject;

  await t.test('fragment-only part selection; unknown parts, bad nonces and unknown clients stay inert',async()=>{
    for(const [id,part] of [['a1','avatar'],['s1','sign-in'],['w1','account-switcher']]){
      const shown=await frames[id].evaluate(()=>[...document.querySelectorAll('.part')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.id));
      assert.deepEqual(shown,[`${part}.v1`]);const ready=(await page.evaluate(i=>window.islands[i].messages[0],id));
      assert.deepEqual(ready,{v:1,type:'ready',part,version:1,protocol:[1],issuer:ISSUER});
      assert.equal(await frames[id].evaluate(()=>window.name),'','window.name is read once and cleared');
    }
    await page.evaluate(()=>{window.mount('x1','avatar',{fragment:'#publications'});window.mount('x2','avatar',{initNonce:'AAAAAAAAAAAAAAAAAAAAAA'});window.mount('x3','avatar',{fragment:'#avatar?part=sign-in'});window.mount('x4','avatar',{client:'https://unknown.example/client'});});
    await sleep(3500);for(const id of ['x1','x2','x3','x4'])assert.deepEqual(await types_(page,id),[],id);
    await page.evaluate(()=>{for(const id of ['x1','x2','x3','x4']){window.islands[id].port?.close();}for(const f of [...document.querySelectorAll('#slot iframe')].slice(3))f.remove();});
    // A later fragment change (same-document navigation) is ignored: one part for the island's life.
    assert.equal(await page.evaluate(()=>window.islands.a1.loads),1,'exactly one load event');
    await page.evaluate(()=>{const f=document.querySelectorAll('#slot iframe')[0];f.src=f.src.replace('#avatar.v1','#sign-in.v1');});await sleep(300);
    assert.equal(await frames.a1.evaluate(()=>document.documentElement.dataset.part),'avatar');
    assert.deepEqual(await types_(page,'a1'),['ready']);
  });

  await t.test('inbound messages are presentation-only and validated; #avatar emits only ready',async()=>{
    await page.evaluate(s=>{for(const m of [{v:1,type:'theme',seq:1,tokens:{accent:'#1d4ed8',radius:4}},{v:1,type:'scheme',colorScheme:'light'},{v:1,type:'locale',lang:'es'},{v:1,type:'props',seq:1},{v:1,type:'session',subject:s},{v:1,type:'session',subject:null},{v:1,type:'session',subject:s}])window.send('a1',m);},subject);
    await sleep(800);assert.deepEqual(await types_(page,'a1'),['ready']);
    assert.equal(await frames.a1.evaluate(()=>document.documentElement.lang),'es');
    // Three violations stop the island reading its port; a later valid scheme is not applied.
    await page.evaluate(()=>{window.mount('v1','account-switcher',{w:320,h:248});});await ready(page,'v1');const v1=await(await page.$$('#slot iframe')).at(-1).contentFrame();
    await page.evaluate(()=>{for(const m of [{v:1,type:'select',subject:'x'},{v:1,type:'prepare'},{v:1,type:'scheme',colorScheme:'dim'},{v:1,type:'scheme',colorScheme:'dark'}])window.send('v1',m);});
    await sleep(500);assert.equal(await v1.evaluate(()=>document.documentElement.dataset.scheme),'light');
    assert.deepEqual(await types_(page,'v1'),['ready']);
  });

  await t.test('avatar fills min(width,height), centred; monogram fallback with no binding',async()=>{
    await page.evaluate(s=>{for(const [id,w,h] of [['m1',120,60],['m2',50,200]]){window.mount(id,'avatar',{w,h});}},subject);
    for(const id of ['m1','m2'])await ready(page,id);
    const iframes=await page.$$('#slot iframe'),m1=await iframes.at(-2).contentFrame(),m2=await iframes.at(-1).contentFrame();
    await page.evaluate(s=>{window.send('m1',{v:1,type:'session',subject:s});window.send('m2',{v:1,type:'session',subject:s});},subject);
    for(const [frame,w,h] of [[m1,120,60],[m2,50,200]]){
      await until(frame,()=>document.querySelector('img.avatar')?.src.startsWith('blob:'),null,8000);
      const box=await frame.evaluate(()=>{const r=document.querySelector('img.avatar').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
      const s=Math.min(w,h);assert.deepEqual(box,{x:(w-s)/2,y:(h-s)/2,w:s,h:s});
      const bg=monogramColors(subject,'light').background,expected=[1,3,5].map(i=>parseInt(bg.slice(i,i+2),16));
      const pixel=async()=>frame.evaluate(async()=>{const img=document.querySelector('img.avatar');await img.decode().catch(()=>{});const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);return [img.naturalWidth,...x.getImageData(1,1,1,1).data];});
      await until(frame,async e=>{const img=document.querySelector('img.avatar');await img.decode().catch(()=>{});if(!img.naturalWidth)return false;const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(1,1,1,1).data;return d[3]===255&&d[0]===e[0]&&d[1]===e[1]&&d[2]===e[2];},expected);
      const [natural,...rgba]=await pixel();assert.equal(natural,64);assert.deepEqual(rgba,[...expected,255],'the monogram tile, opaque, at the bucket size');
    }
    assert.deepEqual(await types_(page,'m1'),['ready']);
  });

  await t.test('serving: shell, assets, worker and service worker headers from the real Worker; the app origin never serves islands',async()=>{
    const get=(url,headers={})=>forwardTo(worker.port,{method:'GET',url,headers:{'cf-connecting-ip':'198.51.100.7',...headers}});
    const shell=await get(`${EMBED}/embed?client=${encodeURIComponent(CLIENT)}`),csp=shell.headers['content-security-policy'],html=String(shell.body);
    assert.equal(shell.status,200);assert.match(csp,/frame-ancestors https:\/\/app\.example;/);assert.match(csp,/script-src 'self' 'sha256-[A-Za-z0-9+/]{43}=';/);assert.match(csp,/require-trusted-types-for 'script'; trusted-types bindle-embed$/);
    assert.equal(shell.headers['cross-origin-embedder-policy'],'require-corp');assert.equal(shell.headers['cache-control'],'private, max-age=300');assert.equal(shell.headers['set-cookie'],undefined);
    const config=JSON.parse(/id="config">(.*?)<\/script>/.exec(html)[1]);assert.equal(config.issuer,ISSUER);assert.equal(config.clientId,CLIENT);assert.deepEqual(config.origins,[APP]);assert.equal(config.sw,'/embed/sw.js');
    const map=/<script type="importmap">(.*?)<\/script>/.exec(html)[1],digest='sha256-'+Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(map))).toString('base64');assert.ok(csp.includes(`'${digest}'`),'the CSP hash is the shipped import map');
    for(const href of [config.worker,...[...html.matchAll(/(?:href|src)="(\/embed\/assets\/[^"]+)"/g)].map(m=>m[1]),...Object.values(JSON.parse(map).imports)]){const asset=await get(EMBED+href);assert.equal(asset.status,200,href);assert.equal(asset.headers['cross-origin-resource-policy'],'same-origin');assert.equal(asset.headers['cross-origin-embedder-policy'],'require-corp');assert.match(asset.headers['cache-control'],/immutable/);assert.equal(asset.headers['x-content-type-options'],'nosniff');}
    const sw=await get(EMBED+'/embed/sw.js');assert.equal(sw.status,200);assert.equal(sw.headers['service-worker-allowed'],'/embed');assert.equal(sw.headers['cache-control'],'no-cache');assert.match(String(sw.body),/const GENERATION='bindle-embed-[a-f0-9]{20}'/);
    for(const path of ['/embed/shell.html','/embed/shell.json','/embed/sw.js?v=1',config.worker+'?v=1'])assert.equal((await get(EMBED+path)).status,404,path);
    for(const path of ['/embed','/embed/sw.js',config.worker,'/embed/shell.html'])assert.equal((await get(ISSUER+path)).status,404,`app origin ${path}`);
    const manifest=JSON.parse((await get(ISSUER+'/.well-known/bindle/manifest.json')).body);assert.equal(manifest.profiles['https://3sln.me/artefacts/profiles/components/v1'].embed_origin,EMBED);
    // Bearer alone never gets avatar bytes, and the refusal waits for the same fixed deadline as a success.
    const started=Date.now(),refused=await get(`${EMBED}/embed/api/avatar?s=64`,{'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','x-bindle-embed':'1',authorization:'BindleEmbedSession x'});
    assert.equal(refused.status,401);assert.ok(Date.now()-started>=1400,'uniform deadline');assert.equal(refused.headers['access-control-allow-origin'],undefined);assert.equal(refused.headers['cross-origin-resource-policy'],'same-origin');
  });

  await t.test('sign-in island flow: unnamed popup, opener handshake, code to the app, leader-only restore, key-bound re-encoded avatar',async()=>{
    assert.deepEqual((await p8(frames.s1)).workers,[],'P10: the sign-in island starts no worker (no storage, no network) before activation');
    await page.evaluate(()=>window.prepare('s1'));await sleep(600); // pointer arming (400 ms after visible)
    const popupPromise=f.context.waitForEvent('page',{timeout:8000});
    await frames.s1.locator('button.signin').hover();await sleep(500);await frames.s1.locator('button.signin').click(); // the pointer must rest on the island for the arming delay
    const popup=await popupPromise;try{await page.waitForFunction(()=>window.exchanged,null,{timeout:15000});}catch(e){console.error('F',JSON.stringify(await types_(page,'s1')),popup.url(),JSON.stringify(await popup.evaluate(()=>({log:window.log,o:window.hasOpener,acked:window.acked,decision:window.decision})).catch(x=>x.message)),JSON.stringify(f.log.filter(l=>!l.url.includes('/assets/')).slice(-12).map(l=>l.method+' '+l.url)));throw e;}
    assert.equal(await page.evaluate(()=>window.exchanged.status),200,JSON.stringify(await page.evaluate(()=>window.exchanged)));
    // The island redeems its claim (nonce, key proof) before it ends the flow.
    await page.waitForFunction(()=>window.types('s1').includes('flow:ended:completed'),null,{timeout:10000});
    assert.deepEqual(await types_(page,'s1'),['ready','flow:started','code','flow:ended:completed']);
    const popupState=await popup.evaluate(()=>({hasOpener:window.hasOpener,name:window.nameAtLoad,log:window.log,acked:window.acked})).catch(()=>null);
    if(popupState){assert.equal(popupState.hasOpener,true);assert.equal(popupState.name,'','the popup is never named');assert.ok(popupState.log.filter(l=>l.type==='bindle-embed-proof').every(l=>l.origin===EMBED&&l.fromOpener));}
    const opens=(await p8(frames.s1)).calls.filter(c=>c.startsWith('open:'));assert.deepEqual(opens,['open:about:blank|_blank|popup']);
    assert.ok(!(await page.evaluate(()=>window.msgs)).length,'nothing reached the app window');
    const entryCall=f.log.find(e=>e.url===`${ISSUER}/api/oauth/entries`&&e.method==='POST');assert.equal(entryCall.headers.origin,EMBED);assert.equal(entryCall.headers.cookie,undefined);
    // The member islands (avatar, switcher) share one partition: only the leader restores.
    await page.evaluate(s=>{window.send('a1',{v:1,type:'session',subject:s});window.send('w1',{v:1,type:'session',subject:s});},subject);
    await until(frames.a1,async()=>{const img=document.querySelector('img.avatar');if(!img?.src.startsWith('blob:'))return false;await img.decode().catch(()=>{});if(!img.naturalWidth)return false;const c=document.createElement('canvas');c.width=c.height=img.naturalWidth;const x=c.getContext('2d');x.drawImage(img,0,0);const corner=x.getImageData(1,1,1,1).data,centre=x.getImageData(img.naturalWidth/2,img.naturalWidth/2,1,1).data;return corner[3]===0&&centre[3]===255&&centre[2]>200;},null,15000);
    assert.equal(f.sessionCalls(),1,'restore is leader-only');
    const avatarCalls=f.log.filter(e=>e.url.startsWith(`${EMBED}/embed/api/avatar`));assert.ok(avatarCalls.length>=1);
    assert.ok(avatarCalls.every(e=>e.method==='GET'&&/^BindleEmbedSession /.test(e.headers.authorization)&&/^[\w-]+\.[\w-]+\.[\w-]+$/.test(e.headers.dpop??'')&&e.headers['sec-fetch-site']==='same-origin'&&e.headers.cookie===undefined),'avatar bytes need the session and a key proof');
    await until(frames.w1,()=>document.querySelector('.card .name')?.textContent==='Display alex',null,8000);
    assert.deepEqual(await types_(page,'a1'),['ready'],'no avatar load/error signal ever reaches the port');
    // Failover: a second tab on the same site follows; closing the leader's tab hands leadership over.
    const page2=await f.open();await page2.evaluate(()=>window.mount('b1','avatar',{w:40,h:40}));await ready(page2,'b1');
    await page2.evaluate(s=>window.send('b1',{v:1,type:'session',subject:s}),subject);const b1=await(await page2.$('#slot iframe')).contentFrame();
    await until(b1,()=>document.querySelector('img.avatar')?.src.startsWith('blob:'),null,8000);
    assert.equal(f.sessionCalls(),1,'a follower renders the leader snapshot without restoring');
    await page.close();
    await sleep(1500);
    assert.equal(f.sessionCalls(),2,'the next island leads and restores with its own key proof');
    await until(b1,async()=>{const img=document.querySelector('img.avatar');await img.decode().catch(()=>{});if(!img.naturalWidth)return false;const c=document.createElement('canvas');c.width=c.height=img.naturalWidth;const x=c.getContext('2d');x.drawImage(img,0,0);const corner=x.getImageData(1,1,1,1).data,centre=x.getImageData(img.naturalWidth/2,img.naturalWidth/2,1,1).data;return corner[3]===0&&centre[3]===255&&centre[2]>200;},null,10000);
    t.diagnostic(`session calls ${f.sessionCalls()}`);
    f.page2=page2;
  });

  await t.test('the popup bridge delivers only to the embed origin',async()=>{
    // An app-opened popup on the same provider document: its hello targets the embed origin, so the app gets nothing.
    const page=f.page2;const entry=await page.evaluate(async({issuer,client,app})=>(await fetch(issuer+'/api/oauth/entries',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:client,redirectUri:app+'/callback',challenge:'c'.repeat(43),challengeMethod:'S256',state:'s'.repeat(43),intent:'login',requests:[],presentation:'popup'})})).json(),{issuer:ISSUER,client:CLIENT,app:APP});
    const popupPromise=f.context.waitForEvent('page',{timeout:8000});await page.evaluate(u=>window.openOwn(u),`${ISSUER}/oauth/authorize?entry=${entry.entryId}`);
    const own=await popupPromise;await until(own,()=>window.hasOpener!==undefined);await sleep(800);
    assert.deepEqual(await page.evaluate(()=>window.msgs),[],'exact targetOrigin drops the hello at the app');
    // A forged done message from the app window to an island is ignored (no flow pending, wrong source).
    await page.evaluate(()=>document.querySelector('#slot iframe').contentWindow.postMessage({v:1,type:'bindle-embed-done'},'*'));await sleep(200);
    assert.deepEqual(await types_(page,'b1'),['ready']);
    await own.close();
  });

  await t.test('sandbox detection degrades to unavailable without a popup',async()=>{
    const page=f.page2;await page.evaluate(()=>window.mount('z1','sign-in',{w:240,h:44,sandbox:'allow-scripts allow-same-origin allow-popups'}));await ready(page,'z1');
    await page.evaluate(()=>window.prepare('z1'));await sleep(600);
    const z1=await(await page.$$('#slot iframe')).at(-1).contentFrame();let opened=false;const listener=()=>{opened=true;};f.context.on('page',listener);
    await z1.locator('button.signin').hover();await sleep(500);await z1.locator('button.signin').click(); // the pointer must rest on the island for the arming delayawait sleep(800);f.context.off('page',listener);
    assert.deepEqual(await types_(page,'z1'),['ready','flow:started','flow:ended:unavailable']);assert.equal(opened,false);
  });

  await t.test('light/dark follows name and scheme; reduced motion removes transitions',async()=>{
    const page=f.page2;await page.evaluate(()=>window.mount('d1','account-switcher',{w:320,h:320,cs:'dark'}));await ready(page,'d1');
    const d1=await(await page.$$('#slot iframe')).at(-1).contentFrame();await until(d1,()=>Boolean(document.querySelector('.switcher')));
    assert.equal(await d1.evaluate(()=>getComputedStyle(document.querySelector('.switcher')).backgroundColor),'rgb(23, 25, 29)');
    await page.evaluate(()=>window.send('d1',{v:1,type:'scheme',colorScheme:'light'}));await until(d1,()=>document.documentElement.dataset.scheme==='light');
    assert.equal(await d1.evaluate(()=>getComputedStyle(document.querySelector('.switcher')).backgroundColor),'rgb(255, 255, 255)');
    assert.equal(await d1.evaluate(()=>getComputedStyle(document.querySelector('.control')).transitionDuration.split(',')[0]),'0.12s');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await d1.evaluate(()=>getComputedStyle(document.querySelector('.control')).transitionDuration.split(',')[0]),'0s');
    await page.emulateMedia({reducedMotion:'no-preference'});
  });

  await t.test('no P8 behaviours, no focus trap, no inputs, CSP and Trusted Types clean',async()=>{
    const page=f.page2;
    for(const frame of page.frames().filter(fr=>fr.url().startsWith(EMBED))){
      const log=await p8(frame);if(!log)continue;
      assert.deepEqual(log.calls.filter(c=>!c.startsWith('open:')),[],frame.url());assert.deepEqual(log.csp,[],frame.url());
      assert.equal(await frame.evaluate(()=>document.querySelectorAll('input,textarea,select,form,iframe,dialog').length),0);
      assert.equal(await frame.evaluate(()=>window.length),0,'no nested frames');
    }
    assert.equal(page.url(),APP+'/','the top-level document never navigated');
    // Tab moves through the switcher island and out again.
    await page.evaluate(()=>{for(const f of document.querySelectorAll('#slot iframe'))if(!f.title.includes('switcher'))f.remove();});
    await page.focus('#before');let left=false;for(let i=0;i<12&&!left;i++){await page.keyboard.press('Tab');left=await page.evaluate(()=>document.activeElement?.id==='after');}
    assert.equal(left,true,'Tab always leaves the island');
    assert.deepEqual(f.errors.filter(e=>!/ResizeObserver/.test(e)),[]);
  });
});

