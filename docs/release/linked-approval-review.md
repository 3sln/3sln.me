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

## LA2 implementation

Status: agent review, 2026-10-20. One independent agent reviewer worked read-only against the uncommitted LA2 federation device grant (`packages/federation/device-authorization.mjs`), the app-session lifetime rewrite (`packages/federation/app-sessions.mjs`), the lifetime hunks of `packages/identity/linked-approval.mjs` and their tests, under the user decisions of 2026-10-20 (no absolute app lifetime, 180-day idle, access tokens ≤ 15 min Bearer / ≤ 60 min DPoP, live checks on every refresh and RPC, one fresh step-up at approval). It confirmed findings with scratch tests. The author fixed the confirmed findings in LA2-owned files and added regression tests (`tests/device-authorization.test.mjs`, last test). This is not human sign-off, and production remains gated.

Human reviewer: __________  Date: __________  Outcome: __________

**Judged sound by the reviewer:** bound access tokens are invisible to the Bearer path; the internal owner-shard code cannot be redeemed at `/oauth/token` (PKCE challenge derived from the linked request); single redemption (transactional approval-record delete, durable proof consumption, rollback); the post-issue lineage re-check fails closed; browser and media-type refusal first; pending answers carry only `error` and `interval`; metadata-document clients get `unauthorized_client`; `dpop_jkt` bound through redemption; nonce checked after the signature; `ath`, `htu`, `htm` and `iat` checked; RPC requires the token key; refresh without the key neither renews nor revokes; reuse revokes and ends the lineage; only the current token revokes a bound family; host lifetime settings are capped; the cancel endpoint needs the request key.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| LA2-S1 | High | A preferences read with a DPoP-bound token minted resource child tokens in the Bearer namespace (`service.mjs` `readPreferences` copies the parent record), giving a key-less credential that skipped the lineage check. | **Fixed.** The device RPC handler moves every child token it returns into the bound namespace with the parent's key, so it needs a proof with `ath` and passes the lineage check. Regression test added. `service.mjs` itself still mints Bearer children for any caller; its owner should make children inherit `jkt`. |
| LA2-S2 | High (release blocker) | The SDK (`packages/sdk/src/tokens.mjs`) rejects `expires_in > 300`, so 60-minute device tokens and 15-minute renewals fail SDK validation. | **Open, other owner.** The SDK must accept 900 s Bearer / 3600 s DPoP. `tests/authorization-entry-sdk-contract.test.mjs` fails until then. |
| LA2-S3 | Medium | For `ongoing` sessions `refresh_expires_in` equals the idle window, and the SDK treats it as a deadline that never moves later, forcing re-sign-in at day 180 even when active. | **Spec fixed, SDK open.** auth.md and device-authorization §7 define `refresh_expires_in` as the issued refresh token's lifetime, renewed by rotation. The SDK must follow. |
| LA2-S4 | Medium | The global poll budget was charged before the per-network bound, so one address could exhaust it for everyone. | **Fixed.** Per-network first; refused polls are not charged globally. Test added. |
| LA2-S5 | Medium | The per-client creation budget was charged before the per-address cap, so one address could exhaust a client's budget. | **Fixed** (address cap charged first). Unknown client addresses still skip the address cap, as in LA1, relying on per-client and global caps; adapters must supply the client IP. |
| LA2-S6 | Medium (suspected) | `ongoing` lineage never expires, and an abandoned (idle) family never ends its lineage, slowly filling the 100-entry lineage table. | **Fixed for device families.** Before each app approval, LA2 ends idle or revoked device families of that owner and their lineage. Test added. Residual: `service.mjs` `createRefreshFamily` (memory-profile code flow) can prune a device family without ending its lineage. |
| LA2-S7 | Medium (design risk) | A step-up within 5 minutes, possibly from before the request existed, plus the indefinite default amplifies device-code phishing. | **Mitigated.** An app approval's confirmation must postdate the request (`authAt ≥ request.createdAt`). The `ongoing` default and the indefinite lifetime remain the user's decision; residual risk recorded in architecture §13 and spec §10.1. |
| LA2-S8 | Low | The RPC `jti` cache is per instance, the RPC nonce optional, and the proof does not cover the body, so a captured token+proof pair replays on another instance within 60 s. | **Accepted residual** (RFC 9449 resource-server profile). A shared jti store or mandatory RPC nonce is LA3 follow-up. |
| LA2-S9 | Low | A repeated approval could overwrite the stored approval record, orphaning grants. | **Fixed.** An existing record is never overwritten; the new grants are withdrawn and `conflict` returned. Unredeemed approvals still leave inactive-in-practice grants until revoked (as unredeemed codes do today). |
| LA2-S10 | Low | `cleanup()` never removes idle families or refresh rows with the `NO_EXPIRY` sentinel. | **Partly addressed.** Revoked families now get `expiresAt = now` and are cleaned; idle device families are revoked by the approval sweep and per-account pruning. `service.mjs` `cleanup` should also consider `idleExpiresAt` (other owner). |
| LA2-S11 | Low | Client eligibility was checked only at creation. | **Fixed.** Refresh and device RPC re-check that the client is still a device-eligible registration and end the session otherwise. |
| LA2-S12 | Info | Each rotation's 30 s grace is per record, so a same-key thief and the client can alternate inside 30 s windows. | **Accepted** (requires the private key; the grace is the user-specified behavior). |

