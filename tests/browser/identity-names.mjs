import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/'});
const names=['document','HTMLElement','CustomEvent','Event','EventTarget','ErrorEvent','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));for(const name of names)globalThis[name]=window[name];
const {Engine,Provider,dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {default:StateProvider}=await import('../../apps/web/src/providers/browser-state.mjs');
const {ClaimHandle,DownloadNameCertificate}=await import('../../apps/web/src/bl/identity.mjs');
const {ConfirmOwner,CancelOwnerConfirmation,cancelStepUp}=await import('../../apps/web/src/bl/step-up.mjs');
const {OwnerFlow}=await import('../../apps/web/src/bl/owner-flow.mjs');
const {RevokeOtherDevices}=await import('../../apps/web/src/bl/release.mjs');
const {default:stepUpView}=await import('../../apps/web/src/ui/step-up.mjs');
const {default:authView}=await import('../../apps/web/src/ui/release-auth.mjs');
const {default:securityView}=await import('../../apps/web/src/ui/release-security.mjs');
const {default:recoveryView}=await import('../../apps/web/src/ui/release-recovery.mjs');
const {default:localize}=await import('../../apps/web/src/ui/localize.mjs');
const {createLocalization}=await import('../../packages/i18n/index.mjs');
const {createNameAssignment}=await import('../../packages/recovery/identity-backup.mjs');
const origin='https://space.example',account={id:crypto.randomUUID(),handle:'n.2a',paidHandle:null,aliases:['n.2a']};
const base={config:{origin,localDevelopment:true},brand:{name:'Personal Space',host:'space.example'},session:{account},data:{account,grants:[]},auth:'signup',authMethod:'password'};
const render=(view,state,locale='en')=>{const root=document.createElement('main');dodo.reconcile(root,[localize(view(state),createLocalization({locale}))]);return root;};
test.after(async()=>{await window.happyDOM.close();for(const name of names)globalThis[name]=previous[name];});
async function fixture(){
 const calls=[],downloads=[];
 const api={csrf:'csrf',async request(path,body){calls.push({path,body});return {};},async get(path){calls.push({path});return {account,grants:[]};}};
 const browser={download:(...args)=>downloads.push(args)};
 const engine=new Engine({providers:{state:StateProvider,api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),portalContributions:Provider.fromSingleton({}),recoveryFile:Provider.fromSingleton({})}});
 const write=patch=>engine.container.use({state:{write:true}},({state})=>state.transition(next=>Object.assign(next,patch)));
 await write({...base,loading:false});
 return {api,browser,engine,calls,downloads,write,read:()=>engine.container.use(['state'],({state})=>state.snapshot()),act:action=>engine.dispatch(action).next('complete')};
}

test('signup assigns names without asking for a base; login and localized setup display the complete returned handle',()=>{
 const signup=render(authView,{...base,signupStep:'credential',signupTermsAccepted:true});assert.equal(signup.querySelector('[name=handle]'),null);assert.match(signup.textContent,/unique handle starting with n\./);
 const spanish=render(authView,{...base,signupStep:'credential',signupTermsAccepted:true},'es');assert.match(spanish.textContent,/nombre de usuario único/);
 const login=render(authView,{...base,auth:'login'}),input=login.querySelector('[name=handle]');
 const pattern=new RegExp('^(?:'+input.pattern+')$','v');for(const name of ['N.OI','n.2a','7alias','Alice'])assert.equal(pattern.test(name),true);assert.equal(pattern.test('name@evil.example'),false);
 const setup=render(recoveryView,{...base,pending:true,pendingStage:'recovery',pendingHandle:'n.2a',route:{kind:'recovery-setup'}},'es');assert.match(setup.textContent,/Tu nombre de usuario asignado/);assert.equal(setup.querySelector('strong[translate=no]').textContent,'n.2a@space.example');
});

test('security shows permanent identity, one-alias consequences, historical paid eligibility and separate public certificate controls',()=>{
 const unclaimed=render(securityView,base);assert.match(unclaimed.textContent,/ever had a verified paid subscription/);assert.match(unclaimed.textContent,/cannot be changed, transferred or reassigned/);assert.equal(unclaimed.querySelector('[name=confirmed]').type,'checkbox');
 const input=unclaimed.querySelector('[name=handle]');assert.equal(new RegExp('^(?:'+input.pattern+')$','v').test('7alias'),true);
 const claimed={...account,paidHandle:'7alias',aliases:['n.2a','7alias']};const spanish=render(securityView,{...base,data:{account:claimed,grants:[]}},'es');
 assert.equal(spanish.querySelector('[name=handle]'),null);assert.match(spanish.textContent,/7alias@space\.example/);assert.match(spanish.textContent,/incluso después de cancelarla/);
 const downloads=[...spanish.querySelectorAll('button')].filter(button=>button.textContent.includes('Descargar certificado'));assert.equal(downloads.length,2);assert.match(spanish.textContent,new RegExp(account.id));
});

test('claim requires explicit permanent-choice acknowledgement and server success before publishing an alias',async()=>{
 const f=await fixture();try{
  await f.act(new ClaimHandle({values:{handle:'7alias'}}));assert.equal(f.calls.length,0);
  f.api.request=async(path,body)=>{f.calls.push({path,body});throw Object.assign(Error('Paid history required'),{status:403});};
  await f.act(new ClaimHandle({values:{handle:'7alias',confirmed:'on'}}));assert.equal((await f.read()).data.account.paidHandle,null);
  const claimed={...account,paidHandle:'7alias',aliases:['n.2a','7alias']};
  f.api.request=async(path,body)=>{f.calls.push({path,body});return {account:claimed};};f.api.get=async()=>({account:claimed,grants:[]});
  await f.act(new ClaimHandle({values:{handle:'7alias',confirmed:'on'}}));const state=await f.read();assert.equal(state.data.account.handle,'n.2a');assert.equal(state.data.account.id,account.id);assert.equal(state.session.account.paidHandle,'7alias');
  const count=f.calls.length;await f.act(new ClaimHandle({values:{handle:'other-name',confirmed:'on'}}));assert.equal(f.calls.length,count);
 }finally{await f.engine.dispose();}
});

test('certificate download verifies the selected public assignment and rejects tampering and cross-owner late responses',async()=>{
 const f=await fixture();try{
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const authority={kid:'test-provider',privateKey:pair.privateKey,publicKey:pair.publicKey};
  const certificate=await createNameAssignment({issuer:origin,entity:account.id,handle:account.handle,assignmentId:crypto.randomUUID(),issuedAt:Date.now()},authority);
  const result={fileName:'handle-claim-n.2a.json',content:JSON.stringify(certificate)};
  f.api.request=async()=>result;f.api.get=async()=>({kid:authority.kid,publicKey:await crypto.subtle.exportKey('jwk',pair.publicKey)});
  await f.act(new DownloadNameCertificate({handle:account.handle}));assert.equal(f.downloads.length,1);const downloaded=JSON.parse(f.downloads[0][1]);assert.equal(downloaded.handle,account.handle);assert.equal(downloaded.entity,account.id);assert.equal(downloaded.keychain,undefined);assert.equal(downloaded.recoveryToken,undefined);
  const altered=structuredClone(certificate);altered.handle='other-name';f.api.request=async()=>({...result,content:JSON.stringify(altered)});await f.act(new DownloadNameCertificate({handle:account.handle}));assert.equal(f.downloads.length,1);
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});f.api.request=()=>{entered();return new Promise(resolve=>{release=resolve;});};
  const pending=f.act(new DownloadNameCertificate({handle:account.handle}));await waiting;await f.write({session:{account:{id:crypto.randomUUID()}},beamGeneration:1,busy:false});release(result);await pending;assert.equal(f.downloads.length,1);
 }finally{await f.engine.dispose();}
});

