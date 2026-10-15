import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { IdentityService, createArgon2Hasher, createWebAuthnAdapter, planAccountLifecycle } from '../packages/identity/index.mjs';
import { encode, decode } from '../packages/identity/crypto.mjs';

class Repository {
  records = new Map();
  async get(id) { return structuredClone(this.records.get(id)); }
  async findByHandle(handle) { return structuredClone([...this.records.values()].find(a => a.handle === handle)); }
  async findByEmail(email) { return structuredClone([...this.records.values()].find(a => a.verifiedEmail === email)); }
  async create(account) { if (this.records.has(account.id) || [...this.records.values()].some(a => a.handle === account.handle)) return false; this.records.set(account.id, structuredClone(account)); return true; }
  async compareAndSwap(id, revision, account) {
    if (this.records.get(id)?.revision !== revision || (account.verifiedEmail && [...this.records.values()].some(a => a.id !== id && a.verifiedEmail === account.verifiedEmail))) return false;
    this.records.set(id, structuredClone(account)); return true;
  }
}
class DeviceRepository {
  records = new Map();
  async get(id) { return structuredClone(this.records.get(id)); }
  async findByUserCode(code) { return structuredClone([...this.records.values()].find(value => value.userCode === code)); }
  async create(value) { if (this.records.has(value.id) || [...this.records.values()].some(record => record.userCode === value.userCode)) return false; this.records.set(value.id, structuredClone(value)); return true; }
  async compareAndSwap(id, revision, value) { if (this.records.get(id)?.revision !== revision) return false; this.records.set(id, structuredClone(value)); return true; }
}
const config = { origin: 'https://3sln.example', rpID: '3sln.example', rpName: '3sln', termsVersion: '2026-10-11' };
const context = { origin: config.origin, remoteIP: '192.0.2.1' };
const signup = { handle: 'alice', method: 'password', password: 'correct horse battery staple', termsAccepted: true, termsVersion: config.termsVersion, turnstileToken: 'verified' };
async function fixture() {
  let now = Date.now(); const messages = []; const repository = new Repository();
  const resources = { repository, deviceRequests: new DeviceRepository(), clock: () => now, config,
    turnstile: { verify: async ({ token }) => token === 'verified' }, rateLimiter: { check: async () => true },
    passwordHasher: await createArgon2Hasher(), webauthn: await createWebAuthnAdapter(),
    mailer: { sendVerification: async value => { messages.push(value); } } };
  return { service: new IdentityService(resources), repository, resources, messages, advance: ms => { now += ms; } };
}
async function activate(service, input = signup) {
  const pending = await service.signup(input, context);
  const file = await service.downloadRecovery(pending, context);
  const owner = await service.confirmRecovery({ ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true }, context);
  return { pending, file, owner, ownerContext: { ...context, sessionToken: owner.sessionToken, csrfToken: owner.csrfToken } };
}

test('signup requires Turnstile, terms and mandatory proved recovery download before activation', async () => {
  const { service, repository } = await fixture();
  await assert.rejects(service.signup({ ...signup, turnstileToken: 'invalid' }, context), { code: 'challenge_failed' });
  await assert.rejects(service.signup({ ...signup, termsAccepted: false }, context), { code: 'terms_required' });
  const pending = await service.signup(signup, context);
  await assert.rejects(service.confirmRecovery({ ...pending, downloadConfirmed: true }, context), { code: 'recovery_confirmation_required' });
  const file = await service.downloadRecovery(pending, context);
  assert.equal(JSON.parse(file.content).recoveryToken, file.recoveryToken);
  const stored = JSON.stringify(await repository.get(pending.account.id));
  assert(!stored.includes(signup.password)); assert(!stored.includes(pending.pendingToken)); assert(!stored.includes(file.recoveryToken));
  await assert.rejects(service.confirmRecovery({ ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: false }, context), { code: 'recovery_confirmation_required' });
  const owner = await service.confirmRecovery({ ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true }, context);
  assert.equal(owner.account.status, 'active');
  await assert.rejects(service.confirmRecovery({ ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true }, context), { code: 'unauthorized' });
});

