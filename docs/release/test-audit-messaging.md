# Test audit: messaging and data domain

Date: 2026-10-14. Scope: tests covering `packages/messaging`, `conversations`,
`storage`, `billing`, `search`, `beaming`, `automation`, `mcp`, `apps`, and the
runtime message-views, item-index, app-notifications, account-lifecycle,
active-population, storage-write and work-limit guards. This is a working audit
by a test agent. It is not a release sign-off.

## Levels

- **Engine**: the test calls domain services directly (`ContactDeliveryService`,
  `MessagingService`, `BillingService`, `SearchService`, `AccountLifecycle`,
  `AccountItemIndex`, `StorageQuota`, or `AccountController` as the account
  engine). Resources are injected in-memory fakes: `MemoryMessagingStore`,
  `SqliteMetadata(':memory:')`, map buckets, fake provider clients and fake
  clocks. There is no HTTP framing and no DOM.
- **Adapter/HTTP**: the test goes through `application.fetch`, `createNodeServer`,
  route handlers with `Request` objects, the Node/Worker fetch adapters,
  `FileBucket`, or real timers inside `SqliteMetadata`.
- **UI**: rendered HTML or meta-tag output. In this domain only `contact-preview`
  (meta and oEmbed HTML) and parts of `conversation-content` are UI-level. All
  other DOM tests live under `tests/browser` and are outside this audit.

| Area | Engine | Adapter/HTTP | UI |
|---|---|---|---|
| messaging, links, delivery, tags, postbacks | contact-delivery, contact-delivery-spec, contact-endpoints(-links), contact-tags, link-replay, link-response, bindle-links, messaging, tags, message-postbacks, message-presentations(-summary), message-push-preview, message-receipt-budget (21–82), message-views (most), submission-status, developer-contact (15–52) | links-http, node-contact, message-postbacks-http-audit, message-receipt-budget 123, message-views 63, developer-contact 68 | contact-preview |
| conversations | conversations, conversations-audit (most), conversation-content | conversations-http, conversations-portable, conversations-audit 32/48/50 | conversation-content 8 (escaped render) |
| storage, quota, write/work guards | storage, storage-providers, storage-no-list-audit, storage-write-budget, storage-write-integration, scaling-audit (most), work-budget (16–62), work-spend-audit, builtin-storage (most), object-urls 4, google-drive(-audit) | object-urls proxy tests, scaling-audit 147/174/184/210, work-budget 77, google-drive-runtime, node-alarm-lifecycle | none |
| billing | billing (most), billing-changes, billing-paid-handle, billing-registry, paid-signup, billing-webhook-routing 5 | billing webhook signature tests (46/53/135/136), billing-webhook-routing 4/6 | none |
| search | search, search-runtime, semantic-global-budget, semantic-spend-audit | none | none |
| beaming, automation, mcp, apps | beaming-security 41–83, browser-automation-*, app-connections-audit, app-metadata(-audit/-node), app-notifications(-audit) most, mcp 24/52, mcp-audit 18–20, form-fetch-injection 13, callable-commands-audit | beaming-runtime (most), beaming-security 23–36, mcp 16/32/42/49, mcp-audit 17, form-fetch, app-notifications-audit 131/149 | none |
| lifecycle, population | account-lifecycle, lifecycle-runner, lifecycle-paid-protection, active-population (most) | active-population 13 (disk SQLite + timers) | none |

## Problems found and what was done

### Nondeterminism: fixed

