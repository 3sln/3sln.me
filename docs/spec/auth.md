# Authentication and account lifecycle — v0 draft

Status: proposed implementation baseline. Normative MUST/SHOULD requirements apply to interoperable providers unless marked 3sln policy. Production readiness requires the security gates in `security.md`.

## Identity and discovery

A handle is a discovery hint, not the durable account key. The durable subject is a provider-issued HTTPS identity URL; clients key identities by issuer plus subject and MUST NOT merge them by email, display name, or handle. Email ownership and domain ownership can change.

The login custom element presents the framework brand, an editable handle, and a visual `@3sln.me` suffix until an `@` is entered. The suffix is presentation only; submission resolves the complete handle. Explain the chosen provider before navigating. Preserve local-part spelling; trim surrounding whitespace, normalize domain through IDNA, and reject control characters, URL credentials, paths, fragments, IP literals, and unsupported ports. v0 handles contain one separator and a nonempty local part and DNS host. Email fallback supports ordinary ASCII mailbox forms; unsupported email syntax receives a clear error, not guessed normalization. Never strip dots or plus-tags or lowercase local parts.

Discover `https://<host>/.well-known/bindle/manifest.json`. `https://<user>@<host>/...` is forbidden: the user segment is URL userinfo and is not account routing. The manifest describes a provider, not whether a particular person exists. Pass the complete account hint to the authorization endpoint as `identity` in the bounded authorization-request POST; its interpretation belongs to that provider. Manifest discovery MUST use HTTPS, bounded responses, schema validation, and an exact issuer origin match. v0 requires authorization, token, and RPC endpoints on that origin, disallows redirects during manifest fetch, and requires CORS for browser discovery. Advanced delegated hosting needs a future explicit trust profile.

Discovery outcomes:

| Outcome | Behavior |
| --- | --- |
| Valid supported manifest | Continue to named provider; provider handles unknown local account. |
| HTTP 404 or 410 from host | Offer clearly labeled email login through 3sln; user confirms sending mail. |
| DNS, TLS, timeout, CORS, 401, 403, 429, 5xx | Explain unavailable discovery and allow retry. Do not interpret as no provider. |
| Malformed JSON, invalid issuer, unsupported version, unsafe endpoint | Fail closed with actionable unsupported-provider message. |
| User intentionally chooses email login despite unavailable provider | Separate explicit 3sln login action; explain that it creates/uses a 3sln identity, distinct from any hosted identity. |

Whether a manifest exists is public provider metadata; the host-level discovery endpoint MUST NOT enumerate individual accounts. The current targeted authorization-request profile resolves an explicitly supplied handle and exposes availability and its public UUID locator; this is a documented product/privacy tradeoff with restrictive admission limits, not an enumeration-proof claim. A host manifest cannot prove that a submitted mailbox belongs to the user.

## Application authorization

Use OAuth authorization code flow with mandatory S256 PKCE. Public browser SDKs have no client secret. Providers register clients and exact HTTPS redirect URIs; localhost HTTP is allowed only in an explicit development configuration. A client ID alone is not evidence that an app is trusted. Display registered origin, app name, requested fragment versions, requested methods, purpose, required/optional status, and current recipients. Treat developer purpose text as unverified text.

The SDK generates cryptographically random `state`, a PKCE verifier, and a transaction record bound to issuer, client, redirect URI, requested fragments, and expiry. Use a top-level redirect by default. After callback, validate state and issuer, exchange the single-use short-lived code, and erase the transaction. Validate issuer identity at token exchange; never send a code or verifier to an endpoint obtained from callback input. The token response binds the subject, client, audience, grants, expiry, and granted fragment revisions. Authentication does not implicitly approve data access. If identity claims use an ID token, implement OIDC validation including nonce, audience, signature, expiry and issuer; do not invent an unsigned equivalent.

