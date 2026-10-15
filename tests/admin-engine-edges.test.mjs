// Engine-level edges for boot and host administration: pure policy, the admin
// store's invariants and the onboarding sweep, with in-memory SQLite and fake clocks.
import test from 'node:test';import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {mintBootToken,bootTokenDigest,verifyBootToken,bootWindowMs,BOOT_TOKEN_WINDOW_MS,BOOT_TOKEN_SKEW_MS} from '../packages/identity/boot.mjs';
import {AdminStorage} from '../packages/identity/admin-store.mjs';
import {validateCatalog,catalogChangeAllowed,assignmentDecision,badgeDecision,effectiveAuthority,ADMIN_ROLE,catalogRole} from '../packages/identity/roles.mjs';
import {encode} from '../packages/identity/crypto.mjs';
import {RESERVED_HANDLES,BOOT_HANDLE} from '../packages/identity/handles.mjs';
import {IdentityShardStorage,ONBOARDING_RELEASE_GRACE_MS} from '../packages/runtime/identity-shards.mjs';
import {createRandom,forEachSeed} from './helpers/chaos.mjs';

const origin='https://admin.example',start=1792000000000;
const forge=claims=>'boot1.'+encode(new TextEncoder().encode(JSON.stringify(claims)));
const claimsAt=(ts,extra={})=>({v:1,iss:origin,purpose:'boot',ts,nonce:encode(new Uint8Array(16).fill(1)),secret:encode(new Uint8Array(32).fill(2)),...extra});
const configFor=async token=>({APP_ORIGIN:origin,BOOTSTRAP_TOKEN_SHA256:await bootTokenDigest(token)});
const withStore=async body=>{const metadata=new SqliteMetadata(':memory:');try{await body(new AdminStorage(metadata),metadata);}finally{metadata.close();}};

test('boot token mint window and clock skew are inclusive at their exact edges and refuse one millisecond beyond',async()=>{
 const token=mintBootToken(origin,{now:start}),config=await configFor(token);
 assert.equal((await verifyBootToken(token,config,{now:start+BOOT_TOKEN_WINDOW_MS})).claims.ts,start);
 await assert.rejects(verifyBootToken(token,config,{now:start+BOOT_TOKEN_WINDOW_MS+1}),{code:'invalid_boot_token',status:403});
 assert.equal((await verifyBootToken(token,config,{now:start-BOOT_TOKEN_SKEW_MS})).claims.ts,start);
 await assert.rejects(verifyBootToken(token,config,{now:start-BOOT_TOKEN_SKEW_MS-1}),{code:'invalid_boot_token'});
 // Completing an already reserved use skips only the mint window, never the future-skew bound or the digest.
 assert.equal((await verifyBootToken(token,config,{now:start+30*86400000,fresh:false})).digest,config.BOOTSTRAP_TOKEN_SHA256);
 await assert.rejects(verifyBootToken(token,config,{now:start-BOOT_TOKEN_SKEW_MS-1,fresh:false}),{code:'invalid_boot_token'});
 // The secret is never echoed back with the verified claims.
 assert.equal('secret' in (await verifyBootToken(token,config,{now:start})).claims,false);
});

test('boot tokens with a matching digest but malformed typed claims are all refused with one generic error',async()=>{
 const cases={extraKey:claimsAt(start,{admin:true}),version:claimsAt(start,{v:2}),purpose:claimsAt(start,{purpose:'login'}),issuerPath:claimsAt(start,{iss:origin+'/'}),
  issuerOther:claimsAt(start,{iss:'https://other.example'}),floatTime:claimsAt(start+0.5),stringTime:claimsAt(String(start)),shortNonce:claimsAt(start,{nonce:'abc'}),
  shortSecret:claimsAt(start,{secret:encode(new Uint8Array(16))}),secretPadding:claimsAt(start,{secret:encode(new Uint8Array(32))+'='})};
 for(const [name,claims] of Object.entries(cases)){const token=forge(claims);await assert.rejects(verifyBootToken(token,await configFor(token),{now:start}),error=>error.code==='invalid_boot_token'&&error.message==='This boot token is invalid, expired or already used.',name);}
 const missing=claimsAt(start);delete missing.nonce;const token=forge(missing);await assert.rejects(verifyBootToken(token,await configFor(token),{now:start}),{code:'invalid_boot_token'});
 const nonJson='boot1.'+encode(new TextEncoder().encode('x'.repeat(40)));await assert.rejects(verifyBootToken(nonJson,await configFor(nonJson),{now:start}),{code:'invalid_boot_token'});
 for(const bad of [undefined,'',`boot2.${'A'.repeat(60)}`,'boot1.'+'A'.repeat(39),'boot1.'+'A'.repeat(481),'boot1.'+'A+'.repeat(30)])await assert.rejects(verifyBootToken(bad,{APP_ORIGIN:origin,BOOTSTRAP_TOKEN_SHA256:'0'.repeat(64)},{now:start}),{code:'invalid_boot_token'});
 for(const digest of [undefined,'abc','g'.repeat(64)])await assert.rejects(verifyBootToken(mintBootToken(origin,{now:start}),{APP_ORIGIN:origin,BOOTSTRAP_TOKEN_SHA256:digest},{now:start}),{code:'boot_unavailable'});
 for(const issuer of ['http://admin.example','https://admin.example/','https://admin.example/path','not a url'])assert.throws(()=>mintBootToken(issuer,{now:start}),TypeError);
 assert.match(mintBootToken('http://localhost:8787',{now:start}),/^boot1\./);
});

