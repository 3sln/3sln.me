// Linked approval identity core (LA1): engine-level evidence for architecture §14 — codes and the HMAC index,
// signed-in resolve with generic failures and no writes, account/prefix/global guess budgets, lifetime caps and
// fresh-credential rules, "Continue as", single consume, lineage cascade atomicity, natural-expiry retention,
// eviction, the reserve → re-check race, DPoP mismatch without state change, notices and the feature flag.
import test from 'node:test';
import {lifecycleIdentityPort} from '../packages/identity/lifecycle-tombstone.mjs';
import assert from 'node:assert/strict';
import { identityEngine, activate, context, sessionContext, signupInput, config, PASSWORD, MemoryAccounts, MemoryDevices } from './helpers/identity-engine.mjs';
import { IdentityCrypto } from '../packages/identity/crypto.mjs';
import { forEachSeed, createScheduler, fakeClock } from './helpers/chaos.mjs';
import { LinkedApprovalAction, LinkedSystemAction, LinkedResolveQuery, LinkedLineageQuery, LinkedOutboxQuery, IdentityAction, MemoryLinkedLimits, globalResolveBudget, linkedLifetime, linkedDurations, linkedNetwork, LINKED } from '../packages/identity/index.mjs';

const HOUR = 3600000, DAY = 86400000, N = 20 ** 8;
const tv = { ...context, deviceBinding: 'tv-binding-'.padEnd(48, 'x') };
const appInput = (overrides = {}) => ({ reviewed: true, clientId: 'https://acme.example/client', host: 'acme.example', reviewedName: 'Acme CLI', requests: [], dpopJkt: 'J'.repeat(43), ...overrides });
function fixture(overrides = {}) {
  const notices = [], f = identityEngine({ config: { ...config, deviceAuthorizationEnabled: true, ...overrides.config }, approvalNotices: { approved: async notice => { notices.push(notice); } }, ...overrides, config: { ...config, deviceAuthorizationEnabled: true, ...overrides.config } });
  const run = async (Kind, method, input, ctx = context) => (await f.engine.dispatch(new Kind(method, input, ctx)).next('result')).detail;
  return { ...f, notices,
    la: (method, input, ctx) => run(LinkedApprovalAction, method, input, ctx), sys: (method, input, ctx) => run(LinkedSystemAction, method, input, ctx),
    resolve: (input, ctx) => f.engine.query(new LinkedResolveQuery(input, ctx)).peek(),
    live: input => f.engine.query(new LinkedLineageQuery(input)).peek(), outbox: owner => f.engine.query(new LinkedOutboxQuery({ owner })).peek(),
    login: (handle = 'alice', ip = context.remoteIP) => f.act('loginPassword', { handle, password: PASSWORD, turnstileToken: 'verified' }, { ...context, remoteIP: ip }),
    step: session => f.act('stepUp', { method: 'password', password: PASSWORD }, sessionContext(session)) };
}
const startSession = f => f.la('linkedStart', { deviceKind: 'tv', turnstileToken: 'verified' }, tv);
const startApp = (f, overrides) => f.sys('linkedStartApp', appInput(overrides), context);
const redeem = (f, request, overrides = {}) => f.sys('linkedRedeem', { deviceCode: request.deviceCode, clientId: 'https://acme.example/client', dpopJkt: 'J'.repeat(43), ...overrides }, context);
const approve = (f, request, session, extra = {}) => f.la('linkedApprove', { requestId: request.requestId, code: request.userCode, approved: true, ...extra }, sessionContext(session));
/** An app approved from a fresh credential sign-in and redeemed: the lineage under test. */
async function approvedApp(f, choice = '1h') {
  const request = await startApp(f); f.clock.advance(1000); const approver = await f.login();
  await approve(f, request, approver, { choice }); f.clock.advance(5000);
  const grant = await redeem(f, request); assert.equal(grant.status, 'approved');
  return { request, approver, grant, ref: { owner: grant.owner, lineageId: grant.lineageId, familyId: grant.familyId } };
}
async function derive(f, parent) {
  const request = await startSession(f); await approve(f, request, parent); f.clock.advance(5000);
  assert.equal((await f.la('linkedPoll', request, tv)).status, 'confirm');
  const result = await f.la('linkedAccept', request, tv); assert.equal(result.status, 'authorized'); return result;
}
const gone = (f, session) => assert.rejects(f.service.authorized(sessionContext(session)), { code: 'unauthorized' });

