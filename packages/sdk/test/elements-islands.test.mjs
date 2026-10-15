// DOM tests for the element side of provider islands (elements/islands.mjs; components profile §3–§5, §10 E1–E10;
// embed-islands §8.2, §10–§11) under happy-dom. Iframe loading is disabled: each test plays the island end of the
// handshake through a fake contentWindow and the real MessageChannel, against testing.mjs's mock provider. Nothing
// here is browser evidence; tests/browser/islands-embed.mjs mounts the real islands.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';

const window=new Window({url:'https://app.example/',settings:{disableIframePageLoading:true}});
for(const name of ['document','HTMLElement','customElements','Node','Element','KeyboardEvent','MouseEvent'])globalThis[name]=window[name];
globalThis.window=window;window.MessageChannel=MessageChannel;
after(()=>window.happyDOM.close());

const {defineBindleElements}=await import('../src/elements/index.mjs');
const {createMockProvider,memoryStorage,installPopupDrivers}=await import('../src/testing.mjs');
const {BindleClient}=await import('../src/identity.mjs');
const {parseIslandName}=await import('../src/islands-protocol.mjs');
defineBindleElements();

const issuer='https://3sln.example',embed='https://embed.3sln.example',clientId='https://app.example/client',redirectUri='https://app.example/callback';
const tick=(ms=15)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,{timeout=3000,message='condition'}={}){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error(`Timed out waiting for ${message}.`);await tick(5);}}
const types=['bindle-session-change','bindle-sign-in-start','bindle-sign-in-end','bindle-account-change','bindle-account-change-failed','bindle-account-select','bindle-menu-toggle'];
async function mount(html,{provider=createMockProvider({issuer,declaration:'full',components:true})}={}){
  document.body.innerHTML='';
  const driver=installPopupDrivers(window,[provider],{});
  const template=document.createElement('template');template.innerHTML=html;
  template.content.querySelector('bindle-session').client=new BindleClient({clientId,redirectUri,fetcher:(input,init)=>provider.fetch(input,init),storage:memoryStorage(),history:{replaceState(){}},defaultHost:'3sln.example'});
  const events=[],listener=event=>events.push({type:event.type,detail:event.detail});for(const type of types)document.addEventListener(type,listener);
  document.body.append(template.content);
  const session=document.querySelector('bindle-session');await session.ready;await until(()=>session.capabilities,{message:'capabilities'});
  return {provider,events,session,uninstall:()=>{driver.uninstall();for(const type of types)document.removeEventListener(type,listener);}};
}
// The island end: a fake contentWindow receives the init and its port; `reply` answers ready (or a given message).
function island(iframe,{reply=true,ready}={}){
  const record={messages:[],port:null,init:null,send:message=>record.port.postMessage(message)};
  Object.defineProperty(iframe,'contentWindow',{configurable:true,value:{postMessage(data,origin,transfer){
    record.init={data,origin};record.port=transfer[0];record.port.onmessage=event=>record.messages.push(event.data);
    if(reply)record.port.postMessage(ready??{v:1,type:'ready',part:data.part,version:data.version,protocol:[1],issuer});
  }}});
  iframe.dispatchEvent(new window.Event('load'));
  return record;
}
const frameIn=async(element,selector)=>{let frame;await until(()=>frame=element.shadowRoot?.querySelector(`${selector} iframe`),{message:`iframe in ${selector}`});return frame;};
const ofType=(record,type)=>record.messages.filter(message=>message.type===type);
const signInPage='<bindle-session client-id="https://app.example/client" redirect-uri="https://app.example/callback"><bindle-sign-in></bindle-sign-in></bindle-session>';
const accountPage='<bindle-session client-id="https://app.example/client" redirect-uri="https://app.example/callback"><bindle-account actions="switch sign-out manage"><span slot="signed-out">signed out</span></bindle-account><bindle-avatar></bindle-avatar></bindle-session>';

