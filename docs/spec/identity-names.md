# Permanent names for UUID identities

Status: user-directed policy and implementation candidate, 2026-10-12. Human reviewer: ___ Date: ___ Outcome: ___. The latest user decisions supersede the earlier chosen-base numeric-suffix design. The identity is a stable **UUIDv4**. Free names have the reserved form **`n.<Crockford Base32 number>`**, and customers with any verified paid subscription history may claim one permanent short alias. Names never recycle. See [UUID recovery and separate certificates](recovery-identity.md), [decision ledger](../../DEVLOG.md) and [production gates](security.md).

## Canonical names and lookup

Free signup has no name field. The provider allocates a numeric identifier, encodes it with lowercase Crockford Base32, and prefixes `n.`; for example `n.2a@space.example`. The example is illustrative, not an availability claim. The complete provider-returned name is shown during setup and in account settings. The UUID, canonical free name and assigned keys remain unchanged when a paid alias is added.

The public parser in `packages/identity/handles.mjs` defines canonical encoding and accepted lookup variants. The allocator range is 1 through 9,999,999,999,999 inclusive; zero is invalid. Canonical free names contain up to nine characters after `n.`, using `0123456789abcdefghjkmnpqrstvwxyz`, with no leading zeros. Lookup is case-insensitive and accepts Crockford `O` as zero and `I`/`L` as one within the numeric code, normalizing supported leading-zero variants. The same substitutions do not apply to paid alias text. A signed name certificate always contains the canonical name, so changing signed spelling invalidates its proof.

Paid short aliases are 3–32 lowercase ASCII letters/digits/underscores/hyphens, beginning with a letter or digit: `[a-z0-9][a-z0-9_-]{2,31}`. A leading digit is permitted. Dots are excluded, reserving the whole `n.` namespace for allocated identifiers. Lookup folds case consistently. Do not strip accents, remove punctuation, guess a name or silently truncate an input. Display literal assigned handles and hosts without translating them.

Names are routing aliases of the immutable UUID. A separate downloadable public certificate binds issuer, UUID, exact name, permanent assignment identifier and issuance time. The encrypted identity recovery file contains no handle or name certificate. Name changes or additional aliases cannot require users to replace a valid UUID recovery file.

## Allocation and permanent claims

Allocate from durable provider-wide shared state rather than per-name counters. The sharded allocator uses 64 fixed globally disjoint lanes; each lane atomically advances its counter and computes its numeric identifier as `sequence * 64 + lane`. Choose the lane server-side, independently of user-controlled base names, since signup has no base name. Lane count, routing and sequence range are persistent protocol state; never change the modulus or restart counters in place. Burned or skipped numbers are acceptable. Exhaustion, overflow and missing allocation state fail closed, never wrap or reuse.

An authoritative permanent claim ledger binds each exact canonical or paid name to its original UUID and assignment identifier independently of live account lookup indexes. Cleanup of stale lookup entries, account deletion, inactivity, billing lapse and failed login must not remove, release or transfer claims. An absent live lookup is not evidence of availability. Reserve a permanent claim before reporting issuance; ambiguous abandoned signup claims may remain burned forever.

Retries can complete the same in-flight assignment for the same UUID idempotently. Ordinary signup cannot reuse a claimed name to recreate a deleted account. A historical signature is not an override for a permanent claim or current account status. Permanent name retention is separate from retaining the recovery/grant state required for account restoration.

Legacy identities keep their existing UUIDs/names. Backfill permanent claims before enabling the new namespace over an existing population. Opportunistic grandfathering of an encountered name does not prove the migration is complete; verified backfill and operating gates remain production requirements. Earlier development-only base-name suffix formats require an explicit migration decision and are not silently reinterpreted as current Crockford names.

## Paid alias eligibility and lifetime

One short alias may be claimed by an account that **has ever been a verified paid subscriber**. Current subscription cancellation or lapse does not remove eligibility or an existing claim. Store a durable paid-history entitlement from trusted billing evidence; do not rely only on current-plan status. A checkout redirect, browser plan value, entered API key or unverified billing event does not establish that history. New paid evidence must be verified and bound to the UUID by the server's billing authority.

Claiming requires an authenticated account, recent authentication and existing CSRF/origin checks. Enforce one permanent alias per UUID plus atomic exact-name uniqueness. A committed alias persists forever, including after lapse, inactivity or deletion. It cannot be changed, transferred, released or reclaimed for a different subject. A returning eligible user without a prior successful alias claim may choose one after cancellation. Availability checks are advisory until the claim commits.

A definite failure to claim an unavailable name must not consume the owner's one successful alias entitlement. A temporary per-owner operation anchor can be cleared only after proving its exact claim failed; the permanent name claim itself cannot be cleared. Ambiguous interrupted claims require reconciliation before permitting another name. Resolve simultaneous distinct requests from one account, two-account collisions and crash/retry paths without granting multiple aliases or reassigning one.

Resolve a short alias to its original UUID and then check live account status and normal authorization. Alias possession grants no additional permission. Keep the canonical free handle unchanged in contact routing and recovery account state; adding a paid alias does not invalidate existing URLs or alter identity keys. Return historical name certificates as public evidence only, never as a substitute for current authorization.

## Rollback and deletion

Permanent claim history, paid-history entitlement and allocator high-water state must not roll back under routine account backup restoration. Restoring an old snapshot cannot make a previously claimed paid name or allocated number available again. Disaster recovery must preserve every issued claim and each lane's maximum allocation, or establish a verified safe continuation and complete claim history before writes resume. Counter high-water recovery alone is insufficient for paid names.

If the provider cannot establish this continuity, disable new allocations/alias claims until a trusted complete history is reconciled. Do not silently reset a namespace, alter shard layouts, treat missing ledger state as a fresh installation or enable a new scheme on existing data. Operators need separately verified migration/backup procedures; a successful test or configured database does not prove nonrollback externally.

Deleting an account may remove its live routing and user data under the explicit retention policy, but keeps its names unavailable forever. Neither a public name certificate nor private identity keys alone may reconstruct missing recovery authority or revoked grant state. Current recovery supports retained accounts; missing-account restoration remains a separately gated protocol.

## User experience and evidence

Signup explains that a free `n.` handle is assigned automatically and displays the exact returned handle during setup. Login accepts complete free or paid names using the shared normalization rules. Explain permanent one-alias commitment before a paid-history claim. The UI must not treat a requested name, payment return or optimistic API state as a committed claim. Recovery and public name certificates download as distinct artifacts.

Required tests include allocation concurrency and range exhaustion, lane disjointness, canonical Base32 and case/ambiguous-character lookup, never-reuse after deletion, preserved legacy claims, malformed numeric codes, namespace migration gates, ever-paid history after cancellation, unpaid denial, one-alias races, failed unavailable-name entitlement, permanent lapse/deletion behavior, separate public certificates, and identity/contact/recovery continuity after alias claim. Crash and restore tests must prove burned reservations do not reassign and histories cannot silently regress. Browser checks must cover signup without a name field, normalized login and literal assigned-name display. Record actual local/Worker/browser evidence and remaining operational limits in the ledger.
