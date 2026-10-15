# Identity and access test audit

Status: test-quality work done locally. Nothing committed or deployed. No human review yet; the decisions below are provisional until a reviewer signs them off in DEVLOG.md.

Human reviewer: __________  Date: __________  Outcome: __________

Scope: packages/identity/*, packages/runtime/{accounts,account-*,identity-shards,admin-http,developer-contact,federation*}.mjs, packages/federation/*, packages/recovery/*, and boot/admin. The audit covers tests/*.test.mjs and tests/worker/* for that scope.

## Levels

- **Engine**: the real service (`IdentityService`, `ShardedIdentityRepository`, `AdminService`/`AdminStorage`, federation service/runtime, `AccountLifecycle`, recovery package), running directly or inside an ngin `Engine`, with in-memory or fake resources and a fake clock.
- **Adapter/HTTP**: the Node server, `fetch` routing, the Miniflare Worker harness, CLI scripts, or SDK-against-endpoint contracts.
- **UI**: DOM or browser runs.

## Audit table

| File | Level | Verdict | Action |
|---|---|---|---|
| identity.test.mjs | engine (real Argon2 and WebAuthn) | strong; the "ngin action dispatch" test duplicated the new engine fixture | removed that test; dispatch, owner query and unknown-action checks now live in identity-engine-edges |
| identity-namespace.test.mjs | engine + Node adapter | sound; seeds orphan/corrupt rows by storage key, which is deliberate fault set-up, not a snapshot | kept |
| identity-sharding.test.mjs | engine | sound; ad hoc fault injection | kept; seeded chaos now generalizes it |
| identity-sharding-audit.test.mjs | engine (SQLite) | sound | kept |
| identity-setup-channel.test.mjs | engine | sound | kept |
| identity-setup-http.test.mjs | adapter/HTTP | **nondeterministic**: slept 1.1 s of real time to wait out the per-IP signup cooldown | the second signup now comes from another network (`CF-Connecting-IP`); no sleep |
| device-login-cancellation.test.mjs | engine | strong | kept; seeded race added in identity-chaos |
| link-response.test.mjs | engine | sound | kept |
| engine.test.mjs | engine (core demo reference model, not identity) | out of scope | none |
| federation.test.mjs | engine | strong; parallel-refresh test redundant | removed; seeded chaos covers it |
| federation-dpop.test.mjs | engine | **flaky**: ±61 s issue-time edges read the real clock twice | pinned to one fixed time; inclusive ±60 s checks added |
| federation-runtime / -native / -object-urls / -mount / -http-admission | adapter/HTTP | sound | kept |
| federation-ui.test.mjs | UI (spawns the DOM run) | sound | kept |
| authorization-entries.test.mjs | adapter/HTTP | **nondeterministic**: `setTimeout(20)` waits for a held approval | waits on arrival/issued signals instead |
| authorization-entry-sdk-contract.test.mjs | adapter (SDK contract) | **nondeterministic**: `setTimeout(10)` waited for fire-and-forget revocation | awaits the observed `/oauth/revoke` response |
| client-metadata.test.mjs | engine + adapter | **nondeterministic**: 20 ms sleep in the fake fetch for request dedupe; the timeout case uses a real 30 ms timer with a wide bound | dedupe uses a gate; timeout case kept and noted |
| client-metadata-sdk-contract.test.mjs | adapter (SDK contract) | sound | kept |
| authorization-entry-helpers.mjs, client-metadata-helpers.mjs | helpers | used `Date.now()+offset` | frozen clock that moves only on `advance` |
| app-sessions.test.mjs | adapter/HTTP | sound | kept |
| embed-bindings.test.mjs | adapter/HTTP | avatar deadline waits a real 300 ms | kept, noted (the deadline is a real timer by design) |
| app-notifications*.test.mjs | engine + adapter | sound | kept |
| boot-admin.test.mjs | mostly engine (Node SQLite and Worker-style), plus HTTP, CLI and one source-grep test | the first boot-token test repeated window/skew/issuer checks now covered at ±1 ms | trimmed to the digest/constant-time test; the grep guard ("stepUp single caller") is kept as an architecture guard |
| onboarding.test.mjs | engine + CLI | waited on the real 500 ms badge-resolver timeout | `t.mock.timers` |
| onboarding-audit.test.mjs | engine | the same 500 ms wait, plus a wall-clock bound | mock timers |
| system-bootstrap.test.mjs, badge-policy.test.mjs | engine | sound | kept |
| bootstrap-safety, onboarding-http, badge-sprite-http, badge-node-injection | adapter/HTTP | sound | kept |
| account-hotpath, account-lifecycle, lifecycle-runner, lifecycle-paid-protection, developer-contact, identity-backup | engine | sound | kept |
| signup-admission, signup-capacity | engine + 2 Node HTTP | sound; pinned limit values are deliberate config guards | kept |
| paid-signup | engine + adapter | sound | kept |
| account-sessions, recovery-identity-runtime | adapter/HTTP | sound | kept |
| recovery-file.test.mjs | engine | two binding tests ran real Argon2 (about 2.3 s) and duplicated recovery-audit | switched to a fast counting KDF; the archived vector and recovery-audit keep real Argon2 (3.5 s → 1.1 s) |
| recovery-audit.test.mjs | engine (independent real-KDF audit) | intentional overlap | kept |
| worker/{accounts,lifecycle,security,federation,bootstrap,system-bootstrap,claim-release,onboarding} | adapter (Miniflare) | sound, no sleeps | kept |

Out of scope but noted: tests/worker/contact.test.mjs (sleeps 1.1 s for the signup cooldown) and tests/worker/conversations.test.mjs (polls with 20 ms sleeps) belong to messaging.

## Decisions (provisional)

1. **Engine first.** New edge and chaos tests drive the real services with injected in-memory resources and a fake clock. `tests/helpers/identity-engine.mjs` builds the app's own `createIdentityEngine` wiring and dispatches `IdentityAction`s. Argon2 and WebAuthn keep their real-implementation tests in identity.test.mjs; the engine fixture uses a fast deterministic hasher.
2. **Deterministic chaos.** `tests/helpers/chaos.mjs` provides seeded PRNG, `forEachSeed`, a scheduler that releases one parked resource call at a time, fault injection (`throw`, `after`/partial commit, `duplicate`, `timeout`) and a fake clock. Each failure names its seed; `CHAOS_SEED=<n>` replays it. All suites pass at seed bases 1, 100, 500, 9000 and 31337.
3. **Invariants, not snapshots.** Chaos assertions are at-most-one-winner, no lost committed write, no token valid after a confirmed revocation, handles never recycled, unique emails, bounded per-account state, and monotonic revisions and epochs. One storage-layout equality was relaxed to "a constant number of rows per account".
4. **No wall-clock waits** in this domain's tests, except the two real-timer deadline tests noted above.
5. **Coverage assertions in seeded tests must hold across seed bases.** The lifecycle chaos workload was retuned (12 seeds, more long clock jumps, faults only during scheduled work) after it failed at seed base 9000.

## New files

identity-engine-edges (10 tests), identity-chaos (7), federation-engine-edges, federation-chaos (8), admin-engine-edges (12), admin-chaos (11), accounts-engine-edges (9), accounts-chaos (5), recovery-edges (6), chaos-helper (3), claim-redemption-chaos (1), signup-capacity-receipts (3). Helpers: tests/helpers/{chaos,identity-engine}.mjs and tests/federation-engine-helpers.mjs.

## Product defects found and fixed (narrow)

| File | Defect | Found by |
|---|---|---|
| runtime/identity-shards.mjs | A redelivered `shardPrepare` (RPC retry after a lost response) reported a committed create or update as a conflict. Prepare now answers from its own token's outcome. | identity-chaos, at-least-once delivery |
| identity/service.mjs | Portable signup (a repository with no allocator) stored the raw handle, so `Alice` and `alice` could both register and a login could not find `Alice`. It now stores the canonical handle. | identity-engine-edges |
| identity/service.mjs | `revokeOtherSessions` counted expired sessions as revoked. | identity-engine-edges |
| federation/authorization-entries.mjs | A cancel committing during an in-flight decision gave one entry two outcomes (`access_denied` and a code). The decision now fails as expired; its code is never delivered. | federation-chaos, seed 7 |
| identity/admin-store.mjs | A caller clock 1 ms behind the window start reset the admin rate window, so skewed isolates could bypass the limit. | admin-chaos |
| identity/admin.mjs `mintClaim` | The outstanding-claim check and the commit expectation used different reads, so two concurrent mints could both succeed. | admin-chaos |
| identity/admin.mjs `unreserve` | A mint landing after the liveness check left a live claim with no reservation. The commit now also expects the claim-name pointer revision. | admin-chaos, seeds 22/25/43 |
| runtime/accounts.mjs `FixedWindowGuard` | A forward clock jump followed by a correction locked a window key for the whole jump. | accounts-chaos |

## Follow-up fixes

| File | Change | Test |
|---|---|---|
| identity/admin.mjs, identity/onboarding.mjs, apps/{node/server,worker/index}.mjs (wiring only) | Redemption of an administrator-minted claim now marks the claim record (`redeemedAt`, under its expected revision) before setup takes the name. `revokeClaim` expects the same revision, so one side wins. If revocation wins, redemption fails before any namespace claim or account exists. If redemption wins, revocation reports `claim_in_use` ("already redeemed") without changing anything, and the account keeps claim provenance (internal). An abandoned redemption (marked, setup never finished) cannot be revoked but expires with the claim. The onboarding sweep then releases the unclaimed name. | claim-redemption-chaos (30 seeds; both winners occur; fails without the fix) |
| identity/service.mjs, runtime/http.mjs, runtime/signup-capacity.mjs | Free/paid signup capacity claims carry the new account ID as an admission receipt (`signup-free/<id>`, `signup-paid/<id>`). A redelivered claim spends one unit, and a reused receipt with different content fails closed. Claims without a receipt behave as before. | signup-capacity-receipts (3 tests, including seeded interleaving with duplicate delivery) |

## Open

- Admin console UI (apps/web, not owned here) shows a redeemed claim as "Outstanding" until it expires. It is excluded from the live-claim count. Showing "Redeemed" is a UI follow-up.
