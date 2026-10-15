// Engine-level messaging fixture (not a test file): ContactDeliveryService and
// MessagingService over the in-memory store, a fake clock and fake identity and
// admission ports. `state()`/`conserved()` read only observable state: the owner
// message list, the accounting the quotas enforce, receipts and outbox events.
import assert from 'node:assert/strict';
import { MemoryMessagingStore, MessagingService } from '../../packages/messaging/index.mjs';
import { fail, key } from '../../packages/messaging/store.mjs';
import { createAuthoredEnvelope, localAuthorResolver, localIdentityDescriptor } from '../../packages/messaging/contact-delivery.mjs';
import { ContactDeliveryService } from '../../packages/messaging/contact-delivery-service.mjs';
import { fakeClock } from './chaos.mjs';

export const ISSUER = 'https://3sln.example', OWNER = '22222222-2222-4222-8222-222222222222', SENDER = '44444444-4444-4444-8444-444444444444', GRANT = '33333333-3333-4333-8333-333333333333';
export const COLLECTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', KID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', RESOURCE = `${ISSUER}/entities/${OWNER}/contacts/${GRANT}`;
export const RECIPIENT = { issuer: ISSUER, owner: OWNER, contactId: GRANT, resource: RESOURCE }, DAY = 86400000;
// Mid-day so UTC-day arithmetic is explicit wherever a test crosses midnight.
export const START = Date.UTC(2026, 9, 14, 12);
export const enc = new TextEncoder(), pair = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
export const [SENDER_KEY, ADMISSION_KEY] = await Promise.all([pair(), pair()]);
export const SENDER_JWK = await (async () => { const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', SENDER_KEY.publicKey); return { kty, crv, x, y }; })();
export const AUTHOR = localIdentityDescriptor(ISSUER, SENDER, KID);

export async function messagingFixture({ maxMessages = 10, maxBytes = 65536, maxMessageBytes = 16384, conditional = false, intake = { autoTags: ['contact:developer'], optionalTags: ['bug', 'feature'] }, maxStoredBytes, maxStoredMessages, wrap = store => store, audience } = {}) {
  const clock = fakeClock(START), raw = new MemoryMessagingStore(), store = wrap(raw);
  const keys = new Map([[SENDER + KID, { alg: 'ES256', publicJwk: SENDER_JWK, active: true, purpose: 'signing', accountActive: true }]]);
  await raw.transaction(async tx => {
    await tx.set(key('collection', OWNER, COLLECTION), { id: COLLECTION, owner: OWNER, name: 'Inbox', active: true });
    await tx.set(key('contact-grant', GRANT), { id: GRANT, owner: OWNER, active: true, messagesUsed: 0, bytesUsed: 0, claims: { collections: [COLLECTION], mimeTypes: ['text/plain'], maxMessages, maxBytes, maxMessageBytes }, delivery: { resource: RESOURCE, kinds: ['one-off'], collection: COLLECTION, ...conditional ? { conditional: true } : {} }, intake: { version: 1, revision: 1, labels: {}, updatedAt: START, ...intake } });
  });
  const parents = { verify: async credential => { if (credential !== GRANT) fail('unauthorized'); return { parent: credential }; }, live: async (tx, verified) => { const grant = await tx.get(key('contact-grant', verified.parent)); if (!grant?.active) fail('unauthorized'); return grant; } };
  const options = { store, issuer: ISSUER, parents, clock: clock.now, resolve: localAuthorResolver({ issuer: ISSUER, lookup: async (subject, kid) => structuredClone(keys.get(subject + kid)) }), admissionKey: async () => ({ kid: 'provider-1', privateKey: ADMISSION_KEY.privateKey }), audience };
  if (maxStoredBytes !== undefined) options.maxStoredBytes = maxStoredBytes;
  if (maxStoredMessages !== undefined) options.maxStoredMessages = maxStoredMessages;
  const service = new ContactDeliveryService(options), messages = new MessagingService({ store: raw, tokens: null, clock: clock.now });
  const authored = (over = {}) => { const text = over.text ?? 'Hello'; delete over.text; return createAuthoredEnvelope({ author: AUTHOR, privateKey: SENDER_KEY.privateKey, recipient: RECIPIENT, mimeType: 'text/plain', body: typeof text === 'string' ? enc.encode(text) : text, subject: 'Hi', optionalTags: [], createdAt: clock.now(), ...over }); };
  const deliver = async (over = {}) => { const { envelope, body } = await authored(over); return service.deliver(GRANT, { envelope, body }); };
  const setIntake = (changes, revisionStep = 1) => store.transaction(async tx => { const grant = await tx.get(key('contact-grant', GRANT)); grant.intake = { ...grant.intake, ...changes, revision: grant.intake.revision + revisionStep }; await tx.set(key('contact-grant', GRANT), grant); return grant.intake.revision; });
  // Observable state: the owner's message list, the accounting the quotas enforce, and outbox events.
  const state = async () => {
    const list = await messages.list(OWNER, { limit: 1000 });
    return raw.transaction(async tx => ({ list, grant: await tx.get(key('contact-grant', GRANT)), usage: await tx.get(key('message-usage', OWNER)) ?? { bytes: 0, messages: 0 }, receipts: (await tx.list(key('contact-delivery-receipt', OWNER))).length, events: (await tx.list(key('notification-event', OWNER))).length }));
  };
  const conserved = async () => {
    const s = await state(), bytes = s.list.reduce((sum, m) => sum + m.size, 0);
    assert.deepEqual(s.usage, { bytes, messages: s.list.length }, 'account usage equals the stored messages');
    assert.equal(s.grant.messagesUsed, s.list.length); assert.equal(s.grant.bytesUsed, bytes);
    assert.equal(s.receipts, s.list.length, 'one receipt per admitted operation');
    assert.equal(s.events, s.list.filter(m => !m.quarantined).length, 'one outbox event per unquarantined message');
    return s;
  };
  return { clock, raw, store, keys, service, messages, authored, deliver, setIntake, state, conserved };
}

