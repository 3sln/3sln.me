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
  activity: row('account', 'domain', 'pilot', 'ACT-1: owner-scoped activity feed/state, and app-bound create/replace/retract with signed admission evidence (packages/activity). Obtain with { actor } (owner or verified app); app handles also need { keys }. Exposure gated by ACTIVITY_V2_ENABLED.', { scoped: true }),
  integrations: row('edge', 'domain', 'planned', 'EXT-X3: unmounted integration manifest validation, key pinning and §2.3 change classification over the client directory; INTEGRATIONS_ENABLED required.'),
  eventBuses: row('edge', 'domain', 'planned', 'EV-1: unmounted bus manifest validation and immutable fragment pins; EVENT_BUSES_ENABLED required.'),
  deviceGrant: row('edge', 'domain', 'planned', 'LA2: unmounted RFC 8628 device grant (device endpoint, device_code token grant, app-kind consent, DPoP RPC, lineage drain) over the linked-approval port and owner federation shards; DEVICE_AUTHORIZATION_ENABLED required.'),
  links: row('account', 'domain', 'pilot', 'BB-C1a: links contract (issue, revoke, rotate, evaluate, list, changes) over LinkService; owner or slot-occupant app actors; BINDLEBOX_ENABLED required. Obtain with { actor }.', { scoped: true }),
  delegations: row('account', 'domain', 'pilot', 'IDKEYS-2 (BB-C3): key-delegation.v1 certificates (issue, renew, revoke, reconcile, list, public status) over DelegationRegistry; owner, messaging-ingress occupant app, system or public actors; BINDLEBOX_ENABLED required. Obtain with { actor }.', { scoped: true }),
  activityPush: row('account', 'domain', 'pilot', 'ACT-2: owner-scoped activity push policy (per-app opt-in, rules, quiet hours, digests, budgets, preview consent) and the leased activity push outbox (packages/messaging/notifications.mjs). Obtain with { actor }. Reached only through the ACTIVITY_V2_ENABLED-checked account RPC.', { scoped: true }),
  consent: row('both', 'domain', 'planned', 'CX-1: unmounted pure consent risk/wording model over pinned contracts, manifests, reviewed apps and current feed readers; INCREMENTAL_AUTH_ENABLED required.'),
  connections: row('account', 'domain', 'pilot', 'EXT-X4: integration connections (lifecycle state, generation fencing, kinds external/built-in), slot occupancy as the owner\'s ordered value, transactional outbox and delegation cascades, and the LINK/DELEGATION_SLOT_OCCUPANT ports (packages/app/domains/connections.mjs); owner or system actors; INTEGRATIONS_ENABLED required. Obtain with { actor }.', { scoped: true }),
  eventBus: row('account', 'domain', 'pilot', 'EV-2: the 3sln.me-hosted event bus (packages/events): owner bus management, reader floors and revocation, cursor reads with leased long-polls held outside the account object, schema-checked publishes under a separate event allowance, retention with gap reporting; owner, system, verified app or enabled provider-feature actors; EVENT_BUSES_ENABLED required. Obtain with { actor } (app/feature also { bus }).', { scoped: true }),
  incremental: row('edge', 'domain', 'planned', 'IA-1/IA-2: unmounted grant-more/configure entry intents (admit, begin, decide, abandon, token exchange), request suppression, caps and the decline ladder over the owner-shard grants/preferences/sessions ports (packages/federation/incremental.mjs, suppression.mjs); INCREMENTAL_AUTH_ENABLED required.'),
  integrationEvents: row('account', 'domain', 'pilot', 'EXT-X6: the integration event outbox and RFC 8417/8935 SET delivery (packages/runtime/integration-events.mjs): X4 outbox ingest, coalesced per-connection rows with strictly increasing seq, signed event-purpose SETs over SSRF-safe egress, retries, dead letters that degrade the connection, owner-visible status. Obtain with { actor } (system; owner for status). INTEGRATIONS_ENABLED required.', { scoped: true }),
  brokeredResources: row('account', 'domain', 'pilot', 'EXT-X7: brokered resource records (provider-owned coupling per connection, integration resource, field binding, consumer and generation), owner discovery through the integration discovery endpoint with signed 60 s tokens, SSRF-safe egress, budgets and caching, revalidation, the C1b messaging `describe` and X8 severance/minting hooks (packages/federation/brokered.mjs, resource-discovery.mjs); owner or system actors; INTEGRATIONS_ENABLED (records also BROKERING_ENABLED) required. Obtain with { actor }.', { scoped: true }),
  eventDoorbells: row('account', 'domain', 'pilot', 'EV-3: data-free push doorbells for hosted event buses (packages/events/doorbell.mjs): subscriptions keyed by (bus, connection) under the reader\'s read approval and connection generation, owner push switch, coalesced ring passes that enqueue at most one pending bus-advanced row per subscription into the X6 outbox under a separate doorbell row budget and fair-share hourly budgets in the event-allowance meters, cancellation with revocation; owner, system or verified app actors; EVENT_BUSES_ENABLED and INTEGRATIONS_ENABLED required. Obtain with { actor }.', { scoped: true }),
  brokeredTokens: row('account', 'domain', 'pilot', 'EXT-X8: brokered consumer token minting (check, sign, confirm against X7 severance), severance draining into X6 revocation SETs with access_ends_by, preferences/v2 descriptors, live introspection checks and the integration pin for RFC 7523 client authentication (packages/federation/introspection.mjs). Obtain with { actor } (system). INTEGRATIONS_ENABLED and BROKERING_ENABLED required.', { scoped: true }),
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
