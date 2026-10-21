# Linked approval and device authorization: security wargame

Status: design review, 2026-10-20. One independent agent reviewer worked read-only against the first drafts of [device authorization](../spec/device-authorization.md) and [linked approval](../architecture/linked-approval.md), and against the current device-login code. The design author incorporated the fixes below into both documents. This is agent review, not human sign-off. Nothing here is implemented, and production remains gated.

Human reviewer: __________  Date: __________  Outcome: __________

## Scope

The reviewer wargamed these attacks against both the design and the current code:

- device-code phishing, including on-demand code generation and the same-network heuristic;
- user-code brute force;
- session-lifetime escalation and laundering;
- cross-account approval;
- replay;
- polling and creation DoS;
- QR swap variants.

It also checked pre-consent privacy, RFC 8628 and RFC 9449 conformance, and whether the spec and the architecture agree. Code read: `packages/identity/{device-login,service}.mjs`, `packages/federation/{app-sessions,authorization-entries}.mjs`, `packages/runtime/routes/identity.mjs`, `apps/web/src/bl/release.mjs` and `apps/web/src/ui/release-public.mjs`. No tests were run. Findings on existing code are from reading the source and need confirming with tests in slice LA1a.

## Findings and dispositions

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| LA-R1 | **High, existing code** | `IdentityService.recent()` (`service.mjs`) and the inline check in `emailStart` use `session.createdAt` regardless of `source`. `DeviceLogin.poll` always issues a full 24 h session. A device-approved session can, in its first 15 minutes, approve another device, which gets a fresh 24 h. The chain repeats without limit, which breaks the lifetime rule today. The same session can also enroll a passkey, link an attacker's email and enable email login (a lasting takeover), remove credentials or revoke the owner's other sessions. | Fix first, as standalone slice LA1a: `authAt` in both checks, issuance clamped to `E`. Architecture §7.3, §14. **Recommend prioritizing ahead of the rest of this design**, because the exposure exists now (behind the release gate). |
| LA-R2 | **High, existing code** | The device review page shows the code from the QR fragment next to the "type the code" field, so typing degenerates to copying from the same page. `ApproveDeviceLogin` compares the typed value only in the browser, then sends the URL copy to the server, so the server never sees the typed code. The anonymous `/api/auth/device/inspect` returns label, status and expiry, limited only per IP. | QR and links carry the locator only. The page never shows a code before it is typed, approve sends and re-matches the typed code, and inspect is removed. Architecture §4.3, §11, §12. |
| LA-R3 | Medium, existing code | `emailLoginConfirm` creates `source:'credential'` sessions, so under `authAt` mailbox control alone could approve devices. | Email sessions get `source:'email'`; recovery and activation sources are audited too. Spec §5.1(2) excludes mailbox proof. Architecture §7.3. |
| LA-R4 | High (design) | Confirm-only on network match is defeated on shared networks (hotel or office NAT, CGNAT, VPN exits): a QR sticker for `/approve#c=ATTACKER` over a TV app's QR passes every condition, and users tick without comparing. | **Confirm-only removed from v1**, and 3sln.me issues no `verification_uri_complete`. CLIs paste the code. If confirm-only is ever reconsidered, the minimum conditions are recorded in architecture §4.3. Spec §10.6 explains why. |
| LA-R5 | High (design) | Brute-force bounds were weak at botnet scale, and the numbers were inconsistent. N = 20⁸ = 2.56×10¹⁰; at L = 20,000, p = 7.8×10⁻⁷ per guess. One account at 40/h finds about 0.27 codes a year. Throughput is min(40A, 80I): with 1,000 accounts and 500 IPs, about 270 a year. Turnstile on the global budget alone is not a cap, and the session kind was outside L. | Hard global failed-resolve budget `G` per day with `G·L/N ≤ 0.01` (about 12,800 at the cap), then Turnstile on every attempt, then typed-code refusal (locator only). Per-account daily cap of 30, limits keyed by prefix, both kinds counted in L, and the §4.1 and §9 numbers reconciled (≤ 20/h per account). Architecture §4.1, §9; spec §10.3. |
| LA-R6 | Medium | Burning a request after 5 locator misses protects nothing, because whoever sees the QR also sees the code. Locator guessing is already 1/N. The burn is a DoS: any viewer of a shared screen can kill requests. | No burn. Misses count against account and prefix limits, and the page drops the locator after 5 misses. Architecture §4.2. |
| LA-R7 | Medium | Login-CSRF onto a shared screen: a remote viewer types the code first and the room TV signs into the viewer's account. "Signed in as" text is easy to miss. | The requesting screen asks "Continue as @handle?" before installing the session (new `confirm` poll status and `accept` operation, LA-15). The SDK aborts on a hint mismatch and otherwise asks for confirmation. Spec §6.3 tightened. |
| LA-R8 | High (availability) | About 2,000 IPs hold all 20,000 live slots, and about 30 exhaust one client's 300 per 10 min. Per-IP limits are meaningless for IPv6. Create→cancel loops grow storage under 24 h retention. | Per-prefix live caps (≤ 3 per IPv4 address or /64), /24 and /48 rates, per-ASN caps and fair admission under pressure, creation-rate caps, and prompt deletion of unconsumed records. Proof-of-work is open question Q6. Residual noted in architecture §13. |
| LA-R9 | High (design) | Lineage gaps. (a) Eviction by `session()`'s 10-session limit ends a parent without cascading. (b) The outbox needed family IDs held on another shard. (c) A race between the token endpoint's liveness check and the family write. (d) `revokeOtherSessions` from a derived session hits its own parent, and recovery or suspension must cover families. | (a) Eviction cascades and prefers sessions without descendants. (b) `derivedFamilies` lives on the parent session entry in the account record. (c) Order: reserve the family in an account CAS → activate → re-check liveness → revoke if the session ended. (d) A derived caller's ancestors are left out of "others" and listed separately; recovery and suspension move every family to the outbox. Architecture §7.4; spec §7(4). |
| LA-R10 | Medium | Rules on derived sessions contradicted each other ("never fresh" vs step-up allowed; "never gains `stepUpAt`" vs `stepUp()`). | One rule: a derived session may approve after its own credential step-up. This is safe because `E` is bounded transitively and the cascade is transitive. Spec §5.1(2), §7(6); architecture LA-7, §7.2, §7.3. |
| LA-R11 | High (migration) | Aliasing the legacy anonymous inspect over the shared namespace would bypass LA-4 and leak app-kind client details. | No inspect alias, and the aliases apply the new rules. Architecture §11, §12. |
| LA-R12 | Medium | A phisher sets `identity` to the victim's handle, and a "Requested by the app" badge legitimizes the lure. `client_name` (attacker text) would appear in a `security` email. Well-known registered clients make the best lures. | Hints only preselect, with no badge. Notices use the verified host only. Per-client device-grant fragment allowlists, with a second tick for sensitive fragments. Spec §10.1; architecture §6.1, §8. |
| LA-R13 | Medium/low | Conformance and completeness: (1) `dpop_jkt` at the device endpoint is an extension; (2) DPoP replay protection needs nonces or a `jti` cache without per-poll writes; (3) Bearer access tokens are inconsistent with mandatory DPoP; (4) there was no row for "approved but the session is dead"; (5) the global poll bound was missing; (6) the media type was not pinned. | (1) Stated as a Bindle extension. (2) Time-windowed nonces plus a non-durable `jti` cache. (3) `token_type` MUST be `DPoP` for this grant, so LA2 must add DPoP support to RPC. (4) Row added: `access_denied`. (5) Global poll ceiling added. (6) Exact `application/x-www-form-urlencoded` required. The `Origin`/`Sec-Fetch-*` refusal goes beyond RFC 8628 but is legitimate. Spec §4.1, §6; architecture §9. |
| LA-R14 | Low | A plaintext `userCodeDisplay` beside the hashed index defeats the hash, and an unkeyed hash of a 34.6-bit code is brute-forced offline. | HMAC under `LINKED_CODE_KEY`, with the display copy kept only on the requesting device. Architecture LA-16, §3, §4.1; spec §10.3. |
| LA-R15 | Low | A pre-consent location display leaks to code guessers, and a VPN exit near the victim makes it falsely reassuring. | No location display. Only a country-mismatch warning, and only when the IP and geo source are trustworthy. Architecture §6.1; spec §10.1. |
| LA-R16 | Low/medium | On a quishing lookalike, a password step-up is phished, which is credential theft beyond one approval. | Passkey step-up is preferred, with password only when the account has no passkey. This is listed as residual risk in architecture §13. |

