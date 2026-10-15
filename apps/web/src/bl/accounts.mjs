import {Action} from '../shared/stack.mjs';
import {accountReset,clearBrowserAccount,installAPIContext} from './account-context.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const state=r=>r.state.snapshot();
const publish=(r,ctx,value)=>{r.state.transition(next=>Object.assign(next,value));ctx.engineFeed.dispatchEvent(new Event('browser-state-updated'));};
const generation=r=>state(r).beamGeneration??0;
const invalid=()=>Error('The account list could not be loaded.');
// Inventory is a first-party projection: handles and non-secret selectors only.
// The picker proof stays in browser memory, never in rendered state.
export async function accountInventory(r,ctx,ticket=generation(r)){
 const inventoryTicket=crypto.randomUUID();publish(r,ctx,{accountsTicket:inventoryTicket,accountsLoading:true});
 // However this request ends (superseded by a transition, offline, or failed after one), the loading
 // indicator it raised is lowered unless a newer inventory request owns it.
 try{await loadInventory(r,ctx,ticket,inventoryTicket);}finally{if(state(r).accountsTicket===inventoryTicket&&state(r).accountsLoading)publish(r,ctx,{accountsLoading:false});}
}
async function loadInventory(r,ctx,ticket,inventoryTicket){
 const result=await r.api.get('/api/auth/accounts',{context:null});if(ticket!==generation(r)||state(r).offline||state(r).accountsTicket!==inventoryTicket)return;
 if(!Array.isArray(result.accounts)||result.accounts.length>20||typeof result.revision!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.revision))throw invalid();
 const seen=new Set(),accounts=result.accounts.map(entry=>{const a=entry?.account;if(!a||!uuid.test(a.id)||seen.has(a.id)||typeof a.handle!=='string'||!a.handle||a.handle.length>128||typeof entry.sessionContext!=='string'||entry.sessionContext.length>128||!Number.isSafeInteger(entry.expiresAt))throw invalid();seen.add(a.id);return {account:{id:a.id,handle:a.handle},sessionContext:entry.sessionContext,expiresAt:entry.expiresAt};});
 r.browser.storeSecret('accountPickerToken',typeof result.pickerToken==='string'&&result.pickerToken.length<=8192?result.pickerToken:null);r.browser.storeSecret('accountPickerIssuedAt',Date.now());
 publish(r,ctx,{browserAccounts:{accounts,activeOwner:uuid.test(result.activeOwner??'')?result.activeOwner:null,limit:Number.isSafeInteger(result.limit)&&result.limit>0&&result.limit<=8?result.limit:5,revision:result.revision,cleanupPending:result.cleanupPending===true},accountsLoading:false});
}
async function cancelPreviousDevice(r,code){if(!code)return '';try{const result=await r.api.request('/api/auth/device/cancel',{deviceCode:code},'POST',{context:null,signal:AbortSignal.timeout(5000)});if(result.cancelled===true)return '';}catch{}return 'Device sign-in cancellation is not confirmed. Check your signed-in devices.';}
// The short-lived proof is refreshed before use; a changed snapshot still requires review.
async function pickerProof(r,ctx,ticket,inventory){if(Date.now()-(r.browser.secret('accountPickerIssuedAt')??0)<90000)return r.browser.secret('accountPickerToken');await accountInventory(r,ctx,ticket);if(ticket!==generation(r))return null;if(state(r).browserAccounts?.revision!==inventory.revision)throw Object.assign(Error('The account list changed. Review it and try again.'),{code:'vault_conflict'});return r.browser.secret('accountPickerToken');}
const captured=(r,initial)=>r.api.captureContext?.()??{owner:initial.session?.account?.id,sessionContext:initial.session?.sessionContext,csrfToken:r.api.csrf};
class AccountAction extends Action {
 static deps={state:{write:true},api:{},browser:{}};
 constructor(detail={}){super();this.detail=detail;}
 async execute(r,ctx){if(state(r).offline)return;this.ticket=generation(r);try{const values=this.detail.operationId?r.browser.consumeSubmission(this.detail.operationId):this.detail.values;await this.perform(r,ctx,{...this.detail,values});}catch(error){if(this.ticket!==generation(r))return;
  // A changed member snapshot is never retried silently: show the fresh list for review.
  if(error.code==='vault_conflict'){publish(r,ctx,{busy:false,accountPicker:true,error:'The account list changed. Review it and try again.'});await accountInventory(r,ctx,this.ticket).catch(()=>{});return;}
  publish(r,ctx,{busy:false,accountsLoading:false,error:error.message??'The account request could not be completed.'});}}
}
export class OpenAccounts extends AccountAction {async perform(r,ctx){this.ticket=generation(r);publish(r,ctx,{accountPicker:true,error:''});await accountInventory(r,ctx,this.ticket);r.browser.focusAccounts?.();}}
export class CloseAccounts extends AccountAction {async perform(r,ctx){publish(r,ctx,{accountPicker:false,error:''});if(state(r).handoff?.choosing&&state(r).session?.account)ctx.engineFeed.dispatchEvent(new Event('contact-handoff-ready'));}}
export class AddAccount extends AccountAction {async perform(r,ctx){const inventory=state(r).browserAccounts;if(inventory&&inventory.accounts.length>=(inventory.limit??5))throw Error('Sign out of an account before adding another.');const code=r.browser.secret('deviceCode')??r.browser.secret('deviceCanceledCode');clearBrowserAccount(r);publish(r,ctx,{...accountReset(state(r)),addingAccount:true,accountPicker:false,auth:'login',busy:true});this.ticket=generation(r);const warning=await cancelPreviousDevice(r,code);if(this.ticket!==generation(r))return;publish(r,ctx,{busy:false,notice:warning});r.browser.setCaptchaAction('login');r.browser.installCaptcha(state(r).config);}}
// Explicit, confirmed switch. Old private state is torn down before the network
// call; the request carries the original tab authority plus the picker proof.
export class SwitchAccount extends AccountAction {async perform(r,ctx,{owner}){
 const initial=state(r),inventory=initial.browserAccounts;if(initial.busy||!uuid.test(owner)||!inventory?.accounts.some(row=>row.account.id===owner))return;
 const pickerToken=await pickerProof(r,ctx,this.ticket,inventory);if(this.ticket!==generation(r))return;const code=r.browser.secret('deviceCode')??r.browser.secret('deviceCanceledCode'),context=captured(r,initial);
 clearBrowserAccount(r);publish(r,ctx,{...accountReset(initial),accountPicker:true,busy:true});this.ticket=generation(r);const warning=await cancelPreviousDevice(r,code);if(this.ticket!==generation(r))return;
 const result=await r.api.request('/api/auth/accounts/switch',{owner,expectedRevision:inventory.revision,...pickerToken?{pickerToken}:{}},'POST',{context});if(this.ticket!==generation(r))return;
 if(result.account?.id!==owner||!result.csrfToken||typeof result.sessionContext!=='string')throw Error('The selected account could not be verified.');installAPIContext(r.api,result);r.browser.announceAccounts?.();
 publish(r,ctx,{session:{account:result.account,sessionContext:result.sessionContext},accountPicker:false,addingAccount:false,busy:false,notice:warning,auth:'login',view:'inbox'});
 // A pending contact handoff continues with the newly chosen account.
 if(state(r).handoff?.choosing)ctx.engineFeed.dispatchEvent(new Event('contact-handoff-ready'));
 const data=await r.api.get('/api/account');if(this.ticket!==generation(r)||state(r).session?.account?.id!==owner)return;publish(r,ctx,{data});
 }}
