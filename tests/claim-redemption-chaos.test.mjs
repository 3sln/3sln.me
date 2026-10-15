// Revocation racing redemption of an administrator-minted onboarding claim, at
// the engine level: real IdentityService, onboarding port, sharded identity
// storage and AdminService over in-memory stores, interleaved by the seeded
// scheduler. Exactly one side may win; rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';import {FixedWindowGuard} from '../packages/runtime/accounts.mjs';
import {IdentityShardStorage,ShardedIdentityRepository,IDENTITY_LAYOUT} from '../packages/runtime/identity-shards.mjs';
import {IdentityService} from '../packages/identity/service.mjs';import {encode} from '../packages/identity/crypto.mjs';import {onboardingPort,onboardingAlias} from '../packages/identity/onboarding.mjs';
import {mintBootToken,bootTokenDigest} from '../packages/identity/boot.mjs';import {AdminStorage,remoteAdminStore} from '../packages/identity/admin-store.mjs';import {AdminService} from '../packages/identity/admin.mjs';
import {createScheduler,forEachSeed,fakeClock} from './helpers/chaos.mjs';

const origin='https://admin.example',key=encode(new Uint8Array(32).fill(77));
function fixture(random){
 const clock=fakeClock(1792000000000),stores=[],db=()=>{const value=new SqliteMetadata(':memory:');stores.push(value);return value;},shards=new Map(),scheduler=createScheduler(random);
 const shard=name=>{if(!shards.has(name)){const storage=new IdentityShardStorage(db());shards.set(name,{storage,stub:scheduler.wrap(new Proxy({},{get:(_,method)=>method==='then'||typeof method==='symbol'?undefined:(...args)=>storage[method.slice(5,6).toLowerCase()+method.slice(6)](...args)}),name)});}return shards.get(name).stub;};
 const config={APP_ORIGIN:origin,ONBOARDING_KEY:key,BOOT_ACCESS_HOURS:'24',SIGNUP_MAX_ADMISSIONS:50,SIGNUP_FREE_MAX_ADMISSIONS:10};
 const repository=new ShardedIdentityRepository({shard,layout:IDENTITY_LAYOUT,clock:clock.now}),storage=new AdminStorage(db());
 const store=scheduler.wrap(remoteAdminStore(async(method,args)=>structuredClone(await storage.invoke(method,structuredClone(args)))),'admin');
 const guard=new FixedWindowGuard({metadata:db()}),passwordHasher={hash:async x=>'hash:'+x,verify:async(x,h)=>h==='hash:'+x},rateLimiter={check:async()=>true},webauthn={registrationOptions:async()=>({challenge:'reg'}),authenticationOptions:async()=>({challenge:'auth'})};
 let admin;
 const onboarding=onboardingPort({config,repository,authority:{consumeSignup:(_,input)=>guard.consumeSignup(input)},clock:clock.now,runtimeName:(name,digest)=>admin.runtimeName(name,digest),redeemName:(name,digest)=>admin.redeemName(name,digest)});
 const identity=new IdentityService({repository,onboarding,clock:clock.now,reservedHandle:name=>admin.isReserved(name),config:{...config,origin,rpID:'admin.example',termsVersion:'v1'},turnstile:{verify:async()=>true},rateLimiter,webauthn,passwordHasher});
 admin=new AdminService({store,identity,onboarding,webauthn,passwordHasher,rateLimiter,clock:clock.now,config});
 const ctx=(extra={})=>({origin,remoteIP:'192.0.2.9',...extra});
 async function boot(){const token=mintBootToken(origin,{now:clock.now()});config.BOOTSTRAP_TOKEN_SHA256=await bootTokenDigest(token);await admin.bootStart({bootToken:token},ctx({setupBinding:'boot-browser'}));const result=await admin.bootComplete({bootToken:token,method:'password',password:'long boot operator password',acknowledgeExpiry:true},ctx({setupBinding:'boot-browser'}));return ctx({actor:'boot',bootSession:result.sessionToken,csrfToken:result.csrfToken});}
 return {repository,storage,identity,admin,scheduler,ctx,boot,close:()=>stores.forEach(s=>s.close())};
}

test('chaos: revoking a claim while it is redeemed serializes on the claim record and exactly one side wins',async()=>{
 const outcomes=new Set();
 await forEachSeed(30,async random=>{const f=fixture(random);try{
  const boot=await f.boot(),name='staff-member';await f.admin.reserve({name},boot);const minted=await f.admin.mintClaim({name},boot);
  const onboardingToken=decodeURIComponent(minted.link.split('#token=')[1]),setup=f.ctx({setupBinding:'claim-browser'});
  const [redeem,revoke]=await f.scheduler.run([
   ()=>f.identity.claimOnboarding({onboardingToken,name,method:'password',password:'long internal account password',termsAccepted:true,termsVersion:'v1',turnstileToken:'ok'},setup),
   ()=>f.admin.revokeClaim({nonce:minted.nonce},boot)]);
  const trace=`trace ${f.scheduler.trace.join(' | ')}`,claim=await f.storage.get('claim/'+minted.nonce),row=await f.repository.onboardingLookup(name);
  assert.notEqual(redeem.status===revoke.status,true,`exactly one of redemption and revocation wins; ${trace}`);
  if(revoke.status==='fulfilled'){
   outcomes.add('revoked');assert.deepEqual(revoke.value,{revoked:true});assert.equal(claim.state,'revoked');
   assert.equal(row.onboarding.phase,'preissued',`a revoked claim never takes the name; ${trace}`);assert.equal(row.onboarding.binding,null);
   assert.equal(await f.repository.get(row.owner),null,'no account was created');assert.equal(await f.repository.findByHandle(name),null,'nobody holds the alias');
  }else{
   outcomes.add('redeemed');assert.equal(revoke.reason.code,'claim_in_use',`revocation reports already redeemed, not ${revoke.reason.code}; ${trace}`);
   assert.notEqual(claim.state,'revoked','revocation never half-applies');assert(Number.isSafeInteger(claim.redeemedAt));
   const account=await f.repository.get(redeem.value.account.id);assert.equal(onboardingAlias(account),name);
   assert.equal((await f.admin.principalFor(account)).internal,true,'the redeemed account keeps claim provenance');
   // Afterwards, revocation keeps refusing and never strips provenance.
   await assert.rejects(f.admin.revokeClaim({nonce:minted.nonce},boot),{code:'claim_in_use'});assert.equal((await f.admin.principalFor(account)).internal,true);
  }
 }finally{f.close();}});
 assert.deepEqual([...outcomes].sort(),['redeemed','revoked'],'the seeds exercise both winners');
});
