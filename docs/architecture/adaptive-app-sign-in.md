# Adaptive app sign-in: frame-initiated popup and FedCM with key-bound embed credentials

Status: **provisional design, 2026-10-14, revision 2.** Revised after review round 1 and the user's AS-R1 decision (§23). **Islands refinement:** [embed islands](embed-islands.md) splits "the frame" into per-part islands (`avatar`, `account-switcher`, `sign-in`) sharing one embed origin, key store and partition; wherever this document says "the frame", read "the islands", with the per-part rules there governing shell, channel, leader election and parts. This document keeps keys, restore, the popup bridge and sandboxing. Nothing here is implemented, routed or production-verified. It is a 3sln reference-host and `@3sln/bindle` SDK design. The only Bindle interop it adds is listed in §16 and written into [auth](../spec/auth.md#presentation-transports-and-key-binding) and [protocol](../spec/protocol.md#2-discovery-and-login) as *proposed*. The coordinator records decisions in DEVLOG.md. Independent reviews (rounds 1 and 2): [adaptive-app-sign-in-review](../release/adaptive-app-sign-in-review.md).

Architecture/security/product sign-off: reviewer ___ / date ___ / outcome ___.

Builds on: [auth](../spec/auth.md), [protocol](../spec/protocol.md), [security](../spec/security.md), [runtime profile](../spec/federation-implementation.md), [embeddable elements](embeddable-elements.md) and its [review](../release/embeddable-elements-review.md), [multi-account sessions](multi-account-sessions.md) (implemented per-account Strict AEAD cookies), [multi-account UI](multi-account-ui.md), and [multi-account review](../release/multi-account-review.md). The phase-1 SDK is `packages/sdk/src/{flows,identity,callback}.mjs` and `packages/sdk/src/elements/`.

## 1. User direction and summary

User direction (2026-10-14):
1. Use FedCM where available; otherwise use a popup (or redirect) OAuth-style flow.
2. A provider frame hosts sensitive provider UI (identity, account switcher, avatar) that the embedder must not read. Its sign-in survives reloads through a device key generated in the frame's own partitioned storage.
3. The Bindle spec says nothing about UI.
4. A user already signed in at the provider gets **one click**, not a fresh login.
5. **AS-R1 decision:** having the app forward the sign-in request was a mistake. The **frame itself** opens the popup or tab at the sign-in URL. The app never sees that window and never gets a handle to it. The flow binds the frame's key to the final embed credential. Confidentiality from the app, for the account switcher and avatar, is a requirement again, not just integrity.

Design in one paragraph: the app hands the frame only **public inputs** (`redirect_uri`, PKCE `code_challenge`, `state`, intent, requested fragments). The frame creates the authorization entry with its own key thumbprint. On a click **inside the frame**, the frame opens the provider popup itself (or, in Chromium, calls FedCM itself with the embed origin as relying party). On approval the provider page proves that its opener holds the bound key, then posts `{code, state, iss, embed credential}` to `window.opener` with `targetOrigin` = the embed origin. The frame keeps the embed credential (in its partition, next to the key) and forwards only `{code, state, iss}` to the app, which exchanges the code with its PKCE verifier. The embed credential never appears in a redirect to the app, in a token response, or in any message the app can receive. Every path that does not run through the frame (app-opened popup, redirect, app-as-RP FedCM) yields **only** the app's own credential and app-granted data.

## 2. Decisions

| ID | Decision | Section |
| --- | --- | --- |
| AS-1 | The frame is served from a dedicated, cookieless **embed origin** (3sln.me: `https://embed.3sln.me`, `Origin-Agent-Cluster: ?1`). It is never the console or provider origin. | §3, §6 |
| AS-2 | The frame generates an ECDSA P-256 key with `extractable:false`, stored as `CryptoKey` in IndexedDB in its partition, one per `(issuer, client_id)`. The thumbprint `jkt` (RFC 7638) is not sent to the app. | §6.1 |
| AS-3 | The app sends the frame public inputs only (`prepare` message). The frame POSTs the entry itself with `embedJkt` and `delivery:"embed-popup"` or `"embed-fedcm"`. The frame never accepts an entry ID, URL or thumbprint from the app. | §7.1 |
| AS-4 | The frame opens the popup itself, inside a click in the frame, directly at `authorization_endpoint?entry=<id>`, unnamed, **without** `noopener` (it needs the opener relationship and the `null` return value to detect blocking). | §7.2 |
| AS-5 | Embed popup pages are a single static provider document served **without** `Cross-Origin-Opener-Policy: same-origin` (`unsafe-none`), so the opener survives. All other authorization pages keep `COOP: same-origin`. | §9 |
| AS-6 | Before showing any account state, the popup runs an **opener-key handshake**: it gets a server challenge, posts it to `window.opener` with `targetOrigin` = embed origin, and the frame returns a DPoP-style proof signed by the key named in the entry. Without a valid proof the popup runs in **plain mode**: no embed credential, ordinary completion to the registered callback. | §7.3, §8 |
| AS-7 | App credential delivery: **forwarded by the frame over the port** (primary). The registered-callback relay (D7) is the fallback when the opener is lost. Justification in §7.5. | §7.5 |
| AS-8 | The embed credential is minted only for a handshake-verified popup document (or a FedCM-in-frame assertion whose browser-set `Origin` is the embed origin and whose `params` carry a key proof). It becomes active only when the paired code is exchanged, and it dies with that app session. | §7.4, §11.4 |
| AS-9 | The frame stores its embed credentials itself. The app holds none. Restore on reload is frame-internal (key proof). | §6.3 |
| AS-10 | No `SameSite=None` session cookie, no partitioned cookie and no Storage Access API for the frame. Embed APIs read no cookies. | §4.3 |
| AS-11 | FedCM inside the frame (RP = embed origin, `allow="identity-credentials-get"`) is the Chromium enhancement of the same frame-initiated model. App-as-RP FedCM remains an optional app-only path that yields the app credential only. | §11 |
| AS-12 | FedCM needs one narrow provider cookie: `__Secure-bindle_fedcm`, `Path=/fedcm/api/`, session-class. FedCM pages live outside that path. | §11.5 |
| AS-13 | App API access: 5-minute access tokens; refresh tokens persist across reloads only if DPoP-bound, rotate with reuse detection and a one-time same-key grace, and are checked against the live grant. | §12 |
| AS-14 | Sandboxing: the SDK sets no `sandbox` attribute. The frame and the sign-in page both detect sandboxing and degrade or refuse (§10). | §10 |
| AS-15 | The Bindle spec carries only interop: transports, `fedcm_config_url`, the FedCM token shape, the provider-component rule "component credentials never reach the client", and DPoP refresh. UI and framing are 3sln host policy. | §16 |

## 3. Parties, origins and credentials

