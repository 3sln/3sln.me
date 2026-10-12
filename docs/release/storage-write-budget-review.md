# Storage write budget review

Review date: 2026-10-12. Reviewer: independent code-review agent. Human reviewer/date/outcome: **pending**. Production release remains gated. This document records implementation evidence and remaining verification; it does not constitute release approval.

## Existing behavior and the requested change

The existing `AccountWorkBudget` meters covered logical mutations and ingest attempts. It already uses durable owner debits, a fixed 16-shard service allocation, nonrefundable prepaid leases and fail-closed handling of uncertain allocation. Source review and independent execution of `node --test tests/work-budget.test.mjs` passed **8/8** checks, covering concurrency, restart, exact partition totals, uncertain allocation, owner binding, billing entitlement and continued reads/deletion/revocation after exhaustion.

That work budget is not a count of physical bucket writes. Hosted object writes, message delivery and conversation inbox ingestion debit work, but archive writes and large stored RPC results can cause additional bucket puts. `offloadMetadata` also contains a bucket-write path, although no active composition caller was found during this review. Updating the same logical key can maintain constant storage usage while causing repeated physical writes. Quota on retained bytes cannot bound this request churn.

The requested control therefore belongs immediately before the platform bucket's `put` call, independently of logical keys, versions, payload identity, transaction IDs, access tokens and signed URLs. Every actual application-level put attempt must consume admission, including retries and upstream failures. A durable replay that returns a prior result without calling the bucket must not consume a second physical-write unit. Provider errors and uncertain outcomes must never refund admitted units.

## Agreed composition and limits

The coordinator approved a separate physical-write meter with these initial defaults:

| Scope | Limit |
| --- | --- |
| Service monthly total | 250,000 admitted put attempts |
| Foreground service pool | 225,000 per UTC month |
| Archive maintenance service pool | 25,000 per UTC month |
| Owner foreground monthly pool | Free 1,000; Plus 5,000; Pro 10,000 |
| Owner archive maintenance pool | 16 per UTC month |
| Owner rolling-minute burst | 10 |
| App rolling-minute burst | 5 |
| Retained app burst records | At most 64 per account |
| Service allocation | Fixed 16 shards; prepaid leases of up to 16 |

Each pool's shard capacities must sum exactly to its configured total; foreground and maintenance together must conserve the service ceiling. Archive-only admission preserves a small path to cold storage after foreground exhaustion. Journals, inbox ingestion and hosted object writes use foreground admission. Archives use maintenance admission. Both physical bucket ports require wrapping before injection into consumers.

The new guard is independent of `WORK_LIMITS_ENABLED`. Runtime composition enables it explicitly; an enabled guard without a valid durable authority must reject writes. Isolated controller fixtures with no configured guard remain unconfigured fixtures and must not be cited as evidence that the production composition is protected.

The public bucket port should expose only bound `get`, metered `put` and `delete` methods. A generic passthrough must not expose unmetered multipart mutation methods. Trusted internal write context may carry an authenticated app identity, but must be removed before forwarding options upstream. The default owner comes from the account's durable binding. There must be no user-controlled request field that supplies owner, pool, limit, bypass or app identity.

## Admission correctness requirements

App fairness uses the stable authenticated application identifier within the owner account. It must not reset on token refresh, new family, reconnect generation, new signed URL, resource creation or logical-key changes. Transport namespaces remain explicit: the current MCP adapter uses an `mcp:` prefix. Contact and conversation origins need their own stable trusted identities where attributed. Non-app system operations still consume the owner and service budgets.

Do not use mutable ambient `currentApp` state on an account controller: conversation fanout can run outside the account gate. Pass attribution explicitly through the trusted call path. Bound app-record cardinality, and prune only histories whose entire burst window has elapsed; disconnecting an app must not erase still-live counters. Any monthly app balances added later must outlive short-lived burst histories.

Persist nonrefundable local admission before remote service allocation or bucket I/O. Never perform remote bucket or service-authority operations inside a local metadata transaction. Unknown allocation outcomes strand capacity rather than risk overspending. Reject corrupt counters, future-month state and invalid configuration. A calendar transition while a lease is being allocated must not transfer old-month admission into a fresh month.

Fixed partitions and unused local leases can strand capacity; that is an intentional conservative tradeoff. Budget state and service ledgers must not be rolled backward during restore. Changing the layout, month key or shard count requires an explicit migration rather than creating a second independent allocation ceiling. Lowering a service cap must account for already-issued leases; it cannot retroactively withdraw admitted capacity.

Review identified that independently keyed foreground/maintenance counters could over-allocate if an operator changed their percentage mid-month. The implementation now uses one `storage-write-v1/<month>/<partition>` authority ledger. One atomic reservation checks and increments both the common total and the selected pool. The ledger pins the total, foreground and maintenance limits on its first allocation and rejects a changed tuple for that existing month/partition. Total shard capacity is calculated independently of the split; maintenance receives its share and foreground is the difference. Thus a percentage change cannot create another allocation pool or increase the combined total. Already prepaid leases remain funded; policy changes that require new allocations take effect on a fresh month ledger.

Bucket refusal must leave existing objects and metadata intact. A hosted write that has reached an uncertain effect must retain its journal semantics rather than silently retry. A failed archive must retain the hot account records; budget exhaustion may delay shelving but must never cause deletion before a successful verified snapshot. Reads, deletion, logout and permission revocation must remain available after foreground exhaustion.

