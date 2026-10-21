import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {IdentityRepository} from '../packages/runtime/accounts.mjs';
import {IdentityShardStorage,ShardedIdentityRepository,IDENTITY_LAYOUT,sweepDeviceExpiry} from '../packages/runtime/identity-shards.mjs';

const record=(now,extra={})=>({id:crypto.randomUUID(),revision:0,userCodeHash:crypto.randomUUID(),kind:'session',status:'pending',pendingUntil:now+1000,expiresAt:now+1000,requester:{network:{country:'MX'}},...extra});
for(const sharded of [false,true])test(`${sharded?'Worker shards':'Node SQLite'}: cleanup deletes expired records and code lookups, retaining cancellation fences until E`,async()=>{
 const stores=new Map(),db=name=>{if(!stores.has(name))stores.set(name,new SqliteMetadata(':memory:'));return stores.get(name);},shard=name=>{const storage=new IdentityShardStorage(db(name));return new Proxy({},{get:(_,method)=>method==='then'?undefined:(...args)=>storage[method.slice(5,6).toLowerCase()+method.slice(6)](...args)});},now=Date.now()+60000;
 const repository=sharded?new ShardedIdentityRepository({shard,layout:IDENTITY_LAYOUT,clock:()=>now}):new IdentityRepository({metadata:db('node')});
 try{
  const pending=record(now),consumed=record(now),app=record(now,{kind:'app',status:'consumed'});for(const r of [pending,consumed,app])assert.equal(await repository.createDevice(r),true);
  assert.equal(await repository.compareAndSwapDevice(consumed.id,0,{...consumed,status:'consumed',revision:1,expiresAt:now+10000,issuedSessionHash:'cancel-fence'}),true);
  const sweep=async at=>{const results=[];for(const metadata of stores.values())results.push(await sweepDeviceExpiry(metadata,{now:at}));return results;};
  await sweep(now+999);assert.ok(await repository.getDevice(pending.id));assert.ok(await repository.findDeviceByCode(pending.userCodeHash));
  await sweep(now+1000);assert.equal((await repository.getDevice(pending.id))??null,null);assert.equal((await repository.getDevice(app.id))??null,null);assert.equal(await repository.findDeviceByCode(pending.userCodeHash),null);assert.equal((await repository.getDevice(consumed.id)).issuedSessionHash,'cancel-fence');
  const replacement=record(now+1000,{userCodeHash:consumed.userCodeHash});assert.equal(await repository.createDevice(replacement),true);await sweep(now+1001);assert.equal((await repository.findDeviceByCode(replacement.userCodeHash)).id,replacement.id);
  await sweep(now+10000);assert.equal((await repository.getDevice(consumed.id))??null,null);for(const metadata of stores.values()){assert.equal((await metadata.list({prefix:'identity-device-expiry/'})).size,0);const all=JSON.stringify([...await metadata.list()]);assert.doesNotMatch(all,/cancel-fence|country/);}
 }finally{for(const metadata of stores.values())metadata.close();}
});

test('cleanup bounds each transaction and schedules continuation without disturbing an earlier alarm',async()=>{
 const metadata=new SqliteMetadata(':memory:'),repository=new IdentityRepository({metadata}),now=Date.now()+60000;
 try{
  for(let i=0;i<70;i++)assert.equal(await repository.createDevice(record(now)),true);
  await metadata.delete('@alarm');const first=await sweepDeviceExpiry(metadata,{now:now+1000,limit:64});assert.equal(first.deleted,64);assert.equal(first.next,now+2000);assert.equal(await metadata.getAlarm(),now+2000);
  await metadata.setAlarm(now+1500);await sweepDeviceExpiry(metadata,{now:now+1000,limit:64});assert.equal(await metadata.getAlarm(),now+1500);await sweepDeviceExpiry(metadata,{now:now+1000,limit:64});assert.equal((await metadata.list({prefix:'device/'})).size,0);assert.equal((await metadata.list({prefix:'device-code/'})).size,0);
 }finally{metadata.close();}
});
