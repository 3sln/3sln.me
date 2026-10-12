import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMetadata, SerialGate } from '../apps/node/resources.mjs';
import { GlobalSemanticBudget } from '../packages/runtime/semantic-budget.mjs';
import { DurableSemanticBudget, SEMANTIC_MODEL, SEMANTIC_DIMENSIONS } from '../packages/search/semantic-budget.mjs';
import { WorkersAIEmbeddingAdapter, VectorizeSearchIndex } from '../packages/search/cloudflare.mjs';
import { recordKey } from '../packages/search/schema.mjs';

const owner = '12345678-1234-4234-8234-123456789abc';
const secondOwner = '12345678-1234-4234-8234-123456789abd';
const start = Date.UTC(2026, 9, 12);
const vector = () => Array(SEMANTIC_DIMENSIONS).fill(0.25);
const document = { id: 'message:a', owner, source: { kind: 'message', id: 'a' }, revision: 1, type: 'message', title: 'Audit', text: 'test body', tags: [], createdAt: start, acl: { readers: [owner] }, embeddingAllowed: true };
const makeOwnerBudget = async (state, options = {}) => {
  const budget = new DurableSemanticBudget({ state, configured: true, globalSpend: { reserve: async () => true }, clock: () => start, ...options });
  await budget.consent(owner, true);
  return budget;
};

test('independent audit: concurrent global reservations stop before daily ceiling and survive controller replacement', async () => {
  const metadata = new SqliteMetadata(':memory:');
  try {
    const config = { SEMANTIC_GLOBAL_DAILY_MICRO_USD: 22, SEMANTIC_GLOBAL_MONTHLY_MICRO_USD: 100 };
    const budget = new GlobalSemanticBudget({ metadata, config, clock: () => start });
    const attempts = await Promise.allSettled(Array.from({ length: 25 }, () => budget.reserve({ operation: 'embed', units: 512, owner })));
    assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 2);
    assert.equal((await metadata.get('semantic/day')).microUSD, 22);
    const restarted = new GlobalSemanticBudget({ metadata, config, clock: () => start });
    await assert.rejects(restarted.reserve({ operation: 'embed', units: 512, owner }), { code: 'semantic_global_budget' });
  } finally { metadata.close(); }
});

test('independent audit: monthly spend and lifetime owner/vector admission are independent', async () => {
  const metadata = new SqliteMetadata(':memory:'); let now = start;
  try {
    const budget = new GlobalSemanticBudget({ metadata, config: { SEMANTIC_GLOBAL_MAX_OWNERS: 1, SEMANTIC_GLOBAL_MAX_UPSERTS: 1 }, clock: () => now });
    await budget.reserve({ owner, operation: 'upsert', units: 384 });
    now = Date.UTC(2026, 10, 12);
    await assert.rejects(budget.reserve({ owner, operation: 'upsert', units: 384 }), { code: 'semantic_global_budget' });
    await assert.rejects(budget.reserve({ owner: secondOwner, operation: 'query', units: 384 }), { code: 'semantic_global_budget' });
    await budget.reserve({ owner, operation: 'query', units: 384 });
    assert.deepEqual(await metadata.get('semantic/stock'), { owners: 1, upserts: 1 });
  } finally { metadata.close(); }
});

test('independent audit: partial same-period global accounting cannot admit external work', async () => {
  const metadata = new SqliteMetadata(':memory:');
  try {
    const budget = new GlobalSemanticBudget({ metadata, clock: () => start });
    await metadata.put('semantic/day', { period: '2026-10-12', calls: 1 });
    await assert.rejects(budget.reserve({ owner, operation: 'embed', units: 512 }));
  } finally { metadata.close(); }
});

test('independent audit: partial same-period owner accounting cannot reach the provider', async () => {
  const state = new SqliteMetadata(':memory:'); let calls = 0;
  try {
    const budget = await makeOwnerBudget(state);
    await state.put(recordKey('search-semantic-spend', owner), { month: '2026-10', queries: 0 });
    const adapter = new WorkersAIEmbeddingAdapter({ binding: { run: async () => { calls++; return { data: [vector()] }; } }, model: SEMANTIC_MODEL, dimensions: SEMANTIC_DIMENSIONS, maxInputBytes: 480, budget });
    await assert.rejects(adapter.embed('hello', { owner, purpose: 'query' }));
    assert.equal(calls, 0);
  } finally { state.close(); }
});

