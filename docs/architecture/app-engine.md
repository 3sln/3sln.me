# Engine-first application architecture

Status: **provisional**. The design is drafted and a pilot is implemented: the
core, the Views and Tags domains end to end, the engine test harness, the engine
CLI and one client domain. The independent architecture review and the fixes made for it are recorded in
`docs/release/app-engine-review.md`. User sign-off: Reviewer ___ Date ___
Outcome ___. Nothing here changes a production gate in `docs/spec/security.md`.

## 1. Goal

Every piece of application logic, server and client, can be driven through an
ngin Engine in any environment. Agents and tests can then explore and verify
behaviour against the engine before any UI is built or changed. HTTP (Worker and
Node) and the web UI become thin adapters that translate requests and intents
into dispatches.

This follows the user direction of 2026-10-15 (DEVLOG, "Engine-first application
architecture") and the 3sln stack ethos (`../stack/deck/ethos.md`):

- declared dependencies;
- container-owned lifetimes;
- the grant is the object;
- the platform is a provider;
- Actions never dispatch Actions;
- the edge is dumb;
- a migration must be verifiable through facades.

## 2. One factory, two placements

```js
import {createAppEngine} from 'packages/app/engine.mjs';
const engine = createAppEngine({providers, interceptors});
```

- `providers` may only use names from the catalogue (§3). A Provider class is used
  as it is. Any other value is a pre-built resource, wrapped with
  `Provider.fromSingleton`.
- `clock`, `random` and `audit` are required. They are never defaulted: a
  composition that forgets its clock fails at construction, rather than quietly
  reading the wall clock inside a test.
- The `auditTrail` interceptor is always installed, outermost.

The same factory and the same Action/Query classes run in every environment. Only
the provider set changes.

| Placement | Where it runs | Lifetime | Composed by |
|---|---|---|---|
| **account** | inside one account's single writer: the `AccountObject` Durable Object (Worker) or the Node `AccountController` behind its `SerialGate` | one engine per controller (per DO instance or Node account), long-lived | `AccountController` constructor (`packages/runtime/accounts.mjs`), which Worker and Node already share |
| **edge** | stateless request tier: Worker isolate, Node process front | planned: one engine per isolate or process; request-scoped resources are leased, not built | `apps/worker/index.mjs` and `apps/node/server.mjs` (slice 13) |
| test | in-process | one per test | `createTestEngine` (`tests/helpers/app-engine.mjs`) |
| CLI | in-process, in memory or a local SQLite file | one per run | `scripts/engine.mjs`, using the test provider set |

An operation's placement follows from its `deps`. An account operation depends on
account providers such as `accountStore` or `views`. An edge engine does not
provide those, so dispatching an account operation at the edge fails during the
lease with `Dependency not found`. It never runs against the wrong storage.

The edge reaches the account placement through one RPC (§7). Today that RPC is a
plain `object.dispatch(...)` call in `http.mjs`. Slice 13 turns it into an edge
`accounts` provider, so edge Actions can call it too.

## 3. Provider catalogue

The source of truth is `PROVIDERS` in `packages/app/providers.mjs`. It is data:
`node scripts/engine.mjs --list` prints it, and `createAppEngine` refuses a name
that is not catalogued. Each row records:

- placement: edge, account or both;
- kind: platform, effect or domain;
- status: pilot or planned;
- `scoped`, when the provider is obtained with `{actor}` and returns an
  owner-scoped handle.

| Kind | Names | Real implementation | Test implementation |
|---|---|---|---|
| Platform | `accountStore` | DO `ctx.storage`, Node `SqliteMetadata` | `SqliteMetadata(':memory:')` |
| | `itemIndex`, `searchIndex` | `AccountItemIndex`, `SqliteSearchIndex` over DO SQL or Node SQLite | the same classes over the same in-memory database |
| | `blobs`, `archives` | R2, `FileBucket`, both behind `guardedBucket` | map buckets |
| | `accounts`, `identityShards`, `abuse`, `adminStore`, `mcpAuthority`, `federationStore` | DO stubs (Worker), controller maps over SQLite (Node) | in-process controllers |
| Effect | `clock`, `random` | `systemClock`, `cryptoRandom` | `fakeClock`, `seededRandom(createRandom(seed))` |
| | `config` | frozen environment and flags | literal object |
| | `audit` | `nullAudit` today. A durable sink is an open question (§13). | `memoryAudit` |
| | `egress`, `mail`, `push`, `billingProvider` (Polar), `ai` (Workers AI and Vectorize) | the existing ports (`createWorkerFormFetch`, mailer, `createPushTransport`, Polar SDK, `WorkersAIEmbeddingAdapter`) | recording fakes |
| Domain | `views`, `incoming`, `tagRules` (scoped), `messaging` | built over the platform providers above | the same classes |
| | `identity`, `contacts`, `delivery`, `conversations`, `storageQuota`, `billing`, `search`, `lifecycle`, `notifications`, `beams`, `apps`, `automation`, `federation`, `admin` | the existing service classes, wrapped slice by slice (§12) | the same classes over test platform providers |

Rules:

1. **Name the resource, not the technology.** Use `accountStore`, not
   `durableStorage`; `ai`, not `workersAI`.
2. **Every platform and effect provider has a real implementation and an
   in-memory one.** Every provider accepts an injected instance. That duality is
   what the harness and the CLI rest on.
3. **Co-transactional providers share one handle.** `itemIndex` and `searchIndex`
   must be built from the same database as `accountStore`, so that one
   `accountStore.transaction` covers their SQL. A DO storage transaction covers
   `ctx.storage.sql`, and Node runs both on one `DatabaseSync`. The catalogue row
   says so, and a composition must never give them separate databases.
4. **Owner-scoped domain providers are the grant.** `OwnerScopedProvider.obtain({actor})`
   resolves the owner during the lease, so an unauthorized actor is refused
   before `run` or `fetch` starts. It then returns a frozen handle whose methods
   take no owner argument. An operation never holds an owner ID it could pass
   elsewhere. `AppAction` and `AppQuery` pass the actor to every `scoped`
   dependency automatically, using instance `deps`. A scoped provider that
   declares `accountStore` also checks the store's bound `owner` key. A store
   bound to another owner refuses with `forbidden` during the lease, whoever
   dispatched: route, facade, harness, CLI, or a future system or MCP caller.
   `warm()` keeps its own check, which is now defence in depth.
5. **Decide from configuration.** Feature flags come from `config`. Whether a
   provider happens to be bound is never used as a feature flag (ethos §5).

## 4. Operation conventions

Domain operations live together in `packages/app/domains/<domain>.mjs`: providers,
Actions and Queries side by side.

| Aspect | Convention |
|---|---|
| Class name | Actions are imperative (`CreateView`, `DeleteRule`). Queries are nominal (`SavedViews`, `IncomingPage`, `TagRules`). |
| Wire name | `static operation = '<domain>.<verb>'`, for example `views.create` or `rules.restore-default`. It is unique, and enforced by `operations()` in the registry `packages/app/operations.mjs`. |
| Payload | Exactly `{actor, id?, input?}`. The constructor copies nothing else, so a wire request cannot set `deps` or any other field (this is tested). `input` is the untrusted request document, and the domain validates it. |
| Actor | Explicit input: `{kind: 'owner', owner}` today. Later `{kind: 'app', owner, clientId, connection}` for MCP and app RPC, and `{kind: 'system', reason}` for alarms and cron. Providers decide what each kind may obtain. |
| Result | Actions emit `result` on the dispatch feed. `perform(engine, action)` awaits it. `read(engine, query)` is a one-shot `peek`. Nothing awaits `engine.dispatch` directly. |
| Facts | `static changes = 'views-changed'` is emitted on `engineFeed` after success, with `{operation, owner}`. A refused or failed operation announces nothing. |
| Live queries | `static refreshOn = [...facts]`. A subscriber gets a live query: refetches are sequenced and contained, and only facts for the same owner (or for no owner) trigger them. |
| Errors | Throw an Error with a snake_case `code`, a message safe to show, and `status` where the domain knows it. `StorageError`, `MessagingFault` and `IdentityFault` already have this shape. New code uses `AppFault`/`fault()` (`packages/app/faults.mjs`). `faultOf()` is the intended single serializer. Unknown errors become `internal_error` without their message. Today only the CLI uses it: the DO `$fault` envelope in `invoke` and the HTTP funnel keep their own equivalent mapping (unknown errors become `invalid_request` or a 500 without detail) until Phase 0 switches them over. |
| Idempotency | Any operation a client may retry after a lost reply takes an `operationId` (a UUIDv4 inside `input`). A bounded receipt (fingerprint plus result) is written **in the same transaction** as the effect. A replay with a different fingerprint is `*_operation_conflict`. `CreateView` is the reference. The harness proves recovery with the `after` fault, where the commit happens but the reply is lost. |
| Policy | Statics read by the account RPC instead of RPC method names (`operationPolicy`): `lifecycle` (`active` by default, `suspended` or `purging`), `gate` (`account` by default, or `none` for cross-account fanout and lookups a peer may call while holding its own gate), and `activity` (`owner-return` or `resource-use`). `operations()` refuses unknown values. |
| Audit | The `auditTrail` interceptor records `{operation, actor kind/owner, outcome, code}` per Action. It never records the input. |

### Transactions and single writers

- **One Action, at most one transaction per single writer.** Example:
  `MessageViews.mutate` reads, validates, writes and records the receipt inside
  one `accountStore.transaction`. Correctness must not depend on the account gate
  around `invoke`, because the gate is defence in depth. The pilot found a case
  that did depend on it: `DELETE /api/rules/:id` was read-then-replace across two
  transactions. It is now `MessagingService.deleteRule`, a single transaction. A
  seeded scheduler test shows the old shape loses an update and the new one
  never does.
- **Durable Objects.** `transaction()` and `blockConcurrencyWhile()` are both
  callback-scoped, so neither can be split across an interceptor's `enter` and
  `leave`. Transactions therefore stay inside the operation, behind a provider
  method. Interceptors observe; they do not begin or commit. `AccountObject` runs
  `invoke` inside `blockConcurrencyWhile`. A dispatch runs its Action on a later
  macrotask (`setTimeout`), and workerd delivers that timer inside the critical
  section. `tests/worker/app-engine.test.mjs` verifies this against real workerd
  with SQLite Durable Objects. The cost is one event-loop turn per dispatch.
- **Completion.** `perform` resolves on `complete`, carrying the value of the
  captured `result`. That happens after the interceptors' `leave` and after the
  lease is released. An account RPC therefore replies only once every hook has
  run inside the gate, and a hook that fails on the way out fails the call.
- **Not yet verified:** that an async `ctx.storage.transaction` on workerd rolls
  back `ctx.storage.sql` writes made by `itemIndex`. The worker test covers the
  committed path only. A failure-path workerd test is needed before slices 2
  and 8 depend on it.
- **Node.** `SqliteMetadata.transaction` is `BEGIN IMMEDIATE` behind a
  `SerialGate`. `itemIndex` writes run inside it on the same handle. A provider
  method must never call `accountStore.get`/`put` from inside its own
  transaction callback. It uses the `tx` it was given, because the gate is not
  re-entrant. **Reads** through `itemIndex` share the same `DatabaseSync`
  without passing through the gate, so on Node a read can observe a write that
  is not yet committed. "Correct without the gate" holds for writes. Reads rely
  on the account gate in `invoke`, which serializes every operation.
- **Across single writers** (conversation fanout, links between two accounts,
  identity plus account), nothing is atomic. The edge or account Action performs
  idempotent steps with operation IDs, and each receiving single writer
  deduplicates. This is today's model, now stated as a rule.

### Composing across domains

Actions do not dispatch Actions: there is no engine in `deps`, on purpose. There
are three sanctioned shapes:

1. **Shared provider, one transaction.** When two domains must change together
   atomically, factor the rule into a pure transaction function, such as
   `ownerRules(tx, owner)` or `accountRemovalProtection(tx, owner)`. Call it from
   one provider method inside one transaction. The pilot's `IncomingPage` takes
   both `views` and `incoming` as dependencies, rather than one domain calling
   into the other.
2. **Fact and reaction.** Follow-up work reacts to a fact on `engineFeed`, such as
   re-indexing search after `incoming-changed`. The reaction is a subscriber that
   the composition installs. The original Action never knows about it.
3. **Adapter orchestration.** A multi-step flow with user-visible intermediate
   states runs as several dispatches from the adapter (route, alarm, bl flow).
   Each step is idempotent.

## 5. Migrating a service class

The preferred shape: services become providers that hold state and resources, and
Actions and Queries are the public operations. There is no big-bang rewrite.

1. Wrap the existing instance as a provider (`messaging: this.messages`), or write
   an `OwnerScopedProvider` that narrows it to one owner (`TagRulesProvider`).
   Inject `clock`/`random` where the class reads them directly. Example:
   `MessageViews` takes `{uuid}`.
2. Write one Action or Query per public operation in
   `packages/app/domains/<domain>.mjs` and register it in `operations.mjs`.
3. Keep every existing entry point as a **facade** that dispatches. For example,
   `AccountController.createView` becomes `this.dispatch(owner, {operation: 'views.create', input})`.
   The unchanged tests then drive the new code: ethos §10, "1283 tests before,
   1283 after".
4. Point the routes at `dispatch` (§7) and add engine-level tests (§8). Rewrite
   service-level tests onto the harness only where they gain something.
5. Remove the facades when no caller is left. Each removal is its own reviewed
   change.

"Wrapping instances is not owning them": half a graph of pre-built singletons is
an honest first step, but it does not yet show laziness or teardown order. Slices
should move construction into `Provider.fromLazySingleton` as they go. The test
harness already builds `messaging` lazily over the `accountStore` provider.

## 6. The account RPC

`AccountController.dispatch(owner, {operation, id, input})` is on the account
`invoke` allowlist. It does the following:

- clones the request, so a Node caller never shares objects;
- looks the operation up in `ACCOUNT_OPERATIONS`, and refuses unknown names with
  `unsupported_method`;
- warms the account, which includes the owner-mismatch check;
- runs the operation as `{kind: 'owner', owner}`.

`invoke` still applies the lifecycle fence, the account gate, the activity hook
and the `$fault` envelope. For `dispatch`, it reads them from the operation's
declared policy (§4) rather than from the RPC method name, and an unknown
operation gets the strictest level. Every pilot operation uses the defaults:
`active`, inside the gate, no activity. This was moved forward from slice 9 at
review, because billing, unsubscribe, identity keys (blocked while suspended),
MCP (activity) and links or conversations (outside the gate) all need it as soon
as they migrate.

## 7. HTTP as route-to-dispatch adapters

A route parses the transport, dispatches, and serializes:

```js
const dispatch = (Operation, params = {}) => object.dispatch(id, {operation: Operation.operation, ...params});
if (path === '/api/views') return json(request.method === 'POST' ? await dispatch(CreateView, {input: await body(request)}) : await dispatch(SavedViews));
```

What stays in the route, for now:

- reading the session (`OwnerQuery`);
- Origin, CSRF and method checks;
- body size limits;
- rate limits and capacity admission;
- query-string parsing into `input` (for example `/api/incoming`).

These are edge concerns. They move into edge interceptors and Actions in slice 13.
Errors still funnel through the one `catch` in `http.mjs`, unchanged.

Migrated routes:

- `/api/views`, `/api/views/:id`;
- `/api/incoming` (GET and PATCH);
- `/api/rules`, `/api/rules/:id`, `/api/rules/:id/restore`;
- `/api/tags/labels`.

The `/api/account` snapshot reads Views, rules and labels through the same
Queries.

## 8. Engine test harness

`packages/app/memory-providers.mjs` owns the Node-only SQLite composition,
deterministic clock and random resources, audit sink and fact recording.
`tests/helpers/app-engine.mjs` is a thin wrapper that adds test fault injection
and scheduler hooks before providers obtain platform resources:

```js
const t = await createTestEngine({seed, clock, db, faults, wrap, providers, interceptors, incomingReady});
await t.perform(new CreateView({actor: t.actor(), input}));   // real Action
await t.read(new SavedViews({actor: t.actor()}));             // real Query
await t.run('views.delete', {id, input});                     // by wire name, as RPC and CLI do
await t.all([...actions]);                                    // independent dispatches, allSettled shape
t.events; t.audit.entries; t.metadata; t.itemIndex; t.clock.advance(ms); await t.dispose();
```

- **Shared composition.** `accountProviders()` (`packages/app/account.mjs`) is
  the account composition. `AccountController` and `createTestEngine` both call
  it, so the domain providers are identical in both. What differs is honest and
  listed here: production `messaging` is the pre-built `MessagingService` over
  the controller's side-effecting store (search queue, item index, blobs). The
  harness builds it lazily without those effects. Slice 2 converges them.
  Production `messaging` takes `systemClock`/`cryptoRandom`.
- **In-memory provider set.** `SqliteMetadata(':memory:')` as `accountStore`,
  plus `itemIndex` over the same database. `messaging` is a lazy singleton over
  `accountStore`, so chaos on the store reaches it. Domain providers are the
  production classes.
- **Chaos.** `faults: {accountStore: [{method: 'transaction', when: 1, mode: 'after'}]}`
  uses `injectFaults`. `wrap: {accountStore: s => scheduler.wrap(s, 'accountStore')}`
  uses `createScheduler`. Both come from `tests/helpers/chaos.mjs`, are applied
  to platform resources before any provider sees them, and are seeded. Rerun a
  failure with `CHAOS_SEED=<n>`.
- **Fake clock and seeded randomness.** `fakeClock()` and
  `seededRandom(...)`. ID generation uses its own stream, separate from fault
  probability draws, so adding a fault rule does not shift IDs. The same seed
  replays the same View and label IDs (this is tested).
- **Observability.** `events` holds every fact the registered operations declare,
  and `audit.entries` holds the interceptor's trail.

`tests/helpers/chaos.mjs` also gained `concurrently` and `tally`.

The deleted `tests/helpers/engine.mjs` wrapped service calls in a generic Action,
so its suites were service-level. Changes to those suites:

- `engine-views` now dispatches the real operations.
- `engine-delivery`, `engine-billing` and `engine-links` are relabelled as
  service-level and call their services directly, until their slices land.

## 9. Engine CLI

`node scripts/engine.mjs` (or `npm run engine --`) composes the harness provider
set. It runs in memory, or with `--db file.sqlite` for a local file that persists
across runs. `--seed`, `--owner`, `--list` and `--repl` are available. A script
is a JSON array or JSON lines:

```json
{"op":"views.create","input":{"name":"Work","filter":{"version":1,"tagsAll":["work"]}},"as":"work"}
{"op":"views.update","id":{"$":"work.id"},"input":{"name":"W","filter":{"version":1},"expectedRevision":1},"expect":{"revision":2}}
{"op":"views.update","id":{"$":"work.id"},"input":{"name":"X","filter":{"version":1},"expectedRevision":1},"expectFault":"view_conflict"}
{"advance":60000}
{"events":true}
{"audit":true}
```

Output is one JSON line per step. An unmet expectation or an unknown operation
exits with status 1, so an agent can verify behaviour before touching UI.

The CLI never reaches a deployment. It imports `createMemoryEngine` from
`packages/app/memory-providers.mjs`, the same composition the test wrapper uses,
without importing test code. Test-only fault injection stays in the wrapper.

## 10. Client side

The web app's `bl/*` modules are already ngin Actions over providers (`api`,
`browser`, `state`, ...), composed in `apps/web/src/release.mjs`.
`tests/helpers/client-engine.mjs` builds a real `Engine` from these parts:

- the real `BrowserStateProvider`;
- scripted `fakeApi(routes)`, which records calls and the request context each
  one carried. A route handler may return a pending promise, which holds a
  request open while another dispatch overtakes it;
- `fakeBrowser()`, which holds secrets in memory and records effects.

Tests `dispatch` the production Actions and assert on `snapshot()` (a read lease
on the browser model), `api.calls`, `browser.effects` and `facts`. Nothing is
rendered.

Conventions:

- Dispatch through the engine, never `action.execute(...)` by hand. The lease, the
  macrotask and the feed are part of the behaviour.
- Assert on the model and on the requests. Never assert on DOM.
- Hold requests open with deferred route handlers to test overtaking and stale
  results. Never sleep.
- A bl Action that needs a resource the fakes lack should get a provider method
  added. It should not get a test-only branch.

The pilot is `tests/browser/engine-accounts.mjs`, which covers multi-account
switching. It runs in `npm run test:ui-state` under the browser loader.

The `BrowserState` UI projection needs `portalContributions`, and that imports
`/packages/portal` paths the Node loader does not map. Composing it in the client
harness is follow-up work.

## 11. Durable Object and SQLite mapping, summarized

| Concern | Worker (DO) | Node | Test or CLI |
|---|---|---|---|
| Single writer | `blockConcurrencyWhile` in `invoke` | `SerialGate` in `invoke` | none: operations must be correct without it |
| Commit boundary | `ctx.storage.transaction(cb)` | `BEGIN IMMEDIATE` … `COMMIT` | same as Node, `:memory:` |
| SQL with metadata | `ctx.storage.sql` inside the storage transaction | same `DatabaseSync` | same |
| Alarms | `alarm()` → planned `system` actor dispatches | `SqliteMetadata.onAlarm` | `clock.advance` plus an explicit dispatch |
| Dispatch cost | one macrotask per operation, inside the gate | same | same |

