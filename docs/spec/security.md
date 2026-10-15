# Security model and release gates — v0 draft

Status: proposed. The runnable local prototype is not a production identity provider until these gates are implemented and reviewed.

## Trust boundaries

Self-hosting provides administrative custody, not automatic end-to-end encryption. A provider can read preferences and execute integrations; hosted 3sln administrators and infrastructure are trusted with plaintext under v0. Apps can retain granted data after access is revoked. Neither revocation nor deletion can retract copies already exported. Explain this in consent and resource deletion UI. Optional future encrypted storage must define independent key custody, recovery, metadata leakage and sharing semantics before making stronger claims.

External fragment/contract documents, app metadata, providers, and connectors are untrusted. URLs identify documents; HTTPS controls transport authenticity, not document safety or implementation correctness. Render metadata as text, never HTML; apply bounded schemas, depth/field count limits and safe widget allowlists. Freeze immutable revision URL plus content digest when accepting a fragment/contract. Mutable documents cannot expand granted fields/methods silently. A declared contract is capability metadata, not proof of honest behavior; connector onboarding checks and conformance suites are separate.

## Grants and resource authority

A grant binds subject, client, fragment revision, approved fields, resource IDs, contracts, method allowlists, constraints, expiry and revision. RPC authorization is the intersection of the live grant snapshot, current resource assignment, current account ownership, connector permissions and method constraints. Removing an assignment or revoking a grant blocks future calls immediately. Adding/replacing a resource, increasing methods or changing a fragment's meaning requires new consent. Resource identifiers MUST be opaque stable IDs, not caller-controlled network targets.

Sharing a configured fragment with another app requires separate consent. Show all existing recipients and say that assignment changes affect those apps. Each app has its own approved resource snapshot: assigning a new resource cannot grant it to every existing recipient. Offer explicit review/approval to expand each selected app. Required fragments may prevent app authorization when declined; optional fragments can be declined without configuration or disclosure of whether they were configured.

Resource values reveal only safe descriptions and IDs. Never return integration OAuth refresh tokens, provider credentials, internal host paths or connection secrets to apps. The broker makes external calls with server-held credentials and narrows authority to approved methods/prefixes/quotas. Sharing an object-storage resource MUST display read, write, overwrite and delete powers distinctly. A storage capability can expose an entire account if the connector is not prefix/container constrained; v0 should require a selected bucket/folder or clearly warn and independently approve broad access.

Special keys such as `@profile` resolve within the authenticated subject namespace and obey contract/method grants. Public profile claims must be deliberately published; authentication does not make all profile attributes public. Cross-subject or cross-workspace resource IDs never inherit permission. A future organization owner is a separate principal with membership/role checks and auditable delegated approval, not an email-domain shortcut.

RPC transaction IDs correlate responses and are not authority. Mutating idempotency keys bind subject, client, resource, contract, method and payload digest; a reuse with a changed payload fails. Bound journal retention and concurrency; document response replay lifetime. Method constraints must be checked before both first execution and replay: revocation cannot replay confidential stored results. Avoid returning internal exception strings. Enforce body size, batch count, operation duration, output size, concurrency and account/app quotas. Check resource ownership atomically where state changes could race.

## Network and connector safety

Server-side URL fetchers for discovery, schema resolution, WebDAV and remote resources are an SSRF boundary. Use a dedicated fetch service or egress controls, HTTPS allowlists where practical, DNS resolution checks and connection-time address validation. Deny loopback, link-local, private, multicast, reserved and cloud metadata addresses in IPv4/IPv6, including mapped forms. Revalidate every redirect and DNS result; v0 disables cross-origin redirects. Prevent DNS rebinding by connecting to validated addresses while preserving TLS hostname verification. Bound redirects, bytes, time, decompression and document recursion. Browser-only fetch avoids server SSRF but still leaks user IP and interest to metadata hosts; tell users when contacting a provider.

