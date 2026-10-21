// ACT-1 engine-level activity: app-bound admission with signed evidence, typed app tags, collapse scope, expiry,
// retraction, rate limits, multi-account isolation and seeded chaos interleavings with lost commit acknowledgements.
// Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine,OWNER,OTHER,ownerActor} from './helpers/app-engine.mjs';
import {forEachSeed,concurrently} from './helpers/chaos.mjs';
import {canonical} from '../packages/core/primitives.mjs';
import {base64url,key,digest} from '../packages/core/records.mjs';
import {ACCOUNT_OPERATIONS} from '../packages/app/operations.mjs';
import {CreateActivity,ReplaceActivity,RetractActivity,ActivityFeed,ActivityItem,MarkActivity,ArchiveActivity,DeleteActivity,LegacyActivityPage,PendingActivity} from '../packages/app/domains/activity.mjs';
import {verifyEvidence,ACTIVITY_LIMITS,activityFromAppMessage} from '../packages/activity/index.mjs';

const ISSUER='https://provider.example';
async function signer(){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),kid='k1',jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
 return {kid,sign:async payload=>base64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(canonical(payload))))),jwks:{keys:[{...jwk,kid,alg:'ES256'}]}};
}
const connectionId=n=>`${String(n).padStart(8,'0')}-0000-8000-a000-000000000000`;
async function setup({seed,owner=OWNER,bind=true,...options}={}){
 const f=await createTestEngine({seed,...options}),keys=await signer();if(bind)await f.metadata.put('owner',owner);
 let n=0;
 /** An approved bindle app connection record, and the app actor the resource handler would build for it. */
 const connect=async({app='cal',generation=1,admission=2,owner:who=owner,id=connectionId(++n)}={})=>{
  const clientId=`https://${app}.example/client`,origin=`https://${app}.example`,name=`${app} app`;
  await f.metadata.put('resource/'+id,{id,owner:who,clientId,name,status:'active',generation,kind:'app-connection',provider:'app',transport:'bindle',appOrigin:origin,notifications:{enabled:true,generation:admission}});
  const actor={kind:'app',owner:who,issuer:ISSUER,app:{clientId,origin,name},connection:{id,generation,admissionGeneration:admission}};
  const input=(extra={})=>({operationId:crypto.randomUUID(),createdAt:f.clock.now(),...extra});
  const op=(Action,data)=>f.perform(new Action({actor,input:data,keys}));
  return {actor,id,
   create:(extra={})=>op(CreateActivity,{...input(),subject:'Build finished',body:'All checks passed.',...extra}),
   replace:(item,expectedRevision,extra={})=>op(ReplaceActivity,{...input(),item,expectedRevision,subject:'Build updated',body:'New result.',...extra}),
   retract:(item,expectedRevision,extra={})=>op(RetractActivity,{...input(),item,expectedRevision,...extra}),
   raw:(Action,data)=>op(Action,data),
   disable:async()=>{const r=await f.metadata.get('resource/'+id);await f.metadata.put('resource/'+id,{...r,notifications:{enabled:false,generation:admission}});},
   reconnect:async()=>{const r=await f.metadata.get('resource/'+id);await f.metadata.put('resource/'+id,{...r,generation:generation+1});return connect({app,generation:generation+1,admission,owner:who,id});},
  };
 };
 const as=who=>({
  list:(input={})=>f.read(new ActivityFeed({actor:ownerActor(who),input})),get:(id,input)=>f.read(new ActivityItem({actor:ownerActor(who),id,input})),
  mark:(id,input)=>f.perform(new MarkActivity({actor:ownerActor(who),id,input})),archive:(id,archived)=>f.perform(new ArchiveActivity({actor:ownerActor(who),id,input:{archived}})),
  remove:id=>f.perform(new DeleteActivity({actor:ownerActor(who),id})),legacy:(input={})=>f.read(new LegacyActivityPage({actor:ownerActor(who),input})),
 });
 const events=async(who=owner)=>[...(await f.metadata.list({prefix:key('activity-event',who)})).values()];
 return {...f,keys,connect,owner:as(owner),as,events,minute:()=>f.clock.advance(61000)};
}
const rejects=(promise,code)=>assert.rejects(promise,error=>{assert.equal(error.code,code,`expected ${code}, got ${error.code}: ${error.message}`);return true;});

