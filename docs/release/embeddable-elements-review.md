# Embeddable Bindle elements: independent review

Date: 2026-10-14. Target: [embeddable-elements](../architecture/embeddable-elements.md) (provisional design). This is a design review through a browser-security and developer-experience lens. Nothing is implemented, so nothing here is implementation evidence. I cross-read auth.md, security.md, the multi-account session/UI/review documents, `packages/sdk/src/identity.mjs`, `login-element.mjs` and `vendor/dodo`. Where a claim depends on browser behaviour I am unsure of, it is marked **needs browser verification**.

| Reviewer | Date | Outcome |
| --- | --- | --- |
| | | |

## What is sound

- Phase 1 has no iframe, and the design says plainly that Shadow DOM is not a security boundary. It rejects silent checks and provider logout through GET, iframe or postMessage, and it never themes consent surfaces.
- The embed credential is display-only and snapshot-scoped to immutable `(owner, session)` pairs, matching the multi-account capability-scope correction.
- The panel document is static, and the embed API is gated by Fetch Metadata and a custom header, with no CORS. This correctly anticipates partitioned cookies riding on the embedder's own requests. The §7.5 side-channel table and the unpaired/paired-empty/paired-five probe evidence are the right shape.
- Theme values reach CSS only as canonical text, trust copy uses a fixed palette, and `forced-colors` mode ignores tokens. The reasoning for rejecting `noopener` is correct.

## Findings

### Blockers

**EE-01 (blocker): the cookie attributes are invalid.** `__Host-bindle_embed` is declared with `Path=/embed/`. The `__Host-` prefix requires `Path=/`, so browsers will reject the cookie. If it is "fixed" by switching to `Path=/`, the partitioned cookie rides on every embedder-initiated credentialed request to any provider route. `http.mjs` already has routes that branch on the mere presence of a `Cookie` header (around line 96). **Fix:** use `__Secure-bindle_embed; Path=/embed/api/` for both the embed cookie and the candidate cookie, and test that cookie-presence checks on other routes ignore it. Alternatively keep `__Host-` with `Path=/` and make every non-embed route ignore embed cookie names, with tests.

**EE-02 (blocker, consistency): the design conflicts with auth.md beyond D6.**
- auth.md says popup completion "sends only a completion reference through `postMessage` with exact origin and source checks". The design instead broadcasts the full callback URL, code included, on a `BroadcastChannel`.
- auth.md says "Log out closes the current provider session and client memory state". `signOut()` deliberately never touches provider sessions.
- D1 lists `auth_time` in the token response generally, but §4 says the app must not learn "whether the user had to sign in first". A login `auth_time` reveals exactly that.

**Fix:** add D7 (popup completion transport) and D8 (logout semantics) to the dependency table, and have the coordinator reconcile them in DEVLOG before phase 1. Restrict `auth_time` to tokens issued for the `reauthenticate` intent (or coarsen it otherwise), and say so in D1.

### High

**EE-03 (high): the popup fallback cannot work, and the callback page is ambiguous.**
- The pending transaction sits in the opener tab's `sessionStorage`.
- The popup is created synchronously in the click, before `beginLogin` writes that transaction. Any sessionStorage copy the popup received at creation is therefore stale, and the COOP browsing-context-group swap may discard it anyway (**needs browser verification**).
- So the §6.2 fallback ("complete in the popup tab itself") has no verifier. Even if it had one, the tokens would land in popup memory, not in the app tab.
- The same `redirect-uri` also serves redirect mode, and after COOP the callback page cannot tell from `window.opener` which mode it is in.

**Fix:**
- Remove the in-popup completion fallback. Without BroadcastChannel, show "Return to the app and choose Continue in this tab".
- Ship one `handleCallback()` that decides the mode deterministically: if a pending transaction exists in this tab, it is redirect mode; otherwise relay.
- Optionally encode the mode in the pending record, not in the URL.

**EE-04 (high): double-click-jacking of popup consent.** In phase 1 the embedder opens the popup and controls `left/top/width/height`, so it can place the provider's "Continue as …" / approve button under the cursor and harvest the second click of a double-click. In phase 2 the panel opens the popup, but the embedder still controls where the panel sits. "No auto-approve" does not stop this.

**Fix:**
- On every provider consent, account-choice and end-session page, make the primary actions inert until the page has been visible and focused for about 600 ms and a fresh `pointerdown` starts on the button. The exact value is a product number.
- Do not default-focus approve.
- Have the SDK pass no position features.
- Add a browser test.

