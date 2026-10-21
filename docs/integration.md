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

## Incremental authorization (provisional, default off)

The opt-in SDK module `packages/sdk/src/incremental.mjs` implements the [incremental authorization draft](spec/incremental-authorization.md) against a spec-contract extension of the SDK testing double. This is local mock verification; provider integration, independent review and production verification remain outstanding. Package exports and a standalone distribution entry are integrator work; the example uses the repository source module. The helper's `enabled` option defaults to `false`; enable it only through your app's default-off `INCREMENTAL_AUTH_ENABLED` flag. Load the module when preparing the optional feature, before its user action, to preserve popup activation and keep it outside the first-render element bundle:

```js
// Inside your app's enabled feature branch, before enabling the request button.
const {createIncrementalClient}=await import('/packages/sdk/src/incremental.mjs');
const incremental=createIncrementalClient({client:session.client,enabled:true,presentation:'popup'});
await incremental.loadCapabilities();
button.addEventListener('click',async()=>{
  const result=await incremental.grantMore({
    reason:'To add due dates to your calendar.',
    requests:[{fragment:'https://calendar.example/preferences/v1',purpose:'Add task due dates.',
      fields:['calendar'],methods:{calendar:{'https://contracts.example/calendar/v1':['createEvent']}}}],
  });
  // Explain the result in the app and degrade gracefully; never automatically ask again.
  renderCalendarAccess(result);
});
```

`grantMore({requests, reason?})` accepts 1–4 optional requests (`required` absent or `false`; include the pinned `digest` when available). It binds the request to the current session's issuer and subject and uses the redirect/popup lifecycle from `flows.mjs`. Completion returns `{outcome:'completed', fragments}`. Each fragment has `outcome` (`granted`, `partial`, `declined`, `unsupported` or `unavailable`), `granted`, and `methods[field][contract]: {granted, missing}` arrays for the requested methods. For `granted` and `partial`, `granted` is the **complete current grant**, including access beyond the request; do not merge it as a delta. Missing outcomes mean declined. On a decline, the helper reports previously known access; an unknown previous method is conservatively missing. Read values and scoped resource identifiers through ordinary `client.readPreferences(fragment)`.

An exchange without tokens leaves existing app sessions intact. If new credentials are issued, completion also returns a validated `issuedSession`; it never silently replaces the app's current session. Existing sessions gain the approved union at their next provider live check. If your app does not need the issued session, call `await session.client.revokeSession(result.issuedSession)` once, then `session.client.forgetSession(result.issuedSession)` to release its unused key. Retain any issued session's DPoP key until its use or revocation ends; the helper checks identity and the recorded existing session deadline before returning it.

`configure({target:{fragment, digest?, fields?}, suggestion?:{values}, reason?})` opens one already-granted fragment, optionally restricted to 1–8 fields. Suggestions contain atomic values only; resource references, occupants and grants cannot be suggested. The provider validates the pinned schema and requires the owner's acceptance. Both `{outcome:'configured', preferences}` and `{outcome:'unchanged', preferences}` include a fresh `@preferences` read with its `revision`; the front-channel outcome is only a hint. Compare that revision and read the returned values before acting. A failed read returns an error and confers no authority.

For `presentation:'redirect'`, recreate the helper on the exact registered callback and use `handleCallback({session:incremental})` from `callback.mjs`, or `incremental.completeCallback(location.href)`. The helper consumes state once and binds the callback URI, issuer and result kind. Popup callback pages can use the existing argument-free `handleCallback()` relay. Redirects keep pending metadata and the PKCE verifier in session storage, never tokens. Restore your app's connection to the **same issuer and subject** before completing a configure redirect so the helper can read preferences; the SDK's memory-only app session does not survive navigation by itself. A redirect grant exchange can complete without a restored session. A configured persistent `client.keyStore` is needed to bind a redirect exchange with DPoP; popup keys remain in memory.