| Test | Problem | Fix |
|---|---|---|
| contact-delivery `scope: …time window` | The service ran on the real clock and the future-skew probe had about 1 s of slack. | The fixture injects a fixed service clock and a fixed `createdAt`. Probes are exact (`NOW±limit±1`). |
| message-postbacks `budgets fail closed` | It seeded a minute bucket at `Date.now()`, so a minute rollover changed the reason. | Both the minute and the day windows are exhausted, so only a UTC-midnight crossing could still affect the outcome. |
| app-notifications `per-connection minute quota` | It used a fixed minute bucket on wall time. | Wall time is frozen mid-minute with `t.mock.timers` (Date only). |
| app-metadata `concurrent MCP consent` | It used a real `setTimeout(5)` sleep. | It waits on a fetch-started deferred plus bounded event-loop turns. No wall time is involved. |
| app-metadata-audit `hanging metadata body` | It waited out the real 1.5 s metadata timeout. | Mocked `setTimeout` ticks the deadline. The test now takes milliseconds. |
| billing `SDK verifies… timestamp` | The ±301 s tolerance probes had about 1 s of slack against wall time. | Date is frozen, so the probes sit exactly 1 s outside the tolerance. |
| semantic-global-budget `reservations serialize` | It had no clock, so day and month periods followed wall time. | A fixed clock is injected. |
| work-budget fixed-window and partition tests | The 1 s window ran on wall time. The test also searched random UUIDs for shard collisions. | A mid-window fixed clock is used, with a deterministic owner sequence. |
| lifecycle-runner `sweep is bounded, leased…` | The sweep time budget and lease expiry ran on wall time. | A fixed `LifecycleSweep` clock is used. |
| active-population `daily marker` / `never-resolving RPCs` | The first ran on wall-time UTC days. The second asserted `performance.now() < 1000` with a real 5 ms deadline. | Date is frozen. Mocked `setTimeout` ticks the deadline, and settling is asserted without measuring time. |
| developer-contact tier and UTC-day tests | Freshness and per-author day quotas ran on wall time. | Date is frozen. |
| message-receipt-budget runtime tests (101–123) | The controller's receipt windows ran on wall time and broke at midnight. | Date is frozen at `START`. |
| conversations-audit `group()` | It had no service clock. | It uses one fixed clock for every peer. |
| conversations-portable | It used `sleep(20)` polling loops with a 1 s budget for alarm-driven drains. | It drains both hosts explicitly for a bounded number of rounds. It runs about 1 s faster. |
| node-alarm-lifecycle retry, work-spend-audit alarm | The first asserted `time >= Date.now()+59000` after awaiting. The second used a 1 s real-timer race. | The first assertion is now relative to the failure instant. The second is a 10 s hang guard only. |

### Nondeterminism: retained and documented

- `form-fetch` (Node and Worker): **now fixed**. Deadlines run on mocked `setTimeout` and are ticked only after the work under test has started (for example, the POST is in flight). The `setTimeout(0)` barriers became explicit deferreds.
- `app-metadata-node` DNS timeout (a real 20 ms timer, deterministic outcome).
- `search-runtime` and `scaling-audit` alarm checks of the form
  `getAlarm() < Date.now()+N`. These are monotonic, so they cannot flake.
- `message-postbacks`: **now fixed**. `runtime/message-postbacks.mjs` reads an injected `config.FORM_POSTBACK_CLOCK` port, which defaults to `Date.now`. The tests pin it 30 s before UTC midnight and probe the minute/day rollover explicitly.

### Snapshot and implementation-detail tests (retained, documented)

These remain because each one also checks a behavior. Each is a candidate to
move to public status APIs:

- Raw storage keys: `lifecycle/state-v1` (account-lifecycle), `storage-write/v1`
  (storage-write-budget), `population/*`, `billing/grace/*`, `catalog/*`,
  `automation/*`, `mcp/v1/token/*`, `link-replay/*` row prefixes.
- Raw SQL: `search_revisions` and `inbox_catalog` in search, search-runtime,
  message-views and tags.
- Monkeypatching with `prototype.call` or replaced methods: work-spend-audit
  103–131, storage 26/42, storage-no-list-audit, billing-registry
  (`clientOverride`, `catalogCache`), billing 107 (`fetchState`). The new
  engine-level billing test covers overlapping reconciles without patching.
- Document and config snapshots: contact-delivery 45 and contact-delivery-spec
  41 regex the spec markdown. cloudflare-email 147 snapshots wrangler config.
  storage 33 reads the JSON schema. These are deliberate contract checks.
- contact-preview pins attribute order in meta-tag regexes. Its tests also share
  one `test.before` world and depend on running in order.

### Redundancy

- Removed: semantic-global-budget's lifetime-cap test duplicated
  semantic-spend-audit line for line. The surviving test now uses
  environment-shaped string limits.
- Retained after review (they overlap, but each has distinct assertions or a
  different layer):
  - contact-delivery-spec vectors, which run an independent `node:crypto`
    verifier, against contact-delivery.
  - app-notifications 39/44 against the audit's 103/117.
  - app-metadata-audit 9/11/16 against app-metadata.
  - browser-automation-audit 8/12 against the runtime tests.
  - storage-write-integration 30/58 (physical-only versus combined meters).
  - message-postbacks 42/45 against the HTTP audit 62/76 (engine versus route).
  - conversations-portable against conversations-http (two independent hosts).