**EE-05 (high): wheel scroll chaining can reveal row count (needs browser verification).** If the panel's content is not scrollable (few rows, or unpaired), wheel and touch scrolling over the frame chain to the embedder page, which can observe its own `scroll` events. If the content is scrollable, the frame consumes the scroll. That is a session-dependent signal the §7.5 table does not cover.

**Fix:**
- Set `overscroll-behavior: contain` on the frame's root and its list scroller.
- Make the scrollability state constant, for example by always reserving a scrollable list area or never scrolling the root.
- Add a wheel-chaining probe to the §15 evidence list.

**EE-06 (high): pairing binding is asserted, not enforceable.** §7.2 says the credential is bound to `(client_id, top-level site, pairing id)`, but the server never learns the top-level site: the CHIPS partition key is not sent to it. The binding is only implicit, through browser partitioning plus `frame-ancestors`. The design also does not state the checks needed when the panel attaches a candidate to an `entryId` received from the parent. Entry creation is unauthenticated, so a malicious registered client can create entries for another client's `client_id` and pass them in. And a client with registered origins on several sites makes the checkbox copy ("on app.example") inaccurate.

**Fix:**
- State the server checks: `entry.clientId === panel client_id`; the entry is unopened, unexpired and not already attached; attach is single-use.
- Rephrase the binding as "browser-partitioned per top-level site, server-bound to client and pairing".
- Name the exact registered origin in the checkbox, or refuse pairing for multi-site clients until that copy is designed.

### Medium

**EE-07 (medium): handshake ordering and retries are underspecified.**
- §7.5 says `ready` is sent "after theme application", but `theme` only arrives over the port *after* `ready`.
- Retries before load post into the initial `about:blank` document, so they are dropped by `targetOrigin`.
- Each retry sends a fresh port, so the parent must listen on all of them and close the losers. "The parent treats the port as authenticated" does not say which port.
- The nonce is readable by any script in the parent document, including third-party scripts. It adds protection only against principals that `event.source === window.parent` already excludes. That is acceptable, but state it.

**Fix:**
- Send init once on the iframe's first `load` event; retry only if no `ready` arrives.
- Accept `ready` only on the most recently sent port and close all the others.
- Allow an optional `theme` and `locale` inside init, and send `ready` after applying them.
- Document that the nonce is defence in depth, not parent-script isolation.

**EE-08 (medium): `BindleClient` internals break `switchAccount`.**
- `beginLogin()` calls `cancelLogin()`, which increments `generation`. That cancels in-flight RPCs ("Resource access was canceled"), and if a refresh is running it sets `session=null`.
- `completeLogin()` does the same.
- So "keep the old session until the new one completes" is false against today's code.
- The single storage key `bindle.pending-login` also collides when one page has two `<bindle-session>` elements.

**Fix:** in S1, separate the login-transaction generation from the session generation, never null the session on login start, and key pending storage by `clientId` + `redirectUri`.

**EE-09 (medium): theme probing is fragile.**
- Computed `color` for `color-mix()`, `oklch()` or wide-gamut values may serialize as `color(srgb …)`, `oklab()` and similar, not `rgb()` (**needs browser verification**).
- Non-color tokens (`radius`, `font`, `density`) cannot be read through a color probe.
- The contrast set omits `danger`/`surface` (the destructive "Stop showing" text), `accent`/`surface` (button boundary at 3:1) and `focus`/`surface-raised`.
- Whether `replaceSync` is governed by `style-src 'self'` **needs browser verification**.

**Fix:**
- Normalize colors through a 2D canvas `fillStyle` round trip, or a specified OKLab→sRGB clamp.
- Read non-color tokens from `getPropertyValue` against the enumerations.
- Add the missing contrast pairs.
- Test under the panel CSP in all three engines.

**EE-10 (medium): the COOP `closed` flip exposes the first provider response's timing.** The opener sees `popup.closed` become true when the first COOP page commits. If any hop before that, such as a redirect from `authorization_endpoint?entry=` to a login or chooser route, depends on cookies or session state, its latency is a presence signal. Strict cookies are not sent on that cross-site-initiated navigation, but nothing in the design requires the first response to be session-independent.

**Fix:** require the entry URL to return one static, cookie-independent COOP document with no server redirects. All session-dependent work happens via same-origin fetches after commit. Add a D4 test that compares commit timing for a signed-out browser and one with several accounts.

