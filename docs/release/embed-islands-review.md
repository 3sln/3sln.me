# Embed islands: independent review

Date: 2026-10-14. Target: [embed-islands](../architecture/embed-islands.md), revision 1 (provisional design). This is a design review through a browser-security and frontend/accessibility lens. Nothing is implemented, so nothing here is implementation evidence. I cross-read adaptive-app-sign-in revision 2, embeddable-elements and its review, the phase-1 elements in `packages/sdk/src/elements/*.mjs`, `vendor/dodo/src/{vdom,style}.js`, and the DEVLOG entries "Embed islands direction" and the user correction on event composition. Claims about browser behaviour I could not verify are marked **needs browser verification**.

| Reviewer | Date | Outcome |
| --- | --- | --- |
| | | |

## What is sound

- **The user direction is followed.** Islands use one shell with fragment parts, a nonce-bound `MessageChannel` and no inbound commands. The leader is chosen with Web Locks and fans out over `BroadcastChannel`, with no `SharedWorker`. Sizes are fixed or set by the embedder, and the dropdown container is the element's `<dialog>` with the switcher island inside it. §10 matches the user correction: events are composed per element, with no global single-event guarantee and no `<bindle-session>` fan-out of island messages. The coordinator's "account change only after the credential is ready, with a distinct failure event" constraint is kept. I found no contradiction with binding user direction.
- **The message surface is minimal.** Outbound messages are listed per part, `#avatar` emits only `ready`, nothing returns an error reply, and the element tears the island down after schema violations. Arrow-key wrapping that never reports an edge is the right call.
- **Avatar delivery is well gated.** It needs a bearer token, uses fetch only, sends CORP `same-origin` with no CORS and `no-store`, re-encodes to raster, and swaps a blob URL in after `decode()`. The §7 snapshot-privacy statement is accurate and does not overclaim: screen capture is called user-permissioned, and no opt-out is promised.
- **Trusted Types `'none'` is compatible with dodo.** `vendor/dodo/src/vdom.js` writes the DOM only through `setAttribute`, `style.setProperty`, `classList`, `dataset` and property assignment, with a `__proto__`/`constructor` denylist. It has no `innerHTML`, `insertAdjacentHTML`, `eval` or `Function`. `style.js` uses constructed sheets (`replaceSync` plus `adoptedStyleSheets`), and CSP `style-src` does not govern those. Because of TT, a mistaken `.props({innerHTML})` would throw instead of injecting.
- **Popover and sheet plumbing are careful.** The `<dialog>` is never re-parented, the close matrix is explicit, scroll and resize reposition rather than close, the backdrop listener is scoped, and the element never sets `virtualKeyboard.overlaysContent`.
- **Honesty.** §18 is an honest list of browser evidence still needed.

## Findings

### EIR-1 (High): the embed API gate rejects every legitimate GET

§6.2 and adaptive §13.4 require an "exact embed `Origin`" on `/embed/api/*`. Under Fetch, a **same-origin GET** has response tainting `basic` and carries **no `Origin` header**: `Origin` is added only for CORS-tainted requests or for methods other than GET and HEAD. A custom header such as `X-Bindle-Embed` or `Authorization` does not change this for same-origin requests.

