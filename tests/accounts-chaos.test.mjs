import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {AccountLifecycle} from '../packages/runtime/account-lifecycle.mjs';
import {lifecycleIdentityPort} from '../packages/identity/lifecycle-tombstone.mjs';
import {consumeSignupCapacity} from '../packages/runtime/signup-capacity.mjs';
import {forEachSeed,createScheduler,injectFaults,fakeClock} from './helpers/chaos.mjs';

// Engine-level contention and fault injection for account admission, the
// account lifecycle and tombstoning. Every schedule and fault is seeded.
const DAY=86400000,owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// A linearizable in-memory metadata store: serialized transactions with full rollback on throw.
class MemoryMetadata {
 rows=new Map();queue=Promise.resolve();
 async get(key){return structuredClone(this.rows.get(key));}
 async put(key,value){this.rows.set(key,structuredClone(value));}
 async delete(key){this.rows.delete(key);}
 async list({prefix=''}={}){return new Map([...this.rows].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)));}
 transaction(operation){const result=this.queue.then(async()=>{const before=structuredClone(this.rows);try{return await operation(this);}catch(error){this.rows=before;throw error;}});this.queue=result.catch(()=>{});return result;}
}

test('signup admission chaos: interleaved free/paid/operator claims with mid-transaction and lost-reply faults never oversell or double-count a receipt',async()=>{
 await forEachSeed(12,async random=>{
  const store=new MemoryMetadata(),scheduler=createScheduler(random),limits={limit:6,freeLimit:3};
  // Faults inside the transaction roll back; lost replies (`after`) commit but report failure.
  const inner={transaction:fn=>store.transaction(tx=>fn(injectFaults(tx,[{method:'put',when:0.1}],{random})))};
  const metadata=scheduler.wrap(injectFaults(inner,[{method:'transaction',when:0.15,mode:'after'},{method:'transaction',when:0.05,mode:'timeout'}],{random}),'abuse');
  const operators=Array.from({length:4},()=>({id:randomUUID(),digest:random.int(16).toString(16).repeat(64)})),seen=[];
  const claim=async kind=>{
   if(kind!=='operator'){const result=await consumeSignupCapacity(metadata,{...limits,kind});if(result.admitted)seen.push(kind);return;}
   // Operator issuance retries the same receipt until it gets an answer.
   const op=random.pick(operators);for(let attempt=0;attempt<6;attempt++){try{const result=await consumeSignupCapacity(metadata,{...limits,kind,admissionId:op.id,admissionDigest:op.digest});if(result.admitted)seen.push('operator:'+op.id);return;}catch(error){if(!['injected_fault','timeout'].includes(error.code))throw error;}}
  };
  const results=await scheduler.run(Array.from({length:14},()=>()=>claim(random.pick(['free','free','paid','operator']))));
  for(const r of results)if(r.status==='rejected')assert(['injected_fault','timeout'].includes(r.reason.code),r.reason.stack);
  const lifetime=await store.get('lifetime')??0,free=(await store.get('signup-capacity/v1'))?.free??0,receipts=[...store.rows.keys()].filter(k=>k.startsWith('signup-operator/'));
  assert(lifetime<=limits.limit,`lifetime ${lifetime} exceeds ${limits.limit}`);assert(free<=limits.freeLimit&&free<=lifetime);
  const reported=seen.filter(k=>!k.startsWith('operator:')).length+new Set(seen.filter(k=>k.startsWith('operator:'))).size;
  assert(reported<=lifetime,'every reported admission is backed by a committed unit');
  assert(seen.filter(k=>k==='free').length<=limits.freeLimit);
  for(const key of new Set(seen.filter(k=>k.startsWith('operator:'))))assert(receipts.includes('signup-operator/'+key.slice(9)),'an admitted operator receipt is durable');
  // Each receipt spends exactly one unit no matter how often it was replayed.
  assert(receipts.length<=operators.length);assert(lifetime-free>=receipts.length);
 });
});

