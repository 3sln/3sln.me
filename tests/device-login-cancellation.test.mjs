import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityService } from '../packages/identity/service.mjs';

class Repository {
  records = new Map();
  async get(id) { return structuredClone(this.records.get(id)); }
  async create(value) { if (this.records.has(value.id)) return false; this.records.set(value.id, structuredClone(value)); return true; }
  async compareAndSwap(id, revision, value) {
    if (this.records.get(id)?.revision !== revision) return false;
    this.records.set(id, structuredClone(value)); return true;
  }
}
const context = { origin: 'https://bindle.example', remoteIP: '192.0.2.1', deviceBinding: 'private-browser-binding' };
async function fixture() {
  let now = 1700000000000;
  const repository = new Repository(), deviceRequests = new Repository();
  const service = new IdentityService({ repository, deviceRequests, clock: () => now,
    config: { origin: context.origin, rpID: 'bindle.example', termsVersion: 'test' },
    turnstile: { verify: async () => true }, rateLimiter: { check: async () => true }, webauthn: {}, passwordHasher: {} });
  const account = { id: service.crypto.id(), handle: 'alice', revision: 0, status: 'active', credentials: [], sessions: [], createdAt: now };
  const phone = await service.session(account, { label: 'Phone' });
  const unrelated = await service.session(account, { label: 'Another browser' });
  await repository.create(account);
  const phoneContext = { ...context, ...phone };
  const request = await service.createDeviceLogin({ label: 'Shared TV', turnstileToken: 'test' }, context);
  await service.approveDeviceLogin({ ...request, approved: true, accountHandle: 'alice' }, phoneContext);
  now += 5000;
  return { service, repository, deviceRequests, account, request, phoneContext, unrelated,
    advance: ms => { now += ms; }, poll: () => service.pollDeviceLogin(request, context), cancel: () => service.cancelDeviceLogin(request, context) };
}
function gate() {
  let signal, release;
  return { entered: new Promise(resolve => { signal = resolve; }), resume: () => release(),
    wait: async () => { signal(); await new Promise(resolve => { release = resolve; }); } };
}
async function retained(f) {
  assert.equal((await f.service.authorized(f.phoneContext)).session.label, 'Phone');
  assert.equal((await f.service.authorized(f.unrelated)).session.label, 'Another browser');
}

test('cancel fences a consumed poll before its prepared session save, even when target is absent', async () => {
  const f = await fixture(), barrier = gate();
  const swap = f.repository.compareAndSwap.bind(f.repository);
  let issuanceSaves = 0;
  f.repository.compareAndSwap = async (id, revision, value) => {
    if (value.sessions.some(s => s.deviceRequestId === f.request.requestId)) { issuanceSaves++; await barrier.wait(); }
    return swap(id, revision, value);
  };
  const poll = f.poll(); const rejection = assert.rejects(poll, { code: 'conflict' });
  await barrier.entered;
  assert.equal((await f.deviceRequests.get(f.request.requestId)).status, 'consumed');
  assert.deepEqual(await f.cancel(), { cancelled: true });
  assert.equal((await f.repository.get(f.account.id)).revision, 1);
  barrier.resume(); await rejection;
  assert.equal(issuanceSaves, 1);
  assert.equal((await f.repository.get(f.account.id)).sessions.length, 2);
  assert.equal((await f.poll()).status, 'access_denied'); await retained(f);
});

test('cancel after session save but before poll returns revokes target and suppresses authorization', async () => {
  const f = await fixture(), barrier = gate();
  const get = f.deviceRequests.get.bind(f.deviceRequests); let stopped = false;
  f.deviceRequests.get = async id => {
    if (!stopped && f.repository.records.get(f.account.id).sessions.some(s => s.deviceRequestId === id)) { stopped = true; await barrier.wait(); }
    return get(id);
  };
  const poll = f.poll(); await barrier.entered;
  assert.deepEqual(await f.cancel(), { cancelled: true });
  barrier.resume(); assert.deepEqual(await poll, { status: 'access_denied' });
  assert.equal((await f.repository.get(f.account.id)).sessions.length, 2); await retained(f);
});

test('late authorized response token becomes unusable after cancellation, with no raw token in request', async () => {
  const f = await fixture(); const result = await f.poll();
  assert.equal(result.status, 'authorized'); await f.service.authorized(result);
  const record = await f.deviceRequests.get(f.request.requestId);
  assert.equal(record.issuedSessionHash, await f.service.crypto.hash('session', result.sessionToken));
  assert(!JSON.stringify(record).includes(result.sessionToken));
  assert(!JSON.stringify(record).includes(result.csrfToken));
  assert(!JSON.stringify(record).includes(f.request.deviceCode));
  assert.deepEqual(await f.cancel(), { cancelled: true });
  await assert.rejects(f.service.authorized(result), { code: 'unauthorized' });
  assert.deepEqual(await f.cancel(), { cancelled: true }); await retained(f);
});

