// Real-browser checks for the islands' optional service worker (apps/embed/sw.js; embed-islands §3.3, EIR-2, EIR-16,
// IMPL-6, S5): registration from a framed island with scope `/embed` (Service-Worker-Allowed), the shell served
// network-first with an offline fallback, content-hashed assets cache-first, and `/embed/api/*` never intercepted or
// stored. islands-embed.mjs blocks service workers, because Playwright cannot route a service worker's script fetch
// (and request interception bypasses service workers). Here nothing is routed: a test CONNECT proxy tunnels the reserved
// .example hosts over real HTTPS, provider.example and embed.provider.example to a local Worker (`wrangler dev
// --local-protocol https`) and app.example to a one-page fixture server, both with a throwaway self-signed certificate
// (made with openssl; certificate errors are ignored by the browsers). The shell, assets, service worker script and
// embed API are therefore the Worker's real responses with browser-set Fetch Metadata. Chromium runs with third-party
// storage partitioning re-enabled, Firefox with cookieBehavior 5 and service workers allowed on certificate overrides
// (devtools.serviceWorkers.testing.enabled). Requires `npm run build:assets` and openssl. Run: node --test tests/browser/islands-sw.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {createServer as createHTTPSServer} from 'node:https';
import {createServer,connect} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomBytes,webcrypto} from 'node:crypto';
import {chromium,firefox} from 'playwright';

const EMBED='https://embed.provider.example',ISSUER='https://provider.example',APP='https://app.example',CLIENT=APP+'/client',sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=createServer();await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});const {port}=server.address();await new Promise(ok=>server.close(ok));return port;}

async function certificate(directory){
  const key=resolve(directory,'key.pem'),cert=resolve(directory,'cert.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=provider.example','-addext','subjectAltName=DNS:provider.example,DNS:embed.provider.example,DNS:app.example','-keyout',key,'-out',cert]);
  return {key,cert};
}
async function startWorker(directory,tls){
  const port=await freePort(),persistence=await mkdtemp(`${tmpdir()}/3sln-islands-sw-`);
  const config=JSON.parse(await readFile('wrangler.local.jsonc','utf8'));config.main=resolve(config.main);config.assets.directory=resolve(config.assets.directory);delete config.$schema;
  Object.assign(config.vars,{APP_ORIGIN:ISSUER,RP_ID:'provider.example',EMBED_ORIGIN:EMBED,FEDERATION_ENABLED:'true',FEDERATION_ENTRY_ENABLED:'true',
    FEDERATION_CLIENTS:JSON.stringify([{id:CLIENT,name:'Service worker fixture app',origin:APP,redirectUris:[APP+'/callback']}])});
  const recovery=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  await writeFile(resolve(directory,'wrangler.json'),JSON.stringify(config));
  await writeFile(resolve(directory,'.dev.vars'),`KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nSESSION_COOKIE_KEY=${randomBytes(32).toString('base64url')}\nRECOVERY_SIGNING_KEY=${JSON.stringify({kid:webcrypto.randomUUID(),privateJWK:await webcrypto.subtle.exportKey('jwk',recovery.privateKey)})}\n`,{mode:0o600});
  const worker=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--config',resolve(directory,'wrangler.json'),'--port',String(port),'--ip','127.0.0.1','--local-protocol','https','--https-key-path',tls.key,'--https-cert-path',tls.cert,'--persist-to',persistence],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(directory,'wrangler.log')}});
  let logs='';for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{logs+=chunk;});
  const stop=async()=>{worker.kill('SIGTERM');await new Promise(ok=>{if(worker.exitCode!==null)return ok();worker.once('exit',ok);setTimeout(ok,5000).unref();});await rm(persistence,{recursive:true,force:true});};
  for(let i=0;i<120;i++){if(worker.exitCode!==null)break;if(/Ready on/.test(logs)){await sleep(500);return {port,stop};}await sleep(500);}
  await stop();throw new Error('Wrangler did not become ready:\n'+logs.slice(-2000));
}
// The app document: the minimal embedder half of the handshake; mount() adds a fresh #avatar island (an island reads its
// window.name nonce once, so a reloaded island is inert by design and every check mounts a new one).
const appPage=`<!doctype html><meta charset="utf-8"><title>SW fixture app</title><body>
<script>
window.ready=0;window.mount=()=>{
  const nonce=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  const iframe=document.createElement('iframe');iframe.src=${JSON.stringify(EMBED)}+'/embed?client='+encodeURIComponent(${JSON.stringify(CLIENT)})+'#avatar.v1';
  iframe.name='bindle-island;v=1;n='+nonce+';l=en;cs=light';iframe.style.cssText='border:0;width:40px;height:40px';
  iframe.addEventListener('load',()=>{const ch=new MessageChannel();ch.port1.onmessage=e=>{if(e.data.type==='ready')window.ready++;};
    iframe.contentWindow.postMessage({v:1,type:'bindle-island-init',nonce,part:'avatar',version:1,theme:{seq:0,tokens:{}},locale:'en',colorScheme:'light',props:{seq:0}},${JSON.stringify(EMBED)},[ch.port2]);},{once:true});
  document.body.append(iframe);};
mount();
</script>`;

