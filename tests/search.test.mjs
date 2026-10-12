import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryMessagingStore } from '../packages/messaging/store.mjs';
import { SearchService, MemorySearchIndex, MemoryVectorIndex, SqliteSearchIndex, nodeSqlPort, enqueueSearchEvent, MetadataSearchOutbox, extractSearchText, validateDocument, normalizeQuery, planBudget, WorkersAIEmbeddingAdapter, VectorizeSearchIndex } from '../packages/search/index.mjs';

const doc = (id, overrides = {}) => ({ id, owner: 'alice', source: { kind: 'message', id }, revision: 1, type: 'message', title: 'Project note', text: 'The violet launch is ready', tags: ['work'], classification: 'work', createdAt: 100, acl: { readers: ['alice'] }, ...overrides });
const fixture = (options = {}) => {
  const docs = new Map(), index = options.index || new MemorySearchIndex(), authority = { get: async (owner, id) => docs.get(owner + '/' + id), scan: async (owner, { limit }) => ({ items: [...docs.values()].filter(row => row.owner === owner).slice(0, limit) }) };
  const service = new SearchService({ index, authority, ...options });
  const put = async input => { docs.set(input.owner + '/' + input.id, structuredClone(input)); await service.ingest({ owner: input.owner, id: input.id, revision: input.revision, operation: 'upsert' }); };
  return { docs, index, authority, service, put };
};

test('lexical, tag AND/OR, date and type queries use bounded candidates', async () => {
  const f = fixture(); await f.put(doc('one')); await f.put(doc('two', { tags: ['work', 'urgent'], createdAt: 200, type: 'email' })); await f.put(doc('three', { tags: ['personal'], text: 'Other topic', createdAt: 300 }));
  assert.deepEqual((await f.service.search('alice', { text: 'violet', tags: { all: ['work', 'urgent'] }, types: ['email'], from: 150, to: 250 })).items.map(row => row.id), ['two']);
  assert.equal((await f.service.search('alice', { tags: { any: ['personal', 'urgent'] } })).items.length, 2);
  assert.equal((await f.service.search('alice', { text: 'violet absent' })).items.length, 0);
  await assert.rejects(f.service.search('alice', { mode: 'semantic', text: 'launch' }), { code: 'semantic_search_unavailable' });
});

test('cold and warm stale indexes cannot leak revoked, deleted or quarantined content', async () => {
  const f = fixture(); await f.put(doc('one')); await f.put(doc('two')); await f.put(doc('three'));
  f.docs.get('alice/one').acl.readers = [];
  f.docs.get('alice/two').quarantined = true;
  f.docs.delete('alice/three');
  assert.deepEqual((await f.service.search('alice', { text: 'violet' })).items, []);
  const restarted = new SearchService({ index: f.index, authority: f.authority });
  assert.deepEqual((await restarted.search('alice', { text: 'violet' })).items, []);
  await f.service.ingest({ owner: 'alice', id: 'three', revision: 2, operation: 'tombstone' });
  await f.index.upsert(doc('three', { text: 'resurrection' }));
  assert.equal((await f.service.search('alice', { text: 'resurrection' })).items.length, 0);
});

test('owner hard filter occurs before authority lookup and snippets only use current source', async () => {
  let reads = 0;
  const f = fixture({ index: { candidates: async () => [{ owner: 'bob', id: 'private', revision: 1 }, { owner: 'alice', id: 'one', revision: 1 }] } });
  f.docs.set('alice/one', doc('one', { text: 'Current safe text' }));
  const get = f.authority.get; f.authority.get = async (...args) => { reads++; return get(...args); };
  const result = await f.service.search('alice', { text: 'violet' });
  assert.equal(reads, 1); assert.equal(result.items[0].snippet, 'Current safe text');
  f.docs.get('alice/one').revision = 2;
  assert.deepEqual((await f.service.search('alice', { text: 'violet' })).items, []);
});

