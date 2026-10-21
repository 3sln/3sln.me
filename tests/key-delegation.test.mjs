// IDKEYS-2 (BB-C3) key-delegation.v1, provider side (packages/identity/delegation.mjs): certificates issued here
// verify with packages/bindlebox-protocol exactly; lifetime cap; purpose limits; occupant-only issuance (failing
// closed without the port); proof of possession; rotation revoking the predecessor; revocation selectors; bounded
// history and audit; status privacy; seeded concurrency (tests/helpers/chaos.mjs); and the status endpoint's flag gate
// and cache semantics on the real Node adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryMessagingStore } from '../packages/core/records.mjs';
import { IdentityKeyRegistry, RotateIdentityKey, createIdentityKeyEngine, performKeyAction } from '../packages/identity/keys.mjs';
import { DelegationRegistry, delegationsProvider, IssueDelegation, RenewDelegation, RevokeDelegation, ReconcileDelegations, DelegationList, DelegationStatus, DELEGATION_PURPOSES, DELEGATION_TYP, POP_DOMAIN, delegationLifetime, signDelegationPop, jwkThumbprint, statusCacheControl } from '../packages/identity/delegation.mjs';
import { createAppEngine, perform, read } from '../packages/app/engine.mjs';
import { memoryAudit } from '../packages/app/providers.mjs';
import { MESSAGING_INGRESS_SLOT } from '../packages/links/types.mjs';
import * as B from '../packages/bindlebox-protocol/index.mjs';
import { encryptSecret, decryptSecret } from '../packages/runtime/secrets.mjs';
import { createScheduler, forEachSeed, fakeClock } from './helpers/chaos.mjs';
import { createNodeServer } from '../apps/node/server.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222', ISSUER = 'https://3sln.example';
const APP = 'https://box.example/client.json', EVIL = 'https://evil.example/client.json';
const ALL = Object.values(DELEGATION_PURPOSES).sort(), AUTHOR = [DELEGATION_PURPOSES.author];
const KEK = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const sealing = { seal: value => encryptSecret(value, KEK), open: value => decryptSecret(value, KEK) };
const code = c => ({ code: c });

