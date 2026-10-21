// BB-C1b descriptor and slot handoff, end to end in process: the core links contract (LinkService + links engine,
// app actors admitted through the occupancy port) issues a contact link for the messaging-ingress occupant; the
// provider's `messaging-address` handoff resolves the link to the occupant's ingress; a same-host sender delivers to
// that ingress; the BindleBox occupant admits it through B2's receive path, and conditional links are evaluated by
// the host on a host-verified author proof. Also: occupant replacement (the previous app loses link authority; links
// are inherited provisionally per DEVLOG), the links contract resource method and the manifest declaration row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMessagingStore } from '../packages/messaging/index.mjs';
import { IdentityKeyRegistry } from '../packages/identity/keys.mjs';
import { encodeDelegationCertificate, jwkThumbprint } from '../packages/identity/delegation.mjs';
import { LinkService } from '../packages/links/issuance.mjs';
import { linksProvider, IssueLink, RevokeLink, EvaluateLink, LinkList } from '../packages/links/engine.mjs';
import { verifyAuthorProof, ENVELOPE_DOMAIN, jcs } from '../packages/links/author-proof.mjs';
import { LinkHandoff, validateDescribe } from '../packages/links/handoff.mjs';
import { MESSAGING_INGRESS_SLOT, MESSAGING_CONTACT_LINK_TYPE, MESSAGING_PROFILE, DESCRIPTOR_MEDIA_TYPE, LINK_SLOT_TABLE, LINKS_CONTRACT, MESSAGING_ADDRESS_DECLARATION } from '../packages/links/types.mjs';
import { contactIntent } from '../packages/links/preview.mjs';
import { linksResourceMethod } from '../packages/runtime/account/links.mjs';
import { RESOURCE_METHOD_HANDLERS } from '../packages/runtime/account/storage.mjs';
import { MANIFEST_DECLARATIONS, federationDeclarations } from '../packages/runtime/federation.mjs';
import { createAppEngine, perform, read } from '../packages/app/engine.mjs';
import { memoryAudit } from '../packages/app/providers.mjs';
import { fakeClock } from './helpers/chaos.mjs';
import { createTestEngine, memoryStore } from './bindlebox/helpers/engine.mjs';
import { ContactsDomain, ReceiveDomain } from '../packages/bindlebox-engine/store/mailbox.mjs';
import { createEdgeIndex, flushEdgeOutbox } from '../packages/bindlebox-engine/store/edge-index.mjs';
import { ReceiveDeliver, handleIngress } from '../packages/bindlebox-engine/domains/receive.mjs';
import * as B from '../packages/bindlebox-protocol/index.mjs';

const ISSUER = 'https://3sln.example', POLICY = 'https://3sln.example/policies/developer-contact/v1', DAY = 86400000;
const BOB = 'b0b00000-0000-4000-8000-000000000002', ALICE = 'a11ce000-0000-4000-8000-000000000001', CAROL = 'ca401000-0000-4000-8000-000000000003';
const BOX_A = { clientId: 'https://box-a.example/client.json', origin: 'https://box-a.example' }, BOX_B = { clientId: 'https://box-b.example/client.json', origin: 'https://box-b.example' };
const encoder = new TextEncoder(), ES = { name: 'ECDSA', namedCurve: 'P-256' };
const pub = ({ kty, crv, x, y }) => ({ kty, crv, x, y });
const principalOf = subject => ({ issuer: ISSUER, subject, identityURI: `${ISSUER}/identity/${subject}` });
const describeBody = origin => ({ version: 1, profiles: [MESSAGING_PROFILE], ingress: `${origin}/ingress`, kinds: ['conversation-init', 'one-off'], limits: { maxParticipants: 32, maxMessageBytes: 1048576, maxEnvelopeBytes: 65536 } });

