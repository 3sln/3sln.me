import {accountRemovalProtection} from '../identity/lifecycle-protection.mjs';

const DAY=86400000, KEY='lifecycle/state-v1';
const PHASES=new Set(['active','warning','suspended','purge-review','purging']);
const BLOCKED=new Set(['suspended','purge-review','purging']);
export const DEFAULT_ACCOUNT_LIFECYCLE_POLICY=Object.freeze({unusedDays:2,inactiveDays:365,warningDays:7,suspendedDays:30,noticeLeaseMs:60000,proofMaxAgeMs:300000,activityCoalesceMs:900000,establishAfterMs:3600000});
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const int=value=>Number.isSafeInteger(value)&&value>=0;
const contextOf=config=>JSON.stringify([config.APP_ORIGIN,config.POLAR_SERVER,config.POLAR_CATALOG_MODE??'static',config.POLAR_ORGANIZATION_ID??null,config.POLAR_METADATA_PREFIX??'3sln_me_',config.POLAR_PRODUCT_ID_PAID??null,config.POLAR_PRODUCT_ID_PLUS??null,config.POLAR_PRODUCT_ID_ULTRA??null]);
const clone=value=>structuredClone(value);

/** Isolated account-local phase logic. No identity status, storage, notification
 * preferences, RPC authority or object-deletion adapter is mutated here.
 *
 * Integration must route all normal effects through access(), consume the
 * durable effects with generation checks, and retain restricted owner auth.
 * The module owns its gate; callers must not acquire that same gate first.
 * protection/contact are local metadata readers. reviewFinance/sendNotice/
 * authorizeReactivation are injected trusted ports and run outside transactions.
 * purge-review is never a deletion permit. A future executor must independently
 * verify external namespace exports against the current owner/generation and
 * mapping revision before deleting host mapping metadata. No connector DELETE
 * is permitted; missing independently restorable mappings must retain the host.
 *
 * adminHold(owner) is a trusted port, read outside transactions, returning
 * {held, since, releasedAt} for the administrator suspension hold. A held or
 * unreadable hold freezes every automatic step (warning, suspension, purge
 * review). A released hold resumes once from a safe state: warning/active
 * restart the inactivity clock; suspended/purge-review restart a full
 * suspended notice episode. Paid protection is evaluated first, unchanged.
 */
