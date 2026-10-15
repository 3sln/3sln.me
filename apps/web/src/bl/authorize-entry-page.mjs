// Wiring for the provider-owned authorization entry page (slice A7): ngin engine, providers, dodo rendering,
// delay-to-arm and the refresh triggers. The browser provider is the only place that touches window, opener,
// navigation and timers, so UI-state tests substitute it.
import {Engine,Provider,dodo as d} from '../shared/stack.mjs';
import {authorizeLocalization} from '../../../../packages/i18n/authorize-catalogue.mjs';
import {consentKit} from '../ui/authorize-entry-consent.mjs';
import {entryView,entryTitle} from '../ui/authorize-entry.mjs';
import {createArming} from './authorize-entry-arming.mjs';
import {createEntryModel,createEntrySecrets,createEntryAPI,EntryAction,EntryView,TERMINAL} from './authorize-entry.mjs';
/** Sandboxed documents cannot set document.domain even to itself (adaptive-app-sign-in §10.2; COOP spike). */
export function sandboxed(win){if(win.origin==='null')return true;try{const doc=win.document;doc.domain=doc.domain;return false;}catch{return true;}}
export function createEntryBrowser(win=globalThis.window){
 return Object.freeze({win,origin:win.location.origin,get location(){return {pathname:win.location.pathname,search:win.location.search};},
  framed:()=>{try{return win.top!==win.self;}catch{return true;}},sandboxed:()=>sandboxed(win),now:()=>Date.now(),
  replace:url=>win.location.replace(url),assign:url=>win.location.assign(url),
  // Only a window this page's opener created can close itself; the result is checked by the caller's UI.
  close:()=>{try{win.close();}catch{}}});
}
export function startEntryPage({root,preferredLocale='en',win=globalThis.window,fetch,browser=createEntryBrowser(win)}){
 const doc=win.document,{t,locale}=authorizeLocalization(preferredLocale);doc.documentElement.lang=locale;
 const model=createEntryModel(),secrets=createEntrySecrets(),api=createEntryAPI(fetch?{fetch}:{}),host=win.location.host;
 let engine=null,surface=null,disposed=false;const dispatch=(kind,detail)=>engine.dispatch(new EntryAction(kind,detail));
 const kit=consentKit({model,t,rerender:()=>render(),onConfigure:detail=>dispatch('configure',detail),root});
 // An early (unarmed) trusted activation is explained rather than silently dropped.
 const arming=createArming({win,doc,onChange:()=>render(),onReject:()=>dispatch('early')});
 const canClose=()=>Boolean(win.opener);
 engine=new Engine({providers:{model:Provider.fromSingleton(model),secrets:Provider.fromSingleton(secrets),api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),i18n:Provider.fromSingleton({t}),consent:Provider.fromSingleton(kit)}});
 function render(){
  if(disposed)return;
  d.reconcile(root,[entryView(model,{t,host,armed:arming.armed,guard:arming.guard,dispatch,kit,canClose:canClose(),close:browser.close})]);
  // A new decision surface restarts the arming delay and moves focus to its heading (never to an approval control).
  // Focus moves only after the user has acted; the first surface keeps the document's natural reading order.
  const key=`${model.phase}|${model.surface}|${(model.accounts??[]).map(a=>a.id+'/'+a.sessionContext).join()}|${model.busy}`;if(key!==surface){surface=key;doc.title=`${entryTitle(model,t,host)} · ${host}`;arming.reset();if(interacted)root.querySelector('#entry-title')?.focus?.({preventScroll:false});}
 }
 let interacted=false;const acted=()=>{interacted=true;};doc.addEventListener('pointerdown',acted,{capture:true,once:true});doc.addEventListener('keydown',acted,{capture:true,once:true});
 const subscription=engine.query(new EntryView()).subscribe({next:render});
 dispatch('boot');
 // Signing in happens in another tab: re-read the browser's accounts when this window regains attention.
 const refresh=()=>{if(doc.visibilityState!=='hidden')dispatch('accounts');};
 win.addEventListener('focus',refresh);doc.addEventListener('visibilitychange',refresh);
 let channel=null;try{if(typeof win.BroadcastChannel==='function'){channel=new win.BroadcastChannel('bindle-accounts');channel.onmessage=event=>{if(event.data?.type==='accounts-changed'&&Object.keys(event.data).length===1)refresh();};}}catch{}
 const expiry=win.setInterval(()=>{if(model.entry&&!TERMINAL.includes(model.phase)&&Date.now()>=model.entry.expiresAt)dispatch('expire');},5000);
 const dispose=()=>{disposed=true;win.clearInterval(expiry);arming.dispose();channel?.close();win.removeEventListener('focus',refresh);doc.removeEventListener('visibilitychange',refresh);subscription.unsubscribe();engine.dispose();};
 win.addEventListener('pagehide',dispose,{once:true});
 // A back-forward-cache restore would show controls wired to a disposed engine: start over from the server.
 win.addEventListener('pageshow',event=>{if(event.persisted)win.location.reload();});
 return {engine,model,secrets,dispatch,render,dispose,arming};
}
