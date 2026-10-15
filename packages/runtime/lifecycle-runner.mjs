import {AccountLifecycle} from './account-lifecycle.mjs';
import {dispatchLifecycleNotice} from '../messaging/dispatcher.mjs';
import {key} from '../messaging/store.mjs';
import {accountRemovalProtection,rememberEverPaid,everPaidEvent} from '../identity/lifecycle-protection.mjs';
import {everPaidReview} from './lifecycle-finance.mjs';
import {APP_NOTIFICATIONS} from '../federation/app-notifications.mjs';
import {PURGE_KEY,COLD_KEY,TOMBSTONE_KEY,coldJob,coldBatch,purgeBatch,externalResourcesPresent,purgeEligibleInTransaction} from './lifecycle-storage.mjs';

// Wires AccountLifecycle into an AccountController (Worker Durable Object or
// Node SQLite account). Everything is behind LIFECYCLE_ENABLED (default off).
// LIFECYCLE_DRY_RUN defaults to true: dry run arms the inactivity clock and
// records owner activity (non-destructive bookkeeping) but never sends,
// fences access, changes phase, tiers storage or deletes. Live mode needs
// LIFECYCLE_DRY_RUN="false"; irreversible purge additionally needs
// LIFECYCLE_PURGE_ENABLED="true".
const DAY=86400000,STATE_KEY='lifecycle/state-v1',LIVE_KEY='lifecycle/live-v1',RECENT_SESSION_MS=900000,LIVE_GAP_MS=8*DAY;
const BLOCKED=new Set(['suspended','purge-review','purging']);
const KNOWN=new Set(['active','warning',...BLOCKED]);
// Restricted operations that stay available while suspended: status, explicit
// reactivation, billing reconciliation/payment (paid protection lifts the
// suspension), public key lookup for previously signed material, and email
// unsubscribe. Every other account API, app RPC, ingress and mutation is denied.
const SUSPENDED_ALLOWED=new Set(['lifecycleStatus','lifecycleReactivate','lifecycleTick','billingRefresh','billingStatus','billingCheckout','billingChangePlan','billingCancelChange','billingWebhookVerified','lifecycleEverPaid','setupBillingStatus','paidHandleEligibility','identitySigningKey','identityKeychain','unsubscribe']);
const PURGING_ALLOWED=new Set(['lifecycleStatus','lifecycleTick','billingRefresh','billingStatus','billingWebhookVerified','lifecycleEverPaid','identitySigningKey']);
const ACTIVITY={touch:'owner-return',federationRPC:'resource-use',mcpOperation:'resource-use'};

// Infrequent Access pays only for objects large enough to recover its costs (checked 2026-10-14):
// saving 0.005 USD/GB-month (0.015 Standard - 0.010 IA, 30-day minimum) must exceed one IA
// write (9 USD/M) plus the source read (0.36 USD/M), i.e. about 1.9 MB for one month, and any
// read after reactivation pays 0.01 USD/GB retrieval. 4 MiB leaves margin; smaller objects stay
// Standard and are protected by the suspension fence, not the storage tier.
export const COLD_MIN_BYTES=4194304;
const integer=(value,fallback,min,max)=>{const parsed=value===undefined||value===''?fallback:Number(value);return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;};
/** 'off' | 'dry-run' | 'live'. Anything but an exact "true" is off; anything but an exact "false" dry run is dry run. */
export function lifecycleMode(config={}){if(config.LIFECYCLE_ENABLED!=='true'&&config.LIFECYCLE_ENABLED!==true)return 'off';return config.LIFECYCLE_DRY_RUN==='false'||config.LIFECYCLE_DRY_RUN===false?'live':'dry-run';}
export function lifecycleSettings(config={}){
 const mode=lifecycleMode(config),live=mode==='live';
 return {mode,purge:live&&config.LIFECYCLE_PURGE_ENABLED==='true',cold:live&&config.LIFECYCLE_COLD_STORAGE==='true',coldSupported:config.LIFECYCLE_COLD_STORAGE_SUPPORTED===true,coldMinBytes:integer(config.LIFECYCLE_COLD_MIN_BYTES,COLD_MIN_BYTES,0,1073741824),coldBudget:integer(config.LIFECYCLE_COLD_BATCH,16,1,256),purgeBudget:integer(config.LIFECYCLE_PURGE_BATCH,64,1,512),finance:config.LIFECYCLE_FINANCE_REVIEW==='local-only'&&!(live&&config.LIFECYCLE_PURGE_ENABLED==='true')?'local-only':'polar'};
}
/** Structured operator log; never includes email, push endpoints, tokens or message content. */
export function lifecycleLog(config,event){const sink=typeof config.LIFECYCLE_LOG==='function'?config.LIFECYCLE_LOG:value=>console.log(JSON.stringify(value));try{sink({event:'account-lifecycle',...event});}catch{}}
const clockOf=c=>typeof c.config.LIFECYCLE_CLOCK==='function'?c.config.LIFECYCLE_CLOCK:Date.now;
function revision(text){let a=0x811c9dc5,b=0x01000193;for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);a=Math.imul(a^code,16777619)>>>0;b=Math.imul(b^code,2246822507)>>>0;}return `c1-${text.length}-${a.toString(16)}-${b.toString(16)}`;}
async function pushSubscriptions(reader,owner){return [...(await reader.list({prefix:key('push-subscription',owner)})).values()].filter(row=>row?.owner===owner&&typeof row.endpoint==='string');}

