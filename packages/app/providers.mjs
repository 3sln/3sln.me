// The application provider catalogue (docs/architecture/app-engine.md §3).
//
// Every resource an operation may declare in `deps` has exactly one name here.
// `createAppEngine` refuses a name that is not catalogued, so a new provider is
// a reviewed catalogue change rather than a string some Action invented. The
// catalogue is data: tests and the engine CLI list it, and a migration slice
// adds its row (and nothing else) to this file.
//
// placement  edge     stateless request tier (Worker isolate / Node process front)
//            account  inside one account's single writer (AccountObject DO / Node
//                     AccountController behind its SerialGate)
// kind       platform a runtime resource with a real and an in-memory implementation
//            effect   time, randomness and the outside world; always injected
//            domain   state plus rules (a former service class), built over
//                     platform providers; owner-scoped handles where the grant matters
// status     pilot    implemented and dispatched in production code
//            planned  reserved name, provided by a later migration slice
// scoped     obtained with { actor }; the resource is an owner-scoped handle and
//            AppAction/AppQuery pass the actor automatically
const row = (placement, kind, status, summary, extra = {}) => Object.freeze({ placement, kind, status, summary, ...extra });
export const PROVIDERS = Object.freeze({
  // Platform resources.
  accountStore: row('account', 'platform', 'pilot', 'Transactional key/value metadata of one account (DO ctx.storage, Node SqliteMetadata); `transaction` is the single-writer commit boundary.'),
  itemIndex: row('account', 'platform', 'pilot', 'SQLite inbox/incoming catalog (AccountItemIndex). Co-transactional with accountStore: built from the same database handle.'),
  searchIndex: row('account', 'platform', 'planned', 'SQLite FTS index plus metadata outbox, co-transactional with accountStore.'),
  blobs: row('account', 'platform', 'planned', 'Guarded object bucket for message bodies (R2 BLOBS, Node FileBucket).'),
  archives: row('account', 'platform', 'planned', 'Guarded cold/snapshot bucket (R2 ARCHIVES, Node FileBucket).'),
  accounts: row('edge', 'platform', 'planned', 'Router from owner ID to that account\'s single writer (ACCOUNTS DO stub, Node controller map).'),
  identityShards: row('edge', 'platform', 'planned', 'Sharded identity directory (IDENTITIES DO stubs, Node SQLite).'),
  abuse: row('edge', 'platform', 'planned', 'Fixed-window rate limits, signup capacity, waitlist and active population (ABUSE DO, Node SQLite).'),
  adminStore: row('edge', 'platform', 'planned', 'Linearizable host administration store (ADMIN_AUTHORITY DO, Node SQLite).'),
  mcpAuthority: row('edge', 'platform', 'planned', 'Sharded MCP authorization store (MCP_AUTH DO, Node SQLite).'),
  federationStore: row('edge', 'platform', 'planned', 'Federation sessions and authorization entries (FEDERATION DO, Node SQLite).'),
  // Effects.
  clock: row('both', 'effect', 'pilot', '{ now() } in epoch milliseconds. Fake in tests.'),
  random: row('both', 'effect', 'pilot', '{ uuid(), bytes(n) }. Seeded in tests.'),
  config: row('both', 'effect', 'planned', 'Frozen deployment configuration and feature flags, decided from configuration (never inferred from a bound resource).'),
  audit: row('both', 'effect', 'pilot', '{ record(entry) } operation audit sink; fed by the auditTrail interceptor.'),
  egress: row('both', 'effect', 'planned', 'Policy-checked outbound fetch (form postbacks, client metadata, Google Drive).'),
  mail: row('edge', 'effect', 'planned', 'Transactional mail transport (Cloudflare Email, SMTP, recording fake).'),
  push: row('both', 'effect', 'planned', 'Web Push transport.'),
  billingProvider: row('account', 'effect', 'planned', 'Polar client (products, customers, subscriptions, checkout).'),
  ai: row('account', 'effect', 'planned', 'Workers AI embeddings and Vectorize shards, behind the semantic budget.'),
  // Domain stores.
  views: row('account', 'domain', 'pilot', 'Owner-scoped saved Views (MessageViews). Obtain with { actor }.', { scoped: true }),
  incoming: row('account', 'domain', 'pilot', 'Owner-scoped incoming pages and organization over itemIndex. Obtain with { actor }.', { scoped: true }),
  messaging: row('account', 'domain', 'pilot', 'MessagingService over the account store (collections, rules, labels, messages).'),
  tagRules: row('account', 'domain', 'pilot', 'Owner-scoped tag rules and tag labels over messaging. Obtain with { actor }.', { scoped: true }),
  identity: row('edge', 'domain', 'planned', 'IdentityService (sessions, signup, recovery, device login).'),
  contacts: row('account', 'domain', 'planned', 'Contact tokens, endpoints and intake.'),
  delivery: row('account', 'domain', 'planned', 'ContactDeliveryService (authored link delivery).'),
  conversations: row('account', 'domain', 'planned', 'Conversation sources, inboxes and fanout.'),
  storageQuota: row('account', 'domain', 'planned', 'Storage quota, reservations and write budgets.'),
  billing: row('account', 'domain', 'planned', 'BillingService (entitlement, webhooks, changes).'),
  search: row('account', 'domain', 'planned', 'SearchService and semantic budget.'),
  lifecycle: row('account', 'domain', 'planned', 'Account lifecycle runner and retention protection.'),
  notifications: row('account', 'domain', 'planned', 'NotificationService and app notifications.'),
  beams: row('account', 'domain', 'planned', 'BeamService and beam contacts.'),
  apps: row('account', 'domain', 'planned', 'App connections and MCP account operations.'),
  automation: row('account', 'domain', 'planned', 'Browser automation records.'),
  federation: row('edge', 'domain', 'planned', 'Federation authority, client directory and entries.'),
  admin: row('edge', 'domain', 'planned', 'AdminService (boot, reserved names, client blocks).'),
  extensions: row('edge', 'domain', 'planned', 'EXT-X1: unmounted slot/declaration validation and provider-wide digest pins; EXTENSIONS_ENABLED required.'),
});

