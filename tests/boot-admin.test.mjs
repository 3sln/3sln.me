import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {SqliteMetadata} from '../apps/node/resources.mjs';import {IdentityRepository,FixedWindowGuard} from '../packages/runtime/accounts.mjs';import {IdentityShardStorage,ShardedIdentityRepository,IDENTITY_LAYOUT,ONBOARDING_RELEASE_GRACE_MS} from '../packages/runtime/identity-shards.mjs';
import {IdentityService} from '../packages/identity/service.mjs';import {encode} from '../packages/identity/crypto.mjs';import {onboardingPort,signOnboardingInvitation} from '../packages/identity/onboarding.mjs';import {signSystemInvitation} from '../packages/identity/system-bootstrap.mjs';
import {configuredNamePolicy,configuredReservedName} from '../packages/identity/badge-policy.mjs';import {mintBootToken,bootTokenDigest,verifyBootToken} from '../packages/identity/boot.mjs';import {AdminStorage,remoteAdminStore} from '../packages/identity/admin-store.mjs';import {AdminService} from '../packages/identity/admin.mjs';import {validateCatalog,effectiveAuthority} from '../packages/identity/roles.mjs';import {adminRoutes} from '../packages/runtime/admin-http.mjs';
const origin='https://admin.example',start=1792000000000,key=encode(new Uint8Array(32).fill(77)),PASSWORD='long boot operator password',BADGES=JSON.stringify([{id:'system',name:'System',description:'Host staff.',svg:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>'},{id:'beta',name:'Beta',description:'Beta tester.',svg:'<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20"/></svg>'}]);
function fixture(worker=false){
 let now=start;const stores=[],db=()=>{const value=new SqliteMetadata(':memory:');stores.push(value);return value;},budget=db(),shards=new Map();
 const shard=name=>{if(!shards.has(name))shards.set(name,new IdentityShardStorage(db()));const storage=shards.get(name);return new Proxy({},{get:(_,method)=>method==='then'?undefined:(...args)=>storage[method.slice(5,6).toLowerCase()+method.slice(6)](...args)});};
 const config={APP_ORIGIN:origin,ONBOARDING_KEY:key,BADGE_DEFINITIONS:BADGES,BOOT_ACCESS_HOURS:'24',SIGNUP_MAX_ADMISSIONS:50,SIGNUP_FREE_MAX_ADMISSIONS:1};
 const repository=worker?new ShardedIdentityRepository({shard,layout:IDENTITY_LAYOUT,clock:()=>now}):new IdentityRepository({metadata:db(),config});
 // Worker-style store: a single authority behind a structured-clone RPC boundary.
 const storage=new AdminStorage(db()),store=worker?remoteAdminStore(async(method,args)=>structuredClone(await storage.invoke(method,structuredClone(args)))):storage,guard=new FixedWindowGuard({metadata:budget});
 const webauthn={registrationOptions:async()=>({challenge:'reg-challenge'}),verifyRegistration:async({response})=>{if(response?.ok!==true)throw Error('bad');return {id:response.id,publicKey:'pk',counter:0};},authenticationOptions:async()=>({challenge:'auth-challenge'}),verifyAuthentication:async({response})=>{if(response?.ok!==true)throw Error('bad');return {counter:1,backedUp:false};}};
 let admin;const passwordHasher={hash:async x=>'hash:'+x,verify:async(x,h)=>h==='hash:'+x},rateLimiter={check:async()=>true};
 const onboarding=onboardingPort({config,repository,authority:{consumeSignup:(_,input)=>guard.consumeSignup(input)},clock:()=>now,runtimeName:(name,digest)=>admin.runtimeName(name,digest),redeemName:(name,digest)=>admin.redeemName(name,digest)});
 const identity=new IdentityService({repository,onboarding,clock:()=>now,reservedHandle:name=>admin.isReserved(name),config:{...config,origin,rpID:'admin.example',termsVersion:'v1',requireReachability:false},turnstile:{verify:async()=>true},rateLimiter,webauthn,passwordHasher,paidHandleEligibility:async()=>true});
 admin=new AdminService({store,identity,onboarding,webauthn,passwordHasher,rateLimiter,clock:()=>now,config});
 const ctx=(extra={})=>({origin,remoteIP:'192.0.2.9',...extra});
 async function deploy(at=now){const token=mintBootToken(origin,{now:at});config.BOOTSTRAP_TOKEN_SHA256=await bootTokenDigest(token);return token;}
 async function claimBoot(token,binding='boot-browser',password=PASSWORD){await admin.bootStart({bootToken:token},ctx({setupBinding:binding}));const result=await admin.bootComplete({bootToken:token,method:'password',password,acknowledgeExpiry:true},ctx({setupBinding:binding}));return {...result,context:ctx({actor:'boot',bootSession:result.sessionToken,csrfToken:result.csrfToken})};}
 async function activate(link,name,password='long internal account password'){const onboardingToken=decodeURIComponent(link.split('#token=')[1]),c=ctx({setupBinding:'claim-'+name}),pending=await identity.claimOnboarding({onboardingToken,name,method:'password',password,termsAccepted:true,termsVersion:'v1',turnstileToken:'ok'},c),file=await identity.downloadRecovery(pending,c),active=await identity.confirmRecovery({...pending,...file,downloadConfirmed:true},c);const context=ctx({actor:'admin',sessionToken:active.sessionToken,csrfToken:active.csrfToken});return {id:active.account.id,context,password,stepUp:()=>identity.stepUp({method:'password',password},context)};}
 async function user(extra={}){const id=crypto.randomUUID(),assignmentId=crypto.randomUUID(),handle=await repository.allocateFreeHandle(undefined,id,assignmentId),{verifiedEmail,...rest}=extra,account={id,assignmentId,handle,revision:0,status:'active',createdAt:now,lastActiveAt:now,credentials:[],sessions:[],challenges:[],audit:[],badgeIds:[],passwordHash:'hash:secret user password',recoveryHash:'recovery-secret-hash',...rest};assert(await repository.create(account));if(verifiedEmail)assert(await repository.compareAndSwap(id,0,{...account,revision:1,verifiedEmail}));return repository.get(id);}
 async function makeAdmin(boot,name){await admin.reserve({name},boot.context);const minted=await admin.mintClaim({name,roles:['admin']},boot.context),member=await activate(minted.link,name);await member.stepUp();return member;}
 // Runs the identity storage alarm sweep on every namespace store at an explicit time.
 async function sweep(at=now){if(!worker)return (await repository.shardOnboardingSweep({now:at})).released;const released=[];for(const [shardName,shardStorage]of shards)if(shardName.startsWith('identity-v1/namespace/'))released.push(...(await shardStorage.onboardingSweep({now:at})).released);return released.sort();}
 return {config,repository,store,storage,identity,admin,ctx,deploy,claimBoot,activate,user,makeAdmin,sweep,advance:ms=>now+=ms,now:()=>now,close:()=>stores.forEach(s=>s.close())};
}
const both=(title,body)=>{for(const worker of [false,true])test(`${worker?'Worker-style':'Node SQLite'}: ${title}`,async()=>{const f=fixture(worker);try{await body(f);}finally{f.close();}});};

// Window, skew and typed-claim edges live in admin-engine-edges.test.mjs.
test('boot tokens match the configured digest (case-insensitively) in constant time before any claim parsing',async()=>{
 const token=mintBootToken(origin,{now:start}),digest=await bootTokenDigest(token),config={APP_ORIGIN:origin,BOOTSTRAP_TOKEN_SHA256:digest.toUpperCase()};
 assert.equal((await verifyBootToken(token,config,{now:start+60000})).digest,digest);
 const calls=[];const spy=(a,b)=>{calls.push([a.length,b.length]);return false;};
 for(const other of [mintBootToken(origin,{now:start}),token.slice(0,-1)+(token.at(-1)==='A'?'B':'A')])await assert.rejects(verifyBootToken(other,config,{now:start,compare:spy}),{code:'invalid_boot_token'});
 assert.deepEqual(calls,[[64,64],[64,64]]);
 await assert.rejects(verifyBootToken(token,{APP_ORIGIN:origin},{now:start}),{code:'boot_unavailable'});
});

both('a boot token is used exactly once across claim and restore, including concurrent races',async f=>{
 const token=await f.deploy(),[a,b]=await Promise.allSettled([f.admin.bootStart({bootToken:token},f.ctx({setupBinding:'browser-a'})),f.admin.bootStart({bootToken:token},f.ctx({setupBinding:'browser-b'}))]);
 assert.equal([a,b].filter(r=>r.status==='fulfilled').length,1);const winner=a.status==='fulfilled'?'browser-a':'browser-b',loser=winner==='browser-a'?'browser-b':'browser-a';
 assert.equal((await f.admin.bootStart({bootToken:token},f.ctx({setupBinding:winner}))).mode,'claim');
 await assert.rejects(f.admin.bootComplete({bootToken:token,method:'password',password:PASSWORD,acknowledgeExpiry:true},f.ctx({setupBinding:loser})),{code:'boot_token_consumed'});
 await assert.rejects(f.admin.bootComplete({bootToken:token,method:'password',password:PASSWORD,acknowledgeExpiry:false},f.ctx({setupBinding:winner})),{code:'acknowledgement_required'});
 const done=await Promise.allSettled([1,2].map(()=>f.admin.bootComplete({bootToken:token,method:'password',password:PASSWORD,acknowledgeExpiry:true},f.ctx({setupBinding:winner}))));
 assert.equal(done.filter(r=>r.status==='fulfilled').length,1);assert.equal(done.find(r=>r.status==='rejected').reason.code,'boot_token_consumed');
 // The same token can neither claim again nor restore an existing boot.
 for(const binding of [winner,loser,'browser-c'])await assert.rejects(f.admin.bootStart({bootToken:token},f.ctx({setupBinding:binding})),{code:'boot_token_consumed'});
 assert.equal((await f.admin.bootStatus({},f.ctx())).token,'used');
 const principal=await f.store.get('boot/principal');assert.equal(principal.generation,1);assert.equal(principal.passwordHash,'hash:'+PASSWORD);
 await assert.rejects(f.store.commit({writes:{['boot-token/'+f.config.BOOTSTRAP_TOKEN_SHA256]:null}}),{code:'boot_token_consumed'});
 await assert.rejects(f.store.commit({writes:{['boot-token/'+f.config.BOOTSTRAP_TOKEN_SHA256]:{phase:'reserved'}}}),{code:'boot_token_consumed'});
 // A stale configuration redeployed later is refused by the consumed record and its mint window.
 f.advance(1800001);await assert.rejects(f.admin.bootStart({bootToken:token},f.ctx({setupBinding:'browser-d'})),{code:'invalid_boot_token'});
});

both('restore resets boot credentials and sessions, re-arms expiry, and leaves administrators intact',async f=>{
 f.config.BOOT_ACCESS_HOURS='2';const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops');
 assert.equal((await f.admin.overview({},boot.context)).boot.active,true);
 f.advance(2*3600000);
 await assert.rejects(f.admin.overview({},boot.context),{code:'boot_expired'});
 await assert.rejects(f.admin.bootLogin({method:'password',password:PASSWORD},f.ctx()),{code:'boot_expired'});
 await member.stepUp();assert.equal((await f.admin.overview({},member.context)).actor.kind,'admin');
 assert.equal((await f.admin.overview({},member.context)).boot.active,false);
 const fresh=await f.deploy(),restored=await f.claimBoot(fresh,'restore-browser','replacement boot password');assert.equal(restored.mode,'restore');
 const principal=await f.store.get('boot/principal');assert.equal(principal.generation,2);assert.equal(principal.expiresAt,f.now()+2*3600000);assert.equal(principal.claimedAt,start);
 await assert.rejects(f.admin.bootLogin({method:'password',password:PASSWORD},f.ctx()),{code:'unauthorized'});
 await assert.rejects(f.admin.overview({},boot.context),{code:'unauthorized'});
 const login=await f.admin.bootLogin({method:'password',password:'replacement boot password'},f.ctx());assert(login.sessionToken);
 await member.stepUp();assert.equal((await f.admin.lookup({owner:member.id},member.context)).user.authority.admin,true);
 const actions=(await f.admin.audit({fromSeq:1},restored.context)).entries.map(e=>e.action);for(const action of ['boot.claim','boot.restore','admin.claim-mint'])assert(actions.includes(action),action);
 // Passkey boot and step-up windows.
 f.advance(301000);await assert.rejects(f.admin.reserve({name:'helpdesk'},restored.context),{code:'step_up_required'});
 await f.admin.bootStepUp({method:'password',password:'replacement boot password'},restored.context);await f.admin.reserve({name:'helpdesk'},restored.context);
});

both('only boot creates or revokes administrators',async f=>{
 const boot=await f.claimBoot(await f.deploy()),first=await f.makeAdmin(boot,'ops'),second=await f.makeAdmin(boot,'ops-two');
 assert.equal((await f.admin.lookup({handle:'ops'},boot.context)).user.authority.admin,true);
 await f.admin.reserve({name:'staff'},first.context);
 await assert.rejects(f.admin.mintClaim({name:'staff',roles:['admin']},first.context),{code:'admin_role_boot_only'});
 await assert.rejects(f.admin.reserve({name:'staff',roles:['admin']},first.context),{code:'admin_role_boot_only'});
 await f.admin.reserve({name:'staff',roles:['admin']},boot.context);
 await assert.rejects(f.admin.mintClaim({name:'staff'},first.context),{code:'admin_role_boot_only'});
 const staff=await f.activate((await f.admin.mintClaim({name:'staff',roles:[]},first.context)).link,'staff');
 let target=(await f.admin.lookup({owner:staff.id},first.context)).user;assert.equal(target.internal,true);
 await assert.rejects(f.admin.setRoles({owner:staff.id,roles:['admin'],expectedRevision:target.principalRevision},first.context),{code:'admin_role_boot_only'});
 target=(await f.admin.lookup({owner:second.id},first.context)).user;
 await assert.rejects(f.admin.setRoles({owner:second.id,roles:[],expectedRevision:target.principalRevision},first.context),{code:'admin_target_forbidden'});
 await assert.rejects(f.admin.suspend({owner:second.id},first.context),{code:'admin_target_forbidden'});
 // Boot revokes; the revoked member immediately loses the console.
 await f.admin.setRoles({owner:second.id,roles:[],expectedRevision:target.principalRevision},boot.context);
 await second.stepUp();await assert.rejects(f.admin.overview({},second.context),{code:'forbidden'});
 const ordinary=await f.user();await assert.rejects(f.admin.setRoles({owner:ordinary.id,roles:['admin'],expectedRevision:null},boot.context),{code:'role_class_forbidden'});
 assert(( await f.admin.audit({fromSeq:1},boot.context)).entries.some(e=>e.action==='admin.revoke'&&e.target===second.id));
});

both('role classes bound what administrators can grant to users, themselves, other admins and boot',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops'),peer=await f.makeAdmin(boot,'ops-two'),ordinary=await f.user();
 const catalog={version:1,capabilities:{'support.read':{class:'internal',description:'Read support queue.'},'beta.access':{class:'user',description:'Try beta features.'}},roles:{support:{class:'internal',name:'Support',description:'Support staff.',capabilities:['support.read']},beta:{class:'user',name:'Beta',description:'Beta testers.',capabilities:['beta.access']}},badgeClasses:{beta:'user'}};
 assert.throws(()=>validateCatalog({...catalog,roles:{...catalog.roles,leak:{class:'user',name:'Leak',description:'Bad.',capabilities:['support.read']}}}),{code:'invalid_role_catalog'});
 assert.throws(()=>validateCatalog({...catalog,capabilities:{...catalog.capabilities,'admin.all':{class:'user',description:'No.'}}}),{code:'invalid_role_catalog'});
 assert.throws(()=>validateCatalog({...catalog,roles:{admin:{class:'user',name:'A',description:'B.',capabilities:[]}}}),{code:'invalid_role_catalog'});
 await assert.rejects(f.admin.setCatalog({catalog,expectedRevision:null},member.context),{code:'classification_boot_only'});
 await f.admin.setCatalog({catalog,expectedRevision:null},boot.context);
 let view=(await f.admin.lookup({owner:ordinary.id},member.context)).user;assert.equal(view.internal,false);
 await assert.rejects(f.admin.setRoles({owner:ordinary.id,roles:['support'],expectedRevision:view.principalRevision},member.context),{code:'role_class_forbidden'});
 await assert.rejects(f.admin.setRoles({owner:ordinary.id,roles:['ghost'],expectedRevision:view.principalRevision},member.context),{code:'unknown_role'});
 await f.admin.setRoles({owner:ordinary.id,roles:['beta'],expectedRevision:view.principalRevision},member.context);
 assert.deepEqual(await f.admin.authority(ordinary.id),{roles:['beta'],capabilities:['beta.access'],admin:false});
 await assert.rejects(f.admin.setBadges({owner:ordinary.id,badgeIds:['system']},member.context),{code:'badge_class_forbidden'});
 await f.admin.setBadges({owner:ordinary.id,badgeIds:['beta']},member.context);assert.deepEqual((await f.repository.get(ordinary.id)).badgeIds,['beta']);
 const self=(await f.admin.lookup({owner:member.id},member.context)).user;
 await assert.rejects(f.admin.setRoles({owner:member.id,roles:['admin','support'],expectedRevision:self.principalRevision},member.context),{code:'self_forbidden'});
 await assert.rejects(f.admin.setBadges({owner:member.id,badgeIds:['system']},member.context),{code:'self_forbidden'});
 const other=(await f.admin.lookup({owner:peer.id},member.context)).user;
 await assert.rejects(f.admin.setRoles({owner:peer.id,roles:['admin','support'],expectedRevision:other.principalRevision},member.context),{code:'admin_target_forbidden'});
 await assert.rejects(f.admin.setBadges({owner:peer.id,badgeIds:[]},member.context),{code:'admin_target_forbidden'});
 assert.equal((await f.admin.lookup({handle:'boot'},member.context)).user,null);
 await assert.rejects(f.admin.setRoles({owner:'boot',roles:[],expectedRevision:null},member.context),{code:'invalid_request'});
 await assert.rejects(f.admin.bootStepUp({method:'password',password:PASSWORD},{...member.context,actor:'boot'}),{code:'unauthorized'});
 await assert.rejects(f.admin.overview({},{...member.context,actor:undefined}),{code:'actor_required'});
 // Admins may edit only user-class roles with user-class capabilities.
 const current=await f.admin.overview({},member.context);
 await f.admin.setCatalog({catalog:{...catalog,roles:{...catalog.roles,beta:{...catalog.roles.beta,description:'Beta testers (renamed).'}}},expectedRevision:current.catalogRevision},member.context);
 const after=await f.admin.overview({},member.context);
 await assert.rejects(f.admin.setCatalog({catalog:{...after.catalog,roles:{...after.catalog.roles,support:{...after.catalog.roles.support,class:'user',capabilities:[]}}},expectedRevision:after.catalogRevision},member.context),{code:'classification_boot_only'});
 await assert.rejects(f.admin.setCatalog({catalog:{...after.catalog,capabilities:{...after.catalog.capabilities,'support.read':{class:'user',description:'Read support queue.'}}},expectedRevision:after.catalogRevision},member.context),{code:'classification_boot_only'});
 // Boot reclassifying a held role fails closed for ordinary holders at read time.
 await f.admin.setCatalog({catalog:{...after.catalog,roles:{...after.catalog.roles,beta:{...after.catalog.roles.beta,class:'internal'}}},expectedRevision:after.catalogRevision},boot.context);
 assert.deepEqual(await f.admin.authority(ordinary.id),{roles:[],capabilities:[],admin:false});
 assert.deepEqual(effectiveAuthority({version:1,capabilities:{},roles:{},badgeClasses:{}},{roles:['admin']},{internal:false,active:true}).admin,false);
});

both('suspension atomically revokes app lineage after natural session expiry and reactivation cannot revive it',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops');f.identity.config.deviceAuthorizationEnabled=true;
 const familyId='app-family',lineageId=crypto.randomUUID(),target=await f.user({sessions:[],linkedLineage:[{id:lineageId,sessions:['expired-parent'],sessionExpiresAt:f.now()-1,families:[familyId],expiresAt:f.now()+30*86400000}],lineageOutbox:[{familyId:'older-family',lineageId:'older-lineage',enqueuedAt:f.now()-1}]}),ref={owner:target.id,lineageId,familyId};
 assert.equal(await f.identity.linkedLineageLive(ref),true);
 await f.admin.suspend({owner:target.id},member.context);let stored=await f.repository.get(target.id);assert.deepEqual(stored.linkedLineage,[]);assert.deepEqual(stored.lineageOutbox.map(x=>x.familyId),['older-family',familyId]);assert.equal(await f.identity.linkedLineageLive(ref),false);
 await f.admin.reactivate({owner:target.id},member.context);assert.equal(await f.identity.linkedLineageLive(ref),false);assert.deepEqual((await f.repository.get(target.id)).lineageOutbox,stored.lineageOutbox);
});

both('suspension, step-up freshness, runtime reservations and per-actor rate limits',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops'),ordinary=await f.user({sessions:[{id:'s1',hash:'h',csrfToken:'c',expiresAt:start+86400000,createdAt:start}]});
 await f.admin.suspend({owner:ordinary.id},member.context);let stored=await f.repository.get(ordinary.id);assert.equal(stored.status,'suspended');assert.deepEqual(stored.sessions,[]);
 await assert.rejects(f.admin.suspend({owner:member.id},member.context),{code:'admin_target_forbidden'});
 await f.admin.reactivate({owner:ordinary.id},member.context);assert.equal((await f.repository.get(ordinary.id)).status,'active');
 f.advance(300001);await assert.rejects(f.admin.reserve({name:'concierge'},member.context),{code:'step_up_required'});await member.stepUp();
 await f.admin.reserve({name:'concierge'},member.context);
 const payer=await f.user(),payerSession={account:payer};f.identity.recent=async()=>payerSession;
 await assert.rejects(f.identity.claimHandle({handle:'Concierge'},f.ctx()),{code:'reserved_handle'});
 await assert.rejects(f.identity.claimHandle({handle:'boot'},f.ctx()),{code:'reserved_handle'});
 await f.identity.claimHandle({handle:'paidname'},f.ctx());
 await assert.rejects(f.admin.reserve({name:'paidname'},member.context),{code:'handle_unavailable'});
 await assert.rejects(f.admin.unreserve({name:'admin'},member.context),{code:'not_found'});
 await assert.rejects(f.admin.reserve({name:'admin',badgeIds:['system']},member.context),{code:'badge_boot_only'});await f.admin.reserve({name:'admin'},member.context);await assert.rejects(f.admin.unreserve({name:'admin'},member.context),{code:'static_reservation'});
 const claim=await f.admin.mintClaim({name:'concierge'},member.context);await assert.rejects(f.admin.unreserve({name:'concierge'},member.context),{code:'claim_outstanding'});
 await f.admin.revokeClaim({nonce:claim.nonce},member.context);
 await assert.rejects(f.identity.claimOnboarding({onboardingToken:decodeURIComponent(claim.link.split('#token=')[1]),name:'concierge',method:'password',password:'long internal account password',termsAccepted:true,termsVersion:'v1',turnstileToken:'ok'},f.ctx({setupBinding:'late'})),{code:'invalid_onboarding_invitation'});
 await assert.rejects(f.admin.unreserve({name:'concierge'},member.context),{code:'reservation_assigned'});
 let limited;for(let i=0;i<70&&!limited;i++)try{await f.admin.reserve({name:'loop-name'},member.context);}catch(error){limited=error;}
 assert.equal(limited?.code,'rate_limited');await f.admin.bootStepUp({method:'password',password:PASSWORD},boot.context);await f.admin.reserve({name:'loop-name'},boot.context);
});

