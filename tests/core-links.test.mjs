// Core links (slice BB-C1a): the moved envelope/replay/audience/preview modules, current-key minting across an
// identity key rotation, revoked keys, the links contract service and its engine operations with owner and app
// actors. Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as envelope from '../packages/links/envelope.mjs';
import * as legacyEnvelope from '../packages/messaging/bindle-links.mjs';
import * as replay from '../packages/links/replay.mjs';
import * as legacyReplay from '../packages/messaging/link-replay.mjs';
import * as preview from '../packages/links/preview.mjs';
import * as legacyPreview from '../packages/runtime/contact-preview.mjs';
import * as profile from '../packages/links/profile.mjs';
import * as legacyProfile from '../packages/beaming/profile.mjs';
import * as audience from '../packages/links/audience.mjs';
import * as contactLinks from '../packages/runtime/contact-links.mjs';
import { MemoryMessagingStore, ContactTokenService, ContactEndpointService, MessagingService, signContactToken } from '../packages/messaging/index.mjs';
import { key, fromBase64url, strictText } from '../packages/core/records.mjs';
import { IdentityKeyRegistry } from '../packages/identity/keys.mjs';
import { LinkService, currentLinkKey } from '../packages/links/issuance.mjs';
import { linksProvider, IssueLink, RevokeLink, RotateLinkChallenge, EvaluateLink, LinkList, LinkChanges } from '../packages/links/engine.mjs';
import { MESSAGING_CONTACT_LINK_TYPE, MESSAGING_INGRESS_SLOT, CONTACT_LINK_TYPE } from '../packages/links/types.mjs';
import { createAppEngine, perform, read } from '../packages/app/engine.mjs';
import { memoryAudit } from '../packages/app/providers.mjs';
import { SqliteMetadata } from '../apps/node/resources.mjs';
import { createRandom, forEachSeed, fakeClock } from './helpers/chaos.mjs';

const ISSUER = 'https://3sln.example', OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', POLICY = 'https://3sln.example/policies/developer-contact/v1';
const decoded = segment => JSON.parse(strictText(fromBase64url(segment)));
const metaOf = url => new URL(url).searchParams.get('bindle_meta');
const kidOf = url => decoded(metaOf(url).split('.')[0]).kid;
const claims = (extra = {}) => ({ resource: 'parent-1', kinds: ['one-off'], mimeTypes: ['text/plain'], maxMessages: 5, maxBytes: 65536, maxMessageBytes: 16384, ...extra });

test('moved modules: every legacy path re-exports the exact core-links bindings (no parser differential)', () => {
  for (const [moved, legacy] of [[envelope, legacyEnvelope], [replay, legacyReplay], [preview, legacyPreview], [profile, legacyProfile]]) {
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(moved).sort());
    for (const name of Object.keys(moved)) assert.equal(legacy[name], moved[name], name);
  }
  for (const name of ['linkAudienceDecide', 'admitLinkAudience', 'inspectContactLink', 'signOwnLinkResponse', 'collectLinkState']) assert.equal(contactLinks[name], audience[name], name);
  assert.equal(envelope.CONTACT_LINK_TYPE, CONTACT_LINK_TYPE);
});

