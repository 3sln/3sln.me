import test from 'node:test';
import assert from 'node:assert/strict';
import {launch,baseURL} from './browser.mjs';
import {chaosConsole,seeded,FAULTS,messages,builtinViews} from './chaos.mjs';

// UI chaos: faults that only a real browser shows — rendered busy/alert states,
// native form submission, double clicks, real offline transitions and history.
// Engine-level fault semantics are covered elsewhere; these assert what a person sees.
let browser;
test.before(async()=>{browser=await launch();});
test.after(async()=>{await browser?.close();});

test('sign-in survives a seeded burst of every transport fault with one request per attempt and a usable form',async t=>{
 const c=await chaosConsole(browser,t,{signedIn:false,goto:'/console?signin'});const {page}=c;
 await page.getByRole('button',{name:'Sign in with password',exact:true}).click();
 const order=seeded(0x5157).shuffle(FAULTS);
 for(const [index,kind] of order.entries()){
  await page.locator('.auth-card input[name=handle]').fill('n.chaos');await page.locator('.auth-card input[name=password]').fill('Correct horse battery staple 2026');
  // The reply is held while the extra clicks land, so the busy state (not timing) must absorb them.
  const held=c.hold('POST','/api/auth/login/password'),submit=page.locator('.auth-card form button[type=submit]');await submit.click({clickCount:3});
  const gate=await held;await c.busy();await submit.click({force:true});await c.release(gate,{kind});await page.getByRole('alert').waitFor();await c.settled();
  assert.equal(c.count('POST','/api/auth/login/password'),index+1,`one login request for ${kind}`);
  const [alert]=await c.alerts();assert.ok(alert.trim().length>0,`honest error for ${kind}`);assert.equal((await c.notices()).length,0,`no success notice for ${kind}`);
  assert.equal(await submit.isEnabled(),true,`form usable after ${kind}`);assert.equal(await page.locator('.user-summary').count(),0,`no session after ${kind}`);
  // Raw transport wording never leaks into the interface.
  assert.doesNotMatch(alert,/Failed to fetch|NetworkError|Load failed|Unexpected (token|end)|JSON/,`localizable wording for ${kind}`);
 }
 await page.locator('.auth-card input[name=password]').fill('Correct horse battery staple 2026');await page.locator('.auth-card form button[type=submit]').click();
 await page.locator('.user-summary').waitFor();assert.equal((await c.alerts()).length,0,'a later success clears the stale error');
});

test('going offline while sign-in is in flight releases the form and a late reply opens no session',async t=>{
 const c=await chaosConsole(browser,t,{signedIn:false,goto:'/console?signin'});const {page,context}=c;
 await page.getByRole('button',{name:'Sign in with password',exact:true}).click();
 const held=c.hold('POST','/api/auth/login/password');
 await page.locator('.auth-card input[name=handle]').fill('n.chaos');await page.locator('.auth-card input[name=password]').fill('Correct horse battery staple 2026');
 await page.locator('.auth-card form button[type=submit]').click();const gate=await held;
 await page.getByRole('button',{name:'Please wait…'}).waitFor();
 await context.setOffline(true);await page.getByText(/You’re offline/).waitFor();await c.settled();
 // The reply is delivered for the abandoned attempt (the fixture service did sign in): it must not open a session offline.
 const delivered=page.waitForEvent('requestfinished',request=>request.url().endsWith('/api/auth/login/password'));await c.release(gate);await delivered;await c.frames();await c.frames();
 assert.equal(await page.locator('.user-summary').count(),0,'no session from a reply that arrived offline');assert.equal(await c.stuck(),0);
 // On reconnect the console shows what the service says now, never the abandoned reply's account data.
 const sessions=c.count('GET','/api/session');await context.setOffline(false);await page.waitForFunction(()=>!document.querySelector('.offline-banner'));await c.requests('GET','/api/session',sessions+1);
 await page.locator('.user-summary').waitFor();await c.settled();assert.equal((await c.alerts()).length,0);
});

