import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeServer } from '../apps/node/server.mjs';
import { IdentityService } from '../packages/identity/service.mjs';
import { identityBackupPort } from '../packages/runtime/identity-backup.mjs';
import { verifyIdentityBackup, verifyNameAssignment } from '../packages/recovery/identity-backup.mjs';

const origin = 'http://localhost:8788';
const password = 'Portable recovery runtime test password!';
const challenge = 'local-browser-test-token';
// Compare sensitive persisted records without printing their contents on failure.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decoded = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'identity-recovery-runtime-'));
  let app = await createNodeServer({ directory, config });
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, input, headers = {}, method = 'POST') => {
    const response = await app.fetch(new Request(origin + path, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      ...input === undefined ? {} : { body: JSON.stringify(input) }
    }));
    return { response, status: response.status, value: await response.json() };
  };
  return {
    directory, request, get app() { return app; },
    async restart() { await app.close(); app = await createNodeServer({ directory, config }); },
    async signup() {
      const result = await request('/api/auth/signup', { method: 'password', password, termsAccepted: true, termsVersion: '2026-10-11', turnstileToken: challenge });
      assert.equal(result.status, 200, result.value.error);
      return result.value;
    },
    async download(pendingToken) {
      const result = await request('/api/auth/recovery/download', { pendingToken });
      assert.equal(result.status, 200, result.value.error);
      return { ...result.value, backup: JSON.parse(result.value.content) };
    },
    async activate(pendingToken, recoveryToken) {
      const result = await request('/api/auth/recovery/confirm', { pendingToken, recoveryToken, downloadConfirmed: true });
      assert.equal(result.status, 200, result.value.error);
      return { ...result.value, headers: { Cookie: result.response.headers.get('Set-Cookie').split(';')[0], 'X-CSRF-Token': result.value.csrfToken } };
    },
    async recover(file, overrides = {}) {
      return request('/api/auth/recover', { recoveryToken: file.recoveryToken, identityBackup: file.backup, turnstileToken: challenge, ...overrides });
    }
  };
}