function fixture({ store = new MemoryMessagingStore(), clock = fakeClock(1800000000000), occupant, enabled = true, account = async () => ({ status: 'active' }), ...options } = {}) {
  const keys = new IdentityKeyRegistry({ store, ...sealing, clock: clock.now });
  const signer = async owner => { await keys.ensure(owner, 'signing'); return keys.privateKey(owner, 'signing'); };
  const seat = { value: { clientId: APP, origin: 'https://box.example', ingress: 'https://box.example/ingress', cnx: 'cnx-1', purposes: ALL } };
  const port = occupant === undefined ? async ({ slot }) => (slot === MESSAGING_INGRESS_SLOT ? seat.value : null) : occupant;
  const registry = new DelegationRegistry({ store, issuer: ISSUER, signer, occupant: port, account, clock: clock.now, ...options });
  const audit = memoryAudit({ clock });
  const engine = createAppEngine({ providers: { clock, random: { uuid: () => crypto.randomUUID(), bytes: n => crypto.getRandomValues(new Uint8Array(n)) }, audit, delegations: delegationsProvider({ registry, enabled }) } });
  const app = (clientId = APP, owner = OWNER) => ({ kind: 'app', owner, clientId });
  const run = (Operation, actor, input) => { const op = new Operation({ actor, ...input === undefined ? {} : { input } }); return op instanceof DelegationList || op instanceof DelegationStatus ? read(engine, op) : perform(engine, op); };
  return { store, clock, keys, registry, engine, audit, seat, app, run, owner: { kind: 'owner', owner: OWNER }, system: { kind: 'system', owner: OWNER }, pub: (owner = OWNER) => ({ kind: 'public', owner }) };
}
async function delegateKey() { const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey); const jwk = { kty, crv, x, y }; return { ...pair, jwk, jkt: await jwkThumbprint(jwk) }; }
async function request(f, key, { purposes = ALL, clientId = APP, owner = OWNER, iat = Math.floor(f.clock.now() / 1000), lifetime } = {}) {
  return { delegate: key.jwk, purposes, proof: await signDelegationPop({ privateKey: key.privateKey, issuer: ISSUER, clientId, jkt: key.jkt, subject: owner, iat }), ...lifetime === undefined ? {} : { lifetime } };
}
async function protocolVerify(f, certificate, { purpose = DELEGATION_PURPOSES.author, now = f.clock.now(), owner = OWNER } = {}) {
  const current = await f.keys.current(owner, { purpose: 'signing' });
  const jkt = B.parseDelegation(certificate).claims.jkt;
  return B.verifyDelegation(certificate, { identityKey: { keyId: current.kid, publicJwk: current.publicJwk }, principal: { issuer: ISSUER, subject: owner }, jkt, purpose, now });
}
const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('cross-test: issued certificates verify with packages/bindlebox-protocol exactly', async () => {
  const f = fixture(), key = await delegateKey();
  assert.deepEqual(DELEGATION_PURPOSES, B.PURPOSES); assert.equal(DELEGATION_TYP, B.JWS_TYPES.delegation); assert.equal(MESSAGING_INGRESS_SLOT, B.INGRESS_SLOT);
  const issued = await f.run(IssueDelegation, f.app(), await request(f, key));
  const [header, payload] = issued.certificate.split('.').map((part, i) => i < 2 ? decode(part) : part);
  const current = await f.keys.current(OWNER, { purpose: 'signing' });
  assert.deepEqual(header, { alg: 'ES256', kid: current.kid, typ: 'bindle-key-delegation+jwt' });
  assert.deepEqual(Object.keys(payload), ['bindle', 'v', 'iss', 'sub', 'delegate', 'jkt', 'purposes', 'client', 'cnx', 'since', 'jti', 'iat', 'exp']);
  assert.deepEqual(payload.client, { client_id: APP, origin: 'https://box.example', ingress: 'https://box.example/ingress' });
  assert.equal(payload.jkt, await B.thumbprint(key.jwk)); assert.equal(payload.jkt, key.jkt);
  for (const purpose of ALL) { const verified = await protocolVerify(f, issued.certificate, { purpose }); assert.equal(verified.claims.sub, OWNER); assert.ok(verified.delegateKey); }
  assert.equal(issued.status, `${ISSUER}/identity/${OWNER}/delegations/${key.jkt}`);
  // Wrong identity key, another principal, or a tampered payload never verify.
  const other = await delegateKey();
  await assert.rejects(B.verifyDelegation(issued.certificate, { identityKey: { keyId: current.kid, publicJwk: other.jwk }, principal: { issuer: ISSUER, subject: OWNER }, jkt: key.jkt, purpose: B.PURPOSES.author, now: f.clock.now() }), code('author_unverifiable'));
  await assert.rejects(B.verifyDelegation(issued.certificate, { identityKey: { keyId: current.kid, publicJwk: current.publicJwk }, principal: { issuer: ISSUER, subject: OTHER }, jkt: key.jkt, purpose: B.PURPOSES.author, now: f.clock.now() }), code('author_unverifiable'));
  const parts = issued.certificate.split('.'), tampered = [parts[0], Buffer.from(JSON.stringify({ ...payload, exp: payload.exp - 1 })).toString('base64url'), parts[2]].join('.');
  await assert.rejects(protocolVerify(f, tampered), code('author_unverifiable'));
});

test('lifetime: host-configurable with 24 h as the maximum; apps may ask for less; unusable settings refuse', async () => {
  assert.equal(delegationLifetime(undefined), 86400); assert.equal(delegationLifetime('3600'), 3600); assert.equal(delegationLifetime(10 ** 7), 86400);
  for (const bad of ['abc', '60', -1, 1.5, '1e5']) assert.equal(delegationLifetime(bad), null, String(bad));
  const span = issued => issued.exp - issued.iat;
  for (const [setting, asked, expected] of [[undefined, undefined, 86400], ['999999', undefined, 86400], ['3600', undefined, 3600], [undefined, 600, 600], ['3600', 86400, 3600]]) {
    const f = fixture({ lifetime: setting }), key = await delegateKey();
    const issued = await f.run(IssueDelegation, f.app(), await request(f, key, { lifetime: asked }));
    assert.equal(span(issued), expected, `${setting}/${asked}`);
    await protocolVerify(f, issued.certificate);
    // Expired by the protocol's ±60 s rule just after exp.
    await assert.rejects(protocolVerify(f, issued.certificate, { now: (issued.exp + 61) * 1000 }), code('author_unverifiable'));
  }
  const f = fixture(), key = await delegateKey();
  await assert.rejects(f.run(IssueDelegation, f.app(), await request(f, key, { lifetime: 299 })), code('invalid_request'));
  for (const setting of ['abc', '120']) { const g = fixture({ lifetime: setting }); await assert.rejects(g.run(IssueDelegation, g.app(), await request(g, await delegateKey())), code('delegation_unavailable')); }
});

