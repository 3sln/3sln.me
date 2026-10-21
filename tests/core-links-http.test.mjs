// Core links (BB-C1a) on the real Node adapter: the owner link routes stay unmounted with BINDLEBOX_ENABLED off;
// with it on, an app actor admitted by the slot-occupant port issues through the account engine, the owner lists
// and revokes over HTTP, and identity key rotation keeps contact links verifiable while new ones use the new key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeServer } from '../apps/node/server.mjs';
import { fromBase64url, strictText } from '../packages/core/records.mjs';
import { MESSAGING_CONTACT_LINK_TYPE, MESSAGING_INGRESS_SLOT } from '../packages/links/types.mjs';

const APP = 'https://box.example/app';
const kidOf = url => JSON.parse(strictText(fromBase64url(new URL(url).searchParams.get('bindle_meta').split('.')[0]))).kid;
async function server(port, config) {
  const origin = `http://localhost:${port}`, directory = await mkdtemp(join(tmpdir(), 'bindle-core-links-')), app = await createNodeServer({ directory, config: { APP_ORIGIN: origin, ...config } });
  let network = 1; const fetchURL = (path, init = {}) => { const request = new Request(new URL(path, origin), init); if (!request.headers.has('CF-Connecting-IP')) request.headers.set('CF-Connecting-IP', `203.0.113.${network++ % 250}`); return app.fetch(request); };
  const ip = '198.51.100.7', post = (path, value, headers = {}) => fetchURL(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers }, body: JSON.stringify(value) });
  const signup = await post('/api/auth/signup', { method: 'password', password: 'Private core links account password!', termsAccepted: true, termsVersion: '2026-10-11', turnstileToken: 'local-browser-test-token' }), pending = await signup.json(), setup = { Cookie: signup.headers.get('Set-Cookie').split(';')[0] };
  const recovery = await (await post('/api/auth/recovery/download', { pendingToken: pending.pendingToken }, setup)).json();
  const activated = await post('/api/auth/recovery/confirm', { pendingToken: pending.pendingToken, recoveryToken: recovery.recoveryToken, downloadConfirmed: true }, setup); assert.equal(activated.status, 200, await activated.clone().text());
  const session = await activated.json(), headers = { Cookie: activated.headers.getSetCookie().find(c => c.startsWith('bindle_session=')).split(';')[0], 'X-CSRF-Token': session.csrfToken };
  const owner = (path, value, method = value === undefined ? 'GET' : 'POST') => fetchURL(path, { method, headers: { Origin: origin, ...headers, ...value === undefined ? {} : { 'Content-Type': 'application/json' } }, ...value === undefined ? {} : { body: JSON.stringify(value) } });
  return { app, origin, owner, fetchURL, id: session.account.id, handle: session.account.handle, controller: () => app.resources.accounts.get(session.account.id), async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('flag off: owner link routes are not mounted and the app-actor entry refuses', async () => {
  const s = await server(8793, {});
  try {
    for (const [path, value] of [['/api/links'], ['/api/links/changes'], [`/api/links/${crypto.randomUUID()}/revoke`, {}]]) assert.equal((await s.owner(path, value)).status, 404, path);
    assert.equal((await s.owner('/api/links', {})).status, 404, 'no allowlist reveals the path');
    await assert.rejects(s.controller().linkOperation(s.id, { actor: { kind: 'app', owner: s.id, clientId: APP, handle: s.handle }, operation: 'links.issue', input: {} }), { code: 'not_found' });
    // Existing contact links are unaffected.
    const created = await s.owner('/api/contact-links', { name: 'Friends', mimeTypes: ['text/plain'], expiresAt: Date.now() + 86400000, maxMessages: 3, maxBytes: 65536, maxMessageBytes: 16384 });
    assert.equal(created.status, 200, await created.clone().text());
  } finally { await s.close(); }
});

test('flag on: occupant app issues, owner lists and revokes over HTTP; contact links survive identity key rotation', async () => {
  const occupant = { clientId: APP, generation: 1 };
  const s = await server(8794, { BINDLEBOX_ENABLED: 'true', LINK_SLOT_OCCUPANT: async ({ slot }) => (slot === MESSAGING_INGRESS_SLOT ? occupant : null) });
  try {
    const c = s.controller(), actor = { kind: 'app', owner: s.id, clientId: APP, handle: s.handle };
    const issued = await c.linkOperation(s.id, { actor, operation: 'links.issue', input: { type: MESSAGING_CONTACT_LINK_TYPE, claims: { resource: 'p1', kinds: ['one-off'], mimeTypes: ['text/plain'], maxMessages: 5, maxBytes: 65536, maxMessageBytes: 16384 }, expiresAt: Date.now() + 86400000 } });
    assert.match(issued.link, new RegExp(`^${s.origin}/users/${s.handle.replace('.', '\\.')}/contact/${issued.jti}\\?bindle_meta=`));
    await assert.rejects(c.linkOperation(s.id, { actor: { ...actor, clientId: 'https://other.example/app' }, operation: 'links.issue', input: {} }), { code: 'forbidden' });
    await assert.rejects(c.linkOperation(s.id, { actor: { ...actor, owner: crypto.randomUUID() }, operation: 'links.list' }), { code: 'forbidden' });
    await assert.rejects(c.linkOperation(s.id, { actor, operation: 'views.list' }), { code: 'unsupported_method' });
    const listed = await (await s.owner('/api/links')).json();
    assert.deepEqual(listed.links.map(link => [link.jti, link.revoked, link.occupantGeneration]), [[issued.jti, false, 1]]);
    assert.equal((await s.owner('/api/links?owner=x')).status, 400);
    assert.equal((await s.owner('/api/links', {})).status, 405);
    assert.equal((await s.owner(`/api/links/${issued.jti}/revoke`, {})).status, 200);
    assert.equal((await s.owner(`/api/links/${crypto.randomUUID()}/revoke`, {})).status, 404);
    assert.equal((await s.owner(`/api/links/${issued.jti}/revoke`, { all: true })).status, 400);
    const changes = await (await s.owner('/api/links/changes?since=0')).json();
    assert.deepEqual(changes.changes.map(change => change.change), ['issued', 'revoked']);
    // Contact links: the current key mints; rotation keeps old links; a rotated challenge moves to the new key.
    const contact = await (await s.owner('/api/contact-links', { name: 'Friends', mimeTypes: ['text/plain'], expiresAt: Date.now() + 86400000, maxMessages: 3, maxBytes: 65536, maxMessageBytes: 16384 })).json();
    const before = kidOf(contact.url);
    const rotated = await c.rotateIdentityKey(s.id, { purpose: 'signing', expectedKid: before });
    assert.equal((await c.endpoints.inspect(contact.url)).form, 'link');
    const fresh = await (await s.owner('/api/contact-links', { name: 'New', mimeTypes: ['text/plain'], expiresAt: Date.now() + 86400000, maxMessages: 3, maxBytes: 65536, maxMessageBytes: 16384 })).json();
    assert.equal(kidOf(fresh.url), rotated.kid);
    const landing = await s.fetchURL(contact.url, { headers: { Accept: 'application/json' } });
    assert.notEqual(landing.status, 401, 'the landing still verifies a retired-key link');
    await c.revokeIdentityKey(s.id, { purpose: 'signing', kid: before, reason: 'compromise' });
    await assert.rejects(c.endpoints.inspect(contact.url), { code: 'link_invalid' });
    assert.equal((await c.endpoints.inspect(fresh.url)).form, 'link');
  } finally { await s.close(); }
});
