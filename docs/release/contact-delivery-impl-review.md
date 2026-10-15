# Contact delivery L0: implementation security review

Review date: 2026-10-14. Scope: slice L0, identity-authored contact delivery. Files: `packages/messaging/contact-delivery.mjs`, `contact-delivery-wire.mjs`, `contact-delivery-service.mjs` and `tests/contact-delivery.test.mjs`.

An independent reviewer subagent ran a read-only audit and confirmed findings with scratch scripts. This is a review of local, unwired code. It does not certify HTTP routing (that is L4), deployment or interoperability. Human sign-off: reviewer ___ / date ___ / outcome ___.

## Confirmed absent

The reviewer found no anonymous path:

- A null or missing author is rejected, and so is a missing or null proof.
- A foreign issuer is refused before any lookup.
- Substituting the descriptor, `keyId` or `kid` fails, because the resolver's local descriptor must equal the claimed author exactly.
- Signature domains are separated.
- Base64url must be canonical, and duplicate keys and `__proto__` are rejected.

Performance looked safe. The reviewer found no ReDoS and no quadratic paths: a maximum-size RPC request parses in about 126 ms and a maximum-size multipart request in about 6 ms.

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | Medium | Owner rules bypassed the shared tag model: there was no `initialTags`, `ownerRules` or `applyRules`. As a result `addTags` was ignored and `tags` replaced the auto tags. | Fixed. The service now uses `initialTags` (provenance `intake` plus `intakeRevision`), `ownerRules` and `applyRules`, the same path as `MessagingService.receive`. Tested. |
| 2 | Medium | Hashing, content inspection, ECDSA verification and the cross-account identity lookup all ran before the credential was checked. That wasted work and gave a key-revocation oracle. | Fixed. A new `parents.verify(credential)` port runs first and returns a uniform 401. Tested: no resolve call for a bad credential. |
| 3 | Medium | A key revoked between author verification and commit was still admitted. | Fixed. The service calls `resolve` again inside the owner transaction and requires the same active signing key and an active account. Tested. L4 must keep `resolve` safe to call inside the transaction. |
| 4 | Medium | Conditional parents used lifetime parent quotas instead of per-author daily quotas (links §7.1). | Mitigated. Parents marked `delivery.conditional` are refused with `audience_unavailable` (503) until host policy and per-author daily counters exist (L5). |
| 5 | Low–Med | `localAuthorResolver` hard-coded `purpose:'signing'` and ignored account status. | Fixed. It now passes `purpose` through and requires `accountActive === true`. Tested. |
| 6 | Low | The merged auto and optional tags were not capped. | Fixed. `validTagIds` is applied to the merged list, which caps user tags at 32. Intake lists are checked with `validIntakeTagIds`, so no suspected-tag IDs get through. |
| 7 | Low | An operation ID can be squatted by a different author on a shared parent, which returns 409. | Fixed. The coordinator decided S2 on 2026-10-14: the receipt namespace is now `(owner, parent, author principal, operationId)`. Tested: another author's use of the same ID creates a separate delivery. |
| 8 | Low | "No controls" covered only C0 and DEL. | Fixed. Subject, keyId and capability now reject all `\p{Cc}`, U+2028/2029 and bidi overrides and isolates. This is stricter than the schema pattern. |
| 9 | Low | The fingerprint kept the genesis signature. | Fixed. `semanticEnvelope` now strips both the outer and the nested genesis signature. Tested. |
| 10 | Low | Some bootstrap fields were unbounded. | Partly fixed. `genesis.createdAt` must be no later than the outer `createdAt`. The `identityURI` and `identityDocument` origins must equal the issuer. Checking the recipient participant's descriptor and key against the local key is deferred to the conversation-v2 runtime, and `conversation-init` is refused (`kind_unsupported`) until then. |
| 11 | Low | Error codes did not match the spec. | Fixed: `proof:null` now returns `author_required`, and an intake failure returns `admission_unavailable`. Child-bearer `kinds` are documented as already intersected by `parents.live`. |
| 12 | Info | A UTF-8 BOM was stripped silently, the charset quote regex was loose, `createAuthoredEnvelope` signed the caller's objects, and the encoder did not validate headers. | Fixed: the BOM is now rejected, the regex is exact, the helper signs the validated clone, and the encoder validates `boundary` and MIME. Still open: part order is not enforced, `message` Content-Type must equal the MIME type exactly (charset parameters are refused), and a replay by a capability holder returns the stored receipt. |

## Spec defects reported to coordinator

- **S1.** `{payload, proof?}` still marks `proof` as optional.
- **S2.** The replay namespace ignores the author.
- **S3.** The rule for stripping a nested genesis signature needs an explicit statement and a vector.
- **S4.** The order of credential and author verification is not stated.
- **S5.** The per-author daily quotas in links §7.1 conflict with the statement that "descendants share parent quotas".
- **S6.** "Controls" is undefined.
- **S7.** It is not stated whether `proof:null` is malformed or `author_required`.
- **S8.** Multipart part order, BOM handling and MIME parameters are unspecified.
- **S9.** There is no cap on merged tags.
- **S10.** The relation between genesis time and outer time is unspecified, and so is the check on the recipient participant's descriptor.
- **S11.** There is no interface for the child-bearer kinds restriction.
- **S12.** The resolver contract (account lifecycle, key purpose) is not normative.
- **S13.** The local `identityURI`/`identityDocument`/`keyId` naming is not specified, and no route serves those URIs.
- **S14.** Which collection receives an envelope delivery is not specified (`grant.delivery.collection` is assumed).
- **S15.** Receipt payload is exact, so `intakeRevision` is recorded only in the stored receipt row and in message provenance.
- **S16.** The admission-key discovery profile is undefined.

Reconciliation (2026-10-14): S1–S16 are now written into `docs/spec/contact-delivery.md`, the wire note and the schema's control-character patterns, with every unimplemented item marked proposed. Coordinator decisions applied: S2 (author-scoped replay), S5 (per-author daily quotas govern on conditional links), S7, S13/S16 (dependencies on the directory profile, with provisional local naming) and S14 (no sender-visible collection; internal note only). Still open: a conversation-init vector for S3.