test('codes: base-20 from one namespace, HMAC-indexed under the server key and absent from QR locators and records', async () => {
  const f = fixture({ config: { linkedCodeKey: 'first-test-linked-code-key' } }); try {
    const { ownerContext } = await activate(f.act), session = await startSession(f), app = await startApp(f), record = await f.deviceRequests.get(session.requestId);
    for (const value of [session, app]) assert.match(value.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.equal(session.verificationUri, config.origin + '/approve'); assert.equal(session.locatorUri, `${config.origin}/approve#r=${session.requestId}`); assert.equal(app.verificationUriComplete, undefined);
    const raw = session.userCode.replace('-', '');
    assert(!JSON.stringify(record).includes(raw) && !JSON.stringify(record).includes(session.deviceCode)); assert.notEqual(record.userCodeHash, await new IdentityCrypto().hash('device-user-code', raw));
    const other = fixture({ config: { linkedCodeKey: 'second-test-linked-code-key' } }); const otherMac = await (await other.service.linkedFlow()).mac('user-code', raw); await other.engine.dispose();
    assert.notEqual(otherMac, record.userCodeHash, 'the index depends on the server key');
    assert.equal((await f.resolve({ code: session.userCode.toLowerCase().replace('-', ' ') }, ownerContext)).kind, 'session');
    assert.equal((await f.resolve({ code: app.userCode }, ownerContext)).kind, 'app', 'one namespace for both kinds');
    assert.deepEqual(linkedNetwork('2001:db8:1:2:3:4:5:6'), { narrow: '2001:db8:1:2::/64', wide: '2001:db8:1::/48', resolve: '2001:db8:1:2::/64' });
    assert.deepEqual(linkedNetwork('::ffff:192.0.2.7'), { narrow: '192.0.2.7', wide: '192.0.2.0/24', resolve: '192.0.2.0/24' });
    assert.equal(linkedNetwork('2001:db8::1::2').narrow, 'unknown');
    const keyless = fixture({ config: { linkedCodeKey: null } }); const { ownerContext: keylessOwner } = await activate(keyless.act);
    await assert.rejects(keyless.la('linkedStart', { deviceKind: 'tv', turnstileToken: 'verified' }, tv), { code: 'device_unavailable' }, 'a host without a key never invents one');
    await assert.rejects(keyless.resolve({ code: 'BCDFGHJK' }, keylessOwner), { code: 'device_unavailable' }); await keyless.engine.dispose();
  } finally { await f.engine.dispose(); }
});

test('resolve: signed-in members only, one generic invalid_code, and neither resolve nor poll writes the request', async () => {
  const f = fixture(); try {
    const { ownerContext } = await activate(f.act), request = await startSession(f);
    await assert.rejects(f.resolve({ code: request.userCode }, context), { code: 'unauthorized' });
    await assert.rejects(f.resolve({ code: request.userCode }, { ...ownerContext, origin: 'https://evil.example' }), { code: 'csrf' });
    const swap = f.deviceRequests.compareAndSwap.bind(f.deviceRequests); let writes = 0; f.deviceRequests.compareAndSwap = async (...args) => { writes++; return swap(...args); };
    const view = await f.resolve({ code: request.userCode }, ownerContext);
    assert.deepEqual(Object.keys(view).sort(), ['account', 'createdAt', 'defaultChoice', 'durations', 'expiresAt', 'freshness', 'kind', 'requestId', 'requester', 'warnings']);
    assert.deepEqual(view.requester, { deviceKind: 'tv' }); assert.deepEqual(view.warnings, { countryMismatch: false, sameBrowser: false }); assert.equal(view.defaultChoice, 'session');
    assert.equal((await f.resolve({ code: request.userCode }, { ...ownerContext, deviceBinding: tv.deviceBinding })).warnings.sameBrowser, true);
    for (let i = 0; i < 3; i++) { f.clock.advance(6000); assert.equal((await f.la('linkedPoll', request, tv)).status, 'authorization_pending'); }
    assert.equal(writes, 0, 'resolve and polls are not storage writes');
    const denied = await startSession(f); await f.la('linkedDeny', { requestId: denied.requestId, code: denied.userCode }, ownerContext);
    const expired = await startSession(f), errors = [];
    const capture = async input => { try { await f.resolve(input, ownerContext); } catch (error) { errors.push([error.code, error.message]); } };
    await capture({ code: 'BCDFBCDF' }); await capture({ code: request.userCode, locator: denied.requestId }); await capture({ code: denied.userCode }); await capture({ code: '0O1I0O1I' });
    f.clock.advance(LINKED.sessionPendingMs); await capture({ code: expired.userCode });
    assert.equal(errors.length, 5); assert.equal(new Set(errors.map(error => error.join('|'))).size, 1); assert.equal(errors[0][0], 'invalid_code');
  } finally { await f.engine.dispose(); }
});

test('brute force: account and network-prefix budgets are charged before the code is evaluated', async () => {
  const f = fixture(); try {
    const { ownerContext } = await activate(f.act), request = await startSession(f);
    for (let i = 0; i < 10; i++) await assert.rejects(f.resolve({ code: 'BCDFBCD' + 'FGHJKLMNPQ'[i] }, ownerContext), { code: 'invalid_code' });
    await assert.rejects(f.resolve({ code: request.userCode }, ownerContext), error => error.code === 'rate_limited' && error.retryAfter > 0, 'a correct guess past the budget is still refused');
    await assert.rejects(approve(f, request, ownerContext), { code: 'rate_limited' }, 'approve shares the account budget');
    f.clock.advance(1800000); const next = await startSession(f); assert.equal((await f.resolve({ code: next.userCode }, ownerContext)).requestId, next.requestId);
    // 20 attempts per /24 across accounts, then any account on that prefix waits; another prefix does not.
    const net = ip => ({ ...context, remoteIP: ip });
    const accounts = []; for (const handle of ['bob', 'carol', 'dave']) { await activate(f.act, signupInput({ handle })); accounts.push(await f.login(handle, '198.51.100.9')); }
    for (let i = 0; i < 20; i++) await assert.rejects(f.resolve({ code: 'BCDFBCDF' }, sessionContext(accounts[Math.floor(i / 9)], net(`198.51.100.${10 + i}`))), { code: 'invalid_code' });
    await assert.rejects(f.resolve({ code: next.userCode }, sessionContext(accounts[2], net('198.51.100.200'))), { code: 'rate_limited' });
    assert.equal((await f.resolve({ code: next.userCode }, sessionContext(accounts[2], net('203.0.113.5')))).requestId, next.requestId);
  } finally { await f.engine.dispose(); }
});

test('global resolve budget: sized to live codes, then a challenge per typed attempt at half the account budget, or refusal; locators keep working', async () => {
  assert.equal(globalResolveBudget(20000), 12800); assert.equal(globalResolveBudget(1000), 256000);
  for (const live of [1, 7, 1000, 20000]) assert(globalResolveBudget(live) * live / N <= 0.01);
  const clock = fakeClock(), limits = new MemoryLinkedLimits(clock.now), seen = []; const consume = limits.consume.bind(limits);
  limits.consume = async (key, window) => { if (key === 'resolve-g') seen.push(window.limit); return consume(key, window); };
  const f = fixture({ clock, linkedLimits: limits }); try {
    const { ownerContext, owner } = await activate(f.act), requests = [await startSession(f), await startSession(f), await startApp(f)];
    await assert.rejects(f.resolve({ code: 'BCDFBCDF' }, ownerContext), { code: 'invalid_code' }); assert.deepEqual(seen, [globalResolveBudget(3)]);
    await f.resolve({ code: requests[0].userCode, locator: requests[0].requestId }, ownerContext); assert.equal(seen.length, 1, 'locator resolves are outside G');
    limits.windows.set('resolve-g', { count: 1e15, end: clock.now() + DAY });
    await assert.rejects(f.resolve({ code: requests[0].userCode }, ownerContext), { code: 'challenge_required' });
    await assert.rejects(f.resolve({ code: requests[0].userCode, turnstileToken: 'forged' }, ownerContext), { code: 'challenge_required' });
    for (let i = 0; i < 5; i++) assert.equal((await f.resolve({ code: requests[1].userCode, turnstileToken: 'verified' }, ownerContext)).requestId, requests[1].requestId);
    await assert.rejects(f.resolve({ code: requests[1].userCode, turnstileToken: 'verified' }, ownerContext), { code: 'rate_limited' }, 'the per-account cap halves');
    const other = await activate(f.act, signupInput({ handle: 'erin' }));
    assert.equal((await f.resolve({ code: requests[2].userCode, locator: requests[2].requestId }, other.ownerContext)).kind, 'app');
    assert.equal(owner.account.handle, 'alice');
  } finally { await f.engine.dispose(); }
  const refusing = fixture({ config: { linkedTypedResolution: 'refused' }, linkedLimits: { consume: async key => key !== 'resolve-g' } }); try {
    const { ownerContext } = await activate(refusing.act), request = await startSession(refusing);
    await assert.rejects(refusing.resolve({ code: request.userCode, turnstileToken: 'verified' }, ownerContext), { code: 'typed_resolution_unavailable' });
    assert.equal((await refusing.resolve({ code: request.userCode, locator: request.requestId }, ownerContext)).requestId, request.requestId);
  } finally { await refusing.engine.dispose(); }
  // Without a counting limiter the live count is the global cap, the most conservative G.
  const limited = []; const conservative = fixture({ linkedLimits: { consume: async (key, window) => { if (key === 'resolve-g') limited.push(window.limit); return true; } } }); try {
    const { ownerContext } = await activate(conservative.act); await assert.rejects(conservative.resolve({ code: 'BCDFBCDF' }, ownerContext), { code: 'invalid_code' }); assert.deepEqual(limited, [12800]);
  } finally { await conservative.engine.dispose(); }
});

test('lifetime caps: session E = min(S, now+24h, U) with collapsing options; app E = min(now+30d, U), 7 d idle, 1 h default', async () => {
  const now = 1e12, S = now + 2 * HOUR, ttl = DAY;
  assert.deepEqual(linkedLifetime({ kind: 'session', choice: '1h', now, sessionExpiresAt: S, sessionTtlMs: ttl }), { expiresAt: now + HOUR });
  assert.deepEqual(linkedLifetime({ kind: 'session', choice: '8h', now, sessionExpiresAt: S, sessionTtlMs: ttl }), { expiresAt: S });
  assert.deepEqual(linkedLifetime({ kind: 'session', choice: 'session', now, sessionExpiresAt: now + 3 * DAY, sessionTtlMs: ttl }), { expiresAt: now + DAY });
  assert.deepEqual(linkedDurations({ kind: 'session', now, sessionExpiresAt: S, sessionTtlMs: ttl }).map(o => o.choice), ['1h', 'session']);
  assert.deepEqual(linkedLifetime({ kind: 'app', choice: '30d', now }), { expiresAt: now + 30 * DAY, idleExpiresAt: now + 7 * DAY });
  assert.deepEqual(linkedLifetime({ kind: 'app', choice: '1h', now }), { expiresAt: now + HOUR, idleExpiresAt: now + HOUR });
  assert.equal(linkedLifetime({ kind: 'app', choice: 'session', now }), null); assert.equal(linkedLifetime({ kind: 'session', choice: '30d', now, sessionExpiresAt: S, sessionTtlMs: ttl }), null);
  const f = fixture(); try {
    const { owner } = await activate(f.act); f.clock.advance(23 * HOUR); await f.step(owner);
    const request = await startSession(f), view = await f.resolve({ code: request.userCode }, sessionContext(owner));
    assert.deepEqual(view.durations, [{ choice: 'session', expiresAt: owner.expiresAt }], 'options reaching S collapse');
    await assert.rejects(approve(f, request, owner, { choice: '30d' }), { code: 'invalid_choice' });
    assert.equal((await approve(f, request, owner, { choice: '8h' })).expiresAt, owner.expiresAt);
    f.clock.advance(5000); await f.la('linkedPoll', request, tv); const child = await f.la('linkedAccept', request, tv);
    assert.equal(child.expiresAt, owner.expiresAt, 'a derived session never outlives its approver');
    const short = await approvedApp(f), long = await approvedApp(f, '30d'), t1 = short.grant.approvedAt, t2 = long.grant.approvedAt;
    assert.deepEqual([short.grant.expiresAt, short.grant.idleExpiresAt], [t1 + HOUR, t1 + HOUR]);
    assert.deepEqual([long.grant.expiresAt, long.grant.idleExpiresAt, long.grant.idleMs], [t2 + 30 * DAY, t2 + 7 * DAY, 7 * DAY]);
    assert(long.grant.expiresAt > long.approver.expiresAt, 'app authority is not capped by S');
  } finally { await f.engine.dispose(); }
});

test('fresh credential: session approval needs credential evidence within 5 minutes; app approval needs a sign-in made for it', async () => {
  const f = fixture(); try {
    const { owner } = await activate(f.act); f.clock.advance(LINKED.freshMs); const session = await startSession(f);
    await assert.rejects(approve(f, session, owner), { code: 'reauthentication_required' });
    assert.equal((await f.resolve({ code: session.userCode }, sessionContext(owner))).freshness.satisfied, false);
    await f.step(owner); await approve(f, session, owner);
    const early = await f.login(); f.clock.advance(1000); const app = await startApp(f);
    await assert.rejects(approve(f, app, owner), { code: 'fresh_sign_in_required' }, 'step-up alone never qualifies');
    await assert.rejects(approve(f, app, early), { code: 'fresh_sign_in_required' }, 'a sign-in from before the request does not count');
    f.clock.advance(1000); const fresh = await f.login(), view = await f.resolve({ code: app.userCode }, sessionContext(fresh));
    assert.deepEqual(view.freshness, { required: 'sign-in', satisfied: true }); assert.equal(view.defaultChoice, '1h'); assert.equal(view.app.host, 'acme.example');
    f.clock.advance(LINKED.freshMs); await assert.rejects(approve(f, app, fresh), { code: 'fresh_sign_in_required' });
    await f.step(owner); const child = await derive(f, owner); await f.step(child); f.clock.advance(1000); const app2 = await startApp(f);
    await assert.rejects(approve(f, app2, child), { code: 'fresh_sign_in_required' }, 'derived sessions cannot approve apps');
  } finally { await f.engine.dispose(); }
});

test('"Continue as": an approved session request polls `confirm` without consuming and `accept` consumes once; legacy polls still consume', async () => {
  const f = fixture(); try {
    const { owner } = await activate(f.act), request = await startSession(f); await approve(f, request, owner); f.clock.advance(5000);
    const confirm = await f.la('linkedPoll', request, tv);
    assert.deepEqual(confirm, { status: 'confirm', account: { handle: 'alice' }, expiresAt: owner.expiresAt });
    assert.equal((await f.deviceRequests.get(request.requestId)).status, 'approved');
    await assert.rejects(f.la('linkedAccept', request, { ...tv, deviceBinding: 'other-binding'.padEnd(48, 'y') }), { code: 'unauthorized' });
    const accepted = await f.la('linkedAccept', request, tv); assert.equal(accepted.status, 'authorized');
    assert.equal((await f.service.authorized(sessionContext(accepted))).session.source, 'linked-approval');
    assert.deepEqual(await f.la('linkedAccept', request, tv), { status: 'expired_token' });
    const legacy = await f.act('createDeviceLogin', { label: 'TV', turnstileToken: 'verified' }, tv);
    await f.act('approveDeviceLogin', { requestId: legacy.requestId, userCode: legacy.userCode, accountHandle: 'alice', approved: true }, sessionContext(owner)); f.clock.advance(5000);
    assert.equal((await f.act('pollDeviceLogin', legacy, tv)).status, 'authorized');
    await assert.rejects(f.la('linkedAccept', legacy, tv), { code: 'unauthorized' }, 'legacy requests keep their one-step consume');
    const notMe = await startSession(f); await approve(f, notMe, owner); assert.deepEqual(await f.la('linkedCancel', notMe, tv), { cancelled: true });
    assert.deepEqual(await f.la('linkedPoll', notMe, tv), { status: 'access_denied' });
  } finally { await f.engine.dispose(); }
});

test('chaos: single consume of session and app requests under every interleaving', async () => {
  await forEachSeed(15, async random => {
    const clock = fakeClock(), scheduler = createScheduler(random), accounts = new MemoryAccounts(), devices = new MemoryDevices();
    const f = fixture({ clock, repository: scheduler.wrap(accounts, 'accounts'), deviceRequests: scheduler.wrap(devices, 'devices'), linkedPollLimits: { consume: async () => true } });
    try {
      const { owner } = await activate(f.act), session = await startSession(f); await approve(f, session, owner);
      const app = await startApp(f); clock.advance(1000); const approver = await f.login(); await approve(f, app, approver); clock.advance(5000);
      const results = await scheduler.run([() => f.la('linkedAccept', session, tv), () => f.la('linkedAccept', session, tv), () => f.act('pollDeviceLogin', session, tv), () => f.la('linkedCancel', session, tv), () => redeem(f, app), () => redeem(f, app), () => redeem(f, app)]);
      const trace = scheduler.trace.join(' | '), value = r => r.status === 'fulfilled' ? r.value : {};
      const authorized = results.slice(0, 3).filter(r => value(r).status === 'authorized'), grants = results.slice(4).filter(r => value(r).status === 'approved');
      assert(authorized.length <= 1, `two session handoffs; ${trace}`); assert.equal(grants.length, 1, `app redeemed ${grants.length} times; ${trace}`);
      if (value(results[3]).cancelled === true) for (const r of authorized) await gone(f, r.value);
      const stored = await accounts.get(owner.account.id);
      assert.equal(stored.linkedLineage.length, 1); assert.deepEqual(stored.linkedLineage[0].families, [grants[0].value.familyId]);
      assert(stored.sessions.filter(s => s.parentSessionId).length <= (value(results[3]).cancelled === true ? 0 : 1));
    } finally { await f.engine.dispose(); }
  });
});

test('lineage cascade is atomic: one account CAS ends the session chain and moves app families to the outbox, or nothing changes', async () => {
  const accounts = new MemoryAccounts(); let failing = false; const swap = accounts.compareAndSwap.bind(accounts); let saves = 0;
  accounts.compareAndSwap = async (...args) => { saves++; if (failing) throw Object.assign(new Error('storage unavailable'), { code: 'storage_unavailable' }); return swap(...args); };
  const f = fixture({ repository: accounts }); try {
    await activate(f.act); const { approver, ref } = await approvedApp(f, '8h'); await f.step(approver);
    const child = await derive(f, approver); await f.step(child); const grandchild = await derive(f, child);
    assert.deepEqual((await f.owner(sessionContext(approver))).signOutImpact, { sessions: 2, apps: 1 });
    failing = true; await assert.rejects(f.act('logout', {}, sessionContext(approver)), { code: 'storage_unavailable' }); failing = false;
    for (const s of [approver, child, grandchild]) await f.service.authorized(sessionContext(s));
    assert.equal(await f.live(ref), true); assert.deepEqual(await f.outbox(ref.owner), []);
    saves = 0; await f.act('logout', {}, sessionContext(approver)); assert.equal(saves, 1, 'one account CAS');
    for (const s of [approver, child, grandchild]) await gone(f, s);
    assert.equal(await f.live(ref), false); assert.deepEqual((await f.outbox(ref.owner)).map(item => item.familyId), [ref.familyId]);
    assert.deepEqual(await f.sys('linkedOutboxAck', { owner: ref.owner, familyIds: ['unrelated'] }), { acknowledged: 0 });
    assert.deepEqual(await f.sys('linkedOutboxAck', { owner: ref.owner, familyIds: [ref.familyId] }), { acknowledged: 1 }); assert.deepEqual(await f.outbox(ref.owner), []);
  } finally { await f.engine.dispose(); }
});

for (const path of ['revokeSession', 'revokeOtherSessions', 'removePasskey', 'recover', 'linkedLineageRevoke', 'linkedCancelApp', 'suspension']) test(`lineage ends through ${path}`, async () => {
  const f = fixture(); try {
    const { owner, file } = await activate(f.act), { approver, ref, request } = await approvedApp(f, '30d'), unrelated = await f.login();
    if (path === 'revokeSession') await f.act(path, { sessionId: approver.sessionContext }, sessionContext(owner));
    else if (path === 'revokeOtherSessions') { await f.step(unrelated); await f.act(path, {}, sessionContext(unrelated)); }
    else if (path === 'removePasskey') { const account = await f.repository.get(ref.owner); account.credentials = [{ id: 'approver-key' }, { id: 'other-key' }]; account.sessions.find(s => s.id === approver.sessionContext).credentialId = 'approver-key'; await f.repository.compareAndSwap(account.id, account.revision, account); await f.act(path, { credentialId: 'approver-key' }, sessionContext(owner)); }
    else if (path === 'recover') { f.clock.advance(2 * DAY); assert.equal(await f.live(ref), true, 'natural expiry keeps the lineage'); await f.act('recover', { recoveryToken: file.recoveryToken, turnstileToken: 'verified' }); }
    else if (path === 'linkedLineageRevoke') assert.deepEqual(await f.sys(path, { owner: ref.owner, lineageId: ref.lineageId }), { revoked: true });
    else if (path === 'linkedCancelApp') assert.deepEqual(await f.sys(path, { deviceCode: request.deviceCode, clientId: 'https://acme.example/client', dpopJkt: 'J'.repeat(43) }), { cancelled: true });
    else { const account = await f.repository.get(ref.owner); account.status = 'suspended'; account.sessions = []; await f.repository.compareAndSwap(account.id, account.revision, account); assert.equal(await f.live(ref), false); account.status = 'active'; account.revision++; await f.repository.compareAndSwap(account.id, account.revision - 1, account); }
    assert.equal(await f.live(ref), false, 'refresh backstop fails closed');
    if (path !== 'suspension') assert.deepEqual((await f.outbox(ref.owner)).map(item => item.familyId), [ref.familyId]);
    if (['revokeSession', 'linkedLineageRevoke', 'linkedCancelApp', 'removePasskey'].includes(path)) await f.service.authorized(sessionContext(unrelated));
  } finally { await f.engine.dispose(); }
});

test('natural expiry of the approving session keeps app lineage until E; the backstop fails closed for inactive accounts and E', async () => {
  const f = fixture(); try {
    await activate(f.act); const { approver, ref } = await approvedApp(f, '30d');
    f.clock.advance(DAY + 1000); await f.login(); // prunes the naturally expired approver
    assert.equal((await f.repository.get(ref.owner)).sessions.some(s => s.id === approver.sessionContext), false);
    assert.equal(await f.live(ref), true);
    assert.equal(await f.live({ ...ref, familyId: 'another-family' }), false); assert.equal(await f.live({ ...ref, lineageId: 'another-lineage' }), false);
    await f.act('logout', {}, sessionContext(await f.login())); assert.equal(await f.live(ref), true, 'unrelated sign-out leaves it');
    f.clock.advance(30 * DAY); assert.equal(await f.live(ref), false, 'never past E');
  } finally { await f.engine.dispose(); }
});

test('eviction: the session limit prefers sessions without derived sessions or apps, protects the new session\'s ancestry, and cascades when forced', async () => {
  const f = fixture(); try {
    const { owner } = await activate(f.act); const { approver, ref } = await approvedApp(f, '8h'); await f.step(approver); const child = await derive(f, approver);
    for (let i = 0; i < 12; i++) await f.login();
    await f.service.authorized(sessionContext(approver)); await gone(f, owner); assert.equal(await f.live(ref), true, 'a session with an approved app outlives older idle ones');
    // Every other session is busy: the oldest is evicted, and its chain and lineage end in the same CAS.
    const account = await f.repository.get(ref.owner); account.linkedLineage.push(...account.sessions.filter(s => s.id !== approver.sessionContext && s.id !== child.sessionContext).map(s => ({ id: crypto.randomUUID(), sessions: [s.id], sessionExpiresAt: s.expiresAt, families: ['family-' + s.id], createdAt: f.clock.now(), expiresAt: f.clock.now() + DAY })));
    account.sessions.sort((a, b) => (a.id === approver.sessionContext ? -1 : b.id === approver.sessionContext ? 1 : 0)); await f.repository.compareAndSwap(account.id, account.revision, account);
    await f.login(); await gone(f, approver); await gone(f, child); assert.equal(await f.live(ref), false);
    assert((await f.outbox(ref.owner)).some(item => item.familyId === ref.familyId));
  } finally { await f.engine.dispose(); }
  const g = fixture(); try {
    const { ownerContext } = await activate(g.act); await g.act('logout', {}, ownerContext); const parent = await g.login(); for (let i = 0; i < 9; i++) await g.login(); await g.step(parent);
    assert.equal((await g.repository.get((await g.service.authorized(sessionContext(parent))).account.id)).sessions.length, 10);
    const child = await derive(g, parent); await g.service.authorized(sessionContext(parent)); await g.service.authorized(sessionContext(child));
  } finally { await g.engine.dispose(); }
});

test('chaos: sign-out racing redemption never leaves a live lineage under an ended session (reserve → activate → re-check)', async () => {
  await forEachSeed(20, async random => {
    const clock = fakeClock(), scheduler = createScheduler(random), accounts = new MemoryAccounts();
    const f = fixture({ clock, repository: scheduler.wrap(accounts, 'accounts') });
    try {
      await activate(f.act); const request = await startApp(f); clock.advance(1000); const approver = await f.login(); await approve(f, request, approver); clock.advance(5000);
      // LA2's token endpoint: redeem, then (family written) re-check the lineage before responding.
      const results = await scheduler.run([async () => { const grant = await redeem(f, request); return grant.status === 'approved' ? { grant, live: await f.service.linkedLineageLive({ owner: grant.owner, lineageId: grant.lineageId, familyId: grant.familyId }) } : { grant }; }, () => f.act('logout', {}, sessionContext(approver))]);
      const trace = scheduler.trace.join(' | '), token = results[0].value;
      assert.equal(results[0].status, 'fulfilled', trace);
      // A sign-out that lost the account CAS to the reservation reports a conflict and is retried by the user.
      if (results[1].status === 'rejected') { assert.equal(results[1].reason.code, 'conflict', trace); await f.act('logout', {}, sessionContext(approver)); }
      if (token.grant.status === 'approved') {
        const ref = { owner: token.grant.owner, lineageId: token.grant.lineageId, familyId: token.grant.familyId };
        assert.equal(await f.service.linkedLineageLive(ref), false, `live after sign-out; ${trace}`);
        if (token.live) assert((await f.outbox(ref.owner)).some(item => item.familyId === ref.familyId), `committed family not queued for revocation; ${trace}`);
      } else assert.equal(token.grant.status, 'access_denied', trace);
    } finally { await f.engine.dispose(); }
  });
});

test('DPoP and client mismatches answer without changing the request; pending answers are independent of resolve', async () => {
  const f = fixture(); try {
    const { ownerContext } = await activate(f.act), request = await startApp(f), before = await f.deviceRequests.get(request.requestId);
    assert.deepEqual(await redeem(f, request, { dpopJkt: 'K'.repeat(43) }), { status: 'invalid_dpop_proof' });
    assert.deepEqual(await redeem(f, request, { clientId: 'https://other.example/client' }), { status: 'invalid_grant' });
    assert.deepEqual(await redeem(f, request, { deviceCode: `${request.requestId}.${'x'.repeat(43)}` }), { status: 'invalid_grant' });
    assert.deepEqual(await redeem(f, request, { deviceCode: 'malformed' }), { status: 'invalid_grant' });
    assert.deepEqual(await f.deviceRequests.get(request.requestId), before);
    f.clock.advance(5000); const first = await redeem(f, request); await f.resolve({ code: request.userCode }, ownerContext); f.clock.advance(5000);
    assert.deepEqual(await redeem(f, request), first); assert.deepEqual(first, { status: 'authorization_pending', interval: 5 });
    assert.equal((await redeem(f, request)).status, 'slow_down');
    await f.la('linkedDeny', { requestId: request.requestId, code: request.userCode }, ownerContext); assert.deepEqual(await redeem(f, request), { status: 'access_denied' });
    const late = await startApp(f); f.clock.advance(LINKED.appPendingMs); assert.deepEqual(await redeem(f, late), { status: 'expired_token' });
  } finally { await f.engine.dispose(); }
});

test('notices go out only after approval and name only the verified host or device kind; delivery failure never blocks approval', async () => {
  let fail = false; const notices = [];
  const f = fixture({ approvalNotices: { approved: async notice => { if (fail) throw new Error('mail down'); notices.push(notice); } } }); try {
    const { owner, ownerContext } = await activate(f.act), app = await startApp(f, { reviewedName: 'Totally Your Bank', identityHint: '@alice' });
    f.clock.advance(1000); const fresh = await f.login(); assert.equal((await f.resolve({ code: app.userCode }, sessionContext(fresh))).app.preselect, true);
    const denied = await startSession(f); await f.la('linkedDeny', { requestId: denied.requestId, code: denied.userCode }, ownerContext); assert.equal(notices.length, 0);
    await approve(f, app, fresh); assert.equal(notices.length, 1);
    assert.deepEqual({ ...notices[0], subject: { ...notices[0].subject } }, { type: 'linked-approval', owner: owner.account.id, kind: 'app', subject: { host: 'acme.example' }, approvedAt: f.clock.now(), expiresAt: f.clock.now() + HOUR, consoleUrl: config.origin + '/' });
    assert(!JSON.stringify(notices).includes('Bank'));
    const session = await startSession(f); fail = true; assert.equal((await approve(f, session, owner)).approved, true); fail = false;
    const another = await startSession(f); await approve(f, another, owner); assert.deepEqual({ ...notices.at(-1).subject }, { deviceKind: 'tv' });
  } finally { await f.engine.dispose(); }
});

test('multi-account: one decision per request, and the tab\'s account context is re-verified', async () => {
  const f = fixture(); try {
    const { owner } = await activate(f.act), bob = await activate(f.act, signupInput({ handle: 'bob' })), request = await startSession(f);
    await assert.rejects(f.la('linkedApprove', { requestId: request.requestId, code: request.userCode, approved: true }, { ...sessionContext(owner), expectedOwner: bob.owner.account.id }), { code: 'account_context_conflict' });
    await approve(f, request, owner); await assert.rejects(approve(f, request, bob.owner), { code: 'conflict' });
    await assert.rejects(f.la('linkedDeny', { requestId: request.requestId, code: request.userCode }, bob.ownerContext), { code: 'conflict' });
    await assert.rejects(f.resolve({ code: request.userCode }, bob.ownerContext), { code: 'invalid_code' }, 'decided requests resolve generically');
    await assert.rejects(f.la('linkedApprove', { requestId: request.requestId, code: request.userCode, approved: true, accountHandle: 'bob' }, sessionContext(owner)), { code: 'confirmation_required' });
  } finally { await f.engine.dispose(); }
});

test('feature flag: new operations are absent and lineage checks fail closed while legacy QR sign-in works; unreviewed clients get no request', async () => {
  const off = fixture({ config: { deviceAuthorizationEnabled: false } }); try {
    const { owner, ownerContext } = await activate(off.act);
    for (const call of [() => off.la('linkedStart', { deviceKind: 'tv', turnstileToken: 'verified' }, tv), () => off.resolve({ code: 'BCDFBCDF' }, ownerContext), () => startApp(off), () => off.sys('linkedRedeem', { deviceCode: 'x' }, context)]) await assert.rejects(call(), { code: 'not_found' });
    assert.equal(await off.live({ owner: owner.account.id, lineageId: 'x', familyId: 'y' }), false);
    const legacy = await off.act('createDeviceLogin', { label: 'TV', turnstileToken: 'verified' }, tv);
    assert.match(legacy.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/); assert.equal(legacy.verificationUriComplete, `${config.origin}/device#request=${legacy.requestId}`);
    await off.act('approveDeviceLogin', { requestId: legacy.requestId, userCode: legacy.userCode, accountHandle: 'alice', approved: true }, ownerContext); off.clock.advance(5000);
    assert.equal((await off.act('pollDeviceLogin', legacy, tv)).status, 'authorized');
    assert.throws(() => new IdentityAction('linkedStart', {}, context), TypeError); assert.throws(() => new LinkedApprovalAction('linkedRedeem', {}, context), TypeError);
  } finally { await off.engine.dispose(); }
  const on = fixture(); try {
    for (const input of [appInput({ reviewed: false }), appInput({ reviewed: undefined, metadataDocument: true })]) await assert.rejects(startApp(on, input), { code: 'unauthorized_client' });
    await assert.rejects(startApp(on, { dpopJkt: 'short' }), { code: 'invalid_request' });
    await assert.rejects(on.la('linkedStart', { deviceKind: 'tv', turnstileToken: 'verified' }, context), { code: 'binding_required' });
    await assert.rejects(on.la('linkedStart', { deviceKind: 'Living room', turnstileToken: 'verified' }, tv), { code: 'invalid_device_kind' });
  } finally { await on.engine.dispose(); }
});

test('review fixes: locator approvals survive a guessed-out shared prefix; IPv6 /48 tier; mapped IPv4 parsing; unknown addresses never share one bucket', async () => {
  assert.deepEqual(linkedNetwork('::ffff:c000:0207'), linkedNetwork('192.0.2.7'));
  const keys = []; const spy = fixture({ linkedLimits: { consume: async key => { keys.push(key); return true; } } }); try {
    const { ownerContext } = await activate(spy.act); await assert.rejects(spy.resolve({ code: 'BCDFBCDF' }, { ...ownerContext, remoteIP: '2001:db8:1:2::9' }), { code: 'invalid_code' });
    assert(keys.some(key => key.startsWith('resolve-w:')), 'IPv6 typed resolves pay the /48 tier');
    keys.length = 0; await startSession(spy); const unknownStart = keys.filter(key => key.startsWith('start-')); keys.length = 0;
    await spy.la('linkedStart', { deviceKind: 'tv', turnstileToken: 'verified' }, { ...tv, remoteIP: undefined }); assert.equal(keys.filter(key => key.startsWith('start-')).length, 0); assert.equal(unknownStart.length, 2);
  } finally { await spy.engine.dispose(); }
  const f = fixture(); try {
    const { owner } = await activate(f.act), request = await startSession(f), net = ip => ({ ...context, remoteIP: ip });
    const guessers = []; for (const handle of ['gus', 'hal', 'ivy']) { await activate(f.act, signupInput({ handle })); guessers.push(await f.login(handle)); }
    for (let i = 0; i < 20; i++) await assert.rejects(f.resolve({ code: 'BCDFBCDF' }, sessionContext(guessers[Math.floor(i / 9)], net(`192.0.2.${100 + i}`))), { code: 'invalid_code' });
    await assert.rejects(f.resolve({ code: request.userCode }, sessionContext(owner)), { code: 'rate_limited' }, 'typed codes on the prefix wait');
    assert.equal((await f.resolve({ code: request.userCode, locator: request.requestId }, sessionContext(owner))).requestId, request.requestId);
    assert.equal((await approve(f, request, owner)).approved, true, 'a locator approval is not blocked by others\' guessing');
  } finally { await f.engine.dispose(); }
});

test('review fixes: a full lineage table closes redemption with access_denied before consuming; expired-but-unpruned approvers keep app lineage; no key fails closed', async () => {
  const f = fixture(); try {
    await activate(f.act); const request = await startApp(f); f.clock.advance(1000); const approver = await f.login(); await approve(f, request, approver); f.clock.advance(5000);
    const account = await f.repository.get(approver.account.id); account.linkedLineage = Array.from({ length: LINKED.lineageLimit }, (_, i) => ({ id: `l${i}`, sessions: ['x'], sessionExpiresAt: 0, families: [`f${i}`], createdAt: 0, expiresAt: f.clock.now() + DAY }));
    await f.repository.compareAndSwap(account.id, account.revision, account);
    assert.deepEqual(await redeem(f, request), { status: 'access_denied' }); assert.equal((await f.deviceRequests.get(request.requestId)).status, 'approved');
  } finally { await f.engine.dispose(); }
  const g = fixture(); try {
    await activate(g.act); const { ref, approver } = await approvedApp(g, '30d'); g.clock.advance(DAY - 10000); const other = await g.login();
    g.clock.advance(20000); assert((await g.repository.get(ref.owner)).sessions.some(s => s.id === approver.sessionContext && s.expiresAt <= g.clock.now()), 'approver expired but still stored');
    await g.act('revokeOtherSessions', {}, sessionContext(other)); assert.equal(await g.live(ref), true, 'natural expiry is deterministic');
  } finally { await g.engine.dispose(); }
  const keyless = fixture({ config: { linkedCodeKey: undefined } }); try {
    await assert.rejects(keyless.la('linkedStart', { deviceKind: 'tv', turnstileToken: 'verified' }, tv), { code: 'device_unavailable' });
  } finally { await keyless.engine.dispose(); }
});

test('lifecycle tombstone atomically revokes naturally expired app lineage and retains its durable outbox',async()=>{
 const f=fixture();try{await activate(f.act);const {ref}=await approvedApp(f,'30d');f.clock.advance(2*DAY);assert.equal(await f.live(ref),true);
 const port=lifecycleIdentityPort(f.repository,{clock:f.clock.now});await port.tombstone(ref.owner);assert.equal(await f.live(ref),false);const account=await f.repository.get(ref.owner);assert.equal(account.status,'deleted');assert.deepEqual(account.linkedLineage,undefined);assert.equal(account.lineageOutbox[0].familyId,ref.familyId);assert.deepEqual(account.sessions,[]);
 await port.tombstone(ref.owner);assert.deepEqual((await f.repository.get(ref.owner)).lineageOutbox,account.lineageOutbox);
 }finally{await f.engine.dispose();}
});