test('boot access window accepts only whole hours from one to seventy-two',()=>{
 assert.equal(bootWindowMs({}),24*3600000);assert.equal(bootWindowMs({BOOT_ACCESS_HOURS:'1'}),3600000);assert.equal(bootWindowMs({BOOT_ACCESS_HOURS:72}),72*3600000);
 for(const hours of ['0','73','1.5','-1','','24h',' 24'])assert.throws(()=>bootWindowMs({BOOT_ACCESS_HOURS:hours}),{code:'boot_unavailable'},String(hours));
});

// ---- role policy invariants over random catalogs, actors, targets and requests ----
function randomCatalog(random){
 const capabilities={},roles={},badgeClasses={};
 for(let i=0;i<random.int(6);i++)capabilities[`cap-${i}`]={class:random.pick(['internal','user']),description:'Capability.'};
 const caps=Object.keys(capabilities);
 for(let i=0;i<random.int(6);i++){const cls=random.pick(['internal','user']),allowed=caps.filter(id=>cls==='internal'||capabilities[id].class==='user');roles[`role-${i}`]={class:cls,name:'Role',description:'Role.',capabilities:random.shuffle(allowed).slice(0,random.int(allowed.length+1)),...cls==='internal'&&random.chance(0.4)?{delegable:true}:{}};}
 for(const id of ['beta','system','staff'])if(random.chance(0.7))badgeClasses[id]=random.pick(['internal','delegable','user']);
 return validateCatalog({version:1,capabilities,roles,badgeClasses});
}
const attempt=fn=>{try{return {value:fn()};}catch(error){return {error};}};

test('no administrator decision can mint admins, self-promote, touch admins or add boot-only internal roles (seeded)',async()=>{
 await forEachSeed(200,async random=>{
  const catalog=randomCatalog(random),ids=[ADMIN_ROLE,...Object.keys(catalog.roles),'ghost'],pickRoles=()=>random.shuffle(ids).slice(0,random.int(4));
  const actor=random.pick([{kind:'boot'},{kind:'admin',owner:'actor'},{kind:'none'}]),target={owner:random.pick(['actor','other']),internal:random.chance(0.5),roles:pickRoles().filter(id=>catalogRole(catalog,id))};
  const next=pickRoles(),result=attempt(()=>assignmentDecision(actor,target,catalog,next));
  if(result.error){assert(typeof result.error.code==='string');return;}
  const roles=result.value;assert.deepEqual(roles,[...new Set(next)].sort());
  for(const id of roles){const role=catalogRole(catalog,id);assert(role,'only defined roles');if(role.class==='internal')assert.equal(target.internal,true,'internal roles need an internal account');}
  if(actor.kind==='none')assert.fail('an unauthenticated actor never decides');
  if(actor.kind==='admin'){
   assert.notEqual(target.owner,actor.owner,'never self');assert(!target.roles.includes(ADMIN_ROLE),'never changes an administrator');assert(!roles.includes(ADMIN_ROLE),'never grants admin');
   for(const id of roles)if(!target.roles.includes(id)&&catalogRole(catalog,id).class==='internal')assert.equal(catalog.roles[id]?.delegable,true,'new internal roles are boot-delegated');
  }
  // Effective authority fails closed: no internal capability or admin for ordinary or inactive accounts.
  const active=random.chance(0.8),authority=effectiveAuthority(catalog,{roles},{internal:target.internal,active});
  if(!target.internal)for(const cap of authority.capabilities)assert.equal(catalog.capabilities[cap].class,'user');
  if(authority.admin)assert(target.internal&&active);
 });
});

