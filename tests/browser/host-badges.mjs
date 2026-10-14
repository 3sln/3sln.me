import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/console'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
const {dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {default:view}=await import('../../apps/web/src/ui/release-security.mjs');
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});
const policy={path:'/api/badges/sprite.svg?v='+'a'.repeat(64),definitions:[{id:'staff',name:'<img src=x onerror=alert(1)>',description:'<a href="https://tracking.example">Local only</a>'}]};
const render=(badges,badgePolicy=policy)=>{const root=document.createElement('main');dodo.reconcile(root,[view({config:{badgePolicy},brand:{host:'space.example'},data:{account:{id:'owner',handle:'n.1',badges}},busy:false,offline:false})]);return root;};
test('known symbol IDs render trusted sprite and literal accessible metadata; identity URLs/markup cannot select artwork',()=>{
 const root=render(['staff']),badge=root.querySelector('.local-account-badge');assert(badge);assert.match(badge.textContent,/<img/);assert.match(badge.textContent,/<a href/);assert.equal(badge.querySelectorAll('a,img,script,button').length,0);assert.equal(badge.querySelector('span').getAttribute('translate'),'no');assert.equal(badge.querySelector('svg').getAttribute('aria-label'),policy.definitions[0].name);assert.equal(badge.querySelector('use').getAttribute('href'),policy.path+'#staff');
 for(const ids of [undefined,['unknown'],['https://tracking.example/icon'],[{id:'staff',svg:'<script/>'}]])assert.equal(render(ids).querySelector('.local-account-badge'),null);
 for(const path of ['https://tracking.example/sprite.svg','//tracking.example/sprite.svg','/api/badges/sprite.svg?private=secret','/api/badges/sprite.svg#foreign'])assert.equal(render(['staff'],{...policy,path}).querySelector('.local-account-badge'),null);
});
