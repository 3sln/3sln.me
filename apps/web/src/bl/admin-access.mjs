import { Action, Query } from '../shared/stack.mjs';
import { resolveLocale } from '../shared/i18n.mjs';
import { consoleReset } from '../providers/admin-state.mjs';
import { parseBootToken } from '../providers/admin-browser.mjs';
// Boot setup, boot sign-in and the administrator gate. This module is loaded
// only on /console?boot or /console?admin; console operations are a separate
// module imported after a boot session or administrator authority is confirmed.
export const UPDATED='admin-state-updated';
export const current=r=>r.state.snapshot();
export function update(r,ctx,patch){r.state.transition(next=>Object.assign(next,typeof patch==='function'?patch(next):patch));ctx.engineFeed.dispatchEvent(new Event(UPDATED));}
const STEP_UP_MS=300000,PASSWORD_MIN=15,PASSWORD_MAX=128;
export const failure=(code,extra={})=>Object.assign(new Error(code),{code,...extra});
/** Every privileged datum is dropped together: overview, lookups, audit pages,
 * revealed links and open dialogs. Used on expiry, sign-out and lost authority. */
export function wipe(r,ctx,patch){r.api.forget();r.browser.clearSecrets();update(r,ctx,{...consoleReset(),boot:null,setup:null,signin:null,...patch});}
const SESSION_LOST=['unauthorized','csrf','boot_unclaimed','session_context_conflict','account_context_conflict'];
/** Classifies a failed request. Returns true when the failure ended the session
 * (all console data is already wiped), so callers must not touch stale results. */
export function sessionFailure(r,ctx,error){
  const mode=current(r).mode,code=error?.code,live=current(r).phase==='console';
  if(code==='local_reset')return true;
  if(code==='boot_expired'&&mode==='boot'){wipe(r,ctx,{phase:'boot-expired',error:{code}});return true;}
  // Before a session exists (setup, sign-in) these are ordinary, shown errors.
  if(live&&SESSION_LOST.includes(code)){wipe(r,ctx,{phase:mode==='boot'?(code==='boot_unclaimed'?'boot-setup':'boot-signin'):'admin-signin',error:{code}});return true;}
  if(live&&code==='forbidden'&&mode==='admin'){wipe(r,ctx,{phase:'admin-denied',error:{code}});return true;}
  if(['admin_unavailable','boot_unavailable'].includes(code)||error?.status===503&&!['claims_unavailable','rate_limited'].includes(code)){wipe(r,ctx,{phase:'unavailable',error:{code}});return true;}
  return false;
}
/** Base for every console Action: one operation at a time, failures classified. */
export class AdminAction extends Action {
  static deps={state:{write:true},api:{},browser:{}};
  constructor(detail={}){super();this.detail=detail;}
  async execute(r,ctx){
    if(current(r).busy&&!this.constructor.concurrent)return;
    const generation=r.api.generation;if(!this.constructor.concurrent)update(r,ctx,{busy:true,error:null,notice:'',noticeSubject:null});
    try{await this.perform(r,ctx,this.detail);}
    catch(error){if(r.api.generation!==generation&&error?.code!=='local_reset')return;if(!sessionFailure(r,ctx,error))await this.failed(r,ctx,error);else if(current(r).phase==='boot-signin'&&!current(r).signin)await loginOptions(r,ctx).catch(()=>{});}
    finally{if(!this.constructor.concurrent&&current(r).busy)update(r,ctx,{busy:false});}
  }
  // Subclasses clear the specific result they were requesting so a failure never
  // leaves an earlier answer on screen as though it belonged to this request.
  async failed(r,ctx,error){update(r,ctx,{error:{code:error?.code??'unexpected_response',...error?.issuer?{issuer:error.issuer}:{}}});}
  call(r,path,body){return r.api.call(current(r).mode,path,body);}
}
export class AdminState extends Query {
  static deps=['state'];
  boot({state},{notify,engineFeed}){this.feed=engineFeed;this.publish=()=>notify(state.snapshot());engineFeed.addEventListener(UPDATED,this.publish);this.publish();}
  kill(){this.feed.removeEventListener(UPDATED,this.publish);}
}
function bootSession(r,ctx,result,patch={}){
  if(typeof result?.csrfToken!=='string'||!Number.isSafeInteger(result.bootExpiresAt)||!Number.isSafeInteger(result.sessionExpiresAt))throw failure('unexpected_response');
  r.api.setBootCsrf(result.csrfToken);r.browser.storeSecret('bootToken',null);r.browser.storeSecret('bootRegistration',null);r.browser.storeSecret('bootLogin',null);
  update(r,ctx,{...consoleReset(),phase:'console',setup:null,signin:null,boot:{bootExpiresAt:result.bootExpiresAt,sessionExpiresAt:result.sessionExpiresAt,stepUpUntil:Number.isSafeInteger(result.stepUpUntil)?result.stepUpUntil:r.browser.now()+STEP_UP_MS},...patch});
}
async function bootEntry(r,ctx){
  try{bootSession(r,ctx,await r.api.call('boot','/api/admin/boot/session',{}));return;}catch(error){if(!['unauthorized','boot_expired','boot_unclaimed'].includes(error?.code))throw error;if(error.code==='boot_expired'){update(r,ctx,{phase:'boot-expired'});return;}}
  const status=await r.api.call('boot','/api/admin/boot/status',{});
  if(status.configured!==true){update(r,ctx,{phase:'boot-unconfigured'});return;}
  const token=['unused','reserved','used'].includes(status.token)?status.token:'used';
  if(token==='used'){update(r,ctx,{phase:'boot-signin',tokenState:token});await loginOptions(r,ctx);return;}
  update(r,ctx,{phase:'boot-setup',tokenState:token,setup:null});
}
async function loginOptions(r,ctx){
  try{const result=await r.api.call('boot','/api/admin/boot/login/begin',{});r.browser.storeSecret('bootLogin',result.passkey?{challengeId:result.challengeId,options:result.authenticationOptions}:null);update(r,ctx,{phase:'boot-signin',signin:{password:result.password===true,passkey:result.passkey===true}});}
  catch(error){if(error?.code==='boot_expired'){update(r,ctx,{phase:'boot-expired',signin:null});return;}if(error?.code==='boot_unclaimed'){update(r,ctx,{phase:'boot-setup',signin:null});return;}throw error;}
}
export class InitializeAdmin extends AdminAction {
  async perform(r,ctx){
    const route=r.browser.route(),locale=resolveLocale(route.locale??r.browser.language());r.browser.applyLocale(locale);update(r,ctx,{mode:route.mode,locale,now:r.browser.now(),phase:'loading'});
    if(route.mode==='boot'){await bootEntry(r,ctx);return;}
    const account=await r.api.accountSession();if(!account){update(r,ctx,{phase:'admin-signin'});return;}
    const access=await r.api.call('admin','/api/admin/access',{});
    if(access.admin!==true){wipe(r,ctx,{phase:'admin-denied'});return;}
    update(r,ctx,{...consoleReset(),phase:'console',account:{id:account.id,handle:typeof access.handle==='string'?access.handle:account.handle,passkey:access.passkey===true}});
  }
  async failed(r,ctx,error){update(r,ctx,{phase:error?.status===404||error?.code==='not_found'?'unavailable':current(r).phase==='loading'?'unavailable':current(r).phase,error:{code:error?.code??'unexpected_response'}});}
}
export class BootSigninOptions extends AdminAction {async perform(r,ctx){await loginOptions(r,ctx);}}
/** Step 1 of setup: the token is checked locally for shape, kept only in memory,
 * and sent once in a POST body. It is never placed in the URL or in state. */
