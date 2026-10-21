// Real-browser provider matrix for the provider-agnostic elements (components-profile
// decision note §5–§7). app.example serves the SDK from this checkout; every
// provider is testing.mjs's mock on its own origin behind page.route, with
// credentialless CORS like a real provider. Full / standard / minimal / partial
// declarations, an unsupported (version 2) and a below-floor manifest, and a host
// without a manifest. Nothing here is verified against a deployed provider.
// Run: node --test tests/browser/provider-matrix.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {chromium,firefox} from 'playwright';
import {createMockProvider,componentsDeclaration} from '../../packages/sdk/src/testing.mjs';

const root=resolve('.'),app='https://app.example',clientId=app+'/client',redirectUris=[app+'/callback',app+'/popup-callback'];
const artifacts=resolve(process.env.E2E_ARTIFACTS??'artifacts/browser');await mkdir(artifacts,{recursive:true});
// 1×1 PNG for the granted-picture case.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const appPage=({redirect,attributes='',account=''})=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture app</title><meta name="viewport" content="width=device-width">
<style>body{font-family:system-ui;margin:1rem;background:Canvas;color:CanvasText}</style>
<script type="module">import '/packages/sdk/src/define.mjs';window.events=[];for(const type of ['bindle-session-change','bindle-flow-start','bindle-flow-end','bindle-menu-toggle','bindle-sign-in-start','bindle-sign-in-end','bindle-account-change','bindle-account-change-failed','bindle-email-fallback'])document.addEventListener(type,event=>window.events.push({type,detail:JSON.parse(JSON.stringify(event.detail??null))}));window.sdkReady=true;</script></head>
<body><bindle-session client-id="${clientId}" redirect-uri="${app}${redirect}" default-host="3sln.example" ${attributes}><bindle-account ${account}><bindle-sign-in slot="signed-out"></bindle-sign-in></bindle-account></bindle-session><p id="outside">Outside</p></body></html>`;
const callbackPage=`<!doctype html><meta charset="utf-8"><title>Signing in</title><script type="module">import {handleCallback} from '/packages/sdk/src/callback.mjs';window.callbackResult=await handleCallback();</script><body></body>`;
const providerPage=`<!doctype html><meta charset="utf-8"><title>Provider</title><h1>Choose an account</h1><button id="approve">Approve</button> <button id="deny">Cancel</button>
<script>const params=new URL(location.href).searchParams,entry=params.get('entry')??params.get('request_id');for(const decision of ['approve','deny'])document.getElementById(decision).onclick=async()=>{const response=await fetch('/test/decide',{method:'POST',body:JSON.stringify({entry,decision})});location.assign(await response.text());};</script>`;

async function launch(t,engine){
  const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try{return await engine.launch({headless:true,...engine.name()==='chromium'&&!existsSync(chromium.executablePath())&&existsSync(chrome)?{executablePath:chrome}:{}});}
  catch(error){t.skip(`${engine.name()} unavailable: ${error.message.split('\n')[0]}`);return null;}
}
// `providers` maps host → mock options; '3sln.example' is the default provider.
async function fixture(t,{engine=chromium,providers,attributes,account}){
  const browser=await launch(t,engine);if(!browser)return null;t.after(()=>browser.close());
  const mocks=Object.fromEntries(Object.entries(providers).map(([host,options])=>[`https://${host}`,options===404?404:createMockProvider({issuer:`https://${host}`,clients:[{clientId,redirectUris}],...options})]));
  const context=await browser.newContext({ignoreHTTPSErrors:true});
  const requests=[],embedRequests=[],errors=[];
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===app){
      if(['/','/callback'].includes(url.pathname))return route.fulfill({contentType:'text/html',body:appPage({redirect:'/callback',attributes,account})});
      if(url.pathname==='/popup')return route.fulfill({contentType:'text/html',body:appPage({redirect:'/popup-callback',attributes,account})});
      if(url.pathname==='/popup-callback')return route.fulfill({contentType:'text/html',headers:{'Referrer-Policy':'no-referrer'},body:callbackPage});
      if(/^\/(?:packages\/sdk\/src|packages\/i18n|vendor\/dodo)\//.test(url.pathname)&&!url.pathname.includes('..'))return route.fulfill({contentType:extname(url.pathname)==='.mjs'||extname(url.pathname)==='.js'?'text/javascript':'text/plain',body:await readFile(resolve(root,'.'+url.pathname))});
      return route.fulfill({status:404,body:''});
    }
    if(url.hostname.startsWith('embed.')){embedRequests.push(url.href);return route.abort();}
    const mock=mocks[url.origin];
    if(mock){
      const cors={'Access-Control-Allow-Origin':app,'Access-Control-Allow-Headers':'content-type,accept,dpop,authorization','Access-Control-Expose-Headers':'DPoP-Nonce','Access-Control-Allow-Methods':'GET,POST','Vary':'Origin'};
      if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
      if(mock===404)return route.fulfill({status:404,headers:cors,body:''});
      if(url.pathname==='/oauth/authorize')return route.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin'},body:providerPage});
      if(url.pathname==='/test/decide'){const {entry,decision}=JSON.parse(request.postData());return route.fulfill({contentType:'text/plain',body:mock.authorize(entry,{decision})});}
      if(url.pathname.startsWith('/avatars/'))return route.fulfill({contentType:'image/png',body:png});
      const headers={};for(const name of ['content-type','dpop','authorization']){const value=await request.headerValue(name);if(value)headers[name]=value;}
      requests.push({origin:url.origin,path:url.pathname,dpop:!!headers.dpop,cookie:await request.headerValue('cookie')});
      const response=await mock.handle(new Request(url,{method:request.method(),headers,body:['GET','HEAD'].includes(request.method())?undefined:request.postDataBuffer()}));
      return route.fulfill({status:response.status,headers:{...cors,...Object.fromEntries(response.headers)},body:Buffer.from(await response.arrayBuffer())});
    }
    return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  return {browser,context,page,mocks,requests,embedRequests,errors};
}
const ready=page=>page.waitForFunction(()=>window.sdkReady&&document.querySelector('bindle-session')?.capabilities);
const shadowText=page=>page.evaluate(()=>[...document.querySelectorAll('*')].map(node=>node.shadowRoot?.textContent??'').join(' '));
const panelActions=page=>page.evaluate(()=>[...document.querySelector('bindle-account').shadowRoot.querySelectorAll('[role=list] [role=listitem] > button, [role=list] [role=listitem] > a')].map(node=>node.textContent));
// Popup sign-in: approve in the provider window, wait for the app session.
async function popupSignIn(f,start){
  const popupPromise=f.context.waitForEvent('page');await start();const popup=await popupPromise;
  await popup.getByRole('button',{name:'Approve'}).click();
  await f.page.waitForFunction(()=>document.querySelector('bindle-session').session,null,{timeout:10000});
  return popup;
}
const signInForm=async(page,handle)=>{await page.getByLabel('Your Bindle identity').fill(handle);await page.getByRole('button',{name:'Continue',exact:true}).click();};

