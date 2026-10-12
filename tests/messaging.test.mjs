import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMessagingStore, ContactTokenService, MessagingService, NotificationService, signContactToken, contactURL, renderMessage, inspectWebArchive, WEB_ARCHIVE_MIME, defaultNotificationPreferences } from '../packages/messaging/index.mjs';
import { base64url, textEncoder, key } from '../packages/messaging/store.mjs';

const bytes = value => textEncoder.encode(value);
const rejects = (operation, code) => assert.rejects(operation, error => error.code === code);
async function fixture({ alg = 'EdDSA', ...limits } = {}) {
  let now = 1800000000000;
  const clock = () => now;
  const store = new MemoryMessagingStore();
  const tokens = new ContactTokenService({ store, issuer: 'https://3sln.example', clock });
  const messages = new MessagingService({ store, tokens, clock });
  const notifications = new NotificationService({ store, clock });
  const owner = 'account/alice';
  const inbox = await messages.createCollection(owner, 'Inbox');
  const other = await messages.createCollection(owner, 'Saved');
  const keypair = await crypto.subtle.generateKey(alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await tokens.registerKey(owner, { kid: 'key-1', alg, publicJwk: await crypto.subtle.exportKey('jwk', keypair.publicKey) });
  const grant = await tokens.createGrant(owner, { kid: 'key-1', collections: [inbox.id], mimeTypes: ['text/plain', 'text/html', WEB_ARCHIVE_MIME], expiresAt: now + 7 * 86400000, ...limits });
  const token = await signContactToken({ header: grant.protectedHeader, claims: grant.claims, privateKey: keypair.privateKey });
  const receive = (value = 'Hello', overrides = {}) => messages.receive(token, { collection: inbox.id, mimeType: 'text/plain', bytes: bytes(value), idempotencyKey: crypto.randomUUID(), ...overrides });
  return { store, tokens, messages, notifications, owner, inbox, other, grant, token, keypair, receive, clock, advance: duration => { now += duration; } };
}

for (const alg of ['EdDSA', 'ES256']) test(`${alg} tokens require registered exact claims, signature and live grant`, async () => {
  const f = await fixture({ alg });
  assert.equal((await f.tokens.verify(f.token)).claims.sub, f.owner);
  const forged = await signContactToken({ header: f.grant.protectedHeader, claims: { ...f.grant.claims, maxMessages: 999 }, privateKey: f.keypair.privateKey });
  await rejects(() => f.tokens.verify(forged), 'unauthorized');
  const segments = f.token.split('.'); segments[2] = base64url(new Uint8Array(64));
  await rejects(() => f.tokens.verify(segments.join('.')), 'unauthorized');
  await f.tokens.revoke(f.owner, f.grant.grant.id);
  await rejects(() => f.receive(), 'unauthorized');
});

test('contact URL uses a fragment and cannot introduce URL userinfo', async () => {
  const f = await fixture(); const url = new URL(contactURL({ origin: 'https://3sln.example', handle: 'alice', token: f.token }));
  assert.equal(url.pathname, '/users/alice/message'); assert.equal(url.search, ''); assert.equal(url.username, ''); assert.ok(url.hash.startsWith('#token='));
  assert.throws(() => contactURL({ origin: 'https://alice@3sln.example', handle: 'alice', token: f.token }));
});

test('scope, ownership, MIME and UTF-8 checks protect message storage', async () => {
  const f = await fixture();
  await rejects(() => f.receive('Hello', { collection: f.other.id }), 'forbidden');
  await rejects(() => f.receive('Hello', { mimeType: 'image/svg+xml' }), 'forbidden');
  await rejects(() => f.receive('Hello', { bytes: new Uint8Array([255]) }), 'invalid_utf8');
  const accepted = await f.receive();
  await rejects(() => f.messages.read('account/bob', accepted.id), 'not_found');
  await rejects(() => f.messages.update(f.owner, accepted.id, { grantId: 'other' }), 'invalid_actions');
  assert.deepEqual(await f.messages.list('account/bob'), []);
  assert.equal((await f.messages.list(f.owner))[0].bytes, undefined);
});

test('atomic quota reservation and idempotency withstand parallel requests', async () => {
  const f = await fixture({ maxMessages: 1 });
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => f.receive(`message-${index}`)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.messages.list(f.owner)).length, 1);
  const g = await fixture({ maxMessages: 1 });
  const repeated = await Promise.all(Array.from({ length: 10 }, () => g.receive('same', { idempotencyKey: 'same' })));
  assert.equal(new Set(repeated.map(result => result.id)).size, 1);
  await rejects(() => g.receive('different', { idempotencyKey: 'same' }), 'idempotency_conflict');
  await g.tokens.revoke(g.owner, g.grant.grant.id);
  await rejects(() => g.receive('same', { idempotencyKey: 'same' }), 'unauthorized');
});