test('an admitted item carries required app attribution, qualified tags and verifiable signed evidence', async t=>{
 const f=await setup();t.after(()=>f.dispose());const cal=await f.connect();
 const result=await cal.create({tags:['receipt','sys.spam'],priority:'urgent',collapseKey:'build-1'});
 assert.deepEqual(Object.keys(result).sort(),['admittedAt','item','revision'],'the app learns only its own item, revision and admission time');
 const [row]=(await f.owner.list()).items;
 assert.equal(row.app.principal,`${ISSUER}#https://cal.example/client`);assert.equal(row.app.origin,'https://cal.example');assert.equal(row.read,false);
 assert.deepEqual(row.tags.map(t=>[t.namespace,t.app,t.id]),[['app',row.app.principal,'receipt'],['app',row.app.principal,'sys.spam']],'a sys.-looking local ID stays an app tag');
 const detail=await f.owner.get(result.item);assert.equal(detail.content.body,'All checks passed.');assert.equal(detail.history.length,1);
 const [{evidence,attestation}]=detail.history;
 assert.equal(await verifyEvidence(evidence,attestation,{issuer:ISSUER,keys:f.keys.jwks}),true);
 for(const forged of [{...evidence,subject:'Pay now'},{...evidence,app:{...evidence.app,clientId:'https://bank.example/client'}},{...evidence,account:OTHER},{...evidence,priority:'low'}])assert.equal(await verifyEvidence(forged,attestation,{issuer:ISSUER,keys:f.keys.jwks}),false);
 assert.equal(await verifyEvidence(evidence,attestation,{issuer:'https://elsewhere.example',keys:f.keys.jwks}),false,'verification anchors to the admitting issuer');
 assert.equal(evidence.expiresAt,null);assert.equal(evidence.previousRevision,null,'absent values are explicit');
 assert.ok(!Object.hasOwn(ACCOUNT_OPERATIONS,'activity.create')&&!Object.hasOwn(ACCOUNT_OPERATIONS,'activity.replace')&&!Object.hasOwn(ACCOUNT_OPERATIONS,'activity.retract'),'app mutations are never owner-dispatchable');
});

test('spoofed sys: tags and forged attribution fields are refused before any effect or charge', async t=>{
 const f=await setup();t.after(()=>f.dispose());const cal=await f.connect();
 for(const tag of ['sys:spam','SYS:spam','ｓｙｓ：spam','s​ys:spam','‮sys:spam','sys:suspected.spam','receipt:paid','x：y'])await rejects(cal.create({tags:[tag]}),'reserved_tag');
 for(const tags of [['Spam'],['-x'],['a b'],['x'.repeat(65)],[{namespace:'sys',id:'spam'}],['dup','dup'],Array.from({length:32},(_,i)=>`t${i}`)])await rejects(cal.create({tags}),'invalid_args');
 for(const field of [{app:{clientId:'https://bank.example/client'}},{origin:'https://bank.example'},{sender:'bank'},{recipient:OTHER},{account:OTHER},{system:true},{read:true},{channel:'push'},{namespace:'sys'}])await rejects(cal.create(field),'invalid_args');
 for(const priority of ['URGENT','emergency',1])await rejects(cal.create({priority}),'invalid_args');
 assert.equal((await f.owner.list()).items.length,0);
 for(let i=0;i<ACTIVITY_LIMITS.app.minute;i++)await cal.create({tags:['ok']});
 await rejects(cal.create(),'rate_limited');
});