test('opaque cursors are query/owner bound, expiring and recheck ACL on every page', async () => {
  let now = 0; const f = fixture({ clock: () => now });
  for (const id of ['one', 'two', 'three']) await f.put(doc(id));
  const first = await f.service.search('alice', { text: 'violet', limit: 1 }); assert.ok(first.cursor); assert.ok(!first.cursor.includes('violet'));
  await assert.rejects(f.service.search('bob', { text: 'violet', limit: 1, cursor: first.cursor }), { code: 'invalid_search_cursor' });
  await assert.rejects(f.service.search('alice', { text: 'ready', limit: 1, cursor: first.cursor }), { code: 'invalid_search_cursor' });
  for (const value of f.docs.values()) value.acl.readers = [];
  assert.deepEqual((await f.service.search('alice', { text: 'violet', limit: 1, cursor: first.cursor })).items, []);
  for (const value of f.docs.values()) value.acl.readers = ['alice'];
  const next = await f.service.search('alice', { limit: 1 }); now = 300001;
  await assert.rejects(f.service.search('alice', { limit: 1, cursor: next.cursor }), { code: 'invalid_search_cursor' });
});

test('revisioned outbox coalesces, rolls back overflow, and acknowledgement preserves newer work', async () => {
  const store = new MemoryMessagingStore();
  const enqueue = (id, operation = 'upsert') => store.transaction(tx => enqueueSearchEvent(tx, { owner: 'alice', id, source: { kind: 'message', id, privateCredential: 'must-not-be-copied' }, operation }, { maxQueue: 1 }));
  const first = await enqueue('one'); assert.deepEqual(first.source, { kind: 'message', id: 'one' }); const second = await enqueue('one', 'tombstone'); assert.equal(second.revision, 2);
  await assert.rejects(enqueue('two'), { code: 'search_queue_full' });
  const metadata = { list: ({ prefix, limit }) => store.transaction(async tx => new Map((await tx.list(prefix)).slice(0, limit).map(row => [row.key, row.value]))), transaction: operation => store.transaction(operation) };
  const outbox = new MetadataSearchOutbox(metadata);
  assert.equal(await outbox.acknowledge(first), false); assert.equal((await outbox.peek('alice', 1))[0].revision, 2);
  assert.equal(await outbox.acknowledge(second), true); assert.deepEqual(await outbox.peek('alice', 1), []);
  assert.equal((await enqueue('two')).revision, 1);
});

test('ingestion is idempotent, ignores delayed revisions and preserves tombstones', async () => {
  const f = fixture(); await f.put(doc('one')); await f.put(doc('one', { revision: 2, text: 'Updated gold launch' }));
  await f.service.ingest({ owner: 'alice', id: 'one', revision: 1, operation: 'upsert' });
  assert.equal((await f.service.search('alice', { text: 'gold' })).items.length, 1);
  await f.service.ingest({ owner: 'alice', id: 'one', revision: 3, operation: 'tombstone' });
  await f.index.upsert(doc('one', { revision: 2, text: 'Updated gold launch' }));
  assert.equal((await f.service.search('alice', { text: 'gold' })).items.length, 0);
});

test('semantic ports use supplied embeddings, bounded hybrid ranking and permission after embedding await', async () => {
  const vectorIndex = new MemoryVectorIndex({ dimensions: 2 }); const embedder = { embed: async text => text.includes('launch') ? [1, 0] : [0, 1] };
  const f = fixture({ vectorIndex, embedder }); await f.put(doc('one', { embeddingAllowed: true })); await f.put(doc('two', { text: 'Garden blossoms', embeddingAllowed: true }));
  const result = await f.service.search('alice', { text: 'launch', mode: 'semantic' }); assert.equal(result.semanticAvailable, true); assert.equal(result.items[0].id, 'one');
  f.service.embedder = { embed: async () => { f.docs.get('alice/one').acl.readers = []; return [1, 0]; } };
  f.docs.get('alice/one').revision = 2;
  await f.service.ingest({ owner: 'alice', id: 'one', revision: 2, operation: 'upsert' });
  assert.ok(!(await f.service.search('alice', { mode: 'semantic', text: 'launch' })).items.some(row => row.id === 'one'));
});