## Brute-force arithmetic (after fixes)

- Code space N = 20⁸ = 2.56 × 10¹⁰. The global live cap across both kinds is L ≤ 20,000, so p = L/N ≤ 7.8 × 10⁻⁷ per typed guess.
- One account is held to ≤ 20 failures per hour and ≤ 30 per day. That gives at most 30 × 7.8 × 10⁻⁷ ≈ 2.3 × 10⁻⁵ discoveries per account per day, about 0.009 per year, at the cap.
- The global budget `G` holds everyone together to ≤ 0.01 expected discoveries per day while it lasts: G = 0.01 · N / L, which is about 12,800 failures per day at the cap and about 256,000 at 1,000 live codes.
- Past `G`, each typed attempt needs a Turnstile pass. That phase is bounded by the solver farm's budget, not by design. When the operator sees abuse, typed resolution is refused for the rest of the day and only locator resolution works. That is an availability cost during an attack, chosen deliberately over silent exposure.
- A guess with a locator succeeds with probability 1/N = 3.9 × 10⁻¹¹ and is not counted in `G`.
- Consequence of a hit: the attacker sees the request (client host or device kind) and can approve it with the attacker's own account. The "Continue as" confirmation on the requesting screen (LA-R7) and the SDK subject check make that visible to the victim. The attacker can also deny it, which is a nuisance.

