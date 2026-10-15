import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {launch,baseURL} from './browser.mjs';
import {deferred} from './chaos.mjs';

// Contention against the real local Worker: real cookies, sessions, multi-account
// state and the real service worker. Only explicit gates delay chosen requests so
// two tabs interleave deterministically; nothing is answered by a fixture.
let browser;
test.before(async()=>{const url=new URL(baseURL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname),'local Worker required');browser=await launch();});
test.after(async()=>{await browser?.close();});
async function signup(context,index){const headers={Origin:baseURL,'Content-Type':'application/json','CF-Connecting-IP':`198.51.100.${200+index}`};const pending=await (await context.request.post(baseURL+'/api/auth/signup',{headers,data:{method:'password',password:'UI chaos contention password 2026!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}})).json();assert.ok(pending.pendingToken,JSON.stringify(pending));const file=await (await context.request.post(baseURL+'/api/auth/recovery/download',{headers,data:{pendingToken:pending.pendingToken}})).json();const response=await context.request.post(baseURL+'/api/auth/recovery/confirm',{headers,data:{pendingToken:pending.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true}});assert.equal(response.status(),200);return (await response.json()).account;}
const shell=(page,handle)=>page.locator('.user-summary strong').filter({hasText:handle}).waitFor();
const watchErrors=(t,...pages)=>{const errors=[];for(const page of pages){page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!/^Failed to load resource|status of (4|5)\d\d/.test(message.text()))errors.push(message.text());});}t.after(()=>assert.deepEqual(errors,[],'No browser runtime or console errors'));};

test('two tabs: a switch in one tab never changes the other, and signing out the other tab’s account mid-request ends it honestly',async t=>{
 const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});t.after(()=>context.close());
 const one=await signup(context,1),two=await signup(context,2);
 const a=await context.newPage(),b=await context.newPage();watchErrors(t,a,b);for(const page of [a,b])page.setDefaultTimeout(10000);
 await a.goto(baseURL+'/console');await shell(a,two.handle);await b.goto(baseURL+'/console');await shell(b,two.handle);
 // Tab A switches to the other account: a per-tab selection, announced to B, which revalidates its own.
 await a.getByRole('button',{name:'Switch account',exact:true}).click();await a.locator('.account-row').filter({hasText:one.handle+'@'}).getByRole('button',{name:'Open account',exact:true}).click();await shell(a,one.handle);
 const rechecked=b.waitForEvent('requestfinished',request=>new URL(request.url()).pathname==='/api/account');await b.evaluate(()=>window.dispatchEvent(new Event('focus')));await rechecked;
 await b.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await shell(b,two.handle);assert.equal(await b.locator('.user-summary strong').filter({hasText:one.handle}).count(),0,'B keeps its own account after revalidating');
 // Tab B creates a View whose request is held at the network edge.
 const gate=deferred(),reached=deferred();await b.route('**/api/views',async route=>{if(route.request().method()!=='POST')return route.continue();reached.resolve();await gate.promise;await route.continue();});
 await b.getByRole('button',{name:'New View',exact:true}).first().click();await b.getByLabel('View name').fill('Contended view');await b.locator('.modal form button[type=submit]').click();await reached.promise;
 // Tab A signs out B's account while B's mutation is still in flight.
 await a.getByRole('button',{name:'Switch account',exact:true}).click();await a.locator('.account-row').filter({hasText:two.handle+'@'}).getByRole('button',{name:'Sign out',exact:true}).click();await a.getByText('Signed out.').waitFor();
 gate.resolve();
 await b.waitForFunction(()=>!document.querySelector('.user-summary'));await b.locator('[role=alert]').first().waitFor();
 const alerts=await b.locator('[role=alert]').allTextContents();assert.ok(alerts.some(text=>/session expired|Account changed|Choose an account/i.test(text)),`B explains the ended session: ${JSON.stringify(alerts)}`);
 assert.equal(await b.getByText('Contended view').count(),0,'no success or private data after the session ended');assert.equal(await b.locator('.alert.success').count(),0);
 assert.equal(await b.getByText(one.handle,{exact:true}).count()+await b.locator('.user-summary').count(),0,'B never falls through to A’s account');
 await b.waitForFunction(()=>![...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Please wait…'));
 await shell(a,one.handle).catch(async()=>{await a.locator('.account-row').filter({hasText:one.handle+'@'}).waitFor();});
});

test('a service-worker update mid-session waits, keeps the running tab on its build, survives an offline reload, and activates for the next session',async t=>{
 // A loopback proxy in front of the Worker can publish "the next build": the same sw.js with different bytes.
 const target=new URL(baseURL);let nextBuild=false,updates=0;
 const proxy=createServer((incoming,outgoing)=>{const upstream=httpRequest({host:target.hostname,port:target.port,method:incoming.method,path:incoming.url,headers:{...incoming.headers,host:target.host}},response=>{
  if(incoming.url==='/sw.js'&&nextBuild){const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{updates++;const body=Buffer.concat([Buffer.concat(chunks),Buffer.from('\n// next build')]);const headers={...response.headers,'content-length':String(body.length)};delete headers['content-encoding'];delete headers.etag;outgoing.writeHead(response.statusCode,headers);outgoing.end(body);});return;}
  outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);});incoming.pipe(upstream);upstream.on('error',()=>outgoing.destroy());});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>proxy.close(resolve)));const origin=`http://127.0.0.1:${proxy.address().port}`;
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();watchErrors(t,page);page.setDefaultTimeout(15000);
 await page.goto(origin+'/console');await page.locator('.auth-card').waitFor();await page.waitForFunction(async()=>Boolean((await navigator.serviceWorker.getRegistration())?.active));await page.evaluate(()=>navigator.serviceWorker.ready);
 await page.reload();await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await page.locator('.auth-card').waitFor();
 const cachesBefore=await page.evaluate(()=>caches.keys());await page.evaluate(()=>{window.sessionMarker='still-the-same-document';});
 nextBuild=true;await page.evaluate(()=>navigator.serviceWorker.getRegistration().then(registration=>registration.update()));
 await page.waitForFunction(async()=>Boolean((await navigator.serviceWorker.getRegistration())?.waiting));assert.ok(updates>=1,'the next build was fetched');
 assert.equal(await page.evaluate(()=>window.sessionMarker),'still-the-same-document','no forced reload mid-session');
 assert.deepEqual(await page.evaluate(()=>caches.keys()),cachesBefore,'the running build keeps its cache');
 // The running tab keeps working on its own build: a lazily rendered flow and a locale change.
 await page.getByRole('button',{name:/^Create (a|an) .* account$|^Create an account$/}).first().click();await page.locator('.signup-wizard').waitFor();
 await page.locator('.language-switch').selectOption('es');await page.locator('.signup-wizard').waitFor();await page.locator('.language-switch').selectOption('en');
 await context.setOffline(true);await page.reload();await page.getByText(/You’re offline/).waitFor();await page.locator('.auth-card, .signup-wizard').first().waitFor();await context.setOffline(false);
 // Once no tab uses the old build, the waiting worker takes over for the next session.
 await page.close();const next=await context.newPage();watchErrors(t,next);next.setDefaultTimeout(15000);await next.goto(origin+'/console');await next.locator('.auth-card').waitFor();
 await next.waitForFunction(async()=>{const registration=await navigator.serviceWorker.getRegistration();return Boolean(navigator.serviceWorker.controller)&&!registration.waiting;});
});
