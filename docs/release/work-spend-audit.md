# Mutation admission and maintenance spend audit

Date: 2026-10-12. Reviewer: independent automated code review and fault injection. Human reviewer/date/outcome: **unsigned**. Production release remains disabled. This review supplements [semantic spend audit](semantic-spend-audit.md), [unit economics](../architecture/unit-economics.md) and [DEVLOG](../../DEVLOG.md); it does not certify a provider invoice ceiling.

## Admission controls reviewed

`AccountWorkBudget` limits covered mutations and ingest attempts per UTC month to 1,000/free, 5,000/Plus and 10,000/Pro. The plan comes from durable, owner-matched billing entitlement; expired paid entitlement falls back to free. The service allowance is 250,000 units/month in total, split exactly among sixteen fixed partitions. Owner hashing routes directly to a partition. Sixteen-unit prepaid leases keep the shared service counter off most operations; a one-unit fallback can use a partition's final remainder. Unused local leases expire when the owner's month changes; their service allocation is not refunded.

Owner debits happen before service allocation and before effects. An uncertain service response or crash may consume allowance without completing work; retrying does not refund it. The account transaction rejects another owner's ID before modifying counters. Independent concurrent-consumer testing confirms a last prepaid unit cannot be spent twice. A service cap of zero denies new work. These units count covered attempts, not SQL rows, bytes, requests, successful delivery or dollars.

The normal Worker and Node adapters supply durable work authorities. The portable controller permits explicitly disabled/no-authority test configurations; merely constructing a controller does not prove the deployed adapter has enforced admission. Changing shard layout or deleting durable counters is not a supported way to replenish capacity.

## Authorization and exhaustion boundaries

Owner HTTP mutation admission follows authenticated session and CSRF checks. Authenticated invalid mutation attempts can consume that same owner's allowance; this is conservative attempt accounting. Foreign-owner account admission and invalid CSRF fail before debit.

Contact delivery verifies the signed bearer and recorded grant, validates message fields/content, checks the shared parent allowance and account storage quota, and checks idempotency before admitting new work. Invalid signatures, wrong recipient/collection/type, exhausted grant/storage quota and replay of a completed idempotent delivery do not create a new debit or pending R2 upload reservation. Valid contact senders can consume the recipient's allowance within the grant the recipient issued. Contact GET/inspection/token minting does not spend mutation units; it still performs ordinary authentication/signing/metadata work.

GET/read/export, DELETE, contact revocation, logout and safety operations remain usable after admission exhaustion. Keeping them usable does not make their resource use free. Hosted object puts admit work after validating conditions, canonical base64, size/type and byte capacity, before reservation/upload effects. Failed authorization and malformed puts do not burn another owner's allowance. Hosted delete remains exempt and records durable cleanup ownership.

Beaming is a separate bounded subsystem: offers, accept/signal/ICE operations are not all covered by this general mutation counter. Paid beaming uses its own offer/byte allowance and bounded signaling state. A 250,000-unit service allowance must never be described as a cap on all beaming writes, all ingress, all reads, all identity operations or all provider activity.

## Read-only federation journal finding

The initial account-level federation adapter stopped journaling read results, but the outer `FederationController.dispatch` still created durable reserved/completed outcome records for reads, including large payloads that the metadata adapter could offload to blob storage. This could create retained records/copies for repeated GETs outside mutation admission. Independent regression coverage exercises `get`, `list`, `read`, `describe`, `capabilities` and `presign` and requires zero outcome journals. The coordinator owns the outer dispatch correction and final test result; durable mutation journals remain required to prevent repeating ambiguous writes.

## Maintenance fixes implemented during review

The initial maintenance scheduler retried failed upload cleanup, blob garbage collection, vector purge and extraction every minute. A new-work cap did not stop existing queued work from retrying. For scale, 1,000 continuously failing accounts could otherwise cause 43.2 million alarm invocations per 30 days; batches of 32 deletes could attempt 1.3824 billion deletes. This is a failure scenario, not observed provider usage.

Automatic maintenance now persists exponential backoff: delays begin at one minute, double, and cap at one hour. After eight recorded failures the subsystem pauses automatic provider work. Records and byte reservations are retained; a pause never claims that physical deletion succeeded. Pending successful batches do not erase the failure history of cleanup work still retained elsewhere in the queue. Queue cursors and bounded batch sizes are preserved.

