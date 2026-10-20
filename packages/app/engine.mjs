// The application Engine (docs/architecture/app-engine.md).
//
// One factory composes every placement: the account single writer (AccountObject
// DO and the Node AccountController share `AccountController`, which calls this),
// the test harness (tests/helpers/app-engine.mjs) and the engine CLI
// (scripts/engine.mjs). Only the provider set differs; the Actions and Queries
// dispatched are the same classes everywhere.
import { Engine, Provider, Action, Query } from '../../vendor/ngin/index.js';
import { PROVIDERS, auditTrail } from './providers.mjs';
import { fault, AppFault } from './faults.mjs';

const isProvider = value => typeof value === 'function' && value.prototype instanceof Provider;
// Effects are always injected, never defaulted: a composition that forgot its
// clock should fail at construction, not quietly read the wall clock in a test.
const REQUIRED = ['clock', 'random', 'audit'];

/**
 * @param {object} options
 * @param {Record<string, typeof Provider | any>} options.providers catalogued
 *   names only. A Provider class is used as is; any other value is a pre-built
 *   resource wrapped with `Provider.fromSingleton`.
 * @param {object[]} [options.interceptors] added inside the audit trail.
 */
export function createAppEngine({ providers = {}, interceptors = [] } = {}) {
  for (const name of Object.keys(providers)) if (!Object.hasOwn(PROVIDERS, name)) throw new TypeError(`Uncatalogued app provider: ${name}`);
  for (const name of REQUIRED) if (!Object.hasOwn(providers, name)) throw new TypeError(`The app engine requires a ${name} provider`);
  return new Engine({ providers: Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, isProvider(value) ? value : Provider.fromSingleton(value)])), interceptors: [auditTrail, ...interceptors] });
}

/** Dispatch an Action and resolve with its `result` once the dispatch has completed: after the
 * interceptors' `leave` and the lease release, so an account RPC replies only when every hook ran
 * inside the gate, and a hook that fails on the way out fails the call instead of following a reply.
 * Rejects with what the work threw. `signal` stops waiting without aborting the work: a disconnected
 * HTTP caller must not cancel a mutation between its transaction and its reply. */
export async function perform(engine, action, { signal } = {}) {
  const feed = engine.dispatch(action); let result;
  feed.addEventListener('result', event => { result = event; }, { once: true });
  await feed.next('complete', { signal });
  if (!result) throw new Error(`${action.constructor.name} completed without a result`);
  return result.detail;
}
/** One-shot read: an active Query answers from its last value, otherwise `fetch` runs (wrapped by the interceptors). */
export function read(engine, query) { return engine.query(query).peek(); }
/** Either kind, for adapters that route by operation name. */
export function operate(engine, operation, options) { return operation instanceof Query ? read(engine, operation) : perform(engine, operation, options); }

// Placement policy an operation declares as statics, read by the account RPC (`AccountController.invoke`)
// instead of matching RPC method names:
//   lifecycle  'active' (default) | 'suspended' (allowed while suspended) | 'purging' (also while purging)
//   gate       'account' (default: inside the single-writer gate) | 'none' (cross-account fanout and lookups
//              that a peer account may call while holding its own gate)
//   activity   undefined | 'owner-return' | 'resource-use' (resets the inactivity clock after success)
const LIFECYCLE = ['active', 'suspended', 'purging'], GATES = ['account', 'none'], ACTIVITY = ['owner-return', 'resource-use'];
// The same vocabulary declares the policy of the controller's named RPC methods (packages/runtime/account/index.mjs).
export const LIFECYCLE_POLICIES = Object.freeze(LIFECYCLE), GATE_POLICIES = Object.freeze(GATES), ACTIVITY_POLICIES = Object.freeze(ACTIVITY);
export function operationPolicy(registry, name) {
  const Operation = typeof name === 'string' && Object.hasOwn(registry, name) ? registry[name] : null;
  return Operation ? { lifecycle: Operation.lifecycle ?? 'active', gate: Operation.gate ?? 'account', ...Operation.activity ? { activity: Operation.activity } : {} } : {};
}

/** Builds a frozen wire-name registry; a duplicate name or unknown policy is a programming error. */
export function operations(...classes) {
  const registry = {};
  for (const Operation of classes) {
    if (typeof Operation.operation !== 'string' || !(Operation.prototype instanceof AppAction || Operation.prototype instanceof AppQuery)) throw new TypeError(`${Operation.name} is not an app operation`);
    if (Object.hasOwn(registry, Operation.operation)) throw new TypeError(`Duplicate operation ${Operation.operation}`);
    if (![undefined, ...LIFECYCLE].includes(Operation.lifecycle) || ![undefined, ...GATES].includes(Operation.gate) || ![undefined, ...ACTIVITY].includes(Operation.activity)) throw new TypeError(`${Operation.name} declares an unknown policy`);
    registry[Operation.operation] = Operation;
  }
  return Object.freeze(registry);
}

// Owner IDs are minted with crypto.randomUUID; the check stays as loose as the
// Node account router (36 hex/dash characters) so no legacy ID is locked out.
const OWNER = /^[a-f0-9-]{36}$/;
/** The authenticated owner an actor speaks for, or an `unauthorized` fault. */
export function ownerOf(actor) {
  if (actor?.kind !== 'owner' || typeof actor.owner !== 'string' || !OWNER.test(actor.owner)) fault('unauthorized', 'Sign in to continue.', 401);
  return actor.owner;
}

