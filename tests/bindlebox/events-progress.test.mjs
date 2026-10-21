import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,uuidOf} from './outbox-fixture.mjs';
import {recordProgress,EVENT_LIMITS} from '../../packages/bindlebox-engine/domains/events.mjs';

test('BB-B3 progress coalesces updates and resumes after an engine restart',async t=>{
 const f=await fixture(t);await f.submit();const first=await f.run('send.events');assert.equal(first.events.length,1);
 await f.drain();const hidden=await f.run('send.events',{input:{after:first.resumeToken}});assert.equal(hidden.events.length,0);
 await f.restart();f.clock.advance(250);const next=await f.run('send.events',{input:{after:first.resumeToken}});
 assert.equal(next.events.length,1);assert.equal(next.events[0].data.delivered,1);assert.notEqual(next.resumeToken,first.resumeToken);
 const stream=await f.run('send.events-stream',{input:{after:first.resumeToken}});assert.equal(stream.headers.get('Content-Type'),'text/event-stream');const text=await stream.text();assert.match(text,/event: message/);assert.match(text,/"delivered":1/);
 assert.equal((await f.run('send.events',{input:{after:next.resumeToken}})).events.length,0);assert.equal(next.maxAgeMs,300000);
});

test('BB-B3 stale, foreign, malformed and future resume tokens request reset and snapshots',async t=>{
 const f=await fixture(t);await f.submit();const first=await f.run('send.events');
 for(const after of ['bad',first.resumeToken.replace(/\/\d+$/,'/900000'),first.resumeToken.replace(/^[^/]+/,'other-owner')]){
  const page=await f.run('send.events',{input:{after}});assert.equal(page.reset,true);assert.equal(page.events[0].type,'reset');assert.deepEqual(page.events[0].data.refetch,['outbox']);
 }
 f.clock.advance(EVENT_LIMITS.age+1);const expired=await f.run('send.events',{input:{after:first.resumeToken.replace(/\/\d+$/,'/0')}});assert.equal(expired.reset,true);
 assert.equal((await f.get(1)).recipientCount,1);
});

test('BB-B3 journal retains at most 1000 durable monotonic events and reports gaps',async t=>{
 const f=await fixture(t);await f.submit();const first=await f.run('send.events');
 await f.store.transaction(async tx=>{for(let i=0;i<1005;i++){f.clock.advance(251);await recordProgress(tx,{owner:f.h.actor().owner,clock:f.clock,random:f.h.random},{messageId:uuidOf(i+100),revision:1,recipientCount:1,pending:1,delivered:0,failed:0,cancelled:0});}});
 const page=await f.run('send.events');assert.equal(page.events.length,1000);assert.equal((await f.run('send.events',{input:{after:first.resumeToken}})).reset,true);
 const numbers=page.events.map(e=>Number(e.id.split('/')[2]));assert.ok(numbers.every((n,i)=>!i||n===numbers[i-1]+1));
 const source=await f.run('send.events-stream',{input:{after:page.resumeToken}});assert.equal(await source.text(),'');
});
