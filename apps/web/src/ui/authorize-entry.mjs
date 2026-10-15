// Rendering for the provider-owned authorization entry page (slice A7). Pure projection of the entry model: the
// page module supplies `dispatch`, the arming guard and the shared consent kit. Account handles appear only on
// this provider page; approval controls ("Continue as …", "Allow selected access", "Sign out") are armed by
// bl/authorize-entry-arming.mjs, never take default focus and are marked aria-disabled until armed.
import {dodo as d} from '../shared/stack.mjs';
import {durationOf} from '../bl/authorize-entry.mjs';
const h=d.h;
const isolate=text=>'⁨'+text+'⁩';
const hostOf=origin=>{try{return new URL(origin).host;}catch{return origin;}};
function heading(model,t,host,{title=false}={}){
 const wrap=title?text=>text:isolate,app=wrap(model.entry?.client.name??''),intent=model.entry?.intent,target=model.accounts?.[0];
 switch(model.phase){
  case 'framed':return t('Sign-in can’t be shown inside another page');
  case 'sandboxed':return t('Open {host} in a normal window',{host});
  case 'invalid':return t('This sign-in link is incomplete');
  case 'expired':return t('This sign-in has expired');
  case 'unavailable':return t('Sign-in is not available right now');
  case 'consent':return t('Review what {app} can access',{app});
  case 'reauth':return t('Confirm it’s you');
  case 'end-session':return target?t('Sign out {account}?',{account:wrap(target.handle+'@'+host)}):t('Sign out of {host}?',{host});
  case 'returning':return t('Returning to {app}…',{app});
  case 'closed':return t('You can close this window');
  case 'choose':return intent==='reauthenticate'?t('Confirm it’s you'):intent==='select-account'?t('Choose an account for {app}',{app}):t('Sign in to {app}',{app});
  default:return t('Preparing secure sign-in…');
 }
}
const duration=(seconds,t)=>{const {count,unit}=durationOf(seconds);return unit==='seconds'?t.plural('{#} seconds','{#} second',count):unit==='minutes'?t.plural('{#} minutes','{#} minute',count):t.plural('{#} hours','{#} hour',count);};
/** `ctx`: {t, host, armed, guard(fn), dispatch(kind,detail), kit, canClose, close} */
export function entryView(model,ctx){
 const {t,host,armed,guard,dispatch,kit}=ctx,entry=model.entry,app=entry?isolate(entry.client.name):'',busy=model.busy;
 // Approval control: aria-disabled while unarmed (keeps focusability), inert while busy, no default focus.
 const approve=(text,action,{disabled=false,detail}={})=>h('button',text).props({type:'button',disabled:busy||disabled}).attrs({'aria-disabled':armed?undefined:'true'}).data({entryApprove:'true',consentApprove:detail}).classes('button','primary').on({click:guard(action)});
 const plain=(text,action,kind='secondary')=>h('button',text).props({type:'button',disabled:busy}).classes(...kind==='text-button'?['text-button']:['button',kind]).on({click:action});
 // One persistent live region for notices, placed after the controls so a notice never shifts them; errors are alerts.
 const status=[model.error?h('p',model.error).attrs({role:'alert'}).classes('alert','error'):null];
 const live=h('div',model.notice?h('p',model.notice).classes('security-note'):null).attrs({role:'status','aria-live':'polite'}).key('entry-live');
 // The registered origin is the trust anchor; the client name is registration data shown beside it.
 const origin=entry?h('p',t('App website: '),h('strong',hostOf(entry.client.origin)).attrs({translate:'no'}),' ',h('span',entry.client.origin).classes('field-help').attrs({translate:'no'})).key('entry-origin'):null;
 const cancel=entry&&entry.intent!=='end-session'?plain(model.phase==='consent'?t('Cancel connection'):t('Cancel'),()=>dispatch('cancel')):null;
 const account=handle=>isolate(handle+'@'+host);
 // A real link (never window.open with noopener, whose null result hides a blocked popup); middle-click works too.
 const signInLink=label=>h('a',label).props({href:'/console?signin',target:'_blank',rel:'noopener noreferrer'}).classes('button','secondary').on({click:()=>dispatch('open-signin')});
 const signIn=(label,help)=>h('div',h('p',help).classes('muted'),h('div',signInLink(label),plain(t('Check again'),()=>dispatch('accounts',{explicit:true}),'text-button')).classes('buttons')).classes('entry-signin');
 let body;
 switch(model.phase){
  case 'loading':case 'handshake':body=[h('p',t('Preparing secure sign-in…')).attrs({role:'status'})];break;
  case 'framed':body=[h('p',t('For your security, this page only works in its own window or tab. Close this page and start again from the application.'))];break;
  case 'sandboxed':body=[h('p',t('This window was opened with restrictions that make signing in unsafe. Open {host} in a normal window and start again from the application.',{host}))];break;
  case 'invalid':case 'expired':case 'unavailable':body=[h('p',model.phase==='unavailable'?t('Try again later from the application.'):t('Start again from the application. Nothing was shared.')),...status,ctx.canClose?h('div',plain(t('Close window'),()=>ctx.close())).classes('buttons'):null];break;
  case 'returning':body=[h('p',t('Returning to the application. Nothing else is needed here.')).attrs({role:'status'})];break;
  case 'closed':body=[h('p',model.outcome==='completed'?t('{app} received your sign-in.',{app}):t('Sign-in was canceled. Nothing was shared.')).attrs({role:'status'}),ctx.canClose?h('div',plain(t('Close window'),()=>ctx.close())).classes('buttons'):null];break;
  case 'choose':{
   const accounts=model.accounts??[],constrained=Boolean(entry.subjectConstraint);
   const intro=entry.intent==='reauthenticate'?h('p',t('{app} asks you to confirm your account. You need to have signed in less than {duration} ago.',{app,duration:duration(entry.maxAge,t)})):entry.requests.length?h('p',t('Choose an account. You will then review the access {app} requests before anything is shared.',{app})):h('p',t('{app} will receive your account’s ID, the same one other apps receive. Your handle, preferences and resources are not shared.',{app}));
   const rows=accounts.map(a=>h('li',h('div',approve(t('Continue as {account}',{account:account(a.handle)}),()=>dispatch('continue',{owner:a.id})),a.hinted?h('span',t('Requested by the app')).classes('field-help'):null).classes('buttons')).classes('credential-row','account-row').key(a.id));
   const missing=constrained?model.otherAccounts?t('You’re signed in on this browser, but not as the account {app} asked about.',{app}):t('The account {app} asked about is not signed in on this browser.',{app}):t('No account is signed in on this browser.');
   body=[origin,intro,...status,model.accountsLoading&&!model.accounts?h('p',t('Loading accounts on this browser…')).attrs({role:'status'}):null,
    rows.length?h('ul',...rows).classes('account-list').attrs({'aria-label':t('Accounts signed in on this browser')}):model.accounts?h('p',missing).classes('security-note'):null,
    rows.length?h('p',t('Nothing is shared until you continue. {app} learns only the result.',{app})).classes('muted'):null,
    h('h2',constrained?t('Not listed?'):rows.length?t('Use another account'):t('Sign in')),
    signIn(constrained?t('Sign in again'):rows.length?t('Sign in with another account'):t('Sign in'),t('Sign-in opens {host} in a new tab. If another account is already signed in there, use Add account. Then return to this window.',{host})),
    h('div',cancel).classes('buttons')];break;}
  case 'reauth':{const handle=model.reauth?.handle??'',current=model.accounts?.find(a=>a.id===model.reauth?.id);
   body=[origin,h('p',t('For your security, sign in again as {account}. {app} needs a sign-in from less than {duration} ago.',{account:account(handle),app,duration:duration(entry.maxAge,t)})),...status,
    signIn(t('Sign in again'),t('In the new tab, choose Add account and sign in again as {account}. Then return to this window.',{account:account(handle)})),
    h('div',current?approve(t('I’ve signed in again, continue'),()=>dispatch('continue',{owner:current.id})):null,cancel).classes('buttons')];break;}
  case 'consent':{const view=model.consent;
   body=[origin,h('p',t('Account: '),h('strong',account(model.selected.handle)).attrs({translate:'no'})),...status,
    h('p',t('Choose the values, resources and methods this app may access. You can revoke access later.')),...view.requests.map(kit.requestCard),
    h('div',approve(t('Allow selected access'),()=>dispatch('approve'),{disabled:kit.approvalBlocked(view),detail:'true'}),cancel).classes('buttons'),
    h('p',t('To use another account, cancel and start again from the application.')).classes('muted')];break;}
  case 'end-session':{const target=model.accounts?.[0];
   body=target?[origin,h('p',t('{app} asked to sign you out of {host} on this browser.',{app,host})),h('p',t('Other accounts on this browser and your other devices stay signed in. Apps keep the access you gave them until you revoke it.')).classes('security-note'),...status,
     h('div',approve(t('Sign out'),()=>dispatch('end-session',{confirmed:true})),plain(t('Stay signed in'),()=>dispatch('end-session',{confirmed:false}))).classes('buttons')]
    :[origin,model.accountsLoading?h('p',t('Loading accounts on this browser…')).attrs({role:'status'}):h('p',t('The account {app} asked about is not signed in on this browser. There is nothing to sign out.',{app})),...status,
     model.accounts?h('div',plain(t('Return to the app'),()=>dispatch('end-session',{confirmed:true}),'primary')).classes('buttons'):null];break;}
  default:body=[];
 }
 return h('main',h('p',t('Bindle · Your provider')).classes('logo'),h('h1',heading(model,t,host)).attrs({tabindex:'-1',id:'entry-title'}),...body,['choose','reauth','consent','end-session'].includes(model.phase)?live:null).classes('consent-page','entry-page').attrs({'aria-busy':busy?'true':'false','data-phase':model.phase});
}
/** Plain text for document.title (no bidi isolation characters, which some window titles render as boxes). */
export const entryTitle=(model,t,host)=>heading(model,t,host,{title:true});
