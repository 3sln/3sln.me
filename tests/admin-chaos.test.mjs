// Contention, fault injection and bounded scaling for host administration at the
// engine level: AdminService over a real (in-memory SQLite) AdminStorage, a fake
// identity resource and a fake clock. Seeds are logged on failure (CHAOS_SEED).
import test from 'node:test';import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {AdminStorage} from '../packages/identity/admin-store.mjs';
import {AdminService} from '../packages/identity/admin.mjs';
import {mintBootToken,bootTokenDigest} from '../packages/identity/boot.mjs';
import {IdentityCrypto,encode} from '../packages/identity/crypto.mjs';
import {createScheduler,injectFaults,forEachSeed,fakeClock} from './helpers/chaos.mjs';

const origin='https://admin.example',start=1792000000000,PASSWORD='long boot operator password';
const catalogWith=description=>({version:1,capabilities:{'beta.access':{class:'user',description:'Try beta features.'}},roles:{beta:{class:'user',name:'Beta',description,capabilities:['beta.access']},early:{class:'user',name:'Early',description:'Early access.',capabilities:[]}},badgeClasses:{}});
function fixture({random,faults,txFaults}={}){
 const clock=fakeClock(start),raw=new SqliteMetadata(':memory:');
 // txFaults wrap the transaction handle, so a fault lands inside the atomic section.
 const metadata=txFaults?{get:k=>raw.get(k),list:o=>raw.list(o),transaction:op=>raw.transaction(tx=>op(injectFaults(tx,txFaults)))}:raw;
 const storage=new AdminStorage(metadata),scheduler=random?createScheduler(random):null;let store=faults?injectFaults(storage,faults,{random}):storage;if(scheduler)store=scheduler.wrap(store,'admin-store');
 const accounts=new Map(),repository={get:async id=>structuredClone(accounts.get(id)??null),findByHandle:async()=>null,onboardingLookup:async()=>null};
 const identity={origin(context){if(context?.origin!==origin)throw Object.assign(new Error('csrf'),{code:'csrf'});},crypto:new IdentityCrypto(),repository,config:{}};
 const config={APP_ORIGIN:origin,BOOT_ACCESS_HOURS:'24',ONBOARDING_KEY:encode(new Uint8Array(32).fill(5))},issued=[];
 const admin=new AdminService({store,identity,onboarding:{issue:async token=>{issued.push(token);}},webauthn:{registrationOptions:async()=>({challenge:'reg'})},passwordHasher:{hash:async x=>'hash:'+x,verify:async(x,h)=>h==='hash:'+x},rateLimiter:{check:async()=>true},clock:clock.now,config});
 const ctx=(extra={})=>({origin,remoteIP:'192.0.2.9',...extra});
 const deploy=async()=>{const token=mintBootToken(origin,{now:clock.now()});config.BOOTSTRAP_TOKEN_SHA256=await bootTokenDigest(token);return token;};
 const claimBoot=async(token,binding='boot-browser')=>{await admin.bootStart({bootToken:token},ctx({setupBinding:binding}));const result=await admin.bootComplete({bootToken:token,method:'password',password:PASSWORD,acknowledgeExpiry:true},ctx({setupBinding:binding}));return ctx({actor:'boot',bootSession:result.sessionToken,csrfToken:result.csrfToken});};
 const addAccount=()=>{const id=crypto.randomUUID();accounts.set(id,{id,assignmentId:crypto.randomUUID(),handle:'n.'+accounts.size+'a',status:'active',createdAt:start,lastActiveAt:start,credentials:[],sessions:[]});return id;};
 const audit=async()=>{const rows=[];let startAfter='';for(;;){const page=await storage.list('audit/',{startAfter,limit:100});if(!page.length)return rows;rows.push(...page.map(r=>r.value));startAfter=page.at(-1).key;}};
 return {admin,storage,raw,scheduler,clock,ctx,deploy,claimBoot,addAccount,audit,issued,close:()=>raw.close()};
}
// The whole log verifies, sequence numbers have no gaps, and the head is the last entry.
async function assertAuditIntact(f){const rows=await f.audit();assert.deepEqual(await f.storage.verifyAudit(),{valid:true,seq:rows.length});assert.deepEqual(rows.map(r=>r.seq),rows.map((_,i)=>i+1));return rows;}
const codes=results=>results.filter(r=>r.status==='rejected').map(r=>r.reason?.code);
const retrying=async(operation,attempts=20)=>{for(let i=1;;i++)try{return await operation();}catch(error){if(error.code!=='conflict'||i>=attempts)throw error;}};