// A same-host principal: an identity key in the provider registry and a delegate key certified by CORE's encoder.
async function party(subject, registry, clock, { client = BOX_A, purposes } = {}) {
  await registry.ensure(subject, 'signing');
  const identity = await registry.privateKey(subject, 'signing'), delegate = await crypto.subtle.generateKey(ES, true, ['sign', 'verify']), jwk = pub(await crypto.subtle.exportKey('jwk', delegate.publicKey)), jkt = await jwkThumbprint(jwk), iat = Math.floor(clock.now() / 1000) - 60;
  const certify = async (over = {}) => encodeDelegationCertificate({ bindle: 'key-delegation', v: 1, iss: ISSUER, sub: subject, delegate: jwk, jkt, purposes: purposes ?? [B.PURPOSES.author, B.PURPOSES.receipt].sort(), client: { client_id: client.clientId, origin: client.origin, ingress: `${client.origin}/ingress` }, cnx: `cnx-${subject.slice(0, 4)}`, since: iat - DAY / 1000, jti: `cert-${subject.slice(0, 4)}`, iat, exp: iat + 86400, ...over }, identity);
  const delegation = await certify(), principal = principalOf(subject);
  return { subject, principal, jkt, jwk, certify, signer: { privateKey: delegate.privateKey, delegation, kid: `jkt:${jkt}` }, author: { principal, identityDocument: `${principal.identityURI}/document.json`, keyId: identity.kid, delegate: `jkt:${jkt}` } };
}

async function world({ seed = Number(process.env.CHAOS_SEED ?? 1) } = {}) {
  const clock = fakeClock(Date.UTC(2026, 9, 20, 12)), seal = value => structuredClone(value), open = value => value;
  const stores = { [BOB]: new MemoryMessagingStore(), [ALICE]: new MemoryMessagingStore(), [CAROL]: new MemoryMessagingStore() };
  const registries = Object.fromEntries(Object.entries(stores).map(([subject, store]) => [subject, new IdentityKeyRegistry({ store, clock: clock.now, seal, open })]));
  const revoked = new Set(), decisions = [], calls = { describe: 0, statusThrows: false, keyThrows: false };
  // Host ports: same-host principals only, CURRENT signing key, delegation status from the author's account.
  const hostPorts = {
    resolveKey: async ({ issuer, subject, kid }) => { if (calls.keyThrows) throw new Error('directory down'); if (issuer !== ISSUER || !registries[subject]) return null; const r = await registries[subject].lookup(subject, { purpose: 'signing', kid }); return r?.current ? { alg: r.alg, publicJwk: r.publicJwk } : null; },
    status: async ({ jkt }) => { if (calls.statusThrows) throw new Error('status down'); return { status: revoked.has(jkt) ? 'revoked' : 'active' }; },
  };
  const seat = { value: { ...BOX_A, generation: 1 } };
  const occupant = async ({ owner, slot }) => (owner === BOB && slot === MESSAGING_INGRESS_SLOT ? seat.value : null);
  const service = new LinkService({ store: stores[BOB], issuer: ISSUER, keys: registries[BOB], clock: clock.now, policies: [POLICY], signingKey: owner => registries[BOB].privateKey(owner, 'signing'), decide: async input => { decisions.push(input); return { state: input.principal.subject === ALICE ? 'eligible' : 'ineligible' }; }, verifyAuthor: input => verifyAuthorProof(input.proof, { ...input, ...hostPorts }) });
  const core = createAppEngine({ providers: { clock, random: { uuid: () => crypto.randomUUID() }, audit: memoryAudit({ clock }), links: linksProvider({ service, enabled: true, occupant }) } });
  const describers = { [BOX_A.clientId]: () => describeBody(BOX_A.origin), [BOX_B.clientId]: () => describeBody(BOX_B.origin) };
  const handoff = new LinkHandoff({ service, occupant, clock: clock.now, describe: async ({ occupant: o }) => { calls.describe++; return describers[o.clientId](); } });
  const actor = (box, generation = seat.value.generation) => ({ kind: 'app', owner: BOB, clientId: box.clientId, handle: 'bob', generation });
  // The occupant's providerLink: what the BindleBox app shell sends over the links contract (bindlebox §4.2).
  const providerLink = (box, generation) => ({
    async issue({ type, claims }) { const { sub, audience, ...members } = claims; assert.equal(sub, BOB); return perform(core, new IssueLink({ actor: actor(box, generation), input: { type, claims: members, expiresAt: clock.now() + 30 * DAY, ...(audience ? { audience: audience.policy ? { policy: audience.policy } : {} } : {}) } })); },
    revoke: ({ jti }) => perform(core, new RevokeLink({ actor: actor(box, generation), id: jti })),
    evaluate: input => perform(core, new EvaluateLink({ actor: actor(box, generation), input })),
  });
  const parties = { alice: await party(ALICE, registries[ALICE], clock), carol: await party(CAROL, registries[CAROL], clock), bob: await party(BOB, registries[BOB], clock) };
  // Bob's mailbox at box A: B2 receive over a directory backed by the provider registries.
  const edge = createEdgeIndex(memoryStore());
  const mailbox = async (box, generation) => {
    const store = memoryStore([['owner', BOB]]), signer = { ...parties.bob.signer, delegation: await parties.bob.certify({ client: { client_id: box.clientId, origin: box.origin, ingress: `${box.origin}/ingress` } }) };
    const directory = { resolveKey: async ({ issuer, subject, keyId }) => { const r = issuer === ISSUER && registries[subject] ? await registries[subject].lookup(subject, { purpose: 'signing', kid: keyId }) : null; return r?.verifiable ? { keyId, publicJwk: r.publicJwk, identityURI: `${ISSUER}/identity/${subject}` } : null; }, status: hostPorts.status };
    const e = createTestEngine({ seed, owner: BOB, clock, store, providers: { contacts: ContactsDomain, receive: ReceiveDomain, directory, delegateKeys: { current: async () => signer }, providerLink: providerLink(box, generation), userStorage: null, classifier: null } });
    await e.run('receive.configure', { input: { principal: principalOf(BOB), ingress: `${box.origin}/ingress` } });
    return { ...e, box, async link(input = {}) { const created = await e.run('contacts.create-link', { input }); await flushEdgeOutbox(store, edge, BOB); return created; } };
  };
  // A sender: resolve the descriptor from the link (as an intent handler does), then POST the authored envelope.
  const send = async (target, from, link, { operationId = crypto.randomUUID(), text = 'Hello', createdAt = clock.now() - 1000 } = {}) => {
    const descriptor = await handoff.descriptor(link.link), meta = new URL(link.link).searchParams.get('bindle_meta'), body = encoder.encode(text);
    const envelope = await B.signEnvelope({ version: 1, profile: B.PROFILE, kind: 'one-off', noReply: true, operationId, createdAt, recipient: { issuer: ISSUER, owner: BOB, contactId: link.jti, resource: link.resource }, content: await B.contentDescriptor('text/plain', body), subject: 'Hi', optionalTags: [], author: from.author }, from.signer);
    const { contentType, bytes } = B.encodeDelivery(envelope, { body, boundary: 'c1b' });
    const response = await handleIngress({ url: descriptor.ingress, method: 'POST', headers: { authorization: `BindleLink ${meta}`, 'content-type': contentType }, body: bytes }, { edge, now: clock.now, deliver: (owner, input) => { assert.equal(descriptor.ingress, `${target.box.origin}/ingress`, 'delivered where the descriptor pointed'); return target.perform(new ReceiveDeliver({ actor: { kind: 'ingress', owner }, input })); } });
    return { status: response.status, json: await response.json(), envelope, descriptor };
  };
  return { clock, stores, registries, revoked, decisions, calls, seat, service, core, handoff, describers, actor, providerLink, parties, mailbox, send, hostPorts };
}

