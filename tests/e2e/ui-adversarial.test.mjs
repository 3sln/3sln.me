import test from 'node:test';
import assert from 'node:assert/strict';
import {launch,baseURL,waitForApp,screenshot,publicAssetCache} from './browser.mjs';

// Real Chromium renders actual application assets. API interception is restricted
// to explicitly labeled fault-injection cases; worker-flow covers real endpoints.
let browser;
test.before(async()=>{browser=await launch();});
test.after(async()=>{await browser?.close();});
async function pageWithAccount(t,overrides={}){
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[],'No browser runtime errors'));
  const account={id:'redteam-account',handle:'redteam',status:'active',hasPassword:true,passkeyCount:0};
  await page.route('**/api/config',route=>route.fulfill({json:{environment:'Adversarial browser fixture',termsVersion:'2026-10-11',providers:{}}}));
  await page.route('**/api/session',route=>route.fulfill({json:{account,csrfToken:'fixture-csrf'}}));
  await page.route('**/api/account',route=>route.fulfill({json:{account,collections:[{id:'inbox',name:'Inbox'}],messages:[],contacts:[],rules:[],resources:[],grants:[],...overrides}}));
  await waitForApp(page);await page.getByRole('heading',{name:'A quieter inbox.'}).waitFor();
  return {page,context};
}
test('public landing and mobile layout fit viewport',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[],'No browser runtime errors'));
  await waitForApp(page);await screenshot(page,'landing-desktop');
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await screenshot(page,`landing-mobile-${width}`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`landing overflows at ${width}px`);
  }
});
test('dialog has accessible name, traps focus, and returns focus after Escape',async t=>{
  const {page}=await pageWithAccount(t);const opener=page.getByRole('button',{name:'New collection',exact:true});
  await opener.click();const dialog=page.getByRole('dialog');await dialog.waitFor();
  const title=await dialog.getAttribute('aria-labelledby');assert.ok(title);
  assert.ok(await page.locator(`#${title}`).count(),'dialog accessible name references an existing title');
  const controls=dialog.locator('button,input,select,textarea,a[href]');await page.waitForFunction(()=>document.activeElement?.closest('[role=dialog]'));await controls.last().focus();await page.keyboard.press('Tab');
  assert.ok(await controls.first().evaluate(el=>el===document.activeElement),'Tab stays inside dialog');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='New collection');
  assert.ok(await opener.evaluate(el=>el===document.activeElement),'Escape restores focus to opener');
});
test('expired session erases private content and returns to sign in',async t=>{
  const {page}=await pageWithAccount(t,{collections:[{id:'inbox',name:'Private collection sentinel'}]});
  await page.route('**/api/collections',route=>route.fulfill({status:401,json:{error:'unauthorized',message:'Sign in to continue.'}}));
  await page.getByRole('button',{name:'New collection',exact:true}).click();await page.getByLabel('Collection name').fill('Try expired session');
  await page.getByRole('button',{name:'Create collection',exact:true}).click();
  await page.locator('.auth-card').waitFor();assert.equal(await page.getByText('Private collection sentinel',{exact:true}).count(),0);
});
test('double submission cannot create two mutations',async t=>{
  const {page}=await pageWithAccount(t);let requests=0;
  await page.route('**/api/collections',async route=>{requests++;await new Promise(resolve=>setTimeout(resolve,150));await route.fulfill({json:{collection:{id:'test',name:'One collection'}}});});
  await page.getByRole('button',{name:'New collection',exact:true}).click();await page.getByLabel('Collection name').fill('One collection');
  await page.locator('.modal form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
  await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(requests,1);
});
test('offline clears private message state and cache excludes private endpoints',async t=>{
  const {page,context}=await pageWithAccount(t,{collections:[{id:'inbox',name:'Private offline sentinel'}]});
  await context.setOffline(true);await page.getByText(/You’re offline/).waitFor();
  assert.equal(await page.getByText('Private offline sentinel',{exact:true}).count(),0);
  const urls=await publicAssetCache(page);assert.equal(urls.filter(url=>new URL(url).pathname.startsWith('/api/')).length,0);
  await screenshot(page,'offline-private-data-cleared');
});
test('incomplete message metadata does not break rendering',async t=>{
  const {page}=await pageWithAccount(t,{messages:[{id:'message',mimeType:'text/plain',size:8,receivedAt:null}]});
  await page.getByRole('button',{name:/Text message/}).waitFor();
  assert.ok(await page.getByRole('heading',{name:'A quieter inbox.'}).isVisible());
});
test('authenticated mobile navigation and forms fit viewport',async t=>{
  const {page}=await pageWithAccount(t);await page.setViewportSize({width:390,height:844});
  await screenshot(page,'inbox-mobile');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'New collection',exact:true}).click();await screenshot(page,'dialog-mobile');
  assert.ok(await page.getByLabel('Collection name').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});