test('owner sessions have exact-origin CSRF checks, expiration and hashed at-rest secrets', async () => {
  const { service, repository, advance } = await fixture(); const { owner, ownerContext } = await activate(service);
  const serialized = JSON.stringify(await repository.get(owner.account.id)); assert(!serialized.includes(owner.sessionToken));
  assert.equal((await service.owner({}, ownerContext)).account.handle, 'alice');
  await assert.rejects(service.logout({}, { ...ownerContext, origin: 'https://evil.example' }), { code: 'csrf' });
  await assert.rejects(service.logout({}, { ...ownerContext, csrfToken: 'wrong' }), { code: 'csrf' });
  advance(86400001); await assert.rejects(service.owner({}, ownerContext), { code: 'unauthorized' });
});

test('password login verifies real Argon2id and rejects unknown/wrong/pending accounts', async () => {
  const { service } = await fixture(); await activate(service);
  const logged = await service.loginPassword({ ...signup }, context); assert.equal(logged.account.handle, 'alice');
  await assert.rejects(service.loginPassword({ ...signup, password: 'this is the wrong password' }, context), { code: 'unauthorized' });
  await assert.rejects(service.loginPassword({ ...signup, handle: 'unknown' }, context), { code: 'unauthorized' });
  await service.signup({ ...signup, handle: 'pending' }, context);
  await assert.rejects(service.loginPassword({ ...signup, handle: 'pending' }, context), { code: 'unauthorized' });
});

test('recovery starts one atomic transaction and revokes old sessions, passwords and email challenges', async () => {
  const { service, repository } = await fixture(); const { file, owner, ownerContext } = await activate(service);
  const results = await Promise.allSettled([service.recover({ recoveryToken: file.recoveryToken, turnstileToken: 'verified' }, context), service.recover({ recoveryToken: file.recoveryToken, turnstileToken: 'verified' }, context)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(service.owner({}, ownerContext), { code: 'unauthorized' });
  const account = await repository.get(owner.account.id); assert.equal(account.passwordHash, null); assert.equal(account.sessions.length, 0);
  const pending = results.find(r => r.status === 'fulfilled').value;
  await assert.rejects(service.downloadRecovery(pending, context), { code: 'credential_required' });
  await service.setPendingPassword({ ...pending, password: 'new correct horse battery staple' }, context);
  const replacement = await service.downloadRecovery(pending, context);
  await service.confirmRecovery({ ...pending, recoveryToken: replacement.recoveryToken, downloadConfirmed: true }, context);
  await assert.rejects(service.recover({ recoveryToken: file.recoveryToken, turnstileToken: 'verified' }, context), { code: 'unauthorized' });
});

test('parallel activation has one winner and recovery-file reissue invalidates older files', async () => {
  const { service } = await fixture(); const pending = await service.signup(signup, context);
  const old = await service.downloadRecovery(pending, context); const fresh = await service.downloadRecovery(pending, context);
  await assert.rejects(service.confirmRecovery({ ...pending, recoveryToken: old.recoveryToken, downloadConfirmed: true }, context), { code: 'recovery_confirmation_required' });
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => service.confirmRecovery({ ...pending, recoveryToken: fresh.recoveryToken, downloadConfirmed: true }, context)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});

function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }); const id = crypto.getRandomValues(new Uint8Array(32));
  const key = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, decode(jwk.x)], [-3, decode(jwk.y)]]));
  const digest = value => createHash('sha256').update(value).digest();
  const clientData = (type, challenge, origin = config.origin, extra = {}) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
  return {
    id: encode(id),
    registration(challenge, { origin = config.origin, rpID = config.rpID, flags = 0x45, extra } = {}) {
      const data = Buffer.concat([digest(rpID), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, id.length]), id, key]);
      return { id: encode(id), rawId: encode(id), type: 'public-key', response: { clientDataJSON: encode(clientData('webauthn.create', challenge, origin, extra)), attestationObject: encode(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]))), transports: ['internal'] }, clientExtensionResults: {} };
    },
    assertion(challenge, accountId, { origin = config.origin, flags = 5, counter = 1, tamper = false, userHandle = accountId } = {}) {
      const data = Buffer.concat([digest(config.rpID), Buffer.from([flags]), Buffer.from([0, 0, 0, counter])]);
      const client = clientData('webauthn.get', challenge, origin); const signature = sign('sha256', Buffer.concat([data, digest(client)]), privateKey);
      if (tamper) signature[signature.length - 1] ^= 1;
      return { id: encode(id), rawId: encode(id), type: 'public-key', response: { clientDataJSON: encode(client), authenticatorData: encode(data), signature: encode(signature), userHandle: encode(new TextEncoder().encode(userHandle)) }, clientExtensionResults: {} };
    },
  };
}

