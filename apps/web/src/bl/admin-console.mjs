import { Action } from '../shared/stack.mjs';
import { AdminAction, current, update, wipe, failure } from './admin-access.mjs';
// Console operations (boot or administrator). Loaded lazily after access is
// confirmed. The server is the authority for every rule; the option helpers
// below only mirror it so the console never offers a change it would refuse.
export const ADMIN_ROLE='admin';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG=/^[a-z][a-z0-9-]{0,31}$/;
const list=value=>Array.isArray(value)?value.filter(item=>typeof item==='string'):typeof value==='string'&&value?[value]:[];
const role=(catalog,id)=>id===ADMIN_ROLE?{class:'internal',name:'Administrator',description:'Operates this host: reservations, claims, roles below administrator, badges and user lookup.',capabilities:[],builtin:true}:catalog?.roles?.[id]??null;
const badgeClassOf=(catalog,id)=>['internal','delegable','user'].includes(catalog?.badgeClasses?.[id])?catalog.badgeClasses[id]:'internal';
/** Role choices for a target. `target`: {internal, roles, self} (a reservation or
 * claim target is internal with no roles). Classes the target can never receive
 * are hidden unless already held, so they can still be removed. */
export function roleOptions(actor,catalog,target){
 const before=target.roles??[],holdsAdmin=before.includes(ADMIN_ROLE),ids=[ADMIN_ROLE,...Object.keys(catalog?.roles??{}).sort()];
 return ids.map(id=>{const r=role(catalog,id),selected=before.includes(id);if(!r)return null;if(r.class==='internal'&&target.internal!==true&&!selected)return null;
  let reason=null;
  if(r.class==='internal'&&target.internal!==true)reason='internal-only';
  else if(actor==='admin'){if(target.self)reason='self';else if(holdsAdmin)reason='admin-target';else if(id===ADMIN_ROLE)reason='boot-only';else if(r.class==='internal'&&r.delegable!==true&&!selected)reason='boot-only';}
  // Removing a stale or class-mismatched role is always allowed where editing is.
  if(reason==='internal-only'&&selected&&!(actor==='admin'&&(target.self||holdsAdmin)))reason=null;
  return {id,name:r.name,class:r.class,delegable:r.delegable===true,builtin:r.builtin===true,selected,disabled:Boolean(reason),reason};}).filter(Boolean);
}
export function badgeOptions(actor,catalog,badges,target){
 const before=target.badgeIds??[],holdsAdmin=(target.roles??[]).includes(ADMIN_ROLE);
 return (badges??[]).map(({id})=>{const cls=badgeClassOf(catalog,id),selected=before.includes(id);if(cls!=='user'&&target.internal!==true&&!selected)return null;
  let reason=null;if(cls!=='user'&&target.internal!==true)reason=selected?null:'internal-only';
  if(actor==='admin'){if(target.self)reason='self';else if(holdsAdmin)reason='admin-target';else if(cls==='internal'&&!selected)reason='boot-only';}
  return {id,class:cls,selected,disabled:Boolean(reason),reason};}).filter(Boolean);
}
/** What an administrator may edit in the catalog: user-class roles only. */
export const catalogEditable=(actor,roleValue)=>actor==='boot'||!roleValue||roleValue.class==='user';
export function auditDiff(before,after){
 const show=value=>{const text=JSON.stringify(value??null);return text.length>160?text.slice(0,157)+'…':text;};
 const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
 if(plain(before)&&plain(after)){const keys=[...new Set([...Object.keys(before),...Object.keys(after)])].sort();return keys.filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])).slice(0,12).map(key=>({key,before:Object.hasOwn(before,key)?show(before[key]):'—',after:Object.hasOwn(after,key)?show(after[key]):'—'}));}
 if(before==null&&after==null)return [];
 return [{key:'',before:before==null?'—':show(before),after:after==null?'—':show(after)}];
}
const actor=r=>current(r).mode;
const catalogOf=r=>current(r).overview?.catalog??{version:1,capabilities:{},roles:{},badgeClasses:{}};
const clone=value=>JSON.parse(JSON.stringify(value));
function confirmFirst(r,ctx,detail,{title,body,confirmLabel,subject}){if(detail.confirmed===true)return false;r.browser.rememberFocus();update(r,ctx,{modal:{kind:'confirm',title,body,confirmLabel,subject:subject??null,intent:{...detail,confirmed:true}}});r.browser.focus('.admin-modal [data-autofocus]');return true;}
async function openStepUp(r,ctx,retry){
 const boot=actor(r)==='boot';let methods;
 if(boot){const result=await r.api.call('boot','/api/admin/boot/login/begin',{});r.browser.storeSecret('stepUp',result.passkey?{challengeId:result.challengeId,options:result.authenticationOptions}:null);methods={password:result.password===true,passkey:result.passkey===true};}
 else{const result=await r.api.call('admin','/api/admin/step-up/begin',{});r.browser.storeSecret('stepUp',result.passkey?{options:result.authenticationOptions}:null);methods={password:false,passkey:result.passkey===true};}
 if(!current(r).modal)r.browser.rememberFocus();
 update(r,ctx,{modal:{kind:'step-up',methods,retry:retry??null,error:null},error:null});r.browser.focus('.admin-modal [data-autofocus]');
}
/** Every operation: a step-up demand opens the modal and the operation is
 * retried once after a successful confirmation. */