Entry limits return `{outcome:'rate_limited', code:'rate_limited', retryAfter?, ownerReviewUri?}`. `retryAfter` is seconds from `Retry-After`; review links are accepted only on the issuer origin. The helper does not retry entry creation, decisions, uncertain token exchanges or preference reads. Its only bounded protocol retry is one DPoP nonce challenge. Respect declines and cooldowns, offer a review link when provided, and send no request for your app's own “Not now” action. Start requests only from an explicit user action; never ask on page load or schedule another prompt.

An undeclared intent returns `unsupported-provider` without sending it. The app may explicitly offer the draft's full-request login fallback for `grant-more`, or a settings link for unsupported `configure`; the helper never starts another consent flow automatically. Transport outcomes such as `redirecting`, `popup-blocked`, `dismissed` and `canceled` retain their existing meanings. `cancel()` ends the pending flow; `dispose()` releases the helper. Tests can drive the same logic through `createIncrementalEngine`, the exported Begin/Complete/Cancel Actions and `IncrementalResult` Query.

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

## Events: integration-hosted bus conformance (EV-4, provisional)

An integration-hosted bus implements [events §3.2–§8](spec/events.md#32-integration-hosted-buses): pull only, with live provider introspection before **every** publish, including transaction replays. The manifest URL and canonical digest are immutable; grants do not cover successor buses. Brokered reads require the verified `bindle.bus: {floor_at, history}` claim, and return only records strictly after that time unless the owner approved history. Reads stop within the 360-second revocation bound, or earlier after acknowledged revocation. These draft requirements and passing local fixtures confer no production approval.

From a repository checkout with Node 24+ and dependencies installed, run the reference in-memory host and provider client checks:

```sh
node --test tests/event-bus-conformance*.test.mjs
```

`tests/fixtures/integration-bus.mjs` is a separate extension using the existing integration fixture's logical HTTPS `.example` identities. It is default off (`createIntegrationBus({enabled:true})` is test-only opt-in), uses private ngin Actions/Queries over an injected provider, and has no production route or subscription transport. It uses opaque stand-ins for **already verified** brokered tokens. Its passes prove host/client behavior against a fake issuer; they do not test JWS/DPoP verification, real provider introspection, durable recovery, deployment, or external-service conformance. The existing integration server is unchanged. Production `EVENT_BUSES_ENABLED`, `INTEGRATIONS_ENABLED` and `BROKERING_ENABLED` remain default off and their independent release gates still apply.

To run the same host scenarios against your implementation, supply a local ESM adapter exporting `async createIntegrationBus(options)`:

```sh
EV4_BUS_ADAPTER=/absolute/path/to/your-bus-adapter.mjs node --test tests/event-bus-conformance.test.mjs
```

Every host scenario runs with a fresh isolated owner; none is skipped for adapters. A missing factory export fails the run. The additional fixture-engine test always tests the reference fake and is labelled separately. Adapter setup must clean up partial creation when it rejects, and `close()` must clean up successful instances. The host factory receives `{enabled:true, manifest?, limits?}`; omitted manifests use the exported `busManifest()`. It must reject invalid manifests or limits before installing an occupant. Use only a disposable local/test environment. The suite intentionally changes grants, retention, pins and availability.

The adapter interface is:

| Member | Contract |
| --- | --- |
| `origin`, `resource`, `manifest` | The logical called origin (`https://integration.example`), initial resource (`https://integration.example/r/task-changes`), and the full pinned document. Import the fixture constants to avoid spelling differences. Transport can map those logical identities to your local server while preserving token audiences. |
| `clock.now()` | The test issuer/host clock in milliseconds; only `control({op:'advance',seconds})` advances it. Start with a positive whole Unix second. |
| `call(token,method,args={},tx?,resource?)` | Invoke the actual bus RPC (or resource descriptor for `describe`); default resource is `resource` above. Return the unmodified contract result or throw an error with its protocol `code`. The adapter may translate transport errors, but must not implement validation, authorization, cursors, gaps or deduplication on behalf of the host. |
| `control(input)` | Drive the isolated test issuer and owner controls below; never expose these controls as application APIs. |
| `snapshot()` | Return `{introspections:[...]}` recorded at the test provider's live introspection endpoint. Each received publish authorization request appends an entry, including denials and failures. Do not infer this trace from successful publishes or host counters. |
| `close()` | Shut down transport/resources and destroy the isolated test owner. |

The test-only controls mirror the reference extension. They may drive your existing owner API and a test issuer; they must exercise your host's actual implementation:

| `control` input | Required behavior |
| --- | --- |
| `{op:'pin',manifest,digest?}` | Fetch/pin the supplied public test document; return `{manifest,digest}` using canonical SHA-256 with the `sha256-` prefix. Expected-digest mismatch is `digest_mismatch`; changed contents at a pinned URL are `schema_changed`. Invalid bus manifests are `unsupported_fragment`. Retain unknown top-level members in the digest. |
| `{op:'create',manifest,resource}` | Owner assigns a **new, empty** bus for this document/resource, returning its descriptor data. Keep existing buses; never copy their records or grants. Initial creation uses the same path. |
| `{op:'approve',client,methods,history?,floorAt?,grant?,resource?,claims?,binding?}` | Return an authenticated test token. `client` maps to `https://<client>.example/bindle/client.json`; default resource is the initial bus, floor is the current Unix second, history is false, and token lifetime is 300 seconds. Bind to the fixture issuer/subject/connection, exact manifest/digest/resource and method ceiling. `grant` changes the grant ID while retaining a supplied floor for widening tests. `claims` and `binding` override verified claims for negative vectors (e.g. wrong audience, purpose, resource, digest or a missing `bus` claim); sign these with the test issuer. An unapproved history request on a `history: "never"` bus is `forbidden`. |
| `{op:'revoke',token,acknowledged?}` | Revoke the token's current live grant at the test provider. Unacknowledged reads may continue until token expiry; writes must fail on their next live check. `acknowledged:true` also delivers/applies host invalidation before returning. Re-approval gives a new floor; renewed same-client tokens must not lose the publisher journal. |
| `{op:'introspection',mode}` | Set the test provider to `active`, `inactive`, `budget` (exhausted, `active:false`) or `outage` (unavailable). Every denied/unavailable check fails closed with `forbidden` in this adapter contract. |
| `{op:'advance',seconds}` | Advance both clocks and run due retention maintenance without a real sleep. Existing tokens keep their original expiry. |
| `{op:'purge',resource?}` | Owner purges retained records, keeping head and journal; subsequent reads report loss. |
| `{op:'lose-reply'}` | Drop the next successful publish reply **after committing** and surface `indeterminate`. Retrying the same `tx` must return its original receipt without republishing. |

The scenarios cover pinning and successor isolation; pull-only limits; host-stamped attribution; client/bus/floor-bound cursors and widening; strict time floors and history; retention by time, count and bytes; purge gaps; live publish checks during replay/revocation/outage/budget denial; bounded read revocation; method ceilings and token bindings; UTF-8 record/request/response bounds; total/per-publisher ordering; opaque receipts, concurrent replay, `tx_conflict`, lost replies and journal retention (including the ten-minute minimum). The client suite additionally verifies malformed-response rejection without advancing its cursor, foreign-attestation filtering, deduplication, gap callbacks, and explicit same-transaction retry after uncertainty. It never attempts `subscribe` or `unsubscribe`.

In the fake, `binding.fragment` and `binding.digest` stand in for the test issuer's pinned grant/assignment metadata; they are **not new wire claims**. A real adapter should translate these negative vectors into its test issuer's existing pinned approval checks, and otherwise mint the token shape from integrations §5.3 plus the specified `bindle.bus` claim. The integration journal key remains `(iss, sub, client_id, tx)` across resources; changing the resource under the same transaction is `tx_conflict`.

For a consumer using `packages/events/client.mjs`, pass `attestor: projection.broker.origin` and `brokered: {floorAt: verifiedClaims.bindle.bus.floor_at, history: verifiedClaims.bindle.bus.history}`. The client validates the complete response envelope before updating its cursor and validates publish receipts; it never retries on its own. These checks cannot prevent a dishonest integration from fabricating records or attribution, and do not replace host authorization or manifest/payload validation.

Review/sign-off for this provisional conformance contract: reviewer ___ / date ___ / outcome ___. No independent review or production verification is claimed.

## Integrations: provider and integration conformance (EXT-X9b, provisional)

The integration conformance suite checks a provider's side of [integrations §5–§7](spec/integrations.md) against a reference integration, and an integration's side against this provider's real token, event and introspection code. Everything runs locally with `.example` identities and fake clocks; nothing is fetched from the network. Integrations are default off (`INTEGRATIONS_ENABLED`, `BROKERING_ENABLED`).

From a repository checkout with Node 24+ and dependencies installed:

```sh
node --test tests/integrations-conformance.test.mjs
```

The suite covers the following.

| Area | What a conforming party must do |
| --- | --- |
| Webhooks (§6) | Accept SETs signed with an `event`-purpose key from `brokered-resources.v1.jwks_uri`. Look up the connection before fetching any key. Apply `preferences-updated` snapshots in `seq` order, ignore stale `seq`, and answer `202` to duplicates and unknown event types. A provider re-signs a retried SET with the same `jti` and coalesces markers. |
| Discovery (§5.2) | Honour contract filters, exact `ids` probes (`limit: 0` → `exists`), text search and cursors, never across connections. Refuse unknown contracts and facets with `400`. |
| Brokered tokens (§5.3) | Accept only ES256 RFC 9068 `invoke` tokens for your `rpc_endpoint`, for the token's resource, connection generation and methods. Refuse `discover`, `describe` and expired tokens. Verification never writes to the provider's key ring, and rotated keys stay published until their tokens expire. |
| Introspection (§5.7) | For write-effect methods, introspect on every call with `private_key_jwt` and no caching. Fail closed when the endpoint answers `active: false` or is unreachable. |
| Invalidation (§7) | `credential-revoked` rejects the listed grants. `connection-revoked` raises the generation floor, even out of `seq` order, and a later `connection-resumed` re-admits the new generation. |
| 360 s bound (§7.4) | After severance, a provider mints no new token, and a released token stops working at most 360 s later. That holds with every webhook lost, a verifier 30 s slow and 30 s leeway. |

The suite also checks the following provider-side behaviour:

- generation fencing through suspend and resume;
- `seq` on `preferences/v2` for integration readers;
- credential-free X6 snapshots bound to (connection, generation);
- SSRF-refused discovery egress;
- explicit reconfirmation after a record becomes unavailable.

To test your own integration, use `tests/fixtures/integration-server.mjs` as the reference for the expected HTTP behaviour. Its `createIntegrationServer({verifyToken, introspect, requiresIntrospection, connections, resources, clock})` takes injected verifiers, so the brokered-token, webhook and introspection tests drive it with tokens minted by `packages/federation/signing.mjs` and SETs from `packages/runtime/integration-events.mjs`. Replace `server.fetch` with requests to your own endpoints, served under their logical HTTPS audiences, and keep the assertions. `server.listen()` serves the fixture on loopback HTTP when you want to point a client at it.

What this does **not** establish:

- interoperability with any external integration or provider;
- delivery over the public Internet;
- production key custody;
- per-IP limits beyond the local adapter's.

The provider does not yet accept hints (`hint_endpoint`, AMD-C10). Review and sign-off: reviewer ___ / date ___ / outcome ___.
