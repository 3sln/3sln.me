// Engine-level tests of the core identity key registry (packages/identity/keys.mjs, slice C0): rotation with
// continuity, revocation, kid lookup after rotation, purpose separation, bounded history, custody, seeded
// concurrency (tests/helpers/chaos.mjs) and the recovery-restore boundary through the Node account runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryMessagingStore } from '../packages/core/records.mjs';
import { ContactTokenService, IdentityKeyRegistry as ReexportedRegistry } from '../packages/messaging/contact-tokens.mjs';
import { IdentityKeyRegistry, createIdentityKeyEngine, performKeyAction, readKeyQuery, EnsureIdentityKey, RotateIdentityKey, RevokeIdentityKey, RegisterIdentityKey, IdentityKeyByKid, CurrentIdentityKey, IdentityKeyHistory, verifyKeyContinuity, resolveIdentityKey, KEY_HISTORY_LIMIT } from '../packages/identity/keys.mjs';
import { encryptSecret, decryptSecret } from '../packages/runtime/secrets.mjs';
import { createScheduler, forEachSeed, fakeClock } from './helpers/chaos.mjs';
import { createNodeServer } from '../apps/node/server.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222', ISSUER = 'https://3sln.example';
const KEK = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const sealing = { seal: value => encryptSecret(value, KEK), open: value => decryptSecret(value, KEK) };
function fixture({ store = new MemoryMessagingStore(), clock = fakeClock(1800000000000), historyLimit } = {}) {
  const engine = createIdentityKeyEngine({ store, ...sealing, clock: clock.now, ...historyLimit ? { historyLimit } : {} });
  const act = (Action, input, owner = OWNER) => performKeyAction(engine, new Action({ owner, input }));
  const ask = (Query, input, owner = OWNER) => readKeyQuery(engine, new Query({ owner, input }));
  const rows = () => store.transaction(tx => tx.list(''));
  return { engine, keys: engine.identityKeys, store, clock, act, ask, rows };
}
const code = c => ({ code: c });
const signWith = async (privateKey, bytes) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes));
const verifyWith = async (publicJwk, signature, bytes) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']), signature, bytes);

