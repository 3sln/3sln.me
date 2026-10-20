import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityAction } from '../packages/identity/index.mjs';
import { normalizeHandle, encodeFreeHandleNumber, validatePaidHandle, isReservedHandle, isFreeHandle, MAX_FREE_HANDLE_NUMBER, RESERVED_HANDLES } from '../packages/identity/handles.mjs';
import { createRandom, fakeClock } from './helpers/chaos.mjs';
import { identityEngine, activate, signupInput, sessionContext, context, memoryShards, PASSWORD } from './helpers/identity-engine.mjs';

// Engine-level identity edges: the real IdentityService dispatched through ngin
// with in-memory resources and a fake clock. Behaviour and invariants only.

test('handle grammar: free numbers round-trip, case and Crockford confusables canonicalize to one identity, bounds fail closed', () => {
  const random = createRandom(11), seen = new Map();
  for (let i = 0; i < 400; i++) {
    const number = BigInt(1 + random.int(2 ** 30)) * BigInt(1 + random.int(9000)) % MAX_FREE_HANDLE_NUMBER + 1n, handle = encodeFreeHandleNumber(number);
    assert.equal(normalizeHandle(handle), handle); assert(isFreeHandle(handle));
    const confusable = 'N.' + handle.slice(2).toUpperCase().replaceAll('0', 'O').replaceAll('1', random.pick(['I', 'L', 'i', 'l']));
    assert.equal(normalizeHandle(confusable), handle, confusable);
    if (handle.length < 11) assert.equal(normalizeHandle('n.0' + handle.slice(2)), handle, 'leading zeroes name the same number');
    if (seen.has(handle)) assert.equal(seen.get(handle), number, 'distinct numbers never share a handle'); seen.set(handle, number);
  }
  assert.equal(encodeFreeHandleNumber(MAX_FREE_HANDLE_NUMBER).length <= 11, true);
  for (const bad of [0, -1, MAX_FREE_HANDLE_NUMBER + 1n, 1.5, '01', 'x']) assert.throws(() => encodeFreeHandleNumber(bad), TypeError, String(bad));
  for (const bad of ['n.zzzzzzzzz', 'n.u', 'n.', 'n.0000000000', 'аlice', 'ａlice', ' alice', 'alice ', 'al', 'a'.repeat(33), '-alice', '_alice', 'ali.ce', 'ali@ce', null, 42])
    assert.throws(() => normalizeHandle(bad), TypeError, String(bad));
  assert.equal(normalizeHandle('ALICE-x_1'), 'alice-x_1'); assert.equal(normalizeHandle('a'.repeat(32)), 'a'.repeat(32));
  for (const name of RESERVED_HANDLES) { assert(isReservedHandle(name.toUpperCase())); assert.throws(() => validatePaidHandle(name.toUpperCase()), TypeError); }
  assert.throws(() => validatePaidHandle('N.1'), TypeError, 'paid names never enter the free namespace');
  assert.equal(validatePaidHandle('Custom-Name'), 'custom-name');
});

test('portable signup stores the canonical handle so case variants can neither duplicate nor lose an account', async () => {
  const { act, repository } = identityEngine();
  const { owner } = await activate(act, signupInput({ handle: 'Alice' }));
  assert.equal(owner.account.handle, 'alice');
  await assert.rejects(act('signup', signupInput({ handle: 'ALICE' })), { code: 'handle_unavailable' });
  assert.equal(repository.records.size, 1);
  assert.equal((await act('loginPassword', signupInput({ handle: 'aLiCe' }))).account.id, owner.account.id);
});

test('allocated free handles ignore requested names, never repeat, and log in through case/confusable variants', async () => {
  const clock = fakeClock(), shards = memoryShards(), { act } = identityEngine({ repository: shards.repository(clock.now), clock });
  const handles = [];
  for (let i = 0; i < 6; i++) { const { owner } = await activate(act, signupInput({ handle: 'alice' })); handles.push(owner.account.handle); }
  assert.equal(new Set(handles).size, handles.length); assert(handles.every(isFreeHandle));
  for (const handle of handles) {
    const variant = 'N.' + handle.slice(2).toUpperCase().replaceAll('0', 'o').replaceAll('1', 'l');
    assert.equal((await act('loginPassword', signupInput({ handle: variant }))).account.handle, handle);
  }
});