function promptReady(f){return new Promise(resolve=>{const changed=async()=>{const state=await f.read();if(state.stepUp&&!state.busy){f.engine.feed.removeEventListener('browser-state-updated',changed);resolve(state.stepUp);}};f.engine.feed.addEventListener('browser-state-updated',changed);changed();});}
for(const method of ['password','passkey'])test(`inline ${method} confirmation retries the rejected request once without consuming the original form again`,{timeout:5000},async()=>{
 const f=await fixture();let pending;try{
  let fresh=false,claims=0,consumed=0,assertions=0;const bodies=[],options={challenge:'challenge'};
  f.browser.consumeSubmission=id=>{assert.equal(id,'original');consumed++;return {handle:'7alias',confirmed:'on'};};f.browser.authenticatePasskey=async value=>{assert.deepEqual(value,options);assertions++;return {id:'own-key'};};
  f.api.request=async(path,body)=>{f.calls.push({path,body});if(path.endsWith('/begin'))return {password:method==='password',passkey:method==='passkey',authenticationOptions:options};if(path.endsWith('/step-up')){assert.equal(body.method,method);fresh=true;return {};}claims++;bodies.push(body);if(!fresh)throw Object.assign(Error('Confirm first'),{code:'reauthentication_required',status:403});return {};};
  const ready=promptReady(f);pending=f.act(new ClaimHandle({operationId:'original'}));const prompt=await ready;assert.equal(claims,1);assert.equal(consumed,1);
  const root=render(stepUpView,await f.read(),'es');assert.match(root.textContent,/Confirma tu identidad/);assert.equal(root.querySelector('[name=password]')!==null,method==='password');
  await f.act(new ConfirmOwner({id:prompt.id,method,values:{password:'private password'}}));await pending;const state=await f.read();assert.equal(state.stepUp,null);assert.equal(state.busy,false);assert.equal(claims,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(consumed,1);assert.equal(assertions,method==='passkey'?1:0);assert(!JSON.stringify(state).includes('private password'));
 }finally{cancelStepUp(f.browser);await pending;await f.engine.dispose();}
});

test('wrong credentials and canceled passkey ceremonies retain the owner and prompt; cancel discards the pending action',{timeout:5000},async()=>{
 const f=await fixture();let pending;try{
  let claims=0;f.api.request=async path=>{if(path.endsWith('/begin'))return {password:true,passkey:true,authenticationOptions:{challenge:'one'}};if(path.endsWith('/step-up'))throw Object.assign(Error('Authentication failed.'),{status:401});claims++;throw Object.assign(Error('Confirm first'),{code:'reauthentication_required',status:403});};
  const ready=promptReady(f);pending=f.act(new ClaimHandle({values:{handle:'7alias',confirmed:'on'}}));const prompt=await ready;
  await f.act(new ConfirmOwner({id:prompt.id,method:'password',values:{password:'wrong'}}));assert.equal((await f.read()).session.account.id,account.id);assert.equal((await f.read()).stepUp.id,prompt.id);assert.equal((await f.read()).error,'Authentication failed.');
  f.browser.authenticatePasskey=async()=>{throw Error('Passkey canceled.');};await f.act(new ConfirmOwner({id:prompt.id,method:'passkey'}));assert.equal((await f.read()).error,'Passkey canceled.');assert.equal(claims,1);
  await f.act(new CancelOwnerConfirmation({id:prompt.id}));await pending;assert.equal((await f.read()).stepUp,null);assert.equal((await f.read()).busy,false);assert.equal(claims,1);
 }finally{cancelStepUp(f.browser);await pending;await f.engine.dispose();}
});

for(const change of ['owner','session','offline'])test(`confirmation cannot retry after ${change} changes`,{timeout:5000},async()=>{
 const f=await fixture();let pending;try{
  f.api.request=async path=>{f.calls.push({path});if(path.endsWith('/begin'))return {password:true};throw Object.assign(Error('Confirm first'),{code:'reauthentication_required',status:403});};
  const ready=promptReady(f);pending=f.act(new ClaimHandle({values:{handle:'7alias',confirmed:'on'}}));const prompt=await ready;
  await f.write(change==='owner'?{session:{account:{id:crypto.randomUUID()}},beamGeneration:1}:change==='session'?{session:{account,sessionContext:'replacement'}}:{offline:true});await f.act(new ConfirmOwner({id:prompt.id,method:'password',values:{password:'private'}}));await pending;assert.equal(f.calls.length,2);assert.equal((await f.read()).stepUp,null);
 }finally{cancelStepUp(f.browser);await pending;await f.engine.dispose();}
});

test('legacy console actions use inline confirmation and a repeated freshness rejection does not loop',{timeout:5000},async()=>{
 const f=await fixture();let pending;try{
  let mutations=0,begins=0;f.api.request=async path=>{if(path.endsWith('/begin')){begins++;return {password:true};}if(path.endsWith('/step-up'))return {};mutations++;throw Object.assign(Error('Still needs confirmation'),{code:'reauthentication_required',status:403});};
  const ready=promptReady(f);pending=f.act(new RevokeOtherDevices());const prompt=await ready;await f.act(new ConfirmOwner({id:prompt.id,method:'password',values:{password:'private'}}));await pending;const state=await f.read();assert.equal(mutations,2);assert.equal(begins,1);assert.equal(state.stepUp,null);assert.equal(state.busy,false);assert.equal(state.error,'Still needs confirmation');
 }finally{cancelStepUp(f.browser);await pending;await f.engine.dispose();}
});

test('bearer message dispatches never trigger owner confirmation or automatic retries',async()=>{
 class Dispatch extends OwnerFlow {async perform(r){await r.api.request('/api/messages/'+account.id+'/postbacks',{},'POST',{dispatchToken:'proof'});}}
 const f=await fixture();try{let calls=0;f.api.request=async()=>{calls++;throw Object.assign(Error('Remote confirmation required'),{code:'reauthentication_required',status:403});};await f.act(new Dispatch());assert.equal(calls,1);assert.equal((await f.read()).stepUp,undefined);assert.equal((await f.read()).busy,false);}finally{await f.engine.dispose();}
});
