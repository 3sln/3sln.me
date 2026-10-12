import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMetadata, SerialGate } from '../apps/node/resources.mjs';
import { AccountController } from '../packages/runtime/accounts.mjs';
import { key } from '../packages/messaging/store.mjs';
import { enqueueSearchEvent } from '../packages/search/index.mjs';

const owner = '12345678-1234-4234-8234-123456789abc';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const create = async () => {
  const metadata = new SqliteMetadata(':memory:'), bytes = new TextEncoder().encode('Violet project private text');
  const blobs = { get: async () => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) }), delete: async () => {} };
  const controller = new AccountController({ metadata, sql: metadata.sql, gate: new SerialGate(), blobs, archives: { get: async () => null }, config: { APP_ORIGIN: 'https://app.example', LOCAL_DEVELOPMENT: 'true', BILLING_ENABLED: 'false' } });
  const message = { id, owner, collection: 'inbox', mimeType: 'text/plain', receivedAt: Date.now(), readAt: null, size: bytes.length, tags: ['work'], classification: 'work', quarantined: false, blobRef: 'body', revision: 1 };
  await metadata.put(key('message', owner, id), message); controller.itemIndex.upsert(message);
  await metadata.put('owner', owner); await metadata.put('lastOwnerActiveAt', Date.now());
  return { metadata, controller, message };
};

test('runtime search never treats a stale item catalog as source authority after source deletion', async () => {
  const { metadata, controller } = await create();
  try {
    await controller.search.ingest({ owner, id: `message:${id}`, revision: 1, operation: 'upsert' });
    assert.equal((await controller.search.search(owner, { text: 'Violet' })).items.length, 1);
    await metadata.delete(key('message', owner, id));
    assert.ok(controller.itemIndex.get(id)); // Deliberately stale derived projection.
    assert.deepEqual((await controller.search.search(owner, { text: 'Violet' })).items, []);
    // A new service/controller must still refuse the old indexed content.
    const restarted = new AccountController({ metadata, sql: metadata.sql, gate: new SerialGate(), blobs: { get: async () => null }, archives: { get: async () => null }, config: { APP_ORIGIN: 'https://app.example', LOCAL_DEVELOPMENT: 'true', BILLING_ENABLED: 'false' } });
    assert.deepEqual((await restarted.search.search(owner, { text: 'Violet' })).items, []);
  } finally { metadata.close(); }
});

test('shelved authority does not convert queued upserts into deletion tombstones', async () => {
  const { metadata, controller } = await create();
  try {
    await metadata.transaction(tx => enqueueSearchEvent(tx, { owner, id: `message:${id}`, source: { kind: 'message', id }, revision: 1 }));
    await metadata.delete(key('message', owner, id)); await metadata.put('shelved', true);
    await controller.alarm();
    const pending = await controller.searchOutbox.peek(owner, 10);
    assert.equal(pending.length, 1); assert.equal(pending[0].operation, 'upsert');
    assert.equal(metadata.db.prepare('SELECT count(*) AS count FROM search_revisions').get().count, 0);
  } finally { metadata.close(); }
});

test('existing source messages are queued during bounded migration and become searchable', async () => {
  const { metadata, controller } = await create();
  try {
    await controller.warm(owner);
    const pending = await controller.searchOutbox.peek(owner, 10);
    assert.equal(pending.length, 1);
    await controller.searchDrain(owner, { limit: 10 });
    const result = await controller.omniSearch(owner, { text: 'Violet' });
    assert.equal(result.items.length, 1); assert.equal(result.indexing.pending, 0);
  } finally { metadata.close(); }
});

test('a full search backfill queue does not block authoritative inbox catalog migration', async () => {
  const { metadata, controller } = await create();
  try {
    // Exhausted durable capacity is independent of owner read permission.
    await metadata.put(key('search-queue-usage', owner), { count: 5000 });
    await controller.warm(owner);
    assert.equal(await metadata.get('item-index-ready'), true);
    assert.equal(controller.itemIndex.page(owner, { limit: 1 }).items.length, 1);
    assert.equal((await metadata.get(key('search-queue-usage', owner))).count, 5000);
  } finally { metadata.close(); }
});

test('large legacy catalogs and search backfill advance on bounded alarms without owner retries', async () => {
  const { metadata, controller, message } = await create();
  try {
    await metadata.transaction(async tx => {
      for(let index=0;index<450;index++){
        const messageId=`bbbbbbbb-bbbb-4bbb-8bbb-${index.toString(16).padStart(12,'0')}`;
        await tx.put(key('message',owner,messageId),{...message,id:messageId});
      }
    });
    await controller.warm(owner);
    assert.notEqual(await metadata.get('item-index-ready'),true);
    assert.notEqual(await metadata.get('search-backfill-ready'),true);
    assert.ok((await metadata.get(key('search-queue-usage',owner))).count<=200);
    await controller.alarm(); await controller.alarm();
    assert.equal(await metadata.get('item-index-ready'),true);
    assert.equal(await metadata.get('search-backfill-ready'),true);
    assert.equal(metadata.db.prepare('SELECT count(*) AS count FROM inbox_catalog WHERE owner=?').get(owner).count,451);
    assert.equal((await controller.messagePage(owner,{limit:100})).items.length,100);
    assert.ok((await metadata.get(key('search-queue-usage',owner))).count<=900);
    assert.equal(metadata.db.prepare('SELECT count(*) AS count FROM search_documents WHERE owner=?').get(owner).count,20);
    assert.ok(!await metadata.get('shelved'));
  } finally { metadata.close(); }
});

test('legacy backfill reserves plan queue capacity for new source mutations', async () => {
  const { metadata, controller } = await create();
  try {
    await metadata.put(key('search-queue-usage',owner),{count:899});
    await controller.warm(owner);
    assert.equal((await metadata.get(key('search-queue-usage',owner))).count,900);
    await controller.warm(owner);
    assert.equal((await metadata.get('search-backfill-blocked')).reason,'queue_capacity');
    assert.equal(await metadata.get('item-index-ready'),true);
    assert.ok((await metadata.getAlarm())<Date.now()+120000);
  } finally { metadata.close(); }
});
