# BindleBox contacts and receive review (BB-B2)

Date: 2026-10-20.

**Scope.**
- Engine domains: `packages/bindlebox-engine/domains/{receive,receive-budget,contacts,intake,delegation}.mjs`.
- Stores: `packages/bindlebox-engine/store/{mailbox,edge-index}.mjs`.
- Tests: `tests/bindlebox/{receive-fixtures,receive,contacts,intake,delegation}.test.mjs`, which run on the seeded network simulator.

Design sources: [spec](../spec/bindlebox.md) §3.3–§3.4, §4, §6.7, §7.1, §7.4, §8 and §9, and [architecture](../architecture/messaging-app.md) §8, §11 and §12.1.

**Method.** One independent security-reviewer subagent reviewed the code read-only, using executable probes. The implementer fixed every confirmed finding and added a regression test for each one.

**This is agent review, not human sign-off.** Human sign-off: reviewer ___ / date ___ / outcome ___.

Nothing here is mounted, flag-enabled, production-verified or interop-verified:
- The operations are not yet in `MAILBOX_OPERATIONS`.
- No route exists.
- `BINDLEBOX_ENABLED` stays off.

## What was checked clean

- **IDKEYS-1 patterns are not repeated.**
  - The receipt signer is read once into a frozen snapshot, and its kid must equal the delegation's `jkt`.
  - The replay decision, the live link/block/revocation recheck, budgets, and the item, replay and receipt writes all happen in one transaction.
  - A receipt is released only after commit.
- **Crashes and duplicates.** Concurrent duplicates are admitted once. A crash during commit either admits or rolls back. A replay after a link or key revocation is refused.
- **Cheap refusals.** Forged authors trigger no status fetch.
- **Edge index.** Refusals are uniform and the index holds no secrets.
- **Errors.** Error bodies are fixed messages.
- **Filtering stays unobservable.** No admission response depends on classification or the allowlist (§6.7).

## Findings

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| BB2-R1 | medium-high | Large bodies were staged in user storage before the admission transaction. A refusal inside it (spent quota, rate limit, conflict, block, revocation, hot allowance) orphaned the object, without bound. | **Fixed.** Quotas and budgets run read-only before staging, and replays never stage. Staged keys are unique per attempt. A refused or replayed attempt deletes its staged copy, or queues it in `storage-gc/` for `intake.sweep`. |
| BB2-R2 | medium | The staging key was derived from the replay id, so a conflicting retry overwrote the admitted body. The receipt then no longer matched the stored bytes. | **Fixed.** The replay or conflict decision comes before staging, and keys are unique per attempt, so no attempt can overwrite another's body. |
| BB2-R3 | medium | Refusals before custody were uncounted. Each new verified principal cost owner-key and author crypto, a status fetch, a `links.evaluate` call and a permanent negative decision row. | **Fixed.** A bounded, in-memory limiter counts verified refusals: at most 20 per principal and 200 per issuer host per hour. It is checked against the claimed author before any crypto, so a principal cannot be throttled by someone merely claiming to be it. Negative decisions are capped at 256 per link, expired rows are pruned, and `receive.sweep` removes expired decisions. |
| BB2-R4 | low-medium | Intake dedup answered before provenance verification. It was keyed by `tx` alone and returned a stored disposition for different content under the same `jti`. | **Fixed.** Dedup runs after `verifyProvenance`, keyed by (consumer, tx) and (consumer, jti). It returns a stored disposition only when the digest and `jti` match; otherwise it is `operation_conflict`. |
| BB2-R5 | low-medium | The classifier occupant could supply its own calibration, with unchecked thresholds, and so enable auto-reject. | **Fixed.** Calibrations come only from the owner's provider (`providerLink.calibration`), for exactly the reported model version. They must satisfy `0 < low < high ≤ 1`. |
| BB2-R6 | low | A spoofed allowlisted email address could skip auto-reject. | **Fixed.** An address allowlist match counts only when DMARC passes. |
| BB2-R7 | low | Rejected-view erasure left user-storage bodies and `by-jkt/` index rows behind. | **Fixed.** Both are removed; user-storage deletion is queued and performed by the sweep, outside any transaction. |
| BB2-R8 | info | Concurrent drains could overspend the classifier allowance. | **Fixed.** Each call is reserved inside a transaction before it is made. |
| BB2-I1 | info | Positive audience decisions are not invalidated by an owner policy change (spec §4.2). | **Open.** No policy-change operation exists yet. It must clear `decision/{jti}/*` when it lands. |

## Residual and provisional items

These are recorded for the design owner. They are provisional and unsigned.

- **"Applied" under quarantine.** On learning a revocation, every not-yet-reviewed item from that `jkt` created at or after `revokedHour - 1 h` is quarantined. This is the receive side's reading of "not yet applied".
- **Known revocations for one-offs.** One-offs and plain messages are refused when a revocation is already known (persisted or cached). Otherwise they rely on certificate expiry, which §3.4 permits.
- **Native issuer-domain limit.** Public requests are limited to 100 per day per issuer host. §12.1 specifies domain limits only for email.
- **In-memory state.** The refusal limiter, the status cache and the key cache are per engine instance and in memory. Revocations are persisted.
- **Consumer origin is trusted.** `intake.deliver` trusts the consumer origin passed by the app shell after brokered-token authentication (B8).
- **Out of scope here.** Records and `BindleConversation` (B4), multicast `receive.batch` (P2) and activity submission (ACT) are not implemented. Notifications are recorded only as an item field.
