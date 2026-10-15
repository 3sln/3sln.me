// DOM tests for the embeddable elements under happy-dom. Provider behaviour comes
// from testing.mjs (full / standard / minimal declarations): the authorization
// entry and components profile are mock-verified only.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Window} from 'happy-dom';

const window=new Window({url:'https://app.example/'});
for(const name of ['document','HTMLElement','customElements','Node','Element','KeyboardEvent','MouseEvent'])globalThis[name]=window[name];
globalThis.window=window;
after(()=>window.happyDOM.close());

const {defineBindleElements}=await import('../src/elements/index.mjs');
const {providerDefaults,contrast,contrastPairs,validateThemeTokens}=await import('../src/elements/theme-probe.mjs');
const {createMockProvider,memoryStorage,installPopupDrivers}=await import('../src/testing.mjs');
const {BindleClient}=await import('../src/identity.mjs');
const {sdkCatalogues}=await import('../../i18n/sdk-catalogue.mjs');
defineBindleElements();

const clientId='https://app.example/client',redirectUri='https://app.example/callback';
const tick=(ms=15)=>new Promise(resolve=>setTimeout(resolve,ms));
// Waits for a condition instead of a fixed delay: the popup relay crosses a
// BroadcastChannel (a macrotask) plus WebCrypto and the token exchange, which a
// loaded machine can stretch well past any fixed tick (the old 40 ms flake).
async function until(predicate,{timeout=3000,message='condition'}={}){
  const end=Date.now()+timeout;
  while(!predicate()){if(Date.now()>end)throw new Error(`Timed out waiting for ${message}.`);await tick(5);}
}
const eventTypes=['bindle-session-change','bindle-flow-start','bindle-flow-end','bindle-flow-state','bindle-menu-toggle','bindle-error','bindle-login-request','bindle-email-fallback','bindle-sign-in-start','bindle-sign-in-end','bindle-account-change','bindle-account-change-failed','bindle-capabilities-change'];
async function mount(html,{provider=createMockProvider({issuer:'https://3sln.example'}),providers=[provider],decide,blocked,client=true,clientOptions={},load=true}={}){
  document.body.innerHTML='';
  const fetcher=async(input,init)=>{const url=new URL(input instanceof Request?input.url:input);return providers.find(item=>item.issuer===url.origin)?.fetch(input,init)??new Response('',{status:404});};
  const driver=installPopupDrivers(window,providers,{decide,blocked});
  const template=document.createElement('template');template.innerHTML=html;
  const session=template.content.querySelector('bindle-session');
  if(session&&client)session.client=new BindleClient({clientId,redirectUri,fetcher,storage:memoryStorage(),history:{replaceState(){}},defaultHost:new URL(provider.issuer).host,...clientOptions});
  const events=[],listener=event=>events.push({type:event.type,detail:event.detail});
  for(const type of eventTypes)document.addEventListener(type,listener);
  document.body.append(template.content);
  const element=document.querySelector('bindle-session');
  if(element&&client){await element.ready;if(load)await until(()=>element.capabilities,{message:'capabilities'});}
  return {provider,driver,events,session:element,uninstall:()=>{driver.uninstall();for(const type of eventTypes)document.removeEventListener(type,listener);}};
}
const shadow=selector=>document.querySelector(selector).shadowRoot;
const submit=(element,value)=>{const root=element.shadowRoot,input=root.querySelector('input');input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));root.querySelector('form').dispatchEvent(new window.Event('submit',{cancelable:true}));};
const key=(target,name)=>target.dispatchEvent(new window.KeyboardEvent('keydown',{key:name,bubbles:true,composed:true,cancelable:true}));
const page=(actions='switch provider reauth sign-out provider-sign-out manage',attributes='')=>`<bindle-session client-id="${clientId}" redirect-uri="${redirectUri}" ${attributes}><bindle-account actions="${actions}"><bindle-sign-in slot="signed-out"></bindle-sign-in><a slot="menu-start" href="/settings">Settings</a></bindle-account></bindle-session>`;
const buttons=root=>[...root.querySelectorAll('[role=list] button,[role=list] a')].map(node=>node.textContent);
async function signIn(handle='alex'){const element=document.querySelector('bindle-sign-in'),session=document.querySelector('bindle-session');submit(element,handle);await until(()=>session.session,{message:'sign-in'});}