test('purposes: only recognized, consented, ascending purposes; the certificate carries exactly those', async () => {
  const f = fixture(), key = await delegateKey();
  for (const purposes of [[], ['https://spec.bindle.example/bindlebox/v1/purposes/admin'], [...ALL].reverse(), [DELEGATION_PURPOSES.author, DELEGATION_PURPOSES.author], 'author'])
    await assert.rejects(f.run(IssueDelegation, f.app(), await request(f, key, { purposes })), code('invalid_request'), JSON.stringify(purposes));
  f.seat.value = { ...f.seat.value, purposes: AUTHOR };
  await assert.rejects(f.run(IssueDelegation, f.app(), await request(f, key, { purposes: ALL })), code('forbidden'));
  const issued = await f.run(IssueDelegation, f.app(), await request(f, key, { purposes: AUTHOR }));
  assert.deepEqual(issued.purposes, AUTHOR);
  await protocolVerify(f, issued.certificate, { purpose: DELEGATION_PURPOSES.author });
  await assert.rejects(protocolVerify(f, issued.certificate, { purpose: DELEGATION_PURPOSES.receipt }), code('author_unverifiable'));
  // Unknown request members, private key material and extra JWK members are refused.
  const g = fixture(), k2 = await delegateKey(), base = await request(g, k2);
  for (const input of [{ ...base, client: { client_id: EVIL } }, { ...base, delegate: { ...k2.jwk, d: 'AAAA' } }, { ...base, delegate: { ...k2.jwk, ext: true } }, { ...base, cnx: 'x' }])
    await assert.rejects(g.run(IssueDelegation, g.app(), input), code('invalid_request'));
});

test('purpose separation: an identity key is never certified as a delegate, and the PoP is no JWS or bindlebox domain', async () => {
  const f = fixture();
  await f.keys.ensure(OWNER, 'signing');
  // The app cannot hold the identity private key, but even a crafted request naming the identity public key fails:
  // first on possession, and on aliasing when possession is somehow shown (simulated with a registered external key).
  const ext = await delegateKey();
  await f.keys.register(OWNER, { kid: 'external-1', alg: 'ES256', publicJwk: ext.jwk });
  await assert.rejects(f.run(IssueDelegation, f.app(), await request(f, ext)), code('invalid_request'));
  const current = await f.keys.current(OWNER, { purpose: 'signing' }), forged = { delegate: current.publicJwk, purposes: ALL, proof: { iat: Math.floor(f.clock.now() / 1000), signature: 'A'.repeat(86) } };
  await assert.rejects(f.run(IssueDelegation, f.app(), forged), code('invalid_request'));
  assert.ok(!POP_DOMAIN.startsWith('eyJ') && Object.values(B.DOMAINS).every(d => !d.startsWith(POP_DOMAIN) && !POP_DOMAIN.startsWith(d)));
  // A delegate key never resolves as an identity key of the owner.
  const key = await delegateKey(); await f.run(IssueDelegation, f.app(), await request(f, key));
  assert.equal(await f.keys.lookup(OWNER, { purpose: 'signing', kid: key.jkt }), null);
  assert.ok((await f.keys.history(OWNER, { purpose: 'signing' })).every(record => record.publicJwk.x !== key.jwk.x));
});

test('occupancy: non-occupants, a missing or failing port, inactive accounts and the flag are refused', async () => {
  const key = await delegateKey();
  const f = fixture(), input = await request(f, key);
  await assert.rejects(f.run(IssueDelegation, f.app(EVIL), await request(f, key, { clientId: EVIL })), code('forbidden'));
  for (const actor of [f.owner, f.system, f.pub()]) await assert.rejects(f.run(IssueDelegation, actor, input), code('forbidden'));
  await assert.rejects(f.run(IssueDelegation, { kind: 'app', owner: 'nope', clientId: APP }, input), code('unauthorized'));
  for (const occupant of [null, async () => null, async () => { throw new Error('down'); }, async () => ({ clientId: APP, origin: 'http://box.example', ingress: 'https://box.example/ingress', cnx: 'c', purposes: ALL }), async () => ({ clientId: APP, origin: 'https://box.example', ingress: 'https://box.example/in?x=1', cnx: 'c', purposes: ALL }), async () => ({ clientId: APP, origin: 'https://box.example', ingress: 'https://box.example/ingress', cnx: 'c' })]) {
    const g = fixture(occupant === null ? {} : { occupant });
    if (occupant === null) g.registry.occupant = undefined;
    await assert.rejects(g.run(IssueDelegation, g.app(), await request(g, key)), code('forbidden'));
  }
  const inactive = fixture({ account: async () => ({ status: 'suspended' }) });
  await assert.rejects(inactive.run(IssueDelegation, inactive.app(), await request(inactive, key)), code('forbidden'));
  const noAccount = fixture({ account: undefined }); noAccount.registry.account = undefined;
  await assert.rejects(noAccount.run(IssueDelegation, noAccount.app(), await request(noAccount, key)), code('forbidden'));
  const off = fixture({ enabled: false });
  await assert.rejects(off.run(IssueDelegation, off.app(), input), code('not_found'));
  await assert.rejects(off.run(DelegationStatus, off.pub(), { jkt: key.jkt }), code('not_found'));
  // Proof of possession: another key's signature, a stale iat, or a proof bound to another client or subject.
  const other = await delegateKey(), stale = await request(f, key, { iat: Math.floor(f.clock.now() / 1000) - 600 });
  for (const bad of [{ ...input, proof: (await request(f, other)).proof }, stale, await request(f, key, { clientId: EVIL }), await request(f, key, { owner: OTHER })])
    await assert.rejects(f.run(IssueDelegation, f.app(), bad), code('invalid_request'));
});