test('passkey sign-in: a cancelled ceremony and a failing finish both return to a usable form without a second begin',async t=>{
 const c=await chaosConsole(browser,t,{signedIn:false,goto:null,handlers:{
  'POST /api/auth/login/passkey/begin':route=>route.fulfill({json:{challengeToken:'fixture-challenge',authenticationOptions:{challenge:'AAAAAAAAAAAAAAAAAAAAAA',rpId:'localhost',allowCredentials:[],userVerification:'required',timeout:60000}}}),
  'POST /api/auth/login/passkey/finish':route=>route.fulfill({status:503,json:{error:'unavailable',message:'The service is temporarily unavailable.'}})}});
 const {page,context}=c;
 await context.addInitScript(()=>{let calls=0;window.passkeyCalls=()=>calls;navigator.credentials.get=async()=>{calls++;if(calls===1)throw new DOMException('The operation either timed out or was not allowed.','NotAllowedError');return {id:'AQID',rawId:new Uint8Array([1,2,3]).buffer,type:'public-key',authenticatorAttachment:'platform',getClientExtensionResults:()=>({}),response:{clientDataJSON:new Uint8Array([1]).buffer,authenticatorData:new Uint8Array([1]).buffer,signature:new Uint8Array([1]).buffer,userHandle:null}};};});
 await page.goto(baseURL+'/console?signin');await page.locator('.auth-card').waitFor();
 for(const attempt of [1,2]){
  await page.locator('.auth-card input[name=handle]').fill('n.chaos');
  const held=c.hold('POST','/api/auth/login/passkey/begin');await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).click({clickCount:3});await c.release(await held);
  if(attempt===2)await c.requests('POST','/api/auth/login/passkey/finish',1);await page.getByRole('alert').waitFor();await c.settled();
  assert.equal(c.count('POST','/api/auth/login/passkey/begin'),attempt);assert.equal(await page.evaluate(()=>window.passkeyCalls()),attempt);
  assert.equal(c.count('POST','/api/auth/login/passkey/finish'),attempt-1);
  assert.equal(await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).isEnabled(),true);
  assert.equal(await page.locator('.user-summary').count(),0);
 }
});

test('saving a View: triple submit sends one mutation, 5xx/429 keep the dialog, and a lost reply is never reported as saved',async t=>{
 const c=await chaosConsole(browser,t,{handlers:{'POST /api/views':async(route,{model,body})=>{const view={id:'v'+model.views.length,name:body.name,revision:1,filter:body.filter,sort:body.sort};model.views=[...model.views,view];return route.fulfill({json:{view}});}}});const {page}=c;
 await page.getByRole('button',{name:'New View',exact:true}).first().click();await page.getByLabel('View name').fill('Chaos view');
 const save=page.locator('.modal form button[type=submit]');
 for(const [index,kind] of [503,429,500].entries()){
  const held=c.hold('POST','/api/views');await save.click({clickCount:3});const gate=await held;await c.busy();await save.click({force:true});await c.release(gate,{kind});await page.getByRole('alert').first().waitFor();await c.settled();
  assert.equal(c.count('POST','/api/views'),index+1);assert.equal(await page.getByRole('dialog').count(),1,'dialog stays open with the draft');assert.equal(await page.getByLabel('View name').inputValue(),'Chaos view');
  assert.equal((await c.notices()).length,0);
 }
 // The fixture applies the View, then the connection resets before the reply: outcome unknown.
 c.inject('POST','/api/views','reset',{after:true});await save.click();await c.requests('POST','/api/views',4);await c.settled();await page.getByRole('alert').first().waitFor();
 const [alert]=await c.alerts();assert.match(alert,/may|check|not confirmed|unknown|interrupted/i,'unknown outcome is described as unknown');
 assert.equal((await c.notices()).length,0,'no success notice for an unknown outcome');assert.equal(c.model.views.length,2,'the fixture did apply it');
});

test('superseded View responses arriving out of order never replace the newer View',async t=>{
 const views=[...builtinViews(),{id:'work',name:'Work',revision:1,filter:{version:1,tagsAll:['work']},sort:'activity-desc'},{id:'home',name:'Home',revision:1,filter:{version:1,tagsAll:['home']},sort:'activity-desc'}];
 const c=await chaosConsole(browser,t,{views,incoming:{all:messages(3,{prefix:'All'}),work:messages(3,{prefix:'Work item',seed:2}),home:messages(3,{prefix:'Home item',seed:3})}});const {page}=c;
 const slow=c.hold('GET','/api/incoming');
 await page.locator('.incoming-toolbar select').selectOption('work');const gate=await slow;
 await page.locator('.incoming-toolbar select').selectOption('home');await page.getByText('Home item 0',{exact:true}).waitFor();
 const late=page.waitForEvent('requestfinished',request=>request.url().includes('view=work'));await c.release(gate);await late;await c.frames();await c.settled();
 assert.equal(await page.getByText('Work item 0',{exact:true}).count(),0,'late Work page discarded');assert.equal(await page.locator('.incoming-toolbar select').inputValue(),'home');
 assert.equal(await page.getByText('Home item 2',{exact:true}).count(),1);assert.equal(await c.stuck(),0);
});