function lifecycleOf(c){
 if(c.lifecycle)return c.lifecycle;
 const settings=lifecycleSettings(c.config),clock=clockOf(c),config=c.config;
 c.lifecycle=new AccountLifecycle({metadata:c.metadata,gate:c.gate,config,clock,purge:settings.purge,
  // A channel is ready only if a configured transport can actually reach it.
  contact:async(tx,owner)=>{const identity=c.lifecycleContact?.owner===owner?c.lifecycleContact:null,email=config.LIFECYCLE_MAIL?.sendAccountNotice&&identity?.verifiedEmail?identity.verifiedEmail:null,subscriptions=config.LIFECYCLE_PUSH?.send?await pushSubscriptions(tx,owner):[];
   return {verified:Boolean(email||subscriptions.length),available:Boolean(email||subscriptions.length),revision:revision(`${email??''}|${identity?.emailVerifiedAt??''}|${subscriptions.map(row=>row.id).sort().join(',')}`)};},
  reviewFinance:async({owner,context,generation,activityEpoch})=>{
   const now=clock();
   // Purge always requires this live lookup to succeed; failure or ambiguity throws and the step holds.
   if(settings.finance!=='local-only'){const review=await everPaidReview({billing:c.billing,config,owner,metadata:c.metadata,now});if(review.everPaid)return {owner,context,generation,activityEpoch,neverPaid:false,checkedAt:now,expiresAt:now+60000};}
   return {owner,context,generation,activityEpoch,neverPaid:true,checkedAt:now,expiresAt:now+60000};
  },
  sendNotice:async delivery=>{const identity=c.lifecycleContact?.owner===delivery.owner?c.lifecycleContact:null;return dispatchLifecycleNotice({push:config.LIFECYCLE_PUSH,mail:config.LIFECYCLE_MAIL,owner:delivery.owner,phase:delivery.phase,deletion:settings.purge,days:delivery.deadlineDays,attemptId:delivery.attemptId,email:identity?.verifiedEmail??null,subscriptions:config.LIFECYCLE_PUSH?.send?await pushSubscriptions(c.metadata,delivery.owner):[]});},
  // The HTTP layer verified the owner session and CSRF; reactivation needs a recent sign-in.
  authorizeReactivation:async({owner,authority,generation,capabilityEpoch,context})=>{const now=clock();if(authority?.kind!=='owner-session'||authority.owner!==owner||!Number.isSafeInteger(authority.authenticatedAt)||authority.authenticatedAt>now||now-authority.authenticatedAt>RECENT_SESSION_MS)return null;return {owner,context,generation,capabilityEpoch,verifiedAt:now,expiresAt:now+60000};},
  adminHold:async owner=>{if(typeof config.LIFECYCLE_ADMIN_HOLD!=='function')throw new Error('Administrator hold port unavailable');return config.LIFECYCLE_ADMIN_HOLD(owner);},
  purgeEligible:async tx=>c.lifecycleExternalChecked===true&&purgeEligibleInTransaction(tx)});
 return c.lifecycle;
}
const fault=(code,message,status)=>({code,message,status});

