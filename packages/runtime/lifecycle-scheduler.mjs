import {lifecycleMode,lifecycleLog} from './lifecycle-runner.mjs';

// Bounded, resumable sweep over identity shards. It arms lifecycle schedules for
// accounts that never return (migration and Node restart wake-up) and nudges a
// tick on each; per-account alarms drive exact notice timing. One run takes a
// lease, processes at most LIFECYCLE_SWEEP_BATCH accounts within
// LIFECYCLE_SWEEP_TIME_MS, saves the cursor after every page and continues via
// its own alarm until the pass completes. A crashed run's lease expires; ticks
// are idempotent, so a replayed page is safe.
const KEY='lifecycle/sweep-v1',LEASE_MS=600000,STATUSES=new Set(['active','suspended','deleted']);
const integer=(value,fallback,min,max)=>{const parsed=value===undefined||value===''?fallback:Number(value);return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;};
const tally=(counts,name)=>{counts[name]=(counts[name]||0)+1;};

export class LifecycleSweep {
 constructor({metadata,repository,accounts,config,clock=()=>Date.now()}){
  if(!metadata?.transaction||typeof repository?.lifecycleCandidates!=='function'||typeof accounts?.get!=='function')throw new TypeError('Lifecycle sweep ports are required');
  Object.assign(this,{metadata,repository,accounts,config,clock});
 }
 async status(){const state=await this.metadata.get(KEY);return state?{cursor:state.cursor!==null,passes:state.passes,lastRun:state.lastRun??null,running:Boolean(state.lease&&state.lease.until>this.clock())}:{cursor:false,passes:0,lastRun:null,running:false};}
 async run({trigger='cron'}={}){
  const mode=lifecycleMode(this.config);if(mode==='off')return {mode};
  const budget=integer(this.config.LIFECYCLE_SWEEP_BATCH,200,1,2000),timeBudget=integer(this.config.LIFECYCLE_SWEEP_TIME_MS,25000,1000,600000),continueMs=integer(this.config.LIFECYCLE_SWEEP_CONTINUE_MS,900000,60000,86400000);
  const started=this.clock(),lease=crypto.randomUUID();
  const claimed=await this.metadata.transaction(async tx=>{
   const stored=await tx.get(KEY),state=stored&&stored.version===1?stored:{version:1,cursor:null,passes:0};
   if(state.lease&&state.lease.until>started&&state.lease.until<=started+LEASE_MS)return null;
   state.lease={id:lease,until:started+LEASE_MS};await tx.put(KEY,state);return state;
  });
  if(!claimed)return {mode,skipped:'running'};
  let cursor=claimed.cursor,processed=0,complete=false;const counts={};
  try{
   while(processed<budget&&this.clock()-started<timeBudget){
    const page=await this.repository.lifecycleCandidates({...cursor?{cursor}:{},limit:Math.min(100,budget-processed)});
    if(!page||!Array.isArray(page.accounts)||page.accounts.length>100||page.cursor!==null&&typeof page.cursor!=='string')throw Object.assign(new Error('Invalid identity page'),{code:'lifecycle_sweep_invalid_page'});
    for(const account of page.accounts){
     if(!STATUSES.has(account.status)){tally(counts,'skipped');continue;}
     processed++;
     try{const result=await this.accounts.get(account.id).invoke({method:'lifecycleTick',args:[account.id,{source:'sweep'}]});tally(counts,result?.$fault?'fault':result?.planned?`planned:${result.planned}`:result?.action??'none');}
     catch{tally(counts,'error');}
    }
    cursor=page.cursor;
    const saved=await this.metadata.transaction(async tx=>{const state=await tx.get(KEY);if(state?.lease?.id!==lease)return false;state.cursor=cursor;if(!cursor){state.passes=(state.passes||0)+1;state.passCompletedAt=this.clock();}await tx.put(KEY,state);return true;});
    if(!saved)throw Object.assign(new Error('Sweep lease lost'),{code:'lifecycle_sweep_lease_lost'});
    if(!cursor){complete=true;break;}
   }
  }finally{
   const summary={trigger,at:started,processed,complete,counts};
   await this.metadata.transaction(async tx=>{const state=await tx.get(KEY);if(state?.lease?.id!==lease)return;delete state.lease;state.lastRun=summary;await tx.put(KEY,state);});
   if(cursor)await this.metadata.setAlarm(this.clock()+continueMs);
   lifecycleLog(this.config,{mode,action:'sweep',...summary});
  }
  return {mode,processed,complete,counts};
 }
}