**EE-11 (medium): `window.close()` and `focus()` after COOP swaps.** The callback page's `window.close()` relies on the window still being script-closable after `about:blank` → provider → app navigations across browsing-context groups, and iOS Safari opens popups as tabs. **Needs browser verification** in Chromium, Firefox, WebKit and iOS. **Fix:** treat close as best effort, always render a persistent "Return to app" message, and document iOS behaviour as tab-based.

**EE-12 (medium): the cached panel document carries authorization data.** The registered-origin list and the `frame-ancestors` header are per client, but the document is "cacheable with a content hash". A revoked origin could keep a cached CSP or allowlist. **Fix:** `Cache-Control: no-cache` with an ETag on `/embed/v1/accounts` (immutable caching only for the script and style subresources), `no-store` on embed API responses, and a revocation test.

**EE-13 (medium, DX): embedders cannot actually use the session.** `session` exposes `{issuer, subject, grantedFragments}`, but the design never shows how to call `rpc`, `readPreferences` or `userMessage`. There is also no initial-state contract: listeners attached after upgrade miss `bindle-session-change`.

**Fix:**
- Expose `sessionEl.client` (the `BindleClient`) as documented public API.
- Fire `bindle-session-change` once on connect, and add a `ready` promise.
- Make flow methods return `Promise<{outcome}>` so callers do not have to correlate events.

**EE-14 (medium, DX): embedder CSP and COEP prerequisites are missing.**
- Discovery fetches arbitrary user-typed hosts, so a strict `connect-src` breaks sign-in for any non-allowlisted provider.
- Phase 2 needs `frame-src`.
- COEP `require-corp` pages need the panel to send matching COEP/CORP headers.

**Fix:** add an "Embedder requirements" section listing the CSP directives, the COEP stance and the trade-off of `connect-src https:`, and optionally a same-origin discovery proxy helper.

### Low

**EE-15 (low): pre-open ordering.** `<bindle-sign-in>` opens the popup before `parseIdentity` validates the input, which flashes a window on typos. **Fix:** parse synchronously first, and open the popup only for valid input.

**EE-16 (low): the code is exposed on the callback page.** Third-party scripts or subresources on the callback page can see the code, or receive it through the Referer header, before `replaceState`. PKCE mitigates this. **Fix:** document `Referrer-Policy: no-referrer` and require the relay script to run first, on a minimal callback page.

**EE-17 (low): inconsistent "Continue in this tab" semantics.** One §6.3 row says "same entry", another says "fresh redirect entry". **Fix:** always use a fresh entry and transaction.

**EE-18 (low): `session` means two different things.** `session="id"` on child elements means a controller id, while `<bindle-session>.session` holds the session data. **Fix:** rename the attribute to `controller` (or `for`).

**EE-19 (low): error reporting is duplicated.** `bindle-error` and `bindle-flow-end{outcome:'discovery-error'}` overlap. **Fix:** report flow failures only through `flow-end` with a stable `code` enumeration, and keep `bindle-error` for configuration errors.

**EE-20 (low): the panel's trust note can be spoofed.** The embedder can render a fake "accounts" list, including the "app.example can't see this list" note. **Fix:** do not present the note as a verification cue; keep the copy factual and keep consent top-level only.

**EE-21 (low): entry creation can be abused.** Unauthenticated, cookieless entry creation for any `client_id` is a storage and DoS vector. **Fix:** per-IP/client rate limits, a short TTL and a bounded entry count in D1.

**EE-22 (low, DX): testing support is missing.** The design has no mocking story. **Fix:** ship a `createMockProvider()` / fake `BindleClient` and document `client` injection for unit tests. Existing `fetcher`/`storage` injection makes this cheap.

## Sandbox and embedder manipulation

The embedder can remove or loosen `sandbox` (which only empowers the provider frame), add the `credentialless` or `csp` attributes (Chromium), or remove `allow-scripts`. Each of these yields either an unpaired-looking panel or the timeout fallback. None produces a state-dependent signal, provided `ready` is always sent before any credentialed request. Add `credentialless` and `csp=` to the §15 hostile-parent tests. Whether CHIPS cookies are set in WebKit/iOS under its default third-party cookie policy **needs browser verification**. If they are not, phase 2 is effectively Chromium and Firefox only, and §7 should say so.

## Recommendation

Phase 1 can proceed mock-first once EE-01 to EE-04 and EE-08 are addressed in the design and EE-02 is reconciled in DEVLOG. Phase 2 stays gated on D5, D6, EE-05, EE-06, EE-07 and the cross-engine probe evidence. No sign-off is claimed here.

## Author response (2026-10-14)