both('audit log is hash-chained, append-only and tamper evident',async f=>{
 const boot=await f.claimBoot(await f.deploy());await f.admin.reserve({name:'helpdesk'},boot.context);await f.admin.reserve({name:'helpdesk',badgeIds:['system']},boot.context);
 const {entries,verified}=await f.admin.audit({fromSeq:1},boot.context);assert.equal(verified.valid,true);assert.deepEqual(entries.map(e=>e.seq),entries.map((_,i)=>i+1));
 const change=entries.findLast(e=>e.action==='reservation.set');assert.deepEqual(change.before.badgeIds,[]);assert.deepEqual(change.after.badgeIds,['system']);assert.equal(change.actor.kind,'boot');
 for(const writes of [{'audit/000000000001':{}},{'audit-head':{seq:0}}])await assert.rejects(f.store.commit({writes}),TypeError);
 await assert.rejects(f.storage.invoke('delete',['audit/000000000001']),TypeError);
 const raw=await f.storage.metadata.get('admin/audit/000000000002');await f.storage.metadata.put('admin/audit/000000000002',{...raw,action:'reservation.remove'});
 assert.deepEqual(await f.store.verifyAudit(),{valid:false,seq:2});
});

both('user lookup is bounded and never returns secrets, credentials or recovery material',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops'),ordinary=await f.user({verifiedEmail:'person@example.org',emailVerifiedAt:start,credentials:[{id:'cred-1',publicKey:'public-key-bytes',counter:3}],sessions:[{id:'s',hash:'session-hash-value',csrfToken:'csrf-value',expiresAt:start+3600000,createdAt:start}],pendingHash:'pending-hash-value',recoveryResumeHash:'resume-hash'});
 for(const query of [{owner:ordinary.id},{handle:ordinary.handle},{email:'person@EXAMPLE.org'}]){const result=await f.admin.lookup(query,member.context),text=JSON.stringify(result);assert.equal(result.user.id,ordinary.id);assert.equal(result.user.email,'p***@example.org');for(const secret of ['hash:','session-hash','csrf-value','public-key','cred-1','pending-hash','recovery','resume-hash','person@'])assert(!text.includes(secret),secret);}
 await assert.rejects(f.admin.lookup({handle:'ops',owner:member.id},member.context),{code:'invalid_request'});
 await assert.rejects(f.admin.lookup({prefix:'o'},member.context),{code:'invalid_request'});
 const audit=JSON.stringify((await f.admin.audit({fromSeq:1},boot.context)).entries);assert(!audit.includes('person@example.org'));assert(!audit.includes(PASSWORD));
});