class ConsoleAction extends AdminAction {
 async failed(r,ctx,error){
  if(error?.code==='step_up_required'){await openStepUp(r,ctx,this.retryable===false?null:{...this.detail,kind:this.detail.kind??this.constructor.intent}).catch(next=>this.report(r,ctx,next));return;}
  await this.report(r,ctx,error);
 }
 async report(r,ctx,error){const code=error?.code??'unexpected_response';await this.clear(r,ctx,code);update(r,ctx,{error:{code}});if(code==='conflict')await refreshOverview(r,ctx).catch(()=>{});}
 async clear(){}
}
async function refreshOverview(r,ctx){const overview=await r.api.call(actor(r),'/api/admin/overview',{});update(r,ctx,{overview:sanitizeOverview(overview)});}
function sanitizeOverview(value){if(!value||typeof value!=='object'||!value.catalog||!value.reservations)throw failure('unexpected_response');return value;}
export class EnterConsole extends ConsoleAction {static intent='reload-overview';async perform(r,ctx){update(r,ctx,{consoleReady:true});await refreshOverview(r,ctx);r.browser.focus('#admin-heading');}async clear(r,ctx){update(r,ctx,{overview:null});}}
export class LoadOverview extends ConsoleAction {static intent='reload-overview';async perform(r,ctx){await refreshOverview(r,ctx);}async clear(r,ctx){update(r,ctx,{overview:null});}}
export class Navigate extends Action {
 static deps={state:{write:true},api:{},browser:{}};constructor(detail){super();this.detail=detail;}
 execute(r,ctx){const view=this.detail.view;if(!['overview','reservations','claims','roles','users','audit'].includes(view)||current(r).busy)return;
  // A revealed claim link is shown once: leaving the screen drops it.
  update(r,ctx,{view,reveal:view==='claims'&&current(r).view==='claims'?current(r).reveal:null,error:null,notice:''});r.browser.focus('#admin-heading');
  if(view==='audit'&&!current(r).audit)ctx.engineFeed.dispatchEvent(new CustomEvent('admin-retry',{detail:{kind:'load-audit'}}));
  if(!current(r).overview)ctx.engineFeed.dispatchEvent(new CustomEvent('admin-retry',{detail:{kind:'reload-overview'}}));}
}
export class CloseModal extends Action {
 static deps={state:{write:true},browser:{}};
 execute(r,ctx){const modal=current(r).modal;if(!modal)return;r.browser.storeSecret('stepUp',null);update(r,ctx,{modal:null,...modal.kind==='step-up'&&modal.retry?{notice:'step-up-cancelled'}:{}});r.browser.restoreFocus();}
}
export class OpenEditor extends Action {
 static deps={state:{write:true},browser:{}};constructor(detail){super();this.detail=detail;}
 execute(r,ctx){const kind=this.detail.editor;if(!['role','capability'].includes(kind))return;if(kind==='capability'&&current(r).mode!=='boot')return;r.browser.rememberFocus();update(r,ctx,{modal:{kind,id:typeof this.detail.id==='string'?this.detail.id:null,error:null},error:null});r.browser.focus('.admin-modal [data-autofocus]');}
}
export class StepUpConfirm extends AdminAction {
 async perform(r,ctx,detail){
  const modal=current(r).modal;if(modal?.kind!=='step-up')return;const boot=actor(r)==='boot',secret=r.browser.secret('stepUp');let body;
  if(detail.method==='password'&&boot){const password=detail.values?.password;if(typeof password!=='string'||!password){update(r,ctx,{modal:{...modal,error:{code:'password_required'}}});return;}body={method:'password',password};}
  else{if(!secret){update(r,ctx,{modal:{...modal,error:{code:'passkey_unavailable'}}});return;}let response;try{response=await r.browser.authenticatePasskey(secret.options);}catch(error){update(r,ctx,{modal:{...current(r).modal,error:{code:error.code??'passkey_cancelled'}}});return;}body=boot?{method:'passkey',challengeId:secret.challengeId,response}:{method:'passkey',response};}
  let result;
  try{result=await r.api.call(actor(r),boot?'/api/admin/boot/step-up':'/api/admin/step-up',body);}
  catch(error){
   // A wrong credential is not a lost session; re-arm a fresh challenge. If the
   // session really ended, the next request reports it and the console is wiped.
   if(['unauthorized','passkey_required','rate_limited','invalid_method'].includes(error?.code)){if(current(r).modal?.kind==='step-up'){await openStepUp(r,ctx,modal.retry);update(r,ctx,{modal:{...current(r).modal,error:{code:error.code==='unauthorized'?'step_up_failed':error.code}}});}return;}
   throw error;}
  r.browser.storeSecret('stepUp',null);
  if(boot&&current(r).boot&&Number.isSafeInteger(result?.stepUpUntil))update(r,ctx,{boot:{...current(r).boot,stepUpUntil:result.stepUpUntil}});
  update(r,ctx,{modal:null,stepUpAt:r.browser.now()});r.browser.restoreFocus();
  if(modal.retry)ctx.engineFeed.dispatchEvent(new CustomEvent('admin-retry',{detail:modal.retry}));
 }
 async failed(r,ctx,error){update(r,ctx,{modal:current(r).modal?{...current(r).modal,error:{code:error?.code??'unexpected_response'}}:null});}
}
// ---- reservations ----
export class Reserve extends ConsoleAction {
 async perform(r,ctx,detail){const values=detail.values??{},name=String(values.name??'').trim().toLowerCase();if(!name)throw failure('invalid_handle');
  const body={name,roles:list(values.roles),badgeIds:list(values.badgeIds)};const result=await this.call(r,'/api/admin/reservations/set',body);await refreshOverview(r,ctx);update(r,ctx,{notice:'reserved',noticeSubject:result.reservation?.name??name});}
}
export class Unreserve extends ConsoleAction {
 async perform(r,ctx,detail){if(confirmFirst(r,ctx,detail,{title:'Release this reservation?',body:'The handle becomes available to anyone again. Assigned handles and handles with outstanding claims are never released.',confirmLabel:'Release reservation',subject:detail.name}))return;update(r,ctx,{modal:null});await this.call(r,'/api/admin/reservations/remove',{name:detail.name});await refreshOverview(r,ctx);update(r,ctx,{notice:'unreserved',noticeSubject:detail.name});r.browser.restoreFocus();}
}
// ---- claims ----
export class MintClaim extends ConsoleAction {
 async perform(r,ctx,detail){const values=detail.values??{},name=String(values.name??'').trim().toLowerCase(),hours=Number(values.hours||24);if(!name)throw failure('invalid_handle');if(!Number.isInteger(hours)||hours<1||hours>168)throw failure('invalid_request');
  const body={name,hours};if(values.customize==='on'){body.roles=list(values.roles);body.badgeIds=list(values.badgeIds);}
  const grantsAdmin=(body.roles??current(r).overview?.reservations?.runtime?.find(item=>item.name===name)?.roles??[]).includes(ADMIN_ROLE);
  if(grantsAdmin&&confirmFirst(r,ctx,detail,{title:'Mint an administrator claim?',body:'Whoever opens this link can create an account with full administrator authority. Only send it to the intended person over a trusted channel.',confirmLabel:'Mint administrator claim',subject:name}))return;
  update(r,ctx,{modal:null,reveal:null});const result=await this.call(r,'/api/admin/claims/mint',body);const defaults=current(r).overview?.reservations?.runtime?.find(item=>item.name===name);this.reveal(r,ctx,{...result,roles:body.roles??defaults?.roles??[],badgeIds:body.badgeIds??defaults?.badgeIds??[]});await refreshOverview(r,ctx).catch(()=>{});
 }
 reveal(r,ctx,result){if(typeof result?.link!=='string'||!result.link.startsWith(r.browser.origin()+'/token-onboarding#token='))throw failure('unexpected_response');const claim=current(r).overview?.claims?.find(item=>item.nonce===result.nonce);update(r,ctx,{view:'claims',reveal:{name:result.name,nonce:result.nonce,link:result.link,expiresAt:result.expiresAt,roles:result.roles??claim?.roles??[],badgeIds:result.badgeIds??claim?.badgeIds??[],copied:false}});r.browser.focus('#claim-reveal-heading');}
 async clear(r,ctx){update(r,ctx,{reveal:null});}
}
export class ClaimLink extends MintClaim {
 async perform(r,ctx,detail){if(!UUID.test(detail.nonce??''))throw failure('invalid_request');update(r,ctx,{reveal:null});this.reveal(r,ctx,await this.call(r,'/api/admin/claims/link',{nonce:detail.nonce}));}
}
export class RevokeClaim extends ConsoleAction {
 async perform(r,ctx,detail){if(!UUID.test(detail.nonce??''))throw failure('invalid_request');if(confirmFirst(r,ctx,detail,{title:'Revoke this claim token?',body:'The link stops working immediately. This cannot be undone; mint a new claim if the person still needs one.',confirmLabel:'Revoke claim',subject:detail.name}))return;update(r,ctx,{modal:null,reveal:current(r).reveal?.nonce===detail.nonce?null:current(r).reveal});await this.call(r,'/api/admin/claims/revoke',{nonce:detail.nonce});await refreshOverview(r,ctx);update(r,ctx,{notice:'revoked',noticeSubject:detail.name??''});r.browser.restoreFocus();}
}
export class CopyReveal extends Action {static deps={state:{write:true},browser:{}};async execute(r,ctx){const reveal=current(r).reveal;if(!reveal)return;try{await r.browser.copy(reveal.link);update(r,ctx,{reveal:{...current(r).reveal,copied:true}});}catch{update(r,ctx,{error:{code:'copy_failed'}});}}}
export class DismissReveal extends Action {static deps={state:{write:true},browser:{}};execute(r,ctx){update(r,ctx,{reveal:null});r.browser.focus('#admin-heading');}}
// ---- catalog ----
async function saveCatalog(action,r,ctx,next){const revision=current(r).overview?.catalogRevision??null;await action.call(r,'/api/admin/catalog',{catalog:next,expectedRevision:revision});update(r,ctx,{modal:null});await refreshOverview(r,ctx);update(r,ctx,{notice:'catalog-saved'});r.browser.restoreFocus();}
class CatalogAction extends ConsoleAction {async report(r,ctx,error){const modal=current(r).modal;if(modal&&['role','capability'].includes(modal.kind)&&error?.code!=='conflict'){update(r,ctx,{modal:{...modal,error:{code:error?.code??'unexpected_response'}}});return;}update(r,ctx,{modal:null});await super.report(r,ctx,error);}}
export class SaveRole extends CatalogAction {
 async perform(r,ctx,detail){const values=detail.values??{},existing=typeof detail.existing==='string'?detail.existing:null,id=existing??String(values.id??'').trim(),catalog=catalogOf(r),old=existing?catalog.roles[existing]:null;
  if(!SLUG.test(id)||id===ADMIN_ROLE)throw failure('invalid_role_catalog');if(!existing&&catalog.roles[id])throw failure('role_exists');if(!catalogEditable(actor(r),old))throw failure('classification_boot_only');
  const cls=actor(r)==='boot'&&values.class==='internal'?'internal':'user',value={class:cls,name:String(values.name??'').trim(),description:String(values.description??'').trim(),capabilities:list(values.capabilities).sort()};
  if(cls==='internal'&&values.delegable==='on')value.delegable=true;const next=clone(catalog);next.roles[id]=value;await saveCatalog(this,r,ctx,next);}
}
export class DeleteRole extends CatalogAction {
 async perform(r,ctx,detail){const catalog=catalogOf(r),old=catalog.roles[detail.id];if(!old)throw failure('unknown_role');if(!catalogEditable(actor(r),old))throw failure('classification_boot_only');if(confirmFirst(r,ctx,detail,{title:'Delete this role?',body:'Holders lose its capabilities immediately. Their stored role entry stays but grants nothing.',confirmLabel:'Delete role',subject:detail.id}))return;const next=clone(catalog);delete next.roles[detail.id];await saveCatalog(this,r,ctx,next);}
}
export class SaveCapability extends CatalogAction {
 async perform(r,ctx,detail){if(actor(r)!=='boot')throw failure('classification_boot_only');const values=detail.values??{},id=String(values.id??'').trim(),catalog=catalogOf(r);if(catalog.capabilities[id])throw failure('capability_exists');const next=clone(catalog);next.capabilities[id]={class:values.class==='user'?'user':'internal',description:String(values.description??'').trim()};await saveCatalog(this,r,ctx,next);}
}
export class DeleteCapability extends CatalogAction {
 async perform(r,ctx,detail){if(actor(r)!=='boot')throw failure('classification_boot_only');const catalog=catalogOf(r);if(!catalog.capabilities[detail.id])throw failure('invalid_role_catalog');if(confirmFirst(r,ctx,detail,{title:'Delete this capability?',body:'It is removed from every role that lists it, and holders lose it immediately.',confirmLabel:'Delete capability',subject:detail.id}))return;const next=clone(catalog);delete next.capabilities[detail.id];for(const value of Object.values(next.roles))value.capabilities=value.capabilities.filter(cap=>cap!==detail.id);await saveCatalog(this,r,ctx,next);}
}
export class SetCapabilityClass extends CatalogAction {
 async perform(r,ctx,detail){if(actor(r)!=='boot')throw failure('classification_boot_only');const catalog=catalogOf(r),cap=catalog.capabilities[detail.id];if(!cap||!['internal','user'].includes(detail.values?.class))throw failure('invalid_role_catalog');if(cap.class===detail.values.class)return;const next=clone(catalog);next.capabilities[detail.id].class=detail.values.class;
  // A user-class role may hold only user-class capabilities: reclassifying one
  // to internal removes it from user-class roles rather than failing validation.
  if(detail.values.class==='internal'){const affected=Object.entries(next.roles).filter(([,value])=>value.class==='user'&&value.capabilities.includes(detail.id)).map(([id])=>id);if(affected.length&&confirmFirst(r,ctx,detail,{title:'Make this capability internal?',body:'It is removed from user-class roles that list it, and ordinary holders lose it immediately.',confirmLabel:'Make internal',subject:detail.id}))return;for(const value of Object.values(next.roles))if(value.class==='user')value.capabilities=value.capabilities.filter(cap=>cap!==detail.id);}
  await saveCatalog(this,r,ctx,next);}
}
export class SaveBadgeClasses extends CatalogAction {
 async perform(r,ctx,detail){if(actor(r)!=='boot')throw failure('classification_boot_only');const catalog=catalogOf(r),next=clone(catalog);for(const {id} of current(r).overview?.badges??[]){const value=detail.values?.['badge-'+id];if(['internal','delegable','user'].includes(value))next.badgeClasses[id]=value;}await saveCatalog(this,r,ctx,next);}
}
// ---- users ----
export class Lookup extends ConsoleAction {
 async perform(r,ctx,detail){const by=['handle','owner','email'].includes(detail.values?.by)?detail.values.by:'handle',query=String(detail.values?.query??'').trim();update(r,ctx,{user:null,lookupQuery:null});
  if(!query||query.length>254)throw failure('invalid_request');if(by==='owner'&&!UUID.test(query.toLowerCase()))throw failure('invalid_owner');if(by==='email'&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(query))throw failure('invalid_email');
  const result=await this.call(r,'/api/admin/users/lookup',{[by]:by==='owner'?query.toLowerCase():query});update(r,ctx,{user:result.user??null,lookupQuery:{by,found:Boolean(result.user)}});r.browser.focus('#lookup-result');}
 async clear(r,ctx){update(r,ctx,{user:null,lookupQuery:null});}
}
class UserAction extends ConsoleAction {
 async done(r,ctx,result,notice){if(!result?.user?.id)throw failure('unexpected_response');update(r,ctx,{user:result.user,modal:null,notice});r.browser.restoreFocus();}
 async report(r,ctx,error){update(r,ctx,{modal:null});await super.report(r,ctx,error);if(error?.code==='conflict'&&current(r).user?.id)await this.reload(r,ctx).catch(()=>{});}
 async reload(r,ctx){const id=current(r).user?.id;if(!id)return;const result=await this.call(r,'/api/admin/users/lookup',{owner:id});update(r,ctx,{user:result.user??null});}
}
export class SetRoles extends UserAction {
 async perform(r,ctx,detail){const user=current(r).user;if(!user||user.id!==detail.owner)throw failure('invalid_request');const roles=list(detail.values?.roles).sort(),changesAdmin=roles.includes(ADMIN_ROLE)!==user.roles.includes(ADMIN_ROLE);
  if(changesAdmin&&confirmFirst(r,ctx,{...detail,values:{roles}},{title:roles.includes(ADMIN_ROLE)?'Grant administrator authority?':'Revoke administrator authority?',body:roles.includes(ADMIN_ROLE)?'This account will be able to reserve handles, mint claims, edit user-class roles and manage ordinary accounts.':'This account loses administrator authority immediately.',confirmLabel:roles.includes(ADMIN_ROLE)?'Grant administrator':'Revoke administrator',subject:user.handle}))return;
  await this.done(r,ctx,await this.call(r,'/api/admin/users/roles',{owner:user.id,roles,expectedRevision:user.principalRevision}),'roles-saved');}
}
export class SetBadges extends UserAction {
 async perform(r,ctx,detail){const user=current(r).user;if(!user||user.id!==detail.owner)throw failure('invalid_request');const badgeIds=list(detail.values?.badgeIds);if(badgeIds.length>4)throw failure('invalid_badges');await this.done(r,ctx,await this.call(r,'/api/admin/users/badges',{owner:user.id,badgeIds}),'badges-saved');}
}
export class Suspend extends UserAction {
 async perform(r,ctx,detail){const user=current(r).user;if(!user||user.id!==detail.owner)throw failure('invalid_request');if(confirmFirst(r,ctx,detail,{title:'Suspend this account?',body:'All of its sessions end now and it cannot sign in until an administrator or boot reactivates it.',confirmLabel:'Suspend account',subject:user.handle}))return;await this.done(r,ctx,await this.call(r,'/api/admin/users/suspend',{owner:user.id}),'suspended');}
}
export class Reactivate extends UserAction {
 async perform(r,ctx,detail){const user=current(r).user;if(!user||user.id!==detail.owner)throw failure('invalid_request');if(confirmFirst(r,ctx,detail,{title:'Reactivate this account?',body:'The account can sign in again. Only an administrator suspension is lifted; other account states are unchanged.',confirmLabel:'Reactivate account',subject:user.handle}))return;await this.done(r,ctx,await this.call(r,'/api/admin/users/reactivate',{owner:user.id}),'reactivated');}
}
export class LoadPrincipals extends ConsoleAction {
 static intent='load-principals';
 async perform(r,ctx,detail){const startAfter=typeof detail.startAfter==='string'&&UUID.test(detail.startAfter)?detail.startAfter:'';const result=await this.call(r,'/api/admin/principals',startAfter?{startAfter}:{});const previous=current(r).principals;update(r,ctx,{principals:{rows:Array.isArray(result.principals)?result.principals.slice(0,50):[],next:typeof result.next==='string'?result.next:null,cursor:startAfter,trail:startAfter?[...(previous?.trail??[]),previous?.cursor??''].slice(-50):[]}});}
 async clear(r,ctx){update(r,ctx,{principals:null});}
}
export class PrincipalsBack extends LoadPrincipals {async perform(r,ctx){const trail=current(r).principals?.trail??[];const cursor=trail.at(-1)??'';const result=await this.call(r,'/api/admin/principals',cursor?{startAfter:cursor}:{});update(r,ctx,{principals:{rows:result.principals??[],next:result.next??null,cursor,trail:trail.slice(0,-1)}});}}
// ---- audit ----
export class LoadAudit extends ConsoleAction {
 static intent='load-audit';
 async perform(r,ctx,detail){const body={};if(Number.isSafeInteger(detail.fromSeq)&&detail.fromSeq>=1)body.fromSeq=detail.fromSeq;if(detail.verify===true)body.verify=true;update(r,ctx,{audit:current(r).audit?{...current(r).audit,loading:true}:null});
  const result=await this.call(r,'/api/admin/audit',body);if(!Array.isArray(result.entries)||!result.verified)throw failure('unexpected_response');
  update(r,ctx,{audit:{entries:result.entries,head:result.head,verified:{valid:result.verified.valid===true,seq:result.verified.seq},fromSeq:body.fromSeq??null,full:body.verify===true,checkedAt:r.browser.now()}});}
 async clear(r,ctx){update(r,ctx,{audit:null});}
}
// ---- boot ----
export class EndBoot extends ConsoleAction {
 async perform(r,ctx,detail){if(actor(r)!=='boot')return;if(confirmFirst(r,ctx,detail,{title:'End boot access now?',body:'Boot is signed out everywhere and cannot sign in again. Only minting a new token and redeploying its digest restores boot. Administrators, roles and claims are unaffected.',confirmLabel:'End boot access',subject:null}))return;update(r,ctx,{modal:null});await this.call(r,'/api/admin/boot/end',{confirm:'end-boot-access'});wipe(r,ctx,{phase:'boot-ended'});}
}
export const constructors={
 navigate:Navigate,'close-modal':CloseModal,'open-editor':OpenEditor,'step-up-confirm':StepUpConfirm,'reload-overview':LoadOverview,
 reserve:Reserve,unreserve:Unreserve,'mint-claim':MintClaim,'claim-link':ClaimLink,'revoke-claim':RevokeClaim,'copy-reveal':CopyReveal,'dismiss-reveal':DismissReveal,
 'save-role':SaveRole,'delete-role':DeleteRole,'save-capability':SaveCapability,'delete-capability':DeleteCapability,'set-capability-class':SetCapabilityClass,'save-badge-classes':SaveBadgeClasses,
 lookup:Lookup,'set-roles':SetRoles,'set-badges':SetBadges,suspend:Suspend,reactivate:Reactivate,'load-principals':LoadPrincipals,'principals-back':PrincipalsBack,
 'load-audit':LoadAudit,'end-boot':EndBoot
};