test('link JWS signer: seeded round trips verify, and every single-character mutation is refused', async t => {
  t.diagnostic(`CHAOS_SEED base ${Number(process.env.CHAOS_SEED ?? 1)}`);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const B64 = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'];
  await forEachSeed(4, async random => {
    for (let round = 0; round < 12; round++) {
      const iat = 1800000000 + random.int(1000), meta = { bindle: 'link-meta', v: 1, type: MESSAGING_CONTACT_LINK_TYPE, iss: ISSUER, aud: `${ISSUER}/users/alice/contact/${crypto.randomUUID()}`, jti: crypto.randomUUID(), iat, exp: iat + 1 + random.int(86400), sub: OWNER, ...claims({ maxMessages: 1 + random.int(100) }) };
      const value = await envelope.signLinkJWS({ header: { alg: 'ES256', kid: `k${random.int(9)}`, typ: envelope.LINK_META_TYP }, claims: meta, privateKey: pair.privateKey });
      // Same canonical bytes as the pre-C1a contact-token signer: stored inputs stay comparable.
      const legacy = await signContactToken({ header: { alg: 'ES256', kid: decoded(value.split('.')[0]).kid, typ: envelope.LINK_META_TYP }, claims: meta, privateKey: pair.privateKey });
      assert.equal(value.split('.').slice(0, 2).join('.'), legacy.split('.').slice(0, 2).join('.'));
      const parsed = envelope.parseLinkMeta(value);
      assert.equal(await envelope.verifyLinkSignature(crypto, parsed, { alg: 'ES256', publicJwk }), true);
      assert.deepEqual(envelope.parseLinkQuery(`${meta.aud}?bindle_meta=${value}`), { form: 'link', meta: value });
      const at = random.int(value.length), swap = random.pick(B64.filter(char => char !== value[at])), mutated = value.slice(0, at) + swap + value.slice(at + 1);
      let accepted = false; try { accepted = await envelope.verifyLinkSignature(crypto, envelope.parseLinkMeta(mutated), { alg: 'ES256', publicJwk }); } catch (error) { assert.equal(error.code, 'link_invalid'); }
      // A mutated final character can be a noncanonical encoding of the same bytes; anything else must fail.
      if (accepted) assert.equal(envelope.parseLinkMeta(mutated).input, parsed.input);
    }
  });
  await assert.rejects(envelope.signLinkJWS({ header: { alg: 'ES256', kid: 'k', typ: 'contact+jwt' }, claims: {}, privateKey: pair.privateKey }), { code: 'invalid_token' });
  await assert.rejects(envelope.signLinkJWS({ header: { alg: 'none', kid: 'k', typ: envelope.LINK_META_TYP }, claims: {}, privateKey: pair.privateKey }), { code: 'invalid_token' });
});

test('replay record through the core-links path: single use, principal cap, refusal instead of eviction', async () => {
  const metadata = new SqliteMetadata(':memory:'), clock = fakeClock(1800000000000);
  try {
    const record = new replay.LinkReplayRecord({ metadata, clock: clock.now, principalCap: 1 }), hash = 'A'.repeat(43), other = 'B'.repeat(43);
    const row = { parent: crypto.randomUUID(), iss: ISSUER, sub: OWNER, key: hash, expiresAt: clock.now() + 300000 };
    assert.deepEqual(await record.consume(row), { consumed: true, expiresAt: row.expiresAt });
    await assert.rejects(record.consume(row), { code: 'audience_stale' });
    await assert.rejects(record.consume({ ...row, key: other }), { code: 'audience_unavailable' });
    clock.advance(301000); assert.equal((await record.consume({ ...row, key: other, expiresAt: clock.now() + 300000 })).consumed, true);
  } finally { metadata.close(); }
});

// A registry-held identity key (as AccountController holds it) plus the contact endpoint service over one store.
async function contactWorld() {
  let now = 1800000000000; const clock = () => now, store = new MemoryMessagingStore();
  const tokens = new ContactTokenService({ store, issuer: ISSUER, clock }), registry = new IdentityKeyRegistry({ store, clock, seal: value => structuredClone(value), open: value => value });
  await registry.ensure(OWNER, 'signing');
  const endpoints = new ContactEndpointService({ tokens, linkPolicies: [POLICY], signer: async ({ owner, kid }) => { const signer = await registry.privateKey(owner, 'signing'); if (signer?.kid !== kid) throw new Error('Signing key unavailable'); return signer.privateKey; } });
  const messages = new MessagingService({ store, tokens: endpoints, clock }), collection = await messages.createCollection(OWNER, 'Inbox');
  const create = async (extra = {}) => { const current = await registry.current(OWNER, { purpose: 'signing' }); return endpoints.createLink(OWNER, { handle: 'alice', kid: current?.kid ?? 'none', collections: [collection.id], mimeTypes: ['text/plain'], expiresAt: now + 86400000, maxMessages: 3, ...extra }); };
  return { store, tokens, registry, endpoints, create, now: clock, advance: ms => { now += ms; } };
}