function lifecycleRig(random){
 const clock=fakeClock(100*DAY),metadata=new SqliteMetadata(':memory:'),scheduler=createScheduler(random);
 const world={faulty:false,protection:'unpaid',outcome:'accepted',finance:'ok',admin:{held:false,since:null,releasedAt:null},sent:[]};
 const ports=scheduler.wrap({
  reviewFinance:async args=>{if(world.finance==='throw')throw new Error('finance outage');return {...args,neverPaid:world.finance==='ok',checkedAt:clock.now(),expiresAt:clock.now()+300000};},
  sendNotice:async delivery=>{world.sent.push(delivery);if(world.outcome==='throw')throw Object.assign(new Error('provider down'),{code:'timeout'});return world.outcome==='accepted'?{accepted:true,receipt:'r-'+delivery.attemptId}:world.outcome==='suppressed'?{outcome:'failed',blocked:'suppressed'}:{outcome:world.outcome};},
  adminHold:async()=>structuredClone(world.admin),
  authorizeReactivation:async args=>({...args,verifiedAt:clock.now(),expiresAt:clock.now()+60000}),
 },'port');
 // Storage faults are injected only while scheduled work runs; set-up and invariant reads must not fail.
 const store={transaction:fn=>metadata.transaction(tx=>fn(injectFaults(tx,[{method:'put',when:()=>world.faulty&&random.chance(0.04)}],{random})))};
 const model=new AccountLifecycle({metadata:store,gate:scheduler.wrap(new SerialGate(),'gate'),config:{APP_ORIGIN:'https://lifecycle.example',POLAR_SERVER:'production'},clock:clock.now,
  protection:async()=>({status:world.protection}),contact:async()=>({verified:true,available:true,revision:'email-1'}),
  reviewFinance:ports.reviewFinance,sendNotice:ports.sendNotice,adminHold:ports.adminHold,authorizeReactivation:ports.authorizeReactivation});
 return {clock,metadata,scheduler,world,model};
}
const EXPECTED=new Set(['injected_fault','account_suspended','stale_reactivation','account_deleting','lifecycle_unarmed']);

test('lifecycle chaos: concurrent steps, activity and reactivation under faults and clock jumps keep state valid and epochs monotonic',async()=>{
 const phases=new Set();
 await forEachSeed(12,async random=>{
  const {clock,metadata,scheduler,world,model}=lifecycleRig(random);
  try{
   await metadata.put('owner',owner);await model.recordActivation(owner,{createdAt:clock.now()-1000,activatedAt:clock.now()});
   let last=await model.status(owner);const notices=new Map();
   for(let round=0;round<90;round++){
    // Mostly scheduler-like ticks; rare long jumps cross the inactivity window (or overshoot a notice deadline).
    clock.advance(random.chance(0.08)?400*DAY:random.pick([0,DAY/4,DAY,DAY,3*DAY,3*DAY]));
    const roll=random.next();world.outcome=roll<0.8?'accepted':roll<0.87?'unknown':roll<0.92?'failed':roll<0.97?'throw':'suppressed';world.finance=random.pick(['ok','ok','ok','ok','throw','paid']);
    // Payment protection and administrator holds come and go for single rounds.
    world.protection=random.chance(0.05)?'paid-protected':'unpaid';
    world.admin=world.admin.held?{held:false,since:null,releasedAt:clock.now()}:random.chance(0.04)?{held:true,since:clock.now(),releasedAt:null}:world.admin;
    // Mostly scheduler ticks, with occasional owner activity racing them, so every phase is reached.
    const work=Array.from({length:2+random.int(2)},()=>()=>model.step(owner));if(random.chance(0.12))work.push(random.chance(0.5)?()=>model.recordActivity(owner,{source:'owner-return'}):()=>model.reactivate(owner,{}));
    world.faulty=true;const results=await scheduler.run(work);world.faulty=false;
    for(const r of results)if(r.status==='rejected')assert(EXPECTED.has(r.reason.code),`round ${round}: ${r.reason.stack}`);
    const now=await model.status(owner);phases.add(now.phase);// validates the stored state; corrupt state would throw lifecycle_unavailable
    for(const key of ['generation','activityEpoch','capabilityEpoch'])assert(now[key]>=last[key],`${key} went backwards in round ${round}`);
    assert.notEqual(now.phase,'purging','purge is disabled');assert(now.attempts<=6);
    if(world.protection==='paid-protected'&&!world.admin.held){const settled=await model.step(owner);assert.equal(settled.phase,'active','paid protection always restores an active account');}
    for(const d of world.sent.splice(0)){const key=d.phase+':'+d.generation;notices.set(key,(notices.get(key)??0)+1);}
    last=await model.status(owner);
   }
   for(const [episode,count] of notices)assert(count<=6,`episode ${episode} sent ${count} notices`);
  }finally{metadata.close();}
 });
 assert(phases.has('suspended'),'the workload must reach suspension to exercise blocked-phase races');
});

