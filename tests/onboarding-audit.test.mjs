import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {IdentityRepository,FixedWindowGuard} from '../packages/runtime/accounts.mjs';
import {IdentityService} from '../packages/identity/service.mjs';
import {onboardingPort,signOnboardingInvitation,verifyOnboardingInvitation,signOnboardingIssuance} from '../packages/identity/onboarding.mjs';
import {encode} from '../packages/identity/crypto.mjs';
import application from '../packages/runtime/http.mjs';

const origin='https://onboarding.example',now=1791979200000,key=encode(new Uint8Array(32).fill(63));
function fixture(){
 const metadata=new SqliteMetadata(':memory:'),budget=new SqliteMetadata(':memory:');
 const config={APP_ORIGIN:origin,ONBOARDING_ENABLED:'true',ONBOARDING_KEY:key,ONBOARDING_NAMES:['alice','bob'],SIGNUP_MAX_ADMISSIONS:10,SIGNUP_FREE_MAX_ADMISSIONS:1};
 const repository=new IdentityRepository({metadata,config}),guard=new FixedWindowGuard({metadata:budget});
 const port=onboardingPort({config,repository,authority:{consumeSignup:(_scope,input)=>guard.consumeSignup(input)},clock:()=>now});
 const service=new IdentityService({repository,onboarding:port,clock:()=>now,config:{...config,origin,rpID:'onboarding.example',termsVersion:'v1',requireReachability:false},turnstile:{verify:async()=>true},rateLimiter:{check:async()=>true},passwordHasher:{hash:async value=>'hash:'+value,verify:async(value,hash)=>hash==='hash:'+value},webauthn:{registrationOptions:async()=>({challenge:'fixture'})},paidHandleEligibility:async()=>true});
 const claims={version:1,purpose:'bindle-ordinary-account-onboarding',issuer:origin,nonce:crypto.randomUUID(),issuedAt:now,expiresAt:now+3600000,names:['alice','bob'].map(name=>({name,owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()}))};
 const context={origin,remoteIP:'192.0.2.3',setupBinding:'private-fixture-binding'};
 const input={method:'password',password:'long ordinary onboarding password',termsAccepted:true,termsVersion:'v1',turnstileToken:'fixture'};
 return {metadata,budget,repository,guard,config,port,service,claims,context,input,close(){metadata.close();budget.close();}};
}
async function invitation(f){const token=await signOnboardingInvitation(f.claims,key,{now}),verified=await verifyOnboardingInvitation(token,key,origin,{now}),proof=await signOnboardingIssuance(verified.digest,origin,key,{now});return {token,proof};}

test('configured ordinary name is protected before issuance even through paid mixed-case input',async()=>{
 const f=fixture();try{
  const id=crypto.randomUUID(),assignmentId=crypto.randomUUID(),handle=await f.repository.allocateFreeHandle(undefined,id,assignmentId);
  const account={id,assignmentId,handle,revision:0,status:'active',credentials:[],sessions:[]};
  assert.equal(await f.repository.create(account),true);
  f.service.recent=async()=>({account});
  f.service.onboarding=null;f.service.config.ONBOARDING_ENABLED='false';
  await assert.rejects(f.service.claimHandle({handle:'ALICE'},f.context),{code:'reserved_handle'});
  assert.equal(await f.repository.onboardingLookup('alice'),null);
  assert.equal((await f.repository.get(id)).paidHandle,undefined);
 }finally{f.close();}
});

test('partial issuance reserves permanently but does not expose a usable invitation until resumed',async()=>{
 const f=fixture();try{
  const {token,proof}=await invitation(f),reserve=f.repository.reserveOnboardingIdentity.bind(f.repository);let fail=true;
  f.repository.reserveOnboardingIdentity=async(item,...rest)=>{if(item.name==='bob'&&fail)throw Error('Interrupted second reservation');return reserve(item,...rest);};
  await assert.rejects(f.port.issue(token,proof),/Interrupted/);
  assert.equal((await f.repository.onboardingLookup('alice')).state,'operator-alias');
  await assert.rejects(f.port.inspect(token),{code:'onboarding_not_issued'});
  assert.equal(await f.budget.get('lifetime'),undefined);
  fail=false;await f.port.issue(token,proof);
  assert.deepEqual((await f.port.inspect(token)).names.map(entry=>entry.status),['available','available']);
  const replacement={...f.claims,nonce:crypto.randomUUID(),names:f.claims.names.map(item=>({...item,owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()}))};
  const other=await signOnboardingInvitation(replacement,key,{now}),otherDigest=(await verifyOnboardingInvitation(other,key,origin,{now})).digest;
  await assert.rejects(f.port.issue(other,await signOnboardingIssuance(otherDigest,origin,key,{now})),{code:'onboarding_name_unavailable'});
 }finally{f.close();}
});