// Signing out another saved account leaves this tab's account and view intact.
export class LogoutAccounts extends AccountAction {async perform(r,ctx,{all=false,owner,values}){
 const initial=state(r);if(initial.busy)return;if(all&&values?.confirmed!=='on')throw Error('Confirm signing out of all accounts in this browser.');const inventory=initial.browserAccounts;if(!inventory)throw Error('Open the account list and try again.');owner=owner??initial.session?.account?.id;if(!all&&!inventory.accounts.some(row=>row.account.id===owner))return;
 const pickerToken=await pickerProof(r,ctx,this.ticket,inventory);if(this.ticket!==generation(r))return;const current=all||owner===initial.session?.account?.id,context=captured(r,initial);let warning='';
 if(current){const code=r.browser.secret('deviceCode')??r.browser.secret('deviceCanceledCode');clearBrowserAccount(r);publish(r,ctx,{...accountReset(initial),accountPicker:true,busy:true});this.ticket=generation(r);warning=await cancelPreviousDevice(r,code);if(this.ticket!==generation(r))return;}else publish(r,ctx,{busy:true,error:'',notice:''});
 // This device's push subscription is removed from each signed-out account (never blocks sign-out).
 const push=await r.browser.pushSubscriptionId?.(),result=await r.api.request('/api/auth/accounts/'+(all?'logout-all':'logout'),{...!all?{owner}:{},expectedRevision:inventory.revision,...pickerToken?{pickerToken}:{},...push?{pushSubscription:push}:{}},'POST',{context});if(all)await r.browser.unsubscribePush?.();if(this.ticket!==generation(r))return;r.browser.announceAccounts?.();
 publish(r,ctx,{busy:false,...current?{auth:'login'}:{},browserAccounts:null,notice:warning||(result.cleanupPending?'Sign-out is not fully confirmed. Refresh the account list to retry.':'Signed out.'),accountPicker:true});await accountInventory(r,ctx,this.ticket);if(current){r.browser.setCaptchaAction('login');r.browser.installCaptcha(state(r).config);}
 }}
// Retry only the exact unresolved revocations held in retry-only custody.
export class RetryAccountCleanup extends AccountAction {async perform(r,ctx){
 const initial=state(r),inventory=initial.browserAccounts;if(initial.busy||!inventory?.cleanupPending)return;const pickerToken=await pickerProof(r,ctx,this.ticket,inventory);if(this.ticket!==generation(r))return;if(!pickerToken)throw Error('Open the account list and try again.');publish(r,ctx,{busy:true,error:'',notice:''});
 const result=await r.api.request('/api/auth/accounts/cleanup',{expectedRevision:inventory.revision,pickerToken},'POST',{context:null});if(this.ticket!==generation(r))return;
 publish(r,ctx,{busy:false,notice:result.cleanupPending?'Sign-out is not fully confirmed. Refresh the account list to retry.':'Signed out.'});await accountInventory(r,ctx,this.ticket);
 }}
