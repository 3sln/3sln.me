// Node-only in-process account composition shared by the engine CLI and tests (app-engine.md §8–9).
// SQLite defaults to :memory:; wrap decorates platform resources before lazy providers obtain them.
// Test fault injection is supplied by tests/helpers/app-engine.mjs, never imported here.
import { Provider } from '../../vendor/ngin/index.js';
import { createAppEngine, perform, read, operate } from './engine.mjs';
import { memoryAudit } from './providers.mjs';
import { ACCOUNT_OPERATIONS } from './operations.mjs';
import { accountProviders } from './account.mjs';
import { MessagingService } from '../messaging/index.mjs';
import { AccountItemIndex } from '../runtime/item-index.mjs';
import { SqliteMetadata } from '../../apps/node/resources.mjs';
export function createRandom(seed = 1) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = n => Math.floor(next() * n);
  return {
    seed,
    next,
    int,
    pick: list => list[int(list.length)],
    shuffle: list => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = int(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; },
    chance: p => next() < p,
  };
}

export function fakeClock(start = Date.UTC(2026, 9, 14, 12)) {
  let current = start;
  return { now: () => current, advance: ms => { current += ms; return current; }, set: ms => { current = ms; return current; } };
}

const concurrently=fns=>Promise.all(fns.map(fn=>new Promise(resolve=>setTimeout(resolve)).then(fn).then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}))));

export const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ownerActor = (owner = OWNER) => ({ kind: 'owner', owner });

/** The `random` provider resource over a seeded PRNG: version 4 UUIDs and bytes, reproducible by seed. */
export function seededRandom(random) {
  const bytes = n => Uint8Array.from({ length: n }, () => random.int(256));
  return { seed: random.seed, bytes, uuid() { const b = bytes(16); b[6] = b[6] & 0x0f | 0x40; b[8] = b[8] & 0x3f | 0x80; const h = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; } };
}
/** The MessagingService store contract over account metadata: AccountController's adapter without its
 * search/index/blob side effects, which belong to domains this harness does not compose yet. */
export const metadataStore = metadata => ({ transaction: operation => metadata.transaction(tx => operation({ get: key => tx.get(key), set: (key, value) => tx.put(key, value), delete: key => tx.delete(key), list: async prefix => [...await tx.list({ prefix })].map(([key, value]) => ({ key, value })) })) });

// Built over whatever accountStore resolves to, so faults and schedulers on the store reach messaging too.
const MessagingProvider = Provider.fromLazySingleton(async ({ accountStore, clock, random }) => {
  const [store, time, ids] = [await accountStore.obtain(), await clock.obtain(), await random.obtain()];
  return new MessagingService({ store: metadataStore(store), tokens: null, clock: time.now, crypto: { randomUUID: ids.uuid, subtle: crypto.subtle, getRandomValues: array => crypto.getRandomValues(array) } });
}, undefined, { deps: ['accountStore', 'clock', 'random'] });

const FACTS = [...new Set(Object.values(ACCOUNT_OPERATIONS).map(Operation => Operation.changes).filter(Boolean))];

export async function createMemoryEngine({ db = ':memory:', seed = Number(process.env.CHAOS_SEED ?? 1), clock = fakeClock(), random, wrap = {}, providers = {}, interceptors = [], incomingReady = true } = {}) {
  // Two streams: fault probabilities draw from `random`, generated IDs from `ids`, so adding a fault rule
  // never shifts the IDs a seed produces.
  random ??= createRandom(seed); const ids = createRandom((seed ^ 0x5eed5eed) >>> 0);
  const metadata = new SqliteMetadata(db), itemIndex = new AccountItemIndex(metadata.sql);
  if (incomingReady && !await metadata.get('item-index-ready')) { await metadata.put('item-index-ready', true); itemIndex.migrateIncoming(); }
  const decorate=(name,resource)=>wrap[name]?wrap[name](resource):resource;
  const audit = memoryAudit({ clock });
  // The production account composition over in-process resources; `providers` overrides by name.
  const engine = createAppEngine({ providers: { ...accountProviders({ accountStore: decorate('accountStore', metadata), itemIndex: decorate('itemIndex', itemIndex), messaging: MessagingProvider, clock, random: seededRandom(ids), audit }), ...providers }, interceptors });
  // Every engineFeed fact the registered operations declare, in order: what UI and reactions would see.
  const events = [], record = event => events.push({ type: event.type, ...event.detail });
  for (const fact of FACTS) engine.feed.addEventListener(fact, record);
  const byName = (name, params = {}) => { if (!Object.hasOwn(ACCOUNT_OPERATIONS, name)) throw new TypeError(`Unknown operation ${name}`); return new ACCOUNT_OPERATIONS[name]({ actor: ownerActor(), ...params }); };
  return {
    engine, metadata, itemIndex, clock, audit, events, random,
    actor: ownerActor,
    perform: (action, options) => perform(engine, action, options),
    read: query => read(engine, query),
    /** Dispatch by wire name, as the account RPC and the CLI do; the actor defaults to OWNER. */
    run: (name, params) => operate(engine, byName(name, params)),
    /** Dispatch independent operations, each on its own macrotask; Promise.allSettled-style results. */
    all: operations => concurrently(operations.map(operation => () => operate(engine, operation))),
    async dispose() { await engine.dispose(); metadata.close(); },
  };
}