export class AccountLifecycle {
  constructor({metadata,gate,config,protection=accountRemovalProtection,contact,reviewFinance,sendNotice,authorizeReactivation,adminHold,purge=false,purgeEligible=async()=>false,clock=Date.now,policy={}}){
    if(!metadata?.transaction||!gate?.run||!config?.APP_ORIGIN||typeof contact!=='function'||typeof reviewFinance!=='function'||typeof sendNotice!=='function'||typeof adminHold!=='function')throw new TypeError('Lifecycle ports are required');
    if(typeof purge!=='boolean'||typeof purgeEligible!=='function')throw new TypeError('Lifecycle purge ports are invalid');Object.assign(this,{metadata,gate,config,protection,contact,reviewFinance,sendNotice,authorizeReactivation,adminHold,purge,purgeEligible,clock});this.policy={...DEFAULT_ACCOUNT_LIFECYCLE_POLICY,...policy};
    const p=this.policy;if(Object.keys(policy).some(key=>!Object.hasOwn(DEFAULT_ACCOUNT_LIFECYCLE_POLICY,key))||!Object.values(p).every(int)||p.unusedDays<1||p.inactiveDays<30||p.warningDays<7||p.suspendedDays<30||p.noticeLeaseMs<1000||p.noticeLeaseMs>300000||p.proofMaxAgeMs<1000||p.proofMaxAgeMs>300000||p.activityCoalesceMs>900000||p.establishAfterMs>86400000)throw new TypeError('Conservative lifecycle bounds are required');this.context=JSON.stringify([contextOf(config),this.policy]);
  }
  async transaction(fn){return this.gate.run(()=>this.metadata.transaction(fn));}
  validate(state,owner){
    if(!state||state.version!==1||state.owner!==owner||state.context!==this.context||!PHASES.has(state.phase)||!['generation','activityEpoch','capabilityEpoch','createdAt','activatedAt','lastActivityAt','lastObservedAt'].every(k=>int(state[k]))||state.generation<1||state.activityEpoch<1||state.createdAt>state.activatedAt||state.activatedAt>state.lastActivityAt||state.lastActivityAt>state.lastObservedAt||typeof state.established!=='boolean'||state.lastObservedAt>this.clock())fail('lifecycle_unavailable','Lifecycle ownership, clock or state requires review.',503);
    if(['active','purging'].includes(state.phase)&&state.notice!==null||!['active','purging'].includes(state.phase)&&!state.notice)fail('lifecycle_unavailable','Notice phase evidence is missing.',503);
    if(BLOCKED.has(state.phase)){const warning=state.lastWarning;if(!warning||warning.phase!=='warning'||!Array.isArray(warning.attempts)||warning.attempts.length>6||!int(warning.firstAcceptedAt)||!int(warning.deadline)||warning.deadline!==warning.firstAcceptedAt+this.grace('warning')||state.notice&&warning.deadline>state.notice.startedAt||warning.attempts.some(a=>!a||!uuid(a.id)||!int(a.reservedAt)||!['accepted','failed','unknown'].includes(a.outcome)||a.outcome==='accepted'&&(typeof a.receipt!=='string'||!a.receipt||!int(a.acceptedAt)))||!this.accepted(warning))fail('lifecycle_unavailable','Completed warning evidence requires review.',503);}
    if(state.notice){const n=state.notice;if(!['warning','suspended'].includes(n.phase)||!int(n.startedAt)||!Array.isArray(n.attempts)||n.attempts.length>6||!int(n.episode)||typeof n.channelRevision!=='string'||n.channelRevision.length>256||n.attempts.some(a=>!uuid(a.id)||!int(a.reservedAt)||!int(a.leaseUntil)||a.leaseUntil<a.reservedAt||!['reserved','accepted','failed','unknown'].includes(a.outcome)||a.generation!==n.generation||a.channelRevision!==n.channelRevision)||new Set(n.attempts.map(a=>a.id)).size!==n.attempts.length||n.firstAcceptedAt!==null&&!int(n.firstAcceptedAt)||n.deadline!==null&&!int(n.deadline))fail('lifecycle_unavailable','Notice state requires review.',503);}
    if(state.notice){const n=state.notice,first=n.attempts.find(a=>a.id===n.firstAcceptedId);if(!int(n.generation)||n.generation!==(state.phase==='purge-review'?state.generation-1:state.generation)||n.startedAt>state.lastObservedAt||n.phase!==state.phase&&!(state.phase==='purge-review'&&n.phase==='suspended')||n.attempts.some((a,i)=>a.reservedAt<n.startedAt||a.reservedAt>state.lastObservedAt||a.leaseUntil!==a.reservedAt+this.policy.noticeLeaseMs||i>0&&a.reservedAt-n.attempts[i-1].reservedAt<this.spacing(n.phase)||a.outcome==='accepted'&&(!int(a.acceptedAt)||a.acceptedAt<a.reservedAt||a.acceptedAt>state.lastObservedAt||typeof a.receipt!=='string'||!a.receipt||a.receipt.length>256))||new Set(n.attempts.filter(a=>a.receipt).map(a=>a.receipt)).size!==n.attempts.filter(a=>a.receipt).length||n.firstAcceptedAt===null&&(n.deadline!==null||n.firstAcceptedId!==null)||n.firstAcceptedAt!==null&&(!first||first.outcome!=='accepted'||first.acceptedAt!==n.firstAcceptedAt||n.deadline!==n.firstAcceptedAt+this.grace(n.phase))||![null,'bounced','suppressed'].includes(n.blocked))fail('lifecycle_unavailable','Notice evidence requires review.',503);}
    if(state.adminResumedAt!==undefined&&!int(state.adminResumedAt)||state.adminReleaseSeen!==undefined&&state.adminReleaseSeen!==null&&!int(state.adminReleaseSeen)||state.adminHold!=null&&(!int(state.adminHold.since)||!int(state.adminHold.observedAt)))fail('lifecycle_unavailable','Administrator hold state requires review.',503);
    if(state.phase==='purging'&&(!int(state.purgeStartedAt)||state.purgeStartedAt>state.lastObservedAt))fail('lifecycle_unavailable','Purge state requires review.',503);
    return state;
  }
  async read(tx,owner){if(!uuid(owner)||await tx.get('owner')!==owner)fail('forbidden','Account ownership does not match.',403);const state=await tx.get(KEY);return state===undefined?null:this.validate(state,owner);}
  bump(state,key){if(!int(state[key])||!Number.isSafeInteger(state[key]+1))fail('lifecycle_unavailable','Lifecycle counters require review.',503);state[key]++;}
  view(state){return state?{armed:true,phase:state.phase,generation:state.generation,activityEpoch:state.activityEpoch,capabilityEpoch:state.capabilityEpoch,lastActivityAt:state.lastActivityAt,established:state.established,deadline:state.notice?.deadline??null,attempts:state.notice?.attempts.length??0,hold:state.hold??null,adminHold:Boolean(state.adminHold),nextWakeAt:this.nextWake(state),automaticDeletionEnabled:this.purge,noticeDeadlineDays:this.deadlineDays(state)}: {armed:false,phase:'unarmed',automaticDeletionEnabled:this.purge};}
  deadlineDays(state){const n=state.notice;if(!n)return null;return n.deadline===null?this.grace(n.phase)/DAY:Math.max(0,Math.ceil((n.deadline-this.clock())/DAY));}
  async status(owner){return this.transaction(async tx=>this.view(await this.read(tx,owner)));}
  async access(owner){return this.transaction(async tx=>{const state=await this.read(tx,owner);return {blocked:BLOCKED.has(state?.phase),phase:state?.phase??'unarmed',capabilityEpoch:state?.capabilityEpoch??0,generation:state?.generation??0};});}
  async recordActivation(owner,{createdAt,activatedAt,established=false}={}){
    return this.transaction(async tx=>{const existing=await this.read(tx,owner);if(existing)return this.view(existing);const now=this.clock();if(!int(createdAt)||!int(activatedAt)||createdAt>activatedAt||activatedAt>now||typeof established!=='boolean')fail('invalid_activation','Trusted completed activation timestamps are required.',400);const state={version:1,owner,context:this.context,phase:'active',generation:1,activityEpoch:1,capabilityEpoch:0,createdAt,activatedAt,lastActivityAt:activatedAt,lastObservedAt:now,established,notice:null,lastWarning:null,hold:null};await tx.put(KEY,state);return this.view(state);});
  }
  async recordActivity(owner,{source}={}){
    if(!['owner-return','resource-use','owner-confirmation'].includes(source))fail('invalid_activity','Only authenticated meaningful activity can reset inactivity.',400);
    return this.transaction(async tx=>{const state=await this.read(tx,owner);if(!state)fail('lifecycle_unarmed','Completed activation must be recorded first.');if(BLOCKED.has(state.phase))fail('account_suspended','Use restricted owner reactivation.',423);const now=this.clock();if(state.phase==='active'&&state.established&&now-state.lastActivityAt<this.policy.activityCoalesceMs)return this.view(state);
      // Signup bootstrap and the initial setup session do not establish continued use.
      if(state.phase==='active'&&!state.established&&now-state.activatedAt<this.policy.establishAfterMs)return this.view(state);this.bump(state,'activityEpoch');if(state.phase==='warning'){this.bump(state,'generation');state.phase='active';state.notice=null;state.hold=null;}state.lastActivityAt=now;state.lastObservedAt=now;state.established=true;await tx.put(KEY,state);return this.view(state);});
  }
  same(state,snapshot){return state&&state.generation===snapshot.generation&&state.activityEpoch===snapshot.activityEpoch&&state.phase===snapshot.phase;}
  grace(phase){return (phase==='warning'?this.policy.warningDays:this.policy.suspendedDays)*DAY;}
  spacing(phase){return Math.max(DAY,Math.floor(this.grace(phase)/3));}
  episode(state,channelRevision){return {phase:state.phase,generation:state.generation,episode:(state.notice?.episode??0)+1,startedAt:this.clock(),channelRevision,firstAcceptedAt:null,firstAcceptedId:null,deadline:null,blocked:null,attempts:[]};}
  accepted(n){return n.firstAcceptedAt!==null&&n.attempts.filter(a=>(a.id===n.firstAcceptedId||a.reservedAt>=n.firstAcceptedAt)&&a.reservedAt<=n.deadline&&a.outcome!=='reserved').length>=3&&n.attempts.some(a=>a.outcome==='accepted'&&(a.id===n.firstAcceptedId||a.reservedAt>=n.firstAcceptedAt)&&a.receipt);}
  nextWake(state){if(state.phase==='purging')return this.clock();if(state.phase==='active')return state.lastActivityAt+(state.established?this.policy.inactiveDays:this.policy.unusedDays)*DAY;if(!state.notice)return null;const n=state.notice,pending=n.attempts.find(a=>a.outcome==='reserved');if(pending)return pending.leaseUntil;if(n.deadline!==null&&this.accepted(n))return n.deadline;const last=n.attempts.at(-1);return last?last.reservedAt+this.spacing(n.phase):n.startedAt;}
  validProof(proof,snapshot){const now=this.clock();return proof?.owner===snapshot.owner&&proof.context===this.context&&proof.generation===snapshot.generation&&proof.activityEpoch===snapshot.activityEpoch&&proof.neverPaid===true&&int(proof.checkedAt)&&int(proof.expiresAt)&&proof.checkedAt<=now&&proof.expiresAt>now&&proof.expiresAt<=proof.checkedAt+this.policy.proofMaxAgeMs;}
  contactReady(channel){return channel?.verified===true&&channel.available===true&&channel.bounced!==true&&channel.suppressed!==true&&typeof channel.revision==='string'&&channel.revision.length>0&&channel.revision.length<=256;}
  async hold(owner,snapshot,reason){return this.transaction(async tx=>{const state=await this.read(tx,owner);if(!this.same(state,snapshot))return {action:'stale',...this.view(state)};state.hold=reason;state.lastObservedAt=this.clock();await tx.put(KEY,state);return {action:'hold',...this.view(state)};});}
  async effect(tx,state,kind){await tx.put('lifecycle/effect/'+state.generation,{version:1,owner:state.owner,generation:state.generation,capabilityEpoch:state.capabilityEpoch,kind,createdAt:this.clock()});}
  async adminState(owner){try{const value=await this.adminHold(owner);if(!value||typeof value.held!=='boolean'||value.since!=null&&!int(value.since)||value.releasedAt!=null&&!int(value.releasedAt))return null;return {held:value.held,since:value.since??null,releasedAt:value.releasedAt??null};}catch{return null;}}
  // Decides the step while an administrator hold is held, unreadable or newly
  // released (including a hold that came and went between two steps).
  async administer(tx,state,admin){
    if(!admin)return {action:'hold',reason:'admin-status-unavailable',...this.view(state)};
    const now=this.clock();
    if(admin.held){if(!state.adminHold){state.adminHold={since:admin.since??now,observedAt:now};state.lastObservedAt=now;await tx.put(KEY,state);}return {action:'hold',reason:'admin-suspended',...this.view(state)};}
    // Release times are compared only with release times (admin clock), never the account clock.
    if(!state.adminHold&&!(admin.releasedAt!==null&&admin.releasedAt>(state.adminReleaseSeen??-1)&&admin.releasedAt>state.activatedAt))return null;
    if(state.phase==='purging'){state.adminHold=null;state.adminResumedAt=now;state.adminReleaseSeen=admin.releasedAt??state.adminReleaseSeen??null;state.lastObservedAt=now;await tx.put(KEY,state);return null;}
    this.bump(state,'generation');state.hold=null;state.adminHold=null;state.adminResumedAt=now;state.adminReleaseSeen=admin.releasedAt??state.adminReleaseSeen??null;state.lastObservedAt=now;
    // A resumed account gets the long inactivity window, never the short unused-account one.
    if(['active','warning'].includes(state.phase)){this.bump(state,'activityEpoch');state.phase='active';state.notice=null;state.lastActivityAt=now;state.established=true;}
    else{const channelRevision=state.notice.channelRevision;state.phase='suspended';state.notice=this.episode(state,channelRevision);await this.effect(tx,state,'freeze');}
    await tx.put(KEY,state);return {action:'resumed',...this.view(state)};
  }
  async cancelForPaid(tx,state){
    // Purge began irreversibly; protection observed now halts further batches for operator review.
    if(state.phase==='purging'){if(state.hold!=='purge-halted-protection'){state.hold='purge-halted-protection';state.lastObservedAt=this.clock();await tx.put(KEY,state);}return {action:'hold',reason:'purge-halted-protection',...this.view(state)};}
    if(state.phase!=='active'){const blocked=['suspended','purge-review'].includes(state.phase);this.bump(state,'generation');if(blocked)this.bump(state,'capabilityEpoch');state.phase='active';state.notice=null;state.hold=null;if(blocked)await this.effect(tx,state,'thaw');state.lastObservedAt=this.clock();await tx.put(KEY,state);}return {action:'paid-protected',...this.view(state)};}
  async step(owner){
    const admin=await this.adminState(owner);
    const snapshot=await this.transaction(async tx=>{const state=await this.read(tx,owner);if(!state)return null;const protection=await this.protection(tx,owner,{config:this.config,now:this.clock()});if(protection.status==='paid-protected')return {result:await this.cancelForPaid(tx,state)};const decided=await this.administer(tx,state,admin);if(decided)return {result:decided};if(state.phase==='purging')return {result:{action:protection.status==='unpaid'?'purging':'hold',...protection.status==='unpaid'?{}:{reason:'purge-halted-review'},...this.view(state)}};if(protection.status!=='unpaid')return {result:{action:'hold',reason:'payment-review',...this.view(state)}};if(state.phase==='active'&&this.clock()<this.nextWake(state))return {result:{action:'wait',...this.view(state)}};return {state:clone(state)};});
    if(!snapshot)return {action:'unarmed',...this.view(null)};if(snapshot.result)return snapshot.result;
    const before=snapshot.state;let proof;try{proof=await this.reviewFinance({owner,context:this.context,generation:before.generation,activityEpoch:before.activityEpoch});}catch{return this.hold(owner,before,'financial-review-unavailable');}if(proof?.neverPaid===false){const cancelled=await this.transaction(async tx=>{const state=await this.read(tx,owner);if(!state)return null;const local=await this.protection(tx,owner,{config:this.config,now:this.clock()});return local.status==='paid-protected'?this.cancelForPaid(tx,state):null;});if(cancelled)return cancelled;}
    if(!this.validProof(proof,before))return this.hold(owner,before,'financial-history-unverified');
    const confirmed=await this.adminState(owner);
    const prepared=await this.transaction(async tx=>{const state=await this.read(tx,owner);if(!this.same(state,before))return {result:{action:'stale',...this.view(state)}};if(!confirmed||confirmed.held||confirmed.releasedAt!==admin.releasedAt||state.adminHold)return {result:{action:'hold',reason:confirmed?.held?'admin-suspended':'admin-status-changed',...this.view(state)}};const local=await this.protection(tx,owner,{config:this.config,now:this.clock()});if(local.status==='paid-protected')return {result:await this.cancelForPaid(tx,state)};if(local.status!=='unpaid'||!this.validProof(proof,before))return {result:{action:'hold',reason:'payment-review',...this.view(state)}};
      // The final grace period has elapsed. Deletion is irreversible only from this committed fence.
      if(state.phase==='purge-review'){if(!this.purge)return {result:{action:'deletion-review',...this.view(state),purgePermitted:false,preservationRequired:true}};if(!await this.purgeEligible(tx,owner))return {result:{action:'hold',reason:'external-mapping-preservation-required',...this.view(state),purgePermitted:false,preservationRequired:true}};const now=this.clock();this.bump(state,'generation');this.bump(state,'capabilityEpoch');state.phase='purging';state.notice=null;state.hold=null;state.purgeStartedAt=now;state.lastObservedAt=now;await this.effect(tx,state,'purge');await tx.put(KEY,state);return {result:{action:'purge-started',...this.view(state)}};}
      const channel=await this.contact(tx,owner);if(!this.contactReady(channel))return {result:{action:'hold',reason:'contact-unavailable',...this.view(state)}};
      if(state.phase==='active'){state.phase='warning';this.bump(state,'generation');state.notice=this.episode(state,channel.revision);state.hold=null;}
      if(state.notice.channelRevision!==channel.revision)return {result:{action:'hold',reason:'contact-changed',...this.view(state)}};
      const n=state.notice,now=this.clock();for(const attempt of n.attempts)if(attempt.outcome==='reserved'&&attempt.leaseUntil<=now)attempt.outcome='unknown';
      if(n.firstAcceptedAt!==null&&now>=n.deadline){if(n.blocked||!this.accepted(n)){state.hold='insufficient-notice-evidence';await tx.put(KEY,state);return {result:{action:'hold',...this.view(state)}};}state.lastObservedAt=now;state.hold=null;this.bump(state,'generation');this.bump(state,'capabilityEpoch');if(state.phase==='warning'){state.lastWarning=clone(n);state.phase='suspended';state.notice=this.episode(state,channel.revision);await this.effect(tx,state,'freeze');}else{state.phase='purge-review';await this.effect(tx,state,'purge-review');}await tx.put(KEY,state);return {result:{action:state.phase==='suspended'?'suspended':'deletion-review',...this.view(state)}};}
      const last=n.attempts.at(-1);if(n.attempts.some(a=>a.outcome==='reserved')||last&&now<last.reservedAt+this.spacing(n.phase)){await tx.put(KEY,state);return {result:{action:'wait',...this.view(state)}};}
      if(n.blocked){state.hold='contact-'+n.blocked;await tx.put(KEY,state);return {result:{action:'hold',reason:state.hold,...this.view(state)}};}
      if(n.attempts.length>=6||n.firstAcceptedAt===null&&n.attempts.length>=3){state.hold='notice-attempts-exhausted';await tx.put(KEY,state);return {result:{action:'hold',...this.view(state)}};}
      const attempt={id:crypto.randomUUID(),generation:state.generation,channelRevision:channel.revision,reservedAt:now,leaseUntil:now+this.policy.noticeLeaseMs,outcome:'reserved',receipt:null,acceptedAt:null};n.attempts.push(attempt);state.lastObservedAt=now;await tx.put(KEY,state);return {delivery:{owner,phase:state.phase,generation:state.generation,activityEpoch:state.activityEpoch,attemptId:attempt.id,channelRevision:channel.revision,deadline:n.deadline,deadlineDays:n.deadline===null?this.grace(state.phase)/DAY:Math.max(0,Math.ceil((n.deadline-now)/DAY))}};
    });
    if(prepared.result)return prepared.result;const delivery=prepared.delivery;let receipt;try{receipt=await this.sendNotice(delivery);}catch(error){receipt={outcome:'unknown',blocked:error.code==='E_RECIPIENT_SUPPRESSED'?'suppressed':undefined};}
    return this.transaction(async tx=>{const state=await this.read(tx,owner),attempt=state?.notice?.attempts.find(a=>a.id===delivery.attemptId);if(!state||state.generation!==delivery.generation||state.activityEpoch!==delivery.activityEpoch||!attempt||attempt.outcome!=='reserved')return {action:'stale',...this.view(state)};const protection=await this.protection(tx,owner,{config:this.config,now:this.clock()}),channel=await this.contact(tx,owner);if(protection.status==='paid-protected')return this.cancelForPaid(tx,state);if(protection.status!=='unpaid'||!this.contactReady(channel)||channel.revision!==delivery.channelRevision){attempt.outcome='unknown';state.hold='authority-changed';}else if(['bounced','suppressed'].includes(receipt?.blocked)){attempt.outcome='failed';state.notice.blocked=receipt.blocked;state.hold='contact-'+receipt.blocked;}else if(receipt?.accepted===true&&!state.notice.attempts.some(a=>a.id!==attempt.id&&a.receipt===receipt.receipt)&&typeof receipt.receipt==='string'&&receipt.receipt.length>0&&receipt.receipt.length<=256){attempt.outcome='accepted';attempt.receipt=receipt.receipt;attempt.acceptedAt=this.clock();if(state.notice.firstAcceptedAt===null){state.notice.firstAcceptedAt=attempt.acceptedAt;state.notice.firstAcceptedId=attempt.id;state.notice.deadline=attempt.acceptedAt+this.grace(state.phase);}}else attempt.outcome=receipt?.outcome==='failed'?'failed':'unknown';state.lastObservedAt=this.clock();await tx.put(KEY,state);return {action:'notice-recorded',outcome:attempt.outcome,...this.view(state)};});
  }
  /** Live enforcement resumed after a period without live ticks (off, dry run or
   * an outage). Deadlines from that period never authorise deletion: active and
   * warning restart the long inactivity clock; suspended and purge-review restart
   * a full suspended notice episode. Purging is already irreversible. */
  async restartAfterGap(owner){return this.transaction(async tx=>{const state=await this.read(tx,owner);if(!state||['active','purging'].includes(state.phase))return {action:'unchanged',...this.view(state)};const now=this.clock();this.bump(state,'generation');state.hold=null;state.lastObservedAt=now;if(state.phase==='warning'){this.bump(state,'activityEpoch');state.phase='active';state.notice=null;state.lastActivityAt=now;state.established=true;}else{state.phase='suspended';state.notice=this.episode(state,state.notice.channelRevision);await this.effect(tx,state,'freeze');}await tx.put(KEY,state);return {action:'restarted',...this.view(state)};});}
  /** Dry-run planner: reads local state and ports that do not send or mutate.
   * It never calls reviewFinance (which may record paid history) or sendNotice. */
  async plan(owner){
    const admin=await this.adminState(owner);
    return this.transaction(async tx=>{
      const state=await this.read(tx,owner);if(!state)return {action:'arm',...this.view(null)};
      const protection=await this.protection(tx,owner,{config:this.config,now:this.clock()}),view=this.view(state),now=this.clock();
      if(protection.status==='paid-protected')return {action:state.phase==='purging'?'hold':'paid-protected',...view};
      if(!admin||admin.held)return {action:'hold',reason:admin?'admin-suspended':'admin-status-unavailable',...view};
      if(state.phase==='purging')return {action:protection.status==='unpaid'?'purge-continue':'hold',...view};
      if(protection.status!=='unpaid')return {action:'hold',reason:'payment-review',...view};
      if(state.phase==='active'&&now<this.nextWake(state))return {action:'wait',...view};
      if(state.phase==='purge-review')return {action:this.purge?'purge':'deletion-review',...view};
      if(!this.contactReady(await this.contact(tx,owner)))return {action:'hold',reason:'contact-unavailable',...view};
      if(state.phase==='active')return {action:'notice',notice:'warning',deadlineDays:this.grace('warning')/DAY,...view};
      const n=state.notice;if(state.hold)return {action:'hold',reason:state.hold,...view};
      if(n.firstAcceptedAt!==null&&now>=n.deadline)return {action:this.accepted(n)&&!n.blocked?(state.phase==='warning'?'suspend':'purge-review'):'hold',...view};
      if(now<this.nextWake(state))return {action:'wait',...view};
      return {action:'notice',notice:state.phase,deadlineDays:this.deadlineDays(state),...view};
    });
  }
  async restartNoticeEpisode(owner){return this.transaction(async tx=>{const state=await this.read(tx,owner);if(!state||!['warning','suspended'].includes(state.phase))fail('invalid_lifecycle_phase','There is no notice phase to restart.');const channel=await this.contact(tx,owner);if(!this.contactReady(channel))fail('contact_unavailable','A verified usable contact is required.');this.bump(state,'generation');state.notice=this.episode(state,channel.revision);state.hold=null;state.lastObservedAt=this.clock();if(state.phase==='suspended')await this.effect(tx,state,'freeze');await tx.put(KEY,state);return this.view(state);});}
  async reactivate(owner,authority){if(typeof this.authorizeReactivation!=='function')fail('reauthentication_required','Restricted verified owner authentication is required.',401);const before=await this.transaction(tx=>this.read(tx,owner));if(!before)fail('lifecycle_unarmed','Lifecycle is not armed.');if(before.adminHold)fail('account_suspended','An administrator hold must be lifted first.',423);if(before.phase==='purging')fail('account_deleting','Account deletion has already begun.',410);const proof=await this.authorizeReactivation({owner,authority,generation:before.generation,capabilityEpoch:before.capabilityEpoch,context:this.context});if(proof?.owner!==owner||proof.context!==this.context||proof.generation!==before.generation||proof.capabilityEpoch!==before.capabilityEpoch||!int(proof.verifiedAt)||proof.verifiedAt>this.clock()||!int(proof.expiresAt)||proof.expiresAt>proof.verifiedAt+this.policy.proofMaxAgeMs||proof.expiresAt<=this.clock())fail('reauthentication_required','Owner authentication is stale.',401);return this.transaction(async tx=>{const state=await this.read(tx,owner);if(!this.same(state,before)||state.adminHold||state.phase==='purging'||proof.expiresAt<=this.clock())fail('stale_reactivation','The lifecycle changed. Authenticate again.');this.bump(state,'generation');this.bump(state,'activityEpoch');this.bump(state,'capabilityEpoch');state.phase='active';state.notice=null;state.hold=null;state.lastActivityAt=this.clock();state.lastObservedAt=this.clock();state.established=true;await this.effect(tx,state,'thaw');await tx.put(KEY,state);return this.view(state);});}
}