test('real WebAuthn registration enforces challenge, origin, RP, presence, verification and top-level use', async () => {
  const { service } = await fixture(); const device = authenticator();
  const pending = await service.signup({ ...signup, method: 'passkey', password: undefined }, context);
  await assert.rejects(service.downloadRecovery(pending, context), { code: 'credential_required' });
  for (const options of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { flags: 0x41 }, { flags: 0x44 }, { extra: { crossOrigin: true } }]) {
    await assert.rejects(service.registerPasskey({ ...pending, response: device.registration(pending.registrationOptions.challenge, options) }, context), { code: 'invalid_passkey' });
  }
  await assert.rejects(service.registerPasskey({ ...pending, response: device.registration('wrong') }, context), { code: 'invalid_passkey' });
  await service.registerPasskey({ ...pending, response: device.registration(pending.registrationOptions.challenge) }, context);
  await assert.rejects(service.registerPasskey({ ...pending, response: device.registration(pending.registrationOptions.challenge) }, context), { code: 'invalid_challenge' });
});

test('real signed WebAuthn assertion rejects signatures, wrong account, UV, origin and replay', async () => {
  const { service } = await fixture(); const device = authenticator();
  const pending = await service.signup({ ...signup, method: 'passkey', password: undefined }, context);
  await service.registerPasskey({ ...pending, response: device.registration(pending.registrationOptions.challenge) }, context);
  const file = await service.downloadRecovery(pending, context);
  await service.confirmRecovery({ ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true }, context);
  const login = await service.beginPasskeyLogin({ handle: signup.handle, turnstileToken: 'verified' }, context);
  for (const options of [{ tamper: true }, { origin: 'https://evil.example' }, { flags: 1 }, { userHandle: 'different-account' }]) {
    await assert.rejects(service.finishPasskeyLogin({ challengeToken: login.challengeToken, response: device.assertion(login.authenticationOptions.challenge, pending.account.id, options) }, context), { code: 'unauthorized' });
  }
  const input = { challengeToken: login.challengeToken, response: device.assertion(login.authenticationOptions.challenge, pending.account.id) };
  const session = await service.finishPasskeyLogin(input, context); assert.equal(session.account.handle, 'alice');
  await assert.rejects(service.finishPasskeyLogin(input, context), { code: 'unauthorized' });
});

test('email linking binds owner session, tokens stay in mail only, confirmation is single-use and email login explicit', async () => {
  const { service, messages } = await fixture(); const { ownerContext } = await activate(service);
  assert.deepEqual(await service.emailStart({ email: 'Alice@MAIL.example' }, ownerContext), { sent: true });
  const token = messages[0].token;
  await assert.rejects(service.emailConfirm({ token, confirmed: false }, ownerContext), { code: 'confirmation_required' });
  const otherSession = await service.loginPassword(signup, context);
  await assert.rejects(service.emailConfirm({ token, confirmed: true }, { ...context, ...otherSession }), { code: 'invalid_challenge' });
  const linked = await service.emailConfirm({ token, confirmed: true }, ownerContext); assert.equal(linked.account.verifiedEmail, 'Alice@mail.example');
  assert.equal(linked.account.emailLoginEnabled, false);
  await assert.rejects(service.emailConfirm({ token, confirmed: true }, ownerContext), { code: 'invalid_challenge' });
  assert.deepEqual(await service.emailLoginStart({ email: 'unknown@mail.example', turnstileToken: 'verified' }, context), { sent: true });
  assert.equal(messages.length, 1);
  await service.emailLoginStart({ email: 'Alice@mail.example', turnstileToken: 'verified' }, context);
  assert.equal(messages.length, 1, 'verified contact alone cannot issue login mail');
  await service.configureEmailLogin({ enabled: true }, ownerContext);
  await service.emailLoginStart({ email: 'Alice@mail.example', turnstileToken: 'verified' }, context);
  const loginToken = messages.at(-1).token;
  await assert.rejects(service.emailLoginConfirm({ token: loginToken, confirmed: false }, context), { code: 'confirmation_required' });
  const login = await service.emailLoginConfirm({ token: loginToken, confirmed: true }, context); assert.equal(login.account.handle, 'alice');
  await assert.rejects(service.emailLoginConfirm({ token: loginToken, confirmed: true }, context), { code: 'unauthorized' });
});

