// Service-level billing webhooks (not yet engine-migrated: direct BillingService calls,
// see docs/architecture/app-engine.md slice 7): BillingService behind the account gate with a
// fake Polar client and fake clock. Order, duplicates and replay storms must
// never change what the provider's current state entitles, and paid history is
// monotonic. Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BillingService, BILLING_PLANS } from '../packages/billing/index.mjs';
import { accountRemovalProtection } from '../packages/identity/lifecycle-protection.mjs';
import { SerialGate } from '../apps/node/resources.mjs';
import { forEachSeed, fakeClock, concurrently, tally } from './helpers/chaos.mjs';

const BASE = Number(process.env.CHAOS_SEED ?? 1), DAY = 86400000;
const OWNER = 'aa111111-1111-4111-8111-111111111111';
const config = { BILLING_ENABLED: 'true', POLAR_SERVER: 'sandbox', POLAR_ACCESS_TOKEN: 'offline-only', POLAR_WEBHOOK_SECRET: 'whsec_' + Buffer.alloc(32, 39).toString('base64'), POLAR_PRODUCT_ID_PAID: 'paid-product', POLAR_PRODUCT_ID_PLUS: 'plus-product', POLAR_PRODUCT_ID_ULTRA: 'ultra-product', APP_ORIGIN: 'https://3sln.example' };
class Metadata {
  constructor() { this.rows = new Map(); this.tail = Promise.resolve(); }
  async get(k) { return structuredClone(this.rows.get(k)); }
  async put(k, v) { this.rows.set(k, structuredClone(v)); }
  async delete(k) { this.rows.delete(k); }
  async list({ prefix = '', limit = 100000 } = {}) { return new Map([...this.rows].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)); }
  async transaction(fn) { const previous = this.tail; let release; this.tail = new Promise(r => release = r); await previous; const snapshot = structuredClone(this.rows); try { return await fn(this); } catch (e) { this.rows = snapshot; throw e; } finally { release(); } }
}
function fixture() {
  const clock = fakeClock(Date.UTC(2026, 9, 14, 12)), now = clock.now(), metadata = new Metadata(), calls = [];
  const products = Object.fromEntries(['paid', 'plus', 'ultra'].map(plan => { const id = config[`POLAR_PRODUCT_ID_${plan.toUpperCase()}`]; return [id, { id, is_archived: false, is_recurring: true, recurring_interval: 'year', recurring_interval_count: 1, organization_id: 'org', prices: [{ id: plan + '-price', product_id: id, source: 'catalog', is_archived: false, amount_type: 'fixed', price_currency: 'usd', price_amount: BILLING_PLANS[plan].annualAmount }] }]; }));
  const customer = { id: 'customer', external_id: OWNER, organization_id: 'org', deleted_at: null, active_subscriptions: [] };
  const subscription = { id: 'subscription', customer_id: customer.id, customer: { ...customer }, product_id: config.POLAR_PRODUCT_ID_PLUS, amount: BILLING_PLANS.plus.annualAmount, currency: 'usd', recurring_interval: 'year', recurring_interval_count: 1, status: 'active', current_period_start: new Date(now - 1000).toISOString(), current_period_end: new Date(now + 365 * DAY).toISOString(), cancel_at_period_end: false, ended_at: null, ends_at: null };
  const client = { products: { get: async id => { calls.push('product'); return structuredClone(products[id]); } }, customers: { getStateExternal: async () => { calls.push('customer'); return structuredClone(customer); } }, subscriptions: { get: async () => { calls.push('subscription'); return structuredClone(subscription); } } };
  const gate = new SerialGate(), service = new BillingService({ config, metadata, client, now: clock.now });
  // The account controller serializes every billing method with its gate; so does this fixture.
  const account = { webhook: event => gate.run(() => service.applyWebhook(event)), reconcile: () => gate.run(() => service.reconcile(OWNER)), entitlement: () => service.entitlement(OWNER) };
  return { clock, now, metadata, customer, subscription, client, calls, service, account, protection: () => accountRemovalProtection(metadata, OWNER, { config, now: clock.now() }) };
}
const hashOf = text => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0').repeat(8);
const event = (id, at, body = id) => ({ id, owner: OWNER, type: 'subscription.updated', bodyHash: hashOf(body), eventTimestamp: at });

test('webhook replay storm: each event id is applied exactly once and duplicates never reach the provider', async () => {
  const f = fixture(); f.customer.active_subscriptions = [{ id: f.subscription.id }];
  await f.metadata.put('owner', OWNER);
  const { account } = f, ids = Array.from({ length: 8 }, (_, i) => `evt_${i}`);
  {
    const storm = ids.flatMap(id => Array.from({ length: 6 }, () => () => account.webhook(event(id, f.now))));
    const results = await concurrently(storm);
    assert.deepEqual(tally(results, value => value.duplicate ? 'duplicate' : 'applied'), { applied: 8, duplicate: 40 });
    for (const r of results) assert.equal(r.value.plan, 'plus');
    assert.equal(f.calls.filter(c => c === 'customer').length, 8, 'one provider reconciliation per distinct event');
    assert.equal((await f.metadata.list({ prefix: 'billing/event/' })).size, 8);
    // Same id with a different body: the first recorded body wins and every other is a conflict.
    const conflicts = await concurrently(Array.from({ length: 5 }, (_, i) => () => account.webhook(event('evt_0', f.now, `tampered-${i}`))));
    assert.deepEqual(tally(conflicts), { webhook_id_conflict: 5 });
    const fresh = await concurrently([...Array.from({ length: 3 }, (_, i) => () => account.webhook(event('evt_new', f.now, `body-${i}`)))]);
    assert.deepEqual(tally(fresh, value => value.duplicate ? 'duplicate' : 'applied'), { applied: 1, webhook_id_conflict: 2 });
  }
});