The manifest may advertise an iframe preference, but v0 SDKs treat it as an unsupported hint and use redirect. Providers MUST deny framing of login, account management and consent. Third-party cookie blocking, clickjacking, and passkey origin restrictions make embedded authentication unsuitable as the baseline. Future iframe support needs an explicit security profile. Popup completion, if later supported, sends only a completion reference through `postMessage` with exact origin and source checks; tokens never traverse wildcard messaging.

v0 browser access tokens expire after at most five minutes, stay in memory, and target only the provider RPC audience. No refresh token in localStorage. Provider login sessions use Secure, HttpOnly cookies with SameSite=Strict and CSRF checks on every mutation. Production browser apps needing persistent background access should use a backend session/token vault; broader token lifecycle is a subsequent profile. Log out closes the current provider session and client memory state; grant revocation is a separate explicit action. Revocation MUST block RPC immediately, regardless of unexpired tokens.

## 3sln email materialization

Sending email never creates an account. A request creates an expiring verification challenge, with purpose `login` or `link`, a hash of a random secret (at least 256 bits), intended email, initiating account for linking, initiating browser transaction, and allowed return target. Replies are generic regardless of account existence. Apply mailbox/IP/device/global rate limits without permanently locking a mailbox due to an attacker's requests. Only registered redirect targets are accepted; links cannot carry arbitrary return URLs.

Magic links are valid for ten minutes and single-use. GET renders a confirmation page and MUST NOT consume the token, create an account, associate an email, or authenticate: mail scanners prefetch links. Redemption is an explicit CSRF-protected POST. Token material must be removed from the address bar after delivery into a temporary server-bound interaction; use `Referrer-Policy: no-referrer`, no analytics or third-party assets, and scrub query strings from logs. Cross-device links can complete mailbox verification, but cannot approve the initiating app's authorization transaction without a fresh flow on the consuming browser. Show the app/provider context; prevent login CSRF by requiring explicit acceptance before replacing an existing session.

Account and email changes run in one database transaction with a unique canonical email ownership constraint and consumed-token compare-and-swap. Domain normalization alone defines canonical comparison; local-part semantics cannot safely be guessed. Repeated redemption returns an expired/used result; it cannot replay success or expose the account.

| Verified challenge and current browser state | Required outcome |
| --- | --- |
| Unclaimed email; no session | Explain new account, obtain explicit account creation confirmation, then create subject and associate email atomically. |
| Email belongs to A; no session | Explicit login confirmation authenticates A. No account creation. |
| Unclaimed email; already signed into A; login-purpose link | Offer attach to A or create a separate account. Neither happens automatically. Attaching requires recent A authentication and explicit confirmation; separate account switches session only after confirmation. |
| Email belongs to A; signed into A | Confirm same account; complete eligible login transaction. |
| Email belongs to B; signed into A | Explain different account; offer cancel or explicit switch to B. Never attach B's email to A, transfer it, or merge accounts. |
| Link-purpose challenge initiated by A; signed into A | Require recent authentication and explicit attach; atomically claim only if unclaimed or already A. |
| Link-purpose challenge initiated by A; no session | Require login to A before continuing; mailbox proof alone cannot authorize modification of A. |
| Link-purpose challenge initiated by A; signed into B | Require switching/authenticating A; do not rebind the challenge to B. |
| Email claimed by another account after link sent | Reject attachment, preserve ownership; offer separate login flow. |
| Expired, used, malformed or wrong-purpose token | Generic invalid-link screen and explicit resend; no mutation. |
| Token forwarded or opened on another device | Mailbox token is transferable proof; present full context, require explicit acceptance, and begin a fresh app authorization transaction on that device. |
| Email removed after challenge issued | Account/email revision check invalidates outstanding login challenges; fresh flow reflects current ownership. |
| Account deleted/suspended after challenge issued | Reject; do not resurrect or silently rematerialize the account. |
| Concurrent redemption/create/link | Exactly one atomic transition succeeds; uniqueness prevents duplicate ownership. |
| User changes mailbox input during flow | Issue a new challenge; never retarget an existing token. |