test('SQL FTS5 filters before LIMIT, keeps exact tags and rejects replayed deleted revisions', async () => {
  const db = new DatabaseSync(':memory:'); const index = new SqliteSearchIndex({ sql: nodeSqlPort(db) }); const f = fixture({ index });
  try {
    await f.put(doc('one')); await f.put(doc('two', { tags: ['worker'], createdAt: 200 })); await f.put(doc('bob', { owner: 'bob', acl: { readers: ['bob'] } }));
    assert.deepEqual((await index.candidates('alice', normalizeQuery({ text: 'violet', tags: { all: ['work'] } }), { limit: 1 })).map(row => row.id), ['one']);
    assert.deepEqual((await index.candidates('alice', normalizeQuery({ text: 'violet', tags: { any: ['worker'] }, from: 150 }), { limit: 5 })).map(row => row.id), ['two']);
    await index.tombstone({ owner: 'alice', id: 'one', revision: 2 }); await index.upsert(doc('one'));
    assert.equal((await index.candidates('alice', normalizeQuery({ text: 'violet', tags: { all: ['work'] } }), { limit: 5 })).length, 0);
    assert.equal(db.prepare('SELECT documents FROM search_usage WHERE owner=?').get('alice').documents, 1);
    await index.upsert(doc('unicode', { title: '', text: 'A cafe\u0301 meeting' }));
    assert.equal((await index.candidates('alice', normalizeQuery({ text: 'café' }), { limit: 5 })).length, 1);
    assert.equal((await index.candidates('alice', normalizeQuery({ text: '616c696365' }), { limit: 5 })).length, 0); // Owner scope is not content.
  } finally { db.close(); }
});

test('SQL indexing budget failure rolls back derived rows and revisions', async () => {
  const db = new DatabaseSync(':memory:'); const index = new SqliteSearchIndex({ sql: nodeSqlPort(db), budgets: { indexedTokens: 5 } });
  try {
    await index.upsert(doc('one', { title: '', text: 'gold' }));
    await assert.rejects(index.upsert(doc('one', { revision: 2, text: 'too many tokens to fit budget' })), { code: 'search_token_budget' });
    assert.equal(db.prepare('SELECT revision FROM search_revisions').get().revision, 1);
    assert.equal((await index.candidates('alice', normalizeQuery({ text: 'gold' }), { limit: 5 })).length, 1);
  } finally { db.close(); }
});

test('credential content is forbidden and media extraction is bounded inert text', () => {
  assert.throws(() => validateDocument(doc('secret', { type: 'provider-credential' })), { code: 'sensitive_search_document' });
  const bytes = new TextEncoder().encode('<p>Hello &amp; world</p><script>fetch("secret")</script><img src="https://tracking.example/">');
  assert.equal(extractSearchText({ mimeType: 'text/html', bytes }).text, 'Hello & world');
  assert.equal(extractSearchText({ mimeType: 'text/html', bytes: new TextEncoder().encode('<p>Visible</p><script>unclosed hidden code') }).text, 'Visible');
  assert.equal(extractSearchText({ mimeType: 'video/mp4', bytes }).supported, false);
  assert.throws(() => extractSearchText({ mimeType: 'text/plain', bytes }, { maxInputBytes: 1 }), { code: 'search_extraction_limit' });
  assert.ok(planBudget('free', { indexedTokens: 2000001 }).provisional); assert.equal(planBudget('free', { indexedTokens: 2000001 }).remaining.indexedTokens, 0);
});