test('ensure is idempotent per purpose and the engine reports changes on engineFeed', async () => {
  const f = fixture(), events = [];
  f.engine.container.feed.addEventListener('identity-keys-changed', event => events.push(event.detail));
  const first = await f.act(EnsureIdentityKey, { purpose: 'signing' }), again = await f.act(EnsureIdentityKey, { purpose: 'signing' });
  assert.equal(first.created, true); assert.deepEqual(again, { kid: first.kid, created: false });
  const encryption = await f.act(EnsureIdentityKey, { purpose: 'encryption' });
  assert.notEqual(encryption.kid, first.kid);
  const current = await f.ask(CurrentIdentityKey, { purpose: 'signing' });
  assert.equal(current.kid, first.kid); assert.equal(current.current, true); assert.equal(current.alg, 'ES256'); assert.deepEqual(Object.keys(current.publicJwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal((await f.ask(CurrentIdentityKey, { purpose: 'encryption' })).alg, 'ECDH-ES');
  assert.deepEqual(events.map(e => e.purpose), ['signing', 'signing', 'encryption']);
  await assert.rejects(f.act(EnsureIdentityKey, { purpose: 'delegate' }), code('invalid_purpose'));
});

test('signing rotation: the old key signs the new one, kid lookup still finds the retired key, stored grants survive', async () => {
  const f = fixture(), tokens = new ContactTokenService({ store: f.store, issuer: ISSUER, clock: f.clock.now });
  const { kid: oldKid } = await f.act(EnsureIdentityKey, { purpose: 'signing' }), oldSigner = await f.keys.privateKey(OWNER, 'signing');
  await f.store.transaction(tx => tx.set(`collection/${OWNER}/inbox/`, { active: true }));
  const { grant } = await tokens.createGrant(OWNER, { kid: oldKid, collections: ['inbox'], mimeTypes: ['text/plain'], expiresAt: f.clock.now() + 86400000 });
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url'), input = `${encode(grant.header)}.${encode(grant.claims)}`;
  const token = `${input}.${Buffer.from(await signWith(oldSigner.privateKey, new TextEncoder().encode(input))).toString('base64url')}`;
  assert.equal((await tokens.verify(token)).claims.jti, grant.id);
  await assert.rejects(f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: 'stale' }), code('key_conflict'));
  const rotated = await f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: oldKid });
  assert.equal(rotated.previous, oldKid); assert.notEqual(rotated.kid, oldKid);
  const old = await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: oldKid }), next = await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: rotated.kid });
  assert.equal(old.state, 'retired'); assert.equal(old.current, false); assert.equal(old.verifiable, true); assert.equal(old.successor, rotated.kid);
  assert.equal(next.current, true); assert.equal(next.predecessor, oldKid); assert.equal(next.continuity.kid, oldKid);
  assert.equal(await verifyKeyContinuity({ signer: old, next }), true);
  assert.equal(await verifyKeyContinuity({ signer: next, next }), false, 'the new key cannot vouch for itself');
  assert.equal((await f.keys.privateKey(OWNER, 'signing')).kid, rotated.kid);
  assert.equal((await tokens.verify(token)).claims.jti, grant.id, 'provider-stored grants signed before rotation stay valid');
  assert.deepEqual((await f.ask(IdentityKeyHistory, { purpose: 'signing' })).map(k => [k.kid, k.state]), [[oldKid, 'retired'], [rotated.kid, 'active']]);
  // Tampering with any bound field breaks continuity.
  for (const change of [{ kid: crypto.randomUUID() }, { predecessor: crypto.randomUUID() }, { publicJwk: old.publicJwk }, { purpose: 'encryption' }]) assert.equal(await verifyKeyContinuity({ signer: old, next: { ...next, ...change } }), false);
  const forged = { ...next.continuity, signature: Buffer.from(await signWith(oldSigner.privateKey, new TextEncoder().encode(`${next.continuity.kid}.${next.continuity.payload}`))).toString('base64url') };
  assert.equal(await verifyKeyContinuity({ signer: old, next: { ...next, continuity: forged } }), false, 'the continuity domain prefix is required');
});

test('encryption rotation is vouched for by the signing key and retains the old private key sealed', async () => {
  const f = fixture();
  const { kid: signingKid } = await f.act(EnsureIdentityKey, { purpose: 'signing' }), { kid: e0 } = await f.act(EnsureIdentityKey, { purpose: 'encryption' });
  const before = await f.keys.exportPrivate(OWNER, 'encryption');
  const { kid: e1 } = await f.act(RotateIdentityKey, { purpose: 'encryption', expectedKid: e0 });
  const next = await f.ask(IdentityKeyByKid, { purpose: 'encryption', kid: e1 }), signer = await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: signingKid });
  assert.equal(next.continuity.kid, signingKid); assert.equal(await verifyKeyContinuity({ signer, next }), true);
  assert.equal(await verifyKeyContinuity({ signer: await f.ask(IdentityKeyByKid, { purpose: 'encryption', kid: e0 }), next }), false, 'an ECDH key never signs continuity');
  const retained = (await f.rows()).find(row => row.key === `identity-key-retained/${OWNER}/${e0}/`).value;
  assert.deepEqual(await decryptSecret(retained.encrypted, KEK), before.privateJWK);
  assert.equal((await f.ask(IdentityKeyByKid, { purpose: 'encryption', kid: e0 })).state, 'retired');
  // A signing rotation in between makes a stale encryption statement unusable; the next attempt succeeds.
  const { kid: s1 } = await f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: signingKid });
  const { kid: e2 } = await f.act(RotateIdentityKey, { purpose: 'encryption', expectedKid: e1 });
  assert.equal((await f.ask(IdentityKeyByKid, { purpose: 'encryption', kid: e2 })).continuity.kid, s1);
});