test('pins: core proof verification, certificates and descriptors match the BindleBox protocol library', async () => {
  const w = await world();
  assert.equal(ENVELOPE_DOMAIN, B.DOMAINS.envelope);
  assert.deepEqual(LINK_SLOT_TABLE, [{ type: MESSAGING_CONTACT_LINK_TYPE, slot: MESSAGING_INGRESS_SLOT }]);
  assert.equal(MESSAGING_CONTACT_LINK_TYPE, B.CONTACT_LINK_TYPE); assert.equal(MESSAGING_INGRESS_SLOT, B.INGRESS_SLOT); assert.equal(MESSAGING_PROFILE, B.PROFILE); assert.equal(DESCRIPTOR_MEDIA_TYPE, B.DESCRIPTOR_MEDIA_TYPE);
  // Core-encoded certificates parse under the protocol's strict parser; JCS readings agree.
  assert.equal(B.parseDelegation(w.parties.alice.signer.delegation).claims.sub, ALICE);
  const value = { b: [1, 'x', { d: null, c: true }], a: 'ü' }; assert.equal(jcs(value), B.jcs(value));
  for (const bad of [1.5, -0, 2 ** 60, '\ud800']) { assert.throws(() => jcs(bad), { code: 'author_proof_invalid' }); assert.throws(() => B.jcs(bad)); }
  // validateDescribe accepts what the protocol's descriptor validator accepts, and refuses an off-origin ingress.
  const body = describeBody(BOX_A.origin); assert.ok(validateDescribe(body, { origin: BOX_A.origin })); B.validateDescriptor(body, { describe: true });
  assert.equal(validateDescribe(body, { origin: BOX_B.origin }), null);
  for (const over of [{ version: 2 }, { profiles: ['https://other.example/p'] }, { ingress: 'http://box-a.example/ingress' }, { ingress: 'https://box-a.example/ingress?x=1' }, { limits: { maxParticipants: 33, maxMessageBytes: 1, maxEnvelopeBytes: 1 } }, { kinds: ['one-off', 'conversation-init'] }, { multicast: 'https://elsewhere.example/m' }, { extra: true }]) assert.equal(validateDescribe({ ...body, ...over }), null, JSON.stringify(over));
});