test('a refresh failure after a successful mutation still reports the success and does not invite a duplicate',async t=>{
 const c=await chaosConsole(browser,t,{handlers:{'POST /api/collections':async(route,{model,body})=>{model.data.collections=[...model.data.collections,{id:'c'+model.data.collections.length,name:body.name}];return route.fulfill({json:{id:'created'}});}}});const {page}=c;
 await page.getByRole('button',{name:'Contact links',exact:true}).click();
 // Collection creation lives in the legacy modal; open it the way the inbox toolbar does.
 await page.evaluate(()=>document.getElementById('app').dispatchEvent(new CustomEvent('3sln-intent',{bubbles:true,detail:{kind:'open-modal',modal:{kind:'collection'}}})));
 await page.getByRole('dialog').waitFor();await page.getByRole('dialog').locator('input').first().fill('Receipts');
 c.inject('GET','/api/account',503);await page.getByRole('dialog').locator('button[type=submit]').click();
 await page.getByRole('dialog').waitFor({state:'detached'});await c.settled();
 assert.equal(c.count('POST','/api/collections'),1);
 const notices=await c.notices();assert.ok(notices.some(text=>/Collection created/.test(text)),'the completed mutation is reported');
});

test('a restored back-forward cache entry reloads into fresh state instead of a torn-down console',async t=>{
 const c=await chaosConsole(browser,t,{});const {page}=c;
 const sessions=c.count('GET','/api/session');
 // Chromium under automation never enters the bfcache; the exact lifecycle events it would fire are replayed.
 const reloaded=page.waitForEvent('framenavigated');
 await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
 await reloaded;await page.getByRole('heading',{name:'Messages & conversations'}).waitFor();
 assert.ok(c.count('GET','/api/session')>sessions,'session is re-read after restore');
});

test('back and forward during a pending request leave no stale or stuck state',async t=>{
 const c=await chaosConsole(browser,t,{incoming:{all:messages(5)}});const {page}=c;
 const held=c.hold('GET','/api/views');await page.getByRole('button',{name:'Messages',exact:true}).click();await held;
 await page.goto(baseURL+'/docs/');await page.goBack();await page.getByRole('heading',{name:'Messages & conversations'}).waitFor();await page.getByText('Message 4',{exact:true}).waitFor();
 await page.goForward();await page.goBack();await page.getByText('Message 4',{exact:true}).waitFor();await c.settled();assert.equal(await c.stuck(),0);
});

const SVG='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="black"/></svg>';
// Turnstile stand-in: every render or reset issues a fresh single-use token, as the real widget does.
const turnstile=`window.turnstileTokens=0;window.turnstileWidgets=[];window.turnstile={render(node,options){window.turnstileWidgets.push(options);options.callback(options.action+'-proof-'+(++window.turnstileTokens));return String(window.turnstileWidgets.length);},reset(id){const options=window.turnstileWidgets[Number(id)-1];options?.callback(options.action+'-proof-'+(++window.turnstileTokens));},remove(){}};`;
test('device QR: a failing poll ends in an honest interrupted state and Try again starts exactly one fresh request',async t=>{
 const c=await chaosConsole(browser,t,{signedIn:false,goto:null,config:{turnstileSiteKey:'device-fixture',localDevelopment:false,deviceLoginEnabled:true},handlers:{
  'POST /api/auth/device/start':(route,{model})=>route.fulfill({json:{deviceCode:'private-device-'+model.calls.length,requestId:'550e8400-e29b-41d4-a716-446655440033',userCode:'23456789',verificationUriComplete:'https://identity.example/device#request=550e8400-e29b-41d4-a716-446655440011',expiresAt:Date.now()+120000,interval:5}}),
  'POST /api/auth/device/qr':route=>route.fulfill({json:{svg:SVG}}),'POST /api/auth/device/cancel':route=>route.fulfill({json:{cancelled:true}})}});
 const {page,context}=c;await context.route('https://challenges.cloudflare.com/**',route=>route.fulfill({contentType:'application/javascript',body:turnstile}));
 c.inject('POST','/api/auth/device/poll',503);
 await page.goto(baseURL+'/console?signin');await page.getByRole('button',{name:'Use phone / TV QR',exact:true}).click({clickCount:2});
 await page.locator('.device-qr').waitFor();assert.equal(c.count('POST','/api/auth/device/start'),1,'double click starts one request');
 // The first poll is due after the server interval (5 s); its 503 must not loop or leave a spinner.
 await page.getByText('This sign-in request was interrupted. Reconnect and start again.',{exact:true}).waitFor({timeout:12000});await c.settled();
 assert.equal(c.count('POST','/api/auth/device/poll'),1);assert.ok((await c.alerts()).some(text=>text.length>0));assert.equal(await page.locator('.device-qr').count(),0);
 await page.getByRole('button',{name:'Try again',exact:true}).click({clickCount:2});await page.locator('.device-qr').waitFor();
 assert.equal(c.count('POST','/api/auth/device/start'),2);assert.equal(await page.evaluate(()=>document.documentElement.textContent.includes('private-device')),false);
 await page.getByRole('button',{name:'Cancel phone sign-in',exact:true}).click();await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();await c.settled();
});