// An operation's payload is exactly { actor, id, input }. Nothing else is copied
// from the caller, so a wire request can never set `deps` or any other field.
function scoped(Operation, actor) {
  const deps = Array.isArray(Operation.deps) ? Operation.deps.filter(name => PROVIDERS[name]?.scoped) : [];
  return deps.length ? Object.fromEntries(deps.map(name => [name, { actor }])) : undefined;
}
function payload(target, { actor, id, input } = {}) {
  target.actor = actor; if (id !== undefined) target.id = id; if (input !== undefined) target.input = input;
  // Owner-scoped providers receive the actor as obtain options: the grant is
  // resolved (and refused) during the lease, before `run`/`fetch` starts.
  const deps = scoped(target.constructor, actor); if (deps) target.deps = deps;
}

/**
 * Base for state-changing operations. Subclasses set `static operation` (the
 * wire name), `static deps`, optionally `static changes` (the engineFeed fact
 * fired after success) and implement `run(resources, context)`.
 *
 * The result is emitted as a `result` event, not returned: `dispatch` returns a
 * feed, and `perform` awaits that event. An Action never dispatches another
 * Action (there is no engine in deps); cross-domain work shares a provider or
 * reacts to the fact on engineFeed.
 */
export class AppAction extends Action {
  constructor(params) { super(); payload(this, params); }
  async execute(resources, context) {
    const value = await this.run(resources, context);
    context.dispatchFeed.dispatchEvent(new CustomEvent('result', { detail: value }));
    if (this.constructor.changes) context.engineFeed.dispatchEvent(new CustomEvent(this.constructor.changes, { detail: { operation: this.constructor.operation, owner: this.actor?.owner ?? null } }));
  }
  run() { throw new Error(`${this.constructor.name}.run() not implemented`); }
}

/**
 * Base for reads. Subclasses implement `fetch(resources)`. A one-shot `read`
 * (peek) runs `fetch` once; a subscriber gets a live query that refetches when a
 * fact named in `static refreshOn` fires for the same owner. Refreshes are
 * sequenced (only the newest one notifies) and contained (a failed refresh keeps
 * the last value instead of killing the query); a failed first fetch ends the
 * query with that error.
 */
export class AppQuery extends Query {
  constructor(params) { super(); payload(this, params); }
  async boot(resources, { notify, engineFeed }) {
    let sequence = 0;
    const refresh = async () => { const mine = ++sequence; try { const value = await this.fetch(resources); if (mine === sequence) notify(value); } catch (error) { console.error(`${this.constructor.name} refresh failed:`, error?.code ?? error); } };
    const relevant = event => { if (event.detail?.owner == null || event.detail.owner === this.actor?.owner) refresh(); };
    const events = this.constructor.refreshOn ?? [], stop = () => { sequence++; for (const name of events) engineFeed.removeEventListener(name, relevant); };
    // Listening before the first fetch: a fact fired while it runs starts a newer refresh, which wins.
    for (const name of events) engineFeed.addEventListener(name, relevant);
    this.kill = stop;
    const mine = ++sequence;
    try { const value = await this.fetch(resources); if (mine === sequence) notify(value); } catch (error) { stop(); throw error; }
  }
  fetch() { throw new Error(`${this.constructor.name}.fetch() not implemented`); }
}

/**
 * A domain provider whose resource is an owner-scoped handle. `obtain({ actor })`
 * resolves the owner (refusing during the lease), obtains the declared
 * dependency resources and returns `scope(resources, owner)` frozen: the handle
 * methods take no owner argument, so an operation never holds an owner ID it
 * could pass somewhere else. A provider that declares `accountStore` also checks the store's bound
 * owner. Dependencies are released with the handle.
 */
export class OwnerScopedProvider extends Provider {
  #deps; #held = new WeakMap();
  constructor(deps) { super(); this.#deps = deps; }
  async obtain({ actor } = {}) {
    const owner = ownerOf(actor), resources = {}, obtained = [];
    try {
      for (const name of this.constructor.deps) { resources[name] = await this.#deps[name].obtain(); obtained.push(name); }
      // The grant includes the binding: an account store that belongs to another owner refuses here, in the
      // lease, whoever dispatched (route, facade, harness, CLI, a future system or MCP caller). A store
      // without an owner yet (a fresh account before `warm`, a multi-owner test store) has nobody to protect.
      const bound = await resources.accountStore?.get('owner');
      if (bound !== undefined && bound !== owner) throw new AppFault('forbidden', 'Account owner mismatch.', 403);
      const handle = Object.freeze(this.scope(resources, owner)); this.#held.set(handle, { resources, obtained }); return handle;
    } catch (error) { for (const name of obtained) await this.#deps[name].release(resources[name]); throw error; }
  }
  async release(handle) {
    const held = this.#held.get(handle); if (!held) return; this.#held.delete(handle);
    for (const name of held.obtained) await this.#deps[name].release(held.resources[name]);
  }
  scope() { throw new Error(`${this.constructor.name}.scope() not implemented`); }
}
