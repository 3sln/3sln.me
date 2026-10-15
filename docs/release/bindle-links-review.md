# Bindle links — independent security and interop review

Date: 2026-10-14. Scope: [links draft](../spec/links.md) and [decision note](../architecture/bindle-links.md), checked against contact-tokens, contact-delivery, security.md, `contact-endpoints.mjs`, `contact-tokens.mjs`, `developer-contact.mjs`, the signed-contact route in `http.mjs`, and the DEVLOG developer-contact entries. This was a design review by an independent agent reviewer. No code or tests were run, and nothing here is deployment evidence. Human protocol/security reviewer ___ / date ___ / outcome ___.

The reviewer confirmed that both documents reflect the user-approved decisions: the coordinator's provisional points 1–9, no anonymous delivery through any link, and response nonce with mint time, expiry and a bounded replay record.

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | High | The contact meta did not bind the `kinds`, `resource` and authorship fields that contact-delivery requires the signed URL to bind. Legacy `?sig=` links could never deliver under the D10 cutover. | **Fixed.** Meta adds `resource` and `kinds`, and authorship is implicitly identity-only (links §6). Legacy parents get a narrow `kinds:["one-off"]` carve-out with a host-assigned resource (§10). The contact-delivery paragraph is added to the reconciliation list. |
| 2 | High | The single developer parent would exhaust its lifetime caps of 100,000 messages and 1 GiB in about 11–13 days, and rotation keeps quotas. | **Fixed.** On conditional links, the signed `maxMessages`/`maxBytes` apply per principal per UTC day, with unsigned aggregate budgets for the parent (§7.1, D13). |
| 3 | High | The developer-contact replacement conflicts with the DEVLOG instruction of 2026-10-13 (daily requested grants; no per-message policy lookups or permanent links). | **Fixed (labelled).** The mapping is a contingent proposal. Daily grants stay the default until the user answers open question 1. |
| 4 | Medium | Caching the first decision of the day locks out users who pay mid-day; today's pointer is keyed by tier. | **Fixed.** Positive decisions are reused for the day, negative ones for at most 15 minutes behind rate limits. The claim about refresh counts is restated as "bounded". |
| 5 | Medium | One account could fill the per-parent replay cap of the shared developer link. | **Fixed.** Order of limits: rate limits, then a per-principal live-row cap, then a per-parent cap sized at least rate × 420 s. Signing is rate-limited, and no row is created before verification (§7.2). |
| 6 | Medium | Conditional evaluation for bearer-RPC admission was unstated. | **Fixed.** Bearer admission is a link delivery and evaluates policy, while minting is ungated (§6.1). |
| 7 | Medium | Data on non-inspection representations, HEAD and the profile representation was ambiguous, and "HTML conveys states" contradicted "HTML never evaluates". | **Fixed.** Data is evaluated only on a JSON-inspection GET and is `link_malformed` elsewhere. HTML is state-agnostic. The profile representation ignores eligibility (§7.2, §8). |
| 8 | Medium | The Worker's `URLSearchParams` `sig` detection differs from the raw parser (`%73ig`). | **Fixed.** The legacy marker is defined on the raw split, with one shared parser module for all routing (§2). |
| 9 | Medium | The cross-protocol argument cited the wrong inputs. The same account key also signs unprefixed conversation-v1 canonical JSON and three JWS types. | **Fixed.** A normative identity-key signature-domain table is added. `typ` is checked before any claim use, new non-JWS profiles must use a prefix, and the conversation-v1 form is a legacy exception (§7.2). |
| 10 | Medium | The handoff relied on a cross-site POST that will not carry SameSite cookies, and it is an open-redirect-shaped flow. | **Fixed.** The incoming POST only renders a confirmation. Signing requires a same-origin, CSRF-protected confirmation POST. Other rules: `frame-ancestors 'none'`, exactly one `bindle_meta` component, the registrable domain highlighted, and per-user rate limits. The same applies to same-host "Continue as" (§9). |
| 11 | Medium | A tenant on a multi-tenant host could define a policy that acts as an identity oracle; disclosure to the link owner was unstated. | **Fixed.** `policy` must come from an operator registry checked at issuance. GET results and principals are never disclosed to the link owner (§7.1, D7). |
| 12 | Medium | It was unclear whether policy-derived tier tags could drive owner rules. | **Fixed.** They are authorized delivery tags with provenance `policy` and valid `tagsAll` inputs (§7.5). |
| 13 | Low | Parser edge cases: an empty or missing `=`, `;`, `%zz`, the legacy length bound, and dot segments. | **Fixed** (§2, §3.2, §10). |
| 14 | Low | Comparing `iss` against the request origin depends on the Host header. | **Fixed.** Comparison is against the configured canonical origin, failing closed (§3.2). |
| 15 | Low | ECDSA malleability creates a second `md` for the same capability. | **Fixed.** `md` is computed over the signing input `segment1.segment2` (§4). |
| 16 | Low | Data-key scoping, the byte encoding of `H`, and purge-before-check were open. | **Fixed** (§7.2). |
| 17 | Low | Missing: query redaction for `bindle_data`; the effect of the CORS `*` inspection; a misdirected timing SHOULD. | **Fixed** (§8). |
| 18 | Low | Future foreign verification is an SSRF and amplification vector. | **Fixed.** The spec references the SSRF boundary and requires caching and per-issuer limits (§7.3). |
| 19 | Nit | Misplaced `nonce` step, app-message wording, decision ordering, a missing review link, data `iss`/`sub` naming, and a 503 nonce burn. | **Fixed.** |

## Sound as reviewed