test('signup wizard: a rapid triple click advances one question, and create-account faults keep the draft without a second request',async t=>{
 const c=await chaosConsole(browser,t,{signedIn:false,goto:'/console?signup',config:{signupContactRequired:true,emailSetupAvailable:true,pushSetupAvailable:false}});const {page}=c;
 const card=page.locator('.signup-wizard'),heading=()=>card.locator('.wizard-heading').textContent();
 await card.getByRole('button',{name:'Password',exact:true}).click();
 const visited=[];for(let step=0;step<6&&!await card.getByRole('button',{name:'Create my account',exact:true}).count();step++){
  const before=await heading();visited.push(before);
  if(await card.getByRole('button',{name:'Use email',exact:true}).count())await card.getByRole('button',{name:'Use email',exact:true}).click();
  if(await card.locator('input[name=noticeEmail]').count())await card.locator('input[name=noticeEmail]').fill('person@setup.example');
  if(await card.locator('input[name=termsAccepted]').count())await card.locator('input[name=termsAccepted]').check();
  await card.getByRole('button',{name:'Continue',exact:true}).click({clickCount:3});
  await page.waitForFunction(previous=>document.querySelector('.signup-wizard .wizard-heading')?.textContent!==previous,before);await c.settled();
  assert.equal((await c.alerts()).length,0,`no validation error leaks from extra clicks on "${before}"`);
 }
 assert.deepEqual(visited,[...new Set(visited)],'no question was shown twice');assert.equal(visited.length,4,`no question was skipped: ${JSON.stringify(visited)}`);
 await card.getByLabel('Password',{exact:true}).fill('Private wizard password for chaos');
 const held=c.hold('POST','/api/auth/signup');await card.locator('form button[type=submit]').click({clickCount:3});const gate=await held;await c.busy();
 await c.release(gate,{kind:503});await page.getByRole('alert').waitFor();await c.settled();
 assert.equal(c.count('POST','/api/auth/signup'),1);assert.equal(await card.getByRole('button',{name:'Create my account',exact:true}).count(),1,'still on the credential question');
 assert.equal(c.count('POST','/api/auth/setup/email/start'),0,'no email was sent for a failed signup');assert.equal((await c.notices()).length,0);
});

