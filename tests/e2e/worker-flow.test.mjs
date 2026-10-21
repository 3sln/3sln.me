import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {launch,baseURL,virtualAuthenticator,waitForApp,screenshot,publicAssetCache,completeSignupQuestions} from './browser.mjs';

// These checks intentionally run against wrangler.local.jsonc only. Never point
// this mutation suite at a deployed service. Turnstile's explicit local test
// token is injected; account auth, passkey verification and storage stay real.
let browser;
test.before(async()=>{
  const url=new URL(baseURL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname),'local Worker required');
  const config=await (await fetch(`${baseURL}/api/config`)).json();assert.equal(config.localDevelopment,true,'explicit local configuration required');
  browser=await launch();
});
test.after(async()=>{await browser?.close();});
async function setup(t){
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,extraHTTPHeaders:{'CF-Connecting-IP':process.env.E2E_CLIENT_IP||`198.51.100.${Math.floor(Math.random()*200)+20}`}});t.after(async()=>{for(const page of context.pages()){const alerts=await page.locator('[role=alert]').allTextContents().catch(()=>[]);if(alerts.length)console.log('Browser alerts:',alerts.join(' | '));}await context.close();});
  // Observe the closed renderer only in this controlled browser fixture.
  // Production author content receives neither this reference nor script access.
  await context.addInitScript(()=>{const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=attach.call(this,options);window.__fixtureMessageShadow=root;return root;};});
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>console.log('Browser runtime:',error.message));
  await page.route('https://challenges.cloudflare.com/**',route=>route.abort());
  await page.route('**/api/auth/**',async route=>{
    const request=route.request();if(request.method()!=='POST')return route.continue();
    const body=request.postDataJSON();if(Object.hasOwn(body,'turnstileToken'))body.turnstileToken='local-browser-test-token';
    return route.continue({postData:JSON.stringify(body)});
  });
  await waitForApp(page);await page.getByRole('button',{name:'Create a 3sln.me account',exact:true}).click();return {page,context};
}
const recoveryAnswer='Private browser recovery phrase 2026!';
function assertAssignedIdentity(account){
  assert.match(account.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.match(account.handle,/^n\.[0-9abcdefghjkmnpqrstvwxyz]+$/);
}
async function finishRecoveryDownload(page){
  await page.getByRole('heading',{name:'Keep a way back in.'}).waitFor();
  await page.getByLabel('What is my private recovery passphrase?',{exact:true}).fill(recoveryAnswer);
  await page.getByRole('button',{name:'Encrypt recovery file',exact:true}).click();
  await page.getByRole('heading',{name:'Save your encrypted recovery file.'}).waitFor();
  const confirm=page.getByLabel('I saved my recovery file in a safe place.');assert.equal(await confirm.isDisabled(),true);
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download recovery file',exact:true}).click();
  const download=await pending;const recovery=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.equal(recovery.format,'3sln-recovery');assert.equal(recovery.recoveryToken,undefined);assert.ok(recovery.ciphertext);assert.equal(JSON.stringify(recovery).includes(recoveryAnswer),false);
  await page.getByRole('heading',{name:'Test your recovery answers.'}).waitFor();
  await page.getByLabel('What is my private recovery passphrase?',{exact:true}).fill(recoveryAnswer);
  await page.getByRole('button',{name:'Test unlock',exact:true}).click();
  await page.getByRole('heading',{name:'Your way back in is ready.'}).waitFor();
  await page.getByLabel('I saved my recovery file in a safe place.').check();await page.getByRole('button',{name:'Open my space',exact:true}).click();
  await page.getByRole('heading',{name:'Messages & conversations'}).waitFor();return recovery;
}
// Private requests name the tab's account member, as the console does (multi-account sessions).
async function ownerAPI(page,path,body,method='POST'){
  return page.evaluate(async({path,body,method})=>{
    const session=await (await fetch('/api/session')).json();const response=await fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext},...(method==='GET'?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),cache:response.headers.get('Cache-Control')};
  },{path,body,method});
}
test('real passkey signup, confirmation gate, sign out and assertion login',async t=>{
  const {page,context}=await setup(t);await virtualAuthenticator(context,page);
  await page.locator('.auth-card').getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();await page.getByRole('button',{name:'Create a 3sln.me account',exact:true}).click();await page.getByRole('heading',{name:'How would you like to sign in?',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Your handle').count(),0);assert.equal(await page.locator('input[type=email]').count(),0);
  await completeSignupQuestions(page);await page.getByRole('button',{name:'Create my account'}).click();
  await page.getByRole('heading',{name:'Keep a way back in.'}).waitFor();
  assert.equal((await context.request.get(`${baseURL}/api/session`)).status(),200);
  assert.equal((await (await context.request.get(`${baseURL}/api/session`)).json()).authenticated,false);
  await finishRecoveryDownload(page);await screenshot(page,'live-passkey-inbox-desktop');
  const assigned=(await (await context.request.get(`${baseURL}/api/session`)).json()).account;assertAssignedIdentity(assigned);const handle=assigned.handle;
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Your handle').fill(handle);
  await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).click();await page.getByRole('heading',{name:'Messages & conversations'}).waitFor();
  const session=await (await context.request.get(`${baseURL}/api/session`)).json();assert.equal(session.account.handle,handle);assert.equal(session.account.id,assigned.id);assert.equal(session.account.passkeyCount,1);
  const cookies=await context.cookies();assert.ok(cookies.some(c=>c.httpOnly&&c.sameSite==='Strict'));
  await page.getByRole('button',{name:'Contact links',exact:true}).click();await page.getByRole('button',{name:'New contact link',exact:true}).click();
  await page.getByLabel('Name this link').fill('Friends');await page.getByRole('button',{name:'Create contact link',exact:true}).click();
  await page.getByLabel('Contact URL').waitFor();await page.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('heading',{name:'Friends',exact:true}).waitFor();await screenshot(page,'live-contacts-desktop');
  await page.getByRole('button',{name:'Resources',exact:true}).click();await screenshot(page,'live-resources-desktop');
  await page.getByRole('button',{name:'Account & security',exact:true}).click();await screenshot(page,'live-security-desktop');
  await page.setViewportSize({width:390,height:844});await screenshot(page,'live-security-mobile');
  const tvContext=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{'CF-Connecting-IP':'198.51.100.222'}});t.after(()=>tvContext.close());const tv=await tvContext.newPage();tv.setDefaultTimeout(15000);await tv.goto(baseURL+'/console?signin');const created=tv.waitForResponse(response=>response.url().endsWith('/api/auth/device/start'));await tv.getByRole('button',{name:'Use phone / TV QR',exact:true}).click();const device=await(await created).json();await tv.getByRole('heading',{name:'A new screen. The same you.',exact:true}).waitFor();assert.equal(await tv.getByRole('button',{name:'Show device QR',exact:true}).count(),0);await tv.locator('.device-qr').waitFor();assert.equal((await(await tvContext.request.get(baseURL+'/api/session')).json()).authenticated,false);await screenshot(tv,'live-automatic-tv-qr');
  // LA4 retires the review surface; LA3 mounts /approve later. Exercise the LA1 compatibility decision over real HTTP.
  await page.goto(device.verificationUriComplete);await page.locator('a[href="/approve#r='+device.requestId+'"]').waitFor();assert.equal(await page.locator('input[name=code]').count(),0);assert.equal(await page.getByText(device.userCode,{exact:true}).count(),0);
  const decision=await page.evaluate(async device=>{const session=await(await fetch('/api/session')).json(),headers={Origin:location.origin,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,...session.sessionContext?{'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext}:{}};const response=await fetch('/api/auth/device/approve',{method:'POST',headers,body:JSON.stringify({requestId:device.requestId,userCode:device.userCode,accountHandle:session.account.handle,approved:true})});return {status:response.status,body:await response.json()};},device);assert.equal(decision.status,200,JSON.stringify(decision.body));assert.equal(decision.body.approved,true);await tv.locator('.app-shell').waitFor();assert.equal((await(await tvContext.request.get(baseURL+'/api/session')).json()).account.id,assigned.id);await screenshot(tv,'live-automatic-tv-approved');

});
test('real password setup resumes, recovery rotates, contacts constrain messages, and private APIs never cache',async t=>{
  const {page,context}=await setup(t);
  await page.getByRole('button',{name:'Password',exact:true}).click();assert.equal(await page.getByLabel('Your handle').count(),0);
  await completeSignupQuestions(page);await page.getByLabel('Password',{exact:true}).fill('Test only long password 2026!');await page.getByRole('button',{name:'Create my account'}).click();
  await page.getByRole('heading',{name:'Keep a way back in.'}).waitFor();await page.reload();
  const recovery=await finishRecoveryDownload(page);
  const assigned=(await (await context.request.get(`${baseURL}/api/session`)).json()).account;assertAssignedIdentity(assigned);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Use my recovery file'}).click();
  await page.getByRole('button',{name:'Continue to recovery',exact:true}).click();
  await page.getByLabel('Encrypted recovery file',{exact:true}).setInputFiles({name:'recovery.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(recovery))});
  await page.getByRole('button',{name:'Read recovery questions',exact:true}).click();
  await page.getByLabel('What is my private recovery passphrase?',{exact:true}).fill(recoveryAnswer);await page.getByRole('button',{name:'Unlock recovery file',exact:true}).click();await page.getByLabel('Or choose a password').fill('Rotated test password 2026!');
  await page.getByRole('button',{name:'Set password & continue'}).click();const rotated=await finishRecoveryDownload(page);assert.notEqual(rotated.ciphertext,recovery.ciphertext);
  const recovered=(await (await context.request.get(`${baseURL}/api/session`)).json()).account;assert.equal(recovered.id,assigned.id);assert.equal(recovered.handle,assigned.handle);
  const replayPage=await context.newPage();await replayPage.goto(`${baseURL}/recovery/restore`);
  await replayPage.getByLabel('Encrypted recovery file',{exact:true}).setInputFiles({name:'recovery.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(recovery))});
  await replayPage.getByRole('button',{name:'Read recovery questions',exact:true}).click();await replayPage.getByLabel('What is my private recovery passphrase?',{exact:true}).fill(recoveryAnswer);
  const replay=replayPage.waitForResponse(response=>response.url().endsWith('/api/auth/recover'));await replayPage.getByRole('button',{name:'Unlock recovery file',exact:true}).click();assert.equal((await replay).status(),401,'consumed recovery file cannot be reused');await replayPage.close();
  await page.getByRole('button',{name:'Resources',exact:true}).click();await screenshot(page,'live-resources-desktop');
  await page.getByRole('button',{name:'Notifications',exact:true}).click();await screenshot(page,'live-notifications-desktop');
  await page.getByRole('button',{name:'Messages',exact:true}).first().click();
  const account=await ownerAPI(page,'/api/account',null,'GET');assert.equal(account.cache,'no-store');
  const collection=account.body.collections[0].id;
  const contact=await ownerAPI(page,'/api/contacts',{name:'Adversarial test',collections:[collection],mimeTypes:['text/html'],expiresAt:Date.now()+3600000,maxMessages:1,maxMessageBytes:65536,maxBytes:65536});assert.equal(contact.status,200);
  const share=new URL(contact.body.url);assert.ok(share.pathname.includes('/contact/'));assert.ok(share.searchParams.get('sig'));assert.equal((await context.request.get(share.href,{headers:{Accept:'application/vnd.bindle.contact-token+jwt'}})).status(),406);
  assert.equal((await ownerAPI(page,'/api/profile',{displayName:'Actual scoped recipient',bio:'Private biography',avatar:'https://images.example/private.png',discloseToContacts:true},'PUT')).status,200);
  assert.equal((await ownerAPI(page,`/api/contacts/${contact.body.id}/beam`,{profileFields:['displayName'],beamEnabled:false},'PUT')).status,200);
  const sharedProfile=await context.request.get(share.href,{headers:{Accept:'application/vnd.bindle.contact-profile+json'}});assert.equal(sharedProfile.status(),200);assert.deepEqual((await sharedProfile.json()).profile,{displayName:'Actual scoped recipient'});
  await page.goto(share.href);await page.getByRole('heading',{name:/^Send a message to \u2068?Actual scoped recipient\u2069?\.$/}).waitFor();assert.equal(await page.locator('.contact-profile-bio').count(),0);assert.equal(await page.getByRole('link',{name:'View shared avatar',exact:true}).count(),0);assert.equal(new URL(page.url()).search,'');await screenshot(page,'live-contact-scoped-profile');
  assert.equal((await ownerAPI(page,'/api/profile',{displayName:'Actual scoped recipient',bio:'Private biography',avatar:'https://images.example/private.png',discloseToContacts:false},'PUT')).status,200);
  const disabledProfile=await context.request.get(share.href,{headers:{Accept:'application/vnd.bindle.contact-profile+json'}});assert.equal((await disabledProfile.json()).profile,null);await page.goto(share.href);await page.getByRole('heading',{name:/^Send a message to /}).waitFor();assert.equal(await page.locator('.contact-recipient-profile').count(),0);await page.goto(baseURL+'/console');await page.getByRole('button',{name:'Messages',exact:true}).first().waitFor();
  // Identity-authored delivery: the signed-in sender's provider signs, the page posts credentialless multipart.
  const send=async input=>page.evaluate(async({url,input})=>{const bytes=new TextEncoder().encode(input.text),sha256=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''),session=await (await fetch('/api/session')).json();const signed=await fetch('/api/links/envelope',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext},body:JSON.stringify({link:url,mimeType:input.mimeType,subject:'',optionalTags:[],byteLength:bytes.byteLength,sha256,operationId:input.operationId,createdAt:input.createdAt})});if(!signed.ok)return {status:signed.status,body:await signed.json()};const {envelope}=await signed.json(),form=new FormData();form.append('envelope',new Blob([JSON.stringify(envelope)],{type:'application/json'}));form.append('message',new Blob([bytes],{type:input.mimeType}));const response=await fetch(url,{method:'POST',body:form,credentials:'omit'});return {status:response.status,body:await response.json()};},{url:share.href,input});
  const input={mimeType:'text/html',text:'<h1>Safe heading</h1><img src="https://leak.example/pixel"><script>parent.__messageExecuted=true</script>',operationId:crypto.randomUUID(),createdAt:Date.now()};
  assert.ok([400,415].includes((await send({...input,mimeType:'image/png',operationId:crypto.randomUUID()})).status));
  const accepted=await send(input);assert.equal(accepted.status,202,JSON.stringify(accepted.body));assert.deepEqual((await send(input)).body.receipt,accepted.body.receipt);
  assert.equal((await send({...input,operationId:crypto.randomUUID()})).status,429);
  await page.reload();await page.getByRole('button',{name:/New message/}).click();
  const frame=page.locator('iframe[title]');await frame.waitFor();assert.equal(await frame.getAttribute('sandbox'),'allow-scripts');
  const child=await (await frame.elementHandle()).contentFrame();await child.waitForFunction(()=>window.__fixtureMessageShadow?.querySelector('h1')?.textContent==='Safe heading');
  assert.equal(await child.evaluate(()=>document.querySelector('iframe,form')!==null),false);
  assert.equal(await page.evaluate(()=>Boolean(window.__messageExecuted)),false);await screenshot(page,'live-inert-message-desktop');
  await ownerAPI(page,`/api/contacts/${contact.body.id}`,{},'DELETE');assert.notEqual((await send(input)).status,202);
  const urls=await publicAssetCache(page);assert.ok(urls.every(url=>!new URL(url).pathname.startsWith('/api/')));
  await page.setViewportSize({width:390,height:844});await screenshot(page,'live-inbox-mobile');
});
