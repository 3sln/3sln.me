# Multiple local accounts in one browser

Status: provisional design, 2026-10-14. Implementation and security sign-off remain pending. This document describes provider-local session handling; it does not change Bindle authorization or require a particular client library.

## Existing behavior and proposed boundary

Today the provider writes one HttpOnly session cookie. Its opaque token contains an owner UUID used to route to that owner's repository, where the session hash, expiry and account status are checked. Successful login replaces the cookie. Sessions have independent server records and expire within 24 hours.

Keep those per-owner records. Add a bounded, authenticated-encrypted host cookie containing at most **five** session entries and one active entry. The vault is transport storage, not an authorization grant: every selected token still requires the existing owner-session check. A switch does not mint a session or extend its lifetime. Five is an initial product limit, not a protocol constant.

Production cookie: `__Host-bindle_accounts`, Secure, HttpOnly, Path=/, SameSite=Strict. The localhost development cookie has a distinct unprefixed name. Do not use Domain, Partitioned storage as a substitute for first-party login, browser storage, URLs, or readable JavaScript session tokens.

## Vault format and routing

Use a versioned AEAD envelope with a key ID, random nonce and authenticated ciphertext. Bind associated data to the exact configured provider origin, cookie name and format version. A dedicated operator-provisioned key/key ring is required; do not reuse onboarding, postback or app-signature keys. Authenticate before parsing inner JSON or selecting any owner actor. Bound encoded input to 3,800 bytes, ciphertext/plaintext size, entry count, token grammar, UUIDs, timestamps, unique owners, and active-entry membership. Reject duplicate cookie names and duplicate JSON fields. A malformed, oversized, unknown-key or unauthenticated vault yields an anonymous response without owner actor requests.

Inner entries contain only `{owner,token,expiresAt}`; the envelope also carries `activeOwner`, `issuedAt` and version. No credentials, pending tokens, email, names, badges or CSRF tokens belong in the vault. The token's embedded UUID must match its entry owner. Derive labels from authenticated account projection. Measure final worst-case cookie bytes in tests; never silently truncate entries. At the fifth account, adding a different account requires an explicit removal choice.

Ordinary account requests decrypt once, select `activeOwner`, and validate **one** owner session. Do not inspect all entries, global identity indexes or every owner's database on that hot path. Expired entries may be removed by their authenticated recorded expiry without actor access; unexpired revocations are discovered when that account is explicitly selected. No fallback to another owner on an invalid active session: show the chooser/sign-in state so a request never unexpectedly targets another identity.

A dedicated first-party chooser request may validate up to five entries to show current authenticated labels and unavailable entries. It is bounded, rate-limited and no-store; this cost is not part of every page/API request. Never expose raw tokens to the browser. Background validation cannot automatically change the active owner.

## Migration, concurrency and lifecycle

Accept a valid legacy single-session cookie only when no vault cookie is present. Validate the legacy session normally, then upgrade to a one-entry vault and expire the legacy cookie. A malformed vault must not fall back to legacy credentials. During a rolling deployment, prefer compatibility readers before enabling vault writers; reverting to an old reader would otherwise unexpectedly sign users out. Key rotation accepts a bounded previous-key window and rewrites using the current key without refreshing owner-session expiry.

Login adds/replaces the authenticated owner's entry, preserves other entries, and selects that owner. Pending setup does not add an entry until ordinary activation succeeds. Account recovery and device approval use the same final session installation path and cannot replace an unrelated account's entry without explicit intent.

A stateless cookie cannot merge concurrent stale responses reliably. Serialize account-management UI operations and broadcast only an opaque account-context-change event between first-party tabs. Every owner request carries an expected owner context (UUID is not a secret or grant); a mismatch with the authenticated active owner returns a context-conflict response before mutation. This prevents a background tab from silently writing to the newly selected account. Async results are fenced by owner, session/context generation, selected object and request ticket. Abort prepared postback handoffs and destroy message frames/private proposals when the context changes. A later phase may add a durable browser-vault revision if atomic multi-tab membership merging is required; do not claim the stateless draft solves last-response-wins cookie races.

## Switching and logout

Proposed owner endpoint: `POST /api/auth/accounts/switch {owner}`. Require exact provider Origin, current active session and its CSRF token, authenticated vault membership, and a fresh authoritative check of the target token. Verify vault authenticity before either actor lookup. Return only the selected public account, fresh selected-session CSRF projection and expiry; rewrite the active pointer. Target revoked/expired/suspended fails without selecting another account. If the active session has expired, switching needs an explicit chooser challenge bound to the authenticated vault and same-origin browser request, or reauthentication; do not bypass CSRF by accepting a bare target UUID.

