import test from 'node:test';
import assert from 'node:assert/strict';
import {ShardedIdentityRepository,IdentityShardStorage,identityShardName,IDENTITY_LAYOUT} from '../packages/runtime/identity-shards.mjs';

class Metadata {
  rows=new Map();queue=Promise.resolve();
  async get(key){return structuredClone(this.rows.get(key));}
  async put(key,value){this.rows.set(key,structuredClone(value));}
  async delete(key){this.rows.delete(key);}
  async list({prefix='',startAfter='',limit=100}={}){return new Map([...this.rows].filter(([key])=>key.startsWith(prefix)&&key>startAfter).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));}
  async transaction(operation){const result=this.queue.then(async()=>{const old=structuredClone(this.rows);try{return await operation(this);}catch(error){this.rows=old;throw error;}});this.queue=result.catch(()=>{});return result;}
}
function fixture(){
  const shards=new Map(),calls=[];let failure,now=1000;
  const shard=name=>{
    if(!shards.has(name))shards.set(name,new IdentityShardStorage(new Metadata()));
    const controller=shards.get(name);
    return new Proxy({}, {get:(_,method)=>method==='then'?undefined:async(...args)=>{
      calls.push({name,method,args});const fault=failure?.method===method&&(!failure.match||failure.match(args));
      if(fault&&!failure.after){failure=null;throw new Error('injected interruption');}
      const result=await controller[method.slice(5,6).toLowerCase()+method.slice(6)](...args);
      if(fault){failure=null;throw new Error('injected interruption');}return result;
    }});
  };
  const repo=()=>new ShardedIdentityRepository({shard,layout:IDENTITY_LAYOUT,clock:()=>now});
  return {repository:repo(),repo,shards,calls,fail:value=>{failure=value;},advance:value=>{now=value;}};
}
const account=(id,handle=id)=>({id,handle,revision:0,status:'active',verifiedEmail:null});

test('versioned routing has independent 64 bucket families and rejects implicit migration',async()=>{
  assert.throws(()=>new ShardedIdentityRepository({shard:()=>{}}),/legacy identity data/);
  assert.equal(await identityShardName('account','alice'),await identityShardName('account','alice'));
  assert.notEqual(await identityShardName('account','alice'),await identityShardName('email','alice'));
  const names=await Promise.all(Array.from({length:1000},(_,i)=>identityShardName('account',`owner-${i}`)));
  assert.equal(new Set(names).size,64);
});

test('concurrent handle registration has one winner and session reads/CAS stay on account bucket',async()=>{
  const f=fixture(),r=f.repository;
  const results=await Promise.all(Array.from({length:20},(_,i)=>r.create(account(`owner-${i}`,'shared'))));
  assert.equal(results.filter(Boolean).length,1);
  const winner=await r.findByHandle('shared');assert(winner);
  f.calls.length=0;assert.deepEqual(await r.get(winner.id),winner);
  assert(await r.compareAndSwap(winner.id,0,{...winner,revision:1,status:'updated'}));
  assert(f.calls.every(call=>call.name===f.calls[0].name&&call.name.startsWith('identity-v1/account/')));
  assert.equal(await r.compareAndSwap(winner.id,0,{...winner,revision:1}),false);
});

test('concurrent email claims preserve unique authoritative ownership and release on change',async()=>{
  const {repository:r}=fixture();const a=account('a'),b=account('b');await r.create(a);await r.create(b);
  const results=await Promise.all([a,b].map(value=>r.compareAndSwap(value.id,0,{...value,revision:1,verifiedEmail:'shared@example.example'})));
  assert.equal(results.filter(Boolean).length,1);
  const owner=await r.findByEmail('shared@example.example');assert(owner);
  const loser=owner.id==='a'?b:a;assert.equal((await r.get(loser.id)).verifiedEmail,null);
  assert(await r.compareAndSwap(owner.id,1,{...owner,revision:2,verifiedEmail:'next@example.example'}));
  assert.equal(await r.findByEmail('shared@example.example'),null);
  assert(await r.compareAndSwap(loser.id,0,{...loser,revision:1,verifiedEmail:'shared@example.example'}));
  assert.equal((await r.findByEmail('shared@example.example')).id,loser.id);
});

for(const method of ['shardPrepare','shardClaim','shardSettle','shardFinish'])test(`registration recovers durable operation after ${method} response loss`,async()=>{
  const f=fixture(),value=account(`interrupted-${method}`);
  f.fail({method,after:true});await assert.rejects(f.repository.create(value),/injected/);
  const resumed=f.repo();assert.deepEqual(await resumed.get(value.id),value);
  assert.deepEqual(await resumed.findByHandle(value.handle),value);
  assert.equal(await resumed.create(account('impostor',value.handle)),false);
});

