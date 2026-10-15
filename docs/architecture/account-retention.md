# Unpaid account contact and retention

User-directed policy, 2026-10-13. Reviewer ___ / Date ___ / Outcome ___. This document separates implemented account activation and conservative paid-history protection from the warning/suspension/deletion executor. That executor is now implemented locally behind `LIFECYCLE_ENABLED` (default `"false"`) and `LIFECYCLE_DRY_RUN` (default `"true"`). See [the runner review](../release/lifecycle-runner-review.md). Production enablement and delivery remain unverified.

New hosted accounts must establish a reachable channel before activation: a verified associated email or an encrypted push challenge acknowledged by the setup browser. An email supplied in a URL or invite is not proof by itself. Credential enrollment and recovery setup remain mandatory. Existing active accounts are grandfathered; losing a contact channel must not lock a user out of account recovery. Pending setup can be resumed using the enrolled credential without gaining an active session.

The onboarding explanation is: “For unpaid accounts, we might check in periodically to ask if you’re still using the account.” It must also explain repeated warning attempts, a grace period, suspension, and eventual deletion of hosted data. Connected external storage data is never deleted by this process. Access through the deleted provider identity does end. External bytes alone do not guarantee usability: Google Drive logical keys depend on host-held file mappings. Before deleting those mappings, independently restorable private provider-side manifests must be preserved and verified against the current owner and mapping revision, with an importer usable after fresh authentication. Until that exists, essential-map erasure must remain blocked; retaining a host archive temporarily is not a completed hosted-data purge. See [executor design](../release/account-lifecycle-executor-design.md).

## Eligibility and protection

Automatic inactivity removal applies only to identities with authoritative never-paid signup provenance. A confirmed paid-tier history permanently protects the account, even after downgrade; the marker is independent of claiming a paid handle and is preserved before any billing state overwrite. Unknown, legacy, restored, corrupt or wrong-environment provenance is retained for review. Current or provisional paid capacity and unresolved financial changes also prevent destructive transitions. Explicit owner-requested deletion and separately authorized over-quota offload policies are different operations.

Authenticated owner and authorized application resource use count as activity. Incoming unsolicited messages and maintenance jobs do not constitute owner confirmation. Every transition must compare fresh paid protection, activity epoch, lifecycle generation and notice evidence under the account-local gate. Identity-directory status alone cannot freeze already issued resource or contact grants.

## Phases

The executor must implement active → warning → suspended → deletion review/purge. Warning notices say “Action required: your account will be suspended in N days.” Suspended notices say “Action required: your account will be deleted in N days.” Deadlines are server-derived, visible in the portal, and never invented by a client.

Each phase requires at least three distinct, spaced contact attempts during its grace window and at least one provider acceptance in that phase. Transport retries of one attempt do not count as multiple attempts. Record attempt ID, lifecycle generation, channel revision, provider receipt and accepted-at time. Acceptance means the provider accepted the message, not that the person read it. All failed/unknown attempts, known bounces, suppression or missing verified channels hold destructive advancement. The first accepted notice starts the fixed grace deadline; changing transports or retrying does not shorten it.

Suspension retains hosted data, blocks normal account APIs, app/resource RPC, message ingress and mutations, and initiates reversible shelving. Restricted credential/recovery authentication, status and explicit reactivation remain available. Reactivation atomically cancels stale phase work before restoring access. Purge must never call external storage connector deletion APIs or follow arbitrary resource URLs. Only provider-owned object prefixes and indexes with exact ownership/version evidence may be removed; username claims remain reserved permanently.

Implementation status, 2026-10-14, local only:

- Account Durable Object alarms, a six-hourly cron sweep (`LifecycleScheduler`) and the Node scheduler drive `AccountLifecycle`.
- Notices go by push and by verified email from `accounts@`.
- Suspension returns 423 for account APIs and app RPC, except restricted status, reactivation, billing and unsubscribe.
- Reactivation requires a sign-in within the last 15 minutes.
- Purge additionally needs `LIFECYCLE_PURGE_ENABLED="true"` (default false). It needs a successful live Polar ever-paid lookup, and the monotonic `lifecycle/ever-paid-v1` marker must be absent. Any order, refund, chargeback or subscription for any product sets that marker, whether observed by webhook or by the lookup.
- Purge tombstones the identity, keeping the handle, and holds accounts with external connectors.

With the checked-in flags, nothing is sent, suspended or deleted. Dry run only arms the inactivity clock and logs planned actions.

## R2 storage classes

R2 Infrequent Access has the same online access model as Standard; suspension is enforced by authorization, not by the storage tier. The Workers binding has no copy or class-change call. The executor therefore rewrites identical bytes at the same key with `storageClass: 'InfrequentAccess'` under an etag condition. It does this only for owned objects of at least `LIFECYCLE_COLD_MIN_BYTES` (default 4 MiB). Below about 1.9 MB, Infrequent Access cannot repay one write and the source read within its 30-day minimum, and any later read adds retrieval cost. Smaller objects stay Standard, and the suspension fence blocks reads either way. Node reports tiering unsupported. Storage is $0.01/GB-month versus $0.015 Standard. Infrequent Access has a 30-day minimum charge, $0.01/GB retrieval, higher operation prices, and no Standard free allowance. There is no minimum object size. [Storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/), [pricing](https://developers.cloudflare.com/r2/pricing/).

Existing objects can change class through S3 CopyObject with `x-amz-storage-class`; Workers uploads can specify `storageClass`. A broad bucket-age rule cannot safely express account suspension or paid exemptions. Use resumable owner-specific tiering with exact object generations and existing admission budgets. Freeze access immediately; tiering completion is separate. Estimate transition, minimum-duration and reactivation costs before moving data: many small objects or short suspension may cost more in Infrequent Access. Recheck lifecycle generation before each operation so stale suspended work cannot modify reactivated data. External providers are excluded.