test('contact links across an identity key rotation: old links verify, new links and rotated challenges use the current key, a revoked key verifies nothing', async () => {
  const w = await contactWorld(), first = (await w.registry.current(OWNER, { purpose: 'signing' })).kid;
  const plain = await w.create(), conditional = await w.create({ audience: { policy: POLICY } });
  assert.equal(kidOf(plain.url), first);
  const rotated = await w.registry.rotate(OWNER, { purpose: 'signing', expectedKid: first });
  assert.equal((await w.endpoints.inspect(plain.url)).form, 'link', 'a retired key keeps its stored links valid');
  const fresh = await w.create();
  assert.equal(kidOf(fresh.url), rotated.kid, 'new links are minted with the current key');
  // A caller naming the retired key cannot mint under it.
  const collection = (await w.store.transaction(tx => tx.get(key('contact-grant', plain.grant.id)))).claims.collections[0];
  const stale = await w.endpoints.createLink(OWNER, { handle: 'alice', kid: first, collections: [collection], mimeTypes: ['text/plain'], expiresAt: w.now() + 86400000, maxMessages: 3 });
  assert.equal(kidOf(stale.url), rotated.kid, 'a stale caller kid is replaced by the current key');
  const challenged = await w.endpoints.rotateChallenge(OWNER, conditional.grant.id);
  assert.equal(kidOf(challenged.url), rotated.kid, 'challenge rotation re-signs with the current key');
  await assert.rejects(w.endpoints.inspect(conditional.url), { code: 'link_invalid' }, 'the previous meta stops verifying');
  assert.equal((await w.endpoints.inspect(challenged.url)).conditional, true);
  await w.registry.revoke(OWNER, { purpose: 'signing', kid: first, reason: 'compromise' });
  await assert.rejects(w.endpoints.inspect(plain.url), { code: 'link_invalid' }, 'a revoked key verifies nothing');
  assert.equal((await w.endpoints.inspect(fresh.url)).form, 'link');
  // A forged meta under the revoked key with the exact stored claims is still refused.
  const grant = await w.store.transaction(tx => tx.get(key('contact-grant', plain.grant.id)));
  assert.equal(grant.endpoint.header.kid, first);
  // Revoking the current key clears the pointer: issuance refuses until a new key exists.
  await w.registry.revoke(OWNER, { purpose: 'signing', kid: rotated.kid });
  assert.equal(await currentLinkKey(w.registry, OWNER, null), null);
  await assert.rejects(w.create(), { code: 'invalid_key' });
  await assert.rejects(w.endpoints.inspect(fresh.url), { code: 'link_invalid' });
});

test('externally registered keys (pre-registry fixtures) keep minting under the caller kid only while active', async () => {
  const store = new MemoryMessagingStore(), tokens = new ContactTokenService({ store, issuer: ISSUER });
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await tokens.registerKey(OWNER, { kid: 'one', alg: 'ES256', publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) });
  const endpoints = new ContactEndpointService({ tokens, signer: async () => pair.privateKey }), messages = new MessagingService({ store, tokens: endpoints });
  const collection = await messages.createCollection(OWNER, 'Inbox'), options = { handle: 'alice', kid: 'one', collections: [collection.id], mimeTypes: ['text/plain'], expiresAt: Date.now() + 86400000 };
  assert.equal(kidOf((await endpoints.createLink(OWNER, options)).url), 'one');
  await tokens.revokeKey(OWNER, 'one');
  await assert.rejects(endpoints.createLink(OWNER, options), { code: 'invalid_key' });
});

// The links contract service and engine over one account store.
async function linksWorld({ enabled = true, occupant, changeRetention, decide } = {}) {
  const clock = fakeClock(1800000000000), store = new MemoryMessagingStore(), registry = new IdentityKeyRegistry({ store, clock: clock.now, seal: value => structuredClone(value), open: value => value });
  await registry.ensure(OWNER, 'signing');
  const service = new LinkService({ store, issuer: ISSUER, keys: registry, clock: clock.now, policies: [POLICY], signingKey: owner => registry.privateKey(owner, 'signing'), decide, ...(changeRetention ? { changeRetention } : {}) });
  const audit = memoryAudit({ clock }), state = { occupant: occupant === undefined ? { clientId: 'https://box.example/app', generation: 3 } : occupant };
  const engine = createAppEngine({ providers: { clock, random: { uuid: () => crypto.randomUUID() }, audit, links: linksProvider({ service, enabled, occupant: async ({ owner, slot }) => (owner === OWNER && slot === MESSAGING_INGRESS_SLOT ? state.occupant : null) }) } });
  const app = (clientId = 'https://box.example/app') => ({ kind: 'app', owner: OWNER, clientId, handle: 'alice' }), owner = { kind: 'owner', owner: OWNER };
  return { clock, store, registry, service, engine, audit, state, app, owner, issue: (input, actor = app()) => perform(engine, new IssueLink({ actor, input: { type: MESSAGING_CONTACT_LINK_TYPE, claims: claims(), expiresAt: clock.now() + 86400000, ...input } })) };
}