test('failed cleanup never reports success; cancelled linked request retries after expiry', async () => {
  const f = await fixture(), result = await f.poll();
  const swap = f.repository.compareAndSwap.bind(f.repository); let attempts = 0;
  f.repository.compareAndSwap = async () => { attempts++; return false; };
  await assert.rejects(f.cancel(), { code: 'conflict' }); assert.equal(attempts, 4);
  assert.equal((await f.deviceRequests.get(f.request.requestId)).status, 'cancelled');
  await f.service.authorized(result); // Failure is deliberately not a revocation claim.
  f.repository.compareAndSwap = swap; f.advance(300000);
  assert.deepEqual(await f.cancel(), { cancelled: true });
  await assert.rejects(f.service.authorized(result), { code: 'unauthorized' }); await retained(f);
});

test('cleanup transport uncertainty propagates and an idempotent retry finishes cleanup', async () => {
  const f = await fixture(), result = await f.poll();
  const swap = f.repository.compareAndSwap.bind(f.repository);
  f.repository.compareAndSwap = async (...args) => { await swap(...args); throw new Error('storage acknowledgement lost'); };
  await assert.rejects(f.cancel(), /acknowledgement lost/);
  f.repository.compareAndSwap = swap;
  assert.deepEqual(await f.cancel(), { cancelled: true });
  await assert.rejects(f.service.authorized(result), { code: 'unauthorized' }); await retained(f);
});

test('request CAS conflict is retried with binding intact; legacy consumed records cannot promise revocation', async () => {
  const f = await fixture(); const swap = f.deviceRequests.compareAndSwap.bind(f.deviceRequests); let first = true;
  f.deviceRequests.compareAndSwap = async (...args) => { if (first) { first = false; return false; } return swap(...args); };
  assert.deepEqual(await f.cancel(), { cancelled: true });
  const legacy = await fixture(), result = await legacy.poll();
  const record = legacy.deviceRequests.records.get(legacy.request.requestId);
  delete record.issuedSessionHash; delete record.issuedSessionId;
  assert.deepEqual(await legacy.cancel(), { cancelled: false, reason: 'session_not_linked' });
  await legacy.service.authorized(result); await retained(legacy);
});

test('cancellation still requires secret, original browser binding and exact origin', async () => {
  const f = await fixture(), result = await f.poll();
  await assert.rejects(f.service.cancelDeviceLogin(f.request, { ...context, deviceBinding: 'different' }), { code: 'unauthorized' });
  await assert.rejects(f.service.cancelDeviceLogin(f.request, { ...context, origin: 'https://other.example' }), { code: 'csrf' });
  await assert.rejects(f.service.cancelDeviceLogin({ deviceCode: `${f.request.requestId}.${'x'.repeat(43)}` }, context), { code: 'unauthorized' });
  await f.service.authorized(result);
  assert.deepEqual(await f.cancel(), { cancelled: true });
});

test('account deletion fences prepared session and cancellation does not recreate account', async () => {
  const f = await fixture(), barrier = gate(); const swap = f.repository.compareAndSwap.bind(f.repository);
  f.repository.compareAndSwap = async (...args) => { await barrier.wait(); return swap(...args); };
  const rejection = assert.rejects(f.poll(), { code: 'conflict' }); await barrier.entered;
  f.repository.records.delete(f.account.id);
  assert.deepEqual(await f.cancel(), { cancelled: true }); barrier.resume(); await rejection;
  assert.equal(await f.repository.get(f.account.id), undefined);
});

test('concurrent unrelated session creation survives targeted cancellation', async () => {
  const f = await fixture(), result = await f.poll();
  const swap = f.repository.compareAndSwap.bind(f.repository); let raced = false, other;
  f.repository.compareAndSwap = async (...args) => {
    if (!raced) {
      raced = true; const account = await f.repository.get(f.account.id), revision = account.revision;
      other = await f.service.session(account, { label: 'Concurrent browser' }); account.revision++;
      await swap(account.id, revision, account);
    }
    return swap(...args);
  };
  assert.deepEqual(await f.cancel(), { cancelled: true });
  await assert.rejects(f.service.authorized(result), { code: 'unauthorized' });
  assert.equal((await f.service.authorized(other)).session.label, 'Concurrent browser'); await retained(f);
});