test('lookup resumes registration whose claim was saved before interruption',async()=>{
  const f=fixture(),value=account('lookup-recovery');f.fail({method:'shardClaim',after:true});
  await assert.rejects(f.repository.create(value));assert.deepEqual(await f.repo().findByHandle(value.handle),value);
});

test('bounded lifecycle pages recover operation interrupted before lookup claim',async()=>{
  const f=fixture(),value=account('maintenance-recovery');f.fail({method:'shardClaim'});
  await assert.rejects(f.repository.create(value));const r=f.repo();let cursor,found=false,pages=0;
  do{const page=await r.lifecycleCandidates({cursor,limit:10});found ||= page.accounts.some(a=>a.id===value.id);cursor=page.cursor;pages++;}while(cursor);
  assert(found);assert.equal(pages,64);assert.equal((await r.findByHandle(value.handle)).id,value.id);
});

test('interrupted email cleanup cannot publish an old email or delete a replacement owner claim',async()=>{
  const f=fixture(),r=f.repository;let a=account('a'),b=account('b');await r.create(a);await r.create(b);
  a={...a,revision:1,verifiedEmail:'first@example.example'};await r.compareAndSwap('a',0,a);
  f.fail({method:'shardRelease'});
  await assert.rejects(r.compareAndSwap('a',1,{...a,revision:2,verifiedEmail:'second@example.example'}));
  const resumed=f.repo();assert.equal(await resumed.findByEmail('first@example.example'),null);
  assert.equal((await resumed.findByEmail('second@example.example')).id,'a');
  assert(await resumed.compareAndSwap('b',0,{...b,revision:1,verifiedEmail:'first@example.example'}));
  const stale={kind:'email',value:'first@example.example',owner:'a',token:'wrong'};
  assert.equal(await resumed.release(stale),false);
  assert.equal((await resumed.findByEmail('first@example.example')).id,'b');
});

test('device code uniqueness, direct request CAS, expiry reuse, and immutable expiry',async()=>{
  const f=fixture(),r=f.repository,a={id:'device-a',userCode:'ABCDEFGH',revision:0,expiresAt:2000},b={...a,id:'device-b'};
  assert(await r.createDevice(a));assert.equal(await r.createDevice(b),false);
  assert.equal((await r.findDeviceByCode(a.userCode)).id,a.id);
  assert.equal(await r.compareAndSwapDevice(a.id,0,{...a,revision:1,expiresAt:9000}),false);
  f.advance(2001);assert.equal(await r.findDeviceByCode(a.userCode),null);
  assert(await r.createDevice({...b,expiresAt:4000}));
  assert(await r.compareAndSwapDevice(a.id,0,{...a,revision:1,status:'cancelled'}));
  assert.equal((await r.findDeviceByCode(a.userCode)).id,b.id);
});

test('an email conflict aborts a new account and frees its partially reserved handle',async()=>{
  const f=fixture(),r=f.repository,owner={...account('owner'),verifiedEmail:'taken@example.example'};
  assert(await r.create(owner));
  assert.equal(await r.create({...account('loser','free-handle'),verifiedEmail:owner.verifiedEmail}),false);
  assert.equal(await r.get('loser'),null);assert.equal(await r.findByHandle('free-handle'),null);
  assert(await r.create(account('replacement','free-handle')));
  assert.equal((await r.findByEmail(owner.verifiedEmail)).id,owner.id);
});

test('concurrent recovery of one pending email operation commits once and preserves later CAS',async()=>{
  const f=fixture(),r=f.repository,a=account('parallel');assert(await r.create(a));
  f.fail({method:'shardClaim',after:true});await assert.rejects(r.compareAndSwap(a.id,0,{...a,revision:1,verifiedEmail:'parallel@example.example'}));
  const values=await Promise.all(Array.from({length:20},()=>f.repo().get(a.id)));
  assert(values.every(value=>value.revision===1&&value.verifiedEmail==='parallel@example.example'));
  const results=await Promise.all(Array.from({length:20},(_,i)=>f.repo().compareAndSwap(a.id,1,{...values[0],revision:2,status:`update-${i}`})));
  assert.equal(results.filter(Boolean).length,1);assert.equal((await r.get(a.id)).revision,2);
  assert.equal((await r.findByEmail('parallel@example.example')).id,a.id);
});