test('administrator catalog edits never reclassify capabilities, badges or internal roles (seeded mutations)',async()=>{
 await forEachSeed(200,async random=>{
  const before=randomCatalog(random),draft=structuredClone({...before,capabilities:{...before.capabilities},roles:{...before.roles},badgeClasses:{...before.badgeClasses}});
  const mutation=random.int(6),roleIds=Object.keys(draft.roles),capIds=Object.keys(draft.capabilities);
  if(mutation===0&&roleIds.length){const id=random.pick(roleIds);draft.roles[id]={...draft.roles[id],description:'Edited.'};}
  if(mutation===1&&roleIds.length){const id=random.pick(roleIds);draft.roles[id]={...draft.roles[id],class:draft.roles[id].class==='user'?'internal':'user',capabilities:[]};delete draft.roles[id].delegable;}
  if(mutation===2&&capIds.length){const id=random.pick(capIds);draft.capabilities[id]={...draft.capabilities[id],class:draft.capabilities[id].class==='user'?'internal':'user'};}
  if(mutation===3)draft.badgeClasses.beta=random.pick(['internal','delegable','user']);
  if(mutation===4)draft.roles['role-new']={class:random.pick(['internal','user']),name:'New',description:'New.',capabilities:[]};
  if(mutation===5&&roleIds.length)delete draft.roles[random.pick(roleIds)];
  const valid=attempt(()=>validateCatalog(draft));if(valid.error)return;const after=valid.value;
  assert.equal(catalogChangeAllowed({kind:'boot'},before,after),true);assert.equal(catalogChangeAllowed({kind:'none'},before,after),false);assert.equal(catalogChangeAllowed(undefined,before,after),false);
  if(catalogChangeAllowed({kind:'admin',owner:'a'},before,after)){
   assert.deepEqual(after.capabilities,before.capabilities);assert.deepEqual(after.badgeClasses,before.badgeClasses);
   for(const id of new Set([...Object.keys(before.roles),...Object.keys(after.roles)]))if(JSON.stringify(before.roles[id])!==JSON.stringify(after.roles[id])){assert.notEqual(before.roles[id]?.class,'internal');assert.notEqual(after.roles[id]?.class,'internal');}
  }
 });
});

test('badge decisions: administrators add only user or already-held badges and never decorate admins or themselves',async()=>{
 await forEachSeed(150,async random=>{
  const catalog=randomCatalog(random),known=['beta','system','staff'],actor=random.pick([{kind:'boot'},{kind:'admin',owner:'actor'}]);
  const target={owner:random.pick(['actor','other']),internal:random.chance(0.5),roles:random.chance(0.2)?[ADMIN_ROLE]:[],badgeIds:random.shuffle(known).slice(0,random.int(3))};
  const next=random.shuffle([...known,...random.chance(0.1)?['unknown']:[]]).slice(0,random.int(5)),result=attempt(()=>badgeDecision(actor,target,catalog,known,next));if(result.error)return;
  for(const id of result.value){const cls=catalog.badgeClasses[id]??'internal';if(cls!=='user')assert.equal(target.internal,true);if(actor.kind==='admin'&&!target.badgeIds.includes(id))assert.notEqual(cls,'internal');}
  if(actor.kind==='admin'){assert.notEqual(target.owner,'actor');assert(!target.roles.includes(ADMIN_ROLE));}
 });
 assert.throws(()=>badgeDecision({kind:'boot'},{internal:true},validateCatalog({version:1,capabilities:{},roles:{},badgeClasses:{}}),['a','b','c','d','e'],['a','b','c','d','e']),{code:'invalid_badges'});
});

// ---- admin store invariants ----
test('admin rate windows stay closed when callers report slightly earlier clocks (skewed isolates cannot reset the window)',async()=>withStore(async store=>{
 const rate=now=>({key:'admin-actor',limit:3,windowMs:600000,now}),results=[];
 // Alternating timestamps one millisecond apart, as from two isolates with skewed clocks.
 for(let i=0;i<10;i++)results.push((await store.commit({rate:rate(start+(i%2?-1:0))})).committed);
 assert.equal(results.filter(Boolean).length,3,'the limit holds across alternating skewed timestamps');
 // The window resets once it has elapsed; a clock stepped back by a whole window cannot lock the actor out forever.
 assert.equal((await store.commit({rate:rate(start+600000+5)})).committed,true);
 assert.equal((await store.commit({rate:rate(start-10*600000)})).committed,true);
}));