test('handoff end to end: provider contact link -> descriptor -> occupant ingress -> B2 admission, with host-verified author proofs on conditional links', async () => {
  const w = await world(), box = await w.mailbox(BOX_A, 1);
  const plain = await box.link();
  const descriptor = await w.handoff.descriptor(plain.link);
  assert.deepEqual(Object.keys(descriptor).sort(), ['expiresAt', 'ingress', 'kinds', 'limits', 'profiles', 'version']);
  assert.equal(descriptor.ingress, 'https://box-a.example/ingress'); assert.deepEqual(descriptor.kinds, ['one-off'], "the link's signed kinds");
  assert.ok(descriptor.expiresAt <= w.clock.now() + 3600000); B.validateDescriptor(descriptor, { now: w.clock.now() });
  // An intent handler gets the same capability: the canonical contact-url resolves to the same descriptor.
  const intent = new URL(contactIntent('send-message', plain.link)); assert.equal(intent.protocol, 'web+bindle:');
  assert.deepEqual(await w.handoff.descriptor(intent.searchParams.get('contact-url')), descriptor);
  assert.equal(w.calls.describe, 1, 'describe results are cached per occupant');
  const delivered = await w.send(box, w.parties.alice, plain, { text: 'Hello through the handoff' });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
  const items = (await box.run('receive.items')).items; assert.equal(items.length, 1); assert.equal(items[0].author.principal.subject, ALICE); assert.equal(items[0].author.verified, true);
  // Conditional link: the occupant evaluates with the envelope as author proof; the host verifies it itself.
  const conditional = await box.link({ conditional: true, policy: POLICY });
  assert.equal((await w.send(box, w.parties.alice, conditional)).status, 200);
  assert.deepEqual(w.decisions.map(d => [d.parent, d.principal.subject, d.policy]), [[conditional.jti, ALICE, POLICY]]);
  const carol = await w.send(box, w.parties.carol, conditional); assert.equal(carol.status, 403); assert.equal(carol.json.error, 'audience_ineligible');
  // The occupant cannot reuse one author's envelope to evaluate another principal.
  await assert.rejects(perform(w.core, new EvaluateLink({ actor: w.actor(BOX_A), input: { jti: conditional.jti, principal: { issuer: ISSUER, subject: ALICE }, proof: carol.envelope } })), { code: 'author_proof_invalid' }, "carol's envelope is not alice's proof");
});