for(const engine of [chromium,firefox])test(`${engine.name()}: full declaration: popup, DPoP-bound session with a non-extractable key, provider manage URL, an unreachable embed origin degrades islands to the standard composition`,async t=>{
  // FedCM is declared off here: real Chromium would try the mock config URL. The FedCM path is covered by DOM tests.
  const f=await fixture(t,{engine,providers:{'3sln.example':{declaration:'full',fedcm:false,profile:true,picture:true}}});if(!f)return;const {page,mocks,requests,embedRequests,errors}=f,mock=mocks['https://3sln.example'];
  await page.goto(app+'/popup');await ready(page);
  const caps=await page.evaluate(()=>document.querySelector('bindle-session').capabilities);
  assert.equal(caps.dpop,true);assert.equal(caps.profile,true);assert.ok(caps.islands.signIn);
  assert.equal(await page.getByRole('button',{name:'Continue with 3sln.example'}).isVisible(),true);
  await popupSignIn(f,()=>page.getByRole('button',{name:'Continue with 3sln.example'}).click());
  const [entry]=[...mock.entries.values()];assert.match(entry.dpopJkt,/^[A-Za-z0-9_-]{43}$/);assert.equal(entry.loginHint,undefined);
  assert.ok(requests.filter(call=>call.path==='/oauth/token').every(call=>call.dpop),'token requests carry DPoP proofs');
  assert.ok(requests.every(call=>call.cookie===null),'credentialless');
  const bound=await page.evaluate(async()=>{const s=document.querySelector('bindle-session'),tokens=s.client.session,key=await s.client.dpopKey(tokens.dpopJkt);const renewed=await s.client.refresh();return {jkt:tokens.dpopJkt,extractable:key.privateKey.extractable,lifetime:tokens.refresh_expires_in,renewed:renewed.renewalCount,same:renewed.dpopJkt===tokens.dpopJkt};});
  assert.deepEqual(bound,{jkt:entry.dpopJkt,extractable:false,lifetime:2592000,renewed:1,same:true});
  const order=await page.evaluate(()=>window.events.map(event=>event.type).filter(type=>['bindle-session-change','bindle-sign-in-start','bindle-sign-in-end','bindle-account-change'].includes(type)));
  assert.deepEqual(order,['bindle-session-change','bindle-sign-in-start','bindle-session-change','bindle-account-change','bindle-sign-in-end']);
  const trigger=page.getByRole('button',{name:/^Account: Alex Example$/});await trigger.waitFor();
  await page.locator('bindle-account .avatar.picture').waitFor(); // The account name can render before the image decodes.
  await trigger.click();
  assert.deepEqual(await panelActions(page),['Use another account','Use a different provider','Sign out of this app','Manage at 3sln.example']);
  assert.equal(await page.getByRole('link',{name:'Manage at 3sln.example'}).getAttribute('href'),'https://3sln.example/console/apps');
  // The embed origin is unreachable here: each island times out (3 s after load, or 10 s without one, as Firefox fires
  // no load for a failed frame) and its part degrades for the document.
  await page.waitForFunction(()=>{const s=document.querySelector('bindle-account').state.islands;return s.avatar==='fallback'&&s.switcher==='fallback';},null,{timeout:15000});
  assert.equal(await page.evaluate(()=>document.querySelector('bindle-session').capabilities.islands.avatar),null);
  assert.ok(embedRequests.length>0&&embedRequests.every(url=>url.startsWith('https://embed.3sln.example/embed?client=')),'only island shells were requested');
  assert.deepEqual(await panelActions(page),['Use another account','Use a different provider','Sign out of this app','Manage at 3sln.example'],'the fallback keeps every action');
  await page.screenshot({path:resolve(artifacts,`provider-matrix-full-${engine.name()}.png`)});
  assert.deepEqual(errors,[]);
});

