# Components profile and provider-agnostic elements: decision note

Status: **provisional design, 2026-10-14, revision 2.** Revision 1 was reviewed independently (21 findings); revision 2 answers each finding (§14). No human sign-off is implied. Nothing here is implemented, routed or production-verified. It is a 3sln.me profile and `@3sln/bindle` SDK design plus targeted core-spec edits. The coordinator records decisions in DEVLOG.md. Independent review: [components-profile-review](../release/components-profile-review.md).

Architecture/security/product sign-off: reviewer ___ / date ___ / outcome ___.

Deliverables: the profile [docs/profiles/components-v1.md](../profiles/components-v1.md) (identifier `https://3sln.me/artefacts/profiles/components/v1`), its machine-readable descriptor [components-profile-v1.json](artefacts/components-profile-v1.json), and targeted edits to [protocol §2](../spec/protocol.md#2-discovery-and-login) and [auth](../spec/auth.md#presentation-transports-and-key-binding). Builds on [adaptive app sign-in](adaptive-app-sign-in.md), [embed islands](embed-islands.md), [embeddable elements](embeddable-elements.md) and the SDK in `packages/sdk/src/`.

## 1. User direction (followed exactly)

1. The custom elements and sign-in flow work with **any** Bindle provider: 3sln.me, third-party, or self-hosted (this same codebase).
2. Elements and UI are not part of the Bindle spec. Provider-operated components are governed by a 3sln.me-published sub-spec. A provider declares support in its manifest before the elements use it. Undeclared providers still work, with a simpler UI.
3. **Granular declaration (clarification).** The manifest declares which spec features, intents, embed host, island parts (each versioned), theme tokens and credential-binding profiles the provider supports. Elements compute behaviour **per feature** and render their best composition from what is available. Full/standard/minimal are illustrative cases, not the logic. Validation and caching are defined: bounded size, unknown fields ignored, runtime failure degrades a feature for the session, no cross-provider mixing. Core stays minimal and generic; feature identifiers are stable and versioned.
4. **Conformance floor (clarification).** Core states the minimum: a valid manifest, the code + PKCE redirect flow, exact issuer binding, registered callbacks. Below it, elements report an unsupported provider. Only a definitive 404/410 offers the fallback provider; errors never switch providers. Core-only providers are fully supported with the standard UI. The profile is an optional enhancement.
5. **Standard-UI profile button (clarification).** With at least a granted display name or handle, the composed profile button shows an initials avatar (display name abbreviated, else the handle's local part), grapheme-aware and robust for caseless scripts, emoji and bidi, with a deterministic colour from a stable identifier, never the display name.

6. **Scheme-aware identity colour (addition).** Stable hue from the identifier, separate light and dark tones tuned in OKLCH with fixed lightness and chroma, ≥4.5:1 text contrast in both schemes, following the element's effective scheme live, shared by islands, system colours in forced-colours mode, and applied to `<bindle-monogram>` (audit only).

## 2. Decisions

| ID | Decision | Section |
| --- | --- | --- |
| CP-1 | Core manifest gains two generic containers: `features` (Bindle-defined, versioned identifiers `name.vN`) and `profiles` (third-party, keyed by absolute HTTPS URI). OAuth-registered capabilities (`revocation_endpoint`, `dpop_signing_alg_values_supported`, `grant_types_supported`) stay flat under their RFC names. | §3, protocol §2 |
| CP-2 | Core feature registry v0: `authorization-entry.v1`, `fedcm.v1`, `intents.v1`, `client-id-metadata.v1`, each with a defined default when absent. Links-owned features (`link-responses.v1` and others) are added by the links slice. | §3.2 |
| CP-3 | `embed_origin`, `embed_profiles_supported`, island parts, the channel, theme tokens, events and the key-binding mechanism move out of core into the components profile. Core keeps only the envelope: component credentials never reach clients or core endpoints; extra code-delivery channels keep PKCE/state/iss/redirect binding and deliver only to the redirect URI's origin. | §3.1 |
| CP-4 | Profile identifier `https://3sln.me/artefacts/profiles/components/v1` (replaces the server constant `…/profiles/embed/v1`). | profile |
| CP-5 | The island `ready` message carries `issuer` (and the part version); one embed origin serves exactly one issuer. Elements tear down on mismatch. This is the cross-provider mixing defence. | profile §5.1 |
| CP-13 | Core gains a narrow **component-origin envelope** (auth): a profile-declared origin may create entries and FedCM assertions for a registered client only with a profile-defined key proof; codes may transit it but reach the client only on the redirect origin. This resolves the core/profile contradiction (CPR-2). | auth, profile §1 |
| CP-14 | Islands get explicit `'none'` for default-allowed powerful features, provider rule P8 (no top navigation, storage access, modals, downloads, inputs, focus traps, app imitation) and a target sandbox token set pending browser evidence (CPR-5). | profile §3.1, §10 |
| CP-6 | Elements compute a frozen per-issuer **capability set** from the declaration and runtime degradations; every element composes from it. | §5 |
| CP-7 | One element API in every composition. Event names, detail shapes and `state` fields are identical; only which events can occur differs, and that is documented per capability. | §6 |
| CP-8 | The composed profile button (one `<dialog>` container, popover or sheet, disclosure pattern) is used in every composition; the switcher region is the island when available and built-in buttons otherwise. This supersedes the phase-1 `role=menu` fallback in islands §8.1/§22. | §6.2 |
| CP-9 | Standard avatar: granted picture → initials (§7) → subject monogram. Initials, monogram and island fallbacks share one scheme-aware OKLCH colour derivation from the subject (§7.1). | §6.2, §7 |
| CP-10 | Without `select-account`, "Use another account" is re-authentication through the best available path, keeping the current session until the new one is ready; it never signs out first. | §6.2 |
| CP-11 | Cross-provider client identity: recommend HTTPS-URL client IDs; providers that declare `client-id-metadata.v1` need no pre-registration; others need registration of the same URL ID (or a per-issuer mapping in the SDK). | §8 |
| CP-12 | Islands from providers the user did not choose never mount; `island-issuers` lets an app restrict islands to an allowlist; FedCM delegation to islands only for the default provider or an allowlisted issuer. Default for other parts: any provider that declares the profile (Q1 reopened by CPR-5/CPR-13). | §6.5 |

## 3. Core versus profile

### 3.1 What sits where, and why

| Item | Where | Justification |
| --- | --- | --- |
| Manifest discovery, issuer equality, required endpoints, `login_presentation` (`redirect`, `popup`) | Core (unchanged) | Every client needs them; they are the conformance floor. |
| Conformance floor | Core | User direction 4. It defines when a host is a provider at all, which every client must decide the same way. |
| `features` container and its processing rules (bounds, unknown ignored, invalid → absent, runtime downgrade, no mixing, caching) | Core | A capability declaration is interop for all clients, including non-UI clients (CLIs, backends, other SDKs). |
| `profiles` container and its rules (URI keys, opaque members, cannot alter core) | Core | Needed so that third parties can extend the manifest without colliding with core names or each other. Core defines only the container. |
| `authorization-entry.v1` (endpoint, intents) | Core feature | Identity-optional sign-in, account selection, reauthentication and provider sign-out are useful to any client, with or without UI. |
| `fedcm.v1` (`config_url`) | Core feature | FedCM is a browser transport ending in the ordinary code; any browser client can use it. Must come from the issuer's own manifest. |
| `intents.v1` (`web+bindle` intents, `login_endpoint`) | Core feature | Interop between contact pages and any provider; not UI. Wire text stays in links.md. |
| `client-id-metadata.v1` | Core feature | Client identity across providers is interop (§8). |
| Revocation, DPoP, refresh grant | Core, flat RFC names | Standard OAuth metadata. Moving them into `features` would hide them from generic OAuth tooling. |
| FedCM `params` / token extension hooks | Core (generic wording) | The exchange shape is core; a profile may add members only for its components. |
| Component-credential envelope (never to clients; not accepted at token, revocation, RPC) | Core | It constrains core endpoints and protects every client, including ones that never embed components. |
| Profile-defined code delivery envelope (PKCE/state/iss/`redirect_uri` binding; only to the redirect URI's origin) | Core | It is the one place a profile touches the core authorization code; fixing the envelope keeps every delivery path as strong as the redirect. |
| `embed_origin`, shell path, iframe `name`, handshake, port messages, parts, sizing, theme allowlist, `manage_url` | Profile | Embedder-to-provider UI interop. Meaningless to non-UI clients; the user directed that UI is not in Bindle. |
| Component credential attestation and binding (`key-binding.v1`: `embedJkt`, `delivery`, opener handshake, claim, FedCM-in-island proof) | Profile | Exists only because components exist. Entry members it adds are allowed by the core rule that features and declared profiles may define entry members. |
| Island events contract (`flow`, `code`, `select`, `escape`, `dismiss`) | Profile | Element ↔ island interop. DOM event names are SDK API (this note §6), in neither spec. |
| Framing headers, COOP classes, popup activation delays | Provider policy (3sln: security.md reference-host section) and profile §3 minimums | How a provider protects its pages is policy; the profile states only the minimum an embedder relies on. |
| Generic DPoP key binding of app tokens (`dpopJkt`) | Core | Non-UI, protects every public client. |

### 3.2 Core feature registry and defaults

Normative text is in [protocol §2](../spec/protocol.md#2-discovery-and-login). Summary of defaults when absent: no entry → identity-pinned request only (complete handle required; no select-account, reauth or end-session); no `fedcm.v1` → popup/redirect; no `intents.v1` → plain intent links; no `client-id-metadata.v1` → pre-registration; no `revocation_endpoint` → local sign-out only; no DPoP metadata → memory-only refresh; no `popup` in `login_presentation` → redirect only.

### 3.3 Migration from flat draft names

| Draft name (emitted today) | New form | Emitter (owner) |
| --- | --- | --- |
| `authorization_entry_endpoint`, `authorization_entry_intents` | `features["authorization-entry.v1"] = {endpoint, intents}` | `packages/federation/authorization-entries.mjs:17` (authorization-entry implementer) |
| `embed_profiles_supported: ["https://3sln.me/artefacts/profiles/embed/v1"]` | `profiles["https://3sln.me/artefacts/profiles/components/v1"] = {embed_origin, protocol, parts, theme_tokens, credential_binding, manage_url?}` | same file, `:9`, `:17` |
| `fedcm_config_url`, `login_presentation` value `fedcm` | `features["fedcm.v1"] = {config_url}` | not emitted yet (A4 FedCM slice) |
| `intents_supported`, `intent_login_endpoint` | `features["intents.v1"] = {intents, login_endpoint}` | `packages/runtime/http.mjs:160` (links agent) |

The SDK reads only the new forms. Nothing is deployed, so there is no compatibility window.

## 4. Declaration processing

- **Fetch.** Unchanged core discovery (HTTPS, cookieless, no redirects, 64 KiB, 10 s).
- **Validate.** Required members fail closed (unsupported provider, no fallback). Each feature and profile is validated independently; failure removes only that capability and logs a development warning. Unknown keys and members are ignored. Bounds: 32 features ≤4 KiB each; 8 profiles ≤8 KiB each.
- **Cache.** Fetched with `cache:'no-cache'`; in memory, per issuer origin, for the manifest's HTTP freshness lifetime capped at 1 hour (default 5 minutes). Never persisted. A flow uses one snapshot from start to code exchange (the pending record already stores endpoints). Refetch is lazy, at the next flow or mount after expiry.
- **Runtime degradation.** A declared capability that fails in a way showing it is not implemented is marked degraded for that issuer until the document reloads: entry endpoint 404/405/501; island handshake timeout (after draining one macrotask and accepting a `ready` timestamped inside the window), schema violations or `ready` mismatch (per part; an `issuer` mismatch disables the whole profile); FedCM reporting `unavailable` twice for non-user reasons; token endpoint rejecting DPoP proofs (memory-only refresh for that session). Network and 5xx errors are retryable errors, not degradation. Degradations never persist, never cross issuers and never reverse within the document.
- **No mixing.** Every value used in an operation comes from the manifest of the issuer the operation is bound to: the current session's issuer, the default provider when signed out, or the provider the user typed. The `embed-origin` hint applies only to the default provider and is verified against its declaration.

## 5. Capability computation

`capabilities(issuer)` is a pure function of the validated declaration, the user agent and the degradation set. Elements read it; they never inspect the manifest themselves.

```text
; 1. remove degraded base inputs first, so dependent flags inherit the degradation
decl         = validated declaration minus degraded(issuer) entries
; 2. derive
entry        = decl.features["authorization-entry.v1"] present  ; intents = its intents, else []
login        = always (entry with 'login', else identity-pinned request needing a handle)
identityless = entry && intents ∋ login
selectAcct   = entry && intents ∋ select-account
reauth       = entry && intents ∋ reauthenticate
endSession   = entry && intents ∋ end-session
popupDeclared= login_presentation ∋ popup      ; whether a popup opens is known only at click time
fedcm        = decl.features["fedcm.v1"] && entry && 'IdentityCredential' in window
revoke       = revocation_endpoint valid
dpop         = dpop_signing_alg_values_supported ∋ ES256 && entry   ; entry carries dpopJkt (protocol §2)
profile      = decl.profiles[COMPONENTS_V1] valid (profile §2) && policy allows issuer (§6.5)
island.avatar   = profile && parts.avatar has a common version && binding recognized
island.switcher = profile && parts["account-switcher"] has a common version && binding recognized && identityless
island.signIn   = profile && parts["sign-in"] has a common version && identityless
island.*.fedcm  = part.fedcm && fedcm && (issuer is the default provider || issuer ∈ island-issuers)
manageUrl    = profile.manage_url valid ? it : issuer + "/"
```

Transport choice for any app-started flow (sign-in, switch, reauth, provider sign-out): FedCM if `fedcm` (sign-in and switch only), else a popup if `popupDeclared`, the app chose `presentation="popup"` and `window.open` succeeds inside the click, else redirect (a blocked popup follows the existing `popup-fallback` rule). Island controls map to intents as profile §5.4 states (`login` for sign-in and "Use another account"). A flow started inside an island uses the island's own transport (profile §8).

## 6. Element compositions and events

### 6.1 `<bindle-sign-in>` (signed out)

| Capability (of the default provider, then of the typed provider) | Renders | Click/submit does |
| --- | --- | --- |
| `island.signIn` | The `#sign-in` island as the primary control; the handle form behind "Use a different provider". | The island runs the flow and returns a code (profile §8). |
| no island, `identityless` | A "Continue" button for the default provider plus the handle form (handle optional). | App-started flow with intent `login`, no hint (or a hint if typed). |
| no `identityless` (no entry, or entry without `login`) | The handle form; a complete handle is required. | Identity-pinned authorization request. |
| Typed handle resolves to a provider with `island.signIn` | A provider-specific `#sign-in` island appears in place of the submit button and needs one more click inside it (user activation must happen in the island). | Island flow. |
| Typed host below the floor or malformed | Form with error "This provider isn't supported." | Nothing; no fallback. |
| Typed host returns 404/410 | Form with the named fallback offer (default 3sln.me, configurable or disabled). | `bindle-email-fallback` event. |

Events (all compositions): `bindle-sign-in-start {source:'island'|'form', presentation:'island'|'fedcm'|'popup'|'redirect'}`; `bindle-sign-in-end {outcome:'completed'|'canceled'|'unavailable'|'popup-blocked'|'discovery-error'|'network-error', code?, session?}` (one per start; `completed` only after the app credential is ready); `bindle-login-request`, `bindle-email-fallback` (unchanged). `state = {status, islands, last}`.

### 6.2 `<bindle-account>` (signed in): composed profile button

Structure is the same in every composition (islands §8.1 shell): trigger with avatar box (and optional label), one `<dialog>` container shown as an anchored popover or a sheet, slots `menu-header`, `menu-start`, `menu-end`, `panel-footer`, a `role=list` of actions (disclosure pattern).

| Region | Capability present | Renders | Capability absent |
| --- | --- | --- | --- |
| Avatar | `island.avatar` | The standard avatar chain is always rendered; the transparent `#avatar` island sits on top and covers it only with a bound picture (CPR-15). | Granted picture (`profile.picture`, HTTPS on the issuer origin, `referrerpolicy=no-referrer`, monogram on error) → initials (§7) from granted display name or handle → subject monogram. |
| Label (`trigger="avatar-label"`) | — | Granted display name or handle, else "Signed in · host". Never island data. | same |
| Switcher | `island.switcher` | `#account-switcher` island (mounted on intent) holding "Use another account", "Manage", "Remove from this site". | Built-in buttons below. |
| "Use another account" | `selectAcct` | App-started `select-account` flow (transport §5). | `identityless` → `login` flow without hint. Otherwise an inline handle field in the panel, then an identity-pinned flow. In all cases the current session stays current until the new credential is ready (no sign-out first). |
| "Use a different provider" | always | Inline handle field; the typed provider's capabilities then apply. | — |
| "Confirm it's you" (`reauth` action) | `reauth` | `reauthenticate` flow. | Omitted, even if requested in `actions`. |
| "Sign out of host…" (`provider-sign-out`) | `endSession` | `end-session` flow. | Omitted. |
| "Sign out of this app" | always | App sign-out; revokes at `revocation_endpoint` only if `revoke` and `revoke-on-sign-out`. | Local sign-out only. |
| "Manage at host" | always | Link to `manageUrl`, `noopener noreferrer`. | — |

Events (all compositions): `bindle-menu-toggle {open, reason}`; `bindle-account-change {previous, session, cause}` after the controller's `bindle-session-change`, never with an intermediate `null` during a switch; `bindle-account-change-failed {code}`. `bindle-account-select {subject}` occurs **only** with `island.switcher` (it reports a pick inside the island); apps must use `bindle-account-change` to learn the result. `state = {status, session, open, mode, islands: {avatar, switcher}, actions: [...available], capabilities}`.

### 6.3 `<bindle-avatar>`

Standard avatar chain of §6.2 always; with `island.avatar` the transparent island is layered over it. No events. `state = {islands, source: 'island'|'picture'|'initials'|'monogram'}` (`source` reflects only what the element rendered itself; with the island it is `'island'` whatever the island shows).

### 6.4 `<bindle-session>`

Adds read-only `capabilities` (frozen, for the current session's issuer, or the default provider when signed out), updated before `bindle-session-change` dispatches, and an event `bindle-capabilities-change {issuer, capabilities}` when the set changes (discovery, degradation, issuer change). Manifest data is public, so exposing it leaks nothing about the user.

### 6.5 Island policy attributes

- `islands="auto|off"` on `<bindle-session>` (default `auto`, coordinator decision of 2026-10-14).
- `island-issuers="<origin> …"` (new): when present, islands mount only for listed issuers; others get the standard composition.
- Islands of an issuer other than the current session's issuer or the default provider mount only after the user typed or chose that provider.
- `identity-credentials-get` is delegated to an island only for the default provider or an `island-issuers` entry (CPR-6).
- Tracking disclosure (CPR-13): a mounted sign-in island costs one shell request to the provider per 5 minutes (cacheable shell) and does no storage or network work until clicked; integration docs disclose this, and apps that do not want it set `islands="off"`.

### 6.6 Illustrative cases (not the logic)

| Case | Declaration | Result |
| --- | --- | --- |
| Full (3sln.me, self-hosted with islands) | Entry with all intents, popup, FedCM, revocation, DPoP, profile with all parts and `key-binding.v1` | Island sign-in, island avatar, island switcher; reauth and provider sign-out in the action list; persistent DPoP refresh. |
| Standard (core features, no profile) | Entry (`login`, `select-account`), popup, revocation | Form plus "Continue"; initials or monogram avatar; built-in "Use another account" via `select-account` popup; no reauth/provider sign-out actions; revocation on sign-out when requested. |
| Minimal (floor only) | Required members, `login_presentation: ["redirect"]` | Handle form (handle required), redirect only; initials/monogram; "Use another account" = handle field + identity-pinned redirect; sign-out local only. |
| Partial: avatar island only | Profile with `avatar` and `key-binding.v1`, no switcher | Island avatar in the trigger; built-in switcher actions from core capabilities (e.g. `select-account` re-auth). |
| Partial: sign-in island only | Profile with `sign-in`, no binding | Island sign-in button; standard avatar and switcher (identity-bearing parts need a binding). |

## 7. Initials avatar algorithm (standard composition)

Input: the granted `displayName`; else the local part of the granted `handle`. Colour key: the subject URL (§7.1). Output: 0–2 grapheme clusters plus a colour; an empty result falls back to the subject monogram.

1. **Normalize.** NFC. Values with bidi controls or C0/C1 controls are already rejected by the session view; trim and collapse runs of white space.
2. **Emoji first.** If the first grapheme cluster of the whole string (after skipping white space and punctuation) is an emoji (`\p{Extended_Pictographic}`, an emoji with modifiers, a keycap, a regional-indicator pair or a tag sequence), the result is that single cluster. This runs before word filtering, because emoji are not word-like segments.
3. **Words.** `Intl.Segmenter(undefined,{granularity:'word'})`, keeping segments with `isWordLike`; without `Intl.Segmenter`, split on `[\p{Z}\p{P}]+` with the `u` flag. For a handle local part, first drop everything from the first `+` (a tag), then split on `.`, `_` and `-`.
4. **Graphemes.** Take each word's first extended grapheme cluster with `Intl.Segmenter(undefined,{granularity:'grapheme'})` (Unicode 15.1 or later is assumed for Indic conjunct clusters; older engines may return a shorter cluster, which is acceptable). Without it, match `^(?:\p{RI}\p{RI}|\P{M}[\p{M}\p{EMod}\u{FE0F}\u{E0020}-\u{E007F}]*(?:\u{200D}\P{M}[\p{M}\p{EMod}\u{FE0F}]*)*)` with the `u` flag (escapes written out; no literal invisible characters in source). Strip `\p{Default_Ignorable_Code_Point}` and blank letters (U+115F, U+1160, U+3164, U+FFA0) before segmenting; skip leading clusters that are not letters or digits; keep at most the base plus three combining marks per cluster, and apply NFKC to the extracted cluster only (so "ﬁ" becomes "f").
5. **Caseless, logographic and joining scripts.** If the first cluster is Han, Hiragana, Katakana, Hangul, Thai, Lao, Khmer, Myanmar, Tibetan or another script whose names commonly have no word breaks, the result is that single cluster (for example "김민수" → "김", "山田太郎" → "山"). The same applies to joining scripts (Arabic, Syriac, N'Ko, Mongolian, Adlam), whose two initials would otherwise render as one joined word ("محمد علي" → "م").
6. **Otherwise** take the first cluster of the first word and, if there are at least two words, the first cluster of the last word ("Ada Lovelace" → "AL", "ada.lovelace" → "AL", "Ada" → "A").
7. **Case.** Upper-case only Latin, Greek, Cyrillic and Armenian clusters (not Georgian, whose upper case is Mtavruli), with `toUpperCase()` (locale-independent, so results do not depend on the viewer), and only if the result is still exactly one grapheme cluster; otherwise keep it as is ("ß" stays "ß", "ŉ" is not expanded).
8. **Bidi.** If the two clusters have different strong directions (`\p{Script=Hebrew}`/`Arabic` and others versus left-to-right letters), keep only the first. Render inside `<bdi dir="auto">` with `unicode-bidi: isolate`.
9. **Colour.** See §7.1. The colour key is the subject URL (which already contains the issuer origin), never the display name, so a rename keeps the colour and two accounts with the same name usually differ.
10. **Rendering.** `aria-hidden` (the trigger carries the accessible name), system font, `font-size` 40% of the box, `overflow: hidden`. No network access.

### 7.1 Identity colour, shared by initials, monogram and islands

One derivation colours the initials avatar, `<bindle-monogram>` and the island fallbacks (profile Appendix A), so standard and enhanced compositions match.

1. **Hue.** `b` as defined in profile Appendix A (FNV-1a over UTF-16 code units of the subject, second round), so the hue is independent of the monogram's pattern bits; `index = b mod 24`; `hue = index × 15 + 7.5` degrees. Quantizing to 24 hues keeps the palette stable and lets a test check every hue exhaustively.
2. **Per-scheme tones in OKLCH**, fixed lightness and chroma per scheme so every hue carries the same visual weight (provisional values; the contrast test is normative, the numbers are tuned to pass it):

   | Scheme | Background | Foreground (initials text, monogram cells) |
   | --- | --- | --- |
   | Light | `oklch(0.93 0.03 hue)` | `oklch(0.40 0.065 hue)` |
   | Dark | `oklch(0.36 0.06 hue)` | `oklch(0.93 0.03 hue)` |

   These chroma values are inside the sRGB gamut for all 24 hues (checked: minimum contrast 7.3:1 light, 8.7:1 dark), so no hue is chroma-reduced and all carry equal weight; any future out-of-gamut value is mapped by reducing chroma only, never lightness. Where `oklch()` is unsupported, the element uses a precomputed sRGB table generated from the same formula at build time.
3. **Contrast guarantee.** After gamut mapping, foreground on background is at least 4.5:1 (WCAG 2.x relative luminance) for all 24 hues in both schemes; a unit test enforces it, and if any hue fails, the scheme's shared lightness values are adjusted, never one hue alone. This also exceeds the 3:1 non-text minimum for monogram cells.
4. **Effective scheme.** In order: the element's `theme` attribute (`light`/`dark`), inherited from `<bindle-session theme>`; else, when the embedder sets `--bindle-surface`, its resolved colour's relative luminance (dark below 0.18); else the embedder's used `color-scheme` on the host; else `prefers-color-scheme`. Implementation: tones are written as CSS `light-dark(<light>, <dark>)` values, and the element sets `color-scheme` on its shadow root to `light`, `dark`, or (in `auto`, when the inherited used value is `normal`) `light dark`, so embedder `color-scheme` changes and `prefers-color-scheme` changes apply live without script. The token-luminance rule needs script: it is re-evaluated on attribute changes, `refreshTheme()` and media-query changes. Whenever the resolved scheme changes, elements resend `scheme` to their islands (profile §5.3). Islands receive the element's resolved scheme in `scheme` and apply the same table.
5. **Forced colours.** Under `forced-colors: active`: background `Canvas`, foreground `CanvasText`, a 1 px `CanvasText` border, and `forced-color-adjust: none` only on the cells and text that carry those system colours (needs browser evidence that cells stay visible).

## 8. Client identity across providers

**Today.** A client is an operator-reviewed entry in each provider's `FEDERATION_CLIENTS` (`{id,name,origin,redirectUris}`, [wire profile](../spec/federation-implementation.md), [deployment](../deployment/federation.md)); IDs are opaque strings of at most 200 characters. Protocol §2 said dynamic registration and client metadata were out of scope. `BindleClient` takes one `clientId` for every issuer (`packages/sdk/src/identity.mjs:85`). So an app works with a provider only if that provider registered it under the same ID. The elements cannot hide this: islands (`/embed?client=<id>`), FedCM (`clientId`, `Origin` check) and every entry need a client the provider recognises.

**Decision (provisional).**
1. Recommend that apps use an HTTPS URL on their own origin as `client_id` (for example `https://app.example/bindle-client.json`), serving an OAuth client ID metadata document there (`client_id`, `client_name`, `redirect_uris` on the same origin, optional `logo_uri`).
2. Core feature `client-id-metadata.v1` (protocol §2): a provider that declares it resolves URL client IDs itself (SSRF-safe egress, bounded, cookieless, cached ≤24 h, revalidated), derives allowed origins and redirect URIs from the document, labels the app as unreviewed unless its own review says otherwise, and may still refuse by policy. Such a provider needs **no pre-registration**; islands derive `frame-ancestors` from the document's redirect-URI origins.
3. A provider without the feature needs registration. Registering the same URL ID everywhere keeps one SDK configuration. The SDK also accepts `clientId` as a function `(issuer) => id | null` for apps registered under different IDs; `null` means "not registered here" and the elements report "This app isn't connected to {host}" (discovery error `unregistered-client`) before any provider page opens.
4. Safety rules (now in core protocol §2 and profile §3, CPR-16): registration precedence over the document; document validation (`client_id` equality, non-root path, size, type, no redirects, ≤24 h positive and negative cache); origin-first consent labels for unreviewed clients; shell lookups never block, are rate-limited and negatively cached; providers MAY serve the inert shell to unreviewed clients; `frame-ancestors` reduces to the `client_id` origin.
5. The 3sln reference runtime cannot fetch arbitrary metadata on Cloudflare yet (no verified egress port, [app metadata](../spec/app-metadata.md)), so 3sln.me does not declare `client-id-metadata.v1` until that port exists. That is a release item, not a design gap.

## 9. Audit: 3sln.me hard-coding and provider assumptions

The `@3sln.me` default handle suffix is intentional and stays configurable. Contract identifiers under `https://3sln.me/artefacts/contracts/` (for example `identity.mjs:290`) are intended global identifiers, not findings.

### 9.1 SDK (`packages/sdk/src`)

| # | Sev | Location | Finding | Fix |
| --- | --- | --- | --- | --- |
| A1 | High | `identity.mjs:313` | Subject must match `/entities/<uuid v4>`, the 3sln path shape. Any other provider's subject URL is rejected. | Require an HTTPS URL on the issuer origin, ≤2048 chars, no userinfo, query or fragment; no path shape. |
| A2 | High | `identity.mjs:33` | 404/410 fallback hard-codes `provider:'https://3sln.me'`. | `emailFallback` option (default `https://3sln.me`, `null` disables); `<bindle-session email-fallback>`. |
| A3 | High | `identity.mjs:74-75`, `:144-145`, `:158` | Reads flat `authorization_entry_*`; absent `authorization_entry_intents` defaults to **all** intents. | Read `features["authorization-entry.v1"]`; missing or invalid intents make the feature absent. |
| A4 | High | `identity.mjs:85-88`, `elements/session.mjs:49` | One `clientId` for every issuer; no per-issuer mapping or URL client ID support. | §8: `clientId` string or `(issuer)=>id`, `unregistered-client` code. |
| A5 | Medium | `identity.mjs:63-77` | `validateManifest` ignores `features`/`profiles` and bounds; no capability object. | New `capabilities.mjs` (§5) fed by a declaration validator in `identity.mjs`. |
| A6 | Medium | `flows.mjs:111` | Opens a popup whenever the app asks, even if the provider does not declare `popup`. | Popup only when `login_presentation` includes it; otherwise redirect. |
| A7 | Medium | `elements/account.mjs:46`, `:113-119`; `flows.mjs:56-58` | Default actions include `switch`; reauth/provider sign-out render even when the provider cannot do them, then fail with `unsupported-provider`. | Actions from capabilities (§6.2); switch fallback per CP-10. |
| A8 | Medium | `identity.mjs:312` | `token_type` must be `Bearer`; auth.md requires `DPoP` for sender-constrained tokens. | Accept `DPoP` exactly when the entry carried `dpopJkt`. |
| A9 | Medium | `identity.mjs:312`, `:314` | Relies on token members (`issuer`, `client_id`, `audience`, `granted_fragments`) defined only in the 3sln runtime wire profile; caps `refresh_expires_in` at 28,800 s. | Promote the token response to core text (spec follow-up); lift the cap for DPoP refresh. |
| A10 | Medium | `identity.mjs:81`, `:151`, `:163` | The entry body and the `?entry=` authorization parameter exist only in design docs, so third parties cannot implement `authorization-entry.v1`. | Write the entry wire into auth/federation-implementation under the feature. |
| A11 | Medium | `elements/account.mjs:117` | "Manage" links to `issuer + '/'`, assuming the account console sits at the issuer root. | `manageUrl` from the profile, issuer root as default. |
| A12 | Low | `flows.mjs:47-48`, `elements/session.mjs:40`, `elements/sign-in.mjs:31` | `\|\| '3sln.me'` makes the default host impossible to disable. | Keep `3sln.me` as default; `default-host="none"` requires full handles. |
| A13 | Low | `elements/theme-probe.mjs:7-8`, `:14` | Token set includes `font`, `font-scale`, `density`, `color-scheme`, which islands ignore; nothing intersects with a provider declaration; the 9 contrast pairs differ from profile §7's 13, so element and island revert different tokens. | Send `tokens ∩ theme_tokens ∩ allowlist`; adopt the profile's 13 pairs. |
| A15 | Low | `identity.mjs:39` | `fetchProvider` returns a hard-coded `presentation:'redirect'` that ignores the declaration. | Return the capability set instead. |
| A16 | Medium | `identity.mjs:95`, `:168` | One pending transaction per `(client, callback)`; an island `prepare` would overwrite an in-flight redirect's verifier (CPR-9). | Pending records keyed by `state`; island records in memory. |
| A14 | Low | `testing.mjs:22-23`, `:30` | Mock emits flat members, `/entities/` subjects and no `features`/`profiles`, so A1/A3/A5 regressions are invisible. | Declaration options and non-3sln subject shapes. |

### 9.2 Server (findings only; files owned by running agents)

| # | Location | Finding | Fix |
| --- | --- | --- | --- |
| S1 | `packages/federation/authorization-entries.mjs:9`, `:17` | `EMBED_PROFILE='https://3sln.me/artefacts/profiles/embed/v1'`, flat `embed_profiles_supported` and flat entry members. | §3.3 forms; `embed_origin` from configuration. |
| S2 | `packages/runtime/http.mjs:160` | Flat `intents_supported`/`intent_login_endpoint`. | `features["intents.v1"]`. |

Server status, 2026-10-14: S1 and S2 are implemented (provisional). See the [federation mount review](../release/federation-mount-review.md).

### 9.3 Designs and specs

| # | Location | Finding | Fix |
| --- | --- | --- | --- |
| D1 | embed-islands.md:28, :48, :101; adaptive-app-sign-in.md:106 | Shell URL fixed at `https://embed.3sln.me`. | `<embed_origin>/embed?client=…` from the declaration. |
| D2 | adaptive-app-sign-in.md:151, :157, :164 | Popup opens `https://3sln.me/oauth/authorize`; hello/done `targetOrigin` fixed to `https://embed.3sln.me`. | Issuer `authorization_endpoint`; declared embed origin (profile §9.1). |
| D3 | adaptive-app-sign-in.md:261-262 | FedCM in frame assumes the embed host is same-site with the issuer. | Profile §2.2: SHOULD be same-site, otherwise listed in the FedCM well-known file. |
| D4 | adaptive-app-sign-in.md:338, :362; embed-islands.md:287, :428, :440, :567 | Discovery reads `embed_profiles_supported`/`embed_origin` as core members, "3sln islands profile". | Components profile accessor; per-part gating (§5). |
| D5 | embed-islands.md:429 | `embed-origin` hint is not tied to one issuer. | Default provider only, verified (profile §11). |
| D6 | embed-islands.md:410 | "Non-3sln provider → phase-1 rendering". | Capability composition (§6). |
| D7 | embed-islands.md §4.1, §4.4 | `ready` has no issuer, so a provider can point at another provider's embed origin undetected. | `ready.issuer`, one issuer per embed origin (CP-5). |
| D8 | embed-islands.md:525 | Preconnect to `https://embed.3sln.me`. | `<embed_origin>` of the default provider. |
| D9 | adaptive-app-sign-in.md:132-133; embed-islands.md:211 | Embed API URLs under `embed.3sln.me`. | Mark as 3sln deployment values; provider-internal (profile §9.1). |
| D10 | protocol.md §2, auth.md discovery table (before this change) | Core spec named 3sln.me as the email fallback. | **Fixed here:** "a fallback provider the client names". |

### 9.4 `<bindle-monogram>` (`packages/sdk/src/elements/monogram.mjs`, findings only)

| # | Sev | Location | Finding | Fix |
| --- | --- | --- | --- | --- |
| M1 | Medium | `monogram.mjs:22` | Cells use `hsl(hue 60% 38%/72%)`. HSL is not perceptually uniform, so hues carry different weight, and contrast is unverified (yellow-green cells at 38% are close to 3:1 on `#f4f5f7`). | §7.1 OKLCH tones and the exhaustive contrast test. |
| M2 | Medium | `monogram.mjs:21` | Background is `--_raised`, i.e. the embedder's `--bindle-surface-raised`, so cell contrast depends on an unchecked embedder token. | Self-contained tile: §7.1 background tone, cells in the foreground tone. |
| M3 | Medium | `monogram.mjs:27`, `:32` | Standalone `<bindle-monogram>` follows only `prefers-color-scheme`; it ignores `theme`, `<bindle-session theme>`, embedder `color-scheme` and tokens (`observedAttributes` lacks `theme`). | §7.1 effective scheme with `light-dark()` and root `color-scheme`. |
| M4 | Low | `monogram.mjs:14` | Continuous hue `b % 360` cannot be contrast-tested exhaustively and differs from the initials derivation. | 24 quantized hues from `fnv1a32(subject)` (§7.1); the cell pattern is unchanged. |
| M5 | Low | `monogram.mjs:23` | Forced-colours rule colours cells with `CanvasText` backgrounds, which forced-colours mode may override; no tile border. | §7.1 step 5 with `forced-color-adjust: none` on cells, plus a border; browser evidence. |
| M6 | Low | `monogram.mjs:9-24` | The island fallback must render the same picture, but the pattern and palette live only in the element module. | Move `monogramPattern` and the §7.1 palette into the shared `embed-protocol.mjs` (islands slice I1). |

Totals: 16 SDK, 6 monogram, 2 server, 10 design/spec findings (one already fixed); 34 in all.

## 10. Implementation follow-ups (non-overlapping ownership)

| Slice | Owns (write) | Work |
| --- | --- | --- |
| CPS-1 SDK declaration and capabilities | `packages/sdk/src/identity.mjs` (validator), new `packages/sdk/src/capabilities.mjs`, `packages/sdk/src/flows.mjs`, `packages/sdk/src/testing.mjs`, `packages/sdk/test/{identity,flows,capabilities}.test.mjs` | A1–A6, A8, A9 (SDK side), A12, A14–A16; per-issuer cache and degradation; `clientId` function. |
| CPS-2 SDK elements | `packages/sdk/src/elements/{account,sign-in,session,shared,monogram}.mjs`, new `elements/{initials,avatar}.mjs`, `packages/sdk/test/elements.test.mjs` | §6 compositions, CP-8 container in every mode, §7 initials, §7.1 colours, M1–M6, A7, A11, A13; `island-issuers`. Coordinates with islands slice I5 (`islands.mjs`, `panel.mjs`). |
| CPS-3 Server manifest | `packages/federation/authorization-entries.mjs`, `packages/federation/runtime.mjs`, `packages/runtime/federation.mjs` (one hunk each, when the authorization-entry implementer releases them) | S1; `features`/`profiles` emission; tests in `tests/authorization-entries.test.mjs`. |
| CPS-4 Links | `packages/runtime/http.mjs:160` hunk, `docs/spec/links.md` (links agent) | S2 and §11. |
| CPS-5 Islands runtime | `apps/embed/src/channel.mjs`, `apps/embed/src/parts/*` (I2/I3), `apps/embed/src/sandbox.mjs` (A5) | `ready.issuer` and `version`; `#part.vN` fragments; per-type byte caps; P8–P10; `(issuer, client_id)` filtering; transparent avatar; sandbox probe accepting the target token set once evidence exists. |
| CPS-6 Spec follow-ups | `docs/spec/federation-implementation.md`, `docs/spec/auth.md` | A9/A10: entry wire and token response as core text; `client-id-metadata.v1` details. |
| CPS-7 Publication (after sign-off) | `packages/core/public-contracts.mjs`, move `docs/architecture/artefacts/components-profile-v1.json` to `docs/artefacts/` | Registry entry `{name:'components', kind:'manifest-profile', id:'https://3sln.me/artefacts/profiles/components/v1', path:'/artefacts/profiles/components/v1.json', documentation:'/docs/profiles/components-v1.html'}`. |
| CPS-8 Design doc alignment (coordinator) | adaptive-app-sign-in.md, embed-islands.md, security.md reference-host section | D1–D9 replacements; islands §8.1/§22 fallback text per CP-8. |

Evidence before completion: `npm test`; capability unit tests over declaration fixtures (valid, invalid member, unknown feature, oversize, duplicate-version, cross-issuer); DOM tests for each §6.6 case and for degradation after a handshake timeout and an `issuer` mismatch; initials vectors (Latin, Turkish dotless i, German ß, Korean, Japanese, Arabic, Hebrew + Latin, Devanagari conjuncts, ZWJ emoji, flags, leading punctuation, digits); browser checks with a third-party mock provider on a different origin.

## 11. Needed `docs/spec/links.md` changes (links agent)

1. §6.4: replace "declares the intent in `intents_supported` together with an `intent_login_endpoint` on the issuer origin" with "declares the `intents.v1` feature ([protocol §2](protocol.md#2-discovery-and-login)) listing the intent, with its `login_endpoint` on the issuer origin".
2. §9 step 3 and the implementation-status table: `link_response_endpoint` becomes a feature, for example `link-responses.v1 = {endpoint}`; any conditional-link or directory capability (`directory_url`, §7.3) likewise gets a versioned feature identifier added to protocol §2's registry.
3. State the absent defaults there (plain intent links; no opener response; principal verification unavailable).

## 12. Changes needed in other documents (coordinator)

- **adaptive-app-sign-in.md:** AS-15 and §16: the interop list becomes the core envelope plus the components profile; §14 reads the profile accessor; D1–D3, D9.
- **embed-islands.md:** §3.1, §4.1, §4.4 (`ready.issuer`), §11 (capability composition), §12.1 (`island-issuers`, hint rule), §12.3, §16, §20; §8.1/§22 fallback per CP-8.
- **security.md (reference-host section):** cite the profile for island rules and add `ready.issuer` and per-issuer isolation to the verification list.
- **embeddable-elements.md:** note that the element API is capability-driven (§6).
- **integration.md:** client ID recommendation (§8), `island-issuers`, the island tracking disclosure, guidance that app `message` listeners check `event.origin` and `event.source` (CPR-7), and the SDK's default email-fallback provider (moved out of core, CPR-17).
- **DEVLOG.md:** entry for this design and review, unsigned.

## 13. Open questions for the user

- **Q1** Default island policy: any provider that declares the profile (current), or only an app-configured allowlist?
- **Q2** Should 3sln.me plan to declare `client-id-metadata.v1` (needs a verified egress port on Cloudflare), or keep reviewed registration only?
- **Q3** CP-8 makes the composed `<dialog>` container (no `role=menu`) the standard composition too. Accept, or keep phase-1 `role=menu` when no switcher island is mounted?
- **Q4** Initials for single-word Latin names: one letter ("A") or two ("AD")? The draft uses one.
- **Q5** Sandbox islands with `allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox` once browser evidence confirms FedCM, storage and popups still work (blocks top navigation by hostile islands), or keep unsandboxed with provider rule P8 only?

## 14. Review reconciliation

Independent review: [components-profile-review](../release/components-profile-review.md), 21 findings (4 High, 12 Medium, 5 Low, no Blocker). No human sign-off is implied.

| Finding | Resolution |
| --- | --- |
| CPR-1 (M) premature "revision 2" claim | Status line corrected; this table is the real reconciliation, written after the review. |
| CPR-2 (H) core contradicts profile on component origin | CP-13: core component-origin envelope in auth (FedCM `Origin`, entry creation with key proof, code transit); protocol "cannot change core" names it as the one exception; profile §1. |
| CPR-3 (H) part versions never negotiated | Fragment `#part.vN`, `version` in init and `ready`, key sets per (part, version) (profile §3, §5.1, §5.2; descriptor). |
| CPR-4 (H) `authorization-entry.v1` has no wire | Marked **reserved** in protocol §2 until the wire profile publishes it; profile §1 says it is a design target until then; CPS-6 goes first. |
| CPR-5 (H) unsandboxed hostile islands | Explicit `'none'` in `allow`; P8; target sandbox token set pending evidence; Q5 (profile §3.1, §10). |
| CPR-6 (M) FedCM delegation to hostile islands | Delegation only for the default provider or `island-issuers` (profile §2.1; §5, §6.5). |
| CPR-7 (M) window messages to the app | P9 (port only), E7 (no window listener), integration guidance (§12). |
| CPR-8 (M) partition-scoped component data | `(issuer, client_id)` filtering (profile §2.2, P10). |
| CPR-9 (M) pending-record clash | E8; audit A16. |
| CPR-10 (M) size caps, `loginHint` | UTF-8 per-type caps; `loginHint` never rendered (profile §5.2, §5.3). |
| CPR-11 (M) descriptor placeholders | Typed per-message schemas, tightened `embed_origin` prefilter, part-entry handling aligned (descriptor). |
| CPR-12 (M) pseudo-code errors | Degrade inputs first; `dpop` needs entry, stated in protocol §2; popup decided at click; island intents defined (§5, profile §5.4). |
| CPR-13 (M) tracking by a mounted sign-in island | Cacheable 5-minute shell; no storage or network before a click (P10); disclosure; Q1 reopened (§6.5). |
| CPR-14 (M) initials defects | Emoji first; full fallback regex with escapes; joining scripts single cluster; case only for Latin/Greek/Cyrillic/Armenian; ignorable and blank letters stripped, marks capped, NFKC per cluster; plus-tag dropped (§7). |
| CPR-15 (M) avatar mismatch, hue correlation | Element always renders its standard avatar; transparent island covers it only with a picture; hue from `b`; dead text removed; `scheme` resend rule (profile §5.3, §6, Appendix A; §7.1). |
| CPR-16 (M) metadata-client safety | Precedence, validation and labelling in core protocol §2; shell lookup rules in profile §3; §8. |
| CPR-17 (L) UI/SDK text in core | "No presentation beyond the listed security disclosures"; SDK default removed from the core files. |
| CPR-18 (L) `grant_types_supported` default, wording | Providers with refresh MUST list it; `login_presentation` described as a Bindle member. |
| CPR-19 (L) unverified hint, HTTP cache | E9; `cache:'no-cache'` (profile §11; §4). |
| CPR-20 (L) focus traps, overlays, spoofing | P8 (no traps, no app imitation); E10. IntersectionObserver v2 gating stays an islands-design item. |
| CPR-21 (L) handshake timing, audit omissions | Macrotask drain and timestamp check (profile §5.1); `src` set before insertion; A13 extended, A15 and A16 added. |

Still open (browser evidence): top-navigation blocking per engine, sandboxed islands with FedCM/storage/popups, FedCM dialog wording in cross-site frames, transparent cross-origin frames, initial `about:blank` load events, forced-colours cell rendering.