test('sign-in through the elements exposes nothing about provider accounts before approval',async()=>{
  let release;const {provider,driver,events,session,uninstall}=await mount(page(),{decide:()=>new Promise(resolve=>release=resolve)});
  assert.equal(events.find(event=>event.type==='bindle-session-change').detail,null);
  const signIn=document.querySelector('bindle-sign-in');
  assert.equal(signIn.shadowRoot.querySelector('#suffix').textContent,'@3sln.example');
  assert.equal(signIn.shadowRoot.querySelector('label').textContent,'Your Bindle identity');
  submit(signIn,'alex');
  assert.equal(driver.opened.length,1,'window opens synchronously inside the submit');
  assert.match(signIn.shadowRoot.querySelector('[role=status]').textContent,/3sln\.example/);
  await until(()=>release,{message:'the provider page'});
  // Before approval, no event, attribute or rendered text carries account data.
  const before=JSON.stringify(events)+document.body.innerHTML+[...document.querySelectorAll('*')].map(node=>node.shadowRoot?.innerHTML??'').join('');
  for(const account of provider.accounts){assert.ok(!before.includes(account.subject));assert.ok(!before.includes(account.displayName));}
  release({decision:'approve'});
  await until(()=>events.some(event=>event.type==='bindle-sign-in-end'),{message:'bindle-sign-in-end'});
  assert.deepEqual(events.filter(event=>event.type==='bindle-flow-end').map(event=>event.detail),[{intent:'login',outcome:'completed'}]);
  const order=events.map(event=>event.type).filter(type=>['bindle-session-change','bindle-account-change','bindle-sign-in-start','bindle-sign-in-end'].includes(type));
  assert.deepEqual(order,['bindle-session-change','bindle-sign-in-start','bindle-session-change','bindle-account-change','bindle-sign-in-end'],'derived events follow the controller event');
  assert.deepEqual(events.find(event=>event.type==='bindle-sign-in-start').detail,{source:'form',presentation:'popup'});
  assert.equal(events.find(event=>event.type==='bindle-sign-in-end').detail.session.subject,provider.accounts[0].subject);
  assert.deepEqual(events.find(event=>event.type==='bindle-account-change').detail,{previous:null,session:session.session,cause:'sign-in'});
  const account=shadow('bindle-account'),trigger=account.querySelector('.trigger');
  assert.equal(account.querySelectorAll('[role=status]').length,1);
  assert.equal(trigger.getAttribute('aria-label'),'Account: Signed in · 3sln.example');
  assert.ok(!account.textContent.includes('Alex Example'),'no profile shown without a profile grant');
  assert.equal(account.querySelectorAll('.avatar.monogram .cell').length,25,'no granted name: subject monogram');
  assert.equal(signIn.state.last.outcome,'completed');
  uninstall();
});

