# Extensibility design review (slots, integrations, brokered resources)

Date: 2026-10-20. Subject: revision 1 of [extensions](../spec/extensions.md), [integrations](../spec/integrations.md) and the [extensibility design](../architecture/extensibility-design.md). Two independent reviewer agents with different lenses read the drafts plus the relevant core specs and source (`packages/federation/schema.mjs`, `service.mjs`), working read-only. Revision 2 of all three documents incorporates the fixes recorded below. This is an agent review, not human sign-off: reviewer ___ / date ___ / outcome ___.

The review asked two questions. Can the core invariants be broken by abuse? Does the design survive versioning, partial support and ecosystem growth? It found 9 High findings across the two lenses:

- 6 interop: client-metadata contradiction, offline authority, preferences v1 semantics, per-occupant consent, occupant replacement versus pending retries, and fragment unknown-member rejection;
- 3 security: core-MUST conflicts, an overclaimed severance bound, and cross-issuer subject confusion.

All are resolved in revision 2. Several resolutions require core amendments, which are listed (C1–C11) but deliberately not applied, because other agents are editing `protocol.md` during the messaging extraction.

Both reviewers judged it correct to keep `profiles` distinct from slots, for three reasons: the subject differs (a host property versus entity roles), multiplicity differs (a map versus an array), and so does the security boundary (only profiles may use the component-origin envelope).

## Security and abuse lens (24 findings: 3 High, 15 Medium, 6 Low)

