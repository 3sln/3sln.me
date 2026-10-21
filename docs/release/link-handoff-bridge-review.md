# Link handoff and bridge receiver review (BB-C1b, BB-B7)

Independent security review, 2026-10-20, of Wave 3 slices BB-C1b (descriptor and slot handoff) and BB-B7 (BindleBox bridge receiver). One reviewer agent read the changes, ran the four suites below and edited nothing. Human reviewer: ___ Date: ___ Outcome: ___.

This record is not a release approval. Production stays disabled. Everything new is behind `BINDLEBOX_ENABLED`, which is off by default, and the manifest row additionally needs `EXTENSIONS_ENABLED` and a mount.

## What was implemented (local behaviour only)

### BB-C1b

**Author proof on `evaluate` (`packages/links/author-proof.mjs`).** This closes [core links review](core-links-review.md) finding 1. The occupant now passes the author-signed envelope it is admitting. The host verifies all of the following itself:

- the envelope's recipient is this link (issuer, owner, `contactId`) and the link's `resource`, and its kind is one of the link's kinds;
- the author principal is the principal being evaluated;
- `createdAt` falls within the 24 h link window;
- the delegation certificate:
  - verifies under the principal's **current** same-host signing key, resolved by the host;
  - certifies the author purpose for the proof's jkt;
  - has a lifetime of at most 24 h;
  - is strict JSON with no duplicate members;
- the envelope signature verifies over the BindleBox envelope domain under JCS;
- the delegation status is `active`.

The envelope domain and the JCS reading are pinned to `packages/bindlebox-protocol`, and certificates are cross-parsed by it.

**Link authority (`packages/links/engine.mjs`).** App actors that carry the verified connection `generation` must match the seat's generation.

**Descriptor handoff (`packages/links/handoff.mjs`).**

- The provider verifies the link, reads the occupant of the slot the link type is bound to, calls the provider's `describe` port, and validates the result against bindlebox §2.3. The ingress must be on the occupant's origin when that origin is known.
- It serves the link's signed `kinds`, with `expiresAt` at most 1 h away.
- The cache is keyed on the seat (client and generation) and expires within 1 h.
- Every failure is one uniform answer: 503 `recipient_unavailable` with `Retry-After: 3600`.

**Account wiring (`packages/runtime/account/links.mjs`).**

- Host proof ports: `identityKey` and `delegationStatus`.
- `linkDescriptor` uses `gate: 'none'`.
- `linksResourceMethod` handles the links contract and is appended to `RESOURCE_METHOD_HANDLERS`. It builds the app actor only from verified context: epoch, app connection, the occupancy seat at that generation, and the handle from the identity directory. This closes core links review findings 4 and 5. Writes are journaled per (client, tx).

**Descriptor route (`packages/runtime/routes/links.mjs`).** It runs in the `edge` stage, because the contacts module answers every contact path in `public`. It checks the app origin itself and answers only the exact media type.

**Manifest (`packages/runtime/federation.mjs`).** One EXT-X2 row declares the `messaging-address` consumer. It requires `mounts.messagingAddress`, which the adapters do not set yet.

**Link-type → slot table (`LINK_SLOT_TABLE` in `packages/links/types.mjs`).**

**Cross-owner change.** `bindlebox-engine/domains/receive.mjs` (owned by B2) has one change: it passes `proof: envelope` to `providerLink.evaluate`.

### BB-B7

`packages/bindlebox-engine/domains/bridge.mjs` adds `bridge.receive`, `bridge.configure` and `bridge.settings`, registered in the operations table and the catalogue. `bridge.receive` runs in this order:

1. strict RPC framing for the intake contract and `deliver`;
2. consumer and channel binding, checked before any key lookup: only the owner's provider may use `email`, and an application consumer the owner allowed may use only its own channel;
3. B2's `intake.deliver` for provenance verification (consumer key, `iss`, recipient, digest, 7-day window) and tx/jti dedup;
4. dedup on ingress fingerprint per consumer;
5. the owner switch, read in the commit.