## 12. Migration order and slice ownership

**Phase 0** (one agent, before parallel slices) removes the shared hot spots, so
that each later slice changes a shared file only by one import or spread line,
which an integrator applies:

- Move the remaining owner routes out of `packages/runtime/http.mjs` into
  per-domain modules `packages/runtime/routes/<domain>.mjs`.
  `automationRoutes`/`beamRoutes` already follow this pattern.
- Move per-domain `AccountController` methods into
  `packages/runtime/account/<domain>.mjs`, exporting `{methods, rpc}`. `rpc`
  declares lifecycle access, gate placement, activity and warming for `invoke`.
  `automationMethods`/`conversationMethods` already follow this pattern.
- The `PROVIDERS` rows, the `ACCOUNT_OPERATIONS` list and the
  `accountProviders()` spread stay in core files. A slice edits only its own
  rows and its own line.
- Assign owners to the shared hot spots that the review found unassigned:
  - Phase 0 owns the shared parts of `packages/runtime/accounts.mjs`
    (constructor, `invoke`, `warm`, `snapshot`), both slice registries and shared
    helpers, `packages/app/memory-providers.mjs` and `tests/helpers/app-engine.mjs`.
    Lifecycle policy now comes from each account slice's `rpc` entries rather
    than shared method sets in `lifecycle-runner.mjs`.
  - `packages/messaging/messages.mjs` and `packages/runtime/item-index.mjs`
    belong to slice 2. Slices 4 and 8 request changes to them through slice 2's
    owner or the integrator.
