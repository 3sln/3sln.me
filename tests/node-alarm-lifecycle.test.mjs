import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('closing metadata fences a running alarm rejection without reading or restarting the closed database',async()=>{
 const metadata=new SqliteMetadata(':memory:'),entered=deferred(),release=deferred();let calls=0;
 metadata.onAlarm=async()=>{calls++;entered.resolve();await release.promise;throw new Error('pending alarm failed');};
 await metadata.setAlarm(Date.now());await entered.promise;metadata.close();
 metadata.getAlarm=()=>{assert.fail('closed alarm must not read');};metadata.setAlarm=()=>{assert.fail('closed alarm must not restart');};
 release.resolve();await turn();await turn();metadata.arm(Date.now());assert.equal(metadata.timer,null);assert.equal(calls,1);metadata.close();
});
test('an alarm failure while open retains the normal retry schedule',async()=>{
 const metadata=new SqliteMetadata(':memory:'),retried=deferred();
 try{metadata.onAlarm=async()=>{throw new Error('retryable failure');};const original=metadata.setAlarm.bind(metadata);metadata.setAlarm=async time=>{await original(time);retried.resolve(time);};
  await original(Date.now());const time=await retried.promise;assert.ok(time>=Date.now()+59000);assert.equal(await metadata.getAlarm(),time);assert.ok(metadata.timer);
 }finally{metadata.close();}
});