The design author revised `docs/architecture/embeddable-elements.md` to address every finding. The finding-by-finding resolution is recorded in its §16. EE-02 is only partly addressed: `auth_time` is now restricted to the reauthentication intent, and the popup-transport and logout-semantics conflicts with auth.md are recorded as dependencies D7 and D8. Those two still await coordinator reconciliation in DEVLOG.md. Browser-behaviour items marked "needs browser verification" remain unverified. This response is not a reviewer sign-off.

## Implementation review (phase 1, 2026-10-14)

Scope: slices S1 (flows, callback, testing, `identity.mjs` changes), S2 (elements, `define.mjs`, the `<bindle-login>` alias), S3 (`packages/i18n/sdk-catalogue.mjs`), S6 (`docs/integration.md`), and the D7/D8 interop text in `docs/spec/auth.md`. An independent reviewer subagent read the diff only (browser security and DX), and the implementer fixed the findings. The reviewer reported no blockers. No human sign-off is implied.

| Reviewer | Date | Outcome |
| --- | --- | --- |
| | | |

Verification status: the provider-owned authorization entry (D1/S4), end-session, revocation (D3) and popup COOP pages (D4) do not exist server-side. Every entry-based flow is verified only against `packages/sdk/src/testing.mjs`, in happy-dom unit tests and in Chromium (`tests/browser/embed-elements.mjs`). Firefox and WebKit were skipped because the pinned Playwright revisions are not installed here. No screen-reader pass has been done.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 (medium) | An end-session `error` callback, or a dismissed end-session window, left the app signed in. | `completeEndSession` treats `error` as `canceled` and signs out even when callback validation fails. `#end` clears app tokens on every terminal end-session outcome. |
| 2 (medium) | The relay was fire-and-forget, so a lost message still showed "close this window". | Added a v1 ack (`bindle-callback-ack`). Without one, the callback page says the sign-in expired or was replaced. Resuming a popup sign-in after the app tab reloads is not supported (documented). |
| 3 (medium) | Any `?state=` link on the callback URL could blank the page; expired redirect returns were relayed. | `handleCallback` acts only when `state`, `iss` and exactly one of `code`/`error`/`result` are present. An expired or other transaction in this tab yields an "expired or replaced" message, and the address bar is scrubbed on every consuming path. Docs require a dedicated `redirect-uri`. |
| 4 (medium, unconfirmed) | `revokePrevious` could revoke a same-account grant. | Revocation now happens only when the subject or issuer differs. |
| 5 (low) | A failed completion left the verifier pending. | Every terminal outcome except `redirecting` and `popup-blocked` calls `cancelLogin()`. |
| 6 (low) | Canceling during the token exchange dropped live tokens. | Tokens issued after cancellation are revoked (best effort). |
| 7 (low) | An already-closed window returned by `open()` was not treated as blocked. | It is now treated as blocked. Stale transactions are also cleared before `open()`, so a popup's copied `sessionStorage` holds none. |
| 8 (low) | Bidi controls in profile names could reorder the account label. | Values containing bidi controls are dropped, and labels render in `<bdi dir="auto">`. |
| 9 (low) | Activation failures and fallback events were inconsistent. | `not-configured` added to `flowCodes`, `fallback:true` added on automatic redirects, and the `NotAllowedError` rejection documented. |
| 10 (low, a11y) | Flows started from the account menu were not announced; focus was lost; `role=menu` held non-items. | The account element has a `role=status` region, focus moves to the badge when sign-in completes from the slotted form, and the header and note sit outside `role=menu`. |
| 11 (low) | Popup mode inside a third-party iframe hangs, because storage is partitioned. | Documented as unsupported; use `presentation="redirect"`. |
| 12 (low, docs) | Undocumented deviations. | The callback page takes `storageKey`. The prefix registry tracks every session tag. The pending key changed to `bindle.pending-login:[clientId,redirectUri]`, which weakens `tests/e2e/federation.test.mjs:10` (it now reads a key that is always empty); that file has a different owner and is flagged for them. |

Design deviations directed by the coordinator (provisional):
- `presentation` defaults to `popup`, and a blocked popup automatically falls back to redirect. `popup-fallback="prompt"` keeps the design's explicit offer.
- `default-host` is overridable.
- The package name `@3sln/bindle` appears only in `packages/sdk/package.json`, which is private.
- The `define.mjs` bundle is about 24 KiB min+brotli, over the 18 KiB budget. Most of the overage is the existing `BindleClient`.
- `<bindle-access-summary>` is not implemented.