test('rotation: a new key revokes its predecessor; renewal keeps since; revoked keys never return', async () => {
  const f = fixture(), a = await delegateKey(), b = await delegateKey();
  const first = await f.run(IssueDelegation, f.app(), await request(f, a));
  assert.deepEqual(await f.run(DelegationStatus, f.pub(), { jkt: a.jkt }), { status: 'active', final: false });
  // Renewal while fresh returns the stored certificate; past half-life it re-signs with the same since.
  const again = await f.run(RenewDelegation, f.app(), await request(f, a));
  assert.equal(again.certificate, first.certificate); assert.equal(again.reused, true);
  f.clock.advance(13 * 3600 * 1000);
  const renewed = await f.run(RenewDelegation, f.app(), await request(f, a));
  assert.notEqual(renewed.jti, first.jti); assert.equal(renewed.since, first.since); assert.equal(renewed.reused, false);
  assert.equal(B.parseDelegation(renewed.certificate).claims.since, first.iat);
  await assert.rejects(f.run(RenewDelegation, f.app(), await request(f, b)), code('not_found'));
  f.clock.advance(3600 * 1000);
  const second = await f.run(IssueDelegation, f.app(), await request(f, b));
  assert.equal(second.since, second.iat);
  const revoked = await f.run(DelegationStatus, f.pub(), { jkt: a.jkt });
  assert.deepEqual(revoked, { status: 'revoked', revokedHour: Math.floor(f.clock.now() / 3600000), final: true });
  assert.equal((await f.run(DelegationStatus, f.pub(), { jkt: b.jkt })).status, 'active');
  await assert.rejects(f.run(IssueDelegation, f.app(), await request(f, a)), code('delegation_revoked'));
  await assert.rejects(f.run(RenewDelegation, f.app(), await request(f, a)), code('delegation_revoked'));
  // Identity key rotation: the next certificate is signed by the new key and verifies under it.
  const before = (await f.keys.current(OWNER, { purpose: 'signing' })).kid;
  await f.keys.rotate(OWNER, { purpose: 'signing', expectedKid: before });
  const rekeyed = await f.run(RenewDelegation, f.app(), await request(f, b));
  assert.equal(rekeyed.reused, false); assert.notEqual(B.parseDelegation(rekeyed.certificate).header.kid, before);
  await protocolVerify(f, rekeyed.certificate);
  const { delegations, audit } = await f.run(DelegationList, f.owner);
  assert.deepEqual(delegations.map(d => [d.jkt, d.state, d.reason]), [[a.jkt, 'revoked', 'superseded'], [b.jkt, 'active', null]]);
  assert.ok(delegations.every(d => !('certificate' in d) && !('last' in d)));
  assert.deepEqual(audit.map(e => e.event).reverse(), ['issued', 'renewed', 'issued', 'revoked', 'renewed']);
  assert.ok(f.audit.entries.some(e => e.operation === 'delegations.issue' && e.outcome === 'ok' && e.actor.kind === 'app'));
  assert.ok(f.audit.entries.every(e => !JSON.stringify(e).includes(first.certificate)));
});