test('multi-name capacity is per assignment and lost debit acknowledgement never charges another slot',async()=>{
 const f=fixture();try{
  const {token,proof}=await invitation(f);await f.port.issue(token,proof);
  const binding=await f.service.crypto.hash('onboarding-setup-browser',f.context.setupBinding),consume=f.guard.consumeSignup.bind(f.guard);let lost=true;
  f.guard.consumeSignup=async input=>{const result=await consume(input);if(lost){lost=false;throw Error('Lost debit acknowledgement');}return result;};
  await assert.rejects(f.port.prepare(token,'alice',binding),/Lost debit/);
  await f.port.prepare(token,'alice',binding);assert.equal(await f.budget.get('lifetime'),1);
  await f.port.prepare(token,'bob',binding);assert.equal(await f.budget.get('lifetime'),2);
  assert.equal((await f.budget.get('signup-capacity/v1')).free,0);
  for(const item of f.claims.names)assert.equal((await f.budget.get('signup-operator/'+item.assignmentId)).version,1);
  await f.budget.delete('signup-operator/'+f.claims.names[0].assignmentId);
  await assert.rejects(f.port.prepare(token,'alice',binding),{code:'signup_capacity_unavailable'});
  assert.equal(await f.budget.get('lifetime'),2);
 }finally{f.close();}
});

test('ordinary issued identity cannot acquire system metadata or replacement setup authority through replay',async()=>{
 const f=fixture();try{
  const {token,proof}=await invitation(f);await f.port.issue(token,proof);
  const pending=await f.service.claimOnboarding({...f.input,name:'alice',onboardingToken:token},f.context);
  assert.equal(pending.account.systemBadge,undefined);assert.equal(pending.paymentRequired,false);
  assert.equal((await f.repository.findByHandle('ALICE')).id,f.claims.names[0].owner);
  await assert.rejects(f.service.claimOnboarding({...f.input,name:'alice',onboardingToken:token},f.context),{code:'onboarding_invitation_consumed'});
  const account=await f.repository.get(pending.account.id);
  assert.equal(await f.repository.compareAndSwap(account.id,account.revision,{...account,revision:account.revision+1,onboardingIdentity:undefined}),false);
  assert.equal(await f.repository.compareAndSwap(account.id,account.revision,{...account,revision:account.revision+1,systemIdentity:{role:'system'}}),false);
  const resumed=await f.service.loginPassword({handle:'alice',password:f.input.password,turnstileToken:'fixture'},f.context);
  assert.equal(resumed.resumed,true);assert.notEqual(resumed.pendingToken,pending.pendingToken);assert.equal(resumed.sessionToken,undefined);
  await assert.rejects(f.service.downloadRecovery({pendingToken:pending.pendingToken},f.context),{code:'unauthorized'});
 }finally{f.close();}
});

test('issuance proof and ordinary invitation are purpose-separated and cannot widen public signup',async()=>{
 const f=fixture();try{
  const {token,proof}=await invitation(f);
  await assert.rejects(f.port.issue(token,token),{code:'invalid_onboarding_invitation'});
  await assert.rejects(f.port.inspect(proof),{code:'invalid_onboarding_invitation'});
  await assert.rejects(verifyOnboardingInvitation(token,key,'https://other.example',{now}),{code:'invalid_onboarding_invitation'});
  await assert.rejects(f.service.signup({...f.input,signupPlan:'operator'},f.context),{code:'invalid_plan'});
  await assert.rejects(f.service.claimOnboarding({...f.input,onboardingToken:token,name:'alice',role:'system'},f.context),{code:'invalid_onboarding_request'});
  await assert.rejects(f.service.claimOnboarding({...f.input,onboardingToken:token,name:'alice',badgeIds:['system']},f.context),{code:'invalid_onboarding_request'});
  assert.equal(await f.budget.get('lifetime'),undefined);
 }finally{f.close();}
});