test('concurrent catalog edits under seeded interleavings: one blind writer wins, retrying writers serialize into a linear history',async()=>{
 await forEachSeed(12,async random=>{const f=fixture({random});try{
  const boot=await f.claimBoot(await f.deploy());
  // Blind writers all expect the empty catalog: exactly one may commit.
  const blind=await f.scheduler.run([1,2,3,4].map(i=>()=>f.admin.setCatalog({catalog:catalogWith(`Blind ${i}.`),expectedRevision:null},boot)));
  assert.equal(blind.filter(r=>r.status==='fulfilled').length,1);assert(codes(blind).every(code=>code==='conflict'),codes(blind).join());
  // Read-modify-write writers that reload on conflict all land, each on top of the previous one.
  const writers=[1,2,3].map(i=>()=>retrying(async()=>{const {catalogRevision}=await f.admin.overview({},boot);return f.admin.setCatalog({catalog:catalogWith(`Writer ${i}.`),expectedRevision:catalogRevision},boot);}));
  const settled=await f.scheduler.run(writers);assert(settled.every(r=>r.status==='fulfilled'),codes(settled).join());
  assert.equal((await f.storage.get('catalog')).revision,4);
  const sets=(await assertAuditIntact(f)).filter(e=>e.action==='catalog.set');assert.equal(sets.length,4);
  for(let i=1;i<sets.length;i++)assert.deepEqual(sets[i].before,sets[i-1].after,'each write builds on the one before it: no lost update');
 }finally{f.close();}});
});

test('a boot token is reserved once and consumed once across seeded interleavings of competing browsers',async()=>{
 await forEachSeed(12,async random=>{const f=fixture({random});try{
  const token=await f.deploy(),starts=await f.scheduler.run(['a','b','c'].map(b=>()=>f.admin.bootStart({bootToken:token},f.ctx({setupBinding:b}))));
  assert.equal(starts.filter(r=>r.status==='fulfilled').length,1);assert(codes(starts).every(c=>c==='boot_token_consumed'));
  const winner=['a','b','c'][starts.findIndex(r=>r.status==='fulfilled')],loser=winner==='a'?'b':'a';
  const complete=binding=>()=>f.admin.bootComplete({bootToken:token,method:'password',password:PASSWORD,acknowledgeExpiry:true},f.ctx({setupBinding:binding}));
  const done=await f.scheduler.run([complete(winner),complete(winner),complete(loser),complete('fresh')]);
  assert.equal(done.filter(r=>r.status==='fulfilled').length,1);assert.equal(done[0].status==='fulfilled'||done[1].status==='fulfilled',true,'only the reserving browser completes');
  assert(codes(done).every(c=>c==='boot_token_consumed'));
  const record=await f.storage.get('boot-token/'+(await bootTokenDigest(token)));assert.equal(record.phase,'consumed');
  const principal=await f.storage.get('boot/principal'),sessions=await f.storage.get('boot/sessions');assert.equal(principal.generation,1);assert.equal(sessions.sessions.length,1);
  const rows=await assertAuditIntact(f);assert.deepEqual(rows.map(r=>r.action),['boot.token-reserved','boot.claim']);
 }finally{f.close();}});
});

test('concurrent claim minting for one name leaves exactly one live claim and one issued invitation',async()=>{
 await forEachSeed(10,async random=>{const f=fixture({random});try{
  const boot=await f.claimBoot(await f.deploy());await f.admin.reserve({name:'concierge'},boot);
  const results=await f.scheduler.run([1,2,3].map(()=>()=>f.admin.mintClaim({name:'concierge'},boot)));
  const winners=results.filter(r=>r.status==='fulfilled');assert.equal(winners.length,1);assert(codes(results).every(c=>['claim_outstanding','conflict'].includes(c)),codes(results).join());
  const claims=(await f.storage.list('claim/')).map(r=>r.value);assert.equal(claims.length,1,JSON.stringify(claims.map(c=>[c.state,c.nonce]))+JSON.stringify(results.map(r=>r.reason?.message)));assert.equal(claims[0].nonce,winners[0].value.nonce);
  assert.equal((await f.storage.get('claim-name/concierge')).nonce,claims[0].nonce);assert.equal(f.issued.length,1);
  await assertAuditIntact(f);
 }finally{f.close();}});
});

