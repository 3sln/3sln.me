// Engine-level Views: the production Views Actions and Queries dispatched through
// the application engine (tests/helpers/app-engine.mjs) over the durable Node
// metadata adapter. A retry that reuses the client operation ID after a lost reply
// must return the original View, never a duplicate (UI chaos finding).
// Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestEngine, OWNER, OTHER, ownerActor } from './helpers/app-engine.mjs';
import { tally } from './helpers/chaos.mjs';
import { ViewsProvider, SavedViews, CreateView, UpdateView, DeleteView, IncomingPage, UpdateIncoming } from '../packages/app/domains/views.mjs';

const definition = (name = 'Work', extra = {}) => ({ name, filter: { version: 1, tagsAll: ['work'] }, sort: 'activity-desc', ...extra });
async function fixture(t, options) {
  const e = await createTestEngine(options);
  t.after(() => e.dispose());
  const create = (input, owner = OWNER) => new CreateView({ actor: ownerActor(owner), input });
  const custom = async (owner = OWNER) => (await e.read(new SavedViews({ actor: ownerActor(owner) }))).views.filter(view => !view.builtin);
  return { e, create, custom };
}

test('a retry after a lost reply returns the original View instead of a duplicate', async t => {
  const { e, create, custom } = await fixture(t), operationId = randomUUID();
  const first = await e.perform(create(definition('Work', { operationId })));
  // The reply is lost; the client resends the identical request with the same ID.
  const retry = await e.perform(create(definition('Work', { operationId })));
  assert.deepEqual(retry, first);
  assert.deepEqual((await custom()).map(view => view.id), [first.id]);
  // The operation ID is scoped to its owner.
  const foreign = await e.perform(create(definition('Work', { operationId }), OTHER));
  assert.notEqual(foreign.id, first.id);
  assert.equal((await custom(OTHER)).length, 1);
});

test('a commit whose acknowledgement is lost is recovered by the same operation ID (injected fault)', async t => {
  // The first transaction commits and then reports failure: the caller sees an error for work that happened.
  const { e, create, custom } = await fixture(t, { faults: { accountStore: [{ method: 'transaction', when: 1, mode: 'after' }] } }), operationId = randomUUID();
  await assert.rejects(e.perform(create(definition('Work', { operationId }))), { code: 'injected_fault' });
  const [committed] = await custom();
  assert.ok(committed, 'the write committed although its reply was lost');
  assert.deepEqual(await e.perform(create(definition('Work', { operationId }))), committed);
  assert.equal((await custom()).length, 1);
  assert.deepEqual(e.audit.entries.filter(entry => entry.operation === 'views.create').map(entry => entry.outcome), ['error', 'ok']);
});

test('concurrent duplicate submissions with one operation ID create exactly one View', async t => {
  const { e, create, custom } = await fixture(t), operationId = randomUUID();
  const results = await e.all(Array.from({ length: 8 }, () => create(definition('Burst', { operationId }))));
  assert.deepEqual(tally(results), { fulfilled: 8 });
  assert.equal(new Set(results.map(r => r.value.id)).size, 1);
  assert.equal((await custom()).length, 1);
});

test('an operation ID cannot be replayed for a different definition, and distinct IDs stay distinct', async t => {
  const { e, create, custom } = await fixture(t), operationId = randomUUID();
  const view = await e.perform(create(definition('Work', { operationId })));
  await assert.rejects(e.perform(create(definition('Other', { operationId }))), { code: 'view_operation_conflict', status: 409 });
  // Normalization is part of the fingerprint: an equivalent filter is the same request.
  const equivalent = await e.perform(create({ name: 'Work', filter: { version: 1, tagsAll: ['work'], types: [] }, sort: 'activity-desc', operationId }));
  assert.equal(equivalent.id, view.id);
  const second = await e.perform(create(definition('Work', { operationId: randomUUID() })));
  const legacy = await e.perform(create(definition('Work')));
  assert.equal(new Set([view.id, second.id, legacy.id]).size, 3);
  assert.equal((await custom()).length, 3);
  for (const bad of ['', 'not-a-uuid', operationId.toUpperCase(), '00000000-0000-1000-8000-000000000000', 7])
    await assert.rejects(e.perform(create(definition('Bad', { operationId: bad }))), { code: 'invalid_view' });
  await assert.rejects(e.perform(new UpdateView({ actor: ownerActor(), id: view.id, input: { ...definition('Renamed'), expectedRevision: 1, operationId } })), { code: 'invalid_view' });
  assert.equal((await custom()).length, 3);
});