test('caller mutation during await cannot change stored message bytes', async () => {
  const f = await fixture(); const content = bytes('safe'); const pending = f.receive('ignored', { bytes: content }); content.fill(88);
  const result = await pending;
  assert.equal(new TextDecoder().decode((await f.messages.read(f.owner, result.id)).bytes), 'safe');
});

test('byte, aggregate account and collection revocation limits are live', async () => {
  const f = await fixture({ maxBytes: 8, maxMessageBytes: 5 });
  await rejects(() => f.receive('123456'), 'quota_exceeded');
  await f.receive('12345'); await rejects(() => f.receive('1234'), 'quota_exceeded');
  const g = await fixture(); g.messages.maxStoredBytes = 4;
  const result = await g.receive('1234'); await rejects(() => g.receive('a'), 'account_quota_exceeded');
  await g.messages.delete(g.owner, result.id); await g.receive('abcd');
  await g.messages.disableCollection(g.owner, g.inbox.id);
  await rejects(() => g.receive('x'), 'unauthorized');
});

test('key retirement and expiration invalidate even otherwise valid signatures', async () => {
  const f = await fixture(); await f.tokens.revokeKey(f.owner, 'key-1'); await rejects(() => f.receive(), 'unauthorized');
  const g = await fixture(); g.advance(8 * 86400000); await rejects(() => g.receive(), 'unauthorized');
});

test('rules match original metadata; quarantine remains sticky and owner can release', async () => {
  const f = await fixture();
  await f.messages.setRules(f.owner, [
    { id: 'move', enabled: true, match: { collection: f.inbox.id }, actions: { collection: f.other.id, tags: ['review'], quarantined: true } },
    { id: 'no-cascade', enabled: true, match: { collection: f.other.id }, actions: { classification: 'spam' } },
    { id: 'no-release', enabled: true, match: {}, actions: { quarantined: false } },
  ]);
  const result = await f.receive(); let message = await f.messages.read(f.owner, result.id);
  assert.equal(message.collection, f.other.id); assert.equal(message.classification, 'unclassified'); assert.equal(message.quarantined, true);
  assert.deepEqual(await f.store.transaction(tx => tx.list(key('notification-event', f.owner))), []);
  await f.messages.update(f.owner, result.id, { quarantined: false, classification: 'personal', read: true, tags: ['friend'] });
  message = await f.messages.read(f.owner, result.id); assert.equal(message.readAt, f.clock());
  await f.messages.update(f.owner, result.id, { read: false, quarantined: false });
  assert.equal((await f.store.transaction(tx => tx.list(key('notification-event', f.owner)))).length, 1);
});

test('HTML rendering reconstructs only inert tags and archives reject traversal/active formats', () => {
  const rendered = renderMessage({ mimeType: 'text/html', bytes: bytes('<p onclick="alert(1)">Hi<img src="https://evil.example"><script>alert(1)</script><a href="https://evil.example">link</a><iframe srcdoc="bad"></iframe></p>') });
  assert.equal(rendered.sandbox, ''); assert.equal(rendered.referrerPolicy, 'no-referrer');
  assert.ok(!rendered.html.includes('onclick')); assert.ok(!rendered.html.includes('<script')); assert.ok(!rendered.html.includes('<iframe')); assert.ok(!rendered.html.includes('https://evil.example')); assert.ok(rendered.html.includes('<p>Hi'));
  const archive = path => bytes(JSON.stringify({ version: 1, entrypoint: path, entries: [{ path, mimeType: 'text/html', data: base64url(bytes('<b>Archive</b>')) }] }));
  assert.equal(inspectWebArchive(archive('index.html')).entries.length, 1);
  assert.ok(renderMessage({ mimeType: WEB_ARCHIVE_MIME, bytes: archive('index.html') }).html.includes('<b>Archive</b>'));
  for (const path of ['../x', '/x', 'a\\b', 'a/%2e%2e/x', 'https://evil.example/x', 'a//b']) assert.throws(() => inspectWebArchive(archive(path)));
  assert.equal(renderMessage({ mimeType: 'application/vnd.3sln.webrtc+json', bytes: bytes('{}') }).kind, 'download');
});

test('transaction failures roll back writes', async () => {
  const store = new MemoryMessagingStore();
  await assert.rejects(() => store.transaction(async tx => { await tx.set('partial', true); throw new Error('stop'); }));
  assert.equal(await store.transaction(tx => tx.get('partial')), undefined);
});

async function enableEmail(f, overrides = {}) {
  const preferences = defaultNotificationPreferences(); Object.assign(preferences.email, { enabled: true, delayMinutes: 5, repeatHours: 1, maxReminders: 2 }, overrides);
  await f.notifications.setPreferences(f.owner, preferences, { verifiedEmail: true }); return preferences;
}