test('revocation is monotonic, stops stored artifacts verifying, and revoking the current key clears it', async () => {
  const f = fixture(), tokens = new ContactTokenService({ store: f.store, issuer: ISSUER, clock: f.clock.now });
  const { kid: k0 } = await f.act(EnsureIdentityKey, { purpose: 'signing' }), { kid: k1 } = await f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: k0 });
  await f.store.transaction(tx => tx.set(`collection/${OWNER}/inbox/`, { active: true }));
  await assert.rejects(f.act(RevokeIdentityKey, { purpose: 'signing', kid: k0, reason: 'because' }), code('invalid_key'));
  await assert.rejects(f.act(RevokeIdentityKey, { purpose: 'signing', kid: 'missing' }), code('not_found'));
  await assert.rejects(f.act(RevokeIdentityKey, { purpose: 'encryption', kid: k0 }), code('not_found'), 'a signing kid is unknown under encryption');
  const revoked = await f.act(RevokeIdentityKey, { purpose: 'signing', kid: k0, reason: 'compromise' });
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.verifiable, false);
  assert.equal((await f.act(RevokeIdentityKey, { purpose: 'signing', kid: k0 })).revokedAt, revoked.revokedAt, 'idempotent');
  await assert.rejects(tokens.createGrant(OWNER, { kid: k0, collections: ['inbox'], mimeTypes: ['text/plain'], expiresAt: f.clock.now() + 86400000 }), code('invalid_key'));
  await assert.rejects(f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: k0 }), code('key_conflict'));
  await f.act(RevokeIdentityKey, { purpose: 'signing', kid: k1 });
  assert.equal(await f.keys.privateKey(OWNER, 'signing'), null); assert.equal(await f.ask(CurrentIdentityKey, { purpose: 'signing' }), null);
  assert.equal((await f.rows()).some(row => row.key === 'signing-key'), false, 'the revoked private key is dropped');
  const replacement = await f.act(EnsureIdentityKey, { purpose: 'signing' }), described = await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: replacement.kid });
  assert.equal(replacement.created, true); assert.equal(described.predecessor, null); assert.equal(described.continuity, null, 'a revoked key never vouches for its replacement');
  assert.equal((await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: k1 })).state, 'revoked', 'never resurrected');
  // Legacy delegate keeps its behaviour.
  await tokens.revokeKey(OWNER, replacement.kid); assert.equal((await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: replacement.kid })).verifiable, false);
});

test('purposes never cross: lookups, private-key usages and registry prefixes are separate', async () => {
  const f = fixture();
  const { kid: s } = await f.act(EnsureIdentityKey, { purpose: 'signing' }), { kid: e } = await f.act(EnsureIdentityKey, { purpose: 'encryption' });
  assert.equal(await f.ask(IdentityKeyByKid, { purpose: 'encryption', kid: s }), null); assert.equal(await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: e }), null);
  await assert.rejects(f.ask(IdentityKeyByKid, { kid: s }), code('invalid_purpose'));
  const signer = await f.keys.privateKey(OWNER, 'signing'), decrypter = await f.keys.privateKey(OWNER, 'encryption');
  assert.deepEqual(signer.privateKey.usages, ['sign']); assert.equal(signer.privateKey.extractable, false);
  assert.deepEqual(decrypter.privateKey.usages, ['deriveBits']); assert.equal(decrypter.privateKey.algorithm.name, 'ECDH');
  await assert.rejects(crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, decrypter.privateKey, new Uint8Array(1)));
  const rows = await f.rows();
  assert.deepEqual(rows.filter(row => row.key.startsWith('contact-key/')).map(row => row.value.kid), [s]);
  assert.deepEqual(rows.filter(row => row.key.startsWith('identity-encryption-key/')).map(row => row.value.kid), [e]);
  // Another owner's lookups never see this owner's keys, and a pointer bound to another owner is refused.
  assert.equal(await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: s }, OTHER), null);
  await assert.rejects(f.keys.privateKey(OTHER, 'signing'), code('forbidden'));
  await assert.rejects(f.act(EnsureIdentityKey, { purpose: 'signing' }, OTHER), code('forbidden'));
});

