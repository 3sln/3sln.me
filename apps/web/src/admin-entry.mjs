import { Engine, dodo, watch, queryCell } from './shared/stack.mjs';
import { createLocalization } from './shared/i18n.mjs';
import localizeTree from './ui/localize.mjs';
import AdminAPIProvider from './providers/admin-api.mjs';
import AdminStateProvider from './providers/admin-state.mjs';
import AdminBrowserProvider from './providers/admin-browser.mjs';
import * as access from './bl/admin-access.mjs';
import { accessView } from './ui/admin-access.mjs';
// Composition root for /console?boot and /console?admin only. The ordinary
// console never imports this file. Operation screens (./admin-console.mjs) load
// only once a boot session exists or administrator authority is confirmed.
const root=document.getElementById('app');
const engine=new Engine({providers:{api:AdminAPIProvider,state:AdminStateProvider,browser:AdminBrowserProvider}});
const localizations=Object.fromEntries(['en','es'].map(locale=>[locale,createLocalization({locale})]));
const readState=await engine.container.use(['state'],({state})=>state.snapshot);
const browser=await engine.container.use(['browser'],({browser})=>browser);
const adminAPI=await engine.container.use(['api'],({api})=>api);
let operations=null,loading=null,entering=false;
function constructors(){return {...access.accessConstructors,...operations?.constructors??{}};}
function dispatchIntent(detail){const Action=constructors()[detail.kind];if(!Action)return;engine.dispatch(new Action(detail));}
async function loadConsole(){
 if(operations||loading)return;
 loading=import('./admin-console.mjs').then(module=>{operations=module;engine.feed.dispatchEvent(new Event(access.UPDATED));}).catch(()=>engine.dispatch(new access.ConsoleUnavailable())).finally(()=>{loading=null;});
}
root.addEventListener('3sln-intent',event=>{event.stopPropagation();dispatchIntent(event.detail);});
engine.feed.addEventListener('admin-retry',event=>dispatchIntent(event.detail));
engine.feed.addEventListener('admin-boot-signin',()=>engine.dispatch(new access.BootSigninOptions()));
// Move focus to the new screen's heading whenever the phase changes (expiry, sign-out, end).
let lastPhase=null;engine.feed.addEventListener(access.UPDATED,()=>{const phase=readState().phase;if(lastPhase&&phase!==lastPhase)browser.focus('#admin-heading');lastPhase=phase;});
engine.feed.addEventListener(access.UPDATED,()=>{const state=readState();if(state.phase!=='console'||state.consoleReady){entering=false;return;}if(!operations){loadConsole();return;}if(!entering){entering=true;engine.dispatch(new operations.EnterConsole());}});
// Escape closes the topmost dialog; the dialog itself traps Tab.
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&readState().modal&&!readState().busy){event.preventDefault();dispatchIntent({kind:'close-modal'});}});
const stateCell=queryCell(engine.query(new access.AdminState()));
dodo.reconcile(root,[watch(stateCell,state=>{const localization=localizations[state.locale]??localizations.en;browser.setTitle(localization.t(state.mode==='boot'?'Boot console · Host administration':'Host administration'));const view=state.phase==='console'&&operations?operations.consoleView(state):state.phase==='console'?accessView({...state,phase:'loading'}):accessView(state);return localizeTree(view,localization);})]);
const stopTick=browser.every(1000,()=>engine.dispatch(new access.Tick()));
engine.dispatch(new access.InitializeAdmin());
window.addEventListener('pagehide',()=>{if(readState().mode==='admin'&&readState().phase==='console')adminAPI.endStepUpOnExit();stopTick();dodo.reconcile(root,[]);engine.dispose();},{once:true});
// Back/forward cache restores a torn-down page: reload instead of showing a blank console.
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
