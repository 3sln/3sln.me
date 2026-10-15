// Engine-level contact delivery: boundaries, races and contention asserted as
// invariants on observable state. Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { key } from '../packages/messaging/store.mjs';
import { DELIVERY_LIMITS } from '../packages/messaging/contact-delivery.mjs';
import { createScheduler, forEachSeed } from './helpers/chaos.mjs';
import { domainEngine, tally } from './helpers/engine.mjs';
import { messagingFixture as fixture, OWNER, GRANT, SENDER, KID, SENDER_JWK, DAY, START, pair } from './helpers/messaging-fixture.mjs';

const BASE = Number(process.env.CHAOS_SEED ?? 1);

test('operation age is admitted at both inclusive edges and refused one millisecond outside, before any write', async () => {
  const f = await fixture(), now = f.clock.now();
  for (const createdAt of [now - DELIVERY_LIMITS.maxOperationAgeMs, now + DELIVERY_LIMITS.maxFutureSkewMs]) assert.equal((await f.deliver({ createdAt })).replayed, false);
  for (const createdAt of [now - DELIVERY_LIMITS.maxOperationAgeMs - 1, now + DELIVERY_LIMITS.maxFutureSkewMs + 1]) await assert.rejects(f.deliver({ createdAt }), { code: 'operation_expired' });
  assert.equal((await f.conserved()).list.length, 2);
});

test('receipt retention always outlives admissibility, so an exact replay never becomes a second message', async () => {
  for (const offset of [-DELIVERY_LIMITS.maxOperationAgeMs, -1, 0, DELIVERY_LIMITS.maxFutureSkewMs]) {
    const f = await fixture(), createdAt = f.clock.now() + offset, { envelope, body } = await f.authored({ createdAt });
    const first = await f.service.deliver(GRANT, { envelope, body });
    const retainUntil = await f.raw.transaction(async tx => (await tx.list(key('contact-delivery-receipt', OWNER)))[0].value.retainUntil);
    assert.ok(retainUntil - DELIVERY_LIMITS.minReceiptRetentionMs >= createdAt + DELIVERY_LIMITS.maxOperationAgeMs, 'fence outlives the last admissible instant');
    // While the fence is retained, an exact replay returns the original receipt even though the operation has aged out.
    f.clock.set(createdAt + DELIVERY_LIMITS.maxOperationAgeMs + 1);
    assert.deepEqual(await f.service.deliver(GRANT, { envelope, body }), { receipt: first.receipt, replayed: true });
    // After the retention instant the fence may be collected; the operation is then inadmissible on age alone.
    f.clock.set(retainUntil);
    await f.raw.transaction(async tx => { for (const row of await tx.list(key('contact-delivery-receipt', OWNER))) await tx.delete(row.key); });
    await assert.rejects(f.service.deliver(GRANT, { envelope, body }), { code: 'operation_expired' });
    assert.equal((await f.state()).list.length, 1);
  }
});

test('grant and account quotas are inclusive at their exact limits', async () => {
  const sized = n => 'x'.repeat(n);
  let f = await fixture({ maxMessages: 3 });
  for (let i = 0; i < 3; i++) await f.deliver();
  await assert.rejects(f.deliver(), { code: 'quota_exceeded' }); await f.conserved();

  f = await fixture({ maxBytes: 100, maxMessageBytes: 60 });
  await assert.rejects(f.deliver({ text: sized(61) }), { code: 'too_large' });
  await f.deliver({ text: sized(60) }); await f.deliver({ text: sized(40) });
  await assert.rejects(f.deliver({ text: sized(1) }), { code: 'quota_exceeded' });
  assert.equal((await f.conserved()).usage.bytes, 100);

  f = await fixture({ maxStoredBytes: 10, maxStoredMessages: 2 });
  await f.deliver({ text: sized(6) }); await assert.rejects(f.deliver({ text: sized(5) }), { code: 'account_quota_exceeded' });
  await f.deliver({ text: sized(4) }); await assert.rejects(f.deliver({ text: '' }), { code: 'account_quota_exceeded' }, 'an empty body still needs a message slot');
  assert.deepEqual((await f.conserved()).usage, { bytes: 10, messages: 2 });
  // Deleting frees exactly what it used.
  await f.messages.delete(OWNER, (await f.state()).list.find(m => m.size === 6).id);
  await f.deliver({ text: sized(6) });
  const after = await f.state(); assert.equal(after.usage.bytes, after.list.reduce((s, m) => s + m.size, 0));
});