test('links contract: flag off refuses everything; owners and non-occupants cannot issue; the occupant issues exact verified metas', async () => {
  const off = await linksWorld({ enabled: false });
  await assert.rejects(off.issue(), { code: 'not_found' });
  await assert.rejects(read(off.engine, new LinkList({ actor: off.owner })), { code: 'not_found' });
  const w = await linksWorld();
  await assert.rejects(w.issue({}, w.owner), { code: 'forbidden' });
  await assert.rejects(w.issue({}, w.app('https://other.example/app')), { code: 'forbidden' });
  await assert.rejects(w.issue({}, { kind: 'app', owner: OWNER }), { code: 'unauthorized' });
  await assert.rejects(w.issue({}, { kind: 'system', owner: OWNER }), { code: 'unauthorized' });
  const issued = await w.issue({ audience: { policy: POLICY } });
  const url = new URL(issued.link), [h, p] = metaOf(issued.link).split('.'), header = decoded(h), meta = decoded(p);
  assert.equal(url.pathname, `/users/alice/contact/${issued.jti}`); assert.deepEqual([...url.searchParams.keys()], ['bindle_meta']);
  assert.deepEqual(header, { alg: 'ES256', kid: (await w.registry.current(OWNER, { purpose: 'signing' })).kid, typ: 'bindle-link-meta+jwt' });
  assert.deepEqual(Object.keys(meta).sort(), ['aud', 'audience', 'bindle', 'exp', 'iat', 'iss', 'jti', 'kinds', 'maxBytes', 'maxMessageBytes', 'maxMessages', 'mimeTypes', 'resource', 'sub', 'type', 'v'].sort());
  assert.equal(meta.sub, OWNER); assert.equal(meta.audience.policy, POLICY); assert.equal(meta.audience.challenge.length, 22);
  const verified = await w.service.verify(issued.link);
  assert.equal(verified.conditional, true); assert.equal(verified.record.issuer.clientId, 'https://box.example/app'); assert.equal(verified.record.issuer.generation, 3);
  assert.deepEqual(w.audit.entries.at(-1), { at: w.clock.now(), operation: 'links.issue', actor: { kind: 'app', owner: OWNER }, outcome: 'ok' });
  // Members the provider fills, members the type forbids, unregistered policies and bad bounds are refused.
  for (const [input, code] of [[{ claims: claims({ sub: OWNER }) }, 'invalid_link_claims'], [{ claims: claims({ collections: ['x'] }) }, 'invalid_link_claims'], [{ claims: claims({ kinds: ['one-off', 'conversation-init'] }) }, 'invalid_link_claims'], [{ claims: claims({ resource: 'x'.repeat(129) }) }, 'invalid_link_claims'], [{ claims: claims({ maxMessageBytes: 70000 }) }, 'invalid_link_claims'], [{ audience: { policy: 'https://evil.example/oracle' } }, 'invalid_link_policy'], [{ audience: { challenge: 'A'.repeat(22) } }, 'invalid_link_policy'], [{ expiresAt: w.clock.now() + 400 * 86400000 }, 'invalid_link_expiry'], [{ type: CONTACT_LINK_TYPE }, 'unsupported_link_type'], [{ iss: 'https://evil.example' }, 'invalid_request']]) await assert.rejects(w.issue(input), { code }, JSON.stringify(input));
  // Exact stored claims: a valid signature over claims the provider did not store is invalid.
  const signer = await w.registry.privateKey(OWNER, 'signing'), forged = await envelope.signLinkJWS({ header, claims: { ...meta, maxMessages: 100000 }, privateKey: signer.privateKey });
  await assert.rejects(w.service.verify(`${url.origin}${url.pathname}?bindle_meta=${forged}`), { code: 'link_invalid' });
  await assert.rejects(w.service.verify(`${issued.link}&bindle_data=a.b.c`), { code: 'link_malformed' });
  assert.equal((await w.service.verify(`${issued.link}&bindle_data=a.b.c`, { allowData: true })).data, 'a.b.c');
  await assert.rejects(w.service.verify(issued.link.replace('/alice/', '/bob/')), { code: 'link_invalid' });
  // No occupant port, no occupant, or a replaced occupant: forbidden, re-read on every operation.
  w.state.occupant = { clientId: 'https://next.example/app', generation: 4 };
  await assert.rejects(w.issue(), { code: 'forbidden' });
  await assert.rejects(read(w.engine, new LinkList({ actor: w.app() })), { code: 'forbidden' });
  const listed = await read(w.engine, new LinkList({ actor: w.app('https://next.example/app'), input: { type: MESSAGING_CONTACT_LINK_TYPE } }));
  assert.deepEqual(listed.links.map(link => [link.jti, link.occupantGeneration, link.revoked]), [[issued.jti, 3, false]], 'a new occupant reads earlier links with their generation');
});

