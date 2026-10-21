// BB-B2 consumer side of delegation status (spec §3.4): bounded caches, the 5-minute status reuse, persisted
// revocations, quarantine by revokedHour and the recheck sweep. Provider-side issuance is IDKEYS-2.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,P,NOW,uuidOf} from './receive-fixtures.test.mjs';
import {boundedCache,verificationPorts} from '../../packages/bindlebox-engine/domains/delegation.mjs';
import {memoryStore} from './helpers/engine.mjs';

test('the bounded cache evicts least recently used entries and honours expiry',()=>{
 const cache=boundedCache(3);for(const k of ['a','b','c'])cache.set(k,k,100);
 assert.equal(cache.get('a',50),'a');cache.set('d','d',100);assert.equal(cache.get('b',50),undefined,'b was least recently used');
 assert.equal(cache.size,3);assert.equal(cache.get('a',101),undefined,'expired');
 const big=boundedCache();for(let i=0;i<5000;i++)big.set(String(i),i,1e15);assert.equal(big.size,1024);
});

test('ports: no directory means no fetch; active status is reused for 5 minutes; revocations are learned once',async()=>{
 const none=verificationPorts({directory:null,store:memoryStore(),now:NOW});assert.equal(await none.resolveKey({}),null);assert.equal(none.status,undefined);
 let calls=0,answer={status:'active'};const directory={resolveKey:async()=>null,status:async()=>{calls++;return answer;}},store=memoryStore(),q={issuer:'https://a.example',subject:P.alice.principal.subject,jkt:'k1'};
 assert.deepEqual(await verificationPorts({directory,store,now:NOW}).status(q),{status:'active'});
 await verificationPorts({directory,store,now:NOW+299999}).status(q);assert.equal(calls,1);
 answer={status:'revoked',revokedHour:5};const later=verificationPorts({directory,store,now:NOW+300001});
 assert.deepEqual(await later.status(q),{status:'revoked',revokedHour:5});assert.equal(calls,2);assert.equal(later.learned.length,1);
 answer={status:'active'};assert.equal((await verificationPorts({directory,store,now:NOW+1e9}).status(q)).status,'revoked','a cached revocation never reverts');
 // Malformed or missing answers are not "active": the protocol maps them to 503.
 const odd=verificationPorts({directory:{resolveKey:async()=>null,status:async()=>({status:'maybe'})},store,now:NOW});assert.deepEqual(await odd.status({...q,jkt:'k2'}),{status:'maybe'});
});

test('quarantine follows revokedHour - 1 h, and the recheck sweep learns revocations without new traffic',async t=>{
 const w=await createWorld();t.after(()=>w.dispose());const link=await w.link('bob',{kinds:['conversation-init','one-off']});
 // An old item (created two hours before the revocation hour) stays; a recent one is quarantined.
 const hour=Math.floor(NOW/3600000);
 assert.equal((await w.deliver('alice','bob',link,{operationId:uuidOf(1),createdAt:(hour-2)*3600000})).status,200);
 assert.equal((await w.deliver('alice','bob',link,{operationId:uuidOf(2),createdAt:NOW-1000})).status,200);
 assert.equal((await w.system('bob','delegation.recheck',{})).checked,1,'never checked: due at once');
 w.directory.revoke(P.alice.jkt,hour);
 assert.equal((await w.system('bob','delegation.recheck',{})).checked,0,'checked less than 5 minutes ago');
 w.clock.advance(300000);const result=await w.system('bob','delegation.recheck',{});assert.deepEqual(result,{checked:1,revoked:1,unavailable:0});
 const items=await w.items('bob'),byOp=Object.fromEntries(items.map(i=>[i.operationId,i]));
 assert.equal(byOp[uuidOf(1)].quarantined,false);assert.equal(byOp[uuidOf(2)].quarantined.reason,'delegation_revoked');
 // Directory outage during the sweep is counted, not fatal; an owner may trigger it, an ingress actor may not.
 w.directory.outage('status');w.clock.advance(300000);
 const {DelegationRecheck}=await import('../../packages/bindlebox-engine/domains/delegation.mjs'),bob=w.peer('bob');
 assert.equal((await w.run('bob','delegation.recheck',{})).checked,0,'a revoked key is no longer rechecked');
 assert.equal((await w.deliver('carol','bob',link,{operationId:uuidOf(3),createdAt:w.clock.now()-1000})).status,200);w.clock.advance(300000);
 assert.deepEqual(await w.system('bob','delegation.recheck',{}),{checked:1,revoked:0,unavailable:1});
 await assert.rejects(bob.engine.perform(new DelegationRecheck({actor:{kind:'ingress',owner:bob.owner},input:{}})),{code:'unauthorized'});
});