for(const engine of [chromium,firefox])test(`${engine.name()}: standard declaration: required controls, select-account switch, popover placement and close semantics`,async t=>{
  const f=await fixture(t,{engine,providers:{'3sln.example':{declaration:'standard',profile:true,accounts:[{handle:'alex',displayName:'Alex Example'},{handle:'sam',displayName:'Sam Sample'}]}}});if(!f)return;const {page,mocks,errors}=f,mock=mocks['https://3sln.example'];
  await page.goto(app+'/popup');await ready(page);
  assert.equal(await page.getByLabel('Your Bindle identity').getAttribute('required'),null,'handle optional with identity-optional login');
  await popupSignIn(f,()=>signInForm(page,'alex'));
  assert.equal([...mock.entries.values()][0].loginHint,'alex@3sln.example');
  const trigger=page.getByRole('button',{name:/^Account: /});
  for(const width of [1280,320]){
    await page.setViewportSize({width,height:640});await trigger.click();
    const box=await page.evaluate(()=>{const panel=document.querySelector('bindle-account').shadowRoot.querySelector('dialog.panel'),r=panel.getBoundingClientRect();return {open:panel.matches(':popover-open'),left:r.left,right:r.right,top:r.top,bottom:r.bottom,vw:innerWidth,vh:innerHeight};});
    assert.ok(box.open&&box.left>=0&&box.right<=box.vw&&box.top>=0&&box.bottom<=box.vh,`panel inside the viewport at ${width}px: ${JSON.stringify(box)}`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:resolve(artifacts,`provider-matrix-panel-${engine.name()}-${width}.png`)});
    // A second press on the trigger toggles closed and stays closed (no close-then-reopen).
    await trigger.click();await page.waitForFunction(()=>document.querySelector('bindle-account').shadowRoot.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')==='false');
    assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  }
  await page.setViewportSize({width:1280,height:640});
  await trigger.click();await page.mouse.click(5,600);await page.waitForFunction(()=>window.events.filter(e=>e.type==='bindle-menu-toggle').at(-1)?.detail.reason==='outside');
  assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  const toggles=await page.evaluate(()=>window.events.filter(event=>event.type==='bindle-menu-toggle').map(event=>event.detail));
  assert.deepEqual(toggles.at(-1),{open:false,reason:'outside'});
  assert.ok(!toggles.some((value,index)=>index>0&&value.open&&toggles[index-1].open),'never reopened without a close');
  await trigger.click();
  assert.deepEqual(await panelActions(page),['Use another account','Use a different provider','Sign out of this app','Manage at 3sln.example'],'no reauth or provider sign-out without the intents');
  const popupPromise=f.context.waitForEvent('page');await page.getByRole('button',{name:'Use another account'}).click();
  const popup=await popupPromise;await popup.getByRole('button',{name:'Cancel'}).waitFor();
  assert.equal([...mock.entries.values()].at(-1).intent,'select-account');
  await popup.getByRole('button',{name:'Cancel'}).click();
  await page.waitForFunction(()=>window.events.some(event=>event.type==='bindle-account-change-failed'));
  assert.equal(await page.evaluate(()=>document.querySelector('bindle-session').session!==null),true,'the current session stays');
  assert.deepEqual(errors,[]);
});