test('account switch: a held switch never shows the previous account, a lost reply stays honest, and a retry lands on the chosen account only',async t=>{
 const one={id:'11111111-2222-4333-8444-555555555555',handle:'n.first',status:'active'},two={id:'22222222-3333-4444-8555-666666666666',handle:'n.second',status:'active'};
 const inventory=()=>({accounts:[one,two].map(account=>({account,sessionContext:'ctx-'+account.handle,expiresAt:Date.now()+3600000})),revision:'r'.repeat(43),activeOwner:one.id,pickerToken:'private-picker',limit:5,cleanupPending:false});
 const view=name=>[...builtinViews(),{id:'private',name,revision:1,filter:{version:1},sort:'activity-desc'}];
 const c=await chaosConsole(browser,t,{account:one,views:view('First private sentinel'),handlers:{
  'GET /api/auth/accounts':route=>route.fulfill({json:inventory()}),
  'POST /api/auth/accounts/switch':(route,{model})=>{model.account=two;model.views=view('Second private sentinel');return route.fulfill({json:{account:two,csrfToken:'second-csrf',sessionContext:'ctx-second'}});}}});const {page}=c;
 await page.locator('.user-summary').getByText('n.first',{exact:true}).waitFor();await page.getByText('First private sentinel').first().waitFor();
 await page.getByRole('button',{name:'Switch account',exact:true}).click();const open=page.locator('.account-row').filter({hasText:'n.second@'}).getByRole('button',{name:'Open account',exact:true});await open.waitFor();
 // First attempt: the reply is lost after the server switched.
 const held=c.hold('POST','/api/auth/accounts/switch');
 await open.click({clickCount:3});const gate=await held;assert.equal(c.count('POST','/api/auth/accounts/switch'),1);
 await page.waitForFunction(()=>document.querySelector('.account-picker')?.getAttribute('aria-busy')==='true');
 assert.equal(await page.getByText('First private sentinel').count(),0,'old private data is gone before the network answers');
 await c.release(gate,{kind:'reset',after:true});await page.getByRole('alert').waitFor();await c.settled();
 assert.equal(await page.locator('.user-summary').count(),0,'no account is presented as open after an unknown switch');assert.equal(await page.getByText(/private sentinel/).count(),0);
 await page.locator('.account-row').filter({hasText:'n.second@'}).getByRole('button',{name:'Open account',exact:true}).click();
 await page.locator('.user-summary').getByText('n.second',{exact:true}).waitFor();await page.getByText('Second private sentinel').first().waitFor();await c.settled();
 assert.equal(await page.getByText('First private sentinel').count(),0,'no stale data from the previous account');assert.equal(c.count('POST','/api/auth/accounts/switch'),2);
});

test('signing out another account: a 503 keeps the list honest and a retry signs out exactly once',async t=>{
 const one={id:'11111111-2222-4333-8444-555555555555',handle:'n.first',status:'active'},two={id:'22222222-3333-4444-8555-666666666666',handle:'n.second',status:'active'};let members=[one,two];
 const c=await chaosConsole(browser,t,{account:one,handlers:{
  'GET /api/auth/accounts':route=>route.fulfill({json:{accounts:members.map(account=>({account,sessionContext:'ctx-'+account.handle,expiresAt:Date.now()+3600000})),revision:(members.length===2?'r':'s').repeat(43),activeOwner:one.id,pickerToken:'private-picker',limit:5,cleanupPending:false}}),
  'POST /api/auth/accounts/logout':route=>{members=[one];return route.fulfill({json:{loggedOut:true,cleanupPending:false}});}}});const {page}=c;
 await page.getByRole('button',{name:'Switch account',exact:true}).click();const signOut=()=>page.locator('.account-row').filter({hasText:'n.second@'}).getByRole('button',{name:'Sign out',exact:true});await signOut().waitFor();
 const held=c.hold('POST','/api/auth/accounts/logout');await signOut().click({clickCount:3});const gate=await held;await c.release(gate,{kind:503});await page.getByRole('alert').waitFor();await c.settled();
 assert.equal(c.count('POST','/api/auth/accounts/logout'),1);assert.equal(await page.locator('.account-row').filter({hasText:'n.second@'}).count(),1,'the account is still listed');assert.equal((await c.notices()).length,0);
 await signOut().click();await page.getByText('Signed out.').waitFor();await c.settled();assert.equal(await page.locator('.account-row').filter({hasText:'n.second@'}).count(),0);assert.equal(c.count('POST','/api/auth/accounts/logout'),2);
 assert.equal(await page.locator('.account-row').filter({hasText:'n.first@'}).getByText('Current account').count(),1,'this tab keeps its own account');
});

