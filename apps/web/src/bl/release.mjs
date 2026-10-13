import {defaultKeybindings as defaultBindings} from '../shared/portal-bindings.mjs';
import {compileKeybindings,inspectKeybindings,resolveKeybinding,portalContext} from '../../../../packages/portal/keybindings.mjs';
import {resolveLocale,createLocalization} from '../shared/i18n.mjs';
import { Action,Query } from '../shared/stack.mjs';
const changed=(feed)=>feed.dispatchEvent(new Event('browser-state-updated'));
function commit(state,feed,recipe){state.transition(recipe);changed(feed);}
const update=(resources,ctx,patch)=>commit(resources.state,ctx.engineFeed,next=>Object.assign(next,patch));
const current=r=>r.state.snapshot();
async function refresh(r,ctx){const owner=current(r).session?.account?.id,generation=current(r).beamGeneration??0;const data=await r.api.get('/api/account');if(!current(r).offline&&current(r).session?.account?.id===owner&&(current(r).beamGeneration??0)===generation){update(r,ctx,{data});return true;}return false;}
function clearAccount(r,ctx){r.api.csrf=null;update(r,ctx,{busy:false,conversations:{},mcpRequest:null,mcpGrants:null,automation:null,beaming:{},beamGeneration:(current(r).beamGeneration??0)+1,session:null,data:null,messageDetail:null,messageRender:null,selected:null,modal:null,billing:null,billingLoading:false,billingError:'',billingCurrency:null,billingTicket:null,billingChangeDraft:null,billingChangeAttempt:null,semanticPreferences:null,searchDraft:{},spaceSearch:{phase:'idle',items:[]}});}
const notice=(r,ctx,text)=>update(r,ctx,{notice:text,error:''});
async function completed(r,ctx,text){update(r,ctx,{modal:null});await refresh(r,ctx);notice(r,ctx,text);r.browser.restoreFocus();}
function pending(r,ctx,token,stage){r.browser.savePending(token,stage);update(r,ctx,{pending:true,pendingStage:stage});}
async function recovery(r,ctx){
 pending(r,ctx,r.browser.secret('pending'),'recovery');
 if(current(r).route.kind!=='recovery-setup'){r.browser.navigate('/recovery/setup');return;}
 const result=await r.api.request('/api/auth/recovery/download',{pendingToken:r.browser.secret('pending')});
 r.browser.storeSecret('recovery',result);r.browser.storeSecret('encryptedRecovery',null);
 const handle=result.account?.handle??result.handle??current(r).pendingHandle;
 update(r,ctx,{pendingHandle:typeof handle==='string'&&/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(handle)?handle:null,recovery:{fileName:result.fileName},recoveryStage:'questions',recoveryQuestions:[{id:r.browser.id(),type:'passphrase',prompt:createLocalization({locale:current(r).locale}).t('What is my private recovery passphrase?'),hint:''}],downloaded:false,recoveryVerified:false});
}
async function accept(r,ctx,result){if(!result.account||!result.csrfToken)throw new Error('Sign-in did not create a verified account session.');r.browser.clearPending();r.api.csrf=result.csrfToken;update(r,ctx,{pending:false,recovery:null,beaming:{},beamGeneration:(current(r).beamGeneration??0)+1,session:{account:result.account},auth:'login',notice:'',deviceLogin:null});await refresh(r,ctx);if(!['recovery-setup','email'].includes(current(r).route.kind))r.browser.continueAuthorization?.();}
const tags=value=>String(value??'').split(',').map(value=>value.trim()).filter(Boolean);
async function addRule(r,rule){return r.api.request('/api/rules',{rules:[...(current(r).data?.rules??[]),{...rule,id:r.browser.id()}]},'PUT');}
async function loadBilling(r,ctx){
 const owner=current(r).session?.account?.id??current(r).session?.account?.handle;
 if(!owner||current(r).offline)return;
 const attempt=current(r).billingChangeAttempt??r.browser.billingChange?.(owner),currency=current(r).billingCurrency,ticket=r.browser.id(),query=new URLSearchParams();if(currency)query.set('currency',currency);if(attempt?.txId)query.set('txId',attempt.txId);update(r,ctx,{billingLoading:true,billingError:'',billingTicket:ticket});
 try{const billing=await r.api.get('/api/billing'+(query.size?'?'+query.toString():''));if(!current(r).offline&&current(r).billingTicket===ticket&&(current(r).session?.account?.id??current(r).session?.account?.handle)===owner)update(r,ctx,{billing,billingLoading:false,billingChangeAttempt:reconcileBillingChange(r,owner,billing),...attempt&&billing.changeAttempt?.txId===attempt.txId&&billing.changeAttempt?.outcome==='not-found'?{notice:'This request was not registered. Review the current plan before trying again.'}:{}});}
 catch(error){if(current(r).billingTicket!==ticket||(current(r).session?.account?.id??current(r).session?.account?.handle)!==owner)return;if(error.status===401){clearAccount(r,ctx);return;}if(!current(r).offline)update(r,ctx,{billing:null,billingLoading:false,billingError:'Plan information could not be loaded. Please try again.'});}
}
function reconcileBillingChange(r,owner,billing){
 const restored=current(r).billingChangeAttempt??r.browser.billingChange?.(owner),remote=billing.changeAttempt;
 if(restored&&remote?.txId===restored.txId&&['confirmed','pending','rejected','canceled','not-found'].includes(remote.outcome)){try{r.browser.saveBillingChange?.(owner,null);}catch{}return null;}
 if(restored)return {...restored,phase:'unknown'};
 if(remote?.outcome==='unknown')return {...remote,phase:'unknown'};
 return null;
}
function trustedBillingURL(value,server){
 let url;try{url=new URL(value);}catch{throw new Error('The payment page could not be opened. Please try again.');}
 const hosts=server==='sandbox'?['sandbox.polar.sh','sandbox-api.polar.sh']:['polar.sh','api.polar.sh'];
 if(url.protocol!=='https:'||url.username||url.password||url.port||!hosts.includes(url.hostname))throw new Error('The payment page could not be opened. Please try again.');
 return url.href;
}

/** One projection and one feed vocabulary own account, navigation and async UI.
 * The Query also owns polling/network listener lifetimes; it never mutates state. */
