import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {normalizeHandle,validatePaidHandle,encodeFreeHandleNumber,isFreeHandle} from '../packages/identity/handles.mjs';
import {IdentityRepository} from '../packages/runtime/accounts.mjs';
import {IdentityShardStorage,ShardedIdentityRepository,IDENTITY_LAYOUT,identityShardName} from '../packages/runtime/identity-shards.mjs';
function fixture(){
 const shards=new Map();
 const shard=name=>{if(!shards.has(name))shards.set(name,new IdentityShardStorage(new SqliteMetadata(':memory:')));const storage=shards.get(name);return new Proxy({},{get:(_,method)=>method==='then'?undefined:(...args)=>storage[method.slice(5,6).toLowerCase()+method.slice(6)](...args)});};
 return {shards,repo:new ShardedIdentityRepository({shard,layout:IDENTITY_LAYOUT}),close:()=>{for(const value of shards.values())value.metadata.close();}};
}
const account=(id,handle,assignmentId=crypto.randomUUID())=>({id,handle,assignmentId,revision:0,status:'active',verifiedEmail:null});
test('allocated names burn immediately, consume once, and remain unavailable after account deletion',async()=>{
 const f=fixture();try{
  const id=crypto.randomUUID(),assignmentId=crypto.randomUUID(),handle=await f.repo.allocateFreeHandle('alice',id,assignmentId);
  assert.match(handle,/^n\.[0-9abcdefghjkmnpqrstvwxyz]+$/);
  assert.equal(await f.repo.create(account(crypto.randomUUID(),handle)),false);
  assert.equal(await f.repo.create(account(id,handle,assignmentId)),true);
  const entered=handle.toUpperCase().replaceAll('0','O').replaceAll('1','L');
  assert.equal((await f.repo.findByHandle(entered)).handle,handle);
  const bucket=f.shards.get(await identityShardName('account',id));await bucket.metadata.delete(`identity-record/account/${id}`);
  assert.equal(await f.repo.findByHandle(handle),null);
  assert.equal(await f.repo.create(account(crypto.randomUUID(),handle)),false);
  assert.equal(await f.repo.create(account(id,handle,assignmentId)),false);
 }finally{f.close();}
});
test('global 64-lane names are unique without any basename or per-user allocator',async()=>{
 const f=fixture();try{
  const names=await Promise.all(Array.from({length:120},(_,i)=>f.repo.allocateFreeHandle(i%2?'alice':'bob',crypto.randomUUID(),crypto.randomUUID())));
  assert.equal(new Set(names.map(name=>name.split('.')[1])).size,names.length);
  for(const [name,storage]of f.shards)if(name.includes('/allocator/')){
    const rows=await storage.metadata.list({prefix:''});assert(rows.has('identity-global-handle-sequence'));assert([...rows.keys()].every(key=>key==='identity-global-handle-sequence'||key.startsWith('identity-global-handle-number/')));
  }
  assert.match(await f.repo.allocateFreeHandle(undefined,crypto.randomUUID()),/^n\./);
  assert.match(await f.repo.allocateFreeHandle('ignored.invalid.base',crypto.randomUUID()),/^n\./);
 }finally{f.close();}
});
test('counter corruption/exhaustion fails closed and resets cannot reissue permanent claims',async()=>{
 const metadata=new SqliteMetadata(':memory:'),storage=new IdentityShardStorage(metadata);try{
  assert.equal(await storage.nextHandleNumber(0),'64');
  assert(await storage.handleClaim('n.20',{owner:'owner',assignmentId:'assignment'}));
  await metadata.put('identity-global-handle-sequence','0');
  await assert.rejects(storage.nextHandleNumber(0),/counter reuse/);
  assert.equal(await storage.handleClaim('n.20',{owner:'other',assignmentId:'other-assignment'}),false);
  await metadata.put('identity-global-handle-sequence','156249999999');
  await assert.rejects(storage.nextHandleNumber(0),/exhausted/);
  await metadata.put('identity-global-handle-sequence',null);
  await assert.rejects(storage.nextHandleNumber(1),/Invalid/);
 }finally{metadata.close();}
});
test('orphan legacy lookup is grandfathered before cleanup and cannot be recycled',async()=>{
 const f=fixture();try{
  const handle='legacy-owner',id=crypto.randomUUID(),token=crypto.randomUUID();
  const name=await identityShardName('handle',handle);
  // Seed an old lookup with no new permanent claim and no surviving account.
  await f.repo.bucket('handle',handle);await f.shards.get(name).metadata.put(`identity-lookup/handle/${handle}`,{owner:id,token});
  assert.equal(await f.repo.findByHandle(handle),null);
  assert.equal(await f.repo.create(account(crypto.randomUUID(),handle)),false);
 }finally{f.close();}
});
test('paid aliases stay attached to their identity assignment and cannot claim free handles',async()=>{
 const f=fixture();try{
  const id=crypto.randomUUID(),assignmentId=crypto.randomUUID(),handle=await f.repo.allocateFreeHandle('alice',id,assignmentId);
  assert(await f.repo.create(account(id,handle,assignmentId)));
  const taken=crypto.randomUUID();assert(await f.repo.create(account(taken,'taken-alias')));
  assert.equal(await f.repo.claimPaidHandle('taken-alias',id,assignmentId),false);
  assert(await f.repo.claimPaidHandle('alice-123',id,assignmentId));
  assert.equal((await f.repo.findByHandle('alice-123')).handle,handle);
  assert.equal(await f.repo.claimPaidHandle('another-alias',id,assignmentId),false);
  await assert.rejects(f.repo.claimPaidHandle('n.123',id,assignmentId));
  await assert.rejects(f.repo.claimPaidHandle('alice.123',id,assignmentId));
  assert.equal(await f.repo.claimPaidHandle('another',id,crypto.randomUUID()),false);
  const other=crypto.randomUUID();assert(await f.repo.create(account(other,'another-account')));
  assert.equal(await f.repo.claimPaidHandle('alice-123',other,crypto.randomUUID()),false);
 }finally{f.close();}
});
test('Node adapter preserves permanent claims after account and lookup deletion',async()=>{
 const metadata=new SqliteMetadata(':memory:'),repo=new IdentityRepository({metadata});try{
  const id=crypto.randomUUID(),assignmentId=crypto.randomUUID(),handle=await repo.allocateFreeHandle('alice',id,assignmentId);
  assert(await repo.create(account(id,handle,assignmentId)));
  assert(await repo.claimPaidHandle('alice',id,assignmentId));assert.equal((await repo.findByHandle('alice')).id,id);
  await metadata.delete(`account/${id}`);await metadata.delete(`handle/${handle}`);
  assert.equal(await repo.create(account(crypto.randomUUID(),handle)),false);
  assert.equal(await repo.create(account(id,handle,assignmentId)),false);
 }finally{metadata.close();}
});
test('paid owner journal resumes issuance after response loss and prevents a second alias',async()=>{
 const f=fixture();try{
  const id=crypto.randomUUID(),assignmentId=crypto.randomUUID(),handle=await f.repo.allocateFreeHandle('alice',id,assignmentId);
  assert(await f.repo.create(account(id,handle,assignmentId)));
  const anchorBucket=await f.repo.bucket('namespace',`paid-owner:${id}`);
  const anchor=await anchorBucket.shardPaidHandleAnchor(id,'first-alias',assignmentId);
  assert.equal(anchor.state,'pending');
  const namespace=await f.repo.bucket('namespace','first-alias');
  assert(await namespace.shardPaidHandleClaim('first-alias',id,assignmentId));
  // Simulate a lost response before the owner journal commits.
  assert.equal(await f.repo.claimPaidHandle('second-alias',id,assignmentId),false);
  assert.equal(await f.repo.claimPaidHandle('first-alias',id,assignmentId),true);
  assert.equal(await anchorBucket.shardPaidHandleFinish(id,{...anchor,token:crypto.randomUUID()},false),false);
  assert.equal((await f.repo.findByHandle('first-alias')).id,id);
 }finally{f.close();}
});