test('durable signed recovery adopts the existing signer and preserves valid and revoked contact policy across restart and return', async t => {
  const f = await fixture(t), pending = await f.signup();
  const accountId = pending.account.id, assignedHandle = pending.account.handle;
  const originalSigner = await f.app.resources.accounts.get(accountId).signingKey(accountId);
  const file = await f.download(pending.pendingToken), backup = file.backup;
  assert.equal(backup.version, 2);
  assert.equal(backup.issuer, origin);
  assert.equal(backup.entity, accountId);
  assert.equal(backup.keychain.signing.kid, originalSigner.kid);
  assert.notEqual(backup.keychain.encryption.kid, originalSigner.kid);
  assert.notEqual(backup.keychain.encryption.privateJWK.d, backup.keychain.signing.privateJWK.d);
  for (const value of [backup, decoded(backup.proof.payload)]) {
    assert.equal(value.handle, undefined);
    assert.equal(value.nameAssignment, undefined);
    assert.equal(value.assignmentId, undefined);
  }
  const authorityPath = join(f.directory, 'recovery-signing-key');
  assert.equal((await stat(authorityPath)).mode & 0o777, 0o600);
  const authorityText = await readFile(authorityPath, 'utf8');
  const authority = JSON.parse(authorityText), { d, key_ops, ...publicKey } = authority.privateJWK;
  await verifyIdentityBackup(backup, { kid: authority.kid, publicKey }, { issuer: origin, entity: accountId });
  const owner = await f.activate(pending.pendingToken, file.recoveryToken);
  const certificateResponse = await f.request('/api/auth/handles/certificate', {}, owner.headers);
  assert.equal(certificateResponse.status, 200, certificateResponse.value.error);
  const assignment = JSON.parse(certificateResponse.value.content);
  await verifyNameAssignment(assignment, { kid: authority.kid, publicKey }, { issuer: origin, entity: accountId, handle: assignedHandle });
  for (const value of [assignment, decoded(assignment.proof.payload)]) {
    assert.equal(value.entity, accountId);
    assert.equal(value.handle, assignedHandle);
    assert.equal(value.keychain, undefined);
    assert.equal(value.recoveryToken, undefined);
    assert.equal(JSON.stringify(value).includes(backup.keychain.signing.privateJWK.d), false);
    assert.equal(JSON.stringify(value).includes(backup.keychain.encryption.privateJWK.d), false);
  }
  const snapshot = await f.request('/api/account', undefined, owner.headers, 'GET');
  assert.equal(snapshot.status, 200);
  const options = { collections: [snapshot.value.collections[0].id], mimeTypes: ['text/plain'], expiresAt: Date.now() + 86400000 };
  const active = await f.request('/api/contacts', { ...options, name: 'Keep active' }, owner.headers);
  const revoked = await f.request('/api/contacts', { ...options, name: 'Already revoked' }, owner.headers);
  assert.equal(active.status, 200, active.value.error);
  assert.equal(revoked.status, 200, revoked.value.error);
  assert.equal((await f.request('/api/contacts/' + revoked.value.id, undefined, owner.headers, 'DELETE')).status, 200);
  const inspect = async url => f.app.fetch(new Request(url, { headers: { Accept: 'application/json' } }));
  assert.equal((await inspect(active.value.url)).status, 200);
  assert.equal((await inspect(revoked.value.url)).status, 401);
  const beforeKeys = digest(await f.app.resources.accounts.get(accountId).identityKeychain(accountId, { create: false }));
  await f.restart();
  assert.equal(digest(await readFile(authorityPath, 'utf8')), digest(authorityText));
  const recovered = await f.recover(file);
  assert.equal(recovered.status, 200, recovered.value.error);
  assert.equal(recovered.value.account.id, accountId);
  assert.equal(recovered.value.account.handle, assignedHandle);
  assert.equal((await inspect(active.value.url)).status, 401, 'Recovering accounts cannot accept contact access');
  assert.equal((await f.request('/api/session', undefined, owner.headers, 'GET')).value.authenticated, false);
  const pendingToken = recovered.value.pendingToken;
  assert.equal((await f.request('/api/auth/password/pending', { pendingToken, password })).status, 200);
  const replacement = await f.download(pendingToken);
  assert.equal(digest(replacement.backup.keychain), digest(backup.keychain));
  assert.equal(replacement.backup.handle, undefined);
  assert.equal(digest(await f.app.resources.accounts.get(accountId).identityKeychain(accountId, { create: false })), beforeKeys);
  // An interrupted recovery can resume from the original signed file even after replacement issuance.
  const resumed = await f.recover(file);
  assert.equal(resumed.status, 200, resumed.value.error);
  assert.equal(resumed.value.resumed, true);
  assert.equal(resumed.value.credentialRequired, false);
  const returned = await f.activate(resumed.value.pendingToken, replacement.recoveryToken);
  assert.equal(returned.account.id, accountId);
  const returnedCertificate = await f.request('/api/auth/handles/certificate', {}, returned.headers);
  assert.equal(returnedCertificate.status, 200);
  assert.equal(JSON.parse(returnedCertificate.value.content).assignmentId, assignment.assignmentId);
  assert.equal((await inspect(active.value.url)).status, 200);
  assert.equal((await inspect(revoked.value.url)).status, 401);
  const beforeReplay = digest(await f.app.resources.repository.get(accountId));
  const replay = await f.recover(file);
  assert.equal(replay.status, 401);
  assert.equal(replay.value.error, 'unauthorized');
  assert.equal(digest(await f.app.resources.repository.get(accountId)), beforeReplay);
});

test('v2 token stripping and signature mutation reject without changing identity or key metadata', async t => {
  const f = await fixture(t), pending = await f.signup('tamperproof');
  const file = await f.download(pending.pendingToken);
  await f.activate(pending.pendingToken, file.recoveryToken);
  const controller = f.app.resources.accounts.get(pending.account.id);
  const identityBefore = digest(await f.app.resources.repository.get(pending.account.id));
  const metadataBefore = digest([...await controller.metadata.list({})]);
  const tampered = structuredClone(file.backup);
  const signature = Buffer.from(tampered.proof.signature, 'base64url'); signature[0] ^= 1;
  tampered.proof.signature = signature.toString('base64url');
  for (const identityBackup of [undefined, { version: 1, issuer: origin, handle: pending.account.handle, recoveryToken: file.recoveryToken }, tampered]) {
    const result = await f.recover(file, { identityBackup });
    assert.equal(result.status, 401);
    assert.equal(result.value.error, 'unauthorized');
    assert.equal(digest(await f.app.resources.repository.get(pending.account.id)), identityBefore);
    assert.equal(digest([...await controller.metadata.list({})]), metadataBefore);
  }
});

