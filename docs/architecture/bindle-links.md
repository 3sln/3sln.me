# Bindle link envelope and conditional contact links — decision note

Status: provisional design. No runtime or publication claim. The coordinator owns the DEVLOG entry. Architecture/security/product sign-off: reviewer ___ / date ___ / outcome ___.

Normative draft: [links](../spec/links.md). Independent review: [bindle-links-review](../release/bindle-links-review.md). Builds on [contact endpoints](../spec/contact-tokens.md), [contact delivery](../spec/contact-delivery.md), [delivery wire decision](contact-delivery-wire.md) and [conversation/identity design](conversation-contact-design.md).

## Decisions

| # | Decision | Relation to the provisional direction |
| --- | --- | --- |
| D1 | `bindle_meta` is a compact JWS whose payload is the metadata. Verification uses the exact received bytes. `aud` is the canonical origin plus path. Unrelated parameters are ignored and unsigned. Unknown, duplicated, case-varied or percent-encoded `bindle_*` names are rejected. Values are raw base64url with no decoding. | Adopted. Values are restricted to the raw alphabet, so the raw value and the decoded value are identical. That removes a class of parser-differential bugs. |
| D2 | One magic member, `bindle`, takes the value `"link-meta"` or `"link-data"`. A distinct JOSE `typ` (`bindle-link-meta+jwt` / `bindle-link-data+jwt`) is added for RFC 8725 explicit typing. A versioned `type` URI plus `v:1` complete the envelope. Conditional-ness is an `audience` member on the contact type, not a separate kind. | Adopted. Magic serves the user's "intent" purpose for tooling that only reads the payload. `typ` serves JOSE libraries. Both are cheap. |
| D3 | **Deviation (form):** `bindle_data` is also a compact JWS, signed by the audience identity key, rather than raw base64 JSON with an embedded detached signature. | The payload segment is still the base64url JSON carrying the magic member, and tooling reads it the same way as meta. Avoided: JCS canonicalization inside a URL value, nested base64 (about 1.8× growth), and a second parser. "Outside the signature" still holds, because data is never covered by the owner's signature. |
| D4 | The response binds `md` (SHA-256 of the meta signing input `segment1.segment2`, so that ECDSA signature malleation cannot create a second digest), `aud`, the audience principal `(iss, sub)`, `handle`, `kid`, a fresh 128-bit `nonce`, the mint time `iat` and the expiry `exp`, all under the audience signature. `exp - iat` is at most 300 s, with a clock-skew tolerance of 60 s. | Adopted, plus the user's nonce addition. `md` already binds the challenge, so the response does not echo it. |
| D5 | **Challenge retained**, with an honest role. It marks the link as conditional and gives a rotation primitive: the owner can reissue the same parent with a new challenge, which invalidates every outstanding completed URL while keeping quotas, receipts and tags. Cryptographic binding comes from `md`, not from the challenge. | Kept, as the user asked. Without rotation it adds no security beyond `md`. |
| D6 | The response is a GET pre-check only. Conditional delivery requires a contact-delivery v1 author proof, re-evaluated on the author principal. There is no anonymous branch and no legacy inbox bearer (406). **Small deviation:** a POST URL carrying `bindle_data` is rejected rather than ignored. | A rejection removes the ambiguity of which identity a request represents, and it keeps responses out of delivery logs. |
| D7 | Eligibility is host policy, evaluated at GET and at admission, including bearer-RPC admission. The rejection set is malformed, invalid, required, stale, unverifiable, unavailable, ineligible. A refusal reason may only be a policy-level statement. Meta has **no free-text display members**; there is only an optional `policy` URI, which must be in an operator-registered policy registry (no tenant-defined policies, which could act as identity oracles). GET results and principals are never disclosed to the link owner. | Adopted, and narrowed: removing free text removes the phishing surface in tooling. Owner pages render their own explanation, attributed to their origin. |
| D8 | Opener flow: on the same host, the host signs with its own identity key after an explicit click. On another host, a form POST goes to a proposed `link_response_endpoint`; the provider builds the return URL only from `meta.aud`. A Bindle app follows the same rules. | Adopted. Cross-host verification is blocked on the directory/identity-document profile, which is not implemented, and is stated as such in the spec. |
| D9 | Existing `?sig=` links verify unchanged, but per D10 their delivery becomes authored-only at an explicit cutover. New links use `bindle_meta`. One parent has one form. There is no re-signing into the other form, and both parameters together are rejected. | Least disruptive. The current `ContactEndpointService` already stores the exact header and claims per parent and compares them exactly, so the new `typ` and members slot into the same record. |
| D10 | **User decision:** no anonymous message through *any* link. Every link delivery carries a contact-delivery v1 author proof from a resolvable, verifiable identity, in both URL forms. App messages over app-connection grants are provider-admitted and are not links. This supersedes contact-delivery's explicit unverified one-off mode. | Approved by the user and relayed by the coordinator. Sections needing reconciliation are listed below. |
| D11 | **User decision:** responses carry a nonce. The owner host keeps a single-use **replay record** `H(jti, iss, sub, nonce)`, inserted atomically after verification and before policy. Rows expire at `exp + 60` (at most 420 s). Rate limits, then a per-principal live-row cap (so one account cannot fill the shared developer parent), then a per-parent cap sized at least the global rate × 420 s, bound the state; at the cap the host fails closed with `audience_unavailable` instead of evicting. No row is created before identity verification. Only the JSON inspection evaluation consumes a nonce, so previews cannot burn it. | The nonce makes "first use wins" enforceable. A replayer who reads a log *after* the opener's page has evaluated gets `audience_stale`. A replayer racing ahead still learns eligibility, so the residual risk below remains. Delivery never uses the record; author proofs stay mandatory. |
| D12 | Contact meta adds `resource` and `kinds` (identity-only authorship is implicit). That satisfies contact-delivery's rule that the signed URL binds profile, resource, kinds and authorship. Legacy `?sig=` parents get a narrow carve-out at cutover: `kinds:["one-off"]`, a host-assigned resource, and never `conversation-init`. | Reviewer finding 1. Without it, legacy links could not deliver at all after the D10 cutover. |
| D13 | On conditional links, the signed `maxMessages`/`maxBytes` apply **per author principal per UTC day**. Aggregate parent protection comes from the existing unsigned receipt, work and storage budgets. | Reviewer finding 2. 1,500 users × 5 msgs / 64 KiB per day is about 7,500 msgs and 96 MiB a day, which would exhaust 100,000-message / 1 GiB lifetime caps in roughly 11–13 days. Rotation keeps quotas, so it cannot help. This also makes per-user limits signed again. |
| D14 | **User decision (2026-10-14):** delivery tags are not link members. Automatic tags (formerly `requiredTags`) and the sender-selectable allowlist (formerly `optionalTags`, coordinator decision: also mutable) are the parent's revisioned **intake configuration**, updated by the owner at any time without reissuing the link, changing `md` or touching quotas. Deliveries record the applied intake revision. Legacy signed tags seed revision 0. A side-effect-free metadata representation (`Accept: application/vnd.bindle.contact-intake+json`) lists accepted optional tags with localized labels and never discloses auto tags (coordinator decision). Unknown optional tags are refused with `forbidden_tags` (links §6.2–§6.3). | Signed limits, `kinds` and `resource` stay in meta: they bound the capability. Tags confer no sender authority, so moving them out of the signature costs nothing; the owner's live config replaces creation-time signed intent. |