- callable-commands-audit line 7: **fixed**. A mutable caller is now asserted to
  be refused with `invalid_context` and no dispatch. A frozen caller must
  dispatch exactly once with its original token. No portal product bug was found.

## Engine-level tests added

All are seeded through `tests/helpers/chaos.mjs`. Rerun a failure with
`CHAOS_SEED=<seed>`. Every seeded test logs its base seed as a diagnostic.
Operations run as ngin Actions through `tests/helpers/engine.mjs`, which wraps
injected resources as singleton Providers. `tests/helpers/messaging-fixture.mjs`
holds the shared delivery fixture.

- `engine-links.test.mjs`:
  - A raw-query parser fuzz checked differentially against WHATWG
    `URLSearchParams`.
  - A strict-JSON fuzz for both parsers, checked differentially against
    `JSON.parse`, plus depth bombs.
  - Size and encoding bounds.
  - Audience validity boundaries composed with the replay record at every edge
    instant.
  - A replay storm: 50 copies of one response, an exact principal cap, an exact
    parent cap with 500 principals, and purge batches at expiry.
  - Lost commit acknowledgements.
- `engine-delivery.test.mjs`:
  - Inclusive operation-age edges.
  - Receipt retention outlives admissibility.
  - Exact grant, byte and account quotas.
  - 20 deliveries contending for 7 slots under seeded interleavings.
  - Concurrent duplicate operation IDs and re-signed retries.
  - Intake revisions racing deliveries.
  - Intake or key changes between prepare and commit.
  - Per-author UTC-day quotas with a backward clock jump.
  - Bounded state for 120 deliveries.
- `engine-tags.test.mjs`:
  - Promotion idempotence.
  - Owner overrides and quarantine release.
  - Suppression before promotion.
  - No rule cascades.
  - Exact tag limits and automated overflow.
  - A seeded owner/automation interleaving model with bounded history.
- `engine-billing.test.mjs`:
  - A webhook replay storm through the account gate.
  - Body-hash conflicts.
  - An out-of-order, delayed and duplicated timeline that follows provider
    state.
  - Monotonic paid protection.
  - Exact event-history capacity and expiry.
  - A provider outage mid-storm.
- `engine-storage-chaos.test.mjs`:
  - `AccountController` receive under blob put/delete faults, metadata row write
    faults and lost commit acknowledgements. It checks byte-exact content,
    conserved accounting and no untracked blobs.
  - Conversation inbox history under the same faults.
  - A lost blob after commit.
  - Exact storage quota, pending-upload cap and TTL boundaries.
- `engine-search.test.mjs`:
  - Seeded create/update/delete/quarantine with partial drains and stale
    redeliveries, on both the memory and SQLite indexes. It checks for no leaks
    before drain and for index-level consistency after deletes.
  - Outbox coalescing and queue bounds.
- `engine-lifecycle.test.mjs`:
  - Seeded clock jumps forward and backward never shortcut inactivity, warning
    or suspension periods, and a clock behind recorded time fails closed.
  - Sweeps overlapping reactivation under seeded interleavings, covering both
    outcomes.
- `engine-item-index.test.mjs`:
  - The incoming catalog equals a model of its members after seeded
    upserts, moves and removals, with paging that has no gaps or repeats.
  - Stale and forged cursors are refused.

## Product bugs found

1. **Conversation inbox retries conflicted after a failed cleanup**
   (`packages/conversations/runtime.mjs`).
   - Cause: inbox messages use a deterministic reservation id. If an attempt
     failed and the blob delete in its release also failed, the reservation
     survived. Every retry of that event then got `409 conflict: Upload
     reservation already exists` until the 20-minute TTL cleanup ran.
   - Fix: under the account gate, with no receipt recorded, the inbox now
     releases any stale reservation for that id before reserving.
   - Evidence: the conversation chaos test fails without the fix on seeds 2, 7
     and 13. It passes with the fix on 24 seeds.

No other product defects were found. The other new invariants held: delivery
quotas and receipts, tag promotion, billing ordering, search consistency,
lifecycle timelines and the item catalog.