| ID | Sev | Finding | Resolution in revision 2 |
| --- | --- | --- | --- |
| SEC-1 | High | Brokered access contradicts core MUSTs: immediate revocation (protocol §4, auth), issuer-gateway-only, no third-party endpoints, no callbacks, opaque preference references. | An explicit `brokered-resources.v1` exception with a stated bound (amendment C8). Contracts can opt out (`x-bindle-brokerable: false`) or require introspection (`introspect`, 30 s bound). Consent discloses the delay (integrations §5.2, §5.7, §14). |
| SEC-2 | High | "Bound without cooperation" is false: an integration can ignore `exp` or hand consumers its own credentials. | §7.3 now separates what the provider guarantees, what a conforming integration adds, and what no one can guarantee. Integrations MUST NOT derive consumer credentials from brokered tokens. Consent discloses this. |
| SEC-3 | High | Cross-issuer subject confusion; a JWKS fetch before connection lookup gives SSRF and DoS. | Subjects must be on the `iss` origin. Resources are bound to (`iss`, connection, `sub`). Validation order is lookup first, then a fetch from the pinned issuer only (§3.3, §5.5, §11.2–3). |
| SEC-4 | Medium | Integration identity continuity: key or `jwks_uri` changes, expired-domain takeover, shared-host origins. | JWK thumbprints pinned at approval. A key set without a pinned key, or a changed `jwks_uri`, auth method or `redirect_uris`, is staged for owner review and blocks events, discovery and minting. Endpoints share the `client_id` path prefix. Multi-tenant origins are refused unless operator-registered (§2.1, §2.3). |
| SEC-5 | Medium | Purpose confusion: `describe` used a discovery token; no discovery or SET checklists; SET verification referenced `typ at+jwt`. | `describe` purpose defined. Separate checklists for discovery (§4.2), invocation (§5.5) and SETs (§6.1). The RPC endpoint rejects other purposes. |
| SEC-6 | Medium | Terminal SET replay could delete new-generation data; no resume event; `seq` across generations undefined. | `terminal` affects only generations below the floor. A `connection-resumed` event is added. `seq` is monotonic across generations (§6.1–6.2). |
| SEC-7 | Medium | Integration-supplied IDs used as provider keys: collisions, issuer-origin IDs, ID recycling. | Provider-assigned `record_id`; the integration ID appears only in tokens and `broker.resource`. No external endpoints on the issuer origin. Missing IDs need owner reconfirmation, and IDs must not be reused (§4.3–4.4, §2.1). |
| SEC-8 | Medium | Leakage: connection ID in consumer-readable JWTs, raw IDs and labels in events, consumer identities, token logging. | The connection ID is declared non-secret and encodes nothing private. Event `values` equal the integration's own v2 read minus tokens. Disclosure that the integration learns which apps use the resource. Tokens are never persisted past expiry or logged (§3.3, §5.1–5.2, §6.2, §10). |
| SEC-9 | Medium | Hints: connection outside the signed assertion, cross-client claims, limit exhaustion, fetches for unknown clients. | Connection inside the assertion, `jti`, at most 60 s lifetime, local lookup only, ownership verified before limit accounting, failures limited per source (§8). |
| SEC-10 | Medium | DPoP downgrade and incomplete proof checks. | `dpop: "required"` mints nothing for keyless consumers. DPoP-bound is defined as "entry carried `dpopJkt`". All RFC 9449 §4.3 checks, including `ath` and a proof `jti` cache (§5.4). |
| SEC-11 | Medium | Slot spoofing through `publisher`; split view across fetchers; supersedes hijack. | The host of `id` is displayed and `publisher` is shown only when same-origin. Optional `digest` in declarations and fragment requests (C2). Provider-global pins. `supersedes` is same-origin only, and migration is offered only when an existing consumer requests it (extensions §2, §4, §5.1, §7). |
| SEC-12 | Medium | `any-error` asserted by the publisher alone; failover trusts occupant status claims. | `any-error` is valid only if every contract method is pinned `effect: read` or `pure`, and validators check this (C10). The spec states that status codes are occupant claims and that at-most-once roles use `exclusive` (extensions §3.3). |
| SEC-13 | Medium | Bulk consent for new occupants conflicts with resource scoping and protocol §4; hijack-by-prompt in the bridge example. | Per-consumer approval with no preselection, and the old origin shown against the new. `exclusive` replacement with provider consumers needs recent authentication and is never offered inside an integration-initiated flow (extensions §3.4; design §7.1). |
| SEC-14 | Medium | `unavailable` is a consent oracle for installed apps; SMTP behavior may vary with occupancy. | `unavailable` only from provider-public facts. A no-occupancy-oracle rule. SMTP responses must not vary with slot state (extensions §5.2, §9.8; design §7.1). |
| SEC-15 | Medium | Shared issuer key set; compromise has no procedure. | A dedicated brokering key set (`brokered-resources.v1.jwks_uri`) with purpose-separated `kid`s. Generations above the known maximum are rejected. Key-compromise procedure and one-hour residual stated (§5.3, §5.5, §7.1, §7.4). |
| SEC-16 | Medium | Provider-as-consumer identity: no grant, disable not revoking, `tx` collisions, provenance confusion. | `bindle.feature`, a grant per enablement, disable emits `credential-revoked`, UUIDv5 `tx`. The design requires `public-intake` to mark email provenance unverified (extensions §5.3, integrations §5.3, §7.1). |
| SEC-17 | Medium | Internal contradiction: minting in `degraded`. | A new `manifest-invalid` state (no minting). `degraded` is health only. Transient fetch failures change nothing (§2.3, §3.1). |
| SEC-18 | Medium | Clock-skew arithmetic understated the bound. | Leeway 30 s; verifier clocks within 30 s; `access_ends_by` = commit + 360 s, derived explicitly (§5.5, §7.2). |
| SEC-19 | Low | Retries versus the 10-minute freshness window. | Each attempt is re-signed with a fresh `iat` and the same `jti`. A duplicate `jti` gets 202 without reprocessing. Future `iat` rejected (§6.1). |
| SEC-20 | Low | Provider-only slots requestable by apps. | Supporting providers MUST refuse. The residual risk at non-supporting providers is noted (extensions §2.2, §8). |
| SEC-21 | Low | Introspection usable on others' tokens; 30 s cache contradicted "no delay". | `active: false` unless the audience and connection belong to the caller. The bound is restated as 30 s (§5.7). |
| SEC-22 | Low | Built-in self-preference; integration labels mimicking built-ins. | No preselection, neutral ordering, a built-in marker integrations cannot set, labels shown with origin (extensions §5.1). |
| SEC-23 | Low | `iss` injection on initiate-login and management navigation. | `iss` is untrusted, fetched under SSRF rules, and the issuer host is confirmed with the user (§3.2, §4.5). |
| SEC-24 | Low | Cost amplification: mint per read, unbounded cursor, manifest flapping, unbounded provider-consumer responses. | Token reuse while more than 60 s remain, cursor at most 1 KiB, notices coalesced daily, provider-consumer responses bounded by contract limits (§2.3, §4.1, §5.3, §11.6). |