### Superseded contact-delivery provisions (reconciled 2026-10-14 in the spec and architecture documents below; marked superseded/proposed, not implemented)

- `docs/spec/contact-delivery.md`:
  - "One semantic envelope": the `author` row ("or explicit `null` only for an allowed unverified one-off").
  - "Authorship and signatures": the whole paragraph beginning "Anonymous legacy contact remains a valid existing feature…", including the `authorship:"unverified"` receipt branch and "A product requiring every sender…".
  - "Contact bearer RPC": the `authorship` claim (drop `"unverified"`; must be exactly `["identity"]`), together with "The unverified value applies only to one-off…".
  - The RPC example JSON (`"author": null`), with its caption "under a parent explicitly permitting unverified one-offs". The example needs an authored payload and proof.
  - "Replay, accounting, and receipts": the receipt `authorship` field (the only value is now `identity`).
  - "Current implementation versus this candidate": the Signatures row ("explicit unverified branch").
- `docs/architecture/contact-delivery-wire.md`:
  - "Recommendation and boundaries", paragraph 2 ("Anonymous one-offs remain possible only under an explicit unverified mode…").
  - "Implementation sequence" step 1 ("anonymous exception").
- `docs/architecture/artefacts/contact-delivery-v1.schema.json`: the `"unverified"` enum (around line 531) and the `"author": null` example (around line 681). The vectors file contains no null-author case.
- `docs/spec/contact-tokens.md`: "One URL, three explicit operations" (multipart POST and inbox-bearer delivery without authorship) and "Typed delivery design". Both describe implemented anonymous behavior that now needs a cutover note.
- `docs/spec/contact-delivery.md` "Contact bearer RPC", the paragraph "The signed URL protected claims and its immutable parent record MUST explicitly bind…". It should reference the links contact meta (`resource`, `kinds`, implicit identity authorship) and the legacy-parent carve-out (links §10). It should also note that bearer admission on a conditional parent evaluates host policy (links §6.1).
- DEVLOG 2026-10-14 "Contact POST and bearer-RPC delivery candidate" ("Anonymous one-offs are an explicit permitted mode…").