test('evaluate: a bare principal, a misbound, tampered, stale, cross-host, revoked or unverifiable proof never reaches the policy', async () => {
  const w = await world(), box = await w.mailbox(BOX_A, 1), link = await box.link({ conditional: true, policy: POLICY }), unconditional = await box.link();
  const alice = w.parties.alice, sign = (over = {}, signer = alice.signer, author = alice.author) => B.signEnvelope({ version: 1, profile: B.PROFILE, kind: 'one-off', noReply: true, operationId: crypto.randomUUID(), createdAt: w.clock.now() - 1000, recipient: { issuer: ISSUER, owner: BOB, contactId: link.jti, resource: link.resource }, content: { mimeType: 'text/plain', byteLength: 1, sha256: 'A'.repeat(43) }, subject: 'x', optionalTags: [], author, ...over }, signer);
  const evaluate = (proof, principal = { issuer: ISSUER, subject: ALICE }, jti = link.jti) => perform(w.core, new EvaluateLink({ actor: w.actor(BOX_A), input: { jti, principal, proof } }));
  assert.deepEqual(await evaluate(await sign()), { state: 'eligible' });
  await assert.rejects(perform(w.core, new EvaluateLink({ actor: w.actor(BOX_A), input: { jti: link.jti, principal: { issuer: ISSUER, subject: ALICE } } })), { code: 'author_proof_required' });
  await assert.rejects(evaluate(await sign(), { issuer: ISSUER, subject: CAROL }), { code: 'author_proof_invalid' }, 'another principal');
  await assert.rejects(evaluate(await sign({ recipient: { issuer: ISSUER, owner: BOB, contactId: unconditional.jti, resource: unconditional.resource } })), { code: 'author_proof_invalid' }, 'a delivery to another link');
  await assert.rejects(evaluate(await sign({ recipient: { issuer: ISSUER, owner: CAROL, contactId: link.jti, resource: link.resource } })), { code: 'author_proof_invalid' }, 'another owner');
  const tampered = await sign(); tampered.payload.subject = 'changed'; await assert.rejects(evaluate(tampered), { code: 'author_proof_invalid' });
  await assert.rejects(evaluate(await sign({ createdAt: w.clock.now() - 2 * DAY })), { code: 'author_proof_invalid' }, 'outside the link window');
  await assert.rejects(evaluate({ payload: {}, proof: {} }), { code: 'author_proof_invalid' });
  // A certificate without the author purpose, or one signed by someone else's identity key.
  const noAuthor = await party(ALICE, w.registries[ALICE], w.clock, { purposes: [B.PURPOSES.receipt] });
  await assert.rejects(evaluate(await sign({}, noAuthor.signer, noAuthor.author)), { code: 'author_proof_invalid' });
  const carolKey = await w.registries[CAROL].privateKey(CAROL, 'signing'), forgedCert = await encodeDelegationCertificate({ ...B.parseDelegation(alice.signer.delegation).claims }, carolKey);
  await assert.rejects(evaluate(await sign({}, { ...alice.signer, delegation: forgedCert }, { ...alice.author, keyId: carolKey.kid })), { code: 'author_proof_invalid' });
  // Cross-host principals are unverifiable until the directory profile exists.
  const remote = { ...alice.author, principal: { issuer: 'https://other.example', subject: ALICE, identityURI: `https://other.example/identity/${ALICE}` }, identityDocument: `https://other.example/identity/${ALICE}/d.json` };
  await assert.rejects(evaluate(await sign({}, alice.signer, remote), { issuer: 'https://other.example', subject: ALICE }), { code: 'author_proof_invalid' });
  // Lookups that fail are `unavailable`, never eligible; a revoked delegate key or a rotated identity key is invalid.
  w.calls.keyThrows = true; assert.deepEqual(await evaluate(await sign()), { state: 'unavailable' }); w.calls.keyThrows = false;
  w.calls.statusThrows = true; assert.deepEqual(await evaluate(await sign()), { state: 'unavailable' }); w.calls.statusThrows = false;
  w.revoked.add(alice.jkt); await assert.rejects(evaluate(await sign()), { code: 'author_proof_invalid' }); w.revoked.delete(alice.jkt);
  const first = await w.registries[ALICE].current(ALICE, { purpose: 'signing' }); await w.registries[ALICE].rotate(ALICE, { purpose: 'signing', expectedKid: first.kid });
  await assert.rejects(evaluate(await sign()), { code: 'author_proof_invalid' }, 'a certificate under a retired identity key');
  assert.equal(w.decisions.length, 1, 'only the valid proof reached the policy');
  // Review LH-5: the delivery's resource must be the link's; certificates longer than 24 h or with duplicate members
  // are refused like the protocol library refuses them.
  const fresh = await party(ALICE, w.registries[ALICE], w.clock), signFresh = over => sign(over, fresh.signer, fresh.author);
  await assert.rejects(evaluate(await signFresh({ recipient: { issuer: ISSUER, owner: BOB, contactId: link.jti, resource: 'other' } })), { code: 'author_proof_invalid' });
  const claims = B.parseDelegation(fresh.signer.delegation).claims, key = await w.registries[ALICE].privateKey(ALICE, 'signing');
  const long = await encodeDelegationCertificate({ ...claims, exp: claims.iat + 2 * 86400 }, key);
  const swap = async delegation => { const e = await signFresh(); e.proof.delegation = delegation; return e; }; // the delegation is outside the signing input
  await assert.rejects(evaluate(await swap(long)), { code: 'author_proof_invalid' });
  const b64 = v => Buffer.from(v).toString('base64url'), head = `${b64(JSON.stringify({ alg: 'ES256', kid: key.kid, typ: 'bindle-key-delegation+jwt' }))}.${b64(JSON.stringify(claims).replace('"v":1', '"v":2,"v":1'))}`;
  const dup = `${head}.${b64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, encoder.encode(head))))}`;
  assert.throws(() => B.parseDelegation(dup));
  await assert.rejects(evaluate(await swap(dup)), { code: 'author_proof_invalid' });
  assert.deepEqual(await evaluate(await signFresh()), { state: 'eligible' });
  // Unconditional links have no audience; budgets still bound everything (60 per link per hour).
  assert.deepEqual(await evaluate(await sign(), undefined, unconditional.jti), { state: 'unavailable' });
  // Review LH-1: a flood of proofs that fail verification (e.g. other-host authors) never spends the evaluation budget.
  const other = await box.link({ conditional: true, policy: POLICY }), signOther = (over = {}) => B.signEnvelope({ version: 1, profile: B.PROFILE, kind: 'one-off', noReply: true, operationId: crypto.randomUUID(), createdAt: w.clock.now() - 1000, recipient: { issuer: ISSUER, owner: BOB, contactId: other.jti, resource: other.resource }, content: { mimeType: 'text/plain', byteLength: 1, sha256: 'A'.repeat(43) }, subject: 'x', optionalTags: [], author: fresh.author, ...over }, fresh.signer);
  const foreign = { ...fresh.author, principal: { issuer: 'https://other.example', subject: ALICE, identityURI: `https://other.example/identity/${ALICE}` }, identityDocument: `https://other.example/identity/${ALICE}/d.json` };
  for (let i = 0; i < 70; i++) await assert.rejects(perform(w.core, new EvaluateLink({ actor: w.actor(BOX_A), input: { jti: other.jti, principal: { issuer: 'https://other.example', subject: ALICE }, proof: await signOther({ author: foreign }) } })), { code: 'author_proof_invalid' });
  assert.deepEqual(await perform(w.core, new EvaluateLink({ actor: w.actor(BOX_A), input: { jti: other.jti, principal: { issuer: ISSUER, subject: ALICE }, proof: await signOther() } })), { state: 'eligible' });
});