| Durable marker | Scope and retained work |
| --- | --- |
| `storage/cleanup-retry` | Expired upload reservations; their blob references and reserved-byte/count records remain owned |
| `storage/garbage-retry` | Retired blob references in `blob-garbage/` |
| `search/purge-retry` | Revoked/deleted semantic vectors and `search-vector-purge` progress |
| `search/extraction-retry` | Lexical outbox work that cannot extract/index; accepted source events remain queued |
| `search/semantic-retry` | Provider failure during deferred semantic backfill; no automatic endless hourly enrichment retry |
| `maintenance/alarm-retry` | Unexpected failures in the remaining alarm workflow, including archive/provider exceptions |

Markers contain `failures`, `paused`, `retryAt`, `code` and `updatedAt`. `paused:true` means operator investigation and repair are required. After fixing the cause, an operator may clear the relevant retry marker and explicitly reschedule the retained work; a paused semantic backfill also needs its paused state reconciled. No public reset endpoint was added. The failure/health records are durable diagnostics, not a finished operational dashboard or deletion certificate. This manual repair path remains a production readiness gate.

The scheduler honors retry deadlines and ignores paused cleanup when deciding whether to wake after one minute. General maintenance may still perform a weekly metadata heartbeat; it does not retry a paused provider operation. Newly authorized foreground work, quota reservation release during a foreground attempt, and explicitly triggered operations are separate from the bounded automatic retry policy. A mutation cap plus backoff therefore reduces amplification without guaranteeing that all housekeeping work has a finite lifetime bill.

Node's timer adapter now conditionally claims and clears the matching persisted alarm before invoking its handler. Previously a fired alarm remained stored; the new “already scheduled earlier” check could treat that expired timestamp as a future scheduled alarm and suppress cleanup continuation. Conditional claiming avoids clearing a replacement alarm. Account activity writes now coalesce over fifteen minutes rather than one minute; reading/searching remains available.

## Cost-model implications

A normal work admission performs roughly three logical metadata reads (owner, counter, billing) and one counter write. A full sixteen-unit refill adds an owner lease write and a shared counter write, about 1.125 logical writes per admitted unit in a full-lease workload. At 250,000 units this is approximately 281,250 logical ledger writes, before failed admission, indexing, cleanup, identity and all other work. These are source-level logical operations, not measured Cloudflare billable rows; SQL indexes, hidden metadata storage and transactions can add amplification.

An always-visible idle beaming client polls every thirty seconds: 86,400 polls per 30-day month. Active transfers poll every five seconds (518,400/month if sustained), plus per-offer requests. Hidden/offline clients stop polling. The empty mailbox path includes identity lookup, account touch, mailbox and outbox calls; model actual RPC fan-out instead of assuming one DO call per poll. Fifteen-minute activity coalescing reduces continuously visible activity updates to roughly 2,880/month/account, with two metadata writes per update, while preserving the reads and ordinary request costs. This is still far above a 1,000-request “typical” scenario if a browser remains visible continuously.

Storage liabilities continue during pause: retained payloads, reservations, orphan references, SQL indexes/tombstones and remote vectors need capacity budgets and verified erasure. Read-only and denial traffic require independent edge protection and measured cost. Beaming's own allowances, fixed Workers fees, provider billing-unit rounding and operational support remain separate from mutation admission. Billing alerts are a monitoring aid, not proof of an enforced invoice ceiling.

## Evidence

Independent tests in `tests/work-spend-audit.test.mjs` cover foreign-owner isolation, concurrent last-unit spending, exact partition sums, consumed Node alarm state, read-only federation journaling, eight-failure cleanup pauses with retained ownership, scheduler behavior for paused work and fifteen-minute activity coalescing. `tests/work-budget.test.mjs` additionally exercises actual Node HTTP authentication/CSRF, invalid bearers, malformed delivery, exhaustion, restart, deletion/revocation/logout and hosted-object admission. Final combined results are recorded by the coordinator in DEVLOG. No network provider calls, production deployment, invoice reconciliation or operator recovery drill were performed by this audit.
