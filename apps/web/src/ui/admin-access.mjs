import { h, icon, fire, logo } from './release-primitives.mjs';
import { interfaceText as tx } from './interface-text.mjs';
// Boot setup, boot sign-in, the administrator gate and the shared console frame.
// Operation screens live in admin-console.mjs and are imported only after access.
export const ERRORS={
 invalid_boot_token:'This boot token is invalid, expired or already used.',
 boot_token_consumed:'This boot token was already used or its setup window closed. Mint a new token and redeploy its digest.',
 setup_binding_required:'Continue setup in the browser that started it.',
 acknowledgement_required:'Tick the acknowledgement to confirm you understand when boot access ends.',
 invalid_password:'Use a password of 15–128 characters.',
 password_mismatch:'The two passwords do not match.',
 password_required:'Enter the boot password.',
 invalid_passkey:'Passkey verification failed. Try again or choose a password.',
 invalid_method:'Choose a passkey or a password.',
 boot_unavailable:'Boot setup is not configured on this deployment.',
 boot_expired:'Boot access has expired.',
 boot_unclaimed:'Boot has not been claimed yet.',
 unauthorized:'Authentication failed or your session ended. Sign in again.',
 session_expired:'Your boot session ended. Sign in again to continue.',
 csrf:'This request did not come from this console’s exact origin. Reload the page and try again.',
 step_up_required:'Confirm it’s you to continue.',
 step_up_cancelled:'Not confirmed. Nothing was changed.',
 actor_required:'Choose the boot or administrator console.',
 forbidden:'Administrator authority is required.',
 rate_limited:'Too many administrative actions. Wait a few minutes before continuing.',
 conflict:'Something changed while you were working. The latest state has been reloaded; review it and try again.',
 invalid_request:'The request was not accepted. Check the fields and try again.',
 invalid_handle:'Enter a named handle of 3–32 characters.',
 boot_reserved:'The boot handle is permanently reserved.',
 handle_unavailable:'This handle already has a permanent assignment.',
 not_found:'Nothing matches that request.',
 static_reservation:'Deployment configuration reserves this handle. Change it there.',
 claim_outstanding:'This handle has an outstanding claim token. Revoke it first.',
 reservation_assigned:'Assigned or retired handles are never released.',
 claims_unavailable:'Claim tokens need a configured onboarding key on this deployment.',
 static_name_boot_only:'Only boot can mint claims for handles reserved by deployment configuration.',
 not_reserved:'Reserve this handle before minting a claim token.',
 claim_unavailable:'This claim token is no longer usable.',
 claim_minter_only:'Only boot or the administrator who minted this claim can retrieve its link.',
 claim_in_use:'Setup already started with this claim. Manage the account instead.',
 invalid_email:'Enter a complete email address.',
 classification_boot_only:'Only boot can classify roles, capabilities and badges, or change internal roles.',
 invalid_role_catalog:'The role catalog is invalid. Check identifiers, names and capability classes.',
 invalid_roles:'Choose up to 16 distinct roles.',
 unknown_role:'A selected role is not defined.',
 role_class_forbidden:'Internal roles require a reserved internal account.',
 self_forbidden:'Administrators cannot change their own account.',
 admin_target_forbidden:'Only boot can change or suspend an administrator.',
 admin_role_boot_only:'Only boot can create administrators.',
 role_boot_only:'Only boot can assign this internal role.',
 invalid_badges:'Choose up to four configured badges.',
 badge_class_forbidden:'This badge is limited to reserved internal accounts.',
 badge_boot_only:'Only boot can assign this badge.',
 invalid_state:'The account is not in a state that allows this change.',
 passkey_required:'Administrators confirm with a passkey. Add a passkey to this account under Account & security, then return.',
 passkey_unavailable:'No passkey is registered for boot. Use the password.',
 passkey_unsupported:'This browser does not support passkeys.',
 passkey_exists:'This authenticator already holds a passkey for this site. Use another authenticator.',
 passkey_cancelled:'The passkey request was cancelled or timed out.',
 admin_unavailable:'Administration is not available on this deployment.',
 network:'The service could not be reached. Check your connection and try again.',
 token_missing:'Paste the boot token or import the token file.',
 token_file_invalid:'This is not a boot token file.',
 token_wrong_origin:'This token was minted for another origin. Mint one for this console’s exact origin.',
 token_stale:'This token is older than its 30-minute window. Mint a new token and redeploy its digest.',
 token_malformed:'This does not look like a boot token. It starts with “boot1.”.',
 setup_lost:'Setup was interrupted. Paste the token again.',
 setup_expired:'The 10-minute setup window closed and the token is now used. Mint a new token and redeploy its digest.',
 confirmation_required:'Confirm this action first.',
 logout_unconfirmed:'The server did not confirm the sign-out. This browser’s boot cookie was cleared; if this is a shared device, close the browser and sign in again later to verify.',
 role_exists:'A role with this identifier already exists.',
 capability_exists:'A capability with this identifier already exists.',
 invalid_owner:'Enter a complete account identifier (UUID).',
 copy_failed:'The link could not be copied. Select it and copy it manually.',
 step_up_failed:'That confirmation did not succeed. Try again.',
 unexpected_response:'The service returned an unexpected response.'
};
export const errorText=error=>error?ERRORS[error.code]??tx('The request could not be completed ({code}).',{code:String(error.code??'unknown').slice(0,64)}):null;
export const NOTICES={reserved:'Reservation saved.',unreserved:'Reservation released.',revoked:'Claim token revoked.','catalog-saved':'Role catalog saved.','roles-saved':'Roles saved.','badges-saved':'Badges saved.',suspended:'Account suspended.',reactivated:'Account reactivated.','step-up-cancelled':'Not confirmed. Nothing was changed.','signed-out':'You signed out of boot.',claimed:'Boot is claimed. This browser now holds a boot session.',restored:'Boot is restored. Older boot sessions no longer work.','client-blocked':'Client host blocked.','client-unblocked':'Client host unblocked.'};
export const noticeText=notice=>NOTICES[notice]??notice;
export const data=(value,tag='span')=>h(tag,String(value??'')).attrs({translate:'no'});
export function formatTime(value,locale){if(!Number.isFinite(value))return '—';try{return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}catch{return new Date(value).toISOString();}}
export const when=(value,locale)=>data(formatTime(value,locale));
export function duration(ms){const total=Math.max(0,Math.floor(ms/1000)),hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),seconds=total%60;if(hours>0)return tx('{hours} h {minutes} min',{hours:String(hours),minutes:String(minutes).padStart(2,'0')});if(minutes>=10)return tx('{minutes} min',{minutes:String(minutes)});return tx('{minutes} min {seconds} s',{minutes:String(minutes),seconds:String(seconds).padStart(2,'0')});}
export function button(state,text,kind,detail={},cls='button',disabled=false){return h('button',text).props({type:'button',disabled:disabled||state.busy}).classes(...cls.split(' ').filter(Boolean)).on({click:event=>fire(event.currentTarget,kind,detail)});}
/** Native form submission is always intercepted: no field ever reaches a URL. */
export function form(state,children,kind,label,{detail={},cls='',danger=false,clear=false,disabled=false}={}){
 return h('form',...children,h('div',h('button',state.busy?'Please wait…':label).props({type:'submit',disabled:disabled||state.busy}).classes('button',danger?'danger-button':'primary')).classes('form-actions')).props({method:'post'}).on({submit:event=>{event.preventDefault();const node=event.currentTarget;if(state.busy||disabled||!node.checkValidity()){node.reportValidity?.();return;}const values={};for(const [key,value] of new FormData(node))if(typeof value==='string'){if(Object.hasOwn(values,key))values[key]=[].concat(values[key],value);else values[key]=value;}for(const box of node.querySelectorAll('input[type=checkbox][data-list]'))if(!Object.hasOwn(values,box.name))values[box.name]=[];fire(node,kind,{...detail,values});if(clear)for(const input of node.querySelectorAll('input[type=password]'))input.value='';}}).classes('form','admin-form',...cls.split(' ').filter(Boolean));
}
export function input(name,label,type='text',extra={},help){const id=`field-${name}`;const {minLength,maxLength,min,max,list,...rest}=extra,props={},attributes={};for(const [key,value] of Object.entries(rest))(key.startsWith('data-')?attributes:props)[key]=value;if(list)attributes.list=list;return h('div',h('label',label).attrs({for:id}),h('input').props({id,name,type,...props}).attrs({...attributes,...help?{'aria-describedby':id+'-help'}:{},...minLength!==undefined?{minlength:String(minLength)}:{},...maxLength!==undefined?{maxlength:String(maxLength)}:{},...min!==undefined?{min:String(min)}:{},...max!==undefined?{max:String(max)}:{},autocapitalize:'off',spellcheck:'false'}).classes('input').key(`${name}:${type}`),help?h('p',help).props({id:id+'-help'}).classes('field-help'):null).classes('field');}
export function alerts(state){return h('div',state.error?h('div',h('p',errorText(state.error)),state.error.issuer?h('p',tx('Token issuer: {issuer}',{issuer:state.error.issuer})).classes('field-help'):null,button(state,'Dismiss','dismiss',{},'text-button',false)).attrs({role:'alert'}).classes('alert','error','admin-alert'):null,state.notice?h('p',icon('check'),h('span',noticeText(state.notice)),state.noticeSubject?h('strong',String(state.noticeSubject)).attrs({translate:'no'}).classes('notice-subject'):null).attrs({role:'status'}).classes('alert','success'):null).classes('alerts');}
/** Persistent boot banner: a countdown to boot expiry (role=timer, so assistive
 * technology is not interrupted every second) with a plain-language deadline. */