- Switch the DO `$fault` envelope and the HTTP catch to `faultOf`. Today a coded
  system error, for example `ERR_SQLITE_ERROR`, reaches the caller with its raw
  message. This remains follow-up work; the mechanical split preserves the
  existing error behavior.

The mechanical split's file-ownership map is below. These are responsibility
boundaries for future slices, not reviewer sign-off. Each domain owns its route
stages, method allowlist and capacity-admission rules, plus its account methods
and RPC policies. Shared registration changes go through the core integrator;
domain slices do not edit each other's files.

| Slice | HTTP adapter (`packages/runtime/routes/`) | Account adapter (`packages/runtime/account/`) |
|---|---|---|
| 0: core integrator | `index.mjs`, `shared.mjs`, `site.mjs`; `packages/runtime/http.mjs` | `index.mjs`, `support.mjs`; shared controller in `packages/runtime/accounts.mjs` |
| 1: Views and tags | `views.mjs` | `views.mjs` |
| 2: Messages and collections | `messages.mjs` | `messages.mjs` |
| 3: Contacts and intake | `contacts.mjs` | `contacts.mjs` |
| 4: Inbound delivery and link replay | `delivery.mjs` | `delivery.mjs` |
| 5: Conversations | `conversations.mjs` | `conversations.mjs` |
| 6: Storage and Google Drive | `storage.mjs` | `storage.mjs` |
| 7: Billing | `billing.mjs` | `billing.mjs` |
| 8: Search | `search.mjs` | `search.mjs` |
| 9: Lifecycle and retention | `lifecycle.mjs` | `lifecycle.mjs` |
| 10: Notifications and app connections | `notifications.mjs` | `notifications.mjs` |
| 11: Beaming | `beams.mjs` | `beams.mjs` |
| 12: Automation | `automation.mjs` | `automation.mjs` |
| 13a: Edge identity and sessions | `identity.mjs` | `identity.mjs` |
| 13b: Administration and signup admission | `admin.mjs` | — |
| 13c: Federation and MCP authority | `federation.mjs` | — |