test('boot is permanently unclaimable through signup, policy, onboarding, system invitations and admin claims',async()=>{
 assert(configuredReservedName({HOST_NAME_POLICY:{version:1,reserved:[],onboarding:[]}},'BOOT'));
 assert.throws(()=>configuredNamePolicy({HOST_NAME_POLICY:{version:1,reserved:[],onboarding:['boot']}}),{code:'host_name_policy_unavailable'});
 await assert.rejects(signOnboardingInvitation({version:1,purpose:'bindle-ordinary-account-onboarding',issuer:origin,nonce:crypto.randomUUID(),issuedAt:start,expiresAt:start+3600000,names:[{name:'boot',owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()}]},key,{now:start}),{code:'invalid_onboarding_invitation'});
 await assert.rejects(signSystemInvitation({version:1,purpose:'bindle-system-account-setup',issuer:origin,handle:'boot',role:'system',owner:crypto.randomUUID(),assignmentId:crypto.randomUUID(),nonce:crypto.randomUUID(),issuedAt:start,expiresAt:start+3600000},key,{now:start}),{code:'invalid_system_invitation'});
 const f=fixture();try{const boot=await f.claimBoot(await f.deploy());for(const call of [()=>f.admin.reserve({name:'boot'},boot.context),()=>f.admin.mintClaim({name:'BOOT'},boot.context),()=>f.admin.unreserve({name:'boot'},boot.context)])await assert.rejects(call(),{code:'boot_reserved'});assert.equal(await f.admin.isReserved('Boot'),true);assert.equal(await f.repository.findByHandle('boot'),null);}finally{f.close();}
});

