# Storage write admission

An account's stored-byte quota does not control request fees: replacing a one-byte object thousands of times still makes thousands of writes. The existing monthly work allowance counts covered logical changes. A separate durable meter now admits each application-controlled bucket `put` attempt immediately before I/O, including failures, replacements, message bodies, large mutation outcomes and cold archives. Both blob and archive adapters use the same account meter in Node and Workers.

| Default | Limit |
| --- | --- |
| One app or stable contact/conversation writer | 5 attempts in a rolling 60 seconds |
| Account, across all writers and resources | 10 attempts in a rolling 60 seconds |
| Free / Plus / Pro foreground writes | 1,000 / 5,000 / 10,000 per UTC month |
| Whole-service admitted bucket attempts | 250,000 per UTC month |
| Service allocation | 225,000 foreground; 25,000 reserved for archives |
| Account archive reserve | 16 attempts per UTC month |

These are conservative initial operator settings, separate from work units, storage bytes and app permissions. Paid entitlement comes from durable billing state; renewal, changing devices, adding resources, changing keys, changing versions or minting more upload URLs does not reset a writer's account allowance. Writer attribution uses stable application IDs and parent contact/conversation identities, not short-lived bearer strings. Active writer histories are bounded. The API exposes monthly usage alongside byte usage; exhausted attempts return a safe error and retry timing. Clients must not automatically retry ambiguous writes.

## Enforcement boundary

The account injects guarded bucket ports before giving them to quota, messaging, storage or archive logic. Ports expose only `get`, `put` and `delete`, with native receiver binding. Private admission context is stripped before provider calls. Listing, copying and multipart methods are not exposed as an unmetered escape hatch; adding them requires explicit Class A accounting. Multipart upload creation, parts and completion would each need admission. Object storage's public contract still has no listing operation.

The meter debits before the bucket call and never refunds provider errors or uncertain outcomes. A completed idempotent replay makes no new bucket call and consumes no additional physical-write allowance. Journal reservation and original grants are still required: cost admission neither authorizes a write nor makes remote I/O atomic. Proxy upload URLs use the same guarded account dispatcher. Native write URLs remain unavailable unless a backend can enforce one-use/replay and the same cost controls; currently native signing is read-only. External S3/WebDAV connections remain read-only at the hosted dispatcher, and managed Drive writes retain the existing logical-work admission. This meter covers this application's bucket puts, not every possible external provider operation.

Owner and global state use durable SQLite transactions. Shared allocations are prepaid in batches of sixteen, routed by immutable account hash to sixteen partitions; most puts consume a local credit without a shared request. Both service pools use one authority record per month/partition with atomic combined and per-pool counts. Each total partition depends only on the service ceiling; its maintenance allocation is carved out of it. The authority pins its policy tuple on first use and refuses changes within that month, so changing the maintenance percentage cannot create a second allowance. Capacity can be stranded by shard imbalance, unused prepaid credits or uncertain allocation responses; this conservatism lowers availability rather than increasing spend.

Only the internal archive port can spend maintenance credit. Journal/message/object work cannot claim that reserve. Cold archive failures retain authoritative hot data; existing retry/backoff ownership remains intact. A full service archive reserve can delay shelving. Meter state and prepaid allocations must survive restart and backup/restore; resetting counters or changing layout is not a supported replenishment mechanism. `STORAGE_WRITE_ENABLED` is independent of `WORK_LIMITS_ENABLED`; an enabled meter with a missing authority fails closed. Production Worker and Node compositions default to enabled. Operator changes to policy should take effect at a UTC month boundary.

If retained-upload or garbage cleanup is paused, foreground bucket writes fail closed before admission. This prevents replacement churn from accumulating abandoned physical objects behind a logical byte quota. Reads, deletion and the bounded archive reserve remain available while cleanup is repaired.

## Cost interpretation

Cloudflare R2 Standard currently includes one million Class A operations per month, then charges $4.50 per million, rounded up to billing units. `PutObject` is Class A; delete operations are free. The 250,000-attempt application cap deliberately leaves room within that request allowance when it is otherwise unused. It is not a promise of a zero invoice: free allowances may be shared with other workloads, provider-internal retries are outside this application's meter, and bytes, reads, Worker/SQLite use, search and external providers have separate costs and controls. [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

This complements the existing logical work, signup, ingress, storage quota, semantic-spend and bounded-maintenance controls. It does not replace them. Alerts and reconciliation against actual Cloudflare usage remain operational release work.

Design/cost-policy reviewer: ___ Date: ___ Outcome: ___. Independent review: [storage write budget review](../release/storage-write-budget-review.md). Implementation evidence is recorded in DEVLOG.md.
