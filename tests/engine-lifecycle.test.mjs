// Engine-level account lifecycle: AccountLifecycle over in-memory SQLite with
// fake clock, contact, finance, notice and reactivation ports. Seeded clock
// jumps (forward and backward) must never shortcut a notice period, and sweeps
// overlapping owner reactivation must leave one coherent outcome.
// Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMetadata, SerialGate } from '../apps/node/resources.mjs';
import { AccountLifecycle } from '../packages/runtime/account-lifecycle.mjs';
import { createScheduler, forEachSeed, fakeClock } from './helpers/chaos.mjs';

const BASE = Number(process.env.CHAOS_SEED ?? 1), DAY = 86400000, HOUR = 3600000;
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', config = { APP_ORIGIN: 'https://lifecycle.example', POLAR_SERVER: 'production', POLAR_CATALOG_MODE: 'metadata', POLAR_ORGANIZATION_ID: 'org' };

async function fixture(t, { wrap = ports => ports, outcome = () => 'accepted' } = {}) {
  const clock = fakeClock(100 * DAY), metadata = new SqliteMetadata(':memory:'); t.after(() => metadata.close());
  await metadata.put('owner', OWNER);
  const sent = [], ports = wrap({
    reviewFinance: async args => ({ ...args, neverPaid: true, checkedAt: clock.now(), expiresAt: clock.now() + 300000 }),
    sendNotice: async delivery => { const result = outcome(); sent.push({ ...delivery, at: clock.now(), result }); return result === 'accepted' ? { accepted: true, receipt: 'provider-' + delivery.attemptId } : { outcome: result }; },
    authorizeReactivation: async args => ({ ...args, verifiedAt: clock.now(), expiresAt: clock.now() + 60000 }),
    adminHold: async () => ({ held: false, since: null, releasedAt: null }),
  });
  const model = new AccountLifecycle({ metadata, gate: new SerialGate(), config, clock: clock.now, protection: async () => ({ status: 'unpaid' }), contact: async () => ({ verified: true, available: true, revision: 'email-1' }), ...ports });
  await model.recordActivation(OWNER, { createdAt: clock.now() - 1000, activatedAt: clock.now() });
  const effects = async () => [...(await metadata.list({ prefix: 'lifecycle/effect/' })).values()];
  return { clock, metadata, model, sent, effects };
}

test('seeded clock jumps never shortcut inactivity, warning or suspension periods, and a clock behind recorded time fails closed', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  let reached = new Set();
  await forEachSeed(8, async random => {
    const f = await fixture(t, { outcome: () => random.pick(['accepted', 'accepted', 'accepted', 'accepted', 'accepted', 'unknown', 'failed']) });
    let latest = f.clock.now(), view = await f.model.status(OWNER), lastActivity = view.lastActivityAt;
    for (let i = 0; i < 220; i++) {
      const roll = random.next();
      if (roll < 0.1) {
        // Clock steps backwards: every call refuses rather than acting on time it has already recorded past.
        f.clock.set(latest - random.pick([1, HOUR, 5 * DAY]));
        for (const call of [() => f.model.step(OWNER), () => f.model.status(OWNER), () => f.model.recordActivity(OWNER, { source: 'owner-return' })]) {
          try { await call(); } catch (error) { assert.ok(['lifecycle_unavailable', 'account_suspended'].includes(error.code), error.code); }
        }
        f.clock.set(latest); continue;
      }
      latest = f.clock.advance(random.pick([HOUR, DAY, 2 * DAY, 3 * DAY, 10 * DAY, 10 * DAY, 10 * DAY, 400 * DAY]));
      if (roll < 0.15 && view.phase === 'active') { view = await f.model.recordActivity(OWNER, { source: 'owner-return' }); lastActivity = view.lastActivityAt; continue; }
      const result = await f.model.step(OWNER), now = f.clock.now(), after = await f.model.status(OWNER);
      reached.add(after.phase);
      assert.notEqual(result.action, 'purge-started', 'purging is disabled');
      if (view.phase === 'active' && after.phase === 'warning') assert.ok(now >= lastActivity + (view.established ? 365 : 2) * DAY, 'warning only after the inactivity window');
      for (const [from, to, grace] of [['warning', 'suspended', 7 * DAY], ['suspended', 'purge-review', 30 * DAY]]) {
        if (view.phase !== from || after.phase !== to) continue;
        // The notice episode that just ended: same phase, the generation it ran under.
        const episode = f.sent.filter(s => s.phase === from && s.generation === view.generation), accepted = episode.filter(s => s.result === 'accepted');
        assert.ok(episode.length >= 3 && accepted.length >= 1, `${from}→${to} with ${episode.length} notices, ${accepted.length} accepted`);
        assert.ok(now >= accepted[0].at + grace, `${from}→${to} before its ${grace / DAY}-day grace`);
        assert.ok(episode.filter(s => s.at <= accepted[0].at + grace).length >= 3, 'three notices inside the grace period');
      }
      assert.ok(after.generation >= view.generation, 'generation never decreases');
      view = after;
    }
  }, { base: BASE });
  // Holds (failed notices, big jumps) are legitimate outcomes, so phase coverage is
  // asserted for the default seed base only; it guards against a generator that
  // silently stops exercising transitions. Other bases check the invariants alone.
  t.diagnostic(`phases reached: ${[...reached]}`);
  if (process.env.CHAOS_SEED === undefined) assert.ok(['warning', 'suspended', 'purge-review'].every(phase => reached.has(phase)), `timeline reached ${[...reached]}`);
});