test('unreserving while a claim is minted never leaves a live claim without its reservation',async()=>{
 await forEachSeed(40,async random=>{const f=fixture({random});try{
  const boot=await f.claimBoot(await f.deploy());await f.admin.reserve({name:'frontdesk'},boot);
  const results=await f.scheduler.run([()=>f.admin.mintClaim({name:'frontdesk'},boot),()=>f.admin.unreserve({name:'frontdesk'},boot)]);
  assert(codes(results).every(c=>['claim_outstanding','conflict','not_reserved'].includes(c)),codes(results).join());
  const live=(await f.storage.list('claim/')).map(r=>r.value).filter(c=>['issuing','issued'].includes(c.state));
  if(live.length)assert(await f.storage.get('reservation/frontdesk'),'an outstanding claim keeps its reservation');
  else assert.equal(await f.storage.get('reservation/frontdesk'),null);
 }finally{f.close();}});
});

test('concurrent role assignments on one principal serialize with reloads; the stored roles are the last audited value',async()=>{
 await forEachSeed(10,async random=>{const f=fixture({random});try{
  const boot=await f.claimBoot(await f.deploy()),owner=f.addAccount();await f.admin.setCatalog({catalog:catalogWith('Beta.'),expectedRevision:null},boot);
  const choices=[['beta'],['early'],['beta','early'],[]];
  const results=await f.scheduler.run(choices.map(roles=>()=>retrying(async()=>{const {user}=await f.admin.lookup({owner},boot);return f.admin.setRoles({owner,roles,expectedRevision:user.principalRevision},boot);})));
  assert(results.every(r=>r.status==='fulfilled'),codes(results).join());
  const row=await f.storage.get('principal/'+owner),sets=(await assertAuditIntact(f)).filter(e=>e.action==='roles.set');
  assert.equal(row.revision,choices.length);assert.equal(sets.length,choices.length);assert.deepEqual(row.roles,sets.at(-1).after);
  for(let i=1;i<sets.length;i++)assert.deepEqual(sets[i].before,sets[i-1].after);
 }finally{f.close();}});
});

test('a store failure inside the commit transaction rolls back the record, the rate debit and the audit entry',async()=>{
 let armed=false;const f=fixture({txFaults:[{method:'put',when:call=>armed&&call.args[0]==='admin/audit-head'&&!(armed=false)}]});try{
  const boot=await f.claimBoot(await f.deploy()),head=await f.storage.get('audit-head'),rate=await f.raw.get('admin/rate/boot');
  armed=true;await assert.rejects(f.admin.setCatalog({catalog:catalogWith('First.'),expectedRevision:null},boot),{code:'injected_fault'});
  assert.equal(await f.storage.get('catalog'),null);assert.deepEqual(await f.storage.get('audit-head'),head);assert.deepEqual(await f.raw.get('admin/rate/boot'),rate);
  await f.admin.setCatalog({catalog:catalogWith('First.'),expectedRevision:null},boot);
  assert.equal((await f.storage.get('catalog')).revision,1);assert.equal((await assertAuditIntact(f)).filter(e=>e.action==='catalog.set').length,1);
 }finally{f.close();}
});

test('a lost commit response (applied, then failed) is never applied twice: the retry conflicts and a reload shows the change',async()=>{
 let armed=false;const f=fixture({faults:[{method:'commit',mode:'after',when:()=>armed&&!(armed=false)}]});try{
  const boot=await f.claimBoot(await f.deploy());armed=true;
  await assert.rejects(f.admin.setCatalog({catalog:catalogWith('Once.'),expectedRevision:null},boot),{code:'injected_fault'});
  await assert.rejects(f.admin.setCatalog({catalog:catalogWith('Once.'),expectedRevision:null},boot),{code:'conflict'});
  const view=await f.admin.overview({},boot);assert.equal(view.catalogRevision,1);assert.equal(view.catalog.roles.beta.description,'Once.');
  assert.equal((await assertAuditIntact(f)).filter(e=>e.action==='catalog.set').length,1);
 }finally{f.close();}
});

