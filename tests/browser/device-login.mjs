import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/device#request=locator'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
const {dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {default:view}=await import('../../apps/web/src/ui/release-public.mjs');
const {default:localize}=await import('../../apps/web/src/ui/localize.mjs');
const {createLocalization}=await import('../../packages/i18n/index.mjs');
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});
test('device review never displays or pre-fills a URL or request code, signed in or out, in English and Spanish',()=>{
 for(const locale of ['en','es'])for(const signedIn of [false,true]){
  const root=document.createElement('main'),state={route:{kind:'device',requestId:'locator',userCode:'URLSECRET'},deviceRequest:{userCode:'STOREDSECRET',label:'TV',status:'pending',expiresAt:Date.now()+300000},session:signedIn?{account:{handle:'alice'}}:null,brand:{name:'Space',host:'space.example'},config:{},locale};dodo.reconcile(root,[localize(view(state),createLocalization({locale}))]);assert.doesNotMatch(root.textContent,/URLSECRET|STOREDSECRET/);assert.equal(root.querySelector('.device-code'),null);assert.equal(root.querySelector('input[name=code]')?.value??'','');assert.equal(root.querySelectorAll('input[name=code]').length,signedIn?1:0);
  if(signedIn){const form=root.querySelector('form'),code=form.querySelector('input[name=code]');assert.equal(code.autocomplete,'off');assert.equal(code.required,true);assert.equal(code.maxLength,16);code.value='typed-code';form.querySelector('input[name=approved]').checked=true;let detail;root.addEventListener('3sln-intent',event=>detail=event.detail);form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));assert.equal(detail.kind,'approve-device');assert.equal(new window.FormData(detail.form).get('code'),'typed-code');}
 }
});