test('cross-app impersonation, replaced incarnations, disabled admission and authority confusion are refused', async t=>{
 const f=await setup();t.after(()=>f.dispose());const cal=await f.connect({app:'cal'}),bank=await f.connect({app:'bank'});
 const {item}=await cal.create();
 await rejects(bank.replace(item,1),'not_found');await rejects(bank.retract(item,1),'not_found');
 // The actor must match the live connection record exactly: a borrowed origin, name or client is refused.
 for(const forged of [{...cal.actor,app:{...cal.actor.app,origin:'https://bank.example'}},{...cal.actor,app:{...cal.actor.app,clientId:'https://bank.example/client'}},{...cal.actor,connection:{...cal.actor.connection,admissionGeneration:1}},{...cal.actor,connection:{...bank.actor.connection}}])
  await rejects(f.perform(new CreateActivity({actor:forged,keys:f.keys,input:{operationId:crypto.randomUUID(),createdAt:f.clock.now(),subject:'s',body:'b'}})),'forbidden');
 await rejects(f.perform(new CreateActivity({actor:{...cal.actor,extra:1},keys:f.keys,input:{}})),'unauthorized');
 await rejects(f.perform(new CreateActivity({actor:ownerActor(),keys:f.keys,input:{}})),'forbidden');
 await rejects(f.read(new ActivityFeed({actor:cal.actor})),'forbidden');
 await rejects(f.perform(new CreateActivity({actor:cal.actor,input:{operationId:crypto.randomUUID(),createdAt:f.clock.now(),subject:'s',body:'b'}})),'temporarily_unavailable');
 // Reconnecting is a new incarnation: it inherits no mutation authority, and the old credential is dead.
 const again=await cal.reconnect();
 await rejects(again.replace(item,1),'not_found');await rejects(cal.replace(item,1),'forbidden');
 const fresh=await again.create();await again.disable();
 await rejects(again.create(),'forbidden');await rejects(again.retract(fresh.item,1),'forbidden');
 assert.equal((await f.owner.list()).items.length,2);
});

test('collapse keys only coalesce pending notification work within one app connection incarnation', async t=>{
 const f=await setup();t.after(()=>f.dispose());const cal=await f.connect({app:'cal'}),bank=await f.connect({app:'bank'});
 const a=await cal.create({collapseKey:'k'}),b=await cal.create({collapseKey:'k',subject:'Second'}),c=await bank.create({collapseKey:'k'});
 assert.equal((await f.owner.list()).items.length,3,'equal keys never merge retained items');
 const groups=await f.events();assert.equal(groups.length,2,'another app with the same key is a separate group');
 assert.deepEqual(groups.find(g=>g.members.length===2).members.map(m=>m.item),[a.item,b.item]);
 await f.owner.mark(a.item,{revision:1,read:true});
 assert.equal((await f.owner.get(b.item)).read,false,'collapse never merges read state');
 // Retracting the latest member falls back to the earlier eligible one; archiving that leaves nothing pending.
 await f.owner.mark(a.item,{revision:1,read:false});
 const before=(await f.owner.list()).items.find(i=>i.id===a.item);assert.equal(before.subject,'Build finished','another item keeps its own content');
 const pendingFor=async()=>(await f.read(new PendingActivity({actor:ownerActor()}))).map(p=>p.item).sort();
 assert.deepEqual(await pendingFor(),[a.item,b.item,c.item].filter(id=>id!==a.item).sort(),'only the latest of a group is pending');
 await cal.retract(b.item,1);assert.deepEqual(await pendingFor(),[c.item],'read items are ineligible, so nothing else of the group is pending');
 const d=await cal.create({collapseKey:'k'});await f.owner.archive(d.item,true);
 assert.deepEqual(await pendingFor(),[c.item]);
 // A reconnected incarnation and another account never share the group.
 const groupsBefore=(await f.events()).length,again=await cal.reconnect();await again.create({collapseKey:'k'});
 assert.equal((await f.events()).length,groupsBefore+1);
 // A replacement moving to a new key moves its pending membership; it never creates new notification work.
 const e=await bank.create(),eventsBefore=(await f.events()).length;await bank.replace(e.item,1,{collapseKey:'k'});
 assert.equal((await f.events()).length,eventsBefore-1);
});

