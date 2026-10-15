// Engine-level search consistency: SearchService over the durable outbox and
// both index adapters, driven by seeded create/update/delete/quarantine
// sequences with partial drains and stale redeliveries. Results never expose
// deleted, quarantined or superseded content, and a drained index agrees with
// the authority. Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SearchService, MemorySearchIndex, SqliteSearchIndex, nodeSqlPort, enqueueSearchEvent, MetadataSearchOutbox, normalizeQuery } from '../packages/search/index.mjs';
import { SqliteMetadata } from '../apps/node/resources.mjs';
import { forEachSeed } from './helpers/chaos.mjs';

const BASE = Number(process.env.CHAOS_SEED ?? 1), OWNER = 'alice';
const adapters = { memory: () => new MemorySearchIndex(), sqlite: () => new SqliteSearchIndex({ sql: nodeSqlPort(new DatabaseSync(':memory:')) }) };
const word = (doc, revision) => `w${doc}r${revision}`;

async function fixture(t, index) {
  const metadata = new SqliteMetadata(':memory:'); t.after(() => metadata.close());
  const docs = new Map(), outbox = new MetadataSearchOutbox(metadata);
  const authority = { get: async (owner, id) => structuredClone(docs.get(`${owner}/${id}`)) ?? null, scan: async (owner, { limit }) => ({ items: [...docs.values()].filter(d => d.owner === owner).slice(0, limit) }) };
  const service = new SearchService({ index, authority, outbox });
  // A source mutation and its search event commit together, as the account store does.
  const mutate = (id, change) => metadata.transaction(async tx => {
    const prior = docs.get(`${OWNER}/${id}`), next = change(prior && structuredClone(prior));
    const event = await enqueueSearchEvent(tx, { owner: OWNER, id, operation: next ? 'upsert' : 'tombstone', source: { kind: 'message', id } });
    if (next) docs.set(`${OWNER}/${id}`, { ...next, revision: event.revision }); else docs.delete(`${OWNER}/${id}`);
    return event;
  });
  return { metadata, docs, outbox, service, index, mutate };
}
const visible = doc => doc && !doc.quarantined;

for (const [name, make] of Object.entries(adapters)) test(`search (${name}): seeded mutations with partial drains and stale redeliveries never leak and converge after drain`, async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  await forEachSeed(4, async random => {
    const f = await fixture(t, make()), ids = Array.from({ length: 12 }, (_, i) => `d${i}`), history = new Map(), events = [];
    for (let step = 0; step < 80; step++) {
      const id = random.pick(ids), current = f.docs.get(`${OWNER}/${id}`), roll = random.next();
      if (!current || roll < 0.35) events.push(await f.mutate(id, prior => ({ id, owner: OWNER, source: { kind: 'message', id }, type: 'message', title: 'note', text: `shared ${word(id, (prior?.revision ?? 0) + 1)}`, tags: [], createdAt: step, acl: { readers: [OWNER] }, quarantined: false })));
      else if (roll < 0.6) events.push(await f.mutate(id, () => null));
      else if (roll < 0.75) events.push(await f.mutate(id, prior => ({ ...prior, quarantined: !prior.quarantined, text: `shared ${word(id, prior.revision + 1)}` })));
      else if (roll < 0.9) await f.service.drain(OWNER, { limit: 1 + random.int(5) });
      // An old event delivered again (at-least-once queues) must never revive older content.
      else if (events.length) await f.service.ingest(random.pick(events));
      for (const [key, doc] of f.docs) history.set(key, [...new Set([...(history.get(key) ?? []), doc.text.split(' ')[1]])]);
      // Before any drain, results are filtered to live, visible, current revisions.
      const { items } = await f.service.search(OWNER, { text: 'shared', limit: 100 });
      for (const item of items) { const doc = f.docs.get(`${OWNER}/${item.id}`); assert.ok(visible(doc), `leaked ${item.id}`); assert.equal(item.revision, doc.revision); assert.equal(item.snippet, doc.text); }
    }
    while ((await f.service.drain(OWNER, { limit: 100 })).processed);
    assert.deepEqual(await f.outbox.peek(OWNER, 100), []);
    const query = text => normalizeQuery({ text, limit: 100 });
    for (const id of ids) {
      const doc = f.docs.get(`${OWNER}/${id}`), currentWord = doc?.text.split(' ')[1];
      for (const old of history.get(`${OWNER}/${id}`) ?? []) {
        // The index itself (not just the service filter) holds no stale or deleted terms after a drain.
        const raw = await f.index.candidates(OWNER, query(old), { limit: 200 });
        if (old === currentWord && visible(doc)) assert.deepEqual(raw.map(r => [r.id, r.revision]), [[id, doc.revision]], `${old} indexed`);
        else assert.deepEqual(raw, [], `${old} still indexed for ${id}`);
      }
    }
    const all = (await f.service.search(OWNER, { text: 'shared', limit: 100 })).items.map(i => i.id).sort();
    assert.deepEqual(all, [...f.docs.values()].filter(visible).map(d => d.id).sort());
  }, { base: BASE });
});

test('search outbox coalesces per item and stays within its queue bound', async t => {
  const f = await fixture(t, new MemorySearchIndex());
  for (let i = 0; i < 50; i++) await f.mutate('same', prior => ({ id: 'same', owner: OWNER, source: { kind: 'message', id: 'same' }, type: 'message', title: 't', text: `shared ${word('same', (prior?.revision ?? 0) + 1)}`, tags: [], createdAt: i, acl: { readers: [OWNER] } }));
  const pending = await f.outbox.peek(OWNER, 100);
  assert.equal(pending.length, 1); assert.equal(pending[0].revision, 50);
  // A full queue refuses new items but still coalesces updates to queued ones.
  await f.metadata.transaction(async tx => { for (let i = 0; i < 2; i++) await enqueueSearchEvent(tx, { owner: OWNER, id: `q${i}`, source: { kind: 'message', id: `q${i}` } }, { maxQueue: 3 }); });
  await assert.rejects(f.metadata.transaction(tx => enqueueSearchEvent(tx, { owner: OWNER, id: 'q2', source: { kind: 'message', id: 'q2' } }, { maxQueue: 3 })), { code: 'search_queue_full' });
  await f.metadata.transaction(tx => enqueueSearchEvent(tx, { owner: OWNER, id: 'q0', source: { kind: 'message', id: 'q0' } }, { maxQueue: 3 }));
  assert.equal((await f.outbox.peek(OWNER, 100)).length, 3);
});