test('profile button: one dialog container without role=menu, Escape returns focus, toggle reasons',async()=>{
  const {session,events,uninstall}=await mount(page());await signIn();
  const account=document.querySelector('bindle-account'),root=account.shadowRoot,trigger=root.querySelector('.trigger');
  assert.equal(trigger.getAttribute('aria-haspopup'),'dialog');assert.equal(root.querySelector('[role=menu],[role=menuitem]'),null);
  trigger.focus();key(trigger,'ArrowDown');
  const panel=root.querySelector('dialog.panel');
  assert.equal(trigger.getAttribute('aria-expanded'),'true');assert.equal(panel.open,true);assert.equal(panel.getAttribute('aria-label'),'Account');
  assert.equal(root.querySelector('[role=list]').getAttribute('aria-label'),'Account actions');
  assert.ok(root.activeElement&&panel.contains(root.activeElement),'keyboard opening focuses inside the panel');
  // The standard provider in this mock declares every intent: all requested actions render, Manage uses the issuer root.
  assert.deepEqual(buttons(root),['Use another account','Use a different provider',"Confirm it's you",'Sign out of this app','Sign out of 3sln.example…','Manage at 3sln.example']);
  const manage=[...root.querySelectorAll('a.item')].at(-1);assert.equal(manage.getAttribute('href'),'https://3sln.example/');assert.equal(manage.getAttribute('rel'),'noopener noreferrer');
  key(root.activeElement,'Escape');
  assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.equal(root.activeElement,trigger);
  assert.deepEqual(events.filter(event=>event.type==='bindle-menu-toggle').map(event=>event.detail),[{open:true,reason:'trigger'},{open:false,reason:'escape'}]);
  const providerItem=[...root.querySelectorAll('button.item')].find(item=>item.textContent==='Sign out of 3sln.example…');
  assert.match(root.getElementById(providerItem.getAttribute('aria-describedby')).textContent,/Other apps and accounts stay signed in/);
  // App sign-out never starts a provider flow; the account change reports its cause.
  trigger.click();const flows=events.filter(event=>event.type==='bindle-flow-start').length;
  [...root.querySelectorAll('button.item')].find(item=>item.textContent==='Sign out of this app').click();await tick();
  assert.equal(session.session,null);assert.equal(events.filter(event=>event.type==='bindle-flow-start').length,flows);
  assert.equal(events.filter(event=>event.type==='bindle-account-change').at(-1).detail.cause,'sign-out');
  assert.ok(root.querySelector('slot[name=signed-out]'));
  uninstall();
});

test('minimal provider: required handle, no unsupported actions, "Use another account" asks for a handle',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example',declaration:'minimal'});
  const {session,events,driver,uninstall}=await mount(page(),{provider});
  const signInRoot=shadow('bindle-sign-in');
  assert.equal(signInRoot.querySelector('.continue'),null,'no identity-optional button');assert.equal(signInRoot.querySelector('input').hasAttribute('required'),true);
  submit(document.querySelector('bindle-sign-in'),'');assert.equal(signInRoot.querySelector('[role=alert]').textContent,'Enter your Bindle identity.');
  // No popup is declared, so a submission redirects (not exercised here); complete via the callback instead.
  await session.controller.completeCallback(provider.authorize((await session.client.beginAuthorization({identity:'alex'})).authorizationUrl));
  await until(()=>session.session);
  const root=shadow('bindle-account');root.querySelector('.trigger').click();
  assert.deepEqual(buttons(root),['Use another account','Use a different provider','Sign out of this app','Manage at 3sln.example'],'reauth and provider sign-out are omitted even when requested');
  [...root.querySelectorAll('button.item')].find(item=>item.textContent==='Use another account').click();
  assert.ok(root.querySelector('form.handle'),'inline handle field');assert.equal(driver.opened.length,0);
  root.querySelector('form.handle').dispatchEvent(new window.Event('submit',{cancelable:true}));
  assert.equal(root.querySelector('form.handle [role=alert]').textContent,'Enter your Bindle identity.');
  assert.equal(events.filter(event=>event.type==='bindle-flow-start').length,0);
  uninstall();
});

test('standard provider: "Continue with host", select-account switch, failure keeps the session',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example',declaration:'standard',accounts:[{handle:'alex'},{handle:'sam'}]});
  let choice={decision:'approve'};const {session,events,uninstall}=await mount(page(),{provider,decide:()=>choice});
  const continueButton=shadow('bindle-sign-in').querySelector('.continue');
  assert.equal(continueButton.textContent,'Continue with 3sln.example');assert.equal(shadow('bindle-sign-in').querySelector('input').hasAttribute('required'),false);
  continueButton.click();await until(()=>session.session);
  assert.equal([...provider.entries.values()][0].loginHint,undefined);
  const first=session.session,root=shadow('bindle-account');root.querySelector('.trigger').click();
  assert.deepEqual(buttons(root),['Use another account','Use a different provider','Sign out of this app','Manage at 3sln.example']);
  choice={decision:'deny'};[...root.querySelectorAll('button.item')].find(item=>item.textContent==='Use another account').click();
  await until(()=>events.some(event=>event.type==='bindle-account-change-failed'));
  assert.deepEqual(events.find(event=>event.type==='bindle-account-change-failed').detail,{code:'canceled'});assert.equal(session.session,first);
  assert.equal([...provider.entries.values()].at(-1).intent,'select-account');
  choice={decision:'approve',account:provider.accounts[1]};root.querySelector('.trigger').click();
  [...root.querySelectorAll('button.item')].find(item=>item.textContent==='Use another account').click();
  await until(()=>events.some(event=>event.type==='bindle-account-change'&&event.detail.cause==='switch'));
  const change=events.find(event=>event.type==='bindle-account-change'&&event.detail.cause==='switch').detail;
  assert.equal(change.previous,first.subject);assert.equal(change.session.subject,provider.accounts[1].subject);
  assert.ok(!events.some(event=>event.type==='bindle-session-change'&&event.detail===null&&events.indexOf(event)>2),'no intermediate null during a switch');
  uninstall();
});