test('hostile HTML is readable in the sandbox without script execution or external requests',async t=>{
  const {renderMessage}=await import('../../packages/messaging/content.mjs');
  const message={id:'12345678-1234-1234-1234-123456789abc',mimeType:'text/html',size:100,receivedAt:Date.now(),tags:[],readAt:1};
  const {page}=await pageWithAccount(t,{messages:[message]});let leaked=false;
  page.on('request',request=>{if(request.url().includes('leak.example'))leaked=true;});
  const render=renderMessage({mimeType:'text/html',bytes:new TextEncoder().encode('<h1>Safe heading</h1><img src="https://leak.example/pixel"><script>parent.__messageExecuted=true</script>')});
  await page.route(`**/api/messages/${message.id}`,route=>route.fulfill({json:{message,render}}));
  await page.getByRole('button',{name:/New message/}).click();
  await page.frameLocator('iframe[title="Message content"]').getByRole('heading',{name:'Safe heading'}).waitFor();
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'');assert.equal(await page.evaluate(()=>Boolean(window.__messageExecuted)),false);assert.equal(leaked,false);
});
test('installed public shell reloads offline without cached account responses',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(8000);
  await waitForApp(page);await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  const urls=await publicAssetCache(page);assert.ok(urls.some(url=>new URL(url).pathname==='/src/release.mjs'),'shell cached');
  assert.ok(urls.every(url=>!new URL(url).pathname.startsWith('/api/')),'private APIs not cached');
  await context.setOffline(true);await page.reload();await page.getByText(/You’re offline/).waitFor();await page.locator('.auth-card').waitFor();
  assert.equal(await page.getByRole('button',{name:'Create my account'}).isDisabled(),true);await screenshot(page,'offline-shell');
});
test('contact composer keeps the same delivery key after a failed response and never sends on GET',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(8000);
  const claims={collections:['inbox'],mimeTypes:['text/plain'],maxMessageBytes:65536};const token=`e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const invitation=`/users/reader/contact/11111111-1111-1111-1111-111111111111?sig=fixture-signed-endpoint`;
  const deliveries=[];await page.route(`**${invitation}`,route=>{
    const request=route.request();
    if(request.method()==='GET'&&request.headers().accept==='application/vnd.bindle.contact-token+jwt')return route.fulfill({body:token,contentType:'application/vnd.bindle.contact-token+jwt'});
    if(request.method()!=='POST')return route.continue();
    const multipart=request.postData();assert.ok(request.headers()['content-type'].startsWith('multipart/form-data; boundary='));
    const idempotencyKey=/name="idempotencyKey"\r\n\r\n([^\r\n]+)/.exec(multipart)?.[1];assert.ok(idempotencyKey);deliveries.push({idempotencyKey,multipart});
    return route.fulfill(deliveries.length===1?{status:503,json:{message:'Try again'}}:{status:202,json:{accepted:true,id:'message'}});
  });
  await page.goto(`${baseURL}${invitation}`);await page.getByLabel('Your message').waitFor();assert.equal(deliveries.length,0);assert.equal(new URL(page.url()).searchParams.has('sig'),false);
  await page.getByLabel('Your message').fill('A short note');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByRole('heading',{name:'Your message is on its way.'}).waitFor();
  assert.equal(deliveries.length,2);assert.equal(deliveries[0].idempotencyKey,deliveries[1].idempotencyKey);
});

test('identity email availability does not claim reminder delivery',async t=>{
 const {page}=await pageWithAccount(t,{account:{id:'notification-fixture',handle:'redteam',verifiedEmail:'reader@example.test'},notificationPreferences:{enabled:true,push:{enabled:false},email:{enabled:true,delayMinutes:60,repeatHours:24,maxReminders:3},collections:[],excludeTags:[]}});
 await page.route('**/api/config',route=>route.fulfill({json:{emailEnabled:true,notificationEmailEnabled:false,providers:{}}}));await page.reload();await page.getByRole('button',{name:'Notifications',exact:true}).click();
 const email=page.getByRole('checkbox',{name:'Email reminders',exact:true});assert.equal(await email.isDisabled(),true);assert.equal(await email.isChecked(),false);await page.getByText('Email reminders are not available on this service yet.',{exact:true}).waitFor();
});