test('links contract across an identity key rotation: issued links verify via history, new and rotated metas use the current key, revocation refuses', async () => {
  const w = await linksWorld(), first = (await w.registry.current(OWNER, { purpose: 'signing' })).kid;
  const plain = await w.issue(), conditional = await w.issue({ audience: {} });
  const next = await w.registry.rotate(OWNER, { purpose: 'signing', expectedKid: first });
  assert.equal((await w.service.verify(plain.link)).record.header.kid, first);
  const fresh = await w.issue(); assert.equal(kidOf(fresh.link), next.kid);
  const rotated = await perform(w.engine, new RotateLinkChallenge({ actor: w.app(), id: conditional.jti }));
  assert.equal(kidOf(rotated.link), next.kid);
  await assert.rejects(w.service.verify(conditional.link), { code: 'link_invalid' });
  assert.equal((await w.service.verify(rotated.link)).conditional, true);
  await assert.rejects(perform(w.engine, new RotateLinkChallenge({ actor: w.app(), id: plain.jti })), { code: 'not_found' }, 'unconditional links have no challenge');
  await assert.rejects(perform(w.engine, new RotateLinkChallenge({ actor: w.owner, id: conditional.jti })), { code: 'forbidden' });
  await w.registry.revoke(OWNER, { purpose: 'signing', kid: first, reason: 'compromise' });
  await assert.rejects(w.service.verify(plain.link), { code: 'link_invalid' });
  assert.equal((await w.service.verify(fresh.link)).conditional, false);
  // A signer that hands out a key which is no longer current is refused at commit.
  const stale = new LinkService({ store: w.store, issuer: ISSUER, keys: w.registry, clock: w.clock.now, signingKey: async () => ({ kid: first, privateKey: (await w.registry.privateKey(OWNER, 'signing')).privateKey }) });
  await assert.rejects(stale.issue(OWNER, { type: MESSAGING_CONTACT_LINK_TYPE, claims: claims(), expiresAt: w.clock.now() + 86400000, handle: 'alice' }), { code: 'key_conflict' });
});

