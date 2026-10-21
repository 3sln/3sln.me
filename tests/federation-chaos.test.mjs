// Engine-level contention, fault injection and bounded-scaling tests for federation sessions and authorization entries.
// Every schedule and fault plan is seeded (tests/helpers/chaos.mjs); a failure names its seed for CHAOS_SEED replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryFederationStore} from '../packages/federation/index.mjs';
import {provider,dpopKey,tokenNonce,codeOf,clientId,issuer,entryBody,appOrigin} from './authorization-entry-helpers.mjs';
import {ctx,entry,serviceFixture,owner} from './federation-engine-helpers.mjs';
import {createScheduler,injectFaults,forEachSeed} from './helpers/chaos.mjs';

const fulfilled=results=>results.filter(r=>r.status==='fulfilled').map(r=>r.value);
const tokenURL=`${issuer}/oauth/token`;

test('chaos: any interleaving of duplicate refreshes (and revocations) yields at most one rotation and then ends the session',async()=>{
 await forEachSeed(12,async random=>{
  const scheduler=createScheduler(random),f=await serviceFixture({store:scheduler.wrap(new MemoryFederationStore(),'store')}),first=await f.exchange(await f.connect());
  const refreshes=2+random.int(3),tasks=Array.from({length:refreshes},()=>()=>f.refresh(first.refresh_token));
  if(random.chance(0.5))tasks.push(()=>f.service.revoke(owner,first.grants[0]));
  if(random.chance(0.5))tasks.push(()=>f.service.revokeToken({token:first.refresh_token,clientId:'https://app.example/client'}));
  const results=await scheduler.run(random.shuffle(tasks)),wins=fulfilled(results).filter(value=>value?.refresh_token);
  assert.ok(wins.length<=1&&(tasks.length>refreshes||wins.length===1),`one rotation, none only if revoked first (${scheduler.trace.join(' | ')})`);
  for(const r of results)if(r.status==='rejected')assert.ok(['invalid_grant','unauthorized'].includes(r.reason.code),r.reason.message);
  // Two presentations of one refresh token are a reuse: nothing from this connection may survive.
  for(const token of [first.access_token,...wins.map(w=>w.access_token)])assert.equal(await f.alive(token),false);
  for(const token of [first.refresh_token,...wins.map(w=>w.refresh_token)])await assert.rejects(f.refresh(token));
 });
});

test('chaos: concurrent redemption of one authorization code issues exactly one token set',async()=>{
 await forEachSeed(10,async random=>{
  const scheduler=createScheduler(random),f=await serviceFixture({store:scheduler.wrap(new MemoryFederationStore(),'store')}),code=await f.connect();
  const results=await scheduler.run(Array.from({length:2+random.int(4)},()=>()=>f.exchange(code)));
  assert.equal(fulfilled(results).length,1);for(const r of results)if(r.status==='rejected')assert.equal(r.reason.code,'invalid_grant');
  assert.equal(await f.rows('federation/token/'),1);assert.equal(await f.rows('federation/family/'),1);assert.equal(await f.rows('federation/code/'),0);
 });
});

// A DPoP-bound session: same-key concurrent refreshes may share one rotation through the one-time grace, never fork.
async function boundSession(p,key,alex=p.signIn()){
 const e=await entry(p,{dpopJkt:key.jkt});await p.entries.select(e.entryId,ctx(alex),{nonce:e.nonce},e.page);const code=codeOf((await p.entries.decide(e.entryId,ctx(alex),{nonce:e.nonce,approved:[]},e.page)).redirectUri);
 return p.authority.exchange({code,verifier:e.verifier,clientId,redirectUri:'https://app.example/callback',dpop:await key.sign({htu:tokenURL,nonce:await tokenNonce(p),iat:Math.floor(p.clock()/1000)})});
}
const boundRefresh=async(p,key,refreshToken)=>({refreshToken,clientId,dpop:await key.sign({htu:tokenURL,nonce:await tokenNonce(p),iat:Math.floor(p.clock()/1000)})});
const live=async(p,token)=>{try{await p.authority.rpc(token,{version:'0',tx:crypto.randomUUID(),resource:'@profile',contract:'https://3sln.me/artefacts/contracts/profile/v1',method:'read',args:{}});return true;}catch(error){return error.code!=='unauthorized';}};

