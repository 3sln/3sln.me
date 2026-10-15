# Embeddable Bindle custom elements

Status: **provisional design, 2026-10-14.** Nothing here is implemented, published, or production-verified. This is a 3sln SDK deliverable. It is not part of the Bindle specification: Bindle defines rules, and these elements are one framework-neutral client of those rules. Where the design needs new wire behaviour, it lists that behaviour as a dependency and does not define it. The coordinator records decisions in DEVLOG.md. Independent review: [embeddable-elements-review](../release/embeddable-elements-review.md).

Architecture/security/product sign-off: reviewer ___ / date ___ / outcome ___.

**Superseded (2026-10-14):** phase 2 (the partitioned-cookie provider panel), §7 in full, dependency D5 and slice S5 are superseded by [adaptive app sign-in](adaptive-app-sign-in.md) (key-bound embed credentials, frame-initiated popup and FedCM) and [embed islands](embed-islands.md), which also replaces §2's panel row, §3.3 `show-provider-accounts`, §8.2 iframe markup, §8.3 step 6 and the §8.4 message table. D6 is resolved by removing UI rules from the Bindle spec. The text below is kept as the design record.

Builds on: [authentication](../spec/auth.md), [protocol](../spec/protocol.md), [security gates](../spec/security.md), [multi-account sessions](multi-account-sessions.md), [multi-account UI](multi-account-ui.md), [multi-account review](../release/multi-account-review.md) (especially *New provider-owned authorization entry* and *Iframe privacy and browser limitations*), and [browser automation](browser-automation.md) (postMessage rules). The existing SDK is `packages/sdk/src/identity.mjs` (`BindleClient`) and `packages/sdk/src/login-element.mjs` (`<bindle-login>`).

## 1. Goals and non-goals

Goal: an app can add "sign in with your Bindle identity" with a few lines of HTML. That covers signing in, a signed-in badge with a dropdown, embedder-supplied menu items, account switching, signing in again, and signing out. The app gets consistent theming and never learns which provider accounts the user has, or whether the user is signed in, before the user approves.

| Goal | Design answer |
| --- | --- |
| Easy integration | Plain custom elements plus one non-visual `<bindle-session>` controller. No framework, no build step, SSR-safe definitions. |
| Sensitive things isolated | Account inventory, credentials and consent are rendered only by provider-origin documents: a top-level popup/redirect (phase 1), plus an optional label-only provider iframe (phase 2). The embedder's DOM gets only what the user typed, and the identity the user approved. |
| Non-sensitive things embedder-owned | Sign-in form, badge, menu shell, embedder slots and CSS parts run in the embedder's DOM and are fully styleable. |
| Consistent theming | One set of `--bindle-*` CSS custom properties styles the light-DOM elements. The same values are resolved, validated and sent to provider frames as an allowlisted token set. Provider consent surfaces are deliberately *not* embedder-themed. |
| Framework branding | Elements say "Bindle", never "3sln.me". The only special treatment of 3sln.me is the default `@3sln.me` handle suffix, which disappears once `@` is typed. The provider's identity appears only as its host name, where the user needs it to make a decision. |

Non-goals: silent sign-in or a `prompt=none` style probe (§5.5); app-readable provider session state; embedding final consent in an iframe; cross-provider account aggregation; persisting tokens beyond the existing in-memory SDK policy.

## 2. Where each thing renders

| Surface | Origin and context | What it shows | Phase |
| --- | --- | --- | --- |
| `<bindle-sign-in>` form | Embedder document, open shadow root | Handle input with `@3sln.me` suggestion; resolved provider host; local discovery errors | 1 |
| `<bindle-account>` badge and menu | Embedder document, open shadow root | Only the *approved* identity: subject-derived monogram, plus handle/display name if the app was granted those profile fields; built-in actions; embedder slots | 1 |
| Authorization popup or redirect | Provider origin, top-level, `COOP: same-origin` | Account chooser, sign-in, add account, consent, reauthentication, end-session confirmation | 1 |
| `<bindle-provider-accounts>` panel | Provider origin, cross-site iframe, partitioned storage | Labels of this browser's provider accounts that the user chose to show on this site; actions open the popup | 2 (gated) |

**Phase 1 needs no iframe.** Without an embed credential, a provider iframe in an app has no Strict session cookie, so it cannot show anything account-specific (§7). A "launcher" iframe would add only a provider-styled button, which the embedder's DOM can render equally well. Phase 1 therefore ships the user-facing essentials with popup/redirect isolation. The iframe/postMessage/theming channel the user asked for arrives in phase 2, where it carries real value: the account switcher list is visible to the user and invisible to the embedder.

Shadow DOM is a styling boundary, not a security boundary. Everything in the embedder's DOM, including a closed shadow root, is readable by embedder script. The design assumes the embedder can read every keystroke in `<bindle-sign-in>` and every byte the light-DOM elements hold.

## 3. Element inventory

All elements use the `bindle-` prefix. Every event is a `CustomEvent` with `bubbles:true, composed:true`. Every element works without JavaScript frameworks and degrades to inert content before definition.

### 3.1 `<bindle-session>`: non-visual controller

Owns one `BindleClient` and one flow at a time. Descendants find it through a DOM context request (§9.3), so it can wrap arbitrary embedder markup. You can also link an element explicitly with `controller="<id>"` (EE-18).

