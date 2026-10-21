// LA5 regression: real application assets, explicitly mocked legacy API contract.
// LA3's new linked routes are intentionally unmounted. New flow Actions are covered
// separately in device-requesting-engine.mjs with the production ngin client harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import {launch,baseURL,screenshot} from './browser.mjs';
let browser;
test.before(async()=>{browser=await launch();});
test.after(async()=>{await browser?.close();});
const requestId='550e8400-e29b-41d4-a716-446655440031';
for(const locale of ['en','es'])for(const width of [320,390,1440])for(const colorScheme of ['light','dark'])test(`legacy device entry: ${locale}, ${width}px, ${colorScheme}; locator QR and no approval input`,async t=>{
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme,serviceWorkers:'block'});t.after(()=>context.close());const page=await context.newPage(),calls=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/config',route=>route.fulfill({json:{origin:baseURL,localDevelopment:true,deviceAuthorizationEnabled:false,signupEnabled:true,brand:{name:'3sln.me',host:new URL(baseURL).host}}}));
 await page.route('**/api/session',route=>route.fulfill({json:{authenticated:false}}));
 await page.route('**/api/auth/device/start',route=>{calls.push(['start',route.request().postDataJSON()]);return route.fulfill({json:{deviceCode:'private-legacy-authority',requestId,userCode:'BCDF-GHJK',verificationUriComplete:baseURL+'/device#request='+requestId,expiresAt:Date.now()+60000,interval:60}});});
 await page.route('**/api/auth/device/qr',route=>{calls.push(['qr',route.request().postDataJSON()]);return route.fulfill({json:{svg:'<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="white"/><path d="M20 20h60v60H20zM140 20h60v60h-60zM20 140h60v60H20z" fill="black"/></svg>'}});});
 await page.route('**/api/auth/device/poll',route=>route.fulfill({json:{status:'authorization_pending',interval:60}}));
 await page.route('**/api/auth/device/cancel',route=>{calls.push(['cancel',route.request().postDataJSON()]);return route.fulfill({json:{cancelled:true}});});
 await page.goto(baseURL+'/console?signin&lang='+locale);assert.equal(await page.getByRole('group',{name:locale==='es'?'Este dispositivo':'This device',exact:true}).count(),0);await page.getByRole('button',{name:locale==='es'?'Usar QR de teléfono / TV':'Use phone / TV QR',exact:true}).click();await page.locator('.device-code').waitFor();
 assert.equal(await page.locator('.device-code').innerText(),'BCDF-GHJK');assert.equal(await page.locator('.device-code').getAttribute('translate'),'no');assert.equal(await page.locator('input[name=code],input[name=userCode]').count(),0,'the requesting code never sits beside an approval field (LA-R2)');
 assert.deepEqual(calls[0],['start',{label:'TV or shared screen',turnstileToken:'local-browser-test-token'}]);assert.deepEqual(calls[1],['qr',{verificationUriComplete:baseURL+'/device#request='+requestId}]);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'document fits viewport');assert.equal(await page.evaluate(()=>document.querySelector('.auth-card').scrollWidth<=document.querySelector('.auth-card').clientWidth),true,'card fits viewport');
 assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('private-legacy-authority')||document.documentElement.textContent.includes('private-legacy-authority')||location.href.includes('BCDF-GHJK')),false);
 await screenshot(page,`la5-legacy-${locale}-${width}-${colorScheme}`);const cancel=page.getByRole('button',{name:locale==='es'?'Cancelar inicio de sesión con teléfono':'Cancel phone sign-in',exact:true});await cancel.focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:locale==='es'?'Qué bueno verte.':'Good to see you.',exact:true}).waitFor();assert.equal(calls.at(-1)[0],'cancel');assert.deepEqual(errors,[]);
});
