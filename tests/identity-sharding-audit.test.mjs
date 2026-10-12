import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMetadata } from '../apps/node/resources.mjs';
import { IdentityShardStorage, ShardedIdentityRepository, IDENTITY_LAYOUT } from '../packages/runtime/identity-shards.mjs';

test('independent identity audit: a later committed CAS cannot turn a committed registration result into false', async () => {
  const shards = new Map(); let release, settled; const pendingResponse = new Promise(resolve => { release = resolve; }), firstCommit = new Promise(resolve => { settled = resolve; }); let intercepted = false;
  const shard = name => {
    if (!shards.has(name)) { const metadata = new SqliteMetadata(':memory:'); shards.set(name, { metadata, controller: new IdentityShardStorage(metadata) }); }
    const { controller } = shards.get(name);
    return new Proxy({}, { get: (_, method) => method === 'then' ? undefined : async (...args) => {
      const result = await controller[method.slice(5, 6).toLowerCase() + method.slice(6)](...args);
      if (method === 'shardSettle' && !intercepted) { intercepted = true; settled(); await pendingResponse; }
      return result;
    } });
  };
  const repository = new ShardedIdentityRepository({ shard, layout: IDENTITY_LAYOUT }), value = { id: 'audit-owner', handle: 'audit-handle', revision: 0, verifiedEmail: null, status: 'active' };
  try {
    const registration = repository.create(value); await firstCommit;
    assert.deepEqual(await repository.get(value.id), value);
    assert.equal(await repository.compareAndSwap(value.id, 0, { ...value, revision: 1, status: 'updated' }), true);
    release(); assert.equal(await registration, true);
    assert.equal((await repository.get(value.id)).revision, 1);
    assert.equal((await repository.findByHandle(value.handle)).id, value.id);
  } finally { release(); for (const { metadata } of shards.values()) metadata.close(); }
});