test('a signed file cannot reconstruct a missing account or missing identity keys', async t => {
  const f = await fixture(t), pending = await f.signup('missingstate');
  const file = await f.download(pending.pendingToken);
  await f.activate(pending.pendingToken, file.recoveryToken);
  const id = pending.account.id, controller = f.app.resources.accounts.get(id);
  const identityBefore = digest(await f.app.resources.repository.get(id));
  await controller.metadata.delete('encryption-key');
  const withoutEncryption = digest([...await controller.metadata.list({})]);
  const missingKey = await f.recover(file);
  assert.equal(missingKey.status, 401);
  assert.equal(digest([...await controller.metadata.list({})]), withoutEncryption, 'Verification must not generate replacement keys');
  assert.equal(digest(await f.app.resources.repository.get(id)), identityBefore);
  await f.app.resources.repository.metadata.delete(`account/${id}`);
  const identityRows = digest([...await f.app.resources.repository.metadata.list({})]);
  const missingAccount = await f.recover(file);
  assert.equal(missingAccount.status, 401);
  assert.equal(await f.app.resources.repository.get(id), undefined);
  assert.equal(digest([...await f.app.resources.repository.metadata.list({})]), identityRows);
  assert.equal(digest([...await controller.metadata.list({})]), withoutEncryption);
});

test('download fails closed with absent provider authority before persisting recovery or identity keys', async t => {
  const f = await fixture(t), pending = await f.signup('nosigner');
  const repository = f.app.resources.repository, accounts = f.app.resources.accounts;
  const controller = accounts.get(pending.account.id);
  const identityBefore = digest(await repository.get(pending.account.id));
  const keysBefore = digest([...await controller.metadata.list({})]);
  // Node normally provisions a durable authority. Inject the runtime port without
  // it to exercise the same absent-secret failure used by Worker deployments.
  const service = new IdentityService({ repository, identityBackup: identityBackupPort({ config: { APP_ORIGIN: origin }, accounts }),
    turnstile: {}, rateLimiter: {}, webauthn: {}, passwordHasher: {},
    config: { origin, rpID: 'localhost', termsVersion: '2026-10-11', allowInsecureLocalhost: true } });
  await assert.rejects(service.downloadRecovery({ pendingToken: pending.pendingToken }, { origin }), { code: 'recovery_unavailable' });
  assert.equal(digest(await repository.get(pending.account.id)), identityBefore);
  assert.equal(digest([...await controller.metadata.list({})]), keysBefore);
});

test('legacy recovery can resume after issuing its signed upgrade, then requires the replacement signed file', async t => {
  const f = await fixture(t), pending = await f.signup('legacyreturn');
  const file = await f.download(pending.pendingToken);
  await f.activate(pending.pendingToken, file.recoveryToken);
  const repository = f.app.resources.repository, id = pending.account.id;
  // Model an existing pre-v2 identity row: the old random token is current, but
  // no format marker or provider assignment was persisted by that version.
  const legacy = await repository.get(id);
  delete legacy.recoveryBackupVersion; delete legacy.nameAssignmentId;
  await repository.metadata.put(`account/${id}`, legacy);
  const start = await f.recover(file, { identityBackup: undefined });
  assert.equal(start.status, 200, start.value.error);
  assert.equal((await f.request('/api/auth/password/pending', { pendingToken: start.value.pendingToken, password })).status, 200);
  const replacement = await f.download(start.value.pendingToken);
  assert.equal(replacement.backup.version, 2);
  const resumed = await f.recover(file, { identityBackup: undefined });
  assert.equal(resumed.status, 200, resumed.value.error);
  assert.equal(resumed.value.resumed, true);
  assert.equal(resumed.value.credentialRequired, false);
  await f.activate(resumed.value.pendingToken, replacement.recoveryToken);
  assert.equal((await f.recover(file, { identityBackup: undefined })).status, 401);
  assert.equal((await f.recover(replacement, { identityBackup: undefined })).status, 401);
  const returned = await f.recover(replacement);
  assert.equal(returned.status, 200, returned.value.error);
  assert.equal(returned.value.account.id, id);
});