let directory,worker,app,proxy,proxyPort,offline=false;
test.before(async()=>{
  directory=await mkdtemp(resolve(await mkdir('.output',{recursive:true}).then(()=>'.output'),'islands-sw-'));
  const tls=await certificate(directory);worker=await startWorker(directory,tls);
  app=createHTTPSServer({key:await readFile(tls.key),cert:await readFile(tls.cert)},(req,res)=>{if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(appPage);}else{res.writeHead(404);res.end();}});
  await new Promise(ok=>app.listen(0,'127.0.0.1',ok));
  // CONNECT only, for the three fixture hosts; `offline` refuses every new tunnel (a network outage the service worker sees too).
  const targets={'provider.example:443':worker.port,'embed.provider.example:443':worker.port,'app.example:443':app.address().port};
  proxy=createServer(socket=>{socket.on('error',()=>{});socket.once('data',head=>{
    const match=/^CONNECT ([^ ]+) HTTP\/1\.[01]\r\n/.exec(head.toString('latin1')),port=match&&targets[match[1]];
    if(!port||offline){socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
    const upstream=connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.pipe(upstream);upstream.pipe(socket);});
    upstream.on('error',()=>socket.destroy());
  });});
  await new Promise(ok=>proxy.listen(0,'127.0.0.1',ok));proxyPort=proxy.address().port;
},{timeout:120000});
test.after(async()=>{proxy?.close();app?.close();await worker?.stop();if(directory)await rm(directory,{recursive:true,force:true});});

async function disabledFeatures(){const b=await chromium.launch({args:['--enable-automation']}),c=await b.newBrowserCDPSession(),{arguments:a}=await c.send('Browser.getBrowserCommandLine');await b.close();return a.find(x=>x.startsWith('--disable-features=')).slice(19);}
async function launch(name){
  const proxyOption={server:`http://127.0.0.1:${proxyPort}`};
  if(name==='chromium'){const df=await disabledFeatures();return chromium.launch({proxy:proxyOption,args:['--ignore-certificate-errors','--enable-features=ThirdPartyStoragePartitioning',`--disable-features=${df.split(',').filter(x=>x!=='ThirdPartyStoragePartitioning').join(',')}`],ignoreDefaultArgs:[`--disable-features=${df}`]});}
  return firefox.launch({proxy:proxyOption,firefoxUserPrefs:{'network.cookie.cookieBehavior':5,'devtools.serviceWorkers.testing.enabled':true}});
}
const island=page=>page.frames().filter(frame=>frame.url().startsWith(EMBED+'/embed?')).at(-1);
// What the embed origin's caches hold, as paths (with the query for the shell).
const cached=frame=>frame.evaluate(async()=>{const out=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys()){const url=new URL(request.url);out.push(url.pathname+url.search);}return out;});