test('boot token CLI writes a private file and prints only the non-secret digest',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bindle-boot-token-'));try{const out=join(dir,'boot.json'),run=args=>spawnSync(process.execPath,['scripts/boot-token.mjs',...args],{encoding:'utf8'});
  let result=run(['mint','--origin',origin,'--out',out]);assert.equal(result.status,0);assert.equal(result.stderr,'');const file=JSON.parse(await readFile(out,'utf8'));assert.equal((await stat(out)).mode&0o777,0o600);
  assert.equal(result.stdout,`BOOTSTRAP_TOKEN_SHA256=${file.digest}\n`);assert(!result.stdout.includes(file.token));assert.equal(file.digest,await bootTokenDigest(file.token));
  await verifyBootToken(file.token,{APP_ORIGIN:origin,BOOTSTRAP_TOKEN_SHA256:file.digest});
  assert.notEqual(run(['mint','--origin',origin,'--out',out]).status,0);assert.notEqual(run(['mint','--origin','http://plain.example','--out',join(dir,'x')]).status,0);
  result=run(['digest','--in',out]);assert.equal(result.stdout,`BOOTSTRAP_TOKEN_SHA256=${file.digest}\n`);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('admin routes require exact origin, explicit actor and set an isolated HttpOnly boot cookie',async()=>{
 const f=fixture();try{const token=await f.deploy(),env={APP_ORIGIN:origin,ADMIN_SERVICE:async()=>f.admin},json=(data,status=200,headers)=>new Response(JSON.stringify(data),{status,headers}),body=async request=>request.json();
  const call=(path,input,headers={},context={})=>adminRoutes({path,request:new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(input)}),env,local:false,context:{remoteIP:'192.0.2.1',...context},body,json});
  assert.equal(await adminRoutes({path:'/api/other',request:new Request(origin+'/api/other'),env,local:false,context:{},body,json}),null);
  assert.equal((await call('/api/admin/boot/start',{bootToken:token},{Origin:'https://evil.example'})).status,403);
  assert.equal((await call('/api/admin/boot/start',{bootToken:token},{},{setupBinding:'route-browser'})).status,200);
  const done=await call('/api/admin/boot/complete',{bootToken:token,method:'password',password:PASSWORD,acknowledgeExpiry:true},{},{setupBinding:'route-browser'}),cookie=done.headers.get('Set-Cookie'),result=await done.json();
  assert.match(cookie,/^__Host-bindle_boot=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);assert.equal(result.sessionToken,undefined);
  const session=cookie.split(';')[0];await assert.rejects(call('/api/admin/overview',{},{Cookie:session,'X-CSRF-Token':result.csrfToken}),{code:'actor_required'});
  assert.equal((await call('/api/admin/overview',{},{Cookie:session,'X-CSRF-Token':result.csrfToken,'X-Bindle-Admin-Actor':'boot'},{csrfToken:result.csrfToken})).status,200);
 }finally{f.close();}
});