### Why not separate link kinds for conditional contact?

A conditional link has the same parent, scope, quotas, tags, receipts and delivery representations as an unconditional one. Only the admission predicate differs. A separate `type` would duplicate the scope definition, and processors could disagree on which tags or quotas apply. Future link kinds (invites, beaming) get their own `type` URIs because their authority actually differs.

### Why a signed response at all, when delivery needs an author proof anyway?

The response gives an opener's provider a way to show an eligible or ineligible state **before** the person composes anything. It also lets the owner page render a tailored composer, and both work without a session at the owner host. The response has no other role. If GET pre-checks are later judged unnecessary, the envelope still stands and the response can be dropped without changing delivery.

### Same-host session shortcut rejected

Verifying a same-host opener by owner cookie on the public capability route would mix session and capability credentials there, which contact-delivery forbids. Instead the host's authenticated owner operation produces an ordinary response or author proof, and the public route verifies it like any other. Interop stays uniform, and no cookie influences public capability responses.

## Developer contact (`ray@`) mapping

**Today** (`packages/runtime/developer-contact.mjs`). `POST /api/developer-contact` checks the tier with a forced billing refresh, and checks the active-population policy for free users. It then creates or reuses one parent grant per beneficiary, per tier, per UTC day on the developer account. The grant is limited to 5 messages, 64 KiB total and 16 KiB per message, with tier-specific required tags. The host stores pointer, `contact-name`, `contact-url` and grant rows, plus a cleanup pass of up to 50 rows. The DEVLOG-recorded user instruction is: eligibility is checked at issuance only, with no per-message policy lookups.

**Implemented locally (2026-10-14; open question 1 resolved).** Developer contact is one conditional link served by `GET /api/developer-contact`; the daily-grant text under "Today" above is historical and describes the superseded `POST` issuance. The DEVLOG instruction recorded on 2026-10-13 (users explicitly request a token granted for the current day; no ongoing billing checks, per-message policy lookups or permanent developer links) conflicts with a long-lived link that is evaluated at receipt; the user has since directed the move to a single conditional contact link. Design: one long-lived conditional parent, rotated at most every 366 days, with:

- intake auto tags `["contact:developer"]` (D14; not signed);
- intake optional tags `topic:*`;
- the MIME types `text/plain` and `text/html`;
- a policy URI, for example `https://3sln.example/policies/developer-contact/v1`;
- signed per-principal daily limits `maxMessages:5`, `maxBytes:65536` and `maxMessageBytes:16384` (D13).

The eligibility predicate is the same as today: a confirmed paid base entitlement, or any local 3sln account while the active population is below 1,500. Foreign principals are ineligible by policy, so the developer link **does not depend on the directory**. The `priority:*` tier tag becomes a policy-derived tag. It is an authorized delivery tag, so existing `tagsAll` owner rules keep matching, with provenance `policy`.

| Goes away | Added |
| --- | --- |
| Per-user daily parent grants, which also count toward the developer account's 1,000-grant cap. That cap is currently a real ceiling on concurrently eligible daily requesters (`contact-capacity`). | One immutable conditional parent and its URL. |
| Day/tier pointer rows, encrypted per-grant URL rows, the cleanup pass and the crash-resume reconciliation path. | A per-(parent, principal, UTC day) admission record: `{tier decision, decidedAt, messagesUsed, bytesUsed}`, with a TTL of 48 hours or more. It enforces the signed per-principal daily limits (D13). |
| An endpoint signature per request, and the `/api/developer-contact` issuance route. The UI can display the static link instead. | Response signing (same host) and verification at GET; author-proof verification at delivery. |
| | A bounded nonce replay record per parent: rows live at most 420 s, a cap applies per parent, and the host fails closed at the cap. |

### Change in semantics (needs the user's decision)

A conditional link naturally evaluates eligibility **at receipt**. The user previously decided against per-message billing and policy lookups, and against eligibility-loss revocation within the day. This design honors that decision as far as possible through D6 and the decision record. A positive decision is reused for the rest of its UTC day. A negative or lower-tier decision is reused for at most 15 minutes, behind per-principal rate limits. Today's pointer is keyed by tier, so someone who pays mid-day gets access at once, and the 15-minute limit avoids locking such a person out until midnight. Forced billing refreshes are therefore **bounded**: one per eligible user per day, plus a rate-limited number for ineligible users. They are not strictly one per day. What changes:

- (a) A user who lapses mid-day keeps access until the day ends, just as today.
- (b) The *first* message of each day is now evaluated at send time, not when a link was requested.
- (c) Population-threshold crossings take effect at the next decision for each principal.

The alternative, strict per-delivery evaluation, conflicts with the recorded instruction and is not proposed without approval.

### Residual risks

