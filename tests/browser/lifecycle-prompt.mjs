import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/console?lifecycle=review'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
const {dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {lifecyclePrompt}=await import('../../apps/web/src/ui/lifecycle-prompt.mjs');
const {ReactivateAccount,showLifecycle}=await import('../../apps/web/src/bl/lifecycle.mjs');
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});
const render=state=>{const root=document.createElement('main');const tree=lifecyclePrompt({busy:false,offline:false,...state});dodo.reconcile(root,tree?[tree]:[]);return root;};
function resources(responses){let state={busy:false,lifecycle:null};const calls=[];return {calls,get state(){return state;},r:{state:{snapshot:()=>state,transition:recipe=>{const next={...state};recipe(next);state=next;},reserve:()=>{if(state.busy)return false;state={...state,busy:true};return true;}},api:{async get(path){calls.push(['GET',path]);return responses[path]();},async request(path,body){calls.push(['POST',path,body]);return responses[path]();}}},ctx:{engineFeed:new EventTarget()}};}

test('the suspended prompt shows only server-derived deadlines and a single explicit confirmation intent',()=>{
 assert.equal(render({lifecycle:null}).textContent,'');assert.equal(render({lifecycle:{required:false}}).textContent,'');
 assert.doesNotMatch(render({lifecycle:{required:true,phase:'suspended',deadlineDays:12}}).textContent,/deleted in/);
 const root=render({lifecycle:{required:true,phase:'suspended',deadlineDays:12,deletionScheduled:true}});
 assert.match(root.textContent,/deleted in 12 days/);assert.match(root.textContent,/connected external storage is never deleted/);
 const button=root.querySelector('button');assert.equal(button.textContent,'I’m still using it');
 let intent;root.addEventListener('3sln-intent',event=>intent=event.detail);button.click();assert.equal(intent.kind,'reactivate-account');
 assert.doesNotMatch(render({lifecycle:{required:true,phase:'suspended',deadlineDays:'12<script>',deletionScheduled:true}}).textContent,/12</);
 assert.match(render({lifecycle:{required:true,phase:'suspended',reauthenticate:true}}).textContent,/sign in again/i);
});

test('loading status after a suspended response and confirming reactivation clear the prompt; stale sign-in asks to reauthenticate',async()=>{
 const ok=resources({'/api/account/lifecycle':()=>({phase:'suspended',deadlineDays:20,reactivationRequired:true,deletionScheduled:true}),'/api/account/lifecycle/reactivate':()=>({phase:'active'}),'/api/account':()=>({account:{id:'owner'}})});
 await showLifecycle(ok.r,ok.ctx);assert.deepEqual(ok.state.lifecycle,{required:true,phase:'suspended',deadlineDays:20,deletionScheduled:true});
 await new ReactivateAccount().execute(ok.r,ok.ctx);assert.equal(ok.state.lifecycle,null);assert.equal(ok.state.data.account.id,'owner');assert.deepEqual(ok.calls.find(c=>c[0]==='POST'),['POST','/api/account/lifecycle/reactivate',{}]);
 const stale=resources({'/api/account/lifecycle/reactivate':()=>{throw Object.assign(new Error('Sign in again.'),{code:'reauthentication_required'});}});
 stale.r.state.transition(next=>next.lifecycle={required:true,phase:'suspended'});await new ReactivateAccount().execute(stale.r,stale.ctx);
 assert.equal(stale.state.lifecycle.reauthenticate,true);assert.equal(stale.state.error,'Sign in again.');assert.equal(stale.state.busy,false);
});