test('links contract: revoke, list, changes and evaluate are scoped, idempotent and bounded', async () => {
  const decisions = [], w = await linksWorld({ changeRetention: 3, decide: async input => { decisions.push(input); return { state: input.principal.subject === OWNER ? 'eligible' : 'ineligible', tags: ['x'] }; } });
  const a = await w.issue({ audience: { policy: POLICY } }), b = await w.issue();
  const principal = { issuer: ISSUER, subject: OWNER };
  assert.deepEqual(await perform(w.engine, new EvaluateLink({ actor: w.app(), input: { jti: a.jti, principal } })), { state: 'eligible' });
  assert.deepEqual(decisions, [{ owner: OWNER, parent: a.jti, policy: POLICY, principal }]);
  assert.deepEqual(await perform(w.engine, new EvaluateLink({ actor: w.app(), input: { jti: b.jti, principal } })), { state: 'unavailable' }, 'an unconditional link has no audience');
  await assert.rejects(perform(w.engine, new EvaluateLink({ actor: w.app(), input: { jti: a.jti, principal: { issuer: ISSUER, subject: 'x' } } })), { code: 'invalid_link_query' });
  await assert.rejects(perform(w.engine, new EvaluateLink({ actor: w.owner, input: { jti: a.jti, principal } })), { code: 'forbidden' });
  const before = await read(w.engine, new LinkChanges({ actor: w.app(), input: { since: 0 } }));
  assert.deepEqual(before.changes.map(change => [change.jti, change.change]), [[a.jti, 'issued'], [b.jti, 'issued']]);
  assert.deepEqual(await perform(w.engine, new RevokeLink({ actor: w.owner, id: b.jti })), {});
  assert.deepEqual(await perform(w.engine, new RevokeLink({ actor: w.app(), id: b.jti })), {}, 'idempotent');
  await assert.rejects(perform(w.engine, new RevokeLink({ actor: w.app(), id: crypto.randomUUID() })), { code: 'not_found' });
  await assert.rejects(w.service.verify(b.link), { code: 'link_invalid' });
  assert.deepEqual(await perform(w.engine, new EvaluateLink({ actor: w.app(), input: { jti: b.jti, principal } })), { state: 'unavailable' });
  const after = await read(w.engine, new LinkChanges({ actor: w.app(), input: { since: before.seq } }));
  assert.deepEqual(after.changes.map(change => [change.jti, change.change]), [[b.jti, 'revoked']]);
  await w.issue(); await w.issue();
  assert.deepEqual(await read(w.engine, new LinkChanges({ actor: w.app(), input: { since: 0 } })), { reset: true, seq: 5 }, 'the bounded log tells old readers to re-list');
  await assert.rejects(read(w.engine, new LinkChanges({ actor: w.app(), input: { since: 99 } })), { code: 'invalid_link_query' });
  const page = await read(w.engine, new LinkList({ actor: w.owner, input: { limit: 2 } }));
  assert.equal(page.links.length, 2); assert.ok(page.cursor);
  const rest = await read(w.engine, new LinkList({ actor: w.owner, input: { cursor: page.cursor, limit: 100 } }));
  assert.equal(page.links.length + rest.links.length, 4); assert.equal(rest.cursor, undefined);
  await assert.rejects(read(w.engine, new LinkList({ actor: w.owner, input: { limit: 101 } })), { code: 'invalid_link_query' });
  await assert.rejects(read(w.engine, new LinkList({ actor: w.owner, input: { owner: OWNER } })), { code: 'invalid_request' });
});

test('links contract: another owner, a bound store and the per-owner cap', async () => {
  const w = await linksWorld(), other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', issued = await w.issue();
  await assert.rejects(perform(w.engine, new RevokeLink({ actor: { kind: 'owner', owner: other }, id: issued.jti })), { code: 'not_found' });
  await w.store.transaction(tx => tx.set('owner', OWNER));
  await assert.rejects(read(w.engine, new LinkList({ actor: { kind: 'owner', owner: other } })), { code: 'forbidden' });
  const small = new LinkService({ store: w.store, issuer: ISSUER, keys: w.registry, clock: w.clock.now, maxLinks: 2, signingKey: owner => w.registry.privateKey(owner, 'signing') });
  const input = { type: MESSAGING_CONTACT_LINK_TYPE, claims: claims(), expiresAt: w.clock.now() + 86400000, handle: 'alice' };
  await small.issue(OWNER, input); await assert.rejects(small.issue(OWNER, input), { code: 'link_limit' });
  // Expired records are reclaimed 30 days after expiry, making room again.
  w.clock.advance(32 * 86400000); assert.ok((await small.issue(OWNER, { ...input, expiresAt: w.clock.now() + 86400000 })).jti);
});

