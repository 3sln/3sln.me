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
  await waitForApp(page);await page.waitForFunction(async()=>Boolean((await navigator.serviceWorker.getRegistration())?.active));await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.reload();await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  const urls=await publicAssetCache(page);assert.ok(urls.some(url=>/^\/assets\/apps\/web\/src\/release\.[a-f0-9]+\.mjs$/.test(new URL(url).pathname)),'shell cached');
  assert.ok(urls.every(url=>!new URL(url).pathname.startsWith('/api/')),'private APIs not cached');
  const imports=await page.evaluate(()=>JSON.parse(document.querySelector('script[type=importmap]').textContent).imports);
  for(const path of ['/src/bl/identity.mjs','/packages/recovery/identity-backup.mjs','/packages/identity/handles.mjs'])assert.ok(urls.some(url=>new URL(url).pathname===imports[path]),'hashed identity shell dependency cached');
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
test('explicit signup entry is branded and localized, returns to sign-in, and respects closed registration',async t=>{const context=await browser.newContext();t.after(()=>context.close());await context.addInitScript(()=>localStorage.setItem('personal-space-preferences',JSON.stringify({locale:'es'})));const page=await context.newPage();let signups=0;await page.route('**/api/config',route=>route.fulfill({json:{localDevelopment:true,signupEnabled:false,emailEnabled:false,brand:{name:'My Space',host:'self.example'},handleOriginHost:'self.example'}}));await page.route('**/api/session',route=>route.fulfill({json:{authenticated:false,account:null}}));await page.route('**/api/auth/signup',route=>{signups++;return route.fulfill({status:403,json:{message:'closed'}});});await page.goto(baseURL+'/?signin');await page.getByRole('button',{name:'Crear una cuenta en My Space',exact:true}).click();await page.getByRole('heading',{name:'Tu espacio empieza aquí.',exact:true}).waitFor();assert.equal(await page.locator('input[type=email]').count(),0);assert.equal(await page.locator('input[autocomplete=username]').count(),0);assert.equal(await page.getByRole('button',{name:'Crear mi cuenta',exact:true}).isDisabled(),true);await page.getByText('Este servicio todavía no permite crear cuentas.',{exact:true}).waitFor();await page.locator('.auth-card .auth-switch').getByRole('button',{name:'Iniciar sesión',exact:true}).click();await page.getByRole('button',{name:'Crear una cuenta en My Space',exact:true}).waitFor();await page.getByRole('heading',{name:'Qué bueno verte.',exact:true}).waitFor();assert.equal(await page.locator('.auth-card input[name=handle]').count(),1);assert.equal(signups,0);});
test('MCP sign-in permits explicit account creation and back navigation without approving app access',async t=>{const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();let mutations=0;await page.route('**/api/config',route=>route.fulfill({json:{localDevelopment:true,signupEnabled:false,emailEnabled:false,brand:{name:'3sln.me',host:'3sln.me'}}}));await page.route('**/api/session',route=>route.fulfill({json:{authenticated:false,account:null}}));await page.route('**/api/mcp/**',route=>{mutations++;return route.fulfill({status:401,json:{message:'Sign in first.'}});});await page.goto(baseURL+'/mcp/consent#request='+'A'.repeat(43));await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();await screenshot(page,'explicit-account-creation-signin');await page.getByRole('button',{name:'Create a 3sln.me account',exact:true}).click();await page.getByRole('heading',{name:'Your space starts here.',exact:true}).waitFor();assert.equal(await page.locator('.auth-card input[name=handle]').count(),0);assert.equal(await page.locator('.auth-card input[type=email]').count(),0);assert.equal(new URL(page.url()).pathname,'/mcp/consent');await page.locator('.auth-card .auth-switch').getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();assert.equal(mutations,0);});
// Explicit pending-setup API/worker capability fixtures; these exercise the real
// portal in Chrome without claiming email transport or push-provider delivery.
async function pendingContactFixture(t,{locale='en',push=false,oldWorker=false}={}){const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());await context.addInitScript(({locale,oldWorker})=>{sessionStorage.setItem('3sln-setup',JSON.stringify({token:'limited-fixture-pending-token',stage:'recovery'}));localStorage.setItem('personal-space-preferences',JSON.stringify({locale}));window.setupPermissionCalls=0;const original=Notification.requestPermission.bind(Notification);Notification.requestPermission=(...args)=>{window.setupPermissionCalls++;return original(...args);};if(oldWorker)Object.defineProperty(navigator.serviceWorker,'ready',{value:Promise.resolve({active:{postMessage(){}}})});},{locale,oldWorker});const page=await context.newPage();page.setDefaultTimeout(10000);const accountId='550e8400-e29b-41d4-a716-446655440001';let verified=false,starts=0,activations=0,downloads=0;await page.route('**/api/config',route=>route.fulfill({json:{localDevelopment:true,signupContactRequired:true,emailSetupAvailable:true,pushSetupAvailable:push,vapidPublicKey:'fixture-public-key',brand:{name:'3sln.me',host:'3sln.me'}}}));await page.route('**/api/session',route=>route.fulfill({json:{authenticated:false}}));await page.route('**/api/auth/setup/status',route=>route.fulfill({json:{accountId,channelRequired:true,channelVerified:verified,verifiedEmail:verified?'person@person.example':null,pushVerified:false,emailAvailable:true,pushAvailable:push}}));await page.route('**/api/auth/setup/email/start',route=>{starts++;assert.equal(route.request().postDataJSON().email,'person@person.example');return route.fulfill({json:{sent:true}});});await page.route('**/api/auth/setup/email/confirm',route=>{if(route.request().postDataJSON().code!=='12345678')return route.fulfill({status:400,json:{message:'That email code is incorrect.'}});verified=true;return route.fulfill({json:{channelVerified:true}});});await page.route('**/api/auth/setup/push/start',route=>{starts++;return route.fulfill({json:{sent:true}});});await page.route('**/api/auth/recovery/download',route=>{downloads++;return route.fulfill({json:{fileName:'recovery.json',account:{id:accountId,handle:'n.abc'},recoveryToken:accountId+'.'+'A'.repeat(43)}});});await page.route('**/api/auth/recovery/confirm',route=>{activations++;return route.fulfill({status:403,json:{message:'Not activated by this fixture.'}});});await page.goto(baseURL+'/recovery/setup?email=untrusted@untrusted.example');await page.getByRole('heading',{name:locale==='es'?'Elige cómo podemos contactarte.':'Choose how we can reach you.',exact:true}).waitFor();return {page,counts:()=>({verified,starts,activations,downloads})};}
test('pending account requires server email proof, preserves wrong-code input, localizes policy and never opens a session',async t=>{const {page,counts}=await pendingContactFixture(t,{locale:'es'});assert.equal(await page.locator('.app-shell').count(),0);assert.equal(counts().downloads,0);assert.equal(await page.evaluate(()=>window.setupPermissionCalls),0);await page.getByText('En las cuentas gratuitas, podríamos contactarte periódicamente para preguntar si sigues usando la cuenta.',{exact:true}).waitFor();await screenshot(page,'account-contact-setup-es');await page.locator('input[name=email]').fill('person@person.example');await page.getByRole('button',{name:'Enviar código de verificación',exact:true}).click();await page.getByText('Busca en tu correo el código de verificación de ocho dígitos.',{exact:true}).first().waitFor();await page.locator('input[name=code]').fill('87654321');await page.getByRole('button',{name:'Verificar correo',exact:true}).click();await page.getByText('Ese código de correo es incorrecto.',{exact:true}).waitFor();assert.equal(await page.locator('input[name=code]').inputValue(),'87654321');assert.equal(counts().verified,false);assert.equal(counts().downloads,0);await page.locator('input[name=code]').fill('12345678');await page.getByRole('button',{name:'Verificar correo',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.recovery-question'));assert.equal(counts().verified,true);assert.equal(counts().downloads,1);assert.equal(counts().activations,0);assert.equal(await page.locator('.app-shell').count(),0);assert.equal(page.url().includes('12345678'),false);});
test('old active service worker cannot falsely verify push and offers email without requesting permission',async t=>{const {page,counts}=await pendingContactFixture(t,{push:true,oldWorker:true});await page.getByRole('button',{name:'Use notifications',exact:true}).click();await page.getByRole('button',{name:'Enable notifications',exact:true}).click();await page.getByText('A browser update is needed for verification notifications. Close other tabs and reload, or use email.',{exact:true}).waitFor();await page.getByRole('button',{name:'Send verification code',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.setupPermissionCalls),0);assert.equal(counts().starts,0);assert.equal(counts().activations,0);assert.equal(counts().downloads,0);});
test('public entry selectors have clear spacing and touch targets and every signup mode fits 320px',async t=>{const context=await browser.newContext();t.after(()=>context.close());await context.addInitScript(()=>{if(!localStorage.getItem('personal-space-preferences'))localStorage.setItem('personal-space-preferences',JSON.stringify({locale:'es'}));window.permissionPrompts=0;Notification.requestPermission=async()=>{window.permissionPrompts++;return 'denied';};});const page=await context.newPage();await page.route('**/api/config',route=>route.fulfill({json:{localDevelopment:true,signupEnabled:true,signupContactRequired:true,emailSetupAvailable:true,pushSetupAvailable:true,brand:{name:'3sln.me',host:'3sln.me'}}}));await page.route('**/api/session',route=>route.fulfill({json:{authenticated:false}}));await page.goto(baseURL+'/?signin');await page.getByRole('heading',{name:'Qué bueno verte.',exact:true}).waitFor();assert.equal(await page.locator('.landing-nav a[href="#the-idea"]').count(),0);for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.locator('.language-switch').inputValue(),'es');assert.equal(await page.locator('.landing-story h1 em').textContent(),'tuyo.');const select=await page.locator('.language-switch').boundingBox();assert.ok(select.width>=88&&select.height>=44);await page.locator('.language-switch').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineWidth),'3px');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const suffix=await page.locator('.landing-nav .logo-suffix').evaluate(node=>({height:node.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(node).fontSize)}));assert.ok(suffix.height<suffix.fontSize*1.8,'logo suffix must remain one line');await page.evaluate(()=>document.activeElement?.blur());await screenshot(page,'landing-signin-es-'+width);}await page.getByRole('button',{name:'Crear una cuenta en 3sln.me',exact:true}).click();await page.getByRole('heading',{name:'Tu espacio empieza aquí.',exact:true}).waitFor();for(const mode of ['email','push']){await page.getByRole('button',{name:mode==='email'?'Usar correo':'Usar notificaciones',exact:true}).click();await page.getByRole('button',{name:mode==='email'?'Usar correo':'Usar notificaciones',exact:true,pressed:true}).waitFor();assert.equal(await page.getByRole('button',{name:mode==='email'?'Usar correo':'Usar notificaciones',exact:true}).getAttribute('aria-pressed'),'true');if(mode==='email')await page.getByLabel('Correo para los avisos de la cuenta',{exact:true}).fill('person@setup.example');for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await screenshot(page,'landing-signup-'+mode+'-es-'+width);}}await page.getByRole('button',{name:'Contraseña',exact:true}).click();await page.getByLabel('Contraseña',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.evaluate(()=>window.permissionPrompts),0);await page.locator('.language-switch').selectOption('en');await page.getByRole('heading',{name:'Your space starts here.',exact:true}).waitFor();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('personal-space-preferences')).locale==='en');await page.goto(baseURL+'/?signin');await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('.language-switch').inputValue(),'en');const suffix=await page.locator('.landing-nav .logo-suffix').evaluate(node=>({height:node.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(node).fontSize)}));assert.ok(suffix.height<suffix.fontSize*1.8);await page.evaluate(()=>document.activeElement?.blur());await screenshot(page,'landing-signin-en-'+width);}});