Slice 0 also owns `packages/app/memory-providers.mjs`, the thin test wrapper and
CLI. Existing domain implementation files remain assigned by the table below.
The registries preserve cross-cutting route order; in particular delivery bearer
RPC precedes federation RPC, and beam contact routes precede generic contacts.

Each slice owns `packages/app/domains/<domain>.mjs`, the
`tests/engine-<domain>*.test.mjs` suites it creates or converts, and the files
listed below. No two slices own the same file.

| # | Slice | Depends on | Owned files (besides its domain module and tests) |
|---|---|---|---|
| 0 | Core and harness (pilot, done) | — | `packages/app/{engine,providers,faults,operations,account,memory-providers}.mjs`, `tests/helpers/{app-engine,client-engine,chaos}.mjs`, `scripts/engine.mjs`, this document |
| 1 | Views and tags (pilot, done) | 0 | `packages/runtime/message-views.mjs`, `packages/messaging/tags.mjs`, `tag-policy.mjs` |
| 2 | Messages and collections (read, update, delete, page, presentations, postbacks) | Phase 0 | `packages/messaging/{messages,store,content,message-metadata,presentation-summary,form-*,submission-status}.mjs`, `packages/runtime/{item-index,message-presentations,message-postbacks}.mjs` |
| 3 | Contacts and intake (contact tokens, endpoints, links, previews, developer contact) | Phase 0 | `packages/messaging/{contact-tokens,contact-endpoints}.mjs`, `packages/runtime/{contact-links,contact-preview,developer-contact}.mjs` |
| 4 | Inbound delivery and link replay | 3 | `packages/messaging/{contact-delivery*,link-replay,bindle-links,dispatcher}.mjs`, `packages/runtime/message-receipt-budget.mjs`; converts `engine-delivery`, `engine-links` |
| 5 | Conversations | 13a (`accounts` router) | `packages/conversations/*` |
| 6 | Storage, quota, resources, Google Drive | Phase 0 | `packages/storage/*`, `packages/runtime/{storage-quota,storage-write-budget,guarded-bucket,work-budget,identity-backup}.mjs`; converts `engine-storage-chaos` |
| 7 | Billing | Phase 0 | `packages/billing/*`, `packages/runtime/lifecycle-finance.mjs`, `apps/worker/plan-catalog.mjs`; converts `engine-billing` |
| 8 | Search | Phase 0 | `packages/search/*`, `packages/runtime/semantic-*.mjs`, `apps/worker/semantic-budget.mjs` |
| 9 | Lifecycle and retention (fence becomes an interceptor; alarms become `system` dispatches) | 2–8 | `packages/runtime/{lifecycle-runner,lifecycle-scheduler,lifecycle-storage,account-lifecycle,cleanup-retry,active-population}.mjs`, `packages/identity/lifecycle*.mjs`, `apps/worker/lifecycle.mjs` |
| 10 | Notifications, push, app connections and MCP account tools | Phase 0 | `packages/messaging/{notifications,web-push}.mjs`, `packages/runtime/app-notifications.mjs`, `packages/apps/*`, `packages/mcp/account.mjs` |
| 11 | Beaming | Phase 0 | `packages/beaming/*` |
| 12 | Automation | Phase 0 | `packages/automation/*` |
| 13a | Edge engine and identity (`createEdgeEngine`, `accounts` router, sessions) | 0 | `apps/worker/{index,objects,password,secrets}.mjs`, `apps/node/{server,resources}.mjs`, `packages/identity/{index,service,webauthn,crypto}.mjs`, `packages/runtime/{account-session-http,account-cookies,identity-shards,secrets}.mjs` |
| 13b | Admin, boot, abuse, waitlist, signup capacity | 13a | `packages/identity/admin*.mjs`, `packages/runtime/{admin-http,waitlist,signup-*}.mjs`, `packages/core/abuse-policy.mjs` |
| 13c | Federation and the MCP authority | 13a | `packages/federation/*`, `packages/runtime/{federation,federation-entry-http}.mjs`, `packages/mcp/{runtime,http}.mjs`, `apps/worker/{federation,mcp-object,client-metadata-fetch}.mjs` |
| C1 | Client: accounts (pilot, done) | 0 | `tests/browser/engine-accounts.mjs` |
| C2… | Client: one per `apps/web/src/bl/<domain>.mjs` | 0 | that bl file plus `tests/browser/engine-<domain>.mjs` |