| Kind | Name | Notes |
| --- | --- | --- |
| attr | `client-id` (required), `redirect-uri` (required) | Exact registered values. Mismatch fails at the provider. The element does not guess. |
| attr | `presentation` | `redirect` (default; matches spec v0) or `popup`. Popup falls back to an explicit "Continue in this tab" offer (§6.3). |
| attr | `requests-src` | Optional: the `id` of a `<script type="application/json">` holding fragment requests. This lets requests be declared in HTML. |
| prop | `client` | Public API: the `BindleClient` used for `readPreferences`, `callResource` and `userMessage` after sign-in. Assign before connection to supply your own (EE-13). |
| prop (read-only) | `ready` | Promise resolving once the controller has initialised and emitted its initial state. |
| prop | `requests` | Fragment request array, as in `BindleClient.beginLogin`. |
| prop (read-only) | `session` | `null`, or `{issuer, subject, grantedFragments, profile?}`. Contains only post-approval data. `profile` exists only if granted. |
| prop (read-only) | `state` | `signed-out`, `pending`, `signed-in`. This is *app* state, never provider state. |
| method | `signIn({identity?})` | Starts an authorization entry with intent `login`. Identity is an optional non-authoritative hint (§5.1). |
| method | `switchAccount()` | Intent `select-account`. Fresh PKCE/state. The current session is kept until a new one completes. |
| method | `reauthenticate({maxAge})` | Intent `reauthenticate`, constrained to the current subject. Success requires the same subject and `auth_time >= now - maxAge`. `auth_time` is returned **only** for this intent; on ordinary sign-in it would reveal whether the user had to sign in first (EE-02). |
| method | `signOut({revoke=false})` | App sign-out: clear SDK memory and pending login, and, if the provider advertises it, revoke this app's grant/refresh token. Never touches provider sessions. |
| method | `endProviderSession()` | Intent `end-session`. Shows the provider's confirmation page. Also performs app sign-out locally once the flow finishes. |
| method | `completeCallback(url?)` | Low-level redirect completion for apps not using `handleCallback()`. Wraps `client.completeLogin`. |
| event | `bindle-session-change` | `detail: session \| null`. Fires once on connect (initial state, so late listeners can read `session` or await `ready`), then on approval, switch completion, sign-out and expiry. |
| event | `bindle-flow-start` | `detail: {intent}`. The intent is what the *app* requested. |
| event | `bindle-flow-end` | `detail: {intent, outcome}`. `outcome` is `completed`, `canceled` or `dismissed`, plus local-only outcomes (`popup-blocked`, `discovery-error`, `network-error`). `canceled` covers every provider-side non-approval (§4). |
| event | `bindle-error` | Configuration errors only (missing `client-id`, invalid `redirect-uri`). Flow failures, including discovery, are reported only through `bindle-flow-end` with stable `code` values (`discovery-unavailable`, `unsupported-provider`, `no-provider`, `popup-blocked`, `network-error`) (EE-19). |

Every flow method returns `Promise<{outcome, code?}>` mirroring `bindle-flow-end`; it never rejects for provider-side outcomes (EE-13).

Flow methods in `popup` mode must be called during transient user activation (`navigator.userActivation.isActive`). Otherwise they reject with `NotAllowedError` and never open a window. In redirect mode they may be called programmatically, for example when the app requires reauthentication before a sensitive action.

### 3.2 `<bindle-sign-in>`: handle entry (successor to `<bindle-login>`)

`<bindle-login>` stays as a compatible alias for one minor version. Its existing `client`/`requests` properties and `bindle-login-request`/`bindle-email-fallback` events are preserved.

| Kind | Name | Notes |
| --- | --- | --- |
| attr | `lang`, `theme` (`auto`/`light`/`dark`) | §10 and §11. |
| attr | `identity-required` | Boolean. If absent and the provider advertises the identity-optional entry, an empty submit continues to the default provider without a handle. That keeps the handle out of the embedder's reach (§4). |
| attr | `default-host` | **Open question (§14).** Proposed fixed `3sln.me`, overridable only for self-hosted builds. |
| slot | `heading`, `help`, `footer` | Embedder copy. Security-relevant copy (the provider host announcement, discovery errors, the email-fallback disclosure) is not slottable or overridable. |
| part | `form`, `label`, `field`, `input`, `suffix`, `submit`, `status`, `provider-note` | |
| event | as `<bindle-session>`, plus legacy events | Without a session or client, emits `bindle-login-request` as today. |

Behaviour: `@3sln.me` renders as a visual suffix (and an `aria-describedby` hint) until the value contains `@`. Parsing reuses `parseIdentity` unchanged. Host-level discovery may start on blur or after a 400 ms pause in typing; it is cookieless and public. Parsing and validation happen before any window opens, so a typo never flashes a popup (EE-15). Before navigating, show "You'll continue at **example.org**", using the host name only, with no provider logo.

### 3.3 `<bindle-account>`: badge, dropdown and switcher shell

Renders the signed-out slot until `session` is non-null. Then it renders a badge button that opens a menu.

| Kind | Name | Notes |
| --- | --- | --- |
| attr | `actions` | Space-separated subset of `switch reauth sign-out provider-sign-out manage`. Default: `switch sign-out`. |
| attr | `show-provider-accounts` | Phase 2: embeds `<bindle-provider-accounts>` in the menu (§7). |
| slot | `signed-out` | Defaults to a button that calls `session.signIn()`, or focuses a sibling `<bindle-sign-in>` if one exists. |
| slot | `badge` | Replaces the monogram, for example with the app's own avatar. |
| slot | `menu-header`, `menu-start`, `menu-end` | Embedder menu items. Children with `role="menuitem"` join keyboard navigation. |
| part | `badge`, `monogram`, `label`, `menu`, `menu-header`, `item`, `item-danger`, `separator`, `provider-frame` | |
| event | `bindle-menu-toggle` | `detail: {open}`. |

Identity display uses only data the app already has. The monogram is computed locally from the subject URL; nothing is fetched. The handle or display name appears only if the app requested and was granted a profile field. Otherwise the label reads "Signed in · example.org". The element never shows the handle typed into `<bindle-sign-in>`, because the user may have chosen a different account at the provider.

