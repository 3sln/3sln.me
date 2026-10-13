# Shared activity and storage-write admission

An account's stored-byte quota does not control request fees: replacing a one-byte object thousands of times still makes thousands of writes. One durable activity meter now admits covered logical mutation attempts and each application-controlled bucket `put` attempt immediately before I/O, including failures, replacements, message bodies and large mutation outcomes. Both use the same account counters and service ledger in Node and Workers. A logical attempt costs one unit and each actual put attempt costs another: a simple hosted upload normally costs two units, and an operation storing multiple objects costs more. Completed idempotent replay adds no physical-write unit; any logical replay admission still counts. Cold archives use the reserved pool.

| Default | Limit |
| --- | --- |
| One app or stable contact/conversation writer | 120 activity units in a rolling 60 seconds |
| Account, across all writers and resources | 240 activity units in a rolling 60 seconds |
| Free foreground activity | 500 per rolling hour; 1,000 per rolling day |
| Plus and Pro foreground activity | 2,000 per rolling hour; 10,000 per rolling day |
| Whole-service admitted activity units | 10,000,000 per UTC month |
| Service allocation | 9,000,000 foreground activity units; 1,000,000 reserved for archives |
| Account archive reserve | 16 attempts per UTC month |

These are operator settings for one combined allowance, separate from storage bytes and app permissions. Paid entitlement comes from durable billing state; renewal, changing devices, adding resources, changing keys, changing versions or minting more upload URLs does not reset a writer's account allowance. Writer attribution uses stable application IDs and parent contact/conversation identities, not short-lived bearer strings. Active writer histories are bounded. The API exposes rolling-day and rolling-hour usage alongside byte usage; exhausted attempts return a safe error and retry timing. Clients must not automatically retry ambiguous writes.

Account hour/day history is coalesced into at most 1,441 minute buckets. Buckets expire conservatively after the minute ends plus the window, so recovery can take up to one extra minute; returned retry timing includes this margin. Minute bursts retain exact timestamps. Hour/day foreground history survives month changes, restart and plan changes. Migration preserves existing service credits and monthly accounting, and carries recent minute events into rolling history; older writes cannot be reconstructed from the previous monthly aggregate.

These limits replace both active account monthly work and physical-write quotas. The shared monthly service budget can still stop new activity until the UTC month boundary; it remains distinct from the rolling account allowance. The old standalone work-budget module and records are retained for historical compatibility and audit, but the active account controller does not enforce their monthly quotas or import their service credits.

## Enforcement boundary

The account injects guarded bucket ports before giving them to quota, messaging, storage or archive logic. Ports expose only `get`, `put` and `delete`, with native receiver binding. Private admission context is stripped before provider calls. Listing, copying and multipart methods are not exposed as an unmetered escape hatch; adding them requires explicit Class A accounting. Multipart upload creation, parts and completion would each need admission. Object storage's public contract still has no listing operation.

The meter debits logical admission before the covered operation and physical admission before the bucket call. It never refunds provider errors or uncertain outcomes. A completed idempotent replay makes no new bucket call and consumes no additional physical-write unit. Journal reservation and original grants are still required: cost admission neither authorizes a write nor makes remote I/O atomic. Proxy upload URLs use the same guarded account dispatcher. Native write URLs remain unavailable unless a backend can enforce one-use/replay and the same cost controls; currently native signing is read-only. External S3/WebDAV connections remain read-only at the hosted dispatcher, and managed Drive writes consume combined logical-activity admission. The shared meter bounds this application's covered mutations and bucket puts, not every possible external provider operation.

Owner and global state use durable SQLite transactions. Shared allocations are prepaid in batches of sixteen, routed by immutable account hash to sixteen partitions; most puts consume a local credit without a shared request. Both service pools use one authority record per month/partition with atomic combined and per-pool counts. Each total partition depends only on the service ceiling; its maintenance allocation is carved out of it. The authority pins its policy tuple on first use and refuses changes within that month, so changing the maintenance percentage cannot create a second allowance. Capacity can be stranded by shard imbalance, unused prepaid credits or uncertain allocation responses; this conservatism lowers availability rather than increasing spend.

Only the internal archive port can spend maintenance credit. Journal/message/object work cannot claim that reserve. Cold archive failures retain authoritative hot data; existing retry/backoff ownership remains intact. A full service archive reserve can delay shelving. Meter state and prepaid allocations must survive restart and backup/restore; resetting counters or changing layout is not a supported replenishment mechanism. The flags `STORAGE_WRITE_ENABLED` and `WORK_LIMITS_ENABLED` independently select physical and logical admission into the same meter; enabling either requires a valid authority and fails closed without one. Production Worker and Node compositions default to enabled. Operator changes to the shared allocation policy should take effect at a UTC month boundary.

If retained-upload or garbage cleanup is paused, foreground bucket writes fail closed before admission. This prevents replacement churn from accumulating abandoned physical objects behind a logical byte quota. Reads, deletion and the bounded archive reserve remain available while cleanup is repaired.

## Message ingress

Contact endpoint multipart POST, contact bearer POST and public conversation delivery use the normal shared HTTP message abuse policy before accepting bodies or dispatching to account storage. After authentication, recipient-side contact receive and conversation inbox materialization use the same account activity meter and guarded blob port as uploads. Changing sender IPs, endpoint URLs or short-lived tokens cannot reset the recipient allowance; stable parent contact grants and conversation identities attribute both logical and physical units. Receipt/idempotency checks precede additional object writes.

Rate denials expose `Retry-After` to cross-origin clients. Account timing reflects the limiting rolling window; HTTP ingress uses a conservative upper bound from the denied existing policy window. Conversation delivery can be asynchronous: acceptance into a delivery queue does not promise every recipient has stored the message, and delivery status records recipient failures.

## Cost interpretation

Cloudflare R2 Standard currently includes one million Class A operations per month, then charges $4.50 per million, rounded up to billing units. `PutObject` is Class A; delete operations are free. The 10,000,000-unit application cap allows paid usage beyond the free allowance. Since covered logical activity also consumes units, the ceiling on physical put attempts is at most that total, less other admitted activity. It is not a promise of a zero invoice: free allowances may be shared with other workloads, provider-internal retries are outside this application's meter, and bytes, reads, Worker/SQLite use, search and external providers have separate costs and controls. [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

This complements the existing signup, ingress, storage quota, semantic-spend and bounded-maintenance controls. It does not replace them. Alerts and reconciliation against actual Cloudflare usage remain operational release work.

Design/cost-policy reviewer: ___ Date: ___ Outcome: ___. Independent review: [storage write budget review](../release/storage-write-budget-review.md). Implementation evidence is recorded in DEVLOG.md.