**Failure:** `GET /embed/api/avatar` and `GET /embed/api/events` (the leader's stream) get the constant 403 in every engine. Islands render the monogram forever, and the bug looks like "no binding", so it can ship unnoticed.

**Fix (§6.2, adaptive §13.4):**
- Gate on `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode`, `Sec-Fetch-Dest` and `X-Bindle-Embed`.
- Require `Origin == embed origin` only when the header is present or the method is not GET/HEAD.
- Add an I4 test that sends a real same-origin GET without `Origin` and expects 200.

### EIR-2 (High): the shell CSP breaks the service worker and, likely, FedCM in the frame

Three conflicts in §3.1 and §3.3:

1. **Service worker vs Trusted Types.** `ServiceWorkerContainer.register()` is a Trusted Types `TrustedScriptURL` sink. So are `new Worker()` and `script.src`, which matters if EIR-3's fix is adopted. With `require-trusted-types-for 'script'; trusted-types 'none'`, no policy can exist, so `navigator.serviceWorker.register('/embed/sw.js')` throws a `TypeError`.
   - Fix: replace `trusted-types 'none'` with `trusted-types bindle-embed`. Add one policy whose `createScriptURL` returns only exact allowlisted same-origin paths (`/embed/sw.js` and any worker asset) and throws otherwise. Keep `createHTML` and `createScript` undefined, so HTML and script sinks still throw.
2. **Service worker scope.** A script at `/embed/sw.js` has a maximum scope of `/embed/`. Registering scope `/embed` fails with `SecurityError` unless `sw.js` is served with `Service-Worker-Allowed: /embed`. Even with scope `/embed/`, the shell at `/embed?client=` would be outside it, so "serve the shell network-first" could not work.
   - Fix: send `Service-Worker-Allowed: /embed` on `sw.js`, or move the shell to `/embed/`. In the fetch handler, return without `respondWith` for `/embed/api/*`, so DPoP `htu` and streaming are untouched.
3. **FedCM in the frame vs `connect-src 'self'`.** FedCM fetches use destination `webidentity`, which CSP maps to `connect-src`, and Chromium checks the requesting document's CSP for the config and endpoint fetches (**needs browser verification**). If so, adaptive §11.3 cannot fetch `https://3sln.me/...` from the island.
   - Fix: `connect-src 'self' <issuer origin>`, derived from the same registry data as the shell. Add this to §18.

### EIR-3 (High): shared main thread and event loop leak account inventory through timing

§5.5 and §13.2 rule out timing leaks except browser-wide side channels. Two channels are architectural, not browser bugs:

1. **One event loop for all islands in a tab.** All islands in a tab are same-origin, so they share one agent and event loop, even with `Origin-Agent-Cluster`. The embedder can mount a probe island (for example `#sign-in`) at any time and time `load` and then `ready`. That latency includes whatever the leader island is doing on the shared thread: ECDSA proofs per restore, stream parsing, snapshot reconcile, and avatar `decode()` for up to 8 rows.
2. **One main thread for the whole page on Android.** On Chrome for Android, and on Firefox without Fission, cross-site frames often share the embedder's renderer process. In Chromium that is a single main thread, so island work shows up directly in the embedder's long tasks, `requestAnimationFrame` jitter and `setTimeout` drift.

Contributing designed behaviour:
- §3.4 step 2 opens IndexedDB and reads or creates the key before `ready`. Adaptive §13.1 says "ready after storage access". Key creation vs a read, and the size of the database, vary by state.
- Inbound `session{subject}` with an arbitrary subject "can make the leader restore a binding it holds" (§4.3). The embedder can probe subjects and watch for the extra work.

**Fix:**
- Move all state-dependent work to a dedicated module `Worker` started by the leader. Web Locks, BroadcastChannel, IndexedDB, fetch, WebCrypto and `createImageBitmap` all work in workers; this needs the policy from EIR-2.1.
- Keep the island DOM constant: always 8 row nodes, and avatars set only as blob URLs, which Chromium decodes off the main thread. Snapshot application must cost the same for 0 to 8 bindings.
- Post `ready` before any storage access.
- Keep every binding restored whatever the current `subject`, so `session` changes cause zero work.
- Add main-thread-contention probes on Android Chrome to I7 (**needs browser verification**).

### EIR-4 (Medium): bfcache eligibility is a binding oracle

§5.3 step 1 opens the stream only when bindings exist. An in-flight fetch, a held lock, an open `BroadcastChannel` or an IndexedDB connection can each make the *top-level* page ineligible for bfcache, depending on engine and version. The embedder reads this with `pageshow.persisted`, or with `PerformanceNavigationTiming.notRestoredReasons`, where cross-origin frames report `blocked` even when the reasons are masked.

**Failure:** "restored" vs "not restored" reveals whether the partition holds any binding. Separately, islands may silently cost embedders bfcache.

**Fix (§5.3 step 4):** define a deterministic `pagehide` teardown that runs in every state:
1. Abort the stream with `AbortController`.
2. Close the bus.
3. Release the lock.
4. Close IndexedDB.
5. Make `session/end` a `fetch(..., {keepalive:true})`.

Resume on `pageshow`. I7 must assert identical `notRestoredReasons` for zero and five bindings.

### EIR-5 (Medium): focus scrolling and Tab-stop count reveal row count

On narrow viewports §9.2 lets "the panel scroll with the island inside it". When the island calls `focus()`, or keyboard Tab moves into a row, the browser scrolls *ancestor* scrollers to reveal that row, including the embedder-owned panel. The embedder sees panel `scroll` events, and their offsets follow the focused row's position. Over a user's ArrowDown or Tab sequence, the offsets show where focus wraps or leaves. Separately, every binding row and the conditional "More at example.org" row is a Tab stop. The number of Tab presses before `focusin` on the next embedder element therefore tracks the binding count.

**Fix (§4.4, §13.1, §14.1):**
- Make the account list a **single Tab stop** with roving `tabindex`, using arrows inside the island.
- Make "More…" always present, as a constant slot.
- Use `focus({preventScroll:true})` everywhere.
- Set root `overflow:hidden`, with only the internal list scrolling.
- Have the element never clip the island: the panel scrolls the slots, never the iframe. If it must clip, the element sets the panel's scroll position itself on `focusin` of the iframe.

### EIR-6 (Medium): the initial-focus heuristic breaks keyboard and pointer use

§9.4 has the island move focus to its first control "in response to its own window `focus` event". That event also fires when:
- Shift+Tab enters the frame. The browser has focused the *last* control, the island jumps to the first, and reverse navigation breaks.
- A pointer click lands on a control. Focus jumps away from the clicked control.
- The user returns from another app or the island's popup, and loses their position.

**Fix:** redirect only when `document.activeElement === document.body` after the event, meaning a programmatic `iframe.focus()` with no inner target. Otherwise leave focus alone. Accept that a mode switch (§9.4) restores the first control, not the exact one, and say so.

### EIR-7 (Medium): a stale island `CloseWatcher` traps the Android back gesture

The island creates a `CloseWatcher` during an activation (§4.4 `escape`), but it is never told when the panel closes. Inbound messages are presentation-only, and closing by `select`, outside click or session change sends it nothing.

**Failure:** the next back gesture is consumed by the stale watcher. The island posts `escape`, the element ignores it because the panel is closed, and the user's back press does nothing.

**Fix:** the island destroys its watcher when its `IntersectionObserver` reports not intersecting, which happens because the closed `<dialog>` is `display:none`, and on window `blur`. Or drop the island watcher entirely if the parent modal dialog's watcher receives the request while focus is in the frame (**needs browser verification**; already listed in §18).

### EIR-8 (Medium): rate-limit drops can leave a signed-out account on screen

§4.2 drops messages above 10 per second per port. Boot sends `init` plus `session`, `prepare`, `props` and `theme`, and a scheme change sends two more. A dropped `session{null}` leaves the previous account's card and avatar visible after app sign-out, for example on a shared device.

**Fix:** state messages (`session`, `theme`, `scheme`, `locale`, `props`) are last-value-wins. Coalesce the latest message per type and apply it on the next tick instead of dropping it. Count only non-state types against the limit, and never rate-limit `session` or `forget`.

### EIR-9 (Medium): leader races lose `credentials-changed` and `forget`, and steals exhaust session caps

1. **Lost bus messages.** A `credentials-changed` or relayed `forget` sent while no leader exists is lost: during failover, after a steal, or after a `resign` on `pagehide`. A new binding is never restored, or a forgotten one survives in a follower's snapshot for up to 600 s.
   - Fix (§5.2–5.3): the island that receives `forget` deletes credentials from IndexedDB itself, since any island can. Keep a `credentials-generation` record in IndexedDB. Each new leader reads it on acquisition and every heartbeat, and restores from it, so bus messages become hints, not the source of truth.
2. **Session caps.** A steal, a thawed frozen tab, or a bfcache restore can leave orphaned embed sessions, because `session/end` is best-effort. With the cap of 4 sessions per credential refusing new ones, the next leader cannot restore and the user sees the no-binding state.
   - Fix: key sessions by `(credential, instance)`, and have a new session **evict the oldest** rather than be refused.
3. **`forget` scope.** `forget` wipes every binding for the client in the partition, so a multi-account app signing out one account also removes the others.
   - Fix: decide this in Q2. An optional `forget{subject}` is still only state-reducing and has no reply.

### EIR-10 (Medium): popover edge cases

1. **Trigger toggle race.** `popover="auto"` light dismiss runs on pointer events before `click`, so clicking the trigger while open closes the popover and the click reopens it.
   - Fix: make the trigger the invoker with `popovertarget`/`commandfor`. Both are in the same shadow root, the invoker counts as inside, and Chromium also gets the implicit anchor.
2. **Switching between popover and modal.** `showModal()` throws `InvalidStateError` while the popover is showing, and `showPopover()` throws on a dialog with `open`.
   - Fix (§9.4): specify the order as `hidePopover()` → remove `popover` → `showModal()`, and `close()` → add `popover` → `showPopover()`.
3. **Taps on other iframes (iOS).** Tapping a non-focusable spot in another cross-origin iframe, such as an ad, often moves no focus and fires no `blur`, so the panel stays open.
   - Fix: on a coarse pointer, use a transparent full-viewport catcher behind the panel in the top layer, or accept and document the limitation.
4. **Visually hidden panel.** It stays "open" and armed, because IntersectionObserver v1 ignores `visibility` (§9.2).
   - Fix: close instead of hiding when focus is outside, or the island re-arms on IO changes only (see EIR-13).
5. **Moved hosts.** Implement `connectedMoveCallback`, so `moveBefore` relocations of the host by frameworks do not tear down and remount islands.

### EIR-11 (Medium): ARIA and phase-1 breaking changes need an explicit migration

Island mode changes the following phase-1 behaviour:
- `aria-haspopup` goes from `menu` to `dialog`, and `aria-controls` from `menu` to `panel`.
- Tab inside the panel no longer closes it.
- `switch`/`manage` move out of the embedder's DOM.
- `::part(sign-in)` and other embedder CSS no longer reach the island button.
- `<bindle-sign-in>` hides the handle form behind "Use a different provider".

All of this switches on automatically when the provider advertises the profile (`islands="auto"` default). The new structure is a dialog that contains a `role=menu` group next to an iframe of plain buttons. This mixes interaction models: NVDA switches to application mode in the menu and Tab semantics conflict.

**Fix (Q3, §8.1, §12.1):**
- In island mode, drop `role=menu` and use a list of buttons and links (disclosure pattern). Slotted `role=menuitem` children are accepted but their role is ignored, with a console warning.
- Ship islands opt-in in the current major version, or treat this as a semver-major change with a migration note in `docs/integration.md`.
- Replace `aria-busy` on the button with a status-region announcement.
- Give standalone `<bindle-avatar>` `role=img` and an app-granted label, or `aria-hidden`.

### EIR-12 (Low): theme tokens contradict "tokens never affect layout"

The validator `theme-probe.mjs`, which §12.4 moves to `embed-protocol.mjs`, accepts:
- `font-scale` up to 1.25, which changes text metrics and truncation;
- `density`, which overlaps the `density` prop;
- `radius`;
- `font`.

`contrastPairs` also omits combinations the switcher will use on `surface-raised`: `text-muted`, `danger`, `accent` and `border`. That allows a faint "Remove". The scheme also has three sources of truth: the `color-scheme` token, `scheme`/`cs`, and the iframe's `color-scheme`.

**Fix (§4.3, §13.3):**
- List which tokens are layout-affecting and prove they cannot change row count or control visibility. Otherwise ignore them in islands.
- Derive the contrast matrix from every foreground/background pair in `parts.css`, enforced by a test.
- Make `scheme` win, and drop the `color-scheme` token for islands.

### EIR-13 (Low): clickjacking arming is mis-scoped

- Arming also gates **keyboard** activation (§13.4), but an embedder cannot synthesize trusted keys. Arm pointer activation only.
- The 600 ms window silently swallows quick clicks after opening. Show the disarmed state visually, or use about 400 ms; IntersectionObserver v2 itself requires ≥100 ms.
- IntersectionObserver v1 cannot see `opacity:0`, filters or overlays applied through `::part(panel)` or `::part(switcher-frame)` in Firefox and WebKit. That is acceptable only because `select` and "Remove" grant nothing new.
- The second "Remove" confirmation sits at a fixed position, so a two-click lure works. Its impact is limited to losing your own bindings, so state that as the residual.

### EIR-14 (Low): element-side entitlement filtering is not a boundary

`port1` lives in the embedder's realm. App script that loads earlier can patch `MessagePort.prototype` or `HTMLIFrameElement.prototype.contentWindow` and read raw `select{subject}` and every other outbound message. §10.1's "surfaced only if the controller holds a live session" is a UX filter.

**Fix (§4.4):** state the island-side invariant. Every outbound field must be app-entitled *before* element filtering. `select` is sent only for subjects whose binding was created by a flow that delivered a code to this `client_id`, and is never sent for imported or other-client bindings.

### EIR-15 (Low): text scaling vs fixed island sizes

The sign-in width comes from a static per-locale table, and the switcher rows are fixed. The same WCAG 1.4.4 concern that rejected `account-name` applies under:
- Android OS font scaling, which Chrome applies per document;
- minimum-font-size settings;
- user stylesheets.

**Fix:** the element scales island sizes by the embedder's root font-size ratio. That is an embedder-side fact, not island content. The island wraps the label to two lines before truncating, and keeps the full text in the accessible name.

### EIR-16 (Low): COEP, CORP and service-worker cache staleness

- Headers cannot depend on whether the embedder uses COEP, because the shell is static. Send `COEP: require-corp` plus `CORP: cross-origin` always, and say so.
- Embedders that are cross-origin isolated also send `COOP: same-origin`, which severs the island's popup (adaptive §9). They get plain mode, so "COEP compatibility" means rendering only.
- The service worker's 7-day cached-shell fallback (§3.3) carries a stale `frame-ancestors` and parts list after a registry removal. Cap it at 24 hours, or use the fallback only when `navigator.onLine === false`.

### EIR-17 (Low): ordering and transient-state wording

The microtask ordering in §10.1 holds when the controller dispatches from script. However, "coalesced within one microtask" does not prevent a transient `null`, because a switch spans an asynchronous exchange.

**Fix:** require the controller to keep publishing the previous session until the new credential is ready or failure is declared, and never publish an intermediate `null` during a switch. Add a test.

### EIR-18 (Low): ownership and interface gaps

- **Unowned files.** No slice owns `theme-probe.mjs` (the re-export), `monogram.mjs` (shared with the island bundle), `elements/index.mjs` and `define.mjs` (registering `<bindle-avatar>`), or the `packages/i18n/catalogues.mjs` index.
- **Re-encoding pipeline.** The repository and `vendor/` have no image codec, and Workers have no canvas. Re-encoding uploaded pictures and generated badges needs a WASM codec, with a size and CPU budget, an owner (I4) and a provenance entry.
- **Bus schema.** `hello` lacks the follower's avatar bucket, so the leader cannot fetch the right size for each island (§5.2, §6.1).
- **Mock API.** `apps/embed/testing/mock-api.mjs` must be test-only and never routed by the Worker or Node apps (AGENTS.md demo rule). State this in §19.

## Author response (2026-10-14)

All 18 findings were accepted and incorporated into [embed-islands](../architecture/embed-islands.md) revision 2. The finding-by-finding mapping is in its §23. Main changes:
- An `Origin` gate that works for same-origin GETs.
- A script-URL-only Trusted Types policy and a correct service-worker scope.
- A dedicated worker that does all state-dependent work.
- An identical `pagehide` teardown in every state.
- A single Tab stop for the switcher list, with `preventScroll`.
- Last-value-wins state messages.
- A credentials generation in IndexedDB, plus sessions that evict the oldest when the cap is reached.
- Fixed ordering for switching between popover and modal, with the trigger as the popover's invoker.
- The disclosure pattern in island mode, with islands opt-in until a major release.
- Pointer-only arming of controls.

Browser claims remain unverified, as the review says. Accepting the revision is the author's call; no human sign-off is implied.

## Implementation review: slices I1, I2, I3, I6 and the A5 client pieces (2026-10-14)

Scope: `packages/sdk/src/islands-protocol.mjs`, `apps/embed/**` (shell, runtime, worker, parts, keys, restore, popup bridge, sandbox probe, service worker) and `packages/i18n/islands-catalogue.mjs`. An independent reviewer read the code without editing it, focusing on browser security: leaks through size, timing or messages, leader races, key handling and the bridge. The reviewer ran the Node suites and the Playwright suite (Chromium 156 and Firefox 157 passed; WebKit was skipped because `newPage()` hangs on this machine). This is implementation review only. Nothing is routed or production-verified, and no human sign-off is implied.

| Reviewer | Date | Outcome |
| --- | --- | --- |
| | | |

### Findings and resolutions

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| IMPL-1 | Medium-High | A `forget` sent during a bfcache resume ran against the store `pagehide` had closed, and was dropped. Confirmed by script. | Worker operations now wait on a `ready` promise that `start`/`pageshow` resolves. Regression test added. |
| IMPL-2 | Medium | A subject-scoped `forget` or Remove never matched, because the server session view has no `subject`. | Records whose subject is unknown now match any subject-scoped forget (fail closed). The server gap is still open, see below. Test added. |
| IMPL-3 | Medium | With `session{subject:null}` the switcher still listed every binding. | A null subject now shows no rows. |
| IMPL-4 | Medium | With memory-only storage plus Web Locks, islands had separate terms and stores, which broke fencing. | Memory-only storage now leads solo (§5.4), and `seen` resets on every `term` message. |
| IMPL-5 | Medium | A follower kept showing a forgotten account until the next snapshot. | The forget operation and the bus `forget` now drop matching views locally and emit. |
| IMPL-6 | Medium | The service worker served unhashed asset paths cache-first, which could pin old island code. | Only content-hashed names are served cache-first. The generation must be build-derived (I8). |
| IMPL-7 | Low-Medium | The redraw cadence and the first-snapshot delay scaled with the number of bindings. | Renewal is now one batch on the earliest expiry, and restore batches are padded to 8 slots. Fixed-schedule snapshots are not implemented. |
| IMPL-8 | Low | Sliding an armed frame under the cursor did not re-arm it. | A pointer must now rest on the island for 400 ms before a `pointerdown` counts. It re-arms on `pointerleave`. |
| IMPL-9 | Low | A binding was marked delivered before `code` was sent. | `delivered` is now the result of `send()`. |
| IMPL-10 | Low | A `prepare` that arrived during a flow was discarded at the flow's end. | Only the `prepare` that was used is consumed. |
| U1 | (uncertain) | A popup that closes or is severed before any hello reported `canceled`. | It now reports `unavailable`, meaning the opener was lost. Test added. |

### Still open (not changed)

- **U2.** The `document.domain` sandbox probe is untested under `Origin-Agent-Cluster: ?1` with a sandbox.
- **U3.** The lock is released only after the worker processes `pagehide`, so bfcache eligibility may differ between leader and follower. This is not account-dependent.
- **U4.** Photo decode cost differs from the monogram decode cost wherever decode is not off-thread.

### Found during implementation

- **Origin under `no-referrer`.** Under `referrerPolicy:'no-referrer'`, a same-origin POST carries `Origin: null` (Firefox 157), which the embed API's Origin gate rejects. Embed API calls now use `'same-origin'`.
- **COEP on the worker script.** A dedicated worker under the COEP shell fails to load unless its script response also sends `Cross-Origin-Embedder-Policy: require-corp` (Chromium 156).
- **Claim format.** Claims and codes are routed handles (`<uuid>.<b64>`), so the bridge accepts that grammar.
- **Stale renders.** A slow, stale render response could replace a newer picture. Render requests are now ticketed.

### Gaps for other slices

- **A2/I4:** the session `view` must carry `subject` (and avatar presence).
- **I4** must build:
  - `GET /embed/api/avatar`;
  - `/embed/api/events`;
  - `/embed/api/session/end`;
  - the `/embed` shell (per-client CSP, `frame-ancestors`, config templating with `<` escaped);
  - asset serving with COEP and CORP.
- **A7:** the popup document must handle `bindle-embed-ack` (`{v:1,type,entry}`).
- **Not implemented:** FedCM in the frame.
- **Profile vs design:** the shell's caching header disagrees (`private` vs `no-cache`).

## Serving review: slice I4 and the build (2026-10-14)

Scope: islands served on the embed origin. This covers the build (`scripts/build-assets.mjs`, `jstools.config.mjs`), the routes (`packages/runtime/http.mjs` `embedOriginRoutes`/`embedShell`), the embed API (`packages/runtime/federation-entry-http.mjs` from `EMBED_AUTH`), `packages/federation/{embed-shell,embed-avatar,embed-bindings}.mjs`, and the client integration fixes in `apps/embed/src/{restore,keys}.mjs` and `apps/embed/sw.js`.

One independent reviewer read the diff without editing it. It focused on headers, CSP, COEP and CORP, per-client `frame-ancestors`, avatar privacy and timing, and cache poisoning through the service-worker scope. This is implementation review only. It implies no human sign-off, and nothing is production-verified.

| Reviewer | Date | Outcome |
| --- | --- | --- |
| | | |

### What was built

- **Build.** The `apps/embed/src/boot.mjs` graph is re-rooted under `/embed/assets/` with its own static import map, which is checked as the browser resolves it.
  - The map is inline in the shell, and its SHA-256 is added to the shell's `script-src`.
  - The shell gets two hashed stylesheets.
  - The island worker is a standalone js-tools bundle.
  - `/embed/sw.js` carries a build-derived generation.
  - The shell template keeps one `{{CONFIG}}` slot. The server fills it per client with `<`, U+2028 and U+2029 escaped (`fillShell`). The build proves this round-trips.
  - No island code stays under `/assets/`.
- **Routes (embed origin only).**
  - `/embed`: per-client `frame-ancestors`, CSP with Trusted Types, COEP `require-corp`, CORP `cross-origin`, `private, max-age=300`, and an ETag.
  - `/embed/assets/*`: COEP, CORP `same-origin`, immutable. Scripts also carry a worker CSP (`connect-src 'self' <issuer>`).
  - `/embed/sw.js`: `Service-Worker-Allowed: /embed`.
  - Any query string on assets or `sw.js` returns 404.
  - `GET /embed/api/avatar`: session bearer plus a GET DPoP proof. Returns a re-encoded PNG with no CORS, `no-store`, a sandbox CSP and one fixed deadline.
  - `GET /embed/api/events`: an NDJSON stream with leases, at most two per credential (the oldest yields). Each tick re-checks the lease, session and binding.
  - `POST /embed/api/session/end`: bearer only, always answers 204.
  - The app origin still returns 404 for `/embed*` (M3).
- **Session view.** It now carries `subject` and avatar presence (a boolean). The avatar URL never leaves the provider.
- **Avatar source.** No avatar bytes are stored anywhere: the account picture is the profile's HTTPS URL.
  - Sources are the provider's own static assets, or origins the operator approves in `EMBED_AVATAR_ORIGINS`. The Worker fetches the latter under `global_fetch_strictly_public`; Node injects no fetcher, so on Node only own-asset sources work.
  - Only bounded, non-interlaced 8-bit PNGs are decoded. There is no vendored codec, so JPEG, WebP and SVG keep the monogram.
- **`Origin: null` decision.** Fetch serializes the origin of a same-origin, non-CORS POST as `null` under a `no-referrer` policy, which is the shell's policy (observed in Firefox 157).
  - The gate accepts `Origin: null` only together with the browser-set `Sec-Fetch-Site: same-origin`, and with the mode, destination and `X-Bindle-Embed` checks.
  - Opaque-origin initiators (sandboxed or `data:` documents) are never same-origin, and `X-Bindle-Embed` cannot be sent cross-origin because no preflight is answered.
  - The client also sends `referrerPolicy:'same-origin'`, so it normally carries the exact Origin.
  - adaptive §13.4 needs this sentence (coordinator).

### Findings and resolutions

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| S1 | Low | Avatar re-encoding costs about 70 ms of CPU for a 1024² source, and nothing is cached. An authenticated user can amplify that cost within the API rate limits (120/min per IP). | **Open.** Follow-up: a per-session avatar budget, or a short cache keyed by (source digest, size) in the account object. |
| S2 | Low | The uniform deadline was only a floor. Slow sources or Durable Object round trips could answer later than fast failures, and the ASSETS read had no timeout. | **Fixed.** The whole pipeline races a real timer, and unfinished work answers `not_found` at the deadline. Test added. |
| S3 | Low | `frame-ancestors` accepted `http:` redirect origins from client config, which the front Worker does not re-validate. | **Fixed.** Only `https:` ancestors are accepted outside `LOCAL_DEVELOPMENT`; otherwise the inert page with `frame-ancestors 'none'`. Test added. |
| S4 | Low | Accepting `Origin: null` was broader than the client needed, and the comments in `restore.mjs` were stale. | **Kept, with the rule above.** The comments are corrected. |
| S5 | Low/Info | The service worker refused `private` responses, so the shell (`private, max-age=300`) was never cached and the offline fallback could not work. | **Fixed.** `storable` now refuses only `no-store` and `Set-Cookie`. A per-partition service-worker cache is a private cache. |
| S6 | Info | All clients share one embed origin, isolated only by per-top-level-site partitioning. | By design (EI-1). Recorded. |

### Evidence (2026-10-14)

| Check | Result |
| --- | --- |
| `npm test` | 1100/1100 |
| `npm run test:worker` | 50/50 |
| `npm run test:ui-state` | 182/182 |
| `npm run build:assets` | Passes. 28 island modules; the shell is 1012 bytes gzipped. |
| `npm run check:worker` | Passes |
| Browser gate (`npm run test:e2e`, before the S2–S5 fixes) | 85/85 portal, 4/4 federation, 2/2 authorization entry |
| `node --test tests/browser/islands-embed.mjs` | Chromium 10/10 and Firefox 10/10, against a local Worker (`--upstream-protocol https`, `.example` hosts forwarded by Playwright) |

The islands browser run uses the real shell, assets, worker, embed API, entries, claim, token exchange and avatar route. Its popup document is still a stand-in for A7.

**Not verified:**
- WebKit: `newPage()` hangs in this environment.
- Service-worker registration in a browser: Playwright cannot route a service worker's script fetch for a `.example` host. The headers are checked against the Worker instead.
- FedCM.
- Deployed Workers.
