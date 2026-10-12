import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/'});
const names=['document','HTMLElement','CustomEvent','Event','EventTarget','ErrorEvent','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));for(const name of names)globalThis[name]=window[name];
const {Engine,Provider,dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {default:StateProvider}=await import('../../apps/web/src/providers/browser-state.mjs');
const {ClaimHandle,DownloadNameCertificate}=await import('../../apps/web/src/bl/identity.mjs');
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
 const engine=new Engine({providers:{state:StateProvider,api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser)}});
 const write=patch=>engine.container.use({state:{write:true}},({state})=>state.transition(next=>Object.assign(next,patch)));
 await write({...base,loading:false});
 return {api,browser,engine,calls,downloads,write,read:()=>engine.container.use(['state'],({state})=>state.snapshot()),act:action=>engine.dispatch(action).next('complete')};
}

test('signup assigns names without asking for a base; login and localized setup display the complete returned handle',()=>{
 const signup=render(authView,base);assert.equal(signup.querySelector('[name=handle]'),null);assert.match(signup.textContent,/unique handle starting with n\./);
 const spanish=render(authView,base,'es');assert.match(spanish.textContent,/nombre de usuario único/);
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