async function suspended(f) {
  f.clock.advance(3 * DAY);
  for (let i = 0; i < 3; i++) { assert.equal((await f.model.step(OWNER)).outcome, 'accepted'); f.clock.advance(f.model.spacing('warning')); }
  f.clock.set((await f.model.status(OWNER)).deadline);
  assert.equal((await f.model.step(OWNER)).action, 'suspended');
}
async function suspendedDeadline(f) {
  await suspended(f);
  for (let i = 0; i < 3; i++) { assert.equal((await f.model.step(OWNER)).outcome, 'accepted'); f.clock.advance(f.model.spacing('suspended')); }
  f.clock.set((await f.model.status(OWNER)).deadline);
}
test('sweeps overlapping owner reactivation: one coherent outcome under every seeded interleaving', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  const outcomes = new Set();
  await forEachSeed(12, async random => {
    // Even seeds race a due notice; odd seeds race the suspension deadline itself.
    const atDeadline = random.seed % 2 === 1, scheduler = createScheduler(random), f = await fixture(t, { wrap: ports => scheduler.wrap(ports, 'ports') });
    if (atDeadline) await suspendedDeadline(f); else { await suspended(f); f.clock.advance(f.model.spacing('suspended')); }
    const before = await f.model.status(OWNER), thawsBefore = (await f.effects()).filter(e => e.kind === 'thaw').length;
    const [sweep, reactivation, second] = await scheduler.run([() => f.model.step(OWNER), () => f.model.reactivate(OWNER, { kind: 'passkey' }), () => f.model.step(OWNER)]);
    const after = await f.model.status(OWNER), access = await f.model.access(OWNER);
    assert.equal(access.blocked, ['suspended', 'purge-review', 'purging'].includes(after.phase));
    const thaws = (await f.effects()).filter(e => e.kind === 'thaw').length - thawsBefore;
    for (const r of [sweep, second]) assert.equal(r.status, 'fulfilled', r.reason?.message);
    if (reactivation.status === 'fulfilled') {
      outcomes.add('reactivated');
      assert.equal(reactivation.value.phase, 'active'); assert.equal(after.phase, 'active', 'no stale sweep re-blocks a reactivated account');
      assert.ok(after.capabilityEpoch > before.capabilityEpoch); assert.equal(thaws, 1);
    } else {
      outcomes.add(reactivation.reason.code);
      // Only a committed phase change can make the owner's proof stale.
      assert.equal(reactivation.reason.code, 'stale_reactivation'); assert.equal(atDeadline, true);
      assert.equal(after.phase, 'purge-review'); assert.equal(thaws, 0);
    }
  }, { base: BASE });
  t.diagnostic(`race outcomes: ${[...outcomes]}`);
  assert.ok(outcomes.has('reactivated'));
  // The losing order, forced: the owner's proof is issued, the deadline sweep commits, then the stale proof arrives.
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { wrap: ports => ({ ...ports, authorizeReactivation: async args => { await held; return ports.authorizeReactivation(args); } }) });
  await suspendedDeadline(f);
  const reactivation = f.model.reactivate(OWNER, { kind: 'passkey' }).catch(error => error);
  assert.equal((await f.model.step(OWNER)).action, 'deletion-review');
  release();
  assert.equal((await reactivation).code, 'stale_reactivation');
  assert.equal((await f.model.status(OWNER)).phase, 'purge-review');
  assert.equal((await f.effects()).filter(e => e.kind === 'thaw').length, 0);
});