export const systemClock = Object.freeze({ now: () => Date.now() });
export const cryptoRandom = Object.freeze({ uuid: () => crypto.randomUUID(), bytes: n => crypto.getRandomValues(new Uint8Array(n)) });
export const nullAudit = Object.freeze({ record() {} });
/** A bounded in-memory audit sink: the newest `limit` entries, stamped with `clock`. */
export function memoryAudit({ clock = systemClock, limit = 1000 } = {}) {
  const entries = [];
  return { entries, record(entry) { entries.push({ at: clock.now(), ...entry }); if (entries.length > limit) entries.splice(0, entries.length - limit); } };
}
// Only who and what, never the input: inputs carry message text, filters and tokens.
const subject = actor => actor && typeof actor === 'object' ? { kind: String(actor.kind), ...typeof actor.owner === 'string' ? { owner: actor.owner } : {} } : null;
const entry = (ctx, outcome, error) => ({ operation: ctx.action.constructor.operation ?? ctx.action.constructor.name, actor: subject(ctx.action.actor), outcome, ...error?.code ? { code: String(error.code) } : {} });
/**
 * Records one entry per dispatched Action (queries are reads and are not
 * audited). An interceptor rather than a call in each Action, so an operation
 * cannot forget it; it observes and never changes the outcome. It is not a
 * transaction boundary: DO `transaction()` and `blockConcurrencyWhile()` are
 * callback-scoped, so begin/commit cannot be split across enter and leave.
 */
export const auditTrail = Object.freeze({
  deps: ['audit'],
  leave({ audit }, ctx) { if (ctx.action) audit.record(entry(ctx, 'ok')); },
  error({ audit }, ctx) { if (ctx.action) audit.record(entry(ctx, 'error', ctx.error)); },
  abort({ audit }, ctx) { if (ctx.action) audit.record(entry(ctx, 'abort', ctx.error)); },
});