test('full provider: provider manage URL, island hook consulted, islands="off" and island-issuers restrict it',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example',declaration:'full',profile:true,picture:true});
  const {session,uninstall}=await mount(page(),{provider});
  assert.equal(session.capabilities.profile,true);assert.ok(session.capabilities.islands.signIn);
  // This window has no MessageChannel, so the mounter declines and the standard composition stays (islands: elements-islands.test.mjs).
  await tick();assert.equal(document.querySelector('bindle-sign-in').state.islands,'off');assert.ok(shadow('bindle-sign-in').querySelector('form'));
  await signIn();
  const account=document.querySelector('bindle-account'),root=account.shadowRoot;root.querySelector('.trigger').click();
  assert.equal([...root.querySelectorAll('a.item')].at(-1).getAttribute('href'),'https://3sln.example/console/apps');
  assert.equal(root.querySelector('.avatar').classList.contains('picture'),true,'granted picture on the issuer origin');
  root.querySelector('.avatar img').dispatchEvent(new window.Event('error'));
  assert.equal(root.querySelector('.avatar .initials').textContent,'AE','picture error falls back to initials');
  assert.deepEqual(account.state.islands,{avatar:'off',switcher:'off'});assert.equal(account.state.capabilities.profile,true);
  session.setAttribute('islands','off');assert.equal(session.capabilities.profile,false);
  session.setAttribute('islands','auto');session.setAttribute('island-issuers','https://other.example');assert.equal(session.capabilities.profile,false);
  session.setAttribute('island-issuers','https://3sln.example');assert.equal(session.capabilities.profile,true);
  uninstall();
});

test('typed providers: unsupported is an error without fallback; a 404 offers the default host only',async()=>{
  const def=createMockProvider({issuer:'https://3sln.example'}),below=createMockProvider({issuer:'https://below.example',manifestPatch:{login_presentation:['popup']}});
  const {events,uninstall}=await mount(page(),{provider:def,providers:[def,below]});
  const element=document.querySelector('bindle-sign-in');
  submit(element,'alex@below.example');await until(()=>element.shadowRoot.querySelector('[role=alert]').textContent);
  assert.equal(element.shadowRoot.querySelector('[role=alert]').textContent,"This provider isn't supported.");
  assert.equal(events.some(event=>event.type==='bindle-email-fallback'),false);
  submit(element,'alex@mail.example');await until(()=>events.some(event=>event.type==='bindle-email-fallback'));
  assert.equal(events.find(event=>event.type==='bindle-email-fallback').detail.provider,'https://3sln.example');
  assert.deepEqual(events.filter(event=>event.type==='bindle-sign-in-end').map(event=>event.detail),[{outcome:'discovery-error',code:'unsupported-provider'},{outcome:'discovery-error',code:'no-provider'}]);
  uninstall();
});

test('blocked popup with prompt fallback shows an alert with Try again and Continue in this tab',async()=>{
  const {events,uninstall}=await mount(page(undefined,'popup-fallback="prompt"'),{blocked:true});
  submit(document.querySelector('bindle-sign-in'),'alex');await tick();
  const root=shadow('bindle-sign-in'),alert=root.querySelector('.notice[role=alert]');
  assert.match(alert.textContent,/blocked the sign-in window/);
  assert.deepEqual([...alert.querySelectorAll('button')].map(button=>button.textContent),['Try again','Continue in this tab']);
  assert.equal(events.find(event=>event.type==='bindle-flow-end').detail.outcome,'popup-blocked');
  assert.deepEqual(events.find(event=>event.type==='bindle-sign-in-end').detail,{outcome:'popup-blocked',code:'popup-blocked'});
  uninstall();
});