| Party | Origin / context | Trusted for | Holds |
| --- | --- | --- | --- |
| App | App origin, top-level | Its own data | PKCE verifier and pending record (sessionStorage); access token (memory); refresh token and app DPoP key (IndexedDB, persistent profile) |
| Embed frame | `embed.3sln.me`, cross-site frame, partitioned by the app's top-level site | Rendering identity and the switcher to the user, confidentially | Embed key and embed credentials (IndexedDB); embed session (memory); handle to its popup |
| Provider popup | `3sln.me`, top-level, opened by the frame, `COOP: unsafe-none`, static single document | Account choice, sign-in, consent | First-party per-account Strict cookies (after commit) |
| Other provider pages | `3sln.me`, top-level, `COOP: same-origin` | Console, consent via app-opened popups and redirects | Strict cookies |
| Browser FedCM UI | Browser chrome | Account choice | Reads `__Secure-bindle_fedcm` on `/fedcm/api/*` |

`embed.3sln.me` and `3sln.me` are same-site but cross-origin. Both send `Origin-Agent-Cluster: ?1`, so `document.domain` cannot merge them, and neither can script the other's DOM. Host-only `__Host-` cookies of `3sln.me` are never sent to the embed origin, and the frame is in a cross-site context anyway.

| Credential | Bound to | Lifetime (provisional) | Where | Authority |
| --- | --- | --- | --- | --- |
| Per-account cookies | Owner session (AEAD) | Session ≤24 h | Provider first-party jar | Provider pages (unchanged) |
| `__Secure-bindle_fedcm` | Per-member FedCM capability hashes | ≤ member session; rotated each install | Provider unpartitioned jar, `Path=/fedcm/api/` | FedCM accounts list; code minting for FedCM-bound entries |
| Authorization code | Entry (client, redirect, PKCE, state, intent, delivery, `embedJkt`), owner, decision | 60 s, single use | Frame → app port, or app callback, or FedCM token | One exchange |
| Access token | App session, grants | ≤300 s | App memory | RPC with live checks |
| Refresh token (persistent) | App session family, app `dpopJkt` | Rotates each use; idle 7 d; absolute 30 d | App IndexedDB | Renew access within live grants |
| Embed credential | Approval, owner, `client_id`, `embedJkt`, and (after exchange) the app session | Pending ≤10 min until the paired code is exchanged; then idle 7 d, absolute ≤ refresh family's absolute expiry | Frame IndexedDB only | Start an embed session, with key proof |
| Embed session | Embed credential, `embedJkt` | 600 s, renewable by proof | Frame memory | Read labels and avatar for that binding |

## 4. Browser facts relied on

Verified against current documentation on 2026-10-14 unless marked *needs browser evidence*.

### 4.1 Partitioning

