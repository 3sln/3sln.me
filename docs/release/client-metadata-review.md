# Client ID metadata documents (`client-id-metadata.v1`): security review

Date: 2026-10-14. Reviewer: one independent AI review agent (SSRF, phishing and OAuth lens), read-only, with probes run locally. Implementer: client-metadata agent. Human reviewer: ___ Date: ___ Outcome: ___. Provisional until signed in DEVLOG.md.

Scope: `packages/federation/client-metadata.mjs`, `node-client-metadata-fetch.mjs`, `apps/worker/client-metadata-fetch.mjs`, the federation service, controller, entries and HTTP changes, the routing authority and entry facade, admin `blockClient`, Worker and Node composition, and the consent, entry and admin UI. The specification is protocol §2 and [wire profile](../spec/federation-implementation.md#client-id-metadata-documents-client-id-metadatav1).

The reviewer found no High-severity issue.

## Findings and resolution

| # | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | Medium | A block matched one exact host, so attackers could sidestep it with wildcard subdomains. | **Fixed.** A block now applies to the host and every parent domain down to two labels (`hostAndParents`). The admin UI and docs say that subdomains are covered. Tested. |
| 2 | Medium | Fetch budgets could be exhausted. The per-host key let path or subdomain churn drain a victim, and a global cold-miss flood refused working clients. | **Partly fixed.** Fetch and entry budgets are now keyed on the client site (last two labels), so subdomain churn shares one budget. A known-good document is served for at most one hour past its freshness when budgets refuse a refetch. Tested. **Residual:** the global budget is still shared, and a flood of distinct IDs can evict the 512-entry LRU. Unauthenticated callers are bounded by the existing per-address HTTP and entry budgets. Recorded as a limitation. |
| 3 | Medium | The provider's own issuer and embed hosts were accepted as client hosts. | **Fixed.** `reservedHosts` (APP_ORIGIN and EMBED_ORIGIN hosts and their subdomains) are never metadata clients. Tested. |
| 4 | Low | The Node egress adapter drops `Cache-Control`, so Node caches every document for 1 h. | **Accepted and documented.** The adapter belongs to `packages/apps` (outside this slice). The 1 h default is within the 24 h bound. |
| 5 | Low | The server counts `client_name` length in code points but the page counted UTF-16 units, so long emoji names broke the entry page. | **Fixed.** The page now counts code points. Tested. |
| 6 | Low | The set of rejected `client_name` characters was incomplete (U+061C, soft hyphen, U+180E, interlinear annotation, variation selectors, tags). | **Fixed.** Those ranges are now rejected. Tested. |
| 7 | Low | A live access token used without an Origin still works for up to 5 min after a block or after disabling the feature. | **Accepted and documented.** Code exchange, refresh and cross-origin calls are refused immediately. A per-RPC client check would add an owner-shard round trip. |
| 8 | Low | `persistClient` updated the in-memory client map inside the transaction. | **Fixed.** The map is updated only after the approval transaction commits. |
| 9 | Low | Without the admin binding, the Worker ran with no block list. | **Fixed.** The Worker keeps the feature off when `ADMIN_AUTHORITY` is absent (fails closed). |
| I | Info | Snapshot fields in the docs omitted `clientUri` and `logoUri`. RPC error responses carry CORS headers before the client check. `publicRouting:true` is not tied to the wrangler flag by a test. | Docs fixed. The CORS behaviour predates this slice and leaks only error codes. The wrangler flag is present in both configurations; a configuration test remains open. |

## Areas the reviewer found sound (verified by probes where marked)

- URL syntax (verified): encoded dot segments, `%2f`, numeric or short IP forms, an explicit `:443`, userinfo, query and fragment are all refused, and only punycode hosts are accepted.
- Node DNS-pinned egress.
- Workers strictly-public routing with DoH screening, which is screening, not connection pinning.
- Bounded size and deadline.
- Exact cache keys, and no caching of failures as documents.
- Budgets charged before any egress.
- The snapshot trust boundary: no caller-supplied snapshot is accepted, and stores re-validate.
- Static-registration precedence.
- Exact same-origin redirect URIs.
- Rejection of confidential clients.
- Token and refresh behaviour.
- Consent and entry pages label the app by its verified host. The claimed name is shown only as isolated text marked unverified, and logos are never rendered.
- The bound on owner storage.
- Admin authority, step-up and audit for blocks.
- The manifest declares the feature only when it is enabled and has an egress port.

## Remaining gates

These gates remain before production declaration:

- Verify the Workers egress against private and rebinding targets ([security](../spec/security.md#required-verification-before-a-public-beta)).
- Run consent comprehension research for unreviewed-app labels.
- Get human sign-off.

`CLIENT_METADATA_ENABLED` stays `false` in the checked-in Worker configuration.
