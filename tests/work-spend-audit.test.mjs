import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMetadata } from '../apps/node/resources.mjs';
import { AccountWorkBudget, workPartitionLimit } from '../packages/runtime/work-budget.mjs';
import { FederationController } from '../packages/federation/runtime.mjs';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const stranger = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = Date.UTC(2026, 9, 12);

test('independent work audit: foreign-owner denial neither spends a lease nor contacts the service allocator', async () => {
  const metadata = new SqliteMetadata(':memory:'); let calls = 0;
  try {
    await metadata.put('owner', owner);
    await metadata.put('work/month', { version: 1, month: '2026-10', used: 9, remaining: 7 });
    const prior = await metadata.get('work/month');
    const budget = new AccountWorkBudget({ metadata, authority: { consume: async () => { calls++; return true; } }, clock: () => now });
    await assert.rejects(budget.admit(stranger, { initialize: true }), { code: 'forbidden' });
    assert.deepEqual(await metadata.get('work/month'), prior);
    assert.equal(calls, 0);
  } finally { metadata.close(); }
});

test('independent work audit: two consumers cannot spend the same last prepaid unit', async () => {
  const metadata = new SqliteMetadata(':memory:'); let calls = 0;
  try {
    await metadata.put('owner', owner);
    await metadata.put('work/month', { version: 1, month: '2026-10', used: 0, remaining: 1 });
    const options = { metadata, authority: { consume: async () => { calls++; return false; } }, clock: () => now };
    const consumers = [new AccountWorkBudget(options), new AccountWorkBudget(options)];
    const results = await Promise.allSettled(consumers.map(consumer => consumer.admit(owner)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await metadata.get('work/month')).remaining, 0);
    assert.equal((await metadata.get('work/month')).used, 2);
    assert.equal(calls, 2); // Rejected batch followed by rejected one-unit fallback.
  } finally { metadata.close(); }
});

test('independent work audit: uneven service partitions conserve the configured admission total', () => {
  for (const total of [0, 1, 15, 16, 17, 250000, 250003]) {
    const slices = Array.from({ length: 16 }, (_, partition) => workPartitionLimit(total, partition));
    assert.equal(slices.reduce((sum, value) => sum + value, 0), total);
    assert.ok(Math.max(...slices) - Math.min(...slices) <= 1);
  }
});

test('independent work audit: Node clears the fired alarm before a handler schedules more work', async () => {
  const metadata = new SqliteMetadata(':memory:'); let finish;
  const observed = new Promise(resolve => { finish = resolve; });
  let timeout;
  try {
    metadata.onAlarm = async () => finish(await metadata.getAlarm());
    await metadata.setAlarm(Date.now() + 1);
    const alarm = await Promise.race([observed, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('alarm did not run')), 10000); })]); // hang guard only, not a timing assertion
    assert.ok(alarm === undefined || alarm === null, 'A consumed alarm must not suppress the next scheduled cleanup.');
  } finally { clearTimeout(timeout); metadata.close(); }
});

test('independent work audit: federation reads do not create durable outcome journals or blob copies', async () => {
  const rows = new Map(); let calls = 0;
  const transaction = { get: async key => rows.get(key), set: async (key, value) => rows.set(key, value) };
  const controller = new FederationController({
    metadata: { transaction: async action => action(transaction) }, auth: { owner: async () => ({}) },
    issuer: 'https://provider.example', dispatcher: { durableJournal: true, execute: async () => { calls++; return { data: 'x'.repeat(70000) }; } }
  });
  for (const method of ['get', 'list', 'read', 'describe', 'capabilities', 'presign']) {
    await controller.dispatch({ subject: `https://provider.example/entities/${owner}`, clientId: 'https://client.example', resource: 'https://provider.example/resource/test', contract: 'https://schema.example/storage/v1', method, args: {}, tx: crypto.randomUUID(), transaction }, crypto);
  }
  assert.equal(calls, 6);
  assert.equal(rows.size, 0);
});

import { StorageQuota } from '../packages/runtime/storage-quota.mjs';
import { AccountController } from '../packages/runtime/accounts.mjs';
import { key } from '../packages/messaging/store.mjs';

