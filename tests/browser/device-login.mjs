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
test('retired device review links to approval with only a locator, signed in or out, in English and Spanish',()=>{
 for(const locale of ['en','es'])for(const signedIn of [false,true]){
  const root=document.createElement('main'),requestId='550e8400-e29b-41d4-a716-446655440011',state={route:{kind:'device',requestId,userCode:'URLSECRET'},deviceRequest:{userCode:'STOREDSECRET',label:'TV',status:'pending',expiresAt:Date.now()+300000},session:signedIn?{account:{handle:'alice'}}:null,brand:{name:'Space',host:'space.example'},config:{},locale};dodo.reconcile(root,[localize(view(state),createLocalization({locale}))]);assert.doesNotMatch(root.textContent,/URLSECRET|STOREDSECRET/);assert.equal(root.querySelector('.device-code'),null);assert.equal(root.querySelector('form'),null);assert.equal(root.querySelector('input[name=code]'),null);assert.equal(root.querySelector('a[href^="/approve"]').getAttribute('href'),'/approve#r='+requestId);
 }
});