test('uninstall and app switch: status flips at once, reconcile persists it, and a key never moves', async () => {
  const f = fixture(), a = await delegateKey();
  await f.run(IssueDelegation, f.app(), await request(f, a));
  f.seat.value = { ...f.seat.value, cnx: 'cnx-2' }; // reinstall: new connection incarnation
  await assert.rejects(f.run(IssueDelegation, f.app(), await request(f, a)), code('delegation_revoked'));
  assert.equal((await f.run(DelegationStatus, f.pub(), { jkt: a.jkt })).final, true, 'the moved key was revoked where it was');
  const b = await delegateKey(); await f.run(IssueDelegation, f.app(), await request(f, b));
  f.seat.value = null; // uninstalled: reconcile persists it without any status query
  await assert.rejects(f.run(RenewDelegation, f.app(), await request(f, b)), code('forbidden'));
  assert.deepEqual(await f.run(ReconcileDelegations, f.system), { revoked: 1 });
  assert.equal((await f.run(DelegationStatus, f.pub(), { jkt: b.jkt })).final, true);
  // KD-1: the first observed mismatch is persisted, so A -> B -> A never revives the key.
  f.seat.value = { clientId: APP, origin: 'https://box.example', ingress: 'https://box.example/ingress', cnx: 'cnx-3', purposes: ALL };
  const d = await delegateKey(); await f.run(IssueDelegation, f.app(), await request(f, d));
  f.seat.value = { ...f.seat.value, clientId: EVIL };
  const seen = await f.run(DelegationStatus, f.pub(), { jkt: d.jkt });
  assert.equal(seen.status, 'revoked'); assert.equal(seen.final, true);
  f.seat.value = { ...f.seat.value, clientId: APP };
  assert.equal((await f.run(DelegationStatus, f.pub(), { jkt: d.jkt })).status, 'revoked');
  assert.equal((await f.run(DelegationList, f.owner)).delegations.find(x => x.jkt === d.jkt).reason, 'occupant-changed');
  // KD-2: withdrawing a certified purpose revokes the key (status and reconcile alike).
  const e = await delegateKey(); await f.run(IssueDelegation, f.app(), await request(f, e));
  f.seat.value = { ...f.seat.value, purposes: AUTHOR };
  assert.deepEqual(await f.run(ReconcileDelegations, f.system), { revoked: 1 });
  assert.equal((await f.run(DelegationList, f.owner)).delegations.find(x => x.jkt === e.jkt).reason, 'consent-withdrawn');
  const h = await delegateKey(); await f.run(IssueDelegation, f.app(), await request(f, h, { purposes: AUTHOR }));
  assert.equal((await f.run(DelegationStatus, f.pub(), { jkt: h.jkt })).status, 'active');
  // A failing port is 503, never active.
  const g = fixture(), c = await delegateKey(); await g.run(IssueDelegation, g.app(), await request(g, c));
  g.registry.occupant = async () => { throw new Error('down'); };
  await assert.rejects(g.run(DelegationStatus, g.pub(), { jkt: c.jkt }), code('delegation_unavailable'));
  await assert.rejects(g.run(ReconcileDelegations, g.system), code('delegation_unavailable'));
});

test('revocation selectors: owner by key, client or all; the app only its own keys; idempotent', async () => {
  const f = fixture(), a = await delegateKey();
  await f.run(IssueDelegation, f.app(), await request(f, a));
  await assert.rejects(f.run(RevokeDelegation, f.app(EVIL), { jkt: a.jkt }), code('not_found'));
  await assert.rejects(f.run(RevokeDelegation, f.app(), { all: true }), code('forbidden'));
  await assert.rejects(f.run(RevokeDelegation, f.app(), { clientId: APP }), code('forbidden'));
  await assert.rejects(f.run(RevokeDelegation, f.pub(), { jkt: a.jkt }), code('forbidden'));
  for (const input of [{}, { jkt: a.jkt, all: true }, { jkt: 'short' }, { all: false }, { jkt: a.jkt, reason: 'because' }, { jkt: a.jkt, extra: 1 }, { jkt: a.jkt, reason: 'superseded' }, { jkt: a.jkt, reason: 'occupant-changed' }]) await assert.rejects(f.run(RevokeDelegation, f.owner, input), code('invalid_request'), JSON.stringify(input));
  // KD-6: an app can only record `app` as its reason.
  for (const reason of ['compromise', 'client-breach', 'suspended', 'owner']) await assert.rejects(f.run(RevokeDelegation, f.app(), { jkt: a.jkt, reason }), code('invalid_request'), reason);
  assert.deepEqual(await f.run(RevokeDelegation, f.app(), { jkt: a.jkt }), { revoked: 1 });
  assert.deepEqual(await f.run(RevokeDelegation, f.app(), { jkt: a.jkt }), { revoked: 0 });
  const b = await delegateKey(); await f.run(IssueDelegation, f.app(), await request(f, b));
  assert.deepEqual(await f.run(RevokeDelegation, f.system, { clientId: APP, reason: 'client-breach' }), { revoked: 1 });
  const c = await delegateKey(); await f.run(IssueDelegation, f.app(), await request(f, c));
  assert.deepEqual(await f.run(RevokeDelegation, f.owner, { all: true }), { revoked: 1 });
  assert.ok((await f.run(DelegationList, f.owner)).delegations.every(d => d.state === 'revoked'));
});

