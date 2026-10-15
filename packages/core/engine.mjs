import { randomUUID, createHash } from 'node:crypto';
import { canonical } from './primitives.mjs';

export const STORAGE = 'https://bindle.example/contracts/object-storage/v1';
export const SYNC = 'https://bindle.example/fragments/app-sync/v1';
export class Fault extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new Fault(code, message); };
const clone = value => structuredClone(value);

// In-memory reference model: no durable storage, authentication, or provider credentials.
export class BindleEngine {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.resources = new Map(); this.preferences = new Map(); this.grants = new Map();
    this.tokens = new Map(); this.transactions = new Map();
    this.fragment = { id: SYNC, title: 'App sync', description: 'Store and synchronize application files across your devices.', fields: [{ key: 'storage', type: 'resource', multiple: true, contracts: [STORAGE] }] };
  }
  addStorage(owner, name) {
    const id = `https://3sln.example/resources/${randomUUID()}`;
    this.resources.set(id, { id, owner, name, contracts: [STORAGE], objects: new Map() });
    return id;
  }
  configure(owner, ids) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) fail('invalid_preferences', 'Choose distinct resources.');
    for (const id of ids) {
      const r = this.resources.get(id);
      if (!r || r.owner !== owner || !r.contracts.includes(STORAGE)) fail('invalid_resource', 'Resource must belong to you and implement object storage.');
    }
    this.preferences.set(owner, clone(ids));
    // Removing an assignment permanently narrows prior approvals. Reassigning it
    // later must not revive an app's access without renewed consent.
    for (const grant of this.grants.values()) {
      if (grant.owner === owner) grant.resources = grant.resources.filter(id => ids.includes(id));
    }
  }
  consent(owner, client, { methods = ['get'], resources, acknowledged = false, lifetimeMs = 300000 } = {}) {
    if (!acknowledged) fail('consent_required', 'Explicit consent is required.');
    if (!client || !Array.isArray(methods) || !methods.length || methods.some(m => !['get', 'put', 'delete'].includes(m))) fail('invalid_grant', 'Unknown method or client.');
    if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 300000) fail('invalid_grant', 'Token lifetime must be at most five minutes.');
    const assigned = this.preferences.get(owner) || [];
    const selected = resources ?? assigned;
    if (!Array.isArray(selected) || !selected.length || selected.some(id => !assigned.includes(id))) fail('invalid_grant', 'Approve only assigned resources.');
    const id = randomUUID(); const token = randomUUID();
    const grant = { id, owner, client, fragment: SYNC, contract: STORAGE, methods: [...new Set(methods)], resources: [...new Set(selected)], active: true, expiresAt: this.clock() + lifetimeMs };
    this.grants.set(id, grant); this.tokens.set(token, id);
    return { grant: clone(grant), access_token: token };
  }
  revoke(owner, id) {
    const grant = this.grants.get(id);
    if (!grant || grant.owner !== owner) fail('not_found', 'Grant not found.');
    grant.active = false;
  }
  snapshot(owner) {
    return { fragment: clone(this.fragment), resources: [...this.resources.values()].filter(r => r.owner === owner).map(({ objects, ...r }) => clone(r)), preferences: { storage: clone(this.preferences.get(owner) || []) }, grants: [...this.grants.values()].filter(g => g.owner === owner).map(clone) };
  }
  rpc(token, request) {
    const grant = this.grants.get(this.tokens.get(token));
    if (!grant || !grant.active || grant.expiresAt <= this.clock()) fail('unauthorized', 'Grant is expired or revoked.');
    const { tx, resource, contract, method, args = {} } = request || {};
    if (typeof tx !== 'string' || !tx.length || tx.length > 128) fail('invalid_request', 'A transaction identifier is required.');
    const target = this.resources.get(resource);
    if (!target || target.owner !== grant.owner || contract !== grant.contract || !target.contracts.includes(contract) || !grant.methods.includes(method) || !grant.resources.includes(resource) || !(this.preferences.get(grant.owner) || []).includes(resource)) fail('forbidden', 'Resource or method is outside the current grant.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid_request', 'Arguments must be an object.');
    const fingerprint = createHash('sha256').update(canonical({ resource, contract, method, args })).digest('hex');
    const txKey = `${grant.id}:${tx}`;
    const prior = this.transactions.get(txKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('transaction_conflict', 'Transaction identifier was reused with different arguments.');
      return clone(prior.response);
    }
    if (typeof args.key !== 'string' || !args.key.length || args.key.length > 1024) fail('invalid_request', 'Object key is required.');
    let result;
    const current = target.objects.get(args.key);
    if (method === 'get') {
      if (!current) fail('not_found', 'Object not found.');
      result = clone(current);
    }
    if (method === 'put' || method === 'delete') {
      // Require optimistic concurrency: null means create only, a string matches an existing version.
      if (!Object.hasOwn(args, 'ifMatch') || args.ifMatch !== (current?.etag ?? null)) fail('precondition_failed', 'Object changed; reload before writing.');
      if (method === 'put') {
        if (typeof args.value !== 'string' || Buffer.byteLength(args.value) > 65536) fail('invalid_request', 'Reference objects must be strings up to 64 KiB.');
        result = { value: args.value, etag: randomUUID() }; target.objects.set(args.key, clone(result));
      } else { target.objects.delete(args.key); result = { deleted: Boolean(current) }; }
    }
    const response = { tx, result };
    this.transactions.set(txKey, { fingerprint, response: clone(response) });
    return response;
  }
}