The resulting item has channel origin and an unverified sender. It is never authored. Spam tiers run later in `intake.drain`. There is no egress or reply port, and the result is exactly `{disposition}`.

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| LH-1 | Medium, confirmed | The evaluation budget was charged before proof verification. Proofs that failed (for example from authors on other hosts) could exhaust the per-link and per-owner budgets and lock out eligible senders. | **Fixed.** The proof is verified first, under a separate per-owner failed-proof budget. Only verified proofs spend the evaluation budget. A regression test sends 70 invalid proofs, then a valid one, which is still `eligible`. |
| LH-2 | Medium, suspected | The links write journal was reserved before the occupancy check, so a connected app without the seat could fill the 256-entry cap and block the occupant. | **Fixed.** Occupancy at the exact generation is checked before any journal read or write. There is a per-client cap of 128, and `forbidden`/`unauthorized` are never journaled. Regression test added. |
| LH-3 | Low, suspected | Generation fencing ignores the connection id. If one client could hold two connections with equal generations, both would pass. | **Open.** The fix needs the occupancy port (EXT-X4, `account/connections.mjs`, not owned here) to return `connection`. Requested from the X4 owner. |
| LH-4 | Low, confirmed | The descriptor route did the identity lookup before rate limiting, which made it a handle/subject oracle. | **Fixed.** The network rate limit now runs before parsing or any lookup. |
| LH-5 | Low/Info, confirmed | Proof checks were looser than the protocol library's: no 24 h certificate cap, duplicate JSON members allowed, no binding of `resource` or kind to the link. | **Fixed.** All three are enforced, with regression tests. `identityURI` shape is not bound; it is host-specific and the key comes from the host anyway. |
| LH-6 | Info | Conditional links cannot admit authors from other hosts (`author_proof_invalid`). | **Accepted, provisional.** This is the documented limit until the directory profile exists. To be recorded in DEVLOG as a functional gap. |
| LH-7 | Info | Bridge items: (a) the `refused` answer came before provenance was verified; (b) fingerprint pruning lists every row on each delivery (O(N)); (c) B2's `intakeJti`/`intakeTx` rows are never pruned; (d) `createBridgeProvider` is not wired into the B8 shell, and the shell must always pass `resource`. | **(a) Fixed:** the switch is read in the commit after verification. (b) **Accepted.** Rows are bounded by the per-day public limits × 8 days. (c) and (d) **Open** for B2 and B8. Until then the bridge is unreachable in the shell, which fails closed. |
| LH-8 | Info | A replaced occupant could replay its own write tx and get the cached result. | **Fixed** by LH-2's ordering. |

The reviewer found no issue in these areas:

- actor construction from verified context;
- refusal of stale and replaced occupants;
- the proof's binding to link, owner and principal;
- JCS and signing-input parity with the protocol library;
- descriptor uniformity and validation;
- no server-side fetch, so no SSRF;
- the edge route's origin and media-type checks;
- bridge consumer and channel binding before key lookup;
- fingerprint scoping and conflict handling;
- no backscatter path;
- dispositions independent of classification;
- flag gating.

## Known limits

- **Not yet wired.** `MESSAGING_DESCRIBE` (the provider's brokered `describe` call, EXT-X7), the adapters' `mounts.messagingAddress`, federation routing of the links-contract resource, and the BindleBox shell's routing to `bridge.receive` are all unwired. Until they exist, every descriptor answers `recipient_unavailable` and nothing is advertised.
- **Landing page.** The HTML landing page for app-type links still uses the generic composer, which the contacts module owns. Its preview profile does not yet know app-type links.
- **Unchanged receive behaviour.** An invalid proof still surfaces to the sender as `audience_unavailable` and is not counted by B2's refusal limiter.
- **Provider side not built.** The fake provider in the tests models SMTP acceptance, the holding queue, tx derivation and the invariant reply. The real BRIDGE slice is not built. No mail delivery, provider conformance or production capability is implied.

## Evidence

- `tests/core-links-handoff.test.mjs`, 6 tests:
  - protocol pins;
  - end to end: provider contact link → descriptor → occupant ingress → B2 admission, including conditional links with host-verified proofs and an intent handler;
  - proof negatives;
  - LH-1 and LH-5 regressions;
  - occupant replacement;
  - the resource method, including the LH-2 regression;
  - the manifest row.
- `tests/core-links-handoff-http.test.mjs`, 1 test on the real Node adapter, covering the descriptor route: headers, uniform 503, 401/400 answers, revoked links, fall-through to other media types, and the flag off.
- `tests/bindlebox/bridge.test.mjs`, 5 tests:
  - registry;
  - fake-provider end to end, covering tiers and invariant replies;
  - forged and misbound provenance;
  - dedup on tx, jti and fingerprint, plus a lost commit reply;
  - no reply or signal for rejected mail, the switch, and the flag.
- `tests/core-links.test.mjs` was adapted to the required proof, using a stub host verifier.