test('custody: private keys exist only sealed; public records and descriptors carry no private member', async () => {
  const f = fixture();
  const { kid: s0 } = await f.act(EnsureIdentityKey, { purpose: 'signing' }); const { kid: e0 } = await f.act(EnsureIdentityKey, { purpose: 'encryption' });
  await f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: s0 }); await f.act(RotateIdentityKey, { purpose: 'encryption', expectedKid: e0 });
  const secrets = [(await f.keys.exportPrivate(OWNER, 'signing')).privateJWK.d, (await f.keys.exportPrivate(OWNER, 'encryption')).privateJWK.d];
  const serialized = JSON.stringify(await f.rows());
  for (const d of secrets) assert.equal(serialized.includes(d), false);
  assert.equal(/"d":/.test(serialized), false);
  for (const purpose of ['signing', 'encryption']) for (const described of await f.ask(IdentityKeyHistory, { purpose })) assert.equal(JSON.stringify(described).includes('"d"'), false);
  // Without sealing the registry refuses private-key work rather than storing plaintext.
  const bare = new IdentityKeyRegistry({ store: new MemoryMessagingStore() });
  await assert.rejects(bare.ensure(OWNER, 'signing'), code('identity_keys_unavailable'));
  // Legacy registration strips everything but the public coordinates and refuses private material.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await assert.rejects(f.act(RegisterIdentityKey, { kid: 'legacy', alg: 'ES256', publicJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) }), code('invalid_key'));
  await f.act(RegisterIdentityKey, { kid: 'legacy', alg: 'ES256', publicJwk: { ...await crypto.subtle.exportKey('jwk', pair.publicKey), extra: 'x' } });
  assert.deepEqual(Object.keys((await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: 'legacy' })).publicJwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(ReexportedRegistry, IdentityKeyRegistry, 'contact-tokens re-exports the registry');
});

test('history is bounded: signing prunes revoked then retired records, encryption refuses instead of dropping keys', async () => {
  const f = fixture({ historyLimit: 3 });
  let { kid } = await f.act(EnsureIdentityKey, { purpose: 'signing' }); const first = kid;
  ({ kid } = await f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: kid }));
  await f.act(RevokeIdentityKey, { purpose: 'signing', kid: first });
  for (let i = 0; i < 4; i++) ({ kid } = await f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: kid }));
  const history = await f.ask(IdentityKeyHistory, { purpose: 'signing' });
  assert.equal(history.length, 3); assert.equal(history.at(-1).kid, kid); assert.equal(history.at(-1).current, true);
  assert.equal(history.some(k => k.kid === first), false, 'the revoked record went first');
  let { kid: e } = await f.act(EnsureIdentityKey, { purpose: 'encryption' });
  ({ kid: e } = await f.act(RotateIdentityKey, { purpose: 'encryption', expectedKid: e })); ({ kid: e } = await f.act(RotateIdentityKey, { purpose: 'encryption', expectedKid: e }));
  await assert.rejects(f.act(RotateIdentityKey, { purpose: 'encryption', expectedKid: e }), code('key_history_full'));
  assert.equal((await f.ask(CurrentIdentityKey, { purpose: 'encryption' })).kid, e, 'a refused rotation changes nothing');
  assert.equal((await f.rows()).filter(row => row.key.startsWith('identity-key-retained/')).length, 2);
  assert.equal(KEY_HISTORY_LIMIT >= 2, true);
});

test('legacy pointers without public records are backfilled once; orphaned active records retire on replacement', async () => {
  const f = fixture(), pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  await f.store.transaction(async tx => tx.set('encryption-key', { kid: 'legacy-e', encrypted: await encryptSecret(await crypto.subtle.exportKey('jwk', pair.privateKey), KEK) }));
  assert.equal(await f.ask(IdentityKeyByKid, { purpose: 'encryption', kid: 'legacy-e' }), null);
  assert.deepEqual(await f.act(EnsureIdentityKey, { purpose: 'encryption' }), { kid: 'legacy-e', created: false });
  const backfilled = await f.ask(IdentityKeyByKid, { purpose: 'encryption', kid: 'legacy-e' });
  assert.equal(backfilled.current, true); assert.equal(backfilled.publicJwk.x, (await crypto.subtle.exportKey('jwk', pair.publicKey)).x);
  await f.store.transaction(tx => tx.delete('encryption-key'));
  const fresh = await f.act(EnsureIdentityKey, { purpose: 'encryption' });
  assert.equal((await f.ask(IdentityKeyByKid, { purpose: 'encryption', kid: 'legacy-e' })).state, 'retired');
  assert.equal((await f.ask(IdentityKeyHistory, { purpose: 'encryption' })).filter(k => k.state === 'active').map(k => k.kid).join(), fresh.kid);
});

