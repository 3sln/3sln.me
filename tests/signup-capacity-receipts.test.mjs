// Redelivered signup-capacity claims (an RPC retried after a lost reply) must
// spend one lifetime unit per signup. Free/paid signups carry the new account ID
// as an admission receipt; operator/system admissions already did.
import test from 'node:test';import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';import {FixedWindowGuard} from '../packages/runtime/accounts.mjs';
import {injectFaults,createScheduler,forEachSeed} from './helpers/chaos.mjs';
import {identityEngine,signupInput} from './helpers/identity-engine.mjs';

const limits={limit:3,freeLimit:2},digest=id=>id.replaceAll('-','').padEnd(64,'0').slice(0,64);

test('a duplicated free or paid capacity claim with one admission receipt spends a single unit',async t=>{
 const metadata=new SqliteMetadata(':memory:');t.after(()=>metadata.close());
 const guard=injectFaults(new FixedWindowGuard({metadata}),[{method:'consumeSignup',mode:'duplicate'}]);
 const first=crypto.randomUUID(),second=crypto.randomUUID(),paid=crypto.randomUUID();
 assert.deepEqual(await guard.consumeSignup({...limits,kind:'free',admissionId:first,admissionDigest:digest(first)}),{admitted:true});
 assert.deepEqual(await guard.consumeSignup({...limits,kind:'free',admissionId:second,admissionDigest:digest(second)}),{admitted:true});
 assert.deepEqual(await guard.consumeSignup({...limits,kind:'free',admissionId:crypto.randomUUID(),admissionDigest:digest(paid)}),{admitted:false,capacity:'free'},'two free units were spent, not four');
 assert.deepEqual(await guard.consumeSignup({...limits,kind:'paid',admissionId:paid,admissionDigest:digest(paid)}),{admitted:true});
 assert.deepEqual(await guard.consumeSignup({...limits,kind:'paid',admissionId:paid,admissionDigest:digest(paid)}),{admitted:true},'a later retry of an admitted signup stays admitted at the cap');
 assert.deepEqual(await guard.consumeSignup({...limits,kind:'paid',admissionId:crypto.randomUUID(),admissionDigest:digest(first)}),{admitted:false,capacity:'global'});
 await assert.rejects(guard.consumeSignup({...limits,kind:'free',admissionId:first,admissionDigest:digest(second)}),{code:'signup_capacity_unavailable'},'a reused receipt with different content fails closed');
 await assert.rejects(guard.consumeSignup({...limits,kind:'free',admissionId:'not-a-uuid',admissionDigest:digest(first)}),{code:'signup_capacity_unavailable'});
});

test('chaos: interleaved and redelivered signups never exceed the cap and never charge one signup twice',async()=>{
 await forEachSeed(15,async random=>{
  const metadata=new SqliteMetadata(':memory:');try{
   const scheduler=createScheduler(random),guard=scheduler.wrap(injectFaults(new FixedWindowGuard({metadata}),[{method:'consumeSignup',mode:'duplicate',when:()=>random.chance(0.5)}],{random}),'guard');
   const ids=Array.from({length:6},()=>crypto.randomUUID());
   const results=await scheduler.run(ids.map(id=>()=>guard.consumeSignup({limit:4,freeLimit:4,kind:'free',admissionId:id,admissionDigest:digest(id)})));
   const admitted=results.filter(r=>r.value?.admitted===true).length;
   assert.equal(admitted,4,`each admitted signup spends exactly one of four units; trace ${scheduler.trace.join(' | ')}`);
   assert.deepEqual(await new FixedWindowGuard({metadata}).signupStatus({limit:4,freeLimit:4}),{globalAvailable:false,freeAvailable:false});
  }finally{metadata.close();}
 });
});

test('the identity engine presents the new account ID as the signup admission receipt',async()=>{
 const seen=[],{act}=identityEngine({rateLimiter:{check:async input=>{if(input.phase==='admitted')seen.push(input.admissionId);return true;}}});
 const pending=await act('signup',signupInput());
 assert.deepEqual(seen,[pending.account.id]);
});