test('occupant replacement: the previous app loses link authority, the new one inherits the links (provisional), and the descriptor follows the seat', async () => {
  const w = await world(), boxA = await w.mailbox(BOX_A, 1), plain = await boxA.link(), conditional = await boxA.link({ conditional: true, policy: POLICY });
  assert.equal((await w.handoff.descriptor(plain.link)).ingress, 'https://box-a.example/ingress');
  w.seat.value = { ...BOX_B, generation: 2 };
  // Box A: no issue, list, evaluate or revoke; its conditional admissions fail closed as audience_unavailable.
  await assert.rejects(boxA.link(), { code: 'forbidden' });
  await assert.rejects(read(w.core, new LinkList({ actor: w.actor(BOX_A, 1) })), { code: 'forbidden' });
  await assert.rejects(perform(w.core, new RevokeLink({ actor: w.actor(BOX_A, 1), id: plain.jti })), { code: 'forbidden' });
  const boxB = await w.mailbox(BOX_B, 2);
  // Box B lists A's links with the generation that issued them (bindlebox §4.2: offer bulk revoke and reissue).
  const listed = await read(w.core, new LinkList({ actor: w.actor(BOX_B, 2) }));
  assert.deepEqual(listed.links.map(link => [link.jti, link.occupantGeneration]).sort(), [[plain.jti, 1], [conditional.jti, 1]].sort());
  // The descriptor now points at B (the cache is keyed on the seat); a stale generation of B is refused.
  assert.equal((await w.handoff.descriptor(plain.link)).ingress, 'https://box-b.example/ingress');
  await assert.rejects(read(w.core, new LinkList({ actor: w.actor(BOX_B, 1) })), { code: 'forbidden' });
  // A suspended-and-resumed A (new generation) cannot use its old credential either.
  w.seat.value = { ...BOX_A, generation: 3 };
  await assert.rejects(read(w.core, new LinkList({ actor: w.actor(BOX_A, 1) })), { code: 'forbidden' });
  w.seat.value = { ...BOX_B, generation: 2 };
  // B revokes an inherited link; no seat, a failing describe or an invalid describe are one uniform answer.
  assert.deepEqual(await perform(w.core, new RevokeLink({ actor: w.actor(BOX_B, 2), id: conditional.jti })), {});
  await assert.rejects(w.handoff.descriptor(conditional.link), { code: 'link_invalid' });
  w.describers[BOX_B.clientId] = () => describeBody('https://elsewhere.example');
  const fresh = new LinkHandoff({ service: w.service, occupant: async () => ({ ...BOX_B, generation: 2 }), clock: w.clock.now, describe: async () => describeBody('https://elsewhere.example') });
  await assert.rejects(fresh.descriptor(plain.link), { code: 'recipient_unavailable' });
  for (const occupant of [async () => null, async () => { throw new Error('port down'); }]) await assert.rejects(new LinkHandoff({ service: w.service, occupant, describe: async () => describeBody(BOX_B.origin) }).descriptor(plain.link), { code: 'recipient_unavailable' });
  await assert.rejects(new LinkHandoff({ service: w.service, occupant: async () => ({ ...BOX_B, generation: 2 }) }).descriptor(plain.link), { code: 'recipient_unavailable' }, 'no describe port');
  await assert.rejects(new LinkHandoff({ service: w.service, occupant: async () => ({ ...BOX_B, generation: 2 }), describe: async () => { throw new Error('down'); } }).descriptor(plain.link), { code: 'recipient_unavailable' });
  await assert.rejects(w.handoff.descriptor(`${plain.link}&bindle_data=a.b.c`), { code: 'link_malformed' });
  await assert.rejects(w.handoff.descriptor(plain.link.replace('/bob/', '/eve/')), { code: 'link_invalid' });
  // Delivery through B, after B issues its own link.
  const mine = await boxB.link(); assert.equal((await w.send(boxB, w.parties.alice, mine)).status, 200);
});

