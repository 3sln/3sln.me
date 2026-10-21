import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteMetadata} from '../../apps/node/resources.mjs';
import {fixture,P,NOW,uuidOf} from './outbox-fixture.mjs';

test('BB-B3 lost and duplicate ACKs retry identical operations with one recipient effect',async t=>{
 const f=await fixture(t,{rules:[{to:'bob',when:1,mode:'after'},{to:'bob',when:2,mode:'duplicate'}]});const {input}=await f.submit();await f.due();
 let view=await f.get(1);assert.equal(view.pending,1);assert.equal(view.recipients[0].state,'unknown');assert.equal(f.received.size,1);
 await f.drain();view=await f.get(1);assert.equal(view.delivered,1);assert.equal(view.recipients[0].attempts,2);assert.equal(f.received.size,1);
 await f.run('send.submit',{input});await f.drain();assert.equal(f.requests.length,2);
});

test('BB-B3 dead endpoint opens a durable breaker; a single half-open probe closes and catches up',async t=>{
 const f=await fixture(t,{rules:[{to:'bob',mode:'reset'}]});await f.submit();
 for(let n=0;n<5;n++)await f.due();
 const breakers=[...(await f.store.list({prefix:'bb:send:breaker/'})).values()];assert.equal(breakers[0].failures,5);assert.ok(breakers[0].until>NOW);
 const count=f.requests.length;f.clock.set(breakers[0].until-1);await f.restart();await f.drain();assert.equal(f.requests.length,count);
 f.network.rules.length=0;f.clock.set(Math.max(breakers[0].until,(await f.get(1)).recipients[0].nextAttemptAt));await f.drain();assert.equal((await f.get(1)).delivered,1);
 assert.equal([...(await f.store.list({prefix:'bb:send:breaker/'})).values()][0].until,0);
});

test('BB-B3 Retry-After, expiry and manual retry preserve spacing and finite budgets',async t=>{
 const f=await fixture(t,{limits:{attempts:1},rules:[{to:'bob',mode:'rate-limit',retryAfter:120}]});await f.submit({record:true});await f.drain();
 let view=await f.get(1);assert.equal(view.failed,1);const at=view.recipients[0].nextAttemptAt;assert.equal(at,NOW+120000);
 assert.equal((await f.run('outbox.retry-missing',{id:uuidOf(1)})).requeued,1);assert.equal((await f.run('outbox.retry-missing',{id:uuidOf(1)})).requeued,0);
 await f.restart();await f.drain();assert.equal(f.requests.length,1);assert.equal((await f.get(1)).recipients[0].nextAttemptAt,at);
 f.clock.set(at);f.network.rules.length=0;await f.drain();assert.equal((await f.get(1)).delivered,1);
 const far=await fixture(t,{rules:[{to:'bob',mode:'rate-limit',retryAfter:90000}]});await far.submit();await far.drain();assert.equal((await far.get(1)).failed,1);
 assert.equal([...(await far.store.list({prefix:'bb:send:breaker/'})).values()][0].failures,0);
});

test('BB-B3 per-person catch-up includes edits and retractions, and never re-adds blocked peers',async t=>{
 const f=await fixture(t,{limits:{attempts:1},rules:[{to:'bob',mode:'reset'}]});
 await f.submit({record:true,id:1});await f.submit({record:true,id:2,type:'retract',target:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',body:null});
 await f.drain();assert.equal((await f.get(1)).failed,1);assert.equal((await f.get(2)).failed,1);
 assert.equal((await f.run('outbox.catch-up',{input:{principal:P.bob.principal}})).requeued,2);
 f.clock.advance(60000);f.network.rules.length=0;await f.drain();assert.equal((await f.get(1)).delivered,1);assert.equal((await f.get(2)).delivered,1);
 await f.submit({record:true,id:3});f.network.rules.push({to:'bob',mode:'reset'});await f.drain();f.blocked.add(`${P.bob.principal.issuer}\n${P.bob.principal.subject}`);
 assert.equal((await f.run('outbox.catch-up',{input:{principal:P.bob.principal}})).requeued,0);assert.equal((await f.get(3)).cancelled,1);
});

test('BB-B3 durable SQLite crash/reopen recovers a committed claim with the exact operation',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'bb-b3-'));t.after(()=>rm(folder,{recursive:true,force:true}));const path=join(folder,'mailbox.sqlite');
 let db=new SqliteMetadata(path);await db.put('owner',P.alice.principal.subject);let crash=true;
 const crashing={get:key=>db.get(key),transaction:work=>db.transaction(async tx=>{const result=await work(tx);if(crash&&[...(await tx.list({prefix:'bb:send:task/'})).values()].some(task=>task.state==='delivered'))throw new Error('simulated process death before local ACK commit');return result;})};
 const f=await fixture(t,{store:crashing});await f.submit();await assert.rejects(f.drain(),/simulated process death/);
 assert.equal(f.received.size,1);assert.equal((await f.get(1)).recipients[0].state,'in_progress');crash=false;
 await f.h.dispose();db.close();db=new SqliteMetadata(path);await f.restart(db);t.after(()=>db.close());
 await f.drain();assert.equal(f.requests.length,1);f.clock.advance(15001);await f.drain();
 const view=await f.get(1);assert.equal(view.delivered,1);assert.equal(view.recipients[0].attempts,2);assert.equal(f.received.size,1);
});

test('BB-B3 one authorization repair; repeated 403 becomes terminal without opening host breaker',async t=>{
 let repairs=0;const f=await fixture(t,{rules:[{to:'bob',mode:'status',status:403}],repair:async()=>{repairs++;return {};}});await f.submit();await f.due();await f.drain();
 assert.equal(repairs,1);assert.equal((await f.get(1)).failed,1);assert.equal(f.requests.length,2);
 assert.equal([...(await f.store.list({prefix:'bb:send:breaker/'})).values()][0].failures,0);
});


test('expired catch-up material has a durable cleanup alarm and is purged at the retry horizon',async t=>{
 const {nextWake}=await import('../../apps/bindlebox/worker/storage.mjs'),f=await fixture(t);await f.submit({record:true});
 f.clock.advance(73*3600000);const expired=await f.drain(),key='bb:send:task/'+uuidOf(1)+':0',task=await f.store.get(key);assert.equal(task.state,'expired');assert.ok(task.credential);
 const horizon=task.createdAt+167*3600000;assert.equal(expired.nextAlarmAt,horizon);assert.equal(await nextWake(f.store,f.clock.now()),horizon);
 f.clock.set(horizon);await f.drain();assert.equal((await f.store.get(key)).credential,null);assert.equal(await nextWake(f.store,f.clock.now()),null);assert.equal((await f.get(1)).failed,1);
});