test('per-account state stays bounded: sessions, audit trail and login challenges have hard caps and evict oldest first', async () => {
  const { act, service, repository, owner } = identityEngine(), { owner: first } = await activate(act), tokens = [];
  for (let i = 0; i < 105; i++) tokens.push(await act('loginPassword', signupInput()));
  const stored = await repository.get(first.account.id);
  assert(stored.sessions.length <= 10, `sessions ${stored.sessions.length}`); assert(stored.audit.length <= 100, `audit ${stored.audit.length}`);
  for (const result of tokens.slice(-9)) assert.equal((await owner(sessionContext(result))).account.id, first.account.id);
  for (const result of [first, ...tokens.slice(0, 90)]) await assert.rejects(service.owner({}, sessionContext(result)), { code: 'unauthorized' });
  for (let i = 0; i < 12; i++) await act('beginPasskeyLogin', { handle: 'alice', turnstileToken: 'verified' });
  assert((await repository.get(first.account.id)).challenges.length <= 5);
});

test('expiry boundaries are exclusive: sessions, recent-auth and setup authority end exactly at their deadline', async () => {
  const clock = fakeClock(), { act, service, owner } = identityEngine({ clock });
  const pending = await act('signup', signupInput());
  clock.advance(1800000 - 1); const file = await act('downloadRecovery', pending);
  clock.advance(1); await assert.rejects(act('confirmRecovery', { ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true }), { code: 'unauthorized' });
  const { ownerContext, owner: session } = await activate(act, signupInput({ handle: 'bobby' }));
  clock.advance(900000 - 1); assert.deepEqual(await act('revokeOtherSessions', {}, ownerContext), { revoked: 0 });
  clock.advance(1); await assert.rejects(act('revokeOtherSessions', {}, ownerContext), { code: 'reauthentication_required' });
  clock.set(session.expiresAt - 1); assert.equal((await owner(ownerContext)).account.handle, 'bobby');
  clock.set(session.expiresAt); await assert.rejects(service.owner({}, ownerContext), { code: 'unauthorized' });
});

test('revoking other devices reports and removes only live sessions; expired ones never count', async () => {
  const clock = fakeClock(), { act, service } = identityEngine({ clock }), { owner } = await activate(act);
  await act('loginPassword', signupInput()); clock.advance(owner.expiresAt - clock.now() - 1000);
  const fresh = await act('loginPassword', signupInput()), other = await act('loginPassword', signupInput()); clock.advance(2000);
  assert.deepEqual(await act('revokeOtherSessions', {}, sessionContext(fresh)), { revoked: 1 }, 'two expired sessions are not reported as revoked');
  await assert.rejects(service.owner({}, sessionContext(other)), { code: 'unauthorized' });
  assert.equal((await service.owner({}, sessionContext(fresh))).devices.length, 1);
});

test('clock jumps fail closed: a backwards jump never extends a session or a step-up, and future-dated windows refuse sends', async () => {
  const clock = fakeClock(), { act, service } = identityEngine({ clock }), { ownerContext, owner } = await activate(act);
  await service.stepUp({ method: 'password', password: PASSWORD }, ownerContext);
  assert.ok((await service.privileged(ownerContext)).sessionId);
  clock.advance(-60000); await assert.rejects(service.privileged(ownerContext), { code: 'step_up_required' }, 'step-up dated in the future is not trusted');
  clock.advance(60000 + 300000); await assert.rejects(service.privileged(ownerContext), { code: 'step_up_required' });
  clock.advance(-86400000); assert.equal((await service.owner({}, ownerContext)).expiresAt, owner.expiresAt, 'going back in time keeps the original deadline');
  clock.set(owner.expiresAt); await assert.rejects(service.owner({}, ownerContext), { code: 'unauthorized' });
});