test('admission limits: per app across reconnection, aggregate per account, retract reserve and free identical retries', async t=>{
 const f=await setup();t.after(()=>f.dispose());let cal=await f.connect({app:'cal'});
 const items=[];for(let i=0;i<ACTIVITY_LIMITS.app.minute;i++)items.push(await cal.create());
 const refused=await cal.create().catch(e=>e);assert.equal(refused.code,'rate_limited');assert.ok(refused.retryAfter>0&&refused.retryAfter<=60);
 await rejects(cal.replace(items[0].item,1),'rate_limited');
 await cal.retract(items[0].item,1);// the reserve cannot be starved by creates
 cal=await cal.reconnect();await rejects(cal.create(),'rate_limited');
 f.minute();
 const data={operationId:crypto.randomUUID(),createdAt:f.clock.now(),subject:'s',body:'b'},first=await cal.raw(CreateActivity,data);
 for(let i=0;i<5;i++)assert.deepEqual(await cal.raw(CreateActivity,data),first,'an identical retry returns the retained outcome');
 await rejects(cal.raw(CreateActivity,{...data,subject:'changed'}),'tx_conflict');
 await rejects(cal.raw(ReplaceActivity,{...data,item:first.item,expectedRevision:1}),'tx_conflict');
 for(let i=0;i<ACTIVITY_LIMITS.app.minute-1;i++)await cal.create();// retries were not charged
 await rejects(cal.create(),'rate_limited');
 // Many apps cannot exceed the account aggregate.
 f.minute();const apps=await Promise.all(['a','b','c','d'].map(app=>f.connect({app})));let admitted=0;
 for(let i=0;i<40;i++)await apps[i%4].create().then(()=>admitted++,e=>assert.equal(e.code,'rate_limited'));
 assert.equal(admitted,ACTIVITY_LIMITS.account.minute);
 // Old operations never execute as new.
 await rejects(apps[0].create({createdAt:f.clock.now()-ACTIVITY_LIMITS.operationWindow}),'operation_expired');
 await rejects(apps[0].create({createdAt:f.clock.now()+ACTIVITY_LIMITS.futureSkew+1}),'operation_expired');
});

test('expiry is terminal for app mutations and pending work, without erasing retained content', async t=>{
 const f=await setup();t.after(()=>f.dispose());const cal=await f.connect();
 for(const expiresAt of [f.clock.now(),f.clock.now()-1,f.clock.now()+ACTIVITY_LIMITS.maxExpiry+1])await rejects(cal.create({expiresAt}),'invalid_expiry');
 await rejects(cal.create({expiresAt:'tomorrow'}),'invalid_args');
 const {item}=await cal.create({expiresAt:f.clock.now()+3600000});
 const r2=await cal.replace(item,1,{expiresAt:f.clock.now()+7200000});assert.equal(r2.revision,2);
 f.clock.advance(7200000);
 await rejects(cal.replace(item,2,{expiresAt:f.clock.now()+3600000}),'expired');await rejects(cal.retract(item,2),'expired');
 const detail=await f.owner.get(item);assert.equal(detail.state,'expired');assert.equal(detail.content.inert,true);assert.equal(detail.content.subject,'Build updated');
 assert.deepEqual(await f.read(new PendingActivity({actor:ownerActor()})),[]);
 assert.equal((await f.owner.list({state:'expired'})).items.length,1);
});