Do not permit arbitrary outbound RPC URLs or arbitrary contract code. Connector hosts are validated on connection and on each network request. WebDAV can legitimately use private servers, but allowing this requires a deliberate self-hosted deployment policy, distinct from public hosted 3sln. S3 credentials restrict bucket/prefix and methods; Google Drive OAuth scopes restrict access where feasible and disclose actual upstream scope. Connector OAuth callback state binds user, connector and initiating action; OAuth refresh secrets are encrypted with managed keys, never logged, and deleted on disconnect. Treat filenames, object keys, MIME types and provider responses as hostile. Do not serve active uploaded content from the auth origin.

## Application and browser controls

Production login/consent pages require restrictive CSP, `frame-ancestors 'none'`, HSTS after domain readiness, no third-party scripts, no-referrer policy on secret-bearing flows, CSRF protection, safe output encoding and a dedicated auth origin where practical. Avoid unsafe inline script and eval. SDK CORS cannot be wildcard with credentials; token endpoints allow registered app origins. Cookies and authorization tokens do not enter URLs, analytics, crash reports or logs. SDK assets should be versioned; app integrators control third-party script exposure and should prefer a backend token vault for high-value access.

Consent must identify the verified registered app origin and current provider; developer names are untrusted marketing. Prevent clickjacking, consent laundering, bundled optional choices, ambiguous resource summaries and deceptive success states. Authentication cancellation returns no preference content. Show final granted scope, partial/optional declines and revocation instructions. Permission prompts cannot promise downstream data deletion.

## Reference-host presentation and framing (3sln.me policy)

This section is 3sln.me reference-host and `@3sln/bindle` SDK policy, not Bindle interop. It was moved out of [auth](auth.md) and [protocol](protocol.md) on the user's 2026-10-14 direction that the Bindle specification say nothing about UI. Other providers may choose differently. Design: [adaptive app sign-in](../architecture/adaptive-app-sign-in.md).

