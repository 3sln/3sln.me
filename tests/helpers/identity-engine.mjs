// Engine-level identity fixture: the real IdentityService inside an ngin Engine,
// with every pluggable resource replaced by an in-memory or fake one. Passwords
// use a fast deterministic fake hasher (Argon2 itself is covered by identity.test.mjs).
import { createIdentityEngine, IdentityAction, OwnerQuery } from '../../packages/identity/index.mjs';
import { ShardedIdentityRepository, IdentityShardStorage, IDENTITY_LAYOUT } from '../../packages/runtime/identity-shards.mjs';
import { createHash } from 'node:crypto';
import { fakeClock } from './chaos.mjs';

export const config = { origin: 'https://3sln.example', rpID: '3sln.example', rpName: '3sln', termsVersion: '2026-10-11' };
export const context = { origin: config.origin, remoteIP: '192.0.2.1' };
export const PASSWORD = 'correct horse battery staple';
export const signupInput = (overrides = {}) => ({ handle: 'alice', method: 'password', password: PASSWORD, termsAccepted: true, termsVersion: config.termsVersion, turnstileToken: 'verified', ...overrides });

/** Linearizable Map repository with the IdentityService repository contract. */
export class MemoryAccounts {
  records = new Map();
  async get(id) { return structuredClone(this.records.get(id)); }
  async findByHandle(handle) { return structuredClone([...this.records.values()].find(a => a.handle === handle)); }
  async findByEmail(email) { return structuredClone([...this.records.values()].find(a => a.verifiedEmail === email)); }
  async create(account) { if (this.records.has(account.id) || [...this.records.values()].some(a => a.handle === account.handle)) return false; this.records.set(account.id, structuredClone(account)); return true; }
  async compareAndSwap(id, revision, account) {
    if (this.records.get(id)?.revision !== revision || (account.verifiedEmail && [...this.records.values()].some(a => a.id !== id && a.verifiedEmail === account.verifiedEmail))) return false;
    this.records.set(id, structuredClone(account)); return true;
  }
}
export class MemoryDevices {
  records = new Map();
  async get(id) { return structuredClone(this.records.get(id)); }
  async findByUserCode(code) { return structuredClone([...this.records.values()].find(value => value.userCode === code)); }
  async create(value) { if (this.records.has(value.id) || [...this.records.values()].some(record => record.userCode === value.userCode)) return false; this.records.set(value.id, structuredClone(value)); return true; }
  async compareAndSwap(id, revision, value) { if (this.records.get(id)?.revision !== revision) return false; this.records.set(id, structuredClone(value)); return true; }
}
/** Serialized in-memory transactional metadata, the contract IdentityShardStorage needs. */
export class MemoryMetadata {
  rows = new Map(); queue = Promise.resolve();
  async get(key) { return structuredClone(this.rows.get(key)); }
  async put(key, value) { this.rows.set(key, structuredClone(value)); }
  async delete(key) { this.rows.delete(key); }
  async list({ prefix = '', startAfter = '', limit = 100 } = {}) { return new Map([...this.rows].filter(([key]) => key.startsWith(prefix) && key > startAfter).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)); }
  async transaction(operation) { const result = this.queue.then(async () => { const old = structuredClone(this.rows); try { return await operation(this); } catch (error) { this.rows = old; throw error; } }); this.queue = result.catch(() => {}); return result; }
}
/** Sharded identity storage: one IdentityShardStorage per shard name, reached
 * through `shardX` RPC-shaped calls like the Worker/Node adapters. `wrap` lets a
 * test interpose a scheduler or fault injector on each shard stub. */
export function memoryShards({ wrap = stub => stub } = {}) {
  const controllers = new Map(), stubs = new Map();
  const shard = name => {
    if (!stubs.has(name)) {
      const controller = new IdentityShardStorage(new MemoryMetadata()); controllers.set(name, controller);
      const stub = new Proxy({}, { get: (_, method) => method === 'then' || typeof method === 'symbol' ? undefined : (...args) => controller[method.slice(5, 6).toLowerCase() + method.slice(6)](...args) });
      stubs.set(name, wrap(stub, name));
    }
    return stubs.get(name);
  };
  return { shard, controllers, repository: clock => new ShardedIdentityRepository({ shard, layout: IDENTITY_LAYOUT, clock }) };
}
const digest = value => `fake:${createHash('sha256').update(value).digest('base64url')}`;
export const fakeHasher = { dummyHash: digest('dummy'), hash: async value => digest(value), verify: async (value, encoded) => encoded === digest(value) };

export function identityEngine({ repository = new MemoryAccounts(), deviceRequests = new MemoryDevices(), clock = fakeClock(), mailer, rateLimiter = { check: async () => true }, ...overrides } = {}) {
  const mail = [];
  const resources = { repository, deviceRequests, clock: clock.now, config, turnstile: { verify: async ({ token }) => token === 'verified' }, rateLimiter,
    passwordHasher: fakeHasher, webauthn: { registrationOptions: async () => ({ challenge: 'unused' }), authenticationOptions: async () => ({ challenge: 'unused' }) },
    mailer: mailer ?? { sendVerification: async value => { mail.push(value); }, sendSetupCode: async value => { mail.push(value); } }, ...overrides };
  // The app's own engine wiring; `service` reaches methods that are not
  // dispatchable actions (owner reads, step-up) through the engine container.
  const engine = createIdentityEngine(resources);
  const service = new Proxy({}, { get: (_, method) => (...args) => engine.container.use(['identity'], ({ identity }) => identity[method](...args)) });
  /** Dispatch one identity action and resolve with its result (rejects with the IdentityFault). */
  const act = async (method, input, ctx = context) => (await engine.dispatch(new IdentityAction(method, input, ctx)).next('result')).detail;
  const owner = ctx => engine.query(new OwnerQuery(ctx)).peek();
  return { engine, service, act, owner, repository, deviceRequests, clock, mail, resources };
}
/** Signup → recovery download → confirmation, all through engine dispatch. */
export async function activate(act, input = signupInput()) {
  const pending = await act('signup', input);
  const file = await act('downloadRecovery', pending);
  const owner = await act('confirmRecovery', { ...pending, recoveryToken: file.recoveryToken, downloadConfirmed: true });
  return { pending, file, owner, ownerContext: sessionContext(owner) };
}
export const sessionContext = (result, base = context) => ({ ...base, sessionToken: result.sessionToken, csrfToken: result.csrfToken });