test('links contract resource method: the app actor comes only from verified context; writes are journaled per tx', async () => {
  const OWNER = BOB, ORIGIN = ISSUER, rows = new Map(), seen = [];
  const metadata = { get: async k => structuredClone(rows.get(k)), put: async (k, v) => { rows.set(k, structuredClone(v)); }, delete: async k => { for (const key of [k].flat()) rows.delete(key); }, list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...rows].filter(([k]) => k.startsWith(prefix)).slice(0, limit)) };
  const state = { epoch: true, account: { status: 'active', handle: 'bob' }, connection: true, seat: { clientId: BOX_A.clientId, connection: 'conn-1', generation: 4 } };
  const c = { config: { BINDLEBOX_ENABLED: 'true', APP_ORIGIN: ORIGIN, FEDERATION_IDENTITY_CHECK: async (owner, epoch) => state.epoch && owner === OWNER && epoch === 'e1', IDENTITY_ACCOUNT: async () => state.account, LINK_SLOT_OCCUPANT: async ({ owner, slot }) => (owner === OWNER && slot === MESSAGING_INGRESS_SLOT ? state.seat : null) }, metadata, warm: async () => {}, apps: { check: async (owner, id, generation, clientId) => { if (!state.connection || id !== 'conn-1' || generation !== 4 || clientId !== BOX_A.clientId) throw Object.assign(new Error('gone'), { code: 'invalid_token', status: 401 }); } }, linkOperation: async (owner, params) => { seen.push(structuredClone(params)); return { ok: seen.length }; } };
  const context = (over = {}) => ({ authority: 'bindle', resource: `${ORIGIN}/entities/${OWNER}/links`, resourceGeneration: OWNER, contract: LINKS_CONTRACT, method: 'list', args: {}, clientId: BOX_A.clientId, connection: { id: 'conn-1', generation: 4 }, epoch: 'e1', tx: crypto.randomUUID(), ...over });
  assert.equal(RESOURCE_METHOD_HANDLERS[LINKS_CONTRACT], linksResourceMethod);
  assert.deepEqual(await linksResourceMethod(c, OWNER, context()), { ok: 1 });
  assert.deepEqual(seen[0], { actor: { kind: 'app', owner: OWNER, clientId: BOX_A.clientId, handle: 'bob', generation: 4, connection: 'conn-1' }, operation: 'links.list', input: {} }, 'handle from identity, generation from the connection');
  await assert.rejects(linksResourceMethod({ ...c, config: { ...c.config, BINDLEBOX_ENABLED: 'false' } }, OWNER, context()), { code: 'not_found' });
  for (const over of [{ authority: 'oauth' }, { resource: `${ORIGIN}/entities/${CAROL}/links` }, { resourceGeneration: CAROL }, { contract: 'https://spec.bindle.example/contracts/other/v1' }, { connection: undefined }]) await assert.rejects(linksResourceMethod(c, OWNER, context(over)), { code: 'forbidden' }, JSON.stringify(over));
  await assert.rejects(linksResourceMethod(c, OWNER, context({ method: 'mint' })), { code: 'unsupported_method' });
  await assert.rejects(linksResourceMethod(c, OWNER, context({ epoch: 'stale' })), { code: 'unauthorized' });
  state.connection = false; await assert.rejects(linksResourceMethod(c, OWNER, context()), { code: 'invalid_token' }); state.connection = true;
  state.account = { status: 'suspended', handle: 'bob' }; await assert.rejects(linksResourceMethod(c, OWNER, context()), { code: 'forbidden' }); state.account = { status: 'active', handle: 'bob' };
  // Writes: one effect per tx; a replay returns the first result; reuse with other arguments is a conflict.
  const tx = crypto.randomUUID(), issue = context({ method: 'issue', tx, args: { type: MESSAGING_CONTACT_LINK_TYPE, claims: { resource: 'r' } } });
  const first = await linksResourceMethod(c, OWNER, issue), again = await linksResourceMethod(c, OWNER, issue);
  assert.deepEqual(again, first); assert.equal(seen.filter(p => p.operation === 'links.issue').length, 1);
  await assert.rejects(linksResourceMethod(c, OWNER, { ...issue, args: { ...issue.args, expiresAt: 1 } }), { code: 'tx_conflict' });
  await assert.rejects(linksResourceMethod(c, OWNER, context({ method: 'revoke', args: { jti: 'x' }, tx: 'nope' })), { code: 'invalid_args' });
  await assert.rejects(linksResourceMethod(c, OWNER, context({ method: 'revoke', args: { jti: 'x', owner: CAROL } })), { code: 'invalid_args' });
  assert.deepEqual(seen.at(-1).operation, 'links.issue');
  await linksResourceMethod(c, OWNER, context({ method: 'revoke', args: { jti: 'j1' } })); assert.deepEqual(seen.at(-1), { actor: seen[0].actor, operation: 'links.revoke', id: 'j1' });
  // Review LH-2/LH-8: a connected app without the seat (or at another generation) is refused before the journal: it
  // can neither fill it nor replay a cached result, and nothing is written.
  const journalSize = [...rows.keys()].filter(k => k.startsWith('links-rpc/')).length, calls = seen.length;
  for (const seat of [null, { clientId: BOX_A.clientId, generation: 4, connection: 'other' }, { clientId: BOX_B.clientId, generation: 4 }, { clientId: BOX_A.clientId, generation: 5 }]) { state.seat = seat; for (const ctx of [issue, context({ method: 'issue', args: {} }), context()]) await assert.rejects(linksResourceMethod(c, OWNER, ctx), { code: 'forbidden' }); }
  assert.equal([...rows.keys()].filter(k => k.startsWith('links-rpc/')).length, journalSize); assert.equal(seen.length, calls);
});