test('out-of-order, delayed and duplicated webhooks across a subscription timeline follow provider state; paid history is monotonic', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  await forEachSeed(5, async random => {
    const f = fixture(); await f.metadata.put('owner', OWNER);
    const firstEnd = Date.parse(f.subscription.current_period_end);
    // Each step mutates the provider, then its webhooks arrive shuffled with redeliveries and delayed older events.
    const steps = [
      { expect: 'free', apply: () => { f.customer.active_subscriptions = []; } },
      { expect: 'plus', apply: () => { f.customer.active_subscriptions = [{ id: f.subscription.id }]; } },
      { expect: 'plus', apply: () => { f.subscription.status = 'canceled'; f.subscription.cancel_at_period_end = true; } },
      { expect: 'plus', apply: () => { f.subscription.status = 'past_due'; f.subscription.cancel_at_period_end = false; f.subscription.current_period_end = new Date(firstEnd + 365 * DAY).toISOString(); } },
      { expect: 'free', apply: () => { f.subscription.status = 'canceled'; f.subscription.ended_at = new Date(f.clock.now()).toISOString(); f.customer.active_subscriptions = []; } },
      { expect: 'free', apply: () => { f.customer.deleted_at = new Date(f.clock.now()).toISOString(); } },
    ];
    const delivered = []; let paidSeen = false, n = 0;
    for (const [index, step] of steps.entries()) {
      f.clock.advance(DAY); step.apply();
      const fresh = Array.from({ length: 1 + random.int(3) }, () => event(`evt_${n++}`, f.clock.now()));
      const replays = delivered.length ? Array.from({ length: random.int(3) }, () => random.pick(delivered)) : [];
      const delayed = Array.from({ length: random.int(2) }, () => event(`late_${n++}`, f.now - random.int(10) * DAY));
      for (const item of random.shuffle([...fresh, ...replays, ...delayed])) {
        const before = f.calls.length, stored = await f.account.entitlement(), wasDelivered = delivered.some(d => d.id === item.id), result = await f.account.webhook(item);
        // A duplicate is acknowledged from stored state; any new id (however old its timestamp) reconciles the provider's current state.
        if (wasDelivered) { assert.equal(result.duplicate, true); assert.equal(f.calls.length, before, 'a duplicate never calls the provider'); assert.equal(result.plan, stored.plan); }
        else { delivered.push(item); assert.equal(result.plan, step.expect, `step ${index} after ${item.id}`); }
        // Never paid beyond the first verified period: past_due cannot extend it.
        if (result.plan !== 'free') assert.ok(result.validUntil <= firstEnd);
        if (result.plan !== 'free') paidSeen = true;
        const protection = await f.protection();
        if (paidSeen) assert.equal(protection.status, 'paid-protected', `paid history lost at step ${index}`);
      }
    }
    assert.ok(paidSeen);
    assert.equal((await f.metadata.list({ prefix: 'billing/event/' })).size, delivered.length);
  }, { base: BASE });
});

test('webhook history stays bounded: rows expire after 35 days and capacity is exact', async () => {
  const f = fixture(); f.customer.active_subscriptions = [{ id: f.subscription.id }]; await f.metadata.put('owner', OWNER);
  for (let i = 0; i < 4095; i++) await f.metadata.put('billing/event/old_' + String(i).padStart(4, '0'), { bodyHash: '0'.repeat(64), receivedAt: f.now });
  assert.equal((await f.account.webhook(event('evt_last_slot', f.now))).duplicate, false, 'the 4096th row is admitted');
  await assert.rejects(f.account.webhook(event('evt_over', f.now)), { code: 'billing_event_capacity' });
  f.clock.set(f.now + 35 * DAY - 1); await assert.rejects(f.account.webhook(event('evt_over', f.now)), { code: 'billing_event_capacity' });
  f.clock.set(f.now + 35 * DAY); assert.equal((await f.account.webhook(event('evt_over', f.now))).duplicate, false);
  assert.ok((await f.metadata.list({ prefix: 'billing/event/' })).size <= 4096);
});

test('a provider outage mid-storm records no event, keeps the last paid deadline and stays retryable', async () => {
  const f = fixture(); f.customer.active_subscriptions = [{ id: f.subscription.id }]; await f.metadata.put('owner', OWNER);
  const paid = await f.account.reconcile();
  const real = f.client.customers.getStateExternal; let failures = 3;
  f.client.customers.getStateExternal = async () => { if (failures-- > 0) throw Object.assign(new Error('offline'), { statusCode: 503 }); return real(); };
  for (let i = 0; i < 3; i++) { await assert.rejects(f.account.webhook(event('evt_retry', f.now)), { code: 'billing_provider_unavailable' }); assert.deepEqual(await f.account.entitlement(), paid); }
  assert.equal(await f.metadata.get('billing/event/evt_retry'), undefined);
  assert.equal((await f.account.webhook(event('evt_retry', f.now))).duplicate, false);
  assert.equal((await f.account.webhook(event('evt_retry', f.now))).duplicate, true);
});
