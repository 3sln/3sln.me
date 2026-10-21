import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {fixture,P,B,NOW,uuidOf} from './outbox-fixture.mjs';
import {receiptFor} from './vectors/fixtures.mjs';
import {memoryStore} from './helpers/engine.mjs';
async function until(predicate){for(let n=0;n<1000&&!predicate();n++)await tick();assert.ok(predicate(),'network attempt started');}

test('BB-B3 slow hosts cannot hold transactions; concurrent drains respect four requests and two per host',async t=>{
 const f=await fixture(t,{rules:[{mode:'delay',ms:1000}]});
 for(let id=1;id<=3;id++)await f.submit({id,people:['bob','carol']});
 const first=f.drain();await until(()=>f.requests.length===4);assert.equal((await f.run('outbox.list')).length,3);
 assert.deepEqual(await f.drain(),{attempted:0,pending:6,nextAlarmAt:NOW+15000});
 assert.equal(f.network.trace.filter(e=>e.to==='bob').length,2);assert.equal(f.network.trace.filter(e=>e.to==='carol').length,2);
 await f.network.advance(1000);await first;
 assert.equal((await f.run('outbox.list')).reduce((n,m)=>n+m.delivered,0),4);await f.network.advance(1000);
 const last=f.drain();await until(()=>f.requests.length===6);await f.network.advance(1000);await last;
 assert.equal((await f.run('outbox.list')).reduce((n,m)=>n+m.delivered,0),6);
});

test('BB-B3 cancellation during an attempt fences failure; late verified custody is delivered-before-cancel',async t=>{
 const f=await fixture(t,{rules:[{to:'bob',mode:'delay',ms:1000}]});await f.submit();
 const drain=f.drain();await until(()=>f.requests.length===1);await f.run('outbox.cancel',{id:uuidOf(1)});
 await f.network.advance(1000);await drain;const view=await f.get(1);
 assert.equal(view.cancelled,1);assert.equal(view.delivered,0);assert.equal(view.recipients[0].deliveredBeforeCancel,true);
 f.clock.advance(60000);await f.drain();assert.equal(f.requests.length,1);
});

test('BB-B3 timeouts bound slow connections and trickled response bodies while healthy recipients progress',async t=>{
 for(const mode of ['delay','trickle']){
  const waiting=new Map(),timers={set(fn,ms){const id={};waiting.set(id,{fn,ms});return id;},clear:id=>waiting.delete(id)};
  const f=await fixture(t,{timers,rules:[{to:'bob',mode,ms:10000,body:'{"receipt":{}}'}]});await f.submit({people:['bob','carol']});
  const work=f.drain();await until(()=>f.requests.length===2);
  for(let n=0;n<1000&&(await f.get(1)).delivered!==1;n++)await tick();assert.equal((await f.get(1)).delivered,1);
  for(const timer of [...waiting.values()].sort((a,b)=>a.ms-b.ms))timer.fn();
  await work;const view=await f.get(1);assert.deepEqual([view.delivered,view.pending],[1,1]);assert.equal(view.recipients[0].state,'unknown');
  assert.ok(view.recipients[0].nextAttemptAt>=NOW+5000);
 }
});

test('BB-B3 oversized, unsigned and mismatched ACKs stay pending; no success response alone proves custody',async t=>{
 for(const response of [()=>new Response('x'.repeat(65537)),()=>Response.json({state:'delivered'}),async request=>{
  const parsed=await B.parseDelivery(request.headers['Content-Type'],request.body);return Response.json({receipt:await receiptFor(P.carol,parsed.envelope,{ingress:P.bob.ingress})});
 }]){
  const f=await fixture(t);f.network.mount('bob',response);await f.submit();await f.drain();assert.equal((await f.get(1)).delivered,0);assert.equal((await f.get(1)).pending,1);
 }
});

test('BB-B3 host recovery automatically requeues in-window expired obligations without refilling manual budgets',async t=>{
 const f=await fixture(t,{limits:{attempts:1},rules:[{to:'bob',mode:'reset'}]});
 for(let id=1;id<=5;id++){await f.submit({id,record:true});await f.drain();}
 let breaker=[...(await f.store.list({prefix:'bb:send:breaker/'})).values()][0];assert.ok(breaker.until>NOW);
 f.clock.set(breaker.until);f.network.rules.length=0;await f.submit({id:6,record:true});await f.drain();
 const list=await f.run('outbox.list');assert.equal(list[5].delivered,1);assert.ok(list.slice(0,5).every(m=>m.pending===1));
 for(let n=0;n<3;n++)await f.drain();assert.ok((await f.run('outbox.list')).every(m=>m.delivered===1));
 assert.equal((await f.run('outbox.catch-up',{input:{principal:P.bob.principal}})).requeued,0);
});

test('BB-B3 automatic lifetime expires visibly and replayed submission remains idempotent after its window',async t=>{
 const f=await fixture(t);const {input}=await f.submit();f.clock.advance(24*3600000);await f.drain();
 assert.equal((await f.get(1)).failed,1);assert.equal((await f.run('outbox.retry-missing',{id:uuidOf(1)})).requeued,0);
 assert.equal((await f.run('send.submit',{input})).recipientCount,1);assert.equal(f.requests.length,0);
});

test('BB-B3 transport and directory/status verification run outside the mailbox transaction',async t=>{
 const base=memoryStore([['owner',P.alice.principal.subject]]);let inside=false;
 const store={get:key=>base.get(key),transaction:work=>base.transaction(async tx=>{inside=true;try{return await work(tx);}finally{inside=false;}})};
 const f=await fixture(t,{store});const resolve=f.w.resolveKey,status=f.w.status;
 f.w.resolveKey=(...args)=>{assert.equal(inside,false);return resolve(...args);};f.w.status=(...args)=>{assert.equal(inside,false);return status(...args);};
 f.network.mount('bob',async request=>{assert.equal(inside,false);const parsed=await B.parseDelivery(request.headers['Content-Type'],request.body);return Response.json({receipt:await receiptFor(P.bob,parsed.envelope)});});
 await f.submit();await f.drain();assert.equal((await f.get(1)).delivered,1);
});

test('BB-B3 429 interrupts consecutive host failures and never opens the breaker',async t=>{
 const f=await fixture(t,{rules:[{to:'bob',when:[1,2,3,4,6],mode:'reset'},{to:'bob',when:5,mode:'rate-limit',retryAfter:1}]});await f.submit({record:true});
 for(let n=0;n<6;n++)await f.due();const breaker=[...(await f.store.list({prefix:'bb:send:breaker/'})).values()][0];assert.equal(breaker.failures,1);assert.equal(breaker.until,0);
});

test('BB-B3 re-resolved link endpoints acquire a new host slot before forwarding credentials',async t=>{
 const f=await fixture(t,{rules:[{to:'bob',when:1,mode:'status',status:404}],repair:async()=>({ingress:'https://recovered.box.example/ingress'})});await f.submit();await f.due();await f.drain();
 assert.equal(f.requests.length,1);const view=await f.get(1);assert.equal(view.recipients[0].state,'retry_scheduled');assert.equal(view.recipients[0].reason,'moved');
 f.clock.set(view.recipients[0].nextAttemptAt);await f.drain();assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,'https://recovered.box.example/ingress');
 // The old certificate is bound to the old ingress: even this 200 cannot falsely resolve custody.
 assert.equal((await f.get(1)).delivered,0);
});