test('email reminders require opt-in, verification, delay, unread state and bounded repeats', async () => {
  const f = await fixture(); const received = await f.receive(); f.advance(600000);
  assert.deepEqual(await f.notifications.claimDue(f.owner), []);
  const preferences = defaultNotificationPreferences(); preferences.email.enabled = true;
  await rejects(() => f.notifications.setPreferences(f.owner, preferences), 'verified_email_required');
  await enableEmail(f);
  let jobs = await f.notifications.claimDue(f.owner); assert.equal(jobs.length, 1); assert.equal(jobs[0].payload.body, 'You have an unread message.');
  assert.ok(!JSON.stringify(jobs[0]).includes('Hello')); assert.equal(await f.notifications.authorizeDelivery(f.owner, jobs[0].id, jobs[0].lease), true);
  await f.notifications.finish(f.owner, jobs[0].id, jobs[0].lease, { delivered: true });
  assert.deepEqual(await f.notifications.claimDue(f.owner), []);
  f.advance(3600000); jobs = await f.notifications.claimDue(f.owner); assert.equal(jobs.length, 1);
  await f.messages.update(f.owner, received.id, { read: true });
  assert.equal(await f.notifications.authorizeDelivery(f.owner, jobs[0].id, jobs[0].lease), false);
});

test('notification leases deduplicate claims and reject stale completions', async () => {
  const f = await fixture(); await enableEmail(f); await f.receive(); f.advance(300000);
  const batches = await Promise.all(Array.from({ length: 8 }, () => f.notifications.claimDue(f.owner)));
  assert.equal(batches.flat().length, 1); const original = batches.flat()[0];
  f.advance(61000); const [retried] = await f.notifications.claimDue(f.owner); assert.notEqual(retried.lease, original.lease);
  await rejects(() => f.notifications.finish(f.owner, original.id, original.lease, { delivered: true }), 'stale_lease');
  await f.notifications.finish(f.owner, retried.id, retried.lease, { delivered: true });
});

test('unsubscribe suppresses leased delivery without disclosing recipient; repeat is idempotent', async () => {
  const f = await fixture(); await enableEmail(f); await f.receive(); f.advance(300000);
  const [job] = await f.notifications.claimDue(f.owner); const token = await f.notifications.issueUnsubscribe(f.owner);
  assert.deepEqual(await f.notifications.unsubscribe(token), { unsubscribed: true });
  assert.deepEqual(await f.notifications.unsubscribe(token), { unsubscribed: true });
  assert.equal(await f.notifications.authorizeDelivery(f.owner, job.id, job.lease), false);
  assert.deepEqual(await f.notifications.claimDue(f.owner), []);
  await rejects(() => f.notifications.unsubscribe('x'.repeat(43)), 'invalid_unsubscribe');
});

test('quiet hours, collection/tag filtering, quarantine and deletion suppress notifications', async () => {
  const f = await fixture(); const preferences = await enableEmail(f); const received = await f.receive(); f.advance(300000);
  preferences.quiet = { enabled: true, startHour: 0, endHour: 0, utcOffsetMinutes: 0 };
  await f.notifications.setPreferences(f.owner, preferences, { verifiedEmail: true }); assert.deepEqual(await f.notifications.claimDue(f.owner), []);
  preferences.quiet.enabled = false; preferences.collections = [f.other.id];
  await f.notifications.setPreferences(f.owner, preferences, { verifiedEmail: true }); assert.deepEqual(await f.notifications.claimDue(f.owner), []);
  preferences.collections = []; preferences.excludeTags = ['mute'];
  await f.notifications.setPreferences(f.owner, preferences, { verifiedEmail: true });
  await f.messages.update(f.owner, received.id, { tags: ['mute'] }); assert.deepEqual(await f.notifications.claimDue(f.owner), []);
  await f.messages.update(f.owner, received.id, { tags: [], quarantined: true }); assert.deepEqual(await f.notifications.claimDue(f.owner), []);
  await f.messages.update(f.owner, received.id, { quarantined: false }); const [job] = await f.notifications.claimDue(f.owner); assert.ok(job);
  await f.messages.delete(f.owner, received.id); assert.equal(await f.notifications.authorizeDelivery(f.owner, job.id, job.lease), false);
});

test('push device registration and revocation protect endpoints and suppress delivery', async () => {
  const f = await fixture();
  const subscription = { endpoint: 'https://fcm.googleapis.com/send/device-secret', keys: { p256dh: base64url(new Uint8Array(65).fill(4)), auth: base64url(new Uint8Array(16).fill(1)) } };
  await rejects(() => f.notifications.subscribe(f.owner, { ...subscription, endpoint: 'http://127.0.0.1/private' }), 'invalid_subscription');
  const device = await f.notifications.subscribe(f.owner, subscription);
  assert.equal((await f.notifications.subscriptions(f.owner))[0].endpoint, undefined);
  const preferences = defaultNotificationPreferences(); preferences.push.enabled = true; await f.notifications.setPreferences(f.owner, preferences);
  await f.receive(); const [job] = await f.notifications.claimDue(f.owner); assert.equal(job.channel, 'push');
  await f.notifications.unsubscribeDevice(f.owner, device.id); assert.equal(await f.notifications.authorizeDelivery(f.owner, job.id, job.lease), false);
});