test('replacement and retraction need the owning connection and exact revision; terminal items stay terminal', async t=>{
 const f=await setup();t.after(()=>f.dispose());const cal=await f.connect();
 const {item}=await cal.create();await f.owner.mark(item,{revision:1,read:true});await f.owner.archive(item,true);
 await rejects(cal.replace(item,2),'stale_revision');
 await cal.replace(item,1,{tags:['new']});
 let row=await f.owner.get(item);assert.equal(row.read,true);assert.equal(row.archived,true,'replacements preserve read and archive');
 await rejects(f.owner.mark(item,{revision:1,read:false}),'stale_revision');
 await rejects(cal.retract(item,1),'stale_revision');
 // Fill the history: the final slot is reserved for the terminal event.
 let revision=2;for(;revision<ACTIVITY_LIMITS.revisions-1;revision++){if(revision%9===0)f.minute();await cal.replace(item,revision);}
 f.minute();await rejects(cal.replace(item,revision),'revision_limit');
 const tomb=await cal.retract(item,revision);assert.equal(tomb.revision,ACTIVITY_LIMITS.revisions);
 row=await f.owner.get(item);assert.equal(row.state,'retracted');assert.equal(row.content.inert,true);assert.equal(row.history.at(-1).kind,'retract');
 assert.equal(await verifyEvidence(row.history.at(-1).evidence,row.history.at(-1).attestation,{issuer:ISSUER,keys:f.keys.jwks}),true,'the tombstone is signed');
 await rejects(cal.replace(item,tomb.revision),'terminal');await rejects(cal.retract(item,tomb.revision),'terminal');
 // Recipient deletion is terminal: the ID never becomes an upsert target.
 const other=await cal.create();await f.owner.remove(other.item);
 await rejects(cal.replace(other.item,1),'not_found');await rejects(f.owner.get(other.item),'not_found');
});

test('multi-account isolation: items, receipts, connections and collapse groups never cross accounts', async t=>{
 const f=await setup({bind:false});t.after(()=>f.dispose());
 const a=await f.connect({app:'cal',owner:OWNER}),b=await f.connect({app:'cal',owner:OTHER});
 const operationId=crypto.randomUUID(),data={operationId,createdAt:f.clock.now(),subject:'s',body:'b',collapseKey:'k'};
 const ra=await a.raw(CreateActivity,data),rb=await b.raw(CreateActivity,data);
 assert.notEqual(ra.item,rb.item,'the same operation ID in two accounts is two independent operations');
 assert.deepEqual((await f.as(OWNER).list()).items.map(i=>i.id),[ra.item]);assert.deepEqual((await f.as(OTHER).list()).items.map(i=>i.id),[rb.item]);
 await rejects(f.as(OTHER).get(ra.item),'not_found');await rejects(f.as(OTHER).mark(ra.item,{revision:1,read:true}),'not_found');await rejects(f.as(OTHER).remove(ra.item),'not_found');
 // An app actor naming another owner with this account's connection is refused, and so is replacing across accounts.
 await rejects(f.perform(new CreateActivity({actor:{...a.actor,owner:OTHER},keys:f.keys,input:{...data,operationId:crypto.randomUUID()}})),'forbidden');
 await rejects(b.replace(ra.item,1),'not_found');
 assert.equal((await f.events(OWNER)).length,1);assert.equal((await f.events(OTHER)).length,1);
 // A bound account store refuses any other owner, whoever dispatched.
 const g=await setup();t.after(()=>g.dispose());const foreign=await g.connect({owner:OTHER});
 await rejects(foreign.create(),'forbidden');await rejects(g.as(OTHER).list(),'forbidden');
});

