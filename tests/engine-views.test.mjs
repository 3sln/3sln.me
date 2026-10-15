// Engine-level View creation: MessageViews over the durable Node metadata
// adapter, driven as independent concurrent operations. A retry that reuses the
// client operation ID after a lost reply must return the original View, never a
// duplicate (UI chaos finding).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SqliteMetadata } from '../apps/node/resources.mjs';
import { MessageViews } from '../packages/runtime/message-views.mjs';
import { domainEngine, tally } from './helpers/engine.mjs';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const definition = (name = 'Work', extra = {}) => ({ name, filter: { version: 1, tagsAll: ['work'] }, sort: 'activity-desc', ...extra });
function fixture(t) {
  const metadata = new SqliteMetadata(':memory:'), e = domainEngine({ views: new MessageViews(metadata) });
  t.after(async () => { await e.dispose(); metadata.close(); });
  const create = (input, owner = OWNER) => ({ views }) => views.mutate(owner, 'create', null, input);
  const custom = async (owner = OWNER) => (await e.run(({ views }) => views.list(owner))).filter(view => !view.builtin);
  return { e, create, custom };
}

test('a retry after a lost reply returns the original View instead of a duplicate', async t => {
  const { e, create, custom } = fixture(t), operationId = randomUUID();
  const first = await e.run(create(definition('Work', { operationId })));
  // The reply is lost; the client resends the identical request with the same ID.
  const retry = await e.run(create(definition('Work', { operationId })));
  assert.deepEqual(retry, first);
  assert.deepEqual((await custom()).map(view => view.id), [first.id]);
  // The operation ID is scoped to its owner.
  const foreign = await e.run(create(definition('Work', { operationId }), OTHER));
  assert.notEqual(foreign.id, first.id);
  assert.equal((await custom(OTHER)).length, 1);
});

test('concurrent duplicate submissions with one operation ID create exactly one View', async t => {
  const { e, create, custom } = fixture(t), operationId = randomUUID();
  const results = await e.all(Array.from({ length: 8 }, () => create(definition('Burst', { operationId }))));
  assert.deepEqual(tally(results), { fulfilled: 8 });
  assert.equal(new Set(results.map(r => r.value.id)).size, 1);
  assert.equal((await custom()).length, 1);
});

test('an operation ID cannot be replayed for a different definition, and distinct IDs stay distinct', async t => {
  const { e, create, custom } = fixture(t), operationId = randomUUID();
  const view = await e.run(create(definition('Work', { operationId })));
  await assert.rejects(e.run(create(definition('Other', { operationId }))), { code: 'view_operation_conflict', status: 409 });
  // Normalization is part of the fingerprint: an equivalent filter is the same request.
  const equivalent = await e.run(create({ name: 'Work', filter: { version: 1, tagsAll: ['work'], types: [] }, sort: 'activity-desc', operationId }));
  assert.equal(equivalent.id, view.id);
  const second = await e.run(create(definition('Work', { operationId: randomUUID() })));
  const legacy = await e.run(create(definition('Work')));
  assert.equal(new Set([view.id, second.id, legacy.id]).size, 3);
  assert.equal((await custom()).length, 3);
  for (const bad of ['', 'not-a-uuid', operationId.toUpperCase(), '00000000-0000-1000-8000-000000000000', 7])
    await assert.rejects(e.run(create(definition('Bad', { operationId: bad }))), { code: 'invalid_view' });
  await assert.rejects(e.run(({ views }) => views.mutate(OWNER, 'update', view.id, { ...definition('Renamed'), expectedRevision: 1, operationId })), { code: 'invalid_view' });
  assert.equal((await custom()).length, 3);
});

test('a retry at the View limit returns the original, and receipts stay bounded', async t => {
  const { e, create, custom } = fixture(t), ids = [];
  for (let i = 0; i < 61; i++) { const operationId = randomUUID(); ids.push(operationId); await e.run(create(definition('View ' + i, { operationId }))); }
  const original = (await custom()).at(-1);
  assert.deepEqual(await e.run(create(definition('View 60', { operationId: ids.at(-1) }))), original);
  await assert.rejects(e.run(create(definition('Extra', { operationId: randomUUID() }))), { code: 'view_limit' });
  assert.equal((await custom()).length, 61);
  // Deleting and recreating churns receipts; only the most recent 64 are kept.
  for (const view of await custom()) await e.run(({ views }) => views.mutate(OWNER, 'delete', view.id, { expectedRevision: 1 }));
  for (let i = 0; i < 10; i++) { const view = await e.run(create(definition('Churn ' + i, { operationId: randomUUID() }))); await e.run(({ views }) => views.mutate(OWNER, 'delete', view.id, { expectedRevision: 1 })); }
  const receipts = await e.run(({ views }) => views.metadata.get('message-view-operations/v1/' + OWNER));
  assert.equal(receipts.length, 64);
  assert.equal(receipts.some(r => r.operationId === ids[0]), false);
});