export class BrowserState extends Query {
  static deps=['state','browser','portalContributions'];
  boot({state,browser,portalContributions},{notify,engineFeed}){
    this.cancelPoll=null;this.cancelChord=null;this.feed=engineFeed;
    this.publish=()=>{
      const raw=state.snapshot(),registry=portalContributions,context=portalContext(raw,{textInputFocus:browser.inputFocused()});const commands=registry.list('commands').map(({id,title,module,capability})=>({id,title,module,disabled:capability!=='public'&&(!context.authenticated||context.offline)}));const bindings=compileKeybindings(defaultBindings(registry),raw.keybindingOverrides??[],commands);const snapshot={...raw,navigation:registry.list('navigation').map(({id,title,view,icon,order,module})=>({id,title,view,icon,order,module})),commands,shortcuts:inspectKeybindings(bindings,context).map(row=>({...row,title:commands.find(command=>command.id===row.command)?.title??row.command}))};if(raw.route.kind==='mcp-consent'&&raw.session?.account&&!raw.offline&&!raw.busy&&!raw.mcpRequest)queueMicrotask(()=>engineFeed.dispatchEvent(new Event('mcp-request-opened')));notify(snapshot.offline?{...snapshot,conversations:{},mcpRequest:null,mcpGrants:null,automation:null,beaming:{},data:null,messageDetail:null,messageRender:null,session:null}:snapshot);this.cancelPoll?.();this.cancelPoll=null;this.cancelChord?.();this.cancelChord=null;
      if(raw.keyChord?.strokes?.length)this.cancelChord=browser.delay(()=>engineFeed.dispatchEvent(new CustomEvent('shortcut-chord-expired',{detail:{startedAt:raw.keyChord.startedAt}})),Math.max(0,raw.keyChord.startedAt+1500-browser.now()));const device=snapshot.deviceLogin;
      if(device?.status==='authorization_pending'&&!snapshot.busy&&!snapshot.offline)this.cancelPoll=browser.delay(()=>engineFeed.dispatchEvent(new Event('device-poll-due')),Math.max(0,device.nextPollAt-browser.now()));
    };
    engineFeed.addEventListener('browser-state-updated',this.publish);
    this.network=browser.onNetwork(online=>engineFeed.dispatchEvent(new CustomEvent('network-changed',{detail:online})));
    this.publish();
  }
  kill(){this.feed.removeEventListener('browser-state-updated',this.publish);this.cancelPoll?.();this.cancelChord?.();this.network?.();}
}
export class RecheckSession extends Action {
  static deps={state:{write:true},api:{},browser:{}};
  async execute(r,ctx){const generation=current(r).beamGeneration??0;try{const result=await r.api.get('/api/session');if(current(r).offline||(current(r).beamGeneration??0)!==generation)return;update(r,ctx,{...(current(r).session?.account?.id!==result.account?.id?{billing:null,billingLoading:false,billingError:'',billingCurrency:null,billingTicket:null,billingChangeDraft:null,billingChangeAttempt:null,busy:false,conversations:{},mcpRequest:null,mcpGrants:null,automation:null,beaming:{},beamGeneration:(current(r).beamGeneration??0)+1}:{}),session:result.account?{account:result.account}:null});if(result.account)await refresh(r,ctx);else notice(r,ctx,'Sign in in the other tab, then check again.');}catch(error){if(!current(r).offline&&(current(r).beamGeneration??0)===generation)update(r,ctx,{error:error.message});}}
}
class Flow extends Action {
  static deps={state:{write:true},api:{},browser:{},portalContributions:{},recoveryFile:{}};
  #detail;
  constructor(detail={}){super();this.#detail=detail;}
  async execute(r,ctx){const detail=this.#detail;let values;try{values=detail.operationId?r.browser.consumeSubmission(detail.operationId):detail.values;}catch(error){update(r,ctx,{error:error.message});return;}if(!r.state.reserve())return;changed(ctx.engineFeed);try{await this.perform(r,ctx,{...detail,values});}catch(error){if(error.status===401)clearAccount(r,ctx);update(r,ctx,{error:error.message});}finally{update(r,ctx,{busy:false});}}
}
export class InitializeSpace extends Flow {
  async perform(r,ctx,detail){const route=r.browser.route(),restored=r.browser.restorePending(),preferences=r.browser.preferences(),locale=resolveLocale(preferences.locale??r.browser.language());let overrides=preferences.keybindingOverrides??[];try{compileKeybindings(defaultBindings(r.portalContributions),overrides,r.portalContributions.list('commands'));}catch{overrides=[];}r.browser.applyLocale(locale);update(r,ctx,{route,locale,keybindingOverrides:overrides,offline:!r.browser.online(),pending:!!restored,pendingStage:restored?.stage,brand:{name:'3sln.me',host:'3sln.me'},pushPermission:r.browser.pushPermission()});
    try{const config=await r.api.get('/api/config');const host=config.handleOriginHost??new URL(config.origin??'https://3sln.me').host;update(r,ctx,{config,brand:config.brand??{name:'3sln.me',host,description:'Your personal space'}});r.browser.applyBrand(config.brand??{name:'3sln.me'});r.browser.setCaptchaAction(route.kind==='device'||route.kind==='mcp-consent'||route.auth==='login'?'login':'signup');}catch{/* Session read below reports actual service availability. */}
    if(route.kind==='contact'&&r.browser.secret('contactEndpoint'))update(r,ctx,{route:{...route,claims:await r.api.contactClaims(r.browser.secret('contactEndpoint'))}});
    if(route.kind==='device'||route.kind==='mcp-consent'||route.auth==='login')update(r,ctx,{auth:'login'});
    try{const result=await r.api.get('/api/session');update(r,ctx,{...(current(r).session?.account?.id!==result.account?.id?{busy:false,conversations:{},mcpRequest:null,mcpGrants:null,automation:null,beaming:{},beamGeneration:(current(r).beamGeneration??0)+1}:{}),session:result.account?{account:result.account}:null});if(result.account){await refresh(r,ctx);if(route.kind==='home')r.browser.continueAuthorization?.();}else r.browser.installCaptcha(current(r).config);if(route.kind==='recovery-setup'&&restored?.stage==='recovery')await recovery(r,ctx);if(route.kind==='device'&&route.requestId&&route.userCode)update(r,ctx,{deviceRequest:await r.api.request('/api/auth/device/inspect',{requestId:route.requestId,userCode:route.userCode})});}finally{update(r,ctx,{loading:false});r.browser.installWorker();}
  }
}
export class NavigateSpace extends Action {
  static deps={state:{write:true},browser:{},api:{}};
  constructor(detail){super();this.detail=detail;}
  async execute(r,ctx){const d=this.detail;const patches={
    navigate:()=>({view:d.view,selected:null,notice:'',error:'',modal:null,...d.filter?{filter:d.filter}:{}}),
    'set-auth':()=>({auth:d.auth,recovery:null,notice:'',error:'',emailSent:false,captchaPurpose:null}),
    'set-auth-method':()=>({authMethod:d.method,error:''}),
    'set-filter':()=>({filter:d.filter,selected:null}),search:()=>({search:d.search}),
    'search-shortcuts':()=>({bindingSearch:d.search}),'search-commands':()=>({commandSearch:d.search}),
    'edit-space-search':()=>({searchDraft:{...current(r).searchDraft,[d.field]:d.value}}),
    'close-message':()=>({selected:null,messageRender:null}),
    'open-modal':()=>({modal:d.modal,error:''}),'close-modal':()=>({modal:null,commandSearch:'',keyChord:[]})
  };if(d.kind==='set-auth')r.browser.setCaptchaAction(d.auth==='recover'?'recovery':d.auth==='email'?'email':d.auth==='login'?'login':'signup');if(d.kind==='open-modal')r.browser.captureFocus();update(r,ctx,patches[d.kind]?.()??{});if(d.kind==='open-modal')r.browser.modalFocus();if(d.kind==='close-modal')r.browser.restoreFocus();if(d.kind==='navigate'&&d.view==='billing')await loadBilling(r,ctx);if(d.kind==='navigate'&&d.view==='space-search'&&current(r).config.semanticSearchEnabled===true)await loadSemanticPreferences(r,ctx);}
}
export class NetworkChanged extends Action {
  static deps={state:{write:true},api:{},browser:{}};
  constructor(detail){super();this.detail=detail;}
  async execute(r,ctx){try{await this.perform(r,ctx,this.detail);}catch(error){if((current(r).beamGeneration??0)!==this.generation||current(r).offline)return;if(error.status===401)clearAccount(r,ctx);update(r,ctx,{error:error.message});}}
  async perform(r,ctx,detail){update(r,ctx,{busy:false,conversations:{},mcpRequest:null,mcpGrants:null,automation:null,beaming:{},beamGeneration:(current(r).beamGeneration??0)+1,modal:null,offline:!detail.online,data:null,messageDetail:null,messageRender:null,selected:null,billing:null,billingLoading:false,billingError:'',billingTicket:null,billingChangeDraft:null,billingChangeAttempt:null,semanticPreferences:null,searchDraft:{},spaceSearch:{phase:'idle',items:[]}});this.generation=current(r).beamGeneration??0;if(detail.online){const result=await r.api.get('/api/session');if(current(r).offline||(current(r).beamGeneration??0)!==this.generation)return;update(r,ctx,{...(current(r).session?.account?.id!==result.account?.id?{billingCurrency:null,billingTicket:null,billingChangeDraft:null,billingChangeAttempt:null,busy:false,conversations:{},mcpRequest:null,mcpGrants:null,automation:null,beaming:{},beamGeneration:(current(r).beamGeneration??0)+1}:{}),session:result.account?{account:result.account}:null});this.generation=current(r).beamGeneration??0;if(result.account){if(!await refresh(r,ctx))return;if(current(r).view==='billing')await loadBilling(r,ctx);}}}
}
export class SignUp extends Flow {
  async perform(r,ctx,detail){const s=current(r),v=detail.values;const result=await r.api.request('/api/auth/signup',{password:v.password,method:s.authMethod,termsAccepted:v.termsAccepted==='on',termsVersion:s.config.termsVersion??'2026-10-11',...r.browser.captcha(s.config)});
    pending(r,ctx,result.pendingToken,s.authMethod==='passkey'?'credential':'recovery');
    update(r,ctx,{pendingHandle:result.account?.handle??null});
    if(s.authMethod==='passkey')await r.api.request('/api/auth/passkey/register',{pendingToken:result.pendingToken,response:await r.browser.createPasskey(result.registrationOptions)});
    await recovery(r,ctx);
  }
}
export class SignIn extends Flow {
  async perform(r,ctx,detail){const s=current(r),v=detail.values,payload={handle:v.handle,password:v.password,...r.browser.captcha(s.config)};
    if(s.authMethod==='password')await accept(r,ctx,await r.api.request('/api/auth/login/password',payload));
    else {const begin=await r.api.request('/api/auth/login/passkey/begin',payload);await accept(r,ctx,await r.api.request('/api/auth/login/passkey/finish',{challengeToken:begin.challengeToken,response:await r.browser.authenticatePasskey(begin.authenticationOptions)}));}
  }
}
export class SignOut extends Flow {async perform(r,ctx,detail){await r.api.request('/api/auth/logout',{});clearAccount(r,ctx);update(r,ctx,{auth:'login'});r.browser.setCaptchaAction('login');r.browser.installCaptcha(current(r).config);}}
export class StartRecovery extends Flow {
 async perform(r,ctx){const s=current(r),token=r.browser.captcha(s.config).turnstileToken;if(!token)throw new Error('Complete the recovery security check before continuing.');r.browser.storeRecoveryChallenge(token);r.browser.navigate('/recovery/restore');}
}
export class InspectRecovery extends Flow {
 async perform(r,ctx,detail){const result=await r.recoveryFile.inspect(detail.values.file);r.browser.storeSecret('restoreFile',result.text);update(r,ctx,{unlockQuestions:result.header.questions,recoveryStage:'unlock',notice:'',error:''});}
}
export class RecoverAccount extends Flow {
 async perform(r,ctx,detail){const s=current(r),turnstileToken=r.browser.recoveryChallenge(s.config),file=r.browser.secret('restoreFile');if(!file)throw new Error('Choose your encrypted recovery file first.');const answers=s.unlockQuestions.map(question=>detail.values['unlock:'+question.id]);let payload;try{payload=await r.recoveryFile.decrypt(file,answers,s.config.origin);}finally{answers.fill('');}
 const result=await r.api.request('/api/auth/recover',{recoveryToken:payload.recoveryToken,...payload.version===2?{identityBackup:payload}:{},turnstileToken});r.browser.storeSecret('restoreFile',null);r.browser.clearRecoveryChallenge();pending(r,ctx,result.pendingToken,result.credentialRequired?'credential':'recovery');r.browser.navigate('/recovery/setup');
 }
}
export class SetPendingPasskey extends Flow {async perform(r,ctx,detail){const pendingToken=r.browser.secret('pending'),begin=await r.api.request('/api/auth/passkey/register/begin',{pendingToken});await r.api.request('/api/auth/passkey/register',{pendingToken,response:await r.browser.createPasskey(begin.registrationOptions)});await recovery(r,ctx);}}
export class SetPendingPassword extends Flow {async perform(r,ctx,detail){await r.api.request('/api/auth/password/pending',{pendingToken:r.browser.secret('pending'),password:detail.values.password});await recovery(r,ctx);}}
export class PrepareRecovery extends Flow {async perform(r,ctx,detail){if(!r.browser.secret('pending'))throw new Error('Start account setup or recovery before preparing this file.');await recovery(r,ctx);}}
export class EditRecoveryQuestion extends Action {
 static deps={state:{write:true},browser:{}};
 constructor(detail){super();this.detail=detail;}
 execute(r,ctx){const d=this.detail,s=current(r);if(s.recoveryStage!=='questions'||s.busy)return;let questions=s.recoveryQuestions??[];
 if(d.kind==='add-recovery-question'&&questions.length<12)questions=[...questions,{id:r.browser.id(),type:'text',prompt:'',hint:''}];
 if(d.kind==='remove-recovery-question'&&questions.length>1)questions=questions.filter(question=>question.id!==d.id);
 if(d.kind==='move-recovery-question'){const from=questions.findIndex(question=>question.id===d.id),to=from+d.direction;if(from>=0&&to>=0&&to<questions.length){questions=[...questions];[questions[from],questions[to]]=[questions[to],questions[from]];}}
 if(d.kind==='edit-recovery-question'&&['type','prompt','hint'].includes(d.field))questions=questions.map(question=>question.id===d.id?{...question,[d.field]:String(d.value).slice(0,1024)}:question);
 update(r,ctx,{recoveryQuestions:questions});
 }
}
export class EncryptRecovery extends Flow {
 async perform(r,ctx,detail){const s=current(r),file=r.browser.secret('recovery');if(!file?.content||s.recoveryStage!=='questions')throw new Error('Prepare a recovery file first.');const answers=s.recoveryQuestions.map(question=>detail.values['answer:'+question.id]);let encrypted;try{encrypted=await r.recoveryFile.encrypt(JSON.parse(file.content),s.recoveryQuestions,answers,s.config.origin);}finally{answers.fill('');}r.browser.storeSecret('encryptedRecovery',JSON.stringify(encrypted,null,2));update(r,ctx,{recoveryStage:'download',unlockQuestions:encrypted.questions,downloaded:false,recoveryVerified:false,error:''});
 }
}
export class DownloadRecovery extends Flow {
 async perform(r,ctx){const encrypted=r.browser.secret('encryptedRecovery');if(!encrypted)throw new Error('Encrypt your recovery file before downloading.');r.browser.download(r.browser.secret('recovery')?.fileName??'account-recovery.json',encrypted);update(r,ctx,{downloaded:true,recoveryStage:'verify'});}
}
export class VerifyRecovery extends Flow {
 async perform(r,ctx,detail){const s=current(r);if(!s.downloaded)throw new Error('Download your encrypted recovery file before testing it.');const answers=s.unlockQuestions.map(question=>detail.values['verify:'+question.id]);let payload;try{payload=await r.recoveryFile.decrypt(r.browser.secret('encryptedRecovery'),answers,s.config.origin);}finally{answers.fill('');}if(payload.recoveryToken!==r.browser.secret('recovery')?.recoveryToken)throw new Error('This recovery file does not match the pending account.');update(r,ctx,{recoveryVerified:true,recoveryStage:'confirm',error:''});}
}
export class ConfirmRecovery extends Flow {
 async perform(r,ctx,detail){if(!current(r).downloaded||!current(r).recoveryVerified||detail.values.confirmed!=='on')throw new Error('Download your encrypted recovery file, test its answers, and confirm it is saved before continuing.');const result=await r.api.request('/api/auth/recovery/confirm',{pendingToken:r.browser.secret('pending'),recoveryToken:r.browser.secret('recovery')?.recoveryToken,downloadConfirmed:true});await accept(r,ctx,result);r.browser.storeSecret('encryptedRecovery',null);r.browser.storeSecret('restoreFile',null);r.browser.clearRecoveryChallenge();if(!r.browser.continueAuthorization?.())r.browser.navigate('/');}
}
export class RequestEmailSignIn extends Flow {async perform(r,ctx,detail){await r.api.request('/api/auth/email/login/start',{email:detail.values.email,...r.browser.captcha(current(r).config)});update(r,ctx,{emailSent:true});}}
export class ConfirmEmail extends Flow {async perform(r,ctx,detail){const s=current(r),token=r.browser.secret('token');if(!token)throw new Error('This email link is incomplete.');const result=await r.api.request(s.route.emailLogin?'/api/auth/email/login/confirm':'/api/auth/email/confirm',{token,confirmed:true});update(r,ctx,{emailConfirmed:true});if(s.route.emailLogin){await accept(r,ctx,result);if(!r.browser.continueAuthorization?.())r.browser.navigate('/');}}}
export class UnsubscribeChannel extends Flow {async perform(r,ctx,detail){const token=r.browser.secret('token');if(!token)throw new Error('This unsubscribe link is incomplete.');await r.api.request('/api/notifications/unsubscribe',{token,owner:r.browser.secret('owner')});update(r,ctx,{unsubscribed:true});}}
export class SendContactMessage extends Flow {async perform(r,ctx,detail){const endpoint=r.browser.secret('contactEndpoint'),v=detail.values;if(!endpoint)throw new Error('This invitation is incomplete.');if(!(v.file?.size||v.text?.trim()))throw new Error('Write a message or attach a file before sending.');if(v.file?.size>(current(r).route.claims?.maxMessageBytes??1048576))throw new Error('This file exceeds the contact invitation’s message limit.');const payload=await r.browser.fingerprintMessage(v),s=current(r);const idempotencyKey=s.sendPayload===payload?s.sendId:r.browser.id();update(r,ctx,{sendPayload:payload,sendId:idempotencyKey});await r.api.sendContact(endpoint,v,idempotencyKey);update(r,ctx,{sent:true});}}
export class LoadAccount extends Flow {async perform(r,ctx,detail){await refresh(r,ctx);}}
class BillingFlow extends Action {
 static deps=Flow.deps;#detail;constructor(detail={}){super();this.#detail=detail;}
 async execute(r,ctx){const owner=current(r).session?.account?.id??current(r).session?.account?.handle;if(!owner||current(r).offline||!r.state.reserve())return;const generation=current(r).beamGeneration??0;const live=()=>!!owner&&!current(r).offline&&(current(r).session?.account?.id??current(r).session?.account?.handle)===owner&&(current(r).beamGeneration??0)===generation;changed(ctx.engineFeed);try{const values=this.#detail.operationId?r.browser.consumeSubmission(this.#detail.operationId):this.#detail.values;await this.perform(r,ctx,{...this.#detail,values},live);}catch(error){if(live()){if(error.status===401)clearAccount(r,ctx);else update(r,ctx,{error:error.message});}}finally{if(live())update(r,ctx,{busy:false});}}
}
export class LoadBilling extends BillingFlow {async perform(r,ctx){if(await refresh(r,ctx))await loadBilling(r,ctx);}}
export class ChangeBillingCurrency extends BillingFlow {async perform(r,ctx,detail){const currency=detail.currency;if(currency!==null&&(typeof currency!=='string'||!current(r).billing?.currencies?.includes(currency)))throw new Error('Choose an available currency to continue.');update(r,ctx,{billingCurrency:currency});await loadBilling(r,ctx);}}
export class BillingCheckout extends BillingFlow {
 async perform(r,ctx,detail,live){const s=current(r);if(s.offline||s.billing?.enabled!==true||s.billing?.configured!==true)throw new Error('Paid plans are not available on this service yet.');if(!['paid','plus','ultra'].includes(detail.plan))throw new Error('Choose a paid plan to continue.');const currency=s.billing.selectedCurrency,price=s.billing.plans?.find(plan=>plan.id===detail.plan)?.price;if(typeof currency!=='string'||!/^[a-z]{3}$/.test(currency)||s.billingLoading||s.billing.pricingUnavailable===true||![0,2].includes(price?.exponent)||!Number.isSafeInteger(price?.amount)||price.amount<0||price?.available!==true||price?.source!=='polar'||price.currency!==currency||!s.billing.currencies?.includes(currency))throw new Error('Current prices are unavailable. Refresh prices to continue.');const result=await r.api.request('/api/billing/checkout',{plan:detail.plan,currency,locale:s.locale??'en'});if(live())r.browser.navigate(trustedBillingURL(result.url,s.billing.server));}
}
export class BillingPortal extends BillingFlow {
 async perform(r,ctx,detail,live){const s=current(r);if(s.offline||s.billing?.enabled!==true||s.billing?.configured!==true)throw new Error('Paid plans are not available on this service yet.');const result=await r.api.request('/api/billing/portal',{});if(live())r.browser.navigate(trustedBillingURL(result.url,s.billing.server));}
}
const billingRank=Object.freeze(Object.assign(Object.create(null),{paid:1,plus:2,ultra:3}));
export class ReviewPlanChange extends BillingFlow {
 async perform(r,ctx,detail,live){let s=current(r);if(s.billing?.enabled!==true||s.billing?.configured!==true)throw new Error('Paid plans are not available on this service yet.');if(s.billingChangeAttempt||s.billing?.mutationBlocked||s.billing?.changeAttempt?.outcome==='unknown')throw new Error('Recheck the previous plan change before starting another.');const currency=s.billing?.subscription?.currency;if(typeof currency!=='string'||!/^[a-z]{3}$/.test(currency))throw new Error('Your subscription currency could not be verified. Refresh billing to continue.');if(s.billing.selectedCurrency!==currency){update(r,ctx,{billingCurrency:currency});await loadBilling(r,ctx);if(!live())return;s=current(r);}const target=s.billing?.plans?.find(plan=>plan.id===detail.plan),currentPlan=s.billing?.plan;if(!billingRank[currentPlan]||!billingRank[detail.plan]||detail.plan===currentPlan||s.billing?.pricingUnavailable||target?.price?.available!==true||target.price.source!=='polar'||target.price.currency!==currency||typeof target.priceDigest!=='string')throw new Error('Current prices are unavailable. Refresh prices to continue.');update(r,ctx,{billingChangeDraft:{plan:detail.plan,name:target.name,storageBytes:target.storageBytes,dailyActivityUnits:target.dailyActivityUnits,hourlyActivityUnits:target.hourlyActivityUnits,price:target.price,priceDigest:target.priceDigest,upgrade:billingRank[detail.plan]>billingRank[currentPlan],txId:r.browser.id()},error:''});}
}
export class CancelPlanChangeReview extends Action {static deps={state:{write:true}};execute(r,ctx){if(!current(r).busy)update(r,ctx,{billingChangeDraft:null});}}
export class ConfirmPlanChange extends BillingFlow {
 async perform(r,ctx,detail,live){const s=current(r),draft=s.billingChangeDraft,owner=s.session?.account?.id??s.session?.account?.handle;if(!draft||s.billingChangeAttempt||s.billing?.enabled!==true||s.billing?.configured!==true||s.billingLoading||detail.values?.authorize!=='on')throw new Error('Review and authorize the plan change before continuing.');const target=s.billing?.plans?.find(plan=>plan.id===draft.plan);if(target?.priceDigest!==draft.priceDigest||target.price?.currency!==draft.price.currency||target.price?.available!==true)throw new Error('The plan changed after your review. Refresh prices and review it again.');try{r.browser.saveBillingChange(owner,draft);}catch{throw new Error('The plan change could not be prepared safely. Please try again.');}update(r,ctx,{billingChangeDraft:null,billingChangeAttempt:{...draft,phase:'sending'}});let result;try{result=await r.api.request('/api/billing/change-plan',{plan:draft.plan,txId:draft.txId,priceDigest:draft.priceDigest});}catch(error){if(!live())return;if(error.status&&error.status<500){try{r.browser.saveBillingChange(owner,null);}catch{}update(r,ctx,{billingChangeAttempt:null,error:error.message});await loadBilling(r,ctx);return;}update(r,ctx,{billingChangeAttempt:{...draft,phase:'unknown'},error:''});return;}if(!live())return;if(!['confirmed','pending'].includes(result?.outcome)){update(r,ctx,{billingChangeAttempt:{...draft,phase:'unknown'},error:''});return;}try{r.browser.saveBillingChange(owner,null);}catch{}update(r,ctx,{billingChangeAttempt:null,...result.billing?{billing:result.billing}: {},notice:result.outcome==='pending'?'Your plan change is pending confirmation.':'Your plan change was confirmed.',error:''});await refresh(r,ctx);if(live())await loadBilling(r,ctx);}
}
export class ReviewScheduledCancel extends BillingFlow {
 async perform(r,ctx){const s=current(r),scheduled=s.billing?.changeAttempt;if(s.billingChangeAttempt||s.billing?.mutationBlocked||s.billing?.pendingChange?.kind!=='renewal-downgrade'||!scheduled?.txId)throw new Error('Refresh billing to review the scheduled change.');update(r,ctx,{billingChangeDraft:{kind:'cancel',plan:s.billing.plan,priceDigest:'',scheduledTxId:scheduled.txId,txId:r.browser.id()},error:''});}
}
export class ConfirmScheduledCancel extends BillingFlow {
 async perform(r,ctx,detail,live){const s=current(r),draft=s.billingChangeDraft,owner=s.session?.account?.id??s.session?.account?.handle;if(draft?.kind!=='cancel'||detail.values?.authorize!=='on'||s.billingChangeAttempt||s.billing?.changeAttempt?.txId!==draft.scheduledTxId||s.billing?.pendingChange?.kind!=='renewal-downgrade')throw new Error('Refresh billing to review the scheduled change.');try{r.browser.saveBillingChange(owner,draft);}catch{throw new Error('The plan change could not be prepared safely. Please try again.');}update(r,ctx,{billingChangeDraft:null,billingChangeAttempt:{...draft,phase:'sending'}});let result;try{result=await r.api.request('/api/billing/cancel-change',{txId:draft.txId,scheduledTxId:draft.scheduledTxId});}catch(error){if(!live())return;if(error.status&&error.status<500){try{r.browser.saveBillingChange(owner,null);}catch{}update(r,ctx,{billingChangeAttempt:null,error:error.message});await loadBilling(r,ctx);return;}update(r,ctx,{billingChangeAttempt:{...draft,phase:'unknown'},error:''});return;}if(!live())return;if(result?.outcome!=='confirmed'){update(r,ctx,{billingChangeAttempt:{...draft,phase:'unknown'},error:''});return;}try{r.browser.saveBillingChange(owner,null);}catch{}update(r,ctx,{billingChangeAttempt:null,...result.billing?{billing:result.billing}:{},notice:'The scheduled downgrade was canceled.',error:''});await refresh(r,ctx);if(live())await loadBilling(r,ctx);}
}
// Each request owns a model ticket. Superseded requests and replies after a
// network/session transition cannot reintroduce private search results.
async function loadSemanticPreferences(r,ctx){const owner=current(r).session?.account?.id;if(!owner||current(r).offline)return;try{const preferences=await r.api.get('/api/search/preferences');if(!current(r).offline&&current(r).session?.account?.id===owner)update(r,ctx,{semanticPreferences:preferences});}catch(error){if(error.status===401)clearAccount(r,ctx);else update(r,ctx,{error:'Search preferences could not be loaded. Please try again.'});}}
export class SaveSemanticPreferences extends Flow {async perform(r,ctx,detail){const owner=current(r).session?.account?.id;if(!owner||current(r).offline)return;const enabled=detail.values?.enabled==='on';if(enabled&&detail.values?.consent!=='on')throw new Error('Review and agree to remote semantic processing before enabling it.');const preferences=await r.api.request('/api/search/preferences',{enabled},'PUT');if(!current(r).offline&&current(r).session?.account?.id===owner)update(r,ctx,{semanticPreferences:preferences,error:'',spaceSearch:{phase:'idle',items:[]},searchDraft:{...current(r).searchDraft,mode:'lexical'},notice:enabled?'Semantic indexing is starting. Text search remains available.':'Semantic search is off. Remote vector cleanup is pending.'});}}
export class SearchSpace extends Action {
 static deps={state:{write:true},api:{},browser:{}};
 constructor(detail={}){super();this.detail=detail;}
 async execute(r,ctx){
  const initial=current(r);if(initial.offline||!initial.session)return;
  const previous=initial.spaceSearch??{items:[]},append=this.detail.kind==='search-next-page';
  if(append&&(!previous.cursor||previous.phase==='loading'))return;
  let values;try{values=this.detail.operationId?r.browser.consumeSubmission(this.detail.operationId):this.detail.values??initial.searchDraft??{};}catch{update(r,ctx,{spaceSearch:{...previous,phase:'error',error:'This search expired. Please try again.'}});return;}
  const criteria=append?previous.criteria:{q:String(values.q??'').trim(),tag:String(values.tag??'').trim(),type:String(values.type??'').trim(),mode:['lexical','semantic','hybrid'].includes(values.mode)?values.mode:'lexical'};
  const ticket=r.browser.id(),query=new URLSearchParams({q:criteria.q,mode:criteria.mode,limit:'20'});
  if(criteria.tag)query.append('tag',criteria.tag);if(criteria.type)query.append('type',criteria.type);if(append)query.set('cursor',previous.cursor);
  update(r,ctx,{searchDraft:criteria,spaceSearch:{phase:'loading',ticket,criteria,items:append?previous.items:[],cursor:null,error:''}});
  try{
   const result=await r.api.get(`/api/search?${query}`);
   if(current(r).offline||!current(r).session||current(r).spaceSearch?.ticket!==ticket)return;
   const incoming=Array.isArray(result.items)?result.items:[],combined=append?[...previous.items,...incoming]:incoming,items=[...new Map(combined.map(item=>[item.id,item])).values()];
   update(r,ctx,{spaceSearch:{phase:'ready',ticket,criteria,items,cursor:result.cursor??null,indexing:result.indexing,bounded:result.bounded,semanticAvailable:result.semanticAvailable===true,semanticError:result.semanticError,semantic:result.semantic,error:''}});
  }catch(error){if(current(r).spaceSearch?.ticket!==ticket||current(r).offline)return;if(error.status===401){clearAccount(r,ctx);return;}update(r,ctx,{spaceSearch:{...current(r).spaceSearch,phase:'error',cursor:append?previous.cursor:null,error:'Search could not be completed. Please try again.'}});}
 }
}
export class ReadMessage extends Flow {async perform(r,ctx,detail){const id=detail.id;update(r,ctx,{selected:id,messageDetail:null,messageRender:null});const item=current(r).data.messages.find(item=>item.id===id);if(!item?.readAt)await r.api.request(`/api/messages/${encodeURIComponent(id)}`,{read:true},'PATCH');const response=await r.api.get(`/api/messages/${encodeURIComponent(id)}`);update(r,ctx,{messageDetail:response.message??response,messageRender:response.render});await refresh(r,ctx);}}
export class ReadSearchMessage extends ReadMessage {async perform(r,ctx,detail){update(r,ctx,{view:'inbox',filter:'all',search:'',modal:null});await super.perform(r,ctx,detail);}}
export class UpdateMessage extends Flow {async perform(r,ctx,detail){await r.api.request(`/api/messages/${detail.id}`,detail.actions,'PATCH');await refresh(r,ctx);}}
export class OrganizeMessage extends Flow {async perform(r,ctx,detail){const v=detail.values;await r.api.request(`/api/messages/${current(r).modal.message.id}`,{collection:v.collection,tags:tags(v.tags),classification:v.classification},'PATCH');await completed(r,ctx,'Message updated.');}}
export class CreateCollection extends Flow {async perform(r,ctx,detail){await r.api.request('/api/collections',{name:detail.values.name});await completed(r,ctx,'Collection created.');}}
export class CreateContact extends Flow {async perform(r,ctx,detail){const v=detail.values;const result=await r.api.request('/api/contacts',{name:v.name,collections:[v.collection],mimeTypes:[v.mimeType,...v.conversationInvites==='on'?['application/vnd.3sln.conversation-invite+json']:[]],expiresAt:r.browser.now()+Number(v.days)*86400000,maxMessages:Number(v.maxMessages),maxMessageBytes:Number(v.maxMessageBytes),maxBytes:Number(v.maxMessages)*Number(v.maxMessageBytes)});await refresh(r,ctx);update(r,ctx,{modal:{kind:'share',contact:result.contact??result}});notice(r,ctx,'Contact link created.');}}
export class ShareContact extends Flow {async perform(r,ctx,detail){r.browser.captureFocus();const contact=current(r).data.contacts.find(c=>c.id===detail.id),share=await r.api.get(`/api/contacts/${detail.id}/url`);update(r,ctx,{modal:{kind:'share',contact:{...contact,...share}}});r.browser.modalFocus();}}
export class CopyContactLink extends Flow {async perform(r,ctx,detail){await r.browser.copy(current(r).modal.contact.url);notice(r,ctx,'Link copied.');}}
export class SaveContactLink extends Flow {async perform(r,ctx,detail){r.browser.download('contact-link.txt',current(r).modal.contact.url,'text/plain');}}
export class RevokeContact extends Flow {async perform(r,ctx,detail){await r.api.request(`/api/contacts/${current(r).modal.contact.id}`,{},'DELETE');await completed(r,ctx,'Contact link revoked.');}}
export class QuarantineContact extends Flow {async perform(r,ctx,detail){const c=current(r).modal.contact;await addRule(r,{name:`Quarantine ${c.name??'contact'}`,enabled:true,match:{grantId:c.id},actions:{quarantined:true}});await completed(r,ctx,'Future messages from this contact will be quarantined.');}}
export class CreateRule extends Flow {async perform(r,ctx,detail){const v=detail.values;await addRule(r,{name:v.name,enabled:true,match:{...(v.grantId?{grantId:v.grantId}:{}),...(v.mimeType?{mimeType:v.mimeType}:{})},actions:{...(v.collection?{collection:v.collection}:{}),tags:tags(v.tags),classification:v.classification,quarantined:v.quarantined==='on'}});await completed(r,ctx,'Rule created.');}}
export class ToggleRule extends Flow {async perform(r,ctx,detail){await r.api.request('/api/rules',{rules:(current(r).data.rules??[]).map(rule=>rule.id===detail.id?{...rule,enabled:!rule.enabled}:rule)},'PUT');await refresh(r,ctx);}}
export class DeleteRule extends Flow {async perform(r,ctx,detail){await r.api.request(`/api/rules/${current(r).modal.rule.id}`,{},'DELETE');await completed(r,ctx,'Rule deleted.');}}
export class SaveResource extends Flow {async perform(r,ctx,detail){const result=await r.api.request('/api/resources',{provider:current(r).modal.provider.id,...detail.values});if(result.authorizationUrl){const url=new URL(result.authorizationUrl);if(url.protocol!=='https:')throw new Error('Provider authorization URL is unsafe.');r.browser.navigate(url.href);return;}await completed(r,ctx,result.message??'Resource configuration saved. Review the connection status.');}}
export class VerifyResource extends Flow {async perform(r,ctx,detail){const result=await r.api.request(`/api/resources/${detail.id}/verify`,{key:detail.values.key});await completed(r,ctx,result.message??'Connection verification completed.');}}
export class DisconnectResource extends Flow {async perform(r,ctx,detail){await r.api.request(`/api/resources/${current(r).modal.resource.id}`,{},'DELETE');await completed(r,ctx,'Resource disconnected.');}}
export class SaveNotifications extends Flow {async perform(r,ctx,detail){const v=detail.values,p=current(r).data.notificationPreferences;if(v.push==='on'&&!p.push.enabled)await r.api.request('/api/notifications/subscribe',{subscription:await r.browser.subscribePush(current(r).config.vapidPublicKey)});await r.api.request('/api/notifications',{...p,enabled:v.enabled==='on',push:{enabled:v.push==='on'},email:{enabled:v.email==='on',delayMinutes:Number(v.delayMinutes),repeatHours:Number(v.repeatHours),maxReminders:Number(v.maxReminders)},collections:Object.keys(v).filter(key=>key.startsWith('collection:')).map(key=>key.slice(11)),excludeTags:tags(v.excludeTags)},'PUT');await refresh(r,ctx);notice(r,ctx,'Notification preferences saved.');}}
export class DisableNotifications extends Flow {async perform(r,ctx,detail){const p=current(r).data.notificationPreferences;await r.api.request('/api/notifications',{...p,enabled:false,push:{enabled:false},email:{...p.email,enabled:false}},'PUT');await refresh(r,ctx);notice(r,ctx,'All notification channels are off.');}}
export class RemovePushDevice extends Flow {async perform(r,ctx,detail){await r.api.request(`/api/notifications/devices/${detail.id}`,{},'DELETE');await refresh(r,ctx);notice(r,ctx,'Push device removed.');}}
export class LinkEmail extends Flow {async perform(r,ctx,detail){await r.api.request('/api/auth/email/start',{email:detail.values.email});update(r,ctx,{modal:null});notice(r,ctx,'Verification message requested. Check your inbox.');}}
export class RevokeGrant extends Flow {async perform(r,ctx,detail){await r.api.request(`/api/grants/${detail.id}`,{},'DELETE');await refresh(r,ctx);notice(r,ctx,'App access revoked.');}}
export class AddPasskey extends Flow {async perform(r,ctx,detail){const begin=await r.api.request('/api/auth/passkeys/begin',{label:detail.values.label});await r.api.request('/api/auth/passkeys/finish',{challengeId:begin.challengeId,response:await r.browser.createPasskey(begin.registrationOptions)});await completed(r,ctx,'Passkey added to your account.');}}
export class RemovePasskey extends Flow {async perform(r,ctx,detail){const result=await r.api.request('/api/auth/passkeys/remove',{credentialId:detail.credentialId});if(result.currentSessionRevoked){clearAccount(r,ctx);notice(r,ctx,'Passkey removed. Sign in with a remaining key.');}else await completed(r,ctx,'Passkey and its device sessions revoked.');}}
export class RevokeDevice extends Flow {async perform(r,ctx,detail){const result=await r.api.request('/api/auth/devices/revoke',{sessionId:detail.sessionId});if(result.currentSessionRevoked)clearAccount(r,ctx);else await completed(r,ctx,'Device session revoked.');}}
export class RevokeOtherDevices extends Flow {async perform(r,ctx,detail){await r.api.request('/api/auth/devices/revoke-others',{});await completed(r,ctx,'Other devices signed out.');}}
export class StartDeviceLogin extends Flow {async perform(r,ctx,detail){const s=current(r);if(!s.config.localDevelopment&&s.captchaPurpose!=='device'){r.browser.setCaptchaAction('device');update(r,ctx,{captchaPurpose:'device',notice:'Complete the security check to create a device sign-in request.'});return;}const result=await r.api.request('/api/auth/device/start',{label:'TV or shared screen',...r.browser.captcha(s.config)});r.browser.storeSecret('deviceCode',result.deviceCode);const device={requestId:result.requestId,userCode:result.userCode,verificationUriComplete:result.verificationUriComplete,expiresAt:result.expiresAt,interval:Math.max(5,result.interval??5),nextPollAt:r.browser.now()+Math.max(5,result.interval??5)*1000,status:'authorization_pending'};update(r,ctx,{deviceLogin:device});const qr=await r.api.request('/api/auth/device/qr',{verificationUriComplete:result.verificationUriComplete});update(r,ctx,{deviceLogin:{...device,qr:qr.svg}});}}
export class PollDeviceLogin extends Flow {async perform(r,ctx,detail){const device=current(r).deviceLogin;if(!device||device.status!=='authorization_pending')return;if(r.browser.now()>=device.expiresAt){update(r,ctx,{deviceLogin:{...device,status:'expired_token'}});r.browser.storeSecret('deviceCode',null);return;}const result=await r.api.request('/api/auth/device/poll',{deviceCode:r.browser.secret('deviceCode')});if(result.status==='authorized'){r.browser.storeSecret('deviceCode',null);await accept(r,ctx,result);return;}const interval=Math.max(5,result.interval??device.interval);update(r,ctx,{deviceLogin:{...device,status:result.status==='slow_down'?'authorization_pending':result.status,interval,nextPollAt:r.browser.now()+interval*1000}});}}
export class CancelDeviceLogin extends Flow {async perform(r,ctx,detail){const deviceCode=r.browser.secret('deviceCode');update(r,ctx,{deviceLogin:null,captchaPurpose:null});r.browser.setCaptchaAction(current(r).auth==='signup'?'signup':'login');r.browser.storeSecret('deviceCode',null);if(deviceCode)await r.api.request('/api/auth/device/cancel',{deviceCode});}}
export class InspectDeviceLogin extends Flow {async perform(r,ctx,detail){const route=current(r).route;if(!route.requestId||!route.userCode)throw new Error('This device invitation is incomplete.');const result=await r.api.request('/api/auth/device/inspect',{requestId:route.requestId,userCode:route.userCode});update(r,ctx,{deviceRequest:result});}}
export class ApproveDeviceLogin extends Flow {async perform(r,ctx,detail){const s=current(r),v=detail.values;if(!s.session?.account)throw new Error('Sign in on this phone before approving.');if(v.code!==s.route.userCode||v.approved!=='on')throw new Error('Compare the code on the requesting screen and confirm it matches.');await r.api.request('/api/auth/device/approve',{requestId:s.route.requestId,userCode:s.route.userCode,accountHandle:s.session.account.handle,approved:true});update(r,ctx,{deviceApproved:true});}}
export class DenyDeviceLogin extends Flow {async perform(r,ctx,detail){const route=current(r).route;await r.api.request('/api/auth/device/deny',{requestId:route.requestId,userCode:route.userCode});update(r,ctx,{deviceDenied:true});}}

/** Context is derived from the same immutable model and current browser focus;
 * no component or event handler stores a second copy of these flags. */
export class PortalContext extends Query {
 static deps=['state','browser'];
 boot({state,browser},{notify,engineFeed}){this.feed=engineFeed;this.publish=()=>notify(portalContext(state.snapshot(),{textInputFocus:browser.inputFocused()}));this.focus=browser.onFocus(()=>engineFeed.dispatchEvent(new Event('browser-state-updated')));engineFeed.addEventListener('browser-state-updated',this.publish);this.publish();}
 kill(){this.feed.removeEventListener('browser-state-updated',this.publish);this.focus?.();}
}
export class SetLanguage extends Action {
 static deps={state:{write:true},browser:{}};
 constructor(detail){super();this.detail=detail;}
 execute(r,ctx){const values=this.detail.operationId?r.browser.consumeSubmission(this.detail.operationId):this.detail.values;const locale=resolveLocale(values.locale),snapshot=current(r);try{r.browser.savePreferences({locale,keybindingOverrides:snapshot.keybindingOverrides});update(r,ctx,{locale,notice:'Language preference saved.',error:''});}catch(error){update(r,ctx,{error:error.message});}}
}
export class SetShortcut extends Action {
 static deps={state:{write:true},browser:{},portalContributions:{}};
 constructor(detail){super();this.detail=detail;}
 execute(r,ctx){const s=current(r),id=this.detail.command,v=this.detail.operationId?r.browser.consumeSubmission(this.detail.operationId):this.detail.values;try{const remaining=(s.keybindingOverrides??[]).filter(binding=>binding.command!==id&&binding.command!==`-${id}`),overrides=[...remaining,{command:`-${id}`},{command:id,key:v.key,when:v.when}];compileKeybindings(defaultBindings(r.portalContributions),overrides,r.portalContributions.list('commands'));r.browser.savePreferences({locale:s.locale,keybindingOverrides:overrides});update(r,ctx,{keybindingOverrides:overrides,modal:null,error:'',notice:'Keyboard shortcut saved.',keyChord:[]});r.browser.restoreFocus();}catch(error){update(r,ctx,{error:error.message});}}
}
export class ResetShortcuts extends Action {
 static deps={state:{write:true},browser:{}};
 constructor(detail={}){super();this.detail=detail;}
 execute(r,ctx){const s=current(r),id=this.detail.command,overrides=id?(s.keybindingOverrides??[]).filter(binding=>binding.command!==id&&binding.command!==`-${id}`):[];try{r.browser.savePreferences({locale:s.locale,keybindingOverrides:overrides});update(r,ctx,{keybindingOverrides:overrides,keyChord:[],notice:'Shortcut defaults restored.',error:''});}catch(error){update(r,ctx,{error:error.message});}}
}
export class PressShortcut extends Action {
 static deps={state:{write:true},browser:{},portalContributions:{}};
 constructor(detail){super();this.detail=detail;}
 execute(r,ctx){const s=current(r),context=portalContext(s,{textInputFocus:r.browser.inputFocused()}),registry=r.portalContributions;const result=resolveKeybinding(compileKeybindings(defaultBindings(registry),s.keybindingOverrides,registry.list('commands')),context,s.keyChord,this.detail.stroke,{now:r.browser.now()});if(result.status!=='none'||s.keyChord?.strokes?.length)update(r,ctx,{keyChord:result.sequence});if(result.status==='command')ctx.engineFeed.dispatchEvent(new CustomEvent('portal-command-requested',{detail:{id:result.command}}));}
}
export class ClearShortcutChord extends Action {
 static deps={state:{write:true}};
 constructor(detail){super();this.detail=detail;}
 execute(r,ctx){if(current(r).keyChord?.startedAt===this.detail.startedAt)update(r,ctx,{keyChord:[]});}
}

export class ReportCommandError extends Action {static deps={state:{write:true}};constructor(detail){super();this.detail=detail;}execute(r,ctx){update(r,ctx,{error:this.detail.message});}}
