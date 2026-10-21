# Device authorization (`device-authorization.v1`) — v0 draft

Status: **proposed, 2026-10-20.** Not routed and not declared by any provider. The 3sln.me reference host implements the provider side locally and unmounted (slices LA1 and LA2, behind `DEVICE_AUTHORIZATION_ENABLED`, default off); that is engine-tested local behavior, not production verification or conformance. It is a Bindle profile of the [OAuth 2.0 Device Authorization Grant, RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html), with [DPoP, RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) sender-constraint. Normative MUST/SHOULD language applies to providers that declare the feature and to clients that use it. This specification defines interoperability only. It defines no user interface. How a provider renders its verification page, collects the code, chooses accounts or words its warnings is provider policy (the 3sln.me design is [linked approval](../architecture/linked-approval.md)). The user direction, coordinator decisions and review outcomes are recorded in DEVLOG.md (2026-10-20). Independent review: [linked-approval-review](../release/linked-approval-review.md).

Builds on: [auth](auth.md) (application authorization, token lifetime and client sessions), [protocol §2](protocol.md#2-discovery-and-login) (manifest and feature declarations) and the [runtime profile](federation-implementation.md) (fragment requests and token response members).

## 1. Scope

A device-authorization client runs where a browser redirect back to the client is impractical: a command-line tool, a console application, a TV application or a headless service started by a person. The client obtains a short `user_code` and a `verification_uri`. The person opens that URI on any device where they can authenticate to the provider, approves the request, and the client polls the token endpoint until it receives tokens.

Out of scope:

- **Provider-local cross-device sign-in.** Extending a provider's own login session to another browser (for example a TV signing into the provider's console) does not involve a client and is provider policy. A provider MAY share its verification page and code namespace between that flow and this grant. It keeps session semantics: a derived login session SHOULD never outlive the session that approved it (§7 item 6).
- **Browser-based clients.** A client running in a web page uses the redirect, popup or FedCM transports in [auth](auth.md#presentation-transports-and-key-binding). Providers reject device-authorization requests sent by browsers (§4.1).
- **Confidential clients.** v0 defines only public clients (`token_endpoint_auth_method` `none`). Confidential device clients need a later profile.

## 2. Declaration

A provider supports this profile only when all of the following are present in its manifest. If any is missing or invalid, the client treats the feature as absent. The manifest processing rules in [protocol §2](protocol.md#2-discovery-and-login) apply.

| Member | Kind | Requirement |
| --- | --- | --- |
| `device_authorization_endpoint` | Flat, OAuth-registered (RFC 8628 §4) | HTTPS URL on the issuer origin. |
| `grant_types_supported` | Flat | Contains `urn:ietf:params:oauth:grant-type:device_code` and `refresh_token`. |
| `dpop_signing_alg_values_supported` | Flat | Nonempty. Contains `ES256`. |
| `revocation_endpoint` | Flat | Present (RFC 7009). |
| `features["device-authorization.v1"]` | Bindle feature | An object. v1 defines no members, and clients ignore unknown members. Its presence declares that the flat members above follow this profile. |

The flat members stay under their registered names so generic OAuth tooling can read them. The feature entry exists because this profile adds requirements that a plain RFC 8628 server does not meet: mandatory DPoP, the lifetime rule, fragment requests and browser refusal. A client MUST NOT use this profile with a provider that declares the flat members without the feature.

When the feature is absent, the provider offers no device sign-in to Bindle clients. A non-browser client then needs a registration for another flow, or it cannot sign in with that provider.

## 3. Client eligibility and identity

A client MUST be eligible for the device grant before a provider accepts its request:

- **Operator-registered client.** The registration lists the device grant. A registration that lists only the code grant is refused with `unauthorized_client`.
- **Client ID metadata document** (when `client-id-metadata.v1` is also declared). The [validation rules](federation-implementation.md#client-id-metadata-documents-client-id-metadatav1) change as follows when the document's `grant_types` contains `urn:ietf:params:oauth:grant-type:device_code`. `grant_types` ⊆ {`authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`}. `redirect_uris` MAY be absent or empty only if `authorization_code` is not listed. `token_endpoint_auth_method` is absent or `none`. A provider MAY refuse device clients resolved from metadata documents. It MAY also apply stricter verification to them, because their identifier is not operator-reviewed.

**The client is not authenticated by this grant.** Anyone can send a device-authorization request carrying any eligible public `client_id`. The verified client identifier, its registered origin or metadata host, tells the user which client's grants will be issued. It does not prove that the software holding the device code is that client. Providers MUST NOT describe the request as coming from the client in a way that implies authentication of the requester. Tokens issued by this grant carry the client's grants, so an attacker who starts the flow and persuades a user to approve it receives those grants (§10.1).

## 4. Device authorization request

### 4.1 Request

The client sends `POST` to `device_authorization_endpoint` with `Content-Type` exactly `application/x-www-form-urlencoded`. Providers reject any other media type. The body is at most 8 KiB.

| Parameter | Requirement | Meaning |
| --- | --- | --- |
| `client_id` | REQUIRED | Eligible client (§3). |
| `dpop_jkt` | REQUIRED | Base64url SHA-256 JWK thumbprint (RFC 7638) of the client's DPoP public key. It binds the device code and every token issued from it to that key. RFC 9449 §10 defines `dpop_jkt` only for authorization (and pushed authorization) requests, so its use at the device authorization endpoint is a Bindle extension with the same meaning. |
| `bindle_requests` | OPTIONAL | JSON text of the fragment request array defined in the [runtime profile](federation-implementation.md#http-flow) (`{fragment,required,purpose,fields,methods?}`), at most eight entries. Absent or `[]` requests an identity-only connection. |
| `identity` | OPTIONAL | A complete account handle the user typed into the client. It is a hint for the provider, never a binding. The provider interprets it as in [auth](auth.md#identity-and-discovery). |
| `ui_locales` | OPTIONAL | BCP 47 tags, space-separated, as in OIDC. |
| `scope` | MUST NOT be sent | Bindle access is requested as fragments. A provider rejects any `scope` value with `invalid_scope`. |

Browser refusal. A provider MUST reject, with `invalid_request`, any device-authorization or device-grant token request that carries an `Origin` header or any `Sec-Fetch-*` header, with one provisional Node transport exception: in the absence of `Origin`, a lone `Sec-Fetch-Mode: cors` and no other `Sec-Fetch-*` header MAY be accepted. This is the header emitted by Node/undici fetch; other mode values, an empty `Origin`, and every combination containing another fetch-metadata header remain refused. This exception is provisional pending independent review. It MUST NOT send CORS headers on either response. This keeps a web page from starting a flow from the victim's own browser and network (§10.1, §10.5). It goes beyond RFC 8628, which does not address browsers. It is effective because current browsers send `Origin` on cross-origin form posts, `fetch` in no-cors mode and `sendBeacon`, and the exact media-type rule excludes `<a ping>`.

### 4.2 Successful response

HTTP 200, `application/json`, `Cache-Control: no-store`:

| Member | Requirement |
| --- | --- |
| `device_code` | Opaque, at least 256 bits of entropy, single-use, stored by the provider only as a hash. |
| `user_code` | §4.3. |
| `verification_uri` | HTTPS URL on the issuer origin with no query or fragment. It MUST be short enough to type. |
| `verification_uri_complete` | OPTIONAL. HTTPS URL on the issuer origin that additionally carries the user code. The provider chooses whether to issue it and where the code goes. A fragment is RECOMMENDED so the code stays out of server logs. Its use is governed by §5.2. |
| `expires_in` | At most 600 seconds. |
| `interval` | At least 5 seconds. |

### 4.3 User code

- At least 2³⁴ equally likely values, generated with a CSPRNG.
- Case-insensitive. Characters are drawn from an alphabet of unambiguous ASCII letters and digits. Providers SHOULD use the RFC 8628 §6.1 base-20 consonant alphabet `BCDFGHJKLMNPQRSTVWXZ` with eight characters. Separators (`-`, spaces) are presentation and are ignored on entry.
- Unique among live codes at the provider, for both this grant and any provider-local flow sharing the namespace.
- Valid until `expires_in`, approval, denial or cancellation, whichever comes first, and never reissued.

Providers MUST bound verification attempts so that the expected number of live codes an attacker can discover by guessing within one code lifetime stays negligible. They do this per user agent or account, per network and globally (RFC 8628 §5.1). One factor alone does not satisfy this. This specification does not fix the limits.

### 4.4 Errors

The error response follows RFC 6749 §5.2, with `Cache-Control: no-store`. The codes are `invalid_request`, `invalid_client` (unknown client), `unauthorized_client` (not eligible for the device grant), `invalid_scope`, and `temporarily_unavailable` with a `Retry-After` header for rate limiting or capacity. Error responses MUST NOT reveal whether an `identity` hint names an existing account.

## 5. Verification and approval

This section fixes the security properties of the approval decision, not its presentation.

### 5.1 Approval requirements

1. **No approval on navigation.** A GET of `verification_uri` or `verification_uri_complete`, a prefetch, or a frame load MUST NOT approve, deny, consume or extend a request. It MUST NOT reveal the client, requested access or request state to an unauthenticated user agent.
2. **Authenticated owner.** Approval requires an authenticated provider session for the account receiving the grant, plus a fresh authentication with a user credential of that account, performed within that session (provider policy defines freshness and which credentials count; RECOMMENDED at most 5 minutes, passkey or password). The creation of a session or token by this grant or by a provider-local cross-device approval is never such an authentication, and neither is mailbox proof alone.
3. **Explicit account binding.** When the user agent holds several accounts, the account is an explicit choice. The approval record binds exactly that account's subject. An `identity` hint MAY preselect an account. It MUST NOT substitute for the choice, and it never redirects an approval to another account.
4. **Code binding.** The decision is bound to the request identified by the user code. The provider MUST establish that the user saw the code displayed by the device, either by having the user enter it or by having the user explicitly confirm it (§5.2).
5. **Consent.** The requested fragments receive the same consent as an authorization-code request for that client ([auth](auth.md#application-authorization), [runtime profile](federation-implementation.md#http-flow)). A previous approval for the same client MUST NOT approve a device request without a fresh explicit decision.
6. **At most once.** The transition from pending to approved, denied or cancelled happens at most once (atomic compare-and-swap). Denial is always available and ends the request.
7. **No unsolicited prompts.** A provider MUST NOT push approval prompts to a user for a pending request it did not receive from that user's own code entry. That would recreate push-fatigue attacks. It SHOULD notify the account's other channels after an approval.

### 5.2 `verification_uri_complete`

A provider that issues `verification_uri_complete` MAY prefill the code from it (but see §10.6). With a prefilled code, the provider MUST still obtain the explicit decision in §5.1, and the confirmation in §5.1(4) MUST be a distinct act that names the code. The provider MUST require the user to type the code instead whenever it cannot establish that the approval is happening alongside the requesting device. The provider decides what establishes that. Clients MUST display `user_code` and `verification_uri` even when they also show or open the complete URI, so the user can type the code. A client MAY open `verification_uri_complete` in the system browser. It MUST NOT open it in an embedded web view it controls (RFC 8252 §8.12).

## 6. Token request (polling)

### 6.1 Request

The client sends `POST` to `token_endpoint` (form-encoded) with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code` and `client_id`. A `DPoP` header is REQUIRED. Its proof key thumbprint MUST equal the request's `dpop_jkt`. The provider MUST support DPoP server nonces (RFC 9449 §8) at the token endpoint and MAY require them. Proof replay protection SHOULD rest on time-windowed server nonces plus a short-lived `jti` cache. The cache need not be durable: a durable `jti` record per poll would add a storage write to every poll (§10.5).

### 6.2 Responses

| Condition | Response |
| --- | --- |
| Missing, invalid or mismatched DPoP proof | `invalid_dpop_proof` (or `use_dpop_nonce`). The request state does not change, nothing is consumed, and the attempt counts toward the polling limits. |
| `client_id` differs from the request's | `invalid_grant`. The request state does not change. |
| Pending | `authorization_pending` |
| Polled sooner than the current interval | `slow_down`. The client adds 5 seconds to its interval for all later polls (RFC 8628 §3.5). The provider MAY include an `interval` member with the new value. |
| Denied, or cancelled by the client | `access_denied` |
| Expired before approval | `expired_token` |
| Already redeemed, unknown or malformed | `invalid_grant` |
| Approved, but the approving session is no longer live | `access_denied`. The request is closed. |
| Approved, and the approving session is still live | HTTP 200 token response (§6.3). The device code is consumed in the same atomic step. |

The error codes and HTTP 400 status follow RFC 8628 §3.5. **Pre-consent privacy:** until the request is approved or denied, every response MUST be independent of whether the code was looked up, which account was selected or whether consent is in progress. Responses are byte-identical apart from `interval`.

**Single use.** At most one token response is ever issued per device code. A lost success response is not replayed. The client starts a new flow. This gives up retry convenience so that a stolen or logged device code can never be redeemed a second time. The DPoP binding additionally makes a stolen device code useless without the client's private key.

**Polling limits.** A provider SHOULD enforce the interval per device code and MUST bound polling per network and globally. Interval state need not be durable: a provider MAY keep it in a non-durable limiter, and a reset limiter only lets the client poll at the base interval again.

### 6.3 Token response

The token response is the same as the authorization-code exchange response for that client ([runtime profile](federation-implementation.md#http-flow), [auth](auth.md#token-lifetime-and-client-sessions)). It includes `access_token`, `token_type` (MUST be `DPoP` for this grant, so access tokens are bound to `dpop_jkt` like the refresh token), `expires_in`, `issuer`, `subject`, `client_id`, `audience`, `grants`, `granted_fragments`, and a DPoP-bound `refresh_token` with `refresh_expires_in` and `refresh_idle_expires_in`. `expires_in` follows the access-token limits in §7, and `refresh_expires_in` and `refresh_idle_expires_in` follow its refresh rules. A client that sent an `identity` hint SHOULD abort when the returned `subject` does not match it. A client that sent no hint SHOULD show the user the signed-in account and ask for confirmation before using the tokens, so an approval made from the wrong account (or by an attacker's account, §10.3) is noticed.

## 7. Credential lifetime

Revised 2026-10-20 (user decision, provisional), superseding the earlier `E = min(S, t₀ + P, t₀ + U)` cap for credentials issued by this grant. The credentials from one successful device grant form one **client session** ([auth](auth.md#token-lifetime-and-client-sessions)). Let `t₀` be the approval time and `U` a shorter duration the user chose at approval, if the provider offered one and the user chose it.

1. **No absolute lifetime is required.** The client session ends by revocation (§8), refresh-token reuse detection, a failed live check (items 4 and 5) or the idle limit (item 2). If the user chose `U`, the client session's absolute expiry is `t₀ + U` and refresh rotation never extends it. A provider MAY impose its own absolute cap, and then MUST state it in `refresh_expires_in`.
2. **Idle limit.** A refresh token not used within the provider's idle limit is invalid. The idle limit restarts at every successful refresh and never extends past an absolute expiry from item 1. RECOMMENDED: 180 days; providers MAY configure it.
3. **Access tokens** are DPoP-bound (§6.3) and live at most 60 minutes, never past an absolute expiry from item 1. Providers MAY issue shorter ones.
4. **Live lineage.** The client session belongs to the grant, not to the approving login session, so the natural expiry of that session does not end it. If the approving login session (or any session in its approval chain, item 6) is ended explicitly — sign-out, revocation, eviction by a session-count limit, credential removal, recovery, account suspension or deletion — the provider MUST revoke the client session. The provider MUST check this lineage on every refresh and on every resource request, failing closed, so revocation takes effect immediately; a refresh then fails with `invalid_grant` and resource requests are refused.
5. Every refresh and every resource request also performs the live checks in [auth](auth.md#token-lifetime-and-client-sessions): grants, client connection, account status. Renewal intersects only the grants approved for this request.
6. **Chains.** A session issued by a cross-device approval can approve only after a fresh credential authentication within it (§5.1(2)). Revocation under item 4 applies transitively: ending any session in a chain revokes everything derived from it. Provider-local session extension (§1, out of scope) keeps session semantics: a derived login session never outlives the session that approved it.
7. **Approval.** The user's one involvement is the approval itself, with its fresh credential authentication (§5.1(2)). A provider SHOULD NOT require periodic reapproval as a substitute for the checks in items 4 and 5.

`refresh_expires_in` is the lifetime of the issued refresh token: without an absolute expiry it equals `refresh_idle_expires_in`, and each rotation renews it. Clients MUST NOT assume a minimum lifetime and MUST NOT treat `refresh_expires_in` as a deadline that can only move earlier. When refresh fails with `invalid_grant`, the client starts a new device flow.

Rationale. An unattended client should keep working while it is in use and the user has not revoked it; involving the user again only after long disuse keeps device-code phishing from being re-armed by routine reapproval prompts. Immediate revocation rests on the live checks at every refresh and resource request, not on short credentials.

## 8. Sender constraint and revocation

- The device code, the refresh token and the access token are bound to `dpop_jkt`. Every refresh carries a DPoP proof for that key. A refresh without one is refused and does not rotate.
- A client SHOULD keep its DPoP private key non-exportable (an OS key store or hardware-backed key) and SHOULD store the refresh token only alongside it.
- RFC 7009 revocation of the refresh token revokes the client session. The cascades in [auth](auth.md#token-lifetime-and-client-sessions) apply: revoking the client connection, revoking the client session, or detecting refresh reuse.
- The provider MUST let the account owner list and revoke client sessions created by this grant, individually. How it presents them is provider policy.

## 9. Interaction with other features

- `authorization-entry.v1` is not required. A provider MAY implement approval internally with its authorization entry, but this profile exposes no entry identifier to the client.
- `client-id-metadata.v1`: see §3.
- Components profiles: this grant never issues component credentials.

## 10. Security considerations

These supplement RFC 8628 §5, RFC 9700 and [security](security.md).

### 10.1 Remote phishing (device-code phishing)

An attacker starts a real flow, then persuades a victim to approve its code, for example with a message that says "enter this code to verify your account". Attackers can automate this to issue a fresh code the moment a victim opens a lure page. The code binding (§5.1(4)) cannot tell an attacker's code from the victim's own, because the victim types or confirms whatever the lure shows. The following reduce the risk, but no protocol measure removes it:

- Approval requires a fresh credential authentication and an explicit, account-bound decision (§5.1).
- Providers SHOULD show trustworthy context, such as the verified client identifier. Approximate network location is weak context: an attacker can choose a VPN exit near the victim, so a location shown as reassurance can mislead, and it leaks to anyone who guesses a code. A mismatch signal (for example a different country than the approving browser) is more useful than a displayed location. Providers MUST NOT show requester-supplied free text, including client-supplied names in notifications, as if it were verified.
- An `identity` hint is attacker-controlled. Providers MUST NOT present it as evidence that the request is legitimate.
- Short codes and expiry (§4.2), and no unsolicited prompts (§5.1(7)).
- Browser refusal (§4.1) keeps a lure page from starting the flow from the victim's own network, which would defeat network-match signals.
- Post-approval notification, optional user-chosen shorter lifetimes, the idle limit and live checks (§7), and individual revocation (§8) limit the damage and help detection. Because a client session has no absolute lifetime by default, a phished approval lasts until it is noticed and revoked or left idle; providers SHOULD make app connections easy to review and revoke.
- Providers SHOULD restrict which fragments each client may request through this grant, and MAY require extra confirmation for sensitive fragments. Well-known registered clients make the most convincing lures.

### 10.2 Client impersonation

See §3. A trusted public `client_id` gives no assurance about the requester. Providers SHOULD treat clients resolved from unreviewed metadata documents as higher risk.

### 10.3 User-code guessing

A guessed live code lets an attacker see what another user's device requested. It also lets the attacker approve that request with the attacker's own account (a login-CSRF onto the victim's device) or deny it. §4.3 requires entropy and multi-dimensional attempt bounds. Providers SHOULD require an authenticated session before resolving a code, which charges guesses to accounts as well as networks. Network limits SHOULD be keyed by prefix (IPv4 /24, IPv6 /64 or wider), not by address. Account and network limits do not bound a botnet with many accounts, so providers MUST also keep a hard global budget of failed resolutions that scales with the number of live codes (expected discoveries = failures × live codes ÷ code space), with a stronger challenge or refusal once it is exhausted. Clients SHOULD confirm the signed-in subject (§6.3). Providers SHOULD store user codes only as keyed hashes (HMAC with a server secret): an unkeyed hash of a 34-bit code is brute-forced offline.

### 10.4 Device-code leakage and replay

The device code is single-use, hashed at rest and DPoP-bound (§6.2). It never appears in a verification URI.

### 10.5 Polling and creation flooding

Request creation is bounded per network prefix, per client and globally, both as a rate and as a number of live requests. Global and per-client caps can themselves be used to deny service to legitimate users, so providers SHOULD cap live requests per prefix and admit prefixes without a live request first when under pressure. Expired or cancelled requests that issued nothing SHOULD be deleted promptly. Polling is bounded per device code (interval), per network and globally (§6.2). A provider SHOULD reject malformed device codes, and apply network limits, before any storage read or signature verification. It SHOULD avoid a durable write for each poll that changes nothing.

### 10.6 QR codes

A QR code that encodes `verification_uri_complete` can be replaced by an attacker's code, for example a sticker on a shared screen. The approval then targets the attacker's request. Requiring the user to type the code shown by the device (§5.2) defeats a substitution that does not also control the device's own display. Prefill-and-confirm does not: users tick a confirmation without comparing. A provider that prefills from a QR-borne URI therefore loses this protection, even when network signals match, because an attacker on the same network (hotel, office, carrier-grade NAT, shared VPN exit) passes them. A QR code also hides the destination URL, so users may land on a lookalike site. Phishing-resistant credentials such as passkeys protect the account credential in that case. They do not protect the approval decision.

## 11. Sign-off checkpoints

| Checkpoint | Reviewer / date / outcome |
| --- | --- |
| DA1: Declaration (flat RFC 8628 members plus the feature entry), browser refusal, mandatory DPoP | Pending |
| DA2: Approval requirements, including fresh non-derived authentication and explicit account binding | Pending |
| DA3: Lifetime rule (revised 2026-10-20: no absolute lifetime by default, idle limit, ≤ 60 min DPoP access tokens, live lineage and grant checks on every refresh and resource request) | Pending (user decision recorded provisionally in DEVLOG.md; no reviewer sign-off) |
| DA4: Single use with no success replay; pre-consent privacy of poll responses | Pending |
| DA5: Metadata-document delta for device-only clients | Pending |

Reviewer fields record actual outcomes when available. No approval is fabricated. These checkpoints do not block drafting or local implementation, and production declaration follows the gates in [security](security.md) and DEVLOG.md.

## References

- [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html): OAuth 2.0 Device Authorization Grant.
- [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html): DPoP, including `dpop_jkt` (§10) and server nonces (§8).
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html): OAuth 2.0 Security Best Current Practice.
- [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html): OAuth 2.0 for Native Apps (system browser, no embedded user agents).
- [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html): Token Revocation.