## Interop and evolution lens (22 findings: 6 High, 11 Medium, 5 Low)

| ID | Sev | Finding | Resolution in revision 2 |
| --- | --- | --- | --- |
| INT-1 | High | Confidential-client requirement contradicts current client-metadata validation. Such clients are refused, not degraded. | Amendment C7. Integrations check `integrations.v1` and `token_endpoint_auth_methods_supported` first, otherwise they use a public `client_id` or do not connect (§2.1, §12). |
| INT-2 | High | Headless integrations lose provider RPC within hours (5-minute tokens, capped refresh). | A connection-bound rotating refresh token for `private_key_jwt` clients, uncapped while live and revoked by the severance commit (§3.4). |
| INT-3 | High | The brokered projection changed preferences/v1 semantics at an immutable URL. The M7 compatibility claim was wrong. | `preferences/v2` with a uniform object. `id` remains the provider's scoped reference; the integration ID is only in `broker.resource`. v1 readers never receive brokered values. M7 corrected (§5.1, C9). |
| INT-4 | High | Per-occupant consent is not expressible: the current read path hides the whole field while one occupant awaits consent. | Approved occupants are projected in owner order and unapproved ones omitted, with the field in `requiresConsent`. Per-resource `status`. Amendment C3 changes the read path (extensions §3.1). |
| INT-5 | High | Exclusive replacement revokes the credential needed for a same-`tx` retry. | An ambiguous outcome at a removed or replaced occupant is reported unknown and never dispatched elsewhere (extensions §3.3; design §7.1). |
| INT-6 | High | Fragments with unknown top-level members are rejected (`schema.mjs`), so the "works without support" claim was not guaranteed. | Amendment C1 (ignore unknown top-level members). §8 states the strict-provider fallback. Slice X1 owns the `schema.mjs` change. |
| INT-7 | Medium | Event freshness versus retries; lost acknowledgments; pull/push race on `revision`. | Re-signed retries with the same `jti` and a duplicate acknowledgment. Snapshots built at send time. `seq` returned in v2 reads and compared across channels (§6.1–6.3). |
| INT-8 | Medium | No forward-compatible path: supporting providers rejected unknown `slot.v`; unknown manifest `v` degraded connections. | Unknown or `crit`-failing slots are processed as ordinary fragments with an "unrecognized role" disclosure. Additive members are allowed. An unknown manifest `v` keeps the pinned snapshot and stages review (extensions §2.1–2.2, §7; integrations §2.2–2.3). |
| INT-9 | Medium | Pin scope and publisher equivocation. | Provider-global pins per URL. Optional `digest` in declarations and fragment requests (C2) (extensions §4.3). |
| INT-10 | Medium | Partial-failure semantics: snapshot timing, fresh `tx`, multi-invoke under `consumer-choice`, broadcast reporting, no-effect codes. | An operation snapshot; a fresh `tx` per occupant switch; multi-invoke gated on harmlessness; per-occupant broadcast results; amendment C4 (extensions §3). |
| INT-11 | Medium | Scoping `describe` used a discovery-audience token. | The `describe` purpose, with `aud = rpc_endpoint` (§5.6, §5.5 step 4). |
| INT-12 | Medium | The `unavailable` outcome has no wire representation. | Amendment C5. A missing status means `declined` (extensions §5.2). |
| INT-13 | Medium | Effect of one bad optional slot on the whole request was undefined. | Optional: `unsupported` for that fragment only. Required: `unsupported_fragment` (extensions §2.2). |
| INT-14 | Medium | Provider declaration removal was unspecified. | Built-in becomes `unavailable` but stays assigned. Consumer feature disabled, with notice and revocation (extensions §4.2). |
| INT-15 | Medium | "Required slot configured" and empty representation undefined. | Configured means at least one approved occupant. An empty `exclusive` slot is an absent field; an empty multi-occupant slot is `[]` (extensions §3.1). |
| INT-16 | Medium | Declaration validity depended on remote fetches; CORS. | Local syntax validation, lazy fetches, unfetched means "unknown", publishers serve CORS (extensions §4.3). |
| INT-17 | Medium | Event evolution and subscription. | Unknown types acknowledged and ignored. An `events` subscription list, with revocations always sent. `seq` across generations (§2.2, §6.1). |
| INT-18 | Low | Ecosystem fragmentation. | Occupants SHOULD declare every slot they fill. No equivalence mechanism. A curated `/artefacts/slots/` index is an open question (extensions §6; design §11). |
| INT-19 | Low | `supersedes` null, empty options, conflicting bounds, unenforceable MUST, missing downgrade rule. | All clarified (extensions §2.1, §4.3). |
| INT-20 | Low | `bindle_intent` name collision. | Renamed `bindle_management=create` (§4.5). |
| INT-21 | Low | `bindle.grant` undefined for provider consumers. | Defined as the feature enablement (§5.3). |
| INT-22 | Low | Slots requiring introspection contradicted "slots cannot alter RPC". | Only contracts can mark methods (`introspect`), never slots (C10; extensions §9.6). |