test('sign-in island: exact iframe and handshake, prepare per port, translated events after the app credential is ready',async()=>{
  const {provider,events,session,uninstall}=await mount(signInPage),element=document.querySelector('bindle-sign-in');
  const iframe=await frameIn(element,'.island');
  assert.equal(iframe.getAttribute('src'),`${embed}/embed?client=${encodeURIComponent(clientId)}#sign-in.v1`);
  const name=parseIslandName(iframe.name);assert.ok(name,'name grammar (profile §3.1)');assert.equal(name.lang,'en-US');
  assert.equal(iframe.getAttribute('referrerpolicy'),'no-referrer');assert.equal(iframe.hasAttribute('sandbox'),false);assert.equal(iframe.hasAttribute('credentialless'),false);
  assert.match(iframe.getAttribute('allow'),/^identity-credentials-get 'none'; storage-access 'none';.* sync-xhr 'none'$/,'FedCM is not delegated unless declared and allowed');
  assert.equal(iframe.title,'Continue with 3sln.example');assert.equal(element.state.islands,'mounting');
  assert.ok(element.shadowRoot.querySelector('form'),'the standard composition shows until the island is live');
  const fake=island(iframe);
  assert.equal(fake.init.origin,embed,'exact targetOrigin, never *');
  assert.deepEqual(Object.keys(fake.init.data).sort(),['colorScheme','locale','nonce','part','props','theme','type','v','version']);
  assert.equal(fake.init.data.nonce,name.nonce);assert.deepEqual(fake.init.data.props,{seq:0,label:'continue',variant:'filled'});
  await until(()=>element.state.islands==='live',{message:'live'});
  assert.equal(iframe.isConnected,true,'re-rendering the element never replaces the mounted iframe');
  assert.equal(element.shadowRoot.querySelector('form'),null,'the handle form moves behind "Use a different provider"');
  assert.ok(element.shadowRoot.querySelector('[part=other-provider]'));
  await until(()=>ofType(fake,'prepare').length===1,{message:'prepare'});
  assert.deepEqual(ofType(fake,'session'),[{v:1,type:'session',subject:null}]);
  const prepare=ofType(fake,'prepare')[0];
  assert.equal(prepare.redirectUri,redirectUri);assert.match(prepare.challenge,/^[\w-]{43}$/);assert.match(prepare.state,/^[\w-]{43}$/);assert.deepEqual(prepare.uiLocales,['en-US']);
  assert.equal(session.client.storage.length,0,'island transactions stay in memory');
  // A user-activated island flow; the island created the entry with the prepare inputs (here: directly at the mock).
  fake.send({v:1,type:'flow',phase:'started'});
  await until(()=>events.some(event=>event.type==='bindle-sign-in-start'),{message:'start'});
  assert.deepEqual(events.find(event=>event.type==='bindle-sign-in-start').detail,{source:'island',presentation:'island'});
  const created=await(await provider.fetch(`${issuer}/api/oauth/entries`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId,redirectUri,challenge:prepare.challenge,challengeMethod:'S256',state:prepare.state,intent:'login',requests:[],presentation:'popup',...prepare.dpopJkt?{dpopJkt:prepare.dpopJkt}:{}})})).json();
  const code=new URL(provider.authorize(created.entryId)).searchParams.get('code');
  fake.send({v:1,type:'code',code,state:prepare.state,iss:issuer});fake.send({v:1,type:'flow',phase:'ended',outcome:'completed'});
  await until(()=>events.some(event=>event.type==='bindle-sign-in-end'),{message:'end'});
  const order=events.map(event=>event.type).filter(type=>['bindle-session-change','bindle-sign-in-end'].includes(type));
  assert.deepEqual(order.slice(-2),['bindle-session-change','bindle-sign-in-end'],'completed only after the app credential is ready');
  const end=events.find(event=>event.type==='bindle-sign-in-end').detail;
  assert.equal(end.outcome,'completed');assert.equal(end.session.subject,provider.accounts[0].subject);assert.ok(Object.isFrozen(end));
  assert.equal(session.session.subject,provider.accounts[0].subject);
  await until(()=>ofType(fake,'prepare').length===2,{message:'fresh prepare after the flow'});
  assert.notEqual(ofType(fake,'prepare')[1].state,prepare.state);
  assert.deepEqual(ofType(fake,'session').at(-1),{v:1,type:'session',subject:provider.accounts[0].subject});
  uninstall();
});