test('chaos: same-key concurrent refreshes of a bound session agree on one successor; a third presentation revokes it',async()=>{
 await forEachSeed(8,async random=>{
  const scheduler=createScheduler(random),p=await provider({shardStore:()=>scheduler.wrap(new MemoryFederationStore(),'shard')}),key=await dpopKey(),first=await boundSession(p,key);
  const count=2+random.int(2),inputs=await Promise.all(Array.from({length:count},()=>boundRefresh(p,key,first.refresh_token)));
  const results=await scheduler.run(inputs.map(input=>()=>p.authority.refresh(input))),wins=fulfilled(results);
  assert.ok(wins.length>=1&&wins.length<=2,scheduler.trace.join(' | '));assert.equal(new Set(wins.map(w=>w.refresh_token)).size,1,'the grace answer is the identical successor');
  const successor=wins[0].refresh_token,next=p.authority.refresh(await boundRefresh(p,key,successor));
  if(count>=3){await assert.rejects(next,{code:'invalid_grant'});for(const w of wins)assert.equal(await live(p,w.access_token),false);}
  else assert.ok((await next).refresh_token);
 });
});

test('faults: a lost bound-refresh response is recovered by the same key within the grace, never after it',async()=>{
 for(const late of [false,true]){
  let armed=false;const p=await provider({shardStore:()=>injectFaults(new MemoryFederationStore(),[{method:'transaction',mode:'after',when:()=>{const fire=armed;armed=false;return fire;}}])}),key=await dpopKey(),first=await boundSession(p,key);
  armed=true;await assert.rejects(p.authority.refresh(await boundRefresh(p,key,first.refresh_token)),{code:'injected_fault'});
  if(late)p.time.advance(30001);
  const retry=p.authority.refresh(await boundRefresh(p,key,first.refresh_token));
  if(late){await assert.rejects(retry,{code:'invalid_grant'});assert.equal(await live(p,first.access_token),false);continue;}
  const recovered=await retry,onward=await p.authority.refresh(await boundRefresh(p,key,recovered.refresh_token));assert.equal(await live(p,onward.access_token),true);
 }
});

test('faults: a lost code-exchange response burns the code without a second issuance, and expiry reclaims the orphan',async()=>{
 let armed=false;const store=injectFaults(new MemoryFederationStore(),[{method:'transaction',mode:'after',when:()=>{const fire=armed;armed=false;return fire;}}]),f=await serviceFixture({store}),code=await f.connect();
 armed=true;await assert.rejects(f.exchange(code),{code:'injected_fault'});await assert.rejects(f.exchange(code),{code:'invalid_grant'});
 assert.equal(await f.rows('federation/family/'),1);f.clock.advance(180*86400000);
 for(let pass=0;pass<4&&(await f.service.cleanup({limit:2})).remaining;pass++);
 for(const kind of ['code','token','refresh','family','request'])assert.equal(await f.rows(`federation/${kind}/`),0,kind);
});

