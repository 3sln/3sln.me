# 3sln.me components profile v1 — provisional draft

**Profile identifier:** `https://3sln.me/artefacts/profiles/components/v1`

Status: **provisional draft, 2026-10-14, revision 2** (after independent review; [review](../release/components-profile-review.md)). Nothing in this profile is implemented, routed or production-verified. Publication of this text does not imply that any provider, including 3sln.me, conforms to it. The identifier resolves to the machine-readable descriptor [components-profile-v1.json](../architecture/artefacts/components-profile-v1.json), registered as a provisional manifest profile in the [contract registry](/artefacts/contracts/). Registration is not sign-off and implies no conformance. Decision record and rationale: [components profile decision note](../architecture/components-profile.md).

This profile is published by 3sln.me. **It is not part of the Bindle specification.** Bindle defines interop and no user interface. This profile defines what a Bindle provider must implement so that the `@3sln/bindle` custom elements (or any other embedder library that implements the element side of this profile) can embed **provider-operated components** ("islands") in an application page. It covers the wire contract between the embedder's elements and the provider's islands, and the security properties a provider must guarantee when it claims support. How a provider draws its islands, and how its islands talk to its own server, are provider matters except where §9 names a credential-binding mechanism.

Providers that do not declare this profile still work with the elements: the elements then use only core Bindle features ([protocol §2](../spec/protocol.md#2-discovery-and-login)) and render their own, simpler UI from app-granted data.

MUST, SHOULD and MAY express requirements of this draft. "Provider" means the Bindle issuer that declares the profile. "Element" means embedder-side code that implements this profile. "Island" means a provider document loaded in an iframe on the embed origin. "Embedder" means the application page and all script in it.

## 1. Relationship to core Bindle

- The profile is declared in the issuer's manifest under the core `profiles` container ([protocol §2](../spec/protocol.md#2-discovery-and-login)), keyed by the identifier above. Core Bindle defines only the container and its processing rules; every member below is defined here.
- The profile relies on core features declared separately in the manifest: `authorization-entry.v1` (islands create authorization entries), optionally `fedcm.v1` (FedCM inside an island) and the flat DPoP metadata (`dpop_signing_alg_values_supported`) for the app's own refresh token.
- The profile is an optional enhancement above the core [conformance floor](../spec/protocol.md#2-discovery-and-login). Elements fully support providers that implement only the floor.
- The profile uses the core **component-origin envelope** ([auth](../spec/auth.md#presentation-transports-and-key-binding)): `embed_origin` is the declared component origin, which may create authorization entries and FedCM assertions for a registered client only together with the key proof of §9; codes may pass through it but reach the app only on the origin of the flow's registered redirect URI; component credentials never reach the app and never work at core endpoints.
- `authorization-entry.v1` is a proposed core feature whose wire text is not yet published (decision note CPS-6). Until it is, no provider can conform to this profile's flow parts, and this profile is a design target, not an implementable standard.
- Nothing in this profile changes consent, grants, token semantics or RPC authority. An app gets exactly the access its own code exchange grants, whichever path the user took.

## 2. Declaration

```json
"profiles": {
  "https://3sln.me/artefacts/profiles/components/v1": {
    "embed_origin": "https://embed.example.org",
    "protocol": [1],
    "parts": {
      "avatar": {"versions": [1]},
      "account-switcher": {"versions": [1], "fedcm": true},
      "sign-in": {"versions": [1], "fedcm": true}
    },
    "theme_tokens": ["surface", "surface-raised", "text", "text-muted", "accent", "on-accent", "border", "focus", "danger", "radius"],
    "credential_binding": ["key-binding.v1"],
    "manage_url": "https://example.org/console/apps"
  }
}
```

| Member | Required | Type and validation | If absent or invalid |
| --- | --- | --- | --- |
| `embed_origin` | Yes | ASCII serialization of an HTTPS origin: `new URL(v).origin === v`, no path, query, fragment, userinfo or IP literal. MUST differ from the issuer origin and from the embedder's own origin. | The whole profile declaration is ignored. |
| `protocol` | Yes | Array of 1–8 distinct positive integers: channel protocol versions (§5). | Profile ignored. No common version with the element: profile ignored. |
| `parts` | Yes | Object of at most 16 members. Keys match `^[a-z][a-z-]{0,31}$`. Each value is an object with `versions` (array of 1–8 distinct positive integers) and optional `fedcm` (boolean, default `false`). Unknown members of a part object are ignored. | Unknown part names are ignored. A part with no version the element implements is treated as absent. |
| `theme_tokens` | No | Array of token names from §7; unknown names ignored. | `[]`: islands use provider defaults and the element sends no tokens. |
| `credential_binding` | No | Array of binding identifiers (§9). Defined: `key-binding.v1`. Unknown identifiers ignored. | `[]`. Identity-bearing parts (`avatar`, `account-switcher`) are then treated as absent (§2.1). |
| `manage_url` | No | HTTPS URL on the **issuer** origin, no userinfo or fragment. Target of the elements' "Manage" link. | Elements link to the issuer origin root. |

Unknown members are ignored. The serialized declaration is bounded by the core `profiles` limit (8 KiB).

### 2.1 Cross-checks

An element applies these after member validation; each failure removes only the named capability:

- `sign-in` and `account-switcher` require core `authorization-entry.v1` with the `login` intent, because their flows create authorization entries. Without it they are absent.
- `avatar` and `account-switcher` render account data held by islands. They are absent unless `credential_binding` names a binding the element recognizes as meeting §9 (v1: `key-binding.v1`).
- A part's `fedcm: true` is honored only if the manifest also declares core `fedcm.v1`, the element runs where `IdentityCredential` exists, **and** the issuer is the app's configured default provider or listed in the app's island allowlist (`island-issuers`). Otherwise the element does not delegate `identity-credentials-get` to that island, because a hostile island could run FedCM against any identity provider over the app's page.

### 2.2 Embed origin rules (provider)

- The embed origin MUST be dedicated to islands: it serves no console, login, consent or user-generated content, sets and reads no cookies, and serves islands for **exactly one issuer**.
- It SHOULD be same-site with the issuer (for example `embed.example.org` for `example.org`), which lets FedCM inside an island skip the well-known check ([adaptive sign-in §11.3](../architecture/adaptive-app-sign-in.md)). A cross-site embed origin MUST be listed in the issuer's FedCM well-known file if any part declares `fedcm: true`.
- The embed origin MUST NOT receive the app's PKCE verifier, access or refresh tokens, or DPoP keys. It handles authorization codes only transiently (§8).
- Component data is scoped to `(issuer, client_id)`, not to the browser partition: every island read of bindings, labels or avatars MUST be filtered to credentials of this `client_id` that are live, so two clients on the same top-level site never see each other's users (review CPR-8).

## 3. Shell

```text
GET <embed_origin>/embed?client=<percent-encoded client_id>#<part>.v<version>
```

- The path `/embed` is fixed by this profile. `client` is the app's exact `client_id` at this issuer (pre-registered, or resolved through core `client-id-metadata.v1`). The fragment is exactly one part name and one part version the element selected from the declaration (highest common), for example `#sign-in.v1`; the island implements that version's props, sizing and outbound set, and ignores any later `location.hash` change.
- The response MUST be byte-identical for every user of a client and MUST NOT depend on cookies or request credentials. It MUST send `Content-Security-Policy` with `frame-ancestors` set to the exact origins of the client's registered redirect URIs, and `script-src` limited to the embed origin (no third-party script); `Cache-Control: private, max-age=300` (bounding staleness of `frame-ancestors` and the parts list after a registry change to 5 minutes while avoiding a provider request on every page view); `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; `Origin-Agent-Cluster: ?1`.
- For a client resolved through `client-id-metadata.v1`, the provider MUST NOT block the shell response on a metadata fetch (serve the inert document and resolve in the background), MUST rate-limit and negative-cache lookups per client host, and MAY serve the inert document to clients it has not reviewed, since a sign-in island would otherwise lend provider branding to any page. `frame-ancestors` for such clients is the `client_id` origin.
- For an unknown client, a part outside the profile's declared parts, or a part the client's registration excludes, the provider MUST serve a constant inert document that sends no message (so the element's handshake times out, §5.1) with `frame-ancestors 'none'` for unknown clients.
- A part's island MUST work at any iframe size within the part's range (§6) and MUST NOT navigate itself, change `location.hash` effectively, or load nested frames.

### 3.1 Iframe the element creates

```html
<iframe src="<embed_origin>/embed?client=<client_id>#<part>"
        name="bindle-island;v=1;n=<nonce>;l=<lang>;cs=<light|dark>"
        title="<localized part title>" referrerpolicy="no-referrer" loading="eager"
        allow="identity-credentials-get <'src' only when §2.1 allows, else 'none'>; storage-access 'none'; browsing-topics 'none'; attribution-reporting 'none'; shared-storage 'none'; join-ad-interest-group 'none'; run-ad-auction 'none'; private-aggregation 'none'; sync-xhr 'none'"></iframe>
```

- `name` matches `^bindle-island;v=1;n=[A-Za-z0-9_-]{22};l=[A-Za-z0-9-]{1,35};cs=(light|dark)$`. The nonce is 128 random bits, base64url. The island reads `window.name` once and clears it.
- `allow` names `'none'` for every feature whose default allowlist is `*` that islands do not need (the list above, extended as browsers add such features), because omitting a feature does not disable it.
- **Sandbox (pending browser evidence).** The target is `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"` (no top navigation, modals, downloads or forms), once evidence shows that FedCM in the frame, partitioned storage, Web Locks and opener-preserving popups work under it in Chromium, Firefox and WebKit; the island's sandbox probe must then treat exactly a non-opaque sandbox as normal. Until that evidence exists, the element sets no `sandbox` and relies on provider rule P8 (§10). The element never sets `credentialless`, and MUST tear the island down if the embedder adds `credentialless` or a different `sandbox` or changes `src`, `name` or `allow` (observed with a `MutationObserver`), or if the iframe fires a second `load` (the element sets `src` before inserting the iframe so the initial `about:blank` does not count; needs browser evidence).
- Sizes are set by the element or the embedder (§6). The element MUST NOT derive any size from island content.

## 4. Theme, locale and scheme before the handshake

The `l` and `cs` values in `name` let the island render static, account-independent UI before the handshake. The island MUST NOT open storage, use keys or make credentialed requests before it has sent `ready` (§5.1).

## 5. Channel

### 5.1 Handshake

1. On the iframe's first `load`, the element posts exactly one window message to `iframe.contentWindow` with `targetOrigin` equal to the declared `embed_origin` (never `'*'`), transferring one `MessagePort`:

   ```json
   {"v":1, "type":"bindle-island-init", "nonce":"…", "part":"sign-in", "version":1,
    "theme":{"seq":0, "tokens":{}}, "locale":"en", "colorScheme":"light", "props":{"seq":0}}
   ```

2. The island accepts only the first message where `event.source === window.parent`, `event.origin` is an allowed parent origin for the client, the key set is exact, `part` and `version` equal its fragment, the nonce equals the one from `name` (constant-time comparison), exactly one port is transferred and every field validates. It then stops listening to window messages.
3. The island replies on the port, before any storage access, leader election or credentialed request:

   ```json
   {"v":1, "type":"ready", "part":"sign-in", "version":1, "protocol":[1], "issuer":"https://example.org"}
   ```

   `issuer` is the issuer this embed origin serves. `ready` is identical in every account state.
4. The element MUST tear the island down and render its fallback (and treat that part as degraded for the issuer for the rest of the document's life) if `ready` does not arrive within 3 seconds of `load` (on timeout the element first drains one macrotask and accepts a `ready` whose `event.timeStamp` falls within the window, so an embedder long task does not cause a spurious degradation), if `part` or `version` differs, if `protocol` has no version in common, or if `issuer` is not exactly the issuer whose manifest declared this embed origin. An `issuer` mismatch disables **every** part of that declaration for the document.

### 5.2 Message rules (both directions)

- Plain structured-clone data only. The receiver rejects any value whose prototype is not `Object.prototype` or `Array.prototype` at any depth, and any `Blob`, `ArrayBuffer`, typed array or `MessagePort`.
- Every message has `v` and `type` and an exact key set per (part, version, type). Size is measured as UTF-8 bytes of its JSON serialization: at most 8 KiB for `prepare` and `bindle-island-init`, 4 KiB for `code`, 2 KiB for every other type. Strings are bounded as listed.
- State messages (`theme`, `locale`, `scheme`, `props`, `session`, `prepare`) are last-value-wins: the receiver applies the latest of each type on its next task, so none is lost. `session` and `forget` are never rate-limited. Other types are limited to 10 per second per port; excess messages are dropped.
- There are no error replies. After 3 schema violations within a minute, the element tears the island down and the island stops reading the port.
- The element drops (and counts as a violation) any outbound type not listed for that part in §5.4.

### 5.3 Inbound (element → island)

| `type` | Parts | Fields | Rules |
| --- | --- | --- | --- |
| `bindle-island-init` | all | `v`, `nonce`, `part`, `version`, `theme`, `locale`, `colorScheme`, `props` | Window message, §5.1. |
| `theme` | all | `v`, `seq` (uint32, increasing), `tokens` (≤16 entries) | §7. |
| `locale` | all | `v`, `lang` (BCP 47, ≤35 chars) | Resolved against the island's catalogues, falling back to `en`; `dir` follows the locale. |
| `scheme` | all | `v`, `colorScheme` (`light`\|`dark`) | The element MUST send it on every change of its resolved scheme, including ``prefers-color-scheme`` media changes and embedder `color-scheme` changes it detects. |
| `props` | all | `v`, `seq`, part-specific fields (§6) | Enums and keys into the provider's own catalogue only. No embedder free text ever reaches an island. |
| `session` | all | `v`, `subject` (HTTPS URL ≤2048 on the issuer origin) or `null` | The app's current subject **at this issuer**. No reply and no network or crypto work in the island. |
| `prepare` | `sign-in`, `account-switcher` | `v`, `redirectUri`, `challenge` (base64url S256, 43 chars), `state` (43 chars), `requests` (bounded as the core entry schema), optional `loginHint` (≤320), `uiLocales` (≤4 tags), `colorScheme`, `dpopJkt` (RFC 7638 thumbprint of the **app's** DPoP key) | Public flow inputs only. Stored, never acted on, and never rendered: `loginHint` is embedder-supplied text that islands pass only to the provider's entry endpoint as an untrusted hint. The intent always comes from the control the user activates in the island. The element sends a fresh `prepare` after every flow end. |
| `forget` | all | `v`, optional `subject` | The only state-reducing inbound message: the island deletes this client's local component credentials in its partition (only for `subject` if given). It cannot add, approve, select, open a window or reveal anything. |

No inbound message makes an island start a flow, open a window, select an account, move focus, navigate or write to the network (except `forget` ending component sessions). Every action requires a trusted user activation inside the island.

### 5.4 Outbound (island → element), per part — the events contract

| Part | `type` | Fields | When the island sends it | What the element may rely on |
| --- | --- | --- | --- | --- |
| all | `ready` | `v`, `part`, `version`, `protocol`, `issuer` | Once, after a valid init (§5.1). | The island is live. Nothing about account state. |
| `sign-in`, `account-switcher` | `flow` | `v`, `phase` (`started`\|`ended`), `outcome?` (`completed`\|`canceled`\|`popup-blocked`\|`unavailable`) | `started` when a user-activated flow begins in the island; `ended` exactly once per `started`. Intents: the `sign-in` control and the switcher's "Use another account" use `login` (no hint; the provider shows its full account chooser). | Generic outcome only. `unavailable` means "use your own path" (sandboxed, opener lost, storage blocked) and is never more specific. `completed` is followed by `code` before `ended`. |
| `sign-in`, `account-switcher` | `code` | `v`, `code` (≤2048), `state`, `iss` | After a completed island flow, only if the parent origin verified at init equals the origin of the `prepare.redirectUri` used for that flow. | An authorization code for the app's own PKCE exchange. The element validates it exactly as callback parameters against its pending record (state, issuer, single use) and exchanges it with its verifier. |
| `account-switcher` | `select` | `v`, `subject` | The user picked another account in the switcher, for a subject whose component binding was created by a flow that delivered a code to this `client_id`. | A subject the app may already hold a session for. The element acts on it only if it holds a live app session for exactly that `(issuer, subject)`. |
| `account-switcher` | `escape` | `v` | Escape pressed in the island, or a close request handled by the island. | Close the container. |
| `account-switcher` | `dismiss` | `v` | The island's own close control, or a provider tab opened from the island. | Close the container. |
| `avatar` | — | — | Sends nothing after `ready`. | — |

**Island-side entitlement invariant (provider MUST).** Embedder script can read the raw port, so every outbound field MUST be something the app is entitled to before it leaves the island. Islands MUST NOT send, by any message or observable side effect they control: sizes, row counts, which bindings exist, labels, avatar or load status, focus position or arrow-key edges, leader status, restore results or error reasons.

## 6. Parts (v1)

General sizing contract: the element or embedder chooses each iframe's size from attributes, CSS and the viewport only. The island lays out within that box, never reports a size and never scrolls an embedder-owned scroller.

| Part | Version | Interactive | Element sizing (range the island MUST support) | `props` | Outbound |
| --- | --- | --- | --- | --- | --- |
| `avatar` | 1 | No. The element sets `aria-hidden="true"`, `tabindex="-1"` and `pointer-events:none`. | Square or rectangular, 16–512 CSS px per side. The picture is centered and as large as fits. | `{}` | none after `ready` |
| `account-switcher` | 1 | Yes | 280–480 px inline × 200–480 px block; v1 element defaults 320 × 320 (`regular`) or 320 × 248 (`compact`). | `{density: 'regular'\|'compact', actions: subset of ['use-another','manage','remove']}` | `flow`, `code`, `select`, `escape`, `dismiss` |
| `sign-in` | 1 | Yes | Block 44–56 px (element default 44, or 48 with a coarse pointer); inline ≥200 px. | `{label: 'continue'\|'sign-in'\|'sign-up', variant: 'filled'\|'outline'}` | `flow`, `code` |

- **avatar.** Paints a transparent background and draws only the picture of the app's current `session` subject when it holds an active component binding for it; otherwise it draws nothing. The element always renders its own standard avatar (granted picture, initials or monogram) underneath the island, so enabling the island never replaces initials with a different fallback, and a bound picture simply covers it. (Transparent cross-origin frames over embedder content need browser evidence; the iframe and island set the same `color-scheme` so no opaque backdrop is painted.) Image bytes MUST NOT be loadable by the embedder (no CORS, `Cross-Origin-Resource-Policy: same-origin`, `no-store`) and MUST arrive without changing the iframe's load events.
- **account-switcher.** Shows the current account card, other accounts the island holds bindings for in this partition, and the actions in `props.actions`. Its UI MUST name the provider host and SHOULD state that the app cannot see the list. "Use another account" starts an island flow (§8). "Manage" opens a `noopener` top-level provider page. "Remove" requires a second in-island confirmation and deletes only the island's own binding.
- **sign-in.** One provider-labelled control that starts an island flow with intent `login`.

New parts and new part versions may be added to v1 declarations without a new profile identifier; elements ignore what they do not implement.

## 7. Theme tokens (v1 allowlist)

| Token | Grammar |
| --- | --- |
| `surface`, `surface-raised`, `text`, `text-muted`, `accent`, `on-accent`, `border`, `focus`, `danger` | `^#[0-9a-f]{6}$` (opaque, canonical lowercase) |
| `radius` | integer 0–16 (CSS px) |

- The element sends only tokens that are both in this allowlist and in the declaration's `theme_tokens`, after validating them. The island MUST validate again and MUST NOT trust the element.
- Contrast: if any of these pairs falls below its minimum, the island reverts both members to its defaults: `text`/`surface` 4.5, `text-muted`/`surface` 4.5, `text`/`surface-raised` 4.5, `text-muted`/`surface-raised` 4.5, `on-accent`/`accent` 4.5, `danger`/`surface` 4.5, `danger`/`surface-raised` 4.5, `accent`/`surface` 4.5, `accent`/`surface-raised` 4.5, `focus`/`surface` 3, `focus`/`surface-raised` 3, `border`/`surface` 3, `border`/`surface-raised` 3.
- Tokens MUST NOT affect size, visibility, opacity, position, z-index, row count or which controls exist. Trust-bearing text (provider host, "the app can't see this", warnings) uses a fixed provider palette. Under `forced-colors: active` tokens are ignored.
- Fonts, font scale, density and color scheme are not tokens. Density is a `props` value; scheme is the `scheme` message.

## 8. Island-initiated flows and code delivery

1. The element sends `prepare` with fresh PKCE and `state` for the issuer of that island, and keeps its pending record (verifier, state, issuer, endpoints) exactly as for an app-started flow.
2. On a trusted activation of a flow control, the island creates the authorization entry at the core `authorization-entry.v1` endpoint itself, with the `prepare` inputs, the intent of the activated control, and any members its credential binding defines (§9). It MUST NOT accept an entry identifier, URL or key thumbprint from the element.
3. The island opens the provider's authorization page in a popup or uses FedCM inside the island. Every approval happens in a top-level provider document or the browser's FedCM dialog, never inside the island.
4. On completion the island sends `code{code, state, iss}` only if the parent origin verified at init equals the origin of the flow's `redirectUri`, and the provider re-checks that `redirectUri` is registered for `client_id`. The code is bound to the app's PKCE challenge, `state`, issuer and `redirectUri` at exchange.
5. If the island cannot complete (popup blocked, opener lost, sandboxed), it sends `flow{ended, outcome}` and the element MAY continue on its own path (app-opened popup or redirect), which yields app credentials only. A popup opened by the island that loses its opener completes to the app's registered callback as an ordinary authorization.

## 9. Component credentials and credential binding

Requirements for every provider that declares this profile with an identity-bearing part:

- **C1.** Credentials that authenticate islands (component credentials) MUST NOT appear in any redirect, token response, callback parameter or message the app can receive, and MUST NOT be accepted at the token, revocation or RPC endpoints (core rule).
- **C2.** A component credential MUST be issued only after delivery to an island has been attested by a fresh proof of possession of a key that was generated inside the embed origin and is not extractable, and MUST be bound to that key, the `client_id` and the approving account.
- **C3.** A component credential becomes usable only when the paired authorization code is exchanged, and MUST be revoked with that app session (connection revocation, RFC 7009 revocation of its refresh token, refresh-token reuse, account recovery, suspension or deletion).
- **C4.** Component credentials authorize only display of the bound account's identity in islands. They never authorize RPC, grants, consent, preferences or provider session changes.
- **C5.** Authorizations completed without a user choice (for example an auto-selected FedCM assertion) MUST NOT yield a component credential.

`credential_binding` names the mechanism that meets C2–C5. Elements recognize only identifiers listed here.

### 9.1 `key-binding.v1`

Normative for providers that declare it. Rationale and attack analysis: [adaptive app sign-in §6–§8, §11](../architecture/adaptive-app-sign-in.md).

- **Key.** The island generates an ECDSA P-256 key with `extractable:false` per `(issuer, client_id)`, stored in its partitioned storage (in memory if storage is unavailable). `embedJkt` is its RFC 7638 thumbprint; it is never sent to the element.
- **Entry members.** The island's entry POST adds `embedJkt` and `delivery` (`"embed-popup"` or `"embed-fedcm"`). The provider stores both and trusts neither until attestation. Entries created by app code with these members MUST be refused.
- **Popup attestation.** The island opens the popup within its own activation, unnamed and without `noopener`. The provider's popup document renders no account state until it has posted `{v:1, type:"bindle-embed-hello", entry, challenge}` to `window.opener` with `targetOrigin` = embed origin and received `{v:1, type:"bindle-embed-proof", proof}` from its opener, where `proof` is an ES256 JWS with header `jwk` whose payload carries `htu` (the provider's verification URL), `nonce` (the single-use, ≤60 s server challenge), `entry`, `iat` and `jti`. The provider verifies `jkt(jwk) == entry.embedJkt`. Without a valid proof within 3 s the popup continues as an ordinary authorization in a `COOP: same-origin` document and no component credential is ever issued for that entry.
- **Delivery.** After approval the popup posts `{v:1, type:"bindle-embed-done", entry, code, state, iss, claim}` to `window.opener` with `targetOrigin` = embed origin. `claim` is single use, valid ≤2 minutes and redeemable only with a fresh proof from the entry's key. The island accepts hello and done messages only from its own popup handle, from the issuer origin, for its own pending entry, with exact schemas.
- **FedCM inside an island.** `navigator.credentials.get({identity:{providers:[{configURL, clientId, params:{v:1, entry, proof}}], mode:'active'}, mediation:'required'})` with the RP being the embed origin. The provider's assertion endpoint requires `Origin` equal to the embed origin, `delivery == "embed-fedcm"` and `jkt(proof.jwk) == entry.embedJkt`, and returns `token` = the JSON text `{"v":1,"code","state","iss","claim"}`; for `is_auto_selected=true` it omits `claim` (C5).
- **Claim redemption and restore.** The island redeems `claim`, and later restores sessions, with DPoP-style proofs (RFC 9449 shape, server nonce, `ath` over the credential) from the same key. A valid proof from a different key is rejected without revoking anything.

Paths and lifetimes of the provider's embed API are provider-internal.

## 10. Requirements summary

**Provider (P):**
1. Dedicated, cookieless embed origin serving exactly one issuer; `ready.issuer` is that issuer (§2.2, §5.1).
2. Shell rules of §3, including `frame-ancestors` from registered redirect-URI origins and no third-party script.
3. No action from inbound messages; every action needs a trusted activation inside the island; every approval in a top-level provider document or the FedCM dialog (§5.3, §8).
4. Outbound messages only as §5.4, with the entitlement invariant.
5. Constant messages, sizes and pre-`ready` work in every account state.
6. Component credentials per §9.
7. Theme validation per §7.
8. Islands never navigate any browsing context other than their own popup, never call `requestStorageAccess()`, never open modal dialogs (`alert`, `confirm`, `prompt`, `print`) or start downloads, contain no text inputs, never trap keyboard focus (Tab always leaves the island), and never draw content imitating the embedding app.
9. Islands never `postMessage` to `window.parent`, `window.top` or any embedder window after the handshake; all traffic uses the port.
10. Component data filtered by `(issuer, client_id)` (§2.2); the `sign-in` island performs no storage access and no network request after loading the shell until a user activates it.

**Element (E):**
1. Use declaration values only from the manifest of the issuer the operation is bound to; never combine members from different issuers (§11).
2. Exact `targetOrigin` from the validated declaration; never `'*'`.
3. Validate every port message (§5.2) and translate it; never forward raw island data to app event detail.
4. Send `session`, `prepare` and `forget` only to islands of the issuer they concern. Never send a subject, `state` or `challenge` of one issuer to another issuer's islands.
5. Tear down on timeout, violation, `ready` mismatch, attribute mutation or second `load`, and degrade that part for the document (§5.1).
6. Mount islands of an issuer other than the app's current session issuer or configured default provider only after the user chose that provider.
7. Install no window `message` listener for islands beyond what the handshake needs (none: the element posts init and listens only on the port).
8. Keep pending authorization records keyed by `state`; records for island flows live in memory; accept `code` only on the port that received the matching `prepare`, only between that island's `flow{started}` and `flow{ended}`.
9. Before an island started from an unverified `embed-origin` hint is verified against the issuer's declaration, send it only `bindle-island-init` (no `session`, `prepare` or `forget`).
10. Close the container when focus leaves the island and the panel (focus traps are a provider violation the element cannot prevent).

## 11. Declaration processing (elements)

- The declaration is read from the issuer's validated manifest, fetched as core Bindle requires (HTTPS, no cookies, no redirects, bounded). Elements fetch it with `cache: 'no-cache'` (so a shared HTTP cache cannot extend its life) and keep it in memory only, for at most the manifest's HTTP freshness lifetime capped at one hour (default five minutes), and use one snapshot from flow start to code exchange.
- An optional embedder hint of the embed origin may start an island early only for the configured default provider. It is verified against that issuer's declaration when discovery completes; on mismatch every island started from the hint is torn down.
- A part that fails at runtime is degraded for that issuer until the document is reloaded. Degradation is never persisted, never applied to another issuer and never reversed by a later message.

## 12. Versioning

The semantics at this identifier are immutable once signed off. Additive changes within v1: new part names, new part versions, new optional declaration members and new `credential_binding` identifiers, all ignored by elements that do not implement them. Any change to existing message shapes, handshake, requirements or validation that an existing element or provider could misread requires a new channel `protocol` version or a new profile identifier.

## 13. Conformance checks

Providers: shell headers and inert responses for unknown clients and parts; `frame-ancestors` under registered, unregistered and nested parents; `ready` constant and first; `ready.issuer` correct; no outbound message types beyond §5.4 under fuzzed inbound traffic; no action from inbound messages; code delivered only to the redirect origin; component credential refused at token, revocation and RPC endpoints; key-binding attestation refused with another key, without an opener, and for app-created entries; identical sizes, load events and message sequences for 0 and many bindings.

Elements: targetOrigin equals the declaration; handshake timeout and mismatch teardown; cross-issuer isolation of `session`/`prepare`; code validation identical to callbacks; translation without raw payloads; degradation scoped per issuer and document.

## Appendix A. Monogram (shared fallback picture)

Elements render this as their last-resort avatar. Islands in v1 draw no fallback (§6), but any island that draws an identity fallback or colour MUST use this derivation so standard and enhanced compositions match.

Input: the subject URL string `s` (1–2048 UTF-16 code units). `fnv(text, seed)` is 32-bit FNV-1a over UTF-16 code units with initial value `seed` (default `0x811c9dc5`) and prime `0x01000193`. Let `a = fnv(s)` and `b = fnv(s, a XOR 0x9e3779b9)`. For row `r` and column `c` in 0–4, let `k = r*3 + (c < 3 ? c : 4 - c)` (0–14); the cell is on when bit `k` of `a` is 1 (15 bits of `a` are used). If no cell is on, the center cell is on. The cell pattern is the one `monogramPattern` in `@3sln/bindle` computes.

**Colour (shared with the elements' initials and monogram).** `index = b mod 24` (independent of the pattern bits), `hue = index × 15 + 7.5`. The tile background and the on-cells use these OKLCH tones for the scheme received in `scheme` (or `cs` before the handshake): light background `oklch(0.93 0.03 hue)`, cells `oklch(0.40 0.065 hue)`; dark background `oklch(0.36 0.06 hue)`, cells `oklch(0.93 0.03 hue)` (all inside the sRGB gamut for the 24 hues). Foreground on background is at least 4.5:1 for every hue in both schemes. Under `forced-colors: active` the tile uses `Canvas`, `CanvasText` and a `CanvasText` border. These values are provisional until the shared contrast test fixes them; islands and elements MUST use the same table.
