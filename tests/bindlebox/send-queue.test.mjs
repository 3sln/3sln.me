import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,P,B,uuidOf} from './outbox-fixture.mjs';

test('BB-B3 submission is atomic/idempotent, owner-scoped and explicitly default-off',async t=>{
 const f=await fixture(t),{input,result}=await f.submit({people:['bob','carol']});
 assert.equal(result.recipientCount,2);assert.equal(result.pending,2);
 assert.deepEqual(await f.run('send.submit',{input}),result);
 const conflict=structuredClone(input);conflict.recipients.reverse();await assert.rejects(f.run('send.submit',{input:conflict}),{code:'send_operation_conflict'});
 await assert.rejects(f.h.run('outbox.list',{actor:{kind:'owner',owner:P.bob.principal.subject}}),{code:'forbidden'});
 assert.equal(f.requests.length,0);assert.equal(f.h.audit.entries.some(e=>JSON.stringify(e).includes('Queue body')),false);
 assert.equal((await f.run('outbox.list')).length,1);
 const off=await fixture(t,{enabled:false});await assert.rejects(off.submit(),{code:'not_found'});await assert.rejects(off.run('outbox.list'),{code:'not_found'});await assert.rejects(off.run('send.events'),{code:'not_found'});
});

test('BB-B3 partial delivery, terminal refusal and cancellation keep the frozen denominator',async t=>{
 const f=await fixture(t,{rules:[{to:'carol',mode:'status',status:413}]});await f.submit({people:['bob','carol']});await f.drain();
 let view=await f.get(1);assert.equal(view.delivered,1);assert.equal(view.failed,1);assert.equal(view.recipientCount,2);
 assert.equal((await f.run('outbox.retry-missing',{id:uuidOf(1)})).requeued,0);await f.drain();assert.equal(f.requests.length,2);
 await f.submit({id:2,people:['bob','carol']});f.blocked.add(`${P.carol.principal.issuer}\n${P.carol.principal.subject}`);await f.drain();
 view=await f.get(2);assert.deepEqual([view.delivered,view.cancelled,view.recipientCount],[1,1,2]);
 await f.submit({id:3});await f.run('outbox.cancel',{id:uuidOf(3)});view=await f.get(3);assert.equal(view.cancelled,1);assert.equal((await f.run('outbox.retry-missing',{id:uuidOf(3)})).requeued,0);
});

test('BB-B3 rejects overload before promising work and bounds a 1000-recipient submission',async t=>{
 const f=await fixture(t),first=await f.submit(),base=first.input.recipients[0];
 const recipients=Array.from({length:1000},(_,i)=>{const r=structuredClone(base);r.envelope.payload.operationId=uuidOf(20);r.envelope.payload.recipient.owner=uuidOf(10000+i);return r;});
 // Queue checks the prepared envelope shape; signing allocation is the trusted compose domain's job.
 const full=await fixture(t);const result=await full.run('send.submit',{input:{...first.input,operationId:uuidOf(20),recipients}});
 assert.equal(result.recipientCount,1000);assert.equal(result.pending,1000);
 await assert.rejects(full.submit({id:21}),{code:'send_capacity'});
 await assert.rejects(full.run('send.submit',{input:{...first.input,operationId:uuidOf(20),recipients:[...recipients,base]}}),{code:'malformed'});
 assert.equal((await full.get(20)).recipientCount,1000);assert.equal(full.requests.length,0);
 const small=await fixture(t,{limits:{bytes:1024}});await assert.rejects(small.submit(),{code:'send_capacity'});assert.deepEqual(await small.run('outbox.list'),[]);
});

test('BB-B3 validates bytes, recipient uniqueness, credentials and live authority before append',async t=>{
 const f=await fixture(t),{input}=await f.submit();
 for(const edit of [v=>v.body[0]^=1,v=>v.recipients.push(v.recipients[0]),v=>v.recipients[0].credential='Bearer unsafe',v=>v.recipients[0].ingress='http://untrusted.example/ingress']){
  const bad=structuredClone(input);edit(bad);await assert.rejects(f.run('send.submit',{input:bad}));
 }
 const denied=await fixture(t,{authorize:()=>false});await assert.rejects(denied.submit(),{code:'not_authorized'});assert.deepEqual(await denied.run('outbox.list'),[]);
});

test('BB-B3 owner reads never disclose envelope, credential, body or custody proof',async t=>{
 const f=await fixture(t);await f.submit();await f.drain();const text=JSON.stringify(await f.get(1));
 for(const secret of ['BindleLink','Queue body','delegation','signature','payloadDigest'])assert.equal(text.includes(secret),false);
 assert.equal((await f.get(1)).delivered,1);assert.deepEqual(f.requests.map(r=>[r.redirect,r.credentials]),[['manual','omit']]);
 assert.equal(B.aggregate(['delivered']).delivered,1);
});
