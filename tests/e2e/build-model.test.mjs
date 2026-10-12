import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {launch,baseURL,waitForApp} from './browser.mjs';

test('content-addressed import map, CSS and isolated worker have immutable policies while the shell revalidates',async t=>{
 const browser=await launch();t.after(()=>browser.close());const page=await browser.newPage();await waitForApp(page);
 const html=await (await page.request.get(baseURL)).text();const policy=(await page.request.get(baseURL)).headers()['content-security-policy'];const meta=/<meta name="bindle-import-map-csp" content="([^"]+)">/.exec(html)?.[1];assert.ok(meta&&policy.includes("'"+meta+"'"));
 const manifest=await(await page.request.get(baseURL+'/build-manifest.json')).json();const imports=await page.evaluate(()=>JSON.parse(document.querySelector('script[type=importmap]').textContent).imports);
 assert.equal(imports['/vendor/dodo/index.js'],imports['/assets/vendor/dodo/index.js']);assert.equal(imports['/packages/identity/handles.mjs'],manifest.imports['/packages/identity/handles.mjs']);
 for(const url of [manifest.entries.app.module,manifest.entries.app.css,manifest.entries.app.wireup,manifest.workers.recovery]){assert.match(url,/\.[a-f0-9]{10}\.(?:mjs|js|css)$/);const response=await page.request.get(baseURL+url);assert.equal(response.status(),200);assert.match(response.headers()['cache-control'],/immutable/);}
 assert.equal((await page.request.get(baseURL)).headers()['cache-control'],'no-store');
 const worker=await page.request.get(baseURL+manifest.workers.recovery);assert.match(worker.headers()['content-security-policy'],/wasm-unsafe-eval/);
 const raw=await page.request.get(baseURL+'/src/main.mjs');assert.equal(raw.status(),404);
});

test('public SDK embeds from another origin with no import map and follows stable loaders to immutable standalone modules',async t=>{
 const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><body><script type="module">import {defineLoginElement} from ${JSON.stringify(baseURL+'/packages/sdk/src/login-element.mjs')};import {parseIdentity} from ${JSON.stringify(baseURL+'/packages/sdk/src/identity.mjs')};defineLoginElement();const element=document.createElement('bindle-login');element.addEventListener('bindle-login-request',event=>window.receivedIdentity=event.detail);document.body.append(element);window.parsedIdentity=parseIdentity('n.7k3m');window.sdkReady=true;</script></body>`);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await launch();t.after(()=>browser.close());const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.sdkReady);
 assert.equal(await page.locator('script[type=importmap]').count(),0);await page.getByLabel('Your Bindle identity').fill('n.7k3m');await page.getByRole('button',{name:'Continue'}).click();const result=await page.evaluate(()=>({received:window.receivedIdentity,parsed:window.parsedIdentity}));assert.equal(result.received.handle,'n.7k3m@3sln.me');assert.equal(result.parsed.handle,result.received.handle);
 for(const path of ['/packages/sdk/src/login-element.mjs','/packages/sdk/src/identity.mjs']){const response=await page.request.get(baseURL+path);assert.equal(response.headers()['access-control-allow-origin'],'*');assert.equal(response.headers()['cache-control'],'no-cache');const body=await response.text();const target=JSON.parse(/export \* from ("[^"]+")/.exec(body)[1]);const immutable=await page.request.get(baseURL+target);assert.equal(immutable.headers()['access-control-allow-origin'],'*');assert.match(immutable.headers()['cache-control'],/immutable/);}
});