test('reading a message: a double click marks it read once, and a 401 mid-read erases private content',async t=>{
 const items=messages(3,{prefix:'Private subject'}).map(item=>({...item,readAt:null}));
 const c=await chaosConsole(browser,t,{incoming:{all:items},handlers:{
  'PATCH ^/api/messages/[^/]+$':route=>route.fulfill({json:{ok:true}}),
  'GET ^/api/messages/[^/]+$':route=>route.fulfill({json:{message:{...items[0],text:'Private body sentinel'},render:{kind:'text'}}})}});const {page}=c;
 const held=c.hold('PATCH',/^\/api\/messages\//);await page.getByRole('button',{name:/Private subject 0/}).click({clickCount:2});const gate=await held;await c.release(gate);
 await page.getByText('Private body sentinel').waitFor();await c.settled();assert.equal(c.count('PATCH',/^\/api\/messages\//),1,'one read mutation');
 c.model.handlers['GET ^/api/messages/[^/]+$']=route=>route.fulfill({status:401,json:{error:'unauthorized',message:'Sign in to continue.'}});
 await page.getByRole('button',{name:/Private subject 1/}).click();await page.getByText('Your session expired. Sign in again.',{exact:true}).waitFor();await c.settled();
 assert.equal(await page.getByText(/Private (subject|body)/).count(),0,'no private message content after expiry');
});

test('intake editing: a conflict reloads the current tags, a 503 keeps the dialog, and a refresh failure after saving still reports the save',async t=>{
 const contact={id:'33333333-4444-4555-8666-777777777777',name:'Chaos link',active:true,form:'link',maxMessages:5,messagesUsed:0,expiresAt:Date.now()+86400000};let revision=1;
 const c=await chaosConsole(browser,t,{data:{contacts:[contact],tagLabels:{revision:1,labels:{work:'Work'}}},handlers:{
  'GET ^/api/contacts/[^/]+/intake$':route=>route.fulfill({json:{revision,autoTags:[],optionalTags:[],labels:{}}}),
  'PUT ^/api/contacts/[^/]+/intake$':(route,{body})=>{if(body.revision!==revision)return route.fulfill({status:409,json:{error:'intake_conflict',message:'Conflict.'}});revision++;return route.fulfill({json:{revision}});}}});const {page}=c;
 await page.getByRole('button',{name:'Contact links',exact:true}).click();await page.getByRole('button',{name:'Edit tags',exact:true}).click();await page.getByRole('dialog').waitFor();
 revision=2;await page.getByRole('dialog').locator('form button[type=submit]').click();await page.getByRole('dialog').getByText('These tags changed in another window. Review the current settings and save again.',{exact:true}).waitFor();await c.settled();
 const held=c.hold('PUT',/\/intake$/);await page.getByRole('dialog').locator('form button[type=submit]').click({clickCount:3});const gate=await held;await c.busy();await c.release(gate,{kind:503});await page.getByRole('dialog').getByText('The service is temporarily unavailable.').waitFor();await c.settled();
 assert.equal(await page.getByRole('dialog').count(),1);assert.equal(c.count('PUT',/\/intake$/),2,'conflict + one held attempt, extra clicks absorbed');
 c.inject('GET','/api/account',503);await page.getByRole('dialog').locator('form button[type=submit]').click();await page.getByRole('dialog').waitFor({state:'detached'});await c.settled();
 assert.ok((await c.notices()).some(text=>text.includes('Tags updated')),'saved tags are reported even though the refresh failed');assert.equal(revision,3);
});

const plans=[{id:'free',name:'Free',storageBytes:500000000,annualAmount:0},{id:'paid',name:'Paid',storageBytes:5000000000,annualAmount:500},{id:'plus',name:'Plus',storageBytes:100000000000,annualAmount:3500},{id:'ultra',name:'Ultra',storageBytes:1000000000000,annualAmount:25000}].map(plan=>({...plan,currency:'usd',dailyActivityUnits:10000,hourlyActivityUnits:2000,priceDigest:'digest-'+plan.id,price:{currency:'usd',amount:plan.annualAmount,exponent:2,source:'polar',taxBehavior:'checkout',available:true}}));
const billing=(extra={})=>({plan:'free',enabled:true,configured:true,server:'sandbox',currencies:['usd'],selectedCurrency:'usd',plans,...extra});
const storage={plan:'free',planName:'Free',storageBytes:500000000,usedBytes:1000,reservedBytes:0,remainingBytes:499999000,overLimit:false,messagesBytes:1000,objectsBytes:0,messageCount:1,objectCount:0};
test('billing upgrade (mocked, never Polar): triple-click checkout sends one request and an untrusted payment URL is refused',async t=>{
 const c=await chaosConsole(browser,t,{data:{storage},handlers:{'GET /api/billing':route=>route.fulfill({json:billing()}),'POST /api/billing/checkout':route=>route.fulfill({json:{url:'https://polar.attacker.example/checkout'}})}});const {page}=c;
 let navigatedAway=false;page.on('framenavigated',frame=>{if(frame===page.mainFrame()&&!frame.url().startsWith(baseURL))navigatedAway=true;});
 await page.getByRole('button',{name:'Storage & billing',exact:true}).click();const choose=page.locator('.plan-card').filter({has:page.getByRole('heading',{name:'Paid',exact:true})}).getByRole('button',{name:'Choose plan',exact:true});await choose.waitFor();
 const held=c.hold('POST','/api/billing/checkout');await choose.click({clickCount:3});const gate=await held;await c.release(gate);await page.getByRole('alert').waitFor();await c.settled();
 assert.equal(c.count('POST','/api/billing/checkout'),1);assert.equal(navigatedAway,false);assert.match((await c.alerts())[0],/payment page could not be opened/);
});

test('billing plan change (mocked): a lost or unreadable reply is shown as unknown and never as a confirmed or refused change',async t=>{
 for(const kind of ['reset','truncated']){
  const current=billing({plan:'paid',subscription:{currency:'usd'}});
  const c=await chaosConsole(browser,t,{data:{storage:{...storage,plan:'paid'}},handlers:{'GET /api/billing':route=>route.fulfill({json:current}),'POST /api/billing/change-plan':route=>route.fulfill({json:{outcome:'pending',billing:current}})}});const {page}=c;
  await page.getByRole('button',{name:'Storage & billing',exact:true}).click();await page.locator('.plan-card').filter({has:page.getByRole('heading',{name:'Plus',exact:true})}).getByRole('button',{name:'Change plan',exact:true}).click();
  await page.locator('.billing-change-review input[name=authorize]').check();c.inject('POST','/api/billing/change-plan',kind,{after:true});
  await page.getByRole('button',{name:'Confirm plan change',exact:true}).click({clickCount:3});await page.getByRole('heading',{name:'Checking the previous plan change',exact:true}).waitFor();await c.settled();
  assert.equal(c.count('POST','/api/billing/change-plan'),1,`one change request (${kind})`);assert.equal((await c.notices()).filter(text=>/confirmed|pending confirmation/.test(text)).length,0,`no success for ${kind}`);
  const saved=await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('3sln-billing-change:')).length);assert.equal(saved,1,`the unknown attempt is kept for reconciliation (${kind})`);
  await c.context.close();
 }
});

test('rapid navigation while billing loads never shows billing data elsewhere and leaves no loading state',async t=>{
 const c=await chaosConsole(browser,t,{data:{storage},handlers:{'GET /api/billing':route=>route.fulfill({json:billing()})}});const {page}=c;
 const held=c.hold('GET','/api/billing');await page.getByRole('button',{name:'Storage & billing',exact:true}).click();const gate=await held;
 for(const name of seeded(0xb111).shuffle(['Rules','Contact links','Resources','Notifications']))await page.getByRole('button',{name,exact:true}).click();
 await page.getByRole('button',{name:'Messages',exact:true}).click();await c.release(gate);await c.settled();
 assert.equal(await page.locator('.plan-card').count(),0,'billing cards are not rendered on another view');assert.equal(await page.getByRole('heading',{name:'Messages & conversations'}).count(),1);
 await page.getByRole('button',{name:'Storage & billing',exact:true}).click();await page.locator('.plan-card').first().waitFor();await c.settled();
});

test('console contact send: triple-click sends one envelope, a lost delivery reply is retried with the same operation, and intake faults offer a reload',async t=>{
 const invitation='/users/reader/contact/44444444-1111-4111-8111-111111111111?sig=fixture.signed.endpoint',signed=[],deliveries=[];let intakeFailures=1;
 const c=await chaosConsole(browser,t,{goto:null,handlers:{'POST /api/links/envelope':(route,{body})=>{signed.push(body);return route.fulfill({json:{envelope:{payload:{operationId:body.operationId,createdAt:body.createdAt,content:{mimeType:body.mimeType,byteLength:body.byteLength,sha256:body.sha256}},proof:{alg:'ES256',kid:'k',signature:'s'}}}});}}});const {page,context}=c;
 await context.route(url=>new URL(url).pathname===new URL(baseURL+invitation).pathname,async route=>{const request=route.request();
  if(request.method()==='GET'){if(intakeFailures-->0)return route.fulfill({status:503,json:{error:'unavailable',message:'The service is temporarily unavailable.'}});return route.fulfill({contentType:'application/vnd.bindle.contact-intake+json',json:{version:1,form:'legacy',intakeRevision:null,optionalTags:[],kinds:['one-off'],mimeTypes:['text/plain'],maxMessageBytes:65536,maxMessages:5,maxBytes:65536,quotaScope:'parent',expiresAt:Date.now()+3600000,conditional:false}});}
  const envelope=JSON.parse(/name="envelope"[^\r]*\r\nContent-Type: application\/json\r\n\r\n([^\r\n]+)/.exec(request.postData())[1]);deliveries.push(envelope.payload.operationId);
  if(deliveries.length===1)return route.abort('connectionreset');return route.fulfill({status:202,json:{receipt:{payload:{messageId:'message'},proof:{}}}});});
 await page.goto(`${baseURL}/console#contact=${encodeURIComponent(baseURL+invitation)}&intent=send-message`);
 await page.getByRole('alert').first().waitFor();await c.settled();const reload=page.getByRole('button',{name:/Reload|Try again/});await reload.first().click();
 await page.getByLabel('Your message').waitFor();await page.getByLabel('Your message').fill('Chaos note');
 await page.getByRole('button',{name:'Send message',exact:true}).click({clickCount:3});await page.getByRole('alert').first().waitFor();await c.settled();
 assert.equal(signed.length,1,'triple click signs one envelope');assert.equal(deliveries.length,1);assert.equal(await page.getByRole('heading',{name:'Your message is on its way.'}).count(),0,'no success after a lost reply');
 await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByRole('heading',{name:'Your message is on its way.'}).waitFor();
 assert.equal(deliveries.length,2);assert.equal(deliveries[0],deliveries[1],'the retry reconciles the same operation');
});

test('saving a signed contact: a double submit redeems once and a failed refresh still reports the saved contact',async t=>{
 let redeems=0;
 const c=await chaosConsole(browser,t,{handlers:{
  'GET /api/beams/status':route=>route.fulfill({json:{available:true,devices:[],limits:{maxFiles:10,maxBytes:1000000}}}),'GET /api/beams/mailbox':route=>route.fulfill({json:{offers:[]}}),
  'GET /api/contacts/directory':route=>route.fulfill({json:{contacts:[]}}),'GET /api/profile':route=>route.fulfill({json:{displayName:'',bio:'',discloseToContacts:false}}),
  'POST /api/contacts/redeem':route=>{redeems++;return route.fulfill({json:{saved:true}});}}});const {page}=c;
 await page.evaluate(()=>document.getElementById('app').dispatchEvent(new CustomEvent('3sln-intent',{bubbles:true,detail:{kind:'navigate',view:'beaming'}})));
 const url=page.getByLabel('Signed contact URL',{exact:true});await url.waitFor();await url.fill(baseURL+'/users/reader/contact/44444444-1111-4111-8111-111111111111?sig=fixture.signed.endpoint');
 const form=url.locator('xpath=ancestor::form');const held=c.hold('POST','/api/contacts/redeem');await form.locator('button[type=submit]').click({clickCount:3});const gate=await held;await c.busy();await form.locator('button[type=submit]').click({force:true});
 c.inject('GET','/api/beams/status',503);await c.release(gate);await page.getByText('Signed contact saved.').waitFor();await c.settled();
 assert.equal(redeems,1,'one redeem for repeated submits');assert.ok((await c.alerts()).some(text=>/saved, but the latest information could not be loaded/.test(text)),'the stale refresh is reported separately');
});

test('public contact page: a failing link description is reported honestly, offers no compose path, and Try again recovers without the stripped capability',async t=>{
 const invitation='/users/reader/contact/44444444-1111-4111-8111-111111111111?sig=fixture.signed.endpoint';let failures=1;
 const c=await chaosConsole(browser,t,{signedIn:false,goto:null});const {page,context}=c;
 await context.route(url=>new URL(url).pathname===new URL(baseURL+invitation).pathname,route=>{if(route.request().resourceType()==='document')return route.continue();
  if(failures-->0)return route.fulfill({status:503,json:{error:'unavailable',message:'The service is temporarily unavailable.'}});
  return route.fulfill({contentType:'application/vnd.bindle.contact-intake+json',json:{version:1,form:'legacy',intakeRevision:null,optionalTags:[],kinds:['one-off'],mimeTypes:['text/plain'],maxMessageBytes:65536,maxMessages:5,maxBytes:65536,quotaScope:'parent',expiresAt:Date.now()+3600000,conditional:false}});});
 await page.goto(baseURL+invitation);await page.getByText('The service is temporarily unavailable.').waitFor();await c.settled();
 assert.equal(await page.getByLabel('Your message').count(),0,'no compose path without a verified description');assert.equal((await c.notices()).length,0);
 assert.equal(await page.getByText('Up to 64 KB',{exact:true}).count(),0,'no limits are shown that were never described');
 // The signed capability is removed from the address bar on load, so only an in-page retry can recover.
 assert.equal(new URL(page.url()).search,'','capability no longer in the URL');await page.getByRole('button',{name:'Try again',exact:true}).click({clickCount:2});
 await page.getByText('Up to 64 KB',{exact:true}).waitFor();await c.settled();assert.equal((await c.alerts()).length,0);
});