Built-in actions map to `<bindle-session>` methods. Labels: "Use another account", "Confirm it's you", "Sign out of this app", "Sign out of example.org…", "Manage at example.org" (the provider's connected-apps page, opened in a new tab with `noopener`). The `provider-sign-out` label says plainly that other apps and accounts are not affected unless the user chooses so at the provider.

### 3.4 Smaller pieces

- `<bindle-monogram subject="…">`: a standalone deterministic monogram. Pure and offline.
- `<bindle-access-summary>` (optional, phase 1b): lists the token's `grantedFragments` titles, which the app already knows, with a "Review at example.org" link. Not a provider status probe.
- `handleCallback()` (module function, not an element): used on the registered callback page. It completes in place in redirect mode and relays in popup mode (§6.2).

### 3.5 Minimal integration

```html
<script type="module" src="https://cdn.example/bindle-elements@1/define.mjs" integrity="sha384-…" crossorigin="anonymous"></script>
<bindle-session client-id="https://app.example/client" redirect-uri="https://app.example/callback" presentation="popup">
  <bindle-account actions="switch reauth sign-out provider-sign-out">
    <bindle-sign-in slot="signed-out"></bindle-sign-in>
    <a slot="menu-start" role="menuitem" href="/settings">Settings</a>
  </bindle-account>
</bindle-session>
```

## 4. Information that crosses to the embedder

The rule: before approval the embedder learns only what it caused or what the user typed into it. After approval it learns only the approved identity and grants.

| Stage | Embedder can learn | Embedder must not learn |
| --- | --- | --- |
| Typing | The characters typed (inherent to an embedder-DOM input), and public host-level discovery results | Anything about provider sessions. Discovery runs with `credentials:'omit'`. |
| Entry creation | Success, or a generic error that does not depend on sessions (the POST sends no cookies). A handle is a hint, not resolved at entry time, so there is no existence oracle (dependency D1). | Account existence, availability or UUID for the new entry. The legacy identity-pinned request keeps its documented availability trade-off. |
| Flow in progress | That a window opened. Under COOP the popup reports `closed` early, and abandonment and elapsed time remain observable (an accepted residual). | Popup frame count, navigations, focus, or which provider screen is showing (COOP same-origin on every provider page in the flow). |
| Completion | A one-use code at the registered callback, then via token exchange: subject, issuer, granted fragments, and `auth_time` only when the app asked for `reauthenticate` | Other accounts, account count, whether the user switched, whether the user had to sign in first, and whether this account approved before |
| Non-completion | `error=access_denied`, identical for user cancel, no account, sign-in failure, request expiry and provider-side errors | Any distinguishing reason |
| End-session | `result=completed\|canceled`, with state | Whether a session existed. With no session, the provider tells the user and still returns `completed`. |
| Phase-2 panel | `ready` (constant), `theme-result` (derived only from the embedder's own input), `flow-started` (identical for every control), `escape` | Labels, count, paired/unpaired state, errors, size, focus, load timing (§7.5) |

Accepted residuals (stated, not mitigated away): time-to-completion and abandonment; the identity actually approved; the handle the user typed; and whether the user ever completes. Browser-wide side channels such as CPU contention or extension behaviour are out of scope. The actionable contract is that no designed signal depends on provider session state.

## 5. Mapping app flows onto the provider-owned authorization entry

All flows use the proposed **provider-owned authorization entry** (dependency D1): a pre-owner request that pins client, exact callback, PKCE S256 challenge, state, requested fragments/methods, intent, nonce and expiry, before any account is chosen. The account is chosen only on the provider's first-party page.

### 5.1 Request shape the SDK will send (needs server and spec agreement)

`POST authorization_entry_endpoint`, with `credentials:'omit'`, `redirect:'error'`, JSON, bounded:

```json
{"clientId":"…","redirectUri":"…","challenge":"…","challengeMethod":"S256","state":"…",
 "intent":"login|select-account|reauthenticate|end-session",
 "loginHint":"alice@example.org","subjectConstraint":"https://example.org/entities/…",
 "maxAge":300,"requests":[…],"uiLocales":["es"],"colorScheme":"dark","presentation":"popup"}
```

- `loginHint` is non-authoritative display pre-fill. It is ignored if it names another host, and never resolved at entry creation.
- `subjectConstraint` is allowed only with `reauthenticate` and `end-session`, and only with a subject the app already holds. The provider must not reveal whether that subject has a session here.
- `colorScheme` and `uiLocales` are the *only* presentation inputs to top-level provider pages. No embedder tokens reach consent (§8.6).
- The response is `{entryId}` (opaque). The SDK navigates to `authorization_endpoint?entry=<entryId>`. The identity-pinned `beginLogin(identity)` path remains for providers that lack the entry.

### 5.2 Intents

| App call | Provider behaviour (from multi-account UI/review) | Return | SDK obligations |
| --- | --- | --- | --- |
| `signIn` | Choose a live account or sign in/add one, then review access. Always name the account and offer "Use another account". No auto-approve. | code or `access_denied` | Validate state/iss, PKCE exchange, then `bindle-session-change` |
| `switchAccount` | Same chooser, explicitly opened. A fresh entry, so nothing is retargeted. | code for the newly approved account, or `access_denied` | Keep the old session until the new exchange succeeds. On cancel, the old session is untouched. On success, retire old tokens (`revoke` per app policy) and emit the change. The element does not reveal whether the new subject equals the old one beyond the subject itself. |
| `reauthenticate` | Fresh credential proof for the constrained subject. A different account is never a successful reauth. | code plus `auth_time` | Require same subject and `auth_time` within `maxAge`. On failure, keep the existing session and emit `outcome:'canceled'`. Do not silently restore revoked grants. |
| `endProviderSession` | Provider page names the client and the exact account/session. Default scope is that account in this browser. Other accounts/devices need separate provider choices. | `completed\|canceled` | Always clear app tokens afterwards, whatever the result. Never call without user activation in popup mode. |
| `signOut` | none (local), plus optional token/grant revocation (D3) | none | Clear memory, abort refresh, clear pending login. Does not claim the provider session ended. |

Never: GET-triggered provider logout, image/iframe logout, postMessage logout commands, or app-chosen owners.

### 5.3 Required `BindleClient` changes (EE-08)

Today `cancelLogin()` increments a single `generation`, which also cancels in-flight RPCs and nulls the session during a refresh. Both `beginLogin` and `completeLogin` call it, and pending state uses one fixed `sessionStorage` key. Before `switchAccount` can keep the old session, split this into a login generation and a session generation. Starting or completing a login must never cancel RPCs or null the current session until the new token exchange succeeds. Key pending storage by `(clientId, state)` so two controllers on one page cannot collide.

### 5.4 Callback handling

Unchanged `completeLogin` validation applies: exact callback, allowed parameter set, state, `iss`, single-use pending transaction, and history scrub. End-session callbacks are a separate parameter set (`state`, `iss`, `result`) validated by `completeEndSession`, so a login code can never be confused with an end-session result.

### 5.5 Why no silent check

A hidden iframe, `prompt=none`, or a background popup that returns "already signed in" is a session-presence oracle, and Strict cookies make it unreliable anyway. After a reload the app is signed out (in-memory tokens, existing SDK policy). The user clicks once, and the provider shows "Continue as …" for an already-approved account. Apps that need persistence should use a backend token vault (security.md).

## 6. Popup and redirect mechanics

### 6.1 Opening without tripping popup blockers

Discovery and entry creation are asynchronous, but `window.open` must run inside the click. In the click handler, synchronously call `window.open('about:blank', name, 'popup')`, passing no position or size features so the embedder cannot place provider buttons under the cursor (EE-04), then immediately set `popup.opener = null` (it is still same-origin), and render a neutral "Contacting your provider…" text into it with `textContent` (no markup). Once the entry exists, assign `popup.location` to the provider URL. If discovery or entry creation fails, close the popup and show the error inline. Handle parsing completes before `window.open` (EE-15).

The entry URL (`authorization_endpoint?entry=…`) must return one static, cookie-independent COOP document with no server-side redirect. The account-dependent rendering happens after that commit, from same-origin requests. Otherwise, when the first COOP page commits it becomes an opener-observable timing signal that depends on the session (EE-10, dependency D4).

**Popup clickjacking (EE-04, dependency D4).** The embedder controls the timing of the click that opens the window and can try to land a second click of a double-click on the provider page. On approve, account choice, add-account and end-session, provider controls stay inert until the page has been visible and focused for at least 600 ms, and they then require a fresh `pointerdown`/keyboard activation that starts on the control. The approve button never has default focus. Opening the provider URL directly with `noopener` is rejected because `window.open` then always returns `null`, which makes blocked popups undetectable.

### 6.2 Completion without opener

Every provider page in the flow sends `Cross-Origin-Opener-Policy: same-origin`, which severs the opener. This also prevents opener-side XS-leaks (`popup.length`, navigation timing). The registered callback page then runs in the popup, top-level at the app origin. It calls `handleCallback()`, which, in popup mode:

1. runs as the first script on the page, which is served with `Referrer-Policy: no-referrer`, ahead of any analytics or third-party script (EE-16);
2. reads `code`, `state` and `iss` (or `error` / `result`), then calls `history.replaceState` to drop them;
3. posts only `{v:1,type:'bindle-callback',code,state,iss}` on `BroadcastChannel('bindle-callback:' + sha256(state).slice(0,16))`. The channel is same-origin and in the opener tab's storage partition. This is app-origin to app-origin, never a provider-to-app message;
4. shows a persistent "Return to app.example. You can close this window" message, then tries `window.close()`, which may silently fail after the COOP browsing-context swap or when iOS opens the popup as a tab (EE-11, needs browser verification).

The callback module ships a single `handleCallback()`. If this tab holds a pending transaction for the returned `state`, it completes in place (redirect mode). Otherwise it relays (popup mode). The pending PKCE verifier lives in the *opener* tab's `sessionStorage`, so the popup can never redeem the code itself. There is no "complete in the popup" fallback (EE-03). Without BroadcastChannel, popup mode is unavailable and the element uses redirect.

The main tab listens only while that transaction is pending. It validates the message shape, then runs the full `completeLogin` validation. State mismatches, duplicates and late arrivals are rejected by the existing single-use transaction. auth.md currently says popup completion uses provider postMessage carrying only a completion reference. This same-origin relay of the code is a different transport and must be reconciled (dependency D7, EE-02).

### 6.3 Failure UX

| Situation | Behaviour |
| --- | --- |
| `window.open` returns `null` (blocked) | Inline notice (`role="alert"`): "Your browser blocked the sign-in window." Buttons: **Try again** (new activation) and **Continue in this tab** (redirect with a fresh entry, EE-17). No automatic redirect. `bindle-flow-end{outcome:'popup-blocked'}`. |
| Popup opened, user lost it | After 2 s, show "Waiting for example.org… **Show window** · **Continue in this tab** · **Cancel**". **Show window** calls `popup.focus()`. This is best effort: after the COOP swap the handle reports closed and the call does nothing. **Continue in this tab** cancels the transaction and starts a fresh redirect entry. The old popup's late callback fails state validation and shows "This sign-in was replaced". |
| Embedded webviews or iOS in-app browsers | Detection is unreliable, so `presentation=popup` always keeps "Continue in this tab" visible next to the waiting state. |
| Popup closed without result | Not observable under COOP. The waiting state persists until **Cancel** or a 10-minute entry expiry, then `outcome:'dismissed'`. |
| Redirect mode in an SPA | The app must route `redirect-uri` to a page that calls `handleCallback()` before loading unrelated code (existing integration guidance). |

## 7. Phase 2: provider accounts panel in an iframe

### 7.1 Why a separate embed credential

The vault cookie is `SameSite=Strict`. It is never sent to a cross-site iframe, and the Storage Access API does not attach Strict or Lax cookies even when access is granted. Weakening the vault to `SameSite=None` is rejected (multi-account sessions). The panel therefore uses a **label-only, partitioned (CHIPS) embed credential**, created only through an explicit user choice in a top-level provider page. Whether WebKit/iOS accepts CHIPS cookies under its default third-party policy needs browser verification. If it does not, phase 2 is Chromium and Firefox only, and WebKit users keep the popup path. Storage Access with an unpartitioned `SameSite=None` embed cookie is the documented alternative. It is not chosen first because it needs per-browser prompts, prior first-party interaction (WebKit), and a cookie visible to every embedding site.

### 7.2 Authority of the embed credential

- **Display only.** It can return labels (handle, plus provider-local display name if the owner allows) for an immutable set of `(owner, session)` pairs. It cannot select an owner, bind an entry, approve, switch the console, sign out, or return tokens.
- **Snapshot-scoped**, per the coordinator capability blocker: accounts added later do not appear until the user refreshes the pairing in a top-level provider page. Revoked or expired members disappear, because the server intersects with live sessions.
- **Bound** server-side to `(client_id, pairing id, (owner, session) set)`. The server never sees the top-level site, so the site binding is *only* the browser's cookie partitioning plus `frame-ancestors`. A client registered on several sites shares one pairing record, and each site needs its own partitioned cookie, created by a pairing completed from that site (EE-06). It expires after 30 days at most (product number to be decided) and is revocable from a provider console list, "Sites showing your accounts". Signing out of a member removes it from all pairings.
- Because CHIPS partitions by top-level *site*, sibling subdomains of the embedder's site share the partition. Exact `frame-ancestors` (§8.1) limits which origins can frame the panel, and the server checks the registered client.

### 7.3 Pairing without an observable flow

Pairing is offered *only inside the normal authorization popup*: a checkbox, off by default, reading "Show my example.org accounts on app.example next time (app.example can't see them)". The panel itself does not present that phrase as a verification cue, because an embedder can render a fake panel with the same text. Users verify only in top-level provider pages (EE-20). The flow then ends with the ordinary callback (code or `access_denied`), so the embedder cannot distinguish a paired completion from any other.

Mechanics:

1. On first load, the panel's own same-origin request sets a random, partitioned, HttpOnly `__Secure-bindle_embed_candidate` cookie (`Path=/embed/api/`). It does this unconditionally, whatever the session state.
2. When the user starts a flow from the panel, the panel (a provider-origin document) opens the popup itself. Before navigating, it POSTs `{entryId}` to attach its candidate hash to the entry. Who created the entry: `<bindle-session>`, which passes `entryId` (non-secret) over the port.
3. If the user ticks the box and approves, the server records the pairing for the chosen `(owner, session)` set. On its next load, or a bounded poll while `flow-started` is active, the panel exchanges its candidate for `__Secure-bindle_embed` (`Partitioned; Secure; HttpOnly; SameSite=None; Path=/embed/api/`). `__Host-` is not usable here because it requires `Path=/`, which would send the cookie with embedder-initiated requests to every provider route. Some existing routes branch on whether any cookie is present (`packages/runtime/http.mjs`). Tests must show that non-embed routes ignore both cookie names (EE-01).

Server checks when a candidate is attached to an entry (EE-06): the entry's `client_id` equals the panel's `client_id`; the entry has not yet been opened in a provider page; each candidate attaches to at most one entry, and each entry to one candidate; both are short-lived. The pairing checkbox appears only on an entry that has an attached candidate.

### 7.4 Embed API gates

Partitioned cookies are also sent on requests that the *embedder's own top-level document* makes to the provider, because the partition key is the top-level site. Every embed API therefore requires all of the following before reading any cookie or vault state, and returns one constant 403 body otherwise:

- `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors|same-origin`, `Sec-Fetch-Dest: empty`;
- an exact provider `Origin`;
- a custom header (`X-Bindle-Embed: 1`);
- no CORS response headers. The embed API is never cross-origin readable.

Browsers without Fetch Metadata get no panel. The panel *document* (`/embed/v1/accounts`, `Sec-Fetch-Dest: iframe`) is static: identical bytes for every user of a given `client_id`, with cookies ignored. Because it carries that client's allowed origins and `frame-ancestors`, it is served `Cache-Control: no-cache` with an ETag, so registry changes take effect. Embed API responses are `no-store` (EE-12). Its responses never depend on the embed credential.

### 7.5 Panel behaviour constraints (side channels)

| Channel | Constraint |
| --- | --- |
| Size | Fixed height chosen by the parent (`size="compact\|regular"` → 248/320 CSS px). The frame never reports size. The list area always has `overscroll-behavior: contain` and a constant scrollable height (padded to a fixed row capacity), so wheel or touch scroll chaining into the parent page behaves identically for 0–5 accounts (EE-05, needs browser verification). |
| `contentWindow.length` | Always 0. The frame contains no nested frames, in any state. |
| Load and navigation | A single document load. All account fetches start after `load` *and* after `ready`. No later navigations, `location.hash` changes or reloads, so the parent sees exactly one `load` event. |
| Messages | The frame sends only `ready`, `theme-result`, `flow-started` and `escape`. Their contents never depend on paired state, labels, count or errors. `ready` is sent after theme application, before any credentialed request. |
| Focus | No `autofocus`, and no `focus()` without user activation inside the frame, so parent `blur` events reveal only user clicks. |
| Errors | Rendered only inside the frame ("Couldn't load accounts; open example.org"). Nothing reaches the parent. |
| Visual | Unpaired and empty-paired panels show the same neutral row ("Choose an account at example.org"). Rows are rendered only inside the frame. |
| Actions | Every control (account row, "Add account", "Choose an account") opens the same popup to the same `entryId` URL, adding at most an opaque `account_hint` that is meaningful only to the first-party provider page. The frame emits the same `flow-started`. "Manage" opens a new `noopener` tab. "Stop showing accounts here" requires an in-frame confirmation and emits nothing. |

Selecting a row never authorizes, switches or completes anything by itself. The top-level popup does the authenticated selection and the final approval. A future no-popup "quick switch" to an already-approved account would be clickjackable and would reveal account linkage. It is deferred, and if ever considered, needs IntersectionObserver v2 `trackVisibility` evidence plus a separate review.

## 8. Frame security protocol

### 8.1 Framing policy

- `/embed/v1/*` only: `Content-Security-Policy: frame-ancestors <exact registered origins for client_id>`, computed server-side from the `client_id` path or query parameter. Unknown client, or none: `frame-ancestors 'none'`. No wildcards, suffix matching or query-supplied ancestors. CSP checks the whole ancestor chain, so an app nested inside an unregistered host fails closed. `X-Frame-Options: DENY` stays on every non-embed route. It cannot express an allowlist, so embed routes omit it and rely on CSP.
- Console, authorize, consent, recovery and account pages keep `frame-ancestors 'none'`. Nothing changes globally.
- Panel CSP: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'none'; base-uri 'none'; form-action 'none'`. No third-party assets or fonts.
- `Referrer-Policy: no-referrer` on panel and embed API responses.

### 8.2 Iframe created by the element

```html
<iframe src="https://provider.example/embed/v1/accounts?client_id=…#n=<nonce>"
        title="(localized) Your example.org accounts"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        allow="" referrerpolicy="no-referrer" loading="eager" style="color-scheme: <scheme>"></iframe>
```

If the embedder adds stricter sandboxing (an opaque origin, or no popups), the frame detects this (`origin === 'null'` makes the cookie and fetch path unavailable, and `window.open` returns `null`). It then shows a neutral "Open example.org" link. If popups are blocked as well, the parent's handshake timeout (§8.3) makes the element replace the frame with its own embedder-DOM "Use another account" action. The fallback timing does not depend on account state, because the decision happens before any credentialed request.

### 8.3 Handshake (MessageChannel binding)

1. **Parent** generates a 128-bit `nonce` (base64url), puts it in the iframe URL **fragment** (never sent to servers or referrers), and creates a `MessageChannel`.
2. **Frame**, on script start, reads and removes the fragment (`history.replaceState`). It installs one `message` listener that accepts an event only where `event.source === window.parent`, `event.origin` is one of the registered origins for `client_id` (embedded as JSON in the static document; the per-client list comes from a hashed public registry file, so the document stays static per client), `event.data` matches exactly `{v:1, type:'bindle-embed-init', nonce, theme, locale}` (theme and locale are validated as in §8.4–8.5), with a constant-time nonce comparison, and `event.ports.length === 1`. The first valid init wins. The listener is then removed and all further window messages are ignored.
3. **Parent** posts the init exactly once, from the iframe's first `load` event, with `iframe.contentWindow.postMessage(init, providerOrigin, [port2])`, where `providerOrigin` is the discovered issuer origin, never `'*'`. There are no retries and only one port exists, so the question of which port wins never arises. If the frame was not ready to receive, the 3 s timeout applies (EE-07).
4. **Frame** applies theme and locale from the init, then replies on the port with `{v:1, type:'ready', protocol:[1]}`. This ordering is what makes "ready after theme, before any credentialed request" possible. The parent treats the port as authenticated: only the document that received a message targeted at `providerOrigin` holds it. The nonce is defence in depth that binds the frame instance. Any script in the embedder page can read it, but embedder script is the embedder (EE-07).
5. All later traffic uses the port only. If no `ready` arrives within 3 s of iframe `load`, the parent closes the port, removes the iframe and renders the embedder-DOM fallback.
6. **Teardown**: element disconnection, `session` change, a menu closing longer than 60 s, or an iframe `load` event after the first (unexpected navigation) all close the port and recreate the frame with a new nonce. The frame closes itself on port `close` (where supported) or on `dispose`.

### 8.4 Message schema (v1)

Every message is a plain object of at most 2 KiB when serialized with JSON. It has an exact key set: unknown keys cause the message to be dropped, there is no error reply (a reply could be an oracle), and the drop is logged locally in development builds only. Strings are bounded. Structured-clone transfer of anything other than plain data is rejected.

| Direction | `type` | Fields |
| --- | --- | --- |
| parent → frame | `bindle-embed-init` | `v`, `nonce` (window message, with port) |
| parent → frame | `theme` | `v`, `seq` (uint32), `tokens` (object, ≤16 entries) |
| parent → frame | `locale` | `v`, `lang` (BCP 47, ≤35 chars) |
| parent → frame | `entry` | `v`, `entryId` (provider grammar). The entry the next popup should open. |
| parent → frame | `dispose` | `v` |
| frame → parent | `ready` | `v`, `protocol` |
| frame → parent | `theme-result` | `v`, `seq`, `rejected` (array of token names drawn only from the parent's input) |
| frame → parent | `flow-started` | `v` |
| frame → parent | `escape` | `v` |

The parent ignores `flow-started` unless an `entry` was sent and is still pending. Messages are rate-limited (10/s per direction). Excess messages are dropped.

### 8.5 Theme tokens: allowlist and validation

`<bindle-account>` resolves the embedder's CSS custom properties on itself. It assigns each color var to a hidden probe's `color` and reads the computed value, so `var()`, `color-mix()` and named colors all resolve in the embedder's realm. Computed colors may serialize as `rgb()`, `color(srgb …)` or `oklch()` depending on engine, so the element normalizes by painting the computed color onto a 1×1 canvas and reading the sRGB pixel back as `#rrggbb`, rejecting non-opaque results. Non-color tokens are read with `getPropertyValue('--bindle-…')` and matched strictly against the grammar below. Anything else is omitted (EE-09, needs browser verification in all three engines). The frame trusts nothing and validates again:

| Token | Grammar | Notes |
| --- | --- | --- |
| `surface`, `surface-raised`, `text`, `text-muted`, `accent`, `on-accent`, `border`, `focus`, `danger` | `^#[0-9a-f]{6}$` | Opaque sRGB only. No alpha, no functions, no names, no `url()`. |
| `radius` | integer 0–16 | Applied as px. |
| `font` | `system\|sans\|serif\|mono` | Maps to provider-defined local stacks. No font names, no loading. |
| `font-scale` | `0.875\|1\|1.125\|1.25` | |
| `density` | `compact\|comfortable` | |
| `color-scheme` | `light\|dark` | |

Semantic checks after the grammar: `text`/`surface`, `text-muted`/`surface`, `text`/`surface-raised` and `on-accent`/`accent` need contrast ≥ 4.5:1. `danger`/`surface` and `accent`/`surface` (accent is used for link text) need ≥ 4.5:1. `focus`/`surface`, `focus`/`surface-raised` and `border`/`surface` need ≥ 3:1 (EE-09). A failing pair reverts *both* members to the provider default for the current scheme and lists them in `rejected`. Unknown names are listed in `rejected`, as are duplicates and values over the bounds.

Application: the frame builds the text `:root{--t-surface:#xxxxxx;…}` *only* from validated canonical values and calls `sheet.replaceSync()` on a constructed stylesheet adopted by the document. Whether `style-src 'self'` permits constructed stylesheets in every engine needs browser verification. The fallback is setting each validated value with `style.setProperty` on the root element, which never parses a declaration block. Untrusted strings never reach CSS, attributes or `innerHTML`. The frame's trust elements (the "example.org" host line, the "app.example can't see this list" note, and warnings) use a separate fixed palette that ignores tokens. `forced-colors: active` ignores tokens entirely and uses system colors. Tokens never affect layout, visibility, opacity, position or z-index. They are color, radius and type only.

Theme updates: the parent resends (with an incremented `seq`) when `theme` changes, on `prefers-color-scheme` change, or when `refreshTheme()` is called. The frame applies the update synchronously and replies.

### 8.6 What is never embedder-themed

The authorization popup/redirect pages, the end-session confirmation, and every consent screen use the provider's own design and copy. The only inputs are `colorScheme` and `uiLocales`. An app restyling consent to look like itself is consent laundering (security.md).

## 9. Packaging

### 9.1 Modules

- `@<scope>/bindle-elements/elements.mjs`: classes and `defineBindleElements({prefix='bindle'})`. **No side effects on import.** Classes extend `globalThis.HTMLElement ?? class {}`, so importing under SSR (Node, Workers) is safe.
- `/define.mjs`: auto-defines with the default prefix and skips names that are already defined. This makes two copies on one page harmless, though the first wins.
- `/flows.mjs`: headless `createSession(options)` for apps that render their own UI. The elements use the same object.
- `/callback.mjs`: `handleCallback()`.
- Renders with vendored **dodo** (`reconcileShadow` from `@3sln/dodo/style` mounts into each element's shadow root and works with an existing declarative shadow root; `css` for constructable sheets; `@3sln/dodo/reactive` `cell`/`watch` for state). The provider panel document uses dodo plus an **ngin** `Engine` with providers for the port, theme and accounts, matching the portal. Embedder bundles do not include ngin. Budget: ≤ 18 KiB min+brotli for `define.mjs` excluding locale catalogues. Each catalogue is a separate lazily imported module.

### 9.2 SSR and hydration

Elements render meaningful light-DOM fallback (slotted content and a `<noscript>`-friendly link) before definition. A server may emit declarative shadow DOM. On upgrade, the element adopts the existing root (`host.shadowRoot ?? attachShadow`), unlike the current `<bindle-login>`, which returns early and skips listener wiring. Nothing reads `window`, `document`, `crypto` or storage at module top level.

### 9.3 Cross-element context

`<bindle-session>` answers `context-request` events (the Web Components Community Group context protocol: `{context:'bindle-session', callback, subscribe}`). Descendants dispatch this in `connectedCallback`, and it crosses shadow roots through `composed`. dodo's `withContext` serves only dodo-rendered trees inside one element and is not used across embedder markup.

### 9.4 Versioning and distribution

- SemVer for the element API: attributes, properties, events, slots and parts. Parts and slots are public API.
- The postMessage protocol has its own integer `v`. The frame advertises `protocol:[1]`, and the parent picks the highest common version. Embed routes are path-versioned (`/embed/v1/`). The provider keeps serving v1 documents for at least 12 months after v2 ships.
- npm (ESM only, `exports` map, `sideEffects: ["./define.mjs"]`), plus content-addressed hosted ESM via the existing `/packages/sdk/…` loader model with SRI hashes published in the build manifest. Docs recommend npm or a pinned SRI URL over a floating loader. A floating provider-hosted script runs with full embedder privileges.
- TypeScript declarations and a `custom-elements.json` manifest are generated, not hand-written.
- Package name and publication scope: **open (§14)**. Examples use `cdn.example`.

### 9.5 Embedder requirements (EE-14)

- **CSP**: discovery fetches `https://<user-typed host>/.well-known/bindle/manifest.json` from the embedder page. A strict `connect-src` blocks any host not listed. Options: list the expected providers (self-hosted providers then fail with a clear `discovery-unavailable`), allow `https:`, or set `discovery-proxy="<same-origin URL>"`, a documented, cookie-free, bounded proxy the app operates that applies the server-side SSRF rules in security.md. Entry, token and RPC endpoints need the provider origin in `connect-src`. Phase 2 needs `frame-src <provider origin>`. `script-src` must allow the element bundle (npm build or pinned CDN URL with SRI).
- **COOP/COEP**: an embedder with `Cross-Origin-Embedder-Policy: require-corp` needs the panel served with `Cross-Origin-Resource-Policy: cross-origin`, or must use `credentialless` iframes. Credentialless frames use an ephemeral storage partition (needs browser verification), so in that case the panel is unavailable and falls back. An embedder `COOP: same-origin` does not break the BroadcastChannel completion.
- **Callback route**: a page at the exact `redirect-uri` that imports `callback.mjs` and calls `handleCallback()` first, served with `Referrer-Policy: no-referrer`.
- **Registration**: exact origins and callback with the provider operator. Phase 2 also needs those origins registered as frame ancestors.

### 9.6 Testing and mocking (EE-22)

`/testing.mjs` exports `createMockProvider({accounts, outcome})`. It implements discovery, entry, authorize, token and callback in-process (a fetch shim, plus a fake popup driver), so app tests and the package's own DOM tests can exercise every outcome without a network. It is never included in `define.mjs`. Its fixtures use `.example` hosts.

## 10. Localization

Locale is resolved from the element's `lang` attribute, then the nearest ancestor `lang`, then `navigator.languages`, through `packages/i18n` `resolveLocale`/`createLocalization`. SDK strings move to a dedicated SDK catalogue module, so the large portal catalogue is not bundled. Embedders may replace *non-security* copy via slots. The provider host announcement, consent-related copy and errors are not overridable.

Locale reaches provider pages as `uiLocales` (entry) and reaches the panel as a `locale` message validated against `supportedLocales`, falling back to `en`. Layout uses logical properties, and `dir` follows the locale's `direction`. Numbers and dates are formatted with `Intl`.

## 11. Light/dark and styling

`theme="auto|light|dark"` on any element, inheriting from `<bindle-session>`. `auto` follows `prefers-color-scheme`. Tokens are public CSS custom properties: `--bindle-surface`, `--bindle-surface-raised`, `--bindle-text`, `--bindle-text-muted`, `--bindle-accent`, `--bindle-on-accent`, `--bindle-border`, `--bindle-focus`, `--bindle-danger`, `--bindle-radius`, `--bindle-font`, `--bindle-font-scale`, `--bindle-density`. These are the same names as the frame tokens, so one declaration themes both. Defaults are neutral, with no 3sln palette, and come in light and dark sets that meet the §8.5 contrast rules. `::part()` gives full control of light-DOM elements, and frames remain token-only.

## 12. Accessibility

- Sign-in: a visible label ("Your Bindle identity"). The suffix is announced through `aria-describedby` ("@3sln.me will be added unless you type @"). Errors set `aria-invalid` and live in a `role="alert"` region. Status uses `role="status"`. The input has `autocomplete="username"`, `autocapitalize="none"` and `spellcheck="false"`.
- Menu: the badge is a `button` with `aria-haspopup="menu"`, `aria-expanded` and an accessible name ("Account: …"). The menu uses `role="menu"` with roving tabindex across built-in and slotted `menuitem`s. Arrow keys, Home/End and type-ahead work. Escape closes and returns focus to the trigger. Tab leaves the menu and closes it.
- Panel frame: a localized `title`. It is reachable in tab order after the menu items. Escape inside the frame posts `escape`, and the parent closes the menu and refocuses the trigger. Arrow-key focus does not cross the frame boundary, which is documented behaviour.
- Popup: when a window opens, a live region announces "A sign-in window from example.org opened", along with the fallback actions.
- Visual: 44 px targets, visible focus using the `focus` token at 3:1 or better, `prefers-reduced-motion` respected (no animated menus), `forced-colors` support, no truncation of the distinguishing handle at 200% zoom or 320 px width (wrap instead).
- Verification: keyboard and screen-reader passes (VoiceOver/Safari, NVDA/Firefox) are release evidence, not assumptions.

## 13. Dependencies on other work

| ID | Dependency | Owner area | Blocking |
| --- | --- | --- | --- |
| D1 | Provider-owned authorization entry: identity-optional, intents, `loginHint`/`subjectConstraint`/`maxAge`/`uiLocales`/`colorScheme`, generic `access_denied`, end-session `result`, `auth_time` in token response, manifest `authorization_entry_endpoint` and supported intents. Needs the spec wire text (Bindle protocol) and the runtime. | Federation and spec | All of phase 1 except plain sign-in via the legacy path |
| D2 | Multi-account vault, request-local selection, account chooser on authorize page | Multi-account agent (in progress) | `switchAccount`, the chooser |
| D3 | Token/grant revocation endpoint (RFC 7009-style) advertised in the manifest | Federation | `signOut({revoke:true})` only |
| D4 | COOP `same-origin` on all authorization pages; a static, cookie-independent entry document with no server redirect; provider control activation delay and no default focus on approve (§6.1) | Runtime HTTP and authorize UI | Popup mode |
| D5 | Embed routes: static panel document, per-client `frame-ancestors`, Fetch-Metadata-gated embed API, candidate/pairing records, CHIPS cookie, console "Sites showing your accounts", pairing checkbox in authorize UI | Federation, runtime and portal | Phase 2 only |
| D7 | Popup completion transport: auth.md says completion is a postMessage carrying only a reference; this design relays the code over a same-origin app BroadcastChannel (§6.2). Reconcile in auth.md and DEVLOG (EE-02). | Spec and coordinator | Popup mode publication |
| D8 | Logout semantics: auth.md says log out closes the current provider session; the multi-account documents and this design split app sign-out (`signOut`) from provider end-session (`endProviderSession`). Reconcile auth.md (EE-02). | Spec and coordinator | Wording of sign-out actions |
| D9 | Entry abuse bounds: entries are created unauthenticated (public clients), so they need per-IP, per-client and global rate limits, a short TTL (≤10 min) and bounded storage (EE-21) | Federation | D1 |
| D6 | auth.md/protocol.md say iframe login is unsupported in v0 and that providers must deny framing of "account management". Phase 2 needs an explicit carve-out for a label-only, non-authorizing panel, or the panel stays 3sln-proprietary and unadvertised. The coordinator must reconcile this in DEVLOG. | Spec and coordinator | Phase 2 publication |

## 14. Open questions for the user

1. Should embedders be able to override the default `@3sln.me` suffix (`default-host`), for example for self-hosted providers, or is it always `3sln.me`?
2. Is the phase-2 account panel wanted, given that it requires a new partitioned embed credential and a spec carve-out? Phase 1 delivers sign-in, badge, switch, reauth and sign-out without iframes.
3. Package name and scope for npm and CDN publication.
4. Default `presentation`: `redirect` (spec-default, most robust) or `popup` (better SPA experience)?
5. Is per-reload one-click re-sign-in acceptable, or should a backend-session companion be scoped next?

## 15. Implementation breakdown (non-overlapping ownership)

| Slice | Owns (write) | Depends on |
| --- | --- | --- |
| S1 SDK flows | `packages/sdk/src/flows.mjs`, `packages/sdk/src/callback.mjs`, `packages/sdk/src/testing.mjs`, changes in `packages/sdk/src/identity.mjs` (generation split and keyed pending storage per §5.3, entry intents, `completeEndSession`, `reauthenticate` checks), `packages/sdk/test/flows.test.mjs` | D1 (mock-first against the agreed schema) |
| S2 Elements | `packages/sdk/src/elements/*` (session, sign-in, account, monogram, access-summary, theme-probe), `packages/sdk/src/define.mjs`, `packages/sdk/src/login-element.mjs` (alias shim), `packages/sdk/test/elements.test.mjs`, `tests/browser/embed-elements.mjs` | S1 interface |
| S3 SDK i18n | `packages/i18n/sdk-catalogue.mjs` (new). Does not edit `catalogues.mjs`. | none |
| S4 Server entry | federation entry/intents (files assigned once the multi-account agent releases `packages/runtime` and `packages/identity`), `docs/spec/federation-implementation.md` section | D2 checkpoint |
| S5 Embed protocol (phase 2) | `packages/sdk/src/embed-protocol.mjs` (shared schema and token validator, consumed read-only by S2), `apps/embed/*` (panel document), `packages/federation/embed.mjs`, `tests/embed-protocol.test.mjs`, `tests/browser/embed-panel.mjs` | D5, D6, user answer to Q2 |
| S6 Docs | `docs/integration.md` elements section, packaging README | S1 and S2 |

Required evidence before calling any slice complete: `npm test`; DOM tests that observe no session-dependent events or attributes; real-browser tests in Chromium, Firefox and WebKit with third-party cookies blocked, popups blocked, nested hostile parents, sandboxed, `credentialless` and `csp=` iframes, and spoofed or replayed messages from other windows and ports. Phase 2 additionally needs embedder-side probes (`contentWindow.length`, load count, blur timing, size) that show identical observations for unpaired, paired-empty and paired-with-five-accounts states.

## 16. Review reconciliation

The independent review ([embeddable-elements-review](../release/embeddable-elements-review.md)) raised EE-01 to EE-22. The design was revised as follows. Accepting the changes is the author's call. No human sign-off is implied.

| Finding | Resolution in this document |
| --- | --- |
| EE-01 cookie prefix | `__Secure-` cookies scoped to `Path=/embed/api/`, with a test that non-embed routes ignore them (§7.3) |
| EE-02 spec conflicts | D7 (popup transport) and D8 (logout semantics) added for coordinator reconciliation. `auth_time` only for `reauthenticate` (§3.1, §4) |
| EE-03 popup verifier | No complete-in-popup fallback. A single mode-detecting `handleCallback()` (§6.2) |
| EE-04 popup clickjacking | No window position features. Provider activation delay and no default focus on approve (§6.1, D4) |
| EE-05 scroll chaining | `overscroll-behavior: contain`, constant scroll height, wheel probe in evidence (§7.5) |
| EE-06 site binding | Binding rephrased as browser-partition-only. Candidate–entry server checks specified (§7.2–7.3) |
| EE-07 handshake order | Single init on `load` carrying theme and locale, a single port, nonce documented as defence in depth (§8.3) |
| EE-08 client generations | Required SDK changes (§5.3, S1) |
| EE-09 color handling | Canvas normalization, added contrast pairs, CSP fallback (§8.5) |
| EE-10 entry timing | Static entry document with no redirects (§6.1, D4) |
| EE-11 close/focus | Best effort, persistent "Return to app" message (§6.2–6.3) |
| EE-12 caching | `no-cache` plus ETag on the panel document, `no-store` on the API (§7.4) |
| EE-13 DX surface | Public `client`, initial state event, `ready`, promise-returning flows (§3.1) |
| EE-14 embedder setup | §9.5 |
| EE-15–19, EE-21, EE-22 | Parse before opening, no-referrer callback that runs first, fresh entry for "Continue in this tab", `controller` attribute, `flow-end` codes, D9 rate limits, `testing.mjs` |
| EE-20 fake panel | The in-frame note is not a verification cue (§7.3) |

Still open after review: WebKit/iOS CHIPS support, scroll-chaining and computed-color behaviour, and whether constructed stylesheets work under the panel CSP. All of these need browser evidence. Phase 2 stays gated on D5, D6 and that evidence.