test('chaos: random storage faults (throw, partial commit, duplicate, timeout) never fork a refresh family or leak unbounded state',async()=>{
 const allowed=new Set(['injected_fault','timeout','invalid_grant','unauthorized','rate_limited','invalid_request','stale_consent','not_found']);
 await forEachSeed(10,async random=>{
  let faulty=true;const rules=[['throw',0.08],['after',0.08],['duplicate',0.05],['timeout',0.04]].map(([mode,p])=>({method:'transaction',mode,when:call=>faulty&&random.chance(p)}));
  const store=injectFaults(new MemoryFederationStore(),rules),f=await serviceFixture({store}).catch(()=>null);if(!f)return;
  const attempt=async operation=>{try{return await operation();}catch(error){assert.ok(allowed.has(error.code),`${error.code}: ${error.message}`);return null;}};
  let current=null;
  for(let step=0;step<25;step++){
   const choice=random.int(10);
   if(!current||choice===0){const code=await attempt(()=>f.connect());if(code)current=await attempt(()=>f.exchange(code))??current;}
   else if(choice<7){const next=await attempt(()=>f.refresh(current.refresh_token));if(next)current=next;}
   else if(choice===7)await attempt(()=>f.service.revoke(owner,current.grants[0]));
   else f.clock.advance(random.int(400000));
  }
  faulty=false;
  // One live successor per family: every unused refresh record is its family's current hash.
  const rows=await store.transaction(tx=>tx.list('federation/'));
  for(const {value} of rows.filter(r=>r.key.startsWith('federation/family/'))){const unused=rows.filter(r=>r.key.startsWith('federation/refresh/')&&r.value.familyId===value.familyId&&!r.value.used);assert.ok(unused.length<=1);if(unused.length)assert.equal(unused[0].key,`federation/refresh/${value.currentHash}`);}
  f.clock.advance(180*86400000+1);for(let pass=0;pass<8&&(await f.service.cleanup()).remaining;pass++);
  for(const kind of ['code','token','refresh','family','request','dpop'])assert.equal(await f.rows(`federation/${kind}/`),0,kind);
 });
});

test('chaos: racing decisions and a cancel on one entry produce exactly one outcome',async()=>{
 await forEachSeed(12,async random=>{
  const scheduler=createScheduler(random),p=await provider({store:scheduler.wrap(new MemoryFederationStore(),'entries'),shardStore:()=>scheduler.wrap(new MemoryFederationStore(),'shard')});
  const alex=p.signIn(p.accounts[0]),sam=p.signIn(p.accounts[1]),e=await entry(p);
  for(const session of [alex,sam])await p.entries.select(e.entryId,ctx(session),{nonce:e.nonce},e.page);
  const tasks=[()=>p.entries.decide(e.entryId,ctx(alex),{nonce:e.nonce,approved:[]},e.page),()=>p.entries.decide(e.entryId,ctx(sam),{nonce:e.nonce,approved:[]},e.page)];if(random.chance(0.6))tasks.push(()=>p.entries.cancel(e.entryId,{nonce:e.nonce},e.page));
  const results=await scheduler.run(random.shuffle(tasks)),outcomes=fulfilled(results);
  assert.equal(outcomes.length,1,`one outcome (${scheduler.trace.join(' | ')})`);
  for(const r of results)if(r.status==='rejected')assert.equal(r.reason.code,'invalid_request');
  await assert.rejects(p.entries.view(e.entryId),{code:'invalid_request'});
 });
});

test('scaling: entry creation budgets cap each caller and the store, and cleanup drains every expired row',async()=>{
 const store=new MemoryFederationStore(),p=await provider({store,limits:{global:45}}),rows=async()=>(await store.transaction(tx=>tx.list(''))).length;
 const create=remote=>p.entries.create(entryBody().body,{origin:appOrigin,remote});
 for(let i=0;i<30;i++)await create('caller-a');
 await assert.rejects(create('caller-a'),{code:'rate_limited'});
 for(let i=0;i<15;i++)await create(`caller-${i}`);await assert.rejects(create('caller-new'),{code:'rate_limited'},'the store-wide budget holds');
 p.time.advance(1200000);await create('caller-a');
 let passes=0;while((await p.entries.cleanup({limit:16})).remaining)passes++;
 assert.ok(passes<=4);p.time.advance(1200000);await p.entries.cleanup({limit:128});assert.equal(await rows(),0,'nothing outlives its window');
});