test('Cloudflare adapters require real binding output and partition vector candidate generation', async () => {
  const embedding = new WorkersAIEmbeddingAdapter({ binding: { run: async (model, input) => { assert.equal(model, 'embedding-model'); assert.deepEqual(input.text, ['launch']); return { data: [[1, 0]] }; } }, model: 'embedding-model', dimensions: 2 });
  assert.deepEqual(await embedding.embed('launch'), [1, 0]);
  const state = new Map(); let queryOptions; const binding = { upsert: async () => {}, deleteByIds: async () => {}, query: async (vector, options) => { queryOptions = options; return { matches: [{ namespace: options.namespace, metadata: { owner: 'alice', itemId: 'one', revision: 1 }, score: 1 }, { namespace: options.namespace, metadata: { owner: 'bob', itemId: 'private', revision: 1 }, score: 1 }] }; } };
  const metadata = { get: async key => state.get(key), put: async (key, value) => state.set(key, value) }; metadata.transaction = operation => operation(metadata);
  const index = new VectorizeSearchIndex({ binding, owner: 'alice', dimensions: 2, state: metadata, gate: { run: operation => operation() } });
  await index.upsert(doc('one', { embeddingAllowed: true }), [1, 0]);
  const rows = await index.candidates('alice', normalizeQuery({ text: 'launch' }), { limit: 200, vector: [1, 0] }); assert.equal(queryOptions.topK, 50); assert.equal(rows.length, 1); assert.ok(queryOptions.namespace);
  await assert.rejects(index.candidates('bob', normalizeQuery(), { limit: 1, vector: [1, 0] }), { code: 'search_index_owner' });
});

test('remote vector deletion failures retain bounded durable cleanup work and retry it', async () => {
  const store = new MemoryMessagingStore();
  const state = { get: key => store.transaction(tx => tx.get(key)), put: (key, value) => store.transaction(tx => tx.set(key, value)), transaction: operation => store.transaction(tx => operation({ get: tx.get, put: tx.set })) };
  let failDelete = true, deleted = [], mutations = 0;
  const binding = { query: async () => ({ matches: [] }), upsert: async () => { mutations++; }, deleteByIds: async ids => { if (failDelete) throw Error('remote_unavailable'); deleted.push(...ids); } };
  const index = new VectorizeSearchIndex({ binding, owner: 'alice', dimensions: 2, state, gate: { run: operation => operation() } });
  await index.upsert(doc('one', { embeddingAllowed: true }), [1, 0]);
  await assert.rejects(index.upsert(doc('one', { revision: 2, embeddingAllowed: true }), [0, 1]), /remote_unavailable/);
  await assert.rejects(index.upsert(doc('one', { revision: 3, embeddingAllowed: true }), [1, 0]), /remote_unavailable/);
  assert.equal(mutations, 2);
  failDelete = false; await index.upsert(doc('one', { revision: 2, embeddingAllowed: true }), [0, 1]); assert.equal(deleted.length, 1);
  await index.tombstone({ owner: 'alice', id: 'one', revision: 3 }); assert.equal(deleted.length, 2);
});

test('search authority purpose supports exact-revision cached text without source blob rereads', async () => {
  const index = new MemorySearchIndex(), original = doc('one'); await index.upsert(original); let extractionReads = 0;
  const authority = { get: async (owner, id, { purpose, revision }) => {
    if (purpose === 'search') { const text = await index.readContent(owner, id, revision); return text && original.revision === revision ? { ...original, ...text } : null; }
    extractionReads++; return original;
  } };
  const service = new SearchService({ index, authority });
  assert.equal((await service.search('alice', { text: 'violet' })).items.length, 1); assert.equal(extractionReads, 0);
  original.revision = 2;
  assert.deepEqual((await service.search('alice', { text: 'violet' })).items, []); assert.equal(extractionReads, 0);
});

test('lexical rebuild discards orphaned derived content and rejects unbounded adapter pages', async () => {
  const f = fixture(); await f.put(doc('orphan')); f.docs.delete('alice/orphan'); f.docs.set('alice/current', doc('current'));
  assert.equal((await f.service.rebuild('alice', { reset: true, limit: 1 })).processed, 1);
  assert.equal(await f.index.readContent('alice', 'orphan', 1), null);
  assert.deepEqual((await f.service.search('alice', { text: 'violet' })).items.map(row => row.id), ['current']);
  f.authority.scan = async () => ({ items: [doc('one'), doc('two')] });
  await assert.rejects(f.service.rebuild('alice', { limit: 1 }), { code: 'unbounded_search_authority' });
  f.index.candidates = async () => Array.from({ length: 201 }, () => ({ owner: 'alice', id: 'current', revision: 1 }));
  await assert.rejects(f.service.search('alice'), { code: 'unbounded_search_index' });
});