test('manifest: the messaging-address consumer row needs BINDLEBOX_ENABLED, EXTENSIONS_ENABLED and a mounted handoff', () => {
  const row = MANIFEST_DECLARATIONS.find(r => Array.isArray(r.flag) && r.flag.includes('BINDLEBOX_ENABLED'));
  assert.deepEqual(row.flag, ['BINDLEBOX_ENABLED', 'EXTENSIONS_ENABLED']);
  assert.equal(row.mounted({ target: 'authority', mounts: {} }), false); assert.equal(row.mounted({ target: 'entries', mounts: { messagingAddress: true } }), false);
  assert.equal(row.mounted({ target: 'authority', mounts: { messagingAddress: true } }), true);
  assert.deepEqual(row.declare({}), { extensions: [MESSAGING_ADDRESS_DECLARATION] });
  const config = { APP_ORIGIN: ISSUER, BINDLEBOX_ENABLED: 'true', EXTENSIONS_ENABLED: 'true' };
  assert.equal(federationDeclarations({ ...config, BINDLEBOX_ENABLED: 'false' }, { target: 'authority', mounts: { messagingAddress: true } }).extensions, undefined);
  // Flags and mount alone never advertise: the entry is kept only beside a declared extensions.v1 (not yet mounted).
  assert.equal(federationDeclarations(config, { target: 'authority', mounts: { messagingAddress: true } }).extensions, undefined);
});