- Using a completed URL before the opener's page does (at most 420 s, single use because of the nonce record) discloses whether *that named audience* is eligible. Above 1,500 users, that indirectly reveals whether the person is paid. The mitigations are short windows, query redaction, `replaceState` scrubbing and no-referrer. The disclosure is otherwise inherent to the user's URL-attached design.
- Eligibility evaluation becomes reachable through an unauthenticated GET. Billing refreshes must therefore sit behind the daily decision cache, and GETs that carry data need IP and principal rate limits before any billing call.
- Conditional delivery depends on contact-delivery v1 author proofs, which are unimplemented. The developer link cannot move to this design until at least an identity-authored one-off on signed POST exists.
- Per-user limits are signed (D13), but they are enforced through one shared host-side record rather than separate grants, so a bug in that record affects every user of the link. The parent's aggregate exposure depends on the unsigned receipt and work budgets.

## QR and size budget

These figures were measured with the repository's `qrcode` package using realistic claims: a UUID `kid`, `sub`, `jti` and collection, the developer tags, ES256, and the `/users/ray/contact/<uuid>` path.

| URL | Characters | QR version (M / L) |
| --- | --- | --- |
| Legacy `?sig=` endpoint | 959 | 25 / 22 |
| Conditional `bindle_meta` | 1,215 | 29 / 25 |
| Completed, with `bindle_data` (including `nonce`) | 1,953 | 37 / 33 |

The completed URL is produced by software and not meant to be printed, so only the conditional link needs a QR code. Version 29-M is dense but scannable on modern phones at sensible sizes. An optional future compaction would replace the eight scope claims with a scope digest, since the host stores the exact claims anyway. That measured 859 characters (25-M → 24-M), but tooling would no longer see tags offline. It is not adopted for v1.

## Implementation slices (non-overlapping ownership)

| Slice | Owns | Depends on |
| --- | --- | --- |
| L0 Identity-authored one-off delivery (contact-delivery v1 subset) | strict envelope/proof code in `packages/messaging/contact-delivery*.mjs` (new), `tests/contact-delivery-*.test.mjs` | Existing candidate spec and vectors |
| L1 Envelope parser and vectors (pure; the single raw-query parser used by both the Worker edge and the account object) — **implemented (library, unrouted)** | `packages/messaging/bindle-links.mjs` (new), `tests/bindle-links.test.mjs`, `docs/architecture/artefacts/bindle-links.vectors.json` | None |
| L2 Contact meta issuance and inspection (including `resource`/`kinds`, policy-registry check, rotation, intake configuration and metadata representation per D14) — **implemented (library, unrouted)**; per-principal daily quota enforcement belongs to admission (L0/L5) | `packages/messaging/contact-endpoints.mjs`, `packages/messaging/tag-policy.mjs` (intake), `packages/messaging/contact-tokens.mjs` (`typ` allowlist only), `tests/contact-endpoints-links.test.mjs` | L1 |
| L3 Response signing and same-host verification — **implemented (library)**; resolver and signer wiring pending | `packages/identity/link-response.mjs` (new), keychain read access via `packages/runtime/accounts.mjs` method allowlist, `tests/link-response.test.mjs` | L1 |
| L4 HTTP adapter | `packages/runtime/http.mjs`: contact route grammar, states, the 406/400/403 mapping, the owner sign-response route, and the D10 cutover that retires anonymous legacy multipart and inbox-bearer delivery. Worker tests. | L0, L2, L3 |
| L4b Replay record — **implemented (library)**; instantiation per account object pending | nonce store in `packages/messaging/link-replay.mjs` (new), using the existing transactional metadata and bounded alarms; `tests/link-replay.test.mjs` | L1 |
| L5 Developer-contact policy | `packages/runtime/developer-contact.mjs`, daily decision record, issuance-route retirement, `tests/developer-contact*.test.mjs` | L0, L2, L3 |
| L6 Frontend | contact page states, disclosure, "Continue as" and scrub in `apps/web/src/ui/` contact components plus i18n catalogue keys, `tests/browser/` | L4 |

Cross-host `link_response_endpoint` and directory verification are a later slice, gated on the identity-document profile.

## Open questions for the user

1. **Resolved (user direction, 2026-10-14):** developer contact moves to one conditional link, checking eligibility at send time, reusing a positive decision for the day and a negative one for 15 minutes. It replaces per-day requested grants once implemented; implementation pending.
2. Should identities from other providers ever qualify for developer contact under the "everyone below 1,500" rule once the directory exists? Default: no, only local accounts.
3. Is it acceptable that someone who obtains a completed URL and uses it *before* the opener's page does (within 7 minutes at most) learns that named person's eligibility? The nonce record stops later replays.
4. **Resolved (2026-10-14):** anonymous delivery on existing `?sig=` links ends in the same change that ships authored delivery (L0), not before.
5. Keep the per-user 5 messages/64 KiB/16 KiB daily limits unchanged?