test('malformed optional badge definitions do not prevent the console reading its public setup configuration',async()=>{
 let identityCalls=0;
 const env={APP_ORIGIN:origin,LOCAL_DEVELOPMENT:'true',SIGNUP_ENABLED:'false',HOST_NAME_POLICY:'{',BADGE_DEFINITIONS:'{',ONBOARDING_NAMES:['private-allowed-name'],IDENTITY_ENGINE(){identityCalls++;throw Error('Unexpected identity access');}};
 const response=await application.fetch(new Request(origin+'/api/config'),env);
 assert.equal(response.status,200);
 const config=await response.json();
 assert.deepEqual(config.badgePolicy,{path:null,definitions:[]});assert.equal(config.signupEnabled,false);assert.equal(config.tokenOnboardingEnabled,false);assert.equal(identityCalls,0);
 delete env.BADGE_DEFINITIONS;
 const validBadges=await(await application.fetch(new Request(origin+'/api/config'),env)).json();
 assert.match(validBadges.badgePolicy.path,/^\/api\/badges\/sprite\.svg\?v=[a-f0-9]{64}$/);
 assert(validBadges.badgePolicy.definitions.every(value=>Object.keys(value).sort().join(',')==='description,id,name'));
 assert.equal(JSON.stringify(validBadges).includes('private-allowed-name'),false);assert.equal(JSON.stringify(validBadges.badgePolicy).includes('<svg'),false);
});

test('injected badge resolver receives only frozen public identity selectors and never becomes credential authority',async()=>{
 const f=fixture();try{
  f.claims.names[0].badgeIds=['system'];
  const {token,proof}=await invitation(f);await f.port.issue(token,proof);
  const pending=await f.service.claimOnboarding({...f.input,onboardingToken:token,name:'alice'},f.context);
  let descriptor;
  f.service.resolveIdentityBadges=identity=>{descriptor=identity;return ['unknown','system'];};
  const resumed=await f.service.loginPassword({handle:'alice',password:f.input.password,turnstileToken:'fixture'},f.context);
  assert.equal(resumed.resumed,true);assert.equal(resumed.sessionToken,undefined);assert.deepEqual(resumed.account.badges,['system']);
  assert.deepEqual(Object.keys(descriptor).sort(),['aliases','badgeIds','handle','id','status']);
  assert(Object.isFrozen(descriptor));assert(Object.isFrozen(descriptor.aliases));assert(Object.isFrozen(descriptor.badgeIds));
  assert.equal(JSON.stringify(descriptor).includes('hash:'),false);assert.equal(JSON.stringify(descriptor).includes(resumed.pendingToken),false);
  f.service.resolveIdentityBadges=()=>{throw Error('Private backend detail');};
  const failed=await f.service.loginPassword({handle:'alice',password:f.input.password,turnstileToken:'fixture'},f.context);
  assert.equal(failed.resumed,true);assert.deepEqual(failed.account.badges,[]);assert.equal(JSON.stringify(failed).includes('Private backend detail'),false);
  f.service.resolveIdentityBadges=()=>new Promise(()=>{});
  const started=performance.now(),timed=await f.service.loginPassword({handle:'alice',password:f.input.password,turnstileToken:'fixture'},f.context);
  assert.equal(timed.resumed,true);assert.deepEqual(timed.account.badges,[]);assert(performance.now()-started<2000,'optional asynchronous resolver must not hang credential resumption');
  assert.equal((await f.repository.get(pending.account.id)).status,'pending');
 }finally{f.close();}
});

test('explicit formerly reserved ordinary alias survives policy removal while trusted badge IDs remain editable',async()=>{
 const f=fixture();try{
  const policy={version:1,reserved:[],onboarding:['admin']};
  f.config.HOST_NAME_POLICY=policy;f.service.config.HOST_NAME_POLICY=policy;
  f.claims.names=[{...f.claims.names[0],name:'admin',badgeIds:['system']}];
  const {token,proof}=await invitation(f);await f.port.issue(token,proof);
  const pending=await f.service.claimOnboarding({...f.input,onboardingToken:token,name:'admin'},f.context);
  assert.equal(pending.account.systemBadge,undefined);assert.deepEqual(pending.account.badges,['system']);
  const account=await f.repository.get(pending.account.id);assert.equal(account.systemIdentity,undefined);
  assert.equal(await f.repository.compareAndSwap(account.id,account.revision,{...account,revision:account.revision+1,badgeIds:[]}),true);
  f.config.HOST_NAME_POLICY={version:1,reserved:[],onboarding:[]};f.service.config.HOST_NAME_POLICY=f.config.HOST_NAME_POLICY;
  const resumed=await f.service.loginPassword({handle:'ADMIN',password:f.input.password,turnstileToken:'fixture'},f.context);
  assert.equal(resumed.account.id,pending.account.id);assert.equal(resumed.resumed,true);assert.deepEqual(resumed.account.badges,[]);
  assert.equal((await f.repository.onboardingLookup('admin')).state,'operator-alias');
 }finally{f.close();}
});