/** Request-path enforcement, before any account method runs. Live mode only. */
export async function lifecycleBlocked(c,method){
 // A deletion tombstone is final in every mode, including after the flag is turned off.
 if(await c.metadata.get(TOMBSTONE_KEY)!==undefined)return method==='lifecycleStatus'||method==='lifecycleTick'?null:fault('account_deleted','This account was deleted after its final notice period.',410);
 if(lifecycleMode(c.config)!=='live')return null;
 let state=await c.metadata.get(STATE_KEY);if(state===undefined)return null;
 // Payment lifts suspension immediately rather than at the next scheduled tick.
 if(state&&['suspended','purge-review'].includes(state.phase)&&!SUSPENDED_ALLOWED.has(method)&&state.owner&&(await c.metadata.transaction(tx=>accountRemovalProtection(tx,state.owner,{config:c.config,now:clockOf(c)()}))).status==='paid-protected'){await lifecycleOf(c).step(state.owner);state=await c.metadata.get(STATE_KEY);}
 if(!state||!KNOWN.has(state.phase))return SUSPENDED_ALLOWED.has(method)?null:fault('lifecycle_unavailable','Account status requires review.',503);
 if(state.phase==='purging')return PURGING_ALLOWED.has(method)?null:fault('account_deleting','Account deletion has begun.',410);
 if(BLOCKED.has(state.phase)&&!SUSPENDED_ALLOWED.has(method))return fault('account_suspended','This account is suspended. Sign in and confirm you are still using it to reactivate.',423);
 return null;
}
export function lifecycleGated(method){return method.startsWith('lifecycle');}

async function armIfNeeded(c,lifecycle,owner,identity){
 const status=await lifecycle.status(owner);if(status.armed)return status;
 if(identity?.status!=='active')return status;
 const now=clockOf(c)(),createdAt=Number.isSafeInteger(identity.createdAt)&&identity.createdAt<=now?identity.createdAt:now;
 // Activation time is when the executor first observes an active identity: never earlier than reality.
 // Accounts that existed for more than a day before arming are treated as established (365-day clock).
 return lifecycle.recordActivation(owner,{createdAt,activatedAt:now,established:now-createdAt>=DAY});
}

/** Records qualifying owner/app activity after a successful account operation, outside the account gate. */
export async function lifecycleActivity(c,method,args=[]){
 if(method==='billingWebhookVerified'&&lifecycleMode(c.config)==='live'){try{await c.scheduleAlarm(Date.now()+1000);}catch{}return;}
 const source=ACTIVITY[method];if(!source||lifecycleMode(c.config)==='off')return;
 // App RPC counts as resource use; an app sending a notification into the account is inbound, not use.
 if(method==='federationRPC'&&(args[0]?.contract===APP_NOTIFICATIONS||typeof args[0]?.subject!=='string'))return;
 const owner=method==='federationRPC'?/\/entities\/([a-f0-9-]{36})$/.exec(args[0].subject)?.[1]:args[0];if(typeof owner!=='string')return;
 const now=clockOf(c)();if(c.lifecycleActivityAt&&now-c.lifecycleActivityAt<300000)return;
 try{
  if(await c.metadata.get(TOMBSTONE_KEY)!==undefined||await c.metadata.get('owner')!==owner)return;
  const lifecycle=lifecycleOf(c);let status=await lifecycle.status(owner);
  if(!status.armed){const identity=await c.config.LIFECYCLE_IDENTITY?.get(owner);status=await armIfNeeded(c,lifecycle,owner,identity);if(!status.armed)return;}
  if(BLOCKED.has(status.phase))return;
  const after=await lifecycle.recordActivity(owner,{source});if(after.established)c.lifecycleActivityAt=now;
 }catch(error){lifecycleLog(c.config,{action:'activity-error',owner,code:error?.code||'unavailable'});}
}