test('waiting state announces the provider host and keeps Continue in this tab visible',async()=>{
  const {session,uninstall}=await mount(page(),{decide:()=>new Promise(()=>{})});
  submit(document.querySelector('bindle-sign-in'),'alex@3sln.example');
  const root=shadow('bindle-sign-in');await until(()=>root.querySelector('[role=status]').textContent.startsWith('A sign-in window'));
  assert.equal(root.querySelector('[role=status]').textContent,'A sign-in window from 3sln.example opened.');
  assert.deepEqual([...root.querySelectorAll('.notice button')].map(button=>button.textContent),['Continue in this tab']);
  session.cancelFlow();await tick();assert.equal(root.querySelector('.notice'),null);
  uninstall();
});

test('invalid input is reported inline and never opens a window',async()=>{
  const {driver,uninstall}=await mount(page());
  const signIn=document.querySelector('bindle-sign-in');submit(signIn,'alex@bad host');
  assert.equal(driver.opened.length,0);
  const input=signIn.shadowRoot.querySelector('input');assert.equal(input.getAttribute('aria-invalid'),'true');
  assert.equal(signIn.shadowRoot.querySelector('[role=alert]').textContent,'Enter a handle like alex@provider.example.');
  signIn.setAttribute('identity-required','');submit(signIn,'  ');assert.equal(signIn.shadowRoot.querySelector('[role=alert]').textContent,'Enter your Bindle identity.');assert.equal(driver.opened.length,0);
  uninstall();
});

test('granted profile: initials avatar and label; Spanish locale and dark theme with color-scheme',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example',profile:true});
  const {uninstall}=await mount(page(undefined,'lang="es" theme="dark"'),{provider});
  const element=document.querySelector('bindle-sign-in');
  assert.equal(element.shadowRoot.querySelector('label').textContent,'Tu identidad Bindle');
  const signInRoot=element.shadowRoot.querySelector('.root');assert.ok(signInRoot.classList.contains('dark'));assert.equal(signInRoot.style.getPropertyValue('color-scheme'),'dark');
  await signIn();
  const root=shadow('bindle-account');
  assert.equal(root.querySelector('.trigger').getAttribute('aria-label'),'Cuenta: Alex Example');
  assert.equal(root.querySelector('.avatar .initials').textContent,'AE');
  const tile=root.querySelector('.avatar');assert.match(tile.style.getPropertyValue('--_id-bg-l'),/^#[0-9a-f]{6}$/);assert.match(tile.style.getPropertyValue('--_id-bg-d'),/^#[0-9a-f]{6}$/);
  uninstall();
});

test('<bindle-avatar>: standard chain, island state, and an embedder dark surface selects the dark scheme',async()=>{
  const provider=createMockProvider({issuer:'https://3sln.example',profile:true});
  const {session,uninstall}=await mount(`<bindle-session client-id="${clientId}" redirect-uri="${redirectUri}"><bindle-avatar style="--bindle-surface:#101010"></bindle-avatar><bindle-sign-in></bindle-sign-in></bindle-session>`,{provider});
  const avatar=document.querySelector('bindle-avatar');assert.equal(avatar.shadowRoot.querySelector('.avatar'),null,'nothing before a session');
  await signIn();await tick();
  assert.deepEqual(avatar.state,{islands:'off',source:'initials'});
  assert.equal(avatar.shadowRoot.querySelector('.avatar').getAttribute('aria-label'),'Identity picture');
  assert.ok(avatar.shadowRoot.querySelector('.root').classList.contains('dark'),'--bindle-surface luminance below 0.18 means dark');
  await session.signOut();await tick();assert.equal(avatar.shadowRoot.querySelector('.avatar'),null);
  uninstall();
});