- **Handle entry.** The `@3sln/bindle` sign-in element shows the framework brand, an editable handle and a visual `@3sln.me` suffix until `@` is typed; submission resolves the complete handle, and the element names the resolved provider host before navigating.
- **Framing.** Login, account management, consent, recovery and console pages send `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The only framed provider documents are the `/embed` island shell (with `/embed/assets/*`, `/embed/api/*` and `/embed/sw.js`) on a dedicated cookieless embed origin (never the console origin), with `frame-ancestors` set to the exact registered origins of the `client_id`, display-only authority, no cookies read, and every sensitive action escalated to a top-level popup or FedCM. Consent never happens in a frame.
- **Popups.** Authorization pages use `Cross-Origin-Opener-Policy: same-origin`, a static cookie-independent entry document, controls inert until visible and focused for 600 ms, and no default focus on approve. Completion is a top-level redirect to the registered redirect URI. The one exception is the single static entry document for popups opened by the embed frame, served without COOP so the opener survives; it refuses to run framed or sandboxed, shows no account state until an opener-key handshake succeeds, otherwise replaces itself with the `COOP: same-origin` authorization page, and posts only a key-bound claim and the code to the embed origin with an exact `targetOrigin`.
- **Islands** ([embed islands](../architecture/embed-islands.md)). Only allowlisted parts (`avatar`, `account-switcher`, `sign-in`) load; sizes are fixed or set by the embedder, never by state; islands send no state-dependent messages, sizes, focus or error signals; avatar responses are re-encoded rasters with `Cross-Origin-Resource-Policy: same-origin`, no CORS and `no-store`; the partitioned service worker never caches API responses; `/embed/api/*` requires an exact embed `Origin` on non-GET requests and on any GET that carries one.
- **FedCM cookie.** The only `SameSite=None` provider cookie is `__Secure-bindle_fedcm` (`Path=/fedcm/api/`, HttpOnly, not partitioned), holding session-class FedCM-purpose capabilities (rotated on every install, revoked with their sessions) rather than console session tokens; every `/fedcm/api/*` handler requires `Sec-Fetch-Dest: webidentity` before reading cookies, and FedCM login/continuation pages live outside that path and authenticate with the Strict cookies. Per-account login cookies stay `SameSite=Strict`.
- **Browser app credentials.** Persistent browser refresh tokens are issued only DPoP-bound. Embed credentials are delivered only to the embed frame, bound to its non-extractable key, never reach the app and never authorize RPC.

Verification before public beta: framing refusal on every non-embed route; embed `frame-ancestors` under allowed, unregistered and nested parents; FedCM endpoints refuse non-`webidentity` requests with identical timing; embed restore fails with another key, client or site; refresh reuse revokes the client session and its embed token; R1 one-click sign-in for an already signed-in user in Chromium (FedCM and popup), Firefox and WebKit. Islands: size, load-count, timing and focus probes identical across account states; popover close matrix; leader failover across tabs; avatar hotlinking refused from other origins and as a top-level or `<img>` load from the embedder.

## Audit and operational controls

Record account and grant changes, credential enrollment/removal, session transitions, connector lifecycle and denied privilege expansions. Audit events omit raw tokens, challenges, credentials, preference values, file contents and unnecessary email addresses. Users can inspect relevant events; production retention and deletion policies need explicit sign-off. Separate security telemetry from user exportable event history. Encrypt secrets/backups, test restore and key rotation, and document recovery from provider compromise. No production email, integration credentials or deployment changes are necessary for the local prototype.

## Required verification before a public beta

| Boundary | Minimum meaningful verification |
| --- | --- |
| Discovery | 404/410 vs transient error; malformed manifests; origin mismatch; redirects; unsupported schema; IDNA and userinfo input. |
| OAuth | PKCE downgrade rejection; reused/expired code; wrong state/issuer/client/redirect; open redirect attempts; no secret in URL/log; revoked grants with live tokens. |
| Email | Every lifecycle table row in auth.md; mail scanner GET no-op; atomic parallel claims; stale email/account revisions; browser-session mismatch; recovery-disabled account. |
| Passkeys | Wrong origin/RP/challenge/type/signature; replay; missing verification; account binding; enrollment/deletion authorization; synced counter handling. |
| Authorization | Cross-user/client/resource/method rejection; assignment removal immediate; expansion consent; immutable revision checks; optional fragment privacy; @profile restrictions. |
| RPC | Payload-changing idempotency collision; cross-principal tx IDs; revocation on replay; race between revoke and mutation; bounded resource exhaustion. |
| Network | Private/IPv6/metadata and redirect targets; DNS rebinding; compressed oversized content; hostile schema nesting; connectors returning unsafe paths/content. Client ID metadata documents (`client-id-metadata.v1`): verified Workers egress against private and rebinding targets before declaring the feature in production. |
| Consent | User tests accurately identifying recipients, field data, resource powers, shared-fragment consequences and revocation limits; keyboard/screen-reader flow and cancellation. |
| Operations | No secret leakage; connector disconnect; encrypted backup restore; rate-limit abuse and enumeration review; dependency/security review. |

Tests should exercise invariants against the actual persistence and broker paths, not merely duplicate validation functions. Consent comprehension needs human research before claiming the UI is intuitive. Independent security review is appropriate before storing public users' credentials or brokering production integrations.

## Sign-off checkpoints

- [ ] **S1 — Custody claims:** v0 server trust and revocation limitations accepted; no unsupported E2EE claims.
- [ ] **S2 — Grant expansion:** resource/method additions need per-app reconsent, including shared fragments.
- [ ] **S3 — Connector scope:** supported providers and permitted bucket/folder scope approved before production implementation.
- [ ] **S4 — Production gate:** auth/grant/race/SSRF verification, consent research and security review complete.
- [ ] **S5 — Operations:** retention, recovery, backup, key custody and incident plan approved.

Reviewer / date / notes: _pending; local drafting and implementation may proceed._

## Primary reference

[OAuth Security Best Current Practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) supplies the OAuth security baseline. The resource grant intersection, email lifecycle, SSRF and custody rules above are proposed Bindle/3sln design requirements, not claims that OAuth specifies those features.