async function consumeEffects(c,lifecycle,owner){
 const settings=lifecycleSettings(c.config);
 for(const [path,effect]of await c.metadata.list({prefix:'lifecycle/effect/',limit:16})){
  if(effect?.owner===owner){
   if(effect.kind==='freeze'&&settings.cold){const access=await lifecycle.access(owner);if(access.blocked&&access.generation===effect.generation)await c.metadata.put(COLD_KEY,coldJob(effect.generation));}
   if(effect.kind==='thaw')await c.metadata.delete(COLD_KEY);
  }
  await c.metadata.delete(path);
 }
}

/** One bounded lifecycle tick for this account (alarm, cron sweep or reactivation). */
export async function lifecycleTick(c,{source='alarm'}={}){
 const settings=lifecycleSettings(c.config),mode=settings.mode,log=event=>lifecycleLog(c.config,{mode,source,...event});
 if(await c.metadata.get(TOMBSTONE_KEY)!==undefined)return {mode,action:'deleted'};
 if(mode==='off')return {mode};
 const owner=await c.metadata.get('owner');if(!owner)return {mode,action:'unmaterialized'};
 const clock=clockOf(c),lifecycle=lifecycleOf(c);
 let identity;try{identity=await c.config.LIFECYCLE_IDENTITY?.get(owner);}catch{identity=undefined;}
 if(identity===undefined){log({owner,action:'hold',reason:'identity-unavailable'});await c.scheduleAlarm(clock()+DAY);return {mode,action:'hold',reason:'identity-unavailable'};}
 c.lifecycleContact=identity?{owner,verifiedEmail:identity.verifiedEmail,emailVerifiedAt:identity.emailVerifiedAt}:null;
 let result;
 try{
  const armed=await armIfNeeded(c,lifecycle,owner,identity);if(!armed.armed){return {mode,action:'unarmed',identityStatus:identity?.status??null};}
  if(mode==='dry-run'){
   result=await lifecycle.plan(owner);log({owner,action:'planned',planned:result.action,phase:result.phase,reason:result.reason,deadlineDays:result.deadlineDays});
   await c.scheduleAlarm(Math.max(clock()+3600000,result.action==='wait'&&result.nextWakeAt?result.nextWakeAt:clock()+DAY));return {mode,...result,planned:result.action,action:'planned'};
  }
  // Deadlines from a period without live enforcement never authorise suspension or deletion.
  const live=await c.metadata.get(LIVE_KEY),now0=clock();
  if(!Number.isSafeInteger(live?.at)||live.at>now0||now0-live.at>LIVE_GAP_MS){const restarted=await lifecycle.restartAfterGap(owner);if(restarted.action==='restarted')log({owner,action:'restarted-after-gap',phase:restarted.phase});}
  await c.metadata.put(LIVE_KEY,{at:now0});
  const view=await lifecycle.status(owner);
  c.lifecycleExternalChecked=false;if(view.phase==='purge-review'&&settings.purge)c.lifecycleExternalChecked=!await externalResourcesPresent(c,owner);
  for(let i=0;i<3;i++){result=await lifecycle.step(owner);log({owner,action:result.action,phase:result.phase,reason:result.reason,outcome:result.outcome,generation:result.generation});if(!['resumed','suspended','purge-started'].includes(result.action)||result.phase==='active')break;}
  await consumeEffects(c,lifecycle,owner);
  let busy=false;
  if(result.phase==='purging'&&result.action==='purging'&&settings.purge){
   const fence=async()=>(await lifecycle.step(owner)).action==='purging';
   const batch=await purgeBatch(c,owner,{identity:c.config.LIFECYCLE_IDENTITY,fence,budget:settings.purgeBudget,log});
   if(batch.done)return {mode,action:'deleted'};busy=!batch.halted;result={...result,purgeStage:batch.stage};
  }
  if(settings.cold&&(result.phase==='suspended'||result.phase==='purge-review')){
   const job=await c.metadata.get(COLD_KEY);
   if(job){const batch=await coldBatch(c,owner,{generation:job.generation,blocked:async()=>(await lifecycle.access(owner)).blocked,minBytes:settings.coldMinBytes,budget:settings.coldBudget,supported:settings.coldSupported});busy||=!batch.done&&!batch.failed&&!batch.halted;}
  }
  // Durable holds and paid protection back off to a weekly check; transient port outages retry daily.
  const now=clock(),transient=['admin-status-unavailable','admin-status-changed','financial-review-unavailable','contact-unavailable'].includes(result.reason);
  const next=busy?now+2000:result.action==='paid-protected'?now+7*DAY:result.action==='hold'?now+(transient?DAY:7*DAY):result.action==='deletion-review'?now+DAY:result.action==='stale'?now+60000:Math.max(now+60000,result.nextWakeAt??now+7*DAY);
  await c.scheduleAlarm(Math.min(next,now+7*DAY));
  return {mode,...result};
 }catch(error){log({owner,action:'error',code:error?.code||'unavailable'});await c.scheduleAlarm(clock()+3600000);return {mode,action:'error',code:error?.code||'unavailable'};}
}

