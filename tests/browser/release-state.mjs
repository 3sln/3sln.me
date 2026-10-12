import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,Provider} from '../../apps/web/src/shared/stack.mjs';
import {compilePortalModules} from '../../packages/portal/index.mjs';
import StateProvider from '../../apps/web/src/providers/browser-state.mjs';
import {BrowserState,InitializeSpace,NavigateSpace,PrepareRecovery,EncryptRecovery,VerifyRecovery,DownloadRecovery,ConfirmRecovery,NetworkChanged,CreateCollection,SetLanguage,SetShortcut,PressShortcut,ResetShortcuts} from '../../apps/web/src/bl/release.mjs';
function fixture({authenticated=false}={}){
 const payload={version:1,issuer:'https://account.example',handle:'river',recoveryToken:'00000000-0000-0000-0000-000000000000.'+'a'.repeat(43)};const secrets={pending:'pending-secret'},calls=[],downloads=[],preferences=[];let textFocus=false;
 const api={csrf:null,async get(path){if(path==='/api/config')return {origin:'https://account.example',brand:{name:'Personal Space',host:'account.example'}};if(path==='/api/session')return authenticated?{account:{handle:'river'},csrfToken:'csrf'}:{authenticated:false};if(path==='/api/account')return {account:{handle:'river'},messages:[],collections:[],contacts:[],resources:[],rules:[]};throw new Error(path);},async request(path,body){calls.push({path,body});if(path.endsWith('/recovery/download'))return {fileName:'recovery.json',content:JSON.stringify(payload),recoveryToken:payload.recoveryToken};if(path.endsWith('/recovery/confirm'))return {account:{handle:'river'},csrfToken:'csrf'};if(path==='/api/collections')return {id:'new-collection'};throw new Error(path);}};
 const browser={preferences:()=>({}),language:()=> 'en',applyLocale(){},savePreferences:p=>preferences.push(p),inputFocused:()=>textFocus,onFocus:()=>()=>{},route:()=>({kind:'recovery-setup'}),online:()=>true,restorePending:()=>null,pushPermission:()=> 'unsupported',installCaptcha(){},applyBrand(){},setCaptchaAction(){},installWorker(){},onNetwork:()=>()=>{},now:()=>Date.now(),delay:(cb,ms)=>{const id=setTimeout(cb,ms);return()=>clearTimeout(id);},id:()=> 'question-id',navigate(){},clearRecoveryChallenge(){},captureFocus(){},modalFocus(){},restoreFocus(){},secret:key=>secrets[key],storeSecret:(key,value)=>{secrets[key]=value;},savePending:(token)=>{secrets.pending=token;},clearPending:()=>{secrets.pending=null;secrets.recovery=null;},download:(...args)=>downloads.push(args)};
 const registry=compilePortalModules([{id:'test',contributions:{commands:[{id:'test.navigate',title:'Open inbox',capability:'navigation',deps:{},execute(){}}],keybindings:[{id:'test.navigate.default',command:'test.navigate',key:'g i',when:'authenticated && !textInputFocus'}]}}]);
 const engine=new Engine({providers:{portalContributions:Provider.fromSingleton(registry),state:StateProvider,api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),recoveryFile:Provider.fromSingleton({encrypt:async(p,q,a)=>({format:'3sln-recovery',questions:q,ciphertext:'opaque-ciphertext'}),decrypt:async()=>payload})}});
 const snapshots=[];const query=engine.query(new BrowserState());const subscription=query.subscribe({next:s=>snapshots.push(s)});
 return {engine,api,calls,downloads,snapshots,query,preferences,setFocus:value=>{textFocus=value;},async act(action){await engine.dispatch(action).next('complete');},async close(){subscription.unsubscribe();await engine.dispose();}};
}
test('browser Actions own navigation and required recovery receipt; Query projection excludes file secrets',async()=>{
 const f=fixture();try{await f.act(new InitializeSpace());await f.act(new NavigateSpace({kind:'open-modal',modal:{kind:'collection'}}));assert.equal((await f.query.peek()).modal.kind,'collection');
 await f.act(new PrepareRecovery());let state=await f.query.peek();assert.deepEqual(state.recovery,{fileName:'recovery.json'});assert.equal(state.pending,true);assert.equal(JSON.stringify(state).includes('a'.repeat(43)),false);assert.equal(JSON.stringify(state).includes('pending-secret'),false);
 await f.act(new ConfirmRecovery({values:{confirmed:'on'}}));assert.equal(f.calls.filter(call=>call.path.endsWith('/confirm')).length,0);assert.match((await f.query.peek()).error,/Download/);
 await f.act(new EncryptRecovery({values:{'answer:question-id':'private answer'}}));await f.act(new DownloadRecovery());assert.equal(f.downloads.length,1);assert.equal(f.downloads[0][1].includes('recoveryToken'),false);await f.act(new VerifyRecovery({values:{'verify:question-id':'private answer'}}));await f.act(new ConfirmRecovery({values:{}}));assert.equal(f.calls.filter(call=>call.path.endsWith('/confirm')).length,0);
 await f.act(new ConfirmRecovery({values:{confirmed:'on'}}));state=await f.query.peek();assert.equal(state.session.account.handle,'river');assert.equal(state.recovery,null);
 await f.act(new NetworkChanged({online:false}));state=await f.query.peek();assert.equal(state.data,null);assert.equal(state.session,null);assert.equal(state.offline,true);
 }finally{await f.close();}
});
test('read leases are immutable and do not expose browser-state transitions',async()=>{
 const provider=new StateProvider(),read=await provider.obtain();assert.equal(read.transition,undefined);assert.throws(()=>{read.snapshot().view='resources';},TypeError);const write=await provider.obtain({write:true});write.transition(s=>{s.route={kind:'home',nested:{key:'value'}};});assert.throws(()=>{read.snapshot().route.nested.key='changed';},TypeError);provider.dispose();
});

test('language and shortcut overrides are Action-owned, persist no account data, and respect editing context',async()=>{
 const f=fixture({authenticated:true}),commands=[];f.engine.feed.addEventListener('portal-command-requested',event=>commands.push(event.detail.id));try{
  await f.act(new InitializeSpace());await f.act(new SetLanguage({values:{locale:'es'}}));assert.equal((await f.query.peek()).locale,'es');assert.deepEqual(Object.keys(f.preferences[0]).sort(),['keybindingOverrides','locale']);
  await f.act(new SetShortcut({command:'test.navigate',values:{key:'mod+i',when:'authenticated && !textInputFocus'}}));let state=await f.query.peek();assert.equal(state.shortcuts.length,1);assert.equal(state.shortcuts[0].user,true);assert.equal(state.shortcuts[0].key,'mod+i');
  await f.act(new PressShortcut({stroke:'mod+i'}));assert.deepEqual(commands,['test.navigate']);f.setFocus(true);await f.act(new PressShortcut({stroke:'mod+i'}));assert.deepEqual(commands,['test.navigate']);
  f.setFocus(false);await f.act(new ResetShortcuts());await f.act(new PressShortcut({stroke:'g'}));assert.deepEqual((await f.query.peek()).keyChord.strokes,['g']);await f.act(new PressShortcut({stroke:'i'}));assert.deepEqual(commands,['test.navigate','test.navigate']);assert.deepEqual((await f.query.peek()).keyChord,[]);
 }finally{await f.close();}
});