test('independent audit: timeout attempts consume owner allowance and cannot be replayed free', async () => {
  const state = new SqliteMetadata(':memory:'); let calls = 0;
  try {
    const budget = await makeOwnerBudget(state, { limits: { queries: 2 } });
    const adapter = new WorkersAIEmbeddingAdapter({ binding: { run: async () => { calls++; throw new Error('ambiguous remote timeout'); } }, model: SEMANTIC_MODEL, dimensions: SEMANTIC_DIMENSIONS, maxInputBytes: 480, budget });
    for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(adapter.embed('same query', { owner, purpose: 'query' }));
    assert.equal(calls, 2);
    const status = await budget.status(owner);
    assert.equal(status.usage.queries, 2);
    assert.equal(status.usage.embeddingTokens, 1024);
    assert.equal(status.usage.spendMicroUSD, 22);
  } finally { state.close(); }
});

test('independent audit: global admission rejection stops provider even after local reservation', async () => {
  const state = new SqliteMetadata(':memory:'); let calls = 0;
  try {
    const budget = await makeOwnerBudget(state, { globalSpend: { reserve: async () => false } });
    const adapter = new WorkersAIEmbeddingAdapter({ binding: { run: async () => { calls++; return { data: [vector()] }; } }, model: SEMANTIC_MODEL, dimensions: SEMANTIC_DIMENSIONS, maxInputBytes: 480, budget });
    await assert.rejects(adapter.embed('query', { owner, purpose: 'query' }), { code: 'semantic_global_budget' });
    assert.equal(calls, 0);
    assert.equal((await budget.status(owner)).usage.queries, 1);
  } finally { state.close(); }
});

test('independent audit: excerpt truncation stays within bytes without breaking UTF-8', async () => {
  let sent;
  const adapter = new WorkersAIEmbeddingAdapter({ binding: { run: async (_model, payload) => { sent = payload.text[0]; return { data: [vector()] }; } }, model: SEMANTIC_MODEL, dimensions: SEMANTIC_DIMENSIONS, maxInputBytes: 480 });
  await adapter.embed('x' + '🌈'.repeat(200));
  assert.ok(new TextEncoder().encode(sent).length <= 480);
  assert.ok(!sent.includes('\uFFFD'));
  assert.equal(sent, 'x' + '🌈'.repeat(119));
});

test('independent audit: ambiguous vector upsert leaves durable cleanup intent and unreclaimed slot', async () => {
  const state = new SqliteMetadata(':memory:'); let submittedId, calls = 0;
  try {
    const budget = await makeOwnerBudget(state);
    const binding = {
      upsert: async rows => { calls++; submittedId = rows[0].id; throw new Error('remote accepted, response lost'); },
      query: async () => ({ matches: [] }), deleteByIds: async () => {}
    };
    const index = new VectorizeSearchIndex({ binding, state, gate: new SerialGate(), owner, dimensions: SEMANTIC_DIMENSIONS, maxVectors: 1, budget });
    await assert.rejects(index.upsert(document, vector()));
    const intent = await state.get(recordKey('search-vector-revision', owner, document.id));
    assert.ok(intent.cleanupIds.includes(submittedId));
    await index.tombstone({ owner, id: document.id, revision: 2 });
    await assert.rejects(index.upsert({ ...document, id: 'message:b', source: { kind: 'message', id: 'b' } }, vector()), { code: 'search_vector_budget' });
    assert.equal(calls, 1);
  } finally { state.close(); }
});

// Sharded allocator/lease conservation tests deliberately instantiate separate
// local consumers to exercise persistence, not just an in-memory serial queue.
import { semanticBudgetPartition, semanticShard, vectorBinding, SEMANTIC_LAYOUT } from '../packages/runtime/semantic-routing.mjs';
import { LeasedSemanticSpend } from '../packages/runtime/semantic-leases.mjs';

const leaseGrant = (input, day = '2026-10-12') => ({ ...input, day, month: day.slice(0, 7), layoutVersion: SEMANTIC_LAYOUT.version });