test('chromium: minimal declaration: handle required, redirect only, completes on the callback page',async t=>{
  const f=await fixture(t,{providers:{'3sln.example':{declaration:'minimal'}}});if(!f)return;const {page,context,errors}=f;
  await page.goto(app+'/');await ready(page);
  assert.equal(await page.getByRole('button',{name:/^Continue with/}).count(),0);
  assert.equal(await page.getByLabel('Your Bindle identity').getAttribute('required'),'');
  let popups=0;context.on('page',()=>popups++);
  await signInForm(page,'alex');
  await page.waitForURL('https://3sln.example/oauth/authorize?request_id=**');assert.equal(popups,0,'no popup when not declared');
  await page.getByRole('button',{name:'Approve'}).click();
  await page.waitForURL(app+'/callback');await page.getByRole('button',{name:/^Account: /}).waitFor({timeout:10000});
  await page.getByRole('button',{name:/^Account: /}).click();
  assert.deepEqual(await panelActions(page),['Use another account','Use a different provider','Sign out of this app','Manage at 3sln.example']);
  await page.getByRole('button',{name:'Use another account'}).click();
  await page.getByRole('textbox',{name:'Your Bindle identity'}).waitFor();assert.equal(popups,0,'a typed handle comes first (CP-10)');
  assert.deepEqual(errors,[]);
});

