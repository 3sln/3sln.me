import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkReplayRecord } from '../packages/messaging/link-replay.mjs';
import { SqliteMetadata } from '../apps/node/resources.mjs';

const ISS='https://3sln.example',hash=i=>String(i).padStart(43,'A');
function fixture(options={}) {
  let now=1800000000000;const metadata=new SqliteMetadata(':memory:');
  const replay=new LinkReplayRecord({metadata,clock:()=>now,...options});
  const consume=(i,{sub='55555555-5555-4555-8555-555555555555',parent='parent',ttl=420000}={})=>replay.consume({parent,iss:ISS,sub,key:hash(i),expiresAt:now+ttl});
  const rows=async prefix=>(await metadata.list({prefix})).size;
  return {metadata,replay,consume,rows,advance:ms=>{now+=ms;},now:()=>now};
}
const user=i=>`55555555-5555-4555-8555-${String(i).padStart(12,'0')}`;

test('§7.2 single use: a duplicate H is audience_stale; other parents are separate namespaces',async()=>{
  const f=fixture();assert.deepEqual(await f.consume(1),{consumed:true,expiresAt:f.now()+420000});
  await assert.rejects(f.consume(1),{code:'audience_stale'});assert.equal((await f.consume(1,{parent:'other'})).consumed,true);f.metadata.close();
});
test('§7.2 rows never outlive insertion + 420 s and expired responses are refused before any write',async()=>{
  const f=fixture();await assert.rejects(f.consume(1,{ttl:420001}),{code:'audience_stale'});await assert.rejects(f.consume(1,{ttl:0}),{code:'audience_stale'});
  assert.equal(await f.rows('link-replay/'),0);
  for(const input of [{parent:'',iss:ISS,sub:'s',key:hash(1),expiresAt:f.now()+1},{parent:'é'.repeat(60),iss:ISS,sub:'s',key:hash(1),expiresAt:f.now()+1},{parent:'p',iss:ISS,sub:'s',key:'short',expiresAt:f.now()+1},{parent:'p',iss:ISS,sub:'s',key:hash(1),expiresAt:1.5}])await assert.rejects(f.replay.consume(input),{code:'invalid_replay_record'});
  f.metadata.close();
});
test('§7.2 per-principal live-row cap refuses only that principal; expiry frees it',async()=>{
  const f=fixture();for(let i=0;i<3;i++)await f.consume(i);
  await assert.rejects(f.consume(9),{code:'audience_unavailable'});assert.equal((await f.consume(10,{sub:user(2)})).consumed,true);
  f.advance(420000);assert.equal((await f.consume(11)).consumed,true);f.metadata.close();
});
test('§7.2 per-parent cap refuses rather than evicting unexpired rows; lazy purge resumes after expiry',async()=>{
  const f=fixture({parentCap:4200,evaluationRate:10,purgeBatch:2});
  await f.metadata.put('link-replay/parent/count',4199);await f.consume(1,{sub:user(1)});
  await assert.rejects(f.consume(2,{sub:user(2)}),{code:'audience_unavailable'});await assert.rejects(f.consume(1,{sub:user(1)}),{code:'audience_stale'},'existing row was not evicted');
  f.advance(420000);assert.equal((await f.consume(3,{sub:user(3)})).consumed,true);
  assert.equal(await f.metadata.get('link-replay/parent/count'),4200);assert.equal(await f.rows('link-replay/parent/h/'),1);f.metadata.close();
});
test('§7.2 purge commits even when admission is refused and removes all three row kinds',async()=>{
  const f=fixture({principalCap:1,parentCap:4200,purgeBatch:64});await f.consume(1);await f.consume(2,{sub:user(2)});
  f.advance(420000);await f.consume(3,{sub:user(3)});await assert.rejects(f.consume(3,{sub:user(3)}),{code:'audience_stale'});
  assert.equal(await f.rows('link-replay/parent/h/'),1);assert.equal(await f.rows('link-replay/parent/p/'),1);assert.equal(await f.rows('link-replay/parent/e/'),1);assert.equal(await f.metadata.get('link-replay/parent/count'),1);
  f.advance(420000);assert.equal(await f.replay.purge('parent'),1);assert.equal(await f.rows('link-replay/parent/'),1);f.metadata.close();
});
test('limits are validated: the parent cap covers the global evaluation rate × 420 s',()=>{
  const metadata=new SqliteMetadata(':memory:');
  for(const options of [{parentCap:4199,evaluationRate:10},{principalCap:0},{principalCap:1.5},{purgeBatch:0},{metadata:{}}])assert.throws(()=>new LinkReplayRecord({metadata,...options}),{code:'invalid_replay_limits'});
  assert.ok(new LinkReplayRecord({metadata,parentCap:420,evaluationRate:1}));metadata.close();
});