## Cross-document inconsistencies found and fixed

The reviewers found these inconsistencies:

1. design §7.1 versus integrations §7.1 on pending retries (INT-5);
2. M7 versus the contracts prose (INT-3);
3. per-occupant consent versus the contract (INT-4);
4. "order-insensitive" events versus the pull/push race (INT-7);
5. "plain application" fallback versus client-metadata refusal (INT-1);
6. §5.6 versus §5.5 (INT-11);
7. the downgrade rule claimed as shared but missing from extensions §4.3 (INT-19);
8. design §7.2 blurring the two "unavailable" cases (now split into (a) and (b));
9. `degraded` minting (SEC-17);
10. this review file was referenced but missing (now present).

## Residual risks, accepted and disclosed

- Up to 360 s of brokered access after revocation at a conforming integration, or 30 s for introspection-marked methods. None at all is enforceable against a non-conforming integration.
- A removed brokering key is trusted for up to one hour by integrations that cached the old key set.
- Worker egress to integration endpoints is screened but not connection-pinned (the same limitation as `client-id-metadata.v1`).
- Providers without amendment C1 may reject slot fragments outright. Apps then treat optional slots as unavailable.
- Occupant status codes drive `pre-dispatch` failover and are trusted claims.

## Required before any implementation claim

- Coordinator and human decision on amendments C1–C11.
- Brokering key provisioning.
- Conformance fixtures: an independent integration server, plus a provider without support.
- `npm test` for every slice, and browser verification for the Connections console.

This review changes no code, runtime or production gate.

## X3 implementation

Date: 2026-10-20. Subject: EXT-X3 in `packages/federation/integrations.mjs` (new) and `packages/federation/client-metadata.mjs` (extended), with tests in `tests/integrations-manifest.test.mjs`. One independent reviewer agent worked read-only, with proof-of-concept scripts, and looked at four areas: manifest spoofing, key-pinning bypass, SSRF and cache poisoning. This is an agent review, not human sign-off: reviewer ___ / date ___ / outcome ___.