test('bounded history, tombstones, audit ring and the new-key rate', async () => {
  const f = fixture({ historyLimit: 3, auditLimit: 5, newKeysPerDay: 50 }), keys = [];
  for (let i = 0; i < 6; i++) { const key = await delegateKey(); keys.push(key); await f.run(IssueDelegation, f.app(), await request(f, key)); f.clock.advance(1000); }
  const { delegations, audit } = await f.run(DelegationList, f.owner);
  assert.equal(delegations.length, 3); assert.deepEqual(delegations.map(d => d.jkt), keys.slice(3).map(k => k.jkt));
  assert.equal(audit.length, 5);
  assert.deepEqual(await f.run(DelegationStatus, f.pub(), { jkt: keys[0].jkt }), { status: 'revoked', final: false });
  await assert.rejects(f.run(IssueDelegation, f.app(), await request(f, keys[0])), code('delegation_revoked'));
  const g = fixture({ newKeysPerDay: 2 });
  for (let i = 0; i < 2; i++) await g.run(IssueDelegation, g.app(), await request(g, await delegateKey()));
  await assert.rejects(g.run(IssueDelegation, g.app(), await request(g, await delegateKey())), code('rate_limited'));
  g.clock.advance(86400001);
  await g.run(IssueDelegation, g.app(), await request(g, await delegateKey()));
});

test('status privacy: unknown keys, malformed keys and other subjects answer identically', async () => {
  const f = fixture(), a = await delegateKey(), stranger = await delegateKey();
  await f.run(IssueDelegation, f.app(), await request(f, a));
  const unknown = await f.run(DelegationStatus, f.pub(), { jkt: stranger.jkt });
  assert.deepEqual(unknown, { status: 'revoked', final: false });
  assert.deepEqual(await f.run(DelegationStatus, f.pub(OTHER), { jkt: a.jkt }), unknown, 'the same jkt under another subject is unknown');
  assert.deepEqual(await f.run(DelegationStatus, f.pub(), { jkt: 'not-a-thumbprint' }), unknown);
  await assert.rejects(f.run(DelegationStatus, f.pub(), { jkt: a.jkt, subject: OTHER }), code('invalid_request'));
  const active = await f.run(DelegationStatus, f.pub(), { jkt: a.jkt });
  assert.deepEqual(Object.keys(active).sort(), ['final', 'status']);
  assert.equal(statusCacheControl(active), 'public, max-age=300'); assert.equal(statusCacheControl(unknown), 'public, max-age=300');
  assert.equal(statusCacheControl({ status: 'revoked', revokedHour: 1, final: true }), 'public, max-age=86400, immutable');
});

test('concurrency (seeded): racing issues, revocations and identity rotation leave at most one active key', async () => {
  await forEachSeed(6, async random => {
    const scheduler = createScheduler(random), store = new MemoryMessagingStore(), f = fixture({ store: scheduler.wrap(store, 'store'), newKeysPerDay: 50 });
    await f.keys.ensure(OWNER, 'signing');
    const keys = await Promise.all([0, 1, 2, 3].map(delegateKey)), inputs = await Promise.all(keys.map(k => request(f, k)));
    const kid = (await f.keys.current(OWNER, { purpose: 'signing' })).kid;
    const tasks = [...inputs.map(input => () => f.run(IssueDelegation, f.app(), input)), () => f.run(IssueDelegation, f.app(), inputs[0]), () => f.run(RevokeDelegation, f.owner, { clientId: APP })];
    if (random.chance(0.5)) tasks.push(() => f.keys.rotate(OWNER, { purpose: 'signing', expectedKid: kid }));
    const results = await scheduler.run(tasks);
    for (const r of results) if (r.status === 'rejected') assert.ok(['delegation_conflict', 'delegation_revoked', 'key_conflict'].includes(r.reason?.code), String(r.reason?.code ?? r.reason));
    const { delegations } = await f.registry.list(OWNER);
    assert.ok(delegations.filter(d => d.state === 'active').length <= 1, `scheduler trace ${scheduler.trace.join(', ')}`);
    // Every returned certificate's key is either the single active one or reports revoked; none is unknown to status.
    const current = (await f.keys.current(OWNER, { purpose: 'signing' })).kid;
    for (const r of results.slice(0, 5)) if (r.status === 'fulfilled') {
      const state = await f.registry.status(OWNER, r.value.jkt);
      assert.ok(delegations.some(d => d.jkt === r.value.jkt), 'issued keys are recorded');
      if (state.status === 'active') { const header = B.parseDelegation(r.value.certificate).header; if (header.kid === current) await protocolVerify(f, r.value.certificate); }
    }
  });
});