both('review regressions: delegation, static names, claim-link ownership, target races, read audits and store transitions',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops'),peer=await f.makeAdmin(boot,'ops-two');
 const catalog={version:1,capabilities:{'ops.danger':{class:'internal',description:'Dangerous operations.'},'desk.read':{class:'internal',description:'Read the help desk.'}},roles:{ops:{class:'internal',name:'Ops',description:'Operations.',capabilities:['ops.danger']},desk:{class:'internal',name:'Desk',description:'Help desk.',capabilities:['desk.read'],delegable:true}},badgeClasses:{beta:'delegable'}};
 assert.throws(()=>validateCatalog({...catalog,roles:{x:{class:'user',name:'X',description:'Y.',capabilities:[],delegable:true}}}),{code:'invalid_role_catalog'});
 await f.admin.setCatalog({catalog,expectedRevision:null},boot.context);
 // F1: static names, non-delegated internal roles and internal badges are boot-only.
 await assert.rejects(f.admin.mintClaim({name:'security'},member.context),{code:'static_name_boot_only'});
 await f.admin.reserve({name:'night-desk'},member.context);
 await assert.rejects(f.admin.mintClaim({name:'night-desk',roles:['ops']},member.context),{code:'role_boot_only'});
 await assert.rejects(f.admin.mintClaim({name:'night-desk',badgeIds:['system']},member.context),{code:'badge_boot_only'});
 const minted=await f.admin.mintClaim({name:'night-desk',roles:['desk'],badgeIds:['beta']},member.context),desk=await f.activate(minted.link,'night-desk');
 const view=(await f.admin.lookup({owner:desk.id},member.context)).user;assert.deepEqual(view.authority.capabilities,['desk.read']);
 await assert.rejects(f.admin.setRoles({owner:desk.id,roles:['desk','ops'],expectedRevision:view.principalRevision},member.context),{code:'role_boot_only'});
 // F2: only the minter (or boot) re-derives a claim link.
 await f.admin.reserve({name:'secops'},boot.context);const bootClaim=await f.admin.mintClaim({name:'secops',roles:['ops']},boot.context);
 await assert.rejects(f.admin.claimLink({nonce:bootClaim.nonce},member.context),{code:'claim_minter_only'});
 await f.admin.reserve({name:'day-desk'},member.context);const own=await f.admin.mintClaim({name:'day-desk'},member.context);
 await assert.rejects(f.admin.claimLink({nonce:own.nonce},peer.context),{code:'claim_minter_only'});assert.equal((await f.admin.claimLink({nonce:own.nonce},member.context)).link,own.link);
 // F3: boot promoting the target mid-decision makes the admin's suspension conflict.
 const target=await f.user(),principalFor=f.admin.principalFor.bind(f.admin);let once=true;
 f.admin.principalFor=async account=>{const result=await principalFor(account);if(once&&account.id===target.id){once=false;await f.admin.setBadges({owner:target.id,badgeIds:['beta']},boot.context).catch(()=>{});const row=await f.store.get('principal/'+target.id);await f.store.commit({expect:{['principal/'+target.id]:row?.revision??null},writes:{['principal/'+target.id]:{owner:target.id,assignmentId:target.assignmentId,roles:['admin'],hold:null}}});}return result;};
 await assert.rejects(f.admin.suspend({owner:target.id},member.context),{code:'conflict'});f.admin.principalFor=principalFor;assert.equal((await f.repository.get(target.id)).status,'active');assert.equal((await f.store.get('principal/'+target.id)).hold,null);
 // F4: console reads are rate-limited and audited.
 const before=(await f.store.get('audit-head')).seq;await f.admin.overview({},member.context);await f.admin.principals({},member.context);
 const entries=(await f.admin.audit({fromSeq:before+1},boot.context)).entries.map(e=>e.action);assert.deepEqual(entries.slice(0,2),['console.overview','principals.list']);
 // F5/F6: page verification and no re-reservation of a reserved token.
 const page=await f.admin.audit({fromSeq:2},boot.context);assert.equal(page.verified.valid,true);assert.equal((await f.admin.audit({verify:true},boot.context)).verified.valid,true);
 const digest='f'.repeat(64);await f.store.commit({writes:{['boot-token/'+digest]:{phase:'reserved',binding:'a'}}});
 await assert.rejects(f.store.commit({writes:{['boot-token/'+digest]:{phase:'reserved',binding:'b'}}}),{code:'boot_token_consumed'});
});