test('lifecycle clock rollback fails closed and recovers once the clock passes the last observation',async t=>{
 const {clock,metadata,model}=lifecycleRig({int:()=>0,chance:()=>false,next:()=>0.5});t.after(()=>metadata.close());
 await metadata.put('owner',owner);await model.recordActivation(owner,{createdAt:clock.now()-1000,activatedAt:clock.now()});
 clock.advance(3*DAY);await model.step(owner);const observed=clock.now();
 clock.advance(-DAY);await assert.rejects(model.step(owner),{code:'lifecycle_unavailable'});await assert.rejects(model.recordActivity(owner,{source:'owner-return'}),{code:'lifecycle_unavailable'});
 clock.set(observed);assert.equal((await model.status(owner)).phase,'warning');
});

test('lifecycle scaling: three simulated years of daily ticks keep the state record and notice evidence bounded',async t=>{
 const {clock,metadata,world,model}=lifecycleRig({int:()=>0,chance:()=>false,next:()=>0.5});t.after(()=>metadata.close());
 await metadata.put('owner',owner);await model.recordActivation(owner,{createdAt:clock.now()-1000,activatedAt:clock.now()});let largest=0,sent=0;
 for(let day=0;day<3*365;day++){
  clock.advance(DAY);world.outcome=day%5?'accepted':'unknown';
  const r=await model.step(owner);if(r.phase==='suspended'&&day%60===0)await model.reactivate(owner,{});else if(day%500===0)await model.recordActivity(owner,{source:'resource-use'}).catch(e=>assert.equal(e.code,'account_suspended'));
  largest=Math.max(largest,JSON.stringify(await metadata.get('lifecycle/state-v1')).length);sent+=world.sent.splice(0).length;
 }
 assert(largest<6000,`state grew to ${largest} bytes`);assert(sent>0);
 const state=await metadata.get('lifecycle/state-v1');assert((state.notice?.attempts.length??0)<=6);
});

class Accounts {records=new Map();async get(id){return structuredClone(this.records.get(id)??null);}async compareAndSwap(id,revision,value){if(this.records.get(id)?.revision!==revision)return false;this.records.set(id,structuredClone(value));return true;}}

test('tombstone chaos: racing session writers never resurrect credentials, and a lost race leaves the account intact',async()=>{
 await forEachSeed(25,async random=>{
  const repository=new Accounts(),scheduler=createScheduler(random),id=randomUUID(),gated=scheduler.wrap(repository,'identity');
  repository.records.set(id,{id,revision:0,handle:'n.42',assignmentId:'assign-1',status:'active',createdAt:1,verifiedEmail:'owner@example.example',passwordHash:'hash',recoveryHash:'recovery',credentials:[{id:'c1'}],sessions:[],challenges:[],audit:[]});
  const port=lifecycleIdentityPort(gated,{clock:()=>5000});
  // Mirrors the identity service: a session is added only to an active account, by revision-checked swap.
  const writer=async n=>{let added=0;for(let attempt=0;attempt<4;attempt++){const account=await gated.get(id);if(account.status!=='active')return added?'added':'refused';account.sessions.push({id:'s'+n+'-'+attempt});account.revision++;if(await gated.compareAndSwap(id,account.revision-1,account))added++;}return added?'added':'conflict';};
  const results=await scheduler.run([()=>port.tombstone(id,{assignmentId:'assign-1'}),...Array.from({length:1+random.int(4)},(_,n)=>()=>writer(n))]);
  const final=repository.records.get(id),[tomb]=results;
  if(tomb.status==='fulfilled'){
   assert.equal(tomb.value,true);assert.equal(final.status,'deleted');
   assert.deepEqual([final.sessions,final.credentials,final.passwordHash,final.recoveryHash,final.verifiedEmail],[[],[],null,null,undefined]);
   assert.deepEqual([final.handle,final.assignmentId,final.id],['n.42','assign-1',id],'the name and assignment stay bound forever');
   assert.equal(await port.tombstone(id,{assignmentId:'assign-1'}),true,'tombstoning is idempotent');
  }else{assert.equal(tomb.reason.code,'lifecycle_identity_conflict');assert.equal(final.status,'active');assert.equal(final.passwordHash,'hash');}
  await assert.rejects(port.tombstone(id,{assignmentId:'reassigned'}),{code:'lifecycle_assignment_changed'},'a stale assignment never tombstones a reassigned identity');
 });
});