`POST /api/auth/accounts/logout {owner}` removes and revokes exactly the selected owned entry. Logout of another saved account requires active-session CSRF plus its authenticated vault membership. `logout-all` explicitly validates/revokes the bounded set, reports partial server failures, and clears the local vault; it does not claim other devices were revoked. A separate existing account-level revoke-all-devices operation remains distinct. Logout never silently activates a remaining account. Cookie expiry is no later than the latest contained session expiry; per-entry expiry and revocation remain authoritative.

## OAuth and account choice

On the provider's first-party authorization screen, show which authenticated account would approve the request and offer an explicit account choice. A handle/subject-bound request cannot be reassigned by switching: either choose its exact locally authenticated identity or restart/cancel the request. Consent selects an owner request-locally without changing the console's global active owner. Choosing a different account invalidates any prepared consent state, resource choices and CSRF/context binding and requires a new review for that account. Bind reinspection and approval to the selected session epoch and resource/grant digest. Existing method/resource consent is per owner and client; another owner's consent never carries over.

Before explicit approval, the app receives neither account inventory, chosen identity, session presence nor notification recipient information. The provider may render the picker to its own user, but must not leak it through iframe messaging, timing-specific result payloads, preconsent redirects or app-readable storage. Registered callback origin, PKCE/state and existing exact method consent remain required.

## App-requested account flows

Apps may initiate a provider-hosted intent using existing authorization continuation mechanisms: `login`, `select-account`, `reauthenticate`, or `end-session`. Bind each request to its registered client, exact callback, expiring nonce/state, and PKCE whenever a grant is issued. An app cannot name an arbitrary callback, inspect the vault, choose an unseen owner or cause a provider cookie change through a GET or silent frame request.

SDK-local signout clears/revokes that app's own session and tokens. Ending a provider session requires explicit provider-owned user UI identifying the intended account and scope; it never automatically logs out all saved accounts or other devices. Its callback conveys only `completed` or `canceled`, with request state, without saved-account count or session-presence details.

App account switching starts a new authorization request and creates the chosen owner's client connection/grant after review. It does not retarget an existing handle-bound grant or consent. Reauthentication requires a fresh credential proof bound to the requested operation, chosen owner and session epoch; it preserves existing grant attenuation and notification disable generations. No successful reauthentication implicitly restores disabled methods or expands resource access.

## Notifications and deep links

Stored notification metadata must identify its actual recipient owner independently of the active browser account. With preview disabled, OS text stays generic; enabling previews may include the authenticated recipient's display label according to the user's privacy setting. Notification clicks open a fixed provider route with bounded message/owner identifiers. Those identifiers and advisory action locators are **routing hints, never authority**.

The foreground provider validates the vault before loading content. If the intended owner is inactive, ask to switch and execute the ordinary authenticated switch; if absent/revoked, ask to sign in as that owner. Do not fetch the message under whichever account is active, do not auto-submit a form, and do not mark it read until the selected owner's normal authorization succeeds. The service worker does not receive session tokens or a readable vault. Account labels shown by a notification cannot be trusted as a substitute for server owner checks.

## Third-party frames

Browsers may block provider cookies in app-origin frames even while the provider has first-party sessions. Storage access and partitioned cookies vary by browser and user policy; this design does not depend on either to recover the provider's complete account inventory. A frame unable to authenticate renders a neutral continuation action and opens a provider first-party popup or top-level redirect on explicit user interaction. No silent account probe, token relay to an app parent, wildcard postMessage or credential forwarding.

The popup/redirect uses a bounded expiring request continuation plus exact registered callback/state/PKCE, not session tokens in its URL. The app learns only the authorized result after approval. Popup blocked/closed cases offer a normal top-level link. Provider framing policy may require a dedicated narrowly embeddable authorization document; the current ordinary console's anti-framing protections are not weakened globally. Actual browser cookie blocking, opaque sandbox origin, popup behavior and opener/message source checks require browser tests before release.

## Required verification and open decisions

Tests must prove authentication rejection before actor routing; maximum cookie bytes; legacy migration and no malformed-vault downgrade; independent per-owner expiry/revocation; active-only hot-path actor count; CSRF and context-conflict switching; one/all logout partial failures; stale response and cross-tab mutation fences; handle-bound OAuth choice with no preconsent app disclosure; recipient notification routing; third-party blocked-cookie fallback without token relay. Include real Node and Worker adapters and multiple browser privacy modes.

Open decisions: exact AEAD/key provisioning format; explicit chooser challenge when the active session expires; session installation conflicts across tabs; maximum account limit after byte measurement; suspended-account restricted picker behavior; browser support matrix and dedicated embeddable surface. No runtime implementation, deployment or cross-browser conformance is claimed by this draft.

Reviewer: pending. Date: pending. Outcome: pending.