export class BootStart extends AdminAction {
  async perform(r,ctx,detail){
    let text=detail.values?.token;if(detail.file)text=await r.browser.readTokenFile(detail.file);
    const token=parseBootToken(text,{origin:r.browser.origin(),now:r.browser.now()});r.browser.storeSecret('bootToken',token);
    await r.api.call('boot','/api/admin/boot/begin',{});
    const result=await r.api.call('boot','/api/admin/boot/start',{bootToken:token});
    if(!['claim','restore'].includes(result.mode)||!Number.isSafeInteger(result.completeBy)||!Number.isSafeInteger(result.accessMs))throw failure('unexpected_response');
    r.browser.storeSecret('bootRegistration',result.registrationOptions??null);
    update(r,ctx,{setup:{mode:result.mode,completeBy:result.completeBy,accessMs:result.accessMs,method:'passkey'}});r.browser.focus('#boot-credential-heading');
  }
  async failed(r,ctx,error){r.browser.storeSecret('bootToken',null);update(r,ctx,{setup:null,error:{code:error?.code??'unexpected_response',...error?.issuer?{issuer:error.issuer}:{}},...error?.code==='boot_token_consumed'?{tokenState:'used'}:{}});}
}
export class BootMethod extends Action {static deps={state:{write:true}};constructor(detail){super();this.detail=detail;}execute(r,ctx){const setup=current(r).setup;if(setup&&['passkey','password'].includes(this.detail.method))update(r,ctx,{setup:{...setup,method:this.detail.method},error:null});}}
export class BootComplete extends AdminAction {
  async perform(r,ctx,detail){
    const setup=current(r).setup,token=r.browser.secret('bootToken'),values=detail.values??{};
    if(!setup||!token)throw failure('setup_lost');
    if(setup.completeBy<=r.browser.now())throw failure('setup_expired');
    if(values.acknowledge!=='on')throw failure('acknowledgement_required');
    const body={bootToken:token,method:setup.method,acknowledgeExpiry:true};
    if(setup.method==='password'){const password=values.password??'';if([...password].length<PASSWORD_MIN||[...password].length>PASSWORD_MAX)throw failure('invalid_password');if(password!==values.confirm)throw failure('password_mismatch');body.password=password;}
    else body.response=await r.browser.createPasskey(r.browser.secret('bootRegistration'));
    const result=await r.api.call('boot','/api/admin/boot/complete',body);
    bootSession(r,ctx,result,{notice:result.mode==='restore'?'restored':'claimed'});
  }
  async failed(r,ctx,error){const code=error?.code??'unexpected_response',terminal=['boot_token_consumed','setup_lost','setup_expired','invalid_boot_token','setup_binding_required'].includes(code);if(terminal){r.browser.storeSecret('bootToken',null);r.browser.storeSecret('bootRegistration',null);}update(r,ctx,{error:{code},...terminal?{setup:null,tokenState:code==='boot_token_consumed'||code==='setup_expired'?'used':current(r).tokenState}:{}});}
}
export class BootSignin extends AdminAction {
  async perform(r,ctx,detail){
    const method=detail.method==='passkey'?'passkey':'password',body={method};
    if(method==='password'){if(typeof detail.values?.password!=='string'||!detail.values.password)throw failure('password_required');body.password=detail.values.password;}
    else{const login=r.browser.secret('bootLogin');if(!login)throw failure('passkey_unavailable');body.challengeId=login.challengeId;body.response=await r.browser.authenticatePasskey(login.options);}
    bootSession(r,ctx,await r.api.call('boot','/api/admin/boot/login',body));
  }
  async failed(r,ctx,error){update(r,ctx,{error:{code:error?.code??'unexpected_response'}});if(r.browser.secret('bootLogin')&&error?.code!=='boot_expired')await loginOptions(r,ctx).catch(()=>{});}
}
export class SignOut extends AdminAction {
  static concurrent=true;
  async perform(r,ctx){
    if(current(r).mode==='boot'){let ok=false;if(r.api.hasBootCsrf())ok=await r.api.call('boot','/api/admin/boot/logout',{}).then(result=>result.loggedOut===true,()=>false);
     // The cookie is cleared either way; a failed server-side revocation is reported, never hidden.
     wipe(r,ctx,ok?{phase:'boot-signin',notice:'signed-out'}:{phase:'boot-signin',error:{code:'logout_unconfirmed'}});await loginOptions(r,ctx).catch(()=>{});return;}
    await r.api.call('admin','/api/admin/step-up/end',{}).catch(()=>{});wipe(r,ctx,{phase:'left',account:null});r.browser.navigate('/console');
  }
}
/** Clock tick: drives the countdown and enforces expiry locally, so boot data
 * disappears at the deadline even if no request is made. */
