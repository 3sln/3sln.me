import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
import {identityShardName} from '../../packages/runtime/identity-shards.mjs';

test('actual Worker alarms physically delete expired linked requests and code claims, retaining a consumed session through E',async t=>{
 const h=await createHarness();t.after(()=>h.close());const namespace=await h.mf.getDurableObjectNamespace('IDENTITIES'),now=Date.now(),id=crypto.randomUUID(),code=crypto.randomUUID(),record={id,revision:0,userCodeHash:code,kind:'session',status:'pending',pendingUntil:now+1000,expiresAt:now+1000,requester:{network:{country:'MX'}}};
 assert.equal(await h.directory.createDevice(record),true);assert.equal(await h.directory.compareAndSwapDevice(id,0,{...record,revision:1,status:'consumed',expiresAt:now+60000,issuedSessionHash:'cancellation-fence'}),true);
 const primary=namespace.get(namespace.idFromName(await identityShardName('device',id))),lookup=namespace.get(namespace.idFromName(await identityShardName('device-code',code)));
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,now+1001-Date.now())));await primary.fireAlarm();await lookup.fireAlarm();assert.equal((await h.directory.getDevice(id)).issuedSessionHash,'cancellation-fence');assert.equal(new Map(await lookup.rows()).has('identity-lookup/device-code/'+code),false);assert.ok(await primary.alarmAt());
 assert.equal(await h.directory.compareAndSwapDevice(id,1,{...record,revision:2,status:'consumed',expiresAt:now-1}),true);await primary.fireAlarm();assert.equal(await h.directory.getDevice(id),null);assert.equal(new Map(await primary.rows()).has('identity-record/device/'+id),false);
});
