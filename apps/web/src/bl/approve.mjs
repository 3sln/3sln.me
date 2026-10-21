// LA4, mock-first: LA3 mounts startApprovePage; no demo or production routes are installed here.
// Contract: accounts/session use the existing member selectors and CSRF. linked/resolve returns
// {request:{id,kind,createdAt,expiresAt,deviceKind?,client?:{origin,reviewed},countryMismatch?,sameBrowser?},
//  session:{expiresAt,authAt:timestamp|null,sessionTtlMs?},consent?:{requests:[consent-kit views]},identityHint?}.
// linked/{approve,deny} re-match the typed code and owner/session; approve returns {expiresAt}.
// linked/configure takes the consent kit's fragment/values/revision/digest fields and returns a new review.
// App resolve/approve must independently enforce fresh sign-in in this flow; browser evidence is UX only.
import {Action,Query,Engine,Provider,dodo as d} from '../shared/stack.mjs';
import {createEntryAPI,parseAccounts} from './authorize-entry.mjs';
import {freshAPI,ConfirmOwner,CancelOwnerConfirmation,cancelStepUp} from './step-up.mjs';
import {createArming} from './authorize-entry-arming.mjs';
import {decodeOptions,serializeCredential} from './browser-codecs.mjs';
import {consentKit} from '../ui/authorize-entry-consent.mjs';
import {approveView} from '../ui/approve.mjs';
import {approveLocalization} from '../../../../packages/i18n/approve-catalogue.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,KEY='3sln-linked-approval',TEN_MIN=600000,HOUR=3600000;
const fail=code=>{throw Object.assign(Error(code),{code});},changed=ctx=>ctx.engineFeed.dispatchEvent(new Event('browser-state-updated'));
export function normalizeApprovalCode(value){const code=typeof value==='string'?value.toUpperCase().replace(/[- ]/g,''):'';return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(code)?code:null;}
export function approvalLocator(hash=''){const p=new URLSearchParams(hash.replace(/^#/,'')),id=p.get('r')??p.get('request');return UUID.test(id??'')?id:null;}
export function approvalDurations(request,session,now){
 if(request.kind==='app')return [{value:'ongoing',label:'Ongoing'},{value:'1h',label:'1 hour'},{value:'8h',label:'8 hours'}];
 const remaining=Math.max(0,Math.min(session.expiresAt-(session.reviewedAt??now),session.sessionTtlMs??24*HOUR));
 return [...[{value:HOUR,label:'1 hour'},{value:8*HOUR,label:'8 hours'}].filter(option=>option.value<remaining),{value:remaining,label:'Until your sign-in here ends'}];
}
export function validApprovalReview(value,now){
 const q=value?.request,s=value?.session;
 if(!q||!UUID.test(q.id??'')||!['session','app'].includes(q.kind)||!Number.isSafeInteger(q.createdAt)||q.createdAt>now||!Number.isSafeInteger(q.expiresAt)||q.expiresAt<=now||!s||!Number.isSafeInteger(s.expiresAt)||s.expiresAt<=now||s.authAt!==null&&(!Number.isSafeInteger(s.authAt)||s.authAt>now)||s.sessionTtlMs!==undefined&&(!Number.isSafeInteger(s.sessionTtlMs)||s.sessionTtlMs<=0))fail('invalid_code');
 let host=null;if(q.kind==='app'){let url;try{url=new URL(q.client?.origin);}catch{fail('invalid_code');}if(q.client.reviewed!==true||url.protocol!=='https:'||url.username||url.password||url.origin!==q.client.origin)fail('invalid_code');host=url.host;if(!Array.isArray(value.consent?.requests)||value.consent.requests.length>8)fail('invalid_code');}
 if(q.kind==='session'&&!['tv','computer','phone'].includes(q.deviceKind))fail('invalid_code');
 return {request:{id:q.id,kind:q.kind,createdAt:q.createdAt,expiresAt:q.expiresAt,deviceKind:q.deviceKind,host,countryMismatch:q.countryMismatch===true,sameBrowser:q.sameBrowser===true},session:{...s,authAt:s.authAt??0,reviewedAt:now},consent:q.kind==='app'?structuredClone(value.consent):{requests:[]},identityHint:typeof value.identityHint==='string'?value.identityHint:null};
}
export function createApproveState(){const model={phase:'loading',busy:false,error:'',notice:'',draft:'',locator:null,accounts:[],selected:null,session:null,beamGeneration:0,offline:false,stepUp:null,request:null,approvalSession:null,choice:null,consent:{requests:[]},selection:new Map(),drafts:new Map(),dirty:new Set(),sensitive:new Set(),freshMembers:new Map(),surface:0,signInReason:null};return {model,snapshot:()=>model,transition:recipe=>recipe(model),reserve:()=>{if(model.busy)return false;model.busy=true;model.error='';return true;}};}
const freshInFlow=(s,member,now)=>{const at=s.freshMembers.get(member.id+'/'+member.sessionContext);return Number.isSafeInteger(at)&&at<=now&&now-at<=300000;};
export function createApproveAPI({fetch}={}){
 const transport=createEntryAPI(fetch?{fetch}:{});let member=null,csrf=null;
 return {setContext(value){member=value?.account?{id:value.account.id,sessionContext:value.sessionContext}:null;csrf=value?.csrfToken??null;},
  get:(path)=>transport.get(path,{member}),async request(path,body){const value=await transport.post(path,body,{member,csrf});return path==='/api/auth/step-up/begin'&&value.passkey?{...value,password:false}:value;}};
}
export function createApproveBrowser(win=globalThis.window){return {now:()=>Date.now(),location:()=>win.location,clearFragment:()=>win.history.replaceState(null,'',win.location.pathname),focus:selector=>win.document.querySelector(selector)?.focus(),
 readDraft(){try{const v=JSON.parse(win.sessionStorage.getItem(KEY)??'null');win.sessionStorage.removeItem(KEY);return v;}catch{return null;}},saveDraft:value=>{try{win.sessionStorage.setItem(KEY,JSON.stringify(value));}catch{fail('draft_unavailable');}},clearDraft:()=>{try{win.sessionStorage.removeItem(KEY);}catch{}},navigate:path=>win.location.assign(path),
 authenticatePasskey:async options=>serializeCredential(await win.navigator.credentials.get({publicKey:decodeOptions(options)})),
 // LA3's host supplies the existing Turnstile component; never pretend a populated key is a proof.
 signInProof:()=>({}),framed:()=>win.top!==win.self};}
const messages={invalid_code:'That code does not match. Get a new code on your device if it expired.',rate_limited:'Too many attempts. Wait before trying again.',unauthorized:'That account is no longer signed in. Choose an account again.',account_context_conflict:'That account is no longer signed in. Choose an account again.',session_context_conflict:'That account is no longer signed in. Choose an account again.',draft_unavailable:'This browser could not save your pending approval. Stay here and sign in.',fresh_signin_required:'Sign in again here to approve this app.',reauthentication_required:'Confirm your passkey or password before approving.',invalid_credentials:'Sign-in failed. Check your details and try again.'};
// The local freshness guard borrows freshAPI's suspended-request prompt, without inventing a server
// endpoint or minting authentication evidence. The decision endpoint must still check freshness itself.
async function confirmApprovalOwner(r,ctx){let confirmed=false;const gate={get:async()=>{if(!confirmed){confirmed=true;fail('reauthentication_required');}return {};},request:async(...args)=>{const value=await r.api.request(...args);return args[0]==='/api/auth/step-up/begin'&&value.passkey?{...value,password:false}:value;}};await freshAPI({...r,api:gate},ctx).get('approval-credential');}
export class ApproveView extends Query {static deps=['state'];boot({state},{notify,engineFeed}){this.feed=engineFeed;this.publish=()=>notify({...state.snapshot()});engineFeed.addEventListener('browser-state-updated',this.publish);this.publish();}kill(){this.feed.removeEventListener('browser-state-updated',this.publish);}}
export class ApproveAction extends Action {
 static deps={state:{write:true},secrets:{write:true},api:{},browser:{},i18n:{},consent:{}};
 constructor(kind,detail={}){super();this.kind=kind;this.detail=detail;}
 async execute(r,ctx){const s=r.state.snapshot(),{kind,detail}=this;
  if(kind==='draft'){if(s.phase==='code'&&!s.busy){s.draft=String(detail.code??'').slice(0,32);changed(ctx);}return;}
  if(kind==='early'){s.notice=r.i18n.t('Ready in a moment. Select the button again.');changed(ctx);return;}
  if(kind==='consent-changed'){s.surface++;changed(ctx);return;}
  if(kind==='expire'){if(!s.request||r.browser.now()<s.request.expiresAt&&r.browser.now()<s.approvalSession.expiresAt)return;s.beamGeneration++;cancelStepUp(r.browser);s.stepUp=null;s.request=null;s.phase='code';s.busy=false;s.draft='';r.secrets.code=null;r.secrets.ticket=null;s.error=r.i18n.t(messages.invalid_code);changed(ctx);return;}
  if(kind==='duration'){if(!s.busy&&s.request&&approvalDurations(s.request,s.approvalSession,r.browser.now()).some(o=>o.value===detail.value)){s.choice=detail.value;s.surface++;changed(ctx);}return;}
  if(kind==='sensitive'){if(!s.busy){detail.checked?s.sensitive.add(detail.fragment):s.sensitive.delete(detail.fragment);s.surface++;changed(ctx);}return;}
  if(s.busy)return;if(!r.state.reserve())return;const ticket={};r.secrets.ticket=ticket;changed(ctx);
  const generation=s.beamGeneration,live=()=>s.beamGeneration===generation&&!s.offline;
  try{
   if(kind==='boot'){
    if(r.browser.framed?.()){s.phase='blocked';return;}
    s.locator=approvalLocator(r.browser.location().hash);r.browser.clearFragment();const draft=r.browser.readDraft();
    if(draft?.v===1&&Number.isSafeInteger(draft.savedAt)&&draft.savedAt<=r.browser.now()&&r.browser.now()-draft.savedAt<=TEN_MIN){if(!s.locator&&UUID.test(draft.locator??''))s.locator=draft.locator;s.draft=normalizeApprovalCode(draft.code)??'';}
    s.accounts=parseAccounts(await r.api.get('/api/auth/accounts'));s.phase='code';if(s.draft){r.secrets.code=s.draft;s.phase=s.accounts.length?'choose':'signin';s.signInReason='initial';}return;
   }
   if(kind==='code'){
    const code=normalizeApprovalCode(detail.code??s.draft);if(!code)fail('invalid_code');r.secrets.code=code;s.draft=code;s.request=null;s.selected=null;s.session=null;r.api.setContext(null);s.phase=s.accounts.length?'choose':'signin';s.signInReason='initial';return;
   }
   if(kind==='another'){cancelStepUp(r.browser);s.stepUp=null;s.phase='choose';s.request=null;s.selected=null;s.session=null;s.beamGeneration++;r.api.setContext(null);return;}
   if(kind==='add-account'){s.phase='signin';s.signInReason='another';return;}
   if(kind==='accounts'){
    const accounts=parseAccounts(await r.api.get('/api/auth/accounts'));if(!live())return;const member=accounts.find(a=>a.id===s.selected?.id&&a.sessionContext===s.selected?.sessionContext);s.accounts=accounts;
    if(s.selected&&!member){s.beamGeneration++;cancelStepUp(r.browser);s.selected=null;s.session=null;s.request=null;s.stepUp=null;r.api.setContext(null);s.phase=accounts.length?'choose':'signin';}return;
   }
   if(kind==='signin'){
    const input={handle:detail.values?.handle,...await r.browser.signInProof()},method=detail.method;if(!['passkey','password'].includes(method))fail('invalid_credentials');
    let result;if(method==='password')result=await r.api.request('/api/auth/login/password',{...input,password:detail.values?.password});
    else {const begin=await r.api.request('/api/auth/login/passkey/begin',input);if(!live())return;const response=await r.browser.authenticatePasskey(begin.authenticationOptions);if(!live())return;result=await r.api.request('/api/auth/login/passkey/finish',{challengeToken:begin.challengeToken,response});}
    if(!live())return;const member=parseAccounts({accounts:[result]})[0];if(!result.csrfToken||s.signInReason==='app'&&member.id!==s.selected?.id)fail('fresh_signin_required');
    s.freshMembers.set(member.id+'/'+member.sessionContext,r.browser.now());const accounts=parseAccounts(await r.api.get('/api/auth/accounts'));if(!live())return;s.accounts=accounts;s.selected=member;s.session={account:{id:member.id,handle:member.handle},sessionContext:member.sessionContext};r.api.setContext(result);await this.resolve(r,ctx);return;
   }
   if(kind==='choose'){
    const member=s.accounts.find(a=>a.id===detail.id&&a.sessionContext===detail.sessionContext);if(!member)fail('unauthorized');s.selected=member;s.session={account:{id:member.id,handle:member.handle},sessionContext:member.sessionContext};
    r.api.setContext({account:{id:member.id},sessionContext:member.sessionContext});const session=await r.api.get('/api/session');if(!live())return;if(session.account?.id!==member.id||session.sessionContext!==member.sessionContext)fail('account_context_conflict');r.api.setContext(session);await this.resolve(r,ctx);return;
   }
   if(kind==='signin-again'){s.phase='signin';s.signInReason=s.request?.kind==='app'?'app':'renew';return;}
   if(kind==='retry-credential'){if(s.selected&&s.phase==='credential')await this.resolve(r,ctx);return;}
   if(kind==='navigate'){
    if(!['/console?signup=1','/recovery/restore','/console?signin=1'].includes(detail.path))return;
    r.browser.saveDraft({v:1,...s.locator?{locator:s.locator}:{},code:r.secrets.code,savedAt:r.browser.now()});r.browser.navigate(detail.path);return;
   }
   if(kind==='configure'){
    if(s.phase!=='review'||s.request?.kind!=='app')return;const result=await r.api.request('/api/auth/linked/configure',{requestId:s.request.id,code:r.secrets.code,fragment:detail.fragment,values:detail.values,expectedRevision:detail.expectedRevision,reviewedConsumerDigest:detail.reviewedConsumerDigest,updateShared:detail.updateShared});if(!live())return;
    const review=validApprovalReview(result,r.browser.now());if(review.request.id!==s.request.id||review.request.kind!=='app')fail('invalid_code');s.consent=review.consent;s.drafts.clear();s.dirty.clear();s.selection.clear();s.sensitive.clear();s.surface++;return;
   }
   if(kind==='approve'||kind==='deny'){
    const q=s.request;if(s.phase!=='review'||!q||!s.selected||!r.secrets.code)return;if(r.browser.now()>=q.expiresAt)fail('invalid_code');
    const input={requestId:q.id,code:r.secrets.code,owner:s.selected.id,sessionContext:s.selected.sessionContext};
    if(kind==='approve'){
     if(!r.browser.approvalArmed?.())return;
     if(q.kind==='app'&&!freshInFlow(s,s.selected,r.browser.now()))fail('fresh_signin_required');
     if(!approvalDurations(q,s.approvalSession,r.browser.now()).some(o=>o.value===s.choice)&&q.kind==='app')fail('invalid_code');
     if(q.kind==='app'&&(r.consent.approvalBlocked(s.consent)||s.consent.requests.some(q=>q.sensitive&&!r.consent.selection(q).declined&&!s.sensitive.has(q.fragment))))return;
     Object.assign(input,{choice:s.choice,...q.kind==='app'?{consent:r.consent.approvedSelections(s.consent),sensitive:[...s.sensitive]}:{}});
    }
    const result=await (kind==='approve'&&q.kind==='session'?freshAPI(r,ctx):r.api).request('/api/auth/linked/'+kind,input);if(!live())return;
    if(kind==='approve'&&!(q.kind==='app'&&s.choice==='ongoing'&&result.expiresAt===null)&&(!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=r.browser.now()))fail('request_failed');
    s.phase=kind==='approve'?'approved':'denied';s.endsAt=result.expiresAt;r.secrets.code=null;s.draft='';s.locator=null;r.browser.clearDraft();return;
   }
  }catch(error){if(live()){
   s.error=r.i18n.t(messages[error?.code]??'The request could not be completed. Check your connection before trying again.');
   if(kind==='boot')s.phase='unavailable';
   if(error?.code==='invalid_code'){r.secrets.misses=(r.secrets.misses??0)+1;if(r.secrets.misses>=5)s.locator=null;s.phase='code';s.request=null;}
   if(error?.code==='fresh_signin_required'){s.phase='signin';s.signInReason='app';}
   if(['unauthorized','account_context_conflict','session_context_conflict'].includes(error?.code)){s.beamGeneration++;s.selected=null;s.session=null;s.request=null;s.phase='choose';r.api.setContext(null);}
  }}finally{if(r.secrets.ticket===ticket)s.busy=false;s.surface++;changed(ctx);}
 }
 async resolve(r,ctx){const s=r.state.snapshot(),generation=s.beamGeneration,member=s.selected;
  const value=await r.api.request('/api/auth/linked/resolve',{code:r.secrets.code,...s.locator?{locator:s.locator}:{}});if(generation!==s.beamGeneration||member!==s.selected)return;
  const view=validApprovalReview(value,r.browser.now());Object.assign(s,{request:view.request,approvalSession:view.session,consent:view.consent,choice:approvalDurations(view.request,view.session,r.browser.now()).at(view.request.kind==='app'?0:-1).value});s.selection.clear();s.drafts.clear();s.dirty.clear();s.sensitive.clear();
  s.phase=view.request.kind==='app'&&!freshInFlow(s,member,r.browser.now())?'signin':'review';if(s.phase==='signin')s.signInReason='app';
  if(view.request.kind==='session'&&(view.session.authAt<=0||r.browser.now()-view.session.authAt>300000)){s.phase='credential';changed(ctx);await confirmApprovalOwner(r,ctx);if(generation!==s.beamGeneration||member!==s.selected)return;s.phase='review';}changed(ctx);
 }
}
export function startApprovePage({root,preferredLocale='en',win=globalThis.window,api=createApproveAPI(),browser=createApproveBrowser(win)}={}){
 const i18n=approveLocalization(preferredLocale),state=createApproveState(),secrets={code:null,misses:0},model=state.model;win.document.documentElement.lang=i18n.locale;win.document.title=i18n.t('Approve a sign-in');
 let engine,disposed=false,lastSurface='',lastPhase='',arming;const dispatch=(kind,detail)=>engine.dispatch(new ApproveAction(kind,detail));
 const kit=consentKit({model,t:i18n.t,root,rerender:()=>dispatch('consent-changed'),onConfigure:detail=>dispatch('configure',detail)});
 browser.approvalArmed=()=>arming.armed;
 engine=new Engine({providers:Object.fromEntries(Object.entries({state,secrets,api,browser,i18n,consent:kit}).map(([k,v])=>[k,Provider.fromSingleton(v)]))});
 function render(){if(disposed)return;const surface=`${model.phase}|${model.surface}|${model.stepUp?.id??''}`;if(surface!==lastSurface){lastSurface=surface;arming?.reset();}
  d.reconcile(root,[approveView(model,{...i18n,dispatch,kit,armed:arming?.armed===true,guard:handler=>arming.guard(handler)})]);
  if(lastPhase&&lastPhase!==model.phase&&model.phase!=='loading')root.querySelector('#approval-title')?.focus();lastPhase=model.phase;
 }
 arming=createArming({win,doc:win.document,delay:1000,onChange:render,onReject:()=>dispatch('early')});
 const query=engine.query(new ApproveView()).subscribe({next:render});
 const intent=event=>{const detail=event.detail;if(!['confirm-owner','cancel-owner-confirmation'].includes(detail?.kind))return;const values=detail.form?Object.fromEntries(new win.FormData(detail.form)):undefined;engine.dispatch(detail.kind==='confirm-owner'?new ConfirmOwner({...detail,values}):new CancelOwnerConfirmation(detail));};root.addEventListener('3sln-intent',intent);
 const refresh=()=>{if(win.document.visibilityState!=='hidden')dispatch('accounts');};win.addEventListener('focus',refresh);win.document.addEventListener('visibilitychange',refresh);
 let channel;try{channel=new win.BroadcastChannel('bindle-accounts');channel.onmessage=event=>{if(event.data?.type==='accounts-changed'&&Object.keys(event.data).length===1)refresh();};}catch{}
 const expiry=win.setInterval(()=>{if(model.request&&['review','credential'].includes(model.phase))dispatch('expire');},1000);
 dispatch('boot');
 const dispose=()=>{disposed=true;model.beamGeneration++;cancelStepUp(browser);secrets.code=null;channel?.close();arming.dispose();win.clearInterval(expiry);query.unsubscribe();root.removeEventListener('3sln-intent',intent);win.removeEventListener('focus',refresh);win.document.removeEventListener('visibilitychange',refresh);win.removeEventListener('pagehide',dispose);engine.dispose();};
 win.addEventListener('pagehide',dispose,{once:true});return {engine,state,secrets,dispatch,render,dispose};
}