// Admin console slice (2026-10-14): boot ends its own access, the console
// restores boot CSRF after reload, admins learn only their own authority, and
// administrator step-up through the console requires a passkey.
both('boot can end its own access early; only a new token restores it',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops');
 await assert.rejects(f.admin.bootEnd({},boot.context),{code:'invalid_request'});
 const info=await f.admin.bootSessionInfo({},{...boot.context,csrfToken:undefined});assert.equal(info.csrfToken,boot.csrfToken);assert.equal(info.bootExpiresAt,boot.bootExpiresAt);
 f.advance(301000);await assert.rejects(f.admin.bootEnd({confirm:'end-boot-access'},boot.context),{code:'step_up_required'});
 await f.admin.bootStepUp({method:'password',password:PASSWORD},boot.context);
 assert.equal((await f.admin.bootEnd({confirm:'end-boot-access'},boot.context)).ended,true);
 await assert.rejects(f.admin.overview({},boot.context),{code:'boot_expired'});await assert.rejects(f.admin.bootLogin({method:'password',password:PASSWORD},f.ctx()),{code:'boot_expired'});await assert.rejects(f.admin.bootSessionInfo({},boot.context),{code:'boot_expired'});
 const overview=await f.admin.overview({},member.context);assert.equal(overview.boot.status,'ended');assert.equal(overview.boot.active,false);
 assert.deepEqual((await f.admin.audit({},member.context)).entries.filter(e=>e.action==='boot.end').map(e=>[e.before.status,e.after.status]),[['active','ended']]);
 const restored=await f.claimBoot(await f.deploy(f.now()),'restore-browser');assert.equal(restored.mode,'restore');assert.equal((await f.admin.overview({},restored.context)).boot.active,true);
});
both('console access reports only the caller\'s own administrator authority',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops'),plain=await f.user();
 assert.deepEqual(await f.admin.access({},member.context),{admin:true,handle:'ops',passkey:false});
 await assert.rejects(f.admin.access({},{...member.context,actor:'boot'}),{code:'actor_required'});await assert.rejects(f.admin.access({},{...member.context,csrfToken:'wrong'}),{code:'csrf'});
 const session=await f.identity.loginPassword({handle:plain.handle,password:'secret user password',turnstileToken:'ok'},f.ctx());assert.ok(session.sessionToken);
 assert.deepEqual(await f.admin.access({},f.ctx({actor:'admin',sessionToken:session.sessionToken,csrfToken:session.csrfToken})),{admin:false});
 await assert.rejects(f.admin.access({extra:1},member.context),{code:'invalid_request'});
});
test('admin console routes: passkey-only administrator step-up, boot session restore and end clear the cookie',async()=>{
 const f=fixture();try{const token=await f.deploy(),env={APP_ORIGIN:origin,ADMIN_SERVICE:async()=>f.admin},json=(data,status=200,headers)=>new Response(JSON.stringify(data),{status,headers}),body=async request=>request.json();
  const call=(path,input,headers={},context={})=>adminRoutes({path,request:new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(input)}),env,local:true,context:{remoteIP:'192.0.2.1',...context},body,json});
  await call('/api/admin/boot/start',{bootToken:token},{},{setupBinding:'route-browser'});const done=await call('/api/admin/boot/complete',{bootToken:token,method:'password',password:PASSWORD,acknowledgeExpiry:true},{},{setupBinding:'route-browser'}),result=await done.json(),cookie=done.headers.get('Set-Cookie').split(';')[0],bootSession=cookie.split('=')[1];
  assert.match(cookie,/^bindle_boot=/);
  const info=await (await call('/api/admin/boot/session',{},{Cookie:cookie},{})).json();assert.equal(info.csrfToken,result.csrfToken);assert.equal(info.bootExpiresAt,result.bootExpiresAt);
  assert.equal((await call('/api/admin/boot/session',{},{Cookie:cookie,Origin:'https://evil.example'})).status,403);
  const member=await f.makeAdmin({context:f.ctx({actor:'boot',bootSession,csrfToken:result.csrfToken})},'ops');
  const refused=await call('/api/admin/step-up',{method:'password',password:member.password},{},member.context);assert.equal(refused.status,403);assert.equal((await refused.json()).error,'passkey_required');
  assert.equal((await (await call('/api/admin/access',{},{'X-Bindle-Admin-Actor':'admin'},member.context)).json()).admin,true);
  const ended=await call('/api/admin/boot/end',{confirm:'end-boot-access'},{Cookie:cookie,'X-CSRF-Token':result.csrfToken,'X-Bindle-Admin-Actor':'boot'},{csrfToken:result.csrfToken});assert.equal(ended.status,200);assert.match(ended.headers.get('Set-Cookie'),/^bindle_boot=; .*Max-Age=0/);
 }finally{f.close();}
});
both('overview marks which claim links the caller may retrieve',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops'),peer=await f.makeAdmin(boot,'ops-two');
 await f.admin.reserve({name:'desk-one'},member.context);const own=await f.admin.mintClaim({name:'desk-one'},member.context);
 const mine=c=>c.find(x=>x.nonce===own.nonce).linkAvailable;
 assert.equal(mine((await f.admin.overview({},member.context)).claims),true);assert.equal(mine((await f.admin.overview({},peer.context)).claims),false);assert.equal(mine((await f.admin.overview({},boot.context)).claims),true);
});
test('boot/begin is rate limited per IP pseudonym and globally',async()=>{
 const {abuseWindows,enforceAbusePolicy}=await import('../packages/core/abuse-policy.mjs');
 const windows=abuseWindows({operation:'boot-begin',ipHash:'ip-a',subnetHash:'net'});assert.ok(windows.some(w=>w.key==='boot-begin:burst:ip-a'));assert.ok(windows.some(w=>w.key==='boot-begin:global'&&w.limit>0));
 const counts=new Map(),resource={consume:async w=>{const n=(counts.get(w.key)??0)+1;counts.set(w.key,n);return n<=w.limit;}};let allowed=0;for(let i=0;i<300;i++)if(await enforceAbusePolicy(resource,{operation:'boot-begin',ipHash:'ip-'+i,subnetHash:'n'}))allowed++;assert.equal(allowed,200,'the global ceiling holds across many IP pseudonyms');
 let ok=0;for(let i=0;i<8;i++)if(await enforceAbusePolicy({consume:resource.consume},{operation:'boot-begin',ipHash:'single',subnetHash:'n'}))ok++;assert.ok(ok<=5);
 const f=fixture();try{const env={APP_ORIGIN:origin,ADMIN_SERVICE:async()=>f.admin},json=(data,status=200,headers)=>new Response(JSON.stringify(data),{status,headers}),body=async request=>request.json();let calls=[];f.admin.rateLimiter={check:async input=>{calls.push(input.operation);return false;}};
  await assert.rejects(adminRoutes({path:'/api/admin/boot/begin',request:new Request(origin+'/api/admin/boot/begin',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}),env,local:false,context:{remoteIP:'192.0.2.1'},body,json}),{code:'rate_limited'});assert.deepEqual(calls,['boot-begin']);
 }finally{f.close();}
});
test('console boot logout always clears the cookie; administrator step-up can be withdrawn',async()=>{
 const f=fixture();try{const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'ops');
  const env={APP_ORIGIN:origin,ADMIN_SERVICE:async()=>f.admin},json=(data,status=200,headers)=>new Response(JSON.stringify(data),{status,headers}),body=async request=>request.json();
  const response=await adminRoutes({path:'/api/admin/boot/logout',request:new Request(origin+'/api/admin/boot/logout',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:'bindle_boot=bad'},body:'{}'}),env,local:true,context:{},body,json});assert.equal(response.status,409);assert.match(response.headers.get('Set-Cookie'),/^bindle_boot=; .*Max-Age=0/);
  await f.admin.overview({},member.context);assert.deepEqual(await f.admin.endStepUp({},member.context),{ended:true});await assert.rejects(f.admin.overview({},member.context),{code:'step_up_required'});
 }finally{f.close();}
});
test('IdentityService.stepUp has a single caller: the passkey-only admin route',async()=>{
 const {readFile}=await import('node:fs/promises');const {execFileSync}=await import('node:child_process');
 const hits=execFileSync('grep',['-rln','identity.stepUp(\\|\\.stepUp(','packages','apps'],{encoding:'utf8'}).trim().split('\n').filter(f=>!f.includes('node_modules')&&f!=='packages/identity/service.mjs');
 assert.deepEqual(hits,['packages/runtime/admin-http.mjs']);assert.match(await readFile('packages/runtime/admin-http.mjs','utf8'),/input\?\.method!=='passkey'/);
});