test('chromium: a DPoP-bound redirect sign-in keeps its non-extractable key across the round trip (IndexedDB)',async t=>{
  const f=await fixture(t,{providers:{'3sln.example':{declaration:'full',fedcm:false}},attributes:'presentation="redirect"'});if(!f)return;const {page,mocks,requests,errors}=f,mock=mocks['https://3sln.example'];
  await page.goto(app+'/');await ready(page);
  await page.getByRole('button',{name:/^Continue with/}).click();
  await page.waitForURL('https://3sln.example/oauth/authorize?entry=**');
  const entry=[...mock.entries.values()].at(-1);assert.equal(entry.presentation,'redirect');assert.match(entry.dpopJkt,/^[A-Za-z0-9_-]{43}$/);
  await page.getByRole('button',{name:'Approve'}).click();
  await page.waitForURL(app+'/callback');await page.getByRole('button',{name:/^Account: /}).waitFor({timeout:10000});
  const bound=await page.evaluate(async()=>{const client=document.querySelector('bindle-session').client,session=client.session,key=await client.dpopKey(session.dpopJkt);const renewed=await client.refresh();return {jkt:session.dpopJkt,extractable:key.privateKey.extractable,renewed:renewed.dpopJkt===session.dpopJkt};});
  assert.deepEqual(bound,{jkt:entry.dpopJkt,extractable:false,renewed:true});
  assert.ok(requests.filter(r=>r.path==='/oauth/token').every(r=>r.dpop));
  // The parked key is removed from IndexedDB once the exchange ends.
  assert.equal(await page.evaluate(()=>new Promise(resolve=>{const open=indexedDB.open('bindle-sdk',1);open.onsuccess=()=>{const request=open.result.transaction('dpop-keys').objectStore('dpop-keys').count();request.onsuccess=()=>resolve(request.result);};})),0);
  assert.deepEqual(errors,[]);
});