test('shared Crockford parser canonicalizes case and aliases, and numeric paid names remain separate',()=>{
 assert.equal(encodeFreeHandleNumber('64'),'n.20');
 assert.equal(normalizeHandle('N.2O'),'n.20');
 assert.equal(normalizeHandle('n.IL'),'n.11');
 assert.equal(normalizeHandle('n.0002O'),'n.20');
 assert.equal(normalizeHandle('123'),'123');assert.equal(validatePaidHandle('123'),'123');
 assert.equal(normalizeHandle('ALICE'),'alice');assert.equal(isFreeHandle('N.2O'),true);
 assert.throws(()=>normalizeHandle('n.u'));assert.throws(()=>normalizeHandle('n.0'));
 assert.throws(()=>normalizeHandle('other.20'));assert.throws(()=>validatePaidHandle('n.20'));
 assert.throws(()=>encodeFreeHandleNumber('10000000000000'));assert.throws(()=>normalizeHandle('n.zzzzzzzzz'));
});
test('paid lookup cannot attach an orphan alias to a reused subject with a new assignment',async()=>{
 const metadata=new SqliteMetadata(':memory:'),repo=new IdentityRepository({metadata});try{
  const id=crypto.randomUUID(),assignmentId=crypto.randomUUID(),handle=await repo.allocateFreeHandle(undefined,id,assignmentId);
  assert(await repo.create(account(id,handle,assignmentId)));assert(await repo.claimPaidHandle('123',id,assignmentId));
  await metadata.delete(`account/${id}`);
  const replacement=account(id,'fresh-canonical',crypto.randomUUID());assert(await repo.create(replacement));
  assert.equal(await repo.findByHandle('123'),null);
  assert.equal(await repo.claimPaidHandle('123',id,assignmentId),false);
 }finally{metadata.close();}
});