test('verification lookup: same-host resolves locally, other issuers only through the directory hook', async () => {
  const f = fixture(), { kid } = await f.act(EnsureIdentityKey, { purpose: 'signing' });
  const local = (subject, k, purpose) => f.ask(IdentityKeyByKid, { purpose, kid: k }, subject);
  assert.equal((await resolveIdentityKey({ issuer: ISSUER, subject: OWNER, kid }, { issuer: ISSUER, local })).kid, kid);
  assert.equal(await resolveIdentityKey({ issuer: ISSUER, subject: OWNER, kid, purpose: 'encryption' }, { issuer: ISSUER, local }), null);
  assert.equal(await resolveIdentityKey({ issuer: 'https://peer.example', subject: OWNER, kid }, { issuer: ISSUER, local }), null, 'no directory: unverifiable');
  const directory = { resolve: async ({ kid: k, purpose }) => ({ kid: k, purpose: purpose === 'signing' ? 'encryption' : purpose, alg: 'ES256' }) };
  assert.equal(await resolveIdentityKey({ issuer: 'https://peer.example', subject: OWNER, kid }, { issuer: ISSUER, local, directory }), null, 'a directory answer for another purpose is refused');
  const honest = { resolve: async ({ kid: k, purpose }) => ({ kid: k, purpose, alg: 'ES256' }) };
  assert.equal((await resolveIdentityKey({ issuer: 'https://peer.example', subject: OWNER, kid: 'p1' }, { issuer: ISSUER, local, directory: honest })).kid, 'p1');
});

test('seeded concurrency: rotations, revocation and ensure interleave without two current keys or stale continuity', async () => {
  await forEachSeed(25, async random => {
    const scheduler = createScheduler(random), store = new MemoryMessagingStore(), f = fixture({ store: scheduler.wrap(store, 'store') });
    const { kid: s0 } = await f.keys.ensure(OWNER, 'signing'), { kid: e0 } = await f.keys.ensure(OWNER, 'encryption');
    const results = await scheduler.run([
      () => f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: s0 }),
      () => f.act(RotateIdentityKey, { purpose: 'signing', expectedKid: s0 }),
      () => f.act(RotateIdentityKey, { purpose: 'encryption', expectedKid: e0 }),
      () => f.act(RevokeIdentityKey, { purpose: 'signing', kid: s0, reason: 'compromise' }),
      () => f.act(EnsureIdentityKey, { purpose: 'signing' }),
      () => f.ask(IdentityKeyByKid, { purpose: 'signing', kid: s0 }),
    ]);
    for (const result of results) if (result.status === 'rejected') assert.ok(['key_conflict', 'not_found', 'identity_keys_unavailable'].includes(result.reason?.code), String(result.reason?.stack ?? result.reason));
    assert.ok(results.slice(0, 2).filter(r => r.status === 'fulfilled').length <= 1, 'one rotation per expected kid');
    assert.equal((await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: s0 })).state, 'revoked', 'revocation always lands');
    for (const purpose of ['signing', 'encryption']) {
      const history = await f.ask(IdentityKeyHistory, { purpose }), current = await f.ask(CurrentIdentityKey, { purpose }), active = history.filter(k => k.state === 'active');
      assert.ok(active.length <= 1); assert.equal(active[0]?.kid ?? null, current?.kid ?? null, 'the only active record is the pointer');
      const pointer = await f.keys.privateKey(OWNER, purpose); assert.equal(pointer?.kid ?? null, current?.kid ?? null);
      for (const next of history.filter(k => k.continuity)) {
        const signer = await f.ask(IdentityKeyByKid, { purpose: 'signing', kid: next.continuity.kid });
        assert.equal(await verifyKeyContinuity({ signer, next, subject: OWNER }), signer.state !== 'revoked', 'a revoked signer vouches for nothing');
      }
    }
    const committed = new Set((await store.transaction(tx => tx.list(''))).map(row => row.value?.kid).filter(Boolean));
    for (const result of results.slice(0, 3)) if (result.status === 'fulfilled') assert.ok(committed.has(result.value.kid));
  });
});

