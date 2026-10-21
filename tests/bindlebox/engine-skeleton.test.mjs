import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Provider} from '../../vendor/ngin/index.js';
import {createMailboxEngine,MailboxAction,MailboxQuery,OwnerScopedProvider,operations} from '../../packages/bindlebox-engine/engine.mjs';
import {MailboxPing,MAILBOX_OPERATIONS} from '../../packages/bindlebox-engine/operations.mjs';
import {memoryEffects,PROVIDERS} from '../../packages/bindlebox-engine/providers.mjs';
import {MailboxFault,faultOf} from '../../packages/bindlebox-engine/faults.mjs';
import {createTestEngine,OWNER,OTHER,ownerActor,memoryStore} from './helpers/engine.mjs';
import {createNetwork} from './helpers/network.mjs';
import {forEachSeed,createRandom,createScheduler} from '../helpers/chaos.mjs';

test('mailbox factory requires explicit effects, rejects unknown providers and keeps its catalogue independent',async t=>{
 const effects=memoryEffects();for(const name of ['clock','random','audit']){const providers={...effects};delete providers[name];assert.throws(()=>createMailboxEngine({providers}),new RegExp(name));assert.throws(()=>createMailboxEngine({providers:{...effects,[name]:null}}),new RegExp(name));}
 assert.throws(()=>createMailboxEngine({providers:{...effects,accountStore:{}}}),/Uncatalogued/);
 assert.deepEqual(Object.keys(MAILBOX_OPERATIONS),['mailbox.ping']);assert.ok(Object.isFrozen(PROVIDERS));assert.ok(Object.isFrozen(MAILBOX_OPERATIONS));assert.equal(PROVIDERS.classifier.status,'planned');
 const engine=createMailboxEngine({providers:{...effects,clock:Provider.fromSingleton(effects.clock)}});t.after(()=>engine.dispose());
 const resource=await engine.container.use(['clock'],({clock})=>clock);assert.equal(resource,effects.clock);
});
test('the registered ping dispatches through the harness, strips wire fields and audits only safe metadata',async t=>{
 const e=createTestEngine();t.after(()=>e.dispose());const secret='private body and token';
 const operation=new MailboxPing({actor:e.actor(),input:{secret},deps:{clock:'injected'},run:()=>secret});assert.equal(operation.deps,undefined);assert.equal(Object.hasOwn(operation,'run'),false);
 assert.deepEqual(await e.run('mailbox.ping',{input:{secret}}),{owner:OWNER,now:e.clock.now(),status:'skeleton'});
 e.clock.advance(42);assert.equal((await e.perform(operation)).now,e.clock.now());
 await assert.rejects(e.run('mailbox.ping',{actor:{kind:'system',reason:'not an owner probe'}}),{code:'unauthorized',status:401});
 assert.deepEqual(e.audit.entries.map(entry=>entry.outcome),['ok','ok','error']);assert.equal(JSON.stringify(e.audit.entries).includes(secret),false);assert.deepEqual(e.events,[]);
 assert.throws(()=>e.run('constructor'),/Unknown operation/);
});
test('completion waits for inner hooks; audit observes leave failures and safe fault serialization',async t=>{
 const order=[],e=createTestEngine({interceptors:[{leave(){order.push('leave');throw new MailboxFault('test_failure','Safe failure.',409);}}]});t.after(()=>e.dispose());
 await assert.rejects(e.run('mailbox.ping').then(()=>order.push('resolved')),{code:'test_failure'});assert.deepEqual(order,['leave']);assert.equal(e.audit.entries[0].outcome,'error');
 assert.deepEqual(faultOf(new Error('secret')),{code:'internal_error',message:'The operation could not be completed.',status:500});assert.deepEqual(faultOf(new MailboxFault('conflict','Safe.',409)),{code:'conflict',message:'Safe.',status:409});
 assert.throws(()=>operations(MailboxPing,MailboxPing),/Duplicate/);assert.throws(()=>operations(class {}),/not a mailbox operation/);
});
class Scoped extends OwnerScopedProvider {static deps=['mailboxStore'];scope({mailboxStore},owner){return {owner,read:()=>mailboxStore.get('value')};}}
class Write extends MailboxAction {static operation='test.write';static deps=['contacts','mailboxStore'];static changes='incoming-changed';async run({mailboxStore}){return mailboxStore.transaction(async tx=>{await tx.put('value',this.input.value);return {value:this.input.value};});}}
class Value extends MailboxQuery {static operation='test.value';static deps=['contacts'];static refreshOn=['incoming-changed'];fetch({contacts}){return contacts.read();}}
test('owner grants resolve during the lease and transactional faults separate rollback from a lost reply',async t=>{
 for(const mode of ['throw','after']){
  const e=createTestEngine({providers:{contacts:Scoped},registry:operations(Write,Value),faults:{mailboxStore:[{method:'transaction',when:1,mode}]}});t.after(()=>e.dispose());
  await assert.rejects(e.perform(new Write({actor:ownerActor(OTHER),input:{value:1}})),{code:'forbidden'});assert.deepEqual(e.events,[]);
  await assert.rejects(e.perform(new Write({actor:e.actor(),input:{value:7}})),{code:'injected_fault'});assert.equal(await e.store.get('value'),mode==='after'?7:undefined);assert.deepEqual(e.events,[]);
  await e.perform(new Write({actor:e.actor(),input:{value:8}}));assert.equal(await e.read(new Value({actor:e.actor()})),8);assert.deepEqual(e.events.map(event=>event.owner),[OWNER]);
 }
 const store=memoryStore();await assert.rejects(store.transaction(async tx=>{await tx.put('x',1);throw new Error('rollback');}));assert.equal(await store.get('x'),undefined);
 const schedule=createScheduler(createRandom(7)),e=createTestEngine({providers:{contacts:Scoped},wrap:{mailboxStore:resource=>schedule.wrap(resource,'store')},registry:operations(Write)});t.after(()=>e.dispose());
 const settled=await schedule.run([()=>e.perform(new Write({actor:e.actor(),input:{value:1}})),()=>e.perform(new Write({actor:e.actor(),input:{value:2}}))]);assert.ok(settled.every(result=>result.status==='fulfilled'));assert.ok(schedule.trace.length);
});
test('multi-party simulator replays seeded fault plans with isolated stores, keys, provider fakes and clocks',async()=>{
 await forEachSeed(3,async random=>{
  const run=async()=>{const network=createNetwork({seed:random.seed,rules:[{to:'bob',when:.5,mode:'drop'}]});try{
   const alice=network.peers.get('alice'),bob=network.peers.get('bob');assert.notEqual(alice.store,bob.store);assert.notEqual(alice.delegateKeys.id,bob.delegateKeys.id);assert.notEqual(alice.providerLink,bob.providerLink);assert.equal(alice.delegateKeys.fake,true);
   await alice.store.put('private',1);assert.equal(await bob.store.get('private'),undefined);assert.equal((await alice.engine.engine.container.use(['directory'],({directory})=>directory.resolve('bob'))).ingress,bob.ingress);
   network.skew('bob',60000);assert.equal(bob.clock.now()-alice.clock.now(),60000);const outcomes=[];
   for(let i=0;i<8;i++){try{outcomes.push(await (await network.send('alice','bob',{op:'mailbox.ping'})).json());}catch(error){outcomes.push(error.code);}}
   return {outcomes,trace:network.trace,ids:[alice.owner,bob.owner]};
  }finally{await network.dispose();}};assert.deepEqual(await run(),await run());
 });
});
test('simulator covers delays, duplicate delivery, response loss after commit, retry statuses, partial results and recovery',async t=>{
 const network=createNetwork();t.after(()=>network.dispose());const bob=network.peers.get('bob');let commits=0;
 network.mount('bob',async()=>{await bob.store.put('commits',++commits);return Response.json({commits});});
 network.rules.push({to:'bob',when:1,mode:'after'},{to:'bob',when:2,mode:'duplicate'},{to:'bob',when:3,mode:'delay',ms:100},{to:'bob',when:4,mode:'rate-limit',retryAfter:17},{to:'bob',when:5,mode:'status',status:503},{to:'bob',when:6,mode:'partial',results:[{index:0,state:'unknown'}]},{to:'bob',when:7,mode:'trickle',body:'{}',ms:10});
 await assert.rejects(network.send('alice','bob',{}),{code:'connection_reset'});assert.equal(commits,1);
 assert.deepEqual(await (await network.send('alice','bob',{})).json(),{commits:3});
 const delayed=network.send('alice','bob',{});assert.equal(commits,3);await network.advance(100);assert.equal((await (await delayed).json()).commits,4);
 const limited=await network.send('alice','bob',{});assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'17');assert.equal((await network.send('alice','bob',{})).status,503);
 assert.deepEqual(await (await network.send('alice','bob',{})).json(),{results:[{index:0,state:'unknown'}]});const trickle=(await network.send('alice','bob',{})).text();await network.advance(20);assert.equal(await trickle,'{}');
 network.kill('bob');await assert.rejects(network.send('alice','bob',{}),{code:'host_unavailable'});await network.recover('bob');assert.equal(await bob.store.get('commits'),4);assert.equal((await (await network.send('alice','bob',{})).json()).commits,5);
});
const cli=(args,input='')=>{const result=spawnSync(process.execPath,['scripts/bindlebox.mjs',...args],{input,encoding:'utf8'});return {...result,lines:result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};};
test('CLI lists its own catalogue and drives deterministic independent peers, clock steps, audit and failure exit codes',()=>{
 const source=[{as:'alice',op:'mailbox.ping',expect:{status:'skeleton'}},{as:'bob',op:'mailbox.ping'},{advance:100},{as:'alice',op:'mailbox.ping'},{as:'alice',audit:true}].map(JSON.stringify).join('\n');
 const run=cli(['--peers','3','--seed','7','-'],source);assert.equal(run.status,0,run.stderr+run.stdout);assert.notEqual(run.lines[0].result.owner,run.lines[1].result.owner);assert.equal(run.lines[3].result.now-run.lines[0].result.now,100);assert.equal(run.lines[4].audit.length,2);assert.deepEqual(cli(['--peers','3','--seed','7','-'],source).lines,run.lines);
 assert.equal(cli(['-'],'{"op":"mailbox.ping","expect":{"status":"delivered"}}').status,1);assert.equal(cli(['-'],'{"op":"send.submit"}').status,1);assert.equal(cli(['-'],'null').status,1);assert.equal(cli(['--peers','0']).status,1);
 assert.deepEqual(cli(['--list']).lines.filter(line=>line.operation).map(line=>line.operation),['mailbox.ping']);
});