test('boot-token records only ever move unseen to reserved to consumed, and never back or away',async()=>withStore(async store=>{
 const key='boot-token/'+'a'.repeat(64),attemptWrite=async value=>store.commit({writes:{[key]:value}}).then(r=>r.committed,e=>e.code);
 assert.equal(await attemptWrite({phase:'consumed'}),'boot_token_consumed','cannot skip reservation');
 assert.equal(await attemptWrite(null),'boot_token_consumed');
 assert.equal(await attemptWrite({phase:'reserved',binding:'x'}),true);
 assert.equal(await attemptWrite({phase:'reserved',binding:'y'}),'boot_token_consumed','a reservation cannot be replaced');
 assert.equal(await attemptWrite({phase:'other'}),'boot_token_consumed');
 assert.equal(await attemptWrite({phase:'consumed'}),true);
 for(const value of [{phase:'consumed'},{phase:'reserved'},null])assert.equal(await attemptWrite(value),'boot_token_consumed','consumed is forever');
 assert.equal((await store.get(key)).phase,'consumed');
 // A refused transition rolls back every other write and the rate debit in the same commit.
 await assert.rejects(store.commit({writes:{catalog:{version:1},[key]:null},rate:{key:'r',limit:1,windowMs:1000,now:start},audit:{action:'x'}}),{code:'boot_token_consumed'});
 assert.equal(await store.get('catalog'),null);assert.equal(await store.get('audit-head'),null);assert.equal((await store.commit({rate:{key:'r',limit:1,windowMs:1000,now:start}})).committed,true);
}));

test('audit chain verification detects edits, deletions, reordering, truncation and forged heads',async()=>{
 const build=async(store,n)=>{for(let i=0;i<n;i++)await store.commit({audit:{action:'entry',i}});};
 const pad=seq=>String(seq).padStart(12,'0');
 const tamper={
  edit:async m=>{const row=await m.get('admin/audit/'+pad(3));await m.put('admin/audit/'+pad(3),{...row,i:99});},
  rehash:async m=>{const row=await m.get('admin/audit/'+pad(3));await m.put('admin/audit/'+pad(3),{...row,hash:'f'.repeat(64)});},
  deleteMiddle:async m=>{await m.delete('admin/audit/'+pad(3));},
  swap:async m=>{const a=await m.get('admin/audit/'+pad(2)),b=await m.get('admin/audit/'+pad(3));await m.put('admin/audit/'+pad(2),b);await m.put('admin/audit/'+pad(3),a);},
  truncate:async m=>{await m.delete('admin/audit/'+pad(5));},
  head:async m=>{await m.put('admin/audit-head',{seq:5,hash:'0'.repeat(64)});},
  extend:async m=>{const row=await m.get('admin/audit/'+pad(5));await m.put('admin/audit/'+pad(6),{...row,seq:6});},
 };
 for(const [name,mutate] of Object.entries(tamper))await withStore(async(store,metadata)=>{
  await build(store,5);assert.deepEqual(await store.verifyAudit(),{valid:true,seq:5});await mutate(metadata);
  assert.equal((await store.verifyAudit()).valid,false,name);
 });
 // A partial window verifies only its own links; reaching the end also checks the head.
 await withStore(async(store,metadata)=>{await build(store,120);assert.deepEqual(await store.verifyAudit({from:101,count:10}),{valid:true,seq:110});assert.deepEqual(await store.verifyAudit(),{valid:true,seq:120});
  await metadata.put('admin/audit-head',{seq:119,hash:'0'.repeat(64)});assert.deepEqual(await store.verifyAudit({from:10,count:5}),{valid:true,seq:14});assert.equal((await store.verifyAudit({from:100})).valid,false);
  await assert.rejects(store.verifyAudit({from:0}),TypeError);assert.equal((await store.verifyAudit({from:500})).valid,false,'a window after the end has no anchor');});
});

