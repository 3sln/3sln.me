# COOP / opener spike for adaptive app sign-in (revision 2)

Status: empirical, throwaway harness. Not a design decision and not signed off. Reviewer/date/outcome: unsigned (provisional evidence only).

Context: `docs/architecture/adaptive-app-sign-in.md` (revision 2) relies on a provider iframe (cross-site from the top-level app) opening a popup to a provider page that keeps `window.opener` and posts back to the iframe with an exact `targetOrigin`.

## How to rerun

```
node tests/spikes/coop-opener/run.mjs            # all engines, prints JSON
node tests/spikes/coop-opener/run.mjs chromium   # or: firefox, webkit
SPIKE_DEBUG=1 node tests/spikes/coop-opener/run.mjs chromium
```

The harness is `tests/spikes/coop-opener/run.mjs` (Playwright 1.64.0 from the repo's dev dependencies; browsers via `npx playwright install firefox webkit`). It is deliberately not an npm script and touches no app code.

How it gets cross-site behaviour: three fake https origins (`https://app.example`, `https://provider.example`, `https://other.example`) are served by Playwright `context.route` interception, so each is its own site. COOP headers are set on the fulfilled responses. All checks use real Playwright clicks (real user activation) inside the iframe. Popups post two messages to `window.opener`: `exact` with `targetOrigin = https://provider.example`, and `wild` with `'*'` as a control that proves which window the opener is.

## Environment and versions

| Engine | Version | Result of this run |
|---|---|---|
| Chromium | 156.0.8078.4 (Playwright 1.64.0 build) | Ran all tests |
| Firefox | 157.0 (Playwright build) | Ran all tests |
| WebKit | 27.2 (Playwright webkit v2251) | **Not tested.** `webkit.launch()` returns but `newPage()` never returns on this machine (macOS 14.6, arm64), sandboxed shell. One further diagnosis attempt was denied by the permission system and was not pursued. Every WebKit claim in the design remains unverified. The harness reports this as an engine error rather than hanging. |

Limitations (recorded honestly):

- Mobile: Playwright desktop engines cannot prove iOS Safari or Android Chrome behaviour. iOS has no real popup windows (they become tabs), Android Chrome process isolation is heuristic, and neither engine's mobile opener, COOP, process-sharing or back-forward-cache behaviour was exercised. Device-emulation modes only change viewport and user agent, not these browser internals. Treat all mobile rows in the design's browser matrix as needing real devices.
- Origins are route-intercepted fakes served from memory, so network-level behaviour (cookies, real TLS, HTTP caching, `Origin-Agent-Cluster`, process-per-site isolation counts) is not covered.
- Playwright's Chromium launches with `--disable-features=...ThirdPartyStoragePartitioning`, and Playwright's Firefox does not partition by default. Test 6 was therefore run in an extra configuration for each (Chromium `--enable-features=ThirdPartyStoragePartitioning`; Firefox `network.cookie.cookieBehavior=5`, which I believe matches Firefox's shipping default but did not verify separately). The unpartitioned default runs are listed too, to show the harness can detect leakage.
- Headless, one run per cell, 3 s message wait (0.5 s for negative checks). A cell reading "no" means not observed in that window.

## Results

Notation: `app COOP / popup COOP`; `none` = no header, `so` = `same-origin`, `soap` = `same-origin-allow-popups`. Chromium and Firefox results were identical in every cell of tests 1-4, so one table covers both unless noted. WebKit: not tested (no column of results exists).

### Tests 1 and 2: iframe-opened popup (iframe on provider origin, app top-level on app origin)

`window.open` return is the value the frame sees. "Opener" is `window.opener !== null` in the popup. "Exact to frame" is whether `opener.postMessage(msg, providerOrigin)` reached the iframe.

| App COOP | Popup COOP | window.open in frame | Popup opener kept | Exact msg reaches frame | Wildcard msg reaches frame | App got any message |
|---|---|---|---|---|---|---|
| none | none | handle | **yes** | **yes** | yes | no |
| none | so | handle | no | no | no | no |
| none | soap | handle | no | no | no | no |
| so | none | **null** (popup still opened) | no | no | no | no |
| so | so | null (popup still opened) | no | no | no | no |
| so | soap | null (popup still opened) | no | no | no | no |
| soap | none | handle | **yes** | **yes** | yes | no |
| soap | so | handle | no | no | no | no |
| soap | soap | handle | no | no | no | no |

Same for Chromium 156.0.8078.4 and Firefox 157.0.

Control (app opens the same popup itself, popup `none`): opener is the app window; the exact message addressed to the provider origin is **dropped** (app received nothing), while the wildcard control message is delivered to the app. This held for app COOP none and soap in both engines. With popup COOP `so` the opener is null in all combinations. With app COOP `so` an app-opened popup has no opener either way (popup `none` or `so`).

### Test 3: popup loads without COOP, then `location.replace` to a `COOP: same-origin` page

| App COOP | Stage 1 (no COOP) opener | Stage 1 exact msg to frame | After replace: opener | After replace: msg (exact or wildcard) to frame |
|---|---|---|---|---|
| none | yes | yes | **no** | no |
| soap | yes | yes | **no** | no |

Both engines. The opener is severed as the design expects (the plain-mode redirect in section 7.3 step 6 is therefore a reliable way to drop the opener).

### Test 4: can the app obtain a reference to the frame-opened popup?

| Case | Result (both engines) |
|---|---|
| Unnamed popup (`_blank`), app calls `window.open('', n)` for `''`, `popup`, `provider`, `_blank`, `zz` | Every call creates a new blank window; none returns the existing popup. `window.length` is 1 (only the iframe), `window.frames[1]` is `undefined`. |
| Frame passes a **name** (`pn`) | The app's `window.open('', 'pn')` **returns the existing popup's cross-origin WindowProxy** (reading `location.href` throws SecurityError, proving it is a live cross-origin proxy). The app could then `postMessage`, assign `location`, or `close()` it. |

So the design's "unnamed" requirement (AS-4) is load-bearing: a named popup is reachable by the app.

### Test 5: sandboxed iframe (app COOP none, popup COOP none)

| iframe `sandbox` | Frame origin | `window.open` | Popup origin | document.domain probe: frame / popup | Popup opener | Exact msg to frame | Wildcard msg to frame |
|---|---|---|---|---|---|---|---|
| `allow-scripts allow-same-origin` | provider | **returns null** (Firefox **throws** `InvalidAccessError`), no popup opened | n/a | SecurityError / n/a | n/a | no | no |
| `allow-scripts allow-same-origin allow-popups` | provider | handle | **provider (not `null`)** | SecurityError / **SecurityError** | yes | yes | yes |
| `allow-scripts allow-popups` (opaque origin) | `null` | handle | `null` | SecurityError / SecurityError | yes | **no** (frame origin is `null`, exact target never matches) | yes |
| `allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox` | provider | handle | provider | SecurityError / **ok** | yes | yes | yes |

Same for Chromium and Firefox. The unsandboxed popup (last row) is the only document where the probe passes (`ok`). Popups inherit the sandbox flags, including `allow-same-origin`, so `origin !== 'null'` does not reveal a sandbox when `allow-same-origin` is present; the `document.domain` probe does.

### Test 6: BroadcastChannel and localStorage partitioning

Setup: two first-party provider tabs (T1, T2), the provider iframe in `app.example` (F1), the provider iframe in `other.example` (F2). T1 and F1 each post once on channel `ch`. Cells list who received what. localStorage column lists the value each page saw for key `k` (written by the previous page) on load.

| Configuration | Received by T1 | by T2 | by F1 | by F2 | localStorage seen on load (T1/T2/F1/F2) |
|---|---|---|---|---|---|
| Chromium 156, **partitioning enabled** | none | T1 | none | none | null / T1 / null / null |
| Firefox 157, cookieBehavior=5 | none | T1 | none | none | null / T1 / null / null |
| Chromium 156, Playwright default (partitioning disabled by Playwright) | F1 | T1, F1 | T1 | T1, F1 | null / T1 / T2 / F1 (shared) |
| Firefox 157, Playwright default | F1 | T1, F1 | T1 | T1, F1 | null / T1 / T2 / F1 (shared) |

Partitioned: first-party tabs share state, the app-embedded frame and the other-site-embedded frame each see nothing from first-party tabs or from each other. The unpartitioned rows are an artifact of Playwright launch flags/prefs and only show the test would detect leakage. WebKit not tested.

## Implications for the design

Supported by evidence (Chromium 156 and Firefox 157 only):

1. AS-5/section 9: an `unsafe-none` popup keeps its opener when the app has no COOP or `same-origin-allow-popups`; exact-target delivery to the frame works. A popup document with **any** COOP (`so` or `soap`) loses the opener, even under an app with no COOP. The embed popup document, and any document it first navigates to, must send no COOP header (not `same-origin-allow-popups` either).
2. Section 7.2/9 claim that an app with `COOP: same-origin` yields `null` from `window.open` and no usable opener: confirmed. In that case the popup still opens as a window, so the plain-mode fallback is needed and works as designed. The recommendation of `same-origin-allow-popups` for apps is correct: it keeps the opener for an `unsafe-none` popup.
3. Section 8 attestation: an app-opened popup has the app as opener, and the exact-origin message is dropped (verified by the wildcard control). Plain mode for app-opened flows holds.
4. Section 7.3 step 6 (`location.replace` to a `COOP: same-origin` page to sever): severs in both engines.
5. Section 4.1 partitioning claims for BroadcastChannel and localStorage hold in Chromium and Firefox when partitioning is on (the Playwright defaults hide this, see limitations).
6. Section 7.5 / AS-4: unnamed `_blank` popups are not reachable by the app.

Contradicted or sharpened (do not edit the design doc from here; these are for the reviewer):

- **Named popups are reachable.** The design says the frame opens the popup "unnamed", but any future code path that passes a `name` lets the app obtain the popup's WindowProxy via `window.open('', name)` and navigate or close it. Add an explicit "never name the popup" invariant or test.
- **`window.open` failure signalling differs by engine.** Firefox **throws** `InvalidAccessError` in a sandboxed iframe without `allow-popups` (Chromium returns `null`). Section 7.2 and section 10 say a `null` return is handled; the frame must also `try/catch`. Separately, when the app has `COOP: same-origin`, both engines return `null` while still opening a window, so "null" does not mean "no window exists"; the frame cannot close that window.
- **Sandbox detection (section 10).** The `document.domain = document.domain` probe is confirmed as the discriminator (`SecurityError` in every sandboxed document, `ok` in the unsandboxed popup). The `origin === 'null'` check is only useful for sandboxes without `allow-same-origin`. A frame sandboxed with `allow-scripts allow-same-origin allow-popups` is a working configuration for the whole handshake (opener kept, exact messages delivered); the design's "degraded mode" for any sandbox is a policy choice, not a technical necessity. Behaviour with an `Origin-Agent-Cluster` header (design claims the probe still throws) was **not tested**.
- **Opaque-origin frame (`allow-scripts allow-popups`, no `allow-same-origin`).** The popup keeps its opener, but exact-target messages to the provider origin never match the frame's `null` origin (dropped). The design's protocol therefore fails closed there, as intended, but the popup still believes it has an opener until the 3 s timeout.
- **WebKit and mobile are unverified.** The design's matrix marks Safari/iOS "needs evidence" and that remains true: this spike produced no WebKit evidence and cannot speak for iOS Safari or Android Chrome. Needed: a macOS Safari run, an iOS Safari run (popup becomes a tab; opener retention, COOP behaviour, BroadcastChannel partitioning) and an Android Chrome run (process isolation of the non-COOP popup).