test('parallel signup reserves one handle and concurrent email claims never merge owners', async () => {
  const { service, messages } = await fixture();
  const race = await Promise.allSettled([service.signup(signup, context), service.signup(signup, context)]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  const pending = race.find(r => r.status === 'fulfilled').value; const file = await service.downloadRecovery(pending, context);
  const alice = await service.confirmRecovery({ ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true }, context);
  const bob = await activate(service, { ...signup, handle: 'bob' });
  const aliceContext = { ...context, ...alice };
  await service.emailStart({ email: 'same@mail.example' }, aliceContext);
  await service.emailStart({ email: 'same@mail.example' }, bob.ownerContext);
  const claims = await Promise.allSettled([service.emailConfirm({ token: messages[0].token, confirmed: true }, aliceContext), service.emailConfirm({ token: messages[1].token, confirmed: true }, bob.ownerContext)]);
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
  assert.notEqual(alice.account.id, bob.owner.account.id);
});

test('passkey and setup expiry reject stale challenges; synced zero-counter credentials authenticate', async () => {
  const { service, advance } = await fixture(); const device = authenticator();
  const pending = await service.signup({ ...signup, method: 'passkey' }, context);
  await service.registerPasskey({ ...pending, response: device.registration(pending.registrationOptions.challenge) }, context);
  const file = await service.downloadRecovery(pending, context);
  await service.confirmRecovery({ ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true }, context);
  for (let i = 0; i < 2; i++) {
    const login = await service.beginPasskeyLogin({ handle: signup.handle, turnstileToken: 'verified' }, context);
    await service.finishPasskeyLogin({ challengeToken: login.challengeToken, response: device.assertion(login.authenticationOptions.challenge, pending.account.id, { counter: 0 }) }, context);
  }
  const stale = await service.beginPasskeyLogin({ handle: signup.handle, turnstileToken: 'verified' }, context);
  advance(300001);
  await assert.rejects(service.finishPasskeyLogin({ challengeToken: stale.challengeToken, response: device.assertion(stale.authenticationOptions.challenge, pending.account.id) }, context), { code: 'unauthorized' });
  const abandoned = await service.signup({ ...signup, handle: 'abandoned' }, context); advance(1800001);
  await assert.rejects(service.downloadRecovery(abandoned, context), { code: 'unauthorized' });
});

test('dormant lifecycle preserves no-contact accounts and requires signoff, actual notice and grace', () => {
  const day = 86400000; const account = { status: 'active', createdAt: 1, lastActiveAt: 1, sessions: [] };
  const policy = { now: 1000 * day };
  assert.equal(planAccountLifecycle(account, policy).action, 'shelve');
  account.shelvedAt = 181 * day;
  assert.equal(planAccountLifecycle(account, policy).action, 'retain-shelved');
  const approved = { ...policy,paymentProtection:{status:'unpaid'}, deletionEnabled: true, deletionSignoff: { reviewer: 'actual reviewer fixture', date: '2026-10-11', outcome: 'approved' } };
  assert.equal(planAccountLifecycle(account, approved).action, 'retain-shelved');
  account.verifiedEmail = 'owner@mail.example'; assert.equal(planAccountLifecycle(account, approved).action, 'notify');
  account.deletionNotice = { deliveredAt: 950 * day, deliveryReceipt: 'verified-test-receipt' };
  assert.equal(planAccountLifecycle(account, approved).action, 'retain-shelved');
  assert.equal(planAccountLifecycle(account, { ...approved, now: 1041 * day }).action, 'eligible-for-deletion-review');
  account.lastResourceActivityAt = 1001 * day;
  assert.equal(planAccountLifecycle(account, { ...approved, now: 1041 * day }).action, 'retain');
});

test('multiple real passkeys can be enrolled, renamed and removed with session-bound recent authorization', async () => {
  const { service } = await fixture(); const { ownerContext } = await activate(service); const first = authenticator(); const second = authenticator();
  const beginning = await service.credentialBegin({ label: 'Phone passkey' }, ownerContext);
  const anotherSession = await service.loginPassword(signup, context);
  await assert.rejects(service.credentialFinish({ challengeId: beginning.challengeId, response: first.registration(beginning.registrationOptions.challenge) }, { ...context, ...anotherSession }), { code: 'invalid_challenge' });
  await service.credentialFinish({ challengeId: beginning.challengeId, response: first.registration(beginning.registrationOptions.challenge) }, ownerContext);
  const next = await service.credentialBegin({ label: 'Security key' }, ownerContext);
  const input = { challengeId: next.challengeId, response: second.registration(next.registrationOptions.challenge) };
  const race = await Promise.allSettled([service.credentialFinish(input, ownerContext), service.credentialFinish(input, ownerContext)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  let owner = await service.owner({}, ownerContext); assert.equal(owner.credentials.length, 2); assert.equal(owner.credentials[0].label, 'Phone passkey');
  assert(!JSON.stringify(owner.credentials).includes('publicKey'));
  await assert.rejects(service.renamePasskey({ credentialId: first.id, label: 'Updated' }, { ...ownerContext, csrfToken: 'wrong' }), { code: 'csrf' });
  await service.renamePasskey({ credentialId: first.id, label: 'Personal phone' }, ownerContext);
  owner = await service.owner({}, ownerContext); assert.equal(owner.credentials[0].label, 'Personal phone');
  await service.removePasskey({ credentialId: first.id }, ownerContext); await service.removePasskey({ credentialId: second.id }, ownerContext);
  assert.equal((await service.owner({}, ownerContext)).credentials.length, 0);
});

test('last passkey cannot be removed without another login method and recovery; removed passkeys stop authenticating', async () => {
  const { service, advance } = await fixture(); const first = authenticator(); const second = authenticator();
  const pending = await service.signup({ ...signup, method: 'passkey' }, context);
  await service.registerPasskey({ ...pending, response: first.registration(pending.registrationOptions.challenge) }, context);
  const file = await service.downloadRecovery(pending, context);
  const owner = await service.confirmRecovery({ ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true }, context); const ownerContext = { ...context, ...owner };
  await assert.rejects(service.removePasskey({ credentialId: first.id }, ownerContext), { code: 'credential_required' });
  const beginning = await service.credentialBegin({ label: 'Second passkey' }, ownerContext);
  await service.credentialFinish({ challengeId: beginning.challengeId, response: second.registration(beginning.registrationOptions.challenge) }, ownerContext);
  const login = await service.beginPasskeyLogin({ handle: signup.handle, turnstileToken: 'verified' }, context);
  await service.removePasskey({ credentialId: first.id }, ownerContext);
  await assert.rejects(service.finishPasskeyLogin({ challengeToken: login.challengeToken, response: first.assertion(login.authenticationOptions.challenge, owner.account.id) }, context), { code: 'unauthorized' });
  advance(900001);
  await assert.rejects(service.credentialBegin({}, ownerContext), { code: 'reauthentication_required' });
});

test('session device lists expose stable safe IDs, targeted/all-other revocation and persisted last-use', async () => {
  const { service, repository, advance } = await fixture(); const { ownerContext, owner } = await activate(service);
  const second = await service.loginPassword({ ...signup, label: 'Laptop' }, context); const secondContext = { ...context, ...second };
  let snapshot = await service.owner({}, ownerContext); assert.equal(snapshot.devices.length, 2); assert.equal(snapshot.devices.filter(device => device.current).length, 1);
  const currentID = snapshot.devices.find(device => device.current).id; const otherID = snapshot.devices.find(device => !device.current).id;
  assert.equal((await service.owner({}, ownerContext)).devices.find(device => device.current).id, currentID);
  assert(!JSON.stringify(snapshot.devices).includes('hash')); assert(!JSON.stringify(snapshot.devices).includes('csrf')); assert(!JSON.stringify(snapshot.devices).includes(owner.sessionToken));
  advance(61000); await service.owner({}, ownerContext); assert((await repository.get(owner.account.id)).sessions.find(session => session.id === currentID).lastUsedAt > owner.account.createdAt);
  await service.revokeSession({ sessionId: otherID }, ownerContext); await assert.rejects(service.owner({}, secondContext), { code: 'unauthorized' });
  const third = await service.loginPassword(signup, context); await service.revokeOtherSessions({}, ownerContext);
  await assert.rejects(service.owner({}, { ...context, ...third }), { code: 'unauthorized' });
  assert.equal((await service.owner({}, ownerContext)).devices.length, 1);
  await service.revokeSession({ sessionId: currentID }, ownerContext); await assert.rejects(service.owner({}, ownerContext), { code: 'unauthorized' });
});

test('QR device sign-in keeps polling secrets out of QR, needs explicit matching account/code and has one handoff winner', async () => {
  const { service, resources, advance } = await fixture(); const { ownerContext } = await activate(service);
  const requesting = { ...context, deviceBinding: 'requesting-browser-cookie-secret' };
  const request = await service.createDeviceLogin({ label: 'Living room TV', turnstileToken: 'verified' }, requesting);
  assert.equal(request.userCode.length, 8); assert(!request.verificationUriComplete.includes(request.deviceCode)); assert(!request.verificationUriComplete.includes('session'));
  assert(!JSON.stringify(await resources.deviceRequests.get(request.requestId)).includes(request.deviceCode));
  await assert.rejects(service.pollDeviceLogin({ deviceCode: request.deviceCode }, { ...requesting, deviceBinding: 'wrong-cookie' }), { code: 'unauthorized' });
  assert.equal((await service.pollDeviceLogin(request, requesting)).status, 'slow_down'); advance(10000);
  assert.equal((await service.pollDeviceLogin(request, requesting)).status, 'authorization_pending');
  const inspection = await service.deviceRequest({ userCode: request.userCode }, context); assert.equal(inspection.label, 'Living room TV'); assert.equal(inspection.owner, undefined);
  const approval = { requestId: request.requestId, userCode: request.userCode, accountHandle: 'alice', approved: true };
  await assert.rejects(service.approveDeviceLogin({ ...approval, userCode: '22222222' }, ownerContext), { code: 'invalid_device_request' });
  await assert.rejects(service.approveDeviceLogin({ ...approval, accountHandle: 'different-account' }, ownerContext), { code: 'confirmation_required' });
  await assert.rejects(service.approveDeviceLogin({ ...approval, approved: false }, ownerContext), { code: 'confirmation_required' });
  await assert.rejects(service.approveDeviceLogin(approval, { ...ownerContext, origin: 'https://evil.example' }), { code: 'csrf' });
  await service.approveDeviceLogin(approval, ownerContext); advance(10000);
  const results = await Promise.all([service.pollDeviceLogin(request, requesting), service.pollDeviceLogin(request, requesting)]);
  assert.equal(results.filter(result => result.status === 'authorized').length, 1); const authorized = results.find(result => result.status === 'authorized');
  assert.equal(authorized.account.handle, 'alice');
  assert.equal((await service.owner({}, { ...context, ...authorized })).devices.find(device => device.current).label, 'Living room TV');
  assert.equal((await service.pollDeviceLogin(request, requesting)).status, 'expired_token');
});

test('device denial, cancellation, expiry and revoked approving sessions never issue owner credentials', async () => {
  const { service, advance } = await fixture(); const { ownerContext } = await activate(service);
  const create = () => service.createDeviceLogin({ label: 'New browser', turnstileToken: 'verified' }, context);
  const denied = await create(); await service.denyDeviceLogin(denied, ownerContext); assert.deepEqual(await service.pollDeviceLogin(denied, context), { status: 'access_denied' });
  const cancelled = await create(); await service.cancelDeviceLogin(cancelled, context); assert.deepEqual(await service.pollDeviceLogin(cancelled, context), { status: 'access_denied' });
  const expired = await create(); advance(300000); assert.deepEqual(await service.pollDeviceLogin(expired, context), { status: 'expired_token' });
  await assert.rejects(service.deviceRequest(expired, context), { code: 'invalid_device_request' });
  const revoked = await create(); await service.approveDeviceLogin({ ...revoked, accountHandle: 'alice', approved: true }, ownerContext);
  await service.logout({}, ownerContext); advance(5000); assert.deepEqual(await service.pollDeviceLogin(revoked, context), { status: 'access_denied' });
});

test('device handoff fails closed on session-store race, and credential revocation invalidates its login sessions', async () => {
  const { service, repository, advance } = await fixture(); const { ownerContext } = await activate(service);
  const device = authenticator(); const begin = await service.credentialBegin({}, ownerContext);
  await service.credentialFinish({ challengeId: begin.challengeId, response: device.registration(begin.registrationOptions.challenge) }, ownerContext);
  const login = await service.beginPasskeyLogin({ handle: 'alice', turnstileToken: 'verified' }, context);
  const session = await service.finishPasskeyLogin({ challengeToken: login.challengeToken, response: device.assertion(login.authenticationOptions.challenge, (await service.owner({}, ownerContext)).account.id) }, context);
  await service.removePasskey({ credentialId: device.id }, ownerContext); await assert.rejects(service.owner({}, { ...context, ...session }), { code: 'unauthorized' });
  const request = await service.createDeviceLogin({ label: 'Racing device', turnstileToken: 'verified' }, context);
  await service.approveDeviceLogin({ ...request, accountHandle: 'alice', approved: true }, ownerContext); advance(5000);
  const original = repository.compareAndSwap.bind(repository); repository.compareAndSwap = async () => false;
  await assert.rejects(service.pollDeviceLogin(request, context), { code: 'conflict' }); repository.compareAndSwap = original;
  assert.deepEqual(await service.pollDeviceLogin(request, context), { status: 'expired_token' });
});

test('invalid CAPTCHA, invalid signup fields and duplicate handles never reserve admitted global creation capacity', async () => {
  const { service, resources } = await fixture(); let admitted = 0; const phases = [];
  resources.rateLimiter.check = async input => { phases.push(input.phase); if (input.phase === 'admitted') { if (admitted >= 2) return false; admitted++; } return true; };
  for (let i = 0; i < 20; i++) await assert.rejects(service.signup({ ...signup, handle: `invalid_${i}`, turnstileToken: 'invalid' }, { ...context, remoteIP: `192.0.2.${i}` }), { code: 'challenge_failed' });
  for (const invalid of [{ handle: 'A' }, { termsAccepted: false }, { method: 'invalid' }, { password: 'short' }]) await assert.rejects(service.signup({ ...signup, ...invalid }, context));
  assert.equal(admitted, 0); assert(phases.every(phase => phase === 'attempt'));
  await service.signup(signup, context); assert.equal(admitted, 1);
  await assert.rejects(service.signup(signup, context), { code: 'handle_unavailable' }); assert.equal(admitted, 1);
  await service.signup({ ...signup, handle: 'second_valid' }, context); assert.equal(admitted, 2);
  await assert.rejects(service.signup({ ...signup, handle: 'third_valid' }, context), { code: 'rate_limited' }); assert.equal(admitted, 2);
});

test('original recovery file resumes lost responses and expired setup without resetting replacement credentials', async () => {
  const { service, repository, advance } = await fixture(); const { file, ownerContext } = await activate(service);
  const recoveryInput = { recoveryToken: file.recoveryToken, turnstileToken: 'verified' };
  const lostResponse = await service.recover(recoveryInput, context);
  const resumed = await service.recover(recoveryInput, context); assert.equal(resumed.resumed, true); assert.equal(resumed.sessionToken, undefined);
  assert.equal(resumed.account.id, lostResponse.account.id); assert.notEqual(resumed.pendingToken, lostResponse.pendingToken);
  await assert.rejects(service.downloadRecovery(lostResponse, context), { code: 'unauthorized' });
  await service.setPendingPassword({ ...resumed, password: 'replacement password must survive retry' }, context);
  const replacement = await service.downloadRecovery(resumed, context);
  const before = await repository.get(resumed.account.id); advance(1800001);
  await assert.rejects(service.downloadRecovery(resumed, context), { code: 'unauthorized' });
  const renewed = await service.recover(recoveryInput, context); assert.equal(renewed.resumed, true); assert.equal(renewed.credentialRequired, false); assert.equal(renewed.readyForRecovery, true);
  const after = await repository.get(renewed.account.id); assert.equal(after.passwordHash, before.passwordHash); assert.equal(after.recoveryHash, before.recoveryHash);
  assert(!JSON.stringify(after).includes(renewed.pendingToken)); assert(!JSON.stringify(after).includes(file.recoveryToken)); assert(!JSON.stringify(after.audit).includes('pendingToken'));
  await assert.rejects(service.owner({}, ownerContext), { code: 'unauthorized' });
  await assert.rejects(service.confirmRecovery({ ...renewed, recoveryToken: file.recoveryToken, downloadConfirmed: true }, context), { code: 'recovery_confirmation_required' });
  const activated = await service.confirmRecovery({ ...renewed, recoveryToken: replacement.recoveryToken, downloadConfirmed: true }, context);
  assert.equal(activated.account.status, 'active'); assert.equal((await repository.get(activated.account.id)).recoveryResumeHash, undefined);
  await assert.rejects(service.recover(recoveryInput, context), { code: 'unauthorized' });
  assert.equal((await service.loginPassword({ ...signup, password: 'replacement password must survive retry' }, context)).account.handle, 'alice');
});

test('verified contact requires explicit email-login opt-in; opt-out invalidates pending links and re-enable cannot revive them', async () => {
  const { service, messages, advance } = await fixture(); const { ownerContext, file } = await activate(service);
  await assert.rejects(service.configureEmailLogin({ enabled: true }, ownerContext), { code: 'verified_email_required' });
  await service.emailStart({ email: 'owner@mail.example' }, ownerContext); await service.emailConfirm({ token: messages[0].token, confirmed: true }, ownerContext);
  const start = { email: 'owner@mail.example', turnstileToken: 'verified' };
  await service.emailLoginStart(start, context); assert.equal(messages.length, 1);
  await assert.rejects(service.configureEmailLogin({ enabled: true }, { ...ownerContext, csrfToken: 'wrong' }), { code: 'csrf' });
  await service.configureEmailLogin({ enabled: true }, ownerContext); await service.emailLoginStart(start, context); const pendingToken = messages.at(-1).token;
  await service.configureEmailLogin({ enabled: false }, ownerContext);
  await assert.rejects(service.emailLoginConfirm({ token: pendingToken, confirmed: true }, context), { code: 'unauthorized' });
  await service.configureEmailLogin({ enabled: true }, ownerContext);
  await assert.rejects(service.emailLoginConfirm({ token: pendingToken, confirmed: true }, context), { code: 'unauthorized' });
  await service.emailStart({ email: 'replacement@mail.example' }, ownerContext); await service.emailConfirm({ token: messages.at(-1).token, confirmed: true }, ownerContext);
  assert.equal((await service.owner({}, ownerContext)).account.emailLoginEnabled, false);
  advance(900001); await assert.rejects(service.configureEmailLogin({ enabled: true }, ownerContext), { code: 'reauthentication_required' });
  const recovery = await service.recover({ recoveryToken: file.recoveryToken, turnstileToken: 'verified' }, context); assert.equal(recovery.account.status, 'recovering');
});