export function bootBanner(state){
 const boot=state.boot;if(state.mode!=='boot'||!boot)return null;const left=boot.bootExpiresAt-state.now,urgent=left<=3600000,critical=left<=600000;
 const sessionLeft=boot.sessionExpiresAt-state.now;
 return h('section',h('div',icon('shield'),h('div',h('strong',tx('Boot access ends in {time}',{time:String(duration(left))})).props({id:'boot-countdown'}),h('span',tx('At {time}. After that, only a new boot token and redeploy can restore boot.',{time:formatTime(boot.bootExpiresAt,state.locale)})))).classes('boot-banner-text'),h('span',sessionLeft<=300000?tx('Session ends in {time}. Sign in again soon.',{time:String(duration(sessionLeft))}):tx('Session: {time} left',{time:String(duration(sessionLeft))})).classes('boot-session-left',sessionLeft<=300000?'ending':'')).attrs({role:'timer','aria-labelledby':'boot-countdown'}).classes('boot-banner',urgent?'urgent':'',critical?'critical':'');
}
export function frame(state,content,{nav=null}={}){
 // Each phase gets fresh form controls: no typed value or constraint survives into another screen.
 const main=state.phase==='console'?content:h('div',content).key('phase:'+state.phase+':'+(state.setup?.mode??'')+':'+(state.setup?.method??''));
 const actor=state.phase==='console'?(state.mode==='boot'?h('span','Boot').classes('pill','actor-pill','actor-boot'):h('span',tx('Administrator · {handle}',{handle:state.account?.handle??''})).classes('pill','actor-pill','admin')):null;
 return h('div',h('a','Skip to content').props({href:'#admin-main'}).classes('skip-link'),
  h('header',h('div',logo({brand:{name:'3sln.me'}}),h('span','Host administration').classes('admin-title')).classes('admin-brand'),h('div',actor,h('select',h('option','English').props({value:'en',selected:state.locale==='en'}),h('option','Español').props({value:'es',selected:state.locale==='es'})).attrs({'aria-label':'Interface language'}).classes('language-switch').on({change:event=>fire(event.currentTarget,'set-locale',{values:{locale:event.target.value}})}),state.phase==='console'?button(state,[icon('logout'),state.mode==='boot'?'Sign out of boot':'Leave administration'],'sign-out',{},'button secondary',false):null).classes('admin-header-actions')).classes('admin-header'),
  bootBanner(state),nav,
  h('main',alerts(state),main).props({id:'admin-main',tabIndex:-1}).classes('admin-main')
 ).classes('admin-console',state.mode==='boot'?'boot-mode':'admin-mode').props({inert:Boolean(state.modal)}).attrs({'aria-hidden':state.modal?'true':null});
}
const panel=(title,...children)=>h('section',h('h1',title).props({id:'admin-heading',tabIndex:-1}),...children).classes('panel','admin-access-panel');
function setupView(state){
 const setup=state.setup;
 if(!setup){
  const tokenNote=state.tokenState==='reserved'?h('p','This deployment’s token is already reserved by a setup in progress. If that was not you, mint a new token and redeploy its digest.').classes('alert','warning-note'):state.tokenState==='used'?h('p','This deployment’s token has already been used. Restoring or claiming boot needs a new token and redeploy.').classes('alert','warning-note'):null;
  return panel(state.tokenState==='used'?'Boot token already used':'Set up boot access',
   h('p','Boot is this host’s deploy-token principal. It is not an account: it has no inbox, recovery file or directory entry, and its access ends after a fixed window.').classes('muted'),tokenNote,
   form(state,[h('div',h('label','Boot token').attrs({for:'field-token'}),h('textarea').props({id:'field-token',name:'token',rows:3,autocomplete:'off',spellcheck:false}).attrs({autocapitalize:'off','aria-describedby':'field-token-help'}).classes('input','token-input'),h('p','Paste the token or the whole token file from scripts/boot-token.mjs. It is sent once to this exact origin and never placed in the address bar.').props({id:'field-token-help'}).classes('field-help')).classes('field'),
    h('div',h('label','Or import the token file').attrs({for:'field-token-file'}),h('input').props({id:'field-token-file',type:'file',accept:'.json,.txt,application/json,text/plain'}).classes('input','file-input').on({change:event=>{const file=event.currentTarget.files?.[0];if(file)fire(event.currentTarget,'boot-start',{file});event.currentTarget.value='';}})).classes('field')],'boot-start','Check token',{clear:true}));
 }
 const left=setup.completeBy-state.now,endsAt=state.now+setup.accessMs;
 return panel(setup.mode==='restore'?'Restore boot access':'Claim boot access',
  h('p',setup.mode==='restore'?'Boot already exists. Restoring replaces its credential and signs out every older boot session. Administrators, roles and claims stay as they are.':'This is the first claim of boot on this host.').classes('muted'),
  h('p',tx('Finish within {time}. After that the token is burned and you must redeploy.',{time:String(duration(left))})).attrs({role:'timer'}).classes('alert','warning-note'),
  h('h2','Choose the boot credential').props({id:'boot-credential-heading',tabIndex:-1}),
  h('div',...[['passkey','Passkey','Recommended. Bound to this device or security key.'],['password','Password','15–128 characters. Stored only as a hash.']].map(([id,title,text])=>h('label',h('input').props({type:'radio',name:'boot-method',value:id,checked:setup.method===id}).on({change:event=>fire(event.currentTarget,'boot-method',{method:id})}),h('span',h('strong',title),h('span',text).classes('field-help'))).classes('choice-card',setup.method===id?'active':''))).attrs({role:'radiogroup','aria-label':'Boot credential'}).classes('choice-grid'),
  form(state,[setup.method==='password'?h('div',input('password','Boot password','password',{required:true,minLength:15,maxLength:128,autocomplete:'new-password'}),input('confirm','Repeat the password','password',{required:true,minLength:15,maxLength:128,autocomplete:'new-password'})):h('p','Your browser will ask you to create a passkey for “boot”.').classes('field-help'),
   h('div',h('p',h('strong','There is no recovery file for boot.'),' ',tx('Boot access ends at about {time} ({window} from now). Lost access needs a new token and redeploy.',{time:formatTime(endsAt,state.locale),window:String(duration(setup.accessMs))}))).classes('expiry-callout'),
   h('label',h('input').props({type:'checkbox',name:'acknowledge',required:true}).key('acknowledge'),h('span',tx('I understand boot access ends at about {time} and that lost access needs a new token and redeploy.',{time:formatTime(endsAt,state.locale)}))).classes('checkbox-field','acknowledge-field')],
   'boot-complete',setup.mode==='restore'?'Restore boot':'Claim boot'));
}
function signinView(state){
 const signin=state.signin;
 return panel('Sign in as boot',h('p','Boot signs in with the credential set when it was claimed or last restored. Boot sessions last at most one hour.').classes('muted'),
  !signin?h('p','Checking boot sign-in options…').attrs({role:'status'}):h('div',
   signin.passkey?h('div',button(state,[icon('shield'),'Sign in with passkey'],'boot-signin',{method:'passkey'},'button primary')).classes('form-actions'):null,
   signin.password?form(state,[input('password','Boot password','password',{required:true,autocomplete:'current-password',maxLength:512})],'boot-signin','Sign in with password',{detail:{method:'password'},clear:true}):null,
   !signin.passkey&&!signin.password?h('p','Boot has no usable credential. Restore it with a new token.').classes('alert','warning-note'):null));
}
const redeploy=()=>h('ol',h('li','On a trusted machine, mint a token: node scripts/boot-token.mjs mint --origin <this origin> --out boot-token.json'),h('li','Deploy the printed BOOTSTRAP_TOKEN_SHA256 value.'),h('li','Within 30 minutes of minting, open /console?boot and paste or import the token file.')).classes('redeploy-steps');
export function accessView(state){return accessScreen(state);}
function accessScreen(state){
 const p=state.phase;
 if(p==='loading')return frame(state,h('p','Opening host administration…').attrs({role:'status'}).classes('admin-loading'));
 if(p==='boot-setup')return frame(state,setupView(state));
 if(p==='boot-signin')return frame(state,signinView(state));
 if(p==='boot-expired')return frame(state,panel('Boot access has ended',h('p','Boot can no longer sign in, step up or act. Administrators, roles and claims are unaffected. Claims boot minted stay usable until their own expiry.').classes('muted'),h('h2','To restore boot'),redeploy()));
 if(p==='boot-ended')return frame(state,panel('Boot access ended early',h('p','You ended boot access. Boot can no longer sign in or act. Administrators, roles and claims are unaffected.').classes('muted'),h('h2','To restore boot'),redeploy()));
 if(p==='boot-unconfigured')return frame(state,panel('Boot is not configured',h('p','This deployment has no boot token digest, so boot cannot be claimed or restored here.').classes('muted'),h('h2','To configure boot'),redeploy()));
 if(p==='admin-signin')return frame(state,panel('Sign in to continue',h('p','Host administration uses your normal account session. Sign in with an administrator account, then return here.').classes('muted'),h('a','Go to sign-in').props({href:'/console?signin'}).classes('button','primary')));
 if(p==='admin-denied')return frame(state,panel('Not available for this account',h('p','Host administration is only for administrator accounts.').classes('muted'),h('a','Back to your space').props({href:'/console'}).classes('button','primary')));
 if(p==='left')return frame(state,h('p','Leaving host administration…').attrs({role:'status'}));
 return frame(state,panel('Administration unavailable',h('p','Host administration is not available on this deployment right now.').classes('muted'),h('a','Back to your space').props({href:'/console'}).classes('button','secondary')));
}