test('a retained verified-payment marker permits one numeric custom name after cancellation without replacing identity recovery', async t => {
  const f = await fixture(t, { BILLING_ENABLED: 'true', POLAR_SERVER: 'sandbox', POLAR_PRODUCT_ID_PAID: 'fixture-paid', POLAR_PRODUCT_ID_PLUS: 'fixture-plus', POLAR_PRODUCT_ID_ULTRA: 'fixture-ultra', POLAR_ACCESS_TOKEN: 'fixture-only-access', POLAR_WEBHOOK_SECRET: 'fixture-only-webhook' });
  const pending = await f.signup(), file = await f.download(pending.pendingToken), owner = await f.activate(pending.pendingToken, file.recoveryToken);
  const id = owner.account.id, controller = f.app.resources.accounts.get(id), repository = f.app.resources.repository;
  // This is a local persisted-evidence fixture. Provider-order verification is
  // covered separately; these rows do not assert a real payment occurred.
  await controller.metadata.put(`billing/ever-paid/sandbox/${id}`, { version: 1, source: 'polar', owner: id, server: 'sandbox', organizationId: 'fixture-org', plan: 'plus', productId: 'fixture-plus', orderId: 'fixture-paid-order', subscriptionId: 'fixture-ended-subscription', verifiedAt: Date.now() - 86400000 });
  await controller.metadata.put('billing/state', { owner: id, source: 'polar', plan: 'free', status: 'canceled', validUntil: Date.now() - 1000 });
  const recoveryBefore = (await repository.get(id)).recoveryHash, keychainBefore = digest(await controller.identityKeychain(id, { create: false }));
  await f.restart();
  const freshLogin=await f.request('/api/auth/login/password',{handle:owner.account.handle,password,turnstileToken:challenge});assert.equal(freshLogin.status,200,freshLogin.value.error);
  const freshHeaders={Cookie:freshLogin.response.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':freshLogin.value.csrfToken};
  const claim = await f.request('/api/auth/handles/claim', { handle: '123' }, freshHeaders);
  assert.equal(claim.status, 200, claim.value.error);
  assert.equal(claim.value.account.id, id);
  assert.equal(claim.value.account.handle, owner.account.handle);
  assert.equal(claim.value.account.paidHandle, '123');
  assert.equal((await f.app.resources.repository.get(id)).recoveryHash, recoveryBefore);
  assert.equal(digest(await f.app.resources.accounts.get(id).identityKeychain(id, { create: false })), keychainBefore);
  assert.equal((await f.request('/api/auth/handles/claim', { handle: '123' }, freshHeaders)).status, 200);
  assert.equal((await f.request('/api/auth/handles/claim', { handle: '456' }, freshHeaders)).value.error, 'handle_already_claimed');
  const authority = await f.request('/api/recovery/authority', undefined, {}, 'GET');
  assert.equal(authority.status, 200);
  const certificate = await f.request('/api/auth/handles/certificate', { handle: '123' }, freshHeaders);
  assert.equal(certificate.status, 200, certificate.value.error);
  const publicClaim = JSON.parse(certificate.value.content);
  await verifyNameAssignment(publicClaim, authority.value, { issuer: origin, entity: id, handle: '123' });
  for (const value of [publicClaim, decoded(publicClaim.proof.payload)]) {
    assert.equal(value.recoveryToken, undefined);
    assert.equal(value.keychain, undefined);
  }
  const login = await f.request('/api/auth/login/password', { handle: '123', password, turnstileToken: challenge });
  assert.equal(login.status, 200, login.value.error);
  assert.equal(login.value.account.id, id);
  const recovery = await f.recover(file);
  assert.equal(recovery.status, 200, recovery.value.error);
  assert.equal(recovery.value.account.id, id);
  assert.equal(recovery.value.account.paidHandle, '123');
});

test('equivalent Crockford login spellings share the same handle abuse window', async () => {
  const attempts = [], lookups = [];
  const service = new IdentityService({ repository: { findByHandle: async handle => { lookups.push(handle); return null; } },
    turnstile: { verify: async () => true }, rateLimiter: { check: async input => { attempts.push(input); return true; } },
    webauthn: { authenticationOptions: async () => ({ challenge: 'fixture-challenge' }) }, passwordHasher: { hash: async () => 'fixture-hash', verify: async () => false },
    config: { origin, rpID: 'localhost', termsVersion: '2026-10-11', allowInsecureLocalhost: true } });
  for (const handle of ['N.OI', 'n.0001']) {
    await assert.rejects(service.loginPassword({ handle, password, turnstileToken: challenge }, { origin }), { code: 'unauthorized' });
    await service.beginPasskeyLogin({ handle, turnstileToken: challenge }, { origin });
  }
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts.map(input => input.handle), ['n.1', 'n.1', 'n.1', 'n.1']);
  assert.deepEqual(lookups, ['n.1', 'n.1', 'n.1', 'n.1']);
});