test('missing configuration is a bindle-error and flows resolve without throwing',async()=>{
  const {events,uninstall}=await mount('<bindle-session><bindle-sign-in></bindle-sign-in></bindle-session>',{client:false});
  const element=document.querySelector('bindle-session');await element.ready;
  assert.equal(events.find(event=>event.type==='bindle-error').detail.code,'configuration');
  assert.deepEqual(await element.signIn(),{outcome:'canceled',code:'not-configured'});
  uninstall();
});

test('controller attribute links elements outside the session subtree',async()=>{
  const {session,driver,uninstall}=await mount(`<bindle-session id="s1" client-id="${clientId}" redirect-uri="${redirectUri}"></bindle-session><bindle-sign-in controller="s1"></bindle-sign-in>`);await tick();
  const signIn=document.querySelector('bindle-sign-in');assert.equal(signIn.session,session);
  submit(signIn,'alex@3sln.example');assert.equal(driver.opened.length,1);await until(()=>session.session);
  uninstall();
});

test('<bindle-login> is gone; without a session <bindle-sign-in> reports the parsed handle',async()=>{
  assert.equal(customElements.get('bindle-login'),undefined);
  const {events,uninstall}=await mount('<bindle-sign-in></bindle-sign-in>',{client:false});
  submit(document.querySelector('bindle-sign-in'),'n.7k3m');
  assert.equal(events.find(event=>event.type==='bindle-login-request').detail.handle,'n.7k3m@3sln.me');
  uninstall();
});

test('theme tokens: profile allowlist and its 13 contrast pairs; failing pairs revert both members',()=>{
  assert.equal(contrastPairs.length,13);
  for(const scheme of ['light','dark'])for(const [fore,back,minimum] of contrastPairs)assert.ok(contrast(providerDefaults[scheme][fore],providerDefaults[scheme][back])>=minimum,`${scheme} ${fore}/${back}`);
  const result=validateThemeTokens({surface:'#ffffff',text:'#fefefe',accent:'red',radius:40,font:'Comic Sans',density:'compact',url:'x',border:'url(x)'});
  assert.deepEqual(result.tokens,{});
  assert.deepEqual([...result.rejected].sort(),['accent','border','density','font','radius','surface','text','url'].sort());
  assert.deepEqual(validateThemeTokens({accent:'#2f5bd3',radius:12}).tokens,{accent:'#2f5bd3',radius:12});
});

test('SDK strings all exist in the SDK catalogue with Spanish parity',async()=>{
  assert.deepEqual(Object.keys(sdkCatalogues.en['']).sort(),Object.keys(sdkCatalogues.es['']).sort());
  const directory=new URL('../src/',import.meta.url),files=[];
  for(const entry of await readdir(directory,{recursive:true}))if(entry.endsWith('.mjs'))files.push(await readFile(new URL(entry,directory),'utf8'));
  const used=new Set();
  for(const source of files)for(const match of source.matchAll(/\bt\((['"])((?:(?!\1).)+)\1/g))used.add(match[2]);
  for(const text of used)assert.ok(text in sdkCatalogues.es[''],`missing SDK string: ${text}`);
  assert.ok(used.size>25);
});

test('<bindle-sign-in default-host> sends the user to the provider it names, composing from that provider',async()=>{
  const def=createMockProvider({issuer:'https://3sln.example',declaration:'minimal'}),other=createMockProvider({issuer:'https://other.example',declaration:'standard'});
  const {session,driver,uninstall}=await mount(`<bindle-session client-id="${clientId}" redirect-uri="${redirectUri}"><bindle-sign-in default-host="other.example"></bindle-sign-in></bindle-session>`,{provider:def,providers:[def,other]});
  const element=document.querySelector('bindle-sign-in');
  await until(()=>element.shadowRoot.querySelector('.continue'),{message:"other.example's capabilities"});
  assert.equal(element.shadowRoot.querySelector('.continue').textContent,'Continue with other.example');
  submit(element,'alex');await until(()=>session.session);
  assert.equal(session.session.issuer,'https://other.example');assert.equal([...other.entries.values()][0].loginHint,'alex@other.example');assert.equal(def.entries.size,0);
  assert.equal(driver.opened.length,1);
  uninstall();
});