test('sign-in island: codes outside a flow or for another prepare are violations; three tear down and degrade the part',async()=>{
  const {events,session,uninstall}=await mount(signInPage),element=document.querySelector('bindle-sign-in');
  const iframe=await frameIn(element,'.island'),fake=island(iframe);
  await until(()=>ofType(fake,'prepare').length===1,{message:'prepare'});
  fake.send({v:1,type:'code',code:'abc',state:ofType(fake,'prepare')[0].state,iss:issuer}); // no flow started
  fake.send({v:1,type:'select',subject:`${issuer}/people/x`}); // not a sign-in type
  fake.send({v:1,type:'flow',phase:'ended',outcome:'completed'}); // ended without started
  await until(()=>element.state.islands==='fallback',{message:'fallback'});
  assert.equal(iframe.isConnected,false);assert.equal(session.capabilities.islands.signIn,null,'degraded for this issuer and document');
  assert.ok(element.shadowRoot.querySelector('form'),'the standard composition is back');
  assert.ok(!events.some(event=>['bindle-sign-in-start','bindle-sign-in-end','bindle-session-change'].includes(event.type)&&event.detail?.source==='island'));
  uninstall();
});

test('sign-in island: an unavailable flow offers the app path; no ready in 3 s, tampering or a foreign issuer fall back',async t=>{
  {
    const {events,uninstall}=await mount(signInPage),element=document.querySelector('bindle-sign-in'),fake=island(await frameIn(element,'.island'));
    await until(()=>element.state.islands==='live');
    fake.send({v:1,type:'flow',phase:'started'});fake.send({v:1,type:'flow',phase:'ended',outcome:'unavailable'});
    await until(()=>events.some(event=>event.type==='bindle-sign-in-end'));
    assert.deepEqual(events.find(event=>event.type==='bindle-sign-in-end').detail,{outcome:'unavailable'});
    assert.ok(element.shadowRoot.querySelector('[part=continue]'),'Continue with the provider (app credentials only) appears');
    uninstall();
  }
  {
    const {session,uninstall}=await mount(signInPage),element=document.querySelector('bindle-sign-in'),iframe=await frameIn(element,'.island');
    island(iframe,{reply:false});await tick(3200);
    assert.equal(element.state.islands,'fallback');assert.equal(iframe.isConnected,false);assert.equal(session.capabilities.islands.signIn,null);
    uninstall();
  }
  {
    const {session,uninstall}=await mount(signInPage),element=document.querySelector('bindle-sign-in'),iframe=await frameIn(element,'.island');
    island(iframe);await until(()=>element.state.islands==='live');
    iframe.setAttribute('sandbox','allow-scripts');await until(()=>element.state.islands==='fallback',{message:'tamper'});
    assert.equal(session.capabilities.islands.signIn,null);
    uninstall();
  }
  {
    const {session,uninstall}=await mount(signInPage),element=document.querySelector('bindle-sign-in'),iframe=await frameIn(element,'.island');
    island(iframe,{ready:{v:1,type:'ready',part:'sign-in',version:1,protocol:[1],issuer:'https://evil.example'}});
    await until(()=>element.state.islands==='fallback',{message:'issuer mismatch'});
    assert.equal(session.capabilities.profile,false,'a foreign ready.issuer disables every part of the declaration');
    uninstall();
  }
});

