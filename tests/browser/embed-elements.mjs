// Real-browser checks for the embeddable elements (design §15 evidence, phase 1).
// Source-intercepted fixture: app.example serves the SDK from this checkout and
// 3sln.example is testing.mjs's mock provider behind page.route. The provider-owned
// authorization entry (D1/S4) is NOT implemented server-side; everything here is
// verified against the mock only. Run: node --test tests/browser/embed-elements.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {chromium,firefox,webkit} from 'playwright';
import {createMockProvider} from '../../packages/sdk/src/testing.mjs';

const root=resolve('.'),app='https://app.example',providerOrigin='https://3sln.example',clientId=app+'/client';
const artifacts=resolve(process.env.E2E_ARTIFACTS??'artifacts/browser');await mkdir(artifacts,{recursive:true});
const types={'.mjs':'text/javascript','.js':'text/javascript'};
const appPage=redirect=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture app</title><meta name="viewport" content="width=device-width">
<style>:root{color-scheme:light dark}body{font-family:system-ui;margin:2rem;background:Canvas;color:CanvasText}.themed{--bindle-accent:color-mix(in srgb, #ff0000 50%, #0000ff);--bindle-surface:oklch(1 0 0);--bindle-text:rgb(0 0 0 / .5);--bindle-radius:12;--bindle-density:compact;--bindle-font:Comic Sans}</style>
<script type="module">import '/packages/sdk/src/define.mjs';window.events=[];for(const type of ['bindle-session-change','bindle-flow-start','bindle-flow-end','bindle-menu-toggle'])document.addEventListener(type,event=>window.events.push({type,detail:event.detail}));window.sdkReady=true;</script></head>
<body><h1>Fixture app</h1><bindle-session client-id="${clientId}" redirect-uri="${app}${redirect}" default-host="3sln.example"><bindle-account actions="switch reauth sign-out provider-sign-out manage"><bindle-sign-in slot="signed-out"></bindle-sign-in><a slot="menu-start" href="/settings">Settings</a></bindle-account></bindle-session><div class="themed" id="themed"></div></body></html>`;
// The recommended minimal callback page: no-referrer, callback.mjs first.
const callbackPage=`<!doctype html><meta charset="utf-8"><title>Signing in</title><script type="module">import {handleCallback} from '/packages/sdk/src/callback.mjs';window.callbackResult=await handleCallback();</script><body></body>`;
// Mock first-party provider page: static, COOP same-origin, account choice happens
// only here. The decision goes to a test-only route that applies the mock decision.
const providerPage=`<!doctype html><meta charset="utf-8"><title>3sln.example</title><h1>Choose an account</h1><p>Signing in to app.example</p><button id="approve">Continue as Alex</button> <button id="deny">Cancel</button>
<script>const entry=new URL(location.href).searchParams.get('entry');for(const decision of ['approve','deny'])document.getElementById(decision).onclick=async()=>{const response=await fetch('/test/decide',{method:'POST',body:JSON.stringify({entry,decision})});location.assign(await response.text());};</script>`;

async function fixture(t,browserType){
  const name=browserType.name(),chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let browser;
  try{browser=await browserType.launch({headless:true,...name==='chromium'&&!existsSync(chromium.executablePath())&&existsSync(chrome)?{executablePath:chrome}:{}});}catch(error){t.skip(`${name} unavailable: ${error.message.split('\n')[0]}`);return null;}
  t.after(()=>browser.close());
  const provider=createMockProvider({issuer:providerOrigin,clients:[{clientId,redirectUris:[app+'/callback',app+'/popup-callback']}]});
  const context=await browser.newContext({ignoreHTTPSErrors:true});
  // A provider cookie that must never ride on SDK requests (credentials:'omit').
  await context.addCookies([{name:'provider_session',value:'secret',domain:'3sln.example',path:'/',secure:true,sameSite:'None'}]);
  const requests=[],errors=[];
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===app){
      if(url.pathname==='/'||url.pathname==='/callback')return route.fulfill({contentType:'text/html',body:appPage('/callback')});
      if(url.pathname==='/popup')return route.fulfill({contentType:'text/html',body:appPage('/popup-callback')});
      if(url.pathname==='/popup-callback')return route.fulfill({contentType:'text/html',headers:{'Referrer-Policy':'no-referrer'},body:callbackPage});
      if(/^\/(?:packages\/sdk\/src|packages\/i18n|vendor\/dodo)\//.test(url.pathname)&&!url.pathname.includes('..'))return route.fulfill({contentType:types[extname(url.pathname)]??'text/plain',body:await readFile(resolve(root,'.'+url.pathname))});
      return route.fulfill({status:404,body:''});
    }
    if(url.origin===providerOrigin){
      const cors={'Access-Control-Allow-Origin':app,'Access-Control-Allow-Headers':'content-type,accept,dpop,authorization','Access-Control-Expose-Headers':'DPoP-Nonce','Access-Control-Allow-Methods':'GET,POST','Vary':'Origin'};
      if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
      if(url.pathname==='/oauth/authorize')return route.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin','Referrer-Policy':'no-referrer'},body:providerPage});
      if(url.pathname==='/test/decide'){const {entry,decision}=JSON.parse(request.postData());return route.fulfill({contentType:'text/plain',body:provider.authorize(entry,{decision})});}
      requests.push({path:url.pathname,cookie:await request.headerValue('cookie'),origin:await request.headerValue('origin')});
      const passed={};for(const name of ['content-type','dpop','authorization'])if(await request.headerValue(name))passed[name]=await request.headerValue(name);
      const response=await provider.handle(new Request(url,{method:request.method(),headers:passed,body:['GET','HEAD'].includes(request.method())?undefined:request.postDataBuffer()}));
      return route.fulfill({status:response.status,headers:{...cors,...Object.fromEntries(response.headers)},body:Buffer.from(await response.arrayBuffer())});
    }
    return route.abort();
  });
  // WebKit's newPage() hangs on some machines; skip honestly instead of timing out.
  const page=await Promise.race([context.newPage(),new Promise(resolve=>setTimeout(()=>resolve(null),15000))]);
  if(!page){t.skip(`${name}: newPage() did not return within 15 s`);return null;}
  page.on('pageerror',error=>errors.push(error.message));
  return {browser,context,page,provider,requests,errors,name};
}
const engines=[chromium,firefox,webkit];

for(const engine of engines)test(`${engine.name()}: popup sign-in completes over BroadcastChannel; nothing about accounts reaches the app before consent`,async t=>{
  const f=await fixture(t,engine);if(!f)return;const {page,context,provider,requests,errors}=f;
  await page.goto(app+'/popup');await page.waitForFunction(()=>window.sdkReady&&customElements.get('bindle-session')&&document.querySelector('bindle-session').capabilities);
  await page.getByLabel('Your Bindle identity').fill('alex');
  const popupPromise=context.waitForEvent('page');
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const popup=await popupPromise;
  await popup.getByRole('button',{name:'Continue as Alex'}).waitFor();
  // Before consent: the app has seen only its own flow-start; no account data anywhere.
  const before=await page.evaluate(()=>({events:JSON.stringify(window.events),text:document.body.innerText+[...document.querySelectorAll('*')].map(node=>node.shadowRoot?.textContent??'').join(' ')}));
  assert.ok(!before.events.includes(provider.accounts[0].subject));assert.ok(!before.text.includes('Alex Example'));
  assert.match(before.text,/A sign-in window from 3sln\.example opened\./);
  assert.equal(await popup.evaluate(()=>window.opener),null,'COOP severs the opener');
  await popup.getByRole('button',{name:'Continue as Alex'}).click();
  await page.getByRole('button',{name:/^Account: Signed in · 3sln\.example$/}).waitFor({timeout:10000});
  const after=await page.evaluate(()=>window.events.filter(event=>event.type==='bindle-flow-end').map(event=>event.detail));
  assert.deepEqual(after,[{intent:'login',outcome:'completed'}]);
  if(!popup.isClosed()){assert.equal(await popup.evaluate(()=>location.search),'','callback parameters scrubbed');assert.equal((await popup.evaluate(()=>window.callbackResult)).mode,'relay');}
  assert.ok(requests.length>=3);
  for(const request of requests)assert.equal(request.cookie,null,`${request.path} must not carry provider cookies`);
  const entry=[...provider.entries.values()][0];assert.equal(entry.presentation,'popup');assert.equal(entry.loginHint,'alex@3sln.example');
  assert.deepEqual(errors,[]);
});

for(const engine of engines)test(`${engine.name()}: blocked popup falls back to a redirect that completes on the callback page`,async t=>{
  const f=await fixture(t,engine);if(!f)return;const {page,provider,errors}=f;
  await page.addInitScript(()=>{window.open=()=>null;});
  await page.goto(app+'/');await page.waitForFunction(()=>window.sdkReady&&customElements.get('bindle-session')&&document.querySelector('bindle-session').capabilities);
  await page.getByLabel('Your Bindle identity').fill('alex');await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.waitForURL(providerOrigin+'/oauth/authorize?**');
  assert.equal([...provider.entries.values()][0].presentation,'redirect');
  await page.getByRole('button',{name:'Continue as Alex'}).click();
  await page.waitForURL(app+'/callback');
  await page.getByRole('button',{name:/^Account: /}).waitFor({timeout:10000});
  assert.equal(await page.evaluate(()=>location.search),'');
  assert.deepEqual(errors,[]);
});

test('chromium: keyboard menu, accessible names, theme token normalization, and light/dark rendering',async t=>{
  const f=await fixture(t,chromium);if(!f)return;const {page,context,errors}=f;
  await page.goto(app+'/popup');await page.waitForFunction(()=>window.sdkReady&&customElements.get('bindle-session')&&document.querySelector('bindle-session').capabilities);
  // Theme probe in a real engine: color-mix and oklch normalize, alpha is rejected,
  // non-color tokens are grammar-checked.
  const theme=await page.evaluate(async()=>{const {resolveThemeTokens}=await import('/packages/sdk/src/elements/theme-probe.mjs');return resolveThemeTokens(document.getElementById('themed'),{scheme:'light'});});
  assert.equal(theme.tokens.surface,'#ffffff');assert.equal(theme.tokens.radius,12);assert.equal(theme.tokens.density,undefined,'density is not a profile token');
  assert.match(theme.tokens.accent??'',/^#[0-9a-f]{6}$/);
  assert.ok(theme.rejected.includes('text'));assert.equal(theme.tokens.font,undefined);
  for(const scheme of ['light','dark']){
    await page.emulateMedia({colorScheme:scheme});
    const background=await page.evaluate(()=>getComputedStyle(document.querySelector('bindle-sign-in').shadowRoot.querySelector('.identity')).backgroundColor);
    assert.equal(background,scheme==='light'?'rgb(255, 255, 255)':'rgb(23, 25, 29)');
    await page.screenshot({path:resolve(artifacts,`embed-elements-sign-in-${scheme}.png`)});
  }
  await page.emulateMedia({colorScheme:'light'});
  await page.getByLabel('Your Bindle identity').fill('alex');
  const popupPromise=context.waitForEvent('page');await page.keyboard.press('Enter');
  const popup=await popupPromise;await popup.getByRole('button',{name:'Continue as Alex'}).click();
  const badge=page.getByRole('button',{name:/^Account: /});await badge.waitFor({timeout:10000});
  assert.equal(await badge.getAttribute('aria-haspopup'),'dialog');
  await badge.focus();await page.keyboard.press('Enter');
  assert.equal(await badge.getAttribute('aria-expanded'),'true');
  const list=page.getByRole('list',{name:'Account actions'});await list.waitFor();
  assert.equal(await page.getByRole('menu').count(),0);assert.equal(await page.getByRole('menuitem').count(),0);
  assert.equal(await page.evaluate(()=>document.querySelector('bindle-account').shadowRoot.querySelector('dialog.panel').matches(':popover-open')),true);
  for(const name of ['Use another account',"Confirm it's you",'Sign out of this app','Sign out of 3sln.example…'])await list.getByRole('button',{name}).waitFor();
  assert.equal(await list.getByRole('link',{name:'Manage at 3sln.example'}).getAttribute('href'),await page.evaluate(()=>document.querySelector('bindle-session').capabilities.manageUrl));
  await page.screenshot({path:resolve(artifacts,'embed-elements-menu-light.png')});
  await page.keyboard.press('Escape');
  assert.equal(await badge.getAttribute('aria-expanded'),'false');
  assert.equal(await page.evaluate(()=>document.querySelector('bindle-account').shadowRoot.activeElement?.classList.contains('trigger')),true);
  // Narrow viewport: no horizontal overflow.
  await page.setViewportSize({width:320,height:640});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
});