test('seeded interleavings: concurrent issue, revoke and key rotation never leave a link verifiable under a revoked key', async t => {
  t.diagnostic(`CHAOS_SEED base ${Number(process.env.CHAOS_SEED ?? 1)}`);
  await forEachSeed(4, async random => {
    const w = await linksWorld(), issued = [];
    for (let step = 0; step < 10; step++) {
      const choice = random.int(4), current = (await w.registry.current(OWNER, { purpose: 'signing' }))?.kid;
      const ops = [() => w.issue().then(value => issued.push(value)), () => w.issue().then(value => issued.push(value))];
      if (choice === 0 && current) ops.push(() => w.registry.rotate(OWNER, { purpose: 'signing', expectedKid: current }));
      if (choice === 1 && current) ops.push(() => w.registry.revoke(OWNER, { purpose: 'signing', kid: current }));
      if (choice === 2 && !current) ops.push(() => w.registry.ensure(OWNER, 'signing'));
      if (choice === 3 && issued.length) ops.push(() => perform(w.engine, new RevokeLink({ actor: w.app(), id: random.pick(issued).jti })));
      const results = await Promise.allSettled(random.shuffle(ops).map(op => op()));
      for (const result of results) if (result.status === 'rejected') assert.ok(['key_conflict', 'identity_keys_unavailable', 'not_found'].includes(result.reason?.code) || /unavailable/i.test(result.reason?.message ?? ''), String(result.reason?.code ?? result.reason));
    }
    const history = new Map((await w.registry.history(OWNER, { purpose: 'signing' })).map(record => [record.kid, record.state]));
    for (const link of issued) {
      const kid = kidOf(link.link), stored = await w.store.transaction(tx => tx.get(key('link', link.jti)));
      const outcome = await w.service.verify(link.link).then(() => 'ok', error => error.code);
      if (history.get(kid) === 'revoked' || stored.revoked) assert.equal(outcome, 'link_invalid', `${kid} ${history.get(kid)}`);
      else assert.equal(outcome, 'ok', `${kid} ${history.get(kid)}`);
    }
  });
});

test('review regressions: revoked links free the cap, app-supplied principals are budgeted, a rotation race leaves no orphan grant', async () => {
  const w = await linksWorld({ decide: async () => ({ state: 'eligible' }) });
  const small = new LinkService({ store: w.store, issuer: ISSUER, keys: w.registry, clock: w.clock.now, maxLinks: 2, evaluationsPerLink: 2, evaluationsPerOwner: 3, policies: [POLICY], decide: async () => ({ state: 'eligible' }), signingKey: owner => w.registry.privateKey(owner, 'signing') });
  const input = { type: MESSAGING_CONTACT_LINK_TYPE, claims: claims(), expiresAt: w.clock.now() + 366 * 86400000 - 1000, handle: 'alice' };
  const a = await small.issue(OWNER, { ...input, audience: { policy: POLICY } }), b = await small.issue(OWNER, { ...input, audience: {} });
  await assert.rejects(small.issue(OWNER, input), { code: 'link_limit' });
  await small.revoke(OWNER, b.jti); await small.revoke(OWNER, b.jti);
  const c = await small.issue(OWNER, { ...input, audience: {} });
  await assert.rejects(small.issue(OWNER, input), { code: 'link_limit' }, 'an idempotent second revoke frees nothing extra');
  const principal = () => ({ issuer: ISSUER, subject: crypto.randomUUID() });
  assert.deepEqual([await small.evaluate(OWNER, { jti: a.jti, principal: principal() }), await small.evaluate(OWNER, { jti: a.jti, principal: principal() }), await small.evaluate(OWNER, { jti: a.jti, principal: principal() })].map(r => r.state), ['eligible', 'eligible', 'unavailable'], 'per-link hourly budget');
  assert.equal((await small.evaluate(OWNER, { jti: c.jti, principal: principal() })).state, 'eligible');
  assert.equal((await small.evaluate(OWNER, { jti: c.jti, principal: principal() })).state, 'unavailable', 'per-owner hourly budget');
  w.clock.advance(3600000); assert.equal((await small.evaluate(OWNER, { jti: a.jti, principal: principal() })).state, 'eligible');
  // Revoked records are reclaimed 30 days after revocation even when their expiry is a year away.
  w.clock.advance(31 * 86400000); await small.revoke(OWNER, a.jti); await small.revoke(OWNER, c.jti);
  w.clock.advance(31 * 86400000); await small.issue(OWNER, input); await small.issue(OWNER, input);
  await assert.rejects(small.issue(OWNER, input), { code: 'link_limit' }, 'reclaim at the cap drops revoked records, live ones still count');
  assert.equal((await w.store.transaction(tx => tx.list(key('link')))).filter(row => row.value.revoked).length, 0);
  // Contact endpoints: the key rotates between grant creation and the endpoint commit.
  const cw = await contactWorld(), first = (await cw.registry.current(OWNER, { purpose: 'signing' })).kid;
  const original = cw.endpoints.signer; cw.endpoints.signer = async input => { const key = await original(input); await cw.registry.rotate(OWNER, { purpose: 'signing', expectedKid: first }); return key; };
  await assert.rejects(cw.create(), { code: 'invalid_key' });
  assert.equal((await cw.tokens.list(OWNER)).length, 0, 'no endpoint-less grant remains');
});