both('expired unredeemed claims release their name; redeemed, mid-redemption, static and boot names never do',async f=>{
 const boot=await f.claimBoot(await f.deploy()),member=await f.makeAdmin(boot,'operator'),token=link=>decodeURIComponent(link.split('#token=')[1]);
 const statik=await f.admin.mintClaim({name:'security',hours:1},boot.context);
 for(const name of ['unused','revoked','redeemed','started'])await f.admin.reserve({name},member.context);
 const claims={};for(const name of ['unused','revoked','redeemed','started'])claims[name]=await f.admin.mintClaim({name,hours:1},member.context);
 await f.admin.revokeClaim({nonce:claims.revoked.nonce},member.context);
 await f.activate(claims.redeemed.link,'redeemed');
 // Mid-redemption: the claim was bound to a setup, which has not finished yet.
 assert.equal((await f.repository.claimOnboardingIdentity('started',(await f.repository.onboardingLookup('started')).onboarding.digest,'s'.repeat(43))).phase,'claiming');
 const due=claims.unused.expiresAt+ONBOARDING_RELEASE_GRACE_MS;assert.equal(statik.expiresAt,claims.unused.expiresAt);
 assert.deepEqual(await f.sweep(due-1),[]);assert.equal((await f.repository.onboardingLookup('unused')).onboarding.phase,'preissued');
 f.advance(due-f.now());assert.deepEqual((await f.sweep()).sort(),['revoked','unused']);
 assert.equal(await f.repository.onboardingLookup('unused'),null);assert.equal(await f.repository.onboardingLookup('revoked'),null);
 assert.equal((await f.repository.onboardingLookup('redeemed')).onboarding.phase,'consumed');assert((await f.repository.findByHandle('redeemed')));
 assert.equal((await f.repository.onboardingLookup('started')).onboarding.phase,'claiming');
 assert.equal((await f.repository.onboardingLookup('security')).onboarding.phase,'preissued');
 assert.deepEqual(await f.sweep(due+86400000),[]);
 // The expired token stays dead; the released name can be unreserved or reissued.
 await assert.rejects(f.identity.claimOnboarding({onboardingToken:token(claims.unused.link),name:'unused',method:'password',password:'long internal account password',termsAccepted:true,termsVersion:'v1',turnstileToken:'ok'},f.ctx({setupBinding:'late'})));
 await member.stepUp();await f.admin.unreserve({name:'unused'},member.context);
 await assert.rejects(f.admin.unreserve({name:'redeemed'},member.context),{code:'reservation_assigned'});await assert.rejects(f.admin.unreserve({name:'started'},member.context),{code:'reservation_assigned'});
 const again=await f.admin.mintClaim({name:'revoked',hours:1},member.context);const owner=await f.activate(again.link,'revoked');assert.equal((await f.repository.findByHandle('revoked')).id,owner.id);
 f.advance(2*3600000);assert.deepEqual(await f.sweep(),[]);assert.equal((await f.repository.onboardingLookup('revoked')).onboarding.phase,'consumed');
});

test('claim-name release races concurrent redemption with exactly one winner and is idempotent',async()=>{
 const binding='b'.repeat(43),digest='d'.repeat(64),expiresAt=start,now=start+ONBOARDING_RELEASE_GRACE_MS,winners={claim:0,release:0};
 const reserve=(storage,name,at=expiresAt,hex=digest)=>storage.onboardingReserve({name,owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()},{nonce:crypto.randomUUID(),expiresAt:at},hex);
 for(let i=0;i<40;i++){
  const metadata=new SqliteMetadata(':memory:'),storage=new IdentityShardStorage(metadata,{});try{
   const name='race-'+i;assert(await reserve(storage,name));
   const delay=async(n,fn)=>{for(let k=0;k<n;k++)await null;return fn();};
   const claim=()=>delay(i%3,()=>storage.onboardingClaim(name,digest,binding)),sweep=()=>delay((i>>1)%3,()=>storage.onboardingSweep({now}));
   const [claimed,swept,again]=i%2?await Promise.all([claim(),sweep(),sweep()]).then(([c,s,a])=>[c,s,a]):await Promise.all([sweep(),claim(),sweep()]).then(([s,c,a])=>[c,s,a]);
   const released=[...swept.released,...again.released].filter(n=>n===name).length,row=await storage.handleLookup(name);
   assert(released<=1,'a reservation is released at most once');
   if(claimed){winners.claim++;assert.equal(released,0);assert.equal(row.onboarding.phase,'claiming');assert.equal(row.onboarding.binding,binding);}
   else{winners.release++;assert.equal(released,1);assert.equal(row,null);assert.equal(await storage.onboardingClaim(name,digest,binding),null);}
   assert.deepEqual((await storage.onboardingSweep({now:now+86400000})).released,[]);
  }finally{metadata.close();}
 }
 assert(winners.claim>0&&winners.release>0,`both orders exercised: ${JSON.stringify(winners)}`);
});

