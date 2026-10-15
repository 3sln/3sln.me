# Boot token and host administration: independent review

Date: 2026-10-14. One independent agent reviewer with a privileged-access security lens audited the [design](../architecture/boot-and-admin.md) and the local backend source. This is agent evidence, not human approval. No deployment, secret or production identity was involved. Human reviewer: __________ Date: __________ Outcome: __________.

## Scope

- **Source:** [boot.mjs](../../packages/identity/boot.mjs), [roles.mjs](../../packages/identity/roles.mjs), [admin-store.mjs](../../packages/identity/admin-store.mjs), [admin.mjs](../../packages/identity/admin.mjs), [admin-http.mjs](../../packages/runtime/admin-http.mjs) (unmounted) and [boot-token CLI](../../scripts/boot-token.mjs).
- **Targeted edits:** service step-up and the runtime reservation hook; onboarding `runtimeName`; permanent `boot` reservation.
- **Lens:** token theft and replay; the deploy-race window; privilege escalation; confused deputy between boot and administrator; audit tampering; social engineering of restore.

The reviewer edited no repository files. Its repro scripts used a copy of the test harness.

## Findings and resolution

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | High (confirmed) | Any administrator could mint claims for static reserved names (`ray`, `security`, …) carrying internal roles and the `system` badge. That gives a crony internal capabilities, staff impersonation and a permanent name binding. | **Fixed.** Static-name claims are boot-only (`static_name_boot_only`). Administrators may add an internal role only if boot marked it `delegable` (`role_boot_only`). Internal badges are boot-only; the new `delegable` badge class is internal-only but administrators may assign it (`badge_boot_only`). |
| F2 | Medium (confirmed) | An administrator could re-derive claim links minted by boot or by another administrator and claim the account first. | **Fixed.** Only boot or the administrator who minted a claim can retrieve its link (`claim_minter_only`). |
| F3 | Low/Medium (confirmed via injected interleaving) | Suspend, reactivate and set-badges did not include the target's role or claim records in `expect`. Boot granting `admin` mid-decision still let an administrator suspend the new administrator. | **Fixed.** `principalFor` returns the target's `expect` (principal and claim revisions). Cross-store edits commit the hold write, the target revisions and the intent entry together. |
| F4 | Low (confirmed) | Overview and principal listing were neither rate-limited nor audited, contrary to the design. | **Fixed.** Both commit a read-rate window and an audit entry. |
| F5 | Low (confirmed) | `verifyAudit` stopped at a fixed 10,000 entries, so honest logs would be reported invalid. Each read re-walked the whole chain. An entry containing `undefined` would hash differently from its stored form. | **Fixed.** Ranged verification (a page is checked against the previous entry's hash), full verification on request, and JSON normalization before hashing. |
| F6 | Low (confirmed) | The store allowed a reserved boot token to be re-reserved with a new binding; only the service's `expect` prevented it. | **Fixed.** The store now permits only `absent → reserved → consumed`. |
| F7 | Low (reasoned) | Some writes had no audit entry: the suspend hold and its rollback, the reactivate hold clear, the claim `issued` state change, and boot step-up/logout. | **Fixed.** Hold changes share a commit with intent/outcome entries. `claim.issued`, `boot.step-up` and `boot.logout` are audited. Unauthenticated login-challenge housekeeping stays unaudited (documented). |
| F8 | Info | Several smaller points (listed below). | Documented as design limits and open questions. |

F8 details:

- Administrators can manage `bs1` system accounts that do not hold `admin`.
- A revoke could race a claimant's setup. **Fixed:** a revoked claim never counts as internal provenance.
- Boot password guessing is limited per IP only.
- `boot/status` is public.
- Boot cannot end its own access early.
- Restore does not undo administrators created by a compromised boot.
- Claims minted by boot outlive boot's expiry.

Regression tests for F1–F6 are in [boot-admin.test.mjs](../../tests/boot-admin.test.mjs) ("review regressions"). They run on both the Node SQLite and the Worker-style RPC adapters.

## Confirmed sound by the reviewer

- **Token verification:** bounded syntax, constant-time digest comparison (always two 64-character strings), exact claims, then the 30-minute window with 2 minutes of skew. Every failure gives the same error.
- **Single use:** the first start wins; concurrent completes produce one boot; a consumed token cannot be deleted or reused; a stale digest is refused. Checked on both adapters.
- **CLI:** writes with `O_EXCL|O_NOFOLLOW` and mode 0600, and prints only the digest.
- **Boot sessions:** restore bumps the generation, which invalidates old sessions. Sessions are capped at the access expiry. Login uses a dummy hash.
- **Separation:** an isolated `__Host-` HttpOnly SameSite=Strict boot cookie, plus exact Origin, CSRF and the explicit actor header, with no fallback between credentials.
- **Step-up:** administrator passkey step-up is bound to the session.
- **Role and catalog rules:** assignment and badge rules forbid self-changes, touching administrators and granting `admin`. Catalog rules forbid administrator reclassification.
- **Fail-closed reads:** effective authority is recomputed at read time. A corrupt catalog gives 503.
- **Reserved names:** the reservation hook fails closed; `boot` is excluded everywhere.
- **Claim admission:** `runtimeName` admits only the exact claim digest.
- **No leakage:** no secrets in lookup, overview, audit or route responses.

## Evidence

- `node --test tests/boot-admin.test.mjs`: **20/20** after the fixes.
- Identity-adjacent suites (bootstrap, onboarding audit, badge policy, namespace, identity, setup HTTP, account sessions, developer contact): **96/96**.
- Full `npm test` after the initial implementation: **1000/1000**. The post-fix rerun showed 996 pass and 36 fail. Every failure is in concurrently changing SDK flows, authorization-entry and islands tests (owned by other agents), and none of those files imports the modules changed here.
- None of this is browser, deployed-provider or production evidence. The routes are not mounted.

## Follow-ups: claim-name release and lifecycle freeze (2026-10-14)

Scope: release of expired, unused `preissued` claim reservations (`identity-shards` `onboardingSweep`, run by the identity storage alarm on Node and Worker), and the administrator-suspension lifecycle freeze (`AccountLifecycle` `adminHold` port, `planAccountLifecycle` `adminHold`, `AdminService.lifecycleHold`, `lastHold`). Both follow provisional coordinator decisions. An independent automated reviewer (race safety and namespace invariants) reviewed them on 2026-10-14. No human sign-off.

| ID | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| R1 | Low (confirmed) | `preissued` rows written before the expiry index existed are never swept. | **Accepted limitation**, documented in boot-and-admin.md. The fresh-layout development data has no backfill. A namespace backfill is needed before relying on release for older data. |
| R2 | Low (reasoned) | A sweep that keeps throwing (for example an unreadable `HOST_NAME_POLICY`) could exhaust Durable Object alarm retries and drop the alarm. | **Fixed.** `IdentityRepository.alarm` catches the failure, releases nothing, and re-arms an hourly retry. Tested. |
| R3 | Low (reasoned) | If `getAlarm` returned the running alarm's time, the "only move earlier" check would never re-arm the next due time. | **Fixed.** The sweep re-arms when the existing alarm is at or before `now`. Tested. |
| R4 | Low (reasoned) | A step that read "not held" can commit one transition, or one notice, just after an admin suspends. The two stores cannot share a transaction. | **Accepted, documented.** The next step freezes. Reactivation resumes as `suspended` with a fresh episode, never toward deletion. |
| R5a | Low | A resumed account that was never established got the 3-day unused window. | **Fixed.** A resumed account is marked established, so it gets the long inactivity window. |
| R5b | Low | `adminHold`, `adminResumedAt` and `adminReleaseSeen` were not validated. | **Fixed.** Corrupt values fail closed (`lifecycle_unavailable`). Tested. |
| R5c | Low | Release detection compared admin-clock `releasedAt` with the account clock. | **Fixed.** It compares only with the last seen `releasedAt`. Tested with a lagging admin clock. |
| R5d | Low | Owner `reactivate()` ignored an observed admin hold. | **Fixed.** Owner reactivation refuses (`account_suspended`) while an admin hold is observed. Tested. |
| R5e | Low | `planAccountLifecycle` treats an omitted `adminHold` as not held. | **Accepted.** The helper is unwired. Callers must pass the port value when it is integrated. |

The reviewer confirmed these as sound:

- The index, the namespace row and the alarm share one storage (the namespace bucket Durable Object, or the Node identities database). Release and `onboardingClaim` therefore serialize, and exactly one wins. A randomized race test checks both orders.
- The release predicate excludes assigned, allocated, paid, system, claiming and consumed rows, configured policy names and `boot`.
- Stale index entries cannot release a newer reservation.
- An issue or reserve that arrives late cannot keep a released name.
- The admin-store state (`liveClaim`, `unreserve`, `revokeClaim`) stays consistent.
- The resume transition passes `validate()`.
- Paid protection is still evaluated first.

`AccountLifecycle` is not wired into any scheduler, so the freeze has no production effect until the lifecycle executor is integrated.
