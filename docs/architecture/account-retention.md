# Unpaid account contact and retention

User-directed policy, 2026-10-13. Reviewer ___ / Date ___ / Outcome ___. This document separates implemented account activation and conservative paid-history protection from the warning/suspension/deletion executor that still needs implementation.

New hosted accounts must establish a reachable channel before activation: a verified associated email or an encrypted push challenge acknowledged by the setup browser. An email supplied in a URL or invite is not proof by itself. Credential enrollment and recovery setup remain mandatory. Existing active accounts are grandfathered; losing a contact channel must not lock a user out of account recovery. Pending setup can be resumed using the enrolled credential without gaining an active session.

The onboarding explanation is: “For unpaid accounts, we might check in periodically to ask if you’re still using the account.” It must also explain repeated warning attempts, a grace period, suspension, and eventual deletion of hosted data. Connected external storage data is never deleted by this process. Access through the deleted provider identity does end. External bytes alone do not guarantee usability: Google Drive logical keys depend on host-held file mappings. Before deleting those mappings, independently restorable private provider-side manifests must be preserved and verified against the current owner and mapping revision, with an importer usable after fresh authentication. Until that exists, essential-map erasure must remain blocked; retaining a host archive temporarily is not a completed hosted-data purge. See [executor design](../release/account-lifecycle-executor-design.md).

## Eligibility and protection

Automatic inactivity removal applies only to identities with authoritative never-paid signup provenance. A confirmed paid-tier history permanently protects the account, even after downgrade; the marker is independent of claiming a paid handle and is preserved before any billing state overwrite. Unknown, legacy, restored, corrupt or wrong-environment provenance is retained for review. Current or provisional paid capacity and unresolved financial changes also prevent destructive transitions. Explicit owner-requested deletion and separately authorized over-quota offload policies are different operations.

Authenticated owner and authorized application resource use count as activity. Incoming unsolicited messages and maintenance jobs do not constitute owner confirmation. Every transition must compare fresh paid protection, activity epoch, lifecycle generation and notice evidence under the account-local gate. Identity-directory status alone cannot freeze already issued resource or contact grants.

## Phases

The executor must implement active → warning → suspended → deletion review/purge. Warning notices say “Action required: your account will be suspended in N days.” Suspended notices say “Action required: your account will be deleted in N days.” Deadlines are server-derived, visible in the portal, and never invented by a client.

Each phase requires at least three distinct, spaced contact attempts during its grace window and at least one provider acceptance in that phase. Transport retries of one attempt do not count as multiple attempts. Record attempt ID, lifecycle generation, channel revision, provider receipt and accepted-at time. Acceptance means the provider accepted the message, not that the person read it. All failed/unknown attempts, known bounces, suppression or missing verified channels hold destructive advancement. The first accepted notice starts the fixed grace deadline; changing transports or retrying does not shorten it.

Suspension retains hosted data, blocks normal account APIs, app/resource RPC, message ingress and mutations, and initiates reversible shelving. Restricted credential/recovery authentication, status and explicit reactivation remain available. Reactivation atomically cancels stale phase work before restoring access. Purge must never call external storage connector deletion APIs or follow arbitrary resource URLs. Only provider-owned object prefixes and indexes with exact ownership/version evidence may be removed; username claims remain reserved permanently.

No automatic purge is currently enabled. Existing account alarms only perform reversible cold metadata shelving. The new paid-history helper and email warning templates are not an executor and do not prove notices have been sent.

## R2 storage classes

R2 Infrequent Access has the same online access model as Standard; suspension is enforced by authorization, not by the storage tier. Storage is $0.01/GB-month versus $0.015 Standard. Infrequent Access has a 30-day minimum charge, $0.01/GB retrieval, higher operation prices, and no Standard free allowance. There is no minimum object size. [Storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/), [pricing](https://developers.cloudflare.com/r2/pricing/).

Existing objects can change class through S3 CopyObject with `x-amz-storage-class`; Workers uploads can specify `storageClass`. A broad bucket-age rule cannot safely express account suspension or paid exemptions. Use resumable owner-specific tiering with exact object generations and existing admission budgets. Freeze access immediately; tiering completion is separate. Estimate transition, minimum-duration and reactivation costs before moving data: many small objects or short suspension may cost more in Infrequent Access. Recheck lifecycle generation before each operation so stale suspended work cannot modify reactivated data. External providers are excluded.