test('independent audit: sixteen uneven allowance partitions conserve every aggregate ceiling exactly', () => {
  const totals = { SEMANTIC_GLOBAL_MONTHLY_MICRO_USD: 5000001, SEMANTIC_GLOBAL_DAILY_MICRO_USD: 500003, SEMANTIC_GLOBAL_MAX_OWNERS: 1000, SEMANTIC_GLOBAL_MAX_UPSERTS: 2000007 };
  const partitions = Array.from({ length: 16 }, (_, index) => semanticBudgetPartition(totals, index));
  for (const [key, total] of Object.entries(totals)) {
    assert.equal(partitions.reduce((sum, partition) => sum + partition[key], 0), total);
    assert.ok(Math.max(...partitions.map(partition => partition[key])) - Math.min(...partitions.map(partition => partition[key])) <= 1);
  }
});

test('independent audit: vector routing selects one stable binding without querying all four', async () => {
  let queries = 0;
  const config = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`SEARCH_VECTORS_${index}`, { query: async () => { queries++; }, upsert() {}, deleteByIds() {} }]));
  const first = await vectorBinding(config, owner), second = await vectorBinding(config, owner);
  assert.equal(first.shard, await semanticShard(owner, 4));
  assert.equal(first.binding, config[`SEARCH_VECTORS_${first.shard}`]);
  assert.equal(second.binding, first.binding);
  assert.equal(queries, 0);
  await first.binding.query();
  assert.equal(queries, 1);
});

test('independent audit: prepaid lease consumption survives consumer replacement without another authority call', async () => {
  const metadata = new SqliteMetadata(':memory:'); let claims = 0;
  try {
    const authorityFor = async () => ({ partition: 0, authority: { reserveLease: async input => { claims++; return leaseGrant(input); } } });
    let leased = new LeasedSemanticSpend({ metadata, authorityFor, clock: () => start });
    await leased.reserve({ owner, operation: 'embed', units: 512 });
    leased = new LeasedSemanticSpend({ metadata, authorityFor, clock: () => start });
    await leased.reserve({ owner, operation: 'embed', units: 512 });
    assert.equal(claims, 1);
    assert.equal((await metadata.get(`semantic/lease/${owner}`)).money, 128 - 22);
  } finally { metadata.close(); }
});

test('independent audit: a lease response crossing UTC midnight cannot spend yesterday credit', async () => {
  const metadata = new SqliteMetadata(':memory:'); let now = start;
  try {
    const authorityFor = async () => ({ partition: 0, authority: { reserveLease: async input => { now += 86400000; return leaseGrant(input); } } });
    const leased = new LeasedSemanticSpend({ metadata, authorityFor, clock: () => now });
    await assert.rejects(leased.reserve({ owner, operation: 'embed', units: 512 }));
    assert.equal(await metadata.get(`semantic/lease/${owner}`), undefined);
  } finally { metadata.close(); }
});

test('independent audit: concurrent stock-only lease refills cannot restore already debited money', async () => {
  const metadata = new SqliteMetadata(':memory:'); let signalBoth;
  const bothClaimed = new Promise(resolve => { signalBoth = resolve; }); const pending = [];
  try {
    await metadata.put(`semantic/lease/${owner}`, { day: '2026-10-12', money: 8, slots: 0 });
    const authorityFor = async () => ({ partition: 0, authority: { reserveLease: input => new Promise(resolve => { pending.push(() => resolve(leaseGrant(input))); if (pending.length === 2) signalBoth(); }) } });
    const a = new LeasedSemanticSpend({ metadata, authorityFor, clock: () => start });
    const b = new LeasedSemanticSpend({ metadata, authorityFor, clock: () => start });
    const first = a.reserve({ owner, operation: 'upsert', units: 384 });
    const second = b.reserve({ owner, operation: 'upsert', units: 384 });
    await bothClaimed;
    pending[0](); await first;
    pending[1](); await second;
    const state = await metadata.get(`semantic/lease/${owner}`);
    assert.equal(state.money, 0);
    assert.equal(state.slots, 30);
  } finally { metadata.close(); }
});