test('claim-name release never touches other namespace states, schedules its alarm and leaves a later reservation alone',async()=>{
 const metadata=new SqliteMetadata(':memory:'),storage=new IdentityShardStorage(metadata,{});try{
  const now=start+ONBOARDING_RELEASE_GRACE_MS,digest='e'.repeat(64),key=(at,name)=>`identity-onboarding-expiry/${String(at).padStart(16,'0')}/${name}`;
  const owner=crypto.randomUUID(),assignmentId=crypto.randomUUID(),base={version:1,digest,binding:null,canonical:null,admitted:false,issuanceComplete:true,expiresAt:start};
  const marker=name=>({version:1,kind:'ordinary-onboarding',handle:name,assignmentId,invitationId:owner,claimDigest:digest});
  const rows={allocated:{owner,assignmentId,state:'allocated'},assigned:{owner,assignmentId,state:'assigned',createToken:'t'},paid:{owner,assignmentId,state:'paid-alias'},system:{owner,assignmentId,state:'system-alias',bootstrap:{version:1,phase:'reserved'}},
   claiming:{owner,assignmentId,state:'operator-alias',onboarding:{...base,marker:marker('claiming'),phase:'claiming',binding:'b'.repeat(43)}},consumed:{owner,assignmentId,state:'operator-alias',onboarding:{...base,marker:marker('consumed'),phase:'consumed',binding:'b'.repeat(43),admitted:true,canonical:'n.1'}},
   other:{owner,assignmentId,state:'operator-alias',onboarding:{...base,marker:marker('other'),phase:'preissued',digest:'f'.repeat(64)}},security:{owner,assignmentId,state:'operator-alias',onboarding:{...base,marker:marker('security'),phase:'preissued'}},boot:{owner,assignmentId,state:'operator-alias',onboarding:{...base,marker:marker('boot'),phase:'preissued'}}};
  for(const [name,row]of Object.entries(rows)){await metadata.put('identity-namespace/'+name,row);await metadata.put(key(start,name),{handle:name,digest,expiresAt:start});}
  assert.deepEqual((await storage.onboardingSweep({now})).released,[]);
  for(const [name,row]of Object.entries(rows))assert.deepEqual(await metadata.get('identity-namespace/'+name),row);
  assert.equal((await metadata.list({prefix:'identity-onboarding-expiry/'})).size,0);
  // Index and alarm: the earliest due reservation arms the alarm; a later one survives an earlier sweep.
  const item={name:'later',owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()};assert(await storage.onboardingReserve(item,{nonce:crypto.randomUUID(),expiresAt:start+7200000},digest));
  assert.equal(await metadata.getAlarm(),start+7200000+ONBOARDING_RELEASE_GRACE_MS);
  assert(await storage.onboardingReserve({name:'early',owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()},{nonce:crypto.randomUUID(),expiresAt:start},digest));
  assert.equal(await metadata.getAlarm(),now);
  assert.deepEqual(await storage.onboardingSweep({now}),{released:['early'],next:start+7200000+ONBOARDING_RELEASE_GRACE_MS});
  assert.equal((await storage.handleLookup('later')).onboarding.phase,'preissued');
  // A replacement reservation for a released name gets its own index entry.
  assert(await storage.onboardingReserve({name:'early',owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()},{nonce:crypto.randomUUID(),expiresAt:start+3600000},digest));
  assert.deepEqual((await storage.onboardingSweep({now})).released,[]);assert.equal((await storage.handleLookup('early')).onboarding.phase,'preissued');
  // An alarm at or before now (the running one) never blocks re-arming the next due time.
  await metadata.put('@alarm',now-1);await storage.onboardingSweep({now});assert.equal(await metadata.getAlarm(),start+3600000+ONBOARDING_RELEASE_GRACE_MS);
  // The Node identity repository alarm runs the same sweep on its own clock.
  const repository=new IdentityRepository({metadata,config:{}}),past=Date.now()-ONBOARDING_RELEASE_GRACE_MS-1;
  assert(await repository.reserveOnboardingIdentity({name:'stale',owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()},{nonce:crypto.randomUUID(),expiresAt:past},digest));
  await repository.alarm();assert.equal(await repository.onboardingLookup('stale'),null);
  // A failing sweep (unreadable name policy) releases nothing and retries later.
  const broken=new IdentityRepository({metadata,config:{HOST_NAME_POLICY:'{not json'}});assert(await broken.shardOnboardingReserve({name:'kept',owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()},{nonce:crypto.randomUUID(),expiresAt:past},digest));await broken.alarm();assert.equal((await broken.onboardingLookup('kept')).onboarding.phase,'preissued');assert(await metadata.getAlarm()>Date.now()+3000000);
 }finally{metadata.close();}
});

both('administrator suspension exposes a lifecycle hold whose release survives role changes',async f=>{
 const boot=await f.claimBoot(await f.deploy()),target=await f.user();
 assert.deepEqual(await f.admin.lifecycleHold(target.id),{held:false,since:null,releasedAt:null});
 await f.admin.suspend({owner:target.id},boot.context);const held=await f.admin.lifecycleHold(target.id);assert.equal(held.held,true);assert.equal(held.since,f.now());
 f.advance(60000);await f.admin.reactivate({owner:target.id},boot.context);assert.deepEqual(await f.admin.lifecycleHold(target.id),{held:false,since:null,releasedAt:f.now()});
 await assert.rejects(f.admin.lifecycleHold('not-a-uuid'),{name:'TypeError'});
});


both('admin suspension invokes account connection severance directly after the identity commits',async f=>{
 const boot=await f.claimBoot(await f.deploy()),ordinary=await f.user(),calls=[];
 f.admin.connectionsSeverAccount=async(id,input)=>{assert.equal((await f.repository.get(id)).status,'suspended');calls.push({id,...input});};
 await f.admin.suspend({owner:ordinary.id},boot.context);assert.deepEqual(calls,[{id:ordinary.id,reason:'admin-suspended'}]);
 await f.admin.reactivate({owner:ordinary.id},boot.context);assert.equal(calls.length,1);
});