## Judged sound by the reviewer

- `E = min(S, cap, U)`, fixed at approval.
- One CAS per decision.
- The session-kind consume fence and cancel compensation from the [cancellation review](device-login-cancellation-review.md).
- No success replay, and a 256-bit hashed device code bound to DPoP.
- Resolve only when signed in.
- Owner and session-context re-verification for multi-account.
- No pre-approval push.
- Device kind as a fixed choice.
- QR codes carrying the locator only.
- `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and COOP.
- The `__Host-` SameSite=Strict binding cookie, now required by the design.
- Interval state in the non-durable limiter.
- A lost response forces only a restart.

## Residual risks accepted in the design

- Remote phishing of a user who follows an attacker's instructions (spec §10.1).
- A malicious or compromised requesting device's own display.
- Availability under large residential-proxy floods.
- The Turnstile phase of the global budget.
- Password step-up on lookalike sites for accounts without passkeys.
- An approximately 5-minute access-token tail after lineage revocation, until the outbox drains.

## Open items for the coordinator and user

- Decide architecture Q1 (whether app lifetime is capped at 24 h), Q2 (whether voluntary sign-out cascades), Q3 (metadata-document device clients), Q4 (default duration), Q5 (paste vs a hardened confirm-only) and Q6 (proof-of-work).
- Schedule LA1a (the LA-R1 and LA-R3 fixes) independently and soon. It touches `packages/identity/service.mjs` only.
- Update the spec registry (`protocol.md` features table), `device-login.md` (supersession note) and the public-docs allowlist. Record the decisions in DEVLOG.md.

Decision reviewer: __________  Date: __________  Outcome: __________

## LA1 implementation

Status: agent review, 2026-10-20. One independent agent reviewer worked read-only against the uncommitted LA1 identity core: `packages/identity/{linked-approval,device-login,service,index}.mjs`, the Worker/Node adapter hunks and `tests/linked-approval.test.mjs`. It checked them against [linked approval](../architecture/linked-approval.md) §3–§10.1 and the [device authorization](../spec/device-authorization.md) spec. The author fixed the confirmed findings in LA1's own files and added regression tests. Findings that need other owners stay open. This is not human sign-off, and production remains gated.

Human reviewer: __________  Date: __________  Outcome: __________

**Judged sound by the reviewer:**
- single consume of accept and redeem, with request CAS, including races;
- the cancel fence;
- the reserve → re-check order;
- outbox deduplication;
- the `E` caps and choice validation;
- the app fresh-sign-in rule;
- multi-account context;
- no pre-consent leak;
- the charging order;
- no anonymous inspect in the legacy alias;
- system operations unreachable from browser classes;
- adapters passing a configured code key.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| LA1-S1 | Medium | Admin suspension (`admin.mjs`) and the lifecycle tombstone clear sessions without `revokeAllLineage`. After reactivation, an app approved from a naturally expired session revives for the rest of `E`, and the drain never revokes it. | **Locally implemented by integrator, 2026-10-20; no independent re-review.** Suspension and tombstone CAS writes call `revokeAllLineage`; tombstones retain the durable outbox. Node/Worker-style suspension and actual app-lineage tombstone regression tests pass. LA2 family issuance/draining remains later work; architecture §10.1. |
| LA1-S2 | Medium | Nothing physically deletes linked-approval records. Adapters only treat them as expired, so requester country and decided-request fields stay at rest and storage grows. | **Locally implemented by integrator, 2026-10-20; no independent re-review.** Transactional expiry indexes and bounded identity-alarm sweeps remove request records and code lookups. Node restores device alarms on restart; consumed session fences survive until E. Portable SQLite/shard and actual Worker regression tests pass; architecture §10.1. |
| LA1-S3 | Medium | The prefix budget was charged on locator, approve and deny calls, so guessers on a shared /24 could block QR approvals. Unknown client addresses shared one service-wide bucket. Hex IPv4-mapped IPv6 addresses collapsed into one /64. | **Fixed.** Typed codes pay the network budget before evaluation; locator attempts pay only on a miss. Unknown addresses are keyed per account for resolve and skip the start prefix windows. `::ffff:` hex is normalised to IPv4. Tests added. |
| LA1-S4 | Low | IPv6 resolve limits were per /64 only, so a /48 holder had 65,536 buckets. | **Fixed.** An added /48 tier allows 200 per day. Test added. |
| LA1-S5 | Low (suspected) | Single Durable Object hot spots: the live-slot counter and `resolve-g`. Filling the live cap also blocks legacy QR starts. | **Partly fixed.** The live counter is sharded 8 ways and summed on read. `resolve-g` stays one window, touched only by typed resolves after the account and network budgets. The shared live cap is kept deliberately, because `L` must count both kinds. Residual. |
| LA1-S6 | Low | `redeem` consumed before reserving, and a full lineage table or CAS exhaustion threw non-RFC faults. | **Fixed.** Parent liveness and the lineage limit are checked before the consume. Reservation failures map to `access_denied`. Test added. |
| LA1-S7 | Low | Expired but still-stored sessions counted as explicit removals, so whether an app survived natural expiry depended on whether pruning had run. | **Fixed.** Only removal of a still-live session (or live descendant) is explicit, in every mode. Test added. |
| LA1-S8 | Low | An omitted `linkedCodeKey` silently used a per-instance key. The federation `IdentityService` passes no linked resources. | **Fixed.** A missing key fails closed, and only `linkedEphemeralKey: true` (tests) opts in. §10.1 requires LA2 to use the main identity resources. |

Contract notes from the review, applied to §10.1:
- `accountHandle` on approve is optional, and the tab context then carries account binding;
- redeem returns RFC 8628 statuses only;
- the retention text is corrected (LA1-S2).

Decision reviewer: __________  Date: __________  Outcome: __________
