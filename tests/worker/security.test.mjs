import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argon2id } from 'hash-wasm';

// Actual workerd + SQLite Durable Objects + R2. These test-only subclasses
// expose inspection/seeding; they are never bundled into the deployed Worker.
const harness = `
import worker, { IdentityDirectory, AccountObject, AbuseGuard } from './apps/worker/index.mjs';
import {createWorkerArgon2Hasher}from'./apps/worker/password.mjs';
export class TestDirectory extends IdentityDirectory {
  async rows(){return [...await this.ctx.storage.list()];}
  async passwordVector(password, encoded){const hasher=createWorkerArgon2Hasher();return {match:await hasher.verify(password,encoded),wrong:await hasher.verify(password+'wrong',encoded)};}
}
export class TestAccount extends AccountObject {
  async seed(owner, records){await this.warm(owner);for(const [key,value]of records)await this.ctx.storage.put(key,value);}
  async rows(){return [...await this.ctx.storage.list()];}
  async evictCold(){await this.ctx.storage.put('lastOwnerActiveAt',0);await super.alarm();}
  async restoreCold(owner){await this.warm(owner);return [...await this.ctx.storage.list()];}
  async alarmAt(){return this.ctx.storage.getAlarm();}
}
export class TestAbuse extends AbuseGuard {async rows(){return [...await this.ctx.storage.list()];} }
export default worker;`;
let mf, directory, accounts, abuse, archives, temporary;
const origin = 'http://localhost:8787';
test.before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), '3sln-worker-security-'));
  const out = path.join(temporary, 'worker.mjs');
  await build({ stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'test-harness.mjs' }, outfile: out,
    bundle: true, format: 'esm', platform: 'browser', mainFields: ['browser', 'module', 'main'], conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers', 'node:*'], target: 'es2022', logLevel: 'silent',
    banner: { js: "import * as util from 'node:util'; import * as fs from 'node:fs'; import * as stream from 'node:stream'; import * as buffer from 'node:buffer'; import * as nodeAssertBuiltin from 'node:assert'; import * as zlib from 'node:zlib'; const nodeModules={'node:util':util,'node:fs':fs,'node:stream':stream,'node:buffer':buffer,'node:assert':nodeAssertBuiltin,'node:zlib':zlib}; const require=name=>{if(!nodeModules[name])throw new Error('Unexpected builtin '+name);return nodeModules[name];};" },
    plugins: [{ name: 'worker-test-imports', setup(build) {
      build.onResolve({ filter: /^(?:util|fs|stream|buffer|assert|zlib)$/ }, args => ({ path: `node:${args.path}`, external: true }));
      build.onResolve({ filter: /\.wasm$/ }, args => ({ path: `./${path.basename(args.path)}`, external: true }));
    } }] });
  for (const name of ['argon2', 'blake2b']) await copyFile(path.resolve(`vendor/hash-wasm/${name}.wasm`), path.join(temporary, `${name}.wasm`));
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'identity-security-test', modulesRoot: temporary, modules: [{ type: 'ESModule', path: out }, ...['argon2', 'blake2b'].map(name => ({ type: 'CompiledWasm', path: path.join(temporary, `${name}.wasm`) }))],
    compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR),
    bindings: { APP_ORIGIN: origin, RP_ID: 'localhost', TERMS_VERSION: '2026-10-11', LOCAL_DEVELOPMENT: 'true', IDENTITY_LAYOUT:'v1-64-fresh', SIGNUP_IP_WINDOW_MS:'1000', SIGNUP_IP_DAILY_LIMIT:'20',
      KEY_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'), ABUSE_HASH_KEY: 'isolated-test-rate-limit-key' },
    durableObjects: { IDENTITIES: { className: 'TestDirectory', useSQLite: true }, ACCOUNTS: { className: 'TestAccount', useSQLite: true }, ABUSE: { className: 'TestAbuse', useSQLite: true } },
    r2Buckets: ['BLOBS', 'ARCHIVES'], serviceBindings: { ASSETS: async () => new Response('<!doctype html><title>Test</title>', { headers: { 'Content-Type': 'text/html' } }) } }));
  const identities = await mf.getDurableObjectNamespace('IDENTITIES'); directory = new ShardedIdentityRepository({shard:name=>identities.get(identities.idFromName(name)),layout:'v1-64-fresh'});directory.passwordVector=(...args)=>identities.get(identities.idFromName('password-vector-test')).passwordVector(...args);
  accounts = await mf.getDurableObjectNamespace('ACCOUNTS'); abuse = await mf.getDurableObjectNamespace('ABUSE'); archives = await mf.getR2Bucket('ARCHIVES');
});
test.after(async () => { await mf?.dispose(); if (temporary) await rm(temporary, { recursive: true, force: true }); });
async function request(route, { method = 'GET', value, headers = {}, raw } = {}) {
  return mf.dispatchFetch(`${origin}${route}`, { method, headers: { ...(value !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(value !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(value) } : {}) });
}
async function signup(handle = `test_${crypto.randomUUID().slice(0, 8)}`) {
  const start = await request('/api/auth/signup', { method: 'POST', value: { handle, method: 'password', password: 'isolated test account password', termsAccepted: true, termsVersion: '2026-10-11', turnstileToken: 'local-browser-test-token' }, headers: { Origin: origin } });
  assert.equal(start.status, 200); const pending = await start.json();
  const download = await request('/api/auth/recovery/download', { method: 'POST', value: { pendingToken: pending.pendingToken }, headers: { Origin: origin } });
  assert.equal(download.status, 200); const file = await download.json();
  const activation = await request('/api/auth/recovery/confirm', { method: 'POST', value: { pendingToken: pending.pendingToken, recoveryToken: file.recoveryToken, downloadConfirmed: true }, headers: { Origin: origin } });
  assert.equal(activation.status, 200); const result = await activation.json();
  return { result, pending, file, cookie: activation.headers.get('Set-Cookie').split(';')[0] };
}

test('Worker rejects cross-origin owner/bootstrap mutation and hides demo API', async () => {
  for (const route of ['/api/auth/signup', '/api/auth/recovery/download', '/api/contacts']) {
    assert.equal((await request(route, { method: 'POST', value: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(route, { method: 'POST', value: {} })).status, 403);
  }
  assert.equal((await request('/api/demo/consent')).status, 404);
  assert.equal((await mf.dispatchFetch('http://untrusted.example/api/session')).status, 403);
});

test('actual Worker signup stays unauthenticated until recovery proof; cookie secret never enters JSON/storage', async () => {
  const { result, cookie, pending, file } = await signup();
  assert.equal(result.sessionToken, undefined); assert.equal(result.account.status, 'active');
  const session = await request('/api/session', { headers: { Cookie: cookie } }); assert.equal((await session.json()).authenticated, true);
  assert.equal(session.headers.get('Cache-Control'), 'no-store');
  const stored = JSON.stringify(await directory.get(result.account.id));
  assert(!stored.includes(decodeURIComponent(cookie.split('=')[1]))); assert(!stored.includes(file.recoveryToken)); assert(!stored.includes(pending.pendingToken));
  assert(!stored.includes('isolated test account password'));
  assert.equal((await request('/api/contacts', { method: 'POST', value: {}, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': 'wrong' } })).status, 403);
  const logout = await request('/api/auth/logout', { method: 'POST', value: {}, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': result.csrfToken } });
  assert.equal(logout.status, 200); assert.equal((await (await request('/api/session', { headers: { Cookie: cookie } })).json()).authenticated, false);
  const login = await request('/api/auth/login/password', { method: 'POST', value: { handle: result.account.handle, password: 'isolated test account password', turnstileToken: 'local-browser-test-token' }, headers: { Origin: origin } });
  assert.equal(login.status, 200); assert(login.headers.get('Set-Cookie').includes('HttpOnly')); assert.equal((await login.json()).sessionToken, undefined);
});

test('Worker enforces request byte bounds and JSON content type', async () => {
  assert.equal((await request('/api/auth/signup', { method: 'POST', raw: '{}', headers: { Origin: origin, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/auth/signup', { method: 'POST', raw: '{invalid', headers: { Origin: origin } })).status, 400);
  assert.equal((await request('/api/auth/signup', { method: 'POST', raw: JSON.stringify({ oversized: 'x'.repeat(100001) }), headers: { Origin: origin } })).status, 413);
  for (const value of [null, [], 'text', 1]) assert.equal((await request('/api/auth/signup', { method: 'POST', value, headers: { Origin: origin } })).status, 400);
  assert.equal((await request('/api/contacts', { method: 'OPTIONS' })).status, 405);
});

test('actual Durable Object races preserve unique handles/emails and reject stale CAS writes', async () => {
  const handle = `race_${crypto.randomUUID().slice(0, 8)}`;
  const alice = { id: crypto.randomUUID(), handle, revision: 0, status: 'active' };
  const bob = { id: crypto.randomUUID(), handle, revision: 0, status: 'active' };
  const race = await Promise.all([directory.create(alice), directory.create(bob)]); assert.equal(race.filter(Boolean).length, 1);
  const winning = await directory.findByHandle(handle); assert.equal(winning.id, race[0] ? alice.id : bob.id);
  const other = { id: crypto.randomUUID(), handle: `other_${crypto.randomUUID().slice(0, 8)}`, revision: 0, status: 'active' }; assert(await directory.create(other));
  const email = `race-${crypto.randomUUID()}@mail.example`;
  const claims = await Promise.all([directory.compareAndSwap(winning.id, 0, { ...winning, revision: 1, verifiedEmail: email }), directory.compareAndSwap(other.id, 0, { ...other, revision: 1, verifiedEmail: email })]);
  assert.equal(claims.filter(Boolean).length, 1); assert.equal((await directory.findByEmail(email)).id, claims[0] ? winning.id : other.id);
  assert.equal(await directory.compareAndSwap((await directory.findByEmail(email)).id, 0, { ...winning, revision: 2 }), false);
});

test('R2 cold shelving retains credentials/capabilities hot and restores message/resource metadata with an alarm', async () => {
  const owner = crypto.randomUUID(); const object = accounts.get(accounts.idFromName(owner));
  const messageKey = `message/${owner}/test`; const resourceKey = 'resource/test';
  await object.seed(owner, [[messageKey, { id: 'test', owner, blobRef: 'immutable-existing-object', size: 4 }], [resourceKey, { id: 'test', owner, secret: { ciphertext: 'encrypted-only' } }], ['signing-key', { encrypted: { ciphertext: 'private-encrypted' } }], ['contact-grant/test', { active: true }]]);
  await object.evictCold();
  const cold = new Map(await object.rows()); assert.equal(cold.get('shelved'), true); assert.equal(cold.has(messageKey), false); assert.equal(cold.has(resourceKey), false); assert(cold.has('signing-key')); assert(cold.has('contact-grant/test'));
  assert(await archives.get(`accounts/${owner}.json`));
  const warm = new Map(await object.restoreCold(owner)); assert.equal(warm.has('shelved'), false); assert.equal(warm.get(messageKey).owner, owner); assert.equal(warm.get(resourceKey).owner, owner); assert(await object.alarmAt());
});

test('actual Durable Object abuse rate limits reserve a fixed number under parallel load', async () => {
  const object = abuse.get(abuse.idFromName(`parallel-${crypto.randomUUID()}`));
  const results = await Promise.all(Array.from({ length: 12 }, () => object.consume({ windowMs: 60000, limit: 3 })));
  assert.equal(results.filter(Boolean).length, 3); assert.equal(new Map(await object.rows()).get('window').count, 3);
});

test('static Worker Argon2 matches the unmodified maintained Node KDF with fixed parameters', async () => {
  const password = 'worker and node interoperability test';
  const encoded = await argon2id({ password, salt: new Uint8Array(32).fill(9), parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded' });
  const verification = await directory.passwordVector(password, encoded);
  assert.equal(verification.match, true); assert.equal(verification.wrong, false);
});