test('independent work audit: abandoned upload cleanup backs off and pauses after eight failed deletes without releasing ownership', async () => {
  const metadata = new SqliteMetadata(':memory:'); let time = now, deletes = 0;
  try {
    const id = crypto.randomUUID();
    await metadata.put(`storage/reservation/${id}`, { id, owner, bytes: 4, growthBytes: 4, expiresAt: time - 1, blobRef: `messages/${owner}/${id}` });
    await metadata.put('storage/reservations', { growthBytes: 4, uploadBytes: 4, count: 1 });
    const quota = new StorageQuota({ metadata, clock: () => time, blobs: { delete: async () => { deletes++; throw new Error('provider unavailable'); } } });
    for (let attempt = 1; attempt <= 8; attempt++) {
      await quota.cleanup();
      const retry = await metadata.get('storage/cleanup-retry');
      assert.equal(retry.failures, attempt);
      if (!retry.paused) {
        assert.equal(retry.retryAt - time, Math.min(3600000, 60000 * 2 ** (attempt - 1)));
        await quota.cleanup(); assert.equal(deletes, attempt); // Too early: no remote call.
        time = retry.retryAt;
      }
    }
    time += 365 * 86400000;
    await quota.cleanup(); assert.equal(deletes, 8);
    assert.equal((await metadata.get('storage/cleanup-retry')).paused, true);
    assert.equal(await quota.nextCleanup(), Infinity);
    assert.ok(await metadata.get(`storage/reservation/${id}`));
    assert.equal((await metadata.get('storage/reservations')).count, 1);
  } finally { metadata.close(); }
});

for (const subsystem of ['garbage', 'extraction', 'purge']) test(`independent work audit: ${subsystem} retries stop after eight failures with durable work retained`, async () => {
  const metadata = new SqliteMetadata(':memory:'); let calls = 0;
  try {
    const failure = async () => { calls++; throw Object.assign(new Error('provider unavailable'), { code: 'provider_unavailable' }); };
    let retryKey, context, run, retained;
    if (subsystem === 'garbage') {
      retryKey = 'storage/garbage-retry'; retained = 'blob-garbage/test'; await metadata.put(retained, 'owned-blob');
      context = { metadata, blobs: { delete: failure } }; run = () => AccountController.prototype.collectBlobGarbage.call(context);
    } else if (subsystem === 'extraction') {
      retryKey = 'search/extraction-retry'; retained = key('search-queue-usage', owner); await metadata.put(retained, { count: 1 });
      context = { metadata, search: { drain: failure }, searchIndex: {}, configureSemanticSearch: async () => {}, billing: { entitlement: async () => ({ plan: 'free' }) } };
      run = () => AccountController.prototype.searchDrain.call(context, owner);
    } else {
      retryKey = 'search/purge-retry'; retained = 'search-vector-purge'; await metadata.put(retained, { owner });
      await metadata.put(key('search-vector-revision', owner, 'message:test'), { active: true, revision: 1 });
      context = { metadata, search: { vectorIndex: { tombstone: failure } } };
      run = () => AccountController.prototype.purgeSearchVectors.call(context, owner);
    }
    for (let attempt = 1; attempt <= 8; attempt++) {
      await run().catch(() => {});
      const retry = await metadata.get(retryKey); assert.equal(retry.failures, attempt);
      await run().catch(() => {}); assert.equal(calls, attempt);
      if (!retry.paused) await metadata.put(retryKey, { ...retry, retryAt: 0 });
    }
    await run(); assert.equal(calls, 8); assert.ok(await metadata.get(retained));
  } finally { metadata.close(); }
});

test('independent work audit: paused housekeeping does not force minute alarms and activity writes coalesce for fifteen minutes', async () => {
  const metadata = new SqliteMetadata(':memory:'); let schedules = 0;
  try {
    await metadata.put('owner', owner); await metadata.put('item-index-ready', true); await metadata.put('search-backfill-ready', true);
    await metadata.put(key('search-queue-usage', owner), { count: 1 }); await metadata.put('blob-garbage/test', 'retained'); await metadata.put('search-vector-purge', { owner });
    for (const retryKey of ['search/extraction-retry', 'storage/garbage-retry', 'search/purge-retry']) await metadata.put(retryKey, { failures: 8, paused: true, retryAt: null });
    const context = { metadata, quota: { nextCleanup: async () => Infinity }, warm: async () => {}, scheduleAlarm: async () => { schedules++; } };
    const later = Date.now() + 7 * 86400000;
    await AccountController.prototype.scheduleAlarm.call(context, later); assert.equal(await metadata.getAlarm(), later);
    const activity = Date.now() - 5 * 60000; await metadata.put('lastOwnerActiveAt', activity);
    await AccountController.prototype.touch.call(context, owner); assert.equal(await metadata.get('lastOwnerActiveAt'), activity); assert.equal(schedules, 0);
    await metadata.put('lastOwnerActiveAt', Date.now() - 16 * 60000);
    await AccountController.prototype.touch.call(context, owner); assert.equal(schedules, 1);
  } finally { metadata.close(); }
});