// Recovery restore (docs/spec/recovery-identity.md): verification compares the file against the current keys,
// so rotation makes older files unusable (no rollback) and a revoked current key fails closed without new keys.
const origin = 'http://localhost:8788', password = 'Portable recovery runtime test password!', challenge = 'local-browser-test-token';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function runtime(t) {
  const directory = await mkdtemp(join(tmpdir(), 'identity-keys-runtime-')), app = await createNodeServer({ directory, config: {} });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, input) => { const response = await app.fetch(new Request(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })); return { status: response.status, value: await response.json() }; };
  const pending = (await request('/api/auth/signup', { method: 'password', password, termsAccepted: true, termsVersion: '2026-10-11', turnstileToken: challenge })).value;
  const file = (await request('/api/auth/recovery/download', { pendingToken: pending.pendingToken })).value;
  assert.equal((await request('/api/auth/recovery/confirm', { pendingToken: pending.pendingToken, recoveryToken: file.recoveryToken, downloadConfirmed: true })).status, 200);
  const id = pending.account.id, recover = () => request('/api/auth/recover', { recoveryToken: file.recoveryToken, identityBackup: JSON.parse(file.content), turnstileToken: challenge });
  return { id, controller: app.resources.accounts.get(id), recover };
}
test('restore from a recovery file made before a signing rotation is rejected; lookups report the retired key', async t => {
  const r = await runtime(t), before = await r.controller.identityKeychain(r.id, { create: false });
  const rotated = await r.controller.rotateIdentityKey(r.id, { purpose: 'signing', expectedKid: before.signing.kid });
  const after = digest(await r.controller.identityKeychain(r.id, { create: false }));
  assert.equal((await r.recover()).status, 401);
  assert.equal(digest(await r.controller.identityKeychain(r.id, { create: false })), after, 'a rejected restore never changes keys');
  assert.deepEqual(await r.controller.identitySigningKey(r.id, before.signing.kid).then(k => [k.active, k.state]), [false, 'retired']);
  assert.deepEqual(await r.controller.identitySigningKey(r.id, rotated.kid).then(k => [k.active, k.state]), [true, 'active']);
  assert.equal(await r.controller.identitySigningKey(r.id, 'unknown'), null);
  assert.equal((await r.controller.signingKey(r.id)).kid, rotated.kid);
  assert.equal((await r.controller.identityKeyHistory(r.id, { purpose: 'signing' })).length, 2);
});
test('restore after revoking the current encryption key fails closed and creates no replacement key', async t => {
  const r = await runtime(t), before = await r.controller.identityKeychain(r.id, { create: false });
  await r.controller.revokeIdentityKey(r.id, { purpose: 'encryption', kid: before.encryption.kid, reason: 'compromise' });
  const rows = digest([...await r.controller.metadata.list({})]);
  assert.equal((await r.recover()).status, 401);
  assert.equal(digest([...await r.controller.metadata.list({})]), rows, 'verification must not generate replacement keys');
  await assert.rejects(r.controller.identityKeychain(r.id, { create: false }), code('identity_keys_unavailable'));
});