test('account islands: avatar after sign-in, switcher on intent, select and escape translated, forget on app sign-out',async()=>{
  const {provider,events,session,uninstall}=await mount(accountPage),account=document.querySelector('bindle-account'),avatarElement=document.querySelector('bindle-avatar');
  assert.equal(account.shadowRoot?.querySelector('iframe')??null,null,'nothing mounts while signed out');
  await session.signIn({host:'3sln.example'});await until(()=>session.session,{message:'sign-in'});
  const subject=session.session.subject,avatarFrame=await frameIn(account,'.avatar-island');
  assert.equal(avatarFrame.getAttribute('aria-hidden'),'true');assert.equal(avatarFrame.tabIndex,-1);assert.equal(avatarFrame.style.pointerEvents,'none');
  assert.match(avatarFrame.getAttribute('src'),/#avatar\.v1$/);assert.match(avatarFrame.getAttribute('allow'),/^identity-credentials-get 'none';/);
  const avatar=island(avatarFrame);await until(()=>account.state.islands.avatar==='live');
  await until(()=>ofType(avatar,'session').length===1);assert.deepEqual(ofType(avatar,'session'),[{v:1,type:'session',subject}]);
  assert.equal(ofType(avatar,'prepare').length,0,'avatar gets no flow inputs');
  const standalone=island(await frameIn(avatarElement,'.island'));await until(()=>avatarElement.state.islands==='live');
  // The switcher mounts on first intent and lives in the panel.
  account.shadowRoot.querySelector('.trigger').dispatchEvent(new window.Event('pointerenter'));
  const switcherFrame=await frameIn(account,'.switcher');assert.equal(switcherFrame.title,'Account');
  const switcher=island(switcherFrame);await until(()=>account.state.islands.switcher==='live');
  assert.equal(switcherFrame.isConnected,true);assert.equal(avatarFrame.isConnected,true);
  await until(()=>ofType(switcher,'prepare').length===1);
  assert.deepEqual(switcher.init.data.props,{seq:0,density:'regular',actions:['use-another','manage','remove']});
  assert.deepEqual(account.state.actions,['sign-out'],'switch and manage move into the live switcher');
  account.shadowRoot.querySelector('.trigger').click();assert.equal(account.open,true);
  switcher.send({v:1,type:'escape'});await until(()=>!account.open,{message:'escape closes'});
  assert.equal(events.filter(event=>event.type==='bindle-menu-toggle').at(-1).detail.reason,'escape');
  // select: only a held app session for exactly that subject is surfaced; repeats within 500 ms are one.
  switcher.send({v:1,type:'select',subject});switcher.send({v:1,type:'select',subject});
  await until(()=>events.some(event=>event.type==='bindle-account-select'));await tick(30);
  assert.deepEqual(events.filter(event=>event.type==='bindle-account-select').map(event=>event.detail),[{subject}]);
  switcher.send({v:1,type:'select',subject:`${issuer}/people/unknown`});
  await until(()=>events.some(event=>event.type==='bindle-account-change-failed'));
  assert.deepEqual(events.find(event=>event.type==='bindle-account-change-failed').detail,{code:'no-session'});
  // A type outside the part's contract is a violation, never translated.
  avatar.send({v:1,type:'select',subject});await tick(30);assert.equal(events.filter(event=>event.type==='bindle-account-select').length,1);
  // App sign-out: forget precedes session{null}; the islands stay mounted to receive both.
  await session.signOut();await tick(30);
  for(const record of [avatar,switcher,standalone]){
    const at=record.messages.findIndex(message=>message.type==='forget');
    assert.deepEqual(record.messages.slice(at,at+2),[{v:1,type:'forget',subject},{v:1,type:'session',subject:null}]);
  }
  // Sign-out cleared every pending transaction, so the switcher gets a fresh prepare it can complete.
  await until(()=>ofType(switcher,'prepare').length===2,{message:'prepare after sign-out'});
  assert.ok(session.client.hasPending(ofType(switcher,'prepare')[1].state));assert.equal(session.client.hasPending(ofType(switcher,'prepare')[0].state),false);
  assert.equal(avatarFrame.isConnected,true);assert.equal(switcherFrame.isConnected,true);
  assert.equal(account.state.islands.avatar,'live');assert.equal(account.state.status,'signed-out');
  // A later island of this issuer still receives the queued forget; the app signing in as that subject withdraws it.
  document.querySelector('bindle-avatar').remove();
  const later=document.createElement('bindle-avatar');session.append(later);
  await session.signIn({host:'3sln.example'});await until(()=>session.session);
  const laterIsland=island(await frameIn(later,'.island'));await until(()=>later.state.islands==='live');await tick(30);
  assert.equal(ofType(laterIsland,'forget').length,0,'signing in again as that subject withdrew the queued forget');
  assert.ok(provider);uninstall();
});

test('account: a second load event tears the island down (unexpected navigation)',async()=>{
  const {session,uninstall}=await mount(accountPage),account=document.querySelector('bindle-account');
  await session.signIn({host:'3sln.example'});await until(()=>session.session);
  const frame=await frameIn(account,'.avatar-island');island(frame);await until(()=>account.state.islands.avatar==='live');
  frame.dispatchEvent(new window.Event('load'));
  await until(()=>account.state.islands.avatar==='fallback');assert.equal(frame.isConnected,false);
  assert.equal(session.capabilities.islands.avatar,null);
  uninstall();
});

test('review fixes: teardown mid-flow still ends the flow; an exchanged code decides the outcome',async()=>{
  {
    const {events,uninstall}=await mount(signInPage),element=document.querySelector('bindle-sign-in'),iframe=await frameIn(element,'.island'),fake=island(iframe);
    await until(()=>element.state.islands==='live');
    fake.send({v:1,type:'flow',phase:'started'});await until(()=>events.some(event=>event.type==='bindle-sign-in-start'));
    iframe.setAttribute('allow','');await until(()=>element.state.islands==='fallback');
    await until(()=>events.some(event=>event.type==='bindle-sign-in-end'),{message:'end after teardown'});
    assert.deepEqual(events.find(event=>event.type==='bindle-sign-in-end').detail,{outcome:'unavailable'});
    uninstall();
  }
  {
    const {provider,events,session,uninstall}=await mount(signInPage),element=document.querySelector('bindle-sign-in'),fake=island(await frameIn(element,'.island'));
    await until(()=>ofType(fake,'prepare').length===1);const prepare=ofType(fake,'prepare')[0];
    const created=await(await provider.fetch(`${issuer}/api/oauth/entries`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId,redirectUri,challenge:prepare.challenge,challengeMethod:'S256',state:prepare.state,intent:'login',requests:[],presentation:'popup',...prepare.dpopJkt?{dpopJkt:prepare.dpopJkt}:{}})})).json();
    const code=new URL(provider.authorize(created.entryId)).searchParams.get('code');
    fake.send({v:1,type:'flow',phase:'started'});fake.send({v:1,type:'code',code,state:prepare.state,iss:issuer});fake.send({v:1,type:'flow',phase:'ended',outcome:'canceled'});
    await until(()=>events.some(event=>event.type==='bindle-sign-in-end'));
    assert.equal(events.find(event=>event.type==='bindle-sign-in-end').detail.outcome,'completed','the app holds the session, so the event says so');assert.ok(session.session);
    uninstall();
  }
});

test('review fixes: provider end-session also sends forget to the islands',async()=>{
  const {session,uninstall}=await mount(accountPage),account=document.querySelector('bindle-account');
  await session.signIn({host:'3sln.example'});await until(()=>session.session);const subject=session.session.subject;
  const avatar=island(await frameIn(account,'.avatar-island'));await until(()=>account.state.islands.avatar==='live');
  await session.endProviderSession();await until(()=>!session.session,{message:'provider sign-out'});await tick(30);
  assert.ok(ofType(avatar,'forget').some(message=>message.subject===subject),JSON.stringify(avatar.messages.map(m=>m.type)));
  uninstall();
});