Also noted by the author: `dpop.mjs` lets a malformed segment's `DOMException` (numeric `code`) escape `verifyProof`; LA2 maps it to `invalid_dpop_proof`, while `http.mjs` answers a generic error (other owner). `FederationService.issueAccess` still issues 5-minute tokens for the initial code exchange (other owner).

Decision reviewer: __________  Date: __________  Outcome: __________


## LA3 mount

Status: agent review, 2026-10-20. One independent agent reviewer read the uncommitted LA3 mount and ran workerd probes against it. The mount covers: `packages/runtime/device-grant.mjs`; the linked, device, `/approve` and declaration hunks in `packages/runtime/routes/{identity,federation,site}.mjs` and `packages/runtime/federation.mjs`; and the Worker/Node composition. Everything sits behind `DEVICE_AUTHORIZATION_ENABLED`, which defaults to off. This is local evidence only. There is no production verification and no human sign-off.

Human reviewer: __________  Date: __________  Outcome: __________

**Judged sound by the reviewer:**
- **Owner trust.**
  - Review, approve and drain take the owner from the authenticated session.
  - `issue` takes it from LA1's redemption.
  - RPC takes it from the token prefix, after an active-account check and before any Durable Object wakes.
  - The owner shard refuses any other owner, and `device()` exposes only five methods. None of them is reachable over HTTP.
- **Approval routes.** They run after the router's exact-Origin check and require the member's CSRF token and an owner/session-context match.
- **`configure`.** It adds no capability beyond `/api/preferences`.
- **Binding cookie.** It is `__Host-`, HttpOnly and SameSite=Strict.
- **Review payload.** It carries no client name, DPoP data or device code. `authAt` is UX only, and every decision re-checks it.
- **Lone `Sec-Fetch-Mode`.** Relaxing the browser refusal for this single header is safe.
- **Bounded reads.** Body reads are bounded, and poll limits run before signatures or storage.
- **Declaration.** The declaration appears only on the authority manifest, and only when the flag is on and federation, refresh and the DPoP key are all mounted. Every declared member works.
- **Flag off.**
  - The new paths answer exactly like unknown paths.
  - No cookies are set.
  - `/api/config` gains only a boolean.
  - The legacy `/device` page and the QR validator are unchanged.
- **Flag on with federation off.** Only the session kind mounts, and `configure` fails closed.
- **Drain.** It re-arms while the outbox has entries, and it is cleanup rather than the access control.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| LA3-S1 | Medium | Refresh and access tokens have the same shape as device codes. Device-code cancellation ran first for any DPoP-bearing revocation and returned its own errors (for example a stale proof, or `invalid_request` for a browser client). The real RFC 7009 revocation then never ran, while the client believed the token was revoked. | **Fixed.** Only an explicit `token_type_hint=device_code` can fail the request. Without a hint, cancellation is best effort and the RFC 7009 handler always runs. Requests with browser headers skip it. Worker test: a stale-proof, unhinted DPoP revocation still revokes. |
| LA3-S2 | Medium | Device polling went through the generic `/oauth/*` limiter, which allows 30 requests per minute per IP and answers 429. The provider's global poll cap answered 503. The SDK treats both as terminal, so a shared NAT, or an attacker in the same lane, could abort other users' sign-ins. | **Fixed at the mount.** The `device_code` branch now runs before the generic limiter, under the provider's own per-network and global poll bounds. Overload is answered as RFC 8628 `slow_down` (interval 10). Residual (SDK owner): the SDK should treat 429 or 503 with `Retry-After` as a back-off. |
| LA3-S3 | Low | Routes were gated on the string `'true'`, but the mount evidence also accepted boolean `true`. On Node, `config:{DEVICE_AUTHORIZATION_ENABLED:true}` could therefore declare routes that were not mounted. | **Fixed.** The routes use the same predicate as the mount evidence. |
| LA3-S4 | Low | An uncoded failure on the token branch became a 500 after redemption. A lost owner-shard call left a live lineage with no family. | **Fixed.** The token branch answers 503 `temporarily_unavailable`. A lost or uncoded remote `issue` revokes the reserved lineage and answers `access_denied`. |
| LA3-S5 | Low | A malformed `choice` was dropped, so the request fell back to the longest default lifetime. Separately, an app-kind approval sent without a consent array goes straight to LA1. | **Fixed for `choice`.** A present but malformed choice now answers `invalid_choice`. **Accepted** for the second part: LA1 consumes the request, the redemption then fails closed with `access_denied`, and only the approver's own flow is affected. |
| LA3-S6 | Low (suspected) | On the Worker, every resolve, session kind included, wakes the member's owner FederationObject. That writes its owner marker and arms its alarm. | **Accepted residual.** The calls are authenticated and bounded by the account and network budgets. Routing session-kind resolves away from the shard would need a kind probe that charges the guess budget twice. Revisit with a provider short-circuit. |

Also reconciled by the author during the mount (not reviewer findings):
- Node's `fetch` (undici, also the SDK's CLI transport) always sends `Sec-Fetch-Mode: cors`. Under the spec's literal "any `Sec-Fetch-*`" rule, the LA2 browser refusal would reject every Node CLI. The mount withholds only a lone `Sec-Fetch-Mode` from the check, because browsers send it together with `Sec-Fetch-Site`/`Dest` (and `Origin` on POST). Spec §4.1 wording needs the same refinement (coordinator).
- With the flag on, the console uses the linked flow, so the legacy QR browser test (`tests/e2e/worker-flow.test.mjs`) does not apply. It passes with the flag off.

Decision reviewer: __________  Date: __________  Outcome: __________