test('recovery tokens: malformed or cross-account proofs change nothing; a completed recovery retires the old file', async () => {
  const { act, repository } = identityEngine(), a = await activate(act), b = await activate(act, signupInput({ handle: 'bobby' }));
  const before = structuredClone([...repository.records.values()]);
  const [, secret] = a.file.recoveryToken.split('.');
  for (const recoveryToken of ['', 'x'.repeat(200), a.file.recoveryToken + 'x', `${b.owner.account.id}.${secret}`, a.file.recoveryToken.toUpperCase(), 42])
    await assert.rejects(act('recover', { recoveryToken, turnstileToken: 'verified' }), { code: 'unauthorized' });
  assert.deepEqual([...repository.records.values()], before, 'failed proofs never mutate accounts');
  const recovering = await act('recover', { recoveryToken: a.file.recoveryToken, turnstileToken: 'verified' });
  assert.equal(recovering.credentialRequired, true);
  await act('setPendingPassword', { pendingToken: recovering.pendingToken, password: 'a brand new replacement password' });
  const replacement = await act('downloadRecovery', recovering);
  await act('confirmRecovery', { pendingToken: recovering.pendingToken, recoveryToken: replacement.recoveryToken, downloadConfirmed: true });
  await assert.rejects(act('recover', { recoveryToken: a.file.recoveryToken, turnstileToken: 'verified' }), { code: 'unauthorized' }, 'old file is retired');
  await assert.rejects(act('loginPassword', signupInput()), { code: 'unauthorized' }, 'old password is gone');
  assert.equal((await act('loginPassword', signupInput({ password: 'a brand new replacement password' }))).account.id, a.owner.account.id);
  assert.equal((await act('recover', { recoveryToken: replacement.recoveryToken, turnstileToken: 'verified' })).resumed, false);
});

test('device codes: human-entered variants normalize, confusable symbols are refused, polling backs off to a cap and expiry ends the request', async () => {
  const clock = fakeClock(), { act, service } = identityEngine({ clock }), { ownerContext } = await activate(act);
  const device = { ...context, deviceBinding: 'tv-browser' }, request = await act('createDeviceLogin', { label: 'TV', turnstileToken: 'verified' }, device);
  assert.match(request.userCode, /^[2-9A-HJ-NP-Z]{8}$/);
  const spaced = request.userCode.toLowerCase().replace(/(.{4})/, '$1- ');
  assert.equal((await service.deviceRequest({ userCode: spaced }, ownerContext)).requestId, request.requestId);
  for (const userCode of ['0OOOOOOO', 'IIIIIIII', '11111111', request.userCode.slice(1), request.userCode + 'A'])
    await assert.rejects(service.deviceRequest({ userCode }, ownerContext), { code: 'invalid_device_request' });
  let interval = 0;
  for (let i = 0; i < 14; i++) { const result = await act('pollDeviceLogin', request, device); assert.equal(result.status, 'slow_down'); assert(result.interval >= interval && result.interval <= 60); interval = result.interval; }
  assert.equal(interval, 60);
  clock.advance(300000);
  assert.equal((await act('pollDeviceLogin', request, device)).status, 'expired_token');
  await assert.rejects(act('approveDeviceLogin', { requestId: request.requestId, userCode: request.userCode, accountHandle: 'alice', approved: true }, ownerContext), { code: 'invalid_device_request' });
});

test('failing guards fail closed before any account is reserved, and failed actions never announce an identity update', async () => {
  let updates = 0;
  const broken = identityEngine({ turnstile: { verify: async () => { throw new Error('challenge provider down'); } } });
  broken.engine.feed.addEventListener('identity-updated', () => updates++);
  await assert.rejects(broken.act('signup', signupInput()), /challenge provider down/);
  const limited = identityEngine({ rateLimiter: { check: async () => { throw Object.assign(new Error('limiter timeout'), { code: 'timeout' }); } } });
  await assert.rejects(limited.act('signup', signupInput()), { code: 'timeout' });
  assert.equal(broken.repository.records.size + limited.repository.records.size, 0);
  assert.equal(updates, 0);
  const working = identityEngine(); working.engine.feed.addEventListener('identity-updated', () => updates++);
  await activate(working.act); assert.equal(updates, 4);
  for (const method of ['owner', 'constructor', '__proto__', 'privileged']) assert.throws(() => new IdentityAction(method, {}, context), TypeError);
});