Account settings list verified emails, verification dates, primary contact, passkeys, sessions, and grants. Adding/removing emails requires recent authentication; new addresses must be verified. Notify existing contact channels of sensitive changes without leaking secrets. Removing an email invalidates its outstanding challenges. Never permit removal of the last usable recovery/login method without enrolling another. Mailbox proof is a recovery factor; administrators must not invent bypass merges. Account merge and identity migration are explicitly outside v0.

Email authentication proves current mailbox control, not legal identity or durable ownership. Recycled mailboxes can recover accounts still linked to them. Explain this when enabling email recovery; users may opt out of email recovery after enrolling sufficient alternative credentials. A passkey-protected account configured without email recovery MUST NOT be recovered through an email login link. A verified email may remain a contact address without being an authentication method. Hosted account records implement this with `emailLoginEnabled=false` by default. A recently authenticated owner explicitly enables or disables it with CSRF protection after verifying the mailbox; linking alone grants no login authority. Both link issuance and redemption check the current setting. Disabling removes outstanding login challenges so re-enabling cannot revive an old link, and changing the verified contact disables email login until the owner opts in again.

## Hosted recovery-file transaction

The original recovery file starts one pending recovery transaction and revokes old sessions and authenticators. Its hashed resume authority remains only while that account is recovering, so lost HTTP responses or an expired 30-minute setup token do not strand an account with no other recovery channel. A CAPTCHA/rate-limit guarded resume rotates the limited setup token without clearing completed replacement credentials. The user must still prove possession of a newly downloaded replacement file and confirm saving it before activation. Activation atomically removes the original file’s resume authority; it cannot replay completed recovery or issue a full session on its own. Setup and resume secrets never enter audit events or logs.

## Passkeys

Use maintained server-side WebAuthn verification, not handwritten cryptography. 3sln fixes its RP ID and permitted HTTPS origin list in deployment configuration; never derive them from request headers. Challenges are random, single-use, short-lived, and bound to purpose and session. Validate challenge, origin, RP ID hash, type, signature, user presence and required user verification. User handles are stable opaque bytes unrelated to email. Registration requires an authenticated recent session; login uses discoverable credentials or an explicit handle, with enumeration-safe errors. Store credential public keys, IDs, transports, backup flags, counters and a user-chosen label. Synced passkey counters can be nonmonotonic; evaluate anomalies without assuming every zero/nonincrease is a cloned authenticator.

Require user verification for account management and passkey login. Do not require attestation for ordinary individual users. Offer enrollment after materialization, additional passkeys, last-used metadata, and removal with recent authentication and recovery-method checks. Passkeys remain provider-scoped: a self-hosted provider uses its own RP ID. Lost-device recovery follows the user's configured factors; no automatic downgrade to email when disabled.

## Sign-off checkpoints

- [ ] **A1 — Federation identity:** issuer plus stable subject; host manifest; fail-closed discovery; email fallback is a separate identity.
- [ ] **A2 — Auth profile:** redirect code + PKCE; iframe unsupported in v0; registered clients and exact redirects.
- [ ] **A3 — Account linking:** no silent merges; linking requires current-account proof plus explicit mailbox consent.
- [ ] **A4 — Recovery:** email recovery is configurable and entails recycled-mailbox risk; users may disable it after alternative enrollment.
- [ ] **A5 — Session scope:** short browser tokens; persistent background access deferred to a backend profile.

Reviewer / date / notes: _pending; these review checkpoints do not block drafting or local implementation._

## Primary references

- [OAuth Security Best Current Practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html): PKCE, redirect validation, mix-up prevention and bearer-token handling.
- [WebFinger, RFC 7033](https://www.rfc-editor.org/rfc/rfc7033.html): host-based discovery of account identifiers; informs the discovery distinction without making Bindle a WebFinger implementation.
- [WebAuthn Level 2](https://www.w3.org/TR/webauthn-2/): RP/origin binding and registration/assertion verification. Production libraries may support newer versions while retaining this baseline.