test('a retry at the View limit returns the original, and receipts stay bounded', async t => {
  const { e, create, custom } = await fixture(t), ids = [];
  for (let i = 0; i < 61; i++) { const operationId = randomUUID(); ids.push(operationId); await e.perform(create(definition('View ' + i, { operationId }))); }
  const original = (await custom()).at(-1);
  assert.deepEqual(await e.perform(create(definition('View 60', { operationId: ids.at(-1) }))), original);
  await assert.rejects(e.perform(create(definition('Extra', { operationId: randomUUID() }))), { code: 'view_limit' });
  assert.equal((await custom()).length, 61);
  // Deleting and recreating churns receipts; only the most recent 64 are kept.
  const remove = view => e.perform(new DeleteView({ actor: ownerActor(), id: view.id, input: { expectedRevision: 1 } }));
  for (const view of await custom()) await remove(view);
  for (let i = 0; i < 10; i++) await remove(await e.perform(create(definition('Churn ' + i, { operationId: randomUUID() }))));
  const receipts = await e.metadata.get('message-view-operations/v1/' + OWNER);
  assert.equal(receipts.length, 64);
  assert.equal(receipts.some(r => r.operationId === ids[0]), false);
});

test('View IDs come from the seeded random provider, so a seed replays the same IDs', async t => {
  const ids = async seed => { const { e, create } = await fixture(t, { seed }); return [(await e.perform(create(definition('A')))).id, (await e.perform(create(definition('B')))).id]; };
  const [a, b] = [await ids(41), await ids(41)];
  assert.deepEqual(a, b);
  assert.notDeepEqual(await ids(42), a);
  for (const id of a) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('only an owner actor obtains the Views handle; refusal happens in the lease, before any work', async t => {
  const { e, custom } = await fixture(t);
  for (const actor of [undefined, null, { kind: 'app', owner: OWNER }, { kind: 'owner' }, { kind: 'owner', owner: '../' + OWNER }]) {
    await assert.rejects(e.perform(new CreateView({ actor, input: definition() })), { code: 'unauthorized', status: 401 });
    await assert.rejects(e.read(new SavedViews({ actor })), { code: 'unauthorized' });
  }
  assert.equal((await custom()).length, 0);
  assert.equal(e.events.length, 0, 'a refused operation announces nothing');
  // The payload is exactly {actor, id, input}: a caller cannot smuggle dependency options in.
  const smuggled = new CreateView({ actor: ownerActor(), input: definition(), deps: { views: { actor: ownerActor(OTHER) } } });
  await e.perform(smuggled);
  assert.equal((await custom()).length, 1); assert.equal((await custom(OTHER)).length, 0);
});

test('mutations announce one fact each on the engine feed, and a live Views query refetches on them', async t => {
  // Count the live query's reads by owner through a provider override (the production handle, observed).
  const reads = [];
  class CountingViews extends ViewsProvider { scope(resources, owner) { const handle = super.scope(resources, owner); return { ...handle, list: () => { reads.push(owner); return handle.list(); } }; } }
  const { e, create } = await fixture(t, { providers: { views: CountingViews } }), seen = [];
  const subscription = e.engine.query(new SavedViews({ actor: ownerActor() })).subscribe(value => seen.push(value.views.length));
  t.after(() => subscription.unsubscribe());
  await new Promise(resolve => setTimeout(resolve, 5));
  const view = await e.perform(create(definition()));
  await e.perform(new UpdateView({ actor: ownerActor(), id: view.id, input: { ...definition('Renamed'), expectedRevision: 1 } }));
  await e.perform(create(definition('Other owner'), OTHER));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(e.events.map(event => [event.type, event.operation, event.owner]), [['views-changed', 'views.create', OWNER], ['views-changed', 'views.update', OWNER], ['views-changed', 'views.create', OTHER]]);
  // Built-ins (3), then the create; the update keeps the count; the other owner's fact is ignored.
  assert.equal(seen[0], 3); assert.equal(seen.at(-1), 4);
  // One boot read plus one refetch per fact for this owner; the other owner's fact causes none.
  assert.deepEqual(reads.filter(owner => owner === OWNER).length, 3); assert.equal(reads.includes(OTHER), false);
});

test('incoming pages resolve saved Views through the co-transactional item index, and organization commits once', async t => {
  const { e, create } = await fixture(t);
  const message = i => ({ id: `m${i}`, owner: OWNER, receivedAt: 1000 + i, readAt: null, collection: 'inbox', tags: i % 2 ? ['work'] : [], classification: 'unclassified', mimeType: 'text/plain', size: 4 });
  for (let i = 0; i < 6; i++) e.itemIndex.upsert(message(i));
  const view = await e.perform(create(definition()));
  const page = await e.read(new IncomingPage({ actor: ownerActor(), input: { view: view.id, viewRevision: 1, limit: 2 } }));
  assert.equal(page.items.length, 2); assert.ok(page.cursor);
  const rest = await e.read(new IncomingPage({ actor: ownerActor(), input: { view: view.id, viewRevision: 1, limit: 2, cursor: page.cursor } }));
  assert.deepEqual([...page.items, ...rest.items].map(item => item.id).sort(), ['m1', 'm3', 'm5']);
  await assert.rejects(e.read(new IncomingPage({ actor: ownerActor(), input: { view: view.id, viewRevision: 2 } })), { code: 'view_conflict' });
  await assert.rejects(e.read(new IncomingPage({ actor: ownerActor(OTHER), input: { view: view.id, viewRevision: 1 } })), { code: 'view_not_found' });
  // Conversation organization is validated before readiness and conflicts on a stale revision.
  await assert.rejects(e.perform(new UpdateIncoming({ actor: ownerActor(), input: { id: 'm1', expectedRevision: 1, tags: ['x'] } })), { code: 'invalid_view' });
  await assert.rejects(e.perform(new UpdateIncoming({ actor: ownerActor(), input: { id: 'conversation:missing', expectedRevision: 1, tags: ['x'] } })), { code: 'not_found' });
  // Two owners' tabs organize one conversation from the same revision: exactly one commits.
  e.itemIndex.upsert({ ...message(9), conversation: { id: 'c1', source: { origin: 'https://3sln.example', owner: OTHER } } });
  const [card] = (await e.read(new IncomingPage({ actor: ownerActor(), input: { filter: { version: 1, types: ['conversation'] } } }))).items;
  const organize = tags => new UpdateIncoming({ actor: ownerActor(), input: { id: card.id, expectedRevision: card.organizationRevision, tags } });
  const results = await e.all([organize(['first']), organize(['second'])]);
  assert.deepEqual(tally(results, () => 'saved'), { saved: 1, item_conflict: 1 });
  const [after] = (await e.read(new IncomingPage({ actor: ownerActor(), input: { filter: { version: 1, types: ['conversation'] } } }))).items;
  assert.deepEqual(after.tags, results.find(r => r.status === 'fulfilled').value.tags);
  assert.equal(e.events.filter(event => event.type === 'incoming-changed').length, 1);
});

test('an index that is still upgrading answers temporarily_unavailable before resolving the View', async t => {
  const { e } = await fixture(t, { incomingReady: false });
  await assert.rejects(e.read(new IncomingPage({ actor: ownerActor(), input: { view: 'missing', viewRevision: 1 } })), { code: 'temporarily_unavailable', status: 503 });
  await assert.rejects(e.perform(new UpdateIncoming({ actor: ownerActor(), input: { id: 'conversation:x', expectedRevision: 1, tags: [] } })), { code: 'temporarily_unavailable' });
});