test('duplicate delivery of a boot completion consumes the token once and the operator can still sign in with the credential',async()=>{
 const f=fixture({faults:[{method:'commit',mode:'duplicate',when:call=>Object.keys(call.args[0]?.writes??{}).includes('boot/principal')}]});try{
  const token=await f.deploy();await f.admin.bootStart({bootToken:token},f.ctx({setupBinding:'b'}));
  // The duplicate's refusal is what the caller sees; the first delivery already applied.
  await assert.rejects(f.admin.bootComplete({bootToken:token,method:'password',password:PASSWORD,acknowledgeExpiry:true},f.ctx({setupBinding:'b'})),{code:'boot_token_consumed'});
  assert.equal((await f.storage.get('boot/principal')).generation,1);
  await assert.rejects(f.admin.bootStart({bootToken:token},f.ctx({setupBinding:'b'})),{code:'boot_token_consumed'});
  const fault=f.admin.store;f.admin.store=f.storage;try{const login=await f.admin.bootLogin({method:'password',password:PASSWORD},f.ctx());assert.match(login.sessionToken,/^[A-Za-z0-9_-]{43}$/);}finally{f.admin.store=fault;}
  assert.equal((await assertAuditIntact(f)).filter(e=>e.action==='boot.claim').length,1);
 }finally{f.close();}
});

test('clock jumps fail closed: backwards before step-up and past boot expiry refuse mutations without writing',async()=>{
 const f=fixture();try{
  const boot=await f.claimBoot(await f.deploy()),head=await f.storage.get('audit-head');
  f.clock.advance(-1);await assert.rejects(f.admin.reserve({name:'helpdesk'},boot),{code:'step_up_required'});await assert.rejects(f.admin.overview({},boot),{code:'step_up_required'});
  f.clock.set(start+24*3600000);await assert.rejects(f.admin.reserve({name:'helpdesk'},boot),{code:'boot_expired'});await assert.rejects(f.admin.bootLogin({method:'password',password:PASSWORD},f.ctx()),{code:'boot_expired'});
  assert.deepEqual(await f.storage.get('audit-head'),head);assert.equal(await f.storage.get('reservation/helpdesk'),null);
 }finally{f.close();}
});

test('per-actor mutation rate limit holds when successive requests carry a clock one millisecond behind',async()=>{
 const f=fixture();try{
  const boot=await f.claimBoot(await f.deploy());let accepted=0,limited=null;
  for(let i=0;i<70&&!limited;i++){f.clock.set(start+1+(i%2?0:1));try{await f.admin.reserve({name:`name-${String(i).padStart(2,'0')}`},boot);accepted++;}catch(error){limited=error;}}
  assert.equal(limited?.code,'rate_limited');assert(accepted<=60,`accepted ${accepted}`);
 }finally{f.close();}
});

test('bounded reads at scale: overview, principal pages, audit pages and boot sessions never grow with stored state',async()=>{
 const f=fixture();try{
  const boot=await f.claimBoot(await f.deploy());
  for(let i=0;i<150;i++)await f.storage.commit({writes:{[`reservation/bulk-${String(i).padStart(3,'0')}`]:{name:`bulk-${i}`,source:'runtime',roles:[],badgeIds:[]}}});
  for(let i=0;i<120;i++){const nonce=crypto.randomUUID();await f.storage.commit({writes:{['claim/'+nonce]:{nonce,name:'bulk-'+i,state:'issued',roles:[],badgeIds:[],expiresAt:start,createdAt:start}}});}
  const owners=[];for(let i=0;i<120;i++){const owner=crypto.randomUUID();owners.push(owner);await f.storage.commit({writes:{['principal/'+owner]:{owner,roles:[],updatedAt:start}}});}
  for(let i=0;i<130;i++)await f.storage.commit({audit:{action:'bulk',i}});
  const view=await f.admin.overview({},boot);assert(view.reservations.runtime.length<=100);assert(view.claims.length<=100);
  const seen=[];let startAfter,pages=0;do{const page=await f.admin.principals(startAfter?{startAfter}:{},boot);assert(page.principals.length<=50);seen.push(...page.principals.map(p=>p.owner));startAfter=page.next;pages++;}while(startAfter&&pages<10);
  assert.deepEqual(seen.sort(),owners.sort());
  const latest=await f.admin.audit({},boot);assert(latest.entries.length<=50);assert.equal(latest.verified.valid,true);assert.equal(latest.entries.at(-1).seq,latest.head);
  assert.equal((await f.admin.audit({fromSeq:1,verify:true},boot)).verified.valid,true);
  for(let i=0;i<10;i++)await f.admin.bootLogin({method:'password',password:PASSWORD},f.ctx());
  assert((await f.storage.get('boot/sessions')).sessions.length<=3,'boot keeps at most three live sessions');
 }finally{f.close();}
});