**What was implemented:**

- **Manifest parsing.** `bindle_integration` is parsed only from client metadata, and only when the directory is constructed with `integrations:true`. Nothing in the runtime passes that flag yet. The manifest is limited to 8 KiB. Unknown members are ignored, and an invalid member is treated as absent.
- **URL binding.** Every URL must be on the `client_id` origin and path prefix. This includes `jwks_uri` and `redirect_uris`.
- **Rejected manifests.** A manifest is rejected when:
  - endpoints collide;
  - it is hosted on the issuer origin or on a configured shared host;
  - a public document carries confidential-only members (`events_endpoint`, `resources`, `occupant`). The document and the manifest disagree in that case.
- **Extension claims.** Claims go through `validateExtensions`. They are checked for syntax only unless trusted pins are supplied.
- **AMD-C7.** `private_key_jwt` with a path-prefixed `jwks_uri` is accepted only with integrations. Inline keys and secrets are always refused.
- **Key sets.** Key sets come through the same egress port, budgets, bounds and cache rules as client documents, cached per (`client_id`, `jwks_uri`). A set containing any private member is rejected. Thumbprints follow RFC 7638.
- **Change handling.** The §2.3 change table is implemented as a pure classifier.
- **Snapshots.** Snapshots must re-derive exactly from their client fields.

| ID | Sev | Finding | Status |
| --- | --- | --- | --- |
| X3-S1 | High | Key pinning could be bypassed. The §2.3 row "rotated, with at least one pinned key still present → adopted" let a takeover domain republish the archived public key next to its own key. The attacker key became pinned, and endpoint moves were adopted silently on the same refetch. | **Fixed.** A pinned key that disappears is unpinned immediately. An added key is only recorded in `pendingThumbprints`, and while any key is pending no endpoint move is adopted. `promotePendingKeys` pins a pending key only after a fresh assertion signed by a currently pinned key. **This deviates from integrations §2.3** and needs a provisional spec amendment recorded in DEVLOG. |
| X3-S2 | Medium | The Node egress adapter (`packages/apps/node-metadata-fetch.mjs`) turns every non-200 response into a generic error. As a result, 404/410 are never seen as definitive on Node, so a deleted client stays `unchanged`. That adapter also drops `Cache-Control`. | **Open.** The fix is outside X3's file ownership. The adapter should surface 404/410 as a typed `gone` result and forward `Cache-Control`. On Workers, 404/410 are detected. |
| X3-S3 | Low | A 200 document that failed validation was negative-cached as transient, so the connection never reached `manifest-invalid`. | **Fixed.** The failure is cached as definitive `invalid` and classified as `client_invalid`. |
| X3-S4 | Medium | Key sets had no stale fallback. A flood that exhausted the shared budgets blocked key-based authentication, and one transient error overwrote a good cached set. | **Fixed.** The last validated set is served for up to 1 h past its freshness when budgets or transport refuse a refetch. A transient failure never replaces a good set. |
| X3-S5 | Low | A static registration that declared `private_key_jwt` with an unusable `jwksUri`, or ran without integrations, was silently downgraded to a public client. | **Fixed.** Constructing the directory throws a `TypeError` instead (fail closed). |

**Reviewer notes, accepted:**

- `resolveKeys` now re-resolves the client by its ID and refuses a caller-supplied `jwksUri` that differs from the resolved one.
- `validClientSnapshot` callers must pass the provider's reserved hosts.

**Required before any implementation claim:**

- the runtime wiring (`integrations:true` in `packages/runtime/federation.mjs`, plus `validClientSnapshot(…,{integrations:true,reserved})` in `service.mjs` and `authorization-entries.mjs`), which belongs to X4 or the integrator;
- the X3-S2 adapter fix;
- token-endpoint enforcement that uses `pinnedKeys` only (LA2/X4);
- human sign-off on the S1 spec deviation.