export class Tick extends Action {
  static deps={state:{write:true},api:{},browser:{}};
  execute(r,ctx){
    const now=r.browser.now(),state=current(r);
    if(state.mode==='boot'&&state.boot&&state.phase==='console'){
      if(state.boot.bootExpiresAt<=now){wipe(r,ctx,{phase:'boot-expired',now});return;}
      if(state.boot.sessionExpiresAt<=now){wipe(r,ctx,{phase:'boot-signin',now,error:{code:'session_expired'}});ctx.engineFeed.dispatchEvent(new Event('admin-boot-signin'));return;}
    }
    // Administrators: once the 15-minute read window of the last step-up passes, drop
    // console data locally and re-enter (which asks for a fresh step-up).
    if(state.mode==='admin'&&state.phase==='console'&&Number.isSafeInteger(state.stepUpAt)&&state.stepUpAt+900000<=now){update(r,ctx,{...consoleReset(),now,stepUpAt:null});return;}
    if(state.setup&&state.setup.completeBy<=now){r.browser.storeSecret('bootToken',null);update(r,ctx,{now,setup:null,tokenState:'used',error:{code:'setup_expired'}});return;}
    update(r,ctx,{now});
  }
}
export class SetAdminLocale extends Action {static deps={state:{write:true},browser:{}};constructor(detail){super();this.detail=detail;}execute(r,ctx){const locale=resolveLocale(this.detail.values?.locale);r.browser.applyLocale(locale);update(r,ctx,{locale});}}
export class ConsoleUnavailable extends Action {static deps={state:{write:true},api:{},browser:{}};execute(r,ctx){wipe(r,ctx,{phase:'unavailable',error:{code:'network'}});}}
export class DismissMessage extends Action {static deps={state:{write:true}};execute(r,ctx){update(r,ctx,{error:null,notice:'',noticeSubject:null});}}
export const accessConstructors={'boot-start':BootStart,'boot-method':BootMethod,'boot-complete':BootComplete,'boot-signin':BootSignin,'boot-signin-options':BootSigninOptions,'sign-out':SignOut,'set-locale':SetAdminLocale,'dismiss':DismissMessage};