- IndexedDB, localStorage, BroadcastChannel, SharedWorker and service workers in a third-party frame are partitioned by top-level site in Firefox ([MDN state partitioning](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/State_Partitioning)), Chrome 115+ ([Chrome storage partitioning](https://privacysandbox.google.com/cookies/storage-partitioning)) and WebKit, which partitions BroadcastChannel by top origin and frame origin ([WebKit bug 229814](https://bugs.webkit.org/show_bug.cgi?id=229814)).
- **BroadcastChannel is not shared** between the frame on `app.example` and a first-party `3sln.me` tab. It is shared between an app tab and the app's own callback page, which the D7 fallback uses.
- `postMessage` addresses a WindowProxy, not storage, so it crosses partitions. The frame-to-popup bridge relies on this.
- In Firefox and WebKit, the Storage Access API un-partitions only cookies. Chromium also has a non-cookie extension and auto-grants storage access to an IdP frame after a FedCM sign-in. In no engine does SAA attach Strict/Lax cookies to a cross-site frame, so it cannot reach the per-account session cookies. It is not used.
- Chrome partitions by top-level site plus a cross-site-ancestor bit; WebKit by top origin. Sibling subdomains share a partition in Chrome and Firefox, not in Safari (§18).

### 4.2 Key storage

`crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, false, ['sign'])` yields a private key that cannot be exported; `CryptoKey` is structured-cloneable into IndexedDB and stays non-extractable. Script on the embed origin can still *use* it (T2).

### 4.3 No third-party cookie for the frame

Embed API requests carry a DPoP proof and an embed session header, never cookies. Third-party-cookie blocking, CHIPS and SAA do not matter to the frame.

### 4.4 Popups from frames

`window.open` in a cross-origin frame needs transient activation in that frame; the frame opens its own popups from its own clicks. The popup's `window.opener` is the frame's WindowProxy. The popup document's origin is the provider's; it can reach `opener` and `opener.top` as cross-origin WindowProxies (postMessage, `closed`, `location` assignment only). The app holds no reference to an unnamed popup opened by the frame.

## 5. First-class requirement R1: already signed in → one click

**R1.** A user with a live provider session in this browser, who has connected this app before, reaches a signed-in app *and* a signed-in frame with **one click inside the frame plus one click in provider-controlled UI**, with no credential entry, in every supported browser. A first connection adds only consent review. On later visits the frame restores automatically (zero clicks) until eviction.

The frame cannot see first-party sessions (§4.1). The bridge is always a provider context with first-party access, opened by the frame:

| Path | First-party state from | Clicks (returning user) | Embed credential | Browsers |
| --- | --- | --- | --- | --- |
| FedCM in frame (§11.3) | Browser fetches `/fedcm/api/accounts` with the FedCM cookie | Frame button → account in browser dialog | Yes | Chrome/Edge |
| Frame popup (§7) | Static popup document commits on the provider origin; same-origin fetches carry Strict cookies; "Continue as …" | Frame button → "Continue as …" | Yes (after handshake) | All |
| App-as-RP FedCM (§11.6) | FedCM cookie | App button → dialog | **No** (app credential only) | Chrome/Edge |
| App popup or redirect | Strict cookies after commit | App button → "Continue as …" | **No** | All |
| Frame restore (§6.3) | Frame's stored embed credential | 0 | Already held | All, until eviction |

Rules: provider choosers and the FedCM accounts list show only members whose live session validates; nothing returns to the app before the user picks. "Continue as X" for an already-approved client with no new fragments completes on that click; there is no auto-approval without a click. A FedCM assertion with `is_auto_selected=true` yields memory-profile app credentials only and **no** embed credential (review round 1 AS-R2).

## 6. Embed frame lifecycle

### 6.1 Mount and key

1. The SDK creates, per part, `<iframe src="https://embed.3sln.me/embed?client=<id>#<part>" name="bindle-island;v=1;n=<nonce>;l=<lang>;cs=<scheme>" allow="identity-credentials-get" referrerpolicy="no-referrer">` with fixed or embedder-set geometry ([embed islands §4.1](embed-islands.md#4-channel)). The nonce, locale and colour scheme travel in the iframe `name`, never in the URL. **No `sandbox` attribute** (§10). `frame-ancestors` is derived from the client's redirect-URI origins (unknown client → `'none'`); the shell is static per client, `Cache-Control: no-cache` + ETag.
2. Handshake (embed islands §4.1): a single init on `load` carrying `part`, one transferred `MessageChannel` port, exact `targetOrigin`. The island accepts init only from `window.parent` with an origin in its registered list and a nonce matching `name`.
3. The island replies `ready{v, part, protocol}` **before** any storage access, leader election or credentialed request; `ready` is constant. The sandbox probe (§10) and all key and credential work then run in the island worker (embed islands §5).
4. If storage is unavailable or temporary (`window.credentialless`, opaque origin, blocked storage), the frame uses an in-memory key; credentials then last only for the page life.

### 6.2 Messages (superseded in detail by [embed islands §4.3–4.4](embed-islands.md#4-channel))

Messages are now **per part**: `ready` carries `part`; `prepare`, `code` and `flow` belong to `account-switcher` and `sign-in`; `select` to `account-switcher` only; `session` and `forget` (with optional `subject`) to all parts; state messages are last-value-wins. The table below is the original single-frame contract, kept for the semantics each message has.

| Direction | `type` | Fields | Notes |
| --- | --- | --- | --- |
| frame → app | `ready` | `v`, `protocol` | Constant. |
| app → frame | `prepare` | `v`, `redirectUri`, `challenge`, `state`, `requests` (bounded as the entry schema), `loginHint?`, `uiLocales?`, `colorScheme?` | Public inputs only. `client_id` comes from the frame URL; the frame rejects a mismatching or unregistered `redirectUri` locally and the server re-checks. The app sends a fresh `prepare` after every flow end. The intent is never taken from the app: it comes from the control the user clicks in the frame (AS-R2-9). |
| app → frame | `session` | `v`, `subject` or `null` | Which of the app's sessions is current. The frame shows that account if it holds a binding for it, otherwise a "Show my account" control. No reply. |
| frame → app | `code` | `v`, `code`, `state`, `iss` | Only after a completed flow, and only if the parent origin verified at init equals the origin of the entry's `redirect_uri` (AS-R2-6). Validated by the SDK exactly as callback parameters. |
| frame → app | `flow` | `v`, `phase` (`started` or `ended`), `outcome?` (`completed`, `canceled`, `popup-blocked`, `unavailable`) | `canceled` covers every non-approval. `unavailable` means "use your own path" (sandboxed, blocked, or no opener) and is not more specific. |
| frame → app | `select` | `v`, `subject` | The user picked another *connected* account in the frame's switcher. The app already knows every subject it is connected to. |
| app → frame | `forget` | `v` | App sign-out: the frame deletes its key and credentials for this client. |

Exact key sets, size bound (2 KiB), rate limit (10/s) and the theme rules of embeddable-elements §8.4–8.5 apply. The frame never posts to the app the thumbprint, labels, avatar, account count, which accounts it holds, restore results or error reasons.

### 6.3 Restore (frame-internal, leader-only)

Restore runs only in the partition's elected leader island worker (embed islands §5), which fans the resulting snapshot out to the other islands over the partition bus; non-leaders never call these endpoints. Embed sessions are keyed by `(credential, instance)` and capped at 4 sessions and 2 streams per credential; a new session **evicts the oldest** rather than being refused. For each stored credential the leader calls:

```text
POST https://embed.3sln.me/embed/api/nonce            → {nonce}
POST https://embed.3sln.me/embed/api/session
     Authorization: BindleEmbed <credential>
     DPoP: <ES256 proof: jwk, jti, htm, htu, iat, nonce, ath=b64url(sha256(credential))>
     → 200 {session, expires_in:600, view:{handle, name?, avatar}} | 401 constant
```

Checks: Fetch Metadata gates (§13.4); proof syntax, `alg`, exact `htm`/`htu`, `iat` ±60 s, single-use server nonce ≤120 s, unseen `jti`, `ath`; credential active, unexpired, idle window; `jkt(jwk) == binding.embedJkt`; `client_id` matches; linked app session live; connection generation, account status and authority epoch current. A valid proof from a different key is rejected identically and logged; nothing is revoked (round 1 AS-R11). Restores run serially, padded to at least 300 ms each, after `ready`, and do not depend on the app's current `session{subject}`: the leader restores every held binding and islands only filter the snapshot.

## 7. Frame-initiated popup flow (binding and delivery)

### 7.1 Entry creation by the frame

`prepare` only stores the app's public inputs in frame memory. Entries are created **lazily, on the click** (AS-R2-9): the frame POSTs the authorization entry from the embed origin (cookieless, CORS allowed for the embed origin only on this endpoint) with those inputs, the intent of the clicked control, its own `embedJkt` and `delivery:"embed-popup"`. The response is `{entryId}` (≥128-bit random; the server never looks entries up or deduplicates them by `state`, AS-R2-5). Entry creation has a per-client budget as well as per-IP and global limits, so one hostile client cannot drain others (D9).

The server stores `embedJkt` and `delivery` on the entry but trusts neither: anybody can create an entry with any thumbprint. Attestation happens at delivery (§8).

### 7.2 Opening

On a click inside the frame (activation in the frame), the frame synchronously calls `window.open('about:blank', '_blank', 'popup')` (an embed-origin blank document that holds no first-party state), keeps the handle privately, creates the entry, then assigns `popup.location` to `https://3sln.me/oauth/authorize?entry=<id>`, and posts `flow{phase:'started'}`. Both the blank document and the provider entry document are `unsafe-none`, so the opener survives. A `null` return means blocked, sandboxed, **or forced noopener because the app's top-level document sends `COOP: same-origin`** (in which case the browser may still have opened a popup). The frame then posts `flow{phase:'ended', outcome:'unavailable'}` (AS-R2-2). The SDK keeps its pending record until a callback arrives or the entry expires, so a plain-mode popup still completes to the app's callback without the app starting a second flow. Integration docs tell apps that want the confidential frame to use `same-origin-allow-popups`.

### 7.3 Opener-key handshake (in the popup, before any account state)

1. The popup document (static, `COOP: unsafe-none`, §9) runs its sandbox refusal check (§10.2) and checks `window.top === window`. It renders **no account state** until the handshake succeeds.
2. It fetches `POST /oauth/entries/<id>/embed-challenge` (same-origin) → `{challenge}` (128-bit, single use, bound to this entry, ≤60 s).
3. If `window.opener` is non-null, it posts `{v:1, type:'bindle-embed-hello', entry, challenge}` with `targetOrigin = 'https://embed.3sln.me'`.
4. The frame accepts the message only if `event.source` is its own popup handle, `event.origin` is the provider origin, `entry` is its pending entry and the schema is exact. It replies to `event.source` with `{v:1, type:'bindle-embed-proof', proof}` (`targetOrigin` = provider origin), where `proof` is an ES256 JWT with its public `jwk`, `htu` = the challenge-verify URL, `nonce` = challenge, `entry`, `iat`, `jti`.
5. The popup POSTs the proof to `/oauth/entries/<id>/embed-verify`. The server checks `jkt(jwk) == entry.embedJkt`, the challenge, freshness and single use, marks the entry **embed-attested**, and returns a per-page secret held only in that document's memory. Every later chooser, consent and decision request for this entry must carry it; for `embed-popup` entries the decision endpoint refuses requests without it (AS-R2-5).
6. No reply within 3 s, `opener` null, or a failed check: **plain mode**. The page immediately `location.replace`s to `/oauth/authorize?entry=<id>&mode=plain`, a document served with `COOP: same-origin` (which severs any opener), and the flow continues there as an ordinary authorization completing through the registered callback (AS-R2-1). Nothing is shown and no decision is possible in the `unsafe-none` document without the handshake. No embed credential or claim is ever issued for a plain-mode entry.

### 7.4 Approval and delivery

After "Continue as …" (and consent if needed), the decision POST of an embed-attested entry (with the per-page secret, Strict cookie, CSRF, Fetch Metadata) returns to the popup document only `{code, state, iss, claim}`. `claim` is a single-use 256-bit handle, valid 2 minutes, redeemable only with a proof from `entry.embedJkt` (AS-R2-4). The credential itself never passes through the popup. The popup posts `{v:1, type:'bindle-embed-done', entry, code, state, iss, claim}` to `window.opener` with `targetOrigin = 'https://embed.3sln.me'`. The frame applies the same checks as for the hello (`event.source` is its popup handle, provider origin, its pending entry, exact schema), acknowledges, and the popup closes itself. Without the acknowledgement within 3 s the popup falls back to the callback redirect carrying only `code`, `state`, `iss`; the claim is never redeemed, so no credential exists.

The frame redeems the claim at `POST /embed/api/claim` with a DPoP proof (server nonce) from its key, stores the returned credential, forwards `code{code, state, iss}` to the app, and the app exchanges the code with its verifier. The exchange creates the app session and activates the paired credential, linking it to that app session. A credential whose code is never exchanged stays inactive and expires after 10 minutes.

### 7.5 Why the code goes through the frame (primary) rather than the callback

- One window lifecycle: the popup can close itself, and no navigation to an app page happens inside the popup, so the opener relationship and `COOP: unsafe-none` are needed for one provider document only.
- The callback relay needs a callback page, BroadcastChannel and a navigation that the app's own COOP may sever; it remains the fallback.
- Delivery remains origin-constrained: the embed document's `frame-ancestors` is derived from the client's **redirect-URI origins** and checks the whole ancestor chain, and the frame forwards a code only when its verified parent origin equals the origin of that entry's `redirect_uri` (AS-R2-6). This is origin-level, not path-level, delivery: comparable to, but weaker than, an exact redirect URI, and acceptable because the code is also bound to the parent's PKCE challenge. The code is still bound to the app's PKCE challenge and state, and to `redirect_uri` at exchange.
- The frame is provider code and handles the code only transiently.

## 8. Attestation argument

**Claim.** An embed credential is only ever usable by a provider frame, running in the browser of the user who approved, holding the non-extractable key named in the entry. No app (client-side or server-side) can obtain one bound to its own key.

1. **Minting requires the victim's first-party provider document.** The credential is returned only to a same-origin fetch from the provider origin authenticated by the chosen owner's Strict cookie and CSRF token. A server-side attacker has no such cookie; a hostile app page cannot send Strict cookies cross-site or read a provider response (no CORS).
2. **That document releases only a key-bound claim to an attested opener.** It obtains a claim only after the handshake proves that `window.opener` answers at the embed origin *and* signs with the key whose thumbprint the entry carries; it posts only with `targetOrigin` = embed origin; and the claim is redeemable only with a fresh proof from that key. If the app opens the same sign-in URL itself, the opener is the app window: the hello is dropped by `targetOrigin`, no proof arrives, plain mode applies, and the app gets only its code. If a victim opens a link from an attacker, the opener is `null` or attacker-origin: plain mode.
3. **Only provider code runs on the embed origin.** Its documents generate keys internally (non-extractable), create entries only with their own thumbprint, never accept entry IDs or thumbprints from the app, and answer hellos only from their own popup handle for their own pending entry. So any attested `embedJkt` is a key living in a frame in the approving user's browser.
4. **A thief gains nothing.** The credential is useless without the key (DPoP proof per restore), and the key cannot leave the frame's partition.

Residual: script injection on the embed origin breaks step 3 (T2); provider-origin XSS breaks everything (as today).

### 8.1 Paths that do not run through the frame

| Path | What the app gets | Embed credential |
| --- | --- | --- |
| App opens popup or redirect itself (including after `popup-blocked`) | App credential, app-granted data | Never (no attested opener) |
| App-as-RP FedCM | App credential | Never (`Origin` is the app, server refuses `embedJkt` there) |
| Popup opener lost (app `COOP`, user closed frame, navigation) | App credential via callback | Never minted, or minted but inactive and discarded |
| Frame sandboxed, credentialless, or storage blocked | App credential via the app's own path | None, or page-lifetime only |

In all of these the frame shows only a neutral "Show my account at example.org" control and the app renders whatever its own grants disclose in its own DOM.

### 8.2 What the app learns

From any path: that a flow started and ended, the generic outcome, and on completion the approved identity and grants through its own exchange. From the frame: `ready`, `flow`, `code`, `select{subject}` among subjects it already holds. Never labels, avatars, account counts, other device accounts or the thumbprint. Accepted residuals (AS-R2-10): flow duration hints whether the user had to sign in; `session{subject}` followed by whether the user then needs a flow hints whether the frame held a binding for that subject; `select` reveals which known subject the user chose.

## 9. COOP, window hygiene and XS-leaks

**Why `unsafe-none`.** The popup's initial `about:blank` is created by the cross-origin frame, so its opener policy is `unsafe-none`. Navigating it to a response with `COOP: same-origin` (or `same-origin-allow-popups`) is a policy mismatch, which puts the popup in a new browsing context group and sets `window.opener` to `null`. The embed sign-in document therefore omits COOP (`unsafe-none`). `restrict-properties` is not shipped and is not relied on. Only the entry document for `delivery:"embed-popup"` behaves this way; it is a single static document with no further navigations (sign-in, passkey, chooser and consent all render inside it from same-origin fetches). Every other authorization page keeps `COOP: same-origin`. If the app's top-level document has `COOP: same-origin`, the popup may still be severed (*needs browser evidence per engine*); the handshake then fails and plain mode applies. Integration docs recommend `same-origin-allow-popups` for apps that want the confidential frame.

Mitigations for keeping the opener:

| Risk | Mitigation |
| --- | --- |
| App obtains a popup handle | The frame opens it unnamed (`_blank`), keeps the handle in a closure, never assigns `window.name`. There is no API from the app's window, or from the frame's WindowProxy, to the frame's opened windows. |
| App navigates the frame (its child) after the popup opened | The new document is in the frame's navigable and becomes the popup's `opener`, but holds no handle to the popup. The popup's messages use `targetOrigin` = embed origin, so they are dropped unless the navigable again holds an embed-origin document, which can only be provider code without a pending entry for that hello. |
| Tabnabbing of the popup | Only the frame holds a handle that could assign `popup.location`, and it is provider code. The popup never navigates `opener` or `opener.top`. |
| Tabnabbing of the app | The popup never touches `opener.top`; it only posts to `opener` with exact `targetOrigin`. |
| XS-leaks via `popup.closed`, `length`, navigation timing | Only the frame can observe them; it reports to the app only `flow` phases with generic outcomes. The popup document has no nested frames (`length` constant 0) and no navigations after load. |
| Framing the popup page | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, and a `top === self` check before rendering. |
| URL state | The URL carries only the entry ID. Codes and credentials travel in fetch responses and `postMessage`. `Referrer-Policy: no-referrer`. |
| Plain-mode abuse | Anyone can create an `embed-popup` entry and open it to keep a handle; without a handshake the `unsafe-none` document shows nothing and replaces itself with the `COOP: same-origin` plain page, severing the handle (AS-R2-1). |
| Process sharing | Without COOP isolation the popup may share a browsing context group with the app. Site isolation still separates processes on desktop Chrome and Firefox (Fission); on Android Chrome, isolation is heuristic (*residual; needs evidence*). The page enables no cross-origin isolation features and holds secrets only transiently. |
| Activation tricks | Provider controls are inert until the popup is visible and focused for 600 ms; approve has no default focus (D4). |

## 10. Sandboxing

### 10.1 Frame

The SDK sets no `sandbox` attribute: the frame is provider code, and sandboxing it only breaks the popup bridge. The app controls the iframe element, so the frame probes on startup: setting `document.domain = document.domain` throws `SecurityError` in any sandboxed document (the sandboxed `document.domain` flag has no `allow-` keyword) even with `Origin-Agent-Cluster`, because the sandbox check runs first (*needs browser evidence in all engines*). `self.origin === 'null'` also means sandboxed without `allow-same-origin`. If sandboxed, the frame enters **degraded mode**: no entry creation, no popup, no restore; it shows the neutral "Show my account at example.org" link (opening a `noopener` provider tab with no embed role) and posts `flow{outcome:'unavailable'}` when its control is used. `window.open` returning `null` is handled the same way.

### 10.2 Sign-in page

A popup opened from a sandboxed frame without `allow-popups-to-escape-sandbox` inherits the sandbox. Before any account state or handshake the provider popup runs the same `document.domain` probe and checks `origin !== 'null'` (the detached-form probe of revision 2 was wrong and is dropped, AS-R2-3). If either indicates sandboxing, it renders only "Open example.org in a normal window" and refuses to continue. Sandbox detection is a usability guard, not a security boundary: the attestation argument (§8) does not depend on it.

## 11. FedCM

### 11.1 Verified facts

Sources: [Chrome IdP guide](https://developer.chrome.com/docs/identity/fedcm/implement/identity-provider), [Chrome RP guide](https://developer.chrome.com/docs/identity/fedcm/implement/relying-party), [FedCM spec](https://w3c-fedid.github.io/FedCM/), [Chrome 143 updates](https://developer.chrome.com/blog/fedcm-chrome-143-updates), [Continuation API](https://privacysandbox.google.com/blog/fedcm-chrome-126-updates), [MDN browser-compat-data](https://github.com/mdn/browser-compat-data).

| Topic | Fact |
| --- | --- |
| Support | `IdentityCredential`: Chrome 108+, Edge yes; Firefox no (`navigator.login` listed from 138, FedCM itself not shipped); Safari/iOS no. `IdentityProvider.resolve` Chrome 132+. |
| Config | Required `accounts_endpoint`, `id_assertion_endpoint`, `login_url`; optional `client_metadata_endpoint`, `disconnect_endpoint`, `account_label`, `supports_use_other_account`, `branding`. |
| Well-known | `/.well-known/web-identity` at the IdP's eTLD+1 with `provider_urls`; Chrome 145 also requires `accounts_endpoint` and `login_url` there (when `client_metadata_endpoint` is used). Skipped when the config host equals the RP origin's registrable domain. |
| Accounts endpoint | `GET`, credentials included, opaque origin, **only `SameSite=None` cookies**, no `client_id`/`Origin`/`Referer`, `Sec-Fetch-Dest: webidentity`. Accounts need `id` and one of `name`/`email`/`username`/`tel`; optional `picture`, `approved_clients`, `login_hints`, `domain_hints`, `label_hints`. |
| ID assertion | `POST` form: `client_id`, `account_id`, `disclosure_text_shown`, `is_auto_selected`, optional `fields`, `params` (JSON, Chrome 132+). `Origin` = RP document origin. Credentialed CORS with exact origin. Response `token` (string; object from 143), `continue_on`, or `error{code,url}`. |
| Nonce | Inside `params`; top-level `nonce` dropped in Chrome 145. Error property `code` renamed `error` in 145. |
| Login Status | `Set-Login: logged-in|logged-out` header or `navigator.login.setStatus()`. Logged-out: active mode shows `login_url`; passive mode does not fetch accounts. |
| Iframes | Permissions Policy `identity-credentials-get`; RP origin is the iframe origin; top-level origin not sent. |
| Third-party cookies | Chrome documents FedCM as working with third-party cookies blocked. |

### 11.2 Provider configuration

- Manifest `"fedcm_config_url": "https://3sln.me/fedcm/config.json"`.
- `https://3sln.me/.well-known/web-identity`: `{"provider_urls":["https://3sln.me/fedcm/config.json"],"accounts_endpoint":"/fedcm/api/accounts","login_url":"/auth/fedcm-login"}`.
- Config: `accounts_endpoint:/fedcm/api/accounts`, `id_assertion_endpoint:/fedcm/api/assert`, `disconnect_endpoint:/fedcm/api/disconnect`, `client_metadata_endpoint:/fedcm/api/client` (no cookies), `login_url:/auth/fedcm-login`, `supports_use_other_account:true`.
- `/auth/fedcm-login` and `/auth/fedcm-continue` are static pages outside the cookie path that authenticate with Strict cookies after commit. The login page offers "Continue as …" for existing members, reinstalls the FedCM cookie and sends `Set-Login: logged-in`.

### 11.3 FedCM inside the frame (Chromium enhancement)

The same frame-initiated model with the browser dialog instead of a popup:

1. On the click, the frame creates an entry with `delivery:"embed-fedcm"`, the control's intent and its `embedJkt` (§7.1), within the click's transient activation (*needs evidence that activation survives the entry POST in Chrome*).
2. On a click in the frame: `navigator.credentials.get({identity:{providers:[{configURL, clientId:<app client_id>, params:{v:1, entry, proof}}], mode:'active', context:'signin'}, mediation:'required'})`, where `proof` is an ES256 JWT by the frame key over `{entry, iat, jti, nonce:<single-use server nonce>, htu:<assert URL>}`. `mediation:'required'` disables auto-selection, so every embed credential follows an explicit choice (AS-R2-7).
3. The RP origin is `https://embed.3sln.me`. The well-known check is skipped because the config host `3sln.me` equals the RP's registrable domain (spec rule; *needs browser evidence* that Chrome applies it to a framed RP).
4. `/fedcm/api/assert` requires `Sec-Fetch-Dest: webidentity`, `Origin == https://embed.3sln.me` exactly, `client_id` registered, `params` exact, entry unbound, `delivery == embed-fedcm`, `jkt(proof.jwk) == entry.embedJkt`, fresh `jti`, live member. It returns `token` = JSON text `{"v":1,"code","state","iss","claim"}` (the frame redeems the claim with a key proof, as in §7.4) or `continue_on` (consent; the continuation page resolves with the same token shape). For `is_auto_selected=true` it returns the code with no credential.
5. The token is delivered by the browser to the frame's JavaScript only (RP = embed origin). The frame stores `credential` and forwards `code{…}` to the app.

Attestation: the `Origin` is browser-set, so only an embed-origin document can receive an embed-bound token; the key proof ties it to the entry's thumbprint. No handshake is needed. If the app strips `allow="identity-credentials-get"` or FedCM is unavailable, the frame falls back to the popup.

Open UX point (*needs browser evidence*): the dialog names the RP origin, which will be the provider's embed host, not the app. `client_metadata` supplies the app's privacy and terms links, and the continuation consent page names the app. This is acceptable only if usability checks show users understand which app they are signing in to.

### 11.4 Assertion and minting rules

- The accounts response lists live members (≤8): opaque per-session `id` (HMAC), `username` (handle), `name`, `picture` (generated badge URL), `approved_clients`, `login_hints`.
- The entry binds to one owner exactly once. Consent, new fragments, resource review and reauthentication go through `continue_on` to `/auth/fedcm-continue?entry=…&k=<one-time secret>`, bound to entry and owner; the page authenticates with that owner's Strict cookie after commit and refuses any other.
- Every non-approval returns `{error:{code:"access_denied"}}`.
- Codes are bound to the entry's PKCE challenge, state, delivery and (for embed deliveries) the credential they pair with.

### 11.5 The FedCM cookie

- `__Secure-bindle_fedcm`; `Secure; HttpOnly; SameSite=None; Path=/fedcm/api/`; not Partitioned.
- AEAD value over ≤8 entries `{owner, sessionContext, fedcmSecret}`; the secret's hash lives on the owner session with purpose `fedcm`, rotates on every install, and is part of logout cleanup and revocation custody. It is session-class: a copy plus forged headers can mint codes for clients the user already approved, so it lives no longer than its sessions.
- Installed with per-account cookies and lazily on `GET /api/session`; removed with the last member.
- Every `/fedcm/api/*` handler checks `Sec-Fetch-Dest: webidentity` before reading cookies and returns a constant 403 otherwise; no CORS on accounts; `no-store`.
- `Set-Login` follows member installation and removal.

### 11.6 App-as-RP FedCM (optional)

The app may call FedCM itself (RP = app origin, `params:{v:1, entry}` with an app-created entry). It returns an app code only; the server refuses any `embedJkt` on entries created for this delivery. This is a fast app-only sign-in for apps that do not embed the frame.

## 12. App credentials

| Profile | When | Refresh | Persistence |
| --- | --- | --- | --- |
| Memory | No `dpopJkt`, or auto-selected FedCM | Rotating, 8 h absolute | Memory only |
| Persistent (default, provisional) | Entry carried `dpopJkt`, exchange proved it, user clicked | Rotating, DPoP-bound, idle 7 d, absolute 30 d | IndexedDB (token + non-extractable app key) |

- RFC 9700 §4.14: public-client refresh tokens must be sender-constrained or rotated; persistence requires both. DPoP server nonces are mandatory at the token endpoint. Script injected into the app can still start a new sign-in with an exportable key if the user clicks through; that residual is shared by every public client. App sessions are capped at 8 per client and owner and listed in the console.
- Rotation: the SDK serialises refresh with Web Locks, re-reads storage under the lock, writes the successor before releasing. The server accepts the immediately previous token once within 30 s with the same DPoP key and returns the same successor; anything else is reuse and revokes the app session.
- Every refresh checks live grants, connection generation, account status and authority epoch.

### 12.1 Revocation cascade

| Trigger | Access/child | Refresh family | Embed credential |
| --- | --- | --- | --- |
| App connection disconnected | Revoked | All for client+owner | All for client+owner |
| App session revoked (console list, RFC 7009 on refresh token) | Revoked | That family | Its paired credential |
| Refresh reuse | Revoked | That family | Its paired credential |
| Frame "Remove from this site" | — | — | That credential |
| Embed credential with wrong key | — | — | Unchanged (rejected, logged) |
| One fragment grant revoked | That fragment denied | Continues | Unchanged |
| Recovery, suspension, deletion, epoch change | Revoked | All | All |
| Console "Sign out of all apps" (new, provisional) | Revoked | All app sessions of the owner | All |
| Provider first-party sign-out of a browser | Unchanged | Unchanged | Unchanged |

## 13. Frame scope and hardening

### 13.1 What the frame shows and does

Split across islands (embed islands §6, §8): the `avatar` part shows only the current subject's avatar; the `account-switcher` part shows the identity, the switcher and the actions below; `sign-in` starts flows.

- For the app's current `subject`, if it holds an active binding: handle, display name and avatar (provider-rendered, confidential from the app), plus "Connected to app.example".
- A switcher listing the accounts it holds bindings for in this partition (accounts the user approved for this app through the frame in this browser). Picking one posts `select{subject}`.
- "Use another account" and "Add account" run the frame-initiated flow (§7 or §11.3), where the provider shows the full first-party inventory. "Review access", "Manage", "Sign out of example.org…" open provider pages in `noopener` tabs (no embed role). "Remove from this site" is a two-step in-frame confirmation that calls `/embed/api/forget`.
- It cannot approve, switch the console account, end sessions, revoke grants other than its own binding, read preferences, call RPC, or list device accounts it holds no binding for.

### 13.2 Clickjacking and UI redress

`frame-ancestors` per client; delay-to-arm 600 ms after visibility, re-armed on resize or move; IntersectionObserver v2 `trackVisibility` where available (Chromium only). Elsewhere a frame cannot detect overlays or opacity, so in-frame controls never grant authority by themselves: every flow ends with a click in a top-level provider popup or the browser's FedCM dialog.

### 13.3 Embedder probing

Embeddable-elements §7.5 applies (fixed size chosen by the parent, no nested frames, single load, no autofocus, in-frame errors). Additionally: `ready` is constant and sent after storage access whatever the state; label length never affects layout (fixed row height, truncation); restores are serial and padded; the frame's `flow` outcomes are generic; there is no reply to `session`.

### 13.4 Embed API gates

`/embed/api/*` on the embed origin requires `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors|same-origin`, `Sec-Fetch-Dest: empty`, `X-Bindle-Embed: 1`, and an `Origin` header equal to the embed origin **for every non-GET request, and for a GET whenever one is present** (browsers omit `Origin` on same-origin GETs; EIR-1). `Origin: null` (Firefox sends it under `Referrer-Policy: no-referrer`) is accepted only together with `Sec-Fetch-Site: same-origin`; no CORS; `no-store`; no cookies read. These stop browser-based misuse; the cryptographic gate is the key proof plus an attested binding (§8).

## 14. Discovery and transport selection

1. Parse the handle; fetch the manifest cookieless; read `login_presentation`, the core `features` (e.g. `fedcm.v1`) and the `profiles` container (components profile, see [components profile](components-profile.md)).
2. If the provider supports the 3sln embed profile, mount the frame. Frame-initiated: FedCM in frame if `IdentityCredential` exists, the iframe has `identity-credentials-get` and the manifest advertises FedCM; otherwise the frame popup.
3. Without the frame, or when the frame reports `unavailable` or `popup-blocked`: app-as-RP FedCM (optional), then app popup, then redirect. These yield app credentials only.
4. Unknown hosts without FedCM: popup or redirect. A FedCM config URL is used only from that issuer's manifest.

## 15. Embed credential exchange summary

| Step | App sees | Frame sees | Server binds |
| --- | --- | --- | --- |
| `prepare` | its own inputs | public inputs | — |
| Entry POST | — | `entryId` | entry with `embedJkt`, delivery |
| Popup / FedCM | `flow started` | popup handle / dialog | owner once |
| Handshake | — | challenge, signs proof | attested |
| Approval | — | `{code, state, iss, claim}`; redeems claim with key proof | code + pending credential |
| Forward | `{code, state, iss}` | — | — |
| Exchange | app credentials | — | app session; credential activated and linked |
| Restore | — | embed session | key proof |

## 16. Bindle interop surface (proposed; written into the spec)

| Item | Location | Shape |
| --- | --- | --- |
| Transports | protocol §2, auth | `login_presentation`: `redirect` (MUST), `popup`, `fedcm` (requires `fedcm_config_url`). |
| FedCM | auth, protocol §2 | `params` `{v:1, entry, …profile fields}`; token JSON text `{"v":1,"code","state","iss"}`; `Origin` check against registered origins; never an access token. |
| Provider components | auth | A provider MAY operate a component embedded in client pages that starts authorizations from client-supplied public parameters. It returns to the client only the ordinary code with `state` and `iss`, delivered only to documents of the client's registered origins; credentials for the component MUST NOT reach the client in any redirect, token response or message. Behaviour is provider-defined; `embed_profiles_supported` lists profile URIs (the single name; DEVLOG's `embed_binding_profiles_supported` is retired). **Proposed:** `embed_origin`, the exact HTTPS origin serving the component, used by clients only as iframe `src` origin and `postMessage` `targetOrigin`; an explicit exception to the v0 same-origin endpoint rule, final name to be agreed with the authorization-entry implementer. |
| DPoP refresh | auth, protocol §4 | `dpopJkt`; DPoP at the token endpoint; persistence only when sender-constrained; `refresh_idle_expires_in`; `dpop_signing_alg_values_supported`. |

Removed from the spec: every framing, iframe and handle-suffix rule (moved to the 3sln host section of [security](../spec/security.md#reference-host-presentation-and-framing-3slnme-policy)).

## 17. Storage eviction and browser matrix

| Situation | Effect | Recovery |
| --- | --- | --- |
| Frame storage cleared (site data, ITP, private window) | Key and embed credentials gone together | Frame shows "Show my account"; app session continues; one click + "Continue as" mints a new binding |
| App storage cleared | App credentials gone; frame bindings still valid but the app has no live session, so `session{null}` keeps the frame neutral, and server checks fail once the app session is revoked or expires | App re-sign-in through the frame (one click) |
| Binding revoked or expired | Restore fails | Same as cleared |
| Credentialless / opaque frame | Ephemeral | Page lifetime only |

| Browser | FedCM in frame | Frame popup bridge | Partitioned frame storage | Notes |
| --- | --- | --- | --- | --- |
| Chrome / Edge | Yes (needs evidence for framed RP and dialog naming) | Yes | Yes (115+) | Default `restore`. |
| Firefox | No | Yes | Yes | |
| Safari / iOS | No | Yes (needs evidence: popup as tab on iOS, opener retention) | Yes, by top origin | ITP deletes script-writable storage after 7 days without user interaction on the site; partitioned frame storage is expected to follow the app site (*needs evidence*). |

## 18. Partition edge cases

- Sibling subdomains (Chrome/Firefox) share the frame's partition; keys and bindings are per `client_id`, and `frame-ancestors` keeps each client's frame on that client's origins. Safari keys by top origin, so siblings do not share.
- A top-level site change is a new partition: clean failure, re-sign-in. An app framed by an unregistered outer page fails `frame-ancestors`.
- Top-level site is not sent to the server; `ancestorOrigins` (Chrome, Safari, Firefox 148+) is client-reported and used for diagnostics only. Binding to the app is `client_id`, `frame-ancestors` and partitioning.

## 19. Threats

| ID | Threat | Mitigation |
| --- | --- | --- |
| T1 | Embed credential theft/replay across sites or devices | Key-bound; frame-only storage; never sent to the app; wrong-key use rejected. |
| T2 | Script injection on the embed origin | Can use the key while it runs and could answer handshakes for attacker entries. Embed origin: static, no third-party code, `script-src 'self'`, Trusted Types, no `innerHTML`, no embedder-supplied markup (theme tokens validated, §8.5 of embeddable elements). Every other embed-origin response carries `CSP: sandbox` and `nosniff`; no SVG or user-influenced active content is served there. The only image responses are avatars: fetch-only, re-encoded server-side to a raster format, `Cross-Origin-Resource-Policy: same-origin`, no CORS, `no-store` (embed islands §6). Moving avatars to another host would lose the CORP same-origin property; the frame refuses to run top-level; provider links from the frame open `noopener` tabs; the entry URL never redirects (AS-R2-8). |
| T3 | Confused deputy app ↔ frame | Frame accepts only public inputs; creates its own entries; answers hellos only from its own popup for its own entry; forwards only `{code,state,iss}`. App can tell the frame which subject is current; the frame shows only bindings it holds. |
| T4 | FedCM injection | `Origin` exact (app or embed origin by delivery); entry binding once; key proof for embed delivery; PKCE. |
| T5 | Refresh theft by app XSS | DPoP + rotation; residual of new sign-ins with exportable keys (§12). |
| T6 | UI redress | §13.2; final actions only in top-level popup or browser dialog. |
| T7 | Popup handle or opener abuse | §9. |
| T8 | Multi-account leakage | Frame switcher confidential; FedCM list to browser only; constant messages. |
| T9 | Phishing an approval into an attacker key | Attested opener required (§8); a link opened without the frame yields plain mode. |

## 20. Relationship to other designs

### 20.1 Embeddable elements: superseded sections (coordinator to apply; that file is not edited here)

- §1 non-goal on in-memory tokens: superseded by §12 and frame restore.
- §2 "panel" row and "Phase 1 needs no iframe": superseded; the frame is the confidential identity and switcher surface.
- §3.3 `show-provider-accounts`: replaced by the frame.
- §4 phase-2 row: replaced by §8.2 and §13.3.
- §5.5: still holds for preconsent probing.
- §6.2: remains the fallback (D7) and the app-initiated popup path. §6.1's `opener = null` remains for **app-opened** popups only; frame-opened popups keep the opener (§9).
- §7.1–7.4 (CHIPS credential, candidate cookie, pairing): superseded entirely. §7.5 side channels retained with §13.3 additions.
- §8.1–8.5: retained except the iframe `sandbox` attribute in §8.2 (removed; §10) and the message table (replaced by §6.2).
- §13 D5 superseded; D6 resolved by removing UI rules from the spec.

### 20.2 SDK API changes needed

- `presentation:'auto'`; frame-first when the provider advertises the embed profile.
- New frame controller: mounts the frame, sends `prepare` (fresh PKCE and state per flow) and `session`, receives `code` and validates it via the callback validator against the pending record.
- Pending record: `dpopJkt` slot; several pending records keyed by state.
- `entryExtensions`: `dpopJkt` only. The app never sends `embedJkt` (the server refuses it on app-created entries).
- `transports`: FedCM transport returns `{outcome:'unavailable'}` on non-user failures; late failures without activation fall back to redirect instead of rejecting.
- `signOut({revoke})`, `revoke-on-switch`, `revokePrevious`: act on the app session (RFC 7009 on the refresh token cascades to the paired embed credential) and send `forget`.
- Lift the 28,800 s `refresh_expires_in` cap for the persistent profile.

### 20.3 Dependencies

D1 entry (with `delivery`, `embedJkt` server field, CORS for the embed origin, embed-challenge/verify routes); D2 multi-account cookies (implemented) plus FedCM cookie hooks; D3 RFC 7009 on app sessions; D4 COOP rules (now two classes); D10 DPoP at the token endpoint.

## 21. Implementation breakdown (non-overlapping ownership)

| Slice | Owns (write) | Depends on |
| --- | --- | --- |
| A1 Spec | `docs/spec/auth.md`, `protocol.md`, `security.md` host section (done here); later `federation-implementation.md` | Coordinator |
| A2 Federation core | `packages/federation/app-sessions.mjs`, `dpop.mjs`, `embed-bindings.mjs` (new); token-endpoint changes; `tests/app-sessions.test.mjs`, `tests/federation-dpop.test.mjs` | D1 landed |
| A3 Entry and popup routes | entry `delivery`, embed-challenge/verify, decision response for attested entries, COOP class selection (files assigned when multi-account releases `packages/runtime`) | A2, D4 |
| A4 FedCM | `packages/runtime/fedcm.mjs` (new), one route hunk in `http.mjs`, cookie in `account-cookies.mjs`, purpose hash in `identity/service.mjs`, `tests/fedcm.test.mjs` | A2; multi-account owner releases files |
| A5 Embed keys and bridge | `apps/embed/src/{keys,restore,bridge,sandbox}.mjs` (key store, leader restore calls, popup/FedCM bridge and handshake, sandbox probe), `packages/federation/embed-api.mjs`, `tests/embed-api.test.mjs`, `tests/browser/embed-bridge.mjs`. The rest of `apps/embed/` (shell, runtime, worker, parts) belongs to the islands I-slices ([embed islands §19](embed-islands.md#19-implementation-breakdown-non-overlapping-ownership)) | A2, A3 |
| A6 SDK | `packages/sdk/src/{flows,identity}.mjs`, new `embed-controller.mjs` (no DOM: multi-session store, `prepare`, code validation), `fedcm.mjs`, `packages/sdk/test/*`. `elements/account.mjs` moves to islands slice I5 | A2/A3 contracts; mock-first |
| A7 Provider UI | popup document (single-document flow, activation delay, handshake UI states), console "Sign out of all apps" and app-session list | A3, D2 |

Evidence before completion: `npm test`; DOM tests that observe no state-dependent messages; real Chromium (FedCM in frame on/off), Firefox and WebKit with third-party cookies blocked, cleared site data, private windows, popups blocked, app `COOP: same-origin` and `same-origin-allow-popups`, sandboxed and credentialless frames, an app that opens the sign-in URL itself, an app that navigates the frame mid-flow, and spoofed messages; R1 measured in clicks per browser.

## 22. Open questions and coordinator recommendations

Coordinator recommendations, recorded as **provisional pending user sign-off**:
- Q1 Lifetimes: 30-day absolute and 7-day idle for persistent refresh and embed credentials.
- Q2 Provider first-party sign-out does not revoke app sessions; add an explicit console "Sign out of all apps".
- Q3 Persistence on by default, with DPoP binding required.

Remaining questions for the user:
- Q4 Is it acceptable that the FedCM-in-frame dialog names the provider's embed host rather than the app (§11.3), or should Chromium also use the popup by default until evidence?
- Q5 Embedders with `COOP: same-origin` lose the confidential frame (plain mode). Acceptable, with integration guidance to use `same-origin-allow-popups`?

## 23. Review reconciliation

### Round 1 (revision 1)

AS-R1 (blocker, client-asserted `embedJkt`) is resolved by the user's decision: the frame creates the entry and opens the window, and attestation comes from the handshake plus `targetOrigin` delivery (§7–8). Confidentiality is restored. Other round-1 fixes carried into revision 2: R2 auto-selected FedCM → memory-only, no embed (§5, §12); R3 FedCM cookie path and pages (§11.2, §11.5); R4 B2 claim checks are subsumed by the handshake and dedicated origin; R5 dedicated embed origin (AS-1); R6 lazy FedCM cookie install and "Continue as" login page; R7 late-failure fallback (§20.2); R8 frame controls never use app-run FedCM (§13.1); R9 moot (the frame never accepts entries from the app); R10 refresh races (§12); R11 wrong key rejected, not revoked (§6.3); R12 factual corrections (§4.1, §6.1, §18); R13 clickjacking limits stated (§13.2); R14 embed credential tied to app session (§3, §7.4); R15 FedCM cookie session-class (§11.5).

### Round 2

A fresh reviewer re-attacked the binding, delivery and COOP change (review file, "Round 2 review"). The core binding held: no app-side or server-side path obtained an embed credential bound to the attacker's key. Fixes:

| Finding | Resolution |
| --- | --- |
| AS-R2-1 plain mode stays in the `unsafe-none` page | No account state before the handshake; plain mode `location.replace`s to a `COOP: same-origin` page; decisions on `embed-popup` entries require the handshake's per-page secret (§7.3, §9) |
| AS-R2-2 app `COOP: same-origin` forces noopener | Frame reports `unavailable`; SDK keeps the pending record until callback or expiry; guidance for `same-origin-allow-popups` (§7.2) |
| AS-R2-3 detached-form probe always "sandboxed" | Dropped; `document.domain` + `origin` only; documented as a usability guard (§10.2) |
| AS-R2-4 fallback still activates a credential | Popup carries a key-bound single-use claim, redeemed by the frame with a proof; no claim redemption, no credential (§7.4, §11.3) |
| AS-R2-5 attestation not tied to the page | Per-page secret from `embed-verify` required on decisions; ≥128-bit entry IDs; no lookup by state; same checks on `done` (§7.1, §7.3, §7.4) |
| AS-R2-6 origin-level code delivery | `frame-ancestors` from redirect-URI origins; forward only when parent origin equals the entry's redirect origin; auth.md reworded to "unless delivery to the component is attested by proof of the component's key" (§6.2, §7.5) |
| AS-R2-7 FedCM in frame | `mediation:'required'`; server nonce in the key proof (§11.3); Q4 stays open |
| AS-R2-8 embed-origin hygiene | Added to T2; blank-then-navigate opening (§7.2) |
| AS-R2-9 intent from app; entry spam | Intent from the clicked control; lazy entries; per-client budget (§6.2, §7.1) |
| AS-R2-10 overstated "app learns nothing" | Residuals stated (§8.2) |

Still unverified (browser evidence): per-engine COOP behaviour, the origin the FedCM dialog names for a framed caller, FedCM cooldown keying, Android process isolation, and opener retention on iOS.