**Parallel order:**

1. Phase 0.
2. In parallel: {2, 3, 6, 7, 8, 10, 11, 12}, 13a, and any C-slices.
3. Then 4 (after 3), 5 (after 13a), and 13b/13c (after 13a).
4. Lifecycle (9) comes last, because it touches the fence for every domain.

Each slice must:

- record in DEVLOG.md any difference between this specification and what it
  implemented;
- keep every gate green (`npm test`, `test:worker`, `test:ui-state`, `test:dom`,
  `build:assets`, `check:worker`, `test:e2e`);
- add an engine-level suite through the harness for every operation it
  registers.

## 13. Open questions (for the user)

1. **Authorization shape.** The pilot uses owner-scoped providers: the grant is
   the object, and refusal happens during the lease. The stack deck leaves
   provider versus interceptor open. Should this be house style here?
2. **Account RPC.** There is one generic `dispatch` method, instead of one RPC
   method per operation. The lifecycle fence, gate placement and activity then
   come from per-operation metadata, which is now implemented. Accept?
3. **Edge engine lifetime.** Per isolate or process, with request-scoped leases
   (recommended), or per request as `createIdentityEngine` does today?
4. **Behaviour changes in the pilot.**
   - `PATCH /api/incoming` now warms the account before it validates input, so an
     owner mismatch is reported before `invalid_view`.
   - Rules and labels are refused with `forbidden` if the account store belongs
     to another owner (the owner binding).
   - `PUT /api/rules` without `rules` now answers `400 invalid_rules`. It used to
     return the list.
   - Rules and label operations now warm the account first, like Views.
   - `DELETE /api/rules/:id` no longer re-validates the remaining rules. Before,
     a rule pointing at a disabled collection blocked unrelated deletions.
5. **Durable audit.** Production uses `nullAudit`. Should the audit trail go to a
   bounded DO-storage ring, to Workers Analytics Engine, or nowhere?
6. **MCP and app RPC.** Should every MCP tool become a dispatch of the same
   Actions with an `app` actor? The aim is that "an agent holding Alice's token
   is Alice", with no second, MCP-shaped path.
7. **CLI provider set (implemented).** The shared set lives in
   `packages/app/memory-providers.mjs`, with a Node-only SQLite import. The CLI
   imports it directly; `tests/helpers/app-engine.mjs` adds only test fault hooks.