- Exact-bytes JWS verification, strict I-JSON, no embedded or remote keys, and comparison against the stored exact header and claims (matching the current `endpointLive`).
- Meta/data confusion is blocked twice, by `typ` and by the `bindle` magic. Legacy↔new substitution fails.
- The `md` + `aud` binding, and invalidation of outstanding responses by challenge rotation.
- The validity arithmetic: `exp - iat` ≤ 300 s, ±60 s skew, a maximum span of 420 s, and row lifetime ≤ 420 s.
- Raw-alphabet parameter values, and rejection of duplicate, encoded or unknown `bindle_*` names.
- Same-host local verification; `audience_unverifiable` for foreign principals until the directory exists.
- The response is a pre-check only, with author proofs mandatory for every link delivery.
- The return target is built only from `meta.aud`; meta has no free-text display members.

## Remaining gates

- Contact-delivery v1 author proofs (L0) and the directory/identity-document profile are unimplemented.
- Contact-delivery sections superseded by D10/D12 await coordinator reconciliation.
- Open user questions are listed in the decision note.
- Fixed vectors and library conformance tests now exist (see the implementation review below); HTTP-level conformance (items 10, 11, 14) awaits L4.

## Implementation review (slices L1, L2, L3, L4b)

Date: 2026-10-14. An independent agent reviewer audited the library diff from a security angle. Diff: `packages/messaging/bindle-links.mjs`, `contact-endpoints.mjs`, `link-replay.mjs`, the intake functions in `tag-policy.mjs`, the `contact-tokens.mjs` `typ` allowlist, and `packages/identity/link-response.mjs`, together with their tests and `docs/architecture/artefacts/bindle-links.vectors.json`. The reviewer covered parser differentials, signature substitution, meta/data confusion, replay and state bounds, timing and oracles, and intake. Suspected issues were reproduced with throwaway scripts. Nothing is routed over HTTP, so this is not deployment evidence. Human reviewer ___ / date ___ / outcome ___.

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | Medium | `mint()` issued legacy anonymous `bindle-inbox+jwt` bearers for new-form (including conditional) links. Those bearers bypassed §6.1 author proofs, §7.5 evaluation and §7.1 per-principal quotas. Confirmed. | **Fixed.** `mint()` returns `not_acceptable` (406) for link-form parents. `live()` rejects any inbox bearer whose parent is link-form, which a test confirms with an owner-signed forged bearer. |
| 2 | Medium | `accounts.createContact` spreads the owner request body into `endpoints.create`, so `POST /api/contacts` could select `form:'link'`, `kinds` and `audience`. Confirmed at library level. | **Fixed.** `create()` is legacy-only and rejects `form`/`kinds`/`audience`/`tagLabels`. New-form issuance is a separate trusted method, `createLink()`, which no route calls yet. |
| 3 | Low | Senders could never select a registered `sys:*` optional tag: it was escaped before the allowlist comparison, while metadata advertised it. | **Fixed.** Exact intake IDs match first; only other text is escaped. Tested. |
| 4 | Low | `updateIntake` worked on revoked or expired parents. | **Fixed.** It now requires an active, unexpired parent. Reading intake stays allowed for the owner. |
| 5 | Low | `signLinkResponse` relied on the caller having run the §9 checks, and would sign for an unknown `type` or an HTTP `aud`. | **Fixed.** It enforces the supported `type` and an HTTPS `aud` itself. `http://localhost` is accepted only with explicit `allowInsecureLocalhost`. |
| 6 | Low | `parseLinkQuery` scanned unbounded input before any length check (about 2.3 s for 10 MB). The edge's 18,000-character cap made it unreachable. | **Fixed.** Input over 18,000 characters is rejected before splitting. |
| 7 | Low | The HTTP edge (`http.mjs`) still routes with `URLSearchParams` (`sig` and an unverified `sub`). It fails closed today. | **Fixed (links integration, 2026-10-14).** The edge takes every routing decision from `parseLinkQuery`; new-form links route on `parseLinkMeta(...).claims.sub` after an `aud` pre-check, legacy links on the `sig` payload, and the account object re-verifies. See [links integration review](links-integration-review.md). |
| 8 | Nit | `TextDecoder` stripped a leading BOM in names (stricter than WHATWG) and in JWS segments (an alternative encoding was accepted). | **Fixed.** `ignoreBOM` is set, so a BOM-prefixed name is an unrelated parameter as in WHATWG, and a BOM-prefixed segment fails strict JSON. |
| 9 | Nit | `kid` accepted C1 control characters. | **Fixed.** |
| 10 | Nit | The `strictJSON` depth limit was inconsistent for an empty innermost container. | Accepted: no effect, given the exact member sets. |
| 11 | Nit | `prepareLinkResponse` accepted an empty `#`. | **Fixed.** |
| 12 | Nit | The replay `parent` was not bound to the H `jti`; the key length could exceed Durable Object limits; the purge hook is unscheduled. | **Fixed/noted.** `parent` must be ASCII `[A-Za-z0-9._-]{1,64}`, and callers must pass `meta.claims.jti`. Scheduling `purge()` is L4 wiring; per-parent state is bounded by `parentCap`. |
| 13 | Nit | Label language matching was case-sensitive. | **Fixed** (BCP 47 case-insensitive). |

The reviewer judged these sound: the §2 grammar, including encoded and duplicated names, `;`, fragments and limits; the strict I-JSON/JWS profile; cross-form and same-key `typ` separation with exact stored input; md stability under ECDSA malleation; response verification ordering, with validity checked before lookup and foreign issuers unverifiable; the replay-record ordering, refuse-not-evict behavior, purge committing on refusal, and the `startAfter` boundary; intake isolation from md, claims and quotas, with revision CAS; and the metadata representation writing nothing and disclosing no auto tags or collections.