test('interaction-only flexible CAPTCHA fits every auth flow and preserves challenges on resize',async t=>{
  const context=await browser.newContext({viewport:{width:320,height:844}});t.after(()=>context.close());
  const page=await context.newPage();page.setDefaultTimeout(8000);
  await page.route('**/api/config',route=>route.fulfill({json:{environment:'Production-like CAPTCHA sizing fixture',brand:{name:'3sln.me'},turnstileSiteKey:'fixture-site-key',localDevelopment:false,signupEnabled:true,emailEnabled:true,deviceLoginEnabled:true,providers:{}}}));
  await page.route('**/api/session',route=>route.fulfill({json:{account:null}}));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',route=>route.fulfill({contentType:'application/javascript',body:`window.fixtureCaptcha={renders:[],removals:[]};window.turnstile={render(node,options){const id=String(window.fixtureCaptcha.renders.length+1);window.fixtureCaptcha.renders.push({id,size:options.size,appearance:options.appearance,action:options.action});const iframe=document.createElement('iframe');iframe.title='Security verification';iframe.style.cssText='width:100%;min-width:300px;height:65px;border:0;display:none';iframe.srcdoc='<body style="margin:0;background:#eee">Security verification</body>';node.append(iframe);node.fixtureInteract=()=>{options['before-interactive-callback']();iframe.style.display='block';options.callback('fixture-completed-proof');};node.fixtureFinish=()=>{iframe.style.display='none';options['after-interactive-callback']();};return id;},remove(id){window.fixtureCaptcha.removals.push(id);document.querySelector('[data-widget-id="'+id+'"] iframe')?.remove();}};` }));
  await page.goto(baseURL+'/?signin');await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();await page.locator('.cf-turnstile iframe').waitFor({state:'attached'});
  for(const flow of ['signin','signup','email','device']){
    if(flow==='signup'){await page.getByRole('button',{name:/^Create a .* account$/}).click();await page.getByRole('heading',{name:'Your space starts here.',exact:true}).waitFor();}
    if(flow==='email'){await page.locator('.auth-card').getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Sign in by email',exact:true}).click();await page.getByRole('heading',{name:'An invitation back home.',exact:true}).waitFor();}
    if(flow==='device'){await page.getByRole('button',{name:'Back to sign in',exact:true}).click();await page.getByRole('button',{name:'Use phone / TV QR',exact:true}).click();await page.getByRole('heading',{name:'Bring your account to this screen.',exact:true}).waitFor();}
    await page.locator('.cf-turnstile iframe').waitFor({state:'attached'});
    assert.equal(await page.locator('.cf-turnstile iframe').isVisible(),false,'Automated checks need no visible widget');assert.equal(await page.locator('.cf-turnstile').evaluate(node=>getComputedStyle(node).marginTop),flow==='device'?'0px':'-17px');await screenshot(page,'turnstile-hidden-'+flow+'-320');
    await page.locator('.cf-turnstile').evaluate(node=>node.fixtureInteract());
    const baseline=await page.evaluate(()=>window.fixtureCaptcha.renders.length);
    for(const width of [320,390,1440,320]){
      await page.setViewportSize({width,height:900});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${flow} CAPTCHA overflows at ${width}px`);
      const box=await page.locator('.cf-turnstile iframe').boundingBox();assert.ok(box.width>=300);assert.equal(box.height,65);assert.ok(box.x>=0&&box.x+box.width<=width);
      const container=await page.locator('.cf-turnstile').boundingBox();assert.equal(box.width,container.width,'Rectangular challenge fills its container');
      assert.equal(await page.locator('.cf-turnstile').evaluate(el=>getComputedStyle(el).overflow),'visible');
      assert.equal(await page.evaluate(()=>window.fixtureCaptcha.renders.length),baseline,'Resize must not recreate a completed challenge');
    }
    await screenshot(page,'turnstile-flexible-'+flow+'-320');await page.locator('.cf-turnstile').evaluate(node=>node.fixtureFinish());
  }
  assert.ok((await page.evaluate(()=>window.fixtureCaptcha.renders)).every(widget=>widget.size==='flexible'&&widget.appearance==='interaction-only'));
});


test('contact profile is literal scoped optional metadata with no automatic avatar requests',async t=>{
 const invitation='/users/reader/contact/11111111-1111-1111-1111-111111111111?sig=private-profile-fixture';
 const claims={collections:['inbox'],mimeTypes:['text/plain'],maxMessageBytes:65536},token=`e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
 for(const scenario of ['shared','long','partial','disabled','failure','expired']){
  const context=await browser.newContext({viewport:{width:320,height:1000}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(8000);let profiles=0,avatarRequests=0;
  await context.addInitScript(()=>localStorage.setItem('personal-space-preferences',JSON.stringify({locale:'es'})));
  await page.route('https://images.example/**',route=>{avatarRequests++;return route.abort();});
  await page.route('**/api/config',route=>route.fulfill({json:{origin:baseURL,providers:{}}}));
  await page.route('**/api/session',route=>route.fulfill({json:{account:scenario==='shared'?{id:'owner-fixture',handle:'owner'}:null}}));
  await page.route('**/api/account',route=>route.fulfill({json:{account:{id:'owner-fixture',handle:'owner'},collections:[],messages:[],contacts:[],rules:[],resources:[]}}));
  await page.route('**'+invitation,route=>{
   const accept=route.request().headers().accept;
   if(accept==='application/vnd.bindle.contact-token+jwt')return route.fulfill(scenario==='expired'?{status:403,body:'Expired'}:{body:token,contentType:'application/vnd.bindle.contact-token+jwt'});
   if(accept==='application/vnd.bindle.contact-profile+json'){profiles++;return route.fulfill(scenario==='failure'?{status:503,body:'Unavailable'}:{json:{identityURI:'https://forged.example',profile:scenario==='disabled'?null:scenario==='long'?{displayName:'Z'.repeat(100)}:scenario==='partial'?{bio:'Sign in',unknown:'not shared'}:{displayName:'<img src=x onerror=alert(1)>',bio:'Sign in',avatar:'https://images.example/avatar.png'}},contentType:'application/vnd.bindle.contact-profile+json'});}
   return route.continue();
  });
  await page.goto(baseURL+invitation);await page.getByText('Identidad del contacto: reader',{exact:true}).waitFor();assert.equal(new URL(page.url()).search,'');
  if(scenario==='expired'){await page.getByText('La invitación está incompleta, vencida o revocada. Pide un enlace firmado vigente.').waitFor();assert.equal(profiles,0);assert.equal(await page.getByRole('button',{name:'Enviar mensaje',exact:true}).count(),0);}
  else{await page.getByRole('button',{name:'Enviar mensaje',exact:true}).waitFor();if(scenario==='shared'||scenario==='partial'){await page.getByText('Compartido por este enlace de contacto',{exact:true}).waitFor();assert.equal(await page.locator('.contact-profile-bio').textContent(),'Sign in','User biography must not be translated');}if(scenario==='long'){await page.getByRole('heading',{name:'Envía un mensaje a '+'Z'.repeat(100)+'.',exact:true}).waitFor();await screenshot(page,'contact-profile-long-es-320');}if(scenario==='shared'){await page.getByRole('heading',{name:'Envía un mensaje a <img src=x onerror=alert(1)>.',exact:true}).waitFor();assert.equal(await page.locator('.contact-recipient-profile strong').textContent(),'<img src=x onerror=alert(1)>');assert.equal(await page.locator('.contact-recipient-profile img').count(),0);const avatar=page.getByRole('link',{name:'Ver avatar compartido',exact:true});assert.equal(await avatar.getAttribute('rel'),'noreferrer noopener');await screenshot(page,'contact-profile-shared-es-320');}else assert.equal(await page.getByRole('link',{name:'Ver avatar compartido',exact:true}).count(),0);}
  assert.equal(avatarRequests,0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('[href*="forged.example"]').count(),0);
 }
});

test('public pages follow system theme with readable controls and preserve the CAPTCHA when preference changes',async t=>{
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'light'});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(8000);
 await context.addInitScript(()=>localStorage.setItem('personal-space-preferences',JSON.stringify({locale:'es'})));
 await page.route('**/api/config',route=>route.fulfill({json:{origin:baseURL,brand:{name:'3sln.me',host:'3sln.me'},turnstileSiteKey:'theme-fixture',localDevelopment:false,providers:{}}}));
 await page.route('**/api/session',route=>route.fulfill({json:{account:null}}));
 await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',route=>route.fulfill({contentType:'application/javascript',body:`window.themeCaptchaRenders=0;window.turnstile={render(node,options){window.themeCaptchaRenders++;options.callback('unchanged-theme-proof');return String(window.themeCaptchaRenders);},remove(){}};`}));
 await page.goto(baseURL+'/?signin');await page.getByRole('heading',{name:'Qué bueno verte.',exact:true}).waitFor();await page.waitForFunction(()=>window.themeCaptchaRenders>0);await page.getByRole('button',{name:'Contraseña',exact:true}).click();await page.getByLabel('Contraseña',{exact:true}).waitFor();
 const renders=await page.evaluate(()=>window.themeCaptchaRenders);
 const assertContrast=async selector=>{const ratio=await page.locator(selector).first().evaluate(node=>{const style=getComputedStyle(node),rgb=color=>color.match(/[\d.]+/g).slice(0,3).map(Number),luminance=color=>rgb(color).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);let background=style.backgroundColor,ancestor=node;while((background==='rgba(0, 0, 0, 0)'||background==='transparent')&&ancestor.parentElement){ancestor=ancestor.parentElement;background=getComputedStyle(ancestor).backgroundColor;}const a=luminance(style.color),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);});assert.ok(ratio>=4.5,`${selector} contrast ${ratio}`);};
 for(const theme of ['light','dark']){
  await page.emulateMedia({colorScheme:theme});await page.waitForFunction(expected=>getComputedStyle(document.documentElement).colorScheme===expected,theme);
  for(const width of [1440,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await assertContrast('.auth-card .input');await assertContrast('.auth-card .button.primary');await assertContrast('.auth-card .button.secondary');await assertContrast('.language-switch');assert.equal(await page.locator('.language-switch').evaluate(node=>getComputedStyle(node).backgroundSize),'12px 12px');assert.equal(await page.locator('.language-switch').evaluate(node=>getComputedStyle(node).backgroundRepeat),'no-repeat');await assertContrast('.hero-copy');await assertContrast('.floating-tile b');await page.locator('.language-switch').focus();assert.equal(await page.locator('.language-switch').evaluate(node=>getComputedStyle(node).outlineWidth),'3px');await page.evaluate(()=>document.activeElement.blur());await screenshot(page,`system-theme-${theme}-es-${width}`);}
  const logo=page.locator('.landing-nav .logo img');await page.waitForFunction(dark=>document.querySelector('.landing-nav .logo img').currentSrc.includes('ondark')===dark,theme==='dark');
  await page.locator('.auth-card .button.primary').hover();await assertContrast('.auth-card .button.primary');assert.equal(await page.evaluate(()=>window.themeCaptchaRenders),renders,'Changing device theme must preserve the challenge');
 }
 const invitation='/users/theme-owner/contact/11111111-1111-1111-1111-111111111111?sig=theme-private';const token=`e30.${Buffer.from(JSON.stringify({collections:['inbox'],mimeTypes:['text/plain']})).toString('base64url')}.signature`;
 await page.route('**'+invitation,route=>{const accept=route.request().headers().accept;if(accept==='application/vnd.bindle.contact-token+jwt')return route.fulfill({body:token,contentType:accept});if(accept==='application/vnd.bindle.contact-profile+json')return route.fulfill({json:{profile:{displayName:'Destinatario',bio:'Perfil compartido'}},contentType:accept});return route.continue();});
 await page.goto(baseURL+invitation);await page.getByRole('heading',{name:'Envía un mensaje a Destinatario.',exact:true}).waitFor();await assertContrast('.contact-recipient-profile strong');await assertContrast('.contact-profile-bio');await assertContrast('.auth-card .input');await screenshot(page,'system-theme-dark-contact-es-320');
 for(const path of ['/recovery/setup','/mcp/consent']){await page.goto(baseURL+path);await page.locator('.auth-card,.mcp-consent').first().waitFor();assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'dark');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await screenshot(page,'system-theme-dark-'+(path.includes('recovery')?'recovery':'mcp')+'-320');}
 await page.route('**/api/session',route=>route.fulfill({json:{account:{id:'theme-owner',handle:'owner'}}}));await page.route('**/api/account',route=>route.fulfill({json:{account:{id:'theme-owner',handle:'owner'},collections:[],messages:[],contacts:[],rules:[],resources:[]}}));await page.goto(baseURL);await page.locator('.app-shell').waitFor();assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light');assert.equal(await page.locator('.sidebar .logo img').evaluate(node=>node.currentSrc.includes('ondark')),false,'Console retains its reviewed light logo');

});