test('chromium: partial declarations: login without select-account, and a profile with only the sign-in part',async t=>{
  const f=await fixture(t,{providers:{'3sln.example':{supportedIntents:['login'],components:componentsDeclaration('https://3sln.example',{parts:['sign-in'],binding:false})}}});if(!f)return;const {page,mocks,embedRequests,errors}=f,mock=mocks['https://3sln.example'];
  await page.goto(app+'/popup');await ready(page);
  const caps=await page.evaluate(()=>document.querySelector('bindle-session').capabilities);
  assert.ok(caps.islands.signIn);assert.equal(caps.islands.avatar,null);assert.equal(caps.islands.switcher,null);
  assert.equal(await page.evaluate(()=>document.querySelector('bindle-sign-in').state.islands),'mounting','the sign-in island mounts; the standard button shows meanwhile');
  await popupSignIn(f,()=>page.getByRole('button',{name:'Continue with 3sln.example'}).click());
  await page.getByRole('button',{name:/^Account: /}).click();
  await popupSignIn(f,()=>page.getByRole('button',{name:'Use another account'}).click());
  const last=[...mock.entries.values()].at(-1);assert.equal(last.intent,'login');assert.equal(last.loginHint,undefined);
  assert.ok(embedRequests.every(url=>/^https:\/\/embed\.3sln\.example\/embed\?client=[^#]+$/.test(url)),'only the sign-in shell, never avatar or switcher (no credential binding)');assert.deepEqual(errors,[]);
});

test('chromium: unsupported and below-floor providers are errors without a window or fallback; a 404 host offers only the default host',async t=>{
  const f=await fixture(t,{providers:{'3sln.example':{declaration:'standard'},'v2.example':{manifestPatch:{version:'2'}},'below.example':{manifestPatch:{login_presentation:['popup']}},'nofloor.example':{manifestPatch:{authorization_request_endpoint:undefined}},'mail.example':404}});if(!f)return;const {page,context,errors}=f;
  await page.goto(app+'/popup');await ready(page);
  let popups=0;context.on('page',()=>popups++);
  for(const host of ['v2.example','below.example','nofloor.example']){
    await signInForm(page,`alex@${host}`);
    await page.waitForFunction(()=>document.querySelector('bindle-sign-in').shadowRoot.querySelector('[role=alert]').textContent);
    assert.equal(await page.evaluate(()=>document.querySelector('bindle-sign-in').shadowRoot.querySelector('[role=alert]').textContent),"This provider isn't supported.",host);
    await page.getByLabel('Your Bindle identity').fill('');
  }
  assert.equal(popups,0);assert.equal(await page.evaluate(()=>window.events.some(event=>event.type==='bindle-email-fallback')),false);
  await signInForm(page,'alex@mail.example');
  await page.waitForFunction(()=>window.events.some(event=>event.type==='bindle-email-fallback'));
  const fallback=await page.evaluate(()=>window.events.find(event=>event.type==='bindle-email-fallback').detail);
  assert.equal(fallback.provider,'https://3sln.example');assert.equal(fallback.identity.handle,'alex@mail.example');
  assert.equal(popups,0);assert.deepEqual(errors,[]);
});

// Relative luminance contrast from computed colours normalised through a canvas (handles oklch/light-dark).
const tileColors=page=>page.evaluate(()=>{
  const tile=document.querySelector('bindle-account').shadowRoot.querySelector('.avatar'),style=getComputedStyle(tile),ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
  const rgb=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle='#000';ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
  const lum=c=>{const [r,g,b]=c.map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};
  const bg=rgb(style.backgroundColor),fg=rgb(style.color),[hi,lo]=[lum(bg),lum(fg)].sort((a,b)=>b-a);
  return {bg:bg.join(','),ratio:(hi+0.05)/(lo+0.05),border:style.borderTopWidth,borderStyle:style.borderTopStyle,text:tile.textContent};
});
for(const engine of [chromium,firefox])test(`${engine.name()}: identity tile: initials, ≥4.5:1 in both schemes, live scheme changes, embedder color-scheme, theme attribute, forced colours`,async t=>{
  const f=await fixture(t,{engine,providers:{'3sln.example':{declaration:'standard',profile:true}}});if(!f)return;const {page,errors}=f;
  await page.goto(app+'/popup');await ready(page);
  await popupSignIn(f,()=>signInForm(page,'alex'));
  await page.emulateMedia({colorScheme:'light'});const light=await tileColors(page);
  await page.emulateMedia({colorScheme:'dark'});const dark=await tileColors(page);
  assert.equal(light.text,'AE');assert.notEqual(light.bg,dark.bg,'the tile follows prefers-color-scheme live');
  assert.ok(light.ratio>=4.5,`light ${light.ratio}`);assert.ok(dark.ratio>=4.5,`dark ${dark.ratio}`);
  await page.screenshot({path:resolve(artifacts,`provider-matrix-tile-dark-${engine.name()}.png`)});
  // An embedder that declares color-scheme: light on the host keeps the light tones under a dark OS.
  await page.evaluate(()=>{document.querySelector('bindle-account').style.colorScheme='light';document.querySelector('bindle-account').attributeChangedCallback();});
  assert.equal((await tileColors(page)).bg,light.bg);
  // The theme attribute forces the scheme regardless.
  await page.emulateMedia({colorScheme:'light'});await page.evaluate(()=>{const a=document.querySelector('bindle-account');a.style.colorScheme='';a.setAttribute('theme','dark');});
  assert.equal((await tileColors(page)).bg,dark.bg);
  await page.emulateMedia({forcedColors:'active'});const forced=await tileColors(page);
  assert.notEqual(forced.border,'0px');assert.equal(forced.borderStyle,'solid');
  await page.screenshot({path:resolve(artifacts,`provider-matrix-tile-forced-${engine.name()}.png`)});
  assert.deepEqual(errors,[]);
});