test('KD-3: a client or all revocation committed while a new key is being signed fences that issuance', async () => {
  for (const input of [{ all: true, reason: 'suspended' }, { clientId: APP, reason: 'uninstalled' }]) {
    const f = fixture(), a = await delegateKey(), signer = f.registry.signer;
    f.registry.signer = async owner => { const value = await signer(owner); await f.run(RevokeDelegation, f.system, input); return value; };
    await assert.rejects(f.run(IssueDelegation, f.app(), await request(f, a)), code('delegation_conflict'));
    assert.deepEqual(await f.run(DelegationStatus, f.pub(), { jkt: a.jkt }), { status: 'revoked', final: false });
  }
  // Suspension during signing: the account check is repeated before commit.
  let active = true; const g = fixture({ account: async () => ({ status: active ? 'active' : 'suspended' }) }), b = await delegateKey(), signer = g.registry.signer;
  g.registry.signer = async owner => { const value = await signer(owner); active = false; return value; };
  await assert.rejects(g.run(IssueDelegation, g.app(), await request(g, b)), code('forbidden'));
});

// Real Node adapter: flag gate, route shapes and the HTTP cache semantics of the public status endpoint.
async function server(port, config) {
  const origin = `http://localhost:${port}`, directory = await mkdtemp(join(tmpdir(), 'bindle-key-delegation-')), app = await createNodeServer({ directory, config: { APP_ORIGIN: origin, ...config } });
  const fetchURL = (path, init = {}) => app.fetch(new Request(new URL(path, origin), init));
  const ip = '198.51.100.9', post = (path, value, headers = {}) => fetchURL(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers }, body: JSON.stringify(value) });
  const signup = await post('/api/auth/signup', { method: 'password', password: 'Private key delegation account password!', termsAccepted: true, termsVersion: '2026-10-11', turnstileToken: 'local-browser-test-token' }), pending = await signup.json(), setup = { Cookie: signup.headers.get('Set-Cookie').split(';')[0] };
  const recovery = await (await post('/api/auth/recovery/download', { pendingToken: pending.pendingToken }, setup)).json();
  const activated = await post('/api/auth/recovery/confirm', { pendingToken: pending.pendingToken, recoveryToken: recovery.recoveryToken, downloadConfirmed: true }, setup); assert.equal(activated.status, 200, await activated.clone().text());
  const session = await activated.json(), headers = { Cookie: activated.headers.getSetCookie().find(c => c.startsWith('bindle_session=')).split(';')[0], 'X-CSRF-Token': session.csrfToken };
  const owner = (path, value, method = value === undefined ? 'GET' : 'POST') => fetchURL(path, { method, headers: { Origin: origin, ...headers, ...value === undefined ? {} : { 'Content-Type': 'application/json' } }, ...value === undefined ? {} : { body: JSON.stringify(value) } });
  return { app, origin, owner, fetchURL, id: session.account.id, controller: () => app.resources.accounts.get(session.account.id), async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
const httpRequest = async (s, key, clientId = APP) => ({ delegate: key.jwk, purposes: ALL, proof: await signDelegationPop({ privateKey: key.privateKey, issuer: s.origin, clientId, jkt: key.jkt, subject: s.id, iat: Math.floor(Date.now() / 1000) }) });

test('flag off: the status endpoint and owner routes are not mounted and the app entry refuses', async () => {
  const s = await server(8796, {});
  try {
    const key = await delegateKey();
    assert.equal((await s.fetchURL(`/identity/${s.id}/delegations/${key.jkt}`)).status, 404);
    assert.equal((await s.owner('/api/delegations')).status, 404);
    assert.equal((await s.owner('/api/delegations/revoke', { all: true })).status, 404);
    await assert.rejects(s.controller().delegationOperation(s.id, { actor: { kind: 'app', owner: s.id, clientId: APP }, operation: 'delegations.issue', input: await httpRequest(s, key) }), code('not_found'));
  } finally { await s.close(); }
});

test('flag on: issuance through the account, protocol verification, and status endpoint cache semantics', async () => {
  const seat = { value: { clientId: APP, origin: 'https://box.example', ingress: 'https://box.example/ingress', cnx: 'cnx-1', purposes: ALL } };
  const s = await server(8797, { BINDLEBOX_ENABLED: 'true', DELEGATION_SLOT_OCCUPANT: async ({ slot }) => (slot === MESSAGING_INGRESS_SLOT ? seat.value : null), DELEGATION_CERTIFICATE_SECONDS: '7200' });
  try {
    const c = s.controller(), actor = { kind: 'app', owner: s.id, clientId: APP }, key = await delegateKey();
    await assert.rejects(c.delegationOperation(s.id, { actor: { ...actor, owner: crypto.randomUUID() }, operation: 'delegations.issue', input: {} }), code('forbidden'));
    await assert.rejects(c.delegationOperation(s.id, { actor: { kind: 'owner', owner: s.id }, operation: 'delegations.issue', input: {} }), code('forbidden'));
    await assert.rejects(c.delegationOperation(s.id, { actor, operation: 'delegations.status', input: { jkt: key.jkt } }), code('unsupported_method'));
    const issued = await c.delegationOperation(s.id, { actor, operation: 'delegations.issue', input: await httpRequest(s, key) });
    assert.equal(issued.exp - issued.iat, 7200);
    // Cross-check against the public identity key port and the protocol library (loopback only in this local test).
    const kid = B.parseDelegation(issued.certificate, { allowLoopback: true }).header.kid, identityKey = await c.identitySigningKey(s.id, kid);
    const verified = await B.verifyDelegation(issued.certificate, { identityKey: { keyId: kid, publicJwk: identityKey.publicJwk }, principal: { issuer: s.origin, subject: s.id }, jkt: key.jkt, purpose: B.PURPOSES.receipt, now: Date.now(), allowLoopback: true });
    assert.equal(verified.claims.client.ingress, 'https://box.example/ingress');
    assert.equal(issued.status, `${s.origin}/identity/${s.id}/delegations/${key.jkt}`);

    const status = await s.fetchURL(new URL(issued.status).pathname, { headers: { 'CF-Connecting-IP': '203.0.113.5' } });
    assert.equal(status.status, 200); assert.deepEqual(await status.json(), { status: 'active' });
    assert.equal(status.headers.get('Cache-Control'), 'public, max-age=300'); assert.equal(status.headers.get('Set-Cookie'), null);
    const head = await s.fetchURL(new URL(issued.status).pathname, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await s.fetchURL(new URL(issued.status).pathname, { method: 'POST', headers: { Origin: s.origin } })).status, 405);
    assert.equal((await s.fetchURL(`/identity/${s.id}/delegations/short`)).status, 400);
    // Unknown key and unknown subject: identical body and cache class, no account woken for the stranger.
    const stranger = await delegateKey(), ghost = crypto.randomUUID();
    const a = await s.fetchURL(`/identity/${s.id}/delegations/${stranger.jkt}`), b = await s.fetchURL(`/identity/${ghost}/delegations/${key.jkt}`);
    assert.deepEqual([a.status, await a.json(), a.headers.get('Cache-Control')], [200, { status: 'revoked' }, 'public, max-age=300']);
    assert.deepEqual([b.status, await b.json(), b.headers.get('Cache-Control')], [200, { status: 'revoked' }, 'public, max-age=300']);
    assert.equal(s.app.resources.accounts.has?.(ghost) ?? false, false);
    // Owner list and revoke over HTTP; the revocation is final and cacheable for long.
    const listed = await (await s.owner('/api/delegations')).json();
    assert.deepEqual(listed.delegations.map(d => [d.jkt, d.state]), [[key.jkt, 'active']]);
    assert.equal((await s.owner('/api/delegations', {})).status, 405);
    assert.equal((await s.owner('/api/delegations/revoke', { jkt: key.jkt, owner: 'x' })).status, 400);
    assert.deepEqual(await (await s.owner('/api/delegations/revoke', { jkt: key.jkt })).json(), { revoked: 1 });
    const gone = await s.fetchURL(new URL(issued.status).pathname), body = await gone.json();
    assert.deepEqual(Object.keys(body).sort(), ['revokedHour', 'status']); assert.equal(body.status, 'revoked'); assert.equal(body.revokedHour, Math.floor(Date.now() / 3600000));
    assert.equal(gone.headers.get('Cache-Control'), 'public, max-age=86400, immutable');
    // An occupant change flips a fresh key to revoked at once, without the immutable class.
    const next = await delegateKey(); await c.delegationOperation(s.id, { actor, operation: 'delegations.issue', input: await httpRequest(s, next) });
    seat.value = { ...seat.value, clientId: EVIL };
    const moved = await s.fetchURL(`/identity/${s.id}/delegations/${next.jkt}`), movedBody = await moved.json();
    assert.deepEqual([movedBody.status, typeof movedBody.revokedHour, moved.headers.get('Cache-Control')], ['revoked', 'number', 'public, max-age=86400, immutable'], 'the first observed mismatch is persisted (KD-1)');
    seat.value = { ...seat.value, clientId: APP };
    const failing = await server(8798, { BINDLEBOX_ENABLED: 'true', DELEGATION_SLOT_OCCUPANT: async () => { throw new Error('down'); } });
    try {
      const unavailable = await failing.fetchURL(`/identity/${failing.id}/delegations/${key.jkt}`);
      // Nothing was ever issued there, so the key is unknown; only an active record consults the port.
      assert.equal(unavailable.status, 200);
    } finally { await failing.close(); }
  } finally { await s.close(); }
});