test('admin store listings are capped and paginate completely; keys and records are validated before any write',async()=>withStore(async store=>{
 for(let i=0;i<230;i++)await store.commit({writes:{[`reservation/name-${String(i).padStart(3,'0')}`]:{name:i}}});
 const seen=[];let startAfter='';for(let pages=0;pages<10;pages++){const rows=await store.list('reservation/',{startAfter,limit:100});assert(rows.length<=100);if(!rows.length)break;seen.push(...rows.map(r=>r.key));startAfter=rows.at(-1).key;}
 assert.equal(new Set(seen).size,230);assert.deepEqual(seen,[...seen].sort());
 for(const options of [{limit:101},{limit:0},{limit:1.5},{startAfter:'x'.repeat(254)}])await assert.rejects(store.list('reservation/',options),TypeError);
 for(const prefix of ['','boot/','audit','catalog/','claim-name/'])await assert.rejects(store.list(prefix),TypeError);
 for(const key of ['reservation/Upper','reservation/ab','principal/not-a-uuid','claim/x','other','boot-token/abc','audit/000000000001','audit-head'])await assert.rejects(store.commit({writes:{[key]:{v:1}}}),TypeError,key);
 for(const value of [[],'text',7])await assert.rejects(store.commit({writes:{'reservation/valid-name':value}}),TypeError);
 for(const rate of [{key:'UPPER',limit:1,windowMs:1,now:1},{key:'k',limit:1.5,windowMs:1,now:1},{key:'k',limit:1,windowMs:1,now:'1'}])await assert.rejects(store.commit({rate}),TypeError);
 await assert.rejects(store.invoke('delete',['catalog']),TypeError);
 assert.equal((await store.get('reservation/name-000')).revision,1);
}));

test('reserved and boot names are never allocatable as paid aliases in the namespace authority',async()=>{
 const metadata=new SqliteMetadata(':memory:'),storage=new IdentityShardStorage(metadata,{});try{
  for(const name of RESERVED_HANDLES){assert.equal(await storage.paidHandleClaim(name,crypto.randomUUID(),crypto.randomUUID()),false,name);assert.equal(await storage.paidHandleClaim(name.toUpperCase(),crypto.randomUUID(),crypto.randomUUID()),false,name);}
  assert.equal((await metadata.list({prefix:'identity-namespace/'})).size,0);
  // Configured names are also refused, and a boot-handle onboarding policy is invalid configuration.
  const configured=new IdentityShardStorage(metadata,{HOST_NAME_POLICY:JSON.stringify({version:1,reserved:[],onboarding:['vip-name']})});
  assert.equal(await configured.paidHandleClaim('vip-name',crypto.randomUUID(),crypto.randomUUID()),false);assert.equal(await configured.paidHandleClaim(BOOT_HANDLE,crypto.randomUUID(),crypto.randomUUID()),false);
 }finally{metadata.close();}
});

test('onboarding sweep at scale: bounded batches, never before expiry plus grace, never claimed rows, index fully drained',async()=>{
 const random=createRandom(Number(process.env.CHAOS_SEED??11)),metadata=new SqliteMetadata(':memory:'),storage=new IdentityShardStorage(metadata,{});try{
  const digest='c'.repeat(64),binding='b'.repeat(43),rows=[];
  for(let i=0;i<220;i++){const name=`bulk-${String(i).padStart(3,'0')}`,expiresAt=start+random.int(4)*3600000;assert(await storage.onboardingReserve({name,owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()},{nonce:crypto.randomUUID(),expiresAt},digest));
   const claimed=random.chance(0.25);if(claimed)assert.equal((await storage.onboardingClaim(name,digest,binding)).phase,'claiming');rows.push({name,expiresAt,claimed});}
  const at=start+2*3600000+ONBOARDING_RELEASE_GRACE_MS,released=[];let calls=0,result;
  // A full batch asks to be re-run shortly (next = now + 1s); anything else is the next real due time.
  do{result=await storage.onboardingSweep({now:at,limit:64});assert(result.released.length<=64);released.push(...result.released);calls++;}while(result.next===at+1000&&calls<20);
  const due=rows.filter(r=>r.expiresAt+ONBOARDING_RELEASE_GRACE_MS<=at);
  assert(calls<=Math.ceil(due.length/64)+1,`bounded work: ${calls} sweeps for ${due.length} due entries`);
  assert.deepEqual(released.sort(),due.filter(r=>!r.claimed).map(r=>r.name).sort());
  for(const row of rows){const stored=await storage.handleLookup(row.name);if(released.includes(row.name))assert.equal(stored,null);else assert(stored,`${row.name} kept`);}
  const index=await metadata.list({prefix:'identity-onboarding-expiry/',limit:1000});
  assert.equal(index.size,rows.length-due.length,'due index entries are drained; only future ones remain');
  assert.equal(result.next,Math.min(...rows.filter(r=>!due.includes(r)).map(r=>r.expiresAt+ONBOARDING_RELEASE_GRACE_MS)));
  for(const options of [{now:at,limit:0},{now:at,limit:257},{now:'x'}])await assert.rejects(storage.onboardingSweep(options),TypeError);
 }finally{metadata.close();}
});