for(const name of ['chromium','firefox'])test(`islands service worker in ${name}`,{timeout:120000},async t=>{
  let browser;try{browser=await launch(name);}catch(error){t.skip(`${name} unavailable: ${error.message.split('\n')[0]}`);return;}
  t.after(()=>browser.close());
  const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(APP+'/');await page.waitForFunction(()=>window.ready===1,null,{timeout:15000});

  await t.test('the framed island registers /embed/sw.js with scope /embed (Service-Worker-Allowed), partitioned to this site',async()=>{
    const registration=await island(page).evaluate(async()=>{const r=await Promise.race([navigator.serviceWorker.ready,new Promise(ok=>setTimeout(()=>ok(null),10000))]);return r&&{scope:r.scope,script:r.active?.scriptURL};});
    assert.ok(registration,'the island registered its service worker after ready');
    assert.equal(registration.scope,`${EMBED}/embed`);assert.equal(registration.script,`${EMBED}/embed/sw.js`);
    assert.deepEqual(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0,'nothing registered for the app');
    // A first-party embed-origin document is another partition: it sees no registration.
    const own=await context.newPage();await own.goto(`${EMBED}/embed/sw.js`);
    assert.equal(await own.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0,'the registration is partitioned by top-level site');await own.close();
  });

  await t.test('a newly mounted island is controlled; the shell and only content-hashed assets are cached',async()=>{
    await page.evaluate(()=>window.mount());await page.waitForFunction(()=>window.ready===2,null,{timeout:15000});
    const frame=island(page);
    assert.equal(await frame.evaluate(()=>navigator.serviceWorker.controller?.scriptURL),`${EMBED}/embed/sw.js`);
    const keys=await cached(frame);
    assert.ok(keys.includes(`/embed?client=${encodeURIComponent(CLIENT)}`),JSON.stringify(keys));
    for(const key of keys)assert.match(key,/^\/embed\?client=|^\/embed\/assets\/.+\.[0-9a-f]{8,}\.(?:m?js|css)$/,`only the shell and hashed assets: ${key}`);
    assert.ok(keys.some(key=>key.startsWith('/embed/assets/')),'hashed assets are cached');
  });

  await t.test('/embed/api/* is never intercepted or stored',async()=>{
    const frame=island(page);
    const statuses=await frame.evaluate(async()=>{const get=await fetch('/embed/api/events',{headers:{'X-Bindle-Embed':'1'},cache:'no-store'});const post=await fetch('/embed/api/nonce',{method:'POST',headers:{'X-Bindle-Embed':'1'},cache:'no-store',referrerPolicy:'same-origin'});return [get.status,post.status];});
    assert.deepEqual(statuses,[401,200],'both reached the Worker (the stream needs a session; nonce is open)');
    assert.ok(!(await cached(frame)).some(key=>key.startsWith('/embed/api/')),'no API response in any cache');
    offline=true;await context.setOffline(true);
    const results=await frame.evaluate(async()=>{const out=[];for(const init of [{},{method:'POST'}])try{await fetch(init.method?'/embed/api/nonce':'/embed/api/events',{...init,headers:{'X-Bindle-Embed':'1'}});out.push('served');}catch{out.push('network-error');}return out;});
    await context.setOffline(false);offline=false;
    assert.deepEqual(results,['network-error','network-error'],'without the network, API calls fail instead of being answered from a cache');
  });

  await t.test('offline, the shell falls back to the cached copy and still completes the handshake',async()=>{
    // The fallback is used only on a network error while navigator.onLine is false (EIR-16).
    offline=true;await context.setOffline(true);
    await page.evaluate(()=>window.mount());
    let served=true;try{await page.waitForFunction(()=>window.ready===3,null,{timeout:15000});}catch{served=false;}
    await context.setOffline(false);offline=false;
    assert.equal(served,true,'the cached shell rendered and answered the handshake while offline');
    const frame=island(page);assert.ok(await frame.evaluate(()=>{const config=JSON.parse(document.getElementById('config').textContent);return config.parts.length===3&&!config.parts.includes('request')&&document.getElementById('request.v1')?.childElementCount===0;}),'the cached shell keeps the three advertised parts; incremental requests stay inert while disabled');
  });

  assert.deepEqual(errors,[]);
});