test('review regressions: revoke-then-replace at full history, revoked signers, pruned kids, external keys, legacy revoked pointers', async () => {
  // Finding 1: a full encryption history still admits the replacement after a revocation.
  const f = fixture({ historyLimit: 2 });
  let { kid: e } = await f.act(EnsureIdentityKey, { purpose: 'encryption' }); await f.act(EnsureIdentityKey, { purpose: 'signing' });
  ({ kid: e } = await f.act(RotateIdentityKey, { purpose: 'encryption', expectedKid: e }));
  await f.act(RevokeIdentityKey, { purpose: 'encryption', kid: e, reason: 'compromise' });
  const replacement = await f.act(EnsureIdentityKey, { purpose: 'encryption' });
  assert.equal(replacement.created, true); assert.ok(await f.keys.exportPrivate(OWNER, 'encryption'));
  assert.equal((await f.rows()).filter(row => row.key.startsWith('identity-key-retained/')).length, 2, 'pruning a public record never drops private material');
  // Finding 2: continuity is refused from a revoked signer, for another subject, or dated after revocation.
  const g = fixture(); const { kid: s0 } = await g.act(EnsureIdentityKey, { purpose: 'signing' }); const { kid: s1 } = await g.act(RotateIdentityKey, { purpose: 'signing', expectedKid: s0 });
  const next = await g.ask(IdentityKeyByKid, { purpose: 'signing', kid: s1 }), old = await g.ask(IdentityKeyByKid, { purpose: 'signing', kid: s0 });
  assert.equal(await verifyKeyContinuity({ signer: old, next, subject: OWNER }), true);
  assert.equal(await verifyKeyContinuity({ signer: old, next, subject: OTHER }), false);
  assert.equal(await verifyKeyContinuity({ signer: { ...old, revokedAt: 0 }, next }), false);
  await g.act(RevokeIdentityKey, { purpose: 'signing', kid: s0, reason: 'compromise' });
  assert.equal(await verifyKeyContinuity({ signer: await g.ask(IdentityKeyByKid, { purpose: 'signing', kid: s0 }), next }), false);
  // Finding 3: a pruned revoked kid can never be registered again.
  const h = fixture({ historyLimit: 2 }), pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  await h.act(RegisterIdentityKey, { kid: 'ext', alg: 'ES256', publicJwk }); await h.act(RevokeIdentityKey, { purpose: 'signing', kid: 'ext', reason: 'compromise' });
  let { kid } = await h.act(EnsureIdentityKey, { purpose: 'signing' }); ({ kid } = await h.act(RotateIdentityKey, { purpose: 'signing', expectedKid: kid }));
  assert.equal(await h.ask(IdentityKeyByKid, { purpose: 'signing', kid: 'ext' }), null, 'pruned');
  await assert.rejects(h.act(RegisterIdentityKey, { kid: 'ext', alg: 'ES256', publicJwk }), code('key_exists'));
  // Finding 5: ensure never relabels an externally registered key or invents a successor.
  const x = fixture(); await x.act(RegisterIdentityKey, { kid: 'external', alg: 'ES256', publicJwk });
  const own = await x.act(EnsureIdentityKey, { purpose: 'signing' }), external = await x.ask(IdentityKeyByKid, { purpose: 'signing', kid: 'external' });
  assert.equal(external.state, 'active'); assert.equal(external.current, false); assert.equal(external.successor, null);
  assert.equal((await x.ask(CurrentIdentityKey, { purpose: 'signing' })).kid, own.kid);
  // Finding 6: a pre-C0 pointer left on a revoked record is dropped and replaced, never signed with.
  const l = fixture(), legacy = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await l.store.transaction(async tx => { await tx.set(`contact-key/${OWNER}/old/`, { owner: OWNER, kid: 'old', alg: 'ES256', publicJwk: await crypto.subtle.exportKey('jwk', legacy.publicKey), active: false }); await tx.set('signing-key', { kid: 'old', encrypted: await encryptSecret(await crypto.subtle.exportKey('jwk', legacy.privateKey), KEK) }); });
  assert.equal(await l.keys.privateKey(OWNER, 'signing'), null);
  const repaired = await l.act(EnsureIdentityKey, { purpose: 'signing' });
  assert.equal(repaired.created, true); assert.notEqual(repaired.kid, 'old'); assert.equal((await l.keys.privateKey(OWNER, 'signing')).kid, repaired.kid);
  assert.equal((await l.ask(IdentityKeyByKid, { purpose: 'signing', kid: 'old' })).state, 'revoked');
});