## Meaning and verification boundaries

This is a ceiling on **covered application-level platform bucket put attempts**. It is not a universal cloud invoice ceiling. Provider-internal retries, reads, listing, retained storage, account/worker compute, metadata persistence, third-party connectors and unrelated operator credentials require separate accounting or operational controls. No current provider prices were used to infer a monetary ceiling in this review.

The application's current external S3/WebDAV write routes remain unavailable; native S3 write URLs remain disabled. Hosted writes and Google Drive writes already pass logical work admission. The physical platform bucket wrapper must not be described as a meter of every Google API request or a future external S3 upload path. Any future direct provider upload URL needs enforceable reservation before issuance, because its later requests bypass this bucket wrapper.

## Implementation review and current evidence

Source review confirms that `AccountController` wraps both blob and archive ports before creating their consumers. Both wrappers share one budget instance, use the persisted owner and select their pool in trusted composition. The wrapper exposes only `get`, `put` and `delete`, and strips `storageAdmission` before forwarding provider options. Object writes and stored RPC outcomes carry the authenticated client ID. Contact ingestion uses its stable parent grant ID rather than the rotating inbox JWT; conversation ingestion uses its trusted source and conversation identifier. These are capability/conversation fairness buckets, not claims of a globally authenticated sender identity. Node settings, both Wrangler configurations and the Worker harness enable the new guard independently of logical work admission.

Review identified and confirmed corrections for falsey stored records resetting counters, array-shaped app maps, invalid lease remainders, cached leases spending without a valid authority, overlapping lease credits, the 64-app bound and incorrect burst retry timing. The cached-lease path also now checks the clock after its transaction: crossing a UTC month boundary or rolling backward rejects admission even when no remote refill was needed.

Independent execution of `node --test tests/storage-write-budget.test.mjs tests/work-budget.test.mjs` passes **17/17**: nine new physical-write accounting tests and eight existing work-budget tests. The new checks cover durable owner/app burst limits, foreground versus archive reserve, exact pool partition sums, uncertain allocations, concurrency, SQLite restart, falsey/corrupt state, missing authority with cached credit, a calendar transition during cached admission and correct retry timing for the actual constraining window.

The shared-authority correction is also present in source: `FixedWindowGuard` lifetime accounting now initializes only an absent record, and rejects persisted `null` rather than resetting the service counter. The common storage ledger validates that each counter is within its pinned limit as well as checking the total equals both pools combined. A final five-test account/bucket rerun passed after adding the over-limit stored-pool regression. No remaining blocker was identified in this focused source review. The unused `offloadMetadata` helper must not later be connected to this same-metadata guard inside its current transaction adapter without refactoring, because its nested budget transaction would deadlock; no active composition uses it here.

Final independent focused execution passes **16/16**: eleven tests in `tests/storage-write-budget.test.mjs` plus five in `tests/storage-write-integration.test.mjs`. This is a separate, later run from the earlier 17-test combined work-budget result. The two added accounting cases cover a mid-month split change without a second pool, and exact total conservation for tiny/uneven caps and different percentages. Account/controller tests count actual calls to injected bucket implementations during same-key replacements, app/owner throttling, completed replay, failed writes, foreground exhaustion and archive-reserve use. They also verify that reads/deletion remain available and that the wrapper strips private admission options without exposing extra bucket methods.

Both ports are wrapped even when metering is explicitly disabled, so internal attribution never reaches the underlying provider. Enabled admission without a valid authority fails closed. The coordinator reports **3/3 actual Worker checks** passing, including signed upload throttling, replay and `Retry-After`; those Worker results were not rerun by this reviewer. The coordinator separately reports **24/24** combined new accounting, account/bucket and existing work-budget checks. Full-suite, browser, deployment dry-run and operational approval remain separate coordinator gates. No security attack probes were performed for this task; review used source inspection and functionality tests.

### Paused cleanup admission follow-up

The final constructor guard rejects foreground bucket puts with `storage_write_unavailable` (503) when either `storage/garbage-retry` or `storage/cleanup-retry` has `paused === true`. With physical metering enabled, this check runs before physical-budget admission and before upstream bucket I/O, so a refused write consumes no physical-write unit. Existing logical admission may already have occurred. Both foreground upload and stored-result consumers inherit the same wrapped port. Reads and deletion bypass put admission; archive puts bypass this cleanup-pause condition but still require their normal maintenance, owner/app burst and service admission. This preserves a bounded archival path rather than promising unlimited maintenance availability.

Independent execution of `node --test tests/storage-write-budget.test.mjs tests/storage-write-integration.test.mjs` after this change passed **17/17**: eleven budget tests and six integration tests. The new integration case sets the garbage-cleanup pause, rejects a replacement before another provider call, reads the prior object, deletes it, successfully archives and confirms that foreground usage did not increase. The second cleanup marker's equivalent admission branch was verified in source. No additional security probes were performed.

The guard is an admission check, not cancellation of a write already admitted when cleanup later pauses. It applies only while physical metering is enabled. Paused cleanup records deliberately retain outstanding ownership and stop automatic retries; restoring foreground writes requires operator repair of the cleanup condition and retry state. This change does not add automatic unpausing. No blocker was identified in this narrow safety and availability review; production operational approval remains pending.