test('concurrent deliveries contend for one parent quota: exactly the limit is admitted under every seeded interleaving', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  await forEachSeed(5, async random => {
    const scheduler = createScheduler(random), f = await fixture({ maxMessages: 7, wrap: store => scheduler.wrap(store, 'store') });
    const e = domainEngine({ service: f.service });
    const inputs = await Promise.all(Array.from({ length: 20 }, (_, i) => f.authored({ text: `m${i}` })));
    try {
      const results = await scheduler.run(inputs.map(input => () => e.run(({ service }) => service.deliver(GRANT, input))));
      assert.deepEqual(tally(results, value => value.replayed ? 'replayed' : 'accepted'), { accepted: 7, quota_exceeded: 13 });
      assert.equal((await f.conserved()).list.length, 7);
    } finally { await e.dispose(); }
  }, { base: BASE });
});

test('duplicate operation IDs: concurrent copies and re-signed retries admit once; changed claims conflict', async () => {
  const f = await fixture(), e = domainEngine({ service: f.service });
  try {
    const { envelope, body } = await f.authored({ text: 'once' });
    const results = await e.all(Array.from({ length: 12 }, () => ({ service }) => service.deliver(GRANT, { envelope, body })));
    assert.deepEqual(tally(results, value => value.replayed ? 'replayed' : 'accepted'), { accepted: 1, replayed: 11 });
    const receipts = new Set(results.map(r => JSON.stringify(r.value.receipt))); assert.equal(receipts.size, 1);
    // ECDSA signatures are randomized: re-signing the same claims is the same operation.
    const resigned = await f.authored({ text: 'once', operationId: envelope.payload.operationId, createdAt: envelope.payload.createdAt });
    assert.notEqual(resigned.envelope.proof.signature, envelope.proof.signature);
    assert.equal((await f.service.deliver(GRANT, resigned)).replayed, true);
    for (const over of [{ text: 'changed' }, { subject: 'Other' }, { optionalTags: ['bug'] }]) await assert.rejects(f.deliver({ operationId: envelope.payload.operationId, createdAt: envelope.payload.createdAt, ...over }), { code: 'operation_conflict' });
    assert.equal((await f.conserved()).list.length, 1);
  } finally { await e.dispose(); }
});

test('intake revisions racing deliveries: every message carries exactly the tags of the revision it records', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  // Revision n auto-applies tag `rev:n`; odd revisions accept the optional tag `bug`, even ones do not.
  await forEachSeed(4, async random => {
    const scheduler = createScheduler(random), f = await fixture({ wrap: store => scheduler.wrap(store, 'store'), intake: { autoTags: ['rev:1'], optionalTags: ['bug'] } });
    const inputs = await Promise.all(Array.from({ length: 10 }, (_, i) => f.authored({ text: `m${i}`, optionalTags: i % 2 ? ['bug'] : [] })));
    const deliveries = inputs.map(input => () => f.service.deliver(GRANT, input));
    let revision = 1;
    const updates = Array.from({ length: 5 }, () => async () => { const next = await f.store.transaction(async tx => { const grant = await tx.get(key('contact-grant', GRANT)), r = grant.intake.revision + 1; grant.intake = { ...grant.intake, revision: r, autoTags: [`rev:${r}`], optionalTags: r % 2 ? ['bug'] : [] }; await tx.set(key('contact-grant', GRANT), grant); return r; }); revision = Math.max(revision, next); });
    const results = await scheduler.run(random.shuffle([...deliveries, ...updates]));
    assert.equal(revision, 6);
    for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'forbidden_tags');
    const s = await f.conserved();
    for (const m of s.list) {
      assert.ok(m.intakeRevision >= 1 && m.intakeRevision <= 6);
      assert.equal(m.delivery.intakeRevision, m.intakeRevision);
      const expected = [`rev:${m.intakeRevision}`, ...m.senderMetadata.tags];
      assert.deepEqual(m.deliveryTags, expected); assert.deepEqual(m.tags, expected);
      if (m.senderMetadata.tags.includes('bug')) assert.equal(m.intakeRevision % 2, 1, 'optional tag admitted only under a revision that accepted it');
    }
    assert.equal(s.list.length + results.filter(r => r.status === 'rejected').length, 10);
  }, { base: BASE });
});