test('the v1 adapter qualifies legacy tags under the verified app without normalizing them', async t=>{
 const f=await setup();t.after(()=>f.dispose());
 const p={purpose:'bindle-app-notification-admission-v1',issuer:ISSUER,owner:OWNER,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',clientId:'https://cal.example/client',origin:'https://cal.example',name:'Calendar',subject:'Hi',tags:['receipt','Paid Plan','sys:spam'],receivedAt:5,attestation:{alg:'ES256',kid:'k1',signature:'x'}};
 const row=activityFromAppMessage({id:p.id,owner:OWNER,readAt:null,appNotification:p});
 assert.deepEqual(row.tags.map(t=>[t.namespace,t.id??t.value]),[['app','receipt'],['app-legacy','Paid Plan'],['app-legacy','sys:spam']]);
 assert.equal(activityFromAppMessage({id:'x',owner:OWNER}),null,'unattributed messages are not app activity');
 await f.metadata.put(key('message',OWNER,p.id),{id:p.id,owner:OWNER,readAt:null,appNotification:p});
 assert.deepEqual((await f.owner.legacy()).items.map(i=>i.id),[p.id]);
});

test('chaos: interleaved app and owner operations with lost commit acknowledgements keep every invariant', async()=>{
 await forEachSeed(12,async random=>{
  const f=await setup({seed:random.seed,faults:{accountStore:[{method:'transaction',mode:'after',when:0.08}]}});
  try{
   const apps=[await f.connect({app:'cal'}),await f.connect({app:'bank'})],ops=[],created=new Map();
   for(let round=0;round<6;round++){
    const batch=Array.from({length:8},()=>{
     const app=random.pick(apps),known=[...created.keys()],roll=random.int(8),target=known.length?random.pick(known):null;
     if(roll<3||!target){const data={operationId:crypto.randomUUID(),createdAt:f.clock.now(),subject:'s',body:'b',...random.chance(0.5)?{collapseKey:random.pick(['x','y'])}:{},...random.chance(0.3)?{expiresAt:f.clock.now()+random.int(4)*60000+1}:{}};
      // A lost acknowledgement is retried with the same operation: it must not produce a second item.
      return async()=>{let r;for(let i=0;i<3&&!r;i++)r=await app.raw(CreateActivity,data).catch(e=>e.code==='injected_fault'?null:Promise.reject(e));if(r)created.set(r.item,app);ops.push(data.operationId);return r;};}
     const owner=created.get(target);
     return [()=>owner.replace(target,1+random.int(3),{collapseKey:random.pick(['x','y'])}),()=>owner.retract(target,1+random.int(3)),()=>app.retract(target,1),()=>f.owner.mark(target,{revision:1+random.int(2),read:random.chance(0.5)}),()=>f.owner.archive(target,random.chance(0.5)),()=>random.chance(0.2)?f.owner.remove(target):f.owner.get(target)][random.int(6)];
    });
    const results=await concurrently(batch);
    for(const r of results)if(r.status==='rejected')assert.ok(['stale_revision','terminal','expired','not_found','rate_limited','revision_limit','injected_fault'].includes(r.reason?.code),`unexpected ${r.reason?.code}: ${r.reason?.message}`);
    f.clock.advance(random.int(3)*30000);
   }
   assert.ok(created.size>0,'the run admitted items');
   // Invariants over durable state.
   const store=await f.metadata.list({prefix:'activity-'}),items=[...store].filter(([k])=>k.startsWith('activity-item/')).map(([,v])=>v);
   const usage=store.get(key('activity-usage',OWNER));assert.equal(usage?.items??0,items.length,'usage counts live items');
   for(const item of items){
    const revs=[...store].filter(([k])=>k.startsWith(key('activity-rev',OWNER,item.id))).map(([,v])=>v);
    assert.deepEqual(revs.map(r=>r.revision),Array.from({length:item.revisions},(_,i)=>i+1),'revisions are contiguous and never overwritten');
    assert.equal(item.revision,item.revisions);assert.equal(item.state==='retracted',revs.at(-1).kind==='retract','only a signed tombstone is terminal');
    assert.ok(revs.slice(0,-1).every(r=>r.kind!=='retract'),'nothing follows a retraction');
    if(item.state!=='active'||item.read||item.archived)assert.equal(item.eventGroup,null,'ineligible items hold no pending work');
    if(item.eventGroup)assert.ok(store.get(key('activity-event',OWNER,item.eventGroup))?.members.some(m=>m.item===item.id));
   }
   for(const [k,event]of store)if(k.startsWith('activity-event/'))for(const m of event.members){const item=items.find(i=>i.id===m.item);assert.ok(item&&item.eventGroup===event.group,'event members point back to their items');}
   const receipts=[...store].filter(([k])=>k.startsWith('activity-receipt/'));
   for(const id of ops)assert.ok(receipts.filter(([k])=>k.endsWith(`/${id}/`)).length<=1);
   const createdItems=new Set(receipts.filter(([,r])=>r.result.revision===1).map(([,r])=>r.result.item));
   assert.ok(items.every(i=>createdItems.has(i.id)),'every item came from exactly one retained create');
  }finally{await f.dispose();}
 });
});

// Regressions for the ACT-1 independent security review (docs/release/activity-design-review.md, "ACT-1 implementation").
test('S1: one app filling receipts or storage cannot starve another app\'s retraction or creation', async t=>{
 const f=await setup();t.after(()=>f.dispose());const spam=await f.connect({app:'spam'}),cal=await f.connect({app:'cal'});
 const mine=await cal.create();let limited=0;
 for(let day=0;day<3;day++){
  for(let i=0;i<100;i++){if(i%10===0)f.minute();const r=await spam.create().catch(e=>{assert.match(e.code,/rate_limited|capacity_exceeded/);limited++;return null;});if(r)await spam.retract(r.item,1).catch(e=>assert.equal(e.code,'rate_limited'));}
  f.clock.advance(86400000);
 }
 assert.ok(limited>0,'the spamming app hit its own receipt share');
 f.minute();assert.equal((await cal.retract(mine.item,1)).revision,2,'retraction capacity is never exhausted by another app');
 assert.ok((await cal.create()).item,'creation capacity remains for other apps');
});
test('S2: per-app storage share; S4: unsafe subjects; S5: whole-record verification; S9: hashed collapse groups', async t=>{
 const f=await setup();t.after(()=>f.dispose());const cal=await f.connect();
 await f.metadata.put(key('activity-usage',OWNER,await digest(crypto,canonical(['activity-app-v1',`${cal.actor.issuer}#${cal.actor.app.clientId}`]))),{items:ACTIVITY_LIMITS.appItems,bytes:0});
 await rejects(cal.create(),'capacity_exceeded');
 const other=await f.connect({app:'other'});
 for(const subject of ['‮evil','a⁦b','line break','​​','\u0085x','⁠﻿'])await rejects(other.create({subject}),'invalid_args');
 const {item}=await other.create({subject:'שלום world',collapseKey:'Secret.Topic-1'});
 const groups=await f.events();assert.ok(groups.every(g=>!g.group.includes('Secret')),'collapse keys are not stored verbatim in pending work');
 const {verifyRevision}=await import('../packages/activity/index.mjs'),record=await f.metadata.get(key('activity-rev',OWNER,item,'001')),ctx={issuer:ISSUER,keys:f.keys.jwks,owner:OWNER,item};
 assert.equal(await verifyRevision(record,ctx),true);
 assert.equal(await verifyRevision({...record,content:{...record.content,body:'Pay now'}},ctx),false);
 assert.equal(await verifyRevision(record,{...ctx,item:crypto.randomUUID()}),false);assert.equal(await verifyRevision(record,{...ctx,owner:OTHER}),false);
});
test('S3: legacy rows are unverified unless the caller verified them', ()=>{
 const p={purpose:'bindle-app-notification-admission-v1',issuer:'https://evil.example',owner:OWNER,id:'x',clientId:'c',origin:'o',name:'Your Bank',subject:'s',tags:[],receivedAt:1,attestation:{alg:'none'}};
 assert.equal(activityFromAppMessage({id:'x',owner:OWNER,appNotification:p}).verified,false);
 assert.equal(activityFromAppMessage({id:'x',owner:OWNER,appNotification:p},{verified:true}).verified,true);
});
