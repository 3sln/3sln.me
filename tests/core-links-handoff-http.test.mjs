// BB-C1b descriptor route on the real Node adapter: GET <contact link> with the ingress media type answers the
// current occupant's descriptor (configured occupancy and describe ports), uniform 503 recipient_unavailable without
// one, 401 for links that do not verify, and nothing at all with BINDLEBOX_ENABLED off or for other media types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeServer } from '../apps/node/server.mjs';
import { MESSAGING_CONTACT_LINK_TYPE, MESSAGING_INGRESS_SLOT, MESSAGING_PROFILE, DESCRIPTOR_MEDIA_TYPE } from '../packages/links/types.mjs';

const BOX = { clientId: 'https://box.example/client.json', origin: 'https://box.example' };
const claims = { resource: 'p1', kinds: ['conversation-init', 'one-off'], mimeTypes: ['text/plain'], maxMessages: 5, maxBytes: 65536, maxMessageBytes: 16384 };
async function server(port, config) {
  const origin = `http://localhost:${port}`, directory = await mkdtemp(join(tmpdir(), 'bindle-c1b-')), app = await createNodeServer({ directory, config: { APP_ORIGIN: origin, ...config } });
  let network = 1; const fetchURL = (path, init = {}) => { const request = new Request(new URL(path, origin), init); if (!request.headers.has('CF-Connecting-IP')) request.headers.set('CF-Connecting-IP', `203.0.113.${network++ % 250}`); return app.fetch(request); };
  const ip = '198.51.100.9', post = (path, value, headers = {}) => fetchURL(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers }, body: JSON.stringify(value) });
  const signup = await post('/api/auth/signup', { method: 'password', password: 'Private slot handoff account password!', termsAccepted: true, termsVersion: '2026-10-11', turnstileToken: 'local-browser-test-token' }), pending = await signup.json(), setup = { Cookie: signup.headers.get('Set-Cookie').split(';')[0] };
  const recovery = await (await post('/api/auth/recovery/download', { pendingToken: pending.pendingToken }, setup)).json();
  const activated = await post('/api/auth/recovery/confirm', { pendingToken: pending.pendingToken, recoveryToken: recovery.recoveryToken, downloadConfirmed: true }, setup); assert.equal(activated.status, 200, await activated.clone().text());
  const session = await activated.json();
  return { app, origin, fetchURL, id: session.account.id, handle: session.account.handle, controller: () => app.resources.accounts.get(session.account.id), async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
const describe = { calls: 0, body: () => ({ version: 1, profiles: [MESSAGING_PROFILE], ingress: `${BOX.origin}/ingress`, kinds: ['conversation-init', 'one-off'], limits: { maxParticipants: 32, maxMessageBytes: 1048576, maxEnvelopeBytes: 65536 } }) };

test('descriptor route: occupant descriptor, uniform unavailability, link checks, and nothing with the flag off', async () => {
  const seat = { value: { ...BOX, generation: 1 } };
  const s = await server(8797, { BINDLEBOX_ENABLED: 'true', LINK_SLOT_OCCUPANT: async ({ slot }) => (slot === MESSAGING_INGRESS_SLOT ? seat.value : null), MESSAGING_DESCRIBE: async ({ occupant }) => { describe.calls++; if (occupant.clientId !== BOX.clientId) throw new Error('unknown occupant'); return describe.body(); } });
  try {
    const c = s.controller(), actor = { kind: 'app', owner: s.id, clientId: BOX.clientId, handle: s.handle };
    const issued = await c.linkOperation(s.id, { actor, operation: 'links.issue', input: { type: MESSAGING_CONTACT_LINK_TYPE, claims, expiresAt: Date.now() + 86400000 } });
    const get = (url, accept = DESCRIPTOR_MEDIA_TYPE, method = 'GET') => s.fetchURL(url, { method, headers: { Accept: accept } });
    const response = await get(issued.link);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('Content-Type'), DESCRIPTOR_MEDIA_TYPE); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer'); assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*'); assert.equal(response.headers.get('Set-Cookie'), null);
    const descriptor = await response.json();
    assert.equal(descriptor.ingress, `${BOX.origin}/ingress`); assert.deepEqual(descriptor.kinds, claims.kinds); assert.ok(descriptor.expiresAt <= Date.now() + 3600000);
    // Unrelated parameters are dropped before verification; HEAD and the CORS preflight work credentialless.
    assert.equal((await get(`${issued.link}&utm_source=x`)).status, 200);
    assert.equal((await get(issued.link, DESCRIPTOR_MEDIA_TYPE, 'HEAD')).status, 200);
    const preflight = await s.fetchURL(issued.link, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'accept' } }); assert.equal(preflight.status, 204);
    // No occupant, or an occupant whose describe fails: the same 503 body and Retry-After.
    seat.value = null; const none = await get(issued.link);
    seat.value = { clientId: 'https://other.example/client.json', generation: 2 }; const failing = await get(issued.link);
    for (const r of [none, failing]) { assert.equal(r.status, 503); assert.equal(r.headers.get('Retry-After'), '3600'); assert.deepEqual(await r.json(), { error: 'recipient_unavailable', message: 'The recipient is unavailable.' }); }
    seat.value = { ...BOX, generation: 1 };
    // Links that do not verify, and data on the URL.
    const meta = new URL(issued.link).searchParams.get('bindle_meta');
    assert.equal((await get(`${s.origin}/users/${s.handle}/contact/${crypto.randomUUID()}?bindle_meta=${meta}`)).status, 401);
    assert.equal((await get(issued.link.replace(meta.slice(-4), 'AAAA'))).status, 401);
    assert.equal((await get(`${issued.link}&bindle_data=a.b.c`)).status, 400);
    await c.linkOperation(s.id, { actor, operation: 'links.revoke', id: issued.jti });
    assert.equal((await get(issued.link)).status, 401, 'a revoked link resolves nothing');
    // Other media types are left to the contacts module (no descriptor body).
    const html = await get(issued.link, 'text/html'); assert.notEqual(html.headers.get('Content-Type'), DESCRIPTOR_MEDIA_TYPE);
  } finally { await s.close(); }
  const off = await server(8798, { LINK_SLOT_OCCUPANT: async () => ({ ...BOX, generation: 1 }), MESSAGING_DESCRIBE: async () => describe.body() });
  try {
    const r = await off.fetchURL(`${off.origin}/users/${off.handle}/contact/${crypto.randomUUID()}?bindle_meta=a.b.c`, { headers: { Accept: DESCRIPTOR_MEDIA_TYPE } });
    assert.notEqual(r.headers.get('Content-Type'), DESCRIPTOR_MEDIA_TYPE); assert.notEqual(r.status, 503);
    await assert.rejects(off.controller().linkDescriptor(off.id, `${off.origin}/users/x/contact/y`), { code: 'not_found' });
  } finally { await off.close(); }
});