test('a delivery prepared before an intake change or key revocation is judged at commit, with nothing written on refusal', async () => {
  const f = await fixture();
  let prepared = await f.service.prepare(GRANT, await f.authored({ optionalTags: ['bug'] }));
  await f.setIntake({ optionalTags: ['feature'] });
  await assert.rejects(f.service.commit(prepared), { code: 'forbidden_tags' });
  prepared = await f.service.prepare(GRANT, await f.authored());
  f.keys.get(SENDER + KID).active = false;
  await assert.rejects(f.service.commit(prepared), { code: 'author_unverifiable' });
  f.keys.get(SENDER + KID).active = true; f.keys.get(SENDER + KID).accountActive = false;
  await assert.rejects(f.service.commit(prepared), { code: 'author_unverifiable' });
  // A rotated key with the same id is a different key: the fence compares key material, not names.
  const other = await pair(), { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', other.publicKey);
  Object.assign(f.keys.get(SENDER + KID), { accountActive: true, publicJwk: { kty, crv, x, y } });
  await assert.rejects(f.service.commit(prepared), { code: 'author_unverifiable' });
  // Revoking the parent between prepare and commit is equally fatal.
  f.keys.get(SENDER + KID).publicJwk = SENDER_JWK;
  prepared = await f.service.prepare(GRANT, await f.authored());
  await f.raw.transaction(async tx => { const grant = await tx.get(key('contact-grant', GRANT)); grant.active = false; await tx.set(key('contact-grant', GRANT), grant); });
  await assert.rejects(f.service.commit(prepared), { code: 'unauthorized' });
  const s = await f.state(); assert.equal(s.list.length, 0); assert.equal(s.receipts, 0); assert.deepEqual(s.usage, { bytes: 0, messages: 0 });
});

test('conditional per-author daily quota: resets exactly at UTC midnight and a backwards clock jump never refunds a day', async () => {
  const audience = { admit: async () => ({ tags: [] }) }, f = await fixture({ conditional: true, maxMessages: 2, audience });
  const midnight = Math.ceil(START / DAY) * DAY;
  f.clock.set(midnight - 1); await f.deliver(); await f.deliver();
  await assert.rejects(f.deliver(), { code: 'quota_exceeded' });
  f.clock.set(midnight); await f.deliver(); await f.deliver();
  await assert.rejects(f.deliver(), { code: 'quota_exceeded' });
  f.clock.set(midnight - 1); await assert.rejects(f.deliver(), { code: 'quota_exceeded' }, 'rollback lands on the already-spent day');
  // Daily rows carry an expiry three days out so collection keeps state bounded.
  const days = await f.raw.transaction(async tx => (await tx.list(key('contact-author-day', OWNER))).map(row => row.value));
  assert.equal(days.length, 2); for (const day of days) assert.ok(day.expiresAt > midnight + DAY && day.expiresAt <= midnight + 3 * DAY);
  // Grant-wide totals still account every admitted message even though the daily rows decide admission.
  assert.equal((await f.conserved()).list.length, 4);
  // Without the audience port a conditional parent is unavailable, never silently unconditional.
  const g = await fixture({ conditional: true });
  await assert.rejects(g.deliver(), { code: 'audience_unavailable' });
});

test('bounded scaling: 120 concurrent deliveries keep state linear in admitted messages and refuse past the account cap', async () => {
  const f = await fixture({ maxMessages: 1000, maxBytes: 1 << 20, maxStoredMessages: 100 });
  const e = domainEngine({ service: f.service });
  try {
    const inputs = await Promise.all(Array.from({ length: 120 }, (_, i) => f.authored({ text: `message ${i}` })));
    const results = await e.all(inputs.map(input => ({ service }) => service.deliver(GRANT, input)));
    assert.deepEqual(tally(results, () => 'accepted'), { accepted: 100, account_quota_exceeded: 20 });
    const s = await f.conserved();
    // Rows per admitted message: message, receipt, notification event; plus fixed per-account rows.
    const rows = await f.raw.transaction(async tx => (await tx.list('')).length);
    assert.equal(rows, 3 * 100 + 5, 'collection, grant, usage, rules and rule defaults are the only other rows');
    assert.equal(s.list.length, 100);
  } finally { await e.dispose(); }
});