export const lifecycleMethods={
 async lifecycleStatus(owner){
  const settings=lifecycleSettings(this.config);if(settings.mode==='off')return {mode:'off',phase:'unarmed'};
  const stored=await this.metadata.get('owner');if(stored!==owner)throw Object.assign(new Error('Account owner mismatch.'),{code:'forbidden',status:403});
  if(await this.metadata.get(TOMBSTONE_KEY)!==undefined)return {mode:settings.mode,phase:'deleted'};
  const view=await lifecycleOf(this).status(owner),purge=await this.metadata.get(PURGE_KEY);
  // Server-derived deadline and wording; dry run never presents an enforced phase.
  return {mode:settings.mode,phase:view.phase,armed:view.armed,deadline:view.deadline??null,deadlineDays:view.noticeDeadlineDays??null,reactivationRequired:settings.mode==='live'&&['suspended','purge-review'].includes(view.phase),deletionScheduled:settings.purge&&['suspended','purge-review'].includes(view.phase),confirmationAvailable:settings.mode==='live'&&view.phase==='warning',hold:view.hold??null,adminHold:view.adminHold===true,purging:Boolean(purge)};
 },
 /** Explicit "I'm still using it". Warning: confirmation activity. Suspended:
  * restricted reactivation with a recent owner session. */
 async lifecycleReactivate(owner,authority){
  if(lifecycleMode(this.config)!=='live')throw Object.assign(new Error('Account lifecycle enforcement is not active.'),{code:'lifecycle_inactive',status:409});
  const lifecycle=lifecycleOf(this),view=await lifecycle.status(owner);
  if(['active','warning'].includes(view.phase)){this.lifecycleActivityAt=null;if(view.armed)await lifecycle.recordActivity(owner,{source:'owner-confirmation'});}
  else{await lifecycle.reactivate(owner,authority);await consumeEffects(this,lifecycle,owner);await this.metadata.delete(COLD_KEY);lifecycleLog(this.config,{mode:'live',owner,action:'reactivated'});}
  return lifecycleMethods.lifecycleStatus.call(this,owner);
 },
 /** Verified Polar webhook observation for an identity in any non-deleted status
  * (including admin-suspended or recovering, which the billing route otherwise ignores). */
 async lifecycleEverPaid(owner,event){if(!everPaidEvent(event))return {recorded:false};if(await this.metadata.get('owner')!==owner)return {recorded:false};return {recorded:await rememberEverPaid(this.metadata,owner,{source:'webhook',evidence:event.type})};},
 /** Cron-sweep entry: arms missing schedules and runs one bounded tick without restoring archives. */
 async lifecycleTick(owner,{source='sweep'}={}){
  const stored=await this.metadata.get('owner');if(stored!==undefined&&stored!==owner)throw Object.assign(new Error('Account owner mismatch.'),{code:'forbidden',status:403});
  // A purge interrupted between the storage wipe and the tombstone write is completed from the identity tombstone.
  if(stored===undefined&&lifecycleMode(this.config)!=='off'&&(await this.config.LIFECYCLE_IDENTITY?.get(owner).catch(()=>null))?.status==='deleted'){await this.metadata.put('owner',owner);await this.metadata.put(TOMBSTONE_KEY,{version:1,owner,deletedAt:clockOf(this)(),reason:'inactive-unpaid',restored:true});return {mode:lifecycleMode(this.config),action:'deleted'};}
  return lifecycleTick(this,{source});
 }
};
