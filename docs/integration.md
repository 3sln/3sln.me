# Integrating with 3sln.me and Bindle

Bindle is an open implementation draft for identity, preference fragments and resource contracts. The current repository contains a working local identity/messaging application; federated OAuth login and general fragment consent are not yet a released interoperability service. Production publication is gated by release-status.json.

Start with [the protocol](spec/protocol.md), [authentication](spec/auth.md), [baseline contracts](spec/contracts.md), [object storage](spec/storage.md), [contact endpoints](spec/contact-tokens.md), [messaging](spec/messaging.md), and [device login](spec/device-login.md).

## App login

The SDK (`packages/sdk/src/`) works with **any Bindle provider**: 3sln.me, a third party, or a self-hosted instance of this codebase. A host is a supported provider when its manifest meets the [conformance floor](spec/protocol.md#2-discovery-and-login): a valid manifest with exact issuer equality and every required endpoint on the issuer origin, the code + PKCE redirect flow and registered callbacks. Below the floor, or with a malformed manifest, the SDK reports `unsupported-provider` and never falls back to another provider. Everything else a provider offers is read from its declaration (protocol §2 `features` and `profiles`, plus the flat OAuth members), and the SDK adapts **per feature**: it never assumes 3sln.me paths, subject shapes or capabilities.

`BindleClient` (`identity.mjs`) handles discovery, PKCE, the exact callback check and the token exchange. `client.beginLogin(handle, {requests})` returns an `authorizationUrl` for the identity-pinned request every provider supports; `client.completeLogin()` on the registered callback page verifies state, issuer, callback and expiry, consumes the pending verifier once and exchanges the code without cookies. Several transactions may be pending at once; each is keyed by its `state`. Subjects are any HTTPS URL on the issuer origin (no path shape is assumed).

### Client IDs across providers

An app needs a client ID that each provider recognises:

- **Recommended:** an HTTPS URL on your own origin that serves an OAuth client ID metadata document (for example `https://app.example/bindle-client.json`, with `client_id`, `client_name` and `redirect_uris` on the same origin). Pass it as `clientMetadataUrl` (`client-metadata` attribute). Providers that declare `client-id-metadata.v1` accept it without pre-registration; the SDK uses it only with those providers.
- Providers without that feature need registration. Register the same ID everywhere and pass one string as `clientId`, or pass a map `{"https://idp.example": "id-there"}` or a resolver `issuer => id | null` (the `clientIds` property of `<bindle-session>`). An explicit ID takes precedence over the metadata URL.
- When no ID applies, the flow ends with `discovery-error` / `unregistered-client` ("This app isn't connected to {host}.") before any provider page opens.

### Default host and email fallback

Unqualified input such as `alex` is completed with the default host (`3sln.me` unless `defaultHost` / `default-host` says otherwise; `default-host="none"` requires complete handles). If a typed host answers a definitive **404 or 410**, the flow ends with `no-provider` and a `fallback` naming the default host, and `<bindle-sign-in>` emits `bindle-email-fallback`; your app decides whether to offer email sign-in there after telling the user the address goes to that provider. The fallback is never the typed host itself, never another host, and never offered for network, TLS, CORS, 401/403/429/5xx or malformed responses. `emailFallback:false` (`email-fallback="off"`) disables it.

### Sessions, refresh and DPoP

Access tokens are short-lived (at most five minutes) and stay in memory. When the provider declares `dpop_signing_alg_values_supported` with `ES256`, `authorization-entry.v1` and a `refresh_token` grant, the SDK generates a **non-extractable** P-256 key, names its thumbprint (`dpopJkt`) in the authorization entry and signs a DPoP proof for the code exchange and every refresh, retrying once when the provider asks for a nonce. Such a refresh token is sender-constrained, so when the provider also reports `refresh_idle_expires_in` the SDK accepts the provider's own `refresh_expires_in` and renews the idle deadline on each rotation; any other refresh token keeps the eight-hour memory ceiling. The access token may be `Bearer` (the current 3sln reference choice) or `DPoP`, as the token response says; a `DPoP` access token is sent with a proof bound to it. The SDK does not persist sessions: a reload needs a fresh sign-in. A redirect round trip parks the key in IndexedDB until the code exchange ends; without IndexedDB, redirect sign-ins stay unbound. A provider that rejects DPoP proofs is degraded to unbound sessions for the rest of the page.

`signOut({revoke:true})` revokes each app session it signs out with that session's own refresh token (RFC 7009), which also ends that session's paired component credential at providers that issue one; `revokePrevious` on a switch revokes only the previous session. Sign-out of the app never ends the provider session; `endProviderSession()` does that where the provider declares it.

## Embeddable elements (provisional)

Framework-neutral custom elements: `<bindle-session>`, `<bindle-sign-in>`, `<bindle-account>`, `<bindle-avatar>` and `<bindle-monogram>`. The former `<bindle-login>` alias is removed (nothing was released). Designs: [embeddable elements](architecture/embeddable-elements.md) and the [components profile decision note](architecture/components-profile.md). The package name `@3sln/bindle` lives only in `packages/sdk/package.json`, which is private.

```html
<script type="module" src="/packages/sdk/src/define.mjs"></script>
<bindle-session client-metadata="https://app.example/bindle-client.json" client-id="https://app.example/client" redirect-uri="https://app.example/callback">
  <bindle-account actions="switch provider reauth sign-out provider-sign-out manage">
    <bindle-sign-in slot="signed-out"></bindle-sign-in>
    <a slot="menu-start" href="/settings">Settings</a>
  </bindle-account>
</bindle-session>
```

### Capability-driven behaviour

`<bindle-session>` discovers the current provider (the session's issuer, else the default provider) on connect and exposes a frozen `capabilities` object, updated before `bindle-capabilities-change {issuer, capabilities}` fires. Elements compose from it; they never read the manifest. The members are `entry`, `intents`, `identityless`, `selectAccount`, `reauthenticate`, `endSession`, `popup`, `fedcm`, `revoke`, `dpop`, `refresh`, `clientIdMetadata`, `manageUrl`, `profile`, `embedOrigin`, `themeTokens` and `islands: {avatar, switcher, signIn}`. Headless apps call `createSession()` from `flows.mjs`, then `await session.loadCapabilities()`, and read `session.capabilities`.

Declaration processing follows protocol §2: at most 32 features of at most 4 KiB and 8 profiles of at most 8 KiB, unknown keys ignored, an invalid feature or profile treated as absent, caching for the HTTP freshness lifetime capped at one hour, and values of one issuer never combined with another's. A declared capability that turns out not to be implemented (for example an entry endpoint answering 404, 405 or 501, or FedCM twice unavailable for non-user reasons) is degraded for that issuer until the page reloads; network and 5xx errors stay retryable.

| Area | Behaviour |
| --- | --- |
| Sign-in | With identity-optional login (`authorization-entry.v1` with `login`): a **Continue with {host}** button plus the handle form, where the handle is optional. Otherwise the handle form requires a complete handle. A typed provider below the floor shows "This provider isn't supported."; a 404/410 host emits `bindle-email-fallback`. |
| Transport | `presentation="auto"` (default): FedCM when the provider declares `fedcm.v1` and the browser supports it; else a popup **only if** `login_presentation` lists `popup` and the provider's declaration is already known when the user clicks; else a top-level redirect. `presentation="popup"` also opens a popup before discovery, and closes it again if the declaration has no `popup`. `presentation="redirect"` always redirects. FedCM failures raised before the browser dialog can appear continue with a popup or, once the click's activation has expired, a redirect; any rejection after that (browsers report a dismissed dialog as a generic error) ends the flow as `canceled`. |
| Profile button | One `<dialog>` container (an anchored popover; disclosure pattern, `role=list` of actions, no `role=menu`). The trigger shows the granted picture (HTTPS on the issuer origin), else initials from the granted display name or handle (grapheme-aware; one letter for one word, first and last for several), else the subject monogram. |
| Actions | `actions` lists the requested actions (default `switch provider sign-out manage`). `reauth` renders only with `reauthenticate`, `provider-sign-out` only with `end-session`. **Use another account** re-authenticates through `select-account` when declared, else an identity-optional login at the same provider, else asks for a handle in the panel; the current session stays until the new one is ready. **Use a different provider** asks for a handle. **Manage** links to the profile's `manage_url`, else the issuer root. |
| Colour | The initials and monogram tile take a stable hue from the subject URL with fixed OKLCH tones per scheme (at least 4.5:1 in light and dark), follow the element's effective scheme live (`theme` attribute; else a dark `--bindle-surface`; else the page's `color-scheme`; else `prefers-color-scheme`) and use system colours in forced-colours mode. |

The illustrative cases are *full* (every feature plus the components profile), *standard* (entry with `login` and `select-account`, popup, revocation) and *minimal* (floor only: handle form, redirect, local sign-out); any combination composes the same way. `createMockProvider({declaration:'full'|'standard'|'minimal', ...})` in `testing.mjs` builds each case, and individual options toggle single features.

### Events and state (identical in every composition)

| Element | Events | `state` |
| --- | --- | --- |
| `<bindle-session>` | `bindle-session-change` (on connect, then each change; never an intermediate `null` during a switch), `bindle-flow-start {intent, presentation, source}`, `bindle-flow-end {intent, outcome, code?}`, `bindle-flow-state`, `bindle-capabilities-change`, `bindle-error` (configuration) | `signed-out \| pending \| signed-in`; also `session`, `capabilities`, `ready` |
| `<bindle-sign-in>` | `bindle-sign-in-start {source, presentation}`, `bindle-sign-in-end {outcome, code?, session?}` (one per start; `completed` only once the app credential is ready), `bindle-email-fallback`, and `bindle-sign-in-request` when no `<bindle-session>` is present | `{status, islands, last}` |
| `<bindle-account>` | `bindle-menu-toggle {open, reason}`, `bindle-account-change {previous, session, cause}`, `bindle-account-change-failed {code}`, `bindle-account-select {subject}` (switcher island only) | `{status, session, open, mode, islands, actions, capabilities}` |
| `<bindle-avatar>` | none | `{islands, source}` |

Element events are dispatched in a microtask after the controller event that caused them, so a document listener sees `bindle-session-change` first. Flow outcomes are `completed`, `canceled`, `dismissed`, `popup-blocked`, `discovery-error`, `network-error` and `redirecting`; codes include `invalid-identity`, `identity-required`, `unsupported-provider`, `unregistered-client`, `no-provider` and `discovery-unavailable`. Every provider-side refusal is `canceled`. Before approval the page learns only what the user typed; afterwards `session` holds `{issuer, subject, grantedFragments, profile?}`.

### Provider islands

Providers may declare the [3sln.me components profile](profiles/components-v1.md) to offer provider-operated islands (avatar, account switcher, sign-in). Islands are **on by default** for any provider whose declaration lists the needed parts; `islands="off"` on `<bindle-session>` disables them and `island-issuers="https://idp.example …"` restricts them to listed issuers. FedCM inside an island is delegated only for the default provider or a listed issuer. **Status:** the elements contain the mount hook (`elements/islands.mjs`), but the island runtime is a separate, unfinished slice: today no island mounts, `state.islands` stays `'off'`, and the standard composition is always shown. Once islands mount, a sign-in island costs one cacheable shell request to the provider per five minutes and does no storage or network work until clicked; apps that do not want this set `islands="off"`. Island messages travel over a `MessagePort`, never window messages, but any `message` listener your app installs must still check `event.origin` and `event.source`.

### Callback page

Popup and redirect sign-ins return to the exact `redirect-uri`. Serve it as a minimal page with `Referrer-Policy: no-referrer` that runs this before any other script:

```html
<script type="module">import {handleCallback} from '/packages/sdk/src/callback.mjs'; await handleCallback();</script>
```

`handleCallback()` acts only on a complete provider callback (`state`, `iss`, and exactly one of `code`, `error` or `result`). When this tab holds the pending transaction it completes in place (redirect mode); when it holds an expired or different one it asks the user to start again; otherwise it relays the parameters to the waiting tab over a same-origin `BroadcastChannel` and reports whether the tab acknowledged (popup mode). Provider pages are expected to send `Cross-Origin-Opener-Policy: same-origin`; the app's own COOP must be absent or `same-origin-allow-popups`. Popup mode is not supported when the app runs inside a third-party iframe (partitioned `BroadcastChannel` and `sessionStorage`); use `presentation="redirect"` there. In popup mode a flow method called outside a user action rejects with `NotAllowedError`; a blocked popup continues as a redirect (`fallback:true`) unless `popup-fallback="prompt"`.

### Extension points and embedder requirements

- `sessionEl.transports`: `{name, available({intent}), authorize({intent, params, client, signal})}` objects run after the built-in FedCM transport; `{outcome:'unavailable'}` falls back. `sessionEl.entryExtensions`: an async `({intent}) => fields` hook that may add entry fields but never core fields or key-binding members (`dpopJkt`, `embedJkt`, `delivery`).
- **CSP:** discovery fetches `https://<host>/.well-known/bindle/manifest.json`, and the entry, token, revocation and RPC endpoints are on the provider origin, so `connect-src` must list the expected providers (or `https:`).
- **Theming:** public `--bindle-*` custom properties and `::part()` names with light and dark defaults. Provider pages are never themed by the embedder; island tokens are limited to the profile allowlist and the provider's declared `theme_tokens`.
- **Size:** `define.mjs` renders sign-in from about 17.7 KiB min+brotli; the controller and the signed-in account view load right after connect, and FedCM, DPoP, the token client and the callback handler load on use (measured with code splitting).

**Status.** Nothing here is production-verified. Entry-based flows (identity-optional sign-in, switching, reauthentication, provider sign-out, DPoP-bound sessions, revocation) are verified against `testing.mjs` in DOM and browser tests and against the local, unmounted 3sln reference handlers (`tests/authorization-entry-sdk-contract.test.mjs`, which adds the entry declaration because the reference runtime does not advertise unmounted routes). `authorization-entry.v1` stays reserved until its wire text is published, and no provider declares `fedcm.v1` yet. For tests, `createMockProvider()` provides a fetch shim, `installPopupDriver(window, …)` / `installPopupDrivers(window, providers, …)` and `installFedCM(window, …)`. Never ship `testing.mjs` in production bundles.

Shared preferences can be reviewed and edited in the provider at `/preferences`; a single deliberate save updates the exact listed subscriptions while preserving each app’s method ceiling.

Provider operators explicitly register reviewed client origins/callbacks and immutable fragment schemas. Runtime federation is enabled separately from public-signup release gates. `allowInsecureLocalhost:true` is only for explicit local development; production discovery requires HTTPS DNS origins.

Failed discovery must not downgrade identity. Only definitive absent manifests (404/410) may offer explicit email fallback. 3sln.me returns service-unavailable while its production federation endpoint is disabled, so clients do not incorrectly interpret the unfinished service as an absent identity provider.

## Resources and contracts

Resources have identifiers and exact contract URLs; a display name is not conformance. Apps request field and resource-method scopes, users explicitly approve, and every operation checks live grants/current assignments. Adding a resource does not silently extend an app's access. Browse the [contract registry](/artefacts/contracts/) for direct JSON definitions. The object storage contract identifier `/artefacts/contracts/object-storage/v1` returns its [JSON Schema](/artefacts/contracts/object-storage/v1.json); usage documentation remains separate. It remains a versioned draft until the release gates are complete.

Storage capabilities describe read/write/range/presigning support. Object listing is absent; apps maintain directory/index objects. Do not assume every Google Drive, WebDAV or S3-compatible connection supports safe conditional writes. Object URLs are bearer capabilities for one object and operation. The result reports mode and revocation: native provider URLs can remain valid until expiry after grant revocation, while provider-proxy URLs perform live grant checks. Users approve temporary-link powers explicitly; callers must send the returned requiredHeaders and must not infer revocation behavior from the storage provider name.

## Contact endpoints

The primary shared contact capability is a signed endpoint URL. HTML GET opens the host's composer, a token MIME Accept header yields a short-lived API bearer, and intentional multipart POST to the signed URL delivers a message. Signed URLs and returned bearers need safe handling and log redaction. MIME/size/count limits are live, revocable and separate from permission to read messages. Delivery tags are not part of the signed link: each link has revisioned, owner-editable server-side intake configuration (automatic tags and a sender-selectable optional allowlist), and a side-effect-free metadata request to the link reports the accepted optional tags, intake revision and limits. Legacy `?sig=` endpoints seed intake from their signed tags. Every link delivery needs a verified author proof; anonymous submission is refused with `author_required`. See [links](spec/links.md). Raw sender annotations grant no authority. Legacy collection restrictions remain enforced for compatibility; they are not configurable Views.

## Messages, conversations and Views

The user-facing model is one logical store of messages and conversations. Saved Views filter that store by metadata; an item can appear in multiple Views without duplicate storage. Renaming or deleting a View does not modify retained messages. Views never determine app permissions, and changing their filters cannot expand a resource grant. The owner-facing `/api/views` and `/api/incoming` implementation is separate from the existing scoped app/MCP APIs; it is not yet a new published Bindle RPC contract. See [messaging](spec/messaging.md) for the implemented boundary.

## Self-hosting and extension

[Self-hosting instructions](self-hosting.md) explain the same portable application behind Workers and Node, unbranded by default. Integration credentials, branding and runtime resources belong to the operator. The specifications are open drafts; contact MIME registration, complete machine grant schemas, portability conformance and external storage credentials are still release work. Read the independent interoperability and security reviews before implementing against an assumed stable protocol.

## Hosted SDK artifacts

`/packages/sdk/src/define.mjs`, `/packages/sdk/src/callback.mjs` and `/packages/sdk/src/identity.mjs` are revalidating public loaders to standalone content-addressed ESM, so an embedding app needs no portal import map; the portal's build manifest exposes the targets for version pinning. The standalone bundles are built without code splitting, so they carry the lazily loaded parts inline. The runtime serves these loaders and their hashed targets with anonymous CORS, so cross-origin embedding works. The SDK grants no access without actual provider authentication and explicit consent. Runtime registration and production activation remain separate operator steps.
